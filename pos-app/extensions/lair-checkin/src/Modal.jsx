// The check-in screen, opened from the "Lair check-in" tile.
//   Ticket (SAM-4821, or the older GOB-7K2QXM): shows who it is, then "Add $X to cart and check in"
//     (or "Check in only" when nothing is due). The fee goes in the cart as a custom sale tagged
//     `_booking: <ref>`, so paying with "Pay on Verifone" marks the booking paid.
//   Member card (DGC-<customer id>): puts that customer on the sale, so their spend counts toward their rolls.
import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { addFeesToCart, bookingsInCart, cartProblem, setCartCustomer } from './cart.js';
import { customerIdNumber, describeTicket, feeLines, linesTotal, money, readCode, rollsLabel } from './codes.js';
import { checkIn, LairError, lookUpMember } from './lair.js';

export default async () => {
  render(<CheckIn />, document.body);
};

/**
 * @typedef {'critical' | 'warning' | 'info' | 'success'} Tone
 * @typedef {{ title: string, message: string, tone: Tone, retry?: (() => void) | null }} Problem
 * @typedef {import('./codes.js').CheckInAnswer} CheckInAnswer
 * @typedef {Awaited<ReturnType<typeof addFeesToCart>>} CartAdded
 * @typedef {CartAdded | { error: string, lines: import('./codes.js').FeeLine[] }} CartResult
 * @typedef {{ code: string, answer: CheckInAnswer, cart: CartResult | null }} Ticket
 * @typedef {{ code: string, name: string, customerId: number | null, rolls: unknown, attached: boolean, cartError: string }} Member
 */

const TITLES = /** @type {Record<string, string>} */ ({
  offline: 'No internet',
  network: "Can't reach the Lair app",
  timeout: 'No answer from the Lair app',
  login: 'This POS login has no access',
  'not-found': 'Code not found',
  busy: 'Slow down a moment',
  server: 'The Lair app had a problem',
  refused: "That didn't work",
});

function CheckIn() {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
  const [ticket, setTicket] = useState(/** @type {Ticket | null} */ (null));
  const [member, setMember] = useState(/** @type {Member | null} */ (null));
  const cart = useCart();
  const working = useRef(false);
  const cameraOpen = useRef(false);

  // One scanner subscription for the life of the screen, always calling this render's handler.
  const onScan = useRef(/** @type {(data: string, source?: string) => void} */ (() => {}));
  onScan.current = (data, source) => {
    if (cameraOpen.current && source !== 'external' && source !== 'embedded') closeCamera();
    handle(data);
  };
  useEffect(() => listenToScanner((data, source) => onScan.current(data, source)), []);

  function openCamera() {
    if (working.current) return;
    setProblem(null);
    try {
      shopify.scanner.showCameraScanner();
      cameraOpen.current = true;
    } catch {
      cameraOpen.current = false;
      setProblem({ title: "Couldn't open the camera", message: 'Type the code into the box below instead.', tone: 'warning' });
    }
  }

  function closeCamera() {
    cameraOpen.current = false;
    try {
      shopify.scanner.hideCameraScanner();
    } catch {
      // Already closed (staff tapped the camera's own close button).
    }
  }

  /**
   * Does one thing at a time, with a busy line while it runs and a plain-words problem if it fails.
   * @param {string} label
   * @param {() => Promise<void>} task
   * @param {() => void} [retry]
   */
  async function run(label, task, retry) {
    if (working.current) return;
    working.current = true;
    setBusy(label);
    setProblem(null);
    try {
      await task();
    } catch (error) {
      setProblem(problemFor(error, retry));
    } finally {
      working.current = false;
      setBusy('');
    }
  }

  /** A scanned or typed code. @param {string} raw */
  function handle(raw) {
    if (working.current) return;
    const code = readCode(raw);
    if (code.kind === 'empty') return;
    setTicket(null);
    setMember(null);
    if (code.kind === 'unknown') {
      setProblem({
        title: "That's not a Lair code",
        message: `"${code.text}" isn't a ticket or member card. Tickets look like SAM-4821 and member cards start with DGC-.`,
        tone: 'warning',
      });
      return;
    }
    if (code.kind === 'member') {
      run(`Looking up member card ${code.code}…`, () => showMember(code.code, code.customerId), () => handle(raw));
      return;
    }
    run(`Looking up ${code.code}…`, () => showTicket(code.code), () => handle(raw));
  }

  /** @param {string} code */
  async function showTicket(code) {
    const answer = await checkIn({ code, preview: true });
    if (!answer || answer.found === false) {
      throw new LairError('not-found', answer?.message || `No booking or sign-up with the code ${code}.`, 404);
    }
    setTicket({ code, answer, cart: null });
    setTyped('');
  }

  /**
   * "Add $X to cart and check in" (addToCart) or "Check in only".
   * @param {boolean} addToCart
   */
  function confirm(addToCart) {
    const current = ticket;
    if (!current) return;
    run(
      addToCart ? 'Checking in and adding to the cart…' : 'Checking in…',
      async () => {
        let answer = current.answer;
        if (!answer.checkedIn) {
          // A reason (not today, cancelled) means staff chose "anyway".
          const force = Boolean(answer.reason) && answer.reason !== 'already';
          answer = await checkIn({ code: current.code, force });
          if (!answer?.checkedIn) {
            setTicket({ code: current.code, answer: answer || current.answer, cart: null });
            return;
          }
        }
        const cartResult = addToCart ? await putFeesInCart(answer, current.code) : null;
        setTicket({ code: current.code, answer, cart: cartResult });
        announce(answer, current.code, cartResult, !current.answer.checkedIn);
      },
      () => confirm(addToCart),
    );
  }

  /** "Add $X to cart" for someone already checked in. */
  function addFeeOnly() {
    const current = ticket;
    if (!current) return;
    run('Adding to the cart…', async () => {
      const cartResult = await putFeesInCart(current.answer, current.code);
      setTicket({ ...current, cart: cartResult });
      announce(current.answer, current.code, cartResult, false);
    });
  }

  /**
   * @param {CheckInAnswer} answer
   * @param {string} code
   * @returns {Promise<CartResult | null>}
   */
  async function putFeesInCart(answer, code) {
    const lines = feeLines(answer, code);
    if (!lines.length) return null;
    try {
      return await addFeesToCart(lines, customerIdNumber(answer.customer?.id));
    } catch (error) {
      return { error: cartProblem(error), lines };
    }
  }

  /** @param {string} code @param {string} idFromCode */
  async function showMember(code, idFromCode) {
    const found = await lookUpMember(code);
    const name = typeof found?.name === 'string' && found.name.trim() ? found.name.trim() : 'Member';
    const customerId = customerIdNumber(found?.customerId ?? idFromCode);
    let attached = false;
    let cartError = '';
    if (customerId) {
      try {
        await setCartCustomer(customerId);
        attached = true;
      } catch (error) {
        cartError = cartProblem(error);
      }
    } else {
      cartError = 'The Lair app sent no customer number.';
    }
    setMember({ code, name, customerId, rolls: found?.rolls, attached, cartError });
    setTyped('');
    if (attached) toast(`${firstName(name)} is on this sale`);
  }

  /** "Put them on this sale" again, after the customer was changed or removed. */
  function reattachMember() {
    const current = member;
    if (!current?.customerId) return;
    const customerId = current.customerId;
    run('Putting them on this sale…', async () => {
      try {
        await setCartCustomer(customerId);
        setMember({ ...current, attached: true, cartError: '' });
        toast(`${firstName(current.name)} is on this sale`);
      } catch (error) {
        setMember({ ...current, attached: false, cartError: cartProblem(error) });
      }
    });
  }

  function scanNext() {
    setTicket(null);
    setMember(null);
    setProblem(null);
    openCamera();
  }

  function lookUpTyped() {
    if (!typed.trim()) {
      setProblem({ title: 'Type a code first', message: 'Tickets look like SAM-4821 and member cards start with DGC-.', tone: 'info' });
      return;
    }
    handle(typed);
  }

  const showing = Boolean(ticket || member);
  return (
    <s-page heading="Lair check-in">
      <s-scroll-box>
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            {busy ? <BusyLine label={busy} /> : null}
            {problem ? <ProblemBanner problem={problem} busy={Boolean(busy)} /> : null}
            {ticket ? (
              <TicketCard ticket={ticket} bookingsInCart={cart.bookings} busy={Boolean(busy)} onConfirm={confirm} onAddFee={addFeeOnly} />
            ) : null}
            {member ? (
              <MemberCard member={member} cartCustomerId={cart.customerId} busy={Boolean(busy)} onReattach={reattachMember} />
            ) : null}
            <s-button variant={showing ? 'secondary' : 'primary'} disabled={Boolean(busy)} onClick={showing ? scanNext : openCamera}>
              {showing ? 'Scan next' : 'Scan ticket or member card'}
            </s-button>
            <s-text-field label="Or type the code" placeholder="SAM-4821" value={typed} onInput={(event) => setTyped(event.currentTarget.value ?? '')}>
              <s-button slot="accessory" disabled={Boolean(busy)} onClick={lookUpTyped}>
                Look up
              </s-button>
            </s-text-field>
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}

/**
 * @param {{ ticket: Ticket, bookingsInCart: string[], busy: boolean, onConfirm: (addToCart: boolean) => void, onAddFee: () => void }} props
 */
function TicketCard({ ticket, bookingsInCart: inCart, busy, onConfirm, onAddFee }) {
  const { answer, code, cart } = ticket;
  const t = describeTicket(answer, code);
  const lines = feeLines(answer, code);
  const total = linesTotal(lines);
  const feeInCart = lines.length > 0 && lines.every((line) => inCart.includes(line.properties._booking));
  const checkedIn = Boolean(answer.checkedIn);
  const reason = checkedIn ? '' : answer.reason || '';
  const noun = answer.join || answer.kind === 'join' ? 'sign-up' : 'booking';

  /** @type {{ tone: 'success' | 'critical' | 'warning' | 'neutral', text: string }} */
  let status = { tone: 'neutral', text: 'Not checked in yet' };
  if (checkedIn) status = { tone: 'success', text: t.arrivedAt ? `Checked in ${t.arrivedAt}` : 'Checked in' };
  else if (reason === 'cancelled') status = { tone: 'critical', text: 'Cancelled' };
  else if (reason === 'not-today') status = { tone: 'warning', text: 'Not today' };

  /** @type {{ tone: 'success' | 'warning' | 'info' | 'neutral', text: string }} */
  let pay = { tone: 'neutral', text: 'Nothing to pay' };
  if (t.due > 0 && feeInCart) pay = { tone: 'info', text: `In the cart: ${money(t.due)}` };
  else if (t.due > 0) pay = { tone: 'warning', text: `To pay: ${money(t.due)}` };
  else if (t.paid) pay = { tone: 'success', text: 'Paid' };

  const added = cart && 'added' in cart ? cart : null;
  // Once this screen has put the fee in the cart, don't offer it again (even if the cart is paid and cleared
  // while the screen stays open): scan the ticket again to start over.
  const justAdded = Boolean(added && added.added.length);
  const offerFee = lines.length > 0 && !feeInCart && !justAdded;

  const anyway = reason ? ' anyway' : '';
  let action = null;
  if (!checkedIn) {
    action =
      offerFee ? (
        <s-button variant="primary" disabled={busy} onClick={() => onConfirm(true)}>
          {`Add ${money(total)} to cart and check in${anyway}`}
        </s-button>
      ) : (
        <s-button variant="primary" disabled={busy} onClick={() => onConfirm(false)}>
          {reason ? 'Check in anyway' : 'Check in only'}
        </s-button>
      );
  } else if (offerFee) {
    action = (
      <s-button variant="primary" disabled={busy} onClick={onAddFee}>
        {`Add ${money(total)} to cart`}
      </s-button>
    );
  }

  return (
    <s-stack direction="block" gap="base">
      <s-section heading={t.name}>
        <s-stack direction="block" gap="small">
          <s-stack direction="inline" gap="small">
            <s-badge tone={status.tone}>{status.text}</s-badge>
            <s-badge tone={pay.tone}>{pay.text}</s-badge>
          </s-stack>
          <s-text type="strong">{`${t.what} · ${t.ref}`}</s-text>
          {t.when ? <s-text>{t.when}</s-text> : null}
          {t.tables ? <s-text>{t.tables}</s-text> : null}
          {t.people ? <s-text>{t.people}</s-text> : null}
        </s-stack>
      </s-section>
      {reason ? (
        <s-banner tone={reason === 'cancelled' ? 'critical' : 'warning'} heading={reasonHeading(reason, noun)}>
          {answer.message || `Check with them before letting them in.`}
        </s-banner>
      ) : null}
      {cart && 'error' in cart ? (
        <s-banner tone="critical" heading="The fee isn't in the cart">
          {`POS said: ${cart.error}. Add it by hand as a custom sale: ${cart.lines.map((l) => `${l.title}, $${l.price}`).join('; ')}.`}
        </s-banner>
      ) : null}
      {added && added.unlinked.length ? (
        <s-banner tone="warning" heading="The fee isn't linked to the booking">
          {`It's in the cart, but the ${noun} won't be marked paid by itself. After they pay, mark ${t.ref} paid on the staff page.`}
        </s-banner>
      ) : null}
      {added && added.added.length && !added.unlinked.length ? (
        <s-banner tone="success" heading={`${money(linesTotal(added.added))} is in the cart`}>
          {`Take payment as usual.${added.customerAdded ? ` ${t.name}'s account is on the sale too, so it counts toward their rolls.` : ''}`}
        </s-banner>
      ) : null}
      {added && !added.added.length && added.skipped.length ? (
        <s-banner tone="info" heading="Already in the cart">{`The fee for ${t.ref} was already in the cart.`}</s-banner>
      ) : null}
      {action}
    </s-stack>
  );
}

/**
 * @param {{ member: Member, cartCustomerId: number | null, busy: boolean, onReattach: () => void }} props
 */
function MemberCard({ member, cartCustomerId, busy, onReattach }) {
  // The cart can report its new customer a moment after setCustomer finishes, so an empty cart customer still
  // counts as "on this sale" once it's been set; a different customer means someone changed it.
  const onSale = member.attached && (cartCustomerId === null || cartCustomerId === member.customerId);
  const rolls = rollsLabel(member.rolls);
  return (
    <s-stack direction="block" gap="base">
      <s-section heading={member.name}>
        <s-stack direction="block" gap="small">
          <s-stack direction="inline" gap="small">
            <s-badge tone={onSale ? 'success' : 'warning'}>{onSale ? 'On this sale' : 'Not on this sale'}</s-badge>
          </s-stack>
          <s-text type="strong">{`Member card · ${member.code}`}</s-text>
          {rolls ? <s-text>{rolls}</s-text> : null}
          {onSale ? <s-text color="subdued">What they buy on this sale counts toward their bonus rolls.</s-text> : null}
        </s-stack>
      </s-section>
      {member.cartError ? (
        <s-banner tone="critical" heading="Couldn't put them on the sale">
          {`POS said: ${member.cartError}. Add ${member.name} with the cart's "Add customer" button instead.`}
        </s-banner>
      ) : null}
      {!onSale && member.customerId ? (
        <s-button variant="primary" disabled={busy} onClick={onReattach}>
          Put them on this sale
        </s-button>
      ) : null}
    </s-stack>
  );
}

/** @param {{ label: string }} props */
function BusyLine({ label }) {
  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      <s-spinner accessibilityLabel={label} />
      <s-text>{label}</s-text>
    </s-stack>
  );
}

/** @param {{ problem: Problem, busy: boolean }} props */
function ProblemBanner({ problem, busy }) {
  const retry = problem.retry;
  return (
    <s-stack direction="block" gap="small">
      <s-banner tone={problem.tone} heading={problem.title}>
        {problem.message}
      </s-banner>
      {retry ? (
        <s-button disabled={busy} onClick={() => retry()}>
          Try again
        </s-button>
      ) : null}
    </s-stack>
  );
}

/** @param {string} reason @param {string} noun */
function reasonHeading(reason, noun) {
  if (reason === 'not-today') return `This ${noun} isn't for today`;
  if (reason === 'cancelled') return `This ${noun} was cancelled`;
  return 'Check before letting them in';
}

/**
 * @param {unknown} error
 * @param {(() => void) | undefined} retry
 * @returns {Problem}
 */
function problemFor(error, retry) {
  if (error instanceof LairError) {
    const canRetry = ['offline', 'network', 'timeout', 'busy', 'server'].includes(error.kind);
    return {
      title: TITLES[error.kind] || "That didn't work",
      message: error.message,
      tone: error.kind === 'not-found' || error.kind === 'refused' ? 'warning' : 'critical',
      retry: canRetry ? retry : null,
    };
  }
  const message = error instanceof Error && error.message ? error.message : 'Try again.';
  return { title: 'Something went wrong', message, tone: 'critical', retry };
}

/**
 * @param {CheckInAnswer} answer
 * @param {string} code
 * @param {CartResult | null} cartResult
 * @param {boolean} checkedInNow
 */
function announce(answer, code, cartResult, checkedInNow) {
  const parts = [];
  if (checkedInNow) parts.push(`${firstName(describeTicket(answer, code).name)} checked in`);
  if (cartResult && 'added' in cartResult && cartResult.added.length) parts.push(`${money(linesTotal(cartResult.added))} in the cart`);
  if (cartResult && 'error' in cartResult) parts.push('fee NOT in the cart');
  if (parts.length) toast(parts.join(' · '));
}

/** @param {string} text */
function toast(text) {
  try {
    shopify.toast.show(text);
  } catch {
    // The screen already says the same thing.
  }
}

/** @param {string} name */
function firstName(name) {
  return String(name).trim().split(/\s+/)[0] || name;
}

/**
 * Calls onScan for each new scan (camera, built-in or Bluetooth scanner). The scanner keeps its last value, and
 * subscribing can replay a scan from before this screen opened; those replays and doubled reports are skipped.
 * @param {(data: string, source?: string) => void} onScan
 * @returns {(() => void) | undefined} unsubscribe
 */
function listenToScanner(onScan) {
  const signal = shopify.scanner?.scannerData?.current;
  if (!signal?.subscribe) return undefined;
  const stale = signal.value?.data;
  const openedAt = Date.now();
  let ready = false;
  let last = { data: '', at: 0 };
  const unsubscribe = signal.subscribe((scan) => {
    const data = typeof scan?.data === 'string' ? scan.data : '';
    if (!ready || !data) return;
    const now = Date.now();
    if (data === stale && now - openedAt < 2000) return;
    if (data === last.data && now - last.at < 3000) return;
    last = { data, at: now };
    onScan(data, scan?.source);
  });
  ready = true;
  return unsubscribe;
}

/** The booking refs already in the cart and the cart's customer, kept up to date. */
function useCart() {
  const read = (/** @type {any} */ value) => ({ bookings: bookingsInCart(value), customerId: customerIdNumber(value?.customer?.id) });
  const [state, setState] = useState(() => read(shopify.cart?.current?.value));
  useEffect(() => {
    const signal = shopify.cart?.current;
    if (!signal?.subscribe) return undefined;
    return signal.subscribe((value) => setState(read(value)));
  }, []);
  return state;
}

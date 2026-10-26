// The check-in screen, opened from the "Lair check-in" tile. What staff see (views.jsx draws it; the 27 Oct 2026
// rework, Mo: "one obvious next step on every screen", and fewer taps to payment):
//   Home    "Scan a code" (the scanner works on every screen), search by name, and Today: now and next, later
//           today, and finished, each with who's here and what's to pay.
//   Group   everyone in a game, event or the table bookings. "Check in several at once": tick the ones paying
//           together, then "Check in 3 people and add $45 to cart".
//   Person  "Are you Sam?": "Check in and add $15 to cart" in one tap (with their session pass, another, or none),
//           "Just check in (pay later)", or "Split the bill". A GM game's player can have their GM pay for them
//           ("Kate pays for this seat", then a yes or no).
//   Member  (a member code) their loyalty card and "Check in and add everything · $41": today's bookings checked
//           in, their fees, any sessions they owe from earlier weeks, a GM's charges for their players' seats, and their
//           tab, in one sale. Then their rows, tab and passes, each to pay on its own.
//   Pass    (a pass code) who has it, sessions left, and "Use on…" one of today's bookings.
// Once something is in the cart, the screen closes itself (window.close) so staff land on the POS home screen, one
// tap from Pay on Verifone. If POS doesn't close it (a known POS bug after the screen has waited on the Lair app),
// staff see "In the cart" with one "Close and pay" button instead.
// Fees go in the POS cart as custom sales tagged `_booking` (plus `_share` for a share of a bill; an owed session is
// "Owed: <game> (<date>)"), and a tab's items as the real products tagged `_tab`. When the sale is paid on the
// Verifone, the Lair app's orders/paid webhook marks them paid. API contract v4, sections 7 and 11, v5 section 2, and
// v21-gm-cover.
import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { addEverythingToCart, addFeesToCart, addTabToCart, bookingsInCart, cartCustomerId, putOnSale, sharesInCart, tabsInCart } from './cart.js';
import { readCode } from './codes.js';
import {
  afterCart,
  CHECK_FIRST,
  checkinOutcome,
  currentRow,
  everythingOutcome,
  everythingPlan,
  groupPlan,
  groupScreen,
  HOME,
  memberPlan,
  nextScreen,
  NO_PASS,
  notALairCode,
  openUseIds,
  passChange,
  passInUse,
  passOptions,
  passParam,
  passProblem,
  personScreen,
  recordUses,
  scanPurpose,
  stackAfterPerson,
  tabNotes,
  undoNote,
  withGroups,
  wrongScan,
} from './flow.js';
import { dayKey, firstName, money, plural } from './format.js';
import { checkIn, coverSeat, getToday, LairError, problemFor, scanCode, shareBill, tabAdded, uncoverSeat, undoPassUse } from './lair.js';
import { feeLines, itemCount, linesTotal, owedLines, shareLines, tabToast } from './lines.js';
import { cardFilled, cardFullShort, cardFullWords } from './loyalty.js';
import { customerNames } from './sale.js';
import { amountProblem, parseDollars, payerFromScan, pendingShare, pendingState, WAITING, waitingRefs } from './split.js';
import { loadPending, savePending, saveTileEntry } from './store.js';
import { dueOf, findRow, gameTitle, isHeld, isOwed, mergeRows, replaceRows, rowKey, tileEntry } from './today.js';
import { CurrentScreen } from './views.jsx';

export default async () => {
  render(<CheckIn />, document.body);
};

/**
 * @typedef {import('./today.js').Today} Today
 * @typedef {import('./today.js').Row} Row
 * @typedef {import('./today.js').Group} Group
 * @typedef {import('./today.js').PassLike} PassLike
 * @typedef {import('./flow.js').Screen} Screen
 * @typedef {import('./flow.js').GroupScreen} GroupScreen
 * @typedef {import('./flow.js').PersonScreen} PersonScreen
 * @typedef {import('./flow.js').MemberScreen} MemberScreen
 * @typedef {import('./flow.js').PassScreen} PassScreen
 * @typedef {import('./flow.js').PersonActionName} PersonActionName
 * @typedef {import('./split.js').Pending} Pending
 * @typedef {import('./views.jsx').Shown} Shown
 * @typedef {import('./views.jsx').Want} Want
 * @typedef {import('./views.jsx').Ctx} Ctx
 * @typedef {import('./lines.js').FeeLine} FeeLine
 * @typedef {Awaited<ReturnType<typeof addFeesToCart>>} CartResult
 */

/** A scan button sets what the next scan is for; after two minutes without one, a scan is just a scan again. */
const WANT_MS = 120_000;

/** How long "Add everything" waits for a fresh look at a member's loyalty card before closing anyway. */
const CARD_WAIT_MS = 2500;

function CheckIn() {
  const [today, setToday] = useState(/** @type {Today | null} */ (null));
  const [loading, setLoading] = useState(false);
  const [listProblem, setListProblem] = useState(/** @type {Shown | null} */ (null));
  const [stack, setStack] = useState(/** @type {Screen[]} */ ([HOME]));
  const [busy, setBusy] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [problem, setProblem] = useState(/** @type {Shown | null} */ (null));
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(/** @type {Record<string, Pending>} */ ({}));
  const cart = useCart();

  const working = useRef(false);
  const cameraOpen = useRef(false);
  const want = useRef(/** @type {{ want: Want, at: number }} */ ({ want: 'any', at: 0 }));
  const loadingNow = useRef(false);
  const stale = useRef(false);
  // Members and payers this screen has seen, so the cart strip can say who's on the sale.
  const seen = useRef(/** @type {{ customerId?: unknown, name?: unknown }[]} */ ([]));
  // The latest state, for scans and actions that finish after a render or two.
  const stackNow = useRef(stack);
  stackNow.current = stack;
  const todayNow = useRef(today);
  todayNow.current = today;
  const pendingNow = useRef(pending);
  pendingNow.current = pending;

  /* ---------------- today's list ---------------- */

  /** GET /pos/today: on opening, and on Refresh. No polling. */
  async function loadToday() {
    if (loadingNow.current) return;
    loadingNow.current = true;
    stale.current = false;
    setLoading(true);
    try {
      const fresh = await getToday();
      // Someone was checked in while it loaded: this copy may be older than the screen's, so ask again.
      if (!stale.current) {
        setToday(fresh);
        setListProblem(null);
      }
    } catch (error) {
      const shown = problemFor(error);
      setListProblem({ ...shown, retry: shown.retry ? loadToday : null });
    } finally {
      loadingNow.current = false;
      setLoading(false);
    }
    if (stale.current) loadToday();
  }

  /** Fresher copies of some rows (from a check-in, a scan or a share). @param {(Row | null | undefined)[]} rows */
  function setRows(rows) {
    setToday((current) => replaceRows(current, rows));
    if (loadingNow.current) stale.current = true;
  }

  useEffect(() => {
    loadToday();
    loadPending(Date.now()).then((saved) => setPending((current) => ({ ...saved, ...current })));
  }, []);

  // The tile shows today's numbers; leave it the freshest ones.
  useEffect(() => {
    if (today) saveTileEntry(tileEntry(today, Date.now()));
  }, [today]);

  // "In the cart" (when the screen didn't close by itself) is done with once the sale is paid: back to Today. It reads
  // the POS cart itself, not this screen's copy, which can be a moment behind the lines just added.
  useEffect(() => {
    const top = stackNow.current[stackNow.current.length - 1];
    if (top?.name === 'ready' && !(shopify.cart?.current?.value?.lineItems || []).length) navigate([HOME]);
  }, [cart.value, stack]);

  /* ---------------- shares of a bill waiting to be paid ---------------- */

  /** @param {Record<string, Pending>} next @returns {Promise<void>} saved on the iPad */
  function keepPending(next) {
    pendingNow.current = next;
    setPending(next);
    return savePending(next);
  }

  /**
   * A share put in the cart, kept on the iPad: the next time the booking is opened, it says "Waiting for the last
   * payment…" until the payment reaches the Lair app, so the next friend isn't charged the whole remainder. Saved
   * before the screen closes (a closed screen keeps nothing).
   * @param {string} key
   * @param {Pending} note
   */
  function rememberShare(key, note) {
    return keepPending({ ...pendingNow.current, [key]: note });
  }

  /** @param {string[]} keys */
  function forgetShares(keys) {
    const next = { ...pendingNow.current };
    for (const key of keys) delete next[key];
    keepPending(next);
  }

  // Forget a share once its payment has reached the Lair app (or it's been half an hour).
  useEffect(() => {
    const keys = Object.keys(pending);
    if (!keys.length) return;
    const now = Date.now();
    const done = keys.filter((key) => {
      const [type, ...rest] = key.split(':');
      const row = findRow(today, rest.join(':'), type)?.row || null;
      const state = pendingState(pending[key], row, cart.shares, now);
      return state === 'landed' || state === 'expired';
    });
    if (done.length) forgetShares(done);
  }, [today, pending, cart.shares]);

  /**
   * Codes whose last share left the cart but hasn't reached the Lair app yet, from the notes as they are now
   * (split.js waitingRefs): a member's code, a group and a pass's "Use on…" leave them out until the payment lands.
   * @param {Row[]} [more] fresher copies than the Today list's (a member's fresh look)
   */
  function heldNow(more = []) {
    const rows = [...more, ...(todayNow.current?.groups || []).flatMap((group) => group.rows || [])];
    return waitingRefs(pendingNow.current, rows, sharesInCart(shopify.cart.current.value), Date.now());
  }

  /* ---------------- doing one thing at a time ---------------- */

  /**
   * One action at a time, with a busy line (and the tapped button spinning) while it runs and a plain-words banner if
   * it fails.
   * @param {string} label
   * @param {() => Promise<void>} task
   * @param {() => void} [retry]
   * @param {string} [key] which button: 'main' for a screen's main one
   */
  async function run(label, task, retry, key = 'main') {
    if (working.current) return;
    working.current = true;
    setBusy(label);
    setBusyKey(key);
    setProblem(null);
    try {
      await task();
    } catch (error) {
      const shown = problemFor(error);
      setProblem({ ...shown, retry: shown.retry && retry ? retry : null });
    } finally {
      working.current = false;
      setBusy('');
      setBusyKey('');
    }
  }

  /**
   * @param {string} title
   * @param {string} message
   * @param {'critical' | 'warning' | 'info' | 'success'} [tone]
   * @param {{ label: string, run: () => void } | null} [action] the next step, as a button under the banner
   */
  function say(title, message, tone = 'warning', action = null) {
    setProblem({ title, message, tone, retry: null, action });
  }

  /* ---------------- moving between screens, and closing ---------------- */

  /** @param {Screen[]} next */
  function navigate(next) {
    setStack(next.length ? next : [HOME]);
  }

  /** @param {Screen} screen */
  function push(screen) {
    setProblem(null);
    setStack((current) => [...current, screen]);
  }

  function back() {
    if (working.current) return;
    setProblem(null);
    setStack((current) => (current.length > 1 ? current.slice(0, -1) : [HOME]));
  }

  function goHome() {
    if (working.current) return;
    setProblem(null);
    setQuery('');
    navigate([HOME]);
  }

  /**
   * Closes the check-in screen (POS UI extensions 2026-07: window.close() "closes the extension screen and dismisses
   * the modal"), back to the POS home screen with the cart.
   */
  function closeScreen() {
    try {
      window.close();
    } catch {
      // The "In the cart" screen is showing, with its Close and pay button.
    }
  }

  /**
   * Something is in the cart and nothing needs sorting out: say so, then close. If POS doesn't close the screen
   * (it sometimes won't after the screen has waited on the Lair app), "In the cart" shows instead, with one button.
   * @param {string} toastText
   * @param {{ heading: string, body: string, who?: string, extra?: string }} ready
   */
  function finish(toastText, ready) {
    toast(toastText);
    setProblem(null);
    navigate([HOME, { name: 'ready', heading: ready.heading, body: ready.body, who: ready.who || '', extra: ready.extra || '' }]);
    closeScreen();
  }

  /**
   * Fee lines into the cart, then close the screen when they all went in cleanly and the Lair app had nothing to say
   * (afterCart); otherwise stay, say what to do, and offer "Close and pay" when there's something to pay for.
   * @param {FeeLine[]} lines
   * @param {unknown} customerId who goes on the sale
   * @param {{ who?: string, ref?: string, replaceCustomer?: boolean, stay?: boolean, prefix?: string, checkedIn?: boolean,
   *   filled?: boolean, notices?: string[], afterAdd?: (added: CartResult) => Promise<unknown> }} [options]
   *   who: their first name; ref: the code paying marks paid; stay: something else is on screen already, so don't
   *   close; prefix: words before "Added $15. Ready to pay." in the toast; checkedIn: they were checked in too; filled:
   *   the check-in filled their loyalty card; notices: what the Lair app said at check-in; afterAdd: anything to finish
   *   (and wait for) before the screen can close
   * @returns {Promise<CartResult>}
   */
  async function putInCart(
    lines,
    customerId,
    { who = '', ref = '', replaceCustomer = false, stay = false, prefix = '', checkedIn = false, filled = false, notices = [], afterAdd } = {},
  ) {
    const added = await addFeesToCart(lines, customerId, { replaceCustomer });
    if (afterAdd) await afterAdd(added);
    const next = afterCart(added, { who, ref, notices });
    const said = next.toast ? `${prefix}${next.toast}` : prefix.trim();
    if (!next.close || stay) {
      if (said) toast(said);
      if (next.banner) say(next.banner.title, next.banner.message, next.banner.tone, next.next === 'close' ? { label: 'Close and pay', run: closeScreen } : null);
      return added;
    }
    const cents = linesTotal(added.added);
    finish(filled ? `${said} ${cardFullShort(who)}` : said, {
      heading: `Added ${money(cents)}${who ? ` for ${who}` : ''}`,
      body: `${checkedIn ? (who ? `${who}'s checked in. ` : "They're checked in. ") : ''}Ready to pay with Pay on Verifone.`,
      who,
      extra: filled ? cardFullWords(who) : '',
    });
    return added;
  }

  /** @param {(screen: PersonScreen) => PersonScreen} change */
  function updatePerson(change) {
    setStack((current) => {
      const top = current[current.length - 1];
      return top.name === 'person' ? [...current.slice(0, -1), change(top)] : current;
    });
  }

  /** @param {(screen: MemberScreen) => MemberScreen} change */
  function updateMember(change) {
    setStack((current) => {
      const top = current[current.length - 1];
      return top.name === 'member' ? [...current.slice(0, -1), change(top)] : current;
    });
  }

  /** @param {(screen: PassScreen) => PassScreen} change */
  function updatePass(change) {
    setStack((current) => {
      const top = current[current.length - 1];
      return top.name === 'pass' ? [...current.slice(0, -1), change(top)] : current;
    });
  }

  /** @param {(screen: GroupScreen) => GroupScreen} change */
  function updateGroup(change) {
    setStack((current) => {
      const top = current[current.length - 1];
      return top.name === 'group' ? [...current.slice(0, -1), change(top)] : current;
    });
  }

  function topScreen() {
    return stackNow.current[stackNow.current.length - 1];
  }

  /** @returns {PersonScreen | null} */
  function topPerson() {
    const top = topScreen();
    return top.name === 'person' ? top : null;
  }

  /** @returns {MemberScreen | null} */
  function topMember() {
    const top = topScreen();
    return top.name === 'member' ? top : null;
  }

  /** @returns {PassScreen | null} */
  function topPass() {
    const top = topScreen();
    return top.name === 'pass' ? top : null;
  }

  /** @returns {GroupScreen | null} */
  function topGroup() {
    const top = topScreen();
    return top.name === 'group' ? top : null;
  }

  /** @param {{ customerId?: unknown, name?: unknown } | null | undefined} person */
  function remember(person) {
    if (person?.customerId != null && person.name) seen.current = [person, ...seen.current].slice(0, 30);
  }

  /* ---------------- scanning ---------------- */

  // One scanner subscription for the life of the screen, always calling this render's handler.
  const onScan = useRef(/** @type {(data: string, source?: string) => void} */ (() => {}));
  onScan.current = (data, source) => {
    if (cameraOpen.current && source !== 'external' && source !== 'embedded') closeCamera();
    const asked = Date.now() - want.current.at < WANT_MS ? want.current.want : 'any';
    want.current = { want: 'any', at: 0 };
    handle(data, asked);
  };
  useEffect(() => listenToScanner((data, source) => onScan.current(data, source)), []);

  /** "Scan a code", "Scan their member code", "Scan a pass". @param {Want} what */
  function scan(what) {
    if (working.current) return;
    setProblem(null);
    want.current = { want: what, at: Date.now() };
    try {
      shopify.scanner.showCameraScanner();
      cameraOpen.current = true;
    } catch {
      cameraOpen.current = false;
      say("Couldn't open the camera", what === 'any' ? 'Use the scanner, or type the code into the search box.' : 'Use the scanner, or type the code in instead.');
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
   * A scanned or typed code: POST /pos/scan, then wherever it belongs.
   * @param {string} raw
   * @param {Want} what
   */
  function handle(raw, what) {
    if (working.current) return;
    const read = readCode(raw);
    if (read.kind === 'empty') return;
    if (read.kind === 'unknown') {
      const words = notALairCode(read.text);
      say(words.title, words.message, 'warning', { label: 'Scan again', run: () => scan(what) });
      return;
    }
    run(
      `Looking up ${read.code}…`,
      async () => {
        /** @type {any} */
        let answer;
        try {
          answer = await scanCode(read.code);
        } catch (error) {
          if (error instanceof LairError && error.kind === 'not-found') {
            say(`We couldn't find ${read.code}`, `${error.message} Check the code with them, or search by name.`, 'warning', { label: 'Scan again', run: () => scan(what) });
            return;
          }
          throw error;
        }
        route(answer, what);
      },
      () => handle(raw, what),
    );
  }

  /** @param {any} answer @param {Want} what */
  function route(answer, what) {
    const person = topPerson();
    const row = person ? currentRow(person, todayNow.current) : null;
    const purpose = scanPurpose(
      {
        want: what,
        screen: topScreen().name,
        splitOpen: Boolean(person?.split.open),
        takesPass: Boolean(row && row.type !== 'join' && dueOf(row) > 0 && !isOwed(row) && row.kind !== 'gm-cover'),
      },
      answer?.type,
    );
    if (purpose === 'wrong') {
      const words = wrongScan(what === 'pass' ? 'pass' : 'payer');
      say(words.title, words.message, 'warning', { label: 'Scan again', run: () => scan(what) });
      return;
    }
    if (purpose === 'payer') {
      const found = payerFromScan(answer);
      if ('problem' in found) {
        say("That's not a member code", found.problem);
        return;
      }
      remember(found.payer);
      updatePerson((screen) => ({ ...screen, split: { ...screen.split, open: true, payer: found.payer } }));
      toast(`${firstName(found.payer.name) || 'They'} will pay this share`);
      return;
    }
    if (purpose === 'pass') {
      /** @type {PassLike} */
      const pass = answer.pass;
      const why = passProblem(pass);
      if (why) {
        say(`${pass?.label || 'That pass'} can't be used`, why);
        return;
      }
      updatePerson((screen) => ({ ...screen, passes: [...screen.passes.filter((p) => p.code !== pass.code), pass], choice: String(pass.code) }));
      toast(`${pass.label || 'The pass'} is ready to use`);
      return;
    }
    const screen = nextScreen(answer);
    if (!screen) {
      say('That code needs a newer screen', 'The Lair app answered with something this screen doesn’t know. Search by name instead.');
      return;
    }
    if (screen.name === 'person') setRows([screen.row]);
    if (screen.name === 'member') {
      setRows(screen.rows);
      remember(screen.member);
    }
    setQuery('');
    navigate([HOME, screen]);
  }

  /* ---------------- a person: check in, the cart, a share of the bill ---------------- */

  /**
   * The person view's buttons (personAction says which).
   * @param {PersonActionName} action
   * @param {boolean} [force] "Check in anyway"
   */
  function personDo(action, force = false) {
    switch (action) {
      case 'check-in':
        return doCheckIn(force);
      case 'check-in-only':
        return checkInOnly();
      case 'check-in-add':
        return checkInAndAdd();
      case 'check-in-split':
        return checkInThenSplit();
      case 'add':
        return addToCart();
      case 'use-pass':
        return usePassAndAdd();
      case 'split':
        setProblem(null);
        updatePerson((screen) => ({ ...screen, split: { ...screen.split, open: true } }));
        return undefined;
      case 'refresh':
        return refreshRow();
      case 'forget':
        return forgetShare();
      case 'close':
      case 'done':
        return closeScreen();
      default:
        return back();
    }
  }

  /** "Check in" and "Check in anyway": nothing goes in the cart. @param {boolean} force */
  function doCheckIn(force) {
    const screen = topPerson();
    if (!screen) return;
    const row = currentRow(screen, todayNow.current);
    const pass = passParam(screen.choice, row);
    run(force ? 'Checking in anyway…' : 'Checking in…', async () => void (await checkInPerson(screen, row, { pass, force })), () => doCheckIn(force));
  }

  /**
   * "Just check in (pay later)": checked in, nothing in the cart, and back where staff came from (their group, the
   * member, or Today). What's left to pay stays on their booking, for their member code or a later visit.
   */
  function checkInOnly() {
    const screen = topPerson();
    if (!screen) return;
    const row = currentRow(screen, todayNow.current);
    const pass = passParam(screen.choice, row);
    run(
      'Checking in…',
      async () => {
        const { answer } = await checkInPerson(screen, row, { pass });
        if (!checkinOutcome(answer).arrived) return;
        const fresh = answer?.row ? { ...row, ...answer.row } : row;
        const first = firstName(fresh.name);
        const due = dueOf(fresh);
        toast(`${first ? `${first}'s` : "They're"} checked in.${due ? ` ${money(due)} to pay later.` : ''}`);
        navigate(stackAfterPerson(stackNow.current, screen.groupKey, (key) => Boolean(todayNow.current?.groups.some((g) => g.key === key))));
        // What the Lair app said about the pass ("covered 1 of 2 people"), on the screen staff go back to.
        const notice = checkinOutcome(answer).notice;
        if (notice) say(`About ${first ? `${first}'s` : 'the'} pass`, notice, 'warning');
      },
      checkInOnly,
      'check-in-only',
    );
  }

  /**
   * "Check in and add $15 to cart" and "Check in with the pass": one tap from arriving to the cart. Checks them in,
   * then puts what's left to pay in the cart and closes the screen. Nothing to pay: the screen says they're in, ready
   * for the next scan. Not checked in (another day, say): the screen says why.
   */
  function checkInAndAdd() {
    const screen = topPerson();
    if (!screen) return;
    const row = currentRow(screen, todayNow.current);
    const pass = passParam(screen.choice, row);
    run(
      'Checking in…',
      async () => {
        const { answer, filled } = await checkInPerson(screen, row, { pass });
        const outcome = checkinOutcome(answer);
        if (!outcome.arrived || !outcome.lines.length) return;
        const fresh = answer?.row ? { ...row, ...answer.row } : row;
        await putInCart(outcome.lines, answer?.customer?.id ?? fresh.customerId ?? null, {
          who: firstName(fresh.name),
          ref: String(fresh.ref || ''),
          checkedIn: true,
          filled,
          // A pass that didn't cover everyone, or wasn't used: staff see it before they take payment.
          notices: [outcome.notice],
        });
      },
      checkInAndAdd,
    );
  }

  /**
   * "Use the pass" once they're here: the pass picked covers what's left (POST /pos/checkin with its code), then
   * anything it doesn't cover goes in the cart and the screen closes. All covered: the screen says they're in.
   */
  function usePassAndAdd() {
    const screen = topPerson();
    if (!screen) return;
    const row = currentRow(screen, todayNow.current);
    const change = passChange(passInUse(row, screen.uses), screen.choice);
    if (change.action !== 'use') return;
    run(
      'Using the pass…',
      async () => {
        const { answer } = await checkInPerson(screen, row, { pass: change.pass });
        const outcome = checkinOutcome(answer);
        if (!outcome.arrived || !outcome.lines.length) return;
        const fresh = answer?.row ? { ...row, ...answer.row } : row;
        await putInCart(outcome.lines, answer?.customer?.id ?? fresh.customerId ?? null, {
          who: firstName(fresh.name),
          ref: String(fresh.ref || ''),
          notices: [outcome.notice],
        });
      },
      usePassAndAdd,
    );
  }

  /** "Check in, then split the bill". */
  function checkInThenSplit() {
    const screen = topPerson();
    if (!screen) return;
    const row = currentRow(screen, todayNow.current);
    const pass = passParam(screen.choice, row);
    run(
      'Checking in…',
      async () => {
        const { answer } = await checkInPerson(screen, row, { pass });
        const fresh = answer?.row ? { ...row, ...answer.row } : row;
        if (checkinOutcome(answer).arrived && dueOf(fresh) > 0) updatePerson((current) => ({ ...current, split: { ...current.split, open: true } }));
      },
      checkInThenSplit,
      'check-in-split',
    );
  }

  /**
   * POST /pos/checkin for the person on screen, then their row, any pass use it made (so it can be undone) and the
   * answer on screen. Whether their loyalty card filled, when the Lair app sends the card with check-ins.
   * @param {PersonScreen} screen
   * @param {Row} row
   * @param {{ pass?: string, force?: boolean }} options
   * @returns {Promise<{ answer: any, filled: boolean }>}
   */
  async function checkInPerson(screen, row, { pass, force = false }) {
    const answer = await checkIn({ id: row.id, type: row.type === 'join' ? 'join' : 'booking', pass, force });
    if (answer?.row) setRows([answer.row]);
    const outcome = checkinOutcome(answer);
    const filled = outcome.arrived && cardFilled(screen.loyalty, answer?.loyalty);
    updatePerson((current) => {
      if (rowKey(current.row) !== rowKey(row)) return current;
      const fresh = answer?.row ? { ...current.row, ...answer.row } : current.row;
      const uses = recordUses(current.uses, answer);
      const choice = outcome.arrived ? passOptions(fresh, current.passes, passInUse(fresh, uses)).picked : current.choice;
      const loyalty = answer?.loyalty && typeof answer.loyalty === 'object' ? answer.loyalty : current.loyalty;
      return { ...current, row: fresh, result: answer, uses, note: null, choice, loyalty, filled: current.filled || filled };
    });
    return { answer, filled };
  }

  /**
   * Gives back every pass use on this booking (POST /pos/pass-undo): the ones this screen saw at check-in, or else
   * the open ones on the booking's own pass (POST /pos/scan of the pass lists its uses). Says so and returns null when
   * there are none to find.
   * @param {PersonScreen} screen
   * @param {Row} row
   * @returns {Promise<{ answers: any[], row: Row } | null>}
   */
  async function undoUses(screen, row) {
    let ids = screen.uses.map((use) => use.useId);
    if (!ids.length && row.pass?.code) {
      const found = await scanCode(String(row.pass.code));
      if (found?.type === 'pass') ids = openUseIds(found.pass, row.id);
    }
    if (!ids.length) {
      say("Couldn't find that pass use", 'Undo it on the staff page, under Passes.');
      return null;
    }
    const answers = [];
    for (const id of ids) answers.push(await undoPassUse(id));
    /** @type {Row | null} */
    const fresh = [...answers].reverse().find((answer) => answer?.row)?.row || null;
    if (fresh) setRows([fresh]);
    const after = fresh ? { ...row, ...fresh } : row;
    updatePerson((current) => (rowKey(current.row) === rowKey(row) ? { ...current, row: after, uses: [], result: null, choice: null } : current));
    return { answers, row: after };
  }

  /** "Undo pass": the sessions go back on the pass, and the screen shows what's to pay now. */
  function undoPass() {
    const screen = topPerson();
    if (!screen) return;
    const row = currentRow(screen, todayNow.current);
    run(
      'Undoing the pass…',
      async () => {
        const undone = await undoUses(screen, row);
        if (!undone) return;
        const note = undoNote(undone.answers, undone.row);
        updatePerson((current) => (rowKey(current.row) === rowKey(row) ? { ...current, note } : current));
      },
      undoPass,
      'undo-pass',
    );
  }

  /**
   * The pass button once they're here (passChange): "Use this pass" checks in again with it for what's left;
   * "Switch to this pass" and "Check in again without a pass" undo the pass in use first, then check in again with
   * the new choice.
   */
  function changePass() {
    const screen = topPerson();
    if (!screen) return;
    const row = currentRow(screen, todayNow.current);
    const change = passChange(passInUse(row, screen.uses), screen.choice);
    if (change.action === 'none') return;
    run(
      change.action === 'switch' ? 'Switching the pass…' : 'Checking in with the pass…',
      async () => {
        let current = row;
        if (change.action === 'switch') {
          const undone = await undoUses(screen, row);
          if (!undone) return;
          current = undone.row;
        }
        await checkInPerson(screen, current, { pass: change.pass });
      },
      changePass,
      'change-pass',
    );
  }

  /**
   * "Add $X to cart" for someone here, or for something that's paid but never checked in: a regular's owed session
   * (its own "Owed: …" line) or a GM's charge for a player's seat (POST /pos/checkin answers with its line). The
   * check-in's lines are asked for again if what's due has changed. Then the screen closes.
   */
  function addToCart() {
    const screen = topPerson();
    if (!screen) return;
    const row = currentRow(screen, todayNow.current);
    run(
      'Adding to the cart…',
      async () => {
        const who = firstName(row.name);
        if (row.owed) {
          const owed = owedLines([row]);
          if (!owed.length) {
            say('Nothing went in the cart', 'This seat has no code to pay it by. Refresh, then try again.');
            return;
          }
          await putInCart(owed, row.customerId ?? null, { who, ref: String(row.ref || '') });
          return;
        }
        let answer = screen.result;
        const known = answer ? checkinOutcome(answer) : null;
        let lines = known && (known.arrived || known.payOnly) ? feeLines(answer) : [];
        if (!lines.length || linesTotal(lines) !== dueOf(row)) {
          // What's due now. 'none': asking again never uses a pass by itself.
          answer = await checkIn({ id: row.id, type: row.type === 'join' ? 'join' : 'booking', pass: NO_PASS });
          if (answer?.row) setRows([answer.row]);
          const fresh = answer;
          updatePerson((current) => (rowKey(current.row) === rowKey(row) ? { ...current, result: fresh } : current));
          lines = feeLines(answer);
        }
        if (!lines.length) {
          toast('Nothing to pay on this one.');
          return;
        }
        await putInCart(lines, answer?.customer?.id ?? row.customerId ?? null, { who, ref: String(row.ref || '') });
      },
      addToCart,
    );
  }

  /** "Add $X to cart" in Split the bill: POST /pos/share, its line in the cart, the payer on the sale, then close. */
  function addShare() {
    const screen = topPerson();
    if (!screen) return;
    const row = currentRow(screen, todayNow.current);
    const custom = screen.split.mode === 'custom';
    const amount = custom ? parseDollars(screen.split.custom) : null;
    if (custom) {
      const issue = amountProblem(amount, row);
      if (issue) {
        say('Check the amount', issue);
        return;
      }
    }
    const payer = screen.split.payer;
    run(
      'Adding the share to the cart…',
      async () => {
        const answer = await shareBill({ id: row.id, type: row.type === 'join' ? 'join' : 'booking', amount: custom ? amount : null });
        if (answer?.row) setRows([answer.row]);
        const lines = shareLines(answer);
        if (!lines.length) {
          say('Nothing went in the cart', 'The Lair app sent no share for this booking. Refresh, then try again.');
          return;
        }
        const before = answer?.row ? { ...row, ...answer.row } : row;
        await putInCart(lines, payer ? payer.customerId : null, {
          who: payer ? firstName(payer.name) : '',
          ref: String(row.ref || ''),
          replaceCustomer: Boolean(payer),
          // Kept on the iPad before the screen closes, so the next friend sees "Waiting for the last payment…".
          afterAdd: async (added) => {
            if (added.added.length) await rememberShare(rowKey(row), pendingShare(before, linesTotal(added.added), Date.now()));
          },
        });
      },
      addShare,
    );
  }

  /** "Refresh" while waiting for a share's payment: the row again from POST /pos/scan. */
  function refreshRow() {
    const screen = topPerson();
    if (!screen) return;
    const row = currentRow(screen, todayNow.current);
    run(
      'Checking for the payment…',
      async () => {
        const answer = await scanCode(String(row.ref));
        /** @type {Row | null} */
        const fresh = answer?.row && rowKey(answer.row) === rowKey(row) ? answer.row : null;
        if (!fresh) return;
        setRows([fresh]);
        updatePerson((current) => (rowKey(current.row) === rowKey(fresh) ? { ...current, row: { ...current.row, ...fresh } } : current));
      },
      refreshRow,
    );
  }

  /** "It wasn't paid": forget the share, so the rest can be paid. */
  function forgetShare() {
    const screen = topPerson();
    if (screen) forgetShares([rowKey(currentRow(screen, todayNow.current))]);
  }

  /* ---------------- GM pays for a player (contract v21-gm-cover) ---------------- */

  /**
   * The seat as it is now, after its GM started or stopped paying: the answer's row, or a fresh look (POST /pos/scan).
   * Never throws: the change is made by then, and the screen says so whatever happens here.
   * @param {Row} row
   * @param {any} answer
   * @returns {Promise<Row | null>}
   */
  async function freshSeat(row, answer) {
    /** @type {Row | null} */
    let fresh = answer?.row && rowKey(answer.row) === rowKey(row) ? answer.row : null;
    if (!fresh && row.ref) {
      try {
        const found = await scanCode(String(row.ref));
        fresh = found?.row && rowKey(found.row) === rowKey(row) ? found.row : null;
      } catch {
        fresh = null;
      }
    }
    if (fresh) setRows([fresh]);
    return fresh;
  }

  /**
   * The GM's first name for the person on screen (the Lair app's, else from their game's title, "… · GM Kate"), to
   * start a sentence and to go in one: "The GM" and "the GM" when it isn't known.
   * @param {PersonScreen} screen
   * @param {Row} row
   */
  function gmName(screen, row) {
    const name = row.gmPays?.payer || gameTitle({ kind: 'game', title: screen.groupTitle }).gm;
    return { start: name || 'The GM', mid: name || 'the GM' };
  }

  /** "Yes, Kate pays": POST /pos/cover. The player pays nothing; the GM's charge goes on the GM's account. */
  function coverPlayer() {
    const screen = topPerson();
    if (!screen) return;
    const row = currentRow(screen, todayNow.current);
    const gm = gmName(screen, row);
    const first = firstName(row.name);
    run(
      `Putting ${first ? `${first}'s` : 'the'} seat on ${gm.mid}…`,
      async () => {
        const answer = await coverSeat({ gameId: String(row.gameId || ''), ref: String(row.ref || '') });
        const fresh = await freshSeat(row, answer);
        updatePerson((current) =>
          rowKey(current.row) === rowKey(row)
            ? { ...current, row: fresh ? { ...current.row, ...fresh } : current.row, cover: answer?.cover || { amount: 0 }, result: null, confirm: null }
            : current,
        );
        toast(`${gm.start} is paying for ${first ? `${first}'s` : 'the'} seat.`);
      },
      coverPlayer,
      'gm-pays',
    );
  }

  /** "Yes, stop Kate paying": POST /pos/uncover. The seat costs its full price again. */
  function uncoverPlayer() {
    const screen = topPerson();
    if (!screen) return;
    const row = currentRow(screen, todayNow.current);
    const gm = gmName(screen, row);
    const first = firstName(row.name);
    run(
      `Stopping ${gm.mid} paying…`,
      async () => {
        const answer = await uncoverSeat({ gameId: String(row.gameId || ''), ref: String(row.ref || '') });
        const fresh = await freshSeat(row, answer);
        updatePerson((current) =>
          rowKey(current.row) === rowKey(row)
            ? { ...current, row: fresh ? { ...current.row, ...fresh } : current.row, cover: null, result: null, confirm: null }
            : current,
        );
        toast(`${gm.start} isn't paying for ${first ? `${first}'s` : 'the'} seat any more.`);
      },
      uncoverPlayer,
      'gm-stop',
    );
  }

  /* ---------------- a group: people paying together ---------------- */

  /**
   * "Check in 3 people and add $45 to cart": each ticked person still to come is checked in (their saved passes apply,
   * as on the member view), each ticked person already here has their lines asked for (`pass: 'none'`), and every line
   * goes in one sale. Then the screen closes.
   */
  function checkInGroup() {
    const screen = topGroup();
    const group = screen ? todayNow.current?.groups.find((g) => g.key === screen.key) : null;
    if (!screen || !group) return;
    const plan = groupPlan(group.rows, screen.ticked, bookingsInCart(shopify.cart.current.value), heldNow());
    if (!plan.label) return;
    run(
      plan.checkIn.length ? 'Checking them in…' : 'Adding to the cart…',
      async () => {
        /** @type {FeeLine[]} */
        const lines = [];
        /** @type {string[]} */
        const refused = [];
        /** @type {string[]} what the Lair app said (a pass that didn't cover everyone, or wasn't used) */
        const notices = [];
        let people = 0;
        // Each answer goes on screen as it comes, so if the internet drops halfway, Try again checks in only the rest
        // (and asks the ones already in for their lines with `pass: 'none'`, so no pass is used twice).
        for (const row of plan.checkIn) {
          const answer = await checkIn({ id: row.id, type: row.type === 'join' ? 'join' : 'booking' });
          if (answer?.row) setRows([answer.row]);
          const outcome = checkinOutcome(answer);
          if (outcome.arrived) {
            lines.push(...outcome.lines);
            people += Math.max(1, Math.round(Number(row.people) || 1));
            if (outcome.notice) notices.push(`${firstName(row.name) || 'One booking'}: ${outcome.notice}`);
          } else {
            refused.push(`${firstName(row.name) || 'Someone'}: ${outcome.refused}`);
          }
        }
        for (const row of plan.add) {
          const answer = await checkIn({ id: row.id, type: row.type === 'join' ? 'join' : 'booking', pass: NO_PASS });
          if (answer?.row) setRows([answer.row]);
          lines.push(...feeLines(answer));
        }
        updateGroup((current) => (current.key === screen.key ? { ...current, ticked: [], picking: false } : current));
        const checked = people ? `Checked in ${plural(people, 'person', 'people')}. ` : '';
        // Anyone the Lair app wouldn't check in, and anything it said: on screen before anyone pays.
        const heads = [refused.length ? `${refused.join(' ')} Open them to check them in anyway.` : '', ...notices].filter(Boolean);
        if (!lines.length) {
          if (heads.length) say(refused.length ? (people ? 'Not everyone was checked in' : 'No one was checked in') : CHECK_FIRST, heads.join(' '));
          if (people) toast(`${checked}Nothing to pay.`);
          return;
        }
        const who = plan.customerId ? firstName(group.rows.find((row) => String(row.customerId ?? '') === plan.customerId)?.name) : '';
        await putInCart(lines, plan.customerId, { who, prefix: checked, checkedIn: people > 0, notices: heads });
      },
      checkInGroup,
    );
  }

  /* ---------------- a member ---------------- */

  /**
   * Today's rows for the member view, before their fees go in the cart (memberPlan): each one still to come checked in
   * (POST /pos/checkin, their saved pass used), then each one here already and still owing, and each GM charge, asked
   * for its lines with `pass: 'none'` like the person view. One by one, never POST /pos/checkin-member: that checks in
   * every row again with its saved pass, so it would use a pass on a booking staff checked in without one ("Just check
   * in (pay later)" with the pass turned off). Each answer goes on screen as it comes, so if the internet drops
   * halfway, Try again does only the rest. Returns the lines, the rows, how many were checked in, and what the Lair
   * app said (a pass that didn't cover everyone, someone it wouldn't check in).
   * @param {MemberScreen} screen
   * @param {ReturnType<typeof memberPlan>} plan
   * @returns {Promise<{ rows: Row[], lines: FeeLine[], checked: number, notices: string[] }>}
   */
  async function checkInToday(screen, plan) {
    /** @type {Row[]} */
    const rows = [];
    /** @type {FeeLine[]} */
    const lines = [];
    /** @type {string[]} */
    const notices = [];
    let checked = 0;
    /** @param {Row} row @param {any} answer */
    const take = (row, answer) => {
      if (answer?.row) {
        rows.push(answer.row);
        setRows([answer.row]);
        updateMember((current) => ({ ...current, rows: mergeRows(current.rows, [answer.row]) }));
      }
      const outcome = checkinOutcome(answer);
      lines.push(...outcome.lines);
      if (outcome.notice) notices.push(outcome.notice);
      return outcome;
    };
    for (const row of plan.coming) {
      const outcome = take(row, await checkIn({ id: row.id, type: row.type === 'join' ? 'join' : 'booking' }));
      if (outcome.arrived) checked += 1;
      else notices.push(`${row.ref || firstName(row.name) || 'One booking'} wasn't checked in: ${outcome.refused}`);
    }
    for (const row of plan.owing) take(row, await checkIn({ id: row.id, type: row.type === 'join' ? 'join' : 'booking', pass: NO_PASS }));
    return { rows, lines, checked, notices };
  }

  /**
   * A fresh look at a member (POST /pos/scan of their code), or null. Never throws: a code staff replaced since the
   * scan just means the screen carries on with what it has.
   * @param {MemberScreen} screen
   */
  async function lookAgain(screen) {
    if (!screen.member.code) return null;
    try {
      const fresh = await scanCode(String(screen.member.code));
      const next = nextScreen(fresh);
      return next?.name === 'member' ? next : null;
    } catch (error) {
      if (error instanceof LairError && error.kind === 'not-found') return null;
      throw error;
    }
  }

  /**
   * "Check in and add everything · $X" (API contract v5, section 2), from a fresh look at the member (so a session
   * paid or a tab changed since the scan isn't missed):
   *   1. today's rows checked in (checkInToday)
   *   2. their fee lines, a GM's charges for their players' seats, then their owed sessions' lines
   *   3. the tab's items, tagged `_tab`
   *   4. the member on the sale, then POST /pos/tab/:id/added
   * Then the screen closes, and says so when the check-in filled their loyalty card.
   */
  function addEverything() {
    const screen = topMember();
    if (!screen) return;
    const name = firstName(screen.member.name);
    run(
      'Adding everything to the cart…',
      async () => {
        let current = screen;
        let rows = withGroups(screen.rows, todayNow.current).map((x) => x.row);
        const fresh = await lookAgain(screen);
        if (fresh?.name === 'member') {
          current = { ...screen, rows: fresh.rows, tab: fresh.tab, passes: fresh.passes };
          rows = fresh.rows;
          setRows(fresh.rows);
          updateMember((shown) => ({ ...shown, rows: fresh.rows, tab: fresh.tab, passes: fresh.passes }));
        }
        const before = fresh?.loyalty || screen.loyalty || null;
        const inCart = { bookings: bookingsInCart(shopify.cart.current.value), tabs: tabsInCart(shopify.cart.current.value), held: heldNow(rows) };
        const plan = everythingPlan(rows, current.tab, inCart);
        if (!plan.show) {
          const something = (shopify.cart.current.value?.lineItems || []).length > 0;
          say('Nothing to add', 'Everything of theirs is paid, or in this sale already.', 'info', something ? { label: 'Close and pay', run: closeScreen } : null);
          return;
        }
        const day = plan.today.canCheckIn ? await checkInToday(current, plan.today) : { rows: [], lines: [], checked: 0, notices: [] };
        // A check-in can fill their card: look again while the cart fills.
        const card = day.checked && before ? withTimeout(lookAgain(current), CARD_WAIT_MS).catch(() => null) : Promise.resolve(null);
        /** The card after check-in, on screen; true when it filled. */
        const cardNow = async () => {
          const after = await card;
          if (after) updateMember((shown) => ({ ...shown, loyalty: after.loyalty }));
          return Boolean(after && cardFilled(before, after.loyalty));
        };
        // Today's lines, then their owed sessions' (the fresh look's, each with the Lair app's own line).
        const lines = [...day.lines, ...owedLines(plan.owed)];
        const tab = plan.tab ? current.tab : null;
        if (!lines.length && !tab) {
          const filled = await cardNow();
          const said = [...day.notices, filled ? cardFullWords(name) : ''].filter(Boolean).join(' ');
          if (said) say(filled ? 'Card full!' : CHECK_FIRST, said, filled && !day.notices.length ? 'success' : 'warning');
          toast(day.checked ? 'Checked in. Nothing to pay.' : 'Nothing to pay.');
          return;
        }
        /** @type {any} */
        let marked = null;
        const result = await addEverythingToCart({
          lines,
          tab,
          customerId: screen.member.customerId,
          markAdded: async (id) => {
            marked = await tabAdded(id);
          },
        });
        if (marked?.tab) updateMember((shown) => ({ ...shown, tab: marked.tab }));
        const outcome = everythingOutcome(result, name, day.notices);
        const filled = await cardNow();
        if (!outcome.close) {
          if (outcome.toast) toast(filled ? `${outcome.toast} ${cardFullShort(name)}` : outcome.toast);
          if (outcome.problem) {
            const message = filled ? `${outcome.problem.message} ${cardFullWords(name)}` : outcome.problem.message;
            say(outcome.problem.title, message, outcome.problem.tone, outcome.next === 'close' ? { label: 'Close and pay', run: closeScreen } : null);
          }
          return;
        }
        finish(filled ? `${outcome.toast} ${cardFullShort(name)}` : outcome.toast, {
          heading: `Added everything for ${name || 'them'}`,
          body: `${day.checked ? (name ? `${name}'s checked in. ` : "They're checked in. ") : ''}Ready to pay with Pay on Verifone.`,
          who: String(screen.member.name || ''),
          extra: filled ? cardFullWords(name) : '',
        });
      },
      addEverything,
      'everything',
    );
  }

  /** "Check in" for a member on a monthly account: today's rows checked in, their fees on the account, nothing in the cart. */
  function checkInMemberOnly() {
    const screen = topMember();
    if (!screen) return;
    const name = firstName(screen.member.name);
    run(
      'Checking in…',
      async () => {
        const plan = memberPlan(withGroups(screen.rows, todayNow.current).map((x) => x.row), cart.bookings);
        if (!plan.waiting) return;
        // Only the ones still to come: nothing to pay now, so nothing is asked for lines.
        const day = await checkInToday(screen, { ...plan, owing: [] });
        const after = day.checked && screen.loyalty ? await withTimeout(lookAgain(screen), CARD_WAIT_MS).catch(() => null) : null;
        if (after) updateMember((shown) => ({ ...shown, loyalty: after.loyalty }));
        const full = after && cardFilled(screen.loyalty, after.loyalty) ? cardFullWords(name) : '';
        const words = [day.checked ? "Today's fees go on their account." : '', ...day.notices, full].filter(Boolean).join(' ');
        const title = day.checked ? `${name ? `${name}'s` : "They're"} checked in` : 'No one was checked in';
        say(title, words, day.notices.length ? 'warning' : full ? 'success' : 'info', { label: 'Done', run: closeScreen });
      },
      checkInMemberOnly,
    );
  }

  /** "Add just the tab": the products, POST /pos/tab/:id/added, then the member on the sale, then close. */
  function addTab() {
    const screen = topMember();
    if (!screen?.tab) return;
    const tab = screen.tab;
    const name = firstName(screen.member.name);
    run(
      'Adding the tab to the cart…',
      async () => {
        /** @type {any} */
        let marked = null;
        const result = await addTabToCart(tab, screen.member.customerId, async (id) => {
          marked = await tabAdded(id);
        });
        if (marked?.tab) updateMember((current) => ({ ...current, tab: marked.tab }));
        if (result.already) {
          say('The tab is in the cart already', 'Take payment with Pay on Verifone.', 'info', { label: 'Close and pay', run: closeScreen });
          return;
        }
        const notes = tabNotes(result);
        if (!result.added.length) {
          say('Nothing from the tab went in the cart', notes.join(' ') || 'Try again.', 'critical');
          return;
        }
        if (notes.length) {
          toast(tabToast(itemCount(result.added)));
          say('Check the cart', notes.join(' '));
          return;
        }
        finish(tabToast(itemCount(result.added)), {
          heading: `Added ${name ? `${name}'s` : 'the'} tab`,
          body: 'Ready to pay with Pay on Verifone.',
          who: String(screen.member.name || ''),
        });
      },
      addTab,
      'tab',
    );
  }

  /** "Put Sam on this sale". */
  function putMemberOnSale() {
    const screen = topMember();
    if (!screen) return;
    const name = firstName(screen.member.name) || 'They';
    run(
      'Putting them on the sale…',
      async () => {
        const result = await putOnSale(screen.member.customerId, true);
        if (result === 'added' || result === 'already') toast(`${name} is on this sale`);
        else if (result === 'none') say("Couldn't put them on the sale", "The Lair app has no Shopify account for them. Use the cart's Add customer button.");
        else say("Couldn't put them on the sale", "POS said no. Use the cart's Add customer button instead.");
      },
      undefined,
      'on-sale',
    );
  }

  /* ---------------- a pass ---------------- */

  /** "Use on…" a row: check them in with this pass, then their person view with what's left to pay. @param {Row} row @param {Group} group */
  function usePassOn(row, group) {
    const screen = topPass();
    if (!screen) return;
    const pass = screen.pass;
    // The pass would cover what the sale already charges (or a share that's just been paid): never both.
    const first = firstName(row.name) || 'them';
    if (row.ref && bookingsInCart(shopify.cart.current.value).includes(String(row.ref))) {
      say(`${first === 'them' ? 'Their' : `${first}'s`} fee is in the cart`, `Take that payment first, or take the line off the sale, then use the pass on ${first}.`);
      return;
    }
    if (isHeld(row, heldNow())) {
      say(WAITING, `A share of ${row.ref} was paid a moment ago and hasn't reached the Lair app yet. Try again in a few seconds.`, 'info');
      return;
    }
    run(
      `Checking ${firstName(row.name) || 'them'} in with ${pass.label || 'the pass'}…`,
      async () => {
        const answer = await checkIn({ id: row.id, type: row.type === 'join' ? 'join' : 'booking', pass: String(pass.code) });
        if (answer?.row) setRows([answer.row]);
        const left = Number(answer?.pass?.left);
        const after = Number.isFinite(left) ? { ...pass, sessionsLeft: left } : pass;
        updatePass((current) => ({ ...current, picking: false, pass: after }));
        const next = personScreen(row, { groupKey: group.key, groupTitle: group.title || '', passes: [after], result: answer });
        // Not checked in (another day, say): "Check in anyway" should still use this pass.
        push(checkinOutcome(answer).arrived ? next : { ...next, choice: String(pass.code) });
      },
      () => usePassOn(row, group),
    );
  }

  /* ---------------- drawing ---------------- */

  const top = stack[stack.length - 1];
  const now = Date.now();
  // Shares on their way to the Lair app: checked against the Today list and the member on screen (their fresh look).
  const onScreen = [...(top.name === 'member' ? top.rows : []), ...(today?.groups || []).flatMap((group) => group.rows || [])];
  /** @type {Ctx} */
  const ctx = {
    today,
    loading,
    listProblem,
    todayKey: today?.day || dayKey(now),
    now,
    busy,
    busyKey,
    problem,
    query,
    cart: { ...cart, held: waitingRefs(pending, onScreen, cart.shares, now) },
    names: customerNames(today, seen.current),
    pending,
    backLabel: backLabel(stack, today),
    act: {
      back,
      home: goHome,
      close: closeScreen,
      scan,
      lookUp: (text, what) => handle(text, what),
      setQuery: (text) => setQuery(text),
      refresh: () => loadToday(),
      openGroup: (key) => push(groupScreen(key)),
      startPicking: (keys) => {
        setProblem(null);
        updateGroup((screen) => ({ ...screen, picking: true, ticked: [...keys] }));
      },
      setTicks: (keys) => updateGroup((screen) => ({ ...screen, ticked: keys })),
      stopPicking: () => {
        setProblem(null);
        updateGroup((screen) => ({ ...screen, picking: false, ticked: [] }));
      },
      checkInGroup,
      openRow: (row, group, passes, loyalty) =>
        push(personScreen(row, { groupKey: group?.key ?? null, groupTitle: group?.title ?? '', passes: passes || [], loyalty: loyalty || null })),
      person: (action, force) => personDo(action, force),
      setChoice: (choice) => updatePerson((screen) => ({ ...screen, choice })),
      changePass,
      undoPass,
      setSplit: (patch) => {
        setProblem(null);
        if (patch.payer) remember(patch.payer);
        updatePerson((screen) => ({ ...screen, split: { ...screen.split, ...patch } }));
      },
      addShare,
      askGm: (confirm) => {
        setProblem(null);
        updatePerson((screen) => ({ ...screen, confirm }));
      },
      cover: coverPlayer,
      uncover: uncoverPlayer,
      addEverything,
      checkInMemberOnly,
      addTab,
      putMemberOnSale,
      openPass: (pass) => push({ name: 'pass', pass, picking: false }),
      togglePicking: () => updatePass((screen) => ({ ...screen, picking: !screen.picking })),
      usePassOn,
    },
  };
  return <CurrentScreen screen={top} ctx={ctx} />;
}

/**
 * A promise, or null if it takes longer than `ms`.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T | null>}
 */
function withTimeout(promise, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Where the Back button goes, in words.
 * @param {Screen[]} stack
 * @param {Today | null} today
 */
function backLabel(stack, today) {
  const previous = stack.length > 1 ? stack[stack.length - 2] : HOME;
  switch (previous.name) {
    case 'group': {
      const group = today?.groups.find((g) => g.key === previous.key);
      return (group && gameTitle(group).name) || 'Back';
    }
    case 'person':
      return firstName(previous.row.name) || 'Back';
    case 'member':
      return firstName(previous.member.name) || 'Member';
    case 'pass':
      return previous.pass.label || 'Pass';
    default:
      return 'Today';
  }
}

/** @param {string} text */
function toast(text) {
  if (!text) return;
  try {
    shopify.toast.show(text);
  } catch {
    // The screen says the same thing.
  }
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

/** What's in the POS cart that matters here, kept up to date: booking lines, shares, tabs, the customer, and the cart itself. */
function useCart() {
  const read = (/** @type {any} */ value) => ({
    bookings: bookingsInCart(value),
    shares: sharesInCart(value),
    tabs: tabsInCart(value),
    customerId: cartCustomerId(value),
    value: value || null,
  });
  const [state, setState] = useState(() => read(shopify.cart?.current?.value));
  useEffect(() => {
    const signal = shopify.cart?.current;
    if (!signal?.subscribe) return undefined;
    return signal.subscribe((value) => setState(read(value)));
  }, []);
  return state;
}

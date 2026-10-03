// The check-in screen, opened from the "Lair check-in" tile. What staff see (views.jsx draws it):
//   Home    "Scan a code", search by name, and Today: GM games, events and table bookings in time order, with how
//           many people are here.
//   Group   everyone in it: Here, Paid, Due $X, No-show or Refund?.
//   Person  "Are you Sam?": check in (with their session pass, another, or none), then "Add $X to cart" or
//           "Split the bill" (each friend pays a share, on their own account).
//   Member  (a member code) their bookings today with "Check in everyone and add to cart", their tab with "Add tab to
//           cart", and their passes.
//   Pass    (a pass code) who has it, sessions left, and "Use on…" one of today's bookings.
// Fees go in the POS cart as custom sales tagged `_booking` (plus `_share` for a share of a bill), and a tab's items as
// the real products tagged `_tab`. When the sale is paid on the Verifone, the Lair app's orders/paid webhook marks them
// paid. API contract v4, sections 7 and 11.
import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { addFeesToCart, addTabToCart, bookingsInCart, cartCustomerId, putOnSale, sharesInCart, tabsInCart } from './cart.js';
import { readCode } from './codes.js';
import { dayKey, firstName } from './format.js';
import {
  checkinOutcome,
  currentRow,
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
  undoNote,
  withGroups,
  wrongScan,
} from './flow.js';
import { checkIn, checkInMember, getToday, LairError, problemFor, scanCode, shareBill, tabAdded, undoPassUse } from './lair.js';
import { addedToast, feeLines, itemCount, linesTotal, NOTHING_TO_PAY, shareLines, tabToast } from './lines.js';
import { amountProblem, parseDollars, payerFromScan, pendingShare, pendingState } from './split.js';
import { loadPending, savePending, saveTileEntry } from './store.js';
import { dueOf, findRow, mergeRows, replaceRows, rowKey, tileEntry } from './today.js';
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
 * @typedef {import('./flow.js').PersonScreen} PersonScreen
 * @typedef {import('./flow.js').MemberScreen} MemberScreen
 * @typedef {import('./flow.js').PassScreen} PassScreen
 * @typedef {import('./split.js').Pending} Pending
 * @typedef {import('./views.jsx').Shown} Shown
 * @typedef {import('./views.jsx').Want} Want
 * @typedef {import('./views.jsx').Ctx} Ctx
 * @typedef {Awaited<ReturnType<typeof addFeesToCart>>} CartResult
 */

/** A scan button sets what the next scan is for; after two minutes without one, a scan is just a scan again. */
const WANT_MS = 120_000;

function CheckIn() {
  const [today, setToday] = useState(/** @type {Today | null} */ (null));
  const [loading, setLoading] = useState(false);
  const [listProblem, setListProblem] = useState(/** @type {Shown | null} */ (null));
  const [stack, setStack] = useState(/** @type {Screen[]} */ ([HOME]));
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState(/** @type {Shown | null} */ (null));
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(/** @type {Record<string, Pending>} */ ({}));
  const cart = useCart();

  const working = useRef(false);
  const cameraOpen = useRef(false);
  const want = useRef(/** @type {{ want: Want, at: number }} */ ({ want: 'any', at: 0 }));
  const loadingNow = useRef(false);
  const stale = useRef(false);
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

  /* ---------------- shares of a bill waiting to be paid ---------------- */

  /** @param {Record<string, Pending>} next */
  function keepPending(next) {
    pendingNow.current = next;
    setPending(next);
    savePending(next);
  }

  /** @param {string} key @param {Pending} note */
  function rememberShare(key, note) {
    keepPending({ ...pendingNow.current, [key]: note });
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

  /* ---------------- doing one thing at a time ---------------- */

  /**
   * One action at a time, with a busy line while it runs and a plain-words banner if it fails.
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
      const shown = problemFor(error);
      setProblem({ ...shown, retry: shown.retry && retry ? retry : null });
    } finally {
      working.current = false;
      setBusy('');
    }
  }

  /** @param {string} title @param {string} message @param {'critical' | 'warning' | 'info'} [tone] */
  function say(title, message, tone = 'warning') {
    setProblem({ title, message, tone, retry: null });
  }

  /* ---------------- moving between screens ---------------- */

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

  /** @param {string} key */
  const groupExists = (key) => Boolean(todayNow.current?.groups.some((g) => g.key === key));

  /** After the cart: back to the member, or to their group. @param {PersonScreen} screen */
  function leavePerson(screen) {
    navigate(stackAfterPerson(stackNow.current, screen.groupKey, groupExists));
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
      say("Couldn't open the camera", what === 'any' ? 'Type the code into the search box instead.' : 'Type the code in instead.');
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
      say(words.title, words.message);
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
            say('Code not found', `${error.message} Check it with them, or search by name.`);
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
      { want: what, screen: topScreen().name, splitOpen: Boolean(person?.split.open), takesPass: Boolean(row && row.type !== 'join' && dueOf(row) > 0) },
      answer?.type,
    );
    if (purpose === 'wrong') {
      const words = wrongScan(what === 'pass' ? 'pass' : 'payer');
      say(words.title, words.message);
      return;
    }
    if (purpose === 'payer') {
      const found = payerFromScan(answer);
      if ('problem' in found) {
        say("That's not a member code", found.problem);
        return;
      }
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
    if (screen.name === 'member') setRows(screen.rows);
    setQuery('');
    navigate([HOME, screen]);
  }

  /* ---------------- a person: check in, the cart, a share of the bill ---------------- */

  /** "Check in", "Check in anyway" and "Use this pass". @param {boolean} force */
  function doCheckIn(force) {
    const screen = topPerson();
    if (!screen) return;
    const row = currentRow(screen, todayNow.current);
    const pass = passParam(screen.choice, row);
    run(force ? 'Checking in anyway…' : 'Checking in…', () => checkInPerson(row, { pass, force }), () => doCheckIn(force));
  }

  /**
   * POST /pos/checkin for the person on screen, then their row, any pass use it made (so it can be undone) and the
   * answer on screen.
   * @param {Row} row
   * @param {{ pass?: string, force?: boolean }} options
   */
  async function checkInPerson(row, { pass, force = false }) {
    const answer = await checkIn({ id: row.id, type: row.type === 'join' ? 'join' : 'booking', pass, force });
    if (answer?.row) setRows([answer.row]);
    const outcome = checkinOutcome(answer);
    updatePerson((current) => {
      if (rowKey(current.row) !== rowKey(row)) return current;
      const fresh = answer?.row ? { ...current.row, ...answer.row } : current.row;
      const uses = recordUses(current.uses, answer);
      const choice = outcome.arrived ? passOptions(fresh, current.passes, passInUse(fresh, uses)).picked : current.choice;
      return { ...current, row: fresh, result: answer, uses, note: null, choice };
    });
    if (outcome.arrived && !outcome.total) toast(NOTHING_TO_PAY);
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
        await checkInPerson(current, { pass: change.pass });
      },
      changePass,
    );
  }

  /** "Add $X to cart": the check-in's lines (asked for again if what's due has changed), then back to the group. */
  function addToCart() {
    const screen = topPerson();
    if (!screen) return;
    const row = currentRow(screen, todayNow.current);
    run(
      'Adding to the cart…',
      async () => {
        let answer = screen.result;
        let lines = answer && checkinOutcome(answer).arrived ? feeLines(answer) : [];
        if (!lines.length || linesTotal(lines) !== dueOf(row)) {
          // What's due now. 'none': asking again never uses a pass by itself.
          answer = await checkIn({ id: row.id, type: row.type === 'join' ? 'join' : 'booking', pass: NO_PASS });
          if (answer?.row) setRows([answer.row]);
          const fresh = answer;
          updatePerson((current) => (rowKey(current.row) === rowKey(row) ? { ...current, result: fresh } : current));
          lines = feeLines(answer);
        }
        if (!lines.length) {
          toast(NOTHING_TO_PAY);
          return;
        }
        const added = await addFeesToCart(lines, answer?.customer?.id ?? null);
        if (stayAfterCart(added)) return;
        toast(addedToast(linesTotal(added.added)));
        leavePerson(screen);
        warnAfterCart(added, firstName(row.name), String(row.ref || ''));
      },
      addToCart,
    );
  }

  /** "Add $X to cart" in Split the bill: POST /pos/share, its line in the cart, the payer on the sale. */
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
        const added = await addFeesToCart(lines, payer ? payer.customerId : null, { replaceCustomer: Boolean(payer) });
        if (stayAfterCart(added)) return;
        const cents = linesTotal(added.added);
        rememberShare(rowKey(row), pendingShare(answer?.row ? { ...row, ...answer.row } : row, cents, Date.now()));
        toast(addedToast(cents));
        leavePerson(screen);
        warnAfterCart(added, payer ? firstName(payer.name) : '', String(row.ref || ''));
      },
      addShare,
    );
  }

  /**
   * After adding to the cart: stay on this screen with a banner when nothing new went in.
   * @param {CartResult} added
   * @returns {boolean} stay
   */
  function stayAfterCart(added) {
    if (added.failed.length) {
      const said = added.failed[0].message.replace(/[.!]+$/, '');
      say(
        added.added.length ? "Some of it isn't in the cart" : "It isn't in the cart",
        `POS said: ${said}. Add it by hand as a custom sale: ${added.failed.map(({ line }) => `${line.title}, $${line.price}`).join('; ')}.`,
        'critical',
      );
      return true;
    }
    if (!added.added.length) {
      say('Already in the cart', "There's a line for this booking in the cart already. Take that payment first, or take it off the sale.", 'info');
      return true;
    }
    return false;
  }

  /**
   * Things to know after the cart, shown on the next screen.
   * @param {CartResult} added
   * @param {string} who
   * @param {string} ref
   */
  function warnAfterCart(added, who, ref) {
    if (added.unlinked.length) {
      say(
        "It's in the cart, but not linked",
        `Paying won't mark ${ref || 'the booking'} paid by itself. After they pay, mark it paid on the staff page.`,
      );
    } else if (added.customer === 'failed') {
      say(`Couldn't put ${who || 'them'} on the sale`, "Add them with the cart's Add customer button, so their spend counts.", 'info');
    }
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

  /* ---------------- a member ---------------- */

  /**
   * The member view's main button. While someone is still to come: "Check in everyone and add to cart" (POST
   * /pos/checkin-member). Once they're all here: "Add $X to cart" for each row still owing, its lines asked for with
   * `pass: 'none'` like the person view, so the amount on the button is what goes in the cart.
   */
  function checkInEveryone() {
    const screen = topMember();
    if (!screen) return;
    const name = firstName(screen.member.name);
    const plan = memberPlan(withGroups(screen.rows, todayNow.current).map((x) => x.row), cart.bookings);
    run(
      plan.waiting ? 'Checking everyone in…' : 'Adding to the cart…',
      async () => {
        /** @type {any} */
        let answer;
        if (plan.waiting) {
          answer = await checkInMember(screen.member.customerId);
        } else {
          const answers = [];
          for (const row of plan.owing) answers.push(await checkIn({ id: row.id, type: row.type === 'join' ? 'join' : 'booking', pass: NO_PASS }));
          answer = {
            rows: answers.map((a) => a?.row).filter(Boolean),
            lines: answers.flatMap((a) => (Array.isArray(a?.lines) ? a.lines : [])),
            customer: { id: screen.member.customerId },
            notices: answers.map((a) => a?.notice).filter(Boolean),
          };
        }
        /** @type {Row[]} */
        const rows = Array.isArray(answer?.rows) ? answer.rows : [];
        setRows(rows);
        const notices = Array.isArray(answer?.notices) ? answer.notices.map(String) : [];
        updateMember((current) => ({ ...current, rows: mergeRows(current.rows, rows), notices }));
        const lines = feeLines(answer);
        if (!lines.length) {
          toast(NOTHING_TO_PAY);
          return;
        }
        const added = await addFeesToCart(lines, answer?.customer?.id ?? screen.member.customerId);
        if (stayAfterCart(added)) return;
        toast(addedToast(linesTotal(added.added)));
        warnAfterCart(added, name, '');
      },
      checkInEveryone,
    );
  }

  /** "Add tab to cart": the products, POST /pos/tab/:id/added, then the member on the sale. */
  function addTab() {
    const screen = topMember();
    if (!screen?.tab) return;
    const tab = screen.tab;
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
          say('The tab is in the cart already', 'Take payment on the Verifone.', 'info');
          return;
        }
        const notes = [];
        if (result.failed.length) notes.push(`POS couldn't add ${result.failed.map((f) => f.item.title).join(', ')} (${result.failed[0].message}).`);
        if (result.declined.length) notes.push(`Not added: ${result.declined.map((i) => i.title).join(', ')}.`);
        if (result.bad.length) notes.push(`Ring these up by hand: ${result.bad.join(', ')}.`);
        if (result.untagged.length) notes.push(`${result.untagged.map((i) => i.title).join(', ')} isn't linked to the tab, so paying won't mark the tab paid by itself.`);
        if (result.markProblem) notes.push(`The Lair app wasn't told the tab is at the counter (${result.markProblem}), so they could still change it in My Lair.`);
        if (!result.added.length) {
          say('Nothing from the tab went in the cart', notes.join(' ') || 'Try again.', 'critical');
          return;
        }
        toast(tabToast(itemCount(result.added)));
        if (notes.length) say('Check the cart', notes.join(' '));
      },
      addTab,
    );
  }

  /** "Put Sam on this sale". */
  function putMemberOnSale() {
    const screen = topMember();
    if (!screen) return;
    const name = firstName(screen.member.name) || 'They';
    run('Putting them on the sale…', async () => {
      const result = await putOnSale(screen.member.customerId, true);
      if (result === 'added' || result === 'already') toast(`${name} is on this sale`);
      else if (result === 'none') say("Couldn't put them on the sale", "The Lair app has no Shopify account for them. Use the cart's Add customer button.");
      else say("Couldn't put them on the sale", "POS said no. Use the cart's Add customer button instead.");
    });
  }

  /* ---------------- a pass ---------------- */

  /** "Use on…" a row: check them in with this pass, then their person view with what's left to pay. @param {Row} row @param {Group} group */
  function usePassOn(row, group) {
    const screen = topPass();
    if (!screen) return;
    const pass = screen.pass;
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
  /** @type {Ctx} */
  const ctx = {
    today,
    loading,
    listProblem,
    todayKey: today?.day || dayKey(Date.now()),
    now: Date.now(),
    busy,
    problem,
    query,
    cart,
    pending,
    backLabel: backLabel(stack, today),
    act: {
      back,
      scan,
      lookUp: (text, what) => handle(text, what),
      setQuery: (text) => setQuery(text),
      refresh: () => loadToday(),
      openGroup: (key) => push({ name: 'group', key }),
      openRow: (row, group, passes) => push(personScreen(row, { groupKey: group?.key ?? null, groupTitle: group?.title ?? '', passes: passes || [] })),
      checkIn: (force) => doCheckIn(force),
      setChoice: (choice) => updatePerson((screen) => ({ ...screen, choice })),
      changePass,
      undoPass,
      addToCart,
      done: () => {
        const screen = topPerson();
        if (screen) leavePerson(screen);
      },
      setSplit: (patch) => {
        setProblem(null);
        updatePerson((screen) => ({ ...screen, split: { ...screen.split, ...patch } }));
      },
      addShare,
      refreshRow,
      forgetShare,
      checkInEveryone,
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
 * Where the Back button goes, in words.
 * @param {Screen[]} stack
 * @param {Today | null} today
 */
function backLabel(stack, today) {
  const previous = stack.length > 1 ? stack[stack.length - 2] : HOME;
  switch (previous.name) {
    case 'group':
      return today?.groups.find((g) => g.key === previous.key)?.title || 'Back';
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

/** What's in the POS cart that matters here, kept up to date: booking lines, shares, tabs and the customer. */
function useCart() {
  const read = (/** @type {any} */ value) => ({
    bookings: bookingsInCart(value),
    shares: sharesInCart(value),
    tabs: tabsInCart(value),
    customerId: cartCustomerId(value),
  });
  const [state, setState] = useState(() => read(shopify.cart?.current?.value));
  useEffect(() => {
    const signal = shopify.cart?.current;
    if (!signal?.subscribe) return undefined;
    return signal.subscribe((value) => setState(read(value)));
  }, []);
  return state;
}


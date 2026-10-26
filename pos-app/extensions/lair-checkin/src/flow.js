// Which screen comes next, and what each screen offers: after a scan, at check-in, with passes and tabs, and after the
// cart. No `shopify` global here, so `npm test` can check it without a POS.
import { readCode } from './codes.js';
import { dateLabel, dayKey, firstName, money, plural, shortDay, timeRange } from './format.js';
import { addedToast, everythingToast, feeLines, itemCount, linesTotal, NOTHING_TO_PAY, passUsedLabel, tabCents, tabItems } from './lines.js';
import { canSplit, splitFirst } from './split.js';
import { dueOf, findRow, isArrived, isHeld, isOwed, isPayOnly, passSummary, passUsable, rowKey, rowState } from './today.js';

/**
 * @typedef {import('./today.js').Row} Row
 * @typedef {import('./today.js').PassLike} PassLike
 * @typedef {import('./today.js').Today} Today
 * @typedef {import('./lines.js').Tab} Tab
 * @typedef {import('./lines.js').UsedPass} UsedPass
 * @typedef {import('./lines.js').FeeLine} FeeLine
 * @typedef {import('./lines.js').TabItem} TabItem
 * @typedef {{ added: FeeLine[], skipped: FeeLine[], unlinked: FeeLine[], failed: { line: FeeLine, message: string }[] }} FeesResult
 *   what happened to some fee lines in the cart (cart.js)
 * @typedef {{ already: boolean, added: TabItem[], declined: TabItem[], untagged: TabItem[],
 *   failed: { item: TabItem, message: string }[], bad: string[], markProblem: string }} TabResult
 *   what happened to a tab's items in the cart (cart.js)
 * @typedef {{ title: string, message: string, tone: 'critical' | 'warning' | 'info' }} Banner
 * @typedef {import('./split.js').Payer} Payer
 * @typedef {{ customerId?: unknown, name?: string, code?: string | null }} Member
 * @typedef {{ row?: Row | null, lines?: unknown, customer?: { id?: unknown } | null, pass?: UsedPass | null,
 *   notice?: string | null, message?: string, checkedIn?: boolean }} CheckinAnswer what POST /pos/checkin answers
 * @typedef {{ open: boolean, mode: 'person' | 'custom', custom: string, payer: Payer | null }} SplitState
 * @typedef {{ useId: string, code: string, label: string, covered: number, used: number, left: number | null }} KnownUse
 *   a pass use this screen saw in a check-in answer, so "Undo pass" can give it back
 * @typedef {{ heading: string, body: string }} Note a banner the person view shows, like "Pass undone. $45 to pay."
 * @typedef {{ ref?: string, amount?: number, people?: number, paid?: boolean, due?: number, status?: string, locked?: boolean }} Cover
 *   the GM's charge from POST /pos/cover (contract v21-gm-cover)
 * @typedef {{ name: 'person', row: Row, groupKey: string | null, groupTitle: string, passes: PassLike[],
 *   choice: string | null, result: CheckinAnswer | null, split: SplitState, uses: KnownUse[], note: Note | null,
 *   loyalty?: object | null, filled?: boolean, cover?: Cover | null, confirm?: 'cover' | 'uncover' | null }} PersonScreen
 *   loyalty: their loyalty card, when this screen has it (from their member code, or a ticket's scan once the Lair app
 *   sends it); filled: this screen's check-in filled their card; cover: the GM's charge this screen just set up;
 *   confirm: "GM pays" (or stop) is waiting for a yes
 * @typedef {{ name: 'member', member: Member, rows: Row[], tab: Tab | null, passes: PassLike[], loyalty?: object | null,
 *   account?: { billing?: string, creditLimit?: number, owed?: number, available?: number | null, warning?: string | null } | null }} MemberScreen
 *   loyalty: their loyalty card from the scan (`{ stamps, cardSize, rollsAvailable, card }`, rounds 6 and 7), for show only
 *   account: their billing from the scan (round 9): `{ billing: 'visit' }`, or a monthly account's limit and what's owed
 * @typedef {{ name: 'pass', pass: PassLike & Record<string, any>, picking: boolean }} PassScreen
 * @typedef {{ name: 'group', key: string, ticked: string[], picking: boolean }} GroupScreen
 *   picking: "Check in several at once" is open; ticked: the rowKeys ticked to pay together
 * @typedef {{ name: 'ready', heading: string, body: string, who: string, extra: string }} ReadyScreen
 *   what went in the cart, shown only when the check-in screen didn't close by itself (a POS bug): "Close and pay"
 * @typedef {{ name: 'home' } | GroupScreen | PersonScreen | MemberScreen | PassScreen | ReadyScreen} Screen
 */

/** @type {Screen} */
export const HOME = { name: 'home' };

/** The pass choice that means "don't use a pass" (sent to POST /pos/checkin as `pass: 'none'`). */
export const NO_PASS = 'none';

/** @param {unknown} text */
const alnum = (text) =>
  String(text ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/** @param {unknown} value */
const lower = (value) => String(value ?? '').toLowerCase();

/**
 * The person view ("Are you Sam?") for a row.
 * @param {Row} row
 * @param {{ groupKey?: string | null, groupTitle?: string, passes?: PassLike[], result?: CheckinAnswer | null, loyalty?: object | null }} [options]
 *   passes: a member's passes, when they came from scanning their member code; loyalty: their card, when known
 * @returns {PersonScreen}
 */
export function personScreen(row, { groupKey = null, groupTitle = '', passes = [], result = null, loyalty = null } = {}) {
  const merged = result?.row ? { ...row, ...result.row } : row;
  const uses = recordUses([], result);
  return {
    name: 'person',
    row: merged,
    groupKey,
    groupTitle,
    passes,
    choice: passOptions(merged, passes, passInUse(merged, uses)).picked,
    result,
    split: { open: false, mode: 'person', custom: '', payer: null },
    uses,
    note: null,
    loyalty,
    filled: false,
    cover: null,
    confirm: null,
  };
}

/**
 * The screen for a `POST /pos/scan` answer, or null when the answer isn't one the screen knows.
 *   booking or join → the person view ("Are you Sam?")
 *   member          → the member view (their rows today, tab and passes)
 *   pass            → the pass view
 * @param {any} answer
 * @returns {Screen | null}
 */
export function nextScreen(answer) {
  const type = answer?.type;
  if ((type === 'booking' || type === 'join') && answer.row && answer.row.id != null) {
    return personScreen(
      { ...answer.row, type: answer.row.type || type },
      {
        groupKey: answer.group?.key != null ? String(answer.group.key) : null,
        groupTitle: String(answer.group?.title || ''),
        // their card, once the Lair app sends it with tickets (the counter's ask, 27 Oct 2026)
        loyalty: answer.loyalty && typeof answer.loyalty === 'object' ? answer.loyalty : null,
      },
    );
  }
  if (type === 'member' && answer.member) {
    return {
      name: 'member',
      member: answer.member,
      rows: Array.isArray(answer.rows) ? answer.rows : [],
      tab: answer.tab && typeof answer.tab === 'object' ? answer.tab : null,
      passes: Array.isArray(answer.passes) ? answer.passes : [],
      loyalty: answer.loyalty && typeof answer.loyalty === 'object' ? answer.loyalty : null,
      account: answer.account && typeof answer.account === 'object' ? answer.account : null,
    };
  }
  if (type === 'pass' && answer.pass && typeof answer.pass === 'object') return { name: 'pass', pass: answer.pass, picking: false };
  return null;
}

/**
 * Where to go once a person's fee is in the cart: back to the member view if that's where they came from, otherwise
 * to their group, otherwise one step back.
 * @param {Screen[]} stack the screens so far, the person view last
 * @param {string | null} groupKey
 * @param {(key: string) => boolean} groupExists
 * @returns {Screen[]}
 */
export function stackAfterPerson(stack, groupKey, groupExists) {
  const previous = stack.length > 1 ? stack[stack.length - 2] : null;
  if (previous?.name === 'member') return stack.slice(0, -1);
  if (groupKey && groupExists(groupKey)) return [HOME, groupScreen(groupKey)];
  return stack.length > 1 ? stack.slice(0, -1) : [HOME];
}

/** A group view, nobody ticked. @param {string} key @returns {GroupScreen} */
export function groupScreen(key) {
  return { name: 'group', key, ticked: [], picking: false };
}

/**
 * The freshest copy of the person view's row: the Today list's (it's updated after every check-in), else the one the
 * screen was opened with, updated by its last check-in.
 * @param {PersonScreen} screen
 * @param {Today | null} today
 * @returns {Row}
 */
export function currentRow(screen, today) {
  const listed = findRow(today, screen.row.id, screen.row.type)?.row;
  if (listed) return listed;
  return screen.result?.row ? { ...screen.row, ...screen.result.row } : screen.row;
}

/**
 * The pass uses in a check-in answer, added to the ones this screen already knows (each answer's `pass.useId`).
 * @param {KnownUse[]} uses
 * @param {CheckinAnswer | null | undefined} answer
 * @returns {KnownUse[]}
 */
export function recordUses(uses, answer) {
  const list = uses || [];
  const pass = answer?.pass;
  const useId = pass?.useId != null ? String(pass.useId) : '';
  if (!useId || list.some((u) => u.useId === useId)) return list;
  const left = Number(pass?.left);
  return [
    ...list,
    {
      useId,
      code: String(pass?.code || ''),
      label: String(pass?.label || pass?.code || 'The pass'),
      covered: Math.max(0, Math.round(Number(pass?.covered) || 0)),
      used: Math.max(0, Math.round(Number(pass?.used) || 0)),
      left: Number.isFinite(left) ? Math.max(0, Math.round(left)) : null,
    },
  ];
}

/**
 * The pass covering this booking now, if any: the last one this screen used, or else the booking's own pass when
 * something is covered (checked in earlier, here or on the staff page).
 * @param {Row} row the freshest copy
 * @param {KnownUse[]} uses
 * @returns {{ code: string, label: string, left: number | null } | null}
 */
export function passInUse(row, uses) {
  if (!(Number(row?.covered) > 0)) return null;
  const list = uses || [];
  const last = list[list.length - 1];
  if (last) return { code: last.code, label: last.label, left: last.left };
  const own = row?.pass;
  const left = Number(own?.left);
  return { code: String(own?.code || ''), label: String(own?.label || own?.code || 'A pass'), left: Number.isFinite(left) ? left : null };
}

/**
 * The pass choices on the person view, and which starts picked. Passes only cover table fees, so event entries
 * never get any.
 *   Before check-in: the booking's saved pass (picked), the member's other passes and any pass scanned here, then
 *   "Don't use a pass" (picked when there's no saved pass).
 *   Once they're here, with a pass in use: that pass (picked), the others, and "Don't use a pass". Picking another
 *   one switches: the pass in use is undone first (POST /pos/pass-undo).
 *   Once they're here, with no pass in use: passes that could cover what's still due, none picked.
 * @param {Row} row
 * @param {PassLike[]} passes
 * @param {{ code: string, label: string, left: number | null } | null} [inUse] passInUse
 * @returns {{ options: { value: string, label: string }[], picked: string | null }}
 */
export function passOptions(row, passes, inUse = null) {
  if (!row || row.type === 'join') return { options: [], picked: null };
  const arrived = isArrived(row);
  if (arrived && !dueOf(row) && !inUse) return { options: [], picked: null };
  const seen = new Set();
  /** @type {{ value: string, label: string }[]} */
  const options = [];
  /** @param {PassLike} pass @param {string} label */
  const add = (pass, label) => {
    const key = alnum(pass.code);
    if (!key || seen.has(key)) return;
    seen.add(key);
    options.push({ value: String(pass.code), label });
  };
  const using = arrived && inUse?.code ? inUse : null;
  if (using) add({ code: using.code }, `${passSummary({ label: using.label, code: using.code, left: using.left ?? undefined })} (in use)`);
  const saved = row.pass?.code && passUsable(row.pass) && !(arrived && !using && Number(row.covered) > 0) ? row.pass : null;
  if (saved) add(saved, `${passSummary(saved)} (saved on the booking)`);
  if (row.pass?.code) seen.add(alnum(row.pass.code));
  for (const pass of passes || []) if (passUsable(pass)) add(pass, passSummary(pass));
  if (arrived && !inUse) return { options, picked: null };
  if (options.length || inUse) options.push({ value: NO_PASS, label: "Don't use a pass" });
  if (arrived) return { options, picked: using ? String(using.code) : null };
  return { options, picked: saved ? String(saved.code) : options.length ? NO_PASS : null };
}

/**
 * What the pass button does once they're here, for the picked choice:
 *   none    nothing to change: the pass in use is picked, or no pass is in use and none is picked
 *   use     no pass in use yet: check in again with the picked pass (it covers what's still due)
 *   switch  a pass is in use and something else is picked: undo it, then check in again with the new choice
 *           (a pass code, or 'none' for "Don't use a pass")
 * @param {{ code: string } | null} inUse passInUse
 * @param {string | null} choice
 * @returns {{ action: 'none' | 'use' | 'switch', pass: string, label: string }}
 */
export function passChange(inUse, choice) {
  const none = { action: /** @type {const} */ ('none'), pass: '', label: '' };
  if (!choice) return none;
  if (inUse) {
    if (inUse.code && alnum(inUse.code) === alnum(choice)) return none;
    if (choice === NO_PASS) return { action: 'switch', pass: NO_PASS, label: 'Check in again without a pass' };
    return { action: 'switch', pass: choice, label: 'Switch to this pass' };
  }
  if (choice === NO_PASS) return none;
  return { action: 'use', pass: choice, label: 'Use this pass' };
}

/**
 * The uses of a pass on one booking that haven't been undone, from the pass as POST /pos/scan gives it (its `uses`).
 * For undoing a pass this screen didn't use itself.
 * @param {any} pass
 * @param {unknown} bookingId
 * @returns {string[]}
 */
export function openUseIds(pass, bookingId) {
  return (Array.isArray(pass?.uses) ? pass.uses : [])
    .filter((use) => use && use.id != null && String(use.bookingId) === String(bookingId) && !use.undone)
    .map((use) => String(use.id));
}

/**
 * What staff see after "Undo pass": what's to pay now, and the sessions back on the pass.
 * @param {{ pass?: any, row?: Row | null }[]} answers the POST /pos/pass-undo answers, oldest first
 * @param {Row} row the row after undoing
 * @returns {Note}
 */
export function undoNote(answers, row) {
  const due = dueOf(row);
  /** @type {Map<string, string>} */
  const passes = new Map();
  for (const answer of answers || []) {
    const pass = answer?.pass;
    if (!pass) continue;
    const left = Number(pass.sessionsLeft ?? pass.left);
    const name = String(pass.label || pass.code || 'The pass');
    passes.set(String(pass.code || name), Number.isFinite(left) ? `${name} has ${plural(Math.max(0, left), 'session')} left.` : `The session is back on ${name}.`);
  }
  return {
    heading: `Pass undone. ${due > 0 ? `${money(due)} to pay.` : 'Nothing to pay.'}`,
    body: [...passes.values()].join(' ') || 'The session is back on the pass.',
  };
}

/**
 * What to send as `pass` to POST /pos/checkin for the person view's choice:
 *   not here yet  the saved pass → left out (the Lair app uses the booking's own), another → its code,
 *                 "Don't use a pass" → 'none'
 *   here already  a pass picked to cover what's left → its code; otherwise 'none', so asking for the cart lines
 *                 again never uses a pass by itself
 * @param {string | null} choice
 * @param {Row} row
 * @returns {string | undefined}
 */
export function passParam(choice, row) {
  if (isArrived(row)) return choice && choice !== NO_PASS ? choice : NO_PASS;
  if (!choice) return undefined;
  if (choice === NO_PASS) return NO_PASS;
  if (row.pass?.code && alnum(row.pass.code) === alnum(choice)) return undefined;
  return choice;
}

/**
 * What a check-in answer means for the screen. A GM's charge for a player's seat (`reason: 'cover'`, contract
 * v21-gm-cover) is never checked in, but has its line to pay: payOnly.
 * @param {CheckinAnswer | null | undefined} answer
 */
export function checkinOutcome(answer) {
  const row = answer?.row || null;
  if (/** @type {{ reason?: unknown }} */ (answer || {}).reason === 'cover') {
    const lines = feeLines(answer);
    const total = linesTotal(lines);
    return { arrived: false, payOnly: true, refused: '', lines, total, text: total ? `${money(total)} to pay.` : 'Nothing to pay.', passText: '', notice: '' };
  }
  const arrived = answer?.checkedIn === true || (answer?.checkedIn !== false && Boolean(row && isArrived(row)));
  if (!arrived) {
    return { arrived: false, payOnly: false, refused: String(answer?.notice || answer?.message || "They weren't checked in."), lines: [], total: 0, text: '', passText: '', notice: '' };
  }
  const lines = feeLines(answer);
  const total = linesTotal(lines);
  return {
    arrived: true,
    payOnly: false,
    refused: '',
    lines,
    total,
    text: total > 0 ? `Checked in. ${money(total)} to pay.` : NOTHING_TO_PAY,
    passText: passUsedLabel(answer?.pass),
    notice: String(answer?.notice || ''),
  };
}

/**
 * Where the person view is at:
 *   owed      paid, never checked in: a weekly regular's seat whose session ended unpaid ("Owed: …"; they owe it
 *             whether or not they came), or a GM's charge for one of their players' seats
 *   paid      one of those with nothing left to pay
 *   check-in  not here yet: "Check in", or "Check in anyway" with a warning (cancelled, no-show, another day, or
 *             the Lair app said no)
 *   pay       here, with money left to pay
 *   done      here, nothing to pay
 * @param {Row} row the freshest copy (currentRow)
 * @param {CheckinAnswer | null} result this screen's last check-in answer
 * @param {string} todayKey the Lair day, "2026-10-03"
 * @returns {{ stage: 'owed' | 'paid' | 'check-in' | 'pay' | 'done', force: boolean, warning: string }}
 */
export function personPlan(row, result, todayKey) {
  if (isPayOnly(row)) return { stage: dueOf(row) > 0 ? 'owed' : 'paid', force: false, warning: '' };
  const outcome = result ? checkinOutcome(result) : null;
  const arrived = isArrived(row) || Boolean(outcome?.arrived);
  if (arrived) return { stage: dueOf(row) > 0 ? 'pay' : 'done', force: false, warning: '' };
  const noun = row.type === 'join' ? 'sign-up' : 'booking';
  let warning = '';
  if (outcome && !outcome.arrived) warning = outcome.refused;
  else if (lower(row.status) === 'cancelled') warning = `This ${noun} was cancelled.`;
  else if (['noshow', 'no-show'].includes(lower(row.status))) warning = `This ${noun} was marked as a no-show.`;
  else if (todayKey && Number(row.start) && dayKey(Number(row.start)) !== todayKey) {
    // Never "Today" here: this warning only shows for another day (and the screen's day can differ from the clock's)
    warning = `This ${noun} is for ${shortDay(row.start)}, ${timeRange(row.start, row.end)}, not today.`;
  }
  return { stage: 'check-in', force: Boolean(warning), warning };
}

/** Under a button that puts something in the cart: what happens next (Mo, 27 Oct 2026). */
export const CLOSES = 'The screen closes, ready for Pay on Verifone.';

/**
 * Why someone checked in has nothing to pay, for the screen that says they're in.
 * @param {Row} row the freshest copy
 */
export function whyNothing(row) {
  const gm = row?.kind === 'gm-seat' && row?.gmPays?.on ? row.gmPays : null;
  if (gm) return `Nothing to pay: ${gm.payer || 'the GM'} is paying for this seat.`;
  const amount = Math.max(0, Math.round(Number(row?.amount) || 0));
  const paid = Math.max(0, Math.round(Number(row?.paidAmount) || 0));
  if (row?.waived && !paid) return 'Nothing to pay: it was waived.';
  if (amount > 0 && !paid && (Number(row?.covered) || 0) >= amount) return 'Nothing to pay: their pass covers it.';
  if (amount > 0) return "Nothing to pay: it's paid.";
  return 'Nothing to pay.';
}

/**
 * @typedef {'check-in' | 'check-in-add' | 'check-in-split' | 'check-in-only' | 'add' | 'use-pass' | 'split' | 'close' | 'refresh' | 'forget' | 'done' | 'back'} PersonActionName
 *   check-in        check in, nothing goes in the cart (nothing to pay, or "Check in anyway")
 *   check-in-add    check in, then put what's left to pay in the cart and close the screen
 *   check-in-split  check in, then split the bill
 *   check-in-only   check in and pay later
 *   add             put what's due in the cart and close the screen
 *   use-pass        once they're here: use the pass picked for what's left, then put anything still to pay in the cart
 *   split           split the bill
 *   close           close the screen: it's in the cart, ready to pay
 *   refresh         look for the last share's payment again; forget: it wasn't paid
 *   done / back     close the screen / go back
 * @typedef {{ action: PersonActionName, label: string, force: boolean, hint: string,
 *   more: { action: PersonActionName, label: string }[] }} PersonAction
 */

/**
 * The person view's one main button, and the quieter ones under it (Mo, 27 Oct 2026: "one obvious next step on every
 * screen", and fewer taps to payment). Before check-in, checking in and adding to the cart are one tap; "Just check
 * in" is there for anyone paying later. Splitting leads when they said they'd split or part is paid already, and a
 * pass picked for what's left leads once they're here.
 * @param {{ row: Row, plan: ReturnType<typeof personPlan>, choice: string | null, inUse?: { code: string } | null,
 *   inCart: boolean, shareInCart?: boolean, share: import('./split.js').PendingState, justChecked: boolean }} input
 *   choice: the pass choice; inUse: the pass covering it now (passInUse); inCart: a line for its booking is in this
 *   cart; shareInCart: that line is a share (someone's part of the bill, or a named player's own share); share: where a
 *   share of its bill put in the cart from this iPad has got to; justChecked: this screen checked them in
 * @returns {PersonAction}
 */
export function personAction({ row, plan, choice, inUse = null, inCart, shareInCart = false, share, justChecked }) {
  const due = dueOf(row);
  /** @param {PersonActionName} action @param {string} label @param {Partial<PersonAction>} [extra] @returns {PersonAction} */
  const make = (action, label, extra = {}) => ({ action, label, force: false, hint: '', more: [], ...extra });
  // Someone's share of this booking is in the sale (not one this screen is waiting on): that payment comes first, as
  // the cart takes one line a booking, and the sale's customer is who the Lair app counts as paying.
  const close =
    inCart && shareInCart && share !== 'in-cart'
      ? make('close', 'Close and pay', { hint: 'A share of this booking is in the cart. Take that payment first, then open them again.' })
      : make('close', 'Close and pay', { hint: "It's in the cart. Take payment with Pay on Verifone." });
  const add = make('add', `Add ${money(due)} to cart`, { hint: CLOSES });
  if (plan.stage === 'pay' && share === 'waiting' && !inCart) {
    return make('refresh', 'Refresh', { hint: 'Tap Refresh in a few seconds to see the last payment.', more: [{ action: 'forget', label: "It wasn't paid" }] });
  }
  switch (plan.stage) {
    case 'owed':
      if (inCart) return close;
      // A GM paying for a player's seat can use their store credit (GM credit): Shopify POS applies it in the cart.
      return row.kind === 'gm-cover' ? { ...add, hint: storeCreditHint(row) } : add;
    case 'paid':
      return make('back', 'Back', { hint: 'Nothing to pay on this.' });
    case 'check-in': {
      if (plan.force) return make('check-in', 'Check in anyway', { force: true });
      const passes = row.type !== 'join' && Boolean(choice) && choice !== NO_PASS;
      const later = { action: /** @type {const} */ ('check-in-only'), label: 'Just check in (pay later)' };
      if (due > 0 && splitFirst(row)) return make('check-in-split', 'Check in, then split the bill', { more: [later] });
      if (due > 0 && passes) return make('check-in-add', 'Check in with the pass', { hint: "Anything the pass doesn't cover goes in the cart.", more: [later] });
      if (due > 0) {
        /** @type {PersonAction['more']} */
        const more = [later];
        if (canSplit(row)) more.push({ action: 'check-in-split', label: 'Check in, then split the bill' });
        return make('check-in-add', `Check in and add ${money(due)} to cart`, { hint: CLOSES, more });
      }
      return make('check-in', 'Check in');
    }
    case 'pay':
      if (inCart || share === 'in-cart') return close;
      // A pass picked for what's left: it comes off first, the rest goes in the cart.
      if (row.type !== 'join' && passChange(inUse, choice).action === 'use') {
        return make('use-pass', 'Use the pass', { hint: "Anything the pass doesn't cover goes in the cart." });
      }
      if (splitFirst(row)) return make('split', 'Split the bill', { more: [{ action: 'add', label: `Add ${money(due)} to cart` }] });
      return { ...add, more: canSplit(row) ? [{ action: 'split', label: 'Split the bill' }] : [] };
    default:
      // They're in with nothing to pay: the scanner is ready for the next code.
      return justChecked ? make('done', 'Done', { hint: 'Or scan the next code.', more: [{ action: 'back', label: 'Back' }] }) : make('back', 'Back');
  }
}

/**
 * Under "Add $10 to cart" for a GM's charge (Mo, 27 Oct 2026: "The GM using their store credit to pay for a person"):
 * Shopify POS takes store credit in the cart (Apply store credit, POS 10.2 and later), so what their credit covers
 * never goes on the Verifone.
 * @param {Row} row the charge, on the GM's account
 */
export function storeCreditHint(row) {
  const first = firstName(row?.name);
  return `The screen closes. Paying with ${first ? `${first}'s` : 'their'} store credit? In the cart, tap Apply store credit.`;
}

/** A banner's title when the Lair app said something staff should see before taking payment (a pass that didn't cover everyone, say). */
export const CHECK_FIRST = 'Check before they pay';

/**
 * After fee lines went in the cart: close the check-in screen when they all went in cleanly and the Lair app had
 * nothing to say (Mo, 27 Oct 2026: "the check-in screen should close by itself"), else stay and say what to do. Its
 * notices ("Pass SJ-KIWI-4 had 2 sessions left, so it covered 2 of 3 people.") are never closed away unread.
 *   next  'close' when the banner's button should be "Close and pay" (there's something in the cart to pay for)
 * @param {FeesResult & { customer?: string }} added addFeesToCart's answer
 * @param {{ who?: string, ref?: string, notices?: string[] }} [context] their first name, the code paying marks paid,
 *   and what the Lair app said at check-in
 * @returns {{ close: boolean, toast: string, banner: Banner | null, next: 'close' | null }}
 */
export function afterCart(added, { who = '', ref = '', notices = [] } = {}) {
  const cents = linesTotal(added.added);
  const toast = added.added.length ? addedToast(cents, who) : '';
  const heads = (notices || []).map((n) => String(n || '').trim()).filter(Boolean);
  const next = added.added.length || added.skipped.length ? /** @type {const} */ ('close') : null;
  /** @param {Banner} banner */
  const stay = (banner) => ({ close: false, toast, banner, next });
  if (added.failed.length) {
    return stay({ title: added.added.length ? "Some of it isn't in the cart" : "It isn't in the cart", message: [failedFeesText(added.failed), ...heads].join(' '), tone: 'critical' });
  }
  if (!added.added.length) {
    return {
      close: false,
      toast: '',
      banner: { title: 'Already in the cart', message: [...heads, 'Take payment with Pay on Verifone, or take that line off the sale first.'].join(' '), tone: 'info' },
      next,
    };
  }
  if (added.unlinked.length) {
    const message = `Paying won't mark ${ref || 'the booking'} paid by itself. After they pay, mark it paid on the staff page.`;
    return stay({ title: "It's in the cart, but not linked", message: [message, ...heads].join(' '), tone: 'warning' });
  }
  if (heads.length) return stay({ title: CHECK_FIRST, message: heads.join(' '), tone: 'warning' });
  if (added.customer === 'failed') {
    return stay({ title: `Couldn't put ${who || 'them'} on the sale`, message: "Add them with the cart's Add customer button, so their spend counts.", tone: 'info' });
  }
  return { close: true, toast, banner: null, next: null };
}

/**
 * The group view's ticks, for people paying together (Mo, 27 Oct 2026: "a whole group" in fewer taps).
 *   tickable  rowKeys of rows that can be ticked: still to come, or here with something to pay that isn't in the cart
 *             and isn't waiting on a share's payment (never a no-show, a refund to sort out, a cancellation, or a seat
 *             that's paid, never checked in)
 *   toCome    rowKeys of the rows still to come ("Tick everyone still to come")
 *   checkIn   the ticked rows to check in; add: the ticked rows already here, whose fees go in the cart
 *   due       what the ticked rows come to, before any saved pass
 *   label     the main button: "Check in 3 people and add $45 to cart", "Check in 2 people", "Add $30 to cart", or ''
 *   customerId  whose sale it is: theirs when every ticked row is one person's, else null (nobody is put on the sale)
 *   passNote  a saved pass comes off at check-in, so it may come to less
 * @param {Row[]} rows
 * @param {string[]} ticked rowKeys
 * @param {string[]} [inCart] codes with a line in the cart already
 * @param {string[]} [held] codes whose last share is on its way to the Lair app (isHeld)
 */
export function groupPlan(rows, ticked, inCart = [], held = []) {
  const picked = new Set(ticked || []);
  /** @type {string[]} */
  const tickable = [];
  /** @type {string[]} */
  const toCome = [];
  /** @type {Row[]} */
  const checkIn = [];
  /** @type {Row[]} */
  const add = [];
  let due = 0;
  let people = 0;
  let passNote = false;
  const customers = new Set();
  for (const row of rows || []) {
    if (!row || isPayOnly(row)) continue;
    const state = rowState(row);
    const cartHas = Boolean(row.ref) && inCart.includes(String(row.ref));
    const waiting = state === 'waiting';
    if (!waiting && !(state === 'arrived' && dueOf(row) > 0 && !cartHas && !isHeld(row, held))) continue;
    const key = rowKey(row);
    tickable.push(key);
    if (waiting) toCome.push(key);
    if (!picked.has(key)) continue;
    if (waiting) {
      checkIn.push(row);
      people += Math.max(1, Math.round(Number(row.people) || 1));
      if (dueOf(row) > 0 && row.type !== 'join' && row.pass?.code && passUsable(row.pass)) passNote = true;
    } else {
      add.push(row);
    }
    if (!cartHas) due += dueOf(row);
    customers.add(String(row.customerId ?? ''));
  }
  let label = '';
  if (checkIn.length) label = due ? `Check in ${plural(people, 'person', 'people')} and add ${money(due)} to cart` : `Check in ${plural(people, 'person', 'people')}`;
  else if (add.length) label = `Add ${money(due)} to cart`;
  const only = customers.size === 1 ? [...customers][0] : '';
  return { tickable, toCome, checkIn, add, due, label, customerId: only || null, passNote };
}

/**
 * What a scanned code is for, on the screen staff are looking at.
 *   want  what staff asked to scan: 'payer' ("Who's paying?"), 'pass' ("Scan a pass") or 'any'
 *   a member code while a bill is being split names who's paying; a pass on the person view becomes a pass choice
 *   (when that booking can take one); anything else opens its own screen
 * @param {{ want: 'any' | 'payer' | 'pass', screen: string, splitOpen: boolean, takesPass: boolean }} context
 * @param {unknown} type the `type` from POST /pos/scan
 * @returns {'open' | 'payer' | 'pass' | 'wrong'}
 */
export function scanPurpose({ want, screen, splitOpen, takesPass }, type) {
  if (want === 'payer') return type === 'member' || type === 'booking' || type === 'join' ? 'payer' : 'wrong';
  if (want === 'pass') return type === 'pass' ? 'pass' : 'wrong';
  if (screen === 'person' && splitOpen && type === 'member') return 'payer';
  if (screen === 'person' && takesPass && type === 'pass') return 'pass';
  return 'open';
}

/** What staff see when a scan wasn't what they asked for. @param {'payer' | 'pass'} want */
export function wrongScan(want) {
  return want === 'pass'
    ? { title: "That's not a pass code", message: 'Scan the code on their pass, or the one under Passes in My Lair.' }
    : { title: "That's not a member code", message: 'Ask them to open My Lair on the website and show the code there.' };
}

/**
 * Why a pass can't be used right now, or '' when it can.
 * @param {PassLike | null | undefined} pass
 */
export function passProblem(pass) {
  if (!pass) return 'That pass could not be found.';
  if (pass.status === 'void') return 'It was cancelled on the staff page.';
  if (pass.status === 'expired') return `It expired${pass.expiresAt ? ` on ${dateLabel(pass.expiresAt)}` : ''}.`;
  if (!passUsable(pass)) return 'It has no sessions left.';
  return '';
}

/** A scan that isn't a Lair code at all (a product barcode, say). @param {string} text */
export function notALairCode(text) {
  const shown = String(text || '').trim().slice(0, 40);
  return {
    title: "That's not a Lair code",
    message: `${shown ? `"${shown}" isn't` : "That isn't"} a booking, member or pass code. They look like SJ-OWLBEAR-17.`,
  };
}

/** A code typed into the search box, tidied ("sj owlbear 17" → "SJ-OWLBEAR-17"), or null for a name. @param {string} query */
export function codeInQuery(query) {
  const read = readCode(query);
  return read.kind === 'code' ? read.code : null;
}

/**
 * A member's rows split into today's and their owed seats (a weekly regular's sessions that ended unpaid).
 * @template {Row} R
 * @param {R[]} rows
 */
export function splitOwed(rows) {
  /** @type {R[]} */
  const today = [];
  /** @type {R[]} */
  const owed = [];
  for (const row of rows || []) (row?.owed ? owed : today).push(row);
  return { today, owed };
}

/**
 * The member view's plan for their rows today (owed seats aren't today's, so they're left out):
 *   coming   still to come: each checked in (POST /pos/checkin, their saved pass used)
 *   owing    here already with money owed, and a GM's charges for their players' seats (paid, never checked in): each
 *            asked for its lines with `pass: 'none'` like the person view, so a pass is never used by itself
 *   waiting  how many are still to come; due: what today's rows come to, before any saved pass
 * @param {Row[]} rows the freshest copies
 * @param {string[]} [inCart] codes with a line in the cart already
 * @param {string[]} [held] codes whose last share is on its way to the Lair app (isHeld): left out until it lands
 */
export function memberPlan(rows, inCart = [], held = []) {
  let waiting = 0;
  let due = 0;
  /** @type {Row[]} still to come: checked in one by one, their saved passes used (never POST /pos/checkin-member,
   *  which would use a saved pass on rows already here that staff checked in without one) */
  const coming = [];
  /** @type {Row[]} */
  const owing = [];
  for (const row of rows || []) {
    if (row?.owed) continue;
    if (row?.kind === 'gm-cover') {
      if (dueOf(row) > 0 && !(row.ref && inCart.includes(String(row.ref)))) {
        due += dueOf(row);
        owing.push(row);
      }
      continue;
    }
    const state = rowState(row);
    if (state === 'waiting') {
      waiting += 1;
      coming.push(row);
    }
    if ((state === 'waiting' || state === 'arrived') && dueOf(row) > 0 && !(row.ref && inCart.includes(String(row.ref))) && !isHeld(row, held)) {
      due += dueOf(row);
      if (state === 'arrived') owing.push(row);
    }
  }
  return { canCheckIn: waiting > 0 || due > 0, waiting, due, coming, owing };
}

/**
 * The member view's main button, "Add everything to cart ($X)" (API contract v5, section 2): today's rows checked in
 * and their fees, their owed seats, and their tab, in one go.
 *   today     memberPlan for today's rows
 *   owed      owed seats with something to pay and no line in the cart yet; owedDue what they come to
 *   tab       whether the tab goes in; tabTotal what it comes to at its own prices (the till charges the shop's)
 *   total     what the button says: today's dues (before any saved pass comes off), the owed seats and the tab
 *   show      there's someone to check in or something to pay
 *   label     "Check in and add everything · $52" (or "Add everything to cart · $52" with no one to check in); for one
 *             part only, "Check in and add $15 to cart" or "Add $15 to cart"; "Check in everyone" when there's
 *             nothing to pay; "Add the tab to cart" for a tab with no prices on it
 *   separate  more than one of those parts
 *   parts     "Today $30 · Owed $15 · Tab $7" when it's more than one part, else ''
 *   note      a word when a saved pass will come off at check-in, so the cart may come to less
 * @param {Row[]} rows the freshest copies, today's and owed
 * @param {Tab | null | undefined} tab
 * @param {{ bookings?: string[], tabs?: string[], held?: string[] }} [cart] codes and tabs with lines in the cart already,
 *   and codes whose last share is on its way to the Lair app (isHeld)
 */
export function everythingPlan(rows, tab, { bookings = [], tabs = [], held = [] } = {}) {
  const split = splitOwed(rows);
  const today = memberPlan(split.today, bookings, held);
  const owed = split.owed.filter((row) => isOwed(row) && !(row.ref && bookings.includes(String(row.ref))));
  const owedDue = owed.reduce((sum, row) => sum + dueOf(row), 0);
  const tabState = tabPlan(tab, tabs);
  const tabTotal = tabState.canAdd ? tabCents(tab) : 0;
  const total = today.due + owedDue + tabTotal;
  // A GM's charges for their players' seats (round 21) are paid with today's, shown apart.
  const chargeDue = today.owing.filter((row) => row.kind === 'gm-cover').reduce((sum, row) => sum + dueOf(row), 0);
  const ownDue = today.due - chargeDue;
  const separate = [today.waiting > 0 || ownDue > 0, chargeDue > 0, owed.length > 0, tabState.canAdd].filter(Boolean).length > 1;
  const parts = [
    ownDue ? `Today ${money(ownDue)}` : '',
    chargeDue ? `Players' seats ${money(chargeDue)}` : '',
    owedDue ? `Owed ${money(owedDue)}` : '',
    tabState.canAdd ? (tabTotal ? `Tab ${money(tabTotal)}` : 'Tab') : '',
  ].filter(Boolean);
  const passComesOff = split.today.some(
    (row) => rowState(row) === 'waiting' && dueOf(row) > 0 && Boolean(row.pass?.code) && passUsable(row.pass) && !(row.ref && bookings.includes(String(row.ref))),
  );
  const coming = today.waiting > 0;
  let label = 'Check in everyone';
  if (total > 0 && separate) label = coming ? `Check in and add everything · ${money(total)}` : `Add everything to cart · ${money(total)}`;
  else if (total > 0) label = coming ? `Check in and add ${money(total)} to cart` : `Add ${money(total)} to cart`;
  else if (tabState.canAdd) label = coming ? 'Check in and add the tab' : 'Add the tab to cart';
  return {
    today,
    owed,
    owedDue,
    tab: tabState.canAdd,
    tabTotal,
    total,
    show: today.canCheckIn || owed.length > 0 || tabState.canAdd,
    label,
    separate,
    parts: separate && parts.length > 1 ? parts.join(' · ') : '',
    note: passComesOff ? 'A saved pass comes off when they check in, so it may come to less.' : '',
  };
}

/**
 * What staff are told about fee lines POS wouldn't take: "POS said: …. Add it by hand as a custom sale: <title>, $15.00."
 * @param {{ line: FeeLine, message: string }[]} failed
 */
export function failedFeesText(failed) {
  const said = String(failed[0]?.message || 'POS refused the change').replace(/[.!]+$/, '');
  return `POS said: ${said}. Add it by hand as a custom sale: ${failed.map(({ line }) => `${line.title}, $${line.price}`).join('; ')}.`;
}

/**
 * What staff should know after a tab's items went in the cart: items POS couldn't add or staff declined, ones to ring
 * up by hand, ones not linked to the tab, and the Lair app not hearing about it.
 * @param {Pick<TabResult, 'failed' | 'declined' | 'bad' | 'untagged' | 'markProblem'>} result
 * @returns {string[]}
 */
export function tabNotes(result) {
  const notes = [];
  if (result.failed.length) notes.push(`POS couldn't add ${result.failed.map((f) => f.item.title).join(', ')} (${result.failed[0].message}).`);
  if (result.declined.length) notes.push(`Not added: ${result.declined.map((i) => i.title).join(', ')}.`);
  if (result.bad.length) notes.push(`Ring these up by hand: ${result.bad.join(', ')}.`);
  if (result.untagged.length) notes.push(`${result.untagged.map((i) => i.title).join(', ')} isn't linked to the tab, so paying won't mark the tab paid by itself.`);
  if (result.markProblem) notes.push(`The Lair app wasn't told the tab is at the counter (${result.markProblem}), so they could still change it in My Lair.`);
  return notes;
}

/**
 * What "Add everything to cart" tells staff: a toast for what went in ("Added $30 and 3 items from the tab. Ready to
 * pay."), and a banner when something needs sorting out, worst first: something isn't in the cart; something to
 * check; it was all in the cart already; what the Lair app said at check-in; they couldn't be put on the sale. The
 * screen closes by itself only when there's no banner (close).
 * @param {{ fees: FeesResult, tab: TabResult | null, customer: string }} result addEverythingToCart's
 * @param {string} [who] their first name
 * @param {string[]} [notices] what the Lair app said at check-in (a pass that didn't cover everyone, someone not
 *   checked in)
 * @returns {{ toast: string, problem: Banner | null, close: boolean, next: 'close' | null }}
 *   next: 'close' when the banner's button should be "Close and pay"
 */
export function everythingOutcome(result, who = '', notices = []) {
  const { fees, tab } = result;
  const items = itemCount(tab?.added || []);
  const added = fees.added.length > 0 || items > 0;
  const inCart = added || fees.skipped.length > 0 || Boolean(tab?.already);
  const toast = added ? everythingToast(linesTotal(fees.added), items) : '';
  const heads = (notices || []).map((n) => String(n || '').trim()).filter(Boolean);
  const notes = [];
  if (fees.failed.length) notes.push(failedFeesText(fees.failed));
  if (fees.unlinked.length) {
    const what = fees.unlinked.map((line) => line.properties._booking || line.title).join(', ');
    notes.push(`Paying won't mark ${what} paid by itself. After they pay, mark ${fees.unlinked.length === 1 ? 'it' : 'them'} paid on the staff page.`);
  }
  if (tab) notes.push(...tabNotes(tab));
  const next = inCart ? /** @type {const} */ ('close') : null;
  /** @param {Banner} problem */
  const stay = (problem) => ({ toast, problem, close: false, next });
  if (fees.failed.length || tab?.failed.length) {
    return stay({ title: added ? "Some of it isn't in the cart" : "It isn't in the cart", message: [...notes, ...heads].join(' '), tone: 'critical' });
  }
  if (notes.length) return stay({ title: 'Check the cart', message: [...notes, ...heads].join(' '), tone: 'warning' });
  if (!added) return stay({ title: 'Already in the cart', message: [...heads, "It's all in this sale already. Take payment with Pay on Verifone."].join(' '), tone: 'info' });
  if (heads.length) return stay({ title: CHECK_FIRST, message: heads.join(' '), tone: 'warning' });
  if (result.customer === 'failed') {
    return stay({ title: `Couldn't put ${who || 'them'} on the sale`, message: "Add them with the cart's Add customer button, so their spend counts.", tone: 'info' });
  }
  return { toast, problem: null, close: true, next: null };
}

/**
 * Rows swapped for the Today list's copies where it has them (it's updated after every check-in).
 * @param {Row[]} rows
 * @param {Today | null} today
 * @returns {{ row: Row, group: import('./today.js').Group | null }[]}
 */
export function withGroups(rows, today) {
  return (rows || []).map((row) => findRow(today, row.id, row.type) || { row, group: null });
}

/**
 * The member view's tab: whether "Add tab to cart" makes sense, and a word about where it's at.
 * @param {Tab | null | undefined} tab
 * @param {string[]} tabsInCart tab ids with lines in this cart
 */
export function tabPlan(tab, tabsInCart) {
  if (!tab) return { show: false, canAdd: false, note: '' };
  const { items } = tabItems(tab);
  if (tab.status === 'paid') return { show: true, canAdd: false, note: 'Paid' };
  if ((tabsInCart || []).includes(String(tab.id))) return { show: true, canAdd: false, note: 'In the cart. Take payment on the Verifone.' };
  if (!items.length) return { show: true, canAdd: false, note: 'Nothing on it yet' };
  return {
    show: true,
    canAdd: true,
    note: tab.status === 'in-cart' ? "Put in a sale before, but not paid. Add it again if that sale didn't go through." : '',
  };
}

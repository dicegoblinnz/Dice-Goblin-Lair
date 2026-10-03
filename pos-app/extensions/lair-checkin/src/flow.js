// Which screen comes next, and what each screen offers: after a scan, at check-in, with passes and tabs, and after the
// cart. No `shopify` global here, so `npm test` can check it without a POS.
import { readCode } from './codes.js';
import { dateLabel, dayKey, money, plural, shortDay, timeRange } from './format.js';
import { feeLines, linesTotal, NOTHING_TO_PAY, passUsedLabel, tabItems } from './lines.js';
import { dueOf, findRow, isArrived, passSummary, passUsable, rowState } from './today.js';

/**
 * @typedef {import('./today.js').Row} Row
 * @typedef {import('./today.js').PassLike} PassLike
 * @typedef {import('./today.js').Today} Today
 * @typedef {import('./lines.js').Tab} Tab
 * @typedef {import('./lines.js').UsedPass} UsedPass
 * @typedef {import('./split.js').Payer} Payer
 * @typedef {{ customerId?: unknown, name?: string, code?: string | null }} Member
 * @typedef {{ row?: Row | null, lines?: unknown, customer?: { id?: unknown } | null, pass?: UsedPass | null,
 *   notice?: string | null, message?: string, checkedIn?: boolean }} CheckinAnswer what POST /pos/checkin answers
 * @typedef {{ open: boolean, mode: 'person' | 'custom', custom: string, payer: Payer | null }} SplitState
 * @typedef {{ useId: string, code: string, label: string, covered: number, used: number, left: number | null }} KnownUse
 *   a pass use this screen saw in a check-in answer, so "Undo pass" can give it back
 * @typedef {{ heading: string, body: string }} Note a banner the person view shows, like "Pass undone. $45 to pay."
 * @typedef {{ name: 'person', row: Row, groupKey: string | null, groupTitle: string, passes: PassLike[],
 *   choice: string | null, result: CheckinAnswer | null, split: SplitState, uses: KnownUse[], note: Note | null }} PersonScreen
 * @typedef {{ name: 'member', member: Member, rows: Row[], tab: Tab | null, passes: PassLike[], notices: string[] }} MemberScreen
 * @typedef {{ name: 'pass', pass: PassLike & Record<string, any>, picking: boolean }} PassScreen
 * @typedef {{ name: 'home' } | { name: 'group', key: string } | PersonScreen | MemberScreen | PassScreen} Screen
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
 * @param {{ groupKey?: string | null, groupTitle?: string, passes?: PassLike[], result?: CheckinAnswer | null }} [options]
 *   passes: a member's passes, when they came from scanning their member code
 * @returns {PersonScreen}
 */
export function personScreen(row, { groupKey = null, groupTitle = '', passes = [], result = null } = {}) {
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
      { groupKey: answer.group?.key != null ? String(answer.group.key) : null, groupTitle: String(answer.group?.title || '') },
    );
  }
  if (type === 'member' && answer.member) {
    return {
      name: 'member',
      member: answer.member,
      rows: Array.isArray(answer.rows) ? answer.rows : [],
      tab: answer.tab && typeof answer.tab === 'object' ? answer.tab : null,
      passes: Array.isArray(answer.passes) ? answer.passes : [],
      notices: [],
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
  if (groupKey && groupExists(groupKey)) return [HOME, { name: 'group', key: groupKey }];
  return stack.length > 1 ? stack.slice(0, -1) : [HOME];
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
 * What a check-in answer means for the screen.
 * @param {CheckinAnswer | null | undefined} answer
 */
export function checkinOutcome(answer) {
  const row = answer?.row || null;
  const arrived = answer?.checkedIn === true || (answer?.checkedIn !== false && Boolean(row && isArrived(row)));
  if (!arrived) {
    return { arrived: false, refused: String(answer?.notice || answer?.message || "They weren't checked in."), lines: [], total: 0, text: '', passText: '', notice: '' };
  }
  const lines = feeLines(answer);
  const total = linesTotal(lines);
  return {
    arrived: true,
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
 *   check-in  not here yet: "Check in", or "Check in anyway" with a warning (cancelled, no-show, another day, or
 *             the Lair app said no)
 *   pay       here, with money left to pay
 *   done      here, nothing to pay
 * @param {Row} row the freshest copy (currentRow)
 * @param {CheckinAnswer | null} result this screen's last check-in answer
 * @param {string} todayKey the Lair day, "2026-10-03"
 */
export function personPlan(row, result, todayKey) {
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
 * The member view's main button, for their rows today:
 *   someone still to come  "Check in everyone and add to cart" (POST /pos/checkin-member)
 *   all here, money owed   "Add $X to cart" for what isn't in the cart yet (`owing`: each row's lines, asked for with
 *                          `pass: 'none'` like the person view, so it never uses a pass by itself)
 * @param {Row[]} rows the freshest copies
 * @param {string[]} [inCart] codes with a line in the cart already
 */
export function memberPlan(rows, inCart = []) {
  let waiting = 0;
  let due = 0;
  /** @type {Row[]} */
  const owing = [];
  for (const row of rows || []) {
    const state = rowState(row);
    if (state === 'waiting') waiting += 1;
    if ((state === 'waiting' || state === 'arrived') && dueOf(row) > 0 && !(row.ref && inCart.includes(String(row.ref)))) {
      due += dueOf(row);
      if (state === 'arrived') owing.push(row);
    }
  }
  return { canCheckIn: waiting > 0 || due > 0, waiting, due, owing };
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

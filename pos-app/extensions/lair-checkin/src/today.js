// The "Today" roster from GET /pos/today: groups in time order, who's here, what's still due, badges and search.
// No `shopify` global here, so `npm test` can check it without a POS.
import { firstName, fold, money, peopleLabel, plural, shortDay, tablesLabel, timeRange } from './format.js';

/**
 * @typedef {{ code?: string, label?: string, left?: number, sessionsLeft?: number, sessionsTotal?: number,
 *   status?: string, cover?: number, expiresAt?: number | null, note?: string,
 *   holder?: { customerId?: unknown, name?: string, email?: string } | null }} PassLike
 * @typedef {{ amount?: number, customerId?: unknown, name?: string, at?: number }} Payment
 * @typedef {{ id: string | number, type?: string, kind?: string, ref?: string, name?: string, people?: number,
 *   tables?: string[], start?: number, end?: number, status?: string, arrivedAt?: number | null, paid?: boolean,
 *   amount?: number, covered?: number, due?: number, paidAmount?: number, payments?: Payment[], split?: boolean,
 *   customerId?: unknown, pass?: PassLike | null, refund?: string | null, note?: string, title?: string,
 *   players?: unknown[], party?: unknown[], gameId?: string | null, occurrenceId?: string | null,
 *   seriesId?: string | null, owed?: boolean, waived?: boolean, line?: unknown, onAccount?: boolean }} Row
 *   seriesId: a weekly regular's seat. owed: a regular's seat whose session ended unpaid (paid like any fee, never
 *   checked in); the Lair app sends its cart line as `line` with a member's rows. waived: staff let them off.
 * @typedef {{ key: string, kind?: string, title?: string, start?: number, end?: number, tables?: string[], rows: Row[] }} Group
 * @typedef {{ day?: string, now?: number, groups: Group[] }} Today
 * @typedef {'waiting' | 'arrived' | 'noshow' | 'refund' | 'cancelled'} RowState
 * @typedef {{ tone: 'success' | 'warning' | 'critical' | 'info' | 'neutral', text: string }} Badge
 */

const ARRIVED = new Set(['seated', 'done', 'attended', 'arrived', 'checked-in', 'checkedin']);
const NO_SHOW = new Set(['noshow', 'no-show']);
const KIND_ORDER = /** @type {Record<string, number>} */ ({ game: 0, event: 1, tables: 2 });

/** @param {unknown} value */
const lower = (value) => String(value ?? '').toLowerCase();

/** "booking:bk_123": one row, whichever group it's in. @param {Pick<Row, 'id' | 'type'>} row */
export function rowKey(row) {
  return `${row?.type === 'join' ? 'join' : 'booking'}:${row?.id}`;
}

/** What's left to pay for a row, in cents. @param {Row | null | undefined} row */
export function dueOf(row) {
  return Math.max(0, Math.round(Number(row?.due) || 0));
}

/** @param {Row | null | undefined} row */
export function isArrived(row) {
  return Boolean(row?.arrivedAt) || ARRIVED.has(lower(row?.status));
}

/** Paid online, then cancelled or missed: staff decide about a refund. @param {Row | null | undefined} row */
export function refundPending(row) {
  return row?.refund === 'ask' || row?.refund === 'due';
}

/** @param {Row | null | undefined} row @returns {RowState} */
export function rowState(row) {
  if (refundPending(row)) return 'refund';
  if (lower(row?.status) === 'cancelled') return 'cancelled';
  if (isArrived(row)) return 'arrived';
  if (NO_SHOW.has(lower(row?.status))) return 'noshow';
  return 'waiting';
}

/** How many people a row is for (at least 1). @param {Row} row */
function headcount(row) {
  return Math.max(1, Math.round(Number(row?.people) || 1));
}

/** A weekly regular's seat whose session ended unpaid, still to pay. @param {Row | null | undefined} row */
export function isOwed(row) {
  return Boolean(row?.owed) && dueOf(row) > 0;
}

/**
 * The badges for a row in a list: Here, Paid, Due $X (Owed $X for a regular's unpaid session), No-show or Refund?,
 * plus "In cart" when its line is already in this POS cart, "Pass" when a saved pass will be used at check-in, and
 * "Weekly" for a weekly regular's seat.
 * @param {Row} row
 * @param {boolean} [inCart] a line for it is in this POS cart already
 * @returns {Badge[]}
 */
export function rowBadges(row, inCart = false) {
  const badges = stateBadges(row, inCart);
  if (row?.seriesId) badges.push({ tone: 'info', text: 'Weekly' });
  return badges;
}

/** @param {Row} row @param {boolean} inCart @returns {Badge[]} */
function stateBadges(row, inCart) {
  const due = dueOf(row);
  const owed = isOwed(row);
  /** @type {Badge | null} */
  const moneyBadge = due > 0 ? (inCart ? { tone: 'info', text: 'In cart' } : { tone: 'warning', text: `${owed ? 'Owed' : 'Due'} ${money(due)}` }) : null;
  switch (rowState(row)) {
    case 'refund':
      return [{ tone: 'critical', text: 'Refund?' }];
    case 'cancelled':
      return [{ tone: 'critical', text: 'Cancelled' }];
    case 'noshow':
      // A regular's seat is owed even when they didn't come.
      return owed && moneyBadge ? [{ tone: 'neutral', text: 'No-show' }, moneyBadge] : [{ tone: 'neutral', text: 'No-show' }];
    case 'arrived':
      return moneyBadge ? [{ tone: 'success', text: 'Here' }, moneyBadge] : [{ tone: 'success', text: 'Here' }];
    default: {
      /** @type {Badge[]} */
      const badges = [moneyBadge || (row?.paid ? { tone: 'success', text: 'Paid' } : { tone: 'neutral', text: 'Free' })];
      // An owed seat is paid, never checked in, so its saved pass isn't used.
      if (due > 0 && !owed && (row?.pass?.code || row?.pass?.label)) badges.push({ tone: 'info', text: 'Pass' });
      return badges;
    }
  }
}

/** When an owed seat's session was: "Thu 1 Oct, 6pm–9pm" (the date even when it was today). @param {Row} row */
export function owedWhen(row) {
  return [shortDay(row?.start), timeRange(row?.start, row?.end)].filter(Boolean).join(', ');
}

/** @param {Row} a @param {Row} b */
function byTimeThenName(a, b) {
  return (Number(a?.start) || 0) - (Number(b?.start) || 0) || fold(a?.name).localeCompare(fold(b?.name));
}

const STATE_ORDER = /** @type {Record<RowState, number>} */ ({ waiting: 0, refund: 1, arrived: 2, noshow: 3, cancelled: 4 });

/**
 * Rows for a list: people still to come first (by time, then name), then refunds to sort out, then those who are
 * here, then no-shows.
 * @param {Row[]} rows
 */
export function sortRows(rows) {
  return [...(rows || [])].sort((a, b) => STATE_ORDER[rowState(a)] - STATE_ORDER[rowState(b)] || byTimeThenName(a, b));
}

/**
 * Groups in time order; at the same time, GM games before events before table bookings.
 * @param {Group[]} groups
 */
export function sortGroups(groups) {
  return [...(groups || [])]
    .filter((g) => g && Array.isArray(g.rows))
    .sort(
      (a, b) =>
        (Number(a.start) || 0) - (Number(b.start) || 0) ||
        (KIND_ORDER[a.kind || ''] ?? 3) - (KIND_ORDER[b.kind || ''] ?? 3) ||
        String(a.title || '').localeCompare(String(b.title || '')),
    );
}

/**
 * People booked, people here and money still due (no-shows, cancellations and refunds don't count as due, except a
 * regular's owed seat).
 * @param {Row[]} rows
 */
export function countRows(rows) {
  let people = 0;
  let arrived = 0;
  let due = 0;
  for (const row of rows || []) {
    const state = rowState(row);
    if (state === 'cancelled') continue;
    people += headcount(row);
    if (state === 'arrived') arrived += headcount(row);
    if (state === 'waiting' || state === 'arrived' || (state === 'noshow' && isOwed(row))) due += dueOf(row);
  }
  return { people, arrived, due };
}

/** "3/5 here · $30 due" (people, not bookings). @param {Group} group */
export function groupSummary(group) {
  const { people, arrived, due } = countRows(group?.rows);
  if (!people) return 'No one booked yet';
  return `${arrived}/${people} here${due ? ` · ${money(due)} due` : ''}`;
}

/** "6pm–10pm · T7, T8" for a game or event, "5 bookings" for table bookings. @param {Group} group */
export function groupDetails(group) {
  if (group?.kind === 'tables') return plural((group.rows || []).length, 'booking');
  return [timeRange(group?.start, group?.end), tablesLabel(group?.tables)].filter(Boolean).join(' · ');
}

/** Totals for the whole day. @param {Today | null | undefined} today */
export function dayCounts(today) {
  return countRows((today?.groups || []).flatMap((g) => g.rows || []));
}

/** The tile's subtitle: "14 today · 5 here". @param {Today | null | undefined} today */
export function tileSubheading(today) {
  const { people, arrived } = dayCounts(today);
  return people ? `${people} today · ${arrived} here` : 'Nothing booked today';
}

/**
 * What they booked, in a few words: "GM seat: Curse of Strahd", "Game spot: Warhammer night", "Event entry: Pokémon
 * TCG league", "Walk-in" or "Table booking".
 * @param {Row} row
 */
export function whatLabel(row) {
  // round 9: a monthly account's tab from an earlier day
  if (row?.type === 'tab') return 'Tab';
  const title = String(row?.title || '').trim();
  if (row?.type === 'join') return title ? `Event entry: ${title}` : 'Event entry';
  if (row?.kind === 'gm-seat') return title ? `GM seat: ${title}` : 'GM seat';
  if (row?.occurrenceId) return title ? `Game spot: ${title}` : 'Game spot';
  if (row?.kind === 'walkin') return 'Walk-in';
  return 'Table booking';
}

/** "3 people · T4 · 7pm–10pm", plus "Splitting the bill" when they are. @param {Row} row */
export function rowDetails(row) {
  return [peopleLabel(row?.people), tablesLabel(row?.tables), timeRange(row?.start, row?.end), row?.split ? 'Splitting the bill' : '']
    .filter(Boolean)
    .join(' · ');
}

/**
 * Seat players' names, with their characters: ["Alex (Grog)", "Jo"].
 * @param {Row} row
 * @returns {string[]}
 */
export function playerNames(row) {
  const list = Array.isArray(row?.players) ? row.players : Array.isArray(row?.party) ? row.party : [];
  return list
    .map((p) => {
      if (typeof p === 'string') return p.trim();
      const player = /** @type {{ name?: unknown, character?: unknown }} */ (p || {});
      const name = String(player.name ?? '').trim();
      const character = String(player.character ?? '').trim();
      return name && character ? `${name} (${character})` : name;
    })
    .filter(Boolean);
}

/** Letters and digits only, upper case: how codes are compared. @param {unknown} text */
function alnum(text) {
  return String(text ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Finds people by name (accents and case don't matter), seat player, or part of their code.
 * @param {Today | null | undefined} today
 * @param {string} query
 * @returns {{ row: Row, group: Group }[]}
 */
export function searchToday(today, query) {
  const q = fold(query);
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const key = alnum(query);
  /** @type {{ row: Row, group: Group }[]} */
  const found = [];
  for (const group of sortGroups(today?.groups || [])) {
    for (const row of group.rows) {
      const names = fold([row.name, ...playerNames(row)].join(' '));
      const byName = words.every((word) => names.includes(word));
      const byCode = key.length >= 3 && alnum(row.ref).includes(key);
      if (byName || byCode) found.push({ row, group });
    }
  }
  return found.sort((a, b) => STATE_ORDER[rowState(a.row)] - STATE_ORDER[rowState(b.row)] || byTimeThenName(a.row, b.row)).slice(0, 40);
}

/**
 * @param {Today | null | undefined} today
 * @param {unknown} id
 * @param {unknown} type
 * @returns {{ row: Row, group: Group } | null}
 */
export function findRow(today, id, type) {
  const key = rowKey({ id: /** @type {string} */ (id), type: /** @type {string} */ (type) });
  for (const group of today?.groups || []) {
    for (const row of group.rows || []) if (rowKey(row) === key) return { row, group };
  }
  return null;
}

/**
 * The same roster with some rows swapped for fresher copies (after a check-in), keeping everything else.
 * @param {Today | null} today
 * @param {(Row | null | undefined)[]} rows
 * @returns {Today | null}
 */
export function replaceRows(today, rows) {
  const list = /** @type {Row[]} */ ((rows || []).filter((r) => r && r.id != null));
  if (!today || !list.length) return today;
  const fresh = new Map(list.map((r) => [rowKey(r), r]));
  return {
    ...today,
    groups: today.groups.map((group) => ({
      ...group,
      rows: group.rows.map((row) => {
        const update = fresh.get(rowKey(row));
        return update ? { ...row, ...update } : row;
      }),
    })),
  };
}

/**
 * A list of rows with some swapped for fresher copies, and any new ones added at the end.
 * @param {Row[]} rows
 * @param {(Row | null | undefined)[]} fresh
 * @returns {Row[]}
 */
export function mergeRows(rows, fresh) {
  const updates = /** @type {Row[]} */ ((fresh || []).filter((r) => r && r.id != null));
  const merged = (rows || []).map((row) => {
    const update = updates.find((r) => rowKey(r) === rowKey(row));
    return update ? { ...row, ...update } : row;
  });
  for (const row of updates) if (!merged.some((r) => rowKey(r) === rowKey(row))) merged.push(row);
  return merged;
}

/** Sessions left on a pass (row passes say `left`, full passes `sessionsLeft`). @param {PassLike | null | undefined} pass */
export function passLeft(pass) {
  const left = Number(pass?.left ?? pass?.sessionsLeft);
  return Number.isFinite(left) ? Math.max(0, Math.round(left)) : null;
}

/** "Warhammer league · 7 left". @param {PassLike | null | undefined} pass */
export function passSummary(pass) {
  const left = passLeft(pass);
  return [pass?.label || pass?.code || 'Pass', left === null ? '' : `${left} left`].filter(Boolean).join(' · ');
}

/** A pass that can be used now: active (or no status given) with sessions left. @param {PassLike | null | undefined} pass */
export function passUsable(pass) {
  if (!pass?.code) return false;
  if (pass.status && pass.status !== 'active') return false;
  return passLeft(pass) !== 0;
}

/**
 * Who a pass could be used on today: table bookings, seats and game spots (not event entries) with something still to
 * pay, whether they're here yet or not. Not an owed seat: passes are used at check-in, and those aren't checked in.
 * The holder's own bookings come first.
 * @param {Today | null | undefined} today
 * @param {PassLike | null | undefined} pass
 * @returns {{ row: Row, group: Group }[]}
 */
export function passCandidates(today, pass) {
  const holder = String(pass?.holder?.customerId ?? '');
  /** @type {{ row: Row, group: Group }[]} */
  const list = [];
  for (const group of sortGroups(today?.groups || [])) {
    for (const row of group.rows) {
      const state = rowState(row);
      if (row.type === 'join' || (state !== 'waiting' && state !== 'arrived') || !dueOf(row) || isOwed(row)) continue;
      list.push({ row, group });
    }
  }
  const mine = (/** @type {Row} */ row) => (holder && String(row.customerId ?? '') === holder ? 0 : 1);
  return list.sort((a, b) => mine(a.row) - mine(b.row) || STATE_ORDER[rowState(a.row)] - STATE_ORDER[rowState(b.row)] || byTimeThenName(a.row, b.row));
}

/** "Are you Sam?" @param {Row | null | undefined} row */
export function areYou(row) {
  const name = firstName(row?.name);
  return name ? `Are you ${name}?` : 'Who is this?';
}

/** Where the check-in screen leaves today's numbers for the tile, so the tile needn't ask the Lair app again. */
export const TILE_KEY = 'tile-counts';

/**
 * What the check-in screen saves for the tile: when, which Lair day, and the words.
 * @param {Today | null | undefined} today
 * @param {number} now
 */
export function tileEntry(today, now) {
  return { at: now, day: String(today?.day || ''), text: tileSubheading(today) };
}

/**
 * The tile's saved subtitle when it's for today and newer than the one the tile shows, otherwise null.
 * @param {unknown} entry what `shopify.storage.get(TILE_KEY)` gave back
 * @param {number} shownAt when the tile's own subtitle was made
 * @param {string} day the Lair day now, "2026-10-03"
 */
export function newerTileText(entry, shownAt, day) {
  const saved = /** @type {{ at?: unknown, day?: unknown, text?: unknown } | null} */ (entry && typeof entry === 'object' ? entry : null);
  if (!saved || typeof saved.text !== 'string' || !saved.text || saved.day !== day) return null;
  const at = Number(saved.at);
  return Number.isFinite(at) && at > shownAt ? saved.text : null;
}

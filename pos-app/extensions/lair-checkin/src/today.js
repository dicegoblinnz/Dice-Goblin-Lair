// The "Today" roster from GET /pos/today: groups in time order, who's here, what's still due, badges and search.
// No `shopify` global here, so `npm test` can check it without a POS.
import { firstName, fold, money, peopleLabel, plural, shortDay, tablesLabel, timeLabel, timeRange } from './format.js';

/**
 * @typedef {{ code?: string, label?: string, left?: number, sessionsLeft?: number, sessionsTotal?: number,
 *   status?: string, cover?: number, expiresAt?: number | null, note?: string,
 *   holder?: { customerId?: unknown, name?: string, email?: string } | null }} PassLike
 * @typedef {{ amount?: number, customerId?: unknown, name?: string, at?: number }} Payment
 * @typedef {{ on?: boolean, can?: boolean, amount?: number, payer?: string }} GmPays
 *   A GM game seat's "GM pays" state, when the Lair app sends it (contract v21-gm-cover; the counter's ask, 27 Oct
 *   2026): on (the GM pays for it), can (the GM could), amount (cents the GM pays or would pay), payer (that GM's
 *   first name).
 * @typedef {{ id: string | number, type?: string, kind?: string, ref?: string, name?: string, people?: number,
 *   tables?: string[], start?: number, end?: number, status?: string, arrivedAt?: number | null, paid?: boolean,
 *   amount?: number, covered?: number, due?: number, paidAmount?: number, payments?: Payment[], split?: boolean,
 *   customerId?: unknown, pass?: PassLike | null, refund?: string | null, note?: string, title?: string,
 *   players?: unknown[], party?: unknown[], gameId?: string | null, occurrenceId?: string | null,
 *   seriesId?: string | null, owed?: boolean, waived?: boolean, line?: unknown, onAccount?: boolean,
 *   gmPays?: GmPays | null, playerOf?: { name?: string } | null }} Row
 *   seriesId: a weekly regular's seat. owed: a regular's seat whose session ended unpaid (paid like any fee, never
 *   checked in); the Lair app sends its cart line as `line` with a member's rows. waived: staff let them off.
 *   playerOf: a named player in someone else's game (round 11): the row's due is their own share, and its cart line
 *   carries the game's code with `_share`.
 *   kind 'gm-cover': a GM's charge for one of their player's seats (round 21), on the GM's member code: paid, never
 *   checked in. covered: cents a session pass took off (never the GM paying: that's gmPays).
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
 * A row that's only ever paid, never checked in: a regular's owed seat, or a GM's charge for one of their players'
 * seats (kind 'gm-cover', contract v21-gm-cover: "It's paid, never checked in").
 * @param {Row | null | undefined} row
 */
export function isPayOnly(row) {
  return Boolean(row?.owed) || row?.kind === 'gm-cover';
}

/** The GM pays for this seat (the Lair app's gmPays, contract v21-gm-cover). @param {Row | null | undefined} row */
export function gmPaysFor(row) {
  return row?.kind === 'gm-seat' && row?.gmPays?.on === true;
}

/**
 * Whether to offer "Kate pays for this seat" (contract v21-gm-cover): the Lair app's gmPays.can once it sends it.
 * Until then, a GM game seat that's on, with something to pay and nothing paid or taken off it yet; if the GM can't
 * pay for it after all (no account, a free session), the Lair app says why in plain words.
 * @param {Row | null | undefined} row
 */
export function canGmPay(row) {
  if (row?.kind !== 'gm-seat') return false;
  if (row.gmPays) return row.gmPays.can === true && row.gmPays.on !== true;
  const state = rowState(row);
  return (
    (state === 'waiting' || state === 'arrived') &&
    !row.owed &&
    !row.waived &&
    dueOf(row) > 0 &&
    !(Number(row.paidAmount) > 0) &&
    !(Number(row.covered) > 0)
  );
}

/**
 * What the player's screen offers about the GM paying (contract v21-gm-cover): 'offer' ("Kate pays for this seat"),
 * 'stop' ("Stop Kate paying"), 'in-cart' (neither while the seat's own line is in the sale: paying it would end the
 * GM's offer, and a GM's charge on top would take too much), or null (nothing to offer).
 * @param {Row | null | undefined} row
 * @param {boolean} inCart the seat's line (or a share of it) is in the cart
 * @returns {'offer' | 'stop' | 'in-cart' | null}
 */
export function gmPaysChoice(row, inCart) {
  if (row?.kind !== 'gm-seat') return null;
  const on = gmPaysFor(row);
  if (!on && !canGmPay(row)) return null;
  if (inCart) return 'in-cart';
  return on ? 'stop' : 'offer';
}

/**
 * A seat with the GM's charge this screen just set up (POST /pos/cover's `cover`), for a Lair app that doesn't send
 * gmPays on its rows yet: the seat says the GM pays, and who, and how much.
 * @param {Row} row
 * @param {{ amount?: number } | null | undefined} cover
 * @param {string} payer the GM's first name
 * @returns {Row}
 */
export function withCover(row, cover, payer) {
  if (!cover || row?.kind !== 'gm-seat' || row.gmPays?.on) return row;
  const amount = Math.max(0, Math.round(Number(cover.amount) || 0));
  return { ...row, gmPays: { ...(row.gmPays || {}), on: true, can: false, payer: row.gmPays?.payer || payer, ...(amount ? { amount } : {}) } };
}

/**
 * Whether a row is held back from the cart because the last share of its bill left the cart a moment ago and hasn't
 * reached the Lair app yet (split.js waitingRefs): until it lands, adding what's left would charge that share again. A
 * named player's own share of a game (playerOf) is theirs alone, so it's never held.
 * @param {Row | null | undefined} row
 * @param {string[]} [held] codes with a share payment on its way
 */
export function isHeld(row, held = []) {
  return Boolean(row?.ref) && !row?.playerOf && (held || []).includes(String(row?.ref));
}

/**
 * The badges for a row in a list: Here, Paid, Due $X (Owed $X for a regular's unpaid session), No-show or Refund?,
 * plus "In cart" when its line is already in this POS cart, "Payment on its way" when the last share of it was just
 * paid (isHeld), "Pass" when a saved pass will be used at check-in, "GM pays" when the GM pays for the seat (instead of
 * "Free"), and "Weekly" for a weekly regular's seat.
 * @param {Row} row
 * @param {boolean} [inCart] a line for it is in this POS cart already
 * @param {boolean} [held] the last share of it was just paid and hasn't reached the Lair app yet
 * @returns {Badge[]}
 */
export function rowBadges(row, inCart = false, held = false) {
  let badges = stateBadges(row, inCart, held);
  if (gmPaysFor(row)) badges = [...badges.filter((b) => b.text !== 'Free'), { tone: 'info', text: 'GM pays' }];
  if (row?.seriesId) badges.push({ tone: 'info', text: 'Weekly' });
  return badges;
}

/** @param {Row} row @param {boolean} inCart @param {boolean} held @returns {Badge[]} */
function stateBadges(row, inCart, held) {
  const due = dueOf(row);
  const owed = isOwed(row);
  /** @type {Badge | null} */
  const moneyBadge =
    due > 0
      ? inCart
        ? { tone: 'info', text: 'In cart' }
        : held
          ? { tone: 'info', text: 'Payment on its way' }
          : { tone: 'warning', text: `${owed ? 'Owed' : 'Due'} ${money(due)}` }
      : null;
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

/** "3 of 5 here · $30 to pay" (people, not bookings). @param {Group} group */
export function groupSummary(group) {
  const { people, arrived, due } = countRows(group?.rows);
  if (!people) return 'No one booked yet';
  return `${arrived} of ${people} here${due ? ` · ${money(due)} to pay` : ''}`;
}

/** Before this, a group is "later today" on the home screen; within it, "now and next". */
export const NEXT_MS = 2 * 60 * 60 * 1000;

/**
 * Today's groups for the home screen, each list in time order: now and next (started, or starting within two hours),
 * later today, and finished (ended).
 * @param {Group[]} groups
 * @param {number} now
 */
export function dayBuckets(groups, now) {
  /** @type {{ now: Group[], later: Group[], finished: Group[] }} */
  const buckets = { now: [], later: [], finished: [] };
  for (const group of sortGroups(groups)) {
    const end = Number(group.end) || 0;
    const start = Number(group.start) || 0;
    if (end && end <= now) buckets.finished.push(group);
    else if (start > now + NEXT_MS) buckets.later.push(group);
    else buckets.now.push(group);
  }
  return buckets;
}

/**
 * A group's badges on the home screen: "3 of 5 here" and "$30 to pay", or before it starts with no one here,
 * "Starts at 7pm" and "4 booked".
 * @param {Group} group
 * @param {number} now
 * @returns {Badge[]}
 */
export function groupBadges(group, now) {
  const { people, arrived, due } = countRows(group?.rows);
  if (!people) return [{ tone: 'neutral', text: 'No one booked yet' }];
  const start = Number(group?.start) || 0;
  /** @type {Badge[]} */
  const badges =
    !arrived && start > now
      ? [
          { tone: 'info', text: `Starts at ${timeLabel(start)}` },
          { tone: 'neutral', text: `${people} booked` },
        ]
      : [{ tone: arrived === people ? 'success' : 'neutral', text: `${arrived} of ${people} here` }];
  if (due) badges.push({ tone: 'warning', text: `${money(due)} to pay` });
  return badges;
}

/** A finished group in one line: "Learn to play · 3 people · all paid", or "· $15 to pay". @param {Group} group */
export function finishedLine(group) {
  const { people, due } = countRows(group?.rows);
  const title = gameTitle(group).name || 'Bookings';
  if (!people) return `${title} · no one booked`;
  return `${title} · ${peopleLabel(people)} · ${due ? `${money(due)} to pay` : 'all paid'}`;
}

/**
 * A game's title split from its GM: "Curse of Strahd · GM Kate" (the Lair app's Today title) → { name: "Curse of
 * Strahd", gm: "Kate" }. Anything else is all name.
 * @param {Pick<Group, 'title' | 'kind'> | null | undefined} group
 */
export function gameTitle(group) {
  const title = String(group?.title || '').trim();
  const at = title.lastIndexOf(' · GM ');
  if (group?.kind !== 'game' || at < 0) return { name: title, gm: '' };
  return { name: title.slice(0, at).trim(), gm: title.slice(at + 6).trim() };
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

/**
 * What they booked, in a few words: "GM seat: Curse of Strahd", "Game spot: Warhammer night", "Event entry: Pokémon
 * TCG league", "Walk-in" or "Table booking". A GM's charge says what it is: "Paying for Mia's seat: Curse of Strahd".
 * @param {Row} row
 */
export function whatLabel(row) {
  // round 9: a monthly account's tab from an earlier day
  if (row?.type === 'tab') return 'Tab';
  const title = String(row?.title || '').trim();
  if (row?.kind === 'gm-cover') return title || "Paying for a player's seat";
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
 * Not one with a line in this cart (whole or a share): the pass would cover what the sale already charges. Not one
 * whose last share is on its way to the Lair app (isHeld). The holder's own bookings come first.
 * @param {Today | null | undefined} today
 * @param {PassLike | null | undefined} pass
 * @param {string[]} [inCart] codes with a line in the cart
 * @param {string[]} [held] codes with a share payment on its way
 * @returns {{ row: Row, group: Group }[]}
 */
export function passCandidates(today, pass, inCart = [], held = []) {
  const holder = String(pass?.holder?.customerId ?? '');
  /** @type {{ row: Row, group: Group }[]} */
  const list = [];
  for (const group of sortGroups(today?.groups || [])) {
    for (const row of group.rows) {
      const state = rowState(row);
      if (row.type === 'join' || (state !== 'waiting' && state !== 'arrived') || !dueOf(row) || isOwed(row)) continue;
      if ((row.ref && inCart.includes(String(row.ref))) || isHeld(row, held)) continue;
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
export const TILE_KEY = 'tile-numbers';

/**
 * @typedef {{ at: number, day: string, people: number, arrived: number, owing: string[] }} TileEntry
 *   today's numbers for the tile: when they were made, which Lair day, people booked and here, and the codes of
 *   bookings that are here with something still to pay
 */

/**
 * Today's numbers for the tile, from the Today list (the check-in screen saves them; the tile makes them too).
 * @param {Today | null | undefined} today
 * @param {number} now
 * @returns {TileEntry}
 */
export function tileEntry(today, now) {
  const { people, arrived } = dayCounts(today);
  /** @type {string[]} */
  const owing = [];
  for (const group of today?.groups || []) {
    for (const row of group.rows || []) if (row?.ref && rowState(row) === 'arrived' && dueOf(row) > 0) owing.push(String(row.ref));
  }
  return { at: now, day: String(today?.day || ''), people, arrived, owing };
}

/**
 * The tile's words and its badge: "9 of 27 here · 2 to pay", and 2: bookings that are here with something still to
 * pay that isn't in the cart (Shopify: a tile's count is for things to act on).
 * @param {TileEntry | null | undefined} entry
 * @param {string[]} [inCart] codes with a line in the cart
 * @returns {{ subheading: string, count: number }}
 */
export function tileWords(entry, inCart = []) {
  const people = Math.max(0, Math.round(Number(entry?.people) || 0));
  if (!people) return { subheading: 'Nothing booked today', count: 0 };
  const arrived = Math.max(0, Math.round(Number(entry?.arrived) || 0));
  const count = (entry?.owing || []).filter((ref) => !inCart.includes(ref)).length;
  return { subheading: `${arrived} of ${people} here${count ? ` · ${count} to pay` : ''}`, count };
}

/**
 * The tile's saved numbers when they're for today and newer than the ones the tile shows, otherwise null.
 * @param {unknown} entry what `shopify.storage.get(TILE_KEY)` gave back
 * @param {number} shownAt when the tile's own numbers were made
 * @param {string} day the Lair day now, "2026-10-03"
 * @returns {TileEntry | null}
 */
export function newerTileEntry(entry, shownAt, day) {
  const saved = /** @type {Partial<TileEntry> | null} */ (entry && typeof entry === 'object' ? entry : null);
  if (!saved || saved.day !== day || !Array.isArray(saved.owing)) return null;
  const at = Number(saved.at);
  const people = Number(saved.people);
  const arrived = Number(saved.arrived);
  if (!Number.isFinite(at) || at <= shownAt || !Number.isFinite(people) || !Number.isFinite(arrived)) return null;
  return { at, day, people, arrived, owing: saved.owing.filter((ref) => typeof ref === 'string') };
}

/** After a sale with Lair lines leaves the cart, the tile asks for fresh numbers this much later (the payment lands). */
export const AFTER_SALE_MS = 8000;

/** And numbers older than this are asked for again when the cart next changes. */
export const STALE_MS = 15 * 60 * 1000;

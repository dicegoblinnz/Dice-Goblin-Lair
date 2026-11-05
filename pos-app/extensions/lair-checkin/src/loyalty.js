// The loyalty card at the counter (API contract v6 section 1, v7 section 4, v22-stamps): the stamps on a member's card,
// their rolls waiting in My Lair, the stamps a check-in or a payment just added, and the moment a check-in fills a card
// (Mo, 27 Oct 2026: "show the member's loyalty card progress, a friendly line when someone's card fills"). Round 22
// (Mo, 28 Oct 2026: "the stamp is not clear" and "give the staff [a way] to add a stamp on the area for the stamps"):
// the card is drawn like a punch card, two rows of five, with what's left in words, and staff can add a stamp on it.
// Round 29 (Lair contract v29-roleplayers, Mo, 2 Nov 2026: "12 slots, 2 from Gobgob"): from a Lair app that sends the
// head start, the card has 12 slots, the first 2 Gobgob's, so it's drawn in three rows of four and says "9 of 12"; a
// roll still takes 10 stamps, so what's left and when a card fills are counted as before. An older Lair app's card is
// drawn as it was.
// No `shopify` global here, so `npm test` can check it without a POS.
import { plural } from './format.js';

/**
 * @typedef {{ stamps: number, size: number, rolls: number, card: number, waiting?: number, slots?: number, headStart?: number, onCard?: number }} Card
 *   stamps on this card (a full card's roll joins `rolls` and the next card starts at 0), the card's size (10), rolls
 *   waiting in My Lair, and which card they're on (1 for the first; 0 when the Lair app didn't say). waiting (round 24,
 *   contract v24-new-players): a welcome code's rolls waiting for their first paid session, only while some do.
 *   slots, headStart and onCard (round 29): the slots the card shows (12), Gobgob's head start at the front of them (2)
 *   and the slots filled (stamps + headStart); only from a Lair app that sends them
 */

/** Stamps to a row when the card is drawn: two rows of five, like a punch card. */
export const ROW = 5;
/** Round 29: a card with Gobgob's head start (12 slots) is drawn in three rows of four, as My Lair draws it on a phone */
export const HEAD_ROW = 4;

/** Round 29: the slots a card shows (its size when there's no head start), Gobgob's at the front, and the ones filled */
const slotsOf = (/** @type {Card} */ card) => card.slots || card.size;
const headOf = (/** @type {Card} */ card) => card.headStart || 0;
const filledOf = (/** @type {Card} */ card) => card.stamps + headOf(card);

/**
 * A scan's `loyalty` (`{ stamps, cardSize, rollsAvailable, card, rollsWaiting?, slots?, headStart?, onCard? }`) as a
 * Card, or null when there isn't one (a Lair app from before round 6, or a guest's ticket: only an account has a card).
 * Round 29: slots past the card's size are Gobgob's head start, already filled; onCard is worked out from the stamps.
 * @param {unknown} loyalty
 * @returns {Card | null}
 */
export function loyaltyCard(loyalty) {
  if (!loyalty || typeof loyalty !== 'object') return null;
  const raw = /** @type {{ stamps?: unknown, cardSize?: unknown, rollsAvailable?: unknown, card?: unknown, rollsWaiting?: unknown, slots?: unknown }} */ (loyalty);
  const size = Math.round(Number(raw.cardSize) || 0);
  if (size < 1) return null;
  const waiting = Math.max(0, Math.round(Number(raw.rollsWaiting) || 0));
  const stamps = Math.min(size, Math.max(0, Math.round(Number(raw.stamps) || 0)));
  /** @type {Card} */
  const card = {
    stamps,
    size,
    rolls: Math.max(0, Math.round(Number(raw.rollsAvailable) || 0)),
    card: Math.max(0, Math.round(Number(raw.card) || 0)),
    ...(waiting ? { waiting } : {}),
  };
  // round 29: a head start of a few slots (2), never one bigger than the card itself
  const slots = Math.round(Number(raw.slots) || 0);
  const headStart = slots - size;
  if (headStart < 1 || headStart > size) return card;
  return { ...card, slots, headStart, onCard: stamps + headStart };
}

/** "Loyalty card 3", or "Loyalty card" when the Lair app didn't say which. @param {Card} card */
export function cardHeading(card) {
  return card.card ? `Loyalty card ${card.card}` : 'Loyalty card';
}

/**
 * The stamps in words: "9 of 10 stamps. One more fills it.", "4 of 10 stamps." or "A new card: no stamps yet." Round
 * 29, with the head start: "11 of 12. One more fills it.", "9 of 12." or "A new card: 2 of 12, with Gobgob’s head start."
 * @param {Card} card
 */
export function stampWords(card) {
  const left = card.size - card.stamps;
  if (headOf(card)) {
    if (!card.stamps) return `A new card: ${stampCount(card)}, with Gobgob’s head start.`;
    return left === 1 ? `${stampCount(card)}. One more fills it.` : `${stampCount(card)}.`;
  }
  if (!card.stamps) return 'A new card: no stamps yet.';
  if (left === 1) return `${card.stamps} of ${card.size} stamps. One more fills it.`;
  return `${card.stamps} of ${card.size} stamps.`;
}

/**
 * The count, big and short, for the top of the card: "7 of 10 stamps", "1 of 10 stamps", "No stamps yet". Round 29,
 * with the head start, the slots filled: "9 of 12", and a new card's "2 of 12".
 * @param {Card} card
 */
export function stampCount(card) {
  if (headOf(card)) return `${filledOf(card)} of ${slotsOf(card)}`;
  return card.stamps ? `${card.stamps} of ${card.size} stamps` : 'No stamps yet';
}

/**
 * What's left, in words, under the count: "3 more fill the card: a d20 roll for store credit.", "One more fills the
 * card: a d20 roll for store credit." or, on a new card, "10 sessions fill the card: a d20 roll for store credit."
 * Round 29, with the head start, a new card says "10 more fill the card: …" (it shows 2 of 12 already).
 * @param {Card} card
 */
export function stampsLeft(card) {
  const left = Math.max(0, card.size - card.stamps);
  const prize = 'a d20 roll for store credit.';
  if (!card.stamps && !headOf(card)) return `${plural(card.size, 'session')} fill the card: ${prize}`;
  if (left === 1) return `One more fills the card: ${prize}`;
  return `${left} more fill the card: ${prize}`;
}

/**
 * Round 29: why the first slots are gold, for staff to pass on: "The first 2 are Gobgob’s head start: a roll is still
 * 10 visits." '' for a card without a head start (an older Lair app).
 * @param {Card} card
 */
export function headStartWords(card) {
  const head = headOf(card);
  return head ? `The first ${head} are Gobgob’s head start: a roll is still ${card.size} visits.` : '';
}

/**
 * When stamps land, under the card (round 22: they come by themselves once a session is checked in or paid, so staff
 * know not to add one too). On a ticket: whether this session's stamps are on yet. On a member's card (no row): that
 * check-ins and payments stamp by themselves, and Add a stamp is for a session the Lair app doesn't know about.
 * @param {{ people?: unknown, status?: unknown, arrivedAt?: unknown, paid?: unknown } | null} [row]
 */
export function stampNote(row = null) {
  if (!row) return 'Check-ins and payments add stamps by themselves. Add one here for a session the Lair app doesn’t know about.';
  // (a no-show or a cancelled one stamps nobody, and its screen says what happened to it)
  if (['noshow', 'cancelled'].includes(String(row.status || ''))) return '';
  const many = Math.round(Number(row.people) || 1) > 1;
  const stamped = Boolean(row.arrivedAt) || ['seated', 'done', 'attended'].includes(String(row.status || '')) || row.paid === true;
  if (stamped) return many ? 'This session’s stamps are on their card.' : 'This session’s stamp is on their card.';
  return many ? 'Checking in or paying adds this session’s stamps.' : 'Checking in or paying adds this session’s stamp.';
}

/** "1 roll waiting in My Lair", or '' with none. @param {Card} card */
export function rollWords(card) {
  return card.rolls ? `${plural(card.rolls, 'roll')} waiting in My Lair` : '';
}

/**
 * Round 24 (contract v24-new-players): a welcome code's rolls, which are theirs once they've paid for a session: "Welcome
 * roll waiting: theirs once they’ve paid for a session.", "2 welcome rolls waiting: …", or '' with none.
 * @param {Card} card
 */
export function welcomeWords(card) {
  const n = card.waiting || 0;
  if (!n) return '';
  return `${n === 1 ? 'Welcome roll' : `${n} welcome rolls`} waiting: theirs once they’ve paid for a session.`;
}

/**
 * The card's slots one by one, for drawing: true for each one filled (round 29: Gobgob's head start, then the stamps),
 * false for each space left.
 * @param {Card} card
 * @returns {boolean[]}
 */
export function stampMarks(card) {
  return Array.from({ length: Math.min(slotsOf(card), 20) }, (_, i) => i < filledOf(card));
}

/**
 * The card's slots in rows, for drawing like a punch card: two rows of five on a 10-stamp card (ROW), and round 29's
 * 12 slots in three rows of four (HEAD_ROW). Each mark is 'head' (Gobgob's head start), 'new' (a stamp this screen saw
 * land: the last `fresh` of them), 'on' (an older stamp) or 'off' (a space left).
 * @param {Card} card
 * @param {number} [fresh] stamps this screen just saw land
 * @returns {('head' | 'on' | 'new' | 'off')[][]}
 */
export function stampRows(card, fresh = 0) {
  const head = headOf(card);
  const filled = filledOf(card);
  const newOnes = Math.min(card.stamps, Math.max(0, Math.round(Number(fresh) || 0)));
  /** @type {('head' | 'on' | 'new' | 'off')[]} */
  const marks = stampMarks(card).map((on, i) => (i < head ? 'head' : !on ? 'off' : i >= filled - newOnes ? 'new' : 'on'));
  const per = head ? HEAD_ROW : ROW;
  /** @type {('head' | 'on' | 'new' | 'off')[][]} */
  const rows = [];
  for (let i = 0; i < marks.length; i += per) rows.push(marks.slice(i, i + per));
  return rows;
}

/**
 * Every stamp on someone's cards so far (full cards and this one), from a card's number; null without card numbers (a
 * Lair app from round 6).
 * @param {Card} card
 */
function totalStamps(card) {
  return card.card ? (card.card - 1) * card.size + card.stamps : null;
}

/**
 * How many stamps landed between two looks at the same person's card (a check-in, a payment, a stamp staff added):
 * 0 when nothing did, it went down, or either look is missing. Across a full card too: 9 on card 3, then 1 on card 4,
 * is 2. Without card numbers, only what this card shows.
 * @param {unknown} before a scan's `loyalty`
 * @param {unknown} after the same person's `loyalty`, later
 */
export function freshStamps(before, after) {
  const was = loyaltyCard(before);
  const now = loyaltyCard(after);
  if (!was || !now) return 0;
  const a = totalStamps(was);
  const b = totalStamps(now);
  if (a !== null && b !== null) return Math.max(0, b - a);
  return Math.max(0, now.stamps - was.stamps);
}

/** "New stamp" or "3 new stamps", for the badge on the card. @param {number} fresh */
export function freshWords(fresh) {
  return fresh === 1 ? 'New stamp' : `${fresh} new stamps`;
}

/**
 * Did a card fill between two looks at it? A later card number says so; without card numbers (a Lair app from round 6),
 * more rolls and fewer stamps.
 * @param {unknown} before a scan's `loyalty`
 * @param {unknown} after the same member's `loyalty`, later
 */
export function cardFilled(before, after) {
  const was = loyaltyCard(before);
  const now = loyaltyCard(after);
  if (!was || !now) return false;
  if (was.card && now.card) return now.card > was.card;
  return now.rolls > was.rolls && now.stamps < was.stamps;
}

/** The friendly line when a card fills. @param {string} name their first name */
export function cardFullWords(name) {
  return `${name ? `${name}'s` : 'Their'} loyalty card is full! A roll for store credit is waiting in My Lair.`;
}

/** The same, short, for a toast. @param {string} name their first name */
export function cardFullShort(name) {
  return `${name ? `${name}'s` : 'Their'} loyalty card is full!`;
}

/**
 * The toast once staff add a stamp: "Stamp added: 8 of 10." or "Stamp added: Sam's card is full!". Round 29, with the
 * head start: "Stamp added: 10 of 12."
 * @param {unknown} loyalty
 * @param {string} name
 */
export function stampAddedWords(loyalty, name) {
  const card = loyaltyCard(loyalty);
  if (!card) return 'Stamp added.';
  if (!card.stamps && card.card > 1) return `Stamp added: ${cardFullShort(name)}`;
  return `Stamp added: ${filledOf(card)} of ${slotsOf(card)}.`;
}

/**
 * A key for one tap of "Add a stamp", so the Lair app adds it once however often the counter asks (a retry after a lost
 * answer sends the same key). 8 to 64 letters, numbers and dashes.
 */
export function stampKey() {
  const random = typeof crypto === 'object' && crypto ? crypto : null;
  if (random && typeof random.randomUUID === 'function') return `pos-${random.randomUUID()}`;
  if (random && typeof random.getRandomValues === 'function') {
    return `pos-${Array.from(random.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  // (no crypto on this device: the key only has to be different for each tap, not secret)
  return `pos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

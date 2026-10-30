// The loyalty card at the counter (API contract v6 section 1, v7 section 4, v22-stamps): the stamps on a member's card,
// their rolls waiting in My Lair, the stamps a check-in or a payment just added, and the moment a check-in fills a card
// (Mo, 27 Oct 2026: "show the member's loyalty card progress, a friendly line when someone's card fills"). Round 22
// (Mo, 28 Oct 2026: "the stamp is not clear" and "give the staff [a way] to add a stamp on the area for the stamps"):
// the card is drawn like a punch card, two rows of five, with what's left in words, and staff can add a stamp on it.
// No `shopify` global here, so `npm test` can check it without a POS.
import { plural } from './format.js';

/**
 * @typedef {{ stamps: number, size: number, rolls: number, card: number, waiting?: number }} Card
 *   stamps on this card (a full card's roll joins `rolls` and the next card starts at 0), the card's size (10), rolls
 *   waiting in My Lair, and which card they're on (1 for the first; 0 when the Lair app didn't say). waiting (round 24,
 *   contract v24-new-players): a welcome code's rolls waiting for their first paid session, only while some do
 */

/** Stamps to a row when the card is drawn: two rows of five, like a punch card. */
export const ROW = 5;

/**
 * A scan's `loyalty` (`{ stamps, cardSize, rollsAvailable, card, rollsWaiting? }`) as a Card, or null when there isn't
 * one (a Lair app from before round 6, or a guest's ticket: only an account has a card).
 * @param {unknown} loyalty
 * @returns {Card | null}
 */
export function loyaltyCard(loyalty) {
  if (!loyalty || typeof loyalty !== 'object') return null;
  const raw = /** @type {{ stamps?: unknown, cardSize?: unknown, rollsAvailable?: unknown, card?: unknown, rollsWaiting?: unknown }} */ (loyalty);
  const size = Math.round(Number(raw.cardSize) || 0);
  if (size < 1) return null;
  const waiting = Math.max(0, Math.round(Number(raw.rollsWaiting) || 0));
  return {
    stamps: Math.min(size, Math.max(0, Math.round(Number(raw.stamps) || 0))),
    size,
    rolls: Math.max(0, Math.round(Number(raw.rollsAvailable) || 0)),
    card: Math.max(0, Math.round(Number(raw.card) || 0)),
    ...(waiting ? { waiting } : {}),
  };
}

/** "Loyalty card 3", or "Loyalty card" when the Lair app didn't say which. @param {Card} card */
export function cardHeading(card) {
  return card.card ? `Loyalty card ${card.card}` : 'Loyalty card';
}

/**
 * The stamps in words: "9 of 10 stamps. One more fills it.", "4 of 10 stamps." or "A new card: no stamps yet."
 * @param {Card} card
 */
export function stampWords(card) {
  if (!card.stamps) return 'A new card: no stamps yet.';
  const left = card.size - card.stamps;
  if (left === 1) return `${card.stamps} of ${card.size} stamps. One more fills it.`;
  return `${card.stamps} of ${card.size} stamps.`;
}

/** The count, big and short, for the top of the card: "7 of 10 stamps", "1 of 10 stamps", "No stamps yet". @param {Card} card */
export function stampCount(card) {
  return card.stamps ? `${card.stamps} of ${card.size} stamps` : 'No stamps yet';
}

/**
 * What's left, in words, under the count: "3 more fill the card: a d20 roll for store credit.", "One more fills the
 * card: a d20 roll for store credit." or, on a new card, "10 sessions fill the card: a d20 roll for store credit."
 * @param {Card} card
 */
export function stampsLeft(card) {
  const left = Math.max(0, card.size - card.stamps);
  const prize = 'a d20 roll for store credit.';
  if (!card.stamps) return `${plural(card.size, 'session')} fill the card: ${prize}`;
  if (left === 1) return `One more fills the card: ${prize}`;
  return `${left} more fill the card: ${prize}`;
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
 * The card's stamps one by one, for drawing: true for each stamp, false for each space left.
 * @param {Card} card
 * @returns {boolean[]}
 */
export function stampMarks(card) {
  return Array.from({ length: Math.min(card.size, 20) }, (_, i) => i < card.stamps);
}

/**
 * The card's stamps in rows of ROW (two rows of five on a 10-stamp card), for drawing like a punch card: each mark is
 * 'new' (a stamp this screen saw land: the last `fresh` of them), 'on' (an older stamp) or 'off' (a space left).
 * @param {Card} card
 * @param {number} [fresh] stamps this screen just saw land
 * @returns {('on' | 'new' | 'off')[][]}
 */
export function stampRows(card, fresh = 0) {
  const newOnes = Math.min(card.stamps, Math.max(0, Math.round(Number(fresh) || 0)));
  const marks = stampMarks(card).map((on, i) => (!on ? 'off' : i >= card.stamps - newOnes ? 'new' : 'on'));
  /** @type {('on' | 'new' | 'off')[][]} */
  const rows = [];
  for (let i = 0; i < marks.length; i += ROW) rows.push(/** @type {('on' | 'new' | 'off')[]} */ (marks.slice(i, i + ROW)));
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

/** The toast once staff add a stamp: "Stamp added: 8 of 10." or "Stamp added: Sam's card is full!". @param {unknown} loyalty @param {string} name */
export function stampAddedWords(loyalty, name) {
  const card = loyaltyCard(loyalty);
  if (!card) return 'Stamp added.';
  if (!card.stamps && card.card > 1) return `Stamp added: ${cardFullShort(name)}`;
  return `Stamp added: ${card.stamps} of ${card.size}.`;
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

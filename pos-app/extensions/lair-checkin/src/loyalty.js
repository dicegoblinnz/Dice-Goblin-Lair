// The loyalty card at the counter (API contract v6 section 1, v7 section 4): the stamps on a member's card, their rolls
// waiting in My Lair, and the moment a check-in fills a card (Mo, 27 Oct 2026: "show the member's loyalty card
// progress, a friendly line when someone's card fills"). For show only: stamps come from check-ins, and they roll in My
// Lair. No `shopify` global here, so `npm test` can check it without a POS.
import { plural } from './format.js';

/**
 * @typedef {{ stamps: number, size: number, rolls: number, card: number }} Card
 *   stamps on this card (a full card's roll joins `rolls` and the next card starts at 0), the card's size (10), rolls
 *   waiting in My Lair, and which card they're on (1 for the first; 0 when the Lair app didn't say)
 */

/**
 * A scan's `loyalty` (`{ stamps, cardSize, rollsAvailable, card }`) as a Card, or null when there isn't one (a Lair
 * app from before round 6, or a ticket: only member codes bring their card so far).
 * @param {unknown} loyalty
 * @returns {Card | null}
 */
export function loyaltyCard(loyalty) {
  if (!loyalty || typeof loyalty !== 'object') return null;
  const raw = /** @type {{ stamps?: unknown, cardSize?: unknown, rollsAvailable?: unknown, card?: unknown }} */ (loyalty);
  const size = Math.round(Number(raw.cardSize) || 0);
  if (size < 1) return null;
  return {
    stamps: Math.min(size, Math.max(0, Math.round(Number(raw.stamps) || 0))),
    size,
    rolls: Math.max(0, Math.round(Number(raw.rollsAvailable) || 0)),
    card: Math.max(0, Math.round(Number(raw.card) || 0)),
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

/** "1 roll waiting in My Lair", or '' with none. @param {Card} card */
export function rollWords(card) {
  return card.rolls ? `${plural(card.rolls, 'roll')} waiting in My Lair` : '';
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

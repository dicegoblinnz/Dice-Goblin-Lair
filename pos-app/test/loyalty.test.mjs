// The loyalty card at the counter: its stamps, rolls waiting, and the moment a card fills: `npm test` in pos-app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardFilled, cardFullWords, cardHeading, loyaltyCard, rollWords, stampMarks, stampWords } from '../extensions/lair-checkin/src/loyalty.js';

test('a scan’s loyalty becomes a card, or nothing from an older Lair app or nonsense', () => {
  assert.deepEqual(loyaltyCard({ stamps: 9, cardSize: 10, rollsAvailable: 1, card: 3 }), { stamps: 9, size: 10, rolls: 1, card: 3 });
  assert.deepEqual(loyaltyCard({ stamps: 4, cardSize: 10 }), { stamps: 4, size: 10, rolls: 0, card: 0 }, 'round 6: no card number');
  assert.deepEqual(loyaltyCard({ stamps: 'lots', cardSize: 10, rollsAvailable: -2 }), { stamps: 0, size: 10, rolls: 0, card: 0 });
  assert.deepEqual(loyaltyCard({ stamps: 14, cardSize: 10 }), { stamps: 10, size: 10, rolls: 0, card: 0 }, 'never more stamps than the card holds');
  assert.equal(loyaltyCard(undefined), null);
  assert.equal(loyaltyCard(null), null);
  assert.equal(loyaltyCard('7 stamps'), null);
  assert.equal(loyaltyCard({ stamps: 3 }), null, 'no card size');
});

test('the card in words: which card, its stamps, and rolls waiting in My Lair', () => {
  const card = loyaltyCard({ stamps: 9, cardSize: 10, rollsAvailable: 1, card: 3 });
  assert.ok(card);
  if (!card) return;
  assert.equal(cardHeading(card), 'Loyalty card 3');
  assert.equal(stampWords(card), '9 of 10 stamps. One more fills it.');
  assert.equal(rollWords(card), '1 roll waiting in My Lair');
  assert.deepEqual(stampMarks(card), [true, true, true, true, true, true, true, true, true, false]);
  assert.equal(cardHeading({ ...card, card: 0 }), 'Loyalty card');
  assert.equal(stampWords({ ...card, stamps: 4 }), '4 of 10 stamps.');
  assert.equal(stampWords({ ...card, stamps: 0 }), 'A new card: no stamps yet.');
  assert.equal(rollWords({ ...card, rolls: 3 }), '3 rolls waiting in My Lair');
  assert.equal(rollWords({ ...card, rolls: 0 }), '');
});

test('a card filled when they’re on a later card, or (without card numbers) more rolls and fewer stamps', () => {
  const before = { stamps: 9, cardSize: 10, rollsAvailable: 0, card: 3 };
  assert.equal(cardFilled(before, { stamps: 0, cardSize: 10, rollsAvailable: 1, card: 4 }), true);
  assert.equal(cardFilled(before, { stamps: 2, cardSize: 10, rollsAvailable: 1, card: 4 }), true, 'a group of three filled it and started the next');
  assert.equal(cardFilled(before, { stamps: 9, cardSize: 10, rollsAvailable: 0, card: 3 }), false, 'nothing changed');
  assert.equal(cardFilled({ stamps: 8, cardSize: 10, rollsAvailable: 0, card: 3 }, { stamps: 9, cardSize: 10, rollsAvailable: 0, card: 3 }), false, 'one more stamp');
  assert.equal(cardFilled({ stamps: 9, cardSize: 10, rollsAvailable: 0 }, { stamps: 0, cardSize: 10, rollsAvailable: 1 }), true, 'round 6');
  assert.equal(cardFilled({ stamps: 3, cardSize: 10, rollsAvailable: 0 }, { stamps: 3, cardSize: 10, rollsAvailable: 1 }), false, 'a roll from staff, not a full card');
  assert.equal(cardFilled(null, { stamps: 0, cardSize: 10, rollsAvailable: 1, card: 4 }), false);
  assert.equal(cardFilled(before, undefined), false);
  assert.equal(cardFullWords('Sam'), "Sam's loyalty card is full! A roll for store credit is waiting in My Lair.");
  assert.equal(cardFullWords(''), 'Their loyalty card is full! A roll for store credit is waiting in My Lair.');
});

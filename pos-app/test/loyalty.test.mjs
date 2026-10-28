// The loyalty card at the counter: its stamps, rolls waiting, and the moment a card fills: `npm test` in pos-app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cardFilled,
  cardFullWords,
  cardHeading,
  freshStamps,
  freshWords,
  loyaltyCard,
  rollWords,
  stampAddedWords,
  stampCount,
  stampKey,
  stampMarks,
  stampNote,
  stampRows,
  stampsLeft,
  stampWords,
} from '../extensions/lair-checkin/src/loyalty.js';

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

/* ---------------- round 22 (Mo, 28 Oct 2026: "the stamp is not clear") ---------------- */

test('round 22: the card drawn like a punch card, two rows of five, with the stamps that just landed marked new', () => {
  const card = loyaltyCard({ stamps: 7, cardSize: 10, rollsAvailable: 0, card: 2 });
  assert.ok(card);
  if (!card) return;
  assert.deepEqual(stampRows(card), [['on', 'on', 'on', 'on', 'on'], ['on', 'on', 'off', 'off', 'off']]);
  assert.deepEqual(stampRows(card, 2), [['on', 'on', 'on', 'on', 'on'], ['new', 'new', 'off', 'off', 'off']], 'the last two are new');
  assert.deepEqual(stampRows({ ...card, stamps: 1 }, 3), [['new', 'off', 'off', 'off', 'off'], ['off', 'off', 'off', 'off', 'off']], 'never more new than are on it');
  assert.deepEqual(stampRows({ ...card, stamps: 0 }), [['off', 'off', 'off', 'off', 'off'], ['off', 'off', 'off', 'off', 'off']]);
  assert.deepEqual(stampRows({ ...card, size: 12, stamps: 6 }).map((r) => r.length), [5, 5, 2], 'any size, five to a row');
});

test('round 22: the count, big and short, and what is left to the d20 roll', () => {
  const card = { stamps: 7, size: 10, rolls: 0, card: 2 };
  assert.equal(stampCount(card), '7 of 10 stamps');
  assert.equal(stampCount({ ...card, stamps: 1 }), '1 of 10 stamps');
  assert.equal(stampCount({ ...card, stamps: 0 }), 'No stamps yet');
  assert.equal(stampsLeft(card), '3 more fill the card: a d20 roll for store credit.');
  assert.equal(stampsLeft({ ...card, stamps: 9 }), 'One more fills the card: a d20 roll for store credit.');
  assert.equal(stampsLeft({ ...card, stamps: 0 }), '10 sessions fill the card: a d20 roll for store credit.');
  assert.equal(freshWords(1), 'New stamp');
  assert.equal(freshWords(3), '3 new stamps');
});

test('round 22: the stamps that landed between two looks, across a full card too', () => {
  const look = (stamps, card, rollsAvailable = 0) => ({ stamps, cardSize: 10, rollsAvailable, card });
  assert.equal(freshStamps(look(4, 1), look(7, 1)), 3, 'a check-in for three');
  assert.equal(freshStamps(look(9, 3), look(1, 4, 1)), 2, '9 on card 3, then 1 on card 4');
  assert.equal(freshStamps(look(9, 3), look(0, 4, 1)), 1, 'the one that filled it');
  assert.equal(freshStamps(look(5, 2), look(5, 2)), 0, 'nothing new');
  assert.equal(freshStamps(look(5, 2), look(3, 2)), 0, 'went down (a check-in undone): nothing new');
  assert.equal(freshStamps({ stamps: 2, cardSize: 10 }, { stamps: 5, cardSize: 10 }), 3, 'without card numbers, what this card shows');
  assert.equal(freshStamps(null, look(5, 2)), 0);
  assert.equal(freshStamps(look(5, 2), undefined), 0);
});

test('round 22: when stamps land, in words under the card', () => {
  assert.equal(stampNote(), 'Check-ins and payments add stamps by themselves. Add one here for a session the Lair app doesn’t know about.');
  assert.equal(stampNote({ people: 1, status: 'confirmed', paid: false }), 'Checking in or paying adds this session’s stamp.');
  assert.equal(stampNote({ people: 3, status: 'confirmed', paid: false }), 'Checking in or paying adds this session’s stamps.');
  assert.equal(stampNote({ people: 1, status: 'seated', arrivedAt: 1 }), 'This session’s stamp is on their card.');
  assert.equal(stampNote({ people: 2, status: 'attended' }), 'This session’s stamps are on their card.');
  assert.equal(stampNote({ people: 2, status: 'confirmed', paid: true }), 'This session’s stamps are on their card.', 'paid at the counter, or online');
  assert.equal(stampNote({ people: 2, status: 'noshow', paid: true }), '', 'a no-show stamps nobody');
  assert.equal(stampNote({ people: 1, status: 'cancelled' }), '');
});

test('round 22: the toast when staff add a stamp, and a different key for every tap', () => {
  assert.equal(stampAddedWords({ stamps: 8, cardSize: 10, rollsAvailable: 0, card: 1 }, 'Sam'), 'Stamp added: 8 of 10.');
  assert.equal(stampAddedWords({ stamps: 0, cardSize: 10, rollsAvailable: 1, card: 2 }, 'Sam'), "Stamp added: Sam's loyalty card is full!");
  assert.equal(stampAddedWords(null, 'Sam'), 'Stamp added.');
  const keys = new Set(Array.from({ length: 50 }, () => stampKey()));
  assert.equal(keys.size, 50);
  for (const key of keys) assert.match(key, /^[A-Za-z0-9_-]{8,64}$/, 'what the Lair app takes as a key');
});

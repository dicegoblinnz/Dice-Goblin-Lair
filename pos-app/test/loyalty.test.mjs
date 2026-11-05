// The loyalty card at the counter: its stamps, rolls waiting, and the moment a card fills: `npm test` in pos-app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cardFilled,
  cardFullWords,
  cardHeading,
  freshStamps,
  freshWords,
  headStartWords,
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

/* ---------------- round 29, the head start (Mo, 2 Nov 2026, mockup A: "12 slots, 2 from Gobgob") ----------------
   "Every card shows 12 slots, the first 2 already filled as Gobgob's head start, so a d20 roll still takes 10 paid
   visits. Cards in progress get the 2 as well: 7 of 10 shows as 9 of 12; 0 shows 2 of 12; 9 shows 11 of 12; the 10th
   stamp completes the card, a roll becomes available exactly as today, and the next card shows 2 of 12." The counter
   says "X of 12" too. A Lair app from before round 29 sends no slots: the card is as it was, ten slots. */

/** A scan's loyalty from a round 29 Lair app */
const r29 = (stamps, card = 1, rollsAvailable = 0) => ({ stamps, cardSize: 10, cards: card - 1, rollsAvailable, card, slots: 12, headStart: 2, onCard: stamps + 2 });

test('round 29: a card with the head start has 12 slots, Gobgob’s 2 and the stamps on top; an older Lair app’s has ten, as before', () => {
  assert.deepEqual(loyaltyCard(r29(7, 2, 1)), { stamps: 7, size: 10, rolls: 1, card: 2, slots: 12, headStart: 2, onCard: 9 }, '7 of 10 shows as 9 of 12');
  assert.deepEqual(loyaltyCard(r29(0)), { stamps: 0, size: 10, rolls: 0, card: 1, slots: 12, headStart: 2, onCard: 2 }, '0 shows 2 of 12');
  assert.deepEqual(loyaltyCard(r29(9)), { stamps: 9, size: 10, rolls: 0, card: 1, slots: 12, headStart: 2, onCard: 11 }, '9 shows 11 of 12');
  // onCard follows the stamps on the card, whatever came with them
  assert.equal(loyaltyCard({ ...r29(4), onCard: 40 })?.onCard, 6);
  // a Lair app from before round 29 (no slots), or slots that make no sense: ten slots and no head start, as before
  assert.deepEqual(loyaltyCard({ stamps: 7, cardSize: 10, rollsAvailable: 1, card: 2 }), { stamps: 7, size: 10, rolls: 1, card: 2 });
  assert.deepEqual(loyaltyCard({ stamps: 7, cardSize: 10, rollsAvailable: 1, card: 2, slots: 8 }), { stamps: 7, size: 10, rolls: 1, card: 2 });
  assert.deepEqual(loyaltyCard({ stamps: 7, cardSize: 10, rollsAvailable: 1, card: 2, slots: 'twelve' }), { stamps: 7, size: 10, rolls: 1, card: 2 });
});

test('round 29: the count says "X of 12" and what’s left is still the stamps to go; staff can say why the first 2 are gold', () => {
  const at = (stamps) => /** @type {import('../extensions/lair-checkin/src/loyalty.js').Card} */ (loyaltyCard(r29(stamps)));
  assert.deepEqual([stampCount(at(0)), stampCount(at(7)), stampCount(at(9))], ['2 of 12', '9 of 12', '11 of 12']);
  assert.equal(stampsLeft(at(0)), '10 more fill the card: a d20 roll for store credit.', 'a new card: still 10 paid visits to a roll');
  assert.equal(stampsLeft(at(7)), '3 more fill the card: a d20 roll for store credit.');
  assert.equal(stampsLeft(at(9)), 'One more fills the card: a d20 roll for store credit.');
  assert.equal(stampWords(at(9)), '11 of 12. One more fills it.');
  assert.equal(stampWords(at(7)), '9 of 12.');
  assert.equal(stampWords(at(0)), 'A new card: 2 of 12, with Gobgob’s head start.');
  assert.equal(headStartWords(at(7)), 'The first 2 are Gobgob’s head start: a roll is still 10 visits.');
  const older = loyaltyCard({ stamps: 7, cardSize: 10, rollsAvailable: 0, card: 2 });
  assert.ok(older);
  if (!older) return;
  assert.equal(headStartWords(older), '', 'an older Lair app: no head start to explain');
  assert.deepEqual([stampCount(older), stampsLeft(older)], ['7 of 10 stamps', '3 more fill the card: a d20 roll for store credit.'], 'and its words as before');
  assert.equal(stampAddedWords(r29(8), 'Sam'), 'Stamp added: 10 of 12.');
  assert.equal(stampAddedWords(r29(0, 2, 1), 'Sam'), "Stamp added: Sam's loyalty card is full!", 'the 10th stamp fills it; the next card is 2 of 12');
});

test('round 29: the card drawn in three rows of four: Gobgob’s 2 first, then the stamps (the ones that just landed marked new), then the spaces left', () => {
  const card = loyaltyCard(r29(7, 2));
  assert.ok(card);
  if (!card) return;
  assert.deepEqual(stampRows(card), [['head', 'head', 'on', 'on'], ['on', 'on', 'on', 'on'], ['on', 'off', 'off', 'off']]);
  assert.deepEqual(stampRows(card, 2), [['head', 'head', 'on', 'on'], ['on', 'on', 'on', 'new'], ['new', 'off', 'off', 'off']], 'the last two are new');
  assert.deepEqual(stampRows({ ...card, stamps: 0, onCard: 2 }, 3), [['head', 'head', 'off', 'off'], ['off', 'off', 'off', 'off'], ['off', 'off', 'off', 'off']], 'a new card: just Gobgob’s 2');
  assert.deepEqual(stampMarks(card).filter(Boolean).length, 9, '9 of 12 filled');
});

test('round 29: stamps that landed and a card that filled are counted by the 10 stamps a card takes, as before', () => {
  assert.equal(freshStamps(r29(4), r29(7)), 3);
  assert.equal(freshStamps(r29(9, 3), r29(1, 4, 1)), 2, '11 of 12 on card 3, then 3 of 12 on card 4: two stamps');
  assert.equal(cardFilled(r29(9, 3), r29(0, 4, 1)), true, 'the 10th stamp fills it');
  assert.equal(cardFilled(r29(8, 3), r29(9, 3)), false, '11 of 12 isn’t full');
  // the Lair app went live while the screen was open: an older card before, a round 29 one after
  assert.equal(freshStamps({ stamps: 4, cardSize: 10, rollsAvailable: 0, card: 1 }, r29(5)), 1);
  assert.equal(cardFilled({ stamps: 9, cardSize: 10, rollsAvailable: 0, card: 1 }, r29(0, 2, 1)), true);
});

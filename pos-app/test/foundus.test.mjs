// Round 24 (contract v24-new-players): "How did they find us?" on a new player's first day, and a welcome code's roll
// waiting on their card: `npm test` in pos-app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOUND_US, FOUND_US_WORDS, askFoundUs, foundUsSaved } from '../extensions/lair-checkin/src/foundus.js';
import { nextScreen } from '../extensions/lair-checkin/src/flow.js';
import { loyaltyCard, welcomeWords } from '../extensions/lair-checkin/src/loyalty.js';
import { FOUND_US_ANSWERS } from '../../src/newplayers.js';

test('the counter offers exactly the answers the Lair app keeps, in its order, and its words', () => {
  assert.deepEqual(FOUND_US, FOUND_US_ANSWERS);
  assert.deepEqual(FOUND_US_WORDS, {
    heading: 'How did they find us?',
    hint: 'They’re new here. Ask, then tap their answer: it tells us which ads bring people in.',
  });
  assert.equal(foundUsSaved('instagram'), 'Saved: Instagram');
  assert.equal(foundUsSaved('walked-past'), 'Saved: Walked past');
  assert.equal(foundUsSaved('myspace'), 'Saved');
});

test('the question shows on a new player’s first day until someone answers, and never from an older Lair app', () => {
  const scan = (more) => nextScreen({ type: 'member', member: { customerId: '777', name: 'Sam Jones' }, rows: [], ...more });
  const fresh = scan({ newHere: true, foundUs: null });
  assert.deepEqual(fresh?.name === 'member' && [fresh.newHere, fresh.foundUs], [true, null]);
  assert.equal(askFoundUs(fresh), true, 'new, and nobody has asked');
  const answered = scan({ newHere: true, foundUs: { answer: 'instagram', label: 'Instagram' } });
  assert.equal(askFoundUs(answered), false, 'answered already');
  assert.equal(askFoundUs(scan({ newHere: false, foundUs: null })), false, 'played here before today');
  const older = scan({});
  assert.deepEqual(older?.name === 'member' && [older.newHere, older.foundUs], [false, null]);
  assert.equal(askFoundUs(older), false, 'a Lair app from before round 24 says nothing, so nothing is asked');
  assert.equal(askFoundUs(scan({ newHere: 'yes' })), false);
});

test('a welcome code’s roll waiting shows on the card until their first paid session', () => {
  const card = loyaltyCard({ stamps: 0, cardSize: 10, rollsAvailable: 0, card: 1, rollsWaiting: 1 });
  assert.deepEqual(card, { stamps: 0, size: 10, rolls: 0, card: 1, waiting: 1 });
  assert.equal(card && welcomeWords(card), 'Welcome roll waiting: theirs once they’ve paid for a session.');
  const two = loyaltyCard({ stamps: 3, cardSize: 10, rollsAvailable: 0, card: 1, rollsWaiting: 2 });
  assert.equal(two && welcomeWords(two), '2 welcome rolls waiting: theirs once they’ve paid for a session.');
  const none = loyaltyCard({ stamps: 3, cardSize: 10, rollsAvailable: 1, card: 1 });
  assert.deepEqual(none, { stamps: 3, size: 10, rolls: 1, card: 1 }, 'nothing waiting: the card as it was');
  assert.equal(none && welcomeWords(none), '');
  assert.equal(welcomeWords({ stamps: 0, size: 10, rolls: 0, card: 1, waiting: 0 }), '');
});

// Split the bill: shares, who's paying, and waiting for a payment to land: `npm test` in pos-app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  amountProblem,
  bookerPayer,
  canSplit,
  cleanPending,
  paidSummary,
  parseDollars,
  payerFromScan,
  paymentsLine,
  pendingShare,
  pendingState,
  PENDING_MS,
  personShare,
  shareSummary,
  sharesLeft,
  splitFirst,
  WAITING,
} from '../extensions/lair-checkin/src/split.js';

// Sam booked T4 for 4 people at $10 each and is splitting the bill.
const sam = { id: 'bk_sam', type: 'booking', ref: 'SJ-OWLBEAR-17', name: 'Sam Jones', people: 4, amount: 4000, covered: 0, paidAmount: 0, due: 4000, split: true, customerId: '777' };

test('one person’s share is the amount shared by everyone, never more than what’s left', () => {
  assert.equal(personShare(sam), 1000);
  assert.equal(sharesLeft(sam), 4);
  assert.equal(shareSummary(sam), '4 of 4 left to pay · $10 each');
  const twoPaid = { ...sam, paidAmount: 2000, due: 2000 };
  assert.equal(sharesLeft(twoPaid), 2);
  assert.equal(shareSummary(twoPaid), '2 of 4 left to pay · $10 each');
  // A pass covered two of them: two shares left.
  assert.equal(sharesLeft({ ...sam, covered: 2000, due: 2000 }), 2);
  // $25 for 3 people: $8.34 each, rounded up like the Lair app does; the last share is what's left.
  const odd = { ...sam, people: 3, amount: 2500, due: 2500 };
  assert.equal(personShare(odd), 834);
  assert.equal(personShare({ ...odd, paidAmount: 1668, due: 832 }), 832);
  assert.equal(sharesLeft(odd), 3);
  assert.equal(personShare({ ...sam, due: 0, paid: true }), 0);
  assert.equal(shareSummary({ ...sam, due: 0 }), 'Nothing left to pay');
});

test('split is offered when there is something due and someone to split it with', () => {
  assert.equal(canSplit(sam), true);
  assert.equal(splitFirst(sam), true, 'they chose to split when booking');
  assert.equal(canSplit({ ...sam, split: false }), true, 'four people can still split');
  assert.equal(splitFirst({ ...sam, split: false }), false);
  assert.equal(canSplit({ ...sam, people: 1, split: false }), false);
  assert.equal(splitFirst({ ...sam, people: 1, split: false, paidAmount: 500, due: 3500 }), true, 'part paid already');
  assert.equal(canSplit({ ...sam, due: 0 }), false);
});

test('says what is paid, what is left and who paid', () => {
  assert.equal(paidSummary(sam), '');
  const part = { ...sam, paidAmount: 2000, due: 2000, payments: [{ amount: 1000, name: 'Sam Jones', customerId: '777' }, { amount: 1000, name: 'Alex Kim' }] };
  assert.equal(paidSummary(part), 'Paid $20 of $40 · $20 left');
  assert.equal(paymentsLine(part), 'Sam $10 · Alex $10');
  assert.equal(paidSummary({ ...sam, covered: 1000, paidAmount: 3000, due: 0, paid: true }), 'Paid $30 of $30');
  assert.equal(paymentsLine({ ...sam, payments: [{ amount: 500 }] }), 'Someone $5');
  assert.equal(paymentsLine(sam), '');
});

test('reads a typed amount in dollars', () => {
  assert.equal(parseDollars('12'), 1200);
  assert.equal(parseDollars('12.5'), 1250);
  assert.equal(parseDollars(' $12.35 '), 1235);
  assert.equal(parseDollars('.5'), 50);
  assert.equal(parseDollars('1,200'), 120000);
  assert.equal(parseDollars('12.'), 1200);
  for (const bad of ['', '0', '0.00', '-5', 'ten', '12.345', '1e3', null, undefined]) assert.equal(parseDollars(bad), null, String(bad));
  assert.equal(amountProblem(1250, sam), '');
  assert.equal(amountProblem(4000, sam), '');
  assert.equal(amountProblem(4001, sam), 'Only $40 is left to pay.');
  assert.equal(amountProblem(null, sam), 'Type an amount, like 12.50.');
});

test('who’s paying: the booker, a scanned member code, or a ticket on their account', () => {
  assert.deepEqual(bookerPayer(sam), { customerId: '777', name: 'Sam Jones', code: 'SJ-OWLBEAR-17' });
  assert.equal(bookerPayer({ ...sam, customerId: null }), null);
  assert.deepEqual(payerFromScan({ type: 'member', member: { customerId: '555', name: 'Alex Kim', code: 'AK-KIWI-3' }, rows: [] }), {
    payer: { customerId: '555', name: 'Alex Kim', code: 'AK-KIWI-3' },
  });
  assert.deepEqual(payerFromScan({ type: 'booking', row: { ...sam, customerId: 888, name: 'Jo Bloggs', ref: 'JB-TUI-2' } }), {
    payer: { customerId: '888', name: 'Jo Bloggs', code: 'JB-TUI-2' },
  });
  for (const answer of [{ type: 'pass', pass: { code: 'P' } }, { type: 'booking', row: { ...sam, customerId: null } }, null]) {
    assert.match(/** @type {any} */ (payerFromScan(answer)).problem, /^That's not a member code/);
  }
});

test('a share put in the cart is in the cart, then waiting, until its payment lands', () => {
  const now = 1_000_000;
  const note = pendingShare(sam, 1000, now);
  assert.deepEqual(note, { ref: 'SJ-OWLBEAR-17', amount: 1000, expect: 1000, at: now });
  assert.equal(pendingState(note, sam, ['SJ-OWLBEAR-17'], now + 1000), 'in-cart');
  assert.equal(pendingState(note, sam, [], now + 60_000), 'waiting', 'paid on the Verifone, webhook not here yet');
  assert.equal(WAITING, 'Waiting for the last payment…');
  assert.equal(pendingState(note, { ...sam, paidAmount: 1000, due: 3000 }, [], now + 70_000), 'landed');
  assert.equal(pendingState(note, { ...sam, paidAmount: 0, due: 0, paid: true }, [], now + 70_000), 'landed', 'marked paid by hand');
  assert.equal(pendingState(note, sam, [], now + PENDING_MS), 'expired');
  assert.equal(pendingState(null, sam, [], now), 'none');
  // The second share: Sam's $10 already landed.
  const second = pendingShare({ ...sam, paidAmount: 1000, due: 3000 }, 1000, now);
  assert.equal(second.expect, 2000);
  assert.equal(pendingState(second, { ...sam, paidAmount: 1000, due: 3000 }, [], now + 5000), 'waiting');
});

test('saved notes are checked when they are read back', () => {
  const now = 10 * PENDING_MS;
  const saved = {
    'booking:bk_sam': { ref: 'SJ-OWLBEAR-17', amount: 1000, expect: 1000, at: now - 1000 },
    'booking:old': { ref: 'AB-OWL-1', amount: 1000, expect: 1000, at: now - PENDING_MS - 1 },
    'booking:junk': { ref: '', expect: 1 },
    'booking:nan': { ref: 'X', expect: 'lots', at: now },
  };
  assert.deepEqual(cleanPending(saved, now), { 'booking:bk_sam': saved['booking:bk_sam'] });
  assert.deepEqual(cleanPending(undefined, now), {});
  assert.deepEqual(cleanPending('nope', now), {});
});

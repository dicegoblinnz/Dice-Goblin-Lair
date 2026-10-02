// Checks the Lair check-in helpers without a POS: `npm test` in pos-app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  customerIdNumber,
  describeTicket,
  feeLines,
  linesTotal,
  money,
  readCode,
  rollsLabel,
  whenLabel,
} from '../extensions/lair-checkin/src/codes.js';

// 3 Oct 2026 is NZDT (UTC+13): 05:00 UTC is 6pm in Auckland.
const at = (day, hourUtc) => Date.UTC(2026, 9, day, hourUtc, 0);

test('reads ticket codes however they are typed or scanned', () => {
  for (const raw of ['SAM-4821', 'sam4821', ' sam 4821 ', 'Sam-4821\n', 'https://www.dicegoblin.nz/t/SAM-4821']) {
    assert.deepEqual(readCode(raw), { kind: 'ticket', code: 'SAM-4821' }, raw);
  }
  assert.deepEqual(readCode('GOB-7K2QXM'), { kind: 'ticket', code: 'GOB-7K2QXM' });
  assert.deepEqual(readCode('gob7k2qxm'), { kind: 'ticket', code: 'GOB-7K2QXM' });
  assert.deepEqual(readCode('GOB-1234'), { kind: 'ticket', code: 'GOB-1234' });
  assert.deepEqual(readCode('GOB123456'), { kind: 'ticket', code: 'GOB-123456' });
});

test('reads member cards', () => {
  assert.deepEqual(readCode('DGC-7234567890123'), { kind: 'member', code: 'DGC-7234567890123', customerId: '7234567890123' });
  assert.deepEqual(readCode('dgc 42'), { kind: 'member', code: 'DGC-42', customerId: '42' });
});

test('turns away things that are not Lair codes', () => {
  assert.deepEqual(readCode('   '), { kind: 'empty' });
  assert.equal(readCode('9421234567890').kind, 'unknown');
  assert.equal(readCode('hello there').kind, 'unknown');
  assert.equal(readCode('SAM-482').kind, 'unknown');
});

test('formats money, ids and rolls', () => {
  assert.equal(money(4000), '$40.00');
  assert.equal(money(1250), '$12.50');
  assert.equal(money(undefined), '$0.00');
  assert.equal(customerIdNumber('123'), 123);
  assert.equal(customerIdNumber('gid://shopify/Customer/7234567890123'), 7234567890123);
  assert.equal(customerIdNumber('nope'), null);
  assert.equal(rollsLabel(2), '2 bonus rolls waiting');
  assert.equal(rollsLabel({ daily: true, bonus: 1, toNext: 500 }), "1 bonus roll waiting · today's free roll not used yet · $5.00 more spend for the next roll");
  assert.equal(rollsLabel(null), '');
});

test('says when, in Auckland time', () => {
  assert.equal(whenLabel(at(3, 5), at(3, 8), at(3, 1)), 'Today, 6:00pm–9:00pm');
  assert.equal(whenLabel(at(4, 5), at(4, 8), at(3, 1)), 'Sun 4 Oct, 6:00pm–9:00pm');
  assert.equal(whenLabel(undefined, undefined), '');
});

const tableBooking = {
  found: true,
  kind: 'booking',
  booking: { ref: 'SAM-4821', kind: 'table', name: 'Sam Smith', tables: ['T4'], start: at(3, 5), end: at(3, 8), people: 4, paid: false },
  checkedIn: false,
  due: 4000,
};

test('describes a table booking for the result card', () => {
  const t = describeTicket(tableBooking, 'SAM-4821', at(3, 1));
  assert.equal(t.name, 'Sam Smith');
  assert.equal(t.what, 'Table booking');
  assert.equal(t.when, 'Today, 6:00pm–9:00pm');
  assert.equal(t.tables, 'Table T4');
  assert.equal(t.people, '4 people');
  assert.equal(t.due, 4000);
});

test('describes GM game seats and event sign-ups', () => {
  const seat = describeTicket(
    {
      kind: 'booking',
      booking: { ref: 'ANA-1111', kind: 'gm-seat', name: 'Ana', tables: [], people: 2, players: [{ name: 'Ana' }, { name: 'Ben' }] },
      game: { title: 'Curse of Strahd', tables: ['T7', 'T8'] },
      due: 3000,
    },
    'ANA-1111',
  );
  assert.equal(seat.what, 'Game seat: Curse of Strahd');
  assert.equal(seat.tables, 'Tables T7, T8');
  assert.equal(seat.people, '2 people: Ana, Ben');
  const join = describeTicket({ kind: 'join', join: { ref: 'JO-2222', title: 'Warhammer night', name: 'Jo', people: 1 }, due: 0 }, 'JO-2222');
  assert.equal(join.what, 'Event sign-up: Warhammer night');
  assert.equal(join.people, '1 person');
});

test('uses the fee lines the Lair app sends', () => {
  const lines = feeLines(
    { ...tableBooking, lines: [{ title: 'Table fee SAM-4821 (T4)', price: '40.00', quantity: 1, taxable: true, properties: { _booking: 'SAM-4821' } }] },
    'SAM-4821',
  );
  assert.deepEqual(lines, [{ title: 'Table fee SAM-4821 (T4)', price: '40.00', quantity: 1, taxable: true, properties: { _booking: 'SAM-4821' } }]);
  assert.equal(linesTotal(lines), 4000);
});

test('makes a fee line from what is due when the Lair app sends none', () => {
  assert.deepEqual(feeLines(tableBooking, 'SAM-4821'), [
    { title: 'Table fee SAM-4821 (T4)', price: '40.00', quantity: 1, taxable: true, properties: { _booking: 'SAM-4821' } },
  ]);
  assert.deepEqual(feeLines({ kind: 'join', join: { ref: 'JO-2222' }, due: 1500 }, 'JO-2222'), [
    { title: 'Entry fee JO-2222', price: '15.00', quantity: 1, taxable: true, properties: { _booking: 'JO-2222' } },
  ]);
});

test('adds nothing when nothing is due, and skips broken lines', () => {
  assert.deepEqual(feeLines({ ...tableBooking, due: 0 }, 'SAM-4821'), []);
  assert.deepEqual(feeLines({ ...tableBooking, due: 0, lines: [{ title: 'Bad', price: 'abc' }] }, 'SAM-4821'), []);
  const tagged = feeLines({ ...tableBooking, lines: [{ title: 'Table fee', price: 40, quantity: 2 }] }, 'SAM-4821');
  assert.deepEqual(tagged[0].properties, { _booking: 'SAM-4821' });
  assert.equal(tagged[0].price, '40.00');
  assert.equal(linesTotal(tagged), 8000);
});

// Money, people, tables and times as the counter screens show them: `npm test` in pos-app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  customerIdNumber,
  dateLabel,
  dayKey,
  dayLabel,
  firstName,
  fold,
  longDay,
  loyaltyLine,
  money,
  peopleLabel,
  plural,
  tablesLabel,
  timeLabel,
  timeRange,
  whenLabel,
} from '../extensions/lair-checkin/src/format.js';

// 3 Oct 2026 is NZDT (UTC+13): 05:00 UTC is 6pm in Auckland.
const at = (day, hourUtc, minute = 0) => Date.UTC(2026, 9, day, hourUtc, minute);

test('money is whole dollars unless there are cents', () => {
  assert.equal(money(1500), '$15');
  assert.equal(money(1250), '$12.50');
  assert.equal(money(5), '$0.05');
  assert.equal(money(120000), '$1,200');
  assert.equal(money(0), '$0');
  assert.equal(money(undefined), '$0');
  assert.equal(money(-500), '$0');
  assert.equal(money('2000'), '$20');
});

test('people, tables, names and plurals', () => {
  assert.equal(peopleLabel(1), '1 person');
  assert.equal(peopleLabel(3), '3 people');
  assert.equal(peopleLabel(0), '');
  assert.equal(tablesLabel(['T7', 'T8']), 'T7, T8');
  assert.equal(tablesLabel(['T4']), 'T4');
  assert.equal(tablesLabel([]), '');
  assert.equal(tablesLabel(undefined), '');
  assert.equal(firstName('Sam Jones'), 'Sam');
  assert.equal(firstName('  Zoë van der Berg '), 'Zoë');
  assert.equal(plural(1, 'item'), '1 item');
  assert.equal(plural(2, 'item'), '2 items');
  assert.equal(fold('  Zoë VAN der Berg'), 'zoe van der berg');
});

test('the loyalty card line: stamps of the card, and rolls waiting in My Lair when there are any', () => {
  assert.equal(loyaltyLine({ stamps: 7, cardSize: 10, rollsAvailable: 1 }), 'Loyalty card: 7 of 10 stamps · 1 roll waiting in My Lair');
  assert.equal(loyaltyLine({ stamps: 0, cardSize: 10, rollsAvailable: 3 }), 'Loyalty card: 0 of 10 stamps · 3 rolls waiting in My Lair');
  assert.equal(loyaltyLine({ stamps: 9, cardSize: 10, rollsAvailable: 0 }), 'Loyalty card: 9 of 10 stamps');
  assert.equal(loyaltyLine({ stamps: 4, cardSize: 10 }), 'Loyalty card: 4 of 10 stamps');
  // Nothing from an older Lair app, or nothing that makes sense: no line
  assert.equal(loyaltyLine(undefined), '');
  assert.equal(loyaltyLine(null), '');
  assert.equal(loyaltyLine('7 stamps'), '');
  assert.equal(loyaltyLine({ stamps: 3 }), '');
  assert.equal(loyaltyLine({ stamps: 'lots', cardSize: 10, rollsAvailable: -2 }), 'Loyalty card: 0 of 10 stamps');
});

test('times are short and in Auckland time', () => {
  assert.equal(timeLabel(at(3, 5)), '6pm');
  assert.equal(timeLabel(at(3, 5, 30)), '6:30pm');
  assert.equal(timeLabel(at(2, 23)), '12pm');
  assert.equal(timeLabel(at(2, 22)), '11am');
  assert.equal(timeLabel(undefined), '');
  assert.equal(timeRange(at(3, 5), at(3, 8)), '6pm–9pm');
  assert.equal(timeRange(at(3, 5), undefined), '6pm');
  assert.equal(whenLabel(at(3, 5), at(3, 8), at(3, 1)), 'Today, 6pm–9pm');
  assert.equal(whenLabel(at(4, 5), at(4, 8), at(3, 1)), 'Sun 4 Oct, 6pm–9pm');
  assert.equal(dayLabel(at(3, 10), at(3, 1)), 'Today');
  assert.equal(dateLabel(Date.UTC(2026, 11, 31, 5)), '31 Dec 2026');
  assert.equal(longDay(at(3, 5)), 'Saturday 3 October');
  assert.equal(longDay(undefined), '');
});

test('the Lair day is the Auckland date, in the same form as GET /pos/today', () => {
  assert.equal(dayKey(at(3, 5)), '2026-10-03');
  assert.equal(dayKey(at(2, 10)), '2026-10-02', '11pm on Friday in Auckland');
  assert.equal(dayKey(at(2, 11)), '2026-10-03', 'midnight in Auckland is 11am UTC');
});

test('customer ids become the number the POS cart wants', () => {
  assert.equal(customerIdNumber('123'), 123);
  assert.equal(customerIdNumber(123), 123);
  assert.equal(customerIdNumber('gid://shopify/Customer/7234567890123'), 7234567890123);
  assert.equal(customerIdNumber('nope'), null);
  assert.equal(customerIdNumber(null), null);
});

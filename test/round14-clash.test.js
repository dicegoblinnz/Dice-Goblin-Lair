// Round 14, found on the way: POST /bookings took ignoreBookingId and game from the request. Booking ids are on the public
// floor, so anyone could book a table someone else had by sending that booking's id as ignoreBookingId (the clash check
// skipped it), and game: true let one person take a GM's two tables. Both are the Lair's own now (only checkGameSession
// sets them). Run with: node --test test/
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings } from '../src/core.js';

const time = new LairTime('Pacific/Auckland');
const DAY = 24 * 3_600_000;
// Friday 9 October 2026, 1:00pm in Auckland
const NOW = Date.UTC(2026, 9, 9, 0, 0);
const realNow = Date.now;
const MOBILE = '021 555 0100';
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);

function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      if (/^\s*(select|with)/i.test(query)) {
        const rows = stmt.all(...bindings);
        return { toArray: () => rows, one: () => rows[0] };
      }
      stmt.run(...bindings);
      return { toArray: () => [], one: () => undefined };
    },
  };
  const kv = new Map();
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: () => {} };
}

let lair;
async function call(method, path, body, customer = '') {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer }, body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: response.status, data: await response.json() };
}

beforeEach(() => {
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'example-shop.myshopify.com' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: id === 'gm', tags: [] });
  lair.rulesCache = rulesFromSettings({ lair_hours: 'Sat 10:00-23:00', lair_shop_tables: '' }, [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }], []);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
});
afterEach(() => {
  Date.now = realNow;
});

test("a booking can't skip the clash check with someone else's booking id (ignoreBookingId and game are the Lair's own)", async () => {
  const first = await call('POST', 'bookings', { kind: 'table', tables: ['T5'], start: at('2026-10-10', 14), end: at('2026-10-10', 16), people: 2, name: 'Jo', email: 'jo@example.com', phone: MOBILE });
  assert.equal(first.status, 200, first.data.error);
  const sneaky = await call('POST', 'bookings', {
    kind: 'table', tables: ['T5'], start: at('2026-10-10', 14), end: at('2026-10-10', 16), people: 2, name: 'Sneaky', email: 'sneaky@example.com', phone: MOBILE,
    ignoreBookingId: first.data.booking.id,
  });
  assert.equal(sneaky.status, 409, 'T5 is taken');
  const greedy = await call('POST', 'bookings', {
    kind: 'table', tables: ['T6', 'T7'], start: at('2026-10-10', 14), end: at('2026-10-10', 16), people: 1, name: 'Greedy', email: 'greedy@example.com', phone: MOBILE, game: true,
  });
  assert.equal(greedy.status, 422, "game: true doesn't buy a GM's two tables");
});

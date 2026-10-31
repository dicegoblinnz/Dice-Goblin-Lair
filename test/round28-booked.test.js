// Round 28: "Booked a session" for the ad platforms (contract v28-booked). The ads plan's tracking list: "A 'Booked a
// session' event when a table, TTRPG seat or event booking is confirmed, sent to both platforms and flagged when it's
// someone's first booking." Mo (1 Nov 2026): "how do we add all of the tracking pixels etc can you do it yourself".
// The Lair says what to tell (track on a booking's answer); the website sends it on. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const TODAY = '2026-11-01';
const YESTERDAY = '2026-10-31';
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Sunday 1 November 2026, 1:00pm in Auckland (NZDT, UTC+13)
const NOW = at(TODAY, 13);
const realNow = Date.now;
const nowIs = (ms) => {
  Date.now = () => ms;
};

/* ---------------- helpers, as in test/round22-stamps.test.js ---------------- */
function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      // as SQLite in a Durable Object: Cloudflare's limits (test/cloudflare-sql.js)
      cloudflareSql(query, bindings);
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

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];
// Today's events: trivia night at $5 a person, and a free demo night (nothing to pay)
const EVENTS = [
  { id: 'quiz', title: 'Trivia night', start: at(TODAY, 18), end: at(TODAY, 20), tables: '', capacity: 20, entryFee: 500 },
  { id: 'demo', title: 'Free demo night', start: at(TODAY, 15), end: at(TODAY, 17), tables: '', capacity: 20, entryFee: 0 },
  // Warhammer night: no sign-ups, two game spots to reserve (T14+T15, T16+T17)
  { id: 'warhammer', title: 'Warhammer night', start: at(TODAY, 18), end: at(TODAY, 21), tables: '', gameTables: 'T14+T15, T16+T17' },
];
// People by their Shopify customer IDs (made up): the main account; helpers Hemi (Check-in) and Tama (Library only); and
// players, every one of them new to the Lair unless a test says otherwise
const OWNER = '9001';
const HEMI = '9102';
const TAMA = '9103';
const MIA = '6001';
const KAI = '6002';
const RIA = '6003';
const LEO = '6004';
// A GM who runs TTRPG sessions
const GM = '7001';
const ENV = { CURRENCY: 'NZD' };

let ctx;
let lair;
// Who paid each POS order (its number → customer ID): Shopify's answer for the order's customer, so the Lair notes whose
// payment it was (payments.customer_id)
let buyers;
// Each store credit Shopify was asked for ([customerId, cents])
let credited;
async function call(method, path, body, customer = '', extraHeaders = {}) {
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders },
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, data: await response.json() };
}
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const internal = (path, body) => call('POST', `internal/${path}`, body, '', { 'X-Lair-Internal': '1' });
const pos = (path, body) => internal(`pos/${path}`, body);
const update = (id, patch, who = OWNER) => call('POST', `bookings/${id}/update`, patch, who);
const card = async (who) => ok(await call('GET', 'me', null, who)).loyalty;
const codeOf = (id) => lair.memberRow(id).code;
/** "Got a code?" in My Lair */
const redeem = (who, code) => call('POST', 'me/codes/redeem', { code }, who);
/** POST /roll as a member: one of their loyalty rolls */
const roll = (who) => call('POST', 'roll', { kind: 'loyalty' }, who, { 'X-Lair-Client': '203.0.113.7' });
const NO_ROLLS = '409 No rolls yet, friend. Fill your card: 10 sessions earn a roll.';

/** A paid POS order (the orders/paid webhook's shape): its line items as given, its customer when there is one */
const posOrder = (n, lineItems, extra = {}) => ({ id: n, admin_graphql_api_id: `gid://shopify/Order/${n}`, name: `#${n}`, source_name: 'pos', line_items: lineItems, ...extra });
/** An order line paying a booking at the counter (a custom sale with its code in _booking), $amount */
const bookingLine = (id, ref, amount) => ({ id, quantity: 1, price: amount.toFixed(2), properties: [{ name: '_booking', value: ref }] });
/** An order line for the Session product, $15 unless said */
const sessionLine = (id, variant, sku, price = '15.00') => ({ id, title: 'Session', variant_title: variant, sku, quantity: 1, price, properties: [] });

/** A table booked online by a member (pay at the Lair), today 2pm to 4pm unless said → the booking */
async function table(who, name, { tables = ['T3'], people = 1, start = at(TODAY, 14), end = at(TODAY, 16), ...more } = {}) {
  return ok(await call('POST', 'bookings', { kind: 'table', tables, start, end, people, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100', pay: 'day', ...more }, who)).booking;
}
/** A sign-up to one of today's events (pay at the Lair) → the sign-up */
async function signUp(who, name, event = 'quiz', more = {}) {
  return ok(await call('POST', `events/${event}@${TODAY}/join`, { name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100', people: 1, ...more }, who)).join;
}
/** Kai played yesterday: a table checked in and paid at the counter */
async function kaiPlayedYesterday() {
  nowIs(at(YESTERDAY, 13));
  const kais = await table(KAI, 'Kai', { tables: ['T9'], start: at(YESTERDAY, 14), end: at(YESTERDAY, 16) });
  ok(await pos('checkin', { id: kais.id, type: 'booking' }));
  ok(await internal('orders-paid', posOrder(7001, [bookingLine(70011, kais.ref, 10)])));
  nowIs(NOW);
  return kais;
}
const welcomeUses = (who) => lair.sql.exec("SELECT COUNT(*) AS n FROM roll_code_uses WHERE customer_id = ? AND pays_on = 'first-session'", who).one().n;

// No network in these tests: Shopify's store credit is a stand-in, and anything else that reaches out fails the test.
const realFetch = globalThis.fetch;
let reached = [];

beforeEach(async () => {
  reached = [];
  credited = [];
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  ctx = fakeCtx();
  lair = new Lair(ctx, ENV);
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: id === GM, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  buyers = new Map();
  lair.shopify.orderSpend = async (orderId) => {
    const n = String(orderId).split('/').pop();
    return buyers.has(n) ? { customerId: buyers.get(n), amount: 1000, source: 'pos', name: `#${n}` } : null;
  };
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  lair.shopify.customersSince = async () => new Map();
  lair.shopify.searchCustomers = async () => [{ customerId: OWNER, name: 'Mo', email: 'owner@example.com' }];
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.creditCustomer = async (customerId, cents) => {
    credited.push([customerId, cents]);
  };
  lair.shopify.createPrizeCode = async () => assert.fail('a loyalty roll never makes a discount code');
  lair.accountEmail = async () => ({ fetched: false, email: '' });
  lair.checkGiftCodes = async () => 0;
  lair.notifyStaff = () => {};
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  for (const [id, name, perms] of [[HEMI, 'Hemi Walker', ['checkin']], [TAMA, 'Tama Rewi', ['library']]]) {
    ok(await call('POST', 'team', { customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, perms }, OWNER));
  }
  for (const [id, name] of [[MIA, 'Mia Chen'], [KAI, 'Kai Tane'], [RIA, 'Ria Moana'], [LEO, 'Leo Park']]) {
    lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
  }
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});


/** POST a table booking as a member → the whole answer (booking, track, ...) */
async function bookTable(who, name, { tables = ['T3'], people = 1, start = at(TODAY, 14), end = at(TODAY, 16), ...more } = {}) {
  return ok(await call('POST', 'bookings', { kind: 'table', tables, start, end, people, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100', pay: 'day', ...more }, who));
}
/** POST a sign-up to one of today's events → the whole answer */
async function join(who, name, event = 'quiz', more = {}) {
  return ok(await call('POST', `events/${event}@${TODAY}/join`, { name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100', people: 1, ...more }, who));
}
/** A TTRPG session the GM lists for tonight (schedule 'flexible' makes it a weekly game you can join) → the game */
async function session(more = {}) {
  return ok(await call('POST', 'games', {
    title: 'Blades at the Lair', system: 'Blades in the Dark', gm: 'Ellie', email: 'ellie@example.com', blurb: 'Heists.', seats: 4, tables: ['T12'],
    start: at(TODAY, 18), end: at(TODAY, 21), ...more,
  }, GM)).game;
}
const track = (data, kind, first) => ({ id: (data.booking || data.join || {}).ref, kind, value: (data.booking || data.join).amount / 100, currency: 'NZD', first });

test('round 28: a new member\'s first table booking tells the ad platforms "booked": its code, what it comes to and first: true; their next booking isn\'t first', async () => {
  const first = await bookTable(MIA, 'Mia', { people: 2 });
  assert.ok(first.booking.amount > 0, 'a table has a fee');
  assert.deepEqual(first.track, track(first, 'table', true));
  const next = await bookTable(MIA, 'Mia', { tables: ['T4'], start: at(TODAY, 17), end: at(TODAY, 19) });
  assert.deepEqual(next.track, track(next, 'table', false));
});

test('round 28: someone who\'s played at the Lair before isn\'t booking for the first time', async () => {
  await kaiPlayedYesterday();
  const today = await bookTable(KAI, 'Kai');
  assert.equal(today.track.first, false);
});

test('round 28: a booking they cancelled doesn\'t make the next one not first; a sign-up does', async () => {
  // (on Tuesday, so it can still be cancelled online: bookings lock 24 hours before they start)
  const cancelled = await bookTable(RIA, 'Ria', { start: at('2026-11-03', 17), end: at('2026-11-03', 19) });
  ok(await update(cancelled.booking.id, { status: 'cancelled' }, RIA));
  assert.equal((await bookTable(RIA, 'Ria', { tables: ['T5'] })).track.first, true, 'the cancelled one never happened');
  const signed = await join(LEO, 'Leo');
  assert.equal(signed.track.first, true);
  assert.equal((await bookTable(LEO, 'Leo', { tables: ['T6'] })).track.first, false, 'Leo has a sign-up on');
});

test('round 28: a sign-up tells "booked" as an event: the $5 trivia night at 5, the free demo night at 0', async () => {
  const quiz = await join(MIA, 'Mia', 'quiz', { people: 2 });
  assert.deepEqual(quiz.track, { id: quiz.join.ref, kind: 'event', value: 10, currency: 'NZD', first: true });
  const demo = await join(MIA, 'Mia', 'demo');
  assert.deepEqual(demo.track, { id: demo.join.ref, kind: 'event', value: 0, currency: 'NZD', first: false });
});

test('round 28: what staff make for someone (the staff page, a walk-in) tells nothing: it isn\'t an ad\'s doing', async () => {
  const forSomeone = ok(await call('POST', 'bookings', {
    kind: 'table', tables: ['T7'], start: at(TODAY, 14), end: at(TODAY, 16), people: 1, name: 'Pat', email: 'pat@example.com', phone: '021 555 0100', pay: 'day', staffOverride: true,
  }, OWNER));
  assert.equal(forSomeone.booking.status, 'confirmed');
  assert.equal('track' in forSomeone, false);
  nowIs(at(TODAY, 14, 5));
  const walkin = ok(await call('POST', 'bookings', { kind: 'walkin', tables: ['T8'], start: at(TODAY, 14, 5), end: at(TODAY, 16), people: 1, name: 'Sam' }, OWNER));
  assert.equal('track' in walkin, false);
});

test('round 28: a TTRPG seat tells "booked" as ttrpg; without an account, first is null (nobody to know)', async () => {
  const game = await session();
  const guest = ok(await call('POST', 'bookings', { kind: 'gm-seat', gameId: game.id, people: 1, name: 'Ash', email: 'ash@example.com', phone: '021 555 0100' }, ''));
  assert.deepEqual(guest.track, track(guest, 'ttrpg', null));
  const member = ok(await call('POST', 'bookings', { kind: 'gm-seat', gameId: game.id, people: 1, name: 'Mia', email: 'mia@example.com', phone: '021 555 0100' }, MIA));
  assert.deepEqual(member.track, track(member, 'ttrpg', true));
});

test('round 28: joining a weekly game tells "booked" as weekly for the seat it saves; joining again (the seat\'s already theirs) tells nothing', async () => {
  const game = await session({ schedule: 'flexible' });
  const joined = ok(await call('POST', `games/${game.id}/join-series`, { people: 1, name: 'Mia', email: 'mia@example.com', phone: '021 555 0100' }, MIA));
  assert.equal(joined.booked.length, 1, 'tonight\'s seat');
  const seat = lair.booking(joined.booked[0].ref);
  assert.deepEqual(joined.track, { id: seat.ref, kind: 'weekly', value: seat.amount / 100, currency: 'NZD', first: true });
  const again = ok(await call('POST', `games/${game.id}/join-series`, { people: 1, name: 'Mia', email: 'mia@example.com', phone: '021 555 0100' }, MIA));
  assert.equal('track' in again, false);
});

test('round 28: a game spot at an event tells "booked" as a game spot', async () => {
  const spot = ok(await call('POST', `events/warhammer@${TODAY}/reserve`, { name: 'Leo', email: 'leo@example.com', phone: '021 555 0100', people: 2 }, LEO));
  assert.equal(spot.booking.status, 'confirmed');
  assert.deepEqual(spot.track, track(spot, 'game-spot', true));
});

test('round 28: only a confirmed booking is told: one held for online payment (its checkout\'s purchase counts) or cancelled isn\'t', () => {
  for (const status of ['held', 'cancelled', 'seated']) {
    assert.equal(lair.bookedTrack({ id: 'bk_x', ref: 'MI-OWLBEAR-1', status, amount: 1500 }, 'table', MIA), null, status);
  }
  assert.deepEqual(lair.bookedTrack({ id: 'bk_x', ref: 'MI-OWLBEAR-1', status: 'confirmed', amount: 1550 }, 'table', MIA), { id: 'MI-OWLBEAR-1', kind: 'table', value: 15.5, currency: 'NZD', first: true });
});

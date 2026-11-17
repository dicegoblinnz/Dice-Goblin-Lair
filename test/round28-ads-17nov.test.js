// "First booking" for everyone (17 Nov 2026, from the website review before more ad spend): the ads can't tell a new
// player from a regular, so `first` on a booking's answer (contract v28-booked, section 1) is worked out for a guest too,
// from the email and mobile they typed and what the Lair already knows (past bookings and sign-ups, a named place on
// someone's game, a member with that email or mobile and their visits and counter purchases). A member is matched the
// same way, so someone who booked as a guest before isn't new once they log in. The answer only ever says first: true or
// false for this booking, never anything about anyone else.
// And paid clicks keep their credit: a member's first ad tags (round 24, what the weekly numbers credit a new player to)
// give way once to a paid click, while they haven't been to the Lair yet, so an old Facebook page or Eventfinda link
// doesn't take the credit for the ad that brought them in. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { phoneKeySql } from '../src/newplayers.js';

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
  return { db, storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: () => {} };
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

/* ---------------- this file's own helpers ---------------- */

/** A TTRPG session the GM lists for tonight → the game */
async function session(more = {}) {
  return ok(await call('POST', 'games', {
    title: 'Blades at the Lair', system: 'Blades in the Dark', gm: 'Ellie', email: 'ellie@example.com', blurb: 'Heists.', seats: 6, tables: ['T12', 'T13'],
    start: at(TODAY, 18), end: at(TODAY, 21), ...more,
  }, GM)).game;
}
/** A seat at that session, as a guest ('') or a member → the whole answer */
const seat = async (game, who, name, email, phone) => ok(await call('POST', 'bookings', { kind: 'gm-seat', gameId: game.id, people: 1, name, email, phone }, who));
/** A sign-up to one of today's events → the whole answer */
const joinAs = async (who, name, email, phone, event = 'quiz') => ok(await call('POST', `events/${event}@${TODAY}/join`, { name, email, phone, people: 1 }, who));
/** A table booked online by a member → the whole answer */
const tableAs = async (who, name, email, phone, { tables = ['T3'], start = at(TODAY, 14), end = at(TODAY, 16) } = {}) => ok(await call('POST', 'bookings', {
  kind: 'table', tables, start, end, people: 1, name, email, phone, pay: 'day',
}, who));

test('first booking: a guest nobody has met is booking for the first time (first: true, no longer null)', async () => {
  const game = await session();
  const ash = await seat(game, '', 'Ash', 'ash@example.com', '021 555 0101');
  assert.equal(ash.track.first, true);
});

test('first booking: a guest whose email booked before (another mobile, any case) is not new', async () => {
  const game = await session();
  assert.equal((await seat(game, '', 'Ash', 'ash@example.com', '021 555 0101')).track.first, true);
  const later = await session({ start: at(TODAY, 19), end: at(TODAY, 21), tables: ['T14', 'T15'] });
  assert.equal((await seat(later, '', 'Ash', '  ASH@Example.com ', '027 555 0199')).track.first, false);
});

test('first booking: a guest whose mobile signed up before, typed another way and with another email, is not new', async () => {
  assert.equal((await joinAs('', 'Bo', 'bo@example.com', '021 555 0102')).track.first, true);
  const game = await session();
  assert.equal((await seat(game, '', 'Bo', 'bo.other@example.com', '+64 21-555-0102')).track.first, false);
});

test('first booking: a guest\'s own cancelled booking never happened, so the next one is still first', async () => {
  const game = await session({ start: at('2026-11-03', 18), end: at('2026-11-03', 21) });
  const gone = await seat(game, '', 'Cy', 'cy@example.com', '021 555 0103');
  lair.sql.exec("UPDATE bookings SET status = 'cancelled' WHERE id = ?", gone.booking.id);
  const tonight = await session();
  assert.equal((await seat(tonight, '', 'Cy', 'cy@example.com', '021 555 0103')).track.first, true);
});

test('first booking: a guest using a member\'s email is matched to that member: their visits and counter purchases count', async () => {
  // Kai played yesterday (checked in and paid at the counter); today he books as a guest with his email
  nowIs(at(YESTERDAY, 13));
  const kais = await tableAs(KAI, 'Kai', 'other.kai@example.com', '021 555 0104', { tables: ['T9'], start: at(YESTERDAY, 14), end: at(YESTERDAY, 16) });
  ok(await pos('checkin', { id: kais.booking.id, type: 'booking' }));
  ok(await internal('orders-paid', posOrder(7001, [bookingLine(70011, kais.booking.ref, 10)])));
  nowIs(NOW);
  const game = await session();
  assert.equal((await seat(game, '', 'Kai', 'kai@example.com', '027 555 0204')).track.first, false, 'kai@example.com is Kai\'s account email');
  // Leo has never booked online, but bought at the till last week with his account on the sale
  lair.sql.exec('INSERT INTO spend (order_id, customer_id, amount, source, created_at) VALUES (?, ?, ?, ?, ?)', 'gid://shopify/Order/88', LEO, 2500, 'pos', at('2026-10-25', 15));
  assert.equal((await seat(game, '', 'Leo', 'leo@example.com', '027 555 0205')).track.first, false, 'a counter purchase is a visit');
});

test('first booking: a guest whose mobile is on a member\'s profile is matched to that member', async () => {
  // Ria's profile has her mobile (from an earlier booking of hers that was cancelled, so it isn't a visit or a booking)
  lair.sql.exec('UPDATE members SET mobile = ? WHERE customer_id = ?', '022 555 0106', RIA);
  nowIs(at(YESTERDAY, 13));
  lair.sql.exec('INSERT INTO spend (order_id, customer_id, amount, source, created_at) VALUES (?, ?, ?, ?, ?)', 'gid://shopify/Order/89', RIA, 900, 'pos', at(YESTERDAY, 15));
  nowIs(NOW);
  const game = await session();
  assert.equal((await seat(game, '', 'R', 'r.moana@example.com', '+64 22 555 0106')).track.first, false);
});

test('first booking: someone named on another\'s game spot by email has been to the Lair, so their own booking isn\'t first', async () => {
  const spot = ok(await call('POST', `events/warhammer@${TODAY}/reserve`, {
    name: 'Leo', email: 'leo@example.com', phone: '021 555 0107', people: 2, players: [{ email: 'dee@example.com' }],
  }, LEO));
  assert.equal(spot.booking.status, 'confirmed');
  const game = await session();
  assert.equal((await seat(game, '', 'Dee', 'dee@example.com', '027 555 0207')).track.first, false);
});

test('first booking: a member who booked as a guest before (same email or mobile) isn\'t new once logged in', async () => {
  const game = await session();
  assert.equal((await seat(game, '', 'Mia', 'mia.c@example.com', '021 555 0108')).track.first, true, 'as a guest');
  // logged in, her account email is another one, but the mobile is the same
  assert.equal((await tableAs(MIA, 'Mia', 'mia@example.com', '0215550108')).track.first, false);
});

test('first booking: two strangers never make each other not new, and the answer says nothing about anyone else', async () => {
  const game = await session();
  const one = await seat(game, '', 'Eli', 'eli@example.com', '021 555 0109');
  const two = await seat(game, '', 'Fi', 'fi@example.com', '021 555 0110');
  for (const answer of [one, two]) {
    assert.equal(answer.track.first, true);
    assert.deepEqual(Object.keys(answer.track).sort(), ['currency', 'first', 'id', 'kind', 'value']);
  }
});

test('first booking: a mobile is looked up by its key through an index, on bookings, sign-ups and members', () => {
  for (const [table, column, index] of [['bookings', 'phone', 'bookings_phone_key'], ['event_joins', 'phone', 'event_joins_phone_key'], ['members', 'mobile', 'members_mobile_key']]) {
    const plan = ctx.db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE ${phoneKeySql(column)} = ?`).all('64215550100');
    assert.ok(plan.some((r) => String(r.detail).includes(index)), `${table}: ${JSON.stringify(plan)}`);
  }
});

/* ---------------- paid clicks keep their credit (round 24's ad tags) ---------------- */
const adOf = (id) => {
  const r = lair.sql.exec('SELECT ad_source, ad_medium, ad_campaign FROM members WHERE customer_id = ?', id).one();
  return r.ad_source ? `${r.ad_source}/${r.ad_medium || 'none'}/${r.ad_campaign || 'none'}` : null;
};
const meAd = async (who, ad) => ok(await call('POST', 'me/ad', ad, who)).saved;

test('paid credit: a paid click replaces an older unpaid link on a member who hasn\'t been to the Lair yet, once', async () => {
  assert.equal(await meAd(MIA, { source: 'eventfinda', medium: 'referral', campaign: 'trivia' }), true);
  assert.equal(adOf(MIA), 'eventfinda/referral/trivia');
  assert.equal(await meAd(MIA, { source: 'facebook', medium: 'social' }), false, 'unpaid never replaces unpaid');
  assert.equal(await meAd(MIA, { source: 'facebook', medium: 'paid', campaign: 'new-players' }), true, 'paid beats unpaid');
  assert.equal(adOf(MIA), 'facebook/paid/new-players');
  assert.equal(await meAd(MIA, { source: 'google', medium: 'cpc' }), false, 'the first paid click keeps it');
  assert.equal(await meAd(MIA, { source: 'eventfinda', medium: 'referral' }), false);
  assert.equal(adOf(MIA), 'facebook/paid/new-players');
});

test('paid credit: a booking carrying a paid click does the same, and the booking keeps its own tags', async () => {
  assert.equal(await meAd(RIA, { source: 'facebook', medium: 'social' }), true);
  const booked = ok(await call('POST', 'bookings', {
    kind: 'table', tables: ['T5'], start: at(TODAY, 14), end: at(TODAY, 16), people: 1, name: 'Ria', email: 'ria@example.com', phone: '021 555 0111', pay: 'day',
    ad: { source: 'tiktok', medium: 'paid', campaign: 'burst-1' },
  }, RIA));
  assert.equal(adOf(RIA), 'tiktok/paid/burst-1');
  const row = lair.sql.exec('SELECT ad_source, ad_medium FROM bookings WHERE id = ?', booked.booking.id).one();
  assert.deepEqual({ ...row }, { ad_source: 'tiktok', ad_medium: 'paid' });
});

test('paid credit: once someone has been to the Lair, how they found it is settled: a later paid click changes nothing', async () => {
  assert.equal(await meAd(KAI, { source: 'eventfinda', medium: 'referral' }), true);
  nowIs(at(YESTERDAY, 13));
  const kais = await tableAs(KAI, 'Kai', 'kai@example.com', '021 555 0112', { tables: ['T9'], start: at(YESTERDAY, 14), end: at(YESTERDAY, 16) });
  ok(await pos('checkin', { id: kais.booking.id, type: 'booking' }));
  nowIs(NOW);
  assert.equal(await meAd(KAI, { source: 'google', medium: 'cpc' }), false);
  assert.equal(adOf(KAI), 'eventfinda/referral/none');
});

test('paid credit: which mediums are paid', async () => {
  const { isPaidAd } = await import('../src/newplayers.js');
  for (const medium of ['paid', 'cpc', 'ppc', 'cpm', 'paid-social', 'paid_social', 'paidsocial', 'paid-search']) assert.equal(isPaidAd({ source: 'x', medium }), true, medium);
  for (const medium of [null, '', 'social', 'referral', 'email', 'organic', 'unpaid', 'prepaid']) assert.equal(isPaidAd({ source: 'x', medium }), false, String(medium));
  assert.equal(isPaidAd(null), false);
});

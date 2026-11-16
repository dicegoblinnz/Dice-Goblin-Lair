// Round 40: walk-ins from Google ads (contract v40-walkins). Mo (16 Nov 2026), after the first Google search campaign
// went live: "Can you set it up for me to track who actually walks in?" The website keeps the Google click an ad visitor
// came by; the Lair notes it on their account; and once they've had their first paid session at the Lair (the same rule as
// a welcome code's: they came in and paid), a password-protected list tells Google Ads that click became a First visit.
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { WALKIN, cleanClick, feedAllowed, walkinTime } from '../src/walkins.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TODAY = '2026-11-01';
const YESTERDAY = '2026-10-31';
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Sunday 1 November 2026, 1:00pm in Auckland (NZDT, UTC+13)
const NOW = at(TODAY, 13);
const realNow = Date.now;
const nowIs = (ms) => {
  Date.now = () => ms;
};
// A Google click ID as Google sends them (made up)
const GCLID = 'Cj0KCQiA4NWrBhD-ARIsAFCKwWt3mYbGzTrPq_EXAMPLE_gclid_1234567890abcdefABCDEF';
const GCLID2 = 'EAIaIQobChMI8sv7_SECOND_click_0987654321zyxwvuZYXWVU';

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
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
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


/* ---------------- the click ---------------- */

test(`a Google click ID is kept only when it looks like one, from the last 90 days, and never from the future`, () => {
  assert.deepEqual(cleanClick({ gclid: GCLID, at: NOW - HOUR }, NOW), { gclid: GCLID, at: NOW - HOUR });
  // no time, or one after now: the Lair hears it now
  assert.deepEqual(cleanClick({ gclid: GCLID }, NOW), { gclid: GCLID, at: NOW });
  assert.deepEqual(cleanClick({ gclid: GCLID, at: NOW + DAY }, NOW), { gclid: GCLID, at: NOW });
  // Google keeps a click for 90 days, so an older one is nothing
  assert.equal(cleanClick({ gclid: GCLID, at: NOW - 91 * DAY }, NOW), null);
  for (const junk of [null, undefined, GCLID, [GCLID], {}, { gclid: 'short' }, { gclid: 'has spaces in it and is long enough' }, { gclid: '<script>alert(1)</script>xxxxxxxxxx' }, { gclid: 'x'.repeat(301) }, { gclid: 12345678901234567890 }]) {
    assert.equal(cleanClick(junk, NOW), null, JSON.stringify(junk));
  }
});

const clickOf = (id) => ({ ...lair.sql.exec('SELECT click_gclid, click_at FROM members WHERE customer_id = ?', id).one() });

test(`a booking or sign-up from an ad keeps the Google click on the member: the latest click stands, an older one never replaces it`, async () => {
  await table(MIA, 'Mia', { click: { gclid: GCLID, at: NOW - 2 * HOUR } });
  assert.deepEqual(clickOf(MIA), { click_gclid: GCLID, click_at: NOW - 2 * HOUR });
  // a later click from another ad replaces it
  await signUp(MIA, 'Mia', 'quiz', { click: { gclid: GCLID2, at: NOW - HOUR } });
  assert.deepEqual(clickOf(MIA), { click_gclid: GCLID2, click_at: NOW - HOUR });
  // an older one (another browser that kept it longer) doesn't
  ok(await call('POST', 'me/click', { gclid: GCLID, at: NOW - 3 * HOUR }, MIA));
  assert.equal(clickOf(MIA).click_gclid, GCLID2);
  // junk never stops a booking and keeps nothing
  await table(RIA, 'Ria', { tables: ['T4'], click: 'nope' });
  assert.deepEqual(clickOf(RIA), { click_gclid: null, click_at: null });
  // what staff book for someone isn't from an ad
  ok(await call('POST', 'bookings', { kind: 'table', tables: ['T6'], start: at(TODAY, 14), end: at(TODAY, 16), people: 2, name: 'Leo Park', email: 'leo@example.com', staffOverride: true, customerId: LEO, click: { gclid: GCLID } }, OWNER));
  assert.equal(clickOf(LEO).click_gclid, null);
  assert.equal(clickOf(OWNER).click_gclid, null);
});

test(`POST /me/click: their own click once they're logged in and the Lair knows them; nobody else's`, async () => {
  assert.deepEqual(ok(await call('POST', 'me/click', { gclid: GCLID, at: NOW - HOUR }, KAI)), { saved: true });
  assert.deepEqual(clickOf(KAI), { click_gclid: GCLID, click_at: NOW - HOUR });
  assert.deepEqual(ok(await call('POST', 'me/click', { gclid: 'bad' }, KAI)), { saved: false });
  assert.equal((await call('POST', 'me/click', { gclid: GCLID })).status, 401);
  // someone the Lair hasn't met yet: no member record made here (their member code comes from their name, as /me/ad)
  assert.equal((await call('POST', 'me/click', { gclid: GCLID }, '6099')).status, 404);
  assert.equal(lair.memberRow('6099'), null);
});

/* ---------------- the list Google Ads reads ---------------- */

const feed = async () => {
  const response = await lair.fetch(new Request('https://lair.test/internal/walkins', { headers: { 'X-Lair-Internal': '1' } }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /^text\/csv/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  return (await response.text()).trim().split('\n');
};
const HEADER = ['Google Click ID,Conversion Name,Conversion Time,Order ID'];

test(`the list: a new player from a Google ad shows up once they've come in and paid for their first session, and not before`, async () => {
  nowIs(at(TODAY, 11));
  const mias = await table(MIA, 'Mia', { click: { gclid: GCLID, at: at(TODAY, 10, 30) } });
  // booked, not here yet: not a walk-in
  assert.deepEqual(await feed(), HEADER);
  nowIs(at(TODAY, 14, 5));
  ok(await pos('checkin', { id: mias.id, type: 'booking' }));
  // here but not paid: still not counted (the welcome code's rule: they came and paid)
  assert.deepEqual(await feed(), HEADER);
  ok(await internal('orders-paid', posOrder(7101, [bookingLine(71011, mias.ref, 10)])));
  assert.deepEqual(await feed(), [...HEADER, `${GCLID},First visit,2026-11-01T14:00:00+13:00,fv-${mias.id}`]);
  // the same row every day after, so Google counts it once
  nowIs(at(TODAY, 20));
  assert.deepEqual(await feed(), [...HEADER, `${GCLID},First visit,2026-11-01T14:00:00+13:00,fv-${mias.id}`]);
});

test(`the list: someone who'd played at the Lair before the click isn't a new player`, async () => {
  // Kai played yesterday, then clicked an ad today and came back
  nowIs(at(YESTERDAY, 13));
  const kais = await table(KAI, 'Kai', { tables: ['T9'], start: at(YESTERDAY, 14), end: at(YESTERDAY, 16) });
  ok(await pos('checkin', { id: kais.id, type: 'booking' }));
  ok(await internal('orders-paid', posOrder(7201, [bookingLine(72011, kais.ref, 10)])));
  nowIs(at(TODAY, 11));
  const again = await table(KAI, 'Kai', { tables: ['T8'], click: { gclid: GCLID, at: at(TODAY, 10) } });
  nowIs(at(TODAY, 14, 5));
  ok(await pos('checkin', { id: again.id, type: 'booking' }));
  ok(await internal('orders-paid', posOrder(7202, [bookingLine(72021, again.ref, 10)])));
  assert.deepEqual(await feed(), HEADER);
});

test(`the list: a click more than 90 days before the visit, or a visit more than 60 days ago, is left off (Google keeps a click 90 days)`, async () => {
  nowIs(at(TODAY, 11));
  const mias = await table(MIA, 'Mia', { click: { gclid: GCLID, at: at(TODAY, 10) } });
  nowIs(at(TODAY, 14, 5));
  ok(await pos('checkin', { id: mias.id, type: 'booking' }));
  ok(await internal('orders-paid', posOrder(7301, [bookingLine(73011, mias.ref, 10)])));
  assert.equal((await feed()).length, 2);
  nowIs(at(TODAY, 14) + 61 * DAY);
  assert.deepEqual(await feed(), HEADER);
});

test(`conversion times are Auckland time with its offset, across the daylight saving change (Data Manager reads the first line as the column names, so there's no time zone line)`, () => {
  // 5 April 2026 3am NZDT is 2am NZST: 1pm on 4 April and 1pm on 6 April
  assert.equal(walkinTime(Date.UTC(2026, 3, 4, 0, 0, 0)), '2026-04-04T13:00:00+13:00');
  assert.equal(walkinTime(Date.UTC(2026, 3, 6, 1, 0, 0)), '2026-04-06T13:00:00+12:00');
  assert.equal(WALKIN.name, 'First visit');
});

/* ---------------- who may read the list ---------------- */

test(`only Google Ads, with the list's password, reads it: by its username and password, or its key in the address; no password set means no list`, () => {
  const KEY = 'k'.repeat(40);
  const basic = (user, pass) => new Request('https://lair.test/ads/walkins.csv', { headers: { Authorization: `Basic ${btoa(`${user}:${pass}`)}` } });
  assert.equal(feedAllowed(basic('google', KEY), KEY), true);
  assert.equal(feedAllowed(new Request(`https://lair.test/ads/walkins.csv?key=${KEY}`), KEY), true);
  assert.equal(feedAllowed(basic('google', 'wrong'), KEY), false);
  assert.equal(feedAllowed(basic('someone', KEY), KEY), false, 'the username is google');
  assert.equal(feedAllowed(new Request('https://lair.test/ads/walkins.csv'), KEY), false);
  assert.equal(feedAllowed(new Request(`https://lair.test/ads/walkins.csv?key=${KEY}`), ''), false, 'no password set: nobody');
  assert.equal(feedAllowed(new Request('https://lair.test/ads/walkins.csv?key=short'), 'short'), false, 'a password under 24 characters is never accepted');
});

test(`from the review: the list's password is read from the config database, where it's kept`, async () => {
  const { withConfig } = await import('../src/config.js');
  const KEY = 'p'.repeat(40);
  const CONFIG = { prepare: () => ({ all: async () => ({ results: [{ key: 'ADS_FEED_KEY', value: KEY }] }) }) };
  // past the minute the config is cached for (the Lair read it, empty, as these checks started)
  nowIs(NOW + 400 * DAY);
  const env = await withConfig({ CONFIG });
  assert.equal(env.ADS_FEED_KEY, KEY);
  assert.equal(feedAllowed(new Request('https://lair.test/ads/walkins.csv', { headers: { Authorization: `Basic ${btoa(`google:${KEY}`)}` } }), env.ADS_FEED_KEY), true);
});

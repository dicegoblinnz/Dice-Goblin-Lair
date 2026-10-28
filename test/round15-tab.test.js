// Round 15, everything on the tab (Mo, 12 Oct 2026): "Don't create a new QR code to pay make it live inside each
// person's tab ... signing up to a game adds it to your tab and if you don't cancel within 24 hours of the game it is on
// your account and cannot be removed ... require staff to remove items from tabs ... Including table booking etc."
// What's booked or signed up for from round 15's first start (lockFrom) can be cancelled online until 24 hours before;
// after that it stays on the tab (staff can still take it off), and once it's over unpaid it's owed, whether or not they
// came. Nothing goes to checkout any more. Run with: npm test   (under TZ=UTC and TZ=Pacific/Auckland)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, cancelUntil, TAB_WORDS } from '../src/core.js';
import { TAB_MESSAGES } from '../src/tab.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const MIN = 60_000;
// Thursday 1 October 2026, 1:00pm in Auckland (NZDT, UTC+13), as in lair.test.js
const NOW = Date.UTC(2026, 9, 1, 0, 0);
const realNow = Date.now;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);

/* ---------------- helpers, as in lair.test.js ---------------- */
function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      // as SQLite in a Durable Object: at most 100 bound values a query (27 Oct 2026) and 5 terms in a compound SELECT
      // (29 Oct 2026), Cloudflare's limits (test/cloudflare-sql.js)
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

const ROOMS = [
  { id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 },
  { id: 'side-room-1', name: 'Side room 1', code: 'A', tables: 4, seats: 4, order: 2 },
  { id: 'side-room-2', name: 'Side room 2', code: 'B', tables: 4, seats: 4, order: 3 },
];
const TEST_HOURS = 'Mon closed\nTue 12:00-22:00\nWed 12:00-22:00\nThu 12:00-22:00\nFri 12:00-23:00\nSat 10:00-23:00\nSun 10:00-20:00';
const EVENTS = [
  // Friday: trivia at $5 a person (20 places), a free paint night, and Warhammer game tables at $10 a person
  { id: 'quiz', title: 'Trivia night', start: at('2026-10-02', 18), end: at('2026-10-02', 20), tables: '', capacity: 20, entryFee: 500 },
  { id: 'paint', title: 'Paint night', start: at('2026-10-02', 19), end: at('2026-10-02', 21), tables: '', capacity: 10 },
  { id: 'wh', title: 'Warhammer night', start: at('2026-10-02', 18), end: at('2026-10-02', 22), tables: '', gameTables: 'T14+T15, T16+T17, T18+T19', entryFee: 1000 },
  // The weekend: a championship round 4 sold online only, and a league people could pay online or in store
  { id: 'champs', title: 'Riftbound championship', start: at('2026-10-03', 11), end: at('2026-10-03', 17), tables: '', capacity: 32, entryFee: 2500, gameTables: 'T5+T6, T7+T8', payment: 'online' },
  { id: 'league', title: 'Pokémon league', start: at('2026-10-04', 12), end: at('2026-10-04', 16), tables: '', capacity: 16, entryFee: 1500, gameTables: 'T9+T10', payment: 'either' },
];
const QUIZ = 'quiz@2026-10-02';
const PAINT = 'paint@2026-10-02';
const WH = 'wh@2026-10-02';
const SAM = '1001';
const KIRI = '1002';
const MIA = 'mia';
const LEO = 'leo';
// Helpers on the staff page (round 9), each with just the one permission; 'staff' is the main account
const HELPERS = { 'helper-desk': ['checkin'], 'helper-tables': ['tables'], 'helper-events': ['events'], 'helper-money': ['money'] };

let lair;
// Round 7: customer bookings need a mobile, so the helper adds one when a test sends none (as lair.test.js)
const MOBILE_ROUTES = /^(?:bookings|games\/[^/]+\/join-series|events\/[^/]+\/(?:join|reserve))$/;
async function call(method, path, body, customer = '', extraHeaders = {}) {
  const sent = method === 'POST' && body && MOBILE_ROUTES.test(path) && !('phone' in body) ? { ...body, phone: '021 555 0100' } : body;
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders },
      body: sent ? JSON.stringify(sent) : undefined,
    }),
  );
  return { status: response.status, data: await response.json() };
}
const internal = (path, body) => call('POST', `internal/${path}`, body, '', { 'X-Lair-Internal': '1' });
const pos = (path, body) => internal(`pos/${path}`, body);
const me = async (who) => (await call('GET', 'me', null, who)).data;
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const LOCKED = `409 ${TAB_WORDS.locked(24)}`;
const NOT_YOURS = "403 That's not one of your staff permissions. Ask the main account to tick it on the Team tab.";

/** Sam's table for 4 ($40), Saturday 3 October 3pm to 5pm unless said */
const table = (over = {}) => ({
  kind: 'table', tables: ['T3'], start: at('2026-10-03', 15), end: at('2026-10-03', 17), people: 4, name: 'Sam Jones', email: 'sam@example.com', ...over,
});
const book = (over = {}, who = SAM) => call('POST', 'bookings', table(over), who);
const signUp = (id, body = {}, who = SAM) => call('POST', `events/${id}/join`, { name: 'Sam Jones', email: 'sam@example.com', people: 2, ...body }, who);
const reserve = (id, body = {}, who = SAM) => call('POST', `events/${id}/reserve`, { name: 'Sam Jones', email: 'sam@example.com', people: 2, ...body }, who);
const cancelBooking = (id, who) => call('POST', `bookings/${id}/update`, { status: 'cancelled' }, who);
const cancelJoin = (id, who) => call('POST', `events/joins/${id}/cancel`, {}, who);
/** A one-off TTRPG game the GM lists, Friday 2 October 6pm to 9pm ($15 a seat) */
const oneShot = async (over = {}) => (await call('POST', 'games', {
  title: 'Tomb of Horrors', system: 'D&D 5e', gm: 'Ana', email: 'ana@example.com', blurb: 'Traps.', seats: 4, tables: ['A1'], start: at('2026-10-02', 18), end: at('2026-10-02', 21), ...over,
}, 'gm')).data.game;
const seat = (gameId, name, who) => call('POST', 'bookings', { kind: 'gm-seat', gameId, people: 1, name, email: `${name.toLowerCase()}@example.com` }, who);
const posOrder = (n, lines) => ({
  id: n, admin_graphql_api_id: `gid://shopify/Order/${n}`, source_name: 'pos',
  line_items: lines.map((l, i) => ({ id: n * 10 + i, quantity: 1, price: l.price, properties: Object.entries(l.properties).map(([name, value]) => ({ name, value })) })),
});

/** Turn on emails and catch everything sent to Resend (single and batch). Call restore() when done. */
function captureEmails() {
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test' };
  const sent = [];
  const before = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return { sent, restore: () => { globalThis.fetch = before; } };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

/** Shopify connected (orders/paid needs it), with nothing reaching out to it: no account email to look up */
function connectShopify() {
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  lair.shopify.customerEmail = async () => null;
}

// No network in these tests: anything that reaches for it (other than captureEmails' stand-in for Resend) is noted, and
// the test fails
const realFetch = globalThis.fetch;
let reached = [];

beforeEach(() => {
  reached = [];
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  lair.person = async (id) => (HELPERS[id]
    ? { customerId: id, staff: true, role: 'helper', perms: HELPERS[id], gm: false }
    : { customerId: id || null, staff: id === 'staff', gm: id === 'gm' });
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, ROOMS, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

/* ---------------- the words and the cutover ---------------- */

test('round 15: the tab\'s words, word for word; cancelUntil is the start less the theme\'s refund hours (24)', () => {
  assert.equal(TAB_WORDS.locked(24), "It's less than 24 hours away, so it can't be cancelled online now: it stays on your tab. Have a chat with us at the counter or give us a call, and we'll sort it out.");
  assert.equal(TAB_WORDS.keptSeat('Friday, 2 October at 6:00 pm to 9:00 pm', 24), "Your seat on Friday, 2 October at 6:00 pm to 9:00 pm is less than 24 hours away, so it stays on your tab. Have a chat with us if you can't make it.");
  assert.equal(TAB_WORDS.onTab, 'It goes on your tab: pay at the counter on the day, or pay for a few at once. Just give your name at the counter (or show your Goblin card from My Lair).');
  assert.equal(TAB_WORDS.onTabGuest, 'Pay at the counter on the day: just give your name. Make a free Dice Goblin account with this email and it goes on your tab in My Lair.');
  assert.equal(TAB_WORDS.nothingToPay, 'Nothing to pay. Just give your name at the counter when you arrive.');
  assert.equal(TAB_WORDS.cancelBy('Friday, 2 October at 3:00 pm', 24), "Can't make it? Cancel in My Lair by Friday, 2 October at 3:00 pm (24 hours before). After that it stays on your tab, even if you can't come.");
  assert.equal(TAB_WORDS.cancelByGuest('Friday, 2 October at 3:00 pm', 24), "Can't make it? Let us know by Friday, 2 October at 3:00 pm (24 hours before): reply to this email or give us a call. After that it's yours to pay, even if you can't come.");
  assert.equal(TAB_WORDS.lockedNow(24), "It's less than 24 hours away, so it's locked in: it stays on your tab, even if you can't come. Have a chat with us if something comes up.");
  assert.deepEqual([TAB_MESSAGES.pickSome, TAB_MESSAGES.notTheirs, TAB_MESSAGES.nothingDue], [
    "Tick what they're paying for.", "One of those isn't on their tab any more. Refresh their page and try again.", 'Nothing is left to pay on what you ticked.',
  ]);
  const start = at('2026-10-03', 15);
  assert.equal(cancelUntil({ start }, lair.rulesCache), at('2026-10-02', 15));
  assert.equal(cancelUntil({ start }, rulesFromSettings({ lair_refund_hours: 6 }, ROOMS, [])), at('2026-10-03', 9));
  assert.equal(cancelUntil({ start }, {}), at('2026-10-02', 15), '24 when the theme says nothing');
});

test('round 15: the cutover (lockFrom) is the first start, kept through later starts, and sign-ups get their waived column once', () => {
  const ctx = fakeCtx();
  const first = new Lair(ctx, { CURRENCY: 'NZD' });
  assert.equal(first.lockFrom, NOW);
  assert.ok(first.sql.exec("SELECT name FROM pragma_table_info('event_joins')").toArray().some((c) => c.name === 'waived'), 'event_joins has waived');
  // The next start (a deploy, an eviction) an hour later keeps the first cutover, and finds the column there already
  Date.now = () => NOW + HOUR;
  const again = new Lair(ctx, { CURRENCY: 'NZD' });
  assert.equal(again.lockFrom, NOW);
  assert.equal(Number(again.sql.exec("SELECT value FROM meta WHERE key = 'lock-from'").one().value), NOW);
  assert.equal(again.sql.exec("SELECT name FROM pragma_table_info('event_joins')").toArray().filter((c) => c.name === 'waived').length, 1);
});

/* ---------------- cancelling: online until 24 hours before, then staff only ---------------- */

test('round 15: a table booking can be cancelled online until 24 hours before; after that it stays on the tab, and only staff take it off', async () => {
  // Saturday 3pm: cancelled online until Friday 3pm
  const sam = (await book()).data.booking;
  const kiri = (await book({ tables: ['T4'], name: 'Kiri Smith', email: 'kiri@example.com' }, KIRI)).data.booking;
  assert.deepEqual([sam.cancelUntil, sam.locked, kiri.cancelUntil, kiri.locked], [at('2026-10-02', 15), false, at('2026-10-02', 15), false]);
  // A minute before: fine
  Date.now = () => at('2026-10-02', 14, 59);
  const early = await cancelBooking(sam.id, SAM);
  assert.deepEqual([early.status, early.data.booking.status, early.data.booking.cancelUntil, early.data.booking.locked], [200, 'cancelled', null, false]);
  // 24 hours before on the dot, and any time after: locked, and nothing changes
  for (const when of [at('2026-10-02', 15), at('2026-10-03', 14, 59)]) {
    Date.now = () => when;
    assert.equal(said(await cancelBooking(kiri.id, KIRI)), LOCKED);
  }
  assert.equal(lair.booking(kiri.id).status, 'confirmed');
  // Staff still can: the main account, or a helper with Tables or Check-in (not one with Events only)
  assert.equal(said(await cancelBooking(kiri.id, 'helper-events')), NOT_YOURS);
  const byHelper = await cancelBooking(kiri.id, 'helper-tables');
  assert.deepEqual([byHelper.status, byHelper.data.booking.status], [200, 'cancelled']);
  // Once it has started it's staff only, as before
  const later = (await book({ tables: ['T6'], start: at('2026-10-03', 18), end: at('2026-10-03', 19) })).data.booking;
  Date.now = () => at('2026-10-03', 18, 30);
  assert.equal(said(await cancelBooking(later.id, SAM)), '403 Only staff can change that booking.');
  assert.equal((await cancelBooking(later.id, 'staff')).data.booking.status, 'cancelled');
});

test('round 15: something booked inside the 24 hours is locked at once (the booking page says so before it\'s booked)', async () => {
  // Today at 3pm, booked at 1pm
  const today = await book({ start: at('2026-10-01', 15), end: at('2026-10-01', 17) });
  assert.equal(today.status, 200, today.data.error);
  assert.deepEqual([today.data.booking.cancelUntil, today.data.booking.locked], [at('2026-09-30', 15), true]);
  assert.equal(said(await cancelBooking(today.data.booking.id, SAM)), LOCKED);
  // A seat at tonight's game, the same
  const game = await oneShot({ title: 'Tonight', tables: ['A2'], start: at('2026-10-01', 18), end: at('2026-10-01', 21) });
  const mine = (await seat(game.id, 'Mia', MIA)).data.booking;
  assert.equal(mine.locked, true);
  assert.equal(said(await cancelBooking(mine.id, MIA)), LOCKED);
  // Friday evening's sign-up and game table, booked at 7pm on Thursday
  Date.now = () => at('2026-10-01', 19);
  const join = (await signUp(QUIZ)).data.join;
  assert.deepEqual([join.cancelUntil, join.locked], [at('2026-10-01', 18), true]);
  assert.equal(said(await cancelJoin(join.id, SAM)), LOCKED);
  const spot = (await reserve(WH)).data.booking;
  assert.deepEqual([spot.cancelUntil, spot.locked], [at('2026-10-01', 18), true]);
  assert.equal(said(await cancelBooking(spot.id, SAM)), LOCKED);
  // Staff take them off
  assert.equal((await cancelJoin(join.id, 'helper-events')).data.join.status, 'cancelled');
  assert.equal((await cancelBooking(spot.id, 'helper-desk')).data.booking.status, 'cancelled');
});

test('round 15: a seat at a one-off TTRPG game: cancelled online until 24 hours before, then locked (the GM hears only about the one dropped); staff can still cancel', async () => {
  const game = await oneShot();
  const mia = (await seat(game.id, 'Mia', MIA)).data.booking;
  const leo = (await seat(game.id, 'Leo', LEO)).data.booking;
  assert.deepEqual([mia.cancelUntil, mia.locked], [at('2026-10-01', 18), false]);
  const mail = captureEmails();
  try {
    Date.now = () => at('2026-10-01', 17, 59);
    assert.equal((await cancelBooking(mia.id, MIA)).data.booking.status, 'cancelled');
    Date.now = () => at('2026-10-01', 18);
    assert.equal(said(await cancelBooking(leo.id, LEO)), LOCKED);
    await settle();
    assert.equal(mail.sent.filter((m) => /Seat dropped/.test(m.subject)).length, 1, "the GM hears about Mia's, not the refused one");
    assert.equal(lair.booking(leo.id).status, 'confirmed');
    const byStaff = await cancelBooking(leo.id, 'staff');
    assert.deepEqual([byStaff.status, byStaff.data.booking.status], [200, 'cancelled']);
  } finally {
    mail.restore();
  }
});

test('round 15: an event sign-up and an event game table: cancelled online until 24 hours before, then locked; staff can still cancel', async () => {
  const samJoin = (await signUp(QUIZ)).data.join;
  const kiriJoin = (await signUp(QUIZ, { name: 'Kiri Smith', email: 'kiri@example.com', people: 1 }, KIRI)).data.join;
  const samSpot = (await reserve(WH)).data.booking;
  const kiriSpot = (await reserve(WH, { name: 'Kiri Smith', email: 'kiri@example.com' }, KIRI)).data.booking;
  assert.deepEqual([samJoin.amount, samJoin.cancelUntil, samJoin.locked], [1000, at('2026-10-01', 18), false]);
  assert.deepEqual([samSpot.amount, samSpot.occurrenceId, samSpot.cancelUntil, samSpot.locked], [2000, WH, at('2026-10-01', 18), false]);
  // A minute before the 24 hours: Sam cancels both himself
  Date.now = () => at('2026-10-01', 17, 59);
  assert.equal((await cancelJoin(samJoin.id, SAM)).data.join.status, 'cancelled');
  assert.equal((await cancelBooking(samSpot.id, SAM)).data.booking.status, 'cancelled');
  // From 24 hours before, Kiri can't: both stay on her tab
  Date.now = () => at('2026-10-01', 18);
  assert.equal(said(await cancelJoin(kiriJoin.id, KIRI)), LOCKED);
  assert.equal(said(await cancelBooking(kiriSpot.id, KIRI)), LOCKED);
  assert.deepEqual([lair.joinById(kiriJoin.id).status, lair.booking(kiriSpot.id).status], ['confirmed', 'confirmed']);
  const mine = await me(KIRI);
  assert.deepEqual([mine.joins[0].locked, mine.bookings[0].locked], [true, true]);
  // Staff take them off: a sign-up needs Check-in or Events, a game table Check-in or Tables
  assert.equal(said(await cancelJoin(kiriJoin.id, 'helper-tables')), NOT_YOURS);
  assert.equal((await cancelJoin(kiriJoin.id, 'helper-events')).data.join.status, 'cancelled');
  assert.equal(said(await cancelBooking(kiriSpot.id, 'helper-events')), NOT_YOURS);
  assert.equal((await cancelBooking(kiriSpot.id, 'helper-desk')).data.booking.status, 'cancelled');
  assert.deepEqual((await call('GET', 'floor')).data.eventSpots[WH], { total: 3, taken: 0 });
});

test('round 15: what isn\'t locked can be cancelled online until it starts: a free sign-up, and anything booked before round 15', async () => {
  // A free sign-up has nothing to go on the tab
  const free = (await signUp(PAINT)).data.join;
  assert.deepEqual([free.amount, free.cancelUntil, free.locked], [0, at('2026-10-02', 19), false]);
  Date.now = () => at('2026-10-02', 18, 59);
  assert.deepEqual((await me(SAM)).joins.map((j) => [j.id, j.cancelUntil, j.locked]), [[free.id, at('2026-10-02', 19), false]]);
  assert.equal((await cancelJoin(free.id, SAM)).data.join.status, 'cancelled');

  // Booked before round 15's first start (lockFrom): the rules they were booked under, cancelled online until they start
  Date.now = () => NOW;
  lair.lockFrom = NOW + HOUR;
  const oldTable = (await book({ start: at('2026-10-02', 15), end: at('2026-10-02', 17) })).data.booking;
  const oldJoin = (await signUp(QUIZ)).data.join;
  const oldSeat = (await seat((await oneShot()).id, 'Mia', MIA)).data.booking;
  assert.deepEqual([oldTable.cancelUntil, oldTable.locked, oldJoin.cancelUntil, oldSeat.cancelUntil], [at('2026-10-02', 15), false, at('2026-10-02', 18), at('2026-10-02', 18)]);
  // ... while Kiri's, booked once round 15 is on, is locked 24 hours before
  Date.now = () => NOW + HOUR;
  const newTable = (await book({ tables: ['T4'], start: at('2026-10-02', 15), end: at('2026-10-02', 17), name: 'Kiri Smith', email: 'kiri@example.com' }, KIRI)).data.booking;
  assert.equal(newTable.cancelUntil, at('2026-10-01', 15));
  Date.now = () => at('2026-10-02', 14);
  assert.equal(said(await cancelBooking(newTable.id, KIRI)), LOCKED);
  assert.equal((await cancelBooking(oldTable.id, SAM)).data.booking.status, 'cancelled');
  Date.now = () => at('2026-10-02', 17, 30);
  assert.equal((await cancelJoin(oldJoin.id, SAM)).data.join.status, 'cancelled');
  assert.equal((await cancelBooking(oldSeat.id, MIA)).data.booking.status, 'cancelled');
});

test('round 15: a weekly regular\'s seat Gobgob saved inside the 24 hours (a session the GM added late) can be cancelled until it starts; one saved earlier is locked', async () => {
  const listed = await call('POST', 'games', {
    title: 'Flexible Blades', system: 'Blades in the Dark', gm: 'Ellie', email: 'ellie@example.com', blurb: 'Heists.', seats: 4, tables: ['B1'],
    start: at('2026-10-02', 18), end: at('2026-10-02', 21), schedule: 'flexible',
  }, 'gm');
  const first = listed.data.game;
  const joined = await call('POST', `games/${first.id}/join-series`, { people: 1, name: 'Mia', email: 'mia@example.com' }, MIA);
  assert.equal(joined.status, 200, joined.data.error);
  // Friday's seat was saved 29 hours ahead: locked from Thursday 6pm, like anything else
  const firstSeat = lair.booking(joined.data.booked[0].ref);
  assert.deepEqual((await me(MIA)).seats.map((s) => [s.id, s.cancelUntil, s.locked]), [[firstSeat.id, at('2026-10-01', 18), false]]);
  Date.now = () => at('2026-10-02', 12);
  assert.equal(said(await cancelBooking(firstSeat.id, MIA)), LOCKED);
  // Friday's session is over at 9pm; at 9:30 the GM adds Saturday's, which is the next one, so Gobgob saves Mia's seat
  // there and then, less than 24 hours before it. That wasn't her choice, so she can cancel it until it starts.
  Date.now = () => at('2026-10-02', 21, 30);
  const mail = captureEmails();
  try {
    const added = await call('POST', `games/${first.id}/sessions`, { start: at('2026-10-03', 18), end: at('2026-10-03', 21) }, 'gm');
    assert.equal(added.status, 200, added.data.error);
    const late = lair.gameBookings(added.data.game.id).find((b) => b.customerId === MIA);
    assert.equal(late.seriesId, first.seriesId);
    await settle();
    const told = mail.sent.find((m) => m.to === 'mia@example.com');
    assert.match(told.subject, /^New session: Flexible Blades/);
    assert.ok(told.text.includes(TAB_WORDS.onTab), told.text);
    assert.ok(told.text.includes("Can't make it? Cancel in My Lair, so someone else can have your seat."), told.text);
    assert.ok(!told.text.includes('(24 hours before)'), 'no cancel-by time for a seat saved this late');
    const view = (await me(MIA)).seats.find((s) => s.id === late.id);
    assert.deepEqual([view.cancelUntil, view.locked], [at('2026-10-03', 18), false]);
    Date.now = () => at('2026-10-03', 17, 30);
    assert.equal((await cancelBooking(late.id, MIA)).data.booking.status, 'cancelled');
  } finally {
    mail.restore();
  }
});

/* ---------------- leaving a weekly game ---------------- */

test('round 15: leaving a weekly game keeps the seat that\'s locked (on the tab, with a notice; the GM is told) and frees the later ones; staff stopping a regular free them all', async () => {
  const listed = await call('POST', 'games', {
    title: 'Weekly Mothership', system: 'Mothership', gm: 'Ellie', email: 'ellie@example.com', blurb: 'Space horror.', seats: 4, tables: ['A1'],
    start: at('2026-10-02', 18), end: at('2026-10-02', 21), schedule: 'weekly',
  }, 'gm');
  const { sessions } = listed.data;
  const seriesId = listed.data.game.seriesId;
  // Mia and Kai are regulars with Friday's seat (saved 29 hours ahead), and staff saved them the week after's too
  for (const [who, name] of [[MIA, 'Mia'], ['kai', 'Kai']]) {
    const joined = await call('POST', `games/${sessions[0].id}/join-series`, { people: 1, name, email: `${who}@example.com` }, who);
    assert.equal(joined.status, 200, joined.data.error);
    const added = await call('POST', `games/${sessions[1].id}/players`, { customerId: who, name, email: `${who}@example.com`, people: 1, weekly: true }, 'staff');
    assert.equal(added.status, 200, added.data.error);
  }
  const seatOf = (who, i) => lair.gameBookings(sessions[i].id).find((b) => b.customerId === who && b.kind === 'gm-seat');
  assert.deepEqual([seatOf(MIA, 0).seriesId, seatOf(MIA, 1).seriesId], [seriesId, seriesId]);
  const next = seatOf(MIA, 1);
  // Thursday 7pm: Friday's seat is 23 hours away, so it's locked; the next week's isn't
  Date.now = () => at('2026-10-01', 19);
  const mail = captureEmails();
  try {
    const left = await call('POST', `series/${seriesId}/leave`, {}, MIA);
    assert.equal(left.status, 200, left.data.error);
    const kept = seatOf(MIA, 0);
    const when = lair.when(kept, lair.rulesCache);
    assert.deepEqual(left.data, {
      ok: true, cancelled: 1, kept: [{ id: kept.id, ref: kept.ref, start: at('2026-10-02', 18), end: at('2026-10-02', 21) }], notice: TAB_WORDS.keptSeat(when, 24),
    });
    assert.deepEqual([lair.booking(kept.id).status, lair.booking(next.id).status], ['confirmed', 'cancelled']);
    // She's not a regular any more; the seat she kept is on her tab, locked
    const mine = await me(MIA);
    assert.deepEqual(mine.series, []);
    assert.deepEqual(mine.seats.filter((s) => s.status === 'confirmed').map((s) => [s.id, s.locked]), [[kept.id, true]]);
    assert.deepEqual(mine.account.comingUp.items.map((i) => [i.id, i.amount, i.locked]), [[kept.id, 1500, true]]);
    await settle();
    const gm = mail.sent.filter((m) => m.to === 'ellie@example.com');
    assert.equal(gm.length, 1);
    assert.match(gm[0].text, /Mia has stopped coming to every session of Weekly Mothership\./);
    assert.ok(gm[0].text.includes(`Their seat after that is free again. Their seat on ${when} stays theirs: it's less than 24 hours away.`), gm[0].text);
    assert.match(gm[0].text, new RegExp(`Sessions freed: +${lair.when(next, lair.rulesCache)}\\n`));
    assert.match(gm[0].text, new RegExp(`Seat kept: +${when}\\n`));
    // Staff stopping a regular free every seat they have, the locked one too, and keep nothing
    const stopped = await call('POST', `series/${seriesId}/leave`, { customerId: 'kai' }, 'staff');
    assert.deepEqual([stopped.status, stopped.data.cancelled, stopped.data.kept, stopped.data.notice], [200, 2, [], undefined]);
    assert.deepEqual([seatOf('kai', 0).status, seatOf('kai', 1).status], ['cancelled', 'cancelled']);
  } finally {
    mail.restore();
  }
});

/* ---------------- owed: over and unpaid, whether or not they came ---------------- */

test('round 15: a table booked from round 15 on that ends unpaid is owed, no-show or not: My Lair, the POS and the staff card list it once; waived it isn\'t; a POS order with its line pays it', async () => {
  connectShopify();
  // Sam's table today at 3pm; he doesn't come
  const booked = (await book({ tables: ['T5'], start: at('2026-10-01', 15), end: at('2026-10-01', 17) })).data.booking;
  const code = lair.memberRow(SAM).code;
  assert.equal((await me(SAM)).bookings[0].owed, false, 'not before it is over');
  Date.now = () => at('2026-10-01', 17, 30);
  const mine = await me(SAM);
  assert.deepEqual([mine.bookings[0].owed, mine.bookings[0].due, mine.bookings[0].cancelUntil, mine.bookings[0].locked], [true, 4000, null, false]);
  assert.deepEqual(mine.dueNow, [{ id: booked.id, type: 'booking', ref: booked.ref, title: 'Table T5', start: at('2026-10-01', 15), end: at('2026-10-01', 17), amount: 4000, covered: 0, paidAmount: 0, due: 4000, owed: true }]);
  assert.deepEqual(mine.account.owed.items.map((i) => [i.type, i.ref, i.amount, i.status, i.settle, i.owedRow]), [['booking', booked.ref, 4000, 'owed', 'day', true]]);
  assert.equal(mine.account.owed.total, 4000);
  // The POS: an owed row with its line (not among today's rows, though it was today), never checked in
  const line = { title: `Owed: Table T5 (Thu 1 Oct, ${booked.ref})`, price: '40.00', quantity: 1, taxable: true, properties: { _booking: booked.ref } };
  const scan = (await pos('scan', { code })).data;
  assert.deepEqual(scan.rows.map((r) => [r.id, r.owed]), [[booked.id, true]]);
  assert.deepEqual(scan.rows[0].line, line);
  const counter = (await pos('checkin-member', { customerId: SAM })).data;
  assert.deepEqual([counter.rows.map((r) => [r.id, r.owed]), counter.lines], [[[booked.id, true]], [line]]);
  assert.deepEqual([lair.booking(booked.id).status, lair.booking(booked.id).arrivedAt], ['confirmed', null]);
  // The staff page's card, the next day: an owed row, and the message says what they owe
  Date.now = () => at('2026-10-02', 13);
  const card = (await call('POST', 'checkin', { code }, 'staff')).data;
  assert.deepEqual([card.rows.map((r) => [r.id, r.owed]), card.due], [[[booked.id, true]], 4000]);
  assert.match(card.message, /^Sam Jones has nothing booked today\. They owe \$40 from 1 earlier session\.$/);
  // Waived (it needs Money): nothing due and not owed; put back, it's owed again
  assert.equal(said(await call('POST', `bookings/${booked.id}/update`, { waived: true }, 'helper-desk')), NOT_YOURS);
  assert.equal(said(await call('POST', `bookings/${booked.id}/update`, { waived: true }, SAM)), '403 Only staff can change that booking.');
  const waived = await call('POST', `bookings/${booked.id}/update`, { waived: true }, 'helper-money');
  assert.deepEqual([waived.status, waived.data.booking.waived, waived.data.booking.due, waived.data.booking.owed], [200, true, 0, false]);
  assert.deepEqual([(await me(SAM)).dueNow, (await pos('scan', { code })).data.rows, (await me(SAM)).account.owed.items], [[], [], []]);
  await call('POST', `bookings/${booked.id}/update`, { waived: false }, 'staff');
  assert.deepEqual((await me(SAM)).dueNow.map((d) => [d.id, d.owed]), [[booked.id, true]]);
  // Paid at the counter: a POS order with its _booking line
  const paid = await internal('orders-paid', posOrder(1501, [line]));
  assert.deepEqual(paid.data.updated, [booked.ref]);
  assert.deepEqual([lair.booking(booked.id).paid, lair.isOwed(lair.booking(booked.id))], [true, false]);
  assert.deepEqual([(await me(SAM)).dueNow, (await me(SAM)).account.owed.total], [[], 0]);
});

test('round 15: a sign-up from round 15 on that ends unpaid is owed too ("Owed:" line), listed once on its own day; staff with Money waive it; paying its line clears it', async () => {
  connectShopify();
  // Friday 6pm to 8pm, 2 people at $5; Sam doesn't come
  const join = (await signUp(QUIZ)).data.join;
  const code = lair.memberRow(SAM).code;
  Date.now = () => at('2026-10-02', 20, 30);
  const mine = await me(SAM);
  assert.deepEqual([mine.joins[0].owed, mine.joins[0].due, mine.joins[0].waived], [true, 1000, false]);
  assert.deepEqual(mine.dueNow, [{ id: join.id, type: 'join', ref: join.ref, title: 'Trivia night', start: at('2026-10-02', 18), end: at('2026-10-02', 20), amount: 1000, covered: 0, paidAmount: 0, due: 1000, owed: true }]);
  assert.deepEqual(mine.account.owed.items.map((i) => [i.type, i.ref, i.kind, i.amount, i.owedRow]), [['join', join.ref, 'event', 1000, true]]);
  // The POS lists it once, as owed (not among today's rows too, though it ended today), and checks nothing in
  const line = { title: `Owed: Trivia night (Fri 2 Oct, ${join.ref})`, price: '10.00', quantity: 1, taxable: true, properties: { _booking: join.ref } };
  const scan = (await pos('scan', { code })).data;
  assert.deepEqual(scan.rows.map((r) => [r.type, r.id, r.owed]), [['join', join.id, true]]);
  assert.deepEqual(scan.rows[0].line, line);
  const counter = (await pos('checkin-member', { customerId: SAM })).data;
  assert.deepEqual([counter.rows.map((r) => [r.type, r.id, r.owed]), counter.lines], [[['join', join.id, true]], [line]]);
  assert.equal(lair.joinById(join.id).status, 'confirmed', 'never checked in');
  // The staff page's card lists it once too, with what's due
  const card = (await call('POST', 'checkin', { code }, 'staff')).data;
  assert.deepEqual([card.rows.filter((r) => r.id === join.id).map((r) => r.owed), card.due], [[true], 1000]);
  // Waived: staff with Money only, as for a booking (a member can't waive their own)
  assert.equal(said(await call('POST', `bookings/${join.id}/update`, { waived: true }, 'helper-events')), NOT_YOURS);
  assert.equal(said(await call('POST', `bookings/${join.id}/update`, { waived: true }, SAM)), '404 Booking not found.');
  const waived = await call('POST', `bookings/${join.id}/update`, { waived: true }, 'helper-money');
  assert.deepEqual([waived.status, waived.data.join.waived, waived.data.join.due, waived.data.join.owed], [200, true, 0, false]);
  assert.equal(lair.sql.exec('SELECT waived FROM event_joins WHERE id = ?', join.id).one().waived, 1);
  assert.deepEqual((await me(SAM)).dueNow, []);
  assert.deepEqual((await pos('scan', { code })).data.rows.map((r) => [r.id, r.owed, r.due, r.waived]), [[join.id, false, 0, true]], "just today's row, with nothing to pay");
  assert.equal((await me(SAM)).joins[0].waived, true);
  // Put back, it's owed again; paid with its line at the counter, it's done
  const back = await call('POST', `bookings/${join.id}/update`, { waived: false }, 'staff');
  assert.deepEqual([back.data.join.waived, back.data.join.owed], [false, true]);
  const paid = await internal('orders-paid', posOrder(1502, [line]));
  assert.deepEqual(paid.data.updated, [join.ref]);
  assert.deepEqual([lair.joinById(join.id).paid, lair.joinOwed(lair.joinById(join.id))], [true, false]);
  assert.deepEqual((await me(SAM)).dueNow, []);
});

test('round 15: owed rows come oldest first, bookings and sign-ups together, each once at the counter (a monthly account too); a weekend later the staff card says what they owe', async () => {
  const tbl = (await book({ tables: ['T5'], start: at('2026-10-01', 15), end: at('2026-10-01', 17) })).data.booking;
  const join = (await signUp(QUIZ)).data.join;
  const spot = (await reserve(WH)).data.booking;
  const code = lair.memberRow(SAM).code;
  // Sam checks in for his table but leaves without paying; he misses Friday's
  Date.now = () => at('2026-10-01', 15, 5);
  assert.equal((await call('POST', 'checkin', { id: tbl.id, type: 'booking' }, 'staff')).data.checkedIn, true);
  Date.now = () => at('2026-10-05', 13);
  const rows = (await pos('scan', { code })).data.rows;
  assert.deepEqual(rows.map((r) => [r.type, r.id, r.line.title]), [
    ['booking', tbl.id, `Owed: Table T5 (Thu 1 Oct, ${tbl.ref})`], ['booking', spot.id, `Owed: Warhammer night (Fri 2 Oct, ${spot.ref})`], ['join', join.id, `Owed: Trivia night (Fri 2 Oct, ${join.ref})`],
  ]);
  // The Members view counts the same three (GET /members?owing=1 and the member's own page)
  const owing = (await call('GET', 'members?owing=1', null, 'staff')).data;
  assert.deepEqual(owing.map((m) => [m.customerId, m.owed, m.owedCount]), [[SAM, 7000, 3]]);
  const page = (await call('GET', `members/${SAM}`, null, 'staff')).data.member;
  assert.deepEqual([page.owed, page.owedCount], [7000, 3]);
  // On a monthly account it's all on the account too, and still listed once
  assert.equal((await call('POST', `members/${SAM}/account`, { billing: 'monthly', creditLimit: 20000 }, 'staff')).status, 200);
  const monthly = (await pos('checkin-member', { customerId: SAM })).data;
  assert.deepEqual(monthly.rows.map((r) => [r.id, r.onAccount]), [[tbl.id, true], [spot.id, true], [join.id, true]]);
  assert.deepEqual((await pos('scan', { code })).data.rows.map((r) => [r.id, r.onAccount]), [[tbl.id, true], [spot.id, true], [join.id, true]]);
  assert.deepEqual(monthly.lines.map((l) => [l.properties._booking, l.price]), [[tbl.ref, '40.00'], [spot.ref, '20.00'], [join.ref, '10.00']]);
  const tab = (await me(SAM)).account;
  assert.deepEqual([tab.owed.items.map((i) => [i.id, i.settle]), tab.owed.total], [[[tbl.id, 'account'], [spot.id, 'account'], [join.id, 'account']], 7000]);
  const card = (await call('POST', 'checkin', { code }, 'staff')).data;
  assert.deepEqual([card.rows.map((r) => r.id), card.due], [[tbl.id, spot.id, join.id], 7000]);
  assert.match(card.message, /They owe \$70 from 3 earlier sessions\.$/);
});

test('round 15: what was booked before round 15 keeps the old rule: a one-off no-show or a sign-up left unpaid isn\'t owed', async () => {
  // Round 15 started an hour after these were booked
  lair.lockFrom = NOW + HOUR;
  await book({ tables: ['T5'], start: at('2026-10-01', 15), end: at('2026-10-01', 17) });
  await signUp(QUIZ);
  await reserve(WH);
  await seat((await oneShot()).id, 'Sam', SAM);
  // Kiri booked the same table time once round 15 was on
  Date.now = () => NOW + HOUR;
  const kiri = (await book({ tables: ['T6'], start: at('2026-10-01', 15), end: at('2026-10-01', 17), name: 'Kiri Smith', email: 'kiri@example.com' }, KIRI)).data.booking;
  Date.now = () => at('2026-10-03', 13);
  const sam = await me(SAM);
  assert.deepEqual([sam.dueNow, sam.account.owed.items], [[], []]);
  assert.deepEqual([...sam.bookings, ...sam.seats, ...sam.joins].map((x) => x.owed), [false, false, false, false]);
  assert.deepEqual((await pos('scan', { code: lair.memberRow(SAM).code })).data.rows, []);
  assert.deepEqual((await me(KIRI)).dueNow.map((d) => [d.id, d.owed]), [[kiri.id, true]]);
  // the Members view agrees: Kiri owes for hers, Sam owes nothing
  assert.deepEqual((await call('GET', 'members?owing=1', null, 'staff')).data.map((m) => [m.customerId, m.owed, m.owedCount]), [[KIRI, 4000, 1]]);
});

/* ---------------- nothing goes to checkout ---------------- */

test('round 15: no online checkout: events sold online, or online or in store, are signed up for and booked on the tab at once, whatever pay says; GET /floor says payOnline false', async () => {
  connectShopify();
  let checkouts = 0;
  lair.shopify.createCheckout = async () => {
    checkouts += 1;
    return { draftOrderId: 'gid://shopify/DraftOrder/1', checkoutUrl: 'https://checkout.test/1' };
  };
  for (const [id, fee] of [['champs@2026-10-03', 2500], ['league@2026-10-04', 1500]]) {
    const joined = await signUp(id, { pay: 'now' });
    assert.equal(joined.status, 200, joined.data.error);
    assert.deepEqual(
      [joined.data.join.status, joined.data.join.pay, joined.data.join.payment, joined.data.join.amount, joined.data.join.due, joined.data.checkoutUrl, joined.data.holdMinutes, joined.data.notice],
      ['confirmed', 'day', 'store', 2 * fee, 2 * fee, undefined, undefined, null], id,
    );
    const spot = await reserve(id, { pay: 'now' });
    assert.equal(spot.status, 200, spot.data.error);
    assert.deepEqual(
      [spot.data.booking.status, spot.data.booking.pay, spot.data.booking.payment, spot.data.booking.amount, spot.data.checkoutUrl, spot.data.holdMinutes, spot.data.notice],
      ['confirmed', 'day', 'store', 2 * fee, undefined, undefined, null], id,
    );
  }
  // Logged out too: a guest pays at the counter on the day
  const guest = await signUp('champs@2026-10-03', { name: 'Hemi Walker', email: 'hemi@example.com', people: 1, pay: 'now' }, '');
  assert.deepEqual([guest.status, guest.data.join.status, guest.data.join.pay, guest.data.checkoutUrl], [200, 'confirmed', 'day', undefined]);
  assert.equal(checkouts, 0, 'never a checkout');
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM event_joins WHERE status = 'held' OR pay = 'now' OR hold_until IS NOT NULL").one().n, 0);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE status = 'held' OR pay = 'now' OR hold_until IS NOT NULL").one().n, 0);
  // My Lair has nothing to pay online: each is on the tab, to pay at the counter
  assert.ok((await me(SAM)).account.comingUp.items.every((i) => i.settle === 'day' && i.status === 'booked'));
  for (const who of ['', SAM, 'staff']) assert.equal((await call('GET', 'floor', null, who)).data.features.payOnline, false, who || 'the public');
  assert.deepEqual(lair.paymentPlan('online', 'now'), { wantsPayNow: false, payNow: false, required: false });
});

/* ---------------- what My Lair and the answers say ---------------- */

test('round 15: the answers, My Lair\'s lists and its tab carry cancelUntil (the start less 24 hours) and locked, which turns on as time passes', async () => {
  const tbl = (await book()).data.booking; // Saturday 3pm
  const game = await oneShot(); // Friday 6pm
  const st = (await seat(game.id, 'Sam', SAM)).data.booking;
  const join = (await signUp(QUIZ)).data.join; // Friday 6pm
  const spot = (await reserve(WH)).data.booking; // Friday 6pm
  // Friday's can be cancelled online until Thursday 6pm, Saturday's until Friday 3pm
  const fridayBy = at('2026-10-01', 18);
  const saturdayBy = at('2026-10-02', 15);
  assert.deepEqual([tbl, st, join, spot].map((x) => [x.cancelUntil, x.locked]), [[saturdayBy, false], [fridayBy, false], [fridayBy, false], [fridayBy, false]]);
  const views = async () => {
    const m = await me(SAM);
    const of = (list) => list.map((x) => [x.id, x.cancelUntil, x.locked]);
    return { bookings: of(m.bookings), seats: of(m.seats), joins: of(m.joins), comingUp: of(m.account.comingUp.items) };
  };
  const expect = (fri, sat) => ({
    bookings: [[spot.id, ...fri], [tbl.id, ...sat]], seats: [[st.id, ...fri]], joins: [[join.id, ...fri]],
    // the tab's coming up: soonest first, then by title (Game table at Warhammer night, Tomb of Horrors, Trivia night)
    comingUp: [[spot.id, ...fri], [st.id, ...fri], [join.id, ...fri], [tbl.id, ...sat]],
  });
  assert.deepEqual(await views(), expect([fridayBy, false], [saturdayBy, false]));
  // A minute before Thursday 6pm nothing's locked; from 6pm, 24 hours before them, Friday's are; Saturday's isn't yet
  Date.now = () => fridayBy - MIN;
  assert.deepEqual(await views(), expect([fridayBy, false], [saturdayBy, false]));
  Date.now = () => fridayBy;
  assert.deepEqual(await views(), expect([fridayBy, true], [saturdayBy, false]));
  // Friday 3pm: all of them
  Date.now = () => saturdayBy;
  assert.deepEqual(await views(), expect([fridayBy, true], [saturdayBy, true]));
  // Once one's over or cancelled there's nothing to cancel: no cancelUntil, not locked
  Date.now = () => at('2026-10-02', 22, 30);
  const after = await me(SAM);
  assert.deepEqual([...after.bookings, ...after.seats, ...after.joins].map((x) => [x.id, x.cancelUntil, x.locked]), [
    [spot.id, null, false], [tbl.id, saturdayBy, true], [st.id, null, false], [join.id, null, false],
  ]);
  assert.deepEqual(after.account.comingUp.items.map((i) => i.id), [tbl.id]);
  assert.equal((await cancelBooking(tbl.id, 'staff')).data.booking.status, 'cancelled');
  assert.deepEqual((await me(SAM)).bookings.map((b) => [b.id, b.cancelUntil, b.locked]), [[spot.id, null, false], [tbl.id, null, false]]);
});

/* ---------------- paying for a few at once ---------------- */

test('round 15: staff mark several things on a member\'s tab paid at once (POST /members/:id/paid), coming up or owed; only theirs, and only staff with the right permission', async () => {
  const tbl = (await book()).data.booking; // $40, Saturday
  const join = (await signUp(QUIZ)).data.join; // $10, Friday
  const today = (await book({ tables: ['T5'], start: at('2026-10-01', 15), end: at('2026-10-01', 17) })).data.booking; // $40, today
  const gone = (await book({ tables: ['T6'] })).data.booking;
  assert.equal((await cancelBooking(gone.id, SAM)).data.booking.status, 'cancelled');
  const kiri = (await book({ tables: ['T4'], name: 'Kiri Smith', email: 'kiri@example.com' }, KIRI)).data.booking;
  const markPaid = (who, items) => call('POST', `members/${SAM}/paid`, { items }, who);
  const both = [{ type: 'booking', id: tbl.id }, { type: 'join', id: join.id }];
  // Not for members, not even their own; a helper needs Check-in or Tables for a booking, Check-in or Events for a sign-up
  assert.equal(said(await markPaid(SAM, both)), '403 Staff only. Log in with your staff account.');
  assert.equal(said(await markPaid('helper-events', both)), NOT_YOURS);
  assert.equal(said(await markPaid('helper-tables', both)), NOT_YOURS);
  assert.equal(said(await markPaid('helper-money', both)), NOT_YOURS);
  // Nothing ticked; someone else's; one that was cancelled; one that isn't there: refused, and nothing is paid
  assert.equal(said(await markPaid('staff', [])), `422 ${TAB_MESSAGES.pickSome}`);
  assert.equal(said(await markPaid('staff', [...both, { type: 'booking', id: kiri.id }])), `409 ${TAB_MESSAGES.notTheirs}`);
  assert.equal(said(await markPaid('staff', [...both, { type: 'booking', id: gone.id }])), `409 ${TAB_MESSAGES.notTheirs}`);
  assert.equal(said(await markPaid('staff', [{ type: 'join', id: tbl.id }])), `409 ${TAB_MESSAGES.notTheirs}`, 'a booking named as a sign-up');
  assert.deepEqual([lair.booking(tbl.id).paid, lair.joinById(join.id).paid, lair.booking(kiri.id).paid], [false, false, false]);
  // The two coming up, at once (a helper on the desk can do both)
  const res = await markPaid('helper-desk', both);
  assert.equal(res.status, 200, res.data.error);
  assert.deepEqual(res.data.paid, [{ type: 'booking', id: tbl.id, ref: tbl.ref, amount: 4000 }, { type: 'join', id: join.id, ref: join.ref, amount: 1000 }]);
  assert.equal(res.data.total, 5000);
  assert.deepEqual(res.data.account.comingUp.items.map((i) => [i.id, i.amount, i.settle]), [[today.id, 4000, 'day'], [join.id, 0, 'paid'], [tbl.id, 0, 'paid']]);
  assert.equal(res.data.account.comingUp.total, 4000);
  const mine = await me(SAM);
  assert.deepEqual([mine.bookings.find((b) => b.id === tbl.id).due, mine.bookings.find((b) => b.id === tbl.id).paid, mine.joins[0].due, mine.joins[0].paid], [0, true, 0, true]);
  assert.deepEqual([lair.booking(tbl.id).paidAmount, lair.joinById(join.id).paidAmount], [4000, 1000]);
  // Ticked again: nothing left to pay
  assert.equal(said(await markPaid('staff', both)), `409 ${TAB_MESSAGES.nothingDue}`);
  // What's owed too: today's table, over and unpaid, paid the next day (the paid ones ticked with it are left alone)
  Date.now = () => at('2026-10-02', 12);
  assert.deepEqual((await me(SAM)).dueNow.map((d) => [d.id, d.owed]), [[today.id, true]]);
  const owed = await markPaid('staff', [{ type: 'booking', id: today.id }, ...both]);
  assert.deepEqual([owed.status, owed.data.paid.map((p) => [p.id, p.amount]), owed.data.total], [200, [[today.id, 4000]], 4000]);
  assert.deepEqual([(await me(SAM)).dueNow, owed.data.account.owed.total], [[], 0]);
  // Kiri's own is hers to pay still
  assert.equal(lair.booking(kiri.id).paid, false);
});

/* ---------------- the emails ---------------- */

test('round 15: confirmations show no code: what it costs and that it\'s on the tab (a guest pays at the counter on the day), then until when it can be cancelled, or that it\'s locked in', async () => {
  const mail = captureEmails();
  const to = (email) => mail.sent.find((m) => m.to === email);
  const noCode = (m, ...refs) => {
    assert.doesNotMatch(m.text, /Your code|Booking code/, m.text);
    for (const ref of refs) assert.ok(!`${m.subject}\n${m.text}\n${m.html}`.includes(ref), `no ${ref} in ${m.subject}`);
  };
  const friday3pm = time.label(at('2026-10-02', 15));
  const thursday6pm = time.label(at('2026-10-01', 18));
  try {
    // A member's table on Saturday at 3pm, a guest's (logged out), and one booked inside the 24 hours (today at 3pm)
    const member = (await book()).data.booking;
    const guest = (await book({ tables: ['T4'], name: 'Hemi Walker', email: 'hemi@example.com' }, '')).data.booking;
    const late = (await book({ tables: ['T5'], start: at('2026-10-01', 15), end: at('2026-10-01', 17), name: 'Kiri Smith', email: 'kiri@example.com' }, KIRI)).data.booking;
    await settle();
    const sam = to('sam@example.com');
    assert.equal(sam.subject, `You're booked: ${lair.when(lair.booking(member.id), lair.rulesCache)}`);
    noCode(sam, member.ref);
    assert.match(sam.text, /Fee: +\$40\.00, on your tab\n/);
    assert.ok(sam.text.includes(TAB_WORDS.onTab) && sam.text.includes(TAB_WORDS.cancelBy(friday3pm, 24)), sam.text);
    const hemi = to('hemi@example.com');
    noCode(hemi, guest.ref);
    assert.match(hemi.text, /Fee: +\$40\.00, pay at the counter on the day\n/);
    assert.ok(hemi.text.includes(TAB_WORDS.onTabGuest) && hemi.text.includes(TAB_WORDS.cancelByGuest(friday3pm, 24)), hemi.text);
    const kiri = to('kiri@example.com');
    noCode(kiri, late.ref);
    assert.ok(kiri.text.includes(TAB_WORDS.onTab) && kiri.text.includes(TAB_WORDS.lockedNow(24)), kiri.text);
    assert.ok(!kiri.text.includes("Can't make it?"), 'nothing to cancel by');

    // Sign-ups: a member's ($10 on the tab), a free one, and a guest's ($5 at the counter on the day)
    mail.sent.length = 0;
    const join = (await signUp(QUIZ)).data.join;
    const free = (await signUp(PAINT, { name: 'Kiri Smith', email: 'kiri@example.com', people: 1 }, KIRI)).data.join;
    const guestJoin = (await signUp(QUIZ, { name: 'Hemi Walker', email: 'hemi@example.com', people: 1 }, '')).data.join;
    await settle();
    const quiz = to('sam@example.com');
    assert.equal(quiz.subject, `You're in: Trivia night, ${lair.when(lair.joinById(join.id), lair.rulesCache)}`);
    noCode(quiz, join.ref);
    assert.match(quiz.text, /Entry: +\$10\.00, on your tab\n/);
    assert.ok(quiz.text.includes(TAB_WORDS.onTab) && quiz.text.includes(TAB_WORDS.cancelBy(thursday6pm, 24)), quiz.text);
    const paint = to('kiri@example.com');
    noCode(paint, free.ref);
    assert.ok(paint.text.includes(TAB_WORDS.nothingToPay) && paint.text.includes("Can't make it? Cancel in My Lair, so someone else can have your spot."), paint.text);
    const hemiJoin = to('hemi@example.com');
    noCode(hemiJoin, guestJoin.ref);
    assert.match(hemiJoin.text, /Entry: +\$5\.00, pay at the counter on the day\n/);
    assert.ok(hemiJoin.text.includes(TAB_WORDS.onTabGuest) && hemiJoin.text.includes(TAB_WORDS.cancelByGuest(thursday6pm, 24)), hemiJoin.text);

    // Someone staff sign up who has no account yet: pay on the day, the account line, and let us know by Thursday 6pm
    mail.sent.length = 0;
    const added = await call('POST', `events/${QUIZ}/joins`, { name: 'Aroha Ngata', email: 'aroha@example.com', people: 1 }, 'staff');
    assert.deepEqual([added.status, added.data.invited], [200, true]);
    await settle();
    const aroha = to('aroha@example.com');
    noCode(aroha, added.data.join.ref);
    assert.match(aroha.text, /Entry: +\$5\.00, pay at the counter on the day\n/);
    for (const words of [
      'Pay at the counter on the day: just give your name.',
      'Make your Dice Goblin account with this email (aroha@example.com), or log in with it if you have one: this sign-up goes on your tab in My Lair, and so does anything else the team adds for you.',
      TAB_WORDS.cancelByGuest(thursday6pm, 24),
    ]) assert.ok(aroha.text.includes(words), words);

    // A seat at a one-off game: on the tab, cancelled in My Lair by Thursday 6pm
    mail.sent.length = 0;
    const game = await oneShot();
    const mine = (await seat(game.id, 'Mia', MIA)).data.booking;
    await settle();
    const seatMail = to('mia@example.com');
    assert.equal(seatMail.subject, `Seat saved: Tomb of Horrors, ${lair.when(lair.booking(mine.id), lair.rulesCache)}`);
    noCode(seatMail, mine.ref);
    assert.match(seatMail.text, /Fee: +\$15\.00, on your tab\n/);
    assert.ok(seatMail.text.includes(TAB_WORDS.cancelBy(thursday6pm, 24)), seatMail.text);

    // Staff alerts keep their codes: a sign-up paid at the counter and then cancelled by staff names the one to refund
    await call('POST', `bookings/${join.id}/update`, { paid: true }, 'staff');
    mail.sent.length = 0;
    assert.equal((await cancelJoin(join.id, 'staff')).data.refund.due, true);
    await settle();
    assert.ok(mail.sent.some((m) => m.to === 'staff@dicegoblin.test' && m.subject === `Refund due: ${join.ref}`), mail.sent.map((m) => m.subject).join('; '));
  } finally {
    mail.restore();
  }
});

test('round 15: a guest on someone else\'s sign-up never sees it as owed in My Lair: it\'s on the tab of whoever signed them up', async () => {
  await me(KIRI);
  // Sam signs himself and Kiri up (by her member code): $10, on Sam's tab; neither comes
  const join = (await signUp(QUIZ, { guests: [{ code: lair.memberRow(KIRI).code }] })).data.join;
  Date.now = () => at('2026-10-03', 12);
  assert.deepEqual((await me(SAM)).dueNow.map((d) => [d.id, d.due, d.owed]), [[join.id, 1000, true]]);
  const kiri = await me(KIRI);
  assert.deepEqual(kiri.joins.map((j) => [j.id, j.guestOf, j.amount, j.due, j.owed]), [[join.id, { name: 'Sam' }, 0, 0, false]]);
  assert.deepEqual([kiri.dueNow, kiri.account.owed.items], [[], []]);
});

test('round 15: a game\'s players hear about a new time or a cancelled game with no code to show; a new time says to have a chat inside the 24 hours', async () => {
  const game = await oneShot(); // Friday 6pm
  const mia = (await seat(game.id, 'Mia', MIA)).data.booking;
  const mail = captureEmails();
  try {
    const moved = await call('POST', `games/${game.id}/edit`, { start: at('2026-10-02', 19), end: at('2026-10-02', 22) }, 'staff');
    assert.equal(moved.status, 200, moved.data.error);
    await settle();
    const told = mail.sent.find((m) => m.to === 'mia@example.com');
    assert.match(told.subject, /^New time: Tomb of Horrors, /);
    assert.doesNotMatch(told.text, /Your code/);
    assert.ok(!`${told.subject}\n${told.text}`.includes(mia.ref), 'no booking code');
    assert.ok(told.text.includes("Can't make the new time? Cancel your seat in My Lair and Gobgob will let your GM know. Less than 24 hours away? Have a chat with us and we'll take it off your tab."), told.text);
    // Her seat moved with it, and so did the last moment to cancel it
    assert.deepEqual((await me(MIA)).seats.map((s) => [s.id, s.start, s.cancelUntil, s.locked]), [[mia.id, at('2026-10-02', 19), at('2026-10-01', 19), false]]);
    mail.sent.length = 0;
    assert.equal((await call('POST', `games/${game.id}/update`, { status: 'cancelled' }, 'gm')).status, 200);
    await settle();
    const off = mail.sent.find((m) => m.to === 'mia@example.com');
    assert.match(off.subject, /^Cancelled: Tomb of Horrors, /);
    assert.doesNotMatch(off.text, /Your code/);
    assert.ok(!`${off.subject}\n${off.text}`.includes(mia.ref), 'no booking code');
    // Nothing's owed for a game that didn't happen
    Date.now = () => at('2026-10-03', 12);
    assert.deepEqual([(await me(MIA)).dueNow, lair.isOwed(lair.booking(mia.id))], [[], false]);
  } finally {
    mail.restore();
  }
});

test('round 15: a GM\'s own table and a walk-in are never owed (staff settle those there and then)', async () => {
  const game = await oneShot();
  const gmTable = lair.gameBookings(game.id).find((b) => b.kind === 'gm');
  const walkin = (await call('POST', 'bookings', { kind: 'walkin', tables: ['T8'], start: NOW, end: NOW + HOUR, people: 2, name: 'Walk In' }, 'staff')).data.booking;
  Date.now = () => at('2026-10-03', 12);
  assert.deepEqual([lair.isOwed(lair.booking(gmTable.id)), lair.isOwed(lair.booking(walkin.id))], [false, false]);
  assert.deepEqual([lair.booking(gmTable.id).customerId, (await me('gm')).dueNow], ['gm', []]);
  assert.deepEqual(lair.owedRows('gm', lair.rulesCache, Date.now()), []);
});

/* ---------------- after the first review ---------------- */

test('round 15: a sign-up can\'t be cancelled online once it\'s started (a free one, or one from before round 15); staff still can', async () => {
  const free = (await signUp(PAINT)).data.join;
  // Sam's trivia sign-up predates round 15 (so it isn't locked 24 hours before)
  lair.lockFrom = NOW + HOUR;
  const old = (await signUp(QUIZ)).data.join;
  Date.now = () => at('2026-10-02', 19, 30);
  assert.equal(said(await cancelJoin(free.id, SAM)), `409 ${TAB_WORDS.started}`);
  assert.equal(said(await cancelJoin(old.id, SAM)), `409 ${TAB_WORDS.started}`);
  assert.deepEqual([lair.joinById(free.id).status, lair.joinById(old.id).status], ['confirmed', 'confirmed']);
  assert.equal((await cancelJoin(free.id, 'staff')).data.join.status, 'cancelled');
});

test('round 15: joining a weekly game less than 24 hours before its next session books a seat that\'s locked at once (their own choice, like a one-off seat)', async () => {
  const listed = await call('POST', 'games', {
    title: 'Late Blades', system: 'Blades in the Dark', gm: 'Ellie', email: 'ellie@example.com', blurb: 'Heists.', seats: 4, tables: ['B1'],
    start: at('2026-10-02', 18), end: at('2026-10-02', 21), schedule: 'flexible',
  }, 'gm');
  assert.equal(listed.status, 200, listed.data.error);
  // Friday 9am: the session is 9 hours away
  Date.now = () => at('2026-10-02', 9);
  const joined = await call('POST', `games/${listed.data.game.id}/join-series`, { people: 1, name: 'Mia', email: 'mia@example.com' }, MIA);
  assert.equal(joined.status, 200, joined.data.error);
  const booked = lair.booking(joined.data.booked[0].ref);
  assert.equal(booked.gobSaved, false, 'booked by joining, not saved by Gobgob by itself');
  const view = (await me(MIA)).seats.find((x) => x.id === booked.id);
  assert.deepEqual([view.cancelUntil, view.locked], [at('2026-10-01', 18), true]);
  assert.equal(said(await cancelBooking(booked.id, MIA)), LOCKED);
});

test('round 15: something owed that\'s theirs by email alone (booked as a guest, not on their account yet) stays among today\'s rows at the counter, never lost', async () => {
  // Sam is a member; earlier today a table was booked with his email but no account (a guest booking)
  await call('GET', 'me', null, SAM);
  lair.write("UPDATE members SET email = 'sam@example.com' WHERE customer_id = ?", SAM);
  const guest = (await book({ tables: ['T7'], start: at('2026-10-01', 14), end: at('2026-10-01', 16) }, '')).data.booking;
  assert.equal(lair.booking(guest.id).customerId, null);
  Date.now = () => at('2026-10-01', 16, 30);
  assert.equal(lair.isOwed(lair.booking(guest.id)), true);
  const code = lair.memberRow(SAM).code;
  const scan = (await pos('scan', { code })).data;
  assert.deepEqual(scan.rows.map((r) => [r.id, r.due]), [[guest.id, 4000]], 'listed once, among today\'s');
  const counter = (await pos('checkin-member', { customerId: SAM })).data;
  assert.deepEqual(counter.rows.map((r) => r.id), [guest.id]);
  assert.deepEqual(counter.lines.map((l) => [l.properties._booking, l.price]), [[guest.ref, '40.00']]);
});

test('round 15: once they\'re here (checked in), there\'s nothing to lock: no cancelUntil, not locked', async () => {
  const booked = (await book({ tables: ['T5'], start: at('2026-10-01', 15), end: at('2026-10-01', 17) })).data.booking;
  assert.deepEqual([booked.cancelUntil, booked.locked], [at('2026-09-30', 15), true]);
  Date.now = () => at('2026-10-01', 15, 5);
  assert.equal((await call('POST', 'checkin', { id: booked.id, type: 'booking' }, 'staff')).data.checkedIn, true);
  const view = (await me(SAM)).bookings.find((b) => b.id === booked.id);
  assert.deepEqual([view.status, view.cancelUntil, view.locked], ['seated', null, false]);
});

test('round 15: POST /members/:id/paid asks who\'s asking first: someone who isn\'t staff gets the 403 whatever they send', async () => {
  assert.equal((await call('POST', `members/${SAM}/paid`, {}, SAM)).status, 403);
  assert.equal((await call('POST', `members/${SAM}/paid`, { items: [{ type: 'booking', id: 'nope' }] }, KIRI)).status, 403);
  assert.equal(said(await call('POST', `members/${SAM}/paid`, {}, 'staff')), `422 ${TAB_MESSAGES.pickSome}`);
});

/* ---------------- after the independent review ---------------- */

test('round 15: the seat joining a weekly game booked inside the 24 hours stays locked when they join again or leave (only seats Gobgob saved by itself are let off)', async () => {
  const listed = await call('POST', 'games', {
    title: 'Later Blades', system: 'Blades in the Dark', gm: 'Ellie', email: 'ellie@example.com', blurb: 'Heists.', seats: 4, tables: ['B2'],
    start: at('2026-10-02', 18), end: at('2026-10-02', 21), schedule: 'flexible',
  }, 'gm');
  assert.equal(listed.status, 200, listed.data.error);
  const { seriesId } = listed.data.game;
  Date.now = () => at('2026-10-02', 9);
  const joined = await call('POST', `games/${listed.data.game.id}/join-series`, { people: 1, name: 'Mia', email: 'mia@example.com' }, MIA);
  assert.equal(joined.status, 200, joined.data.error);
  const booked = lair.booking(joined.data.booked[0].ref);
  // joining again (changing who's coming) keeps it locked
  Date.now = () => at('2026-10-02', 9, 5);
  const again = await call('POST', `games/${listed.data.game.id}/join-series`, { people: 1, name: 'Mia', email: 'mia@example.com' }, MIA);
  assert.equal(again.status, 200, again.data.error);
  assert.equal((await me(MIA)).seats.find((x) => x.id === booked.id).locked, true);
  assert.equal(said(await cancelBooking(booked.id, MIA)), LOCKED);
  // leaving keeps it on her tab too
  Date.now = () => at('2026-10-02', 9, 10);
  const left = await call('POST', `series/${seriesId}/leave`, {}, MIA);
  assert.equal(left.status, 200, left.data.error);
  assert.deepEqual([left.data.cancelled, left.data.kept.map((k) => k.id)], [0, [booked.id]]);
  assert.equal(lair.booking(booked.id).status, 'confirmed');
});

test('round 15: a named player\'s share is never owed on their own tab; once the game is over unpaid, what\'s left is the booker\'s', async () => {
  await me(KIRI);
  const kiriCode = lair.memberRow(KIRI).code;
  const res = await reserve(WH, { players: [{ code: kiriCode }] });
  assert.equal(res.status, 200, res.data.error);
  const id = res.data.booking.id;
  // Friday 10:30pm: the game's over and nobody paid
  Date.now = () => at('2026-10-02', 22, 30);
  const card = (await call('POST', 'checkin', { code: kiriCode }, 'staff')).data;
  const row = card.rows.find((r) => r.playerOf);
  assert.deepEqual([row.id, row.owed, row.due], [id, false, 1000]);
  const scan = (await pos('scan', { code: kiriCode })).data.rows.find((r) => r.playerOf);
  assert.deepEqual([scan.owed, scan.due], [false, 1000]);
  assert.equal(lair.isOwed(lair.booking(id)), true, 'the booker owes what is left');
  assert.deepEqual((await me(SAM)).dueNow.map((d) => [d.id, d.owed, d.due]), [[id, true, 2000]]);
});

test('round 15: paid at the counter ahead of time, then cancelled in time online: the money comes back (refund due, and staff are emailed)', async () => {
  const mail = captureEmails();
  try {
    const tbl = (await book()).data.booking;
    const join = (await signUp(QUIZ)).data.join;
    const paid = await call('POST', `members/${SAM}/paid`, { items: [{ type: 'booking', id: tbl.id }, { type: 'join', id: join.id }] }, 'staff');
    assert.equal(paid.status, 200, paid.data.error);
    const t = await cancelBooking(tbl.id, SAM);
    assert.deepEqual([t.status, t.data.refund.due, t.data.refund.amount, lair.booking(tbl.id).refund], [200, true, 4000, 'due']);
    const j = await cancelJoin(join.id, SAM);
    assert.deepEqual([j.status, j.data.refund.due, j.data.refund.amount, lair.joinById(join.id).refund], [200, true, 1000, 'due']);
    await settle();
    const told = mail.sent.filter((m) => m.to === 'staff@dicegoblin.test').map((m) => m.subject);
    assert.deepEqual(told.sort(), [`Refund due: ${join.ref}`, `Refund due: ${tbl.ref}`].sort());
    const tableMail = mail.sent.find((m) => m.subject === `Refund due: ${tbl.ref}`);
    assert.match(tableMail.text, /they'd paid \$40\.00 for it at the counter already\. Refund it \(or put it on their store credit\), then mark it refunded\./);
  } finally {
    mail.restore();
  }
});

test('round 15: a sign-up or game table for an event date that\'s gone from the calendar (deleted in Shopify) is never locked or owed', async () => {
  const join = (await signUp(QUIZ)).data.join;
  const spot = (await reserve(WH)).data.booking;
  // Shopify's editor deletes Friday's trivia and Warhammer dates
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, ROOMS, EVENTS.filter((e) => !['quiz', 'wh'].includes(e.id)));
  Date.now = () => at('2026-10-02', 12);
  const mine = await me(SAM);
  assert.deepEqual(mine.joins.map((j) => [j.id, j.gone, j.locked]), [[join.id, true, false]]);
  assert.equal(mine.bookings.find((b) => b.id === spot.id).locked, false);
  assert.equal((await cancelJoin(join.id, SAM)).data.join.status, 'cancelled');
  // the game table left alone: once its time is over it isn't owed
  Date.now = () => at('2026-10-03', 13);
  assert.equal(lair.isOwed(lair.booking(spot.id)), false);
  assert.deepEqual((await me(SAM)).dueNow, []);
});

test('round 15: a guest\'s confirmation inside the 24 hours says it\'s theirs to pay (they have no tab yet)', async () => {
  const mail = captureEmails();
  try {
    const guest = await book({ tables: ['T8'], start: at('2026-10-01', 18), end: at('2026-10-01', 20), name: 'Jo Guest', email: 'jo@example.com' }, '');
    assert.equal(guest.status, 200, guest.data.error);
    await settle();
    const letter = mail.sent.find((m) => m.to === 'jo@example.com');
    assert.ok(letter.text.includes(TAB_WORDS.onTabGuest), letter.text);
    assert.ok(letter.text.includes(TAB_WORDS.lockedNowGuest(24)), letter.text);
    assert.ok(!letter.text.includes('stays on your tab'), 'a guest has no tab yet');
  } finally {
    mail.restore();
  }
});

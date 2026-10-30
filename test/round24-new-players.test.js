// Round 24: welcome codes that pay out at a new player's first paid session, "How did you find us?", the ad a booking
// came from, and new players in the weekly numbers (contract v24-new-players). Mo (31 Oct 2026), planning the ads: "The ad
// only welcome can be a hook for people joining dice goblin" and "Happy with welcome codes but I want it only given out
// after their first event at dice goblin not a free dice roll. They need to come and pay using their id or qr etc. Then
// they get a dice for it. Otherwise it won't work for me to give people free credit." Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { FOUND_US_ANSWERS, WELCOME_CODES, WELCOME_WORDS as W, cleanAd, welcomeMessage } from '../src/newplayers.js';
import { REPORT_WORDS } from '../src/report.js';

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
/** An order line for the Session product */
const sessionLine = (id, variant, sku) => ({ id, title: 'Session', variant_title: variant, sku, quantity: 1, price: '15.00', properties: [] });

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
  lair.shopify.orderSpend = async () => null;
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

/* ---------------- the words, the codes and the answers ---------------- */

test('round 24: the words, word for word, the four welcome codes and the answers to "How did you find us?"', () => {
  assert.deepEqual(W, {
    notNew: "That's a welcome code for players new to the Lair, and you've played with us before. Thanks for coming back!",
    oneEach: "You've used a welcome code already. It's one per player.",
    welcome: "That Welcome code tick didn't come through properly. Try again.",
    answer: 'Pick one of the answers.',
    noMember: 'No member with that customer ID.',
  });
  assert.equal(welcomeMessage(1, false), "Saved! Your welcome roll unlocks after your first paid session at the Lair. Show your member code at the counter when you pay, and it's yours.");
  assert.equal(welcomeMessage(2, false), "Saved! Your 2 welcome rolls unlock after your first paid session at the Lair. Show your member code at the counter when you pay, and they're yours.");
  assert.equal(welcomeMessage(1, true), 'Welcome to the Lair! Your welcome roll is ready on Home, friend.');
  assert.equal(welcomeMessage(3, true), 'Welcome to the Lair! Your 3 welcome rolls are ready on Home, friend.');
  // one for each channel in the ads plan
  assert.deepEqual(WELCOME_CODES, [
    { code: 'SEARCH-ROLL', note: 'Welcome code for Google' },
    { code: 'SCROLL-ROLL', note: 'Welcome code for Facebook and Instagram' },
    { code: 'TOK-ROLL', note: 'Welcome code for TikTok' },
    { code: 'UPVOTE-ROLL', note: 'Welcome code for Reddit' },
  ]);
  assert.deepEqual(FOUND_US_ANSWERS, [
    ['google', 'Google'], ['facebook', 'Facebook'], ['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['reddit', 'Reddit'],
    ['friend', 'A friend'], ['walked-past', 'Walked past'], ['discord', 'Discord'], ['other', 'Something else'],
  ]);
  assert.match(REPORT_WORDS.newPlayer, /first visit/);
});

test('round 24: the four welcome codes are made once on start, 1 roll each with no limit or last day; one switched off stays off when the Lair starts again', async () => {
  const listed = async () => ok(await call('GET', 'roll-codes?status=all', null, OWNER));
  const welcome = async () => (await listed()).codes.filter((c) => c.welcome).map((c) => [c.code, c.rolls, c.limit, c.expiresAt, c.status, c.note, c.createdBy]).sort();
  assert.deepEqual(await welcome(), [
    ['SCROLL-ROLL', 1, null, null, 'active', 'Welcome code for Facebook and Instagram', 'setup'],
    ['SEARCH-ROLL', 1, null, null, 'active', 'Welcome code for Google', 'setup'],
    ['TOK-ROLL', 1, null, null, 'active', 'Welcome code for TikTok', 'setup'],
    ['UPVOTE-ROLL', 1, null, null, 'active', 'Welcome code for Reddit', 'setup'],
  ]);
  // round 7's ROLL-FOR-LOOT is an ordinary loot code: its roll comes at once
  assert.equal((await listed()).codes.find((c) => c.code === 'ROLL-FOR-LOOT').welcome, false);
  const tok = (await listed()).codes.find((c) => c.code === 'TOK-ROLL');
  ok(await call('POST', `roll-codes/${tok.id}/update`, { status: 'inactive' }, OWNER));
  // the Lair starting again (a deploy) makes none of them again
  lair = new Lair(ctx, ENV);
  lair.taggedPerson = async (id) => ({ customerId: id || null, staff: id === OWNER, gm: false, tags: [] });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  const after = (await listed()).codes.filter((c) => c.welcome);
  assert.equal(after.length, 4);
  assert.equal(after.find((c) => c.code === 'TOK-ROLL').status, 'inactive');
});

/* ---------------- "only given out after their first event ... not a free dice roll" ---------------- */

test('welcome codes (Mo, 31 Oct 2026): "only given out after their first event at dice goblin not a free dice roll": the roll waits, and nothing can be rolled until their first paid session', async () => {
  const saved = await redeem(MIA, 'scroll-roll');
  assert.equal(saved.status, 200, saved.data.error);
  const { kind, rolls, waiting, message, loyalty } = saved.data;
  assert.deepEqual([kind, rolls, waiting, message], ['welcome', 0, 1, welcomeMessage(1, false)], "kind 'welcome': a page from before shows the message and offers no roll");
  assert.deepEqual([loyalty.rolls.available, loyalty.rolls.waiting, loyalty.rolls.earned.codes], [0, 1, 0]);
  assert.equal(said(await roll(MIA)), NO_ROLLS, 'nothing to roll yet');
  // booked for this afternoon: still waiting
  const booking = await table(MIA, 'Mia');
  assert.equal((await card(MIA)).rolls.waiting, 1);
  assert.equal(said(await roll(MIA)), NO_ROLLS);
  // "They need to come and pay using their id or qr": her table paid at the counter, and the roll is hers
  ok(await internal('orders-paid', posOrder(8001, [bookingLine(80011, booking.ref, 10)])));
  const c = await card(MIA);
  assert.deepEqual([c.rolls.available, c.rolls.earned.codes, c.rolls.used], [1, 1, 0]);
  assert.equal('waiting' in c.rolls, false, 'nothing waits any more');
  // and it's a roll like any other: $1 to $20 store credit, or the sure $10
  const rolled = ok(await call('POST', 'roll', { kind: 'loyalty', pick: 'sure' }, MIA, { 'X-Lair-Client': '203.0.113.7' }));
  assert.deepEqual([rolled.prize.amount, rolled.loyalty.rolls.available], [1000, 0]);
  assert.deepEqual(credited, [[MIA, 1000]]);
  assert.equal(said(await roll(MIA)), NO_ROLLS, 'one welcome roll, once');
});

test('welcome codes: "not a free dice roll": checked in without paying, a free event, a fee staff let them off or a GM\'s own session doesn\'t unlock it; paying does', async () => {
  ok(await redeem(MIA, 'SEARCH-ROLL'));
  // checked in at the counter, nothing paid yet: a stamp, but the roll waits
  const booking = await table(MIA, 'Mia');
  ok(await pos('checkin', { id: booking.id, type: 'booking' }));
  assert.equal(lair.stampCount(MIA), 1, 'the session is on her card');
  assert.equal((await card(MIA)).rolls.waiting, 1, 'but nothing was paid');
  // a free event, checked in: nothing to pay, so nothing unlocks
  const demo = await signUp(MIA, 'Mia', 'demo');
  ok(await pos('checkin', { id: demo.id, type: 'join' }));
  assert.equal(lair.stampCount(MIA), 2);
  assert.equal((await card(MIA)).rolls.waiting, 1);
  // staff let her off the table fee: free to her, so still nothing
  ok(await update(booking.id, { waived: true }));
  assert.equal((await card(MIA)).rolls.waiting, 1);
  ok(await update(booking.id, { waived: false }));
  // trivia night, paid at the counter: that's a paid session
  const quiz = await signUp(MIA, 'Mia');
  nowIs(at(TODAY, 18, 5));
  ok(await pos('checkin', { id: quiz.id, type: 'join' }));
  assert.equal((await card(MIA)).rolls.waiting, 1, 'checked in, not paid yet');
  ok(await internal('orders-paid', posOrder(8101, [bookingLine(81011, quiz.ref, 5)])));
  const c = await card(MIA);
  assert.deepEqual([c.rolls.available, 'waiting' in c.rolls], [1, false]);
  // Rangi, a GM new to the Lair, runs a session tonight: it stamps his card, but he paid nothing, so his roll waits
  nowIs(NOW);
  const RANGI = '5001';
  lair.makeMember({ customerId: RANGI, name: 'Rangi Hohaia', email: 'rangi@example.com' }, NOW);
  ok(await redeem(RANGI, 'TOK-ROLL'));
  const game = ok(await call('POST', 'games', {
    title: "Rangi's one-shot", system: 'D&D 5e', gm: 'Rangi', blurb: 'A test session.', seats: 4, tables: ['T7'], start: at(TODAY, 19), end: at(TODAY, 22),
    gmCustomerId: RANGI, gmCustomerName: 'Rangi', gmEmail: 'rangi@example.com',
  }, OWNER)).game;
  ok(await call('POST', 'bookings', { kind: 'gm-seat', gameId: game.id, people: 1, name: 'Leo', email: 'leo@example.com', phone: '021 555 0100', pay: 'day' }, LEO));
  nowIs(at(TODAY, 19, 30));
  // (the 10-minute run notes that he ran it, and that he isn't on the team)
  await lair.gmRunUpkeep(Date.now());
  assert.equal(lair.stampCount(RANGI), 1, 'a stamp for running it');
  assert.deepEqual([(await card(RANGI)).rolls.available, (await card(RANGI)).rolls.waiting], [0, 1]);
});

test('welcome codes: a session pass used at check-in, a Session product rung up at the counter or a stamp staff add counts as their paid session', async () => {
  // Mia: a pass of hers covers her table at check-in
  ok(await redeem(MIA, 'SCROLL-ROLL'));
  const pass = ok(await call('POST', 'passes', { label: 'Five sessions', sessions: 5, customerId: MIA, holderName: '' }, OWNER)).pass;
  const booking = await table(MIA, 'Mia', { usePass: pass.code });
  assert.equal((await card(MIA)).rolls.waiting, 1, 'nothing used until check-in');
  const checked = ok(await pos('checkin', { id: booking.id, type: 'booking' }));
  assert.ok(checked.row.covered > 0, 'the pass covered it');
  assert.equal((await card(MIA)).rolls.available, 1);
  // Kai: an RPG Session rung up at the counter with his code scanned
  ok(await redeem(KAI, 'SCROLL-ROLL'));
  ok(await internal('orders-paid', posOrder(8201, [sessionLine(82011, 'RPG Session', 'LAIR-SESSION-RPG')], { customer: { id: Number(KAI) } })));
  assert.equal((await card(KAI)).rolls.available, 1);
  // Ria: a stamp staff added at the counter for a session the Lair app doesn't know about
  ok(await redeem(RIA, 'TOK-ROLL'));
  ok(await pos('stamp', { customerId: RIA, key: 'ria-stamp-0001' }));
  assert.equal((await card(RIA)).rolls.available, 1);
});

test('welcome codes: like stamps, the roll follows the paid session: marked a no-show or cancelled, it waits again (unless it was rolled)', async () => {
  ok(await redeem(MIA, 'SCROLL-ROLL'));
  const booking = await table(MIA, 'Mia');
  ok(await update(booking.id, { paid: true }));
  assert.equal((await card(MIA)).rolls.available, 1);
  ok(await update(booking.id, { status: 'noshow' }));
  assert.deepEqual([(await card(MIA)).rolls.available, (await card(MIA)).rolls.waiting], [0, 1], 'a no-show was never a session');
  ok(await update(booking.id, { status: 'confirmed' }));
  assert.equal((await card(MIA)).rolls.available, 1);
  ok(await roll(MIA));
  ok(await update(booking.id, { status: 'cancelled' }));
  const c = await card(MIA);
  assert.deepEqual([c.rolls.available, c.rolls.used, c.rolls.waiting], [0, 1, 1], 'rolled already: nothing more to take, and never below none');
});

/* ---------------- welcome codes are for new players, one each ---------------- */

test('welcome codes are for players new to the Lair: someone who played before today is turned away, and nothing is saved', async () => {
  await kaiPlayedYesterday();
  const refused = await redeem(KAI, 'SCROLL-ROLL');
  assert.equal(said(refused), `409 ${W.notNew}`);
  assert.equal(welcomeUses(KAI), 0);
  assert.equal((await card(KAI)).rolls.available, 0);
  // an ordinary loot code still works for him, at once
  const loot = ok(await redeem(KAI, 'ROLL-FOR-LOOT'));
  assert.deepEqual([loot.kind, loot.rolls, loot.loyalty.rolls.available], ['roll', 1, 1]);
  // played yesterday with no booking of their own: Ria had an RPG Session rung up at the counter, and Leo was a stamp
  // staff added for a session the Lair app didn't know about
  nowIs(at(YESTERDAY, 15));
  ok(await internal('orders-paid', posOrder(7101, [sessionLine(71011, 'RPG Session', 'LAIR-SESSION-RPG')], { customer: { id: Number(RIA) } })));
  ok(await pos('stamp', { customerId: LEO, key: 'leo-stamp-0001' }));
  nowIs(NOW);
  assert.equal(said(await redeem(RIA, 'SEARCH-ROLL')), `409 ${W.notNew}`);
  assert.equal(said(await redeem(LEO, 'SEARCH-ROLL')), `409 ${W.notNew}`);
});

test('welcome codes at the counter: someone who checks in and pays for their first session today, then types the code, gets the roll at once', async () => {
  const booking = await table(MIA, 'Mia');
  ok(await pos('checkin', { id: booking.id, type: 'booking' }));
  ok(await internal('orders-paid', posOrder(8301, [bookingLine(83011, booking.ref, 10)])));
  const saved = ok(await redeem(MIA, 'SEARCH-ROLL'));
  assert.deepEqual([saved.kind, saved.rolls, saved.waiting, saved.message], ['roll', 1, 0, welcomeMessage(1, true)], "kind 'roll': the page offers Roll it now");
  assert.equal(saved.loyalty.rolls.available, 1);
  assert.equal(welcomeUses(MIA), 1);
});

test('welcome codes: one per player, even a different one, and two at the same moment save one', async () => {
  ok(await redeem(MIA, 'SCROLL-ROLL'));
  assert.equal(said(await redeem(MIA, 'SCROLL-ROLL')), "409 You've used that code already. It's one go each.");
  assert.equal(said(await redeem(MIA, 'SEARCH-ROLL')), `409 ${W.oneEach}`);
  assert.equal(welcomeUses(MIA), 1);
  // two codes at once, from two phones
  const [a, b] = await Promise.all([redeem(KAI, 'TOK-ROLL'), redeem(KAI, 'UPVOTE-ROLL')]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(welcomeUses(KAI), 1);
  // and the store keeps it so whatever happens: a second welcome use for a member can't be saved
  const codeId = lair.sql.exec("SELECT id FROM roll_codes WHERE code = 'SEARCH-ROLL'").one().id;
  assert.throws(() => lair.sql.exec("INSERT INTO roll_code_uses (id, code_id, customer_id, rolls, grant_id, at, pays_on) VALUES ('ru_x', ?, ?, 1, NULL, ?, 'first-session')", codeId, MIA, NOW), /UNIQUE/);
});

test('welcome codes: switched off or past their last day, they stop like any loot code; logged out, nothing happens', async () => {
  const listed = ok(await call('GET', 'roll-codes?status=all', null, OWNER)).codes;
  const reddit = listed.find((c) => c.code === 'UPVOTE-ROLL');
  ok(await call('POST', `roll-codes/${reddit.id}/update`, { status: 'inactive' }, OWNER));
  assert.equal(said(await redeem(MIA, 'UPVOTE-ROLL')), "410 That code isn't working any more. Ask us at the counter.");
  // a welcome code staff made for one day only
  ok(await call('POST', 'roll-codes', { code: 'OPEN-DAY', welcome: true, expires: TODAY }, OWNER));
  nowIs(at('2026-11-02', 10));
  assert.equal(said(await redeem(MIA, 'OPEN-DAY')), "410 That code isn't working any more. Ask us at the counter.");
  assert.equal(said(await call('POST', 'me/codes/redeem', { code: 'SEARCH-ROLL' })), '401 Log in to use a code.');
  assert.equal(welcomeUses(MIA), 0);
});

/* ---------------- staff make and change welcome codes ---------------- */

test('staff: a loot code is made a welcome code with welcome: true and switched with update; a use keeps what the code was when it was typed', async () => {
  const made = ok(await call('POST', 'roll-codes', { code: 'MEET-GOBGOB', welcome: true, note: 'Flyers at the library' }, OWNER)).code;
  assert.deepEqual([made.code, made.rolls, made.welcome, made.status], ['MEET-GOBGOB', 1, true, 'active']);
  const plain = ok(await call('POST', 'roll-codes', { code: 'PLAIN-LOOT' }, OWNER)).code;
  assert.equal(plain.welcome, false, 'without the tick, as before');
  for (const bad of ['yes', 1, null, {}]) {
    assert.equal(said(await call('POST', 'roll-codes', { code: 'BAD-TICK', welcome: bad }, OWNER)), `422 ${W.welcome}`, JSON.stringify(bad));
  }
  assert.equal(said(await call('POST', 'roll-codes', { code: 'NOT-YOURS', welcome: true }, HEMI)), "403 That's not one of your staff permissions. Ask the main account to tick it on the Team tab.");
  // Mia's waits for her first paid session
  assert.equal(ok(await redeem(MIA, 'MEET-GOBGOB')).kind, 'welcome');
  // switched to an ordinary loot code: Kai's roll comes at once, Mia's still waits
  const changed = ok(await call('POST', `roll-codes/${made.id}/update`, { welcome: false }, OWNER)).code;
  assert.equal(changed.welcome, false);
  const kais = ok(await redeem(KAI, 'MEET-GOBGOB'));
  assert.deepEqual([kais.kind, kais.rolls], ['roll', 1]);
  assert.deepEqual([(await card(MIA)).rolls.available, (await card(MIA)).rolls.waiting], [0, 1]);
  // and back again
  assert.equal(ok(await call('POST', `roll-codes/${made.id}/update`, { welcome: true }, OWNER)).code.welcome, true);
  assert.equal(said(await call('POST', `roll-codes/${made.id}/update`, { welcome: 'no' }, OWNER)), `422 ${W.welcome}`);
});

test('staff see a member\'s welcome code on their page: which code, when, and whether it waits for their first paid session', async () => {
  assert.equal(ok(await call('GET', `members/${MIA}`, null, OWNER)).member.welcome, null);
  ok(await redeem(MIA, 'SCROLL-ROLL'));
  assert.deepEqual(ok(await call('GET', `members/${MIA}`, null, OWNER)).member.welcome, { code: 'SCROLL-ROLL', at: NOW, rolls: 1, waiting: true });
  const booking = await table(MIA, 'Mia');
  ok(await update(booking.id, { paid: true }));
  assert.equal(ok(await call('GET', `members/${MIA}`, null, OWNER)).member.welcome.waiting, false);
});

test('the counter shows a welcome roll that waits (rollsWaiting), and a card with nothing waiting is as it was', async () => {
  const before = ok(await pos('scan', { code: codeOf(MIA) })).loyalty;
  assert.deepEqual(before, { stamps: 0, cardSize: 10, rollsAvailable: 0, card: 1 });
  ok(await redeem(MIA, 'SCROLL-ROLL'));
  assert.deepEqual(ok(await pos('scan', { code: codeOf(MIA) })).loyalty, { stamps: 0, cardSize: 10, rollsAvailable: 0, card: 1, rollsWaiting: 1 });
  const booking = await table(MIA, 'Mia');
  const ticket = ok(await pos('scan', { code: booking.ref }));
  assert.equal(ticket.loyalty.rollsWaiting, 1, 'a ticket on her account shows it too');
  ok(await pos('checkin', { id: booking.id, type: 'booking' }));
  ok(await internal('orders-paid', posOrder(8401, [bookingLine(84011, booking.ref, 10)])));
  assert.deepEqual(ok(await pos('scan', { code: codeOf(MIA) })).loyalty, { stamps: 1, cardSize: 10, rollsAvailable: 1, card: 1 });
});

/* ---------------- "How did you find us?" ---------------- */

test('"How did you find us?": the counter asks on a new player\'s first day (newHere), and their answer is saved with who and when', async () => {
  await kaiPlayedYesterday();
  const kai = ok(await pos('scan', { code: codeOf(KAI) }));
  assert.deepEqual([kai.newHere, kai.foundUs], [false, null], 'Kai played yesterday: not asked');
  const mia = ok(await pos('scan', { code: codeOf(MIA) }));
  assert.deepEqual([mia.newHere, mia.foundUs], [true, null], 'Mia is new: asked');
  // still new while today is her first day, after checking in
  const booking = await table(MIA, 'Mia');
  ok(await pos('checkin', { id: booking.id, type: 'booking' }));
  assert.equal(ok(await pos('scan', { code: codeOf(MIA) })).newHere, true);
  const saved = ok(await pos('found-us', { customerId: MIA, answer: 'instagram' }));
  assert.deepEqual(saved.foundUs, { answer: 'instagram', label: 'Instagram', at: NOW, by: 'the counter' });
  assert.deepEqual(ok(await pos('scan', { code: codeOf(MIA) })).foundUs, saved.foundUs);
  assert.equal(said(await pos('found-us', { customerId: MIA, answer: 'myspace' })), `422 ${W.answer}`);
  assert.equal(said(await pos('found-us', { customerId: MIA, answer: null })), `422 ${W.answer}`, 'the counter never clears it');
  assert.equal(said(await pos('found-us', { customerId: '777', answer: 'google' })), `404 ${W.noMember}`);
  // tomorrow she's not new any more
  nowIs(at('2026-11-02', 16));
  assert.equal(ok(await pos('scan', { code: codeOf(MIA) })).newHere, false);
});

test('"How did you find us?": a member answers in My Lair; staff with Check-in or Members set, change or clear it on their page', async () => {
  assert.equal(ok(await call('GET', 'me', null, MIA)).foundUs, null);
  const mine = ok(await call('POST', 'me/found-us', { answer: 'friend' }, MIA));
  assert.deepEqual(mine.foundUs, { answer: 'friend', label: 'A friend', at: NOW, by: 'me' });
  assert.deepEqual(ok(await call('GET', 'me', null, MIA)).foundUs, mine.foundUs);
  assert.equal(said(await call('POST', 'me/found-us', { answer: 'Friend' })), '401 Log in to tell us.');
  assert.equal(said(await call('POST', 'me/found-us', { answer: 'telepathy' }, MIA)), `422 ${W.answer}`);
  // Hemi (Check-in) changes it; Tama (Library only) can't
  const changed = ok(await call('POST', `members/${MIA}/found-us`, { answer: 'discord' }, HEMI));
  assert.deepEqual(changed.foundUs, { answer: 'discord', label: 'Discord', at: NOW, by: 'Hemi' });
  assert.equal((await call('POST', `members/${MIA}/found-us`, { answer: 'google' }, TAMA)).status, 403);
  assert.equal((await call('POST', `members/${MIA}/found-us`, { answer: 'google' }, MIA)).status, 403);
  assert.deepEqual(ok(await call('GET', `members/${MIA}`, null, OWNER)).member.foundUs, changed.foundUs);
  // cleared
  assert.equal(ok(await call('POST', `members/${MIA}/found-us`, { answer: null }, OWNER)).foundUs, null);
  assert.equal(ok(await call('GET', `members/${MIA}`, null, OWNER)).member.foundUs, null);
});

/* ---------------- ad tags ---------------- */

test('ad tags: cleaned to lower case and safe letters, and anything that isn\'t tags is nothing', () => {
  assert.deepEqual(cleanAd({ source: 'Google', medium: 'Paid', campaign: 'New players: Nov 2026!' }), { source: 'google', medium: 'paid', campaign: 'new-players-nov-2026' });
  assert.deepEqual(cleanAd({ source: 'facebook' }), { source: 'facebook', medium: null, campaign: null });
  assert.equal(cleanAd({ source: 'x'.repeat(60) }).source.length, 40);
  for (const junk of [null, undefined, 'google', ['google'], {}, { medium: 'paid' }, { source: '!!!' }, { source: { x: 1 } }, { source: true }]) {
    assert.equal(cleanAd(junk), null, JSON.stringify(junk));
  }
});

const adOf = (table, id) => ({ ...lair.sql.exec(`SELECT ad_source, ad_medium, ad_campaign FROM ${table} WHERE id = ?`, id).one() });
const memberAd = (id) => ({ ...lair.sql.exec('SELECT ad_source, ad_medium, ad_campaign, ad_at FROM members WHERE customer_id = ?', id).one() });

test('ad tags: a booking or sign-up made from an ad link keeps where it came from, and so does the member: the first they came with, never replaced', async () => {
  const booked = await table(MIA, 'Mia', { ad: { source: 'Google', medium: 'paid', campaign: 'New players' } });
  assert.deepEqual(adOf('bookings', booked.id), { ad_source: 'google', ad_medium: 'paid', ad_campaign: 'new-players' });
  assert.deepEqual(memberAd(MIA), { ad_source: 'google', ad_medium: 'paid', ad_campaign: 'new-players', ad_at: NOW });
  // a sign-up from a Facebook ad later: the sign-up keeps Facebook, Mia keeps Google
  const join = await signUp(MIA, 'Mia', 'quiz', { ad: { source: 'facebook', medium: 'paid', campaign: 'trivia' } });
  assert.deepEqual(adOf('event_joins', join.id), { ad_source: 'facebook', ad_medium: 'paid', ad_campaign: 'trivia' });
  assert.equal(memberAd(MIA).ad_source, 'google');
  // My Lair sends the link's tags once they log in: kept only when they have none
  assert.deepEqual(ok(await call('POST', 'me/ad', { source: 'tiktok', medium: 'paid' }, MIA)), { saved: false });
  assert.deepEqual(ok(await call('POST', 'me/ad', { source: 'tiktok', medium: 'paid' }, KAI)), { saved: true });
  assert.deepEqual(memberAd(KAI), { ad_source: 'tiktok', ad_medium: 'paid', ad_campaign: null, ad_at: NOW });
  assert.deepEqual(ok(await call('POST', 'me/ad', { medium: 'paid' }, RIA)), { saved: false }, 'no source: nothing');
  assert.equal(said(await call('POST', 'me/ad', { source: 'tiktok' })), '401 Log in first.');
  // junk tags never stop a booking, and save nothing
  const junk = await table(RIA, 'Ria', { tables: ['T4'], ad: 'google' });
  assert.deepEqual(adOf('bookings', junk.id), { ad_source: null, ad_medium: null, ad_campaign: null });
  assert.equal(memberAd(RIA).ad_source, null);
  // logged out, a booking keeps its own tags (there's no member to keep them)
  const guest = ok(await call('POST', 'bookings', { kind: 'table', tables: ['T5'], start: at(TODAY, 14), end: at(TODAY, 16), people: 2, name: 'Pat', email: 'pat@example.com', phone: '021 555 0199', pay: 'day', ad: { source: 'reddit', medium: 'paid' } })).booking;
  assert.deepEqual(adOf('bookings', guest.id), { ad_source: 'reddit', ad_medium: 'paid', ad_campaign: null });
  // what staff book for someone isn't from an ad
  const forSomeone = ok(await call('POST', 'bookings', { kind: 'table', tables: ['T6'], start: at(TODAY, 14), end: at(TODAY, 16), people: 2, name: 'Walk Up', email: 'walk@example.com', staffOverride: true, ad: { source: 'google' } }, OWNER)).booking;
  assert.equal(adOf('bookings', forSomeone.id).ad_source, null);
});

/* ---------------- new players in the weekly numbers ---------------- */

// The weeks, by their Mondays: this week so far (Sunday 1 Nov is its last day), then the whole weeks before it
const W0 = '2026-10-26';
const W1 = '2026-10-19';
const W2 = '2026-10-12';
let seq = 0;
/** A booking straight into the store (as test/round19-report.test.js does), on a day at 6pm; checked in unless said */
function visit({ customer = null, day, status = 'seated', people = 1, paidAmount = 0 }) {
  seq += 1;
  const id = `bk_v${seq}`;
  lair.sql.exec(
    `INSERT INTO bookings (id, ref, kind, status, tables, starts_at, ends_at, people, name, paid, paid_amount, customer_id, created_at, updated_at, paid_at)
     VALUES (?, ?, 'table', ?, '["T1"]', ?, ?, ?, 'Someone', ?, ?, ?, ?, ?, ?)`,
    id, `VISIT-${seq}`, status, at(day, 18), at(day, 20), people, paidAmount ? 1 : 0, paidAmount, customer, at(day, 10), at(day, 10), paidAmount ? at(day, 19) : null,
  );
  return id;
}

test('weekly numbers (round 24): new players are people with an account whose first visit was that week, each counted once, by their welcome code, else their first ad, else their answer, else not known', async () => {
  const OWEN = '6005';
  const ZOE = '6006';
  const TIM = '6007';
  for (const [id, name] of [[OWEN, 'Owen Hart'], [ZOE, 'Zoe Bell'], [TIM, 'Tim Fox']]) lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
  // Mia: first came on Tuesday 20 Oct with SCROLL-ROLL, and also told us a friend (the code comes first)
  visit({ customer: MIA, day: '2026-10-20' });
  nowIs(at('2026-10-20', 12));
  ok(await redeem(MIA, 'SCROLL-ROLL'));
  ok(await call('POST', 'me/found-us', { answer: 'friend' }, MIA));
  nowIs(NOW);
  // Kai: first came on Wednesday 21 Oct, from a Google ad
  visit({ customer: KAI, day: '2026-10-21', status: 'confirmed', paidAmount: 1000 });
  lair.sql.exec("UPDATE members SET ad_source = 'google', ad_medium = 'paid' WHERE customer_id = ?", KAI);
  // Owen: first came on Thursday 22 Oct and told the counter he walked past; a no-show the week before never counted
  visit({ customer: OWEN, day: '2026-10-15', status: 'noshow' });
  visit({ customer: OWEN, day: '2026-10-22' });
  ok(await pos('found-us', { customerId: OWEN, answer: 'walked-past' }));
  // Ria: first came on Tuesday 27 Oct and said Instagram; Leo came with her as a named player, and nobody knows how he heard
  const rias = visit({ customer: RIA, day: '2026-10-27', people: 4 });
  lair.sql.exec("INSERT INTO booking_players (id, booking_id, role, position, name, customer_id, created_at) VALUES ('bp_v1', ?, 'player', 1, 'Leo', ?, ?)", rias, LEO, NOW);
  ok(await call('POST', 'me/found-us', { answer: 'instagram' }, RIA));
  // Zoe: came on 13 Oct and again on 28 Oct: new in her first week only
  visit({ customer: ZOE, day: '2026-10-13' });
  visit({ customer: ZOE, day: '2026-10-28' });
  // Tim: came on 1 September, long before these weeks, and again on 23 Oct: never new in them
  visit({ customer: TIM, day: '2026-09-01' });
  visit({ customer: TIM, day: '2026-10-23' });
  // friends without an account (Ria's other two) are visits, never new players
  const data = ok(await call('GET', 'report?weeks=4', null, OWNER));
  const week = (monday) => data.weeks.find((w) => w.week === monday).newPlayers;
  assert.deepEqual(week(W0), { total: 2, codes: {}, ads: {}, answers: { instagram: 1 }, unknown: 1 });
  assert.deepEqual(week(W1), { total: 3, codes: { 'SCROLL-ROLL': 1 }, ads: { 'google/paid': 1 }, answers: { 'walked-past': 1 }, unknown: 0 });
  assert.deepEqual(week(W2), { total: 1, codes: {}, ads: {}, answers: {}, unknown: 1 });
  assert.match(data.words.newPlayer, /first visit/);
  // the Monday email says it beside the week before
  const [, last, before] = data.weeks;
  const lines = Object.fromEntries(lair.weeklyReportContent(last, before, data).body.details);
  assert.equal(lines['New players'], '3 (1 the week before): 1 by welcome code (SCROLL-ROLL 1), 1 by ad link (google/paid 1), 1 told us (Walked past 1)');
  const quiet = Object.fromEntries(lair.weeklyReportContent(data.weeks[0], last, data).body.details);
  assert.equal(quiet['New players'], '2 (3 the week before): 1 told us (Instagram 1), 1 not known');
});

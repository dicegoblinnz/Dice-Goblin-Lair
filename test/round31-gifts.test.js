// Round 31, Christmas gifts (contract v31-gifts), from the parties, families and newcomers work. Mo's calls, 1 and 6 Nov
// 2026: two experience gifts sold as products, "Your first roleplaying game" ($30: a seat at any beginner game and a set
// of dice up to $30 to keep, "so effectively it would look like the session is free") and "Learn to paint" ($10: a seat
// at Learn to paint with the Lair's miniature, brushes and paints); email only, like the session gift; "3 years,
// experience honoured" (a gift still covers its experience if prices go up). He approved the mockups on 6 Nov 2026
// ("Yes, as drawn"): the gift email, the product pages and the gifts in My Lair's Wallet.
//
// The rules these checks hold the Lair to:
//  - An order line LAIR-XP-FIRSTGAME or LAIR-XP-PAINT (online or at the counter) makes one gift a unit, unlinked, once per
//    order, line and unit; the buyer gets every code by email ("Your gift is ready"), or the staff do.
//  - New Zealand's Fair Trading Act (gift cards and vouchers sold since 16 March 2026): at least 3 years, and the date
//    shown. Every gift lasts until the end of its sale day 3 years on, Lair time (29 February: 1 March), session gifts too.
//  - A gift's code is a bearer code worth money, so it's long enough that guessing one is hopeless.
//  - Your first roleplaying game covers one person's whole TTRPG seat, GM's fee and all (its GM is still credited), and
//    staff are reminded about the dice; Learn to paint covers one person's entry at Learn to paint; neither covers
//    anything else; staff can use one with nothing booked (a kid at the kids' table); undo puts it back.
//  - My Lair shows what each gift is, who it's from and its use-by date (Learn to paint: its next class).
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { GIFT_KINDS, GIFT_WORDS, giftUseBy } from '../src/experience-gifts.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Friday 6 November 2026, 2pm in Auckland (NZDT): the gifts go on sale
const NOW = at('2026-11-06', 14);
// the end of 6 November 2029 in Auckland: the use-by of a gift sold today
const USE_BY = at('2029-11-07', 0) - 1;
const SUN = '2026-11-08';
const realNow = Date.now;
const realFetch = globalThis.fetch;
const nowIs = (ms) => {
  Date.now = () => ms;
};
const ADDRESS = '56/691 Manukau Road, Royal Oak, Auckland 1023';

/* ---------------- helpers, as in test/round29-firstgame.test.js and test/round30-library.test.js ---------------- */
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
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) }, waitUntil: () => {} };
}

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 21, seats: 4, order: 1 }];
// Learn to paint as it is in Shopify (lair_event learn-to-paint): the first Thursday of the month from 5 Nov 2026, 6 to
// 8pm, 8 seats, $10 at the counter. Blood on the Clocktower: another $10 event with sign-ups.
const PAINT = {
  id: 'learn-to-paint', title: 'Learn to paint', start: at('2026-11-05', 18), end: at('2026-11-05', 20), repeat: 'monthly', tables: '', capacity: 8,
  entryFee: 1000, payment: 'store', type: 'learn',
};
const CLOCKTOWER = { id: 'blood-on-the-clocktower', title: 'Blood on the Clocktower', start: at('2026-11-29', 12), end: at('2026-11-29', 18), tables: '', capacity: 40, entryFee: 1000, payment: 'store', type: 'social' };
// (review) a painting night that isn't Learn to paint: $40, sign-ups, "paint" in its name
const MASTERCLASS = { id: 'painting-masterclass', title: 'Painting masterclass', start: at('2026-11-26', 18), end: at('2026-11-26', 21), tables: '', capacity: 10, entryFee: 4000, payment: 'store', type: 'learn' };
const PAINT_DEC = 'learn-to-paint@2026-12-03';
const SETTINGS = { lair_hours: DEFAULT_HOURS, lair_shop_tables: '', store_phone: '021 159 6894' };
const rulesWith = (events = [PAINT, CLOCKTOWER, MASTERCLASS]) => rulesFromSettings(SETTINGS, ROOMS, events, { address: ADDRESS });
// People by their Shopify customer IDs (made up): the main account, a trusted GM (Ellie) and four members
const OWNER = '9001';
const GM = '7001';
const SAM = '6001';
const RIA = '6002';
const KAI = '6003';
const LEO = '6004';
const NAMES = { [OWNER]: 'Mo Ashgrove', [GM]: 'Ellie Rua', [SAM]: 'Sam Jones', [RIA]: 'Ria Moana', [KAI]: 'Kai Tane', [LEO]: 'Leo Park' };
const MOBILE = '021 555 0100';
const emailOf = (name) => `${name.split(' ')[0].toLowerCase()}@example.com`;

let lair;
let mail;
/** GM credit asked to go now (gmCreditSoon), counted here: the GM credit runs themselves are round 21's and 30's checks */
let creditSoon = 0;
async function call(method, path, body, customer = '', extraHeaders = {}) {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  }));
  const type = response.headers.get('Content-Type') || '';
  return { status: response.status, data: type.includes('json') ? await response.json() : await response.text() };
}
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error || JSON.stringify(res.data));
  return res.data;
};
const internal = (path, body) => call('POST', `internal/${path}`, body, '', { 'X-Lair-Internal': '1', 'X-Lair-Pos-User': 'Counter' });
const settle = () => new Promise((r) => setTimeout(r, 10));

/** Every email, as Resend got it; bounce(address) makes Resend refuse emails to that address (422) until bounce(null) */
function captureEmails() {
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test' };
  const sent = [];
  const reached = [];
  let refused = null;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.resend.com/')) {
      reached.push(String(url));
      throw new Error(`No network in tests: ${url}`);
    }
    const body = JSON.parse(init.body);
    const list = Array.isArray(body) ? body : [body];
    if (refused && list.some((m) => m.to[0] === refused)) return new Response(JSON.stringify({ message: 'The to address is invalid.' }), { status: 422 });
    for (const m of list) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return { sent, reached, bounce: (address) => { refused = address; } };
}

/* ---------------- orders ---------------- */
const order = (n, lines, extra = {}) => ({ id: n, admin_graphql_api_id: `gid://shopify/Order/${n}`, name: `#${n}`, source_name: 'web', line_items: lines, ...extra });
const line = (id, sku, quantity, price, extra = {}) => ({ id, sku, quantity, price, title: 'Gift', properties: [], ...extra });
/** Who Shopify says bought an order (its email and first name), by order number; anything else: nobody */
let buyers = {};
const paid = async (o) => ok(await internal('orders-paid', o));
/** A pass as staff see it, by its code */
const passNamed = async (code) => ok(await call('GET', `passes?status=all&q=${encodeURIComponent(code)}`, null, OWNER)).passes.find((p) => p.code === code);
/** Sam buys gifts online: order #1700 → the codes made */
async function samBuys(lines, n = 1700) {
  buyers[`gid://shopify/Order/${n}`] = { name: `#${n}`, email: 'sam.jones@example.com', firstName: 'Sam' };
  return (await paid(order(n, lines))).gifts;
}
const firstGameGift = async () => (await samBuys([line(17001, 'LAIR-XP-FIRSTGAME', 1, '30.00')]))[0];
const paintGift = async (n = 1701) => (await samBuys([line(n * 10 + 1, 'LAIR-XP-PAINT', 1, '10.00')], n))[0];
/** Someone adds a gift in My Lair ("Got a code?") */
const redeem = async (code, who) => ok(await call('POST', 'me/codes/redeem', { code }, who));

/* ---------------- what's booked ---------------- */
/** A TTRPG session Ellie lists (a trusted GM: straight on the board): Sunday 6 to 10pm, $15 a seat ($5 of it her fee) */
async function game(more = {}) {
  return ok(await call('POST', 'games', {
    title: 'Candlekeep Mysteries', system: 'D&D 5e', gm: 'Ellie', email: 'ellie@example.com', blurb: 'A library full of secrets.', seats: 4,
    tables: ['T12'], start: at(SUN, 18), end: at(SUN, 22), schedule: 'one-shot', characters: 'pregens', ...more,
  }, GM)).game;
}
async function seat(gameId, who, more = {}) {
  return ok(await call('POST', 'bookings', { kind: 'gm-seat', gameId, people: 1, name: NAMES[who], email: emailOf(NAMES[who]), phone: MOBILE, ...more }, who)).booking;
}
async function table(who, more = {}) {
  return ok(await call('POST', 'bookings', {
    kind: 'table', tables: ['T3'], start: at(SUN, 13), end: at(SUN, 15), people: 2, name: NAMES[who], email: emailOf(NAMES[who]), phone: MOBILE, pay: 'day', ...more,
  }, who)).booking;
}
const bookingRow = (id) => lair.sql.exec('SELECT * FROM bookings WHERE id = ?', id).toArray()[0];
const joinRow = (id) => lair.sql.exec('SELECT * FROM event_joins WHERE id = ?', id).toArray()[0];
/** A sign-up for an event date, as the events page makes it */
async function signUp(occurrenceId, who, body = {}) {
  return ok(await call('POST', `events/${occurrenceId}/join`, { name: NAMES[who], email: emailOf(NAMES[who]), phone: MOBILE, people: 1, ...body }, who)).join;
}
/** The counter (the POS) checks a booking in, with a pass or gift code when one's given */
const posCheckIn = (id, type, pass) => internal('pos/checkin', { id, type, ...(pass ? { pass } : {}) });
/** The staff page checks a row in */
const staffCheckIn = (id, type, pass) => call('POST', 'checkin', { id, type, ...(pass ? { pass } : {}) }, OWNER);

beforeEach(() => {
  nowIs(NOW);
  buyers = {};
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'example-shop.myshopify.com' });
  mail = captureEmails();
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: id === GM, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.orderGiftBuyer = async (id) => buyers[id] || null;
  lair.shopify.customerEmail = async () => null;
  lair.shopify.customersSince = async () => new Map();
  lair.accountEmail = async () => ({ fetched: false, email: '' });
  lair.checkGiftCodes = async () => 0;
  creditSoon = 0;
  lair.gmCreditSoon = () => {
    creditSoon += 1;
    return null;
  };
  lair.rulesCache = rulesWith();
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  for (const [id, name] of Object.entries(NAMES)) lair.makeMember({ customerId: id, name, email: emailOf(name) }, NOW);
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(mail.reached, [], 'nothing but Resend was reached');
});

/* ================ on start ================ */

test('round 31, gifts: the columns are made on start (a pass\'s kind and who it\'s from, what a pass covered on a sign-up, a use\'s sign-up and note), and a second start changes nothing', () => {
  const cols = (t) => lair.sql.exec(`SELECT name FROM pragma_table_info('${t}')`).toArray().map((c) => c.name);
  for (const c of ['kind', 'gift_from']) assert.ok(cols('passes').includes(c), `passes.${c}`);
  for (const c of ['covered', 'pass_id']) assert.ok(cols('event_joins').includes(c), `event_joins.${c}`);
  for (const c of ['join_id', 'note']) assert.ok(cols('pass_uses').includes(c), `pass_uses.${c}`);
  assert.doesNotThrow(() => lair.migrate());
});

/* ================ sold as products ================ */

test('round 31, gifts: LAIR-XP-FIRSTGAME and LAIR-XP-PAINT lines make one unlinked gift a unit (whoever bought them), with its kind, who it\'s from, what it cost and a use-by 3 years on; a repeated webhook makes nothing new', async () => {
  buyers['gid://shopify/Order/1700'] = { name: '#1700', email: 'sam.jones@example.com', firstName: 'Sam' };
  // Sam is logged in: the order is his spend, but the gifts aren't his
  lair.shopify.orderSpend = async () => ({ customerId: SAM, amount: 7000, source: 'web', name: '#1700' });
  const o = order(1700, [
    line(17001, 'LAIR-XP-FIRSTGAME', 2, '30.00'),
    line(17002, 'lair-xp-paint', 1, '10.00', { discount_allocations: [{ amount: '1.00' }] }),
    line(17003, 'DICE-1', 1, '20.00'),
    line(17004, 'LAIR-XP-FIRSTGAME', 0, '30.00'),
    line(17005, 'LAIR-XP-BUNGEE', 1, '99.00'),
  ]);
  const first = await paid(o);
  assert.equal(first.gifts.length, 3, 'two first games and one paint; a quantity of 0 and a kind the Lair doesn\'t know make none');
  assert.deepEqual(first.passes, [], 'no session passes');
  const passes = await Promise.all(first.gifts.map(passNamed));
  assert.deepEqual(passes.map((p) => [p.label, p.kind, p.sessionsTotal, p.source, p.pricePaid, p.orderName, p.note, p.from, p.status, p.expiresAt]), [
    ['Gift: Your first roleplaying game', 'first-game', 1, 'gift', 3000, '#1700', 'A gift from Sam', 'Sam', 'active', USE_BY],
    ['Gift: Your first roleplaying game', 'first-game', 1, 'gift', 3000, '#1700', 'A gift from Sam', 'Sam', 'active', USE_BY],
    ['Gift: Learn to paint', 'paint', 1, 'gift', 900, '#1700', 'A gift from Sam', 'Sam', 'active', USE_BY],
  ]);
  assert.ok(passes.every((p) => !p.holder.customerId && !p.holder.name && !p.holder.email), 'unlinked: the buyer gives them away');
  assert.deepEqual(passes.map((p) => p.name), ['Your first roleplaying game', 'Your first roleplaying game', 'Learn to paint']);
  assert.deepEqual(passes.map((p) => p.covers), [GIFT_KINDS['first-game'].staff, GIFT_KINDS['first-game'].staff, GIFT_KINDS.paint.staff]);
  // the kind the Lair doesn't know is noted for the health check, never guessed at
  assert.match(JSON.stringify(lair.statusSeen.unknownGift), /LAIR-XP-BUNGEE.*#1700/);
  await settle();
  assert.equal(mail.sent.length, 1, 'one email for the order');
  // Shopify sends the webhook again: nothing new, and no second email
  const again = await paid(o);
  assert.deepEqual(again.gifts, []);
  await settle();
  assert.equal(mail.sent.length, 1);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM passes WHERE source = 'gift'").one().n, 3);
});

test('round 31, gifts: a gift\'s code is long enough to be safe to hand on (DG, a word and 4 letters or digits: never one that reads as 0, O, 1, I or L), and the session gift\'s too', async () => {
  const codes = await samBuys([line(17001, 'LAIR-XP-FIRSTGAME', 30, '30.00'), line(17002, 'LAIR-GIFT-5', 3, '50.00')]);
  assert.equal(codes.length, 33);
  for (const code of codes) assert.match(code, /^DG-[A-Z]{3,9}-[A-HJKMNP-Z2-9]{4}$/, code);
  assert.equal(new Set(codes).size, 33, 'every code is its own');
  // each one is found however it's typed
  const typed = codes[0].toLowerCase().replace(/-/g, ' ');
  assert.equal((await redeem(typed, RIA)).pass.code, codes[0]);
});

test('round 31, gifts: use by the end of the sale day 3 years on, Lair time: a sale late at night keeps its day, 29 February becomes 1 March, and session gifts get it too', async () => {
  // just before midnight on 6 November in Auckland (11:30am UTC): still 6 November
  assert.equal(giftUseBy(at('2026-11-06', 23, 30), TZ), USE_BY);
  // just after midnight: 7 November
  assert.equal(giftUseBy(at('2026-11-07', 0, 5), TZ), at('2029-11-08', 0) - 1);
  // 29 February 2028 → there's no 29 February 2031, so 1 March 2031 (at least 3 years)
  assert.equal(giftUseBy(at('2028-02-29', 12), TZ), at('2031-03-02', 0) - 1);
  // across a daylight saving change (NZST in June): still the end of that day in Auckland
  assert.equal(giftUseBy(at('2027-06-15', 9), TZ), at('2030-06-16', 0) - 1);
  // a session gift (LAIR-GIFT-N) sold now lasts 3 years as well, and its email says so
  const [code] = await samBuys([line(17001, 'LAIR-GIFT-5', 1, '50.00')]);
  assert.equal((await passNamed(code)).expiresAt, USE_BY);
  await settle();
  assert.match(mail.sent[0].text, /Use by 6 November 2029/);
});

test('round 31, gifts: one gift: "Your gift is ready", as drawn (mockup GiftEmail): its name, code, what it covers and use-by in the box, how to use it, the button to beginner games and the promise if prices go up', async () => {
  const code = await firstGameGift();
  await settle();
  assert.equal(mail.sent.length, 1);
  const [m] = mail.sent;
  assert.deepEqual([m.to, m.subject], ['sam.jones@example.com', 'Your gift is ready']);
  const k = GIFT_KINDS['first-game'];
  for (const text of [
    'Kia ora Sam, thanks for buying a gift from the Lair. Gobgob wrapped it themselves.',
    'Pass it on however you like: forward this email, print it, or write the code in a card.',
    'YOUR FIRST ROLEPLAYING GAME', code, 'A seat at any beginner game at the Lair, and a set of dice to keep.', 'Use by 6 November 2029',
    'How to use it:', 'Log in at dicegoblin.nz, open My Lair › Wallet and enter the code under "Got a code?". Or just show it at the counter.',
    "Kids 8 to 14:", "Kids' games, weekdays 4 to 6pm. Staff look after them until pick-up.",
    'Teens and adults:', 'Any game that takes beginners. Under-14s come with a grown-up.',
    'The dice:', 'Picked at the counter on the day: any set up to $30.',
    'See beginner games: https://www.dicegoblin.nz/pages/gm-games',
    'If prices go up, the gift still covers the game. If the Lair ever stops running beginner games, it becomes store credit for what you paid.',
    'See you at the Lair!\nGobgob, the Dice Goblin',
  ]) assert.ok(m.text.includes(text), `the email says: ${text}`);
  assert.equal(k.covers, 'A seat at any beginner game at the Lair, and a set of dice to keep.');
  // the box, as drawn: the name small above the code, the code big, the use-by in bold
  assert.match(m.html, /border:2px dashed #1f7a3d/);
  assert.match(m.html, />YOUR FIRST ROLEPLAYING GAME</);
  assert.match(m.html, new RegExp(`font:800 30px[^>]*>${code}<`));
  assert.match(m.html, /font:700 15px[^>]*>Use by 6 November 2029</);
  assert.doesNotMatch(m.text, /session gift/i);
});

test('round 31, gifts: a Learn to paint gift\'s email has its own details and a button to its next class; gifts of both kinds share one email; no email on the order or one that bounces: the staff get the codes', async () => {
  const code = await paintGift();
  await settle();
  const [m] = mail.sent;
  assert.equal(m.subject, 'Your gift is ready');
  for (const text of [
    'LEARN TO PAINT', code, "A seat at Learn to paint, with the Lair's miniature, brushes and paints.", 'Use by 6 November 2029',
    'Learn to paint:', 'Next class: Thursday 3 December, 6 to 8pm. 8 seats, so book ahead.',
    'Who can paint:', 'Ages 8 and up. Under-12s come with a grown-up, who watches free.',
    'Keep the miniature:', '$5 more on the night, or $20 for a large one.',
    `See the next class: https://www.dicegoblin.nz/pages/events-calendar#event=${encodeURIComponent(PAINT_DEC)}`,
    'If prices go up, the gift still covers the class. If the Lair ever stops running Learn to paint, it becomes store credit for what you paid.',
  ]) assert.ok(m.text.includes(text), `the email says: ${text}`);
  // both kinds on one order: one email, every code, both sets of details, and My Lair's button
  mail.sent.length = 0;
  const both = await samBuys([line(17101, 'LAIR-XP-FIRSTGAME', 1, '30.00'), line(17102, 'LAIR-XP-PAINT', 2, '10.00')], 1710);
  await settle();
  assert.equal(mail.sent.length, 1);
  const [many] = mail.sent;
  assert.equal(many.subject, 'Your gifts are ready');
  for (const c of both) assert.ok(many.text.includes(c), c);
  for (const text of [
    'Kia ora Sam, thanks for buying gifts from the Lair. Gobgob wrapped them themselves.',
    'Pass them on however you like: forward this email, print it, or write each code in a card.',
    'The dice:', 'Keep the miniature:', 'Open My Lair: https://www.dicegoblin.nz/pages/my-lair',
    "If prices go up, each gift still covers what it's for. If the Lair ever stops running one, it becomes store credit for what you paid.",
  ]) assert.ok(many.text.includes(text), `the email says: ${text}`);
  assert.equal((many.text.match(/How to use it:/g) || []).length, 1, 'how to use them, once');
  // rung up at the counter with no email on the order (and nobody logged in): the staff get the code to pass on
  mail.sent.length = 0;
  const counter = await paid({ ...order(1720, [line(17201, 'LAIR-XP-FIRSTGAME', 1, '30.00')]), source_name: 'pos' });
  await settle();
  assert.deepEqual(mail.sent.map((x) => [x.to, x.subject]), [['staff@dicegoblin.test', 'Gift codes to pass on: #1720']]);
  assert.ok(mail.sent[0].text.includes(counter.gifts[0]) && /no email address on the order/.test(mail.sent[0].text) && /Use by 6 November 2029/.test(mail.sent[0].text));
  assert.equal((await passNamed(counter.gifts[0])).from, null, 'no first name, no "from"');
  // the email bounces: the staff get it, and say why
  mail.sent.length = 0;
  mail.bounce('ari@example.com');
  buyers['gid://shopify/Order/1730'] = { name: '#1730', email: 'ari@example.com', firstName: 'Ari' };
  const bounced = await paid(order(1730, [line(17301, 'LAIR-XP-PAINT', 1, '10.00')]));
  await settle();
  await settle();
  mail.bounce(null);
  assert.deepEqual(mail.sent.map((x) => x.to), ['staff@dicegoblin.test'], 'only the staff got it');
  const [staff] = mail.sent;
  assert.equal(staff.subject, 'Gift codes to pass on: #1730');
  assert.ok(staff.text.includes(bounced.gifts[0]) && /couldn't be emailed to ari@example\.com/.test(staff.text));
});

/* ================ in My Lair ================ */

test('round 31, gifts: added in My Lair ("Got a code?"), a gift says what it is, who it\'s from and its use-by; Learn to paint says when the next class is', async () => {
  const fg = await firstGameGift();
  const paint = await paintGift();
  const added = await redeem(fg, RIA);
  assert.equal(added.kind, 'pass');
  assert.equal(added.message, 'Added to your wallet: Your first roleplaying game. Use it by 6 November 2029.');
  await redeem(paint, RIA);
  const passes = ok(await call('GET', 'me', null, RIA)).passes;
  const mine = Object.fromEntries(passes.map((p) => [p.code, p]));
  assert.deepEqual(
    [mine[fg].kind, mine[fg].name, mine[fg].from, mine[fg].expiresAt, mine[fg].status, mine[fg].sessionsLeft, mine[fg].source],
    ['first-game', 'Your first roleplaying game', 'Sam', USE_BY, 'active', 1, 'gift'],
  );
  assert.equal(mine[fg].next, undefined, 'no class to come for a first game');
  assert.deepEqual([mine[paint].kind, mine[paint].name, mine[paint].from], ['paint', 'Learn to paint', 'Sam']);
  assert.deepEqual(mine[paint].next, { occurrenceId: PAINT_DEC, title: 'Learn to paint', start: at('2026-12-03', 18), full: false });
  assert.equal(mine[paint].note, undefined, 'the buyer\'s note stays with staff');
  // someone else can't take it now it's hers
  assert.equal((await call('POST', 'me/codes/redeem', { code: fg }, KAI)).status, 409);
});

/* ================ at the counter ================ */

test('round 31, gifts: Your first roleplaying game covers one person\'s whole TTRPG seat at check-in, GM\'s fee and all, so the seat is paid and its GM is credited; staff are reminded about the dice; undo puts it back', async () => {
  const code = await firstGameGift();
  await redeem(code, RIA);
  const g = await game();
  const s = await seat(g.id, RIA);
  assert.equal(bookingRow(s.id).amount, 1500, 'a $15 seat: $10 table and $5 for the GM');
  nowIs(at(SUN, 18, 5));
  // scanned on its own first, the gift's code says what it is and that it's ready (not "1 session left of 1")
  const scanned = ok(await call('POST', 'checkin', { code }, OWNER));
  assert.deepEqual([scanned.kind, scanned.pass.kind, scanned.message], ['pass', 'first-game', 'Gift: Your first roleplaying game, ready to use.']);
  const r = ok(await posCheckIn(s.id, 'booking', code));
  assert.equal(r.checkedIn, true);
  assert.deepEqual([r.pass.code, r.pass.used, r.pass.left, r.pass.covered, r.pass.kind], [code, 1, 0, 1500, 'first-game']);
  assert.equal(r.notice, GIFT_WORDS.dice);
  assert.deepEqual(r.lines, [], 'nothing to ring up for the seat');
  const after = bookingRow(s.id);
  assert.deepEqual([after.covered, after.paid, after.amount], [1500, 1, 1500]);
  // the GM's fee is part of what the gift paid: the seat is ready for Ellie's credit, as any paid seat is, and it's
  // asked to go now, as when a seat is paid at the counter
  assert.deepEqual(lair.gmCreditReady(Date.now(), lair.rulesCache, g.id).map((x) => x.booking_id), [s.id]);
  assert.equal(creditSoon, 1);
  assert.equal((await passNamed(code)).status, 'used');
  assert.equal(ok(await call('POST', 'checkin', { code }, OWNER)).message, 'Gift: Your first roleplaying game, used.');
  // undo: the seat owes its $15 again, and the gift is back
  const use = (await passNamed(code)).uses[0];
  assert.deepEqual([use.bookingId, use.joinId, use.people, use.covered], [s.id, null, 1, 1500]);
  // (review) by then Ellie has her $5 for the seat: taking the gift off tells staff, as unmarking a paid seat does
  // (src/gm-credit.js gmCreditUndone), since the player now owes for a seat its GM was paid for
  lair.sql.exec(
    "INSERT INTO gm_credit_seats (booking_id, game_id, customer_id, people, amount, status, batch, note, tries, created_at, updated_at) VALUES (?, ?, ?, 1, 500, 'credited', 'b1', NULL, 0, ?, ?)",
    s.id, g.id, GM, Date.now(), Date.now(),
  );
  const alerts = [];
  lair.notifyStaff = (subject) => alerts.push(subject);
  ok(await call('POST', `passes/uses/${use.id}/undo`, {}, OWNER));
  assert.deepEqual([bookingRow(s.id).covered, bookingRow(s.id).paid], [0, 0]);
  assert.equal((await passNamed(code)).status, 'active');
  assert.equal(alerts.length, 1, 'staff hear the GM was credited for a seat that owes again');
  assert.match(alerts[0], /^GM credit to check: /);
});

test('round 31, gifts: a session pass still covers only the table part of a seat (the GM\'s fee is paid), so the GM isn\'t credited until it is', async () => {
  const pass = ok(await call('POST', 'passes', { label: 'Session pass', sessions: 5, customerId: RIA }, OWNER)).pass;
  const g = await game();
  const s = await seat(g.id, RIA);
  nowIs(at(SUN, 18, 5));
  const r = ok(await posCheckIn(s.id, 'booking', pass.code));
  assert.equal(r.pass.covered, 1000);
  assert.equal(r.notice, null);
  assert.deepEqual([bookingRow(s.id).covered, bookingRow(s.id).paid], [1000, 0]);
  assert.deepEqual(lair.gmCreditReady(Date.now(), lair.rulesCache, g.id), []);
  assert.equal(creditSoon, 0);
});

test('round 31, gifts: a gift covers nothing it isn\'t for: Your first roleplaying game on a table or an event sign-up, Learn to paint on a seat; nothing is used and the counter is told why', async () => {
  const fg = await firstGameGift();
  const paint = await paintGift();
  await redeem(fg, KAI);
  await redeem(paint, KAI);
  const t = await table(KAI);
  const g = await game();
  const s = await seat(g.id, KAI);
  nowIs(at(SUN, 13, 5));
  const onTable = ok(await posCheckIn(t.id, 'booking', fg));
  assert.deepEqual([onTable.pass, onTable.notice], [null, GIFT_WORDS.notFor('first-game')]);
  nowIs(at(SUN, 18, 5));
  const paintOnSeat = ok(await posCheckIn(s.id, 'booking', paint));
  assert.deepEqual([paintOnSeat.pass, paintOnSeat.notice], [null, GIFT_WORDS.notFor('paint')]);
  assert.equal(bookingRow(s.id).covered, 0);
  for (const code of [fg, paint]) assert.equal((await passNamed(code)).status, 'active', `${code} is still to use`);
  assert.equal(GIFT_WORDS.notFor('first-game'), 'This gift is for a seat at a roleplaying game, so it wasn\'t used here.');
  assert.equal(GIFT_WORDS.notFor('paint'), 'This gift is for a seat at Learn to paint, so it wasn\'t used here.');
  // saved on a booking made online: only on what it's for
  nowIs(NOW);
  assert.equal(said(await call('POST', 'bookings', { kind: 'table', tables: ['T4'], start: at(SUN, 13), end: at(SUN, 15), people: 1, name: 'Kai Tane', email: 'kai@example.com', phone: MOBILE, pay: 'day', usePass: fg }, KAI)), `422 ${GIFT_WORDS.notFor('first-game')}`);
  assert.equal(said(await call('POST', 'bookings', { kind: 'gm-seat', gameId: g.id, people: 1, name: 'Kai Tane', email: 'kai@example.com', phone: MOBILE, usePass: paint }, KAI)), `422 ${GIFT_WORDS.notFor('paint')}`);
});

test('round 31, gifts: saved on a TTRPG seat booked online, Your first roleplaying game covers it when they check in, with nothing chosen at the counter', async () => {
  const code = await firstGameGift();
  await redeem(code, LEO);
  const g = await game();
  const s = await seat(g.id, LEO, { usePass: code });
  assert.equal(bookingRow(s.id).pass_id, lair.passByCode(code).id);
  nowIs(at(SUN, 18, 5));
  const r = ok(await posCheckIn(s.id, 'booking'));
  assert.deepEqual([r.pass.code, r.pass.covered, r.notice], [code, 1500, GIFT_WORDS.dice]);
  assert.equal(bookingRow(s.id).paid, 1);
});

test('round 31, gifts: Learn to paint covers one person\'s entry on a Learn to paint sign-up at check-in (staff page or counter); a session pass never covers event entry; undo puts it back', async () => {
  const code = await paintGift();
  await redeem(code, KAI);
  const j = await signUp(PAINT_DEC, KAI, { people: 2 });
  assert.equal(joinRow(j.id).amount, 2000);
  nowIs(at('2026-12-03', 18, 5));
  const r = ok(await staffCheckIn(j.id, 'join', code));
  assert.equal(r.checkedIn, true);
  assert.deepEqual([r.pass.code, r.pass.used, r.pass.left, r.pass.covered, r.pass.kind], [code, 1, 0, 1000, 'paint']);
  assert.deepEqual([r.row.covered, r.row.due, r.row.paid], [1000, 1000, false], 'their friend still pays $10');
  assert.equal(r.row.pass.code, code);
  assert.equal(r.notice, null);
  assert.deepEqual([joinRow(j.id).covered, joinRow(j.id).pass_id], [1000, lair.passByCode(code).id]);
  // the counter rings up only what's left, and the receipt says the gift covered the rest
  const pos = ok(await posCheckIn(j.id, 'join'));
  assert.deepEqual(pos.lines.map((l) => [l.price, l.title.endsWith('(gift covered $10)')]), [['10.00', true]]);
  assert.equal(pos.row.due, 1000);
  // undo: they owe $20 again, and the gift is back
  const use = (await passNamed(code)).uses[0];
  assert.deepEqual([use.bookingId, use.joinId, use.covered], [null, j.id, 1000]);
  ok(await call('POST', `passes/uses/${use.id}/undo`, {}, OWNER));
  assert.deepEqual([joinRow(j.id).covered, joinRow(j.id).paid], [0, 0]);
  assert.equal((await passNamed(code)).status, 'active');
  // a sign-up for one, covered in full: paid
  const solo = await signUp(PAINT_DEC, LEO);
  const r2 = ok(await staffCheckIn(solo.id, 'join', code));
  assert.deepEqual([r2.row.covered, r2.row.due, r2.row.paid], [1000, 0, true]);
  // a session pass on a sign-up: as ever, event entry isn't covered
  const pass = ok(await call('POST', 'passes', { label: 'Session pass', sessions: 5, customerId: KAI }, OWNER)).pass;
  const other = await signUp(PAINT_DEC, SAM);
  const r3 = ok(await staffCheckIn(other.id, 'join', pass.code));
  assert.deepEqual([r3.pass, r3.notice, joinRow(other.id).covered], [null, "Passes don't cover event entry, so no pass was used.", 0]);
});

test('round 31, gifts: Learn to paint covers no other event, and Your first roleplaying game covers no sign-up', async () => {
  const paint = await paintGift();
  const fg = await firstGameGift();
  const clock = await signUp('blood-on-the-clocktower@2026-11-29', KAI);
  nowIs(at('2026-11-29', 12, 5));
  const r = ok(await staffCheckIn(clock.id, 'join', paint));
  assert.deepEqual([r.pass, r.notice, joinRow(clock.id).covered], [null, GIFT_WORDS.notFor('paint'), 0]);
  nowIs(NOW);
  const painting = await signUp(PAINT_DEC, KAI);
  nowIs(at('2026-12-03', 18, 5));
  const r2 = ok(await staffCheckIn(painting.id, 'join', fg));
  assert.deepEqual([r2.pass, r2.notice], [null, GIFT_WORDS.notFor('first-game')]);
  assert.equal((await passNamed(paint)).status, 'active');
  // (review) the gift is "a seat at Learn to paint" (its email, page and contract): another painting night, here a $40
  // masterclass, is not Learn to paint, so it isn't covered
  nowIs(NOW);
  const master = await signUp('painting-masterclass@2026-11-26', KAI);
  nowIs(at('2026-11-26', 18, 5));
  const r3 = ok(await staffCheckIn(master.id, 'join', paint));
  assert.deepEqual([r3.pass, r3.notice, joinRow(master.id).covered], [null, GIFT_WORDS.notFor('paint'), 0]);
  assert.equal((await passNamed(paint)).status, 'active');
});

test('round 31, gifts: a walk-in at Learn to paint is checked in, then the gift covers their entry', async () => {
  const code = await paintGift();
  const { code: memberCode } = lair.memberRow(LEO);
  nowIs(at('2026-12-03', 18, 10));
  const walk = ok(await call('POST', `events/${PAINT_DEC}/attend`, { code: memberCode }, OWNER));
  assert.equal(walk.row.due, 1000);
  const r = ok(await staffCheckIn(walk.join.id, 'join', code));
  assert.deepEqual([r.pass.covered, r.row.due, r.row.paid], [1000, 0, true]);
});

test('round 31, gifts: "Use it now": staff use a gift with nothing booked (a kid at the kids\' table), once; only gifts, only staff; undo puts it back', async () => {
  const code = await firstGameGift();
  const p = lair.passByCode(code);
  assert.equal(said(await call('POST', `passes/${p.id}/use`, { note: "Kids' game" }, KAI)), '403 Staff only. Log in with your staff account.');
  const r = ok(await call('POST', `passes/${p.id}/use`, { note: "Kids' game, Wednesday" }, OWNER));
  assert.deepEqual([r.pass.status, r.pass.sessionsLeft], ['used', 0]);
  assert.equal(r.message, GIFT_WORDS.usedNow('first-game'));
  const use = r.pass.uses[0];
  assert.deepEqual([use.bookingId, use.joinId, use.covered, use.note], [null, null, 0, "Kids' game, Wednesday"]);
  // once
  assert.equal(said(await call('POST', `passes/${p.id}/use`, {}, OWNER)), '409 That gift has been used. Undo its use first if that was a mistake.');
  // a session pass is used at check-in, on what it covers
  const pass = ok(await call('POST', 'passes', { label: 'Session pass', sessions: 5, customerId: KAI }, OWNER)).pass;
  assert.equal(said(await call('POST', `passes/${pass.id}/use`, {}, OWNER)), `422 ${GIFT_WORDS.onlyGifts}`);
  // undo
  ok(await call('POST', `passes/uses/${use.id}/undo`, {}, OWNER));
  assert.equal((await passNamed(code)).status, 'active');
  // past its use-by, it can't be used
  nowIs(USE_BY + 1);
  assert.equal(said(await call('POST', `passes/${p.id}/use`, {}, OWNER)), '409 That gift expired on 6 November 2029.');
});

test('round 31, gifts: past its use-by, a gift isn\'t used at check-in (a seat or a sign-up) and the counter is told when it ran out', async () => {
  const code = await firstGameGift();
  const paint = await paintGift();
  await redeem(code, RIA);
  await redeem(paint, RIA);
  const g = await game();
  const s = await seat(g.id, RIA);
  const j = await signUp(PAINT_DEC, RIA);
  // (as if Sunday and 3 December were 3 years on: their use-by is the Saturday before)
  lair.sql.exec("UPDATE passes SET expires_at = ? WHERE source = 'gift'", at('2026-11-08', 0) - 1);
  nowIs(at(SUN, 18, 5));
  const r = ok(await posCheckIn(s.id, 'booking', code));
  assert.deepEqual([r.pass, r.notice], [null, `Pass ${code} expired on 7 November 2026, so it wasn't used.`]);
  nowIs(at('2026-12-03', 18, 5));
  const r2 = ok(await staffCheckIn(j.id, 'join', paint));
  assert.deepEqual([r2.pass, r2.notice], [null, `Pass ${paint} expired on 7 November 2026, so it wasn't used.`]);
});

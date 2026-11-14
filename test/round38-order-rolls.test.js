// Round 38: d20 rolls on online orders, and a second order in the same parcel (contract v38-order-rolls). Mo (14 Nov
// 2026), settling the shop's deals: "The $200 spend is online only no in-store correlation", "magic boxes always give a
// dice per $100 sold and anything else will be $200 normally and $100 if it was a special season thing", "The $200 is
// for a transaction not a running total", "they get the dice after purchase. And credit is immediately in Thier
// account", and "give them the ability to buy more products within the hour to add the items inside the same package if
// they chose to. To save on shipping again." Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, parseDoubleDays, DEFAULT_HOURS } from '../src/core.js';
import { ORDER_ROLLS, ORDER_ROLL_WORDS as W, isMagicBox, orderRollCount, orderRollLines, doubleDayOn, parcelCode } from '../src/order-rolls.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Friday 20 November 2026, 1:00pm in Auckland (NZDT, UTC+13): an ordinary day
const NOW = at('2026-11-20', 13);
// Saturday 28 November 2026, Black Friday's weekend: a double day in these settings
const DOUBLE = at('2026-11-28', 11);
const realNow = Date.now;
const nowIs = (ms) => {
  Date.now = () => ms;
};
const settle = () => new Promise((r) => setTimeout(r, 15));

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
// The theme's settings once the live theme has round 38's (Theme settings › Lair bookings)
const SETTINGS = { lair_hours: DEFAULT_HOURS, lair_shop_tables: '', lair_order_rolls: true, lair_rolls_every: 200, lair_rolls_double_days: '2026-11-27 to 2026-11-30' };
const OWNER = '9001';
const MIA = '6001';
const KAI = '6002';
const NAMES = { [OWNER]: 'Mo Ashgrove', [MIA]: 'Mia Chen', [KAI]: 'Kai Tane' };
const emailOf = (id) => `${NAMES[id].split(' ')[0].toLowerCase()}@example.com`;

let lair;
// orderSpend's answers by order number: who it was for, its name, discount codes and when it was paid
let spends;
// how each order is reaching them (gwOrderInfo): 'ship' or 'pickup' by order number
let delivery;
let codesMade;
let marked;
let credited;
let reached;
const realFetch = globalThis.fetch;

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
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const internal = (path, body) => call('POST', `internal/${path}`, body, '', { 'X-Lair-Internal': '1' });
const paid = (order) => internal('orders-paid', order);
const card = async (who) => ok(await call('GET', 'me', null, who)).loyalty;
const roll = (who, pick = 'roll') => call('POST', 'roll', { kind: 'loyalty', pick }, who, { 'X-Lair-Client': '203.0.113.7' });

/** An online order (the orders/paid webhook's shape), and what orderSpend says about it */
function webOrder(n, lineItems, { customer = MIA, paidAt = Date.now(), codes = [], source = 'web', extra = {} } = {}) {
  spends.set(String(n), { customerId: customer, amount: 0, source, name: `#${n}`, discountCodes: codes, processedAt: paidAt });
  return { id: n, admin_graphql_api_id: `gid://shopify/Order/${n}`, name: `#${n}`, source_name: source, line_items: lineItems, ...extra };
}
/** A line of Gobgob dice, $price each */
const dice = (id, price, quantity = 1, discount = 0) => ({
  id, title: 'Galaxy Dice Set', variant_title: 'Purple', vendor: 'Dice Goblin NZ', price: price.toFixed(2), quantity,
  discount_allocations: discount ? [{ amount: discount.toFixed(2) }] : [],
});
/** A Magic booster box ($price) */
const box = (id, price, variant = 'Booster Box', { vendor = 'Wizards of the Coast', title = 'MTG - The Hobbit', quantity = 1 } = {}) => ({
  id, title, variant_title: variant, vendor, price: price.toFixed(2), quantity, discount_allocations: [],
});
const giftCard = (id, price) => ({ id, title: 'Dice Goblin gift card', variant_title: `$${price}`, vendor: 'Dice Goblin NZ', price: price.toFixed(2), quantity: 1, gift_card: true });
const rowOf = (n) => lair.sql.exec('SELECT * FROM order_rolls WHERE order_id = ?', `gid://shopify/Order/${n}`).toArray()[0];

/** Turn on emails and catch everything sent to Resend */
function captureEmails() {
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test' };
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.resend.com/')) throw new Error(`No network in tests: ${url}`);
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return {
    sent,
    /** this round's emails since the last look */
    ours: async () => {
      await settle();
      const mine = sent.filter((m) => / for your order /.test(m.subject));
      sent.splice(0, sent.length);
      return mine;
    },
  };
}

beforeEach(async () => {
  reached = [];
  spends = new Map();
  delivery = new Map();
  codesMade = [];
  marked = [];
  credited = [];
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.orderSpend = async (orderId) => spends.get(String(orderId).split('/').pop()) || null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  lair.shopify.customersSince = async () => new Map();
  lair.shopify.creditCustomer = async (customerId, cents) => {
    credited.push([customerId, cents]);
    return true;
  };
  lair.shopify.gwOrderInfo = async (orderId) => {
    const how = delivery.get(String(orderId).split('/').pop()) || 'ship';
    return { id: orderId, name: `#${String(orderId).split('/').pop()}`, createdAt: new Date(Date.now()).toISOString(),
      shippingLine: how === 'pickup' ? { title: 'Pickup at the Lair', deliveryCategory: 'PICK_UP' } : { title: 'NZ Post', deliveryCategory: 'SHIPPING' } };
  };
  lair.shopify.createParcelCode = async (input) => {
    codesMade.push(input);
    return `gid://shopify/DiscountCodeNode/${codesMade.length}`;
  };
  lair.shopify.gwMarkOrder = async (orderId, tag, paragraph) => {
    marked.push([orderId, tag, paragraph]);
  };
  lair.accountEmail = async () => ({ fetched: false, email: '' });
  lair.checkGiftCodes = async () => 0;
  lair.notifyStaff = () => {};
  lair.gmCreditSoon = () => null;
  lair.rulesCache = rulesFromSettings(SETTINGS, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  for (const id of Object.keys(NAMES)) lair.makeMember({ customerId: id, name: NAMES[id], email: emailOf(id) }, NOW);
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

/* ---------------- the words and the numbers ---------------- */

test('round 38: the words, word for word, and the numbers: a roll for every $200, at most 50 an order, an hour for the same parcel', () => {
  assert.deepEqual([ORDER_ROLLS.every, ORDER_ROLLS.maxPerOrder, ORDER_ROLLS.parcelMinutes, ORDER_ROLLS.parcelLeastMinutes, ORDER_ROLLS.parcelTag], [200, 50, 60, 10, 'Same parcel']);
  assert.equal(W.subject(1, '#1550'), 'A d20 roll for your order #1550');
  assert.equal(W.subject(3, '#1550'), '3 d20 rolls for your order #1550');
  assert.equal(W.title(1), 'A d20 roll, waiting in My Lair');
  assert.equal(W.title(2), '2 d20 rolls, waiting in My Lair');
  assert.equal(W.thanks('Mia', '#1550', 1), 'Kia ora Mia, thanks for your order #1550. It earned a d20 roll.');
  assert.equal(W.thanks('', '#1550', 2), 'Kia ora friend, thanks for your order #1550. It earned 2 d20 rolls.');
  assert.equal(W.how(1), 'Roll it in My Lair and the number lands in your store credit straight away, $1 to $20. Or take a sure $10 instead.');
  assert.equal(W.how(2), 'Roll each one in My Lair and the number lands in your store credit straight away, $1 to $20. Or take a sure $10 instead.');
  assert.equal(W.parcel('2:05pm', '#1550'), 'Want to spend it now? Order again before 2:05pm and it goes in the same parcel as #1550, with no extra delivery.');
  assert.deepEqual([W.button(1), W.button(4), W.parcelLink, W.parcelTitle('#1550')], ['Roll it in My Lair', 'Roll them in My Lair', 'Add to this parcel', 'Same parcel as #1550']);
  assert.equal(W.secondNote('#1550'), 'Same parcel as #1550: pack the two together.');
  assert.equal(W.firstNote('#1551'), '#1551 goes in the same parcel as this one: pack the two together.');
});

test('round 38: the theme\'s settings: on only once the live theme says true, a roll for every $200 when it\'s empty, and the double days', () => {
  // a theme from before round 38 (no setting) gives none: the Lair can go live before the theme
  assert.equal(rulesFromSettings({}, ROOMS, []).rolls.on, false);
  assert.equal(rulesFromSettings({ lair_order_rolls: 'true' }, ROOMS, []).rolls.on, false);
  assert.equal(rulesFromSettings({ lair_order_rolls: true }, ROOMS, []).rolls.on, true);
  assert.equal(rulesFromSettings({ lair_order_rolls: true, lair_rolls_every: '' }, ROOMS, []).rolls.every, 200);
  assert.equal(rulesFromSettings({ lair_order_rolls: true, lair_rolls_every: 150 }, ROOMS, []).rolls.every, 150);
  assert.deepEqual(parseDoubleDays('2026-11-27 to 2026-11-30, 2026-12-26'), [['2026-11-27', '2026-11-30'], ['2026-12-26', '2026-12-26']]);
  assert.deepEqual(parseDoubleDays('2026-11-30..2026-11-27; nonsense\n2026-02-30, 2026-12-31 - 2027-01-02'), [['2026-11-27', '2026-11-30'], ['2026-12-31', '2027-01-02']]);
  assert.deepEqual(parseDoubleDays(''), []);
  // the day is the shop's: 11:30pm on the 26th in Auckland isn't Black Friday yet, 12:01am on the 27th is
  const days = parseDoubleDays('2026-11-27 to 2026-11-30');
  assert.equal(doubleDayOn(at('2026-11-26', 23, 30), days, TZ), false);
  assert.equal(doubleDayOn(at('2026-11-27', 0, 1), days, TZ), true);
  assert.equal(doubleDayOn(at('2026-11-30', 23, 59), days, TZ), true);
  assert.equal(doubleDayOn(at('2026-12-01', 0, 1), days, TZ), false);
});

test('Magic booster boxes (Mo: "magic boxes always give a dice per $100 sold"): Wizards of the Coast\'s boxes of boosters, and nothing else', () => {
  for (const variant of ['Booster Box', 'Box', 'Collector Box', 'Play Booster Box', 'Collector Booster Box', 'booster box']) {
    assert.equal(isMagicBox(box(1, 380, variant)), true, variant);
  }
  // a box with no variants of its own, by its title
  assert.equal(isMagicBox(box(1, 300, null, { title: 'MTG Foundations Play Booster Box' })), true);
  assert.equal(isMagicBox(box(1, 300, 'Default Title', { title: 'MTG Foundations Play Booster Box' })), true);
  // Magic's other things
  for (const variant of ['Scene Box - Enterprise-Q', 'Scene Box Villains Unleashed', 'Draft Night', 'Booster Pack', 'Collector Booster Pack', 'Bundle', 'Prerelease Kit', 'Commander Deck - Klingon Fury']) {
    assert.equal(isMagicBox(box(1, 80, variant)), false, variant);
  }
  // other games' boxes ("Don't do that with any other game, only magic the gathering")
  assert.equal(isMagicBox(box(1, 360, 'Booster Box', { vendor: 'The Pokémon Company', title: 'Pokemon TCG Perfect Order Booster' })), false);
  assert.equal(isMagicBox(box(1, 240, 'Booster Box', { vendor: 'Riot Games', title: 'Riftbound Radiance' })), false);
  assert.equal(isMagicBox(box(1, 240, 'Booster Box', { vendor: 'WeirdCo', title: 'Cyberpunk TCG - Welcome to Night City - Booster' })), false);
});

test('counting (Mo: "anything else will be $200 normally and $100 if it was a special season thing"): what the products cost after discounts, boxes double, double days double everything once', () => {
  const count = (items, double = false) => orderRollCount(orderRollLines(items), { every: 200, double }).rolls;
  assert.equal(count([dice(1, 199.99)]), 0);
  assert.equal(count([dice(1, 200)]), 1);
  assert.equal(count([dice(1, 100, 3, 100)]), 1, 'the free die ($100 off) doesn\'t count');
  assert.equal(count([dice(1, 399)]), 1);
  assert.equal(count([dice(1, 400)]), 2);
  // a box: a roll for every $100 of it
  assert.equal(count([box(1, 300)]), 3);
  assert.equal(count([box(1, 380)]), 3);
  assert.equal(count([box(1, 450)]), 4);
  assert.equal(count([box(1, 380, 'Booster Box', { quantity: 2 })]), 7);
  // a box and dice together: the box's $80 over and the dice's $50 make the next $100
  assert.equal(count([box(1, 380), dice(2, 50)]), 4);
  // a double day: every $100, and a box isn't four times
  assert.equal(count([dice(1, 200)], true), 2);
  assert.equal(count([box(1, 400)], true), 4);
  // a gift card isn't spending at the shop
  assert.equal(count([giftCard(1, 200)]), 0);
  assert.equal(count([giftCard(1, 200), dice(2, 200)]), 1);
  // at most 50 an order
  assert.equal(count([dice(1, 200, 80)]), 50);
  const { counted, boxes } = orderRollCount(orderRollLines([box(1, 380), dice(2, 50)]), { every: 200 });
  assert.deepEqual([counted, boxes], [43000, 38000]);
});

test('the rolls (Mo: "they get the dice after purchase. And credit is immediately in Thier account"): an online order\'s rolls are in My Lair at once, each a d20 for store credit or the sure $10', async () => {
  const before = await card(MIA);
  assert.equal(before.rolls.available, 0);
  const res = ok(await paid(webOrder(1550, [box(15501, 380), dice(15502, 50)])));
  assert.deepEqual(res.orderRolls, { rolls: 4 });
  const after = await card(MIA);
  assert.equal(after.rolls.available, 4);
  assert.equal(after.rolls.earned.orders, 4);
  // they roll in My Lair: the d20's face lands in their store credit
  const rolled = ok(await roll(MIA));
  assert.ok(rolled.prize.amount >= 100 && rolled.prize.amount <= 2000);
  assert.equal(credited.length, 1);
  assert.deepEqual(credited[0], [MIA, rolled.prize.amount]);
  // or a sure $10
  ok(await roll(MIA, 'sure'));
  assert.deepEqual(credited[1], [MIA, 1000]);
  assert.equal((await card(MIA)).rolls.available, 2);
});

test('online only (Mo: "The $200 spend is online only no in-store correlation"): a counter sale, the till\'s, a draft order, a subscription\'s billing, a damage charge and an order with no customer earn nothing', async () => {
  // Shopify POS at the counter
  ok(await paid(webOrder(1601, [dice(16011, 400)], { source: 'pos' })));
  // the Lair's own till (a draft order tagged lair-till)
  ok(await paid(webOrder(1602, [dice(16021, 400)], { source: 'shopify_draft_order', extra: { tags: 'lair-till' } })));
  // one of the Lair's checkouts, or an order staff made in Shopify admin
  ok(await paid(webOrder(1603, [dice(16031, 400)], { source: 'shopify_draft_order' })));
  // no customer on it
  ok(await paid(webOrder(1604, [dice(16041, 400)], { customer: null })));
  // a library membership's own billing, and a damage charge, aren't shopping
  ok(await paid(webOrder(1605, [dice(16051, 400)], { source: 'subscription_contract' })));
  ok(await paid(webOrder(1606, [{ id: 16061, title: 'Library damage charge', variant_title: null, vendor: 'Dice Goblin NZ', price: '250.00', quantity: 1 }])));
  assert.equal((await card(MIA)).rolls.available, 0);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM order_rolls').one().n, 0);
});

test('each order on its own (Mo: "The $200 is for a transaction not a running total"), and once however often Shopify sends it', async () => {
  ok(await paid(webOrder(1701, [dice(17011, 150)])));
  ok(await paid(webOrder(1702, [dice(17021, 150)])));
  assert.equal((await card(MIA)).rolls.available, 0);
  const order = webOrder(1703, [dice(17031, 420)]);
  ok(await paid(order));
  ok(await paid(order));
  ok(await paid(order));
  assert.equal((await card(MIA)).rolls.available, 2);
  assert.equal(rowOf(1703).rolls, 2);
});

test('switched off: a theme without the setting ticked gives none (Mo checks it before it goes live)', async () => {
  lair.rulesCache = rulesFromSettings({ ...SETTINGS, lair_order_rolls: false }, ROOMS, []);
  ok(await paid(webOrder(1801, [box(18011, 450)])));
  assert.equal((await card(MIA)).rolls.available, 0);
  // a theme from before round 38
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  ok(await paid(webOrder(1802, [box(18021, 450)])));
  assert.equal((await card(MIA)).rolls.available, 0);
});

test('double days ("we will save them for special days"): every $100 counts on the shop\'s day, boxes still twice', async () => {
  nowIs(DOUBLE);
  ok(await paid(webOrder(1901, [dice(19011, 200)], { paidAt: DOUBLE })));
  ok(await paid(webOrder(1902, [box(19021, 400)], { paidAt: DOUBLE })));
  assert.equal(rowOf(1901).rolls, 2);
  assert.equal(rowOf(1901).doubled, 1);
  assert.equal(rowOf(1902).rolls, 4);
  // paid before midnight on the 30th, its webhook after: the day it was paid
  nowIs(at('2026-12-01', 0, 5));
  ok(await paid(webOrder(1903, [dice(19031, 200)], { paidAt: at('2026-11-30', 23, 58) })));
  assert.equal(rowOf(1903).rolls, 2);
  ok(await paid(webOrder(1904, [dice(19041, 200)], { paidAt: at('2026-12-01', 0, 2) })));
  assert.equal(rowOf(1904).rolls, 1);
});

test('the email: Gobgob tells them once, with a button to My Lair; a posted order\'s has an hour to add to the same parcel, its code only theirs and used once', async () => {
  const mail = captureEmails();
  ok(await paid(webOrder(2001, [box(20011, 380)], { paidAt: NOW })));
  const [email, ...more] = await mail.ours();
  assert.equal(more.length, 0);
  assert.equal(email.to, 'mia@example.com');
  assert.equal(email.subject, '3 d20 rolls for your order #2001');
  assert.match(email.html, /3 d20 rolls, waiting in My Lair/);
  assert.match(email.html, /Kia ora Mia, thanks for your order #2001\. It earned 3 d20 rolls\./);
  assert.match(email.html, /Roll them in My Lair/);
  // the parcel: an hour from when it was paid, 2pm
  assert.match(email.html, /Want to spend it now\? Order again before 2pm and it goes in the same parcel as #2001, with no extra delivery\./);
  assert.equal(codesMade.length, 1);
  const [code] = codesMade;
  assert.match(code.code, /^PARCEL-[A-HJ-NP-Z2-9]{6}$/);
  assert.deepEqual([code.customerId, code.endsAt, code.title], [MIA, NOW + HOUR, 'Same parcel as #2001']);
  assert.match(email.html, new RegExp(`/discount/${code.code}\\?redirect=%2Fcollections%2Fall`));
  assert.match(email.html, />Add to this parcel</);
  // the same webhook again: no second email, no second code
  ok(await paid(webOrder(2001, [box(20011, 380)], { paidAt: NOW })));
  assert.equal((await mail.ours()).length, 0);
  assert.equal(codesMade.length, 1);
});

test('the email: a pickup has no parcel, nobody is emailed with ORDER_ROLL_EMAILS off, and a webhook too late for the hour leaves the parcel out', async () => {
  const mail = captureEmails();
  delivery.set('2101', 'pickup');
  ok(await paid(webOrder(2101, [dice(21011, 200)])));
  const [pickup] = await mail.ours();
  assert.equal(pickup.subject, 'A d20 roll for your order #2101');
  assert.doesNotMatch(pickup.html, /same parcel/);
  assert.equal(codesMade.length, 0);
  // paid 55 minutes ago: less than 10 minutes of the hour left, so no code
  ok(await paid(webOrder(2102, [dice(21021, 200)], { paidAt: NOW - 55 * MIN })));
  const [late] = await mail.ours();
  assert.doesNotMatch(late.html, /same parcel/);
  assert.equal(codesMade.length, 0);
  // switched off in the config
  lair.baseEnv = { ...lair.baseEnv, ORDER_ROLL_EMAILS: 'off' };
  ok(await paid(webOrder(2103, [dice(21031, 200)])));
  assert.equal((await mail.ours()).length, 0);
  assert.equal(codesMade.length, 0, 'no code is made for an email that isn\'t going');
  // the rolls are there either way
  assert.equal((await card(MIA)).rolls.available, 3);
});

test('the same parcel (Mo: "buy more products within the hour to add the items inside the same package"): a second order with the code tags both orders once, and earns its own rolls but no new code', async () => {
  const mail = captureEmails();
  ok(await paid(webOrder(2201, [box(22011, 380)])));
  await mail.ours();
  const { code } = codesMade[0];
  // 20 minutes later, with the code
  nowIs(NOW + 20 * MIN);
  const second = webOrder(2202, [dice(22021, 210)], { codes: [code.toLowerCase()] });
  const res = ok(await paid(second));
  assert.deepEqual(res.orderRolls, { parcel: '#2201', rolls: 1 });
  await settle();
  assert.deepEqual(marked, [
    ['gid://shopify/Order/2202', 'Same parcel', 'Same parcel as #2201: pack the two together.'],
    ['gid://shopify/Order/2201', 'Same parcel', '#2202 goes in the same parcel as this one: pack the two together.'],
  ]);
  // the second order's email has no parcel of its own
  const [email] = await mail.ours();
  assert.equal(email.subject, 'A d20 roll for your order #2202');
  assert.doesNotMatch(email.html, /same parcel/);
  assert.equal(codesMade.length, 1);
  // Shopify sends it again: nothing more
  ok(await paid(second));
  await settle();
  assert.equal(marked.length, 2);
  // someone else typing Mia's code links nothing
  ok(await paid(webOrder(2203, [dice(22031, 50)], { customer: KAI, codes: [code] })));
  await settle();
  assert.equal(marked.length, 2);
});

test('the 10-minute run: an email a restart cut short goes out once, and a parcel\'s tags Shopify refused are tried again', async () => {
  const mail = captureEmails();
  // the Lair stopped before its background work: the row is kept, nothing sent
  lair.orderRollsFollowUp = async () => false;
  ok(await paid(webOrder(2301, [dice(23011, 400)])));
  assert.equal((await mail.ours()).length, 0);
  delete lair.orderRollsFollowUp;
  nowIs(NOW + 10 * MIN);
  const done = await lair.orderRollsUpkeep(Date.now());
  assert.deepEqual(done, { emails: 1, tags: 0 });
  const [email] = await mail.ours();
  assert.equal(email.subject, '2 d20 rolls for your order #2301');
  assert.equal(await lair.orderRollsUpkeep(Date.now()), null);
  // a parcel whose tags Shopify refused
  const { code } = codesMade[0];
  lair.shopify.gwMarkOrder = async () => {
    throw new Error('Access denied for write_orders');
  };
  ok(await paid(webOrder(2302, [dice(23021, 20)], { codes: [code] })));
  await settle();
  assert.equal(rowOf(2301).parcel_tagged_at, null);
  lair.shopify.gwMarkOrder = async (orderId, tag, paragraph) => {
    marked.push([orderId, tag, paragraph]);
  };
  assert.deepEqual(await lair.orderRollsUpkeep(Date.now()), { emails: 0, tags: 1 });
  assert.equal(marked.length, 2);
});

test('a follow-up already under way is left to finish (from the separate review): the 10-minute run meeting it mid-way sends nothing, so the email keeps its parcel', async () => {
  const mail = captureEmails();
  // Shopify takes its time saying how the order is reaching them
  let answer;
  const slow = new Promise((resolve) => {
    answer = resolve;
  });
  const realInfo = lair.shopify.gwOrderInfo;
  lair.shopify.gwOrderInfo = async (orderId) => {
    await slow;
    return realInfo(orderId);
  };
  ok(await paid(webOrder(2401, [box(24011, 380)])));
  await settle();
  // the 10-minute run comes round while the first follow-up waits on Shopify
  nowIs(NOW + 30_000);
  assert.equal(await lair.orderRollsUpkeep(Date.now()), null);
  assert.equal((await mail.ours()).length, 0);
  answer();
  const [email, ...more] = await mail.ours();
  assert.equal(more.length, 0);
  assert.match(email.html, />Add to this parcel</);
  assert.equal(codesMade.length, 1);
  // one that died mid-way (a restart) is picked up once it's been 5 minutes
  lair.orderRollsFollowUp = async () => false;
  ok(await paid(webOrder(2402, [dice(24021, 200)])));
  delete lair.orderRollsFollowUp;
  lair.sql.exec('UPDATE order_rolls SET follow_at = ? WHERE order_id = ?', Date.now(), 'gid://shopify/Order/2402');
  assert.equal(await lair.orderRollsUpkeep(Date.now()), null);
  nowIs(NOW + 30_000 + 5 * MIN + 1000);
  assert.deepEqual(await lair.orderRollsUpkeep(Date.now()), { emails: 1, tags: 0 });
});

test('an order Shopify gives no source for is never taken as online (as ordersPaid takes it as a draft)', async () => {
  ok(await paid(webOrder(2501, [dice(25011, 400)], { source: '' })));
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM order_rolls').one().n, 0);
});

test('a same-parcel code is never guessable: six of 31 letters and numbers from crypto, none of 0, O, 1, I or L', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i += 1) seen.add(parcelCode());
  assert.equal(seen.size, 300);
  for (const code of seen) assert.match(code, /^PARCEL-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  // a fixed source gives a fixed code, skipping bytes past the last whole run of the alphabet
  const fixed = (n) => Uint8Array.from({ length: n }, (_, i) => (i === 0 ? 250 : i));
  assert.equal(parcelCode(fixed), 'PARCEL-BCDEFG');
});

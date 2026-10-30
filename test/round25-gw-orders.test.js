// Round 25: Games Workshop items ordered in (contract v25-gw-orders). Mo (31 Oct 2026): "If it's on our shelf, it says
// so. If not, it's clearly ordered in from Games Workshop, not in store." Orders close at midnight at the end of Monday,
// GW ships on Thursday, and it should be with the customer two weeks after that Thursday; Mo gets the GW order list first
// thing Tuesday, and Lair pickups get an email when it's in. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { GW_WORDS as W, gwSchedule, gwLabel, isGwItem, packsFor, deliveryOf } from '../src/gw-orders.js';

const time = new LairTime('Pacific/Auckland');
const HOUR = 3_600_000;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Tuesday 3 November 2026, 1pm in Auckland: this week's orders close at midnight on Monday 9 November
const NOW = at('2026-11-03', 13);
const realNow = Date.now;
const nowIs = (ms) => {
  Date.now = () => ms;
};

function fakeCtx(pending) {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
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
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: (p) => pending.push(p) };
}

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];
const ENV = { CURRENCY: 'NZD', RESEND_API_KEY: 'test-key', FROM_EMAIL: 'gobgob@example.com', STAFF_EMAIL: 'staff@example.com' };

/* ---------------- a pretend Shopify: GW variants' stock, and orders ---------------- */
const KIT = 'gid://shopify/ProductVariant/501';
const PAINT = 'gid://shopify/ProductVariant/502';
const SOON = 'gid://shopify/ProductVariant/503';
const DROPPED = 'gid://shopify/ProductVariant/504';
const DICE = 'gid://shopify/ProductVariant/601';
let stock;
let orders;
let overrides;
let marks;
let denyMark;
let mails;
let calls;
let pending;
let ctx;
let lair;

const settle = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};
const numeric = (gid) => Number(String(gid).split('/').pop());
const gwLine = (id, variant, quantity, price = null) => ({
  id, variant_id: numeric(variant), sku: stock.get(variant).code, vendor: 'Games Workshop', name: stock.get(variant).title,
  title: stock.get(variant).title, quantity, price: price || stock.get(variant).price, properties: [],
});
const diceLine = (id, quantity = 1) => ({ id, variant_id: numeric(DICE), sku: 'DG-D20-RED', vendor: 'Dice Goblin NZ', name: 'Red d20', title: 'Red d20', quantity, price: '5.00', properties: [] });

/**
 * A paid order: the sale comes off the stock (as Shopify does when it's made), then the orders/paid webhook. Who: an
 * email and a first name, or none (a counter sale with no customer). How: 'pickup', 'ship' or 'counter'.
 */
async function pay(n, lines, { who = null, how = 'pickup', placed = Date.now(), again = false } = {}) {
  const orderId = `gid://shopify/Order/${n}`;
  if (!again) {
    for (const line of lines) {
      const variant = `gid://shopify/ProductVariant/${line.variant_id}`;
      if (stock.has(variant)) stock.get(variant).available -= line.quantity;
    }
    orders.set(orderId, {
      info: {
        id: orderId, name: `#${n}`, email: who?.email || null, createdAt: new Date(placed).toISOString(),
        customer: who ? { id: `gid://shopify/Customer/${who.id}`, firstName: who.first, displayName: who.first, defaultEmailAddress: { emailAddress: who.email } } : null,
        billingAddress: null,
        shippingLine: how === 'counter' ? null : how === 'ship' ? { title: 'NZ Post tracked', deliveryCategory: 'shipping' } : { title: 'Collect from the Lair', deliveryCategory: 'pick-up' },
      },
      cancelledAt: null,
      lines: new Map(lines.map((l) => [`gid://shopify/LineItem/${l.id}`, l.quantity])),
    });
  }
  const webhook = { id: n, admin_graphql_api_id: orderId, name: `#${n}`, source_name: how === 'counter' ? 'pos' : 'web', line_items: lines };
  const response = await lair.fetch(new Request('https://lair.test/internal/orders-paid', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body: JSON.stringify(webhook),
  }));
  const data = await response.json();
  assert.equal(response.status, 200, data.error);
  await settle();
  return data;
}
const maintain = async (ms) => {
  nowIs(ms);
  const result = { list: await lair.gwOrderList(lair.rulesCache, ms), orders: await lair.gwReconcile(ms) };
  await settle();
  return result;
};
const orderins = () => lair.sql.exec('SELECT * FROM gw_orderins ORDER BY placed_at, id').toArray();
const mailsTo = (to) => mails.filter((m) => m.to === to);
const KAI = { id: 7001, first: 'Kai', email: 'kai@example.com' };
const MIA = { id: 7002, first: 'Mia', email: 'mia@example.com' };
const LEO = { id: 7003, first: 'Leo', email: 'leo@example.com' };

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = async (url) => {
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  pending = [];
  mails = [];
  calls = [];
  marks = [];
  denyMark = false;
  overrides = {};
  stock = new Map([
    [KIT, { code: '99120101386', title: 'Combat Patrol: Space Marines', available: 0, policy: 'CONTINUE', pack: 1, release: '', price: '210.00' }],
    [PAINT, { code: '99189950001', title: 'Base: Abaddon Black (18ml)', available: 1, policy: 'CONTINUE', pack: 6, release: '', price: '8.50' }],
    [SOON, { code: '99120102999', title: 'Kill Team: Starter Set', available: 0, policy: 'CONTINUE', pack: 1, release: '2026-11-14', price: '180.00' }],
    [DROPPED, { code: '99120101111', title: 'Retired Kit', available: 0, policy: 'DENY', pack: 1, release: '', price: '60.00' }],
  ]);
  orders = new Map();
  ctx = fakeCtx(pending);
  lair = new Lair(ctx, ENV);
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  lair.shopify.gwOrder = async (orderId, ids) => {
    calls.push(['gwOrder', orderId, ids]);
    return {
      order: orders.get(orderId)?.info || null,
      variants: new Map(ids.filter((id) => stock.has(id)).map((id) => [id, { id, tracked: true, ...stock.get(id) }])),
      overrides,
    };
  };
  lair.shopify.gwState = async (ids) => {
    calls.push(['gwState', ids.length]);
    const state = new Map();
    for (const id of ids) {
      if (stock.has(id)) state.set(id, { available: stock.get(id).available, cancelledAt: null, currentQuantity: NaN });
      else if (orders.has(id)) state.set(id, { available: NaN, cancelledAt: orders.get(id).cancelledAt, currentQuantity: NaN });
      else {
        const order = [...orders.values()].find((o) => o.lines.has(id));
        if (order) state.set(id, { available: NaN, cancelledAt: null, currentQuantity: order.lines.get(id) });
      }
    }
    return state;
  };
  lair.shopify.gwMarkOrder = async (orderId, tag, note) => {
    if (denyMark) throw new Error('Access denied for tagsAdd field. Required access: `write_orders` access scope.');
    marks.push([orderId, tag, note]);
    return true;
  };
  lair.shopify.gwBelowZero = async () => ({
    variants: [...stock].filter(([, v]) => v.available < 0).map(([id, v]) => ({ id, ...v, tracked: true })),
    overrides,
  });
  lair.mail = async (message) => {
    mails.push(message);
    return { ok: true, attempted: true, status: 200 };
  };
  lair.mailMany = async (messages) => {
    mails.push(...messages);
    return { ok: true, attempted: true, status: 200, sent: messages.length };
  };
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
});

/* ---------------- the dates and the words ---------------- */

test('round 25: the dates, as the theme works them out', () => {
  // Mo's own example: ordered on Saturday 31 October, by midnight Monday 2 Nov, should be with them by Thursday 19 Nov
  assert.deepEqual(gwSchedule('2026-10-31'), { cutoff: '2026-11-02', ships: '2026-11-05', promise: '2026-11-19' });
  // a Monday is that Monday's (until midnight)
  assert.deepEqual(gwSchedule('2026-11-02'), { cutoff: '2026-11-02', ships: '2026-11-05', promise: '2026-11-19' });
  // a Tuesday is next Monday's
  assert.deepEqual(gwSchedule('2026-11-03'), { cutoff: '2026-11-09', ships: '2026-11-12', promise: '2026-11-26' });
  // a product released after the order day counts from its release day
  assert.deepEqual(gwSchedule('2026-11-03', '2026-11-14'), { cutoff: '2026-11-16', ships: '2026-11-19', promise: '2026-12-03' });
  assert.deepEqual(gwSchedule('2026-11-20', '2026-11-14'), { cutoff: '2026-11-23', ships: '2026-11-26', promise: '2026-12-10' });
  // the Warhammer tab's changes: a skipped Monday joins the next week, and a week's dates can be moved
  const changes = { '2026-12-28': { skip: true }, '2027-01-04': { promise: '2027-01-28', ships: '2027-01-07' } };
  assert.deepEqual(gwSchedule('2026-12-22', '', changes), { cutoff: '2027-01-04', ships: '2027-01-07', promise: '2027-01-28' });
  assert.deepEqual(gwSchedule('2026-12-22', '', 'not an object'), { cutoff: '2026-12-28', ships: '2026-12-31', promise: '2027-01-14' });
  // every day of a year agrees with the rule: the next Monday on or after, ships 3 days after, should be there 17 after
  let day = '2026-10-01';
  for (let i = 0; i < 400; i += 1) {
    const { cutoff, ships, promise } = gwSchedule(day);
    const wd = new Date(`${cutoff}T00:00:00Z`).getUTCDay();
    assert.equal(wd, 1, `${day} closes on a Monday`);
    assert.ok(cutoff >= day && (Date.parse(cutoff) - Date.parse(day)) / 864e5 < 7, day);
    assert.equal((Date.parse(ships) - Date.parse(cutoff)) / 864e5, 3);
    assert.equal((Date.parse(promise) - Date.parse(cutoff)) / 864e5, 17);
    day = new Date(Date.parse(day) + 864e5).toISOString().slice(0, 10);
  }
  assert.equal(gwLabel('2026-11-02', 'cutoff'), 'Monday 2 Nov');
  assert.equal(gwLabel('2026-11-19', 'short'), 'Thu 19 Nov');
  assert.equal(gwLabel('2026-11-19'), 'Thursday 19 November');
  assert.equal(packsFor(1, 6), 1);
  assert.equal(packsFor(7, 6), 2);
  assert.equal(packsFor(3, 1), 3);
  // what's a GW line: GW's vendor and a GW code; library copies (DGLRPG-…) and other vendors never are
  assert.equal(isGwItem({ vendor: 'Games Workshop', sku: '99120101386' }), true);
  assert.equal(isGwItem({ vendor: 'Games Workshop', sku: 'DGLRPG-091' }), false);
  assert.equal(isGwItem({ vendor: 'Dice Goblin NZ', sku: '99120101386' }), false);
  assert.equal(deliveryOf({ shippingLine: { title: 'Collect from the Lair', deliveryCategory: 'pick-up' } }, false), 'pickup');
  assert.equal(deliveryOf({ shippingLine: { title: 'NZ Post tracked', deliveryCategory: 'shipping' } }, false), 'ship');
  assert.equal(deliveryOf({ shippingLine: null }, true), 'counter');
});

test('round 25: the customer\'s words, word for word', () => {
  assert.equal(W.toldSubject('#2041'), 'Ordered in for you: order #2041');
  assert.equal(W.toldIntro('Kai', false, 'Thursday 26 November'), "Thanks, Kai! It isn't on our shelf, so it's going on our next order from Games Workshop. It should be with you by Thursday 26 November.");
  assert.equal(W.toldIntro('', true, 'Thursday 26 November'), "Thanks for your order! Some of it isn't on our shelf, so it's going on our next order from Games Workshop. It should be with you by Thursday 26 November.");
  assert.deepEqual(W.toldOutro, {
    ship: "We'll post your order in one parcel once everything's here.",
    pickup: "We'll email you when it's in at the Lair, ready to collect.",
    counter: "We'll email you when it's in, ready to collect at the Lair.",
  });
  assert.equal(W.refund, "If Games Workshop can't supply it, we'll let you know and refund it in full.");
  assert.equal(W.inSubject('#2041'), "It's in: order #2041 is ready to collect");
  assert.equal(W.inIntro('Kai'), 'Kai, your Games Workshop order has landed at the Lair. Gobgob has it behind the counter with your name on it.');
  assert.equal(W.inOutro, "Pop in and grab it whenever we're open.");
});

/* ---------------- a paid order ---------------- */

test('round 25: a GW kit that isn\'t on the shelf is ordered in: recorded, tagged, and the customer told the date', async () => {
  const paid = await pay(2041, [gwLine(1, KIT, 1)], { who: KAI, how: 'pickup' });
  assert.deepEqual(paid.gw, { units: 1, lines: [{ code: '99120101386', quantity: 1, promise: '2026-11-26' }] });
  const [row] = orderins();
  assert.equal(row.cutoff, '2026-11-09');
  assert.equal(row.quantity, 1);
  assert.equal(row.price, 21000);
  assert.deepEqual(marks, [['gid://shopify/Order/2041', 'Ordered in', 'Ordered in from Games Workshop: 1 × Combat Patrol: Space Marines (99120101386). Should be with them by Thu 26 Nov. One parcel: send it all once it\'s in.']]);
  const [told] = mailsTo('kai@example.com');
  assert.equal(told.subject, 'Ordered in for you: order #2041');
  assert.match(told.text, /Thanks, Kai! It isn't on our shelf, so it's going on our next order from Games Workshop\. It should be with you by Thursday 26 November\./);
  assert.match(told.text, /1 × Combat Patrol: Space Marines/);
  assert.match(told.text, /We'll email you when it's in at the Lair, ready to collect\./);
  assert.match(told.text, /refund it in full/);
  assert.equal(told.idempotencyKey, 'gw-told-2041');
  // the webhook again: nothing new, and Shopify isn't asked again
  const asked = calls.length;
  const again = await pay(2041, [gwLine(1, KIT, 1)], { who: KAI, again: true });
  assert.equal(again.gw, undefined);
  assert.equal(calls.length, asked);
  assert.equal(orderins().length, 1);
  assert.equal(mailsTo('kai@example.com').length, 1);
});

test('round 25: what the shelf covers isn\'t ordered in, and what\'s already ordered in for a variant counts first', async () => {
  // one pot on the shelf; Kai buys 3 (posted, with a d20): 2 ordered in, and some of the order is on the shelf
  const kai = await pay(2042, [gwLine(1, PAINT, 3), diceLine(2)], { who: KAI, how: 'ship' });
  assert.equal(kai.gw.units, 2);
  assert.match(mailsTo('kai@example.com')[0].text, /Some of it isn't on our shelf/);
  assert.match(mailsTo('kai@example.com')[0].text, /post your order in one parcel/);
  // Mia buys 1 more: the stock is 3 short now, 2 of them Kai's, so 1 is hers
  const mia = await pay(2043, [gwLine(1, PAINT, 1)], { who: MIA });
  assert.equal(mia.gw.units, 1);
  assert.deepEqual(orderins().map((r) => [r.order_id.split('/').pop(), r.quantity, r.line_quantity]), [['2042', 2, 3], ['2043', 1, 1]]);
  // an order without GW lines never asks Shopify anything for this
  const asked = calls.length;
  await pay(2044, [diceLine(1, 2)], { who: LEO });
  assert.equal(calls.length, asked);
  // a kit that's dropped off the pad (stops at 0) is never ordered in, even oversold at the counter
  const dropped = await pay(2045, [gwLine(1, DROPPED, 1)], { how: 'counter' });
  assert.deepEqual(dropped.gw, { units: 0, lines: [] });
  assert.equal(orderins().length, 2);
});

test('round 25: a counter sale with no customer is ordered in quietly, and an advance order counts from its release day', async () => {
  const counter = await pay(2050, [gwLine(1, KIT, 1)], { how: 'counter' });
  assert.equal(counter.gw.units, 1);
  assert.equal(mails.length, 0);
  assert.match(marks[0][2], /^Ordered in from Games Workshop at the counter: 1 × Combat Patrol: Space Marines \(99120101386\)\. Should be in by Thu 26 Nov: put it aside for them\.$/);
  const order = lair.sql.exec('SELECT * FROM gw_orders WHERE order_id = ?', 'gid://shopify/Order/2050').one();
  assert.equal(order.channel, 'counter');
  assert.equal(order.delivery, 'counter');
  const soon = await pay(2051, [gwLine(1, SOON, 1)], { who: MIA });
  assert.equal(soon.gw.lines[0].promise, '2026-12-03');
  assert.match(mailsTo('mia@example.com')[0].text, /Thursday 3 December/);
});

test('round 25: an order placed before midnight on Monday is that week\'s, however late its webhook comes', async () => {
  nowIs(at('2026-11-10', 0, 20));
  await pay(2052, [gwLine(1, KIT, 1)], { who: KAI, placed: at('2026-11-09', 23, 58) });
  assert.equal(orderins()[0].cutoff, '2026-11-09');
});

test('round 25: tags Shopify turned down (the scope not approved yet) are tried again by maintenance', async () => {
  denyMark = true;
  await pay(2060, [gwLine(1, KIT, 1)], { who: KAI });
  assert.equal(marks.length, 0);
  assert.equal(lair.sql.exec('SELECT marked_at FROM gw_orders').one().marked_at, null);
  denyMark = false;
  const run = await maintain(NOW + HOUR);
  assert.equal(run.orders.marked, 1);
  assert.equal(marks.length, 1);
  assert.ok(lair.sql.exec('SELECT marked_at FROM gw_orders').one().marked_at);
});

/* ---------------- the Tuesday list ---------------- */

test('round 25: Tuesday\'s GW order list: once per cutoff from 6am, in packs, with the week\'s numbers and the odd ones out', async () => {
  // the first run only notes the week, so the first list is a whole week's
  assert.deepEqual((await maintain(at('2026-11-03', 14))).list, { list: '2026-11-02', baseline: true });
  nowIs(NOW + HOUR);
  await pay(2070, [gwLine(1, KIT, 2), gwLine(2, PAINT, 2)], { who: KAI, how: 'ship' }); // the shelf's one pot covers 1
  await pay(2071, [gwLine(1, PAINT, 1)], { how: 'counter' });
  // a kit that's below zero with no order to explain it (counted wrong, or sold before this went live)
  stock.set('gid://shopify/ProductVariant/505', { code: '99120105555', title: 'Stormcast Eternals: Vindictors', available: -1, policy: 'CONTINUE', pack: 1, release: '', price: '95.00' });
  // nothing on Monday, nor before 6am on Tuesday
  assert.equal((await maintain(at('2026-11-09', 23, 50))).list, null);
  assert.equal((await maintain(at('2026-11-10', 5, 50))).list, null);
  const run = await maintain(at('2026-11-10', 6, 10));
  assert.deepEqual(run.list, { list: '2026-11-09', codes: 2, packs: 3 });
  const [list] = mailsTo('staff@example.com');
  assert.equal(list.subject, 'GW order for Monday 9 Nov: 2 codes');
  assert.equal(list.idempotencyKey, 'gw-list-2026-11-09');
  assert.match(list.text, /> 99120101386,2\n> 99189950001,1/);
  assert.match(list.text, /Base: Abaddon Black \(18ml\): 2 ordered in, so 1 pack of 6 \(4 extra for the shelf\)/);
  assert.match(list.text, /Combat Patrol: Space Marines: 2/);
  assert.match(list.text, /Ordered in online/);
  assert.match(list.text, /At NZ RRP: +\$471\n/);
  assert.match(list.text, /Ordered in online: +1 order, 3 items, \$428\.50\nOrdered in at the counter: +1 order, 1 item, \$8\.50/);
  assert.match(list.text, /Counter sale #2071, no customer/);
  assert.match(list.text, /99120105555 below zero/);
  assert.match(list.text, /Stormcast Eternals: Vindictors: 1 below zero that no order explains/);
  const csv = Buffer.from(list.attachments[0].content, 'base64').toString('utf8');
  assert.equal(list.attachments[0].filename, 'gw-order-2026-11-09.csv');
  assert.equal(csv, 'Product code,Quantity\n99120101386,2\n99189950001,1\n');
  assert.ok(orderins().every((r) => r.listed_for === '2026-11-09'));
  // once: the next run sends nothing, and next week's starts empty
  assert.equal((await maintain(at('2026-11-10', 6, 20))).list, null);
  assert.equal(mailsTo('staff@example.com').length, 1);
});

test('round 25: a week the Warhammer tab skipped has no list, and a failed send is tried again', async () => {
  await maintain(at('2026-11-03', 14));
  overrides = { '2026-11-09': { skip: true } };
  nowIs(NOW + HOUR);
  await pay(2080, [gwLine(1, KIT, 1)], { who: KAI });
  assert.equal(orderins()[0].cutoff, '2026-11-16');
  assert.deepEqual((await maintain(at('2026-11-10', 7))).list, { list: '2026-11-09', skipped: true });
  assert.equal(mailsTo('staff@example.com').length, 0);
  // the next week's send fails once: nothing's marked, and the next run sends it
  overrides = {};
  lair.mail = async (message) => {
    mails.push(message);
    return { ok: false, attempted: true, status: 500 };
  };
  await maintain(at('2026-11-17', 6, 5));
  assert.equal(orderins()[0].listed_for, null);
  lair.mail = async (message) => {
    mails.push(message);
    return { ok: true, attempted: true, status: 200 };
  };
  const run = await maintain(at('2026-11-17', 6, 15));
  assert.deepEqual(run.list, { list: '2026-11-16', codes: 1, packs: 1 });
  assert.equal(orderins()[0].listed_for, '2026-11-16');
});

/* ---------------- when it comes in ---------------- */

test('round 25: stock coming in marks ordered-in units in, oldest order first; pickups hear it\'s in, the shop what to pack', async () => {
  await pay(2090, [gwLine(1, KIT, 1)], { who: KAI, how: 'pickup' });
  nowIs(NOW + HOUR);
  await pay(2091, [gwLine(1, KIT, 1)], { who: MIA, how: 'ship' });
  await pay(2092, [gwLine(1, KIT, 1)], { how: 'counter' });
  mails = [];
  // nothing in yet
  assert.equal((await maintain(NOW + 2 * HOUR)).orders, null);
  // GW's delivery: 2 kits added to stock (−3 → −1): Kai's and Mia's are in, the counter sale's still to come
  stock.get(KIT).available += 2;
  const run = await maintain(NOW + 3 * HOUR);
  assert.deepEqual(run.orders, { arrived: 2, ready: ['#2090', '#2091'] });
  const [kai] = mailsTo('kai@example.com');
  assert.equal(kai.subject, "It's in: order #2090 is ready to collect");
  assert.match(kai.text, /Kai, your Games Workshop order has landed at the Lair/);
  assert.equal(kai.idempotencyKey, 'gw-in-2090');
  assert.equal(mailsTo('mia@example.com').length, 0); // posted: Shopify tells her when it's sent
  const [shop] = mailsTo('staff@example.com');
  assert.equal(shop.subject, 'In from Games Workshop: 2 orders ready');
  assert.match(shop.text, /#2090: 1 × Combat Patrol: Space Marines/);
  assert.match(shop.text, /Kai collects at the Lair: we've emailed them it's in\./);
  assert.match(shop.text, /Ready to pack and post: it's all in\./);
  // the rest comes in: the counter sale's put aside
  stock.get(KIT).available += 1;
  mails = [];
  const rest = await maintain(NOW + 4 * HOUR);
  assert.deepEqual(rest.orders, { arrived: 1, ready: ['#2092'] });
  assert.match(mailsTo('staff@example.com')[0].text, /Counter sale with no customer on it: put it aside for whoever ordered it\./);
  // and nothing more after
  mails = [];
  assert.equal((await maintain(NOW + 5 * HOUR)).orders, null);
  assert.equal(mails.length, 0);
});

test('round 25: a refund or a cancelled order takes its ordered-in units off, and the restock isn\'t mistaken for GW\'s delivery', async () => {
  await pay(2100, [gwLine(1, KIT, 2)], { who: KAI });
  nowIs(NOW + HOUR);
  await pay(2101, [gwLine(1, KIT, 1)], { who: MIA });
  // Kai is refunded one kit, restocked (−3 → −2)
  orders.get('gid://shopify/Order/2100').lines.set('gid://shopify/LineItem/1', 1);
  stock.get(KIT).available += 1;
  mails = [];
  const run = await maintain(NOW + 2 * HOUR);
  assert.deepEqual(run.orders, { cancelled: 1 });
  assert.deepEqual(orderins().map((r) => [r.quantity, r.arrived, r.cancelled]), [[2, 0, 1], [1, 0, 0]]);
  // Mia's order is cancelled and restocked: nothing to tell anyone
  orders.get('gid://shopify/Order/2101').cancelledAt = new Date().toISOString();
  stock.get(KIT).available += 1;
  const cancelled = await maintain(NOW + 3 * HOUR);
  assert.deepEqual(cancelled.orders, { cancelled: 1 });
  assert.equal(mails.length, 0);
  assert.ok(lair.sql.exec("SELECT ready_at FROM gw_orders WHERE name = '#2101'").one().ready_at);
});

test('round 25: an order still waiting the day after its date is flagged to the shop once', async () => {
  await pay(2110, [gwLine(1, KIT, 1)], { who: KAI });
  mails = [];
  assert.equal((await maintain(at('2026-11-26', 20))).orders, null);
  const late = await maintain(at('2026-11-27', 9));
  assert.deepEqual(late.orders, { late: ['#2110'] });
  const [shop] = mailsTo('staff@example.com');
  assert.equal(shop.subject, 'Late from Games Workshop: 1 order');
  assert.match(shop.text, /#2110 \(Kai\), due Thu 26 Nov/);
  assert.equal((await maintain(at('2026-11-27', 10))).orders, null);
});

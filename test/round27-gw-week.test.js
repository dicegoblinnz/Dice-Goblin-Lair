// Round 27: the rest of the Warhammer tab (contract v27-gw-week). The plan, agreed with Mo on 31 Oct 2026: "Ready before
// the first Tuesday after going live: the Warhammer tab with the pad upload, the Tuesday list and email, receiving, GW
// couldn't supply, holiday dates and weekly ordered-in sales." This week's order with shelf top-ups, GW couldn't supply
// (order it again, or refund it), the box coming in (added to stock once, customers told), and order dates.
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS, STAFF_PERMS } from '../src/core.js';
import { GW_WORDS } from '../src/gw-orders.js';
import { GW_WEEK_WORDS as W, weekDates, listWeek, mondayOf, RECEIVE_PART } from '../src/gw-week.js';
import { PAD_WORDS } from '../src/gw-pad.js';

const time = new LairTime('Pacific/Auckland');
const HOUR = 3_600_000;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Tuesday 3 November 2026, 1pm in Auckland: Monday 2 Nov's list went this morning, so orders now are Monday 9 Nov's
const NOW = at('2026-11-03', 13);
const realNow = Date.now;
let clock;
const nowIs = (ms) => {
  clock = ms;
  Date.now = () => clock;
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
const ENV = {
  CURRENCY: 'NZD', RESEND_API_KEY: 'test-key', FROM_EMAIL: 'gobgob@example.com', STAFF_EMAIL: 'staff@example.com',
  GW_LOCATION_ID: '72250359911', GW_POS_PUBLICATION_ID: '129866989671', SHOP: 'ep0qiq-rp.myshopify.com',
};
const LOCATION = 'gid://shopify/Location/72250359911';
const OWNER = '9001';
const HELPER = '9002';
const MEMBER = '9003';

/* ---------------- a pretend Shopify: GW variants' stock, orders, the schedule and stock adjustments ---------------- */
const KIT = 'gid://shopify/ProductVariant/501';
const PAINT = 'gid://shopify/ProductVariant/502';
const SOON = 'gid://shopify/ProductVariant/503';
const NULN = 'gid://shopify/ProductVariant/505';
const CODE = { [KIT]: '99120101386', [PAINT]: '99189950001', [SOON]: '99120102999', [NULN]: '99189953083' };
let stock;
let orders;
let schedule; // { overrides, digest }
let adjusts; // Shopify's idempotency keys: key → { ok, params }
let adjustCalls;
let trouble; // what goes wrong next: { adjust: 'lost' | 'down' | 'refused' | [userError codes], lookup, state, save: 'stale' }
let mails;
let batches; // each mailMany: the customers' emails sent together
let mailDown;
let pending;
let lair;

const settle = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};
const numeric = (gid) => Number(String(gid).split('/').pop());
const itemOf = (variant) => `gid://shopify/InventoryItem/${numeric(variant) + 1000}`;
const gwLine = (id, variant, quantity) => ({
  id, variant_id: numeric(variant), sku: stock.get(variant).code, vendor: 'Games Workshop', name: stock.get(variant).title,
  title: stock.get(variant).title, quantity, price: stock.get(variant).price, properties: [],
});

/** A paid order: the sale off the stock, then the orders/paid webhook. how: 'pickup', 'ship' or 'counter' */
async function pay(n, lines, { who = null, how = 'pickup' } = {}) {
  const orderId = `gid://shopify/Order/${n}`;
  for (const line of lines) stock.get(`gid://shopify/ProductVariant/${line.variant_id}`).available -= line.quantity;
  orders.set(orderId, {
    info: {
      id: orderId, name: `#${n}`, email: who?.email || null, createdAt: new Date(Date.now()).toISOString(),
      customer: who ? { id: `gid://shopify/Customer/${who.id}`, firstName: who.first } : null,
      shippingLine: how === 'counter' ? null : how === 'ship' ? { title: 'NZ Post tracked', deliveryCategory: 'shipping' } : { title: 'Collect from the Lair', deliveryCategory: 'pick-up' },
    },
    cancelledAt: null,
    lines: new Map(lines.map((l) => [`gid://shopify/LineItem/${l.id}`, l.quantity])),
  });
  const webhook = { id: n, admin_graphql_api_id: orderId, name: `#${n}`, source_name: how === 'counter' ? 'pos' : 'web', line_items: lines };
  const response = await lair.fetch(new Request('https://lair.test/internal/orders-paid', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body: JSON.stringify(webhook),
  }));
  assert.equal(response.status, 200);
  await settle();
}
/** A refund in Shopify with Restock ticked: the line's units go back, and the stock with them */
function refund(n, lineId, variant, units) {
  const order = orders.get(`gid://shopify/Order/${n}`);
  const key = `gid://shopify/LineItem/${lineId}`;
  order.lines.set(key, order.lines.get(key) - units);
  stock.get(variant).available += units;
}
const maintain = async (ms) => {
  nowIs(ms);
  const result = { list: await lair.gwOrderList(lair.rulesCache, ms), orders: await lair.gwReconcile(ms) };
  await settle();
  return result;
};
/** A request to the Lair as the staff page makes it (each a moment after the last) */
async function call(method, path, body, customer = OWNER) {
  clock += 1;
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  }));
  const data = await response.json();
  await settle();
  return { status: response.status, data };
}
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const lines = () => lair.sql.exec('SELECT * FROM gw_orderins ORDER BY placed_at, id').toArray();
const order = (n) => lair.sql.exec('SELECT * FROM gw_orders WHERE order_id = ?', `gid://shopify/Order/${n}`).toArray()[0];
const mailsTo = (to) => mails.filter((m) => m.to === to);
const KAI = { id: 7001, first: 'Kai', email: 'kai@example.com' };
const MIA = { id: 7002, first: 'Mia', email: 'mia@example.com' };
const LEO = { id: 7003, first: 'Leo', email: 'leo@example.com' };

beforeEach(() => {
  nowIs(NOW);
  pending = [];
  mails = [];
  batches = [];
  mailDown = false;
  adjusts = new Map();
  adjustCalls = [];
  trouble = {};
  schedule = { overrides: {}, digest: null };
  stock = new Map([
    [KIT, { code: CODE[KIT], title: 'Combat Patrol: Space Marines', available: 0, policy: 'CONTINUE', pack: 1, release: '', price: '210.00', tracked: true }],
    [PAINT, { code: CODE[PAINT], title: 'Base: Abaddon Black (18ml)', available: 0, policy: 'CONTINUE', pack: 6, release: '', price: '8.50', tracked: true }],
    [SOON, { code: CODE[SOON], title: 'Kill Team: Starter Set', available: 0, policy: 'CONTINUE', pack: 1, release: '', price: '180.00', tracked: true }],
    [NULN, { code: CODE[NULN], title: 'Shade: Nuln Oil (24ml)', available: 2, policy: 'CONTINUE', pack: 6, release: '', price: '11.60', tracked: true }],
  ]);
  orders = new Map();
  lair = new Lair(fakeCtx(pending), ENV);
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.customerTags = async (id) => (id === OWNER ? ['staff'] : []);
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  lair.shopify.gwStock = async (ids) => ({
    variants: new Map(ids.filter((id) => stock.has(id)).map((id) => [id, { id, ...stock.get(id) }])), overrides: schedule.overrides,
  });
  lair.shopify.gwOrderInfo = async (orderId) => {
    const info = orders.get(orderId)?.info;
    return info ? { id: info.id, name: info.name, createdAt: info.createdAt, shippingLine: info.shippingLine } : null;
  };
  lair.shopify.orderGiftBuyer = async (orderId) => {
    const info = orders.get(orderId)?.info;
    return info ? { name: info.name, email: info.email || '', firstName: info.customer?.firstName || '' } : null;
  };
  lair.shopify.gwState = async (ids) => {
    if (trouble.state) {
      trouble.state = null;
      throw new Error('Shopify is having a moment');
    }
    const state = new Map();
    for (const id of ids) {
      if (stock.has(id)) state.set(id, { available: stock.get(id).available, cancelledAt: null, currentQuantity: NaN });
      else if (orders.has(id)) state.set(id, { available: NaN, cancelledAt: orders.get(id).cancelledAt, currentQuantity: NaN });
      else {
        const o = [...orders.values()].find((x) => x.lines.has(id));
        if (o) state.set(id, { available: NaN, cancelledAt: null, currentQuantity: o.lines.get(id) });
      }
    }
    return state;
  };
  lair.shopify.gwMarkOrder = async () => true;
  lair.shopify.gwBelowZero = async () => ({
    variants: [...stock].filter(([, v]) => v.available < 0).map(([id, v]) => ({ id, ...v })), overrides: schedule.overrides,
  });
  lair.shopify.gwScheduleRead = async () => {
    if (trouble.read) throw new Error('Shopify is having a moment');
    return { shopId: 'gid://shopify/Shop/63862538343', overrides: JSON.parse(JSON.stringify(schedule.overrides)), digest: schedule.digest };
  };
  lair.shopify.gwScheduleSave = async (shopId, value, digest) => {
    assert.equal(shopId, 'gid://shopify/Shop/63862538343');
    if (trouble.save === 'stale' || digest !== schedule.digest) {
      trouble.save = null;
      return { stale: true };
    }
    schedule = { overrides: JSON.parse(value).overrides, digest: `digest-${Math.random()}` };
    return { ok: true };
  };
  lair.shopify.gwReceiveLookup = async (codes) => {
    if (trouble.lookup) throw new Error(trouble.lookup);
    const found = new Map();
    for (const [id, v] of stock) {
      if (codes.includes(v.code)) found.set(v.code, { variantId: id, inventoryItemId: itemOf(id), tracked: v.tracked !== false, title: v.title });
    }
    return found;
  };
  // Shopify's inventoryAdjustQuantities with its idempotency key (24 hours, as Shopify keeps them)
  lair.shopify.gwAdjust = async (changes, locationId, key, reference) => {
    adjustCalls.push({ key, changes, reference });
    assert.equal(locationId, LOCATION);
    const params = JSON.stringify(changes);
    const seen = adjusts.get(key);
    if (seen && seen.params !== params) return { errors: [{ code: 'IDEMPOTENCY_KEY_PARAMETER_MISMATCH', message: 'The same idempotency key cannot be used with different operation parameters.' }] };
    if (seen?.ok) return { ok: true };
    if (seen && !seen.ok) return { errors: [{ code: 'IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED', message: 'A previous request with this idempotency key failed.' }] };
    const next = trouble.adjust;
    trouble.adjust = null;
    if (next === 'down') throw new Error('Shopify API error 502');
    if (next === 'refused') {
      const error = new Error('Shopify API: Access denied for inventoryAdjustQuantities field. Required access: `write_inventory` access scope.');
      error.nothingRan = true;
      error.refused = true;
      throw error;
    }
    if (Array.isArray(next)) {
      if (!next.includes('IDEMPOTENCY_CONCURRENT_REQUEST')) adjusts.set(key, { ok: false, params });
      return { errors: next.map((code) => ({ code, message: code === 'INVALID_LOCATION' ? 'The specified location could not be found.' : 'Try again.' })) };
    }
    for (const change of changes) {
      const variant = [...stock.keys()].find((id) => itemOf(id) === change.inventoryItemId);
      stock.get(variant).available += change.delta;
    }
    adjusts.set(key, { ok: true, params });
    if (next === 'lost') throw new Error('The network connection was lost.');
    return { ok: true };
  };
  lair.mail = async (message) => {
    mails.push(message);
    return { ok: true, attempted: true, status: 200 };
  };
  lair.mailMany = async (messages) => {
    if (mailDown) return { ok: false, attempted: true, status: 500, message: 'Resend is down', sent: 0 };
    batches.push(messages.map((m) => m.to));
    mails.push(...messages);
    return { ok: true, attempted: true, status: 200, sent: messages.length };
  };
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  // the latest order pad (round 26), for top-ups and the delivery screen's barcodes
  const padRow = (code, title, pack, barcode, mrp) => lair.sql.exec(
    `INSERT INTO gw_pad (code, desc, title, system, race, ss, barcode, pack, trade, mrp, release, min_stock, type, tags, range_key, colour, part)
     VALUES (?, ?, ?, '', '', '', ?, ?, 0, ?, NULL, 0, 'War Game', '[]', NULL, NULL, 1)`,
    code, title, title, barcode, pack, mrp,
  );
  padRow(CODE[KIT], 'Combat Patrol: Space Marines', 1, '5011921160001', 21000);
  padRow(CODE[PAINT], 'Base: Abaddon Black (18ml)', 6, '5011921150001', 850);
  padRow(CODE[SOON], 'Kill Team: Starter Set', 1, '5011921170001', 18000);
  padRow(CODE[NULN], 'Shade: Nuln Oil (24ml)', 6, '5011921100009', 1160);
  padRow('99120199999', 'Shade: 50%_Off Wash', 6, '', 1160);
  // Monday 2 Nov's list went this morning
  lair.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('gw-list', '2026-11-02')");
  lair.sql.exec("INSERT INTO staff_helpers (customer_id, perms, status, created_at) VALUES (?, ?, 'active', ?)", HELPER, JSON.stringify(STAFF_PERMS), NOW);
});
afterEach(() => {
  Date.now = realNow;
});

/* ---------------- the weeks ---------------- */

test('round 27: the open week through the week, and skipped Mondays', () => {
  assert.equal(mondayOf('2026-11-03'), '2026-11-02');
  assert.equal(mondayOf('2026-11-02'), '2026-11-02');
  assert.equal(mondayOf('2026-11-08'), '2026-11-02');
  assert.deepEqual(weekDates('2026-11-09'), { ships: '2026-11-12', promise: '2026-11-26', skip: false });
  assert.deepEqual(weekDates('2026-11-09', { '2026-11-09': { ships: '2026-11-13', promise: '2026-12-01' } }), { ships: '2026-11-13', promise: '2026-12-01', skip: false });
  assert.equal(listWeek('2026-11-09', { '2026-11-09': { skip: true }, '2026-11-16': { skip: true } }), '2026-11-23');
  const open = (ms, overrides = {}) => lair.gwOpenWeek(ms, overrides);
  // Tuesday afternoon, the list gone: next Monday's
  assert.equal(open(NOW), '2026-11-09');
  // a Monday: today's, until midnight
  assert.equal(open(at('2026-11-09', 23, 59)), '2026-11-09');
  // after midnight on Monday, before the list goes at 6am: still that Monday's
  assert.equal(open(at('2026-11-10', 5)), '2026-11-09');
  lair.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('gw-list', '2026-11-09')");
  assert.equal(open(at('2026-11-10', 7)), '2026-11-16');
  // a skipped Monday passes it on
  assert.equal(open(at('2026-11-10', 7), { '2026-11-16': { skip: true } }), '2026-11-23');
});

/* ---------------- this week's order ---------------- */

test("round 27: this week's order: so far, shelf top-ups, the list as it went, and top-ups after", async () => {
  await pay(1, [gwLine(11, KIT, 1)], { who: KAI });
  await pay(2, [gwLine(21, PAINT, 2)], { who: MIA, how: 'ship' });
  let week = ok(await call('GET', 'gw/week'));
  assert.equal(week.open.cutoff, '2026-11-09');
  assert.equal(week.open.due, '2026-11-10');
  assert.deepEqual(week.open.codes.map((c) => [c.code, c.units, c.packs, c.topup]), [[CODE[KIT], 1, 1, 0], [CODE[PAINT], 2, 1, 0]]);
  assert.equal(week.open.total, 21000 + 6 * 850);
  assert.equal(week.sent, null, 'no list kept yet');
  // two more packs of Abaddon Black for the shelf, and a pack of Nuln Oil nobody's ordered
  week = ok(await call('POST', 'gw/topups', { cutoff: '2026-11-09', code: CODE[PAINT], packs: 2 }));
  week = ok(await call('POST', 'gw/topups', { cutoff: '2026-11-09', code: CODE[NULN], packs: 1 }));
  assert.deepEqual(week.open.codes.map((c) => [c.code, c.units, c.packs, c.topup]), [[CODE[KIT], 1, 1, 0], [CODE[PAINT], 2, 1, 2], [CODE[NULN], 0, 0, 1]]);
  assert.equal(week.open.total, 21000 + 3 * 6 * 850 + 6 * 1160);
  // changed, then taken off and put back
  week = ok(await call('POST', 'gw/topups', { cutoff: '2026-11-09', code: CODE[NULN], packs: 0 }));
  assert.equal(week.open.codes.some((c) => c.code === CODE[NULN]), false);
  ok(await call('POST', 'gw/topups', { cutoff: '2026-11-09', code: CODE[NULN], packs: 1 }));
  // what's turned away
  assert.equal(said(await call('POST', 'gw/topups', { cutoff: '2026-11-09', code: '99120100000', packs: 1 })), `422 ${W.notOnPad}`);
  assert.equal(said(await call('POST', 'gw/topups', { cutoff: '2026-11-09', code: CODE[NULN], packs: 100 })), `422 ${W.packs}`);
  assert.equal(said(await call('POST', 'gw/topups', { cutoff: '2026-11-09', code: CODE[NULN], packs: 1.5 })), `422 ${W.packs}`);
  assert.equal(said(await call('POST', 'gw/topups', { cutoff: '2026-11-09', code: CODE[NULN] })), `422 ${W.packs}`);
  assert.equal(said(await call('POST', 'gw/topups', { cutoff: '2026-11-16', code: CODE[NULN], packs: 1 })), `422 ${W.closed}`);
  assert.equal(said(await call('POST', 'gw/topups', { cutoff: '2026-11-02', code: CODE[NULN], packs: 1 })), `422 ${W.closed}`);

  // Tuesday 10 November, 6am: the list goes with the top-ups on it
  await maintain(at('2026-11-10', 6, 5));
  const list = mailsTo('staff@example.com').find((m) => m.subject.startsWith('GW order for Monday 9 Nov'));
  assert.ok(list, 'the list went');
  assert.match(list.subject, /3 codes/);
  assert.match(list.text, /> 99120101386,1\n> 99189950001,3\n> 99189953083,1/);
  assert.match(list.text, /Base: Abaddon Black \(18ml\): 2 ordered in, so 1 pack of 6 \(4 extra for the shelf\), plus 2 packs for the shelf/);
  assert.match(list.text, /Shade: Nuln Oil \(24ml\): 1 pack of 6 for the shelf/);
  assert.match(list.text, /At NZ RRP: +\$432\.60/, 'at NZ RRP: $210 + 18 × $8.50 + 6 × $11.60');
  assert.match(list.text, /When the box comes/);
  const csv = atob(list.attachments[0].content);
  assert.equal(csv, 'Product code,Quantity\n99120101386,1\n99189950001,3\n99189953083,1\n');

  week = ok(await call('GET', 'gw/week'));
  assert.equal(week.open.cutoff, '2026-11-16');
  assert.deepEqual(week.open.codes, []);
  assert.equal(week.sent.cutoff, '2026-11-09');
  assert.ok(week.sent.at);
  assert.deepEqual(week.sent.codes.map((c) => [c.code, c.units, c.packs, c.topup, c.waiting]), [
    [CODE[KIT], 1, 1, 0, 1], [CODE[PAINT], 2, 1, 2, 2], [CODE[NULN], 0, 0, 1, 0],
  ]);
  assert.equal(week.sent.paste, '99120101386,1\n99189950001,3\n99189953083,1');
  // a top-up after it went: on the tab's lines to paste, not a new email
  week = ok(await call('POST', 'gw/topups', { cutoff: '2026-11-09', code: CODE[SOON], packs: 2 }));
  assert.equal(week.sent.paste, '99120101386,1\n99120102999,2\n99189950001,3\n99189953083,1');
  assert.equal(week.sent.csv, 'Product code,Quantity\n99120101386,1\n99120102999,2\n99189950001,3\n99189953083,1\n');
  // next week's top-ups are next week's
  ok(await call('POST', 'gw/topups', { cutoff: '2026-11-16', code: CODE[NULN], packs: 3 }));
  week = ok(await call('GET', 'gw/week'));
  assert.deepEqual(week.open.codes.map((c) => [c.code, c.topup]), [[CODE[NULN], 3]]);
  assert.equal(said(await call('POST', 'gw/topups', { cutoff: '2026-11-02', code: CODE[NULN], packs: 1 })), `422 ${W.closed}`);
  // ordered-in sales, week by week
  assert.deepEqual(week.weeks, [{ cutoff: '2026-11-09', online: { orders: 2, units: 3, value: 21000 + 2 * 850 }, counter: { orders: 0, units: 0, value: 0 } }]);
});

test('round 27: a line on the pad by barcode, code or words', async () => {
  assert.deepEqual(ok(await call('GET', 'gw/find?q=5011921100009')).lines.map((l) => l.code), [CODE[NULN]]);
  assert.deepEqual(ok(await call('GET', 'gw/find?q=991899')).lines.map((l) => l.code), [CODE[PAINT], CODE[NULN]]);
  assert.deepEqual(ok(await call('GET', 'gw/find?q=nuln oil')).lines.map((l) => [l.code, l.title, l.pack, l.price]), [[CODE[NULN], 'Shade: Nuln Oil (24ml)', 6, 1160]]);
  assert.deepEqual(ok(await call('GET', 'gw/find?q=patrol space')).lines.map((l) => l.code), [CODE[KIT]]);
  // LIKE's own characters are just characters
  assert.deepEqual(ok(await call('GET', 'gw/find?q=50%25_off')).lines.map((l) => l.code), ['99120199999']);
  assert.deepEqual(ok(await call('GET', 'gw/find?q=%25')).lines, []);
  assert.deepEqual(ok(await call('GET', 'gw/find?q=_')).lines, []);
  // a product off the pad, still in the shop (round 26's copy of the shop)
  lair.sql.exec("INSERT INTO gw_shop (sku, variant_id, product_id, product_title, pack, barcode, price) VALUES ('99120108888', 'gid://shopify/ProductVariant/9', 'gid://shopify/Product/9', 'Old Kit', 1, '5011921188888', 6000)");
  assert.deepEqual(ok(await call('GET', 'gw/find?q=5011921188888')).lines, [{ code: '99120108888', title: 'Old Kit', pack: 1, barcode: '5011921188888', price: 6000 }]);
});

/* ---------------- GW couldn't supply ---------------- */

test("round 27: GW couldn't supply: order it again next week, with the new date", async () => {
  await pay(1, [gwLine(11, KIT, 1), gwLine(12, PAINT, 1)], { who: KAI });
  await pay(2, [gwLine(21, KIT, 1)], { who: MIA, how: 'ship' });
  await maintain(at('2026-11-10', 6, 5));
  mails = [];
  assert.equal(order(1).promise, '2026-11-26');
  // GW's trade site says Combat Patrol is out of stock: on next week's order
  const week = ok(await call('POST', 'gw/unsupplied', { cutoff: '2026-11-09', code: CODE[KIT], choice: 'again', tell: true }));
  assert.equal(week.told, 2);
  const kit = lines().filter((l) => l.code === CODE[KIT]);
  assert.deepEqual(kit.map((l) => [l.listed_for, l.promise]), [[null, '2026-12-03'], [null, '2026-12-03']]);
  assert.equal(lines().find((l) => l.code === CODE[PAINT]).listed_for, '2026-11-09', 'the paint is still on its way');
  // one parcel: the order's date is its latest line's
  assert.equal(order(1).promise, '2026-12-03');
  assert.equal(order(2).promise, '2026-12-03');
  const kai = mailsTo('kai@example.com');
  assert.equal(kai.length, 1);
  assert.equal(kai[0].subject, 'A new date for order #1');
  assert.equal(kai[0].replyTo, 'staff@example.com');
  assert.match(kai[0].text, /Hi Kai! Games Workshop couldn't send 1 × Combat Patrol: Space Marines this week, so it's on our next order\. It should now be with you by Thursday 3 December\./);
  assert.match(kai[0].text, /Rather not wait\? Reply to this email and we'll refund it in full\./);
  assert.match(mailsTo('mia@example.com')[0].text, /We'll post your order in one parcel once everything's here\./);
  assert.deepEqual(week.sent.codes.find((c) => c.code === CODE[KIT]).unsupplied, { choice: 'again', units: 2, at: clock });
  assert.equal(week.sent.codes.find((c) => c.code === CODE[KIT]).waiting, 0);
  assert.deepEqual(week.open.codes.map((c) => [c.code, c.units]), [[CODE[KIT], 2]], "on next week's list");
  // the same again (a second tap) changes nothing and says nothing
  const again = ok(await call('POST', 'gw/unsupplied', { cutoff: '2026-11-09', code: CODE[KIT], choice: 'again', tell: true }));
  assert.equal(again.told, 0);
  assert.equal(mails.length, 2);
  // nothing waiting on a code, a list too old, no choice
  assert.equal(said(await call('POST', 'gw/unsupplied', { cutoff: '2026-11-09', code: CODE[KIT], choice: 'refund' })), `422 ${W.noLines}`);
  assert.equal(said(await call('POST', 'gw/unsupplied', { cutoff: '2026-11-09', code: CODE[SOON], choice: 'again' })), `422 ${W.noLines}`);
  assert.equal(said(await call('POST', 'gw/unsupplied', { cutoff: '2026-11-09', code: CODE[KIT], choice: 'later' })), `422 ${W.choice}`);
  assert.equal(said(await call('POST', 'gw/unsupplied', { cutoff: '2026-09-07', code: CODE[KIT], choice: 'again' })), `422 ${W.oldList}`);
  // Tuesday 17 November: it's on that list
  await maintain(at('2026-11-17', 6, 5));
  const list = mailsTo('staff@example.com').find((m) => m.subject.startsWith('GW order for Monday 16 Nov'));
  assert.match(list.text, /> 99120101386,2/);
  assert.deepEqual(lines().filter((l) => l.code === CODE[KIT]).map((l) => l.listed_for), ['2026-11-16', '2026-11-16']);
  // not told late on the old date: the order isn't late until after 3 December
  await maintain(at('2026-11-27', 9));
  assert.equal(mailsTo('staff@example.com').filter((m) => /^Late from Games Workshop/.test(m.subject)).length, 0);
  // without telling them: their dates move, no email
  await pay(3, [gwLine(31, SOON, 1)], { who: LEO });
  await maintain(at('2026-12-01', 6, 5));
  mails = [];
  const quiet = ok(await call('POST', 'gw/unsupplied', { cutoff: '2026-11-30', code: CODE[SOON], choice: 'again', tell: false }));
  assert.equal(quiet.told, 0);
  assert.equal(mails.length, 0);
  assert.equal(order(3).promise, '2026-12-24');
});

test("round 27: GW couldn't supply: refund it, and nothing waits for it", async () => {
  await pay(1, [gwLine(11, KIT, 1), gwLine(12, PAINT, 1)], { who: KAI });
  await maintain(at('2026-11-10', 6, 5));
  mails = [];
  // GW can't supply the Combat Patrol at all: refund it
  let week = ok(await call('POST', 'gw/unsupplied', { cutoff: '2026-11-09', code: CODE[KIT], choice: 'refund', tell: true }));
  assert.equal(week.told, 1);
  const kai = mailsTo('kai@example.com')[0];
  assert.equal(kai.subject, "Sorry: part of order #1 isn't coming");
  assert.match(kai.text, /Hi Kai\. Games Workshop can't supply 1 × Combat Patrol: Space Marines, so we're refunding it in full, back the way you paid\./);
  assert.doesNotMatch(kai.text, /\$210/, "no amount: Shopify's refund says what they paid, after any discount");
  assert.match(kai.text, /The rest of your order is still on its way\./);
  assert.deepEqual(week.refunds.map((r) => [r.order, r.code, r.units, r.amount, r.admin]), [
    ['#1', CODE[KIT], 1, 21000, 'https://admin.shopify.com/store/ep0qiq-rp/orders/1'],
  ]);
  assert.equal(week.sent.codes.find((c) => c.code === CODE[KIT]).unsupplied.choice, 'refund');
  // it isn't in GW's box, so the delivery screen doesn't fill it in, and nobody's waiting on it
  const screen = ok(await call('GET', 'gw/receiving'));
  assert.deepEqual(screen.lastList.codes.map((c) => c.code), [CODE[PAINT]]);
  assert.deepEqual(screen.waiting.map((w) => w.code), [CODE[PAINT]]);
  // Leo orders the same kit next week: the next one that comes is his
  await pay(2, [gwLine(21, KIT, 1)], { who: LEO });
  assert.equal(stock.get(KIT).available, -2);
  stock.get(KIT).available += 1; // one turns up after all
  await maintain(at('2026-11-12', 10));
  assert.equal(lines().find((l) => l.order_id === 'gid://shopify/Order/2').arrived, 1, "Leo's");
  assert.equal(lines().find((l) => l.order_id === 'gid://shopify/Order/1' && l.code === CODE[KIT]).arrived, 0, "never Kai's: it's being refunded");
  // the paint comes in: Kai's order is ready, the refund doesn't hold it up
  stock.get(PAINT).available += 6;
  await maintain(at('2026-11-19', 10));
  assert.ok(order(1).ready_at);
  const inMail = mailsTo('kai@example.com').find((m) => m.subject.startsWith("It's in"));
  assert.ok(inMail, "Kai hears it's in");
  assert.match(inMail.text, /1 × Base: Abaddon Black \(18ml\)/);
  assert.doesNotMatch(inMail.text, /Combat Patrol/);
  // never late
  await maintain(at('2026-11-28', 9));
  assert.equal(mailsTo('staff@example.com').filter((m) => /^Late/.test(m.subject)).length, 0);
  // refunded in Shopify with Restock ticked: off the list
  refund(1, 11, KIT, 1);
  await maintain(at('2026-11-28', 10));
  week = ok(await call('GET', 'gw/week'));
  assert.deepEqual(week.refunds, []);
  assert.equal(lines().find((l) => l.order_id === 'gid://shopify/Order/1' && l.code === CODE[KIT]).cancelled, 1);
});

test("round 27: GW couldn't supply the only thing on an order: ready, and told nothing's coming", async () => {
  await pay(1, [gwLine(11, KIT, 1)], { who: KAI });
  await maintain(at('2026-11-10', 6, 5));
  mails = [];
  ok(await call('POST', 'gw/unsupplied', { cutoff: '2026-11-09', code: CODE[KIT], choice: 'refund', tell: true }));
  assert.equal(mails.length, 1, 'just the refund email: nothing is in, so no It\'s in, and no list for the shop');
  assert.doesNotMatch(mails[0].text, /The rest of your order/);
  assert.ok(order(1).ready_at, 'nothing left to come');
});

/* ---------------- when the box comes ---------------- */

const RECEIPT = 'a1b2c3d4-0001';

test('round 27: the box comes: added to stock once, customers told straight away', async () => {
  await pay(1, [gwLine(11, KIT, 1)], { who: KAI });
  await pay(2, [gwLine(21, PAINT, 2)], { who: MIA, how: 'ship' });
  ok(await call('POST', 'gw/topups', { cutoff: '2026-11-09', code: CODE[PAINT], packs: 1 }));
  await maintain(at('2026-11-10', 6, 5));
  mails = [];
  nowIs(at('2026-11-19', 11));
  let screen = ok(await call('GET', 'gw/receiving'));
  assert.deepEqual(screen.waiting.map((w) => [w.code, w.units, w.orders, w.barcode, w.pack]), [
    [CODE[PAINT], 2, 1, '5011921150001', 6], [CODE[KIT], 1, 1, '5011921160001', 1],
  ]);
  assert.deepEqual(screen.lastList.codes.map((c) => [c.code, c.units]), [[CODE[PAINT], 12], [CODE[KIT], 1]]);
  assert.deepEqual(screen.receipts, []);
  // the box: the kit and two packs of paint
  const body = { receipt: RECEIPT, part: 1, parts: 1, items: [{ code: CODE[PAINT], units: 12 }, { code: CODE[KIT], units: 1 }] };
  const answer = ok(await call('POST', 'gw/receive', body));
  assert.deepEqual(adjustCalls.map((c) => c.key), [`${RECEIPT}-1`]);
  assert.equal(adjustCalls[0].reference, `logistics://dicegoblin.nz/gw-delivery/${RECEIPT}`);
  assert.deepEqual(adjustCalls[0].changes, [{ inventoryItemId: itemOf(KIT), delta: 1 }, { inventoryItemId: itemOf(PAINT), delta: 12 }]);
  assert.equal(stock.get(KIT).available, 0);
  assert.equal(stock.get(PAINT).available, 10, 'two to Mia, ten on the shelf');
  assert.deepEqual(answer.added, [{ code: CODE[KIT], title: 'Combat Patrol: Space Marines', units: 1 }, { code: CODE[PAINT], title: 'Base: Abaddon Black (18ml)', units: 12 }]);
  assert.deepEqual(answer.ready.map((r) => [r.order, r.action]), [
    ['#1', GW_WORDS.ready.pickupTold('Kai')], ['#2', GW_WORDS.ready.ship],
  ]);
  assert.equal(answer.later, false);
  assert.equal(mailsTo('kai@example.com')[0].subject, "It's in: order #1 is ready to collect");
  assert.equal(mailsTo('staff@example.com').filter((m) => m.subject.startsWith('In from Games Workshop')).length, 1);
  // sent again (the answer lost on the way, or a second tap): the same answer, nothing added
  const again = ok(await call('POST', 'gw/receive', body));
  assert.deepEqual(again, answer);
  assert.equal(adjustCalls.length, 1);
  assert.equal(stock.get(PAINT).available, 10);
  // the same part with other counts is a different delivery
  assert.equal(said(await call('POST', 'gw/receive', { ...body, items: [{ code: CODE[PAINT], units: 6 }] })), `409 ${W.changed}`);
  screen = ok(await call('GET', 'gw/receiving'));
  assert.deepEqual(screen.waiting, []);
  assert.deepEqual(screen.receipts.map((r) => [r.receipt, r.units, r.lines, r.ready]), [[RECEIPT, 13, 2, 2]]);
  // maintenance has nothing left to do
  const after = await maintain(at('2026-11-19', 11, 10));
  assert.equal(after.orders, null);
});

test('round 27: a delivery in parts, and what Shopify turns away', async () => {
  await pay(1, [gwLine(11, KIT, 1)], { who: KAI });
  await maintain(at('2026-11-10', 6, 5));
  // too many lines, the same code twice, no units, a bad receipt
  const many = Array.from({ length: RECEIVE_PART + 1 }, (_, i) => ({ code: String(99120100000 + i), units: 1 }));
  assert.equal(said(await call('POST', 'gw/receive', { receipt: RECEIPT, part: 1, parts: 1, items: many })), `413 ${W.tooMany}`);
  assert.equal(said(await call('POST', 'gw/receive', { receipt: RECEIPT, part: 1, parts: 1, items: [{ code: CODE[KIT], units: 1 }, { code: CODE[KIT], units: 2 }] })), `422 ${W.twice}`);
  assert.equal(said(await call('POST', 'gw/receive', { receipt: RECEIPT, part: 1, parts: 1, items: [{ code: CODE[KIT], units: 0 }] })), `422 ${W.units}`);
  assert.equal(said(await call('POST', 'gw/receive', { receipt: RECEIPT, part: 1, parts: 1, items: [{ code: 'DGLRPG-091', units: 1 }] })), `422 ${W.units}`);
  assert.equal(said(await call('POST', 'gw/receive', { receipt: 'x', part: 1, parts: 1, items: [{ code: CODE[KIT], units: 1 }] })), `422 ${W.receipt}`);
  assert.equal(said(await call('POST', 'gw/receive', { receipt: RECEIPT, part: 2, parts: 1, items: [{ code: CODE[KIT], units: 1 }] })), `422 ${W.receipt}`);
  // a code not in the shop: nothing added, and the part can come again without it
  assert.equal(said(await call('POST', 'gw/receive', { receipt: RECEIPT, part: 1, parts: 1, items: [{ code: CODE[KIT], units: 1 }, { code: '99120100000', units: 1 }] })), `422 ${W.notInShop('99120100000')}`);
  stock.get(NULN).tracked = false;
  assert.equal(said(await call('POST', 'gw/receive', { receipt: RECEIPT, part: 1, parts: 1, items: [{ code: CODE[NULN], units: 6 }] })), `422 ${W.untracked(CODE[NULN])}`);
  assert.equal(adjustCalls.length, 0);
  // Shopify turns it down (and adds nothing): the next try has a fresh key
  trouble.adjust = ['INVALID_LOCATION'];
  assert.equal(said(await call('POST', 'gw/receive', { receipt: RECEIPT, part: 1, parts: 2, items: [{ code: CODE[KIT], units: 1 }] })), `422 ${W.shopifyNo('The specified location could not be found.')}`);
  // Shopify busy with the same key a moment ago, then it's in
  trouble.adjust = ['IDEMPOTENCY_CONCURRENT_REQUEST'];
  assert.equal(said(await call('POST', 'gw/receive', { receipt: RECEIPT, part: 1, parts: 2, items: [{ code: CODE[KIT], units: 1 }] })), `503 ${W.busyAdding}`);
  ok(await call('POST', 'gw/receive', { receipt: RECEIPT, part: 1, parts: 2, items: [{ code: CODE[KIT], units: 1 }] }));
  assert.deepEqual(adjustCalls.map((c) => c.key), [`${RECEIPT}-1`, `${RECEIPT}-1-1`, `${RECEIPT}-1-1`]);
  assert.equal(stock.get(KIT).available, 0, 'added once');
  // part 2: Shopify's answer is lost on the way (it was added): asked again with the same key, added once
  trouble.adjust = 'lost';
  assert.equal(said(await call('POST', 'gw/receive', { receipt: RECEIPT, part: 2, parts: 2, items: [{ code: CODE[PAINT], units: 6 }] })), `503 ${W.notAnswered}`);
  assert.equal(stock.get(PAINT).available, 6);
  ok(await call('POST', 'gw/receive', { receipt: RECEIPT, part: 2, parts: 2, items: [{ code: CODE[PAINT], units: 6 }] }));
  assert.equal(stock.get(PAINT).available, 6, 'not twice');
  assert.deepEqual(adjustCalls.slice(-2).map((c) => c.key), [`${RECEIPT}-2`, `${RECEIPT}-2`]);
  // Shopify down before it got there: the same key again, and it's added
  trouble.adjust = 'down';
  const third = { receipt: 'a1b2c3d4-0002', part: 1, parts: 1, items: [{ code: CODE[NULN], units: 6 }] };
  stock.get(NULN).tracked = true;
  assert.equal(said(await call('POST', 'gw/receive', third)), `503 ${W.notAnswered}`);
  ok(await call('POST', 'gw/receive', third));
  assert.equal(stock.get(NULN).available, 8);
  // the permission not approved yet: nothing added, round 26's words
  trouble.adjust = 'refused';
  assert.equal(said(await call('POST', 'gw/receive', { receipt: 'a1b2c3d4-0003', part: 1, parts: 1, items: [{ code: CODE[NULN], units: 1 }] })), `503 ${PAD_WORDS.scopes}`);
  ok(await call('POST', 'gw/receive', { receipt: 'a1b2c3d4-0003', part: 1, parts: 1, items: [{ code: CODE[NULN], units: 1 }] }));
  assert.equal(stock.get(NULN).available, 9);
  assert.equal(adjustCalls.at(-1).key, 'a1b2c3d4-0003-1-1', 'a fresh key after a refusal');
  // a previous try that failed on Shopify's side: a fresh key, and it's added
  adjusts.set('a1b2c3d4-0004-1', { ok: false, params: '[]' });
  // (the same count as the last delivery, so it's sent as another box: again)
  const fourth = { receipt: 'a1b2c3d4-0004', part: 1, parts: 1, again: true, items: [{ code: CODE[NULN], units: 1 }] };
  assert.equal(said(await call('POST', 'gw/receive', fourth)), `409 ${W.changed}`, "Shopify's key for other counts");
  lair.sql.exec("DELETE FROM gw_receipts WHERE receipt = 'a1b2c3d4-0004'");
  adjusts.set('a1b2c3d4-0004-1', { ok: false, params: JSON.stringify([{ inventoryItemId: itemOf(NULN), delta: 1 }]) });
  assert.equal(said(await call('POST', 'gw/receive', fourth)), `503 ${W.notAnswered}`);
  ok(await call('POST', 'gw/receive', fourth));
  assert.equal(stock.get(NULN).available, 10);
  // the stock can't be read straight after: added, and maintenance matches it
  await pay(2, [gwLine(21, SOON, 1)], { who: LEO });
  trouble.state = true;
  const later = ok(await call('POST', 'gw/receive', { receipt: 'a1b2c3d4-0005', part: 1, parts: 1, items: [{ code: CODE[SOON], units: 1 }] }));
  assert.equal(later.later, true);
  assert.deepEqual(later.ready, []);
  await maintain(at('2026-11-10', 9));
  assert.equal(lines().find((l) => l.code === CODE[SOON]).arrived, 1);
  // a part sent a day ago with no answer isn't sent again (Shopify's key has gone by then)
  lair.sql.exec("INSERT INTO gw_receipts (id, receipt, part, parts, items, status, at) VALUES ('a1b2c3d4-0006#1', 'a1b2c3d4-0006', 1, 1, ?, 'sending', ?)",
    JSON.stringify([{ code: CODE[NULN], units: 1 }]), Date.now() - 24 * HOUR);
  assert.equal(said(await call('POST', 'gw/receive', { receipt: 'a1b2c3d4-0006', part: 1, parts: 1, items: [{ code: CODE[NULN], units: 1 }] })), `409 ${W.stale}`);
});

/* ---------------- order dates ---------------- */

test('round 27: order dates: skip a week, change one, push a late one out, and back to usual', async () => {
  await pay(1, [gwLine(11, KIT, 1)], { who: KAI });
  await pay(2, [gwLine(21, PAINT, 1)], { who: MIA, how: 'ship' });
  mails = [];
  let dates = ok(await call('GET', 'gw/dates'));
  assert.equal(dates.open, '2026-11-09');
  assert.equal(dates.weeks.length, 17);
  const nine = (d) => d.weeks.find((w) => w.monday === '2026-11-09');
  assert.deepEqual(nine(dates), { monday: '2026-11-09', ships: '2026-11-12', promise: '2026-11-26', skip: false, changed: false, sent: false, orders: 2, canSkip: true });
  assert.equal(dates.weeks.find((w) => w.monday === '2026-11-02').sent, true);
  assert.equal(dates.weeks.find((w) => w.monday === '2026-11-02').canSkip, false);

  // skip 9 Nov (say GW's closed): its orders join 16 Nov's list and date, and the customers hear
  dates = ok(await call('POST', 'gw/dates', { monday: '2026-11-09', skip: true, tell: true }));
  assert.deepEqual(schedule.overrides, { '2026-11-09': { skip: true } });
  assert.equal(dates.told, 2);
  assert.equal(dates.open, '2026-11-16');
  assert.equal(nine(dates).skip, true);
  assert.equal(nine(dates).orders, 0);
  assert.equal(dates.weeks.find((w) => w.monday === '2026-11-16').orders, 2);
  assert.deepEqual(lines().map((l) => l.promise), ['2026-12-03', '2026-12-03']);
  assert.equal(order(1).promise, '2026-12-03');
  assert.equal(mailsTo('kai@example.com')[0].subject, 'A new date for order #1');
  assert.match(mailsTo('kai@example.com')[0].text, /Hi Kai! Games Workshop's delivery is running later than usual, so your order should now be with you by Thursday 3 December\. Sorry for the wait\./);
  // Tuesday 10 Nov: no list for a skipped week; Tuesday 17 Nov: on 16 Nov's
  await maintain(at('2026-11-10', 6, 5));
  assert.equal(mailsTo('staff@example.com').filter((m) => m.subject.startsWith('GW order')).length, 0);
  await maintain(at('2026-11-17', 6, 5));
  assert.equal(mailsTo('staff@example.com').filter((m) => m.subject.startsWith('GW order for Monday 16 Nov')).length, 1);
  assert.deepEqual(lines().map((l) => l.listed_for), ['2026-11-16', '2026-11-16']);

  // deliveries slipping: 16 Nov's (already sent) pushed out a week, told
  mails = [];
  dates = ok(await call('POST', 'gw/dates', { monday: '2026-11-16', ships: '2026-11-26', promise: '2026-12-10', tell: true }));
  assert.equal(dates.told, 2);
  assert.deepEqual(schedule.overrides['2026-11-16'], { ships: '2026-11-26', promise: '2026-12-10' });
  assert.deepEqual(lines().map((l) => l.promise), ['2026-12-10', '2026-12-10']);
  assert.match(mailsTo('mia@example.com')[0].text, /by Thursday 10 December/);
  // late was flagged on the old date, then told again on the new one
  lair.sql.exec("UPDATE gw_orders SET late_at = 1 WHERE order_id = 'gid://shopify/Order/1'");
  ok(await call('POST', 'gw/dates', { monday: '2026-11-16', ships: '2026-11-26', promise: '2026-12-11', tell: false }));
  assert.equal(order(1).late_at, null);
  // the same dates as usual: back to usual; and reset
  ok(await call('POST', 'gw/dates', { monday: '2026-11-16', ships: '2026-11-19', promise: '2026-12-03', tell: false }));
  assert.equal('2026-11-16' in schedule.overrides, false);
  assert.deepEqual(lines().map((l) => l.promise), ['2026-12-03', '2026-12-03']);
  ok(await call('POST', 'gw/dates', { monday: '2026-12-21', ships: '2026-12-24', promise: '2027-01-14', tell: false }));
  ok(await call('POST', 'gw/dates', { monday: '2026-12-21', reset: true }));
  assert.equal('2026-12-21' in schedule.overrides, false);
  // an earlier date is good news
  await pay(3, [gwLine(31, SOON, 1)], { who: LEO });
  mails = [];
  ok(await call('POST', 'gw/dates', { monday: '2026-11-23', ships: '2026-11-26', promise: '2026-12-08', tell: true }));
  assert.match(mailsTo('leo@example.com')[0].text, /Hi Leo! Good news: your order should now be with you by Tuesday 8 December\./);
});

test("round 27: order dates: what's turned away, and two changes at once", async () => {
  nowIs(at('2026-11-17', 13));
  lair.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('gw-list', '2026-11-16')");
  assert.equal(said(await call('POST', 'gw/dates', { monday: '2026-11-17', skip: true })), `422 ${W.monday}`);
  assert.equal(said(await call('POST', 'gw/dates', { monday: '2026-09-28', skip: true })), `422 ${W.monday}`);
  assert.equal(said(await call('POST', 'gw/dates', { monday: '2027-06-07', skip: true })), `422 ${W.monday}`);
  assert.equal(said(await call('POST', 'gw/dates', { monday: '2026-11-16', skip: true })), `422 ${W.sentSkip}`);
  assert.equal(said(await call('POST', 'gw/dates', { monday: '2026-11-23', ships: '2026-11-23', promise: '2026-12-10' })), `422 ${W.dates}`);
  assert.equal(said(await call('POST', 'gw/dates', { monday: '2026-11-23', ships: '2026-11-30', promise: '2026-11-29' })), `422 ${W.dates}`);
  assert.equal(said(await call('POST', 'gw/dates', { monday: '2026-11-23', ships: '2026-11-26', promise: '2027-01-19' })), `422 ${W.dates}`);
  assert.equal(said(await call('POST', 'gw/dates', { monday: '2026-11-23' })), `422 ${W.dates}`);
  // four Christmas weeks skipped in a row is the most
  for (const monday of ['2026-12-21', '2026-12-28', '2027-01-04', '2027-01-11']) ok(await call('POST', 'gw/dates', { monday, skip: true }));
  assert.equal(said(await call('POST', 'gw/dates', { monday: '2027-01-18', skip: true })), `422 ${W.tooManySkips}`);
  assert.equal(said(await call('POST', 'gw/dates', { monday: '2026-12-14', skip: true })), `422 ${W.tooManySkips}`);
  const dates = ok(await call('GET', 'gw/dates'));
  assert.equal(dates.weeks.find((w) => w.monday === '2026-12-14').canSkip, false);
  assert.equal(dates.weeks.find((w) => w.monday === '2026-12-07').canSkip, true);
  // someone else changed them in between: have another look
  trouble.save = 'stale';
  assert.equal(said(await call('POST', 'gw/dates', { monday: '2026-11-30', skip: true })), `409 ${W.clash}`);
  // Shopify can't be read
  trouble.read = true;
  assert.equal(said(await call('POST', 'gw/dates', { monday: '2026-11-30', skip: true })), `503 ${PAD_WORDS.shopify}`);
  // the week still shows from the last copy
  const week = ok(await call('GET', 'gw/week'));
  assert.equal(week.open.cutoff, '2026-11-23');
  // weeks long gone are tidied away
  trouble.read = false;
  schedule.overrides['2026-08-03'] = { skip: true };
  ok(await call('POST', 'gw/dates', { monday: '2026-11-30', ships: '2026-12-03', promise: '2026-12-18' }));
  assert.equal('2026-08-03' in schedule.overrides, false);
});

/* ---------------- who ---------------- */

test('round 27: the owner only', async () => {
  for (const customer of [HELPER, MEMBER]) {
    for (const [method, path, body] of [
      ['GET', 'gw/week'], ['GET', 'gw/find?q=nuln'], ['GET', 'gw/receiving'], ['GET', 'gw/dates'],
      ['POST', 'gw/topups', { cutoff: '2026-11-09', code: CODE[NULN], packs: 1 }],
      ['POST', 'gw/unsupplied', { cutoff: '2026-11-09', code: CODE[KIT], choice: 'again' }],
      ['POST', 'gw/receive', { receipt: RECEIPT, part: 1, parts: 1, items: [{ code: CODE[KIT], units: 1 }] }],
      ['POST', 'gw/dates', { monday: '2026-11-23', skip: true }],
    ]) {
      const res = await call(method, path, body, customer);
      assert.equal(res.status, 403, `${customer} ${method} ${path}`);
    }
  }
  assert.equal(adjustCalls.length, 0);
  assert.deepEqual(schedule.overrides, {});
});

/* ---------------- the review, 31 Oct 2026 ---------------- */

test('round 27 (the review): customers are told in one batch, and told counts what went', async () => {
  await pay(1, [gwLine(11, KIT, 1)], { who: KAI });
  await pay(2, [gwLine(21, KIT, 1)], { who: MIA, how: 'ship' });
  await pay(3, [gwLine(31, KIT, 1)], { who: LEO, how: 'counter' });
  await maintain(at('2026-11-10', 6, 5));
  mails = [];
  batches = [];
  const singles = () => mails.filter((m) => m.to !== 'staff@example.com').length - batches.flat().length;
  // three customers' new dates: one request to Resend, not three at once (it takes a couple a second)
  const week = ok(await call('POST', 'gw/unsupplied', { cutoff: '2026-11-09', code: CODE[KIT], choice: 'again', tell: true }));
  assert.equal(week.told, 3);
  assert.deepEqual(batches, [['kai@example.com', 'mia@example.com', 'leo@example.com']]);
  assert.equal(singles(), 0);
  // the box completes all three: Kai (pickup) and Leo (counter) hear it's in, together
  await maintain(at('2026-11-17', 6, 5));
  mails = [];
  batches = [];
  ok(await call('POST', 'gw/receive', { receipt: 'b1b2c3d4-0001', part: 1, parts: 1, items: [{ code: CODE[KIT], units: 3 }] }));
  assert.deepEqual(batches, [['kai@example.com', 'leo@example.com']]);
  assert.equal(singles(), 0);
  assert.ok(order(1).ready_told_at && order(3).ready_told_at, 'kept as told once Resend took them');
  // Resend down: told says nobody heard
  await pay(4, [gwLine(41, SOON, 1)], { who: KAI });
  await pay(5, [gwLine(51, SOON, 1)], { who: MIA });
  await maintain(at('2026-11-24', 6, 5));
  mailDown = true;
  const down = ok(await call('POST', 'gw/unsupplied', { cutoff: '2026-11-23', code: CODE[SOON], choice: 'refund', tell: true }));
  assert.equal(down.told, 0);
});

test('round 27 (the review): shelf top-ups follow their week when it is skipped', async () => {
  ok(await call('POST', 'gw/topups', { cutoff: '2026-11-09', code: CODE[NULN], packs: 2 }));
  ok(await call('POST', 'gw/topups', { cutoff: '2026-11-09', code: CODE[PAINT], packs: 1 }));
  // a top-up already on the week after (added before it was the open week)
  lair.sql.exec("INSERT INTO gw_topups (cutoff, code, title, pack, packs, price, added_at) VALUES ('2026-11-16', ?, 'Shade: Nuln Oil (24ml)', 6, 1, 1160, 1)", CODE[NULN]);
  ok(await call('POST', 'gw/dates', { monday: '2026-11-09', skip: true, tell: false }));
  const week = ok(await call('GET', 'gw/week'));
  assert.equal(week.open.cutoff, '2026-11-16');
  assert.deepEqual(week.open.codes.map((c) => [c.code, c.topup]), [[CODE[PAINT], 1], [CODE[NULN], 3]]);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM gw_topups WHERE cutoff = '2026-11-09'").one().n, 0);
});

test('round 27 (the review): a delivery that looks the same as one just added asks first', async () => {
  await pay(1, [gwLine(11, KIT, 1)], { who: KAI });
  await maintain(at('2026-11-10', 6, 5));
  nowIs(at('2026-11-19', 15, 40));
  ok(await call('POST', 'gw/receive', { receipt: 'c1b2c3d4-0001', part: 1, parts: 1, items: [{ code: CODE[KIT], units: 1 }, { code: CODE[PAINT], units: 6 }] }));
  // the same count again from another tab, or the tablet: nothing added until they say so
  nowIs(at('2026-11-19', 16, 5));
  const again = await call('POST', 'gw/receive', { receipt: 'c1b2c3d4-0002', part: 1, parts: 1, items: [{ code: CODE[PAINT], units: 6 }, { code: CODE[KIT], units: 1 }] });
  assert.equal(said(again), `412 ${W.repeat('today at 3:40pm')}`);
  assert.equal(adjustCalls.length, 1);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM gw_receipts WHERE receipt = 'c1b2c3d4-0002'").one().n, 0, 'nothing kept for it');
  // they say it's another box
  ok(await call('POST', 'gw/receive', { receipt: 'c1b2c3d4-0002', part: 1, parts: 1, again: true, items: [{ code: CODE[PAINT], units: 6 }, { code: CODE[KIT], units: 1 }] }));
  assert.equal(adjustCalls.length, 2);
  assert.equal(stock.get(PAINT).available, 12);
  // other counts aren't the same delivery; nor is one from yesterday
  ok(await call('POST', 'gw/receive', { receipt: 'c1b2c3d4-0003', part: 1, parts: 1, items: [{ code: CODE[KIT], units: 2 }] }));
  nowIs(at('2026-11-20', 15));
  const later = await call('POST', 'gw/receive', { receipt: 'c1b2c3d4-0004', part: 1, parts: 1, items: [{ code: CODE[KIT], units: 2 }] });
  assert.equal(said(later), `412 ${W.repeat('Thu 19 Nov at 4:05pm')}`, 'yesterday, within a day');
  nowIs(at('2026-11-21', 17));
  ok(await call('POST', 'gw/receive', { receipt: 'c1b2c3d4-0004', part: 1, parts: 1, items: [{ code: CODE[KIT], units: 2 }] }));
});

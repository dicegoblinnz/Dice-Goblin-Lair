// Round 34, discounts on the till (contract v34-till-discounts). Mo (10 Nov 2026): "for the till have an option to apply
// discounts but once applied the staff needs to 'log in' and that goes through make sure no item can go below 25%
// discount". A discount is a percent off a shop product, up to 25%; Pay takes it only with a PIN just put in by the
// owner or someone with Money; Shopify's own figures are checked again, and a line on a deal can't have one too.
// Round 35 (Mo, 10 Nov 2026: "make it go off actual dollar value not % ... Actually make it 20%"): discounts are dollars
// off each one now (test/round35-till-discounts.test.js). The percent here is still read, from a till that hasn't
// reloaded: up to 20, held to round 35's 80% of the full price, so the three checks of the 25% say 20 now, and one over
// gets round 35's words. Approving, the tag and the note are as they were.
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { TILL_ORDER_TAG, counterSale, counterSource, tillSale, verifoneSale } from '../src/counter.js';
import { COUNTER_SOURCES } from '../src/newplayers.js';
import { tillDraftInput, tillFiguresOf } from '../src/shopify.js';
import { TILL_DISCOUNT_WORDS as D, TILL_DISCOUNT_FRESH_MS, tillDiscountIn } from '../src/till-discounts.js';
import { TILL_PEOPLE_WORDS as P } from '../src/till-people.js';
import { TILL_SALE_WORDS as S, TILL_MARKER, TILL_SHOP_LOCATION, TILL_SALE_OPEN_MS, tillBasketIn, tillPick } from '../src/till-sales.js';
import { TILL_WORDS as W } from '../src/till.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY_MS = 24 * HOUR;
// Sunday 25 October 2026, 10:00am in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 9, 24, 21, 0);
const DAY = '2026-10-25';
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const realNow = Date.now;
const nowIs = (ms) => {
  Date.now = () => ms;
};
// The Lair app's ID, as Shopify gives it for the orders the Lair makes (source_name)
const LAIR_APP = '430573649921';

let background = [];
function fakeCtx() {
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
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: (p) => background.push(p) };
}
/** Everything the Lair left running in the background, finished */
const settle = async () => {
  while (background.length) await background.shift();
};

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];
const EVENTS = [{ id: 'quiz', title: 'Trivia night', start: at(DAY, 18), end: at(DAY, 20), tables: '', capacity: 20, entryFee: 500 }];
// Mo (the owner); helpers Hemi (Check-in) and Tama (Library only: sales only on the till); members Mia and Kai
const OWNER = '9001';
const HEMI = '9102';
const TAMA = '9103';
const MIA = '6001';
const KAI = '6002';
// Rua: a helper with Money, who can approve discounts
const RUA = '9104';

/* ---------- the shop, as the fake Shopify has it ---------- */
const PRODUCTS = {
  oakie: { id: '101', title: 'Oakie Doakie Translucent RPG Dice Set', type: 'Dice & Accessories', vendor: 'Oakie Doakie Dice', status: 'ACTIVE', giftCard: false, dice: true },
  wave: { id: '102', title: 'Sea Wave Blossom D20 (33 mm)', type: 'Dice & Accessories', vendor: 'Dice Goblin NZ', status: 'ACTIVE', giftCard: false, dice: true },
  booster: { id: '103', title: 'Riftbound Radiance', type: 'Trading Card Games', vendor: 'Riot Games', status: 'ACTIVE', giftCard: false, dice: false },
  session: { id: '104', title: 'Session', type: '', vendor: 'Dice Goblin NZ', status: 'UNLISTED', giftCard: false, dice: false },
  drinks: { id: '105', title: 'Drinks', type: 'Food & Drink', vendor: 'Dice Goblin NZ', status: 'ACTIVE', giftCard: false, dice: false },
  old: { id: '106', title: 'Old promo', type: '', vendor: 'Dice Goblin NZ', status: 'ARCHIVED', giftCard: false, dice: false },
  libraryCopy: { id: '107', title: 'Catan (Library)', type: 'Board Games', vendor: 'Catan Studio', status: 'ACTIVE', giftCard: false, dice: false },
  card: { id: '108', title: 'Gift card', type: '', vendor: 'Dice Goblin NZ', status: 'ACTIVE', giftCard: true, dice: false },
  // (10 Nov 2026) different things on one barcode: two sets' boosters, and a dice set whose colours share one
  sparks: { id: '109', title: 'Pokemon Surging Sparks Booster', type: 'Trading Card Games', vendor: 'Pokemon', status: 'ACTIVE', giftCard: false, dice: false },
  prism: { id: '110', title: 'Pokemon Prismatic Evolutions Booster', type: 'Trading Card Games', vendor: 'Pokemon', status: 'ACTIVE', giftCard: false, dice: false },
  sparksCopy: { id: '111', title: 'Pokemon Surging Sparks Booster (Library)', type: 'Trading Card Games', vendor: 'Pokemon', status: 'ACTIVE', giftCard: false, dice: false },
  glow: { id: '112', title: 'Glow Dice Set', type: 'Dice & Accessories', vendor: 'Dice Goblin NZ', status: 'ACTIVE', giftCard: false, dice: true },
};
const VARIANTS = {
  5011: { product: 'oakie', id: '5011', title: 'Green', sku: null, barcodes: ['4056133701068'], price: 1599, tracked: true, stock: 35, oversell: false },
  5012: { product: 'wave', id: '5012', title: 'Default Title', sku: 'DGD-F2-D20-33', barcodes: [], price: 5000, tracked: true, stock: 0, oversell: false },
  5013: { product: 'booster', id: '5013', title: 'Booster Pack', sku: null, barcodes: ['810155276195'], price: 1100, tracked: true, stock: 12, oversell: false },
  5014: { product: 'session', id: '5014', title: 'RPG Session', sku: 'LAIR-SESSION-RPG', barcodes: ['31283123850'], price: 1500, tracked: false, stock: null, oversell: false },
  5015: { product: 'drinks', id: '5015', title: '$3 Drink', sku: null, barcodes: [], price: 300, tracked: false, stock: null, oversell: false },
  5016: { product: 'old', id: '5016', title: 'Default Title', sku: 'OLD-1', barcodes: ['9999000011'], price: 500, tracked: false, stock: null, oversell: false },
  5017: { product: 'libraryCopy', id: '5017', title: 'Default Title', sku: 'DGL34-M011', barcodes: [], price: 0, tracked: true, stock: 1, oversell: false },
  5018: { product: 'card', id: '5018', title: '$50', sku: null, barcodes: ['5555000011'], price: 5000, tracked: false, stock: null, oversell: false },
  5019: { product: 'sparks', id: '5019', title: 'Default Title', sku: 'PKM-SSP-BP', barcodes: ['820650857442'], price: 1000, tracked: true, stock: 20, oversell: false },
  5020: { product: 'prism', id: '5020', title: 'Default Title', sku: 'PKM-PRE-BP', barcodes: ['0820650857442'], price: 1400, tracked: true, stock: 0, oversell: false },
  5021: { product: 'sparksCopy', id: '5021', title: 'Default Title', sku: null, barcodes: ['820650857442'], price: 0, tracked: true, stock: 1, oversell: false },
  5022: { product: 'glow', id: '5022', title: 'Green', sku: null, barcodes: ['6900000000123'], price: 2000, tracked: true, stock: 3, oversell: false },
  5023: { product: 'glow', id: '5023', title: 'Blue', sku: null, barcodes: ['6900000000123'], price: 2000, tracked: true, stock: 2, oversell: false },
};
const match = (id) => ({ product: { ...PRODUCTS[VARIANTS[id].product] }, variant: { ...VARIANTS[id] } });

/** Shopify's figures for a draft's lines, as the fake works them out: the shop's prices, every third dice free, GST */
/**
 * Shopify's figures as the fake works them out: the shop's prices, a line's staff discount (a percent of the line, as
 * Shopify's PERCENTAGE applied discount), then every third dice free (on the dice left at full price, its amount
 * allocated to the line it came from), and GST. shop.staffExtra adds cents to each staff discount (Shopify going wrong).
 */
function figuresFor(lines) {
  const out = lines.map((l) => {
    if (l.variantId) {
      const v = VARIANTS[l.variantId];
      const unit = l.cents ?? v.price;
      const total = unit * l.qty;
      const staff = l.discount ? Math.round((total * l.discount) / 100) + (shop?.staffExtra || 0) : null;
      return { uuid: l.uuid, title: PRODUCTS[v.product].title, variantTitle: v.title === 'Default Title' ? '' : v.title, variantId: l.variantId, qty: l.qty, unit, total, paid: total - (staff || 0), custom: false, attributes: l.attributes || {}, ...(staff != null ? { staff } : {}), dice: PRODUCTS[v.product].dice && l.cents == null };
    }
    return { uuid: l.uuid, title: l.title, variantTitle: '', variantId: null, qty: 1, unit: l.cents, total: l.cents, paid: l.cents, custom: true, attributes: l.attributes || {}, dice: false };
  });
  const units = [];
  out.forEach((l, i) => {
    if (l.dice) for (let n = 0; n < l.qty; n += 1) units.push({ unit: l.unit, line: i });
  });
  units.sort((a, b) => b.unit - a.unit);
  let deal = 0;
  for (let i = 2; i < units.length; i += 3) {
    deal += units[i].unit;
    out[units[i].line].paid -= units[i].unit;
  }
  const subtotal = out.reduce((sum, l) => sum + l.total, 0);
  const staffTotal = out.reduce((sum, l) => sum + (l.staff || 0), 0);
  const total = subtotal - deal - staffTotal;
  return {
    subtotal, discounts: deal ? [{ title: 'Buy any 2 dice, get the 3rd free', amount: deal }] : [], total, gst: Math.round((total * 3) / 23), taxIncluded: true,
    lines: out.map(({ dice, ...l }) => l),
  };
}

let lair;
let shop;
function fakeShopify() {
  shop = { asked: [], drafts: [], deleted: [], completed: [], fulfilled: [], calculated: [], down: false, completeFails: 0, loseComplete: false, fulfilDenied: false, orderTotal: null };
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.tillVariants = async (code) => {
    shop.asked.push(code);
    if (shop.down) throw new Error('Shopify is down');
    // (Shopify's search ignores case, and finds a barcode in its other forms)
    return Object.keys(VARIANTS)
      .filter((id) => VARIANTS[id].barcodes.some((b) => b.replace(/^0+/, '') === code.replace(/^0+/, '')) || String(VARIANTS[id].sku || '').toLowerCase() === code.toLowerCase())
      .map(match);
  };
  lair.shopify.tillSearch = async (words) => {
    if (shop.down) throw new Error('Shopify is down');
    return Object.keys(PRODUCTS)
      .filter((key) => words.every((w) => PRODUCTS[key].title.toLowerCase().includes(w.toLowerCase())))
      .map((key) => ({ ...PRODUCTS[key], variants: Object.values(VARIANTS).filter((v) => v.product === key).map((v) => ({ ...v })) }));
  };
  lair.shopify.tillCalculate = async ({ lines }) => {
    if (shop.down) throw new Error('Shopify is down');
    shop.calculated.push(lines);
    return figuresFor(lines);
  };
  lair.shopify.createTillDraft = async (input) => {
    if (shop.down) throw new Error('Shopify is down');
    const draft = { id: `gid://shopify/DraftOrder/${900 + shop.drafts.length}`, input, figures: figuresFor(input.lines), order: null };
    shop.drafts.push(draft);
    return { id: draft.id, ready: true, ...draft.figures };
  };
  lair.shopify.tillDraft = async (id) => {
    const d = shop.drafts.find((x) => x.id === id && !shop.deleted.includes(id));
    return d ? { id, status: d.order ? 'COMPLETED' : 'OPEN', ready: true, order: d.order, ...d.figures } : null;
  };
  lair.shopify.completePaidDraft = async (id) => {
    const d = shop.drafts.find((x) => x.id === id && !shop.deleted.includes(id));
    if (shop.completeFails > 0) {
      shop.completeFails -= 1;
      throw new Error('Shopify is down');
    }
    if (!d) return { order: null, status: null, errors: ['Draft order not found'] };
    if (d.order) return { order: null, status: 'COMPLETED', errors: ['This draft order has already been completed'] };
    d.order = { id: `gid://shopify/Order/${8000 + shop.completed.length}`, name: `#${3000 + shop.completed.length}`, total: shop.orderTotal ?? d.figures.total };
    shop.completed.push(id);
    if (shop.loseComplete) throw new Error('No answer from Shopify');
    return { order: d.order, status: 'COMPLETED', errors: [] };
  };
  lair.shopify.draftOrderState = async (id) => {
    const d = shop.drafts.find((x) => x.id === id && !shop.deleted.includes(id));
    return d ? { id, status: d.order ? 'COMPLETED' : 'OPEN', ready: true, order: d.order } : null;
  };
  lair.shopify.deleteDraftIfOpen = async (id) => {
    const d = shop.drafts.find((x) => x.id === id);
    if (!d || d.order) return false;
    shop.deleted.push(id);
    return true;
  };
  lair.shopify.fulfilTillOrder = async (orderId, location) => {
    if (shop.fulfilDenied) throw new Error('Shopify API: Access denied for fulfillmentOrders field. Required access: `read_merchant_managed_fulfillment_orders` access scope.');
    shop.fulfilled.push({ orderId, location });
    return { fulfilled: 1, moved: 0 };
  };
}

async function call(method, path, body, customer = '', client = '203.0.113.7') {
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, 'X-Lair-Client': client },
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, data: await response.json() };
}
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const said = (res, status, words) => {
  assert.equal(res.status, status, res.data.error);
  if (words) assert.equal(res.data.error, words);
};
const internal = (path, body) => lair.fetch(new Request(`https://lair.test/internal/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body: JSON.stringify(body),
})).then(async (r) => ({ status: r.status, data: await r.json() }));
// someone on the till with their own PIN (the counter tablet is logged in as the owner's account)
const onTill = async (id, pin = '2580', as = OWNER) => {
  const u = ok(await call('POST', 'till/unlock', { id, pin: '1234' }, as));
  ok(await call('POST', 'till/pin', { token: u.token, pin }, as));
  return u.token;
};
const TILL = 'counter-tablet-1';
const pay = (body, as = OWNER) => call('POST', 'till/pay', { till: TILL, ...body }, as);
const paid = (body, as = OWNER) => call('POST', 'till/paid', body, as);
const saleRow = (id) => lair.sql.exec('SELECT * FROM till_sales WHERE id = ?', id).one();
const bookingRow = (id) => lair.sql.exec('SELECT * FROM bookings WHERE id = ?', id).one();

/** A till order as Shopify's orders/paid webhook sends it: the Lair app's source, its tags, and lines with their properties */
const webhookOrder = (n, lineItems, extra = {}) => ({
  id: n, admin_graphql_api_id: `gid://shopify/Order/${n}`, name: `#${n}`, source_name: LAIR_APP, tags: 'card, lair-till, till', line_items: lineItems, ...extra,
});
const customLine = (id, title, cents, properties) => ({ id, title, quantity: 1, price: (cents / 100).toFixed(2), product_id: null, variant_id: null, sku: null, properties: Object.entries(properties).map(([name, value]) => ({ name, value })) });

beforeEach(async () => {
  background = [];
  globalThis.fetch = async (url) => {
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'dice-goblin.myshopify.com' });
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.searchCustomers = async () => [{ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }];
  lair.shopify.storeCreditBalance = async () => 0;
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  fakeShopify();
  lair.alerts = [];
  lair.notifyStaff = (subject) => lair.alerts.push(subject);
  lair.mail = async () => ({ ok: true });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  for (const [id, name, perms] of [[HEMI, 'Hemi Walker', ['checkin']], [TAMA, 'Tama Rewi', ['library']], [RUA, 'Rua Parata', ['checkin', 'money']]]) {
    ok(await call('POST', 'team', { customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, perms }, OWNER));
  }
  for (const [id, name] of [[MIA, 'Mia Tamaki'], [KAI, 'Kai Tane']]) {
    lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
  }
});

afterEach(() => {
  Date.now = realNow;
});

/** Mia's table for 2 at 6pm tonight, paid at the counter → the booking */
async function miasTable() {
  return ok(await call('POST', 'bookings', { kind: 'table', tables: ['T1'], start: at(DAY, 18), end: at(DAY, 20), people: 2, name: 'Mia', email: 'mia@example.com', phone: '021 555 0100', pay: 'day' }, MIA)).booking;
}

const BOOSTER = '5013'; // Riftbound Radiance booster, $11, not dice
const OAKIE = '5011'; // a dice set, $15.99, in the dice deal
/** A fresh PIN from Rua (Money), as the till's approval asks for one: unlocking gives the token that approves */
const approve = async (id = RUA, pin = '4711') => ok(await call('POST', 'till/unlock', { id, pin }, OWNER)).token;

/* ---------------- the percent ---------------- */
test('round 34: a discount is a percent off, more than 0 and up to 20 (round 35: was 25), to 2 decimal places', () => {
  assert.equal(tillDiscountIn(20), 20);
  assert.equal(tillDiscountIn('12.5'), 12.5);
  assert.equal(tillDiscountIn(10.05), 10.05);
  for (const none of [null, undefined, '', 0, '0']) assert.equal(tillDiscountIn(none), null);
  for (const bad of [20.01, 25, 26, 100, -5, 'ten', 10.123, Infinity]) assert.throws(() => tillDiscountIn(bad), (e) => e.status === 400 && e.message === D.over);
});

test('round 34: only the shop\'s products take a discount, one discount a product', () => {
  assert.deepEqual(tillBasketIn([{ key: 'a', variantId: BOOSTER, qty: 2, discount: 10 }]).items, [{ key: 'a', variantId: BOOSTER, qty: 2, discount: 10 }]);
  assert.throws(() => tillBasketIn([{ key: 'b', booking: 'MT-OWLBEAR-17', discount: 10 }]), (e) => e.status === 400 && e.message === D.notProduct);
  assert.throws(() => tillBasketIn([{ key: 't', tab: 'tab_1', discount: 10 }]), (e) => e.status === 400 && e.message === D.notProduct);
  // the same product twice is one line: with two different discounts it's a mistake
  assert.throws(() => tillBasketIn([{ variantId: BOOSTER, qty: 1, discount: 10 }, { variantId: BOOSTER, qty: 1 }]), (e) => e.status === 400 && e.message === S.lines);
  assert.equal(tillBasketIn([{ variantId: BOOSTER, qty: 1, discount: 10 }, { variantId: BOOSTER, qty: 1, discount: 10 }]).items[0].qty, 2);
});

/* ---------------- what it comes to ---------------- */
test('round 34: the price shows the discount straight away, and that it needs approving', async () => {
  const { price } = ok(await call('POST', 'till/price', { lines: [{ key: 'b', variantId: BOOSTER, qty: 2, discount: 20 }, { key: 'd', variantId: '5015', qty: 1 }] }, OWNER));
  assert.equal(price.subtotal, 2500);
  assert.deepEqual(price.discounts, [{ title: 'Staff discount', amount: 440 }]);
  assert.equal(price.total, 2060);
  assert.equal(price.needsOk, true);
  assert.equal(price.staffDiscount, 440);
  assert.deepEqual(price.lines[0].discount, { percent: 20, amount: 440 });
  assert.equal(price.lines[1].discount, undefined);
  // with no discount, nothing about approving
  const plain = ok(await call('POST', 'till/price', { lines: [{ key: 'b', variantId: BOOSTER, qty: 1 }] }, OWNER)).price;
  assert.equal(plain.needsOk, undefined);
  // more than 20% (round 35: was 25): refused before Shopify is asked
  const asked = shop.calculated.length;
  said(await call('POST', 'till/price', { lines: [{ key: 'b', variantId: BOOSTER, qty: 1, discount: 30 }] }, OWNER), 400, D.over);
  assert.equal(shop.calculated.length, asked);
});

test('round 34: no discount on top of a deal: a die the dice deal takes off can\'t have one too', async () => {
  const lines = [{ key: 'o', variantId: OAKIE, qty: 3, discount: 10 }];
  said(await call('POST', 'till/price', { lines }, OWNER), 422, D.stacked('Oakie Doakie Translucent RPG Dice Set · Green'));
  // two dice (no free one): the discount is fine
  assert.equal(ok(await call('POST', 'till/price', { lines: [{ key: 'o', variantId: OAKIE, qty: 2, discount: 10 }] }, OWNER)).price.staffDiscount, 320);
});

test('round 34: what Shopify actually took off is checked: more than 20% of an item (round 35: was 25) is refused, and nothing is sold', async () => {
  shop.staffExtra = 200;
  said(await call('POST', 'till/price', { lines: [{ key: 'b', variantId: BOOSTER, qty: 1, discount: 20 }] }, OWNER), 422, D.most('Riftbound Radiance · Booster Pack', 220));
  await onTill(RUA, '4711');
  const token = await approve();
  said(await pay({ lines: [{ key: 'b', variantId: BOOSTER, qty: 1, discount: 20 }], method: 'card', discountOk: token }), 422, D.most('Riftbound Radiance · Booster Pack', 220));
  await settle();
  // its draft was deleted and the sale let go: nothing to confirm
  assert.equal(shop.deleted.length, 1);
  assert.equal(lair.sql.exec("SELECT status, ended_why FROM till_sales").one().ended_why, 'discount');
});

/* ---------------- approving ---------------- */
test('round 34: Pay takes a discount only with a PIN from someone with Money, or the owner', async () => {
  const lines = [{ key: 'b', variantId: BOOSTER, qty: 2, discount: 20 }];
  const hemi = await onTill(HEMI, '1357');
  await onTill(RUA, '4711');
  // no approval at all, even with someone on the till: nothing is made
  said(await pay({ lines, method: 'card', token: hemi }), 403, D.needOk);
  // Hemi (Check-in only) can't approve
  said(await pay({ lines, method: 'card', token: hemi, discountOk: await approve(HEMI, '1357') }), 403, D.notMoney('Hemi'));
  // a token that isn't one
  said(await pay({ lines, method: 'card', token: hemi, discountOk: 'nope' }), 403, D.needOk);
  assert.equal(shop.drafts.length, 0);
  // Rua puts her PIN in: it goes through, Hemi still ringing it up
  const sale = ok(await pay({ lines, method: 'card', token: hemi, discountOk: await approve() })).sale;
  assert.equal(sale.total, 1760);
  assert.deepEqual(sale.staffDiscount, { amount: 440, by: 'Rua' });
  assert.deepEqual(sale.discounts, [{ title: 'Staff discount', amount: 440 }]);
  // in Shopify: the line's staff discount says who approved it, the order is tagged and its note says so
  const draft = shop.drafts.at(-1).input;
  assert.equal(draft.lines[0].discount, 20);
  assert.equal(draft.lines[0].discountNote, 'Approved by Rua on the till');
  assert.ok(draft.tags.includes('staff-discount'));
  assert.match(draft.note, /rung up by Hemi .*Staff discount approved by Rua\./);
  const done = ok(await paid({ sale: sale.id, token: hemi, expect: 1760 })).sale;
  assert.equal(done.status, 'paid');
  const row = saleRow(sale.id);
  assert.equal(row.discount_by, RUA);
  assert.equal(row.discount_total, 440);
});

test('round 34: the owner approves too, and a customer paying at the counter can have an approved discount', async () => {
  await onTill(OWNER, '2580');
  const mo = await approve(OWNER, '2580');
  const sale = ok(await pay({ lines: [{ key: 'b', variantId: BOOSTER, qty: 1, discount: 10 }], method: 'card', discountOk: mo })).sale;
  assert.deepEqual(sale.staffDiscount, { amount: 110, by: 'Mo' });
  assert.equal(sale.total, 990);
});

test('round 34: an approval is a PIN put in the last 10 minutes, for one sale', async () => {
  await onTill(RUA, '4711');
  const lines = [{ key: 'b', variantId: BOOSTER, qty: 1, discount: 15 }];
  const token = await approve();
  nowIs(NOW + TILL_DISCOUNT_FRESH_MS + MIN);
  said(await pay({ lines, method: 'card', discountOk: token }), 401, D.stale);
  // a fresh one works; Back lets the sale go, and the same approval works again on that till
  const fresh = await approve();
  const first = ok(await pay({ lines, method: 'card', discountOk: fresh })).sale;
  ok(await call('POST', 'till/pay/cancel', { sale: first.id }, OWNER));
  const again = ok(await pay({ lines, method: 'card', discountOk: fresh })).sale;
  // but not on another till while this one's open, nor once it's paid
  said(await call('POST', 'till/pay', { till: 'counter-tablet-2', lines, method: 'card', discountOk: fresh }, OWNER), 409, D.used);
  ok(await paid({ sale: again.id, token: fresh, expect: again.total }));
  said(await pay({ lines, method: 'card', discountOk: fresh }), 409, D.used);
});

test('round 34: a sale without discounts needs no approval, as before', async () => {
  const sale = ok(await pay({ lines: [{ key: 'b', variantId: BOOSTER, qty: 1 }], method: 'card' })).sale;
  assert.equal(sale.staffDiscount, null);
  assert.ok(!shop.drafts.at(-1).input.tags.includes('staff-discount'));
});

/* ---------------- Shopify's side ---------------- */
test('round 34: the draft asks Shopify for a percent off the line, and its figures read what it took', () => {
  const input = tillDraftInput({ currency: 'NZD', lines: [{ uuid: 'u1', variantId: BOOSTER, qty: 2, discount: 12.5, discountNote: 'Approved by Rua on the till' }, { uuid: 'u2', variantId: '5015', qty: 1 }] });
  assert.deepEqual(input.lineItems[0].appliedDiscount, { valueType: 'PERCENTAGE', value: 12.5, title: 'Staff discount', description: 'Approved by Rua on the till' });
  assert.equal(input.lineItems[1].appliedDiscount, undefined);
  const money = (a) => ({ shopMoney: { amount: a, currencyCode: 'NZD' } });
  const figures = tillFiguresOf({ taxesIncluded: true, totalPriceSet: money('19.25'), totalTaxSet: money('2.51'), platformDiscounts: [] }, [
    { uuid: 'u1', quantity: 2, title: 'Riftbound Radiance', originalUnitPriceSet: money('11.00'), originalTotalSet: money('22.00'), discountedTotalSet: money('19.25'), appliedDiscount: { amountSet: money('2.75') } },
  ]);
  assert.equal(figures.lines[0].staff, 275);
  assert.equal(figures.lines[0].paid, 1925);
});

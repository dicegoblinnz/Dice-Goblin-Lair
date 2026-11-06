// Round 32, the till, part 3: real products, prices and sales saved to Shopify (contract v32-till, section 6). Mo (6 Nov
// 2026): "Part 3 please": the shop's real products and prices (the dice deal) and stock, and each sale saved to Shopify as a
// paid order with the member and the basket's lines, paying a booking's line marking it paid as at the counter, and
// stamps. The price is fixed (the sale's draft order) before the EFTPOS is charged; staff confirm the money with their own
// PIN; the order, tagged lair-till, then does at the webhook what Shopify POS's own sales did. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { TILL_ORDER_TAG, counterSale, counterSource, tillSale, verifoneSale } from '../src/counter.js';
import { COUNTER_SOURCES } from '../src/newplayers.js';
import { tillDraftInput, tillFiguresOf } from '../src/shopify.js';
import { TILL_PEOPLE_WORDS as P } from '../src/till-people.js';
import { TILL_SALE_WORDS as S, TILL_MARKER, TILL_SHOP_LOCATION, TILL_SALE_OPEN_MS, tillBasketIn, tillPick } from '../src/till-sales.js';
import { TILL_WORDS as W } from '../src/till.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 60 * MIN;
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
};
const match = (id) => ({ product: { ...PRODUCTS[VARIANTS[id].product] }, variant: { ...VARIANTS[id] } });

/** Shopify's figures for a draft's lines, as the fake works them out: the shop's prices, every third dice free, GST */
function figuresFor(lines) {
  const out = lines.map((l) => {
    if (l.variantId) {
      const v = VARIANTS[l.variantId];
      const unit = l.cents ?? v.price;
      return { uuid: l.uuid, title: PRODUCTS[v.product].title, variantTitle: v.title === 'Default Title' ? '' : v.title, variantId: l.variantId, qty: l.qty, unit, total: unit * l.qty, paid: unit * l.qty, custom: false, attributes: l.attributes || {}, dice: PRODUCTS[v.product].dice && l.cents == null };
    }
    return { uuid: l.uuid, title: l.title, variantTitle: '', variantId: null, qty: 1, unit: l.cents, total: l.cents, paid: l.cents, custom: true, attributes: l.attributes || {}, dice: false };
  });
  const units = [];
  out.forEach((l) => {
    if (l.dice) for (let i = 0; i < l.qty; i += 1) units.push(l.unit);
  });
  units.sort((a, b) => b - a);
  let deal = 0;
  for (let i = 2; i < units.length; i += 3) deal += units[i];
  const subtotal = out.reduce((sum, l) => sum + l.total, 0);
  const total = subtotal - deal;
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
  for (const [id, name, perms] of [[HEMI, 'Hemi Walker', ['checkin']], [TAMA, 'Tama Rewi', ['library']]]) {
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

/* ---------------- who can use it ---------------- */
test('round 32 part 3: products, prices and paying need the tablet\'s staff account', async () => {
  for (const as of ['', MIA]) {
    for (const path of ['till/product', 'till/search', 'till/price', 'till/pay', 'till/pay/cancel', 'till/paid']) said(await call('POST', path, {}, as), 403, W.staffOnly);
  }
});

/* ---------------- products ---------------- */
test('round 32 part 3: a barcode is the shop\'s product, with the dice deal and stock; Shopify\'s answers are kept', async () => {
  const found = ok(await call('POST', 'till/product', { code: '4056133701068' }, OWNER));
  assert.deepEqual(found.variant, { id: '5011', title: 'Green', price: 1599, sku: null, available: true, stock: 35 });
  assert.equal(found.product.title, 'Oakie Doakie Translucent RPG Dice Set');
  assert.equal(found.product.dice, true);
  assert.deepEqual(found.product.variants, [found.variant]);
  // a SKU works too, and one Shopify shows none of is still sold (it's in their hand), shown as not available
  const wave = ok(await call('POST', 'till/product', { code: 'dgd-f2-d20-33' }, OWNER));
  assert.equal(wave.variant.available, false);
  assert.equal(wave.variant.stock, 0);
  // the unlisted Session product is found (the storefront's search can't see it)
  assert.equal(ok(await call('POST', 'till/product', { code: '31283123850' }, OWNER)).variant.sku, 'LAIR-SESSION-RPG');
  // asked once each: the same barcode again is the kept answer
  ok(await call('POST', 'till/product', { code: '4056133701068' }, OWNER));
  assert.deepEqual(shop.asked, ['4056133701068', 'dgd-f2-d20-33', '31283123850']);
});

test('round 32 part 3: barcodes the till won\'t sell, ones the shop doesn\'t have, and Shopify down', async () => {
  said(await call('POST', 'till/product', { code: '9999000011' }, OWNER), 422, S.notForSale);
  said(await call('POST', 'till/product', { code: '5555000011' }, OWNER), 422, S.notForSale);
  said(await call('POST', 'till/product', { code: 'DGL34-M011' }, OWNER), 422, S.library);
  lair.sql.exec('INSERT INTO library_codes (key, variant_id) VALUES (?, ?)', 'DGL56L031', '777');
  said(await call('POST', 'till/product', { code: 'DGL56-L031' }, OWNER), 422, S.library);
  said(await call('POST', 'till/product', { code: '0000000000000' }, OWNER), 404, S.noProduct);
  said(await call('POST', 'till/product', { code: 'two words' }, OWNER), 400, S.code);
  shop.down = true;
  said(await call('POST', 'till/product', { code: '810155276195' }, OWNER), 503, S.shopify);
});

test('round 32 part 3: searching the shop by name finds unlisted products, never gift cards or library copies', async () => {
  const { products } = ok(await call('POST', 'till/search', { q: 'session' }, OWNER));
  assert.deepEqual(products.map((p) => p.title), ['Session']);
  assert.equal(products[0].variants[0].price, 1500);
  assert.deepEqual(ok(await call('POST', 'till/search', { q: 'card' }, OWNER)).products, []);
  assert.deepEqual(ok(await call('POST', 'till/search', { q: 'catan' }, OWNER)).products, []);
  assert.deepEqual(ok(await call('POST', 'till/search', { q: 'oakie dice' }, OWNER)).products.map((p) => p.title), ['Oakie Doakie Translucent RPG Dice Set']);
  said(await call('POST', 'till/search', { q: 'a' }, OWNER), 400, S.search);
  said(await call('POST', 'till/search', { q: '!!' }, OWNER), 400, S.search);
});

/* ---------------- prices ---------------- */
test('round 32 part 3: Shopify prices the basket: the dice deal, GST, and bookings at what\'s left to pay', async () => {
  const table = await miasTable();
  const { price, dropped } = ok(await call('POST', 'till/price', {
    person: MIA,
    lines: [{ key: 'v:5011', variantId: '5011', qty: 2 }, { key: 'v:5012', variantId: '5012', qty: 1 }, { key: `b:${table.ref}:0`, booking: table.ref }],
  }, OWNER));
  assert.deepEqual(dropped, []);
  // two Oakie sets ($15.99 each) and a $50 D20: the cheapest of the three free
  assert.deepEqual(price.discounts, [{ title: 'Buy any 2 dice, get the 3rd free', amount: 1599 }]);
  assert.equal(price.subtotal, 1599 * 2 + 5000 + table.amount);
  assert.equal(price.total, price.subtotal - 1599);
  assert.equal(price.gst, Math.round((price.total * 3) / 23));
  assert.deepEqual(price.lines.map((l) => [l.key, l.qty, l.unit, l.total]), [['v:5011', 2, 1599, 3198], ['v:5012', 1, 5000, 5000], [`b:${table.ref}:0`, 1, table.amount, table.amount]]);
  // Shopify was asked about the booking as the counter tile's own line: a custom line at its price, with _booking
  const asked = shop.calculated[0];
  const bookingLine = asked.find((l) => l.attributes?._booking);
  assert.equal(bookingLine.cents, table.amount);
  assert.match(bookingLine.title, new RegExp(`^Table fee: ${table.ref}`));
  assert.equal(asked.every((l) => /^[0-9a-f-]{36}$/.test(l.uuid)), true);
  // nothing was checked in or made
  assert.equal(bookingRow(table.id).status, 'confirmed');
  assert.equal(shop.drafts.length, 0);
});

test('round 32 part 3: a price with a booking that has nothing to pay leaves it out', async () => {
  const table = await miasTable();
  lair.sql.exec("UPDATE bookings SET status = 'cancelled' WHERE id = ?", table.id);
  const { price, dropped } = ok(await call('POST', 'till/price', { person: MIA, lines: [{ booking: table.ref }, { variantId: '5013', qty: 1 }] }, OWNER));
  assert.deepEqual(dropped, [table.ref]);
  assert.equal(price.total, 1100);
  // an empty basket, and a basket with something odd in it
  said(await call('POST', 'till/price', { lines: [] }, OWNER), 400, S.empty);
  said(await call('POST', 'till/price', { lines: [{ variantId: 'abc', qty: 1 }] }, OWNER), 400, S.lines);
  said(await call('POST', 'till/price', { lines: [{ variantId: '5013', qty: 0 }] }, OWNER), 400, S.lines);
  said(await call('POST', 'till/price', { lines: [{ variantId: '5013', qty: 1 }], person: '424242' }, OWNER), 404, P.noMember);
});

/* ---------------- paying by card ---------------- */
test('round 32 part 3: a card sale: the price is fixed before the EFTPOS, staff confirm with their PIN, and it becomes a paid order', async () => {
  const table = await miasTable();
  // Mia scans her code and taps Pay by card on the customer screen (nobody on the till)
  const started = ok(await pay({ method: 'card', person: MIA, lines: [{ key: 'v:5011', variantId: '5011', qty: 1 }, { key: `b:${table.ref}:0`, booking: table.ref }] }));
  const { sale } = started;
  assert.equal(sale.status, 'open');
  assert.equal(sale.method, 'card');
  assert.equal(sale.total, 1599 + table.amount);
  assert.deepEqual(sale.person, { id: MIA, first: 'Mia' });
  assert.equal(sale.order, null);
  // she's checked in (paying at the counter means she's here), as the counter tile did when it scanned her
  assert.equal(bookingRow(table.id).status, 'seated');
  // its draft order: Mia's, the dice and the booking (its code in _booking), tagged, noted, with the sale's marker
  const draft = shop.drafts[0];
  assert.equal(draft.input.customerId, MIA);
  assert.deepEqual(draft.input.tags, [TILL_ORDER_TAG, 'till', 'card']);
  assert.equal(draft.input.marker[TILL_MARKER], sale.id);
  assert.match(draft.input.note, /^Sold on the Lair till, by card on the EFTPOS \(ts/);
  assert.doesNotMatch(draft.input.note, new RegExp(table.ref));
  assert.deepEqual(draft.input.lines.map((l) => (l.variantId ? `${l.variantId}×${l.qty}` : `${l.attributes._booking} ${l.cents}`)), ['5011×1', `${table.ref} ${table.amount}`]);
  // Hemi comes over: no PIN, a wrong amount, then the right one
  said(await paid({ sale: sale.id, expect: sale.total }), 401, W.expired);
  const hemi = await onTill(HEMI);
  said(await paid({ sale: sale.id, token: hemi, expect: sale.total - 100 }), 409, S.expect(sale.total));
  const done = ok(await paid({ sale: sale.id, token: hemi, expect: sale.total })).sale;
  assert.equal(done.status, 'paid');
  assert.equal(done.by, 'Hemi');
  assert.deepEqual(done.order, { id: 'gid://shopify/Order/8000', name: '#3000' });
  assert.equal(done.saving, false);
  assert.equal(done.receipt, 'm•••@example.com');
  assert.deepEqual(shop.completed, [draft.id]);
  // fulfilled at the shop, in the background
  await settle();
  assert.deepEqual(shop.fulfilled, [{ orderId: 'gid://shopify/Order/8000', location: TILL_SHOP_LOCATION }]);
  assert.equal(saleRow(sale.id).fulfil_status, 'done');
  // confirming again (a lost answer) gives the same sale, and makes nothing more
  assert.equal(ok(await paid({ sale: sale.id, token: hemi, expect: sale.total })).sale.order.name, '#3000');
  assert.equal(shop.completed.length, 1);
});

test('round 32 part 3: until its order has paid them, a paid sale\'s bookings show as paid at the till, then the webhook pays them as at the counter', async () => {
  const table = await miasTable();
  const { sale } = ok(await pay({ method: 'card', person: MIA, lines: [{ booking: table.ref }] }));
  const hemi = await onTill(HEMI);
  ok(await paid({ sale: sale.id, token: hemi, expect: sale.total }));
  // the booking isn't paid in the Lair yet (the order's webhook does that), but the till won't take it again
  assert.equal(bookingRow(table.id).paid, 0);
  const mia = ok(await call('POST', 'till/scan', { code: lair.memberRow(MIA).code }, OWNER)).person;
  const row = mia.bookings.find((b) => b.code === table.ref);
  assert.equal(row.paid, true);
  assert.equal(row.paying, true);
  assert.deepEqual(row.lines, []);
  said(await pay({ method: 'card', person: MIA, lines: [{ booking: table.ref }] }), 409, S.nothingDue(table.ref));
  // Shopify's orders/paid webhook for it: a counter sale, so its _booking line pays the booking and the spend counts
  lair.shopify.orderSpend = async () => ({ customerId: MIA, amount: sale.total, name: '#3000', source: LAIR_APP, processedAt: NOW });
  const order = webhookOrder(8000, [customLine(80001, `Table fee: ${table.ref} (T1, 2 people)`, sale.total, { _booking: table.ref })], { customer: { id: Number(MIA) } });
  const result = ok(await internal('orders-paid', order));
  assert.equal(result.updated.length, 1);
  assert.equal(bookingRow(table.id).paid, 1);
  assert.equal(lair.sql.exec('SELECT source FROM spend WHERE order_id = ?', 'gid://shopify/Order/8000').one().source, 'lair-till');
  // and it's no longer waiting: paid in the Lair now
  const after = ok(await call('POST', 'till/scan', { code: lair.memberRow(MIA).code }, OWNER)).person.bookings.find((b) => b.code === table.ref);
  assert.equal(after.paid, true);
  assert.equal(after.paying, undefined);
});

test('round 32 part 3: a till order is a counter sale that keeps its lines\' properties; anything else tagged lair-till isn\'t', () => {
  const till = { source_name: LAIR_APP, tags: 'card, lair-till, till' };
  assert.equal(tillSale(till), true);
  assert.equal(counterSale(till), true);
  assert.equal(verifoneSale(till), false);
  assert.equal(counterSource(till), 'lair-till');
  assert.ok(COUNTER_SOURCES.includes('lair-till'));
  // the Admin API gives tags as a list
  assert.equal(tillSale({ source_name: LAIR_APP, tags: ['lair-till'] }), true);
  // a web order, a draft's checkout and Shopify POS's own, even tagged lair-till by hand in admin, aren't the till's
  for (const source of ['web', 'shopify_draft_order', '']) assert.equal(tillSale({ source_name: source, tags: 'lair-till' }), false);
  assert.equal(counterSale({ source_name: 'web', tags: 'lair-till' }), false);
  assert.equal(tillSale({ source_name: 'pos', tags: 'lair-till' }), false);
  assert.equal(counterSource({ source_name: 'pos', tags: 'lair-till' }), 'pos');
  // an app's order without the tag isn't
  assert.equal(counterSale({ source_name: LAIR_APP, tags: 'cash, lair-cash' }), false);
});

test('round 32 part 3: a Session sold on the till stamps the member on the sale, as at the counter', async () => {
  lair.shopify.orderSpend = async () => ({ customerId: KAI, amount: 1500, name: '#3001', source: LAIR_APP, processedAt: NOW });
  const before = lair.stampCount(KAI);
  const order = webhookOrder(8001, [{ id: 80011, title: 'Session', variant_title: 'RPG Session', sku: 'LAIR-SESSION-RPG', quantity: 1, price: '15.00', product_id: 104, variant_id: 5014, properties: [] }], { customer: { id: Number(KAI) } });
  ok(await internal('orders-paid', order));
  assert.equal(lair.stampCount(KAI), before + 1);
});

/* ---------------- cash ---------------- */
test('round 32 part 3: cash needs the owner, Check-in or Money, and what was handed over; the change is worked out', async () => {
  const { sale } = ok(await pay({ method: 'cash', lines: [{ variantId: '5013', qty: 2 }] }));
  assert.equal(sale.total, 2200);
  assert.equal(sale.person, null);
  assert.deepEqual(shop.drafts[0].input.tags, [TILL_ORDER_TAG, 'till', 'cash']);
  assert.equal(shop.drafts[0].input.customerId, null);
  // Tama (sales only) can't take cash
  const tama = await onTill(TAMA);
  said(await paid({ sale: sale.id, token: tama, expect: 2200, handed: 5000 }), 403, S.cash);
  const hemi = await onTill(HEMI);
  said(await paid({ sale: sale.id, token: hemi, expect: 2200 }), 400, S.handed(2200));
  said(await paid({ sale: sale.id, token: hemi, expect: 2200, handed: 2000 }), 400, S.handed(2200));
  said(await paid({ sale: sale.id, token: hemi, expect: 2200, handed: 2200 + 100_001 }), 400, S.handed(2200));
  const done = ok(await paid({ sale: sale.id, token: hemi, expect: 2200, handed: 5000 })).sale;
  assert.equal(done.handed, 5000);
  assert.equal(done.change, 2800);
  assert.equal(done.receipt, null);
  // a card sale, though, anyone on the till can confirm (they keyed it in themselves)
  const card = ok(await pay({ method: 'card', lines: [{ variantId: '5013', qty: 1 }] })).sale;
  assert.equal(ok(await paid({ sale: card.id, token: tama, expect: 1100 })).sale.status, 'paid');
});

test('round 32 part 3: someone still on 1234 can\'t confirm a sale', async () => {
  const { sale } = ok(await pay({ method: 'card', lines: [{ variantId: '5013', qty: 1 }] }));
  const fresh = ok(await call('POST', 'till/unlock', { id: HEMI, pin: '1234' }, OWNER));
  said(await paid({ sale: sale.id, token: fresh.token, expect: 1100 }), 403, W.chooseFirst);
});

/* ---------------- one sale at a time, going back, and letting go ---------------- */
test('round 32 part 3: one sale waits for its money on each till: a new one lets the last go, and Back lets it go', async () => {
  const first = ok(await pay({ method: 'card', lines: [{ variantId: '5013', qty: 1 }] })).sale;
  const second = ok(await pay({ method: 'cash', lines: [{ variantId: '5013', qty: 2 }] })).sale;
  await settle();
  assert.equal(saleRow(first.id).status, 'gone');
  assert.deepEqual(shop.deleted, [shop.drafts[0].id]);
  const hemi = await onTill(HEMI);
  said(await paid({ sale: first.id, token: hemi, expect: 1100 }), 409, S.gone);
  // another till's sale is its own
  const other = ok(await call('POST', 'till/pay', { till: 'counter-tablet-2', method: 'card', lines: [{ variantId: '5013', qty: 1 }] }, OWNER)).sale;
  assert.equal(saleRow(second.id).status, 'open');
  // Back from paying
  assert.deepEqual(ok(await call('POST', 'till/pay/cancel', { sale: second.id }, OWNER)), { sale: null });
  await settle();
  assert.equal(saleRow(second.id).status, 'gone');
  assert.ok(shop.deleted.includes(shop.drafts[1].id));
  // a paid one can't be let go
  ok(await paid({ sale: other.id, token: hemi, expect: 1100 }));
  said(await call('POST', 'till/pay/cancel', { sale: other.id }, OWNER), 409, S.paid);
  said(await paid({ sale: 'ts_nothing', token: hemi, expect: 1 }), 404, S.noSale);
});

test('round 32 part 3: a sale left waiting for its money is let go after 30 minutes', async () => {
  const { sale } = ok(await pay({ method: 'card', lines: [{ variantId: '5013', qty: 1 }] }));
  nowIs(NOW + TILL_SALE_OPEN_MS - MIN);
  await lair.tillSalesUpkeep(Date.now());
  assert.equal(saleRow(sale.id).status, 'open');
  nowIs(NOW + TILL_SALE_OPEN_MS + MIN);
  const run = await lair.tillSalesUpkeep(Date.now());
  assert.equal(run.letGo, 1);
  await settle();
  assert.equal(saleRow(sale.id).status, 'gone');
  assert.deepEqual(shop.deleted, [shop.drafts[0].id]);
});

/* ---------------- passes and tabs ---------------- */
test('round 32 part 3: a saved pass covers the table at check-in, so the sale is only what\'s left', async () => {
  const table = await miasTable();
  const pass = ok(await call('POST', 'passes', { customerId: MIA, sessions: 5, label: '5 sessions' }, OWNER)).pass;
  // (she saved it on the booking in My Lair)
  lair.sql.exec('UPDATE bookings SET pass_id = ? WHERE id = ?', pass.id, table.id);
  const res = ok(await pay({ method: 'card', person: MIA, lines: [{ booking: table.ref }] }));
  // the pass paid it all: nothing to take, and no draft
  assert.equal(res.sale, null);
  assert.deepEqual(res.covered, [table.ref]);
  assert.equal(shop.drafts.length, 0);
  assert.equal(bookingRow(table.id).status, 'seated');
});

test('round 32 part 3: their tab from My Lair is paid with its things at the tab\'s prices, and can\'t change while they pay', async () => {
  const tab = ok(await call('POST', 'tab', { items: [{ variantId: '5015', title: 'Drinks', variantTitle: '$3 Drink', price: 300, qty: 2 }] }, MIA)).tab;
  const { sale } = ok(await pay({ method: 'card', person: MIA, lines: [{ key: `t:${tab.id}:0`, tab: tab.id }] }));
  assert.equal(sale.total, 600);
  const line = shop.drafts[0].input.lines[0];
  assert.deepEqual([line.variantId, line.qty, line.cents, line.attributes], ['5015', 2, 300, { _tab: tab.id }]);
  assert.equal(lair.sql.exec('SELECT status FROM tabs WHERE id = ?', tab.id).one().status, 'in-cart');
  said(await call('POST', 'tab', { items: [] }, MIA), 409);
  // going back puts it back, so it can change again
  ok(await call('POST', 'till/pay/cancel', { sale: sale.id }, OWNER));
  assert.equal(lair.sql.exec('SELECT status FROM tabs WHERE id = ?', tab.id).one().status, 'open');
  // a tab that isn't theirs today
  said(await pay({ method: 'card', person: KAI, lines: [{ tab: tab.id }] }), 409, S.tab);
});

/* ---------------- when Shopify is slow or says no ---------------- */
test('round 32 part 3: Shopify down when paying starts: nothing\'s taken, and the till says so', async () => {
  shop.down = true;
  said(await pay({ method: 'card', lines: [{ variantId: '5013', qty: 1 }] }), 503, S.shopify);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM till_sales WHERE status IN ('open', 'making')").one().n, 0);
  shop.down = false;
  lair.shopify.createTillDraft = async () => {
    throw Object.assign(new Error('Variant is not available'), { refused: true });
  };
  said(await pay({ method: 'card', lines: [{ variantId: '5013', qty: 1 }] }), 422, S.refused('Variant is not available'));
});

test('round 32 part 3: Shopify slow once the money is taken: the sale is paid, and its order is made in the background', async () => {
  const table = await miasTable();
  const { sale } = ok(await pay({ method: 'card', person: MIA, lines: [{ booking: table.ref }] }));
  const hemi = await onTill(HEMI);
  shop.completeFails = 1;
  const done = ok(await paid({ sale: sale.id, token: hemi, expect: sale.total })).sale;
  assert.equal(done.status, 'paid');
  assert.equal(done.saving, true);
  assert.equal(done.order, null);
  assert.equal(saleRow(sale.id).order_status, 'failed');
  // the till won't take it again meanwhile
  said(await pay({ method: 'card', person: MIA, lines: [{ booking: table.ref }] }), 409, S.nothingDue(table.ref));
  // 10 minutes on, the run makes it
  nowIs(NOW + 11 * MIN);
  await lair.tillSalesUpkeep(Date.now());
  await settle();
  const row = saleRow(sale.id);
  assert.equal(row.order_status, 'made');
  assert.equal(row.order_name, '#3000');
  assert.equal(row.fulfil_status, 'done');
});

test('round 32 part 3: an answer lost while the order was made isn\'t made twice', async () => {
  const { sale } = ok(await pay({ method: 'card', lines: [{ variantId: '5013', qty: 1 }] }));
  const hemi = await onTill(HEMI);
  shop.loseComplete = true;
  assert.equal(ok(await paid({ sale: sale.id, token: hemi, expect: 1100 })).sale.saving, true);
  shop.loseComplete = false;
  nowIs(NOW + 11 * MIN);
  await lair.tillSalesUpkeep(Date.now());
  assert.equal(saleRow(sale.id).order_status, 'made');
  assert.equal(shop.completed.length, 1);
});

test('round 32 part 3: a paid sale whose draft was deleted in Shopify stops, and staff hear', async () => {
  const { sale } = ok(await pay({ method: 'card', lines: [{ variantId: '5013', qty: 1 }] }));
  const hemi = await onTill(HEMI);
  shop.deleted.push(shop.drafts[0].id);
  const done = ok(await paid({ sale: sale.id, token: hemi, expect: 1100 })).sale;
  assert.equal(done.status, 'paid');
  assert.equal(saleRow(sale.id).order_status, 'stopped');
  assert.deepEqual(lair.alerts, ['A till sale with no Shopify order: A quick sale']);
});

test('round 32 part 3: an order that comes to a different total than was taken: staff hear', async () => {
  const { sale } = ok(await pay({ method: 'card', lines: [{ variantId: '5013', qty: 1 }] }));
  const hemi = await onTill(HEMI);
  shop.orderTotal = 1000;
  ok(await paid({ sale: sale.id, token: hemi, expect: 1100 }));
  assert.deepEqual(lair.alerts, ["A till sale that doesn't match: A quick sale"]);
});

test('round 32 part 3: fulfilling waits for the new Shopify permissions, then goes', async () => {
  const { sale } = ok(await pay({ method: 'card', lines: [{ variantId: '5013', qty: 1 }] }));
  const hemi = await onTill(HEMI);
  shop.fulfilDenied = true;
  ok(await paid({ sale: sale.id, token: hemi, expect: 1100 }));
  await settle();
  let row = saleRow(sale.id);
  assert.equal(row.fulfil_status, 'failed');
  assert.equal(row.fulfil_next_at, NOW + 6 * HOUR);
  // Mo approves them; the next run after the wait fulfils it
  shop.fulfilDenied = false;
  nowIs(NOW + 6 * HOUR + MIN);
  await lair.tillSalesUpkeep(Date.now());
  row = saleRow(sale.id);
  assert.equal(row.fulfil_status, 'done');
  assert.equal(shop.fulfilled.length, 1);
});

/* ---------------- the pieces ---------------- */
test('round 32 part 3: the basket\'s lines are checked, and the same product twice is one line', () => {
  const basket = tillBasketIn([
    { key: 'v:5011', variantId: '5011', qty: 1 }, { key: 'v:5011b', variantId: 'gid://shopify/ProductVariant/5011', qty: 2 }, { key: 'b', booking: ' mt-owlbear-17 ' },
    { key: 'b2', booking: 'MT-OWLBEAR-17' }, { key: 't', tab: 'tb_abc' }, { key: 't2', tab: 'tb_abc' },
  ]);
  assert.deepEqual(basket.items, [{ key: 'v:5011', variantId: '5011', qty: 3 }]);
  assert.deepEqual(basket.codes, [{ key: 'b', code: 'MT-OWLBEAR-17' }]);
  assert.deepEqual(basket.tabs, ['tb_abc']);
  assert.throws(() => tillBasketIn(Array.from({ length: 61 }, () => ({ variantId: '1', qty: 1 }))), { message: S.tooMany });
  assert.throws(() => tillBasketIn([{ variantId: '1', qty: 60 }, { variantId: '1', qty: 60 }]), { message: S.lines });
  assert.throws(() => tillBasketIn([{ title: 'Free stuff', price: 0 }]), { message: S.lines });
});

test('round 32 part 3: a barcode picks the variant whose barcode it is before one whose SKU it is, and one for sale first', () => {
  const byBarcode = match('5011');
  const bySku = { product: { ...PRODUCTS.booster }, variant: { ...VARIANTS[5013], sku: '4056133701068', barcodes: [] } };
  assert.equal(tillPick([bySku, byBarcode], '4056133701068'), byBarcode);
  assert.equal(tillPick([bySku], '4056133701068'), bySku);
  // a UPC read with its leading 0
  assert.equal(tillPick([byBarcode], '04056133701068'), byBarcode);
  const archived = { product: { ...PRODUCTS.old }, variant: { ...VARIANTS[5011] } };
  assert.equal(tillPick([archived, byBarcode], '4056133701068'), byBarcode);
  assert.equal(tillPick([], 'x'), null);
});

test('round 32 part 3: the draft order Shopify is asked for: automatic discounts on, a $0 collection line for products, uuids and properties', () => {
  const input = tillDraftInput({
    currency: 'NZD',
    lines: [
      { uuid: 'u1', variantId: '5011', qty: 2 },
      { uuid: 'u2', variantId: '5015', qty: 1, cents: 300, attributes: { _tab: 'tb_1' } },
      { uuid: 'u3', title: 'Table fee: MT-OWLBEAR-17 (T1, 2 people)', cents: 2000, attributes: { _booking: 'MT-OWLBEAR-17', _share: '' } },
    ],
  });
  assert.equal(input.acceptAutomaticDiscounts, true);
  assert.deepEqual(input.shippingLine, { title: 'Collected at the Lair', priceWithCurrency: { amount: '0.00', currencyCode: 'NZD' } });
  assert.deepEqual(input.lineItems[0], { uuid: 'u1', variantId: 'gid://shopify/ProductVariant/5011', quantity: 2 });
  assert.deepEqual(input.lineItems[1], { uuid: 'u2', variantId: 'gid://shopify/ProductVariant/5015', quantity: 1, priceOverride: { amount: '3.00', currencyCode: 'NZD' }, customAttributes: [{ key: '_tab', value: 'tb_1' }] });
  assert.deepEqual(input.lineItems[2], {
    uuid: 'u3', title: 'Table fee: MT-OWLBEAR-17 (T1, 2 people)', quantity: 1, originalUnitPriceWithCurrency: { amount: '20.00', currencyCode: 'NZD' }, requiresShipping: false, taxable: true,
    customAttributes: [{ key: '_booking', value: 'MT-OWLBEAR-17' }],
  });
  // only bookings: no shipping line
  assert.equal(tillDraftInput({ currency: 'NZD', lines: [{ title: 'x', cents: 100 }] }).shippingLine, undefined);
});

test('round 32 part 3: Shopify\'s figures in cents: the lines before discounts, the deal, the total and GST', () => {
  const money = (amount) => ({ shopMoney: { amount, currencyCode: 'NZD' } });
  const figures = tillFiguresOf(
    {
      taxesIncluded: true, totalPriceSet: money('81.98'), totalTaxSet: money('10.69'),
      platformDiscounts: [{ title: 'Buy any 2 dice, get the 3rd free', totalAmount: { amount: '15.99' } }, { title: 'Nothing', totalAmount: { amount: '0.0' } }],
    },
    [
      { uuid: 'u1', custom: false, quantity: 2, title: 'Oakie Doakie Translucent RPG Dice Set', variantTitle: 'Green', variant: { id: 'gid://shopify/ProductVariant/5011' }, originalUnitPriceSet: money('15.99'), originalTotalSet: money('31.98'), discountedTotalSet: money('15.99'), customAttributes: [] },
      { uuid: 'u2', custom: false, quantity: 1, title: 'Sea Wave Blossom D20 (33 mm)', variantTitle: 'Default Title', variant: { id: 'gid://shopify/ProductVariant/5012' }, originalUnitPriceSet: money('50.0'), originalTotalSet: money('50.0'), discountedTotalSet: money('50.0'), customAttributes: [] },
    ],
  );
  assert.equal(figures.subtotal, 8198);
  assert.equal(figures.total, 8198 - 1599 + 1599);
  assert.deepEqual(figures.discounts, [{ title: 'Buy any 2 dice, get the 3rd free', amount: 1599 }]);
  assert.equal(figures.gst, 1069);
  assert.deepEqual(figures.lines.map((l) => [l.uuid, l.variantId, l.qty, l.unit, l.total, l.paid, l.variantTitle]), [['u1', '5011', 2, 1599, 3198, 1599, 'Green'], ['u2', '5012', 1, 5000, 5000, 5000, '']]);
});

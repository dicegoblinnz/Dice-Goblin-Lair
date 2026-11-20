// Round 39: Stock off (contract v39-stock-off). Mo, 15 Nov 2026: "gives me the use of my camera and scan my items to
// then click a button to decrease the quantity of that item by the amount scanned [...] instead of doing stock take
// after i come back i instead scan each item and click a button to take the stock off from the website [...] it would be
// cool to add a button to say that item is not sold so it doesnt count as a sold itme and just taken off stock for what
// ever reason like damage maybe gift etc." His picks: "Stock off only" (no prices, no order), "Leave dice out", "Any
// staff, I get a list". Each check is named in the contract's own words (docs/contracts/lair-api-contract-v39-stock-off.md).
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { ShopifyAdmin } from '../src/shopify.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS, sameBarcode } from '../src/core.js';
import { STOCK_OFF_WORDS as W, STOCK_OFF_REASONS, STOCK_OFF_LOCATION, stockOffTake, stockOffRefusal } from '../src/stock-off.js';

const time = new LairTime('Pacific/Auckland');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Saturday 21 November 2026, 2pm in Auckland: a convention day
const SAT = '2026-11-21';
const SUN = '2026-11-22';
const NOW = at(SAT, 14);
const realNow = Date.now;
const realFetch = globalThis.fetch;
let clock;
const nowIs = (ms) => {
  clock = ms;
};

function fakeCtx(pending) {
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
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: (p) => pending.push(p) };
}

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];
const ENV = { CURRENCY: 'NZD', RESEND_API_KEY: 'test-key', FROM_EMAIL: 'gobgob@example.com', STAFF_EMAIL: 'team@example.com', SHOP: 'ep0qiq-rp.myshopify.com' };
const LOCATION = 'gid://shopify/Location/72250359911'; // the shop, "Dice Goblin"
const HOARD = 'gid://shopify/Location/94444617831'; // the dice maker's, "Dice Hoard"
const DICE_DEAL = 'gid://shopify/Collection/491973738599';
const OWNER = '9001'; // Mo, tagged staff
const HELPER = '9002'; // Caleb, a helper with Check-in only
const BARE = '9003'; // Felix, a helper with nothing ticked
const MEMBER = '9004'; // a customer

/* ---------------- a pretend Shopify: the shop's things, their counts at each location, and changes to a count ---------------- */
let things; // numeric variant id → the thing
let lookups; // every code Shopify was asked about
let reads; // every read of variants by id
let adjustCalls;
let keys; // Shopify's idempotency keys: key → { ok, params }
let trouble; // what goes wrong next: { adjust: 'lost' | 'down' | 'refused' | [userError codes], lookup: true, read: true }
let between; // something that happens in the shop between the Lair reading a count and changing it
let badReasons; // reasons Shopify turns away
let mails;
let mailResult;
let ownerAsked;
let pending;
let lair;

const itemOf = (id) => `gid://shopify/InventoryItem/${Number(id) + 1000}`;
function thing(id, title, o = {}) {
  const t = {
    id: String(id),
    product: { id: String(o.productId || Number(id) + 5000), title, type: o.type || 'Board Games', vendor: o.vendor || 'KOSMOS', status: o.status || 'ACTIVE', giftCard: o.giftCard === true, dice: o.dice === true },
    option: o.option || 'Default Title', sku: o.sku || null, barcodes: o.barcodes || [], tracked: o.tracked !== false, price: o.price === undefined ? '10.00' : o.price,
    levels: new Map(o.shop === null ? [] : [[LOCATION, o.shop ?? 5]]),
  };
  if (o.hoard != null) t.levels.set(HOARD, o.hoard);
  things.set(t.id, t);
  return t;
}
const matchOf = (t, location) => ({
  product: { ...t.product },
  variant: { id: t.id, title: t.option, sku: t.sku, barcodes: [...t.barcodes], tracked: t.tracked, itemId: itemOf(t.id), stock: t.levels.has(location) ? t.levels.get(location) : null, price: t.price },
});
const count = (t, location = LOCATION) => t.levels.get(location);

const settle = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};
/** A request to the Lair as the Stock off page makes it (each a moment after the last) */
async function call(method, path, body, customer = OWNER) {
  clock += 1;
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(customer ? { 'X-Lair-Customer': customer } : {}) },
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
let n = 0;
/** A lot's key, as the phone makes one for each tap */
const key = () => `so-${String((n += 1)).padStart(32, '0')}`;
const lot = (lines, more = {}) => ({ id: key(), event: 'Armageddon Auckland', outcome: 'sold', lines, ...more });
const off = (body, customer) => call('POST', 'stock/off', body, customer);
const row = (id) => lair.sql.exec('SELECT * FROM stock_offs WHERE id = ?', id).toArray()[0];
/** The Lair's settings (it reads its own again before every request, so a check changes those) */
const settings = (more = {}) => {
  lair.baseEnv = { ...ENV, ...more };
  lair.env = lair.baseEnv;
};

let CATAN;
let WINGSPAN;
let SLEEVES_JET;
let SLEEVES_RED;
let LIBRARY;
let GIFT;
let KEY20;
let NAMED;
let OAKIE;
let CAN;
let ELSEWHERE;

beforeEach(() => {
  clock = NOW;
  Date.now = () => clock;
  globalThis.fetch = async (url) => {
    throw new Error(`No network in tests: ${url}`);
  };
  n = 0;
  pending = [];
  things = new Map();
  lookups = [];
  reads = [];
  adjustCalls = [];
  keys = new Map();
  trouble = {};
  between = null;
  badReasons = new Set();
  mails = [];
  mailResult = { ok: true, attempted: true, status: 200 };
  ownerAsked = 0;
  CATAN = thing(101, 'Catan', { barcodes: ['0029877030712'], shop: 5 });
  WINGSPAN = thing(102, 'Wingspan', { vendor: 'Stonemaier Games', barcodes: ['644216627721'], shop: 2 });
  SLEEVES_JET = thing(103, 'Dragon Shield Matte Sleeves', { option: 'Jet', productId: 7000, vendor: 'Dragon Shield', type: 'Card Accessories', barcodes: ['5706569110024'], sku: 'AT-11002', shop: 4 });
  SLEEVES_RED = thing(104, 'Dragon Shield Matte Sleeves', { option: 'Crimson', productId: 7000, vendor: 'Dragon Shield', type: 'Card Accessories', barcodes: ['5706569110215'], shop: 0 });
  LIBRARY = thing(105, 'Catan (Library)', { barcodes: ['DGL34-M011'], sku: 'DGL34-M011', vendor: 'Dice Goblin NZ', shop: 1 });
  GIFT = thing(106, 'Dice Goblin gift card', { option: '$50', giftCard: true, tracked: false, barcodes: ['31283129999'], type: 'Gift card', vendor: 'Dice Goblin NZ' });
  // Dice Goblin's own dice: the price keys (not counted) and a named set (0 at the shop, 100 at the dice maker's)
  KEY20 = thing(107, 'Dice', { option: '$20 Dice', dice: true, tracked: false, vendor: 'Dice Goblin NZ', type: 'Dice & Accessories', status: 'UNLISTED', barcodes: ['31283123871'], shop: -14 });
  NAMED = thing(108, 'Blossom Sky Dice Set', { dice: true, vendor: 'Dice Goblin NZ', type: 'Dice & Accessories', sku: 'DGD-N42', shop: 0, hoard: 100 });
  // another maker's dice are counted stock
  OAKIE = thing(109, 'Oakie Doakie Gemidice RPG Dice Set', { option: 'Red Sky', dice: true, vendor: 'Oakie Doakie Dice', type: 'Dice & Accessories', barcodes: ['4056133701310'], shop: 36 });
  CAN = thing(110, 'Can of Drink', { tracked: false, type: 'Drinks', vendor: 'Dice Goblin NZ', barcodes: ['31283123821'], shop: 0 });
  ELSEWHERE = thing(111, 'Supplier Sample Box', { barcodes: ['9400000000111'], shop: null, hoard: 3 });

  lair = new Lair(fakeCtx(pending), ENV);
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.customerTags = async (id) => (id === OWNER ? ['staff'] : []);
  lair.shopify.stockOffByCode = async (code, { location, dice }) => {
    lookups.push(code);
    assert.equal(location, LOCATION);
    assert.equal(dice, DICE_DEAL);
    if (trouble.lookup) throw new Error('Shopify is having a moment');
    return [...things.values()].filter((t) => t.barcodes.some((b) => sameBarcode(b, code)) || sameBarcode(t.sku, code)).map((t) => matchOf(t, location));
  };
  lair.shopify.stockOffByIds = async (ids, { location, dice }) => {
    reads.push([...ids]);
    assert.equal(location, LOCATION);
    assert.equal(dice, DICE_DEAL);
    if (trouble.read) {
      trouble.read = null;
      throw new Error('Shopify is having a moment');
    }
    return new Map(ids.filter((id) => things.has(String(id))).map((id) => [String(id), matchOf(things.get(String(id)), location)]));
  };
  // Shopify's inventoryAdjustQuantities: its idempotency key (kept 24 hours), and each change's changeFromQuantity
  lair.shopify.stockOffAdjust = async (changes, locationId, idem, reason, reference) => {
    adjustCalls.push({ key: idem, changes: changes.map((c) => ({ ...c })), reason, reference });
    assert.equal(locationId, LOCATION);
    if (between) {
      const happen = between;
      between = null;
      happen();
    }
    const params = JSON.stringify({ changes, reason });
    const seen = keys.get(idem);
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
      if (!next.includes('IDEMPOTENCY_CONCURRENT_REQUEST')) keys.set(idem, { ok: false, params });
      return { errors: next.map((code) => ({ code, message: code === 'INVALID_LOCATION' ? 'The specified location could not be found.' : 'Try again.' })) };
    }
    if (badReasons.has(reason)) {
      keys.set(idem, { ok: false, params });
      return { errors: [{ code: 'INVALID_REASON', message: 'The specified reason is invalid.' }] };
    }
    const byItem = (itemId) => [...things.values()].find((t) => itemOf(t.id) === itemId);
    if (changes.some((c) => c.from != null && byItem(c.inventoryItemId).levels.get(locationId) !== c.from)) {
      keys.set(idem, { ok: false, params });
      return { errors: [{ code: 'CHANGE_FROM_QUANTITY_STALE', message: 'The changeFromQuantity argument no longer matches the persisted quantity.' }] };
    }
    for (const c of changes) {
      const t = byItem(c.inventoryItemId);
      t.levels.set(locationId, t.levels.get(locationId) + c.delta);
    }
    keys.set(idem, { ok: true, params });
    if (next === 'lost') throw new Error('The network connection was lost.');
    return { ok: true };
  };
  lair.shopify.shopOwnerEmail = async () => {
    ownerAsked += 1;
    return 'mo@example.com';
  };
  lair.mail = async (message) => {
    mails.push(message);
    return mailResult;
  };
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  const member = (id, first, name) => lair.sql.exec('INSERT INTO members (customer_id, name, first_name, email, created_at) VALUES (?, ?, ?, ?, ?)', id, name, first, `${first.toLowerCase()}@example.com`, NOW);
  member(OWNER, 'Mo', 'Mo Ashgrove');
  member(HELPER, 'Caleb', 'Caleb Rangi');
  member(BARE, 'Felix', 'Felix Grange');
  member(MEMBER, 'Ria', 'Ria Tane');
  lair.sql.exec("INSERT INTO staff_helpers (customer_id, perms, status, created_at) VALUES (?, ?, 'active', ?)", HELPER, JSON.stringify(['checkin']), NOW);
  lair.sql.exec("INSERT INTO staff_helpers (customer_id, perms, status, created_at) VALUES (?, ?, 'active', ?)", BARE, JSON.stringify([]), NOW);
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
});

/* ================ 1. The rules, on their own ================ */

test('never below zero: what comes off is how many were scanned or the count, whichever is smaller; a count at or under zero gives nothing', () => {
  assert.deepEqual(stockOffTake(2, 5), { took: 2, short: 0 });
  assert.deepEqual(stockOffTake(5, 5), { took: 5, short: 0 });
  assert.deepEqual(stockOffTake(3, 2), { took: 2, short: 1 });
  assert.deepEqual(stockOffTake(1, 0), { took: 0, short: 1 });
  // a count under zero is a thing ordered in or oversold: nothing comes off it
  assert.deepEqual(stockOffTake(4, -2), { took: 0, short: 4 });
});

test("what can't come off: a library copy, a gift card, Dice Goblin's own dice, anything Shopify doesn't count, anything with no count at the shop", () => {
  const refusal = (t) => stockOffRefusal(matchOf(t, LOCATION));
  assert.equal(refusal(CATAN), null);
  assert.equal(refusal(SLEEVES_RED), null, 'a count of 0 is still a count');
  assert.equal(refusal(LIBRARY), W.library);
  assert.equal(refusal(GIFT), W.giftCard);
  assert.equal(refusal(KEY20), W.ownDice);
  assert.equal(refusal(NAMED), W.ownDice);
  // other makers' dice are counted stock and come off like anything else
  assert.equal(refusal(OAKIE), null);
  assert.equal(refusal(CAN), "Shopify doesn't count Can of Drink, so there's nothing to take off.");
  assert.equal(refusal(ELSEWHERE), 'Supplier Sample Box has no count at the shop in Shopify.');
  // the option is named when there is one
  assert.equal(stockOffRefusal({ ...matchOf(SLEEVES_JET, LOCATION), variant: { ...matchOf(SLEEVES_JET, LOCATION).variant, tracked: false } }), "Shopify doesn't count Dragon Shield Matte Sleeves · Jet, so there's nothing to take off.");
});

test("the shop's own count is the location Dice Goblin, unless STOCK_OFF_LOCATION_ID names another", async () => {
  assert.equal(STOCK_OFF_LOCATION, LOCATION);
  assert.equal(lair.stockOffLocation(), LOCATION);
  settings({ STOCK_OFF_LOCATION_ID: '94444617831' });
  assert.equal(lair.stockOffLocation(), HOARD);
  settings({ STOCK_OFF_LOCATION_ID: 'gid://shopify/Location/5' });
  assert.equal(lair.stockOffLocation(), 'gid://shopify/Location/5');
});

/* ================ 2. Who ================ */

test('who: anyone the staff page lets in, the owner or a helper whatever their permissions; 401 with nobody logged in, 403 for a customer', async () => {
  const routes = [
    ['GET', 'stock'], ['GET', 'stock/log'],
    ['POST', 'stock/product', { code: '0029877030712' }],
    ['POST', 'stock/off', { id: `so-${'a'.repeat(32)}`, outcome: 'sold', lines: [{ variantId: '101', qty: 1 }] }],
    ['POST', 'stock/undo', { id: `so-${'a'.repeat(32)}` }],
  ];
  for (const [method, path, body] of routes) {
    assert.equal(said(await call(method, path, body, '')), `401 ${W.login}`, `${method} ${path} logged out`);
    assert.equal(said(await call(method, path, body, MEMBER)), `403 ${W.team}`, `${method} ${path} as a customer`);
  }
  assert.equal(count(CATAN), 5);
  assert.equal(adjustCalls.length, 0);
  for (const customer of [OWNER, HELPER, BARE]) {
    ok(await call('GET', 'stock', undefined, customer));
    ok(await call('POST', 'stock/product', { code: '0029877030712' }, customer));
    ok(await off(lot([{ variantId: '101', qty: 1 }]), customer));
  }
  assert.equal(count(CATAN), 2);
});

test("GET /stock: who's on it, the shop's day, 24 hours to undo, and the reasons in the contract's words", async () => {
  const start = ok(await call('GET', 'stock', undefined, HELPER));
  assert.deepEqual(start.staff, { name: 'Caleb', role: 'helper' });
  assert.equal(start.day, SAT);
  assert.equal(start.undoHours, 24);
  assert.deepEqual(start.reasons, [
    { key: 'damaged', label: 'Damaged' }, { key: 'gift', label: 'Gift or giveaway' }, { key: 'prize', label: 'Prize' },
    { key: 'lost', label: 'Lost or stolen' }, { key: 'other', label: 'Something else' },
  ]);
  assert.deepEqual(start.reasons, STOCK_OFF_REASONS.map(([k, label]) => ({ key: k, label })));
  assert.deepEqual(start.events, []);
  assert.deepEqual(ok(await call('GET', 'stock')).staff, { name: 'Mo', role: 'owner' });
});

test('GET /stock: the places lots were taken off in the last 90 days, newest first, up to 8, never the empty one', async () => {
  ok(await off(lot([{ variantId: '101', qty: 1 }], { event: 'Oddity Alley' })));
  nowIs(clock + HOUR);
  ok(await off(lot([{ variantId: '101', qty: 1 }], { event: '' })));
  nowIs(clock + HOUR);
  ok(await off(lot([{ variantId: '101', qty: 1 }], { event: 'Armageddon Auckland' })));
  nowIs(clock + HOUR);
  ok(await off(lot([{ variantId: '109', qty: 1 }], { event: 'Oddity Alley' })));
  assert.deepEqual(ok(await call('GET', 'stock')).events, ['Oddity Alley', 'Armageddon Auckland']);
  // a refused lot's place isn't one
  assert.equal((await off(lot([{ variantId: '105', qty: 1 }], { event: 'Nowhere Con' }))).status, 422);
  assert.deepEqual(ok(await call('GET', 'stock')).events, ['Oddity Alley', 'Armageddon Auckland']);
  for (let i = 1; i <= 9; i += 1) {
    nowIs(clock + MIN);
    ok(await off(lot([{ variantId: '109', qty: 1 }], { event: `Market ${i}` })));
  }
  const events = ok(await call('GET', 'stock')).events;
  assert.equal(events.length, 8);
  assert.equal(events[0], 'Market 9');
  // 91 days on, they've dropped off
  nowIs(clock + 91 * DAY);
  assert.deepEqual(ok(await call('GET', 'stock')).events, []);
});

/* ================ 3. Looking a code up ================ */

test("POST /stock/product: a barcode in any of its forms, or a SKU, gives the thing and the shop's own count", async () => {
  // the camera reads a UPC-A as an EAN-13 with a 0 in front, or without it
  for (const code of ['0029877030712', '029877030712', '29877030712']) {
    const found = ok(await call('POST', 'stock/product', { code }));
    assert.deepEqual(found.product, { id: '5101', title: 'Catan', vendor: 'KOSMOS', type: 'Board Games', status: 'ACTIVE' });
    assert.deepEqual(found.variant, { id: '101', title: 'Default Title', sku: null, stock: 5, price: '10.00' });
    assert.equal(found.choices, undefined);
  }
  const bySku = ok(await call('POST', 'stock/product', { code: 'at-11002' }));
  assert.deepEqual(bySku.variant, { id: '103', title: 'Jet', sku: 'AT-11002', stock: 4, price: '10.00' });
  // a count of 0 or less is still the answer: the page says so
  assert.equal(ok(await call('POST', 'stock/product', { code: '5706569110215' })).variant.stock, 0);
  // another maker's dice are counted stock
  assert.equal(ok(await call('POST', 'stock/product', { code: '4056133701310' })).variant.stock, 36);
});

test("POST /stock/product: the count is the shop's own, not every location's together", async () => {
  const both = thing(120, 'Shared Shelf Game', { barcodes: ['9400000000120'], shop: 2, hoard: 100 });
  assert.equal(ok(await call('POST', 'stock/product', { code: '9400000000120' })).variant.stock, 2);
  assert.equal(count(both, HOARD), 100);
});

test("POST /stock/product: what can't come off is refused with its own words", async () => {
  const ask = async (code) => said(await call('POST', 'stock/product', { code }));
  assert.equal(await ask('DGL34-M011'), `422 ${W.library}`);
  assert.equal(await ask('31283129999'), `422 ${W.giftCard}`);
  assert.equal(await ask('31283123871'), `422 ${W.ownDice}`);
  assert.equal(await ask('DGD-N42'), `422 ${W.ownDice}`);
  assert.equal(await ask('31283123821'), "422 Shopify doesn't count Can of Drink, so there's nothing to take off.");
  assert.equal(await ask('9400000000111'), '422 Supplier Sample Box has no count at the shop in Shopify.');
  assert.equal(await ask('9999999999999'), `404 ${W.notFound}`);
  for (const code of ['', '   ', 'x'.repeat(41), 'has space', '<script>', 'a"b']) assert.equal(await ask(code), `400 ${W.code}`, JSON.stringify(code));
});

test('POST /stock/product: a shelf code the Lair knows is a library copy, whatever Shopify says of it', async () => {
  lair.sql.exec("INSERT INTO library_codes (key, variant_id) VALUES ('DGL56M085', 'gid://shopify/ProductVariant/900')");
  assert.equal(said(await call('POST', 'stock/product', { code: 'dgl56-m085' })), `422 ${W.library}`);
  assert.deepEqual(lookups, [], 'Shopify is not asked');
});

test('POST /stock/product: several things that can come off share a code, so the page asks which; the ones that cannot are left out', async () => {
  const day = thing(130, 'Pokemon 30th Celebration UPC', { option: 'Day (Espeon)', productId: 8000, barcodes: ['0196214130001'], shop: 3 });
  const night = thing(131, 'Pokemon 30th Celebration UPC', { option: 'Night (Umbreon)', productId: 8000, barcodes: ['0196214130001'], shop: 0 });
  const found = ok(await call('POST', 'stock/product', { code: '0196214130001' }));
  assert.equal(found.variant.id, day.id);
  assert.deepEqual(found.choices.map((c) => [c.product.title, c.variant.title, c.variant.stock]), [
    ['Pokemon 30th Celebration UPC', 'Day (Espeon)', 3], ['Pokemon 30th Celebration UPC', 'Night (Umbreon)', 0],
  ]);
  // a library copy with the game's own barcode is left out: one thing left, so nothing to ask
  thing(132, 'Wingspan (Library)', { barcodes: ['644216627721'], vendor: 'Dice Goblin NZ', shop: 1 });
  nowIs(clock + 2 * MIN);
  const wingspan = ok(await call('POST', 'stock/product', { code: '644216627721' }));
  assert.equal(wingspan.variant.id, WINGSPAN.id);
  assert.equal(wingspan.choices, undefined);
  // none of them can come off: the first one's words
  thing(133, 'Dice', { option: '$15 Dice', dice: true, tracked: false, vendor: 'Dice Goblin NZ', status: 'UNLISTED', barcodes: ['31283123871'] });
  nowIs(clock + 2 * MIN);
  assert.equal(said(await call('POST', 'stock/product', { code: '31283123871' })), `422 ${W.ownDice}`);
  assert.ok(night);
});

test("POST /stock/product: Shopify's answers for a code are kept for a minute; when Shopify can't say, 503 and nothing is kept", async () => {
  ok(await call('POST', 'stock/product', { code: '0029877030712' }));
  ok(await call('POST', 'stock/product', { code: '0029877030712' }));
  assert.equal(lookups.length, 1);
  nowIs(clock + 61_000);
  CATAN.levels.set(LOCATION, 3);
  assert.equal(ok(await call('POST', 'stock/product', { code: '0029877030712' })).variant.stock, 3);
  assert.equal(lookups.length, 2);
  trouble.lookup = true;
  assert.equal(said(await call('POST', 'stock/product', { code: '644216627721' })), `503 ${W.shopify}`);
  trouble.lookup = false;
  assert.equal(ok(await call('POST', 'stock/product', { code: '644216627721' })).variant.stock, 2);
});

/* ================ 4. Taking a lot off ================ */

test("sold: the things come off the shop's own count, in one change, with no order, price or customer", async () => {
  const body = lot([{ variantId: '101', qty: 2 }, { variantId: '103', qty: 1 }]);
  const { lot: done } = ok(await off(body, HELPER));
  assert.equal(count(CATAN), 3);
  assert.equal(count(SLEEVES_JET), 3);
  assert.deepEqual(done, {
    id: body.id, event: 'Armageddon Auckland', outcome: 'sold', reason: null, reasonLabel: null, note: null, by: 'Caleb', at: done.at, day: SAT,
    units: 3, took: 3, short: 0,
    lines: [
      { variantId: '101', title: 'Catan', qty: 2, took: 2, short: 0, left: 3 },
      { variantId: '103', title: 'Dragon Shield Matte Sleeves · Jet', qty: 1, took: 1, short: 0, left: 3 },
    ],
    undone: null,
  });
  assert.ok(Math.abs(done.at - clock) < 1000);
  // one inventoryAdjustQuantities for the lot: each line at the count it was read at, Shopify's key the lot's own
  assert.equal(adjustCalls.length, 1);
  assert.deepEqual(adjustCalls[0], {
    key: body.id, reason: 'other', reference: `gid://dice-goblin-lair/StockOff/${body.id}`,
    changes: [{ inventoryItemId: itemOf('101'), delta: -2, from: 5 }, { inventoryItemId: itemOf('103'), delta: -1, from: 4 }],
  });
  // nothing else was asked of Shopify: one read of the two things, one change
  assert.deepEqual(reads, [['101', '103']]);
  assert.deepEqual(lookups, []);
});

test("not sold: it comes off the same way, with why, and Shopify's reason follows it (a reason Shopify turns away goes once more as other)", async () => {
  const expect = { damaged: 'damaged', gift: 'promotion', prize: 'promotion', lost: 'shrinkage', other: 'other' };
  for (const [reason, shopifyReason] of Object.entries(expect)) {
    const body = lot([{ variantId: '109', qty: 1 }], { outcome: 'not-sold', reason, note: reason === 'other' ? 'Opened as the demo copy' : '' });
    const { lot: done } = ok(await off(body));
    assert.equal(done.outcome, 'not-sold');
    assert.equal(done.reason, reason);
    assert.equal(done.reasonLabel, STOCK_OFF_REASONS.find(([k]) => k === reason)[1]);
    assert.equal(done.note, reason === 'other' ? 'Opened as the demo copy' : null);
    assert.equal(adjustCalls.at(-1).reason, shopifyReason);
  }
  assert.equal(count(OAKIE), 31);
  // Shopify turns "damaged" away: the lot goes once more as "other", with a key of its own, and comes off once
  badReasons.add('damaged');
  const body = lot([{ variantId: '109', qty: 2 }], { outcome: 'not-sold', reason: 'damaged' });
  const before = adjustCalls.length;
  ok(await off(body));
  assert.deepEqual(adjustCalls.slice(before).map((c) => [c.key, c.reason]), [[body.id, 'damaged'], [`${body.id}-1`, 'other']]);
  assert.equal(count(OAKIE), 29);
});

test('a lot says where, what happened and why: Sold or Not sold, a reason when it is not sold, and a few words for something else', async () => {
  const lines = [{ variantId: '101', qty: 1 }];
  assert.equal(said(await off(lot(lines, { outcome: 'given' }))), `400 ${W.outcome}`);
  assert.equal(said(await off(lot(lines, { outcome: undefined }))), `400 ${W.outcome}`);
  assert.equal(said(await off(lot(lines, { outcome: 'not-sold' }))), `400 ${W.reason}`);
  assert.equal(said(await off(lot(lines, { outcome: 'not-sold', reason: 'stolen' }))), `400 ${W.reason}`);
  assert.equal(said(await off(lot(lines, { outcome: 'not-sold', reason: 'other' }))), `400 ${W.note}`);
  assert.equal(said(await off(lot(lines, { outcome: 'not-sold', reason: 'other', note: ' a ' }))), `400 ${W.note}`);
  assert.equal(count(CATAN), 5);
  assert.equal(adjustCalls.length, 0);
  // a sold lot keeps no reason or note, whatever was sent with it
  const sold = ok(await off(lot(lines, { reason: 'gift', note: 'ignored' }))).lot;
  assert.equal(sold.reason, null);
  assert.equal(sold.note, null);
  // the place is trimmed to 60 characters and a note to 200; a lot with no place is the shop's
  const long = ok(await off(lot(lines, { outcome: 'not-sold', reason: 'gift', event: `  ${'Armageddon '.repeat(10)}  `, note: 'x'.repeat(300) }))).lot;
  assert.equal(long.event.length, 60);
  assert.equal(long.event.startsWith('Armageddon Armageddon'), true);
  assert.equal(long.note.length, 200);
  assert.equal(ok(await off(lot(lines, { event: undefined }))).lot.event, '');
  assert.equal(ok(await off(lot(lines, { event: '   ' }))).lot.event, '');
});

test('a lot is 1 to 40 different things, each 1 to 99, each once, under a key of ours', async () => {
  const good = [{ variantId: '101', qty: 1 }];
  for (const id of [undefined, '', 'so-123', `so-${'g'.repeat(32)}`, `SO-${'a'.repeat(32)}`, `so-${'a'.repeat(33)}`, 42]) {
    assert.equal(said(await off({ id, outcome: 'sold', lines: good })), `400 ${W.id}`, String(id));
  }
  assert.equal(said(await off(lot([]))), `400 ${W.lines}`);
  assert.equal(said(await off(lot(undefined))), `400 ${W.lines}`);
  assert.equal(said(await off(lot(Array.from({ length: 41 }, (_, i) => ({ variantId: String(1000 + i), qty: 1 }))))), `400 ${W.lines}`);
  for (const qty of [0, -1, 100, 1.5, '2', null, undefined]) assert.equal(said(await off(lot([{ variantId: '101', qty }]))), `400 ${W.qty}`, String(qty));
  for (const variantId of ['', 'abc', 'gid://shopify/ProductVariant/101', '1'.repeat(21), null, 101.5]) {
    assert.equal(said(await off(lot([{ variantId, qty: 1 }]))), `400 ${W.qty}`, String(variantId));
  }
  assert.equal(said(await off(lot([{ variantId: '101', qty: 1 }, { variantId: '101', qty: 2 }]))), `400 ${W.qty}`);
  assert.equal(count(CATAN), 5);
  assert.equal(adjustCalls.length, 0);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM stock_offs').toArray()[0].n, 0);
  // 40 different things is fine, and a number as the id of a thing is read as the page's text one
  for (let i = 0; i < 39; i += 1) thing(2000 + i, `Thing ${i}`, { shop: 1 });
  const forty = [{ variantId: 101, qty: 99 }, ...Array.from({ length: 39 }, (_, i) => ({ variantId: String(2000 + i), qty: 1 }))];
  const done = ok(await off(lot(forty))).lot;
  assert.equal(done.lines.length, 40);
  assert.equal(done.units, 99 + 39);
  assert.equal(done.took, 5 + 39);
  assert.equal(done.short, 94);
});

test('never below zero: the count gives what it has, the rest is the line\'s short, and a count under zero is left exactly as it is', async () => {
  const ordered = thing(140, 'Combat Patrol: Space Marines', { vendor: 'Games Workshop', barcodes: ['5011921160001'], shop: -2 });
  const body = lot([{ variantId: '102', qty: 3 }, { variantId: '104', qty: 1 }, { variantId: '140', qty: 1 }, { variantId: '101', qty: 1 }]);
  const { lot: done } = ok(await off(body));
  // (the lines stay in the order they were scanned)
  assert.deepEqual(done.lines, [
    { variantId: '102', title: 'Wingspan', qty: 3, took: 2, short: 1, left: 0 },
    { variantId: '104', title: 'Dragon Shield Matte Sleeves · Crimson', qty: 1, took: 0, short: 1, left: 0 },
    { variantId: '140', title: 'Combat Patrol: Space Marines', qty: 1, took: 0, short: 1, left: -2 },
    { variantId: '101', title: 'Catan', qty: 1, took: 1, short: 0, left: 4 },
  ]);
  assert.deepEqual([done.units, done.took, done.short], [6, 3, 3]);
  assert.equal(count(WINGSPAN), 0);
  assert.equal(count(SLEEVES_RED), 0);
  assert.equal(count(ordered), -2);
  // only the things something came off are in the change
  assert.deepEqual(adjustCalls[0].changes, [{ inventoryItemId: itemOf('102'), delta: -2, from: 2 }, { inventoryItemId: itemOf('101'), delta: -1, from: 5 }]);
});

test('a lot where nothing could come off makes no call to Shopify and is kept, with its short', async () => {
  const body = lot([{ variantId: '104', qty: 2 }]);
  const { lot: done } = ok(await off(body));
  assert.deepEqual([done.units, done.took, done.short], [2, 0, 2]);
  assert.equal(adjustCalls.length, 0);
  assert.equal(count(SLEEVES_RED), 0);
  assert.deepEqual(ok(await call('GET', 'stock/log')).lots.map((l) => l.id), [body.id]);
  // and again is the same answer
  assert.deepEqual(ok(await off(body)).lot, done);
  assert.equal(reads.length, 1);
});

test('all or nothing: a lot with a thing that cannot come off is refused whole, saying which, and nothing changes; put right, the same key goes through', async () => {
  const body = lot([{ variantId: '101', qty: 1 }, { variantId: '105', qty: 1 }, { variantId: '107', qty: 2 }, { variantId: '999', qty: 1 }, { variantId: '110', qty: 1 }]);
  const res = await off(body);
  assert.equal(said(res), `422 ${W.problems}`);
  assert.deepEqual(res.data.problems, [
    { variantId: '105', words: W.library },
    { variantId: '107', words: W.ownDice },
    { variantId: '999', words: W.gone },
    { variantId: '110', words: "Shopify doesn't count Can of Drink, so there's nothing to take off." },
  ]);
  assert.equal(count(CATAN), 5);
  assert.equal(adjustCalls.length, 0);
  assert.equal(row(body.id), undefined, 'nothing went to Shopify, so the key is free again');
  assert.deepEqual(ok(await call('GET', 'stock/log')).lots, []);
  // the page takes those out and sends the lot again under its key
  const fixed = { ...body, lines: [{ variantId: '101', qty: 1 }] };
  assert.equal(ok(await off(fixed)).lot.took, 1);
  assert.equal(count(CATAN), 4);
});

/* ================ 5. Once ================ */

test('once: the same lot again, however often, answers as it did the first time and takes nothing more off', async () => {
  const body = lot([{ variantId: '101', qty: 2 }]);
  const first = ok(await off(body, HELPER)).lot;
  nowIs(clock + 3 * HOUR);
  // the count has moved on since (a sale online): the answer is still the first one
  CATAN.levels.set(LOCATION, 1);
  assert.deepEqual(ok(await off(body, HELPER)).lot, first);
  // from another phone, days later, with its clock sent along
  nowIs(clock + 3 * DAY);
  assert.deepEqual(ok(await off({ ...body, at: clock }, OWNER)).lot, first);
  assert.equal(adjustCalls.length, 1);
  assert.equal(count(CATAN), 1);
  assert.equal(first.by, 'Caleb');
});

test('once: the same key with different things in it is refused', async () => {
  const body = lot([{ variantId: '101', qty: 2 }]);
  ok(await off(body));
  for (const other of [
    { ...body, lines: [{ variantId: '101', qty: 3 }] },
    { ...body, lines: [{ variantId: '101', qty: 2 }, { variantId: '102', qty: 1 }] },
    { ...body, outcome: 'not-sold', reason: 'gift' },
    { ...body, event: 'Oddity Alley' },
  ]) assert.equal(said(await off(other)), `409 ${W.changed}`);
  assert.equal(count(CATAN), 3);
  assert.equal(count(WINGSPAN), 2);
  // the order the things were scanned in doesn't make it a different lot
  const two = lot([{ variantId: '102', qty: 1 }, { variantId: '101', qty: 1 }]);
  const first = ok(await off(two)).lot;
  assert.deepEqual(ok(await off({ ...two, lines: [...two.lines].reverse() })).lot, first);
});

test("once: an answer lost on the way is asked for again with Shopify's key, so it never comes off twice", async () => {
  const body = lot([{ variantId: '101', qty: 2 }]);
  trouble.adjust = 'lost';
  assert.equal(said(await off(body)), `503 ${W.notAnswered}`);
  assert.equal(count(CATAN), 3, 'it did come off');
  assert.equal(row(body.id).status, 'sending');
  assert.deepEqual(ok(await call('GET', 'stock/log')).lots, [], "it isn't on the list until the Lair knows");
  const done = ok(await off(body)).lot;
  assert.equal(count(CATAN), 3, 'and not a second time');
  assert.deepEqual(adjustCalls.map((c) => c.key), [body.id, body.id]);
  // the line says what the first try took, from the count it was read at
  assert.deepEqual(done.lines, [{ variantId: '101', title: 'Catan', qty: 2, took: 2, short: 0, left: 3 }]);
});

test('once: Shopify down before anything ran, or turning the call away, takes nothing off; the next try does, once', async () => {
  const body = lot([{ variantId: '101', qty: 1 }]);
  trouble.adjust = 'down';
  assert.equal(said(await off(body)), `503 ${W.notAnswered}`);
  assert.equal(count(CATAN), 5);
  ok(await off(body));
  assert.equal(count(CATAN), 4);
  // turned away before it ran (a permission): said plainly, nothing off, and a fresh key next time
  const second = lot([{ variantId: '101', qty: 1 }]);
  trouble.adjust = 'refused';
  const res = await off(second);
  assert.equal(res.status, 422);
  assert.match(res.data.error, /^Shopify said no: /);
  assert.equal(count(CATAN), 4);
  ok(await off(second));
  assert.equal(count(CATAN), 3);
  assert.deepEqual(adjustCalls.slice(-2).map((c) => c.key), [second.id, `${second.id}-1`]);
  // reading the counts failing is a 503 too, and nothing is kept
  const third = lot([{ variantId: '101', qty: 1 }]);
  trouble.read = true;
  assert.equal(said(await off(third)), `503 ${W.shopify}`);
  assert.equal(row(third.id), undefined);
  ok(await off(third));
  assert.equal(count(CATAN), 2);
});

test("once: Shopify's own answers about its key", async () => {
  // still working on the first try
  const busy = lot([{ variantId: '101', qty: 1 }]);
  trouble.adjust = ['IDEMPOTENCY_CONCURRENT_REQUEST'];
  assert.equal(said(await off(busy)), `503 ${W.busy}`);
  ok(await off(busy));
  assert.equal(count(CATAN), 4);
  // Shopify said no and took nothing: that key is spent, so the next try has a new one
  const no = lot([{ variantId: '101', qty: 1 }]);
  trouble.adjust = ['INVALID_LOCATION'];
  assert.equal(said(await off(no)), '422 Shopify said no: The specified location could not be found.');
  assert.equal(count(CATAN), 4);
  ok(await off(no));
  assert.equal(count(CATAN), 3);
  assert.deepEqual(adjustCalls.slice(-2).map((c) => c.key), [no.id, `${no.id}-1`]);
  // a try Shopify says failed, or its service being down, is a 503 and a new key next time
  const failed = lot([{ variantId: '101', qty: 1 }]);
  trouble.adjust = ['SERVICE_UNAVAILABLE'];
  assert.equal(said(await off(failed)), `503 ${W.notAnswered}`);
  ok(await off(failed));
  assert.equal(count(CATAN), 2);
});

test("once: a lot whose answer never came isn't sent again once Shopify's key is nearly up", async () => {
  const body = lot([{ variantId: '101', qty: 1 }]);
  trouble.adjust = 'lost';
  assert.equal(said(await off(body)), `503 ${W.notAnswered}`);
  nowIs(clock + 23 * HOUR + MIN);
  assert.equal(said(await off(body)), `409 ${W.stale}`);
  assert.equal(adjustCalls.length, 1);
  assert.equal(count(CATAN), 4);
});

test('a count that moved in between: Shopify refuses the lot, the Lair reads again and tries again, and never-below-zero holds against the count as it really is', async () => {
  // two Wingspan on the count, both scanned; one sells online between the read and the change
  const body = lot([{ variantId: '102', qty: 2 }, { variantId: '101', qty: 1 }]);
  between = () => WINGSPAN.levels.set(LOCATION, 1);
  const { lot: done } = ok(await off(body));
  assert.deepEqual(done.lines, [
    { variantId: '102', title: 'Wingspan', qty: 2, took: 1, short: 1, left: 0 },
    { variantId: '101', title: 'Catan', qty: 1, took: 1, short: 0, left: 4 },
  ]);
  assert.equal(count(WINGSPAN), 0);
  assert.equal(count(CATAN), 4, 'nothing came off on the try Shopify refused');
  assert.deepEqual(adjustCalls.map((c) => [c.key, c.changes.map((x) => [x.delta, x.from])]), [
    [body.id, [[-2, 2], [-1, 5]]],
    [`${body.id}-1`, [[-1, 1], [-1, 5]]],
  ]);
  assert.equal(reads.length, 2);
});

test('a count that keeps moving: after 3 tries the lot says so, nothing has come off, and it can be sent again', async () => {
  const body = lot([{ variantId: '101', qty: 1 }]);
  let moves = 0;
  const move = () => {
    moves += 1;
    CATAN.levels.set(LOCATION, count(CATAN) + 10);
    if (moves < 3) between = move;
  };
  between = move;
  assert.equal(said(await off(body)), `503 ${W.moved}`);
  assert.equal(adjustCalls.length, 3);
  assert.equal(count(CATAN), 35);
  const { lot: done } = ok(await off(body));
  assert.equal(done.took, 1);
  assert.equal(count(CATAN), 34);
  assert.equal(new Set(adjustCalls.map((c) => c.key)).size, 4, 'each try had a key of its own');
});

/* ================ 6. When it happened ================ */

test("a lot's time: the phone's clock when it's within the last 7 days and no more than 5 minutes ahead, otherwise the Lair's own", async () => {
  const lines = [{ variantId: '109', qty: 1 }];
  const when = async (sent) => ok(await off(lot(lines, { at: sent }))).lot.at;
  // sent from the hall three hours late
  assert.equal(await when(NOW - 3 * HOUR), NOW - 3 * HOUR);
  assert.equal(await when(NOW - 7 * DAY + MIN), NOW - 7 * DAY + MIN);
  const ahead = clock + 4 * MIN;
  assert.equal(await when(ahead), ahead);
  for (const wrong of [NOW - 8 * DAY, NOW + HOUR, 0, -5, 'yesterday', null, 1.5e300]) {
    const got = await when(wrong);
    assert.ok(Math.abs(got - clock) < 1000, `${wrong} → the Lair's clock`);
  }
});

test("a lot's day is the shop's day it happened on, in Auckland", async () => {
  // 11:30pm on Saturday in Auckland is still Saturday morning in UTC, and 12:30am on Sunday is Saturday there too
  nowIs(at(SAT, 23, 30));
  const late = ok(await off(lot([{ variantId: '109', qty: 1 }]))).lot;
  assert.equal(late.day, SAT);
  nowIs(at(SUN, 0, 30));
  const early = ok(await off(lot([{ variantId: '109', qty: 1 }]))).lot;
  assert.equal(early.day, SUN);
  // a lot the phone held on to since Saturday afternoon is Saturday's, though the Lair heard on Sunday
  const held = ok(await off(lot([{ variantId: '109', qty: 1 }], { at: at(SAT, 15) }))).lot;
  assert.equal(held.day, SAT);
  assert.deepEqual(ok(await call('GET', 'stock/log')).lots.map((l) => l.id), [early.id]);
  assert.deepEqual(ok(await call('GET', `stock/log?day=${SAT}`)).lots.map((l) => l.id), [late.id, held.id]);
});

/* ================ 7. Undo ================ */

test('undo: any staff can take a lot back within 24 hours: exactly what it took goes back on the count, once', async () => {
  const body = lot([{ variantId: '102', qty: 3 }, { variantId: '101', qty: 1 }, { variantId: '104', qty: 1 }]);
  ok(await off(body, HELPER));
  assert.deepEqual([count(WINGSPAN), count(CATAN), count(SLEEVES_RED)], [0, 4, 0]);
  nowIs(clock + 2 * HOUR);
  const { lot: back } = ok(await call('POST', 'stock/undo', { id: body.id }, OWNER));
  // Wingspan had 2 and 3 were scanned: 2 go back, not 3; the thing nothing came off is left alone
  assert.deepEqual([count(WINGSPAN), count(CATAN), count(SLEEVES_RED)], [2, 5, 0]);
  assert.deepEqual(back.undone, { at: clock, by: 'Mo' });
  assert.equal(back.by, 'Caleb');
  assert.deepEqual(adjustCalls.at(-1), {
    key: `${body.id}-undo`, reason: 'correction', reference: `gid://dice-goblin-lair/StockOff/${body.id}`,
    changes: [{ inventoryItemId: itemOf('102'), delta: 2, from: null }, { inventoryItemId: itemOf('101'), delta: 1, from: null }],
  });
  // a second undo answers the same and puts nothing more back
  nowIs(clock + MIN);
  assert.deepEqual(ok(await call('POST', 'stock/undo', { id: body.id }, HELPER)).lot, back);
  assert.equal(adjustCalls.length, 2);
  assert.deepEqual([count(WINGSPAN), count(CATAN)], [2, 5]);
  // and the lot itself, sent again, is still the lot that was taken back
  assert.deepEqual(ok(await off(body, HELPER)).lot, back);
  assert.equal(adjustCalls.length, 2);
});

test('undo: not after 24 hours, not a lot Gobgob does not know, not one that has not come off yet', async () => {
  const body = lot([{ variantId: '101', qty: 1 }]);
  ok(await off(body));
  assert.equal(said(await call('POST', 'stock/undo', { id: `so-${'f'.repeat(32)}` })), `404 ${W.noLot}`);
  assert.equal(said(await call('POST', 'stock/undo', { id: 'nonsense' })), `404 ${W.noLot}`);
  assert.equal(said(await call('POST', 'stock/undo', {})), `404 ${W.noLot}`);
  nowIs(clock + 24 * HOUR - MIN);
  const kept = lot([{ variantId: '101', qty: 1 }]);
  ok(await off(kept));
  nowIs(clock + 2 * MIN);
  assert.equal(said(await call('POST', 'stock/undo', { id: body.id })), `409 ${W.tooLate}`);
  assert.equal(count(CATAN), 3);
  ok(await call('POST', 'stock/undo', { id: kept.id }));
  assert.equal(count(CATAN), 4);
  // one whose answer from Shopify never came
  const lost = lot([{ variantId: '101', qty: 1 }]);
  trouble.adjust = 'lost';
  await off(lost);
  assert.equal(said(await call('POST', 'stock/undo', { id: lost.id })), `409 ${W.notOff}`);
});

test("undo: an answer lost on the way is asked for again with its own key, so nothing goes back twice; a lot that took nothing needs no call", async () => {
  const body = lot([{ variantId: '101', qty: 2 }]);
  ok(await off(body));
  trouble.adjust = 'lost';
  assert.equal(said(await call('POST', 'stock/undo', { id: body.id })), `503 ${W.undoNotAnswered}`);
  assert.equal(count(CATAN), 5, 'it did go back');
  assert.equal(ok(await call('GET', 'stock/log')).lots[0].undone, null, "the list doesn't say so until the Lair knows");
  ok(await call('POST', 'stock/undo', { id: body.id }));
  assert.equal(count(CATAN), 5);
  assert.deepEqual(adjustCalls.slice(1).map((c) => c.key), [`${body.id}-undo`, `${body.id}-undo`]);
  // Shopify down before it ran, then turned away: nothing back, and the turned-away try's key isn't used again
  const second = lot([{ variantId: '101', qty: 1 }]);
  ok(await off(second));
  trouble.adjust = 'down';
  assert.equal(said(await call('POST', 'stock/undo', { id: second.id })), `503 ${W.undoNotAnswered}`);
  trouble.adjust = ['INVALID_LOCATION'];
  assert.equal((await call('POST', 'stock/undo', { id: second.id })).status, 422);
  assert.equal(count(CATAN), 4);
  ok(await call('POST', 'stock/undo', { id: second.id }));
  assert.equal(count(CATAN), 5);
  assert.deepEqual(adjustCalls.slice(-3).map((c) => c.key), [`${second.id}-undo`, `${second.id}-undo`, `${second.id}-undo-1`]);
  // nothing came off, so there's nothing to ask Shopify
  const none = lot([{ variantId: '104', qty: 1 }]);
  ok(await off(none));
  const calls = adjustCalls.length;
  assert.ok(ok(await call('POST', 'stock/undo', { id: none.id })).lot.undone);
  assert.equal(adjustCalls.length, calls);
});

/* ================ 8. The list ================ */

test("GET /stock/log: a day's lots, newest first, with what was scanned in the ones that weren't taken back, and what wasn't on the count", async () => {
  const a = ok(await off(lot([{ variantId: '101', qty: 2 }, { variantId: '102', qty: 3 }]), HELPER)).lot; // 5 scanned, 4 off, 1 short
  nowIs(clock + 10 * MIN);
  const b = ok(await off(lot([{ variantId: '109', qty: 1 }], { outcome: 'not-sold', reason: 'gift', event: 'Armageddon Auckland' }), OWNER)).lot;
  nowIs(clock + 10 * MIN);
  const c = ok(await off(lot([{ variantId: '109', qty: 5 }]), BARE)).lot;
  nowIs(clock + MIN);
  ok(await call('POST', 'stock/undo', { id: c.id }, BARE));
  const log = ok(await call('GET', 'stock/log', undefined, BARE));
  assert.equal(log.day, SAT);
  assert.deepEqual(log.lots.map((l) => [l.id, l.by, Boolean(l.undone)]), [[c.id, 'Felix', true], [b.id, 'Mo', false], [a.id, 'Caleb', false]]);
  assert.deepEqual(log.totals, { lots: 2, sold: 5, notSold: 1, short: 1 });
  assert.deepEqual(log.lots[2], a);
  // another day's is empty; a day that isn't one of the last 60, or isn't a day, is refused
  assert.deepEqual(ok(await call('GET', `stock/log?day=${'2026-11-20'}`)), { day: '2026-11-20', lots: [], totals: { lots: 0, sold: 0, notSold: 0, short: 0 } });
  for (const day of ['2026-09-21', '2026-11-22', '21-11-2026', 'today', '2026-13-45']) {
    assert.equal(said(await call('GET', `stock/log?day=${day}`)), `400 ${W.day}`, day);
  }
  // 60 days on, Saturday's can still be read
  nowIs(at(SAT, 14) + 60 * DAY);
  assert.equal(ok(await call('GET', `stock/log?day=${SAT}`)).lots.length, 3);
});

/* ================ 9. The owner's list ================ */

const upkeep = async (ms) => {
  nowIs(ms);
  const result = await lair.stockOffUpkeep(ms);
  await settle();
  return result;
};
/** A Saturday at the stall: Caleb sells, Mo gives one away, one count is short, and a lot is taken back */
async function saturday() {
  const sold = ok(await off(lot([{ variantId: '101', qty: 2 }, { variantId: '102', qty: 3 }]), HELPER)).lot;
  nowIs(at(SAT, 14, 14));
  const gift = ok(await off(lot([{ variantId: '109', qty: 1 }], { outcome: 'not-sold', reason: 'damaged', note: 'Box crushed in the van' }), HELPER)).lot;
  nowIs(at(SAT, 15));
  const more = ok(await off(lot([{ variantId: '101', qty: 1 }, { variantId: '109', qty: 4 }]), OWNER)).lot;
  nowIs(at(SAT, 16));
  const back = ok(await off(lot([{ variantId: '103', qty: 2 }]), BARE)).lot;
  nowIs(at(SAT, 16, 5));
  ok(await call('POST', 'stock/undo', { id: back.id }, OWNER));
  return { sold, gift, more, back };
}

test("the owner's list: each morning from 8am at the shop, one email to the owner with every lot of the days before that hasn't been in one", async () => {
  await saturday();
  // not on the day itself, and not before 8am the next morning
  assert.equal(await upkeep(at(SAT, 23, 50)), null);
  assert.equal(await upkeep(at(SUN, 7, 50)), null);
  assert.equal(mails.length, 0);
  assert.deepEqual(await upkeep(at(SUN, 8)), { lots: 4, sent: true });
  assert.equal(mails.length, 1);
  const mail = mails[0];
  assert.equal(mail.to, 'mo@example.com');
  // the numbers are what was scanned (what left the stall): 3 Wingspan, though the count only had 2
  assert.equal(mail.subject, 'Stock off, Saturday 21 November: 10 sold, 1 not sold');
  // what sold, added up by thing, most first, and who scanned
  assert.match(mail.text, /Armageddon Auckland · Sold:\s+4 × Oakie Doakie Gemidice RPG Dice Set · Red Sky\n\s+3 × Catan\n\s+3 × Wingspan\n\s+Scanned by Caleb and Mo/);
  // each thing not sold on a line of its own with its reason, who and when, and the note
  assert.match(mail.text, /Armageddon Auckland · Not sold:\s+1 × Oakie Doakie Gemidice RPG Dice Set · Red Sky: damaged \(Caleb, 2:14 pm\)\. Box crushed in the van/);
  // what was scanned and wasn't on the count
  assert.match(mail.text, /Armageddon Auckland · Counts to check:\s+Wingspan: 3 scanned, 2 on the count/);
  // lots taken back, with who took them back
  assert.match(mail.text, /Armageddon Auckland · Taken back:\s+2 × Dragon Shield Matte Sleeves · Jet, sold \(Felix, 4:00 pm\), taken back by Mo/);
  assert.match(mail.html, /4 × Oakie Doakie Gemidice RPG Dice Set · Red Sky/);
  // once: the next runs send nothing more
  assert.equal(await upkeep(at(SUN, 8, 10)), null);
  assert.equal(await upkeep(at(SUN, 20)), null);
  assert.equal(mails.length, 1);
  assert.equal(ownerAsked, 1);
});

test("the owner's list: never to the team's address; STOCK_OFF_EMAIL names another, and off means no email at all", async () => {
  settings({ STOCK_OFF_EMAIL: 'stock@example.com' });
  await saturday();
  await upkeep(at(SUN, 8));
  assert.deepEqual(mails.map((m) => m.to), ['stock@example.com']);
  assert.equal(ownerAsked, 0);
  // off: nothing goes, and those lots are never sent later when it's switched back on
  settings({ STOCK_OFF_EMAIL: 'off' });
  nowIs(at(SUN, 14));
  ok(await off(lot([{ variantId: '109', qty: 1 }])));
  assert.equal(await upkeep(at('2026-11-23', 8)), null);
  settings();
  assert.equal(await upkeep(at('2026-11-23', 8, 10)), null);
  assert.equal(mails.length, 1);
  assert.ok(mails.every((m) => m.to !== 'team@example.com'));
  // an address that isn't one address: nothing is sent, and the status table says why
  settings({ STOCK_OFF_EMAIL: 'mo@example.com, caleb@example.com' });
  nowIs(at('2026-11-23', 14));
  ok(await off(lot([{ variantId: '109', qty: 1 }])));
  const result = await upkeep(at('2026-11-24', 8));
  assert.equal(result.sent, false);
  assert.equal(mails.length, 1);
});

test("the owner's list: today's lots wait for tomorrow's; several days go in one email; a lot heard about late is in the next morning's", async () => {
  await saturday();
  // Sunday at the stall, before the Lair's morning run
  nowIs(at(SUN, 7));
  ok(await off(lot([{ variantId: '109', qty: 2 }], { event: 'Armageddon Auckland' }), HELPER));
  await upkeep(at(SUN, 8));
  assert.equal(mails.length, 1);
  assert.doesNotMatch(mails[0].subject, /22/);
  // a phone that had no signal on Saturday gets through on Sunday afternoon: Saturday's lot, heard late
  nowIs(at(SUN, 15));
  ok(await off(lot([{ variantId: '109', qty: 3 }], { at: at(SAT, 17), event: 'Armageddon Auckland' }), BARE));
  assert.equal(await upkeep(at(SUN, 15, 10)), null, "one email a morning: it's in tomorrow's");
  assert.deepEqual(await upkeep(at('2026-11-23', 8, 5)), { lots: 2, sent: true });
  assert.equal(mails[1].subject, 'Stock off, 21 to 22 November: 5 sold, 0 not sold');
  assert.match(mails[1].text, /Saturday 21 November · Armageddon Auckland · Sold:\s+3 × Oakie Doakie/);
  assert.match(mails[1].text, /Sunday 22 November · Armageddon Auckland · Sold:\s+2 × Oakie Doakie/);
  // a lot with no place is the shop's
  nowIs(at('2026-11-23', 17));
  ok(await off(lot([{ variantId: '101', qty: 1 }], { event: '', outcome: 'not-sold', reason: 'prize' })));
  await upkeep(at('2026-11-24', 9));
  assert.equal(mails[2].subject, 'Stock off, Monday 23 November: 0 sold, 1 not sold');
  assert.match(mails[2].text, /At the shop · Not sold:\s+1 × Catan: prize \(Mo, 5:00 pm\)/);
});

test("the owner's list: written once and kept with its key, so a try that may have gone is never followed by a different one; given up on after 23 hours", async () => {
  await saturday();
  mailResult = { ok: false, attempted: true, status: 500, message: 'Resend is down' };
  assert.deepEqual(await upkeep(at(SUN, 8)), { lots: 4, sent: false });
  // more comes off on Sunday, and a Saturday lot arrives late: neither changes the email that's waiting
  nowIs(at(SUN, 9));
  ok(await off(lot([{ variantId: '109', qty: 3 }], { at: at(SAT, 17) }), BARE));
  assert.deepEqual(await upkeep(at(SUN, 9, 10)), { lots: 4, sent: false });
  mailResult = { ok: true, attempted: true, status: 200 };
  assert.deepEqual(await upkeep(at(SUN, 9, 20)), { lots: 4, sent: true });
  assert.equal(mails.length, 3);
  assert.equal(new Set(mails.map((m) => m.idempotencyKey)).size, 1);
  assert.ok(mails[0].idempotencyKey);
  assert.equal(new Set(mails.map((m) => m.text)).size, 1);
  // the late one is in Monday's, with a key of its own
  assert.deepEqual(await upkeep(at('2026-11-23', 8)), { lots: 1, sent: true });
  assert.notEqual(mails[3].idempotencyKey, mails[0].idempotencyKey);
  // an email that never goes is given up on after 23 hours, and the next morning's is not held up by it
  mailResult = { ok: false, attempted: true, status: 500, message: 'Resend is down' };
  nowIs(at('2026-11-23', 12));
  ok(await off(lot([{ variantId: '109', qty: 1 }])));
  assert.deepEqual(await upkeep(at('2026-11-24', 8)), { lots: 1, sent: false });
  assert.deepEqual(await upkeep(at('2026-11-25', 7, 30)), { lots: 1, sent: false, stopped: true });
  mailResult = { ok: true, attempted: true, status: 200 };
  nowIs(at('2026-11-25', 7, 40));
  ok(await off(lot([{ variantId: '109', qty: 1 }], { at: at('2026-11-24', 12) })));
  assert.deepEqual(await upkeep(at('2026-11-25', 8)), { lots: 1, sent: true });
});

test("the owner's list: when Shopify can't say the owner's address, or email isn't set up, the lots wait for a morning that can", async () => {
  await saturday();
  lair.shopify.shopOwnerEmail = async () => {
    throw new Error('Shopify is having a moment');
  };
  assert.deepEqual(await upkeep(at(SUN, 8)), { lots: 4, sent: false });
  assert.equal(mails.length, 0);
  lair.shopify.shopOwnerEmail = async () => 'mo@example.com';
  assert.deepEqual(await upkeep(at(SUN, 8, 10)), { lots: 4, sent: true });
  assert.equal(mails.length, 1);
  // with no email set up at all, nothing is written or claimed
  settings({ RESEND_API_KEY: '' });
  nowIs(at(SUN, 12));
  ok(await off(lot([{ variantId: '109', qty: 1 }])));
  assert.deepEqual(await upkeep(at('2026-11-23', 8)), { lots: 1, sent: false });
  settings();
  assert.deepEqual(await upkeep(at('2026-11-23', 8, 10)), { lots: 1, sent: true });
});

test('the 10-minute run (maintenance) sends the owner\'s list', async () => {
  lair.shopify.appInfo = async () => ({ app: { title: 'Dice Goblin Lair' }, shop: { name: 'Dice Goblin' }, scopes: ['read_products', 'read_inventory', 'write_inventory'] });
  lair.ensureWebhook = async () => ({ ok: true });
  await saturday();
  nowIs(at(SUN, 8, 3));
  const run = await lair.checkConnection('https://lair.test/webhooks/orders-paid');
  await settle();
  assert.deepEqual(run.stockOff, { lots: 4, sent: true });
  assert.equal(mails.filter((m) => /^Stock off, /.test(m.subject)).length, 1);
});

/* ================ 10. What the Lair asks Shopify ================ */

function adminWith(answer) {
  const asked = [];
  const admin = new ShopifyAdmin({ SHOP: 'ep0qiq-rp.myshopify.com', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret', API_VERSION: '2026-07' }, null);
  admin.graphql = async (query, variables, options) => {
    asked.push({ query, variables, options });
    return typeof answer === 'function' ? answer(query, variables) : answer;
  };
  return { admin, asked };
}
const node = (id, o = {}) => ({
  id: `gid://shopify/ProductVariant/${id}`, title: o.option || 'Default Title', sku: o.sku ?? null, price: o.price === undefined ? '89.9' : o.price,
  barcodes: { nodes: (o.barcodes || []).map((value) => ({ value })) },
  inventoryItem: { id: itemOf(id), tracked: o.tracked !== false, inventoryLevel: o.level === null ? null : { quantities: [{ name: 'available', quantity: o.level ?? 5 }] } },
  product: { id: `gid://shopify/Product/${Number(id) + 5000}`, title: o.title || 'Catan', productType: 'Board Games', vendor: 'KOSMOS', status: 'ACTIVE', isGiftCard: false, dice: o.dice === true },
});

test("Shopify, by code: the barcode in every form or the SKU, each thing with its count at the shop's own location", async () => {
  const { admin, asked } = adminWith({ productVariants: { nodes: [node(101, { barcodes: ['029877030712'], level: 5 }), node(150, { barcodes: ['0029877030712'], level: null, title: 'Catan (Library)' })] } });
  const found = await admin.stockOffByCode('0029877030712', { location: LOCATION, dice: DICE_DEAL });
  assert.deepEqual(found[0], {
    product: { id: '5101', title: 'Catan', type: 'Board Games', vendor: 'KOSMOS', status: 'ACTIVE', giftCard: false, dice: false },
    variant: { id: '101', title: 'Default Title', sku: null, barcodes: ['029877030712'], tracked: true, itemId: itemOf(101), stock: 5, price: '89.90' },
  });
  assert.match(asked[0].query, /nodes \{ id title sku price /, "the shop's price is asked for");
  assert.equal(found[1].variant.stock, null, 'no count at the shop');
  assert.match(asked[0].query, /inventoryLevel\(locationId: \$location\) \{ quantities\(names: \["available"\]\) \{ name quantity \} \}/);
  assert.match(asked[0].query, /dice: inCollection\(id: \$dice\)/);
  assert.equal(asked[0].variables.location, LOCATION);
  assert.equal(asked[0].variables.dice, DICE_DEAL);
  assert.equal(asked[0].variables.query, 'barcode:"0029877030712" OR barcode:"29877030712" OR barcode:"029877030712" OR barcode:"00029877030712" OR sku:"0029877030712"');
  // quotes and backslashes never reach Shopify's search
  await admin.stockOffByCode('ab"c\\d', { location: LOCATION, dice: DICE_DEAL });
  assert.equal(asked[1].variables.query, 'barcode:"abcd" OR sku:"abcd"');
});

test('Shopify, by id: the things of a lot in one read, by their numbers', async () => {
  const { admin, asked } = adminWith({ nodes: [node(101, { level: 5 }), null, { id: 'gid://shopify/Product/9' }] });
  const found = await admin.stockOffByIds(['101', '999', '9'], { location: LOCATION, dice: DICE_DEAL });
  assert.deepEqual([...found.keys()], ['101']);
  assert.equal(found.get('101').variant.stock, 5);
  assert.deepEqual(asked[0].variables.ids, ['gid://shopify/ProductVariant/101', 'gid://shopify/ProductVariant/999', 'gid://shopify/ProductVariant/9']);
});

test("Shopify, a change to the count: available at the location, each line from the count it was read at, under the lot's key", async () => {
  const { admin, asked } = adminWith({ inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: 'gid://shopify/InventoryAdjustmentGroup/1' }, userErrors: [] } });
  const changes = [{ inventoryItemId: itemOf(101), delta: -2, from: 5 }, { inventoryItemId: itemOf(102), delta: 1, from: null }];
  assert.deepEqual(await admin.stockOffAdjust(changes, LOCATION, 'so-key', 'damaged', 'gid://dice-goblin-lair/StockOff/so-key'), { ok: true });
  assert.match(asked[0].query, /inventoryAdjustQuantities\(input: \$input\) @idempotent\(key: \$key\)/);
  assert.deepEqual(asked[0].variables, {
    key: 'so-key',
    input: {
      name: 'available', reason: 'damaged', referenceDocumentUri: 'gid://dice-goblin-lair/StockOff/so-key',
      changes: [
        { inventoryItemId: itemOf(101), locationId: LOCATION, delta: -2, changeFromQuantity: 5 },
        { inventoryItemId: itemOf(102), locationId: LOCATION, delta: 1, changeFromQuantity: null },
      ],
    },
  });
  // Shopify's refusals come back as their codes; no answer at all throws
  const refused = adminWith({ inventoryAdjustQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ field: ['input'], message: 'Stale', code: 'CHANGE_FROM_QUANTITY_STALE' }] } });
  assert.deepEqual(await refused.admin.stockOffAdjust(changes, LOCATION, 'k', 'other', 'gid://dice-goblin-lair/StockOff/k'), { errors: [{ code: 'CHANGE_FROM_QUANTITY_STALE', message: 'Stale' }] });
  await assert.rejects(adminWith({}).admin.stockOffAdjust(changes, LOCATION, 'k', 'other', 'gid://dice-goblin-lair/StockOff/k'), /no answer/);
});

// Mo, 20 Nov 2026: "add the price of the item as well so I know the cost just give me the information don't do
// anything else with it": the shop's price is shown on the page and nothing else is done with it.
test("the shop's price comes with a looked-up thing, to be read only: dollars and cents, or null when Shopify gives none", async () => {
  for (const [given, want] of [['89.9', '89.90'], ['12', '12.00'], ['0.00', '0.00'], [null, null], ['', null], ['abc', null], ['-5', null]]) {
    const { admin } = adminWith({ productVariants: { nodes: [node(101, { barcodes: ['029877030712'], price: given })] } });
    const [found] = await admin.stockOffByCode('029877030712', { location: LOCATION, dice: DICE_DEAL });
    assert.equal(found.variant.price, want, `Shopify's ${JSON.stringify(given)}`);
  }
  // the page's answer carries it, for the first thing and for each choice
  assert.equal(ok(await call('POST', 'stock/product', { code: '029877030712' })).variant.price, '10.00');
});

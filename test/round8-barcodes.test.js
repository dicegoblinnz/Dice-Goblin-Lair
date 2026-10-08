// Round 8: a product's barcode matches however a camera reads it. Mo's MTG - Super Heroes bundle has the 12-digit UPC-A
// 195166315386 in Shopify, and the phone read it as the 13-digit EAN-13 0195166315386, so the tab's lookup missed it
// until he typed the code. Run with: node --test test/
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { ShopifyAdmin } from '../src/shopify.js';
import { barcodeForms, sameBarcode, rulesFromSettings } from '../src/core.js';

// Friday 9 October 2026, 6pm in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 9, 9, 5, 0);
const realNow = Date.now;

/* ---------------- helpers (copied from test/round7-a.test.js) ---------------- */
function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
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
const FALLBACK = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];

let lair;
async function call(method, path, body, customer = '') {
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  return { status: response.status, data: await response.json() };
}

beforeEach(() => {
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'ep0qiq-rp.myshopify.com' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: false, tags: [] });
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.rulesCache = rulesFromSettings({ lair_hours: 'Fri 12:00-23:00', lair_shop_tables: '' }, FALLBACK, []);
  lair.rulesLoadedAt = NOW + 365 * 24 * 3_600_000;
});
afterEach(() => {
  Date.now = realNow;
});

test('barcodes (round 8): every form a barcode can be read in; the same code with or without leading zeros', () => {
  assert.deepEqual(barcodeForms('195166315386'), ['195166315386', '0195166315386', '00195166315386'], 'a UPC-A: the EAN-13 and GTIN-14 forms too');
  assert.deepEqual(barcodeForms('0195166315386'), ['0195166315386', '195166315386', '00195166315386'], 'an EAN-13 with a leading 0: the UPC-A too');
  assert.deepEqual(barcodeForms('9300000000017'), ['9300000000017', '09300000000017'], 'an EAN-13 can only gain a 0 in front');
  assert.deepEqual(barcodeForms('12345670'), ['12345670', '000012345670', '0000012345670', '00000012345670'], 'an EAN-8');
  assert.deepEqual(barcodeForms('DGL34-001'), ['DGL34-001'], 'a shelf code is just itself');
  assert.deepEqual(barcodeForms('1234'), ['1234'], 'too short for a product barcode');
  assert.deepEqual(barcodeForms(''), []);
  assert.equal(sameBarcode('0195166315386', '195166315386'), true);
  assert.equal(sameBarcode('00195166315386', '195166315386'), true);
  assert.equal(sameBarcode('195166315387', '195166315386'), false);
  assert.equal(sameBarcode('dgl34-001', 'DGL34-001'), true, 'other codes ignore case');
  assert.equal(sameBarcode('DGL34-001', 'DGL34-0001'), false, 'but keep their zeros');
  assert.equal(sameBarcode('', ''), false);
});

test('barcodes (round 8): LairVariantByCode asks Shopify for every form of a barcode, and for the SKU as typed', async () => {
  const admin = new ShopifyAdmin({ SHOP: 'ep0qiq-rp.myshopify.com' });
  const asked = [];
  admin.graphql = async (query, variables) => {
    asked.push({ query, variables });
    return { productVariants: { nodes: [] } };
  };
  await admin.variantByCode('0195166315386');
  assert.equal(asked[0].variables.query, 'barcode:"0195166315386" OR barcode:"195166315386" OR barcode:"00195166315386" OR sku:"0195166315386"');
  assert.match(asked[0].query, /^query LairVariantByCode\(/, 'the operation keeps its name (the fake Admin API switches on it)');
  await admin.variantByCode('SNK-POCKY');
  assert.equal(asked[1].variables.query, 'barcode:"SNK-POCKY" OR sku:"SNK-POCKY"');
});

test('barcodes (round 8): the tab finds Mo\'s bundle whether the camera reads 195166315386 or 0195166315386', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  const stored = {
    variantId: '44556175933543', productId: '7001', handle: 'mtg-super-heroes', title: 'Bundle', productTitle: 'MTG - Super Heroes', sku: '', barcode: '195166315386',
    price: 12500, available: true, image: null, productImage: null, status: 'ACTIVE', giftCard: false, sellingPlan: false, libraryCode: null,
  };
  const calls = [];
  // Shopify matches a barcode exactly, so it only finds the bundle when one of the forms asked for is the one it keeps
  lair.shopify.variantByCode = async (code) => {
    calls.push(code);
    return barcodeForms(code).includes(stored.barcode) ? [stored] : [];
  };
  const lookup = (code) => call('GET', `tab/lookup?code=${encodeURIComponent(code)}`, null, '1001');
  const ean = await lookup('0195166315386');
  assert.equal(ean.status, 200, ean.data.error);
  assert.deepEqual([ean.data.item.variantId, ean.data.item.title, ean.data.item.variantTitle, ean.data.item.price, ean.data.item.barcode], ['44556175933543', 'MTG - Super Heroes', 'Bundle', 12500, '195166315386']);
  const upc = await lookup('195166315386');
  assert.equal(upc.data.item.variantId, '44556175933543', 'typed as it is in Shopify, as before');
  assert.equal((await lookup('195166315387')).status, 404, 'a different code is still unknown');
});

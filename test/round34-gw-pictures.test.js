// Round 34: GW's own pictures on the order pad's products, and those products online (contract v34-gw-pictures). Mo
// (10 Nov 2026): "please create a full product list with images and information for my customers to order". A pad
// product is on the till only until it shows GW's picture; then it goes on the Online Store and the Shop app.
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { PICTURE_LIMITS, pictureUrl, picturesFor } from '../src/gw-pictures.js';
import { GW_PICTURES } from '../src/gw-pictures-data.js';
import { callBudget } from '../src/shop-filters.js';

const realNow = Date.now;
const NOW = Date.UTC(2026, 10, 10, 9);
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

const ENV = { CURRENCY: 'NZD', GW_ONLINE_PUBLICATION_ID: '129866924135', GW_SHOP_PUBLICATION_ID: '129866956903' };
const ONLINE = 'gid://shopify/Publication/129866924135';
const SHOP = 'gid://shopify/Publication/129866956903';

// three kits, a paint range with two colours, from the real data file
const CODES = Object.keys(GW_PICTURES);
const KIT = CODES.find((c) => c.startsWith('9912010'));
const KIT2 = CODES.find((c) => c.startsWith('9912020'));
const HAD = CODES.find((c) => c.startsWith('9912011'));
const [RED, BLUE] = CODES.filter((c) => c.startsWith('99189961')).slice(0, 2);

let lair;
let pending;
let calls;
let shop; // sku → { productId, variantId, title, variants, productMedia, variantMedia }
let media; // productId → [{ id, status, url }]
let published; // productId → Set of publication ids
let fetchResult; // url → 'READY' | 'FAILED' | 'PROCESSING'

beforeEach(() => {
  globalThis.fetch = async (url) => {
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  pending = [];
  calls = [];
  published = new Map();
  media = new Map();
  fetchResult = {};
  let n = 0;
  shop = {
    [KIT]: { productId: 'gid://shopify/Product/1', variantId: 'gid://shopify/ProductVariant/11', title: 'Kit one', variants: 1, productMedia: 0, variantMedia: 0 },
    [KIT2]: { productId: 'gid://shopify/Product/2', variantId: 'gid://shopify/ProductVariant/21', title: 'Kit two', variants: 1, productMedia: 0, variantMedia: 0 },
    [HAD]: { productId: 'gid://shopify/Product/3', variantId: 'gid://shopify/ProductVariant/31', title: 'Kit with a picture', variants: 1, productMedia: 2, variantMedia: 0 },
    [RED]: { productId: 'gid://shopify/Product/9', variantId: 'gid://shopify/ProductVariant/91', title: 'Warhammer Pro Tone Paints', variants: 2, productMedia: 0, variantMedia: 0 },
    [BLUE]: { productId: 'gid://shopify/Product/9', variantId: 'gid://shopify/ProductVariant/92', title: 'Warhammer Pro Tone Paints', variants: 2, productMedia: 0, variantMedia: 0 },
  };
  lair = new Lair(fakeCtx(pending), ENV);
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  const addMedia = (productId, url) => {
    n += 1;
    const id = `gid://shopify/MediaImage/${n}`;
    if (!media.has(productId)) media.set(productId, []);
    media.get(productId).push({ id, url, status: 'UPLOADED' });
  };
  lair.shopify.gwPictureTargets = async (codes) => {
    calls.push(['find', codes.length]);
    return new Map(codes.filter((c) => shop[c]).map((c) => [c, shop[c]]));
  };
  lair.shopify.gwAddPictures = async (items) => {
    calls.push(['add', items.map((t) => t.productId)]);
    return items.map((t) => {
      for (const u of t.urls) addMedia(t.productId, u);
      return { productId: t.productId };
    });
  };
  lair.shopify.gwAddVariantPictures = async (productId, colours) => {
    calls.push(['colours', productId, colours.map((c) => c.variantId)]);
    for (const c of colours) addMedia(productId, c.url);
    return { productId };
  };
  lair.shopify.gwPictureStatus = async (ids) => {
    calls.push(['status', ids]);
    // Shopify has had time: each picture is as fetchResult says, READY by default
    for (const id of ids) for (const m of media.get(id) || []) m.status = fetchResult[m.url] || 'READY';
    return new Map(ids.map((id) => {
      const list = media.get(id) || [];
      return [id, { ready: list.filter((m) => m.status === 'READY').length, waiting: list.filter((m) => !['READY', 'FAILED'].includes(m.status)).length, failed: list.filter((m) => m.status === 'FAILED').map((m) => m.id) }];
    }));
  };
  lair.shopify.gwDeleteFiles = async (ids) => {
    calls.push(['delete', ids]);
    for (const [pid, list] of media) media.set(pid, list.filter((m) => !ids.includes(m.id)));
  };
  lair.shopify.gwPublish = async (ids, pub) => {
    calls.push(['publish', pub, ids]);
    return ids.map((id) => {
      if (!published.has(id)) published.set(id, new Set());
      published.get(id).add(pub);
      return { productId: id };
    });
  };
});
afterEach(() => {
  Date.now = realNow;
});

const run = (budget = callBudget()) => lair.gwPicturesUpkeep(Date.now(), budget);
const row = (code) => lair.sql.exec('SELECT * FROM gw_pictures WHERE code = ?', code).toArray()[0];
const allFound = async () => {
  // every code gets looked up, a slice at a time
  for (let i = 0; i < Math.ceil(CODES.length / PICTURE_LIMITS.find) + 2; i += 1) await run();
};

test('round 34: the data file: every code has at least one trade-site Resources path, and addresses are encoded', () => {
  assert.ok(CODES.length > 1500);
  for (const code of CODES) {
    assert.match(code, /^\d{8,13}$/);
    assert.ok(picturesFor(code).length >= 1 && picturesFor(code).length <= 4, code);
    for (const p of picturesFor(code)) assert.match(p, /^20\d\d\/\d\d\//);
  }
  assert.equal(pictureUrl('2025/02/BSF-89-07-99120209148-Gloomspite Gitz Moonclan Stabbas.jpg'),
    'https://trade.games-workshop.com/assets/2025/02/BSF-89-07-99120209148-Gloomspite%20Gitz%20Moonclan%20Stabbas.jpg');
  assert.deepEqual(picturesFor('not a code'), []);
});

test('round 34: products with no picture get GW\'s, a paint colour its pot on its variant, and once fetched they go online', async () => {
  await allFound();
  assert.equal(row(KIT).status, 'sent');
  assert.equal(row(RED).status, 'sent');
  assert.equal(row(RED).is_range, 1);
  assert.equal(row(HAD).status, 'had', 'a product that already shows a picture is left as it is');
  assert.equal(row(CODES.find((c) => !shop[c])).status, 'missing');
  assert.deepEqual(media.get('gid://shopify/Product/1').map((m) => m.url), picturesFor(KIT).map(pictureUrl));
  const colours = calls.find((c) => c[0] === 'colours');
  assert.deepEqual(colours.slice(1), ['gid://shopify/Product/9', ['gid://shopify/ProductVariant/91', 'gid://shopify/ProductVariant/92']]);
  assert.equal(published.size, 0, 'nothing goes online before Shopify has fetched the picture');
  // two minutes on, Shopify has fetched them: online and in the Shop app
  nowIs(NOW + PICTURE_LIMITS.checkAfter + 1000);
  const out = await run();
  assert.ok(out.live >= 3);
  for (const id of ['gid://shopify/Product/1', 'gid://shopify/Product/2', 'gid://shopify/Product/9']) assert.deepEqual([...published.get(id)].sort(), [ONLINE, SHOP].sort());
  assert.equal(published.has('gid://shopify/Product/3'), false);
  assert.equal(row(KIT).status, 'live');
  assert.equal(row(BLUE).status, 'live');
  // nothing left to do: the next run asks Shopify nothing
  calls = [];
  assert.equal(await run(), null);
  assert.deepEqual(calls, []);
  assert.deepEqual(lair.gwPicturesView().counts.live, 4);
});

test('round 34: a picture Shopify couldn\'t fetch is deleted and its product stays on the till', async () => {
  for (const u of picturesFor(KIT2).map(pictureUrl)) fetchResult[u] = 'FAILED';
  await allFound();
  nowIs(NOW + PICTURE_LIMITS.checkAfter + 1000);
  await run();
  assert.equal(row(KIT2).status, 'failed');
  assert.equal(published.has('gid://shopify/Product/2'), false);
  assert.ok(calls.some((c) => c[0] === 'delete'));
  assert.equal(media.get('gid://shopify/Product/2').length, 0);
  assert.deepEqual(lair.gwPicturesView().failed.map((f) => f.code), [KIT2]);
});

test('round 34: a code with no product yet is looked for again a day later', async () => {
  const code = CODES.find((c) => !shop[c]);
  await allFound();
  assert.equal(row(code).status, 'missing');
  shop[code] = { productId: 'gid://shopify/Product/5', variantId: 'gid://shopify/ProductVariant/51', title: 'New kit', variants: 1, productMedia: 0, variantMedia: 0 };
  nowIs(NOW + 60 * 60_000);
  await allFound();
  assert.equal(row(code).status, 'missing', 'not asked again within the day');
  nowIs(NOW + 25 * 60 * 60_000);
  await allFound();
  assert.equal(row(code).status, 'sent');
});

test('round 34: it stops when the invocation\'s calls run out, and does nothing without the channels set', async () => {
  const out = await run(callBudget(0, 0));
  assert.equal(calls.length, 0);
  assert.ok(out.left > 0);
  lair.env = { CURRENCY: 'NZD' };
  assert.equal(await run(), null);
});

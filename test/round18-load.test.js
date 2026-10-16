// Less work for the Lair (17 Oct 2026): on launch day the site's traffic used up the Cloudflare free plan's daily
// Durable Objects allowance and the Lair stopped answering. GET /me no longer writes on every load, only writes to what
// the floor is built from clear its cache, and Help me pick's catalogue sync writes only what changed, in full every
// 6 hours (not on every restart).
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const MIN = 60_000;
// Friday 16 October 2026, 1:00pm in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 9, 16, 0, 0);
const realNow = Date.now;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);

/** An in-memory Durable Object, counting every statement run */
function fakeCtx(log) {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      log.push(query.replace(/\s+/g, ' ').trim());
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
const OWNER = '9001';
const MIA = '6001';

let lair;
let log;
async function call(method, path, body, customer = '') {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  }));
  return { status: response.status, data: await response.json() };
}
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const writes = () => log.filter((q) => !/^(select|with)\b/i.test(q));
const floorReads = () => log.filter((q) => q.startsWith('SELECT * FROM bookings WHERE ends_at > ? AND starts_at < ?')).length;
const board = (who = '') => call('GET', `floor?from=${at('2026-10-16', 0)}&to=${at('2026-10-18', 0)}`, null, who);

const realFetch = globalThis.fetch;
let reached = [];
beforeEach(() => {
  reached = [];
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  Date.now = () => NOW;
  log = [];
  lair = new Lair(fakeCtx(log), { CURRENCY: 'NZD' });
  lair.later = (promise) => Promise.resolve(promise).catch(() => {});
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  Object.defineProperty(lair.shopify, 'configured', { get: () => false, configurable: true });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  lair.makeMember({ customerId: MIA, name: 'Mia Chen', email: 'mia@example.com' }, NOW);
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

test('load: GET /me writes nothing when nothing has changed in the last 15 minutes, then keeps last seen', async () => {
  ok(await call('GET', 'me', null, MIA));
  log.length = 0;
  ok(await call('GET', 'me', null, MIA));
  assert.deepEqual(writes(), [], 'a second look straight after writes nothing');
  Date.now = () => NOW + 10 * MIN;
  ok(await call('GET', 'me', null, MIA));
  assert.deepEqual(writes(), [], 'nor 10 minutes later');
  // 16 minutes on, their last seen moves on
  Date.now = () => NOW + 16 * MIN;
  ok(await call('GET', 'me', null, MIA));
  assert.ok(writes().some((q) => q.startsWith('INSERT INTO members')), 'last seen is written again');
  assert.equal(lair.memberRow(MIA).last_seen, NOW + 16 * MIN);
  // a name it doesn't have yet is still filled in straight away
  lair.sql.exec('UPDATE members SET name = NULL WHERE customer_id = ?', MIA);
  log.length = 0;
  ok(await call('GET', 'me?name=Mia%20Chen', null, MIA));
  assert.equal(lair.memberRow(MIA).name, 'Mia Chen');
});

test('load: the floor keeps its cached state through a member opening My Lair, and a booking still shows straight away', async () => {
  ok(await board());
  assert.equal(floorReads(), 1);
  ok(await board());
  assert.equal(floorReads(), 1, 'the second look comes from the cache');
  // a member opening My Lair (their last seen moves on, 20 minutes after they were last seen) doesn't clear it
  Date.now = () => NOW + 20 * MIN;
  ok(await board());
  assert.equal(floorReads(), 2, 'a minute on, the cache has run out');
  ok(await call('GET', 'me', null, MIA));
  assert.ok(writes().some((q) => q.startsWith('INSERT INTO members')));
  Date.now = () => NOW + 20 * MIN + 30_000;
  ok(await board());
  assert.equal(floorReads(), 2, 'still from the cache');
  // a booking clears it: the next look shows it
  const booked = ok(await call('POST', 'bookings', {
    kind: 'table', tables: ['T3'], start: at('2026-10-16', 18), end: at('2026-10-16', 20), people: 2, name: 'Mia Chen', email: 'mia@example.com', phone: '021 555 0100',
  }, MIA)).booking;
  const before = floorReads();
  const after = ok(await board());
  assert.equal(floorReads(), before + 1, 'read again');
  assert.ok(after.bookings.some((b) => b.id === booked.id), 'the new booking is on the floor');
  // and the cache still ends after a minute, whatever happens
  Date.now = () => NOW + 22 * MIN;
  ok(await board());
  assert.equal(floorReads(), before + 2);
});

/** A library product as Shopify's LairPickCatalog gives it */
const product = (id, title, over = {}) => ({
  id: `gid://shopify/Product/${id}`, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title: `${title} (Library)`, status: 'ACTIVE', tags: ['Board Game Rental'],
  vendor: 'Test Games', createdAt: new Date(NOW - 400 * 24 * HOUR).toISOString(), updatedAt: new Date(NOW - 24 * HOUR).toISOString(),
  descriptionHtml: `<p>${title} is a board game.</p>`, featuredMedia: { preview: { image: { url: `https://cdn.shopify.com/s/files/1/${id}.png` } } },
  variants: { nodes: [{ id: `gid://shopify/ProductVariant/${Number(id) + 1000000}`, inventoryQuantity: 1, inventoryItem: { tracked: true } }] },
  libraryCode: { value: 'DGL34-M011' }, players: { value: '2–4' }, playTime: { value: '30 min' }, difficulty: { value: 'Medium' },
  missingPieces: null, missingNote: null, blurb: { value: `Borrow ${title} at Dice Goblin.` }, shopCopy: null, ...over,
});
const forSale = (id, title, over = {}) => ({
  id: `gid://shopify/Product/${id}`, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title, priceRangeV2: { minVariantPrice: { amount: '70.0' } },
  totalInventory: 2, variants: { nodes: [{ availableForSale: true }] }, featuredMedia: { preview: { image: { url: `https://cdn.shopify.com/s/files/1/${id}.png` } } }, ...over,
});
const catalogWrites = () => writes().filter((q) => /pick_catalog|pick_shop/.test(q));

test('load: a catalogue sync writes only the listings and shop copies that changed', async () => {
  const library = [product('8100000000001', 'Catan'), product('8100000000002', 'Azul'), product('8100000000003', 'Uno')];
  const shop = [forSale('9100000000001', 'Catan (5th Edition)'), forSale('9100000000002', 'Azul')];
  lair.saveCatalog(library, shop, { full: true, now: NOW });
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM pick_catalog WHERE status = 'active'").one().n, 3);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM pick_shop').one().n, 2);

  // the same again: nothing written
  log.length = 0;
  const same = lair.saveCatalog(library, shop, { full: true, now: NOW + HOUR });
  assert.deepEqual([same.synced, same.added, same.gone, same.shop], [3, 0, 0, 2]);
  assert.deepEqual(catalogWrites(), [], 'nothing changed, nothing written');

  // Azul's copies change, Uno's gone, a for-sale Azul sold out and a new for-sale game: only those are written
  log.length = 0;
  const azul = product('8100000000002', 'Azul', { variants: { nodes: [{ id: 'gid://shopify/ProductVariant/8101000000002', inventoryQuantity: 2, inventoryItem: { tracked: true } }] } });
  const next = lair.saveCatalog([library[0], azul], [shop[0], forSale('9100000000003', 'Wingspan')], { full: true, now: NOW + 2 * HOUR });
  assert.deepEqual([next.synced, next.added, next.gone, next.shop], [2, 0, 1, 2]);
  const written = catalogWrites();
  assert.equal(written.filter((q) => q.startsWith('INSERT INTO pick_catalog')).length, 1, 'only Azul');
  assert.equal(written.filter((q) => q.startsWith("UPDATE pick_catalog SET status = 'gone'")).length, 1, 'Uno, gone');
  assert.equal(written.filter((q) => q.startsWith('INSERT OR REPLACE INTO pick_shop')).length, 1, 'only Wingspan');
  assert.equal(written.filter((q) => q.startsWith('DELETE FROM pick_shop WHERE product_id = ?')).length, 1, 'the sold out Azul');
  assert.equal(lair.sql.exec('SELECT copies FROM pick_catalog WHERE product_id = ?', '8100000000002').one().copies, 2);
  assert.deepEqual(lair.sql.exec('SELECT product_id FROM pick_shop ORDER BY product_id').toArray().map((r) => r.product_id), ['9100000000001', '9100000000003']);
  // a listing that was gone and is back is written again, even when nothing else changed
  log.length = 0;
  lair.saveCatalog(library, null, { full: true, now: NOW + 3 * HOUR });
  assert.equal(lair.sql.exec('SELECT status FROM pick_catalog WHERE product_id = ?', '8100000000003').one().status, 'active');
});

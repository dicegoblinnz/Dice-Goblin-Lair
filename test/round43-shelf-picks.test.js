// Round 43: the d20 roller's shelf list (contract v43-shelf-picks). Mo, 17 Nov 2026: "the home page d20 roller should
// only pick things on the shelf right now (stock above 0). No ordered-in Warhammer, pre-orders or dropshipped dice."
// Each check is named in the contract's own words (docs/contracts/lair-api-contract-v43-shelf-picks.md).
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { externalCalls, shelfRowOf } from '../src/shopify.js';
import { SHELF, shelfSkips } from '../src/shelf-picks.js';

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 17, 2, 0); // Tuesday 17 November 2026, 3pm in Auckland
const realNow = Date.now;
const realFetch = globalThis.fetch;
let clock;

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
  const storage = { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) };
  storage.getAlarm = async () => alarmAt;
  storage.setAlarm = async (at) => {
    alarmAt = at;
  };
  return { storage, waitUntil: (p) => pending.push(p) };
}

const ENV = { CURRENCY: 'NZD', SHOP: 'ep0qiq-rp.myshopify.com' };
const LOCATION = 'gid://shopify/Location/72250359911'; // the shop, "Dice Goblin"

/* ---------------- a pretend Shopify: variants as the LairShelf query answers them ---------------- */
/** A variant node: shop is its "available" count at the shop's location (null: not stocked there) */
function node(id, title, o = {}) {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    price: o.price ?? '59.99',
    inventoryItem: {
      tracked: o.tracked !== false,
      inventoryLevel: o.shop === null ? null : { quantities: [{ name: 'available', quantity: o.shop ?? 3 }] },
    },
    product: {
      id: `gid://shopify/Product/${o.productId || Number(id) + 5000}`,
      handle: o.handle || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      title,
      productType: o.type || 'Board Games',
      tags: o.tags || [],
      isGiftCard: o.giftCard === true,
      status: o.status || 'ACTIVE',
      onlineStoreUrl: o.online === false ? null : `https://www.dicegoblin.nz/products/${id}`,
    },
  };
}

const NODES = () => [
  node(101, 'Catan', { shop: 4 }),
  node(102, 'Wingspan', { shop: 1 }),
  // Dragon Shield sleeves: Jet on the shelf, Crimson sold out
  node(103, 'Dragon Shield Matte Sleeves', { productId: 7000, handle: 'dragon-shield-matte-sleeves', shop: 6 }),
  node(104, 'Dragon Shield Matte Sleeves', { productId: 7000, handle: 'dragon-shield-matte-sleeves', shop: 0 }),
  // a dropshipped dice set: 0 at the shop (its 100 are at the dice maker's)
  node(105, 'Petalskein Dice Set', { shop: 0, type: 'Dice & Accessories' }),
  // a dice set that's on the shelf too
  node(106, 'Hexwhelp Dice Set', { shop: 2, type: 'Dice & Accessories' }),
  // Games Workshop: ordered in (sells at 0, so below it once ordered), and a kit that's on the shelf
  node(107, 'Combat Patrol: Space Marines', { shop: -2, type: 'Warhammer' }),
  node(108, 'Kill Team: Starter Set', { shop: 1, type: 'Warhammer' }),
  // a pre-order: nothing in yet
  node(109, 'Pokémon Mega Evolution Elite Trainer Box', { shop: 0 }),
  // not counted, a library copy, a gift card, a draft, one off the Online Store, a hidden prize, a $0 thing, a membership
  node(110, 'Session pass', { tracked: false }),
  node(111, 'Catan (Library)', { shop: 1, tags: ['Board Game Rental'] }),
  node(112, 'Dice Goblin gift card', { giftCard: true, shop: 5 }),
  node(113, 'Root', { status: 'DRAFT', shop: 2 }),
  node(114, 'Counter-only Snack', { online: false, shop: 20 }),
  node(115, 'Dice chest prize', { tags: ['dice-chest-prize'], shop: 3 }),
  node(116, 'Free bookmark', { price: '0.00', shop: 30 }),
  node(117, 'Board Game Rental Membership', { shop: 5 }),
  // stocked only somewhere else
  node(118, 'Supplier Sample Box', { shop: null }),
];
// the products the roller may land on, and each one's variants on the shelf
const ON_SHELF = { 5101: ['101'], 5102: ['102'], 7000: ['103'], 5106: ['106'], 5108: ['108'] };

let pending;
let lair;
let pages; // the pages Shopify answers, each a list of nodes
let asked; // every page asked for: its cursor
let trouble; // { fail: n (the next n pages fail), throttle: n }
let waits;
let alarmAt; // the Durable Object's alarm

const settle = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};
async function pick(not) {
  clock += 1;
  const res = await lair.fetch(new Request(`https://lair.test/shelf/pick${not ? `?not=${not}` : ''}`, { method: 'GET', headers: { 'Content-Type': 'application/json' } }));
  const data = await res.json();
  assert.equal(res.status, 200, data.error);
  await settle();
  return data;
}
const later = (ms) => {
  clock += ms;
};

beforeEach(() => {
  clock = NOW;
  Date.now = () => clock;
  globalThis.fetch = async (url) => {
    throw new Error(`No network in tests: ${url}`);
  };
  pending = [];
  asked = [];
  trouble = {};
  waits = [];
  alarmAt = null;
  const all = NODES();
  pages = [all.slice(0, 7), all.slice(7, 14), all.slice(14)];
  lair = new Lair(fakeCtx(pending), ENV);
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.wait = async (ms) => {
    waits.push(ms);
  };
  lair.shopify.shelfPage = async (cursor, location) => {
    assert.equal(location, LOCATION);
    externalCalls.count += 1;
    asked.push(cursor);
    if (trouble.throttle) {
      trouble.throttle -= 1;
      throw Object.assign(new Error('Shopify API: Throttled'), { throttled: true, cost: { requestedQueryCost: 752, throttleStatus: { currentlyAvailable: 200, restoreRate: 100 } } });
    }
    if (trouble.fail) {
      trouble.fail -= 1;
      throw new Error('Shopify is having a moment');
    }
    const i = cursor ? Number(cursor.slice(1)) : 0;
    const nodes = pages[i] || [];
    return { rows: nodes.map(shelfRowOf).filter(Boolean), seen: nodes.length, next: i + 1 < pages.length ? `p${i + 1}` : null };
  };
});

afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
});

/* ---------------- what counts as on the shelf ---------------- */
test('only what is counted, free to sell at the shop, priced, and sold on the Online Store is on the shelf', () => {
  const rows = NODES().map(shelfRowOf).filter(Boolean);
  const by = {};
  for (const r of rows) (by[r.productId] ||= []).push(r.variantId);
  assert.deepEqual(by, ON_SHELF);
  assert.deepEqual(shelfRowOf(NODES()[0]), { productId: '5101', handle: 'catan', variantId: '101', stock: 4 });
});

test('dropshipped dice, ordered-in Games Workshop and pre-orders are never on the shelf', () => {
  const names = NODES().filter((n) => shelfRowOf(n)).map((n) => n.product.title);
  for (const never of ['Petalskein Dice Set', 'Combat Patrol: Space Marines', 'Pokémon Mega Evolution Elite Trainer Box']) assert.ok(!names.includes(never), never);
  for (const ok of ['Hexwhelp Dice Set', 'Kill Team: Starter Set']) assert.ok(names.includes(ok), ok);
});

test('the products to skip are numbers only, at most ten', () => {
  const url = new URL('https://x/shelf/pick?not=1,2,abc,3%2C4,,5,6,7,8,9,10,11,12');
  assert.deepEqual([...shelfSkips(url)], ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  assert.equal(shelfSkips(new URL('https://x/shelf/pick')).size, 0);
});

/* ---------------- picks ---------------- */
test('with no list yet there is no pick, and a read starts; once read, picks come from the shelf list', async () => {
  const first = await pick();
  assert.deepEqual(first, { pick: null, count: 0, at: null });
  assert.equal(asked.length, 3, 'every page read');
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const { pick: p, count, at } = await pick();
    assert.equal(count, 5);
    assert.equal(at, new Date(NOW + 1).toISOString());
    assert.deepEqual(p.variants, ON_SHELF[p.productId], 'only its variants on the shelf');
    seen.add(p.productId);
  }
  assert.deepEqual([...seen].sort(), Object.keys(ON_SHELF).sort(), 'every product on the shelf can come up');
  assert.equal(asked.length, 3, 'a fresh list is not read again');
});

test('a pick skips the products asked, and gives none when nothing else is left', async () => {
  await pick();
  for (let i = 0; i < 50; i += 1) {
    const { pick: p } = await pick('5101,7000,5106');
    assert.ok(['5102', '5108'].includes(p.productId), p.productId);
  }
  assert.equal((await pick('5101,5102,7000,5106,5108')).pick, null);
});

test('a list older than 20 minutes still answers, and is read again in the background', async () => {
  await pick();
  pages[0] = pages[0].filter((n) => n.product.title !== 'Catan');
  later(SHELF.fresh + MIN);
  const stale = await pick('5102,7000,5106,5108');
  assert.equal(stale.pick.productId, '5101', 'answered from the list it had');
  assert.equal(asked.length, 6, 'read again');
  assert.equal((await pick('5102,7000,5106,5108')).pick, null, 'the new list has Catan gone');
});

test('a list older than two hours is not picked from', async () => {
  await pick();
  trouble.fail = 99;
  later(SHELF.usable + MIN);
  const res = await pick();
  assert.equal(res.pick, null);
  assert.equal(res.count, 0);
});

test('a read that fails keeps the old list, and waits five minutes before the next', async () => {
  await pick();
  later(SHELF.fresh + MIN);
  trouble.fail = 1;
  const res = await pick();
  assert.ok(res.pick, 'the old list still answers');
  assert.equal(asked.length, 4);
  later(MIN);
  await pick();
  assert.equal(asked.length, 4, 'not again within five minutes');
  later(SHELF.retry);
  await pick();
  assert.equal(asked.length, 7, 'tried again, carrying on from scratch');
  assert.equal(lair.shelfRun('next').error, null);
});

test('a throttled page waits for Shopify\'s bucket and asks again', async () => {
  trouble.throttle = 1;
  await pick();
  assert.equal(asked.length, 4);
  assert.ok(waits.includes(5770), `waited ${waits}`);
  assert.equal((await pick()).count, 5);
});

test('a read that runs out of calls stops part-way, never shows half a list, and carries on with the next pick', async () => {
  // thirty pages: more than one invocation's calls (each keeps room for a login)
  const all = NODES();
  pages = Array.from({ length: 30 }, (_, i) => (i === 29 ? all : []));
  await pick();
  assert.equal(asked.length, SHELF.callsPerRun - 1);
  assert.equal(lair.shelfCount('live'), 0);
  assert.equal((await pick()).pick, null, 'no list yet');
  assert.equal(asked.length, 30, 'carried on from where it stopped');
  assert.equal(asked[SHELF.callsPerRun - 1], `p${SHELF.callsPerRun - 1}`);
  assert.equal((await pick()).count, 5);
});

test('anyone can pick, logged in or not, and nobody is looked up', async () => {
  let looked = 0;
  lair.person = async () => {
    looked += 1;
    return null;
  };
  await pick();
  assert.equal((await pick()).count, 5);
  assert.equal(looked, 0);
});

/* ---------------- kept fresh by the alarm ---------------- */
test('the 10-minute run wakes the alarm when the list is due, and the alarm reads it before anyone rolls', async () => {
  lair.shelfKeepWarm(clock);
  await settle();
  assert.equal(alarmAt, NOW + SHELF.warmWait, 'no list yet: due');
  clock = alarmAt;
  await lair.alarm();
  await settle();
  assert.equal(asked.length, 3);
  const first = await pick();
  assert.equal(first.count, 5, 'the first roll finds a list');
  assert.ok(first.pick);
  assert.equal(asked.length, 3, 'a fresh list is not read again');
});

test('a fresh list leaves the alarm alone; a list older than 20 minutes wakes it', async () => {
  await pick();
  alarmAt = null;
  lair.alarmAt = undefined;
  later(10 * MIN);
  lair.shelfKeepWarm(clock);
  await settle();
  assert.equal(alarmAt, null);
  later(SHELF.fresh);
  lair.shelfKeepWarm(clock);
  await settle();
  assert.equal(alarmAt, clock + SHELF.warmWait);
});

test("the alarm's read stops within its calls and comes back a minute later to finish", async () => {
  const all = NODES();
  pages = Array.from({ length: 60 }, (_, i) => (i === 59 ? all : []));
  await lair.alarm();
  await settle();
  assert.equal(asked.length, SHELF.alarmCalls - 1);
  assert.equal(lair.shelfCount('live'), 0);
  assert.equal(alarmAt, clock + MIN, 'back in a minute');
  clock = alarmAt;
  await lair.alarm();
  await settle();
  assert.equal(asked.length, 60);
  assert.equal(lair.shelfCount('live'), 5);
});

test('the alarm does nothing while a failed read waits its five minutes', async () => {
  trouble.fail = 1;
  await lair.alarm();
  await settle();
  assert.equal(asked.length, 1);
  later(MIN);
  await lair.alarm();
  assert.equal(asked.length, 1);
  later(SHELF.retry);
  await lair.alarm();
  await settle();
  assert.equal(asked.length, 4);
});

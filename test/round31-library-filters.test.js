// Round 31 (6 Nov 2026, contract v31-library-filters): filters on the library shelves and the shop's board games.
// Mo approved them on 6 Nov 2026: Players, Play time, Youngest player, Weight, How you play and On the shelf now, with
// Library discovery's numbers copied into Shopify and staff able to correct any game. The product metafields were made
// in Shopify that day (all empty); their choices below are as the Admin API gave them on 6 Nov 2026.
//  - custom.plays_with: every count the game plays ("8+ players" when it plays 8 or more).
//  - custom.play_time_band: each band its usual length touches (Under 30 is below 30; 30 to 60 includes both ends; 1 to
//    2 hours is over 60 to 120; 2 hours plus is over 120). Per-chapter times count per chapter.
//  - custom.suits_age: the ages a child can be to play it (a game for 7+ gets Age 8, 10, 12, 14; for 15+ none).
//  - custom.how_you_play: its mode, plus Solo when it plays with one person.
//  - custom.on_shelf: kept by the Lair: true when at least one copy is free now (copies less active holds less loans
//    out, as GET /library/status counts them), In Store Only games too.
//  - Weight is the existing custom.difficulty: filled only where it's empty, from the facts' weight, with cut-offs that
//    agree best with the games that already have one; a set one is never overwritten.
// Library games (active, kind game or expansion) take them from their live facts; the shop's board games from their
// library twin's facts, else from their own players and play time text, age group and tags, leaving a field empty
// rather than guessing. GET /library/status says who the soonest hold is for (heldFor: 'table' | 'member').
// Run with: node --test test/
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings } from '../src/core.js';
import { PICK_DATA } from '../src/pick.js';
import { externalCalls } from '../src/shopify.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Monday 9 November 2026, 4:30pm in Auckland (NZDT), just after the Lair opens
const NOW = at('2026-11-09', 16, 30);
const realNow = Date.now;
let clock = NOW;

/* ---------------- the Lair, with Durable Object alarms ---------------- */
function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      // as SQLite in a Durable Object: at most 100 bound values a query and 5 terms in a compound SELECT (test/cloudflare-sql.js)
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
  // a Durable Object has one alarm: setting it again moves it
  const alarm = { at: null };
  return {
    alarm,
    storage: {
      sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k),
      setAlarm: async (when) => { alarm.at = Number(when); }, getAlarm: async () => alarm.at, deleteAlarm: async () => { alarm.at = null; },
    },
    waitUntil: () => {},
  };
}

// Members; the owner; helpers with and without the library permission
const SAM = '1001';
const KIRI = '1002';
const STAFF = 'staff';
const HELPER = '2001';
const LIBRARIAN = '2002';
const PERSON = {
  [STAFF]: { staff: true, role: 'owner', perms: [] },
  [HELPER]: { staff: true, role: 'helper', perms: ['checkin', 'tables'] },
  [LIBRARIAN]: { staff: true, role: 'helper', perms: ['library'] },
};

let lair;
let ctx;
/** Pending promises (an alarm being set) settle: what happens between one request and the next */
const settle = () => new Promise((resolve) => {
  setImmediate(resolve);
});
/**
 * One invocation (a request to the Lair, or its alarm): Cloudflare's free plan lets it make at most 50 outside calls
 * (Shopify's among them, src/shopify.js's externalCalls). Every invocation in these tests is held to that, and the calls
 * each made are kept (invocations).
 */
const FREE_PLAN_CALLS = 50;
let invocations = [];
async function invoke(run) {
  const start = externalCalls.count;
  try {
    return await run();
  } finally {
    await settle();
    const used = externalCalls.count - start;
    invocations.push(used);
    assert.ok(used <= FREE_PLAN_CALLS, `one invocation made ${used} outside calls; Cloudflare's free plan allows ${FREE_PLAN_CALLS}`);
  }
}
async function call(method, path, body, customer = '', extraHeaders = {}) {
  return invoke(async () => {
    const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    }));
    return { status: response.status, data: await response.json() };
  });
}
const internal = (path, body = {}) => call('POST', `internal/${path}`, body, '', { 'X-Lair-Internal': '1' });
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();

/* ---------------- Shopify, as the filters see it ---------------- */
const gid = (type, id) => `gid://shopify/${type}/${id}`;
const digits = (value) => String(value ?? '').split('/').pop();
// The definitions as the Admin API gave them on 6 Nov 2026: Shopify turns away a value outside the choices, a list
// that's empty, the wrong type, and more than 25 metafields in one metafieldsSet
const DEFINITIONS = {
  'custom.plays_with': { type: 'list.single_line_text_field', choices: ['1 player', '2 players', '3 players', '4 players', '5 players', '6 players', '7 players', '8+ players'] },
  'custom.play_time_band': { type: 'list.single_line_text_field', choices: ['Under 30 min', '30 to 60 min', '1 to 2 hours', '2 hours plus'] },
  'custom.suits_age': { type: 'list.single_line_text_field', choices: ['Age 4', 'Age 6', 'Age 8', 'Age 10', 'Age 12', 'Age 14'] },
  'custom.how_you_play': { type: 'list.single_line_text_field', choices: ['Co-op', 'Competitive', 'Team', 'Solo'] },
  'custom.on_shelf': { type: 'boolean' },
  'custom.difficulty': { type: 'single_line_text_field', choices: ['Easy', 'Medium', 'Hard'] },
};
// The store's age groups (shopify--recommended-age-group entries), as the category metafield points to them
const AGE_GROUPS = {
  [gid('Metaobject', 9001)]: '6 years or older', [gid('Metaobject', 9002)]: '8 years or older', [gid('Metaobject', 9003)]: '10 years or older',
  [gid('Metaobject', 9004)]: 'Teens', [gid('Metaobject', 9005)]: '18 years or older', [gid('Metaobject', 9006)]: 'All ages',
};
const ageGroup = (label) => Object.keys(AGE_GROUPS).find((key) => AGE_GROUPS[key] === label);

/**
 * A pretend Shopify store: products by id (each { id, title, handle, productType, tags, requiresSellingPlan, mf: {
 * 'namespace.key': value } }), the calls made to it, and fail(name) to make a call fail (Shopify down). It answers
 * what the Lair asks by the query's own aliases, so it never depends on how the Lair names them.
 */
let shop;
function useShopify(store = null) {
  // afterRead: something to happen in Shopify just after the Lair reads products (a librarian saving in Shopify admin)
  shop = store || { products: new Map(), calls: [], fail: () => false, afterRead: null };
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  lair.shopify.wait = async () => {};
  lair.shopify.graphql = async (query, variables = {}) => {
    // each is one request outside Cloudflare, as the real one's fetch is
    externalCalls.count += 1;
    const name = query.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1] || '';
    shop.calls.push({ name, variables: JSON.parse(JSON.stringify(variables)) });
    if (shop.fail(name)) throw new Error('Shopify API error 503');
    if (name === 'LairFilterProducts' && shop.afterRead) queueMicrotask(() => shop.afterRead?.());
    if (name === 'VariantCopies') {
      return { nodes: variables.ids.map((id) => {
        const p = [...shop.products.values()].find((x) => x.variantId === digits(id));
        return p ? { id, inventoryQuantity: p.copies ?? 1, inventoryItem: { tracked: true }, product: { tags: p.tags } } : null;
      }) };
    }
    if (/^\s*query/.test(query) && /nodes\(ids:/.test(query)) {
      assert.ok(variables.ids.length <= 50, `at most 50 products a read (asked for ${variables.ids.length})`);
      const fields = [...query.matchAll(/(\w+):\s*metafield\(namespace:\s*"([^"]+)",\s*key:\s*"([^"]+)"\)/g)].map((m) => ({ alias: m[1], key: `${m[2]}.${m[3]}` }));
      return {
        nodes: variables.ids.map((id) => {
          if (AGE_GROUPS[id]) return { id, handle: AGE_GROUPS[id].toLowerCase().replace(/\W+/g, '-'), label: { value: AGE_GROUPS[id] } };
          const p = shop.products.get(digits(id));
          if (!p) return null;
          const node = {
            id, title: p.title, handle: p.handle, status: 'ACTIVE', productType: p.productType || 'Board Games', tags: p.tags || [],
            requiresSellingPlan: Boolean(p.requiresSellingPlan), isGiftCard: false,
          };
          for (const f of fields) node[f.alias] = p.mf[f.key] == null ? null : { value: p.mf[f.key], compareDigest: `digest:${p.mf[f.key]}` };
          return node;
        }),
      };
    }
    if (name === 'LairFilterSet') {
      const list = variables.metafields;
      if (list.length > 25) throw new Error(`Shopify API: The input array size of ${list.length} is greater than the maximum allowed of 25.`);
      const userErrors = [];
      list.forEach((m, i) => {
        const def = DEFINITIONS[`${m.namespace}.${m.key}`];
        const p = shop.products.get(digits(m.ownerId));
        const bad = (message) => userErrors.push({ field: ['metafields', String(i), 'value'], message, code: 'INVALID' });
        if (!def || !p) return bad('Owner or definition not found');
        if (m.type !== def.type) return bad('Type mismatch');
        if (def.type === 'boolean') return ['true', 'false'].includes(m.value) ? null : bad('Value is invalid for type');
        if (def.type.startsWith('list.')) {
          const values = JSON.parse(m.value);
          if (!Array.isArray(values) || !values.length) return bad("Value can't be blank");
          if (!values.every((v) => def.choices.includes(v)) || new Set(values).size !== values.length) return bad('Validation failed');
        } else if (!def.choices.includes(m.value)) return bad('Validation failed');
        if (Object.hasOwn(m, 'compareDigest') && m.compareDigest === null && p.mf[`${m.namespace}.${m.key}`] != null) {
          userErrors.push({ field: ['metafields', String(i)], message: 'The metafield has been changed since it was read.', code: 'STALE_OBJECT' });
        }
        return null;
      });
      // atomic, as Shopify's metafieldsSet is: nothing is saved when anything's wrong
      if (!userErrors.length) for (const m of list) shop.products.get(digits(m.ownerId)).mf[`${m.namespace}.${m.key}`] = m.value;
      return { metafieldsSet: { metafields: userErrors.length ? [] : list.map((m, i) => ({ id: gid('Metafield', i + 1) })), userErrors } };
    }
    if (name === 'LairFilterDelete') {
      const list = variables.metafields;
      if (list.length > 25) throw new Error('Shopify API: too many metafields in one call');
      for (const m of list) delete shop.products.get(digits(m.ownerId))?.mf[`${m.namespace}.${m.key}`];
      return { metafieldsDelete: { deletedMetafields: list.map((m) => ({ ownerId: m.ownerId, namespace: m.namespace, key: m.key })), userErrors: [] } };
    }
    throw new Error(`Not part of this test: ${name}`);
  };
}
/** What Shopify has in a filter field now: a list, true/false for on_shelf, the difficulty's text, or null */
const mf = (productId, key) => {
  const value = shop.products.get(productId)?.mf[`custom.${key}`];
  if (value == null) return null;
  if (key === 'on_shelf') return value === 'true';
  return DEFINITIONS[`custom.${key}`].type.startsWith('list.') ? JSON.parse(value) : value;
};
/** Every filter field of a product: [plays_with, play_time_band, suits_age, how_you_play] */
const filtersOf = (productId) => ['plays_with', 'play_time_band', 'suits_age', 'how_you_play'].map((k) => mf(productId, k));
const writes = (name = 'LairFilterSet') => shop.calls.filter((c) => c.name === name);
const written = (productId) => writes().flatMap((c) => c.variables.metafields).filter((m) => digits(m.ownerId) === productId).map((m) => m.key);

/* ---------------- the library and the shop ---------------- */
/** A facts object (Library discovery's, contract v17 1.2) with sensible defaults */
const facts = (over = {}) => ({
  kind: 'game', players: { min: 2, max: 4, best: [3] }, time: { min: 30, max: 45 }, weight: 2.0, age: 8, mode: 'competitive', vibes: ['thinky'],
  themes: ['abstract'], styles: ['set-collection'], reading: 'some', access: { colourBlind: null, easyPieces: null }, table: 'single', expansionOf: null,
  rpg: null, summary: 'A game from the test library with a plain summary.', confidence: 'medium', ...over,
});
let codes = 0;
/**
 * A library game: { id, title, facts (null: none in the seed, so the Lair makes basic facts from its listing), copies,
 * tags, players, playTime, ages (age group labels), difficulty, shopCopy (a shop product's id), onShelf (Shopify's
 * on_shelf now) }
 */
const libraryGame = (g) => {
  codes += 1;
  return { variantId: String(Number(g.id) + 5000000), code: `DGL34-M${String(codes).padStart(3, '0')}`, copies: 1, tags: [], ...g, library: true };
};
/** A for-sale board game: { id, title, tags, players, playTime, ages, difficulty, libraryCopy, sellingPlan } */
const shopGame = (g) => ({ tags: [], ...g, library: false });

/** A copy of the Lair on ctx (a new one is what Cloudflare starts after an eviction), with Shopify's store kept */
function lairOn(store = null) {
  lair = new Lair(ctx, { CURRENCY: 'NZD', SHOP: 'ep0qiq-rp.myshopify.com', MEMBERSHIPS_SIMPLEE_TAGS: 'off' });
  lair.person = async (id) => ({ customerId: id || null, staff: false, gm: false, tags: [], role: null, perms: [], ...(PERSON[id] || {}) });
  lair.rulesCache = rulesFromSettings({}, [], []);
  lair.rulesLoadedAt = NOW + 365 * DAY;
  useShopify(store);
}
/** The Lair restarts (evicted, then woken again): its memory's gone, its storage and its alarm are as they were */
const restart = () => lairOn(shop);

/** Everything in place: the seed (facts) before the Lair starts, the catalogue as a full sync saves it, and the store */
function start({ library = [], forSale = [] } = {}) {
  PICK_DATA.seed = Object.fromEntries(library.filter((g) => g.facts).map((g) => [g.id, g.facts]));
  PICK_DATA.seedVersion = `test-${Math.random()}`;
  ctx = fakeCtx();
  lairOn();
  const handleOf = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const catalogueNode = (g) => ({
    id: gid('Product', g.id), handle: `${handleOf(g.title)}-library`, title: `${g.title} (Library)`, status: 'ACTIVE', tags: ['Board Game Rental', ...g.tags],
    vendor: 'Test Games', createdAt: new Date(NOW - 400 * DAY).toISOString(), updatedAt: new Date(NOW - DAY).toISOString(), descriptionHtml: `<p>${g.title}</p>`,
    featuredMedia: null, variants: { nodes: [{ id: gid('ProductVariant', g.variantId), inventoryQuantity: g.copies, inventoryItem: { tracked: true } }] },
    libraryCode: { value: g.code }, players: g.players ? { value: g.players } : null, playTime: g.playTime ? { value: g.playTime } : null,
    difficulty: g.difficulty ? { value: g.difficulty } : null, missingPieces: null, missingNote: null, blurb: null,
    shopCopy: g.shopCopy ? { reference: { id: gid('Product', g.shopCopy), handle: 'shop-copy', title: 'Shop copy', status: 'ACTIVE', totalInventory: 2, tracksInventory: true, priceRangeV2: { minVariantPrice: { amount: '60.0' } }, featuredMedia: null } } : null,
  });
  const shopNode = (g) => ({
    id: gid('Product', g.id), handle: handleOf(g.title), title: g.title, status: 'ACTIVE', totalInventory: 2, tracksInventory: true, featuredMedia: null,
    priceRangeV2: { minVariantPrice: { amount: '60.0' } }, variants: { nodes: [{ availableForSale: true }] },
  });
  lair.saveCatalog(library.map(catalogueNode), forSale.length ? forSale.map(shopNode) : null, { full: true, now: Date.now() });
  for (const g of [...library, ...forSale]) {
    shop.products.set(g.id, {
      id: g.id, variantId: g.variantId, copies: g.copies, title: g.library ? `${g.title} (Library)` : g.title,
      handle: g.library ? `${handleOf(g.title)}-library` : handleOf(g.title), tags: g.library ? ['Board Game Rental', ...g.tags] : g.tags,
      requiresSellingPlan: Boolean(g.sellingPlan),
      mf: Object.fromEntries(Object.entries({
        'custom.players': g.players, 'custom.play_time': g.playTime, 'custom.difficulty': g.difficulty,
        'custom.library_copy': g.libraryCopy ? gid('Product', g.libraryCopy) : null, 'custom.shop_copy': g.shopCopy ? gid('Product', g.shopCopy) : null,
        'shopify.recommended-age-group': g.ages ? JSON.stringify(g.ages.map(ageGroup)) : null,
        'custom.on_shelf': g.onShelf == null ? null : String(g.onShelf), 'custom.plays_with': g.playsWith ? JSON.stringify(g.playsWith) : null,
        'custom.suits_age': g.suitsAge ? JSON.stringify(g.suitsAge) : null,
      }).filter(([, v]) => v != null)),
    });
  }
}
/** Staff press "Write the filters to Shopify now" */
const runNow = (who = LIBRARIAN) => call('POST', 'pick/filters', {}, who);
/** When the alarm is set to go off now (null: none), once what's under way has settled */
const alarmTime = async () => {
  await settle();
  return ctx.alarm.at;
};
/** The alarm goes off (the clock moves to it first, and Cloudflare clears it as it goes off): one invocation */
async function alarmGoesOff() {
  assert.ok(await alarmTime(), 'an alarm is set');
  clock = Math.max(clock, ctx.alarm.at);
  ctx.alarm.at = null;
  await invoke(() => lair.alarm());
}
/** The alarm goes off, again and again, until nothing's left for it (at most `most` times). → how many times */
async function alarmsUntilQuiet(most = 30) {
  let times = 0;
  while ((await alarmTime()) !== null && times < most) {
    assert.ok(ctx.alarm.at - clock <= 2 * MIN, 'a minute or so apart');
    await alarmGoesOff();
    times += 1;
  }
  return times;
}

/** A Lair library membership (src/memberships.js): a member whose plan lets them borrow */
function member(customerId, name) {
  lair.sql.exec(
    'INSERT INTO memberships (id, contract_gid, customer_id, status, tier, billing_tier, cancel_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    `ms${customerId}`, gid('SubscriptionContract', customerId), customerId, 'active', 'stash', 'stash', null, NOW - 30 * DAY,
  );
  return call('GET', `me?name=${encodeURIComponent(name)}`, null, customerId);
}
const reserve = (g, who = SAM) => call('POST', 'library/holds', { variantId: g.variantId, productId: g.id, title: g.title, shelfCode: g.code, handle: 'x' }, who);

beforeEach(() => {
  clock = NOW;
  Date.now = () => clock;
  codes = 0;
  invocations = [];
});
afterEach(() => {
  Date.now = realNow;
});

/* ================ 1. The rules, in Shopify's words ================ */

test('Players: every count the game plays, "8+ players" when it plays 8 or more', async () => {
  const g = {
    duo: libraryGame({ id: '9100000000001', title: 'Duo', facts: facts({ players: { min: 2, max: 4, best: [3] } }) }),
    party: libraryGame({ id: '9100000000002', title: 'Party', facts: facts({ players: { min: 1, max: 8, best: [4] } }) }),
    crowd: libraryGame({ id: '9100000000003', title: 'Crowd', facts: facts({ players: { min: 3, max: 10, best: [6] } }) }),
    big: libraryGame({ id: '9100000000004', title: 'Big', facts: facts({ players: { min: 8, max: 12, best: [8] } }) }),
    alone: libraryGame({ id: '9100000000005', title: 'Alone', facts: facts({ players: { min: 1, max: 1, best: [1] }, mode: 'solo' }) }),
    village: libraryGame({ id: '9100000000006', title: 'Village', facts: facts({ players: { min: 10, max: 20, best: [12] } }) }),
  };
  start({ library: Object.values(g) });
  const res = await runNow();
  assert.equal(res.status, 200, said(res));
  assert.deepEqual(mf(g.duo.id, 'plays_with'), ['2 players', '3 players', '4 players']);
  assert.deepEqual(mf(g.party.id, 'plays_with'), ['1 player', '2 players', '3 players', '4 players', '5 players', '6 players', '7 players', '8+ players']);
  assert.deepEqual(mf(g.crowd.id, 'plays_with'), ['3 players', '4 players', '5 players', '6 players', '7 players', '8+ players']);
  assert.deepEqual(mf(g.big.id, 'plays_with'), ['8+ players']);
  assert.deepEqual(mf(g.village.id, 'plays_with'), ['8+ players'], 'a game for 10 to 20 is 8 or more');
  assert.deepEqual(mf(g.alone.id, 'plays_with'), ['1 player']);
});

test('Play time: each band its usual length touches; Under 30 is below 30, 30 to 60 includes both ends, 1 to 2 hours is over 60 to 120, 2 hours plus is over 120', async () => {
  const band = (id, min, max) => libraryGame({ id, title: `Time ${min} to ${max}`, facts: facts({ time: { min, max } }) });
  const g = {
    t20to29: band('9200000000001', 20, 29), t30: band('9200000000002', 30, 30), t29to30: band('9200000000003', 29, 30),
    t60: band('9200000000004', 60, 60), t60to61: band('9200000000005', 60, 61), t61to90: band('9200000000006', 61, 90),
    t120: band('9200000000007', 120, 120), t120to121: band('9200000000008', 120, 121), t121to240: band('9200000000009', 121, 240),
    t15to180: band('9200000000010', 15, 180),
  };
  start({ library: Object.values(g) });
  assert.equal((await runNow()).status, 200);
  const bands = (x) => mf(x.id, 'play_time_band');
  assert.deepEqual(bands(g.t20to29), ['Under 30 min']);
  assert.deepEqual(bands(g.t30), ['30 to 60 min'], '30 minutes is 30 to 60');
  assert.deepEqual(bands(g.t29to30), ['Under 30 min', '30 to 60 min']);
  assert.deepEqual(bands(g.t60), ['30 to 60 min'], '60 minutes is still 30 to 60');
  assert.deepEqual(bands(g.t60to61), ['30 to 60 min', '1 to 2 hours']);
  assert.deepEqual(bands(g.t61to90), ['1 to 2 hours']);
  assert.deepEqual(bands(g.t120), ['1 to 2 hours'], '120 minutes is still 1 to 2 hours');
  assert.deepEqual(bands(g.t120to121), ['1 to 2 hours', '2 hours plus']);
  assert.deepEqual(bands(g.t121to240), ['2 hours plus']);
  assert.deepEqual(bands(g.t15to180), ['Under 30 min', '30 to 60 min', '1 to 2 hours', '2 hours plus']);
});

test('Youngest player: the ages a child can be to play it (a game for 7+ gets Age 8, 10, 12 and 14; for 15+ none, and a value Shopify had is taken off)', async () => {
  const aged = (id, age, over = {}) => libraryGame({ id, title: `Age ${age}`, facts: facts({ age }), ...over });
  const g = {
    a3: aged('9300000000001', 3), a4: aged('9300000000002', 4), a7: aged('9300000000003', 7), a8: aged('9300000000004', 8),
    a13: aged('9300000000005', 13), a14: aged('9300000000006', 14), a15: aged('9300000000007', 15, { suitsAge: ['Age 14'] }),
    a16: aged('9300000000008', 16),
  };
  start({ library: Object.values(g) });
  assert.equal((await runNow()).status, 200);
  const all = ['Age 4', 'Age 6', 'Age 8', 'Age 10', 'Age 12', 'Age 14'];
  assert.deepEqual(mf(g.a3.id, 'suits_age'), all);
  assert.deepEqual(mf(g.a4.id, 'suits_age'), all);
  assert.deepEqual(mf(g.a7.id, 'suits_age'), ['Age 8', 'Age 10', 'Age 12', 'Age 14']);
  assert.deepEqual(mf(g.a8.id, 'suits_age'), ['Age 8', 'Age 10', 'Age 12', 'Age 14']);
  assert.deepEqual(mf(g.a13.id, 'suits_age'), ['Age 14']);
  assert.deepEqual(mf(g.a14.id, 'suits_age'), ['Age 14']);
  assert.equal(mf(g.a15.id, 'suits_age'), null, "15+: none, so what Shopify had is taken off (Shopify won't take an empty list)");
  assert.ok(writes('LairFilterDelete').some((c) => c.variables.metafields.some((m) => digits(m.ownerId) === g.a15.id && m.key === 'suits_age')));
  assert.equal(mf(g.a16.id, 'suits_age'), null);
  assert.ok(!written(g.a16.id).includes('suits_age'), 'nothing to write and nothing to take off');
});

test('How you play: its mode, plus Solo when it plays with one person', async () => {
  const g = {
    coop: libraryGame({ id: '9400000000001', title: 'Together', facts: facts({ mode: 'coop', players: { min: 2, max: 4, best: [3] } }) }),
    coopSolo: libraryGame({ id: '9400000000002', title: 'Together alone', facts: facts({ mode: 'coop', players: { min: 1, max: 4, best: [2] } }) }),
    versusSolo: libraryGame({ id: '9400000000003', title: 'Birds', facts: facts({ mode: 'competitive', players: { min: 1, max: 5, best: [3] } }) }),
    teams: libraryGame({ id: '9400000000004', title: 'Spies', facts: facts({ mode: 'team', players: { min: 4, max: 8, best: [6] } }) }),
    solo: libraryGame({ id: '9400000000005', title: 'Patience', facts: facts({ mode: 'solo', players: { min: 1, max: 1, best: [1] } }) }),
  };
  start({ library: Object.values(g) });
  assert.equal((await runNow()).status, 200);
  assert.deepEqual(mf(g.coop.id, 'how_you_play'), ['Co-op']);
  assert.deepEqual(mf(g.coopSolo.id, 'how_you_play'), ['Co-op', 'Solo']);
  assert.deepEqual(mf(g.versusSolo.id, 'how_you_play'), ['Competitive', 'Solo']);
  assert.deepEqual(mf(g.teams.id, 'how_you_play'), ['Team']);
  assert.deepEqual(mf(g.solo.id, 'how_you_play'), ['Solo']);
});

test("Weight: an empty difficulty is filled from the facts' weight, with the cut-offs that agree best with the games that already have one, and a set one is never overwritten", async () => {
  const weighed = (id, title, weight, difficulty = null) => libraryGame({ id, title, difficulty, facts: facts({ weight }) });
  // staff's own difficulties put Easy below 1.6 and Hard from 3.5 (not the quiz's 2.0 and 3.0), and one game disagrees
  const g = {
    e1: weighed('9500000000001', 'Easy one', 1.2, 'Easy'), e2: weighed('9500000000002', 'Easy two', 1.5, 'Easy'),
    m1: weighed('9500000000003', 'Medium one', 1.6, 'Medium'), m2: weighed('9500000000004', 'Medium two', 2.5, 'Medium'),
    m3: weighed('9500000000005', 'Medium three', 3.4, 'Medium'), h1: weighed('9500000000006', 'Hard one', 3.5, 'Hard'),
    h2: weighed('9500000000007', 'Hard two', 4.0, 'Hard'), odd: weighed('9500000000008', 'Fiddly one', 1.2, 'Hard'),
    // empty: filled by those cut-offs
    f15: weighed('9500000000009', 'Fill 1.5', 1.5), f16: weighed('9500000000010', 'Fill 1.6', 1.6), f34: weighed('9500000000011', 'Fill 3.4', 3.4),
    f35: weighed('9500000000012', 'Fill 3.5', 3.5),
  };
  start({ library: Object.values(g) });
  const res = await runNow();
  assert.equal(res.status, 200, said(res));
  assert.deepEqual([g.f15, g.f16, g.f34, g.f35].map((x) => mf(x.id, 'difficulty')), ['Easy', 'Medium', 'Medium', 'Hard']);
  assert.deepEqual(res.data.cutoffs, { easyBelow: 1.6, hardFrom: 3.5, agree: 7, of: 8 });
  // never overwritten: not the one that disagrees, and not one staff filled in since the Lair read it
  assert.equal(mf(g.odd.id, 'difficulty'), 'Hard');
  assert.ok(!written(g.odd.id).includes('difficulty'));
  const fills = writes().flatMap((c) => c.variables.metafields).filter((m) => m.key === 'difficulty');
  assert.ok(fills.length === 4 && fills.every((m) => Object.hasOwn(m, 'compareDigest') && m.compareDigest === null), 'each fill only lands while it is still empty');
});

/* ================ 2. Library games, shop games and what's left alone ================ */

test("the shop's board games take their library twin's facts (its Library copy, the library's Shop copy, or the catalogue's own title match), else their own players, play time, age group and Co-op and Solo tags; a field is left empty rather than guessed, and staff see every game with a gap", async () => {
  const L = {
    pandemic: libraryGame({ id: '9600000000001', title: 'Pandemic', difficulty: 'Medium', facts: facts({ mode: 'coop', players: { min: 2, max: 4, best: [4] }, time: { min: 34, max: 45 }, weight: 2.4, age: 8 }) }),
    catan: libraryGame({ id: '9600000000002', title: 'Catan', difficulty: 'Medium', shopCopy: '7600000000002', facts: facts({ players: { min: 3, max: 4, best: [4] }, time: { min: 60, max: 90 }, weight: 2.3, age: 10 }) }),
    azul: libraryGame({ id: '9600000000003', title: 'Azul', facts: facts({ players: { min: 2, max: 4, best: [2] }, time: { min: 30, max: 45 }, weight: 1.8, age: 8 }) }),
  };
  // (titles that don't match their twin's, so each link is the only way to it: Pandemic's own Library copy, the library
  // Catan's Shop copy; Azul has only its title)
  const S = {
    pandemic: shopGame({ id: '7600000000001', title: 'Pandemic: Base Game', tags: ['Classic', 'Co-op'], players: '2–4', playTime: '45 min', ages: ['8 years or older'], difficulty: 'Medium', libraryCopy: L.pandemic.id }),
    catan: shopGame({ id: '7600000000002', title: 'Catan – Base Game', tags: ['Classic', 'Strategy'], players: '3–4', playTime: '60+ min', ages: ['10 years or older'], difficulty: 'Medium' }),
    azul: shopGame({ id: '7600000000003', title: 'Azul', tags: ['Family Games'], players: '2–4', playTime: '30–45 min', ages: ['8 years or older'] }),
    dune: shopGame({ id: '7600000000004', title: 'Dune Imperium – Uprising', tags: ['Card game', 'Solo', 'Strategy'], players: '1–4 or 6', playTime: '60–120 min', ages: ['Teens'], difficulty: 'Hard' }),
    unlock: shopGame({ id: '7600000000005', title: 'Unlock! Kids', tags: ['Family Games'], players: '1–4', playTime: 'About 20 min per adventure', ages: ['6 years or older'], difficulty: 'Easy' }),
    sound: shopGame({ id: '7600000000006', title: 'That Sound Game', tags: ['Party'], players: '2+', playTime: '30 min', ages: ['Teens'], difficulty: 'Easy' }),
    tapple: shopGame({ id: '7600000000007', title: 'Tapple After Dark', tags: ['Party'], playTime: '5–15 min', ages: ['18 years or older'], difficulty: 'Easy' }),
    polaroid: shopGame({ id: '7600000000008', title: 'Polaroid – The Game', tags: ['Co-op', 'Solo'], players: '3–10+', playTime: '1–2 hours', ages: ['All ages'], difficulty: 'Easy' }),
    coins: shopGame({ id: '7600000000009', title: 'Vantage – Metal Coins' }),
    membership: shopGame({ id: '7600000000010', title: 'Board Game Rental Membership', sellingPlan: true }),
    lego: shopGame({ id: '7600000000011', title: 'LEGO – Brick Like This', tags: ['Family Games'], players: '2–8', playTime: '15+ min', ages: ['6 years or older'], difficulty: 'Easy' }),
    turns: shopGame({ id: '7600000000012', title: 'Slow Turns', tags: ['Co-op'], players: '2–4', playTime: '20 min per player', ages: ['10 years or older'], difficulty: 'Medium' }),
  };
  start({ library: Object.values(L), forSale: Object.values(S) });
  const res = await runNow();
  assert.equal(res.status, 200, said(res));
  // twins: the same filters as their library copy (Catan's own "60+ min" doesn't matter: its twin's facts win)
  for (const [shopCopy, libraryCopy] of [[S.pandemic, L.pandemic], [S.catan, L.catan], [S.azul, L.azul]]) {
    assert.deepEqual(filtersOf(shopCopy.id), filtersOf(libraryCopy.id), `${shopCopy.title} follows its library twin`);
  }
  assert.deepEqual(filtersOf(S.pandemic.id), [['2 players', '3 players', '4 players'], ['30 to 60 min'], ['Age 8', 'Age 10', 'Age 12', 'Age 14'], ['Co-op']]);
  assert.deepEqual(filtersOf(S.catan.id), [['3 players', '4 players'], ['30 to 60 min', '1 to 2 hours'], ['Age 10', 'Age 12', 'Age 14'], ['Competitive']]);
  // Azul's difficulty was empty in both: filled from the twin's weight (1.8: Easy)
  assert.deepEqual([mf(L.azul.id, 'difficulty'), mf(S.azul.id, 'difficulty')], ['Easy', 'Easy']);
  // no twin: its own text, age group and tags, read as they say
  assert.deepEqual(filtersOf(S.dune.id), [['1 player', '2 players', '3 players', '4 players', '6 players'], ['30 to 60 min', '1 to 2 hours'], ['Age 14'], ['Solo']]);
  assert.deepEqual(filtersOf(S.unlock.id), [['1 player', '2 players', '3 players', '4 players'], ['Under 30 min'], ['Age 6', 'Age 8', 'Age 10', 'Age 12', 'Age 14'], ['Solo']], 'a time per adventure counts per adventure');
  assert.deepEqual(filtersOf(S.sound.id), [null, ['30 to 60 min'], ['Age 14'], null], '"2+" says no top, so players stays empty');
  assert.deepEqual(filtersOf(S.tapple.id), [null, ['Under 30 min'], null, null], '18 or older: no Youngest player age');
  assert.deepEqual(filtersOf(S.polaroid.id), [['3 players', '4 players', '5 players', '6 players', '7 players', '8+ players'], ['30 to 60 min', '1 to 2 hours'], ['Age 4', 'Age 6', 'Age 8', 'Age 10', 'Age 12', 'Age 14'], ['Co-op', 'Solo']]);
  assert.deepEqual(filtersOf(S.coins.id), [null, null, null, null]);
  assert.deepEqual(filtersOf(S.lego.id), [['2 players', '3 players', '4 players', '5 players', '6 players', '7 players', '8+ players'], null, ['Age 6', 'Age 8', 'Age 10', 'Age 12', 'Age 14'], null], '"15+ min" says no top, so play time stays empty');
  assert.deepEqual(filtersOf(S.turns.id)[1], ['30 to 60 min', '1 to 2 hours'], '20 minutes a player, for 2 to 4: 40 to 80 minutes');
  // the shop never gets On the shelf now, and a membership (sold on a plan) isn't a board game
  assert.ok(Object.values(S).every((x) => mf(x.id, 'on_shelf') === null));
  assert.deepEqual(written(S.membership.id), []);
  // staff see the gaps, by the filter names customers see
  const gaps = Object.fromEntries(res.data.gaps.map((x) => [x.productId, x.missing]));
  assert.deepEqual(gaps, {
    [S.coins.id]: ['Players', 'Play time', 'Youngest player', 'How you play', 'Weight'],
    [S.dune.id]: ['How you play'],
    [S.lego.id]: ['Play time', 'How you play'],
    [S.sound.id]: ['Players', 'How you play'],
    [S.tapple.id]: ['Players', 'How you play'],
    [S.unlock.id]: ['How you play'],
  });
  const coins = res.data.gaps.find((x) => x.productId === S.coins.id);
  assert.deepEqual([coins.title, coins.where, coins.twin], ['Vantage – Metal Coins', 'shop', null]);
  // and so does the staff page later
  assert.deepEqual((await call('GET', 'pick/filters', null, LIBRARIAN)).data.gaps.map((x) => x.productId).sort(), Object.keys(gaps).sort());
});

test("a library game whose facts are still the basic ones made from its listing (not checked) takes only what its listing says; RPG books and kind other are left alone", async () => {
  const g = {
    basic: libraryGame({ id: '9700000000001', title: 'New Arrival', facts: null, tags: ['Co-op'], players: '2–5', playTime: '45 min', ages: ['10 years or older'] }),
    bare: libraryGame({ id: '9700000000002', title: 'Mystery Box', facts: null }),
    rpg: libraryGame({ id: '9700000000003', title: 'Starter Set', facts: facts({ kind: 'rpg', rpg: { system: 'D&D 5e', starter: true, setting: 'fantasy', type: 'starter' } }) }),
    other: libraryGame({ id: '9700000000004', title: 'Card Sleeves', facts: facts({ kind: 'other' }) }),
    expansion: libraryGame({ id: '9700000000005', title: 'Big Expansion', facts: facts({ kind: 'expansion', expansionOf: '9700000000001', players: { min: 2, max: 6, best: [4] } }) }),
  };
  start({ library: Object.values(g) });
  const res = await runNow();
  assert.equal(res.status, 200, said(res));
  assert.deepEqual(filtersOf(g.basic.id), [['2 players', '3 players', '4 players', '5 players'], ['30 to 60 min'], ['Age 10', 'Age 12', 'Age 14'], ['Co-op']]);
  assert.deepEqual(filtersOf(g.bare.id), [null, null, null, null], 'the basic facts guessed these, so nothing is written');
  assert.deepEqual(res.data.gaps.find((x) => x.productId === g.bare.id)?.missing, ['Players', 'Play time', 'Youngest player', 'How you play', 'Weight']);
  assert.deepEqual(filtersOf(g.expansion.id)[0], ['2 players', '3 players', '4 players', '5 players', '6 players'], 'an expansion is a game here');
  // RPG books and kind other: never read, never written
  for (const x of [g.rpg, g.other]) {
    assert.deepEqual(written(x.id), []);
    assert.ok(!shop.calls.some((c) => (c.variables.ids || []).includes(gid('Product', x.id))));
  }
  // once staff check the basic facts ("Looks right"), they're the game's facts
  assert.equal((await call('POST', `pick/games/${g.bare.id}`, { checked: true }, LIBRARIAN)).status, 200);
  assert.equal((await runNow()).status, 200);
  assert.ok(filtersOf(g.bare.id).every((list) => Array.isArray(list) && list.length));
});

test("only values that changed are written (read first), in the batches Shopify allows: up to 50 products a read and 25 metafields a write", async () => {
  const many = Array.from({ length: 60 }, (_, i) => libraryGame({ id: String(9800000000001 + i), title: `Game ${i + 1}`, difficulty: 'Medium', facts: facts({ players: { min: 2, max: 2 + (i % 5), best: [2] } }) }));
  start({ library: many });
  const first = await runNow();
  assert.equal(first.status, 200, said(first));
  assert.equal(first.data.changed, 60);
  assert.equal(first.data.message, '60 games changed in Shopify.');
  const reads = shop.calls.filter((c) => c.name === 'LairFilterProducts');
  assert.deepEqual(reads.map((c) => c.variables.ids.length), [50, 10]);
  assert.ok(writes().every((c) => c.variables.metafields.length <= 25));
  assert.equal(writes().flatMap((c) => c.variables.metafields).length, 60 * 5, 'four filters and On the shelf now for each (difficulty was set)');
  // again: everything's as it should be, so nothing's written
  shop.calls = [];
  const again = await runNow();
  assert.deepEqual([again.data.changed, writes().length], [0, 0]);
  assert.equal(again.data.message, "Every game's filters were already up to date.");
  // someone changes one field in Shopify: the next run puts back just that one
  shop.products.get(many[7].id).mf['custom.plays_with'] = JSON.stringify(['1 player']);
  shop.calls = [];
  const fixed = await runNow();
  assert.deepEqual([fixed.data.changed, writes().flatMap((c) => c.variables.metafields).map((m) => [digits(m.ownerId), m.key])], [1, [[many[7].id, 'plays_with']]]);
});

/* ================ 3. On the shelf now ================ */

test('On the shelf now: true while a copy is free (copies less active holds less loans out), and it flips both ways within a minute or two of a hold, a cancel, a collect, a return and an expiry', async () => {
  const azul = libraryGame({ id: '9900000000001', title: 'Azul', difficulty: 'Easy', facts: facts({ weight: 1.8 }) });
  const duo = libraryGame({ id: '9900000000002', title: 'Two Copies', difficulty: 'Easy', copies: 2, facts: facts({ weight: 1.5 }) });
  const ready = libraryGame({ id: '9900000000003', title: 'Already Right', difficulty: 'Easy', onShelf: true, facts: facts() });
  start({ library: [azul, duo, ready] });
  await member(SAM, 'Sam Jones');
  await member(KIRI, 'Kiri Smith');
  // the first check (nothing known yet): read first, so a game Shopify already has right isn't written again
  await invoke(() => lair.alarm());
  assert.deepEqual([mf(azul.id, 'on_shelf'), mf(duo.id, 'on_shelf'), mf(ready.id, 'on_shelf')], [true, true, true]);
  assert.deepEqual([written(azul.id), written(ready.id)], [['on_shelf'], []]);
  assert.equal((await runNow()).status, 200);
  const soon = () => ctx.alarm.at - clock <= 2 * MIN;
  // a hold: off the shelf
  const hold = await reserve(azul);
  assert.equal(hold.status, 200, said(hold));
  assert.ok(soon(), 'the alarm is set to go off within two minutes');
  await alarmGoesOff();
  assert.equal(mf(azul.id, 'on_shelf'), false);
  // cancelled: back on
  assert.equal((await call('POST', `library/holds/${hold.data.hold.id}/cancel`, {}, SAM)).status, 200);
  assert.ok(soon());
  await alarmGoesOff();
  assert.equal(mf(azul.id, 'on_shelf'), true);
  // held and collected: the copy is at home with them, so still off; back at the counter: on again
  const again = await reserve(azul);
  await alarmGoesOff();
  const collected = await call('POST', `library/holds/${again.data.hold.id}/update`, { status: 'collected' }, LIBRARIAN);
  assert.equal(collected.status, 200, said(collected));
  assert.ok(soon());
  await alarmGoesOff();
  assert.equal(mf(azul.id, 'on_shelf'), false);
  assert.equal((await call('POST', `library/loans/${collected.data.loan.id}/return`, {}, LIBRARIAN)).status, 200);
  assert.ok(soon());
  await alarmGoesOff();
  assert.equal(mf(azul.id, 'on_shelf'), true);
  // two copies: one held, one still free, so nothing changes and nothing is written
  shop.calls = [];
  await reserve(duo, KIRI);
  await alarmGoesOff();
  assert.equal(mf(duo.id, 'on_shelf'), true);
  assert.deepEqual(writes(), []);
  // an expiry: held until midnight on the third day, then back on the shelf by itself
  const last = await reserve(azul);
  await alarmGoesOff();
  assert.equal(mf(azul.id, 'on_shelf'), false);
  assert.equal(last.data.hold.until, at('2026-11-12', 0));
  assert.ok(ctx.alarm.at >= last.data.hold.until && ctx.alarm.at - last.data.hold.until <= 2 * MIN, 'the alarm waits for the hold to end');
  await alarmGoesOff();
  assert.equal(mf(azul.id, 'on_shelf'), true);
  // nothing left to do: no alarm
  assert.equal(ctx.alarm.at, null);
});

test('On the shelf now counts In Store Only games the same way: on the shelf to play at a table, off while held', async () => {
  const mvm = libraryGame({ id: '9900000000101', title: 'Mechs vs. Minions (League of Legends)', tags: ['In Store Only'], difficulty: 'Medium', facts: facts({ mode: 'coop' }) });
  start({ library: [mvm] });
  await member(SAM, 'Sam Jones');
  assert.equal((await runNow()).status, 200);
  assert.equal(mf(mvm.id, 'on_shelf'), true);
  const hold = await reserve(mvm);
  assert.equal(hold.status, 200, said(hold));
  await alarmGoesOff();
  assert.equal(mf(mvm.id, 'on_shelf'), false);
  // collected for a table (round 30: no loan), so it's free again
  assert.equal((await call('POST', `library/holds/${hold.data.hold.id}/update`, { status: 'collected' }, LIBRARIAN)).status, 200);
  await alarmGoesOff();
  assert.equal(mf(mvm.id, 'on_shelf'), true);
});

test("a Shopify failure never breaks a borrow, hold or return: they're saved, and On the shelf now is written afterwards, tried again later", async () => {
  const azul = libraryGame({ id: '9900000000201', title: 'Azul', difficulty: 'Easy', facts: facts() });
  start({ library: [azul] });
  await member(SAM, 'Sam Jones');
  assert.equal((await runNow()).status, 200);
  shop.fail = (name) => name === 'LairFilterSet' || name === 'LairShelfValues' || name === 'LairFilterProducts';
  const hold = await reserve(azul);
  assert.equal(hold.status, 200, 'the hold is saved');
  await alarmGoesOff();
  assert.equal(mf(azul.id, 'on_shelf'), true, 'Shopify was down');
  assert.ok(ctx.alarm.at > clock && ctx.alarm.at - clock <= HOUR, 'tried again later');
  const collected = await call('POST', `library/holds/${hold.data.hold.id}/update`, { status: 'collected' }, LIBRARIAN);
  assert.equal(collected.status, 200, 'collected while Shopify is down');
  assert.equal((await call('POST', `library/loans/${collected.data.loan.id}/return`, {}, LIBRARIAN)).status, 200, 'returned while Shopify is down');
  await reserve(azul);
  shop.fail = () => false;
  await alarmGoesOff();
  assert.equal(mf(azul.id, 'on_shelf'), false, 'written once Shopify answers');
});

/* ================ 4. When it runs ================ */

/** Maintenance can run in these tests: Shopify's login and the payment webhook are as they should be */
const maintenanceReady = () => {
  lair.shopify.appInfo = async () => ({ app: { title: 'Dice Goblin Lair' }, shop: { name: 'Dice Goblin' }, scopes: ['write_products', 'read_customers'] });
  lair.ensureWebhook = async () => ({ ok: true });
};
const lastRun = async () => (await call('GET', 'pick/filters', null, LIBRARIAN)).data;

test('the first fill starts by itself at the first maintenance after the deploy (not waiting for 3am); then each night, at the first maintenance from 3am, every game is written again and On the shelf now put right where Shopify drifted, once a night', async () => {
  const azul = libraryGame({ id: '9910000000001', title: 'Azul', difficulty: 'Easy', facts: facts() });
  const catan = libraryGame({ id: '9910000000002', title: 'Catan', difficulty: 'Medium', facts: facts({ players: { min: 3, max: 4, best: [4] } }) });
  start({ library: [azul, catan] });
  maintenanceReady();
  // just deployed at 1am: the first maintenance fills every game, without waiting for 3am
  clock = at('2026-11-10', 1, 0);
  await internal('maintenance');
  assert.deepEqual([mf(azul.id, 'plays_with'), mf(catan.id, 'on_shelf')], [['2 players', '3 players', '4 players'], true]);
  assert.equal((await lastRun()).last.reason, 'first');
  // someone changes On the shelf now in Shopify by hand: before 3am nothing writes again
  shop.products.get(catan.id).mf['custom.on_shelf'] = 'false';
  shop.calls = [];
  clock = at('2026-11-10', 2, 50);
  await internal('maintenance');
  assert.equal(writes().length, 0, 'not before 3am');
  // from 3am, the night's run puts it right
  clock = at('2026-11-10', 3, 5);
  await internal('maintenance');
  assert.equal(mf(catan.id, 'on_shelf'), true);
  assert.equal((await lastRun()).last.reason, 'nightly');
  // once a night
  shop.products.get(catan.id).mf['custom.on_shelf'] = 'false';
  shop.calls = [];
  clock = at('2026-11-10', 3, 15);
  await internal('maintenance');
  assert.equal(writes().length, 0, 'once a night');
  clock = at('2026-11-11', 3, 5);
  await internal('maintenance');
  assert.equal(mf(catan.id, 'on_shelf'), true);
});

/* ================ 5. Cloudflare's free plan: 50 outside calls an invocation ================ */

test("a fill too big for one invocation (Cloudflare's free plan allows 50 outside calls) does what fits in 35 Shopify calls: the button says how much is done and that the rest follows, and the alarm finishes it, a minute apart", async () => {
  const many = Array.from({ length: 200 }, (_, i) => libraryGame({ id: String(9810000000001 + i), title: `Big ${i + 1}`, difficulty: 'Medium', facts: facts() }));
  start({ library: many });
  const done = () => many.filter((g) => mf(g.id, 'plays_with') && mf(g.id, 'on_shelf') !== null).length;
  const res = await runNow();
  assert.equal(res.status, 200, said(res));
  assert.equal(res.data.done, false);
  assert.ok(done() > 0 && done() < 200, `${done()} of 200 written`);
  assert.equal(res.data.message, `${res.data.checked} of 200 games done so far, ${res.data.changed} changed in Shopify. The rest follow in the next few minutes.`);
  assert.equal(res.data.checked, done());
  // still under way: no last run yet, and the run in progress says how far it's got
  const midway = await lastRun();
  assert.deepEqual([midway.last, midway.running.total, midway.running.left], [null, 200, 200 - done()]);
  // the alarm takes it from there, each time a fresh invocation, until every game is written; one of its writes Shopify
  // doesn't answer on the way, and those games wait for the next go rather than being dropped
  const next = await alarmTime();
  assert.ok(next && next - clock <= 2 * MIN, 'the rest follows within a couple of minutes');
  let sets = 0;
  shop.fail = (name) => name === 'LairFilterSet' && (sets += 1) === 3;
  await alarmsUntilQuiet();
  assert.ok(sets > 3, 'the failed write was tried again');
  assert.equal(done(), 200);
  const after = await lastRun();
  assert.deepEqual([after.last.games, after.last.changed, after.last.failed, after.running], [200, 200, 0, null]);
  // no invocation used more than 35 of its 50 calls (the filters' share)
  assert.ok(Math.max(...invocations) <= 35, `the most one invocation made: ${Math.max(...invocations)}`);
});

test("the night's run starts inside maintenance with only what that invocation has left of its 35 Shopify calls; the alarm carries the rest a minute apart, and the night counts as done only once every game is written", async () => {
  const many = Array.from({ length: 120 }, (_, i) => libraryGame({ id: String(9830000000001 + i), title: `Night ${i + 1}`, difficulty: 'Medium', facts: facts() }));
  start({ library: many });
  maintenanceReady();
  // the deploy's first maintenance: by the filters' turn its other steps have used all but a few of its 35 calls, so On
  // the shelf now stops at the limit (100 games to check: 6 calls), and the alarm finishes it and the first fill
  lair.ensureWebhook = async () => {
    externalCalls.count += 30;
    return { ok: true };
  };
  invocations = [];
  await internal('maintenance');
  assert.ok(invocations[0] <= 35, `the first maintenance made ${invocations[0]} outside calls in all`);
  await alarmsUntilQuiet();
  assert.equal((await lastRun()).last.reason, 'first');
  // overnight, someone changes every game's players by hand
  for (const g of many) shop.products.get(g.id).mf['custom.plays_with'] = JSON.stringify(['1 player']);
  const right = () => many.filter((g) => JSON.stringify(mf(g.id, 'plays_with')) === JSON.stringify(['2 players', '3 players', '4 players'])).length;
  // 3:05am: by the filters' turn, maintenance has already made 20 outside calls (its other steps)
  lair.ensureWebhook = async () => {
    externalCalls.count += 20;
    return { ok: true };
  };
  clock = at('2026-11-10', 3, 5);
  invocations = [];
  await internal('maintenance');
  assert.ok(right() > 0 && right() < 120, `${right()} put right in maintenance`);
  assert.ok(invocations[0] <= 35, `maintenance made ${invocations[0]} outside calls in all`);
  const midway = await lastRun();
  assert.deepEqual([midway.last.reason, midway.running.reason], ['first', 'nightly'], 'not the night\'s yet');
  // the alarm, a minute apart, until it's done; then (and only then) the night is done
  await alarmsUntilQuiet();
  assert.equal(right(), 120);
  const night = (await lastRun()).last;
  assert.equal(night.reason, 'nightly');
  shop.calls = [];
  clock = at('2026-11-10', 3, 25);
  await internal('maintenance');
  assert.equal(writes().length, 0, 'the night was done');
  const later = await lastRun();
  assert.deepEqual([later.last.at, later.running], [night.at, null], 'no second run that night');
});

test("Shopify's all-or-nothing write never fails a game's neighbours: a call it turns away is split (halves, then single games) until the one it refuses is alone, and only that game counts as failed", async () => {
  // ten games, each with an empty difficulty to fill (six fields a game, so four to a call)
  const ten = Array.from({ length: 10 }, (_, i) => libraryGame({ id: String(9840000000001 + i), title: `Fill ${i + 1}`, facts: facts({ weight: 1.5 }) }));
  start({ library: ten });
  // a librarian sets one game's difficulty in Shopify admin just after the Lair read it: that fill is refused
  const late = ten[1];
  shop.afterRead = () => {
    shop.products.get(late.id).mf['custom.difficulty'] = 'Hard';
    shop.afterRead = null;
  };
  const res = await runNow();
  assert.equal(res.status, 200, said(res));
  for (const g of ten.filter((x) => x !== late)) assert.equal(mf(g.id, 'difficulty'), 'Easy', `${g.title} is written`);
  assert.equal(mf(late.id, 'difficulty'), 'Hard', 'never overwritten');
  assert.deepEqual([res.data.changed, res.data.failed], [9, 1]);
  assert.equal(res.data.message, "9 games changed in Shopify. 1 game couldn't be written just now: the Lair tries again tonight.");
  // three calls of four, four and two games, then halves: the four (2 + 2), then the two (1 + 1)
  assert.equal(writes().length, 7);
});

test("the alarm's retry always lands: if the Lair can't read its settings as the alarm goes off, it tries again 5 minutes later", async () => {
  const azul = libraryGame({ id: '9850000000001', title: 'Azul', difficulty: 'Easy', facts: facts() });
  start({ library: [azul] });
  await member(SAM, 'Sam Jones');
  assert.equal((await runNow()).status, 200);
  assert.equal((await reserve(azul)).status, 200);
  const set = await alarmTime();
  assert.ok(set);
  lair.useConfig = async () => {
    throw new Error('The config database is down');
  };
  await alarmGoesOff();
  assert.equal(await alarmTime(), set + 5 * MIN);
});

test("after the Lair restarts (an eviction), a later wake never moves a sooner alarm that's already set: it asks Cloudflare first and keeps the sooner one", async () => {
  const azul = libraryGame({ id: '9860000000001', title: 'Azul', difficulty: 'Easy', facts: facts() });
  start({ library: [azul] });
  await member(SAM, 'Sam Jones');
  assert.equal((await runNow()).status, 200);
  // an alarm set before the restart, 10 seconds on (a hold ending, say)
  ctx.alarm.at = clock + 10_000;
  restart();
  // a hold wants the alarm a minute on: the sooner one stays
  assert.equal((await reserve(azul)).status, 200);
  assert.equal(await alarmTime(), clock + 10_000);
  // a sooner one still moves it (a game saved on Check games: 5 seconds)
  assert.equal((await call('POST', `pick/games/${azul.id}`, { checked: true }, LIBRARIAN)).status, 200);
  assert.equal(await alarmTime(), clock + 5_000);
});

test("staff save a game on Library discovery's Check games: its filters, and its shop twin's, go to Shopify straight after", async () => {
  const L = libraryGame({ id: '9920000000001', title: 'Pandemic', difficulty: 'Medium', facts: facts({ mode: 'coop', players: { min: 2, max: 4, best: [4] }, weight: 2.4 }) });
  // linked only by its own Library copy (its title isn't the library's)
  const S = shopGame({ id: '7620000000001', title: 'Pandemic: Base Game', tags: ['Co-op'], players: '2–4', playTime: '45 min', difficulty: 'Medium', libraryCopy: L.id });
  start({ library: [L], forSale: [S] });
  assert.equal((await runNow()).status, 200);
  assert.deepEqual([mf(L.id, 'plays_with'), mf(S.id, 'plays_with')], [['2 players', '3 players', '4 players'], ['2 players', '3 players', '4 players']]);
  // a librarian corrects it: it plays 1 to 5, solo too
  const saved = await call('POST', `pick/games/${L.id}`, { facts: facts({ mode: 'coop', players: { min: 1, max: 5, best: [4] }, weight: 2.4 }) }, LIBRARIAN);
  assert.equal(saved.status, 200, said(saved));
  assert.ok(ctx.alarm.at && ctx.alarm.at - clock <= MIN, 'straight after');
  await alarmGoesOff();
  const players = ['1 player', '2 players', '3 players', '4 players', '5 players'];
  assert.deepEqual([mf(L.id, 'plays_with'), mf(S.id, 'plays_with')], [players, players]);
  assert.deepEqual([mf(L.id, 'how_you_play'), mf(S.id, 'how_you_play')], [['Co-op', 'Solo'], ['Co-op', 'Solo']]);
});

test('the staff button (the library permission, as "Sync with Shopify now" has) runs it now and says how many games changed; the last run and its gaps can be read back', async () => {
  const azul = libraryGame({ id: '9930000000001', title: 'Azul', difficulty: 'Easy', facts: facts() });
  start({ library: [azul] });
  assert.equal((await runNow(HELPER)).status, 403);
  assert.equal((await call('GET', 'pick/filters', null, HELPER)).status, 403);
  const res = await runNow(LIBRARIAN);
  assert.equal(res.status, 200, said(res));
  assert.deepEqual([res.data.games, res.data.changed, res.data.message], [1, 1, '1 game changed in Shopify.']);
  const last = (await call('GET', 'pick/filters', null, STAFF)).data;
  assert.deepEqual([last.last.games, last.last.changed, last.last.at, last.gaps], [1, 1, NOW, []]);
  // Shopify not answering: a 503 that says so, and nothing pretends it was written
  shop.fail = () => true;
  const down = await runNow(LIBRARIAN);
  assert.deepEqual([down.status, down.data.error], [503, "Shopify didn't answer just now. Try again in a minute."]);
  // the app without write_products (the health check's scopes): it says so, rather than failing game by game
  lair.grantedScopes = ['read_products', 'read_metaobjects'];
  const scope = await runNow(LIBRARIAN);
  assert.deepEqual([scope.status, scope.data.error], [503, "Shopify hasn't let the Lair app change products yet (write_products), so the filters can't be written."]);
});

/* ================ 5. GET /library/status ================ */

test("GET /library/status says who the soonest hold is for: heldFor 'table' for a table booking, 'member' for a member's reserve, null with none (every other field as it was)", async () => {
  const azul = libraryGame({ id: '9940000000001', title: 'Azul', facts: facts() });
  const catan = libraryGame({ id: '9940000000002', title: 'Catan', facts: facts() });
  const uno = libraryGame({ id: '9940000000003', title: 'Uno', facts: facts() });
  start({ library: [azul, catan, uno] });
  await member(SAM, 'Sam Jones');
  assert.equal((await reserve(azul)).status, 200);
  // a game held for a table booking (round 17), until the booking ends at 9pm
  lair.sql.exec(
    `INSERT INTO library_holds (id, variant_id, product_id, title, customer_id, status, until, created_by, created_at, updated_at, kind, booking_id)
     VALUES ('lh_table', ?, ?, 'Catan', '', 'held', ?, 'booking', ?, ?, 'booking', 'bk1')`,
    catan.variantId, catan.id, at('2026-11-09', 21), NOW, NOW,
  );
  const status = (await call('GET', `library/status?ids=${azul.variantId},${catan.variantId},${uno.variantId}`, null, KIRI)).data.games;
  assert.deepEqual(status[azul.variantId], { copies: 1, held: 1, out: 0, available: 0, nextFree: at('2026-11-12', 0), mine: null, atHome: null, heldFor: 'member', wanted: [], wantedMore: 0 });
  assert.deepEqual(status[catan.variantId], { copies: 1, held: 1, out: 0, available: 0, nextFree: at('2026-11-09', 21), mine: null, atHome: null, heldFor: 'table', wanted: [], wantedMore: 0 });
  assert.deepEqual(status[uno.variantId], { copies: 1, held: 0, out: 0, available: 1, nextFree: null, mine: null, atHome: null, heldFor: null, wanted: [], wantedMore: 0 });
});

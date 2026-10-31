// Round 26: GW's weekly order pad into Shopify from the staff page's Warhammer tab (contract v26-gw-pad). Mo (31 Oct
// 2026): "how do we tackle the ordered products? Do we add them online? With the same context?" Every line on the pad
// goes into Shopify set up like the live GW listings (name-only description, the plain Google line, selling at 0 so
// it's ordered in), on the till until it has GW's picture; each week's pad keeps the shop in step. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS, STAFF_PERMS } from '../src/core.js';
import {
  PAD_WORDS as W, APPLY_BATCH, STUCK_AFTER, PAD_MIN_ROWS, cleanPadRow, padTitle, paintColour, padSize, padType, padTags, padFaction, dayKey, seoLine,
} from '../src/gw-pad.js';

const time = new LairTime('Pacific/Auckland');
const HOUR = 3_600_000;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Sunday 1 November 2026, 10am in Auckland
const NOW = at('2026-11-01', 10);
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
const ENV = { CURRENCY: 'NZD', GW_LOCATION_ID: '72250359911', GW_POS_PUBLICATION_ID: '129866989671' };
const LOCATION = 'gid://shopify/Location/72250359911';
const POS = 'gid://shopify/Publication/129866989671';
const OWNER = '9001';
const HELPER = '9002';
const MEMBER = '9003';

/* ---------------- a pretend Shopify: GW products and variants ---------------- */
let products; // product id → { id, title, status, tags, release, type, variants: [variant ids], published: Set, input }
let variants; // variant id → { id, sku, price, cost, barcode, policy, pack, productId, vendor }
let nextId;
let calls;
let pending;
let lair;
/** What goes wrong next: create ('lost' | 'throttle' | 'userErrors' | 'denied'), publish (true: refused), update (product id → words) */
let trouble;
const PAGE = 3;

const newId = (kind) => `gid://shopify/${kind}/${(nextId += 1)}`;
/** A product in the pretend shop with its variants ({ sku, price (dollars), ... }) */
function addProduct({ title, status = 'ACTIVE', tags = [], release = null, vendor = 'Games Workshop', type = 'War Game' }, list) {
  const id = newId('Product');
  const product = { id, title, status, tags: [...tags], release, type, vendor, variants: [], published: new Set([POS]), input: null };
  products.set(id, product);
  for (const v of list) {
    const vid = newId('ProductVariant');
    variants.set(vid, { id: vid, sku: v.sku, price: v.price, cost: v.cost ?? null, barcode: v.barcode || '', policy: v.policy || 'DENY', pack: v.pack || 1, productId: id, option: v.option || 'Default Title' });
    product.variants.push(vid);
  }
  return product;
}
const productOf = (sku) => {
  const v = [...variants.values()].find((x) => x.sku === sku);
  return v ? products.get(v.productId) : null;
};
const variantOf = (sku) => [...variants.values()].find((x) => x.sku === sku) || null;
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

function installShopify() {
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.lastCost = null;
  lair.shopify.customerTags = async (id) => (id === OWNER ? ['staff'] : []);
  lair.shopify.gwShopPage = async (after) => {
    calls.push(['page', after]);
    const all = [...variants.values()].filter((v) => products.get(v.productId).vendor === 'Games Workshop')
      .sort((a, b) => Number(a.id.split('/').pop()) - Number(b.id.split('/').pop()));
    const start = after ? all.findIndex((v) => v.id === after) + 1 : 0;
    const slice = all.slice(start, start + PAGE);
    return {
      variants: slice.map((v) => {
        const p = products.get(v.productId);
        return {
          id: v.id, sku: v.sku, price: v.price, cost: v.cost, barcode: v.barcode, policy: v.policy, pack: v.pack, productId: p.id,
          productTitle: p.title, status: p.status, tags: p.tags, variants: p.variants.length, release: p.release,
        };
      }),
      next: start + PAGE < all.length ? slice[slice.length - 1].id : null,
    };
  };
  lair.shopify.gwUpdate = async (groups) => {
    calls.push(['update', groups.map((g) => g.productId)]);
    await tick();
    return groups.map((g) => {
      if (trouble.update?.[g.productId]) return { productId: g.productId, error: new Error(trouble.update[g.productId]) };
      const p = products.get(g.productId);
      for (const input of g.variants) {
        const v = variants.get(input.id);
        if (input.price) v.price = input.price;
        if (input.inventoryItem?.cost) v.cost = input.inventoryItem.cost;
        if (input.barcode) v.barcode = input.barcode;
        if (input.inventoryPolicy) v.policy = input.inventoryPolicy;
        if (input.metafields) v.pack = Number(input.metafields[0].value);
      }
      if (g.tag === 'add' && !p.tags.includes('New release')) p.tags.push('New release');
      if (g.tag === 'remove') p.tags = p.tags.filter((t) => t !== 'New release');
      if (g.release) p.release = g.release;
      return { productId: g.productId };
    });
  };
  lair.shopify.gwCreate = async (list, posId) => {
    calls.push(['create', list.map((p) => p.codes)]);
    await tick();
    const how = trouble.create;
    if (how === 'throttle') {
      trouble.create = null;
      throw Object.assign(new Error('Shopify API: Throttled'), { throttled: true, nothingRan: true, cost: null });
    }
    if (how === 'denied') throw Object.assign(new Error('Shopify API: Access denied for productSet field. Required access: `write_products` access scope.'), { nothingRan: true });
    const made = list.map((item) => {
      if (how === 'userErrors') return { codes: item.codes, error: new Error('Title is too long'), nothingRan: true };
      const p = addProduct({ title: item.input.title, status: item.input.status, tags: item.input.tags, type: item.input.productType,
        release: item.input.metafields?.find((m) => m.key === 'gw_release_date')?.value || null },
      item.input.variants.map((v) => ({ sku: v.sku, price: v.price, cost: v.inventoryItem?.cost ?? null, barcode: v.barcode, policy: v.inventoryPolicy,
        pack: Number(v.metafields?.[0]?.value || 1), option: v.optionValues[0].name })));
      p.published = new Set();
      p.input = item.input;
      return { codes: item.codes, productId: p.id, range: item.range || null };
    });
    if (how === 'lost') {
      trouble.create = null;
      throw new Error('The operation was aborted due to timeout');
    }
    const published = made.filter((m) => m.productId).map((m) => {
      if (trouble.publish) return false;
      products.get(m.productId).published.add(posId);
      return true;
    });
    let i = 0;
    return made.map((m) => (m.productId ? { ...m, published: published[i++] } : m));
  };
  lair.shopify.gwAddVariants = async (productId, list) => {
    calls.push(['add', productId, list.map((v) => v.sku)]);
    await tick();
    const p = products.get(productId);
    return list.map((v) => {
      const vid = newId('ProductVariant');
      variants.set(vid, { id: vid, sku: v.sku, price: v.price, cost: v.inventoryItem?.cost ?? null, barcode: v.barcode || '', policy: v.inventoryPolicy, pack: Number(v.metafields?.[0]?.value || 1), productId, option: v.optionValues[0].name });
      p.variants.push(vid);
      return { codes: [v.sku], productId };
    });
  };
  lair.shopify.gwPublish = async (ids, posId) => {
    calls.push(['publish', ids]);
    return ids.map((id) => {
      if (trouble.publish) return { productId: id, error: new Error('Publication not found') };
      products.get(id).published.add(posId);
      return { productId: id };
    });
  };
  lair.shopify.gwFindSkus = async (codes) => {
    calls.push(['find', codes]);
    const found = new Map();
    for (const code of codes) {
      const v = variantOf(code);
      if (v) found.set(code, { variantId: v.id, productId: v.productId });
    }
    return found;
  };
  lair.shopify.gwActivate = async (ids) => {
    calls.push(['activate', ids]);
    return ids.map((id) => {
      products.get(id).status = 'ACTIVE';
      return { productId: id };
    });
  };
}

/** A request to the Lair as the staff page makes it (each a moment after the last) */
async function call(method, path, body, customer = OWNER) {
  clock += 1;
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
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();

/* ---------------- a pad: GW's rows as the staff page sends them ---------------- */
const kit = (n, extra = {}) => ({
  release: null, module: '', system: 'Warhammer 40K', race: '40K - Space Marines - Generic', ss: `03-${n}`, code: String(99120100000 + n),
  desc: `S/M: Test Squad ${n}`, minstock: 1, pack: 1, barcode: String(5011921000000 + n), nz_trade: 50.46, nz_mrp: 89,
  ...extra,
});
const paint = (n, range, desc, extra = {}) => ({
  release: null, module: '', system: 'Paint', race: range, ss: `21-${n}`, code: String(99189950000 + n), desc, minstock: 6, pack: 6,
  barcode: String(5011921100000 + n), nz_trade: 6.58, nz_mrp: 11.6, ...extra,
});
const BASE = 'Paint - WH Colour - Base';
const TECH = 'Paint - WH Colour - Technical';
/** The usual pad: 520 kits, 30 Base paints, 3 Technical (two sizes), a shop fitting, a trade-only line, a kit still to come */
function padRows() {
  const rows = [];
  for (let n = 1; n <= 520; n += 1) rows.push(kit(n));
  for (let n = 1; n <= 30; n += 1) rows.push(paint(n, BASE, `B: Colour ${String(n).padStart(2, '0')} 12Ml Row`));
  rows.push(paint(101, TECH, 'Te:Blending Medium 18Ml Row'));
  rows.push(paint(102, TECH, 'Technical: Mordant Earth (24Ml)'));
  rows.push(paint(103, TECH, 'Te:Shading Medium 18Ml Row', { release: '2026-11-21 00:00:00' }));
  rows.push({ ...kit(900), system: 'Marketing POS', race: 'Marketing POS - Trade', desc: 'Trade: Window Banner', nz_mrp: null });
  rows.push({ ...kit(901), desc: 'Trd: Aos Intro Activity Pk', nz_mrp: null });
  // a release still to come (GW's pre-order day is a week before: Saturday 14 November)
  rows.push(kit(902, { desc: 'Combat Patrol: Test Marines', release: 46347 }));
  return rows;
}

/** The staff page's upload: 100 rows a part */
async function upload(rows, { size = 100, who = OWNER } = {}) {
  const parts = Math.ceil(rows.length / size);
  let upload = null;
  let last;
  for (let part = 1; part <= parts; part += 1) {
    last = await call('POST', 'gw/pad', { upload, date: '2026-10-26', part, parts, rows: rows.slice((part - 1) * size, part * size) }, who);
    if (last.status !== 200) return last;
    upload = last.data.upload;
  }
  return last;
}
/** Read the shop until done (as the staff page loops) */
async function readShop() {
  let res = ok(await call('POST', 'gw/shop', { restart: true }));
  while (!res.done) res = ok(await call('POST', 'gw/shop', {}));
  return res;
}
/** Apply until nothing's left (as the staff page loops), at most `most` requests */
async function applyAll(most = 400) {
  let res;
  for (let i = 0; i < most; i += 1) {
    res = ok(await call('POST', 'gw/apply', {}));
    if (!res.left) return res;
  }
  return res;
}
const plan = (code) => lair.sql.exec('SELECT * FROM gw_plan WHERE code = ?', String(code)).toArray()[0];

beforeEach(() => {
  globalThis.fetch = async (url) => {
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  pending = [];
  calls = [];
  trouble = {};
  nextId = 1000;
  products = new Map();
  variants = new Map();
  lair = new Lair(fakeCtx(pending), ENV);
  installShopify();
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  // the live shop: a kit at last year's price, a kit not on the pad (still selling at 0), a kit dropped long ago, a
  // colour in the old paint listing, and a library copy of a GW book
  addProduct({ title: 'Space Marines: Test Squad 1', tags: ['Space Marines', 'Warhammer', 'Warhammer 40K'] }, [{ sku: '99120100001', price: '80.00', cost: '45.00', barcode: '5011921000001', policy: 'CONTINUE' }]);
  addProduct({ title: 'Space Marines: Test Squad 2', tags: ['Warhammer'] }, [{ sku: '99120100002', price: '89.00', cost: '50.46', barcode: '5011921000002', policy: 'DENY' }]);
  addProduct({ title: 'Retired Kit' }, [{ sku: '99120109999', price: '60.00', cost: '30.00', policy: 'CONTINUE' }]);
  addProduct({ title: 'Long Gone Kit' }, [{ sku: '99120109998', price: '60.00', policy: 'DENY' }]);
  addProduct({ title: 'Warhammer Colour Paints', type: 'Paints & Hobby', tags: ['Citadel', 'Paints', 'Warhammer', 'Warhammer Colour'] },
    [{ sku: '99189950001', price: '11.60', cost: '6.58', barcode: '5011921100001', policy: 'CONTINUE', pack: 6, option: 'Colour 01' },
      { sku: '99189959999', price: '11.60', cost: '6.58', policy: 'CONTINUE', pack: 6, option: 'Old Colour' }]);
  addProduct({ title: 'Kill Team: Core Manual (Library)', type: 'Role-Playing Game' }, [{ sku: 'DGLRPG-091', price: '0.00' }]);
  // a dice set from another maker, never read
  addProduct({ title: 'Red d20', vendor: 'Dice Goblin NZ', type: 'Dice & Accessories' }, [{ sku: '99120199999', price: '5.00' }]);
  // a helper with every permission a helper can have
  lair.sql.exec("INSERT INTO staff_helpers (customer_id, perms, status, created_at) VALUES (?, ?, 'active', ?)", HELPER, JSON.stringify(STAFF_PERMS), NOW);
});
afterEach(() => {
  Date.now = realNow;
});

/* ---------------- names, kinds and tags ---------------- */

test('round 26: pad names, with GW\'s short forms written out and nothing else changed', () => {
  const cases = [
    ['S/E: Lord-Commander Bastian Carthalos', 'Stormcast Eternals: Lord-Commander Bastian Carthalos'],
    ['Hh:Legion Astartes Melee Weapons Upgrade', 'Horus Heresy: Legion Astartes Melee Weapons Upgrade'],
    ['Horus Heresy:Sot:The Lost And The Damned', 'Horus Heresy: Siege of Terra: The Lost and the Damned'],
    ['Codex: Adeptus Custodes (English)', 'Codex: Adeptus Custodes'],
    ['Battletome: Disciples Of Tzeentch Eng', 'Battletome: Disciples of Tzeentch'],
    ['K/T Datacards: Inquisitorial Agents (Eng', 'Kill Team Datacards: Inquisitorial Agents'],
    ['Aos Skaven + Paint Set Eng/Spa/Port/Lat', 'Age of Sigmar Skaven + Paint Set'],
    ['Blackheart: Claws Of The Maelstrom (Hb)', 'Blackheart: Claws of the Maelstrom (Hardback)'],
    ['Ghazghkull Thraka Prophet O/T Waaagh Pb', 'Ghazghkull Thraka Prophet of the Waaagh (Paperback)'],
    ['Wh Colour: Plastic Glue (15G) (Eu/Au)', 'Warhammer Colour: Plastic Glue (15g)'],
    ['Chaos Black Spray (Uk/Row)', 'Chaos Black Spray'],
    ['Te:Blending Medium 18Ml Row', 'Te: Blending Medium (18ml)'],
    ['Base: Death Korps Drab (12Ml)', 'Base: Death Korps Drab (12ml)'],
    ['Reaver Titan W/Melta Cannon & Chainfist', 'Reaver Titan with Melta Cannon & Chainfist'],
    ['Horus Heresy L/A: Mkiii Tactical Squad', 'Horus Heresy Legiones Astartes: MkIII Tactical Squad'],
    ['Gw Tape Measure', 'GW Tape Measure'],
    ['Lotr: Knights Of Minas Tirith', 'The Lord of the Rings: Knights of Minas Tirith'],
    ['Csm Abaddon The Despoiler', 'Chaos Space Marines Abaddon the Despoiler'],
    ['Lumineth  R-L: Vanari Auralan Wardens', 'Lumineth Realm-lords: Vanari Auralan Wardens'],
    ['Aos: Shattered Dominion: 60 & 90Mm Oval', 'Age of Sigmar: Shattered Dominion: 60 & 90mm Oval'],
    ['Necrons Lokhusts Heavy Destroyer', 'Necrons Lokhusts Heavy Destroyer'],
    ['Combat Patrol: Dark Angels', 'Combat Patrol: Dark Angels'],
    ['Warhammer 40000: Introductory Set (Eng)', 'Warhammer 40,000: Introductory Set'],
  ];
  for (const [from, to] of cases) assert.equal(padTitle(from), to, from);
  // a paint's colour within its range, and its size
  assert.equal(paintColour('B: Mephiston Red 12Ml Row'), 'Mephiston Red');
  assert.equal(paintColour('Tn: Gnarlwood 1 12Ml Row'), 'Gnarlwood 1');
  assert.equal(paintColour('Skink Blue'), 'Skink Blue');
  assert.equal(paintColour('Technical: Mordant Earth (24Ml)'), 'Mordant Earth');
  assert.equal(padSize('Technical: Mordant Earth (24Ml)'), '24ml');
  assert.equal(padSize('Dry: Wrack White'), '');
  // the pad's release dates: Excel's day numbers, or a date and time
  assert.equal(dayKey(46319), '2026-10-24');
  assert.equal(dayKey('2026-10-24 00:00:00'), '2026-10-24');
  assert.equal(dayKey(null), '');
  assert.equal(dayKey('soon'), '');
  assert.equal(seoLine('Codex: Orks'), 'Buy Codex: Orks at Dice Goblin in Auckland, in store or ordered in from Games Workshop.');
});

test('round 26: what goes in from the pad, and its type and tags as the live GW listings have them', () => {
  // no NZ price (trade only), shop fittings, and anything that isn't a GW code are left out
  assert.equal(cleanPadRow(kit(1, { nz_mrp: null })), null);
  assert.equal(cleanPadRow(kit(1, { nz_mrp: 0 })), null);
  assert.equal(cleanPadRow({ ...kit(1), system: 'Fixtures And Fittings', race: 'Fixtures And Fittings - Trade Outlet' }), null);
  assert.equal(cleanPadRow(kit(1, { code: 'DGLRPG-091' })), null);
  assert.equal(cleanPadRow(kit(1, { desc: '  ' })), null);
  const row = cleanPadRow(kit(7, { release: '2026-10-24 00:00:00', barcode: 'n/a', pack: '3', nz_mrp: '$128.00' }));
  assert.equal(row.title, 'Space Marines: Test Squad 7');
  assert.equal(row.mrp, 12800);
  assert.equal(row.trade, 5046);
  assert.equal(row.barcode, '');
  assert.equal(row.pack, 3);
  assert.equal(row.release, '2026-10-24');
  assert.equal(row.type, 'War Game');
  assert.deepEqual(row.tags, ['Warhammer', 'Warhammer 40K', 'Space Marines', 'New release']);
  // a paint: its range and colour
  const pot = cleanPadRow(paint(4, BASE, 'B: Mephiston Red 12Ml Row'));
  assert.equal(pot.rangeKey, 'wh-colour-base');
  assert.equal(pot.colour, 'Mephiston Red');
  assert.equal(pot.type, 'Paints & Hobby');
  assert.deepEqual(pot.tags, ['Warhammer', 'Citadel', 'Paints', 'Warhammer Colour']);
  // kinds: books, gaming gear, brushes and tools, sprays
  const type = (race, system = 'Warhammer 40K', desc = 'Something') => ({ type: padType({ race, system }), tags: padTags({ race, system, desc }) });
  // (books are War Game, as the live listings and the Warhammer skill have them)
  assert.deepEqual(type('Black Library - Warhammer 40K'), { type: 'War Game', tags: ['Warhammer', 'Warhammer 40K', 'Black Library'] });
  // a paint set with miniatures: Paints & Hobby, with its game and faction, as "Space Marines Intercessors + Paints Set"
  assert.deepEqual({ type: padType({ race: '40K - Xenos - Orks', system: 'Warhammer 40K', desc: 'Orks + Paints Eng/Spa/Port/Latv/Rom' }), tags: padTags({ race: '40K - Xenos - Orks', system: 'Warhammer 40K', desc: 'Orks + Paints Eng/Spa/Port/Latv/Rom' }) },
    { type: 'Paints & Hobby', tags: ['Warhammer', 'Warhammer 40K', 'Orks', 'Citadel', 'Warhammer Colour'] });
  assert.equal(padType({ race: 'AOS - Generic', system: 'Age Of Sigmar', desc: 'Aos Paints+Tools Eng/Spa/Port/Latv/Rom' }), 'Paints & Hobby');
  // starter boxes, as the live Kill Team: Starter Set, Introductory Sets and Spearhead: Seraphon
  const starter = (desc, race, system) => padTags({ desc, race, system }).includes('Starter sets');
  assert.equal(starter('Warhammer 40000: Introductory Set (Eng)', '40K - Generic', 'Warhammer 40K'), true);
  assert.equal(starter('Kill Team: Starter Set (English)', 'Kill Team - Generic', 'Kill Team'), true);
  assert.equal(starter('Spearhead: F-E Courts: Charnel Watch', 'AOS - Death - Flesh-Eater Courts', 'Age Of Sigmar'), true);
  assert.equal(starter('Combat Patrol: Dark Angels', '40K - Space Marines - Dark Angels', 'Warhammer 40K'), true);
  assert.equal(starter('Necromunda: Skirmish Core Set', 'Necromunda - Generic', 'Necromunda'), true);
  assert.equal(starter('Combat Patrol Companion (English)', '40K - Generic', 'Warhammer 40K'), false);
  assert.equal(starter('Codex: Orks (English)', '40K - Xenos - Orks', 'Warhammer 40K'), false);
  // no tag ever has a comma (Shopify splits it in two)
  assert.deepEqual(padTags({ desc: 'X', race: '40K - Xenos - Orks, Snakebites', system: 'Warhammer 40K' }), ['Warhammer', 'Warhammer 40K', 'Orks Snakebites']);
  assert.deepEqual(type('Hobby - Play - Figure Case', 'Hobby', 'Warhammer Battle Case'), { type: 'Dice & Accessories', tags: ['Warhammer', 'Accessories'] });
  assert.deepEqual(type('Brush - Base', 'Paint', 'Warhammer Pro: Base Brush Small'), { type: 'Paints & Hobby', tags: ['Warhammer', 'Accessories', 'Citadel', 'Warhammer Pro'] });
  assert.deepEqual(type('Hobby - Build - Glue', 'Hobby', 'Wh Colour: Plastic Glue (15G) (Eu/Au)'), { type: 'Paints & Hobby', tags: ['Warhammer', 'Accessories', 'Citadel', 'Warhammer Colour'] });
  assert.deepEqual(type('Spray - Colour', 'Paint', 'Chaos Black Spray (Uk/Row)'), { type: 'Paints & Hobby', tags: ['Warhammer', 'Citadel', 'Paints'] });
  // factions: the Race's last part, or the one before "Generic"; none for grand alliances, Blood Bowl's teams or Middle-earth's
  const faction = (race, system) => padFaction({ race, system });
  assert.equal(faction('40K - Space Marines - Generic', 'Warhammer 40K'), 'Space Marines');
  assert.equal(faction('40K - Xenos - Leagues Of Votann', 'Warhammer 40K'), 'Leagues of Votann');
  assert.equal(faction('40K - Chaos - Emperors Children', 'Warhammer 40K'), "Emperor's Children");
  assert.equal(faction('AOS - Death - Generic', 'Age Of Sigmar'), null);
  assert.equal(faction('AOS - Generic', 'Age Of Sigmar'), null);
  assert.equal(faction('KT - Imperium - Astra Militarum', 'Kill Team'), 'Astra Militarum');
  assert.equal(faction('Old World - Empire', 'The Old World'), 'Empire of Man');
  assert.equal(faction('HH Astartes - Generic', 'The Horus Heresy'), null);
  assert.equal(faction('Blood Bowl - Skaven', 'Blood Bowl'), null);
  assert.equal(faction('Middle-earth - Humans', 'Middle-earth'), null);
  assert.deepEqual(padTags({ race: 'Chaos Daemons - Khorne', system: 'Chaos Daemons', desc: 'B/K: Bloodmaster' }), ['Warhammer', 'Chaos Daemons', 'Age of Sigmar', 'Warhammer 40K']);
});

/* ---------------- who, and the pad a part at a time ---------------- */

test('round 26: only the owner works the Warhammer tab', async () => {
  for (const [method, path] of [['GET', 'gw'], ['GET', 'gw/plan?action=create'], ['POST', 'gw/pad'], ['POST', 'gw/shop'], ['POST', 'gw/plan'], ['POST', 'gw/apply'], ['POST', 'gw/releases/99120100902']]) {
    const helper = await call(method, path, method === 'POST' ? {} : null, HELPER);
    assert.equal(helper.status, 403, `${method} ${path} for a helper`);
    const member = await call(method, path, method === 'POST' ? {} : null, MEMBER);
    assert.equal(member.status, 403, `${method} ${path} for a member`);
  }
  assert.equal(ok(await call('GET', 'gw')).left, 0);
});

test('round 26: the pad comes a part at a time, in order, and a short file is turned away', async () => {
  const rows = padRows();
  // a part out of order, or another file's part, is turned away
  const first = ok(await call('POST', 'gw/pad', { date: '2026-10-26', part: 1, parts: 6, rows: rows.slice(0, 100) }));
  assert.equal(first.stored, 100);
  assert.equal(said(await call('POST', 'gw/pad', { upload: first.upload, part: 3, parts: 6, rows: rows.slice(200, 300) })), `409 ${W.part}`);
  assert.equal(said(await call('POST', 'gw/pad', { upload: 'someone-else', part: 2, parts: 6, rows: rows.slice(100, 200) })), `409 ${W.part}`);
  assert.equal(said(await call('POST', 'gw/pad', { upload: first.upload, part: 2, parts: 6, rows: Array(201).fill(kit(1)) })), `413 ${W.tooMany}`);
  // a part sent again (its answer was lost) is kept again, once
  ok(await call('POST', 'gw/pad', { upload: first.upload, part: 2, parts: 6, rows: rows.slice(100, 200) }));
  const again = ok(await call('POST', 'gw/pad', { upload: first.upload, part: 2, parts: 6, rows: rows.slice(100, 200) }));
  assert.equal(again.total, 200);
  // the whole pad: fittings and trade-only lines left out
  const done = ok(await upload(rows));
  assert.equal(done.complete, true);
  assert.equal(done.total, rows.length - 2);
  const status = ok(await call('GET', 'gw'));
  assert.equal(status.pad.rows, rows.length - 2);
  assert.equal(status.pad.complete, true);
  assert.equal(status.pad.date, '2026-10-26');
  // a file with only a few lines isn't a whole pad (the plan would stop everything else selling)
  const short = await upload(rows.slice(0, 120));
  assert.equal(said(short), `422 ${W.short(120)}`);
  assert.equal(ok(await call('GET', 'gw')).pad.complete, false);
  assert.equal(said(await call('POST', 'gw/plan', {})), `409 ${W.noPad}`);
  assert.ok(PAD_MIN_ROWS > 120);
});

/* ---------------- the shop and the plan ---------------- */

test('round 26: the plan: new products, paint colours, changes, and lines off the pad', async () => {
  ok(await upload(padRows()));
  assert.equal(said(await call('POST', 'gw/plan', {})), `409 ${W.noShop}`);
  const shop = await readShop();
  // GW codes only: the library copy and the other maker's dice aren't read
  assert.equal(shop.count, 6);
  assert.ok(calls.filter(([what]) => what === 'page').length >= 2, 'read a page at a time');
  const summary = ok(await call('POST', 'gw/plan', {}));
  // new: kits 3 to 520 and the release to come (two of the 520 are in the shop); 29 new Base colours and 2 Technical;
  // the Technical colour still to be released waits
  assert.deepEqual(
    Object.fromEntries(Object.entries(summary.counts).map(([k, v]) => [k, v.todo])),
    { create: 519, range: 31, later: 1, update: 2, drop: 2 },
  );
  assert.equal(summary.left, 519 + 31 + 2 + 2);
  assert.deepEqual(summary.ranges.map((r) => [r.key, r.colours, r.made]), [['wh-colour-base', 29, false], ['wh-colour-technical', 2, false]]);
  // kit 1: a new price and cost; kit 2: keeps selling at 0 again
  assert.deepEqual(JSON.parse(plan(99120100001).changes), {
    price: [8000, 8900], cost: [4500, 5046], variantId: variantOf('99120100001').id, productId: productOf('99120100001').id,
  });
  assert.deepEqual(Object.keys(JSON.parse(plan(99120100002).changes)), ['policy', 'variantId', 'productId']);
  // the colour in the old paint listing matches the pad: nothing to change
  assert.equal(plan(99189950001), undefined);
  // off the pad: the retired kit and the old colour stop at 0; the one already stopped is left alone
  assert.equal(plan(99120109999).action, 'drop');
  assert.equal(plan(99189959999).action, 'drop');
  assert.equal(plan(99120109998), undefined);
  // the lines, 50 a page, for staff to look over
  const page = ok(await call('GET', 'gw/plan?action=create'));
  assert.equal(page.lines.length, 50);
  assert.equal(page.more, true);
  const later = ok(await call('GET', 'gw/plan?action=later')).lines;
  assert.deepEqual(later.map((l) => [l.title, l.release, l.range]), [['Shading Medium', '2026-11-21', 'Warhammer Colour Technical Paints']]);
  const update = ok(await call('GET', 'gw/plan?action=update')).lines.find((l) => l.code === '99120100001');
  assert.deepEqual(update.changes, { price: [8000, 8900], cost: [4500, 5046] });
});

test('round 26: applying: updates and stops, then new products on the till, then each paint range\'s product', async () => {
  ok(await upload(padRows()));
  await readShop();
  ok(await call('POST', 'gw/plan', {}));
  // the first request: updates and stops, together
  const first = ok(await call('POST', 'gw/apply', {}));
  assert.equal(first.done, 4);
  assert.equal(variantOf('99120100001').price, '89.00');
  assert.equal(variantOf('99120100001').cost, '50.46');
  assert.equal(variantOf('99120100002').policy, 'CONTINUE');
  assert.equal(variantOf('99120109999').policy, 'DENY');
  assert.equal(variantOf('99189959999').policy, 'DENY');
  // then new products, five a request
  const second = ok(await call('POST', 'gw/apply', {}));
  assert.equal(second.done, APPLY_BATCH.create);
  const creates = calls.filter(([what]) => what === 'create');
  assert.equal(creates.at(-1)[1].length, APPLY_BATCH.create);
  // (by game, then name: kit 10 is in the first five)
  const made = productOf('99120100010');
  assert.equal(made.title, 'Space Marines: Test Squad 10');
  assert.deepEqual(made.input, {
    title: 'Space Marines: Test Squad 10',
    vendor: 'Games Workshop',
    productType: 'War Game',
    tags: ['Warhammer', 'Warhammer 40K', 'Space Marines'],
    status: 'ACTIVE',
    descriptionHtml: '<p>Space Marines: Test Squad 10</p>',
    seo: { description: 'Buy Space Marines: Test Squad 10 at Dice Goblin in Auckland, in store or ordered in from Games Workshop.' },
    productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
    variants: [{
      optionValues: [{ optionName: 'Title', name: 'Default Title' }],
      sku: '99120100010',
      barcode: '5011921000010',
      price: '89.00',
      inventoryPolicy: 'CONTINUE',
      inventoryItem: { tracked: true, cost: '50.46' },
      inventoryQuantities: [{ locationId: LOCATION, name: 'available', quantity: 0 }],
    }],
  });
  // on the till only (not the website or the Shop app until it has GW's picture)
  assert.deepEqual([...made.published], [POS]);
  // the rest, to the end
  const end = await applyAll();
  assert.equal(end.left, 0);
  assert.deepEqual(end.errors, []);
  const status = ok(await call('GET', 'gw'));
  assert.equal(status.counts.create.done, 519);
  assert.equal(status.counts.range.done, 31);
  assert.equal(status.counts.later.todo, 1);
  // each paint range is one product: made with its first 25 colours, the rest added to it
  const base = productOf('99189950002');
  assert.equal(base.title, 'Warhammer Colour Base Paints');
  assert.equal(base.input.productOptions[0].name, 'Colours');
  assert.equal(base.input.variants.length, APPLY_BATCH.rangeFirst);
  assert.deepEqual(base.input.tags, ['Warhammer', 'Citadel', 'Paints', 'Warhammer Colour']);
  assert.equal(base.input.descriptionHtml, '<p>Warhammer Colour Base Paints</p>');
  assert.equal(base.variants.length, 29);
  assert.deepEqual(calls.filter(([what, id]) => what === 'add' && id === base.id).map(([, , skus]) => skus.length), [4]);
  const pot = variantOf('99189950002');
  assert.equal(pot.option, 'Colour 02');
  assert.equal(pot.pack, 6);
  assert.equal(pot.policy, 'CONTINUE');
  // a range with two sizes says each colour's size
  assert.deepEqual(productOf('99189950101').variants.map((id) => variants.get(id).option).sort(), ['Blending Medium (18ml)', 'Mordant Earth (24ml)']);
  assert.deepEqual(lair.sql.exec('SELECT key FROM gw_ranges ORDER BY key').toArray().map((r) => r.key), ['wh-colour-base', 'wh-colour-technical']);
  // the colour already in the old paint listing isn't made again
  assert.equal([...variants.values()].filter((v) => v.sku === '99189950001').length, 1);
  // nothing went to Shopify twice
  const sent = calls.filter(([what]) => what === 'create').flatMap(([, codes]) => codes.flat())
    .concat(calls.filter(([what]) => what === 'add').flatMap(([, , skus]) => skus));
  assert.equal(sent.length, new Set(sent).size);
  // the next week: the same pad changes nothing, once the shop's been read again
  assert.equal(said(await call('POST', 'gw/plan', {})), `409 ${W.shopAgain}`);
  ok(await upload(padRows()));
  await readShop();
  const again = ok(await call('POST', 'gw/plan', {}));
  assert.equal(again.left, 0);
  assert.equal(again.counts.later.todo, 1);
});

test('round 26: a release still to come is made hidden and goes on sale at 10am on its pre-order day', async () => {
  ok(await upload(padRows()));
  await readShop();
  ok(await call('POST', 'gw/plan', {}));
  await applyAll();
  const soon = productOf('99120100902');
  assert.equal(soon.status, 'DRAFT');
  assert.equal(soon.release, '2026-11-21');
  assert.ok(soon.input.tags.includes('New release'));
  const [release] = ok(await call('GET', 'gw')).releases;
  assert.deepEqual({ ...release, onSaleAt: undefined }, { code: '99120100902', title: 'Combat Patrol: Test Marines', release: '2026-11-21', onSale: '2026-11-14', onSaleAt: undefined, error: null });
  assert.equal(release.onSaleAt, at('2026-11-14', 10));
  // maintenance: not before then
  nowIs(at('2026-11-14', 9, 55));
  assert.equal(await lair.gwActivateReleases(Date.now()), null);
  assert.equal(soon.status, 'DRAFT');
  // staff can bring it forward (GW's email says pre-orders open Friday), but not past its release or before today
  assert.equal(said(await call('POST', 'gw/releases/99120100902', { onSale: '2026-11-22' })), `422 ${W.onSaleDay}`);
  assert.equal(said(await call('POST', 'gw/releases/99120100902', { onSale: '2026-11-01' })), `422 ${W.onSaleDay}`);
  assert.equal(said(await call('POST', 'gw/releases/99120109999', { onSale: '2026-11-14' })), `404 ${W.noRelease}`);
  nowIs(at('2026-11-12', 9));
  const moved = ok(await call('POST', 'gw/releases/99120100902', { onSale: '2026-11-13' }));
  assert.equal(moved.releases[0].onSaleAt, at('2026-11-13', 10));
  nowIs(at('2026-11-13', 10, 5));
  assert.deepEqual(await lair.gwActivateReleases(Date.now()), { activated: ['Combat Patrol: Test Marines'] });
  assert.equal(soon.status, 'ACTIVE');
  assert.deepEqual(ok(await call('GET', 'gw')).releases, []);
  assert.equal(await lair.gwActivateReleases(Date.now()), null);
});

/* ---------------- nothing made twice ---------------- */

test('round 26: a batch Shopify never answered is looked for by SKU before anything is made again', async () => {
  ok(await upload(padRows()));
  await readShop();
  ok(await call('POST', 'gw/plan', {}));
  ok(await call('POST', 'gw/apply', {}));
  // the answer to five new products is lost: Shopify made them, the Lair can't know yet
  trouble.create = 'lost';
  const lost = ok(await call('POST', 'gw/apply', {}));
  assert.equal(lost.done, 0);
  assert.equal(lost.busy, W.busy);
  const claimed = lair.sql.exec("SELECT code FROM gw_plan WHERE status = 'sending'").toArray().map((r) => r.code);
  assert.equal(claimed.length, APPLY_BATCH.create);
  // the next requests carry on with other lines and never send those five again
  ok(await call('POST', 'gw/apply', {}));
  ok(await call('POST', 'gw/apply', {}));
  const sent = calls.filter(([what]) => what === 'create').flatMap(([, codes]) => codes.flat());
  for (const code of claimed) assert.equal(sent.filter((c) => c === code).length, 1, code);
  // two minutes on, they're looked for by SKU: made, so they only need to be on the till
  nowIs(NOW + STUCK_AFTER + 1000);
  ok(await call('POST', 'gw/apply', {}));
  assert.deepEqual(calls.filter(([what]) => what === 'find').at(-1)[1].sort(), [...claimed].sort());
  for (const code of claimed) assert.equal(plan(code).status, 'publish');
  ok(await call('POST', 'gw/apply', {}));
  for (const code of claimed) {
    assert.equal(plan(code).status, 'done');
    assert.deepEqual([...productOf(code).published], [POS]);
    assert.equal([...variants.values()].filter((v) => v.sku === code).length, 1);
  }
});

test('round 26: Shopify busy, turning a product down, or missing a permission', async () => {
  ok(await upload(padRows()));
  await readShop();
  ok(await call('POST', 'gw/plan', {}));
  ok(await call('POST', 'gw/apply', {}));
  // its bucket was empty: nothing ran, so the batch goes back on the list untried
  trouble.create = 'throttle';
  const busy = ok(await call('POST', 'gw/apply', {}));
  assert.equal(busy.busy, W.busy);
  assert.ok(busy.wait > 0);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM gw_plan WHERE status = 'sending'").one().n, 0);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM gw_plan WHERE tries > 0").one().n, 0);
  // turned down: tried three times, then left for staff to see with Shopify's words
  trouble.create = 'userErrors';
  ok(await call('POST', 'gw/apply', {}));
  ok(await call('POST', 'gw/apply', {}));
  const third = ok(await call('POST', 'gw/apply', {}));
  assert.equal(third.errors.length, APPLY_BATCH.create);
  assert.deepEqual(third.errors[0], { code: third.errors[0].code, title: plan(third.errors[0].code).title, error: 'Title is too long' });
  assert.equal(plan(third.errors[0].code).status, 'error');
  // the app's new permissions not approved yet: the words say what to do, straight away
  trouble.create = 'denied';
  const denied = ok(await call('POST', 'gw/apply', {}));
  assert.equal(denied.errors.length, APPLY_BATCH.create);
  assert.equal(denied.errors[0].error, W.scopes);
  // the errors show first in the plan's list
  const lines = ok(await call('GET', 'gw/plan?action=create')).lines;
  assert.equal(lines[0].status, 'error');
  trouble.create = null;
  // made, but the till listing didn't go through: put on the till by the next request
  trouble.publish = true;
  ok(await call('POST', 'gw/apply', {}));
  const waiting = lair.sql.exec("SELECT code, product_id FROM gw_plan WHERE status = 'publish'").toArray();
  assert.equal(waiting.length, APPLY_BATCH.create);
  trouble.publish = false;
  ok(await call('POST', 'gw/apply', {}));
  for (const row of waiting) {
    assert.equal(plan(row.code).status, 'done');
    assert.ok(products.get(row.product_id).published.has(POS));
  }
});

test('round 26: two staff pages applying at once never send the same line twice', async () => {
  ok(await upload(padRows()));
  await readShop();
  ok(await call('POST', 'gw/plan', {}));
  for (let i = 0; i < 60; i += 1) {
    const both = await Promise.all([call('POST', 'gw/apply', {}), call('POST', 'gw/apply', {})]);
    for (const res of both) ok(res);
    if (!both[0].data.left && !both[1].data.left) break;
  }
  await applyAll();
  const sent = calls.filter(([what]) => what === 'create').flatMap(([, codes]) => codes.flat())
    .concat(calls.filter(([what]) => what === 'add').flatMap(([, , skus]) => skus));
  assert.equal(sent.length, new Set(sent).size);
  // one product per paint range
  assert.equal([...products.values()].filter((p) => p.title === 'Warhammer Colour Base Paints').length, 1);
  assert.equal(ok(await call('GET', 'gw')).left, 0);
});

test('round 26: a new pad while a plan was waiting starts again, and the shop must be read after the pad', async () => {
  ok(await upload(padRows()));
  await readShop();
  ok(await call('POST', 'gw/plan', {}));
  // a new pad: the old plan goes; applying needs a new one
  ok(await upload(padRows()));
  assert.equal(said(await call('POST', 'gw/apply', {})), `409 ${W.noPlan}`);
  assert.equal(said(await call('POST', 'gw/plan', {})), `409 ${W.noShop}`);
  await readShop();
  ok(await call('POST', 'gw/plan', {}));
  assert.ok(ok(await call('POST', 'gw/apply', {})).done > 0);
});

/* ---------------- round 25's advance orders wait for release day ---------------- */

test('round 26: an advance order that comes in before release day is told on release day, not before', async () => {
  const mails = [];
  lair.mail = async (message) => {
    mails.push(message);
    return { ok: true, attempted: true, status: 200 };
  };
  lair.env.RESEND_API_KEY = 'test-key';
  lair.env.FROM_EMAIL = 'gobgob@example.com';
  lair.env.STAFF_EMAIL = 'staff@example.com';
  const SOON = 'gid://shopify/ProductVariant/77';
  let stock = 0;
  lair.shopify.gwStock = async () => ({
    variants: new Map([[SOON, { id: SOON, code: '99120100902', title: 'Combat Patrol: Test Marines', available: stock, policy: 'CONTINUE', tracked: true, pack: 1, release: '2026-11-21' }]]),
    overrides: {},
  });
  lair.shopify.gwOrderInfo = async (id) => ({ id, name: '#3001', createdAt: new Date(Date.now()).toISOString(), shippingLine: { title: 'Collect from the Lair', deliveryCategory: 'pick-up' } });
  lair.shopify.orderGiftBuyer = async () => ({ name: '#3001', email: 'kai@example.com', firstName: 'Kai' });
  lair.shopify.gwMarkOrder = async () => true;
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  lair.shopify.gwState = async (ids) => new Map(ids.map((id) => [id, { available: id === SOON ? stock : NaN, cancelledAt: null, currentQuantity: NaN }]));
  // Saturday 14 November: pre-orders open, Kai orders it for pickup
  nowIs(at('2026-11-14', 11));
  stock = -1;
  const order = { id: 3001, admin_graphql_api_id: 'gid://shopify/Order/3001', name: '#3001', source_name: 'web',
    line_items: [{ id: 1, variant_id: 77, sku: '99120100902', vendor: 'Games Workshop', name: 'Combat Patrol: Test Marines', title: 'Combat Patrol: Test Marines', quantity: 1, price: '210.00', properties: [] }] };
  const res = await lair.fetch(new Request('https://lair.test/internal/orders-paid', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body: JSON.stringify(order) }));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  while (pending.length) await Promise.all(pending.splice(0));
  assert.equal(lair.sql.exec('SELECT release FROM gw_orderins').one().release, '2026-11-21');
  const told = mails.filter((m) => m.to === 'kai@example.com');
  assert.equal(told.length, 1, 'the ordered-in email');
  // Thursday 19 November: GW's box comes early, staff add it to stock
  nowIs(at('2026-11-19', 15));
  stock = 0;
  await lair.gwReconcile(Date.now());
  while (pending.length) await Promise.all(pending.splice(0));
  assert.equal(lair.sql.exec('SELECT arrived FROM gw_orderins').one().arrived, 1);
  assert.equal(lair.sql.exec('SELECT ready_at FROM gw_orders').one().ready_at, null);
  assert.equal(mails.filter((m) => m.to === 'kai@example.com').length, 1, 'no It\'s in before release day');
  assert.equal(mails.filter((m) => m.to === 'staff@example.com').length, 0, 'no parcels or pickups for the shop yet');
  // release day, before 8am: still waiting; from 8am, told
  nowIs(at('2026-11-21', 0, 10));
  await lair.gwReconcile(Date.now());
  assert.equal(mails.filter((m) => m.to === 'kai@example.com').length, 1);
  nowIs(at('2026-11-21', 8, 5));
  const result = await lair.gwReconcile(Date.now());
  while (pending.length) await Promise.all(pending.splice(0));
  assert.deepEqual(result.released, ['#3001']);
  assert.equal(mails.filter((m) => m.to === 'kai@example.com').length, 2, 'It\'s in, on release day');
  assert.equal(mails.filter((m) => m.to === 'staff@example.com').length, 1);
  assert.ok(lair.sql.exec('SELECT ready_at FROM gw_orders').one().ready_at);
});

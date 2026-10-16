// Round 17: Help me pick (contract v17, sections 1 to 4, 6, 7 and the PICK_MESSAGES words of 8): the catalogue from
// Shopify, facts (the seed, basic facts, Workers AI), the matcher, quiz sessions, ratings, a member's picks, the staff
// check list, sync and report. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings } from '../src/core.js';
import {
  PICK_LIMITS,
  PICK_DATA, PICK_MESSAGES, PICK_AI_MODEL, PICK_TABLES, basicFacts, catalogRowOf, cleanAnswers, firstVideo, blurbOf, jaccard, matchGames, parsePlayersText,
  parseTimeText, pickKey, pickNorm, playerTypeOf, shelfParts, similarity, validFacts, wildcardIndex,
} from '../src/pick.js';
import { PICK_VOCAB } from '../src/pick-vocab.js';
import { shopifyPaceWait } from '../src/shopify.js';
import { PICK_SEED, PICK_SEED_VERSION } from '../src/pick-seed.js';
import { PICK_KNOWN } from '../src/pick-known.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Friday 16 October 2026, 1:00pm in Auckland (NZDT, UTC+13): round 17
const NOW = Date.UTC(2026, 9, 16, 0, 0);
const realNow = Date.now;
const time = new LairTime('Pacific/Auckland');

/* ---------------- helpers (as test/round16-wishlist.test.js) ---------------- */
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
  return { db, storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) }, waitUntil: () => {} };
}

// Members by Shopify customer ID (made up); the main staff account; a helper with and without the library permission
const SAM = '1001';
const KIRI = '1002';
const STAFF = 'staff';
const HELPER = '2001';
const LIBRARIAN = '2002';
const COMMUNITY = '2003';
const PERSON = {
  [STAFF]: { staff: true, role: 'owner', perms: [] },
  [HELPER]: { staff: true, role: 'helper', perms: ['checkin', 'tables'] },
  [LIBRARIAN]: { staff: true, role: 'helper', perms: ['library'] },
  [COMMUNITY]: { staff: true, role: 'helper', perms: ['community'] },
};

/** A facts object (contract 1.2) with sensible defaults */
const facts = (over = {}) => ({
  kind: 'game', players: { min: 2, max: 4, best: [4] }, time: { min: 30, max: 45 }, weight: 2.0, age: 8, mode: 'competitive', vibes: ['thinky'],
  themes: ['abstract'], styles: ['set-collection'], reading: 'some', access: { colourBlind: null, easyPieces: null }, table: 'single', expansionOf: null,
  rpg: null, summary: 'A game from the test library with a plain summary.', confidence: 'high', ...over,
});

// The test library: each { id, title, code, facts, created? (days ago on Shopify), copies?, tags? }
const G = {
  catan: '8100000000001', ticket: '8100000000002', pandemic: '8100000000003', codenames: '8100000000004', dixit: '8100000000005', azul: '8100000000006',
  wingspan: '8100000000007', scythe: '8100000000008', uno: '8100000000009', haba: '8100000000010', seafarers: '8100000000011', adv1: '8100000000012',
  adv2: '8100000000013', dnd: '8100000000014', coc: '8100000000015', cards: '8100000000016', spirit: '8100000000017', sushi: '8100000000018',
};
const LIBRARY = [
  { id: G.catan, title: 'Catan', code: 'DGL34-M011', facts: facts({ players: { min: 3, max: 4, best: [4] }, time: { min: 60, max: 90 }, weight: 2.3, age: 10, vibes: ['thinky'], themes: ['farming', 'history'], styles: ['trading', 'dice-rolling', 'negotiation'] }) },
  { id: G.ticket, title: 'Ticket to Ride', code: 'DGL56-M020', facts: facts({ players: { min: 2, max: 5, best: [4] }, time: { min: 45, max: 60 }, weight: 1.8, vibes: ['chill'], themes: ['trains', 'travel'], styles: ['route-building', 'set-collection'], reading: 'light' }) },
  { id: G.pandemic, title: 'Pandemic', code: 'DGL34-M040', facts: facts({ players: { min: 2, max: 4, best: [4] }, time: { min: 45, max: 60 }, weight: 2.4, mode: 'coop', vibes: ['thinky'], themes: ['science'], styles: ['puzzle', 'set-collection'] }) },
  { id: G.codenames, title: 'Codenames', code: 'DGL7+-S010', facts: facts({ players: { min: 2, max: 8, best: [6, 8] }, time: { min: 15, max: 20 }, weight: 1.3, age: 14, mode: 'team', vibes: ['laughs'], themes: ['words', 'crime'], styles: ['word', 'party', 'deduction'], reading: 'heavy' }) },
  { id: G.dixit, title: 'Dixit', code: 'DGL56-M011', facts: facts({ players: { min: 3, max: 6, best: [5, 6] }, time: { min: 30, max: 30 }, weight: 1.2, vibes: ['laughs', 'chill'], themes: ['art'], styles: ['storytelling', 'bluffing'], reading: 'light' }) },
  { id: G.azul, title: 'Azul', code: 'DGL34-S004', facts: facts({ players: { min: 2, max: 4, best: [2] }, time: { min: 30, max: 45 }, weight: 1.8, vibes: ['chill'], themes: ['abstract', 'art'], styles: ['pattern-building', 'drafting'], reading: 'light', access: { colourBlind: true, easyPieces: true } }) },
  { id: G.wingspan, title: 'Wingspan', code: 'DGL56-M090', facts: facts({ players: { min: 1, max: 5, best: [3] }, time: { min: 40, max: 70 }, weight: 2.4, vibes: ['chill', 'thinky'], themes: ['nature', 'animals'], styles: ['engine-building', 'set-collection'] }), created: 20 },
  { id: G.scythe, title: 'Scythe', code: 'DGL56-L030', facts: facts({ players: { min: 1, max: 5, best: [4] }, time: { min: 90, max: 115 }, weight: 3.4, age: 14, vibes: ['thinky', 'cutthroat'], themes: ['history', 'war'], styles: ['area-control', 'engine-building'], table: 'double' }) },
  { id: G.uno, title: 'Uno', code: 'DGL7+-S020', facts: facts({ players: { min: 2, max: 10, best: [4, 5] }, time: { min: 15, max: 30 }, weight: 1.1, age: 7, vibes: ['laughs', 'cutthroat'], themes: ['abstract'], styles: ['take-that'], reading: 'light' }) },
  { id: G.haba, title: 'Animal Upon Animal', code: 'DGLF-S002', facts: facts({ players: { min: 2, max: 4, best: [3] }, time: { min: 10, max: 15 }, weight: 1.0, age: 4, vibes: ['laughs'], themes: ['animals', 'cute'], styles: ['dexterity'], reading: 'light', access: { colourBlind: null, easyPieces: true } }) },
  { id: G.seafarers, title: 'Catan: Seafarers', code: 'DGL34-M012', facts: facts({ kind: 'expansion', expansionOf: G.catan, players: { min: 3, max: 4, best: [4] }, time: { min: 90, max: 120 }, weight: 2.5, themes: ['adventure'], styles: ['trading'] }) },
  { id: G.adv1, title: 'Adventure Games: The Dungeon', code: 'DGL34-S002', facts: facts({ players: { min: 1, max: 4, best: [2] }, time: { min: 60, max: 90 }, weight: 1.9, mode: 'coop', vibes: ['thinky'], themes: ['adventure', 'mystery'], styles: ['storytelling', 'deduction'], reading: 'heavy' }) },
  { id: G.adv2, title: 'Adventure Games: Monochrome Inc.', code: 'DGL34-S001', facts: facts({ players: { min: 1, max: 4, best: [2] }, time: { min: 60, max: 90 }, weight: 1.9, mode: 'coop', vibes: ['thinky'], themes: ['adventure', 'mystery'], styles: ['storytelling', 'deduction'], reading: 'heavy' }) },
  { id: G.dnd, title: 'D&D Starter Set', code: 'DGLRPG-010', facts: facts({ kind: 'rpg', players: { min: 2, max: 6, best: [5] }, time: { min: 180, max: 240 }, weight: 3.0, age: 12, mode: 'coop', vibes: ['laughs'], themes: ['fantasy', 'adventure'], styles: ['storytelling', 'campaign'], reading: 'heavy', rpg: { system: 'D&D 5e', starter: true, setting: 'fantasy', type: 'starter' } }) },
  { id: G.coc, title: 'Call of Cthulhu Keeper Rulebook', code: 'DGLRPG-006', facts: facts({ kind: 'rpg', players: { min: 2, max: 6, best: [4] }, time: { min: 180, max: 240 }, weight: 3.0, age: 16, mode: 'coop', vibes: ['thinky'], themes: ['horror', 'mystery'], styles: ['storytelling'], reading: 'heavy', rpg: { system: 'Call of Cthulhu 7e', starter: false, setting: 'horror', type: 'core' } }) },
  { id: G.cards, title: 'Card Sleeves', code: '', facts: facts({ kind: 'other' }) },
  { id: G.spirit, title: 'Spirit Island', code: 'DGL34-L050', facts: facts({ players: { min: 1, max: 4, best: [2] }, time: { min: 90, max: 120 }, weight: 4.1, age: 13, mode: 'coop', vibes: ['thinky'], themes: ['fantasy', 'nature'], styles: ['area-control', 'puzzle'], table: 'double' }) },
  { id: G.sushi, title: 'Sushi Go Party!', code: 'DGL7+-S030', facts: facts({ players: { min: 2, max: 8, best: [4, 5] }, time: { min: 20, max: 20 }, weight: 1.2, vibes: ['laughs', 'chill'], themes: ['food', 'cute'], styles: ['drafting', 'set-collection'], reading: 'light' }) },
];
const variantOf = (productId) => String(Number(productId) + 1000000);

/** A library product as Shopify's LairPickCatalog gives it */
const node = (g, over = {}) => ({
  id: `gid://shopify/Product/${g.id}`, handle: pickNorm(g.title).replace(/ /g, '-'), title: `${g.title} (Library)`, status: 'ACTIVE', tags: g.tags || ['Board Game Rental'],
  vendor: 'Test Games', createdAt: new Date(NOW - (g.created ?? 400) * DAY).toISOString(), updatedAt: new Date(NOW - DAY).toISOString(),
  descriptionHtml: `<p><strong>${g.title}</strong> is a board game.</p><p>🎥 <a href="https://www.youtube.com/watch?v=abc123XYZ_-">Watch how to play on YouTube</a></p>`,
  featuredMedia: { preview: { image: { url: `https://cdn.shopify.com/s/files/1/${g.id}.png` } } },
  variants: { nodes: [{ id: `gid://shopify/ProductVariant/${variantOf(g.id)}`, inventoryQuantity: g.copies ?? 1, inventoryItem: { tracked: true } }] },
  libraryCode: g.code ? { value: g.code } : null, players: { value: '2–4' }, playTime: { value: '30 min' }, difficulty: { value: 'Medium' },
  missingPieces: null, missingNote: null, blurb: { value: `Borrow ${g.title} at Dice Goblin. A board game for the test.` }, shopCopy: null, ...over,
});

let lair;
let ctx;
/** A new Lair on `ctx` with the given seed (applied as it starts), everyone looked up as PERSON says */
function start(seed = Object.fromEntries(LIBRARY.map((g) => [g.id, g.facts])), version = 'test-1') {
  PICK_DATA.seed = seed;
  PICK_DATA.seedVersion = version;
  lair = new Lair(ctx, { CURRENCY: 'NZD' });
  lair.person = async (id) => ({ customerId: id || null, staff: false, gm: false, tags: [], role: null, perms: [], ...(PERSON[id] || {}) });
  lair.rulesCache = rulesFromSettings({}, [], []);
  lair.rulesLoadedAt = NOW + 365 * DAY;
  return lair;
}
/** The catalogue as a full sync would save it, without Shopify */
const catalogue = (list = LIBRARY, shop = null) => lair.saveCatalog(list.map((g) => node(g)), shop, { full: true, now: Date.now() });

let client = 0;
async function call(method, path, body, customer = '', headers = {}) {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, 'X-Lair-Client': headers.client ?? `203.0.113.${client}`, ...headers },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  }));
  return { status: response.status, data: await response.json() };
}
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const ids = (cards) => cards.map((c) => c.productId);
const titles = (cards) => cards.map((c) => c.title);
const hold = (productId, customerId = KIRI, until = NOW + 2 * DAY, extra = {}) => lair.sql.exec(
  `INSERT INTO library_holds (id, variant_id, product_id, title, shelf_code, handle, copies, customer_id, status, until, created_by, created_at, updated_at)
   VALUES (?, ?, ?, 'x', '', '', NULL, ?, 'held', ?, 'member', ?, ?)`,
  extra.id || `lh_${productId}_${customerId}`, variantOf(productId), productId, customerId, until, extra.createdAt ?? NOW, NOW,
);
const loan = (productId, customerId = SAM, status = 'out', extra = {}) => lair.sql.exec(
  `INSERT INTO library_loans (id, variant_id, product_id, title, customer_id, hold_id, status, out_at, returned_at, out_by, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'staff', ?, ?)`,
  extra.id || `ln_${productId}_${customerId}_${status}`, variantOf(productId), extra.noProduct ? null : productId, extra.title || 'x', customerId, status,
  extra.outAt ?? NOW - 10 * DAY, status === 'returned' ? extra.returnedAt ?? NOW - DAY : null, NOW, NOW,
);

const realFetch = globalThis.fetch;
let reached = [];
beforeEach(() => {
  reached = [];
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  Date.now = () => NOW;
  client += 1;
  ctx = fakeCtx();
  start();
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  PICK_DATA.seed = PICK_SEED;
  PICK_DATA.seedVersion = PICK_SEED_VERSION;
  PICK_DATA.known = PICK_KNOWN;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

/* ---------------- the words, the vocabulary and the placeholders ---------------- */

test('pick (round 17): the words, word for word (contract section 8), and the vocabulary is the tagging work\'s', () => {
  assert.deepEqual(PICK_MESSAGES, {
    login: 'Log in to save your picks.',
    loginRate: 'Log in to rate games.',
    product: "That isn't one of our library games. Refresh the page and try again.",
    gone: 'Those picks have gone. Take the quiz again for fresh ones.',
    notYours: "Those picks aren't yours to change. Take the quiz again to make your own.",
    email: "That email address doesn't look right. Check it and try again.",
    busy: 'Gobgob needs a breather. Try again in a few minutes.',
    game: 'Pick a game from the library to bring to your table.',
    facts: "That game's details don't look right: <field>.",
  });
  assert.deepEqual(Object.keys(PICK_VOCAB), ['kinds', 'modes', 'vibes', 'reading', 'tables', 'confidence', 'rpgTypes', 'themes', 'styles']);
  assert.equal(PICK_VOCAB.themes.length, 28);
  assert.equal(PICK_VOCAB.styles.length, 39);
  // The tagging work (16 Oct 2026): every library game's facts, each one valid as it stands (the seed is never clamped),
  // and the famous games for "Games you already love". Checked one by one, so a bad entry names itself.
  assert.equal(PICK_SEED_VERSION, '2026-10-16a');
  const seeded = Object.entries(PICK_SEED);
  assert.equal(seeded.length, 680, 'every active library game on 16 Oct 2026');
  const badSeed = seeded.filter(([id, facts]) => !/^\d{1,20}$/.test(id) || !validFacts(facts).ok).map(([id, facts]) => `${id}: ${validFacts(facts).field}`);
  assert.equal(badSeed.join('; '), '', 'every seeded game is valid');
  assert.ok(PICK_KNOWN.length >= 100, 'about 120 famous games');
  const badKnown = PICK_KNOWN.filter((k) => typeof k.title !== 'string' || !k.title.trim() || !Array.isArray(k.aliases)).map((k) => String(k.title));
  assert.equal(badKnown.join('; '), '', 'every famous game has a title and aliases');
  assert.equal(PICK_AI_MODEL, '@cf/google/gemma-4-26b-a4b-it');
});

test('pick: session ids are 10 characters and edit keys 20, from crypto.getRandomValues, with no look-alikes', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i += 1) {
    const id = pickKey(10);
    const key = pickKey(20);
    assert.match(id, /^[A-HJ-NP-Za-hj-km-np-z2-9]{10}$/);
    assert.match(key, /^[A-HJ-NP-Za-hj-km-np-z2-9]{20}$/);
    assert.doesNotMatch(id + key, /[0O1Iil]/);
    seen.add(id);
  }
  assert.equal(seen.size, 300, 'no repeats');
});

/* ---------------- reading the listings (basic facts) ---------------- */

test('basic facts: the listing texts the store really uses ("2–4", "2-6", "1–5+", "2+", "20 min", "60–90 min", "1–2 hours", Easy/Medium/Hard)', () => {
  assert.deepEqual(parsePlayersText('2–4'), { min: 2, max: 4 });
  assert.deepEqual(parsePlayersText('2-6'), { min: 2, max: 6 });
  assert.deepEqual(parsePlayersText('1–5+'), { min: 1, max: 5 });
  assert.deepEqual(parsePlayersText('2+'), { min: 2, max: 6 }, '"2+" is the minimum plus 4, never 99');
  assert.deepEqual(parsePlayersText('3+'), { min: 3, max: 7 });
  assert.deepEqual(parsePlayersText('2'), { min: 2, max: 2 });
  assert.deepEqual(parsePlayersText('4–20'), { min: 4, max: 20 });
  assert.equal(parsePlayersText(''), null);
  assert.equal(parsePlayersText(null), null);
  assert.deepEqual(parseTimeText('20 min'), { min: 15, max: 20 });
  assert.deepEqual(parseTimeText('60–90 min'), { min: 60, max: 90 });
  assert.deepEqual(parseTimeText('60-90 min'), { min: 60, max: 90 });
  assert.deepEqual(parseTimeText('1–2 hours'), { min: 60, max: 120 });
  assert.deepEqual(parseTimeText('60+ min'), { min: 60, max: 90 });
  assert.deepEqual(parseTimeText('1–8 hours'), { min: 60, max: 480 });
  assert.deepEqual(parseTimeText('30 min per player', 4), { min: 90, max: 120 });
  assert.deepEqual(parseTimeText('5 min per case'), { min: 4, max: 5 });
  assert.equal(parseTimeText(null), null);

  const row = (over) => ({ product_id: '9', title: 'New Game', raw_title: 'New Game (Library)', shelf_code: 'DGL34-M099', tags: '["Board Game Rental"]', players_text: '2–4', time_text: '20 min', difficulty: 'Easy', blurb: null, ...over });
  const easy = basicFacts(row({}));
  assert.deepEqual([easy.players, easy.time, easy.weight, easy.age, easy.mode, easy.confidence, easy.reading, easy.table, easy.kind], [{ min: 2, max: 4, best: [3] }, { min: 15, max: 20 }, 1.5, 8, 'competitive', 'low', 'some', 'single', 'game']);
  assert.deepEqual([easy.vibes, easy.themes, easy.styles, easy.summary], [['thinky'], ['abstract'], ['set-collection'], 'New Game, from the library.']);
  assert.equal(basicFacts(row({ difficulty: 'Medium' })).weight, 2.5);
  assert.equal(basicFacts(row({ difficulty: 'Hard' })).weight, 3.5);
  assert.equal(basicFacts(row({ difficulty: null })).weight, 2.0);
  assert.deepEqual(basicFacts(row({ players_text: '1–5+' })).players, { min: 1, max: 5, best: [3] });
  assert.deepEqual(basicFacts(row({ players_text: '2-6', time_text: '1–2 hours' })).time, { min: 60, max: 120 });
  // ages from the blurb or tags; co-op and vibes and words from the tags; the blurb's first sentence as the summary
  const tagged = basicFacts(row({
    tags: JSON.stringify(['Board Game Rental', 'Co-op', 'Party', 'Family Games', 'Adventure', 'Deduction', 'Strategy']),
    blurb: 'Co-op real-time detective game for ages 6+: spot clues! More words here.',
  }));
  assert.deepEqual([tagged.mode, tagged.vibes, tagged.themes, tagged.styles, tagged.age, tagged.summary], ['coop', ['laughs', 'chill'], ['adventure'], ['party', 'deduction'], 6, 'Co-op real-time detective game for ages 6+: spot clues.'], 'a tag that is a vocabulary word (Party, Deduction) is a style');
  assert.equal(basicFacts(row({ title: 'Catan: Seafarers Expansion', raw_title: 'Catan: Seafarers Expansion (Library)' })).kind, 'expansion');
  const book = basicFacts(row({ title: 'Blades in the Dark', shelf_code: 'DGLRPG-005', players_text: null, time_text: null }));
  assert.deepEqual([book.kind, book.mode, book.reading, book.rpg, book.players.min, book.players.max, book.time], ['rpg', 'competitive', 'some', { system: 'Blades in the Dark', starter: false, setting: 'fantasy', type: 'core' }, 2, 6, { min: 180, max: 240 }]);
  for (const f of [easy, tagged, book]) assert.equal(validFacts(f).ok, true, JSON.stringify(validFacts(f)));
});

test('the catalogue row: "(Library)" off the title, the shelf code upper case, copies only when tracked, in-store-only by tag handle, the blurb and video', () => {
  const base = LIBRARY[0];
  const r = catalogRowOf(node(base, { title: 'Catan (library)', libraryCode: { value: 'dgl34-m011' }, tags: ['Board Game Rental', 'In Store Only'], missingPieces: { value: 'true' }, missingNote: { value: '1 sheep' } }), NOW);
  assert.deepEqual([r.productId, r.variantId, r.title, r.shelfCode, r.copies, r.inStoreOnly, r.missingPieces, r.missingNote], [G.catan, variantOf(G.catan), 'Catan', 'DGL34-M011', 1, 1, 1, '1 sheep']);
  assert.equal(catalogRowOf(node(base, { title: 'Catan(Library)' }), NOW).title, 'Catan');
  assert.equal(catalogRowOf(node(base, { variants: { nodes: [{ id: 'gid://shopify/ProductVariant/5', inventoryQuantity: 3, inventoryItem: { tracked: false } }] } }), NOW).copies, null);
  assert.equal(catalogRowOf(node(base, { variants: { nodes: [{ id: 'gid://shopify/ProductVariant/5', inventoryQuantity: 0, inventoryItem: { tracked: true } }] } }), NOW).copies, null);
  assert.equal(catalogRowOf(node(base, { variants: { nodes: [{ id: 'gid://shopify/ProductVariant/5', inventoryQuantity: 250, inventoryItem: { tracked: true } }] } }), NOW).copies, 99);
  assert.equal(blurbOf('Borrow 7 Wonders Duel at Dice Goblin. The award-winning 2-player 7 Wonders.'), 'The award-winning 2-player 7 Wonders.');
  assert.equal(blurbOf('Borrow X at Dice Goblin.'), null);
  assert.equal(firstVideo('<a href="https://www.youtube.com/results?search_query=x+how+to+play">search</a> then <a href="https://youtu.be/uWqiy8i2L-M">x</a>'), 'https://www.youtube.com/watch?v=uWqiy8i2L-M');
  assert.equal(firstVideo('<a href="https://www.youtube.com/results?search_query=x">search only</a>'), null, 'a YouTube search link doesn\'t count');
  assert.equal(firstVideo('<a href="https://www.youtube.com/watch?v=oQrmKRfKb3c" target="_blank">x</a>'), 'https://www.youtube.com/watch?v=oQrmKRfKb3c');
  assert.equal(pickNorm('CATAN (5th Edition) (Library)'), 'catan');
  assert.equal(pickNorm('Tea & Biscuits: Catán!'), 'tea and biscuits catan');
  assert.deepEqual(shelfParts('DGL34-M011'), { section: 'DGL34', size: 'M', number: 11 });
  assert.deepEqual(shelfParts('DGLRPG-021'), { section: 'DGLRPG', size: null, number: 21 });
  assert.deepEqual(shelfParts('DGL7+-S001'), { section: 'DGL7+', size: 'S', number: 1 });
  assert.equal(shelfParts('nope'), null);
});

/* ---------------- facts: validation, the seed, auto-tags ---------------- */

test('validFacts: the contract\'s shape and words; without clamp anything off is wrong and names the field; with clamp numbers are clamped and unknown words dropped', () => {
  assert.equal(validFacts(facts()).ok, true);
  const wrong = (over, field) => assert.equal(validFacts(facts(over)).field, field, JSON.stringify(over));
  wrong({ kind: 'board' }, 'kind');
  wrong({ players: { min: 0, max: 4, best: [2] } }, 'players.min');
  wrong({ players: { min: 3, max: 2, best: [2] } }, 'players.max');
  wrong({ players: { min: 2, max: 4, best: [5] } }, 'players.best');
  wrong({ players: { min: 2, max: 4, best: [] } }, 'players.best');
  wrong({ time: { min: 30, max: 20 } }, 'time.max');
  wrong({ weight: 5.5 }, 'weight');
  wrong({ weight: 2.25 }, 'weight');
  wrong({ age: 1 }, 'age');
  wrong({ mode: 'versus' }, 'mode');
  wrong({ vibes: [] }, 'vibes');
  wrong({ vibes: ['chill', 'laughs', 'thinky'] }, 'vibes');
  wrong({ themes: ['fantasy', 'dragons'] }, 'themes');
  wrong({ styles: ['a', 'b', 'c', 'd', 'e'] }, 'styles');
  wrong({ reading: 'lots' }, 'reading');
  wrong({ access: { colourBlind: 'yes', easyPieces: null } }, 'access.colourBlind');
  wrong({ table: 'triple' }, 'table');
  wrong({ expansionOf: G.catan }, 'expansionOf');
  wrong({ kind: 'rpg' }, 'rpg');
  wrong({ kind: 'rpg', rpg: { system: 'D&D', starter: 'yes', setting: 'fantasy', type: 'core' } }, 'rpg.starter');
  wrong({ kind: 'rpg', rpg: { system: 'D&D', starter: true, setting: 'elves', type: 'core' } }, 'rpg.setting');
  wrong({ rpg: { system: 'x', starter: true, setting: 'fantasy', type: 'core' } }, 'rpg');
  wrong({ summary: 'Too short' }, 'summary');
  wrong({ summary: 'x'.repeat(141) }, 'summary');
  wrong({ confidence: 'sure' }, 'confidence');
  assert.equal(validFacts(null).field, 'facts');
  assert.deepEqual(validFacts(facts({ kind: 'expansion', expansionOf: `gid://shopify/Product/${G.catan}` })).facts.expansionOf, G.catan);
  // clamped: numbers into range, unknown words dropped, a long summary cut at a word, access answers missing are null
  const clamped = validFacts({
    ...facts(), players: { min: 0, max: 200, best: [300] }, time: { min: -5, max: 5000 }, weight: 7.77, age: 40, vibes: ['chill', 'spicy'],
    themes: ['Fantasy', 'dragons'], styles: ['party', 'flipping'], summary: `${'word '.repeat(40)}end`, access: undefined, rpg: { system: 'x' },
  }, { clamp: true });
  assert.equal(clamped.ok, true);
  assert.deepEqual([clamped.facts.players, clamped.facts.time, clamped.facts.weight, clamped.facts.age], [{ min: 1, max: 99, best: [50] }, { min: 1, max: 1440 }, 5, 18]);
  assert.deepEqual([clamped.facts.vibes, clamped.facts.themes, clamped.facts.styles, clamped.facts.access, clamped.facts.rpg], [['chill'], ['fantasy'], ['party'], { colourBlind: null, easyPieces: null }, null]);
  assert.ok(clamped.facts.summary.length <= 140 && clamped.facts.summary.endsWith('…'));
  assert.equal(validFacts({ ...facts(), vibes: ['spicy'] }, { clamp: true }).field, 'vibes', 'a list left empty is still wrong');
});

test('the seed: applied once per version as the Lair starts; never over a checked or staff row; a row nobody touched takes the new facts', () => {
  catalogue();
  const row = (id) => lair.sql.exec('SELECT * FROM pick_facts WHERE product_id = ?', id).one();
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM pick_facts').one().n, LIBRARY.length);
  assert.deepEqual([row(G.catan).source, row(G.catan).checked, row(G.catan).seed_version], ['seed', 0, 'test-1']);
  assert.equal(lair.sql.exec("SELECT value FROM meta WHERE key = 'pick-seed'").one().value, 'test-1');

  // Staff check Catan and change Azul; Wingspan is left alone
  lair.sql.exec("UPDATE pick_facts SET checked = 1, checked_by = 'staff' WHERE product_id = ?", G.catan);
  lair.sql.exec("UPDATE pick_facts SET source = 'staff', facts = ? WHERE product_id = ?", JSON.stringify(facts({ summary: 'Staff wrote this summary for Azul.' })), G.azul);
  const newer = Object.fromEntries(LIBRARY.map((g) => [g.id, { ...g.facts, summary: `New seed words for ${g.title}.` }]));
  newer['8100000000099'] = facts({ summary: 'A game only the new seed knows about.' });
  newer['8100000000098'] = { ...facts(), weight: 9 };

  // The same version again: nothing happens, even with different facts
  start(newer, 'test-1');
  assert.equal(JSON.parse(row(G.wingspan).facts).summary, LIBRARY[6].facts.summary);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM pick_facts WHERE product_id = '8100000000099'").one().n, 0);

  // A newer version: once
  start(newer, 'test-2');
  assert.equal(JSON.parse(row(G.wingspan).facts).summary, 'New seed words for Wingspan.', 'a seed row nobody touched takes the new facts');
  assert.equal(JSON.parse(row(G.catan).facts).summary, LIBRARY[0].facts.summary, 'checked: never overwritten');
  assert.equal(JSON.parse(row(G.azul).facts).summary, 'Staff wrote this summary for Azul.', 'staff: never overwritten');
  assert.equal(row('8100000000099').source, 'seed', 'a product with no row gets one');
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM pick_facts WHERE product_id = '8100000000098'").one().n, 0, 'an entry that fails validation is skipped');
  assert.equal(lair.sql.exec("SELECT value FROM meta WHERE key = 'pick-seed'").one().value, 'test-2');
  // a basic or auto row nobody checked takes the seed too
  lair.sql.exec("UPDATE pick_facts SET source = 'auto', facts = ? WHERE product_id = ?", JSON.stringify(facts({ summary: 'Workers AI wrote this one.' })), G.dixit);
  start({ [G.dixit]: newer[G.dixit] }, 'test-3');
  assert.deepEqual([row(G.dixit).source, JSON.parse(row(G.dixit).facts).summary], ['seed', 'New seed words for Dixit.']);
  // the real seed (version '0', empty) never runs over a store that has a newer one
  start(PICK_SEED, PICK_SEED_VERSION);
  assert.equal(lair.sql.exec("SELECT value FROM meta WHERE key = 'pick-seed'").one().value, 'test-3');
});

test('the seed\'s real format: keyed by product id, the contract\'s facts with expansionOf a product id or null', () => {
  const seed = { [G.catan]: LIBRARY[0].facts, [G.seafarers]: { ...LIBRARY[10].facts, expansionOf: G.catan } };
  ctx = fakeCtx();
  start(seed, '2026-10-16a');
  const rows = lair.sql.exec('SELECT product_id, facts, source FROM pick_facts ORDER BY product_id').toArray();
  assert.deepEqual(rows.map((r) => [r.product_id, r.source]), [[G.catan, 'seed'], [G.seafarers, 'seed']]);
  assert.equal(JSON.parse(rows[1].facts).expansionOf, G.catan);
  assert.deepEqual(Object.keys(JSON.parse(rows[0].facts)), ['kind', 'players', 'time', 'weight', 'age', 'mode', 'vibes', 'themes', 'styles', 'reading', 'access', 'table', 'expansionOf', 'rpg', 'summary', 'confidence']);
  // the tables are made on every start, and a restart keeps the rows
  for (const statement of PICK_TABLES) assert.match(statement, /IF NOT EXISTS/);
  start(seed, '2026-10-16a');
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM pick_facts').one().n, 2);
});

/** A Workers AI binding that answers from a list, noting each call */
function fakeAI(answers) {
  const calls = [];
  return {
    calls,
    run: async (model, input) => {
      calls.push({ model, input });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(input) : next;
    },
  };
}

test('auto-tag: Workers AI\'s good answer becomes the facts (never high confidence), bad and junk answers count a try and keep the basic facts; 3 tries at most', async () => {
  ctx = fakeCtx();
  start({ [G.catan]: LIBRARY[0].facts }, 'one');
  const fresh = [
    { id: '8200000000001', title: 'Brand New Game', code: 'DGL34-M100' },
    { id: '8200000000002', title: 'Another New Game', code: 'DGL34-M101' },
    { id: '8200000000003', title: 'Third New Game', code: 'DGL34-M102' },
    { id: '8200000000004', title: 'Brand New Game: Big Box Expansion', code: 'DGL34-M103' },
  ];
  catalogue([...fresh, LIBRARY[0]]);
  const facts0 = (id) => lair.sql.exec('SELECT * FROM pick_facts WHERE product_id = ?', id).one();
  assert.deepEqual(fresh.map((g) => facts0(g.id).source), ['basic', 'basic', 'basic', 'basic'], 'basic facts made at once for games the seed doesn\'t know');
  assert.equal(JSON.parse(facts0(fresh[3].id).facts).kind, 'expansion');

  // no binding: skipped
  assert.deepEqual(await lair.autoTag(), { skipped: 'no-ai' });
  const good = { ...facts({ confidence: 'high', summary: 'Race your friends to build the best little town on the board.' }), expansionOfTitle: null, weight: 2.34, vibes: ['chill', 'sparkly'] };
  const junk = { choices: [{ message: { content: 'Sorry, I cannot help with that.' } }] };
  const bad = { response: JSON.stringify({ ...facts(), kind: 'boardgame' }) };
  const expansion = { choices: [{ message: { content: `\`\`\`json\n${JSON.stringify({ ...facts({ kind: 'expansion', summary: 'More of the new game, with a bigger box.' }), expansionOfTitle: 'Brand New Game', rpg: null })}\n\`\`\`` } }] };
  const ai = fakeAI([{ choices: [{ message: { content: JSON.stringify(good) } }] }, junk, bad, expansion]);
  lair.baseEnv = { ...lair.baseEnv, AI: ai, PICK_AI_MODEL: '' };
  lair.env = lair.baseEnv;
  assert.deepEqual(await lair.autoTag(), { tagged: 2, failed: 2 });
  assert.equal(ai.calls.length, 4);
  const sent = ai.calls[0].input;
  assert.equal(ai.calls[0].model, PICK_AI_MODEL);
  assert.equal(sent.response_format.type, 'json_schema');
  assert.equal(sent.response_format.json_schema.name, 'game_facts');
  assert.deepEqual(sent.chat_template_kwargs, { enable_thinking: false });
  const listing = JSON.parse(sent.messages[1].content);
  assert.deepEqual([listing.title, listing.libraryCode, listing.players, listing.playTime, listing.difficulty, listing.vendor], ['Brand New Game', 'DGL34-M100', '2–4', '30 min', 'Medium', 'Test Games']);
  assert.match(listing.description, /Brand New Game is a board game/);
  assert.doesNotMatch(listing.description, /</, 'HTML stripped');

  const first = facts0(fresh[0].id);
  assert.deepEqual([first.source, first.checked, JSON.parse(first.facts).confidence, JSON.parse(first.facts).weight, JSON.parse(first.facts).vibes], ['auto', 0, 'medium', 2.3, ['chill']]);
  for (const g of [fresh[1], fresh[2]]) {
    const r = facts0(g.id);
    assert.deepEqual([r.source, r.ai_tries], ['basic', 1]);
    assert.ok(r.ai_error);
  }
  assert.deepEqual([facts0(fresh[3].id).source, JSON.parse(facts0(fresh[3].id).facts).expansionOf], ['auto', fresh[0].id], 'an expansion\'s base game found by its title');

  // two more failed tries each, then they're left alone
  ai.run = async () => { throw new Error('Workers AI is busy'); };
  assert.deepEqual(await lair.autoTag(), { tagged: 0, failed: 2 });
  assert.deepEqual(await lair.autoTag(), { tagged: 0, failed: 2 });
  assert.deepEqual(await lair.autoTag(), { tagged: 0, failed: 0 });
  assert.equal(facts0(fresh[1].id).ai_tries, 3);
  // PICK_AI off stops it; a model named in config is used
  lair.sql.exec('UPDATE pick_facts SET ai_tries = 0 WHERE product_id = ?', fresh[1].id);
  lair.env = { ...lair.baseEnv, PICK_AI: 'off' };
  assert.deepEqual(await lair.autoTag(), { skipped: 'off' });
  const other = fakeAI([{ choices: [{ message: { content: JSON.stringify(good) } }] }]);
  lair.env = { ...lair.baseEnv, AI: other, PICK_AI_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' };
  assert.deepEqual(await lair.autoTag(), { tagged: 1, failed: 0 });
  assert.equal(other.calls[0].model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
});

/* ---------------- the catalogue from Shopify ---------------- */

/** A Shopify stand-in for the two catalogue queries: library listings and shop copies, paged 2 at a time, noting each search */
function fakeShopify(state) {
  state.calls = [];
  const page = (list, after) => {
    const start = after ? Number(after) : 0;
    return { nodes: list.slice(start, start + 2), pageInfo: { hasNextPage: start + 2 < list.length, endCursor: String(start + 2) } };
  };
  lair.shopify.graphql = async (query, variables = {}) => {
    const op = (String(query).match(/^\s*(?:query|mutation)\s+(\w+)/) || [])[1];
    state.calls.push({ op, query: variables.query });
    if (state.down) throw new Error('Shopify API: Access denied for products field. Required access: `read_products` access scope.');
    if (op === 'LairPickCatalog') {
      const since = String(variables.query).match(/updated_at:>'([^']+)'/)?.[1];
      const list = state.library.filter((n) => !since || Date.parse(n.updatedAt) > Date.parse(since));
      return { products: page(list, variables.after) };
    }
    if (op === 'LairPickShop') return { products: page(state.shop, variables.after) };
    throw new Error(`Fake Shopify: unknown operation ${op}`);
  };
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  return state;
}
const shopNode = (id, title, { price = '95.0', stock = 2, forSale = true, status = 'ACTIVE', handle = pickNorm(title).replace(/ /g, '-') } = {}) => ({
  id: `gid://shopify/Product/${id}`, handle, title, status, totalInventory: stock, tracksInventory: true,
  featuredMedia: null, priceRangeV2: { minVariantPrice: { amount: price } }, variants: { nodes: [{ availableForSale: forSale }] },
});

test('sync: a full sync on the first run reads every page and every shop copy; later runs read only what changed; a full one marks what\'s gone', async () => {
  ctx = fakeCtx();
  start(Object.fromEntries(LIBRARY.slice(0, 4).map((g) => [g.id, g.facts])), 'sync-1');
  const shopify = fakeShopify({
    library: LIBRARY.slice(0, 5).map((g) => node(g)),
    shop: [shopNode('9100000000001', 'Catan (5th Edition)'), shopNode('9100000000002', 'Pandemic', { stock: 0, forSale: false }), shopNode('9100000000003', 'Ticket to Ride', { price: '80.0' })],
  });
  const first = await lair.syncCatalog();
  assert.deepEqual([first.kind, first.synced, first.added, first.gone, first.shop, first.basic], ['full', 5, 5, 0, 3, 1]);
  assert.deepEqual(shopify.calls.map((c) => c.op), ['LairPickCatalog', 'LairPickCatalog', 'LairPickCatalog', 'LairPickShop', 'LairPickShop']);
  assert.equal(shopify.calls[0].query, "tag:'Board Game Rental' AND status:active");
  assert.equal(shopify.calls[3].query, "product_type:'Board Games' AND -tag:'Board Game Rental' AND status:active");
  assert.equal(lair.sql.exec('SELECT source FROM pick_facts WHERE product_id = ?', G.dixit).one().source, 'basic', 'the game the seed didn\'t know got basic facts');
  const catan = lair.sql.exec('SELECT * FROM pick_catalog WHERE product_id = ?', G.catan).one();
  assert.deepEqual([catan.title, catan.raw_title, catan.shelf_code, catan.copies, catan.video, catan.blurb, catan.status], ['Catan', 'Catan (Library)', 'DGL34-M011', 1, 'https://www.youtube.com/watch?v=abc123XYZ_-', 'A board game for the test.', 'active']);

  // 10 minutes on: an update sync asks only for what changed since the last sync less 5 minutes
  Date.now = () => NOW + 10 * 60_000;
  shopify.calls = [];
  shopify.library[0] = node(LIBRARY[0], { title: 'Catan: Trade Build Settle (Library)', updatedAt: new Date(NOW + 9 * 60_000).toISOString() });
  const update = await lair.syncCatalog();
  assert.deepEqual([update.kind, update.synced, update.added, update.gone], ['update', 1, 0, 0]);
  assert.deepEqual(shopify.calls.map((c) => c.op), ['LairPickCatalog']);
  assert.equal(shopify.calls[0].query, `tag:'Board Game Rental' AND status:active AND updated_at:>'${new Date(NOW - 5 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')}'`);
  assert.equal(lair.sql.exec('SELECT title FROM pick_catalog WHERE product_id = ?', G.catan).one().title, 'Catan: Trade Build Settle');

  // 6 hours on: a full sync; Codenames was archived, so it's gone (and out of the quiz)
  Date.now = () => NOW + 6 * HOUR + 60_000;
  shopify.library = shopify.library.filter((n) => !n.id.endsWith(G.codenames));
  const full = await lair.syncCatalog();
  assert.deepEqual([full.kind, full.synced, full.gone], ['full', 4, 1]);
  assert.equal(lair.sql.exec('SELECT status FROM pick_catalog WHERE product_id = ?', G.codenames).one().status, 'gone');
  assert.equal(lair.pickGame(G.codenames), null);
  // and back again once it's listed again
  shopify.library.push(node(LIBRARY[3]));
  await lair.syncCatalog({ full: true });
  assert.equal(lair.sql.exec('SELECT status FROM pick_catalog WHERE product_id = ?', G.codenames).one().status, 'active');

  // 17 Oct 2026: a new Lair (a restart after a quiet spell, or a deploy) doesn't sync it all again inside the 6 hours:
  // the Lair restarts often, and every full sync wrote every listing again
  start(Object.fromEntries(LIBRARY.slice(0, 4).map((g) => [g.id, g.facts])), 'sync-1');
  fakeShopify(shopify);
  Date.now = () => NOW + 6 * HOUR + 2 * 60_000;
  assert.equal((await lair.syncCatalog()).kind, 'update');
  // but a catalogue whose rows' shape has changed (PICK_CATALOG_SHAPE) is synced in full once, then updated again
  lair.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('pick-catalog-shape', 'older')");
  assert.equal((await lair.syncCatalog()).kind, 'full');
  assert.equal((await lair.syncCatalog()).kind, 'update');
});

test('sync: Shopify\'s rate limit: a throttled page is asked again once the bucket has room, pages wait for room, and a store that stays throttled is tried next run without the copies back-off', async () => {
  ctx = fakeCtx();
  start(Object.fromEntries(LIBRARY.slice(0, 4).map((g) => [g.id, g.facts])), 'sync-1');
  const shopify = fakeShopify({ library: LIBRARY.slice(0, 5).map((g) => node(g)), shop: [shopNode('9100000000001', 'Catan (5th Edition)')] });
  const answer = lair.shopify.graphql;
  const waits = [];
  lair.shopify.wait = async (ms) => { waits.push(ms); };
  let throttles = 1;
  lair.shopify.graphql = async (query, variables) => {
    if (throttles > 0 && variables.after === '2') {
      throttles -= 1;
      const error = new Error('Shopify API: Throttled');
      Object.assign(error, { throttled: true, cost: { requestedQueryCost: 600, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 100, restoreRate: 50 } } });
      throw error;
    }
    const data = await answer(query, variables);
    // the bucket after this page: room for half a page (300 of 600), so the next page waits 6 seconds and a bit
    lair.shopify.lastCost = { requestedQueryCost: 600, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 300, restoreRate: 50 } };
    return data;
  };
  const first = await lair.syncCatalog();
  assert.deepEqual([first.kind, first.synced], ['full', 5], 'the throttled page was asked again and the sync finished');
  assert.deepEqual(shopify.calls.filter((c) => c.op === 'LairPickCatalog').length, 3, 'each page read once (the throttled try never reached Shopify\'s fake)');
  assert.ok(waits.includes(10_000), 'waited for room for the throttled page (500 short at 50 a second: 10 seconds, the most)');
  assert.ok(waits.filter((ms) => ms === 6250).length >= 2, 'between pages, waited for room for the next one');
  // a store that stays throttled: five tries, then noted and tried next run, with no copies back-off
  const notes = [];
  lair.note = (entry) => notes.push(entry);
  throttles = 99;
  Date.now = () => NOW + 7 * HOUR;
  assert.deepEqual(await lair.syncCatalog({ full: true }), { skipped: 'throttled' });
  assert.match(notes[0].catalogError.message, /Throttled/);
  assert.equal(lair.retryAt.get('copies') || 0, 0, 'the library pages\' live copy counts carry on');
  throttles = 0;
  assert.equal((await lair.syncCatalog({ full: true })).kind, 'full', 'the next run goes through');
});

test('sync: the Shopify client paces itself by the cost extension (shopifyPaceWait)', () => {
  assert.equal(shopifyPaceWait(null), 0);
  assert.equal(shopifyPaceWait({ requestedQueryCost: 200, throttleStatus: { currentlyAvailable: 900, restoreRate: 50 } }), 0, 'room already');
  assert.equal(shopifyPaceWait({ requestedQueryCost: 600, throttleStatus: { currentlyAvailable: 300, restoreRate: 50 } }), 6250);
  assert.equal(shopifyPaceWait({ requestedQueryCost: 1000, throttleStatus: { currentlyAvailable: 0, restoreRate: 50 } }), 10_000, 'at most 10 seconds');
  assert.equal(shopifyPaceWait({ requestedQueryCost: 600, throttleStatus: { currentlyAvailable: 100, restoreRate: 100 } }), 5250, 'a faster store refills sooner');
});

test('sync: never throws; Shopify refusing (read_products) is noted and backed off; without Shopify it\'s skipped', async () => {
  assert.deepEqual(await lair.syncCatalog(), { skipped: 'shopify' });
  const shopify = fakeShopify({ library: [], shop: [], down: true });
  lair.grantedScopes = ['read_customers', 'read_orders'];
  assert.deepEqual(await lair.syncCatalog(), { skipped: 'scope' }, 'the health check said read_products isn\'t granted');
  assert.equal(shopify.calls.length, 0);
  lair.grantedScopes = null;
  const notes = [];
  lair.note = (entry) => notes.push(entry);
  assert.deepEqual(await lair.syncCatalog(), { skipped: 'error' });
  assert.match(notes[0].catalogError.message, /read_products/);
  shopify.down = false;
  assert.deepEqual(await lair.syncCatalog(), { skipped: 'waiting' }, 'the copies back-off: 10 minutes');
  Date.now = () => NOW + 11 * 60_000;
  assert.equal((await lair.syncCatalog()).kind, 'full');
});

test('shop copies: the copy staff linked (custom.shop_copy) when it\'s on sale and in stock; with no link, the available shop product whose title matches', async () => {
  const shopify = fakeShopify({
    library: [
      node(LIBRARY[0], { shopCopy: { reference: { id: 'gid://shopify/Product/9100000000009', handle: 'catan-base-game', title: 'CATAN', status: 'ACTIVE', totalInventory: 3, tracksInventory: true, priceRangeV2: { minVariantPrice: { amount: '95.0' } } } } }),
      node(LIBRARY[1]), node(LIBRARY[2]), node(LIBRARY[5]),
      node(LIBRARY[6], { shopCopy: { reference: { id: 'gid://shopify/Product/9100000000010', handle: 'wingspan', title: 'Wingspan', status: 'ACTIVE', totalInventory: 0, tracksInventory: true, priceRangeV2: { minVariantPrice: { amount: '110.0' } } } } }),
    ],
    shop: [
      shopNode('9100000000001', 'Catan (5th Edition)', { price: '80.0' }),
      shopNode('9100000000002', 'Pandemic', { stock: 0, forSale: false }),
      shopNode('9100000000003', 'Ticket to Ride', { price: '79.99' }),
      shopNode('9100000000004', 'Azul', { stock: 0, forSale: true }),
      shopNode('9100000000009', 'CATAN', { price: '95.0', handle: 'catan-base-game' }),
      shopNode('9100000000011', 'Wingspan', { price: '105.0' }),
    ],
  });
  await lair.syncCatalog();
  const card = async (id) => (await call('GET', `pick/game/${id}`)).data.game;
  assert.deepEqual((await card(G.catan)).shopCopy, { handle: 'catan-base-game', title: 'CATAN', price: 9500 }, 'the linked copy wins over a title match');
  assert.deepEqual((await card(G.ticket)).shopCopy, { handle: 'ticket-to-ride', title: 'Ticket to Ride', price: 7999 }, 'no link: the title match');
  assert.equal((await card(G.pandemic)).shopCopy, null, 'an unavailable copy is never linked');
  assert.deepEqual((await card(G.azul)).shopCopy, { handle: 'azul', title: 'Azul', price: 9500 }, 'any variant for sale counts as available');
  assert.equal((await card(G.wingspan)).shopCopy, null, 'linked but out of stock: none (no fall back to the title)');
  // the link's own state is used when the shop list doesn't have it (an update sync between full ones)
  lair.sql.exec("DELETE FROM pick_shop WHERE product_id = '9100000000009'");
  lair.pickCache = null;
  assert.deepEqual((await card(G.catan)).shopCopy, { handle: 'catan-base-game', title: 'CATAN', price: 9500 });
  shopify.calls = [];
});

/* ---------------- matching ---------------- */
const quiz = (body = {}, who = '', headers = {}) => call('POST', 'pick', { mode: 'play', players: 4, ...body }, who, headers);
const all = (data) => [...data.picks, ...(data.wildcard ? [data.wildcard] : [])];

test('matching: the hard rules (kind, players, time, age, light reading, a nope\'d swipe, their thumbs down, hide what they\'ve had)', async () => {
  catalogue();
  const res = await quiz({ players: 4, time: 'medium' });
  assert.equal(res.status, 200, said(res));
  const shown = all(res.data);
  assert.equal(res.data.picks.length, 3);
  assert.ok(res.data.wildcard);
  for (const c of shown) {
    assert.ok(c.players.min <= 4 && c.players.max >= 4, c.title);
    assert.ok(c.time.min <= 70 && c.time.max >= 25, c.title);
  }
  assert.ok(!ids(shown).some((id) => [G.seafarers, G.cards, G.dnd, G.coc].includes(id)), 'never an expansion, an "other" or an RPG book');
  assert.equal(res.data.fitCount, LIBRARY.filter((g) => g.facts.kind === 'game' && g.facts.players.min <= 4 && g.facts.players.max >= 4 && g.facts.time.min <= 70 && g.facts.time.max >= 25).length);
  assert.deepEqual(res.data.relaxed, []);

  // kids: the youngest's age is a hard rule (never loosened)
  const kids = await quiz({ players: 3, kids: true, youngest: 5 });
  for (const c of all(kids.data)) assert.ok(c.age <= 5, c.title);
  assert.ok(ids(all(kids.data)).includes(G.haba));
  // 8 means "8 or more": the three that fit come first, and too few means the closest count comes back (players loosened)
  const eight = await quiz({ players: 8 });
  assert.deepEqual([eight.data.fitCount, eight.data.relaxed], [3, ['players']]);
  assert.deepEqual(new Set(ids(eight.data.picks)), new Set([G.codenames, G.uno, G.sushi]));
  // light on reading
  for (const c of all((await quiz({ players: 2, filters: { lightReading: true } })).data)) assert.equal(c.reading, 'light', c.title);
  // a swipe nope'd is out; so is a game they rated down; hideHad leaves out what they've borrowed (members only)
  assert.ok(!ids(all((await quiz({ players: 2, swipes: { [G.azul]: 'nope' } })).data)).includes(G.azul));
  lair.sql.exec("INSERT INTO game_ratings (customer_id, product_id, rating, source, created_at) VALUES (?, ?, -1, 'page', ?)", SAM, G.ticket, NOW);
  assert.ok(!ids(all((await quiz({ players: 4 }, SAM)).data)).includes(G.ticket));
  assert.ok(ids(all((await quiz({ players: 4, filters: { themes: ['travel'] } })).data)).includes(G.ticket), 'others still get it');
  loan(G.pandemic, SAM, 'returned');
  assert.ok(!ids(all((await quiz({ players: 4, team: 'coop', filters: { hideHad: true } }, SAM)).data)).includes(G.pandemic));
  assert.ok(ids(all((await quiz({ players: 4, team: 'coop', filters: { hideHad: true } })).data)).includes(G.pandemic), 'a guest has had nothing');
});

test('matching: anything missing or out of range falls back to "not asked" (never a 422); what was used comes back as answers', async () => {
  catalogue();
  for (const body of [{}, { players: 99, time: 'forever', brain: 'galaxy', team: 'nobody', vibes: ['spicy', 'laughs'], kids: 'yes' }, { mode: 'chess' }, [1, 2]]) {
    const res = await call('POST', 'pick', body);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(res.data.picks.length, 3);
  }
  const res = await call('POST', 'pick', { players: 99, time: 'forever', brain: 'galaxy', team: 'nobody', vibes: ['spicy', 'laughs'], kids: true, youngest: 1 });
  assert.deepEqual(res.data.answers, {
    mode: 'play', players: 4, kids: false, youngest: null, time: null, brain: null, team: 'either', vibes: ['laughs'],
    filters: { themes: [], loves: [], lightReading: false, colourBlind: false, easyPieces: false, hideHad: false }, swipes: {}, rpg: null, useTaste: false,
  });
  assert.deepEqual(cleanAnswers({ filters: { loves: [{ productId: G.catan }, { known: ' Monopoly ' }, { productId: G.catan }, { known: 'x' }, {}, { known: 'Uno' }, { known: 'Risk' }, { known: 'Clue' }] } }).answers.filters.loves,
    [{ productId: G.catan }, { known: 'Monopoly' }, { known: 'x' }, { known: 'Uno' }, { known: 'Risk' }], 'up to 5, repeats dropped');
});

/** Crafted games for matchGames on its own */
const craft = (id, title, over = {}, extra = {}) => ({ productId: id, title, facts: facts(over), staffPick: false, isNew: false, underplayed: false, inStoreOnly: false, shelfCode: '', ...extra });
const plainCtx = (over = {}) => ({
  likes: [], nopes: [], loves: [], tasteLikes: [], tasteDowns: [], myUps: new Set(), ratings: new Map(), down: new Set(), member: false, had: () => false,
  available: () => true, sessionId: 'abcdefghij', round: 0, ...over,
});

test('relaxing: too few fit, so it loosens time, then filters, then availability, then players (only the closest), and lists what it loosened', async () => {
  const busy = new Set(['d']);
  const games = [
    craft('a', 'A long thinky', { time: { min: 100, max: 120 }, reading: 'some' }),
    craft('b', 'B long light', { time: { min: 100, max: 120 }, reading: 'light' }),
    craft('c', 'C short wordy', { time: { min: 20, max: 30 }, reading: 'some' }),
    craft('d', 'D short light reserved', { time: { min: 20, max: 30 }, reading: 'light' }),
    craft('e', 'E big group', { players: { min: 6, max: 8, best: [7] }, time: { min: 20, max: 30 }, reading: 'light' }),
    craft('f', 'F five or six', { players: { min: 5, max: 6, best: [5] }, time: { min: 20, max: 30 }, reading: 'light' }),
  ];
  const ask = cleanAnswers({ players: 4, time: 'short', filters: { lightReading: true } }).answers;
  const one = matchGames(games, ask, plainCtx({ available: (g) => !busy.has(g.productId) }));
  assert.deepEqual([one.fitCount, one.relaxed, one.candidates], [0, ['time', 'filters', 'availability'], 4]);
  assert.ok(!one.picks.some((p) => ['e', 'f'].includes(p.game.productId)), 'players never loosened while 4 came back without');
  const two = matchGames(games, ask, plainCtx());
  assert.deepEqual([two.relaxed, two.candidates], [['time', 'filters'], 4], 'the reserved one fits once availability isn\'t a problem');
  // players: the closest count only (F, one off) comes back, not E (two off)
  const fits = [craft('p', 'P', {}), craft('q', 'Q', {}), craft('r', 'R', {}), games[4], games[5]];
  const three = matchGames(fits, cleanAnswers({ players: 4 }).answers, plainCtx());
  assert.deepEqual([three.fitCount, three.relaxed, three.candidates], [3, ['players'], 4]);
  assert.ok([...three.picks, three.wildcard].some((p) => p.game.productId === 'f'));
  assert.ok(![...three.picks, three.wildcard].some((p) => p.game.productId === 'e'));
  // age and kind are never loosened: with kids under 5 only the one game for 4-year-olds, however few
  catalogue();
  const kids = await quiz({ players: 2, time: 'short', kids: true, youngest: 4 });
  assert.deepEqual([ids(kids.data.picks), kids.data.wildcard, kids.data.fitCount], [[G.haba], null, 1]);
  // through the route: every copy out, play mode brings reserved and out games back, marked
  for (const g of LIBRARY) hold(g.id, KIRI);
  const out = await quiz({ players: 4 });
  assert.deepEqual([out.data.relaxed, out.data.fitCount], [['availability'], 0]);
  assert.ok(all(out.data).every((c) => c.availability.available === 0 && c.availability.held === 1));
  // borrow mode never filters on availability
  const borrow = await quiz({ mode: 'borrow', players: 4 });
  assert.deepEqual(borrow.data.relaxed, []);
  assert.ok(borrow.data.fitCount >= 4);
  // nothing at all: picks [] (no game is for 2-year-olds)
  const none = await quiz({ players: 4, kids: true, youngest: 2 });
  assert.deepEqual([none.data.picks, none.data.wildcard, none.data.fitCount], [[], null, 0]);
});

test('the top three are diverse: a near-twin or the same series is skipped while another within 85% of its score is left; ties break by nudges, then title', () => {
  const twin = { players: { min: 1, max: 4, best: [2] }, time: { min: 60, max: 90 }, weight: 1.9, mode: 'coop', vibes: ['thinky'], themes: ['adventure', 'mystery'], styles: ['storytelling', 'deduction'] };
  const games = [
    craft('m', 'Adventure Games: Monochrome Inc.', twin),
    craft('d', 'Adventure Games: The Dungeon', twin),
    craft('s', 'Spirit Island', { ...twin, weight: 4.1, themes: ['fantasy'], styles: ['puzzle'] }),
    craft('p', 'Pandemic', { players: { min: 2, max: 4, best: [4] }, time: { min: 45, max: 60 }, weight: 2.4, mode: 'coop', vibes: ['thinky'], themes: ['science'], styles: ['puzzle'] }),
  ];
  const ask = cleanAnswers({ players: 2, team: 'coop', vibes: ['thinky'], time: 'long' }).answers;
  const result = matchGames(games, ask, plainCtx());
  // all three of the first score 45; Pandemic 31 is under 85% of 45, so the Dungeon comes third, not second
  assert.deepEqual(result.picks.map((p) => p.game.productId), ['m', 's', 'd']);
  assert.deepEqual(result.picks.map((p) => p.score), [45, 45, 45]);
  // one more close candidate (within 85%): the second of the series is left out
  const more = [...games, craft('t', 'The Crew', { ...twin, themes: ['space'], styles: ['trick-taking'], weight: 2.0 })];
  assert.deepEqual(matchGames(more, ask, plainCtx()).picks.map((p) => p.game.productId), ['m', 's', 't']);
  // a tie is broken by a staff pick, then underplayed, then new, then the title
  const tie = (id, title, extra) => craft(id, title, { players: { min: 1, max: 9, best: [2] }, themes: [title === 'Zebra' ? 'animals' : title === 'Apple' ? 'food' : 'cute'], styles: [title === 'Zebra' ? 'racing' : title === 'Apple' ? 'auction' : 'memory'] }, extra);
  const tied = [tie('z', 'Zebra'), tie('a', 'Apple'), tie('x', 'Mango', { staffPick: true })];
  const order = matchGames(tied, cleanAnswers({ players: 2 }).answers, plainCtx());
  assert.deepEqual(order.picks.map((p) => p.game.title), ['Mango', 'Apple', 'Zebra']);
  assert.equal(order.wildcard, null, 'fewer than 4 candidates: no wildcard');
});

test('the wildcard: stays the same on a refresh, changes with "Show me different picks" (again), prefers nudged games and is unlike the picks', async () => {
  catalogue([...LIBRARY, ...Array.from({ length: 12 }, (_, i) => ({ id: String(8300000000000 + i), title: `Filler ${String.fromCharCode(65 + i)}`, code: `DGL34-M2${String(i).padStart(2, '0')}`, facts: facts({ players: { min: 1, max: 6, best: [4] }, themes: [PICK_VOCAB.themes[i]], styles: [PICK_VOCAB.styles[i]], vibes: [PICK_VOCAB.vibes[i % 4]], weight: 1 + (i % 4) }) }))]);
  start(Object.fromEntries([...LIBRARY, ...Array.from({ length: 12 }, (_, i) => ({ id: String(8300000000000 + i), facts: facts({ players: { min: 1, max: 6, best: [4] }, themes: [PICK_VOCAB.themes[i]], styles: [PICK_VOCAB.styles[i]], vibes: [PICK_VOCAB.vibes[i % 4]], weight: 1 + (i % 4) }) }))].map((g) => [g.id, g.facts])), 'wild-1');
  const first = await quiz({ players: 4 });
  const { id, editKey } = first.data.session;
  assert.match(id, /^[A-HJ-NP-Za-hj-km-np-z2-9]{10}$/);
  assert.match(editKey, /^[A-HJ-NP-Za-hj-km-np-z2-9]{20}$/);
  // a page refresh: the same answers again, with the session: the same picks and wildcard
  const refresh = await quiz({ players: 4, sessionId: id, editKey });
  assert.deepEqual(ids(all(refresh.data)), ids(all(first.data)));
  assert.equal(refresh.data.session.id, id);
  // "Show me different picks": new picks and a new wildcard, then that holds on a refresh
  const again = await quiz({ players: 4, sessionId: id, editKey, again: true });
  assert.notDeepEqual(ids(again.data.picks), ids(first.data.picks));
  assert.notEqual(again.data.wildcard.productId, first.data.wildcard.productId);
  const again2 = await quiz({ players: 4, sessionId: id, editKey });
  assert.deepEqual(ids(all(again2.data)), ids(all(again.data)));
  const row = lair.sql.exec('SELECT requests, round FROM pick_sessions WHERE id = ?', id).one();
  assert.deepEqual([row.requests, row.round], [4, 1]);
  // the wildcard is unlike every pick, and carries its own reason first
  for (const p of again.data.picks) assert.ok(similarity(p, again.data.wildcard) < 0.6);
  assert.ok(['staff-pick', 'new', 'underplayed', 'stretch'].includes(again.data.wildcard.why[0].code));
  // the same id seeds the same draw; the index steps through the shortlist
  assert.equal(wildcardIndex('abcdefghij', 0, 5), wildcardIndex('abcdefghij', 0, 5));
  assert.equal(wildcardIndex('x', 0, 0), -1);
  // a nudged game is preferred: make one a staff pick
  lair.sql.exec('UPDATE pick_facts SET staff_pick = 1 WHERE product_id = ?', '8300000000011');
  lair.pickCache = null;
  const nudged = await quiz({ players: 4, vibes: ['thinky'] });
  if (nudged.data.wildcard.productId === '8300000000011') assert.equal(nudged.data.wildcard.why[0].code, 'staff-pick');
});

test('the quiz\'s reads stay small: everyone\'s ratings kept until one changes (rateGame), what\'s been played kept 10 minutes, games at home read by an index', async () => {
  catalogue();
  await quiz({ players: 4 });
  const kept = lair.pickRatings;
  assert.ok(kept instanceof Map);
  await quiz({ players: 3 });
  assert.equal(lair.pickRatings, kept, 'the same count, not read again');
  assert.equal((await call('POST', 'library/rate', { productId: G.azul, rating: 'up' }, SAM)).status, 200);
  assert.equal(lair.pickRatings, null, 'a rating changed: read again next time');
  await quiz({ players: 4 });
  assert.deepEqual(lair.pickRatings.get(G.azul), { ups: 1, downs: 0 });
  const busy = lair.pickBusy;
  await quiz({ players: 4 });
  assert.equal(lair.pickBusy, busy, 'kept');
  Date.now = () => NOW + 10 * 60_000;
  await quiz({ players: 4 });
  assert.notEqual(lair.pickBusy, busy, 'read again after 10 minutes');
  assert.equal(lair.sql.exec("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'library_loans_status'").toArray()[0]?.sql,
    'CREATE INDEX library_loans_status ON library_loans (status, variant_id)');
});

test('why: up to 3 reasons, strongest first (best-at, time, brain, coop, vibe, like, theme, kids, rated)', async () => {
  catalogue();
  const res = await quiz({ players: 4, team: 'coop', brain: 'some', time: 'medium', vibes: ['thinky'] });
  const pandemic = res.data.picks.find((c) => c.productId === G.pandemic);
  assert.ok(pandemic, titles(res.data.picks).join(', '));
  assert.deepEqual(pandemic.why.map((w) => w.code), ['brain', 'coop', 'best-at']);
  assert.deepEqual(pandemic.why[2], { code: 'best-at', n: 4 });
  // liked a game in the swipes: "like" names it; 3 members' thumbs up: "rated"
  for (const c of ['3001', '3002', '3003']) lair.sql.exec("INSERT INTO game_ratings (customer_id, product_id, rating, source, created_at) VALUES (?, ?, 1, 'page', ?)", c, G.azul, NOW);
  lair.pickRatings = null; // written behind rateGame's back: the quiz's kept count is read again
  const liked = await quiz({ players: 2, swipes: { [G.ticket]: 'like' }, vibes: ['chill'] });
  const azul = all(liked.data).find((c) => c.productId === G.azul);
  assert.ok(azul.why.some((w) => w.code === 'like' && w.title === 'Ticket to Ride') || azul.why.some((w) => w.code === 'rated' && w.ups === 3), JSON.stringify(azul.why));
  const theme = await quiz({ players: 4, filters: { themes: ['travel'] } });
  assert.ok(theme.data.picks[0].why.some((w) => w.code === 'theme' && w.group === 'travel'));
  const kids = await quiz({ players: 3, kids: true, youngest: 6 });
  assert.ok(all(kids.data).every((c) => c.why.some((w) => w.code === 'kids')));
});

test('player types: plain names from the vibes, the team answer and liked swipes; the roleplaying branch is always adventurer', () => {
  const type = (body, liked = []) => playerTypeOf(cleanAnswers(body).answers, liked);
  assert.equal(type({ vibes: ['laughs'] }), 'party');
  assert.equal(type({ vibes: ['thinky'] }), 'thinker');
  assert.equal(type({ vibes: ['cutthroat'] }), 'competitor');
  assert.equal(type({ vibes: ['chill'] }), 'chill');
  assert.equal(type({ team: 'coop', vibes: ['laughs'] }), 'team');
  assert.equal(type({ team: 'competitive', vibes: ['chill'] }), 'chill', '+1 competitor is less than +2 chill');
  assert.equal(type({ vibes: ['laughs', 'thinky'] }), 'party', 'ties go team, party, thinker, competitor, adventurer, chill');
  assert.equal(type({}), 'team', 'nothing at all: the first in the tie order');
  assert.equal(type({ vibes: ['chill'] }, [{ styles: ['campaign', 'storytelling'], themes: ['fantasy', 'pirates'] }]), 'adventurer');
  assert.equal(type({}, [{ styles: ['area-control', 'take-that', 'auction'], themes: [] }]), 'competitor', 'one liked swipe: +1 to its type, however many of its styles');
  assert.equal(type({ vibes: ['thinky'] }, [{ styles: ['area-control', 'take-that', 'auction'], themes: [] }]), 'thinker', '+2 for the vibe beats +1 for the swipe');
  assert.equal(type({ vibes: ['thinky'] }, [{ styles: ['area-control'], themes: [] }, { styles: ['auction'], themes: [] }, { styles: ['negotiation'], themes: [] }]), 'competitor', 'three liked swipes');
  assert.equal(type({ mode: 'rpg', vibes: ['laughs'] }), 'adventurer');
});

test('the roleplaying branch: only RPG books, players within min..max, starter books first for people who\'ve never played, the setting counts', async () => {
  catalogue();
  const never = await quiz({ mode: 'rpg', rpg: { tried: 'never', players: 4, setting: 'any', gm: 'lair' } });
  assert.equal(never.status, 200, said(never));
  assert.deepEqual([never.data.mode, never.data.playerType], ['rpg', 'adventurer']);
  assert.deepEqual(titles(never.data.picks), ['D&D Starter Set', 'Call of Cthulhu Keeper Rulebook']);
  assert.equal(never.data.wildcard, null, 'fewer than 4: no wildcard');
  assert.deepEqual(never.data.picks[0].rpg, { system: 'D&D 5e', starter: true, setting: 'fantasy', type: 'starter' });
  const horror = await quiz({ mode: 'rpg', rpg: { tried: 'lots', players: 4, setting: 'horror', gm: 'own' } });
  assert.equal(horror.data.picks[0].title, 'Call of Cthulhu Keeper Rulebook');
  assert.deepEqual(horror.data.picks[0].why[0], { code: 'theme', group: 'spooky' });
  const crowd = await quiz({ mode: 'rpg', rpg: { tried: 'some', players: 7, setting: 'any' } });
  assert.deepEqual(crowd.data.relaxed, ['players'], 'nobody fits 7, so the closest come back');
});

/* ---------------- sessions, sharing and the routes around them ---------------- */

test('sessions: a wrong edit key makes a new session (never changes the one shared); the shared link is read only, with availability now', async () => {
  catalogue();
  const mine = await quiz({ players: 4, context: { door: 'table', table: 't14' } }, SAM);
  const { id, editKey } = mine.data.session;
  const row = lair.sql.exec('SELECT * FROM pick_sessions WHERE id = ?', id).one();
  assert.deepEqual([row.customer_id, row.door, row.table_code, row.mode, row.saved, JSON.parse(row.picks).length], [SAM, 'table', 'T14', 'play', 0, 3]);
  assert.equal(JSON.parse(row.answers).context, undefined, 'answers are saved without context');
  // someone with the link but not the key: a new session, the shared one untouched
  const other = await quiz({ players: 2, sessionId: id, editKey: 'x'.repeat(20) });
  assert.notEqual(other.data.session.id, id);
  assert.deepEqual(JSON.parse(lair.sql.exec('SELECT answers FROM pick_sessions WHERE id = ?', id).one().answers).players, 4);
  // the shared link: anyone, read only, availability worked out now
  hold(mine.data.picks[0].productId, KIRI);
  const shared = await call('GET', `pick/${id}`);
  assert.equal(shared.status, 200, said(shared));
  assert.deepEqual(Object.keys(shared.data), ['session', 'mode', 'picks', 'wildcard', 'playerType', 'answers', 'createdAt']);
  assert.deepEqual(shared.data.session, { id }, 'no edit key in a shared link');
  assert.deepEqual(ids(shared.data.picks), ids(mine.data.picks));
  assert.deepEqual(shared.data.picks[0].why, mine.data.picks[0].why);
  assert.equal(shared.data.picks[0].availability.available, 0, 'worked out now');
  assert.equal(said(await call('GET', 'pick/NoSuchOne2')), `404 ${PICK_MESSAGES.gone}`);
  assert.equal(said(await call('GET', 'pick/short')), `404 ${PICK_MESSAGES.gone}`);
  // a guest's session keeps no personal details
  const guest = (await quiz({ players: 3 })).data.session.id;
  assert.equal(lair.sql.exec('SELECT customer_id FROM pick_sessions WHERE id = ?', guest).one().customer_id, null);
});

test('the card: the game, its shelf in parts, where it stands, add-ons, the video, missing pieces and the shop copy', async () => {
  catalogue();
  lair.sql.exec("UPDATE pick_catalog SET missing_pieces = 1, missing_note = 'One sheep missing' WHERE product_id = ?", G.catan);
  lair.pickCache = null;
  loan(G.catan, KIRI);
  const res = await call('GET', `pick/game/${G.catan}`, null, SAM);
  assert.equal(res.status, 200, said(res));
  const card = res.data.game;
  assert.deepEqual(Object.keys(card), ['productId', 'variantId', 'handle', 'title', 'image', 'summary', 'blurb', 'shelfCode', 'shelf', 'players', 'time', 'weight', 'brain', 'age', 'mode',
    'vibes', 'themes', 'reading', 'access', 'table', 'video', 'inStoreOnly', 'missingPieces', 'missingNote', 'availability', 'staffPick', 'isNew', 'underplayed', 'addOns', 'shopCopy', 'rpg']);
  assert.deepEqual([card.productId, card.variantId, card.title, card.shelfCode, card.shelf, card.brain, card.missingPieces, card.missingNote], [G.catan, variantOf(G.catan), 'Catan', 'DGL34-M011', { section: 'DGL34', size: 'M', number: 11 }, 'some', true, 'One sheep missing']);
  assert.deepEqual(card.availability, { copies: 1, available: 0, held: 0, out: 1, nextFree: null, mine: null, atHome: null });
  assert.deepEqual(card.addOns, [{ productId: G.seafarers, title: 'Catan: Seafarers', handle: 'catan-seafarers', available: 1 }]);
  assert.equal(card.video, 'https://www.youtube.com/watch?v=abc123XYZ_-');
  assert.equal(card.shopCopy, null);
  // their own copy at home shows as theirs; RPG books have no size; new and underplayed nudges
  assert.deepEqual((await call('GET', `pick/game/${G.catan}`, null, KIRI)).data.game.availability.atHome, { id: `ln_${G.catan}_${KIRI}_out`, outAt: NOW - 10 * DAY });
  assert.deepEqual((await call('GET', `pick/game/${G.dnd}`)).data.game.shelf, { section: 'DGLRPG', size: null, number: 10 });
  const wingspan = (await call('GET', `pick/game/${G.wingspan}`)).data.game;
  assert.deepEqual([wingspan.isNew, wingspan.underplayed], [true, false], 'on Shopify 20 days: new, too new to be underplayed');
  assert.deepEqual([(await call('GET', `pick/game/${G.azul}`)).data.game.underplayed], [true], 'catalogued over 30 days, no hold or loan in 90');
  // not an active library game: 404 game
  assert.equal(said(await call('GET', 'pick/game/8199999999999')), `404 ${PICK_MESSAGES.game}`);
  assert.equal(said(await call('GET', 'pick/game/not-a-number')), `404 ${PICK_MESSAGES.game}`);
  lair.sql.exec("UPDATE pick_catalog SET status = 'gone' WHERE product_id = ?", G.azul);
  lair.pickCache = null;
  assert.equal(said(await call('GET', `pick/game/${G.azul}`)), `404 ${PICK_MESSAGES.game}`);
});

test('rate limit: 300 quiz requests in 10 minutes across /pick, /pick/swipes, /pick/known and /pick/game (429 busy), a logged-in customer\'s own, else the connection\'s; staff aren\'t limited', async () => {
  catalogue();
  assert.equal(PICK_LIMITS.quizPer10Min, 300);
  const headers = { client: '198.51.100.9' };
  for (let i = 0; i < PICK_LIMITS.quizPer10Min / 4; i += 1) {
    assert.equal((await call('POST', 'pick', { players: 4 }, '', headers)).status, 200);
    assert.equal((await call('POST', 'pick/swipes', { players: 4 }, '', headers)).status, 200);
    assert.equal((await call('GET', 'pick/known?q=cat', null, '', headers)).status, 200);
    assert.equal((await call('GET', `pick/game/${G.catan}`, null, '', headers)).status, 200);
  }
  for (const res of [await call('POST', 'pick', { players: 4 }, '', headers), await call('GET', 'pick/known?q=cat', null, '', headers)]) {
    assert.deepEqual([res.status, res.data], [429, { error: PICK_MESSAGES.busy }]);
  }
  assert.equal((await call('POST', 'pick', { players: 4 }, '', { client: '198.51.100.10' })).status, 200, 'another connection is fine');
  assert.equal((await call('POST', 'pick', { players: 4 }, SAM, headers)).status, 200, 'a logged-in customer on the same Wi-Fi has their own allowance');
  assert.equal((await call('POST', 'pick', { players: 4 }, STAFF, headers)).status, 200, 'staff aren\'t limited');
  Date.now = () => NOW + 10 * 60_000 + 1;
  assert.equal((await call('POST', 'pick', { players: 4 }, '', headers)).status, 200, '10 minutes on');
});

test('events: known actions on known sessions are kept, 50 a session at most; anything else is { ok: true } and ignored', async () => {
  catalogue();
  const { id } = (await quiz()).data.session;
  assert.deepEqual((await call('POST', `pick/${id}/event`, { action: 'reserve', productId: G.catan })).data, { ok: true });
  assert.deepEqual((await call('POST', `pick/${id}/event`, { action: 'dance', productId: G.catan })).data, { ok: true });
  assert.deepEqual((await call('POST', 'pick/NoSuchOne2/event', { action: 'view' })).data, { ok: true });
  assert.deepEqual(lair.sql.exec('SELECT session_id, product_id, action FROM pick_events').toArray().map((r) => ({ ...r })), [{ session_id: id, product_id: G.catan, action: 'reserve' }]);
  for (let i = 0; i < 60; i += 1) await call('POST', `pick/${id}/event`, { action: 'view' });
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM pick_events WHERE session_id = ?', id).one().n, 50);
});

test('save: logged in, with the edit key; 401 login, 404 gone, 403 notYours; My Lair shows the last 5', async () => {
  catalogue();
  const guestPicks = (await quiz({ players: 3 })).data.session;
  assert.equal(said(await call('POST', `pick/${guestPicks.id}/save`, { editKey: guestPicks.editKey })), `401 ${PICK_MESSAGES.login}`);
  assert.equal(said(await call('POST', 'pick/NoSuchOne2/save', { editKey: guestPicks.editKey }, SAM)), `404 ${PICK_MESSAGES.gone}`);
  assert.equal(said(await call('POST', `pick/${guestPicks.id}/save`, { editKey: 'nope' }, SAM)), `403 ${PICK_MESSAGES.notYours}`);
  // a guest's session joins their account when they save it
  const saved = await call('POST', `pick/${guestPicks.id}/save`, { editKey: guestPicks.editKey }, SAM);
  assert.equal(saved.status, 200, said(saved));
  assert.equal(saved.data.ok, true);
  assert.equal(saved.data.saved[0].id, guestPicks.id);
  assert.deepEqual(Object.keys(saved.data.saved[0]), ['id', 'createdAt', 'playerType', 'picks']);
  assert.deepEqual(Object.keys(saved.data.saved[0].picks[0]), ['productId', 'title', 'handle', 'image']);
  // once it's Sam's, Kiri can't take it, even with the key
  assert.equal(said(await call('POST', `pick/${guestPicks.id}/save`, { editKey: guestPicks.editKey }, KIRI)), `403 ${PICK_MESSAGES.notYours}`);
  for (let i = 1; i <= 6; i += 1) {
    Date.now = () => NOW + i * 60_000;
    const s = (await quiz({ players: 2 + (i % 3) }, SAM)).data.session;
    await call('POST', `pick/${s.id}/save`, { editKey: s.editKey }, SAM);
  }
  const mine = (await call('GET', 'me/picks', null, SAM)).data.saved;
  assert.equal(mine.length, 5);
  assert.ok(mine[0].createdAt > mine[4].createdAt, 'newest first');
});

test('email: the picks to that address, 3 a session and 30 an hour a connection (429 busy); 422 email, 404 gone, 403 notYours', async () => {
  catalogue();
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify({ id: 'e1' }), { status: 200 });
  };
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>' };
  const headers = { client: '192.0.2.50' };
  const s = (await quiz({ players: 4 }, '', headers)).data.session;
  const send = (body, session = s) => call('POST', `pick/${session.id}/email`, { editKey: session.editKey, ...body }, '', headers);
  assert.equal(said(await send({ email: 'not an email' })), `422 ${PICK_MESSAGES.email}`);
  assert.equal(said(await call('POST', `pick/${s.id}/email`, { email: 'sam@example.com', editKey: 'wrong' }, '', headers)), `403 ${PICK_MESSAGES.notYours}`);
  assert.equal(said(await call('POST', 'pick/NoSuchOne2/email', { email: 'sam@example.com', editKey: s.editKey }, '', headers)), `404 ${PICK_MESSAGES.gone}`);
  const ok = await send({ email: 'sam@example.com' });
  assert.deepEqual([ok.status, ok.data], [200, { ok: true }]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].to, sent[0].subject], ['sam@example.com', 'Your game picks from Dice Goblin']);
  assert.match(sent[0].text, /See them again: https:\/\/www\.dicegoblin\.nz\/pages\/help-me-pick\?p=/);
  assert.match(sent[0].text, /Book a table: https:\/\/www\.dicegoblin\.nz\/pages\/book-a-table/);
  assert.match(sent[0].text, /Join the library: /);
  assert.match(sent[0].text, /players/);
  assert.match(sent[0].html, /cdn\.shopify\.com/, 'each pick\'s picture');
  await send({ email: 'sam@example.com' });
  await send({ email: 'sam@example.com' });
  assert.equal(said(await send({ email: 'sam@example.com' })), `429 ${PICK_MESSAGES.busy}`, '3 a session');
  // 30 an hour a connection, across sessions (3 sent above)
  assert.equal(PICK_LIMITS.emailsPerHour, 30);
  for (let i = 0; i < 9; i += 1) {
    const other = (await quiz({ players: 4 }, '', headers)).data.session;
    for (let j = 0; j < 3; j += 1) assert.equal((await send({ email: 'kiri@example.com' }, other)).status, 200);
  }
  const last = (await quiz({ players: 4 }, '', headers)).data.session;
  assert.equal(said(await send({ email: 'kiri@example.com' }, last)), `429 ${PICK_MESSAGES.busy}`, '30 an hour');
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error('no');
  };
});

test('swipes: up to 8 games that pass the hard rules, as different as possible, never one they rated down', async () => {
  catalogue();
  const res = await call('POST', 'pick/swipes', { mode: 'borrow', players: 4 });
  assert.equal(res.status, 200, said(res));
  const c = res.data.candidates;
  assert.equal(c.length, 8);
  assert.deepEqual(Object.keys(c[0]), ['productId', 'title', 'image', 'summary', 'players', 'time', 'weight']);
  assert.equal(new Set(ids(c)).size, 8);
  for (const g of c) assert.ok(g.players.min <= 4 && g.players.max >= 4, g.title);
  assert.ok(!ids(c).some((id) => [G.seafarers, G.cards, G.dnd].includes(id)));
  // the two near-twin Adventure Games never both make the eight
  assert.ok(!(ids(c).includes(G.adv1) && ids(c).includes(G.adv2)));
  lair.sql.exec("INSERT INTO game_ratings (customer_id, product_id, rating, source, created_at) VALUES (?, ?, -1, 'page', ?)", SAM, c[0].productId, NOW);
  assert.ok(!ids((await call('POST', 'pick/swipes', { mode: 'borrow', players: 4 }, SAM)).data.candidates).includes(c[0].productId));
  // fewer than 8 pass: as many as there are
  assert.deepEqual(titles((await call('POST', 'pick/swipes', { players: 3, kids: true, youngest: 4 })).data.candidates), ['Animal Upon Animal']);
});

test('known: library titles then famous titles and aliases, starts-with first, case and accents ignored, no title twice, 8 at most', async () => {
  catalogue();
  PICK_DATA.known = [
    { title: 'Monopoly', aliases: ['Monopoly Deal'], players: { min: 2, max: 6 }, time: { min: 60, max: 180 }, weight: 1.6, age: 8, mode: 'competitive', vibes: ['cutthroat'], themes: ['city'], styles: ['trading', 'dice-rolling'] },
    { title: 'Catan', aliases: ['Settlers of Catan'], players: { min: 3, max: 4 }, time: { min: 60, max: 90 }, weight: 2.3, age: 10, mode: 'competitive', vibes: ['thinky'], themes: ['farming'], styles: ['trading'] },
    { title: 'Café International', aliases: [], players: { min: 2, max: 4 }, time: { min: 45, max: 60 }, weight: 1.8, age: 10, mode: 'competitive', vibes: ['chill'], themes: ['food'], styles: ['tile-laying'] },
  ];
  const known = async (q) => (await call('GET', `pick/known?q=${encodeURIComponent(q)}`)).data.games;
  assert.deepEqual(await known('cat'), [
    { key: G.catan, title: 'Catan', productId: G.catan },
  ], 'the library\'s Catan; the famous one has the same title, so it\'s left out (and not the expansion)');
  assert.deepEqual(await known('settlers'), [{ key: 'known:Catan', title: 'Catan', productId: null }], 'by an alias');
  assert.deepEqual(await known('CAFE'), [{ key: 'known:Café International', title: 'Café International', productId: null }], 'accents and case ignored');
  assert.deepEqual(await known('mono'), [
    { key: G.adv2, title: 'Adventure Games: Monochrome Inc.', productId: G.adv2 }, { key: 'known:Monopoly', title: 'Monopoly', productId: null },
  ], 'the library first, even when a famous game starts with it');
  // library first (those starting with it, then those containing it, each by title), then famous games; an expansion
  // (Seafarers) and anything not a game or RPG book are never offered
  assert.deepEqual((await known('an')).map((g) => g.title), ['Animal Upon Animal', 'Catan', 'D&D Starter Set', 'Pandemic', 'Spirit Island', 'Wingspan']);
  assert.deepEqual((await known('in')).map((g) => g.title), ['Adventure Games: Monochrome Inc.', 'Wingspan', 'Café International'], 'then famous games');
  assert.ok((await known('a')).length === 0, '2 characters at least');
  assert.ok((await known('e')).length === 0);
  assert.ok((await known('e'.repeat(61))).length === 0, '60 at most');
  assert.ok((await known('ga')).length <= 8);
  // loves: a famous game counts like a library one
  const loved = await quiz({ players: 4, filters: { loves: [{ known: 'Monopoly' }] } });
  assert.equal(loved.status, 200);
});

test('a member\'s taste: saved on every quiz; their likes and thumbs up count with useTaste; taste.has with 3 or more', async () => {
  catalogue();
  await quiz({ players: 4, vibes: ['chill'], swipes: { [G.ticket]: 'like', [G.azul]: 'like', [G.scythe]: 'nope' } }, SAM);
  const row = lair.sql.exec('SELECT * FROM pick_taste WHERE customer_id = ?', SAM).one();
  assert.deepEqual([JSON.parse(row.likes), JSON.parse(row.nopes), row.player_type], [[G.ticket, G.azul], [G.scythe], 'chill']);
  assert.deepEqual(JSON.parse(row.answers), { mode: 'play', players: 4, kids: false, youngest: null, time: null, brain: null, team: 'either', vibes: ['chill'] });
  assert.equal((await call('GET', 'me/picks', null, SAM)).data.taste.has, false);
  // changing their mind moves a game from one list to the other
  await quiz({ players: 4, swipes: { [G.azul]: 'nope' } }, SAM);
  const again = lair.sql.exec('SELECT likes, nopes FROM pick_taste WHERE customer_id = ?', SAM).one();
  assert.deepEqual([JSON.parse(again.likes), JSON.parse(again.nopes)], [[G.ticket], [G.scythe, G.azul]]);
  await call('POST', 'library/rate', { productId: G.dixit, rating: 'up' }, SAM);
  await call('POST', 'library/rate', { productId: G.wingspan, rating: 'up' }, SAM);
  assert.equal((await call('GET', 'me/picks', null, SAM)).data.taste.has, true, 'likes and rated games together: 3');
  // with useTaste their likes help (half weight), without they don't
  const withTaste = await quiz({ players: 4, useTaste: true }, SAM);
  const without = await quiz({ players: 4 }, SAM);
  const score = (data, id) => all(data).findIndex((c) => c.productId === id);
  assert.ok(withTaste.status === 200 && without.status === 200);
  assert.ok(score(withTaste.data, G.ticket) <= score(without.data, G.ticket) || score(without.data, G.ticket) === -1);
  // a guest has no taste row
  await quiz({ players: 4, swipes: { [G.ticket]: 'like' } });
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM pick_taste').one().n, 1);
});

/* ---------------- ratings and a member's picks ---------------- */

test('ratings: up, down and null (taken off), for library games in the catalogue; 401 loginRate, 422 product; toRate is their games back in 30 days, unrated', async () => {
  catalogue();
  assert.equal(said(await call('POST', 'library/rate', { productId: G.catan, rating: 'up' })), `401 ${PICK_MESSAGES.loginRate}`);
  assert.equal(said(await call('POST', 'library/rate', { productId: '8199999999999', rating: 'up' }, SAM)), `422 ${PICK_MESSAGES.product}`);
  assert.equal(said(await call('POST', 'library/rate', { productId: 'catan', rating: 'up' }, SAM)), `422 ${PICK_MESSAGES.product}`);
  assert.deepEqual((await call('POST', 'library/rate', { productId: `gid://shopify/Product/${G.catan}`, rating: 'up', source: 'return' }, SAM)).data, { ok: true, productId: G.catan, rating: 'up' });
  assert.deepEqual((await call('POST', 'library/rate', { productId: G.catan, rating: 'down', source: 'nowhere' }, SAM)).data, { ok: true, productId: G.catan, rating: 'down' });
  assert.deepEqual(lair.sql.exec('SELECT customer_id, product_id, rating, source FROM game_ratings').toArray().map((r) => ({ ...r })), [{ customer_id: SAM, product_id: G.catan, rating: -1, source: 'page' }]);
  assert.deepEqual((await call('POST', 'library/rate', { productId: G.catan, rating: null }, SAM)).data, { ok: true, productId: G.catan, rating: null });
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM game_ratings').one().n, 0);

  // toRate: back on the shelf in the last 30 days, not rated, newest first, 5 at most
  const back = [G.catan, G.ticket, G.pandemic, G.azul, G.dixit, G.wingspan, G.scythe];
  back.forEach((id, i) => loan(id, SAM, 'returned', { returnedAt: NOW - (i + 1) * DAY, id: `ln_back_${i}` }));
  loan(G.uno, SAM, 'returned', { returnedAt: NOW - 31 * DAY, id: 'ln_old' });
  loan(G.haba, SAM, 'out', { id: 'ln_home' });
  loan(G.codenames, KIRI, 'returned', { id: 'ln_kiri' });
  loan(G.sushi, SAM, 'returned', { id: 'ln_noproduct', noProduct: true, returnedAt: NOW - 3600_000, title: 'Sushi Go Party! (Library)' });
  await call('POST', 'library/rate', { productId: G.ticket, rating: 'up' }, SAM);
  const mine = (await call('GET', 'me/picks', null, SAM)).data;
  assert.deepEqual(Object.keys(mine), ['saved', 'taste', 'toRate', 'ratings']);
  assert.deepEqual(mine.toRate.map((r) => r.productId), [G.sushi, G.catan, G.pandemic, G.azul, G.dixit], 'found by its variant when the loan has no product');
  assert.deepEqual(Object.keys(mine.toRate[0]), ['loanId', 'productId', 'title', 'handle', 'image', 'returnedAt']);
  assert.deepEqual([mine.toRate[0].loanId, mine.toRate[0].title], ['ln_noproduct', 'Sushi Go Party!']);
  assert.deepEqual(mine.ratings, { [G.ticket]: 'up' });
  assert.equal(said(await call('GET', 'me/picks')), `401 ${PICK_MESSAGES.login}`);
});

/* ---------------- staff ---------------- */

test('staff routes: perm library (a helper without it gets 403); the check list, low confidence first; editing facts, checking and staff picks', async () => {
  catalogue();
  lair.sql.exec("UPDATE pick_facts SET facts = json_set(facts, '$.confidence', 'low') WHERE product_id IN (?, ?)", G.uno, G.azul);
  lair.sql.exec("UPDATE pick_facts SET source = 'auto' WHERE product_id = ?", G.azul);
  lair.pickCache = null;
  for (const [method, path, body] of [['GET', 'pick/games'], ['POST', `pick/games/${G.catan}`, { checked: true }], ['POST', 'pick/sync', {}]]) {
    assert.equal((await call(method, path, body, HELPER)).status, 403, path);
    assert.equal((await call(method, path, body, SAM)).status, 403, path);
  }
  const list = await call('GET', 'pick/games?filter=check&limit=3', null, LIBRARIAN);
  assert.equal(list.status, 200, said(list));
  assert.equal(list.data.total, LIBRARY.length);
  assert.deepEqual(list.data.games.map((g) => g.title), ['Azul', 'Uno', 'Adventure Games: Monochrome Inc.'], 'low confidence first (auto before seed), then auto, basic, seed, then by title');
  lair.sql.exec("UPDATE pick_facts SET source = 'basic' WHERE product_id = ?", G.scythe);
  lair.pickCache = null;
  assert.equal((await call('GET', 'pick/games?filter=check&offset=2&limit=1', null, STAFF)).data.games[0].title, 'Scythe', 'basic before seed after the low ones');
  assert.deepEqual(Object.keys(list.data.games[0]), ['productId', 'title', 'handle', 'image', 'shelfCode', 'facts', 'source', 'checked', 'checkedBy', 'checkedAt', 'staffPick', 'status']);
  assert.deepEqual((await call('GET', 'pick/games?filter=all&q=dgl34-m0', null, STAFF)).data.games.map((g) => g.title).sort(), ['Catan', 'Catan: Seafarers', 'Pandemic']);
  assert.deepEqual((await call('GET', 'pick/games?filter=all&q=CATAN', null, STAFF)).data.total, 2);
  assert.equal((await call('GET', 'pick/games?filter=auto', null, STAFF)).data.total, 1);
  assert.equal((await call('GET', 'pick/games?limit=500', null, STAFF)).data.games.length, LIBRARY.length, 'limit 100 at most');

  // "Looks right" (who checked it, by first name from their member record; the Lair keeps their customer ID)
  await call('POST', 'me/profile', { name: 'Lee Hana' }, LIBRARIAN);
  const ok = await call('POST', `pick/games/${G.catan}`, { checked: true }, LIBRARIAN);
  assert.deepEqual([ok.status, ok.data.game.checked, ok.data.game.checkedBy, ok.data.game.checkedAt, ok.data.game.source], [200, true, 'Lee', NOW, 'seed']);
  assert.equal(lair.sql.exec('SELECT checked_by FROM pick_facts WHERE product_id = ?', G.catan).one().checked_by, LIBRARIAN);
  assert.equal((await call('GET', 'pick/games?filter=check', null, STAFF)).data.total, LIBRARY.length - 1);
  // new facts: 422 with the field, else staff and checked
  assert.equal(said(await call('POST', `pick/games/${G.azul}`, { facts: { ...LIBRARY[5].facts, weight: 9 } }, STAFF)), "422 That game's details don't look right: weight.");
  assert.equal(said(await call('POST', `pick/games/${G.azul}`, { facts: { ...LIBRARY[5].facts, players: { min: 2, max: 4, best: [9] } } }, STAFF)), "422 That game's details don't look right: players.best.");
  const edited = await call('POST', `pick/games/${G.azul}`, { facts: { ...LIBRARY[5].facts, summary: 'Draft tiles and lay them out in neat patterns on your board.' }, staffPick: true }, STAFF);
  assert.deepEqual([edited.data.game.source, edited.data.game.checked, edited.data.game.staffPick, edited.data.game.facts.summary], ['staff', true, true, 'Draft tiles and lay them out in neat patterns on your board.']);
  assert.equal((await call('GET', 'pick/games?filter=staff-picks', null, STAFF)).data.games[0].title, 'Azul');
  // the low, auto and basic lists are work lists: Azul, checked now, has left them (Uno, low and not checked, stays)
  assert.deepEqual((await call('GET', 'pick/games?filter=low', null, STAFF)).data.games.map((g) => g.title), ['Uno']);
  assert.equal((await call('GET', 'pick/games?filter=auto', null, STAFF)).data.total, 0);
  // saving the same facts marks it checked but doesn't make it staff's; checked: false with them leaves it unchecked
  const same = await call('POST', `pick/games/${G.wingspan}`, { facts: LIBRARY[6].facts }, STAFF);
  assert.deepEqual([same.data.game.source, same.data.game.checked, same.data.game.checkedBy], ['seed', true, null], 'no member record for them: no name');
  const unsure = await call('POST', `pick/games/${G.dixit}`, { facts: LIBRARY[4].facts, checked: false }, STAFF);
  assert.deepEqual([unsure.data.game.source, unsure.data.game.checked], ['seed', false]);
  // a staff pick shows on the card and nudges the wildcard
  assert.equal((await call('GET', `pick/game/${G.azul}`)).data.game.staffPick, true);
  assert.equal(said(await call('POST', 'pick/games/8199999999999', { checked: true }, STAFF)), `422 ${PICK_MESSAGES.product}`);
  // a staff edit is never overwritten by a newer seed
  start(Object.fromEntries(LIBRARY.map((g) => [g.id, { ...g.facts, summary: 'The next seed says something else about it.' }])), 'test-9');
  assert.equal(lair.pickGame(G.azul).title, 'Azul');
  assert.equal(lair.pickGames().byId.get(G.azul).facts.summary, 'Draft tiles and lay them out in neat patterns on your board.');
  assert.equal(lair.pickGames().byId.get(G.catan).facts.summary, LIBRARY[0].facts.summary, 'checked: kept');
});

test('POST /pick/sync (perm library): a full sync now and up to 5 auto-tags → { synced, added, gone, tagged }', async () => {
  const shopify = fakeShopify({ library: LIBRARY.slice(0, 3).map((g) => node(g)).concat([node({ id: '8200000000009', title: 'Fresh Arrival', code: 'DGL34-M300' })]), shop: [] });
  lair.env = { ...lair.baseEnv, AI: fakeAI([{ choices: [{ message: { content: JSON.stringify({ ...facts({ summary: 'A fresh arrival to the test library shelves.' }), expansionOfTitle: null }) } }] }]) };
  lair.useConfig = async () => {};
  const res = await call('POST', 'pick/sync', {}, LIBRARIAN);
  assert.equal(res.status, 200, said(res));
  assert.deepEqual(res.data, { synced: 4, added: 4, gone: 0, tagged: 1 });
  assert.equal(lair.sql.exec("SELECT source FROM pick_facts WHERE product_id = '8200000000009'").one().source, 'auto');
  shopify.down = true;
  assert.equal((await call('POST', 'pick/sync', {}, STAFF)).status, 503);
});

test('the report (perm library or community): sessions, doors, modes, finished, actions, asks and gaps, picked and acted on, never picked, ratings, relaxed', async () => {
  catalogue();
  const a = (await quiz({ players: 4, time: 'medium', context: { door: 'library' } })).data;
  const b = (await quiz({ players: 4, time: 'medium', context: { door: 'kiosk' } })).data;
  const c = (await quiz({ mode: 'borrow', players: 5, time: 'epic', filters: { lightReading: true }, context: { door: 'kiosk' } })).data;
  Date.now = () => NOW - 40 * DAY;
  await quiz({ players: 2, context: { door: 'page' } });
  Date.now = () => NOW;
  await call('POST', `pick/${a.session.id}/event`, { action: 'reserve', productId: a.picks[0].productId });
  await call('POST', `pick/${b.session.id}/event`, { action: 'book', productId: a.picks[0].productId });
  await call('POST', `pick/${b.session.id}/event`, { action: 'view' });
  await call('POST', 'library/rate', { productId: G.catan, rating: 'up' }, SAM);
  await call('POST', 'library/rate', { productId: G.catan, rating: 'down' }, KIRI);
  await call('POST', 'library/rate', { productId: G.uno, rating: 'down' }, KIRI);
  assert.equal((await call('GET', 'pick/report', null, HELPER)).status, 403);
  assert.equal((await call('GET', 'pick/report', null, COMMUNITY)).status, 200);
  const r = (await call('GET', 'pick/report?days=30', null, LIBRARIAN)).data;
  assert.deepEqual([r.from, r.to, r.sessions, r.finished], [NOW - 30 * DAY, NOW, 3, 3]);
  assert.deepEqual([r.byDoor, r.byMode], [{ library: 1, kiosk: 2 }, { play: 2, borrow: 1 }]);
  assert.deepEqual(r.actions, { reserve: 1, book: 1, view: 1 });
  assert.deepEqual(r.asks[0], { players: 4, time: 'medium', brain: null, team: 'either', vibes: [], count: 2, fitCount: a.fitCount, gap: false });
  assert.deepEqual(r.gaps.map((x) => [x.players, x.time, x.count, x.gap]), [[5, 'epic', 1, true]]);
  assert.deepEqual(c.relaxed, ['time']);
  assert.deepEqual(r.relaxed, { time: 1, filters: 0, availability: 0, players: 0 });
  const top = r.picked.find((p) => p.productId === a.picks[0].productId);
  assert.deepEqual([top.shown, top.acted], [2, 2]);
  assert.deepEqual(r.acted[0], { productId: a.picks[0].productId, title: a.picks[0].title, shown: 2, acted: 2, actions: 2 });
  const shownIn30 = new Set([...all(a), ...all(b), ...all(c)].map((x) => x.productId));
  assert.equal(r.neverPicked, LIBRARY.filter((g) => ['game', 'rpg'].includes(g.facts.kind) && !shownIn30.has(g.id)).length, 'none of the window\'s sessions showed them');
  assert.deepEqual(r.ratings.up, [{ productId: G.catan, title: 'Catan', ups: 1, downs: 1 }]);
  assert.deepEqual(r.ratings.down.map((x) => x.title), ['Uno', 'Catan']);
  assert.equal((await call('GET', 'pick/report?days=90', null, STAFF)).data.sessions, 4);
  assert.equal((await call('GET', 'pick/report?days=12', null, STAFF)).data.from, NOW - 30 * DAY, 'anything else is 30');
});

/* ---------------- maintenance and the other half's interface ---------------- */

test('maintenance: step 1 syncs and tags (each on its own, never throwing); step 6 deletes unsaved sessions over 180 days, 500 a run', async () => {
  catalogue();
  const old = (await quiz({ players: 4 })).data.session;
  const kept = (await quiz({ players: 4 }, SAM)).data.session;
  await call('POST', `pick/${kept.id}/save`, { editKey: kept.editKey }, SAM);
  await call('POST', `pick/${old.id}/event`, { action: 'view' });
  lair.sql.exec('UPDATE pick_sessions SET created_at = ?', NOW - 181 * DAY);
  const fresh = (await quiz({ players: 4 })).data.session;
  assert.equal(lair.prunePickSessions(NOW), 1);
  assert.deepEqual(lair.sql.exec('SELECT id FROM pick_sessions ORDER BY id').toArray().map((r) => r.id).sort(), [kept.id, fresh.id].sort());
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM pick_events WHERE session_id = ?', old.id).one().n, 0, 'its events go too');
  for (let i = 0; i < 520; i += 1) lair.sql.exec("INSERT INTO pick_sessions (id, edit_key, created_at) VALUES (?, 'k', ?)", `old${String(i).padStart(7, '0')}`, NOW - 200 * DAY);
  assert.equal(lair.prunePickSessions(NOW), 500);
  assert.equal(lair.prunePickSessions(NOW), 20);
  // the maintenance run: no Shopify and no AI, so step 1 does nothing and says so by leaving no pick entry
  const run = await call('POST', 'internal/maintenance', {}, '', { 'X-Lair-Internal': '1' });
  assert.equal(run.status, 200, said(run));
  assert.equal(run.data.pick, undefined);
  // a failing step never stops the rest
  lair.syncCatalog = async () => { throw new Error('boom'); };
  lair.autoTag = async () => { throw new Error('bang'); };
  const notes = [];
  lair.note = (entry) => notes.push(entry);
  assert.equal(await lair.pickUpkeep(), null);
  assert.match(notes[0].catalogError.message, /boom/);
});

test('pickGame (for src/queue.js): an active catalogue game with facts as { productId, variantId, title, handle, image, shelfCode, copies, inStoreOnly, kind, table, status }', async () => {
  catalogue([...LIBRARY.slice(0, 8).map((g) => (g.id === G.scythe ? { ...g, copies: 3 } : g))]);
  assert.deepEqual(lair.pickGame(G.scythe), {
    productId: G.scythe, variantId: variantOf(G.scythe), title: 'Scythe', handle: 'scythe', image: `https://cdn.shopify.com/s/files/1/${G.scythe}.png`, shelfCode: 'DGL56-L030',
    copies: 3, inStoreOnly: false, kind: 'game', table: 'double', status: 'active',
  });
  assert.equal(lair.pickGame(`gid://shopify/Product/${G.catan}`).title, 'Catan');
  assert.equal(lair.pickGame(G.uno), null, 'not in the catalogue');
  assert.equal(lair.pickGame('nope'), null);
  // no copies from Shopify: what a library page last sent, else 1
  lair.sql.exec('UPDATE pick_catalog SET copies = NULL WHERE product_id = ?', G.catan);
  lair.pickCache = null;
  assert.equal(lair.pickGame(G.catan).copies, 1);
  lair.sql.exec("INSERT INTO library_holds (id, variant_id, product_id, title, copies, customer_id, status, until, created_at) VALUES ('lh_x', ?, ?, 'Catan', 2, ?, 'cancelled', ?, ?)", variantOf(G.catan), G.catan, SAM, NOW, NOW);
  assert.equal(lair.pickGame(G.catan).copies, 2);
  // gone from Shopify: null
  lair.sql.exec("UPDATE pick_catalog SET status = 'gone' WHERE product_id = ?", G.ticket);
  lair.pickCache = null;
  assert.equal(lair.pickGame(G.ticket), null);
});

test('the booking door: a copy another booking has in that window isn\'t free for this one (bookedGamesOverlapping); a missing method is an empty set', async () => {
  catalogue();
  const date = time.key(NOW + 3 * DAY);
  const body = { players: 4, team: 'coop', context: { door: 'booking', date } };
  const before = await quiz(body);
  assert.ok(ids(all(before.data)).includes(G.pandemic));
  let asked = null;
  lair.bookedGamesOverlapping = (start, end) => {
    asked = [start, end];
    return new Set([G.pandemic]);
  };
  const after = await quiz(body);
  assert.deepEqual(asked, [time.at(date, 0), time.at(time.key(NOW + 4 * DAY), 0)], 'the whole Lair day');
  assert.ok(!ids(after.data.picks).includes(G.pandemic), 'its only copy is another booking\'s');
  // two copies: one is still free
  lair.sql.exec('UPDATE pick_catalog SET copies = 2 WHERE product_id = ?', G.pandemic);
  lair.pickCache = null;
  assert.ok(ids(all((await quiz(body)).data)).includes(G.pandemic));
  // the queue's own method (src/queue.js, merged): with no booking holding a game, nothing is taken
  delete lair.bookedGamesOverlapping;
  assert.equal(typeof lair.bookedGamesOverlapping, 'function');
  assert.ok(ids(all((await quiz(body)).data)).includes(G.pandemic));
  // and without it (a Lair from before the queue's half), nothing is taken either
  const own = Object.getPrototypeOf(lair).bookedGamesOverlapping;
  lair.bookedGamesOverlapping = undefined;
  assert.ok(ids(all((await quiz(body)).data)).includes(G.pandemic));
  lair.bookedGamesOverlapping = own;
});

test('after "Show me different picks", a refresh keeps the new picks and a fine-tune (new answers) starts from the best again', async () => {
  catalogue();
  const first = await quiz({ players: 4 });
  const { id, editKey } = first.data.session;
  const again = await quiz({ players: 4, sessionId: id, editKey, again: true });
  assert.notDeepEqual(ids(again.data.picks), ids(first.data.picks));
  assert.deepEqual(ids((await quiz({ players: 4, sessionId: id, editKey })).data.picks), ids(again.data.picks), 'a refresh');
  const tuned = await quiz({ players: 4, sessionId: id, editKey, filters: { themes: ['travel'] } });
  assert.equal(tuned.data.picks[0].productId, G.ticket, 'the best for the new answers, even though it was shown before');
  assert.equal(tuned.data.session.id, id);
});

test('the booking door: a booking\'s own game isn\'t another booking\'s; a booking already holding its copy isn\'t counted twice; underplayed ignores a game at home', async () => {
  catalogue();
  lair.sql.exec('UPDATE pick_catalog SET copies = 2 WHERE product_id = ?', G.pandemic);
  lair.pickCache = null;
  // a booking's own hold (round 17's other half: kind 'booking'); it's already in held, so 1 of 2 copies is left
  lair.sql.exec(
    `INSERT INTO library_holds (id, variant_id, product_id, title, customer_id, status, until, created_by, created_at) VALUES ('lh_b', ?, ?, 'Pandemic', '', 'held', ?, 'booking', ?)`,
    variantOf(G.pandemic), G.pandemic, NOW + 4 * DAY, NOW,
  );
  try {
    lair.sql.exec("ALTER TABLE library_holds ADD COLUMN kind TEXT");
  } catch {
    // the other half may have added it already
  }
  lair.sql.exec("UPDATE library_holds SET kind = 'booking' WHERE id = 'lh_b'");
  lair.bookedGamesOverlapping = () => new Set([G.pandemic]);
  const body = { players: 4, team: 'coop', context: { door: 'booking', date: time.key(NOW + 3 * DAY) } };
  assert.ok(ids(all((await quiz(body)).data)).includes(G.pandemic), 'the held copy is counted once: one left');
  // the booking door with this booking's own game: never kept from itself
  try {
    lair.sql.exec('ALTER TABLE bookings ADD COLUMN game_product_id TEXT');
  } catch {
    // the other half may have added it already
  }
  lair.sql.exec("DELETE FROM library_holds WHERE id = 'lh_b'");
  lair.sql.exec('UPDATE pick_catalog SET copies = 1 WHERE product_id = ?', G.pandemic);
  lair.pickCache = null;
  lair.sql.exec(
    `INSERT INTO bookings (id, ref, kind, status, tables, starts_at, ends_at, people, game_product_id, created_at) VALUES ('bk_mine', 'SJ-OWLBEAR-17', 'table', 'confirmed', '["T5"]', ?, ?, 4, ?, ?)`,
    NOW + 3 * DAY, NOW + 3 * DAY + 3 * HOUR, G.pandemic, NOW,
  );
  const mine = await quiz({ players: 4, team: 'coop', context: { door: 'booking', bookingId: 'bk_mine' } });
  assert.ok(ids(all(mine.data)).includes(G.pandemic));
  const someoneElse = await quiz({ players: 4, team: 'coop', context: { door: 'booking', date: time.key(NOW + 3 * DAY) } });
  assert.ok(!ids(someoneElse.data.picks).includes(G.pandemic));
  // underplayed: a game at home since long ago is being played
  loan(G.azul, SAM, 'out', { outAt: NOW - 200 * DAY });
  lair.pickBusy = null; // what's been played is kept 10 minutes
  assert.equal((await call('GET', `pick/game/${G.azul}`)).data.game.underplayed, false);
});

test('sync (review): a full sync that finds no library listings (Shopify\'s search came back empty) marks nothing gone, keeps the shop copies and tries again next run', async () => {
  const shopify = fakeShopify({ library: LIBRARY.map((g) => node(g)), shop: [shopNode('9100000000001', 'Catan (5th Edition)')] });
  const first = await lair.syncCatalog();
  assert.deepEqual([first.kind, first.synced, first.gone, first.shop], ['full', LIBRARY.length, 0, 1]);
  // 6 hours on, Shopify's search comes back empty
  Date.now = () => NOW + 6 * HOUR + 60_000;
  shopify.library = [];
  shopify.shop = [];
  const notes = [];
  lair.note = (entry) => notes.push(entry);
  const empty = await lair.syncCatalog();
  assert.deepEqual([empty.kind, empty.synced, empty.gone], ['full', 0, 0]);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM pick_catalog WHERE status = 'active'").one().n, LIBRARY.length, 'every game is still in the library');
  assert.ok(lair.pickGame(G.catan), 'the quiz, queues and table bookings still know Catan');
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM pick_shop').one().n, 1, 'the shop copies stay');
  assert.match(notes.find((n) => n.catalogError)?.catalogError.message || '', /no library listings/);
  // it doesn't count as the full sync: the next run tries a full one again, and a real answer marks what has really gone
  Date.now = () => NOW + 6 * HOUR + 11 * 60_000;
  shopify.library = LIBRARY.filter((g) => g.id !== G.codenames).map((g) => node(g));
  const next = await lair.syncCatalog();
  assert.deepEqual([next.kind, next.gone], ['full', 1]);
  assert.equal(lair.sql.exec('SELECT status FROM pick_catalog WHERE product_id = ?', G.codenames).one().status, 'gone');
});

test('the card (review): a game held for my own table booking isn\'t shown as mine (one of my holds), as libraryStatus has it; it still takes the copy', async () => {
  catalogue();
  lair.sql.exec(
    `INSERT INTO library_holds (id, variant_id, product_id, title, customer_id, status, until, created_by, created_at, updated_at, kind, booking_id)
     VALUES ('lh_table', ?, ?, 'Azul', ?, 'held', ?, 'booking', ?, ?, 'booking', 'bk_x')`,
    variantOf(G.azul), G.azul, KIRI, NOW + DAY, NOW, NOW,
  );
  const card = (await call('GET', `pick/game/${G.azul}`, null, KIRI)).data.game;
  assert.deepEqual([card.availability.mine, card.availability.held, card.availability.available], [null, 1, 0]);
  const status = (await call('GET', `library/status?ids=${variantOf(G.azul)}`, null, KIRI)).data.games[variantOf(G.azul)];
  assert.deepEqual([status.mine, status.held, status.available], [null, 1, 0]);
  // a hold of her own is still hers
  hold(G.ticket, KIRI);
  assert.equal((await call('GET', `pick/game/${G.ticket}`, null, KIRI)).data.game.availability.mine?.id, `lh_${G.ticket}_${KIRI}`);
});

test('similarity (review): Jaccard counted in place gives exactly what Sets of the words give (the seed, the famous games and odd lists)', () => {
  const sets = (a, b) => {
    const A = new Set(Array.isArray(a) ? a : []);
    const B = new Set(Array.isArray(b) ? b : []);
    if (!A.size && !B.size) return 0;
    let both = 0;
    for (const x of A) if (B.has(x)) both += 1;
    return both / (A.size + B.size - both);
  };
  const lists = [...Object.values(PICK_SEED), ...PICK_KNOWN].flatMap((f) => [f.styles, f.themes, f.vibes]);
  const odd = [['a', 'a', 'b'], ['a'], [], null, undefined, ['b', 'b', 'c'], ['x', 'x'], 'abc'];
  const every = [...lists.filter((_, i) => i % 3 === 0), ...odd];
  let checked = 0;
  const wrong = [];
  for (const a of every) {
    for (const b of every) {
      checked += 1;
      if (jaccard(a, b) !== sets(a, b) && wrong.length < 3) wrong.push(`${JSON.stringify(a)} ~ ${JSON.stringify(b)}: ${jaccard(a, b)} not ${sets(a, b)}`);
    }
  }
  assert.ok(checked > 100000);
  assert.deepEqual(wrong, []);
});

test('auto-tag (review): a basic game staff have already checked ("Looks right") isn\'t sent to Workers AI, so it never holds up the new games', async () => {
  ctx = fakeCtx();
  start({ [G.catan]: LIBRARY[0].facts }, 'one');
  // seven new games, oldest first; staff check the five oldest as they are
  const fresh = Array.from({ length: 7 }, (_, i) => ({ id: `82000000001${i}`, title: `New Game ${i}`, code: `DGL34-M2${i}0` }));
  catalogue([...fresh, LIBRARY[0]]);
  fresh.forEach((g, i) => lair.sql.exec('UPDATE pick_facts SET created_at = ? WHERE product_id = ?', NOW - (10 - i) * HOUR, g.id));
  for (const g of fresh.slice(0, 5)) assert.equal((await call('POST', `pick/games/${g.id}`, { checked: true }, STAFF)).status, 200);
  const good = { ...facts({ confidence: 'medium', summary: 'Race your friends to build the best little town on the board.' }), expansionOfTitle: null };
  const ai = fakeAI(Array.from({ length: 10 }, () => ({ choices: [{ message: { content: JSON.stringify(good) } }] })));
  lair.env = { ...lair.baseEnv, AI: ai };
  assert.deepEqual(await lair.autoTag(), { tagged: 2, failed: 0 });
  assert.deepEqual(ai.calls.map((c) => JSON.parse(c.input.messages[1].content).title), ['New Game 5', 'New Game 6'], 'only the games nobody has checked');
  const facts0 = (id) => ({ ...lair.sql.exec('SELECT source, checked, ai_tries FROM pick_facts WHERE product_id = ?', id).one() });
  assert.deepEqual(facts0(fresh[0].id), { source: 'basic', checked: 1, ai_tries: 0 }, "staff's check stands");
  assert.deepEqual(await lair.autoTag(), { tagged: 0, failed: 0 });
  assert.equal(ai.calls.length, 2, 'and nothing is asked again on later runs');
});

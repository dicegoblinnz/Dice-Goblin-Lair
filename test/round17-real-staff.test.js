// Round 17, Help me pick: the staff page against the real Lair (contract v17, section 6 and 9.5). Two answers the staff
// page shows that the first build gave in a shape the page couldn't use: who checked a game (a name, not a customer ID)
// and the report's "most acted on" rows (picked's shape, with the actions). Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { rulesFromSettings } from '../src/core.js';
import { PICK_DATA } from '../src/pick.js';
import { PICK_SEED, PICK_SEED_VERSION } from '../src/pick-seed.js';

const DAY = 86_400_000;
// Friday 16 October 2026, 1:00pm in Auckland
const NOW = Date.UTC(2026, 9, 16, 0, 0);
const realNow = Date.now;
const realFetch = globalThis.fetch;

function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      // as SQLite in a Durable Object: at most 100 bound values a query (Cloudflare's limit; 27 Oct 2026)
      if (bindings.length > 100) throw new Error(`too many SQL variables: ${bindings.length}`);
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

// Mo, the main account; Caleb, a helper with Library; Ana, a helper with no member record (made before round 9's records)
const MO = '9001';
const CALEB = '9002';
const ANA = '9003';
const PERSON = {
  [MO]: { staff: true, role: 'owner', perms: [] },
  [CALEB]: { staff: true, role: 'helper', perms: ['library'] },
  [ANA]: { staff: true, role: 'helper', perms: ['library'] },
};
const facts = (over = {}) => ({
  kind: 'game', players: { min: 2, max: 5, best: [4] }, time: { min: 30, max: 60 }, weight: 2.0, age: 8, mode: 'competitive', vibes: ['laughs'],
  themes: ['abstract'], styles: ['set-collection'], reading: 'some', access: { colourBlind: null, easyPieces: null }, table: 'single', expansionOf: null,
  rpg: null, summary: 'A game from the test library with a plain summary.', confidence: 'high', ...over,
});
const LIBRARY = [
  { id: '8300000000001', title: 'Catan', facts: facts({ styles: ['trading', 'dice-rolling'], weight: 2.3 }) },
  { id: '8300000000002', title: 'Codenames', facts: facts({ mode: 'team', styles: ['word', 'party'], weight: 1.3 }) },
  { id: '8300000000003', title: 'Dixit', facts: facts({ styles: ['storytelling'], weight: 1.2 }) },
  { id: '8300000000004', title: 'Azul', facts: facts({ styles: ['pattern-building', 'drafting'], weight: 1.8 }) },
  { id: '8300000000005', title: 'Uno', facts: facts({ styles: ['take-that'], weight: 1.1 }) },
];
const node = (g) => ({
  id: `gid://shopify/Product/${g.id}`, handle: g.title.toLowerCase(), title: `${g.title} (Library)`, status: 'ACTIVE', tags: ['Board Game Rental'], vendor: 'Test',
  createdAt: new Date(NOW - 400 * DAY).toISOString(), updatedAt: new Date(NOW - DAY).toISOString(), descriptionHtml: '',
  featuredMedia: { preview: { image: { url: `https://cdn.shopify.com/s/files/1/${g.id}.png` } } },
  variants: { nodes: [{ id: `gid://shopify/ProductVariant/${Number(g.id) + 1000}`, inventoryQuantity: 2, inventoryItem: { tracked: true } }] },
  libraryCode: { value: `DGL34-M0${g.id.slice(-2)}` }, players: { value: '2–5' }, playTime: { value: '45 min' }, difficulty: { value: 'Medium' },
  missingPieces: null, missingNote: null, blurb: null, shopCopy: null,
});

let lair;
let client = 0;
async function call(method, path, body, customer = '') {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, 'X-Lair-Client': `198.51.100.${client}` },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  }));
  return { status: response.status, data: await response.json() };
}

beforeEach(() => {
  Date.now = () => NOW;
  globalThis.fetch = async (url) => {
    throw new Error(`No network in tests: ${url}`);
  };
  client += 1;
  PICK_DATA.seed = Object.fromEntries(LIBRARY.map((g) => [g.id, g.facts]));
  PICK_DATA.seedVersion = 'real-staff-1';
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  lair.person = async (id) => ({ customerId: id || null, staff: false, gm: false, tags: [], role: null, perms: [], ...(PERSON[id] || {}) });
  lair.rulesCache = rulesFromSettings({}, [], []);
  lair.rulesLoadedAt = NOW + 365 * DAY;
  lair.saveCatalog(LIBRARY.map(node), null, { full: true, now: NOW });
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  PICK_DATA.seed = PICK_SEED;
  PICK_DATA.seedVersion = PICK_SEED_VERSION;
});

test('staff check list: who checked a game is their first name, from their member record (the Lair keeps their customer ID); unknown, it\'s null', async () => {
  await call('POST', 'me/profile', { name: 'Mo Al-Gailani' }, MO);
  await call('POST', 'me/profile', { name: 'Caleb Brown' }, CALEB);
  const [catan, codenames, dixit] = LIBRARY;
  // Looks right, Save and the staff pick switch all answer with the game as the check page shows it
  const looks = await call('POST', `pick/games/${catan.id}`, { checked: true }, MO);
  assert.deepEqual([looks.status, looks.data.game.checked, looks.data.game.checkedBy, looks.data.game.checkedAt], [200, true, 'Mo', NOW]);
  const saved = await call('POST', `pick/games/${codenames.id}`, { facts: { ...codenames.facts, weight: 1.4 } }, CALEB);
  assert.deepEqual([saved.status, saved.data.game.source, saved.data.game.checkedBy], [200, 'staff', 'Caleb']);
  const nameless = await call('POST', `pick/games/${dixit.id}`, { checked: true }, ANA);
  assert.deepEqual([nameless.status, nameless.data.game.checked, nameless.data.game.checkedBy], [200, true, null], 'no member record: no name (never the ID)');
  // the list says the same, every game read from one lookup a person
  const list = (await call('GET', 'pick/games?filter=all', null, CALEB)).data.games;
  assert.deepEqual(list.map((g) => [g.title, g.checkedBy]), [['Azul', null], ['Catan', 'Mo'], ['Codenames', 'Caleb'], ['Dixit', null], ['Uno', null]]);
  // the Lair still keeps who by customer ID
  assert.deepEqual(lair.sql.exec('SELECT product_id, checked_by FROM pick_facts WHERE checked = 1 ORDER BY product_id').toArray().map((r) => [r.product_id, r.checked_by]),
    [[catan.id, MO], [codenames.id, CALEB], [dixit.id, ANA]]);
  // a first name changed on their record shows from then on (read fresh, not kept with the facts)
  await call('POST', 'me/profile', { name: 'Mohamad Al-Gailani', firstName: 'Mo' }, MO);
  await call('POST', 'me/profile', { firstName: 'Cal' }, CALEB);
  const again = (await call('GET', 'pick/games?filter=all', null, MO)).data.games;
  assert.deepEqual(again.filter((g) => g.checked).map((g) => g.checkedBy), ['Mo', 'Cal', null]);
  // taking the check off clears who
  const off = await call('POST', `pick/games/${catan.id}`, { checked: false }, MO);
  assert.deepEqual([off.data.game.checked, off.data.game.checkedBy, off.data.game.checkedAt], [false, null, null]);
});

test('the report: "most acted on" rows have picked\'s shape (shown, and acted: the sessions that acted) and the actions they\'re ranked by', async () => {
  const quiz = async (n) => {
    client += 1;
    return (await call('POST', 'pick', { mode: 'play', players: 4, time: 'medium', context: { door: 'kiosk' } })).data;
  };
  const a = await quiz(1);
  const b = await quiz(2);
  const [first, second] = a.picks;
  assert.ok(first && second && b.picks.some((p) => p.productId === second.productId), 'both sessions show the second pick');
  // one session does three things with the first pick; two sessions reserve the second; looking and asking again don't count
  for (const action of ['more', 'shelf', 'video']) await call('POST', `pick/${a.session.id}/event`, { action, productId: first.productId });
  await call('POST', `pick/${a.session.id}/event`, { action: 'reserve', productId: second.productId });
  await call('POST', `pick/${b.session.id}/event`, { action: 'reserve', productId: second.productId });
  await call('POST', `pick/${b.session.id}/event`, { action: 'view', productId: second.productId });
  await call('POST', `pick/${b.session.id}/event`, { action: 'again' });
  const r = (await call('GET', 'pick/report?days=7', null, MO)).data;
  const shownIn = (pid) => [a, b].filter((s) => [...s.picks, s.wildcard].filter(Boolean).some((p) => p.productId === pid)).length;
  assert.deepEqual(r.acted, [
    { productId: first.productId, title: first.title, shown: shownIn(first.productId), acted: 1, actions: 3 },
    { productId: second.productId, title: second.title, shown: 2, acted: 2, actions: 2 },
  ]);
  // the same game's numbers agree across the two lists
  const picked = r.picked.find((p) => p.productId === second.productId);
  assert.deepEqual([picked.shown, picked.acted], [2, 2]);
  assert.deepEqual(Object.keys(r.picked[0]), ['productId', 'title', 'shown', 'acted']);
  assert.deepEqual(Object.keys(r.acted[0]), ['productId', 'title', 'shown', 'acted', 'actions']);
});

// Round 16: the wishlist (contract v16-wishlist). Mo (16 Oct 2026): "Add to wishlist should be done later for now just
// build the infrastructure." So: the table and three routes for a logged-in member (GET /me/wishlist, POST /me/wishlist,
// POST /me/wishlist/remove), no emails, and nothing in the theme shows it yet. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair, MIGRATIONS } from '../src/lair.js';
import { WISHLIST_MAX, WISHLIST_MESSAGES, wishlistProductId } from '../src/wishlist.js';
import worker from '../src/index.js';

const HOUR = 3_600_000;
// Friday 16 October 2026, 1:00pm in Auckland (NZDT, UTC+13): round 16
const NOW = Date.UTC(2026, 9, 16, 0, 0);
const realNow = Date.now;

/* ---------------- helpers (as test/round15-tab.test.js; the database is kept for its query plans) ---------------- */
function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      // as SQLite in a Durable Object: at most 100 bound values a query (27 Oct 2026) and 5 terms in a compound SELECT
      // (29 Oct 2026), Cloudflare's limits (test/cloudflare-sql.js)
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
  return { db, storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: () => {} };
}

// Members by their Shopify customer IDs (made up), and the main staff account
const SAM = '1001';
const KIRI = '1002';
const STAFF = 'staff';
// Products by their Shopify numbers (made up)
const CATAN = '8100000000001';
const WINGSPAN = '8100000000002';
const AZUL = '8100000000003';

let lair;
async function call(method, path, body, customer = '', extraHeaders = {}) {
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders },
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, data: await response.json() };
}
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const list = (who = SAM) => call('GET', 'me/wishlist', null, who);
const add = (body, who = SAM) => call('POST', 'me/wishlist', body, who);
const remove = (body, who = SAM) => call('POST', 'me/wishlist/remove', body, who);
const rows = () => lair.sql.exec('SELECT customer_id, product_id, handle, title, created_at FROM wishlist ORDER BY rowid').toArray().map((r) => ({ ...r }));
const item = (productId, handle, title, addedAt) => ({ productId, handle, title, addedAt });

// No network in these tests: no Shopify and no emails. Anything that reaches for it is noted, and the test fails.
const realFetch = globalThis.fetch;
let reached = [];

beforeEach(() => {
  reached = [];
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === STAFF, gm: false, tags: [] });
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

/* ---------------- the words and the table ---------------- */

test('wishlist (round 16): the words, word for word, and 100 at most', () => {
  assert.equal(WISHLIST_MAX, 100);
  assert.deepEqual(WISHLIST_MESSAGES, {
    login: 'Log in to keep a wishlist.',
    product: "That doesn't look like one of our products. Refresh the page and try again.",
    handle: "That product's link doesn't look right. Refresh the page and try again.",
    title: "That product's title doesn't look right. Keep it to 255 characters.",
    full: 'Your wishlist is full (100 games). Take one off to add another.',
  });
});

test('wishlist: its table and index are made on every start when missing (a new store, or one from before round 16), and a restart keeps the rows', async () => {
  const ctx = fakeCtx();
  const first = new Lair(ctx, { CURRENCY: 'NZD' });
  const columns = ctx.db.prepare("SELECT name, type, \"notnull\", pk FROM pragma_table_info('wishlist') ORDER BY cid").all().map((c) => [c.name, c.type, c.notnull, c.pk]);
  assert.deepEqual(columns, [
    ['customer_id', 'TEXT', 1, 1], ['product_id', 'TEXT', 1, 2], ['handle', 'TEXT', 0, 0], ['title', 'TEXT', 0, 0], ['created_at', 'INTEGER', 1, 0],
  ], 'one row per member per product: the primary key is (customer_id, product_id)');
  const index = ctx.db.prepare("SELECT name FROM pragma_index_info('wishlist_customer') ORDER BY seqno").all().map((c) => c.name);
  assert.deepEqual(index, ['customer_id', 'created_at']);
  // made on every start (as round 15's columns), not by a step in MIGRATIONS, so it never waits on one
  assert.equal(MIGRATIONS.flat().filter((s) => /wishlist/.test(s)).length, 0);
  // a member's list is read on the index, newest first, with no sort of its own
  const plan = ctx.db.prepare('EXPLAIN QUERY PLAN SELECT product_id, handle, title, created_at FROM wishlist WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC').all(SAM).map((r) => r.detail).join(' | ');
  assert.match(plan, /USING INDEX wishlist_customer/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);

  // A store from before round 16 (every migration run, no wishlist table) gets it on its next start
  ctx.db.exec('DROP TABLE wishlist');
  lair = new Lair(ctx, { CURRENCY: 'NZD' });
  lair.person = async (id) => ({ customerId: id || null, staff: false, gm: false, tags: [] });
  assert.equal(first.sql.exec("SELECT value FROM meta WHERE key = 'schema'").one().value, String(MIGRATIONS.length));
  assert.equal((await add({ productId: CATAN, handle: 'catan', title: 'Catan' })).status, 200);
  // and the next start (a deploy) keeps what's there
  Date.now = () => NOW + HOUR;
  lair = new Lair(ctx, { CURRENCY: 'NZD' });
  lair.person = async (id) => ({ customerId: id || null, staff: false, gm: false, tags: [] });
  assert.deepEqual((await list()).data, { items: [item(CATAN, 'catan', 'Catan', NOW)] });
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE tbl_name = 'wishlist' AND name = 'wishlist_customer'").get().n, 1);
});

/* ---------------- adding, listing and taking off ---------------- */

test('wishlist: a member adds products and sees them newest first; adding one again keeps when it was added and takes a new title or handle', async () => {
  assert.deepEqual((await list()).data, { items: [] }, 'empty to start with');
  const catan = await add({ productId: Number(CATAN), handle: 'catan', title: 'Catan' });
  assert.equal(catan.status, 200, said(catan));
  assert.deepEqual(catan.data, { ok: true, added: true, items: [item(CATAN, 'catan', 'Catan', NOW)] });

  Date.now = () => NOW + HOUR;
  const wingspan = await add({ productId: WINGSPAN, handle: 'wingspan', title: 'Wingspan' });
  assert.deepEqual(wingspan.data, { ok: true, added: true, items: [item(WINGSPAN, 'wingspan', 'Wingspan', NOW + HOUR), item(CATAN, 'catan', 'Catan', NOW)] });

  // Catan again, two hours on (its gid this time) with a new title: added false, still added at NOW, still last
  Date.now = () => NOW + 2 * HOUR;
  const again = await add({ productId: `gid://shopify/Product/${CATAN}`, title: 'Catan (5th edition)' });
  assert.equal(again.status, 200, said(again));
  assert.deepEqual(again.data, {
    ok: true, added: false, items: [item(WINGSPAN, 'wingspan', 'Wingspan', NOW + HOUR), item(CATAN, 'catan', 'Catan (5th edition)', NOW)],
  }, 'the handle it had stays when only the title is sent');
  // a new handle alone; then an empty handle and title, or none at all, change nothing
  assert.deepEqual((await add({ productId: CATAN, handle: 'catan-5th-edition' })).data.items[1], item(CATAN, 'catan-5th-edition', 'Catan (5th edition)', NOW));
  for (const body of [{ productId: CATAN, handle: '', title: '   ' }, { productId: CATAN, handle: null, title: null }, { productId: CATAN }]) {
    const res = await add(body);
    assert.deepEqual([res.status, res.data.added, res.data.items[1]], [200, false, item(CATAN, 'catan-5th-edition', 'Catan (5th edition)', NOW)], JSON.stringify(body));
  }

  // Two added in the same millisecond: the later one first. A product with no handle or title reads ''.
  await add({ productId: AZUL });
  await add({ productId: '8100000000004', title: 'Ticket to Ride' });
  const now = await list();
  assert.equal(now.status, 200);
  assert.deepEqual(now.data, {
    items: [
      item('8100000000004', '', 'Ticket to Ride', NOW + 2 * HOUR), item(AZUL, '', '', NOW + 2 * HOUR),
      item(WINGSPAN, 'wingspan', 'Wingspan', NOW + HOUR), item(CATAN, 'catan-5th-edition', 'Catan (5th edition)', NOW),
    ],
  });
  // one row per product, nothing more
  assert.deepEqual(rows().map((r) => [r.customer_id, r.product_id, r.created_at]), [
    [SAM, CATAN, NOW], [SAM, WINGSPAN, NOW + HOUR], [SAM, AZUL, NOW + 2 * HOUR], [SAM, '8100000000004', NOW + 2 * HOUR],
  ]);
  assert.deepEqual(rows().find((r) => r.product_id === AZUL), { customer_id: SAM, product_id: AZUL, handle: null, title: null, created_at: NOW + 2 * HOUR });
});

test("wishlist: taking one off; one that isn't on it is fine (removed: false), and adding it back later is a new add", async () => {
  await add({ productId: CATAN, handle: 'catan', title: 'Catan' });
  Date.now = () => NOW + HOUR;
  await add({ productId: WINGSPAN, handle: 'wingspan', title: 'Wingspan' });
  const off = await remove({ productId: CATAN });
  assert.equal(off.status, 200, said(off));
  assert.deepEqual(off.data, { ok: true, removed: true, items: [item(WINGSPAN, 'wingspan', 'Wingspan', NOW + HOUR)] });
  // again, and one never added: not an error
  for (const productId of [CATAN, AZUL]) {
    const res = await remove({ productId });
    assert.equal(res.status, 200, said(res));
    assert.deepEqual(res.data, { ok: true, removed: false, items: [item(WINGSPAN, 'wingspan', 'Wingspan', NOW + HOUR)] });
  }
  // by its gid or its number, the same product
  assert.equal((await remove({ productId: `gid://shopify/Product/${WINGSPAN}` })).data.removed, true);
  await add({ productId: WINGSPAN });
  assert.equal((await remove({ productId: Number(WINGSPAN) })).data.removed, true);
  assert.deepEqual((await list()).data, { items: [] });
  assert.deepEqual(rows(), []);
  // Catan back, later: added when it came back
  Date.now = () => NOW + 3 * HOUR;
  assert.deepEqual((await add({ productId: CATAN, title: 'Catan' })).data, { ok: true, added: true, items: [item(CATAN, '', 'Catan', NOW + 3 * HOUR)] });
});

test('wishlist: the gid form, a number and a string of digits are one product, kept as its digits', async () => {
  assert.equal(wishlistProductId(`gid://shopify/Product/${AZUL}`), AZUL);
  assert.equal(wishlistProductId(Number(AZUL)), AZUL);
  assert.equal(wishlistProductId(` ${AZUL} `), AZUL);
  assert.equal(wishlistProductId('12345678901234567890'), '12345678901234567890', '20 digits as a string');
  assert.equal(wishlistProductId(0), '0');
  for (const value of ['gid://shopify/ProductVariant/1', '123456789012345678901', 12345678901234567890, 1.5, -1, '', null, undefined, true, {}, []]) {
    assert.equal(wishlistProductId(value), null, JSON.stringify(value) ?? String(value));
  }

  const res = await add({ productId: `gid://shopify/Product/${AZUL}`, handle: 'azul', title: 'Azul' });
  assert.deepEqual(res.data.items, [item(AZUL, 'azul', 'Azul', NOW)]);
  assert.deepEqual(rows().map((r) => r.product_id), [AZUL], 'kept as its digits');
  for (const productId of [Number(AZUL), AZUL, ` ${AZUL} `, `gid://shopify/Product/${AZUL}`]) {
    const again = await add({ productId });
    assert.deepEqual([again.status, again.data.added, again.data.items.length], [200, false, 1], JSON.stringify(productId));
  }
  // 20 digits are fine as a string; as a JSON number they can't be exact, so they're refused rather than misread
  assert.equal((await add({ productId: '12345678901234567890' })).data.added, true);
  assert.equal(said(await add({ productId: 12345678901234567890 })), `422 ${WISHLIST_MESSAGES.product}`);
  assert.deepEqual(rows().map((r) => r.product_id), [AZUL, '12345678901234567890']);
});

test('wishlist: every check is a 422 with its words, adding or taking off, and nothing is written', async () => {
  await add({ productId: CATAN, handle: 'catan', title: 'Catan' });
  const before = rows();
  const product = `422 ${WISHLIST_MESSAGES.product}`;
  const badIds = [
    undefined, null, '', '   ', 'abc', '12a', '1.5', '-1', '+1', '1 2', '0x1A', '１２３', '123456789012345678901', 12.5, -1, 2 ** 53, true, {}, [], [CATAN],
    `gid://shopify/ProductVariant/${CATAN}`, 'gid://shopify/Product/', 'gid://shopify/Product/12a', `gid://shopify/product/${CATAN}`, `https://www.dicegoblin.nz/products/catan`,
  ];
  for (const productId of badIds) {
    assert.equal(said(await add({ productId, handle: 'catan', title: 'Catan' })), product, `add ${JSON.stringify(productId)}`);
    assert.equal(said(await remove({ productId })), product, `remove ${JSON.stringify(productId)}`);
  }
  // no body at all, or one that isn't an object
  assert.equal(said(await add(undefined)), product);
  assert.equal(said(await add([CATAN])), product);
  assert.equal(said(await remove('8100000000001')), product);

  const handle = `422 ${WISHLIST_MESSAGES.handle}`;
  for (const bad of ['Catan', 'catan base', 'catan_base', 'catán', 'catan/base', 'catan.base', 'x'.repeat(256), 123, true, {}, ['catan']]) {
    assert.equal(said(await add({ productId: WINGSPAN, handle: bad })), handle, JSON.stringify(bad));
    assert.equal(said(await add({ productId: CATAN, handle: bad })), handle, `already on it: ${JSON.stringify(bad)}`);
  }
  const title = `422 ${WISHLIST_MESSAGES.title}`;
  for (const bad of ['x'.repeat(256), '🎲'.repeat(256), 42, true, {}, ['Catan']]) {
    assert.equal(said(await add({ productId: WINGSPAN, title: bad })), title, JSON.stringify(bad).slice(0, 40));
    assert.equal(said(await add({ productId: CATAN, title: bad })), title, `already on it: ${JSON.stringify(bad).slice(0, 40)}`);
  }
  assert.deepEqual(rows(), before, 'nothing was written');

  // What does pass: a 255-character handle (trimmed), 255 characters of title however many UTF-16 units they take, and a
  // title whose spaces, tabs and new lines collapse to one space each, counted after that
  const long = await add({ productId: WINGSPAN, handle: ` ${'w'.repeat(255)} `, title: '🎲'.repeat(255) });
  assert.equal(long.status, 200, said(long));
  assert.deepEqual([long.data.items[0].handle.length, [...long.data.items[0].title].length], [255, 255]);
  const spaced = await add({ productId: AZUL, title: `  Azul:\n\t Summer   Pavilion ${' '.repeat(300)}(2nd printing)  ` });
  assert.equal(spaced.data.items[0].title, 'Azul: Summer Pavilion (2nd printing)');
  assert.equal((await add({ productId: '8100000000004', title: 'x'.repeat(255) })).status, 200);
});

test('wishlist: 100 at most; the 101st is refused, adding one already on it still works, and taking one off makes room', async () => {
  const id = (n) => String(8100000000000 + n);
  for (let n = 1; n <= WISHLIST_MAX; n += 1) {
    Date.now = () => NOW + n;
    const res = await add({ productId: id(n), handle: `game-${n}`, title: `Game ${n}` });
    assert.equal(res.data.added, true, said(res));
  }
  assert.equal((await list()).data.items.length, 100);
  const full = await add({ productId: id(101), handle: 'game-101', title: 'Game 101' });
  assert.equal(said(full), '409 Your wishlist is full (100 games). Take one off to add another.');
  assert.equal(rows().length, 100);
  // one already on it is never refused for being full, and it keeps its place
  const again = await add({ productId: `gid://shopify/Product/${id(50)}`, title: 'Game 50 (deluxe)' });
  assert.equal(again.status, 200, said(again));
  assert.equal(again.data.added, false);
  assert.equal(again.data.items.length, 100);
  assert.deepEqual(again.data.items[50], item(id(50), 'game-50', 'Game 50 (deluxe)', NOW + 50), 'newest first: game 100 is first, game 50 the 51st');
  // the limit is each member's own
  assert.equal((await add({ productId: id(101) }, KIRI)).data.added, true);
  // one off, and the 101st goes on
  assert.equal((await remove({ productId: id(1) })).data.removed, true);
  Date.now = () => NOW + HOUR;
  const room = await add({ productId: id(101), handle: 'game-101', title: 'Game 101' });
  assert.deepEqual([room.status, room.data.added, room.data.items.length, room.data.items[0]], [200, true, 100, item(id(101), 'game-101', 'Game 101', NOW + HOUR)]);
  assert.equal(said(await add({ productId: id(102) })), `409 ${WISHLIST_MESSAGES.full}`);
});

/* ---------------- who ---------------- */

test('wishlist: a guest gets what every /me route gives a guest (401, "Log in to …"), whatever they send, and nothing is written', async () => {
  // the other /me routes, for comparison: a 401 with a "Log in to …" sentence
  for (const res of [await call('GET', 'me'), await call('POST', 'me/profile', { firstName: 'Sam' }), await call('POST', 'me/codes/redeem', { code: 'ROLL-FOR-LOOT' })]) {
    assert.equal(res.status, 401);
    assert.match(res.data.error, /^Log in to /);
    assert.deepEqual(Object.keys(res.data), ['error']);
  }
  const login = `401 ${WISHLIST_MESSAGES.login}`;
  assert.equal(said(await list('')), login);
  assert.equal(said(await add({ productId: CATAN, handle: 'catan', title: 'Catan' }, '')), login);
  assert.equal(said(await add({ productId: 'not a product' }, '')), login, 'logging in comes first');
  assert.equal(said(await remove({ productId: CATAN }, '')), login);
  assert.deepEqual((await list('')).data, { error: WISHLIST_MESSAGES.login });
  assert.deepEqual(rows(), []);
  // and paths past the three routes aren't routes
  assert.equal((await call('GET', 'me/wishlist/catan', null, SAM)).status, 404);
  assert.equal((await call('POST', 'me/wishlist/catan', { productId: CATAN }, SAM)).status, 404);
  assert.equal((await call('POST', 'me/wishlist/remove/catan', { productId: CATAN }, SAM)).status, 404);
  assert.deepEqual(rows(), []);
});

test("wishlist: a member never sees or takes off another's, and staff have no special view", async () => {
  await add({ productId: CATAN, handle: 'catan', title: 'Catan' });
  await add({ productId: WINGSPAN, handle: 'wingspan', title: 'Wingspan' });
  const sams = (await list()).data;
  assert.equal(sams.items.length, 2);

  // Kiri sees only her own (none), and taking off Sam's Catan takes nothing off his
  assert.deepEqual((await list(KIRI)).data, { items: [] });
  assert.deepEqual((await remove({ productId: CATAN }, KIRI)).data, { ok: true, removed: false, items: [] });
  // her own Catan is her own row: Sam's keeps its title and when it was added
  Date.now = () => NOW + HOUR;
  assert.deepEqual((await add({ productId: CATAN, handle: 'catan', title: 'Catan, for Kiri' }, KIRI)).data, { ok: true, added: true, items: [item(CATAN, 'catan', 'Catan, for Kiri', NOW + HOUR)] });
  assert.deepEqual((await list()).data, sams);
  // Sam takes his off; hers stays
  assert.equal((await remove({ productId: CATAN })).data.removed, true);
  assert.deepEqual((await list(KIRI)).data.items, [item(CATAN, 'catan', 'Catan, for Kiri', NOW + HOUR)]);

  // Staff only ever reach their own list: a customerId, in the address or the body, changes nothing
  assert.deepEqual((await call('GET', `me/wishlist?customerId=${KIRI}`, null, STAFF)).data, { items: [] });
  assert.deepEqual((await remove({ productId: CATAN, customerId: KIRI }, STAFF)).data, { ok: true, removed: false, items: [] });
  const staffAdd = await add({ productId: AZUL, title: 'Azul', customerId: SAM }, STAFF);
  assert.deepEqual(staffAdd.data, { ok: true, added: true, items: [item(AZUL, '', 'Azul', NOW + HOUR)] });
  assert.deepEqual((await list()).data.items.map((x) => x.productId), [WINGSPAN]);
  assert.deepEqual((await list(KIRI)).data.items.map((x) => x.productId), [CATAN]);
  assert.deepEqual(rows().map((r) => [r.customer_id, r.product_id]), [[SAM, WINGSPAN], [KIRI, CATAN], [STAFF, AZUL]]);
});

/* ---------------- through the store ---------------- */

async function signedUrl(path, params, secret = 'hush') {
  const { createHmac } = await import('node:crypto');
  const search = new URLSearchParams(params);
  const grouped = {};
  for (const [k, v] of search) (grouped[k] ||= []).push(v);
  const message = Object.entries(grouped).map(([k, v]) => `${k}=${v.join(',')}`).sort().join('');
  search.set('signature', createHmac('sha256', secret).update(message).digest('hex'));
  return `https://worker.test${path}?${search}`;
}

test("wishlist: through the store's app proxy (www.dicegoblin.nz/apps/liar/me/wishlist), as the logged-in customer Shopify names, and as a guest", async () => {
  const env = { SHOP: 'example-shop.myshopify.com', SHOPIFY_CLIENT_SECRET: 'hush', LAIR: { idFromName: () => 'id', get: () => lair } };
  const base = { shop: env.SHOP, path_prefix: '/apps/liar', timestamp: String(Math.floor(NOW / 1000)) };
  const proxy = async (method, path, customer, body) => {
    const res = await worker.fetch(new Request(await signedUrl(`/proxy/${path}`, { ...base, logged_in_customer_id: customer }), {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    }), env);
    return { status: res.status, data: await res.json() };
  };
  const added = await proxy('POST', 'me/wishlist', SAM, { productId: `gid://shopify/Product/${CATAN}`, handle: 'catan', title: 'Catan' });
  assert.deepEqual([added.status, added.data], [200, { ok: true, added: true, items: [item(CATAN, 'catan', 'Catan', NOW)] }]);
  assert.deepEqual(await proxy('GET', 'me/wishlist', SAM), { status: 200, data: { items: [item(CATAN, 'catan', 'Catan', NOW)] } });
  assert.deepEqual(await proxy('GET', 'me/wishlist', KIRI), { status: 200, data: { items: [] } });
  // a guest (no logged-in customer) gets the 401
  assert.deepEqual(await proxy('GET', 'me/wishlist', ''), { status: 401, data: { error: WISHLIST_MESSAGES.login } });
  assert.deepEqual(await proxy('POST', 'me/wishlist/remove', '', { productId: CATAN }), { status: 401, data: { error: WISHLIST_MESSAGES.login } });
  assert.deepEqual(await proxy('POST', 'me/wishlist/remove', SAM, { productId: CATAN }), { status: 200, data: { ok: true, removed: true, items: [] } });
});

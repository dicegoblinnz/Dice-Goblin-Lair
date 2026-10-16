// Round 17, borrowing (contract v17-help-me-pick, section 5): the borrow queue, postal swaps paid through a Shopify
// checkout, "Tell me when it's back", and a library game on a table booking held from 3 days before. The games come from
// the other half of round 17 (pickGame): here a fixture stands in for it. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair, MIGRATIONS } from '../src/lair.js';
import { LairTime, addDays, rulesFromSettings } from '../src/core.js';
import { QUEUE_MAX, QUEUE_MESSAGES, WATCH_MAX, POSTAGE_DEFAULT, bookingHoldFrom, libraryPostage, postalCutoff } from '../src/queue.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Friday 16 October 2026, 1:00pm in Auckland (NZDT): round 17
const NOW = at('2026-10-16', 13);
const realNow = Date.now;
let clock = NOW;
const setNow = (ms) => {
  clock = ms;
};

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
  return { db, storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: () => {} };
}

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];
const HOURS = 'Mon 10:00-23:00\nTue 10:00-23:00\nWed 10:00-23:00\nThu 10:00-23:00\nFri 10:00-23:00\nSat 10:00-23:00\nSun 10:00-23:00';
// Members: Sam (Stash, 3 games), Kiri (Grab, 1), Leo (Hoard, 5), Ari (no plan); staff, and helpers with one permission
const SAM = '1001';
const KIRI = '1002';
const LEO = '1003';
const ARI = '1004';
const TAGS = { staff: ['staff'] };
const HELPERS = { 'helper-desk': ['checkin'], 'helper-library': ['library'], 'helper-tables': ['tables'] };
const NAMES = { [SAM]: 'Sam Jones', [KIRI]: 'Kiri Smith', [LEO]: 'Leo Tane', [ARI]: 'Ari Moana' };

// The library (pickGame stands in for the other half of round 17): Catan has 2 copies, the rest 1
const game = (productId, variantId, title, over = {}) => ({
  productId, variantId, title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), image: `https://cdn.shopify.com/${variantId}.jpg`,
  shelfCode: `DGL34-M${String(variantId).slice(-3)}`, copies: 1, inStoreOnly: false, kind: 'game', table: 'single', status: 'active', ...over,
});
const CATAN = '7001';
const AZUL = '7002';
const ROOT = '7003';
const WINGSPAN = '7004';
const GLOOM = '7005';
const CASCADIA = '7006';
const RPG = '7007';
const ATTIC = '7008';
let FIXTURES;
const freshFixtures = () => ({
  [CATAN]: game(CATAN, '4001', 'Catan', { copies: 2 }),
  [AZUL]: game(AZUL, '4002', 'Azul'),
  [ROOT]: game(ROOT, '4003', 'Root'),
  [WINGSPAN]: game(WINGSPAN, '4004', 'Wingspan'),
  [GLOOM]: game(GLOOM, '4005', 'Gloomhaven', { inStoreOnly: true, table: 'double' }),
  [CASCADIA]: game(CASCADIA, '4006', 'Cascadia', { copies: null }),
  [RPG]: game(RPG, '4007', 'Dungeons starter set', { kind: 'rpg' }),
  [ATTIC]: game(ATTIC, '4008', 'Old game', { status: 'gone' }),
});

let lair;
let shop;
const MOBILE_ROUTES = /^(?:bookings)$/;
async function call(method, path, body, customer = '', extraHeaders = {}) {
  const sent = method === 'POST' && body && MOBILE_ROUTES.test(path) && !('phone' in body) ? { ...body, phone: '021 555 0100' } : body;
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders }, body: sent === undefined || sent === null ? undefined : JSON.stringify(sent),
  }));
  return { status: response.status, data: await response.json() };
}
const internal = (path, body) => call('POST', `internal/${path}`, body, '', { 'X-Lair-Internal': '1' });
const maintenance = async () => (await internal('maintenance', {})).data;
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const queue = (who = SAM) => call('GET', 'me/queue', null, who);
const add = (productId, who = SAM) => call('POST', 'me/queue', { productId }, who);
const removeQ = (productId, who = SAM) => call('POST', 'me/queue/remove', { productId }, who);
const move = (productId, to, who = SAM) => call('POST', 'me/queue/move', { productId, to }, who);
const settings = (body, who = SAM) => call('POST', 'me/queue/settings', body, who);
const restart = (who = SAM) => call('POST', 'me/queue/restart', {}, who);
const rows = (who = SAM) => lair.sql.exec('SELECT * FROM library_queue WHERE customer_id = ? ORDER BY rowid', who).toArray();
const holdsOf = (who) => lair.sql.exec("SELECT * FROM library_holds WHERE customer_id = ? AND status = 'held' ORDER BY created_at, rowid", who).toArray();
const allHolds = () => lair.sql.exec('SELECT * FROM library_holds ORDER BY created_at, rowid').toArray();
const sends = () => lair.sql.exec('SELECT * FROM library_sends ORDER BY created_at, rowid').toArray();
const settle = () => new Promise((r) => setTimeout(r, 10));
/** A member reserves a game by hand (POST /library/holds), as the library page does */
const reserve = (productId, who = SAM, over = {}) => {
  const g = FIXTURES[productId];
  return call('POST', 'library/holds', { variantId: g.variantId, productId, title: g.title, shelfCode: g.shelfCode, handle: g.handle, ...over }, who);
};

/** Turn on emails and catch everything sent to Resend (single and batch); Shopify fakes keep their own counts */
let mail;
function captureEmails() {
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test' };
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.resend.com/')) throw new Error(`No network in tests: ${url}`);
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return { sent, subjects: (to) => sent.filter((m) => !to || m.to === to).map((m) => m.subject) };
}

/** A fake Shopify: the postal swap's draft orders (each remembered with its input), which order each became, deletes */
function fakeShopify() {
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  const state = { drafts: new Map(), deleted: [], orders: new Map(), failNext: 0, n: 0, made: [] };
  lair.shopify.createLibrarySend = async (input) => {
    if (state.failNext > 0) {
      state.failNext -= 1;
      throw new Error('Shopify API error 502');
    }
    state.n += 1;
    const id = `gid://shopify/DraftOrder/${800 + state.n}`;
    state.drafts.set(id, input);
    state.made.push(input);
    return { draftOrderId: id, checkoutUrl: `https://shop.test/checkouts/${800 + state.n}` };
  };
  lair.shopify.draftOrderOrderId = async (id) => state.orders.get(id) ?? null;
  // a draft Shopify still has (null once it's deleted and never paid)
  lair.shopify.draftOrderState = async (id) => (state.drafts.has(id) && (state.orders.has(id) || !state.deleted.includes(id))
    ? { id, status: state.orders.has(id) ? 'COMPLETED' : 'OPEN', ready: true, order: null } : null);
  lair.shopify.deleteDraftIfOpen = async (id) => {
    state.deleted.push(id);
    return true;
  };
  lair.shopify.customerEmail = async () => null;
  lair.shopify.customersSince = async () => new Map();
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.appInfo = async () => ({ app: 'Dice Goblin Lair', shop: 'Dice Goblin', scopes: [] });
  lair.shopify.webhookUris = async () => ['https://lair.test/webhooks/orders-paid'];
  lair.shopify.variantCopies = async (ids) => new Map(ids.map((id) => [id, null]));
  return state;
}

/** The order Shopify makes when a send's draft order is paid, with the draft's own attributes */
function paidSend(draftId, orderNumber, { link = true } = {}) {
  const input = shop.drafts.get(draftId);
  const orderId = `gid://shopify/Order/${orderNumber}`;
  if (link) shop.orders.set(draftId, orderId);
  return {
    id: orderNumber, admin_graphql_api_id: orderId, name: `#${orderNumber}`, source_name: 'shopify_draft_order', note_attributes: [{ name: '_libsend', value: input.sendId }],
    line_items: [{ id: orderNumber * 100, price: '0.00', quantity: 1, properties: [{ name: '_libsend', value: input.sendId }] }],
  };
}

const realFetch = globalThis.fetch;
beforeEach(async () => {
  clock = NOW;
  Date.now = () => clock;
  globalThis.fetch = async (url) => {
    throw new Error(`No network in tests: ${url}`);
  };
  FIXTURES = freshFixtures();
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  lair.pickGame = (id) => FIXTURES[id] || null;
  lair.person = async (id) => (HELPERS[id]
    ? { customerId: id, staff: true, role: 'helper', perms: HELPERS[id], gm: false, tags: [] }
    : { customerId: id || null, staff: id === 'staff', gm: false, tags: TAGS[id] || [] });
  lair.rulesCache = rulesFromSettings({ lair_hours: HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  shop = fakeShopify();
  mail = captureEmails();
  for (const [id, name] of Object.entries(NAMES)) await call('POST', 'me/profile', { name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, id);
  // their library memberships (round 10), so maintenance knows their plans too: Sam Stash, Kiri Grab, Leo Hoard
  for (const [id, tier] of [[SAM, 'stash'], [KIRI, 'grab'], [LEO, 'hoard']]) joinLibrary(id, tier);
});
/** A library membership for a member (a memberships row, as round 10 keeps them) */
function joinLibrary(id, tier, status = 'active') {
  lair.sql.exec(
    `INSERT OR REPLACE INTO memberships (id, contract_gid, customer_id, status, tier, billing_tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    `9${id}`, `gid://shopify/SubscriptionContract/9${id}`, id, status, tier, tier, NOW - 30 * DAY, NOW,
  );
}
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
});

/* ---------------- the words, the tables, the clock ---------------- */

test('round 17 queue: the words, word for word (the contract\'s table), and the limits', () => {
  assert.deepEqual([QUEUE_MAX, WATCH_MAX], [30, 50]);
  const table = {
    loginQueue: 'Log in to see your queue.',
    member: 'Join the library to start a queue.',
    full: 'Your queue is full (30 games). Take one off to add another.',
    inStoreOnly: "That one's rare, so it stays in the Lair. Book a table and play it here instead.",
    product: "That isn't one of our library games. Refresh the page and try again.",
    game: 'Pick a game from the library to bring to your table.',
    started: "That booking has started, so its game can't change now.",
    lapsed: "The cutoff for this Thursday has passed, so it's back on the shelf. It's still in your queue.",
    shopify: "We couldn't open the checkout just now. Try again in a minute, or call us.",
    watchFull: "You're watching 50 games already. Stop watching one to add another.",
  };
  for (const [key, words] of Object.entries(table)) assert.equal(QUEUE_MESSAGES[key], words, key);
  assert.deepEqual(POSTAGE_DEFAULT, { auckland: 1000, 'auckland-rural': 1500, nationwide: 2000, 'nationwide-rural': 3000 });
  // LIBRARY_POSTAGE (config) changes an area's price; anything that isn't a whole number of cents keeps the website's
  assert.deepEqual(libraryPostage({ LIBRARY_POSTAGE: '{"auckland":1200,"nationwide":"lots","nationwide-rural":-5}' }), { auckland: 1200, 'auckland-rural': 1500, nationwide: 2000, 'nationwide-rural': 3000 });
  assert.deepEqual(libraryPostage({ LIBRARY_POSTAGE: 'not json' }), POSTAGE_DEFAULT);
});

test('round 17 queue: its tables and columns are made on every start when missing (a store from before), and a restart keeps the rows', async () => {
  const ctx = fakeCtx();
  const first = new Lair(ctx, { CURRENCY: 'NZD' });
  const cols = (t) => ctx.db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((c) => c.name);
  assert.ok(['kind', 'booking_id'].every((c) => cols('library_holds').includes(c)));
  assert.ok(['game_product_id', 'game_title', 'game_handle', 'game_image', 'game_state', 'game_hold_id'].every((c) => cols('bookings').includes(c)));
  for (const t of ['library_queue', 'library_queue_settings', 'library_sends', 'library_watch']) assert.ok(cols(t).length, t);
  assert.deepEqual(cols('library_watch').slice(0, 7), ['customer_id', 'product_id', 'variant_id', 'title', 'handle', 'created_at', 'told_at']);
  assert.equal(MIGRATIONS.flat().filter((x) => /library_queue|library_sends|library_watch|game_product_id/.test(x)).length, 0, 'not a step in MIGRATIONS');
  // A store from before round 17: its holds are members' holds (kind 'member'), and it carries on
  first.sql.exec("INSERT INTO library_holds (id, variant_id, title, customer_id, status, until, created_at) VALUES ('lh_old', '4001', 'Catan', '1001', 'held', ?, ?)", NOW + DAY, NOW);
  ctx.db.exec('DROP TABLE library_queue');
  const again = new Lair(ctx, { CURRENCY: 'NZD' });
  assert.equal(again.sql.exec("SELECT kind FROM library_holds WHERE id = 'lh_old'").one().kind, 'member');
  assert.ok(cols('library_queue').includes('passed_at'));
  assert.equal(again.sql.exec("SELECT value FROM meta WHERE key = 'schema'").one().value, String(MIGRATIONS.length));
});

test('round 17 queue: a postal hold lasts until the next Wednesday 10pm at least 24 hours away: a Monday, a Wednesday afternoon, a Wednesday 11pm', () => {
  const cut = (ms) => postalCutoff(time, ms);
  // Monday 19 October 9am: this Wednesday (21 October) 10pm, sent Thursday 22nd
  assert.deepEqual(cut(at('2026-10-19', 9)), { confirmBy: at('2026-10-21', 22), sendDay: '2026-10-22' });
  // Tuesday 20 October 9:59pm: still this week (24 hours and a minute); 10:01pm: next week
  assert.deepEqual(cut(at('2026-10-20', 21, 59)), { confirmBy: at('2026-10-21', 22), sendDay: '2026-10-22' });
  assert.deepEqual(cut(at('2026-10-20', 22, 0)), { confirmBy: at('2026-10-21', 22), sendDay: '2026-10-22' }, 'exactly 24 hours is enough');
  assert.deepEqual(cut(at('2026-10-20', 22, 1)), { confirmBy: at('2026-10-28', 22), sendDay: '2026-10-29' });
  // Wednesday 21 October 3pm (less than a day to the cutoff): next Wednesday; and 11pm (after it): next Wednesday too
  assert.deepEqual(cut(at('2026-10-21', 15)), { confirmBy: at('2026-10-28', 22), sendDay: '2026-10-29' });
  assert.deepEqual(cut(at('2026-10-21', 23)), { confirmBy: at('2026-10-28', 22), sendDay: '2026-10-29' });
  // Thursday to Sunday: the coming Wednesday
  for (const day of ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']) assert.equal(cut(at(day, 12)).confirmBy, at('2026-10-28', 22), day);
});

test('round 17 queue: the cutoff is 10pm Lair time across both daylight saving changes (27 September 2026, 4 April 2027)', () => {
  const iso = (ms) => new Date(ms).toISOString();
  // Spring forward (Sunday 27 September 2026): a Friday 25 September (NZST) hold's cutoff is Wednesday 30 September 10pm NZDT
  const spring = postalCutoff(time, at('2026-09-25', 12));
  assert.equal(iso(spring.confirmBy), '2026-09-30T09:00:00.000Z', '10pm NZDT is 9am UTC');
  assert.equal(spring.sendDay, '2026-10-01');
  // the Wednesday before it was still NZST: 10pm is 10am UTC
  assert.equal(iso(postalCutoff(time, at('2026-09-21', 12)).confirmBy), '2026-09-23T10:00:00.000Z');
  // Fall back (Sunday 4 April 2027): a Friday 2 April (NZDT) hold's cutoff is Wednesday 7 April 10pm NZST
  const autumn = postalCutoff(time, at('2027-04-02', 12));
  assert.equal(iso(autumn.confirmBy), '2027-04-07T10:00:00.000Z', '10pm NZST is 10am UTC');
  assert.equal(time.minutesOf(autumn.confirmBy), 22 * 60);
  // made on the night the clocks go back (2:30am, which happens twice): still Wednesday 10pm
  assert.equal(time.minutesOf(postalCutoff(time, Date.parse('2027-04-03T13:30:00Z')).confirmBy), 22 * 60);
});

test('round 17 queue: a booking\'s game is held from midnight Lair time 3 days before its day: Saturday from Wednesday 00:00, across both daylight saving changes', () => {
  // Saturday 24 October 7pm → Wednesday 21 October 00:00 NZDT
  assert.equal(bookingHoldFrom(time, at('2026-10-24', 19)), at('2026-10-21', 0));
  assert.equal(new Date(bookingHoldFrom(time, at('2026-10-24', 19))).toISOString(), '2026-10-20T11:00:00.000Z');
  // a booking just after midnight counts its own day
  assert.equal(bookingHoldFrom(time, at('2026-10-24', 0, 30)), at('2026-10-21', 0));
  // Wednesday 30 September 2026 (after the clocks went forward on the 27th) → Sunday 27 September 00:00, still NZST
  assert.equal(new Date(bookingHoldFrom(time, at('2026-09-30', 18))).toISOString(), '2026-09-26T12:00:00.000Z');
  // Tuesday 6 April 2027 (after the clocks went back on the 4th) → Saturday 3 April 00:00, still NZDT
  assert.equal(new Date(bookingHoldFrom(time, at('2027-04-06', 18))).toISOString(), '2027-04-02T11:00:00.000Z');
  // Wednesday 7 April 2027 → Sunday 4 April 00:00 NZDT (the change is at 3am that day)
  assert.equal(new Date(bookingHoldFrom(time, at('2027-04-07', 18))).toISOString(), '2027-04-03T11:00:00.000Z');
});

/* ---------------- the queue's routes ---------------- */

test('round 17 queue: adding, moving, removing and settings; a game already queued keeps its place; the answer is GET /me/queue\'s', async () => {
  // Leo (Hoard, 5 games) pauses first, so nothing is held while he lines them up
  assert.equal((await settings({ paused: true }, LEO)).status, 200);
  for (const id of [CATAN, AZUL, `gid://shopify/Product/${ROOT}`]) {
    const res = await add(id, LEO);
    assert.equal(res.status, 200, said(res));
    assert.equal(res.data.added, true);
  }
  const again = await add(Number(CATAN), LEO);
  assert.deepEqual([again.status, again.data.ok, again.data.added, again.data.queue.map((x) => x.productId)], [200, true, false, [CATAN, AZUL, ROOT]], 'it keeps its place');
  const view = (await queue(LEO)).data;
  assert.deepEqual(Object.keys(view), ['queue', 'settings', 'sends', 'watching', 'plan', 'postage']);
  assert.deepEqual(view.queue[0], {
    productId: CATAN, variantId: '4001', title: 'Catan', handle: 'catan', image: 'https://cdn.shopify.com/4001.jpg', shelfCode: 'DGL34-M001', position: 1,
    status: 'queued', holdId: null, hold: null, available: true,
  });
  assert.deepEqual(view.settings, { paused: true, delivery: 'store', area: null, stalled: false, stalledReason: null });
  assert.deepEqual([view.plan, view.postage, view.sends, view.watching], [{ name: 'Hoard', games: 5, holds: 0, atHome: 0 }, POSTAGE_DEFAULT, [], []]);
  // move Root to the top, then Catan past the end (it's last)
  assert.deepEqual((await move(ROOT, 1, LEO)).data.queue.map((x) => [x.productId, x.position]), [[ROOT, 1], [CATAN, 2], [AZUL, 3]]);
  assert.deepEqual((await move(CATAN, 9, LEO)).data.queue.map((x) => [x.productId, x.position]), [[ROOT, 1], [AZUL, 2], [CATAN, 3]]);
  for (const to of [0, -1, 1.5, 'two', null, true]) assert.equal(said(await move(ROOT, to, LEO)), `422 ${QUEUE_MESSAGES.position}`, String(to));
  assert.equal(said(await move(WINGSPAN, 1, LEO)), `422 ${QUEUE_MESSAGES.product}`, 'not in the queue');
  // remove Azul: the rest close up; again is fine (removed: false)
  const off = await removeQ(AZUL, LEO);
  assert.deepEqual([off.data.ok, off.data.removed, off.data.queue.map((x) => [x.productId, x.position])], [true, true, [[ROOT, 1], [CATAN, 2]]]);
  assert.deepEqual([(await removeQ(AZUL, LEO)).data.removed, (await removeQ(WINGSPAN, LEO)).data.removed], [false, false]);
  // added back, it goes on the end
  assert.deepEqual((await add(AZUL, LEO)).data.queue.map((x) => x.productId), [ROOT, CATAN, AZUL]);
  // settings: by post to Auckland rural; any case and spaces for the area; a bad one is a 422 and changes nothing
  const post = await settings({ delivery: 'post', area: 'Auckland Rural' }, LEO);
  assert.deepEqual(post.data.settings, { paused: true, delivery: 'post', area: 'auckland-rural', stalled: false, stalledReason: null });
  assert.equal(said(await settings({ delivery: 'pigeon' }, LEO)), `422 ${QUEUE_MESSAGES.delivery}`);
  assert.equal(said(await settings({ area: 'mars' }, LEO)), `422 ${QUEUE_MESSAGES.area}`);
  assert.deepEqual((await settings({ area: null }, LEO)).data.settings.area, null, 'null clears the area');
  assert.deepEqual(holdsOf(LEO), [], 'paused: nothing held all along');
});

test('round 17 queue: the errors: 401 for a guest, 403 member without a plan, 422 product and inStoreOnly, 409 full at 30', async () => {
  for (const res of [await queue(''), await add(CATAN, ''), await removeQ(CATAN, ''), await move(CATAN, 1, ''), await settings({ paused: true }, ''), await restart(''),
    await call('POST', 'me/queue/sends/ls_x/confirm', { area: 'auckland' }, ''), await call('POST', 'me/queue/sends/ls_x/skip', {}, '')]) {
    assert.deepEqual([res.status, res.data], [401, { error: 'Log in to see your queue.' }]);
  }
  assert.equal(said(await add(CATAN, ARI)), `403 ${QUEUE_MESSAGES.member}`);
  for (const bad of [WINGSPAN + '9', ATTIC, 'catan', '', null, `gid://shopify/ProductVariant/${CATAN}`]) assert.equal(said(await add(bad)), `422 ${QUEUE_MESSAGES.product}`, String(bad));
  assert.equal(said(await add(GLOOM)), `422 ${QUEUE_MESSAGES.inStoreOnly}`);
  // pickGame not there (the other half of round 17 not merged): nothing is a library game
  const saved = lair.pickGame;
  lair.pickGame = undefined;
  assert.equal(said(await add(CATAN)), `422 ${QUEUE_MESSAGES.product}`);
  lair.pickGame = saved;
  // 30 at most (Sam paused, so nothing's held and the queue just fills)
  await settings({ paused: true });
  for (let n = 1; n <= QUEUE_MAX; n += 1) FIXTURES[String(8000 + n)] = game(String(8000 + n), String(5000 + n), `Game ${n}`);
  for (let n = 1; n <= QUEUE_MAX; n += 1) assert.equal((await add(String(8000 + n))).data.added, true);
  assert.equal(said(await add(CATAN)), `409 ${QUEUE_MESSAGES.full}`);
  assert.equal((await add('8005')).data.added, false, 'one already on it is never refused for being full');
  await removeQ('8001');
  assert.equal((await add(CATAN)).data.added, true, 'taking one off makes room');
  assert.equal(rows().filter((r) => ['queued', 'held'].includes(r.status)).length, QUEUE_MAX);
});

/* ---------------- moving the queue on ---------------- */

test('round 17 queue: advancing fills free slots in order, passes over a game with no free copy (it keeps its place), and stops when the plan is full', async () => {
  // Kiri has Azul's only copy on hold; Sam (Stash: 3) queues Azul, Catan, Root, Wingspan
  assert.equal((await reserve(AZUL, KIRI)).status, 200);
  await settings({ paused: true });
  for (const id of [AZUL, CATAN, ROOT, WINGSPAN]) await add(id);
  const go = await settings({ paused: false });
  assert.deepEqual(go.data.queue.map((x) => [x.productId, x.position, x.status]), [[AZUL, 1, 'queued'], [CATAN, 2, 'held'], [ROOT, 3, 'held'], [WINGSPAN, 4, 'held']]);
  assert.deepEqual(holdsOf(SAM).map((h) => [h.title, h.created_by, h.kind]), [['Catan', 'queue', 'member'], ['Root', 'queue', 'member'], ['Wingspan', 'queue', 'member']]);
  const catan = go.data.queue[1];
  assert.deepEqual(catan.hold, { until: at('2026-10-19', 0) }, 'in the Lair: held until midnight on the third day');
  assert.equal(catan.holdId, holdsOf(SAM)[0].id);
  assert.deepEqual(go.data.plan, { name: 'Stash', games: 3, holds: 3, atHome: 0 });
  assert.equal(go.data.queue[0].available, false, "Azul's only copy is Kiri's");
  // the plan is full: maintenance holds nothing more
  assert.equal((await maintenance()).queues, undefined);
  // Kiri cancels Azul: its copy is free, and Sam's plan is still full: nothing more held
  const kiriHold = holdsOf(KIRI)[0];
  await call('POST', `library/holds/${kiriHold.id}/cancel`, {}, KIRI);
  assert.deepEqual(holdsOf(SAM).length, 3);
  // Sam collects Catan (it's at home): a plan counts games at home too, so still nothing more
  await call('POST', `library/holds/${holdsOf(SAM)[0].id}/update`, { status: 'collected' }, 'staff');
  assert.equal(holdsOf(SAM).length, 2);
  assert.deepEqual(rows().map((r) => [r.product_id, r.status]), [[AZUL, 'queued'], [CATAN, 'done'], [ROOT, 'held'], [WINGSPAN, 'held']]);
  // Catan comes back to the shelf at the counter: the plan has room, and Azul (first in line, free now) is held
  const loan = lair.sql.exec("SELECT id FROM library_loans WHERE customer_id = ? AND status = 'out'", SAM).one();
  await call('POST', `library/loans/${loan.id}/return`, {}, 'staff');
  assert.deepEqual(rows().map((r) => [r.product_id, r.status]), [[AZUL, 'held'], [CATAN, 'done'], [ROOT, 'held'], [WINGSPAN, 'held']]);
  assert.deepEqual((await queue()).data.queue.map((x) => [x.productId, x.position]), [[AZUL, 1], [ROOT, 3], [WINGSPAN, 4]], 'done games leave the list; positions stay');
});

test('round 17 queue: a game staff lent outside a plan (16 Oct 2026 lending) never takes a queue slot, and the queue never holds a game they have at home', async () => {
  // Sam took a copy of Catan home as a lent game before he joined (no plan then, so nothing to pay); now he's on Stash (3)
  const g = FIXTURES[CATAN];
  lair.sql.exec(
    `INSERT INTO library_loans (id, variant_id, product_id, title, shelf_code, handle, image, customer_id, hold_id, status, out_at, returned_at, out_by,
       returned_by, staff_note, created_at, updated_at, lent) VALUES ('ln-lent', ?, ?, ?, ?, ?, NULL, ?, NULL, 'out', ?, NULL, 'staff', NULL, NULL, ?, ?, 1)`,
    g.variantId, CATAN, g.title, g.shelfCode, g.handle, SAM, NOW - DAY, NOW - DAY, NOW - DAY,
  );
  await settings({ paused: true });
  for (const id of [CATAN, AZUL, ROOT, WINGSPAN]) assert.equal((await add(id)).status, 200);
  const go = await settings({ paused: false });
  assert.deepEqual(go.data.queue.map((x) => [x.productId, x.status]), [[CATAN, 'queued'], [AZUL, 'held'], [ROOT, 'held'], [WINGSPAN, 'held']],
    "three held: the lent game uses no slot, and Catan (one's at home with him) is passed over though its other copy is free");
  assert.deepEqual(go.data.plan, { name: 'Stash', games: 3, holds: 3, atHome: 0 }, 'atHome counts what uses up the plan');
});

test('round 17 queue: never the last copy twice, never a slot twice: two advances in a row, two members at once, and a reserve then an advance', async () => {
  // Kiri (Grab: 1) and Leo (Hoard) both queue Azul (1 copy) while paused
  await settings({ paused: true }, KIRI);
  await settings({ paused: true }, LEO);
  await add(AZUL, KIRI);
  await add(AZUL, LEO);
  await add(ROOT, KIRI);
  // two advances in a row for Kiri: one hold (her plan has 1 slot), Azul
  await settings({ paused: false }, KIRI);
  lair.queueAdvance(KIRI);
  lair.queueAdvance(KIRI);
  assert.deepEqual(holdsOf(KIRI).map((h) => h.title), ['Azul']);
  // Leo unpauses: Azul's one copy is Kiri's, so nothing for him (it's passed over, still queued)
  await settings({ paused: false }, LEO);
  assert.deepEqual(holdsOf(LEO), []);
  assert.deepEqual(allHolds().filter((h) => h.status === 'held' && h.variant_id === '4002').length, 1);
  // both moved on together, twice (as maintenance and a request might): still one hold of Azul
  for (let i = 0; i < 2; i += 1) {
    lair.queueAdvance(LEO);
    lair.queueAdvance(KIRI);
  }
  assert.deepEqual(allHolds().filter((h) => h.status === 'held').map((h) => [h.customer_id, h.title]), [[KIRI, 'Azul']]);
  // a reserve then an advance: Sam reserves Root's only copy by hand; Leo queues Root: nothing to hold
  assert.equal((await reserve(ROOT)).status, 200);
  await add(ROOT, LEO);
  assert.deepEqual(holdsOf(LEO), []);
  // and the other way: Leo's queue holds Wingspan's copy first; Sam's reserve of it is refused
  await add(WINGSPAN, LEO);
  assert.deepEqual(holdsOf(LEO).map((h) => h.title), ['Wingspan']);
  const late = await reserve(WINGSPAN);
  assert.equal(late.status, 409);
  assert.match(late.data.error, /^Every copy is reserved or out on loan right now/);
  assert.equal(allHolds().filter((h) => h.status === 'held' && h.variant_id === '4004').length, 1);
});

test('round 17 queue: in the Lair, an uncollected hold stalls the queue: the game goes back at its place, nothing else is held until they act, and they hear', async () => {
  // Kiri (Grab: 1) queues Azul and Root: Azul is held until midnight Sunday (00:00 Monday 19 October)
  await add(AZUL, KIRI);
  await add(ROOT, KIRI);
  await settle();
  assert.deepEqual(mail.subjects('kiri@example.com').filter((x) => /queue/.test(x)), ['Azul is next in your queue and on hold for you']);
  const kiriMail = mail.sent.find((m) => m.subject === 'Azul is next in your queue and on hold for you');
  assert.match(kiriMail.text, /Kia ora Kiri! Azul came up next in your queue, so it's on hold for you until midnight on Sunday 18 October\. Collect it at the counter with your member code\./);
  assert.match(kiriMail.text, /See your queue: https:\/\/www\.dicegoblin\.nz\/pages\/my-lair\?view=library/);
  assert.ok(mail.subjects('staff@dicegoblin.test').includes('Hold this game: Azul (DGL34-M002) for Kiri Smith, until midnight on Sunday 18 October'));
  assert.match(mail.sent.find((m) => m.subject.startsWith('Hold this game: Azul')).text, /It came up next in her queue|It came up next in their queue/);
  // Monday 19 October, past midnight: maintenance expires it
  setNow(at('2026-10-19', 9));
  mail.sent.length = 0;
  const run = await maintenance();
  assert.deepEqual(run.libraryHolds, { expired: 1 });
  assert.deepEqual(rows(KIRI).map((r) => [r.product_id, r.status, r.position]), [[AZUL, 'queued', 1], [ROOT, 'queued', 2]], 'back at its place');
  const q = (await queue(KIRI)).data;
  assert.deepEqual(q.settings, { paused: false, delivery: 'store', area: null, stalled: true, stalledReason: 'missed' });
  assert.deepEqual(holdsOf(KIRI), [], 'nothing else is held: holds don\'t stack up while she\'s away');
  await settle();
  const paused = mail.sent.filter((m) => m.to === 'kiri@example.com');
  assert.deepEqual(paused.map((m) => m.subject), ['Your queue is paused'], 'one email, the queue words (not the plain "Your hold ended" too)');
  assert.match(paused[0].text, /Azul wasn't collected, so it's back on the shelf and your queue is paused\. Start it again in My Lair whenever you're ready\./);
  // maintenance runs again and again: still stalled, still nothing held
  setNow(at('2026-10-19', 10));
  await maintenance();
  await maintenance();
  assert.deepEqual(holdsOf(KIRI), []);
  // "Start my queue again": Azul is held again (first in line)
  const again = await restart(KIRI);
  assert.deepEqual([again.data.ok, again.data.settings.stalled, again.data.queue.map((x) => [x.productId, x.status])], [true, false, [[AZUL, 'held'], [ROOT, 'queued']]]);
});

test('round 17 queue: any change to the queue, a reserve or a borrow starts a stalled queue again; pausing never holds anything', async () => {
  const stall = async (who) => {
    lair.saveQueueSettings(who, { stalled: true, stalledReason: 'missed', stalledAt: clock }, clock);
    assert.equal(lair.queueSettings(who).stalled, true);
  };
  await settings({ paused: true }, LEO);
  await add(AZUL, LEO);
  await settings({ paused: false }, LEO);
  assert.equal(holdsOf(LEO).length, 1);
  // stalled: adding a game is acting, so it moves on (Root held)
  await stall(LEO);
  await add(ROOT, LEO);
  assert.deepEqual([lair.queueSettings(LEO).stalled, holdsOf(LEO).map((h) => h.title)], [false, ['Azul', 'Root']]);
  // stalled: moving one is acting
  await stall(LEO);
  await add(WINGSPAN, LEO);
  assert.equal(lair.queueSettings(LEO).stalled, false, 'adding cleared it');
  await stall(LEO);
  await move(WINGSPAN, 1, LEO);
  assert.equal(lair.queueSettings(LEO).stalled, false);
  // stalled: a reserve (by the member) is acting
  await stall(LEO);
  await reserve(CASCADIA, LEO);
  assert.equal(lair.queueSettings(LEO).stalled, false);
  // stalled: a borrow (scanning in My Library) is acting
  await stall(LEO);
  lair.saveLibraryGame({ variantId: '4001', productId: CATAN, title: 'Catan', handle: 'catan', shelfCode: 'DGL34-M001' }, clock);
  const scan = await call('POST', 'library/scan', { code: 'DGL34-M001' }, LEO);
  assert.equal(scan.status, 200, said(scan));
  assert.equal(lair.queueSettings(LEO).stalled, false);
  // stalled: unpausing clears it; changing how they swap clears it; staff reserving for them doesn't
  await stall(LEO);
  await call('POST', 'library/holds', { customerId: LEO, variantId: '4002', productId: AZUL, title: 'Azul' }, 'staff').catch(() => null);
  assert.equal(lair.queueSettings(LEO).stalled, true, 'staff reserving for someone isn\'t them acting');
  await settings({ delivery: 'post', area: 'auckland' }, LEO);
  assert.equal(lair.queueSettings(LEO).stalled, false);
  await stall(LEO);
  await settings({ paused: true }, LEO);
  assert.equal(lair.queueSettings(LEO).stalled, true, 'pausing isn\'t starting it');
  await settings({ paused: false }, LEO);
  assert.equal(lair.queueSettings(LEO).stalled, false, 'unpausing is');
  // paused: nothing is held, whatever runs
  await settings({ paused: true }, SAM);
  await add(AZUL);
  await add(GLOOM).catch(() => null);
  await maintenance();
  lair.queueAdvance(SAM);
  assert.deepEqual(holdsOf(SAM), []);
});

test('round 17 queue: a member cancelling a queued hold doesn\'t stall it: the game goes back at its place, passed over until they act, and the next one is held', async () => {
  await settings({ paused: true }, KIRI);
  await add(AZUL, KIRI);
  await add(ROOT, KIRI);
  await settings({ paused: false }, KIRI);
  const azul = holdsOf(KIRI)[0];
  assert.equal(azul.title, 'Azul');
  const cancelled = await call('POST', `library/holds/${azul.id}/cancel`, {}, KIRI);
  assert.equal(cancelled.status, 200);
  const q = (await queue(KIRI)).data;
  assert.deepEqual([q.settings.stalled, q.queue.map((x) => [x.productId, x.position, x.status])], [false, [[AZUL, 1, 'queued'], [ROOT, 2, 'held']]], 'Root, the next one, is held; Azul keeps its place');
  // maintenance doesn't put Azul straight back on hold (she just said no to it), nor stall anything
  await maintenance();
  assert.deepEqual(holdsOf(KIRI).map((h) => h.title), ['Root']);
  // staff releasing a queued hold early: the same (back in the queue, no stall)
  const root = holdsOf(KIRI)[0];
  await call('POST', `library/holds/${root.id}/update`, { status: 'released' }, 'staff');
  assert.deepEqual([lair.queueSettings(KIRI).stalled, rows(KIRI).map((r) => [r.product_id, r.status])], [false, [[AZUL, 'queued'], [ROOT, 'queued']]]);
  assert.deepEqual(holdsOf(KIRI), [], 'both passed over until she acts');
  // staff hold it again by mistake fix: its queue row is held again
  await call('POST', `library/holds/${root.id}/update`, { status: 'held' }, 'staff');
  assert.deepEqual(rows(KIRI).map((r) => [r.product_id, r.status]), [[AZUL, 'queued'], [ROOT, 'held']]);
  // she acts (moves Azul): passed-over games are back in line
  await call('POST', `library/holds/${root.id}/cancel`, {}, KIRI);
  await move(AZUL, 1, KIRI);
  assert.deepEqual(holdsOf(KIRI).map((h) => h.title), ['Azul']);
  // a held game taken off the queue keeps its hold
  const off = await removeQ(AZUL, KIRI);
  assert.deepEqual([off.data.removed, holdsOf(KIRI).map((h) => h.title)], [true, ['Azul']]);
});

/* ---------------- postal swaps ---------------- */

/** Kiri (Grab) swaps by post to Auckland and queues Azul, held at once (Friday 16 October 1pm: until Wednesday 21st 10pm) */
async function postalKiri() {
  await settings({ delivery: 'post', area: 'auckland' }, KIRI);
  await add(AZUL, KIRI);
  const [send] = sends();
  return send;
}
const confirm = (id, body = { area: 'auckland' }, who = KIRI) => call('POST', `me/queue/sends/${id}/confirm`, body, who);
const skip = (id, who = KIRI) => call('POST', `me/queue/sends/${id}/skip`, {}, who);

test('round 17 queue: by post, the hold lasts until the cutoff and a send waits for the postage; the member and staff hear', async () => {
  const send = await postalKiri();
  const hold = holdsOf(KIRI)[0];
  assert.deepEqual([hold.until, hold.created_by], [at('2026-10-21', 22), 'queue']);
  assert.deepEqual([send.status, send.confirm_by, send.send_day, send.area, send.postage, send.hold_id, send.title, send.shelf_code], ['waiting', at('2026-10-21', 22), '2026-10-22', 'auckland', 1000, hold.id, 'Azul', 'DGL34-M002']);
  const q = (await queue(KIRI)).data;
  assert.deepEqual(q.sends, [{
    id: send.id, productId: AZUL, title: 'Azul', shelfCode: 'DGL34-M002', area: 'auckland', postage: 1000, status: 'waiting', confirmBy: at('2026-10-21', 22),
    sendDay: '2026-10-22', holdId: hold.id, checkoutUrl: null, orderName: null, createdAt: NOW,
  }]);
  assert.deepEqual(q.queue[0].hold, { until: at('2026-10-21', 22) });
  await settle();
  const post = mail.sent.find((m) => m.to === 'kiri@example.com');
  assert.equal(post.subject, 'Your next game is ready to post: Azul');
  assert.match(post.text, /Azul came up next in your queue\. Confirm and pay the postage \(\$10\) by 10pm on Wednesday 21 October and it goes out on Thursday\. Not this time\? Skip it and it stays in your queue\./);
  assert.match(post.text, /Send it: https:\/\/www\.dicegoblin\.nz\/pages\/my-lair\?view=library/);
  assert.ok(mail.subjects('staff@dicegoblin.test').includes('Hold this game for the post: Azul (DGL34-M002) for Kiri Smith'));
});

test('round 17 queue: confirm makes one checkout (a draft order for the member: a $0 swap line that ships, the area\'s postage, _libsend); again reuses it; a new area makes a new one', async () => {
  const send = await postalKiri();
  const first = await confirm(send.id);
  assert.equal(first.status, 200, said(first));
  assert.deepEqual([first.data.checkoutUrl, first.data.send.status, first.data.send.checkoutUrl], ['https://shop.test/checkouts/801', 'checkout', 'https://shop.test/checkouts/801']);
  assert.deepEqual(shop.made, [{ sendId: send.id, customerId: KIRI, email: 'kiri@example.com', title: 'Azul', shelfCode: 'DGL34-M002', areaWords: 'Auckland', postage: 1000, currency: 'NZD' }]);
  // twice more (a double tap, a refresh): the same checkout, nothing new made
  for (let i = 0; i < 2; i += 1) assert.equal((await confirm(send.id)).data.checkoutUrl, 'https://shop.test/checkouts/801');
  assert.equal(shop.made.length, 1);
  // two taps at once: one checkout between them
  const [a, b] = await Promise.all([confirm(send.id), confirm(send.id)]);
  assert.deepEqual([a.data.checkoutUrl, b.data.checkoutUrl, shop.made.length], ['https://shop.test/checkouts/801', 'https://shop.test/checkouts/801', 1]);
  // Nationwide rural instead: a new checkout at its price, the old one's link stops working, and it's remembered
  const rural = await confirm(send.id, { area: 'nationwide-rural' });
  assert.deepEqual([rural.data.checkoutUrl, rural.data.send.postage, shop.made[1].postage, shop.made[1].areaWords], ['https://shop.test/checkouts/802', 3000, 3000, 'Nationwide rural']);
  await settle();
  assert.deepEqual(shop.deleted, ['gid://shopify/DraftOrder/801']);
  assert.equal(lair.queueSettings(KIRI).area, 'nationwide-rural');
  // the hold keeps the copy through the 30 minutes' grace after the cutoff, for a payment in flight
  assert.equal(holdsOf(KIRI)[0].until, at('2026-10-21', 22, 30));
  // errors: someone else's send is a 404; a bad area a 422; Shopify down a 503 (nothing changes)
  assert.equal(said(await confirm(send.id, { area: 'auckland' }, SAM)), `404 ${QUEUE_MESSAGES.send}`);
  assert.equal(said(await confirm('ls_nope')), `404 ${QUEUE_MESSAGES.send}`);
  assert.equal(said(await confirm(send.id, { area: 'mars' })), `422 ${QUEUE_MESSAGES.area}`);
  shop.failNext = 1;
  assert.equal(said(await confirm(send.id, { area: 'auckland' })), `503 ${QUEUE_MESSAGES.shopify}`);
  assert.equal((await confirm(send.id, { area: 'auckland' })).data.checkoutUrl, 'https://shop.test/checkouts/803', 'and the next try works');
});

test('round 17 queue: the webhook only pays the send whose own draft order became that order; staff hear "Post this Thursday"; a repeat changes nothing', async () => {
  const send = await postalKiri();
  await confirm(send.id);
  mail.sent.length = 0;
  // A forged order naming the send, from a draft that isn't the send's: nothing
  const forged = { id: 900, admin_graphql_api_id: 'gid://shopify/Order/900', name: '#900', source_name: 'shopify_draft_order', note_attributes: [{ name: '_libsend', value: send.id }] };
  shop.orders.set('gid://shopify/DraftOrder/999', 'gid://shopify/Order/900');
  assert.equal((await internal('orders-paid', forged)).data.librarySends, undefined);
  // an order from the web or the POS naming it: nothing (only a draft order's checkout pays a send)
  for (const source of ['web', 'pos']) assert.equal((await internal('orders-paid', { ...forged, source_name: source })).data.librarySends, undefined);
  // the send's draft still open (so not this order): nothing
  assert.equal((await internal('orders-paid', { ...forged, id: 901, admin_graphql_api_id: 'gid://shopify/Order/901' })).data.librarySends, undefined);
  assert.equal(sends()[0].status, 'checkout');
  // the real one: paid, with the order's id and name
  const paid = await internal('orders-paid', paidSend('gid://shopify/DraftOrder/801', 902));
  assert.deepEqual(paid.data.librarySends, [send.id]);
  const s = sends()[0];
  assert.deepEqual([s.status, s.order_id, s.order_name, s.late], ['paid', 'gid://shopify/Order/902', '#902', 0]);
  assert.ok(holdsOf(KIRI)[0].until >= at('2026-10-22', 0), 'the copy stays theirs while staff post it');
  await settle();
  const staff = mail.sent.filter((m) => m.to === 'staff@dicegoblin.test');
  assert.deepEqual(staff.map((m) => m.subject), ['Post this Thursday: Azul for Kiri Smith']);
  // Shopify sends it again: nothing new, nobody emailed again
  mail.sent.length = 0;
  assert.equal((await internal('orders-paid', paidSend('gid://shopify/DraftOrder/801', 902))).data.librarySends, undefined);
  await settle();
  assert.deepEqual(mail.sent, []);
  // the queue view says paid (no checkout link any more)
  assert.deepEqual((await queue(KIRI)).data.sends.map((x) => [x.status, x.checkoutUrl, x.orderName]), [['paid', null, '#902']]);
  // after the cutoff, a paid send never lapses
  setNow(at('2026-10-22', 9));
  await maintenance();
  assert.equal(sends()[0].status, 'paid');
  assert.equal(holdsOf(KIRI).length, 1);
});

test('round 17 queue: the cutoff: an unpaid send lapses (a checkout after 30 minutes\' grace), the hold ends, the game goes back in the queue and the queue stalls', async () => {
  const send = await postalKiri();
  await add(ROOT, KIRI);
  // Wednesday 21 October 10pm: the waiting send lapses at the cutoff
  setNow(at('2026-10-21', 22));
  mail.sent.length = 0;
  const run = await maintenance();
  assert.deepEqual(run.librarySends, { lapsed: 1 });
  assert.deepEqual([sends()[0].status, lair.holdRow(send.hold_id).status], ['lapsed', 'expired']);
  assert.deepEqual(rows(KIRI).map((r) => [r.product_id, r.status]), [[AZUL, 'queued'], [ROOT, 'queued']]);
  assert.deepEqual(lair.queueSettings(KIRI).stalledReason, 'lapsed');
  assert.deepEqual(holdsOf(KIRI), [], 'nothing else held');
  await settle();
  const told = mail.sent.filter((m) => m.to === 'kiri@example.com');
  assert.deepEqual(told.map((m) => m.subject), ['Your queue is paused']);
  assert.match(told[0].text, /Azul wasn't confirmed by the cutoff, so it's back on the shelf and your queue is paused\./);
  // confirming now: 409 lapsed
  assert.equal(said(await confirm(send.id)), `409 ${QUEUE_MESSAGES.lapsed}`);
  // Restart: Azul is held again, for next Wednesday's cutoff (28 October)
  setNow(at('2026-10-22', 10));
  await restart(KIRI);
  const next = sends().at(-1);
  assert.deepEqual([next.status, next.confirm_by, next.send_day], ['waiting', at('2026-10-28', 22), '2026-10-29']);
  // at the checkout: the cutoff passes, but it waits 30 minutes for a payment in flight
  await confirm(next.id);
  setNow(at('2026-10-28', 22, 10));
  assert.equal((await maintenance()).librarySends, undefined);
  assert.equal(sends().at(-1).status, 'checkout');
  assert.equal(said(await confirm(next.id)), `409 ${QUEUE_MESSAGES.lapsed}`, 'no new checkout after the cutoff');
  assert.equal(sends().at(-1).status, 'checkout', 'but the one in flight stays');
  setNow(at('2026-10-28', 22, 31));
  assert.deepEqual((await maintenance()).librarySends, { lapsed: 1 });
  await settle();
  assert.ok(shop.deleted.includes(next.draft_order_id || sends().at(-1).draft_order_id), 'its checkout stops working');
});

test('round 17 queue: a late payment (after the send lapsed) is still recorded and staff are told to send it next Thursday or refund', async () => {
  const send = await postalKiri();
  await confirm(send.id);
  setNow(at('2026-10-21', 23));
  await maintenance();
  assert.equal(sends()[0].status, 'lapsed');
  mail.sent.length = 0;
  const paid = await internal('orders-paid', paidSend('gid://shopify/DraftOrder/801', 950));
  assert.deepEqual(paid.data.librarySends, [send.id]);
  const s = sends()[0];
  assert.deepEqual([s.status, s.late, s.send_day], ['paid', 1, '2026-10-29']);
  await settle();
  const staff = mail.sent.filter((m) => m.to === 'staff@dicegoblin.test');
  assert.deepEqual(staff.map((m) => m.subject), ['Postage paid after the cutoff: Azul for Kiri Smith']);
  assert.match(staff[0].text, /posted after the cutoff: send it next Thursday or refund/i);
  // paid inside the grace but after it ran out (maintenance hadn't got there yet): lapsed and flagged the same way
  setNow(at('2026-10-23', 9));
  await restart(KIRI);
  const next = sends().at(-1);
  await confirm(next.id);
  setNow(at('2026-10-28', 23));
  mail.sent.length = 0;
  assert.deepEqual((await internal('orders-paid', paidSend('gid://shopify/DraftOrder/802', 951))).data.librarySends, [next.id]);
  assert.deepEqual([sends().at(-1).status, sends().at(-1).late], ['paid', 1]);
  await settle();
  assert.ok(mail.subjects('staff@dicegoblin.test').includes('Postage paid after the cutoff: Azul for Kiri Smith'));
});

test('round 17 queue: "Not this time" skips a send: the hold ends now, the game goes back in the queue, the queue stalls (skipped); a paid one can\'t be skipped', async () => {
  const send = await postalKiri();
  await confirm(send.id);
  const res = await skip(send.id);
  assert.equal(res.status, 200, said(res));
  assert.deepEqual([res.data.ok, res.data.settings.stalled, res.data.settings.stalledReason, res.data.queue.map((x) => [x.productId, x.status])], [true, true, 'skipped', [[AZUL, 'queued']]]);
  assert.deepEqual([sends()[0].status, lair.holdRow(send.hold_id).status], ['cancelled', 'cancelled']);
  await settle();
  assert.deepEqual(shop.deleted, ['gid://shopify/DraftOrder/801'], 'its checkout stops working');
  assert.equal((await skip(send.id)).status, 200, 'again is fine');
  assert.equal(said(await confirm(send.id)), `409 ${QUEUE_MESSAGES.skipped}`);
  assert.equal(said(await skip(send.id, SAM)), `404 ${QUEUE_MESSAGES.send}`);
  // a paid send can't be skipped
  await restart(KIRI);
  const next = sends().at(-1);
  await confirm(next.id);
  await internal('orders-paid', paidSend(sends().at(-1).draft_order_id, 960));
  assert.equal(said(await skip(next.id)), `409 ${QUEUE_MESSAGES.paid}`);
});

test('round 17 queue: staff postal swaps: the open list (by send day, then name, with the member), packed, sent collects into a loan, cancelled goes back in the queue; permissions', async () => {
  const send = await postalKiri();
  await confirm(send.id);
  // Leo by post too (Nationwide), paid
  await settings({ delivery: 'post', area: 'nationwide' }, LEO);
  await add(ROOT, LEO);
  const leoSend = sends().find((x) => x.customer_id === LEO);
  await confirm(leoSend.id, { area: 'nationwide' }, LEO);
  await internal('orders-paid', paidSend(sends().find((x) => x.customer_id === LEO).draft_order_id, 970));
  // who may see and change them: staff with the library permission only
  for (const who of [SAM, '', 'helper-desk', 'helper-tables']) {
    assert.equal((await call('GET', 'library/sends', null, who)).status, 403, who);
    assert.equal((await call('POST', `library/sends/${send.id}/update`, { status: 'cancelled' }, who)).status, 403, who);
  }
  const list = await call('GET', 'library/sends', null, 'helper-library');
  assert.equal(list.status, 200, said(list));
  assert.deepEqual(list.data.sends.map((x) => [x.name, x.status, x.sendDay]), [['Kiri Smith', 'checkout', '2026-10-22'], ['Leo Tane', 'paid', '2026-10-22']]);
  const kiri = list.data.sends[0];
  assert.deepEqual([kiri.email, kiri.code, kiri.customerId, kiri.title, kiri.shelfCode, kiri.postage, 'checkoutUrl' in kiri], ['kiri@example.com', lair.memberRow(KIRI).code, KIRI, 'Azul', 'DGL34-M002', 1000, false]);
  // packing or sending an unpaid one: 409; a bad status: 422
  assert.equal(said(await call('POST', `library/sends/${send.id}/update`, { status: 'sent' }, 'staff')), `409 ${QUEUE_MESSAGES.unpaid}`);
  assert.equal(said(await call('POST', `library/sends/${leoSend.id}/update`, { status: 'lost' }, 'staff')), `422 ${QUEUE_MESSAGES.sendStatus}`);
  // Leo's: packed, then sent: the hold is collected, the game's at home with him (out_by staff), the queue row done
  const packed = await call('POST', `library/sends/${leoSend.id}/update`, { status: 'packed', note: 'Courier bag 3' }, 'helper-library');
  assert.deepEqual([packed.data.send.status, packed.data.send.note, packed.data.loan], ['packed', 'Courier bag 3', null]);
  const sent = await call('POST', `library/sends/${leoSend.id}/update`, { status: 'sent' }, 'helper-library');
  assert.equal(sent.status, 200, said(sent));
  assert.deepEqual([sent.data.send.status, sent.data.loan.title, sent.data.loan.customerId, sent.data.loan.status], ['sent', 'Root', LEO, 'out']);
  const loan = lair.sql.exec("SELECT * FROM library_loans WHERE customer_id = ? AND status = 'out'", LEO).one();
  assert.deepEqual([loan.out_by, lair.holdRow(leoSend.hold_id).status], ['staff:helper-library', 'collected']);
  assert.deepEqual(rows(LEO).map((r) => [r.product_id, r.status]), [[ROOT, 'done']]);
  assert.equal(said(await call('POST', `library/sends/${leoSend.id}/update`, { status: 'cancelled' }, 'staff')), `409 ${QUEUE_MESSAGES.sendDone('sent')}`);
  // Kiri's: cancelled by staff: the hold ends (back on the shelf), the checkout stops working, the game is back in her queue
  const off = await call('POST', `library/sends/${send.id}/update`, { status: 'cancelled' }, 'staff');
  assert.deepEqual([off.data.send.status, lair.holdRow(send.hold_id).status, rows(KIRI)[0].status], ['cancelled', 'released', 'queued']);
  await settle();
  assert.ok(shop.deleted.includes('gid://shopify/DraftOrder/801'));
  // the open list is empty now; all keeps them
  assert.deepEqual((await call('GET', 'library/sends', null, 'staff')).data.sends, []);
  assert.equal((await call('GET', 'library/sends?status=all', null, 'staff')).data.sends.length, 2);
  assert.equal(said(await call('POST', 'library/sends/ls_nope/update', { status: 'packed' }, 'staff')), `404 ${QUEUE_MESSAGES.send}`);
});

/* ---------------- tell me when it's back ---------------- */

test('round 17 queue: watches: add and remove, the errors, 50 at most; each watcher is told once when a copy is free, and a member who has it isn\'t', async () => {
  const watch = (productId, who = SAM) => call('POST', 'library/watch', { productId }, who);
  const unwatch = (productId, who = SAM) => call('POST', 'library/watch/remove', { productId }, who);
  assert.deepEqual(said(await watch(AZUL, '')), "401 Log in to hear when it's back.");
  assert.equal(said(await watch(ATTIC)), `422 ${QUEUE_MESSAGES.product}`);
  assert.equal(said(await watch('nope')), `422 ${QUEUE_MESSAGES.product}`);
  // Kiri reserves Azul's only copy; Sam, Leo and Ari watch it (Ari has no plan: anyone logged in can watch)
  await reserve(AZUL, KIRI);
  for (const who of [SAM, LEO, ARI]) assert.deepEqual((await watch(AZUL, who)).data, { ok: true, watching: true });
  assert.deepEqual((await watch(AZUL)).data, { ok: true, watching: true }, 'again is fine');
  assert.deepEqual((await queue(SAM)).data.watching.map((w) => w.productId), [AZUL]);
  // Leo stops watching
  assert.deepEqual((await unwatch(AZUL, LEO)).data, { ok: true, watching: false });
  // nothing free yet: maintenance tells nobody
  mail.sent.length = 0;
  assert.equal((await maintenance()).watches, undefined);
  // Kiri cancels: Sam and Ari hear once each ("Azul is back on the shelf"), and their watches go
  await call('POST', `library/holds/${holdsOf(KIRI)[0].id}/cancel`, {}, KIRI);
  await settle();
  const back = mail.sent.filter((m) => m.subject === 'Azul is back on the shelf');
  assert.deepEqual(back.map((m) => m.to).sort(), ['ari@example.com', 'sam@example.com']);
  assert.match(back[0].text, /Good news, friend: Azul is back\. Reserve it before someone else does\./);
  assert.match(back[0].text, /Reserve it: https:\/\/www\.dicegoblin\.nz\/products\/azul/);
  assert.deepEqual(lair.sql.exec('SELECT * FROM library_watch').toArray(), []);
  mail.sent.length = 0;
  await maintenance();
  await settle();
  assert.deepEqual(mail.sent.filter((m) => /back on the shelf/.test(m.subject)), [], 'told once');
  // a watcher who has it on hold (or at home) isn't told; their watch just goes
  await reserve(ROOT, KIRI);
  await watch(ROOT, KIRI);
  await watch(ROOT, SAM);
  lair.sql.exec("UPDATE library_holds SET status = 'released' WHERE customer_id = ? AND title = 'Root'", KIRI);
  await reserve(ROOT, KIRI);
  FIXTURES[ROOT].copies = 2;
  mail.sent.length = 0;
  assert.deepEqual((await maintenance()).watches, { told: 1 });
  await settle();
  assert.deepEqual(mail.sent.filter((m) => /back on the shelf/.test(m.subject)).map((m) => m.to), ['sam@example.com']);
  assert.deepEqual(lair.sql.exec('SELECT * FROM library_watch').toArray(), []);
  // 50 at most
  for (let n = 1; n <= WATCH_MAX; n += 1) FIXTURES[String(8100 + n)] = game(String(8100 + n), String(5100 + n), `Watch ${n}`);
  for (let n = 1; n <= WATCH_MAX; n += 1) await watch(String(8100 + n), LEO);
  assert.equal(said(await watch(CATAN, LEO)), `409 ${QUEUE_MESSAGES.watchFull}`);
  assert.equal((await watch('8101', LEO)).status, 200, 'one already watched is fine');
});

/* ---------------- a library game on a table booking ---------------- */

/** A table for 2 on Saturday 24 October, 7pm to 9pm (its game held from Wednesday 21 October 00:00) */
const SATURDAY = { start: at('2026-10-24', 19), end: at('2026-10-24', 21) };
const book = (productId, who = SAM, over = {}) => call('POST', 'bookings', {
  kind: 'table', tables: ['T5'], ...SATURDAY, people: 2, name: NAMES[who] || 'Guest Person', email: `${(NAMES[who] || 'guest x').split(' ')[0].toLowerCase()}@example.com`,
  ...(productId ? { game: { productId } } : {}), ...over,
}, who);
const bookingRow = (id) => lair.sql.exec('SELECT * FROM bookings WHERE id = ?', id).one();
const tableHolds = () => lair.sql.exec("SELECT * FROM library_holds WHERE kind = 'booking' ORDER BY created_at, rowid").toArray();

test('round 17 queue: a game on a table booking: saved with the booking, waiting until midnight 3 days before (a Saturday: Wednesday 00:00), then held by maintenance until the booking ends', async () => {
  const res = await book(CATAN);
  assert.equal(res.status, 200, said(res));
  const { booking } = res.data;
  assert.deepEqual(booking.game, {
    productId: CATAN, title: 'Catan', handle: 'catan', image: 'https://cdn.shopify.com/4001.jpg', state: 'waiting', holdFrom: at('2026-10-21', 0), holdId: null, double: false,
  });
  const row = bookingRow(booking.id);
  assert.deepEqual([row.game_product_id, row.game_title, row.game_handle, row.game_state, row.game_hold_id], [CATAN, 'Catan', 'catan', 'waiting', null]);
  assert.deepEqual(tableHolds(), [], 'nothing held yet');
  // Tuesday 11:59pm: still waiting
  setNow(at('2026-10-20', 23, 59));
  await maintenance();
  assert.deepEqual(tableHolds(), []);
  // Wednesday 00:00: held, for Sam's account, until the booking ends
  setNow(at('2026-10-21', 0));
  const run = await maintenance();
  assert.deepEqual(run.bookingGames, { held: 1, unavailable: 0, released: 0 });
  const [hold] = tableHolds();
  assert.deepEqual([hold.kind, hold.booking_id, hold.customer_id, hold.status, hold.until, hold.variant_id, hold.product_id, hold.created_by], ['booking', booking.id, SAM, 'held', SATURDAY.end, '4001', CATAN, 'booking']);
  assert.deepEqual([bookingRow(booking.id).game_state, bookingRow(booking.id).game_hold_id], ['held', hold.id]);
  assert.equal((await maintenance()).bookingGames, undefined, 'never twice');
  assert.equal(tableHolds().length, 1);
  // it never expires before the booking ends: Saturday 8:59pm, maintenance leaves it held
  for (const when of [at('2026-10-22', 12), at('2026-10-24', 0, 5), at('2026-10-24', 20, 59)]) {
    setNow(when);
    await maintenance();
    assert.equal(lair.holdRow(hold.id).status, 'held', new Date(when).toISOString());
  }
  // checked in: played
  setNow(at('2026-10-24', 19, 5));
  await call('POST', 'checkin', { code: booking.ref }, 'staff');
  assert.equal(bookingRow(booking.id).game_state, 'played');
  // the booking ends: the copy goes back on the shelf, quietly
  setNow(at('2026-10-24', 21, 5));
  mail.sent.length = 0;
  await maintenance();
  assert.deepEqual([lair.holdRow(hold.id).status, lair.holdRow(hold.id).endedAt], ['released', SATURDAY.end]);
  await settle();
  assert.deepEqual(mail.sent.filter((m) => m.to === 'sam@example.com'), [], 'the booker isn\'t emailed about it');
});

test('round 17 queue: booking holds never count against a plan nor show in a member\'s holds, but count for copies (a reserve can\'t take the held copy); staff see them', async () => {
  // Kiri (Grab: 1 game) brings Azul (1 copy) to her table; the window opens
  const kiri = (await book(AZUL, KIRI)).data.booking;
  setNow(at('2026-10-21', 9));
  await maintenance();
  const [hold] = tableHolds();
  assert.equal(hold.customer_id, KIRI);
  // her plan still has its one game free: she reserves Root
  const root = await reserve(ROOT, KIRI);
  assert.equal(root.status, 200, said(root));
  // GET /me: her holds and My Library show Root only; the plan counts 1
  const me = (await call('GET', 'me', null, KIRI)).data;
  assert.deepEqual(me.holds.map((h) => h.title), ['Root']);
  assert.deepEqual([me.library.used, me.library.holds.map((h) => h.title)], [1, ['Root']]);
  assert.deepEqual((await queue(KIRI)).data.plan, { name: 'Grab', games: 1, holds: 1, atHome: 0 });
  assert.deepEqual(me.bookings.find((b) => b.id === kiri.id).game.state, 'held', 'My Lair\'s booking card shows the game');
  // the copy is taken: Sam can't reserve Azul, and the library page says so
  const sam = await reserve(AZUL);
  assert.equal(sam.status, 409);
  const status = (await call('GET', 'library/status?ids=4002', null, KIRI)).data.games['4002'];
  assert.deepEqual([status.held, status.available, status.mine], [1, 0, null], 'held for a table, not one of her holds');
  // a queue passes it over too
  await add(AZUL, LEO);
  assert.deepEqual(holdsOf(LEO).filter((h) => h.kind === 'member'), []);
  // staff see it in the holds list, with its booking
  const staff = (await call('GET', 'library/holds', null, 'helper-library')).data.holds;
  const forTable = staff.find((h) => h.id === hold.id);
  assert.deepEqual([forTable.kind, forTable.booking], ['booking', { id: kiri.id, code: kiri.ref, start: SATURDAY.start, name: 'Kiri Smith' }]);
  assert.equal(staff.find((h) => h.title === 'Root').kind, 'member');
  // and the booking on the staff floor carries its game
  const floor = (await call('GET', `floor?from=${SATURDAY.start - HOUR}&to=${SATURDAY.end + HOUR}`, null, 'staff')).data.bookings.find((b) => b.id === kiri.id);
  assert.deepEqual([floor.game.productId, floor.game.state, floor.game.holdId], [AZUL, 'held', hold.id]);
});

test('round 17 queue: no copy when the window opens: unavailable, the booker emailed once to pick another; held later if a copy comes free', async () => {
  // Sam has Root's only copy at home (borrowed at the counter); Leo books Root for Saturday
  await reserve(ROOT);
  await call('POST', `library/holds/${holdsOf(SAM)[0].id}/update`, { status: 'collected' }, 'staff');
  const leo = (await book(ROOT, LEO)).data.booking;
  setNow(at('2026-10-21', 0, 5));
  mail.sent.length = 0;
  assert.deepEqual((await maintenance()).bookingGames, { held: 0, unavailable: 1, released: 0 });
  assert.equal(bookingRow(leo.id).game_state, 'unavailable');
  await settle();
  const told = mail.sent.filter((m) => m.to === 'leo@example.com');
  assert.deepEqual(told.map((m) => m.subject), ['Pick another game for Saturday 24 October']);
  assert.match(told[0].text, /Every copy of Root is out right now, so we can't hold it for your table on Saturday 24 October\. Pick another game in My Lair, or grab something off the shelves on the night\./);
  // again and again: no second email
  mail.sent.length = 0;
  setNow(at('2026-10-21', 9));
  await maintenance();
  await maintenance();
  await settle();
  assert.deepEqual(mail.sent.filter((m) => m.to === 'leo@example.com'), []);
  // staff see it on the booking
  const floor = (await call('GET', `floor?from=${SATURDAY.start - HOUR}&to=${SATURDAY.end + HOUR}`, null, 'staff')).data.bookings.find((b) => b.id === leo.id);
  assert.equal(floor.game.state, 'unavailable');
  // Sam brings it back: the copy goes straight to the table that wanted it
  const loan = lair.sql.exec("SELECT id FROM library_loans WHERE customer_id = ? AND status = 'out'", SAM).one();
  await call('POST', `library/loans/${loan.id}/return`, {}, 'staff');
  await maintenance();
  assert.deepEqual([bookingRow(leo.id).game_state, tableHolds().length], ['held', 1]);
});

test('round 17 queue: released when the booking is cancelled, a no-show, or its game changes; moved, the window moves; attaching inside the window holds at once', async () => {
  const sam = (await book(CATAN)).data.booking;
  const kiri = (await book(AZUL, KIRI, { tables: ['T6'] })).data.booking;
  const leo = (await book(ROOT, LEO, { tables: ['T7'] })).data.booking;
  setNow(at('2026-10-22', 12));
  await maintenance();
  assert.equal(tableHolds().filter((h) => h.status === 'held').length, 3);
  // Sam cancels his own booking: its hold is released at once, the state says so
  const cancelled = await call('POST', `bookings/${sam.id}/update`, { status: 'cancelled' }, SAM);
  assert.equal(cancelled.status, 200, said(cancelled));
  assert.deepEqual([bookingRow(sam.id).game_state, lair.holdRow(bookingRow(sam.id).game_hold_id).status], ['released', 'released']);
  // Kiri changes her game to Wingspan: Azul's hold goes, Wingspan is held at once (inside the window)
  const changed = await call('POST', `bookings/${kiri.id}/game`, { productId: WINGSPAN }, KIRI);
  assert.equal(changed.status, 200, said(changed));
  assert.deepEqual([changed.data.ok, changed.data.game.productId, changed.data.game.state], [true, WINGSPAN, 'held']);
  const kiriHolds = tableHolds().filter((h) => h.booking_id === kiri.id);
  assert.deepEqual(kiriHolds.map((h) => [h.title, h.status]), [['Azul', 'released'], ['Wingspan', 'held']]);
  // and takes it off
  const none = await call('POST', `bookings/${kiri.id}/game`, { productId: null }, KIRI);
  assert.deepEqual([none.data.game, bookingRow(kiri.id).game_product_id], [null, null]);
  assert.ok(tableHolds().filter((h) => h.booking_id === kiri.id).every((h) => h.status === 'released'));
  // staff move Leo's booking's end later: the hold lasts until the new end
  const moved = await call('POST', `bookings/${leo.id}/update`, { end: at('2026-10-24', 22) }, 'staff');
  assert.equal(moved.status, 200, said(moved));
  assert.equal(lair.holdRow(bookingRow(leo.id).game_hold_id).until, at('2026-10-24', 22));
  // moved to a later week (start and end), the hold goes and the game waits for the new window
  lair.sql.exec('UPDATE bookings SET starts_at = ?, ends_at = ? WHERE id = ?', at('2026-10-31', 19), at('2026-10-31', 21), leo.id);
  const oldHold = bookingRow(leo.id).game_hold_id;
  await maintenance();
  assert.deepEqual([lair.holdRow(oldHold).status, bookingRow(leo.id).game_state, bookingRow(leo.id).game_hold_id], ['released', 'waiting', null]);
  setNow(at('2026-10-28', 0, 5));
  await maintenance();
  assert.equal(bookingRow(leo.id).game_state, 'held', 'held again from the new Wednesday');
  // a no-show releases it
  setNow(at('2026-10-31', 20));
  await call('POST', `bookings/${leo.id}/update`, { status: 'noshow' }, 'staff');
  assert.deepEqual([bookingRow(leo.id).game_state, lair.holdRow(bookingRow(leo.id).game_hold_id).status], ['released', 'released']);
});

test('round 17 queue: POST /bookings/:id/game: owner or staff with tables, until it starts (409 started); a guest booking only from staff; 422 game; big boxes say double', async () => {
  const sam = (await book(null)).data.booking;
  assert.equal(sam.game, undefined, 'no game, no game field');
  for (const bad of [{ productId: RPG }, { productId: ATTIC }, { productId: 'catan' }, {}, { productId: undefined }]) {
    assert.equal(said(await call('POST', `bookings/${sam.id}/game`, bad, SAM)), `422 ${QUEUE_MESSAGES.game}`, JSON.stringify(bad));
  }
  assert.equal(said(await book(RPG, KIRI, { tables: ['T6'] })), `422 ${QUEUE_MESSAGES.game}`, 'and when booking');
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE customer_id = ?", KIRI).one().n, 0, 'nothing booked');
  // someone else: 403; a helper without Tables: 403; staff with Tables: fine
  assert.equal((await call('POST', `bookings/${sam.id}/game`, { productId: CATAN }, KIRI)).status, 403);
  assert.equal((await call('POST', `bookings/${sam.id}/game`, { productId: CATAN }, 'helper-desk')).status, 403);
  const byStaff = await call('POST', `bookings/${sam.id}/game`, { productId: GLOOM }, 'helper-tables');
  assert.equal(byStaff.status, 200, said(byStaff));
  assert.deepEqual([byStaff.data.game.title, byStaff.data.game.double], ['Gloomhaven', true], 'in-store-only games can come to a table; a big box says double');
  assert.equal((await call('POST', `bookings/${sam.id}/game`, { productId: CATAN }, SAM)).data.game.productId, CATAN);
  // a guest booking (no account): nobody but staff
  const guest = (await book(AZUL, '', { tables: ['T8'], name: 'Guest Person', email: 'guest@example.com' })).data.booking;
  assert.equal(guest.game.productId, AZUL, 'a guest gets a game when the booking is made');
  assert.equal((await call('POST', `bookings/${guest.id}/game`, { productId: ROOT }, '')).status, 403);
  assert.equal((await call('POST', `bookings/${guest.id}/game`, { productId: ROOT }, 'staff')).status, 200);
  // once it starts: 409
  setNow(SATURDAY.start);
  assert.equal(said(await call('POST', `bookings/${sam.id}/game`, { productId: AZUL }, SAM)), `409 ${QUEUE_MESSAGES.started}`);
  assert.equal(said(await call('POST', `bookings/${sam.id}/game`, { productId: null }, 'staff')), `409 ${QUEUE_MESSAGES.started}`);
  assert.equal((await call('POST', 'bookings/bk_nope/game', { productId: CATAN }, SAM)).status, 404);
});

test('round 17 queue: bookedGamesOverlapping (for the quiz): games on bookings not cancelled whose window overlaps', async () => {
  const sam = (await book(CATAN)).data.booking;
  await book(AZUL, KIRI, { tables: ['T6'], start: at('2026-10-31', 19), end: at('2026-10-31', 21) });
  const leo = (await book(ROOT, LEO, { tables: ['T7'] })).data.booking;
  const ids = (from, to, opts) => [...lair.bookedGamesOverlapping(from, to, opts)].sort();
  // Saturday 24 evening: Catan and Root; the window starts Wednesday 21, so Thursday overlaps too
  assert.deepEqual(ids(at('2026-10-24', 18), at('2026-10-24', 23)), [CATAN, ROOT]);
  assert.deepEqual(ids(at('2026-10-22', 12), at('2026-10-22', 14)), [CATAN, ROOT]);
  // Tuesday 20: before the window
  assert.deepEqual(ids(at('2026-10-20', 12), at('2026-10-20', 23)), []);
  // the next week: Azul's window from Wednesday 28
  assert.deepEqual(ids(at('2026-10-28', 0), at('2026-10-28', 1)), [AZUL]);
  assert.deepEqual(ids(at('2026-10-24', 18), at('2026-10-24', 23), { exceptBookingId: sam.id }), [ROOT], 'the booking door\'s own left out');
  await call('POST', `bookings/${leo.id}/update`, { status: 'cancelled' }, LEO);
  assert.deepEqual(ids(at('2026-10-24', 18), at('2026-10-24', 23)), [CATAN], 'not cancelled ones');
  assert.deepEqual(ids(at('2026-10-24', 23), at('2026-10-24', 18)), [], 'an empty window');
});

/* ---------------- plans, maintenance and the store ---------------- */

test('round 17 queue: a plan change moves the queue on (Grab to Hoard); a plan paused for a payment, or gone, holds nothing; maintenance moves every queue on', async () => {
  // Kiri (Grab: 1) queues three; one is held
  for (const id of [AZUL, ROOT, WINGSPAN]) await add(id, KIRI);
  assert.equal(holdsOf(KIRI).length, 1);
  // her plan becomes Hoard: the membership webhook's answer names the membership, and her queue moves on
  joinLibrary(KIRI, 'hoard');
  lair.queueAfterPlanChange({ updated: `9${KIRI}` });
  assert.deepEqual(holdsOf(KIRI).map((h) => h.title), ['Azul', 'Root', 'Wingspan']);
  // a payment outstanding pauses borrowing: nothing more is held, even by maintenance
  joinLibrary(KIRI, 'hoard', 'past_due');
  await add(CATAN, KIRI);
  const wingspan = holdsOf(KIRI).find((h) => h.title === 'Wingspan');
  await call('POST', `library/holds/${wingspan.id}/update`, { status: 'released' }, 'staff');
  await maintenance();
  assert.deepEqual(holdsOf(KIRI).map((h) => h.title), ['Azul', 'Root']);
  // paid again: maintenance moves it on (Catan; Wingspan, let go by staff, is passed over until she acts)
  joinLibrary(KIRI, 'hoard', 'active');
  const run = await maintenance();
  assert.deepEqual(run.queues, { members: 1, held: 1 });
  assert.deepEqual(holdsOf(KIRI).map((h) => h.title).sort(), ['Azul', 'Catan', 'Root']);
  await restart(KIRI);
  assert.deepEqual(holdsOf(KIRI).map((h) => h.title).sort(), ['Azul', 'Catan', 'Root', 'Wingspan'], 'she acts: it comes back');
  // a member without a plan any more: nothing
  lair.sql.exec("UPDATE memberships SET status = 'ended' WHERE customer_id = ?", SAM);
  await settings({ paused: true });
  lair.sql.exec("INSERT INTO library_queue (id, customer_id, product_id, variant_id, title, position, status, added_at) VALUES ('lq_x', ?, ?, '4003', 'Root', 1, 'queued', ?)", SAM, ROOT, NOW);
  await settings({ paused: false });
  assert.deepEqual(holdsOf(SAM), []);
});

test('round 17 queue: through the store\'s app proxy: GET /me/queue counts as a known route (the status page\'s proxy line)', async () => {
  const seen = [];
  lair.note = (entries) => seen.push(entries);
  const res = await call('GET', 'me/queue', null, SAM, { 'X-Lair-Origin': 'https://lair.test' });
  assert.equal(res.status, 200);
  assert.ok(seen.some((e) => e.proxy?.seen), 'me is a known route');
  seen.length = 0;
  await call('GET', 'queue', null, SAM, { 'X-Lair-Origin': 'https://lair.test' });
  assert.ok(seen.some((e) => e.proxy?.seen) && !seen.some((e) => e.proxyMiss), 'queue is a known route');
  seen.length = 0;
  await call('POST', 'queue', {}, SAM, { 'X-Lair-Origin': 'https://lair.test' });
  assert.ok(seen.some((e) => e.proxy?.seen) && !seen.some((e) => e.proxyMiss));
});

test('round 17 queue: maintenance\'s steps each stand alone: one failing never stops the others or the run', async () => {
  await add(AZUL, KIRI);
  lair.bookingHoldUpkeep = () => {
    throw new Error('boom');
  };
  lair.lapseSends = () => {
    throw new Error('boom');
  };
  const run = await internal('maintenance', {});
  assert.equal(run.status, 200);
  assert.ok('memberships' in run.data, 'the run carried on to the end');
  lair.queueUpkeep = () => {
    throw new Error('boom');
  };
  lair.watchUpkeep = () => {
    throw new Error('boom');
  };
  assert.equal((await internal('maintenance', {})).status, 200);
});

test('round 17 queue: through maintenance across daylight saving: a Wednesday 7 April 2027 booking\'s game is held from Sunday 4 April 00:00 NZDT, not an hour off', async () => {
  setNow(at('2027-04-01', 12));
  const res = await book(CATAN, SAM, { start: at('2027-04-07', 18), end: at('2027-04-07', 20) });
  assert.equal(res.status, 200, said(res));
  assert.equal(new Date(res.data.booking.game.holdFrom).toISOString(), '2027-04-03T11:00:00.000Z');
  setNow(Date.parse('2027-04-03T10:59:00Z'));
  await maintenance();
  assert.deepEqual(tableHolds(), []);
  setNow(Date.parse('2027-04-03T11:00:00Z'));
  await maintenance();
  assert.deepEqual(tableHolds().map((h) => [h.status, h.until]), [['held', at('2027-04-07', 20)]]);
  // and spring: a Wednesday 30 September 2026 booking from Sunday 27 September 00:00 NZST (12pm UTC on the 26th)
  setNow(at('2026-09-20', 12));
  const spring = await book(AZUL, KIRI, { tables: ['T9'], start: at('2026-09-30', 18), end: at('2026-09-30', 20) });
  assert.equal(new Date(spring.data.booking.game.holdFrom).toISOString(), '2026-09-26T12:00:00.000Z');
  setNow(Date.parse('2026-09-26T11:59:00Z'));
  await maintenance();
  assert.equal(bookingRow(spring.data.booking.id).game_state, 'waiting');
  setNow(Date.parse('2026-09-26T12:00:00Z'));
  await maintenance();
  assert.equal(bookingRow(spring.data.booking.id).game_state, 'held');
});

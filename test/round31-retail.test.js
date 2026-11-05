// Round 31, retail and shopping (contract v31-retail): the wishlist by option and its back-on-the-shelf emails, pickups to
// pull, and Open a display. From the plan "Retail and shopping: plan" and Mo's picks of 6 Nov 2026 (the canvas "Retail
// and shopping: mockups"). Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { WISH_WORDS, OTHERS_WAIT, wishLabel } from '../src/wish-alerts.js';
import { PICKUP_WORDS } from '../src/pickups.js';
import { DISPLAY_WORDS } from '../src/displays.js';
import { UNSUBSCRIBE_WORDS } from '../src/first-game.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const MIN = 60_000;
const DAY = 24 * HOUR;
// Friday 6 November 2026, 7:42pm in Auckland (NZDT, UTC+13): the shop's open until midnight
const NOW = Date.UTC(2026, 10, 6, 6, 42);
const realNow = Date.now;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const nowIs = (ms) => {
  Date.now = () => ms;
};

function fakeCtx() {
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
  return { db, storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: () => {} };
}

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];
const OWNER = '9001';
const MIA = '6001';
const KAI = '6002';
const RIA = '6003';
const ENV = {
  CURRENCY: 'NZD', RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <lair@dicegoblin.test>', STAFF_EMAIL: 'shop@example.com',
  GW_LOCATION_ID: '72250359911', PUBLIC_URL: 'https://lair.test',
};
// a starter deck with two options, a booster with box and pack, and a dice set the supplier sends
const DECK = '8100000000001';
const HEIST = '4700000000011';
const POWER = '4700000000012';
const RADIANCE = '8100000000002';
const BOX = '4700000000021';
const PACK = '4700000000022';
const DICE = '8100000000003';
const DICE_V = '4700000000031';

let lair;
let stock;
let calls;
let mails;
let alerts;
let marketing;
let pickupOrders;
let orderStates;
let readyAnswer;
let displayProducts;
const realFetch = globalThis.fetch;
let reached = [];

async function call(method, path, body, customer = '', extraHeaders = {}) {
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders },
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}
const ok = (res) => {
  assert.equal(res.status, 200, res.data?.error);
  return res.data;
};
const said = (res) => `${res.status} ${res.data?.error || ''}`.trim();

/** One variant as the stock check reads it from Shopify */
const variant = (productId, variantId, { shelf = 0, sellable = shelf > 0, supplier = false, sold = true, price = 5500, title = 'Cyberpunk TCG - Starter Deck', option = '', handle = 'cyberpunk-tcg-starter-deck', options = 2 } = {}) => ({
  variantId, productId, shelf, sellable, supplier, sold, price, title, variantTitle: option, handle, image: `https://cdn.example.com/${variantId}.jpg`, options,
});

const fakeRetail = () => ({
  async variantStock(ids) {
    calls.push(['variantStock', [...ids]]);
    return ids.map((id) => stock.get(String(id))).filter(Boolean);
  },
  async productStock(ids) {
    calls.push(['productStock', [...ids]]);
    return [...stock.values()].filter((v) => ids.includes(v.productId));
  },
  async pickupOrders(since, { orderId = null } = {}) {
    calls.push(['pickupOrders', orderId]);
    return pickupOrders.filter((o) => !orderId || o.orderId === orderId);
  },
  async ordersState(ids) {
    calls.push(['ordersState', [...ids]]);
    return new Map(ids.filter((id) => orderStates.has(id)).map((id) => [id, orderStates.get(id)]));
  },
  async markReady(orderId) {
    calls.push(['markReady', orderId]);
    if (readyAnswer instanceof Error) throw readyAnswer;
    return readyAnswer;
  },
  async setShelf(changes, locationId, key, reference) {
    calls.push(['setShelf', changes, locationId, key, reference]);
    return { ok: true };
  },
  async displayProducts(words, locationId) {
    calls.push(['displayProducts', words, locationId]);
    return displayProducts.filter((p) => p.title.toLowerCase().includes(words.toLowerCase()));
  },
  async displayProduct(productId) {
    calls.push(['displayProduct', productId]);
    return displayProducts.find((p) => p.productId === productId) || null;
  },
  async adjustShelf(changes, locationId, key, reference) {
    calls.push(['adjustShelf', changes, locationId, key, reference]);
    for (const c of changes) {
      for (const p of displayProducts) for (const v of p.variants) if (v.inventoryItemId === c.inventoryItemId) v.shelf += c.delta;
    }
    return { ok: true };
  },
});

beforeEach(async () => {
  reached = [];
  calls = [];
  mails = [];
  alerts = [];
  marketing = new Map();
  stock = new Map();
  pickupOrders = [];
  orderStates = new Map();
  readyAnswer = { ok: true };
  displayProducts = [];
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  lair = new Lair(fakeCtx(), { ...ENV });
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.customerEmail = async () => null;
  lair.shopify.marketingByEmail = async (email) => marketing.get(email) ?? null;
  lair.shopify.unsubscribeMarketing = async () => true;
  lair.retail = fakeRetail;
  lair.mail = async (message) => {
    mails.push(message);
    return { ok: true };
  };
  lair.mailMany = async (messages) => {
    mails.push(...messages);
    return { ok: true, sent: messages.length };
  };
  lair.notifyStaff = (subject, content) => alerts.push({ subject, intro: content.intro, details: content.details });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  lair.regularIdsAt = () => new Set([MIA]);
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  for (const [id, name] of [[MIA, 'Mia Chen'], [KAI, 'Kai Tane'], [RIA, 'Ria Moana']]) {
    lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
  }
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 5));
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

const run = async (ms) => {
  nowIs(ms);
  return lair.retailUpkeep(lair.rulesCache, ms);
};
const wish = (who, body) => call('POST', 'me/wishlist', body, who);

/* ---------------- the words ---------------- */

test('round 31: the words, word for word', () => {
  assert.equal(WISH_WORDS.subject('The Heist'), 'The Heist is back on the shelf');
  assert.equal(WISH_WORDS.subject('Cyberpunk TCG - Welcome to Night City - Booster'), 'Back on the shelf: Cyberpunk TCG - Welcome to…');
  assert.ok(WISH_WORDS.subject('Cyberpunk TCG - Welcome to Night City - Booster').length <= 50);
  assert.equal(WISH_WORDS.preheader('Cyberpunk TCG - Starter Deck', '$55.00', true), "Cyberpunk TCG - Starter Deck, $55.00. You're hearing a day before everyone else.");
  assert.equal(WISH_WORDS.preheader('Cyberpunk TCG - Starter Deck', '$55.00', false), 'Cyberpunk TCG - Starter Deck, $55.00. On the shelf at the Lair now.');
  assert.equal(WISH_WORDS.intro(false), "You asked Gobgob to keep an eye out. It's back on the shelf at the Lair.");
  assert.equal(WISH_WORDS.intro(true), 'You asked Gobgob to keep an eye out. These are back on the shelf at the Lair.');
  assert.equal(WISH_WORDS.regular, "You're a regular, so you're hearing first. Everyone else hears tomorrow.");
  assert.equal(WISH_WORDS.why('The Heist'), "You're getting this because The Heist is on your wishlist.");
  assert.equal(WISH_WORDS.unsubscribe, "Don't send me emails like this");
  // the option's name, unless it only says the pack size, or the product has one option
  assert.equal(wishLabel({ title: 'Cyberpunk TCG - Starter Deck', variant_title: 'The Heist', options: 2 }), 'The Heist');
  assert.equal(wishLabel({ title: 'Riftbound Radiance', variant_title: 'Booster Box', options: 5 }), 'Riftbound Radiance');
  assert.equal(wishLabel({ title: 'Blossom Sky Dice Set', variant_title: '', options: 1 }), 'Blossom Sky Dice Set');
  assert.equal(PICKUP_WORDS.staffSubject('#2031', 'Riftbound Radiance: Booster Box'), 'Pickup #2031 to pull: Riftbound Radiance: Booster Box');
  assert.equal(PICKUP_WORDS.remindSubject('#2031', false), 'Your order #2031 is waiting at the Lair');
  assert.equal(PICKUP_WORDS.remindSubject('#2031', true), 'Last reminder: your order #2031 is at the Lair');
  assert.equal(PICKUP_WORDS.missingSubject('#2031', true), "Sorry, your order #2031 isn't here");
  assert.equal(PICKUP_WORDS.missingSubject('#2031', false), "Sorry, part of your order #2031 isn't here");
  assert.equal(DISPLAY_WORDS.noBox(0), 'Shopify has 0 of that box on the shelf. Count them, then fix the count in Shopify first.');
  assert.equal(DISPLAY_WORDS.pick, "Pick the box you're opening and the packs it holds.");
});

/* ---------------- the wishlist by option ---------------- */

test('wishlist (round 31): a member keeps the exact option, several options of one product, and takes one off or all', async () => {
  const one = ok(await wish(MIA, { productId: DECK, variantId: `gid://shopify/ProductVariant/${HEIST}`, handle: 'cyberpunk-tcg-starter-deck', title: 'Cyberpunk TCG - Starter Deck', variantTitle: 'The Heist' }));
  assert.equal(one.added, true);
  assert.deepEqual(one.alerts, { on: true });
  assert.deepEqual(one.items.map((i) => [i.productId, i.variantId, i.variantTitle]), [[DECK, HEIST, 'The Heist']]);
  nowIs(NOW + MIN);
  const two = ok(await wish(MIA, { productId: DECK, variantId: Number(POWER), title: 'Cyberpunk TCG - Starter Deck', variantTitle: 'Embracing Power' }));
  assert.deepEqual(two.items.map((i) => i.variantId), [POWER, HEIST], 'newest first');
  // the same option again keeps its place
  const again = ok(await wish(MIA, { productId: DECK, variantId: HEIST }));
  assert.deepEqual([again.added, again.items.length], [false, 2]);
  // "Default Title" is a product with one option: no option name
  const dice = ok(await wish(MIA, { productId: DICE, variantId: DICE_V, title: 'Blossom Sky Dice Set', variantTitle: 'Default Title' }));
  assert.equal(dice.items[0].variantTitle, '');
  // a wrong option is a 422 with its words, and nothing is written
  assert.equal(said(await wish(MIA, { productId: DECK, variantId: 'gid://shopify/Product/1' })), "422 That option doesn't look right. Refresh the page and try again.");
  // one option off, then the rest of the product
  const off = ok(await call('POST', 'me/wishlist/remove', { productId: DECK, variantId: HEIST }, MIA));
  assert.deepEqual([off.removed, off.items.map((i) => i.variantId)], [true, [DICE_V, POWER]]);
  const all = ok(await call('POST', 'me/wishlist/remove', { productId: DECK }, MIA));
  assert.deepEqual([all.removed, all.items.map((i) => i.productId)], [true, [DICE]]);
  // any option (round 16's way) still works
  const any = ok(await wish(KAI, { productId: DECK }));
  assert.deepEqual(any.items.map((i) => [i.productId, i.variantId]), [[DECK, null]]);
});

test('wishlist (round 31): a store from before keeps every entry, as any option, when the table moves onto the new key', async () => {
  const ctx = fakeCtx();
  // round 16's table, with an entry in it
  ctx.db.exec(`CREATE TABLE wishlist (customer_id TEXT NOT NULL, product_id TEXT NOT NULL, handle TEXT, title TEXT, created_at INTEGER NOT NULL,
    PRIMARY KEY (customer_id, product_id))`);
  ctx.db.prepare('INSERT INTO wishlist VALUES (?, ?, ?, ?, ?)').run(MIA, DECK, 'cyberpunk-tcg-starter-deck', 'Cyberpunk TCG - Starter Deck', NOW - DAY);
  lair = new Lair(ctx, { ...ENV });
  lair.taggedPerson = async (id) => ({ customerId: id || null, staff: false, gm: false, tags: [] });
  const items = ok(await call('GET', 'me/wishlist', null, MIA)).items;
  assert.deepEqual(items.map((i) => [i.productId, i.variantId, i.title, i.addedAt]), [[DECK, null, 'Cyberpunk TCG - Starter Deck', NOW - DAY]]);
  // and a restart keeps them
  lair = new Lair(ctx, { ...ENV });
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM wishlist').one().n, 1);
});

test('wishlist (round 31): "Email me when these come back" is on until a member switches it off', async () => {
  assert.deepEqual(ok(await call('GET', 'me/wishlist', null, MIA)).alerts, { on: true });
  assert.deepEqual(ok(await call('POST', 'me/wishlist/alerts', { on: false }, MIA)), { ok: true, alerts: { on: false } });
  assert.deepEqual(ok(await call('GET', 'me/wishlist', null, MIA)).alerts, { on: false });
  assert.deepEqual(ok(await call('GET', 'me/wishlist', null, KAI)).alerts, { on: true }, 'only their own');
  assert.equal(said(await call('POST', 'me/wishlist/alerts', { on: 'yes' }, MIA)), '422 Say whether to email you: on or off.');
  assert.equal((await call('POST', 'me/wishlist/alerts', { on: true }, '')).status, 401);
});

/* ---------------- back on the shelf ---------------- */

test('back on the shelf: the first read only records it; a regular hears straight away, everyone else a day later, once each time it comes back', async () => {
  stock.set(HEIST, variant(DECK, HEIST, { shelf: 0, option: 'The Heist' }));
  stock.set(POWER, variant(DECK, POWER, { shelf: 0, option: 'Embracing Power' }));
  ok(await wish(MIA, { productId: DECK, variantId: HEIST, variantTitle: 'The Heist' }));
  ok(await wish(KAI, { productId: DECK }));
  // the first read: what it is now, no email
  await run(NOW + 10 * MIN);
  assert.deepEqual(mails, []);
  const before = ok(await call('GET', 'me/wishlist', null, MIA)).items[0];
  assert.deepEqual([before.status, before.shelf, before.price, before.url], ['out', 0, 5500, `/products/cyberpunk-tcg-starter-deck?variant=${HEIST}`]);

  // The Heist comes in: Mia's a regular and hears now; Kai (any option) waits a day
  stock.set(HEIST, variant(DECK, HEIST, { shelf: 2, option: 'The Heist' }));
  const result = await run(NOW + 20 * MIN);
  assert.deepEqual([result.back, result.queued, result.wishEmails], [1, 2, { sent: 1, skipped: 0 }]);
  assert.deepEqual(mails.map((m) => [m.to, m.subject]), [['mia@example.com', 'The Heist is back on the shelf']]);
  const m = mails[0];
  assert.ok(m.html.includes('The Heist is back'));
  assert.ok(m.text.includes("You asked Gobgob to keep an eye out. It's back on the shelf at the Lair."));
  assert.ok(m.text.includes('Cyberpunk TCG - Starter Deck: The Heist'));
  assert.ok(m.text.includes('$55.00 · Only 2 left at the Lair'), 'true when it goes: 2 left');
  assert.ok(m.text.includes(WISH_WORDS.regular));
  assert.ok(m.html.includes('hearing a day before everyone else.'), 'the preview line');
  assert.ok(m.text.includes(`Buy it online: https://www.dicegoblin.nz/products/cyberpunk-tcg-starter-deck?variant=${HEIST}&utm_source=back-in-stock&utm_medium=email&utm_campaign=shop`));
  assert.ok(m.text.includes('Collect it free at the Lair, or have it delivered for $10.'));
  assert.ok(m.text.includes('4pm to midnight'), "today's hours");
  assert.ok(m.text.includes("You're getting this because The Heist is on your wishlist."));
  const alert = lair.sql.exec('SELECT * FROM wish_alerts WHERE customer_id = ?', MIA).one();
  assert.ok(m.text.includes(`Don't send me emails like this: https://www.dicegoblin.nz/pages/my-lair#unsubscribe=WISH-${alert.id}.${alert.key}`));
  assert.equal(m.headers['List-Unsubscribe'], `<https://lair.test/unsubscribe/WISH-${alert.id}/${alert.key}>`);
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal(ok(await call('GET', 'me/wishlist', null, MIA)).items[0].toldAt, NOW + 20 * MIN);

  // the next runs that day: nothing more (one email each time it comes back)
  await run(NOW + 30 * MIN);
  assert.equal(mails.length, 1);
  // a day later Kai hears, without the regular's line
  await run(NOW + 20 * MIN + OTHERS_WAIT);
  assert.deepEqual(mails.map((x) => x.to), ['mia@example.com', 'kai@example.com']);
  assert.ok(!mails[1].text.includes(WISH_WORDS.regular));
  assert.ok(mails[1].html.includes('On the shelf at the Lair now.'));

  // it sells out, then comes back again: they hear again
  stock.set(HEIST, variant(DECK, HEIST, { shelf: 0, option: 'The Heist' }));
  await run(NOW + 2 * DAY);
  stock.set(HEIST, variant(DECK, HEIST, { shelf: 6, option: 'The Heist' }));
  await run(NOW + 2 * DAY + 10 * MIN);
  assert.deepEqual(mails.map((x) => x.to), ['mia@example.com', 'kai@example.com', 'mia@example.com']);
  assert.ok(mails[2].text.includes('$55.00 · On the shelf at the Lair'), 'more than 3: no count');
});

test('back on the shelf: everyone else waits, and if it sells out again first they wait for next time; never a "sold out again" email', async () => {
  stock.set(HEIST, variant(DECK, HEIST, { shelf: 0, option: 'The Heist' }));
  ok(await wish(KAI, { productId: DECK, variantId: HEIST }));
  await run(NOW + 10 * MIN);
  stock.set(HEIST, variant(DECK, HEIST, { shelf: 1, option: 'The Heist' }));
  await run(NOW + 20 * MIN);
  stock.set(HEIST, variant(DECK, HEIST, { shelf: 0, option: 'The Heist' }));
  await run(NOW + 6 * HOUR);
  await run(NOW + 20 * MIN + OTHERS_WAIT);
  assert.deepEqual(mails, []);
  assert.equal(lair.sql.exec('SELECT skipped FROM wish_alerts WHERE customer_id = ?', KAI).one().skipped, 'sold-out');
});

test('back on the shelf: nobody who unsubscribed after wishing, switched it off, or wished after it came back; an unsubscribe before the wish is no bar', async () => {
  for (const [v, title] of [[HEIST, 'The Heist'], [POWER, 'Embracing Power']]) stock.set(v, variant(DECK, v, { shelf: 0, option: title }));
  ok(await wish(MIA, { productId: DECK, variantId: HEIST }));
  ok(await wish(KAI, { productId: DECK, variantId: HEIST }));
  ok(await wish(RIA, { productId: DECK, variantId: HEIST }));
  await run(NOW + 10 * MIN);
  // Mia used a "Don't send me emails like this" afterwards; Kai unsubscribed in Shopify afterwards; Ria had unsubscribed
  // in Shopify a week before she wished (the wish is fresh consent to this one alert)
  lair.write('INSERT INTO followup_stops (email, at, ref, via) VALUES (?, ?, ?, ?)', 'mia@example.com', NOW + 5 * MIN, 'SJ-OWLBEAR-17', 'link');
  marketing.set('kai@example.com', { customerId: KAI, state: 'UNSUBSCRIBED', at: NOW + 5 * MIN });
  marketing.set('ria@example.com', { customerId: RIA, state: 'UNSUBSCRIBED', at: NOW - 7 * DAY });
  lair.regularIdsAt = () => new Set([MIA, KAI, RIA]);
  stock.set(HEIST, variant(DECK, HEIST, { shelf: 3, option: 'The Heist' }));
  await run(NOW + 20 * MIN);
  assert.deepEqual(mails.map((m) => m.to), ['ria@example.com']);
  const skipped = Object.fromEntries(lair.sql.exec('SELECT customer_id, skipped FROM wish_alerts').toArray().map((r) => [r.customer_id, r.skipped]));
  assert.deepEqual(skipped, { [MIA]: 'stopped', [KAI]: 'shopify', [RIA]: null });

  // switched off in My Lair: recorded as skipped, no email; and an entry made after it came back waits for next time
  mails = [];
  ok(await call('POST', 'me/wishlist/alerts', { on: false }, RIA));
  stock.set(POWER, variant(DECK, POWER, { shelf: 0, option: 'Embracing Power' }));
  ok(await wish(RIA, { productId: DECK, variantId: POWER }));
  await run(NOW + 30 * MIN);
  stock.set(POWER, variant(DECK, POWER, { shelf: 4, option: 'Embracing Power' }));
  await run(NOW + 40 * MIN);
  assert.deepEqual(mails, []);
  assert.equal(lair.sql.exec('SELECT skipped FROM wish_alerts WHERE customer_id = ? AND variants LIKE ?', RIA, `%${POWER}%`).one().skipped, 'off');
});

test('back on the shelf: overnight it waits for 9am; a product no longer sold online is never emailed about', async () => {
  stock.set(HEIST, variant(DECK, HEIST, { shelf: 0, option: 'The Heist' }));
  ok(await wish(MIA, { productId: DECK, variantId: HEIST }));
  await run(NOW + 10 * MIN);
  // back at 11pm Friday: Mia (a regular) hears at 9am Saturday
  stock.set(HEIST, variant(DECK, HEIST, { shelf: 2, option: 'The Heist' }));
  await run(at('2026-11-06', 23));
  assert.deepEqual(mails, []);
  await run(at('2026-11-07', 8, 50));
  assert.deepEqual(mails, []);
  await run(at('2026-11-07', 9));
  assert.deepEqual(mails.map((m) => m.to), ['mia@example.com']);

  // a product taken off the online store isn't emailed about
  mails = [];
  stock.set(POWER, variant(DECK, POWER, { shelf: 0, option: 'Embracing Power' }));
  ok(await wish(KAI, { productId: DECK, variantId: POWER }));
  await run(at('2026-11-07', 10));
  lair.regularIdsAt = () => new Set([KAI]);
  stock.set(POWER, variant(DECK, POWER, { shelf: 2, option: 'Embracing Power', sold: false }));
  await run(at('2026-11-07', 11));
  assert.deepEqual(mails, [], 'not sold online: not on the shelf as far as the website goes');
  assert.equal(ok(await call('GET', 'me/wishlist', null, KAI)).items[0].status, 'gone');
});

test('the wishlist says what the last check found: on the shelf, sold out, delivered in about 10 days, or not checked yet', async () => {
  stock.set(BOX, variant(RADIANCE, BOX, { shelf: 25, price: 24000, title: 'Riftbound Radiance', option: 'Booster Box', handle: 'riftbound-radiance', options: 5 }));
  stock.set(DICE_V, variant(DICE, DICE_V, { shelf: 0, sellable: true, supplier: true, price: 9000, title: 'Blossom Sky Dice Set', handle: 'blossom-sky-dice-set', options: 1 }));
  ok(await wish(MIA, { productId: RADIANCE, variantId: BOX }));
  ok(await wish(MIA, { productId: DICE, variantId: DICE_V }));
  ok(await wish(MIA, { productId: DECK, variantId: HEIST }));
  await run(NOW + 10 * MIN);
  const items = ok(await call('GET', 'me/wishlist', null, MIA)).items;
  assert.deepEqual(items.map((i) => [i.productId, i.status, i.shelf, i.supplier, i.price]), [
    [DECK, null, null, false, null],
    [DICE, 'away', 0, true, 9000],
    [RADIANCE, 'shelf', 25, false, 24000],
  ]);
});

test('back on the shelf: the email\'s "Don\'t send me emails like this" stops all news emails and these, from the link or the mail app', async () => {
  stock.set(HEIST, variant(DECK, HEIST, { shelf: 0, option: 'The Heist' }));
  ok(await wish(MIA, { productId: DECK, variantId: HEIST }));
  await run(NOW + 10 * MIN);
  stock.set(HEIST, variant(DECK, HEIST, { shelf: 2, option: 'The Heist' }));
  await run(NOW + 20 * MIN);
  const a = lair.sql.exec('SELECT * FROM wish_alerts WHERE customer_id = ?', MIA).one();
  const ref = `WISH-${a.id}`;
  // seeing what it is stops nothing
  assert.deepEqual(ok(await call('POST', 'unsubscribe/view', { ref, key: a.key })), { link: { stopped: false } });
  assert.equal(said(await call('POST', 'unsubscribe/view', { ref, key: 'f'.repeat(32) })), `404 ${UNSUBSCRIBE_WORDS.wrong}`);
  // the tap: the stop list (Shopify hears from it, as round 29) and their wishlist emails off
  assert.deepEqual(ok(await call('POST', 'unsubscribe/stop', { ref, key: a.key })), { ok: true, already: false });
  assert.deepEqual(lair.sql.exec('SELECT email, ref, via FROM followup_stops').toArray().map((r) => ({ ...r })), [{ email: 'mia@example.com', ref, via: 'link' }]);
  assert.deepEqual(ok(await call('GET', 'me/wishlist', null, MIA)).alerts, { on: false });
  assert.deepEqual(ok(await call('POST', 'unsubscribe/view', { ref, key: a.key })), { link: { stopped: true } });
  // the mail app's one-click, on the Lair's own address
  const oneClick = await lair.fetch(new Request('https://lair.test/internal/unsubscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body: JSON.stringify({ ref, key: a.key, stop: true }),
  }));
  assert.deepEqual([oneClick.status, await oneClick.text()], [200, UNSUBSCRIBE_WORDS.done]);
});

test('regulars, as Monday\'s numbers count them: visits in 2 different weeks of the last 4', () => {
  delete lair.regularIdsAt;
  const rules = lair.rulesCache;
  const monday = '2026-11-02';
  lair.visitorsByWeek = (from, until, weekOf) => {
    const weeks = new Map();
    for (const [id, ms] of [[MIA, at(monday, 18)], [MIA, at('2026-10-26', 18)], [KAI, at(monday, 18)], [KAI, at('2026-11-03', 18)], [RIA, at('2026-10-05', 18)], [RIA, at(monday, 19)]]) {
      const w = weekOf(ms);
      if (!w) continue;
      if (!weeks.has(w)) weeks.set(w, new Set());
      weeks.get(w).add(id);
    }
    return weeks;
  };
  // Mia: this week and last; Kai: twice this week (one week); Ria: 5 weeks ago (outside) and this week
  assert.deepEqual([...lair.regularIdsAt(rules, NOW)], [MIA]);
});

/* ---------------- pickups ---------------- */

const order = (id, name, lines, extra = {}) => ({
  orderId: id, name, paidAt: NOW, cancelled: false, financial: 'PAID', fulfilment: 'UNFULFILLED', online: true,
  customerId: KAI, firstName: 'Sam', lastName: 'kirk', email: 'sam@example.com', lines, ...extra,
});
const boxLine = { lineId: '9001', variantId: BOX, productId: RADIANCE, title: 'Riftbound Radiance', variantTitle: 'Booster Box', quantity: 1, price: 24000 };
const packLine = { lineId: '9002', variantId: PACK, productId: RADIANCE, title: 'Riftbound Radiance', variantTitle: 'Booster Pack', quantity: 3, price: 1100 };

test('pickups: 2 hours of opening time, from paid; at 11:30pm on a Friday that\'s 11am Saturday', () => {
  const rules = lair.rulesCache;
  assert.equal(lair.openMinutesAfter(rules, NOW, 120), NOW + 2 * HOUR);
  assert.equal(lair.openMinutesAfter(rules, at('2026-11-06', 23, 30), 120), at('2026-11-07', 11, 30));
  // paid Saturday morning before opening: 2 hours after 10am
  assert.equal(lair.openMinutesAfter(rules, at('2026-11-07', 7), 120), at('2026-11-07', 12));
  // a Sunday night after 10pm close: Monday 4pm + 2 hours
  assert.equal(lair.openMinutesAfter(rules, at('2026-11-08', 22, 30), 120), at('2026-11-09', 18));
});

test('pickups: a paid online order collected at the Lair goes on To pull, the shop gets one email, and staff mark it ready', async () => {
  pickupOrders = [order('5001', '#2031', [boxLine])];
  assert.equal(await lair.pickupFromPaid('gid://shopify/Order/5001'), 1);
  assert.equal(await lair.pickupFromPaid('gid://shopify/Order/5001'), 0, 'once');
  assert.deepEqual(alerts.map((a) => a.subject), ['Pickup #2031 to pull: Riftbound Radiance: Booster Box']);
  assert.equal(alerts[0].intro, "Sam K. paid online and collects at the counter. Pull it, put it behind the counter and tap Ready to collect on the staff page. Promised by 9:42pm.");
  // staff with Check-in see it; a customer doesn't
  const list = ok(await call('GET', 'staff/pull', null, OWNER));
  assert.equal(list.newest, NOW);
  assert.deepEqual(list.pickups.map((p) => [p.name, p.customer, p.status, p.dueAt, p.items.map((i) => i.title + ': ' + i.variantTitle)]), [
    ['#2031', 'Sam K.', 'new', NOW + 2 * HOUR, ['Riftbound Radiance: Booster Box']],
  ]);
  assert.equal((await call('GET', 'staff/pull', null, MIA)).status, 403);
  // Ready to collect: Shopify marks it (and sends its own email)
  const ready = ok(await call('POST', 'staff/pull/ready', { orderId: '5001' }, OWNER));
  assert.deepEqual([ready.pickup.status, ready.pickup.readyAt], ['ready', NOW]);
  assert.deepEqual(calls.filter((c) => c[0] === 'markReady'), [['markReady', '5001']]);
  assert.equal(said(await call('POST', 'staff/pull/ready', { orderId: '5001' }, OWNER)), `409 ${PICKUP_WORDS.notNew}`);
  assert.equal(said(await call('POST', 'staff/pull/ready', { orderId: '5999' }, OWNER)), `404 ${PICKUP_WORDS.notFound}`);
});

test('pickups: until the new permission is approved, Ready to collect says so, and nothing changes', async () => {
  pickupOrders = [order('5001', '#2031', [boxLine])];
  await lair.pickupFromPaid('5001');
  readyAnswer = new Error('Access denied for fulfillmentOrders field. Required access: `read_merchant_managed_fulfillment_orders`');
  assert.equal(said(await call('POST', 'staff/pull/ready', { orderId: '5001' }, OWNER)), `503 ${PICKUP_WORDS.noPermission}`);
  assert.equal(ok(await call('GET', 'staff/pull', null, OWNER)).pickups[0].status, 'new');
});

test('pickups: reminders 3 and 10 days after Ready, Refund due at 14 days, and off the list once Shopify shows it collected', async () => {
  pickupOrders = [order('5001', '#2031', [boxLine])];
  await lair.pickupFromPaid('5001');
  ok(await call('POST', 'staff/pull/ready', { orderId: '5001' }, OWNER));
  alerts = [];
  await run(NOW + 2 * DAY);
  assert.deepEqual(mails, []);
  await run(at('2026-11-09', 21, 30));
  assert.deepEqual(mails, [], 'day 3 at 9:30pm: the morning');
  await run(at('2026-11-10', 9, 5));
  assert.deepEqual(mails.map((m) => [m.to, m.subject]), [['sam@example.com', 'Your order #2031 is waiting at the Lair']]);
  assert.ok(mails[0].text.includes("Gobgob is guarding your order behind the counter. Come and grab it whenever we're open."));
  assert.ok(mails[0].text.includes("Friday 20 November, then it's refunded to your card"));
  await run(at('2026-11-12', 10));
  assert.equal(mails.length, 1);
  await run(at('2026-11-16', 20));
  assert.deepEqual(mails.map((m) => m.subject), ['Your order #2031 is waiting at the Lair', 'Last reminder: your order #2031 is at the Lair']);
  await run(at('2026-11-20', 20));
  assert.deepEqual(alerts.map((a) => a.subject), ["Refund due: pickup #2031 wasn't collected"]);
  assert.equal(ok(await call('GET', 'staff/pull', null, OWNER)).pickups[0].refundDue, true);
  // collected after all (staff marked it picked up in Shopify): off the list
  orderStates.set('5001', { fulfilment: 'FULFILLED', cancelled: false });
  await run(at('2026-11-20', 20, 10));
  assert.deepEqual(ok(await call('GET', 'staff/pull', null, OWNER)).pickups, []);
  assert.equal(lair.sql.exec('SELECT closed_how FROM pickups').one().closed_how, 'collected');
});

test('pickups: Not on the shelf tells the customer it\'s being refunded, sets the Lair\'s count to 0, and shows Refund due until Done', async () => {
  pickupOrders = [order('5002', '#2032', [boxLine, packLine], { firstName: 'Ria', lastName: '' })];
  await lair.pickupFromPaid('5002');
  // part of it: the box
  const part = ok(await call('POST', 'staff/pull/missing', { orderId: '5002', lineIds: ['9001'] }, OWNER));
  assert.deepEqual([part.pickup.status, part.pickup.missing, part.pickup.refundDue], ['missing', ['9001'], true]);
  assert.deepEqual(calls.filter((c) => c[0] === 'setShelf').map((c) => [c[1], c[2], c[4]]), [[[{ variantId: BOX, quantity: 0 }], '72250359911', 'logistics://dicegoblin.nz/pickup/5002']]);
  assert.deepEqual(mails.map((m) => [m.to, m.subject]), [['sam@example.com', "Sorry, part of your order #2032 isn't here"]]);
  assert.ok(mails[0].text.includes("We went to pull your order and Riftbound Radiance: Booster Box wasn't on the shelf. Our count was wrong, and that's on us."));
  assert.ok(mails[0].text.includes("We're refunding $240.00 to your card. Shopify emails you when it's done."));
  assert.ok(mails[0].text.includes('The rest of your order is still ready to collect.'));
  // refunded in Shopify, Done: the packs are still to collect
  ok(await call('POST', 'staff/pull/done', { orderId: '5002' }, OWNER));
  const left = ok(await call('GET', 'staff/pull', null, OWNER)).pickups[0];
  assert.deepEqual([left.status, left.items.map((i) => i.lineId), left.missing], ['new', ['9002'], []]);
  // all of it this time
  ok(await call('POST', 'staff/pull/missing', { orderId: '5002' }, OWNER));
  assert.equal(mails[1].subject, "Sorry, your order #2032 isn't here");
  assert.ok(mails[1].text.includes("We're refunding $33.00 to your card."));
  ok(await call('POST', 'staff/pull/done', { orderId: '5002' }, OWNER));
  assert.deepEqual(ok(await call('GET', 'staff/pull', null, OWNER)).pickups, []);
  assert.equal(said(await call('POST', 'staff/pull/missing', { orderId: '5002', lineIds: ['1'] }, OWNER)), `404 ${PICKUP_WORDS.notFound}`);
});

test('pickups: the 10-minute look adds any the webhook missed, and leaves orders that aren\'t paid, online or still to collect', async () => {
  pickupOrders = [
    order('5003', '#2033', [boxLine]),
    order('5004', '#2034', [boxLine], { online: false }),
    order('5005', '#2035', [boxLine], { financial: 'PENDING' }),
    order('5006', '#2036', [boxLine], { cancelled: true }),
    order('5007', '#2037', [boxLine], { fulfilment: 'FULFILLED' }),
  ];
  const result = await run(NOW + 10 * MIN);
  assert.deepEqual(result.pickups, { added: 1, closed: 0 });
  assert.deepEqual(ok(await call('GET', 'staff/pull', null, OWNER)).pickups.map((p) => p.name), ['#2033']);
  // cancelled in Shopify later: off the list
  orderStates.set('5003', { fulfilment: 'UNFULFILLED', cancelled: true });
  await run(NOW + 20 * MIN);
  assert.deepEqual(ok(await call('GET', 'staff/pull', null, OWNER)).pickups, []);
});

/* ---------------- Open a display ---------------- */

const NIGHT_CITY = '8100000000009';
const NC_BOX = '4700000000091';
const NC_PACK = '4700000000092';
const nightCity = () => ({
  productId: NIGHT_CITY, title: 'Cyberpunk TCG - Welcome to Night City - Booster',
  variants: [
    { variantId: NC_BOX, title: 'Booster Box', shelf: 45, inventoryItemId: 'gid://shopify/InventoryItem/91' },
    { variantId: NC_PACK, title: 'Booster Pack', shelf: 25, inventoryItemId: 'gid://shopify/InventoryItem/92' },
  ],
});

test('Open a display: the box comes off and its packs go on in one change, once per tap; the packs in a box are remembered', async () => {
  displayProducts = [nightCity()];
  const found = ok(await call('GET', 'staff/displays?q=Night City', null, OWNER));
  assert.deepEqual(found.products.map((p) => [p.title, p.variants.map((v) => [v.title, v.shelf]), p.remembered]), [
    ['Cyberpunk TCG - Welcome to Night City - Booster', [['Booster Box', 45], ['Booster Pack', 25]], null],
  ]);
  const body = { productId: NIGHT_CITY, boxVariantId: NC_BOX, packVariantId: NC_PACK, boxes: 1, packs: 36, key: 'open-tap-0001' };
  const opened = ok(await call('POST', 'staff/displays/open', body, OWNER));
  assert.deepEqual([opened.open.box, opened.open.pack, opened.open.canUndo], [{ before: 45, after: 44 }, { before: 25, after: 61 }, true]);
  const adjusts = calls.filter((c) => c[0] === 'adjustShelf');
  assert.deepEqual(adjusts.map((c) => [c[1], c[2], c[3]]), [[
    [{ inventoryItemId: 'gid://shopify/InventoryItem/91', delta: -1 }, { inventoryItemId: 'gid://shopify/InventoryItem/92', delta: 36 }], '72250359911', 'open-display-open-tap-0001',
  ]]);
  // the same tap again (an answer lost on the way): the same opening, nothing more in Shopify
  const again = ok(await call('POST', 'staff/displays/open', body, OWNER));
  assert.deepEqual([again.repeated, again.open.id], [true, opened.open.id]);
  assert.equal(calls.filter((c) => c[0] === 'adjustShelf').length, 1);
  // remembered for next time, and the last few openings listed
  const next = ok(await call('GET', 'staff/displays?q=night', null, OWNER));
  assert.deepEqual(next.products[0].remembered, { boxVariantId: NC_BOX, packVariantId: NC_PACK, packs: 36 });
  assert.deepEqual(next.recent.map((r) => [r.title, r.boxes, r.packs]), [['Cyberpunk TCG - Welcome to Night City - Booster', 1, 36]]);
  // undo within a day, once
  const undone = ok(await call('POST', 'staff/displays/undo', { id: opened.open.id }, OWNER));
  assert.equal(undone.undone.undone, true);
  assert.deepEqual(calls.filter((c) => c[0] === 'adjustShelf')[1][1], [{ inventoryItemId: 'gid://shopify/InventoryItem/91', delta: 1 }, { inventoryItemId: 'gid://shopify/InventoryItem/92', delta: -36 }]);
  assert.equal(said(await call('POST', 'staff/displays/undo', { id: opened.open.id }, OWNER)), `409 ${DISPLAY_WORDS.undone}`);
});

test('Open a display: the checks, each with its words, and nothing changes in Shopify', async () => {
  displayProducts = [nightCity()];
  const body = { productId: NIGHT_CITY, boxVariantId: NC_BOX, packVariantId: NC_PACK, boxes: 1, packs: 36, key: 'open-tap-0002' };
  assert.equal(said(await call('POST', 'staff/displays/open', { ...body, boxVariantId: '' }, OWNER)), `422 ${DISPLAY_WORDS.pick}`);
  assert.equal(said(await call('POST', 'staff/displays/open', { ...body, packVariantId: NC_BOX }, OWNER)), `422 ${DISPLAY_WORDS.same}`);
  assert.equal(said(await call('POST', 'staff/displays/open', { ...body, boxes: 0 }, OWNER)), `422 ${DISPLAY_WORDS.boxes}`);
  assert.equal(said(await call('POST', 'staff/displays/open', { ...body, boxes: 11 }, OWNER)), `422 ${DISPLAY_WORDS.boxes}`);
  assert.equal(said(await call('POST', 'staff/displays/open', { ...body, packs: 101 }, OWNER)), `422 ${DISPLAY_WORDS.packs}`);
  assert.equal(said(await call('POST', 'staff/displays/open', { ...body, key: 'x' }, OWNER)), `422 ${DISPLAY_WORDS.key}`);
  displayProducts[0].variants[0].shelf = 0;
  assert.equal(said(await call('POST', 'staff/displays/open', body, OWNER)), `409 ${DISPLAY_WORDS.noBox(0)}`);
  assert.equal((await call('POST', 'staff/displays/open', body, MIA)).status, 403);
  assert.equal(said(await call('GET', 'staff/displays?q=N', null, OWNER)), `422 ${DISPLAY_WORDS.words}`);
  assert.equal(calls.filter((c) => c[0] === 'adjustShelf').length, 0);
  // more than a day later, an opening can't be undone here
  displayProducts[0].variants[0].shelf = 45;
  const opened = ok(await call('POST', 'staff/displays/open', body, OWNER));
  nowIs(NOW + DAY);
  assert.equal(said(await call('POST', 'staff/displays/undo', { id: opened.open.id }, OWNER)), `409 ${DISPLAY_WORDS.undoLate}`);
});

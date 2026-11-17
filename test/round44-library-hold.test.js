// Round 44: library copies bought online are held (contract v44-library-hold). From the website review of 17 Nov 2026:
// library copies ("(Library)" in the title, custom.library_code) can be bought online by anyone with a cart link, and
// 163 are still $0. Members may buy a library copy they've borrowed, at 20% off, from My Library (Mo, 2 Nov 2026). Any
// other online order with a library copy must never be posted out by mistake, and a $0 library copy is always held.
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { LIBRARY_HOLD, LIBRARY_HOLD_WORDS as W } from '../src/library-hold.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Friday 20 November 2026, 1:00pm in Auckland
const NOW = time.at('2026-11-20', 13 * 60);
const realNow = Date.now;
const nowIs = (ms) => {
  Date.now = () => ms;
};
const settle = () => new Promise((r) => setTimeout(r, 15));

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
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: () => {} };
}

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];
const MIA = '6001';
const KAI = '6002';
const STRANGER = '7777';
const NAMES = { [MIA]: 'Mia Chen', [KAI]: 'Kai Tane' };

// Shopify's side: the products (title and library code), each order's customer, the holds and tags placed, and the
// emails sent
const PRODUCTS = new Map([
  ['501', { title: 'Catan (Library)', libraryCode: 'DGL34-M011' }],
  ['502', { title: 'Azul (Library)', libraryCode: 'DGL34-S004' }],
  ['503', { title: 'Catan', libraryCode: null }],
  // "(Library)" in the title but no library code: not a library copy
  ['504', { title: 'Library of Ruina Art Book (Library)', libraryCode: null }],
]);
let lair;
let spends;
let asked;
let holds;
let holdFails;
let marked;
let sent;
const realFetch = globalThis.fetch;

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
const paid = async (order) => {
  const res = await call('POST', 'internal/orders-paid', order, '', { 'X-Lair-Internal': '1' });
  assert.equal(res.status, 200, res.data.error);
  await settle();
  return res.data;
};

/** A paid order (the orders/paid webhook's shape), and who Shopify says it's for */
function order(n, lineItems, { customer = STRANGER, source = 'web' } = {}) {
  spends.set(String(n), { customerId: customer, amount: 0, source, name: `#${n}`, discountCodes: [], processedAt: Date.now() });
  return { id: n, admin_graphql_api_id: `gid://shopify/Order/${n}`, name: `#${n}`, source_name: source, line_items: lineItems };
}
const catan = (id, price, { quantity = 1, discount = 0 } = {}) => ({
  id, product_id: 501, variant_id: 901, title: 'Catan (Library)', name: 'Catan (Library)', sku: 'DGL34-M011', vendor: 'Kosmos',
  price: price.toFixed(2), quantity, discount_allocations: discount ? [{ amount: discount.toFixed(2) }] : [],
});
const azul = (id, price) => ({ id, product_id: 502, variant_id: 902, title: 'Azul (Library)', name: 'Azul (Library)', sku: 'DGL34-S004', vendor: 'Plan B', price: price.toFixed(2), quantity: 1, discount_allocations: [] });
const shopCatan = (id) => ({ id, product_id: 503, variant_id: 903, title: 'Catan', name: 'Catan', sku: 'CATAN-5', vendor: 'Kosmos', price: '79.00', quantity: 1, discount_allocations: [] });
const artBook = (id) => ({ id, product_id: 504, variant_id: 904, title: 'Library of Ruina Art Book (Library)', name: 'Library of Ruina Art Book (Library)', sku: 'ART-1', vendor: 'X', price: '40.00', quantity: 1, discount_allocations: [] });

/** A game at home with someone, as a loan in the Lair */
function atHome(customerId, variantId, title = 'Catan') {
  lair.sql.exec(
    `INSERT INTO library_loans (id, variant_id, product_id, title, shelf_code, customer_id, status, out_at, created_at)
     VALUES (?, ?, NULL, ?, NULL, ?, 'out', ?, ?)`,
    `ln_${customerId}_${variantId}_${Math.random()}`, String(variantId), title, customerId, NOW - DAY, NOW - DAY,
  );
}
const rowOf = (n) => lair.sql.exec('SELECT * FROM library_order_holds WHERE order_id = ?', `gid://shopify/Order/${n}`).toArray()[0];
const staffMail = () => sent.filter((m) => m.to === 'staff@dicegoblin.test');

beforeEach(() => {
  spends = new Map();
  asked = [];
  holds = [];
  holdFails = 0;
  marked = [];
  sent = [];
  nowIs(NOW);
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.resend.com/')) throw new Error(`No network in tests: ${url}`);
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0], key: init.headers?.['Idempotency-Key'] });
    return new Response(JSON.stringify({ id: 'e1' }), { status: 200 });
  };
  lair = new Lair(fakeCtx(), {
    CURRENCY: 'NZD', RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test',
  });
  lair.taggedPerson = async (id) => ({ customerId: id || null, staff: false, gm: false, tags: [] });
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.orderSpend = async (orderId) => spends.get(String(orderId).split('/').pop()) || null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.orderGiftBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  lair.shopify.customersSince = async () => new Map();
  lair.shopify.libraryProducts = async (ids) => {
    asked.push([...ids]);
    return new Map(ids.filter((id) => PRODUCTS.has(String(id))).map((id) => [String(id), PRODUCTS.get(String(id))]));
  };
  lair.shopify.holdOrderFulfilment = async (orderId, hold) => {
    if (holdFails > 0) {
      holdFails -= 1;
      throw new Error('Shopify said no');
    }
    holds.push([orderId, hold]);
    return { held: 1 };
  };
  lair.shopify.gwMarkOrder = async (orderId, tag, paragraph) => {
    marked.push([orderId, tag, paragraph]);
  };
  lair.accountEmail = async () => ({ fetched: false, email: '' });
  lair.checkGiftCodes = async () => 0;
  lair.gmCreditSoon = () => null;
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  for (const id of Object.keys(NAMES)) lair.makeMember({ customerId: id, name: NAMES[id], email: `${NAMES[id].split(' ')[0].toLowerCase()}@example.com` }, NOW);
});
afterEach(async () => {
  // background work (the hold's follow-up) finishes inside the test, never against the real network
  await settle();
  Date.now = realNow;
  globalThis.fetch = realFetch;
});

/* ---------------- the words ---------------- */

test('round 44: the words, word for word', () => {
  assert.equal(LIBRARY_HOLD.tag, 'Library copy');
  assert.equal(LIBRARY_HOLD.handle, 'lair-library-copy');
  assert.equal(W.subject('#1550'), "Don't send order #1550: it has a library copy");
  assert.equal(W.title, 'A library copy was bought online');
  assert.equal(W.introHeld('#1550'), "Order #1550 has a library copy in it, so Gobgob has put it on hold in Shopify. Don't post it or hand it over.");
  assert.equal(W.introNotHeld('#1550'), "Order #1550 has a library copy in it. It isn't on hold in Shopify yet (Gobgob keeps trying for a day), and it's tagged Library copy. Don't post it or hand it over.");
  assert.equal(W.line({ title: 'Catan', code: 'DGL34-M011', quantity: 1, each: 0, why: 'free' }), 'Catan (DGL34-M011): $0.00, a $0 library copy');
  assert.equal(W.line({ title: 'Catan', code: 'DGL34-M011', quantity: 1, each: 6500, why: 'notTheirs' }), 'Catan (DGL34-M011): $65.00, not a game they have on loan');
  assert.equal(W.line({ title: 'Catan', code: 'DGL34-M011', quantity: 2, each: 6500, why: 'notTheirs' }), '2 × Catan (DGL34-M011): $65.00 each, not a game they have on loan');
  assert.equal(W.note([{ title: 'Catan', code: 'DGL34-M011' }]), "Library copy in this order: Catan (DGL34-M011). Don't post it or hand it over. Refund or cancel unless there's a good reason.");
  assert.equal(W.note([{ title: 'Catan', code: 'DGL34-M011' }, { title: 'Azul', code: 'DGL34-S004' }]), "Library copies in this order: Catan (DGL34-M011) and Azul (DGL34-S004). Don't post it or hand it over. Refund or cancel unless there's a good reason.");
  assert.deepEqual(W.outro, [
    "What to do: refund or cancel it in Shopify, and let them know library copies aren't for sale online.",
    "Only keep it if there's a good reason, like a member buying a game they've borrowed. Then release the hold in Shopify (Orders, the order, Release hold) before you send it.",
  ]);
  assert.deepEqual([W.orderRow, W.lineRow, W.customerRow, W.notMember, W.noCustomer], ['Order', 'Library copy', 'Customer', 'Not a Lair member', 'No customer on the order']);
});

/* ---------------- who's held ---------------- */

test('round 44: anyone buying a library copy online is held in Shopify, tagged and noted, and staff are emailed once', async () => {
  const res = await paid(order(1550, [catan(1, 65), shopCatan(2)]));
  assert.deepEqual(res.libraryHold, { lines: 1 });
  // Shopify is asked only about the line that could be a library copy
  assert.deepEqual(asked, [['501']]);
  assert.equal(holds.length, 1);
  assert.equal(holds[0][0], 'gid://shopify/Order/1550');
  assert.equal(holds[0][1].handle, 'lair-library-copy');
  assert.equal(holds[0][1].reasonNotes, W.note([{ title: 'Catan', code: 'DGL34-M011' }]));
  assert.deepEqual(marked, [['gid://shopify/Order/1550', 'Library copy', W.note([{ title: 'Catan', code: 'DGL34-M011' }])]]);
  const mail = staffMail();
  assert.equal(mail.length, 1);
  assert.equal(mail[0].subject, "Don't send order #1550: it has a library copy");
  assert.match(mail[0].html, /Order #1550 has a library copy in it, so Gobgob has put it on hold in Shopify/);
  assert.match(mail[0].html, /Catan \(DGL34-M011\): \$65\.00, not a game they have on loan/);
  assert.match(mail[0].html, /Not a Lair member/);
  assert.match(mail[0].html, /refund or cancel it in Shopify/);
  assert.equal(mail[0].key, 'library-hold-1550');
  // the shop's own Catan isn't mentioned
  assert.doesNotMatch(mail[0].text || mail[0].html, /CATAN-5/);
  // the webhook again: nothing more
  sent.length = 0;
  await paid(order(1550, [catan(1, 65), shopCatan(2)]));
  assert.equal(holds.length, 1);
  assert.equal(marked.length, 1);
  assert.equal(staffMail().length, 0);
  // and the 10-minute run has nothing to do
  assert.equal(await lair.libraryHoldUpkeep(Date.now()), null);
});

test("round 44: a member buying the copy they have at home isn't held, but a $0 one always is", async () => {
  atHome(MIA, 901);
  // 20% off, paid: their own My Library purchase
  let res = await paid(order(1600, [catan(1, 65, { discount: 13 })], { customer: MIA }));
  assert.equal(res.libraryHold, undefined);
  assert.equal(rowOf(1600), undefined);
  assert.equal(holds.length + marked.length + staffMail().length, 0);
  // the same game, listed at $0: held even for them
  res = await paid(order(1601, [catan(1, 0)], { customer: MIA }));
  assert.deepEqual(res.libraryHold, { lines: 1 });
  assert.equal(holds.length, 1);
  assert.match(staffMail()[0].html, /Catan \(DGL34-M011\): \$0\.00, a \$0 library copy/);
  assert.match(staffMail()[0].html, /Mia Chen/);
  // discounts that take it to $0 count as $0
  res = await paid(order(1602, [catan(1, 65, { discount: 65 })], { customer: MIA }));
  assert.deepEqual(res.libraryHold, { lines: 1 });
});

test("round 44: a member is held for a game they haven't got at home, more copies than they have, or someone else's", async () => {
  atHome(MIA, 901);
  atHome(KAI, 902, 'Azul');
  // Azul is at home with Kai, not Mia
  let res = await paid(order(1700, [catan(1, 52), azul(2, 40)], { customer: MIA }));
  assert.deepEqual(res.libraryHold, { lines: 1 });
  const lines = JSON.parse(rowOf(1700).lines);
  assert.deepEqual(lines.map((l) => [l.title, l.why]), [['Azul', 'notTheirs']]);
  assert.match(staffMail()[0].html, /Azul \(DGL34-S004\): \$40\.00, not a game they have on loan/);
  assert.doesNotMatch(staffMail()[0].html, /DGL34-M011/);
  // two of Catan with one at home
  res = await paid(order(1701, [catan(1, 52, { quantity: 2 })], { customer: MIA }));
  assert.deepEqual(res.libraryHold, { lines: 1 });
  // a game that's come back to the shelf is no longer theirs to buy
  lair.sql.exec("UPDATE library_loans SET status = 'returned' WHERE customer_id = ?", KAI);
  res = await paid(order(1702, [azul(1, 40)], { customer: KAI }));
  assert.deepEqual(res.libraryHold, { lines: 1 });
  // an order with no customer at all
  res = await paid(order(1703, [azul(1, 40)], { customer: null }));
  assert.deepEqual(res.libraryHold, { lines: 1 });
  assert.match(staffMail().at(-1).html, /No customer on the order/);
});

test("round 44: counter sales, shop products, books with no library code and the Lair's postal swap line aren't held", async () => {
  // rung up at the counter (Shopify POS)
  let res = await paid(order(1800, [catan(1, 0)], { source: 'pos' }));
  assert.equal(res.libraryHold, undefined);
  // the shop's own copy: Shopify isn't even asked
  res = await paid(order(1801, [shopCatan(1)]));
  assert.equal(res.libraryHold, undefined);
  assert.deepEqual(asked, []);
  // "(Library)" in its title but Shopify says it has no library code
  res = await paid(order(1802, [artBook(1)]));
  assert.equal(res.libraryHold, undefined);
  // the Lair's postal swap checkout: a custom $0 line with no product
  res = await paid(order(1803, [{ id: 1, product_id: null, variant_id: null, title: 'Library swap: Catan (DGL34-M011)', price: '0.00', quantity: 1 }], { source: 'shopify_draft_order' }));
  assert.equal(res.libraryHold, undefined);
  assert.equal(holds.length + marked.length + staffMail().length, 0);
});

test("round 44: when Shopify can't say what the products are, a line that looks like a library copy is held anyway", async () => {
  lair.shopify.libraryProducts = async () => {
    throw new Error('Shopify is down');
  };
  const res = await paid(order(1900, [catan(1, 65)]));
  assert.deepEqual(res.libraryHold, { lines: 1 });
  assert.equal(holds.length, 1);
  assert.match(staffMail()[0].html, /Catan/);
});

test("round 44: a hold Shopify refuses is emailed as tagged, then the 10-minute run tries again, and the email isn't sent twice", async () => {
  holdFails = 1;
  await paid(order(2000, [catan(1, 65)]));
  assert.equal(holds.length, 0);
  assert.equal(marked.length, 1);
  const mail = staffMail();
  assert.equal(mail.length, 1);
  assert.match(mail[0].html, /isn&#39;t on hold in Shopify yet|isn't on hold in Shopify yet/);
  assert.match(rowOf(2000).hold_note, /Shopify said no/);
  sent.length = 0;
  nowIs(NOW + 10 * MIN);
  assert.deepEqual(await lair.libraryHoldUpkeep(Date.now()), { held: 1, tagged: 0, mailed: 0 });
  assert.equal(holds.length, 1);
  assert.ok(rowOf(2000).held_at);
  assert.equal(staffMail().length, 0);
  // nothing left to do
  assert.equal(await lair.libraryHoldUpkeep(Date.now()), null);
});

test('round 44: the 10-minute run gives up on a hold after a day, and sends an email a restart cut short', async () => {
  holdFails = 1000;
  await paid(order(2100, [catan(1, 65)]));
  nowIs(NOW + 10 * MIN);
  assert.deepEqual(await lair.libraryHoldUpkeep(Date.now()), { held: 0, tagged: 0, mailed: 0 });
  nowIs(NOW + LIBRARY_HOLD.retryForMs + MIN);
  assert.equal(await lair.libraryHoldUpkeep(Date.now()), null);
  // an email not sent yet (Resend was down) goes on the next run, once
  holdFails = 0;
  nowIs(NOW + 2 * DAY);
  // Resend turns it away (a 4xx isn't tried again at once)
  globalThis.fetch = async () => new Response(JSON.stringify({ name: 'validation_error', message: 'Not now' }), { status: 422 });
  await paid(order(2101, [catan(1, 65)]));
  assert.equal(rowOf(2101).mailed_at, null);
  sent.length = 0;
  globalThis.fetch = async (url, init) => {
    sent.push({ ...JSON.parse(init.body), to: JSON.parse(init.body).to[0] });
    return new Response(JSON.stringify({ id: 'e2' }), { status: 200 });
  };
  nowIs(NOW + 2 * DAY + 10 * MIN);
  assert.deepEqual(await lair.libraryHoldUpkeep(Date.now()), { held: 0, tagged: 0, mailed: 1 });
  assert.equal(staffMail().length, 1);
  assert.equal(await lair.libraryHoldUpkeep(Date.now()), null);
});

test('round 44: LIBRARY_HOLD_EMAILS = off stops the email, not the hold', async () => {
  lair.baseEnv = { ...lair.baseEnv, LIBRARY_HOLD_EMAILS: 'off' };
  await paid(order(2200, [catan(1, 0)]));
  assert.equal(holds.length, 1);
  assert.equal(marked.length, 1);
  assert.equal(staffMail().length, 0);
  assert.equal(await lair.libraryHoldUpkeep(Date.now()), null);
});

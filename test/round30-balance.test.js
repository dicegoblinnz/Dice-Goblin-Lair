// Round 30: store credit shows straight away. Mo (6 Nov 2026): "the store credit are not updating properly". A loyalty
// roll added store credit in Shopify, but My Lair's Wallet kept showing the balance the page was opened with until it
// was reloaded. Shopify says the balance after each change, so a roll's answer carries it (balance, in cents), as a
// store credit gift's already does, and My Lair shows it at once. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { ShopifyAdmin } from '../src/shopify.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS, LOYALTY_SURE } from '../src/core.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
// Friday 6 November 2026, 7:42pm in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 10, 6, 6, 42);
const realNow = Date.now;
const nowIs = (ms) => {
  Date.now = () => ms;
};

/* ---------------- helpers, as in test/round29-headstart.test.js ---------------- */
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
const OWNER = '9001';
const MIA = '6001';

let ctx;
let lair;
// What the stand-in Shopify does with the next store credit: its transaction, or an error to throw
let answer;
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
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const roll = (who, pick) => call('POST', 'roll', { kind: 'loyalty', ...(pick ? { pick } : {}) }, who, { 'X-Lair-Client': '203.0.113.7' });
/** Ten stamps from the main account's staff page: one roll */
const aRoll = async (who) => ok(await call('POST', `members/${who}/stamps`, { count: 10 }, OWNER));

const realFetch = globalThis.fetch;
let reached = [];

beforeEach(async () => {
  reached = [];
  answer = null;
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  ctx = fakeCtx();
  lair = new Lair(ctx, { CURRENCY: 'NZD' });
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  lair.shopify.customersSince = async () => new Map();
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.creditCustomer = async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  };
  lair.accountEmail = async () => ({ fetched: false, email: '' });
  lair.checkGiftCodes = async () => 0;
  lair.notifyStaff = () => {};
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

test('round 30: a loyalty roll answers with the store credit balance Shopify gives back (balance, in cents), so My Lair shows it at once', async () => {
  await aRoll(MIA);
  await aRoll(MIA);
  await aRoll(MIA);
  // Shopify says the balance after: it's in the answer
  answer = { amount: { amount: '10.0' }, balanceAfter: 4250 };
  const sure = ok(await roll(MIA, 'sure'));
  assert.equal(sure.prize.amount, LOYALTY_SURE);
  assert.equal(sure.prize.status, 'added');
  assert.equal(sure.balance, 4250);
  // Shopify doesn't say (an older answer, or the field was denied): no balance, and the page keeps the one it has
  answer = { amount: { amount: '7.0' }, balanceAfter: null };
  const quiet = ok(await roll(MIA));
  assert.equal(quiet.prize.status, 'added');
  assert.equal('balance' in quiet, false);
  // Shopify couldn't add it: the prize waits at the counter, and there's no balance to show
  answer = new Error('Shopify API: Internal error');
  const failed = ok(await roll(MIA, 'sure'));
  assert.equal(failed.prize.status, 'pending');
  assert.equal('balance' in failed, false);
});

test('round 30: Shopify store credit (creditCustomer) says the balance after it in cents, or null when Shopify leaves it out or denies it; a denied field still counts as made', async () => {
  const admin = new ShopifyAdmin({ SHOP: 'dice-goblin.myshopify.com', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret', API_VERSION: '2026-07' }, ctx.storage);
  const asked = [];
  const answers = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/admin/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 86399 }), { status: 200 });
    const { query, variables } = JSON.parse(init.body);
    asked.push({ query, variables });
    return new Response(JSON.stringify(answers.shift()));
  };
  const tx = (balance) => ({ amount: { amount: '10.0' }, balanceAfterTransaction: balance == null ? null : { amount: balance } });
  answers.push(
    { data: { storeCreditAccountCredit: { storeCreditAccountTransaction: tx('42.5'), userErrors: [] } } },
    { data: { storeCreditAccountCredit: { storeCreditAccountTransaction: tx(null), userErrors: [] } } },
    {
      data: { storeCreditAccountCredit: { storeCreditAccountTransaction: tx(null), userErrors: [] } },
      errors: [{ message: 'Access denied for balanceAfterTransaction field.', path: ['storeCreditAccountCredit', 'storeCreditAccountTransaction', 'balanceAfterTransaction'], extensions: { code: 'ACCESS_DENIED' } }],
    },
  );
  const first = await admin.creditCustomer(MIA, 1000, 'NZD');
  assert.equal(first.balanceAfter, 4250);
  assert.match(asked[0].query, /balanceAfterTransaction \{ amount \}/);
  assert.deepEqual(asked[0].variables.creditInput, { creditAmount: { amount: '10.00', currencyCode: 'NZD' }, notify: true }, 'still with Shopify\'s own email');
  assert.equal((await admin.creditCustomer(MIA, 1000, 'NZD')).balanceAfter, null);
  assert.equal((await admin.creditCustomer(MIA, 1000, 'NZD')).balanceAfter, null, 'made, with the balance denied');
  reached = [];
});

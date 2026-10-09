// Round 10, library memberships: the Lair bills Grab, Stash and Hoard itself through Lair Memberships (Shopify
// subscription contracts), replacing Simplee. Mo (9 Oct 2026): "I want to build a new Shopify app to help replace the
// subscription app that I have called simplee", with damage charges on the member's next bill after a 7-day notice,
// and a cancelled membership running to the end of the month they've paid for.
// Run with: npm test   (under TZ=UTC and TZ=Pacific/Auckland)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair, MIGRATIONS } from '../src/lair.js';
import worker from '../src/index.js';
import { LairTime, rulesFromSettings } from '../src/core.js';
import {
  FEE_NOTICE_DAYS, MAX_ATTEMPTS, MEMBERSHIP_MESSAGES, MEMBERSHIP_TOPICS, RETRY_DAYS, TIERS, billDay, cardWords, chargeKey, numericId, retryAt, tierOf,
} from '../src/memberships.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Saturday 3 October 2026, 10am in Auckland (NZDT): Sam joins on Stash at checkout
const JOINED = at('2026-10-03', 10);
const realNow = Date.now;
let clock = JOINED;
const setNow = (ms) => {
  clock = ms;
};

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

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];
const HOURS = 'Mon 10:00-23:00\nTue 10:00-23:00\nWed 10:00-23:00\nThu 10:00-23:00\nFri 10:00-23:00\nSat 10:00-23:00\nSun 10:00-23:00';
const SAM = '1001';
const KIRI = '1002';
const CONTRACT = '501';
const PM = 'gid://shopify/CustomerPaymentMethod/pm-sam';
const PLAN_IDS = { grab: 'gid://shopify/SellingPlan/701', stash: 'gid://shopify/SellingPlan/702', hoard: 'gid://shopify/SellingPlan/703' };
const FEE_VARIANT = 'gid://shopify/ProductVariant/990';

let lair;
let shop;
let ctx;
async function call(method, path, body, customer = '', extraHeaders = {}) {
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  return { status: response.status, data: await response.json() };
}
const internal = (path, body) => call('POST', `internal/${path}`, body, '', { 'X-Lair-Internal': '1' });
const maintenance = async () => (await internal('maintenance', { webhookUrl: 'https://lair.test/webhooks/orders-paid' })).data.memberships;
const me = async (who = SAM) => (await call('GET', 'me', null, who)).data;
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const settle = () => new Promise((r) => setTimeout(r, 10));
let hookN = 0;
const hook = (topic, payload, webhookId = `wh-${(hookN += 1)}`) => internal('memberships-webhook', { topic, webhookId, payload });
const membership = (id = CONTRACT) => lair.membershipRow(id);
const charges = (id = CONTRACT) => lair.sql.exec('SELECT * FROM membership_charges WHERE membership_id = ? ORDER BY cycle, attempt', id).toArray();
const fee = (id) => lair.feeRow(id);

/** Month n after `from`, the same clock time (the fake's billing cycles) */
const months = (from, n) => {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.getTime();
};

/** Turn on emails and catch everything sent to Resend. */
function captureEmails() {
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test' };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return { sent, restore: () => { globalThis.fetch = realFetch; } };
}

/**
 * A fake Lair Memberships: contracts with monthly billing cycles (each cycle billed at its end), billing attempts that
 * stay pending until the test settles them, an idempotency key that always gives back the same attempt (as Shopify's
 * does), cycle edits, plan changes, card emails and webhooks.
 */
function fakeMemberships() {
  const state = {
    contracts: new Map(), cycles: new Map(), attempts: new Map(), keys: new Map(), edits: new Map(), ended: [], planChanges: [], cardEmails: [],
    billCalls: [], editCalls: [], hooks: [], n: 0, billThrows: 0, billErrors: null, editErrors: null, planErrors: null, groups: [], madeProducts: 0,
  };
  const admin = {
    configured: true,
    contract: async (id) => {
      const c = state.contracts.get(numericId(id));
      return c ? JSON.parse(JSON.stringify(c)) : null;
    },
    cycles: async (id, start, end) => (state.cycles.get(numericId(id)) || []).filter((c) => c.index >= start && c.index <= end).map((c) => ({ ...c })),
    bill: async ({ contractId, cycle, key }) => {
      state.billCalls.push({ contractId, cycle, key });
      if (state.billThrows > 0) {
        state.billThrows -= 1;
        throw new Error('Shopify API error 502');
      }
      if (state.billErrors) {
        const errors = state.billErrors;
        state.billErrors = null;
        return { attemptId: null, errors };
      }
      if (state.keys.has(key)) return { attemptId: state.keys.get(key), errors: [] };
      state.n += 1;
      const attemptId = `gid://shopify/SubscriptionBillingAttempt/${state.n}`;
      state.keys.set(key, attemptId);
      state.attempts.set(attemptId, { contractId: numericId(contractId), cycle, key, state: { state: 'pending' } });
      return { attemptId, errors: [] };
    },
    attempt: async (id) => state.attempts.get(id)?.state || null,
    endContract: async (id, how) => {
      state.ended.push([numericId(id), how]);
      const c = state.contracts.get(numericId(id));
      if (c) c.status = how === 'fail' ? 'FAILED' : 'CANCELLED';
      return { status: how === 'fail' ? 'FAILED' : 'CANCELLED', errors: [] };
    },
    changePlan: async (args) => {
      state.planChanges.push(args);
      if (state.planErrors) return { ok: false, errors: state.planErrors };
      const c = state.contracts.get(numericId(args.contractId));
      if (c) {
        c.lines[0] = { ...c.lines[0], sellingPlanId: args.sellingPlanId, sellingPlanName: args.sellingPlanName, price: args.price };
        c.revisionId = String(Number(c.revisionId) + 1);
      }
      return { ok: true, errors: [] };
    },
    editCycle: async (args) => {
      state.editCalls.push(JSON.parse(JSON.stringify(args)));
      if (state.editErrors) return { ok: false, errors: state.editErrors };
      state.edits.set(`${numericId(args.contractId)}:${args.cycle}`, args);
      return { ok: true, errors: [] };
    },
    clearCycleEdit: async ({ contractId, cycle }) => {
      state.edits.delete(`${numericId(contractId)}:${cycle}`);
      return { ok: true, errors: [] };
    },
    sendCardEmail: async (pm) => {
      state.cardEmails.push(pm);
      return { ok: true, errors: [] };
    },
    customer: async (id) => ({ [SAM]: { name: 'Sam Jones', firstName: 'Sam', email: 'sam@example.com' }, [KIRI]: { name: 'Kiri Smith', firstName: 'Kiri', email: 'kiri@example.com' } })[id] || null,
    ensureWebhooks: async (url) => {
      state.hooks.push(url);
      return { ok: true, created: MEMBERSHIP_TOPICS, errors: [] };
    },
    appInfo: async () => ({ app: 'Lair Memberships', scopes: ['write_products', 'read_customers', 'write_customers', 'read_orders', 'read_customer_payment_methods', 'read_own_subscription_contracts', 'write_own_subscription_contracts'] }),
    ownGroups: async () => state.groups.map((g) => ({ ...g })),
    createPlans: async (productIds) => {
      state.groups.push({
        id: 'gid://shopify/SellingPlanGroup/77', name: 'Library membership', code: 'lair-library-membership', productIds: productIds.map((p) => `gid://shopify/Product/${p}`),
        plans: [{ id: PLAN_IDS.grab, name: 'Grab', price: 3000 }, { id: PLAN_IDS.stash, name: 'Stash', price: 6000 }, { id: PLAN_IDS.hoard, name: 'Hoard', price: 7500 }],
      });
      return { group: 'gid://shopify/SellingPlanGroup/77', errors: [] };
    },
    addProducts: async (groupId, productIds) => {
      state.groups[0].productIds.push(...productIds.map((p) => `gid://shopify/Product/${p}`));
      return { errors: [] };
    },
    feeVariant: async () => (state.madeProducts ? FEE_VARIANT : null),
    createFeeProduct: async () => {
      state.madeProducts += 1;
      return { variantId: FEE_VARIANT, problem: null };
    },
  };
  lair.membershipsAdmin = () => admin;
  return { state, admin };
}

/** A contract made at checkout (the origin order paid the first month), with 12 monthly billing cycles */
function contract({ id = CONTRACT, customerId = SAM, tier = 'stash', createdAt = JOINED, price = TIERS[tier].price, card = { kind: 'card', brand: 'Visa', last4: '4242', expMonth: 8, expYear: 2030 } } = {}) {
  shop.state.contracts.set(id, {
    gid: `gid://shopify/SubscriptionContract/${id}`, id, status: 'ACTIVE', createdAt, currency: 'NZD', revisionId: '1', customerId,
    originOrderId: 'gid://shopify/Order/1550', paymentMethodId: PM, paymentRevoked: false, card, interval: 'MONTH', intervalCount: 1,
    lines: [{ id: `gid://shopify/SubscriptionLine/${id}1`, sellingPlanId: PLAN_IDS[tier], sellingPlanName: TIERS[tier].name, variantId: 'gid://shopify/ProductVariant/42179272933479', productId: 'gid://shopify/Product/7532313641063', title: 'Board Game Rental Membership', quantity: 1, price }],
  });
  shop.state.cycles.set(id, Array.from({ length: 12 }, (_, i) => ({
    index: i + 1, startAt: months(createdAt, i), endAt: months(createdAt, i + 1) - 1, expectedAt: months(createdAt, i + 1), billed: false, skipped: false, edited: false,
  })));
  return shop.state.contracts.get(id);
}

/** Make a contract and send its create webhook */
async function join(over = {}) {
  const c = contract(over);
  const res = await hook('subscription_contracts/create', { admin_graphql_api_id: c.gid, id: Number(c.id), revision_id: c.revisionId, status: 'active' });
  assert.equal(res.status, 200, res.data.error);
  return c;
}

/** Shopify answers a billing attempt (by its key): the cycle is billed on success; the webhook is sent */
async function answer(key, outcome) {
  const attemptId = shop.state.keys.get(key);
  assert.ok(attemptId, `no attempt for ${key}`);
  const attempt = shop.state.attempts.get(attemptId);
  attempt.state = outcome === 'paid' ? { state: 'paid', orderId: 'gid://shopify/Order/1600' } : outcome === 'action' ? { state: 'action', nextActionUrl: 'https://bank.test/3ds' } : { state: 'failed', code: outcome };
  if (outcome === 'paid') shop.state.cycles.get(attempt.contractId).find((c) => c.index === attempt.cycle).billed = true;
  const topic = outcome === 'paid' ? 'subscription_billing_attempts/success' : outcome === 'action' ? 'subscription_billing_attempts/challenged' : 'subscription_billing_attempts/failure';
  return hook(topic, {
    id: null, admin_graphql_api_id: attemptId, idempotency_key: key, subscription_contract_id: Number(attempt.contractId),
    admin_graphql_api_subscription_contract_id: `gid://shopify/SubscriptionContract/${attempt.contractId}`,
    order_id: outcome === 'paid' ? 1600 : null, admin_graphql_api_order_id: outcome === 'paid' ? 'gid://shopify/Order/1600' : null,
    ready: outcome !== 'action', error_code: ['paid', 'action'].includes(outcome) ? null : outcome.toLowerCase(), error_message: ['paid', 'action'].includes(outcome) ? null : 'Declined.',
  });
}

/** Saved plans, as /setup?…&memberships=plans would leave them */
const savePlans = () => lair.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('membership-plans', ?)", JSON.stringify({
  groupId: 'gid://shopify/SellingPlanGroup/77', plans: { grab: { id: PLAN_IDS.grab, name: 'Grab', price: 3000 }, stash: { id: PLAN_IDS.stash, name: 'Stash', price: 6000 }, hoard: { id: PLAN_IDS.hoard, name: 'Hoard', price: 7500 } },
}));

/** A library game at home with Sam */
function gameAtHome(title = 'Catan', customerId = SAM) {
  lair.touchMember(customerId, { name: customerId === SAM ? 'Sam Jones' : 'Kiri Smith', email: customerId === SAM ? 'sam@example.com' : 'kiri@example.com' }, clock);
  return lair.makeLoan({ variantId: '8001', productId: '9001', title, handle: 'catan-library', shelfCode: 'DGL34' }, customerId, clock);
}
const logDamage = (body, who = 'staff') => call('POST', 'library/damage', body, who);

function open({ billing = true } = {}) {
  ctx = fakeCtx();
  lair = new Lair(ctx, { CURRENCY: 'NZD', SHOP: 'dice-goblin.myshopify.com', PUBLIC_URL: 'https://lair.test', ...(billing ? { MEMBERSHIPS_BILLING: 'on' } : {}) });
  lair.person = async (id) => ({
    customerId: id || null, staff: ['staff', 'helper', 'shelf'].includes(id), gm: false, tags: [],
    ...(id === 'helper' ? { role: 'helper', perms: ['library'] } : id === 'shelf' ? { role: 'helper', perms: ['checkin'] } : {}),
  });
  lair.shopify.orderSpend = async () => null;
  lair.rulesCache = rulesFromSettings({ lair_hours: HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = JOINED + 10 * 365 * DAY;
  shop = fakeMemberships();
  savePlans();
  lair.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('membership-fee-variant', ?)", FEE_VARIANT);
}

beforeEach(() => {
  clock = JOINED;
  Date.now = () => clock;
  open();
});
afterEach(() => {
  Date.now = realNow;
});

/* ---------------- the pure parts ---------------- */
test('tiers from selling plan names, idempotency keys, retry times and dates', () => {
  assert.deepEqual(['Grab', 'Stash - Board Game Rental', 'Goblin Hoard', 'Treasure', "Goblin's Loot", 'Something else', ''].map(tierOf), ['grab', 'stash', 'hoard', 'stash', 'grab', null, null]);
  assert.equal(chargeKey('gid://shopify/SubscriptionContract/501', 3, 2), 'lair-membership-501-c3-a2');
  assert.equal(numericId('gid://shopify/Customer/1001'), '1001');
  assert.deepEqual([RETRY_DAYS, MAX_ATTEMPTS], [[3, 7], 3]);
  assert.equal(retryAt(JOINED, 1), JOINED + 3 * DAY);
  assert.equal(retryAt(JOINED, 2), JOINED + 7 * DAY, 'the third try is a week after the first failure');
  assert.equal(retryAt(JOINED, 3), null, 'then it stops');
  assert.equal(billDay(at('2026-11-03', 10), TZ), 'Tue 3 Nov');
  assert.equal(billDay(Date.UTC(2026, 10, 2, 11, 30), TZ), 'Tue 3 Nov', "it's the Lair's date, not UTC's");
  assert.deepEqual([cardWords({ brand: 'Visa', last4: '4242' }), cardWords({ kind: 'paypal' }), cardWords(null)], ['Visa ending 4242', 'PayPal', 'your card']);
});

test('migration: round 10 adds only new tables, and a round 9 database moves across with its rows', () => {
  const old = fakeCtx();
  // a round 9 database: every migration but the last
  old.storage.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  for (const step of MIGRATIONS.slice(0, -1)) for (const statement of step) old.storage.sql.exec(statement);
  old.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)", String(MIGRATIONS.length - 1));
  old.storage.sql.exec("INSERT INTO members (customer_id, name, code, created_at) VALUES ('1001', 'Sam Jones', 'SJ-OWLBEAR-17', 1)");
  const last = MIGRATIONS[MIGRATIONS.length - 1];
  assert.ok(last.every((s) => /^(CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS)/.test(s.trim())), 'only new tables and indexes');
  const moved = new Lair(old, { CURRENCY: 'NZD' });
  assert.equal(moved.memberRow('1001').code, 'SJ-OWLBEAR-17');
  assert.equal(moved.sql.exec("SELECT value FROM meta WHERE key = 'schema'").one().value, String(MIGRATIONS.length));
  for (const table of ['memberships', 'membership_charges', 'damage_charges', 'membership_events']) {
    assert.equal(moved.sql.exec('SELECT COUNT(*) AS n FROM ' + table).one().n, 0, table);
  }
});

/* ---------------- joining ---------------- */
test('a contract made at checkout becomes a membership: Stash, next bill a month on, the card; Sam is welcomed, staff hear, and the library counts 3 games', async () => {
  const mail = captureEmails();
  try {
    await join();
    await settle();
    const m = membership();
    assert.deepEqual(
      [m.customer_id, m.status, m.tier, m.billing_tier, m.price, m.next_cycle, m.next_bill_at, m.payment_method_id, m.source],
      [SAM, 'active', 'stash', 'stash', 6000, 1, months(JOINED, 1), PM, 'checkout'],
      'the checkout paid October, so the first renewal is cycle 1, billed at its end on 3 November',
    );
    assert.equal(lair.memberRow(SAM).name, 'Sam Jones', 'a new member is remembered, with their name from Shopify');
    const welcome = mail.sent.find((e) => e.to === 'sam@example.com');
    assert.equal(welcome.subject, 'Welcome to the Dice Goblin library!');
    assert.match(welcome.text, /Stash: 3 games at a time/);
    assert.match(welcome.text, /Tue 3 Nov/);
    assert.match(welcome.text, /Visa ending 4242/);
    assert.match(welcome.text, /7 days to bring the bits back/);
    assert.ok(mail.sent.some((e) => e.to === 'staff@dicegoblin.test' && /New library member: Sam Jones \(Stash\)/.test(e.subject)));
    const mine = await me();
    assert.deepEqual(mine.library.plan, { name: 'Stash', games: 3 }, 'the plan now comes from the membership, not Simplee tags');
    assert.equal(mine.membership.status, 'active');
    assert.deepEqual(mine.membership.tier, { key: 'stash', name: 'Stash', games: 3, price: 6000 });
    assert.deepEqual([mine.membership.nextBillAt, mine.membership.nextAmount, mine.membership.canChange, mine.membership.canCancel], [months(JOINED, 1), 6000, true, true]);
    assert.deepEqual(mine.membership.card, { kind: 'card', brand: 'Visa', last4: '4242', expMonth: 8, expYear: 2030 });
    assert.deepEqual(mine.membership.plans.map((p) => p.key), ['grab', 'stash', 'hoard']);
  } finally {
    mail.restore();
  }
});

test('webhooks: a repeat (same webhook id) does nothing; a contract that is not a library plan is left alone; an unknown charge is ignored', async () => {
  const c = contract();
  const payload = { admin_graphql_api_id: c.gid, id: 501 };
  assert.equal((await hook('subscription_contracts/create', payload, 'wh-same')).data.created, CONTRACT);
  assert.equal((await hook('subscription_contracts/create', payload, 'wh-same')).data.repeat, true);
  contract({ id: '502' });
  shop.state.contracts.get('502').lines[0] = { ...shop.state.contracts.get('502').lines[0], sellingPlanId: 'gid://shopify/SellingPlan/999', sellingPlanName: 'Coffee club' };
  assert.equal((await hook('subscription_contracts/create', { admin_graphql_api_id: 'gid://shopify/SubscriptionContract/502' })).data.ignored, '502');
  assert.equal(membership('502'), null);
  const stray = await hook('subscription_billing_attempts/success', { admin_graphql_api_id: 'gid://shopify/SubscriptionBillingAttempt/1', idempotency_key: 'someone-else' });
  assert.equal(stray.data.unknown, 'someone-else');
});

test('the webhook route checks Lair Memberships\' own signature and the shop before passing it to the Lair', async () => {
  const seen = [];
  const env = {
    SHOP: 'dice-goblin.myshopify.com', MEMBERSHIPS_CLIENT_SECRET: 'shpss_test_secret', SHOPIFY_CLIENT_SECRET: 'the-other-app',
    LAIR: { idFromName: () => 'id', get: () => ({ fetch: async (req) => { seen.push([new URL(req.url).pathname, req.headers.get('X-Lair-Internal'), await req.text()]); return new Response('{"ok":true}'); } }) },
  };
  const body = JSON.stringify({ admin_graphql_api_id: 'gid://shopify/SubscriptionContract/501' });
  const sign = async (secret) => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))));
  };
  const send = async (secret, shopDomain = env.SHOP) => worker.fetch(new Request('https://lair.test/webhooks/memberships', {
    method: 'POST', body,
    headers: { 'X-Shopify-Hmac-Sha256': await sign(secret), 'X-Shopify-Shop-Domain': shopDomain, 'X-Shopify-Topic': 'subscription_contracts/create', 'X-Shopify-Webhook-Id': 'abc-1' },
  }), env, { waitUntil: () => {} });
  assert.equal((await send('the-other-app')).status, 401, "the Lair's own app's secret doesn't sign these");
  assert.equal((await send('shpss_test_secret', 'someone-else.myshopify.com')).status, 401);
  assert.equal(seen.length, 0);
  assert.equal((await send('shpss_test_secret')).status, 200);
  assert.deepEqual(seen, [['/internal/memberships-webhook', '1', JSON.stringify({ topic: 'subscription_contracts/create', webhookId: 'abc-1', payload: JSON.parse(body) })]]);
});

/* ---------------- billing ---------------- */
test('billing is off until MEMBERSHIPS_BILLING is on: the renewal waits (and says so); nothing is charged', async () => {
  open({ billing: false });
  await join();
  setNow(months(JOINED, 1) + MIN);
  const run = await maintenance();
  assert.deepEqual([run.billing, run.charged, run.waiting], ['off', [], 1]);
  assert.equal(shop.state.billCalls.length, 0);
  assert.deepEqual(shop.state.hooks, ['https://lair.test/webhooks/memberships'], 'the webhooks are still put in place');
});

test('a renewal: billed once at its cycle with a key, paid by webhook, then the next cycle is a month on; a second run never bills it twice', async () => {
  await join();
  setNow(months(JOINED, 1) - HOUR);
  assert.deepEqual((await maintenance()).charged, [], 'not before its date');
  setNow(months(JOINED, 1) + MIN);
  const run = await maintenance();
  assert.equal(run.charged.length, 1);
  assert.deepEqual(shop.state.billCalls, [{ contractId: CONTRACT, cycle: 1, key: 'lair-membership-501-c1-a1' }]);
  const [c] = charges();
  assert.deepEqual([c.kind, c.status, c.cycle, c.attempt, c.amount, c.tier], ['renewal', 'pending', 1, 1, 6000, 'stash']);
  await maintenance();
  assert.equal(shop.state.billCalls.length, 1, 'a charge in flight is never started again');
  const paid = await answer('lair-membership-501-c1-a1', 'paid');
  assert.equal(paid.data.status, 'paid');
  const m = membership();
  assert.deepEqual([m.status, m.next_cycle, m.next_bill_at, m.fail_count], ['active', 2, months(JOINED, 2), 0]);
  assert.equal(charges()[0].order_id, 'gid://shopify/Order/1600');
  await maintenance();
  assert.equal(shop.state.billCalls.length, 1, 'paid: nothing more until December');
  assert.equal((await answer('lair-membership-501-c1-a1', 'paid')).data.already, 'paid', 'the same webhook again changes nothing');
});

test('a claim that never reached Shopify (the Worker stopped, or Shopify was down) is sent again with the same key, so it is one charge', async () => {
  await join();
  setNow(months(JOINED, 1) + MIN);
  shop.state.billThrows = 1;
  await maintenance();
  assert.equal(charges()[0].status, 'claimed', 'claimed, but Shopify never answered');
  setNow(clock + 5 * MIN);
  await maintenance();
  assert.equal(shop.state.billCalls.length, 1, 'not again straight away');
  setNow(clock + 15 * MIN);
  await maintenance();
  assert.deepEqual(shop.state.billCalls.map((b) => b.key), ['lair-membership-501-c1-a1', 'lair-membership-501-c1-a1'], 'the same key both times');
  assert.equal(charges().length, 1);
  assert.equal(charges()[0].status, 'pending');
});

test('a charge whose webhook never came is asked about after 30 minutes', async () => {
  await join();
  setNow(months(JOINED, 1) + MIN);
  await maintenance();
  const attemptId = shop.state.keys.get('lair-membership-501-c1-a1');
  shop.state.attempts.get(attemptId).state = { state: 'paid', orderId: 'gid://shopify/Order/1601' };
  shop.state.cycles.get(CONTRACT)[0].billed = true;
  setNow(clock + 31 * MIN);
  await maintenance();
  assert.deepEqual([charges()[0].status, membership().next_cycle], ['paid', 2]);
});

test('a failed renewal: Shopify emails a card link, Sam is told, borrowing pauses; tries again 3 days later, then a week after the first failure; then it ends', async () => {
  const mail = captureEmails();
  try {
    await join();
    const due = months(JOINED, 1);
    setNow(due + MIN);
    await maintenance();
    await answer('lair-membership-501-c1-a1', 'INSUFFICIENT_FUNDS');
    await settle();
    let m = membership();
    assert.deepEqual([m.status, m.fail_count, m.retry_at, m.tier], ['past_due', 1, due + MIN + 3 * DAY, 'stash']);
    assert.deepEqual(shop.state.cardEmails, [PM], "Shopify's card update email, on the first failure");
    const told = mail.sent.find((e) => e.to === 'sam@example.com' && /didn't go through/.test(e.subject));
    assert.match(told.text, /Shopify has emailed you a secure link/);
    assert.match(told.text, /borrowing new games is paused/i);
    assert.equal(charges()[0].error_code, 'INSUFFICIENT_FUNDS', 'the error code, whatever case Shopify sends it in');
    // borrowing is paused (they keep what they have)
    const mine = await me();
    assert.deepEqual(mine.library.plan, { name: 'Stash', games: 3, blocked: true });
    assert.equal(mine.membership.status, 'past_due');
    const hold = await call('POST', 'library/holds', { variantId: '8002', title: 'Azul', productId: '9002', shelfCode: 'DGL34', handle: 'azul-library' }, SAM);
    assert.equal(said(hold), `402 ${MEMBERSHIP_MESSAGES.blocked}`);
    // try 2, three days later
    setNow(due + MIN + 3 * DAY - HOUR);
    await maintenance();
    assert.equal(shop.state.billCalls.length, 1);
    setNow(due + MIN + 3 * DAY + MIN);
    await maintenance();
    assert.deepEqual(shop.state.billCalls.map((b) => b.key), ['lair-membership-501-c1-a1', 'lair-membership-501-c1-a2']);
    await answer('lair-membership-501-c1-a2', 'CARD_DECLINED');
    m = membership();
    assert.deepEqual([m.status, m.fail_count, m.retry_at], ['past_due', 2, due + MIN + 7 * DAY]);
    assert.equal(shop.state.cardEmails.length, 1, 'the card email only goes once');
    // try 3, a week after the first failure: the last
    setNow(due + MIN + 7 * DAY + MIN);
    await maintenance();
    await answer('lair-membership-501-c1-a3', 'CARD_DECLINED');
    await settle();
    m = membership();
    assert.deepEqual([m.status, m.end_reason], ['ending', 'payment']);
    assert.ok(mail.sent.some((e) => e.to === 'sam@example.com' && e.subject === 'Your library membership has ended' && /after 3 tries/.test(e.text)));
    assert.ok(mail.sent.some((e) => e.to === 'staff@dicegoblin.test' && /failed for good: Sam Jones/.test(e.subject)));
    // the next run marks it failed in Shopify
    await maintenance();
    assert.deepEqual(shop.state.ended, [[CONTRACT, 'fail']]);
    m = membership();
    assert.deepEqual([m.status, m.shopify_status], ['ended', 'FAILED']);
    assert.equal((await me()).library.plan, null, 'no plan any more');
  } finally {
    mail.restore();
  }
});

test('a new card while a payment is outstanding: the next run tries again straight away', async () => {
  await join();
  setNow(months(JOINED, 1) + MIN);
  await maintenance();
  await answer('lair-membership-501-c1-a1', 'EXPIRED_CARD');
  setNow(clock + HOUR);
  shop.state.contracts.get(CONTRACT).card = { kind: 'card', brand: 'Mastercard', last4: '5454', expMonth: 1, expYear: 2031 };
  const res = await hook('customer_payment_methods/update', { admin_graphql_api_id: PM, customer_id: 1001, instrument_type: 'CustomerCreditCard' });
  assert.deepEqual([res.data.memberships, res.data.retried], [1, 1]);
  assert.equal(JSON.parse(membership().card).last4, '5454');
  await maintenance();
  assert.deepEqual(shop.state.billCalls.map((b) => b.key), ['lair-membership-501-c1-a1', 'lair-membership-501-c1-a2']);
  await answer('lair-membership-501-c1-a2', 'paid');
  assert.deepEqual([membership().status, membership().next_cycle], ['active', 2]);
  assert.deepEqual((await me()).library.plan, { name: 'Stash', games: 3 }, 'borrowing is back on');
});

test('a bank check (3D Secure): Shopify emails Sam; left for 3 days, it counts as a failed try', async () => {
  await join();
  const due = months(JOINED, 1);
  setNow(due + MIN);
  await maintenance();
  await answer('lair-membership-501-c1-a1', 'action');
  assert.equal(charges()[0].status, 'challenged');
  assert.equal(membership().status, 'active', 'still active while the bank check waits');
  setNow(due + 2 * DAY);
  await maintenance();
  assert.equal(charges()[0].status, 'challenged');
  setNow(due + 3 * DAY + HOUR);
  await maintenance();
  assert.deepEqual([charges()[0].status, charges()[0].error_code, membership().status], ['failed', 'AUTHENTICATION_REQUIRED', 'past_due']);
});

test('a contract Shopify says has ended can\'t be billed: the membership ends', async () => {
  await join();
  setNow(months(JOINED, 1) + MIN);
  shop.state.billErrors = [{ code: 'CONTRACT_TERMINATED', message: 'Contract is terminated.' }];
  await maintenance();
  assert.deepEqual([membership().status, charges()[0].status], ['ended', 'failed']);
});

/* ---------------- plan changes ---------------- */
test('changing plan: the price changes from the next bill, the games at a time when that bill is paid (up then down before it can\'t skip paying)', async () => {
  const mail = captureEmails();
  try {
    await join();
    const up = await call('POST', 'me/membership/change', { tier: 'hoard' }, SAM);
    assert.equal(up.status, 200, up.data.error);
    assert.deepEqual(shop.state.planChanges, [{ contractId: CONTRACT, lineId: 'gid://shopify/SubscriptionLine/5011', sellingPlanId: PLAN_IDS.hoard, sellingPlanName: 'Hoard', price: 7500 }]);
    assert.deepEqual([up.data.membership.tier.key, up.data.membership.nextTier.key, up.data.membership.nextAmount], ['stash', 'hoard', 7500]);
    assert.deepEqual((await me()).library.plan, { name: 'Stash', games: 3 }, 'Stash until the Hoard bill is paid');
    await settle();
    assert.match(mail.sent.find((e) => e.subject === 'Your library plan changes to Hoard').text, /From your next bill on Tue 3 Nov, you're on Hoard: 5 games at a time for \$75 a month/);
    assert.equal(said(await call('POST', 'me/membership/change', { tier: 'hoard' }, SAM)), `409 ${MEMBERSHIP_MESSAGES.same('Hoard')}`);
    assert.equal(said(await call('POST', 'me/membership/change', { tier: 'mega' }, SAM)), `422 ${MEMBERSHIP_MESSAGES.tier}`);
    // the renewal bills Hoard, and paying it moves them up
    setNow(months(JOINED, 1) + MIN);
    await maintenance();
    assert.deepEqual([charges()[0].amount, charges()[0].tier], [7500, 'hoard']);
    await answer('lair-membership-501-c1-a1', 'paid');
    assert.deepEqual((await me()).library.plan, { name: 'Hoard', games: 5 });
    // down again: from the next bill
    assert.equal((await call('POST', 'me/membership/change', { tier: 'grab' }, SAM)).status, 200);
    assert.deepEqual((await me()).library.plan, { name: 'Hoard', games: 5 }, 'Hoard is paid until December');
  } finally {
    mail.restore();
  }
});

test('plan changes wait while a payment is outstanding or a bill has a damage charge on it; Shopify down is a 503', async () => {
  await join();
  shop.state.planErrors = [{ code: 'HAS_FUTURE_EDITS', message: 'Cannot update a subscription contract with a current or upcoming billing cycle contract edit.' }];
  assert.equal(said(await call('POST', 'me/membership/change', { tier: 'grab' }, SAM)), `409 ${MEMBERSHIP_MESSAGES.editsWaiting}`);
  shop.state.planErrors = [{ code: 'INVALID', message: 'Nope' }];
  assert.equal(said(await call('POST', 'me/membership/change', { tier: 'grab' }, SAM)), `503 ${MEMBERSHIP_MESSAGES.shopifyDown}`);
  assert.equal(membership().billing_tier, 'stash', 'nothing changed');
  shop.state.planErrors = null;
  setNow(months(JOINED, 1) + MIN);
  await maintenance();
  await answer('lair-membership-501-c1-a1', 'CARD_DECLINED');
  assert.equal(said(await call('POST', 'me/membership/change', { tier: 'grab' }, SAM)), `409 ${MEMBERSHIP_MESSAGES.pastDue}`);
  lair.sql.exec("DELETE FROM meta WHERE key = 'membership-plans'");
  lair.sql.exec("UPDATE memberships SET status = 'active'");
  assert.equal(said(await call('POST', 'me/membership/change', { tier: 'grab' }, SAM)), `503 ${MEMBERSHIP_MESSAGES.plansNotReady}`);
  assert.equal(said(await call('POST', 'me/membership/change', { tier: 'grab' }, KIRI)), `404 ${MEMBERSHIP_MESSAGES.none}`);
  assert.equal(said(await call('POST', 'me/membership/change', { tier: 'grab' })), `401 ${MEMBERSHIP_MESSAGES.login}`);
});

/* ---------------- cancelling ---------------- */
test('cancelling: it runs to the end of the paid month (no bill), can be kept until then, then ends in Shopify; games at home go to staff', async () => {
  const mail = captureEmails();
  try {
    await join();
    gameAtHome('Catan');
    setNow(JOINED + 10 * DAY);
    const cancel = await call('POST', 'me/membership/cancel', {}, SAM);
    assert.equal(cancel.status, 200, cancel.data.error);
    assert.deepEqual([cancel.data.membership.status, cancel.data.membership.cancelAt, cancel.data.membership.canResume], ['cancelling', months(JOINED, 1), true]);
    await settle();
    assert.match(mail.sent.find((e) => e.subject === 'Your library membership is cancelled').text, /runs until Tue 3 Nov, and there are no more bills after that/);
    assert.deepEqual((await me()).library.plan, { name: 'Stash', games: 3 }, 'still borrowing until then');
    // kept, then cancelled again
    assert.equal((await call('POST', 'me/membership/resume', {}, SAM)).data.membership.status, 'active');
    assert.equal(said(await call('POST', 'me/membership/resume', {}, SAM)), `409 ${MEMBERSHIP_MESSAGES.notCancelling}`);
    await call('POST', 'me/membership/cancel', {}, SAM);
    // the month runs out: no charge, the contract is cancelled
    setNow(months(JOINED, 1) + MIN);
    const run = await maintenance();
    assert.deepEqual([run.charged, run.ended], [[], [CONTRACT]]);
    assert.equal(shop.state.billCalls.length, 0);
    assert.deepEqual(shop.state.ended, [[CONTRACT, 'cancel']]);
    assert.deepEqual([membership().status, membership().end_reason], ['ended', 'cancelled']);
    await settle();
    assert.ok(mail.sent.some((e) => e.to === 'sam@example.com' && e.subject === 'Your library membership has ended' && /Catan/.test(e.text)));
    assert.ok(mail.sent.some((e) => e.to === 'staff@dicegoblin.test' && /ended with games at home: Sam Jones/.test(e.subject)));
    assert.equal(said(await call('POST', 'me/membership/resume', {}, SAM)), `404 ${MEMBERSHIP_MESSAGES.none}`);
    const after = await me();
    assert.deepEqual([after.library.plan, after.membership.status, after.membership.live], [null, 'ended', false], 'they still see why for 30 days');
  } finally {
    mail.restore();
  }
});

test('cancelling while the renewal is being paid: paid, they keep that month; failed, it ends now with no retries', async () => {
  await join();
  setNow(months(JOINED, 1) + MIN);
  await maintenance();
  await call('POST', 'me/membership/cancel', {}, SAM);
  assert.deepEqual([membership().status, membership().cancel_at], ['cancelling', null]);
  await answer('lair-membership-501-c1-a1', 'paid');
  assert.deepEqual([membership().status, membership().cancel_at], ['cancelling', months(JOINED, 2)], 'they paid November, so it runs to 3 December');
  await maintenance();
  assert.equal(membership().status, 'cancelling');
  // and the other way
  open();
  await join({ id: '601' });
  setNow(months(JOINED, 1) + MIN);
  await maintenance();
  await call('POST', 'me/membership/cancel', {}, SAM);
  await answer('lair-membership-601-c1-a1', 'CARD_DECLINED');
  assert.deepEqual([membership('601').status, membership('601').cancel_at, membership('601').retry_at], ['cancelling', clock, null]);
  await maintenance();
  assert.deepEqual([membership('601').status, shop.state.billCalls.length], ['ended', 1]);
});

test('a payment outstanding and then cancelled: it ends straight away (that month was never paid)', async () => {
  await join();
  setNow(months(JOINED, 1) + MIN);
  await maintenance();
  await answer('lair-membership-501-c1-a1', 'CARD_DECLINED');
  setNow(clock + HOUR);
  await call('POST', 'me/membership/cancel', {}, SAM);
  assert.deepEqual([membership().status, membership().cancel_at], ['cancelling', clock]);
  await maintenance();
  assert.deepEqual([membership().status, shop.state.billCalls.length], ['ended', 1], 'no more tries');
});

/* ---------------- damage charges ---------------- */
test('a damage charge: an itemised notice, 7 days to sort it, then it rides on the next bill (that cycle only) and is paid with it', async () => {
  const mail = captureEmails();
  try {
    await join();
    const loan = gameAtHome('Catan');
    setNow(JOINED + 20 * DAY);
    const res = await logDamage({ customerId: SAM, loanId: loan.id, reason: 'missing', details: '3 wooden sheep', amount: 1500 });
    assert.equal(res.status, 200, res.data.error);
    const id = res.data.charge.id;
    assert.deepEqual([res.data.charge.status, res.data.charge.amount, res.data.charge.title, res.data.charge.dueAt, res.data.charge.emailed, res.data.charge.billable], ['notice', 1500, 'Catan', clock + FEE_NOTICE_DAYS * DAY, true, true]);
    await settle();
    const notice = mail.sent.find((e) => e.to === 'sam@example.com' && /About Catan/.test(e.subject));
    assert.match(notice.text, /Catan came back with a problem: 3 wooden sheep/);
    assert.match(notice.text, /\$15/);
    assert.match(notice.text, /Bring them in before Fri 30 Oct/);
    assert.match(notice.text, /Tue 3 Nov \(not before Fri 30 Oct\)/);
    // GET /me shows it
    assert.deepEqual((await me()).membership.damage.map((f) => [f.title, f.status, f.amount]), [['Catan', 'notice', 1500]]);
    // the notice runs out: due, and on the next bill
    setNow(JOINED + 28 * DAY);
    await maintenance();
    assert.equal(fee(id).status, 'due');
    assert.equal((await me()).membership.nextAmount, 7500, '$60 plus the $15 charge');
    setNow(months(JOINED, 1) + MIN);
    await maintenance();
    assert.deepEqual(shop.state.editCalls, [{
      contractId: CONTRACT, cycle: 1, feeVariantId: FEE_VARIANT, dropPlan: false, fees: [{ id, amount: 1500, label: 'Missing parts: Catan (3 wooden sheep)' }],
    }]);
    const [c] = charges();
    assert.deepEqual([c.amount, JSON.parse(c.fees), fee(id).status, fee(id).charge_id], [7500, [id], 'billing', c.id]);
    await answer(c.idempotency_key, 'paid');
    assert.deepEqual([fee(id).status, membership().next_cycle], ['paid', 2]);
  } finally {
    mail.restore();
  }
});

test('damage charges: disputed (waits, staff hear), waived (Sam hears), put back, a new amount; who may do what', async () => {
  const mail = captureEmails();
  try {
    await join();
    gameAtHome('Azul');
    const { data } = await logDamage({ customerId: SAM, title: 'Azul', reason: 'damaged', details: 'Water damage on the board', amount: 4000 });
    const id = data.charge.id;
    assert.equal(said(await call('POST', `me/damage/${id}/dispute`, { note: 'It was like that when I got it' }, KIRI)), `403 ${MEMBERSHIP_MESSAGES.feeNotYours}`);
    const disputed = await call('POST', `me/damage/${id}/dispute`, { note: 'It was like that when I got it' }, SAM);
    assert.deepEqual([disputed.status, disputed.data.charge.status, disputed.data.charge.disputeNote], [200, 'disputed', 'It was like that when I got it']);
    await settle();
    assert.ok(mail.sent.some((e) => e.to === 'staff@dicegoblin.test' && /Damage charge disputed: Sam Jones, Azul/.test(e.subject) && /like that when I got it/.test(e.text)));
    // a disputed charge never goes on a bill
    setNow(JOINED + 40 * DAY);
    await maintenance();
    assert.equal(fee(id).status, 'disputed');
    assert.deepEqual(shop.state.editCalls, [], 'the renewal went without it');
    // staff: a helper with only library can log but not waive
    assert.equal((await call('POST', `library/damage/${id}/update`, { action: 'waive' }, 'helper')).status, 403);
    assert.equal((await call('POST', `library/damage/${id}/update`, { action: 'amount', amount: 2500 }, 'staff')).data.charge.amount, 2500);
    assert.equal((await call('POST', `library/damage/${id}/update`, { action: 'waive', note: 'Fair enough' }, 'staff')).data.charge.status, 'waived');
    await settle();
    assert.ok(mail.sent.some((e) => e.to === 'sam@example.com' && e.subject === 'Good news: the Azul charge is cancelled' && /\$25/.test(e.text)));
    assert.equal((await call('POST', `library/damage/${id}/update`, { action: 'reinstate' }, 'staff')).data.charge.status, 'due', 'its notice ran out long ago');
    assert.equal(said(await call('POST', `library/damage/${id}/update`, { action: 'amount', amount: 2000 }, 'staff')), `409 ${MEMBERSHIP_MESSAGES.feeChange}`);
    assert.equal(said(await call('POST', `library/damage/${id}/update`, { action: 'nope' }, 'staff')), `422 ${MEMBERSHIP_MESSAGES.feeAction}`);
    // the rules on logging one
    assert.equal(said(await logDamage({ customerId: SAM, title: 'Azul', reason: 'damaged', amount: 50 })), `422 ${MEMBERSHIP_MESSAGES.feeAmount}`);
    assert.equal(said(await logDamage({ customerId: SAM, title: 'Azul', reason: 'damaged', amount: 50001 })), `422 ${MEMBERSHIP_MESSAGES.feeAmount}`);
    assert.equal(said(await logDamage({ customerId: SAM, title: 'Azul', reason: 'chewed', amount: 1000 })), `422 ${MEMBERSHIP_MESSAGES.feeReason}`);
    assert.equal(said(await logDamage({ customerId: SAM, reason: 'lost', amount: 1000 })), `422 ${MEMBERSHIP_MESSAGES.feeTitle}`);
    assert.equal(said(await logDamage({ customerId: '9999', title: 'Azul', reason: 'lost', amount: 1000 })), `404 ${MEMBERSHIP_MESSAGES.feeMember}`);
    assert.equal(said(await logDamage({ customerId: SAM, loanId: 'ln_nope', reason: 'lost', amount: 1000 })), `404 ${MEMBERSHIP_MESSAGES.feeLoan}`);
    assert.equal((await logDamage({ customerId: SAM, title: 'Azul', reason: 'lost', amount: 1000 }, 'shelf')).status, 403, 'a check-in-only helper cannot');
    assert.equal((await logDamage({ customerId: SAM, title: 'Azul', reason: 'lost', amount: 1000 }, 'helper')).status, 200, 'a library helper can');
    assert.equal((await logDamage({ customerId: SAM, title: 'Azul', reason: 'lost', amount: 1000 }, SAM)).status, 403);
    const list = await call('GET', 'library/damage?status=all', null, 'staff');
    assert.equal(list.data.charges.length, 2);
    assert.deepEqual([list.data.charges[1].name, list.data.charges[1].code.length > 0], ['Sam Jones', true]);
  } finally {
    mail.restore();
  }
});

test('Shopify won\'t take the damage charge onto the bill: the renewal goes ahead without it, it waits for the next one, staff hear', async () => {
  const mail = captureEmails();
  try {
    await join();
    const { data } = await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
    setNow(months(JOINED, 1) + MIN);
    shop.state.editErrors = [{ code: 'INVALID', message: 'Variant not found' }];
    await maintenance();
    const [c] = charges();
    assert.deepEqual([c.status, c.amount, JSON.parse(c.fees)], ['pending', 6000, []]);
    assert.equal(fee(data.charge.id).status, 'due');
    await settle();
    assert.ok(mail.sent.some((e) => e.to === 'staff@dicegoblin.test' && /Damage charges left off a library bill/.test(e.subject)));
  } finally {
    mail.restore();
  }
});

test('a damage charge on a renewal that fails for good goes to staff as unpaid', async () => {
  await join();
  const { data } = await logDamage({ customerId: SAM, title: 'Catan', reason: 'lost', amount: 5000 });
  const due = months(JOINED, 1);
  setNow(due + MIN);
  await maintenance();
  assert.equal(fee(data.charge.id).status, 'billing');
  await answer('lair-membership-501-c1-a1', 'CARD_DECLINED');
  assert.equal(fee(data.charge.id).status, 'billing', 'still on the bill while it is retried');
  for (const [day, attempt] of [[3, 2], [7, 3]]) {
    setNow(due + MIN + day * DAY + MIN);
    await maintenance();
    await answer(`lair-membership-501-c1-a${attempt}`, 'CARD_DECLINED');
  }
  assert.deepEqual(shop.state.editCalls.length, 3, 'each try puts the charge back on that cycle');
  assert.equal(fee(data.charge.id).status, 'unpaid');
  assert.equal(membership().status, 'ending');
});

test('cancelled with a damage charge owed: billed on its own when the month runs out (no month\'s fee), then the membership ends', async () => {
  await join();
  const { data } = await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
  setNow(JOINED + 10 * DAY);
  await call('POST', 'me/membership/cancel', {}, SAM);
  setNow(months(JOINED, 1) + MIN);
  const run = await maintenance();
  assert.deepEqual(run.ended, [], 'not yet: a charge is owed');
  const [c] = charges();
  assert.deepEqual([c.kind, c.amount, c.cycle], ['fees', 1500, 1]);
  assert.deepEqual([shop.state.editCalls[0].dropPlan, shop.state.editCalls[0].fees.map((f) => f.amount)], [true, [1500]], 'the month line comes off that bill');
  await answer(c.idempotency_key, 'paid');
  assert.equal(fee(data.charge.id).status, 'paid');
  assert.equal(membership().status, 'cancelling');
  await maintenance();
  assert.deepEqual([membership().status, shop.state.ended], ['ended', [[CONTRACT, 'cancel']]]);
});

test('cancelled with a damage charge still in its notice: nothing is billed until it is due, then it goes on its own', async () => {
  await join();
  const cancelDay = months(JOINED, 1);
  setNow(cancelDay - 2 * DAY);
  const { data } = await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
  await call('POST', 'me/membership/cancel', {}, SAM);
  setNow(cancelDay + MIN);
  await maintenance();
  assert.deepEqual([charges().length, membership().status, fee(data.charge.id).status], [0, 'cancelling', 'notice'], 'its 7 days are not up');
  assert.equal((await me()).library.plan, null, 'but they can\'t borrow any more');
  setNow(cancelDay - 2 * DAY + FEE_NOTICE_DAYS * DAY + MIN);
  await maintenance();
  assert.deepEqual([charges().length, charges()[0].kind], [1, 'fees']);
  await answer(charges()[0].idempotency_key, 'paid');
  await maintenance();
  assert.equal(membership().status, 'ended');
});

test('a damage charge waived before the notice runs out never touches a bill, and a cancelled membership with nothing owed ends', async () => {
  await join();
  const { data } = await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
  await call('POST', `library/damage/${data.charge.id}/update`, { action: 'waive' }, 'staff');
  await call('POST', 'me/membership/cancel', {}, SAM);
  setNow(months(JOINED, 1) + MIN);
  const run = await maintenance();
  assert.deepEqual([run.charged, run.ended, shop.state.editCalls.length], [[], [CONTRACT], 0]);
});

test('a charge being paid right now can\'t be waived', async () => {
  await join();
  const { data } = await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
  setNow(months(JOINED, 1) + MIN);
  await maintenance();
  assert.equal(said(await call('POST', `library/damage/${data.charge.id}/update`, { action: 'waive' }, 'staff')), `409 ${MEMBERSHIP_MESSAGES.feeLocked}`);
  await answer('lair-membership-501-c1-a1', 'CARD_DECLINED');
  assert.equal((await call('POST', `library/damage/${data.charge.id}/update`, { action: 'waive' }, 'staff')).data.charge.status, 'waived', 'between tries it can');
  setNow(clock + 3 * DAY + MIN);
  await maintenance();
  assert.deepEqual(shop.state.editCalls.length, 1, 'the retry goes without it');
  assert.equal(charges()[1].amount, 6000);
});

/* ---------------- staff and Shopify changes ---------------- */
test('staff: the memberships list, a retry now, and ending one now; members and check-in helpers can\'t', async () => {
  await join();
  await join({ id: '502', customerId: KIRI, tier: 'grab' });
  const list = await call('GET', 'memberships', null, 'staff');
  assert.equal(list.status, 200, list.data.error);
  assert.deepEqual(list.data.memberships.map((m) => [m.id, m.name, m.tier.key, m.status]).sort(), [['501', 'Sam Jones', 'stash', 'active'], ['502', 'Kiri Smith', 'grab', 'active']]);
  assert.deepEqual([list.data.billing, list.data.counts.active], ['on', 2]);
  assert.equal((await call('GET', 'memberships', null, SAM)).status, 403);
  assert.equal((await call('GET', 'memberships', null, 'shelf')).status, 403);
  assert.equal((await call('GET', 'memberships', null, 'helper')).status, 200, 'library helpers see them');
  assert.equal(said(await call('POST', 'memberships/501/retry', {}, 'staff')), `409 ${MEMBERSHIP_MESSAGES.retryNotDue}`);
  setNow(months(JOINED, 1) + MIN);
  await maintenance();
  await answer('lair-membership-501-c1-a1', 'CARD_DECLINED');
  setNow(clock + HOUR);
  const retry = await call('POST', 'memberships/501/retry', {}, 'staff');
  assert.equal(retry.data.membership.retryAt, clock);
  await maintenance();
  assert.equal(shop.state.billCalls.filter((b) => b.contractId === '501').length, 2);
  assert.equal(said(await call('POST', 'memberships/502/cancel', { when: 'whenever' }, 'staff')), `422 ${MEMBERSHIP_MESSAGES.staffWhen}`);
  assert.equal((await call('POST', 'memberships/502/cancel', { when: 'now' }, 'helper')).status, 403, 'ending one needs money');
  const ended = await call('POST', 'memberships/502/cancel', { when: 'now' }, 'staff');
  assert.equal(ended.data.membership.status, 'cancelling');
  await answer('lair-membership-502-c1-a1', 'paid');
  assert.equal(membership('502').status, 'cancelling', 'paid after staff ended it: they keep the month it paid for');
  const page = await call('GET', `members/${KIRI}`, null, 'staff');
  assert.equal(page.data.member.membership.id, '502');
});

test('Shopify ends or pauses a contract (the app uninstalled, or an admin): the membership follows; an older version of the contract is ignored', async () => {
  await join();
  const { data } = await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
  const c = shop.state.contracts.get(CONTRACT);
  c.status = 'PAUSED';
  c.revisionId = '5';
  await hook('subscription_contracts/pause', { admin_graphql_api_id: c.gid });
  assert.equal(membership().status, 'paused');
  assert.equal((await me()).library.plan, null);
  c.status = 'ACTIVE';
  c.revisionId = '3';
  assert.equal((await hook('subscription_contracts/update', { admin_graphql_api_id: c.gid })).data.stale, CONTRACT, 'revision 3 is older than 5');
  assert.equal(membership().status, 'paused');
  c.revisionId = '6';
  await hook('subscription_contracts/activate', { admin_graphql_api_id: c.gid });
  assert.equal(membership().status, 'active');
  c.status = 'CANCELLED';
  c.revisionId = '7';
  await hook('subscription_contracts/cancel', { admin_graphql_api_id: c.gid });
  assert.deepEqual([membership().status, membership().end_reason, fee(data.charge.id).status], ['ended', 'shopify:cancelled', 'unpaid']);
});

test('setup: the plans and the damage charge product are made once and saved; the plans go on MEMBERSHIPS_PRODUCT_ID when it is set', async () => {
  lair.sql.exec("DELETE FROM meta WHERE key IN ('membership-plans', 'membership-fee-variant')");
  lair.baseEnv = { ...lair.baseEnv, MEMBERSHIPS_PRODUCT_ID: '7532313641063' };
  const res = await internal('setup', { webhookUrl: 'https://lair.test/webhooks/orders-paid', memberships: 'plans' });
  const s = res.data.membershipsSetup;
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.deepEqual([s.madePlans, s.madeFeeProduct, s.feeVariantId, s.productIds], [true, true, FEE_VARIANT, ['gid://shopify/Product/7532313641063']]);
  assert.deepEqual(Object.keys(s.plans), ['grab', 'stash', 'hoard']);
  assert.deepEqual(lair.membershipPlans().plans.hoard, { id: PLAN_IDS.hoard, name: 'Hoard', price: 7500 });
  assert.equal(lair.feeVariantId(), FEE_VARIANT);
  const again = (await internal('setup', { webhookUrl: 'https://lair.test/webhooks/orders-paid', memberships: 'plans' })).data.membershipsSetup;
  assert.deepEqual([again.madePlans, again.madeFeeProduct, shop.state.groups.length, shop.state.madeProducts], [undefined, undefined, 1, 1], 'found, not made again');
  // without the permissions it says which
  shop.admin.appInfo = async () => ({ app: 'Lair Memberships', scopes: ['write_products'] });
  const missing = (await internal('setup', { webhookUrl: 'https://lair.test/webhooks/orders-paid', memberships: 'plans' })).data.membershipsSetup;
  assert.equal(missing.ok, false);
  assert.ok(missing.missingScopes.includes('write_own_subscription_contracts'));
});

test('a member with Simplee tags and no membership keeps their plan until they move across; a membership wins over tags', async () => {
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: false, tags: id === SAM ? ['hoard - board game rental'] : [] });
  assert.deepEqual((await me()).library.plan, { name: 'Hoard', games: 5 });
  assert.equal((await me()).membership, null);
  await join({ tier: 'grab' });
  assert.deepEqual((await me()).library.plan, { name: 'Grab', games: 1 });
});

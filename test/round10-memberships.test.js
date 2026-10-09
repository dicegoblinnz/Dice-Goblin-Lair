// Round 10, library memberships: the Lair bills Grab, Stash and Hoard itself through Lair Memberships (Shopify
// subscription contracts), replacing Simplee. Mo (9 Oct 2026): "I want to build a new Shopify app to help replace the
// subscription app that I have called simplee", with damage charges on the member's next bill after a 7-day notice,
// and a cancelled membership running to the end of the month they've paid for.
// The second half covers the review's billing scenarios: never twice, never early, never what was waived.
// Run with: npm test   (under TZ=UTC and TZ=Pacific/Auckland)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair, MIGRATIONS } from '../src/lair.js';
import worker from '../src/index.js';
import { LairTime, rulesFromSettings } from '../src/core.js';
import {
  FEE_NOTICE_DAYS, MAX_ATTEMPTS, MEMBERSHIP_MESSAGES, MEMBERSHIP_SCOPES, MEMBERSHIP_TOPICS, MembershipsAdmin, RETRY_DAYS, TIERS, attemptState, billDay, cardWords,
  chargeKey, numericId, payNowKey, retryAt, tierOf,
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
const AZUL = { variantId: '8002', title: 'Azul', productId: '9002', shelfCode: 'DGL34', handle: 'azul-library' };

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
const setEnv = (more) => {
  lair.baseEnv = { ...lair.baseEnv, ...more };
};

/** Month n after `from`, the same clock time (the fake's billing cycles) */
const months = (from, n) => {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.getTime();
};

/** Turn on emails and catch everything sent to Resend. */
function captureEmails() {
  setEnv({ RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test' });
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return { sent, restore: () => { globalThis.fetch = realFetch; } };
}
const toSam = (mail) => mail.sent.filter((e) => e.to === 'sam@example.com');
const toStaff = (mail, pattern) => mail.sent.find((e) => e.to === 'staff@dicegoblin.test' && pattern.test(e.subject));

/**
 * A fake Lair Memberships: contracts with monthly billing cycles (each cycle billed at its end), billing attempts that
 * stay pending until the test settles them, cycle edits that change what a bill charges (the plan line can come off,
 * damage charge lines go on), an idempotency key that always gives back the same attempt, attempts found by their key,
 * plan changes, card emails and webhooks. It can also drop a request before it arrives (billThrows), lose the answer
 * after making the attempt (billLost), or hold a bill part-way (billGate).
 */
function fakeMemberships() {
  const state = {
    contracts: new Map(), cycles: new Map(), attempts: new Map(), keys: new Map(), edits: new Map(), ended: [], planChanges: [], cardEmails: [],
    billCalls: [], editCalls: [], clearCalls: [], findCalls: [], hooks: [], n: 0,
    billThrows: 0, billLost: 0, billGate: null, onBill: null, billErrors: null, editErrors: null, editThrows: 0, clearErrors: null, planErrors: null,
    groups: [], madeProducts: 0,
    // damage charges taken now: one-off contracts (they can be lost before or after they're made, or refused)
    chargeContractCalls: [], findContractCalls: 0, contractThrows: 0, contractLost: 0, contractErrors: null, endErrors: null,
  };
  const editKey = (contractId, cycle) => `${numericId(contractId)}:${cycle}`;
  const admin = {
    configured: true,
    contract: async (id) => {
      const c = state.contracts.get(numericId(id));
      return c ? JSON.parse(JSON.stringify(c)) : null;
    },
    cycles: async (id, start, end) => (state.cycles.get(numericId(id)) || []).filter((c) => c.index >= start && c.index <= end).map((c) => ({ ...c })),
    bill: async ({ contractId, cycle, key }) => {
      state.billCalls.push({ contractId, cycle, key });
      if (state.billGate) await state.billGate(contractId);
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
      const cid = numericId(contractId);
      const c = state.contracts.get(cid);
      const edit = state.edits.get(editKey(cid, cycle));
      const amount = (edit?.dropPlan ? 0 : c.lines.reduce((sum, l) => sum + l.price * l.quantity, 0)) + (edit?.fees || []).reduce((sum, f) => sum + f.amount, 0);
      state.n += 1;
      const attemptId = `gid://shopify/SubscriptionBillingAttempt/${state.n}`;
      state.keys.set(key, attemptId);
      state.attempts.set(attemptId, { contractId: cid, cycle, key, amount, state: { state: 'pending' } });
      // a webhook that gets in before the answer does
      if (state.onBill) await state.onBill(key);
      if (state.billLost > 0) {
        state.billLost -= 1;
        throw new Error('Shopify API error 504');
      }
      return { attemptId, errors: [] };
    },
    attempt: async (id) => state.attempts.get(id)?.state || null,
    findAttempt: async (contractId, key) => {
      state.findCalls.push(key);
      const id = state.keys.get(key);
      const a = id ? state.attempts.get(id) : null;
      return a && a.contractId === numericId(contractId) ? { id, ...a.state } : null;
    },
    endContract: async (id, how) => {
      state.ended.push([numericId(id), how]);
      if (state.endErrors) return { status: null, errors: state.endErrors };
      const c = state.contracts.get(numericId(id));
      if (c) c.status = how === 'fail' ? 'FAILED' : 'CANCELLED';
      return { status: how === 'fail' ? 'FAILED' : 'CANCELLED', errors: [] };
    },
    // a damage charge's one-off contract: the charge as its only line, one billing cycle (due at billAt), marked with
    // the payment's id
    createChargeContract: async (args) => {
      state.chargeContractCalls.push(JSON.parse(JSON.stringify(args)));
      if (state.contractThrows > 0) {
        state.contractThrows -= 1;
        throw new Error('Shopify API error 502');
      }
      if (state.contractErrors) return { contractId: null, errors: state.contractErrors };
      state.n += 1;
      const id = String(900 + state.n);
      const cgid = `gid://shopify/SubscriptionContract/${id}`;
      state.contracts.set(id, {
        gid: cgid, id, status: 'ACTIVE', createdAt: Date.now(), currency: args.currency, revisionId: '1', customerId: String(args.customerId), paymentMethodId: args.paymentMethodId,
        paymentRevoked: false, card: null, interval: 'DAY', intervalCount: 1, marker: args.paymentId,
        lines: [{ id: `${cgid}1`, sellingPlanId: null, sellingPlanName: '', variantId: args.feeVariantId, productId: 'gid://shopify/Product/990', title: 'Library damage charge', quantity: 1, price: args.fee.amount }],
      });
      state.cycles.set(id, [{ index: 1, startAt: Date.now(), endAt: args.billAt, expectedAt: args.billAt, billed: false, skipped: false, edited: false }]);
      if (state.contractLost > 0) {
        state.contractLost -= 1;
        throw new Error('Shopify API error 504');
      }
      return { contractId: cgid, errors: [] };
    },
    findChargeContract: async (customerId, paymentId) => {
      state.findContractCalls += 1;
      const c = [...state.contracts.values()].find((x) => x.marker === paymentId && x.customerId === String(customerId));
      return c ? { id: c.gid, status: c.status } : null;
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
      if (state.editThrows > 0) {
        state.editThrows -= 1;
        throw new Error('Shopify API error 502');
      }
      // as the real one does: any edit already on the cycle comes off first
      state.edits.delete(editKey(args.contractId, args.cycle));
      if (state.editErrors) return { ok: false, errors: state.editErrors };
      state.edits.set(editKey(args.contractId, args.cycle), JSON.parse(JSON.stringify(args)));
      return { ok: true, errors: [] };
    },
    clearCycleEdit: async ({ contractId, cycle }) => {
      state.clearCalls.push({ contractId: numericId(contractId), cycle });
      if (state.clearErrors) return { ok: false, errors: state.clearErrors };
      state.edits.delete(editKey(contractId, cycle));
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
  /** What a billing attempt charged the card, by its key */
  const charged = (key) => state.attempts.get(state.keys.get(key))?.amount ?? null;
  return { state, admin, charged };
}

/** A contract made at checkout (the origin order paid the first month), with 12 monthly billing cycles */
function contract({ id = CONTRACT, customerId = SAM, tier = 'stash', createdAt = JOINED, price = TIERS[tier].price, card = { kind: 'card', brand: 'Visa', last4: '4242', expMonth: 8, expYear: 2030 } } = {}) {
  shop.state.contracts.set(id, {
    gid: `gid://shopify/SubscriptionContract/${id}`, id, status: 'ACTIVE', createdAt, currency: 'NZD', revisionId: '1', customerId,
    paymentMethodId: PM, paymentRevoked: false, card, interval: 'MONTH', intervalCount: 1,
    lines: [{ id: `gid://shopify/SubscriptionLine/${id}1`, sellingPlanId: PLAN_IDS[tier], sellingPlanName: TIERS[tier].name, variantId: 'gid://shopify/ProductVariant/42179272933479', productId: 'gid://shopify/Product/7532313641063', title: 'Board Game Rental Membership', quantity: 1, price }],
  });
  shop.state.cycles.set(id, Array.from({ length: 12 }, (_, i) => ({
    index: i + 1, startAt: months(createdAt, i), endAt: months(createdAt, i + 1) - 1, expectedAt: months(createdAt, i + 1), billed: false, skipped: false, edited: false,
  })));
  return shop.state.contracts.get(id);
}

/** Make a contract and send its create webhook (with its checkout order, as Shopify's payload has) */
async function join(over = {}) {
  const c = contract(over);
  const res = await hook('subscription_contracts/create', {
    admin_graphql_api_id: c.gid, id: Number(c.id), revision_id: c.revisionId, status: 'active', admin_graphql_api_origin_order_id: 'gid://shopify/Order/1550',
  });
  assert.equal(res.status, 200, res.data.error);
  return c;
}

/** Change a contract in Shopify and send the webhook for it */
async function shopifySays(status, topic, id = CONTRACT) {
  const c = shop.state.contracts.get(id);
  c.status = status;
  c.revisionId = String(Number(c.revisionId) + 1);
  return hook(`subscription_contracts/${topic}`, { admin_graphql_api_id: c.gid });
}

/**
 * Shopify answers a billing attempt (by its key): the cycle is billed on success; the webhook is sent, with no attempt
 * id (as in Shopify's own example payload), so the Lair has to go by the key
 */
async function answer(key, outcome) {
  const attemptId = shop.state.keys.get(key);
  assert.ok(attemptId, `no attempt for ${key}`);
  const attempt = shop.state.attempts.get(attemptId);
  attempt.state = outcome === 'paid' ? { state: 'paid', orderId: 'gid://shopify/Order/1600' } : outcome === 'action' ? { state: 'action', nextActionUrl: 'https://bank.test/3ds' } : { state: 'failed', code: outcome };
  if (outcome === 'paid') shop.state.cycles.get(attempt.contractId).find((c) => c.index === attempt.cycle).billed = true;
  const topic = outcome === 'paid' ? 'subscription_billing_attempts/success' : outcome === 'action' ? 'subscription_billing_attempts/challenged' : 'subscription_billing_attempts/failure';
  return hook(topic, {
    id: null, admin_graphql_api_id: null, idempotency_key: key, subscription_contract_id: Number(attempt.contractId),
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
const updateDamage = (id, body, who = 'staff') => call('POST', `library/damage/${id}/update`, body, who);

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
test('tiers from selling plan names, idempotency keys, retry times, dates and attempt states', () => {
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
  assert.deepEqual(attemptState({ __typename: 'SubscriptionBillingAttemptFailedState', error: { __typename: 'SubscriptionBillingAttemptPaymentError', paymentCode: 'insufficient_funds' } }), { state: 'failed', code: 'INSUFFICIENT_FUNDS', message: null });
  assert.deepEqual(attemptState({ __typename: 'SubscriptionBillingAttemptActionRequiredState', action: { nextActionUrl: 'https://bank.test' } }), { state: 'action', nextActionUrl: 'https://bank.test' });
  assert.deepEqual(attemptState({ __typename: 'SubscriptionBillingAttemptPendingState', processing: true }), { state: 'pending' });
  assert.ok(MEMBERSHIP_SCOPES.includes('read_orders'), "a billing attempt's order needs read_orders");
  assert.ok(MEMBERSHIP_TOPICS.includes('CUSTOMER_PAYMENT_METHODS_CREATE'));
  assert.ok(!/friend/.test(MEMBERSHIP_MESSAGES.none + MEMBERSHIP_MESSAGES.tooLate), "errors that stop someone don't call them friend");
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
  for (const table of ['memberships', 'membership_charges', 'damage_charges', 'damage_payments', 'membership_events']) {
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
      [m.customer_id, m.status, m.tier, m.billing_tier, m.price, m.next_cycle, m.next_bill_at, m.payment_method_id, m.source, m.origin_order_id],
      [SAM, 'active', 'stash', 'stash', 6000, 1, months(JOINED, 1), PM, 'checkout', 'gid://shopify/Order/1550'],
      'the checkout paid October, so the first renewal is cycle 1, billed at its end on 3 November',
    );
    assert.equal(lair.memberRow(SAM).name, 'Sam Jones', 'a new member is remembered, with their name from Shopify');
    const welcome = mail.sent.find((e) => e.to === 'sam@example.com');
    assert.equal(welcome.subject, 'Welcome to the Dice Goblin library!');
    assert.match(welcome.text, /Stash: 3 games at a time/);
    assert.match(welcome.text, /Tue 3 Nov/);
    assert.match(welcome.text, /Visa ending 4242/);
    assert.match(welcome.text, /next bill after 7 days, so there's time to bring the bits back/);
    assert.match(welcome.text, /take it straight away from your store credit or card/, 'the terms say a charge can be taken straight away');
    assert.ok(toStaff(mail, /New library member: Sam Jones \(Stash\)/));
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
  assert.equal(shop.charged('lair-membership-501-c1-a1'), 6000);
  const [c] = charges();
  assert.deepEqual([c.kind, c.status, c.cycle, c.attempt, c.amount, c.tier, c.edit_state, c.sent_at], ['renewal', 'pending', 1, 1, 6000, 'stash', 'done', clock]);
  await maintenance();
  assert.equal(shop.state.billCalls.length, 1, 'a charge in flight is never started again');
  const paid = await answer('lair-membership-501-c1-a1', 'paid');
  assert.equal(paid.data.status, 'paid');
  const m = membership();
  assert.deepEqual([m.status, m.next_cycle, m.next_bill_at, m.paid_through, m.fail_count], ['active', 2, months(JOINED, 2), months(JOINED, 2), 0]);
  assert.equal(charges()[0].order_id, 'gid://shopify/Order/1600');
  await maintenance();
  assert.equal(shop.state.billCalls.length, 1, 'paid: nothing more until December');
  assert.equal((await answer('lair-membership-501-c1-a1', 'paid')).data.already, 'paid', 'the same webhook again changes nothing');
});

test('a bill that never reached Shopify is looked up by its key, then sent again with the same key, so it is one charge', async () => {
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
  assert.deepEqual(shop.state.findCalls, ['lair-membership-501-c1-a1'], 'Shopify is asked first');
  assert.deepEqual(shop.state.billCalls.map((b) => b.key), ['lair-membership-501-c1-a1', 'lair-membership-501-c1-a1'], 'the same key both times');
  assert.equal(charges().length, 1);
  assert.equal(charges()[0].status, 'pending');
});

test('a bill whose answer was lost (Shopify made the attempt) is found by its key and followed, never sent again', async () => {
  await join();
  setNow(months(JOINED, 1) + MIN);
  shop.state.billLost = 1;
  await maintenance();
  assert.equal(charges()[0].status, 'claimed');
  setNow(clock + 16 * MIN);
  await maintenance();
  assert.equal(shop.state.billCalls.length, 1);
  assert.deepEqual([charges()[0].status, charges()[0].attempt_gid], ['pending', 'gid://shopify/SubscriptionBillingAttempt/1']);
  await answer('lair-membership-501-c1-a1', 'paid');
  assert.equal(membership().next_cycle, 2);
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
    const told = toSam(mail).find((e) => /didn't go through/.test(e.subject));
    assert.match(told.text, /Shopify has emailed you a secure link/);
    assert.match(told.text, /borrowing new games is paused/i);
    assert.equal(charges()[0].error_code, 'INSUFFICIENT_FUNDS', 'the error code, whatever case Shopify sends it in');
    // borrowing is paused (they keep what they have)
    const mine = await me();
    assert.deepEqual(mine.library.plan, { name: 'Stash', games: 3, blocked: true });
    assert.equal(mine.membership.status, 'past_due');
    assert.equal(said(await call('POST', 'library/holds', AZUL, SAM)), `402 ${MEMBERSHIP_MESSAGES.blocked}`);
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
    assert.ok(toSam(mail).some((e) => e.subject === 'Your library membership has ended' && /after 3 tries/.test(e.text)));
    assert.ok(toStaff(mail, /failed for good: Sam Jones/));
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

test("a new card added for Sam (customer_payment_methods/create) that Shopify puts on the contract tries a failed payment again", async () => {
  await join();
  setNow(months(JOINED, 1) + MIN);
  await maintenance();
  await answer('lair-membership-501-c1-a1', 'EXPIRED_CARD');
  const c = shop.state.contracts.get(CONTRACT);
  c.paymentMethodId = 'gid://shopify/CustomerPaymentMethod/pm-new';
  c.card = { kind: 'card', brand: 'Visa', last4: '9999', expMonth: 2, expYear: 2032 };
  const res = await hook('customer_payment_methods/create', { admin_graphql_api_id: 'gid://shopify/CustomerPaymentMethod/pm-new', admin_graphql_api_customer_id: `gid://shopify/Customer/${SAM}` });
  assert.deepEqual([res.data.memberships, res.data.retried], [1, 1]);
  assert.equal(membership().payment_method_id, 'gid://shopify/CustomerPaymentMethod/pm-new');
  await maintenance();
  assert.equal(shop.state.billCalls.length, 2);
  // a card added that isn't on the contract changes nothing
  await answer('lair-membership-501-c1-a2', 'CARD_DECLINED');
  const other = await hook('customer_payment_methods/create', { admin_graphql_api_id: 'gid://shopify/CustomerPaymentMethod/pm-other', customer_id: Number(SAM) });
  assert.equal(other.data.retried, 0);
});

test('a contract Shopify says has ended can\'t be billed: the charge is dropped (nothing was charged) and the membership ends; staff hear', async () => {
  const mail = captureEmails();
  try {
    await join();
    setNow(months(JOINED, 1) + MIN);
    shop.state.billErrors = [{ code: 'CONTRACT_TERMINATED', message: 'Contract is terminated.' }];
    shop.state.contracts.get(CONTRACT).status = 'CANCELLED';
    await maintenance();
    assert.deepEqual([membership().status, charges()[0].status, charges()[0].void_reason], ['ended', 'void', 'contract-terminated']);
    await settle();
    assert.ok(toStaff(mail, /ended in Shopify: Sam Jones/));
    assert.equal(toSam(mail).length, 1, 'only the welcome: Sam is not told (it may have been a mistake)');
  } finally {
    mail.restore();
  }
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
    const changed = mail.sent.find((e) => e.subject === 'Your library plan changes to Hoard').text;
    assert.match(changed, /From your next bill on Tue 3 Nov, you're on Hoard: 5 games at a time for \$75 a month/);
    assert.match(changed, /before your next bill/);
    assert.equal(said(await call('POST', 'me/membership/change', { tier: 'hoard' }, SAM)), `409 ${MEMBERSHIP_MESSAGES.same('Hoard')}`);
    assert.equal(said(await call('POST', 'me/membership/change', { tier: 'mega' }, SAM)), `422 ${MEMBERSHIP_MESSAGES.tier}`);
    // the renewal bills Hoard, and paying it moves them up
    setNow(months(JOINED, 1) + MIN);
    await maintenance();
    assert.deepEqual([charges()[0].amount, charges()[0].tier, shop.charged('lair-membership-501-c1-a1')], [7500, 'hoard', 7500]);
    await answer('lair-membership-501-c1-a1', 'paid');
    assert.deepEqual((await me()).library.plan, { name: 'Hoard', games: 5 });
    // down again: from the next bill
    assert.equal((await call('POST', 'me/membership/change', { tier: 'grab' }, SAM)).status, 200);
    assert.deepEqual((await me()).library.plan, { name: 'Hoard', games: 5 }, 'Hoard is paid until December');
  } finally {
    mail.restore();
  }
});

test('plan changes wait while a payment is in flight or outstanding, or a bill has a damage charge on it; Shopify down is a 503', async () => {
  await join();
  shop.state.planErrors = [{ code: 'HAS_FUTURE_EDITS', message: 'Cannot update a subscription contract with a current or upcoming billing cycle contract edit.' }];
  assert.equal(said(await call('POST', 'me/membership/change', { tier: 'grab' }, SAM)), `409 ${MEMBERSHIP_MESSAGES.editsWaiting}`);
  shop.state.planErrors = [{ code: 'INVALID', message: 'Nope' }];
  assert.equal(said(await call('POST', 'me/membership/change', { tier: 'grab' }, SAM)), `503 ${MEMBERSHIP_MESSAGES.shopifyDown}`);
  assert.equal(membership().billing_tier, 'stash', 'nothing changed');
  shop.state.planErrors = null;
  setNow(months(JOINED, 1) + MIN);
  await maintenance();
  assert.equal(said(await call('POST', 'me/membership/change', { tier: 'grab' }, SAM)), `409 ${MEMBERSHIP_MESSAGES.editsWaiting}`, 'not while the renewal is being paid');
  assert.equal(shop.state.planChanges.length, 2, 'Shopify was never asked');
  await answer('lair-membership-501-c1-a1', 'CARD_DECLINED');
  assert.equal(said(await call('POST', 'me/membership/change', { tier: 'grab' }, SAM)), `409 ${MEMBERSHIP_MESSAGES.pastDue}`);
  lair.sql.exec("DELETE FROM meta WHERE key = 'membership-plans'");
  lair.sql.exec("UPDATE memberships SET status = 'active'");
  assert.equal(said(await call('POST', 'me/membership/change', { tier: 'grab' }, SAM)), `503 ${MEMBERSHIP_MESSAGES.plansNotReady}`);
  assert.equal(said(await call('POST', 'me/membership/change', { tier: 'grab' }, KIRI)), `404 ${MEMBERSHIP_MESSAGES.none}`);
  assert.equal(said(await call('POST', 'me/membership/change', { tier: 'grab' })), `401 ${MEMBERSHIP_MESSAGES.login}`);
});

test('a damage charge edit left on a paid cycle comes off before a plan change, so it never blocks it', async () => {
  await join();
  await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
  setNow(months(JOINED, 1) + MIN);
  await maintenance();
  await answer('lair-membership-501-c1-a1', 'paid');
  assert.equal(membership().edited_cycle, 1);
  const res = await call('POST', 'me/membership/change', { tier: 'grab' }, SAM);
  assert.equal(res.status, 200, res.data.error);
  assert.deepEqual(shop.state.clearCalls, [{ contractId: CONTRACT, cycle: 1 }]);
  assert.equal(membership().edited_cycle, null);
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
    const cancelled = mail.sent.find((e) => e.subject === 'Your library membership is cancelled').text;
    assert.match(cancelled, /runs until Tue 3 Nov, and there are no more bills after that/);
    assert.match(cancelled, /Keep your membership in My Lair before Tue 3 Nov/);
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
    assert.ok(toSam(mail).some((e) => e.subject === 'Your library membership has ended' && /Catan/.test(e.text)));
    assert.ok(toStaff(mail, /ended with games at home: Sam Jones/));
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
    assert.doesNotMatch(notice.text, /reply to this email/i, 'only the My Lair dispute holds a charge');
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
    assert.deepEqual([c.amount, JSON.parse(c.fees), fee(id).status, fee(id).charge_id, shop.charged(c.idempotency_key)], [7500, [id], 'billing', c.id, 7500]);
    await answer(c.idempotency_key, 'paid');
    assert.deepEqual([fee(id).status, membership().next_cycle], ['paid', 2]);
  } finally {
    mail.restore();
  }
});

test('damage charges: disputed (waits, staff hear), a new amount (a new notice), waived (Sam hears), put back; who may do what', async () => {
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
    setNow(months(JOINED, 1) + MIN);
    await maintenance();
    assert.equal(fee(id).status, 'disputed');
    assert.deepEqual([shop.state.editCalls, shop.charged('lair-membership-501-c1-a1')], [[], 6000], 'the renewal went without it');
    // staff: a helper with only library can log but not waive
    assert.equal((await updateDamage(id, { action: 'waive' }, 'helper')).status, 403);
    const lower = await updateDamage(id, { action: 'amount', amount: 2500 });
    assert.deepEqual([lower.data.charge.amount, lower.data.charge.status, lower.data.charge.dueAt], [2500, 'notice', clock + FEE_NOTICE_DAYS * DAY], 'a new amount is a new notice');
    assert.equal((await updateDamage(id, { action: 'waive', note: 'Fair enough' })).data.charge.status, 'waived');
    await settle();
    assert.ok(toSam(mail).some((e) => e.subject === 'Good news: the Azul charge is cancelled' && /\$25/.test(e.text)));
    assert.equal((await updateDamage(id, { action: 'reinstate' })).data.charge.status, 'notice', 'back in its notice (the new one has days left)');
    assert.equal(said(await updateDamage(id, { action: 'nope' })), `422 ${MEMBERSHIP_MESSAGES.feeAction}`);
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

test('a higher amount is never billed on the old notice: Sam hears the new amount and gets 7 days again', async () => {
  const mail = captureEmails();
  try {
    await join();
    const { data } = await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
    setNow(JOINED + 3 * DAY);
    const changed = await updateDamage(data.charge.id, { action: 'amount', amount: 15000 });
    assert.deepEqual([changed.data.charge.amount, changed.data.charge.status, changed.data.charge.dueAt], [15000, 'notice', clock + FEE_NOTICE_DAYS * DAY]);
    await settle();
    const notice = toSam(mail).find((e) => e.subject === 'The charge for Catan has changed');
    assert.match(notice.text, /from \$15 to \$150/);
    assert.match(notice.text, /Tue 13 Oct/);
    setNow(JOINED + 8 * DAY);
    await maintenance();
    assert.equal(fee(data.charge.id).status, 'notice', 'the first notice would have run out today; the new one has not');
    setNow(JOINED + 11 * DAY);
    await maintenance();
    assert.equal(fee(data.charge.id).status, 'due');
  } finally {
    mail.restore();
  }
});

test('staff can hold a damage charge (it waits, off any bill) and mark one paid at the counter', async () => {
  await join();
  const { data } = await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
  const held = await updateDamage(data.charge.id, { action: 'hold', note: 'Sam rang about it' });
  assert.deepEqual([held.data.charge.status, held.data.charge.disputeNote], ['disputed', 'On hold (staff)']);
  setNow(months(JOINED, 1) + MIN);
  await maintenance();
  assert.equal(shop.charged('lair-membership-501-c1-a1'), 6000, 'not on the bill');
  assert.equal(said(await updateDamage(data.charge.id, { action: 'hold' })), `409 ${MEMBERSHIP_MESSAGES.feeChange}`);
  const paid = await updateDamage(data.charge.id, { action: 'counter' });
  assert.deepEqual([paid.data.charge.status, fee(data.charge.id).note], ['paid', 'Paid at the counter']);
});

test('a damage charge for someone with no membership: the notice says to pay at the counter, and when it falls due staff collect it', async () => {
  const mail = captureEmails();
  try {
    lair.touchMember(KIRI, { name: 'Kiri Smith', email: 'kiri@example.com' }, clock);
    const res = await logDamage({ customerId: KIRI, title: 'Azul', reason: 'lost', amount: 4500 });
    assert.deepEqual([res.data.charge.status, res.data.charge.billable], ['notice', false]);
    await settle();
    const notice = mail.sent.find((e) => e.to === 'kiri@example.com');
    assert.match(notice.text, /At the counter, after Sat 10 Oct/);
    assert.doesNotMatch(notice.text, /Goes on your bill/);
    setNow(JOINED + FEE_NOTICE_DAYS * DAY + MIN);
    await maintenance();
    assert.equal(fee(res.data.charge.id).status, 'unpaid');
    await settle();
    assert.ok(toStaff(mail, /collect at the counter: Kiri Smith/));
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
    assert.deepEqual([c.status, c.amount, JSON.parse(c.fees), shop.charged(c.idempotency_key)], ['pending', 6000, [], 6000]);
    assert.equal(fee(data.charge.id).status, 'due');
    await settle();
    assert.ok(toStaff(mail, /Damage charges left off a library bill/));
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
  assert.deepEqual([fee(data.charge.id).status, fee(data.charge.id).charge_id], ['due', null], 'it waits for the next try');
  for (const [day, attempt] of [[3, 2], [7, 3]]) {
    setNow(due + MIN + day * DAY + MIN);
    await maintenance();
    assert.equal(shop.charged(`lair-membership-501-c1-a${attempt}`), 11000, 'each try carries it');
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
  assert.deepEqual([c.kind, c.amount, c.cycle, shop.charged(c.idempotency_key)], ['fees', 1500, 1, 1500]);
  assert.deepEqual([shop.state.editCalls[0].dropPlan, shop.state.editCalls[0].fees.map((f) => f.amount)], [true, [1500]], 'the month line comes off that bill');
  await answer(c.idempotency_key, 'paid');
  assert.equal(fee(data.charge.id).status, 'paid');
  assert.deepEqual([membership().status, membership().next_cycle], ['cancelling', 2]);
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
  await updateDamage(data.charge.id, { action: 'waive' });
  await call('POST', 'me/membership/cancel', {}, SAM);
  setNow(months(JOINED, 1) + MIN);
  const run = await maintenance();
  assert.deepEqual([run.charged, run.ended, shop.state.editCalls.length], [[], [CONTRACT], 0]);
});

test('a charge being paid right now can\'t be changed; once that try fails it can be waived, and the retry is $60 with the edit taken off', async () => {
  await join();
  const { data } = await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
  const due = months(JOINED, 1);
  setNow(due + MIN);
  await maintenance();
  assert.equal(shop.charged('lair-membership-501-c1-a1'), 7500, '$60 and the $15 charge on one bill');
  assert.equal(said(await updateDamage(data.charge.id, { action: 'waive' })), `409 ${MEMBERSHIP_MESSAGES.feeLocked}`);
  assert.equal(said(await updateDamage(data.charge.id, { action: 'amount', amount: 1000 })), `409 ${MEMBERSHIP_MESSAGES.feeLocked}`);
  await answer('lair-membership-501-c1-a1', 'CARD_DECLINED');
  assert.equal((await updateDamage(data.charge.id, { action: 'waive' })).data.charge.status, 'waived', 'between tries it can');
  setNow(due + MIN + 3 * DAY + MIN);
  await maintenance();
  assert.deepEqual(shop.state.editCalls.length, 1, 'the retry goes without it');
  assert.deepEqual(shop.state.clearCalls, [{ contractId: CONTRACT, cycle: 1 }], 'and the old damage charge line comes off the cycle first');
  assert.deepEqual([charges()[1].amount, shop.charged('lair-membership-501-c1-a2')], [6000, 6000], 'the card is charged $60, not $75');
  assert.equal(membership().edited_cycle, null);
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
  const mail = captureEmails();
  try {
    await join();
    const { data } = await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
    const c = shop.state.contracts.get(CONTRACT);
    c.status = 'PAUSED';
    c.revisionId = '5';
    await hook('subscription_contracts/pause', { admin_graphql_api_id: c.gid });
    assert.deepEqual([membership().status, membership().paused_from], ['paused', 'active']);
    assert.equal((await me()).library.plan, null);
    assert.equal((await me()).membership.status, 'paused', 'they can see it is paused');
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
    await settle();
    assert.ok(toStaff(mail, /ended in Shopify: Sam Jones/), 'staff hear');
    assert.ok(!toSam(mail).some((e) => /has ended/.test(e.subject)), "Sam isn't emailed (it may have been a mistake)");
    // brought back in Shopify after it ended: the Lair doesn't start billing it again, staff hear
    c.status = 'ACTIVE';
    c.revisionId = '8';
    await hook('subscription_contracts/activate', { admin_graphql_api_id: c.gid });
    assert.equal(membership().status, 'ended');
    await settle();
    assert.ok(toStaff(mail, /active again in Shopify: Sam Jones/));
  } finally {
    mail.restore();
  }
});

test('setup: the plans and the damage charge product are made once and saved; the plans go on MEMBERSHIPS_PRODUCT_ID when it is set', async () => {
  lair.sql.exec("DELETE FROM meta WHERE key IN ('membership-plans', 'membership-fee-variant')");
  setEnv({ MEMBERSHIPS_PRODUCT_ID: '7532313641063' });
  const res = await internal('setup', { webhookUrl: 'https://lair.test/webhooks/orders-paid', memberships: 'plans' });
  const s = res.data.membershipsSetup;
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.deepEqual([s.madePlans, s.madeFeeProduct, s.feeVariantId, s.productIds], [true, true, FEE_VARIANT, ['gid://shopify/Product/7532313641063']]);
  assert.deepEqual(Object.keys(s.plans), ['grab', 'stash', 'hoard']);
  assert.deepEqual(lair.membershipPlans().plans.hoard, { id: PLAN_IDS.hoard, name: 'Hoard', price: 7500 });
  assert.equal(lair.feeVariantId(), FEE_VARIANT);
  const again = (await internal('setup', { webhookUrl: 'https://lair.test/webhooks/orders-paid', memberships: 'plans' })).data.membershipsSetup;
  assert.deepEqual([again.madePlans, again.madeFeeProduct, shop.state.groups.length, shop.state.madeProducts], [undefined, undefined, 1, 1], 'found, not made again');
  // without the permissions it says which (read_orders too: a billing attempt's order needs it)
  shop.admin.appInfo = async () => ({ app: 'Lair Memberships', scopes: ['write_products', 'read_customers', 'write_customers', 'read_customer_payment_methods', 'write_own_subscription_contracts'] });
  const missing = (await internal('setup', { webhookUrl: 'https://lair.test/webhooks/orders-paid', memberships: 'plans' })).data.membershipsSetup;
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingScopes, ['read_orders']);
});

test('Simplee tags give a plan only to someone who has never had a Lair membership, and only until MEMBERSHIPS_SIMPLEE_TAGS is off', async () => {
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: false, tags: [SAM, KIRI].includes(id) ? ['hoard - board game rental'] : [] });
  assert.deepEqual((await me()).library.plan, { name: 'Hoard', games: 5 });
  assert.equal((await me()).membership, null);
  await join({ tier: 'grab' });
  assert.deepEqual((await me()).library.plan, { name: 'Grab', games: 1 }, 'a membership wins over tags');
  // ended (here, by Shopify): the old tags don't bring a plan back
  await shopifySays('CANCELLED', 'cancel');
  assert.equal((await me()).library.plan, null);
  // and once everyone has moved across, the tags count for nothing
  assert.deepEqual((await me(KIRI)).library.plan, { name: 'Hoard', games: 5 });
  setEnv({ MEMBERSHIPS_SIMPLEE_TAGS: 'off' });
  assert.equal((await me(KIRI)).library.plan, null);
});

/* ================= the review's scenarios: never twice, never early, never what was waived ================= */

test('a bank check (3D Secure) is never tried again while it waits: after 3 days borrowing pauses and Sam hears; confirmed on day 5, it is paid once', async () => {
  const mail = captureEmails();
  try {
    await join();
    const due = months(JOINED, 1);
    setNow(due + MIN);
    await maintenance();
    await answer('lair-membership-501-c1-a1', 'action');
    assert.equal(charges()[0].status, 'challenged');
    assert.equal(membership().status, 'active', 'still borrowing while the bank check waits');
    setNow(due + 2 * DAY);
    await maintenance();
    assert.equal(membership().status, 'active');
    setNow(due + 3 * DAY + HOUR);
    await maintenance();
    const m = membership();
    assert.deepEqual([m.status, m.retry_at, m.fail_count], ['past_due', null, 0], 'paused, but never tried again: the check could still go through');
    await settle();
    assert.ok(toSam(mail).some((e) => e.subject === 'Your bank wants you to confirm your library payment' && /If it isn't confirmed by Tue 10 Nov, your membership ends/.test(e.text)));
    assert.equal(said(await call('POST', 'library/holds', AZUL, SAM)), `402 ${MEMBERSHIP_MESSAGES.blockedBank}`);
    assert.equal((await me()).membership.bankCheck, true);
    assert.equal(said(await call('POST', 'memberships/501/retry', {}, 'staff')), `409 ${MEMBERSHIP_MESSAGES.retryBank}`);
    // a new card doesn't start a second payment while this one could still go through
    await hook('customer_payment_methods/update', { admin_graphql_api_id: PM, customer_id: 1001 });
    setNow(due + 5 * DAY);
    await maintenance();
    assert.equal(shop.state.billCalls.length, 1, 'one attempt, all along');
    await answer('lair-membership-501-c1-a1', 'paid');
    assert.deepEqual([membership().status, membership().next_cycle], ['active', 2]);
    await settle();
    assert.ok(toSam(mail).some((e) => e.subject === 'Your library payment went through'));
  } finally {
    mail.restore();
  }
});

test('a bank check never done: after 7 days the membership ends with no second charge; a late success is still taken, and staff hear', async () => {
  const mail = captureEmails();
  try {
    await join();
    const due = months(JOINED, 1);
    setNow(due + MIN);
    await maintenance();
    await answer('lair-membership-501-c1-a1', 'action');
    for (let day = 1; day <= 6; day += 1) {
      setNow(due + day * DAY + HOUR);
      await maintenance();
    }
    assert.equal(membership().status, 'past_due');
    setNow(due + 7 * DAY + HOUR);
    await maintenance();
    assert.deepEqual([charges()[0].status, charges()[0].error_code], ['failed', 'AUTHENTICATION_REQUIRED']);
    assert.deepEqual([membership().status, membership().end_reason, shop.state.ended], ['ended', 'payment', [[CONTRACT, 'fail']]]);
    assert.equal(shop.state.billCalls.length, 1, 'never a second charge');
    await settle();
    assert.ok(toSam(mail).some((e) => e.subject === 'Your library membership has ended' && /Your bank wanted you to confirm your library payment, and it wasn't confirmed in time/.test(e.text)));
    // Sam does the bank check after all
    await answer('lair-membership-501-c1-a1', 'paid');
    assert.deepEqual([charges()[0].status, membership().status], ['paid', 'ended']);
    await settle();
    assert.ok(toStaff(mail, /came in after the membership ended: Sam Jones/));
  } finally {
    mail.restore();
  }
});

test('cancelling while a bill never reached Shopify: Shopify is asked, it has nothing, so the bill is dropped and the membership ends unbilled', async () => {
  const mail = captureEmails();
  try {
    await join();
    setNow(months(JOINED, 1) + MIN);
    shop.state.billThrows = 1;
    await maintenance();
    assert.equal(charges()[0].status, 'claimed');
    const cancel = await call('POST', 'me/membership/cancel', {}, SAM);
    assert.deepEqual([cancel.data.membership.status, cancel.data.membership.cancelAt, cancel.data.membership.canResume], ['cancelling', null, true]);
    await settle();
    const told = mail.sent.find((e) => e.subject === 'Your library membership is cancelled').text;
    assert.match(told, /We'd already started taking this month's payment when you cancelled/);
    assert.match(told, /If it doesn't, your membership ends now/);
    assert.doesNotMatch(told, /has ended, and there are no more bills/, 'never "no more bills" while one might still go through');
    setNow(clock + 16 * MIN);
    await maintenance();
    assert.deepEqual(shop.state.findCalls, ['lair-membership-501-c1-a1'], 'Shopify is asked about it by its key');
    assert.equal(shop.state.billCalls.length, 1, 'never sent again');
    assert.deepEqual([charges()[0].status, charges()[0].void_reason], ['void', 'membership-cancelling']);
    assert.deepEqual([membership().status, shop.state.ended], ['ended', [[CONTRACT, 'cancel']]]);
    await settle();
    assert.ok(toSam(mail).some((e) => e.subject === 'Your library membership has ended'));
  } finally {
    mail.restore();
  }
});

test('cancelling while a bill is claimed but not yet sent: it is dropped there and then, and Sam is told there are no more bills', async () => {
  const mail = captureEmails();
  try {
    await join();
    await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
    setNow(months(JOINED, 1) + MIN);
    shop.state.editThrows = 1;
    await maintenance();
    assert.deepEqual([charges()[0].status, charges()[0].sent_at], ['claimed', null], 'stopped while its damage charge was going on the bill');
    await call('POST', 'me/membership/cancel', {}, SAM);
    assert.deepEqual([charges()[0].status, charges()[0].void_reason, membership().cancel_at], ['void', 'cancelled', clock], 'its paid month ran out a minute ago');
    await settle();
    assert.match(mail.sent.find((e) => e.subject === 'Your library membership is cancelled').text, /has ended, and there are no more bills/);
    setNow(clock + 16 * MIN);
    await maintenance();
    assert.equal(shop.state.billCalls.filter((b) => b.key.endsWith('-a1')).length, 0, 'the dropped renewal never went');
    assert.equal(charges()[1].kind, 'fees', 'the damage charge goes on its own, without the month');
  } finally {
    mail.restore();
  }
});

test('one maintenance run at a time, and a membership a webhook changed mid-run is not billed', async () => {
  await join();
  await join({ id: '502', customerId: KIRI, tier: 'grab', createdAt: JOINED + HOUR });
  setNow(months(JOINED, 1) + 2 * HOUR);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  shop.state.billGate = async (contractId) => {
    if (numericId(contractId) === CONTRACT) await gate;
  };
  const first = maintenance();
  await settle();
  assert.equal((await maintenance()).busy, true, 'a second run while the first is going does nothing');
  // Kiri's contract is paused in Shopify while the first run waits on Sam's bill
  await shopifySays('PAUSED', 'pause', '502');
  release();
  const run = await first;
  assert.equal(run.charged.length, 1);
  assert.deepEqual(shop.state.billCalls.map((b) => b.contractId), [CONTRACT], "Kiri's paused membership isn't billed");
  assert.equal(charges('502').length, 0);
  shop.state.billGate = null;
  assert.notEqual((await maintenance()).busy, true, 'the next run goes ahead');
});

test('billing switched on late: missed months are skipped and staff hear; only the bill that is less than 2 days late is taken, never several at once', async () => {
  open({ billing: false });
  const mail = captureEmails();
  try {
    await join();
    setNow(months(JOINED, 2) + DAY);
    assert.equal((await maintenance()).waiting, 1);
    setEnv({ MEMBERSHIPS_BILLING: 'on' });
    const run = await maintenance();
    assert.deepEqual(run.caughtUp, [CONTRACT]);
    assert.deepEqual(shop.state.billCalls.map((b) => b.cycle), [2], 'December only (3 December, a day ago); November is skipped');
    await answer('lair-membership-501-c2-a1', 'paid');
    assert.deepEqual([membership().next_cycle, membership().next_bill_at], [3, months(JOINED, 3)]);
    await maintenance();
    assert.equal(shop.state.billCalls.length, 1, 'January waits for January');
    await settle();
    const told = toStaff(mail, /too late to take/);
    assert.match(told.text, /Sam Jones/);
    assert.match(told.text, /1 month not billed \(due Tue 3 Nov\); next bill Thu 3 Dec/);
  } finally {
    mail.restore();
  }
});

test('long after its date (billing was off): the next bill waits for its own date', async () => {
  open({ billing: false });
  await join();
  setNow(months(JOINED, 2) + 10 * DAY);
  await maintenance();
  setEnv({ MEMBERSHIPS_BILLING: 'on' });
  const run = await maintenance();
  assert.deepEqual([run.caughtUp, run.charged, shop.state.billCalls.length], [[CONTRACT], [], 0]);
  assert.deepEqual([membership().next_cycle, membership().next_bill_at], [3, months(JOINED, 3)]);
});

test('paused in Shopify and back again: a cancelled membership stays cancelled, and ends unbilled', async () => {
  await join();
  setNow(JOINED + 5 * DAY);
  await call('POST', 'me/membership/cancel', {}, SAM);
  await shopifySays('PAUSED', 'pause');
  assert.deepEqual([membership().status, membership().paused_from], ['paused', 'cancelling']);
  await shopifySays('ACTIVE', 'activate');
  assert.deepEqual([membership().status, membership().cancel_at, membership().paused_from], ['cancelling', months(JOINED, 1), null]);
  setNow(months(JOINED, 1) + MIN);
  const run = await maintenance();
  assert.deepEqual([run.charged, run.ended, shop.state.billCalls.length], [[], [CONTRACT], 0]);
});

test('paused for two months and back again: the missed months are not billed, the next bill waits for its date', async () => {
  await join();
  setNow(JOINED + 20 * DAY);
  await shopifySays('PAUSED', 'pause');
  setNow(months(JOINED, 1) + MIN);
  await maintenance();
  assert.equal(shop.state.billCalls.length, 0, 'paused: not billed');
  setNow(months(JOINED, 2) + 20 * DAY);
  await shopifySays('ACTIVE', 'activate');
  const run = await maintenance();
  assert.deepEqual([run.caughtUp, shop.state.billCalls.length, membership().next_cycle], [[CONTRACT], 0, 3]);
});

test('the kill switch: with billing off, a bill Shopify never got is dropped, and one Shopify has is followed but never sent again', async () => {
  await join();
  await join({ id: '502', customerId: KIRI, tier: 'grab', createdAt: JOINED + HOUR });
  setNow(months(JOINED, 1) + 2 * HOUR);
  shop.state.billThrows = 1; // Sam's never reaches Shopify
  shop.state.billLost = 1; // Kiri's reaches Shopify, but the answer is lost
  await maintenance();
  assert.deepEqual([charges()[0].status, charges('502')[0].status], ['claimed', 'claimed']);
  setEnv({ MEMBERSHIPS_BILLING: 'off' });
  setNow(clock + 16 * MIN);
  await maintenance();
  assert.equal(shop.state.billCalls.length, 2, 'nothing sent again');
  assert.deepEqual([charges()[0].status, charges()[0].void_reason], ['void', 'billing-off']);
  assert.equal(charges('502')[0].status, 'pending', "Kiri's is with Shopify: it's followed to the end");
  await answer('lair-membership-502-c1-a1', 'paid');
  assert.equal(membership('502').next_cycle, 2);
});

test('a damage charge bill interrupted before its edit was done is never sent bare: the next run puts the charge on first', async () => {
  await join();
  const { data } = await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
  setNow(JOINED + 10 * DAY);
  await call('POST', 'me/membership/cancel', {}, SAM);
  setNow(months(JOINED, 1) + MIN);
  shop.state.editThrows = 1;
  await maintenance();
  const [c] = charges();
  assert.deepEqual([c.kind, c.status, c.edit_state, c.sent_at], ['fees', 'claimed', 'needed', null]);
  assert.equal(shop.state.billCalls.length, 0, 'not billed without its edit');
  setNow(clock + 16 * MIN);
  await maintenance();
  assert.equal(shop.state.editCalls.length, 2);
  assert.equal(shop.charged(c.idempotency_key), 1500, 'the damage charge only, not the month');
  await answer(c.idempotency_key, 'paid');
  assert.equal(fee(data.charge.id).status, 'paid');
});

test("Shopify refusing a bill (the first order is under review) isn't a failed payment: nothing counts, Sam isn't told, staff hear, and it's tried again tomorrow", async () => {
  const mail = captureEmails();
  try {
    await join();
    const due = months(JOINED, 1);
    setNow(due + MIN);
    shop.state.billErrors = [{ code: 'CONTRACT_UNDER_REVIEW', message: 'The origin order is high risk and unfulfilled.' }];
    await maintenance();
    const m = membership();
    assert.deepEqual([m.status, m.fail_count, m.hold_until], ['active', 0, due + MIN + DAY]);
    assert.deepEqual([charges()[0].status, charges()[0].void_reason], ['void', 'refused:contract_under_review']);
    assert.deepEqual(shop.state.cardEmails, []);
    await settle();
    assert.equal(toSam(mail).length, 1, 'only the welcome');
    assert.match(toStaff(mail, /wouldn't take a library bill: Sam Jones/).text, /under review for fraud risk/);
    assert.deepEqual((await me()).library.plan, { name: 'Stash', games: 3 }, 'still borrowing');
    assert.equal((await call('GET', 'memberships', null, 'staff')).data.memberships[0].holdUntil, due + MIN + DAY);
    setNow(due + 12 * HOUR);
    await maintenance();
    assert.equal(shop.state.billCalls.length, 1, 'not again until tomorrow');
    setNow(due + MIN + DAY + MIN);
    await maintenance();
    assert.deepEqual(shop.state.billCalls.map((b) => b.key), ['lair-membership-501-c1-a1', 'lair-membership-501-c1-a2']);
  } finally {
    mail.restore();
  }
});

test('Shopify refusing a bill because the contract is paused there: nothing counts, and the membership pauses', async () => {
  await join();
  setNow(months(JOINED, 1) + MIN);
  const c = shop.state.contracts.get(CONTRACT);
  c.status = 'PAUSED';
  c.revisionId = '2';
  shop.state.billErrors = [{ code: 'CONTRACT_PAUSED', message: 'Contract is paused.' }];
  await maintenance();
  assert.deepEqual([membership().status, membership().fail_count, charges()[0].status], ['paused', 0, 'void']);
});

test("a payment that fails on the store's side (the dev store's order limit) doesn't count against Sam: no emails to Sam, staff hear, tried again tomorrow", async () => {
  const mail = captureEmails();
  try {
    await join();
    const due = months(JOINED, 1);
    setNow(due + MIN);
    await maintenance();
    await answer('lair-membership-501-c1-a1', 'NON_TEST_ORDER_LIMIT_REACHED');
    const m = membership();
    assert.deepEqual([m.status, m.fail_count, m.hold_until], ['active', 0, due + MIN + DAY]);
    assert.deepEqual(shop.state.cardEmails, []);
    await settle();
    assert.equal(toSam(mail).length, 1, 'only the welcome');
    assert.ok(toStaff(mail, /failed, not because of the card: Sam Jones/));
    setNow(due + MIN + DAY + MIN);
    await maintenance();
    assert.equal(shop.state.billCalls.at(-1).key, 'lair-membership-501-c1-a2');
  } finally {
    mail.restore();
  }
});

test('the bank flags fraud: never tried again on its own; a new card gets one more try', async () => {
  const mail = captureEmails();
  try {
    await join();
    const due = months(JOINED, 1);
    setNow(due + MIN);
    await maintenance();
    await answer('lair-membership-501-c1-a1', 'FRAUD_SUSPECTED');
    await settle();
    assert.deepEqual([membership().status, membership().retry_at, membership().fail_count], ['past_due', null, 1]);
    const told = toSam(mail).find((e) => /didn't go through/.test(e.subject));
    assert.match(told.text, /stopped it as possible fraud/);
    assert.match(told.text, /If your card isn't updated by Tue 10 Nov, your membership ends/);
    assert.ok(toStaff(mail, /flagged as fraud: Sam Jones/));
    setNow(due + 4 * DAY);
    await maintenance();
    assert.equal(shop.state.billCalls.length, 1, 'never tried again on its own');
    shop.state.contracts.get(CONTRACT).card = { kind: 'card', brand: 'Visa', last4: '1111', expMonth: 1, expYear: 2031 };
    await hook('customer_payment_methods/update', { admin_graphql_api_id: PM, customer_id: 1001 });
    await maintenance();
    assert.equal(shop.state.billCalls.length, 2);
    await answer('lair-membership-501-c1-a2', 'paid');
    assert.equal(membership().status, 'active');
  } finally {
    mail.restore();
  }
});

test('the bank flags fraud and the card is never updated: a week later the membership ends (and Sam is told why)', async () => {
  const mail = captureEmails();
  try {
    await join();
    const due = months(JOINED, 1);
    setNow(due + MIN);
    await maintenance();
    await answer('lair-membership-501-c1-a1', 'FRAUD_SUSPECTED');
    const { data } = await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
    setNow(due + MIN + 7 * DAY + MIN);
    const run = await maintenance();
    assert.deepEqual([run.gaveUp, run.ended], [[CONTRACT], [CONTRACT]]);
    assert.deepEqual([membership().status, shop.state.ended, shop.state.billCalls.length], ['ended', [[CONTRACT, 'fail']], 1]);
    assert.equal(fee(data.charge.id).status, 'unpaid');
    await settle();
    const ended = toSam(mail).find((e) => e.subject === 'Your library membership has ended');
    assert.match(ended.text, /Your bank stopped your library payment and your card wasn't updated/);
    assert.match(ended.text, /Damage charges to pay:\s+\$15/, 'the charge it never billed is in it too');
  } finally {
    mail.restore();
  }
});

test('cancelled, with two damage charges a week apart: each is billed on its own cycle, then the membership ends', async () => {
  await join();
  const first = await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
  setNow(JOINED + 10 * DAY);
  await call('POST', 'me/membership/cancel', {}, SAM);
  setNow(months(JOINED, 1) + MIN);
  await maintenance();
  const [one] = charges();
  assert.deepEqual([one.kind, one.cycle, shop.charged(one.idempotency_key)], ['fees', 1, 1500]);
  await answer(one.idempotency_key, 'paid');
  assert.equal(membership().next_cycle, 2, 'that cycle is used: another charge goes on the next one');
  const second = await logDamage({ customerId: SAM, title: 'Azul', reason: 'damaged', amount: 2500 });
  await maintenance();
  assert.equal(membership().status, 'cancelling', 'it waits for the second one');
  setNow(clock + FEE_NOTICE_DAYS * DAY + MIN);
  await maintenance();
  const two = charges()[1];
  assert.deepEqual([two.kind, two.cycle, shop.charged(two.idempotency_key)], ['fees', 2, 2500]);
  await answer(two.idempotency_key, 'paid');
  await maintenance();
  assert.deepEqual([membership().status, fee(first.data.charge.id).status, fee(second.data.charge.id).status], ['ended', 'paid', 'paid']);
});

test('with no damage charge product: a renewal goes without the charges (staff hear), and a cancelled member\'s go to staff so it can end', async () => {
  const mail = captureEmails();
  try {
    lair.sql.exec("DELETE FROM meta WHERE key = 'membership-fee-variant'");
    await join();
    await join({ id: '502', customerId: KIRI, tier: 'grab', createdAt: JOINED + HOUR });
    const sams = await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
    assert.equal(sams.data.charge.billable, false);
    const kiris = await logDamage({ customerId: KIRI, title: 'Azul', reason: 'missing', amount: 2000 });
    setNow(JOINED + 10 * DAY);
    await call('POST', 'me/membership/cancel', {}, KIRI);
    setNow(months(JOINED, 1) + 2 * HOUR);
    const run = await maintenance();
    assert.equal(shop.charged('lair-membership-501-c1-a1'), 6000, "Sam's renewal goes without the charge");
    assert.equal(fee(sams.data.charge.id).status, 'due', 'it waits for a bill that can carry it');
    assert.equal(fee(kiris.data.charge.id).status, 'unpaid', "Kiri's goes to staff");
    assert.deepEqual(run.ended, ['502']);
    await settle();
    assert.ok(toStaff(mail, /Damage charges can't go on library bills/));
  } finally {
    mail.restore();
  }
});

test('a failure that arrives after Shopify ended the contract is only recorded: no new status, no emails to Sam', async () => {
  const mail = captureEmails();
  try {
    await join();
    setNow(months(JOINED, 1) + MIN);
    await maintenance();
    await shopifySays('CANCELLED', 'cancel');
    assert.equal(membership().status, 'ended');
    await settle();
    const before = toSam(mail).length;
    await answer('lair-membership-501-c1-a1', 'CARD_DECLINED');
    await settle();
    assert.deepEqual([membership().status, charges()[0].status], ['ended', 'failed']);
    assert.equal(toSam(mail).length, before);
    assert.deepEqual(shop.state.cardEmails, []);
  } finally {
    mail.restore();
  }
});

test('a late success for a try the Lair had stopped waiting on is taken; if that means the month was paid twice, staff hear to refund one', async () => {
  const mail = captureEmails();
  try {
    await join();
    const due = months(JOINED, 1);
    setNow(due + MIN);
    await maintenance();
    await answer('lair-membership-501-c1-a1', 'CARD_DECLINED');
    setNow(due + MIN + 3 * DAY + MIN);
    await maintenance();
    assert.equal(charges()[1].status, 'pending');
    // Shopify reports the first try paid after all, then the second goes through too
    await answer('lair-membership-501-c1-a1', 'paid');
    assert.deepEqual([charges()[0].status, membership().status, membership().next_cycle], ['paid', 'active', 2]);
    const second = await answer('lair-membership-501-c1-a2', 'paid');
    assert.equal(second.data.double, true);
    assert.equal(membership().next_cycle, 2, 'not moved on twice');
    await settle();
    assert.ok(toStaff(mail, /paid twice: Sam Jones/));
  } finally {
    mail.restore();
  }
});

test("a cycle Shopify says is billed already isn't billed again: the next cycle is read, and staff hear", async () => {
  const mail = captureEmails();
  try {
    await join();
    shop.state.cycles.get(CONTRACT)[0].billed = true;
    setNow(months(JOINED, 1) + MIN);
    await maintenance();
    assert.equal(shop.state.billCalls.length, 0);
    assert.deepEqual([charges()[0].status, charges()[0].void_reason, membership().next_bill_at], ['void', 'cycle-billed', null]);
    await maintenance();
    assert.deepEqual([membership().next_cycle, membership().next_bill_at], [2, months(JOINED, 2)]);
    await settle();
    assert.ok(toStaff(mail, /bill the Lair didn't take: Sam Jones/));
  } finally {
    mail.restore();
  }
});

test("a next bill date Shopify can't give: asked again every half hour, staff hear after a day, and cancelling keeps the month paid at checkout", async () => {
  const mail = captureEmails();
  try {
    const cyclesOf = shop.admin.cycles;
    let reads = 0;
    shop.admin.cycles = async () => {
      reads += 1;
      throw new Error('Shopify API error 503');
    };
    await join();
    assert.deepEqual([membership().next_bill_at, membership().dates_missing_at], [null, JOINED]);
    await maintenance();
    assert.equal(reads, 2);
    setNow(clock + 10 * MIN);
    await maintenance();
    assert.equal(reads, 2, 'not again within half an hour');
    setNow(clock + 25 * MIN);
    await maintenance();
    assert.equal(reads, 3);
    setNow(JOINED + DAY + HOUR);
    await maintenance();
    await settle();
    assert.ok(toStaff(mail, /no next bill date: Sam Jones/));
    const cancel = await call('POST', 'me/membership/cancel', {}, SAM);
    assert.equal(cancel.data.membership.cancelAt, months(JOINED, 1), 'the month they paid for at checkout, not now');
    shop.admin.cycles = cyclesOf;
  } finally {
    mail.restore();
  }
});

/* ================= the second review: webhooks without an attempt id, the store's own failures, stuck bills ================= */

test("a bank check whose webhook gets in before the bill's answer (with no attempt id) is still followed: borrowing pauses after 3 days", async () => {
  await join();
  const due = months(JOINED, 1);
  setNow(due + MIN);
  shop.state.onBill = async (key) => {
    shop.state.onBill = null;
    await answer(key, 'action');
  };
  await maintenance();
  const [c] = charges();
  assert.deepEqual([c.status, c.attempt_gid], ['challenged', 'gid://shopify/SubscriptionBillingAttempt/1'], "the bill's own answer gives the attempt id");
  setNow(due + 3 * DAY + HOUR);
  await maintenance();
  assert.equal(membership().status, 'past_due');
});

test('a bank check on a bill whose answer was lost is found by its key, followed, and given up after 7 days, never billed twice', async () => {
  await join();
  const due = months(JOINED, 1);
  setNow(due + MIN);
  shop.state.billLost = 1;
  await maintenance();
  await answer('lair-membership-501-c1-a1', 'action');
  assert.deepEqual([charges()[0].status, charges()[0].attempt_gid], ['challenged', null], 'the webhook said nothing about which attempt');
  setNow(due + 3 * DAY + HOUR);
  await maintenance();
  assert.deepEqual([charges()[0].attempt_gid, membership().status], ['gid://shopify/SubscriptionBillingAttempt/1', 'past_due']);
  setNow(due + 7 * DAY + HOUR);
  await maintenance();
  assert.deepEqual([membership().status, shop.state.billCalls.length], ['ended', 1]);
});

test('a failure webhook with no error code is read from Shopify, so a declined card is never mistaken for a problem on the store\'s side', async () => {
  await join();
  setNow(months(JOINED, 1) + MIN);
  await maintenance();
  const key = 'lair-membership-501-c1-a1';
  shop.state.attempts.get(shop.state.keys.get(key)).state = { state: 'failed', code: 'CARD_DECLINED' };
  await hook('subscription_billing_attempts/failure', { admin_graphql_api_id: null, idempotency_key: key, error_code: null, error_message: null });
  assert.deepEqual([charges()[0].error_code, membership().status, membership().fail_count], ['CARD_DECLINED', 'past_due', 1]);
});

test("a card the payment gateway can't take is Sam's to fix: it counts as a try and Sam is told", async () => {
  const mail = captureEmails();
  try {
    await join();
    setNow(months(JOINED, 1) + MIN);
    await maintenance();
    await answer('lair-membership-501-c1-a1', 'PAYMENT_METHOD_INCOMPATIBLE_WITH_GATEWAY_CONFIG');
    assert.deepEqual([membership().status, membership().fail_count, shop.state.cardEmails.length], ['past_due', 1, 1]);
    await settle();
    assert.ok(toSam(mail).some((e) => /didn't go through/.test(e.subject)));
  } finally {
    mail.restore();
  }
});

test("failures on the store's side are tried at most 3 times a bill, then billing stops for 30 days (staff hear) and the card is left alone", async () => {
  const mail = captureEmails();
  try {
    await join();
    const due = months(JOINED, 1);
    setNow(due + MIN);
    await maintenance();
    await answer('lair-membership-501-c1-a1', 'INSUFFICIENT_FUNDS');
    let day = 3;
    for (const attempt of [2, 3, 4]) {
      setNow(due + day * DAY + attempt * MIN);
      await maintenance();
      await answer(`lair-membership-501-c1-a${attempt}`, 'MERCHANT_ACCOUNT_ERROR');
      day += 1;
    }
    assert.deepEqual([membership().status, membership().fail_count], ['past_due', 1], 'only the card decline counted');
    assert.equal(membership().hold_until, clock + 30 * DAY);
    for (const later of [6, 10, 20]) {
      setNow(due + later * DAY);
      await maintenance();
    }
    assert.equal(shop.state.billCalls.length, 4, 'never tried day after day');
    await settle();
    const alerts = mail.sent.filter((e) => e.to === 'staff@dicegoblin.test' && /not because of the card: Sam Jones/.test(e.subject));
    assert.deepEqual(alerts.map((e) => /stopped billing them for 30 days/.test(e.text)), [false, false, true], 'one a day while it tries again, then one to say billing has stopped');
    assert.equal(toSam(mail).filter((e) => /didn't go through/.test(e.subject)).length, 1, 'Sam heard only about the decline');
  } finally {
    mail.restore();
  }
});

test("a cancelled member's damage charge that keeps failing on the store's side goes to the counter after 3 tries, and the membership ends", async () => {
  await join();
  const { data } = await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
  setNow(JOINED + 10 * DAY);
  await call('POST', 'me/membership/cancel', {}, SAM);
  const end = months(JOINED, 1);
  for (const attempt of [1, 2, 3]) {
    setNow(end + (attempt - 1) * DAY + attempt * MIN);
    await maintenance();
    await answer(`lair-membership-501-c1-a${attempt}`, 'PAYMENT_PROVIDER_IS_NOT_ENABLED');
  }
  assert.equal(fee(data.charge.id).status, 'unpaid');
  await maintenance();
  assert.deepEqual([membership().status, shop.state.billCalls.length], ['ended', 3]);
});

test("a bill that can't reach Shopify: staff hear after 2 hours, and after 2 days it's dropped and the next bill waits for its date", async () => {
  const mail = captureEmails();
  try {
    await join();
    const due = months(JOINED, 1);
    const cyclesOf = shop.admin.cycles;
    shop.admin.cycles = async () => {
      throw new Error('Shopify API error 503');
    };
    setNow(due + MIN);
    await maintenance();
    assert.equal(charges()[0].status, 'claimed');
    setNow(due + 3 * HOUR);
    await maintenance();
    await settle();
    assert.ok(toStaff(mail, /library bill is stuck: Sam Jones/));
    shop.admin.cycles = cyclesOf;
    setNow(due + 2 * DAY + HOUR);
    const run = await maintenance();
    assert.deepEqual([charges()[0].status, charges()[0].void_reason], ['void', 'too-late']);
    assert.deepEqual([run.caughtUp, membership().next_cycle, shop.state.billCalls.length], [[CONTRACT], 2, 0]);
  } finally {
    mail.restore();
  }
});

test('a failed payment whose retry would be more than 2 days late (billing was off) is dropped, not retried late, and the next month waits for its date', async () => {
  await join();
  const due = months(JOINED, 1);
  setNow(due + MIN);
  await maintenance();
  await answer('lair-membership-501-c1-a1', 'CARD_DECLINED');
  setEnv({ MEMBERSHIPS_BILLING: 'off' });
  setNow(due + 21 * DAY);
  await maintenance();
  setEnv({ MEMBERSHIPS_BILLING: 'on' });
  const run = await maintenance();
  assert.deepEqual(run.caughtUp, [CONTRACT]);
  assert.equal(shop.state.billCalls.length, 1, 'November is not tried again three weeks late');
  assert.deepEqual([membership().status, membership().next_cycle, membership().fail_count], ['active', 2, 0]);
  setNow(months(JOINED, 2) + MIN);
  await maintenance();
  assert.deepEqual(shop.state.billCalls.map((b) => b.cycle), [1, 2], 'December on its own date');
});

test("a damage charge billed on its own: every line that isn't a damage charge comes off the bill, and the committed bill is checked", async () => {
  const admin = new MembershipsAdmin({ SHOP: 'dice-goblin.myshopify.com', MEMBERSHIPS_CLIENT_ID: 'id', MEMBERSHIPS_CLIENT_SECRET: 'secret', API_VERSION: '2026-07' }, ctx.storage);
  const calls = [];
  const plan = { id: 'line-plan', variantId: 'gid://shopify/ProductVariant/42179272933479', quantity: 1, currentPrice: { amount: '60.00' } };
  const feeLine = { id: 'line-fee', variantId: FEE_VARIANT, quantity: 1, currentPrice: { amount: '15.00' } };
  let committed = [];
  admin.graphql = async (query, vars) => {
    const name = query.match(/(?:mutation|query) (\w+)/)[1];
    calls.push([name, vars]);
    if (name === 'MembershipCycleEditDelete') return { subscriptionBillingCycleEditDelete: { billingCycles: [], userErrors: [{ code: 'NO_CYCLE_EDITS', message: 'No edits.' }] } };
    // the membership line has no selling plan id (as a contract moved from another app might)
    if (name === 'MembershipCycleEdit') return { subscriptionBillingCycleContractEdit: { draft: { id: 'gid://shopify/SubscriptionDraft/1', lines: { nodes: [{ id: plan.id, variantId: plan.variantId }] } }, userErrors: [] } };
    if (name === 'MembershipLineRemove') return { subscriptionDraftLineRemove: { lineRemoved: { id: vars.lineId }, userErrors: [] } };
    if (name === 'MembershipLineAdd') return { subscriptionDraftLineAdd: { lineAdded: { id: feeLine.id }, userErrors: [] } };
    if (name === 'MembershipCycleCommit') return { subscriptionBillingCycleContractDraftCommit: { contract: { lines: { nodes: committed } }, userErrors: [] } };
    throw new Error(`unexpected ${name}`);
  };
  const ask = (dropPlan) => admin.editCycle({ contractId: CONTRACT, cycle: 1, feeVariantId: FEE_VARIANT, dropPlan, fees: [{ id: 'dc1', amount: 1500, label: 'Missing parts: Catan' }] });
  committed = [feeLine];
  assert.deepEqual(await ask(true), { ok: true, errors: [] });
  assert.deepEqual(calls.filter(([n]) => n === 'MembershipLineRemove').map(([, v]) => v.lineId), ['line-plan'], 'the month comes off though it has no selling plan id');
  committed = [plan, feeLine];
  const wrong = await ask(true);
  assert.deepEqual([wrong.ok, wrong.errors[0].code], [false, 'LINES'], 'a bill that still has the month on it is never billed as damage only');
  assert.deepEqual(await ask(false), { ok: true, errors: [] }, "a renewal's bill keeps the month and adds the charge");
  committed = [plan];
  assert.equal((await ask(false)).ok, false, 'a renewal bill missing its damage charge says so');
});

test('while a plan change is with Shopify, nothing is billed for that member; the bill after it is on the new plan', async () => {
  await join();
  const due = months(JOINED, 1);
  setNow(due - MIN);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const changePlan = shop.admin.changePlan;
  shop.admin.changePlan = async (args) => {
    await gate;
    return changePlan(args);
  };
  const change = call('POST', 'me/membership/change', { tier: 'grab' }, SAM);
  await settle();
  setNow(due + MIN / 2);
  const run = await maintenance();
  assert.deepEqual([run.charged, shop.state.billCalls.length], [[], 0], 'not while the plan is changing');
  assert.equal(said(await call('POST', 'me/membership/change', { tier: 'hoard' }, SAM)), `409 ${MEMBERSHIP_MESSAGES.changing}`);
  release();
  assert.equal((await change).status, 200);
  assert.equal(membership().changing_until, null);
  await maintenance();
  assert.deepEqual([charges()[0].tier, shop.charged('lair-membership-501-c1-a1')], ['grab', 3000]);
});

test('cancelled, then paused in Shopify, while the renewal is being paid: paid, it runs to the end of that month; declined, it ends', async () => {
  await join();
  setNow(months(JOINED, 1) + MIN);
  await maintenance();
  await call('POST', 'me/membership/cancel', {}, SAM);
  await shopifySays('PAUSED', 'pause');
  assert.deepEqual([membership().status, membership().paused_from, membership().cancel_at], ['paused', 'cancelling', null]);
  await answer('lair-membership-501-c1-a1', 'paid');
  assert.equal(membership().cancel_at, months(JOINED, 2), 'they keep the month it paid for');
  await shopifySays('ACTIVE', 'activate');
  assert.equal(membership().status, 'cancelling');
  setNow(months(JOINED, 2) + MIN);
  await maintenance();
  assert.equal(membership().status, 'ended');
  // and declined
  open();
  await join({ id: '601' });
  setNow(months(JOINED, 1) + MIN);
  await maintenance();
  await call('POST', 'me/membership/cancel', {}, SAM);
  await shopifySays('PAUSED', 'pause', '601');
  await answer('lair-membership-601-c1-a1', 'CARD_DECLINED');
  assert.equal(membership('601').cancel_at, clock);
  await shopifySays('ACTIVE', 'activate', '601');
  await maintenance();
  assert.deepEqual([membership('601').status, shop.state.billCalls.length], ['ended', 1]);
});

test("a cancelled member's failed damage charge is tried again within the hour once their card is updated, and their notice says it's billed on its own", async () => {
  const mail = captureEmails();
  try {
    await join();
    setNow(JOINED + 10 * DAY);
    await call('POST', 'me/membership/cancel', {}, SAM);
    await logDamage({ customerId: SAM, title: 'Catan', reason: 'missing', amount: 1500 });
    await settle();
    assert.match(toSam(mail).find((e) => /About Catan/.test(e.subject)).text, /Billed to your card on its own, on Tue 3 Nov/);
    setNow(months(JOINED, 1) + MIN);
    await maintenance();
    await answer(charges()[0].idempotency_key, 'CARD_DECLINED');
    assert.ok(membership().retry_at > clock);
    const res = await hook('customer_payment_methods/update', { admin_graphql_api_id: PM, customer_id: 1001 });
    assert.equal(res.data.retried, 1);
    await maintenance();
    assert.deepEqual(shop.state.billCalls.map((b) => b.key), ['lair-membership-501-c1-a1', 'lair-membership-501-c1-a2']);
  } finally {
    mail.restore();
  }
});

/* ---------------- damage charges taken now (store credit or the saved card) ---------------- */
// Mo (9 Oct 2026): "make sure there is a way for us to charge a client not on the next billing cycle but immediately
// for any of the damages ... after emails have been sent out ... either by taking their credit or charging their card"
const chargeNow = (id, body = {}, who = 'staff') => call('POST', `library/damage/${id}/charge`, body, who);
const settleCredit = (id, taken, who = 'staff') => call('POST', `library/damage/${id}/settle`, { taken }, who);
const payment = (id) => lair.damagePaymentRow(id);
const payKeyCalls = (key) => shop.state.billCalls.filter((b) => b.key === key).length;

/**
 * A fake store credit account per customer (the Lair's own app), in cents. Shopify can drop a take-off before it
 * arrives (throws), take it but lose the answer (lost), or not let the Lair read the account (readThrows).
 */
function fakeCredit(start = {}) {
  const balances = new Map(Object.entries(start));
  const debits = [];
  const state = { calls: [], throws: 0, lost: 0, readThrows: false };
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  lair.shopify.appInfo = async () => ({ app: 'Dice Goblin Lair', shop: 'Dice Goblin', scopes: [] });
  lair.ensureWebhook = async () => ({ ok: true });
  const denied = () => new Error('Shopify API: Access denied for storeCreditAccounts field.');
  lair.shopify.storeCreditBalance = async (id) => {
    if (state.readThrows) throw denied();
    return balances.get(id) || 0;
  };
  lair.shopify.storeCreditDebits = async (id) => {
    if (state.readThrows) throw denied();
    return debits.filter((d) => d.customerId === id).reverse().map(({ customerId, ...d }) => d);
  };
  lair.shopify.changeStoreCredit = async (id, cents) => {
    state.calls.push([id, cents]);
    if (state.throws > 0) {
      state.throws -= 1;
      throw new Error('Shopify API error 502');
    }
    const now = balances.get(id) || 0;
    if (now + cents < 0) throw Object.assign(new Error('Insufficient funds'), { code: 'INSUFFICIENT_FUNDS', refused: true });
    balances.set(id, now + cents);
    const tx = { id: `gid://shopify/StoreCreditAccountDebitTransaction/${state.calls.length}`, customerId: id, amount: Math.abs(cents), balanceAfter: now + cents, createdAt: Date.now(), fromOrder: false };
    if (cents < 0) debits.push(tx);
    if (state.lost > 0) {
      state.lost -= 1;
      throw new Error('Shopify API error 504');
    }
    return { id: tx.id, balanceAfter: tx.balanceAfter };
  };
  return { balances, debits, state };
}

test('a damage charge taken now from store credit: the notice first, then it comes off once and is paid; Sam gets a receipt, and the next bill is just the plan', async () => {
  const mail = captureEmails();
  try {
    await join();
    const credit = fakeCredit({ [SAM]: 5000 });
    const logged = await logDamage({ customerId: SAM, title: 'Catan', reason: 'damaged', details: 'box corner', amount: 4000 });
    assert.equal(logged.status, 200, logged.data.error);
    const id = logged.data.charge.id;
    assert.deepEqual([logged.data.charge.canChargeNow, logged.data.charge.emailedAt, logged.data.charge.payment], [true, clock, null]);
    const res = await chargeNow(id, { use: 'credit' });
    assert.equal(res.status, 200, res.data.error);
    assert.deepEqual([res.data.charge.status, res.data.charge.paidVia, res.data.charge.canChargeNow], ['paid', 'credit', false]);
    assert.deepEqual([res.data.payment.method, res.data.payment.status, res.data.payment.amount, res.data.payment.balanceAfter], ['credit', 'paid', 4000, 1000]);
    assert.equal(res.data.message, "Paid: $40 came off Sam Jones's store credit.");
    assert.deepEqual([credit.state.calls, credit.balances.get(SAM)], [[[SAM, -4000]], 1000]);
    const p = payment(res.data.payment.id);
    assert.deepEqual([p.transaction_id, p.fee_was, p.told, p.idempotency_key], [credit.debits[0].id, 'notice', 0, payNowKey(p.id)]);
    // pressing it again takes nothing more
    assert.equal(said(await chargeNow(id, { use: 'credit' })), `409 ${MEMBERSHIP_MESSAGES.feePaid}`);
    assert.equal(credit.state.calls.length, 1);
    await settle();
    const receipt = toSam(mail).find((e) => e.subject === 'Paid: the $40 charge for Catan');
    assert.ok(receipt, 'Sam gets a receipt');
    assert.match(receipt.text, /We've taken \$40 from your store credit for Catan/);
    assert.match(receipt.text, /Store credit left/);
    assert.match(receipt.text, /\$10/);
    assert.deepEqual((await me()).membership.damage.map((f) => [f.title, f.status, f.paidVia, f.payment.method]), [['Catan', 'paid', 'credit', 'credit']]);
    // the renewal is the plan only
    setNow(months(JOINED, 1) + MIN);
    await maintenance();
    assert.deepEqual([shop.state.editCalls.length, shop.charged(chargeKey(CONTRACT, 1, 1))], [0, 6000]);
  } finally {
    mail.restore();
  }
});

test('taking a damage charge now: only once its notice has been emailed, never while it is on hold or being paid, only by staff with Money, and a new amount needs its new notice', async () => {
  await join();
  const credit = fakeCredit({ [SAM]: 20000 });
  // no emails: the notice never went, so it can't be taken now
  const quiet = (await logDamage({ customerId: SAM, title: 'Catan', reason: 'damaged', amount: 4000 })).data.charge;
  assert.deepEqual([quiet.emailed, quiet.canChargeNow], [false, false]);
  assert.equal(said(await chargeNow(quiet.id)), `409 ${MEMBERSHIP_MESSAGES.feeNotEmailed}`);
  const mail = captureEmails();
  try {
    const id = (await logDamage({ customerId: SAM, title: 'Azul', reason: 'missing', amount: 2000 })).data.charge.id;
    assert.equal((await chargeNow(id, {}, 'helper')).status, 403, 'a helper with Library only');
    assert.equal((await chargeNow(id, {}, SAM)).status, 403, 'members never');
    assert.equal(said(await chargeNow(id, { use: 'cash' })), `422 ${MEMBERSHIP_MESSAGES.feeUse}`);
    assert.equal(said(await chargeNow('dc_nope')), `404 ${MEMBERSHIP_MESSAGES.feeNone}`);
    await updateDamage(id, { action: 'hold' });
    assert.equal(said(await chargeNow(id)), `409 ${MEMBERSHIP_MESSAGES.feeOnHold}`);
    await updateDamage(id, { action: 'reinstate' });
    // a new amount: a new notice goes, so it can be taken at the new amount
    await updateDamage(id, { action: 'amount', amount: 2500 });
    assert.equal(fee(id).emailed_at, clock);
    const res = await chargeNow(id);
    assert.equal(res.status, 200, res.data.error);
    assert.deepEqual(credit.state.calls, [[SAM, -2500]]);
    // paid ones and waived ones can't be taken again
    assert.equal(said(await chargeNow(id)), `409 ${MEMBERSHIP_MESSAGES.feePaid}`);
    const waived = (await logDamage({ customerId: SAM, title: 'Splendor', reason: 'damaged', amount: 1000 })).data.charge.id;
    await updateDamage(waived, { action: 'waive' });
    assert.equal(said(await chargeNow(waived)), `409 ${MEMBERSHIP_MESSAGES.feeWaived}`);
    // and one being taken now can't be changed
    credit.state.lost = 1;
    const busy = (await logDamage({ customerId: SAM, title: 'Root', reason: 'damaged', amount: 1000 })).data.charge.id;
    await chargeNow(busy, { use: 'credit' });
    assert.equal(fee(busy).status, 'charging');
    assert.equal(said(await updateDamage(busy, { action: 'waive' })), `409 ${MEMBERSHIP_MESSAGES.feeLocked}`);
    assert.equal(said(await chargeNow(busy)), `409 ${MEMBERSHIP_MESSAGES.feeLocked}`);
    assert.equal(said(await call('POST', `me/damage/${busy}/dispute`, { note: 'no' }, SAM)), `409 ${MEMBERSHIP_MESSAGES.feeDispute}`);
  } finally {
    mail.restore();
  }
});

test("a damage charge taken now on Sam's saved card: a one-off contract with just the charge on that card, billed once by its key; paid, Sam gets a receipt and the contract is cancelled; it never becomes a membership", async () => {
  const mail = captureEmails();
  try {
    await join();
    const id = (await logDamage({ customerId: SAM, title: 'Catan', reason: 'lost', amount: 6500 })).data.charge.id;
    const res = await chargeNow(id, { use: 'card' });
    assert.equal(res.status, 200, res.data.error);
    assert.deepEqual([res.data.charge.status, res.data.payment.status, res.data.payment.method, res.data.payment.card], ['charging', 'pending', 'card', 'Visa ending 4242']);
    assert.match(res.data.message, /^Charging \$65 to Visa ending 4242/);
    const [made] = shop.state.chargeContractCalls;
    const p = payment(res.data.payment.id);
    assert.deepEqual(
      [made.customerId, made.paymentMethodId, made.currency, made.feeVariantId, made.paymentId, made.fee],
      [SAM, PM, 'NZD', FEE_VARIANT, p.id, { id, amount: 6500, label: 'Lost or not returned: Catan' }],
    );
    assert.ok(made.billAt > clock && made.billAt <= clock + HOUR, 'its one bill is due straight away');
    assert.deepEqual(shop.state.billCalls.map((b) => [numericId(b.contractId), b.cycle, b.key]), [[numericId(p.contract_gid), 1, payNowKey(p.id)]]);
    // Shopify's webhooks for the one-off contract never make it a membership
    const created = await hook('subscription_contracts/create', { admin_graphql_api_id: p.contract_gid });
    assert.equal(created.data.reason, 'a damage charge taken now');
    assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM memberships').one().n, 1);
    // Sam's page shows it being paid
    assert.deepEqual((await me()).membership.damage.map((f) => [f.status, f.payment.status]), [['charging', 'pending']]);
    await answer(p.idempotency_key, 'paid');
    assert.deepEqual([fee(id).status, fee(id).paid_via, payment(p.id).status, payment(p.id).order_id, shop.charged(p.idempotency_key)], ['paid', 'card', 'paid', 'gid://shopify/Order/1600', 6500]);
    await settle();
    const receipt = toSam(mail).find((e) => e.subject === 'Paid: the $65 charge for Catan');
    assert.match(receipt.text, /We've charged \$65 to Visa ending 4242 for Catan/);
    // the next run cancels the one-off contract, and its cancel webhook is left alone too
    await maintenance();
    assert.deepEqual(shop.state.ended, [[numericId(p.contract_gid), 'cancel']]);
    assert.ok(payment(p.id).closed_at);
    assert.equal((await hook('subscription_contracts/cancel', { admin_graphql_api_id: p.contract_gid })).data.reason, 'a damage charge taken now');
    assert.equal(membership().status, 'active', 'the membership itself is untouched');
    // a repeated success webhook changes nothing
    await answer(p.idempotency_key, 'paid');
    assert.equal(toSam(mail).filter((e) => /^Paid:/.test(e.subject)).length, 1);
    // the renewal is the plan only
    setNow(months(JOINED, 1) + MIN);
    await maintenance();
    assert.equal(shop.charged(chargeKey(CONTRACT, 1, 1)), 6000);
  } finally {
    mail.restore();
  }
});

test('a card charge that is declined: nothing is charged, the charge goes back to its notice, Sam is told it goes on the next bill, staff hear; that bill takes it once', async () => {
  const mail = captureEmails();
  try {
    await join();
    const id = (await logDamage({ customerId: SAM, title: 'Catan', reason: 'damaged', amount: 3000 })).data.charge.id;
    const p = payment((await chargeNow(id, { use: 'card' })).data.payment.id);
    await answer(p.idempotency_key, 'CARD_DECLINED');
    assert.deepEqual([payment(p.id).status, payment(p.id).error_code, fee(id).status], ['failed', 'CARD_DECLINED', 'notice']);
    await settle();
    const told = toSam(mail).find((e) => e.subject === "We couldn't take the charge for Catan");
    assert.match(told.text, /to Visa ending 4242, but it didn't go through/);
    assert.match(told.text, /next library bill instead, on Tue 3 Nov/);
    assert.match(told.text, /update it in My Lair/);
    assert.ok(toStaff(mail, /A damage charge couldn't be taken now: Sam Jones/));
    // it can be tried again (a new payment), or left for the bill: here, the bill
    setNow(months(JOINED, 1) + MIN);
    await maintenance();
    assert.ok(payment(p.id).closed_at, "the declined charge's contract is cancelled");
    assert.equal(shop.charged(chargeKey(CONTRACT, 1, 1)), 9000, '$60 plus the $30 charge');
    await answer(chargeKey(CONTRACT, 1, 1), 'paid');
    assert.deepEqual([fee(id).status, fee(id).paid_via], ['paid', 'bill']);
  } finally {
    mail.restore();
  }
});

test("a card charge that fails on the store's side: Sam isn't told (it wasn't their card), staff hear, and the charge waits for the next bill", async () => {
  const mail = captureEmails();
  try {
    await join();
    const id = (await logDamage({ customerId: SAM, title: 'Catan', reason: 'damaged', amount: 3000 })).data.charge.id;
    setNow(JOINED + 8 * DAY);
    await maintenance();
    assert.equal(fee(id).status, 'due');
    const p = payment((await chargeNow(id, { use: 'card' })).data.payment.id);
    await answer(p.idempotency_key, 'PAYMENT_PROVIDER_IS_NOT_ENABLED');
    assert.deepEqual([payment(p.id).status, fee(id).status], ['failed', 'due']);
    await settle();
    assert.equal(toSam(mail).filter((e) => /couldn't take/.test(e.subject)).length, 0);
    assert.match(toStaff(mail, /couldn't be taken now/).text, /PAYMENT_PROVIDER_IS_NOT_ENABLED/);
    // Shopify refusing the bill outright is the same: nothing charged, back to waiting
    shop.state.billErrors = [{ code: 'INVALID', message: 'Billing cycle is invalid' }];
    const again = await chargeNow(id, { use: 'card' });
    assert.equal(again.status, 409);
    assert.match(again.data.error, /Shopify wouldn't charge Visa ending 4242 \(INVALID: Billing cycle is invalid\)\. Nothing was charged\./);
    assert.equal(fee(id).status, 'due');
  } finally {
    mail.restore();
  }
});

test('logged with chargeNow: the notice says it is being taken now, then it is; with not enough store credit it goes on the card, and the notice says so', async () => {
  const mail = captureEmails();
  try {
    await join();
    const credit = fakeCredit({ [SAM]: 10000 });
    const a = await logDamage({ customerId: SAM, title: 'Catan', reason: 'damaged', amount: 4000, chargeNow: true });
    assert.equal(a.status, 200, a.data.error);
    assert.deepEqual([a.data.chargeNow.ok, a.data.charge.status, a.data.charge.paidVia, a.data.chargeNow.payment.method], [true, 'paid', 'credit', 'credit']);
    assert.equal(payment(a.data.chargeNow.payment.id).told, 1);
    await settle();
    const notice = toSam(mail).find((e) => e.subject === 'About Catan: a charge for damaged');
    assert.match(notice.text, /Taken from your store credit today/);
    assert.doesNotMatch(notice.text, /Goes on your bill|before Sat 10 Oct/);
    // $60 left: a $70 charge goes on the card
    const b = await logDamage({ customerId: SAM, title: 'Azul', reason: 'lost', amount: 7000, chargeNow: true });
    assert.deepEqual([b.data.chargeNow.ok, b.data.charge.status, b.data.chargeNow.payment.method, b.data.chargeNow.payment.status], [true, 'charging', 'card', 'pending']);
    await settle();
    assert.match(toSam(mail).find((e) => e.subject === "Azul hasn't come back").text, /Charged to Visa ending 4242 today/);
    assert.deepEqual(credit.state.calls, [[SAM, -4000]], 'store credit was only asked for the first');
    // a helper with Library can log one, but not charge it now
    assert.equal((await logDamage({ customerId: SAM, title: 'Root', reason: 'damaged', amount: 1000, chargeNow: true }, 'helper')).status, 403);
  } finally {
    mail.restore();
  }
});

test("logged with chargeNow for a member with no email: the notice can't go, so nothing is taken now and it waits as usual", async () => {
  const mail = captureEmails();
  try {
    lair.touchMember('1003', { name: 'Ari Brown' }, clock);
    const credit = fakeCredit({ 1003: 9000 });
    const res = await logDamage({ customerId: '1003', title: 'Catan', reason: 'damaged', amount: 4000, chargeNow: true });
    assert.equal(res.status, 200, res.data.error);
    assert.deepEqual([res.data.charge.status, res.data.charge.emailed, res.data.chargeNow.ok, res.data.chargeNow.error], ['notice', false, false, MEMBERSHIP_MESSAGES.feeNotEmailed]);
    assert.deepEqual(credit.state.calls, []);
  } finally {
    mail.restore();
  }
});

test('store credit whose answer was lost is looked for in the account: there, it is paid; not there after 10 minutes, it goes back; never taken twice', async () => {
  const mail = captureEmails();
  try {
    await join();
    const credit = fakeCredit({ [SAM]: 10000 });
    const a = (await logDamage({ customerId: SAM, title: 'Catan', reason: 'damaged', amount: 4000 })).data.charge.id;
    credit.state.lost = 1;
    const res = await chargeNow(a, { use: 'credit' });
    assert.equal(res.status, 200, res.data.error);
    assert.deepEqual([res.data.payment.status, fee(a).status], ['checking', 'charging']);
    assert.match(res.data.message, /checking whether the store credit came off/);
    setNow(JOINED + 3 * MIN);
    await maintenance();
    assert.deepEqual([fee(a).status, fee(a).paid_via, payment(res.data.payment.id).transaction_id], ['paid', 'credit', credit.debits[0].id]);
    assert.deepEqual(credit.state.calls, [[SAM, -4000]], 'found, never taken again');
    // never reached Shopify: still not in the account after 10 minutes, so it goes back to its notice
    const b = (await logDamage({ customerId: SAM, title: 'Azul', reason: 'damaged', amount: 2000 })).data.charge.id;
    credit.state.throws = 1;
    const res2 = await chargeNow(b, { use: 'credit' });
    assert.equal(res2.data.payment.status, 'checking');
    setNow(clock + 3 * MIN);
    await maintenance();
    assert.equal(payment(res2.data.payment.id).status, 'checking', "not there yet, but it's early");
    setNow(clock + 10 * MIN);
    await maintenance();
    assert.deepEqual([payment(res2.data.payment.id).status, payment(res2.data.payment.id).error_code, fee(b).status], ['failed', 'NOT_TAKEN', 'notice']);
    assert.equal(credit.balances.get(SAM), 6000);
    await settle();
    assert.ok(toStaff(mail, /couldn't be taken now/));
    assert.equal(toSam(mail).filter((e) => /couldn't take/.test(e.subject)).length, 0, "Sam wasn't told it would be taken now");
  } finally {
    mail.restore();
  }
});

test("store credit Shopify can't confirm (the Lair can't read the account): staff are asked after an hour and settle it", async () => {
  const mail = captureEmails();
  try {
    await join();
    const credit = fakeCredit({ [SAM]: 10000 });
    credit.state.readThrows = true;
    const a = (await logDamage({ customerId: SAM, title: 'Catan', reason: 'damaged', amount: 4000 })).data.charge.id;
    credit.state.lost = 1;
    const p = (await chargeNow(a, { use: 'credit' })).data.payment;
    assert.equal(p.status, 'checking');
    setNow(JOINED + 30 * MIN);
    await maintenance();
    assert.equal(payment(p.id).status, 'checking');
    await settle();
    assert.equal(toStaff(mail, /Check a store credit payment/), undefined);
    setNow(JOINED + 70 * MIN);
    await maintenance();
    await settle();
    assert.match(toStaff(mail, /Check a store credit payment: Sam Jones/).text, /say whether it came off/);
    assert.equal((await settleCredit(a, true, 'helper')).status, 403);
    assert.equal(said(await settleCredit(a, 'yes')), `422 ${MEMBERSHIP_MESSAGES.settleSay}`);
    const settled = await settleCredit(a, true);
    assert.equal(settled.status, 200, settled.data.error);
    assert.deepEqual([settled.data.charge.status, settled.data.charge.paidVia, settled.data.payment.status], ['paid', 'credit', 'paid']);
    assert.equal(said(await settleCredit(a, false)), `409 ${MEMBERSHIP_MESSAGES.settleNone}`);
    // one that didn't come off goes back
    const b = (await logDamage({ customerId: SAM, title: 'Azul', reason: 'damaged', amount: 2000 })).data.charge.id;
    credit.state.throws = 1;
    await chargeNow(b, { use: 'credit' });
    const back = await settleCredit(b, false);
    assert.deepEqual([back.data.charge.status, back.data.payment.status, back.data.payment.error], ['notice', 'failed', 'NOT_TAKEN']);
  } finally {
    mail.restore();
  }
});

test('a card charge whose contract or bill answer was lost: the contract is found by its marker and the bill by its key, so it is one contract and one charge', async () => {
  const mail = captureEmails();
  try {
    await join();
    // the contract was made, but the answer was lost
    const a = (await logDamage({ customerId: SAM, title: 'Catan', reason: 'damaged', amount: 3000 })).data.charge.id;
    shop.state.contractLost = 1;
    const res = await chargeNow(a, { use: 'card' });
    assert.equal(res.status, 200, res.data.error);
    assert.equal(res.data.payment.status, 'claimed');
    assert.match(res.data.message, /keeps trying/);
    setNow(JOINED + 16 * MIN);
    await maintenance();
    const pa = payment(res.data.payment.id);
    assert.deepEqual([shop.state.chargeContractCalls.length, shop.state.findContractCalls, pa.status, payKeyCalls(pa.idempotency_key)], [1, 1, 'pending', 1]);
    assert.equal(numericId(pa.contract_gid), [...shop.state.contracts.values()].find((c) => c.marker === pa.id).id);
    // the request never got there: looked for, not found, so it's made (once) and billed
    const b = (await logDamage({ customerId: SAM, title: 'Azul', reason: 'damaged', amount: 2000 })).data.charge.id;
    shop.state.contractThrows = 1;
    const pb = (await chargeNow(b, { use: 'card' })).data.payment;
    setNow(clock + 16 * MIN);
    await maintenance();
    assert.deepEqual([shop.state.chargeContractCalls.length, payment(pb.id).status, payKeyCalls(payment(pb.id).idempotency_key)], [3, 'pending', 1]);
    // the bill was made but its answer lost: found by its key, never billed again
    const c = (await logDamage({ customerId: SAM, title: 'Root', reason: 'damaged', amount: 1000 })).data.charge.id;
    shop.state.billLost = 1;
    const pc = (await chargeNow(c, { use: 'card' })).data.payment;
    assert.equal(payment(pc.id).status, 'claimed');
    setNow(clock + 16 * MIN);
    await maintenance();
    assert.deepEqual([payment(pc.id).status, payKeyCalls(payment(pc.id).idempotency_key)], ['pending', 1]);
    await answer(payment(pc.id).idempotency_key, 'paid');
    assert.deepEqual([fee(c).status, shop.charged(payment(pc.id).idempotency_key)], ['paid', 1000]);
  } finally {
    mail.restore();
  }
});

test("a card charge waiting on Sam's bank check: Sam hears; never done in 7 days, it goes on the next bill; a late success is still taken, and staff hear if that's twice", async () => {
  const mail = captureEmails();
  try {
    await join();
    const a = (await logDamage({ customerId: SAM, title: 'Catan', reason: 'damaged', amount: 4000 })).data.charge.id;
    const pa = payment((await chargeNow(a, { use: 'card' })).data.payment.id);
    await answer(pa.idempotency_key, 'action');
    assert.deepEqual([payment(pa.id).status, fee(a).status], ['challenged', 'charging']);
    await settle();
    const check = toSam(mail).find((e) => e.subject === 'Your bank wants you to confirm a $40 payment');
    assert.match(check.text, /Shopify has emailed you a link/);
    assert.match(check.text, /Sat 10 Oct/);
    setNow(JOINED + DAY);
    await maintenance();
    assert.equal(payment(pa.id).status, 'challenged', 'still waiting: never tried again');
    setNow(JOINED + 7 * DAY + HOUR);
    await maintenance();
    assert.deepEqual([payment(pa.id).status, payment(pa.id).error_code, fee(a).status], ['failed', 'AUTHENTICATION_REQUIRED', 'due']);
    await settle();
    assert.match(toSam(mail).find((e) => e.subject === "We couldn't take the charge for Catan").text, /wasn't confirmed in time, so nothing was charged/);
    // confirmed late, before the next bill: it's taken, and that bill is just the plan
    await answer(pa.idempotency_key, 'paid');
    assert.deepEqual([fee(a).status, fee(a).paid_via], ['paid', 'card']);
    await settle();
    assert.ok(toStaff(mail, /A late payment paid a damage charge: Sam Jones/));
    // another one given up, billed with the renewal, then confirmed late: paid twice, staff refund one
    const b = (await logDamage({ customerId: SAM, title: 'Azul', reason: 'damaged', amount: 2000 })).data.charge.id;
    const pb = payment((await chargeNow(b, { use: 'card' })).data.payment.id);
    await answer(pb.idempotency_key, 'action');
    setNow(months(JOINED, 1) - HOUR);
    await maintenance();
    assert.equal(fee(b).status, 'due');
    setNow(months(JOINED, 1) + MIN);
    await maintenance();
    assert.equal(shop.charged(chargeKey(CONTRACT, 1, 1)), 8000, '$60 plus the $20 charge');
    await answer(chargeKey(CONTRACT, 1, 1), 'paid');
    assert.deepEqual([fee(b).status, fee(b).paid_via], ['paid', 'bill']);
    await answer(pb.idempotency_key, 'paid');
    await settle();
    assert.match(toStaff(mail, /A damage charge was paid twice: Sam Jones/).text, /Refund one of them in Shopify/);
    assert.equal(fee(b).paid_via, 'bill');
  } finally {
    mail.restore();
  }
});

test('with billing off, cards are never charged (store credit still works); a card charge that never reached Shopify is dropped when billing goes off', async () => {
  const mail = captureEmails();
  try {
    await join();
    const credit = fakeCredit({ [SAM]: 10000 });
    const a = (await logDamage({ customerId: SAM, title: 'Catan', reason: 'damaged', amount: 4000 })).data.charge.id;
    setEnv({ MEMBERSHIPS_BILLING: 'off' });
    assert.equal(said(await chargeNow(a, { use: 'card' })), `409 ${MEMBERSHIP_MESSAGES.cardsOff}`);
    assert.equal((await chargeNow(a)).data.charge.paidVia, 'credit', 'auto: store credit');
    setEnv({ MEMBERSHIPS_BILLING: 'on' });
    const b = (await logDamage({ customerId: SAM, title: 'Azul', reason: 'damaged', amount: 2000 })).data.charge.id;
    shop.state.contractThrows = 1;
    const pb = (await chargeNow(b, { use: 'card' })).data.payment;
    assert.equal(payment(pb.id).status, 'claimed');
    setEnv({ MEMBERSHIPS_BILLING: 'off' });
    setNow(clock + 16 * MIN);
    await maintenance();
    assert.deepEqual([payment(pb.id).status, payment(pb.id).void_reason, fee(b).status, shop.state.billCalls.length], ['void', 'billing-off', 'notice', 0]);
    assert.equal(credit.state.calls.length, 1);
  } finally {
    mail.restore();
  }
});

test('cancelled with a damage charge being taken now: the membership waits for it, then ends', async () => {
  const mail = captureEmails();
  try {
    await join();
    setNow(JOINED + 10 * DAY);
    await call('POST', 'me/membership/cancel', {}, SAM);
    const id = (await logDamage({ customerId: SAM, title: 'Catan', reason: 'damaged', amount: 4000 })).data.charge.id;
    const p = payment((await chargeNow(id, { use: 'card' })).data.payment.id);
    assert.equal(p.payment_method_id, PM, "the cancelled membership's card");
    setNow(months(JOINED, 1) + MIN);
    await maintenance();
    assert.equal(membership().status, 'cancelling', 'waits while the charge is being taken');
    await answer(p.idempotency_key, 'paid');
    await maintenance();
    assert.equal(membership().status, 'ended');
    assert.deepEqual(shop.state.ended.map(([c]) => c).sort(), [CONTRACT, numericId(p.contract_gid)].sort());
    assert.equal(shop.state.billCalls.length, 1, 'only the damage charge was billed');
  } finally {
    mail.restore();
  }
});

test("someone with no membership: no card to charge, so store credit or the counter; a charge for the counter can still come off their store credit", async () => {
  const mail = captureEmails();
  try {
    gameAtHome('Catan', KIRI);
    const credit = fakeCredit({});
    const id = (await logDamage({ customerId: KIRI, title: 'Catan', reason: 'damaged', amount: 4000 })).data.charge.id;
    assert.equal(said(await chargeNow(id, { use: 'card' })), `409 ${MEMBERSHIP_MESSAGES.noCardSaved('Kiri Smith')}`);
    assert.equal(said(await chargeNow(id)), `409 ${MEMBERSHIP_MESSAGES.noWayNow('Kiri Smith')}`);
    assert.equal(said(await chargeNow(id, { use: 'credit' })), `409 ${MEMBERSHIP_MESSAGES.creditShort('Kiri Smith', 4000, 0)}`);
    // its notice runs out: it's for the counter, and can still come off store credit
    setNow(JOINED + 8 * DAY);
    await maintenance();
    assert.equal(fee(id).status, 'unpaid');
    credit.balances.set(KIRI, 5000);
    const res = await chargeNow(id);
    assert.deepEqual([res.status, res.data.charge.status, res.data.charge.paidVia], [200, 'paid', 'credit']);
    // Shopify saying it's short (the balance moved): nothing came off, and it stays for the counter
    const b = (await logDamage({ customerId: KIRI, title: 'Azul', reason: 'damaged', amount: 2000 })).data.charge.id;
    credit.state.readThrows = true;
    assert.equal(said(await chargeNow(b, { use: 'credit' })), `409 ${MEMBERSHIP_MESSAGES.creditShort('Kiri Smith', 2000, null)}`);
    assert.deepEqual([fee(b).status, payment(fee(b).payment_id).status, credit.balances.get(KIRI)], ['notice', 'failed', 1000]);
  } finally {
    mail.restore();
  }
});

test("a card charge that can't reach Shopify for 2 days is dropped (nothing charged, staff hear); a one-off contract Shopify won't cancel is left alone after a day's tries (staff hear); the Damage list shows charges being taken", async () => {
  const mail = captureEmails();
  try {
    await join();
    const a = (await logDamage({ customerId: SAM, title: 'Catan', reason: 'damaged', amount: 3000 })).data.charge.id;
    shop.state.contractThrows = 99;
    const pa = (await chargeNow(a, { use: 'card' })).data.payment;
    const open = await call('GET', 'library/damage', null, 'staff');
    assert.deepEqual(open.data.charges.filter((c) => c.id === a).map((c) => [c.status, c.payment.status]), [['charging', 'claimed']]);
    for (let i = 1; i <= 4; i += 1) {
      setNow(JOINED + i * 12 * HOUR + MIN);
      await maintenance();
    }
    assert.deepEqual([payment(pa.id).status, payment(pa.id).void_reason, fee(a).status], ['void', 'too-late', 'notice'], 'back in its notice');
    await settle();
    assert.ok(toStaff(mail, /A damage charge is stuck: Sam Jones/));
    assert.match(toStaff(mail, /A damage charge couldn't be taken: Sam Jones/).text, /Nothing was charged/);
    // a paid one whose contract Shopify won't cancel
    shop.state.contractThrows = 0;
    const b = (await logDamage({ customerId: SAM, title: 'Azul', reason: 'damaged', amount: 2000 })).data.charge.id;
    const pb = payment((await chargeNow(b, { use: 'card' })).data.payment.id);
    await answer(pb.idempotency_key, 'paid');
    shop.state.endErrors = [{ code: 'INVALID', message: 'Contract is busy' }];
    await maintenance();
    assert.equal(payment(pb.id).closed_at, null);
    setNow(clock + DAY + HOUR);
    await maintenance();
    await settle();
    assert.ok(toStaff(mail, /A one-off charge contract won't close/));
    shop.state.endErrors = null;
    await maintenance();
    assert.ok(payment(pb.id).closed_at);
  } finally {
    mail.restore();
  }
});

test('a failure webhook for a damage charge with no error code is read from Shopify, so a declined card is never taken for a problem on our side', async () => {
  const mail = captureEmails();
  try {
    await join();
    const a = (await logDamage({ customerId: SAM, title: 'Catan', reason: 'damaged', amount: 3000 })).data.charge.id;
    const p = payment((await chargeNow(a, { use: 'card' })).data.payment.id);
    shop.state.attempts.get(shop.state.keys.get(p.idempotency_key)).state = { state: 'failed', code: 'EXPIRED_PAYMENT_METHOD' };
    const res = await hook('subscription_billing_attempts/failure', { admin_graphql_api_id: null, idempotency_key: p.idempotency_key, error_code: null });
    assert.equal(res.data.damagePayment, p.id);
    assert.deepEqual([payment(p.id).status, payment(p.id).error_code, fee(a).status], ['failed', 'EXPIRED_PAYMENT_METHOD', 'notice']);
    await settle();
    assert.ok(toSam(mail).find((e) => e.subject === "We couldn't take the charge for Catan"), "it's Sam's card, so Sam hears");
  } finally {
    mail.restore();
  }
});

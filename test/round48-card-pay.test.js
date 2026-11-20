// Round 48 (contract v48-card-pay): My Lair's bill paid by card on the phone. Scaffold from round33-credit-pay.test.js.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { CARD_PAY, CARD_PAY_WORDS as W } from '../src/card-pay.js';
import { TILL_SALE_WORDS as S } from '../src/till-sales.js';
import { shopifyTabPrices } from './tab-prices.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 60 * MIN;
// Saturday 7 November 2026, 2:00pm in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 10, 7, 1, 0);
const DAY = '2026-11-07';
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const realNow = Date.now;
const nowIs = (ms) => {
  Date.now = () => ms;
};

let background = [];
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
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: (p) => background.push(p) };
}
/** Everything the Lair left running in the background, finished */
const settle = async () => {
  while (background.length) await background.shift();
};

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];
// Mo (the owner); Hemi, a helper with Check-in; members Mia and Kai
const OWNER = '9001';
const HEMI = '9102';
const MIA = '6001';
const KAI = '6002';

/* ---------- the shop's products, for the till ---------- */
const VARIANTS = {
  5011: { id: '5011', title: 'Oakie Doakie Translucent RPG Dice Set', variantTitle: 'Green', price: 1599 },
  5013: { id: '5013', title: 'Riftbound Radiance', variantTitle: 'Booster Pack', price: 1100 },
};
const COKE = { variantId: '4401', title: 'Coke', variantTitle: 'Default Title', price: 350, qty: 2 };

/** Shopify's figures for a draft's lines: the shop's prices (no deal), GST */
function figuresFor(lines) {
  const out = lines.map((l) => {
    if (l.variantId && VARIANTS[l.variantId] && l.cents == null) {
      const v = VARIANTS[l.variantId];
      return { uuid: l.uuid, title: v.title, variantTitle: v.variantTitle, variantId: l.variantId, qty: l.qty, unit: v.price, total: v.price * l.qty, paid: v.price * l.qty, custom: false, attributes: l.attributes || {} };
    }
    const unit = l.cents;
    const qty = l.variantId ? l.qty || 1 : 1;
    return { uuid: l.uuid, title: l.title, variantTitle: '', variantId: l.variantId || null, qty, unit, total: unit * qty, paid: unit * qty, custom: !l.variantId, attributes: l.attributes || {} };
  });
  const total = out.reduce((sum, l) => sum + l.total, 0);
  return { subtotal: total, discounts: [], total, gst: Math.round((total * 3) / 23), taxIncluded: true, lines: out };
}

let lair;
let shop;
let cards;
// A pretend Shopify store credit: each customer's balance, every change asked for, and what it does with the next one:
// null (it moves), 'short' (Shopify says there isn't enough), 'refuse' (Shopify says no), 'silent' (it moves, but the
// answer is lost) or 'lost' (nothing moves, and the answer is lost). during: run while the change is with Shopify.
let balances;
let changes;
let says;
let transactions;
let during;
// the time each store credit change was given with Shopify
let timeouts;
function fakeShopify() {
  shop = { drafts: [], deleted: [], completed: [], fulfilled: [], failCreate: 0 };
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.storeCreditBalance = async (id) => balances.get(String(id)) || 0;
  lair.shopify.changeStoreCredit = async (id, cents, currency, opts = {}) => {
    timeouts.push(opts.timeout ?? null);
    const how = says.shift() ?? null;
    changes.push([String(id), cents]);
    if (during) {
      const fn = during;
      during = null;
      await fn();
    }
    if (how === 'short' || (cents < 0 && (balances.get(String(id)) || 0) + cents < 0)) {
      throw Object.assign(new Error('Insufficient funds'), { refused: true, code: 'INSUFFICIENT_FUNDS' });
    }
    if (how === 'refuse') throw Object.assign(new Error('Account is closed'), { refused: true, code: 'ACCOUNT_CLOSED' });
    if (how === 'lost') throw new Error('The operation was aborted due to timeout');
    const after = (balances.get(String(id)) || 0) + cents;
    balances.set(String(id), after);
    const tx = { id: `gid://shopify/StoreCreditAccountTransaction/${transactions.length + 1}`, customerId: String(id), cents, at: Date.now() };
    transactions.push(tx);
    if (how === 'silent') throw new Error('The operation was aborted due to timeout');
    return { id: tx.id, balanceAfter: after };
  };
  lair.shopify.storeCreditDebits = async (id) => transactions.filter((t) => t.customerId === String(id) && t.cents < 0).reverse()
    .map((t) => ({ id: t.id, amount: -t.cents, balanceAfter: null, createdAt: t.at, fromOrder: false }));
  // My Lair's orders (as cash's), and the till's drafts
  const makeDraft = (input) => {
    const draft = { id: `gid://shopify/DraftOrder/${900 + shop.drafts.length}`, input, figures: figuresFor(input.lines), order: null };
    shop.drafts.push(draft);
    return draft;
  };
  lair.shopify.createPaidLinesDraft = async (input) => {
    if (shop.failCreate > 0) {
      shop.failCreate -= 1;
      throw new Error('Shopify is down');
    }
    return { id: makeDraft(input).id, ready: true };
  };
  lair.shopify.createTillDraft = async (input) => {
    const draft = makeDraft(input);
    return { id: draft.id, ready: true, ...draft.figures };
  };
  lair.shopify.tillDraft = async (id) => {
    const d = shop.drafts.find((x) => x.id === id && !shop.deleted.includes(id));
    return d ? { id, status: d.order ? 'COMPLETED' : 'OPEN', ready: true, order: d.order, ...d.figures } : null;
  };
  lair.shopify.completePaidDraft = async (id) => {
    const d = shop.drafts.find((x) => x.id === id && !shop.deleted.includes(id));
    if (!d) return { order: null, status: null, errors: ['Draft order not found'] };
    if (!d.order) {
      d.order = { id: `gid://shopify/Order/${8000 + shop.completed.length}`, name: `#${3000 + shop.completed.length}`, total: d.figures.total };
      shop.completed.push(id);
    }
    return { order: d.order, status: 'COMPLETED', errors: [] };
  };
  lair.shopify.draftOrderState = async (id) => {
    const d = shop.drafts.find((x) => x.id === id && !shop.deleted.includes(id));
    return d ? { id, status: d.order ? 'COMPLETED' : 'OPEN', ready: true, order: d.order } : null;
  };
  lair.shopify.findMarkedOrder = async (customerId, tag, key, value) => shop.drafts.find((d) => d.order && d.input.marker?.[key] === value && d.input.tags.includes(tag))?.order || null;
  lair.shopify.findMarkedDraft = async (customerId, tag, key, value) => {
    const d = shop.drafts.find((x) => x.input.marker?.[key] === value && x.input.tags.includes(tag));
    return d ? { id: d.id, status: d.order ? 'COMPLETED' : 'OPEN', ready: true, order: d.order } : null;
  };
  lair.shopify.deleteDraftIfOpen = async (id) => {
    const d = shop.drafts.find((x) => x.id === id);
    if (!d || d.order) return false;
    shop.deleted.push(id);
    return true;
  };
  lair.shopify.fulfilTillOrder = async (orderId, location) => {
    shop.fulfilled.push({ orderId, location });
    return { fulfilled: 1, moved: 0 };
  };
}

async function call(method, path, body, customer = '', client = '203.0.113.7') {
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, 'X-Lair-Client': client },
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, data: await response.json() };
}
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const said = (res, status, words) => {
  assert.equal(res.status, status, res.data.error);
  if (words) assert.equal(res.data.error, words);
};
const me = async (who) => ok(await call('GET', 'me', null, who));
let keys = 0;
const payCredit = (who, expect, key = `pay-key-${String((keys += 1)).padStart(4, '0')}`) => call('POST', 'me/credit', { expect, key }, who);
const creditRow = (id) => ({ ...lair.sql.exec('SELECT * FROM credit_payments WHERE id = ?', id).one() });
const creditRows = () => lair.sql.exec('SELECT * FROM credit_payments ORDER BY created_at, rowid').toArray();
const bookingRow = (id) => lair.sql.exec('SELECT * FROM bookings WHERE id = ?', id).one();
const saleRow = (id) => lair.sql.exec('SELECT * FROM till_sales WHERE id = ?', id).one();
const upkeep = () => lair.creditPayUpkeep(Date.now());
/** Mia's table for `people` at 6pm tonight, paid on the day ($10 a person) → the booking */
async function table(who = MIA, over = {}) {
  return ok(await call('POST', 'bookings', {
    kind: 'table', tables: ['T1'], start: at(DAY, 18), end: at(DAY, 20), people: 2, name: 'Mia Chen', email: 'mia@example.com', phone: '021 555 0100', pay: 'day', ...over,
  }, who)).booking;
}
// someone on the till with their own PIN (the counter tablet is logged in as the owner's account)
const onTill = async (id, pin = '2580', as = OWNER) => {
  const u = ok(await call('POST', 'till/unlock', { id, pin: '1234' }, as));
  ok(await call('POST', 'till/pin', { token: u.token, pin }, as));
  return u.token;
};
const TILL = 'counter-tablet-1';
const pay = (body, as = OWNER) => call('POST', 'till/pay', { till: TILL, ...body }, as);
const paid = (body, as = OWNER) => call('POST', 'till/paid', body, as);

function fakeCards() {
  const made = [];
  const state = new Map(); // ref → { status, amount }
  return {
    name: 'fake', made, state, refunds: [], failStart: null, failLook: null, failRefund: null,
    async start(input) {
      if (this.failStart) throw this.failStart;
      const ref = `chk_${made.length + 1}`;
      made.push({ ref, ...input });
      state.set(ref, { status: 'open', amount: input.amount });
      return { ref, url: `https://pay.example/${ref}` };
    },
    async look(ref) {
      if (this.failLook) throw this.failLook;
      return { ...(state.get(ref) || { status: 'failed', amount: 0 }) };
    },
    async refund(ref, amount, key) {
      if (this.failRefund) throw this.failRefund;
      this.refunds.push({ ref, amount, key });
      return { id: `rf_${this.refunds.length}` };
    },
    pay(ref) { state.get(ref).status = 'paid'; },
  };
}

beforeEach(async () => {
  background = [];
  keys = 0;
  balances = new Map([[MIA, 5000], [KAI, 0]]);
  changes = [];
  says = [];
  transactions = [];
  during = null;
  timeouts = [];
  globalThis.fetch = async (url) => {
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'dice-goblin.myshopify.com' });
  shopifyTabPrices(lair); // 17 Nov 2026: the Lair prices a tab from Shopify (test/tab-prices.js)
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.searchCustomers = async () => [{ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }];
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  lair.accountEmail = async () => ({ fetched: false, email: '' });
  lair.checkGiftCodes = async () => 0;
  fakeShopify();
  cards = fakeCards();
  lair.cards = cards;
  lair.alerts = [];
  lair.notifyStaff = (subject, content) => lair.alerts.push({ subject, intro: content?.intro || '' });
  lair.mail = async () => ({ ok: true });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  ok(await call('POST', 'team', { customerId: HEMI, name: 'Hemi Walker', email: 'hemi@example.com', perms: ['checkin'] }, OWNER));
  for (const [id, name] of [[MIA, 'Mia Chen'], [KAI, 'Kai Tane']]) {
    lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
  }
});

afterEach(async () => {
  await settle();
  Date.now = realNow;
});

const payCard = (who, expect, key = 'card-key-0001', back) => call('POST', 'me/card', { expect, key, ...(back ? { back } : {}) }, who);
// (a few seconds on each time: the provider is asked about one payment at most every CARD_PAY.askEvery)
const checkCard = (who, id) => {
  nowIs(Date.now() + CARD_PAY.askEvery);
  return call('POST', `me/card/${id}`, {}, who);
};
const cardRow = (id) => lair.sql.exec('SELECT * FROM card_payments WHERE id = ?', id).one();
const cardUpkeep = () => lair.cardPayUpkeep(Date.now());
const board = async (who) => ok(await call('GET', `floor?from=${at(DAY, 0)}&to=${at(DAY, 24)}`, null, who));
// Mia's bill: a $20 table tonight and a $7 tab
const bill = async () => {
  const booking = await table();
  ok(await call('POST', 'tab', { items: [COKE] }, MIA));
  return booking;
};

test('card: the whole bill is paid in one payment, only once the provider says the card was charged', async () => {
  said(await payCard('', 0), 401, W.login);
  said(await payCard(MIA, 0), 409, W.nothing);
  said(await call('POST', 'me/card', { expect: 0, key: 'short' }, MIA), 400, W.key);
  const booking = await bill();
  said(await payCard(MIA, 2000), 409, W.changed(2700));
  assert.equal(cards.made.length, 0, 'no card page until the total matches');
  const page = await me(MIA);
  assert.deepEqual({ on: page.cardPay.on, open: page.cardPay.open, nudgeUnder: page.cardPay.nudgeUnder, hint: page.cardPay.hint }, { on: true, open: null, nudgeUnder: CARD_PAY.nudgeUnder, hint: W.hint });

  const res = ok(await payCard(MIA, 2700, 'card-key-0001', '/pages/my-lair?paid=1'));
  assert.equal(res.message, W.waiting);
  assert.equal(res.url, 'https://pay.example/chk_1');
  assert.equal(res.card.status, 'open');
  assert.deepEqual(cards.made.map((m) => [m.amount, m.currency, m.back, m.id === res.card.id, m.expiresAt]), [[2700, 'NZD', '/pages/my-lair?paid=1', true, NOW + CARD_PAY.openMs]]);
  // opening the page pays nothing
  assert.equal(bookingRow(booking.id).paid, 0);
  assert.equal((await me(MIA)).cardPay.open.url, res.url);
  // asking before they've paid: still nothing
  assert.equal(ok(await checkCard(MIA, res.card.id)).message, W.notYet);
  assert.equal(bookingRow(booking.id).paid, 0);
  // someone else can't ask about it
  said(await checkCard(KAI, res.card.id), 404, W.notFound);

  cards.pay('chk_1');
  const done = ok(await checkCard(MIA, res.card.id));
  assert.equal(done.card.status, 'paid');
  assert.equal(done.message, W.paid(2700));
  assert.equal(bookingRow(booking.id).paid, 1);
  assert.equal(lair.sql.exec("SELECT status FROM tabs WHERE customer_id = ?", MIA).one().status, 'paid');
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM payments WHERE order_id = ?", `card:${res.card.id}`).one().n, 1);
  const after = await me(MIA);
  assert.equal(after.cardPay.open, null);
  // asking again, or the same tap again, moves nothing
  assert.equal(ok(await checkCard(MIA, res.card.id)).card.status, 'paid');
  assert.equal(ok(await payCard(MIA, 2700, 'card-key-0001')).repeated, true);
  said(await payCard(MIA, 2700, 'card-key-0002'), 409, W.nothing);
  assert.equal(cards.made.length, 1);
  assert.equal(cards.refunds.length, 0);

  // its Shopify order: the table as a custom line, the tab's things as their products, tagged and marked
  await settle();
  const row = cardRow(res.card.id);
  assert.equal(row.order_status, 'made');
  const draft = shop.drafts.find((d) => d.input.marker?._lair_card === res.card.id);
  assert.deepEqual(draft.input.tags, ['lair-card', 'card']);
  assert.equal(draft.input.lines.length, 2);
  assert.equal(draft.input.lines.reduce((sum, l) => sum + l.cents * (l.qty || 1), 0), 2700);
});

test('card: the same bill gets the same card page back; a changed bill gets a fresh one and the old one closes', async () => {
  await bill();
  const first = ok(await payCard(MIA, 2700, 'card-key-0001'));
  const same = ok(await payCard(MIA, 2700, 'card-key-0002'));
  assert.equal(same.card.id, first.card.id);
  assert.equal(same.repeated, true);
  assert.equal(cards.made.length, 1);
  ok(await call('POST', 'tab', { items: [COKE, COKE] }, MIA));
  const total = (await me(MIA)).dueNow?.total ?? lair.cashBill(MIA, lair.rulesCache, Date.now()).total;
  const fresh = ok(await payCard(MIA, total, 'card-key-0003'));
  assert.notEqual(fresh.card.id, first.card.id);
  assert.equal(cardRow(first.card.id).status, 'expired');
  // a page nearly out of time isn't handed out again
  nowIs(NOW + CARD_PAY.openMs - MIN);
  const late = ok(await payCard(MIA, total, 'card-key-0004'));
  assert.notEqual(late.card.id, fresh.card.id);
});

test('card: charged after the bill was paid another way, it all goes back to the card and pays nothing', async () => {
  const booking = await bill();
  const res = ok(await payCard(MIA, 2700));
  // meanwhile Mia pays the same bill with store credit
  ok(await call('POST', 'me/credit', { expect: 2700, key: 'pay-key-0100' }, MIA));
  assert.equal(bookingRow(booking.id).paid, 1);
  cards.pay('chk_1');
  const back = ok(await checkCard(MIA, res.card.id));
  // (the fake provider answers at once, so the refund may already be back)
  assert.ok(['refunding', 'refunded'].includes(back.card.status));
  await settle();
  assert.deepEqual(cards.refunds, [{ ref: 'chk_1', amount: 2700, key: res.card.id }]);
  assert.equal(cardRow(res.card.id).status, 'refunded');
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM payments WHERE order_id = ?", `card:${res.card.id}`).one().n, 0);
  assert.equal(ok(await checkCard(MIA, res.card.id)).message, W.refunded);
});

test('card: a refund the provider does not confirm, or a different amount taken, goes to staff and never pays the bill', async () => {
  const booking = await bill();
  const res = ok(await payCard(MIA, 2700));
  ok(await call('POST', 'me/credit', { expect: 2700, key: 'pay-key-0100' }, MIA));
  cards.pay('chk_1');
  cards.failRefund = new Error('timed out');
  ok(await checkCard(MIA, res.card.id));
  await settle();
  assert.equal(cardRow(res.card.id).status, 'check');
  assert.equal(lair.alerts.filter((a) => /Refund a card payment by hand: Mia Chen/.test(a.subject)).length, 1);
  assert.equal((await me(MIA)).cardPay.open.status, 'check');
  assert.equal(ok(await checkCard(MIA, res.card.id)).message, W.check);

  // Kai's provider says it took $1, not the $20 bill
  const kai = await table(KAI, { tables: ['T2'], name: 'Kai Tane', email: 'kai@example.com' });
  const k = ok(await payCard(KAI, 2000, 'card-key-kai1'));
  cards.state.set('chk_2', { status: 'paid', amount: 100 });
  assert.equal(ok(await checkCard(KAI, k.card.id)).card.status, 'check');
  assert.equal(bookingRow(kai.id).paid, 0);
  assert.equal(bookingRow(booking.id).paid, 1);
});

test('card: no provider, a page that will not open, a monthly account and the till all say so, and nothing is paid', async () => {
  const booking = await bill();
  lair.cards = null;
  assert.equal((await me(MIA)).cardPay.on, false);
  said(await payCard(MIA, 2700), 503, W.off);
  lair.cards = cards;
  cards.failStart = new Error('down');
  said(await payCard(MIA, 2700, 'card-key-0002'), 503, W.notStarted);
  assert.equal(lair.sql.exec("SELECT status FROM card_payments WHERE key = 'card-key-0002'").one().status, 'failed');
  cards.failStart = null;
  // a page that isn't https is never handed to a phone
  cards.start = async () => ({ ref: 'x', url: 'http://pay.example/x' });
  said(await payCard(MIA, 2700, 'card-key-0003'), 503, W.notStarted);
  // a back link that leaves the website is dropped
  cards.start = async (input) => { cards.made.push(input); return { ref: 'chk_9', url: 'https://pay.example/chk_9' }; };
  ok(await payCard(MIA, 2700, 'card-key-0004', '//evil.example/x'));
  assert.equal(cards.made.at(-1).back, '/');
  // their tab at the counter's till: pay there
  lair.write("UPDATE tabs SET status = 'in-cart' WHERE customer_id = ?", MIA);
  said(await payCard(MIA, 2700, 'card-key-0005'), 409, W.atCounter);
  lair.write("UPDATE tabs SET status = 'open' WHERE customer_id = ?", MIA);
  ok(await call('POST', `members/${MIA}/account`, { billing: 'monthly', creditLimit: 10000 }, OWNER));
  said(await payCard(MIA, 2700, 'card-key-0006'), 409, W.monthly);
  assert.equal((await me(MIA)).cardPay.on, false);
  assert.equal(bookingRow(booking.id).paid, 0);
});

test('card: the 10-minute run marks a bill paid when they closed the page, expires unpaid pages and looks once more', async () => {
  const booking = await bill();
  const res = ok(await payCard(MIA, 2700));
  cards.pay('chk_1');
  assert.deepEqual(await cardUpkeep(), { paid: 1 });
  assert.equal(bookingRow(booking.id).paid, 1);

  const kai = await table(KAI, { tables: ['T2'], name: 'Kai Tane', email: 'kai@example.com' });
  const k = ok(await payCard(KAI, 2000, 'card-key-kai1'));
  assert.deepEqual(await cardUpkeep(), { open: 1 });
  nowIs(NOW + CARD_PAY.openMs + MIN);
  assert.deepEqual(await cardUpkeep(), { expired: 1 });
  assert.equal(ok(await checkCard(KAI, k.card.id)).message, W.expired);
  // still watched after it closed: paid late, it's found (by the run, or by Kai asking) and pays the bill, since nothing changed
  nowIs(NOW + CARD_PAY.openMs + 20 * MIN);
  assert.deepEqual(await cardUpkeep(), { expired: 1 });
  cards.pay('chk_2');
  nowIs(NOW + CARD_PAY.openMs + 40 * MIN);
  assert.equal(ok(await checkCard(KAI, k.card.id)).card.status, 'paid');
  assert.equal(bookingRow(kai.id).paid, 1);
  assert.equal(await cardUpkeep(), null);
  assert.equal(cardRow(res.card.id).status, 'paid');
});

test('card: a replaced page paid late pays an unchanged bill once; both pages paid, the second goes back', async () => {
  const booking = await bill();
  const first = ok(await payCard(MIA, 2700, 'card-key-0001'));
  nowIs(NOW + CARD_PAY.openMs - MIN);
  const second = ok(await payCard(MIA, 2700, 'card-key-0002'));
  assert.equal(cardRow(first.card.id).status, 'expired');
  cards.pay('chk_1');
  cards.pay('chk_2');
  nowIs(NOW + CARD_PAY.openMs);
  assert.equal(ok(await checkCard(MIA, first.card.id)).card.status, 'paid');
  assert.equal(bookingRow(booking.id).paid, 1);
  ok(await checkCard(MIA, second.card.id));
  await settle();
  assert.equal(cardRow(second.card.id).status, 'refunded');
  assert.deepEqual(cards.refunds.map((r) => r.ref), ['chk_2']);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM payments WHERE order_id LIKE 'card:%'").one().n, 1);
});

test('card: a failed try is still watched, the watch ends two hours after the page closes, and two looks at once pay once', async () => {
  const booking = await bill();
  const res = ok(await payCard(MIA, 2700));
  cards.state.get('chk_1').status = 'failed';
  nowIs(NOW + 5000);
  assert.equal(ok(await checkCard(MIA, res.card.id)).message, W.failed);
  // a second try on the same page goes through
  cards.pay('chk_1');
  nowIs(NOW + 10000);
  const [a, b] = await Promise.all([lair.cardPayLook(res.card.id), lair.cardPayLook(res.card.id)]);
  assert.deepEqual([a, b].sort(), ['paid', 'paid']);
  assert.equal(bookingRow(booking.id).paid, 1);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM payments WHERE order_id = ?", `card:${res.card.id}`).one().n, 1);

  const kai = await table(KAI, { tables: ['T2'], name: 'Kai Tane', email: 'kai@example.com' });
  const k = ok(await payCard(KAI, 2000, 'card-key-kai1'));
  nowIs(NOW + CARD_PAY.openMs + MIN);
  await cardUpkeep();
  nowIs(NOW + CARD_PAY.openMs + CARD_PAY.watchMs + MIN);
  await cardUpkeep();
  assert.ok(cardRow(k.card.id).looked_at);
  assert.equal(await cardUpkeep(), null);
  assert.equal(bookingRow(kai.id).paid, 0);
});

test('card: a page cut off by a restart is failed, and the provider not answering changes nothing', async () => {
  await bill();
  const res = ok(await payCard(MIA, 2700));
  cards.failLook = new Error('down');
  assert.equal(ok(await checkCard(MIA, res.card.id)).card.status, 'open');
  cards.failLook = null;
  lair.write("UPDATE card_payments SET status = 'starting', ref = NULL, url = NULL, updated_at = ? WHERE id = ?", NOW - CARD_PAY.stale - 1, res.card.id);
  said(await payCard(MIA, 2700, 'card-key-0002'), 409, W.busy);
  assert.deepEqual(await cardUpkeep(), { failed: 1 });
  ok(await payCard(MIA, 2700, 'card-key-0003'));
});

test('card: staff who take cash see who paid on their phone today; nobody else does', async () => {
  await bill();
  const res = ok(await payCard(MIA, 2700));
  cards.pay('chk_1');
  ok(await checkCard(MIA, res.card.id));
  const kai = await table(KAI, { tables: ['T2'], name: 'Kai Tane', email: 'kai@example.com' });
  balances.set(KAI, 5000);
  ok(await call('POST', 'me/credit', { expect: 2000, key: 'pay-key-kai1' }, KAI));
  assert.ok(kai);
  for (const staff of [OWNER, HEMI]) {
    const list = (await board(staff)).paidOnPhone;
    assert.deepEqual(list.map((p) => [p.name, p.how, p.amount]).sort(), [['Kai Tane', 'credit', 2000], ['Mia Chen', 'card', 2700]]);
    assert.equal(list.find((p) => p.how === 'card').items.length, 2);
  }
  assert.equal((await board(MIA)).paidOnPhone, undefined);
});

// Round 33: paying with store credit, in My Lair and at the till (contract v33-credit-pay). Mo (7 Nov 2026): "I want to
// add pay using store credit for clients as an extra option thanks"; asked where, he picked both: the counter till
// (store credit next to card and cash) and My Lair's bill (Pay with store credit beside Pay with cash). Store credit is
// Shopify's: taken off with a row written first, never twice, and a lost answer never pays anything. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { CREDIT_PAY, CREDIT_PAY_WORDS as W } from '../src/credit-pay.js';
import { TILL_SALE_WORDS as S } from '../src/till-sales.js';

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

/* ---------------- the words ---------------- */

test('round 33: the words, word for word, and the waits', () => {
  assert.deepEqual([CREDIT_PAY.lookAfter, CREDIT_PAY.goneAfter, CREDIT_PAY.stale, CREDIT_PAY.askAfter], [2 * MIN, 30 * MIN, 30 * MIN, 2 * HOUR]);
  assert.equal(W.login, 'Log in to pay with your store credit.');
  assert.equal(W.noAccount, 'Open My Lair once first, then try again.');
  assert.equal(W.key, "That didn't come through properly. Try again.");
  assert.equal(W.expect, 'expect is the amount you were shown, in cents.');
  assert.equal(W.monthly, "You're on a monthly account, so it all goes on your bill. Pay it online in My Lair, or at the counter.");
  assert.equal(W.nothing, "There's nothing to pay right now.");
  assert.equal(W.passCovered, 'Your session pass covered it, so there\'s nothing to pay.');
  assert.equal(W.changed(1500), "Your bill's $15.00 now (a session pass took some off, or something changed). Check it, then pay again.");
  assert.equal(W.atCounter, "It's being rung up at the counter right now, so pay there.");
  assert.equal(W.off, "Store credit can't be used right now. Try again in a minute.");
  assert.equal(W.short(850, 1500), 'You have $8.50 of store credit, so it doesn\'t cover $15.00. Use it at the counter and pay the rest there.');
  assert.equal(W.short(0, 1500), "You don't have any store credit right now.");
  assert.equal(W.shortNow, "You don't have that much store credit now. Check your balance, then try again.");
  assert.equal(W.notTaken('Account is closed'), "Shopify didn't take the store credit off your account (Account is closed). Nothing moved. Try again in a minute.");
  assert.equal(W.busy, 'Your last store credit payment is still being checked. Try again in a few minutes, or pay at the counter.');
  assert.equal(W.checking, "Shopify didn't answer, so your bill wasn't paid. If any store credit came off, Gobgob puts it back within 30 minutes.");
  assert.equal(W.paidElsewhere, "Something on your bill was paid another way just now, so your store credit's going back on. Check your bill, then pay again.");
  assert.equal(W.paid(1500, 850), 'Paid! $15.00 came off your store credit, and $8.50 is left.');
  assert.equal(W.paid(1500, null), 'Paid! $15.00 came off your store credit.');
  assert.equal(W.tillPerson, 'Store credit needs a member on the sale: scan their code first.');
  assert.equal(W.tillOff, "Shopify didn't answer about their store credit. Try again in a moment, or pay another way.");
  assert.equal(W.tillNone, "They don't have any store credit right now.");
  assert.equal(W.tillShort(450, 1900), "Their store credit is $4.50, so it doesn't cover $19.00. Use it for part, and pay the rest by card or cash.");
  assert.equal(W.tillChanged, "Their store credit changed while it was paying, so this sale wasn't saved. Scan their code again.");
  assert.equal(W.tillNotTaken('Account is closed'), "Shopify wouldn't take their store credit (Account is closed), so this sale wasn't saved. Pay another way.");
  assert.equal(W.tillLost, "Shopify didn't answer about their store credit, so this sale wasn't saved. Any that came off goes back on by itself within 30 minutes.");
  assert.equal(W.tillBusy, 'Their last store credit payment is still being checked. Pay another way, or try again in a few minutes.');
  assert.equal(S.method, 'Pay by card, with cash or with store credit.');
});

/* ---------------- My Lair's bill ---------------- */

test('round 33: My Lair\'s bill (tonight\'s table and the tab) is paid from store credit, once, and gets its Shopify order', async () => {
  said(await payCredit('', 0), 401, W.login);
  said(await payCredit(MIA, 0), 409, W.nothing);
  said(await call('POST', 'me/credit', { expect: 0, key: 'short' }, MIA), 400, W.key);
  const booking = await table();
  ok(await call('POST', 'tab', { items: [COKE] }, MIA));
  said(await call('POST', 'me/credit', { expect: 'lots', key: 'pay-key-xyz1' }, MIA), 400, W.expect);
  // what they were shown has to be what it comes to
  said(await payCredit(MIA, 2000), 409, W.changed(2700));
  assert.deepEqual(changes, [], 'nothing taken until it matches');
  lair.tillCredits = new Map([[MIA, { at: Date.now(), cents: 5000 }]]);
  const res = ok(await payCredit(MIA, 2700, 'pay-key-0100'));
  assert.equal(res.message, W.paid(2700, 2300));
  assert.equal(await lair.tillCredit(MIA), 2300, 'the till reads it again');
  assert.equal(res.balance, 2300);
  assert.equal(res.credit.status, 'paid');
  assert.equal(res.credit.amount, 2700);
  assert.deepEqual(res.credit.items.map((x) => [x.kind, x.ref || null, x.amount]), [['booking', booking.ref, 2000], ['tab', null, 700]]);
  assert.deepEqual(changes, [[MIA, -2700]]);
  // paid, not checked in: staff still do that at the counter
  const b = bookingRow(booking.id);
  assert.equal(b.paid, 1);
  assert.equal(b.paid_amount, 2000);
  assert.equal(b.status, 'confirmed');
  const payment = lair.sql.exec('SELECT * FROM payments WHERE booking_id = ?', booking.id).one();
  assert.equal(payment.order_id, `credit:${res.credit.id}`);
  assert.equal(payment.customer_id, MIA, 'the member is the payer');
  assert.equal(lair.sql.exec('SELECT status FROM tabs').one().status, 'paid');
  // the same tap again: the first payment as it stands, nothing moved
  const again = ok(await payCredit(MIA, 2700, 'pay-key-0100'));
  assert.equal(again.repeated, true);
  assert.equal(again.credit.id, res.credit.id);
  assert.deepEqual(changes, [[MIA, -2700]]);
  // its Shopify order, made in the background: lines at what each paid, the tab's things as products, no booking codes
  await settle();
  const draft = shop.drafts.find((d) => d.input.tags.includes('lair-credit'));
  assert.ok(draft, 'a draft order was made');
  assert.deepEqual(draft.input.tags, ['lair-credit', 'store-credit']);
  assert.equal(draft.input.customerId, MIA);
  assert.deepEqual(draft.input.marker, { _lair_credit: res.credit.id });
  assert.equal(draft.input.note, `Paid from store credit in My Lair (${res.credit.id}).`);
  assert.ok(!draft.input.note.includes(booking.ref));
  assert.deepEqual(draft.input.lines.map((l) => (l.variantId ? [l.variantId, l.qty, l.cents] : [l.title.includes(booking.ref), l.cents])), [[true, 2000], ['4401', 2, 350]]);
  const row = creditRow(res.credit.id);
  assert.deepEqual([row.source, row.status, row.order_status, row.order_name], ['me', 'paid', 'made', '#3000']);
  // nothing's left on the bill, and nothing's being checked
  const page = await me(MIA);
  assert.equal(page.creditPay, null);
  said(await payCredit(MIA, 0), 409, W.nothing);
});

test('round 33: a session pass saved on tonight\'s booking is used first; what\'s left is paid from store credit', async () => {
  const pass = ok(await call('POST', 'passes', { label: 'Mia\'s 2 sessions', sessions: 2, holderName: '', customerId: MIA }, OWNER)).pass;
  const booking = await table(MIA, { people: 3, usePass: pass.code });
  // the bill shows $30 (nothing's used until check-in); paying uses the pass first, so it comes to $10 now
  said(await payCredit(MIA, 3000), 409, W.changed(1000));
  assert.deepEqual(changes, []);
  assert.equal(bookingRow(booking.id).covered, 2000, 'the pass covered two of the three');
  assert.equal(bookingRow(booking.id).status, 'confirmed', 'not checked in');
  const res = ok(await payCredit(MIA, 1000));
  assert.equal(res.credit.amount, 1000);
  assert.deepEqual(changes, [[MIA, -1000]]);
  assert.equal(bookingRow(booking.id).paid, 1);
  // a pass that covers it all: nothing to pay
  const pass2 = ok(await call('POST', 'passes', { label: 'Kai\'s 5 sessions', sessions: 5, holderName: '', customerId: KAI }, OWNER)).pass;
  await table(KAI, { tables: ['T2'], name: 'Kai Tane', email: 'kai@example.com', usePass: pass2.code });
  balances.set(KAI, 3000);
  said(await payCredit(KAI, 2000), 409, W.passCovered);
});

test('round 33: not enough store credit, a monthly account, Shopify saying no, and Shopify off: nothing is paid', async () => {
  const booking = await table();
  balances.set(MIA, 1500);
  said(await payCredit(MIA, 2000), 409, W.short(1500, 2000));
  balances.set(MIA, 0);
  said(await payCredit(MIA, 2000), 409, W.short(0, 2000));
  assert.deepEqual(changes, [], 'never asked Shopify');
  balances.set(MIA, 5000);
  says.push('short');
  said(await payCredit(MIA, 2000), 409, W.shortNow);
  says.push('refuse');
  said(await payCredit(MIA, 2000), 409, W.notTaken('Account is closed'));
  assert.equal(bookingRow(booking.id).paid, 0);
  assert.deepEqual(creditRows().map((r) => r.status), ['failed', 'failed']);
  // a monthly account pays its bill instead
  ok(await call('POST', `members/${KAI}/account`, { billing: 'monthly', creditLimit: 10000 }, OWNER));
  balances.set(KAI, 5000);
  await table(KAI, { tables: ['T2'], name: 'Kai Tane', email: 'kai@example.com' });
  said(await payCredit(KAI, 2000), 409, W.monthly);
  // Shopify's balance unreadable
  lair.shopify.storeCreditBalance = async () => {
    throw new Error('Shopify is down');
  };
  said(await payCredit(MIA, 2000), 503, W.off);
});

test('round 33: a lost answer pays nothing: found in their store credit it goes back on; not there after 30 minutes, it never came off', async () => {
  const booking = await table();
  says.push('silent');
  const res = ok(await payCredit(MIA, 2000));
  assert.equal(res.credit.status, 'checking');
  assert.equal(res.message, W.checking);
  assert.equal(bookingRow(booking.id).paid, 0, 'not paid');
  assert.equal((await me(MIA)).creditPay.status, 'checking');
  // one at a time
  said(await payCredit(MIA, 2000), 409, W.busy);
  // not looked for until 2 minutes on
  assert.equal((await upkeep())?.looked || 0, 0);
  nowIs(NOW + 3 * MIN);
  await upkeep();
  await settle();
  const row = creditRow(res.credit.id);
  assert.equal(row.status, 'returned');
  assert.deepEqual(changes, [[MIA, -2000], [MIA, 2000]]);
  assert.equal(balances.get(MIA), 5000);
  assert.equal(bookingRow(booking.id).paid, 0);
  assert.equal((await me(MIA)).creditPay, null);
  // nothing moved this time: still nothing after 3 minutes; failed after 30
  says.push('lost');
  const lost = ok(await payCredit(MIA, 2000));
  nowIs(NOW + 6 * MIN);
  await upkeep();
  assert.equal(creditRow(lost.credit.id).status, 'checking');
  nowIs(NOW + 34 * MIN);
  await upkeep();
  assert.equal(creditRow(lost.credit.id).status, 'failed');
  assert.deepEqual(changes, [[MIA, -2000], [MIA, 2000], [MIA, -2000]]);
  // and paying works again
  ok(await payCredit(MIA, 2000));
  assert.equal(bookingRow(booking.id).paid, 1);
});

test('round 33: paid another way while the store credit came off: it all goes back on, and nothing is paid twice', async () => {
  const booking = await table();
  // staff take cash for it while Shopify is busy with the store credit
  during = async () => {
    const rules = await lair.rules();
    lair.recordPayments([{ type: 'booking', id: booking.id, lineId: 'line-1', amount: 2000 }], 'cash:elsewhere', rules, { pos: true });
  };
  said(await payCredit(MIA, 2000), 409, W.paidElsewhere);
  await settle();
  assert.deepEqual(changes, [[MIA, -2000], [MIA, 2000]]);
  assert.equal(creditRows()[0].status, 'returned');
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM payments WHERE booking_id = ?", booking.id).one().n, 1, 'only the cash');
});

test('round 33: no answer while it goes back on: staff check it in Shopify admin', async () => {
  await table();
  says.push('silent', 'lost');
  ok(await payCredit(MIA, 2000));
  nowIs(NOW + 3 * MIN);
  await upkeep();
  await settle();
  const row = creditRows()[0];
  assert.deepEqual([row.status, row.stage], ['check', 'back']);
  assert.equal(lair.alerts.length, 1);
  assert.match(lair.alerts[0].subject, /^Check a store credit payment: Mia C\./);
  assert.match(lair.alerts[0].intro, /\$20\.00/);
  // it doesn't hold up paying again
  ok(await payCredit(MIA, 2000));
});

test('round 33: a store credit order Shopify won\'t make yet is tried again', async () => {
  await table();
  shop.failCreate = 1;
  const res = ok(await payCredit(MIA, 2000));
  await settle();
  assert.equal(creditRow(res.credit.id).order_status, 'failed');
  nowIs(NOW + 11 * MIN);
  await lair.retryCreditOrders(Date.now());
  await settle();
  const row = creditRow(res.credit.id);
  assert.deepEqual([row.order_status, row.order_name], ['made', '#3000']);
});

test('round 33: a store credit gift\'s lost answer never takes a payment\'s debit for its own', async () => {
  await table();
  const res = ok(await payCredit(MIA, 2000));
  assert.equal(res.credit.status, 'paid');
  // a gift of the same amount a minute later, whose answer is lost and which never came off
  nowIs(NOW + MIN);
  says.push('lost');
  const gift = ok(await call('POST', 'me/credit/gift', { code: lair.memberRow(KAI).code, amount: 2000, key: 'gift-key-0001' }, MIA));
  assert.equal(gift.gift.status, 'checking');
  nowIs(NOW + 4 * MIN);
  await lair.creditGiftUpkeep(Date.now());
  assert.equal(lair.sql.exec('SELECT status FROM credit_gifts').one().status, 'checking', 'the payment\'s debit isn\'t the gift\'s');
  assert.equal(balances.get(KAI) || 0, 0, 'nothing was given');
});

/* ---------------- the till ---------------- */

test('round 33: at the till, store credit pays all of it with no PIN, and the sale is paid', async () => {
  said(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }], method: 'credit' }), 422, W.tillPerson);
  said(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }], person: KAI, method: 'credit' }), 409, W.tillNone);
  said(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }], person: MIA, method: 'gold' }), 400, S.method);
  const res = ok(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }], person: MIA, method: 'credit' }));
  const sale = res.sale;
  assert.equal(sale.status, 'paid');
  assert.deepEqual([sale.total, sale.credit, sale.due], [1100, 1100, 0]);
  assert.deepEqual(changes, [[MIA, -1100]]);
  const draft = shop.drafts[0];
  assert.deepEqual(draft.input.tags, ['lair-till', 'till', 'credit', 'store-credit']);
  assert.equal(draft.input.note, `Sold on the Lair till, with store credit (${sale.id}).`);
  await settle();
  const row = saleRow(sale.id);
  assert.deepEqual([row.status, row.by, row.credit, row.order_status], ['paid', 'customer', 1100, 'made']);
  assert.equal(shop.completed.length, 1);
  assert.equal(creditRow(row.credit_id).status, 'paid');
  assert.equal(creditRow(row.credit_id).source, 'till');
  // all of it with store credit that doesn't cover it
  balances.set(MIA, 450);
  said(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }], person: MIA, method: 'credit' }), 409, W.tillShort(450, 1100));
  assert.deepEqual(changes, [[MIA, -1100]], 'never asked Shopify');
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM till_sales WHERE status IN ('open', 'making')").one().n, 0, 'the sale was let go');
});

test('round 33: once store credit moves, the till reads it again (not the balance it kept for a minute)', async () => {
  balances.set(MIA, 5000);
  assert.equal(await lair.tillCredit(MIA), 5000);
  balances.set(MIA, 4000);
  assert.equal(await lair.tillCredit(MIA), 5000, 'kept a minute (round 32)');
  ok(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }], person: MIA, method: 'credit' }));
  await settle();
  assert.equal(await lair.tillCredit(MIA), 2900, 'paid at the till: read again');
  // part of a sale, then Back: taken, then back on
  balances.set(MIA, 500);
  const token = await onTill(HEMI);
  const part = ok(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }], person: MIA, method: 'cash', credit: true, token })).sale;
  assert.deepEqual([part.credit, part.due], [500, 600]);
  assert.equal(await lair.tillCredit(MIA), 0, 'part of a sale: read again');
  ok(await call('POST', 'till/pay/cancel', { sale: part.id }, OWNER));
  await settle();
  assert.equal(await lair.tillCredit(MIA), 500, 'back on: read again');
});

test('round 33: at the till, store credit pays part and the rest goes on the card; expect is what\'s left; Back puts it back', async () => {
  balances.set(MIA, 500);
  const token = await onTill(HEMI);
  const res = ok(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }, { key: 'b', variantId: '5011', qty: 1 }], person: MIA, method: 'card', credit: true, token }));
  const sale = res.sale;
  assert.equal(sale.status, 'open');
  assert.deepEqual([sale.total, sale.credit, sale.due], [2699, 500, 2199]);
  assert.deepEqual(changes, [[MIA, -500]]);
  const draft = shop.drafts[0];
  assert.deepEqual(draft.input.tags, ['lair-till', 'till', 'card', 'credit', 'store-credit']);
  assert.equal(draft.input.note, `Sold on the Lair till, with store credit and by card on the EFTPOS, rung up by Hemi (${sale.id}).`);
  said(await paid({ sale: sale.id, token, expect: 2699 }), 409, S.expect(2199));
  const done = ok(await paid({ sale: sale.id, token, expect: 2199 })).sale;
  assert.equal(done.status, 'paid');
  assert.equal(creditRow(saleRow(sale.id).credit_id).status, 'paid');
  await settle();
  // another one, then Back: the store credit goes back on
  balances.set(MIA, 500);
  const next = ok(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }], person: MIA, method: 'cash', credit: true, token })).sale;
  assert.deepEqual([next.credit, next.due], [500, 600]);
  ok(await call('POST', 'till/pay/cancel', { sale: next.id }, OWNER));
  await settle();
  assert.equal(creditRow(saleRow(next.id).credit_id).status, 'returned');
  assert.deepEqual(changes, [[MIA, -500], [MIA, -500], [MIA, 500]]);
  assert.equal(balances.get(MIA), 500);
  // a new sale on the same till lets the last one go, and its store credit back too
  const third = ok(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }], person: MIA, method: 'card', credit: true, token })).sale;
  ok(await pay({ lines: [{ key: 'a', variantId: '5011', qty: 1 }], method: 'card', token }));
  await settle();
  assert.equal(creditRow(saleRow(third.id).credit_id).status, 'returned');
  assert.equal(balances.get(MIA), 500);
});

test('round 33: at the till, Shopify saying no or not answering about store credit saves nothing', async () => {
  says.push('short');
  said(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }], person: MIA, method: 'credit' }), 409, W.tillChanged);
  says.push('refuse');
  said(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }], person: MIA, method: 'credit' }), 409, W.tillNotTaken('Account is closed'));
  says.push('silent');
  said(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }], person: MIA, method: 'credit' }), 503, W.tillLost);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM till_sales WHERE status = 'paid'").one().n, 0);
  said(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }], person: MIA, method: 'credit' }), 409, W.tillBusy);
  nowIs(NOW + 3 * MIN);
  await upkeep();
  await settle();
  assert.deepEqual(creditRows().map((r) => r.status), ['failed', 'failed', 'returned']);
  assert.equal(balances.get(MIA), 5000);
  ok(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }], person: MIA, method: 'credit' }));
});

test('round 33: My Lair\'s bill being rung up at the till can\'t be paid from My Lair at the same time', async () => {
  const booking = await table();
  const token = await onTill(HEMI);
  ok(await pay({ lines: [{ key: 'b', booking: booking.ref }], person: MIA, method: 'card', token }));
  said(await payCredit(MIA, 2000), 409, W.atCounter);
  assert.deepEqual(changes, []);
});

/* ---------------- the reviews (8 Nov 2026) ---------------- */

test('round 33 review: the till\'s key: Pay again after a lost answer gives back the same sale, so store credit is never taken twice', async () => {
  const token = await onTill(HEMI);
  const coke = [{ key: 'a', variantId: '5013', qty: 1 }];
  // all of it from store credit: the till never heard the answer, so it asks again with the same key
  const one = ok(await pay({ lines: coke, person: MIA, method: 'credit', key: 'till-key-0001' })).sale;
  assert.equal(one.status, 'paid');
  const again = ok(await pay({ lines: coke, person: MIA, method: 'credit', key: 'till-key-0001' }));
  assert.equal(again.sale.id, one.id);
  assert.equal(again.sale.status, 'paid');
  assert.equal(again.repeated, true);
  assert.deepEqual(changes, [[MIA, -1100]], 'taken once');
  // part of it: the same open sale back, with what's left to pay, and no second draft
  balances.set(MIA, 500);
  const part = ok(await pay({ lines: coke, person: MIA, method: 'card', credit: true, token, key: 'till-key-0002' })).sale;
  const part2 = ok(await pay({ lines: coke, person: MIA, method: 'card', credit: true, token, key: 'till-key-0002' })).sale;
  assert.deepEqual([part2.id, part2.status, part2.credit, part2.due], [part.id, 'open', 500, 600]);
  assert.equal(shop.drafts.length, 2);
  assert.deepEqual(changes, [[MIA, -1100], [MIA, -500]]);
  // a sale that was let go: the same key starts a new one
  ok(await call('POST', 'till/pay/cancel', { sale: part.id }, OWNER));
  await settle();
  const fresh = ok(await pay({ lines: coke, person: MIA, method: 'card', credit: true, token, key: 'till-key-0002' })).sale;
  assert.notEqual(fresh.id, part.id);
  assert.deepEqual([fresh.status, fresh.credit], ['open', 500]);
  // asked again while its store credit is still coming off: wait
  ok(await call('POST', 'till/pay/cancel', { sale: fresh.id }, OWNER));
  await settle();
  let meanwhile;
  during = async () => {
    meanwhile = await pay({ lines: coke, person: MIA, method: 'card', credit: true, token, key: 'till-key-0003' });
  };
  ok(await pay({ lines: coke, person: MIA, method: 'card', credit: true, token, key: 'till-key-0003' }));
  said(meanwhile, 409, S.making);
  said(await pay({ lines: coke, method: 'card', key: 'no good!' }), 400, S.key);
  // a key from long ago is never someone's sale now: a new one
  await settle();
  nowIs(Date.now() + 31 * MIN);
  balances.set(MIA, 5000);
  const later = ok(await pay({ lines: coke, person: MIA, method: 'credit', key: 'till-key-0001' })).sale;
  assert.notEqual(later.id, one.id);
  assert.equal(later.status, 'paid');
});

test('round 33 review: store credit at the till gets its own time with Shopify, not what the draft left over', async () => {
  const token = await onTill(HEMI);
  const make = lair.shopify.createTillDraft;
  lair.shopify.createTillDraft = async (input) => {
    // Shopify took 8.5 seconds over the draft
    nowIs(Date.now() + 8_500);
    return make(input);
  };
  ok(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }], person: MIA, method: 'card', credit: true, token }));
  assert.ok(timeouts[0] >= 8_000, `the store credit step had ${timeouts[0]}ms`);
});

test('round 33 review: a till sale can\'t be confirmed while its store credit is still coming off', async () => {
  balances.set(MIA, 500);
  const token = await onTill(HEMI);
  let early;
  during = async () => {
    const open = lair.sql.exec("SELECT id FROM till_sales WHERE status = 'open'").one();
    early = await paid({ sale: open.id, token, expect: 600 });
  };
  const sale = ok(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }], person: MIA, method: 'card', credit: true, token })).sale;
  said(early, 409, S.making);
  assert.deepEqual([sale.status, sale.credit, sale.due], ['open', 500, 600]);
  assert.equal(ok(await paid({ sale: sale.id, token, expect: 600 })).sale.status, 'paid');
  assert.equal(creditRow(saleRow(sale.id).credit_id).status, 'paid');
});

test('round 33 review: paying again straight after Back waits for the last sale\'s store credit to go back on', async () => {
  balances.set(MIA, 500);
  const token = await onTill(HEMI);
  const coke = [{ key: 'a', variantId: '5013', qty: 1 }];
  const first = ok(await pay({ lines: coke, person: MIA, method: 'card', credit: true, token })).sale;
  assert.equal(first.credit, 500);
  // Back: its store credit goes back on, taking Shopify a moment
  during = () => new Promise((resolve) => setTimeout(resolve, 30));
  ok(await call('POST', 'till/pay/cancel', { sale: first.id }, OWNER));
  // cash instead, straight away, with their store credit still ticked
  const again = ok(await pay({ lines: coke, person: MIA, method: 'cash', credit: true, token })).sale;
  assert.deepEqual([again.credit, again.due], [500, 600]);
  // Pay again with no Back first lets that sale go, and waits the same way
  during = () => new Promise((resolve) => setTimeout(resolve, 30));
  const third = ok(await pay({ lines: coke, person: MIA, method: 'card', credit: true, token })).sale;
  assert.deepEqual([third.credit, third.due], [500, 600]);
  await settle();
  assert.equal(creditRow(saleRow(first.id).credit_id).status, 'returned');
  assert.equal(creditRow(saleRow(again.id).credit_id).status, 'returned');
  assert.equal(balances.get(MIA), 0, 'the third sale holds it');
});

test('round 33 review: staff asked to make a till sale\'s order by hand hear it was paid with store credit', async () => {
  const token = await onTill(HEMI);
  const sale = ok(await pay({ lines: [{ key: 'a', variantId: '5013', qty: 1 }], person: MIA, method: 'card', credit: true, token })).sale;
  assert.equal(sale.status, 'paid');
  lair.tillOrderStopped(saleRow(sale.id), 'a test', Date.now());
  const alert = lair.alerts.find((a) => /A till sale with no Shopify order/.test(a.subject));
  assert.match(alert.intro, /paid \$11\.00 with store credit at the till/);
  assert.doesNotMatch(alert.intro, /by card/);
});

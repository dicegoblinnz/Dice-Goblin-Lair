// Round 9, the running tab and monthly accounts (contract v9-tab). Mo (9 Oct): "I want the games booked in through GM
// games or events etc to tie to your QR code and falls into your account. And arguably falls into your tab and you will
// have a running tab with future events and when you settle the tab you can pay for it day by day or if you like you
// can save it to pay it off once a month either up front or compiled. The idea is to track it all in the Shopify."
// Run with: npm test   (under TZ=UTC and TZ=Pacific/Auckland)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair, MIGRATIONS } from '../src/lair.js';
import { LairTime, rulesFromSettings } from '../src/core.js';
import { limitWords, TAB_MESSAGES } from '../src/tab.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Monday 14 September 2026, 9am in Auckland (NZST, UTC+12): round 9 goes live (tabFrom)
const LIVE = at('2026-09-14', 9);
const realNow = Date.now;
let clock = LIVE;
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
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: () => {} };
}

const ROOMS = [
  { id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 },
  { id: 'fancy-room', name: 'Fancy room', code: 'F', tables: 1, seats: 12, price: 15, minPeople: 4, order: 4 },
];
const HOURS = 'Mon 10:00-23:00\nTue 10:00-23:00\nWed 10:00-23:00\nThu 10:00-23:00\nFri 10:00-23:00\nSat 10:00-23:00\nSun 10:00-23:00';
// Trivia nights at the counter ($5 each)
const EVENTS = [
  { id: 'quiz', title: 'Trivia night', start: at('2026-09-17', 18), end: at('2026-09-17', 20), tables: '', capacity: 20, entryFee: 500 },
  { id: 'quiz2', title: 'Trivia night', start: at('2026-10-15', 18), end: at('2026-10-15', 20), tables: '', capacity: 20, entryFee: 500 },
];
const MOBILE = '021 555 0100';
const SAM = '1001';
const KIRI = '1002';

let lair;
let shop;
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
const maintenance = () => internal('maintenance', {});
const me = async (who = SAM) => (await call('GET', 'me', null, who)).data;
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const settle = () => new Promise((r) => setTimeout(r, 10));
const table = (day, hh, over = {}) => ({
  kind: 'table', tables: ['T5'], start: at(day, hh), end: at(day, hh + 2), people: 2, name: 'Sam Jones', email: 'sam@example.com', phone: MOBILE, ...over,
});
/** Book a table as a member (now must be over an hour before it), then optionally check them in at its start */
async function book(day, hh, { who = SAM, over = {}, checkIn = false } = {}) {
  setNow(Math.min(clock, at(day, hh) - 2 * HOUR));
  const res = await call('POST', 'bookings', table(day, hh, over), who);
  assert.equal(res.status, 200, res.data.error);
  if (checkIn) {
    setNow(at(day, hh, 5));
    const checked = await call('POST', 'checkin', { code: res.data.booking.ref }, 'staff');
    assert.equal(checked.status, 200, checked.data.error);
  }
  return res.data.booking;
}
const monthly = (limit = 10000, who = SAM, extra = {}) => call('POST', `members/${who}/account`, { billing: 'monthly', creditLimit: limit, ...extra }, 'staff');
const pocky = (qty = 2) => [{ variantId: '5001', title: 'Pocky', variantTitle: 'Strawberry', price: 450, qty }];

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

/** A fake Shopify: draft orders for bills (each remembered with its input), which order each became, deletes */
function fakeShopify() {
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  const state = { drafts: new Map(), deleted: [], orders: new Map(), failNext: 0, n: 0 };
  lair.shopify.createBill = async (input) => {
    if (state.failNext > 0) {
      state.failNext -= 1;
      throw new Error('Shopify API error 502');
    }
    state.n += 1;
    const id = `gid://shopify/DraftOrder/${900 + state.n}`;
    state.drafts.set(id, input);
    return { draftOrderId: id, invoiceUrl: `https://shop.test/invoices/${900 + state.n}` };
  };
  lair.shopify.draftOrderOrderId = async (id) => state.orders.get(id) ?? null;
  lair.shopify.deleteDraftIfOpen = async (id) => {
    state.deleted.push(id);
    return true;
  };
  lair.shopify.customerEmail = async () => null;
  lair.shopify.customersSince = async () => new Map();
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.appInfo = async () => ({ app: 'Dice Goblin Lair', shop: 'Dice Goblin', scopes: [] });
  lair.shopify.webhookUris = async () => [];
  return state;
}

/** The order Shopify makes when a bill's draft order is paid online, with the draft's own lines and attributes */
function paidDraft(state, draftId, orderNumber) {
  const input = state.drafts.get(draftId);
  const orderId = `gid://shopify/Order/${orderNumber}`;
  state.orders.set(draftId, orderId);
  return {
    id: orderNumber, admin_graphql_api_id: orderId, source_name: 'shopify_draft_order', note_attributes: [{ name: '_bill', value: input.billId }],
    line_items: input.lines.map((l, i) => ({
      id: orderNumber * 100 + i, price: (l.cents / 100).toFixed(2), quantity: l.qty || 1, variant_id: l.variantId || null,
      properties: Object.entries(l.attributes).map(([name, value]) => ({ name, value })),
    })),
  };
}

/** A POS order paying what "Add everything to cart" put in the cart: each row's line, tagged as the tile tags it */
function posOrder(orderNumber, rows) {
  return {
    id: orderNumber, admin_graphql_api_id: `gid://shopify/Order/${orderNumber}`, source_name: 'pos',
    line_items: rows.map((row, i) => ({
      id: orderNumber * 100 + i, price: row.line.price, quantity: 1,
      properties: Object.entries({ ...row.line.properties, _booking: row.line.properties._booking || row.ref }).map(([name, value]) => ({ name, value })),
    })),
  };
}

beforeEach(() => {
  clock = LIVE;
  Date.now = () => clock;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'ep0qiq-rp.myshopify.com' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: false, tags: [] });
  lair.rulesCache = rulesFromSettings({ lair_hours: HOURS, lair_shop_tables: '' }, ROOMS, EVENTS);
  lair.rulesLoadedAt = LIVE + 10 * 365 * DAY;
  shop = fakeShopify();
});
afterEach(() => {
  Date.now = realNow;
});

/** Sam and Kiri as members (GET /me makes their records and codes) */
async function members() {
  for (const [id, name] of [[SAM, 'Sam Jones'], [KIRI, 'Kiri Smith']]) await call('GET', `me?name=${encodeURIComponent(name)}`, null, id);
  lair.sql.exec("UPDATE members SET email = 'sam@example.com' WHERE customer_id = ?", SAM);
  lair.sql.exec("UPDATE members SET email = 'kiri@example.com' WHERE customer_id = ?", KIRI);
}

/* ---------------- the tables ---------------- */

test('tab (round 9): one migration entry, found by what it makes, with the accounts and bills tables', () => {
  const mine = MIGRATIONS.filter((m) => m.some((s) => /tab_accounts/.test(s)));
  assert.equal(mine.length, 1);
  assert.match(mine[0][0], /CREATE TABLE IF NOT EXISTS tab_accounts/);
  assert.match(mine[0][1], /CREATE TABLE IF NOT EXISTS tab_bills/);
  const cols = (t) => lair.sql.exec(`SELECT name FROM pragma_table_info('${t}')`).toArray().map((c) => c.name);
  assert.deepEqual(cols('tab_accounts'), ['customer_id', 'billing', 'credit_limit', 'note', 'periods', 'set_by', 'set_at', 'created_at', 'updated_at']);
  assert.ok(cols('tab_bills').includes('draft_order_id') && cols('tab_bills').includes('invoice_url') && cols('tab_bills').includes('paid_how'));
  assert.equal(lair.tabFrom, LIVE, 'tabFrom is the first start');
});

/* ---------------- pay each visit: nothing changes at the counter ---------------- */

test('tab (round 9): a pay-each-visit member sees today owed and what is coming up, never an earlier visit, and the counter is as before', async () => {
  await members();
  const yesterday = await book('2026-09-15', 18, { checkIn: true });
  const later = await book('2026-09-20', 18, { over: { tables: ['T6'] } });
  const today = await book('2026-09-16', 18, { over: { tables: ['T7'] }, checkIn: true });
  setNow(at('2026-09-16', 19));
  assert.equal((await call('POST', 'tab', { items: pocky(2) }, SAM)).status, 200);
  const { account } = await me();
  assert.equal(account.billing, 'visit');
  assert.equal(account.creditLimit, 0);
  assert.equal(account.available, null);
  assert.deepEqual(account.owed.items.map((i) => [i.kind, i.ref || i.kind, i.amount, i.settle]), [[ 'table', today.ref, 2000, 'day'], ['tab', account.owed.items[1].ref, 900, 'day']]);
  assert.equal(account.owed.total, 2900);
  assert.ok(!account.owed.items.some((i) => i.ref === yesterday.ref), "yesterday's unpaid visit isn't owed: they settle each visit");
  assert.deepEqual(account.comingUp.items.map((i) => [i.ref, i.amount, i.settle]), [[later.ref, 2000, 'day']]);
  assert.equal(account.bill, null);
  // the counter: today's row and today's tab, as before; no account rows, and the scan says they pay each visit
  const code = (await me()).member.code;
  const scan = (await internal('pos/scan', { code })).data;
  assert.deepEqual(scan.rows.map((r) => r.ref), [today.ref]);
  assert.equal(scan.tab.total, 900);
  assert.deepEqual(scan.account, { billing: 'visit' });
  const all = (await internal('pos/checkin-member', { customerId: SAM })).data;
  assert.deepEqual(all.lines.map((l) => [l.properties._booking, l.price]), [[today.ref, '20.00']]);
  // the staff check-in card says they pay each visit
  const card = (await call('POST', 'checkin', { code }, 'staff')).data;
  assert.deepEqual(card.account, { billing: 'visit' });
});

/* ---------------- monthly accounts ---------------- */

test('tab (round 9): staff switch a member to a monthly account with a limit, checked as they go, and the words say what changed', async () => {
  await members();
  assert.equal(said(await call('POST', `members/${SAM}/account`, { billing: 'monthly', creditLimit: 5000 }, SAM)), '403 Staff only. Log in with your staff account.');
  assert.equal(said(await call('POST', 'members/9999/account', { billing: 'monthly', creditLimit: 5000 }, 'staff')), `404 ${TAB_MESSAGES.noMember}`);
  assert.equal(said(await call('POST', `members/${SAM}/account`, { billing: 'weekly' }, 'staff')), `422 ${TAB_MESSAGES.billing}`);
  assert.equal(said(await monthly(0)), `422 ${TAB_MESSAGES.needLimit}`);
  assert.equal(said(await monthly(500001)), `422 ${TAB_MESSAGES.limit}`);
  assert.equal(said(await monthly(12.5)), `422 ${TAB_MESSAGES.limit}`);
  const on = await monthly(10000, SAM, { note: 'Trusted regular' });
  assert.equal(on.status, 200, on.data.error);
  assert.equal(on.data.said, 'Sam is on a monthly account now, with a $100 limit. What they check in for from now goes on their account, and their bill comes on the 1st.');
  assert.deepEqual(on.data.before, { billing: 'visit', creditLimit: 0 });
  assert.equal(on.data.account.billing, 'monthly');
  assert.equal(on.data.account.creditLimit, 10000);
  assert.equal(on.data.account.available, 10000);
  assert.equal(on.data.account.note, 'Trusted regular');
  assert.equal(on.data.account.monthlySince, LIVE);
  const raised = await call('POST', `members/${SAM}/account`, { creditLimit: 15000 }, 'staff');
  assert.equal(raised.data.said, "Sam's credit limit went from $100 to $150.");
  assert.deepEqual(raised.data.before, { billing: 'monthly', creditLimit: 10000 });
  assert.equal(raised.data.account.note, 'Trusted regular', 'the note stays when it is not sent');
  // the member page has it, with the bills (none yet)
  const detail = (await call('GET', `members/${SAM}`, null, 'staff')).data.member.account;
  assert.equal(detail.billing, 'monthly');
  assert.deepEqual(detail.bills, []);
  // GET /me says it to them too (without the staff note)
  const mine = (await me()).account;
  assert.equal(mine.billing, 'monthly');
  assert.equal(mine.note, undefined);
  // the floor tells staff who's on an account
  assert.deepEqual((await call('GET', 'floor', null, 'staff')).data.monthlyAccounts, [SAM]);
  assert.equal((await call('GET', 'floor', null, SAM)).data.monthlyAccounts, undefined);
});

test('tab (round 9): on a monthly account visits and tabs roll over, from tabFrom and the account start only', async () => {
  await members();
  // checked in before the account started: they paid (or not) the old way, so it's never owed later
  const before = await book('2026-09-14', 18, { checkIn: true });
  setNow(at('2026-09-14', 21));
  assert.equal((await monthly(10000)).status, 200);
  const visit = await book('2026-09-15', 18, { over: { tables: ['T6'] }, checkIn: true });
  setNow(at('2026-09-15', 19));
  assert.equal((await call('POST', 'tab', { items: pocky(2) }, SAM)).status, 200);
  const coming = await book('2026-09-25', 18, { over: { tables: ['T7'] } });
  setNow(at('2026-09-16', 12));
  const { account } = await me();
  assert.deepEqual(account.owed.items.map((i) => [i.kind, i.amount, i.settle]), [['table', 2000, 'account'], ['tab', 900, 'account']]);
  assert.equal(account.owed.items[0].ref, visit.ref);
  assert.equal(account.owed.items[1].title, `Your tab, ${lair.shortDay(at('2026-09-15', 19))}`);
  assert.ok(!account.owed.items.some((i) => i.ref === before.ref), 'not what was checked in before the account started');
  assert.equal(account.owed.total, 2900);
  assert.equal(account.available, 10000 - 2900);
  assert.deepEqual(account.comingUp.items.map((i) => [i.ref, i.settle]), [[coming.ref, 'account']]);
  // an item from before round 9 went live is never owed either (tabFrom)
  lair.tabFrom = at('2026-09-15', 20);
  assert.deepEqual((await me()).account.owed.items.map((i) => i.kind), [], 'checked in (and the tab started) before tabFrom: not owed');
  lair.tabFrom = LIVE;
  // the counter lists them as owed rows with their cart lines (the tab tagged _tab), after any weekly seats
  const code = (await me()).member.code;
  const scan = (await internal('pos/scan', { code })).data;
  assert.deepEqual(scan.rows.map((r) => [r.type, r.owed, r.onAccount, r.line.price]), [['booking', true, true, '20.00'], ['tab', true, true, '9.00']]);
  assert.match(scan.rows[0].line.title, /^Owed: Table T6 \(Tue 15 Sep/);
  assert.equal(scan.rows[1].line.properties._tab, scan.rows[1].id);
  assert.deepEqual(scan.account, { billing: 'monthly', creditLimit: 10000, owed: 2900, available: 7100, warning: null });
  const card = (await call('POST', 'checkin', { code }, 'staff')).data;
  assert.equal(card.account.billing, 'monthly');
});

test('tab (round 9): a monthly account at its limit refuses new bookings, sign-ups and tab items; staff can still add them, with a warning', async () => {
  await members();
  assert.equal((await monthly(3000)).status, 200);
  await book('2026-09-15', 18, { checkIn: true });
  setNow(at('2026-09-15', 19));
  // $20 owed of $30: $10 more is fine on the tab, $10.50 isn't
  const over = await call('POST', 'tab', { items: pocky(3) }, SAM);
  assert.equal(said(over), `409 ${limitWords(3000, 2000, 'tab')}`);
  assert.equal(over.data.error, 'That would take your Lair account over its $30 limit ($10 left). Pay your bill online or at the counter, then add to your tab again.');
  assert.equal((await call('POST', 'tab', { items: pocky(2) }, SAM)).status, 200);
  // $29 owed: a $20 table is refused
  const refused = await call('POST', 'bookings', table('2026-09-20', 18, { tables: ['T8'] }), SAM);
  assert.equal(said(refused), '409 That would take your Lair account over its $30 limit ($1 left). Pay your bill online or at the counter, then book again.');
  // an event paid at the counter too
  const quiz = await call('POST', 'events/quiz@2026-09-17/join', { name: 'Sam Jones', email: 'sam@example.com', phone: MOBILE, people: 1 }, SAM);
  assert.equal(said(quiz), '409 That would take your Lair account over its $30 limit ($1 left). Pay your bill online or at the counter, then sign up again.');
  // at the limit exactly: "is at its limit"
  lair.sql.exec("UPDATE tab_accounts SET credit_limit = 2900 WHERE customer_id = ?", SAM);
  assert.equal((await call('POST', 'bookings', table('2026-09-20', 18, { tables: ['T8'] }), SAM)).data.error, 'Your Lair account is at its $29 limit. Pay your bill online or at the counter, then book again.');
  // pay-each-visit members have no limit
  assert.equal((await call('POST', 'bookings', table('2026-09-20', 18, { tables: ['T9'], name: 'Kiri Smith', email: 'kiri@example.com' }), KIRI)).status, 200);
  // staff can still book for them on the floor (the override isn't theirs to refuse) and see the warning on the member
  const staffMade = await call('POST', 'bookings', { ...table('2026-09-20', 18, { tables: ['T10'] }), staffOverride: true }, 'staff');
  assert.equal(staffMade.status, 200, staffMade.data.error);
  const detail = (await call('GET', `members/${SAM}`, null, 'staff')).data.member.account;
  assert.equal(detail.warning, 'At their $29 limit: $29 owed.');
});

/* ---------------- the monthly bill ---------------- */

/** Sam on a monthly account from 14 Sep, with a table (checked in) and a tab on 16 Sep: $29 owed from September */
async function september() {
  await members();
  assert.equal((await monthly(10000)).status, 200);
  const visit = await book('2026-09-16', 18, { checkIn: true });
  setNow(at('2026-09-16', 19));
  assert.equal((await call('POST', 'tab', { items: pocky(2) }, SAM)).status, 200);
  return visit;
}

test('tab (round 9): the bill comes on the first run on or after the 1st in Auckland (NZDT), once, as a draft order for the customer', async () => {
  const visit = await september();
  const mail = captureEmails();
  try {
    // 30 Sep 10:55 UTC is 11:55pm on the 30th in Auckland (NZDT since 27 Sep): no bill yet
    setNow(Date.UTC(2026, 8, 30, 10, 55));
    assert.equal(time.key(clock), '2026-09-30');
    await maintenance();
    assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM tab_bills').one().n, 0);
    // 11:05 UTC is 12:05am on 1 October: September's bill
    setNow(Date.UTC(2026, 8, 30, 11, 5));
    assert.equal(time.key(clock), '2026-10-01');
    await maintenance();
    await settle();
    const bills = lair.sql.exec('SELECT * FROM tab_bills').toArray();
    assert.equal(bills.length, 1);
    assert.equal(bills[0].kind, 'month');
    assert.equal(bills[0].month, '2026-09');
    assert.equal(bills[0].total, 2900);
    assert.equal(bills[0].status, 'open');
    assert.equal(bills[0].invoice_url, 'https://shop.test/invoices/901');
    // the draft order: Sam's, a custom line for the table and the tab's products, each tagged
    const draft = shop.drafts.get(bills[0].draft_order_id);
    assert.equal(draft.customerId, SAM);
    assert.equal(draft.email, 'sam@example.com');
    assert.deepEqual(draft.lines.map((l) => [l.title, l.cents, l.variantId || null, l.qty || null]), [
      [`Table for 2 · ${lair.shortDay(at('2026-09-16', 18))} · ${visit.ref}`, 2000, null, null],
      ['Pocky', 450, '5001', 2],
    ]);
    assert.deepEqual(draft.lines[0].attributes, { _booking: visit.ref, _bill: bills[0].id });
    assert.deepEqual(draft.lines[1].attributes, { _tab: lair.sql.exec('SELECT id FROM tabs').one().id, _bill: bills[0].id });
    // the email: the month's total, the items, Pay online, or the counter
    const email = mail.sent.find((m) => /Your Lair bill/.test(m.subject));
    assert.equal(email.subject, 'Your Lair bill for September: $29.00');
    assert.equal(email.to, 'sam@example.com');
    assert.match(email.html, /Pay online/);
    assert.match(email.html, /https:\/\/shop\.test\/invoices\/901/);
    assert.match(email.text, /Or pay at the counter next time you're in/);
    assert.match(email.text, /\$20\.00/);
    // My Lair shows the open bill, and both items say they're on it
    const { account } = await me();
    assert.equal(account.bill.label, 'September 2026');
    assert.equal(account.bill.total, 2900);
    assert.equal(account.bill.invoiceUrl, 'https://shop.test/invoices/901');
    assert.ok(account.owed.items.every((i) => i.onBill && i.bill === bills[0].id));
    // run again (and later that day): never a second bill
    await maintenance();
    setNow(Date.UTC(2026, 9, 1, 3, 0));
    await maintenance();
    assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM tab_bills').one().n, 1);
    assert.equal(mail.sent.filter((m) => /Your Lair bill/.test(m.subject)).length, 1);
  } finally {
    mail.restore();
  }
});

test('tab (round 9): the bill on the 1st in NZST (UTC+12) too; an account switched on mid-month waits for the next 1st', async () => {
  await members();
  // switched on 15 April 2027 (NZST from 4 April): nothing on 1 May for April? It was monthly before 1 May, so yes
  setNow(at('2027-04-15', 9));
  assert.equal((await monthly(10000)).status, 200);
  await book('2027-04-20', 18, { checkIn: true });
  // 30 Apr 11:55 UTC is 11:55pm on 30 April (NZST): no bill; 12:05 UTC is 1 May
  setNow(Date.UTC(2027, 3, 30, 11, 55));
  assert.equal(time.key(clock), '2027-04-30');
  await maintenance();
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM tab_bills').one().n, 0);
  setNow(Date.UTC(2027, 3, 30, 12, 5));
  assert.equal(time.key(clock), '2027-05-01');
  await maintenance();
  assert.equal(lair.sql.exec("SELECT month FROM tab_bills WHERE kind = 'month'").one().month, '2027-04');
  // Kiri switched on 10 May owes from 12 May: no bill until 1 June
  setNow(at('2027-05-10', 9));
  assert.equal((await monthly(10000, KIRI)).status, 200);
  await book('2027-05-12', 18, { who: KIRI, over: { name: 'Kiri Smith', email: 'kiri@example.com', tables: ['T9'] }, checkIn: true });
  setNow(at('2027-05-20', 9));
  await maintenance();
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM tab_bills WHERE customer_id = ?', KIRI).one().n, 0);
  setNow(at('2027-06-01', 0, 10));
  await maintenance();
  assert.equal(lair.sql.exec('SELECT month FROM tab_bills WHERE customer_id = ?', KIRI).one().month, '2027-05');
});

test('tab (round 9): a bill paid online marks the bill and every item on it paid (payments rows, the tab paid), with no booking emails', async () => {
  const visit = await september();
  setNow(at('2026-10-01', 9));
  await maintenance();
  const bill = lair.sql.exec('SELECT * FROM tab_bills').one();
  const mail = captureEmails();
  try {
    const res = await internal('orders-paid', paidDraft(shop, bill.draft_order_id, 7001));
    assert.equal(res.status, 200, res.data.error);
    assert.deepEqual(res.data.bills, [bill.id]);
    await settle();
    const after = lair.sql.exec('SELECT * FROM tab_bills WHERE id = ?', bill.id).one();
    assert.equal(after.status, 'paid');
    assert.equal(after.paid_how, 'online');
    assert.equal(after.order_id, 'gid://shopify/Order/7001');
    const booking = lair.booking(visit.id);
    assert.equal(booking.paid, true);
    assert.equal(booking.paidAmount, 2000);
    assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM payments WHERE booking_id = ?', visit.id).one().n, 1);
    assert.equal(lair.sql.exec('SELECT status FROM tabs').one().status, 'paid');
    assert.equal(mail.sent.length, 0, 'no booking confirmation goes out for a bill');
    const { account } = await me();
    assert.equal(account.owed.total, 0);
    assert.equal(account.bill, null);
    // Shopify sends the webhook again: nothing is paid twice
    await internal('orders-paid', paidDraft(shop, bill.draft_order_id, 7001));
    assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM payments WHERE booking_id = ?', visit.id).one().n, 1);
    assert.equal(lair.booking(visit.id).paidAmount, 2000);
  } finally {
    mail.restore();
  }
});

test("tab (round 9): an online order that isn't the bill's own draft order pays nothing", async () => {
  const visit = await september();
  setNow(at('2026-10-01', 9));
  await maintenance();
  const bill = lair.sql.exec('SELECT * FROM tab_bills').one();
  const fake = paidDraft(shop, bill.draft_order_id, 7002);
  shop.orders.set(bill.draft_order_id, 'gid://shopify/Order/9999');
  fake.source_name = 'web';
  await internal('orders-paid', fake);
  assert.equal(lair.sql.exec('SELECT status FROM tab_bills').one().status, 'open');
  assert.equal(lair.booking(visit.id).paid, false);
});

test('tab (round 9): paid at the counter, the bill is marked paid and its draft order deleted, so it cannot be paid twice', async () => {
  const visit = await september();
  setNow(at('2026-10-02', 18));
  await maintenance();
  const bill = lair.sql.exec('SELECT * FROM tab_bills').one();
  const code = (await me()).member.code;
  const scan = (await internal('pos/scan', { code })).data;
  assert.deepEqual(scan.rows.map((r) => r.type), ['booking', 'tab']);
  const res = await internal('orders-paid', posOrder(8001, scan.rows));
  assert.equal(res.status, 200, res.data.error);
  await settle();
  const after = lair.sql.exec('SELECT * FROM tab_bills').one();
  assert.equal(after.status, 'paid');
  assert.equal(after.paid_how, 'counter');
  assert.equal(after.order_id, 'gid://shopify/Order/8001');
  assert.deepEqual(shop.deleted, [bill.draft_order_id]);
  assert.equal(lair.booking(visit.id).paid, true);
  assert.equal(lair.sql.exec('SELECT status FROM tabs').one().status, 'paid');
  assert.equal((await me()).account.owed.total, 0);
});

test('tab (round 9): part paid at the counter cancels the bill (its draft order deleted) and the rest stays owed', async () => {
  await september();
  setNow(at('2026-10-02', 18));
  await maintenance();
  const bill = lair.sql.exec('SELECT * FROM tab_bills').one();
  const scan = (await internal('pos/scan', { code: (await me()).member.code })).data;
  await internal('orders-paid', posOrder(8002, scan.rows.filter((r) => r.type === 'tab')));
  await settle();
  const after = lair.sql.exec('SELECT * FROM tab_bills').one();
  assert.equal(after.status, 'void');
  assert.equal(after.void_reason, 'part-paid');
  assert.deepEqual(shop.deleted, [bill.draft_order_id]);
  const { account } = await me();
  assert.deepEqual(account.owed.items.map((i) => [i.kind, i.amount, i.onBill]), [['table', 2000, false]]);
  assert.equal(account.bill, null);
});

test('tab (round 9): staff marking an item paid by hand keeps the bill true; void asks nothing of Shopify but deleting its draft', async () => {
  const visit = await september();
  setNow(at('2026-10-02', 18));
  await maintenance();
  const bill = lair.sql.exec('SELECT * FROM tab_bills').one();
  // the table is marked paid by hand: the bill can't charge for it again, so it's cancelled (the tab stays owed)
  await call('POST', `bookings/${visit.id}/update`, { paid: true }, 'staff');
  assert.equal(lair.sql.exec('SELECT status FROM tab_bills').one().status, 'void');
  // void and resend need staff; a paid bill can't be voided; a void one can't be resent
  assert.equal(said(await call('POST', `bills/${bill.id}/void`, {}, SAM)), '403 Staff only. Log in with your staff account.');
  assert.equal(said(await call('POST', 'bills/bl_nope/void', {}, 'staff')), `404 ${TAB_MESSAGES.noBill}`);
  assert.equal(said(await call('POST', `bills/${bill.id}/resend`, {}, 'staff')), `409 ${TAB_MESSAGES.billVoid}`);
});

test('tab (round 9): void, resend and the friendly reminder after 14 days (once)', async () => {
  await september();
  const mail = captureEmails();
  try {
    setNow(at('2026-10-01', 9));
    await maintenance();
    const bill = lair.sql.exec('SELECT * FROM tab_bills').one();
    const again = await call('POST', `bills/${bill.id}/resend`, {}, 'staff');
    assert.equal(again.status, 200, again.data.error);
    assert.equal(again.data.said, 'Bill for $29.00 emailed to sam@example.com again.');
    // 13 days on: no reminder; 14 days: one; and never a second
    setNow(at('2026-10-14', 8));
    await maintenance();
    assert.equal(mail.sent.filter((m) => /reminder/.test(m.subject)).length, 0);
    setNow(at('2026-10-15', 10));
    await maintenance();
    await settle();
    const reminders = mail.sent.filter((m) => /reminder/.test(m.subject));
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].subject, 'A friendly reminder: your Lair bill for September ($29.00)');
    await maintenance();
    assert.equal(mail.sent.filter((m) => /reminder/.test(m.subject)).length, 1);
    // void: the draft order goes, the items stay owed and say they're not on a bill
    const voided = await call('POST', `bills/${bill.id}/void`, {}, 'staff');
    assert.equal(voided.status, 200, voided.data.error);
    assert.equal(voided.data.bill.status, 'void');
    assert.equal(voided.data.bill.voidReason, 'staff');
    await settle();
    assert.deepEqual(shop.deleted, [bill.draft_order_id]);
    assert.equal(voided.data.account.owed.total, 2900);
    assert.ok(voided.data.account.owed.items.every((i) => !i.onBill));
  } finally {
    mail.restore();
  }
});

test('tab (round 9): staff bill now replaces an open bill; pay online now gives the same link until something changes', async () => {
  await september();
  setNow(at('2026-09-20', 12));
  // only monthly accounts can be billed; Kiri pays each visit
  assert.equal(said(await call('POST', `accounts/${KIRI}/bill`, {}, 'staff')), `409 ${TAB_MESSAGES.notMonthly('Kiri Smith')}`);
  assert.equal(said(await call('POST', 'me/account/pay', {}, KIRI)), `409 ${TAB_MESSAGES.payAtCounter}`);
  const first = await call('POST', `accounts/${SAM}/bill`, {}, 'staff');
  assert.equal(first.status, 200, first.data.error);
  assert.equal(first.data.bill.kind, 'now');
  assert.equal(first.data.bill.total, 2900);
  assert.equal(first.data.bill.label, `To ${lair.shortDay(clock)}`);
  const pay = await call('POST', 'me/account/pay', {}, SAM);
  assert.equal(pay.status, 200, pay.data.error);
  assert.equal(pay.data.bill.id, first.data.bill.id, 'nothing changed: the same bill and link');
  assert.equal(pay.data.invoiceUrl, first.data.bill.invoiceUrl);
  // more on today's tab: the open bill is cancelled (it no longer matches), and paying now makes a fresh one
  setNow(at('2026-09-20', 13));
  assert.equal((await call('POST', 'tab', { items: pocky(1) }, SAM)).status, 200);
  const fresh = await call('POST', 'me/account/pay', {}, SAM);
  assert.equal(fresh.data.bill.total, 2900 + 450);
  assert.notEqual(fresh.data.bill.id, first.data.bill.id);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM tab_bills WHERE status = 'open'").one().n, 1, 'one open bill a member');
  await settle();
  assert.ok(shop.deleted.includes(lair.billRow(first.data.bill.id).draft_order_id));
  // the Accounts tab lists Sam, with the open bill
  const list = (await call('GET', 'accounts', null, 'staff')).data.accounts;
  assert.deepEqual(list.map((a) => [a.customerId, a.owed, a.bill?.id]), [[SAM, 3350, fresh.data.bill.id]]);
  assert.equal((await call('GET', 'accounts', null, SAM)).status, 403);
});

test("tab (round 9): when Shopify can't make the draft order the bill waits, and the next run makes it and sends it", async () => {
  await september();
  const mail = captureEmails();
  try {
    shop.failNext = 2;
    setNow(at('2026-10-01', 0, 5));
    await maintenance();
    let bill = lair.sql.exec('SELECT * FROM tab_bills').one();
    assert.equal(bill.status, 'open');
    assert.equal(bill.invoice_url, null);
    assert.equal(mail.sent.length, 0);
    setNow(at('2026-10-01', 0, 15));
    await maintenance();
    await settle();
    bill = lair.sql.exec('SELECT * FROM tab_bills').one();
    assert.ok(bill.invoice_url);
    assert.equal(mail.sent.filter((m) => /Your Lair bill for September/.test(m.subject)).length, 1);
  } finally {
    mail.restore();
  }
});

test('tab (round 9): back to pay each visit keeps what is owed, says so, and new visits are settled each visit again', async () => {
  await september();
  setNow(at('2026-09-18', 9));
  const back = await call('POST', `members/${SAM}/account`, { billing: 'visit' }, 'staff');
  assert.equal(back.status, 200, back.data.error);
  assert.equal(back.data.said, 'Sam pays each visit now. They still owe $29 from their account. That stays owed until they pay it, online or at the counter.');
  assert.equal(back.data.account.billing, 'visit');
  assert.equal(back.data.account.owed.total, 2900);
  // a visit after: owed on its day only, like anyone paying each visit
  await book('2026-09-19', 18, { over: { tables: ['T6'] }, checkIn: true });
  setNow(at('2026-09-19', 21));
  assert.equal((await me()).account.owed.total, 2900 + 2000);
  setNow(at('2026-09-20', 12));
  assert.equal((await me()).account.owed.total, 2900);
  // the counter still lists what's owed from the account; the Accounts tab too, while it's owed
  const scan = (await internal('pos/scan', { code: (await me()).member.code })).data;
  assert.deepEqual(scan.rows.map((r) => r.type), ['booking', 'tab']);
  assert.deepEqual((await call('GET', 'accounts', null, 'staff')).data.accounts.map((a) => [a.billing, a.owed]), [['visit', 2900]]);
  // and no monthly bill is made for them
  setNow(at('2026-10-01', 9));
  await maintenance();
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM tab_bills').one().n, 0);
});

test('tab (round 9): weekly seats owed are on the running tab for everyone, as round 5 owes them', async () => {
  await members();
  // a weekly seat that ended unpaid (round 5's owed rule): made directly, as maintenance would
  setNow(at('2026-09-15', 12));
  lair.sql.exec(
    `INSERT INTO bookings (id, ref, kind, status, tables, room, starts_at, ends_at, people, name, email, pay, paid, amount, customer_id, series_id, created_at, updated_at)
     VALUES ('bk_weekly', 'SJ-WYVERN-3', 'gm-seat', 'confirmed', '["T4"]', 'common-room', ?, ?, 1, 'Sam Jones', 'sam@example.com', 'day', 0, 1500, ?, 'sr_1', ?, ?)`,
    at('2026-09-14', 18), at('2026-09-14', 21), SAM, LIVE, LIVE,
  );
  const { account } = await me();
  assert.deepEqual(account.owed.items.map((i) => [i.ref, i.amount, i.weekly, i.settle]), [['SJ-WYVERN-3', 1500, true, 'day']]);
});

test('tab (round 9): the counter takes everything on the account at once: /pos/checkin-member lines include earlier days and tabs, tagged', async () => {
  await september();
  setNow(at('2026-09-18', 18));
  const all = (await internal('pos/checkin-member', { customerId: SAM })).data;
  const tabId = lair.sql.exec('SELECT id FROM tabs').one().id;
  assert.deepEqual(all.lines.map((l) => [l.price, l.properties._booking || null, l.properties._tab || null]), [['20.00', all.rows[0].ref, null], ['9.00', null, tabId]]);
  assert.ok(all.rows.every((r) => r.owed && r.onAccount));
});

test('tab (round 9): a bill whose link is paid after it was replaced still records the payment, and the newer bill reconciles as paid', async () => {
  const visit = await september();
  setNow(at('2026-10-01', 9));
  await maintenance();
  const first = lair.sql.exec('SELECT * FROM tab_bills').one();
  // the member asks to pay now after something changed (a new tab item): the September bill is replaced
  setNow(at('2026-10-01', 12));
  assert.equal((await call('POST', 'tab', { items: pocky(1) }, SAM)).status, 200);
  const now = (await call('POST', 'me/account/pay', {}, SAM)).data;
  assert.equal(lair.billRow(first.id).status, 'void');
  // ...but the old link was already open in their browser and gets paid
  await internal('orders-paid', paidDraft(shop, first.draft_order_id, 7101));
  assert.equal(lair.booking(visit.id).paid, true, "the payment counts: it's real money");
  assert.equal(lair.billRow(first.id).order_id, 'gid://shopify/Order/7101');
  // the newer bill had the table and September's tab, plus today's: it's no longer all owed, so it's cancelled, and today's tab stays owed
  const newer = lair.billRow(now.bill.id);
  assert.equal(newer.status, 'void');
  const { account } = await me();
  assert.deepEqual(account.owed.items.map((i) => [i.kind, i.amount]), [['tab', 450]]);
});

test('tab (round 9): a tab a bill pays that another order already paid is flagged for staff, never marked twice', async () => {
  await september();
  setNow(at('2026-10-01', 9));
  await maintenance();
  const bill = lair.sql.exec('SELECT * FROM tab_bills').one();
  const tab = lair.sql.exec('SELECT * FROM tabs').one();
  const mail = captureEmails();
  try {
    // paid at the counter on its own first (the bill is cancelled, its link deleted)...
    await internal('orders-paid', { id: 7201, admin_graphql_api_id: 'gid://shopify/Order/7201', source_name: 'pos', line_items: [{ id: 1, price: '4.50', quantity: 2, properties: [{ name: '_tab', value: tab.id }] }] });
    assert.equal(lair.billRow(bill.id).status, 'void');
    // ...then the bill's link is paid anyway: the tab stays paid by the first order, and staff hear about it
    await internal('orders-paid', paidDraft(shop, bill.draft_order_id, 7202));
    await settle();
    assert.equal(lair.sql.exec('SELECT order_id FROM tabs WHERE id = ?', tab.id).one().order_id, 'gid://shopify/Order/7201');
    assert.ok(mail.sent.some((m) => m.to === 'staff@dicegoblin.test' && /Paid twice: a tab/.test(m.subject)));
  } finally {
    mail.restore();
  }
});

test('tab (round 9): an event paid at the counter checks the limit; one paid online now never does', async () => {
  await members();
  await book('2026-09-15', 18, { checkIn: true });
  setNow(at('2026-09-15', 19));
  assert.equal((await monthly(1000)).status, 200);
  // $20 owed (today's visit) of a $10 limit: an event paid online now isn't on the account, so it isn't refused
  lair.rulesCache = rulesFromSettings({ lair_hours: HOURS, lair_shop_tables: '' }, ROOMS, [...EVENTS, { id: 'champs', title: 'Championship', start: at('2026-09-20', 11), end: at('2026-09-20', 17), tables: '', capacity: 30, entryFee: 2500, payment: 'online' }]);
  lair.shopify.createCheckout = async () => ({ draftOrderId: 'gid://shopify/DraftOrder/1', checkoutUrl: 'https://shop.test/checkout/1' });
  const online = await call('POST', 'events/champs@2026-09-20/join', { name: 'Sam Jones', email: 'sam@example.com', phone: MOBILE, people: 1 }, SAM);
  assert.equal(online.status, 200, online.data.error);
  assert.equal(online.data.checkoutUrl, 'https://shop.test/checkout/1');
  const counter = await call('POST', 'events/quiz@2026-09-17/join', { name: 'Sam Jones', email: 'sam@example.com', phone: MOBILE, people: 1 }, SAM);
  assert.equal(said(counter), '409 Your Lair account is at its $10 limit. Pay your bill online or at the counter, then sign up again.');
});

test('tab (round 9): reminders go only for bills that were emailed; a bill a member made to pay now gets none', async () => {
  await september();
  const mail = captureEmails();
  try {
    setNow(at('2026-09-20', 12));
    const paying = await call('POST', 'me/account/pay', {}, SAM);
    assert.equal(paying.status, 200, paying.data.error);
    setNow(at('2026-09-30', 12));
    await maintenance();
    await settle();
    assert.equal(mail.sent.filter((m) => /Lair bill/.test(m.subject)).length, 0, 'no email for a bill the member made, and no reminder');
  } finally {
    mail.restore();
  }
});

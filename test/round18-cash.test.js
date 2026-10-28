// Cash at the counter (17 Oct 2026, contract v18-cash). Mo: "we should have a button to push a client to paid in cash
// and admin or staff checks the button on their account to clear it", recorded in Shopify as a paid order. A member
// taps Pay with cash (POST /me/cash); staff with Check-in or Money tap Got the cash (POST /cash/:id/paid { expect }), which
// checks them in as the till does and pays everything; its Shopify order (tag lair-cash) is made in the background.
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { CASH_WORDS as W } from '../src/cash.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
// Friday 16 October 2026, 1:00pm in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 9, 16, 0, 0);
const realNow = Date.now;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const NOT_PERMITTED = "That's not one of your staff permissions. Ask the main account to tick it on the Team tab.";

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
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: () => {} };
}

const ROOMS = [
  { id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 },
  { id: 'side-room-2', name: 'Side room 2', code: 'B', tables: 4, seats: 4, order: 3 },
];
// The main account; helpers Hemi (Check-in), Ruia (Money) and Tama (Library only); Mia and Kai, members
const OWNER = '9001';
const HEMI = '9102';
const RUIA = '9104';
const TAMA = '9103';
const MIA = '6001';
const KAI = '6002';

let lair;
async function call(method, path, body, customer = '') {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  }));
  return { status: response.status, data: await response.json() };
}
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const me = async (who) => ok(await call('GET', 'me', null, who));
const board = async (who) => ok(await call('GET', `floor?from=${at('2026-10-16', 0)}&to=${at('2026-10-18', 0)}`, null, who));
const payCash = (who) => call('POST', 'me/cash', {}, who);
const cashPaid = (id, expect, who = HEMI) => call('POST', `cash/${id}/paid`, expect === undefined ? {} : { expect }, who);
/** Mia's table tonight, Friday 16 October 6pm to 8pm, for 2 ($20) unless said */
const book = (over = {}, who = MIA) => call('POST', 'bookings', {
  kind: 'table', tables: ['T3'], start: at('2026-10-16', 18), end: at('2026-10-16', 20), people: 2, name: 'Mia Chen', email: 'mia@example.com', phone: '021 555 0100', ...over,
}, who);
const COKE = { variantId: '4401', title: 'Coke', variantTitle: 'Default Title', price: 350, qty: 2 };
const CHIPS = { variantId: '4402', title: 'Chips', variantTitle: 'Salt and vinegar', price: 300, qty: 1 };

/** A stand-in for Shopify's draft orders: what was asked for, and what it made */
function fakeShopify({ failCreate = 0, loseCreateAnswer = false } = {}) {
  const made = { drafts: [], orders: [], completed: [] };
  let fails = failCreate;
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.createPaidLinesDraft = async (input) => {
    if (fails > 0) {
      fails -= 1;
      throw new Error('Shopify is down');
    }
    const draft = { id: `gid://shopify/DraftOrder/${made.drafts.length + 1}`, input, order: null };
    made.drafts.push(draft);
    if (loseCreateAnswer && made.drafts.length === 1) throw new Error('No answer from Shopify');
    return { id: draft.id, ready: true };
  };
  lair.shopify.completePaidDraft = async (id) => {
    const draft = made.drafts.find((d) => d.id === id);
    if (!draft) return { order: null, status: null, errors: ['Not found'] };
    if (!draft.order) {
      const total = draft.input.lines.reduce((sum, l) => sum + l.cents * (l.variantId ? l.qty : 1), 0);
      draft.order = { id: `gid://shopify/Order/${7000 + made.orders.length}`, name: `#${1500 + made.orders.length}`, total };
      made.orders.push(draft.order);
    }
    made.completed.push(id);
    return { order: draft.order, status: 'COMPLETED', errors: [] };
  };
  lair.shopify.draftOrderState = async (id) => {
    const draft = made.drafts.find((d) => d.id === id);
    return draft ? { id, status: draft.order ? 'COMPLETED' : 'OPEN', ready: true, order: draft.order } : null;
  };
  lair.shopify.findMarkedOrder = async (customerId, tag, key, value) => made.drafts.find((d) => d.order && d.input.marker[key] === value && d.input.tags.includes(tag))?.order || null;
  lair.shopify.findMarkedDraft = async (customerId, tag, key, value) => {
    const d = made.drafts.find((x) => x.input.marker[key] === value && x.input.tags.includes(tag));
    return d ? { id: d.id, status: d.order ? 'COMPLETED' : 'OPEN', ready: true, order: d.order } : null;
  };
  lair.shopify.deleteDraftIfOpen = async () => {};
  // (Shopify's other reads, which these tests don't need: GET /me's account email and gift codes)
  lair.accountEmail = async () => ({ fetched: false, email: '' });
  lair.checkGiftCodes = async () => 0;
  return made;
}

const realFetch = globalThis.fetch;
let reached = [];
let pending = [];

beforeEach(async () => {
  reached = [];
  pending = [];
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  // background work (the Shopify order) is kept, so a test can wait for it
  lair.later = (promise) => {
    const safe = Promise.resolve(promise).catch((error) => console.error('background', error));
    pending.push(safe);
    return safe;
  };
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  Object.defineProperty(lair.shopify, 'configured', { get: () => false, configurable: true });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  for (const [id, name, perms] of [[HEMI, 'Hemi Walker', ['checkin']], [RUIA, 'Ruia Parata', ['money']], [TAMA, 'Tama Rewi', ['library']]]) {
    ok(await call('POST', 'team', { customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, perms }, OWNER));
  }
  for (const [id, name] of [[MIA, 'Mia Chen'], [KAI, 'Kai Tane']]) lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

/* ---------------- the member ---------------- */

test('cash: a member asks to pay with cash for their bill (tonight\'s table and their tab); again brings it up to date; they can take it back', async () => {
  assert.equal(said(await payCash('')), `401 ${W.login}`);
  assert.equal(said(await payCash(MIA)), `409 ${W.nothing}`);
  const table = ok(await book()).booking;
  ok(await call('POST', 'tab', { items: [COKE] }, MIA));
  const asked = ok(await payCash(MIA)).cash;
  assert.equal(asked.status, 'waiting');
  assert.equal(asked.total, 2000 + 700);
  assert.deepEqual(asked.items.map((x) => [x.kind, x.ref || null, x.amount]), [['booking', table.ref, 2000], ['tab', null, 700]]);
  assert.equal(asked.items[1].title, 'Tab: 2 things');
  assert.deepEqual(asked.items[1].things, [{ title: 'Coke', qty: 2 }]);
  assert.ok(!('customerId' in asked) && !('by' in asked), 'members see their own, without staff fields');
  assert.deepEqual((await me(MIA)).cash, asked);
  // more on the tab, and tapped again: the same request, brought up to date
  ok(await call('POST', 'tab', { items: [COKE, CHIPS] }, MIA));
  const again = ok(await payCash(MIA)).cash;
  assert.deepEqual([again.id, again.total], [asked.id, 2000 + 1000]);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM cash_requests WHERE status = 'waiting'").one().n, 1);
  // they'll pay another way
  assert.deepEqual(ok(await call('POST', 'me/cash/cancel', {}, MIA)), { cash: null });
  assert.equal((await me(MIA)).cash, null);
  assert.equal(lair.cashRow(asked.id).status, 'ended');
});

test('cash: a member on a monthly account pays their bill instead', async () => {
  ok(await call('POST', `members/${MIA}/account`, { billing: 'monthly', creditLimit: 10000 }, OWNER));
  ok(await call('POST', 'tab', { items: [COKE] }, MIA));
  assert.equal(said(await payCash(MIA)), `409 ${W.monthly}`);
});

/* ---------------- staff ---------------- */

test('cash: staff who take cash (Check-in or Money) see the requests on the floor; nobody else does or can take one', async () => {
  ok(await book());
  const asked = ok(await payCash(MIA)).cash;
  for (const who of [OWNER, HEMI, RUIA]) {
    const list = (await board(who)).cash;
    assert.deepEqual(list.map((c) => [c.id, c.name, c.total, c.status]), [[asked.id, 'Mia Chen', 2000, 'waiting']], who);
  }
  assert.equal((await board(TAMA)).cash, undefined, 'Library only: no cash list');
  assert.equal((await board(KAI)).cash, undefined, 'a member: no cash list');
  assert.equal(said(await cashPaid(asked.id, 2000, TAMA)), `403 ${NOT_PERMITTED}`);
  assert.equal(said(await cashPaid(asked.id, 2000, KAI)), '403 Staff only. Log in with your staff account.');
  assert.equal(said(await cashPaid('cr_nope', 2000)), `404 ${W.noRequest}`);
  assert.equal(said(await cashPaid(asked.id, 'twenty')), `422 ${W.expect}`);
  assert.equal(lair.cashRow(asked.id).status, 'waiting', 'nothing changed');
});

test('cash: Got the cash checks them in and pays everything (payments from the request, the tab paid), then makes its Shopify order', async () => {
  const made = fakeShopify();
  const table = ok(await book()).booking;
  ok(await call('POST', 'tab', { items: [COKE, CHIPS] }, MIA));
  const asked = ok(await payCash(MIA)).cash;
  const res = ok(await cashPaid(asked.id, 3000, RUIA));
  assert.deepEqual([res.cash.status, res.cash.total, res.cash.by], ['paid', 3000, 'Ruia']);
  // checked in (the loyalty stamp), and paid in full from this request
  const b = lair.booking(table.id);
  assert.deepEqual([b.status, b.paid, b.paidAmount], ['seated', true, 2000]);
  const payments = lair.sql.exec('SELECT order_id, amount FROM payments WHERE booking_id = ?', table.id).toArray().map((r) => ({ ...r }));
  assert.deepEqual(payments, [{ order_id: `cash:${asked.id}`, amount: 2000 }]);
  const tab = { ...lair.sql.exec("SELECT status, order_id FROM tabs WHERE customer_id = ?", MIA).one() };
  assert.deepEqual(tab, { status: 'paid', order_id: `cash:${asked.id}` });
  // nothing left on their bill, and nothing waiting
  const after = await me(MIA);
  assert.deepEqual([after.dueNow.length, after.cash, after.tab.status], [0, null, 'paid']);
  assert.deepEqual((await board(HEMI)).cash, []);
  // the Shopify order: for Mia, a custom line for the table and the tab's things as products at the tab's price, tagged
  // lair-cash, with no booking code anywhere the orders/paid webhook reads
  await Promise.all(pending);
  assert.equal(made.drafts.length, 1);
  const input = made.drafts[0].input;
  assert.equal(input.customerId, MIA);
  assert.deepEqual(input.tags, ['lair-cash', 'cash']);
  assert.deepEqual(input.marker, { _lair_cash: asked.id });
  assert.deepEqual(input.lines.map((l) => [l.variantId || null, l.qty || 1, l.cents]), [[null, 1, 2000], ['4401', 2, 350], ['4402', 1, 300]]);
  assert.match(input.lines[0].title, new RegExp(table.ref));
  assert.ok(!/[A-Z]{2}-[A-Z]{3,9}-\d{1,2}/.test(input.note), input.note);
  assert.equal(input.note, `Paid in cash at the Lair counter, taken by Ruia (${asked.id}).`);
  const row = lair.cashRow(asked.id);
  assert.deepEqual([row.order_status, row.order_id, row.order_name], ['made', 'gid://shopify/Order/7000', '#1500']);
  // done once: asking again changes nothing
  assert.equal(said(await cashPaid(asked.id, 3000)), `409 ${W.done('paid')}`);
  assert.equal(said(await call('POST', `cash/${asked.id}/cancel`, {}, HEMI)), `409 ${W.done('paid')}`);
});

test('cash: when it comes to something else now (the tab changed), nothing is paid: the request shows the new total to take', async () => {
  const table = ok(await book()).booking;
  ok(await call('POST', 'tab', { items: [COKE] }, MIA));
  const asked = ok(await payCash(MIA)).cash;
  // they add chips at the last minute
  ok(await call('POST', 'tab', { items: [COKE, CHIPS] }, MIA));
  assert.equal(said(await cashPaid(asked.id, 2700)), `409 ${W.changed(3000)}`);
  assert.equal(lair.booking(table.id).paid, false);
  assert.equal(lair.sql.exec('SELECT status FROM tabs WHERE customer_id = ?', MIA).one().status, 'open');
  assert.equal((await board(HEMI)).cash[0].total, 3000, 'staff are shown the new total');
  // checked in already (they're here), and paid at the new total
  assert.equal(lair.booking(table.id).status, 'seated');
  assert.equal(ok(await cashPaid(asked.id, 3000)).cash.status, 'paid');
  assert.equal(lair.booking(table.id).paid, true);
});

test('cash: Not paid ends a request without paying anything; one with nothing left to pay ends too', async () => {
  const table = ok(await book()).booking;
  const asked = ok(await payCash(MIA)).cash;
  assert.equal(said(await call('POST', `cash/${asked.id}/cancel`, {}, TAMA)), `403 ${NOT_PERMITTED}`);
  assert.equal(ok(await call('POST', `cash/${asked.id}/cancel`, {}, HEMI)).cash.status, 'ended');
  assert.equal(lair.booking(table.id).paid, false);
  assert.equal(said(await cashPaid(asked.id, 2000)), `409 ${W.done('ended')}`);
  // paid some other way meanwhile (staff marked it paid): nothing left, so no cash to take
  const again = ok(await payCash(MIA)).cash;
  ok(await call('POST', `bookings/${table.id}/update`, { paid: true }, OWNER));
  assert.equal(said(await cashPaid(again.id, 2000)), `409 ${W.nothingNow}`);
  assert.equal(lair.cashRow(again.id).status, 'ended');
});

test('cash: a request from another day is ended, not taken; asking again the next day starts afresh', async () => {
  ok(await call('POST', 'tab', { items: [COKE] }, MIA));
  const asked = ok(await payCash(MIA)).cash;
  Date.now = () => at('2026-10-17', 11);
  assert.equal(said(await cashPaid(asked.id, 700)), `409 ${W.otherDay}`);
  assert.equal(lair.cashRow(asked.id).status, 'ended');
  assert.equal((await me(MIA)).cash, null);
});

test('cash: its Shopify order is tried again when Shopify is down, and never made twice when an answer is lost', async () => {
  // down for the first try: tried again after 10 minutes by the 10-minute run
  let made = fakeShopify({ failCreate: 1 });
  ok(await book());
  let asked = ok(await payCash(MIA)).cash;
  ok(await cashPaid(asked.id, 2000));
  await Promise.all(pending);
  let row = lair.cashRow(asked.id);
  assert.deepEqual([row.order_status, row.order_tries, row.order_next_at], ['failed', 1, NOW + 10 * 60_000]);
  assert.deepEqual(await lair.retryCashOrders(NOW + 5 * 60_000), [], 'not before its wait is up');
  Date.now = () => NOW + 11 * 60_000;
  await lair.retryCashOrders(Date.now());
  row = lair.cashRow(asked.id);
  assert.deepEqual([row.order_status, made.orders.length], ['made', 1]);
  // the draft was made but its answer lost: the next try finds it by its marker and completes that one
  Date.now = () => NOW;
  lair = lair; // (same Lair)
  made = fakeShopify({ loseCreateAnswer: true });
  ok(await book({ tables: ['T5'] }, KAI));
  asked = ok(await payCash(KAI)).cash;
  ok(await cashPaid(asked.id, 2000));
  await Promise.all(pending);
  row = lair.cashRow(asked.id);
  assert.equal(row.order_status, 'failed');
  Date.now = () => NOW + 11 * 60_000;
  await lair.retryCashOrders(Date.now());
  row = lair.cashRow(asked.id);
  assert.deepEqual([row.order_status, made.drafts.length, made.orders.length], ['made', 1, 1], 'one draft, one order');
});

test('cash: after every try and a last look, staff hear it needs making by hand; everything stays paid', async () => {
  fakeShopify({ failCreate: 100 });
  const alerts = [];
  lair.staffAlert = (key, subject) => {
    alerts.push(subject);
    return true;
  };
  const table = ok(await book()).booking;
  const asked = ok(await payCash(MIA)).cash;
  ok(await cashPaid(asked.id, 2000));
  await Promise.all(pending);
  for (let i = 0; i < 12; i += 1) {
    const row = lair.cashRow(asked.id);
    if (row.order_status === 'stopped') break;
    Date.now = () => (row.order_next_at || Date.now()) + 1000;
    await lair.retryCashOrders(Date.now());
  }
  assert.equal(lair.cashRow(asked.id).order_status, 'stopped');
  assert.deepEqual(alerts, ['Cash with no Shopify order: Mia Chen']);
  assert.equal(lair.booking(table.id).paid, true);
});

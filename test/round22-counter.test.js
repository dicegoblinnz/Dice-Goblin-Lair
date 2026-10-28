// Round 22: card payments at the counter reach the Lair again (contract v22-stamps, section 6). Pay on Verifone
// (OrderMate: Reconcile Orders) saves each counter sale as an order of its own, without the line properties the Lair
// tile put on the cart (_booking, _share, _tab). Seen on the live store, 28 Oct 2026: every counter sale since 18
// October came that way, so owed seats paid by card stayed owed (#1996 paid Barons for 18 and 25 Oct, then #1997
// took the same $30 as cash), tabs stayed at the counter, and paying stamped nothing. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { ORDERMATE, counterSale, customSale, orderTags, titleCodes, titleTabRefs } from '../src/counter.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
// Sunday 25 October 2026, 10:00am in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 9, 24, 21, 0);
const realNow = Date.now;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const nowIs = (ms) => {
  Date.now = () => ms;
};

/* ---------------- helpers, as in test/round22-stamps.test.js ---------------- */
function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      if (bindings.length > 100) throw new Error(`too many SQL variables: ${bindings.length}`);
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
const EVENTS = [{ id: 'quiz', title: 'Trivia night', start: at('2026-10-25', 18), end: at('2026-10-25', 20), tables: '', capacity: 20, entryFee: 500 }];
const OWNER = '9001';
const RANGI = '5001';
const MIA = '6001';
const KAI = '6002';
const RIA = '6003';

let lair;
let emails = [];
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
const internal = (path, body) => call('POST', `internal/${path}`, body, '', { 'X-Lair-Internal': '1' });
const pos = (path, body) => internal(`pos/${path}`, body);
const paid = (order) => internal('orders-paid', order);
const stamps = (id) => lair.stampCount(id);
const codeOf = (id) => lair.memberRow(id).code;
const tabRow = (id) => lair.sql.exec('SELECT * FROM tabs WHERE id = ?', id).one();
const paymentsOf = (bookingId) => lair.sql.exec('SELECT order_id, line_id, amount, customer_id FROM payments WHERE booking_id = ? ORDER BY at, rowid', bookingId).toArray().map((r) => ({ ...r }));

/** A card sale on Pay on Verifone, as OrderMate saves it: its own source and tags, and lines without properties */
const verifone = (n, lineItems, extra = {}) => ({
  id: n, admin_graphql_api_id: `gid://shopify/Order/${n}`, name: `#${n}`, source_name: ORDERMATE.app, tags: 'OrderMate, Verifone', line_items: lineItems, ...extra,
});
/** Shopify POS's own order (the tile's properties kept) */
const posOrder = (n, lineItems, extra = {}) => ({ id: n, admin_graphql_api_id: `gid://shopify/Order/${n}`, name: `#${n}`, source_name: 'pos', line_items: lineItems, ...extra });
/** A custom sale as OrderMate keeps it: the title the tile gave it, no product, no properties */
const custom = (id, title, amount, quantity = 1) => ({ id, title, quantity, price: amount.toFixed(2), product_id: null, variant_id: null, sku: null, properties: [] });
/** A shop product on a sale */
const product = (id, title, variantId, quantity, price, properties = []) => ({ id, title, quantity, price, product_id: 7000 + id, variant_id: variantId, sku: null, properties });
/** The Session product rung up by hand, with its SKU */
const sessionProduct = (id, variant, sku, quantity = 1, price = '15.00') => ({ id, title: 'Session', variant_title: variant, sku, quantity, price, product_id: 7666520621159, variant_id: 44114668486759, properties: [] });
/** Whose sale it was, as Shopify answers the Lair's question about the order (null: nobody on it) */
const customerIs = (customerId) => {
  lair.shopify.orderSpend = async (orderId) => (customerId ? { customerId, amount: 1000, name: `#${orderId.split('/').pop()}`, source: ORDERMATE.app } : null);
};

/** A table booked online by a member for today (pay at the Lair) → the booking */
async function table(who, name, { tables = ['T3'], people = 3, start = at('2026-10-25', 14), end = at('2026-10-25', 16) } = {}) {
  return ok(await call('POST', 'bookings', { kind: 'table', tables, start, end, people, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100', pay: 'day' }, who)).booking;
}

/** A tab of Pocky (variant 5001, $4.50) and drinks (variant 5002, $3), saved in My Lair, then put in the cart at the counter → its id */
async function tabAtCounter(who, items = [{ variantId: '5001', title: 'Pocky', variantTitle: 'Strawberry', price: 450, qty: 2 }, { variantId: '5002', title: 'Drinks', variantTitle: '$3 Drink', price: 300, qty: 1 }]) {
  const tab = ok(await call('POST', 'tab', { items }, who)).tab;
  ok(await pos(`tab/${tab.id}/added`, {}));
  assert.equal(tabRow(tab.id).status, 'in-cart');
  return tab.id;
}

const realFetch = globalThis.fetch;
let reached = [];

beforeEach(async () => {
  reached = [];
  emails = [];
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.notifyStaff = (subject) => emails.push(subject);
  lair.confirm = () => emails.push('confirmation');
  lair.confirmJoin = () => emails.push('confirmation');
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  for (const [id, name] of [[RANGI, 'Rangi Hohaia'], [MIA, 'Mia Chen'], [KAI, 'Kai Tane'], [RIA, 'Ria Moana']]) {
    lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
  }
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

/* ---------------- what counts as a counter sale, and what a title names ---------------- */

test('counter sales (round 22): Shopify POS and Pay on Verifone are counter sales; the online store and our checkouts never are', () => {
  assert.equal(ORDERMATE.app, '36219584513', "OrderMate: Reconcile Orders' app ID, as the live store's counter orders give it");
  assert.equal(counterSale({ source_name: 'pos' }), true);
  assert.equal(counterSale({ source_name: '36219584513', tags: 'OrderMate, Verifone' }), true);
  assert.equal(counterSale({ source_name: '36219584513' }), true, 'tags or not');
  // OrderMate under a new app ID: its tag, on an order an app made
  assert.equal(counterSale({ source_name: '99999999999', tags: 'Verifone, OrderMate' }), true);
  assert.equal(counterSale({ source_name: '99999999999', tags: ['OrderMate'] }), true, 'tags as a list (the Admin API)');
  // never one a customer could make, whatever its tags
  for (const source of ['web', 'shopify_draft_order', '', 'iphone', 'android']) {
    assert.equal(counterSale({ source_name: source, tags: 'OrderMate, Verifone' }), false, source);
  }
  // the Lair's own cash orders are an app's, but not the counter's card sales (they're paid when staff take the cash)
  assert.equal(counterSale({ source_name: '430573649921', tags: 'cash, lair-cash' }), false);
  assert.deepEqual(orderTags({ tags: ' OrderMate,Verifone , ' }), ['ordermate', 'verifone']);
  assert.deepEqual(orderTags({}), []);
  // a custom sale has no product behind it
  assert.equal(customSale({ product_id: null, variant_id: null }), true);
  assert.equal(customSale({}), true);
  assert.equal(customSale({ product_id: 1, variant_id: 2 }), false);
  // the codes in a title, as the tile writes them
  assert.deepEqual(titleCodes('Owed: Barons (Sun 18 Oct, MA-HARP-10)'), ['MA-HARP-10']);
  assert.deepEqual(titleCodes('Table fee share: JA-KEY-1 ($10 of $60 left)'), ['JA-KEY-1']);
  assert.deepEqual(titleCodes('Game spot share: Warhammer night (SJ-OWLBEAR-17, Sam)'), ['SJ-OWLBEAR-17']);
  assert.deepEqual(titleCodes('GM seat: mos mo (GOB-Z5NB9E)'), ['GOB-Z5NB9E']);
  assert.deepEqual(titleCodes('Owed: Barons (Sun 18 Oct)'), [], 'before round 22 an owed line had no code');
  assert.deepEqual(titleCodes('Taco Kitten Pizza'), []);
  assert.deepEqual(titleCodes('a-harp-10 (MA-HARP-100)'), [], 'only whole codes, in capitals');
  assert.deepEqual(titleTabRefs('Tab: Tue 15 Sep (2 things, TAB-1A2B3C)'), ['1A2B3C']);
  assert.deepEqual(titleTabRefs('Tab: 2 things'), []);
});

/* ---------------- bookings and sign-ups, by the code in the title ---------------- */

test('Pay on Verifone (round 22): a table paid by card is paid in the Lair by the code in its line, stamps the booker, and sends no confirmation', async () => {
  const booking = await table(MIA, 'Mia');
  assert.equal(stamps(MIA), 0);
  emails = []; // (booking it sent its confirmation)
  customerIs(MIA);
  const answer = ok(await paid(verifone(1996, [custom(19961, `Table fee: ${booking.ref} (T3, 3 people)`, 30), product(19962, 'Drinks', 5002, 1, '3.00')])));
  assert.deepEqual(answer.updated, [booking.ref]);
  const b = lair.booking(booking.id);
  assert.deepEqual([b.paid, b.paidAmount, b.status], [true, 3000, 'confirmed']);
  assert.deepEqual(paymentsOf(booking.id), [{ order_id: 'gid://shopify/Order/1996', line_id: '19961', amount: 3000, customer_id: MIA }]);
  assert.equal(stamps(MIA), 3, 'paid today: the session stamps without a check-in');
  assert.deepEqual(emails, [], 'a counter payment needs no confirmation');
  // Shopify sends the webhook again: nothing more
  ok(await paid(verifone(1996, [custom(19961, `Table fee: ${booking.ref} (T3, 3 people)`, 30), product(19962, 'Drinks', 5002, 1, '3.00')])));
  assert.equal(paymentsOf(booking.id).length, 1);
  assert.equal(lair.booking(booking.id).paidAmount, 3000);
  assert.equal(stamps(MIA), 3);
});

test('Pay on Verifone (round 22): an owed seat paid by card is paid by the code in its "Owed:" line; a line from before round 22 (no code) pays nothing', async () => {
  const booking = await table(RIA, 'Ria', { tables: ['T5'], people: 1, start: at('2026-10-25', 11), end: at('2026-10-25', 12) });
  nowIs(at('2026-10-25', 13));
  const scan = ok(await pos('scan', { code: codeOf(RIA) }));
  const owed = scan.rows.find((r) => r.owed);
  assert.equal(owed.line.title, `Owed: Table T5 (Sun 25 Oct, ${booking.ref})`, 'round 22: the code is in the title');
  // a line as it was before round 22: OrderMate drops _booking, and its title names nothing
  ok(await paid(verifone(1995, [custom(19951, 'Owed: Table T5 (Sun 25 Oct)', 10)])));
  assert.equal(lair.booking(booking.id).paid, false);
  assert.equal(lair.isOwed(lair.booking(booking.id)), true);
  // today's line, paid by card
  ok(await paid(verifone(1997, [custom(19971, owed.line.title, Number(owed.line.price))])));
  assert.deepEqual([lair.booking(booking.id).paid, lair.isOwed(lair.booking(booking.id))], [true, false]);
  assert.equal(stamps(RIA), 1);
  assert.deepEqual(ok(await pos('scan', { code: codeOf(RIA) })).rows.filter((r) => r.owed), [], 'nothing owed at the counter now');
});

test('Pay on Verifone (round 22): a share of a bill and a sign-up count what their lines paid; two shares at once count twice', async () => {
  const booking = await table(KAI, 'Kai', { people: 4, tables: ['T6'] });
  const share = ok(await pos('share', { id: booking.id, type: 'booking' })).line;
  assert.equal(share.title, `Table fee share: ${booking.ref} ($10 of $40 left)`);
  // staff made it two shares (quantity 2) before paying
  ok(await paid(verifone(1955, [custom(19551, share.title, 10, 2)])));
  assert.deepEqual([lair.booking(booking.id).paid, lair.booking(booking.id).paidAmount], [false, 2000]);
  assert.equal(stamps(KAI), 0, 'half paid: no stamps until it is all paid or they are checked in');
  ok(await paid(verifone(1956, [custom(19561, share.title, 20)])));
  assert.deepEqual([lair.booking(booking.id).paid, lair.booking(booking.id).paidAmount], [true, 4000]);
  assert.equal(stamps(KAI), 4);
  // an event sign-up's line
  const join = ok(await call('POST', 'events/quiz@2026-10-25/join', { name: 'Mia', email: 'mia@example.com', phone: '021 555 0100', people: 2 }, MIA)).join;
  const checked = ok(await pos('checkin', { id: join.id, type: 'join' }));
  assert.match(checked.lines[0].title, new RegExp(`\\(${join.ref}\\)$`));
  ok(await paid(verifone(1957, [custom(19571, checked.lines[0].title, 10)])));
  assert.equal(lair.joinById(join.id).paid, true);
});

test('Pay on Verifone (round 22): only a custom sale on a counter sale is read, and only when its title names exactly one booking or sign-up', async () => {
  const mias = await table(MIA, 'Mia', { tables: ['T7'], people: 1 });
  const kais = await table(KAI, 'Kai', { tables: ['T8'], people: 1 });
  const title = `Table fee: ${mias.ref} (T7, 1 person)`;
  // the online store: a customer could type any title into an order, so it pays nothing
  ok(await paid({ ...verifone(2001, [custom(20011, title, 10)]), source_name: 'web' }));
  // a draft order (our checkouts) without the booking's own draft: nothing
  ok(await paid({ ...verifone(2002, [custom(20021, title, 10)]), source_name: 'shopify_draft_order' }));
  // a shop product whose title happens to hold a code
  ok(await paid(verifone(2003, [product(20031, title, 5003, 1, '10.00')])));
  // two different bookings' codes in one title: which one? Neither.
  ok(await paid(verifone(2004, [custom(20041, `Table fee: ${mias.ref} and ${kais.ref}`, 20)])));
  // a code that's no booking (Mia's member code) beside one that is: the booking
  assert.equal(lair.booking(mias.id).paid, false);
  assert.equal(lair.booking(kais.id).paid, false);
  ok(await paid(verifone(2005, [custom(20051, `Table fee: ${kais.ref} for ${codeOf(MIA)}`, 10)])));
  assert.deepEqual([lair.booking(mias.id).paid, lair.booking(kais.id).paid], [false, true]);
  // Shopify POS's own order keeps working the old way: its _booking says which, whatever the title
  ok(await paid(posOrder(2006, [{ id: 20061, title: 'Lair fee', quantity: 1, price: '10.00', properties: [{ name: '_booking', value: mias.ref }] }])));
  assert.equal(lair.booking(mias.id).paid, true);
});

test('Pay on Verifone (round 22): the tile\'s titles keep the code in their first 120 characters, however long the session\'s name', async () => {
  const row = (extra) => ({ ref: 'SJ-OWLBEAR-17', title: `The ${'Very '.repeat(40)}Long Campaign`, start: at('2026-10-25', 18), tables: ['T3'], people: 2, due: 1500, covered: 0, ...extra });
  for (const extra of [{ owed: true }, { type: 'join' }, { kind: 'gm-seat' }, { kind: 'gm-cover' }, { playerOf: { name: 'Sam' }, name: `Sam ${'Longname'.repeat(10)}` }, { occurrenceId: 'oc_1' }, { covered: 1000, kind: 'gm-seat' }]) {
    const { title } = lair.posLine(row(extra));
    assert.ok(title.length <= 120, `${title.length}: ${title}`);
    assert.deepEqual(titleCodes(title), ['SJ-OWLBEAR-17'], title);
  }
  assert.equal(lair.posLine(row({ owed: true, title: 'Barons' })).title, 'Owed: Barons (Sun 25 Oct, SJ-OWLBEAR-17)');
  assert.equal(lair.posLine(row({ kind: 'gm-seat', title: 'Barons' })).title, 'GM seat: Barons (SJ-OWLBEAR-17)');
});

/* ---------------- sessions rung up by hand ---------------- */

test('Pay on Verifone (round 22): the Session product rung up by card stamps the member on the sale; with nobody on it, nobody', async () => {
  customerIs(MIA);
  const answer = ok(await paid(verifone(1992, [sessionProduct(19921, 'Dice Goblin Day Pass', 'LAIR-SESSION-DAY', 3, '10.00'), product(19922, 'Snacks', 5004, 6, '3.00')])));
  assert.equal(answer.stamps, 3);
  assert.equal(stamps(MIA), 3);
  customerIs(null);
  const nobody = ok(await paid(verifone(1984, [sessionProduct(19841, 'RPG Kids Session', 'LAIR-SESSION-RPG-KIDS', 1, '10.00')])));
  assert.equal(nobody.stamps, undefined);
  // a pass sold at the counter by card says so
  customerIs(KAI);
  ok(await paid(verifone(1985, [{ id: 19851, title: 'Session pass', variant_title: '5 sessions', sku: 'LAIR-PASS-5', quantity: 1, price: '50.00', product_id: 10237298278503, variant_id: 50371432972391, properties: [] }])));
  assert.equal(lair.sql.exec("SELECT note FROM passes WHERE order_id = 'gid://shopify/Order/1985'").one().note, 'Bought at the counter');
});

/* ---------------- tabs ---------------- */

test('Pay on Verifone (round 22): a tab at the counter is paid when the sale has all its items and its member; then a new tab can start', async () => {
  const tabId = await tabAtCounter(MIA);
  // someone else's sale with the same things: not Mia's tab
  customerIs(KAI);
  ok(await paid(verifone(3001, [product(30011, 'Pocky', 5001, 2, '4.50'), product(30012, 'Drinks', 5002, 1, '3.00')])));
  assert.equal(tabRow(tabId).status, 'in-cart');
  // Mia's sale without the drink (taken off at the till): not paid by it
  customerIs(MIA);
  ok(await paid(verifone(3002, [product(30021, 'Pocky', 5001, 2, '4.50')])));
  assert.equal(tabRow(tabId).status, 'in-cart');
  // Mia's sale with all of it (and a pizza on top): paid
  const answer = ok(await paid(verifone(3003, [product(30031, 'Pocky', 5001, 3, '4.50'), product(30032, 'Drinks', 5002, 1, '3.00'), product(30033, 'Taco Kitten Pizza', 5005, 1, '23.00')])));
  assert.deepEqual(answer.tabs, [tabId]);
  assert.deepEqual([tabRow(tabId).status, tabRow(tabId).order_id], ['paid', 'gid://shopify/Order/3003']);
  // the webhook again: nothing changes
  assert.deepEqual(ok(await paid(verifone(3003, [product(30031, 'Pocky', 5001, 3, '4.50'), product(30032, 'Drinks', 5002, 1, '3.00')]))).tabs, []);
  // she can start a fresh tab today
  assert.equal((await call('POST', 'tab', { items: [{ variantId: '5001', title: 'Pocky', variantTitle: 'Strawberry', price: 450, qty: 1 }] }, MIA)).status, 200);
});

test('Pay on Verifone (round 22): two tabs at the counter share one sale only when it has enough for both; a POS sale still goes by _tab', async () => {
  const older = await tabAtCounter(RIA, [{ variantId: '5001', title: 'Pocky', variantTitle: 'Strawberry', price: 450, qty: 1 }]);
  // (yesterday's tab still at the counter, and today's)
  lair.sql.exec("UPDATE tabs SET day = '2026-10-24', created_at = ?, updated_at = ? WHERE id = ?", at('2026-10-24', 19), at('2026-10-24', 19), older);
  const newer = await tabAtCounter(RIA, [{ variantId: '5001', title: 'Pocky', variantTitle: 'Strawberry', price: 450, qty: 2 }]);
  customerIs(RIA);
  // two Pocky: enough for today's (the newest) only
  ok(await paid(verifone(3101, [product(31011, 'Pocky', 5001, 2, '4.50')])));
  assert.deepEqual([tabRow(newer).status, tabRow(older).status], ['paid', 'in-cart']);
  ok(await paid(verifone(3102, [product(31021, 'Pocky', 5001, 1, '4.50')])));
  assert.equal(tabRow(older).status, 'paid');
  // Shopify POS's own sale: the _tab on its lines says which, as before
  const kais = await tabAtCounter(KAI, [{ variantId: '5002', title: 'Drinks', variantTitle: '$3 Drink', price: 300, qty: 1 }]);
  customerIs(null);
  ok(await paid(posOrder(3103, [product(31031, 'Drinks', 5002, 1, '3.00', [{ name: '_tab', value: kais }])])));
  assert.equal(tabRow(kais).status, 'paid');
});

test("Pay on Verifone (round 22): a monthly account's tab from an earlier day is paid by the TAB code in its line", async () => {
  const tabId = await tabAtCounter(KAI, [{ variantId: '5001', title: 'Pocky', variantTitle: 'Strawberry', price: 450, qty: 2 }]);
  const ref = lair.tabRef(tabId);
  assert.match(ref, /^TAB-[0-9A-F]{6}$/);
  ok(await paid(verifone(3201, [custom(32011, `Tab: Sun 25 Oct (2 things, ${ref})`, 9)])));
  assert.deepEqual([tabRow(tabId).status, tabRow(tabId).order_id], ['paid', 'gid://shopify/Order/3201']);
  // a TAB code on the online store pays nothing
  const other = await tabAtCounter(RIA, [{ variantId: '5001', title: 'Pocky', variantTitle: 'Strawberry', price: 450, qty: 1 }]);
  ok(await paid({ ...verifone(3202, [custom(32021, `Tab: Sun 25 Oct (1 thing, ${lair.tabRef(other)})`, 4.5)]), source_name: 'web' }));
  assert.equal(tabRow(other).status, 'in-cart');
});

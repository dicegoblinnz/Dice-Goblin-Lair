// Round 22: stamps that follow payment, sessions rung up at the counter, and stamps staff add (contract v22-stamps).
// Mo (28 Oct 2026): "When someone pays for his sessions it doesn't add a new stamp", "each session for DND sessions or
// table session added manually should be added as well" and "give the staff [a way] to add a stamp on the area for the
// stamps". Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { STAMPS, STAMP_WORDS as W, bookingStamps, joinStamps, sessionLines } from '../src/stamps.js';

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

/* ---------------- helpers, as in test/round21-gm-cover.test.js ---------------- */
function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      // as SQLite in a Durable Object: at most 100 bound values a query (Cloudflare's limit; 27 Oct 2026)
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
// Tonight's trivia night, $5 a person, paid at the counter
const EVENTS = [{ id: 'quiz', title: 'Trivia night', start: at('2026-10-25', 18), end: at('2026-10-25', 20), tables: '', capacity: 20, entryFee: 500 }];
// People by their Shopify customer IDs (made up): the main account; helpers Hemi (Check-in) and Tama (Library only);
// Rangi, a GM who isn't staff; and players
const OWNER = '9001';
const HEMI = '9102';
const TAMA = '9103';
const RANGI = '5001';
const MIA = '6001';
const KAI = '6002';
const RIA = '6003';

let lair;
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
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const internal = (path, body) => call('POST', `internal/${path}`, body, '', { 'X-Lair-Internal': '1' });
const pos = (path, body) => internal(`pos/${path}`, body);
const update = (id, patch, who = OWNER) => call('POST', `bookings/${id}/update`, patch, who);
const stamps = (id) => lair.stampCount(id);
const card = async (who) => ok(await call('GET', 'me', null, who)).loyalty;
const ledger = (id) => lair.sql.exec('SELECT kind, count, title, order_name, line_id, unit, created_by, undone_at FROM loyalty_stamps WHERE customer_id = ? ORDER BY at, rowid', id).toArray().map((r) => ({ ...r }));
const codeOf = (id) => lair.memberRow(id).code;
const NOT_YOURS = "403 That's not one of your staff permissions. Ask the main account to tick it on the Team tab.";

/** A paid POS order (the orders/paid webhook's shape): its line items as given, its customer when there is one */
const posOrder = (n, lineItems, extra = {}) => ({ id: n, admin_graphql_api_id: `gid://shopify/Order/${n}`, name: `#${n}`, source_name: 'pos', line_items: lineItems, ...extra });
/** An order line paying a booking at the counter (a custom sale with its code in _booking), $amount */
const bookingLine = (id, ref, amount, more = {}) => ({ id, quantity: 1, price: amount.toFixed(2), properties: [{ name: '_booking', value: ref }, ...Object.entries(more).map(([name, value]) => ({ name, value }))] });
/** An order line for the Session product: `variant` is its variant's name, `sku` its SKU */
const sessionLine = (id, variant, sku, quantity = 1, price = '15.00') => ({ id, title: 'Session', variant_title: variant, sku, quantity, price, properties: [] });

/** A table booked online by a member for today (pay at the Lair) → the booking */
async function table(who, name, { tables = ['T3'], people = 3, start = at('2026-10-25', 14), end = at('2026-10-25', 16) } = {}) {
  return ok(await call('POST', 'bookings', { kind: 'table', tables, start, end, people, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100', pay: 'day' }, who)).booking;
}

/** A session listed by the main account for Rangi, Tuesday 27 October 6pm to 10pm unless said → its id */
async function list({ start = at('2026-10-27', 18), end = at('2026-10-27', 22), tables = ['B1'], title = "Rangi's one-shot" } = {}) {
  return ok(await call('POST', 'games', {
    title, system: 'D&D 5e', gm: 'Rangi', blurb: 'A test session.', seats: 4, tables, start, end, gmCustomerId: RANGI, gmCustomerName: 'Rangi', gmEmail: 'rangi@example.com',
  }, OWNER)).game.id;
}

/** A seat booked online by a member (pay at the Lair) → the booking */
async function seat(gameId, who, name, { people = 1 } = {}) {
  return ok(await call('POST', 'bookings', { kind: 'gm-seat', gameId, people, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100', pay: 'day' }, who)).booking;
}

// No network in these tests: no Shopify and no emails. Anything that reaches for it is noted, and the test fails.
const realFetch = globalThis.fetch;
let reached = [];
let shopifyOn = true;

beforeEach(async () => {
  reached = [];
  shopifyOn = true;
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
  lair.shopify.searchCustomers = async () => [{ customerId: OWNER, name: 'Mo', email: 'owner@example.com' }];
  Object.defineProperty(lair.shopify, 'configured', { get: () => shopifyOn, configurable: true });
  lair.notifyStaff = () => {};
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  for (const [id, name, perms] of [[HEMI, 'Hemi Walker', ['checkin']], [TAMA, 'Tama Rewi', ['library']]]) {
    ok(await call('POST', 'team', { customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, perms }, OWNER));
  }
  for (const [id, name] of [[RANGI, 'Rangi Hohaia'], [MIA, 'Mia Chen'], [KAI, 'Kai Tane'], [RIA, 'Ria Moana']]) {
    lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
  }
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

/* ---------------- the words and the rules ---------------- */

test('round 22: the words, word for word, and the rules', () => {
  assert.deepEqual(W, {
    count: 'Add between 1 and 10 stamps.',
    noMember: "There's no loyalty card for them yet: they need a Dice Goblin account. Scan the member code in their My Lair.",
    badKey: "That tap didn't come through properly. Try again.",
    notFound: "That stamp isn't on their card any more. Scan their code again.",
    notTheirs: "That stamp is on someone else's card. Scan their code again.",
    notHere: "That stamp didn't come from the counter, so take it back on the staff page, under Members.",
    ownCard: "You can't add stamps to your own card. Ask the main account.",
    oneAtATime: 'More than one stamp at a time needs the Members permission. Ask the main account to tick it on the Team tab.',
    daily: "That's 2 stamps added at the counter or check-in for them today. Any more go on the staff page, under Members.",
    staffTitle: 'A stamp from Gobgob',
    saleTitle: 'A session at the counter',
  });
  assert.deepEqual([STAMPS.perLine, STAMPS.staffMax, STAMPS.listed, STAMPS.byHandDaily], [10, 10, 20, 2]);
  for (const sku of ['LAIR-SESSION', 'LAIR-SESSION-RPG', 'lair-session-rpg-kids', 'LAIR-SESSION-DAY', ' LAIR-SESSION-TCG ']) assert.ok(STAMPS.sessionSku.test(sku.trim()), sku);
  for (const sku of ['LAIR-PASS-5', 'LAIR-GIFT-10', 'LAIR-SESSIONS', 'DGL34-M011', 'SESSION', '']) assert.ok(!STAMPS.sessionSku.test(sku), sku);
  // the one place that says which sessions stamp: checked in, or paid in full once its day has come
  assert.equal(bookingStamps('b'), "(b.status IN ('seated', 'done') OR (b.status = 'confirmed' AND b.paid = 1 AND b.starts_at < ?))");
  assert.equal(joinStamps('j'), "(j.status = 'attended' OR (j.status = 'confirmed' AND j.paid = 1 AND j.starts_at < ?))");
  // a session product's name: the variant's when it has one, else the product's; one stamp a unit, up to 10 a line
  assert.deepEqual(sessionLines({
    line_items: [
      sessionLine(1, 'RPG Session', 'LAIR-SESSION-RPG'), sessionLine(2, 'Dice Goblin Day Pass', 'LAIR-SESSION-DAY', 25), sessionLine(3, 'TCG League', 'LAIR-SESSION-TCG', 0),
      { id: 4, title: 'Curse of Strahd - D&D Roleplaying Session', variant_title: '240', sku: 'LAIR-SESSION-STRAHD', quantity: 1 },
      { id: 5, title: 'Drinks', variant_title: '$6 Drink', sku: null, quantity: 2 }, { id: 6, title: 'Session pass', variant_title: '5 sessions', sku: 'LAIR-PASS-5', quantity: 1 },
    ],
  }), [
    { lineId: '1', title: 'RPG Session', quantity: 1 }, { lineId: '2', title: 'Dice Goblin Day Pass', quantity: 10 },
    { lineId: '4', title: 'Curse of Strahd - D&D Roleplaying Session', quantity: 1 },
  ]);
  assert.deepEqual(sessionLines({}), []);
});

/* ---------------- paid sessions stamp ---------------- */

test('paid sessions (round 22): a table paid at the counter stamps everyone on it without a check-in; checking in after stamps nothing more; a no-show or cancelling takes them back', async () => {
  const booking = await table(MIA, 'Mia');
  assert.equal(stamps(MIA), 0, 'booked, not paid or here');
  // paid at the counter (the POS sale carries its code), never scanned in: 3 stamps, Mia's friends on her card
  const paid = ok(await internal('orders-paid', posOrder(7001, [bookingLine(70011, booking.ref, 30)])));
  assert.deepEqual(paid.updated, [booking.ref]);
  assert.equal(lair.booking(booking.id).status, 'confirmed', 'not checked in');
  assert.equal(stamps(MIA), 3);
  const c = await card(MIA);
  assert.deepEqual([c.stamps, c.recent], [3, [{ at: booking.start, title: 'Table T3', people: 3 }]], 'My Lair lists it like a checked-in one');
  // checked in afterwards: the same session, so still 3
  ok(await pos('checkin', { id: booking.id, type: 'booking' }));
  assert.equal(stamps(MIA), 3);
  // undoing the check-in leaves it paid, so it keeps its stamps; a no-show takes them back, and putting it back returns them
  ok(await update(booking.id, { status: 'confirmed' }));
  assert.equal(stamps(MIA), 3);
  ok(await update(booking.id, { status: 'noshow' }));
  assert.equal(stamps(MIA), 0);
  ok(await update(booking.id, { status: 'confirmed' }));
  assert.equal(stamps(MIA), 3);
  ok(await update(booking.id, { status: 'cancelled' }));
  assert.equal(stamps(MIA), 0);
  // marked paid by hand on the staff page counts the same as paid at the till
  const kais = await table(KAI, 'Kai', { tables: ['T4'], people: 2 });
  ok(await update(kais.id, { paid: true }));
  assert.equal(stamps(KAI), 2);
});

test('paid sessions (round 22): paid ahead for a later date, its stamps land on its day (Lair time)', async () => {
  const id = await list();
  const kais = await seat(id, KAI, 'Kai');
  ok(await update(kais.id, { paid: true }));
  assert.equal(stamps(KAI), 0, 'Sunday: the seat is on Tuesday');
  nowIs(at('2026-10-26', 23, 59));
  assert.equal(stamps(KAI), 0, 'not on Monday night either');
  nowIs(at('2026-10-27', 0));
  assert.equal(stamps(KAI), 1, 'from midnight on its day');
  assert.deepEqual((await card(KAI)).recent, [{ at: at('2026-10-27', 18), title: "Rangi's one-shot", people: 1 }]);
  // a weekday seat paid but partly: no stamp until it's paid in full (or they're checked in)
  const mias = await seat(id, MIA, 'Mia', { people: 2 });
  ok(await internal('orders-paid', posOrder(7101, [bookingLine(71011, mias.ref, 15, { _share: '1' })])));
  assert.equal(lair.booking(mias.id).paid, false);
  assert.equal(stamps(MIA), 0, 'half paid');
  ok(await internal('orders-paid', posOrder(7102, [bookingLine(71021, mias.ref, 15, { _share: '1' })])));
  assert.equal(stamps(MIA), 2, 'paid in full');
});

test('paid sessions (round 22): an owed session paid at a later visit stamps it, though it was never checked in', async () => {
  const booking = await table(RIA, 'Ria', { tables: ['T5'], people: 1, start: at('2026-10-25', 11), end: at('2026-10-25', 12) });
  // the afternoon: it ended unpaid, so it's owed, and owed sessions are never checked in, only paid
  nowIs(at('2026-10-25', 13));
  const scan = ok(await pos('scan', { code: codeOf(RIA) }));
  const owed = scan.rows.find((r) => r.owed);
  assert.equal(owed?.ref, booking.ref);
  assert.equal(stamps(RIA), 0);
  ok(await internal('orders-paid', posOrder(7201, [bookingLine(72011, owed.line.properties._booking, Number(owed.line.price))])));
  assert.deepEqual([lair.booking(booking.id).status, lair.booking(booking.id).paid], ['confirmed', true]);
  assert.equal(stamps(RIA), 1, 'paid: stamped');
  assert.deepEqual(ok(await pos('scan', { code: codeOf(RIA) })).loyalty, { stamps: 1, cardSize: 10, rollsAvailable: 0, card: 1 }, 'the counter sees it');
});

test('paid sessions (round 22): an event sign-up paid at the counter stamps everyone on it from its day; part paid, it waits', async () => {
  const join = ok(await call('POST', 'events/quiz@2026-10-25/join', { name: 'Mia', email: 'mia@example.com', phone: '021 555 0100', people: 2 }, MIA)).join;
  assert.equal(stamps(MIA), 0);
  ok(await internal('orders-paid', posOrder(7301, [bookingLine(73011, join.ref, 5)])));
  assert.equal(stamps(MIA), 0, '$5 of $10');
  ok(await internal('orders-paid', posOrder(7302, [bookingLine(73021, join.ref, 5)])));
  assert.equal(lair.joinById(join.id).status, 'confirmed');
  assert.equal(stamps(MIA), 2);
  assert.deepEqual((await card(MIA)).recent.map((r) => [r.title, r.people]), [['Trivia night', 2]]);
  // checking in as well doesn't stamp it twice
  ok(await pos('checkin', { id: join.id, type: 'join' }));
  assert.equal(stamps(MIA), 2);
});

test('paid sessions (round 22): a GM with a paid seat of their own session has that seat\'s stamp, not a second one', async () => {
  const id = await list();
  const own = await seat(id, RANGI, 'Rangi');
  await seat(id, MIA, 'Mia');
  ok(await update(own.id, { paid: true }));
  nowIs(at('2026-10-27', 18, 30));
  await lair.gmRunUpkeep(Date.now());
  assert.equal(stamps(RANGI), 1, "the seat's");
  // the seat unpaid again: the session's stamp instead
  ok(await update(own.id, { paid: false }));
  assert.equal(stamps(RANGI), 1, "the session's");
});

test('paid sessions (round 22): a session with no account on it (a walk-in, a guest\'s) stamps whoever paid for it, until it joins an account', async () => {
  /** The next paid order's customer, as Shopify says (orderSpend) */
  const payer = (customerId) => {
    lair.shopify.orderSpend = async (orderId) => ({ customerId, amount: 1000, name: `#${orderId.split('/').pop()}`, source: 'pos' });
  };
  // a walk-in staff made on the staff page: no account on it, seated straight away, so nobody's card has it
  const walkin = ok(await call('POST', 'bookings', { kind: 'walkin', tables: ['T9'], start: at('2026-10-25', 11), end: at('2026-10-25', 13), people: 2, name: 'Mia and a friend' }, OWNER)).booking;
  assert.deepEqual([walkin.status, walkin.customerId ?? null], ['seated', null]);
  assert.equal(stamps(MIA), 0);
  // paid at the counter with Mia on the sale: both stamps are hers, as if she'd booked it
  payer(MIA);
  ok(await internal('orders-paid', posOrder(7401, [bookingLine(74011, walkin.ref, 20)])));
  assert.equal(stamps(MIA), 2);
  assert.deepEqual((await card(MIA)).recent, [{ at: walkin.start, title: 'Table T9', people: 2 }]);
  // a guest's TTRPG seat (booked without logging in), paid by Kai: his, until it joins the guest's own account
  const id = await list();
  const pats = ok(await call('POST', 'bookings', { kind: 'gm-seat', gameId: id, people: 1, name: 'Pat', email: 'pat@example.com', phone: '021 555 0101', pay: 'day' }, '')).booking;
  payer(KAI);
  ok(await internal('orders-paid', posOrder(7402, [bookingLine(74021, pats.ref, 15)])));
  nowIs(at('2026-10-27', 9));
  assert.equal(stamps(KAI), 1, 'paid, on its day');
  lair.sql.exec('UPDATE bookings SET customer_id = ? WHERE id = ?', RIA, pats.id);
  assert.deepEqual([stamps(KAI), stamps(RIA)], [0, 1], 'Pat turned out to be Ria: her account, her stamp');
  // split between two payers: the first payer's, like the booker's, and never anyone else's too
  nowIs(NOW);
  const guestTable = ok(await call('POST', 'bookings', { kind: 'table', tables: ['T10'], start: at('2026-10-25', 14), end: at('2026-10-25', 16), people: 3, name: 'Sam', email: 'sam@example.com', phone: '021 555 0102', pay: 'day' }, '')).booking;
  payer(RIA);
  ok(await internal('orders-paid', posOrder(7403, [bookingLine(74031, guestTable.ref, 10, { _share: '1' })])));
  payer(KAI);
  ok(await internal('orders-paid', posOrder(7404, [bookingLine(74041, guestTable.ref, 20, { _share: '1' })])));
  assert.equal(lair.booking(guestTable.id).paid, true);
  assert.deepEqual([stamps(RIA), stamps(KAI)], [3, 0]);
  // a guest's sign-up paid by Mia: hers too
  const join = ok(await call('POST', 'events/quiz@2026-10-25/join', { name: 'Pat', email: 'pat@example.com', phone: '021 555 0101', people: 1 }, '')).join;
  payer(MIA);
  ok(await internal('orders-paid', posOrder(7405, [bookingLine(74051, join.ref, 5)])));
  assert.equal(stamps(MIA), 3);
  // nobody on the sale: nobody's
  payer(null);
  const other = ok(await call('POST', 'bookings', { kind: 'walkin', tables: ['T11'], start: at('2026-10-25', 11), end: at('2026-10-25', 13), people: 1, name: 'Jo' }, OWNER)).booking;
  ok(await internal('orders-paid', posOrder(7406, [bookingLine(74061, other.ref, 10)])));
  assert.deepEqual([stamps(MIA), stamps(KAI), stamps(RIA)], [3, 0, 3]);
});

/* ---------------- sessions rung up at the counter ---------------- */

test('session products (round 22): a Session rung up at the counter stamps the sale\'s customer, once per unit however often Shopify sends it', async () => {
  const order = posOrder(8001, [sessionLine(80011, 'RPG Session', 'LAIR-SESSION-RPG'), { id: 80012, title: 'Drinks', variant_title: '$6 Drink', sku: null, quantity: 1, price: '6.00', properties: [] }], { customer: { id: Number(MIA) } });
  const first = ok(await internal('orders-paid', order));
  assert.equal(first.stamps, 1);
  assert.equal(stamps(MIA), 1);
  const again = ok(await internal('orders-paid', order));
  assert.equal(again.stamps, undefined, 'nothing new the second time');
  assert.equal(stamps(MIA), 1);
  // a minute later, two day passes (Mia and a friend without an account): both on her card; the customer as a gid works too
  nowIs(NOW + 60_000);
  ok(await internal('orders-paid', posOrder(8002, [sessionLine(80021, 'Dice Goblin Day Pass', 'LAIR-SESSION-DAY', 2, '10.00')], { customer: { id: `gid://shopify/Customer/${MIA}` } })));
  assert.equal(stamps(MIA), 3);
  // the order's customer from Shopify wins over the webhook's
  lair.shopify.orderSpend = async () => ({ customerId: KAI, amount: 1500, name: '#8003', source: 'pos' });
  ok(await internal('orders-paid', posOrder(8003, [sessionLine(80031, 'TCG League', 'LAIR-SESSION-TCG', 1, '5.00')])));
  lair.shopify.orderSpend = async () => null;
  assert.equal(stamps(KAI), 1);
  // nobody on the sale stamps nobody; an online order isn't the counter; other products aren't sessions
  ok(await internal('orders-paid', posOrder(8004, [sessionLine(80041, 'RPG Session', 'LAIR-SESSION-RPG')])));
  ok(await internal('orders-paid', posOrder(8005, [sessionLine(80051, 'RPG Session', 'LAIR-SESSION-RPG')], { source_name: 'web', customer: { id: Number(RIA) } })));
  ok(await internal('orders-paid', posOrder(8006, [{ id: 80061, title: 'Catan', variant_title: 'Default Title', sku: 'DGL34-M011', quantity: 1, price: '0.00', properties: [] }], { customer: { id: Number(RIA) } })));
  assert.equal(stamps(RIA), 0);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM loyalty_stamps').one().n, 4);
  // a mistyped quantity can't fill a card in one go
  ok(await internal('orders-paid', posOrder(8007, [sessionLine(80071, 'RPG Kids Session', 'LAIR-SESSION-RPG-KIDS', 25, '10.00')], { customer: { id: Number(RIA) } })));
  assert.equal(stamps(RIA), STAMPS.perLine);
  // My Lair names each one, and the ledger keeps the order
  assert.deepEqual((await card(MIA)).recent.map((r) => [r.title, r.people]), [['Dice Goblin Day Pass', 1], ['Dice Goblin Day Pass', 1], ['RPG Session', 1]]);
  assert.deepEqual(ledger(MIA).map((r) => [r.kind, r.count, r.title, r.order_name, r.line_id, r.unit, r.created_by]), [
    ['sale', 1, 'RPG Session', '#8001', '80011', 0, 'order:#8001'], ['sale', 1, 'Dice Goblin Day Pass', '#8002', '80021', 0, 'order:#8002'],
    ['sale', 1, 'Dice Goblin Day Pass', '#8002', '80021', 1, 'order:#8002'],
  ]);
  // staff see them on the member's page, and can take one back there (not at the counter)
  const detail = ok(await call('GET', `members/${MIA}`, null, OWNER)).member;
  assert.deepEqual(detail.stamps.map((s) => [s.kind, s.count, s.title, s.orderName, s.addedBy, s.undoneAt]), [
    ['sale', 1, 'Dice Goblin Day Pass', '#8002', null, null], ['sale', 1, 'Dice Goblin Day Pass', '#8002', null, null], ['sale', 1, 'RPG Session', '#8001', null, null],
  ]);
  assert.equal(said(await pos('stamp-undo', { customerId: MIA, id: detail.stamps[0].id })), `409 ${W.notHere}`);
  const back = ok(await call('POST', `members/${MIA}/stamps/${detail.stamps[0].id}/undo`, {}, OWNER));
  assert.deepEqual([back.already, back.member.loyalty.stamps, back.member.stamps[0].undoneBy], [false, 2, 'Mo']);
  assert.equal(stamps(MIA), 2);
});

test('session products (round 22, after review): a Session rung up for a session the Lair has that day is the same session: one stamp, whichever came first', async () => {
  const sale = (n, units = 1, at = null) => {
    if (at) nowIs(at);
    return internal('orders-paid', posOrder(n, [sessionLine(n * 10 + 1, 'Dice Goblin Day Pass', 'LAIR-SESSION-DAY', units, '10.00')], { customer: { id: Number(MIA) } }));
  };
  // Mia's table this afternoon, checked in: one stamp; then a Day Pass rung up for it by hand: still one
  const booking = await table(MIA, 'Mia', { tables: ['T4'], people: 1 });
  ok(await pos('checkin', { id: booking.id, type: 'booking' }));
  assert.equal(stamps(MIA), 1);
  ok(await sale(9001, 1, NOW + 60_000));
  assert.equal(stamps(MIA), 1);
  assert.deepEqual((await card(MIA)).recent.map((r) => [r.title, r.people]), [['Table T4', 1]], 'the table is the stamp; the Day Pass was for it');
  // a second Day Pass that day (a session the Lair doesn't know about): that one counts
  ok(await sale(9002, 1, NOW + 120_000));
  assert.equal(stamps(MIA), 2);
  // the other way round, on Monday: Kai's table for 2 (booked on Sunday), two Day Passes rung up first (one stamp each),
  // then the table is checked in
  const kais = await table(KAI, 'Kai', { tables: ['T5'], people: 2, start: at('2026-10-26', 17), end: at('2026-10-26', 19) });
  nowIs(at('2026-10-26', 17));
  ok(await internal('orders-paid', posOrder(9003, [sessionLine(90031, 'Dice Goblin Day Pass', 'LAIR-SESSION-DAY', 2, '10.00')], { customer: { id: Number(KAI) } })));
  assert.equal(stamps(KAI), 2);
  ok(await pos('checkin', { id: kais.id, type: 'booking' }));
  assert.equal(stamps(KAI), 2, 'the table and its two Day Passes are the same session');
  // stamps staff add by hand are never covered
  ok(await call('POST', `members/${KAI}/stamps`, { count: 1 }, OWNER));
  assert.equal(stamps(KAI), 3);
});

test('paid sessions (round 22, after review): a paid sign-up on an event date gone from the calendar stamps only if they were checked in', async () => {
  const join = ok(await call('POST', 'events/quiz@2026-10-25/join', { name: 'Mia', email: 'mia@example.com', phone: '021 555 0100', people: 2 }, MIA)).join;
  ok(await internal('orders-paid', posOrder(9101, [bookingLine(91011, join.ref, 10)])));
  assert.equal(stamps(MIA), 2);
  // the quiz is taken off the calendar in Shopify: paid but not there (it may not have happened), so no stamps
  const rules = lair.rulesCache;
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  assert.equal(stamps(MIA), 0);
  // put back: back again
  lair.rulesCache = rules;
  assert.equal(stamps(MIA), 2);
  // checked in, it happened: it stamps whatever the calendar says now
  ok(await pos('checkin', { id: join.id, type: 'join' }));
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  assert.equal(stamps(MIA), 2);
  lair.rulesCache = rules;
});

test('paid sessions (round 22, after review): a GM who pays a guest\'s seat in their own session gets no stamp for it; anyone else would', async () => {
  const id = await list();
  const guest = (name, email) => call('POST', 'bookings', { kind: 'gm-seat', gameId: id, people: 1, name, email, phone: '021 555 0101', pay: 'day' }, '');
  const pats = ok(await guest('Pat', 'pat@example.com')).booking;
  const jos = ok(await guest('Jo', 'jo@example.com')).booking;
  lair.shopify.orderSpend = async () => ({ customerId: RANGI, amount: 1500, name: '#9201', source: 'pos' });
  ok(await internal('orders-paid', posOrder(9201, [bookingLine(92011, pats.ref, 15)])));
  lair.shopify.orderSpend = async () => ({ customerId: KAI, amount: 1500, name: '#9202', source: 'pos' });
  ok(await internal('orders-paid', posOrder(9202, [bookingLine(92021, jos.ref, 15)])));
  lair.shopify.orderSpend = async () => null;
  nowIs(at('2026-10-27', 19));
  assert.deepEqual([stamps(RANGI), stamps(KAI)], [0, 1], "Rangi runs it (his stamp is the session's own); Kai's payment is Jo's seat");
});

/* ---------------- stamps staff add ---------------- */

test('staff stamps (round 22): at the counter, one a tap; the same tap again adds nothing; Undo takes it back', async () => {
  const added = ok(await pos('stamp', { customerId: MIA, key: 'tap-aaaa-0001' }));
  assert.deepEqual([added.repeated, added.stamp.kind, added.stamp.count, added.stamp.title, added.stamp.addedBy, added.stamp.undoneAt], [false, 'staff', 1, W.staffTitle, 'the counter', null]);
  assert.deepEqual(added.loyalty, { stamps: 1, cardSize: 10, rollsAvailable: 0, card: 1 });
  // the answer was lost and the counter asked again with the same key: nothing more
  const repeat = ok(await pos('stamp', { customerId: MIA, key: 'tap-aaaa-0001' }));
  assert.deepEqual([repeat.repeated, repeat.stamp.id, repeat.loyalty.stamps], [true, added.stamp.id, 1]);
  assert.equal(stamps(MIA), 1);
  // a new tap is a new stamp
  ok(await pos('stamp', { customerId: MIA, key: 'tap-aaaa-0002' }));
  assert.equal(stamps(MIA), 2);
  // after review: two a member a day from the counter (one a tap, for a session the Lair app doesn't know about), so ten
  // taps can't fill a card; without a key (older screens) it's the same
  assert.equal(said(await pos('stamp', { customerId: MIA })), `409 ${W.daily}`);
  assert.equal(said(await pos('stamp', { customerId: MIA, key: 'tap-aaaa-0005' })), `409 ${W.daily}`);
  // the same key for someone else, a key that isn't one, nobody, and no account
  assert.equal(said(await pos('stamp', { customerId: KAI, key: 'tap-aaaa-0001' })), `409 ${W.notTheirs}`);
  assert.equal(said(await pos('stamp', { customerId: MIA, key: 'x' })), `422 ${W.badKey}`);
  assert.equal(said(await pos('stamp', { customerId: MIA, key: 'has spaces in it' })), `422 ${W.badKey}`);
  assert.equal(said(await pos('stamp', { key: 'tap-aaaa-0003' })), `404 ${W.noMember}`);
  assert.equal(said(await pos('stamp', { customerId: '4040', key: 'tap-aaaa-0004' })), `404 ${W.noMember}`);
  assert.equal(stamps(MIA), 2);
  assert.equal(stamps(KAI), 0);
  // Undo: gone from the card; again, nothing more; someone else's or a stamp that isn't there
  const undone = ok(await pos('stamp-undo', { customerId: MIA, id: added.stamp.id }));
  assert.deepEqual([undone.already, undone.loyalty.stamps, undone.stamp.undoneBy, Boolean(undone.stamp.undoneAt)], [false, 1, 'the counter', true]);
  assert.equal(ok(await pos('stamp-undo', { customerId: MIA, id: added.stamp.id })).already, true);
  assert.equal(stamps(MIA), 1);
  assert.equal(said(await pos('stamp-undo', { customerId: KAI, id: repeat.stamp.id })), `409 ${W.notTheirs}`);
  assert.equal(said(await pos('stamp-undo', { customerId: MIA, id: 'st_nothere' })), `404 ${W.notFound}`);
  // the same key after Undo is still the first tap: it never adds it again
  assert.equal(ok(await pos('stamp', { customerId: MIA, key: 'tap-aaaa-0001' })).repeated, true);
  assert.equal(stamps(MIA), 1);
  // a stamp taken back doesn't count towards the day's two: one more tap works
  ok(await pos('stamp', { customerId: MIA, key: 'tap-aaaa-0006' }));
  assert.equal(stamps(MIA), 2);
  // My Lair lists them as Gobgob's, without the undone one
  assert.deepEqual((await card(MIA)).recent.map((r) => [r.title, r.people]), [[W.staffTitle, 1], [W.staffTitle, 1]]);
  // tomorrow the counter can add two more
  nowIs(at('2026-10-26', 10));
  ok(await pos('stamp', { customerId: MIA, key: 'tap-aaaa-0007' }));
  assert.equal(stamps(MIA), 3);
});

test('staff stamps (round 22, after review): a helper never stamps their own card; without Members, one at a time and two a day with the counter; the counter takes back only its own', async () => {
  // Hemi (Check-in only) and his own card: no, one at a time or more
  assert.equal(said(await call('POST', `members/${HEMI}/stamps`, { count: 1 }, HEMI)), `403 ${W.ownCard}`);
  assert.equal(said(await call('POST', `members/${HEMI}/stamps`, { count: 10 }, HEMI)), `403 ${W.ownCard}`);
  assert.equal(stamps(HEMI), 0);
  // on Mia's card: one at a time (the check-in card's way), recorded as his, from check-in
  assert.equal(said(await call('POST', `members/${MIA}/stamps`, { count: 2 }, HEMI)), `403 ${W.oneAtATime}`);
  const one = ok(await call('POST', `members/${MIA}/stamps`, { count: 1, key: 'hemi-tap-0001' }, HEMI));
  assert.equal(one.stamp.addedBy, 'Hemi');
  assert.equal(lair.sql.exec('SELECT created_by FROM loyalty_stamps WHERE id = ?', one.stamp.id).one().created_by, `checkin:${HEMI}`);
  // the counter's tap and Hemi's share the day's two
  ok(await pos('stamp', { customerId: MIA, key: 'counter-tap-0001' }));
  assert.equal(said(await call('POST', `members/${MIA}/stamps`, { count: 1 }, HEMI)), `409 ${W.daily}`);
  assert.equal(said(await pos('stamp', { customerId: MIA, key: 'counter-tap-0002' })), `409 ${W.daily}`);
  assert.equal(stamps(MIA), 2);
  // the main account (and helpers with Members) aren't limited: a member's page, with a note
  ok(await call('POST', `members/${MIA}/stamps`, { count: 5, note: 'A league night the Lair missed' }, OWNER));
  assert.equal(stamps(MIA), 7);
  // the main account can stamp their own card (it's their shop); a helper with Members still can't stamp their own
  ok(await call('POST', `members/${OWNER}/stamps`, { count: 1 }, OWNER));
  ok(await call('POST', 'team', { customerId: HEMI, name: 'Hemi Walker', email: 'hemi@example.com', perms: ['checkin', 'members'] }, OWNER));
  assert.equal(said(await call('POST', `members/${HEMI}/stamps`, { count: 1 }, HEMI)), `403 ${W.ownCard}`);
  ok(await call('POST', `members/${MIA}/stamps`, { count: 3 }, HEMI));
  assert.equal(stamps(MIA), 10);
  // the counter can't take back a stamp added on the staff page (the main account's five), only its own
  const page = ok(await call('GET', `members/${MIA}`, null, OWNER)).member;
  const mos = page.stamps.find((s) => s.count === 5);
  const counters = page.stamps.find((s) => s.addedBy === 'the counter');
  assert.equal(said(await pos('stamp-undo', { customerId: MIA, id: mos.id })), `409 ${W.notHere}`);
  assert.equal(said(await pos('stamp-undo', { customerId: MIA, id: one.stamp.id })), `409 ${W.notHere}`, "Hemi's check-in stamp is the staff page's to take back");
  assert.equal(ok(await pos('stamp-undo', { customerId: MIA, id: counters.id })).already, false);
});

test('staff stamps (round 22): on a member\'s page, 1 to 10 with a note, for staff with Check-in or Members; Undo there; ten fill a card', async () => {
  const given = ok(await call('POST', `members/${MIA}/stamps`, { count: 3, note: 'Missed check-ins on Friday', key: 'page-aaaa-0001' }, OWNER));
  assert.equal(given.member.customerId, MIA);
  assert.deepEqual(given.member.loyalty, { stamps: 3, cards: 0, rollsAvailable: 0, card: 1 });
  assert.deepEqual(given.member.stamps.map((s) => [s.kind, s.count, s.note, s.addedBy, s.undoneAt]), [['staff', 3, 'Missed check-ins on Friday', 'Mo', null]]);
  assert.equal(ok(await call('POST', `members/${MIA}/stamps`, { count: 3, key: 'page-aaaa-0001' }, OWNER)).repeated, true, 'a double tap');
  assert.equal(stamps(MIA), 3);
  // who can: a helper with Check-in can; one with Library only can't, nor can a member
  ok(await call('POST', `members/${MIA}/stamps`, { count: 1 }, HEMI));
  assert.equal(said(await call('POST', `members/${MIA}/stamps`, { count: 1 }, TAMA)), NOT_YOURS);
  assert.equal(said(await call('POST', `members/${MIA}/stamps`, { count: 1 }, MIA)), '403 Staff only. Log in with your staff account.');
  for (const count of [0, 11, 2.5, 'lots', -1]) assert.equal(said(await call('POST', `members/${MIA}/stamps`, { count }, OWNER)), `422 ${W.count}`, String(count));
  assert.equal(said(await call('POST', 'members/4040/stamps', { count: 1 }, OWNER)), `404 ${W.noMember}`);
  assert.equal(stamps(MIA), 4);
  // Undo on their page: Hemi takes back Mo's three; the list keeps it, marked
  const page = ok(await call('GET', `members/${MIA}`, null, OWNER)).member;
  const mos = page.stamps.find((s) => s.count === 3);
  const back = ok(await call('POST', `members/${MIA}/stamps/${mos.id}/undo`, {}, HEMI));
  assert.equal(back.member.loyalty.stamps, 1);
  assert.deepEqual(back.member.stamps.map((s) => [s.count, s.addedBy, s.undoneBy, Boolean(s.undoneAt)]), [[1, 'Hemi', null, false], [3, 'Mo', 'Hemi', true]]);
  assert.equal(said(await call('POST', `members/${KAI}/stamps/${mos.id}/undo`, {}, OWNER)), `409 ${W.notTheirs}`);
  assert.equal(said(await call('POST', `members/${MIA}/stamps/${mos.id}/undo`, {}, TAMA)), NOT_YOURS);
  // ten fill a card: the next card starts and a roll waits in My Lair
  ok(await call('POST', `members/${MIA}/stamps`, { count: 9 }, OWNER));
  const full = await card(MIA);
  assert.deepEqual([full.stamps, full.cards, full.card, full.rolls.available], [0, 1, 2, 1]);
});

/* ---------------- the counter sees a ticket's card ---------------- */

test('the counter (round 22): a ticket on an account shows its card, and the check-in answer brings its new stamps; a guest\'s has none', async () => {
  const booking = await table(MIA, 'Mia', { people: 2 });
  const scan = ok(await pos('scan', { code: booking.ref }));
  assert.deepEqual(scan.loyalty, { stamps: 0, cardSize: 10, rollsAvailable: 0, card: 1 });
  const checkin = ok(await pos('checkin', { id: booking.id, type: 'booking' }));
  assert.deepEqual([checkin.checkedIn, checkin.loyalty], [true, { stamps: 2, cardSize: 10, rollsAvailable: 0, card: 1 }]);
  // a guest's booking (no account) has no card to show
  const guest = ok(await call('POST', 'bookings', { kind: 'table', tables: ['T6'], start: at('2026-10-25', 14), end: at('2026-10-25', 16), people: 2, name: 'Pat', email: 'pat@example.com', phone: '021 555 0101', pay: 'day' }, '')).booking;
  const guestScan = ok(await pos('scan', { code: guest.ref }));
  assert.equal('loyalty' in guestScan, false);
  assert.equal('loyalty' in ok(await pos('checkin', { id: guest.id, type: 'booking' })), false);
});

test('the staff page (round 22): a member code at check-in brings their card, so a helper with Check-in can add a stamp there', async () => {
  const before = ok(await call('POST', 'checkin', { code: codeOf(MIA) }, HEMI));
  assert.equal(before.kind, 'member');
  assert.deepEqual(before.loyalty, { stamps: 0, cardSize: 10, cards: 0, rollsAvailable: 0, card: 1 });
  const added = ok(await call('POST', `members/${MIA}/stamps`, { count: 1, key: 'checkin-card-tap-1' }, HEMI));
  assert.deepEqual([added.member.loyalty.stamps, added.member.loyalty.card, added.stamp.addedBy], [1, 1, 'Hemi']);
  assert.deepEqual(ok(await call('POST', 'checkin', { code: codeOf(MIA) }, HEMI)).loyalty, { stamps: 1, cardSize: 10, cards: 0, rollsAvailable: 0, card: 1 });
  // nine more fill the card: the next scan shows card 2, and a roll waiting
  ok(await call('POST', `members/${MIA}/stamps`, { count: 9 }, OWNER));
  assert.deepEqual(ok(await call('POST', 'checkin', { code: codeOf(MIA) }, HEMI)).loyalty, { stamps: 0, cardSize: 10, cards: 1, rollsAvailable: 1, card: 2 });
});

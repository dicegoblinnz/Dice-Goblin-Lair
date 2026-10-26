// Round 21, part 2: a GM pays for one of their players (contract v21-gm-cover). Mo (26 Oct 2026): "have the option for
// the gm to pay for someone else if they wish from one of their players. Paying the full $10 for Thier time and they
// don't get store credit for them playing." Then "Both" (the website and the counter) and "Until the player has paid".
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { GM_COVER_WORDS as W } from '../src/gm-cover.js';
import { GM_SESSION_WORDS } from '../src/gm-sessions.js';

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

/* ---------------- helpers, as in test/round21-gm-credit.test.js ---------------- */
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
  { id: 'side-room-2', name: 'Side room 2', code: 'B', tables: 4, seats: 4, order: 3 },
];
// People by their Shopify customer IDs (made up): the main account; helpers Hemi (Check-in) and Tama (Library only);
// Rangi and Wiremu, GMs who aren't staff; and players
const OWNER = '9001';
const HEMI = '9102';
const TAMA = '9103';
const RANGI = '5001';
const WIREMU = '5002';
const MIA = '6001';
const KAI = '6002';
const RIA = '6003';
const NAMES = { [OWNER]: 'Mo', [RANGI]: 'Rangi', [WIREMU]: 'Wiremu' };
const NOT_YOURS = `403 ${W.notYours}`;

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
const cover = (gameId, ref, who) => call('POST', `games/${gameId}/players/${encodeURIComponent(ref)}/cover`, {}, who);
const uncover = (gameId, ref, who) => call('POST', `games/${gameId}/players/${encodeURIComponent(ref)}/uncover`, {}, who);
const update = (id, patch, who = OWNER) => call('POST', `bookings/${id}/update`, patch, who);
const board = async (who = '') => ok(await call('GET', `floor?from=${at('2026-10-24', 0)}&to=${at('2026-11-20', 0)}`, null, who));
const gameOn = async (id, who = '') => (await board(who)).games.find((g) => g.id === id);
const me = async (who) => ok(await call('GET', 'me', null, who));
/** The GM's charge for a seat, as stored */
const coverRow = (seatId) => lair.coverOf(seatId);
const posOrder = (n, lines) => ({
  id: n, admin_graphql_api_id: `gid://shopify/Order/${n}`, source_name: 'pos',
  line_items: lines.map((l, i) => ({ id: n * 10 + i, quantity: 1, price: l.price, properties: Object.entries(l.properties).map(([name, value]) => ({ name, value })) })),
});

/** A session listed by the main account for a GM (Rangi unless said), Tuesday 27 October 6pm to 10pm unless said */
async function list({ gm = RANGI, start = at('2026-10-27', 18), end = at('2026-10-27', 22), seats = 4, gmFee, tables = ['B1'], title, email } = {}) {
  const name = NAMES[gm] || 'Hemi';
  const forGm = gm ? { gmCustomerId: gm, gmCustomerName: name, gmEmail: `${name.toLowerCase()}@example.com` } : { gmEmail: email };
  return ok(await call('POST', 'games', {
    title: title || `${name}'s one-shot`, system: 'D&D 5e', gm: name, blurb: 'A test session.', seats, tables, start, end, ...forGm,
    ...(gmFee === undefined ? {} : { gmFee }),
  }, OWNER)).game.id;
}

/** A seat booked online by a member (pay at the Lair). → the booking */
async function seat(gameId, who, name, { people = 1 } = {}) {
  return ok(await call('POST', 'bookings', {
    kind: 'gm-seat', gameId, people, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100', pay: 'day',
  }, who)).booking;
}

// No network in these tests: no Shopify and no emails (but captureEmails' stand-in for Resend). Anything that reaches
// for it is noted, and the test fails.
const realFetch = globalThis.fetch;
let reached = [];
let alerts = [];
let shopifyOn = false;

beforeEach(async () => {
  reached = [];
  alerts = [];
  shopifyOn = false;
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
  lair.shopify.creditCustomer = async () => ({ amount: { amount: '0' } });
  lair.notifyStaff = (subject, content) => alerts.push({ subject, intro: content.intro });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  for (const [id, name, perms] of [[HEMI, 'Hemi Walker', ['checkin']], [TAMA, 'Tama Rewi', ['library']]]) {
    ok(await call('POST', 'team', { customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, perms }, OWNER));
  }
  for (const [id, name] of [[RANGI, 'Rangi Hohaia'], [WIREMU, 'Wiremu Paki'], [MIA, 'Mia Chen'], [KAI, 'Kai Tane'], [RIA, 'Ria Moana']]) {
    lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
  }
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

/* ---------------- the words ---------------- */

test('GM pays (round 21): the words, word for word', () => {
  assert.deepEqual(W, {
    login: 'Log in to pay for a player.',
    notYours: "Only this session's GM or staff can do that.",
    noGame: 'Game not found.',
    cancelled: 'This session was cancelled.',
    pending: "This session isn't live yet.",
    free: "This session is free, so there's nothing to pay for.",
    noSeat: "That seat isn't on this session any more.",
    own: "That's your own seat.",
    noAccount: 'The GM needs a Dice Goblin account to pay for a player.',
    paid: W.paid,
    nothing: W.nothing,
    already: W.already,
    notCovered: "The GM isn't paying for that seat.",
    coverPaid: "The GM has paid for that seat already, so it can't change now. Ask staff if it needs a refund.",
    started: 'The session has started, so ask staff to change it.',
    stopFirst: 'To stop paying for them, tap "Stop paying" on the session.',
    title: W.title,
  });
  assert.equal(W.paid('Mia'), "Mia has paid for their seat already, so there's nothing to pay for.");
  assert.equal(W.nothing('Mia'), 'Mia has nothing to pay for their seat.');
  assert.equal(W.already('Mia'), 'The GM is paying for Mia already.');
  assert.equal(W.title('Mia', 'Curse of Strahd'), "Paying for Mia's seat: Curse of Strahd");
});

/* ---------------- paying for a player ---------------- */

test('GM pays (round 21): the session\'s GM pays the $10 table part for a player, who then pays nothing; the GM\'s charge is on their account', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  const kais = await seat(id, KAI, 'Kai');
  // the GM's list says who they could pay for
  let players = (await gameOn(id, RANGI)).players;
  assert.deepEqual(players.map((p) => [p.name, p.covered, p.coverable]), [['Mia', false, true], ['Kai', false, true]]);
  const done = ok(await cover(id, mias.ref, RANGI));
  assert.deepEqual([done.seat.ref, done.seat.covered, done.seat.coverable, done.seat.due], [mias.ref, true, false, 0]);
  assert.deepEqual([done.cover.amount, done.cover.due, done.cover.paid, done.cover.people, done.cover.status], [1000, 1000, false, 1, 'confirmed']);
  // the seat: $0 for Mia, and what it cost is kept
  const seatNow = lair.booking(mias.id);
  assert.deepEqual([seatNow.amount, seatNow.coveredBy, seatNow.coverWas, seatNow.paid, seatNow.status], [0, RANGI, 1500, false, 'confirmed']);
  // the GM's charge: a booking of its own, on Rangi's account, with no tables
  const charge = coverRow(mias.id);
  assert.deepEqual([charge.kind, charge.customerId, charge.amount, charge.people, charge.tables, charge.gameId, charge.coverOf, charge.status],
    ['gm-cover', RANGI, 1000, 1, [], id, mias.id, 'confirmed']);
  assert.equal(lair.rowTitle(charge, lair.rulesCache), "Paying for Mia's seat: Rangi's one-shot");
  // the board: Mia's seat is still a seat (4 seats, 2 taken), the GM's list shows it covered
  const game = await gameOn(id, RANGI);
  assert.equal(game.taken, 2);
  assert.deepEqual(game.players.map((p) => [p.name, p.covered, p.coverable]), [['Mia', true, false], ['Kai', false, true]]);
  // the public floor has no sign of the GM's charge; staff see it
  assert.ok(!(await board()).bookings.some((b) => b.id === charge.id));
  assert.ok(!(await board(RANGI)).bookings.some((b) => b.id === charge.id));
  assert.ok((await board(OWNER)).bookings.some((b) => b.id === charge.id));
  // My Lair: Mia's seat has nothing to pay; Rangi's charge is listed
  const mias2 = (await me(MIA)).seats.find((s) => s.id === mias.id);
  assert.deepEqual([mias2.coveredByGm, mias2.due, mias2.amount], [true, 0, 0]);
  const covers = (await me(RANGI)).covers;
  assert.deepEqual(covers.map((c) => [c.ref, c.title, c.player, c.amount, c.due, c.paid, c.owed]), [[charge.ref, "Paying for Mia's seat: Rangi's one-shot", 'Mia', 1000, 1000, false, false]]);
  // Rangi's account says it's coming up, as a 'cover', with nothing to cancel there (Stop paying is on the session)
  const coming = (await me(RANGI)).account.comingUp.items.find((x) => x.id === charge.id);
  assert.deepEqual([coming.kind, coming.title, coming.amount, coming.cancelUntil, coming.locked], ['cover', "Paying for Mia's seat: Rangi's one-shot", 1000, null, false]);
  // paying for a GM fee of $10: the table part is still $10
  const dearer = await list({ tables: ['B2'], gmFee: 1000, title: 'Dearer one' });
  const rias = await seat(dearer, RIA, 'Ria', { people: 2 });
  assert.equal(lair.booking(rias.id).amount, 4000);
  const two = ok(await cover(dearer, rias.ref, RANGI));
  assert.deepEqual([two.cover.amount, two.cover.people], [2000, 2]);
});

test('GM pays (round 21): only the session\'s GM, or staff with GM games, Check-in or Money; never logged out', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  assert.equal(said(await cover(id, mias.ref, '')), `401 ${W.login}`);
  assert.equal(said(await cover(id, mias.ref, WIREMU)), NOT_YOURS, 'another GM');
  assert.equal(said(await cover(id, mias.ref, MIA)), NOT_YOURS, 'the player');
  assert.equal(said(await cover(id, mias.ref, TAMA)), NOT_YOURS, 'a helper with Library only');
  // Hemi at the desk (Check-in)
  ok(await cover(id, mias.ref, HEMI));
  assert.equal(said(await uncover(id, mias.ref, WIREMU)), NOT_YOURS);
  ok(await uncover(id, mias.ref, HEMI));
  // the main account; and at the counter (the POS: { gameId, ref })
  ok(await cover(id, mias.ref, OWNER));
  ok(await uncover(id, mias.ref, OWNER));
  const atCounter = ok(await pos('cover', { gameId: id, ref: mias.ref }));
  assert.equal(atCounter.cover.amount, 1000);
  ok(await pos('uncover', { gameId: id, ref: mias.ref }));
  assert.equal(lair.booking(mias.id).amount, 1500);
});

test('GM pays (round 21): until the player has paid: not a paid, part-paid, pass or waived seat; not twice, not the GM\'s own; a live session with a price', async () => {
  const id = await list();
  const paid = await seat(id, MIA, 'Mia');
  ok(await update(paid.id, { paid: true }));
  assert.equal(said(await cover(id, paid.ref, RANGI)), `409 ${W.paid('Mia')}`);
  const waived = await seat(id, KAI, 'Kai');
  ok(await update(waived.id, { waived: true }));
  assert.equal(said(await cover(id, waived.ref, RANGI)), `409 ${W.nothing('Kai')}`);
  const part = await seat(id, RIA, 'Ria', { people: 2 });
  lair.sql.exec('UPDATE bookings SET paid_amount = 1500 WHERE id = ?', part.id);
  assert.equal(said(await cover(id, part.ref, RANGI)), `409 ${W.paid('Ria')}`);
  lair.sql.exec('UPDATE bookings SET paid_amount = 0, covered = 1000 WHERE id = ?', part.id);
  assert.equal(said(await cover(id, part.ref, RANGI)), `409 ${W.paid('Ria')}`, 'a session pass covered some');
  lair.sql.exec('UPDATE bookings SET covered = 0 WHERE id = ?', part.id);
  ok(await cover(id, part.ref, RANGI));
  assert.equal(said(await cover(id, part.ref, RANGI)), `409 ${W.already('Ria')}`);
  // the GM's own seat
  const other = await list({ tables: ['B2'] });
  const own = await seat(other, RANGI, 'Rangi');
  assert.equal(said(await cover(other, own.ref, RANGI)), `409 ${W.own}`);
  // a seat from another session, a seat that's gone, and a code nobody has
  const kais = await seat(other, KAI, 'Kai');
  assert.equal(said(await cover(id, kais.ref, RANGI)), `404 ${W.noSeat}`);
  ok(await update(kais.id, { status: 'cancelled' }));
  assert.equal(said(await cover(other, kais.ref, RANGI)), `404 ${W.noSeat}`);
  assert.equal(said(await cover(other, 'XX-NOPE-1', RANGI)), `404 ${W.noSeat}`);
  // a free session; a cancelled one; a GM with no account
  const free = await list({ tables: ['B3'], title: 'Free night' });
  const freeSeat = await seat(free, MIA, 'Mia');
  ok(await call('POST', `games/${free}/free`, { free: true }, OWNER));
  assert.equal(said(await cover(free, freeSeat.ref, OWNER)), `409 ${W.free}`);
  const gone = await list({ tables: ['B4'], title: 'Called off' });
  const goneSeat = await seat(gone, RIA, 'Ria');
  ok(await call('POST', `games/${gone}/update`, { status: 'cancelled' }, OWNER));
  assert.equal(said(await cover(gone, goneSeat.ref, OWNER)), `409 ${W.cancelled}`);
  const noAccount = await list({ gm: null, email: 'hemi.gm@example.com', tables: ['T1'], title: "Hemi's one-shot" });
  const theirs = await seat(noAccount, KAI, 'Kai');
  assert.equal(said(await cover(noAccount, theirs.ref, OWNER)), `409 ${W.noAccount}`);
  assert.equal(said(await cover('gm_nope', theirs.ref, OWNER)), `404 ${W.noGame}`);
});

test('GM pays (round 21): until the player has paid, after the session too: an owed seat becomes the GM\'s owed charge', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  nowIs(at('2026-10-28', 12));
  // Mia didn't pay: her seat is owed
  assert.equal(lair.isOwed(lair.booking(mias.id)), true);
  ok(await cover(id, mias.ref, RANGI));
  // now Mia owes nothing, and Rangi owes $10, as an owed line at the counter
  assert.equal(lair.isOwed(lair.booking(mias.id)), false);
  assert.deepEqual(lair.owedRows(MIA, lair.rulesCache, Date.now()), []);
  const owed = lair.owedRows(RANGI, lair.rulesCache, Date.now());
  assert.deepEqual(owed.map((r) => [r.kind, r.due, r.owed, r.line.title, r.line.price]), [['gm-cover', 1000, true, "Owed: Paying for Mia's seat: Rangi's one-shot (Tue 27 Oct)", '10.00']]);
  // but he can't stop paying now the session's started; staff can
  assert.equal(said(await uncover(id, mias.ref, RANGI)), `403 ${W.started}`);
});

test('GM pays (round 21): at the counter the GM\'s charge is paid, never checked in; the player checks in on their seat, with nothing to pay', async () => {
  shopifyOn = true;
  const id = await list({ start: at('2026-10-25', 18), end: at('2026-10-25', 21) });
  const mias = await seat(id, MIA, 'Mia');
  ok(await cover(id, mias.ref, RANGI));
  const charge = coverRow(mias.id);
  nowIs(at('2026-10-25', 17, 30));
  // Rangi's member code at the counter: the charge is his to pay today, not someone to check in
  const scanned = ok(await pos('checkin-member', { customerId: RANGI }));
  const row = scanned.rows.find((r) => r.id === charge.id);
  assert.deepEqual([row.kind, row.due, row.status, row.arrivedAt], ['gm-cover', 1000, 'confirmed', null]);
  const line = scanned.lines.find((l) => l.properties._booking === charge.ref);
  assert.deepEqual([line.title, line.price], [`Paying for Mia's seat: Rangi's one-shot (${charge.ref})`, '10.00']);
  assert.equal(lair.booking(charge.id).status, 'confirmed', 'never checked in');
  const direct = ok(await pos('checkin', { id: charge.id, type: 'booking' }));
  assert.deepEqual([direct.checkedIn, direct.reason], [false, 'cover']);
  assert.equal(direct.message, `Paying for Mia's seat: Rangi's one-shot: nothing to check in. Charge $10.00.`);
  // the POS Today list has Mia (in the game's group), not the charge
  const today = ok(await pos('today', {}));
  const rows = today.groups.flatMap((g) => g.rows);
  assert.ok(rows.some((r) => r.id === mias.id));
  assert.ok(!rows.some((r) => r.id === charge.id));
  // Mia checks in: nothing to pay
  const mia = ok(await pos('checkin', { id: mias.id, type: 'booking' }));
  assert.deepEqual([mia.checkedIn, mia.due], [true, 0]);
  // Rangi pays at the counter: the POS order's _booking line pays his charge
  const paid = await internal('orders-paid', posOrder(2101, [line]));
  assert.deepEqual(paid.data.updated, [charge.ref]);
  const after = lair.booking(charge.id);
  assert.deepEqual([after.paid, after.paidAmount], [true, 1000]);
  assert.deepEqual((await me(RANGI)).covers.map((c) => [c.paid, c.due]), [[true, 0]]);
  // Mia's stamp is hers, and the GM's charge gives nobody a stamp or a seat
  assert.equal(lair.stampCount(MIA), 1);
  assert.equal(lair.stampCount(RANGI), 0);
  assert.equal(lair.takenSeats(id), 1);
});

test('GM pays (round 21): no GM credit for a seat the GM pays for; the floor tells staff how many the GM covered', async () => {
  shopifyOn = true;
  const credited = [];
  lair.shopify.creditCustomer = async (customerId, cents) => {
    credited.push([customerId, cents]);
    return { amount: { amount: (cents / 100).toFixed(2) } };
  };
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  const kais = await seat(id, KAI, 'Kai');
  ok(await cover(id, mias.ref, RANGI));
  ok(await update(kais.id, { paid: true }));
  ok(await update(coverRow(mias.id).id, { paid: true }));
  nowIs(at('2026-10-27', 22, 10));
  assert.equal((await lair.autoGmCredit(Date.now())).credited, 1);
  assert.deepEqual(credited, [[RANGI, 500]], "Kai's $5, not Mia's");
  const view = (await gameOn(id, OWNER)).gmCredit;
  assert.deepEqual([view.credited, view.covered, view.unpaid], [{ players: 1, amount: 500 }, { players: 1 }, { players: 0 }]);
});

test('GM pays (round 21): the charge follows the seat: gone when the player cancels or doesn\'t come, back when the seat is', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  ok(await cover(id, mias.ref, RANGI));
  const charge = coverRow(mias.id);
  // Mia cancels from My Lair
  ok(await update(mias.id, { status: 'cancelled' }, MIA));
  assert.deepEqual([lair.booking(mias.id).status, lair.booking(charge.id).status], ['cancelled', 'cancelled']);
  assert.deepEqual((await me(RANGI)).covers, []);
  // staff put her back: so is the charge
  ok(await update(mias.id, { status: 'confirmed' }));
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(charge.id).status], [0, 'confirmed']);
  // a no-show: Rangi pays nothing, and Mia owes nothing
  nowIs(at('2026-10-27', 19));
  ok(await update(mias.id, { status: 'noshow' }));
  assert.equal(lair.booking(charge.id).status, 'cancelled');
  nowIs(at('2026-10-28', 12));
  assert.deepEqual([lair.owedRows(MIA, lair.rulesCache, Date.now()), lair.owedRows(RANGI, lair.rulesCache, Date.now())], [[], []]);
  // the GM can't cancel the charge as a booking; staff can't change its status or people there either
  assert.equal(said(await update(charge.id, { status: 'cancelled' }, RANGI)), `409 ${W.stopFirst}`);
  assert.equal(said(await update(charge.id, { status: 'cancelled' })), `409 ${W.stopFirst}`);
  assert.equal(said(await update(charge.id, { people: 3 })), `409 ${W.stopFirst}`);
});

test('GM pays (round 21): a charge the GM had paid, then the seat went: a refund due, and staff hear', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  ok(await cover(id, mias.ref, RANGI));
  const charge = coverRow(mias.id);
  ok(await update(charge.id, { paid: true }));
  // staff take Mia off the game
  ok(await call('POST', `games/${id}/players/${encodeURIComponent(mias.ref)}/remove`, {}, OWNER));
  const after = lair.booking(charge.id);
  assert.deepEqual([after.status, after.refund], ['cancelled', 'due']);
  assert.deepEqual(alerts.map((a) => a.subject), [`Refund due: ${charge.ref}`]);
  assert.match(alerts[0].intro, /A GM only pays for players who play/);
  // a paid charge can't be stopped by the GM; once it's gone with its seat, staff can still put the seat's price back
  const kais = await seat(id, KAI, 'Kai');
  ok(await cover(id, kais.ref, RANGI));
  ok(await update(coverRow(kais.id).id, { paid: true }));
  assert.equal(said(await uncover(id, kais.ref, RANGI)), `409 ${W.coverPaid}`);
  assert.equal(said(await uncover(id, kais.ref, OWNER)), `409 ${W.coverPaid}`);
  ok(await uncover(id, mias.ref, OWNER));
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(mias.id).coveredBy], [1500, undefined]);
});

test('GM pays (round 21): stop paying: the GM before the session starts, staff any time; the seat costs what it did', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia', { people: 2 });
  ok(await cover(id, mias.ref, RANGI));
  // staff change the seat's people: still $0 for them, and the GM's charge follows
  ok(await update(mias.id, { people: 3 }));
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(mias.id).coverWas, coverRow(mias.id).amount, coverRow(mias.id).people], [0, 4500, 3000, 3]);
  const stopped = ok(await uncover(id, mias.ref, RANGI));
  assert.deepEqual([stopped.cover, stopped.seat.covered, stopped.seat.coverable], [null, false, true]);
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(mias.id).coveredBy, lair.booking(mias.id).coverWas], [4500, undefined, undefined]);
  assert.equal(lair.coverOf(mias.id).status, 'cancelled');
  assert.equal(said(await uncover(id, mias.ref, RANGI)), `409 ${W.notCovered}`);
  // again, then it starts: only staff can stop it now
  ok(await cover(id, mias.ref, RANGI));
  nowIs(at('2026-10-27', 18, 5));
  assert.equal(said(await uncover(id, mias.ref, RANGI)), `403 ${W.started}`);
  ok(await uncover(id, mias.ref, HEMI));
  assert.equal(lair.booking(mias.id).amount, 4500);
});

test('GM pays (round 21): a session made free takes the charges off; a session cancelled refunds a charge the GM had paid', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  const kais = await seat(id, KAI, 'Kai');
  ok(await cover(id, mias.ref, RANGI));
  ok(await cover(id, kais.ref, RANGI));
  // a paid charge stops it going free, like a paid seat
  ok(await update(coverRow(kais.id).id, { paid: true }));
  assert.equal(said(await call('POST', `games/${id}/free`, { free: true }, OWNER)), `409 ${GM_SESSION_WORDS.paidAlready(1)}`);
  ok(await update(coverRow(kais.id).id, { paid: false }));
  ok(await call('POST', `games/${id}/free`, { free: true }, OWNER));
  assert.deepEqual([coverRow(mias.id).status, coverRow(kais.id).status], ['cancelled', 'cancelled']);
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(mias.id).coveredBy], [0, undefined]);
  // back to a price: the seats are priced again, for the players (the GM's charge is gone)
  ok(await call('POST', `games/${id}/free`, { free: false }, OWNER));
  assert.equal(lair.booking(mias.id).amount, 1500);
  // another session: the GM paid, then it's cancelled: a refund due, with the players'
  const other = await list({ tables: ['B2'], title: 'Called off' });
  const rias = await seat(other, RIA, 'Ria');
  ok(await cover(other, rias.ref, RANGI));
  const charge = coverRow(rias.id);
  lair.sql.exec('UPDATE bookings SET paid = 1, paid_amount = 1000 WHERE id = ?', charge.id);
  ok(await call('POST', `games/${other}/update`, { status: 'cancelled' }, OWNER));
  assert.deepEqual([lair.booking(charge.id).status, lair.booking(charge.id).refund], ['cancelled', 'due']);
  const refunds = alerts.find((a) => a.subject === 'Refunds due: Called off');
  assert.ok(refunds, alerts.map((a) => a.subject).join(', '));
});

test('GM pays (round 21): a price change on the session leaves a seat the GM pays for at $0', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  const kais = await seat(id, KAI, 'Kai');
  ok(await cover(id, mias.ref, RANGI));
  // what the session's seat price update does to its unpaid seats (src/lair.js and src/admin.js)
  lair.write("UPDATE bookings SET amount = ? * people, updated_at = ? WHERE game_id = ? AND kind = 'gm-seat' AND paid = 0 AND covered_by IS NULL AND status IN ('held', 'confirmed', 'seated')", 2000, Date.now(), id);
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(kais.id).amount], [0, 2000]);
});

test('GM pays (round 21): the 10-minute run puts a charge in step with a seat changed some other way', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  ok(await cover(id, mias.ref, RANGI));
  lair.sql.exec("UPDATE bookings SET status = 'cancelled' WHERE id = ?", mias.id);
  assert.equal(coverRow(mias.id).status, 'confirmed');
  assert.equal(lair.coverUpkeep(Date.now()), 1);
  assert.equal(coverRow(mias.id).status, 'cancelled');
  assert.equal(lair.coverUpkeep(Date.now()), 0);
  lair.sql.exec("UPDATE bookings SET status = 'confirmed' WHERE id = ?", mias.id);
  assert.equal(lair.coverUpkeep(Date.now()), 1);
  assert.equal(coverRow(mias.id).status, 'confirmed');
  // a weekly regular's seats freed by staff: their charges go too
  const gone = lair.endRegular('sr_none', MIA, { forThem: true, rules: lair.rulesCache, now: Date.now() });
  assert.deepEqual(gone.seats, []);
});

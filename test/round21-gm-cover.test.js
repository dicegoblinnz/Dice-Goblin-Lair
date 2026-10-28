// Round 21, part 2: a GM pays for one of their players (contract v21-gm-cover). Mo (26 Oct 2026): "have the option for
// the gm to pay for someone else if they wish from one of their players. Paying the full $10 for Thier time and they
// don't get store credit for them playing." Then "Both" (the website and the counter) and "Until the player has paid".
// After its review: the charge follows the seat whatever changes it, the player paying ends the GM's offer, and like any
// seat it's locked in 24 hours before (the GM can't stop paying, the player can't cancel online). Mo, 27 Oct 2026: "The
// player who cancels within 24 hours gets it on Thier own tab and the gm can always send them credit to get rid of it.
// But they get charged the full $15": a no-show pays for their own seat, and the GM pays nothing for it.
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS, TAB_WORDS } from '../src/core.js';
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
const TAB_LOCKED = TAB_WORDS.locked(24);

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
    locked: W.locked,
    seatLocked: W.seatLocked,
    nothingBack: "There's nothing to give back on that one: what the GM has paid isn't more than it costs.",
    chargeGone: "That charge isn't on any more (the GM stopped paying, or the seat went), so there's nothing to pay for it.",
    chargeFollows: "A GM's charge goes where the player's seat goes, so move the session or the seat instead.",
    coveredSeat: "The GM pays for this seat, so there's nothing for the player to pay. If they're paying for it themselves, stop the GM paying first.",
    gmChanged: W.gmChanged,
    stopFirst: 'To stop paying for them, tap "Stop paying" on the session.',
    title: W.title,
  });
  assert.equal(W.locked(24), "It's less than 24 hours away, so it's locked in: you pay for this seat if they come, and if they don't, it's on their own tab. Ask staff if something's come up.");
  assert.equal(W.seatLocked(24), "It's less than 24 hours away, so it can't be cancelled online now. Your GM pays for your seat if you come. If you can't make it, the full price goes on your tab, so have a chat with us at the counter or give us a call.");
  assert.equal(W.gmChanged('Curse of Strahd', 'Tue 27 Oct, 6pm', 'Rangi', '$15.00', 'Mon 26 Oct, 6pm'),
    "Heads up: Curse of Strahd on Tue 27 Oct, 6pm has a new GM, so Rangi isn't paying for your seat any more. It's $15.00 on your tab. Can't make it? Cancel it in My Lair by Mon 26 Oct, 6pm.");
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
  assert.deepEqual(owed.map((r) => [r.kind, r.due, r.owed, r.line.title, r.line.price]), [['gm-cover', 1000, true, `Owed: Paying for Mia's seat: Rangi's one-shot (Tue 27 Oct, ${owed[0].ref})`, '10.00']]);
  // but he can't stop paying now: it's locked in (staff can)
  assert.equal(said(await uncover(id, mias.ref, RANGI)), `403 ${W.locked(24)}`);
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

test('GM pays (round 21): the charge follows the seat: gone when the player cancels in time, back when the seat is; a no-show pays for their own', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  ok(await cover(id, mias.ref, RANGI));
  const charge = coverRow(mias.id);
  // Mia cancels from My Lair, more than 24 hours before
  ok(await update(mias.id, { status: 'cancelled' }, MIA));
  assert.deepEqual([lair.booking(mias.id).status, lair.booking(charge.id).status], ['cancelled', 'cancelled']);
  assert.deepEqual((await me(RANGI)).covers, []);
  // staff put her back: so is the charge
  ok(await update(mias.id, { status: 'confirmed' }));
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(charge.id).status], [0, 'confirmed']);
  // a no-show (Mo, 27 Oct 2026): like any seat, it's still paid for, but by Mia: the full $15 on her own tab, and
  // nothing for Rangi
  nowIs(at('2026-10-27', 19));
  ok(await update(mias.id, { status: 'noshow' }));
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(mias.id).coveredBy, lair.booking(charge.id).status], [1500, RANGI, 'cancelled']);
  nowIs(at('2026-10-28', 12));
  assert.deepEqual(lair.owedRows(MIA, lair.rulesCache, Date.now()).map((r) => [r.id, r.due]), [[mias.id, 1500]]);
  assert.deepEqual(lair.owedRows(RANGI, lair.rulesCache, Date.now()), []);
  // marked a no-show by mistake: put back, it's $0 for her and Rangi's $10 again
  ok(await update(mias.id, { status: 'done' }));
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(charge.id).status], [0, 'confirmed']);
  assert.deepEqual(lair.owedRows(MIA, lair.rulesCache, Date.now()), []);
  assert.deepEqual(lair.owedRows(RANGI, lair.rulesCache, Date.now()).map((r) => [r.id, r.due]), [[charge.id, 1000]]);
  // staff taking the seat off (cancelled) takes the charge off too, as it would a player's seat
  ok(await update(mias.id, { status: 'cancelled' }));
  assert.deepEqual(lair.owedRows(RANGI, lair.rulesCache, Date.now()), []);
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
  assert.equal(alerts[0].intro, "Rangi Hohaia has paid $10.00 for Mia's seat at Rangi's one-shot, Tuesday, 27 October at 6:00 pm to 10:00 pm, but Mia's seat was taken off, so Rangi doesn't pay for it. Give Rangi back $10.00 (refund it, or put it on their store credit), then mark it refunded.");
  assert.deepEqual([after.refundAmount, ok(await call('GET', `floor?from=${at('2026-10-24', 0)}&to=${at('2026-11-20', 0)}`, null, OWNER)).bookings.find((b) => b.id === charge.id).refundAmount], [1000, 1000]);
  // a paid charge can't be stopped by the GM; staff can, and what he paid is a refund due
  const kais = await seat(id, KAI, 'Kai');
  ok(await cover(id, kais.ref, RANGI));
  const kaiCharge = coverRow(kais.id);
  ok(await update(kaiCharge.id, { paid: true }));
  assert.equal(said(await uncover(id, kais.ref, RANGI)), `409 ${W.coverPaid}`);
  alerts = [];
  ok(await uncover(id, kais.ref, OWNER));
  assert.deepEqual([lair.booking(kais.id).amount, lair.booking(kais.id).coveredBy, lair.booking(kaiCharge.id).status, lair.booking(kaiCharge.id).refund], [1500, undefined, 'cancelled', 'due']);
  assert.deepEqual(alerts.map((a) => a.subject), [`Refund due: ${kaiCharge.ref}`]);
  assert.match(alerts[0].intro, /but staff stopped Rangi paying for it\. Give Rangi back \$10\.00/);
  // My Lair shows Rangi both, as money coming back to him
  const back = (await me(RANGI)).covers.map((c) => [c.ref, c.status, c.refund, c.refundAmount, c.due, c.owed]);
  assert.deepEqual(back, [[charge.ref, 'cancelled', 'due', 1000, 0, false], [kaiCharge.ref, 'cancelled', 'due', 1000, 0, false]]);
  // once he's refunded, they're gone from the list: refunded is money back, so nothing's paid on it now
  ok(await update(charge.id, { refunded: true }));
  assert.deepEqual((await me(RANGI)).covers.map((c) => c.ref), [kaiCharge.ref]);
  const refunded = lair.booking(charge.id);
  assert.deepEqual([refunded.refund, refunded.refundAmount, refunded.paidAmount], ['done', 1000, 0]);
  assert.deepEqual(lair.sql.exec("SELECT amount FROM payments WHERE booking_id = ? AND order_id = 'refund'", charge.id).toArray().map((p) => p.amount), [-1000]);
  assert.deepEqual(lair.paymentsOf('booking', charge.id), [], 'money given back is not a payment staff see');
  assert.equal(said(await update(charge.id, { refunded: true })), `409 ${W.nothingBack}`);
  // Mia's seat (taken off, the charge gone with it): staff can still put the seat's price back
  ok(await uncover(id, mias.ref, OWNER));
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(mias.id).coveredBy], [1500, undefined]);
});

test('GM pays (round 21): stop paying: the GM until it\'s locked in (24 hours before), staff any time; the seat costs a seat\'s price', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia', { people: 2 });
  ok(await cover(id, mias.ref, RANGI));
  // staff change the seat's people: still $0 for them, and the GM's charge follows
  ok(await update(mias.id, { people: 3 }));
  assert.deepEqual([lair.booking(mias.id).amount, coverRow(mias.id).amount, coverRow(mias.id).people], [0, 3000, 3]);
  const stopped = ok(await uncover(id, mias.ref, RANGI));
  assert.deepEqual([stopped.cover, stopped.seat.covered, stopped.seat.coverable], [null, false, true]);
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(mias.id).coveredBy, lair.booking(mias.id).coverWas], [4500, undefined, undefined]);
  assert.equal(lair.coverOf(mias.id).status, 'cancelled');
  assert.equal(said(await uncover(id, mias.ref, RANGI)), `409 ${W.notCovered}`);
  // again, then it's 24 hours to go (Monday 6pm): locked in, so only staff can stop it now
  ok(await cover(id, mias.ref, RANGI));
  nowIs(at('2026-10-26', 17, 59));
  assert.equal((await gameOn(id, RANGI)).players.find((p) => p.ref === mias.ref).coverLocked, false);
  nowIs(at('2026-10-26', 18));
  assert.equal((await gameOn(id, RANGI)).players.find((p) => p.ref === mias.ref).coverLocked, true);
  assert.equal(said(await uncover(id, mias.ref, RANGI)), `403 ${W.locked(24)}`);
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
  // free: nothing for the GM to pay while it is, but his offer stays
  assert.deepEqual([coverRow(mias.id).status, coverRow(kais.id).status], ['cancelled', 'cancelled']);
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(mias.id).coveredBy], [0, RANGI]);
  assert.deepEqual((await me(RANGI)).covers, []);
  // back to a price (more than 24 hours before): the GM pays for them again, and they still pay nothing
  ok(await call('POST', `games/${id}/free`, { free: false }, OWNER));
  assert.deepEqual([lair.booking(mias.id).amount, coverRow(mias.id).status, coverRow(mias.id).amount], [0, 'confirmed', 1000]);
  assert.deepEqual([lair.booking(kais.id).amount, coverRow(kais.id).status], [0, 'confirmed']);
  // free again, and priced inside the 24 hours: like any seat booked while it was free, it stays free (nobody pays)
  ok(await call('POST', `games/${id}/free`, { free: true }, OWNER));
  nowIs(at('2026-10-27', 9));
  const late = ok(await call('POST', `games/${id}/free`, { free: false }, OWNER));
  assert.equal(late.stayFree, 2);
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(mias.id).coveredBy, coverRow(mias.id).status], [0, undefined, 'cancelled']);
  nowIs(NOW);
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

test('GM pays (round 21): a price change on the session leaves a seat the GM pays for at $0, and his unpaid charge follows the price', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  const kais = await seat(id, KAI, 'Kai');
  ok(await cover(id, mias.ref, RANGI));
  // what the session's seat price update does to its unpaid seats (src/lair.js and src/admin.js)
  lair.write("UPDATE bookings SET amount = ? * people, updated_at = ? WHERE game_id = ? AND kind = 'gm-seat' AND paid = 0 AND covered_by IS NULL AND status IN ('held', 'confirmed', 'seated')", 2000, Date.now(), id);
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(kais.id).amount], [0, 2000]);
  // staff make the GM fee $10: seats are $20, and the GM's part is still the table part, $10
  ok(await call('POST', `games/${id}/edit`, { gmFee: 1000 }, OWNER));
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(kais.id).amount, coverRow(mias.id).amount], [0, 2000, 1000]);
  // the GM's own charge follows a change to the table part (a pricier room: here, the table price itself)
  lair.write('UPDATE games SET seat_price = 2500 WHERE id = ?', id);
  lair.syncCoversOn(id, Date.now(), lair.rulesCache);
  assert.equal(coverRow(mias.id).amount, 1500);
  // once it's paid, it keeps the price it was paid at
  ok(await update(coverRow(mias.id).id, { paid: true }));
  lair.write('UPDATE games SET seat_price = 3000 WHERE id = ?', id);
  lair.syncCoversOn(id, Date.now(), lair.rulesCache);
  assert.deepEqual([coverRow(mias.id).amount, coverRow(mias.id).paid], [1500, true]);
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
  assert.equal(lair.coverUpkeep(Date.now()), 0);
  // a seat's people changed some other way: the charge follows; a seat given a price some other way: back to $0
  lair.sql.exec('UPDATE bookings SET people = 2, amount = 3000 WHERE id = ?', mias.id);
  assert.equal(lair.coverUpkeep(Date.now()), 1);
  assert.deepEqual([lair.booking(mias.id).amount, coverRow(mias.id).people, coverRow(mias.id).amount], [0, 2, 2000]);
  // a weekly regular's seats freed by staff: their charges go too
  const gone = lair.endRegular('sr_none', MIA, { forThem: true, rules: lair.rulesCache, now: Date.now() });
  assert.deepEqual(gone.seats, []);
});

/* ---------------- after the review (26 Oct 2026): each finding, fixed ---------------- */

test('GM pays, review 1: a seat put back after the GM had paid: no refund now (staff hear), or owed again once he\'s been refunded', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  ok(await cover(id, mias.ref, RANGI));
  const charge = coverRow(mias.id);
  ok(await update(charge.id, { paid: true }));
  // a no-show by mistake: she'd pay for her own seat, so what Rangi paid is a refund due (staff hear); put back, it's
  // his again: no refund now (staff hear)
  nowIs(at('2026-10-27', 18, 30));
  ok(await update(mias.id, { status: 'noshow' }));
  assert.deepEqual([lair.booking(charge.id).status, lair.booking(charge.id).refund, lair.booking(charge.id).refundAmount], ['cancelled', 'due', 1000]);
  assert.deepEqual(alerts.map((a) => a.subject), [`Refund due: ${charge.ref}`]);
  assert.equal(alerts[0].intro, "Rangi Hohaia has paid $10.00 for Mia's seat at Rangi's one-shot, Tuesday, 27 October at 6:00 pm to 10:00 pm, but Mia didn't come, so they pay for their own seat. Give Rangi back $10.00 (refund it, or put it on their store credit), then mark it refunded.");
  ok(await update(mias.id, { status: 'seated' }));
  assert.deepEqual([lair.booking(charge.id).status, lair.booking(charge.id).refund, lair.booking(charge.id).paid, lair.booking(mias.id).amount], ['confirmed', null, true, 0]);
  assert.deepEqual(alerts.map((a) => a.subject), [`Refund due: ${charge.ref}`, `No refund now: ${charge.ref}`]);
  alerts = [];
  // taken off by mistake: a refund due; put back: no refund now, and staff hear
  ok(await update(mias.id, { status: 'cancelled' }));
  assert.deepEqual([lair.booking(charge.id).status, lair.booking(charge.id).refund], ['cancelled', 'due']);
  ok(await update(mias.id, { status: 'seated' }));
  assert.deepEqual([lair.booking(charge.id).status, lair.booking(charge.id).refund, lair.booking(charge.id).paid], ['confirmed', null, true]);
  assert.deepEqual(alerts.map((a) => a.subject), [`Refund due: ${charge.ref}`, `No refund now: ${charge.ref}`]);
  assert.equal(alerts[1].intro, "There's nothing to give back to Rangi for Mia's seat at Rangi's one-shot, Tuesday, 27 October at 6:00 pm to 10:00 pm now: Mia's seat is on, and it costs $10.00, and the $10.00 they paid stays paid. Don't refund it. (If you already have, they owe it again: sort it out with them.)");
  // taken off again, and this time staff refund him; then she's put back: the same charge, owed again
  ok(await update(mias.id, { status: 'cancelled' }));
  ok(await update(charge.id, { refunded: true }));
  ok(await update(mias.id, { status: 'seated' }));
  const again = coverRow(mias.id);
  assert.equal(again.id, charge.id);
  assert.deepEqual([again.status, again.amount, again.paidAmount, again.paid, again.refund, again.customerId], ['confirmed', 1000, 0, false, null, RANGI]);
  // the board says the GM pays for her, and covering again is "already"; the next day he owes it
  assert.equal((await gameOn(id, RANGI)).players.find((p) => p.ref === mias.ref).covered, true);
  assert.equal(said(await cover(id, mias.ref, RANGI)), `409 ${W.already('Mia')}`);
  nowIs(at('2026-10-28', 12));
  assert.deepEqual(lair.owedRows(RANGI, lair.rulesCache, Date.now()).map((r) => [r.id, r.due]), [[again.id, 1000]]);
  assert.deepEqual(lair.owedRows(MIA, lair.rulesCache, Date.now()), []);
});

test('GM pays, review 2: the player paying for their seat ends the GM\'s offer: no $25 for one seat, and the GM gets his credit for it', async () => {
  shopifyOn = true;
  const credited = [];
  lair.shopify.creditCustomer = async (customerId, cents) => {
    credited.push([customerId, cents]);
    return { amount: { amount: (cents / 100).toFixed(2) } };
  };
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  // Mia's $15 line was in the cart before the GM paid for her; it's paid after
  const miaLine = { price: '15.00', properties: { _booking: mias.ref } };
  ok(await pos('cover', { gameId: id, ref: mias.ref }));
  const charge = coverRow(mias.id);
  const paid = ok(await internal('orders-paid', posOrder(3101, [miaLine])));
  assert.deepEqual(paid.updated, [mias.ref]);
  const seatNow = lair.booking(mias.id);
  assert.deepEqual([seatNow.amount, seatNow.paidAmount, seatNow.paid, seatNow.coveredBy], [1500, 1500, true, undefined]);
  // the GM's charge goes: he hadn't paid it, so nothing to give back
  assert.deepEqual([lair.booking(charge.id).status, lair.booking(charge.id).refund, alerts.length], ['cancelled', null, 0]);
  // Mia paid, so the GM gets his $5 for her seat
  nowIs(at('2026-10-27', 22, 10));
  assert.equal((await lair.autoGmCredit(Date.now())).credited, 1);
  assert.deepEqual(credited, [[RANGI, 500]]);

  // both lines on one order, either way round: Mia's seat is paid, and Rangi's $10 is a refund due (staff hear)
  nowIs(NOW);
  for (const [n, title, order] of [[3201, 'GM first', 'gm'], [3202, 'Seat first', 'seat']]) {
    alerts = [];
    const other = await list({ tables: [n === 3201 ? 'B2' : 'B3'], title });
    const kais = await seat(other, KAI, 'Kai');
    const kaiLine = { price: '15.00', properties: { _booking: kais.ref } };
    ok(await cover(other, kais.ref, RANGI));
    const kaiCharge = coverRow(kais.id);
    const gmLine = { price: '10.00', properties: { _booking: kaiCharge.ref } };
    ok(await internal('orders-paid', posOrder(n, order === 'gm' ? [gmLine, kaiLine] : [kaiLine, gmLine])));
    const k = lair.booking(kais.id);
    const c = lair.booking(kaiCharge.id);
    assert.deepEqual([k.amount, k.paidAmount, k.paid, k.coveredBy], [1500, 1500, true, undefined], title);
    assert.deepEqual([c.status, c.paidAmount, c.refund], ['cancelled', 1000, 'due'], title);
    assert.deepEqual(alerts.map((a) => a.subject), [`Refund due: ${kaiCharge.ref}`], title);
    assert.match(alerts[0].intro, /but Kai paid for their own seat too\. Give Rangi back \$10\.00/, title);
  }
});

test('GM pays, review 3: people on a seat the GM has paid for: more is more for him to pay; fewer is money back (staff hear)', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  ok(await cover(id, mias.ref, RANGI));
  const charge = coverRow(mias.id);
  ok(await update(charge.id, { paid: true }));
  // 1 to 3: the seat stays $0 for them, and Rangi's charge is $30 with $10 paid: $20 more for him
  ok(await update(mias.id, { people: 3 }));
  let c = lair.booking(charge.id);
  assert.deepEqual([lair.booking(mias.id).amount, c.people, c.amount, c.paidAmount, c.paid], [0, 3, 3000, 1000, false]);
  nowIs(at('2026-10-28', 12));
  assert.deepEqual(lair.owedRows(RANGI, lair.rulesCache, Date.now()).map((r) => [r.id, r.due]), [[charge.id, 2000]]);
  nowIs(NOW);
  // he pays the rest; then 3 to 1: $20 to give back, staff hear, and it's noted on the charge
  ok(await update(charge.id, { paid: true }));
  alerts = [];
  ok(await update(mias.id, { people: 1 }));
  c = lair.booking(charge.id);
  assert.deepEqual([c.people, c.amount, c.paidAmount, c.paid], [1, 1000, 3000, true]);
  assert.deepEqual(alerts.map((a) => a.subject), [`Refund due: ${charge.ref}`]);
  assert.match(alerts[0].intro, /Rangi Hohaia has paid \$30\.00 for Mia's seat at .*, but the seat is for 1 person now, so it costs \$10\.00\. Give Rangi back \$20\.00/);
  assert.deepEqual([c.refund, c.refundAmount], ['due', 2000]);
  // and the 10-minute run has nothing more to say
  assert.equal(lair.coverUpkeep(Date.now()), 0);
  assert.equal(alerts.length, 1);
});

test('GM pays, review 4: locked in 24 hours before, like any seat: the player can\'t cancel online, the GM can\'t stop, staff can', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  const kais = await seat(id, KAI, 'Kai');
  ok(await cover(id, mias.ref, RANGI));
  // Tuesday 5pm, an hour before: Kai's seat and Mia's (the GM pays) are both locked in
  nowIs(at('2026-10-27', 17));
  assert.equal(said(await update(kais.id, { status: 'cancelled' }, KAI)), `409 ${TAB_LOCKED}`);
  assert.equal(said(await update(mias.id, { status: 'cancelled' }, MIA)), `409 ${W.seatLocked(24)}`);
  assert.equal(said(await uncover(id, mias.ref, RANGI)), `403 ${W.locked(24)}`);
  // My Lair says so: Mia's seat is locked in, with nothing for her to pay; Rangi's charge is locked in too
  const mine = (await me(MIA)).seats.find((s) => s.id === mias.id);
  assert.deepEqual([mine.locked, mine.coveredByGm, mine.due], [true, true, 0]);
  assert.equal((await me(RANGI)).covers[0].locked, true);
  // she doesn't come (Mo, 27 Oct 2026): she pays for her own seat, the full $15 on her own tab, and Rangi pays nothing
  nowIs(at('2026-10-27', 18, 30));
  ok(await update(mias.id, { status: 'noshow' }));
  const missed = (await me(MIA)).seats.find((s) => s.id === mias.id);
  assert.deepEqual([missed.coveredByGm, missed.due, missed.amount], [undefined, 1500, 1500]);
  assert.deepEqual((await me(RANGI)).covers, []);
  nowIs(at('2026-10-28', 12));
  assert.deepEqual(lair.owedRows(RANGI, lair.rulesCache, Date.now()), []);
  assert.deepEqual(lair.owedRows(MIA, lair.rulesCache, Date.now()).map((r) => r.due), [1500]);
  // it's hers like any no-show: staff can mark it paid (and that ends Rangi's offer, as her paying always does)
  ok(await update(mias.id, { paid: true }));
  const settled = lair.booking(mias.id);
  assert.deepEqual([settled.coveredBy, settled.amount, settled.paid, settled.paidAmount], [undefined, 1500, true, 1500]);
  assert.deepEqual(lair.owedRows(MIA, lair.rulesCache, Date.now()), []);
  // the GM paying for a seat inside the 24 hours: it's locked in at once
  nowIs(at('2026-10-27', 9));
  const late = await list({ tables: ['B2'], start: at('2026-10-27', 18), end: at('2026-10-27', 21), title: 'Tonight' });
  nowIs(at('2026-10-27', 10));
  const rias = await seat(late, RIA, 'Ria');
  const done = ok(await cover(late, rias.ref, RANGI));
  assert.equal(done.cover.locked, true);
  assert.equal(said(await uncover(late, rias.ref, RANGI)), `403 ${W.locked(24)}`);
  assert.equal(said(await update(rias.id, { paid: true })), `409 ${W.coveredSeat}`);
  // Ria lets staff know she can't come after all: they stop the GM paying, and the seat's full price is hers, like any
  // locked-in seat (or they leave it, and mark her a no-show on the night: the same for her)
  ok(await uncover(late, rias.ref, OWNER));
  assert.deepEqual([lair.booking(rias.id).amount, lair.booking(rias.id).coveredBy, coverRow(rias.id).status], [1500, undefined, 'cancelled']);
});

test('GM pays, Mo\'s no-show rule (27 Oct 2026): the player pays the full price on their own tab, the GM nothing; they can pay it at the counter', async () => {
  shopifyOn = true;
  const credited = [];
  lair.shopify.creditCustomer = async (customerId, cents) => {
    credited.push([customerId, cents]);
    return { amount: { amount: (cents / 100).toFixed(2) } };
  };
  const id = await list();
  const mias = await seat(id, MIA, 'Mia', { people: 2 });
  ok(await cover(id, mias.ref, RANGI));
  const charge = coverRow(mias.id);
  assert.deepEqual([charge.amount, lair.booking(mias.id).amount], [2000, 0]);
  // she doesn't come: her seat for 2 is $30 on her own tab; Rangi's $20 goes (he hadn't paid, so nobody's told)
  nowIs(at('2026-10-27', 18, 30));
  ok(await update(mias.id, { status: 'noshow' }));
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(charge.id).status, lair.booking(charge.id).refund, alerts.length], [3000, 'cancelled', null, 0]);
  // the 10-minute run has nothing to change, and staff see it as hers to pay
  assert.equal(lair.coverUpkeep(Date.now()), 0);
  const shown = (await board(OWNER)).bookings.find((b) => b.id === mias.id);
  assert.deepEqual([shown.status, shown.amount, shown.due], ['noshow', 3000, 3000]);
  // the GM gets no GM credit for a seat nobody came to, the same as any no-show
  nowIs(at('2026-10-27', 22, 10));
  assert.equal(await lair.autoGmCredit(Date.now()), null, 'nothing for the GM credit run to decide');
  nowIs(at('2026-10-28', 12));
  assert.deepEqual(lair.owedRows(MIA, lair.rulesCache, Date.now()).map((r) => [r.id, r.due]), [[mias.id, 3000]]);
  assert.deepEqual(lair.owedRows(RANGI, lair.rulesCache, Date.now()), []);
  // she pays it at the counter (anyone can, Rangi too: it's her tab's line): paid, and Rangi's offer is done
  const paid = ok(await internal('orders-paid', posOrder(4101, [{ price: '30.00', properties: { _booking: mias.ref } }])));
  assert.deepEqual(paid.updated, [mias.ref]);
  const after = lair.booking(mias.id);
  assert.deepEqual([after.amount, after.paidAmount, after.paid, after.coveredBy], [3000, 3000, true, undefined]);
  assert.deepEqual([lair.booking(charge.id).status, lair.booking(charge.id).refund, alerts.length], ['cancelled', null, 0]);
  assert.deepEqual(lair.owedRows(MIA, lair.rulesCache, Date.now()), []);
  // and still no GM credit for it
  assert.equal(await lair.autoGmCredit(Date.now()), null);
  assert.deepEqual(credited, []);

  // a free session: a no-show has nothing to pay, and neither does the GM
  nowIs(NOW);
  const free = await list({ tables: ['B2'], title: 'Free night' });
  const kais = await seat(free, KAI, 'Kai');
  ok(await cover(free, kais.ref, RANGI));
  ok(await call('POST', `games/${free}/free`, { free: true }, OWNER));
  nowIs(at('2026-10-27', 18, 30));
  ok(await update(kais.id, { status: 'noshow' }));
  assert.deepEqual([lair.booking(kais.id).amount, coverRow(kais.id).status], [0, 'cancelled']);
  nowIs(at('2026-10-28', 12));
  assert.deepEqual(lair.owedRows(KAI, lair.rulesCache, Date.now()), []);
  assert.deepEqual(lair.owedRows(RANGI, lair.rulesCache, Date.now()), []);
  // taken off instead (staff letting a no-show off, as for any seat): nothing to pay for anyone
  nowIs(NOW);
  const third = await list({ tables: ['B3'], title: 'Third' });
  const rias = await seat(third, RIA, 'Ria');
  ok(await cover(third, rias.ref, RANGI));
  nowIs(at('2026-10-27', 18, 30));
  ok(await update(rias.id, { status: 'noshow' }));
  ok(await update(rias.id, { status: 'cancelled' }));
  nowIs(at('2026-10-28', 12));
  assert.deepEqual(lair.owedRows(RIA, lair.rulesCache, Date.now()), []);
  assert.deepEqual(lair.owedRows(RANGI, lair.rulesCache, Date.now()), []);
});

test('GM pays, review 5: a new GM: the old GM\'s offers end while they could stop them (a refund if paid); from 24 hours before they stay theirs', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  const kais = await seat(id, KAI, 'Kai');
  ok(await cover(id, mias.ref, RANGI));
  ok(await cover(id, kais.ref, RANGI));
  // Rangi has paid for Kai; more than 24 hours before, the session goes to Wiremu: both offers end
  ok(await update(coverRow(kais.id).id, { paid: true }));
  const toWiremu = { gmCustomerId: WIREMU, gmCustomerName: 'Wiremu', gm: 'Wiremu' };
  alerts = [];
  ok(await call('POST', `games/${id}/gm`, toWiremu, OWNER));
  // the seats cost their players $15 again; Rangi's paid $10 for Kai is a refund due (staff hear)
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(mias.id).coveredBy, coverRow(mias.id).status], [1500, undefined, 'cancelled']);
  assert.deepEqual([lair.booking(kais.id).amount, coverRow(kais.id).status, coverRow(kais.id).refund, coverRow(kais.id).refundAmount], [1500, 'cancelled', 'due', 1000]);
  assert.deepEqual(alerts.map((a) => a.subject), [`Refund due: ${coverRow(kais.id).ref}`]);
  assert.match(alerts[0].intro, /the session has another GM now, so Rangi doesn't pay for it/);
  assert.deepEqual((await me(RANGI)).covers.map((c) => [c.player, c.status, c.refund]), [['Kai', 'cancelled', 'due']]);
  // Wiremu can pay for her himself
  const theirs = ok(await cover(id, mias.ref, WIREMU));
  assert.equal(coverRow(mias.id).customerId, WIREMU);
  assert.equal(theirs.cover.amount, 1000);
  // inside the 24 hours, the session goes back to Rangi: Wiremu's offer is locked in, so it stays his (staff hear)
  nowIs(at('2026-10-27', 9));
  alerts = [];
  ok(await call('POST', `games/${id}/gm`, { gmCustomerId: RANGI, gmCustomerName: 'Rangi', gm: 'Rangi' }, OWNER));
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(mias.id).coveredBy, coverRow(mias.id).status, coverRow(mias.id).customerId], [0, WIREMU, 'confirmed', WIREMU]);
  assert.deepEqual(alerts.map((a) => a.subject), [`Still paying: ${lair.game(id).title}`]);
  assert.match(alerts[0].intro, /Wiremu was paying for a player's seat on it, and it's less than 24 hours away \(or it's started\), so that's locked in: Wiremu still pays for each player who comes\./);
  // Rangi's list says who pays for Mia; neither GM can stop it now (Wiremu: locked in; Rangi: not his), staff can
  const shown = (await gameOn(id, RANGI)).players.find((p) => p.ref === mias.ref);
  assert.deepEqual([shown.covered, shown.coverBy, shown.coverLocked], [true, 'Wiremu', true]);
  assert.equal(said(await uncover(id, mias.ref, RANGI)), NOT_YOURS);
  // the session's over and Wiremu hasn't paid: it's his to pay, not dropped
  nowIs(at('2026-10-28', 12));
  assert.deepEqual(lair.owedRows(WIREMU, lair.rulesCache, Date.now()).map((r) => r.due), [1000]);
  assert.deepEqual(lair.owedRows(MIA, lair.rulesCache, Date.now()), []);
  // a new GM after the session doesn't drop it either
  ok(await call('POST', `games/${id}/gm`, toWiremu, OWNER));
  ok(await call('POST', `games/${id}/gm`, { gmCustomerId: RANGI, gmCustomerName: 'Rangi', gm: 'Rangi' }, OWNER));
  assert.deepEqual(lair.owedRows(WIREMU, lair.rulesCache, Date.now()).map((r) => r.due), [1000]);
});

test('GM pays, review 6: a covered seat taken off, the session made free and priced again, then the seat put back: the GM pays for it', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  ok(await cover(id, mias.ref, RANGI));
  ok(await update(mias.id, { status: 'cancelled' }, MIA));
  ok(await call('POST', `games/${id}/free`, { free: true }, OWNER));
  ok(await call('POST', `games/${id}/free`, { free: false }, OWNER));
  ok(await update(mias.id, { status: 'confirmed' }));
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(mias.id).coveredBy, coverRow(mias.id).status, coverRow(mias.id).amount], [0, RANGI, 'confirmed', 1000]);
  nowIs(at('2026-10-28', 12));
  assert.deepEqual(lair.owedRows(MIA, lair.rulesCache, Date.now()), []);
  assert.deepEqual(lair.owedRows(RANGI, lair.rulesCache, Date.now()).map((r) => r.due), [1000]);
});

test('GM pays, review 7: stopping puts back what a seat costs now, not what it cost before', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  const kais = await seat(id, KAI, 'Kai');
  ok(await cover(id, mias.ref, RANGI));
  ok(await call('POST', `games/${id}/edit`, { gmFee: 0 }, OWNER));
  assert.equal(lair.booking(kais.id).amount, 1000);
  ok(await uncover(id, mias.ref, RANGI));
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(kais.id).amount], [1000, 1000]);
});

test('GM pays, review 8: the GM\'s charge never takes a table, through a new time and a table move', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  ok(await cover(id, mias.ref, RANGI));
  ok(await call('POST', `games/${id}/edit`, { start: at('2026-10-27', 19), end: at('2026-10-27', 23) }, OWNER));
  let c = coverRow(mias.id);
  assert.deepEqual([c.tables, c.start, c.end], [[], at('2026-10-27', 19), at('2026-10-27', 23)]);
  const gmRow = lair.gameBookings(id).find((b) => b.kind === 'gm');
  ok(await update(gmRow.id, { tables: ['B3'] }));
  c = coverRow(mias.id);
  assert.deepEqual([lair.game(id).tables, c.tables], [['B3'], []]);
  // B1 is free for anyone now
  const booked = await call('POST', 'bookings', {
    kind: 'table', tables: ['B1'], start: at('2026-10-27', 19), end: at('2026-10-27', 21), people: 2, name: 'Kai', email: 'kai@example.com', phone: '021 555 0100',
  }, KAI);
  assert.equal(booked.status, 200, booked.data.error);
});

test('GM pays, review 9: a GM paying for six players can still book a table (the 6-a-email limit is for their own bookings)', async () => {
  const a = await list({ title: 'A' });
  const b = await list({ tables: ['B2'], title: 'B' });
  for (const [g, c, n] of [[a, MIA, 'Mia'], [a, KAI, 'Kai'], [a, RIA, 'Ria'], [b, MIA, 'Mia'], [b, KAI, 'Kai'], [b, RIA, 'Ria']]) {
    ok(await cover(g, (await seat(g, c, n)).ref, RANGI));
  }
  const booked = await call('POST', 'bookings', {
    kind: 'table', tables: ['T5'], start: at('2026-10-29', 18), end: at('2026-10-29', 20), people: 2, name: 'Rangi', email: 'rangi@example.com', phone: '021 555 0100',
  }, RANGI);
  assert.equal(booked.status, 200, booked.data.error);
});

test('GM pays, review 10: the GM\'s charge scanned at the counter on its own code gives its line to pay', async () => {
  const id = await list({ start: at('2026-10-25', 18), end: at('2026-10-25', 21) });
  const mias = await seat(id, MIA, 'Mia');
  ok(await cover(id, mias.ref, RANGI));
  const charge = coverRow(mias.id);
  nowIs(at('2026-10-25', 17, 30));
  const scanned = ok(await pos('checkin', { code: charge.ref }));
  assert.deepEqual([scanned.checkedIn, scanned.reason], [false, 'cover']);
  assert.deepEqual(scanned.lines.map((l) => [l.title, l.price, l.properties._booking]), [[`Paying for Mia's seat: Rangi's one-shot (${charge.ref})`, '10.00', charge.ref]]);
  // once it's gone (staff stopped it), there's no line
  ok(await uncover(id, mias.ref, OWNER));
  const gone = ok(await pos('checkin', { code: charge.ref }));
  assert.deepEqual(gone.lines, []);
});

/* ---------------- after the second review (27 Oct 2026): money back to a GM is what they've paid, net ---------------- */

/** What's due back to Rangi on a charge, as stored and as My Lair shows it */
const backOn = async (chargeId) => {
  const c = lair.booking(chargeId);
  const mine = (await me(RANGI)).covers.find((x) => x.id === chargeId);
  return { refund: c.refund ?? null, amount: c.refundAmount ?? null, paid: c.paidAmount || 0, shown: mine ? mine.refundAmount ?? null : null };
};

test('GM pays, review 2.1: a refund of part of what the GM paid counts: later changes go by what they\'ve paid, net', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia', { people: 3 });
  ok(await cover(id, mias.ref, RANGI));
  const charge = coverRow(mias.id);
  ok(await update(charge.id, { paid: true }));
  // 3 people to 1: $20 to give back, flagged
  ok(await update(mias.id, { people: 1 }));
  assert.deepEqual(await backOn(charge.id), { refund: 'due', amount: 2000, paid: 3000, shown: 2000 });
  // staff give the $20 back and mark it: it's money back, so he's paid $10 net, and nothing more is due
  ok(await update(charge.id, { refunded: true }));
  assert.deepEqual(await backOn(charge.id), { refund: 'done', amount: 2000, paid: 1000, shown: null });
  assert.equal(lair.booking(charge.id).paid, true);
  // Mia cancels in time: the $10 he's still paid is due back, not $30 (staff hear $10)
  alerts = [];
  ok(await update(mias.id, { status: 'cancelled' }, MIA));
  assert.deepEqual(await backOn(charge.id), { refund: 'due', amount: 1000, paid: 1000, shown: 1000 });
  assert.match(alerts[0].intro, /has paid \$10\.00 for Mia's seat .* Give Rangi back \$10\.00/);
  // put back before he's refunded: nothing due back, and he isn't charged again
  alerts = [];
  ok(await update(mias.id, { status: 'confirmed' }));
  assert.deepEqual(await backOn(charge.id), { refund: null, amount: null, paid: 1000, shown: null });
  assert.deepEqual([lair.booking(charge.id).paid, lair.booking(charge.id).amount], [true, 1000]);
  assert.deepEqual(alerts.map((a) => a.subject), [`No refund now: ${charge.ref}`]);
  // back up to 3 people: $30, with $10 paid: $20 for him to pay, not counted as paid
  ok(await update(mias.id, { people: 3 }));
  const c = lair.booking(charge.id);
  assert.deepEqual([c.amount, c.paidAmount, c.paid, (await me(RANGI)).covers[0].due], [3000, 1000, false, 2000]);
  // and undoing a refund mark puts it back as it was
  const kais = await seat(id, KAI, 'Kai');
  ok(await cover(id, kais.ref, RANGI));
  const kc = coverRow(kais.id);
  ok(await update(kc.id, { paid: true }));
  ok(await update(kais.id, { status: 'cancelled' }));
  ok(await update(kc.id, { refunded: true }));
  assert.deepEqual(await backOn(kc.id), { refund: 'done', amount: 1000, paid: 0, shown: null });
  ok(await update(kc.id, { refunded: false }));
  assert.deepEqual(await backOn(kc.id), { refund: 'due', amount: 1000, paid: 1000, shown: 1000 });
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM payments WHERE booking_id = ?", kc.id).one().n, 0);
});

test('GM pays, review 2.1: given back without marking it, then more changes: staff hear the total to give back, in all', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia', { people: 3 });
  ok(await cover(id, mias.ref, RANGI));
  const charge = coverRow(mias.id);
  ok(await update(charge.id, { paid: true }));
  ok(await update(mias.id, { people: 1 }));
  alerts = [];
  ok(await update(mias.id, { status: 'cancelled' }, MIA));
  assert.deepEqual(await backOn(charge.id), { refund: 'due', amount: 3000, paid: 3000, shown: 3000 });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].intro, /What to give back to Rangi for Mia's seat at .* is \$30\.00 now, not \$20\.00: .* That's \$30\.00 in all: if you've given some back already without marking it, give back the rest\. Then mark it refunded\./);
});

test('GM pays, review 2.2: money paid on a charge that\'s gone is always flagged, once an order, whatever the order of its lines', async () => {
  shopifyOn = true;
  const id = await list();
  // a later payment on a part-paid charge that's gone: staff hear the new total
  const mias = await seat(id, MIA, 'Mia');
  ok(await cover(id, mias.ref, RANGI));
  const charge = coverRow(mias.id);
  const half = { price: '5.00', properties: { _booking: charge.ref } };
  ok(await internal('orders-paid', posOrder(4101, [half])));
  ok(await update(mias.id, { status: 'cancelled' }, MIA));
  assert.deepEqual(await backOn(charge.id), { refund: 'due', amount: 500, paid: 500, shown: 500 });
  alerts = [];
  ok(await internal('orders-paid', posOrder(4102, [half])));
  assert.deepEqual(await backOn(charge.id), { refund: 'due', amount: 1000, paid: 1000, shown: 1000 });
  assert.deepEqual(alerts.map((a) => a.subject), [`Refund due: ${charge.ref}`]);
  assert.match(alerts[0].intro, /is \$10\.00 now, not \$5\.00/);
  // the same order sent again adds nothing and says nothing
  alerts = [];
  ok(await internal('orders-paid', posOrder(4102, [half])));
  assert.deepEqual([await backOn(charge.id), alerts.length], [{ refund: 'due', amount: 1000, paid: 1000, shown: 1000 }, 0]);
  // a $0 line on a gone charge: nothing to say
  ok(await internal('orders-paid', posOrder(4103, [{ price: '0.00', properties: { _booking: charge.ref } }])));
  assert.equal(alerts.length, 0);
  // both lines on one order, the GM having paid $5 already: one email, $10, either way round
  for (const [n, order] of [[4201, 'seat'], [4202, 'gm']]) {
    alerts = [];
    const other = await list({ tables: [n === 4201 ? 'B2' : 'B3'], title: `Order ${order} first` });
    const kais = await seat(other, KAI, 'Kai');
    ok(await cover(other, kais.ref, RANGI));
    const kc = coverRow(kais.id);
    ok(await internal('orders-paid', posOrder(n * 10, [{ price: '5.00', properties: { _booking: kc.ref } }])));
    const seatLine = { price: '15.00', properties: { _booking: kais.ref } };
    const gmLine = { price: '5.00', properties: { _booking: kc.ref } };
    ok(await internal('orders-paid', posOrder(n, order === 'seat' ? [seatLine, gmLine] : [gmLine, seatLine])));
    assert.deepEqual(await backOn(kc.id), { refund: 'due', amount: 1000, paid: 1000, shown: 1000 }, order);
    assert.deepEqual(alerts.map((a) => a.subject), [`Refund due: ${kc.ref}`], order);
    assert.match(alerts[0].intro, /Give Rangi back \$10\.00/, order);
  }
  // marking a gone charge paid by hand (a page left open): refused
  const rias = await seat(id, RIA, 'Ria');
  ok(await cover(id, rias.ref, RANGI));
  const rc = coverRow(rias.id);
  ok(await update(rias.id, { status: 'cancelled' }, RIA));
  assert.equal(said(await update(rc.id, { paid: true })), `409 ${W.chargeGone}`);
});

test('GM pays, review 2.3: the staff view of a part-paid charge: what\'s left to pay, and refunds at what was paid', async () => {
  shopifyOn = true;
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  ok(await cover(id, mias.ref, RANGI));
  const charge = coverRow(mias.id);
  ok(await update(charge.id, { paid: true }));
  ok(await update(mias.id, { people: 3 }));
  const staffView = (await board(OWNER)).bookings.find((b) => b.id === charge.id);
  assert.deepEqual([staffView.amount, staffView.paidAmount, staffView.due, staffView.paid], [3000, 1000, 2000, false]);
  // a player's seat refunded at what they paid (a split bill part paid), not its price
  const kais = await seat(id, KAI, 'Kai');
  ok(await internal('orders-paid', posOrder(4301, [{ price: '7.50', properties: { _booking: kais.ref, _share: '1' } }])));
  ok(await call('POST', `games/${id}/update`, { status: 'cancelled' }, OWNER));
  const kai = (await board(OWNER)).bookings.find((b) => b.id === kais.id);
  assert.deepEqual([kai.refund, kai.refundAmount, kai.amount], ['due', 750, 1500]);
});

test('GM pays, review 2.7 to 2.9: a charge never moves on its own; a GM\'s monthly limit counts, as for booking; a covered seat isn\'t marked paid', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  ok(await cover(id, mias.ref, RANGI));
  const charge = coverRow(mias.id);
  assert.equal(said(await update(charge.id, { tables: ['T7'] })), `409 ${W.chargeFollows}`);
  assert.equal(said(await update(charge.id, { end: at('2026-10-27', 23) })), `409 ${W.chargeFollows}`);
  assert.deepEqual([coverRow(mias.id).tables, lair.game(id).tables], [[], ['B1']]);
  assert.equal(said(await update(mias.id, { paid: true })), `409 ${W.coveredSeat}`);
  // Rangi on a monthly account with a $5 limit: paying $10 for a player would go over it, as booking $10 would (staff
  // at the counter can still say the GM pays)
  ok(await call('POST', `members/${RANGI}/account`, { billing: 'monthly', creditLimit: 500 }, OWNER));
  const kais = await seat(id, KAI, 'Kai');
  const over = await cover(id, kais.ref, RANGI);
  assert.equal(over.status, 409);
  assert.equal(over.data.error, 'That would take your Lair account over its $5 limit ($5 left). Pay your bill online or at the counter, then pay for them again.');
  ok(await cover(id, kais.ref, OWNER));
});

test('GM pays, review 2.9: a free session shows no GM paying; Session done says when the GM pays for every seat; a paid free seat is flagged', async () => {
  shopifyOn = true;
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  ok(await cover(id, mias.ref, RANGI));
  ok(await call('POST', `games/${id}/free`, { free: true }, OWNER));
  const shown = (await gameOn(id, RANGI)).players.find((p) => p.ref === mias.ref);
  assert.deepEqual([shown.covered, shown.coverable], [false, false]);
  assert.equal((await me(MIA)).seats.find((x) => x.id === mias.id).coveredByGm, undefined);
  // a counter line made before it was free, paid after: staff hear
  alerts = [];
  ok(await internal('orders-paid', posOrder(4401, [{ price: '15.00', properties: { _booking: mias.ref } }])));
  assert.deepEqual(alerts.map((a) => a.subject), [`Paid for a free seat: ${mias.ref}`]);
  // a session with a price whose GM pays for every seat: Session done says there's no credit to come
  const other = await list({ tables: ['B2'], title: 'All paid for' });
  const kais = await seat(other, KAI, 'Kai');
  ok(await cover(other, kais.ref, RANGI));
  nowIs(at('2026-10-27', 22, 10));
  const tapped = ok(await call('POST', `games/${other}/credit`, {}, OWNER));
  assert.deepEqual([tapped.status, tapped.note], ['none', "The GM pays for their players' seats on this session, so there's no GM credit to add."]);
});

/* ---------------- after the third review (27 Oct 2026) ---------------- */

test('GM pays, review 3.1: a cancelled session works out what\'s due back to the GM on each charge, and the email says it', async () => {
  shopifyOn = true;
  // fully paid; part paid; part refunded already; $20 due back on a live charge; each on its own session
  const make = async (tables, title, people = 1) => {
    const id = await list({ tables, title });
    const s = await seat(id, MIA, 'Mia', { people });
    ok(await cover(id, s.ref, RANGI));
    return { id, seat: s, charge: coverRow(s.id) };
  };
  const full = await make(['B1'], 'Full');
  ok(await update(full.charge.id, { paid: true }));
  const part = await make(['B2'], 'Part');
  ok(await internal('orders-paid', posOrder(5101, [{ price: '5.00', properties: { _booking: part.charge.ref } }])));
  const done = await make(['B3'], 'Done', 3);
  ok(await update(done.charge.id, { paid: true }));
  ok(await update(done.seat.id, { people: 1 }));
  ok(await update(done.charge.id, { refunded: true }));
  const live = await make(['B4'], 'Live', 3);
  ok(await update(live.charge.id, { paid: true }));
  ok(await update(live.seat.id, { people: 1 }));
  alerts = [];
  for (const g of [full, part, done, live]) ok(await call('POST', `games/${g.id}/update`, { status: 'cancelled' }, OWNER));
  assert.deepEqual(await backOn(full.charge.id), { refund: 'due', amount: 1000, paid: 1000, shown: 1000 });
  assert.deepEqual(await backOn(part.charge.id), { refund: 'due', amount: 500, paid: 500, shown: 500 });
  assert.deepEqual(await backOn(done.charge.id), { refund: 'due', amount: 1000, paid: 1000, shown: 1000 });
  assert.deepEqual(await backOn(live.charge.id), { refund: 'due', amount: 3000, paid: 3000, shown: 3000 });
  // the staff view says what to give back; the cancel emails list it (in all, for one that was due already)
  const staffView = async (id) => ok(await call('GET', `floor?from=${at('2026-10-24', 0)}&to=${at('2026-11-20', 0)}`, null, OWNER)).bookings.find((b) => b.id === id);
  assert.equal((await staffView(part.charge.id)).refundAmount, 500);
  const lines = alerts.flatMap((a) => [a.subject]);
  assert.deepEqual(lines, ['Refunds due: Full', 'Refunds due: Part', 'Refunds due: Done', 'Refunds due: Live']);
  // a later payment on a charge whose session was cancelled: staff hear the new total
  alerts = [];
  ok(await internal('orders-paid', posOrder(5102, [{ price: '5.00', properties: { _booking: part.charge.ref } }])));
  assert.deepEqual(await backOn(part.charge.id), { refund: 'due', amount: 1000, paid: 1000, shown: 1000 });
  assert.match(alerts[0].intro, /is \$10\.00 now, not \$5\.00/);
});

test('GM pays, review 3.6 to 3.9: the 10-minute run flags money back when it also puts the seat right; staff told once; the words', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia', { people: 3 });
  ok(await cover(id, mias.ref, RANGI));
  const charge = coverRow(mias.id);
  ok(await update(charge.id, { paid: true }));
  // something else changes the seat to 1 person with a price on it: the run puts it right, and $20 is due back
  lair.sql.exec('UPDATE bookings SET people = 1, amount = 1500 WHERE id = ?', mias.id);
  alerts = [];
  assert.equal(lair.coverUpkeep(Date.now()), 1);
  assert.deepEqual([lair.booking(mias.id).amount, (await backOn(charge.id)).amount], [0, 2000]);
  assert.deepEqual(alerts.map((a) => a.subject), [`Refund due: ${charge.ref}`]);
  // a staff change to the charge (waived off, marked paid) doesn't tell staff again
  alerts = [];
  ok(await update(charge.id, { waived: false }));
  ok(await update(charge.id, { paid: true }));
  assert.deepEqual([alerts.length, (await backOn(charge.id)).amount], [0, 2000]);
  // taken off then back with fewer people than were paid for: "back on, and it costs"
  ok(await update(charge.id, { refunded: true }));
  ok(await update(mias.id, { people: 3 }));
  ok(await update(charge.id, { paid: true }));
  ok(await update(mias.id, { status: 'cancelled' }));
  lair.sql.exec('UPDATE bookings SET people = 1 WHERE id = ?', mias.id);
  alerts = [];
  ok(await update(mias.id, { status: 'confirmed' }));
  assert.match(alerts[0].intro, /is \$20\.00 now, not \$30\.00: Rangi Hohaia has paid \$30\.00 for it, and Mia's seat is back on, and it costs \$10\.00 now\. /);
});

test('GM pays, review 3: a new GM on a free session ends the offer quietly; "Still paying" once; free seats don\'t say the GM pays', async () => {
  const letters = [];
  lair.letter = (to, subject) => {
    letters.push(subject);
    return { to, subject };
  };
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  ok(await cover(id, mias.ref, RANGI));
  ok(await call('POST', `games/${id}/free`, { free: true }, OWNER));
  assert.equal((await me(MIA)).account.comingUp.items.find((x) => x.id === mias.id).coveredByGm, undefined);
  ok(await call('POST', `games/${id}/gm`, { gmCustomerId: WIREMU, gmCustomerName: 'Wiremu', gm: 'Wiremu' }, OWNER));
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(mias.id).coveredBy], [0, undefined]);
  assert.ok(!letters.some((l) => /your seat/.test(l)), letters.join(', '));
  // inside the 24 hours, A to B to C: staff hear once, when it's left with the GM who made it
  const other = await list({ tables: ['B2'], title: 'Locked' });
  const kais = await seat(other, KAI, 'Kai');
  ok(await cover(other, kais.ref, RANGI));
  nowIs(at('2026-10-27', 9));
  alerts = [];
  ok(await call('POST', `games/${other}/gm`, { gmCustomerId: WIREMU, gmCustomerName: 'Wiremu', gm: 'Wiremu' }, OWNER));
  ok(await call('POST', `games/${other}/gm`, { gmEmail: 'hemi.gm@example.com', gm: 'Hemi' }, OWNER));
  assert.deepEqual(alerts.filter((a) => /^Still paying/.test(a.subject)).length, 1);
  assert.equal(coverRow(kais.id).customerId, RANGI);
  // staff can still stop it, even on a seat that's been taken off
  ok(await update(kais.id, { status: 'cancelled' }));
  ok(await uncover(other, kais.ref, OWNER));
});

test('GM pays, final check: a gone charge owes nothing at the desk; a new GM: the cancel-by is the seat\'s own, a taken-off seat stays the GM\'s', async () => {
  const intros = [];
  lair.letter = (to, subject, content) => {
    intros.push([subject, content.intro]);
    return { to, subject };
  };
  // a gone charge, scanned: nothing to pay, and no line
  const id = await list({ start: at('2026-10-25', 18), end: at('2026-10-25', 21) });
  const mias = await seat(id, MIA, 'Mia', { people: 3 });
  ok(await cover(id, mias.ref, RANGI));
  const charge = coverRow(mias.id);
  ok(await uncover(id, mias.ref, OWNER));
  nowIs(at('2026-10-25', 17, 30));
  const scanned = ok(await pos('checkin', { code: charge.ref }));
  assert.deepEqual([scanned.reason, scanned.due, scanned.row.due, scanned.lines], ['cover', 0, 0, []]);
  nowIs(NOW);
  // a regular's seat Gobgob saved inside the 24 hours can be cancelled until the start: a new GM ends the offer, and the
  // player's email says the start, not a time that's passed
  const later = await list({ tables: ['B2'], title: 'Weekly' });
  const kais = await seat(later, KAI, 'Kai');
  ok(await cover(later, kais.ref, RANGI));
  nowIs(at('2026-10-27', 9));
  lair.sql.exec('UPDATE bookings SET series_id = ?, gob_saved = 1, created_at = ? WHERE id = ?', 'sr_test', at('2026-10-27', 8), kais.id);
  ok(await call('POST', `games/${later}/gm`, { gmCustomerId: WIREMU, gmCustomerName: 'Wiremu', gm: 'Wiremu' }, OWNER));
  assert.equal(lair.booking(kais.id).coveredBy, undefined);
  const letter = intros.find(([subject]) => subject === 'Weekly: your seat');
  assert.ok(letter, intros.map(([s]) => s).join(', '));
  assert.match(letter[1], /Cancel it in My Lair by Tuesday, 27 October at 6:00 pm\.$/);
  // a seat taken off inside the 24 hours stays the GM's offer when the session gets a new GM: put back, he pays again
  nowIs(NOW);
  const third = await list({ tables: ['B3'], title: 'Third' });
  const rias = await seat(third, RIA, 'Ria');
  ok(await cover(third, rias.ref, RANGI));
  nowIs(at('2026-10-27', 9));
  ok(await update(rias.id, { status: 'cancelled' }));
  ok(await call('POST', `games/${third}/gm`, { gmCustomerId: WIREMU, gmCustomerName: 'Wiremu', gm: 'Wiremu' }, OWNER));
  assert.deepEqual([lair.booking(rias.id).coveredBy, lair.booking(rias.id).amount], [RANGI, 0]);
  ok(await update(rias.id, { status: 'confirmed' }));
  assert.deepEqual([coverRow(rias.id).status, coverRow(rias.id).customerId, coverRow(rias.id).amount], ['confirmed', RANGI, 1000]);
  // a cancelled session's email says which session each GM's charge was for
  shopifyOn = true;
  ok(await update(coverRow(rias.id).id, { paid: true }));
  alerts = [];
  ok(await call('POST', `games/${third}/update`, { status: 'cancelled' }, OWNER));
  const refunds = alerts.find((a) => a.subject === 'Refunds due: Third');
  assert.ok(refunds);
});

// Round 21: GMs' stamps and GM credit that adds itself (contract v21-gm-credit). Mo (26 Oct 2026): "make sure to make the
// gm gets entry stamps even if they don't pay for the session. Unless the session got canceled." and "have each player
// give the gm credit only when the payment have went through." Then: "Staff gms don't get it. But yes since the card
// began is fine" and "Automatic from today." Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { GM_CREDIT, GM_CREDIT_WORDS as W, autoCredit } from '../src/gm-credit.js';
import { readyForCredit } from '../src/staff-gm.js';
import { GM_SESSION_WORDS } from '../src/gm-sessions.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
// Sunday 25 October 2026, 10:00am in Auckland (NZDT, UTC+13): the day before round 21's GM credit starts
const NOW = Date.UTC(2026, 9, 24, 21, 0);
const realNow = Date.now;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const nowIs = (ms) => {
  Date.now = () => ms;
};

/* ---------------- helpers, as in test/round18-gm-sessions.test.js ---------------- */
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
// People by their Shopify customer IDs (made up): the main account; Ana, a helper with GM games; Rangi and Wiremu, GMs
// who aren't staff; and players
const OWNER = '9001';
const ANA = '9101';
const RANGI = '5001';
const WIREMU = '5002';
const MIA = '6001';
const KAI = '6002';
const RIA = '6003';
const NAMES = { [OWNER]: 'Mo', [ANA]: 'Ana', [RANGI]: 'Rangi', [WIREMU]: 'Wiremu' };

let lair;
async function call(method, path, body, customer = '') {
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer },
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
const credit = (id, body = {}, who = OWNER) => call('POST', `games/${id}/credit`, body, who);
const board = async (who = OWNER) => ok(await call('GET', `floor?from=${at('2026-10-24', 0)}&to=${at('2026-11-20', 0)}`, null, who));
const gameOn = async (id, who = OWNER) => (await board(who)).games.find((g) => g.id === id);
const stamps = (id) => lair.stampCount(id);
const ledger = (gameId) => lair.sql.exec('SELECT booking_id, customer_id, people, amount, status, tries FROM gm_credit_seats WHERE game_id = ? ORDER BY created_at, booking_id', gameId).toArray().map((r) => ({ ...r }));
const creditRows = (gameId) => lair.sql.exec('SELECT customer_id, players, amount, status, by FROM credits WHERE game_id = ? ORDER BY rowid', gameId).toArray().map((r) => ({ ...r }));
const creditedOf = (gameId) => lair.sql.exec('SELECT credited FROM games WHERE id = ?', gameId).one().credited;

/** A session listed by the main account for a GM (Rangi unless said), Tuesday 27 October 6pm to 10pm unless said */
async function list({ gm = RANGI, start = at('2026-10-27', 18), end = at('2026-10-27', 22), seats = 4, gmFee, tables = ['B1'], title, email } = {}) {
  const name = NAMES[gm] || 'Hemi';
  const forGm = gm ? { gmCustomerId: gm, gmCustomerName: name, gmEmail: `${name.toLowerCase()}@example.com` } : { gmEmail: email };
  return ok(await call('POST', 'games', {
    title: title || `${name}'s one-shot`, system: 'D&D 5e', gm: name, blurb: 'A test session.', seats, tables, start, end, ...forGm,
    ...(gmFee === undefined ? {} : { gmFee }),
  }, OWNER)).game.id;
}

/** A seat booked online by a member (pay at the Lair), and marked paid by staff when paid is true. → the booking */
async function seat(gameId, who, name, { people = 1, paid = false } = {}) {
  const { booking } = ok(await call('POST', 'bookings', {
    kind: 'gm-seat', gameId, people, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100', pay: 'day',
  }, who));
  if (paid) ok(await call('POST', `bookings/${booking.id}/update`, { paid: true }, OWNER));
  return booking;
}
const pay = (booking) => call('POST', `bookings/${booking.id}/update`, { paid: true }, OWNER).then(ok);

// No network in these tests: no Shopify and no emails. Anything that reaches for it is noted, and the test fails.
const realFetch = globalThis.fetch;
let reached = [];
let credited = [];
let creditCalls = [];
let alerts = [];
let shopifyOn = true;
let tagsDown = false;
// what Shopify does with the next store credit: null (adds it), 'refuse' (says no) or 'silent' (no answer)
let shopifySays = null;

beforeEach(async () => {
  reached = [];
  credited = [];
  creditCalls = [];
  alerts = [];
  shopifyOn = true;
  tagsDown = false;
  shopifySays = null;
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  lair.taggedPerson = async (id) => {
    if (tagsDown) return { customerId: id || null, staff: false, gm: false, tags: [], tagsFailed: true };
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.searchCustomers = async () => [{ customerId: OWNER, name: 'Mo', email: 'owner@example.com' }];
  Object.defineProperty(lair.shopify, 'configured', { get: () => shopifyOn, configurable: true });
  lair.shopify.creditCustomer = async (customerId, cents, currency, options) => {
    creditCalls.push([customerId, cents, currency, options]);
    if (shopifySays === 'refuse') throw Object.assign(new Error('Customer is not eligible'), { refused: true });
    if (shopifySays === 'silent') throw new Error('The operation was aborted due to timeout');
    credited.push([customerId, cents]);
    return { amount: { amount: (cents / 100).toFixed(2) } };
  };
  lair.notifyStaff = (subject, content) => alerts.push({ subject, intro: content.intro });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  ok(await call('POST', 'team', { customerId: ANA, name: 'Ana Ngata', email: 'ana@example.com', perms: ['sessions'] }, OWNER));
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

test('round 21: the words, word for word, and the start: sessions from midnight on Monday 26 October, Lair time', () => {
  assert.equal(GM_CREDIT.autoFrom, at('2026-10-26', 0));
  assert.equal(GM_CREDIT.maxTries, 5);
  assert.equal(W.stampTitle('Curse of Strahd'), 'Curse of Strahd (you ran it)');
  assert.equal(W.stampTitle(''), 'TTRPG session (you ran it)');
  assert.equal(W.notOver, "GM credit adds itself for this session: once it's over, the GM gets their fee for each player who's paid. There's nothing to tap.");
  assert.equal(W.nothingYet, "Nothing to add yet: the GM gets their fee for each player once they've paid.");
  assert.equal(W.allDone, "Done: the GM has had their fee for every player who's paid.");
  assert.equal(W.sending, "Gobgob is adding the GM's credit right now. Check again in a minute.");
  assert.equal(W.free, "This session was free, so there's no GM credit to add.");
  assert.equal(W.noFee, "This GM covers their players' fee, so there's no store credit to add.");
  assert.equal(W.marked, "The GM's credit has gone to them already, so it can't be kept now. Take it off their store credit on their member page if it shouldn't have gone.");
  assert.equal(W.markedOn, "Marked: they were working, so there's no GM credit for this session.");
  assert.equal(W.markedOff, "Marked: they weren't working, so they get their GM credit once it's over.");
  assert.equal(W.undone('Rangi', '$5.00', "Mia's seat at Curse of Strahd", 'was cancelled'), "Rangi got $5.00 GM credit for Mia's seat at Curse of Strahd, but that seat was cancelled. If Rangi shouldn't keep it, take it off their store credit on their member page.");
  assert.equal(W.noAccount, "The GM isn't linked to a customer account, so add the store credit in Shopify admin.");
  assert.equal(W.refused('Customer is not eligible'), "Shopify didn't add the store credit (Customer is not eligible). Nothing moved. Gobgob tries again in 10 minutes.");
  assert.equal(W.failed('Customer is not eligible'), "Shopify didn't add the store credit after 5 tries (Customer is not eligible). Nothing moved. Add it in Shopify admin.");
  assert.equal(W.check('timeout'), "Shopify didn't confirm the store credit (timeout), so it may have gone through. Check the GM's store credit in Shopify admin before adding any.");
  assert.equal(W.stale, "Shopify didn't answer about the store credit, so it may have gone through. Check the GM's store credit in Shopify admin before adding any.");
  assert.equal(autoCredit({ start: at('2026-10-26', 0) }), true);
  assert.equal(autoCredit({ start: at('2026-10-26', 0) - 1 }), false);
  assert.equal(autoCredit({ starts_at: at('2026-10-27', 18) }), true);
});

/* ---------------- GM stamps ---------------- */

test('GM stamps (round 21): one for each session a GM ran, once it has started; none with nobody booked, none cancelled', async () => {
  const ran = await list();
  await seat(ran, MIA, 'Mia');
  const empty = await list({ tables: ['B2'], title: 'Nobody came' });
  const off = await list({ start: at('2026-10-28', 18), end: at('2026-10-28', 22), title: 'Called off' });
  await seat(off, KAI, 'Kai');
  ok(await call('POST', `games/${off}/update`, { status: 'cancelled' }, OWNER));
  // nothing has started: no stamps, and nothing to look at
  assert.equal(stamps(RANGI), 0);
  assert.equal(await lair.gmRunUpkeep(Date.now()), null);
  // Wednesday night, both Tuesday sessions are over and the cancelled one has started: the run looks at the two that ran
  nowIs(at('2026-10-28', 19));
  assert.deepEqual(await lair.gmRunUpkeep(Date.now()), { looked: 2 });
  assert.equal(stamps(RANGI), 1, 'the session with a player, not the one nobody booked, nor the cancelled one');
  const card = lair.loyaltyOf(RANGI, lair.rulesCache, { details: true });
  assert.equal(card.stamps, 1);
  assert.deepEqual(card.recent.map((s) => [s.title, s.people, s.at]), [["Rangi's one-shot (you ran it)", 1, at('2026-10-27', 18)]]);
  // looked at once each
  assert.equal(await lair.gmRunUpkeep(Date.now()), null);
  // like every stamp, it's counted each time: a session cancelled afterwards takes it back, and a player cancelling theirs
  // (the only one on it) too
  lair.sql.exec("UPDATE games SET status = 'cancelled' WHERE id = ?", ran);
  assert.equal(stamps(RANGI), 0);
  lair.sql.exec("UPDATE games SET status = 'open' WHERE id = ?", ran);
  assert.equal(stamps(RANGI), 1);
  lair.sql.exec("UPDATE bookings SET status = 'cancelled' WHERE game_id = ? AND kind = 'gm-seat'", ran);
  assert.equal(stamps(RANGI), 0);
  // the players' own stamps don't change: Mia's seat was never checked in
  assert.equal(stamps(MIA), 0);
});

test('GM stamps (round 21): no stamp for someone on the team (a helper, the main account), nor before the card began', async () => {
  const anas = await list({ gm: ANA });
  await seat(anas, MIA, 'Mia');
  const mos = await list({ gm: OWNER, tables: ['B2'] });
  await seat(mos, KAI, 'Kai');
  const rangis = await list({ tables: ['B3'] });
  await seat(rangis, RIA, 'Ria');
  nowIs(at('2026-10-27', 18, 30));
  assert.deepEqual(await lair.gmRunUpkeep(Date.now()), { looked: 3 });
  assert.deepEqual(lair.sql.exec('SELECT customer_id, staff FROM gm_runs ORDER BY customer_id').toArray().map((r) => [r.customer_id, r.staff]), [[RANGI, 0], [OWNER, 1], [ANA, 1]]);
  assert.deepEqual([stamps(ANA), stamps(OWNER), stamps(RANGI)], [0, 0, 1]);
  // a later change on the Team tab doesn't move it: what the GM was when it ran stays
  ok(await call('POST', `team/${ANA}/remove`, {}, OWNER));
  assert.equal(stamps(ANA), 0);
  // the card's start: a session from before it began earns nothing
  lair.loyaltyFrom = at('2026-10-27', 18) + 1;
  assert.equal(stamps(RANGI), 0);
});

test('GM stamps (round 21): a GM Shopify can\'t say about waits for the next run; a session given to another GM is looked at again', async () => {
  const id = await list();
  await seat(id, MIA, 'Mia');
  nowIs(at('2026-10-27', 18, 30));
  tagsDown = true;
  assert.equal(await lair.gmRunUpkeep(Date.now()), null);
  assert.equal(stamps(RANGI), 0);
  tagsDown = false;
  assert.deepEqual(await lair.gmRunUpkeep(Date.now()), { looked: 1 });
  assert.equal(stamps(RANGI), 1);
  // the session goes to Wiremu: it's Wiremu's stamp once the run has looked at him
  lair.sql.exec('UPDATE games SET gm_customer_id = ? WHERE id = ?', WIREMU, id);
  assert.deepEqual([stamps(RANGI), stamps(WIREMU)], [0, 0]);
  assert.deepEqual(await lair.gmRunUpkeep(Date.now()), { looked: 1 });
  assert.deepEqual([stamps(RANGI), stamps(WIREMU)], [0, 1]);
});

test('GM stamps (round 21): a GM checked in on a seat of their own session gets that seat\'s stamp, not a second one', async () => {
  const id = await list();
  const own = await seat(id, RANGI, 'Rangi');
  // only the GM's own seat: it didn't run for players
  nowIs(at('2026-10-27', 18, 5));
  ok(await call('POST', 'checkin', { id: own.id }, OWNER));
  await lair.gmRunUpkeep(Date.now());
  assert.equal(stamps(RANGI), 1, "the seat's");
  await seat(id, MIA, 'Mia');
  assert.equal(stamps(RANGI), 1, 'still one');
  // not checked in on it: the session's stamp
  ok(await call('POST', `bookings/${own.id}/update`, { status: 'confirmed' }, OWNER));
  assert.equal(stamps(RANGI), 1, "the session's");
});

/* ---------------- GM credit that adds itself ---------------- */

test('GM credit (round 21): once the session is over, each paid seat gives its GM their fee, one store credit a run; paid later, later; never twice', async () => {
  const id = await list();
  await seat(id, MIA, 'Mia', { people: 2, paid: true });
  const kais = await seat(id, KAI, 'Kai');
  // during the session: nothing yet
  nowIs(at('2026-10-27', 21));
  assert.equal(await lair.autoGmCredit(Date.now()), null);
  assert.deepEqual(creditCalls, []);
  // over: Mia's two seats, $5 each, in one store credit
  nowIs(at('2026-10-27', 22, 10));
  assert.deepEqual(await lair.autoGmCredit(Date.now()), { credited: 2, amount: 1000, staff: 0, manual: 0, retry: 0, failed: 0, check: 0 });
  assert.deepEqual(creditCalls, [[RANGI, 1000, 'NZD', { timeout: GM_CREDIT.timeoutMs }]]);
  assert.deepEqual(ledger(id).map((r) => [r.customer_id, r.people, r.amount, r.status]), [[RANGI, 2, 1000, 'credited']]);
  assert.deepEqual(creditRows(id), [{ customer_id: RANGI, players: 2, amount: 1000, status: 'credited', by: 'auto' }]);
  assert.equal(creditedOf(id), 2);
  // never twice
  assert.equal(await lair.autoGmCredit(Date.now()), null);
  assert.equal(creditCalls.length, 1);
  // the staff page: credited so far, and a player still to pay
  let view = (await gameOn(id)).gmCredit;
  assert.deepEqual([view.auto, view.credited, view.unpaid, view.toCome], [true, { players: 2, amount: 1000 }, { players: 1 }, { players: 0 }]);
  // Kai pays at the counter the next day: his $5 goes the next run
  nowIs(at('2026-10-28', 17));
  await pay(kais);
  view = (await gameOn(id)).gmCredit;
  assert.deepEqual([view.unpaid, view.toCome], [{ players: 0 }, { players: 1 }]);
  assert.deepEqual(await lair.autoGmCredit(Date.now()), { credited: 1, amount: 500, staff: 0, manual: 0, retry: 0, failed: 0, check: 0 });
  assert.deepEqual(credited, [[RANGI, 1000], [RANGI, 500]]);
  assert.deepEqual(creditRows(id).map((r) => [r.players, r.amount, r.status]), [[2, 1000, 'credited'], [1, 500, 'credited']]);
  assert.equal(creditedOf(id), 3);
  view = (await gameOn(id)).gmCredit;
  assert.deepEqual([view.credited, view.unpaid, view.toCome], [{ players: 3, amount: 1500 }, { players: 0 }, { players: 0 }]);
  // My Lair lists both for Rangi, as GM credit has always been listed
  const mine = lair.sql.exec("SELECT amount FROM credits WHERE customer_id = ? AND status = 'credited' ORDER BY rowid", RANGI).toArray().map((r) => r.amount);
  assert.deepEqual(mine, [1000, 500]);
});

test('GM credit (round 21): two sessions of one GM over by the same run go in one store credit; each GM gets their own', async () => {
  const early = await list({ start: at('2026-10-27', 16), end: at('2026-10-27', 19), title: 'Early one' });
  const late = await list({ start: at('2026-10-27', 19), end: at('2026-10-27', 22), title: 'Late one', gmFee: 1000 });
  const other = await list({ gm: WIREMU, tables: ['B2'] });
  await seat(early, MIA, 'Mia', { paid: true });
  await seat(late, KAI, 'Kai', { paid: true });
  await seat(other, RIA, 'Ria', { people: 3, paid: true });
  nowIs(at('2026-10-27', 23));
  assert.deepEqual(await lair.autoGmCredit(Date.now()), { credited: 5, amount: 3000, staff: 0, manual: 0, retry: 0, failed: 0, check: 0 });
  assert.deepEqual(creditCalls.map(([gm, cents]) => [gm, cents]).sort(), [[RANGI, 1500], [WIREMU, 1500]]);
  // each session still has its own record
  assert.deepEqual([creditRows(early)[0].amount, creditRows(late)[0].amount, creditRows(other)[0].amount], [500, 1000, 1500]);
});

test('GM credit (round 21): nothing for a free session, a $0 GM fee, cancelled seats, no-shows or unpaid seats; nothing while Shopify is off', async () => {
  const free = await list({ title: 'Free night' });
  ok(await call('POST', `games/${free}/free`, { free: true }, OWNER));
  await seat(free, MIA, 'Mia');
  const covers = await list({ tables: ['B2'], gmFee: 0, title: 'GM covers it' });
  await seat(covers, KAI, 'Kai', { paid: true });
  const usual = await list({ tables: ['B3'] });
  const gone = await seat(usual, MIA, 'Mia', { paid: true });
  const noshow = await seat(usual, KAI, 'Kai', { paid: true });
  await seat(usual, RIA, 'Ria');
  ok(await call('POST', `bookings/${gone.id}/update`, { status: 'cancelled' }, OWNER));
  nowIs(at('2026-10-27', 19));
  ok(await call('POST', `bookings/${noshow.id}/update`, { status: 'noshow' }, OWNER));
  nowIs(at('2026-10-27', 23));
  shopifyOn = false;
  assert.equal(await lair.autoGmCredit(Date.now()), null);
  shopifyOn = true;
  assert.equal(await lair.autoGmCredit(Date.now()), null);
  assert.deepEqual(creditCalls, []);
  assert.deepEqual([...ledger(free), ...ledger(covers), ...ledger(usual)], []);
  // the staff page says why there's nothing: Ria hasn't paid
  assert.deepEqual((await gameOn(usual)).gmCredit.unpaid, { players: 1 });
});

test('GM credit (round 21): a session from before 26 October keeps Session done; one credited with Session done is left alone', async () => {
  const sunday = await list({ start: at('2026-10-25', 18), end: at('2026-10-25', 21), title: 'Sunday one-shot' });
  await seat(sunday, MIA, 'Mia', { paid: true });
  nowIs(at('2026-10-25', 22));
  assert.equal(await lair.autoGmCredit(Date.now()), null);
  // its card still offers Session done (staffGm only for a staff GM; readyForCredit for anyone)
  assert.equal(readyForCredit(lair.game(sunday), Date.now()), true);
  const done = ok(await credit(sunday));
  assert.deepEqual([done.players, done.amount, done.status, 'auto' in done], [1, 500, 'credited', false]);
  assert.deepEqual(creditRows(sunday).map((r) => [r.amount, r.status, r.by]), [[500, 'credited', `staff:${OWNER}`]]);
  // a round 21 session someone credited the old way (before this went live) isn't credited again
  const tuesday = await list();
  await seat(tuesday, KAI, 'Kai', { paid: true });
  lair.sql.exec("INSERT INTO credits (id, game_id, customer_id, players, amount, status, note, created_at, by) VALUES ('cr_old', ?, ?, 1, 500, 'credited', '', ?, ?)", tuesday, RANGI, Date.now(), `staff:${OWNER}`);
  nowIs(at('2026-10-27', 23));
  assert.equal(await lair.autoGmCredit(Date.now()), null);
  assert.equal(creditCalls.length, 1);
  assert.equal(readyForCredit(lair.game(tuesday), Date.now()), false);
});

test('GM credit (round 21): Session done on a round 21 session does now what the next run would; before it\'s over it says why not', async () => {
  const id = await list();
  await seat(id, MIA, 'Mia', { paid: true });
  const kais = await seat(id, KAI, 'Kai');
  nowIs(at('2026-10-27', 20));
  assert.equal(said(await credit(id)), `409 ${W.notOver}`);
  assert.equal(said(await credit(id, {}, ANA)), "403 That's not one of your staff permissions. Ask the main account to tick it on the Team tab.");
  // the floor offers no Session done for it (no staffGm), and says where it's up to
  assert.equal(readyForCredit(lair.game(id), Date.now()), false);
  nowIs(at('2026-10-27', 22, 1));
  const done = ok(await credit(id));
  assert.deepEqual(done, { players: 1, amount: 500, status: 'credited', note: '', auto: true });
  const again = ok(await credit(id));
  assert.deepEqual(again, { players: 0, amount: 0, status: 'none', note: W.nothingYet, auto: true });
  // Kai pays: the tap credits him at once, and then it's all done
  await pay(kais);
  assert.deepEqual(ok(await credit(id)), { players: 1, amount: 500, status: 'credited', note: '', auto: true });
  assert.deepEqual(ok(await credit(id)), { players: 0, amount: 0, status: 'none', note: W.allDone, auto: true });
  // a session whose store credit Shopify didn't confirm says so, and isn't tried again
  const other = await list({ start: at('2026-10-28', 18), end: at('2026-10-28', 22) });
  await seat(other, RIA, 'Ria', { paid: true });
  nowIs(at('2026-10-28', 22, 1));
  shopifySays = 'silent';
  const unsure = ok(await credit(other));
  assert.deepEqual([unsure.status, unsure.players, unsure.note], ['check', 1, W.check('The operation was aborted due to timeout')]);
  shopifySays = null;
  assert.deepEqual(ok(await credit(other)), unsure);
  assert.equal(creditCalls.length, 3);
  // once credited, the session keeps its GM
  assert.equal(said(await call('POST', `games/${id}/gm`, { gmCustomerId: WIREMU, gmCustomerName: 'Wiremu', gmEmail: 'wiremu@example.com' }, OWNER)), `409 ${GM_SESSION_WORDS.gmCredited}`);
});

test('GM credit (round 21): staff GMs: Never keeps it (recorded, no store credit); Always gives it; Not in their hours goes by their hours', async () => {
  // Never (until the main account picks): Ana and the main account get none
  const anas = await list({ gm: ANA });
  await seat(anas, MIA, 'Mia', { paid: true });
  const mos = await list({ gm: OWNER, tables: ['B2'] });
  await seat(mos, KAI, 'Kai', { people: 2, paid: true });
  nowIs(at('2026-10-27', 22, 10));
  assert.deepEqual(await lair.autoGmCredit(Date.now()), { credited: 0, amount: 0, staff: 3, manual: 0, retry: 0, failed: 0, check: 0 });
  assert.deepEqual(creditCalls, []);
  assert.deepEqual(ledger(anas).map((r) => [r.amount, r.status]), [[0, 'staff']]);
  assert.deepEqual(creditRows(anas).map((r) => [r.players, r.amount, r.status, r.by]), [[1, 0, 'staff', 'auto']]);
  assert.equal(lair.sql.exec('SELECT note FROM credits WHERE game_id = ?', anas).one().note, "No GM credit: Ana is staff, and staff don't earn GM credit (it would have been $5.00 for 1 paying player).");
  assert.equal(creditedOf(anas), 1);
  assert.deepEqual((await gameOn(mos)).gmCredit.staff, { players: 2, amount: 1000 });
  // Always: staff earn it like any GM
  ok(await call('POST', 'team/gm-credit', { mode: 'earn' }, OWNER));
  const later = await list({ gm: ANA, start: at('2026-10-29', 18), end: at('2026-10-29', 22) });
  await seat(later, RIA, 'Ria', { paid: true });
  nowIs(at('2026-10-29', 22, 10));
  assert.equal((await lair.autoGmCredit(Date.now())).credited, 1);
  assert.deepEqual(credited, [[ANA, 500]]);
  // Not in their hours: Ana works Fridays 4pm to 10pm, so Friday's session is kept and Saturday's earns it
  ok(await call('POST', 'team/gm-credit', { mode: 'shifts' }, OWNER));
  ok(await call('POST', `team/${ANA}/hours`, { hours: [{ day: 'fri', from: '16:00', to: '22:00' }] }, OWNER));
  const friday = await list({ gm: ANA, start: at('2026-10-30', 18), end: at('2026-10-30', 22) });
  const saturday = await list({ gm: ANA, start: at('2026-10-31', 18), end: at('2026-10-31', 22) });
  await seat(friday, MIA, 'Mia', { paid: true });
  await seat(saturday, KAI, 'Kai', { paid: true });
  nowIs(at('2026-10-31', 22, 10));
  const both = await lair.autoGmCredit(Date.now());
  assert.deepEqual([both.credited, both.staff], [1, 1]);
  assert.deepEqual(credited, [[ANA, 500], [ANA, 500]]);
  assert.equal(lair.sql.exec('SELECT note FROM credits WHERE game_id = ?', friday).one().note, "No GM credit: it was in Ana's hours, Fri 4pm–10pm (it would have been $5.00 for 1 paying player).");
  assert.equal(lair.sql.exec('SELECT note FROM credits WHERE game_id = ?', saturday).one().note, "It was outside Ana's hours, so they earn it like any GM.");
});

test('GM credit (round 21): a GM Shopify can\'t say about isn\'t paid while the setting could keep it from them; the next run pays', async () => {
  const id = await list();
  await seat(id, MIA, 'Mia', { paid: true });
  nowIs(at('2026-10-27', 22, 10));
  tagsDown = true;
  assert.equal(await lair.autoGmCredit(Date.now()), null);
  assert.deepEqual(ledger(id), []);
  tagsDown = false;
  assert.equal((await lair.autoGmCredit(Date.now())).credited, 1);
});

test('GM credit (round 21): a GM with no account: staff hear once to add it by hand, and it\'s recorded as manual', async () => {
  const id = await list({ gm: null, email: 'hemi@example.com', title: "Hemi's one-shot" });
  assert.equal(lair.game(id).gmCustomerId, null);
  await seat(id, MIA, 'Mia', { paid: true });
  await seat(id, KAI, 'Kai', { paid: true });
  nowIs(at('2026-10-27', 22, 10));
  assert.deepEqual(await lair.autoGmCredit(Date.now()), { credited: 0, amount: 0, staff: 0, manual: 2, retry: 0, failed: 0, check: 0 });
  assert.deepEqual(creditCalls, []);
  assert.deepEqual(ledger(id).map((r) => [r.customer_id, r.amount, r.status]), [[null, 500, 'manual'], [null, 500, 'manual']]);
  assert.deepEqual(creditRows(id).map((r) => [r.players, r.amount, r.status]), [[2, 1000, 'manual']]);
  assert.equal(creditedOf(id), null, 'not done: staff still have it to do');
  assert.deepEqual(alerts.map((a) => a.subject), ['GM credit to add by hand: Hemi']);
  assert.match(alerts[0].intro, /Add \$10\.00 to their store credit in Shopify admin/);
  assert.equal(await lair.autoGmCredit(Date.now()), null);
  assert.equal(alerts.length, 1);
  assert.deepEqual((await gameOn(id)).gmCredit.manual, { players: 2, amount: 1000 });
});

test('GM credit (round 21): Shopify said no: tried again each run, and after 5 tries staff hear; a later yes credits it', async () => {
  const id = await list();
  await seat(id, MIA, 'Mia', { paid: true });
  nowIs(at('2026-10-27', 22, 10));
  shopifySays = 'refuse';
  assert.equal((await lair.autoGmCredit(Date.now())).retry, 1);
  assert.deepEqual(ledger(id).map((r) => [r.status, r.tries]), [['retry', 1]]);
  assert.deepEqual(creditRows(id), []);
  assert.equal(creditedOf(id), null);
  shopifySays = null;
  assert.equal((await lair.autoGmCredit(Date.now())).credited, 1);
  assert.deepEqual(ledger(id).map((r) => [r.status, r.tries]), [['credited', 1]]);
  // another session refused every time: 5 tries, then staff hear, and it's never tried again
  const other = await list({ start: at('2026-10-28', 18), end: at('2026-10-28', 22) });
  await seat(other, KAI, 'Kai', { paid: true });
  nowIs(at('2026-10-28', 22, 10));
  shopifySays = 'refuse';
  for (let i = 1; i <= 4; i += 1) assert.equal((await lair.autoGmCredit(Date.now())).retry, 1, `try ${i}`);
  assert.equal((await lair.autoGmCredit(Date.now())).failed, 1);
  assert.deepEqual(ledger(other).map((r) => [r.status, r.tries]), [['failed', 5]]);
  assert.deepEqual(alerts.map((a) => a.subject), ['GM credit to add by hand: Rangi Hohaia']);
  assert.equal(await lair.autoGmCredit(Date.now()), null);
  assert.equal(creditCalls.filter(([, cents]) => cents === 500).length, 7);
  assert.deepEqual((await gameOn(other)).gmCredit.failed, { players: 1, amount: 500 });
});

test('GM credit (round 21): no answer from Shopify: to check, staff hear, never tried again; one stuck with Shopify 30 minutes too', async () => {
  const id = await list();
  await seat(id, MIA, 'Mia', { paid: true });
  nowIs(at('2026-10-27', 22, 10));
  shopifySays = 'silent';
  assert.equal((await lair.autoGmCredit(Date.now())).check, 1);
  assert.deepEqual(ledger(id).map((r) => r.status), ['check']);
  assert.deepEqual(alerts.map((a) => a.subject), ["Check a GM's store credit: Rangi Hohaia"]);
  assert.match(alerts[0].intro, /may have gone through/);
  shopifySays = null;
  assert.equal(await lair.autoGmCredit(Date.now()), null);
  assert.equal(creditCalls.length, 1);
  assert.deepEqual((await gameOn(id)).gmCredit.check, { players: 1, amount: 500 });
  // a store credit that was with Shopify when the Lair restarted: after 30 minutes it's to check
  const other = await list({ start: at('2026-10-28', 18), end: at('2026-10-28', 22) });
  const kais = await seat(other, KAI, 'Kai', { paid: true });
  lair.sql.exec("INSERT INTO gm_credit_seats (booking_id, game_id, customer_id, people, amount, status, batch, note, tries, created_at, updated_at) VALUES (?, ?, ?, 1, 500, 'sending', 'gc_stuck', NULL, 0, ?, ?)", kais.id, other, RANGI, at('2026-10-28', 22, 5), at('2026-10-28', 22, 5));
  nowIs(at('2026-10-28', 22, 20));
  assert.equal(await lair.autoGmCredit(Date.now()), null, 'not yet');
  nowIs(at('2026-10-28', 22, 36));
  assert.equal((await lair.autoGmCredit(Date.now())).check, 1);
  assert.deepEqual(ledger(other).map((r) => r.status), ['check']);
  assert.equal(alerts.length, 2);
  assert.equal(creditCalls.length, 1, 'never asked again');
});

test('GM credit (round 21): the 10-minute run does it, and the floor shows where it\'s up to only to staff who see GM credit', async () => {
  const id = await list();
  await seat(id, MIA, 'Mia', { paid: true });
  await seat(id, KAI, 'Kai');
  nowIs(at('2026-10-27', 20));
  assert.deepEqual((await gameOn(id)).gmCredit, { ...lair.gmCreditBlank(), toCome: { players: 1 }, unpaid: { players: 1 } });
  // not for the public, the GM or staff without GM games or Money
  for (const who of ['', RANGI]) assert.equal('gmCredit' in ((await gameOn(id, who)) || {}), false, who || 'logged out');
  ok(await call('POST', 'team', { customerId: '9102', name: 'Hemi Walker', email: 'hemi@example.com', perms: ['checkin'] }, OWNER));
  assert.equal('gmCredit' in (await gameOn(id, '9102')), false, 'check-in only');
  nowIs(at('2026-10-27', 22, 10));
  // (the rest of the run asks Shopify for other things, which aren't in this test)
  lair.shopify.graphql = async () => {
    throw new Error('Not in this test');
  };
  lair.syncSessionsFeed = async () => null;
  const run = await lair.checkConnection(undefined);
  assert.deepEqual([run.gmRuns, run.gmCredit?.credited], [{ looked: 1 }, 1]);
  assert.equal(stamps(RANGI), 1);
  assert.deepEqual(credited, [[RANGI, 500]]);
});

/* ---------------- after the review (26 Oct 2026) ---------------- */

test('GM credit (round 21, review): round 17\'s mark still works: "they weren\'t working" pays a kept session; "they were" is refused once paid', async () => {
  ok(await call('POST', 'team/gm-credit', { mode: 'shifts' }, OWNER));
  ok(await call('POST', `team/${ANA}/hours`, { hours: [{ day: 'tue', from: '16:00', to: '23:00' }] }, OWNER));
  const id = await list({ gm: ANA });
  await seat(id, MIA, 'Mia', { paid: true });
  nowIs(at('2026-10-27', 20));
  // the floor says what the setting does for this staff GM's session
  assert.deepEqual((await gameOn(id)).gmCredit.staffGm, { mode: 'shifts', credit: false, onShift: true, marked: false, shift: 'Tue 4pm–11pm', hours: 'Tue 4pm–11pm' });
  nowIs(at('2026-10-27', 22, 10));
  assert.equal((await lair.autoGmCredit(Date.now())).staff, 1);
  // only the main account marks it
  ok(await call('POST', 'team', { customerId: '9102', name: 'Hemi Walker', email: 'hemi@example.com', perms: ['sessions', 'money'] }, OWNER));
  assert.equal((await credit(id, { onShift: false }, '9102')).status, 403);
  const paid = ok(await credit(id, { onShift: false }));
  assert.deepEqual([paid.status, paid.players, paid.amount], ['credited', 1, 500]);
  assert.deepEqual(credited, [[ANA, 500]]);
  assert.equal(lair.sql.exec("SELECT note FROM credits WHERE game_id = ? AND status = 'credited'", id).one().note, "Ana wasn't working then, as Mo marked on the staff page, so they earn it like any GM.");
  assert.deepEqual((await gameOn(id)).gmCredit.staffGm.marked, true);
  // marked "was working" now: it's gone already
  assert.equal(said(await credit(id, { onShift: true })), `409 ${W.marked}`);
  // marked ahead of time: kept for the run
  const next = await list({ gm: ANA, start: at('2026-10-28', 18), end: at('2026-10-28', 22) });
  await seat(next, KAI, 'Kai', { paid: true });
  nowIs(at('2026-10-28', 19));
  assert.deepEqual(ok(await credit(next, { onShift: false })), { players: 0, amount: 0, status: 'marked', note: W.markedOff, auto: true });
  assert.equal(lair.game(next).gmOnShift, false);
  nowIs(at('2026-10-28', 22, 10));
  assert.equal((await lair.autoGmCredit(Date.now())).credited, 1, 'not in her hours on Wednesday anyway, and marked not working');
});

test('GM credit (round 21, review): the tap says why for a free session, a $0 GM fee, and how much to add by hand', async () => {
  const free = await list({ title: 'Free night' });
  ok(await call('POST', `games/${free}/free`, { free: true }, OWNER));
  const noFee = await list({ tables: ['B2'], gmFee: 0, title: 'GM covers it' });
  await seat(noFee, MIA, 'Mia', { paid: true });
  const hemis = await list({ gm: null, email: 'hemi@example.com', tables: ['B3'], title: "Hemi's one-shot" });
  await seat(hemis, KAI, 'Kai', { people: 2, paid: true });
  nowIs(at('2026-10-27', 22, 10));
  assert.deepEqual(ok(await credit(free)), { players: 0, amount: 0, status: 'none', note: W.free, auto: true });
  assert.deepEqual(ok(await credit(noFee)), { players: 0, amount: 0, status: 'none', note: W.noFee, auto: true });
  assert.deepEqual(ok(await credit(hemis)), { players: 2, amount: 1000, status: 'manual', note: W.noAccount, auto: true });
  assert.deepEqual(ok(await credit(hemis)), { players: 2, amount: 1000, status: 'manual', note: W.noAccount, auto: true }, 'and after');
});

test('GM credit (round 21, review): a Session done tap cut off before this went live (credited, no record) is never paid again', async () => {
  const id = await list();
  await seat(id, MIA, 'Mia', { paid: true });
  lair.sql.exec('UPDATE games SET credited = 1 WHERE id = ?', id);
  nowIs(at('2026-10-27', 22, 10));
  assert.equal(await lair.autoGmCredit(Date.now()), null);
  assert.deepEqual(creditCalls, []);
  // the floor leaves it to the card's own words (GM credited for 1 player)
  assert.equal('gmCredit' in (await gameOn(id)), false);
});

test('GM credit (round 21, review): a failed Shopify login is "nothing sent": tried again, not left for staff to check', async () => {
  const { ShopifyAdmin } = await import('../src/shopify.js');
  const admin = new ShopifyAdmin({ SHOP: 'test.myshopify.com', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret' }, { get: async () => null, put: async () => {}, delete: async () => {} });
  admin.accessToken = async () => {
    throw new Error('Shopify login failed (401): bad credentials');
  };
  await assert.rejects(admin.creditCustomer('5001', 500, 'NZD'), (e) => e.refused === true && /login failed/.test(e.message));
});

test('GM credit (round 21, review): the GM can\'t change while a credit is with Shopify; a credited seat\'s payment undone tells staff', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia', { paid: true });
  nowIs(at('2026-10-27', 22, 10));
  // with Shopify: the GM stays put
  let release;
  lair.shopify.creditCustomer = (customerId, cents) => new Promise((resolve) => {
    release = () => {
      credited.push([customerId, cents]);
      resolve({ amount: { amount: (cents / 100).toFixed(2) } });
    };
  });
  const running = lair.autoGmCredit(Date.now());
  for (let i = 0; i < 20 && !release; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.ok(release, 'with Shopify');
  assert.equal(said(await call('POST', `games/${id}/gm`, { gmCustomerId: WIREMU, gmCustomerName: 'Wiremu', gmEmail: 'wiremu@example.com' }, OWNER)), `409 ${GM_SESSION_WORDS.gmCredited}`);
  release();
  await running;
  assert.deepEqual(credited, [[RANGI, 500]]);
  // Mia's payment was a mistake: unmarked, staff hear Rangi has credit for it
  ok(await call('POST', `bookings/${mias.id}/update`, { paid: false }, OWNER));
  assert.deepEqual(alerts.map((a) => a.subject), ['GM credit to check: Rangi Hohaia']);
  assert.equal(alerts[0].intro, W.undone('Rangi Hohaia', '$5.00', "Mia's seat at Rangi's one-shot", "isn't marked paid any more"));
});

test('GM credit (round 21, review): each seat counts its own tries; a tap answers for its own session only', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia', { paid: true });
  await seat(id, KAI, 'Kai', { paid: true });
  const other = await list({ tables: ['B2'], title: 'Other one', start: at('2026-10-28', 18), end: at('2026-10-28', 22) });
  const rias = await seat(other, RIA, 'Ria', { paid: true });
  // Mia's seat has been refused four times already; Kai's is new
  lair.sql.exec("INSERT INTO gm_credit_seats (booking_id, game_id, customer_id, people, amount, status, batch, note, tries, created_at, updated_at) VALUES (?, ?, ?, 1, 500, 'retry', 'gc_old', NULL, 4, ?, ?)", mias.id, id, RANGI, NOW, NOW);
  nowIs(at('2026-10-27', 22, 10));
  shopifySays = 'refuse';
  const run = await lair.autoGmCredit(Date.now());
  assert.deepEqual([run.failed, run.retry], [1, 1]);
  assert.deepEqual(ledger(id).map((r) => [r.booking_id === mias.id ? 'Mia' : 'Kai', r.status, r.tries]).sort(), [['Kai', 'retry', 1], ['Mia', 'failed', 5]]);
  shopifySays = null;
  // a store credit stuck with Shopify for another session (an hour, so this tap finds it's to check) doesn't change what
  // this session's tap says
  lair.sql.exec("INSERT INTO gm_credit_seats (booking_id, game_id, customer_id, people, amount, status, batch, note, tries, created_at, updated_at) VALUES (?, ?, ?, 1, 500, 'sending', 'gc_stuck', NULL, 0, ?, ?)", rias.id, other, RANGI, at('2026-10-27', 21), at('2026-10-27', 21));
  const tap = ok(await credit(id));
  assert.equal(ledger(other)[0].status, 'check');
  assert.deepEqual([tap.status, tap.players, tap.amount], ['credited', 1, 500], "Kai's, now");
});

test('GM stamps (round 21, review): the team as it was when the session started; players who don\'t book through the Lair count', async () => {
  const rangis = await list();
  await seat(rangis, MIA, 'Mia');
  const anas = await list({ gm: ANA, tables: ['B2'] });
  await seat(anas, KAI, 'Kai');
  // Rangi is made a helper after his session, and Ana stops being one after hers
  nowIs(at('2026-10-28', 10));
  ok(await call('POST', 'team', { customerId: RANGI, name: 'Rangi Hohaia', email: 'rangi@example.com', perms: ['sessions'] }, OWNER));
  ok(await call('POST', `team/${ANA}/remove`, {}, OWNER));
  assert.deepEqual(await lair.gmRunUpkeep(Date.now()), { looked: 2 });
  assert.deepEqual([stamps(RANGI), stamps(ANA)], [1, 0], 'Rangi wasn\'t staff then; Ana was');
  // a session whose players are all ones the group already had (offline players): it ran
  const group = await list({ gm: WIREMU, tables: ['B3'], start: at('2026-10-29', 18), end: at('2026-10-29', 22) });
  lair.sql.exec('UPDATE games SET offline_players = 3 WHERE id = ?', group);
  nowIs(at('2026-10-29', 19));
  await lair.gmRunUpkeep(Date.now());
  assert.equal(stamps(WIREMU), 1);
});

test('GM credit (round 21, review): the floor\'s figures hold when a credited seat is cancelled; a waived seat isn\'t "still to pay"', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia', { paid: true });
  const kais = await seat(id, KAI, 'Kai');
  nowIs(at('2026-10-27', 22, 10));
  await lair.autoGmCredit(Date.now());
  ok(await call('POST', `bookings/${kais.id}/update`, { waived: true }, OWNER));
  ok(await call('POST', `bookings/${mias.id}/update`, { status: 'cancelled' }, OWNER));
  const view = (await gameOn(id)).gmCredit;
  assert.deepEqual([view.credited, view.unpaid, view.toCome], [{ players: 1, amount: 500 }, { players: 0 }, { players: 0 }]);
  assert.equal(creditedOf(id), 1);
});

test('GM credit (round 21): the staff floor with more than 100 sessions from 26 Oct 2026 (Cloudflare takes 100 bound values a query)', async () => {
  // 27 Oct 2026: one bound value per session in gmCreditsIn broke the whole staff floor, and the staff page showed no games
  const days = ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
  const ids = [];
  for (const day of days) {
    for (let t = 1; t <= 20; t += 1) ids.push(await list({ start: at(day, 18), end: at(day, 22), tables: [`T${t}`], title: `Session ${day} T${t}` }));
  }
  assert.equal(ids.length, 120);
  const mias = await seat(ids[0], MIA, 'Mia', { paid: true });
  await seat(ids[1], KAI, 'Kai');
  const games = (await board(OWNER)).games;
  assert.equal(games.filter((g) => ids.includes(g.id)).length, 120);
  const first = games.find((g) => g.id === ids[0]);
  assert.deepEqual([first.gmCredit.auto, first.gmCredit.toCome.players], [true, 1]);
  assert.equal(games.find((g) => g.id === ids[1]).gmCredit.unpaid.players, 1);
  assert.ok(mias.ref);
});

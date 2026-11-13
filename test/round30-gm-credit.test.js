// Round 30: GM credit as each player pays, and the plain RPG Session paying the player's seat (contract
// v30-credit). Mo (6 Nov 2026): "have the ability to add the gm store credit after every client is paid inside a game.
// So gms are incentivized to keep the players inside the system and using Thier app to pay for things ... But also the
// store credit are not updating properly."
//
// Seen on the live store (orders from 26 Oct to 5 Nov 2026): about 49 TTRPG seats were rung up at the counter as the
// plain Session product's RPG Session (or RPG Kids Session), and about 29 through the Lair tile. A plain RPG Session
// didn't say which seat it paid, so the seat stayed unpaid and its GM never got their fee. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { GM_CREDIT, GM_CREDIT_WORDS as W } from '../src/gm-credit.js';
import { ORDERMATE } from '../src/counter.js';

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
const OWNER = '9001';
const ANA = '9101';
const RANGI = '5001';
const WIREMU = '5002';
const MIA = '6001';
const KAI = '6002';
const RIA = '6003';
const NAMES = { [OWNER]: 'Mo', [ANA]: 'Ana', [RANGI]: 'Rangi', [WIREMU]: 'Wiremu' };

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
const paidOrder = (order) => internal('orders-paid', order);
const credit = (id, body = {}, who = OWNER) => call('POST', `games/${id}/credit`, body, who);
const ledger = (gameId) => lair.sql.exec('SELECT booking_id, customer_id, people, amount, status FROM gm_credit_seats WHERE game_id = ? ORDER BY created_at, booking_id', gameId).toArray().map((r) => ({ ...r }));
const creditRows = (gameId) => lair.sql.exec('SELECT customer_id, players, amount, status, by FROM credits WHERE game_id = ? ORDER BY rowid', gameId).toArray().map((r) => ({ ...r }));
const seatRow = (id) => lair.sql.exec('SELECT paid, paid_amount, amount, status FROM bookings WHERE id = ?', id).one();
const paymentsOf = (bookingId) => lair.sql.exec('SELECT order_id, line_id, amount, customer_id FROM payments WHERE booking_id = ? ORDER BY at, rowid', bookingId).toArray().map((r) => ({ ...r }));
// the GM credit a payment set going in the background has finished
const settled = async () => {
  for (let i = 0; i < 5; i += 1) await lair.gmCreditRun;
};

/** A session listed by the main account for a GM (Rangi unless said), Tuesday 27 October 6pm to 10pm unless said */
async function list({ gm = RANGI, start = at('2026-10-27', 18), end = at('2026-10-27', 22), seats = 4, gmFee, tables = ['B1'], title } = {}) {
  const name = NAMES[gm] || 'Hemi';
  return ok(await call('POST', 'games', {
    title: title || `${name}'s one-shot`, system: 'D&D 5e', gm: name, blurb: 'A test session.', seats, tables, start, end,
    gmCustomerId: gm, gmCustomerName: name, gmEmail: `${name.toLowerCase()}@example.com`, ...(gmFee === undefined ? {} : { gmFee }),
  }, OWNER)).game.id;
}

/** A seat booked online by a member (pay at the Lair) → the booking */
async function seat(gameId, who, name, { people = 1 } = {}) {
  return ok(await call('POST', 'bookings', {
    kind: 'gm-seat', gameId, people, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100', pay: 'day',
  }, who)).booking;
}
const pay = (booking) => call('POST', `bookings/${booking.id}/update`, { paid: true }, OWNER).then(ok);

/** A card sale on Pay on Verifone, as OrderMate saves it: its own source and tags, and lines without properties */
const verifone = (n, lineItems, extra = {}) => ({
  id: n, admin_graphql_api_id: `gid://shopify/Order/${n}`, name: `#${n}`, source_name: ORDERMATE.app, tags: 'OrderMate, Verifone', line_items: lineItems, ...extra,
});
/** A custom sale as OrderMate keeps it: the title the tile gave it, no product, no properties */
const custom = (id, title, amount) => ({ id, title, quantity: 1, price: amount.toFixed(2), product_id: null, variant_id: null, sku: null, properties: [] });
/** The Session product rung up by hand (the POS grid's tile), with its SKU */
const sessionProduct = (id, variant, sku, quantity = 1, price = '15.00') => ({ id, title: 'Session', variant_title: variant, sku, quantity, price, product_id: 7666520621159, variant_id: 44114668486759, properties: [] });
const rpg = (id, quantity = 1) => sessionProduct(id, 'RPG Session', 'LAIR-SESSION-RPG', quantity, '15.00');
const rpgKids = (id, quantity = 1) => sessionProduct(id, 'RPG Kids Session', 'LAIR-SESSION-RPG-KIDS', quantity, '10.00');
/** Whose sale it was, as Shopify answers the Lair's question about the order (null: nobody on it) */
const customerIs = (customerId) => {
  lair.shopify.orderSpend = async (orderId) => (customerId ? { customerId, amount: 1500, name: `#${orderId.split('/').pop()}`, source: ORDERMATE.app } : null);
};

// No network in these tests: no Shopify and no emails. Anything that reaches for it is noted, and the test fails.
const realFetch = globalThis.fetch;
let reached = [];
let credited = [];
let creditCalls = [];
let alerts = [];

beforeEach(async () => {
  reached = [];
  credited = [];
  creditCalls = [];
  alerts = [];
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
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.creditCustomer = async (customerId, cents, currency, options) => {
    creditCalls.push([customerId, cents, currency, options]);
    credited.push([customerId, cents]);
    return { amount: { amount: (cents / 100).toFixed(2) } };
  };
  lair.notifyStaff = (subject, content) => alerts.push({ subject, intro: content.intro });
  lair.confirm = () => {};
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  ok(await call('POST', 'team', { customerId: ANA, name: 'Ana Ngata', email: 'ana@example.com', perms: ['sessions'] }, OWNER));
  for (const [id, name] of [[RANGI, 'Rangi Hohaia'], [WIREMU, 'Wiremu Paki'], [MIA, 'Mia Chen'], [KAI, 'Kai Tane'], [RIA, 'Ria Moana']]) {
    lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
  }
});
afterEach(async () => {
  await settled();
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

/* ---------------- the words ---------------- */

test('round 30: the words, word for word', () => {
  assert.equal(W.notStarted, "GM credit adds itself for this session: once it's started, the GM gets their fee as each player pays. There's nothing to tap.");
  assert.equal(W.markedOff, "Marked: they weren't working, so they get their GM credit as their players pay.");
  assert.equal(W.cancelled, 'was cancelled');
  // the GM's emails and pages: the credit for each paying player, as they pay
  assert.equal(lair.gmCreditLine({ gmFee: 500 }, lair.rulesCache), '$5.00 store credit for each paying player, as they pay');
});

/* ---------------- GM credit as each player pays ---------------- */

test('GM credit (round 30): once the session has started, each seat gives its GM their fee as soon as it\'s paid, without waiting for the 10-minute run', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia', { people: 2 });
  const kais = await seat(id, KAI, 'Kai');
  // 6:20pm, the session's on: Mia pays for her two seats (staff mark it paid): Rangi's $10 goes straight away
  nowIs(at('2026-10-27', 18, 20));
  await pay(mias);
  await settled();
  assert.deepEqual(creditCalls, [[RANGI, 1000, 'NZD', { timeout: GM_CREDIT.timeoutMs, notify: false }]], 'no email from Shopify each time (Mo: one email a session)');
  assert.deepEqual(ledger(id).map((r) => [r.booking_id, r.customer_id, r.people, r.amount, r.status]), [[mias.id, RANGI, 2, 1000, 'credited']]);
  // 9:55pm: Kai pays by card at the counter (the tile's line, through Pay on Verifone): his $5 goes straight away too
  nowIs(at('2026-10-27', 21, 55));
  ok(await paidOrder(verifone(9001, [custom(1, `GM seat: Rangi's one-shot (${kais.ref})`, 15)], { customer: { id: Number(KAI) } })));
  await settled();
  assert.deepEqual(credited, [[RANGI, 1000], [RANGI, 500]]);
  assert.deepEqual(creditRows(id).map((r) => [r.players, r.amount, r.status, r.by]), [[2, 1000, 'credited', 'auto'], [1, 500, 'credited', 'auto']]);
  // the 10-minute run finds nothing more to do, and nothing is ever paid twice
  assert.equal(await lair.autoGmCredit(Date.now()), null);
  nowIs(at('2026-10-27', 22, 10));
  assert.equal(await lair.autoGmCredit(Date.now()), null);
  assert.equal(creditCalls.length, 2);
  // the same payment sent again by Shopify pays nothing more
  ok(await paidOrder(verifone(9001, [custom(1, `GM seat: Rangi's one-shot (${kais.ref})`, 15)], { customer: { id: Number(KAI) } })));
  await settled();
  assert.equal(creditCalls.length, 2);
});

test('GM credit (round 30): a seat paid before the session starts gives its GM their fee once it starts, and not before', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  nowIs(at('2026-10-27', 15));
  await pay(mias);
  await settled();
  assert.deepEqual(creditCalls, [], 'paid at 3pm, the session is at 6pm');
  nowIs(at('2026-10-27', 18) - 60_000);
  assert.equal(await lair.autoGmCredit(Date.now()), null);
  nowIs(at('2026-10-27', 18));
  assert.deepEqual(await lair.autoGmCredit(Date.now()), { credited: 1, amount: 500, staff: 0, manual: 0, retry: 0, failed: 0, check: 0 });
  assert.deepEqual(credited, [[RANGI, 500]]);
});

test('GM credit (round 30): nothing while unpaid, for a free session or a $0 GM fee; a staff GM\'s is still kept by the team\'s setting', async () => {
  const unpaid = await list();
  await seat(unpaid, MIA, 'Mia');
  const free = await list({ tables: ['B2'], title: 'Free night' });
  ok(await call('POST', `games/${free}/free`, { free: true }, OWNER));
  const freeSeat = await seat(free, KAI, 'Kai');
  const noFee = await list({ tables: ['B3'], gmFee: 0, title: 'No fee' });
  const noFeeSeat = await seat(noFee, RIA, 'Ria');
  const anas = await list({ gm: ANA, tables: ['B4'] });
  const anasSeat = await seat(anas, MIA, 'Mia');
  nowIs(at('2026-10-27', 19));
  await pay(freeSeat);
  await pay(noFeeSeat);
  await pay(anasSeat);
  await settled();
  assert.deepEqual(creditCalls, [], "nothing to Rangi for Mia's unpaid seat, nothing for the free or $0 sessions, nothing to Ana (staff)");
  assert.deepEqual(ledger(anas).map((r) => [r.customer_id, r.amount, r.status]), [[ANA, 0, 'staff']], "Ana's kept, as the team's Never setting says");
});

test('GM credit (round 30): Session done before a session starts says why; once it\'s started it credits who\'s paid now', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  nowIs(at('2026-10-27', 17));
  assert.equal(said(await credit(id)), `409 ${W.notStarted}`);
  nowIs(at('2026-10-27', 18, 5));
  assert.deepEqual(ok(await credit(id)), { players: 0, amount: 0, status: 'none', note: W.nothingYet, auto: true });
  // paid, then the tap before the background credit has been: the tap does it, once
  lair.gmCreditSoon = () => null;
  await pay(mias);
  assert.deepEqual(ok(await credit(id)), { players: 1, amount: 500, status: 'credited', note: '', auto: true });
  assert.deepEqual(ok(await credit(id)), { players: 0, amount: 0, status: 'none', note: W.allDone, auto: true });
  assert.deepEqual(credited, [[RANGI, 500]]);
});

test('GM credit (round 30, from the review): a GM credit Shopify said no to waits 10 minutes before it\'s tried again, however many players pay meanwhile', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  const kais = await seat(id, KAI, 'Kai');
  const rias = await seat(id, RIA, 'Ria');
  let refuse = true;
  lair.shopify.creditCustomer = async (customerId, cents) => {
    creditCalls.push([customerId, cents]);
    if (refuse) throw Object.assign(new Error('Too many requests'), { refused: true });
    credited.push([customerId, cents]);
    return { amount: { amount: (cents / 100).toFixed(2) } };
  };
  const tries = () => Object.fromEntries(lair.sql.exec('SELECT booking_id, status, tries FROM gm_credit_seats WHERE game_id = ?', id).toArray().map((r) => [r.booking_id, `${r.status} ${r.tries}`]));
  // 6:20pm: Mia pays, and Shopify says no (it's busy): her seat waits to be tried again
  nowIs(at('2026-10-27', 18, 20));
  await pay(mias);
  await settled();
  assert.deepEqual(tries(), { [mias.id]: 'retry 1' });
  // Kai and Ria pay over the next few minutes: only their own seats are tried, never Mia's again this soon
  nowIs(at('2026-10-27', 18, 22));
  await pay(kais);
  await settled();
  nowIs(at('2026-10-27', 18, 25));
  await pay(rias);
  await settled();
  assert.deepEqual(tries(), { [mias.id]: 'retry 1', [kais.id]: 'retry 1', [rias.id]: 'retry 1' }, 'a payment never spends another seat\'s tries');
  assert.equal(await lair.autoGmCredit(Date.now()), null, 'the 10-minute run straight after: nothing is due again yet');
  // 10 minutes after Mia's try, Shopify takes it: her seat goes, and the others in their turn
  refuse = false;
  nowIs(at('2026-10-27', 18, 30));
  await lair.autoGmCredit(Date.now());
  assert.deepEqual(tries(), { [mias.id]: 'credited 1', [kais.id]: 'retry 1', [rias.id]: 'retry 1' });
  nowIs(at('2026-10-27', 18, 35));
  await lair.autoGmCredit(Date.now());
  assert.deepEqual(tries(), { [mias.id]: 'credited 1', [kais.id]: 'credited 1', [rias.id]: 'credited 1' });
  assert.deepEqual(credited, [[RANGI, 500], [RANGI, 1000]]);
  assert.deepEqual(alerts.filter((a) => /by hand/.test(a.subject)), [], 'nothing for staff to add by hand');
});

test('GM credit (round 30): a session cancelled after its GM had credit for it tells staff, who decide; nothing is taken back by itself', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  nowIs(at('2026-10-27', 18, 10));
  await pay(mias);
  await settled();
  assert.deepEqual(credited, [[RANGI, 500]]);
  // the rest of the group didn't come, so it's called off 20 minutes in. Round 37: by staff (a GM could, until an hour
  // after it starts; now a GM cancels until 24 hours before, and after that it's staff)
  nowIs(at('2026-10-27', 18, 30));
  ok(await call('POST', `games/${id}/update`, { status: 'cancelled' }, OWNER));
  assert.deepEqual(alerts.filter((a) => a.subject.startsWith('GM credit')).map((a) => [a.subject, a.intro]), [
    ['GM credit to check: Rangi Hohaia', W.undone('Rangi Hohaia', '$5.00', "Mia's seat at Rangi's one-shot", W.cancelled)],
  ]);
  assert.equal(seatRow(mias.id).status, 'cancelled');
  assert.deepEqual(credited, [[RANGI, 500]], 'nothing taken back by itself');
});

test('GM credit (round 30): a GM\'s players in My Lair say whose fee has gone to them, whose is on its way, and who still pays', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  const kais = await seat(id, KAI, 'Kai');
  await seat(id, RIA, 'Ria');
  nowIs(at('2026-10-27', 18, 30));
  await pay(mias);
  await settled();
  lair.gmCreditSoon = () => null;
  await pay(kais);
  const game = ok(await call('GET', 'me', null, RANGI)).games.find((g) => g.id === id);
  assert.deepEqual(game.players.map((p) => [p.name, p.paid, p.gmCredit]), [['Mia', true, 'credited'], ['Kai', true, 'coming'], ['Ria', false, null]]);
  assert.equal(game.gmFee, 500);
});

test('GM credit (round 30): a GM\'s games in My Lair say what they get for each player who pays (gmCreditEach): the GM fee, or 0 when there\'s none to get', async () => {
  const priced = await list();
  const tenner = await list({ tables: ['B2'], gmFee: 1000, title: 'Ten a head' });
  const noFee = await list({ tables: ['B3'], gmFee: 0, title: 'No fee' });
  const free = await list({ start: at('2026-10-28', 18), end: at('2026-10-28', 22), title: 'Free night' });
  ok(await call('POST', `games/${free}/free`, { free: true }, OWNER));
  const anas = await list({ gm: ANA, tables: ['B4'] });
  const each = async (who) => Object.fromEntries(ok(await call('GET', 'me', null, who)).games.map((g) => [g.id, g.gmCreditEach]));
  assert.deepEqual(await each(RANGI), { [priced]: 500, [tenner]: 1000, [noFee]: 0, [free]: 0 });
  assert.deepEqual(await each(ANA), { [anas]: 0 }, 'Ana is on the team, and its setting says staff GMs never get it');
  // (from the review) a session with no fee of its own takes the shop's: with the shop's at $0, there's none, and a paid
  // player's fee isn't "on its way" either
  lair.sql.exec('UPDATE games SET gm_fee = NULL WHERE id = ?', priced);
  const mias = await seat(priced, MIA, 'Mia');
  await pay(mias);
  lair.rulesCache.prices.gmCredit = 0;
  const game = ok(await call('GET', 'me', null, RANGI)).games.find((g) => g.id === priced);
  assert.deepEqual([game.gmCreditEach, game.players.map((p) => [p.name, p.paid, p.gmCredit])], [0, [['Mia', true, null]]]);
});

/* ---------------- one email a session (Mo, 6 Nov 2026: "One email for all the players per session") ---------------- */

/**
 * The GM credit emails the Lair sends, as Resend would take them, with the email set up (listing a game and booking a
 * seat send emails of their own, which Resend takes and aren't kept here)
 */
function mailbox({ answer = () => ({ attempted: true, ok: true, status: 200 }) } = {}) {
  const keys = { RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <lair@dicegoblin.test>' };
  lair.baseEnv = { ...lair.baseEnv, ...keys };
  lair.env = { ...lair.env, ...keys };
  const sent = [];
  lair.mail = async (message) => {
    if (!String(message.subject || '').startsWith('Your GM credit')) return { attempted: true, ok: true, status: 200 };
    sent.push(message);
    return answer(message, sent.length);
  };
  return sent;
}

test('GM credit (round 30): one email a session: the fees land quietly as each player pays, and an hour after it ends Gobgob emails the GM once with who paid and the total', async () => {
  const sent = mailbox();
  const id = await list();
  const mias = await seat(id, MIA, 'Mia', { people: 2 });
  const kais = await seat(id, KAI, 'Kai');
  const rias = await seat(id, RIA, 'Ria');
  nowIs(at('2026-10-27', 18, 20));
  await pay(mias);
  await settled();
  nowIs(at('2026-10-27', 21, 55));
  await pay(kais);
  await settled();
  assert.deepEqual(credited, [[RANGI, 1000], [RANGI, 500]]);
  assert.ok(creditCalls.every((c) => c[3]?.notify === false), 'Shopify sends no email for any of them');
  assert.deepEqual(sent, [], 'nothing yet: the session is on');
  // 10:30pm, half an hour after it ended: not yet (late payers at the counter still count)
  nowIs(at('2026-10-27', 22, 30));
  assert.equal(await lair.gmCreditMails(Date.now()), null);
  // 11pm, an hour after: one email to Rangi, for the three players who paid
  nowIs(at('2026-10-27', 23, 0));
  assert.deepEqual(await lair.gmCreditMails(Date.now()), { sent: 1 });
  assert.equal(sent.length, 1);
  const [mail] = sent;
  assert.equal(mail.to, 'rangi@example.com');
  assert.equal(mail.subject, "Your GM credit for Rangi's one-shot: $15.00");
  assert.match(mail.text, /Kia ora Rangi, \$15\.00 of store credit is on your account for Rangi's one-shot: \$5\.00 for each of the 3 players who paid\./);
  assert.match(mail.text, /Players who paid: Mia \(2\), Kai/);
  assert.match(mail.text, /See it in My Lair: https:\/\/www\.dicegoblin\.nz\/pages\/my-lair\?view=ml-games\n/, 'Games I run, in My Lair');
  assert.equal(mail.idempotencyKey, `gm-credit-mail-${id}-${RANGI}`);
  assert.match(mail.text, /Anyone who pays later still sends you their \$5\.00\. It lands on your store credit without an email, and My Lair shows it under Games I run\./);
  assert.ok(!/Ria/.test(mail.text), "Ria hasn't paid");
  // never twice: a run again, and Ria paying the next day, land quietly
  assert.equal(await lair.gmCreditMails(Date.now()), null);
  nowIs(at('2026-10-28', 12));
  await pay(rias);
  await settled();
  await lair.autoGmCredit(Date.now());
  assert.deepEqual(credited, [[RANGI, 1000], [RANGI, 500], [RANGI, 500]]);
  assert.equal(await lair.gmCreditMails(Date.now()), null);
  assert.equal(sent.length, 1);
});

test('GM credit (round 30): the one email: none for a session whose credit Shopify emailed about before, nothing paid, staff GMs, or sessions long gone; Resend down or not answering: tried again next run, never twice; an address Resend refuses: not again', async () => {
  // Resend busy, then not answering in time, then fine; and it refuses Hemi's address
  const answers = [{ attempted: true, ok: false, status: 503, message: 'busy' }, { attempted: true, ok: false, status: 0, message: 'The operation timed out.' }];
  const sent = mailbox({
    answer: (m) => (m.to === 'hemi@example.com' ? { attempted: true, ok: false, status: 422, message: 'Invalid `to` field.' } : answers.shift() || { attempted: true, ok: true, status: 200 }),
  });
  // Tuesday's sessions: one credited before this round (Shopify emailed the GM then), one nobody paid for, a staff GM's
  // (kept by the team's setting), and Wiremu's, paid
  const before = await list();
  const old = await seat(before, MIA, 'Mia');
  const after = await seat(before, KAI, 'Kai');
  const empty = await list({ tables: ['B2'], title: 'Empty night' });
  await seat(empty, KAI, 'Kai');
  const anas = await list({ gm: ANA, tables: ['B3'] });
  const anaSeat = await seat(anas, RIA, 'Ria');
  const wiremus = await list({ gm: WIREMU, tables: ['B4'], title: "Wiremu's game" });
  const kais = await seat(wiremus, KAI, 'Kai');
  const hemis = await list({ gm: '5003', tables: ['T1'], title: "Hemi's game" });
  const hemiSeat = await seat(hemis, RIA, 'Ria');
  // and Thursday's, which the Lair only gets to two days and more after it ends
  const lateGame = await list({ start: at('2026-10-29', 18), end: at('2026-10-29', 22), tables: ['B1'], title: 'Late one' });
  const lateSeat = await seat(lateGame, MIA, 'Mia');
  nowIs(at('2026-10-27', 19));
  for (const booking of [old, anaSeat, kais, hemiSeat]) {
    await pay(booking);
    await settled();
  }
  lair.sql.exec('UPDATE gm_credit_seats SET quiet = 0 WHERE game_id = ?', before);
  // (Kai pays for Rangi's after this went live: his lands quietly, but Rangi heard about Mia's from Shopify, so an email
  // about Kai's alone would tell half the story)
  await pay(after);
  await settled();
  assert.deepEqual(credited, [[RANGI, 500], [WIREMU, 500], ['5003', 500], [RANGI, 500]], 'Ana is on the team: no credit, so no email');
  const wiremuMails = () => sent.filter((m) => m.to === 'wiremu@example.com');
  nowIs(at('2026-10-27', 23, 5));
  assert.deepEqual(await lair.gmCreditMails(Date.now()), { retry: 1, failed: 1 }, "Resend busy: Wiremu's is tried again next run; Hemi's address refused");
  assert.deepEqual(sent.map((m) => m.to).sort(), ['hemi@example.com', 'wiremu@example.com']);
  nowIs(at('2026-10-27', 23, 15));
  assert.deepEqual(await lair.gmCreditMails(Date.now()), { retry: 1 }, 'Resend not answering in time: tried again too');
  nowIs(at('2026-10-27', 23, 25));
  assert.deepEqual(await lair.gmCreditMails(Date.now()), { sent: 1 });
  assert.equal(wiremuMails().length, 3);
  assert.equal(new Set(wiremuMails().map((m) => m.idempotencyKey)).size, 1, 'the same key each time, so a send Resend did take is never sent twice');
  assert.equal(await lair.gmCreditMails(Date.now()), null);
  assert.equal(sent.filter((m) => m.to === 'hemi@example.com').length, 1, "Hemi's isn't tried again");
  // a session none of whose credit landed in the last two days never gets one (email that was off for days doesn't send
  // about old sessions)
  nowIs(at('2026-10-29', 19));
  await pay(lateSeat);
  await settled();
  nowIs(at('2026-11-01', 9));
  assert.equal(await lair.gmCreditMails(Date.now()), null);
  assert.equal(sent.length, 4);
});

test('GM credit (round 30): the one email: nobody paid on the day (a monthly account\'s bill comes later), so it goes once some credit lands; a claim left with no answer (the Lair restarted mid-send) is tried again after 30 minutes, with the same key', async () => {
  const sent = mailbox();
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  const kais = await seat(id, KAI, 'Kai');
  nowIs(at('2026-10-27', 23));
  await lair.autoGmCredit(Date.now());
  assert.equal(await lair.gmCreditMails(Date.now()), null, 'nothing paid, nothing landed');
  // Sunday: Mia's monthly bill is paid, so her seat is
  nowIs(at('2026-11-01', 10));
  await pay(mias);
  await settled();
  assert.deepEqual(credited, [[RANGI, 500]]);
  // a run that was cut off part-way left its claim with no answer: one 5 minutes old may still be going, so it's left
  lair.sql.exec("INSERT INTO gm_credit_mails (game_id, customer_id, players, amount, status, created_at) VALUES (?, ?, 1, 500, 'sending', ?)", id, RANGI, Date.now() - 5 * 60_000);
  assert.equal(await lair.gmCreditMails(Date.now()), null);
  nowIs(at('2026-11-01', 10, 26));
  assert.deepEqual(await lair.gmCreditMails(Date.now()), { sent: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].idempotencyKey, `gm-credit-mail-${id}-${RANGI}`, 'its same key, so Resend never sends it twice');
  assert.match(sent[0].text, /\$5\.00 for the 1 player who paid\./);
  assert.match(sent[0].text, /Players who paid: Mia\n/);
  // Kai's bill a week on: quietly, as the email said
  nowIs(at('2026-11-08', 10));
  await pay(kais);
  await settled();
  assert.deepEqual(credited, [[RANGI, 500], [RANGI, 500]]);
  assert.equal(await lair.gmCreditMails(Date.now()), null);
  assert.equal(sent.length, 1);
});

/* ---------------- the plain RPG Session pays the player's seat ---------------- */

test('the counter (round 30): a plain RPG Session rung up for a player with a seat that day pays it, and its GM gets their fee straight away', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  nowIs(at('2026-10-27', 21, 50));
  customerIs(MIA);
  const answer = ok(await paidOrder(verifone(9101, [rpg(1)], { customer: { id: Number(MIA) } })));
  await settled();
  assert.deepEqual(answer.sessionsPaid, [mias.ref]);
  assert.deepEqual({ ...seatRow(mias.id) }, { paid: 1, paid_amount: 1500, amount: 1500, status: 'confirmed' });
  assert.deepEqual(paymentsOf(mias.id), [{ order_id: 'gid://shopify/Order/9101', line_id: '1:seat-0', amount: 1500, customer_id: MIA }]);
  assert.deepEqual(credited, [[RANGI, 500]]);
  // one stamp for Mia that day: the seat and the sale are the same session
  assert.equal(lair.stampCount(MIA), 1);
  // Shopify sends the order again: nothing more is paid or credited
  ok(await paidOrder(verifone(9101, [rpg(1)], { customer: { id: Number(MIA) } })));
  await settled();
  assert.equal(paymentsOf(mias.id).length, 1);
  assert.deepEqual(credited, [[RANGI, 500]]);
  assert.deepEqual(alerts.filter((a) => /twice|Overpaid/.test(a.subject)), []);
});

test('the counter (round 30): a plain RPG Session pays only what it covers, one person a unit, on the sale\'s day, for the player on the sale', async () => {
  // Mia and a friend on one seat (two people), Kai's seat on a $10-fee game, Ria's tomorrow
  const tonight = await list();
  const mias = await seat(tonight, MIA, 'Mia', { people: 2 });
  const dear = await list({ tables: ['B2'], gmFee: 1000, title: 'Big fee' });
  const kais = await seat(dear, KAI, 'Kai');
  const tomorrow = await list({ start: at('2026-10-28', 18), end: at('2026-10-28', 22), title: 'Wednesday' });
  const rias = await seat(tomorrow, RIA, 'Ria');
  nowIs(at('2026-10-27', 19));
  // nobody on the sale: nothing to tell whose seat it was
  customerIs(null);
  ok(await paidOrder(verifone(9201, [rpg(1)])));
  assert.equal(seatRow(mias.id).paid_amount, 0);
  // Mia buys one RPG Session: half her seat (one person of two); then another: all of it, and Rangi's $10
  customerIs(MIA);
  ok(await paidOrder(verifone(9202, [rpg(1)], { customer: { id: Number(MIA) } })));
  assert.deepEqual([seatRow(mias.id).paid, seatRow(mias.id).paid_amount], [0, 1500]);
  ok(await paidOrder(verifone(9203, [rpg(1)], { customer: { id: Number(MIA) } })));
  assert.deepEqual([seatRow(mias.id).paid, seatRow(mias.id).paid_amount], [1, 3000]);
  await settled();
  assert.deepEqual(credited, [[RANGI, 1000]]);
  // Kai's seat costs $20: a $15 RPG Session leaves $5 to pay, so no GM credit yet
  customerIs(KAI);
  ok(await paidOrder(verifone(9204, [rpg(1)], { customer: { id: Number(KAI) } })));
  assert.deepEqual([seatRow(kais.id).paid, seatRow(kais.id).paid_amount], [0, 1500]);
  await settled();
  assert.equal(credited.length, 1);
  // Ria's seat is tomorrow: an RPG Session today isn't for it
  customerIs(RIA);
  ok(await paidOrder(verifone(9205, [rpg(1)], { customer: { id: Number(RIA) } })));
  assert.equal(seatRow(rias.id).paid_amount, 0);
  // an RPG Kids Session ($10) for Ria tomorrow, with her seat there: $10 of $15
  nowIs(at('2026-10-28', 18, 30));
  ok(await paidOrder(verifone(9206, [rpgKids(1)], { customer: { id: Number(RIA) } })));
  assert.deepEqual([seatRow(rias.id).paid, seatRow(rias.id).paid_amount], [0, 1000]);
  // an online order never pays a seat this way
  customerIs(KAI);
  ok(await paidOrder({ ...verifone(9207, [rpg(1)], { customer: { id: Number(KAI) } }), source_name: 'web', tags: '' }));
  assert.equal(seatRow(kais.id).paid_amount, 1500);
});

test('the counter (round 30): a plain RPG Session for a seat already paid, its GM paying for it, or a Day Pass pays nothing more', async () => {
  const id = await list();
  const mias = await seat(id, MIA, 'Mia');
  const kais = await seat(id, KAI, 'Kai');
  nowIs(at('2026-10-27', 19));
  // Mia paid through the tile, and the RPG Session was rung up too: nothing paid twice
  customerIs(MIA);
  ok(await paidOrder(verifone(9301, [custom(1, `GM seat: Rangi's one-shot (${mias.ref})`, 15), rpg(2)], { customer: { id: Number(MIA) } })));
  assert.deepEqual(paymentsOf(mias.id).map((p) => [p.line_id, p.amount]), [['1', 1500]]);
  // Rangi pays for Kai's seat: an RPG Session on Kai's sale isn't for it
  ok(await call('POST', `games/${id}/players/${encodeURIComponent(kais.ref)}/cover`, {}, RANGI));
  customerIs(KAI);
  ok(await paidOrder(verifone(9302, [rpg(1)], { customer: { id: Number(KAI) } })));
  assert.deepEqual(paymentsOf(kais.id), []);
  // a Day Pass is a table's session, not a TTRPG seat's
  const ria = await seat(id, RIA, 'Ria');
  customerIs(RIA);
  ok(await paidOrder(verifone(9303, [sessionProduct(1, 'Dice Goblin Day Pass', 'LAIR-SESSION-DAY', 1, '10.00')], { customer: { id: Number(RIA) } })));
  assert.deepEqual(paymentsOf(ria.id), []);
  await settled();
  assert.deepEqual(credited, [[RANGI, 500]], "Mia's seat, once");
});

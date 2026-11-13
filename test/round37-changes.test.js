// Round 37 (14 Nov 2026): changes people make themselves (docs/contracts/lair-api-contract-v37-changes.md). Mo: "I want
// a way for the users/customers to cancel table bookings down from a number of players to what ever number so one
// customer dropped from 9 players to 6 and he was 3 days early so he completely had the chance to change but wasn't given
// an option other than cancelling. [...] Also for gms and their games I want them to have the chance to cancel their
// games too so long as they are before the 24 hour period and they even have the chance to change the time and date and
// given the option to choose to keep that new date or is it a one off etc."
// And at 9:25am, once he'd seen it: "Actually let gms cancel within 4 hours before the session not 24 hours. It's ok.
// I want people who bought tickets to Thier friends can cancel themselves. Just like gms. So that it is all working
// together. [...] customers who signed up to cancel up to 24 hours before the session is due and must call us to cancel
// if it is within that time frame."
// The rules: a customer changes what they booked until 24 hours before it starts (as dice-goblin-shop has it for
// cancelling); after that it's locked in and it's a call. A GM cancels or moves their own session until 4 hours before
// it starts. Each check below is written from the contract's words.
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 3_600_000;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Saturday 14 November 2026, 9:00am in Auckland (NZDT, UTC+13): the morning Mo asked
const NOW = at('2026-11-14', 9);
const realNow = Date.now;
const nowIs = (ms) => {
  Date.now = () => ms;
};

function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      // as SQLite in a Durable Object: at most 100 bound values a query and 5 terms in a compound SELECT
      // (test/cloudflare-sql.js)
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

// The common room's tables seat 4 at $10 a person; the side room's too; the Fancy room is one table for 12 at $15 a
// person, for groups of 4 or more (dice-goblin-shop: Tables and bookings)
const ROOMS = [
  { id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 },
  { id: 'side-room', name: 'Side room', code: 'B', tables: 4, seats: 4, order: 2 },
  { id: 'fancy-room', name: 'Fancy room', code: 'F', tables: 1, seats: 12, price: 15, minPeople: 4, order: 3 },
];
// People by their Shopify customer IDs (made up): the main account; Ana, a helper with GM games; Hemi, a helper at the
// desk (Check-in and Tables); Rangi and Tui, GMs who aren't staff; and players
const OWNER = '9001';
const ANA = '9101';
const HEMI = '9102';
const RANGI = '5001';
const TUI = '5002';
const MIA = '6001';
const KAI = '6002';
const RIA = '6003';
const NAMES = { [OWNER]: 'Mo', [ANA]: 'Ana', [RANGI]: 'Rangi', [TUI]: 'Tui' };

let lair;
let sent;
async function call(method, path, body, customer = '', headers = {}) {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...headers },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  }));
  return { status: response.status, data: await response.json() };
}
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
/** Emails go out in the background: give them a moment, then read what was sent */
const settle = () => new Promise((r) => setTimeout(r, 10));
const mailTo = (to) => sent.filter((m) => m.to === to);
const me = async (who) => ok(await call('GET', 'me', null, who));
const row = (table, id) => lair.sql.exec(`SELECT * FROM ${table} WHERE id = ?`, id).one();

/** Mia's table: T6, T7 and T8 for 9, Tuesday 17 November 6pm to 9pm, three days ahead, unless said */
const book = (over = {}, who = MIA) => call('POST', 'bookings', {
  kind: 'table', tables: ['T6', 'T7', 'T8'], start: at('2026-11-17', 18), end: at('2026-11-17', 21), people: 9,
  name: 'Mia Chen', email: 'mia@example.com', phone: '021 555 0100', ...over,
}, who);
const change = (id, body, who = MIA) => call('POST', `bookings/${id}/update`, body, who);

/** A session a GM lists themselves (Rangi unless said): Tuesday 17 November 6pm to 10pm on B1 unless said */
async function list({ gm = RANGI, start = at('2026-11-17', 18), end = at('2026-11-17', 22), seats = 4, schedule, tables = ['B1'], title } = {}) {
  const name = NAMES[gm];
  return ok(await call('POST', 'games', {
    title: title || `${name}'s game`, system: 'D&D 5e', gm: name, blurb: 'A test session.', seats, tables, start, end, email: `${name.toLowerCase()}@example.com`,
    ...(schedule ? { schedule } : {}),
  }, gm));
}
const seat = (gameId, who, name, people = 1) => call('POST', 'bookings', {
  kind: 'gm-seat', gameId, people, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100',
}, who);
const joinEvery = (gameId, who, name) => call('POST', `games/${gameId}/join-series`, { people: 1, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100' }, who);
const cancelGame = (id, who, scope) => call('POST', `games/${id}/update`, { status: 'cancelled', ...(scope ? { scope } : {}) }, who);
const move = (id, body, who = RANGI) => call('POST', `games/${id}/move`, body, who);
const gameRow = (id) => row('games', id);
const sessionsOf = (seriesId) => lair.sql.exec("SELECT id, starts_at, ends_at, status, tables, slot_day FROM games WHERE series_id = ? ORDER BY starts_at", seriesId).toArray();
const labels = (seriesId, status = null) => sessionsOf(seriesId).filter((r) => !status || r.status === status).map((r) => time.label(r.starts_at));
/** The 10-minute run's top-up of every weekly and fortnightly game */
const topUp = () => lair.extendSeries(lair.rulesCache, Date.now());

const realFetch = globalThis.fetch;
beforeEach(async () => {
  sent = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('resend')) throw new Error(`No network in tests: ${url}`);
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: Array.isArray(m.to) ? m.to[0] : m.to });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  nowIs(NOW);
  lair = new Lair(fakeCtx(), {
    CURRENCY: 'NZD', RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test',
  });
  lair.later = (promise) => Promise.resolve(promise).catch(() => {});
  // The main account is tagged staff in Shopify; Rangi and Tui are trusted GMs (tagged gm), so their games go straight
  // on the board
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: [RANGI, TUI].includes(id), tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  Object.defineProperty(lair.shopify, 'configured', { get: () => false, configurable: true });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  for (const [id, name, perms] of [[ANA, 'Ana Ngata', ['sessions']], [HEMI, 'Hemi Walker', ['checkin', 'tables']]]) {
    ok(await call('POST', 'team', { customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, perms }, OWNER));
  }
  for (const [id, name] of [[RANGI, 'Rangi Hohaia'], [TUI, 'Tui Parata'], [MIA, 'Mia Chen'], [KAI, 'Kai Tane'], [RIA, 'Ria Moana']]) {
    lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
  }
  await settle();
  sent = [];
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
});

/* ================= 1. a table booking's numbers, changed by whoever booked it ================= */

test('numbers: nine become six, three days ahead: the price follows, the table it no longer needs is free at once, and they get one email', async () => {
  const booked = ok(await book()).booking;
  assert.equal(booked.amount, 9000);
  await settle();
  sent = [];
  const done = ok(await change(booked.id, { people: 6 }));
  assert.equal(done.booking.people, 6);
  assert.equal(done.booking.amount, 6000, '$10 a person');
  assert.equal(done.booking.due, 6000);
  assert.deepEqual(done.booking.tables, ['T6', 'T7'], 'the first tables in table order, enough for six');
  assert.deepEqual(done.changed, {
    people: { from: 9, to: 6 }, tables: { from: ['T6', 'T7', 'T8'], to: ['T6', 'T7'], freed: ['T8'] }, amount: { from: 9000, to: 6000 },
  });
  // T8 is anyone's now, at that time
  const kais = await book({ tables: ['T8'], people: 4, name: 'Kai Tane', email: 'kai@example.com' }, KAI);
  assert.equal(kais.status, 200, kais.data.error);
  // and T7 is still Mia's
  assert.equal(said(await book({ tables: ['T7'], people: 4, name: 'Ria Moana', email: 'ria@example.com' }, RIA)), '409 Table T7 is already taken at that time. Pick another.');
  await settle();
  const mail = mailTo('mia@example.com');
  assert.equal(mail.length, 1);
  assert.equal(mail[0].subject, 'Booking changed: 6 people on Tuesday 17 November');
  assert.ok(mail[0].text.includes("YOUR BOOKING'S CHANGED"), mail[0].text);
  assert.ok(mail[0].text.includes('Kia ora Mia Chen, Gobgob has updated your table at the Dice Goblin Lair.'), mail[0].text);
  assert.ok(mail[0].text.includes('6 (it was 9)'), mail[0].text);
  assert.ok(mail[0].text.includes('Tables T6, T7 (T8 is back on the map for someone else)'), mail[0].text);
  assert.ok(mail[0].text.includes('$60.00, on your tab (it was $90.00)'), mail[0].text);
  // staff aren't emailed about it
  assert.deepEqual(mailTo('staff@dicegoblin.test'), []);
  // and staff see why the table went, on the booking
  assert.ok(row('bookings', booked.id).notes.includes('[Changed online: 9 to 6 people, T8 freed]'));
});

test('numbers: their view of a booking says what can change, and stops saying so once it can\'t', async () => {
  const booked = ok(await book()).booking;
  const start = at('2026-11-17', 18);
  const want = { until: start - 24 * HOUR, min: 1, max: 12, each: 1000, keep: [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3] };
  assert.deepEqual(booked.change, want, 'on the booking as it comes back');
  assert.deepEqual((await me(MIA)).bookings.find((b) => b.id === booked.id).change, want, 'and in My Lair');
  // the Fancy room: 4 to 12 people at $15, one table whatever
  const fancy = ok(await book({ tables: ['F1'], people: 6, start: at('2026-11-18', 18), end: at('2026-11-18', 21) })).booking;
  assert.deepEqual(fancy.change, { until: at('2026-11-18', 18) - 24 * HOUR, min: 4, max: 12, each: 1500, keep: [1, 1, 1, 1, 1, 1, 1, 1, 1] });
  // a wargame's double setup: two people may keep both tables
  const war = ok(await book({ tables: ['T10', 'T11'], people: 2, extras: ['wargame'], start: at('2026-11-19', 18), end: at('2026-11-19', 21) })).booking;
  assert.deepEqual(war.change.keep, [2, 2, 2, 2, 2, 2, 2, 2]);
  // locked in (24 hours before): nothing to change online any more
  nowIs(start - 24 * HOUR);
  assert.equal((await me(MIA)).bookings.find((b) => b.id === booked.id).change, undefined);
  // cancelled: nor then
  nowIs(NOW);
  ok(await change(fancy.id, { status: 'cancelled' }));
  assert.equal((await me(MIA)).bookings.find((b) => b.id === fancy.id).change, undefined);
});

test('numbers: they choose which of their tables to keep', async () => {
  const booked = ok(await book()).booking;
  const done = ok(await change(booked.id, { people: 6, tables: ['T8', 'T7'] }));
  assert.deepEqual(done.booking.tables, ['T7', 'T8']);
  assert.deepEqual(done.changed.tables.freed, ['T6']);
  assert.equal((await book({ tables: ['T6'], people: 4, name: 'Kai Tane', email: 'kai@example.com' }, KAI)).status, 200);
  // one table handed back with the same people: a pair with a wargame's double setup keeps just one
  const war = ok(await book({ tables: ['T10', 'T11'], people: 2, extras: ['wargame'], start: at('2026-11-19', 18), end: at('2026-11-19', 21) })).booking;
  const one = ok(await change(war.id, { tables: ['T11'] }));
  assert.deepEqual(one.booking.tables, ['T11']);
  assert.equal(one.booking.people, 2);
  assert.equal(one.booking.amount, 2000, 'the same people, the same price');
  await settle();
  assert.equal(mailTo('mia@example.com').at(-1).subject, 'Booking changed: Table T11 on Thursday 19 November');
});

test('numbers: a group can grow into the chairs it already has, and no further', async () => {
  const booked = ok(await book({ tables: ['T6', 'T7'], people: 6 })).booking;
  const grown = ok(await change(booked.id, { people: 8 }));
  assert.equal(grown.booking.people, 8);
  assert.equal(grown.booking.amount, 8000);
  assert.deepEqual(grown.booking.tables, ['T6', 'T7']);
  assert.equal(said(await change(booked.id, { people: 9 })), '422 Your tables seat 8. For a bigger group, book another table or give us a call.');
  const single = ok(await book({ tables: ['T9'], people: 2, start: at('2026-11-18', 18), end: at('2026-11-18', 21) })).booking;
  assert.equal(said(await change(single.id, { people: 5 })), '422 Your table seats 4. For a bigger group, book another table or give us a call.');
});

test('numbers: the last moment is 24 hours before it starts, to the minute; after that it stays as it is', async () => {
  const booked = ok(await book()).booking;
  const start = at('2026-11-17', 18);
  nowIs(start - 24 * HOUR - MIN);
  assert.equal(ok(await change(booked.id, { people: 8 })).booking.people, 8);
  nowIs(start - 24 * HOUR);
  assert.equal(
    said(await change(booked.id, { people: 6 })),
    "409 It's less than 24 hours away, so it can't be changed online now: it stays on your tab as it is. Have a chat with us at the counter or give us a call, and we'll sort it out.",
  );
  assert.equal(row('bookings', booked.id).people, 8);
  assert.equal(row('bookings', booked.id).amount, 8000);
  // one booked inside the 24 hours is locked at once
  nowIs(NOW);
  const tonight = ok(await book({ tables: ['T12'], people: 4, start: at('2026-11-14', 18), end: at('2026-11-14', 21) })).booking;
  assert.equal(tonight.change, undefined);
  assert.match(said(await change(tonight.id, { people: 2 })), /^409 It's less than 24 hours away, so it can't be changed online now/);
  // staff still can, at the desk
  assert.equal(ok(await change(tonight.id, { people: 2 }, HEMI)).booking.people, 2);
});

test('numbers: what stops it, and nothing changes when it does', async () => {
  const booked = ok(await book()).booking;
  const same = () => assert.deepEqual([row('bookings', booked.id).people, row('bookings', booked.id).amount, row('bookings', booked.id).tables], [9, 9000, '["T6","T7","T8"]']);
  // someone else's, or nobody logged in: as it always was
  assert.equal(said(await change(booked.id, { people: 6 }, KAI)), '403 Only staff can change that booking.');
  assert.equal(said(await change(booked.id, { people: 6 }, '')), '403 Only staff can change that booking.');
  // nothing but its numbers
  assert.equal(said(await change(booked.id, { end: at('2026-11-17', 23) })), '403 Only staff can change that booking.');
  assert.equal(said(await change(booked.id, { paid: true })), '403 Only staff can change that booking.');
  // how many
  const people = '422 Tell us how many people are coming. To call it off, cancel the booking instead.';
  for (const bad of [0, -2, 2.5, 'lots', '', true]) assert.equal(said(await change(booked.id, { people: bad })), people, String(bad));
  assert.equal(said(await change(booked.id, { people: 13 })), '422 Your tables seat 12. For a bigger group, book another table or give us a call.');
  // which tables
  assert.equal(said(await change(booked.id, { people: 6, tables: ['T6', 'T9'] })), '422 Pick from the tables on this booking.');
  assert.equal(said(await change(booked.id, { people: 6, tables: [] })), '422 Pick from the tables on this booking.');
  assert.equal(said(await change(booked.id, { people: 6, tables: ['T6'] })), '422 6 people need more tables than that (those seat 4).');
  assert.equal(said(await change(booked.id, { people: 6, tables: ['T6', 'T7', 'T8'] })), "422 That's more tables than 6 people need. Keep up to 2.");
  assert.equal(said(await change(booked.id, { people: 1, tables: ['T6', 'T7'] })), "422 That's more tables than 1 person needs. Keep up to 1.");
  same();
  // the Fancy room is for groups of 4 or more
  const fancy = ok(await book({ tables: ['F1'], people: 6, start: at('2026-11-18', 18), end: at('2026-11-18', 21) })).booking;
  assert.equal(said(await change(fancy.id, { people: 3 })), '422 Fancy room is for groups of 4 or more. To come with fewer, cancel this booking and book another table.');
  assert.equal(ok(await change(fancy.id, { people: 4 })).booking.amount, 6000, '$15 a person there');
  // (seats at a TTRPG session booked for friends are changed their own way since Mo's second message: section 5 below)
  // a game table at an event isn't changed this way: its players are named, and each pays their own share
  lair.sql.exec("UPDATE bookings SET occurrence_id = 'warhammer-night@2026-11-19' WHERE id = ?", fancy.id);
  assert.equal(said(await change(fancy.id, { people: 5 })), "409 That booking's numbers can't be changed online. Have a chat with us and we'll sort it out.");
  assert.equal((await me(MIA)).bookings.find((b) => b.id === fancy.id).change, undefined);
  lair.sql.exec('UPDATE bookings SET occurrence_id = NULL WHERE id = ?', fancy.id);
  // cancelled
  ok(await change(fancy.id, { status: 'cancelled' }));
  assert.equal(said(await change(fancy.id, { people: 5 })), "409 That booking's been cancelled, so there's nothing to change.");
  // checked in, or started
  nowIs(at('2026-11-17', 17, 50));
  ok(await call('POST', 'checkin', { id: booked.id, type: 'booking', pass: 'none' }, HEMI));
  assert.equal(said(await change(booked.id, { people: 6 })), "409 That one has already started, so it can't be changed online. Have a chat with us at the counter.");
});

test('numbers: money already on it for more people than the new number is staff\'s to sort; less than that is fine', async () => {
  // two of nine friends paid their $10 ahead at the counter (a split bill)
  const booked = ok(await book({ split: true })).booking;
  lair.sql.exec('UPDATE bookings SET paid_amount = 2000 WHERE id = ?', booked.id);
  const six = ok(await change(booked.id, { people: 6 }));
  assert.equal(six.booking.amount, 6000);
  assert.equal(six.booking.due, 4000, 'what two friends paid still counts');
  assert.equal(six.booking.paid, false);
  await settle();
  assert.ok(mailTo('mia@example.com').at(-1).text.includes('$40.00 left on your tab ($20.00 of $60.00 paid)'));
  // down to two: paid up
  const two = ok(await change(booked.id, { people: 2 }));
  assert.equal(two.booking.due, 0);
  assert.equal(two.booking.paid, true);
  // down to one would mean money back: never by itself
  const paid = "409 You've paid for more people than that already. Have a chat with us at the counter or give us a call, and we'll sort out the change and your money back.";
  assert.equal(said(await change(booked.id, { people: 1 })), paid);
  assert.equal(row('bookings', booked.id).people, 2);
  assert.equal(row('bookings', booked.id).paid_amount, 2000, 'nothing moved');
  assert.equal(row('bookings', booked.id).refund, null, 'and no refund flagged');
  // one staff marked paid in full
  const other = ok(await book({ tables: ['T10', 'T11'], people: 8, start: at('2026-11-18', 18), end: at('2026-11-18', 21) })).booking;
  ok(await change(other.id, { paid: true }, HEMI));
  assert.equal(said(await change(other.id, { people: 6 })), paid);
});

test('numbers: asking for what it already is changes nothing and emails nobody', async () => {
  const booked = ok(await book()).booking;
  await settle();
  sent = [];
  const before = row('bookings', booked.id);
  const again = ok(await change(booked.id, { people: 9 }));
  assert.equal(again.changed, null);
  assert.equal(again.booking.people, 9);
  assert.deepEqual(row('bookings', booked.id), before);
  // the same tap twice
  ok(await change(booked.id, { people: 6, tables: ['T6', 'T7'] }));
  assert.equal(ok(await change(booked.id, { people: 6, tables: ['T6', 'T7'] })).changed, null);
  await settle();
  assert.equal(mailTo('mia@example.com').length, 1, 'one email for the one change');
});

test('numbers: staff change a booking the staff way, as before, and their own cancel still cancels', async () => {
  const booked = ok(await book({ tables: ['T6'], people: 4 })).booking;
  // the desk can seat more than the table's chairs (their call)
  assert.equal(ok(await change(booked.id, { people: 6 }, HEMI)).booking.people, 6);
  assert.equal(row('bookings', booked.id).amount, 6000);
  // Mia cancels hers
  const gone = ok(await change(booked.id, { status: 'cancelled' }));
  assert.equal(gone.booking.status, 'cancelled');
});

/* ================= 2. a GM cancels until 24 hours before ================= */

test('GM cancel: a GM cancels their own session until 4 hours before it starts; after that only staff can', async () => {
  const early = (await list()).game;
  const start = at('2026-11-17', 18);
  const mias = ok(await seat(early.id, MIA, 'Mia')).booking;
  await settle();
  sent = [];
  // Tuesday 1:59pm, a minute more than 4 hours before. Mia's own seat has been locked in since Monday 6pm
  nowIs(start - 4 * HOUR - MIN);
  assert.equal((await me(MIA)).seats.find((s) => s.id === mias.id).locked, true);
  const done = ok(await cancelGame(early.id, RANGI));
  assert.equal(done.game.status, 'cancelled');
  assert.equal(done.affected, 1);
  await settle();
  assert.equal(mailTo('mia@example.com').length, 1, 'its player hears');
  assert.equal(mailTo('mia@example.com')[0].subject, "Cancelled: Rangi's game, Tuesday, 17 November at 6:00 pm to 10:00 pm");
  // her seat went with the session: it isn't on her tab, then or once its time has passed
  assert.equal(row('bookings', mias.id).status, 'cancelled');
  nowIs(start + 5 * HOUR);
  const after = await me(MIA);
  assert.equal(after.seats.find((s) => s.id === mias.id).owed, false);
  assert.deepEqual(after.dueNow, []);
  // another, at 4 hours before on the dot
  nowIs(NOW);
  const late = (await list({ start: at('2026-11-18', 18), end: at('2026-11-18', 22), title: 'Wednesday one-shot' })).game;
  const locked = "409 It's less than 4 hours away, so it can't be cancelled online now. Give us a call or see us at the counter, and we'll sort it out with your players.";
  nowIs(at('2026-11-18', 18) - 4 * HOUR);
  assert.equal(said(await cancelGame(late.id, RANGI)), locked);
  // and twenty minutes in (the old rule let them, until an hour after the start)
  nowIs(at('2026-11-18', 18, 20));
  assert.equal(said(await cancelGame(late.id, RANGI)), locked);
  assert.equal(gameRow(late.id).status, 'open');
  // someone who isn't its GM never could
  assert.equal(said(await cancelGame(late.id, TUI)), '403 Only staff can change that game.');
  // staff with GM games still can, any time
  assert.equal(ok(await cancelGame(late.id, ANA)).game.status, 'cancelled');
});

test('GM cancel: "all future sessions" cancels the ones more than 4 hours away; one that\'s closer stays on, and the answer says so', async () => {
  // a weekly game from tonight; by 3pm tonight's is inside the 4 hours
  const listed = await list({ start: at('2026-11-14', 18), end: at('2026-11-14', 22), schedule: 'weekly', title: 'Saturday campaign' });
  const ids = listed.sessions.map((s) => s.id);
  assert.ok(ids.length >= 8);
  nowIs(at('2026-11-14', 15));
  const done = ok(await cancelGame(ids[1], RANGI, 'series'));
  assert.deepEqual(done.kept, [{ id: ids[0], start: at('2026-11-14', 18), when: 'Saturday, 14 November at 6:00 pm' }]);
  assert.equal(done.notice, "Saturday, 14 November at 6:00 pm is less than 4 hours away, so it's still on. Give us a call if it can't run.");
  assert.equal(gameRow(ids[0]).status, 'open', "tonight's is still on");
  for (const id of ids.slice(1)) assert.equal(gameRow(id).status, 'cancelled', id);
  // the game adds no more dates
  assert.equal(row('series', listed.game.seriesId).status, 'cancelled');
  // staff cancel the lot, tonight's too
  const other = await list({ gm: TUI, start: at('2026-11-14', 18), end: at('2026-11-14', 22), schedule: 'weekly', tables: ['B2'], title: 'Tui campaign' });
  const all = ok(await cancelGame(other.sessions[0].id, OWNER, 'series'));
  assert.equal(all.kept, undefined);
  for (const s of other.sessions) assert.equal(gameRow(s.id).status, 'cancelled');
  // half an hour into a session, its GM's "all future sessions" leaves it running without a word about it (it isn't
  // "less than 4 hours away": it's on), and cancels the rest
  const third = await list({ start: at('2026-11-15', 18), end: at('2026-11-15', 22), schedule: 'weekly', tables: ['B3'], title: 'Sunday campaign' });
  nowIs(at('2026-11-15', 18) + 30 * 60 * 1000);
  const late = ok(await cancelGame(third.sessions[0].id, RANGI, 'series'));
  assert.equal(late.kept, undefined);
  assert.equal(late.notice, undefined);
  assert.equal(gameRow(third.sessions[0].id).status, 'open', "the one that's under way carries on");
  for (const s of third.sessions.slice(1)) assert.equal(gameRow(s.id).status, 'cancelled', s.id);
});

test('GM cancel: My Lair tells a GM until when each session is theirs to change', async () => {
  const { game } = await list();
  const mine = (await me(RANGI)).games.find((g) => g.id === game.id);
  assert.equal(mine.changeUntil, at('2026-11-17', 18) - 4 * HOUR);
  // (a customer's own lock is still 24 hours before: the two rules sit side by side)
  assert.equal(lair.rulesCache.refundHours, 24);
  assert.equal(lair.rulesCache.gmChangeHours, 4);
  // and the floor says this Lair app can move a session, so the games board offers "Change date or time"
  const floor = ok(await call('GET', `floor?from=${at('2026-11-17', 0)}&to=${at('2026-11-18', 0)}`, null, RANGI));
  assert.equal(floor.features.changes, true);
});

/* ================= 3. a GM moves a session ================= */

test('move: a GM moves their session to another day and time; its hold and seats go with it, players hear, and the team gets one email', async () => {
  const { game } = await list();
  const mias = ok(await seat(game.id, MIA, 'Mia')).booking;
  await settle();
  sent = [];
  const done = ok(await move(game.id, { start: at('2026-11-18', 17), end: at('2026-11-18', 21) }));
  assert.equal(done.scope, 'session');
  assert.equal(done.moved, 1);
  assert.deepEqual(done.kept, []);
  assert.equal(done.told, 1);
  assert.equal(done.game.start, at('2026-11-18', 17));
  assert.equal(done.game.end, at('2026-11-18', 21));
  // the GM's hold and Mia's seat sit where the session is
  for (const b of lair.sql.exec('SELECT kind, starts_at, ends_at, tables FROM bookings WHERE game_id = ?', game.id).toArray()) {
    assert.deepEqual([b.starts_at, b.ends_at, b.tables], [at('2026-11-18', 17), at('2026-11-18', 21), '["B1"]'], b.kind);
  }
  // B1 is free on Tuesday night again, and taken on Wednesday
  assert.equal((await list({ gm: TUI, title: 'Tui one-shot' })).game.tables[0], 'B1');
  assert.equal(said(await call('POST', 'games', { title: 'Clash', system: 'D&D 5e', gm: 'Tui', blurb: 'x', seats: 4, tables: ['B1'], start: at('2026-11-18', 18), end: at('2026-11-18', 20) }, TUI)), '409 Table B1 is already taken at that time. Pick another.');
  await settle();
  const mail = mailTo('mia@example.com');
  assert.equal(mail.length, 1);
  assert.equal(mail[0].subject, "New time: Rangi's game, Wednesday, 18 November at 5:00 pm to 9:00 pm");
  assert.ok(mail[0].text.includes("Heads up, friend: Rangi's game has moved. Your seat moved with it."), mail[0].text);
  assert.ok(mail[0].text.includes('Tuesday, 17 November at 6:00 pm to 10:00 pm'), 'what it was');
  assert.ok(mail[0].text.includes("Can't make the new time? Cancel your seat in My Lair by Tuesday, 17 November at 5:00 pm and Gobgob will let your GM know. After that it stays on your tab."), mail[0].text);
  const team = mailTo('staff@dicegoblin.test');
  assert.equal(team.length, 1);
  assert.equal(team[0].subject, "Moved by its GM: Rangi's game");
  assert.ok(team[0].text.includes("Rangi moved Rangi's game from Tuesday, 17 November at 6:00 pm to 10:00 pm to Wednesday, 18 November at 5:00 pm to 9:00 pm. 1 person was told by email."), team[0].text);
  // Mia's seat in My Lair is at the new time
  const hers = (await me(MIA)).seats.find((s) => s.id === mias.id);
  assert.equal(hers.start, at('2026-11-18', 17));
});

test('move: a seat whose session moved can be dropped until 24 hours after the move, even inside the usual 24 hours', async () => {
  const { game } = await list();
  const mias = ok(await seat(game.id, MIA, 'Mia')).booking;
  const kais = ok(await seat(game.id, KAI, 'Kai')).booking;
  // Monday 5pm, 25 hours before: Rangi pushes it back an hour
  nowIs(at('2026-11-16', 17));
  ok(await move(game.id, { start: at('2026-11-17', 19), end: at('2026-11-17', 23) }));
  // the usual lock would be Monday 7pm; they have until Tuesday 5pm, a day after the move
  const hers = (await me(MIA)).seats.find((s) => s.id === mias.id);
  assert.equal(hers.cancelUntil, at('2026-11-17', 17));
  assert.equal(hers.locked, false);
  await settle();
  assert.ok(mailTo('mia@example.com').at(-1).text.includes('Cancel your seat in My Lair by Tuesday, 17 November at 5:00 pm'), mailTo('mia@example.com').at(-1).text);
  nowIs(at('2026-11-17', 10));
  assert.equal(ok(await change(mias.id, { status: 'cancelled' })).booking.status, 'cancelled');
  // on the dot it's locked, like any seat
  nowIs(at('2026-11-17', 17));
  assert.match(said(await change(kais.id, { status: 'cancelled' }, KAI)), /^409 It's less than 24 hours away, so it can't be cancelled online now/);
});

test('move: a GM moves a session until 4 hours before it starts; inside their players\' 24 hours the new time still needs a day\'s notice, and each player gets a day to drop out', async () => {
  const { game } = await list();
  const mias = ok(await seat(game.id, MIA, 'Mia')).booking;
  // Tuesday 1pm, five hours before: Mia's seat has been locked in since Monday 6pm
  nowIs(at('2026-11-17', 13));
  assert.equal((await me(MIA)).seats.find((s) => s.id === mias.id).locked, true);
  // later tonight isn't a day's notice
  assert.equal(said(await move(game.id, { start: at('2026-11-17', 19), end: at('2026-11-17', 23) })), "422 Your players need a day's notice. Pick a time at least 24 hours from now.");
  // Thursday is
  sent = [];
  const done = ok(await move(game.id, { start: at('2026-11-19', 18), end: at('2026-11-19', 22) }));
  assert.equal(done.moved, 1);
  assert.equal(done.told, 1);
  // her seat is hers to drop again: until Wednesday 6pm, 24 hours before the new time (later than a day after the move)
  const hers = (await me(MIA)).seats.find((s) => s.id === mias.id);
  assert.equal(hers.start, at('2026-11-19', 18));
  assert.equal(hers.locked, false);
  assert.equal(hers.cancelUntil, at('2026-11-18', 18));
  await settle();
  assert.ok(mailTo('mia@example.com').at(-1).text.includes("Can't make the new time? Cancel your seat in My Lair by Wednesday, 18 November at 6:00 pm and Gobgob will let your GM know. After that it stays on your tab."), mailTo('mia@example.com').at(-1).text);
  assert.equal(ok(await change(mias.id, { status: 'cancelled' })).booking.status, 'cancelled');
});

test('move: a GM can\'t move a session inside its last 4 hours; staff can, and its players still get their day', async () => {
  const { game } = await list();
  const mias = ok(await seat(game.id, MIA, 'Mia')).booking;
  const start = at('2026-11-17', 18);
  nowIs(start - 4 * HOUR);
  const locked = "409 It's less than 4 hours away, so it can't be moved online now. Give us a call or see us at the counter, and we'll sort it out with your players.";
  assert.equal(said(await move(game.id, { start: at('2026-11-19', 18), end: at('2026-11-19', 22) })), locked);
  assert.equal(gameRow(game.id).starts_at, start);
  // someone else, or nobody
  assert.equal(said(await move(game.id, { start: at('2026-11-19', 18) }, MIA)), '403 Only the GM or staff can move a session.');
  assert.equal(said(await move(game.id, { start: at('2026-11-19', 18) }, '')), '403 Only the GM or staff can move a session.');
  // staff with GM games, two hours before, to tonight an hour later
  nowIs(at('2026-11-17', 16));
  sent = [];
  const done = ok(await move(game.id, { start: at('2026-11-17', 19) }, ANA));
  assert.equal(done.game.end, at('2026-11-17', 23), 'as long as it was');
  await settle();
  assert.deepEqual(mailTo('staff@dicegoblin.test'), [], 'the team moved it, so the team isn\'t told');
  // Mia can still drop it, until it starts
  const hers = (await me(MIA)).seats.find((s) => s.id === mias.id);
  assert.equal(hers.cancelUntil, at('2026-11-17', 19));
  assert.ok(mailTo('mia@example.com').at(-1).text.includes('Cancel your seat in My Lair by Tuesday, 17 November at 7:00 pm'));
});

test('move: with players on it a GM\'s new time has to be at least 24 hours away; with nobody on it, only the lead time', async () => {
  const withMia = (await list({ start: at('2026-11-19', 18), end: at('2026-11-19', 22) })).game;
  ok(await seat(withMia.id, MIA, 'Mia'));
  const empty = (await list({ start: at('2026-11-19', 18), end: at('2026-11-19', 22), tables: ['B2'], title: 'Nobody yet' })).game;
  // Wednesday 5pm, 25 hours before both
  nowIs(at('2026-11-18', 17));
  assert.equal(said(await move(withMia.id, { start: at('2026-11-19', 16), end: at('2026-11-19', 20) })), "422 Your players need a day's notice. Pick a time at least 24 hours from now.");
  assert.equal(ok(await move(withMia.id, { start: at('2026-11-19', 17), end: at('2026-11-19', 21) })).moved, 1, 'exactly 24 hours is enough');
  assert.equal(said(await move(empty.id, { start: at('2026-11-18', 17, 30), end: at('2026-11-18', 21, 30) })), "422 That's too soon. Pick a later time.");
  assert.equal(ok(await move(empty.id, { start: at('2026-11-18', 19), end: at('2026-11-18', 23) })).moved, 1, 'two hours away, with nobody to tell');
  // a time that isn't one
  const third = (await list({ start: at('2026-11-21', 18), end: at('2026-11-21', 22), tables: ['B3'], title: 'Third' })).game;
  assert.equal(said(await move(third.id, { start: at('2026-11-21', 19), end: at('2026-11-21', 18) })), '422 That time is not valid.');
  assert.equal(said(await move(third.id, {})), '422 Pick the new day, time or tables.');
  assert.equal(said(await move(third.id, { start: at('2026-11-21', 19), scope: 'forever' })), "422 Choose whether it's just this session or every later session too.");
  // outside opening hours, and a table that's taken: the GM rules' own words
  assert.equal(said(await move(third.id, { start: at('2026-11-23', 10), end: at('2026-11-23', 14) })), '422 That time is outside opening hours.');
  assert.equal(said(await move(third.id, { tables: ['B1'], start: at('2026-11-19', 17), end: at('2026-11-19', 21) })), '409 Table B1 is already taken at that time. Pick another.');
});

test('move: new tables at the same time email nobody, and a GM\'s move can\'t change what players pay', async () => {
  const { game } = await list();
  const mias = ok(await seat(game.id, MIA, 'Mia')).booking;
  await settle();
  sent = [];
  const done = ok(await move(game.id, { tables: ['B3'] }));
  assert.equal(done.moved, 1);
  assert.equal(done.told, 0);
  assert.deepEqual(JSON.parse(row('bookings', mias.id).tables), ['B3']);
  assert.equal(row('bookings', mias.id).moved_at, null, 'its time didn\'t change, so its lock is as it was');
  await settle();
  assert.deepEqual(mailTo('mia@example.com'), []);
  const fyi = mailTo('staff@dicegoblin.test');
  assert.equal(fyi.length, 1, 'the team still hears where it went');
  assert.equal(fyi[0].subject, "Moved by its GM: Rangi's game");
  assert.match(fyi[0].text, /Rangi moved Rangi's game from Table B1 to Table B3, at the same time: Tuesday, 17 November/);
  assert.doesNotMatch(fyi[0].text, /told by email|no one to tell/, 'nobody needed telling, so it doesn\'t count anyone');
  // the Fancy room is $15 a person, so its seats would cost more
  assert.equal(
    said(await move(game.id, { tables: ['F1'] })),
    '422 Those tables are in a room with a different table fee, which would change what your players pay. Pick tables in the same room, or ask the team.',
  );
  // the common room is $10 too: fine
  assert.equal(ok(await move(game.id, { tables: ['T15'] })).game.tables[0], 'T15');
  assert.equal(row('bookings', mias.id).amount, 1500, 'her seat costs what it did');
  // asking for where it is already does nothing
  sent = [];
  const same = ok(await move(game.id, { tables: ['T15'], start: at('2026-11-17', 18), end: at('2026-11-17', 22) }));
  assert.deepEqual([same.moved, same.told], [0, 0]);
  await settle();
  assert.deepEqual(sent, []);
});

/** Rangi's weekly game: Saturdays 6pm to 10pm on B1 from 21 November (its sessions to the 60-day horizon) */
async function weekly(over = {}) {
  const listed = await list({ start: at('2026-11-21', 18), end: at('2026-11-21', 22), schedule: 'weekly', title: 'Curse of Strahd', ...over });
  return { ids: listed.sessions.map((s) => s.id), seriesId: listed.game.seriesId };
}

test('move: in a weekly game a session stays between the sessions before and after it', async () => {
  const { ids } = await weekly();
  const second = ids[1]; // Saturday 28 November
  assert.equal(
    said(await move(second, { start: at('2026-12-06', 13), end: at('2026-12-06', 17) })),
    '422 Keep it between the sessions before and after it: after Saturday, 21 November at 10:00 pm and before Saturday, 5 December at 6:00 pm. To move it further, cancel it and add a new date.',
  );
  assert.match(said(await move(second, { start: at('2026-11-21', 20), end: at('2026-11-22', 0) })), /^422 Keep it between the sessions before and after it/);
  // the first one has nothing before it
  assert.equal(
    said(await move(ids[0], { start: at('2026-11-29', 13), end: at('2026-11-29', 17) })),
    '422 Keep it between the sessions before and after it: before Saturday, 28 November at 6:00 pm. To move it further, cancel it and add a new date.',
  );
  // anywhere in between is fine
  assert.equal(ok(await move(second, { start: at('2026-11-30', 17), end: at('2026-11-30', 21) })).moved, 1);
});

test('move: one session of a weekly game moved to another day is a one-off: the game doesn\'t put another session on the day it left', async () => {
  const { ids, seriesId } = await weekly();
  const before = labels(seriesId).length;
  ok(await move(ids[1], { start: at('2026-11-29', 13), end: at('2026-11-29', 17) }));
  assert.equal(gameRow(ids[1]).slot_day, '2026-11-28', 'it still fills Saturday the 28th');
  topUp();
  assert.equal(labels(seriesId).length, before, 'no second session that week');
  assert.deepEqual(labels(seriesId).slice(0, 3), ['Saturday, 21 November at 6:00 pm', 'Sunday, 29 November at 1:00 pm', 'Saturday, 5 December at 6:00 pm']);
  // the later sessions are where they were, and the game still adds Saturdays as the weeks go by
  nowIs(NOW + 14 * 24 * HOUR);
  topUp();
  const all = labels(seriesId);
  assert.ok(all.slice(2).every((l) => /^Saturday, .* at 6:00 pm$/.test(l)), all.join(' | '));
  assert.equal(all.length, before + 2);
  // moved back onto its own day, it's just that day's session again
  nowIs(NOW);
  ok(await move(ids[1], { start: at('2026-11-28', 18), end: at('2026-11-28', 22) }));
  assert.equal(gameRow(ids[1]).slot_day, null);
});

test('found on the way: a weekly session staff moved to another day (Edit session) no longer comes back on its old day at the next run', async () => {
  const listed = ok(await call('POST', 'games', {
    title: "Ana's campaign", system: 'D&D 5e', gm: 'Ana', blurb: 'A test.', seats: 4, tables: ['B2'], start: at('2026-11-21', 18), end: at('2026-11-21', 22),
    gmCustomerId: ANA, gmCustomerName: 'Ana', gmEmail: 'ana@example.com', schedule: 'weekly',
  }, OWNER));
  const ids = listed.sessions.map((s) => s.id);
  const before = labels(listed.game.seriesId).length;
  const kais = ok(await seat(ids[1], KAI, 'Kai')).booking;
  await settle();
  sent = [];
  ok(await call('POST', `games/${ids[1]}/edit`, { start: at('2026-11-29', 13), end: at('2026-11-29', 17) }, OWNER));
  topUp();
  assert.equal(labels(listed.game.seriesId).length, before, 'it was two sessions that week');
  assert.deepEqual(labels(listed.game.seriesId).slice(0, 3), ['Saturday, 21 November at 6:00 pm', 'Sunday, 29 November at 1:00 pm', 'Saturday, 5 December at 6:00 pm']);
  // and Kai's "New time" email ends with his own way out (he has until 24 hours before, here)
  await settle();
  const mail = mailTo('kai@example.com').at(-1);
  assert.equal(mail.subject, "New time: Ana's campaign, Sunday, 29 November at 1:00 pm to 5:00 pm");
  assert.ok(mail.text.includes("Can't make the new time? Cancel your seat in My Lair by Saturday, 28 November at 1:00 pm and Gobgob will let your GM know. After that it stays on your tab."), mail.text);
  assert.ok(!mail.text.includes('Have a chat with us and we'), 'the old last line is gone');
  assert.ok(row('bookings', kais.id).moved_at > 0);
});

test('move: "this and every later session" gives a weekly game its new day and time: later sessions follow where they can, one that can\'t stays and is listed, and the dates it adds later follow too', async () => {
  const { ids, seriesId } = await weekly();
  // Mia's a regular (her seat is in the next session, the 21st); Kai has a seat on 12 December; Ria on 5 December
  ok(await joinEvery(ids[0], MIA, 'Mia'));
  ok(await seat(ids[3], KAI, 'Kai'));
  const rias = ok(await seat(ids[2], RIA, 'Ria')).booking;
  // B1 is taken on Friday 4 December (someone's table), so that week's session can't move
  ok(await call('POST', 'blocks', { tables: ['B1'], start: at('2026-12-04', 16), end: at('2026-12-04', 24), label: 'Tournament', type: 'tournament' }, OWNER));
  await settle();
  sent = [];
  const before = labels(seriesId).length;
  // from Saturday 28 November: Fridays, 7pm to 11pm
  const done = ok(await move(ids[1], { start: at('2026-11-27', 19), end: at('2026-11-27', 23), scope: 'series' }));
  assert.equal(done.scope, 'series');
  assert.deepEqual(done.kept, [{ id: ids[2], start: at('2026-12-05', 18), when: 'Saturday, 5 December at 6:00 pm', reason: 'Table B1 is already taken at that time. Pick another.' }]);
  assert.equal(done.moved, before - 2, 'this one and every later one but the 5th');
  const now = labels(seriesId);
  assert.deepEqual(now.slice(0, 5), [
    'Saturday, 21 November at 6:00 pm', 'Friday, 27 November at 7:00 pm', 'Saturday, 5 December at 6:00 pm', 'Friday, 11 December at 7:00 pm', 'Friday, 18 December at 7:00 pm',
  ]);
  assert.ok(now.slice(3).every((l) => /^Friday, .* at 7:00 pm$/.test(l)), now.join(' | '));
  assert.equal(gameRow(ids[3]).ends_at - gameRow(ids[3]).starts_at, 4 * HOUR);
  // the game's own day and time, for the dates it adds
  const series = row('series', seriesId);
  assert.deepEqual([series.first_day, series.clock, series.length], ['2026-11-27', 19 * 60, 4 * HOUR]);
  // seats moved with their sessions: Kai's is Friday the 11th; Ria's (the 5th) stayed, and so did its lock
  assert.equal(lair.sql.exec('SELECT starts_at FROM bookings WHERE game_id = ? AND kind = ?', ids[3], 'gm-seat').one().starts_at, at('2026-12-11', 19));
  assert.equal(row('bookings', rias.id).starts_at, at('2026-12-05', 18));
  assert.equal(row('bookings', rias.id).moved_at, null);
  // who hears: Kai (a seat that moved), Mia (a regular); not Ria, whose session stayed
  await settle();
  const kai = mailTo('kai@example.com');
  assert.equal(kai.length, 1);
  assert.equal(kai[0].subject, 'New time from Friday 27 November: Curse of Strahd');
  assert.ok(kai[0].text.includes('Heads up, friend: Curse of Strahd is moving to Fridays at 7pm, from Friday 27 November.'), kai[0].text);
  assert.ok(kai[0].text.includes('Fridays, 7pm to 11pm'), kai[0].text);
  assert.ok(kai[0].text.includes('Saturdays, 6pm to 10pm'), kai[0].text);
  assert.ok(kai[0].text.includes('Friday, 11 December at 7:00 pm to 11:00 pm'), 'his seat\'s new time');
  assert.ok(kai[0].text.includes('Saturday, 5 December at 6:00 pm'), 'the one staying put');
  assert.ok(kai[0].text.includes("Can't make the new time? Cancel your seat in My Lair by Thursday, 10 December at 7:00 pm"), kai[0].text);
  const mia = mailTo('mia@example.com');
  assert.equal(mia.length, 1);
  assert.ok(mia[0].text.includes('Gobgob saves it at the new time'), mia[0].text);
  assert.ok(mia[0].text.includes("Can't make the new time? Skip a session or stop saving your seat in My Lair."), mia[0].text);
  assert.deepEqual(mailTo('ria@example.com'), []);
  const team = mailTo('staff@dicegoblin.test');
  assert.equal(team.length, 1);
  assert.ok(team[0].text.includes('Every later session moves with it: Fridays at 7pm from now on. 2 people were told by email.'), team[0].text);
  assert.ok(team[0].text.includes('Saturday, 5 December at 6:00 pm: Table B1 is already taken at that time. Pick another.'), team[0].text);
  // the top-up, now and as the weeks go by: Fridays at 7pm, never a second session in a week
  topUp();
  assert.deepEqual(labels(seriesId), now, 'nothing new today');
  nowIs(NOW + 21 * 24 * HOUR);
  topUp();
  const later = sessionsOf(seriesId);
  assert.equal(later.length, before + 3);
  assert.ok(later.slice(-3).every((r) => /^Friday, .* at 7:00 pm$/.test(time.label(r.starts_at)) && r.ends_at - r.starts_at === 4 * HOUR), later.map((r) => time.label(r.starts_at)).join(' | '));
  const weeks = later.map((r) => Math.floor((r.starts_at - at('2026-11-16', 0)) / (7 * 24 * HOUR)));
  assert.equal(new Set(weeks).size, weeks.length, `one session a week: ${weeks.join()}`);
});

test('move: every later session is for a weekly or fortnightly game, by whoever runs it, from a session on its usual day', async () => {
  const oneShot = (await list({ tables: ['B2'], title: 'One-shot' })).game;
  const kind = '422 Only a weekly or fortnightly game has a usual day to change. Move this session on its own.';
  assert.equal(said(await move(oneShot.id, { start: at('2026-11-18', 18), scope: 'series' })), kind);
  const flexible = await list({ tables: ['B3'], schedule: 'flexible', title: 'Flexible' });
  assert.equal(said(await move(flexible.game.id, { start: at('2026-11-18', 18), scope: 'series' })), kind);
  const { ids } = await weekly();
  // a week or more from its day
  assert.equal(
    said(await move(ids[1], { start: at('2026-12-05', 13), end: at('2026-12-05', 17), scope: 'series' })),
    "422 That's a week or more from its usual day. Pick a day closer to it, or cancel sessions and add new dates.",
  );
  // never before the session before it
  assert.match(said(await move(ids[1], { start: at('2026-11-21', 19), end: at('2026-11-21', 23), scope: 'series' })), /^422 Keep it between the sessions before and after it: after Saturday, 21 November at 10:00 pm\. /);
  // a session moved on its own before round 37 (nothing says which date it fills)
  lair.sql.exec('UPDATE games SET starts_at = ?, ends_at = ? WHERE id = ?', at('2026-12-06', 13), at('2026-12-06', 17), ids[2]);
  lair.sql.exec("UPDATE bookings SET starts_at = ?, ends_at = ? WHERE game_id = ?", at('2026-12-06', 13), at('2026-12-06', 17), ids[2]);
  assert.equal(
    said(await move(ids[2], { start: at('2026-12-04', 19), end: at('2026-12-04', 23), scope: 'series' })),
    "422 This session was moved on its own before. Open one that's on the game's usual day to change every later session.",
  );
  // staff give the game from its fourth session on to Tui: Rangi doesn't speak for the series any more
  ok(await call('POST', `games/${ids[3]}/gm`, { gmCustomerId: TUI, gmCustomerName: 'Tui Parata', gmEmail: 'tui@example.com', gm: 'Tui', scope: 'series' }, OWNER));
  assert.equal(said(await move(ids[1], { start: at('2026-11-27', 19), end: at('2026-11-27', 23), scope: 'series' })), '403 Only staff, or the GM who runs this game, can change every later session.');
  // he can still move his own session on its own
  assert.equal(ok(await move(ids[1], { start: at('2026-11-27', 19), end: at('2026-11-27', 23) })).moved, 1);
});

test('move: a session moved on its own keeps its date when the game then takes a new day, and one it left out stays out', async () => {
  const { ids, seriesId } = await weekly();
  // the third (5 December) goes to Sunday the 6th on its own; the fourth (12 December) is cancelled
  ok(await move(ids[2], { start: at('2026-12-06', 13), end: at('2026-12-06', 17) }));
  ok(await cancelGame(ids[3], RANGI));
  const before = sessionsOf(seriesId).length;
  // then the game moves to Fridays from the second session
  const done = ok(await move(ids[1], { start: at('2026-11-27', 19), end: at('2026-11-27', 23), scope: 'series' }));
  assert.deepEqual(done.kept.map((k) => [k.id, k.reason]), [[ids[2], 'It was moved on its own before, so it stays where it is.']]);
  assert.equal(gameRow(ids[2]).starts_at, at('2026-12-06', 13));
  assert.equal(gameRow(ids[2]).slot_day, '2026-12-04', "it fills that week's Friday now");
  assert.equal(gameRow(ids[3]).status, 'cancelled');
  assert.equal(gameRow(ids[3]).slot_day, '2026-12-11');
  topUp();
  assert.equal(sessionsOf(seriesId).length, before, 'no session added for the week it moved in, or the week Rangi cancelled');
});

test('move: a weekly game keeps its time of day across the end of daylight saving', async () => {
  // Saturday 20 March 2027: daylight saving ends on Sunday 4 April, at 3am
  nowIs(at('2027-03-20', 9));
  lair.rulesLoadedAt = Date.now() + 10 * 365 * 24 * HOUR;
  const listed = await list({ start: at('2027-03-27', 18), end: at('2027-03-27', 22), schedule: 'weekly', title: 'Across the change' });
  const ids = listed.sessions.map((s) => s.id);
  ok(await move(ids[0], { start: at('2027-03-26', 19), end: at('2027-03-26', 23), scope: 'series' }));
  const rows = sessionsOf(listed.game.seriesId);
  assert.ok(rows.length >= 6);
  for (const r of rows) {
    assert.equal(time.minutesOf(r.starts_at), 19 * 60, time.label(r.starts_at));
    assert.equal(time.weekday(time.key(r.starts_at)), 5, time.label(r.starts_at));
    assert.equal(r.ends_at - r.starts_at, 4 * HOUR);
  }
  // 2 April is NZDT (UTC+13), 9 April NZST (UTC+12): 7pm both times, an hour further apart in real time
  assert.equal(rows[2].starts_at - rows[1].starts_at, 7 * 24 * HOUR + HOUR);
});

/* ================= the edges: limits, emails that say so, and what rides along ================= */

test('numbers: six changes a booking a day, then it\'s a call (each one emails the address on the booking)', async () => {
  const booked = ok(await book()).booking;
  for (let i = 0; i < 6; i += 1) ok(await change(booked.id, { people: i % 2 ? 9 : 10 }));
  assert.equal(said(await change(booked.id, { people: 7 })), "429 That's 6 changes to this booking today. Give us a call and we'll sort the rest out.");
  assert.equal(row('bookings', booked.id).people, 9);
  // a change that changes nothing isn't one
  assert.equal(ok(await change(booked.id, { people: 9 })).changed, null);
  // tomorrow's another day
  nowIs(NOW + 24 * HOUR + MIN);
  assert.equal(ok(await change(booked.id, { people: 7 })).booking.people, 7);
});

test('numbers: a monthly account is held to its credit limit when a booking grows, as a new booking that size would be', async () => {
  ok(await call('POST', `members/${MIA}/account`, { billing: 'monthly', creditLimit: 5000 }, OWNER));
  const booked = ok(await book({ tables: ['T6', 'T7'], people: 5 })).booking;
  assert.equal(said(await change(booked.id, { people: 6 })), '409 That would take your Lair account over its $50 limit ($50 left). Pay your bill online or at the counter, then book again.');
  assert.equal(row('bookings', booked.id).people, 5);
  // (from the separate review: it's the whole new amount that's held to the limit, not just what's added. A table
  // still to come isn't on the account yet, so $55 of limit doesn't cover a $60 table, as it wouldn't for a new one)
  ok(await call('POST', `members/${MIA}/account`, { billing: 'monthly', creditLimit: 5500 }, OWNER));
  assert.equal(said(await change(booked.id, { people: 6 })), '409 That would take your Lair account over its $55 limit ($55 left). Pay your bill online or at the counter, then book again.');
  assert.equal(said(await book({ tables: ['T10', 'T11'], people: 6, start: at('2026-11-18', 18), end: at('2026-11-18', 21) })), '409 That would take your Lair account over its $55 limit ($55 left). Pay your bill online or at the counter, then book again.');
  ok(await call('POST', `members/${MIA}/account`, { billing: 'monthly', creditLimit: 6000 }, OWNER));
  assert.equal(ok(await change(booked.id, { people: 6 })).booking.amount, 6000);
  // a smaller group is always fine
  assert.deepEqual(ok(await change(booked.id, { people: 4 })).booking.tables, ['T6']);
});

test('numbers: the note for staff is always whole, after the customer\'s own notes, and only the latest change is noted', async () => {
  // (from the separate review: a long note of the customer's own used to push the staff note off the end)
  const long = 'We are bringing a cake and nine very excited ten-year-olds for a birthday. '.repeat(7).slice(0, 499).concat('!');
  assert.equal(long.length, 500);
  const booked = ok(await book({ notes: long })).booking;
  ok(await change(booked.id, { people: 6, tables: ['T6', 'T7'] }));
  let notes = row('bookings', booked.id).notes;
  assert.ok(notes.endsWith(' [Changed online: 9 to 6 people, T8 freed]'), notes.slice(-80));
  assert.ok(notes.length <= 500, String(notes.length));
  assert.ok(notes.startsWith('We are bringing a cake'), 'their own words come first, cut only at the end');
  // a second change: one note, the latest
  ok(await change(booked.id, { people: 8 }));
  notes = row('bookings', booked.id).notes;
  assert.ok(notes.endsWith(' [Changed online: 6 to 8 people]'), notes.slice(-60));
  assert.equal(notes.match(/\[Changed online:/g).length, 1);
  assert.ok(notes.length <= 500);
  // a short note keeps every word
  const short = ok(await book({ tables: ['T10'], people: 4, notes: 'Window seat please' })).booking;
  ok(await change(short.id, { people: 3 }));
  assert.equal(row('bookings', short.id).notes, 'Window seat please [Changed online: 4 to 3 people]');
});

test('numbers: a table\'s confirmation and its two-day reminder say its numbers can still be changed; a guest\'s and a locked one\'s don\'t', async () => {
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '', lair_booking_reminders: true }, ROOMS, []);
  const line = 'Numbers changed? Update them in My Lair by then too.';
  ok(await book());
  await settle();
  const confirmation = mailTo('mia@example.com').at(-1);
  assert.match(confirmation.subject, /^You're booked/);
  assert.ok(confirmation.text.includes(`Can't make it? Cancel in My Lair by Monday, 16 November at 6:00 pm (24 hours before). After that it stays on your tab, even if you can't come.\n\n${line}`), confirmation.text);
  // booked with no account: there's no My Lair to change it in
  ok(await book({ tables: ['T10'], people: 2, name: 'Guest Gary', email: 'gary@example.com' }, ''));
  // booked for tonight: locked at once
  ok(await book({ tables: ['T12'], people: 4, start: at('2026-11-14', 18), end: at('2026-11-14', 21), email: 'tonight@example.com' }));
  await settle();
  assert.ok(!mailTo('gary@example.com').at(-1).text.includes('Numbers changed?'));
  assert.ok(!mailTo('tonight@example.com').at(-1).text.includes('Numbers changed?'));
  // Sunday 9am, two days before Tuesday's table: the reminder
  sent = [];
  nowIs(at('2026-11-15', 9));
  ok(await call('POST', 'internal/reminders', { at: at('2026-11-15', 9) }, '', { 'X-Lair-Internal': '1' }));
  await settle();
  const reminder = mailTo('mia@example.com').find((m) => /^See you /.test(m.subject));
  assert.ok(reminder, sent.map((m) => `${m.to}: ${m.subject}`).join(' | '));
  assert.ok(reminder.text.includes(`Cancel free until 6pm Monday and your table goes back for someone else. After that, the $90 stays on your tab. ${line}`), reminder.text);
  const garys = mailTo('gary@example.com').find((m) => /^See you /.test(m.subject));
  assert.ok(garys && !garys.text.includes('Numbers changed?'), 'the guest\'s reminder is as it was');
});

test('move: five changes a game a day by its GM, then it waits for tomorrow; the team isn\'t counted', async () => {
  const { game } = await list();
  for (let i = 0; i < 5; i += 1) ok(await move(game.id, { tables: [i % 2 ? 'B1' : 'B2'] }));
  assert.equal(said(await move(game.id, { tables: ['B3'] })), "429 That's 5 changes to this game today. Try again tomorrow, or ask the team to help.");
  assert.equal(ok(await move(game.id, { tables: ['B3'] }, ANA)).moved, 1);
  nowIs(NOW + 24 * HOUR + MIN);
  assert.equal(ok(await move(game.id, { tables: ['B4'] })).moved, 1);
});

test('move: a fortnightly game takes its new day too, and says so in its own words', async () => {
  const listed = await list({ start: at('2026-11-21', 18), end: at('2026-11-21', 22), schedule: 'fortnightly', title: 'Every other week' });
  const ids = listed.sessions.map((s) => s.id);
  ok(await seat(ids[1], KAI, 'Kai'));
  await settle();
  sent = [];
  assert.equal(
    said(await move(ids[1], { start: at('2026-12-19', 18), end: at('2026-12-19', 22), scope: 'series' })),
    "422 That's a fortnight or more from its usual day. Pick a day closer to it, or cancel sessions and add new dates.",
  );
  // from Saturday 5 December to the Friday before, an hour later: ten days is inside a fortnight, so 13 days back would be too
  ok(await move(ids[1], { start: at('2026-12-04', 19), end: at('2026-12-04', 23), scope: 'series' }));
  assert.deepEqual(labels(listed.game.seriesId).slice(0, 3), ['Saturday, 21 November at 6:00 pm', 'Friday, 4 December at 7:00 pm', 'Friday, 18 December at 7:00 pm']);
  await settle();
  assert.ok(mailTo('kai@example.com')[0].text.includes('Heads up, friend: Every other week is moving to every second Friday at 7pm, from Friday 4 December.'), mailTo('kai@example.com')[0].text);
  nowIs(NOW + 28 * 24 * HOUR);
  topUp();
  const all = sessionsOf(listed.game.seriesId).map((r) => r.starts_at);
  for (let i = 2; i < all.length; i += 1) assert.equal(time.daysBetween(time.key(all[i - 1]), time.key(all[i])), 14, labels(listed.game.seriesId).join(' | '));
});

test('move: new tables for every later session too, and the dates the game adds later take them', async () => {
  const { ids, seriesId } = await weekly();
  const done = ok(await move(ids[1], { tables: ['B3'], scope: 'series' }));
  assert.equal(done.moved, ids.length - 1);
  assert.deepEqual(JSON.parse(gameRow(ids[0]).tables), ['B1'], 'the one before stays');
  for (const id of ids.slice(1)) assert.deepEqual(JSON.parse(gameRow(id).tables), ['B3'], id);
  assert.deepEqual(JSON.parse(row('series', seriesId).tables), ['B3']);
  assert.deepEqual(labels(seriesId).slice(0, 3), ['Saturday, 21 November at 6:00 pm', 'Saturday, 28 November at 6:00 pm', 'Saturday, 5 December at 6:00 pm'], 'no time changed');
  nowIs(NOW + 7 * 24 * HOUR);
  topUp();
  const newest = sessionsOf(seriesId).at(-1);
  assert.deepEqual([time.label(newest.starts_at), newest.tables], ['Saturday, 16 January at 6:00 pm', '["B3"]']);
});

test('move: staff with GM games move every later session of anyone\'s game, close to the day too, and the team isn\'t emailed about its own move', async () => {
  const { ids, seriesId } = await weekly({ start: at('2026-11-14', 18), end: at('2026-11-14', 22) });
  ok(await seat(ids[0], MIA, 'Mia'));
  await settle();
  sent = [];
  // tonight's session, nine hours away, to 7pm, and every later Saturday with it
  const done = ok(await move(ids[0], { start: at('2026-11-14', 19), end: at('2026-11-14', 23), scope: 'series' }, ANA));
  assert.equal(done.moved, ids.length);
  assert.ok(labels(seriesId).every((l) => /^Saturday, .* at 7:00 pm$/.test(l)));
  await settle();
  assert.deepEqual(mailTo('staff@dicegoblin.test'), []);
  assert.equal(mailTo('mia@example.com').length, 1);
  // Mia's seat is tonight: she can drop it until it starts
  assert.ok(mailTo('mia@example.com')[0].text.includes('Cancel your seat in My Lair by Saturday, 14 November at 7:00 pm'), mailTo('mia@example.com')[0].text);
});

test('move: a seat its GM pays for moves with the session, and so does the GM\'s charge for it', async () => {
  const { game } = await list();
  const mias = ok(await seat(game.id, MIA, 'Mia')).booking;
  ok(await call('POST', `games/${game.id}/players/${encodeURIComponent(mias.ref)}/cover`, {}, RANGI));
  ok(await move(game.id, { start: at('2026-11-18', 17), end: at('2026-11-18', 21) }));
  const charge = lair.sql.exec("SELECT starts_at, ends_at, status, amount FROM bookings WHERE game_id = ? AND kind = 'gm-cover'", game.id).one();
  assert.deepEqual([charge.starts_at, charge.ends_at, charge.status, charge.amount], [at('2026-11-18', 17), at('2026-11-18', 21), 'confirmed', 1000]);
  const cover = (await me(RANGI)).covers[0];
  assert.deepEqual([cover.start, cover.locked], [at('2026-11-18', 17), false]);
  // Mia's told how to drop out without "it stays on your tab" (her GM's paying)
  await settle();
  assert.ok(mailTo('mia@example.com').at(-1).text.includes("Cancel your seat in My Lair by Tuesday, 17 November at 5:00 pm and Gobgob will let your GM know. After that it's locked in."), mailTo('mia@example.com').at(-1).text);
});

test('move: a game waiting for a staff goblin\'s OK can move too, and stays waiting', async () => {
  // Kai isn't a trusted GM: his game waits for approval
  const listed = ok(await call('POST', 'games', { title: "Kai's first game", system: 'D&D 5e', gm: 'Kai', blurb: 'A test session.', seats: 4, tables: ['B4'], start: at('2026-11-20', 18), end: at('2026-11-20', 22), email: 'kai@example.com' }, KAI));
  assert.equal(listed.pending, true);
  const done = ok(await move(listed.game.id, { start: at('2026-11-21', 18), end: at('2026-11-21', 22) }, KAI));
  assert.equal(done.game.status, 'pending');
  assert.equal(done.game.start, at('2026-11-21', 18));
});

test('move: a regular whose seat at the moved session is saved, not booked yet, hears about the new time too', async () => {
  const { ids } = await weekly();
  // Mia's a regular: her seat is booked in the next session (the 21st) and saved, not booked, in the ones after
  ok(await joinEvery(ids[0], MIA, 'Mia'));
  ok(await seat(ids[1], KAI, 'Kai'));
  await settle();
  sent = [];
  const done = ok(await move(ids[1], { start: at('2026-11-29', 13), end: at('2026-11-29', 17) }));
  assert.equal(done.told, 2);
  await settle();
  const mia = mailTo('mia@example.com');
  assert.equal(mia.length, 1);
  assert.equal(mia[0].subject, 'New time: Curse of Strahd, Sunday, 29 November at 1:00 pm to 5:00 pm');
  assert.ok(mia[0].text.includes('Heads up, friend: Curse of Strahd has moved. Gobgob saves your seat at the new time.'), mia[0].text);
  assert.ok(mia[0].text.includes("Can't make the new time? Skip a session or stop saving your seat in My Lair."), mia[0].text);
  assert.ok(mailTo('kai@example.com')[0].text.includes('Your seat moved with it.'));
});

/* ================= 5. seats and sign-ups booked for friends: drop some without cancelling the lot ================= */
// Mo, 9:25am the same morning: "I want people who bought tickets to Thier friends can cancel themselves. Just like gms.
// So that it is all working together. Effortlessly. [...] customers who signed up to cancel up to 24 hours before the
// session is due and must call us to cancel if it is within that time frame." (contract v37-changes, section 2)

/** Mia books a seat for each name at a session (the first is hers unless said) */
const seats = (gameId, names, who = MIA, over = {}) => call('POST', 'bookings', {
  kind: 'gm-seat', gameId, people: names.length, name: 'Mia Chen', email: 'mia@example.com', phone: '021 555 0100', players: names.map((name) => ({ name })), ...over,
}, who);
const LOCKED_CHANGE = "409 It's less than 24 hours away, so it can't be changed online now: it stays on your tab as it is. Have a chat with us at the counter or give us a call, and we'll sort it out.";

test('seats: three seats become two, three days ahead: the price follows, the seat goes back on the board, their GM hears, and they get one email', async () => {
  const { game } = await list();
  const booked = ok(await seats(game.id, ['Mia', 'Kiri', 'Jo'])).booking;
  assert.equal(booked.amount, 4500);
  await settle();
  sent = [];
  // My Lair says what can change: one to three seats, who's on them, $15 each, until Monday 6pm (as cancelling)
  const mine = (await me(MIA)).seats.find((s) => s.id === booked.id);
  assert.deepEqual(mine.change, {
    until: at('2026-11-16', 18), min: 1, max: 3, each: 1500, who: [{ name: 'Mia', cost: 1500 }, { name: 'Kiri', cost: 1500 }, { name: 'Jo', cost: 1500 }],
  });
  assert.equal(mine.cancelUntil, mine.change.until);
  // Kiri can't come
  const done = ok(await change(booked.id, { people: 2, staying: [0, 2] }));
  assert.deepEqual(done.changed, { people: { from: 3, to: 2 }, players: { from: ['Mia', 'Kiri', 'Jo'], to: ['Mia', 'Jo'] }, amount: { from: 4500, to: 3000 } });
  const now = (await me(MIA)).seats.find((s) => s.id === booked.id);
  assert.deepEqual([now.people, now.amount, now.due, now.status, now.paid], [2, 3000, 3000, 'confirmed', false]);
  assert.deepEqual(now.players.map((p) => p.name), ['Mia', 'Jo']);
  assert.deepEqual([now.change.max, now.change.who.length], [2, 2]);
  await settle();
  const mail = mailTo('mia@example.com');
  assert.equal(mail.length, 1);
  assert.equal(mail[0].subject, 'Booking changed: 2 seats on Tuesday 17 November');
  for (const words of [
    "Kia ora Mia Chen, Gobgob has updated your seats at Rangi's game.", '2 (it was 3)', 'Mia, Jo', '$30.00, on your tab (it was $45.00)',
    "Can't make it? Cancel in My Lair by Monday, 16 November at 6:00 pm (24 hours before). After that it stays on your tab, even if you can't come.",
  ]) assert.ok(mail[0].text.includes(words), `${words}\n${mail[0].text}`);
  assert.ok(!mail[0].text.includes('Kiri'), 'nobody who dropped out is named');
  // their GM hears, with who's still coming
  const gm = mailTo('rangi@example.com');
  assert.equal(gm.length, 1);
  assert.equal(gm[0].subject, "Seat dropped: Rangi's game, Tuesday, 17 November at 6:00 pm to 10:00 pm");
  assert.ok(gm[0].text.includes("Kia ora Rangi, Mia Chen dropped 1 of their 3 seats at Rangi's game. The spot's back on the games board for someone else."), gm[0].text);
  assert.ok(gm[0].text.includes('Mia, Jo') && gm[0].text.includes('2 of 4'), gm[0].text);
  assert.deepEqual(mailTo('staff@dicegoblin.test'), [], 'nothing for the team to do');
  // the seat is back on the board: Kai takes the other two, and then it's full
  ok(await seat(game.id, KAI, 'Kai', 2));
  assert.equal(said(await seat(game.id, RIA, 'Ria')), '409 This table is full.');
  // the note for staff, on the booking
  assert.equal(row('bookings', booked.id).notes, '[Changed online: 3 to 2 seats]');
});

test('seats: left to the Lair, the last seats go; and what stops a change changes nothing', async () => {
  const { game } = await list();
  const booked = ok(await seats(game.id, ['Mia', 'Kiri', 'Jo'])).booking;
  await settle();
  sent = [];
  const same = async () => {
    const r = row('bookings', booked.id);
    assert.deepEqual([r.people, r.amount, r.party], [3, 4500, JSON.stringify([{ name: 'Mia', character: '' }, { name: 'Kiri', character: '' }, { name: 'Jo', character: '' }])]);
  };
  const count = '422 Tell us how many seats to keep. To give them all up, cancel the booking instead.';
  for (const people of [0, -1, 1.5, 'two', '']) assert.equal(said(await change(booked.id, { people, staying: [0] })), count, String(people));
  assert.equal(said(await change(booked.id, { people: 4 })), '422 To bring someone else, give us a call or ask at the counter. Here you can give seats up.');
  const who = "422 Pick who's still coming: one name for each seat you're keeping.";
  for (const staying of [[0], [0, 1, 2], [0, 0], [0, 3], [0, -1], [0, 1.5], 'Mia', [0, 'Jo']]) assert.equal(said(await change(booked.id, { people: 2, staying })), who, JSON.stringify(staying));
  // their tables aren't theirs to change, and nobody else can change it at all
  assert.equal(said(await change(booked.id, { tables: ['B2'] })), '403 Only staff can change that booking.');
  assert.equal(said(await change(booked.id, { people: 2 }, KAI)), '403 Only staff can change that booking.');
  assert.equal(said(await change(booked.id, { people: 2 }, '')), '403 Only staff can change that booking.');
  await same();
  // asking for what it is already changes nothing and emails nobody
  assert.equal(ok(await change(booked.id, { people: 3 })).changed, null);
  assert.equal(ok(await change(booked.id, { people: '3', staying: [2, 1, 0] })).changed, null);
  await same();
  await settle();
  assert.deepEqual(sent, []);
  // no names sent: the last seats go
  const done = ok(await change(booked.id, { people: 1 }));
  assert.deepEqual(done.changed.players, { from: ['Mia', 'Kiri', 'Jo'], to: ['Mia'] });
  assert.equal(done.booking.amount, 1500);
  await settle();
  assert.ok(mailTo('rangi@example.com')[0].text.includes("Mia Chen dropped 2 of their 3 seats at Rangi's game. The spots are back on the games board for someone else."), mailTo('rangi@example.com')[0].text);
  assert.equal(mailTo('mia@example.com')[0].subject, 'Booking changed: 1 seat on Tuesday 17 November');
  // one seat has nothing to change here: giving it up is the cancel
  assert.equal((await me(MIA)).seats.find((s) => s.id === booked.id).change, undefined);
  assert.equal(ok(await change(booked.id, { status: 'cancelled' })).booking.status, 'cancelled');
  assert.equal(said(await change(booked.id, { people: 1 })), "409 That booking's been cancelled, so there's nothing to change.");
});

test('seats: the last moment is 24 hours before it starts, to the minute; after that it\'s a call, and staff still can', async () => {
  const { game } = await list();
  const start = at('2026-11-17', 18);
  const booked = ok(await seats(game.id, ['Mia', 'Kiri', 'Jo'])).booking;
  nowIs(start - 24 * HOUR - MIN);
  assert.equal(ok(await change(booked.id, { people: 2 })).booking.people, 2);
  nowIs(start - 24 * HOUR);
  assert.equal(said(await change(booked.id, { people: 1 })), LOCKED_CHANGE);
  const mine = (await me(MIA)).seats.find((s) => s.id === booked.id);
  assert.deepEqual([mine.people, mine.locked, mine.change], [2, true, undefined]);
  // the call: someone at the desk takes a seat off it the staff way, as before
  assert.equal(ok(await change(booked.id, { people: 1 }, HEMI)).booking.people, 1);
  assert.equal(row('bookings', booked.id).amount, 1500);
  // booked inside the 24 hours: locked in at once, as it says before they book
  nowIs(NOW);
  const tonight = (await list({ start: at('2026-11-14', 18), end: at('2026-11-14', 22), tables: ['B2'], title: 'Tonight' })).game;
  const late = ok(await seats(tonight.id, ['Mia', 'Kiri'])).booking;
  assert.equal(said(await change(late.id, { people: 1 })), LOCKED_CHANGE);
  // and once it has started
  nowIs(at('2026-11-14', 18, 5));
  assert.equal(said(await change(late.id, { people: 1 })), "409 That one has already started, so it can't be changed online. Have a chat with us at the counter.");
});

test('seats: taken off the staff way (the desk, or someone on the team changing their own in My Lair), the players named go with the seats', async () => {
  const { game } = await list();
  const booked = ok(await seats(game.id, ['Mia', 'Kiri', 'Jo'])).booking;
  // the desk takes one off (the call inside 24 hours): the last name goes with it
  nowIs(at('2026-11-17', 12));
  assert.equal(ok(await change(booked.id, { people: 2 }, HEMI)).booking.people, 2);
  assert.deepEqual(JSON.parse(row('bookings', booked.id).party).map((p) => p.name), ['Mia', 'Kiri']);
  // so their GM's list of players shows who's coming, not who was
  assert.deepEqual((await me(RANGI)).games.find((g) => g.id === game.id).players.map((p) => p.name), ['Mia', 'Kiri']);
  // Mo's own seats, changed in My Lair with his staff login: the staff way (no lock, no email), keeping who he picked
  nowIs(NOW);
  const other = (await list({ start: at('2026-11-18', 18), end: at('2026-11-18', 22), tables: ['B2'], title: 'Wednesday' })).game;
  const own = ok(await seats(other.id, ['Mo', 'Ana', 'Hemi'], OWNER, { name: 'Mo Ashgrove', email: 'owner@example.com' })).booking;
  nowIs(at('2026-11-18', 12));
  assert.equal(ok(await change(own.id, { people: 2, staying: [0, 2] }, OWNER)).booking.people, 2);
  assert.deepEqual(JSON.parse(row('bookings', own.id).party).map((p) => p.name), ['Mo', 'Hemi']);
  assert.equal(row('bookings', own.id).amount, 3000);
  // a pick that isn't one falls back to the first names; more people than names leaves the names alone
  ok(await change(own.id, { people: 1, staying: ['nope'] }, OWNER));
  assert.deepEqual(JSON.parse(row('bookings', own.id).party).map((p) => p.name), ['Mo']);
  ok(await change(own.id, { people: 2 }, OWNER));
  assert.deepEqual(JSON.parse(row('bookings', own.id).party).map((p) => p.name), ['Mo']);
});

test('seats: money already on them for more seats than they\'re keeping is staff\'s to sort; less than that is fine', async () => {
  const { game } = await list();
  const booked = ok(await seats(game.id, ['Mia', 'Kiri', 'Jo'])).booking;
  // $30 paid at the counter ahead of time (two of the three seats)
  lair.write('UPDATE bookings SET paid_amount = 3000 WHERE id = ?', booked.id);
  assert.equal(said(await change(booked.id, { people: 1 })), "409 You've paid for more people than that already. Have a chat with us at the counter or give us a call, and we'll sort out the change and your money back.");
  assert.equal(row('bookings', booked.id).people, 3);
  const done = ok(await change(booked.id, { people: 2 }));
  assert.deepEqual([done.booking.amount, done.booking.paid, done.booking.due], [3000, true, 0]);
});

test('seats: a seat booking its GM pays for: the GM\'s charge follows the seats that stay, and its lock has its own words', async () => {
  const { game } = await list();
  const booked = ok(await seats(game.id, ['Mia', 'Kiri'])).booking;
  ok(await call('POST', `games/${game.id}/players/${encodeURIComponent(booked.ref)}/cover`, {}, RANGI));
  const charge = () => lair.sql.exec("SELECT people, amount, status FROM bookings WHERE cover_of = ? AND kind = 'gm-cover'", booked.id).one();
  assert.deepEqual({ ...charge() }, { people: 2, amount: 2000, status: 'confirmed' });
  const mine = (await me(MIA)).seats.find((s) => s.id === booked.id);
  assert.deepEqual([mine.amount, mine.coveredByGm, mine.change.each], [0, true, 0]);
  await settle();
  sent = [];
  const done = ok(await change(booked.id, { people: 1, staying: [1] }));
  assert.deepEqual(done.changed, { people: { from: 2, to: 1 }, players: { from: ['Mia', 'Kiri'], to: ['Kiri'] }, amount: { from: 0, to: 0 } });
  assert.deepEqual({ ...charge() }, { people: 1, amount: 1000, status: 'confirmed' });
  await settle();
  assert.ok(mailTo('mia@example.com')[0].text.includes('Nothing to pay'), mailTo('mia@example.com')[0].text);
  // (two seats again, to try the lock)
  const other = (await list({ start: at('2026-11-18', 18), end: at('2026-11-18', 22), tables: ['B2'], title: 'Wednesday' })).game;
  const pair = ok(await seats(other.id, ['Mia', 'Kiri'])).booking;
  ok(await call('POST', `games/${other.id}/players/${encodeURIComponent(pair.ref)}/cover`, {}, RANGI));
  nowIs(at('2026-11-18', 18) - 24 * HOUR);
  assert.equal(said(await change(pair.id, { people: 1 })), "409 It's less than 24 hours away, so it can't be changed online now. Your GM pays for your seats if you come. Have a chat with us at the counter or give us a call, and we'll sort it out.");
});

test('seats: a regular who brings a friend drops one seat for a session; Gobgob saves both again for the next', async () => {
  const { ids, seriesId } = await weekly();
  ok(await call('POST', `games/${ids[0]}/join-series`, { people: 2, name: 'Mia Chen', email: 'mia@example.com', phone: '021 555 0100', players: [{ name: 'Mia' }, { name: 'Kiri' }] }, MIA));
  const first = lair.sql.exec("SELECT id, people FROM bookings WHERE game_id = ? AND customer_id = ? AND kind = 'gm-seat'", ids[0], MIA).one();
  assert.equal(first.people, 2);
  const done = ok(await change(first.id, { people: 1, staying: [0] }));
  assert.deepEqual([done.booking.people, done.booking.amount], [1, 1500]);
  assert.equal(lair.sql.exec('SELECT people FROM series_members WHERE series_id = ? AND customer_id = ?', seriesId, MIA).one().people, 2, 'they still save two seats a session');
  // Saturday's session ends, and the 10-minute run saves their seats in the next one: both of them
  nowIs(at('2026-11-21', 22) + MIN);
  lair.rollSeries(lair.rulesCache, Date.now());
  const next = lair.sql.exec("SELECT people, amount FROM bookings WHERE game_id = ? AND customer_id = ? AND kind = 'gm-seat'", ids[1], MIA).one();
  assert.deepEqual({ ...next }, { people: 2, amount: 3000 });
});

test('seats: a booking for more than one seat says in its confirmation and its two-day reminder that the numbers can change; one seat\'s don\'t', async () => {
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '', lair_booking_reminders: true }, ROOMS, []);
  const line = 'Numbers changed? Update them in My Lair by then too.';
  const { game } = await list();
  ok(await seats(game.id, ['Mia', 'Kiri']));
  ok(await seat(game.id, KAI, 'Kai'));
  await settle();
  const confirmation = mailTo('mia@example.com').at(-1);
  assert.match(confirmation.subject, /^Seat saved/);
  assert.ok(confirmation.text.includes(`Can't make it? Cancel in My Lair by Monday, 16 November at 6:00 pm (24 hours before). After that it stays on your tab, even if you can't come.\n\n${line}`), confirmation.text);
  assert.ok(!mailTo('kai@example.com').at(-1).text.includes('Numbers changed?'), 'one seat: cancelling is the change');
  sent = [];
  nowIs(at('2026-11-15', 9));
  ok(await call('POST', 'internal/reminders', { at: at('2026-11-15', 9) }, '', { 'X-Lair-Internal': '1' }));
  await settle();
  const reminder = mailTo('mia@example.com').find((m) => /^See you /.test(m.subject));
  assert.ok(reminder, sent.map((m) => `${m.to}: ${m.subject}`).join(' | '));
  assert.ok(reminder.text.includes(`After that, the $30 stays on your tab. ${line}`), reminder.text);
  const kais = mailTo('kai@example.com').find((m) => /^See you /.test(m.subject));
  assert.ok(kais && !kais.text.includes('Numbers changed?'), kais?.text);
});

/* ---- event sign-ups with friends ---- */
// Blood on the Clocktower as it's run: Sunday 29 November, 12pm to 6pm, $10, 40 places. A library social the same
// afternoon that's free for library members ($10 for anyone else), and a championship that's paid online.
const EVENTS = [
  { id: 'clocktower', title: 'Blood on the Clocktower', start: at('2026-11-29', 12), end: at('2026-11-29', 18), tables: '', capacity: 40, entryFee: 1000 },
  { id: 'social', title: 'Library social', start: at('2026-11-29', 13), end: at('2026-11-29', 17), tables: '', capacity: 20, entryFee: 1000, memberFree: true, type: 'social' },
  { id: 'champs', title: 'Riftbound championship', start: at('2026-11-29', 11), end: at('2026-11-29', 17), tables: '', capacity: 32, entryFee: 2500, payment: 'online' },
];
const CLOCKTOWER = 'clocktower@2026-11-29';
const SOCIAL = 'social@2026-11-29';
const CHAMPS = 'champs@2026-11-29';
const withEvents = (settings = {}) => {
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '', ...settings }, ROOMS, EVENTS);
};
const signUp = (occurrence, body = {}, who = MIA) => call('POST', `events/${occurrence}/join`, { name: 'Mia Chen', email: 'mia@example.com', phone: '021 555 0100', ...body }, who);
const changeJoin = (id, body, who = MIA) => call('POST', `events/joins/${id}/change`, body, who);
const codeOf = async (who) => (await me(who)).member.code;
const joinRow = (id) => row('event_joins', id);
/** A Lair library membership that lets them borrow today (as test/round30-library.test.js makes one) */
let plans = 0;
const libraryMember = (customerId) => {
  plans += 1;
  lair.sql.exec(
    'INSERT INTO memberships (id, contract_gid, customer_id, status, tier, billing_tier, cancel_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    `ms-test-${plans}`, `gid://shopify/SubscriptionContract/9${plans}`, customerId, 'active', 'grab', 'grab', null, NOW - 30 * 24 * HOUR,
  );
};

test('sign-ups: three people become two, a fortnight ahead: the entry follows, the place goes back, and they get one email', async () => {
  withEvents();
  const kai = await codeOf(KAI);
  const signed = ok(await signUp(CLOCKTOWER, { guests: [{ code: kai }, { name: 'Jo' }] }));
  assert.deepEqual([signed.join.people, signed.join.amount, signed.spacesLeft], [3, 3000, 37]);
  await settle();
  sent = [];
  // My Lair says what can change: who's coming with them, $10 a place, until Saturday noon (as cancelling)
  const mine = (await me(MIA)).joins.find((j) => j.id === signed.join.id);
  assert.deepEqual(mine.change, { until: at('2026-11-28', 12), min: 1, max: 3, each: 1000, you: 1000, who: [{ name: 'Kai Tane', cost: 1000 }, { name: 'Jo', cost: 1000 }] });
  assert.equal(mine.cancelUntil, mine.change.until);
  // Jo can't come
  const done = ok(await changeJoin(signed.join.id, { people: 2, staying: [0] }));
  assert.deepEqual(done.changed, { people: { from: 3, to: 2 }, guests: { from: ['Kai Tane', 'Jo'], to: ['Kai Tane'] }, amount: { from: 3000, to: 2000 } });
  assert.deepEqual([done.join.people, done.join.amount, done.join.due, done.join.status], [2, 2000, 2000, 'confirmed']);
  assert.deepEqual(done.join.guests, [{ name: 'Kai Tane', member: true }]);
  assert.equal(joinRow(signed.join.id).note, '[Changed online: 3 to 2 people]');
  // the place is back: 38 of 40 left for the next person
  assert.equal(ok(await signUp(CLOCKTOWER, { name: 'Ria Moana', email: 'ria@example.com', people: 1 }, RIA)).spacesLeft, 37);
  // Kai still has it in his My Lair, as Mia's guest
  assert.equal((await me(KAI)).joins.filter((j) => j.id === signed.join.id).length, 1);
  await settle();
  const mail = mailTo('mia@example.com');
  assert.equal(mail.length, 1);
  assert.equal(mail[0].subject, 'Booking changed: 2 people on Sunday 29 November');
  for (const words of [
    'Kia ora Mia Chen, Gobgob has updated your sign-up for Blood on the Clocktower.', '2 (it was 3)', 'Mia Chen, Kai Tane', '$20.00, on your tab (it was $30.00)',
    "Can't make it? Cancel in My Lair by Saturday, 28 November at 12:00 pm (24 hours before). After that it stays on your tab, even if you can't come.",
  ]) assert.ok(mail[0].text.includes(words), `${words}\n${mail[0].text}`);
  assert.ok(!mail[0].text.includes('Jo'), 'nobody who dropped out is named');
  // then Kai can't either: it's just Mia, and it leaves his My Lair
  const alone = ok(await changeJoin(signed.join.id, { people: 1 }));
  assert.deepEqual([alone.join.people, alone.join.amount, alone.join.guests], [1, 1000, []]);
  assert.equal((await me(KAI)).joins.filter((j) => j.id === signed.join.id).length, 0);
  assert.equal((await me(MIA)).joins.find((j) => j.id === signed.join.id).change, undefined, 'one person: cancelling is the change');
});

test('sign-ups: what stops a change changes nothing, and only whoever signed up can make one', async () => {
  withEvents();
  const kai = await codeOf(KAI);
  const id = ok(await signUp(CLOCKTOWER, { guests: [{ code: kai }, { name: 'Jo' }] })).join.id;
  await settle();
  sent = [];
  const count = '422 Tell us how many people are coming. To call it off, cancel your sign-up instead.';
  for (const people of [0, -2, 2.5, 'some', null, undefined]) assert.equal(said(await changeJoin(id, { people })), count, String(people));
  assert.equal(said(await changeJoin(id, { people: 4 })), '422 To bring someone else, give us a call or ask at the counter. Here you can take people off.');
  const who = "422 Pick who's still coming with you.";
  for (const staying of [[], [0, 1], [2], [-1], [0.5], 'Kai', ['Kai']]) assert.equal(said(await changeJoin(id, { people: 2, staying })), who, JSON.stringify(staying));
  // Kai is on it as a guest: it's Mia's to change. Ria isn't on it at all. Staff cancel one or add one, as before.
  assert.equal(said(await changeJoin(id, { people: 2 }, KAI)), '403 Only the person who signed up can change this. Ask them, or the counter.');
  assert.equal(said(await changeJoin(id, { people: 2 }, RIA)), '403 Only whoever signed up can change who\'s coming.');
  assert.equal(said(await changeJoin(id, { people: 2 }, '')), '403 Only whoever signed up can change who\'s coming.');
  assert.equal(said(await changeJoin(id, { people: 2 }, HEMI)), '403 Only whoever signed up can change who\'s coming.');
  assert.equal(said(await changeJoin('ej-nope', { people: 2 })), '404 Sign-up not found.');
  assert.deepEqual([joinRow(id).people, joinRow(id).amount], [3, 3000]);
  // what it is already: nothing changes, nobody's emailed
  assert.equal(ok(await changeJoin(id, { people: 3 })).changed, null);
  assert.equal(ok(await changeJoin(id, { people: 3, staying: [1, 0] })).changed, null);
  await settle();
  assert.deepEqual(sent, []);
  // the last moment is 24 hours before it starts, to the minute; after that it's a call
  nowIs(at('2026-11-29', 12) - 24 * HOUR - MIN);
  assert.equal(ok(await changeJoin(id, { people: 2, staying: [1] })).join.guests[0].name, 'Jo');
  nowIs(at('2026-11-29', 12) - 24 * HOUR);
  assert.equal(said(await changeJoin(id, { people: 1 })), LOCKED_CHANGE);
  assert.deepEqual([(await me(MIA)).joins.find((j) => j.id === id).locked, (await me(MIA)).joins.find((j) => j.id === id).change], [true, undefined]);
  // started, and cancelled
  nowIs(at('2026-11-29', 12, 10));
  assert.equal(said(await changeJoin(id, { people: 1 })), "409 That one has already started, so it can't be changed online. Have a chat with us at the counter.");
  nowIs(NOW);
  const other = ok(await signUp(CLOCKTOWER, { name: 'Ria Moana', email: 'ria@example.com', people: 2 }, RIA)).join.id;
  ok(await call('POST', `events/joins/${other}/cancel`, {}, RIA));
  assert.equal(said(await changeJoin(other, { people: 1 }, RIA)), "409 That sign-up's been cancelled, so there's nothing to change.");
});

test('sign-ups: friends without names (an older page) come off by the number, and money already on it for more people is staff\'s to sort', async () => {
  withEvents();
  const id = ok(await signUp(CLOCKTOWER, { people: 4 })).join.id;
  const mine = (await me(MIA)).joins.find((j) => j.id === id);
  assert.deepEqual(mine.change.who, [{ name: '', cost: 1000 }, { name: '', cost: 1000 }, { name: '', cost: 1000 }]);
  assert.deepEqual(ok(await changeJoin(id, { people: 3 })).changed, { people: { from: 4, to: 3 }, guests: { from: [], to: [] }, amount: { from: 4000, to: 3000 } });
  // $20 paid at the counter ahead of time
  lair.write('UPDATE event_joins SET paid_amount = 2000 WHERE id = ?', id);
  assert.equal(said(await changeJoin(id, { people: 1 })), "409 You've paid for more people than that already. Have a chat with us at the counter or give us a call, and we'll sort out the change and your money back.");
  const done = ok(await changeJoin(id, { people: 2 }));
  assert.deepEqual([done.join.amount, done.join.paid, done.join.due], [2000, true, 0]);
  // one from before everything went on the tab (round 15), held for an online payment and then paid online, so locked
  // in with staff deciding on money back: neither changes here
  const held = ok(await signUp(CHAMPS, { name: 'Ria Moana', email: 'ria@example.com', people: 2 }, RIA)).join;
  assert.notEqual((await me(RIA)).joins.find((j) => j.id === held.id).change, undefined, 'on their tab, it can change');
  lair.write("UPDATE event_joins SET status = 'held', pay = 'now' WHERE id = ?", held.id);
  const notHere = "409 That sign-up can't be changed online. Have a chat with us and we'll sort it out.";
  assert.equal(said(await changeJoin(held.id, { people: 1 }, RIA)), notHere);
  lair.write("UPDATE event_joins SET status = 'confirmed', paid = 1, paid_amount = 5000 WHERE id = ?", held.id);
  assert.equal(said(await changeJoin(held.id, { people: 1 }, RIA)), notHere);
  assert.equal((await me(RIA)).joins.find((j) => j.id === held.id).change, undefined);
});

test('sign-ups: at an event free for library members, a place comes off at what that place costs today, as the door prices it', async () => {
  withEvents();
  // Mia and Kai are library members; Jo comes by name, so Jo pays
  libraryMember(MIA);
  libraryMember(KAI);
  const kai = await codeOf(KAI);
  const signed = ok(await signUp(SOCIAL, { guests: [{ code: kai }, { name: 'Jo' }] })).join;
  assert.deepEqual([signed.people, signed.amount, signed.memberFree, signed.freeGuests], [3, 1000, true, 1]);
  const mine = (await me(MIA)).joins.find((j) => j.id === signed.id);
  assert.deepEqual(mine.change, { until: at('2026-11-28', 13), min: 1, max: 3, each: 1000, you: 0, who: [{ name: 'Kai Tane', cost: 0 }, { name: 'Jo', cost: 1000 }] });
  // Kai drops out: Jo's $10 stays
  const kaiOut = ok(await changeJoin(signed.id, { people: 2, staying: [1] }));
  assert.deepEqual([kaiOut.join.amount, kaiOut.join.memberFree, kaiOut.join.freeGuests], [1000, true, undefined]);
  assert.deepEqual(kaiOut.changed.amount, { from: 1000, to: 1000 });
  // then Jo does: nothing to pay
  const joOut = ok(await changeJoin(signed.id, { people: 1 }));
  assert.deepEqual([joOut.join.amount, joOut.join.people, joOut.join.memberFree], [0, 1, true]);
});

test('sign-ups: one for more than one person says in its confirmation and its two-day reminder that the numbers can change; one person\'s don\'t', async () => {
  withEvents({ lair_booking_reminders: true });
  const line = 'Numbers changed? Update them in My Lair by then too.';
  ok(await signUp(CLOCKTOWER, { guests: [{ name: 'Jo' }] }));
  ok(await signUp(CLOCKTOWER, { name: 'Ria Moana', email: 'ria@example.com', people: 1 }, RIA));
  await settle();
  const confirmation = mailTo('mia@example.com').at(-1);
  assert.match(confirmation.subject, /^You're in/);
  assert.ok(confirmation.text.includes(`Can't make it? Cancel in My Lair by Saturday, 28 November at 12:00 pm (24 hours before). After that it stays on your tab, even if you can't come.\n\n${line}`), confirmation.text);
  assert.ok(!mailTo('ria@example.com').at(-1).text.includes('Numbers changed?'), 'one person: cancelling is the change');
  sent = [];
  nowIs(at('2026-11-27', 9));
  ok(await call('POST', 'internal/reminders', { at: at('2026-11-27', 9) }, '', { 'X-Lair-Internal': '1' }));
  await settle();
  const reminder = mailTo('mia@example.com').find((m) => /^See you /.test(m.subject));
  assert.ok(reminder, sent.map((m) => `${m.to}: ${m.subject}`).join(' | '));
  assert.ok(reminder.text.includes(`After that, the $20 stays on your tab. ${line}`), reminder.text);
  const rias = mailTo('ria@example.com').find((m) => /^See you /.test(m.subject));
  assert.ok(rias && !rias.text.includes('Numbers changed?'), rias?.text);
});

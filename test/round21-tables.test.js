// 27 Oct 2026, a session's new tables for its later sessions too (contract v21-tables). Mo: "I want there to be an option
// for games when they change Thier table location they keep that location for the future sessions, I noticed when I made
// a session on one table space it changed the next week I want it to be able to keep that new space when changed".
// Until now, Edit session moved one session only, and the weekly game's later sessions (and the ones it makes later) kept
// the tables it was listed on. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { GAME_TABLE_WORDS as W } from '../src/lair.js';

// The staff page's refusal for a permission someone hasn't got (NOT_PERMITTED in src/lair.js)
const NOT_PERMITTED = "That's not one of your staff permissions. Ask the main account to tick it on the Team tab.";

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
// Friday 16 October 2026, 1:00pm in Auckland (NZDT, UTC+13): round 18
const NOW = Date.UTC(2026, 9, 16, 0, 0);
const realNow = Date.now;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);

/* ---------------- helpers, as in test/round17-staff-gm-credit.test.js ---------------- */
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
// People by their Shopify customer IDs (made up): the main account; helpers Ana (GM games), Hemi (Check-in and Money)
// and Tama (Library only), who all run sessions; Rangi, a GM who isn't staff; and players
const OWNER = '9001';
const ANA = '9101';
const HEMI = '9102';
const TAMA = '9103';
const RANGI = '5001';
const MIA = '6001';
const KAI = '6002';
const RIA = '6003';

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
const newSeats = (id, body, who) => call('POST', `games/${id}/new-seats`, body, who);
const setFree = (id, body, who = OWNER) => call('POST', `games/${id}/free`, body, who);
const removeSeat = (id, ref, who) => call('POST', `games/${id}/players/${encodeURIComponent(ref)}/remove`, {}, who);
const changeGm = (id, body, who = OWNER) => call('POST', `games/${id}/gm`, body, who);
const addPlayer = (id, body, who) => call('POST', `games/${id}/players`, { people: 1, ...body }, who);
const me = async (who) => ok(await call('GET', 'me', null, who));
const board = async (who = '') => ok(await call('GET', `floor?from=${at('2026-10-16', 0)}&to=${at('2026-11-14', 0)}`, null, who));
const gameOn = async (id, who = '') => (await board(who)).games.find((g) => g.id === id);

const NAMES = { [OWNER]: 'Mo', [ANA]: 'Ana', [HEMI]: 'Hemi', [TAMA]: 'Tama', [RANGI]: 'Rangi' };

/** A session listed by the main account for a GM (Tama unless said), Saturday 17 October 6pm to 10pm unless said */
async function list({ gm = TAMA, start = at('2026-10-17', 18), end = at('2026-10-17', 22), seats = 4, schedule, gmFee, tables = ['B1'], title } = {}) {
  const name = NAMES[gm];
  return ok(await call('POST', 'games', {
    title: title || `${name}'s one-shot`, system: 'D&D 5e', gm: name, blurb: 'A test session.', seats, tables, start, end,
    gmCustomerId: gm, gmCustomerName: name, gmEmail: `${name.toLowerCase()}@example.com`,
    ...(schedule ? { schedule } : {}), ...(gmFee === undefined ? {} : { gmFee }),
  }, OWNER));
}

/** A seat booked online: a customer's (who) or a guest's (who ''), with an email from their name */
const seat = (gameId, who, name, people = 1, email = `${name.toLowerCase()}@example.com`) => call('POST', 'bookings', {
  kind: 'gm-seat', gameId, people, name, email, phone: '021 555 0100', pay: 'day',
}, who);

/** Kai and Ria (and anyone else said) played at a session on Saturday afternoon; it's Sunday morning after it */
async function playedBefore(people = [[KAI, 'Kai'], [RIA, 'Ria']]) {
  const { game } = await list({ gm: ANA, start: at('2026-10-17', 13), end: at('2026-10-17', 16), seats: 4, tables: ['B2'], title: 'Saturday one-shot' });
  for (const [who, name] of people) ok(await seat(game.id, who, name));
  Date.now = () => at('2026-10-18', 10);
  return game.id;
}

function captureEmails() {
  const env = lair.baseEnv;
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test' };
  const sent = [];
  const before = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return {
    sent,
    restore: () => {
      globalThis.fetch = before;
      lair.baseEnv = env;
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

// No network in these tests: no Shopify and no emails (but captureEmails' stand-in for Resend). Anything that reaches for
// it is noted, and the test fails.
const realFetch = globalThis.fetch;
let reached = [];
let credited = [];
// Shopify's off (GET /me would ask it for things) unless a test turns it on for the GM credit
let shopifyOn = false;

beforeEach(async () => {
  reached = [];
  credited = [];
  shopifyOn = false;
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  // The main account is tagged staff in Shopify; helpers are the Lair's own
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.searchCustomers = async () => [{ customerId: OWNER, name: 'Mo', email: 'owner@example.com' }];
  Object.defineProperty(lair.shopify, 'configured', { get: () => shopifyOn, configurable: true });
  lair.shopify.creditCustomer = async (customerId, cents) => {
    credited.push([customerId, cents]);
  };
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  for (const [id, name, perms] of [[ANA, 'Ana Ngata', ['sessions']], [HEMI, 'Hemi Walker', ['checkin', 'money']], [TAMA, 'Tama Rewi', ['library']]]) {
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


const edit = (id, body, who = OWNER) => call('POST', `games/${id}/edit`, body, who);
const tablesOf = (id) => JSON.parse(lair.sql.exec('SELECT tables FROM games WHERE id = ?', id).one().tables);
const bookingTables = (gameId) => lair.sql.exec("SELECT kind, tables FROM bookings WHERE game_id = ? AND status IN ('held', 'confirmed', 'seated') ORDER BY kind", gameId).toArray().map((r) => [r.kind, JSON.parse(r.tables).join('+')]);
const seriesTables = (seriesId) => JSON.parse(lair.sql.exec('SELECT tables FROM series WHERE id = ?', seriesId).one().tables);

/** Ana's weekly game, Saturdays 6pm to 10pm from 17 October on Table B1 (its sessions to the 60-day horizon) */
async function weekly() {
  const listed = await list({ gm: ANA, start: at('2026-10-17', 18), end: at('2026-10-17', 22), schedule: 'weekly', title: "Ana's campaign" });
  return { sessions: listed.sessions.map((s) => s.id), seriesId: listed.game.seriesId };
}

test('tables for later sessions: "this and every later session" moves each later session and its seats, and the series keeps the new tables', async () => {
  const { sessions, seriesId } = await weekly();
  assert.ok(sessions.length >= 8);
  const [first, second, third] = sessions;
  // Kai has a seat on the third
  ok(await seat(third, KAI, 'Kai'));
  const done = ok(await edit(second, { tables: ['B3'], tablesScope: 'series' }));
  // the second and every later one are on B3 now, with their GM hold and seats; the first (earlier) stays on B1
  assert.deepEqual(tablesOf(first), ['B1']);
  for (const id of sessions.slice(1)) assert.deepEqual(tablesOf(id), ['B3'], id);
  assert.deepEqual(bookingTables(third), [['gm', 'B3'], ['gm-seat', 'B3']]);
  // each kept its own time
  assert.equal(lair.game(third).start, at('2026-10-31', 18));
  assert.deepEqual(done.tables, { scope: 'series', moved: sessions.length - 2, kept: [] });
  // the series keeps B3 for the sessions it adds later
  assert.deepEqual(seriesTables(seriesId), ['B3']);
  Date.now = () => NOW + 14 * 24 * HOUR;
  lair.extendSeries(lair.rulesCache, Date.now());
  const made = lair.sql.exec("SELECT id, tables FROM games WHERE series_id = ? AND status != 'cancelled' ORDER BY starts_at", seriesId).toArray();
  assert.ok(made.length > sessions.length, 'the top-up added sessions');
  assert.deepEqual(made.slice(sessions.length).map((r) => JSON.parse(r.tables)), made.slice(sessions.length).map(() => ['B3']));
});

test('tables for later sessions: a later session whose new table is taken that day keeps its own, and is listed', async () => {
  const { sessions, seriesId } = await weekly();
  const [, second, , fourth] = sessions;
  // B3 is booked on the fourth Saturday (7 November), 5pm to 9pm
  const taken = await call('POST', 'bookings', {
    kind: 'table', tables: ['B3'], start: at('2026-11-07', 17), end: at('2026-11-07', 21), people: 4, name: 'Mia Chen', email: 'mia@example.com', phone: '021 555 0100', pay: 'day',
  }, MIA);
  assert.equal(taken.status, 200, taken.data.error);
  const done = ok(await edit(second, { tables: ['B3'], tablesScope: 'series' }));
  assert.deepEqual(tablesOf(fourth), ['B1']);
  assert.deepEqual(done.tables.kept.map((k) => [k.id, k.when, k.tables.join('+')]), [[fourth, time.label(at('2026-11-07', 18)), 'B1']]);
  assert.match(done.tables.kept[0].reason, /B3/);
  assert.equal(done.tables.moved, sessions.length - 3);
  for (const id of sessions.slice(1).filter((id) => id !== fourth)) assert.deepEqual(tablesOf(id), ['B3'], id);
  // the series still takes B3 from now on
  assert.deepEqual(seriesTables(seriesId), ['B3']);
});

test('tables for later sessions: "just this session" (or no choice, as before) moves this one only', async () => {
  const { sessions, seriesId } = await weekly();
  const [, second, third] = sessions;
  const one = ok(await edit(second, { tables: ['B3'], tablesScope: 'session' }));
  assert.deepEqual([tablesOf(second), tablesOf(third), seriesTables(seriesId)], [['B3'], ['B1'], ['B1']]);
  assert.deepEqual(one.tables, { scope: 'session', moved: 0, kept: [] });
  // an older page sends no choice: this session only, as before
  const old = ok(await edit(third, { tables: ['B2'] }));
  assert.deepEqual([tablesOf(third), tablesOf(sessions[3]), seriesTables(seriesId)], [['B2'], ['B1'], ['B1']]);
  assert.equal(old.tables.scope, 'session');
  // a choice that isn't one of the two
  assert.equal(said(await edit(third, { tables: ['B2'], tablesScope: 'all' })), `422 ${W.scope}`);
  // details alone (no tables) say nothing about tables
  assert.equal(ok(await edit(third, { title: 'Ana’s big campaign' })).tables, undefined);
});

test('tables for later sessions: a session already on the tables can give them to every later one; one-offs and the time are untouched', async () => {
  const { sessions, seriesId } = await weekly();
  const [, second, third] = sessions;
  // moved for one week only first, then "these tables from now on" without changing them here
  ok(await edit(second, { tables: ['B2'], tablesScope: 'session' }));
  const done = ok(await edit(second, { tables: ['B2'], tablesScope: 'series' }));
  assert.deepEqual([tablesOf(second), tablesOf(third), seriesTables(seriesId)], [['B2'], ['B2'], ['B2']]);
  assert.equal(done.tables.moved, sessions.length - 2);
  // a new time for this session, with the tables for later ones: later sessions keep their own times
  ok(await edit(third, { start: at('2026-10-31', 17), end: at('2026-10-31', 21), tables: ['B4'], tablesScope: 'series' }));
  assert.deepEqual([lair.game(third).start, lair.game(sessions[3]).start], [at('2026-10-31', 17), at('2026-11-07', 18)]);
  assert.deepEqual([tablesOf(sessions[3]), seriesTables(seriesId)], [['B4'], ['B4']]);
  // a one-off session has no later sessions: the choice changes nothing else
  const solo = (await list({ gm: ANA, start: at('2026-10-20', 18), end: at('2026-10-20', 22), title: 'One night only' })).game.id;
  const once = ok(await edit(solo, { tables: ['B2'], tablesScope: 'series' }));
  assert.deepEqual([tablesOf(solo), once.tables], [['B2'], undefined]);
});

test('tables for later sessions: staff with GM games only, as any edit', async () => {
  const { sessions } = await weekly();
  assert.equal(said(await edit(sessions[1], { tables: ['B3'], tablesScope: 'series' }, RANGI)), '403 Staff only. Log in with your staff account.');
  assert.equal(said(await edit(sessions[1], { tables: ['B3'], tablesScope: 'series' }, HEMI)), `403 ${NOT_PERMITTED}`);
  ok(await edit(sessions[1], { tables: ['B3'], tablesScope: 'series' }, ANA));
  assert.deepEqual(tablesOf(sessions[2]), ['B3']);
});

/* ---------------- after the review (27 Oct 2026): each finding, fixed ---------------- */

test('tables for later sessions, review: a later session at the time this session moves to keeps its tables (no double booking)', async () => {
  const { sessions } = await weekly();
  const [, second, third] = sessions;
  // the second moves to the third's day and time, on B3, for every later session: the third can't share B3 with it
  const done = ok(await edit(second, { start: at('2026-10-31', 18), end: at('2026-10-31', 22), tables: ['B3'], tablesScope: 'series' }));
  assert.deepEqual([tablesOf(second), tablesOf(third), tablesOf(sessions[3])], [['B3'], ['B1'], ['B3']]);
  assert.deepEqual(done.tables.kept.map((k) => [k.id, k.reason]), [[third, W.clash]]);
  const onB3 = lair.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE tables LIKE '%B3%' AND kind = 'gm' AND status IN ('held', 'confirmed', 'seated') AND starts_at < ? AND ends_at > ?", at('2026-10-31', 22), at('2026-10-31', 18)).one().n;
  assert.equal(onB3, 1);
});

test('tables for later sessions, review: a GM\'s own weekly game moved by staff to a shop table keeps getting its sessions', async () => {
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: 'B4' }, ROOMS, []);
  const listed = ok(await call('POST', 'games', {
    title: "Rangi's campaign", system: 'D&D 5e', gm: 'Rangi', blurb: 'A long campaign.', seats: 4, tables: ['B1'], start: at('2026-10-24', 18), end: at('2026-10-24', 22), schedule: 'weekly',
  }, RANGI));
  ok(await call('POST', `games/${listed.game.id}/update`, { status: 'open' }, OWNER));
  const ids = listed.sessions.map((s) => s.id);
  const seriesId = listed.game.seriesId;
  ok(await edit(ids[1], { tables: ['B4'], tablesScope: 'series' }));
  assert.deepEqual([tablesOf(ids[1]), tablesOf(ids[ids.length - 1]), seriesTables(seriesId)], [['B4'], ['B4'], ['B4']]);
  // two weeks on, the series adds its next sessions on B4 (staff picked it), not skipping them as a shop table
  Date.now = () => NOW + 14 * 24 * HOUR;
  const report = lair.extendSeries(lair.rulesCache, Date.now());
  const mine = report.find((r) => r.series === seriesId);
  assert.ok(mine && mine.created > 0 && mine.skipped === 0, JSON.stringify(report));
  const newest = lair.sql.exec("SELECT tables FROM games WHERE series_id = ? AND status != 'cancelled' ORDER BY starts_at DESC LIMIT 1", seriesId).one();
  assert.deepEqual(JSON.parse(newest.tables), ['B4']);
});

test('tables for later sessions, review: a game loaded at 6:30pm can change tables (its time isn\'t changing)', async () => {
  // (the owner's games.add job, as the Worker's cron runs it)
  const added = await lair.adminJob({ kind: 'games.add', payload: { games: [{
    title: 'Half Past', system: 'D&D 5e', gm: 'Ari', blurb: "Ari's weekly game.", seats: 4, offlinePlayers: 0, gmFee: 500, schedule: 'weekly',
    start: at('2026-10-21', 18, 30), end: at('2026-10-21', 22, 30), tables: ['B1'], level: 'some', age: '13+',
  }] } });
  assert.deepEqual(added.failed, []);
  const seriesId = added.added[0].seriesId;
  const ids = lair.sql.exec("SELECT id FROM games WHERE series_id = ? ORDER BY starts_at", seriesId).toArray().map((r) => r.id);
  ok(await edit(ids[0], { tables: ['B2'], tablesScope: 'series' }));
  assert.deepEqual([tablesOf(ids[0]), tablesOf(ids[1]), lair.game(ids[1]).start], [['B2'], ['B2'], at('2026-10-28', 18, 30)]);
  // a new time between the hours is still refused, as before
  assert.match(said(await edit(ids[0], { start: at('2026-10-21', 19, 15), end: at('2026-10-21', 23, 15), tables: ['B2'] })), /^422 /);
});

test('tables for later sessions, review: a seat put back sits where its session is now', async () => {
  const { sessions } = await weekly();
  const [, second, third] = sessions;
  const kais = ok(await seat(third, KAI, 'Kai')).booking;
  ok(await call('POST', `bookings/${kais.id}/update`, { status: 'cancelled' }, KAI));
  ok(await edit(second, { tables: ['B3'], tablesScope: 'series' }));
  // staff put Kai back: his seat is on B3 with the session, not holding B1
  ok(await call('POST', `bookings/${kais.id}/update`, { status: 'confirmed' }, OWNER));
  const back = lair.booking(kais.id);
  assert.deepEqual([back.status, back.tables], ['confirmed', ['B3']]);
  const b1 = await call('POST', 'bookings', {
    kind: 'table', tables: ['B1'], start: at('2026-10-31', 18), end: at('2026-10-31', 20), people: 2, name: 'Ria Moana', email: 'ria@example.com', phone: '021 555 0100', pay: 'day',
  }, RIA);
  assert.equal(b1.status, 200, b1.data.error);
});

test('tables for later sessions, review: staff see the tables a weekly game keeps (series.tables); nobody else does', async () => {
  const { sessions, seriesId } = await weekly();
  const staffView = async () => (await board(OWNER)).games.find((g) => g.id === sessions[1]).series;
  assert.deepEqual((await staffView()).tables, ['B1']);
  ok(await edit(sessions[1], { tables: ['B3'], tablesScope: 'series' }));
  assert.deepEqual((await staffView()).tables, ['B3']);
  const publicSeries = (await board('')).games.find((g) => g.seriesId === seriesId).series;
  assert.equal('tables' in publicSeries, false);
});

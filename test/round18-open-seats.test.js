// Open seats (16 Oct 2026, contract v18-open-seats). Mo: "Can you help remove all the players from the games and have
// them be bookable so that players are able to join I am launching soon and will want players to all sign up on the
// website for their respective games and join the sessions and give me the ability to kick players out of the session
// after they join in case someone who is not supposed to be there is. So my staff can handle it". The owner's job
// games.openSeats takes the players each group already had (offlinePlayers) off every session that hasn't started and
// every series; Remove takes a weekly regular off every session (scope 'series'). Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { GM_SESSION_WORDS as W } from '../src/gm-sessions.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Friday 16 October 2026, 1:00pm in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 9, 16, 0, 0);
const realNow = Date.now;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);

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
// The main account; helpers Ana (GM games) and Tama (Library only), who runs sessions; players
const OWNER = '9001';
const ANA = '9101';
const TAMA = '9103';
const RANGI = '5001';
const MIA = '6001';
const KAI = '6002';
const RIA = '6003';
const NAMES = { [OWNER]: 'Mo', [ANA]: 'Ana', [TAMA]: 'Tama', [RANGI]: 'Rangi' };

let lair;
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
const job = (kind, payload = {}) => call('POST', 'internal/admin-job', { id: 'job1', kind, payload }, '', { 'X-Lair-Internal': '1' });
const board = async (who = '') => ok(await call('GET', `floor?from=${at('2026-10-16', 0)}&to=${at('2026-12-31', 0)}`, null, who));
const gameOn = async (id, who = '') => (await board(who)).games.find((g) => g.id === id);
const removeSeat = (id, ref, body, who) => call('POST', `games/${id}/players/${encodeURIComponent(ref)}/remove`, body, who);
const seat = (gameId, who, name, people = 1) => call('POST', 'bookings', {
  kind: 'gm-seat', gameId, people, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100', pay: 'day',
}, who);
const joinSeries = (gameId, who, name) => call('POST', `games/${gameId}/join-series`, { people: 1, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100' }, who);
const offline = (where, id) => lair.sql.exec(`SELECT id, starts_at, offline_players AS n FROM games WHERE ${where} = ? ORDER BY starts_at`, id).toArray();
const seriesOffline = (id) => JSON.parse(lair.sql.exec('SELECT details FROM series WHERE id = ?', id).one().details).offlinePlayers;

/** A game loaded from Mo's GM list (round 11's games.add): the players its group already has, never booked here */
const loaded = (over = {}) => ({
  title: 'Fanova', system: 'Pathfinder 2E', gm: 'Caleb', blurb: "Caleb's weekly Pathfinder 2E campaign.", seats: 7, offlinePlayers: 5,
  gmFee: 500, schedule: 'weekly', start: at('2026-10-17', 10), end: at('2026-10-17', 14), tables: ['T2', 'T3'], level: 'some', age: '13+',
  ...over,
});

/** A session listed by the main account for a GM (Tama unless said), weekly unless said, Saturdays 6pm to 10pm */
async function list({ gm = TAMA, start = at('2026-10-17', 18), end = at('2026-10-17', 22), seats = 4, schedule = 'weekly', tables = ['B1'] } = {}) {
  const name = NAMES[gm];
  return ok(await call('POST', 'games', {
    title: `${name}'s campaign`, system: 'D&D 5e', gm: name, blurb: 'A test campaign.', seats, tables, start, end, schedule,
    gmCustomerId: gm, gmCustomerName: name, gmEmail: `${name.toLowerCase()}@example.com`,
  }, OWNER));
}

const realFetch = globalThis.fetch;
let reached = [];

beforeEach(async () => {
  reached = [];
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  Object.defineProperty(lair.shopify, 'configured', { get: () => false, configurable: true });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  for (const [id, name, perms] of [[ANA, 'Ana Ngata', ['sessions']], [TAMA, 'Tama Rewi', ['library']]]) {
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

/* ---------------- games.openSeats ---------------- */

test('open seats: a dry run lists the groups\' players, and who\'s booked through the Lair, and changes nothing', async () => {
  const added = ok(await job('games.add', { games: [
    loaded(),
    loaded({ title: 'Reclaimer', system: 'Daggerheart', seats: 6, offlinePlayers: 6, start: at('2026-10-17', 18), end: at('2026-10-17', 22), tables: ['T4', 'T5'] }),
    loaded({ title: 'PF Society Organized Play', seats: 6, offlinePlayers: 3, schedule: 'one-shot', start: at('2026-10-18', 14), end: at('2026-10-18', 18), tables: ['T6', 'T7'] }),
    loaded({ title: 'Boots on the Ground', gm: 'Mo', seats: 6, offlinePlayers: 0, start: at('2026-10-17', 14), end: at('2026-10-17', 18), tables: ['T8', 'T9'] }),
  ] }));
  assert.deepEqual(added.failed, []);
  const [fanova, reclaimer, pfs] = added.added;
  // Kai books Fanova's first session online, and Ria's a Fanova regular; Reclaimer's six seats are all its group's
  const kais = ok(await seat(fanova.id, KAI, 'Kai')).booking;
  ok(await joinSeries(fanova.id, RIA, 'Ria'));
  assert.equal((await gameOn(fanova.id)).taken, 7, 'five in the group, Kai and Ria');
  assert.equal((await gameOn(reclaimer.id)).status, 'full');
  const before = lair.sql.exec('SELECT id, offline_players, updated_at FROM games ORDER BY id').toArray();
  const dry = ok(await job('games.openSeats', { dryRun: true }));
  assert.equal(dry.dryRun, true);
  assert.deepEqual(lair.sql.exec('SELECT id, offline_players, updated_at FROM games ORDER BY id').toArray(), before, 'nothing changed');
  assert.equal(seriesOffline(fanova.seriesId), 5);
  // one line a game, soonest first: Fanova (Sat 10am), Reclaimer (Sat 6pm), PF Society (Sun 2pm); Boots has nobody
  assert.deepEqual(dry.games.map((g) => [g.id, g.title, g.gm, g.offlinePlayers, g.sessions]), [
    [fanova.seriesId, 'Fanova', 'Caleb', 5, fanova.sessions],
    [reclaimer.seriesId, 'Reclaimer', 'Caleb', 6, reclaimer.sessions],
    [pfs.id, 'PF Society Organized Play', 'Caleb', 3, 1],
  ]);
  assert.equal(dry.games[0].next, at('2026-10-17', 10));
  assert.equal(dry.games[0].when, time.label(at('2026-10-17', 10)));
  assert.deepEqual([dry.sessions, dry.series, dry.players], [fanova.sessions + reclaimer.sessions + 1, 2, 14]);
  // who's booked through the Lair: names, never an email or phone
  assert.deepEqual(dry.booked.map((b) => [b.ref, b.title, b.name, b.people, b.regular, b.account, b.paid]), [
    [kais.ref, 'Fanova', 'Kai', 1, false, true, false],
    [dry.booked[1].ref, 'Fanova', 'Ria', 1, true, true, false],
  ]);
  assert.deepEqual(dry.regulars, [{ title: 'Fanova', name: 'Ria', people: 1 }]);
  assert.deepEqual(dry.invites, []);
  assert.ok(!JSON.stringify(dry).includes('@'), 'no email in the answer');
  // a dry run written as text is still a dry run
  ok(await job('games.openSeats', { dryRun: 'true' }));
  assert.equal(seriesOffline(fanova.seriesId), 5);
});

test('open seats: the groups\' players come off every session that hasn\'t started, and every series, so the seats can be booked', async () => {
  const added = ok(await job('games.add', { games: [
    loaded(),
    loaded({ title: 'Reclaimer', system: 'Daggerheart', seats: 6, offlinePlayers: 6, start: at('2026-10-17', 18), end: at('2026-10-17', 22), tables: ['T4', 'T5'] }),
    loaded({ title: 'PF Society Organized Play', seats: 6, offlinePlayers: 3, schedule: 'one-shot', start: at('2026-10-18', 14), end: at('2026-10-18', 18), tables: ['T6', 'T7'] }),
  ] }));
  const [fanova, reclaimer, pfs] = added.added;
  const kais = ok(await seat(fanova.id, KAI, 'Kai')).booking;
  // Saturday 11am: Fanova's first session is under way, so it keeps its group's count (nobody books into it now)
  Date.now = () => at('2026-10-17', 11);
  const done = ok(await job('games.openSeats'));
  assert.equal(done.dryRun, false);
  assert.deepEqual(done.games.map((g) => [g.title, g.offlinePlayers, g.sessions]), [
    ['Reclaimer', 6, reclaimer.sessions], ['PF Society Organized Play', 3, 1], ['Fanova', 5, fanova.sessions - 1],
  ]);
  const fanovas = offline('series_id', fanova.seriesId);
  assert.deepEqual(fanovas.map((r) => r.n), [5, ...Array(fanovas.length - 1).fill(0)]);
  assert.ok(offline('series_id', reclaimer.seriesId).every((r) => r.n === 0));
  assert.equal(offline('id', pfs.id)[0].n, 0);
  assert.deepEqual([seriesOffline(fanova.seriesId), seriesOffline(reclaimer.seriesId)], [0, 0], 'sessions made later have none');
  // what's booked through the Lair stays: Kai's seat, in the session under way
  assert.equal(lair.booking(kais.id).status, 'confirmed');
  // the board: Reclaimer's open with all six seats free; PF Society too
  const rec = await gameOn(reclaimer.id);
  assert.deepEqual([rec.taken, rec.status], [0, 'open']);
  assert.deepEqual([(await gameOn(pfs.id)).taken, (await gameOn(pfs.id)).status], [0, 'open']);
  // anyone can book them now: Mia takes three of Reclaimer's seats online
  assert.equal(ok(await seat(reclaimer.id, MIA, 'Mia', 3)).booking.status, 'confirmed');
  assert.equal((await gameOn(reclaimer.id)).taken, 3);
  // and a later top-up makes Fanova's new sessions with nobody in them
  Date.now = () => at('2026-11-30', 9);
  lair.extendSeries(lair.rulesCache, Date.now());
  const later = offline('series_id', fanova.seriesId).filter((r) => r.starts_at > at('2026-11-30', 0));
  assert.ok(later.length > 0, 'the top-up made sessions');
  assert.ok(later.every((r) => r.n === 0), JSON.stringify(later));
  // run again, there's nothing left to open
  const again = ok(await job('games.openSeats', { dryRun: true }));
  assert.deepEqual([again.games, again.sessions, again.series, again.players], [[], 0, 0, 0]);
});

test('open seats: invites to keep a seat every week are listed, by name only', async () => {
  const added = ok(await job('games.add', { games: [loaded({ offlinePlayers: 2 })] }));
  const [fanova] = added.added;
  ok(await call('POST', `games/${fanova.id}/players`, { name: 'Lee Brown', email: 'lee@example.com', weekly: true, people: 1 }, OWNER));
  const dry = ok(await job('games.openSeats', { dryRun: true }));
  assert.deepEqual(dry.invites, [{ title: 'Fanova', name: 'Lee Brown' }]);
  assert.deepEqual(dry.booked.map((b) => [b.name, b.account, b.regular]), [['Lee Brown', false, false]]);
  assert.ok(!JSON.stringify(dry).includes('@'), 'no email in the answer');
});

/* ---------------- taking a regular off every session ---------------- */

test('remove: every session takes a regular off for good (no seat saved again, later seats freed); just this session skips one', async () => {
  const listed = await list();
  const [s1, s2, s3] = listed.sessions;
  const { seriesId } = listed.game;
  ok(await joinSeries(s1.id, KAI, 'Kai'));
  ok(await joinSeries(s1.id, RIA, 'Ria'));
  const kaiSeat = lair.gameBookings(s1.id).find((b) => b.customerId === KAI);
  const riaSeat = lair.gameBookings(s1.id).find((b) => b.customerId === RIA);
  // Ria booked the session after next herself too, and paid for it at the counter ahead of time
  const riaLater = ok(await seat(s3.id, RIA, 'Ria')).booking;
  ok(await call('POST', `bookings/${riaLater.id}/update`, { paid: true }, OWNER));
  // a scope that isn't one
  assert.equal(said(await removeSeat(s1.id, kaiSeat.ref, { scope: 'forever' }, OWNER)), `422 ${W.scope}`);
  assert.equal(lair.booking(kaiSeat.id).status, 'confirmed');
  // Kai, just this session: he's still a regular, so once it's over he's seated at the next one
  const skip = ok(await removeSeat(s1.id, kaiSeat.ref, { scope: 'session' }, OWNER));
  assert.deepEqual([skip.booking.status, skip.regular], ['cancelled', null]);
  assert.equal(lair.seriesMember(seriesId, KAI).status, 'active');
  // Ria, every session: her seat here goes, she's not a regular any more, and her seat the week after next is freed (a
  // refund due: she'd paid ahead)
  const gone = ok(await removeSeat(s1.id, riaSeat.ref, { scope: 'series' }, OWNER));
  assert.deepEqual([gone.booking.status, gone.regular], ['cancelled', { stopped: true, freed: 0 }]);
  assert.equal(lair.seriesMember(seriesId, RIA).status, 'left');
  assert.equal(lair.booking(riaLater.id).status, 'confirmed', 'a one-off seat she booked herself is hers to keep');
  // after the first session, maintenance seats Kai at the next one, and never Ria
  Date.now = () => at('2026-10-18', 10);
  lair.rollSeries(lair.rulesCache, Date.now());
  const seated = (id) => lair.gameBookings(id).filter((b) => b.kind === 'gm-seat' && b.status === 'confirmed').map((b) => b.customerId).sort();
  assert.deepEqual(seated(s2.id), [KAI]);
  // the board holds no seat for her either
  assert.equal((await gameOn(s2.id)).held, 0);
});

test('remove: every session frees a regular\'s seats still to come, a paid-ahead one as a refund due; a seat that isn\'t a regular\'s is just taken off', async () => {
  const listed = await list();
  const [s1, s2] = listed.sessions;
  const { seriesId } = listed.game;
  ok(await joinSeries(s1.id, KAI, 'Kai'));
  // after the first session Kai's seated at the second, and pays for it ahead at the counter
  Date.now = () => at('2026-10-18', 10);
  lair.rollSeries(lair.rulesCache, Date.now());
  const next = lair.gameBookings(s2.id).find((b) => b.customerId === KAI && b.status === 'confirmed');
  ok(await call('POST', `bookings/${next.id}/update`, { paid: true }, OWNER));
  const mias = ok(await seat(s2.id, MIA, 'Mia')).booking;
  // Mia's seat isn't a regular's: every session just takes it off
  const mia = ok(await removeSeat(s2.id, mias.ref, { scope: 'series' }, ANA));
  assert.deepEqual([mia.booking.status, mia.regular], ['cancelled', null]);
  // Kai's: taken off this one (paid ahead, so a refund due) and stopped
  const kai = ok(await removeSeat(s2.id, next.ref, { scope: 'series' }, ANA));
  assert.deepEqual([kai.booking.status, kai.refund.due, kai.refund.amount, kai.regular.stopped], ['cancelled', true, 1500, true]);
  assert.equal(lair.seriesMember(seriesId, KAI).status, 'left');
  assert.equal(lair.booking(next.id).refund, 'due');
});

test('remove: a staff GM takes a regular off every session of a series they run; not of one that\'s someone else\'s now; nobody else', async () => {
  const listed = await list({ gm: TAMA });
  const [s1, s2] = listed.sessions;
  const { seriesId } = listed.game;
  ok(await joinSeries(s1.id, KAI, 'Kai'));
  ok(await joinSeries(s1.id, RIA, 'Ria'));
  const kaiSeat = lair.gameBookings(s1.id).find((b) => b.customerId === KAI);
  const riaSeat = lair.gameBookings(s1.id).find((b) => b.customerId === RIA);
  // Rangi isn't staff; logged out, log in
  assert.equal(said(await removeSeat(s1.id, kaiSeat.ref, { scope: 'series' }, RANGI)), `403 ${W.notYours}`);
  assert.equal(said(await removeSeat(s1.id, kaiSeat.ref, { scope: 'series' }, '')), `401 ${W.login}`);
  // Tama runs the series (Library only, but it's his game): every session
  assert.equal(ok(await removeSeat(s1.id, kaiSeat.ref, { scope: 'series' }, TAMA)).regular.stopped, true);
  assert.equal(lair.seriesMember(seriesId, KAI).status, 'left');
  // Staff give the series from the second session on to Rangi: Tama still runs the first session, but not the series
  ok(await call('POST', `games/${s2.id}/gm`, { gmCustomerId: RANGI, gmCustomerName: 'Rangi Hohaia', gm: 'Rangi', scope: 'series' }, OWNER));
  assert.equal(said(await removeSeat(s1.id, riaSeat.ref, { scope: 'series' }, TAMA)), `403 ${W.stopNotYours}`);
  assert.deepEqual([lair.booking(riaSeat.id).status, lair.seriesMember(seriesId, RIA).status], ['confirmed', 'active'], 'nothing changed');
  // just this session is still his to do
  assert.equal(ok(await removeSeat(s1.id, riaSeat.ref, { scope: 'session' }, TAMA)).booking.status, 'cancelled');
  assert.equal(lair.seriesMember(seriesId, RIA).status, 'active');
});

test('remove: a regular who left already is just taken off; staff stopping a regular still frees every seat to come', async () => {
  const listed = await list();
  const [s1] = listed.sessions;
  const { seriesId } = listed.game;
  ok(await joinSeries(s1.id, KAI, 'Kai'));
  ok(await joinSeries(s1.id, RIA, 'Ria'));
  const kaiSeat = lair.gameBookings(s1.id).find((b) => b.customerId === KAI);
  // Kai leaves himself less than 24 hours before: his seat stays on his tab
  Date.now = () => at('2026-10-17', 9);
  const left = ok(await call('POST', `series/${seriesId}/leave`, {}, KAI));
  assert.equal(left.kept.length, 1);
  assert.equal(lair.booking(kaiSeat.id).status, 'confirmed');
  // every session: he isn't a regular any more, so it's just his seat (nothing to stop)
  const res = ok(await removeSeat(s1.id, kaiSeat.ref, { scope: 'series' }, OWNER));
  assert.deepEqual([res.booking.status, res.regular], ['cancelled', null]);
  // staff stopping Ria (POST /series/:id/leave, as before) free her seat even inside the 24 hours
  const riaSeat = lair.gameBookings(s1.id).find((b) => b.customerId === RIA);
  const stop = ok(await call('POST', `series/${seriesId}/leave`, { customerId: RIA }, OWNER));
  assert.deepEqual([stop.cancelled, stop.kept], [1, []]);
  assert.equal(lair.booking(riaSeat.id).status, 'cancelled');
});

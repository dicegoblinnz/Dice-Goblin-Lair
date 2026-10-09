// Round 11: Mo's new events and GM games (9 Oct 2026). "remove all the gm games and all of the events … Can you help
// create all the events and GM games and have images for all of them". This covers the Lair app's part the
// coordinator built: events that run two days in a row (Oddity Alley: Saturday and Sunday), the owner's jobs that
// clear and load GM games (src/admin.js, run by the cron from the config database), players already in a game's group
// counted as seats taken, a loaded game's picture by its Shopify Files address, and starts between the hours.
// Run with: node --test test/   (under TZ=UTC and TZ=Pacific/Auckland)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair, MIGRATIONS } from '../src/lair.js';
import { LairTime, eventDays, eventOccurrences, findOccurrence, rulesFromSettings } from '../src/core.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Friday 9 October 2026, 8:00pm in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 9, 9, 7, 0);
const realNow = Date.now;

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
  { id: 'main-room', name: 'Main room', code: 'T', tables: 21, seats: 4, order: 1 },
  { id: 'gaming-room', name: 'Gaming room', code: 'G', tables: 4, seats: 4, order: 3 },
];
const HOURS = 'Mon 16:00-24:00\nTue 16:00-24:00\nWed 16:00-24:00\nThu 16:00-24:00\nFri 16:00-24:00\nSat 10:00-24:00\nSun 10:00-22:00';
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Warhammer locks T8-T21 on Thursdays; Oddity Alley (two days, third weekend) locks T1-T21 10am to 4pm
const EVENTS = [
  { id: 'warhammer-night', title: 'Warhammer night', start: at('2026-10-15', 18), end: at('2026-10-16', 0), repeat: 'weekly', tables: 'T8-T21', lockTables: true },
  { id: 'oddity-alley', title: 'Oddity Alley', start: at('2026-10-17', 10), end: at('2026-10-17', 16), repeat: 'monthly', tables: 'T1-T21', lockTables: true, days: 2 },
  // sign-ups (events.reset): a Wednesday quiz with places
  { id: 'quiz-night', title: 'Quiz night', start: at('2026-10-14', 18), end: at('2026-10-14', 21), repeat: 'weekly', capacity: 20 },
];
const PICTURE = 'https://cdn.shopify.com/s/files/1/0638/6253/8343/files/game-01-fanova.jpg?v=1';

let lair;
async function call(method, path, body, customer = '', headers = {}) {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...headers }, body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: response.status, data: await response.json() };
}
const job = (kind, payload = {}) => call('POST', 'internal/admin-job', { id: 'job1', kind, payload }, '', { 'X-Lair-Internal': '1' });
const floor = async () => (await call('GET', `floor?from=${NOW - DAY}&to=${NOW + 70 * DAY}`)).data;
const spec = (over = {}) => ({
  title: 'Fanova', system: 'Pathfinder 2E', gm: 'Caleb', blurb: "Caleb's weekly Pathfinder 2E campaign.", seats: 6, offlinePlayers: 5,
  gmFee: 500, schedule: 'weekly', start: at('2026-10-10', 10), end: at('2026-10-10', 14), tables: ['G1', 'G2'], imageUrl: PICTURE, level: 'some', age: '13+',
  ...over,
});

beforeEach(() => {
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'example-shop.myshopify.com', PUBLIC_URL: 'https://lair.test' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: id === 'gm', tags: [] });
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.rulesCache = rulesFromSettings({ lair_hours: HOURS, lair_shop_tables: 'T1-T3' }, ROOMS, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
});
afterEach(() => {
  Date.now = realNow;
});

test('round 11: one migration entry adds the players already in a game, found by what it does', () => {
  const mine = MIGRATIONS.filter((m) => m.some((s) => /ADD COLUMN offline_players\b/.test(s)));
  assert.equal(mine.length, 1);
  const cols = lair.sql.exec("SELECT name FROM pragma_table_info('games')").toArray().map((c) => c.name);
  assert.ok(cols.includes('offline_players'));
});

test('round 11: an event that runs two days gives each day its own date, with the same hours and tables', () => {
  assert.equal(eventDays(2), 2);
  assert.equal(eventDays('2'), 2);
  assert.equal(eventDays(''), 1);
  assert.equal(eventDays(0), 1);
  assert.equal(eventDays(9), 1);
  const rules = lair.rulesCache;
  // the third weekend of November: Saturday 21 and Sunday 22 (Oddity Alley's first date is 17 Oct, a third Saturday)
  const nov = eventOccurrences(rules, at('2026-11-20', 0), at('2026-11-24', 0)).filter((o) => o.eventId === 'oddity-alley');
  assert.deepEqual(nov.map((o) => o.id), ['oddity-alley@2026-11-21', 'oddity-alley@2026-11-22']);
  assert.deepEqual(nov.map((o) => [time.minutesOf(o.start), time.minutesOf(o.end)]), [[600, 960], [600, 960]]);
  // a window that starts on the Sunday still finds the Sunday (its Saturday is before the window)
  const sunOnly = eventOccurrences(rules, at('2026-11-22', 0), at('2026-11-23', 0)).filter((o) => o.eventId === 'oddity-alley');
  assert.deepEqual(sunOnly.map((o) => o.id), ['oddity-alley@2026-11-22']);
  // January 2027: the third Saturday is the 16th, and its Sunday the 17th (the third Sunday that month)
  const jan = eventOccurrences(rules, at('2027-01-01', 0), at('2027-02-01', 0)).filter((o) => o.eventId === 'oddity-alley');
  assert.deepEqual(jan.map((o) => o.id), ['oddity-alley@2027-01-16', 'oddity-alley@2027-01-17']);
  // each day's date is found by its id (sign-ups, maybes and reminders use it)
  assert.equal(findOccurrence(rules, 'oddity-alley@2026-11-22')?.start, at('2026-11-22', 10));
  assert.equal(findOccurrence(rules, 'oddity-alley@2026-11-23'), null);
});

test('round 11: the staff list words a two-day monthly event "Third Saturday and Sunday"', () => {
  const tag = lair.repeatTag({ repeat: 'monthly', start: at('2026-10-17', 10), days: 2 }, lair.rulesCache);
  assert.equal(tag, 'Monthly · Third Saturday and Sunday 10am');
  assert.equal(lair.repeatTag({ repeat: 'monthly', start: at('2026-10-25', 12), days: 1 }, lair.rulesCache), 'Monthly · Fourth Sunday 12pm');
  assert.equal(lair.repeatTag({ repeat: 'weekly', start: at('2026-10-17', 10), days: 2 }, lair.rulesCache), 'Weekly · Saturdays and Sundays 10am');
});

test('round 11: the events editor takes days (1 to 7), storing 1 as empty', () => {
  const rules = lair.rulesCache;
  const base = { title: 'Oddity Alley', type: 'market', start: at('2026-11-21', 10) };
  assert.equal(lair.eventFields({ ...base, days: 2 }, rules).set.days, '2');
  // a new entry leaves 1 out; an existing two-day event going back to one day clears the field
  assert.equal('days' in lair.eventFields({ ...base, days: 1 }, rules).set, false);
  const current = { title: 'Oddity Alley', event_type: 'market', starts_at: '2026-11-21T10:00:00+13:00', days: '2' };
  assert.equal(lair.eventFields({ days: 1 }, rules, current).set.days, '');
  assert.equal(lair.eventFields({ days: '' }, rules, current).set.days, '');
  assert.equal('days' in lair.eventFields({ days: 2 }, rules, current).set, false, 'unchanged, nothing goes to Shopify');
  assert.throws(() => lair.eventFields({ ...base, days: 8 }, rules), /1 to 7 days/);
  assert.equal('days' in lair.eventFields(base, rules).set, false, 'left out, the field is left alone');
});

test('round 11: the internal job route is only for the Worker itself', async () => {
  const res = await call('POST', 'internal/admin-job', { kind: 'games.reset' });
  assert.equal(res.status, 404);
  assert.equal((await job('nope')).status, 422);
});

test("round 11: games.add lists a weekly game for a GM with no account, with its players, picture and sessions", async () => {
  const res = await job('games.add', { games: [spec()] });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.failed, []);
  const [added] = res.data.added;
  assert.equal(added.title, 'Fanova');
  assert.ok(added.seriesId);
  assert.ok(added.sessions >= 8, `weekly sessions to the horizon: ${added.sessions}`);
  const games = (await floor()).games.filter((g) => g.title === 'Fanova');
  // the public board shows the series' next session only
  assert.equal(games.length, 1);
  const g = games[0];
  assert.equal(g.gm, 'Caleb');
  assert.equal(g.status, 'open');
  assert.equal(g.seats, 6);
  assert.equal(g.taken, 5, 'the five players already in the group are seats taken');
  assert.equal(g.image, PICTURE, 'a Shopify Files picture is used as it is');
  assert.equal(g.seatPrice, 1500);
  assert.equal(g.level, 'some');
  assert.equal(g.age, '13+');
  const row = lair.sql.exec("SELECT gm_customer_id, gm_email FROM games WHERE title = 'Fanova' LIMIT 1").one();
  assert.equal(row.gm_customer_id, null);
  assert.equal(row.gm_email, null);
  // only the one open seat can be booked
  const seat = (people) => call('POST', 'bookings', { kind: 'gm-seat', gameId: g.id, people, name: 'Jo Example', email: 'jo@example.com', phone: '021 555 0100' });
  assert.equal((await seat(2)).status, 409);
  const one = await seat(1);
  assert.equal(one.status, 200, JSON.stringify(one.data));
  const after = (await floor()).games.find((x) => x.id === g.id);
  assert.equal(after.taken, 6);
  assert.equal(after.status, 'full');
});

test('round 11: games.add takes a start between the hours, and plans its later sessions the same way', async () => {
  const res = await job('games.add', {
    games: [spec({ title: 'Rise of Dragon', system: 'D&D 5e', gm: 'Hayden', seats: 7, offlinePlayers: 7, start: at('2026-10-11', 13, 30), end: at('2026-10-11', 17, 30), tables: ['T4', 'T5'], imageUrl: null })],
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.failed, []);
  const [added] = res.data.added;
  const starts = lair.sql.exec('SELECT starts_at FROM games WHERE series_id = ? ORDER BY starts_at', added.seriesId).toArray().map((r) => r.starts_at);
  assert.ok(starts.length >= 6);
  assert.ok(starts.every((s) => time.minutesOf(s) === 13 * 60 + 30), 'every session at 1:30pm');
  // Oddity Alley locks T1-T21 10am to 4pm on its Sunday (18 Oct is the Sunday after the third Saturday): skipped
  assert.ok(added.skipped.some((x) => time.key(x.start) === '2026-10-18'), JSON.stringify(added.skipped));
  assert.ok(!starts.some((s) => time.key(s) === '2026-10-18'));
});

test('round 11: games.add reports a game that can\'t go on and carries on with the rest', async () => {
  const res = await job('games.add', {
    games: [
      // T8 is locked by Warhammer on Thursdays from 6pm
      spec({ title: 'Grimskald', system: 'D&D 5e', gm: 'Kane', schedule: 'weekly', start: at('2026-10-15', 18), end: at('2026-10-15', 22), tables: ['T8', 'T9'], imageUrl: null }),
      spec({ title: 'Bad picture', imageUrl: 'https://example.com/x.jpg' }),
      spec({ title: 'The Legacy of Power', system: 'Mutants & Masterminds', gm: 'Hayden', seats: 7, offlinePlayers: 7, start: at('2026-10-15', 18), end: at('2026-10-15', 22), tables: ['T4', 'T5'], imageUrl: null }),
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.failed.map((f) => f.title), ['Grimskald', 'Bad picture']);
  assert.match(res.data.failed[0].error, /T8 is already taken/);
  assert.match(res.data.failed[1].error, /Shopify Files/);
  assert.deepEqual(res.data.added.map((a) => a.title), ['The Legacy of Power']);
  const legacy = (await floor()).games.find((g) => g.title === 'The Legacy of Power');
  assert.equal(legacy.status, 'full', 'seven of seven already in the group');
});

test('round 11: games.reset takes every game, series and seat off the board, silently', async () => {
  await job('games.add', { games: [spec(), spec({ title: 'One Shots', gm: 'Keaton', system: 'Various', schedule: 'fortnightly', start: at('2026-10-11', 10), end: at('2026-10-11', 14), tables: ['G3', 'G4'], offlinePlayers: 5 })] });
  const g = (await floor()).games.find((x) => x.title === 'Fanova');
  const seat = await call('POST', 'bookings', { kind: 'gm-seat', gameId: g.id, people: 1, name: 'Jo Example', email: 'jo@example.com', phone: '021 555 0100' });
  assert.equal(seat.status, 200, JSON.stringify(seat.data));
  const res = await job('games.reset');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(res.data.games >= 10);
  assert.equal(res.data.series, 2);
  const board = await floor();
  assert.deepEqual(board.games, []);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE kind IN ('gm', 'gm-seat') AND status != 'cancelled'").one().n, 0);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM series WHERE status != 'cancelled'").one().n, 0);
  // the daily top-up doesn't bring them back
  assert.deepEqual(lair.extendSeries(lair.rulesCache, NOW + DAY), []);
});

test('round 11: events.reset takes the sign-ups and interest for dates to come off, silently; a paid one stays and is listed', async () => {
  const join = (date) => call('POST', `events/quiz-night@${date}/join`, { name: 'Sam Example', email: 'sam@example.com', phone: '021 555 0100', people: 2 }, '1001');
  const first = await join('2026-10-14');
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const second = await join('2026-10-21');
  assert.equal(second.status, 200, JSON.stringify(second.data));
  lair.sql.exec('UPDATE event_joins SET paid_amount = 1000 WHERE id = ?', second.data.join.id);
  const maybe = await call('POST', 'interest', { kind: 'event', id: 'warhammer-night@2026-10-15', name: 'Kiri Example', email: 'kiri@example.com', phone: '021 555 0101' });
  assert.equal(maybe.status, 200, JSON.stringify(maybe.data));
  const res = await job('events.reset');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual([res.data.joins, res.data.spots, res.data.interests], [1, 0, 1]);
  assert.deepEqual(res.data.paidLeft.map((p) => [p.kind, p.title]), [['sign-up', 'Quiz night']]);
  const rows = lair.sql.exec('SELECT id, status FROM event_joins ORDER BY starts_at').toArray();
  assert.equal(rows[0].status, 'cancelled');
  assert.notEqual(rows[1].status, 'cancelled', 'the paid one is left for staff');
  assert.equal(lair.sql.exec("SELECT status FROM interests WHERE kind = 'event'").one().status, 'removed');
  // nothing to do the second time
  const again = await job('events.reset');
  assert.deepEqual([again.data.joins, again.data.interests], [0, 0]);
});

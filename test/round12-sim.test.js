// Round 12: what the website simulation found (10 Oct 2026). Mo: "Can you run a simulation and check if there is any bugs
// or issues in the website and help identify and fix any of them. Including any inconsistency or works that apply on the
// backend corrupting the front end." The real events and GM games on a local copy, walked through as a visitor, a member
// and staff, with changes made behind their backs (tools/qa/sim/sim.mjs). The Lair app's part:
//  - the series top-up told staff a weekly game "needs a table" for a session on the horizon's last day that just wasn't
//    bookable yet, and told them again about the same dates on every run (the once-a-day note lived in memory only);
//  - an event date deleted, moved or skipped in Shopify (which the staff page refuses while people are on it, but
//    Shopify's own editor allows) left its sign-ups looking as if nothing had happened, and nobody was told;
//  - staff saw "5 of 6 seats taken" over "No players yet" for a game whose group already has five players.
// Run with: node --test test/   (under TZ=UTC and TZ=Pacific/Auckland)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair, MIGRATIONS } from '../src/lair.js';
import { LairTime, rulesFromSettings } from '../src/core.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const MIN = 60_000;
const DAY = 24 * HOUR;
// Saturday 10 October 2026, 12:10am in Auckland (NZDT, UTC+13): the first maintenance run of the day
const NOW = Date.UTC(2026, 9, 9, 11, 10);
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
// Oddity Alley locks the whole main room 10am to 4pm on the third Saturday and the Sunday after; a Wednesday quiz takes
// sign-ups (20 places), and Blood on the Clocktower (4 places) is a one-off on Sunday 18 October
const ALLEY = { id: 'oddity-alley', title: 'Oddity Alley', start: at('2026-10-17', 10), end: at('2026-10-17', 16), repeat: 'monthly', tables: 'T1-T21', lockTables: true, days: 2 };
const QUIZ = { id: 'quiz-night', title: 'Quiz night', start: at('2026-10-14', 18), end: at('2026-10-14', 21), repeat: 'weekly', capacity: 20 };
const CLOCK = { id: 'clocktower-october', title: 'Blood on the Clocktower', type: 'social', start: at('2026-10-18', 12), end: at('2026-10-18', 18), capacity: 4 };
const EVENTS = [ALLEY, QUIZ, CLOCK];
const useEvents = (events) => {
  lair.rulesCache = rulesFromSettings({ lair_hours: HOURS, lair_shop_tables: 'T1-T3' }, ROOMS, events);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
};

let lair;
async function call(method, path, body, customer = '', headers = {}) {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...headers }, body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: response.status, data: await response.json() };
}
const job = (kind, payload = {}) => call('POST', 'internal/admin-job', { id: 'job1', kind, payload }, '', { 'X-Lair-Internal': '1' });
const spec = (over = {}) => ({
  title: 'Neon Streets', system: 'Cyberpunk RED', gm: 'Ari', blurb: "Ari's weekly Cyberpunk game.", seats: 6, offlinePlayers: 5, gmFee: 500,
  schedule: 'weekly', start: at('2026-10-14', 18), end: at('2026-10-14', 22), tables: ['T4', 'T5'], imageUrl: null, ...over,
});
const sessions = (seriesId) => lair.sql.exec('SELECT starts_at FROM games WHERE series_id = ? ORDER BY starts_at', seriesId).toArray().map((r) => time.key(r.starts_at));
const me = async (who) => (await call('GET', 'me', null, who)).data;

function captureEmails() {
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test' };
  // the maintenance methods called straight (not through fetch) use the env as it is
  lair.env = { ...lair.env, ...lair.baseEnv };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return { sent, restore: () => { globalThis.fetch = realFetch; } };
}
const settle = () => new Promise((r) => setTimeout(r, 10));
const staffMail = (sent, pattern) => sent.filter((m) => m.to === 'staff@dicegoblin.test' && pattern.test(m.subject));

beforeEach(() => {
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'example-shop.myshopify.com', PUBLIC_URL: 'https://lair.test' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: id === 'gm', tags: [] });
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.accountEmail = async () => ({ email: null, fetched: false });
  useEvents(EVENTS);
});
afterEach(() => {
  Date.now = realNow;
});

test('round 12: one migration entry, new tables only: the series dates staff were told about and the event dates that went', () => {
  const mine = MIGRATIONS.filter((m) => m.some((s) => /CREATE TABLE IF NOT EXISTS (series_skips|gone_dates)\b/.test(s)));
  assert.equal(mine.length, 1);
  assert.ok(mine[0].every((s) => /^\s*CREATE TABLE IF NOT EXISTS/.test(s)), 'new tables only');
  // entry 29, where it went live (round 14's Discord tables came after it)
  assert.equal(MIGRATIONS.indexOf(mine[0]), 28, 'after every earlier round, where it went live');
  for (const table of ['series_skips', 'gone_dates']) assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", table).one().n, 1, table);
});

test('round 12: a weekly session on the horizon\'s last day that isn\'t bookable yet isn\'t "skipped": the top-up adds it once it is, and nobody is emailed', async () => {
  const mail = captureEmails();
  try {
    // 12:10am Saturday: the horizon ends at 12:10am on Wednesday 9 December, so that evening's 6pm session isn't bookable yet
    const res = await job('games.add', { games: [spec()] });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const [added] = res.data.added;
    assert.deepEqual(added.skipped, [], 'nothing skipped: the 9 December session just isn\'t due yet');
    assert.equal(sessions(added.seriesId).at(-1), '2026-12-02');
    // The same night's runs (every 10 minutes): nothing to add, nothing to say
    for (const later of [10 * MIN, 20 * MIN, 6 * HOUR]) assert.deepEqual(lair.extendSeries(lair.rulesCache, NOW + later), []);
    // 6:10pm: 9 December 6pm is inside the horizon now, so the next run adds it
    const report = lair.extendSeries(lair.rulesCache, NOW + 18 * HOUR);
    assert.deepEqual(report.map((r) => [r.created, r.skipped]), [[1, 0]]);
    assert.equal(sessions(added.seriesId).at(-1), '2026-12-09');
    await settle();
    assert.deepEqual(staffMail(mail.sent, /needs a table/), []);
  } finally {
    mail.restore();
  }
});

test('round 12: a date a series can\'t have (an event locks its tables) is told to staff once, not on every run; a new one is told on its own', async () => {
  const mail = captureEmails();
  try {
    // Sundays 1:30pm on T6 and T7: Oddity Alley has the whole main room on 18 October and 22 November, 10am to 4pm
    const res = await job('games.add', { games: [spec({ title: 'Rise of the Wyrm', system: 'D&D 5e', gm: 'Bex', start: at('2026-10-11', 13, 30), end: at('2026-10-11', 17, 30), tables: ['T6', 'T7'] })] });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const [added] = res.data.added;
    assert.deepEqual(added.skipped.map((x) => time.key(x.start)), ['2026-10-18', '2026-11-22'], 'the job says which dates it skipped');
    // The first maintenance run tells staff about both, once
    lair.extendSeries(lair.rulesCache, NOW + 10 * MIN);
    await settle();
    let told = staffMail(mail.sent, /^Game series needs a table: Rise of the Wyrm$/);
    assert.equal(told.length, 1);
    assert.match(told[0].text, /Sunday, 18 October/);
    assert.match(told[0].text, /Sunday, 22 November/);
    // Later runs, the same night and the next days (a Lair that's been asleep, too): nothing more about those dates
    for (const later of [20 * MIN, 30 * MIN, DAY, 2 * DAY]) {
      lair.extendSeries(lair.rulesCache, NOW + later);
      const fresh = new Lair(lair.ctx, lair.baseEnv);
      fresh.rulesCache = lair.rulesCache;
      fresh.rulesLoadedAt = lair.rulesLoadedAt;
      fresh.extendSeries(lair.rulesCache, NOW + later + MIN);
    }
    await settle();
    assert.equal(staffMail(mail.sent, /needs a table/).length, 1, 'still the one email');
    // Wednesday 21 October, 2:10pm: 20 December (the Sunday after December's third Saturday) comes inside the horizon:
    // told on its own
    lair.extendSeries(lair.rulesCache, NOW + 11 * DAY + 14 * HOUR);
    await settle();
    told = staffMail(mail.sent, /needs a table/);
    assert.equal(told.length, 2);
    assert.match(told[1].text, /Sunday, 20 December/);
    assert.doesNotMatch(told[1].text, /18 October|22 November/);
    const have = sessions(added.seriesId);
    assert.ok(!have.includes('2026-10-18') && !have.includes('2026-11-22') && !have.includes('2026-12-20'));
    assert.ok(have.includes('2026-12-13'), 'the weeks between are added as usual');
  } finally {
    mail.restore();
  }
});

test('round 12: an event date deleted in Shopify with people on it: staff hear once, My Lair says it\'s gone, and putting it back puts everything back', async () => {
  // Sam signs up for the quiz on 14 October (2 people); Kiri says maybe to the 21st; Blood on the Clocktower (4 places)
  // fills up and Ruby joins its waitlist
  const quiz = await call('POST', 'events/quiz-night@2026-10-14/join', { name: 'Sam Jones', email: 'sam@example.com', phone: '021 555 0100', people: 2 }, '1001');
  assert.equal(quiz.status, 200, JSON.stringify(quiz.data));
  const maybe = await call('POST', 'interest', { kind: 'event', id: 'quiz-night@2026-10-21', name: 'Kiri Smith', email: 'kiri@example.com' }, '1002');
  assert.equal(maybe.status, 200, JSON.stringify(maybe.data));
  const full = await call('POST', 'events/clocktower-october@2026-10-18/join', { name: 'Ana Ngata', email: 'ana@example.com', phone: '021 555 0102', people: 4 });
  assert.equal(full.status, 200, JSON.stringify(full.data));
  const waiting = await call('POST', 'interest', { waitlist: true, kind: 'event', id: 'clocktower-october@2026-10-18', name: 'Ruby Tane', email: 'ruby@example.com', phone: '021 555 0103', people: 2 });
  assert.equal(waiting.status, 200, JSON.stringify(waiting.data));
  // Nothing has gone yet
  assert.deepEqual(lair.goneDates(lair.rulesCache, NOW), []);
  assert.equal((await me('1001')).joins[0].gone, undefined);

  const mail = captureEmails();
  try {
    // The quiz and the October Blood on the Clocktower are deleted in Shopify
    useEvents([ALLEY]);
    const gone = lair.goneDates(lair.rulesCache, NOW + 10 * MIN);
    assert.deepEqual(gone.map((d) => [d.occurrenceId, d.people, d.signUps, d.said, d.waiting]).sort(), [
      ['clocktower-october@2026-10-18', 4, 1, 0, 2],
      ['quiz-night@2026-10-14', 2, 1, 0, 0],
      ['quiz-night@2026-10-21', 0, 0, 1, 0],
    ]);
    await settle();
    const told = staffMail(mail.sent, /^Not on the calendar any more: /);
    assert.deepEqual(told.map((m) => m.subject).sort(), [
      'Not on the calendar any more: Blood on the Clocktower, Sun 18 Oct',
      'Not on the calendar any more: Quiz night, Wed 14 Oct',
      'Not on the calendar any more: Quiz night, Wed 21 Oct',
    ]);
    const clock = told.find((m) => /Clocktower/.test(m.subject)).text;
    for (const words of ["Nothing's been cancelled and nobody's been told", 'put the date back in Shopify', '4 people (1 sign-up)', '2 people on the waitlist', 'Ana Ngata: signed up, 4 people', 'ana@example.com', 'Ruby Tane: on the waitlist, 2 people']) {
      assert.ok(clock.includes(words), words);
    }
    // Every later run: nothing more
    assert.deepEqual(lair.goneDates(lair.rulesCache, NOW + 20 * MIN), []);
    await settle();
    assert.equal(staffMail(mail.sent, /^Not on the calendar any more: /).length, 3);
    // My Lair says so (the sign-up, and the maybe), and nothing's cancelled
    const sam = await me('1001');
    assert.deepEqual([sam.joins[0].occurrenceId, sam.joins[0].status, sam.joins[0].gone], ['quiz-night@2026-10-14', 'confirmed', true]);
    const kiri = await me('1002');
    assert.equal(kiri.interests.find((x) => x.targetId === 'quiz-night@2026-10-21').gone, true);

    // Put back (it was a mistake): as it was, and forgotten, so going again tells staff again
    useEvents(EVENTS);
    assert.deepEqual(lair.goneDates(lair.rulesCache, NOW + 30 * MIN), []);
    assert.equal((await me('1001')).joins[0].gone, undefined);
    assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM gone_dates').one().n, 0);
    useEvents([ALLEY, CLOCK]);
    assert.deepEqual(lair.goneDates(lair.rulesCache, NOW + 40 * MIN).map((d) => d.occurrenceId).sort(), ['quiz-night@2026-10-14', 'quiz-night@2026-10-21']);
    // A Lair that couldn't reach Shopify runs on built-in defaults (no events): that's not every date gone
    lair.sql.exec('DELETE FROM gone_dates');
    lair.rulesSource = 'built-in defaults';
    useEvents([]);
    assert.deepEqual(lair.goneDates(lair.rulesCache, NOW + 50 * MIN), []);
    assert.equal((await me('1001')).joins[0].gone, undefined);
  } finally {
    mail.restore();
  }
});

test('round 12: staff see how many players a game\'s group already has; the public see only seats taken', async () => {
  const res = await job('games.add', { games: [spec({ schedule: 'one-shot' })] });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const range = `floor?from=${NOW}&to=${NOW + 10 * DAY}`;
  const staff = (await call('GET', range, null, 'staff')).data.games.find((g) => g.title === 'Neon Streets');
  assert.deepEqual([staff.taken, staff.offlinePlayers, staff.players], [5, 5, []]);
  const shown = (await call('GET', range)).data.games.find((g) => g.title === 'Neon Streets');
  assert.deepEqual([shown.taken, shown.offlinePlayers], [5, undefined]);
});

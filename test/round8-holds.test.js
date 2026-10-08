// Round 8, holds (contract v8 section 1): staff table holds that repeat weekly or fortnightly, the way TTRPG sessions do
// (Mo, 6 Oct: "make the session or event holding can have the option to hold weekly just like ttrpg sessions").
// A repeating hold is a hold series plus one ordinary blocks row a date. Run with: node --test test/  (under TZ=UTC and
// TZ=Pacific/Auckland: every date here is a Lair date either way)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair, MIGRATIONS } from '../src/lair.js';
import { LairTime, holdSeriesDays, rulesFromSettings } from '../src/core.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Thursday 1 October 2026, 1:00pm in Auckland (NZDT, UTC+13), as in lair.test.js
const NOW = Date.UTC(2026, 9, 1, 0, 0);
// Thursday 10 September 2026, 1:00pm NZST (UTC+12): the clocks go forward on Sunday 27 September
const SPRING = Date.UTC(2026, 8, 10, 1, 0);
// Thursday 25 March 2027, 1:00pm NZDT: the clocks go back on Sunday 4 April
const AUTUMN = Date.UTC(2027, 2, 25, 0, 0);
const realNow = Date.now;

/* ---------------- helpers, as in lair.test.js ---------------- */
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

const FALLBACK = [
  { id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 },
  { id: 'side-room-1', name: 'Side room 1', code: 'A', tables: 4, seats: 4, order: 2 },
  { id: 'side-room-2', name: 'Side room 2', code: 'B', tables: 4, seats: 4, order: 3 },
  { id: 'fancy-room', name: 'Fancy room', code: 'F', tables: 1, seats: 12, price: 15, minPeople: 4, order: 4 },
];
const TEST_HOURS = 'Mon closed\nTue 12:00-22:00\nWed 12:00-22:00\nThu 12:00-22:00\nFri 12:00-23:00\nSat 10:00-23:00\nSun 10:00-20:00';

let lair;
const MOBILE_ROUTES = /^(?:bookings|games\/[^/]+\/join-series|events\/[^/]+\/(?:join|reserve))$/;
async function call(method, path, body, customer = '', extraHeaders = {}) {
  const sent = method === 'POST' && body && MOBILE_ROUTES.test(path) && !('phone' in body) ? { ...body, phone: '021 555 0100' } : body;
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders },
      body: sent ? JSON.stringify(sent) : undefined,
    }),
  );
  return { status: response.status, data: await response.json() };
}
const internal = (path, body) => call('POST', `internal/${path}`, body, '', { 'X-Lair-Internal': '1' });
const maintenance = () => internal('maintenance', { webhookUrl: 'https://lair.test/webhooks/orders-paid' });
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const useRules = (settings = {}) => {
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '', ...settings }, FALLBACK, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
};
const open = (ctx = fakeCtx()) => {
  lair = new Lair(ctx, { CURRENCY: 'NZD' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: id === 'gm' });
  lair.shopify.orderSpend = async () => null;
  useRules();
};

/** Thursdays 6pm to 10pm on T14-T17 for the Pokémon league, weekly, from Thursday 1 October (today) */
const hold = (over = {}, who = 'staff') => call('POST', 'blocks', {
  tables: 'T14-T17', start: at('2026-10-01', 18), end: at('2026-10-01', 22), label: 'Pokémon league', type: 'tournament', game: 'Pokémon', repeat: 'weekly', ...over,
}, who);
const remove = (id, body = {}, who = 'staff') => call('POST', `blocks/${id}/delete`, body, who);
/** A series' holds, soonest first */
const holdsOf = (seriesId) => lair.sql.exec('SELECT * FROM blocks WHERE series_id = ? ORDER BY starts_at', seriesId).toArray();
const daysOf = (seriesId) => holdsOf(seriesId).map((r) => time.key(r.starts_at));
const seriesRow = (id) => lair.sql.exec('SELECT * FROM block_series WHERE id = ?', id).one();
const viewOf = (id) => lair.seriesView(seriesRow(id), lair.rulesCache, Date.now());
const holdOn = (seriesId, day) => holdsOf(seriesId).find((r) => time.key(r.starts_at) === day);
const count = (table) => lair.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
const tableBooking = (over = {}) => ({ kind: 'table', tables: ['T15'], start: at('2026-10-08', 19), end: at('2026-10-08', 21), people: 2, name: 'Sam', email: 'sam@example.com', pay: 'day', ...over });
const THURSDAYS = ['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29', '2026-11-05', '2026-11-12', '2026-11-19', '2026-11-26', '2026-12-03'];

beforeEach(() => {
  Date.now = () => NOW;
  open();
});
afterEach(() => {
  Date.now = realNow;
});

/* ---------------- the dates ---------------- */
test('holdSeriesDays: every 7 or 14 days from the first day, up to the last day (included), skipped days left out, straight to fromKey', () => {
  assert.deepEqual(holdSeriesDays({ firstDay: '2026-10-01', every: 7 }, '2026-10-01', '2026-10-29'), ['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29']);
  assert.deepEqual(holdSeriesDays({ firstDay: '2026-10-01', every: 7, until: '2026-10-22', skip: ['2026-10-15'] }, '2026-10-01', '2026-12-31'), ['2026-10-01', '2026-10-08', '2026-10-22']);
  assert.deepEqual(holdSeriesDays({ firstDay: '2026-10-03', every: 14 }, '2026-10-04', '2026-11-30'), ['2026-10-17', '2026-10-31', '2026-11-14', '2026-11-28'], 'fortnightly, from the first date on or after fromKey');
  assert.deepEqual(holdSeriesDays({ firstDay: '2024-01-04', every: 7 }, '2026-10-01', '2026-10-15'), ['2026-10-01', '2026-10-08', '2026-10-15'], 'a series that has run for years');
  assert.deepEqual(holdSeriesDays({ firstDay: '2026-12-31', every: 7 }, '2026-12-30', '2027-01-15'), ['2026-12-31', '2027-01-07', '2027-01-14'], 'across the new year');
  assert.deepEqual(holdSeriesDays({ firstDay: '2026-10-01', every: 0 }, '2026-10-01', '2026-10-29'), []);
});

test('a weekly hold: a date every 7 days at the same Lair time, up to the booking horizon plus 7 days; the answer has the first hold and the series', async () => {
  const res = await hold();
  assert.equal(res.status, 200, res.data.error);
  const { block, series, clashes } = res.data;
  const tables = ['T14', 'T15', 'T16', 'T17'];
  assert.deepEqual(block, { id: block.id, tables, start: at('2026-10-01', 18), end: at('2026-10-01', 22), label: 'Pokémon league', type: 'tournament', game: 'Pokémon' }, 'block: the first hold, as today');
  assert.deepEqual(clashes, []);
  // 60 days plus 7 from Thursday 1 October 1pm reaches Monday 7 December 1pm: ten Thursdays
  assert.deepEqual(daysOf(series.id), THURSDAYS);
  const rows = holdsOf(series.id);
  assert.equal(rows[0].id, block.id, 'the first hold is one of them');
  assert.ok(rows.every((r) => time.minutesOf(r.starts_at) === 18 * 60 && r.ends_at - r.starts_at === 4 * HOUR), 'each 6pm to 10pm');
  assert.ok(rows.every((r) => r.label === 'Pokémon league' && r.type === 'tournament' && r.game === 'Pokémon' && r.tables === JSON.stringify(tables) && r.created_by === 'staff'));
  assert.deepEqual(series, {
    id: series.id, label: 'Pokémon league', type: 'tournament', game: 'Pokémon', tables, repeat: 'weekly', repeatTag: 'Weekly · Thursdays 6pm',
    startTime: '18:00', minutes: 240, firstDay: '2026-10-01', until: null, skipDays: [], status: 'active',
    next: rows.slice(0, 6).map((r) => ({ id: r.id, start: r.starts_at, end: r.ends_at })),
  });
  // its dates hold the tables like any hold
  assert.equal((await call('POST', 'bookings', tableBooking({ start: at('2026-10-15', 19), end: at('2026-10-15', 21) }))).status, 409);
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T13'], start: at('2026-10-15', 19), end: at('2026-10-15', 21) }))).status, 200, 'the tables next door are free');
});

test('a fortnightly hold with a last day: every 14 days up to that day, included; the tag says Fortnightly', async () => {
  const sat = { tables: 'A1-A2', start: at('2026-10-03', 11), end: at('2026-10-03', 15), label: 'Warhammer league', type: 'event', game: 'Warhammer 40,000', repeat: 'fortnightly' };
  const res = await hold({ ...sat, until: '2026-11-14' });
  assert.equal(res.status, 200, res.data.error);
  assert.deepEqual(daysOf(res.data.series.id), ['2026-10-03', '2026-10-17', '2026-10-31', '2026-11-14'], 'the last day counts');
  assert.deepEqual([res.data.series.repeat, res.data.series.repeatTag, res.data.series.until, res.data.series.startTime], ['fortnightly', 'Fortnightly · Saturdays 11am', '2026-11-14', '11:00']);
  const shorter = await hold({ ...sat, tables: 'A3-A4', until: '2026-11-13' });
  assert.deepEqual(daysOf(shorter.data.series.id), ['2026-10-03', '2026-10-17', '2026-10-31']);
  // the first day itself as the last: just the one date, and any case of the word works
  const once = await hold({ tables: 'B1', repeat: 'Weekly', until: '2026-10-01' });
  assert.deepEqual([once.status, daysOf(once.data.series.id), once.data.series.repeat], [200, ['2026-10-01'], 'weekly']);
  // half past: "Thursdays 6:30pm"
  const half = await hold({ tables: 'B2', start: at('2026-10-01', 18, 30), end: at('2026-10-01', 21, 30), repeat: 'fortnightly' });
  assert.equal(half.data.series.repeatTag, 'Fortnightly · Thursdays 6:30pm');
});

test('the messages: how often it repeats, and a last day on or after the first; nothing is held when they come back. A one-off is as before', async () => {
  const said = async (over) => {
    const r = await hold(over);
    return [r.status, r.data.error];
  };
  for (const repeat of ['monthly', 'daily', 'yes']) {
    assert.deepEqual(await said({ repeat }), [422, 'Pick how often it repeats: weekly or fortnightly. Or leave it as a one-off.'], repeat);
  }
  for (const until of ['2026-09-30', 'soon', '2026-02-30', '1 Nov', '2026-1-5']) {
    assert.deepEqual(await said({ until }), [422, "'Repeat until' has to be a date on or after the first one."], until);
  }
  assert.deepEqual(await said({ tables: 'Z9' }), [422, 'Pick tables that exist, like T11-T20.']);
  assert.deepEqual(await said({ end: at('2026-10-01', 17) }), [422, 'The hold needs an end time after the start.']);
  assert.deepEqual([count('blocks'), count('block_series')], [0, 0], 'nothing held');
  // a one-off (repeat '' or left out, or null from an older page) ignores until, and answers series: null
  for (const repeat of ['', undefined, null]) {
    const plain = await hold({ tables: 'A1', repeat, until: 'whenever' });
    assert.deepEqual([plain.status, plain.data.series, Object.keys(plain.data.block).sort()], [200, null, ['end', 'game', 'id', 'label', 'start', 'tables', 'type']]);
  }
  assert.deepEqual([count('blocks'), count('block_series')], [3, 0]);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM blocks WHERE series_id IS NOT NULL').one().n, 0);
  // staff only
  assert.equal((await hold({}, 'someone')).status, 403);
  assert.equal((await remove('bl_x', { later: true }, 'someone')).status, 403);
});

test('the horizon: never more than the booking horizon plus 7 days ahead (lair_horizon_days); the first date is always the one asked for', async () => {
  useRules({ lair_horizon_days: 14 });
  // 14 + 7 days from Thursday 1 October 1pm is Thursday 22 October 1pm: the 6pm hold that day is past it
  assert.deepEqual(daysOf((await hold()).data.series.id), ['2026-10-01', '2026-10-08', '2026-10-15']);
  // a noon hold that day is inside it (and a first date already started is still held, as a one-off would be)
  assert.deepEqual(daysOf((await hold({ tables: 'A1', start: at('2026-10-01', 12), end: at('2026-10-01', 16) })).data.series.id), ['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22']);
  // a first date beyond the horizon: just that one, until maintenance reaches the next
  const far = await hold({ tables: 'B1', start: at('2027-01-07', 18), end: at('2027-01-07', 22) });
  assert.deepEqual([daysOf(far.data.series.id), far.data.series.status, far.data.series.next.length], [['2027-01-07'], 'active', 1]);
  // the morning of that first date, the horizon (21 days) reaches Thursday 28 January 9am
  Date.now = () => at('2027-01-07', 9);
  await maintenance();
  assert.deepEqual(daysOf(far.data.series.id), ['2027-01-07', '2027-01-14', '2027-01-21'], 'maintenance reaches the next ones');
});

/* ---------------- daylight saving ---------------- */
test('daylight saving, clocks going forward (Sun 27 Sep 2026): every date starts at 6pm Lair time, weekly and fortnightly; a hold across midnight keeps its length', async () => {
  Date.now = () => SPRING;
  const weekly = await hold({ start: at('2026-09-10', 18), end: at('2026-09-10', 22) });
  assert.equal(weekly.status, 200, weekly.data.error);
  const rows = holdsOf(weekly.data.series.id);
  assert.deepEqual(rows.slice(0, 4).map((r) => time.key(r.starts_at)), ['2026-09-10', '2026-09-17', '2026-09-24', '2026-10-01']);
  assert.ok(rows.every((r) => time.minutesOf(r.starts_at) === 18 * 60 && r.ends_at - r.starts_at === 4 * HOUR), 'every one 6pm to 10pm');
  assert.equal(rows[3].starts_at - rows[2].starts_at, 7 * DAY - HOUR, 'the week the clocks go forward is an hour shorter');
  const fortnightly = await hold({ tables: 'A1', start: at('2026-09-17', 18), end: at('2026-09-17', 21), repeat: 'fortnightly' });
  const two = holdsOf(fortnightly.data.series.id);
  assert.deepEqual(two.slice(0, 2).map((r) => [time.key(r.starts_at), time.minutesOf(r.starts_at)]), [['2026-09-17', 18 * 60], ['2026-10-01', 18 * 60]]);
  assert.equal(two[1].starts_at - two[0].starts_at, 14 * DAY - HOUR);
  // Saturdays 10pm to 2am: on the night the clocks jump at 2am it still runs 4 hours, so it ends at 3am
  const late = await hold({ tables: 'B1-B2', start: at('2026-09-12', 22), end: at('2026-09-13', 2), label: 'Night owls', type: 'event' });
  const nights = holdsOf(late.data.series.id);
  const change = nights.find((r) => time.key(r.starts_at) === '2026-09-26');
  assert.ok(change && nights.length > 4);
  assert.ok(nights.every((r) => time.minutesOf(r.starts_at) === 22 * 60 && r.ends_at - r.starts_at === 4 * HOUR), 'each starts at 10pm and lasts 4 hours');
  assert.deepEqual([time.key(change.ends_at), time.minutesOf(change.ends_at)], ['2026-09-27', 3 * 60]);
  assert.equal(time.minutesOf(nights[0].ends_at), 2 * 60);
  assert.deepEqual([late.data.series.repeatTag, late.data.series.minutes], ['Weekly · Saturdays 10pm', 240]);
});

test('daylight saving, clocks going back (Sun 4 Apr 2027): every date starts at 6pm Lair time; a hold across midnight keeps its length', async () => {
  Date.now = () => AUTUMN;
  const weekly = await hold({ start: at('2027-03-25', 18), end: at('2027-03-25', 22) });
  const rows = holdsOf(weekly.data.series.id);
  assert.deepEqual(rows.slice(0, 3).map((r) => time.key(r.starts_at)), ['2027-03-25', '2027-04-01', '2027-04-08']);
  assert.ok(rows.every((r) => time.minutesOf(r.starts_at) === 18 * 60 && r.ends_at - r.starts_at === 4 * HOUR));
  assert.equal(rows[2].starts_at - rows[1].starts_at, 7 * DAY + HOUR, 'the week the clocks go back is an hour longer');
  // Saturdays 11pm to 4am: the night the clocks go back at 3am it still runs 5 hours, so it ends at 3am
  const late = await hold({ tables: 'B1-B2', start: at('2027-03-27', 23), end: at('2027-03-28', 4), label: 'Night owls', type: 'event' });
  const nights = holdsOf(late.data.series.id);
  const change = nights.find((r) => time.key(r.starts_at) === '2027-04-03');
  assert.ok(nights.every((r) => time.minutesOf(r.starts_at) === 23 * 60 && r.ends_at - r.starts_at === 5 * HOUR));
  assert.deepEqual([time.key(change.ends_at), time.minutesOf(change.ends_at)], ['2027-04-04', 3 * 60]);
  assert.equal(time.minutesOf(nights[0].ends_at), 4 * 60);
  // and maintenance a month on keeps them at 6pm
  Date.now = () => AUTUMN + 30 * DAY;
  await maintenance();
  const later = holdsOf(weekly.data.series.id);
  assert.ok(later.length > rows.length && later.every((r) => time.minutesOf(r.starts_at) === 18 * 60 && time.weekday(time.key(r.starts_at)) === 4));
});

test('daylight saving: the tests above hold whatever the machine\'s own time zone is', () => {
  // the Lair works in its own time zone, so the process's TZ (UTC or Pacific/Auckland in CI) changes nothing
  assert.equal(new Date(at('2026-09-26', 22)).toISOString(), '2026-09-26T10:00:00.000Z');
  assert.equal(new Date(at('2027-04-03', 23)).toISOString(), '2027-04-03T10:00:00.000Z');
});

/* ---------------- clashes ---------------- */
test('clashes: every date made lists the active bookings on those tables, { ref, start }, soonest first, once each', async () => {
  const b22 = await call('POST', 'bookings', tableBooking({ start: at('2026-10-22', 18), end: at('2026-10-22', 20) }));
  const b8 = await call('POST', 'bookings', tableBooking({ tables: ['T16', 'T17'], people: 6, start: at('2026-10-08', 19), end: at('2026-10-08', 21) }));
  const gone = await call('POST', 'bookings', tableBooking({ start: at('2026-10-15', 19), end: at('2026-10-15', 21) }));
  await call('POST', `bookings/${gone.data.booking.id}/update`, { status: 'cancelled' }, 'staff');
  await call('POST', 'bookings', tableBooking({ tables: ['T10'], start: at('2026-10-29', 19), end: at('2026-10-29', 21) }));
  await call('POST', 'bookings', tableBooking({ start: at('2026-10-29', 16), end: at('2026-10-29', 18) }));
  assert.deepEqual([b22.status, b8.status], [200, 200]);
  const res = await hold();
  assert.deepEqual(res.data.clashes, [{ ref: b8.data.booking.ref, start: at('2026-10-08', 19) }, { ref: b22.data.booking.ref, start: at('2026-10-22', 18) }],
    'cancelled bookings, other tables and bookings that end as the hold starts are left out');
  // holding never moves a booking
  const staff = (await call('GET', 'floor', null, 'staff')).data.bookings;
  assert.deepEqual(staff.find((b) => b.id === b8.data.booking.id).tables, ['T16', 'T17']);
  assert.equal(staff.find((b) => b.id === b8.data.booking.id).status, 'confirmed');
});

/* ---------------- what staff and the public see ---------------- */
test('the floor: staff see each hold\'s series (seriesId, repeat, repeatTag, until), one-offs with nulls; the public see nothing new', async () => {
  const weekly = await hold({ until: '2026-10-29' });
  const once = await call('POST', 'blocks', { tables: 'A1', start: at('2026-10-01', 18), end: at('2026-10-01', 20), label: 'Aroha 021 555 0199', type: 'impromptu' }, 'staff');
  const staff = (await call('GET', 'floor', null, 'staff')).data.blocks;
  const sid = weekly.data.series.id;
  assert.deepEqual(staff.find((b) => b.id === weekly.data.block.id), { ...weekly.data.block, seriesId: sid, repeat: 'weekly', repeatTag: 'Weekly · Thursdays 6pm', until: '2026-10-29' });
  assert.deepEqual(staff.filter((b) => b.seriesId === sid).map((b) => time.key(b.start)), ['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29']);
  assert.deepEqual(staff.find((b) => b.id === once.data.block.id), { ...once.data.block, seriesId: null, repeat: null, repeatTag: null, until: null });
  const pub = (await call('GET', 'floor')).data.blocks;
  assert.deepEqual(pub.find((b) => b.id === weekly.data.block.id), { ...weekly.data.block, label: 'Tournament' }, 'public labels only, as today');
  assert.deepEqual(pub.find((b) => b.id === once.data.block.id), { ...once.data.block, label: 'Reserved' });
  assert.ok(pub.every((b) => !['seriesId', 'repeat', 'repeatTag', 'until'].some((k) => k in b)), 'nothing about series for the public');
  // fortnightly on the staff floor
  const fort = await hold({ tables: 'B1', repeat: 'fortnightly' });
  const again = (await call('GET', 'floor', null, 'staff')).data.blocks.find((b) => b.id === fort.data.block.id);
  assert.deepEqual([again.repeat, again.repeatTag, again.until], ['fortnightly', 'Fortnightly · Thursdays 6pm', null]);
});

/* ---------------- skip a date ---------------- */
test('skipping a date: removing one hold of a series frees its tables and puts its day on skip_days, so maintenance never makes it again', async () => {
  const { series } = (await hold()).data;
  const oct15 = holdOn(series.id, '2026-10-15');
  assert.deepEqual((await remove(oct15.id)).data, { ok: true, removed: 1 });
  assert.deepEqual((await remove(oct15.id)).data, { ok: true, removed: 0 }, 'a second tap isn\'t an error');
  assert.deepEqual(seriesRow(series.id).skip_days, '["2026-10-15"]');
  assert.deepEqual(viewOf(series.id).skipDays, ['2026-10-15']);
  assert.equal(viewOf(series.id).status, 'active');
  assert.equal((await call('POST', 'bookings', tableBooking({ start: at('2026-10-15', 19), end: at('2026-10-15', 21) }))).status, 200, 'its tables are free that night');
  // no body at all, as older pages send it, skips too
  const nov5 = holdOn(series.id, '2026-11-05');
  const bare = await lair.fetch(new Request(`https://lair.test/blocks/${nov5.id}/delete`, { method: 'POST', headers: { 'X-Lair-Customer': 'staff' } }));
  assert.deepEqual(await bare.json(), { ok: true, removed: 1 });
  await maintenance();
  Date.now = () => NOW + 3 * DAY;
  await maintenance();
  assert.deepEqual(daysOf(series.id), THURSDAYS.filter((d) => !['2026-10-15', '2026-11-05'].includes(d)), 'skipped days stay skipped');
  assert.deepEqual(viewOf(series.id).skipDays, ['2026-10-15', '2026-11-05']);
  // a one-off with later: true just goes
  const once = await call('POST', 'blocks', { tables: 'A1', start: at('2026-10-02', 18), end: at('2026-10-02', 20), label: 'Market', type: 'market' }, 'staff');
  assert.deepEqual((await remove(once.data.block.id, { later: true })).data, { ok: true, removed: 1 });
});

/* ---------------- stop repeating ---------------- */
test('stopping from a later date: it and every later date go, the series ends the day before; earlier dates stay; then it has ended', async () => {
  const { series } = (await hold()).data;
  const oct22 = holdOn(series.id, '2026-10-22');
  assert.deepEqual((await remove(oct22.id, { later: true })).data, { ok: true, removed: 7 });
  assert.deepEqual(daysOf(series.id), ['2026-10-01', '2026-10-08', '2026-10-15']);
  assert.deepEqual([seriesRow(series.id).until_day, viewOf(series.id).until, viewOf(series.id).status], ['2026-10-21', '2026-10-21', 'active']);
  const staff = (await call('GET', 'floor', null, 'staff')).data.blocks.filter((b) => b.seriesId === series.id);
  assert.ok(staff.length === 3 && staff.every((b) => b.until === '2026-10-21'));
  assert.deepEqual((await remove(oct22.id, { later: true })).data, { ok: true, removed: 0 }, 'a second tap isn\'t an error');
  // maintenance doesn't go past its new last day, and it ends once its last date is over
  Date.now = () => NOW + 7 * DAY;
  await maintenance();
  assert.deepEqual(daysOf(series.id), ['2026-10-01', '2026-10-08', '2026-10-15']);
  Date.now = () => at('2026-10-15', 18, 30);
  assert.deepEqual([viewOf(series.id).status, viewOf(series.id).next], ['ended', []], 'nothing left to come');
  Date.now = () => at('2026-10-23', 9);
  assert.equal(viewOf(series.id).status, 'ended');
  // stopping it now, from a date that has ended, removes nothing and keeps its last day (a stop never moves it later)
  assert.deepEqual((await remove(holdOn(series.id, '2026-10-15').id, { later: true })).data, { ok: true, removed: 0 });
  assert.deepEqual(daysOf(series.id), ['2026-10-01', '2026-10-08', '2026-10-15'], 'the past is never removed');
  assert.deepEqual([seriesRow(series.id).until_day, viewOf(series.id).status], ['2026-10-21', 'stopped']);
  // a last day it was given moves earlier with a stop
  const ending = (await hold({ tables: 'A1', start: at('2026-10-29', 18), end: at('2026-10-29', 22), until: '2026-11-19' })).data.series;
  assert.deepEqual(daysOf(ending.id), ['2026-10-29', '2026-11-05', '2026-11-12', '2026-11-19']);
  assert.deepEqual((await remove(holdOn(ending.id, '2026-11-12').id, { later: true })).data, { ok: true, removed: 2 });
  assert.deepEqual([seriesRow(ending.id).until_day, viewOf(ending.id).status], ['2026-11-11', 'active']);
});

test('stopping from the first date to come stops the series ("stopped"); holds in the past, and one under way, stay', async () => {
  // started a week ago: last Thursday's hold has ended
  const { series } = (await hold({ start: at('2026-09-24', 18), end: at('2026-09-24', 22) })).data;
  assert.deepEqual(daysOf(series.id), ['2026-09-24', ...THURSDAYS], 'a first date in the past is held as asked, then every date to come');
  assert.deepEqual((await remove(holdOn(series.id, '2026-10-01').id, { later: true })).data, { ok: true, removed: 10 });
  assert.deepEqual(daysOf(series.id), ['2026-09-24']);
  assert.deepEqual([viewOf(series.id).status, viewOf(series.id).until, viewOf(series.id).next], ['stopped', '2026-09-30', []]);
  Date.now = () => NOW + 30 * DAY;
  await maintenance();
  assert.deepEqual(daysOf(series.id), ['2026-09-24'], 'maintenance leaves a stopped series alone');
  // tonight's hold under way: stopping from the next one keeps it (tonight's league keeps its tables)
  Date.now = () => at('2026-10-01', 19);
  const league = (await hold({ tables: 'A1-A2' })).data.series;
  assert.deepEqual(viewOf(league.id).next.map((x) => time.key(x.start)), THURSDAYS.slice(1, 7), 'next: dates not started yet');
  assert.deepEqual((await remove(holdOn(league.id, '2026-10-08').id, { later: true })).data, { ok: true, removed: 9 });
  assert.deepEqual([daysOf(league.id), viewOf(league.id).status, viewOf(league.id).until], [['2026-10-01'], 'stopped', '2026-10-07']);
  // stopping from tonight's own hold, under way, frees tonight's tables too
  const other = (await hold({ tables: 'B1-B2' })).data.series;
  assert.deepEqual((await remove(holdOn(other.id, '2026-10-01').id, { later: true })).data, { ok: true, removed: 10 });
  assert.deepEqual([daysOf(other.id), viewOf(other.id).status, viewOf(other.id).until], [[], 'stopped', '2026-09-30']);
  // a series from a week back, made at 7pm: tonight's date is under way, so it's held too (it hasn't ended)...
  const backdated = (await hold({ tables: 'T5-T6', start: at('2026-09-24', 18), end: at('2026-09-24', 22) })).data.series;
  assert.deepEqual(daysOf(backdated.id), ['2026-09-24', ...THURSDAYS]);
  // ...but made at 11pm, tonight's has ended: it isn't
  Date.now = () => at('2026-10-01', 23);
  const lateNight = (await hold({ tables: 'T7-T8', start: at('2026-09-24', 18), end: at('2026-09-24', 22) })).data.series;
  assert.deepEqual(daysOf(lateNight.id), ['2026-09-24', ...THURSDAYS.slice(1)]);
  // and a Wednesday 10pm to 2am hold, made at 1am on Thursday while last night's date is still going: that one is held
  Date.now = () => at('2026-10-01', 1);
  const owls = (await hold({ tables: 'T9-T10', start: at('2026-09-23', 22), end: at('2026-09-24', 2), label: 'Night owls', type: 'event' })).data.series;
  assert.deepEqual(daysOf(owls.id).slice(0, 3), ['2026-09-23', '2026-09-30', '2026-10-07']);
  // stopping from a hold that has ended: it stays, the dates to come go
  Date.now = () => at('2026-10-09', 12);
  const old = (await hold({ tables: 'T1-T2', start: at('2026-10-01', 18), end: at('2026-10-01', 22) })).data.series;
  assert.deepEqual(daysOf(old.id), ['2026-10-01', ...THURSDAYS.slice(2), '2026-12-10'], 'the first, then the dates to come');
  assert.deepEqual((await remove(holdOn(old.id, '2026-10-01').id, { later: true })).data, { ok: true, removed: 9 });
  assert.deepEqual([daysOf(old.id), viewOf(old.id).status, viewOf(old.id).until], [['2026-10-01'], 'stopped', '2026-10-14']);
});

/* ---------------- maintenance ---------------- */
test('maintenance tops up open series as the days go by, to the horizon plus 7 days: never a skipped date, never past the last day, never a stopped series, never twice', async () => {
  const thursdays = (await hold()).data.series;
  // Fridays until 11 December
  const fridays = (await hold({ tables: 'A1', start: at('2026-10-02', 18), end: at('2026-10-02', 22), label: 'Kill Team league', type: 'event', until: '2026-12-11' })).data.series;
  // Saturdays, stopped from their first date to come
  const saturdays = (await hold({ tables: 'B1', start: at('2026-10-03', 10), end: at('2026-10-03', 13), label: 'Painting club', type: 'event' })).data.series;
  await remove(holdOn(saturdays.id, '2026-10-03').id, { later: true });
  assert.equal(viewOf(saturdays.id).status, 'stopped');
  // skip 3 December, already made
  await remove(holdOn(thursdays.id, '2026-12-03').id);
  assert.equal((await maintenance()).data.holdSeries, undefined, 'nothing to make yet');
  // two weeks on: the horizon reaches Monday 21 December 1pm
  Date.now = () => NOW + 14 * DAY;
  const run = (await maintenance()).data;
  assert.deepEqual(run.holdSeries.map((x) => [x.series, x.created]).sort(), [[thursdays.id, 2], [fridays.id, 1]].sort());
  assert.deepEqual(daysOf(thursdays.id), [...THURSDAYS.filter((d) => d !== '2026-12-03'), '2026-12-10', '2026-12-17']);
  assert.deepEqual(daysOf(fridays.id).slice(-2), ['2026-12-04', '2026-12-11'], 'up to its last day, included');
  assert.deepEqual(daysOf(saturdays.id), []);
  const added = holdOn(thursdays.id, '2026-12-17');
  assert.deepEqual([added.label, added.type, added.game, added.tables, added.created_by, added.ends_at - added.starts_at], ['Pokémon league', 'tournament', 'Pokémon', '["T14","T15","T16","T17"]', 'staff', 4 * HOUR]);
  assert.equal((await maintenance()).data.holdSeries, undefined, 'never twice');
  // the holds that have ended stay where they were
  assert.ok(holdOn(thursdays.id, '2026-10-01') && holdOn(thursdays.id, '2026-10-08'));
  // a series past its last day is left alone, and reads as ended
  Date.now = () => at('2026-12-12', 9);
  await maintenance();
  assert.deepEqual([daysOf(fridays.id).at(-1), viewOf(fridays.id).status], ['2026-12-11', 'ended']);
  assert.equal(viewOf(thursdays.id).status, 'active');
});

/* ---------------- the migration ---------------- */
test('migration: round 8 adds only a column, an index and a table; a round 7 database moves on with its holds, which read as one-offs', async () => {
  const mine = MIGRATIONS.findIndex((m) => m.some((s) => /CREATE TABLE IF NOT EXISTS block_series/.test(s)));
  assert.ok(mine > 0, 'holds\' migration is in the list');
  assert.ok(MIGRATIONS[mine].every((s) => /^\s*(ALTER TABLE \w+ ADD COLUMN|CREATE (UNIQUE )?INDEX IF NOT EXISTS|CREATE TABLE IF NOT EXISTS)/.test(s)), 'only new columns, tables and indexes');
  assert.ok(MIGRATIONS[mine].some((s) => /ALTER TABLE blocks ADD COLUMN series_id TEXT/.test(s)) && MIGRATIONS[mine].some((s) => /blocks_series ON blocks \(series_id, starts_at\)/.test(s)));
  const ctx = fakeCtx();
  const { sql } = ctx.storage;
  sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  for (const statement of MIGRATIONS.slice(0, mine).flat()) sql.exec(statement);
  sql.exec("INSERT INTO meta (key, value) VALUES ('schema', ?)", String(mine));
  sql.exec("INSERT INTO blocks (id, tables, starts_at, ends_at, label, type, created_by, created_at, game) VALUES ('bl_r7', '[\"T15\"]', ?, ?, 'Pokémon league', 'tournament', 'staff', ?, 'Pokémon')",
    at('2026-10-01', 18), at('2026-10-01', 22), NOW - DAY);
  open(ctx);
  assert.equal(sql.exec("SELECT value FROM meta WHERE key = 'schema'").one().value, String(MIGRATIONS.length));
  assert.equal(count('blocks'), 1, 'the hold is kept');
  const staff = (await call('GET', 'floor', null, 'staff')).data.blocks;
  assert.deepEqual(staff, [{ id: 'bl_r7', tables: ['T15'], start: at('2026-10-01', 18), end: at('2026-10-01', 22), label: 'Pokémon league', type: 'tournament', game: 'Pokémon', seriesId: null, repeat: null, repeatTag: null, until: null }]);
  assert.deepEqual((await remove('bl_r7', { later: true })).data, { ok: true, removed: 1 });
  assert.equal((await hold()).status, 200, 'and repeating holds work on it');
  // opening it again runs nothing twice
  open(ctx);
  assert.equal(sql.exec("SELECT value FROM meta WHERE key = 'schema'").one().value, String(MIGRATIONS.length));
});

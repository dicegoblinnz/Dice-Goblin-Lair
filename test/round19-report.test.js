// Round 19, the weekly numbers (24 Oct 2026, contract v19-report). From the website lab: the one number is regulars, with a
// visit counted when it was checked in or paid (Mo picked "Checked in or paid"), a staff-only weekly report, and an
// anonymous count of the website's booking steps (Mo: "Yes, build both").
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { REPORT_WEEKS_MAX, STEP_LIMIT, addDays, mondayOf, weekLabel } from '../src/report.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 60 * MIN;
// Monday 26 October 2026, 9:00am in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 9, 25, 20, 0);
const realNow = Date.now;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Long before every week in these reports: rows made then never count as made in a week
const LONG_AGO = Date.UTC(2026, 0, 5);

// The weeks, by their Mondays: this week (so far), then the whole weeks before it
const W0 = '2026-10-26';
const W1 = '2026-10-19';
const W2 = '2026-10-12';
const W3 = '2026-10-05';
const W4 = '2026-09-28';

function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      if (/^\s*(select|with|pragma)/i.test(query)) {
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

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];
// The main account; helpers Hemi (Check-in only) and Aroha (Community); members
const OWNER = '9001';
const HEMI = '9102';
const AROHA = '9105';
const MIA = '6001';
const KAI = '6002';
const LEO = '6003';
const ZOE = '6004';
const NOA = '6005';
const STAFF_EMAIL = 'staff@dicegoblin.test';

let lair;
let mails = [];
let pending = [];
async function call(method, path, body, customer = '', headers = {}) {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...headers },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  }));
  return { status: response.status, data: await response.json() };
}
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const report = async (weeks = 4, who = OWNER) => ok(await call('GET', `report?weeks=${weeks}`, null, who));
const week = (data, monday) => data.weeks.find((w) => w.week === monday);

/* --- rows straight into the store, so each week's numbers are known exactly --- */
let seq = 0;
/** A booking on a day ('YYYY-MM-DD') at an hour; made LONG_AGO unless `made` says when */
function booking({
  customer = null, day, hour = 18, people = 1, status = 'confirmed', kind = 'table', paid = 0, paidAmount = 0, covered = 0,
  made = LONG_AGO, gameId = null, notes = null, gobSaved = 0, addedBy = null, paidAt,
}) {
  seq += 1;
  const id = `bk_t${seq}`;
  // paid at the counter on the day (an hour in) unless the test says when
  const when = paidAt !== undefined ? paidAt : paid || paidAmount ? at(day, hour + 1) : null;
  lair.sql.exec(
    `INSERT INTO bookings (id, ref, kind, status, tables, starts_at, ends_at, people, name, paid, paid_amount, covered, game_id, customer_id,
       notes, created_at, updated_at, paid_at)
     VALUES (?, ?, ?, ?, '["T1"]', ?, ?, ?, 'Someone', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, `REF-${seq}`, kind, status, at(day, hour), at(day, hour + 2), people, paid, paidAmount, covered, gameId, customer, notes, made, made, when,
  );
  if (gobSaved) lair.sql.exec('UPDATE bookings SET gob_saved = 1 WHERE id = ?', id);
  if (addedBy) lair.sql.exec('UPDATE bookings SET added_by = ? WHERE id = ?', addedBy, id);
  return id;
}
/** An event sign-up */
function signUp({ customer = null, day, hour = 18, people = 1, status = 'confirmed', paid = 0, made = LONG_AGO, addedBy = null, source = null, paidAt }) {
  seq += 1;
  const id = `ej_t${seq}`;
  const when = paidAt !== undefined ? paidAt : paid ? at(day, hour + 1) : null;
  lair.sql.exec(
    `INSERT INTO event_joins (id, ref, occurrence_id, event_id, title, starts_at, ends_at, people, name, status, customer_id, pay, paid, amount,
       created_at, updated_at, added_by, source, paid_at)
     VALUES (?, ?, ?, 'pokemon-night', 'Pokémon night', ?, ?, ?, 'Someone', ?, ?, 'day', ?, 0, ?, ?, ?, ?, ?)`,
    id, `JOIN-${seq}`, `pokemon-night:${day}`, at(day, hour), at(day, hour + 3), people, status, customer, paid, made, made, addedBy, source, when,
  );
  return id;
}
const player = (bookingId, customer) => {
  seq += 1;
  lair.sql.exec("INSERT INTO booking_players (id, booking_id, role, position, name, customer_id, created_at) VALUES (?, ?, 'player', ?, 'A player', ?, ?)", `bp_t${seq}`, bookingId, seq, customer, LONG_AGO);
};
const guest = (joinId, customer) => {
  seq += 1;
  lair.sql.exec('INSERT INTO event_join_guests (id, join_id, customer_id, name, created_at) VALUES (?, ?, ?, ?, ?)', `eg_t${seq}`, joinId, customer, 'A guest', LONG_AGO);
};

beforeEach(async () => {
  mails = [];
  pending = [];
  seq = 0;
  globalThis.fetch = async (url) => {
    throw new Error(`No network in tests: ${url}`);
  };
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', RESEND_API_KEY: 're_test', FROM_EMAIL: 'gobgob@dicegoblin.test', STAFF_EMAIL });
  lair.later = (promise) => {
    const safe = Promise.resolve(promise).catch((error) => console.error('background', error));
    pending.push(safe);
    return safe;
  };
  lair.mail = async (message) => {
    mails.push(message);
    return { ok: true, status: 200 };
  };
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.accountEmail = async () => ({ fetched: false, email: '' });
  lair.checkGiftCodes = async () => 0;
  Object.defineProperty(lair.shopify, 'configured', { get: () => false, configurable: true });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, LONG_AGO);
  for (const [id, name, perms] of [[HEMI, 'Hemi Walker', ['checkin']], [AROHA, 'Aroha Ngata', ['community']]]) {
    ok(await call('POST', 'team', { customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, perms }, OWNER));
  }
  // the team was added just now: as if long ago, so only the members each test adds are new in a week
  lair.sql.exec('UPDATE members SET created_at = ?', LONG_AGO);
});

afterEach(async () => {
  await Promise.all(pending);
  Date.now = realNow;
});

test('weekly numbers (round 19): weeks run Monday to Sunday at the Lair, and labels read like the staff page', () => {
  assert.equal(mondayOf(time, '2026-10-25'), W1, 'a Sunday belongs to the week before');
  assert.equal(mondayOf(time, W0), W0);
  assert.equal(mondayOf(time, '2026-10-31'), W0);
  assert.equal(addDays('2026-10-26', -7), W1);
  assert.equal(addDays('2026-12-29', 7), '2027-01-05');
  assert.equal(weekLabel(W1), '19–25 Oct');
  assert.match(weekLabel(W4), /^28 Sep.* – 4 Oct$/);
});

test('weekly numbers (round 19): staff with Community and the main account see them; members and other helpers don\'t', async () => {
  const member = await call('GET', 'report', null, MIA);
  assert.equal(member.status, 403);
  assert.match(member.data.error, /Staff only/);
  const helper = await call('GET', 'report', null, HEMI);
  assert.equal(helper.status, 403, 'Hemi has Check-in, not Community');
  const aroha = ok(await call('GET', 'report', null, AROHA));
  assert.equal(aroha.weeks.length, 9, 'this week and the 8 before it by default');
  assert.equal(aroha.weeks[0].week, W0);
  assert.equal(aroha.weeks[0].partial, true);
  assert.equal(aroha.weeks[1].week, W1);
  assert.equal(aroha.weeks[1].partial, false);
  assert.equal(ok(await call('GET', 'report?weeks=99', null, OWNER)).weeks.length, REPORT_WEEKS_MAX + 1, 'at most 26 whole weeks');
  assert.equal(ok(await call('GET', 'report?weeks=0', null, OWNER)).weeks.length, 9, 'nonsense gets the default');
  assert.equal(aroha.tz, TZ);
  assert.match(aroha.words.visit, /checked in, or paid on the day/);
});

test('regulars (round 19): visits in 2 different weeks of the last 4, checked in or paid on the day; paid later or ahead, cancellations, no-shows and same-week repeats don\'t make one', async () => {
  // Mia: checked in on a table in W1 and W3, and an event sign-up checked in in W2 (her guest Noa has an account)
  booking({ customer: MIA, day: '2026-10-20', status: 'done', people: 3 });
  booking({ customer: MIA, day: '2026-10-08', status: 'seated' });
  const miaJoin = signUp({ customer: MIA, day: '2026-10-15', status: 'attended', people: 2 });
  guest(miaJoin, NOA);
  // Kai: paid at the counter twice but never scanned, W1 and W2 (the "or paid" Mo picked)
  booking({ customer: KAI, day: '2026-10-21', paid: 1 });
  booking({ customer: KAI, day: '2026-10-14', paidAmount: 500 });
  // Leo: twice in the same week only
  booking({ customer: LEO, day: '2026-10-22', status: 'seated' });
  booking({ customer: LEO, day: '2026-10-24', hour: 12, status: 'done' });
  // Zoe: her own bookings were cancelled and a no-show, but she came as a named player on a friend's table (W2) and to an
  // event (W1)
  booking({ customer: ZOE, day: '2026-10-23', status: 'cancelled', paid: 1 });
  booking({ customer: ZOE, day: '2026-10-13', status: 'noshow' });
  player(booking({ day: '2026-10-16', status: 'seated', people: 4 }), ZOE);
  signUp({ customer: ZOE, day: '2026-10-25', hour: 14, status: 'attended' });
  // Noa: her own table checked in in W4 (and Mia's guest in W2)
  booking({ customer: NOA, day: '2026-09-30', status: 'done' });
  // never visits: a paid hold that lapsed, a booking nobody came to, a cancelled sign-up, a seat nobody came to that was
  // paid at a later visit (round 15's owed seats), and a sign-up paid online days ahead that nobody scanned. Counted,
  // any of these would make Leo a regular in W0 and W1.
  booking({ customer: LEO, day: '2026-10-09', status: 'held', paid: 1 });
  booking({ customer: LEO, day: '2026-10-10' });
  signUp({ customer: LEO, day: '2026-10-11', status: 'cancelled', paid: 1 });
  booking({ customer: LEO, day: '2026-10-06', kind: 'gm-seat', paid: 1, paidAt: at('2026-10-17', 15) });
  signUp({ customer: LEO, day: '2026-10-07', paid: 1, paidAt: at('2026-10-02', 9) });

  const data = await report(6);
  // W0 (so far) looks back on W0–W3: Mia (W1, W2, W3), Kai (W1, W2), Zoe (W1, W2). Noa's W2 alone doesn't count.
  assert.equal(week(data, W0).regulars, 3);
  // W1 looks back on W1–W4: Mia, Kai, Zoe, and Noa (W2 and W4). Leo came twice, but in one week.
  assert.equal(week(data, W1).regulars, 4);
  // W2 looks back on W2–W5: Mia (W2, W3) and Noa (W2, W4)
  assert.equal(week(data, W2).regulars, 2);
  assert.equal(week(data, W3).regulars, 0);
  // people with an account who came: W1 Mia, Kai, Leo, Zoe; W2 Mia, Kai, Zoe (a player), Noa (a guest)
  assert.equal(week(data, W1).visitors, 4);
  assert.equal(week(data, W2).visitors, 4);
  assert.equal(week(data, W3).visitors, 1);
  assert.equal(week(data, W4).visitors, 1);
  // visits count everyone on them, friends without an account too: W1 = Mia's 3 + Kai + Leo 2 + Zoe's event 1
  assert.equal(week(data, W1).visits, 7);
  // W2 = Mia's sign-up of 2 + Kai + the table of 4 Zoe played at
  assert.equal(week(data, W2).visits, 7);
});

test('check-ins (round 19): the rate is checked in out of everything that should have been, and no-shows sit apart', async () => {
  booking({ customer: MIA, day: '2026-10-20', status: 'done' });
  booking({ customer: LEO, day: '2026-10-22', status: 'seated' });
  signUp({ customer: ZOE, day: '2026-10-23', status: 'attended' });
  booking({ customer: KAI, day: '2026-10-21', paid: 1 });
  signUp({ day: '2026-10-24', paid: 1 });
  booking({ day: '2026-10-24', hour: 11 });
  booking({ customer: NOA, day: '2026-10-25', hour: 12, status: 'noshow' });
  booking({ customer: NOA, day: '2026-10-19', status: 'cancelled' });
  // nobody came; it was paid 4 days later (owed): not recorded on the day
  booking({ customer: LEO, day: '2026-10-21', hour: 12, paid: 1, paidAt: at('2026-10-25', 18) });
  const w1 = week(await report(2), W1);
  assert.deepEqual(w1.checkIns, { checkedIn: 3, paidOnly: 2, notRecorded: 2, rate: 43 });
  assert.equal(w1.noShows, 1);
});

test('bookings made (round 19): online, by staff for someone, or saved by Gobgob for a weekly regular, by the week they were made', async () => {
  const made = at('2026-10-21', 15);
  booking({ customer: MIA, day: '2026-10-30', made });
  signUp({ customer: KAI, day: '2026-11-02', made });
  booking({ day: '2026-10-21', kind: 'walkin', status: 'seated', made });
  booking({ day: '2026-10-23', kind: 'gm-seat', notes: 'Added by staff', made });
  booking({ day: '2026-10-24', addedBy: `staff:${OWNER}`, made });
  signUp({ day: '2026-10-25', addedBy: `staff:${HEMI}`, made });
  signUp({ day: '2026-10-25', hour: 11, source: 'walk-in', status: 'attended', made });
  booking({ customer: LEO, day: '2026-10-28', kind: 'gm-seat', gobSaved: 1, made });
  // made the week before: not this week's
  booking({ customer: ZOE, day: '2026-10-22', made: at('2026-10-17', 10) });
  const data = await report(2);
  assert.deepEqual(week(data, W1).bookingsMade, { online: 2, staff: 5, saved: 1 });
  assert.deepEqual(week(data, W2).bookingsMade, { online: 1, staff: 0, saved: 0 });
});

test('bookings made (round 19): a table staff book for someone from the staff page, or a walk-in, is marked as the team\'s', async () => {
  const own = ok(await call('POST', 'bookings', {
    kind: 'table', tables: ['T3'], start: at(W0, 18), end: at(W0, 20), people: 2, name: 'Mia Chen', email: 'mia@example.com', phone: '021 555 0100',
  }, MIA));
  const forSomeone = ok(await call('POST', 'bookings', {
    kind: 'table', staffOverride: true, tables: ['T4'], start: at(W0, 18), end: at(W0, 20), people: 4, name: 'Rangi', email: 'rangi@example.com',
  }, OWNER));
  const walkIn = ok(await call('POST', 'bookings', { kind: 'walkin', tables: ['T5'], start: at(W0, 18), end: at(W0, 20), people: 2, name: 'Walk-in' }, OWNER));
  const by = (ref) => lair.sql.exec('SELECT added_by FROM bookings WHERE ref = ?', ref).one().added_by;
  assert.equal(by(own.booking.ref), null, 'made online by Mia');
  assert.equal(by(forSomeone.booking.ref), `staff:${OWNER}`);
  assert.equal(by(walkIn.booking.ref), `staff:${OWNER}`);
  Date.now = () => NOW + MIN;
  assert.deepEqual(week(await report(1), W0).bookingsMade, { online: 1, staff: 2, saved: 0 });
});

test('new members, TTRPG seats and the library (round 19): by week', async () => {
  for (const [id, made] of [['6101', at('2026-10-20', 12)], ['6102', at('2026-10-25', 21)], ['6103', at('2026-10-14', 9)], ['6104', at('2026-10-21', 12)]]) {
    lair.makeMember({ customerId: id, name: `Member ${id}`, email: `m${id}@example.com` }, made);
  }
  // 6101 to 6103 have used the app themselves; 6104 is a row staff made for someone (picked for a group), never seen
  lair.sql.exec("UPDATE members SET last_seen = created_at WHERE customer_id IN ('6101', '6102', '6103')");
  // a session of 5 seats: 2 and 1 booked (2 more cancelled) and the GM's friend; a cancelled session; a full one of 3
  lair.sql.exec("INSERT INTO games (id, title, tables, starts_at, ends_at, seats, status, offline_players) VALUES ('g1', 'Curse of Strahd', '[\"T9\"]', ?, ?, 5, 'open', 1)", at('2026-10-21', 18), at('2026-10-21', 22));
  booking({ day: '2026-10-21', kind: 'gm-seat', gameId: 'g1', people: 2 });
  booking({ day: '2026-10-21', kind: 'gm-seat', gameId: 'g1', people: 1 });
  booking({ day: '2026-10-21', kind: 'gm-seat', gameId: 'g1', people: 2, status: 'cancelled' });
  lair.sql.exec("INSERT INTO games (id, title, tables, starts_at, ends_at, seats, status) VALUES ('g2', 'Called off', '[\"T9\"]', ?, ?, 5, 'cancelled')", at('2026-10-22', 18), at('2026-10-22', 22));
  lair.sql.exec("INSERT INTO games (id, title, tables, starts_at, ends_at, seats, status, offline_players) VALUES ('g3', 'One-shot', '[\"T8\"]', ?, ?, 3, 'open', 5)", at('2026-10-23', 18), at('2026-10-23', 22));
  lair.sql.exec("INSERT INTO games (id, title, tables, starts_at, ends_at, seats, status) VALUES ('g4', 'Waiting for approval', '[\"T7\"]', ?, ?, 6, 'pending')", at('2026-10-24', 18), at('2026-10-24', 22));
  // library games out: 2 in W1, 1 in W2; memberships: 2 that still borrow, 1 ended
  for (const [n, out] of [[1, at('2026-10-20', 17)], [2, at('2026-10-24', 11)], [3, at('2026-10-15', 17)]]) {
    lair.sql.exec("INSERT INTO library_loans (id, variant_id, title, customer_id, status, out_at, created_at) VALUES (?, ?, 'Catan', ?, 'out', ?, ?)", `ln${n}`, `v${n}`, MIA, out, out);
  }
  // as currentMembership counts them: active, waiting on a payment, or cancelled but inside the month they paid for; one
  // person once
  for (const [n, customer, status, cancelAt] of [
    [1, '611', 'active', null], [2, '612', 'cancelling', null], [3, '613', 'ended', null], [4, '614', 'past_due', null],
    [5, '615', 'ending', null], [6, '616', 'cancelling', at('2026-10-20', 12)], [7, '611', 'active', null], [8, '617', 'cancelling', at('2026-11-15', 12)],
  ]) {
    lair.sql.exec("INSERT INTO memberships (id, contract_gid, customer_id, status, tier, billing_tier, cancel_at, created_at) VALUES (?, ?, ?, ?, 'grab', 'grab', ?, ?)", `ms${n}`, `gid://shopify/SubscriptionContract/${n}`, customer, status, cancelAt, LONG_AGO);
  }
  const data = await report(2);
  assert.equal(week(data, W1).newMembers, 2);
  assert.equal(week(data, W2).newMembers, 1);
  assert.deepEqual(week(data, W1).ttrpg, { sessions: 2, seats: 8, taken: 7 }, 'g1: 2 + 1 + the friend = 4 of 5; g3: 3 of 3 (never more than its seats)');
  assert.equal(week(data, W1).library.loansOut, 2);
  assert.equal(week(data, W2).library.loansOut, 1);
  assert.deepEqual(data.library, { memberships: 4 }, '611 (twice), 612, 614 and 617');
});

test('steps (round 19): anyone\'s browser can send them, only known flows and steps count, and nothing about who is kept', async () => {
  // past weeks' counts, as the store keeps them
  lair.sql.exec("INSERT INTO step_counts (day, flow, step, n) VALUES ('2026-10-20', 'table', 'start', 5), ('2026-10-20', 'table', 'done', 3), ('2026-10-25', 'ttrpg', 'start', 4), ('2026-10-25', 'ttrpg', 'login', 2), ('2026-10-25', 'ttrpg', 'done', 1), ('2026-10-25', 'ttrpg', 'login-done', 1)");
  assert.deepEqual(ok(await call('POST', 'steps', { flow: 'event', step: 'start' })), { ok: true, counted: true }, 'nobody logged in');
  assert.deepEqual(ok(await call('POST', 'steps', { flow: 'event', step: 'done' }, MIA)), { ok: true, counted: true });
  assert.deepEqual(ok(await call('POST', 'steps', { flow: 'ttrpg', step: 'login-done' })), { ok: true, counted: true });
  for (const wrong of [{ flow: 'event', step: 'paid' }, { flow: 'shop', step: 'start' }, {}, { flow: ['event'], step: 'start' }]) {
    assert.deepEqual(ok(await call('POST', 'steps', wrong)), { ok: true, counted: false });
  }
  const columns = lair.sql.exec('PRAGMA table_info(step_counts)').toArray().map((c) => c.name);
  assert.deepEqual(columns, ['day', 'flow', 'step', 'n'], 'no customer, browser or address');
  assert.deepEqual(lair.sql.exec("SELECT day, flow, step, n FROM step_counts WHERE flow = 'event' ORDER BY step").toArray().map((r) => ({ ...r })), [
    { day: W0, flow: 'event', step: 'done', n: 1 }, { day: W0, flow: 'event', step: 'start', n: 1 },
  ]);
  const data = await report(2);
  assert.deepEqual(week(data, W1).steps.table, { start: 5, login: 0, done: 3, 'login-done': 0 });
  assert.deepEqual(week(data, W1).steps.ttrpg, { start: 4, login: 2, done: 1, 'login-done': 1 }, 'a Sunday is still the week before');
  assert.deepEqual(week(data, W0).steps.event, { start: 1, login: 0, done: 1, 'login-done': 0 });
  assert.deepEqual(week(data, W0).steps.ttrpg, { start: 0, login: 0, done: 0, 'login-done': 1 });
});

test('steps (round 19): one browser can\'t run the numbers up; others still count', async () => {
  const send = (client) => call('POST', 'steps', { flow: 'table', step: 'start' }, '', { 'X-Lair-Client': client });
  for (let i = 0; i < STEP_LIMIT + 5; i += 1) ok(await send('203.0.113.9'));
  assert.deepEqual(ok(await send('198.51.100.4')), { ok: true, counted: true });
  assert.equal(lair.sql.exec("SELECT n FROM step_counts WHERE flow = 'table' AND step = 'start'").one().n, STEP_LIMIT + 1);
  // ten minutes on, that browser counts again
  Date.now = () => NOW + 11 * MIN;
  assert.deepEqual(ok(await send('203.0.113.9')), { ok: true, counted: true });
});

test('the weekly email (round 19): from Monday 8am, once a week, last week beside the week before; the first run only notes the week', async () => {
  booking({ customer: MIA, day: '2026-10-20', status: 'done' });
  booking({ customer: MIA, day: '2026-10-13', status: 'done' });
  booking({ customer: KAI, day: '2026-10-21', paid: 1 });
  booking({ day: '2026-10-22' });
  const rules = lair.rulesCache;
  // before 8am on Monday: nothing yet
  assert.equal(lair.weeklyReportMail(rules, at(W0, 7, 50)), null);
  // the first run after it goes live notes the week and sends nothing: the first email is the first whole week counted
  assert.deepEqual(lair.weeklyReportMail(rules, at(W0, 9)), { sent: 0, week: W1, baseline: true });
  assert.equal(mails.length, 0);
  assert.equal(lair.weeklyReportMail(rules, at(W0, 9, 10)), null);
  // the next Monday: last week (26 Oct to 1 Nov) beside the week before
  booking({ customer: KAI, day: '2026-10-28', status: 'done' });
  lair.sql.exec("INSERT INTO step_counts (day, flow, step, n) VALUES ('2026-10-28', 'ttrpg', 'start', 6), ('2026-10-28', 'ttrpg', 'login', 3), ('2026-10-29', 'ttrpg', 'done', 2), ('2026-10-29', 'ttrpg', 'login-done', 1)");
  const result = lair.weeklyReportMail(rules, at('2026-11-02', 8, 5));
  assert.deepEqual(result, { sent: 1, week: W0, to: STAFF_EMAIL });
  await Promise.all(pending);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, STAFF_EMAIL);
  assert.match(mails[0].subject, /^Lair numbers, 26 October to 1 November: 2 regulars$/);
  assert.match(mails[0].text, /Regulars/);
  // Mia came in both weeks' windows; Kai's second visit (28 Oct) is only in the last week's
  assert.match(mails[0].text, /2 \(1 the week before\)/);
  assert.match(mails[0].text, /paid on the day/);
  assert.match(mails[0].text, /6 started, 2 finished; 3 started logged out and were asked to log in first, and 1 of them finished/);
  // once a week: not again that day, nor later in the week
  assert.equal(lair.weeklyReportMail(rules, at('2026-11-02', 8, 15)), null);
  assert.equal(lair.weeklyReportMail(rules, at('2026-11-04', 12)), null);
  // missed Monday (the app was down): the first run after sends it
  assert.deepEqual(lair.weeklyReportMail(rules, at('2026-11-10', 3)), { sent: 1, week: '2026-11-02', to: STAFF_EMAIL });
});

test('the weekly email (round 19): REPORT_EMAIL sends it elsewhere or turns it off; the 10-minute maintenance sends it', async () => {
  const rules = lair.rulesCache;
  lair.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('weekly-report', '2026-10-05')");
  lair.env.REPORT_EMAIL = 'off';
  assert.equal(lair.weeklyReportMail(rules, at(W0, 9)), null);
  lair.env.REPORT_EMAIL = 'mo@example.com';
  assert.deepEqual(lair.weeklyReportMail(rules, at(W0, 9)), { sent: 1, week: W1, to: 'mo@example.com' });
  await Promise.all(pending);
  assert.equal(mails[0].to, 'mo@example.com');
  // low check-ins: the email says the count may be short
  assert.match(mails[0].text, /No sessions to check in|Under 80%|One week is noisy/);
  delete lair.env.REPORT_EMAIL;
  lair.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('weekly-report', '2026-10-05')");
  booking({ customer: MIA, day: '2026-10-20' });
  const checked = await lair.checkConnection(undefined);
  assert.deepEqual(checked.weeklyReport, { sent: 1, week: W1, to: STAFF_EMAIL });
  await Promise.all(pending);
  assert.match(mails[1].text, /Under 80%/, 'one booking, never checked in: 0%');
});

test('the weekly email (round 19): going live mid-week, the first email is the first whole week; a REPORT_EMAIL that isn\'t one address sends nothing', async () => {
  const rules = lair.rulesCache;
  // live on Wednesday 28 October: this week is noted as if sent, so 2 November sends nothing and 9 November sends 2 to 8
  // November, the first whole week counted
  assert.deepEqual(lair.weeklyReportMail(rules, at('2026-10-28', 11)), { sent: 0, week: W0, baseline: true });
  assert.equal(lair.weeklyReportMail(rules, at('2026-11-02', 9)), null);
  assert.deepEqual(lair.weeklyReportMail(rules, at('2026-11-09', 9)), { sent: 1, week: '2026-11-02', to: STAFF_EMAIL });
  await Promise.all(pending);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /^Lair numbers, 2 November to 8 November: 0 regulars$/);
  // a typo, or two addresses, is never quietly swapped for STAFF_EMAIL
  lair.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('weekly-report', '2026-10-05')");
  for (const wrong of ['mo@example', 'mo@example.com, kim@example.com', 'mo@example.com;kim@example.com']) {
    lair.env.REPORT_EMAIL = wrong;
    assert.deepEqual(lair.weeklyReportMail(rules, at(W0, 9)), { sent: 0, error: 'REPORT_EMAIL is not one email address, so the weekly numbers were not sent.' }, wrong);
  }
  assert.equal(mails.length, 1);
  assert.equal(lair.sql.exec("SELECT value FROM meta WHERE key = 'weekly-report'").one().value, '2026-10-05', 'the week isn\'t marked as sent');
});

test('paid on the day (round 19): every write to a booking or sign-up stamps when it was first paid; older payments get their first Shopify payment\'s time', async () => {
  const made = ok(await call('POST', 'bookings', {
    kind: 'table', tables: ['T3'], start: at(W0, 18), end: at(W0, 20), people: 2, name: 'Mia Chen', email: 'mia@example.com', phone: '021 555 0100',
  }, MIA));
  const paidAt = () => lair.sql.exec('SELECT paid_at FROM bookings WHERE ref = ?', made.booking.ref).one().paid_at;
  assert.equal(paidAt(), null, 'not paid yet');
  Date.now = () => NOW + 9 * HOUR;
  lair.write('UPDATE bookings SET paid = 1, paid_amount = amount, updated_at = ? WHERE ref = ?', Date.now(), made.booking.ref);
  assert.equal(paidAt(), NOW + 9 * HOUR, 'stamped when it was paid, whichever way it was paid');
  Date.now = () => NOW + 30 * HOUR;
  lair.write('UPDATE bookings SET notes = ?, updated_at = ? WHERE ref = ?', 'A later change', Date.now(), made.booking.ref);
  assert.equal(paidAt(), NOW + 9 * HOUR, 'the first time stays');
  // a sign-up paid in part
  const joinId = signUp({ customer: KAI, day: W0 });
  lair.write('UPDATE event_joins SET paid_amount = 500, updated_at = ? WHERE id = ?', Date.now(), joinId);
  assert.equal(lair.sql.exec('SELECT paid_at FROM event_joins WHERE id = ?', joinId).one().paid_at, NOW + 30 * HOUR);
  // paid before paid_at existed: the first Shopify payment, else the last change
  const viaShopify = booking({ customer: LEO, day: '2026-10-20', paid: 1, paidAt: null, made: at('2026-10-18', 9) });
  lair.sql.exec("INSERT INTO payments (id, booking_id, kind, order_id, line_id, amount, customer_id, at) VALUES ('pm1', ?, 'booking', 'o1', 'l1', 1000, NULL, ?), ('pm2', ?, 'booking', 'o2', 'l2', 500, NULL, ?)",
    viaShopify, at('2026-10-20', 19), viaShopify, at('2026-10-22', 12));
  const byStaff = booking({ customer: ZOE, day: '2026-10-21', paid: 1, paidAt: null, made: at('2026-10-21', 17) });
  lair.backfillPaidAt();
  const stamped = (id) => lair.sql.exec('SELECT paid_at FROM bookings WHERE id = ?', id).one().paid_at;
  assert.equal(stamped(viaShopify), at('2026-10-20', 19));
  assert.equal(stamped(byStaff), at('2026-10-21', 17));
});

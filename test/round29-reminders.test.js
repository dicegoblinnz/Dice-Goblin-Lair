// Round 29, roleplayers phase 1, item 1, "Reminders" (contract v29-roleplayers section 2). Mo approved it on 2 Nov 2026:
// an email two days before each one-off booking (a TTRPG seat, a table, an event sign-up), warm first ("See you Sunday,
// Ria?"), saying what it costs, until when it can be cancelled free, with a calendar file and a cancel link that works
// without logging in ("One tap cancels while it's still free"). On Monday the weekly numbers say how many went and how
// many one-off bookings were no-shows, so Mo can judge whether reminders work. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import worker from '../src/index.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS, TAB_WORDS } from '../src/core.js';
import { GM_COVER_WORDS } from '../src/gm-cover.js';
import { CANCEL_LINK_WORDS } from '../src/booking-reminders.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// The week of Monday 2 November 2026 (NZDT, UTC+13): bookings are made on Monday, for the weekend
const MON = '2026-11-02';
const THU = '2026-11-05';
const FRI = '2026-11-06';
const SAT = '2026-11-07';
const SUN = '2026-11-08';
const NOW = at(MON, 13);
const realNow = Date.now;
const nowIs = (ms) => {
  Date.now = () => ms;
};
const ADDRESS = '56/691 Manukau Road, Royal Oak, Auckland 1023';
const WHERE = `Dice Goblin, ${ADDRESS}`;
const MY_LAIR = 'https://www.dicegoblin.nz/pages/my-lair';

/* ---------------- helpers, as in test/round28-booked.test.js and test/round11-reminders.test.js ---------------- */
function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      // as SQLite in a Durable Object: Cloudflare's limits (test/cloudflare-sql.js)
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

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];
// Blood on the Clocktower on Sunday 8 November, midday to 6pm, $10 a person with sign-ups; Oddity Alley on Saturday 7
// November, 10am to 3pm, free entry with sign-ups; a quiz on Sunday that will be taken off the calendar; and Warhammer
// night on Sunday with game tables to reserve
const EVENTS = [
  { id: 'clocktower', title: 'Blood on the Clocktower', type: 'social', start: at(SUN, 12), end: at(SUN, 18), tables: '', capacity: 40, entryFee: 1000, payment: 'store' },
  { id: 'alley', title: 'Oddity Alley', type: 'market', start: at(SAT, 10), end: at(SAT, 15), tables: '', capacity: 100, freeEntry: true, priceNote: '' },
  { id: 'quiz', title: 'Trivia night', type: 'social', start: at(SUN, 19), end: at(SUN, 21), tables: '', capacity: 20, entryFee: 500 },
  { id: 'warhammer', title: 'Warhammer night', type: 'wargame', start: at(SUN, 16), end: at(SUN, 21), tables: '', gameTables: 'T14+T15, T16+T17' },
];
const SETTINGS = { lair_hours: DEFAULT_HOURS, lair_shop_tables: '', store_phone: '021 159 6894' };
const rulesWith = (more = {}, events = EVENTS) => rulesFromSettings({ ...SETTINGS, ...more }, ROOMS, events, { address: ADDRESS });
// People by their Shopify customer IDs (made up): the main account, a trusted GM (Ellie) and four members
const OWNER = '9001';
const GM = '7001';
const MIA = '6001';
const KAI = '6002';
const RIA = '6003';
const LEO = '6004';
const MOBILE = '021 555 0100';

let lair;
let mail;
async function call(method, path, body, customer = '', extraHeaders = {}) {
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders },
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
    }),
  );
  const type = response.headers.get('Content-Type') || '';
  return { status: response.status, data: type.includes('json') ? await response.json() : await response.text(), headers: response.headers };
}
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error || JSON.stringify(res.data));
  return res.data;
};
/** The 10-minute run's reminders at a fixed time (POST /internal/reminders { at }, the live checks' clock) */
const runAt = async (ms) => {
  const res = await call('POST', 'internal/reminders', { at: ms }, '', { 'X-Lair-Internal': '1' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
};
/** How many booking reminders a run claimed */
const went = (run) => run.bookings?.sent || 0;
const settle = () => new Promise((r) => setTimeout(r, 10));

/** Every email, as Resend got it; fail(status) makes Resend answer that until fail(0) */
function captureEmails() {
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test', PUBLIC_URL: 'https://lair.example.com' };
  const sent = [];
  const reached = [];
  let failWith = 0;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.resend.com/')) {
      reached.push(String(url));
      throw new Error(`No network in tests: ${url}`);
    }
    if (failWith) return new Response(JSON.stringify({ message: 'nope' }), { status: failWith });
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return { sent, reached, fail: (status) => { failWith = status; } };
}
/** The reminders that went (their subjects start "See you"), to one address or all */
const reminders = (to = null) => mail.sent.filter((m) => /^See you /.test(m.subject) && (!to || m.to === to));
const only = (to) => {
  const list = reminders(to);
  assert.equal(list.length, 1, `one reminder to ${to}, got ${list.length}`);
  return list[0];
};
/** The hidden line email apps show after the subject */
const preheader = (m) => (m.html.match(/<div style="display:none;[^"]*">([^<]*)<\/div>/) || [])[1]?.replace(/&#39;/g, "'").replace(/&amp;/g, '&');
/** A link's address in the plain text ("Cancel my seat: https://…") */
const linkIn = (m, label) => (m.text.match(new RegExp(`^${label}: (\\S+)$`, 'm')) || [])[1] || null;
/** The cancel link's code and key */
const keyOf = (m) => {
  const url = new URL(linkIn(m, 'Cancel my (?:seat|seats|table|sign-up)'));
  return { ref: url.searchParams.get('cancel'), key: url.searchParams.get('key') };
};
const view = (body, client = '203.0.113.9') => call('POST', 'cancel-links/view', body, '', { 'X-Lair-Client': client });
const cancelBy = (body, client = '203.0.113.9') => call('POST', 'cancel-links/cancel', body, '', { 'X-Lair-Client': client });

/* ---------------- what's booked ---------------- */
/** A TTRPG session Ellie lists (a trusted GM: straight on the board): Candlekeep Mysteries, Sunday 6pm to 10pm, $15 a seat */
async function game(more = {}) {
  return ok(await call('POST', 'games', {
    title: 'Candlekeep Mysteries', system: 'D&D 5e', gm: 'Ellie', email: 'ellie@example.com', blurb: 'A library full of secrets.', seats: 4,
    tables: ['T12'], start: at(SUN, 18), end: at(SUN, 22), ...more,
  }, GM)).game;
}
const emailOf = (name) => `${name.split(' ')[0].toLowerCase()}@example.com`;
/** A seat at a session, booked online by a member (who) or a guest (who '') */
async function seat(gameId, who, name, more = {}) {
  return ok(await call('POST', 'bookings', { kind: 'gm-seat', gameId, people: 1, name, email: emailOf(name), phone: MOBILE, ...more }, who)).booking;
}
/** A table booked online: Sunday 2pm to 5pm on T3 for 4 unless said */
async function table(who, name, more = {}) {
  return ok(await call('POST', 'bookings', { kind: 'table', tables: ['T3'], start: at(SUN, 14), end: at(SUN, 17), people: 4, name, email: emailOf(name), phone: MOBILE, pay: 'day', ...more }, who)).booking;
}
/** A sign-up for an event date */
async function signUp(who, name, occurrence, more = {}) {
  return ok(await call('POST', `events/${encodeURIComponent(occurrence)}/join`, { name, email: emailOf(name), phone: MOBILE, people: 1, ...more }, who)).join;
}
const row = (id) => lair.sql.exec('SELECT * FROM bookings WHERE id = ?', id).toArray()[0];
const joinRow = (id) => lair.sql.exec('SELECT * FROM event_joins WHERE id = ?', id).toArray()[0];

beforeEach(async () => {
  nowIs(NOW);
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'example-shop.myshopify.com' });
  mail = captureEmails();
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: id === GM, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  lair.shopify.customersSince = async () => new Map();
  lair.accountEmail = async () => ({ fetched: false, email: '' });
  lair.checkGiftCodes = async () => 0;
  lair.rulesCache = rulesWith();
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  for (const [id, name] of [[OWNER, 'Mo Ashgrove'], [GM, 'Ellie Rua'], [MIA, 'Mia Chen'], [KAI, 'Kai Tane'], [RIA, 'Ria Moana'], [LEO, 'Leo Park']]) {
    lair.makeMember({ customerId: id, name, email: emailOf(name) }, NOW);
  }
});
afterEach(() => {
  Date.now = realNow;
  assert.deepEqual(mail.reached, [], 'nothing but Resend was reached');
});

/* ---------------- when it goes ---------------- */

test('round 29: the columns a reminder needs are made on start: when it went, the start it was for, and the cancel key', () => {
  for (const table of ['bookings', 'event_joins']) {
    const columns = lair.sql.exec(`SELECT name FROM pragma_table_info('${table}')`).toArray().map((c) => c.name);
    for (const column of ['reminded_at', 'reminded_start', 'cancel_key']) assert.ok(columns.includes(column), `${table}.${column}`);
  }
});

test('round 29: a one-off booking\'s reminder goes on the Lair day two days before it, from 9:00 (not 8:59), never at 21:00 or later, and once', async () => {
  const g = await game();
  await seat(g.id, RIA, 'Ria Moana');
  nowIs(at(THU, 12));
  assert.equal(went(await runAt(at(THU, 12))), 0, 'Thursday is three days before');
  assert.equal(went(await runAt(at(FRI, 21))), 0, '9pm Friday: too late at night');
  assert.equal(went(await runAt(at(FRI, 8, 59))), 0, '8:59 Friday: not yet');
  const run = await runAt(at(FRI, 9));
  assert.deepEqual(run.bookings, { sent: 1, seats: 1, tables: 0, signUps: 0, ok: true });
  assert.equal(only('ria@example.com').subject, 'See you Sunday at 6pm?');
  for (const t of [at(FRI, 9, 10), at(FRI, 20, 50), at(SAT, 9), at(SAT, 18), at(SUN, 9)]) assert.equal(went(await runAt(t)), 0, new Date(t).toISOString());
  assert.equal(reminders().length, 1, 'never twice');
});

test('round 29: POST /internal/reminders keeps its answer for event reminders (sent, dates), with booking reminders under bookings only when some were due', async () => {
  const g = await game();
  await seat(g.id, RIA, 'Ria Moana');
  assert.deepEqual(await runAt(at(FRI, 8, 55)), { sent: 0, dates: [] }, 'as round 11 answered: nothing due');
  const run = await runAt(at(FRI, 9, 5));
  assert.equal(run.sent, 0, 'sent: the event reminders ("Remind me the day before"), as before');
  assert.deepEqual(run.dates, []);
  assert.equal(run.bookings.sent, 1);
});

test('round 29: who gets one: one-off TTRPG seats, tables and sign-ups whose date is on the calendar; never a weekly saved seat, a walk-in, a held or cancelled booking, a GM\'s charge, the GM\'s own game, or a session that\'s cancelled or pending', async () => {
  const candlekeep = await game();
  await seat(candlekeep.id, RIA, 'Ria Moana');
  await seat(candlekeep.id, '', 'Sam Jones');
  const kais = await seat(candlekeep.id, KAI, 'Kai Tane');
  // the GM pays for Kai's seat: the GM's charge is a booking of its own (kind gm-cover), and gets no reminder
  ok(await call('POST', `games/${candlekeep.id}/players/${encodeURIComponent(kais.ref)}/cover`, {}, GM));
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE kind = 'gm-cover' AND status = 'confirmed'").one().n, 1);
  // a weekly game: Mia saves her seat every week (series_id), Leo books a one-off seat at it
  const weekly = await game({ title: 'Curse of Strahd', schedule: 'weekly', tables: ['T13'] });
  ok(await call('POST', `games/${weekly.id}/join-series`, { people: 1, name: 'Mia Chen', email: 'mia@example.com', phone: MOBILE }, MIA));
  assert.ok(lair.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE kind = 'gm-seat' AND series_id IS NOT NULL AND customer_id = ?", MIA).one().n >= 1, 'Mia\'s saved seat');
  await seat(weekly.id, LEO, 'Leo Park');
  // a session that's cancelled, and one sent back to waiting for approval
  const lost = await game({ title: 'Lost Mine of Phandelver', tables: ['T10'] });
  await seat(lost.id, '', 'Ana Lost', { email: 'ana@example.com' });
  ok(await call('POST', `games/${lost.id}/update`, { status: 'cancelled' }, OWNER));
  const tomb = await game({ title: 'Tomb of Annihilation', tables: ['T8'] });
  await seat(tomb.id, '', 'Ben Tomb', { email: 'ben@example.com' });
  ok(await call('POST', `games/${tomb.id}/update`, { status: 'pending' }, OWNER));
  // tables: Mia's (on), Kai's (cancelled), a walk-in and an old held one
  await table(MIA, 'Mia Chen', { tables: ['T3'] });
  const kaiTable = await table(KAI, 'Kai Tane', { tables: ['T4'], people: 2 });
  ok(await call('POST', `bookings/${kaiTable.id}/update`, { status: 'cancelled' }, KAI));
  for (const [id, kind, status, email] of [['bk_walkin0000000001', 'walkin', 'confirmed', 'walk@example.com'], ['bk_held00000000001', 'table', 'held', 'held@example.com']]) {
    lair.saveBooking({ id, ref: `R-${id}`, kind, status, tables: ['T6'], start: at(SUN, 14), end: at(SUN, 16), people: 2, name: 'Pat Doe', email, amount: 2000 }, NOW);
  }
  // sign-ups: Leo's (on); Kai's for a quiz that's then taken off the calendar
  await signUp(LEO, 'Leo Park', `clocktower@${SUN}`, { email: 'leo.signup@example.com' });
  await signUp(KAI, 'Kai Tane', `quiz@${SUN}`, { email: 'kai.quiz@example.com' });
  lair.rulesCache = rulesWith({}, EVENTS.filter((e) => e.id !== 'quiz'));

  const run = await runAt(at(FRI, 9));
  assert.deepEqual(run.bookings, { sent: 6, seats: 4, tables: 1, signUps: 1, ok: true });
  assert.deepEqual(reminders().map((m) => m.to).sort(), ['kai@example.com', 'leo.signup@example.com', 'leo@example.com', 'mia@example.com', 'ria@example.com', 'sam@example.com']);
  assert.equal(only('mia@example.com').subject, 'See you Sunday at 2pm?', 'Mia\'s table, not her saved seat');
  for (const nobody of ['ana@example.com', 'ben@example.com', 'walk@example.com', 'held@example.com', 'kai.quiz@example.com', 'ellie@example.com']) {
    assert.equal(reminders(nobody).length, 0, nobody);
  }
});

test('round 29: booked on the reminder day or later: no reminder (its confirmation was it); booked just before that day began: one', async () => {
  const g = await game();
  nowIs(at(THU, 23, 59));
  await seat(g.id, RIA, 'Ria Moana');
  nowIs(at(FRI, 0, 1));
  await seat(g.id, MIA, 'Mia Chen');
  nowIs(at(SAT, 10));
  await table(KAI, 'Kai Tane');
  assert.equal(went(await runAt(at(FRI, 9))), 1);
  assert.equal(reminders().map((m) => m.to).join(), 'ria@example.com');
  for (const t of [at(FRI, 12), at(SAT, 9), at(SAT, 12)]) assert.equal(went(await runAt(t)), 0);
});

test('round 29: Resend down or busy (5xx, 429): the reminder is unmarked and the next run sends it; an address Resend refuses (4xx) isn\'t tried again', async () => {
  const g = await game();
  const ria = await seat(g.id, RIA, 'Ria Moana');
  mail.fail(503);
  assert.equal(went(await runAt(at(FRI, 9))), 1, 'claimed');
  assert.equal(row(ria.id).reminded_at, null, 'Resend was down: unmarked for the next run');
  mail.fail(0);
  assert.equal(went(await runAt(at(FRI, 9, 10))), 1);
  assert.ok(row(ria.id).reminded_at);
  assert.equal(reminders('ria@example.com').length, 1);

  const mias = await seat(g.id, MIA, 'Mia Chen');
  lair.sql.exec('UPDATE bookings SET created_at = ? WHERE id = ?', NOW, mias.id);
  mail.fail(429);
  assert.equal(went(await runAt(at(FRI, 10))), 1);
  assert.equal(row(mias.id).reminded_at, null, 'too many requests: unmarked too');
  mail.fail(0);
  assert.equal(went(await runAt(at(FRI, 10, 10))), 1);
  assert.equal(reminders('mia@example.com').length, 1);

  const kais = await seat(g.id, KAI, 'Kai Tane');
  lair.sql.exec('UPDATE bookings SET created_at = ? WHERE id = ?', NOW, kais.id);
  mail.fail(422);
  assert.equal(went(await runAt(at(FRI, 11))), 1);
  assert.ok(row(kais.id).reminded_at, 'refused: it stays marked');
  mail.fail(0);
  assert.equal(went(await runAt(at(FRI, 11, 10))), 0, 'never tried again');
  assert.equal(went(await runAt(at(SAT, 9))), 0, 'nor the next day');
});

test('round 29: catch-up: none went on the reminder day (Resend down all day), so it goes the next day from 9am while it can still be cancelled free or has nothing to pay; never on the day itself', async () => {
  const g = await game();
  await seat(g.id, RIA, 'Ria Moana');
  const free = await game({ title: 'Free Friday Funnel', tables: ['T9'] });
  ok(await call('POST', `games/${free.id}/free`, { free: true }, OWNER));
  await seat(free.id, LEO, 'Leo Park');
  await table('', 'Sam Jones', { people: 2 });
  // Mia's Oddity Alley sign-up is on Saturday: Thursday is its reminder day, and Friday its last chance
  await signUp(MIA, 'Mia Chen', `alley@${SAT}`);
  mail.fail(503);
  for (const t of [at(FRI, 9), at(FRI, 15), at(FRI, 20, 50)]) assert.equal(went(await runAt(t)), 4, 'claimed and unmarked, every run');
  assert.equal(reminders().length, 0, 'none went on Friday');
  assert.equal(went(await runAt(at(SAT, 8, 59))), 0, 'not before 9am');
  assert.equal(went(await runAt(at(SAT, 13, 50))), 3, 'Saturday: Ria, Leo and Sam (Mia\'s alley is today: never on the day itself)');
  // Resend is back at 2:30pm Saturday: Sam's table locked in at 2pm (24 hours before), so his never comes
  mail.fail(0);
  const run = await runAt(at(SAT, 14, 30));
  assert.equal(run.bookings.sent, 2);
  assert.deepEqual(reminders().map((m) => m.to).sort(), ['leo@example.com', 'ria@example.com']);
  assert.match(only('ria@example.com').text, /Cancel free until 6pm Saturday and your seat goes back on the board for someone else\./);
  assert.match(only('leo@example.com').text, /On your tab: +Nothing to pay/);
  for (const t of [at(SAT, 18, 30), at(SUN, 9), at(SUN, 13)]) assert.equal(went(await runAt(t)), 0);
  assert.equal(reminders('sam@example.com').length + reminders('mia@example.com').length, 0);
});

test('round 29: the catch-up is for a reminder day the reminders were running on: their first start doesn\'t remind everything booked for tomorrow', async () => {
  const g = await game();
  await seat(g.id, RIA, 'Ria Moana');
  const monday = await game({ title: 'Monday Mysteries', start: at('2026-11-09', 18), end: at('2026-11-09', 22), tables: ['T9'] });
  await seat(monday.id, MIA, 'Mia Chen');
  assert.ok(lair.bookingRemindersFrom > 0 && lair.bookingRemindersFrom <= NOW, 'noted on their first start');
  // as if they first started at 8am on Saturday: Sunday's reminder day (Friday) came before that
  lair.bookingRemindersFrom = at(SAT, 8);
  const run = await runAt(at(SAT, 9));
  assert.deepEqual(reminders().map((m) => m.to), ['mia@example.com'], 'Monday\'s, on its own reminder day; none for Sunday\'s');
  assert.equal(run.bookings.sent, 1);
  // started on the Friday evening instead: Friday was a reminder day they ran on, so Saturday catches up
  lair.bookingRemindersFrom = at(FRI, 20);
  assert.equal(went(await runAt(at(SAT, 9, 10))), 1);
  assert.equal(reminders('ria@example.com').length, 1);
});

test('round 29: a booking moved to another day or time gets its reminder again, for the new time, with the same cancel key', async () => {
  const g = await game();
  await seat(g.id, RIA, 'Ria Moana');
  await runAt(at(FRI, 9));
  const first = only('ria@example.com');
  // Saturday morning staff move the session to Sunday week, 15 November
  nowIs(at(SAT, 8));
  ok(await call('POST', `games/${g.id}/edit`, { start: at('2026-11-15', 18), end: at('2026-11-15', 22) }, OWNER));
  assert.equal(went(await runAt(at(SAT, 9))), 0, 'its new reminder day is Friday 13 November');
  assert.equal(went(await runAt(at('2026-11-13', 8, 59))), 0);
  assert.equal(went(await runAt(at('2026-11-13', 9))), 1);
  const again = reminders('ria@example.com');
  assert.equal(again.length, 2);
  assert.match(again[1].text, /When: +Sunday 15 November, 6pm to 10pm/);
  assert.deepEqual(keyOf(again[1]), keyOf(first), 'one key per booking');
  // and then just its time: 7pm the same day, moved on the Saturday before (still free to cancel until 7pm)
  nowIs(at('2026-11-14', 8));
  ok(await call('POST', `games/${g.id}/edit`, { start: at('2026-11-15', 19), end: at('2026-11-15', 22) }, OWNER));
  assert.equal(went(await runAt(at('2026-11-14', 9))), 1);
  const third = reminders('ria@example.com')[2];
  assert.equal(third.subject, 'See you Sunday at 7pm?');
  assert.match(third.text, /Cancel free until 7pm Saturday/);
  assert.equal(went(await runAt(at('2026-11-14', 9, 10))), 0);
});

test('round 29: daylight saving ends on Sunday 4 April 2027: a game that evening is reminded at 9am Friday Lair time, and its cancel deadline is the lock\'s (24 hours before: 7pm Saturday, as the clocks went back)', async () => {
  nowIs(at('2027-03-29', 13));
  const g = await game({ start: at('2027-04-04', 18), end: at('2027-04-04', 22) });
  const ria = await seat(g.id, RIA, 'Ria Moana');
  assert.equal(at('2027-04-02', 9), Date.UTC(2027, 3, 1, 20, 0), '9am Friday NZDT is 8pm Thursday UTC');
  assert.equal(went(await runAt(at('2027-04-02', 8, 59))), 0);
  assert.equal(went(await runAt(at('2027-04-02', 9))), 1);
  const m = only('ria@example.com');
  assert.equal(m.subject, 'See you Sunday at 6pm?');
  assert.match(m.text, /When: +Sunday 4 April, 6pm to 10pm/);
  const lock = lair.cancelRule(lair.booking(ria.id), lair.rulesCache, at('2027-04-02', 9));
  assert.equal(lock.cancelUntil, at('2027-04-03', 19), 'the lock: 24 hours before 6pm Sunday NZST is 7pm Saturday NZDT');
  assert.match(m.text, /Cancel free until 7pm Saturday and your seat goes back on the board for someone else\. After that, the \$15 stays on your tab\./);
  assert.equal(preheader(m), 'Your seat at Candlekeep Mysteries is saved. Cancel free until 7pm Saturday.');
});

test('round 29: daylight saving starts on Sunday 26 September 2027: a game that evening is reminded at 9am Friday Lair time, cancel free until 5pm Saturday (24 hours before)', async () => {
  nowIs(at('2027-09-20', 13));
  const g = await game({ start: at('2027-09-26', 18), end: at('2027-09-26', 22) });
  await seat(g.id, RIA, 'Ria Moana');
  assert.equal(at('2027-09-24', 9), Date.UTC(2027, 8, 23, 21, 0), '9am Friday NZST is 9pm Thursday UTC');
  assert.equal(went(await runAt(at('2027-09-24', 8, 59))), 0);
  assert.equal(went(await runAt(at('2027-09-24', 9))), 1);
  const m = only('ria@example.com');
  assert.match(m.text, /When: +Sunday 26 September, 6pm to 10pm/);
  assert.match(m.text, /Cancel free until 5pm Saturday and your seat goes back on the board for someone else\./);
});

test('round 29: the kill switch: Theme settings › Lair bookings › "Email a reminder two days before each booking" off sends none; absent means on', async () => {
  assert.equal(rulesFromSettings({}, ROOMS, []).bookingReminders, true, 'absent: on');
  assert.equal(rulesFromSettings({ lair_booking_reminders: true }, ROOMS, []).bookingReminders, true);
  assert.equal(rulesFromSettings({ lair_booking_reminders: false }, ROOMS, []).bookingReminders, false);
  const g = await game();
  await seat(g.id, RIA, 'Ria Moana');
  lair.rulesCache = rulesWith({ lair_booking_reminders: false });
  assert.equal(went(await runAt(at(FRI, 9))), 0);
  lair.rulesCache = rulesWith({ lair_booking_reminders: true });
  assert.equal(went(await runAt(at(FRI, 9, 10))), 1);
});

/* ---------------- what it says ---------------- */

test('round 29: a member\'s seat: "See you Sunday, Ria?", her GM and 3 players counting on her, what it costs, until when it\'s free to cancel, the calendar file, Google Calendar, My Lair and the cancel link', async () => {
  const g = await game();
  const ria = await seat(g.id, RIA, 'Ria Moana');
  await seat(g.id, MIA, 'Mia Chen');
  await seat(g.id, KAI, 'Kai Tane');
  await seat(g.id, '', 'Sam Jones');
  await runAt(at(FRI, 9));
  const m = only('ria@example.com');
  assert.equal(m.subject, 'See you Sunday at 6pm?');
  assert.equal(preheader(m), 'Your seat at Candlekeep Mysteries is saved. Cancel free until 6pm Saturday.');
  assert.match(m.text, /^SEE YOU SUNDAY, RIA\?\n\nYour seat at Candlekeep Mysteries is saved\. Your GM and 3 players are counting on you\.\n\n/);
  assert.ok(m.html.includes('>See you Sunday, Ria?</h1>'));
  assert.match(m.text, /When: +Sunday 8 November, 6pm to 10pm\n/);
  assert.match(m.text, /Game: +Candlekeep Mysteries, D&D 5e\n/);
  assert.match(m.text, new RegExp(`Where: +${WHERE.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\n +Upstairs in Royal Oak Mall, above Whitcoulls\\. The lift is next to Whitcoulls\\. On weekends the lift runs during mall hours, 10am to 5pm\\.\\n`));
  assert.match(m.text, /On your tab: +\$15, paid at the counter on the day\n/);
  // round 29's head-start card: a member's reminder carries their card, Gobgob's 2 included
  assert.match(m.text, /Loyalty card: +2 of 12 so far\. Stamps land when you check in\.\n/);
  assert.equal(linkIn(m, 'Add to my calendar'), `https://lair.example.com/ics/b/${ria.id}.ics`);
  assert.ok(m.html.includes(`href="https://lair.example.com/ics/b/${ria.id}.ics"`), 'the button is the calendar file');
  assert.equal(linkIn(m, 'Google Calendar'), `https://calendar.google.com/calendar/render?${new URLSearchParams({
    action: 'TEMPLATE', text: 'Candlekeep Mysteries at Dice Goblin', dates: '20261108T050000Z/20261108T090000Z', details: `See it in My Lair: ${MY_LAIR}`, location: WHERE, ctz: TZ,
  })}`);
  assert.equal(linkIn(m, 'See it in My Lair'), `${MY_LAIR}?view=ml-st-${ria.ref}`);
  const key = row(ria.id).cancel_key;
  assert.match(key, /^[0-9a-f]{32}$/, 'a random key, made when the reminder was claimed');
  assert.equal(linkIn(m, 'Cancel my seat'), `${MY_LAIR}?cancel=${ria.ref}&key=${key}`);
  assert.match(m.text, /\n\nCan't make it\? Cancel free until 6pm Saturday and your seat goes back on the board for someone else\. After that, the \$15 stays on your tab\.\n\nSee you at the Lair!\nGobgob, the Dice Goblin\n/);
});

test('round 29: a seat\'s players: "Your GM and 1 player", "Your GM is counting on you", and a party of 2 is "Your 2 seats"', async () => {
  const g = await game();
  await seat(g.id, RIA, 'Ria Moana');
  await seat(g.id, '', 'Sam Jones', { people: 2, players: [{ name: 'Sam Jones' }, { name: 'Jo Smith' }] });
  const lonely = await game({ title: 'Wildsea', system: 'The Wildsea', tables: ['T9'] });
  await seat(lonely.id, LEO, 'Leo Park');
  await runAt(at(FRI, 9));
  assert.match(only('ria@example.com').text, /Your seat at Candlekeep Mysteries is saved\. Your GM and 2 players are counting on you\./);
  assert.match(only('sam@example.com').text, /Your 2 seats at Candlekeep Mysteries are saved\. Your GM and 1 player are counting on you\./);
  assert.match(only('sam@example.com').text, /Cancel my seats: /);
  assert.match(only('sam@example.com').text, /your seats go back on the board for someone else/);
  assert.match(only('leo@example.com').text, /Your seat at Wildsea is saved\. Your GM is counting on you\./);
  assert.match(only('leo@example.com').text, /Game: +Wildsea, The Wildsea\n/);
});

test('round 29: a seat the GM pays for: nothing on their tab, and after the deadline the full price is theirs if they don\'t come', async () => {
  const g = await game();
  const kais = await seat(g.id, KAI, 'Kai Tane');
  ok(await call('POST', `games/${g.id}/players/${encodeURIComponent(kais.ref)}/cover`, {}, GM));
  await runAt(at(FRI, 9));
  const m = only('kai@example.com');
  assert.match(m.text, /On your tab: +Nothing: your GM's paying for your seat\n/);
  assert.match(m.text, /Can't make it\? Cancel free until 6pm Saturday and your seat goes back on the board for someone else\. After that, if you can't come, the full \$15 goes on your tab\./);
  assert.ok(linkIn(m, 'Cancel my seat'));
});

test('round 29: a free seat (nothing to pay, nothing locks): cancel in My Lair any time before it starts', async () => {
  const g = await game({ title: 'Monster of the Week', system: 'Monster of the Week' });
  ok(await call('POST', `games/${g.id}/free`, { free: true }, OWNER));
  await seat(g.id, LEO, 'Leo Park');
  await runAt(at(FRI, 9));
  const m = only('leo@example.com');
  assert.match(m.text, /Game: +Monster of the Week\n/, 'a game named for its system says it once');
  assert.match(m.text, /On your tab: +Nothing to pay\n/);
  assert.match(m.text, /\n\nCan't make it\? Cancel in My Lair and your seat goes back on the board for someone else\.\n\n/);
  assert.doesNotMatch(m.text, /Cancel free until/);
  assert.equal(preheader(m), 'Your seat at Monster of the Week is saved. Sunday 8 November, 6pm to 10pm.');
  assert.ok(linkIn(m, 'Cancel my seat'), 'it can still be cancelled online');
});

test('round 29: a member\'s table and a guest\'s: "Your table for 4 is saved."; the guest\'s has no My Lair link, its own cancel link and "yours to pay", with no reply-or-call line', async () => {
  const kais = await table(KAI, 'Kai Tane');
  const sams = await table('', 'Sam Jones', { tables: ['T4'], people: 2, start: at(SUN, 14), end: at(SUN, 16) });
  await runAt(at(FRI, 9));
  const k = only('kai@example.com');
  assert.equal(k.subject, 'See you Sunday at 2pm?');
  assert.equal(preheader(k), 'Your table for 4 is saved. Cancel free until 2pm Saturday.');
  assert.match(k.text, /^SEE YOU SUNDAY, KAI\?\n\nYour table for 4 is saved\.\n\n/);
  assert.match(k.text, /When: +Sunday 8 November, 2pm to 5pm\n/);
  assert.match(k.text, /Table: +T3\n/);
  assert.match(k.text, /On your tab: +\$40, paid at the counter on the day\n/);
  assert.equal(linkIn(k, 'Add to my calendar'), `https://lair.example.com/ics/b/${kais.id}.ics`);
  assert.equal(linkIn(k, 'See it in My Lair'), `${MY_LAIR}?view=ml-bk-${kais.ref}`);
  assert.equal(linkIn(k, 'Cancel my table'), `${MY_LAIR}?cancel=${kais.ref}&key=${row(kais.id).cancel_key}`);
  assert.match(k.text, /Can't make it\? Cancel free until 2pm Saturday and your table goes back for someone else\. After that, the \$40 stays on your tab\./);
  assert.match(new URL(linkIn(k, 'Google Calendar')).searchParams.get('text'), /^Table for 4 at Dice Goblin$/);

  const s = only('sam@example.com');
  assert.match(s.text, /^SEE YOU SUNDAY, SAM\?\n\nYour table for 2 is saved\.\n\n/);
  assert.match(s.text, /On your tab: +\$20, paid at the counter on the day\n/);
  assert.equal(linkIn(s, 'See it in My Lair'), null, 'no account, so no My Lair');
  assert.equal(linkIn(s, 'Cancel my table'), `${MY_LAIR}?cancel=${sams.ref}&key=${row(sams.id).cancel_key}`);
  assert.match(s.text, /\n\nCan't make it\? Cancel free until 2pm Saturday and your table goes back for someone else\. After that it's yours to pay, even if you can't come\.\n\n/);
  assert.doesNotMatch(s.text, /reply to this email|give us a call/i);
  assert.doesNotMatch(s.text, /Loyalty card/, 'a guest has no card, so no card row');
});

test('round 29: a table at an event says which, and a booking with no name is "See you Sunday?"', async () => {
  ok(await call('POST', `events/${encodeURIComponent(`warhammer@${SUN}`)}/reserve`, { name: 'Kai Tane', email: 'kai@example.com', phone: MOBILE, people: 2 }, KAI));
  const nameless = await table(MIA, 'Mia Chen', { tables: ['T5'], people: 3 });
  lair.sql.exec("UPDATE bookings SET name = '' WHERE id = ?", nameless.id);
  await runAt(at(FRI, 9));
  const k = only('kai@example.com');
  assert.match(k.text, /Your table for 2 at Warhammer night is saved\./);
  assert.match(k.text, /Event: +Warhammer night\n/);
  assert.match(k.text, /Tables: +T14, T15\n/);
  assert.equal(new URL(linkIn(k, 'Google Calendar')).searchParams.get('text'), 'Warhammer night at Dice Goblin');
  const m = only('mia@example.com');
  assert.match(m.text, /^SEE YOU SUNDAY\?\n\nYour table for 3 is saved\./);
});

test('round 29: event sign-ups: "Your 3 places at …", "Your place at Oddity Alley is saved.", the event\'s calendar file and the sign-up\'s cancel link', async () => {
  const rias = await signUp(RIA, 'Ria Moana', `clocktower@${SUN}`, { people: 3 });
  const leos = await signUp(LEO, 'Leo Park', `alley@${SAT}`);
  await runAt(at(THU, 9));
  const l = only('leo@example.com');
  assert.equal(l.subject, 'See you Saturday at 10am?');
  assert.match(l.text, /^SEE YOU SATURDAY, LEO\?\n\nYour place at Oddity Alley is saved\.\n\n/);
  assert.match(l.text, /When: +Saturday 7 November, 10am to 3pm\n/);
  assert.match(l.text, /Event: +Oddity Alley\n/);
  assert.match(l.text, /Entry: +Free entry\n/);
  assert.equal(linkIn(l, 'Add to my calendar'), `https://lair.example.com/ics/alley%40${SAT}.ics`);
  assert.equal(linkIn(l, 'See it in My Lair'), `${MY_LAIR}?view=ml-ej-${leos.ref}`);
  assert.equal(linkIn(l, 'Cancel my sign-up'), `${MY_LAIR}?cancel=${leos.ref}&key=${joinRow(leos.id).cancel_key}`);
  assert.match(l.text, /\n\nCan't make it\? Cancel in My Lair and your place goes to someone else\.\n\n/);
  await runAt(at(FRI, 9));
  const r = only('ria@example.com');
  assert.equal(r.subject, 'See you Sunday at midday?');
  assert.match(r.text, /Your 3 places at Blood on the Clocktower are saved\./);
  assert.match(r.text, /On your tab: +\$30, paid at the counter on the day\n/);
  assert.match(r.text, /Coming: +Ria Moana, 2 friends\n/);
  assert.equal(linkIn(r, 'Cancel my sign-up'), `${MY_LAIR}?cancel=${rias.ref}&key=${joinRow(rias.id).cancel_key}`);
  assert.match(r.text, /Can't make it\? Cancel free until midday Saturday and your places go to someone else\. After that, the \$30 stays on your tab\./);
});

test('round 29: already locked when it goes (a cut-off over 48 hours): the tab\'s locked-in words, and no cancel link; paid already, or online before round 15, keeps what that means', async () => {
  const g = await game();
  await seat(g.id, RIA, 'Ria Moana');
  await table('', 'Sam Jones', { people: 2 });
  lair.rulesCache = rulesWith({ lair_refund_hours: 72 });
  await runAt(at(FRI, 9));
  const r = only('ria@example.com');
  assert.ok(r.text.includes(TAB_WORDS.lockedNow(72)));
  assert.equal(linkIn(r, 'Cancel my seat'), null);
  assert.equal(preheader(r), 'Your seat at Candlekeep Mysteries is saved. Sunday 8 November, 6pm to 10pm.');
  const s = only('sam@example.com');
  assert.ok(s.text.includes(TAB_WORDS.lockedNowGuest(72)));
  assert.equal(linkIn(s, 'Cancel my table'), null);

  // paid at the counter already (paying for a few at once): they'd get it back if they cancel in time
  lair.rulesCache = rulesWith();
  const mias = await seat(g.id, MIA, 'Mia Chen');
  ok(await call('POST', `bookings/${mias.id}/update`, { paid: true }, OWNER));
  lair.sql.exec('UPDATE bookings SET created_at = ? WHERE id = ?', NOW, mias.id);
  // and a sign-up paid online before round 15: locked in, staff decide on a refund (its confirmation's words)
  const leos = await signUp(LEO, 'Leo Park', `clocktower@${SUN}`);
  lair.sql.exec("UPDATE event_joins SET pay = 'now', paid = 1, paid_amount = amount, created_at = ? WHERE id = ?", NOW - 30 * 24 * HOUR, leos.id);
  await runAt(at(FRI, 10));
  const m = only('mia@example.com');
  assert.match(m.text, /On your tab: +\$15, paid already\. Thank you!\n/);
  assert.match(m.text, /Can't make it\? Cancel free until 6pm Saturday and your seat goes back on the board for someone else, and you'll get your \$15 back\. After that it stays paid, even if you can't come\./);
  const l = only('leo@example.com');
  assert.match(l.text, /On your tab: +\$10, paid online\. Thank you!\n/);
  assert.ok(l.text.includes("You paid online, so you're locked in. Can't make it after all? Cancel in My Lair and have a chat with us about a refund."));
});

/* ---------------- the calendar file ---------------- */

test('round 29: GET /ics/b/<booking id>.ics: the seat or table as a calendar file (title, times, place, a My Lair link, one UID), never a name, email, phone or code; 404 for anything else', async () => {
  const g = await game();
  const ria = await seat(g.id, RIA, 'Ria Moana');
  const kais = await table(KAI, 'Kai Tane');
  const env = { LAIR: { idFromName: () => 'id', get: () => ({ fetch: (req) => lair.fetch(req) }) } };
  const get = async (path) => {
    const res = await worker.fetch(new Request(`https://lair.example.com${path}`), env);
    return { status: res.status, type: res.headers.get('Content-Type') || '', disposition: res.headers.get('Content-Disposition') || '', text: await res.text() };
  };
  const seatIcs = await get(`/ics/b/${ria.id}.ics`);
  assert.equal(seatIcs.status, 200);
  assert.match(seatIcs.type, /^text\/calendar/);
  assert.equal(seatIcs.disposition, 'attachment; filename="dice-goblin-candlekeep-mysteries.ics"');
  const ics = seatIcs.text.replace(/\r\n /g, '');
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, new RegExp(`\r\nUID:${ria.id}@dicegoblin\\.nz\r\n`));
  assert.match(ics, /\r\nDTSTART:20261108T050000Z\r\nDTEND:20261108T090000Z\r\n/);
  assert.match(ics, /\r\nSUMMARY:Candlekeep Mysteries at Dice Goblin\r\n/);
  assert.match(ics, /\r\nLOCATION:Dice Goblin\\, 56\/691 Manukau Road\\, Royal Oak\\, Auckland 1023\r\n/);
  assert.match(ics, /\r\nDESCRIPTION:See it in My Lair: https:\/\/www\.dicegoblin\.nz\/pages\/my-lair\r\n/);
  assert.match(ics, /\r\nURL:https:\/\/www\.dicegoblin\.nz\/pages\/my-lair\r\n/);
  for (const secret of ['Ria', 'ria@', '021', ria.ref, 'Ellie', 'ellie@']) assert.ok(!ics.includes(secret), `no ${secret} in it`);
  const tableIcs = (await get(`/ics/b/${kais.id}.ics`)).text.replace(/\r\n /g, '');
  assert.match(tableIcs, /\r\nSUMMARY:Table for 4 at Dice Goblin\r\n/);
  assert.match(tableIcs, /\r\nDTSTART:20261108T010000Z\r\nDTEND:20261108T040000Z\r\n/);
  // a moved booking's file says its new time (same UID)
  nowIs(at(MON, 15));
  ok(await call('POST', `games/${g.id}/edit`, { start: at(SUN, 19), end: at(SUN, 22) }, OWNER));
  const moved = (await get(`/ics/b/${ria.id}.ics`)).text.replace(/\r\n /g, '');
  assert.match(moved, /\r\nDTSTART:20261108T060000Z\r\n/);
  assert.match(moved, new RegExp(`\r\nUID:${ria.id}@dicegoblin\\.nz\r\n`));

  // 404: unknown, a code instead of the id, cancelled, and bookings that never get a reminder
  const weekly = await game({ title: 'Curse of Strahd', schedule: 'weekly', tables: ['T13'] });
  const saved = ok(await call('POST', `games/${weekly.id}/join-series`, { people: 1, name: 'Mia Chen', email: 'mia@example.com', phone: MOBILE }, MIA));
  const savedSeat = lair.booking(saved.booked[0].ref);
  const gmOwn = lair.sql.exec("SELECT id FROM bookings WHERE kind = 'gm' AND game_id = ?", g.id).one().id;
  lair.saveBooking({ id: 'bk_0123456789abcdef', ref: 'WALK-IN-1', kind: 'walkin', status: 'seated', tables: ['T6'], start: at(SUN, 14), end: at(SUN, 16), people: 2, name: 'Pat', amount: 2000 }, NOW);
  ok(await call('POST', `bookings/${kais.id}/update`, { status: 'cancelled' }, KAI));
  for (const id of ['bk_ffffffffffffffff', kais.id, savedSeat.id, gmOwn, 'bk_0123456789abcdef']) {
    const res = await get(`/ics/b/${id}.ics`);
    assert.equal(res.status, 404, id);
    assert.equal(res.text, 'That booking could not be found.');
  }
  assert.equal((await get(`/ics/b/${encodeURIComponent(ria.ref)}.ics`)).status, 404, 'a booking code never finds it');
  assert.equal((await call('GET', `internal/bookingics/${ria.id}`)).status, 404, 'only the Worker itself reaches the internal route');
});

/* ---------------- the cancel link: one tap, no login ---------------- */

test('round 29: the cancel link\'s view: only what it is, when, for how many, whether it can be cancelled now and until when; no name, email, phone or code', async () => {
  const g = await game();
  await seat(g.id, RIA, 'Ria Moana');
  await table('', 'Sam Jones', { people: 2 });
  await signUp(LEO, 'Leo Park', `clocktower@${SUN}`, { people: 2 });
  await runAt(at(FRI, 9));
  nowIs(at(FRI, 12));
  assert.deepEqual(ok(await view(keyOf(only('ria@example.com')))), {
    link: { kind: 'seat', title: 'Candlekeep Mysteries', when: 'Sunday 8 November, 6pm', people: 1, cancellable: true, until: '6pm Saturday', reason: null },
  });
  assert.deepEqual(ok(await view(keyOf(only('sam@example.com')))), {
    link: { kind: 'table', title: null, when: 'Sunday 8 November, 2pm', people: 2, cancellable: true, until: '2pm Saturday', reason: null },
  });
  assert.deepEqual(ok(await view(keyOf(only('leo@example.com')))), {
    link: { kind: 'signup', title: 'Blood on the Clocktower', when: 'Sunday 8 November, midday', people: 2, cancellable: true, until: 'midday Saturday', reason: null },
  });
});

test('round 29: the cancel link cancels while it\'s free, logged in or not, by the same path as cancelling in My Lair: the seat\'s back on the board and the GM hears', async () => {
  const g = await game();
  const ria = await seat(g.id, RIA, 'Ria Moana');
  const mias = await seat(g.id, MIA, 'Mia Chen');
  await runAt(at(FRI, 9));
  nowIs(at(FRI, 12));
  const before = mail.sent.length;
  const done = ok(await cancelBy(keyOf(only('ria@example.com'))));
  assert.deepEqual(done, { ok: true, kind: 'seat', people: 1, refund: null, notice: null });
  assert.equal(row(ria.id).status, 'cancelled');
  await settle();
  const dropped = mail.sent.slice(before).filter((x) => x.to === 'ellie@example.com');
  assert.deepEqual(dropped.map((x) => x.subject), [`Seat dropped: Candlekeep Mysteries, ${lair.when(lair.game(g.id), lair.rulesCache)}`]);
  assert.match(dropped[0].text, /Ria Moana dropped their seat at Candlekeep Mysteries\. The spot's back on the games board for someone else\./);
  assert.equal(lair.takenSeats(g.id), 1, 'one seat left taken: Mia\'s');
  // Mia cancels hers in My Lair: the same answer underneath, and the same email to the GM
  const own = ok(await call('POST', `bookings/${mias.id}/update`, { status: 'cancelled' }, MIA));
  assert.equal(own.booking.status, 'cancelled');
  await settle();
  assert.equal(mail.sent.slice(before).filter((x) => x.to === 'ellie@example.com' && /^Seat dropped/.test(x.subject)).length, 2);
  // again: cancelled already, nothing changes
  assert.equal(said(await cancelBy(keyOf(only('ria@example.com')))), `409 ${CANCEL_LINK_WORDS.cancelled}`);
  assert.deepEqual(ok(await view(keyOf(only('ria@example.com')))).link, { kind: 'seat', title: 'Candlekeep Mysteries', when: 'Sunday 8 November, 6pm', people: 1, cancellable: false, until: null, reason: CANCEL_LINK_WORDS.cancelled });
});

test('round 29: a guest\'s table and a sign-up cancel by their links too; one paid ahead at the counter is flagged for a refund and staff hear, as cancelling in My Lair does', async () => {
  const sams = await table('', 'Sam Jones', { people: 2 });
  const leos = await signUp(LEO, 'Leo Park', `clocktower@${SUN}`, { people: 2 });
  const kais = await table(KAI, 'Kai Tane', { tables: ['T5'] });
  ok(await call('POST', `bookings/${kais.id}/update`, { paid: true }, OWNER));
  await runAt(at(FRI, 9));
  nowIs(at(FRI, 12));
  assert.deepEqual(ok(await cancelBy(keyOf(only('sam@example.com')))), { ok: true, kind: 'table', people: 2, refund: null, notice: null });
  assert.equal(row(sams.id).status, 'cancelled');
  assert.deepEqual(ok(await cancelBy(keyOf(only('leo@example.com')))), { ok: true, kind: 'signup', people: 2, refund: null, notice: null });
  assert.equal(joinRow(leos.id).status, 'cancelled');
  assert.equal(lair.placesTaken(`clocktower@${SUN}`), 0, 'the places are free again');
  const before = mail.sent.length;
  assert.deepEqual(ok(await cancelBy(keyOf(only('kai@example.com')))), { ok: true, kind: 'table', people: 4, refund: { due: true, amount: 4000 }, notice: null });
  assert.equal(row(kais.id).refund, 'due');
  await settle();
  assert.deepEqual(mail.sent.slice(before).filter((x) => x.to === 'staff@dicegoblin.test').map((x) => x.subject), [`Refund due: ${kais.ref}`]);
});

test('round 29: the cancel link refuses with nothing changed: a wrong key, another booking\'s key or a code that isn\'t one (one plain message), and locked, started or cancelled in the existing words', async () => {
  const g = await game();
  const ria = await seat(g.id, RIA, 'Ria Moana');
  const kais = await seat(g.id, KAI, 'Kai Tane');
  ok(await call('POST', `games/${g.id}/players/${encodeURIComponent(kais.ref)}/cover`, {}, GM));
  const leos = await signUp(LEO, 'Leo Park', `clocktower@${SUN}`);
  await runAt(at(FRI, 9));
  const r = keyOf(only('ria@example.com'));
  const k = keyOf(only('kai@example.com'));
  const l = keyOf(only('leo@example.com'));
  nowIs(at(FRI, 12));
  const wrong = `404 ${CANCEL_LINK_WORDS.wrong}`;
  // (each from its own address: wrong tries from one place are limited, the next test)
  for (const [i, body] of [{ ref: r.ref, key: 'f'.repeat(32) }, { ref: r.ref, key: k.key }, { ref: 'NO-SUCHCODE-1', key: r.key }, { ref: r.ref }, { key: r.key }, {}].entries()) {
    assert.equal(said(await cancelBy(body, `192.0.2.${i}`)), wrong, JSON.stringify(body));
    assert.equal(said(await view(body, `192.0.2.${i}`)), wrong, JSON.stringify(body));
  }
  assert.equal(row(ria.id).status, 'confirmed');
  // the key only ever cancels: it isn't a way into anything else
  assert.equal(said(await call('POST', `bookings/${ria.id}/update`, { status: 'cancelled', key: r.key })), "403 Only staff can change that booking.");
  // locked in: 24 hours before (the GM's seat in the GM's words), and once it's started
  nowIs(at(SAT, 19));
  assert.equal(said(await cancelBy(r)), `409 ${TAB_WORDS.locked(24)}`);
  assert.deepEqual(ok(await view(r)).link, { kind: 'seat', title: 'Candlekeep Mysteries', when: 'Sunday 8 November, 6pm', people: 1, cancellable: false, until: null, reason: TAB_WORDS.locked(24) });
  assert.equal(said(await cancelBy(k)), `409 ${GM_COVER_WORDS.seatLocked(24)}`);
  assert.equal(said(await cancelBy(l)), `409 ${TAB_WORDS.locked(24)}`);
  nowIs(at(SUN, 18, 30));
  assert.equal(said(await cancelBy(r)), `409 ${TAB_WORDS.started}`);
  assert.equal(ok(await view(r)).link.reason, TAB_WORDS.started);
  assert.deepEqual([row(ria.id).status, row(kais.id).status, joinRow(leos.id).status], ['confirmed', 'confirmed', 'confirmed']);
});

test('round 29: wrong tries from one place are limited (10 in 10 minutes), so a key can\'t be guessed', async () => {
  const g = await game();
  await seat(g.id, RIA, 'Ria Moana');
  await runAt(at(FRI, 9));
  const r = keyOf(only('ria@example.com'));
  nowIs(at(FRI, 12));
  for (let i = 0; i < 10; i += 1) assert.equal((await view({ ref: r.ref, key: `${i}`.repeat(32) }, '198.51.100.7')).status, 404);
  assert.equal(said(await view(r, '198.51.100.7')), `429 ${CANCEL_LINK_WORDS.tooMany}`);
  assert.equal((await view(r, '203.0.113.50')).status, 200, 'somewhere else is fine');
  nowIs(at(FRI, 12, 11));
  assert.equal((await view(r, '198.51.100.7')).status, 200, 'and 10 minutes later, there too');
});

test('round 29: one cancel key per booking, made when its reminder is claimed and kept across runs (Resend down, then up)', async () => {
  const g = await game();
  const ria = await seat(g.id, RIA, 'Ria Moana');
  assert.equal(row(ria.id).cancel_key, null, 'no key until a reminder is claimed');
  mail.fail(503);
  await runAt(at(FRI, 9));
  const key = row(ria.id).cancel_key;
  assert.match(key, /^[0-9a-f]{32}$/);
  mail.fail(0);
  await runAt(at(FRI, 9, 10));
  assert.equal(row(ria.id).cancel_key, key);
  assert.equal(keyOf(only('ria@example.com')).key, key);
  const mias = await seat(g.id, MIA, 'Mia Chen');
  lair.sql.exec('UPDATE bookings SET created_at = ? WHERE id = ?', NOW, mias.id);
  await runAt(at(FRI, 10));
  assert.notEqual(row(mias.id).cancel_key, key, 'each booking its own');
});

/* ---------------- the Monday numbers ---------------- */

test('round 29: Monday\'s weekly numbers: booking reminders sent last week, and no-shows on one-off bookings (TTRPG seats, tables, sign-ups), weekly saved seats left out', async () => {
  const g = await game();
  const ria = await seat(g.id, RIA, 'Ria Moana');
  const sams = await seat(g.id, '', 'Sam Jones');
  const kais = await table(KAI, 'Kai Tane');
  const mias = await table(MIA, 'Mia Chen', { tables: ['T5'], people: 2 });
  const leos = await signUp(LEO, 'Leo Park', `clocktower@${SUN}`);
  await signUp(RIA, 'Ria Moana', `clocktower@${SUN}`, { email: 'ria.again@example.com' });
  const weekly = await game({ title: 'Curse of Strahd', schedule: 'weekly', tables: ['T13'] });
  const saved = ok(await call('POST', `games/${weekly.id}/join-series`, { people: 1, name: 'Mia Chen', email: 'mia@example.com', phone: MOBILE }, MIA));
  await runAt(at(FRI, 9));
  assert.equal(reminders().length, 6);
  // the weekend: Ria and Kai's table didn't come (marked no-show), Sam and Mia came (checked in), Leo's sign-up was
  // checked in, Ria's sign-up wasn't (and wasn't paid), and Mia's weekly saved seat was a no-show (left out)
  nowIs(at(SUN, 23));
  for (const [id, status] of [[ria.id, 'noshow'], [kais.id, 'noshow'], [sams.id, 'done'], [mias.id, 'done'], [lair.booking(saved.booked[0].ref).id, 'noshow']]) {
    ok(await call('POST', `bookings/${id}/update`, { status }, OWNER));
  }
  ok(await call('POST', `bookings/${leos.id}/update`, { status: 'attended' }, OWNER));
  const report = lair.reportFor(lair.rulesCache, at('2026-11-09', 9), 2);
  const [, last, before] = report.weeks;
  assert.equal(last.week, MON);
  assert.deepEqual(last.bookingReminders, { sent: 6 });
  assert.deepEqual(last.oneOff, { bookings: 6, noShows: 3, seats: 1, tables: 1, signUps: 1 });
  const lines = Object.fromEntries(lair.weeklyReportContent(last, before, report).body.details);
  assert.equal(lines['Booking reminders sent'], '6 (0 the week before)');
  assert.equal(lines['No-shows on one-off bookings'], '3 of 6, 50% (no one-off bookings the week before): 1 TTRPG seat, 1 table, 1 event sign-up not checked in or paid');
  // the next week, compared with this one
  const next = lair.reportFor(lair.rulesCache, at('2026-11-16', 9), 2);
  const nextLines = Object.fromEntries(lair.weeklyReportContent(next.weeks[1], next.weeks[2], next).body.details);
  assert.equal(nextLines['Booking reminders sent'], '0 (6 the week before)');
  assert.equal(nextLines['No-shows on one-off bookings'], 'No one-off bookings (50% the week before)');
});

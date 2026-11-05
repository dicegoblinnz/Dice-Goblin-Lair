// Round 29, roleplayers phase 1, item 3: "Your first game" for beginners (contract v29-roleplayers section 3). Mo approved
// it on 2 Nov 2026 from mockups A (the front door), B (the join sheet and "You're in") and D3 (the email the day after).
// The Lair's part: GET /me says whether a member has had a TTRPG seat at the Lair (the front door hides for them), a seat
// keeps the answer to "Is this your first roleplaying game?" (first_game, never new_player) and the consent to the email
// the day after (the box starts unticked: New Zealand's Unsolicited Electronic Messages Act 2007 makes that email
// marketing), the GM's email says it's their first game, the counter shows "First game" on that seat, the email goes the
// day after a first game they came to (once, 9am to 9pm, never after they've booked again, saved a weekly seat or
// unsubscribed), its unsubscribe works without logging in (a tap, and the one-click header), and Monday's numbers say
// whether first-timers come back. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import worker from '../src/index.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { CANCEL_LINK_WORDS } from '../src/booking-reminders.js';
import { FIRST_GAME_WORDS, UNSUBSCRIBE_WORDS } from '../src/first-game.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// The week of Monday 2 November 2026 (NZDT, UTC+13): seats are booked on Monday for Sunday's games, and the email goes the
// Monday after (9 November)
const MON = '2026-11-02';
const THU = '2026-11-05';
const FRI = '2026-11-06';
const SAT = '2026-11-07';
const SUN = '2026-11-08';
const MON2 = '2026-11-09';
const TUE2 = '2026-11-10';
const WED2 = '2026-11-11';
const THU2 = '2026-11-12';
const FRI2 = '2026-11-13';
const SAT2 = '2026-11-14';
const SUN2 = '2026-11-15';
const TUE3 = '2026-11-17';
const NOW = at(MON, 13);
const realNow = Date.now;
const realFetch = globalThis.fetch;
const nowIs = (ms) => {
  Date.now = () => ms;
};
const ADDRESS = '56/691 Manukau Road, Royal Oak, Auckland 1023';
const GM_PAGE = 'https://www.dicegoblin.nz/pages/gm-games';
const MY_LAIR = 'https://www.dicegoblin.nz/pages/my-lair';

/* ---------------- helpers, as in test/round28-booked.test.js and test/round29-reminders.test.js ---------------- */
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
const SETTINGS = { lair_hours: DEFAULT_HOURS, lair_shop_tables: '', store_phone: '021 159 6894' };
const rulesWith = (more = {}) => rulesFromSettings({ ...SETTINGS, ...more }, ROOMS, [], { address: ADDRESS });
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
const internal = (path, body) => call('POST', `internal/${path}`, body, '', { 'X-Lair-Internal': '1', 'X-Lair-Pos-User': 'Counter' });
/** The 10-minute run's next-day emails at a fixed time (POST /internal/next-day { at }, the live checks' clock) */
const runAt = async (ms) => ok(await internal('next-day', { at: ms }));
const settle = () => new Promise((r) => setTimeout(r, 10));

/** Every email, as Resend got it (headers too); fail(status) makes Resend answer that until fail(0) */
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
/** The next-day emails that went, to one address or all */
const nextDays = (to = null) => mail.sent.filter((m) => /^How was your first game/.test(m.subject) && (!to || m.to === to));
const only = (to) => {
  const list = nextDays(to);
  assert.equal(list.length, 1, `one next-day email to ${to}, got ${list.length}`);
  return list[0];
};
/** The hidden line email apps show after the subject */
const preheader = (m) => (m.html.match(/<div style="display:none;[^"]*">([^<]*)<\/div>/) || [])[1]?.replace(/&#39;/g, "'").replace(/&amp;/g, '&');
/** A link's address in the plain text ("Save my seat every week: https://…") */
const linkIn = (m, label) => (m.text.match(new RegExp(`^${label}: (\\S+)$`, 'm')) || [])[1] || null;
/** The unsubscribe link's code and key, from the email's #unsubscribe=<code>.<key> */
const stopOf = (m) => {
  const url = new URL(linkIn(m, "Don't send me emails like this"));
  const value = decodeURIComponent(url.hash.replace(/^#unsubscribe=/, ''));
  const dot = value.lastIndexOf('.');
  return { ref: value.slice(0, dot), key: value.slice(dot + 1), url };
};
const stopView = (body, client = '203.0.113.9') => call('POST', 'unsubscribe/view', body, '', { 'X-Lair-Client': client });
const stopNow = (body, client = '203.0.113.9') => call('POST', 'unsubscribe/stop', body, '', { 'X-Lair-Client': client });

/* ---------------- what's booked ---------------- */
/** A TTRPG session Ellie lists (a trusted GM: straight on the board): Candlekeep Mysteries, weekly on Sunday, 6pm to 10pm, $15 a seat */
async function game(more = {}) {
  return ok(await call('POST', 'games', {
    title: 'Candlekeep Mysteries', system: 'D&D 5e', gm: 'Ellie', email: 'ellie@example.com', blurb: 'A library full of secrets.', seats: 4,
    tables: ['T12'], start: at(SUN, 18), end: at(SUN, 22), schedule: 'weekly', characters: 'pregens', ...more,
  }, GM)).game;
}
const emailOf = (name) => `${name.split(' ')[0].toLowerCase()}@example.com`;
/** A seat at a session, booked online by a member (who) or a guest (who '') → the whole answer */
async function join(gameId, who, name, more = {}) {
  return ok(await call('POST', 'bookings', { kind: 'gm-seat', gameId, people: 1, name, email: emailOf(name), phone: MOBILE, ...more }, who));
}
async function seat(gameId, who, name, more = {}) {
  return (await join(gameId, who, name, more)).booking;
}
const row = (id) => lair.sql.exec('SELECT * FROM bookings WHERE id = ?', id).toArray()[0];
/** The counter checks them in at the session (the POS, 5 minutes after it starts) */
async function checkIn(booking, start = booking.start) {
  nowIs(start + 5 * 60_000);
  ok(await internal('pos/checkin', { id: booking.id, type: 'booking' }));
  assert.equal(row(booking.id).status, 'seated');
}
/** The next session of a weekly game, after `game` */
const nextOf = (g) => lair.sql.exec('SELECT id, starts_at FROM games WHERE series_id = ? AND starts_at > ? ORDER BY starts_at LIMIT 1', g.seriesId, g.start).one();
/** Ria's first game: her seat at Candlekeep Mysteries with "Yes, my first" and the box ticked, checked in on Sunday */
async function riasFirstGame(more = {}) {
  const g = await game(more.game || {});
  nowIs(NOW);
  const s = await seat(g.id, RIA, 'Ria Moana', { firstGame: true, followUp: true, ...(more.seat || {}) });
  await checkIn(s);
  return { g, s };
}

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
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  for (const [id, name] of [[OWNER, 'Mo Ashgrove'], [GM, 'Ellie Rua'], [MIA, 'Mia Chen'], [KAI, 'Kai Tane'], [RIA, 'Ria Moana'], [LEO, 'Leo Park']]) {
    lair.makeMember({ customerId: id, name, email: emailOf(name) }, NOW);
  }
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(mail.reached, [], 'nothing but Resend was reached');
});

/* ---------------- on start ---------------- */

test('round 29, first game: the columns are made on start (first_game, the consent and its time, when the email went and its key) and so is the stop list', () => {
  const columns = lair.sql.exec("SELECT name FROM pragma_table_info('bookings')").toArray().map((c) => c.name);
  for (const column of ['first_game', 'followup_ok', 'followup_ok_at', 'followup_at', 'followup_key']) assert.ok(columns.includes(column), `bookings.${column}`);
  const stops = lair.sql.exec("SELECT name FROM pragma_table_info('followup_stops')").toArray().map((c) => c.name);
  assert.deepEqual(stops.sort(), ['at', 'email', 'ref', 'via']);
  // a second start changes nothing
  assert.doesNotThrow(() => lair.migrate());
});

/* ---------------- GET /me: has this member played? ---------------- */

test('round 29, first game: GET /me says ttrpgPlayed: false for a member with no TTRPG seat, or only one to come, a cancelled one, a no-show or a table', async () => {
  const me = async (who) => ok(await call('GET', 'me', null, who));
  assert.equal((await me(RIA)).ttrpgPlayed, false, 'never booked');
  const g = await game();
  await seat(g.id, RIA, 'Ria Moana');
  assert.equal((await me(RIA)).ttrpgPlayed, false, 'a seat still to come');
  // a seat she cancelled, one marked a no-show, and a table she was checked in at
  const lost = await game({ title: 'Lost Mine', schedule: 'one-shot', tables: ['T10'], start: at(SAT, 13), end: at(SAT, 16) });
  const gone = await seat(lost.id, KAI, 'Kai Tane');
  ok(await call('POST', `bookings/${gone.id}/update`, { status: 'cancelled' }, KAI));
  const missed = await seat(lost.id, LEO, 'Leo Park');
  nowIs(at(SAT, 14));
  ok(await call('POST', `bookings/${missed.id}/update`, { status: 'noshow' }, OWNER));
  nowIs(NOW);
  const kaiTable = ok(await call('POST', 'bookings', { kind: 'table', tables: ['T3'], start: at(SAT, 13), end: at(SAT, 15), people: 2, name: 'Mia Chen', email: 'mia@example.com', phone: MOBILE, pay: 'day' }, MIA)).booking;
  await checkIn(kaiTable);
  nowIs(at(SUN, 9));
  assert.equal((await me(KAI)).ttrpgPlayed, false, 'a cancelled seat');
  assert.equal((await me(LEO)).ttrpgPlayed, false, 'a no-show');
  assert.equal((await me(MIA)).ttrpgPlayed, false, 'a table, not a TTRPG seat');
});

test('round 29, first game: GET /me says ttrpgPlayed: true once a TTRPG seat of theirs was checked in, or paid in full once its day came (not before)', async () => {
  const me = async (who) => ok(await call('GET', 'me', null, who));
  const g = await game();
  const rias = await seat(g.id, RIA, 'Ria Moana');
  const kais = await seat(g.id, KAI, 'Kai Tane');
  // Kai pays for his at the counter on Monday, days ahead: paid, but its day hasn't come
  ok(await call('POST', `bookings/${kais.id}/update`, { paid: true }, OWNER));
  assert.equal(row(kais.id).paid, 1);
  assert.equal((await me(KAI)).ttrpgPlayed, false, 'paid ahead, before its day');
  nowIs(at(SUN, 9));
  assert.equal((await me(KAI)).ttrpgPlayed, true, 'paid in full, and its day has come');
  assert.equal((await me(RIA)).ttrpgPlayed, false, 'not checked in or paid yet');
  await checkIn(rias);
  assert.equal((await me(RIA)).ttrpgPlayed, true, 'checked in');
});

test('round 29, first game: ttrpgPlayed counts a guest seat with the member\'s verified account email too, from before guest seats are adopted', async () => {
  // Sam played as a guest months ago (checked in, 'done'), long before guest seats join an account by email
  lair.saveBooking({
    id: 'bk_samoldseat000001', ref: 'SJ-OLD-1', kind: 'gm-seat', status: 'done', tables: ['T12'], start: NOW - 200 * DAY, end: NOW - 200 * DAY + 4 * HOUR,
    people: 1, name: 'Sam Jones', email: 'Sam@Example.com', amount: 1500, gameId: 'gm_old', paid: true, paidAmount: 1500,
  }, NOW - 200 * DAY);
  const SAM = '6005';
  lair.makeMember({ customerId: SAM, name: 'Sam Jones', email: 'sam.other@example.com' }, NOW);
  lair.accountEmail = async () => ({ fetched: true, email: 'sam@example.com' });
  const me = ok(await call('GET', 'me', null, SAM));
  assert.equal(row('bk_samoldseat000001').customer_id, null, 'too old to be adopted');
  assert.equal(me.ttrpgPlayed, true);
});

/* ---------------- joining: the answer and the consent ---------------- */

test('round 29, first game: a TTRPG seat keeps the answer in first_game (1, 0 or null, never new_player) and the consent as 1 or 0 with its time, asked only after "Yes, my first"', async () => {
  const g = await game({ seats: 8, tables: ['T12', 'T13'] });
  const yesTicked = await seat(g.id, RIA, 'Ria Moana', { firstGame: true, followUp: true });
  const yesUnticked = await seat(g.id, KAI, 'Kai Tane', { firstGame: true });
  const yesFalse = await seat(g.id, MIA, 'Mia Chen', { firstGame: true, followUp: false });
  const played = await seat(g.id, LEO, 'Leo Park', { firstGame: false, followUp: true });
  const silent = await seat(g.id, '', 'Pat Doe');
  const pick = (id) => {
    const r = row(id);
    return [r.first_game, r.followup_ok, r.followup_ok_at, r.new_player];
  };
  assert.deepEqual(pick(yesTicked.id), [1, 1, NOW, 0]);
  assert.deepEqual(pick(yesUnticked.id), [1, 0, NOW, 0], 'the box left unticked is a no, with when');
  assert.deepEqual(pick(yesFalse.id), [1, 0, NOW, 0]);
  assert.deepEqual(pick(played.id), [0, null, null, 0], '"I\'ve played before": no consent asked, so none kept');
  assert.deepEqual(pick(silent.id), [null, null, null, 0], 'not answered (it\'s optional)');
});

test('round 29, first game: a guest\'s seat (no account) keeps the answer and the consent the same way', async () => {
  const g = await game();
  const guest = await seat(g.id, '', 'Sam Jones', { firstGame: true, followUp: true });
  assert.equal(row(guest.id).customer_id, null);
  assert.deepEqual([row(guest.id).first_game, row(guest.id).followup_ok], [1, 1]);
});

test('round 29, first game: anything but true or false is no answer, and a table booking ignores it', async () => {
  const g = await game({ seats: 8, tables: ['T12', 'T13'] });
  for (const [who, name, value] of [[RIA, 'Ria Moana', 'yes'], [KAI, 'Kai Tane', 1], [MIA, 'Mia Chen', null]]) {
    const s = await seat(g.id, who, name, { firstGame: value, followUp: true });
    assert.deepEqual([row(s.id).first_game, row(s.id).followup_ok], [null, null], JSON.stringify(value));
  }
  const t = ok(await call('POST', 'bookings', { kind: 'table', tables: ['T3'], start: at(SAT, 13), end: at(SAT, 15), people: 2, name: 'Leo Park', email: 'leo@example.com', phone: MOBILE, pay: 'day', firstGame: true, followUp: true }, LEO)).booking;
  assert.deepEqual([row(t.id).first_game, row(t.id).followup_ok], [null, null]);
});

test('round 29, first game: "Save my seat every week" marks the first seat it books; a full next session has no seat to mark', async () => {
  const g = await game();
  const joined = ok(await call('POST', `games/${g.id}/join-series`, { people: 1, name: 'Ria Moana', email: 'ria@example.com', phone: MOBILE, firstGame: true, followUp: true }, RIA));
  assert.equal(joined.booked.length, 1);
  const first = lair.sql.exec("SELECT * FROM bookings WHERE customer_id = ? AND kind = 'gm-seat'", RIA).toArray();
  assert.equal(first.length, 1);
  assert.deepEqual([first[0].first_game, first[0].followup_ok, first[0].followup_ok_at], [1, 1, NOW]);
  // a full one: Kai joins every week, but the next session has no seat, so nothing is marked anywhere
  const full = await game({ title: 'Tomb of Annihilation', seats: 2, tables: ['T13'] });
  await seat(full.id, MIA, 'Mia Chen');
  await seat(full.id, LEO, 'Leo Park');
  const waiting = ok(await call('POST', `games/${full.id}/join-series`, { people: 1, name: 'Kai Tane', email: 'kai@example.com', phone: MOBILE, firstGame: true, followUp: true }, KAI));
  assert.equal(waiting.booked.length, 0);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE customer_id = ? AND first_game IS NOT NULL", KAI).one().n, 0);
});

test('round 29, first game: a seat\'s answer says which weekday its two-day reminder goes (reminderDay), or nothing: booked on the reminder day or later, a weekly seat, reminders off, or no emails', async () => {
  const g = await game({ seats: 8, tables: ['T12', 'T13'] });
  // Monday for Sunday: Friday's reminder
  assert.equal((await join(g.id, RIA, 'Ria Moana', { firstGame: true })).reminderDay, 'Friday');
  // Thursday for Sunday still gets Friday's; on Friday itself it's booked on the reminder day, so it gets none
  nowIs(at(THU, 20));
  assert.equal((await join(g.id, KAI, 'Kai Tane')).reminderDay, 'Friday');
  nowIs(at(FRI, 10));
  assert.equal((await join(g.id, MIA, 'Mia Chen')).reminderDay, null);
  // a Saturday game booked on Wednesday: Thursday's
  nowIs(NOW);
  const sat = await game({ title: 'Lost Mine', schedule: 'one-shot', tables: ['T10'], start: at(SAT, 13), end: at(SAT, 16) });
  assert.equal((await join(sat.id, LEO, 'Leo Park')).reminderDay, 'Thursday');
  // a weekly saved seat gets no reminder, so "Save my seat every week" answers none
  const weekly = ok(await call('POST', `games/${g.id}/join-series`, { people: 1, name: 'Leo Park', email: 'leo@example.com', phone: MOBILE }, LEO));
  assert.equal(weekly.reminderDay ?? null, null);
  // reminders switched off in Theme settings, and emails not set up
  lair.rulesCache = rulesWith({ lair_booking_reminders: false });
  assert.equal((await join(sat.id, '', 'Sam Jones')).reminderDay, null);
  lair.rulesCache = rulesWith();
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: '' };
  assert.equal((await join(sat.id, '', 'Jo Bloggs')).reminderDay, null);
});

/* ---------------- the GM hears ---------------- */

test('round 29, first game: the GM\'s new-player email says "It\'s Ria\'s first roleplaying game." for a first game, and nothing for anyone else (a weekly join\'s first seat too)', async () => {
  const g = await game({ seats: 8, tables: ['T12', 'T13'] });
  await seat(g.id, RIA, 'Ria Moana', { firstGame: true });
  await seat(g.id, KAI, 'Kai Tane', { firstGame: false });
  await seat(g.id, '', 'Sam Jones');
  await settle();
  const toGm = (name) => mail.sent.find((m) => m.to === 'ellie@example.com' && m.subject.startsWith('New player for Candlekeep Mysteries') && m.subject.endsWith(name));
  assert.ok(toGm('Ria Moana').text.includes("It's Ria's first roleplaying game."), toGm('Ria Moana').text);
  assert.ok(toGm('Ria Moana').html.includes('It&#39;s Ria&#39;s first roleplaying game.'));
  for (const name of ['Kai Tane', 'Sam Jones']) assert.ok(!/first roleplaying game/.test(toGm(name).text), name);
  const weekly = await game({ title: 'Curse of Strahd', tables: ['T14'] });
  ok(await call('POST', `games/${weekly.id}/join-series`, { people: 1, name: 'Mia Chen', email: 'mia@example.com', phone: MOBILE, firstGame: true }, MIA));
  await settle();
  const mias = mail.sent.find((m) => m.to === 'ellie@example.com' && m.subject.startsWith('New player for Curse of Strahd'));
  assert.ok(mias.text.includes("It's Mia's first roleplaying game."));
});

/* ---------------- at the counter (staff only) ---------------- */

test('round 29, first game: staff only: the check-in card, the staff floor and the counter\'s Today and scan say firstGame: true on a first game\'s seat; never GET /me, the public floor or the GM\'s player list', async () => {
  const g = await game({ seats: 8, tables: ['T12', 'T13'], start: at(MON, 18), end: at(MON, 22) });
  const rias = await seat(g.id, RIA, 'Ria Moana', { firstGame: true, followUp: true });
  const kais = await seat(g.id, KAI, 'Kai Tane', { firstGame: false });
  // the counter's Today list
  const today = ok(await internal('pos/today', {}));
  const rows = today.groups.flatMap((x) => x.rows);
  assert.equal(rows.find((r) => r.id === rias.id).firstGame, true);
  assert.ok(!('firstGame' in rows.find((r) => r.id === kais.id)), 'nothing on anyone else\'s');
  // scanning her code at the counter, and the staff page's check-in
  assert.equal(ok(await internal('pos/scan', { code: rias.ref })).row.firstGame, true);
  const checked = ok(await call('POST', 'checkin', { code: rias.ref }, OWNER));
  assert.equal(checked.row.firstGame, true);
  // the staff floor's bookings
  const floor = ok(await call('GET', `floor?from=${NOW}&to=${NOW + DAY}`, null, OWNER));
  assert.equal(floor.bookings.find((b) => b.id === rias.id).firstGame, true);
  // never on customer pages: the public floor, her own My Lair, the GM's own player list
  const text = JSON.stringify([ok(await call('GET', `floor?from=${NOW}&to=${NOW + DAY}`, null, '')), ok(await call('GET', 'me', null, RIA)), ok(await call('GET', `floor?from=${NOW}&to=${NOW + DAY}`, null, GM)).games]);
  assert.ok(!/firstGame|first_game/.test(text), 'nothing about a first game outside the staff views');
});

/* ---------------- the email the day after ---------------- */

test('round 29, first game: the email goes the day after a first game that was checked in, from 9:00 (not 8:59) to before 21:00, and once', async () => {
  await riasFirstGame();
  assert.equal((await runAt(at(SUN, 21, 30))).sent, 0, 'the night of the game');
  assert.equal((await runAt(at(MON2, 8, 59))).sent, 0, '8:59 the day after: not yet');
  assert.equal((await runAt(at(MON2, 21))).sent, 0, '9pm: too late at night');
  const run = await runAt(at(MON2, 9));
  assert.deepEqual(run, { sent: 1, ok: true });
  assert.equal(only('ria@example.com').subject, 'How was your first game, Ria?');
  for (const t of [at(MON2, 9, 10), at(MON2, 20, 50), at(TUE2, 9), at(TUE2, 12)]) assert.equal((await runAt(t)).sent, 0, new Date(t).toISOString());
  assert.equal(nextDays().length, 1, 'never twice');
  assert.ok(row(lair.sql.exec("SELECT id FROM bookings WHERE customer_id = ? AND kind = 'gm-seat'", RIA).one().id).followup_at > 0);
});

test('round 29, first game: only with the box ticked, only to a seat that was checked in (seated or done), and only for a first game', async () => {
  const g = await game({ seats: 8, tables: ['T12', 'T13'] });
  nowIs(NOW);
  const ticked = await seat(g.id, RIA, 'Ria Moana', { firstGame: true, followUp: true });
  const unticked = await seat(g.id, KAI, 'Kai Tane', { firstGame: true });
  const notFirst = await seat(g.id, MIA, 'Mia Chen', { firstGame: false, followUp: true });
  const noShow = await seat(g.id, LEO, 'Leo Park', { firstGame: true, followUp: true });
  const paidOnly = await seat(g.id, '', 'Sam Jones', { firstGame: true, followUp: true });
  const left = await seat(g.id, '', 'Jo Bloggs', { firstGame: true, followUp: true });
  ok(await call('POST', `bookings/${paidOnly.id}/update`, { paid: true }, OWNER));
  for (const s of [ticked, unticked, notFirst, left]) await checkIn(s);
  // Jo came and has left ('done'); Leo is a no-show
  ok(await call('POST', `bookings/${left.id}/update`, { status: 'done' }, OWNER));
  nowIs(at(SUN, 19));
  ok(await call('POST', `bookings/${noShow.id}/update`, { status: 'noshow' }, OWNER));
  const run = await runAt(at(MON2, 10));
  assert.equal(run.sent, 2);
  assert.deepEqual(nextDays().map((m) => m.to).sort(), ['jo@example.com', 'ria@example.com']);
});

test('round 29, first game: skipped once they\'ve booked that game\'s next session or saved a weekly seat in it, never for another game\'s', async () => {
  const g = await game({ seats: 8, tables: ['T12', 'T13'] });
  nowIs(NOW);
  const rias = await seat(g.id, RIA, 'Ria Moana', { firstGame: true, followUp: true });
  const kais = await seat(g.id, KAI, 'Kai Tane', { firstGame: true, followUp: true });
  const sams = await seat(g.id, '', 'Sam Jones', { firstGame: true, followUp: true });
  const mias = await seat(g.id, MIA, 'Mia Chen', { firstGame: true, followUp: true });
  for (const s of [rias, kais, sams, mias]) await checkIn(s);
  nowIs(at(SUN, 22, 30));
  const next = nextOf(g);
  // Ria books next Sunday's session; Kai saves his seat every week; Sam (a guest) books next Sunday by email
  await seat(next.id, RIA, 'Ria Moana');
  ok(await call('POST', `games/${g.id}/join-series`, { people: 1, name: 'Kai Tane', email: 'kai@example.com', phone: MOBILE }, KAI));
  await seat(next.id, '', 'Sam Jones');
  // Mia books a different game: she still gets it
  const other = await game({ title: 'Lost Mine', schedule: 'one-shot', tables: ['T10'], start: at(SAT2, 13), end: at(SAT2, 16) });
  await seat(other.id, MIA, 'Mia Chen');
  const run = await runAt(at(MON2, 9, 30));
  assert.equal(run.sent, 1);
  assert.deepEqual(nextDays().map((m) => m.to), ['mia@example.com']);
});

test('round 29, first game: a weekly game with seats next session (mockup D3): subject, preheader, thanks, the same table, Save my seat every week and its links (deep links), the details, other beginner games counted as the front door counts, and the unsubscribe', async () => {
  const { g, s } = await riasFirstGame();
  nowIs(at(SUN, 22, 30));
  const next = nextOf(g);
  // the week ahead of Monday 9 November, 9am: beginner games with seats on Wednesday and Thursday count; a game for
  // players with some experience, a full one, a private one, one more than 7 days away and Candlekeep's own next session
  // don't
  const add = (title, day, tables, more = {}) => game({ title, schedule: 'one-shot', tables, start: at(day, 18), end: at(day, 21), ...more });
  nowIs(NOW);
  await add('Daggerheart: first flight', WED2, ['T5']);
  await add('Goblin Kitchen Nightmares', THU2, ['T6', 'T7'], { seats: 8, characters: 'at-table' });
  await add('Abomination Vaults', TUE2, ['T7'], { level: 'some' });
  const full = await add('Mothership', FRI2, ['T8'], { seats: 2 });
  await seat(full.id, MIA, 'Mia Chen');
  await seat(full.id, LEO, 'Leo Park');
  const secret = await add('A private table', SAT2, ['T9']);
  lair.sql.exec('UPDATE games SET private = 1 WHERE id = ?', secret.id);
  await add('Far away', TUE3, ['T11']);
  const run = await runAt(at(MON2, 9));
  assert.equal(run.sent, 1);
  const m = only('ria@example.com');
  const { ref, key, url } = stopOf(m);
  assert.equal(m.subject, 'How was your first game, Ria?');
  assert.equal(preheader(m), 'Candlekeep Mysteries runs again on Sunday. Want your seat?');
  assert.match(m.html, /<h1[^>]*>How was your first game\?<\/h1>/);
  // (the details table pads its labels: compared with runs of spaces as one)
  const text = m.text.replace(/ {2,}/g, ' ');
  const order = [
    'HOW WAS YOUR FIRST GAME?',
    'Thanks for coming to Candlekeep Mysteries on Sunday, Ria. Gobgob hopes the dice were kind.',
    "The same table plays every Sunday at 6pm. Save your seat and it's yours each week until you give it up. You pay at the counter each time, $15.",
    `Save my seat every week: ${GM_PAGE}?join=${next.id}&every=1`,
    `Just next Sunday: ${GM_PAGE}?join=${next.id}`,
    `Try a different game: ${GM_PAGE}`,
    'Next session: Sunday 15 November, 6pm to 10pm',
    'Seats left: 4',
    'Loyalty card: 3 of 12 so far. Stamps land when you check in.',
    "Not quite your thing? That's fine. 2 other beginner games have seats this week.",
    'See you at the Lair!\nGobgob, the Dice Goblin',
    `Dice Goblin Lair\n${ADDRESS}`,
    `Don't send me emails like this: ${MY_LAIR}#unsubscribe=${ref}.${key}`,
  ];
  let from = 0;
  for (const part of order) {
    const i = text.indexOf(part, from);
    assert.ok(i >= 0, `in order: ${part}\n---\n${text}`);
    from = i + part.length;
  }
  assert.equal(ref, s.ref);
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(url.search, '', 'the key is in the #fragment, never the address a server sees');
  assert.equal(row(s.id).followup_key, key);
  // one-click unsubscribe (RFC 8058), on the Lair's own address
  assert.deepEqual(m.headers, { 'List-Unsubscribe': `<https://lair.example.com/unsubscribe/${encodeURIComponent(s.ref)}/${key}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  assert.ok(m.html.includes(`#unsubscribe=${s.ref}.${key}`));
});

test('round 29, first game: a one-shot, a full next session, or none: the same thanks, then "Fancy another? N beginner games have seats this week." and Find your next game', async () => {
  // a one-shot on Sunday
  const { g: oneShot } = await riasFirstGame({ game: { title: 'Lost Mine of Phandelver', schedule: 'one-shot' } });
  // a weekly game whose next session is full (Kai's first game), and one whose sessions stop (Mia's)
  nowIs(NOW);
  const weekly = await game({ title: 'Curse of Strahd', seats: 2, tables: ['T13'] });
  const kais = await seat(weekly.id, KAI, 'Kai Tane', { firstGame: true, followUp: true });
  const next = nextOf(weekly);
  await seat(next.id, LEO, 'Leo Park');
  await seat(next.id, '', 'Sam Jones');
  const ending = await game({ title: 'Tomb of Annihilation', tables: ['T14'] });
  const mias = await seat(ending.id, MIA, 'Mia Chen', { firstGame: true, followUp: true });
  lair.sql.exec("UPDATE games SET status = 'cancelled' WHERE series_id = ? AND starts_at > ?", ending.seriesId, ending.start);
  await checkIn(kais);
  await checkIn(mias);
  // one beginner game with seats in the week ahead
  nowIs(NOW);
  await game({ title: 'Daggerheart: first flight', schedule: 'one-shot', tables: ['T5'], start: at(WED2, 18), end: at(WED2, 21) });
  const run = await runAt(at(MON2, 11));
  assert.equal(run.sent, 3);
  for (const [to, title] of [['ria@example.com', 'Lost Mine of Phandelver'], ['kai@example.com', 'Curse of Strahd'], ['mia@example.com', 'Tomb of Annihilation']]) {
    const m = only(to);
    const name = to.split('@')[0].replace(/^./, (c) => c.toUpperCase());
    assert.equal(m.subject, `How was your first game, ${name}?`);
    assert.ok(m.text.includes(`Thanks for coming to ${title} on Sunday, ${name}. Gobgob hopes the dice were kind.`), m.text);
    assert.ok(m.text.includes('Fancy another? 1 beginner game has seats this week.'), m.text);
    assert.equal(linkIn(m, 'Find your next game'), GM_PAGE);
    assert.ok(!/Save my seat|Just next|Next session/.test(m.text), 'none of the weekly table\'s words');
    assert.ok(linkIn(m, "Don't send me emails like this"));
  }
  assert.ok(oneShot);
});

test('round 29, first game: with no other beginner game with seats this week, the count\'s sentence is left out', async () => {
  // a weekly game's email (D3) with no other beginner game: no "Not quite your thing?"
  const { g } = await riasFirstGame();
  await runAt(at(MON2, 9));
  assert.ok(!/Not quite your thing/.test(only('ria@example.com').text), 'D3 without "Not quite your thing?"');
  // the week after, a one-shot with no other beginner game (Candlekeep's sessions called off): "Fancy another?" alone
  lair.sql.exec("UPDATE games SET status = 'cancelled' WHERE series_id = ?", g.seriesId);
  nowIs(at(MON2, 13));
  const oneShot = await game({ title: 'Lost Mine', schedule: 'one-shot', tables: ['T10'], start: at(SUN2, 18), end: at(SUN2, 21) });
  const kais = await seat(oneShot.id, KAI, 'Kai Tane', { firstGame: true, followUp: true });
  await checkIn(kais);
  await runAt(at('2026-11-16', 9));
  const kai = only('kai@example.com').text;
  assert.ok(kai.includes('Fancy another?'));
  assert.ok(!/beginner game/.test(kai), kai);
  assert.equal(linkIn(only('kai@example.com'), 'Find your next game'), GM_PAGE);
});

test('round 29, first game: Resend down or busy (5xx, 429): unmarked, so the next run sends it; anything else isn\'t tried again', async () => {
  const { s } = await riasFirstGame();
  mail.fail(503);
  const down = await runAt(at(MON2, 9));
  assert.deepEqual(down, { sent: 1, ok: false });
  assert.equal(row(s.id).followup_at, null, 'unmarked');
  assert.match(row(s.id).followup_key, /^[0-9a-f]{32}$/, 'its key is kept');
  const keyBefore = row(s.id).followup_key;
  mail.fail(429);
  await runAt(at(MON2, 9, 10));
  assert.equal(row(s.id).followup_at, null);
  mail.fail(0);
  assert.equal((await runAt(at(MON2, 9, 20))).sent, 1);
  assert.equal(nextDays().length, 1);
  assert.equal(row(s.id).followup_key, keyBefore, 'the same key');
  // an address Resend refuses (422) isn't tried again
  nowIs(NOW);
  const g2 = await game({ title: 'Lost Mine', schedule: 'one-shot', tables: ['T10'] });
  const kais = await seat(g2.id, KAI, 'Kai Tane', { firstGame: true, followUp: true });
  await checkIn(kais);
  mail.fail(422);
  await runAt(at(MON2, 10));
  assert.ok(row(kais.id).followup_at > 0, 'stays marked');
  mail.fail(0);
  assert.equal((await runAt(at(MON2, 10, 10))).sent, 0);
});

test('round 29, first game: a daylight-saving week in Auckland: the day after and its 9am are Lair time (Sunday 4 April 2027, the clocks go back; Sunday 26 September 2027, they go forward)', async () => {
  for (const [booked, day, after, utc9] of [['2027-03-29', '2027-04-03', '2027-04-04', '2027-04-03T21:00:00.000Z'], ['2027-09-20', '2027-09-25', '2027-09-26', '2027-09-25T20:00:00.000Z']]) {
    nowIs(at(booked, 13));
    lair.rulesLoadedAt = Date.now() + 10 * 365 * DAY;
    const g = await game({ title: `Saturday game ${day}`, schedule: 'one-shot', tables: ['T15'], start: at(day, 18), end: at(day, 21) });
    const s = await seat(g.id, '', 'Sam Jones', { email: `sam.${day}@example.com`, firstGame: true, followUp: true });
    await checkIn(s);
    // 9am on the Sunday is NZST in April (UTC+12) and NZDT in September (UTC+13)
    assert.equal(new Date(at(after, 9)).toISOString(), utc9);
    assert.equal((await runAt(at(after, 8, 59))).sent, 0, `${after} 8:59 Lair time`);
    assert.equal((await runAt(at(after, 9))).sent, 1, `${after} 9:00 Lair time`);
    assert.equal((await runAt(at(after, 20, 59))).sent, 0, 'once');
  }
  assert.equal(nextDays().length, 2);
});

/* ---------------- unsubscribing ---------------- */

test('round 29, first game: "Don\'t send me emails like this": its key says what it stops, and only a tap (POST /unsubscribe/stop) stops it, by email, straight away: no follow-up goes to that email again', async () => {
  const { s } = await riasFirstGame();
  await runAt(at(MON2, 9));
  const link = stopOf(only('ria@example.com'));
  // opening the page asks (a POST to see what it is) and changes nothing
  const view = ok(await stopView({ ref: link.ref, key: link.key }));
  assert.deepEqual(view, { link: { stopped: false } });
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM followup_stops').one().n, 0);
  // the tap
  const stopped = ok(await stopNow({ ref: link.ref, key: link.key }));
  assert.deepEqual(stopped, { ok: true, already: false });
  const kept = lair.sql.exec('SELECT * FROM followup_stops').toArray();
  assert.equal(kept.length, 1);
  assert.deepEqual([kept[0].email, kept[0].ref, kept[0].via, kept[0].at], ['ria@example.com', s.ref, 'link', Date.now()]);
  assert.deepEqual(ok(await stopNow({ ref: link.ref, key: link.key })), { ok: true, already: true }, 'again: nothing more');
  assert.deepEqual(ok(await stopView({ ref: link.ref, key: link.key })), { link: { stopped: true } });
  // her next first-game seat (another one she ticks the box on) never gets one: the stop is by email
  nowIs(NOW + 7 * DAY);
  const other = await game({ title: 'Lost Mine', schedule: 'one-shot', tables: ['T10'], start: at(SAT2, 13), end: at(SAT2, 16) });
  const again = await seat(other.id, RIA, 'Ria Moana', { email: 'RIA@example.com', firstGame: true, followUp: true });
  await checkIn(again);
  assert.equal((await runAt(at(SUN2, 9))).sent, 0);
  assert.equal(nextDays().length, 1);
});

test('round 29, first game: a wrong key, another booking\'s key or none: one plain 404 that never says which; 10 wrong tries from one place wait (429)', async () => {
  const { s } = await riasFirstGame();
  nowIs(NOW);
  const g2 = await game({ title: 'Lost Mine', schedule: 'one-shot', tables: ['T10'] });
  const kais = await seat(g2.id, KAI, 'Kai Tane', { firstGame: true, followUp: true });
  await checkIn(kais);
  await runAt(at(MON2, 9));
  const ria = stopOf(only('ria@example.com'));
  const kai = stopOf(only('kai@example.com'));
  const WRONG = `404 ${UNSUBSCRIBE_WORDS.wrong}`;
  assert.equal(said(await stopView({ ref: ria.ref, key: 'f'.repeat(32) })), WRONG);
  assert.equal(said(await stopNow({ ref: ria.ref, key: kai.key })), WRONG, 'another booking\'s key');
  assert.equal(said(await stopNow({ ref: 'NO-SUCH-1', key: ria.key })), WRONG);
  assert.equal(said(await stopNow({ ref: ria.ref })), WRONG);
  assert.equal(said(await stopNow({})), WRONG);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM followup_stops').one().n, 0, 'nothing stopped');
  // 10 wrong tries from one place, then it waits (the right key too, until then); elsewhere is fine
  for (let i = 5; i < 10; i += 1) await stopView({ ref: ria.ref, key: 'e'.repeat(32) });
  assert.equal(said(await stopNow({ ref: ria.ref, key: ria.key })), `429 ${CANCEL_LINK_WORDS.tooMany}`);
  assert.deepEqual(ok(await stopNow({ ref: ria.ref, key: ria.key }, '198.51.100.4')), { ok: true, already: false });
  assert.ok(s);
});

test('round 29, first game: the one-click header (List-Unsubscribe-Post) stops it with a POST to the Lair\'s own address and nothing else asked; a GET never does', async () => {
  const { s } = await riasFirstGame();
  await runAt(at(MON2, 9));
  const m = only('ria@example.com');
  const target = m.headers['List-Unsubscribe'].replace(/^<|>$/g, '');
  const env = { LAIR: { idFromName: () => 'id', get: () => ({ fetch: (req) => lair.fetch(req) }) } };
  // an email scanner (or a person) opening it: a GET goes on to the page that asks, and stops nothing
  const opened = await worker.fetch(new Request(target, { headers: { 'CF-Connecting-IP': '203.0.113.50' } }), env);
  assert.equal(opened.status, 303);
  const key = row(s.id).followup_key;
  assert.equal(opened.headers.get('Location'), `${MY_LAIR}#unsubscribe=${s.ref}.${key}`);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM followup_stops').one().n, 0);
  // the mail app's one-click POST
  const posted = await worker.fetch(new Request(target, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.50' } }), env);
  assert.equal(posted.status, 200);
  const kept = lair.sql.exec('SELECT * FROM followup_stops').toArray();
  assert.deepEqual([kept.length, kept[0].email, kept[0].via], [1, 'ria@example.com', 'one-click']);
  // a wrong key there: 404, and nothing stopped
  const wrong = await worker.fetch(new Request(target.replace(key, 'a'.repeat(32)), { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'CF-Connecting-IP': '203.0.113.51' } }), env);
  assert.equal(wrong.status, 404);
});

/* ---------------- Monday's numbers ---------------- */

/** A past booking, saved as it would be by then (status, paid), for the weekly numbers */
let pastN = 0;
function past(kind, { customerId = null, email = null, start, status = 'done', firstGame = null, paid = false, gameId = 'gm_past' }) {
  pastN += 1;
  const id = `bk_past${String(pastN).padStart(10, '0')}`;
  lair.saveBooking({
    id, ref: `PT-PAST-${pastN}`, kind, status, tables: ['T4'], start, end: start + 3 * HOUR, people: 1, name: 'Someone', email: email || `p${pastN}@example.com`,
    amount: 1500, gameId: kind === 'gm-seat' ? gameId : null, customerId, paid, paidAmount: paid ? 1500 : 0,
  }, start - DAY);
  if (firstGame != null) lair.sql.exec('UPDATE bookings SET first_game = ? WHERE id = ?', firstGame, id);
  return id;
}

test('round 29, Monday\'s numbers: first-time TTRPG players who came back to another TTRPG seat within 4 weeks, for the first games whose 4 weeks have finished', async () => {
  // the report on Monday 16 November 2026 (last week: 9 to 15 November); its first games are from 12 to 18 October,
  // whose 4 weeks are over by the end of last week; the week before's are from 5 to 11 October
  nowIs(at('2026-11-16', 9));
  const cohort = (d) => at(`2026-10-${d}`, 18);
  // Ria: first game 13 Oct, back 27 Oct (a TTRPG seat, checked in): back
  past('gm-seat', { customerId: RIA, start: cohort(13), firstGame: 1 });
  past('gm-seat', { customerId: RIA, start: at('2026-10-27', 18) });
  // Sam, a guest: first game 14 Oct, back by email 9 Nov (26 days later): back
  past('gm-seat', { email: 'sam@example.com', start: cohort(14), firstGame: 1 });
  past('gm-seat', { email: 'Sam@Example.com', start: at('2026-11-09', 18), paid: true, status: 'confirmed' });
  lair.sql.exec("UPDATE bookings SET paid_at = starts_at WHERE email = 'Sam@Example.com'");
  // Leo: first game 15 Oct, next TTRPG seat 13 Nov (29 days later): not within 4 weeks
  past('gm-seat', { customerId: LEO, start: cohort(15), firstGame: 1 });
  past('gm-seat', { customerId: LEO, start: at('2026-11-13', 18) });
  // Kai: first game 16 Oct, then only a table: not back at a TTRPG seat
  past('gm-seat', { customerId: KAI, start: cohort(16), firstGame: 1 });
  past('table', { customerId: KAI, start: at('2026-10-20', 14) });
  // Mia: booked a first game 17 Oct but was a no-show, then came 20 Oct: not a first game anyone played
  past('gm-seat', { customerId: MIA, start: cohort(17), firstGame: 1, status: 'noshow' });
  past('gm-seat', { customerId: MIA, start: at('2026-10-20', 18) });
  // Jo: a first game the week before's cohort (8 Oct), back 15 Oct
  past('gm-seat', { email: 'jo@example.com', start: at('2026-10-08', 18), firstGame: 1 });
  past('gm-seat', { email: 'jo@example.com', start: at('2026-10-15', 18) });
  // not a first game (0, and not answered): not counted
  past('gm-seat', { customerId: '6100', start: cohort(13), firstGame: 0 });
  past('gm-seat', { customerId: '6101', start: cohort(13) });
  const report = lair.reportFor(lair.rulesCache, Date.now(), 2);
  const [, last, before] = report.weeks;
  assert.equal(last.week, '2026-11-09');
  assert.deepEqual(last.firstGames, { week: '2026-10-12', players: 4, back: 2 });
  assert.deepEqual(before.firstGames, { week: '2026-10-05', players: 1, back: 1 });
  const lines = new Map(lair.weeklyReportContent(last, before, report).body.details);
  assert.equal(lines.get('First games, back within 4 weeks'), '2 of 4, 50% (first games 12–18 Oct; 1 of 1 the week before)');
  assert.ok(report.words.firstGames);
  // a week with no first games says so
  const quiet = lair.weeklyReportContent({ ...last, firstGames: { week: '2026-10-12', players: 0, back: 0 } }, { ...before, firstGames: { week: '2026-10-05', players: 0, back: 0 } }, report).body.details;
  assert.equal(new Map(quiet).get('First games, back within 4 weeks'), 'No first games 12–18 Oct (none the week before)');
});

test('round 29, Monday\'s numbers: loyalty cards filled in the last 4 weeks (a card fills with its 10th stamp)', async () => {
  // Monday 16 November 2026: last week's 4 weeks are 19 October to 15 November; the week before's, 12 October to 8 November
  nowIs(at('2026-11-16', 9));
  lair.loyaltyFrom = 0;
  const visits = (who, days) => days.forEach((d) => past('table', { customerId: who, start: at(d, 14), status: 'done' }));
  const daysFrom = (first, n, step = 1) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${first}T12:00:00Z`) + i * step * DAY).toISOString().slice(0, 10));
  // Ria: 9 stamps in September, then 2 more on 20 and 21 October: her first card fills on 20 October (in both windows)
  visits(RIA, [...daysFrom('2026-09-01', 9), '2026-10-20', '2026-10-21']);
  // Kai: 10 stamps, all in September: his card filled then (in neither)
  visits(KAI, daysFrom('2026-09-01', 10));
  // Leo: 20 stamps from 19 October to 7 November: two cards (on 28 October and 7 November), in both
  visits(LEO, daysFrom('2026-10-19', 20));
  // Mia: her 10th stamp on 14 October (the week before's window only), from staff on the counter for the last one
  visits(MIA, daysFrom('2026-10-05', 9));
  lair.sql.exec("INSERT INTO loyalty_stamps (id, customer_id, kind, count, at, created_at) VALUES ('st_mia', ?, 'staff', 1, ?, ?)", MIA, at('2026-10-14', 15), at('2026-10-14', 15));
  for (const id of [RIA, KAI, LEO, MIA]) assert.ok(lair.stampCount(id) >= 10, id);
  const report = lair.reportFor(lair.rulesCache, Date.now(), 2);
  const [, last, before] = report.weeks;
  assert.equal(last.cardsFilled, 3, 'Ria\'s and Leo\'s two');
  assert.equal(before.cardsFilled, 4, 'and Mia\'s');
  const lines = new Map(lair.weeklyReportContent(last, before, report).body.details);
  assert.equal(lines.get('Loyalty cards filled, last 4 weeks'), '3 (4 the week before)');
});

test('round 29, Monday\'s numbers: the median days between visits, for people with an account who came on 2 or more days in the last 8 weeks', async () => {
  // Monday 16 November 2026: last week's 8 weeks are 21 September to 15 November
  nowIs(at('2026-11-16', 9));
  const visit = (who, day, kind = 'table') => past(kind, { customerId: who, start: at(day, 14), status: 'done' });
  // Ria every 7 days (1, 8, 15 Nov); Kai 3 days apart (10 and 13 Nov) and twice on the 10th (one day); Leo 20 days
  // apart (1 Oct, 21 Oct, 10 Nov); Mia once; a guest with no account twice; someone whose first visit was before the 8
  // weeks, with only one in them
  for (const d of ['2026-11-01', '2026-11-08', '2026-11-15']) visit(RIA, d);
  visit(KAI, '2026-11-10');
  visit(KAI, '2026-11-10', 'gm-seat');
  visit(KAI, '2026-11-13');
  for (const d of ['2026-10-01', '2026-10-21', '2026-11-10']) visit(LEO, d);
  visit(MIA, '2026-11-03');
  past('table', { email: 'guest@example.com', start: at('2026-11-03', 14) });
  past('table', { email: 'guest@example.com', start: at('2026-11-04', 14) });
  visit('6200', '2026-09-01');
  visit('6200', '2026-11-11');
  const report = lair.reportFor(lair.rulesCache, Date.now(), 2);
  const [, last, before] = report.weeks;
  // Ria 7, Kai 3, Leo 20: the median is 7; the week before's 8 weeks (14 Sep to 8 Nov) have Ria's 7 (1 and 8 Nov) and
  // Leo's 20 (1 and 21 Oct): the median of two is 13.5
  assert.deepEqual(last.visitGap, { median: 7, people: 3 });
  assert.deepEqual(before.visitGap, { median: 13.5, people: 2 });
  const lines = new Map(lair.weeklyReportContent(last, before, report).body.details);
  assert.equal(lines.get('Days between visits'), '7 days, the median for 3 people who came on 2 or more days in the last 8 weeks (13.5 the week before)');
  const none = lair.weeklyReportContent({ ...last, visitGap: { median: null, people: 0 } }, before, report).body.details;
  assert.equal(new Map(none).get('Days between visits'), 'Nobody came on 2 or more days in the last 8 weeks');
});

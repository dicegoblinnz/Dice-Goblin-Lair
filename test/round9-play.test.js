// Round 9, play (contract v9-play): "I'm interested" in a TTRPG session (the GM is emailed and gets back to them) and
// "Maybe" for an event date (or "I'm coming", when it takes no sign-ups), with public counts and never names. Mo (9 Oct):
// "have the option to click on games with spaces in them to say you are interested in joining or others can have an
// option to register interest and the gm will get back to you", and "events for card games etc. where you say you are
// coming or even planning on coming … so that we can get rough numbers".
// Run with: node --test test/   (under TZ=UTC and TZ=Pacific/Auckland)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair, MIGRATIONS } from '../src/lair.js';
import { LairTime, rulesFromSettings } from '../src/core.js';
import { INTEREST_MESSAGES } from '../src/interest.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Friday 9 October 2026, 1:00pm in Auckland (NZDT, UTC+13): round 9
const NOW = Date.UTC(2026, 9, 9, 0, 0);
const realNow = Date.now;

/* ---------------- helpers (as test/round8-guests.test.js) ---------------- */
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
  { id: 'fancy-room', name: 'Fancy room', code: 'F', tables: 1, seats: 12, price: 15, minPeople: 4, order: 4 },
];
const TEST_HOURS = 'Mon closed\nTue 12:00-22:00\nWed 12:00-22:00\nThu 12:00-22:00\nFri 12:00-23:00\nSat 10:00-23:00\nSun 10:00-20:00';
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// A Pokémon league with no sign-ups (entry is a booster pack), trivia with 20 places, and one that finished last week
const EVENTS = [
  { id: 'pokemon', title: 'Pokémon league', type: 'tcg', start: at('2026-10-16', 17), end: at('2026-10-16', 20), tables: '' },
  { id: 'quiz', title: 'Trivia night', start: at('2026-10-14', 18), end: at('2026-10-14', 20), tables: '', capacity: 20, entryFee: 500 },
  { id: 'old', title: 'Last week', start: at('2026-10-02', 18), end: at('2026-10-02', 20), tables: '' },
];
const POKEMON = 'pokemon@2026-10-16';
const QUIZ = 'quiz@2026-10-14';
const MOBILE = '021 555 0100';
const RUBY = { name: 'Ruby Tane', email: 'ruby@example.com', phone: MOBILE };

let lair;
async function call(method, path, body, customer = '', extraHeaders = {}) {
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  return { status: response.status, data: await response.json() };
}
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const interest = (body, who = '', client = '') => call('POST', 'interest', body, who, client ? { 'X-Lair-Client': client } : {});
const removeInterest = (id, body = {}, who = '') => call('POST', `interest/${encodeURIComponent(id)}/remove`, body, who);
const floor = async (who = '') => (await call('GET', `floor?from=${NOW - DAY}&to=${NOW + 30 * DAY}`, null, who)).data;
const me = async (who) => (await call('GET', 'me', null, who)).data;
const rows = () => lair.sql.exec('SELECT * FROM interests ORDER BY rowid').toArray();
/** Ana's Curse of Strahd on Thursday 15 October, 6pm to 9pm (4 seats); she's a trusted GM, so it's live */
const strahd = async (over = {}) => (await call('POST', 'games', {
  title: 'Curse of Strahd', system: 'D&D 5e', gm: 'Ana', email: 'ana@example.com', blurb: 'Mists and wolves.', seats: 4, tables: ['A1'],
  start: at('2026-10-15', 18), end: at('2026-10-15', 21), ...over,
}, 'gm')).data.game;

function captureEmails() {
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test' };
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

beforeEach(() => {
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'example-shop.myshopify.com' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: id === 'gm', tags: [] });
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
});
afterEach(() => {
  Date.now = realNow;
});

test('play (round 9): one new table in one migration entry, found by what it makes', () => {
  const mine = MIGRATIONS.filter((m) => m.some((s) => /CREATE TABLE IF NOT EXISTS interests\b/.test(s)));
  assert.equal(mine.length, 1);
  assert.ok(mine[0].some((s) => /UNIQUE INDEX IF NOT EXISTS interests_one/.test(s)), 'one active interest per person (email) per session or date');
  assert.ok(mine[0].every((s) => /^\s*CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS/.test(s)), 'only new tables and indexes');
  // the migration ran: the table is there and empty
  assert.deepEqual(rows(), []);
});

test("play: a guest says they're interested in a session; the GM is emailed, replies go to the guest, and the board shows a count only", async () => {
  const mail = captureEmails();
  try {
    const game = await strahd();
    assert.equal(game.status, 'open');
    // a guest needs a name, an email and a mobile, as on a sign-up
    assert.equal(said(await interest({ kind: 'session', id: game.id, email: RUBY.email, phone: MOBILE })), `422 ${INTEREST_MESSAGES.name}`);
    assert.equal(said(await interest({ kind: 'session', id: game.id, name: RUBY.name, email: 'ruby', phone: MOBILE })), `422 ${INTEREST_MESSAGES.email}`);
    assert.equal(said(await interest({ kind: 'session', id: game.id, name: RUBY.name, email: RUBY.email })), '422 Add a mobile number so we can reach you on the day.');
    assert.equal(said(await interest({ kind: 'session', id: game.id, ...RUBY, note: 'x'.repeat(281) })), `422 ${INTEREST_MESSAGES.note}`);
    assert.equal(said(await interest({ kind: 'game', id: game.id, ...RUBY })), `422 ${INTEREST_MESSAGES.kind}`);
    assert.equal(said(await interest({ kind: 'session', id: 'gm_nope', ...RUBY })), `404 ${INTEREST_MESSAGES.session}`);
    const res = await interest({ kind: 'session', id: game.id, ...RUBY, note: 'First time playing, is that OK?' });
    assert.equal(res.status, 200, said(res));
    assert.equal(res.data.interest.kind, 'session');
    assert.equal(res.data.interest.level, 'interested');
    assert.equal(res.data.interest.targetId, game.id);
    assert.ok(res.data.interest.key, "a guest's answer carries the key that takes it back from this browser");
    assert.deepEqual(res.data.counts, { interested: 1 });
    assert.equal(res.data.emailed, true);
    await settle();
    const toGm = mail.sent.filter((m) => m.to === 'ana@example.com');
    assert.equal(toGm.length, 1);
    assert.equal(toGm[0].subject, 'Ruby is interested in Curse of Strahd on Thu 15 Oct');
    assert.equal(toGm[0].reply_to, 'ruby@example.com');
    assert.match(toGm[0].html, /First time playing, is that OK\?/);
    assert.match(toGm[0].html, /021 555 0100/);
    assert.match(toGm[0].html, /Nothing is booked yet/);
    // the public board: a count, never a name
    const pub = (await floor()).games.find((g) => g.id === game.id);
    assert.equal(pub.interested, 1);
    assert.equal(pub.interest, undefined);
    assert.ok(!JSON.stringify(await floor()).includes('Ruby'), 'no names on the public floor');
    // the GM sees who, on their own session (with how to reach them); staff too
    const gmView = (await floor('gm')).games.find((g) => g.id === game.id);
    assert.equal(gmView.interest.length, 1);
    assert.equal(gmView.interest[0].name, 'Ruby Tane');
    assert.equal(gmView.interest[0].email, 'ruby@example.com');
    assert.equal(gmView.interest[0].note, 'First time playing, is that OK?');
    assert.equal(gmView.interest[0].member, false);
    const staffView = (await floor('staff')).games.find((g) => g.id === game.id);
    assert.equal(staffView.interest[0].name, 'Ruby Tane');
    // another customer doesn't see names
    assert.equal((await floor('2002')).games.find((g) => g.id === game.id).interest, undefined);
  } finally {
    mail.restore();
  }
});

test('play: asking again changes the note, keeps one row and never emails the GM twice; the GM can’t be interested in their own game', async () => {
  const mail = captureEmails();
  try {
    const game = await strahd();
    const first = await interest({ kind: 'session', id: game.id, ...RUBY, note: 'Keen!' });
    const again = await interest({ kind: 'session', id: game.id, ...RUBY, email: 'RUBY@example.com', note: 'Still keen' });
    assert.equal(again.status, 200);
    assert.equal(again.data.already, true);
    assert.equal(again.data.emailed, false);
    assert.equal(again.data.interest.id, first.data.interest.id);
    assert.equal(again.data.interest.note, 'Still keen');
    assert.equal(rows().length, 1);
    await settle();
    assert.equal(mail.sent.filter((m) => m.to === 'ana@example.com').length, 1);
    assert.equal(said(await interest({ kind: 'session', id: game.id, note: 'Me!' }, 'gm')), `422 ${INTEREST_MESSAGES.own}`);
  } finally {
    mail.restore();
  }
});

test('play: a full session can be asked about; someone with a seat already is told so; a finished one says so', async () => {
  const game = await strahd({ seats: 2 });
  const seat = await call('POST', 'bookings', { kind: 'gm-seat', gameId: game.id, name: 'Kiri Smith', email: 'kiri@example.com', phone: MOBILE, people: 2, players: [{ name: 'Kiri' }, { name: 'Jo' }] });
  assert.equal(seat.status, 200, said(seat));
  assert.equal((await floor()).games.find((g) => g.id === game.id).status, 'full');
  assert.equal((await interest({ kind: 'session', id: game.id, ...RUBY })).status, 200, 'a full session takes interest: the GM gets back if a seat comes up');
  assert.equal(said(await interest({ kind: 'session', id: game.id, name: 'Kiri Smith', email: 'kiri@example.com', phone: MOBILE })), `409 ${INTEREST_MESSAGES.seat}`);
  Date.now = () => at('2026-10-15', 22);
  assert.equal(said(await interest({ kind: 'session', id: game.id, name: 'Late', email: 'late@example.com', phone: MOBILE })), `422 ${INTEREST_MESSAGES.over}`);
});

test('play: "Maybe" for an event date is a count for everyone and names for staff; "I’m coming" only where there are no sign-ups', async () => {
  const maybe = await interest({ kind: 'event', id: QUIZ, ...RUBY });
  assert.equal(maybe.status, 200, said(maybe));
  assert.equal(maybe.data.interest.level, 'maybe');
  assert.deepEqual(maybe.data.counts, { maybe: 1, coming: 0 });
  // trivia takes sign-ups: coming is the sign-up, not this
  assert.equal(said(await interest({ kind: 'event', id: QUIZ, ...RUBY, coming: true })), `422 ${INTEREST_MESSAGES.signUp}`);
  // the Pokémon league has no sign-ups: "I'm coming" is a count too
  const coming = await interest({ kind: 'event', id: POKEMON, name: 'Tama Rewiti', email: 'tama@example.com', phone: MOBILE, coming: true });
  assert.equal(coming.data.interest.level, 'coming');
  await interest({ kind: 'event', id: POKEMON, name: 'Mere Parata', email: 'mere@example.com', phone: MOBILE });
  const pub = await floor();
  assert.deepEqual(pub.eventInterest[QUIZ], { maybe: 1, coming: 0 });
  assert.deepEqual(pub.eventInterest[POKEMON], { maybe: 1, coming: 1 });
  assert.equal(pub.interests, undefined);
  assert.ok(!/Ruby|Tama|Mere/.test(JSON.stringify(pub)), 'no names on the public floor');
  const staff = await floor('staff');
  assert.deepEqual(staff.interests.map((i) => [i.name, i.occurrenceId, i.level]).sort(), [['Mere Parata', POKEMON, 'maybe'], ['Ruby Tane', QUIZ, 'maybe'], ['Tama Rewiti', POKEMON, 'coming']]);
  assert.equal(staff.interests[0].email.endsWith('@example.com'), true);
  // changing your mind: maybe → coming is the same row
  const sure = await interest({ kind: 'event', id: POKEMON, name: 'Mere Parata', email: 'mere@example.com', phone: MOBILE, coming: true });
  assert.equal(sure.data.already, true);
  assert.deepEqual(sure.data.counts, { maybe: 0, coming: 2 });
  // someone signed up already is told so; unknown and finished dates say so
  const joined = await call('POST', `events/${QUIZ}/join`, { name: 'Kiri Smith', email: 'kiri@example.com', phone: MOBILE, people: 1 });
  assert.equal(joined.status, 200, said(joined));
  assert.equal(said(await interest({ kind: 'event', id: QUIZ, name: 'Kiri Smith', email: 'kiri@example.com', phone: MOBILE })), `409 ${INTEREST_MESSAGES.joined}`);
  assert.equal(said(await interest({ kind: 'event', id: 'quiz@2026-10-13', ...RUBY })), `404 ${INTEREST_MESSAGES.event}`);
  assert.equal(said(await interest({ kind: 'event', id: 'old@2026-10-02', ...RUBY })), `422 ${INTEREST_MESSAGES.over}`);
});

test('play: a member’s interest uses their account, shows in GET /me, and only they (or staff, or a guest’s key) can take it back', async () => {
  const game = await strahd();
  await call('GET', `me?name=${encodeURIComponent('Sam Jones')}`, null, '1001');
  await call('POST', 'me/profile', { name: 'Sam Jones', email: 'sam@example.com' }, '1001');
  // logged in: no name, email or mobile needed
  const mine = await interest({ kind: 'session', id: game.id }, '1001');
  assert.equal(mine.status, 200, said(mine));
  assert.equal(mine.data.interest.name, 'Sam Jones');
  assert.equal(mine.data.interest.key, undefined, 'a member takes theirs back by their account, so no key');
  await interest({ kind: 'event', id: POKEMON }, '1001');
  const listed = (await me('1001')).interests;
  assert.deepEqual(listed.map((i) => [i.kind, i.targetId, i.level]), [['session', game.id, 'interested'], ['event', POKEMON, 'maybe']]);
  assert.equal(listed[0].title, 'Curse of Strahd');
  // someone else can't take it back; they can
  assert.equal(said(await removeInterest(mine.data.interest.id, {}, '2002')), `403 ${INTEREST_MESSAGES.notYours}`);
  assert.equal(said(await removeInterest(mine.data.interest.id)), `403 ${INTEREST_MESSAGES.notYours}`);
  const gone = await removeInterest(mine.data.interest.id, {}, '1001');
  assert.equal(gone.status, 200);
  assert.equal(gone.data.interest.status, 'removed');
  assert.deepEqual(gone.data.counts, { interested: 0 });
  assert.equal((await removeInterest(mine.data.interest.id, {}, '1001')).status, 200, 'taking it back twice is fine');
  assert.deepEqual((await me('1001')).interests.map((i) => i.targetId), [POKEMON]);
  assert.equal(said(await removeInterest('in_nope', {}, '1001')), `404 ${INTEREST_MESSAGES.missing}`);
  // a guest takes theirs back with the key from the answer; a wrong key doesn't
  const guest = await interest({ kind: 'event', id: POKEMON, ...RUBY });
  assert.equal(said(await removeInterest(guest.data.interest.id, { key: 'not-the-key' })), `403 ${INTEREST_MESSAGES.notYours}`);
  assert.equal((await removeInterest(guest.data.interest.id, { key: guest.data.interest.key })).status, 200);
  // staff can take any back
  const again = await interest({ kind: 'event', id: POKEMON, ...RUBY });
  assert.equal((await removeInterest(again.data.interest.id, {}, 'staff')).status, 200);
  assert.deepEqual((await floor()).eventInterest[POKEMON], { maybe: 1, coming: 0 });
});

test('play: interest left with an email joins the account when they log in with it, counted once', async () => {
  const game = await strahd();
  await interest({ kind: 'session', id: game.id, ...RUBY, note: 'From my phone' });
  await interest({ kind: 'event', id: POKEMON, ...RUBY });
  // already theirs by account for the Pokémon league (another email), so the guest one is the extra one
  await call('GET', `me?name=${encodeURIComponent('Ruby Tane')}`, null, '3003');
  await interest({ kind: 'event', id: POKEMON, name: 'Ruby Tane', email: 'ruby.t@example.com' }, '3003');
  lair.accountEmail = async () => ({ email: 'Ruby@Example.com', fetched: false });
  const list = (await me('3003')).interests;
  assert.deepEqual(list.map((i) => [i.kind, i.targetId]), [['session', game.id], ['event', POKEMON]]);
  assert.equal(list[0].note, 'From my phone');
  assert.deepEqual((await floor()).eventInterest[POKEMON], { maybe: 1, coming: 0 }, 'counted once');
  assert.equal(rows().filter((r) => r.customer_id === '3003' && r.status === 'active').length, 2);
  // the GM's view says they're a member now
  assert.equal((await floor('gm')).games.find((g) => g.id === game.id).interest[0].member, true);
});

test('play: interest shares the public routes’ rate limit (20 in 10 minutes from one address)', async () => {
  for (let i = 0; i < 20; i += 1) {
    const res = await interest({ kind: 'event', id: POKEMON, name: `Player ${i}`, email: `p${i}@example.com`, phone: MOBILE }, '', '203.0.113.9');
    assert.equal(res.status, 200, said(res));
  }
  const res = await interest({ kind: 'event', id: POKEMON, name: 'Player 21', email: 'p21@example.com', phone: MOBILE }, '', '203.0.113.9');
  assert.equal(res.status, 429);
  // staff aren't limited, and another address isn't either
  assert.equal((await interest({ kind: 'event', id: POKEMON, name: 'Other', email: 'other@example.com', phone: MOBILE }, '', '203.0.113.10')).status, 200);
});

test('play: no GM email on file sends it to the staff to pass on', async () => {
  const mail = captureEmails();
  try {
    const game = await strahd({ email: '' });
    const res = await interest({ kind: 'session', id: game.id, ...RUBY });
    assert.equal(res.data.emailed, true);
    await settle();
    const toStaff = mail.sent.filter((m) => m.to === 'staff@dicegoblin.test');
    assert.equal(toStaff.length, 1);
    assert.equal(toStaff[0].reply_to, 'ruby@example.com');
    assert.match(toStaff[0].html, /please pass this on/);
  } finally {
    mail.restore();
  }
});

// Round 18: more for GM sessions (contract v18-gm-sessions). Mo (16 Oct 2026): "I want the staff to be able to see each
// player inside a gm session run game and have the ability to reserve seats to newer players. And have the ability to
// kick players out of they need." (staff GMs running their own game, and seats held for new players); "Also have staff
// have the ability to make certain games free for special events or just regular events"; "Have the ability for staff
// to change the gm for a game even after it was set." Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { GM_SESSION_WORDS as W } from '../src/gm-sessions.js';

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

/* ---------------- seats for new players ---------------- */

test('round 18: seats for new players are set by staff with GM games or the session\'s own GM when they\'re on the team; nobody else', async () => {
  const tamas = (await list()).game.id;
  const rangis = (await list({ gm: RANGI, tables: ['B2'] })).game.id;
  // Rangi isn't staff, so not even in his own game; Tama only in his own; logged out, log in
  assert.equal(said(await newSeats(rangis, { seats: 2 }, RANGI)), `403 ${W.notYours}`);
  assert.equal(said(await newSeats(rangis, { seats: 2 }, TAMA)), `403 ${W.notYours}`);
  assert.equal(said(await newSeats(tamas, { seats: 2 }, HEMI)), `403 ${W.notYours}`);
  assert.equal(said(await newSeats(tamas, { seats: 2 })), `401 ${W.login}`);
  for (const seats of [5, -1, 1.5, 'two', null, undefined]) {
    assert.equal(said(await newSeats(tamas, seats === undefined ? {} : { seats }, TAMA)), `422 ${W.newSeats(4)}`, String(seats));
  }
  assert.equal(said(await newSeats('gm_nope', { seats: 1 }, OWNER)), '404 Game not found.');
  const set = ok(await newSeats(tamas, { seats: 2 }, TAMA));
  assert.deepEqual([set.game.newSeats, set.game.newLeft, set.sessions], [2, 2, 1]);
  // Ana (GM games) can in anyone's game, and so can the main account
  assert.equal(ok(await newSeats(rangis, { seats: 1 }, ANA)).game.newSeats, 1);
  assert.equal(ok(await newSeats(rangis, { seats: 3 }, OWNER)).game.newSeats, 3);
  // Everyone sees them on the board, with the seats left
  const seen = await gameOn(tamas);
  assert.deepEqual([seen.newSeats, seen.newLeft, seen.taken, seen.status], [2, 2, 0, 'open']);
  // 0 lets them go
  assert.deepEqual([ok(await newSeats(tamas, { seats: 0 }, TAMA)).game.newSeats, (await gameOn(tamas)).newLeft], [0, 0]);
  // A cancelled session can't have them
  ok(await call('POST', `games/${rangis}/update`, { status: 'cancelled' }, OWNER));
  assert.equal(said(await newSeats(rangis, { seats: 1 }, OWNER)), '409 That game was cancelled.');
});

test('round 18: online, only players new to the TTRPG sessions can take the seats kept for them; their seats fill those first', async () => {
  await playedBefore();
  const id = (await list({ start: at('2026-10-24', 18), end: at('2026-10-24', 22) })).game.id;
  ok(await newSeats(id, { seats: 2 }, OWNER));
  // GET /me says who's new: Kai played yesterday, Mia never has
  assert.deepEqual([(await me(KAI)).customer.newPlayer, (await me(MIA)).customer.newPlayer], [false, true]);
  // Kai can have the 2 seats that aren't kept, not 3
  assert.equal(said(await seat(id, KAI, 'Kai', 3)), `409 ${W.keptSome(2, 2)}`);
  const kais = ok(await seat(id, KAI, 'Kai', 2)).booking;
  assert.equal(lair.booking(kais.id).newPlayer, false);
  let seen = await gameOn(id);
  assert.deepEqual([seen.taken, seen.newLeft, seen.status], [2, 2, 'open']);
  // Now only the kept seats are left: Ria can't, and nor can a guest with Kai's email (he's played)
  assert.equal(said(await seat(id, RIA, 'Ria')), `409 ${W.keptAll}`);
  assert.equal(said(await seat(id, '', 'Kai')), `409 ${W.keptAll}`);
  // Mia's new: her seat is one of the kept ones
  const mias = ok(await seat(id, MIA, 'Mia')).booking;
  assert.equal(lair.booking(mias.id).newPlayer, true);
  seen = await gameOn(id);
  assert.deepEqual([seen.taken, seen.newLeft, seen.status], [3, 1, 'open']);
  // A guest whose email has never had a seat is new too
  assert.equal(said(await seat(id, '', 'Lee', 2)), '409 Only 1 seat left.');
  const lees = ok(await seat(id, '', 'Lee')).booking;
  assert.equal(lair.booking(lees.id).newPlayer, true);
  seen = await gameOn(id);
  assert.deepEqual([seen.taken, seen.newLeft, seen.status], [4, 0, 'full']);
  // Seats a new player cancels go back to being kept
  ok(await call('POST', `bookings/${mias.id}/update`, { status: 'cancelled' }, MIA));
  assert.deepEqual([(await gameOn(id)).newLeft, said(await seat(id, RIA, 'Ria'))], [1, `409 ${W.keptAll}`]);
  // A new player's seats at a later session are still new until they've played one
  const later = (await list({ start: at('2026-10-31', 18), end: at('2026-10-31', 22) })).game.id;
  ok(await newSeats(later, { seats: 4 }, OWNER));
  assert.equal(lair.booking(ok(await seat(later, '', 'Lee')).booking.id).newPlayer, true);
  // ... and once Saturday's started, Lee has played, so isn't new any more
  Date.now = () => at('2026-10-24', 19);
  assert.equal(said(await seat(later, '', 'Lee')), `409 ${W.keptAll}`);
});

test('round 18: a weekly regular who isn\'t new leaves the kept seats; a new one has a kept seat at their first session only; released, a regular waiting gets it', async () => {
  await playedBefore();
  const listed = await list({ gm: ANA, start: at('2026-10-24', 18), end: at('2026-10-24', 22), seats: 2, schedule: 'weekly' });
  const [first, second] = listed.sessions;
  const { seriesId } = listed.game;
  // kept for this session and every later one (and the series, for sessions still to be made)
  assert.equal(ok(await newSeats(first.id, { seats: 1, scope: 'series' }, ANA)).sessions, listed.sessions.length);
  assert.deepEqual(lair.sql.exec('SELECT DISTINCT new_seats FROM games WHERE series_id = ?', seriesId).toArray().map((r) => r.new_seats), [1]);
  assert.equal(JSON.parse(lair.sql.exec('SELECT details FROM series WHERE id = ?', seriesId).one().details).newSeats, 1);
  // each a minute after the last, so they're in this order: Kai, Ria, Mia
  let minute = 0;
  const join = (who, name) => {
    minute += 1;
    Date.now = () => at('2026-10-18', 10, minute);
    return call('POST', `games/${first.id}/join-series`, { people: 1, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100' }, who);
  };
  // Kai (not new) has the seat that isn't kept; Ria (not new) waits; the kept seat isn't held for her
  assert.equal(ok(await join(KAI, 'Kai')).booked.length, 1);
  const ria = ok(await join(RIA, 'Ria'));
  assert.equal(ria.booked.length, 0);
  let seen = await gameOn(first.id);
  assert.deepEqual([seen.taken, seen.held, seen.newLeft, seen.status], [1, 0, 1, 'open']);
  // Mia's new, so she can have it
  const mia = ok(await join(MIA, 'Mia'));
  assert.equal(mia.booked.length, 1);
  assert.equal(lair.gameBookings(first.id).find((b) => b.customerId === MIA).newPlayer, true);
  assert.equal((await gameOn(first.id)).status, 'full');
  // The week after, nobody's new: Kai rolls forward (first to join), and the kept seat waits for someone new
  Date.now = () => at('2026-10-25', 10);
  lair.rollSeries(lair.rulesCache, Date.now());
  const seated = () => lair.gameBookings(second.id).filter((b) => b.kind === 'gm-seat' && b.status === 'confirmed').map((b) => b.customerId).sort();
  assert.deepEqual(seated(), [KAI]);
  seen = await gameOn(second.id);
  assert.deepEqual([seen.taken, seen.held, seen.newLeft], [1, 0, 1]);
  // Ana lets this session's kept seat go: the next run seats Ria, who joined before Mia
  ok(await newSeats(second.id, { seats: 0 }, ANA));
  lair.rollSeries(lair.rulesCache, Date.now());
  assert.deepEqual(seated(), [KAI, RIA].sort());
});

test('round 18: staff and the session\'s staff GM can seat anyone in the kept seats, and a seat they add says whether the player is new', async () => {
  await playedBefore();
  const id = (await list({ start: at('2026-10-24', 18), end: at('2026-10-24', 22) })).game.id;
  ok(await newSeats(id, { seats: 3 }, TAMA));
  // Tama (Library only) runs this session: he can reserve seats in it, kept or not; Rangi can't in his own game
  const kai = ok(await addPlayer(id, { customerId: KAI, name: 'Kai Tane', email: 'kai@example.com' }, TAMA));
  assert.equal(kai.booking.newPlayer, false);
  const friend = ok(await addPlayer(id, { name: 'Sam Friend', email: 'sam@example.com', newPlayer: true }, TAMA));
  assert.equal(friend.booking.newPlayer, true);
  // someone with no email can't be known, so isn't new unless they say so
  assert.equal(ok(await addPlayer(id, { name: 'Walk-in' }, TAMA)).booking.newPlayer, false);
  assert.equal(ok(await addPlayer(id, { name: 'Walk-in friend', newPlayer: true }, ANA)).booking.newPlayer, true);
  assert.equal((await gameOn(id)).status, 'full');
  const rangis = (await list({ gm: RANGI, tables: ['B2'], start: at('2026-10-24', 18), end: at('2026-10-24', 22) })).game.id;
  assert.equal(said(await addPlayer(rangis, { name: 'Pat' }, RANGI)), `403 ${W.notYours}`);
  assert.equal(said(await addPlayer(rangis, { name: 'Pat' }, TAMA)), `403 ${W.notYours}`);
  assert.equal(ok(await addPlayer(rangis, { name: 'Pat' }, ANA)).booking.name, 'Pat');
});

test('round 18: a GM who adds a player to their own game isn\'t emailed about them; the player still is', async () => {
  const id = (await list()).game.id;
  const mail = captureEmails();
  try {
    ok(await addPlayer(id, { name: 'Sam Friend', email: 'sam@example.com' }, TAMA));
    await settle();
    assert.deepEqual(mail.sent.map((m) => m.to), ['sam@example.com']);
    mail.sent.length = 0;
    ok(await addPlayer(id, { name: 'Jo Friend', email: 'jo@example.com' }, ANA));
    await settle();
    assert.deepEqual(mail.sent.map((m) => m.to).sort(), ['jo@example.com', 'tama@example.com']);
  } finally {
    mail.restore();
  }
});

/* ---------------- who's in a game, and removing a player ---------------- */

test('round 18: the floor\'s roster, one item per seat, for staff with GM games and the session\'s staff GM only', async () => {
  await playedBefore([[KAI, 'Kai']]);
  const id = (await list({ start: at('2026-10-24', 18), end: at('2026-10-24', 22) })).game.id;
  const rangis = (await list({ gm: RANGI, tables: ['B2'], start: at('2026-10-24', 18), end: at('2026-10-24', 22) })).game.id;
  ok(await newSeats(id, { seats: 2 }, TAMA));
  const kais = ok(await call('POST', 'bookings', {
    kind: 'gm-seat', gameId: id, people: 2, name: 'Kai', email: 'kai@example.com', phone: '021 555 0100', pay: 'day',
    players: [{ name: 'Kai', character: 'Brakka' }, { name: 'Ari', character: '' }],
  }, KAI)).booking;
  const mias = ok(await seat(id, MIA, 'Mia')).booking;
  ok(await call('POST', `bookings/${mias.id}/update`, { paid: true }, OWNER));
  const rosterOf = async (game, who) => (await gameOn(game, who))?.roster;
  const tamas = await rosterOf(id, TAMA);
  assert.deepEqual(tamas, [
    { ref: kais.ref, people: 2, names: ['Kai', 'Ari'], characters: ['Brakka', ''], paid: false, due: 3000, newPlayer: false, regular: false, member: true, here: false },
    { ref: mias.ref, people: 1, names: ['Mia'], characters: [''], paid: true, due: 0, newPlayer: true, regular: false, member: true, here: false },
  ]);
  // Ana and the main account see every game's; Tama not Rangi's; Rangi (not staff) and Hemi (no GM games) none
  assert.deepEqual(await rosterOf(id, ANA), tamas);
  assert.deepEqual(await rosterOf(id, OWNER), tamas);
  assert.equal(await rosterOf(rangis, TAMA), undefined);
  assert.equal(await rosterOf(rangis, RANGI), undefined);
  assert.equal(await rosterOf(id, HEMI), undefined);
  assert.equal(await rosterOf(id, ''), undefined);
  // The roster never has an email or phone
  assert.ok(!JSON.stringify(tamas).includes('@'));
});

test('round 18: staff with GM games and the session\'s staff GM can remove a player (staff page rules: refund due if paid ahead); nobody else', async () => {
  const id = (await list()).game.id;
  const rangis = (await list({ gm: RANGI, tables: ['B2'] })).game.id;
  const mias = ok(await seat(id, MIA, 'Mia', 2)).booking;
  const kais = ok(await seat(id, KAI, 'Kai')).booking;
  const rias = ok(await seat(rangis, RIA, 'Ria')).booking;
  assert.equal(said(await removeSeat(rangis, rias.ref, RANGI)), `403 ${W.notYours}`);
  assert.equal(said(await removeSeat(rangis, rias.ref, TAMA)), `403 ${W.notYours}`);
  assert.equal(said(await removeSeat(id, mias.ref, HEMI)), `403 ${W.notYours}`);
  assert.equal(said(await removeSeat(id, mias.ref, '')), `401 ${W.login}`);
  // a seat from another game, or one that doesn't exist
  assert.equal(said(await removeSeat(id, rias.ref, TAMA)), `404 ${W.noSeat}`);
  assert.equal(said(await removeSeat(id, 'XX-NOPE-1', TAMA)), `404 ${W.noSeat}`);
  // Tama (Library only) removes Mia's seat from his own game, by its reference
  const gone = ok(await removeSeat(id, mias.ref, TAMA));
  assert.equal(gone.booking.status, 'cancelled');
  assert.equal(lair.booking(mias.id).status, 'cancelled');
  assert.equal(said(await removeSeat(id, mias.ref, TAMA)), `404 ${W.noSeat}`);
  assert.deepEqual((await gameOn(id, TAMA)).roster.map((r) => r.ref), [kais.ref]);
  assert.equal((await gameOn(id)).taken, 1);
  // Kai paid at the counter ahead of time: removed, it's owed back, and the staff are told
  ok(await call('POST', `bookings/${kais.id}/update`, { paid: true }, OWNER));
  const mail = captureEmails();
  try {
    const kaiGone = ok(await removeSeat(id, kais.id, ANA));
    assert.deepEqual([kaiGone.refund.due, kaiGone.refund.amount], [true, 1500]);
    assert.equal(lair.booking(kais.id).refund, 'due');
    assert.ok(!JSON.stringify(kaiGone.booking).includes('@'), 'no email in the answer');
    await settle();
    assert.deepEqual(mail.sent.map((m) => [m.to, m.subject]), [['staff@dicegoblin.test', `Refund due: ${kais.ref}`]]);
  } finally {
    mail.restore();
  }
  // Paid, and taken off once it's started: staff decide
  const late = ok(await seat(id, MIA, 'Mia')).booking;
  ok(await call('POST', `bookings/${late.id}/update`, { paid: true }, OWNER));
  Date.now = () => at('2026-10-17', 19);
  const lateGone = ok(await removeSeat(id, late.ref, TAMA));
  assert.deepEqual([lateGone.refund.due, lateGone.refund.ask], [false, true]);
  assert.equal(lair.booking(late.id).refund, 'ask');
  assert.ok(lair.booking(late.id).notes.includes('[Refund?]'));
  // Ana (GM games) in anyone's game
  assert.equal(ok(await removeSeat(rangis, rias.ref, ANA)).booking.status, 'cancelled');
});

/* ---------------- free sessions ---------------- */

test('round 18: staff with GM games make a session free: $0 seats, nothing owed, no GM credit; not while a seat is paid', async () => {
  const id = (await list({ gm: ANA, gmFee: 500 })).game.id;
  const mias = ok(await seat(id, MIA, 'Mia', 2)).booking;
  const kais = ok(await seat(id, KAI, 'Kai')).booking;
  assert.deepEqual([mias.amount, kais.amount], [3000, 1500]);
  ok(await call('POST', `bookings/${kais.id}/update`, { paid: true }, OWNER));
  for (const [who, why] of [[TAMA, `403 ${NOT_PERMITTED}`], [HEMI, `403 ${NOT_PERMITTED}`], [RANGI, '403 Staff only. Log in with your staff account.']]) {
    assert.equal(said(await setFree(id, { free: true }, who)), why);
  }
  for (const free of ['yes', 1, null, undefined]) assert.equal(said(await setFree(id, free === undefined ? {} : { free })), `422 ${W.free}`);
  assert.equal(said(await setFree(id, { free: true, scope: 'all' })), `422 ${W.scope}`);
  assert.equal(said(await setFree(id, { free: true })), `409 ${W.paidAlready(1)}`);
  // Kai's money goes back (staff unmark it: nothing was recorded through the shop), then it can be free
  ok(await call('POST', `bookings/${kais.id}/update`, { paid: false }, OWNER));
  const made = ok(await setFree(id, { free: true }, ANA));
  assert.deepEqual([made.game.free, made.game.seatPrice, made.sessions], [true, 0, 1]);
  assert.deepEqual([lair.booking(mias.id).amount, lair.booking(kais.id).amount], [0, 0]);
  // Nothing on Mia's tab for it
  const mine = (await me(MIA)).seats.find((s) => s.id === mias.id);
  assert.deepEqual([mine.amount, mine.due], [0, 0]);
  // New seats cost nothing, and the confirmation says so
  const mail = captureEmails();
  try {
    const lees = ok(await seat(id, '', 'Lee'));
    assert.equal(lees.booking.amount, 0);
    await settle();
    const told = mail.sent.find((m) => m.to === 'lee@example.com');
    assert.ok(told.text.includes('Nothing to pay'), told.text);
  } finally {
    mail.restore();
  }
  // A staff edit (a new GM fee) keeps it at $0
  ok(await call('POST', `games/${id}/edit`, { gmFee: 1000 }, OWNER));
  assert.deepEqual([lair.booking(mias.id).amount, (await gameOn(id)).seatPrice], [0, 0]);
  // Session done: no GM credit, saying why (even with a seat marked paid)
  ok(await call('POST', `bookings/${mias.id}/update`, { paid: true }, OWNER));
  shopifyOn = true;
  Date.now = () => at('2026-10-17', 23);
  const done = ok(await call('POST', `games/${id}/credit`, {}, OWNER));
  assert.deepEqual([done.amount, done.status, done.note], [0, 'none', W.freeCredit]);
  assert.deepEqual(credited, []);
});

test('round 18: not free any more, the price comes back on unpaid seats of sessions still to start; a series from a session on', async () => {
  const listed = await list({ gm: ANA, gmFee: 500, start: at('2026-10-17', 18), end: at('2026-10-17', 22), schedule: 'weekly' });
  const [first, second, third] = listed.sessions;
  const { seriesId } = listed.game;
  // from the second session on: the first stays as it was, and sessions made later are free too
  const made = ok(await setFree(second.id, { free: true, scope: 'series' }));
  assert.equal(made.sessions, listed.sessions.length - 1);
  const freeOf = (gameId) => Boolean(lair.game(gameId).free);
  assert.deepEqual([freeOf(first.id), freeOf(second.id), freeOf(third.id)], [false, true, true]);
  assert.equal(JSON.parse(lair.sql.exec('SELECT details FROM series WHERE id = ?', seriesId).one().details).free, true);
  // the board says so for the series' sessions to come (series.free), and a session made free alone doesn't
  assert.deepEqual([(await gameOn(second.id, OWNER)).series.free, (await gameOn(second.id, OWNER)).free], [true, true]);
  Date.now = () => at('2026-11-20', 10);
  const extended = lair.extendSeries(lair.rulesCache, Date.now());
  const made2 = lair.sql.exec('SELECT id, free FROM games WHERE series_id = ? AND starts_at > ?', seriesId, at('2026-12-14', 0)).toArray();
  assert.ok(made2.length > 0, JSON.stringify(extended));
  assert.ok(made2.every((g) => g.free === 1));
  // a seat at the third session, then it isn't free any more: $15 again
  Date.now = () => NOW;
  const mias = ok(await seat(third.id, MIA, 'Mia')).booking;
  assert.equal(mias.amount, 0);
  ok(await setFree(third.id, { free: false }));
  // (a series' later sessions are on the staff board, not the public one)
  assert.deepEqual([freeOf(third.id), lair.booking(mias.id).amount, (await gameOn(third.id, OWNER)).seatPrice], [false, 1500, 1500]);
  // a session already started that's made not free keeps its seats at $0 (they played it free)
  const kais = ok(await seat(second.id, KAI, 'Kai')).booking;
  Date.now = () => at('2026-10-24', 19);
  ok(await setFree(second.id, { free: false }));
  assert.equal(lair.booking(kais.id).amount, 0);
});

test('round 18: the GM emails say a free session has no GM credit', async () => {
  const id = (await list({ gm: ANA })).game.id;
  ok(await setFree(id, { free: true }));
  const mail = captureEmails();
  try {
    ok(await changeGm(id, { gmCustomerId: RANGI, gmCustomerName: 'Rangi Hohaia', gm: 'Rangi' }));
    await settle();
    const live = mail.sent.find((m) => m.to === 'rangi@example.com');
    assert.ok(live.text.includes('None: this session is free for the players, so there are no GM fees'), live.text);
  } finally {
    mail.restore();
  }
});

/* ---------------- changing the GM ---------------- */

test('round 18: staff with GM games give a session to another GM; the new GM is told, and the old one too', async () => {
  const id = (await list({ gm: RANGI })).game.id;
  for (const who of [TAMA, HEMI, RANGI]) assert.ok([`403 ${NOT_PERMITTED}`, '403 Staff only. Log in with your staff account.'].includes(said(await changeGm(id, { gmCustomerId: ANA, gm: 'Ana' }, who))));
  assert.equal(said(await changeGm(id, {})), `422 ${W.gmWho}`);
  assert.equal(said(await changeGm(id, { gmEmail: 'not-an-email' })), `422 ${W.gmEmail}`);
  assert.equal(said(await changeGm(id, { gmCustomerId: RANGI, gm: 'Rangi' })), `422 ${W.gmSame}`);
  assert.equal(said(await changeGm(id, { scope: 'everything', gmCustomerId: ANA, gm: 'Ana' })), `422 ${W.scope}`);
  const mail = captureEmails();
  try {
    const changed = ok(await changeGm(id, { gmCustomerId: ANA, gmCustomerName: 'Ana Ngata', gm: 'Ana' }, ANA));
    assert.deepEqual([changed.game.gm, changed.sessions, changed.invited], ['Ana', 1, undefined]);
    const game = lair.game(id);
    assert.deepEqual([game.gm, game.gmCustomerId, game.gmEmail], ['Ana', ANA, 'ana@example.com']);
    const hold = lair.gameBookings(id).find((b) => b.kind === 'gm');
    assert.deepEqual([hold.customerId, hold.name], [ANA, 'GM Ana']);
    await settle();
    assert.deepEqual(mail.sent.map((m) => [m.to, m.subject]).sort(), [
      ['ana@example.com', `Your game is live: ${game.title}`],
      ['rangi@example.com', `${game.title}: a new GM`],
    ]);
    assert.ok(mail.sent.find((m) => m.to === 'rangi@example.com').text.includes('the Dice Goblin team has given'));
  } finally {
    mail.restore();
  }
  // Ana's game now: she can run it, and the name players see can change on its own
  assert.ok((await gameOn(id, ANA)).roster);
  assert.equal(ok(await changeGm(id, { gmCustomerId: ANA, gm: 'Ana N.' })).game.gm, 'Ana N.');
});

test('round 18: a new GM by email: a member\'s links them; anyone else is invited and the game joins their account when they log in', async () => {
  const id = (await list({ gm: RANGI })).game.id;
  // Mia's email: her account
  const toMia = ok(await changeGm(id, { gmEmail: 'MIA@example.com', gm: 'Mia' }));
  assert.equal(toMia.invited, undefined);
  assert.equal(lair.game(id).gmCustomerId, MIA);
  // nobody's email: invited, and the game is waiting for them
  assert.equal(said(await changeGm(id, { gmEmail: 'new.gm@example.com' })), `422 ${W.gmName}`);
  const mail = captureEmails();
  try {
    const invited = ok(await changeGm(id, { gmEmail: 'new.gm@example.com', gm: 'Nova' }));
    assert.equal(invited.invited, true);
    assert.equal(invited.notice, 'Gobgob emailed new.gm@example.com to make an account. The game joins their account when they log in with that email.');
    assert.deepEqual([lair.game(id).gmCustomerId, lair.game(id).gmEmail], [null, 'new.gm@example.com']);
    await settle();
    // the GM before (Mia, by the email as it was typed) and the new one
    assert.deepEqual(mail.sent.map((m) => m.to).sort(), ['MIA@example.com', 'new.gm@example.com']);
  } finally {
    mail.restore();
  }
  // they make an account with that email: the game's theirs
  lair.makeMember({ customerId: '7001', name: 'Nova Lee', email: 'new.gm@example.com' }, Date.now());
  lair.adoptGmGames('7001', 'new.gm@example.com', Date.now());
  assert.equal(lair.game(id).gmCustomerId, '7001');
});

test('round 18: a new GM for a series from a session on; a session already credited keeps its GM', async () => {
  const listed = await list({ gm: RANGI, schedule: 'weekly' });
  const [first, second] = listed.sessions;
  const { seriesId } = listed.game;
  const changed = ok(await changeGm(second.id, { gmCustomerId: ANA, gmCustomerName: 'Ana Ngata', gm: 'Ana', scope: 'series' }));
  assert.equal(changed.sessions, listed.sessions.length - 1);
  assert.deepEqual([lair.game(first.id).gmCustomerId, lair.game(second.id).gmCustomerId], [RANGI, ANA]);
  const series = lair.sql.exec('SELECT gm_customer_id, details FROM series WHERE id = ?', seriesId).one();
  assert.equal(series.gm_customer_id, ANA);
  assert.deepEqual([JSON.parse(series.details).gm, JSON.parse(series.details).gmEmail], ['Ana', 'ana@example.com']);
  // sessions made later are Ana's
  Date.now = () => at('2026-11-20', 10);
  lair.extendSeries(lair.rulesCache, Date.now());
  const later = lair.sql.exec('SELECT gm_customer_id, gm FROM games WHERE series_id = ? AND starts_at > ?', seriesId, at('2026-12-14', 0)).toArray();
  assert.ok(later.length > 0);
  assert.ok(later.every((g) => g.gm_customer_id === ANA && g.gm === 'Ana'));
  // the first session, done and credited, keeps Rangi
  shopifyOn = true;
  Date.now = () => at('2026-10-17', 23);
  ok(await call('POST', `games/${first.id}/credit`, {}, OWNER));
  assert.equal(said(await changeGm(first.id, { gmCustomerId: ANA, gm: 'Ana' })), `409 ${W.gmCredited}`);
});

/* ---------------- from the independent review: a series with more than one GM, money, and limits ---------------- */

test('round 18: a series with more than one GM: each GM cancels, adds dates to and messages only what\'s theirs', async () => {
  const listed = await list({ gm: RANGI, schedule: 'weekly' });
  const [s1, s2, s3] = listed.sessions;
  const { seriesId } = listed.game;
  const kais = ok(await seat(s1.id, KAI, 'Kai')).booking;
  // Mia is given one session in the middle: cancelling "every session" from it cancels hers alone, and not the series
  ok(await changeGm(s2.id, { gmCustomerId: MIA, gmCustomerName: 'Mia Chen', gm: 'Mia' }));
  ok(await call('POST', `games/${s2.id}/update`, { status: 'cancelled', scope: 'series' }, MIA));
  assert.deepEqual([lair.game(s1.id).status, lair.game(s2.id).status, lair.game(s3.id).status], ['open', 'cancelled', 'open']);
  assert.equal(lair.booking(kais.id).status, 'confirmed');
  assert.equal(lair.sql.exec('SELECT status FROM series WHERE id = ?', seriesId).one().status, 'active');
  // the series from session 3 on is Ana's: Rangi (session 1, now over) can't cancel hers, add a date, or message her players
  ok(await changeGm(s3.id, { gmCustomerId: ANA, gmCustomerName: 'Ana Ngata', gm: 'Ana', scope: 'series' }));
  const rias = ok(await seat(s3.id, RIA, 'Ria')).booking;
  Date.now = () => at('2026-10-18', 10);
  ok(await call('POST', `games/${s1.id}/update`, { status: 'cancelled', scope: 'series' }, RANGI));
  assert.deepEqual([lair.game(s3.id).status, lair.booking(rias.id).status], ['open', 'confirmed']);
  assert.equal(lair.sql.exec('SELECT status FROM series WHERE id = ?', seriesId).one().status, 'active');
  assert.equal(said(await call('POST', `games/${s1.id}/sessions`, { start: at('2026-10-20', 18), end: at('2026-10-20', 22), tables: ['B1'] }, RANGI)), '403 Only the GM or staff can add a session.');
  // staff adding a date from Rangi's old session: it's Ana's, as the series is now
  const added = ok(await call('POST', `games/${s1.id}/sessions`, { start: at('2026-10-20', 18), end: at('2026-10-20', 22), tables: ['B1'] }, OWNER));
  assert.deepEqual([lair.game(added.game.id).gmCustomerId, lair.game(added.game.id).gm], [ANA, 'Ana']);
  const mail = captureEmails();
  try {
    const sent = ok(await call('POST', `games/${s1.id}/message`, { text: 'Hi all, this is Rangi', scope: 'series' }, RANGI));
    await settle();
    assert.equal(sent.sent, 0);
    assert.deepEqual(mail.sent, []);
    // Ana, the series' GM now, reaches its players
    const hers = ok(await call('POST', `games/${s3.id}/message`, { text: 'Hi all, this is Ana', scope: 'series' }, ANA));
    assert.equal(hers.sent, 1);
  } finally {
    mail.restore();
  }
});

test('round 18: Session done for a free session records it with no GM credit, whatever the button said (a staff GM\'s too)', async () => {
  const id = (await list({ gm: TAMA })).game.id;
  ok(await setFree(id, { free: true }));
  ok(await seat(id, MIA, 'Mia'));
  shopifyOn = true;
  Date.now = () => at('2026-10-17', 23);
  // a free session isn't weighed for GM credit for staff: nothing on the floor for it
  assert.equal((await gameOn(id, OWNER)).staffGm, undefined);
  const done = ok(await call('POST', `games/${id}/credit`, { expect: 'none' }, OWNER));
  assert.deepEqual([done.amount, done.status, done.note], [0, 'none', W.freeCredit]);
  assert.deepEqual(credited, []);
});

test('round 18: not free any more, a $0 seat marked paid owes the price; a $0 seat never earns GM credit', async () => {
  const id = (await list({ gm: RANGI, gmFee: 500 })).game.id;
  ok(await setFree(id, { free: true }));
  const mias = ok(await seat(id, MIA, 'Mia')).booking;
  ok(await call('POST', `bookings/${mias.id}/update`, { paid: true }, OWNER));
  const back = ok(await setFree(id, { free: false }));
  assert.deepEqual([back.priced, back.stayFree], [1, 0]);
  const b = lair.booking(mias.id);
  assert.deepEqual([b.amount, b.paid, b.paidAmount], [1500, false, 0]);
  assert.equal((await me(MIA)).seats.find((s) => s.id === mias.id).due, 1500);
  // another session made free after it started: its $0 seat marked paid earns no credit
  const later = (await list({ gm: RANGI, gmFee: 500, tables: ['B2'] })).game.id;
  ok(await setFree(later, { free: true }));
  const kais = ok(await seat(later, KAI, 'Kai')).booking;
  ok(await call('POST', `bookings/${kais.id}/update`, { paid: true }, OWNER));
  Date.now = () => at('2026-10-17', 19);
  const notFree = ok(await setFree(later, { free: false }));
  assert.deepEqual([notFree.priced, notFree.stayFree, lair.booking(kais.id).amount], [0, 1, 0]);
  shopifyOn = true;
  Date.now = () => at('2026-10-17', 23);
  const done = ok(await call('POST', `games/${later}/credit`, {}, OWNER));
  assert.deepEqual([done.players, done.amount], [0, 0]);
  assert.deepEqual(credited, []);
});

test('round 18: not free any more inside the 24 hours, seats booked free stay free; outside them, their players are emailed the price', async () => {
  const soon = (await list({ gm: RANGI, gmFee: 500 })).game.id; // Saturday 6pm
  const later = (await list({ gm: RANGI, gmFee: 500, start: at('2026-10-24', 18), end: at('2026-10-24', 22) })).game.id;
  ok(await setFree(soon, { free: true }));
  ok(await setFree(later, { free: true }));
  const mias = ok(await seat(soon, MIA, 'Mia')).booking;
  const kais = ok(await seat(later, KAI, 'Kai')).booking;
  Date.now = () => at('2026-10-17', 9); // 9 hours before Saturday's
  const mail = captureEmails();
  try {
    const kept = ok(await setFree(soon, { free: false }));
    assert.deepEqual([kept.priced, kept.stayFree, lair.booking(mias.id).amount], [0, 1, 0]);
    // she can still cancel it (a $0 seat isn't locked)
    const priced = ok(await setFree(later, { free: false }));
    assert.deepEqual([priced.priced, priced.stayFree, lair.booking(kais.id).amount], [1, 0, 1500]);
    await settle();
    const told = mail.sent.filter((m) => m.to === 'kai@example.com');
    assert.equal(told.length, 1);
    assert.match(told[0].subject, /: not free any more$/);
    assert.ok(told[0].text.includes("isn't free any more, so your seat is $15.00 on your tab. Can't make it? Cancel it in My Lair by"), told[0].text);
    assert.ok(!mail.sent.some((m) => m.to === 'mia@example.com'));
  } finally {
    mail.restore();
  }
  assert.equal(ok(await call('POST', `bookings/${mias.id}/update`, { status: 'cancelled' }, MIA)).booking.status, 'cancelled');
});

test('round 18: a staff GM can\'t remove, add or keep seats in their session once it\'s over; staff with GM games can', async () => {
  const id = (await list()).game.id;
  const mias = ok(await seat(id, MIA, 'Mia')).booking;
  Date.now = () => at('2026-10-18', 10);
  assert.equal(said(await removeSeat(id, mias.ref, TAMA)), `403 ${W.over}`);
  assert.equal(said(await addPlayer(id, { customerId: KAI, name: 'Kai Tane' }, TAMA)), `403 ${W.over}`);
  assert.equal(said(await newSeats(id, { seats: 1 }, TAMA)), `403 ${W.over}`);
  // the seat's still owed
  assert.equal((await me(MIA)).seats.find((s) => s.id === mias.id).owed, true);
  assert.equal(ok(await removeSeat(id, mias.ref, ANA)).booking.status, 'cancelled');
});

test('round 18: a seat on a session pass stops the session being made free, and taking it off asks the staff', async () => {
  const id = (await list({ gm: RANGI, gmFee: 500 })).game.id;
  const pass = ok(await call('POST', 'passes', { label: 'Ten sessions', sessions: 10, customerId: MIA }, OWNER)).pass;
  const booked = ok(await call('POST', 'bookings', { kind: 'gm-seat', gameId: id, people: 1, name: 'Mia', email: 'mia@example.com', phone: '021 555 0100', usePass: pass.code }, MIA)).booking;
  Date.now = () => at('2026-10-17', 17);
  ok(await call('POST', 'checkin', { id: booked.id }, OWNER));
  assert.ok(lair.booking(booked.id).covered > 0);
  assert.equal(said(await setFree(id, { free: true })), `409 ${W.paidAlready(1)}`);
  const mail = captureEmails();
  try {
    const gone = ok(await removeSeat(id, booked.ref, ANA));
    assert.deepEqual([gone.refund.due, gone.refund.ask], [false, true]);
    assert.equal(lair.booking(booked.id).refund, 'ask');
    await settle();
    const told = mail.sent.find((m) => m.to === 'staff@dicegoblin.test');
    assert.match(told.subject, /^Refund\? /);
    assert.ok(told.text.includes('A session pass covered $10.00 of it: undo that on the staff page if it should come back.'), told.text);
  } finally {
    mail.restore();
  }
});

test('round 18: making a past session free leaves no bill open for its seat', async () => {
  const id = (await list({ gm: RANGI, gmFee: 500 })).game.id;
  ok(await call('POST', `members/${KAI}/account`, { billing: 'monthly', creditLimit: 20000 }, OWNER));
  ok(await seat(id, KAI, 'Kai'));
  Date.now = () => at('2026-10-18', 10);
  const bill = ok(await call('POST', `accounts/${KAI}/bill`, {}, OWNER)).bill;
  assert.deepEqual([bill.status, bill.total], ['open', 1500]);
  ok(await setFree(id, { free: true }));
  assert.equal(lair.sql.exec('SELECT status FROM tab_bills WHERE id = ?', bill.id).one().status, 'void');
});

test('round 18: a new GM brings their own bio (none yet: none), for the sessions made later too', async () => {
  const listed = ok(await call('POST', 'games', {
    title: 'Bio test', system: 'D&D 5e', gm: 'Rangi', blurb: 'A test session.', seats: 4, tables: ['B1'], start: at('2026-10-17', 18), end: at('2026-10-17', 22),
    gmCustomerId: RANGI, gmCustomerName: 'Rangi', gmEmail: 'rangi@example.com', gmBio: "I'm Rangi, I've run Strahd 6 times.", schedule: 'weekly',
  }, OWNER));
  ok(await call('POST', 'gm-profile', { name: 'Ana', bio: 'Ana runs cosy one-shots.' }, ANA));
  ok(await changeGm(listed.game.id, { gmCustomerId: ANA, gmCustomerName: 'Ana Ngata', gm: 'Ana', scope: 'series' }));
  const g = await gameOn(listed.game.id);
  assert.deepEqual([g.gm, g.gmBio], ['Ana', 'Ana runs cosy one-shots.']);
  Date.now = () => at('2026-11-20', 10);
  lair.extendSeries(lair.rulesCache, Date.now());
  const made = lair.sql.exec('SELECT gm_bio FROM games WHERE series_id = ? AND starts_at > ?', listed.game.seriesId, at('2026-12-14', 0)).toArray();
  assert.ok(made.length > 0 && made.every((r) => r.gm_bio === 'Ana runs cosy one-shots.'), JSON.stringify(made));
  // someone with no GM profile: no bio (not Ana's)
  Date.now = () => NOW;
  const one = (await list({ gm: ANA, tables: ['B2'] })).game.id;
  ok(await changeGm(one, { gmCustomerId: MIA, gmCustomerName: 'Mia Chen', gm: 'Mia' }));
  assert.equal(lair.game(one).gmBio, '');
});

test('round 18: a staff GM\'s seats for new players for a series change only their own sessions', async () => {
  const listed = await list({ gm: TAMA, schedule: 'weekly' });
  const [s1, s2, s3] = listed.sessions;
  ok(await changeGm(s2.id, { gmCustomerId: RANGI, gmCustomerName: 'Rangi Hohaia', gm: 'Rangi' }));
  assert.equal(said(await newSeats(s2.id, { seats: 1 }, TAMA)), `403 ${W.notYours}`);
  const set = ok(await newSeats(s1.id, { seats: 2, scope: 'series' }, TAMA));
  assert.equal(set.sessions, listed.sessions.length - 1);
  assert.deepEqual([lair.game(s1.id).newSeats, lair.game(s2.id).newSeats, lair.game(s3.id).newSeats], [2, 0, 2]);
});

test('round 18: a new GM with a bad scope saves nothing, not even their member record', async () => {
  const id = (await list({ gm: RANGI })).game.id;
  assert.equal(said(await changeGm(id, { gmCustomerId: '7777', gmCustomerName: 'New Person', gmEmail: 'np@example.com', gm: 'NP', scope: 'bogus' })), `422 ${W.scope}`);
  assert.equal(lair.memberRow('7777'), null);
  assert.equal(lair.game(id).gmCustomerId, RANGI);
});

test('round 18: someone joining a series isn\'t kept out by a new regular ahead of them, who takes the kept seat', async () => {
  await playedBefore([[KAI, 'Kai']]);
  const listed = await list({ gm: ANA, start: at('2026-10-24', 18), end: at('2026-10-24', 22), seats: 2, schedule: 'weekly' });
  const [first] = listed.sessions;
  ok(await newSeats(first.id, { seats: 1 }, ANA));
  // Mia (new) is a regular waiting for a seat there, ahead of Kai
  lair.write(
    "INSERT INTO series_members (series_id, customer_id, people, players, name, email, status, created_at, updated_at) VALUES (?, ?, 1, '[]', 'Mia', 'mia@example.com', 'active', ?, ?)",
    listed.game.seriesId, MIA, Date.now() - 1000, Date.now() - 1000,
  );
  const kai = ok(await call('POST', `games/${first.id}/join-series`, { people: 1, name: 'Kai', email: 'kai@example.com', phone: '021 555 0100' }, KAI));
  assert.equal(kai.booked.length, 1);
  lair.rollSeries(lair.rulesCache, Date.now());
  assert.deepEqual(lair.gameBookings(first.id).filter((b) => b.kind === 'gm-seat' && b.status === 'confirmed').map((b) => b.customerId).sort(), [KAI, MIA].sort());
});

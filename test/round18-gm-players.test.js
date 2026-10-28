// A GM sees their players on every session (17 Oct 2026, contract v18-gm-players). Mo: "I have a user who is asking me
// that he wants to see his players etc. if you see the mobile view I can see my players but he cannot see his please
// make it that all gms can see their players across the site". Dan's Icewind Dale said "3 of 6 seats taken" over "No
// players yet": its three weekly regulars are booked into the series' next session only (rollSeries), and staff gave
// Dan the game from the session after it, where their seats are held with nobody booked. GET /me and GET /floor now
// list a session's regulars whose seats it saves but hasn't booked yet (saved: true), in the order maintenance seats
// them, and "Message your players" reaches them. Run with: npm test (under TZ=UTC and TZ=Pacific/Auckland)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Saturday 17 October 2026, 11:15pm in Auckland (NZDT, UTC+13): when Dan asked
const NOW = Date.UTC(2026, 9, 17, 10, 15);
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
// The main account; Dan, a GM who isn't on the team; players
const OWNER = '9001';
const DAN = '5101';
const MIA = '6001';
const KAI = '6002';
const RIA = '6003';
const LEO = '6004';
const ZOE = '6005';

let lair;
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
const job = (kind, payload = {}) => call('POST', 'internal/admin-job', { id: 'job1', kind, payload }, '', { 'X-Lair-Internal': '1' });
const board = async (who = '') => ok(await call('GET', `floor?from=${at('2026-10-17', 0)}&to=${at('2026-12-31', 0)}`, null, who));
const gameOn = async (id, who = '') => (await board(who)).games.find((g) => g.id === id);
const me = async (who) => ok(await call('GET', 'me', null, who));
const join = (gameId, who, name, more = {}) => call('POST', `games/${gameId}/join-series`, { people: 1, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100', ...more }, who);
const names = (players) => players.map((p) => p.name);
const sessionsOf = (seriesId) => lair.sql.exec("SELECT id, starts_at FROM games WHERE series_id = ? AND status != 'cancelled' ORDER BY starts_at", seriesId).toArray();

/** Dan's game as Mo's GM list loaded it (round 11's games.add: no GM account), Fridays 6pm to 10pm from 23 October */
async function icewindDale(over = {}) {
  const added = ok(await job('games.add', { games: [{
    title: 'Icewind Dale', system: 'D&D 5e', gm: 'Dan', blurb: "Dan's weekly Rime of the Frostmaiden campaign.", seats: 6, offlinePlayers: 0,
    gmFee: 500, schedule: 'weekly', start: at('2026-10-23', 18), end: at('2026-10-23', 22), tables: ['T4', 'T5'], level: 'some', age: '13+', ...over,
  }] }));
  assert.deepEqual(added.failed, []);
  const { seriesId } = added.added[0];
  return { seriesId, sessions: sessionsOf(seriesId).map((r) => r.id) };
}

/** Staff give the game to Dan's account from a session on (POST /games/:id/gm, scope 'series') */
const giveToDan = async (fromId) => ok(await call('POST', `games/${fromId}/gm`, { gmCustomerId: DAN, gmCustomerName: 'Dan Kerr', gmEmail: 'dan@example.com', gm: 'Dan', scope: 'series' }, OWNER));

function captureEmails() {
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test' };
  lair.env = { ...lair.env, ...lair.baseEnv };
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.resend.com/')) {
      reached.push(String(url));
      throw new Error(`No network in tests: ${url}`);
    }
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return sent;
}
const settle = () => new Promise((r) => setTimeout(r, 10));

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
  for (const [id, name] of [[DAN, 'Dan Kerr'], [MIA, 'Mia Chen'], [KAI, 'Kai Tane'], [RIA, 'Ria Moana'], [LEO, 'Leo Park'], [ZOE, 'Zoe Hart']]) {
    lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
  }
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

test('gm players: Dan\'s first session after the series\' next one lists its three regulars (saved), where it said "3 of 6 seats taken" over nobody', async () => {
  const { sessions } = await icewindDale();
  const [first, second, third] = sessions;
  await giveToDan(second);
  ok(await join(first, MIA, 'Mia', { players: [{ name: 'Mia', character: 'Thorin Frostbeard' }] }));
  ok(await join(first, KAI, 'Kai'));
  ok(await join(first, RIA, 'Ria'));

  // My Lair › Games I run: his sessions start at the second (the first isn't on his account), and it lists them all
  const mine = await me(DAN);
  assert.ok(!mine.games.some((g) => g.id === first), 'the first session is still the old GM\'s');
  const next = mine.games.find((g) => g.id === second);
  assert.equal(next.taken, 3);
  assert.equal(next.held, 3, 'their seats are held there, not booked');
  assert.deepEqual(names(next.players), ['Mia', 'Kai', 'Ria'], 'first to join first');
  assert.deepEqual(next.players[0], {
    name: 'Mia', character: 'Thorin Frostbeard', ref: null, paid: false, arrived: false, member: true, regular: true, saved: true,
    pronouns: '', favouriteGames: [], about: '',
  });
  assert.ok(next.players.every((p) => p.saved && p.regular && p.ref === null && !p.paid));
  assert.ok(!JSON.stringify(next.players).includes('@') && !JSON.stringify(next.players).includes('021'), 'never an email or a mobile');
  // every session after the next one too
  assert.deepEqual(names(mine.games.find((g) => g.id === third).players), ['Mia', 'Kai', 'Ria']);

  // The games board: his own sessions carry the same players; the public board never has players
  assert.deepEqual(names((await gameOn(second, DAN)).players), ['Mia', 'Kai', 'Ria']);
  assert.equal((await gameOn(first, '')).players, undefined);
  assert.equal((await gameOn(first, MIA)).players, undefined, 'a player sees no roster');
  // The series is his now, so the website shows him its next session as his game too (Your game): its players are
  // there, booked, though that session isn't on his account
  const theirs = await gameOn(first, DAN);
  assert.deepEqual(names(theirs.players), ['Mia', 'Kai', 'Ria']);
  assert.ok(theirs.players.every((p) => !p.saved && p.ref));
  assert.equal(theirs.roster, undefined, 'nothing to run there: he isn\'t staff');

  // Staff: the series' next session lists the three booked (no saved twice), the session after lists them saved
  const staffFirst = await gameOn(first, OWNER);
  assert.deepEqual(names(staffFirst.players), ['Mia', 'Kai', 'Ria']);
  assert.ok(staffFirst.players.every((p) => !p.saved && p.ref), 'booked there, each with their seat\'s code');
  assert.ok(staffFirst.roster.every((r) => r.ref), 'the roster is still one row per booking');
  assert.ok((await gameOn(second, OWNER)).players.every((p) => p.saved));
});

test('gm players: once the session before ends, maintenance books exactly the regulars the list said, and they\'re booked, not saved', async () => {
  const { seriesId, sessions } = await icewindDale();
  const [first, second] = sessions;
  await giveToDan(second);
  for (const [who, name] of [[MIA, 'Mia'], [KAI, 'Kai'], [RIA, 'Ria']]) ok(await join(first, who, name));
  const listed = names((await me(DAN)).games.find((g) => g.id === second).players);

  // 10:30pm Friday 23 October: the first session has ended
  Date.now = () => at('2026-10-23', 22, 30);
  const rules = await lair.rules();
  lair.rollSeries(rules, Date.now());
  const booked = lair.sql.exec("SELECT name FROM bookings WHERE game_id = ? AND kind = 'gm-seat' AND status = 'confirmed' ORDER BY created_at", second).toArray().map((r) => r.name);
  assert.deepEqual(booked, listed);
  const after = (await me(DAN)).games.find((g) => g.id === second);
  assert.deepEqual(names(after.players), listed);
  assert.ok(after.players.every((p) => !p.saved && p.ref && p.regular), 'booked now, each with a seat code');
  assert.equal(after.held, 0);
  // and the session after that saves them in turn
  assert.ok((await me(DAN)).games.find((g) => g.id === sessionsOf(seriesId)[2].id).players.every((p) => p.saved));
});

test('gm players: saved seats are listed in maintenance\'s order and only while they fit: seats booked or kept for new players come first, and a party that doesn\'t fit keeps nothing from the next', async () => {
  const { sessions } = await icewindDale();
  const [first, second] = sessions;
  await giveToDan(second);
  // a one-off seat at the second session, four regulars (Kai with two friends), and staff keep 2 seats there for new
  // players: 6 − 1 booked − 2 kept = 3 for regulars
  ok(await call('POST', 'bookings', { kind: 'gm-seat', gameId: second, people: 1, name: 'Zoe', email: 'zoe@example.com', phone: '021 555 0100', pay: 'day' }, ZOE));
  ok(await join(first, MIA, 'Mia'));
  ok(await join(first, KAI, 'Kai', { people: 3, players: [{ name: 'Kai' }, { name: 'Ari' }, { name: 'Tui' }] }));
  ok(await join(first, RIA, 'Ria'));
  ok(await join(first, LEO, 'Leo'));
  ok(await call('POST', `games/${second}/new-seats`, { seats: 2 }, OWNER));

  const game = (await me(DAN)).games.find((g) => g.id === second);
  // Mia (1) fits, Kai's 3 don't fit in the 2 left, Ria (1) and Leo (1) do: what maintenance would seat
  assert.deepEqual(names(game.players), ['Zoe', 'Mia', 'Ria', 'Leo']);
  assert.ok(!game.players[0].saved && game.players.slice(1).every((p) => p.saved));
  assert.equal(game.taken, 6, 'the board\'s count is the same: 1 booked, 2 kept for new players, 3 held');
  assert.equal(game.newLeft, undefined, 'a GM still never hears of seats kept for new players');

  // Kai's party of three: listed as three players at a session with room
  const third = (await me(DAN)).games.find((g) => g.id === sessions[2]);
  assert.deepEqual(names(third.players), ['Mia', 'Kai', 'Ari', 'Tui', 'Ria', 'Leo']);
});

test('gm players: a regular who leaves, a series that ends, a cancelled session or one under way saves nobody', async () => {
  const { seriesId, sessions } = await icewindDale();
  const [first, second, third, fourth] = sessions;
  await giveToDan(second);
  ok(await join(first, MIA, 'Mia'));
  ok(await join(first, KAI, 'Kai'));

  ok(await call('POST', `series/${seriesId}/leave`, {}, KAI));
  assert.deepEqual(names((await me(DAN)).games.find((g) => g.id === second).players), ['Mia'], 'Kai left');

  // Dan can't make the third: nobody's saved in a cancelled session
  ok(await call('POST', `games/${third}/update`, { status: 'cancelled', scope: 'session' }, DAN));
  assert.deepEqual((await me(DAN)).games.find((g) => g.id === third).players, []);
  assert.deepEqual(names((await me(DAN)).games.find((g) => g.id === fourth).players), ['Mia']);

  // the second under way (7pm Friday 30 October) with Mia not booked (say the first was cancelled late): nobody's
  // seated in a session that's started, so nobody's saved there either
  Date.now = () => at('2026-10-30', 19);
  assert.deepEqual((await me(DAN)).games.find((g) => g.id === second).players, []);
});

test('gm players: "Message your players" for a session after the next one reaches its regulars; nobody twice, and the series\' players for every session', async () => {
  const { sessions } = await icewindDale();
  const [first, second] = sessions;
  await giveToDan(second);
  ok(await join(first, MIA, 'Mia'));
  ok(await join(first, KAI, 'Kai'));
  ok(await call('POST', 'bookings', { kind: 'gm-seat', gameId: second, people: 1, name: 'Zoe', email: 'zoe@example.com', phone: '021 555 0100', pay: 'day' }, ZOE));
  const sent = captureEmails();

  const session = ok(await call('POST', `games/${second}/message`, { text: 'Bring warm clothes!', scope: 'session' }, DAN));
  await settle();
  assert.equal(session.sent, 3);
  assert.deepEqual(sent.map((m) => m.to).sort(), ['kai@example.com', 'mia@example.com', 'zoe@example.com']);

  sent.length = 0;
  const series = ok(await call('POST', `games/${second}/message`, { text: 'Session zero notes are up.', scope: 'series' }, DAN));
  await settle();
  assert.equal(series.sent, 3, 'each player once');
  assert.deepEqual(sent.map((m) => m.to).sort(), ['kai@example.com', 'mia@example.com', 'zoe@example.com']);
});

test('gm players: a GM who runs only some of a series messages the regulars saved in their own sessions, not the rest', async () => {
  const { sessions } = await icewindDale();
  const [first, second, third] = sessions;
  ok(await join(first, MIA, 'Mia'));
  // Dan runs just the third (staff gave him that one session); the series stays the old GM's
  ok(await call('POST', `games/${third}/gm`, { gmCustomerId: DAN, gmCustomerName: 'Dan Kerr', gmEmail: 'dan@example.com', gm: 'Dan', scope: 'session' }, OWNER));
  ok(await call('POST', 'bookings', { kind: 'gm-seat', gameId: second, people: 1, name: 'Zoe', email: 'zoe@example.com', phone: '021 555 0100', pay: 'day' }, ZOE));
  const sent = captureEmails();
  const res = ok(await call('POST', `games/${third}/message`, { text: 'See you on the 6th!', scope: 'series' }, DAN));
  await settle();
  assert.equal(res.sent, 1);
  assert.deepEqual(sent.map((m) => m.to), ['mia@example.com'], 'Mia is saved in his session; Zoe\'s seat is in someone else\'s');
  assert.deepEqual(names((await me(DAN)).games.find((g) => g.id === third).players), ['Mia']);
  // the series isn't his: the sessions he doesn't run show him no players on the board
  assert.equal((await gameOn(first, DAN)).players, undefined);
  assert.deepEqual(names((await gameOn(third, DAN)).players), ['Mia']);
});

// Round 31, open games (contract v31-open-games; Warhammer and hobby chat, Mo's picks 2 to 6 Nov 2026): a member with no
// opponent lists a pair of tables on a game night as looking for a game (a game and size from lists, new players welcome
// or not), members see it with the booker's first name (logged out, "A player"), the first member to join gets the game,
// and the Lair posts it to Discord without a name, edited once it's taken. Mo: "On the booking + Discord"; "Free to
// cancel until it starts" while nobody's joined; an email that afternoon asking if they're still coming; and, from the
// same chat, "Warhammer Night's unbooked pairs open to anyone to book from 6pm on the night".
// Run with: node --test test/   (under TZ=UTC and TZ=Pacific/Auckland)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings } from '../src/core.js';
import { OPEN_GAME_LIST, OPEN_GAME_WORDS } from '../src/open-games.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Thursday 15 October 2026, 1:00pm in Auckland (NZDT, UTC+13): Warhammer night is tonight, 6pm to midnight
const NOW = Date.UTC(2026, 9, 15, 0, 0);
const realNow = Date.now;
const realFetch = globalThis.fetch;

function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
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
  { id: 'main-room', name: 'Main room', code: 'T', tables: 21, seats: 4, order: 1 },
  { id: 'party-room', name: 'Party room', code: 'P', tables: 4, seats: 4, order: 2 },
];
const HOURS = 'Mon 16:00-24:00\nTue 16:00-24:00\nWed 16:00-24:00\nThu 16:00-24:00\nFri 16:00-24:00\nSat 10:00-24:00\nSun 10:00-22:00';
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const TODAY = '2026-10-15';
const EVENTS = [{
  id: 'warhammer-night', title: 'Warhammer night', type: 'wargame', start: at(TODAY, 18), end: at('2026-10-16', 0), repeat: 'weekly', tables: 'T8-T21',
  lockTables: true, gameTables: 'T8+T9, T10+T11, T12+T13, T14+T15, T18+T19, T20+T21', entryFee: 1000,
}];
const TONIGHT = `warhammer-night@${TODAY}`;
const NEXT_WEEK = 'warhammer-night@2026-10-22';
const MOBILE = '021 555 0100';
const SAM = '1001';
const KIRI = '1002';
const TAMA = '1003';
const HOOK = 'https://discord.test/api/webhooks/123/token-abc';

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
const internal = (path, body) => call('POST', `internal/${path}`, body, '', { 'X-Lair-Internal': '1' });
const me = async (who) => (await call('GET', 'me', null, who)).data;
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
/** Sam lists T10 + T11 tonight: Warhammer 40,000, 1,000 points, new players welcome */
const list = (body = {}, who = SAM, date = TONIGHT) => call('POST', `events/${date}/reserve`, {
  name: 'Sam Jones', email: 'sam@example.com', phone: MOBILE, people: 2, spot: 'T10+T11', looking: { game: '40k', size: '1000', newPlayers: true }, ...body,
}, who);
const openGames = (who = '', query = '') => call('GET', `open-games${query}`, null, who);
const dateOf = (data, occurrenceId = TONIGHT) => data.dates.find((d) => d.occurrenceId === occurrenceId);
const join = (id, who) => call('POST', `open-games/${encodeURIComponent(id)}/join`, {}, who);
const leave = (id, who) => call('POST', `open-games/${encodeURIComponent(id)}/leave`, {}, who);
const cancelBooking = (id, who) => call('POST', `bookings/${id}/update`, { status: 'cancelled' }, who);
const runAt = (ms) => internal('open-games', { at: ms });
const settle = () => new Promise((r) => setTimeout(r, 10));
const playerRows = () => lair.sql.exec('SELECT * FROM booking_players ORDER BY position, rowid').toArray();
const words = (m) => `${m.subject}\n${m.text || ''}\n${m.html || ''}`;

/** Emails (as Resend gets them) and Discord calls (as its webhook gets them); discord: false leaves the webhook unset */
function capture({ discord = true, failPosts = 0 } = {}) {
  lair.baseEnv = {
    ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test',
    ...(discord ? { DISCORD_WARHAMMER_WEBHOOK: HOOK } : {}),
  };
  const sent = [];
  const posts = [];
  let made = 0;
  let failing = failPosts;
  globalThis.fetch = async (url, init = {}) => {
    const address = String(url);
    const method = init.method || 'GET';
    if (address.startsWith('https://discord.test/')) {
      posts.push({ method, url: address, body: init.body ? JSON.parse(init.body) : null });
      if (failing > 0) {
        failing -= 1;
        return new Response('{"message":"busy"}', { status: 500 });
      }
      if (method === 'POST') {
        made += 1;
        return new Response(JSON.stringify({ id: `m${made}` }), { status: 200 });
      }
      return method === 'DELETE' ? new Response(null, { status: 204 }) : new Response('{}', { status: 200 });
    }
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return { sent, posts };
}

/** Sam Jones, Kiri Smith and Tama Rewiti are members, with their emails. Returns their member codes. */
async function members() {
  const codes = {};
  for (const [id, name, email] of [[SAM, 'Sam Jones', 'sam@example.com'], [KIRI, 'Kiri Smith', 'kiri@example.com'], [TAMA, 'Tama Rewiti', 'tama@example.com']]) {
    codes[id] = (await call('GET', `me?name=${encodeURIComponent(name)}`, null, id)).data.member.code;
    lair.sql.exec('UPDATE members SET email = ? WHERE customer_id = ?', email, id);
  }
  return codes;
}

beforeEach(() => {
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'ep0qiq-rp.myshopify.com' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: false, tags: [] });
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.rulesCache = rulesFromSettings({ lair_hours: HOURS, lair_shop_tables: '' }, ROOMS, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
});

/* ---------------- the table and the lists ---------------- */

test('open games (round 31): their own table, and games and sizes from lists only', () => {
  const cols = lair.sql.exec("SELECT name FROM pragma_table_info('open_games')").toArray().map((c) => c.name);
  assert.deepEqual(cols, ['id', 'booking_id', 'occurrence_id', 'game', 'size', 'new_players', 'player_id', 'joined_at', 'nudged_at', 'post_id', 'post_state', 'post_tried_at', 'created_at', 'updated_at']);
  assert.deepEqual(OPEN_GAME_LIST.map((g) => g.key), ['40k', 'aos', 'kill-team', 'old-world', 'bolt-action', 'other']);
  assert.deepEqual(OPEN_GAME_LIST.find((g) => g.key === '40k').sizes, ['combat-patrol', '1000', '2000', 'any']);
  assert.deepEqual(OPEN_GAME_LIST.find((g) => g.key === 'kill-team').sizes, [], 'Kill Team has no points to pick');
});

/* ---------------- listing a game ---------------- */

test('open games (round 31): a member lists a 1 v 1 with a game and size from the lists; until someone joins it is their own $10', async () => {
  await members();
  const mail = capture({ discord: false });
  assert.equal(said(await list({}, '')), `401 ${OPEN_GAME_WORDS.login}`);
  assert.equal(said(await list({ people: 4 })), `422 ${OPEN_GAME_WORDS.size}`);
  assert.equal(said(await list({ players: [{ email: 'mia@example.com' }] })), `422 ${OPEN_GAME_WORDS.both}`);
  assert.equal(said(await list({ looking: { game: 'chess' } })), `422 ${OPEN_GAME_WORDS.game}`);
  assert.equal(said(await list({ looking: { game: '40k', size: 'spearhead' } })), `422 ${OPEN_GAME_WORDS.points}`);
  assert.equal(said(await list({ looking: { game: '40k' } })), `422 ${OPEN_GAME_WORDS.points}`, '40k needs a size (or Not fussed)');
  assert.equal(said(await list({ looking: { game: 'kill-team', size: '1000' } })), `422 ${OPEN_GAME_WORDS.points}`);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM bookings').one().n, 0, 'nothing saved');

  const listed = await list();
  assert.equal(listed.status, 200, said(listed));
  const b = listed.data.booking;
  assert.deepEqual(b.tables, ['T10', 'T11']);
  assert.deepEqual([b.people, b.amount, b.split], [1, 1000, false], 'the booker alone, $10');
  assert.equal(b.gameSize, '1 v 1');
  assert.match(b.openGame.id, /^og_[a-z0-9]{16}$/);
  const { id, ...og } = b.openGame;
  assert.deepEqual(og, { game: '40k', gameLabel: 'Warhammer 40,000', size: '1000', sizeLabel: '1,000 points', newPlayers: true, status: 'looking', opponent: null });
  assert.equal(listed.data.spotsLeft, 5);
  // one listed game a night each
  assert.equal(said(await list({ spot: 'T12+T13' })), `409 ${OPEN_GAME_WORDS.twice}`);
  // Kill Team: no size; new players not ticked
  const kt = await list({ name: 'Tama Rewiti', email: 'tama@example.com', spot: 'T12+T13', looking: { game: 'kill-team' } }, TAMA);
  assert.equal(kt.status, 200, said(kt));
  assert.deepEqual([kt.data.booking.openGame.size, kt.data.booking.openGame.sizeLabel, kt.data.booking.openGame.newPlayers], [null, null, false]);
  await settle();
  const confirmation = mail.sent.find((m) => m.to === 'sam@example.com');
  assert.ok(confirmation, 'Sam has his confirmation');
  assert.match(words(confirmation), /Warhammer 40,000, 1,000 points/);
  assert.match(words(confirmation), /Gobgob's finding you one/);
  assert.equal(mail.sent.filter((m) => m.to === 'sam@example.com').length, 1);
});

/* ---------------- the list ---------------- */

test('open games (round 31): the next four game nights with spots left; members see first names, logged out "A player"; never an email, account or booking', async () => {
  const codes = await members();
  const b = (await list()).data.booking;
  const out = await openGames('');
  assert.equal(out.status, 200);
  assert.deepEqual(out.data.dates.map((d) => d.occurrenceId), [TONIGHT, NEXT_WEEK, 'warhammer-night@2026-10-29', 'warhammer-night@2026-11-05']);
  const tonight = dateOf(out.data);
  assert.deepEqual(tonight.spots, { total: 6, free: 5 });
  assert.deepEqual([tonight.title, tonight.start, tonight.end], ['Warhammer night', at(TODAY, 18), at('2026-10-16', 0)]);
  assert.deepEqual(tonight.games.map(({ id, ...g }) => g), [{
    game: '40k', gameLabel: 'Warhammer 40,000', size: '1000', sizeLabel: '1,000 points', newPlayers: true, tables: 'T10 + T11', start: at(TODAY, 18), player: 'A player', status: 'looking',
  }]);
  assert.equal(tonight.games[0].id, b.openGame.id);
  const raw = JSON.stringify(out.data);
  for (const secret of ['sam@example.com', 'Jones', b.id, b.ref, codes[SAM], 'Sam']) assert.ok(!raw.includes(secret), `logged out, no ${secret}`);
  // a member sees the booker's first name (and only that)
  const kiriSees = dateOf((await openGames(KIRI)).data).games[0];
  assert.equal(kiriSees.player, 'Sam');
  assert.equal(kiriSees.yours, undefined);
  assert.ok(!JSON.stringify(kiriSees).includes('Jones'));
  // the booker sees it's theirs
  assert.equal(dateOf((await openGames(SAM)).data).games[0].yours, 'booker');
  // one date
  assert.deepEqual((await openGames('', `?occurrence=${encodeURIComponent(NEXT_WEEK)}`)).data.dates.map((d) => d.occurrenceId), [NEXT_WEEK]);
  // the lists the reserve sheet offers come with it
  const choices = out.data.choices;
  assert.deepEqual(choices.map((c) => c.key), OPEN_GAME_LIST.map((g) => g.key));
  assert.deepEqual(choices[0], { key: '40k', name: 'Warhammer 40,000', sizes: [
    { key: 'combat-patrol', name: 'Combat Patrol' }, { key: '1000', name: '1,000 points' }, { key: '2000', name: '2,000 points' }, { key: 'any', name: 'Any size' },
  ] });
});

/* ---------------- joining ---------------- */

test('open games (round 31): the first member to join gets it; it becomes 1 v 1, each paying their own $10; both emailed; My Lair shows it to both', async () => {
  await members();
  const mail = capture({ discord: false });
  const b = (await list()).data.booking;
  const og = b.openGame;
  assert.equal(said(await join(og.id, '')), `401 ${OPEN_GAME_WORDS.loginJoin}`);
  assert.equal(said(await join('og_0000000000000000', KIRI)), `404 ${OPEN_GAME_WORDS.gone}`);
  assert.equal(said(await join(og.id, SAM)), `403 ${OPEN_GAME_WORDS.own}`);
  const joined = await join(og.id, KIRI);
  assert.equal(joined.status, 200, said(joined));
  assert.deepEqual([joined.data.game.status, joined.data.game.yours, joined.data.game.player], ['on', 'player', 'Sam']);
  assert.equal(said(await join(og.id, TAMA)), `409 ${OPEN_GAME_WORDS.taken}`);
  const saved = lair.booking(b.id);
  assert.deepEqual([saved.people, saved.amount, saved.split], [2, 2000, true], '1 v 1, $10 each');
  assert.deepEqual(playerRows().map((p) => [p.role, p.customer_id, p.name]), [['opponent', KIRI, 'Kiri Smith']]);
  assert.ok(playerRows()[0].invited_at, "Kiri's email is her own (round 11's game email never goes as well)");
  await settle();
  const toSam = mail.sent.filter((m) => m.to === 'sam@example.com' && /Kiri/.test(m.subject));
  const toKiri = mail.sent.filter((m) => m.to === 'kiri@example.com');
  assert.equal(toSam.length, 1, 'Sam hears Kiri is in');
  assert.match(toSam[0].subject, /^Game on: Kiri/);
  assert.equal(toKiri.length, 1, 'Kiri has her confirmation');
  assert.match(toKiri[0].subject, /^You're in: Warhammer night with Sam/);
  assert.match(words(toKiri[0]), /\$10/);
  // My Lair: Sam's game is on, with Kiri; Kiri's shows Sam's game and her own $10
  const mine = (await me(SAM)).bookings.find((x) => x.id === b.id);
  assert.deepEqual([mine.openGame.status, mine.openGame.opponent], ['on', 'Kiri']);
  const theirs = (await me(KIRI)).bookings.find((x) => x.openGame);
  assert.deepEqual([theirs.playerOf.name, theirs.amount, theirs.openGame.status, theirs.openGame.id], ['Sam', 1000, 'on', og.id]);
  assert.equal(theirs.openGame.canLeave, false, "tonight's is less than 24 hours away");
  // the list: gone for everyone else, still there for the two of them
  assert.deepEqual(dateOf((await openGames(TAMA)).data).games, []);
  assert.deepEqual(dateOf((await openGames(KIRI)).data).games.map((g) => [g.status, g.yours, g.player]), [['on', 'player', 'Sam']]);
  assert.deepEqual(dateOf((await openGames(SAM)).data).games.map((g) => [g.status, g.yours, g.opponent]), [['on', 'booker', 'Kiri']]);
});

test('open games (round 31): joining closes 2 hours before the night ends, and not with a listed game of your own that night', async () => {
  await members();
  const og = (await list()).data.booking.openGame;
  await list({ name: 'Tama Rewiti', email: 'tama@example.com', spot: 'T12+T13' }, TAMA);
  assert.equal(said(await join(og.id, TAMA)), `409 ${OPEN_GAME_WORDS.listed}`);
  Date.now = () => at('2026-10-15', 22, 1);
  assert.equal(said(await join(og.id, KIRI)), `409 ${OPEN_GAME_WORDS.closed}`);
  Date.now = () => at('2026-10-15', 21, 59);
  assert.equal((await join(og.id, KIRI)).status, 200, 'at 9:59pm, still on');
});

/* ---------------- dropping out ---------------- */

test('open games (round 31): the player can drop out until 24 hours before; the game is listed again and the booker told', async () => {
  await members();
  const mail = capture({ discord: false });
  const og = (await list({}, SAM, NEXT_WEEK)).data.booking.openGame;
  assert.equal((await join(og.id, KIRI)).status, 200);
  const entry = (await me(KIRI)).bookings.find((x) => x.openGame);
  assert.deepEqual([entry.openGame.canLeave, entry.openGame.leaveUntil], [true, at('2026-10-22', 18) - 24 * HOUR]);
  assert.equal(said(await leave(og.id, TAMA)), `404 ${OPEN_GAME_WORDS.notIn}`);
  const left = await leave(og.id, KIRI);
  assert.equal(left.status, 200, said(left));
  const bookingId = lair.sql.exec('SELECT booking_id FROM open_games WHERE id = ?', og.id).one().booking_id;
  const b = lair.booking(bookingId);
  assert.deepEqual([b.people, b.amount, b.split], [1, 1000, false], 'back to Sam alone');
  assert.equal(playerRows().length, 0);
  assert.equal(lair.sql.exec('SELECT player_id, joined_at FROM open_games WHERE id = ?', og.id).one().player_id, null);
  await settle();
  const told = mail.sent.filter((m) => m.to === 'sam@example.com' && /can't make it/.test(m.subject));
  assert.equal(told.length, 1);
  assert.match(words(told[0]), /listed it again/);
  // listed again: Tama can join it
  assert.equal((await join(og.id, TAMA)).status, 200);
  // tonight's: less than 24 hours away, so not online
  const tonight = (await list()).data.booking.openGame;
  assert.equal((await join(tonight.id, KIRI)).status, 200);
  assert.equal(said(await leave(tonight.id, KIRI)), `409 ${OPEN_GAME_WORDS.lockedLeave(24, 'Sam')}`);
});

/* ---------------- cancelling ---------------- */

test('open games (round 31): the booker cancels free right up until it starts while nobody has joined; once someone has, the 24-hour rule; the player is told', async () => {
  await members();
  const mail = capture({ discord: false });
  const first = (await list()).data.booking;
  const view = (await me(SAM)).bookings.find((x) => x.id === first.id);
  assert.deepEqual([view.cancelUntil, view.locked], [at(TODAY, 18), false], 'free until 6pm tonight');
  assert.equal((await cancelBooking(first.id, SAM)).status, 200);
  assert.deepEqual(dateOf((await openGames(KIRI)).data).games, [], 'off the list');
  // listed again, and joined tonight: locked in, as any game booking 5 hours away
  const again = (await list()).data.booking;
  assert.equal((await join(again.openGame.id, KIRI)).status, 200);
  assert.equal((await me(SAM)).bookings.find((x) => x.id === again.id).locked, true);
  assert.equal((await cancelBooking(again.id, SAM)).status, 409);
  // next week, joined, more than 24 hours ahead: cancelled, and Kiri told it's off
  const next = (await list({}, SAM, NEXT_WEEK)).data.booking;
  assert.equal((await join(next.openGame.id, KIRI)).status, 200);
  assert.equal((await cancelBooking(next.id, SAM)).status, 200);
  await settle();
  const told = mail.sent.filter((m) => m.to === 'kiri@example.com' && /^Called off/.test(m.subject));
  assert.equal(told.length, 1);
  assert.ok(!(await me(KIRI)).bookings.some((x) => x.id === next.id && x.status !== 'cancelled'), "it's off for Kiri too");
});

/* ---------------- the afternoon email ---------------- */

test('open games (round 31): from 2pm on the day, the booker of a game nobody has joined is asked if they are still coming, once', async () => {
  await members();
  const mail = capture({ discord: false });
  await list();
  const tama = (await list({ name: 'Tama Rewiti', email: 'tama@example.com', spot: 'T12+T13' }, TAMA)).data.booking;
  assert.equal((await join(tama.openGame.id, KIRI)).status, 200);
  await settle();
  mail.sent.length = 0;
  assert.equal((await runAt(at(TODAY, 13, 30))).data.nudged, 0, 'not before 2pm');
  assert.equal((await runAt(at(TODAY, 14, 5))).data.nudged, 1);
  await settle();
  const asked = mail.sent.filter((m) => /^Nobody's joined your game yet/.test(m.subject));
  assert.deepEqual(asked.map((m) => m.to), ['sam@example.com'], 'not Tama: Kiri joined hers');
  assert.match(words(asked[0]), /Cancel free in My Lair before 6pm/);
  assert.match(words(asked[0]), /walks in/);
  assert.equal((await runAt(at(TODAY, 14, 15))).data.nudged, 0, 'once');
  // next week's: not on the day yet
  await list({}, SAM, NEXT_WEEK);
  assert.equal((await runAt(at(TODAY, 15, 0))).data.nudged, 0);
});

/* ---------------- Discord ---------------- */

test('open games (round 31): Discord gets the game without a name, "Game on" once someone joins, and the post goes when it is called off; nothing without the webhook', async () => {
  await members();
  let cap = capture({ discord: false });
  await list({}, SAM, NEXT_WEEK);
  await settle();
  assert.equal(cap.posts.length, 0, 'no webhook, no posts');
  lair.sql.exec('DELETE FROM open_games');
  lair.sql.exec("UPDATE bookings SET status = 'cancelled'");

  cap = capture({ discord: true });
  const b = (await list()).data.booking;
  await settle();
  assert.equal(cap.posts.length, 1);
  const post = cap.posts[0];
  assert.deepEqual([post.method, post.url], ['POST', `${HOOK}?wait=true`]);
  assert.match(post.body.content, /^A Warhammer 40,000 player is looking for a game on Thursday 15 October, from 6pm\. 1,000 points, and new players are welcome\.\nJoin them: https:\/\/\S+\/pages\/warhammer$/);
  assert.deepEqual(post.body.allowed_mentions, { parse: [] }, 'never pings anyone');
  for (const secret of ['Sam', 'Jones', 'sam@example.com', 'T10']) assert.ok(!post.body.content.includes(secret), `no ${secret}`);
  assert.equal(lair.sql.exec('SELECT post_id, post_state FROM open_games WHERE booking_id = ?', b.id).one().post_id, 'm1');
  // joined: the same post says it's taken
  assert.equal((await join(b.openGame.id, KIRI)).status, 200);
  await settle();
  assert.deepEqual([cap.posts[1].method, cap.posts[1].url], ['PATCH', `${HOOK}/messages/m1`]);
  assert.match(cap.posts[1].body.content, /^Game on! The Warhammer 40,000 game on Thursday 15 October has its opponent\./);
  // next week's, called off: its post goes
  const next = (await list({}, SAM, NEXT_WEEK)).data.booking;
  await settle();
  assert.equal((await cancelBooking(next.id, SAM)).status, 200);
  await settle();
  assert.deepEqual(cap.posts.slice(-1).map((p) => [p.method, p.url]), [['DELETE', `${HOOK}/messages/m2`]]);
  assert.equal(lair.sql.exec('SELECT post_state FROM open_games WHERE booking_id = ?', next.id).one().post_state, 'gone');
});

test('open games (round 31): a Discord post that fails is tried again by the 10-minute run', async () => {
  await members();
  const cap = capture({ discord: true, failPosts: 1 });
  const b = (await list({}, SAM, NEXT_WEEK)).data.booking;
  await settle();
  assert.equal(lair.sql.exec('SELECT post_id FROM open_games WHERE booking_id = ?', b.id).one().post_id, null);
  const run = (await runAt(NOW + 10 * 60_000)).data;
  assert.equal(run.posted, 1);
  await settle();
  assert.equal(cap.posts.filter((p) => p.method === 'POST').length, 2);
  assert.equal(lair.sql.exec('SELECT post_id, post_state FROM open_games WHERE booking_id = ?', b.id).one().post_state, 'open');
});

/* ---------------- unbooked pairs from 6pm ---------------- */

test('open games (round 31): from 6pm on the night, any pair nobody reserved can be booked by anyone; the painting station stays held', async () => {
  await members();
  await list();
  const table = (tables) => call('POST', 'bookings', {
    kind: 'table', tables, start: at(TODAY, 20), end: at(TODAY, 22), people: 2, name: 'Kiri Smith', email: 'kiri@example.com', phone: MOBILE,
  }, KIRI);
  const holdsAt = async () => (await call('GET', `floor?from=${at(TODAY, 0)}&to=${at('2026-10-16', 0)}`)).data.eventHolds.filter((h) => h.occurrenceId === TONIGHT);
  // 1pm: the night's tables are all held for it
  assert.notEqual((await table(['T12'])).status, 200);
  const before = await holdsAt();
  assert.deepEqual(before.map((h) => [h.id, h.soft]), [[`ev-${TONIGHT}`, false]]);
  // 6:05pm: the game tables go soft; the painting station (T16, T17) stays locked
  Date.now = () => at(TODAY, 18, 5);
  const after = await holdsAt();
  assert.deepEqual(after.map((h) => [h.id, h.tables.join(','), h.soft]), [
    [`ev-${TONIGHT}`, 'T16,T17', false],
    [`ev-${TONIGHT}-spots`, 'T8,T9,T10,T11,T12,T13,T14,T15,T18,T19,T20,T21', true],
  ]);
  const free = await table(['T12']);
  assert.equal(free.status, 200, said(free));
  assert.notEqual((await table(['T16'])).status, 200, 'the painting station stays held');
  assert.notEqual((await table(['T10'])).status, 200, "Sam's pair is his");
  // next week's night hasn't started: still held
  assert.notEqual((await call('POST', 'bookings', {
    kind: 'table', tables: ['T12'], start: at('2026-10-22', 20), end: at('2026-10-22', 22), people: 2, name: 'Kiri Smith', email: 'kiri@example.com', phone: MOBILE,
  }, KIRI)).status, 200);
});

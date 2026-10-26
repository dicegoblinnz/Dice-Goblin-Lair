// Round 20, the TTRPG page's sessions in the page itself (26 Oct 2026, contract v20-sessions-feed). From the website lab:
// the TTRPG page's HTML had no sessions in it, so search engines and AI search found a page with no games on it. Mo picked
// "Sessions in the page": the Lair app keeps the next two weeks of public sessions in the shop metafield lair.sessions,
// and the theme prints them. GM names stay out, and so do private games.
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { SESSIONS_FEED, sessionsFeed, feedContent } from '../src/sessions-feed.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Monday 26 October 2026, 9:00am in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 9, 25, 20, 0);
const realNow = Date.now;
const realFetch = globalThis.fetch;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);

function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      // as SQLite in a Durable Object: at most 100 bound values a query (Cloudflare's limit; 27 Oct 2026)
      if (bindings.length > 100) throw new Error(`too many SQL variables: ${bindings.length}`);
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
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) }, waitUntil: () => {} };
}

const ROOMS = [{ id: 'side-room-2', name: 'Side room 2', code: 'B', tables: 6, seats: 4, order: 3 }];
// The main account; Ana (a helper with GM games); Rangi and Tama, GMs; Mia and Kai, players (Mia isn't a GM)
const OWNER = '9001';
const ANA = '9101';
const RANGI = '5001';
const TAMA = '5002';
const MIA = '6001';
const KAI = '6002';
const SHOP_GID = 'gid://shopify/Shop/77001';

let lair;
let now;
let calls = [];
let refuse = null;
async function call(method, path, body, customer = '') {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  }));
  return { status: response.status, data: await response.json() };
}
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const board = async (who = '') => ok(await call('GET', `floor?from=${now}&to=${now + 30 * DAY}`, null, who));

/** A game listed by its GM (Rangi unless said): Saturday 31 October 6pm to 10pm unless said */
async function listGame({
  who = RANGI, gm = 'Rangi', title = 'The Sunless Citadel', system = 'D&D 5e', day = '2026-10-31', from = 18, to = 22, seats = 4,
  schedule, privateGame = false, level, tables = ['B1'], extra = {},
} = {}) {
  return ok(await call('POST', 'games', {
    title, system, gm, blurb: `${gm}'s secret notes for the table.`, seats, tables, start: at(day, from), end: at(day, to),
    email: `${gm.toLowerCase()}@example.com`, gmBio: `${gm} has run games since 1999.`,
    ...(schedule ? { schedule } : {}), ...(level ? { level } : {}), ...(privateGame ? { private: true } : {}), ...extra,
  }, who));
}
const seat = (gameId, who, name) => call('POST', 'bookings', {
  kind: 'gm-seat', gameId, people: 1, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100', pay: 'day',
}, who);

/** The metafield writes so far, each as Shopify got it: { ownerId, namespace, key, type, value (parsed) } */
const writes = () => calls
  .filter((c) => /metafieldsSet/.test(c.query))
  .map((c) => ({ ...c.variables.metafields[0], value: JSON.parse(c.variables.metafields[0].value) }));
const lastFeed = () => writes().at(-1)?.value;

beforeEach(async () => {
  calls = [];
  refuse = null;
  now = NOW;
  globalThis.fetch = async (url) => {
    throw new Error(`No network in tests: ${url}`);
  };
  Date.now = () => now;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', STORE_URL: 'https://www.dicegoblin.nz' });
  lair.later = (promise) => Promise.resolve(promise).catch(() => {});
  lair.mail = async () => ({ ok: true, status: 200 });
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: id === RANGI || id === TAMA, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.accountEmail = async () => ({ fetched: false, email: '' });
  // Shopify, as far as this round needs it: the shop's id, and metafieldsSet
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.graphql = async (query, variables = {}, options = {}) => {
    calls.push({ query, variables, options });
    if (/LairShopId/.test(query)) return { shop: { id: SHOP_GID } };
    if (/metafieldsSet/.test(query)) {
      if (refuse === 'userErrors') return { metafieldsSet: { metafields: [], userErrors: [{ field: ['metafields', '0', 'value'], message: 'Value is invalid JSON', code: 'INVALID_VALUE' }] } };
      if (refuse === 'down') throw new Error('Shopify API error 503');
      if (refuse === 'empty') return { metafieldsSet: { metafields: [], userErrors: [] } };
      return { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1', updatedAt: new Date(now).toISOString() }], userErrors: [] } };
    }
    throw new Error(`Not expected in this test: ${query.slice(0, 60)}`);
  };
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  ok(await call('POST', 'team', { customerId: ANA, name: 'Ana Ngata', email: 'ana@example.com', perms: ['sessions'] }, OWNER));
  for (const [id, name] of [[RANGI, 'Rangi Hohaia'], [TAMA, 'Tama Rewi'], [MIA, 'Mia Chen'], [KAI, 'Kai Tane']]) {
    lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
  }
});

afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
});

test('sessions feed (round 20): only the board\'s public sessions to come in the next two weeks, soonest first, with nothing about the GM', () => {
  const base = { seats: 4, taken: 1, status: 'open', schedule: 'one-shot', seatPrice: 1500, gm: 'Rangi', gmBio: 'Bio', blurb: 'Notes', level: 'some' };
  const games = [
    { ...base, id: 'g-later', title: 'Later', system: 'Pathfinder 2e', start: NOW + 3 * DAY, end: NOW + 3 * DAY + 4 * HOUR },
    { ...base, id: 'g-soon', title: 'Soon', system: 'D&D 5e', start: NOW + DAY, end: NOW + DAY + 4 * HOUR, level: 'new', schedule: 'weekly', seriesId: 'sr_1' },
    { ...base, id: 'g-private', title: 'Private', private: true, start: NOW + DAY, end: NOW + DAY + HOUR },
    { ...base, id: 'g-pending', title: 'Pending', status: 'pending', start: NOW + DAY, end: NOW + DAY + HOUR },
    { ...base, id: 'g-cancelled', title: 'Cancelled', status: 'cancelled', start: NOW + DAY, end: NOW + DAY + HOUR },
    { ...base, id: 'g-started', title: 'On now', start: NOW - HOUR, end: NOW + HOUR },
    { ...base, id: 'g-far', title: 'Too far', start: NOW + 15 * DAY, end: NOW + 15 * DAY + HOUR },
    { ...base, id: 'g-full', title: 'Full one', status: 'full', taken: 4, start: NOW + 2 * DAY, end: NOW + 2 * DAY + HOUR, schedule: 'odd' },
    { ...base, id: 'g-broken', title: 'No end', start: NOW + DAY, end: NOW + DAY },
  ];
  const feed = sessionsFeed(games, { now: NOW });
  assert.equal(feed.v, 1);
  assert.equal(feed.days, 14);
  assert.equal(feed.updated, new Date(NOW).toISOString());
  assert.deepEqual(feed.sessions.map((s) => s.id), ['g-soon', 'g-full', 'g-later']);
  assert.deepEqual(feed.sessions[0], {
    id: 'g-soon', title: 'Soon', system: 'D&D 5e', start: new Date(NOW + DAY).toISOString(), end: new Date(NOW + DAY + 4 * HOUR).toISOString(),
    schedule: 'weekly', newPlayers: true, price: 1500, seatsLeft: 3, full: false,
  });
  assert.deepEqual([feed.sessions[1].full, feed.sessions[1].seatsLeft, feed.sessions[1].schedule], [true, 0, 'one-shot'], 'an unknown schedule reads as a one-shot');
  const text = JSON.stringify(feed);
  for (const word of ['Rangi', 'Bio', 'Notes', 'gm', 'blurb']) assert.ok(!text.includes(word), `nothing like "${word}" in the feed`);
  // the most it holds, and long names cut
  const many = Array.from({ length: 60 }, (_, i) => ({ ...base, id: `g${i}`, title: `${'A very long title '.repeat(8)}${i}`, start: NOW + HOUR + i * MIN, end: NOW + 5 * HOUR }));
  const capped = sessionsFeed(many, { now: NOW });
  assert.equal(capped.sessions.length, SESSIONS_FEED.max);
  assert.ok(capped.sessions.every((s) => s.title.length <= 80));
  assert.deepEqual(sessionsFeed(undefined, { now: NOW }).sessions, []);
  assert.equal(feedContent({ ...feed, updated: 'another time' }), feedContent(feed), 'when it was made doesn\'t count as a change');
});

test('sessions feed (round 20): the health check writes the public sessions to the shop metafield lair.sessions, with no GM names, private games or pending ones', async () => {
  const weekly = await listGame({ schedule: 'weekly', level: 'new' });
  await listGame({ title: 'The Secret Keep', schedule: 'weekly', privateGame: true, tables: ['B2'] });
  await listGame({ who: TAMA, gm: 'Tama', title: 'Tomb of Horrors', system: 'AD&D', day: '2026-11-07', from: 14, to: 18, tables: ['B3'], extra: { gmFee: 1000 } });
  const pending = await listGame({ who: MIA, gm: 'Mia', title: 'Mia\'s first game', day: '2026-11-01', from: 12, to: 16, tables: ['B4'] });
  assert.equal(pending.game.status, 'pending', 'a player who isn\'t a GM waits for a manager OK');
  const gone = await listGame({ who: TAMA, gm: 'Tama', title: 'Called off', day: '2026-10-29', tables: ['B5'] });
  ok(await call('POST', `games/${gone.game.id}/update`, { status: 'cancelled' }, OWNER));
  await listGame({ who: TAMA, gm: 'Tama', title: 'Next month', day: '2026-11-21', tables: ['B6'] });

  const result = await lair.checkConnection(undefined);
  assert.deepEqual(result.sessionsFeed, { count: 2, written: true });
  const [written] = writes();
  assert.deepEqual([written.ownerId, written.namespace, written.key, written.type], [SHOP_GID, 'lair', 'sessions', 'json']);
  const feed = written.value;
  assert.deepEqual(feed.sessions.map((s) => s.title), ['The Sunless Citadel', 'Tomb of Horrors'], 'its next weekly session, then the one-shot');
  const [first, second] = feed.sessions;
  assert.equal(first.id, weekly.game.id);
  assert.deepEqual([first.schedule, first.newPlayers, first.seatsLeft, first.full], ['weekly', true, 4, false]);
  assert.equal(first.start, new Date(at('2026-10-31', 18)).toISOString());
  // the seat price the board shows (the table fee plus this GM's fee)
  const seen = (await board()).games.find((g) => g.title === 'Tomb of Horrors');
  assert.equal(second.price, seen.seatPrice);
  const text = JSON.stringify(feed);
  for (const word of ['Rangi', 'Tama', 'Mia', 'example.com', 'secret notes', 'since 1999', 'Secret Keep', 'invite', 'B1']) {
    assert.ok(!text.includes(word), `nothing like "${word}" in what Shopify gets`);
  }
  // asked once for the shop's id, and the write gives up in time
  assert.equal(calls.filter((c) => /LairShopId/.test(c.query)).length, 1);
  assert.equal(calls.find((c) => /metafieldsSet/.test(c.query)).options.timeout, SESSIONS_FEED.timeoutMs);
});

test('sessions feed (round 20): nothing is written while nothing changes; a seat taken, a session cancelled or a day gone by writes it again', async () => {
  const weekly = await listGame({ schedule: 'weekly' });
  const oneShot = await listGame({ who: TAMA, gm: 'Tama', title: 'Tomb of Horrors', day: '2026-11-07', from: 14, to: 18, tables: ['B3'] });
  assert.deepEqual(await lair.syncSessionsFeed(now), { count: 2, written: true });
  now += 10 * MIN;
  assert.deepEqual(await lair.syncSessionsFeed(now), { count: 2, unchanged: true });
  assert.equal(writes().length, 1, 'no second write');

  ok(await seat(oneShot.game.id, KAI, 'Kai'));
  now += 10 * MIN;
  assert.deepEqual(await lair.syncSessionsFeed(now), { count: 2, written: true });
  assert.equal(lastFeed().sessions.find((s) => s.id === oneShot.game.id).seatsLeft, 3, 'a seat taken');

  ok(await call('POST', `games/${oneShot.game.id}/update`, { status: 'cancelled' }, OWNER));
  now += 10 * MIN;
  assert.deepEqual(await lair.syncSessionsFeed(now), { count: 1, written: true });
  assert.deepEqual(lastFeed().sessions.map((s) => s.id), [weekly.game.id], 'a cancelled session goes');

  now += SESSIONS_FEED.refreshMs;
  assert.deepEqual(await lair.syncSessionsFeed(now), { count: 1, written: true }, 'once a day even when nothing changed, in case it was removed in Shopify admin');
  assert.equal(writes().length, 4);
});

test('sessions feed (round 20): a weekly game shows its next session; once that one has started, the one after it takes over', async () => {
  const weekly = await listGame({ schedule: 'weekly' });
  await lair.syncSessionsFeed(now);
  assert.equal(lastFeed().sessions.length, 1, 'one session of the weekly game');
  assert.equal(lastFeed().sessions[0].id, weekly.game.id);
  // Saturday 31 October, 7pm: the session is on, so it's not in the list (it can't be booked from the page now)
  now = at('2026-10-31', 19);
  await lair.syncSessionsFeed(now);
  assert.deepEqual(lastFeed().sessions, [], 'the board still shows the session that\'s on; the list only has sessions to come');
  // after it ends (and the health check moves the series on), the next Saturday's is listed
  now = at('2026-10-31', 22, 30);
  await lair.checkConnection(undefined);
  const next = lastFeed().sessions;
  assert.equal(next.length, 1);
  assert.equal(next[0].start, new Date(at('2026-11-07', 18)).toISOString());
  assert.notEqual(next[0].id, weekly.game.id);
});

test('sessions feed (round 20): a free session shows its usual price and seats kept for new players count as taken, as on the board', async () => {
  const game = await listGame({ who: TAMA, gm: 'Tama', title: 'Tomb of Horrors', day: '2026-11-07', from: 14, to: 18, tables: ['B3'] });
  ok(await call('POST', `games/${game.game.id}/free`, { free: true }, ANA));
  ok(await call('POST', `games/${game.game.id}/new-seats`, { seats: 2 }, ANA));
  await lair.syncSessionsFeed(now);
  const [session] = lastFeed().sessions;
  const seen = (await board()).games.find((g) => g.id === game.game.id);
  assert.equal(session.price, seen.seatPrice);
  assert.ok(session.price > 0, 'never $0: free sessions are staff-only');
  assert.equal(session.seatsLeft, seen.seats - seen.taken);
  assert.equal(session.seatsLeft, 2);
  assert.deepEqual(Object.keys(session).sort(), ['end', 'full', 'id', 'newPlayers', 'price', 'schedule', 'seatsLeft', 'start', 'system', 'title'], 'only these fields: nothing says it\'s free');
});

test('sessions feed (round 20): when Shopify turns the write away, the health check says why, nothing is recorded, and the next run tries again', async () => {
  await listGame({ schedule: 'weekly' });
  refuse = 'userErrors';
  const result = await lair.checkConnection(undefined);
  assert.match(result.sessionsFeed.error, /lair\.sessions metafield away: Value is invalid JSON/);
  // the rest of the health check still ran to the end, and saved its record with the reason in it
  assert.match(lair.statusSeen.connection, /metafield away: Value is invalid JSON/);
  refuse = 'down';
  now += 10 * MIN;
  assert.match((await lair.checkConnection(undefined)).sessionsFeed.error, /503/);
  refuse = 'empty';
  now += 10 * MIN;
  assert.match((await lair.checkConnection(undefined)).sessionsFeed.error, /didn't say the lair\.sessions metafield was written/);
  refuse = null;
  now += 10 * MIN;
  assert.deepEqual((await lair.checkConnection(undefined)).sessionsFeed, { count: 1, written: true });
  now += 10 * MIN;
  assert.equal((await lair.checkConnection(undefined)).sessionsFeed, undefined, 'nothing to say once it\'s in step');
});

test('sessions feed (round 20): without Shopify set up, nothing is asked and nothing is recorded', async () => {
  Object.defineProperty(lair.shopify, 'configured', { get: () => false, configurable: true });
  await listGame({ schedule: 'weekly' });
  assert.equal(await lair.syncSessionsFeed(now), null);
  assert.deepEqual(calls, []);
});

test('sessions feed (round 20): the people booked in stay out: no names, emails or phone numbers, only the seats they take', async () => {
  const game = await listGame({ who: TAMA, gm: 'Tama', title: 'Tomb of Horrors', day: '2026-11-07', from: 14, to: 18, tables: ['B3'] });
  ok(await seat(game.game.id, KAI, 'Kai'));
  ok(await seat(game.game.id, '', 'Hineraukatauri'));
  await lair.syncSessionsFeed(now);
  const text = JSON.stringify(lastFeed());
  for (const word of ['Kai', 'kai@example.com', 'Hineraukatauri', 'hineraukatauri@example.com', '021 555 0100', '5550100', KAI]) {
    assert.ok(!text.includes(word), `nothing like "${word}" in what Shopify gets`);
  }
  assert.equal(lastFeed().sessions[0].seatsLeft, 2);
});

// Private games (17 Oct 2026, contract v18-private). Mo: "I want my gms to be able to have a private game, and it becomes
// an invite only game. But they can toggle a register interest button if they want otherwise it is locked to the
// public." He picked: shown on the board as Private, invite only, and an invite link the GM shares.
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { PRIVATE_WORDS as W, newInviteKey } from '../src/private-games.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
// Friday 16 October 2026, 1:00pm in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 9, 16, 0, 0);
const realNow = Date.now;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);

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

const ROOMS = [{ id: 'side-room-2', name: 'Side room 2', code: 'B', tables: 4, seats: 4, order: 3 }];
// The main account; Ana (a helper with GM games) and Hemi (Check-in only); Rangi, a GM (tagged gm, not staff); players
const OWNER = '9001';
const ANA = '9101';
const HEMI = '9102';
const RANGI = '5001';
const MIA = '6001';
const KAI = '6002';

let lair;
async function call(method, path, body, customer = '') {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  }));
  return { status: response.status, data: await response.json() };
}
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const board = async (who = '') => ok(await call('GET', `floor?from=${at('2026-10-16', 0)}&to=${at('2026-11-14', 0)}`, null, who));
const gameOn = async (id, who = '') => (await board(who)).games.find((g) => g.id === id);
const setPrivate = (id, body, who = RANGI) => call('POST', `games/${id}/private`, body, who);
const newLink = (id, who = RANGI) => call('POST', `games/${id}/invite/new`, {}, who);
const byInvite = (key, who = '') => call('GET', `games/invite/${encodeURIComponent(key)}`, null, who);
const seat = (gameId, who, name, extra = {}) => call('POST', 'bookings', {
  kind: 'gm-seat', gameId, people: 1, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100', pay: 'day', ...extra,
}, who);
const joinEvery = (gameId, who, name, extra = {}) => call('POST', `games/${gameId}/join-series`, {
  people: 1, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100', ...extra,
}, who);
const interest = (id, who, extra = {}) => call('POST', 'interest', { kind: 'session', id, name: 'Kai Tane', email: 'kai@example.com', phone: '021 555 0101', ...extra }, who);

/** Rangi lists his own game: weekly on Saturdays 6pm to 10pm from tomorrow unless said; private unless said */
async function listGame({ schedule = 'weekly', privateGame = true, interestOn = false, start = at('2026-10-17', 18), end = at('2026-10-17', 22), tables = ['B1'] } = {}) {
  return ok(await call('POST', 'games', {
    title: 'The Sunless Citadel', system: 'D&D 5e', gm: 'Rangi', blurb: 'Our campaign.', seats: 4, tables, start, end, schedule,
    email: 'rangi@example.com', ...(privateGame ? { private: true, interest: interestOn } : {}),
  }, RANGI));
}

const realFetch = globalThis.fetch;
let reached = [];
beforeEach(async () => {
  reached = [];
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', STORE_URL: 'https://www.dicegoblin.nz' });
  lair.later = (promise) => Promise.resolve(promise).catch(() => {});
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: id === RANGI, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  Object.defineProperty(lair.shopify, 'configured', { get: () => false, configurable: true });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  for (const [id, name, perms] of [[ANA, 'Ana Ngata', ['sessions']], [HEMI, 'Hemi Walker', ['checkin']]]) {
    ok(await call('POST', 'team', { customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, perms }, OWNER));
  }
  for (const [id, name] of [[RANGI, 'Rangi Hohaia'], [MIA, 'Mia Chen'], [KAI, 'Kai Tane']]) lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

test('private: invite keys are 20 letters from crypto, with no look-alikes, and never repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const key = newInviteKey();
    assert.match(key, /^[a-hj-km-np-z2-9]{20}$/);
    seen.add(key);
  }
  assert.equal(seen.size, 500);
});

test('private: a GM lists a private weekly game: the board shows it as private (no link), the GM gets the link, and every session shares it', async () => {
  const listed = await listGame();
  const { game } = listed;
  assert.equal(game.private, true);
  assert.equal(game.interestOpen, false);
  assert.match(game.invite.key, /^[a-z0-9]{20}$/);
  assert.equal(game.invite.url, `https://www.dicegoblin.nz/pages/gm-games?invite=${game.invite.key}`);
  assert.ok(listed.sessions.length > 3, 'weekly sessions up to the horizon');
  const keys = lair.sql.exec('SELECT DISTINCT invite_key AS k, private AS p FROM games WHERE series_id = ?', game.seriesId).toArray().map((r) => ({ ...r }));
  assert.deepEqual(keys, [{ k: game.invite.key, p: 1 }], 'one key for every session');
  // the public see it, as private, with no link
  for (const who of ['', MIA, HEMI]) {
    const seen = await gameOn(game.id, who);
    assert.deepEqual([seen.private, seen.interestOpen, 'invite' in seen], [true, false, who === HEMI], who || 'logged out');
  }
  // its GM and staff with GM games see the link
  assert.equal((await gameOn(game.id, RANGI)).invite.key, game.invite.key);
  assert.equal((await gameOn(game.id, ANA)).invite.key, game.invite.key);
  const mine = ok(await call('GET', 'me', null, RANGI)).games.find((g) => g.id === game.id);
  assert.equal(mine.invite.key, game.invite.key, 'GET /me has it for the GM');
  // a public game is as it was
  const open = (await listGame({ privateGame: false, tables: ['B2'] })).game;
  assert.deepEqual([open.private, open.interestOpen, 'invite' in open], [false, false, false]);
});

test('private: a seat or a weekly seat needs the invite link; staff with GM games and its GM don\'t; a regular who\'s in can change who\'s coming', async () => {
  const { game } = await listGame();
  const key = game.invite.key;
  assert.equal(said(await seat(game.id, MIA, 'Mia')), `403 ${W.invite}`);
  assert.equal(said(await seat(game.id, '', 'Guest')), `403 ${W.invite}`);
  assert.equal(said(await seat(game.id, MIA, 'Mia', { invite: newInviteKey() })), `403 ${W.invite}`, 'another key');
  assert.equal(said(await seat(game.id, MIA, 'Mia', { invite: 'nope' })), `403 ${W.invite}`);
  assert.equal(said(await seat(game.id, HEMI, 'Hemi')), `403 ${W.invite}`, 'staff without GM games need it too');
  const booked = ok(await seat(game.id, MIA, 'Mia', { invite: key.toUpperCase() })).booking;
  assert.equal(booked.status, 'confirmed', 'any case');
  ok(await seat(game.id, ANA, 'Ana'));
  // every week
  assert.equal(said(await joinEvery(game.id, KAI, 'Kai')), `403 ${W.invite}`);
  ok(await joinEvery(game.id, KAI, 'Kai', { invite: key }));
  ok(await joinEvery(game.id, KAI, 'Kai', { people: 2, players: [{ name: 'Kai' }, { name: 'Ria' }] }), 'in already: no link needed');
  // staff add players without it
  ok(await call('POST', `games/${game.id}/players`, { people: 1, name: 'Tia', email: 'tia@example.com' }, ANA));
});

test('private: Register interest only when its GM switches it on; the GM\'s email has the link', async () => {
  const { game } = await listGame();
  assert.equal(said(await interest(game.id, KAI)), `403 ${W.noInterest}`);
  assert.equal(said(await interest(game.id, '')), `403 ${W.noInterest}`);
  const on = ok(await setPrivate(game.id, { private: true, interest: true }));
  assert.deepEqual([on.game.private, on.game.interestOpen, on.game.invite.key, on.sessions > 3], [true, true, game.invite.key, true]);
  assert.equal((await gameOn(game.id)).interestOpen, true, 'the board says so');
  // the GM is emailed with their link
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>' };
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'e1' }), { status: 200 });
  };
  ok(await interest(game.id, KAI, { note: 'I play a mean bard.' }));
  await new Promise((r) => setTimeout(r, 10));
  const mail = sent.find((m) => (Array.isArray(m.to) ? m.to[0] : m.to) === 'rangi@example.com');
  assert.ok(mail, 'the GM got an email');
  assert.match(mail.subject, /Kai is interested in The Sunless Citadel/);
  assert.ok(mail.text.includes(`your private game The Sunless Citadel`), mail.text);
  assert.ok(mail.text.includes(game.invite.url), 'with the link');
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  // off again: no more interest
  ok(await setPrivate(game.id, { private: true, interest: false }));
  assert.equal(said(await interest(game.id, MIA)), `403 ${W.noInterest}`);
});

test('private: who can change it, and making it public (the link keeps for next time)', async () => {
  const { game } = await listGame();
  assert.equal(said(await setPrivate(game.id, { private: false }, MIA)), `403 ${W.notYours}`);
  assert.equal(said(await setPrivate(game.id, { private: false }, HEMI)), `403 ${W.notYours}`);
  assert.equal(said(await setPrivate(game.id, { private: false }, '')), `401 ${W.login}`);
  assert.equal(said(await setPrivate(game.id, { private: 'no' })), `422 ${W.private}`);
  assert.equal(said(await setPrivate(game.id, { private: true, interest: 'yes' })), `422 ${W.interest}`);
  assert.equal(said(await setPrivate(game.id, { private: true, scope: 'all' })), '422 scope is \'session\' or \'series\'.');
  assert.equal(said(await setPrivate('gm_nope', { private: true })), '404 Game not found.');
  // public: anyone books, and nothing's open to interest only for it
  const pub = ok(await setPrivate(game.id, { private: false }, ANA));
  assert.deepEqual([pub.game.private, pub.game.interestOpen, 'invite' in pub.game], [false, false, false]);
  ok(await seat(game.id, MIA, 'Mia'));
  ok(await interest(game.id, KAI));
  // private again: the same link
  const again = ok(await setPrivate(game.id, { private: true }));
  assert.equal(again.game.invite.key, game.invite.key);
  // just this session public: the later ones stay private
  const later = (await board()).games.filter((g) => g.seriesId === game.seriesId);
  ok(await setPrivate(game.id, { private: false, scope: 'session' }));
  const rows = lair.sql.exec('SELECT id, private FROM games WHERE series_id = ? ORDER BY starts_at', game.seriesId).toArray();
  assert.deepEqual([rows[0].private, rows.slice(1).every((r) => r.private === 1)], [0, true]);
  assert.ok(later.length >= 1);
});

test('private: the invite link opens the next session; a new link stops the old one; a session made later is private with the new link', async () => {
  const { game } = await listGame({ schedule: 'flexible' });
  const key = game.invite.key;
  const found = ok(await byInvite(key));
  assert.deepEqual([found.game.id, found.game.invited, found.game.private, 'invite' in found.game], [game.id, true, true, false]);
  assert.equal(said(await byInvite('abcdefghjkmnpqrstuvw')), `404 ${W.badInvite}`);
  assert.equal(said(await byInvite('<script>')), `404 ${W.badInvite}`);
  // a GM adds a date: private, with the same link
  const added = ok(await call('POST', `games/${game.id}/sessions`, { start: at('2026-10-24', 18), end: at('2026-10-24', 22) }, RANGI));
  const second = lair.game(added.game.id);
  assert.deepEqual([second.private, second.inviteKey], [true, key]);
  // a new link: every session has it, the old one doesn't work
  assert.equal(said(await newLink(game.id, MIA)), `403 ${W.notYours}`);
  const renewed = ok(await newLink(game.id));
  const fresh = renewed.game.invite.key;
  assert.notEqual(fresh, key);
  assert.equal(renewed.sessions, 2);
  assert.equal(said(await byInvite(key)), `404 ${W.badInvite}`);
  assert.equal(said(await seat(game.id, MIA, 'Mia', { invite: key })), `403 ${W.invite}`);
  ok(await seat(game.id, MIA, 'Mia', { invite: fresh }));
  assert.equal(lair.game(second.id).inviteKey, fresh);
  // the next date after this one: once the first has ended, the link opens the second
  Date.now = () => at('2026-10-17', 23);
  assert.equal(ok(await byInvite(fresh)).game.id, second.id);
  // a public game has no link to renew
  const open = (await listGame({ privateGame: false, schedule: 'one-shot', tables: ['B2'], start: at('2026-10-18', 18), end: at('2026-10-18', 22) })).game;
  assert.equal(said(await newLink(open.id)), `409 ${W.notPrivate}`);
});

test('private: weekly sessions made later by maintenance are private with the link; a one-off private game\'s link ends with it', async () => {
  const { game } = await listGame();
  const key = game.invite.key;
  // weeks on, maintenance tops the series up
  Date.now = () => NOW + 30 * 24 * HOUR;
  const rules = await lair.rules();
  lair.extendSeries(rules, Date.now());
  const rows = lair.sql.exec('SELECT private, invite_key FROM games WHERE series_id = ?', game.seriesId).toArray();
  assert.ok(rows.every((r) => r.private === 1 && r.invite_key === key), 'every session, old and new');
  // a one-off
  Date.now = () => NOW;
  const one = (await listGame({ schedule: 'one-shot', tables: ['B3'], start: at('2026-10-18', 18), end: at('2026-10-18', 22) })).game;
  assert.equal(ok(await byInvite(one.invite.key)).game.id, one.id);
  Date.now = () => at('2026-10-18', 23);
  assert.equal(said(await byInvite(one.invite.key)), `404 ${W.badInvite}`);
});

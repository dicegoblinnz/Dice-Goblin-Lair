// Round 14 (contract v14-discord): the Discord bot. Mo (10 Oct 2026): "Can we build a discord mod or something and make it
// link to the website for dice goblin to organize and fit people in, inside the discord? And update the website too?" He
// picked all four parts: TTRPG sessions, events, table bookings, and auto-posts with seat pings.
// Run with: node --test test/   (under TZ=UTC and TZ=Pacific/Auckland)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair, MIGRATIONS } from '../src/lair.js';
import { LairTime, rulesFromSettings } from '../src/core.js';
import { DISCORD_WORDS, deferFor, discordCommands, inPlace, occRef, parseClock, readModal, verifyDiscord } from '../src/discord.js';
import worker from '../src/index.js';
import { resetConfigCache } from '../src/config.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const MIN = 60_000;
const DAY = 24 * HOUR;
// Friday 9 October 2026, 1:00pm in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 9, 9, 0, 0);
const realNow = Date.now;
const realFetch = globalThis.fetch;

/* ---------------- helpers (as test/round9-play.test.js) ---------------- */
function fakeCtx(pending = []) {
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
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: (p) => pending.push(p) };
}

const ROOMS = [
  { id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 },
  { id: 'side-room-1', name: 'Side room 1', code: 'A', tables: 4, seats: 4, order: 2 },
  { id: 'fancy-room', name: 'Fancy room', code: 'F', tables: 1, seats: 12, price: 15, minPeople: 4, order: 4 },
];
const TEST_HOURS = 'Mon closed\nTue 12:00-22:00\nWed 12:00-22:00\nThu 12:00-22:00\nFri 12:00-23:00\nSat 10:00-23:00\nSun 10:00-20:00';
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const EVENTS = [
  // no sign-ups (entry is a booster pack): I'm coming and Maybe
  { id: 'pokemon', title: 'Pokémon league', type: 'tcg', start: at('2026-10-16', 17), end: at('2026-10-16', 20), tables: '', description: 'Bring your deck.' },
  // 20 places, $5, paid at the counter
  { id: 'quiz', title: 'Trivia night', start: at('2026-10-14', 18), end: at('2026-10-14', 20), tables: '', capacity: 20, entryFee: 500 },
  // 2 places, tomorrow afternoon: fills fast
  { id: 'tiny', title: 'Tiny painting class', start: at('2026-10-10', 14), end: at('2026-10-10', 16), tables: '', capacity: 2 },
  // 10 places, $20, paid online
  { id: 'launch', title: 'Launch day', start: at('2026-10-11', 11), end: at('2026-10-11', 13), tables: '', capacity: 10, entryFee: 2000, payment: 'online' },
];
const QUIZ = 'quiz@2026-10-14';
const TINY = 'tiny@2026-10-10';
const LAUNCH = 'launch@2026-10-11';
const POKEMON = 'pokemon@2026-10-16';

const APP = '777777777777777777';
const GUILD = '111111111111111111';
const OTHER_GUILD = '121212121212121212';
const USER = '222222222222222222';
const OTHER = '333333333333333333';
const SESSIONS = '555555555555555555';
const EVENTS_CH = '666666666666666666';
const ROLE = '888888888888888888';
const MOBILE = '021 555 0100';

let lair;
let pending;
async function call(method, path, body, customer = '', extraHeaders = {}) {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders }, body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: response.status, data: await response.json() };
}
const settle = () => new Promise((r) => setTimeout(r, 15));

function ix(type, data, { user = USER, guild = GUILD, message = null, permissions = '0' } = {}) {
  return {
    id: '9001', application_id: APP, type, token: 'tok-123', version: 1, ...(guild ? { guild_id: guild } : {}), channel_id: '444444444444444444',
    ...(guild ? { member: { user: { id: user, username: 'ruby' }, permissions, roles: [] } } : { user: { id: user, username: 'ruby' } }),
    data, ...(message ? { message } : {}),
  };
}
const command = (name, options = [], o = {}) => ix(2, { id: 'c1', name, type: 1, options }, o);
/** A button or select on a public post (ephemeral: false) or on Gobgob's private card (ephemeral: true) */
const click = (customId, o = {}) => ix(3, {
  custom_id: customId, component_type: o.values ? 3 : 2, ...(o.values ? { values: o.values } : {}), ...(o.resolved ? { resolved: o.resolved } : {}),
}, { ...o, message: { id: '999999999999999990', flags: o.ephemeral ? 64 : 0 } });
/** A modal sent, in Discord's current shape (each box in a Label) */
const submit = (customId, fields, o = {}) => ix(5, {
  custom_id: customId,
  components: Object.entries(fields).map(([k, v], i) => ({ type: 18, id: i + 1, component: { type: 4, id: i + 20, custom_id: k, value: v } })),
}, { ...o, message: o.ephemeral ? { id: '999999999999999990', flags: 64 } : null });
async function discord(interaction) {
  const res = await lair.fetch(new Request('https://lair.test/internal/discord/interaction', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body: JSON.stringify(interaction),
  }));
  assert.equal(res.status, 200);
  return res.json();
}
/** Every custom_id on a message, row by row */
const ids = (answer) => (answer.data.components || []).flatMap((r) => r.components.map((c) => c.custom_id || c.url));
const labels = (answer) => (answer.data.components || []).flatMap((r) => r.components.map((c) => c.label || c.placeholder));
const textOf = (answer) => [answer.data.content || '', ...(answer.data.embeds || []).flatMap((e) => [e.title, e.description, ...(e.fields || []).flatMap((f) => [f.name, f.value]), e.footer?.text])].filter(Boolean).join('\n');
const boxes = (answer) => answer.data.components.map((l) => l.component.custom_id);

function setEnv(extra = {}) {
  lair.baseEnv = {
    ...lair.baseEnv, DISCORD_APPLICATION_ID: APP, DISCORD_PUBLIC_KEY: 'a'.repeat(64), DISCORD_BOT_TOKEN: 'bot-token', DISCORD_CLIENT_SECRET: 'client-secret',
    PUBLIC_URL: 'https://lair.test', ...extra,
  };
  lair.env = { ...lair.baseEnv };
}
function setChannels({ sessions = SESSIONS, events = EVENTS_CH, role = null, sessionsType = 0, eventsType = 0 } = {}) {
  lair.saveDiscordSetting('guild', GUILD, 'test');
  lair.saveDiscordSetting('sessions_channel', sessions, 'test');
  lair.saveDiscordSetting('sessions_type', sessionsType, 'test');
  lair.saveDiscordSetting('events_channel', events, 'test');
  lair.saveDiscordSetting('events_type', eventsType, 'test');
  lair.saveDiscordSetting('ping_role', role, 'test');
}
/** A linked member: Discord account → Dice Goblin account, with a profile (a mobile unless told otherwise) */
function linkMember(userId, customerId, profile = {}) {
  lair.sql.exec('INSERT INTO discord_links (user_id, customer_id, username, global_name, linked_at) VALUES (?, ?, ?, ?, ?)', userId, customerId, 'ruby', 'Ruby', NOW);
  lair.touchMember(customerId, { name: 'Ruby Tane', email: 'ruby@example.com', mobile: MOBILE, ...profile }, NOW);
}

/** Discord's API, faked: every call is kept, and routes can answer first */
function fakeDiscord() {
  const calls = [];
  const routes = [];
  let n = 1000;
  const reply = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const type = init.headers?.['Content-Type'] || '';
    let body = init.body;
    if (typeof body === 'string' && type.includes('json')) body = JSON.parse(body);
    const c = { method: init.method || 'GET', url: u, path: u.replace('https://discord.com/api/v10', ''), body, headers: init.headers || {} };
    calls.push(c);
    for (const route of routes) {
      const out = route(c, reply);
      if (out) return out;
    }
    if (c.method === 'POST' && /^\/channels\/\d+\/threads$/.test(c.path)) {
      n += 1;
      return reply({ id: String(800000000000000000 + n), message: { id: String(800000000000000000 + n) } });
    }
    const thread = c.path.match(/^\/channels\/\d+\/messages\/(\d+)\/threads$/);
    if (c.method === 'POST' && thread) return reply({ id: thread[1] });
    if (c.method === 'POST' && /^\/channels\/\d+\/messages$/.test(c.path)) {
      n += 1;
      return reply({ id: String(900000000000000000 + n) });
    }
    if (c.method === 'PATCH' && /^\/channels\/\d+(\/messages\/\d+)?$/.test(c.path)) return reply({ id: c.path.split('/').pop() });
    if (c.method === 'PUT' && /^\/applications\/\d+\/commands$/.test(c.path)) return reply(c.body);
    if (c.path === '/oauth2/token') return reply({ access_token: 'access-1', token_type: 'Bearer', scope: 'identify' });
    if (c.path === '/oauth2/token/revoke') return reply({});
    if (c.path === '/users/@me') return reply({ id: USER, username: 'ruby', global_name: 'Ruby' });
    if (c.path.startsWith('/webhooks/')) return reply({ id: 'w1' });
    return reply({ message: 'Unknown' }, 404);
  };
  return { calls, routes, posts: () => calls.filter((c) => c.method !== 'GET' && c.url.startsWith('https://discord.com/')) };
}

async function strahd(over = {}) {
  const res = await call('POST', 'games', {
    title: 'Curse of Strahd', system: 'D&D 5e', gm: 'Ana', email: 'ana@example.com', blurb: 'Mists and wolves.', seats: 4, tables: ['A1'],
    start: at('2026-10-15', 18), end: at('2026-10-15', 21), ...over,
  }, 'gm');
  assert.equal(res.status, 200, res.data.error);
  return res.data;
}
const weekly = () => strahd({ title: 'Weekly Pathfinder', system: 'Pathfinder 2e', tables: ['A2'], start: at('2026-10-13', 18), end: at('2026-10-13', 21), schedule: 'weekly' });
const guestSeat = (gameId, over = {}) => call('POST', 'bookings', {
  kind: 'gm-seat', gameId, people: 1, name: 'Sam Jones', email: 'sam@example.com', phone: MOBILE, players: [{ name: 'Sam Jones' }], ...over,
});

beforeEach(() => {
  Date.now = () => NOW;
  pending = [];
  lair = new Lair(fakeCtx(pending), { CURRENCY: 'NZD', SHOP: 'example-shop.myshopify.com' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: id === 'gm', tags: [] });
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, ROOMS, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  // the posts catch up only when a test asks (discordSync), never on a timer
  lair.discordAuto = false;
  resetConfigCache();
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
});

/* ---------------- storage ---------------- */
test('discord (round 14): one migration entry at the end, new tables and indexes only, and running it twice is harmless', () => {
  const mine = MIGRATIONS.filter((m) => m.some((s) => /CREATE TABLE IF NOT EXISTS discord_/.test(s)));
  assert.equal(mine.length, 1);
  assert.equal(MIGRATIONS[MIGRATIONS.length - 1], mine[0], 'at the end of the list');
  assert.ok(mine[0].every((s) => /^(CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS)/.test(s.trim())), 'new tables and indexes only');
  for (const table of ['discord_links', 'discord_states', 'discord_items', 'discord_posts', 'discord_settings']) {
    assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", table).one().n, 1, table);
  }
  for (const s of mine[0]) lair.sql.exec(s);
});

test('discord: the pieces Discord sees are well formed (commands, modal answers in both shapes, times typed)', () => {
  const commands = discordCommands();
  assert.deepEqual(commands.map((c) => c.name), ['games', 'events', 'table', 'mylair', 'link', 'lair-setup']);
  for (const c of commands) {
    assert.match(c.name, /^[-_a-z]{1,32}$/);
    assert.ok(c.description.length >= 1 && c.description.length <= 100, c.name);
    assert.deepEqual([c.contexts, c.integration_types], [[0], [0]], 'in the server only');
  }
  assert.equal(commands.find((c) => c.name === 'lair-setup').default_member_permissions, '32', 'server managers only');
  const table = commands.find((c) => c.name === 'table').options;
  assert.deepEqual(table.map((o) => [o.name, o.required]), [['day', true], ['time', true], ['people', true], ['hours', false], ['setup', false]], 'required options first');
  // Label-wrapped boxes (Discord's current shape) and the older Action Row ones
  assert.deepEqual(readModal({ components: [{ type: 18, component: { type: 4, custom_id: 'name', value: 'Ruby' } }, { type: 10, id: 2 }] }), { name: 'Ruby' });
  assert.deepEqual(readModal({ components: [{ type: 1, components: [{ type: 4, custom_id: 'name', value: 'Ruby' }] }] }), { name: 'Ruby' });
  assert.deepEqual(['14:00', '2pm', '2:30 PM', '12am', '12pm', 'midday', '9', '25:00', '13pm', 'soon'].map(parseClock), [840, 840, 870, 0, 720, 720, 540, null, null, null]);
  assert.equal(occRef('a-really-long-event-handle-that-goes-on-and-on-and-on-for-a-very-long-time-indeed@2026-10-14'), occRef('a-really-long-event-handle-that-goes-on-and-on-and-on-for-a-very-long-time-indeed@2026-10-14'));
  assert.match(occRef(QUIZ), /^[0-9a-z]{10}@20261014$/);
  assert.equal(inPlace({ type: 3, message: { flags: 64 } }), true, "Gobgob's private cards change in place");
  assert.equal(inPlace({ type: 3, message: { flags: 0 } }), false, 'a public post answers with a new private message');
  assert.deepEqual(deferFor({ type: 2 }), { type: 5, data: { flags: 64 } });
  assert.deepEqual(deferFor({ type: 3, message: { flags: 64 } }), { type: 6 });
  assert.deepEqual(deferFor({ type: 4 }), { type: 8, data: { choices: [] } });
});

/* ---------------- the Worker: signatures and late answers ---------------- */
async function keys() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
  const publicKey = hex(await crypto.subtle.exportKey('raw', pair.publicKey));
  const sign = async (timestamp, body) => hex(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(`${timestamp}${body}`)));
  return { publicKey, sign };
}
const workerEnv = (publicKey, extra = {}) => ({
  SHOP: 'example-shop.myshopify.com', DISCORD_PUBLIC_KEY: publicKey, DISCORD_APPLICATION_ID: APP,
  LAIR: { idFromName: () => 'dice-goblin', get: () => ({ fetch: (req) => lair.fetch(req) }) }, ...extra,
});
async function signed(k, interaction, { tamper = false, timestamp = '1760000000' } = {}) {
  const body = JSON.stringify(interaction);
  const signature = await k.sign(timestamp, body);
  return new Request('https://lair.test/discord/interactions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp }, body: tamper ? body.replace('games', 'gamez') : body,
  });
}

test("discord: the Worker checks Discord's signature (401 when it doesn't check out), answers PING itself and passes the rest to the Lair", async () => {
  const k = await keys();
  const env = workerEnv(k.publicKey);
  assert.equal(await verifyDiscord('{}', 'zz', '1', k.publicKey), false);
  const ping = await worker.fetch(await signed(k, { type: 1 }), env, { waitUntil: () => {} });
  assert.deepEqual([ping.status, await ping.json()], [200, { type: 1 }]);
  const forged = await worker.fetch(await signed(k, command('games'), { tamper: true }), env, { waitUntil: () => {} });
  assert.equal(forged.status, 401);
  const unsigned = await worker.fetch(new Request('https://lair.test/discord/interactions', { method: 'POST', body: '{"type":1}' }), env, { waitUntil: () => {} });
  assert.equal(unsigned.status, 401);
  const off = await worker.fetch(await signed(k, { type: 1 }), workerEnv(''), { waitUntil: () => {} });
  assert.equal(off.status, 503, 'not set up yet');
  const games = await worker.fetch(await signed(k, command('games')), env, { waitUntil: () => {} });
  const answer = await games.json();
  assert.equal(answer.type, 4);
  assert.equal(answer.data.flags, 64, 'private');
  assert.match(answer.data.content, /No sessions on the board/);
});

test('discord: when the Lair is slow, Discord gets a deferred answer at once and the Lair\'s answer goes in afterwards', async () => {
  const d = fakeDiscord();
  const k = await keys();
  const env = workerEnv(k.publicKey, { DISCORD_WAIT_MS: '5' });
  lair.discordInteraction = async () => {
    await new Promise((r) => setTimeout(r, 40));
    return { type: 4, data: { content: 'Here it is', flags: 64 } };
  };
  const waits = [];
  const res = await worker.fetch(await signed(k, command('games')), env, { waitUntil: (p) => waits.push(p) });
  assert.deepEqual(await res.json(), { type: 5, data: { flags: 64 } }, 'a private "thinking"');
  await Promise.all(waits);
  const edit = d.calls.find((c) => c.path === `/webhooks/${APP}/tok-123/messages/@original`);
  assert.equal(edit.method, 'PATCH');
  assert.deepEqual(edit.body, { content: 'Here it is' }, 'ephemeral was settled by the deferred answer');
  // a card that changes in place is acknowledged quietly, and a modal that came too late asks them to tap again
  lair.discordInteraction = async () => {
    await new Promise((r) => setTimeout(r, 40));
    return { type: 9, data: { custom_id: 'dg:mseat:x:s', title: 'Grab a seat', components: [] } };
  };
  const late = await worker.fetch(await signed(k, click('dg:seat:gm_x', { ephemeral: true })), env, { waitUntil: (p) => waits.push(p) });
  assert.deepEqual(await late.json(), { type: 6 });
  await Promise.all(waits);
  assert.equal(d.calls.filter((c) => c.path.startsWith('/webhooks/')).at(-1).body.content, DISCORD_WORDS.slow);
});

/* ---------------- who and where ---------------- */
test('discord: Gobgob works in the Dice Goblin server only (the first /lair-setup ties it there), never in a DM', async () => {
  assert.match((await discord(command('games', [], { guild: null }))).data.content, /only works in the Dice Goblin server/);
  assert.match((await discord(command('games', [], { guild: OTHER_GUILD }))).data.content, /No sessions/, 'not tied to a server yet');
  const panel = await discord(command('lair-setup', [], { permissions: '32' }));
  assert.match(textOf(panel), /Gobgob's Discord setup/);
  assert.equal(lair.discordSettings().guild, GUILD);
  assert.match((await discord(command('games', [], { guild: OTHER_GUILD }))).data.content, /only works in the Dice Goblin server/);
  assert.match((await discord(command('games'))).data.content, /No sessions/);
  // DISCORD_GUILD_ID in the config wins
  setEnv({ DISCORD_GUILD_ID: OTHER_GUILD });
  assert.match((await discord(command('games'))).data.content, /only works/);
});

/* ---------------- TTRPG sessions ---------------- */
test('/games: the public board (a series shows its next session only), each with its seats, and a list to pick from', async () => {
  const one = await strahd();
  const series = await weekly();
  const answer = await discord(command('games'));
  assert.equal(answer.type, 4);
  const text = textOf(answer);
  assert.match(text, /Weekly Pathfinder\*\* · Tue 13 Oct, 6pm · 4 seats left/);
  assert.match(text, /Curse of Strahd\*\* · Thu 15 Oct, 6pm · 4 seats left/);
  const options = answer.data.components[0].components[0].options;
  assert.deepEqual(options.map((o) => o.value), [`g:${series.game.id}`, `g:${one.game.id}`], 'soonest first, one per series');
  assert.match(options[1].description, /\$15/);
  // picking one opens its card in place
  const card = await discord(click('dg:pick', { values: [`g:${one.game.id}`], ephemeral: true }));
  assert.equal(card.type, 7);
  assert.equal(card.data.embeds[0].title, 'Curse of Strahd');
  assert.match(card.data.embeds[0].url, /\/pages\/gm-games#game=/);
  assert.deepEqual(labels(card), ['Grab a seat', 'Bring friends', "I'm interested", 'On the website', 'All sessions']);
  const regular = await discord(click('dg:pick', { values: [`g:${series.game.id}`], ephemeral: true }));
  assert.ok(labels(regular).includes('Save my seat every week'));
});

test('grab a seat as a guest: the pop-up asks what the website asks, the seat is booked, and it\'s theirs in Discord', async () => {
  const { game } = await strahd();
  const modal = await discord(click(`dg:seat:${game.id}`));
  assert.equal(modal.type, 9);
  assert.deepEqual(boxes(modal), ['name', 'email', 'mobile', 'friends', 'notes']);
  assert.ok(modal.data.title.length <= 45);
  // a mobile that isn't one: the website's words
  const wrong = await discord(submit(modal.data.custom_id, { name: 'Ruby Tane', email: 'ruby@example.com', mobile: '09 555 0100', friends: '', notes: '' }));
  assert.match(wrong.data.content, /That mobile number doesn't look right/);
  const done = await discord(submit(modal.data.custom_id, { name: 'Ruby Tane', email: 'ruby@example.com', mobile: MOBILE, friends: '', notes: 'First time!' }));
  assert.equal(done.type, 4);
  assert.equal(done.data.flags, 64);
  assert.equal(done.data.embeds[0].title, "You're in!");
  assert.match(textOf(done), /\$15 at the counter/);
  const seat = lair.sql.exec("SELECT * FROM bookings WHERE kind = 'gm-seat'").toArray();
  assert.equal(seat.length, 1);
  assert.deepEqual([seat[0].customer_id, seat[0].name, seat[0].phone, seat[0].notes], [null, 'Ruby Tane', MOBILE, 'First time!']);
  assert.match(textOf(done), new RegExp(seat[0].ref));
  assert.ok(lair.discordOwns({ discordUserId: USER }, 'booking', seat[0].id));
  // the floor counts it like any seat
  const floor = (await call('GET', `floor?from=${NOW}&to=${NOW + 30 * DAY}`)).data;
  assert.equal(floor.games.find((g) => g.id === game.id).taken, 1);
  // a second tap doesn't book twice
  const again = await discord(click(`dg:seat:${game.id}`));
  assert.match(again.data.content, /already got a seat/);
  assert.deepEqual(labels(again), ['Bring friends', 'Drop my seat']);
});

test('grab a seat as a linked member: one tap with a mobile on their profile, and the pop-up asks only for what\'s missing', async () => {
  const { game } = await strahd();
  linkMember(USER, '1001');
  const done = await discord(click(`dg:seat:${game.id}`));
  assert.equal(done.type, 4, 'no pop-up');
  assert.equal(done.data.embeds[0].title, "You're in!");
  const seat = lair.sql.exec("SELECT * FROM bookings WHERE kind = 'gm-seat'").toArray()[0];
  assert.deepEqual([seat.customer_id, seat.name, seat.email, seat.phone], ['1001', 'Ruby Tane', 'ruby@example.com', MOBILE]);
  assert.ok(ids(done).includes('https://www.dicegoblin.nz/pages/my-lair'), 'Open My Lair');
  // someone linked with no mobile yet
  const second = await strahd({ title: 'Mothership', start: at('2026-10-16', 18), end: at('2026-10-16', 21), tables: ['A3'] });
  linkMember(OTHER, '1002', { mobile: '' });
  const modal = await discord(click(`dg:seat:${second.game.id}`, { user: OTHER }));
  assert.deepEqual(boxes(modal), ['mobile', 'friends', 'notes']);
  const booked = await discord(submit(modal.data.custom_id, { mobile: '022 123 4567', friends: '', notes: '' }, { user: OTHER }));
  assert.equal(booked.data.embeds[0].title, "You're in!");
  assert.equal(lair.memberRow('1002').mobile, '022 123 4567', 'it goes on their profile, as on the website');
});

test('bring friends: with a seat already, the friends get theirs; a full table says so in the website\'s words', async () => {
  const { game } = await strahd({ seats: 3 });
  linkMember(USER, '1001');
  await discord(click(`dg:seat:${game.id}`));
  const modal = await discord(click(`dg:friends:${game.id}`));
  assert.equal(modal.type, 9);
  assert.match(modal.data.custom_id, /:f$/, 'friends only');
  assert.deepEqual(boxes(modal), ['friends', 'notes']);
  const done = await discord(submit(modal.data.custom_id, { friends: 'Kiri\nSam', notes: '' }));
  assert.match(done.data.embeds[0].description, /2 chairs/);
  const seats = lair.sql.exec("SELECT people, party FROM bookings WHERE kind = 'gm-seat' ORDER BY created_at, rowid").toArray();
  assert.deepEqual(seats.map((s) => s.people), [1, 2]);
  assert.deepEqual(JSON.parse(seats[1].party).map((p) => p.name), ['Kiri', 'Sam']);
  // full now: the card shows it, and a guest trying anyway hears the website's words
  const card = await discord(click('dg:pick', { values: [`g:${game.id}`], ephemeral: true, user: OTHER }));
  assert.equal(card.data.components[0].components[0].disabled, true);
  assert.equal(card.data.components[0].components[0].label, 'Full');
  const late = await discord(submit(`dg:mseat:${game.id}:s`, { name: 'Late Larry', email: 'larry@example.com', mobile: MOBILE, friends: '', notes: '' }, { user: OTHER }));
  assert.match(late.data.content, /This table is full/);
});

test("I'm interested: a linked member in one tap, a guest through the pop-up (its key kept, so they can take it back here)", async () => {
  const { game } = await strahd();
  linkMember(USER, '1001');
  const one = await discord(click(`dg:int:${game.id}`));
  assert.match(one.data.content, /noted you're keen on \*\*Curse of Strahd\*\*/);
  const modal = await discord(click(`dg:int:${game.id}`, { user: OTHER }));
  assert.deepEqual(boxes(modal), ['name', 'email', 'mobile', 'note']);
  const two = await discord(submit(modal.data.custom_id, { name: 'Kiri Smith', email: 'kiri@example.com', mobile: MOBILE, note: 'New to D&D' }, { user: OTHER }));
  assert.match(two.data.content, /keen on/);
  const rows = lair.sql.exec("SELECT * FROM interests WHERE kind = 'session' ORDER BY rowid").toArray();
  assert.deepEqual(rows.map((r) => [r.customer_id, r.name, r.note]), [['1001', 'Ruby Tane', ''], [null, 'Kiri Smith', 'New to D&D']]);
  assert.equal(lair.discordItemKey('interest', rows[1].id, OTHER), rows[1].remove_key);
  // taking it back, from the button on the answer
  const ask = await discord(click(`dg:ask:i:${rows[1].id}`, { user: OTHER, ephemeral: true }));
  assert.match(ask.data.content, /Take back "interested"/);
  const gone = await discord(click(`dg:drop:i:${rows[1].id}`, { user: OTHER, ephemeral: true }));
  assert.match(gone.data.content, /Taken back/);
  assert.equal(lair.sql.exec('SELECT status FROM interests WHERE id = ?', rows[1].id).one().status, 'removed');
});

test('save my seat every week: needs a linked account (the member code is the ticket); then they are a regular, and hear what a kept seat costs', async () => {
  const series = await weekly();
  const guest = await discord(click(`dg:every:${series.game.id}`));
  assert.match(guest.data.content, /needs a Dice Goblin account/);
  assert.ok(ids(guest).some((u) => /\/pages\/my-lair\?link=discord#profile$/.test(u)));
  linkMember(USER, '1001');
  const done = await discord(click(`dg:every:${series.game.id}`));
  assert.match(done.data.content, /You're a regular at \*\*Weekly Pathfinder\*\*!/);
  assert.match(done.data.content, /A seat you keep is yours to pay for, even if you don't come/);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM series_members WHERE customer_id = '1001' AND status = 'active'").one().n, 1);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE customer_id = '1001' AND kind = 'gm-seat' AND series_id IS NOT NULL").one().n, 1);
  // /mylair lists the game they're a regular at, and stopping works from there
  const mine = await discord(command('mylair'));
  assert.match(textOf(mine), /Your seat is saved every session/);
  const stop = mine.data.components[0].components[0].options.find((o) => o.value === `s:${series.game.seriesId}`);
  assert.ok(stop);
  const left = await discord(click(`dg:drop:s:${series.game.seriesId}`, { ephemeral: true }));
  assert.match(left.data.content, /not a regular there any more/);
  assert.equal(lair.sql.exec("SELECT status FROM series_members WHERE customer_id = '1001'").one().status, 'left');
});

/* ---------------- events ---------------- */
test("/events: the next fortnight's dates, each with its places, and the right buttons for each kind of event", async () => {
  const list = await discord(command('events'));
  const text = textOf(list);
  assert.match(text, /Tiny painting class\*\* · Tomorrow, 2pm · 2 places left/);
  assert.match(text, /Trivia night\*\* · Wed 14 Oct, 6pm · 20 places left/);
  assert.match(text, /Pokémon league\*\* · Fri 16 Oct, 5pm · just turn up/);
  const options = list.data.components[0].components[0].options;
  assert.deepEqual(options.map((o) => o.label), ['Tiny painting class', 'Launch day', 'Trivia night', 'Pokémon league']);
  const quiz = await discord(click('dg:pick', { values: [`e:${occRef(QUIZ)}`], ephemeral: true }));
  assert.deepEqual(labels(quiz), ['Sign up', 'Bring friends', 'Maybe', 'On the website', 'All events']);
  assert.match(textOf(quiz), /\$5 a person, paid at the counter/);
  const pokemon = await discord(click('dg:pick', { values: [`e:${occRef(POKEMON)}`], ephemeral: true }));
  assert.deepEqual(labels(pokemon), ["I'm coming", 'Maybe', 'On the website', 'All events']);
  assert.match(textOf(pokemon), /Bring your deck\./, "the event's description");
  assert.match(textOf(pokemon), /No need to sign up/);
  // a date that's gone from the calendar
  const gone = await discord(click('dg:pick', { values: ['e:0000000000@20261014'], ephemeral: true }));
  assert.match(gone.data.content, /isn't on the calendar any more/);
});

test("sign up: a linked member in one tap, a guest with friends (by name and member code), then it's full and the waitlist opens", async () => {
  linkMember(USER, '1001');
  lair.touchMember('2002', { name: 'Kiri Smith', email: 'kiri@example.com' }, NOW);
  const kiri = lair.memberRow('2002').code;
  const one = await discord(click(`dg:join:${occRef(TINY)}`));
  assert.equal(one.data.embeds[0].title, "You're on the list!");
  const joins = () => lair.sql.exec('SELECT * FROM event_joins ORDER BY rowid').toArray();
  assert.deepEqual(joins().map((j) => [j.customer_id, j.people]), [['1001', 1]]);
  // a second tap: already on the list
  assert.match((await discord(click(`dg:join:${occRef(TINY)}`))).data.content, /already on the list/);
  // a guest bringing friends on the quiz: names and member codes
  const modal = await discord(click(`dg:jfr:${occRef(QUIZ)}`, { user: OTHER }));
  assert.deepEqual(boxes(modal), ['name', 'email', 'mobile', 'friends', 'note']);
  const two = await discord(submit(modal.data.custom_id, { name: 'Sam Jones', email: 'sam@example.com', mobile: MOBILE, friends: `Tama\n${kiri}`, note: '' }, { user: OTHER }));
  assert.match(two.data.embeds[0].description, /3 spots/);
  assert.match(textOf(two), /\$15 at the counter/);
  const quiz = joins().find((j) => j.occurrence_id === QUIZ);
  assert.deepEqual(lair.sql.exec('SELECT name, customer_id FROM event_join_guests WHERE join_id = ? ORDER BY rowid', quiz.id).toArray().map((g) => [g.name, g.customer_id]), [['Tama', null], ['Kiri Smith', '2002']]);
  // the tiny class fills up: the card offers the waitlist, and joining it tells the team (nothing booked)
  await call('POST', `events/${encodeURIComponent(TINY)}/join`, { name: 'Jo', email: 'jo@example.com', phone: MOBILE, people: 1 });
  const card = await discord(click('dg:pick', { values: [`e:${occRef(TINY)}`], ephemeral: true, user: OTHER }));
  assert.deepEqual(labels(card).slice(0, 2), ['Join the waitlist', 'Maybe']);
  const wait = await discord(click(`dg:wait:${occRef(TINY)}`, { user: OTHER }));
  assert.deepEqual(boxes(wait), ['name', 'email', 'mobile', 'people']);
  const waiting = await discord(submit(wait.data.custom_id, { name: 'Sam Jones', email: 'sam@example.com', mobile: MOBILE, people: '2' }, { user: OTHER }));
  assert.match(waiting.data.content, /on the waitlist for \*\*Tiny painting class\*\* \(2 people\)\. Nothing's booked or paid/);
  assert.equal(lair.sql.exec("SELECT people FROM interests WHERE level = 'waitlist'").one().people, 2);
});

test('an event paid online gives a "Pay now" link and holds the spot for 30 minutes', async () => {
  linkMember(USER, '1001');
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.createCheckout = async () => ({ draftOrderId: 'gid://shopify/DraftOrder/7', checkoutUrl: 'https://checkout.test/7' });
  const done = await discord(click(`dg:join:${occRef(LAUNCH)}`));
  assert.equal(done.data.embeds[0].title, 'Pay to lock it in');
  assert.match(done.data.embeds[0].description, /for 30 minutes/);
  assert.ok(ids(done).includes('https://checkout.test/7'));
  assert.equal(lair.sql.exec('SELECT status FROM event_joins').one().status, 'held');
});

test("I'm coming and Maybe: a linked member in one tap, a guest through the pop-up", async () => {
  linkMember(USER, '1001');
  const coming = await discord(click(`dg:coming:${occRef(POKEMON)}`));
  assert.match(coming.data.content, /expecting you at \*\*Pokémon league\*\*/);
  const modal = await discord(click(`dg:maybe:${occRef(QUIZ)}`, { user: OTHER }));
  assert.deepEqual(boxes(modal), ['name', 'email', 'mobile']);
  const maybe = await discord(submit(modal.data.custom_id, { name: 'Sam Jones', email: 'sam@example.com', mobile: MOBILE }, { user: OTHER }));
  assert.match(maybe.data.content, /Marked as maybe for \*\*Trivia night\*\*/);
  assert.deepEqual(lair.sql.exec('SELECT target_id, level, customer_id FROM interests ORDER BY rowid').toArray().map((r) => [r.target_id, r.level, r.customer_id]), [[POKEMON, 'coming', '1001'], [QUIZ, 'maybe', null]]);
});

/* ---------------- tables ---------------- */
test("/table: the day and time boxes fill in with the days the Lair is open and times on the hour (none too soon)", async () => {
  const days = await discord(ix(4, { name: 'table', options: [{ name: 'day', type: 3, value: '', focused: true }] }));
  assert.equal(days.type, 8);
  const names = days.data.choices.map((c) => c.name);
  assert.deepEqual(names.slice(0, 4), ['Today, Fri 9 Oct', 'Tomorrow, Sat 10 Oct', 'Sun 11 Oct', 'Tue 13 Oct'], 'Monday is closed');
  assert.equal(days.data.choices[1].value, '2026-10-10');
  assert.ok(days.data.choices.length <= 25);
  const typed = await discord(ix(4, { name: 'table', options: [{ name: 'day', type: 3, value: 'sat', focused: true }] }));
  assert.ok(typed.data.choices.every((c) => /Sat/.test(c.name)));
  const times = await discord(ix(4, { name: 'table', options: [{ name: 'day', type: 3, value: '2026-10-10' }, { name: 'time', type: 3, value: '', focused: true }, { name: 'hours', type: 4, value: 2 }] }));
  assert.deepEqual([times.data.choices[0], times.data.choices.at(-1)], [{ name: '10am', value: '10:00' }, { name: '9pm', value: '21:00' }]);
  const today = await discord(ix(4, { name: 'table', options: [{ name: 'day', type: 3, value: '2026-10-09' }, { name: 'time', type: 3, value: '', focused: true }] }));
  assert.equal(today.data.choices[0].name, '2pm', 'an hour ahead at the earliest');
});

const tableCmd = (day, timeText, people, extra = [], o = {}) => command('table', [
  { name: 'day', type: 3, value: day }, { name: 'time', type: 3, value: timeText }, { name: 'people', type: 4, value: people }, ...extra,
], o);

test('/table: a choice per room (side by side, doubled for a wargame), booked in one tap for a linked member; a guest fills in the pop-up', async () => {
  const four = await discord(tableCmd('2026-10-10', '14:00', 4, [{ name: 'hours', type: 4, value: 3 }]));
  assert.match(four.data.embeds[0].title, /Tables for 4, Tomorrow, 2pm to 5pm/);
  assert.deepEqual(labels(four), ['Common room: T1 · $40', 'Side room 1: A1 · $40', 'Fancy room: F1 · $60']);
  const war = await discord(tableCmd('2026-10-10', '14:00', 4, [{ name: 'setup', type: 3, value: 'wargame' }]));
  assert.deepEqual(labels(war).slice(0, 2), ['Common room: T1 + T2 · $40', 'Side room 1: A1 + A2 · $40']);
  const two = await discord(tableCmd('2026-10-10', '14:00', 2));
  assert.ok(!labels(two).some((l) => /Fancy/.test(l)), 'the Fancy room is for 4 or more');
  // a linked member books T1 in one tap
  linkMember(USER, '1001');
  const pick = four.data.components[0].components[0].custom_id;
  const done = await discord(click(pick, { ephemeral: true }));
  assert.equal(done.type, 7);
  assert.equal(done.data.embeds[0].title, "You're booked in!");
  const booking = lair.sql.exec("SELECT * FROM bookings WHERE kind = 'table'").toArray()[0];
  assert.deepEqual([booking.tables, booking.customer_id, booking.people, booking.ends_at - booking.starts_at, booking.amount], ['["T1"]', '1001', 4, 3 * HOUR, 4000]);
  // a guest picks the side room: the pop-up, then the booking
  const modal = await discord(click(four.data.components[0].components[1].custom_id, { user: OTHER, ephemeral: true }));
  assert.equal(modal.type, 9);
  assert.deepEqual(boxes(modal), ['name', 'email', 'mobile', 'notes']);
  const booked = await discord(submit(modal.data.custom_id, { name: 'Sam Jones', email: 'sam@example.com', mobile: MOBILE, notes: 'Catan night' }, { user: OTHER, ephemeral: true }));
  assert.equal(booked.data.embeds[0].title, "You're booked in!");
  const side = lair.sql.exec("SELECT * FROM bookings WHERE tables = '[\"A1\"]'").one();
  assert.deepEqual([side.customer_id, side.notes], [null, 'Catan night']);
  assert.ok(lair.discordOwns({ discordUserId: OTHER }, 'booking', side.id));
});

test("/table: the house rules about the time come back as the booking page says them, a packed time offers nearby ones, and a table taken meanwhile shows what's left", async () => {
  assert.match((await discord(tableCmd('2026-10-09', '13:00', 2))).data.content, /too soon to book online/);
  assert.match((await discord(tableCmd('2026-10-12', '14:00', 2))).data.content, /We're closed at that time/);
  assert.match((await discord(tableCmd('2026-10-10', '22:00', 2, [{ name: 'hours', type: 4, value: 2 }]))).data.content, /outside opening hours/);
  assert.match((await discord(tableCmd('someday', '14:00', 2))).data.content, /Pick a day from the list/);
  // a tournament locks every table from 2pm to 4pm on Saturday
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, ROOMS, [
    ...EVENTS, { id: 'tourney', title: 'Tournament', start: at('2026-10-10', 14), end: at('2026-10-10', 16), tables: 'all', lockTables: true },
  ]);
  const packed = await discord(tableCmd('2026-10-10', '14:00', 4, [{ name: 'hours', type: 4, value: 2 }]));
  assert.match(packed.data.embeds[0].description, /Every table's taken at that time/);
  assert.deepEqual(labels(packed), ['Try midday', 'Try 4pm', 'Try 5pm']);
  const more = await discord(click(packed.data.components[0].components[1].custom_id, { ephemeral: true }));
  assert.match(more.data.embeds[0].title, /4pm to 6pm/);
  // someone books T1 on the website while they're deciding
  linkMember(USER, '1001');
  const choice = more.data.components[0].components[0].custom_id;
  const web = await call('POST', 'bookings', { kind: 'table', tables: ['T1'], start: at('2026-10-10', 16), end: at('2026-10-10', 18), people: 4, name: 'Jo', email: 'jo@example.com', phone: MOBILE });
  assert.equal(web.status, 200, web.data.error);
  const late = await discord(click(choice, { ephemeral: true }));
  assert.match(late.data.content, /Someone just grabbed that table/);
  assert.equal(labels(late)[0], 'Common room: T2 · $40');
});

/* ---------------- /mylair ---------------- */
test("/mylair: what's theirs (on their account or made here), and cancelling from the list; nobody can cancel someone else's", async () => {
  const { game } = await strahd();
  linkMember(USER, '1001');
  await discord(click(`dg:seat:${game.id}`));
  await discord(click(`dg:join:${occRef(QUIZ)}`));
  const web = await call('POST', 'bookings', { kind: 'table', tables: ['T5'], start: at('2026-10-11', 12), end: at('2026-10-11', 14), people: 2, name: 'Ruby Tane', email: 'ruby@example.com', phone: MOBILE }, '1001');
  assert.equal(web.status, 200, web.data.error);
  const mine = await discord(command('mylair'));
  const text = textOf(mine);
  assert.match(text, /🪑 \*\*Table T5\*\* · Sun 11 Oct, midday to 2pm/);
  assert.match(text, /🎟️ \*\*Trivia night\*\* · Wed 14 Oct, 6pm to 8pm · `[A-Z]+-[A-Z]+-\d+` · \$5 at the counter/);
  assert.match(text, /🎲 \*\*Curse of Strahd\*\* · Thu 15 Oct, 6pm to 9pm .*\$15 at the counter/);
  const options = mine.data.components[0].components[0].options;
  assert.deepEqual(options.map((o) => o.label), ['Cancel: Table T5', 'Drop: Trivia night', 'Drop: Curse of Strahd']);
  const seat = lair.sql.exec("SELECT id FROM bookings WHERE kind = 'gm-seat'").one().id;
  // someone else can't, even with the button's id
  const theirs = await discord(click(`dg:ask:b:${seat}`, { user: OTHER, ephemeral: true }));
  assert.match(theirs.data.content, /already gone/);
  const forged = await discord(click(`dg:drop:b:${seat}`, { user: OTHER, ephemeral: true }));
  assert.match(forged.data.content, /Only staff can change that booking/);
  // they can
  const ask = await discord(click('dg:mine', { values: [`b:${seat}`], ephemeral: true }));
  assert.match(ask.data.content, /Drop your seat at \*\*Curse of Strahd\*\*/);
  const dropped = await discord(click(`dg:drop:b:${seat}`, { ephemeral: true }));
  assert.match(dropped.data.content, /Done\. Gobgob has let the GM know/);
  assert.equal(lair.sql.exec('SELECT status FROM bookings WHERE id = ?', seat).one().status, 'cancelled');
  assert.doesNotMatch(textOf(dropped), /Curse of Strahd/);
  const join = lair.sql.exec('SELECT id FROM event_joins').one().id;
  assert.match((await discord(click(`dg:drop:j:${join}`, { ephemeral: true }))).data.content, /Your spot is free/);
});

test("a guest's booking made in Discord is theirs to cancel there (and only theirs), as a logged-in member's is on the website", async () => {
  const { game } = await strahd();
  const modal = await discord(click(`dg:seat:${game.id}`));
  await discord(submit(modal.data.custom_id, { name: 'Ruby Tane', email: 'ruby@example.com', mobile: MOBILE, friends: '', notes: '' }));
  const seat = lair.sql.exec("SELECT id FROM bookings WHERE kind = 'gm-seat'").one().id;
  // the website's guest can't cancel it (no account) and neither can another Discord user
  assert.equal((await call('POST', `bookings/${seat}/update`, { status: 'cancelled' })).status, 403);
  await assert.rejects(lair.updateBooking(seat, { status: 'cancelled' }, { customerId: null, staff: false, discordUserId: OTHER }), /Only staff/);
  const res = await lair.updateBooking(seat, { status: 'cancelled' }, { customerId: null, staff: false, discordUserId: USER });
  assert.equal(res.booking.status, 'cancelled');
});

/* ---------------- Link Discord ---------------- */
test('Link Discord: My Lair starts it, Discord sends them back, and the accounts are linked one to one; guest bookings made in Discord join the account', async () => {
  const d = fakeDiscord();
  setEnv();
  const { game } = await strahd();
  // a guest seat made in Discord before linking
  const modal = await discord(click(`dg:seat:${game.id}`));
  await discord(submit(modal.data.custom_id, { name: 'Ruby Tane', email: 'ruby.other@example.com', mobile: MOBILE, friends: '', notes: '' }));
  const start = await call('POST', 'me/discord/start', {}, '1001');
  assert.equal(start.status, 200, start.data.error);
  const url = new URL(start.data.url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://discord.com/oauth2/authorize');
  assert.deepEqual(
    ['response_type', 'client_id', 'scope', 'redirect_uri', 'prompt'].map((k) => url.searchParams.get(k)),
    ['code', APP, 'identify', 'https://www.dicegoblin.nz/pages/my-lair', 'none'],
  );
  const state = url.searchParams.get('state');
  assert.match(state, /^dg[0-9a-f]{32}$/);
  // someone else's state, or a made-up one, doesn't work
  assert.match((await call('POST', 'me/discord/finish', { code: 'c0de', state }, '1002')).data.error, /expired/);
  assert.match((await call('POST', 'me/discord/finish', { code: 'c0de', state: `dg${'0'.repeat(32)}` }, '1001')).data.error, /expired/);
  // (and that didn't use it up)
  const done = await call('POST', 'me/discord/finish', { code: 'c0de', state }, '1001');
  assert.equal(done.status, 200, done.data.error);
  assert.deepEqual(done.data.discord, { ready: true, linked: { username: 'ruby', name: 'Ruby', at: NOW } });
  assert.equal(done.data.adopted, 1);
  const token = d.calls.find((c) => c.path === '/oauth2/token');
  assert.equal(new URLSearchParams(token.body).get('redirect_uri'), 'https://www.dicegoblin.nz/pages/my-lair');
  assert.equal(new URLSearchParams(token.body).get('code'), 'c0de');
  await settle();
  assert.ok(d.calls.some((c) => c.path === '/oauth2/token/revoke'), "Discord's token is thrown away");
  assert.equal(lair.sql.exec("SELECT customer_id FROM bookings WHERE kind = 'gm-seat'").one().customer_id, '1001', 'the guest seat joined the account');
  assert.equal(lair.discordLinkRow(USER).customer_id, '1001');
  // a state works once
  assert.match((await call('POST', 'me/discord/finish', { code: 'c0de', state }, '1001')).data.error, /expired/);
  // GET /me says so; linking another account moves the Discord account across
  assert.deepEqual((await call('GET', 'me', null, '1001')).data.discord.linked.name, 'Ruby');
  const again = new URL((await call('POST', 'me/discord/start', {}, '1002')).data.url).searchParams.get('state');
  assert.equal((await call('POST', 'me/discord/finish', { code: 'c0de', state: again }, '1002')).status, 200);
  assert.equal(lair.discordLinkRow(USER).customer_id, '1002');
  assert.equal((await call('GET', 'me', null, '1001')).data.discord.linked, null);
  // unlinking
  assert.equal((await call('POST', 'me/discord/unlink', {}, '1002')).data.ok, true);
  assert.equal(lair.discordLinkRow(USER), null);
});

test("Link Discord: a state is good for 10 minutes; Discord refusing says so; it's off without the client secret", async () => {
  const d = fakeDiscord();
  setEnv();
  const state = new URL((await call('POST', 'me/discord/start', {}, '1001')).data.url).searchParams.get('state');
  Date.now = () => NOW + 11 * MIN;
  assert.match((await call('POST', 'me/discord/finish', { code: 'c0de', state }, '1001')).data.error, /expired/);
  Date.now = () => NOW;
  d.routes.push((c, reply) => (c.path === '/oauth2/token' ? reply({ error: 'invalid_grant' }, 400) : null));
  const fresh = new URL((await call('POST', 'me/discord/start', {}, '1001')).data.url).searchParams.get('state');
  assert.match((await call('POST', 'me/discord/finish', { code: 'bad', state: fresh }, '1001')).data.error, /Discord didn't let Gobgob in/);
  assert.equal((await call('POST', 'me/discord/start', {})).status, 401, 'logged in only');
  setEnv({ DISCORD_CLIENT_SECRET: '' });
  assert.equal((await call('POST', 'me/discord/start', {}, '1001')).status, 503);
  assert.equal((await call('GET', 'me', null, '1001')).data.discord.ready, false);
});

test('/link in Discord: how to link, or which account it is with a way to unlink', async () => {
  setEnv();
  const how = await discord(command('link'));
  assert.match(how.data.content, /Link your Discord to your Dice Goblin account/);
  assert.ok(ids(how).includes('https://www.dicegoblin.nz/pages/my-lair?link=discord#profile'));
  linkMember(USER, '1001');
  const linked = await discord(command('link'));
  assert.match(linked.data.content, /Linked to \*\*Ruby Tane\*\*'s Dice Goblin account \(member code \*\*[A-Z]+-[A-Z]+-\d+\*\*\)/);
  const gone = await discord(click('dg:unlink', { ephemeral: true }));
  assert.match(gone.data.content, /Unlinked\. Anything you booked stays booked/);
  assert.equal(lair.discordLinkRow(USER), null);
});

/* ---------------- /lair-setup ---------------- */
test('/lair-setup: server managers only (checked on every click); channels, the ping role and the switches', async () => {
  setEnv();
  assert.match((await discord(command('lair-setup'))).data.content, /Only server managers/);
  const manager = { permissions: '32', ephemeral: true };
  const panel = await discord(command('lair-setup', [], manager));
  assert.deepEqual(labels(panel), ['Channel for TTRPG sessions', 'Channel for events', 'Role to ping when a seat opens (optional)', 'Auto-posts: On', 'Seat pings: On', 'Round-up: On', 'Post now']);
  assert.match((await discord(click('dg:set:posts', { ephemeral: true }))).data.content, /Only server managers/);
  const picked = await discord(click('dg:set:sessions', { ...manager, values: [SESSIONS], resolved: { channels: { [SESSIONS]: { id: SESSIONS, type: 15 } } } }));
  assert.match(picked.data.content, /TTRPG sessions go to <#555555555555555555>/);
  assert.deepEqual([lair.discordSettings().sessionsChannel, lair.discordSettings().sessionsType], [SESSIONS, 15]);
  assert.match(textOf(picked), /a forum: each one gets its own post/);
  const voice = await discord(click('dg:set:events', { ...manager, values: [EVENTS_CH], resolved: { channels: { [EVENTS_CH]: { id: EVENTS_CH, type: 2 } } } }));
  assert.match(voice.data.content, /Pick a text, announcement or forum channel/);
  await discord(click('dg:set:role', { ...manager, values: [ROLE] }));
  assert.equal(lair.discordSettings().pingRole, ROLE);
  const off = await discord(click('dg:set:posts', manager));
  assert.ok(labels(off).includes('Auto-posts: Off'));
  assert.equal(lair.discordCanPost(), false);
  await discord(click('dg:set:posts', manager));
  assert.equal(lair.discordCanPost(), true);
  setEnv({ DISCORD_BOT_TOKEN: '' });
  assert.match(textOf(await discord(command('lair-setup', [], manager))), /token isn't in Cloudflare yet/);
});

/* ---------------- posts in the server ---------------- */
test('posts: each session (one per series, with a chat thread) and each event date in the next week goes up; the website links to them', async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels();
  const one = await strahd();
  const series = await weekly();
  const out = await lair.discordSync();
  assert.deepEqual([out.created, out.failed], [5, 0], '2 sessions and 3 event dates (Pokémon is 7 days and 4 hours away)');
  const created = d.calls.filter((c) => c.method === 'POST' && /\/messages$/.test(c.path));
  assert.equal(created.filter((c) => c.path === `/channels/${SESSIONS}/messages`).length, 2);
  assert.equal(created.filter((c) => c.path === `/channels/${EVENTS_CH}/messages`).length, 3);
  for (const c of created) {
    assert.deepEqual(c.body.allowed_mentions, { parse: [] }, 'posts never ping');
    assert.equal(c.body.enforce_nonce, true);
    assert.equal(c.headers.Authorization, 'Bot bot-token');
    assert.match(c.headers['User-Agent'], /^DiscordBot \(/);
  }
  const threads = d.calls.filter((c) => /\/messages\/\d+\/threads$/.test(c.path));
  assert.deepEqual(threads.map((c) => c.body.name).sort(), ['Curse of Strahd', 'Weekly Pathfinder']);
  const strahdPost = created.find((c) => c.body.embeds[0].title === 'Curse of Strahd');
  assert.deepEqual(strahdPost.body.components[0].components.map((b) => b.label), ['Grab a seat', 'Bring friends', "I'm interested", 'On the website']);
  // the floor says where each one's chat is
  const floor = (await call('GET', `floor?from=${NOW}&to=${NOW + 30 * DAY}`)).data;
  assert.match(floor.games.find((g) => g.id === one.game.id).discordUrl, new RegExp(`^https://discord\\.com/channels/${GUILD}/\\d+$`));
  assert.ok(floor.games.find((g) => g.id === series.game.id).discordUrl);
  assert.match(floor.eventDiscord[QUIZ], new RegExp(`^https://discord\\.com/channels/${GUILD}/${EVENTS_CH}/\\d+$`));
  // nothing changed, nothing sent
  const before = d.calls.length;
  const quiet = await lair.discordSync();
  assert.deepEqual([quiet.created, quiet.edited], [0, 0]);
  assert.equal(d.calls.length, before);
});

test('posts: a booking changes the seats and the post is edited; a seat that opens in a full session pings the role, once', async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ events: null, role: ROLE });
  const { game } = await strahd({ seats: 2 });
  await lair.discordSync();
  const a = await guestSeat(game.id);
  assert.equal(a.status, 200, a.data.error);
  const edited = await lair.discordSync();
  assert.equal(edited.edited, 1);
  const patch = d.calls.filter((c) => c.method === 'PATCH').at(-1);
  assert.match(JSON.stringify(patch.body.embeds[0].fields), /1 of 2 left/);
  assert.deepEqual(patch.body.allowed_mentions, { parse: [] });
  await guestSeat(game.id, { email: 'kiri@example.com', name: 'Kiri Smith', players: [{ name: 'Kiri Smith' }] });
  await lair.discordSync();
  const full = d.calls.filter((c) => c.method === 'PATCH').at(-1);
  assert.match(JSON.stringify(full.body.embeds[0].fields), /Full right now/);
  assert.equal(full.body.components[0].components[0].disabled, true);
  // Sam drops out: the post shows a seat, and the role hears
  await call('POST', `bookings/${a.data.booking.id}/update`, { status: 'cancelled' }, 'staff');
  const opened = await lair.discordSync();
  assert.deepEqual([opened.pinged, opened.edited], [1, 1]);
  const ping = d.calls.find((c) => c.method === 'POST' && c.body?.content?.includes('A seat just opened up'));
  assert.equal(ping.path, `/channels/${SESSIONS}/messages`);
  assert.match(ping.body.content, /^<@&888888888888888888> A seat just opened up at \*\*Curse of Strahd\*\* \(Thu 15 Oct, 6pm\)\. Just the one, so be quick\.$/);
  assert.deepEqual(ping.body.allowed_mentions, { roles: [ROLE] }, 'only that role');
  assert.equal(ping.body.components[0].components[0].custom_id, `dg:seat:${game.id}`);
  // full again and free again within half an hour: no second ping
  const b = await guestSeat(game.id, { email: 'jo@example.com', name: 'Jo', players: [{ name: 'Jo' }] });
  await lair.discordSync();
  await call('POST', `bookings/${b.data.booking.id}/update`, { status: 'cancelled' }, 'staff');
  assert.equal((await lair.discordSync()).pinged, 0);
});

test('posts: a series moves its post on to the next session; a one-shot that has been played is closed off without buttons', async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ events: null });
  const one = await strahd();
  const series = await weekly();
  await lair.discordSync();
  const seriesPost = lair.sql.exec("SELECT * FROM discord_posts WHERE id LIKE 's:%'").one();
  assert.equal(seriesPost.target_id, series.game.id);
  // after Tuesday's session: the same message shows the next Tuesday
  Date.now = () => at('2026-10-13', 21, 30);
  await lair.discordSync();
  const moved = lair.sql.exec("SELECT * FROM discord_posts WHERE id LIKE 's:%'").one();
  assert.equal(moved.message_id, seriesPost.message_id, 'the same post (and its thread)');
  assert.notEqual(moved.target_id, series.game.id);
  const patch = d.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith(`/messages/${seriesPost.message_id}`)).at(-1);
  assert.match(JSON.stringify(patch.body.embeds[0].fields), /Tue 20 Oct, 6pm to 9pm/);
  // after Thursday's one-shot
  Date.now = () => at('2026-10-15', 21, 30);
  const out = await lair.discordSync();
  assert.equal(out.ended, 1);
  const ended = d.calls.filter((c) => c.method === 'PATCH').at(-1);
  assert.match(ended.body.embeds[0].description, /This session has been played/);
  assert.deepEqual(ended.body.components[0].components.map((c) => c.style), [5], 'a link to the board only');
  assert.equal(lair.sql.exec("SELECT status FROM discord_posts WHERE target_id = ? AND id LIKE 'g:%'", one.game.id).one().status, 'ended');
  // a cancelled session says so
  const other = await strahd({ title: 'Delta Green', start: at('2026-10-17', 18), end: at('2026-10-17', 21), tables: ['A3'] });
  await lair.discordSync();
  await call('POST', `games/${other.game.id}/update`, { status: 'cancelled' }, 'gm');
  await lair.discordSync();
  assert.match(d.calls.filter((c) => c.method === 'PATCH').at(-1).body.embeds[0].description, /This session was cancelled/);
});

test('posts: in a forum, each session is its own post (its own thread): edits go in the thread, a quiet thread is opened again first, and pings go in the thread', async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ events: null, sessionsType: 15, role: ROLE });
  const { game } = await strahd({ seats: 2 });
  await guestSeat(game.id, { email: 'kiri@example.com', name: 'Kiri', players: [{ name: 'Kiri' }] });
  await lair.discordSync();
  const create = d.calls.find((c) => c.method === 'POST' && c.path === `/channels/${SESSIONS}/threads`);
  assert.equal(create.body.name, 'Curse of Strahd');
  assert.equal(create.body.message.embeds[0].title, 'Curse of Strahd');
  const post = lair.sql.exec('SELECT * FROM discord_posts').one();
  assert.equal(post.message_channel, post.thread_id);
  assert.equal(post.message_id, post.thread_id);
  // the thread went quiet (archived): open it, then edit
  let refused = false;
  d.routes.push((c, reply) => {
    if (!refused && c.method === 'PATCH' && c.path.includes('/messages/')) {
      refused = true;
      return reply({ message: 'Thread is archived', code: 50083 }, 400);
    }
    return null;
  });
  const seat = await guestSeat(game.id);
  await lair.discordSync();
  const patches = d.calls.filter((c) => c.method === 'PATCH');
  assert.deepEqual(patches.map((c) => c.path), [`/channels/${post.thread_id}/messages/${post.message_id}`, `/channels/${post.thread_id}`, `/channels/${post.thread_id}/messages/${post.message_id}`]);
  assert.deepEqual(patches[1].body, { archived: false });
  await call('POST', `bookings/${seat.data.booking.id}/update`, { status: 'cancelled' }, 'staff');
  await lair.discordSync();
  const ping = d.calls.find((c) => c.body?.content?.includes('A seat just opened up'));
  assert.equal(ping.path, `/channels/${post.thread_id}/messages`, "forums take posts, so the ping goes in the session's thread");
});

test("posts: Discord saying wait holds posting off; one round makes a dozen calls at most; a refused post is tried again; a deleted one goes up again", async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ events: null });
  for (let i = 0; i < 8; i += 1) await strahd({ title: `Game ${i + 1}`, start: at('2026-10-16', 12 + i), end: at('2026-10-16', 13 + i), tables: ['T10'], seats: 2 });
  const first = await lair.discordSync();
  assert.deepEqual([first.created, first.more], [6, true], 'two calls each (the post and its thread), twelve in all');
  const second = await lair.discordSync();
  assert.equal(second.created, 2);
  // Discord says wait
  d.routes.push((c, reply) => (c.method === 'PATCH' ? reply({ message: 'You are being rate limited.', retry_after: 30, global: false }, 429) : null));
  await guestSeat(lair.sql.exec("SELECT target_id FROM discord_posts WHERE title = 'Game 1'").one().target_id);
  const waited = await lair.discordSync();
  assert.equal(waited.failed, 1);
  assert.deepEqual(await lair.discordSync(), { waiting: true });
  d.routes.length = 0;
  Date.now = () => NOW + 31_000;
  assert.equal((await lair.discordSync()).edited, 1);
  // a post deleted in Discord: the edit's 404 sets it aside, and the next round puts up a fresh one
  d.routes.push((c, reply) => (c.method === 'PATCH' ? reply({ message: 'Unknown Message', code: 10008 }, 404) : null));
  await guestSeat(lair.sql.exec("SELECT target_id FROM discord_posts WHERE title = 'Game 2'").one().target_id);
  await lair.discordSync();
  d.routes.length = 0;
  const again = await lair.discordSync();
  assert.equal(again.created, 1);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM discord_posts WHERE title = 'Game 2' AND status = 'live'").one().n, 1);
  // a refused post (no permission in the channel) is tried again later
  const g9 = await strahd({ title: 'Game 9', start: at('2026-10-17', 12), end: at('2026-10-17', 13), tables: ['T11'] });
  d.routes.push((c, reply) => (c.method === 'POST' ? reply({ message: 'Missing Permissions', code: 50013 }, 403) : null));
  assert.equal((await lair.discordSync()).failed, 1);
  assert.match(lair.sql.exec("SELECT error FROM discord_posts WHERE target_id = ?", g9.game.id).one().error, /50013/);
  d.routes.length = 0;
  assert.equal((await lair.discordSync()).created, 0, 'not straight away');
  Date.now = () => NOW + 31 * MIN + 31_000;
  assert.equal((await lair.discordSync()).created, 1);
});

test('posts: picking another channel leaves the old posts alone and puts new ones up there', async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ events: null });
  await strahd();
  await lair.discordSync();
  lair.saveDiscordSetting('sessions_channel', '565656565656565656', 'test');
  const out = await lair.discordSync();
  assert.equal(out.created, 1);
  assert.ok(d.calls.some((c) => c.path === '/channels/565656565656565656/messages'));
  assert.deepEqual(lair.sql.exec('SELECT status FROM discord_posts ORDER BY created_at, status').toArray().map((r) => r.status).sort(), ['live', 'moved']);
});

test('posts catch up by themselves a moment after a booking changes (once for a burst), and not at all until the bot can post', async () => {
  const d = fakeDiscord();
  lair.discordAuto = true;
  lair.discordDelay = 5;
  await strahd();
  await settle();
  assert.equal(d.calls.length, 0, 'no token, no channel: nothing');
  setEnv();
  setChannels({ events: null });
  const game = lair.sql.exec('SELECT id FROM games').one().id;
  await guestSeat(game);
  await guestSeat(game, { email: 'kiri@example.com', name: 'Kiri', players: [{ name: 'Kiri' }] });
  await settle();
  await Promise.all(pending);
  assert.equal(d.calls.filter((c) => c.method === 'POST' && c.path === `/channels/${SESSIONS}/messages`).length, 1, 'one post, after the burst');
  assert.match(JSON.stringify(d.calls.find((c) => c.path === `/channels/${SESSIONS}/messages`).body.embeds[0].fields), /2 of 4 left/);
});

test('the midday round-up: today\'s spare seats and places, once a day from midday, never in a forum', async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels();
  Date.now = () => at('2026-10-10', 11, 50);
  await strahd({ title: 'Saturday one-shot', start: at('2026-10-10', 18), end: at('2026-10-10', 21) });
  const rules = lair.rulesCache;
  assert.equal(await lair.discordDigest(rules, Date.now()), null, 'not before midday');
  Date.now = () => at('2026-10-10', 12, 10);
  const out = await lair.discordDigest(rules, Date.now());
  assert.deepEqual([out.posted, out.items], [true, 2]);
  const post = d.calls.find((c) => c.method === 'POST' && c.body?.content?.startsWith('**Still room at the Lair today:**'));
  assert.equal(post.path, `/channels/${SESSIONS}/messages`);
  assert.match(post.body.content, /Tiny painting class\*\* · 2pm · 2 places left/);
  assert.match(post.body.content, /Saturday one-shot\*\* · 6pm · 4 seats left/);
  assert.equal(post.body.flags, 4096, 'no notification buzz');
  assert.deepEqual(post.body.components[0].components[0].options.map((o) => o.value.slice(0, 2)), ['e:', 'g:']);
  assert.equal(await lair.discordDigest(rules, Date.now()), null, 'once a day');
  // its list opens the card as a private message
  const card = await discord(click('dg:pick', { values: [post.body.components[0].components[0].options[1].value] }));
  assert.deepEqual([card.type, card.data.flags], [4, 64]);
  // in a forum-only setup it doesn't go up
  lair.sql.exec("DELETE FROM meta WHERE key = 'discord-digest'");
  setChannels({ sessionsType: 15, eventsType: 15 });
  assert.equal((await lair.discordDigest(rules, Date.now())).posted, false);
});

test('slash commands: registered once (with the bot token), again only when they change or when asked', async () => {
  const d = fakeDiscord();
  setEnv();
  const first = await lair.discordRegisterCommands();
  assert.equal(first.ok, true);
  const put = d.calls.filter((c) => c.method === 'PUT');
  assert.equal(put.length, 1);
  assert.equal(put[0].path, `/applications/${APP}/commands`);
  assert.deepEqual(put[0].body, discordCommands());
  assert.equal((await lair.discordRegisterCommands()).cached, true);
  assert.equal(d.calls.filter((c) => c.method === 'PUT').length, 1);
  await lair.discordRegisterCommands({ force: true });
  assert.equal(d.calls.filter((c) => c.method === 'PUT').length, 2);
  // the maintenance does it, and reports what's set up (nothing secret)
  const report = await call('POST', 'internal/maintenance', {}, '', { 'X-Lair-Internal': '1' });
  assert.equal(report.data.discord.commands.ok, true);
  assert.equal(report.data.discord.installUrl, `https://discord.com/oauth2/authorize?client_id=${APP}&scope=bot%20applications.commands&permissions=326417730560`);
  assert.equal(report.data.discord.interactionsUrl, 'https://lair.test/discord/interactions');
  assert.doesNotMatch(JSON.stringify(report.data.discord), /bot-token|client-secret/);
});

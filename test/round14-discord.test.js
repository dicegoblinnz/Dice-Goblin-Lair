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

/* ---------------- helpers (as test/round9-play.test.js), with the Durable Object's alarm ---------------- */
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
  let alarm = null;
  return {
    storage: {
      sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v),
      getAlarm: async () => alarm,
      setAlarm: async (at) => {
        alarm = Number(at);
      },
      deleteAlarm: async () => {
        alarm = null;
      },
    },
    waitUntil: (p) => pending.push(p),
    alarmAt: () => alarm,
    clearAlarm: () => {
      alarm = null;
    },
  };
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
const NEW_CHANNEL = '565656565656565656';
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
const manager = { permissions: '32', ephemeral: true };

function setEnv(extra = {}) {
  lair.baseEnv = {
    ...lair.baseEnv, DISCORD_APPLICATION_ID: APP, DISCORD_PUBLIC_KEY: 'a'.repeat(64), DISCORD_BOT_TOKEN: 'bot-token', DISCORD_CLIENT_SECRET: 'client-secret',
    PUBLIC_URL: 'https://lair.test', ...extra,
  };
  lair.env = { ...lair.baseEnv };
}
function setChannels({ sessions = SESSIONS, events = EVENTS_CH, role = null, sessionsType = 0, eventsType = 0 } = {}) {
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
/** The alarm goes off, as Cloudflare does it: at its time, cleared before it runs */
async function fireAlarm() {
  const t = lair.ctx.alarmAt();
  assert.ok(t, 'an alarm is set');
  Date.now = () => t;
  lair.ctx.clearAlarm();
  await lair.alarm();
  await Promise.all(pending);
}

/**
 * Discord's API, faked. It keeps every call, the messages in each channel and the server's threads (so the bot can look
 * for a post it may have made). Ids are real snowflakes, made at the (test's) time. A route can answer first; its third
 * argument does what Discord would have done anyway (so a route can make the post and then lose the answer).
 */
function fakeDiscord({ owner = USER } = {}) {
  const calls = [];
  const routes = [];
  const channels = new Map();
  const threads = [];
  const deleted = new Set();
  let n = 0;
  const snowflake = () => String(((BigInt(Date.now()) - 1420070400000n) << 22n) + BigInt((n += 1)));
  const reply = (data, status = 200, headers = {}) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const inChannel = (id) => {
    if (!channels.has(id)) channels.set(id, []);
    return channels.get(id);
  };
  const handle = (c) => {
    let m;
    if (c.method === 'GET' && c.path === '/applications/@me') return reply({ id: APP, name: 'Gobgob', owner: { id: owner } });
    if (c.method === 'POST' && (m = c.path.match(/^\/channels\/(\d+)\/threads$/))) {
      const id = snowflake();
      threads.push({ id, parent_id: m[1], name: c.body?.name, type: 11 });
      inChannel(id).push({ id, channel_id: id, author: { id: APP, bot: true }, ...(c.body?.message || {}) });
      return reply({ id, parent_id: m[1], name: c.body?.name, message: { id } }, 201);
    }
    if (c.method === 'POST' && (m = c.path.match(/^\/channels\/(\d+)\/messages\/(\d+)\/threads$/))) {
      const message = inChannel(m[1]).find((x) => x.id === m[2]);
      if (message?.thread) return reply({ message: 'A thread has already been created for this message', code: 160004 }, 400);
      if (message) message.thread = { id: m[2] };
      threads.push({ id: m[2], parent_id: m[1], name: c.body?.name, type: 11 });
      return reply({ id: m[2], parent_id: m[1], name: c.body?.name }, 201);
    }
    if (c.method === 'POST' && (m = c.path.match(/^\/channels\/(\d+)\/messages$/))) {
      const id = snowflake();
      inChannel(m[1]).push({ id, channel_id: m[1], author: { id: APP, bot: true }, content: c.body?.content || '', embeds: c.body?.embeds || [], components: c.body?.components || [] });
      return reply({ id, channel_id: m[1] });
    }
    if (c.method === 'GET' && (m = c.path.match(/^\/channels\/(\d+)\/messages(\?.*)?$/))) return reply(inChannel(m[1]).filter((x) => !deleted.has(x.id)).reverse());
    if (c.method === 'GET' && /^\/guilds\/\d+\/threads\/active$/.test(c.path)) return reply({ threads, members: [] });
    if (c.method === 'PATCH' && (m = c.path.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
      if (deleted.has(m[2])) return reply({ message: 'Unknown Message', code: 10008 }, 404);
      const message = inChannel(m[1]).find((x) => x.id === m[2]);
      if (message) Object.assign(message, c.body);
      return reply({ id: m[2], channel_id: m[1] });
    }
    if (c.method === 'PATCH' && (m = c.path.match(/^\/channels\/(\d+)$/))) {
      const thread = threads.find((x) => x.id === m[1]);
      if (thread) Object.assign(thread, c.body);
      return reply({ id: m[1] });
    }
    if (c.method === 'DELETE' && (m = c.path.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
      deleted.add(m[2]);
      return reply(null, 204);
    }
    if (c.method === 'PUT' && /^\/applications\/\d+\/commands$/.test(c.path)) return reply(c.body);
    if (c.path === '/oauth2/token') return reply({ access_token: 'access-1', token_type: 'Bearer', scope: 'identify' });
    if (c.path === '/oauth2/token/revoke') return reply({});
    if (c.path === '/users/@me') return reply({ id: USER, username: 'ruby', global_name: 'Ruby' });
    if (c.path.startsWith('/webhooks/')) return reply({ id: 'w1' });
    return reply({ message: 'Unknown' }, 404);
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const type = init.headers?.['Content-Type'] || '';
    let body = init.body;
    if (typeof body === 'string' && type.includes('json')) body = JSON.parse(body);
    const c = { method: init.method || 'GET', url: u, path: u.replace('https://discord.com/api/v10', ''), body, headers: init.headers || {}, at: Date.now() };
    calls.push(c);
    for (const route of routes) {
      const out = await route(c, reply, () => handle(c));
      if (out) return out;
    }
    return handle(c);
  };
  return {
    calls, routes, threads, deleted,
    messages: (channel) => inChannel(channel).filter((x) => !deleted.has(x.id)),
    creates: (channel) => calls.filter((c) => c.method === 'POST' && c.path === `/channels/${channel}/messages`),
  };
}

async function strahd(over = {}) {
  const res = await call('POST', 'games', {
    title: 'Curse of Strahd', system: 'D&D 5e', gm: 'Ana', email: 'ana@example.com', blurb: 'Mists and wolves.', seats: 4, tables: ['A1'],
    start: at('2026-10-15', 18), end: at('2026-10-15', 21), ...over,
  }, 'gm');
  assert.equal(res.status, 200, res.data.error);
  return res.data;
}
const weekly = (over = {}) => strahd({ title: 'Weekly Pathfinder', system: 'Pathfinder 2e', tables: ['A2'], start: at('2026-10-13', 18), end: at('2026-10-13', 21), schedule: 'weekly', ...over });
const guestSeat = (gameId, over = {}) => call('POST', 'bookings', {
  kind: 'gm-seat', gameId, people: 1, name: 'Sam Jones', email: 'sam@example.com', phone: MOBILE, players: [{ name: 'Sam Jones' }], ...over,
});
const fill = async (occurrenceId, count) => {
  for (let i = 1; i <= count; i += 1) {
    const res = await call('POST', `events/${encodeURIComponent(occurrenceId)}/join`, { name: `P${i}`, email: `p${i}@example.com`, phone: MOBILE, people: 1 });
    assert.equal(res.status, 200, res.data.error);
  }
};
/** Link a Discord account through My Lair, as the website does it (Discord says the account is `discordId`) */
async function linkThroughMyLair(d, customer, discordId = USER) {
  d.routes.push((c, reply) => (c.path === '/users/@me' ? reply({ id: discordId, username: `u${discordId.slice(0, 3)}`, global_name: 'Someone' }) : null));
  const state = new URL((await call('POST', 'me/discord/start', {}, customer)).data.url).searchParams.get('state');
  const done = await call('POST', 'me/discord/finish', { code: 'c0de', state }, customer);
  d.routes.pop();
  return done;
}

beforeEach(() => {
  Date.now = () => NOW;
  pending = [];
  lair = new Lair(fakeCtx(pending), { CURRENCY: 'NZD', SHOP: 'example-shop.myshopify.com' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: id === 'gm', tags: [] });
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, ROOMS, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  // tied to the Dice Goblin server (the app's owner ran /lair-setup there), as it is once it's set up
  lair.saveDiscordSetting('guild', GUILD, 'test');
  // the posts catch up only when a test asks (discordSync, or the alarm going off), never by themselves
  lair.discordAuto = false;
  resetConfigCache();
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
});

/* ---------------- storage and the Worker's module ---------------- */
test('discord (round 14): one migration entry at the end, new tables and indexes only, and running it twice is harmless', () => {
  const mine = MIGRATIONS.filter((m) => m.some((s) => /CREATE TABLE IF NOT EXISTS discord_/.test(s)));
  assert.equal(mine.length, 1);
  assert.equal(MIGRATIONS[MIGRATIONS.length - 1], mine[0], 'at the end of the list');
  assert.ok(mine[0].every((s) => /^(CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS)/.test(s.trim())), 'new tables and indexes only');
  for (const table of ['discord_links', 'discord_states', 'discord_items', 'discord_posts', 'discord_settings']) {
    assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", table).one().n, 1, table);
  }
  const columns = lair.sql.exec("SELECT name FROM pragma_table_info('discord_posts')").toArray().map((r) => r.name);
  for (const c of ['url', 'tries', 'retry_at', 'unsure', 'thread_retry_at', 'seats_left', 'pinged_at']) assert.ok(columns.includes(c), c);
  for (const s of mine[0]) lair.sql.exec(s);
});

test("discord: src/index.js exports only the Worker and its Durable Object class (workerd takes every export as an entry point, and anything else stops the Worker starting)", async () => {
  const mod = await import('../src/index.js');
  for (const [name, value] of Object.entries(mod)) {
    if (name === 'default') assert.equal(typeof value.fetch, 'function');
    else assert.equal(typeof value, 'function', `${name} must be a class`);
  }
  assert.deepEqual(Object.keys(mod).sort(), ['Lair', 'default']);
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

test("discord: when the Lair is slow, Discord gets a deferred answer at once and the Lair's answer goes in afterwards; a pop-up that came too late leaves the card as it was", async () => {
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
  // a card that changes in place is acknowledged quietly; a pop-up can't go in late, so only the words change (the
  // card keeps its embeds and buttons, so there's still something to tap)
  lair.discordInteraction = async () => {
    await new Promise((r) => setTimeout(r, 40));
    return { type: 9, data: { custom_id: 'dg:mseat:x:s', title: 'Grab a seat', components: [] } };
  };
  const late = await worker.fetch(await signed(k, click('dg:seat:gm_x', { ephemeral: true })), env, { waitUntil: (p) => waits.push(p) });
  assert.deepEqual(await late.json(), { type: 6 });
  await Promise.all(waits);
  assert.deepEqual(d.calls.filter((c) => c.path.startsWith('/webhooks/')).at(-1).body, { content: DISCORD_WORDS.slow });
});

/* ---------------- who and where ---------------- */
test("discord: until the app's owner runs /lair-setup in the server (or DISCORD_GUILD_ID is set), only /lair-setup answers; never in a DM", async () => {
  const d = fakeDiscord();
  setEnv();
  lair.saveDiscordSetting('guild', null, 'test');
  assert.equal((await discord(command('games'))).data.content, `⚠️ ${DISCORD_WORDS.notSetUp}`);
  assert.equal((await discord(click('dg:seat:gm_123'))).data.content, `⚠️ ${DISCORD_WORDS.notSetUp}`);
  assert.deepEqual(await discord(ix(4, { name: 'table', options: [{ name: 'day', type: 3, value: '', focused: true }] })), { type: 8, data: { choices: [] } });
  assert.match((await discord(command('games', [], { guild: null }))).data.content, /only works in the Dice Goblin server/);
  // not a manager: no, owner or not
  assert.match((await discord(command('lair-setup'))).data.content, /Only server managers/);
  // Discord couldn't say who owns the app: nothing is tied, and it says how else to do it
  d.routes.push((c, reply) => (c.path === '/applications/@me' ? reply({ message: '500: Internal Server Error' }, 500) : null));
  assert.equal((await discord(command('lair-setup', [], manager))).data.content, `⚠️ ${DISCORD_WORDS.ownerUnknown}`);
  d.routes.length = 0;
  // a manager of some other server who doesn't own the app can't tie Gobgob to it
  const stranger = await discord(command('lair-setup', [], { ...manager, user: OTHER, guild: OTHER_GUILD }));
  assert.equal(stranger.data.content, `⚠️ ${DISCORD_WORDS.ownerFirst}`);
  assert.equal(lair.discordSettings().guild, null);
  // the app's owner, in the Dice Goblin server
  const panel = await discord(command('lair-setup', [], manager));
  assert.equal(panel.data.content, 'Gobgob is tied to this server.');
  assert.match(textOf(panel), /Gobgob's Discord setup/);
  assert.equal(lair.discordSettings().guild, GUILD);
  const asked = d.calls.filter((c) => c.path === '/applications/@me');
  assert.equal(asked.length, 2, 'asked once, then remembered for an hour');
  assert.equal(asked[1].headers.Authorization, 'Bot bot-token');
  assert.match((await discord(command('games', [], { guild: OTHER_GUILD }))).data.content, /only works in the Dice Goblin server/);
  assert.match((await discord(command('games'))).data.content, /No sessions/);
  // from then on, any manager there opens the panel
  assert.match(textOf(await discord(command('lair-setup', [], { ...manager, user: OTHER }))), /Gobgob's Discord setup/);
  // a team owns the app: its owner and its accepted members
  lair.discordOwnerCache = null;
  d.routes.push((c, reply) => (c.path === '/applications/@me' ? reply({
    id: APP, owner: { id: '444444444444444441' },
    team: { owner_user_id: '444444444444444442', members: [{ membership_state: 2, user: { id: OTHER } }, { membership_state: 1, user: { id: '444444444444444443' } }] },
  }) : null));
  assert.deepEqual([...await lair.discordOwners()].sort(), ['333333333333333333', '444444444444444441', '444444444444444442']);
  // DISCORD_GUILD_ID in the config wins
  setEnv({ DISCORD_GUILD_ID: OTHER_GUILD });
  assert.match((await discord(command('games'))).data.content, /only works/);
  assert.match((await discord(command('games', [], { guild: OTHER_GUILD }))).data.content, /No sessions/);
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
  assert.ok(card.data.embeds[0].fields.every((f) => f.value.trim()), 'no empty field values (Discord refuses them)');
  const regular = await discord(click('dg:pick', { values: [`g:${series.game.id}`], ephemeral: true }));
  assert.ok(labels(regular).includes('Save my seat every week'));
});

test("grab a seat as a guest: the pop-up asks what the website asks, the seat is booked, and it's theirs in Discord", async () => {
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
  // a second tap doesn't book twice, and nor does sending the pop-up again
  const again = await discord(click(`dg:seat:${game.id}`));
  assert.match(again.data.content, /already got a seat/);
  assert.deepEqual(labels(again), ['Bring friends', 'Drop my seat']);
  assert.match((await discord(submit(modal.data.custom_id, { name: 'Ruby Tane', email: 'ruby@example.com', mobile: MOBILE, friends: '', notes: '' }))).data.content, /already got a seat/);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE kind = 'gm-seat'").one().n, 1);
});

test("grab a seat as a linked member: one tap with a mobile on their profile, and the pop-up asks only for what's missing", async () => {
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

test("two taps at once from one Discord user run one after the other, so a double tap books one seat, even while the first is waiting on the shop", async () => {
  const { game } = await strahd();
  linkMember(USER, '1001');
  // the shop is slow to answer just now (the rules come from Shopify every few minutes)
  const rules = lair.rules.bind(lair);
  lair.rules = async (...args) => {
    await new Promise((r) => setTimeout(r, 20));
    return rules(...args);
  };
  const [first, second] = await Promise.all([discord(click(`dg:seat:${game.id}`)), discord(click(`dg:seat:${game.id}`))]);
  assert.equal(first.data.embeds[0].title, "You're in!");
  assert.match(second.data.content, /You've already got a seat at \*\*Curse of Strahd\*\*/);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE kind = 'gm-seat' AND status = 'confirmed'").one().n, 1);
  // someone else's tap doesn't wait for theirs (a guest's pop-up needs one look at the rules, a member's seat two)
  const next = await strahd({ title: 'Mothership', start: at('2026-10-16', 18), end: at('2026-10-16', 21), tables: ['A3'] });
  const order = [];
  await Promise.all([
    discord(click(`dg:seat:${next.game.id}`)).then((x) => order.push(['mine', x.data.embeds?.[0]?.title])),
    discord(click(`dg:seat:${next.game.id}`, { user: OTHER })).then((x) => order.push(['theirs', x.type])),
  ]);
  assert.deepEqual(order, [['theirs', 9], ['mine', "You're in!"]]);
  assert.equal(lair.discordTurns.size, 0, 'nothing left waiting');
});

test("bring friends: with a seat already, the friends get theirs; a full table says so in the website's words", async () => {
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

test("I'm interested: a linked member in one tap, a guest through the pop-up (its key kept, so they can take it back here); the card shows what they said", async () => {
  const { game } = await strahd();
  linkMember(USER, '1001');
  const one = await discord(click(`dg:int:${game.id}`));
  assert.match(one.data.content, /noted you're keen on \*\*Curse of Strahd\*\*/);
  const card = await discord(click('dg:pick', { values: [`g:${game.id}`], ephemeral: true }));
  assert.match(card.data.content, /You said you're interested, so the GM knows/);
  assert.deepEqual(labels(card), ['Grab a seat', 'Bring friends', 'Not interested now', 'On the website', 'All sessions']);
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

test("a guest can't take over someone else's Maybe, interest or waitlist place by typing their email, so linking never moves it", async () => {
  const d = fakeDiscord();
  setEnv();
  const { game } = await strahd();
  // Vic, on the website as a guest: Maybe for the quiz (with a note), keen on Strahd, and waiting for the tiny class
  const maybe = await call('POST', 'interest', { kind: 'event', id: QUIZ, name: 'Vic Tim', email: 'vic@example.com', phone: MOBILE, note: 'Bringing my sister' });
  assert.equal(maybe.status, 200, maybe.data.error);
  assert.equal((await call('POST', 'interest', { kind: 'session', id: game.id, name: 'Vic Tim', email: 'vic@example.com', phone: MOBILE })).status, 200);
  await fill(TINY, 2);
  assert.equal((await call('POST', 'interest', { waitlist: true, id: TINY, people: 2, name: 'Vic Tim', email: 'vic@example.com', phone: MOBILE })).status, 200);
  const before = lair.sql.exec('SELECT * FROM interests ORDER BY rowid').toArray();
  // a Discord guest types Vic's email into each
  const refused = `⚠️ ${DISCORD_WORDS.emailTaken}`;
  assert.equal((await discord(submit(`dg:mev:m:${occRef(QUIZ)}`, { name: 'Att Acker', email: 'VIC@example.com', mobile: MOBILE }, { user: OTHER }))).data.content, refused);
  assert.equal((await discord(submit(`dg:mint:${game.id}`, { name: 'Att Acker', email: 'vic@example.com', mobile: MOBILE, note: '' }, { user: OTHER }))).data.content, refused);
  assert.equal((await discord(submit(`dg:mwait:${occRef(TINY)}`, { name: 'Att Acker', email: 'vic@example.com', mobile: MOBILE, people: '1' }, { user: OTHER }))).data.content, refused);
  assert.deepEqual(lair.sql.exec('SELECT * FROM interests ORDER BY rowid').toArray(), before, "Vic's rows are as they were");
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM discord_items').one().n, 0, 'nothing is theirs');
  // linking their Discord account to their own account brings nothing of Vic's across
  const linked = await linkThroughMyLair(d, '7777', OTHER);
  assert.equal(linked.status, 200, linked.data.error);
  assert.equal(linked.data.adopted, 0);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM interests WHERE customer_id = '7777'").one().n, 0);
  // their own email is fine, and saying it again changes their own row (which stays theirs)
  const own = await discord(submit(`dg:mev:m:${occRef(QUIZ)}`, { name: 'Sam Jones', email: 'sam@example.com', mobile: MOBILE }));
  assert.match(own.data.content, /Marked as maybe for \*\*Trivia night\*\*/);
  const again = await discord(submit(`dg:mev:m:${occRef(QUIZ)}`, { name: 'Sam Jones', email: 'sam@example.com', mobile: MOBILE }));
  assert.match(again.data.content, /Marked as maybe/);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM interests WHERE lower(email) = 'sam@example.com'").one().n, 1);
  assert.ok(lair.discordOwns({ discordUserId: USER }, 'interest', lair.sql.exec("SELECT id FROM interests WHERE lower(email) = 'sam@example.com'").one().id));
});

test("a row made in Discord that someone else's details go into (the website matched it by their email) stops being that Discord user's", async () => {
  const d = fakeDiscord();
  setEnv();
  // a Discord guest says Maybe with an email nobody has used yet, then its owner says Maybe on the website as a guest
  await discord(submit(`dg:mev:m:${occRef(QUIZ)}`, { name: 'Att Acker', email: 'vic@example.com', mobile: MOBILE }, { user: OTHER }));
  const maybe = lair.sql.exec('SELECT id FROM interests WHERE target_id = ?', QUIZ).one().id;
  assert.ok(lair.discordOwns({ discordUserId: OTHER }, 'interest', maybe));
  const web = await call('POST', 'interest', { kind: 'event', id: QUIZ, name: 'Vic Tim', email: 'vic@example.com', phone: MOBILE, note: 'Bringing my sister' });
  assert.equal(web.status, 200, web.data.error);
  assert.equal(lair.sql.exec('SELECT name FROM interests WHERE id = ?', maybe).one().name, 'Vic Tim', "the website's rule changed that row");
  assert.equal(lair.discordOwns({ discordUserId: OTHER }, 'interest', maybe), false);
  assert.doesNotMatch(textOf(await discord(command('mylair', [], { user: OTHER }))), /Trivia night/);
  assert.match((await discord(click(`dg:drop:i:${maybe}`, { user: OTHER, ephemeral: true }))).data.content, /already gone/);
  // the same on a waitlist: Kiri's three places in the queue stay hers
  await fill(TINY, 2);
  await discord(submit(`dg:mwait:${occRef(TINY)}`, { name: 'Att Acker', email: 'kiri@example.com', mobile: MOBILE, people: '1' }, { user: OTHER }));
  const wait = lair.sql.exec("SELECT id FROM interests WHERE level = 'waitlist'").one().id;
  assert.equal((await call('POST', 'interest', { waitlist: true, id: TINY, people: 3, name: 'Kiri Smith', email: 'kiri@example.com', phone: MOBILE })).status, 200);
  assert.equal(lair.discordOwns({ discordUserId: OTHER }, 'interest', wait), false);
  assert.match((await discord(click(`dg:drop:i:${wait}`, { user: OTHER, ephemeral: true }))).data.content, /already gone/);
  assert.deepEqual({ ...lair.sql.exec('SELECT status, people, name FROM interests WHERE id = ?', wait).one() }, { status: 'active', people: 3, name: 'Kiri Smith' });
  // and linking takes neither along
  assert.equal((await linkThroughMyLair(d, '7777', OTHER)).data.adopted, 0);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM interests WHERE customer_id = '7777'").one().n, 0);
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

test('a regular with 2 seats who taps Save my seat every week again keeps both; the card says they are a regular and offers to stop', async () => {
  linkMember(USER, '1001');
  const series = await weekly();
  const web = await call('POST', `games/${series.game.id}/join-series`, {
    people: 2, name: 'Ruby Tane', email: 'ruby@example.com', phone: MOBILE, players: [{ name: 'Ruby Tane' }, { name: 'Kiri' }],
  }, '1001');
  assert.equal(web.status, 200, web.data.error);
  const tap = await discord(click(`dg:every:${series.game.id}`));
  assert.match(tap.data.content, /You're already a regular at \*\*Weekly Pathfinder\*\*, with 2 seats saved every session \(Ruby Tane, Kiri\)/);
  assert.deepEqual(labels(tap), ['Stop coming every week', 'Open My Lair']);
  assert.equal(lair.sql.exec("SELECT people FROM series_members WHERE customer_id = '1001'").one().people, 2, "Kiri keeps her seat");
  const card = await discord(click('dg:pick', { values: [`g:${series.game.id}`], ephemeral: true }));
  assert.match(card.data.content, /Gobgob saves your seat every session/);
  assert.ok(labels(card).includes('Stop coming every week'));
  assert.ok(!labels(card).includes('Save my seat every week'));
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

test('bring friends to an event: "Friend 1" or "Guest 2" is a name, and a line counts as a member code only when a member has it', async () => {
  lair.touchMember('2002', { name: 'Kiri Smith', email: 'kiri@example.com' }, NOW);
  const typed = lair.memberRow('2002').code.toLowerCase().replace(/-/g, ' ');
  const done = await discord(submit(`dg:mjoin:${occRef(QUIZ)}`, {
    name: 'Sam Jones', email: 'sam@example.com', mobile: MOBILE, friends: `Friend 1\nGuest 2\n${typed}\nZZ-NOBODY-99`, note: '',
  }, { user: OTHER }));
  assert.equal(done.data.embeds?.[0]?.title, "You're on the list!", done.data.content);
  assert.match(done.data.embeds[0].description, /5 spots/);
  const join = lair.sql.exec('SELECT id FROM event_joins').one();
  assert.deepEqual(
    lair.sql.exec('SELECT name, customer_id FROM event_join_guests WHERE join_id = ? ORDER BY rowid', join.id).toArray().map((g) => [g.name, g.customer_id]),
    [['Friend 1', null], ['Guest 2', null], ['Kiri Smith', '2002'], ['ZZ-NOBODY-99', null]],
  );
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

test('a guest sending the sign-up pop-up twice while the checkout is being made gets one sign-up; someone else with that email is told it is on the list', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  let made = 0;
  lair.shopify.createCheckout = async () => {
    made += 1;
    await new Promise((r) => setTimeout(r, 30));
    return { draftOrderId: `gid://shopify/DraftOrder/${made}`, checkoutUrl: `https://checkout.test/${made}` };
  };
  const fields = { name: 'Sam Jones', email: 'sam@example.com', mobile: MOBILE, friends: '', note: '' };
  const [a, b] = await Promise.all([discord(submit(`dg:mjoin:${occRef(LAUNCH)}`, fields)), discord(submit(`dg:mjoin:${occRef(LAUNCH)}`, fields))]);
  assert.equal(a.data.embeds[0].title, 'Pay to lock it in');
  assert.match(b.data.content, /You're already on the list for \*\*Launch day\*\*/);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM event_joins WHERE status = 'held'").one().n, 1);
  assert.equal(made, 1, 'one checkout');
  const c = await discord(submit(`dg:mjoin:${occRef(LAUNCH)}`, fields, { user: OTHER }));
  assert.equal(c.data.content, `⚠️ ${DISCORD_WORDS.emailOnList}`);
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
  // their cards follow what they said
  const pokemon = await discord(click('dg:pick', { values: [`e:${occRef(POKEMON)}`], ephemeral: true }));
  assert.deepEqual(labels(pokemon), ['Not coming now', 'Maybe', 'On the website', 'All events']);
  const quiz = await discord(click('dg:pick', { values: [`e:${occRef(QUIZ)}`], ephemeral: true, user: OTHER }));
  assert.match(quiz.data.content, /You said maybe/);
  assert.deepEqual(labels(quiz), ['Sign up', 'Bring friends', 'Not a maybe now', 'On the website', 'All events']);
});

test("on the waitlist: Join the waitlist again keeps how many, Maybe doesn't take them off it, and the card offers Leave the waitlist", async () => {
  linkMember(USER, '1001');
  await fill(TINY, 2);
  const web = await call('POST', 'interest', { waitlist: true, id: TINY, people: 3, note: 'Me and two kids' }, '1001');
  assert.equal(web.status, 200, web.data.error);
  const again = await discord(click(`dg:wait:${occRef(TINY)}`));
  assert.match(again.data.content, /You're already on the waitlist for \*\*Tiny painting class\*\* \(3 people\)/);
  const maybe = await discord(click(`dg:maybe:${occRef(TINY)}`));
  assert.match(maybe.data.content, /You're on the waitlist for \*\*Tiny painting class\*\*, so Gobgob's kept your place in the queue as it is/);
  assert.deepEqual(labels(maybe), ['Leave the waitlist']);
  const row = lair.sql.exec("SELECT level, people, note FROM interests WHERE customer_id = '1001'").one();
  assert.deepEqual([row.level, row.people, row.note], ['waitlist', 3, 'Me and two kids']);
  const card = await discord(click('dg:pick', { values: [`e:${occRef(TINY)}`], ephemeral: true }));
  assert.match(card.data.content, /You're on the waitlist for this one \(3 people\)/);
  assert.deepEqual(labels(card), ['Leave the waitlist', 'On the website', 'All events']);
  const leave = await discord(click(card.data.components[0].components[0].custom_id, { ephemeral: true }));
  assert.match(leave.data.content, /Take back "on the waitlist" for \*\*Tiny painting class\*\*/);
});

/* ---------------- tables ---------------- */
test('/table: the day and time boxes fill in with the days the Lair is open and times on the hour (none too soon, none /table would refuse)', async () => {
  const days = await discord(ix(4, { name: 'table', options: [{ name: 'day', type: 3, value: '', focused: true }] }));
  assert.equal(days.type, 8);
  const names = days.data.choices.map((c) => c.name);
  assert.deepEqual(names.slice(0, 4), ['Today, Fri 9 Oct', 'Tomorrow, Sat 10 Oct', 'Sun 11 Oct', 'Tue 13 Oct'], 'Monday is closed');
  assert.equal(days.data.choices[1].value, '2026-10-10');
  assert.ok(days.data.choices.length <= 25);
  const typed = await discord(ix(4, { name: 'table', options: [{ name: 'day', type: 3, value: 'sat', focused: true }] }));
  assert.ok(typed.data.choices.every((c) => /Sat/.test(c.name)));
  const timesFor = async (hours) => (await discord(ix(4, {
    name: 'table', options: [{ name: 'day', type: 3, value: '2026-10-10' }, { name: 'time', type: 3, value: '', focused: true }, ...(hours ? [{ name: 'hours', type: 4, value: hours }] : [])],
  }))).data.choices;
  const two = await timesFor(2);
  assert.deepEqual([two[0], two.at(-1)], [{ name: '10am', value: '10:00' }, { name: '9pm', value: '21:00' }]);
  assert.equal((await timesFor(1)).at(-1).name, '10pm');
  // hours left out is 2, as /table books it, so the last time offered is one /table takes
  const blank = await timesFor(null);
  assert.equal(blank.at(-1).name, '9pm');
  const last = await discord(tableCmd('2026-10-10', blank.at(-1).value, 2));
  assert.match(last.data.embeds?.[0]?.title || last.data.content, /Tables for 2, Tomorrow, 9pm to 11pm/);
  const today = await discord(ix(4, { name: 'table', options: [{ name: 'day', type: 3, value: '2026-10-09' }, { name: 'time', type: 3, value: '', focused: true }] }));
  assert.equal(today.data.choices[0].name, '2pm', 'an hour ahead at the earliest');
});

function tableCmd(day, timeText, people, extra = [], o = {}) {
  return command('table', [
    { name: 'day', type: 3, value: day }, { name: 'time', type: 3, value: timeText }, { name: 'people', type: 4, value: people }, ...extra,
  ], o);
}

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

test("/table: tapping a choice again (or sending its pop-up twice) books one table, and says they have it already", async () => {
  linkMember(USER, '1001');
  const four = await discord(tableCmd('2026-10-10', '14:00', 4));
  const pick = four.data.components[0].components[0].custom_id;
  const first = await discord(click(pick, { ephemeral: true }));
  const second = await discord(click(pick, { ephemeral: true }));
  assert.equal(first.data.embeds[0].title, "You're booked in!");
  assert.equal(second.data.embeds[0].title, "You're booked in!");
  assert.equal(second.data.embeds[0].description, "You've already got **Table T1** at that time. Gobgob's guarding it.");
  assert.equal(second.data.content, '', 'never "Someone just grabbed that table"');
  // a guest sends the pop-up twice at once
  const modal = await discord(click(four.data.components[0].components[1].custom_id, { user: OTHER, ephemeral: true }));
  const fields = { name: 'Sam Jones', email: 'sam@example.com', mobile: MOBILE, notes: '' };
  const both = await Promise.all([1, 2].map(() => discord(submit(modal.data.custom_id, fields, { user: OTHER, ephemeral: true }))));
  assert.deepEqual(both.map((x) => x.data.embeds[0].title), ["You're booked in!", "You're booked in!"]);
  assert.deepEqual(
    lair.sql.exec("SELECT tables FROM bookings WHERE kind = 'table' AND status = 'confirmed' ORDER BY rowid").toArray().map((r) => r.tables),
    ['["T1"]', '["A1"]'], 'one table each',
  );
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
  // nothing near the time at all
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, ROOMS, [
    ...EVENTS, { id: 'con', title: 'Convention', start: at('2026-10-10', 10), end: at('2026-10-10', 23), tables: 'all', lockTables: true },
  ]);
  assert.equal((await discord(tableCmd('2026-10-10', '14:00', 4))).data.content, DISCORD_WORDS.noTables);
});

test('/table: shop tables count when staff have opened them, as on the booking page', async () => {
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: 'T1-T3' }, ROOMS, EVENTS);
  const closed = await discord(tableCmd('2026-10-10', '14:00', 4));
  assert.equal(labels(closed)[0], 'Common room: T4 · $40', 'the shop tables are the shop\'s');
  const opened = await call('POST', 'openings', { tables: ['T1', 'T2', 'T3'], start: at('2026-10-10', 10), end: at('2026-10-10', 23) }, 'staff');
  assert.equal(opened.status, 200, opened.data.error);
  const open = await discord(tableCmd('2026-10-10', '14:00', 4));
  assert.equal(labels(open)[0], 'Common room: T1 · $40');
  linkMember(USER, '1001');
  assert.equal((await discord(click(open.data.components[0].components[0].custom_id, { ephemeral: true }))).data.embeds[0].title, "You're booked in!");
});

test("/table: a room laid out by hand (table ids like W-1) gets buttons that work, within Discord's 100 characters", async () => {
  const layout = { box: [0, 0, 600, 400], tables: Array.from({ length: 10 }, (_, i) => ({ id: i < 2 ? `W-${i + 1}` : `WARHAMMER-BIG-TABLE-${i + 1}`, x: i * 50, y: 0 })) };
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, [{ id: 'war-room', name: 'War room', code: 'W', seats: 6, layout, order: 1 }], EVENTS);
  linkMember(USER, '1001');
  const answer = await discord(tableCmd('2026-10-10', '14:00', 4, [{ name: 'setup', type: 3, value: 'wargame' }]));
  const choice = answer.data.components[0].components[0];
  assert.equal(choice.label, 'War room: W-1 + W-2 · $40');
  assert.ok(choice.custom_id.length <= 100, choice.custom_id);
  const done = await discord(click(choice.custom_id, { ephemeral: true }));
  assert.equal(done.data.embeds[0].title, "You're booked in!");
  assert.equal(lair.sql.exec("SELECT tables FROM bookings WHERE kind = 'table'").one().tables, '["W-1","W-2"]');
  // the long ids too
  const big = await discord(tableCmd('2026-10-10', '14:00', 24, [{ name: 'setup', type: 3, value: 'wargame' }]));
  for (const id of ids(big)) assert.ok(id.length <= 100, id);
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
  assert.match(forged.data.content, /already gone/);
  assert.equal(lair.sql.exec('SELECT status FROM bookings WHERE id = ?', seat).one().status, 'confirmed');
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

test("once a guest seat has joined an account it's that account's: linking the Discord account to someone else doesn't take it along", async () => {
  const d = fakeDiscord();
  setEnv();
  const { game } = await strahd();
  const modal = await discord(click(`dg:seat:${game.id}`));
  await discord(submit(modal.data.custom_id, { name: 'Ruby Tane', email: 'ruby@example.com', mobile: MOBILE, friends: '', notes: '' }));
  assert.equal((await linkThroughMyLair(d, '1001')).data.adopted, 1);
  const seat = lair.sql.exec("SELECT id, customer_id FROM bookings WHERE kind = 'gm-seat'").one();
  assert.equal(seat.customer_id, '1001');
  // the same Discord account, linked to account 2002 now
  assert.equal((await linkThroughMyLair(d, '2002')).data.adopted, 0);
  assert.doesNotMatch(textOf(await discord(command('mylair'))), /Curse of Strahd/);
  assert.match((await discord(click(`dg:drop:b:${seat.id}`, { ephemeral: true }))).data.content, /already gone/);
  await assert.rejects(lair.updateBooking(seat.id, { status: 'cancelled' }, { customerId: '2002', staff: false, discordUserId: USER }), /Only staff/);
  assert.equal(lair.sql.exec('SELECT status FROM bookings WHERE id = ?', seat.id).one().status, 'confirmed');
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
test('/lair-setup: server managers only (checked on every click); channels, the ping role, the switches and Post now', async () => {
  setEnv();
  assert.match((await discord(command('lair-setup'))).data.content, /Only server managers/);
  const panel = await discord(command('lair-setup', [], manager));
  assert.deepEqual(labels(panel), ['Channel for TTRPG sessions', 'Channel for events', 'Role to ping when a seat opens (optional)', 'Auto-posts: On', 'Seat pings: On', 'Round-up: On', 'Post now']);
  assert.match((await discord(click('dg:set:posts', { ephemeral: true }))).data.content, /Only server managers/);
  assert.match((await discord(click('dg:set:sync', manager))).data.content, /Pick a channel first/);
  const picked = await discord(click('dg:set:sessions', { ...manager, values: [SESSIONS], resolved: { channels: { [SESSIONS]: { id: SESSIONS, type: 15 } } } }));
  assert.match(picked.data.content, /TTRPG sessions go to <#555555555555555555>/);
  assert.doesNotMatch(picked.data.content, /needs a tag/);
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
  const now = await discord(click('dg:set:sync', manager));
  assert.equal(now.type, 7);
  assert.match(now.data.content, /Gobgob's posting now/);
  setEnv({ DISCORD_BOT_TOKEN: '' });
  assert.match(textOf(await discord(command('lair-setup', [], manager))), /token isn't in Cloudflare yet/);
});

test("/lair-setup: a forum that needs a tag on every post is flagged when it's picked, and again if Discord refuses a post there", async () => {
  const d = fakeDiscord();
  setEnv();
  const picked = await discord(click('dg:set:sessions', { ...manager, values: [SESSIONS], resolved: { channels: { [SESSIONS]: { id: SESSIONS, type: 15, flags: 16 } } } }));
  assert.match(picked.data.content, /Heads up: that forum needs a tag on every post, and Gobgob can't add one\. Turn off Require Tags in its settings, or pick a text channel\./);
  await strahd();
  d.routes.push((c, reply) => (c.path === `/channels/${SESSIONS}/threads` ? reply({ message: 'A tag is required to create a forum post in this channel', code: 40067 }, 400) : null));
  assert.equal((await lair.discordSync()).failed, 1);
  const panel = textOf(await discord(command('lair-setup', [], manager)));
  assert.match(panel, /<#555555555555555555> is a forum that needs a tag on every post\. Turn off Require Tags in its settings, or pick a text channel\./);
  assert.match(panel, /0 posts up, 1 still to go up/);
});

/* ---------------- posts in the server ---------------- */
test('posts: each session (one per series, with a chat thread) and each event date in the next week goes up; the website links to them', async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels();
  const one = await strahd();
  const series = await weekly();
  const out = await lair.discordSync();
  assert.deepEqual([out.created, out.threads, out.failed], [5, 2, 0], '2 sessions and 3 event dates (Pokémon is 7 days and 4 hours away)');
  const created = d.calls.filter((c) => c.method === 'POST' && /\/messages$/.test(c.path));
  assert.equal(d.creates(SESSIONS).length, 2);
  assert.equal(d.creates(EVENTS_CH).length, 3);
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
  assert.ok(!d.calls.some((c) => c.method === 'DELETE'), "a session's post stays, with its chat");
  assert.equal(lair.sql.exec("SELECT status FROM discord_posts WHERE target_id = ? AND id LIKE 'g:%'", one.game.id).one().status, 'ended');
  // a cancelled session says so
  const other = await strahd({ title: 'Delta Green', start: at('2026-10-17', 18), end: at('2026-10-17', 21), tables: ['A3'] });
  await lair.discordSync();
  await call('POST', `games/${other.game.id}/update`, { status: 'cancelled' }, 'gm');
  await lair.discordSync();
  assert.match(d.calls.filter((c) => c.method === 'PATCH').at(-1).body.embeds[0].description, /This session was cancelled/);
});

test('posts: a full weekly game moving on to its next session is not a seat opening up, so nobody is pinged', async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ events: null, role: ROLE });
  const series = await weekly({ seats: 2 });
  await guestSeat(series.game.id);
  await guestSeat(series.game.id, { email: 'kiri@example.com', name: 'Kiri', players: [{ name: 'Kiri' }] });
  await lair.discordSync();
  assert.equal(lair.sql.exec("SELECT seats_left FROM discord_posts WHERE id LIKE 's:%'").one().seats_left, 0, 'full when it went up');
  Date.now = () => at('2026-10-13', 21, 30);
  const out = await lair.discordSync();
  assert.deepEqual([out.edited, out.pinged], [1, 0]);
  assert.ok(!d.calls.some((c) => String(c.body?.content || '').includes('opened up')));
  const post = lair.sql.exec("SELECT * FROM discord_posts WHERE id LIKE 's:%'").one();
  assert.deepEqual([post.seats_left, post.target_id === series.game.id], [2, false]);
});

test('posts: in a forum, each session is its own post (its own thread): edits go in the thread, a quiet thread is opened again first, pings go in the thread, and a played session is closed off and archived', async () => {
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
  // once it's been played: closed off, and the post archived
  Date.now = () => at('2026-10-15', 21, 30);
  assert.equal((await lair.discordSync()).ended, 1);
  const last = d.calls.filter((c) => c.method === 'PATCH').slice(-2);
  assert.deepEqual(last.map((c) => c.path), [`/channels/${post.thread_id}/messages/${post.message_id}`, `/channels/${post.thread_id}`]);
  assert.match(last[0].body.embeds[0].description, /This session has been played/);
  assert.deepEqual(last[1].body, { archived: true });
  assert.equal(d.threads.find((t) => t.id === post.thread_id).archived, true);
});

test("posts: an event date's post is deleted once it's over, so the channel stays a list of what's on", async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ sessions: null });
  await lair.discordSync();
  const tiny = lair.sql.exec('SELECT * FROM discord_posts WHERE target_id = ?', TINY).one();
  Date.now = () => at('2026-10-10', 16, 30);
  const out = await lair.discordSync();
  assert.equal(out.ended, 1);
  assert.deepEqual(d.calls.filter((c) => c.method === 'DELETE').map((c) => c.path), [`/channels/${EVENTS_CH}/messages/${tiny.message_id}`]);
  assert.equal(lair.sql.exec('SELECT status FROM discord_posts WHERE id LIKE ?', `e:${TINY}%`).one().status, 'ended');
  const titles = d.messages(EVENTS_CH).map((m) => m.embeds[0].title);
  assert.ok(!titles.includes('Tiny painting class'));
  assert.ok(titles.includes('Trivia night'));
});

test('posts: in a forum, a date that is over is closed off and its post archived', async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ sessions: null, eventsType: 15 });
  await lair.discordSync();
  const tiny = lair.sql.exec('SELECT * FROM discord_posts WHERE target_id = ?', TINY).one();
  assert.equal(d.threads.length, 3);
  Date.now = () => at('2026-10-10', 16, 30);
  assert.equal((await lair.discordSync()).ended, 1);
  const mine = d.calls.filter((c) => c.method === 'PATCH' && c.path.startsWith(`/channels/${tiny.thread_id}`));
  assert.deepEqual(mine.map((c) => c.path), [`/channels/${tiny.thread_id}/messages/${tiny.message_id}`, `/channels/${tiny.thread_id}`]);
  assert.match(mine[0].body.embeds[0].description, /This one's been and gone/);
  assert.deepEqual(mine[1].body, { archived: true });
  assert.ok(!d.calls.some((c) => c.method === 'DELETE'), 'a forum post is closed off, not deleted');
});

test("posts: Discord's waits are per channel and exact: a 429 holds that channel until retry_after (not counted against the post), and a bucket with none left waits without a 429", async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels();
  await strahd({ title: 'Game A', start: at('2026-10-16', 12), end: at('2026-10-16', 13), tables: ['T10'] });
  await strahd({ title: 'Game B', start: at('2026-10-16', 14), end: at('2026-10-16', 15), tables: ['T11'] });
  let said = false;
  d.routes.push((c, reply) => {
    if (!said && c.method === 'POST' && c.path === `/channels/${SESSIONS}/messages`) {
      said = true;
      return reply({ message: 'You are being rate limited.', retry_after: 1.5, global: false }, 429, { 'X-RateLimit-Scope': 'user' });
    }
    return null;
  });
  const first = await lair.discordSync();
  assert.deepEqual([first.created, first.failed], [3, 0], "the events channel isn't held up");
  assert.equal(d.creates(SESSIONS).length, 1, 'one try, then that channel waits');
  const a = lair.sql.exec("SELECT status, tries, retry_at FROM discord_posts WHERE title = 'Game A'").one();
  assert.deepEqual([a.status, a.tries, a.retry_at], ['failed', 0, NOW + 1500]);
  // a second later it's still waiting (no call at all); past retry_after both go up
  Date.now = () => NOW + 1000;
  assert.equal((await lair.discordSync()).created, 0);
  assert.equal(d.creates(SESSIONS).length, 1);
  Date.now = () => NOW + 1600;
  assert.equal((await lair.discordSync()).created, 2);
  // none left in the channel's bucket: its next calls wait for the reset, with no 429
  await strahd({ title: 'Game C', start: at('2026-10-17', 12), end: at('2026-10-17', 13), tables: ['T12'] });
  await strahd({ title: 'Game D', start: at('2026-10-17', 14), end: at('2026-10-17', 15), tables: ['T13'] });
  d.routes.length = 0;
  let spent = false;
  d.routes.push(async (c, reply, fallback) => {
    if (spent || c.method !== 'POST' || c.path !== `/channels/${SESSIONS}/messages`) return null;
    spent = true;
    const res = fallback();
    return reply(await res.json(), res.status, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '3' });
  });
  const before = d.calls.length;
  const held = await lair.discordSync();
  assert.deepEqual([held.created, d.calls.length - before], [1, 1], 'nothing more in that channel until it resets');
  assert.equal(lair.sql.exec("SELECT thread_id FROM discord_posts WHERE title = 'Game C'").one().thread_id, null);
  Date.now = () => NOW + 4600;
  const after = await lair.discordSync();
  assert.deepEqual([after.created, after.threads], [1, 2]);
  assert.ok(!d.calls.some((c) => c.method === 'POST' && c.at < NOW + 4600 && c.at > NOW + 1600), 'nothing was sent while it waited');
});

test('posts: one round makes a dozen Discord calls at most, and the next round follows a second later by itself (the alarm)', async () => {
  fakeDiscord();
  setEnv();
  setChannels({ events: null });
  for (let i = 0; i < 8; i += 1) await strahd({ title: `Game ${i + 1}`, start: at('2026-10-16', 12 + i), end: at('2026-10-16', 13 + i), tables: ['T10'], seats: 2 });
  lair.discordAuto = true;
  const first = await lair.discordSync();
  assert.deepEqual([first.created, first.more], [6, true], 'two calls each (the post and its thread), twelve in all');
  await Promise.all(pending);
  assert.equal(lair.ctx.alarmAt(), NOW + 1000);
  await fireAlarm();
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM discord_posts WHERE status = 'live' AND thread_id IS NOT NULL").one().n, 8);
});

test("posts: a channel Gobgob can't post in is tried again after 30 minutes, then 1, 2, 4 and every 8 hours, never given up; the panel says why, and Post now tries at once", async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ events: null });
  await strahd();
  d.routes.push((c, reply) => (c.method === 'POST' && c.path === `/channels/${SESSIONS}/messages` ? reply({ message: 'Missing Permissions', code: 50013 }, 403) : null));
  const gaps = [];
  let t = NOW;
  for (let i = 0; i < 8; i += 1) {
    Date.now = () => t;
    await lair.discordSync();
    const row = lair.sql.exec('SELECT * FROM discord_posts').one();
    gaps.push((row.retry_at - t) / MIN);
    t = row.retry_at;
  }
  assert.deepEqual(gaps, [30, 60, 120, 240, 480, 480, 480, 480]);
  const row = lair.sql.exec('SELECT * FROM discord_posts').one();
  assert.deepEqual([row.status, row.tries], ['failed', 8]);
  assert.equal(d.creates(SESSIONS).length, 8, 'one try each time');
  // not before it's due
  Date.now = () => t - MIN;
  await lair.discordSync();
  assert.equal(d.creates(SESSIONS).length, 8);
  // the panel says what's wrong
  const panel = textOf(await discord(command('lair-setup', [], manager)));
  assert.match(panel, /Gobgob can't post in <#555555555555555555>\. Check the bot can see it, send messages, embed links and make threads there\./);
  assert.match(panel, /0 posts up, 1 still to go up/);
  // Mo fixes the channel's permissions and taps Post now: it goes up straight away
  d.routes.length = 0;
  assert.match((await discord(click('dg:set:sync', manager))).data.content, /Gobgob's posting now/);
  assert.equal((await lair.discordSync()).created, 1);
  const fixed = textOf(await discord(command('lair-setup', [], manager)));
  assert.doesNotMatch(fixed, /Heads up/);
  assert.match(fixed, /1 post up/);
});

test("posts: edits Discord didn't answer (a 5xx) or asked to wait for (a 429) are tried again soon without counting against the post, which is brought up to date and closed off as usual", async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ events: null });
  const { game } = await strahd({ seats: 8, tables: ['A1', 'A2'] });
  await lair.discordSync();
  d.routes.push((c, reply) => (c.method === 'PATCH' ? reply({ message: '500: Internal Server Error' }, 500) : null));
  for (let i = 1; i <= 5; i += 1) {
    Date.now = () => NOW + (i - 1) * 31_000;
    assert.equal((await guestSeat(game.id, { email: `g${i}@example.com`, name: `G${i}`, players: [{ name: `G${i}` }] })).status, 200);
    await lair.discordSync();
  }
  let post = lair.sql.exec('SELECT * FROM discord_posts').one();
  assert.deepEqual([post.status, post.tries, post.retry_at], ['live', 0, NOW + 4 * 31_000 + 30_000]);
  d.routes.length = 0;
  d.routes.push((c, reply) => (c.method === 'PATCH' ? reply({ message: 'You are being rate limited.', retry_after: 2, global: false }, 429) : null));
  Date.now = () => NOW + 3 * MIN;
  await lair.discordSync();
  post = lair.sql.exec('SELECT * FROM discord_posts').one();
  assert.deepEqual([post.tries, post.retry_at], [0, NOW + 3 * MIN + 2000]);
  d.routes.length = 0;
  Date.now = () => NOW + 10 * MIN;
  assert.equal((await lair.discordSync()).edited, 1);
  assert.match(JSON.stringify(d.calls.filter((c) => c.method === 'PATCH').at(-1).body.embeds[0].fields), /3 of 8 left/);
  Date.now = () => at('2026-10-15', 22);
  assert.equal((await lair.discordSync()).ended, 1);
});

test("posts: while Discord won't take edits to an older post (30046), the seat that opened is pinged once; the edit waits 15 minutes, and the channel isn't held up", async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ events: null, role: ROLE });
  const { game } = await strahd({ seats: 2 });
  const a = await guestSeat(game.id);
  await guestSeat(game.id, { email: 'kiri@example.com', name: 'Kiri', players: [{ name: 'Kiri' }] });
  await lair.discordSync();
  d.routes.push((c, reply) => (c.method === 'PATCH'
    ? reply({ message: 'Maximum number of edits to messages older than 1 hour reached. Try again later', code: 30046, retry_after: 60, global: false }, 429) : null));
  await call('POST', `bookings/${a.data.booking.id}/update`, { status: 'cancelled' }, 'staff');
  await strahd({ title: 'Delta Green', start: at('2026-10-17', 18), end: at('2026-10-17', 21), tables: ['A3'] });
  const first = await lair.discordSync();
  assert.deepEqual([first.pinged, first.created], [1, 1], 'the ping and the new post still go in that channel');
  let post = lair.sql.exec("SELECT * FROM discord_posts WHERE title = 'Curse of Strahd'").one();
  assert.deepEqual([post.tries, post.retry_at, post.seats_left], [0, NOW + 15 * MIN, 1]);
  let t = NOW;
  for (let i = 0; i < 4; i += 1) {
    t += 16 * MIN;
    Date.now = () => t;
    await lair.discordSync();
  }
  const pings = d.calls.filter((c) => c.method === 'POST' && String(c.body?.content || '').includes('A seat just opened up'));
  assert.equal(pings.length, 1, 'one seat, one ping');
  assert.equal(d.calls.filter((c) => c.method === 'PATCH').length, 5, 'the edit was tried every 15 minutes or so');
  post = lair.sql.exec("SELECT * FROM discord_posts WHERE title = 'Curse of Strahd'").one();
  assert.deepEqual([post.status, post.tries], ['live', 0]);
  // the same limit sent as a plain 400 waits the same way
  d.routes.length = 0;
  d.routes.push((c, reply) => (c.method === 'PATCH' ? reply({ message: 'Maximum number of edits to messages older than 1 hour reached. Try again later', code: 30046 }, 400) : null));
  t += 16 * MIN;
  Date.now = () => t;
  await lair.discordSync();
  post = lair.sql.exec("SELECT * FROM discord_posts WHERE title = 'Curse of Strahd'").one();
  assert.deepEqual([post.tries, post.retry_at], [0, t + 15 * MIN]);
});

test('posts: a create Discord may have made (a 5xx, no answer, or the Lair restarting mid-call) is looked for before trying again, so it never goes up twice', async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ events: null });
  const { game } = await strahd();
  // Discord makes the post, then the answer is lost
  let lost = false;
  d.routes.push((c, reply, fallback) => {
    if (!lost && c.method === 'POST' && c.path === `/channels/${SESSIONS}/messages`) {
      lost = true;
      fallback();
      return reply({ message: 'Bad Gateway' }, 502);
    }
    return null;
  });
  const first = await lair.discordSync();
  assert.deepEqual([first.created, first.failed], [0, 1]);
  const row = lair.sql.exec('SELECT * FROM discord_posts').one();
  assert.deepEqual([row.status, row.unsure, row.tries, row.retry_at], ['creating', 1, 0, NOW + 30_000]);
  // half a minute later: found in the channel, not made again
  Date.now = () => NOW + 31_000;
  assert.equal((await lair.discordSync()).created, 1);
  assert.ok(d.calls.some((c) => c.method === 'GET' && c.path === `/channels/${SESSIONS}/messages?limit=50`));
  // the next round brings it up to date and makes its chat thread
  const third = await lair.discordSync();
  assert.deepEqual([third.edited, third.threads], [1, 1]);
  assert.equal(d.creates(SESSIONS).length, 1, 'one post, ever');
  assert.equal(d.messages(SESSIONS).length, 1);
  const live = lair.sql.exec('SELECT * FROM discord_posts').one();
  assert.deepEqual([live.status, live.message_id, live.thread_id], ['live', d.messages(SESSIONS)[0].id, d.messages(SESSIONS)[0].id]);
  // a claim left behind by a restart mid-call, for a post that didn't go up: looked for, not found, made once
  const other = await strahd({ title: 'Delta Green', start: at('2026-10-17', 18), end: at('2026-10-17', 21), tables: ['A3'] });
  lair.sql.exec(
    `INSERT INTO discord_posts (id, kind, target_id, channel_id, channel_type, status, title, starts_at, url, tries, unsure, created_at, updated_at)
     VALUES (?, 'session', ?, ?, 0, 'creating', 'Delta Green', ?, ?, 0, 1, ?, ?)`,
    `g:${other.game.id}`, other.game.id, SESSIONS, other.game.start, lair.discordGameUrl(other.game.id), NOW, NOW,
  );
  assert.equal((await lair.discordSync()).created, 0, 'a claim this fresh may still be in flight');
  Date.now = () => NOW + 31_000 + 2 * MIN;
  const resumed = await lair.discordSync();
  assert.equal(resumed.created, 1);
  assert.equal(d.creates(SESSIONS).length, 2);
  assert.equal(d.messages(SESSIONS).filter((m) => m.embeds[0].title === 'Delta Green').length, 1);
});

test('posts: in a forum, a post that may have gone up is found among the active threads by its name', async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ events: null, sessionsType: 15 });
  await strahd();
  let lost = false;
  d.routes.push((c, reply, fallback) => {
    if (!lost && c.method === 'POST' && c.path === `/channels/${SESSIONS}/threads`) {
      lost = true;
      fallback();
      throw new Error('The connection was reset');
    }
    return null;
  });
  assert.equal((await lair.discordSync()).failed, 1);
  Date.now = () => NOW + 31_000;
  assert.equal((await lair.discordSync()).created, 1);
  assert.ok(d.calls.some((c) => c.path === `/guilds/${GUILD}/threads/active`));
  assert.equal(d.threads.length, 1, 'one forum post');
  const post = lair.sql.exec('SELECT * FROM discord_posts').one();
  assert.deepEqual([post.status, post.thread_id, post.message_id, post.message_channel], ['live', d.threads[0].id, d.threads[0].id, d.threads[0].id]);
});

test("posts: a post that may have gone up but isn't wanted any more is looked for, and taken down if it's there", async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ sessions: null });
  let lost = false;
  d.routes.push((c, reply, fallback) => {
    if (!lost && c.method === 'POST' && c.path === `/channels/${EVENTS_CH}/messages`) {
      lost = true;
      fallback();
      // (and Discord writes the link back its own way: #event=tiny@… rather than tiny%40…)
      const made = d.messages(EVENTS_CH).at(-1);
      made.embeds = [{ ...made.embeds[0], url: made.embeds[0].url.replace('%40', '@') }];
      return reply({ message: '503: Service Unavailable' }, 503);
    }
    return null;
  });
  await lair.discordSync();
  const tiny = lair.sql.exec('SELECT * FROM discord_posts WHERE target_id = ?', TINY).one();
  assert.match(tiny.url, /%40/);
  assert.deepEqual([tiny.status, tiny.unsure, tiny.message_id], ['creating', 1, null]);
  const made = d.messages(EVENTS_CH).find((m) => m.embeds[0].title === 'Tiny painting class');
  assert.ok(made, 'Discord made it after all');
  // the class is over before the next round: no longer wanted, but it's up, so it's found and taken down
  Date.now = () => at('2026-10-10', 16, 30);
  await lair.discordSync();
  assert.deepEqual(d.calls.filter((c) => c.method === 'DELETE').map((c) => c.path), [`/channels/${EVENTS_CH}/messages/${made.id}`]);
  assert.equal(lair.sql.exec('SELECT status FROM discord_posts WHERE id LIKE ?', `e:${TINY}%`).one().status, 'ended');
  assert.equal(d.creates(EVENTS_CH).filter((c) => c.body.embeds[0].title === 'Tiny painting class').length, 1);
});

test("posts: a session's chat thread Discord didn't make is made later, and one that's there already is used", async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ events: null });
  const { game } = await strahd();
  d.routes.push((c, reply) => (/\/messages\/\d+\/threads$/.test(c.path) ? reply({ message: 'You are being rate limited.', retry_after: 2, global: false }, 429) : null));
  const first = await lair.discordSync();
  assert.deepEqual([first.created, first.threads], [1, 0]);
  const row = lair.sql.exec('SELECT * FROM discord_posts').one();
  assert.deepEqual([row.status, row.thread_id, row.thread_retry_at], ['live', null, NOW + 2000]);
  // until then, "Chat on Discord" goes to the post itself
  let floor = (await call('GET', `floor?from=${NOW}&to=${NOW + 30 * DAY}`)).data;
  assert.equal(floor.games.find((g) => g.id === game.id).discordUrl, `https://discord.com/channels/${GUILD}/${SESSIONS}/${row.message_id}`);
  d.routes.length = 0;
  Date.now = () => NOW + 2500;
  assert.equal((await lair.discordSync()).threads, 1);
  assert.equal(lair.sql.exec('SELECT thread_id FROM discord_posts').one().thread_id, row.message_id);
  floor = (await call('GET', `floor?from=${NOW}&to=${NOW + 30 * DAY}`)).data;
  assert.equal(floor.games.find((g) => g.id === game.id).discordUrl, `https://discord.com/channels/${GUILD}/${row.message_id}`);
  // Discord says there's one already (an earlier try made it, then its answer was lost): that's the message's own id
  const other = await strahd({ title: 'Delta Green', start: at('2026-10-17', 18), end: at('2026-10-17', 21), tables: ['A3'] });
  d.routes.push((c, reply, fallback) => {
    if (!/\/messages\/\d+\/threads$/.test(c.path)) return null;
    fallback();
    return reply({ message: 'A thread has already been created for this message', code: 160004 }, 400);
  });
  await lair.discordSync();
  const delta = lair.sql.exec('SELECT * FROM discord_posts WHERE target_id = ?', other.game.id).one();
  assert.equal(delta.thread_id, delta.message_id);
  assert.equal(delta.thread_retry_at, null);
});

test('posts: a post deleted in Discord goes up again', async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ events: null });
  const { game } = await strahd();
  await lair.discordSync();
  const old = lair.sql.exec('SELECT message_id FROM discord_posts').one().message_id;
  d.deleted.add(old);
  await guestSeat(game.id);
  assert.equal((await lair.discordSync()).edited, 0, "the edit's 404 sets it aside");
  assert.equal((await lair.discordSync()).created, 1);
  const live = lair.sql.exec("SELECT * FROM discord_posts WHERE status = 'live'").toArray();
  assert.equal(live.length, 1);
  assert.notEqual(live[0].message_id, old);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM discord_posts WHERE status = 'gone'").one().n, 1);
});

test("posts: while the store's rules haven't loaded (the built-in defaults stand in, with no events), nothing is taken down, posted or rounded up", async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ sessions: null });
  await lair.discordSync();
  assert.equal(d.messages(EVENTS_CH).length, 3);
  // the Lair restarts, and Shopify doesn't answer its first read
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.loadLairData = async () => {
    throw new Error('Shopify said 503');
  };
  lair.rulesCache = null;
  lair.rulesLoadedAt = 0;
  await lair.rules();
  assert.deepEqual([lair.rulesStandIn, lair.rulesCache.events.length], [true, 0]);
  const out = await lair.discordSync();
  assert.equal(out.waiting, 'rules');
  assert.equal(d.calls.filter((c) => c.method === 'DELETE' || c.method === 'PATCH').length, 0, 'every event post stays as it is');
  assert.equal(lair.discordDigestDue(lair.rulesCache, at('2026-10-09', 13)), false, 'no round-up without the events');
  const status = await lair.discordUpkeep(lair.rulesCache);
  assert.deepEqual([status.pending, status.waitingForRules], [0, true]);
  // Shopify answers again: the same posts carry on, none taken down or doubled
  lair.shopify.loadLairData = async () => ({ rooms: ROOMS, events: EVENTS, settingsText: '', theme: null, shop: {} });
  lair.rulesLoadedAt = 0;
  await lair.rules();
  assert.equal(lair.rulesStandIn, false);
  const back = await lair.discordSync();
  assert.deepEqual([back.created, back.ended], [0, 0]);
  assert.equal(d.calls.filter((c) => c.method === 'DELETE').length, 0);
  assert.equal(d.messages(EVENTS_CH).length, 3);
});

test('posts: a retry time that has passed on one post never stops the alarm being set for another that Discord asked to wait', async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ events: null });
  await strahd({ title: 'Game A', start: at('2026-10-16', 12), end: at('2026-10-16', 13), tables: ['T10'] });
  const b = await strahd({ title: 'Game B', start: at('2026-10-16', 14), end: at('2026-10-16', 15), tables: ['T11'] });
  await lair.discordSync();
  // Game A's edit failed once and it's back to what it shows: its old retry time stays on it
  lair.sql.exec("UPDATE discord_posts SET retry_at = ? WHERE title = 'Game A'", NOW - HOUR);
  await guestSeat(b.game.id);
  d.routes.push((c, reply) => (c.method === 'PATCH' ? reply({ message: 'You are being rate limited.', retry_after: 2, global: false }, 429) : null));
  lair.discordAuto = true;
  await lair.discordSync();
  await Promise.all(pending);
  assert.equal(lair.ctx.alarmAt(), NOW + 2000, "Game B's edit is tried again when Discord said");
});

test('posts: picking another channel leaves the old posts alone and puts new ones up there at once, even one Discord refused before', async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels({ events: null });
  await strahd();
  await lair.discordSync();
  await strahd({ title: 'Delta Green', start: at('2026-10-17', 18), end: at('2026-10-17', 21), tables: ['A3'] });
  d.routes.push((c, reply) => (c.method === 'POST' && c.path === `/channels/${SESSIONS}/messages` ? reply({ message: 'Missing Permissions', code: 50013 }, 403) : null));
  await lair.discordSync();
  assert.equal(lair.sql.exec("SELECT status FROM discord_posts WHERE title = 'Delta Green'").one().status, 'failed');
  lair.saveDiscordSetting('sessions_channel', NEW_CHANNEL, 'test');
  const out = await lair.discordSync();
  assert.equal(out.created, 2);
  assert.equal(d.creates(NEW_CHANNEL).length, 2);
  assert.deepEqual(lair.sql.exec('SELECT status FROM discord_posts').toArray().map((r) => r.status).sort(), ['live', 'live', 'moved', 'moved']);
});

test('posts catch up by themselves a moment after a booking changes (the alarm, set once for a burst), and not at all until the bot can post', async () => {
  const d = fakeDiscord();
  lair.discordAuto = true;
  await strahd();
  await Promise.all(pending);
  assert.equal(lair.ctx.alarmAt(), null, 'no token, no channel: no alarm');
  setEnv();
  setChannels({ events: null });
  const game = lair.sql.exec('SELECT id FROM games').one().id;
  await guestSeat(game);
  Date.now = () => NOW + 500;
  await guestSeat(game, { email: 'kiri@example.com', name: 'Kiri', players: [{ name: 'Kiri' }] });
  await Promise.all(pending);
  assert.equal(lair.ctx.alarmAt(), NOW + 2000, 'set by the first change, two seconds on');
  assert.equal(d.calls.length, 0, 'nothing posted from the booking itself');
  await fireAlarm();
  const posted = d.creates(SESSIONS);
  assert.equal(posted.length, 1);
  assert.match(JSON.stringify(posted[0].body.embeds[0].fields), /2 of 4 left/);
  assert.equal(lair.ctx.alarmAt(), null, 'nothing more to do');
  // Post now in /lair-setup wakes it straight away
  Date.now = () => NOW + 10_000;
  await discord(click('dg:set:sync', manager));
  await Promise.all(pending);
  assert.equal(lair.ctx.alarmAt(), NOW + 10_000);
});

test("the midday round-up: today's spare seats and places, once a day from midday, never in a forum", async () => {
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
  assert.deepEqual(post.body.allowed_mentions, { parse: [] });
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

test('the maintenance only wakes the alarm (when the posts have something to do, or the round-up is due); the alarm posts, in its own invocation', async () => {
  const d = fakeDiscord();
  setEnv();
  setChannels();
  Date.now = () => at('2026-10-10', 12, 10);
  await strahd({ title: 'Saturday one-shot', start: at('2026-10-10', 18), end: at('2026-10-10', 21) });
  lair.discordAuto = true;
  const report = await call('POST', 'internal/maintenance', {}, '', { 'X-Lair-Internal': '1' });
  assert.equal(report.status, 200);
  assert.ok(report.data.discord.pending > 0);
  await Promise.all(pending);
  assert.equal(lair.ctx.alarmAt(), at('2026-10-10', 12, 10));
  assert.ok(!d.calls.some((c) => c.path.startsWith('/channels/')), 'the maintenance itself posts nothing');
  await fireAlarm();
  assert.equal(d.creates(SESSIONS).filter((c) => c.body.embeds?.[0]?.title === 'Saturday one-shot').length, 1);
  assert.equal(d.creates(EVENTS_CH).length, 4);
  assert.equal(d.calls.filter((c) => String(c.body?.content || '').startsWith('**Still room at the Lair today:**')).length, 1, 'and the round-up');
  // nothing to do: no alarm
  const quiet = await call('POST', 'internal/maintenance', {}, '', { 'X-Lair-Internal': '1' });
  assert.equal(quiet.data.discord.pending, 0);
  await Promise.all(pending);
  assert.equal(lair.ctx.alarmAt(), null);
  // /setup?…&discord=sync: what Discord refused is tried again now
  lair.sql.exec("UPDATE discord_posts SET tries = 3, retry_at = ?, thread_retry_at = ? WHERE status = 'live'", Date.now() + 8 * HOUR, Date.now() + HOUR);
  await lair.discordUpkeep(lair.rulesCache, { action: 'sync' });
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM discord_posts WHERE tries > 0 OR retry_at IS NOT NULL OR thread_retry_at IS NOT NULL").one().n, 0);
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

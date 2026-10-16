// Round 17, the member's side checked against the real theme (r17-real-member): what the Lair had to change so the
// theme's flows hold. Members who have only ever borrowed have no email of their own (members.email comes from a
// booking or their profile), but GET /me keeps their Shopify account's verified email: the queue's emails and "Tell me
// when it's back" go there, as the postal swap's checkout already did. The theme says "We'll email you when it's back".
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings } from '../src/core.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Friday 16 October 2026, 1:00pm in Auckland (NZDT)
const NOW = at('2026-10-16', 13);
const realNow = Date.now;
const realFetch = globalThis.fetch;
let clock = NOW;

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
  return { db, storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: () => {} };
}

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];
const HOURS = 'Mon 10:00-23:00\nTue 10:00-23:00\nWed 10:00-23:00\nThu 10:00-23:00\nFri 10:00-23:00\nSat 10:00-23:00\nSun 10:00-23:00';
// Sam (Stash), Kiri (Grab), Leo (Hoard) and Ari (no plan): none has ever booked, so none has an email of their own
const SAM = '1001';
const KIRI = '1002';
const LEO = '1003';
const ARI = '1004';
const NAMES = { [SAM]: 'Sam Jones', [KIRI]: 'Kiri Smith', [LEO]: 'Leo Tane', [ARI]: 'Ari Moana' };
/** Their Shopify accounts' verified emails (what GET /me asks Shopify for) */
const ACCOUNT = { [SAM]: 'sam.account@example.com', [KIRI]: 'kiri.account@example.com', [LEO]: 'leo.account@example.com', [ARI]: 'ari.account@example.com' };
const game = (productId, variantId, title) => ({
  productId, variantId, title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), image: null, shelfCode: `DGL34-M${String(variantId).slice(-3)}`,
  copies: 1, inStoreOnly: false, kind: 'game', table: 'single', status: 'active',
});
const AZUL = '7002';
const ROOT = '7003';
const WINGSPAN = '7004';
const FIXTURES = { [AZUL]: game(AZUL, '4002', 'Azul'), [ROOT]: game(ROOT, '4003', 'Root'), [WINGSPAN]: game(WINGSPAN, '4004', 'Wingspan') };

let lair;
let sent;
async function call(method, path, body, customer = '') {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer }, body: body == null ? undefined : JSON.stringify(body),
  }));
  return { status: response.status, data: await response.json() };
}
/** The 10-minute maintenance run, as the Worker's cron asks for it */
const maintenance = async () => (await lair.fetch(new Request('https://lair.test/internal/maintenance', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body: '{}',
}))).json();
const settle = () => new Promise((r) => setTimeout(r, 10));
const to = (address) => sent.filter((m) => m.to === address).map((m) => m.subject);

beforeEach(async () => {
  clock = NOW;
  Date.now = () => clock;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  lair.pickGame = (id) => FIXTURES[id] || null;
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: false, tags: id === 'staff' ? ['staff'] : [] });
  lair.rulesCache = rulesFromSettings({ lair_hours: HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  // Shopify as GET /me needs it: their account's verified email, nothing else
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  lair.shopify.customerEmail = async (id) => (ACCOUNT[id] ? { email: ACCOUNT[id], verified: true } : null);
  lair.shopify.variantCopies = async (ids) => new Map(ids.map((id) => [id, null]));
  lair.shopify.deleteDraftIfOpen = async () => true;
  // emails on, and everything sent to Resend caught
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test' };
  sent = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.resend.com/')) throw new Error(`No network in tests: ${url}`);
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  // each opens My Lair once (GET /me: their member record and their account's email), and has a library plan
  for (const [id, name] of Object.entries(NAMES)) assert.equal((await call('GET', `me?name=${encodeURIComponent(name)}`, null, id)).status, 200);
  for (const [id, tier] of [[SAM, 'stash'], [KIRI, 'grab'], [LEO, 'hoard']]) {
    lair.sql.exec(
      'INSERT OR REPLACE INTO memberships (id, contract_gid, customer_id, status, tier, billing_tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      `9${id}`, `gid://shopify/SubscriptionContract/9${id}`, id, 'active', tier, tier, NOW - 30 * DAY, NOW,
    );
  }
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
});

test('round 17 real member: a member who has only borrowed hears at their account\'s email: on hold, paused, ready to post, back on the shelf (their own email wins once they give one)', async () => {
  const row = lair.memberRow(SAM);
  assert.deepEqual([row.email, row.account_email], [null, ACCOUNT[SAM]], 'no email of their own; their account\'s, from GET /me');
  // Sam queues Azul, on the shelf: held at once, and he hears at his account's email (staff see that address too)
  assert.equal((await call('POST', 'me/queue', { productId: AZUL }, SAM)).data.queue[0].status, 'held');
  await settle();
  assert.deepEqual(to(ACCOUNT[SAM]), ['Azul is next in your queue and on hold for you']);
  assert.match(sent.find((m) => m.subject.startsWith('Hold this game: Azul')).text, /sam\.account@example\.com/);
  // not collected by Monday: his queue stops, and he hears that too
  clock = at('2026-10-19', 9);
  sent.length = 0;
  assert.deepEqual((await maintenance()).libraryHolds, { expired: 1 });
  await settle();
  assert.deepEqual(to(ACCOUNT[SAM]), ['Your queue is paused']);
  // Kiri swaps by post: Root is held for her to post, and the "ready to post" email reaches her account's email
  clock = NOW;
  sent.length = 0;
  await call('POST', 'me/queue/settings', { delivery: 'post', area: 'auckland' }, KIRI);
  await call('POST', 'me/queue', { productId: ROOT }, KIRI);
  await settle();
  assert.deepEqual(to(ACCOUNT[KIRI]), ['Your next game is ready to post: Root']);
  // Ari (no plan) watches Wingspan, which Leo has reserved; Leo cancels and Ari is told, at her account's email
  await call('POST', 'library/holds', { variantId: '4004', productId: WINGSPAN, title: 'Wingspan', shelfCode: 'DGL34-M004', handle: 'wingspan' }, LEO);
  assert.deepEqual((await call('POST', 'library/watch', { productId: WINGSPAN }, ARI)).data, { ok: true, watching: true });
  sent.length = 0;
  const leoHold = lair.sql.exec("SELECT id FROM library_holds WHERE customer_id = ? AND status = 'held'", LEO).one();
  await call('POST', `library/holds/${leoHold.id}/cancel`, {}, LEO);
  await settle();
  assert.deepEqual(to(ACCOUNT[ARI]), ['Wingspan is back on the shelf']);
  assert.deepEqual(lair.sql.exec('SELECT * FROM library_watch').toArray(), [], 'told once: the watch goes');
  // Ari gives an email of her own (her profile): that's where the next one goes
  await call('POST', 'me/profile', { name: NAMES[ARI], email: 'ari@own.example.com' }, ARI);
  await call('POST', 'library/holds', { variantId: '4004', productId: WINGSPAN, title: 'Wingspan', shelfCode: 'DGL34-M004', handle: 'wingspan' }, LEO);
  await call('POST', 'library/watch', { productId: WINGSPAN }, ARI);
  sent.length = 0;
  await call('POST', `library/holds/${lair.sql.exec("SELECT id FROM library_holds WHERE customer_id = ? AND status = 'held'", LEO).one().id}/cancel`, {}, LEO);
  await settle();
  assert.deepEqual(sent.filter((m) => /back on the shelf/.test(m.subject)).map((m) => m.to), ['ari@own.example.com']);
});

test('round 17 real member: with no email at all, nobody is emailed, and the watch still goes once a copy is free', async () => {
  lair.sql.exec('UPDATE members SET account_email = NULL WHERE customer_id = ?', ARI);
  await call('POST', 'library/holds', { variantId: '4004', productId: WINGSPAN, title: 'Wingspan', shelfCode: 'DGL34-M004', handle: 'wingspan' }, LEO);
  await call('POST', 'library/watch', { productId: WINGSPAN }, ARI);
  sent.length = 0;
  await call('POST', `library/holds/${lair.sql.exec("SELECT id FROM library_holds WHERE customer_id = ? AND status = 'held'", LEO).one().id}/cancel`, {}, LEO);
  await settle();
  assert.deepEqual(sent.filter((m) => /back on the shelf/.test(m.subject)), []);
  assert.deepEqual(lair.sql.exec('SELECT * FROM library_watch').toArray(), []);
});

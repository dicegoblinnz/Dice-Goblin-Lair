// Run with: node --test test/
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { LairTime, openWindow, rulesFromSettings, parseTableList, buildRooms } from '../src/core.js';
import { verifyProxySignature, verifyWebhook } from '../src/shopify.js';
import worker from '../src/index.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
// Thursday 1 October 2026, 1:00pm in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 9, 1, 0, 0);
const realNow = Date.now;

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
  { id: 'side-room-2', name: 'Side room 2', code: 'B', tables: 4, seats: 4, order: 3 },
  { id: 'fancy-room', name: 'Fancy room', code: 'F', tables: 1, seats: 12, price: 15, minPeople: 4, order: 4 },
];
// Most tests were written against these hours (open from midday); the real hours have their own test.
const TEST_HOURS = 'Mon closed\nTue 12:00-22:00\nWed 12:00-22:00\nThu 12:00-22:00\nFri 12:00-23:00\nSat 10:00-23:00\nSun 10:00-20:00';

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
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const tableBooking = (over = {}) => ({
  kind: 'table', tables: ['T3'], start: at('2026-10-01', 15), end: at('2026-10-01', 17), people: 4, name: 'Sam', email: 'sam@example.com', pay: 'day', ...over,
});

beforeEach(() => {
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: id === 'gm' });
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [
    { id: 'fnm', title: 'Friday Night Magic', start: at('2026-10-02', 18, 30), end: at('2026-10-02', 22), tables: 'T11-T20' },
  ]);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
});
afterEach(() => {
  Date.now = realNow;
});

test('app proxy signature: valid, tampered and stale', async () => {
  const secret = 'hush';
  const params = new URLSearchParams({ shop: 'ep0qiq-rp.myshopify.com', logged_in_customer_id: '42', path_prefix: '/apps/lair', timestamp: String(NOW / 1000), from: '1' });
  params.append('extra', '1');
  params.append('extra', '2');
  const grouped = {};
  for (const [k, v] of params) (grouped[k] ||= []).push(v);
  const message = Object.entries(grouped).map(([k, v]) => `${k}=${v.join(',')}`).sort().join('');
  const { createHmac } = await import('node:crypto');
  params.set('signature', createHmac('sha256', secret).update(message).digest('hex'));
  assert.equal(await verifyProxySignature(params, secret, { now: NOW }), true);
  const tampered = new URLSearchParams(params);
  tampered.set('logged_in_customer_id', '43');
  assert.equal(await verifyProxySignature(tampered, secret, { now: NOW }), false);
  assert.equal(await verifyProxySignature(params, secret, { now: NOW + 2 * HOUR }), false);
  assert.equal(await verifyProxySignature(params, 'wrong', { now: NOW }), false);
});

test('webhook HMAC', async () => {
  const { createHmac } = await import('node:crypto');
  const body = '{"id":1}';
  const header = createHmac('sha256', 's3cret').update(body).digest('base64');
  assert.equal(await verifyWebhook(body, header, 's3cret'), true);
  assert.equal(await verifyWebhook(body + ' ', header, 's3cret'), false);
});

test('Auckland time and daylight saving (27 Sep 2026)', () => {
  const rules = rulesFromSettings({}, FALLBACK, []);
  const win = openWindow(rules, time, '2026-09-27');
  assert.equal(new Date(win.open).toISOString(), '2026-09-26T21:00:00.000Z'); // 10:00 NZDT
  const before = openWindow(rules, time, '2026-09-26');
  assert.equal(new Date(before.open).toISOString(), '2026-09-25T22:00:00.000Z'); // 10:00 NZST
  assert.equal(new Date(openWindow(rules, time, '2026-09-28').open).toISOString(), '2026-09-28T03:00:00.000Z'); // Monday 4pm NZDT
});

test('table numbering and table lists match the theme', () => {
  const rooms = buildRooms(FALLBACK, 1000);
  assert.deepEqual(rooms[0].tables.slice(0, 3).map((t) => t.id), ['T1', 'T2', 'T3']);
  assert.equal(rooms[3].price, 1500);
  assert.deepEqual(parseTableList('T11-T13, Side room 2', rooms), ['T11', 'T12', 'T13', 'B1', 'B2', 'B3', 'B4']);
  assert.equal(parseTableList('all', rooms).length, 29);
});

test('book a table: pay on the day', async () => {
  const { status, data } = await call('POST', 'bookings', tableBooking());
  assert.equal(status, 200);
  assert.equal(data.booking.status, 'confirmed');
  assert.equal(data.booking.amount, 4000);
  assert.match(data.booking.ref, /^GOB-[A-Z2-9]{6}$/);
});

test('the same table cannot be booked twice', async () => {
  await call('POST', 'bookings', tableBooking());
  const clash = await call('POST', 'bookings', tableBooking({ start: at('2026-10-01', 16), end: at('2026-10-01', 18), name: 'Mia', email: 'mia@example.com' }));
  assert.equal(clash.status, 409);
  const next = await call('POST', 'bookings', tableBooking({ start: at('2026-10-01', 17), end: at('2026-10-01', 18) }));
  assert.equal(next.status, 200);
});

test('one hour lead time: at 1pm, 1:30pm is too soon and 2pm is fine', async () => {
  const soon = await call('POST', 'bookings', tableBooking({ start: at('2026-10-01', 13, 30), end: at('2026-10-01', 14, 30) }));
  assert.equal(soon.status, 422);
  const ok = await call('POST', 'bookings', tableBooking({ start: at('2026-10-01', 14), end: at('2026-10-01', 15) }));
  assert.equal(ok.status, 200);
});

test('opening hours, closed days, room mixing and seat limits', async () => {
  assert.equal((await call('POST', 'bookings', tableBooking({ start: at('2026-10-01', 21), end: at('2026-10-01', 23) }))).status, 422);
  assert.equal((await call('POST', 'bookings', tableBooking({ start: at('2026-10-05', 14), end: at('2026-10-05', 15) }))).status, 422);
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T1', 'A1'] }))).status, 422);
  assert.equal((await call('POST', 'bookings', tableBooking({ people: 9, tables: ['T1', 'T2'] }))).status, 422);
  assert.equal((await call('POST', 'bookings', tableBooking({ people: 2, tables: ['T1', 'T2'], extras: ['wargame'] }))).status, 200);
});

test('fancy room is $15 a person', async () => {
  const { data } = await call('POST', 'bookings', tableBooking({ tables: ['F1'], people: 5 }));
  assert.equal(data.booking.amount, 7500);
});

test('events that hold tables block bookings', async () => {
  const held = await call('POST', 'bookings', tableBooking({ tables: ['T12'], start: at('2026-10-02', 18), end: at('2026-10-02', 20) }));
  assert.equal(held.status, 409);
  const fine = await call('POST', 'bookings', tableBooking({ tables: ['T2'], start: at('2026-10-02', 18), end: at('2026-10-02', 20) }));
  assert.equal(fine.status, 200);
});

test('pay now without Shopify connected falls back to paying at the counter', async () => {
  const { status, data } = await call('POST', 'bookings', tableBooking({ pay: 'now' }));
  assert.equal(status, 200);
  assert.equal(data.booking.status, 'confirmed');
  assert.equal(data.booking.pay, 'day');
  assert.ok(data.notice);
});

test('orders/paid confirms a held booking; unpaid holds lapse after 30 minutes', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.createCheckout = async () => ({ draftOrderId: 'gid://shopify/DraftOrder/1', checkoutUrl: 'https://checkout.test/1' });
  lair.shopify.deleteDraftOrder = async () => {};
  lair.shopify.draftOrderOrderId = async (id) => (id === 'gid://shopify/DraftOrder/1' ? 'gid://shopify/Order/9' : null);
  const first = await call('POST', 'bookings', tableBooking({ pay: 'now' }));
  assert.equal(first.data.checkoutUrl, 'https://checkout.test/1');
  assert.equal(first.data.booking.status, 'held');
  const paid = await internal('orders-paid', { id: 9, admin_graphql_api_id: 'gid://shopify/Order/9', note_attributes: [{ name: '_booking', value: first.data.booking.ref }] });
  assert.deepEqual(paid.data.updated, [first.data.booking.ref]);
  const staffView = await call('GET', 'floor', null, 'staff');
  const saved = staffView.data.bookings.find((b) => b.ref === first.data.booking.ref);
  assert.equal(saved.status, 'confirmed');
  assert.equal(saved.paid, true);

  const second = await call('POST', 'bookings', tableBooking({ tables: ['T4'], pay: 'now' }));
  assert.equal(second.data.booking.status, 'held');
  Date.now = () => NOW + 31 * 60_000;
  const later = await call('GET', 'floor', null, 'staff');
  assert.equal(later.data.bookings.find((b) => b.ref === second.data.booking.ref).status, 'cancelled');
});

test('the public floor hides names; staff see them', async () => {
  await call('POST', 'bookings', tableBooking());
  const pub = await call('GET', 'floor');
  assert.equal(pub.data.bookings[0].name, undefined);
  assert.equal(pub.data.bookings[0].email, undefined);
  const staff = await call('GET', 'floor', null, 'staff');
  assert.equal(staff.data.bookings[0].name, 'Sam');
});

test('staff-only actions are refused for everyone else', async () => {
  const { data } = await call('POST', 'bookings', tableBooking());
  assert.equal((await call('POST', `bookings/${data.booking.id}/update`, { status: 'seated' }, 'someone')).status, 403);
  assert.equal((await call('POST', 'bookings', { ...tableBooking(), kind: 'walkin' }, 'someone')).status, 403);
  assert.equal((await call('POST', 'blocks', { tables: 'T1-T4', start: NOW, end: NOW + HOUR, label: 'x' }, 'someone')).status, 403);
  const seated = await call('POST', `bookings/${data.booking.id}/update`, { status: 'seated', people: 5 }, 'staff');
  assert.equal(seated.data.booking.status, 'seated');
  assert.equal(seated.data.booking.amount, 5000);
});

test('staff: walk-ins, extending into a booked slot is refused, holds block bookings', async () => {
  const walkin = await call('POST', 'bookings', { kind: 'walkin', tables: ['T8'], start: NOW, end: NOW + HOUR, people: 2 }, 'staff');
  assert.equal(walkin.data.booking.status, 'seated');
  await call('POST', 'bookings', tableBooking({ tables: ['T8'], start: at('2026-10-01', 14), end: at('2026-10-01', 15) }));
  const extend = await call('POST', `bookings/${walkin.data.booking.id}/update`, { end: NOW + 2 * HOUR }, 'staff');
  assert.equal(extend.status, 409);
  const hold = await call('POST', 'blocks', { tables: 'T15-T17', start: at('2026-10-01', 18), end: at('2026-10-01', 22), label: 'Pokémon league', type: 'event' }, 'staff');
  assert.deepEqual(hold.data.block.tables, ['T15', 'T16', 'T17']);
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T16'], start: at('2026-10-01', 19), end: at('2026-10-01', 20) }))).status, 409);
  await call('POST', `blocks/${hold.data.block.id}/delete`, {}, 'staff');
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T16'], start: at('2026-10-01', 19), end: at('2026-10-01', 20) }))).status, 200);
});

test('GM games: listing, approval, seats, capacity and store credit for paid players only', async () => {
  const game = {
    title: 'Curse of Strahd one-shot', system: 'D&D 5e', gm: 'Rangi', blurb: 'Mist and vampires.', seats: 3,
    tables: ['A3'], start: at('2026-10-01', 18), end: at('2026-10-01', 22),
  };
  assert.equal((await call('POST', 'games', game)).status, 401);
  const listed = await call('POST', 'games', game, 'player9');
  assert.equal(listed.data.game.status, 'pending');
  assert.equal((await call('GET', 'floor')).data.games.length, 0);
  assert.equal((await call('POST', 'games', { ...game, title: 'Same table' }, 'gm')).status, 409);
  const trusted = await call('POST', 'games', { ...game, title: 'Trusted GM game', tables: ['A4'] }, 'gm');
  assert.equal(trusted.data.game.status, 'open');

  const id = listed.data.game.id;
  assert.equal((await call('POST', `games/${id}/update`, { status: 'open' }, 'staff')).data.game.status, 'open');
  const seat = { kind: 'gm-seat', gameId: id, people: 2, name: 'Mia', email: 'mia@example.com', pay: 'day' };
  const s1 = await call('POST', 'bookings', seat);
  assert.equal(s1.data.booking.amount, 3000);
  assert.equal((await call('POST', 'bookings', { ...seat, name: 'Leo', email: 'leo@example.com' })).status, 409);
  const s2 = await call('POST', 'bookings', { ...seat, people: 1, name: 'Leo', email: 'leo@example.com' });
  assert.equal(s2.status, 200);
  assert.equal((await call('GET', 'floor')).data.games.find((g) => g.id === id).status, 'full');

  await call('POST', `bookings/${s1.data.booking.id}/update`, { paid: true }, 'staff');
  assert.equal((await call('POST', `games/${id}/credit`, {}, 'staff')).status, 422);
  Date.now = () => at('2026-10-01', 22, 30);
  const credit = await call('POST', `games/${id}/credit`, {}, 'staff');
  assert.equal(credit.data.players, 2);
  assert.equal(credit.data.amount, 1000);
  assert.equal((await call('POST', `games/${id}/credit`, {}, 'staff')).status, 409);
});

test('internal routes only answer the Worker, never the public proxy', async () => {
  const { data } = await call('POST', 'bookings', tableBooking());
  const sneaky = await call('POST', 'internal/orders-paid', { note_attributes: [{ name: '_booking', value: data.booking.ref }] });
  assert.equal(sneaky.status, 404);
  const staffView = await call('GET', 'floor', null, 'staff');
  assert.equal(staffView.data.bookings.find((b) => b.ref === data.booking.ref).paid, false);
});

async function signedUrl(path, params, secret = 'hush') {
  const { createHmac } = await import('node:crypto');
  const search = new URLSearchParams(params);
  const grouped = {};
  for (const [k, v] of search) (grouped[k] ||= []).push(v);
  const message = Object.entries(grouped).map(([k, v]) => `${k}=${v.join(',')}`).sort().join('');
  search.set('signature', createHmac('sha256', secret).update(message).digest('hex'));
  return `https://worker.test${path}?${search}`;
}

test('Worker: proxy checks the signature, shop and customer, and never forwards to internal routes', async () => {
  Date.now = realNow;
  const seen = [];
  const env = {
    SHOP: 'ep0qiq-rp.myshopify.com', SHOPIFY_CLIENT_SECRET: 'hush',
    LAIR: { idFromName: () => 'id', get: () => ({ fetch: async (req) => { seen.push({ url: req.url, customer: req.headers.get('X-Lair-Customer'), internal: req.headers.get('X-Lair-Internal') }); return new Response('{}'); } }) },
  };
  const base = { shop: env.SHOP, path_prefix: '/apps/lair', timestamp: String(Math.floor(Date.now() / 1000)) };
  const good = await worker.fetch(new Request(await signedUrl('/proxy/floor', { ...base, logged_in_customer_id: '42', from: '1' })), env);
  assert.equal(good.status, 200);
  assert.equal(seen.at(-1).customer, '42');
  assert.equal(seen.at(-1).internal, null);
  assert.match(seen.at(-1).url, /\/floor\?/);

  const unsigned = await worker.fetch(new Request('https://worker.test/proxy/floor?shop=x'), env);
  assert.equal(unsigned.status, 401);
  const otherShop = await worker.fetch(new Request(await signedUrl('/proxy/floor', { ...base, shop: 'evil.myshopify.com', logged_in_customer_id: '' })), env);
  assert.equal(otherShop.status, 401);
  const twoIds = new URLSearchParams({ ...base });
  twoIds.append('logged_in_customer_id', '1');
  twoIds.append('logged_in_customer_id', '');
  const doubled = await worker.fetch(new Request(await signedUrl('/proxy/floor', twoIds)), env);
  assert.equal(doubled.status, 400);
  const before = seen.length;
  const sneaky = await worker.fetch(new Request(await signedUrl('/proxy/internal/orders-paid', { ...base, logged_in_customer_id: '' }), { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }), env);
  assert.equal(sneaky.status, 404);
  const formPost = await worker.fetch(new Request(await signedUrl('/proxy/bookings', { ...base, logged_in_customer_id: '42' }), { method: 'POST', body: '{"kind":"walkin"}', headers: { 'Content-Type': 'text/plain' } }), env);
  assert.equal(formPost.status, 415);
  const typeless = await worker.fetch(new Request(await signedUrl('/proxy/bookings', { ...base, logged_in_customer_id: '42' }), { method: 'POST', body: new Blob(['{}']) }), env);
  assert.equal(typeless.status, 415);
  assert.equal(seen.length, before);
  const relaxed = await worker.fetch(new Request(await signedUrl('/proxy/bookings', { ...base, logged_in_customer_id: '42' }), { method: 'POST', body: new Blob(['{}']) }), { ...env, JSON_ONLY: 'off' });
  assert.equal(relaxed.status, 200);
  assert.equal(seen.length, before + 1);
});

test('Worker: webhooks need a valid HMAC from this shop', async () => {
  const { createHmac } = await import('node:crypto');
  const seen = [];
  const env = {
    SHOP: 'ep0qiq-rp.myshopify.com', SHOPIFY_CLIENT_SECRET: 'hush',
    LAIR: { idFromName: () => 'id', get: () => ({ fetch: async (req) => { seen.push(req.headers.get('X-Lair-Internal')); return new Response('{"updated":[]}'); } }) },
  };
  const body = '{"id":1,"note_attributes":[]}';
  const hmac = createHmac('sha256', 'hush').update(body).digest('base64');
  const headers = { 'X-Shopify-Hmac-Sha256': hmac, 'X-Shopify-Shop-Domain': env.SHOP, 'X-Shopify-Topic': 'orders/paid' };
  assert.equal((await worker.fetch(new Request('https://worker.test/webhooks/orders-paid', { method: 'POST', body, headers }), env)).status, 200);
  assert.deepEqual(seen, ['1']);
  const forged = { ...headers, 'X-Shopify-Hmac-Sha256': createHmac('sha256', 'nope').update(body).digest('base64') };
  assert.equal((await worker.fetch(new Request('https://worker.test/webhooks/orders-paid', { method: 'POST', body, headers: forged }), env)).status, 401);
  const wrongShop = { ...headers, 'X-Shopify-Shop-Domain': 'evil.myshopify.com' };
  assert.equal((await worker.fetch(new Request('https://worker.test/webhooks/orders-paid', { method: 'POST', body, headers: wrongShop }), env)).status, 401);
  assert.equal((await worker.fetch(new Request('https://worker.test/setup', { method: 'POST' }), { ...env, SETUP_KEY: 'k' })).status, 403);
});

test('only the booking\'s own checkout can pay for it: a cheap order with the ref in a note does nothing', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.createCheckout = async () => ({ draftOrderId: 'gid://shopify/DraftOrder/2', checkoutUrl: 'https://checkout.test/2' });
  lair.shopify.draftOrderOrderId = async (id) => (id === 'gid://shopify/DraftOrder/2' ? 'gid://shopify/Order/10' : null);
  const onTheDay = await call('POST', 'bookings', tableBooking({ tables: ['T7'] }));
  const online = await call('POST', 'bookings', tableBooking({ pay: 'now' }));
  const forged = { id: 99, admin_graphql_api_id: 'gid://shopify/Order/99', note: `Lair booking ${onTheDay.data.booking.ref} ${online.data.booking.ref}`, note_attributes: [{ name: '_booking', value: online.data.booking.ref }] };
  assert.deepEqual((await internal('orders-paid', forged)).data.updated, []);
  const real = { id: 10, admin_graphql_api_id: 'gid://shopify/Order/10', note: `Lair booking ${online.data.booking.ref}` };
  assert.deepEqual((await internal('orders-paid', real)).data.updated, [online.data.booking.ref]);
  assert.deepEqual((await internal('orders-paid', real)).data.updated, [online.data.booking.ref]);
  const all = (await call('GET', 'floor', null, 'staff')).data.bookings;
  assert.equal(all.find((b) => b.ref === onTheDay.data.booking.ref).paid, false);
  const saved = all.find((b) => b.ref === online.data.booking.ref);
  assert.equal(saved.status, 'confirmed');
  assert.equal(saved.paid, true);
  assert.equal(saved.orderId, 'gid://shopify/Order/10');
});

test('paid after the hold ran out: spot kept if free, flagged if someone else took it', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  let n = 0;
  lair.shopify.createCheckout = async () => { n += 1; return { draftOrderId: `gid://shopify/DraftOrder/3${n}`, checkoutUrl: 'https://checkout.test/3' }; };
  lair.shopify.deleteDraftOrder = async () => {};
  lair.shopify.draftOrderOrderId = async (id) => ({ 'gid://shopify/DraftOrder/31': 'gid://shopify/Order/12', 'gid://shopify/DraftOrder/32': 'gid://shopify/Order/13' })[id] || null;
  const a = await call('POST', 'bookings', tableBooking({ tables: ['T5'], pay: 'now' }));
  const b = await call('POST', 'bookings', tableBooking({ tables: ['T6'], pay: 'now', email: 'b@example.com' }));
  Date.now = () => NOW + 31 * 60_000;
  await call('GET', 'floor');
  await call('POST', 'bookings', tableBooking({ tables: ['T6'], email: 'c@example.com' }));
  await internal('orders-paid', { id: 12, admin_graphql_api_id: 'gid://shopify/Order/12', note_attributes: [{ name: '_booking', value: a.data.booking.ref }] });
  await internal('orders-paid', { id: 13, admin_graphql_api_id: 'gid://shopify/Order/13', note_attributes: [{ name: '_booking', value: b.data.booking.ref }] });
  const all = (await call('GET', 'floor', null, 'staff')).data.bookings;
  assert.equal(all.find((x) => x.ref === a.data.booking.ref).status, 'confirmed');
  const late = all.find((x) => x.ref === b.data.booking.ref);
  assert.equal(late.status, 'cancelled');
  assert.equal(late.paid, true);
  assert.match(late.notes, /refund or reseat/);
});

test('pay online can be switched off in the theme settings', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  let called = false;
  lair.shopify.createCheckout = async () => { called = true; return {}; };
  lair.rulesCache = { ...lair.rulesCache, payOnline: false };
  const { data } = await call('POST', 'bookings', tableBooking({ pay: 'now' }));
  assert.equal(called, false);
  assert.equal(data.booking.pay, 'day');
  assert.ok(data.notice);
  const floor = await call('GET', 'floor');
  assert.deepEqual(floor.data.features, { email: false, payOnline: false });
});

test('one email cannot hog the floor', async () => {
  for (let i = 0; i < 6; i += 1) {
    const r = await call('POST', 'bookings', tableBooking({ tables: [`T${i + 1}`] }));
    assert.equal(r.status, 200);
  }
  const extra = await call('POST', 'bookings', tableBooking({ tables: ['T9'], email: 'SAM@example.com' }));
  assert.equal(extra.status, 429);
  const staff = await call('POST', 'bookings', tableBooking({ tables: ['T9'] }), 'staff');
  assert.equal(staff.status, 200);
});

test('custom layouts only count when they have a room box (same as the theme)', () => {
  const noBox = buildRooms([{ id: 'r', name: 'Room', code: 'Q', tables: 2, layout: JSON.stringify({ tables: [{ id: 'X9' }] }) }], 1000);
  assert.deepEqual(noBox[0].tables.map((t) => t.id), ['Q1', 'Q2']);
  const withBox = buildRooms([{ id: 'r', name: 'Room', code: 'Q', tables: 2, layout: { box: [0, 0, 10, 10], tables: [{ id: 'X9' }, {}] } }], 1000);
  assert.deepEqual(withBox[0].tables.map((t) => t.id), ['X9', 'Q2']);
});

test('cancelling a game frees its seats; staff holds report clashing bookings', async () => {
  const game = { title: 'Daggerheart', system: 'Daggerheart', gm: 'Ellie', blurb: 'Sky ships.', seats: 3, tables: ['A1'], start: at('2026-10-01', 18), end: at('2026-10-01', 21), email: 'ellie@example.com' };
  const listed = await call('POST', 'games', game, 'gm');
  const seat = await call('POST', 'bookings', { kind: 'gm-seat', gameId: listed.data.game.id, people: 2, name: 'Mia', email: 'mia@example.com', pay: 'day' });
  assert.equal(seat.status, 200);
  const cancelled = await call('POST', `games/${listed.data.game.id}/update`, { status: 'cancelled' }, 'gm');
  assert.equal(cancelled.data.affected, 1);
  const floor = await call('GET', 'floor', null, 'staff');
  assert.equal(floor.data.bookings.find((b) => b.ref === seat.data.booking.ref).status, 'cancelled');
  const free = await call('POST', 'bookings', tableBooking({ tables: ['A1'], start: at('2026-10-01', 18), end: at('2026-10-01', 19) }));
  assert.equal(free.status, 200);
  const hold = await call('POST', 'blocks', { tables: 'A1-A2', start: at('2026-10-01', 18), end: at('2026-10-01', 20), label: 'Market' }, 'staff');
  assert.deepEqual(hold.data.clashes, [free.data.booking.ref]);
});

test('the payment webhook registers itself once, accepts "already taken", and backs off after errors', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.customerTags = async () => [];
  lair.shopify.accessToken = async () => 'test-token';
  lair.shopify.appInfo = async () => ({ app: 'Dice Goblin Lair', shop: 'Dice Goblin', scopes: ['read_customers', 'read_metaobjects', 'read_themes', 'read_orders', 'write_draft_orders'] });
  lair.shopify.loadLairData = async () => ({ rooms: [], events: [], settingsText: null });
  const calls = [];
  let reply = { userErrors: [] };
  const registered = [];
  lair.shopify.webhookUris = async () => registered.slice();
  lair.shopify.registerWebhook = async (url) => { calls.push(url); if (!reply.userErrors.length) registered.push(url); return reply; };
  const origin = { 'X-Lair-Origin': 'https://lair.example.workers.dev' };
  await call('GET', 'floor', null, '', origin);
  await new Promise((r) => setTimeout(r, 0));
  await call('GET', 'floor', null, '', origin);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ['https://lair.example.workers.dev/webhooks/orders-paid']);

  reply = { userErrors: [{ message: 'Address for this topic has already been taken' }] };
  const moved = await lair.ensureWebhook('https://new.example/webhooks/orders-paid');
  assert.equal(moved.ok, true);

  reply = { userErrors: [{ message: 'Access denied for webhookSubscriptionCreate field.' }] };
  const failed = await lair.ensureWebhook('https://third.example/webhooks/orders-paid');
  assert.equal(failed.ok, false);
  const again = await lair.ensureWebhook('https://third.example/webhooks/orders-paid');
  assert.equal(again.reason, 'Waiting to retry.');
  const forced = await internal('setup', { webhookUrl: 'https://third.example/webhooks/orders-paid' });
  assert.equal(forced.data.shopifyLogin, 'ok');
  assert.deepEqual(forced.data.missingScopes, ['write_store_credit_account_transactions']);
  assert.equal(forced.data.paymentWebhook.ok, false);
  assert.match(forced.data.paymentWebhook.reason, /Access denied/);
});

test('GM credit: two taps at once only pay once; a Shopify failure can be retried', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.loadLairData = async () => ({ rooms: FALLBACK, events: [], settingsText: null });
  const game = { title: 'Race test', system: 'D&D 5e', gm: 'Rangi', blurb: 'x', seats: 3, tables: ['B1'], start: at('2026-10-01', 15), end: at('2026-10-01', 18) };
  const listed = await call('POST', 'games', game, 'gm');
  const seat = await call('POST', 'bookings', { kind: 'gm-seat', gameId: listed.data.game.id, people: 2, name: 'Mia', email: 'mia@example.com', pay: 'day' });
  await call('POST', `bookings/${seat.data.booking.id}/update`, { paid: true }, 'staff');
  Date.now = () => at('2026-10-01', 18, 30);
  let fail = true;
  const credited = [];
  lair.shopify.creditCustomer = async (customerId, cents) => {
    await new Promise((r) => setTimeout(r, 5));
    if (fail) throw new Error('Throttled');
    credited.push([customerId, cents]);
  };
  const first = await call('POST', `games/${listed.data.game.id}/credit`, {}, 'staff');
  assert.equal(first.status, 502);
  fail = false;
  const [a, b] = await Promise.all([
    call('POST', `games/${listed.data.game.id}/credit`, {}, 'staff'),
    call('POST', `games/${listed.data.game.id}/credit`, {}, 'staff'),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.deepEqual(credited, [['gm', 1000]]);
});

test('a booking reference clash fails loudly instead of replacing the other booking', async () => {
  const first = await call('POST', 'bookings', tableBooking({ tables: ['T7'] }));
  const stored = lair.booking(first.data.booking.id);
  assert.throws(() => lair.saveBooking({ ...stored, id: 'bk_other', tables: ['T9'] }, NOW));
  assert.equal(lair.booking(first.data.booking.id).tables[0], 'T7');
});

test('online group limits: 4 to a table, doubled for wargames and big box games, and big groups call', async () => {
  const book = (over) => call('POST', 'bookings', tableBooking({ email: `p${Math.random()}@example.com`, ...over }));
  assert.equal((await book({ people: 25, tables: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'] })).status, 422);
  const tooMany = await book({ people: 4, tables: ['T1', 'T2'] });
  assert.equal(tooMany.status, 422);
  assert.match(tooMany.data.error, /We seat 4 at a table/);
  assert.equal((await book({ people: 1, tables: ['T8', 'T9', 'T10'], extras: ['bigbox'] })).status, 422);
  assert.equal((await book({ people: 1, tables: ['T8', 'T9'], extras: ['bigbox'] })).status, 200);
  assert.equal((await book({ people: 2, tables: ['T1', 'T2'], extras: ['wargame'] })).status, 200);
  assert.equal((await book({ people: 5, tables: ['T11', 'T12'] })).status, 200);
  assert.equal((await book({ people: 6, tables: ['T13', 'T14', 'T15'] })).status, 422);
  assert.equal((await book({ people: 6, tables: ['T13', 'T14', 'T15', 'T16'], extras: ['wargame', 'celebrating', 'kids'] })).status, 200);
  const kept = lair.booking((await book({ people: 3, tables: ['T17'], extras: ['celebrating', 'teach', 'wargame'] })).data.booking.id);
  assert.deepEqual(kept.extras.sort(), ['celebrating', 'wargame']);
  assert.equal((await call('POST', 'bookings', tableBooking({ people: 1, tables: ['T5', 'T6', 'T7'], name: 'Staff setup' }), 'staff')).status, 200);
});

test('late-night hours: a Friday 6pm-2am night can be booked at 1am Saturday', async () => {
  lair.rulesCache = rulesFromSettings({ lair_hours: 'Thu 12:00-22:00\nFri 18:00-02:00', lair_shop_tables: '' }, FALLBACK, []);
  const late = await call('POST', 'bookings', tableBooking({ start: at('2026-10-03', 1), end: at('2026-10-03', 2) }));
  assert.equal(late.status, 200, late.data.error);
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T4'], start: at('2026-10-03', 2), end: at('2026-10-03', 3) }))).status, 422);
});

test('staff moves stay in one room; a GM game moves and stretches with its players', async () => {
  const group = await call('POST', 'bookings', tableBooking({ tables: ['T3', 'T4'], people: 6 }));
  assert.equal((await call('POST', `bookings/${group.data.booking.id}/update`, { tables: ['A1', 'T4'] }, 'staff')).status, 422);
  assert.equal((await call('POST', `bookings/${group.data.booking.id}/update`, { tables: ['A1', 'A2'] }, 'staff')).status, 200);

  const game = { title: 'Moving game', system: 'D&D 5e', gm: 'Rangi', blurb: 'x', seats: 3, tables: ['B1'], start: at('2026-10-01', 15), end: at('2026-10-01', 18) };
  const listed = await call('POST', 'games', game, 'gm');
  const seat = await call('POST', 'bookings', { kind: 'gm-seat', gameId: listed.data.game.id, people: 2, name: 'Mia', email: 'mia@example.com', pay: 'day' });
  const gmBooking = (await call('GET', 'floor', null, 'staff')).data.bookings.find((b) => b.gameId === listed.data.game.id && b.kind === 'gm');
  const longer = await call('POST', `bookings/${gmBooking.id}/update`, { end: at('2026-10-01', 19) }, 'staff');
  assert.equal(longer.status, 200, longer.data.error);
  const moved = await call('POST', `bookings/${gmBooking.id}/update`, { tables: ['B2'] }, 'staff');
  assert.equal(moved.status, 200, moved.data.error);
  const floor = (await call('GET', 'floor', null, 'staff')).data;
  const g = floor.games.find((x) => x.id === listed.data.game.id);
  assert.deepEqual(g.tables, ['B2']);
  assert.equal(g.end, at('2026-10-01', 19));
  const s = floor.bookings.find((b) => b.id === seat.data.booking.id);
  assert.deepEqual(s.tables, ['B2']);
  assert.equal(s.end, at('2026-10-01', 19));
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['B1'], start: at('2026-10-01', 15), end: at('2026-10-01', 16) }))).status, 200);
});

test('GMs: no cancelling after the start, no cancelling the table hold alone, no reopening cancelled games', async () => {
  const game = { title: 'Rules game', system: 'D&D 5e', gm: 'Ellie', blurb: 'x', seats: 3, tables: ['B3'], start: at('2026-10-01', 15), end: at('2026-10-01', 18) };
  const listed = await call('POST', 'games', game, 'gm');
  const gmBooking = (await call('GET', 'floor', null, 'staff')).data.bookings.find((b) => b.gameId === listed.data.game.id);
  assert.equal((await call('POST', `bookings/${gmBooking.id}/update`, { status: 'cancelled' }, 'gm')).status, 403);
  Date.now = () => at('2026-10-01', 16);
  assert.equal((await call('POST', `games/${listed.data.game.id}/update`, { status: 'cancelled' }, 'gm')).status, 403);
  assert.equal((await call('POST', `games/${listed.data.game.id}/update`, { status: 'cancelled' }, 'staff')).status, 200);
  assert.equal((await call('POST', `games/${listed.data.game.id}/update`, { status: 'open' }, 'staff')).status, 409);
});

test('the public sees what a hold is for, never the staff note', async () => {
  await call('POST', 'blocks', { tables: 'T15', start: at('2026-10-01', 18), end: at('2026-10-01', 20), label: 'Aroha Smith 021 555 0199', type: 'impromptu' }, 'staff');
  await call('POST', 'blocks', { tables: 'T16', start: at('2026-10-01', 18), end: at('2026-10-01', 20), label: 'Pokémon league', type: 'tournament' }, 'staff');
  const pub = (await call('GET', 'floor')).data.blocks.map((b) => b.label).sort();
  assert.deepEqual(pub, ['Reserved', 'Tournament']);
  const staff = (await call('GET', 'floor', null, 'staff')).data.blocks.map((b) => b.label).sort();
  assert.deepEqual(staff, ['Aroha Smith 021 555 0199', 'Pokémon league']);
});

test('the floor sends event holds the way the app checks them', async () => {
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [{ id: 'market', title: 'Bring and buy', start: at('2026-10-02', 18), end: at('2026-10-02', 21), tables: 'Side room 2' }]);
  const { eventHolds } = (await call('GET', 'floor')).data;
  assert.deepEqual(eventHolds.map((e) => [e.eventId, e.tables.join(',')]), [['market', 'B1,B2,B3,B4']]);
});

test('a payment that lands while staff are mid-update is kept (fresh read after waiting on Shopify)', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.createCheckout = async () => ({ draftOrderId: 'gid://shopify/DraftOrder/7', checkoutUrl: 'https://checkout.test/7' });
  lair.shopify.draftOrderOrderId = async () => 'gid://shopify/Order/70';
  const held = await call('POST', 'bookings', tableBooking({ pay: 'now' }));
  let release;
  const gate = new Promise((r) => { release = r; });
  let loads = 0;
  lair.shopify.loadLairData = async () => {
    loads += 1;
    if (loads === 1) await gate;
    return { rooms: FALLBACK, events: [], settingsText: null };
  };
  lair.rulesLoadedAt = 0;
  const checkIn = call('POST', `bookings/${held.data.booking.id}/update`, { status: 'seated' }, 'staff');
  await new Promise((r) => setTimeout(r, 0));
  lair.rulesLoadedAt = 0;
  await internal('orders-paid', { id: 70, admin_graphql_api_id: 'gid://shopify/Order/70', note_attributes: [{ name: '_booking', value: held.data.booking.ref }] });
  release();
  const done = await checkIn;
  assert.equal(done.data.booking.status, 'seated');
  assert.equal(done.data.booking.paid, true);
});

test('repeat floor requests are served from memory until something changes', async () => {
  let reads = 0;
  const real = lair.state.bind(lair);
  lair.state = (...args) => { reads += 1; return real(...args); };
  const window = `floor?from=${NOW}&to=${NOW + 24 * HOUR}`;
  await call('GET', window);
  await call('GET', window);
  await call('GET', window, null, 'staff');
  assert.equal(reads, 1);
  await call('POST', 'bookings', tableBooking());
  const before = reads;
  await call('GET', window);
  assert.equal(reads, before + 1);
});

test('when Shopify is down, rules come from the last good copy and are retried a minute later, not every request', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  let loads = 0;
  lair.shopify.loadLairData = async () => { loads += 1; throw new Error('Shopify down'); };
  lair.rulesLoadedAt = 0;
  await call('GET', 'floor');
  await call('GET', 'floor');
  assert.equal(loads, 1);
  Date.now = () => NOW + 61_000;
  await call('GET', 'floor');
  assert.equal(loads, 2);
  assert.equal(lair.rulesCache.rooms.length, 4);
});

test('a payment that lands as the hold runs out still counts, even if the checkout link was already removed', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.createCheckout = async () => ({ draftOrderId: 'gid://shopify/DraftOrder/8', checkoutUrl: 'https://checkout.test/8' });
  let lookups = 0;
  lair.shopify.draftOrderOrderId = async () => { lookups += 1; return null; };
  lair.shopify.deleteDraftIfOpen = async () => true;
  const held = await call('POST', 'bookings', tableBooking({ pay: 'now' }));
  Date.now = () => NOW + 31 * 60_000;
  await call('GET', 'floor');
  const web = { id: 81, admin_graphql_api_id: 'gid://shopify/Order/81', source_name: 'web', note_attributes: [{ name: '_booking', value: held.data.booking.ref }] };
  assert.deepEqual((await internal('orders-paid', web)).data.updated, []);
  assert.equal(lookups, 0);
  const late = { id: 80, admin_graphql_api_id: 'gid://shopify/Order/80', source_name: 'shopify_draft_order', note_attributes: [{ name: '_booking', value: held.data.booking.ref }] };
  assert.deepEqual((await internal('orders-paid', late)).data.updated, [held.data.booking.ref]);
  const saved = (await call('GET', 'floor', null, 'staff')).data.bookings.find((b) => b.ref === held.data.booking.ref);
  assert.equal(saved.paid, true);
  assert.equal(saved.status, 'confirmed');
});

test('Shopify helper: refreshes the token after ACCESS_DENIED, and never deletes a paid checkout', async () => {
  const { ShopifyAdmin } = await import('../src/shopify.js');
  const kv = new Map([['admin-token', { token: 'old', expires: Date.now() + 10 * HOUR, clientId: 'id' }]]);
  const storage = { get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) };
  const admin = new ShopifyAdmin({ SHOP: 'shop.test', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret' }, storage);
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'new', expires_in: 86399 }));
    const token = init.headers['X-Shopify-Access-Token'];
    const body = JSON.parse(init.body);
    seen.push([token, body.query.match(/(DraftOpen|draftOrderDelete|Hooks)/)?.[1]]);
    if (token === 'old') return new Response(JSON.stringify({ errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }] }));
    if (body.query.includes('DraftOpen')) return new Response(JSON.stringify({ data: { draftOrder: { id: body.variables.id, status: body.variables.id.endsWith('/1') ? 'COMPLETED' : 'OPEN' } } }));
    return new Response(JSON.stringify({ data: { draftOrderDelete: { deletedId: 'x', userErrors: [] }, webhookSubscriptions: { nodes: [] } } }));
  };
  try {
    assert.deepEqual(await admin.webhookUris(), []);
    assert.deepEqual(seen.map((s) => s[0]), ['old', 'new']);
    assert.equal(await admin.deleteDraftIfOpen('gid://shopify/DraftOrder/1'), false);
    assert.equal(await admin.deleteDraftIfOpen('gid://shopify/DraftOrder/2'), true);
    assert.equal(seen.filter((s) => s[1] === 'draftOrderDelete').length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('booking rules: the live theme wins once it has them, THEME_ID before that, and a deleted theme falls back', async () => {
  const { ShopifyAdmin } = await import('../src/shopify.js');
  const storage = { get: async () => null, put: async () => {}, delete: async () => {} };
  const admin = new ShopifyAdmin({ SHOP: 'shop.test', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret' }, storage);
  const withSettings = (id, name, current) => ({
    id: `gid://shopify/OnlineStoreTheme/${id}`, name, files: { nodes: [{ body: { content: `/* auto-generated */\n${JSON.stringify({ current })}` } }] },
  });
  const oldLive = withSettings(1, 'Old theme', { color: '#000' });
  const preview = withSettings(2, 'Dice Goblin 2.0', { lair_hours: 'Mon 16:00-24:00' });
  let query = '';
  const shopifyReturns = (main, previewTheme) => {
    admin.graphql = async (q) => {
      query = q;
      return { rooms: { nodes: [] }, events: { nodes: [] }, main: { nodes: main ? [main] : [] }, preview: previewTheme };
    };
  };

  shopifyReturns(oldLive, preview); // before publishing: THEME_ID's preview theme
  let data = await admin.loadLairData('2');
  assert.match(query, /OnlineStoreTheme\/2"/);
  assert.deepEqual(data.theme, { id: '2', name: 'Dice Goblin 2.0', live: false });
  assert.match(data.settingsText, /lair_hours/);

  shopifyReturns(withSettings(3, 'Dice Goblin 2.0 (GitHub)', { lair_hours: 'Mon 16:00-24:00' }), preview); // published copy wins
  data = await admin.loadLairData('2');
  assert.deepEqual(data.theme, { id: '3', name: 'Dice Goblin 2.0 (GitHub)', live: true });

  shopifyReturns(oldLive, null); // THEME_ID points at a deleted theme
  data = await admin.loadLairData('2');
  assert.equal(data.theme.id, '1');

  shopifyReturns(oldLive, undefined); // anything but a number is never put into the query
  await admin.loadLairData('2") { id } x: shop {');
  assert.doesNotMatch(query, /preview:/);
});

test('the fancy room is one table for up to 12, for groups of 4 or more, at $15 a person', async () => {
  const three = await call('POST', 'bookings', tableBooking({ tables: ['F1'], people: 3 }));
  assert.equal(three.status, 422);
  assert.match(three.data.error, /groups of 4 or more/);
  const twelve = await call('POST', 'bookings', tableBooking({ tables: ['F1'], people: 12, email: 'party@example.com' }));
  assert.equal(twelve.status, 200);
  assert.equal(twelve.data.booking.amount, 18000);
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['F1'], people: 13, start: at('2026-10-01', 18), end: at('2026-10-01', 19) }))).status, 422);
  const staffPair = await call('POST', 'bookings', tableBooking({ tables: ['F1'], people: 2, start: at('2026-10-01', 18), end: at('2026-10-01', 19) }), 'staff');
  assert.equal(staffPair.status, 200);
});

test('real opening hours: weekdays 4pm to midnight, Saturday 10am to midnight, Sunday 10am to 10pm', async () => {
  lair.rulesCache = rulesFromSettings({ lair_shop_tables: '' }, FALLBACK, []);
  const book = (day, from, to, table) => call('POST', 'bookings', tableBooking({ tables: [table], start: at(day, from), end: to === 24 ? time.at(day, 24 * 60) : at(day, to), email: `${table}@example.com` }));
  assert.equal((await book('2026-10-05', 15, 16, 'T1')).status, 422); // Monday 3pm: not open yet
  assert.equal((await book('2026-10-05', 16, 17, 'T2')).status, 200); // Monday 4pm
  assert.equal((await book('2026-10-05', 23, 24, 'T3')).status, 200); // Monday 11pm to midnight
  assert.equal((await book('2026-10-03', 10, 11, 'T4')).status, 200); // Saturday 10am
  assert.equal((await book('2026-10-04', 21, 22, 'T5')).status, 200); // Sunday 9pm to 10pm
  assert.equal((await book('2026-10-04', 22, 23, 'T6')).status, 422); // Sunday after 10pm
});

test('refunds: paid online and cancelled 24+ hours ahead is refunded; later, or a no-show, keeps the fee', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  let n = 0;
  lair.shopify.createCheckout = async () => { n += 1; return { draftOrderId: `gid://shopify/DraftOrder/9${n}`, checkoutUrl: 'https://checkout.test/9' }; };
  lair.shopify.draftOrderOrderId = async (id) => id.replace('DraftOrder', 'Order');
  lair.shopify.deleteDraftIfOpen = async () => false;
  const pay = async (over) => {
    const { data } = await call('POST', 'bookings', tableBooking({ pay: 'now', ...over }));
    const orderId = `gid://shopify/Order/9${n}`;
    await internal('orders-paid', { id: 1, admin_graphql_api_id: orderId, source_name: 'shopify_draft_order', note_attributes: [{ name: '_booking', value: data.booking.ref }] });
    return data.booking;
  };
  const early = await pay({ tables: ['T1'], start: at('2026-10-03', 14), end: at('2026-10-03', 16), email: 'early@example.com' });
  const late = await pay({ tables: ['T2'], start: at('2026-10-02', 12), end: at('2026-10-02', 13), email: 'late@example.com' });
  const noshow = await pay({ tables: ['T3'], start: at('2026-10-01', 15), end: at('2026-10-01', 16), email: 'noshow@example.com' });
  const a = await call('POST', `bookings/${early.id}/update`, { status: 'cancelled' }, 'staff');
  assert.equal(a.data.refund.due, true);
  assert.equal(a.data.refund.amount, 4000);
  assert.equal(a.data.refund.orderId, 'gid://shopify/Order/91');
  const b = await call('POST', `bookings/${late.id}/update`, { status: 'cancelled' }, 'staff');
  assert.equal(b.data.refund.due, false);
  const c = await call('POST', `bookings/${noshow.id}/update`, { status: 'noshow' }, 'staff');
  assert.equal(c.data.refund.due, false);
  assert.equal(c.data.refund.reason, 'no-show');
  const counter = await call('POST', 'bookings', tableBooking({ tables: ['T4'], email: 'counter@example.com' }));
  const d = await call('POST', `bookings/${counter.data.booking.id}/update`, { status: 'cancelled' }, 'staff');
  assert.equal(d.data.refund.due, false);
});

function fakeConfigDb(rows) {
  const status = new Map();
  return {
    status,
    rows,
    prepare(sql) {
      return {
        sql,
        all: async () => ({ results: Object.entries(rows).map(([key, value]) => ({ key, value })) }),
        bind: (...args) => ({ sql, args }),
      };
    },
    batch: async (statements) => { for (const st of statements) status.set(st.args[0], { value: st.args[1], at: st.args[2] }); return []; },
  };
}

test('config: keys come from the config database, Worker variables win, and the app picks up changes without a redeploy', async () => {
  const { withConfig, resetConfigCache } = await import('../src/config.js');
  resetConfigCache();
  const db = fakeConfigDb({ SHOPIFY_CLIENT_ID: 'from-db', SHOPIFY_CLIENT_SECRET: 'db-secret', THEME_ID: '42', NOT_ALLOWED: 'x' });
  const merged = await withConfig({ CONFIG: db, SHOP: 'shop.test', SHOPIFY_CLIENT_ID: 'from-env' });
  assert.equal(merged.SHOPIFY_CLIENT_ID, 'from-env');
  assert.equal(merged.SHOPIFY_CLIENT_SECRET, 'db-secret');
  assert.equal(merged.THEME_ID, '42');
  assert.equal(merged.NOT_ALLOWED, undefined);

  resetConfigCache();
  const fresh = new Lair(fakeCtx(), { CONFIG: db, SHOP: 'shop.test', CURRENCY: 'NZD' });
  assert.equal(fresh.shopify.configured, false);
  await fresh.useConfig();
  assert.equal(fresh.shopify.configured, true);
  assert.equal(fresh.shopify.clientSecret, 'db-secret');
  const before = fresh.shopify;
  await fresh.useConfig();
  assert.equal(fresh.shopify, before);
  resetConfigCache();
});

test('health check: the cron run records Shopify login, missing permissions and rooms in the status table', async () => {
  const { resetConfigCache } = await import('../src/config.js');
  resetConfigCache();
  const db = fakeConfigDb({ SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret' });
  const seen = [];
  const env = {
    CONFIG: db, SHOP: 'ep0qiq-rp.myshopify.com', PUBLIC_URL: 'https://lair.example.workers.dev',
    LAIR: { idFromName: () => 'id', get: () => ({ fetch: async (req) => { seen.push([new URL(req.url).pathname, req.headers.get('X-Lair-Internal'), await req.text()]); return new Response('{}'); } }) },
  };
  const waits = [];
  await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.deepEqual(seen, [['/internal/maintenance', '1', JSON.stringify({ webhookUrl: 'https://lair.example.workers.dev/webhooks/orders-paid' })]]);

  const probe = new Lair(fakeCtx(), { CONFIG: db, SHOP: 'shop.test', CURRENCY: 'NZD' });
  await probe.useConfig();
  probe.shopify.loadLairData = async () => ({
    rooms: FALLBACK, events: [], settingsText: JSON.stringify({ current: { lair_refund_hours: 24 } }), theme: { id: '42', name: 'Dice Goblin 2.0', live: false },
  });
  probe.shopify.appInfo = async () => ({ app: 'Dice Goblin Lair', shop: 'Dice Goblin', scopes: ['read_customers', 'read_metaobjects', 'read_themes', 'write_orders', 'write_draft_orders', 'write_store_credit_account_transactions'] });
  probe.shopify.webhookUris = async () => ['https://lair.example.workers.dev/webhooks/orders-paid'];
  const response = await probe.fetch(new Request('https://lair.example.workers.dev/internal/maintenance', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body: JSON.stringify({ webhookUrl: 'https://lair.example.workers.dev/webhooks/orders-paid' }),
  }));
  const result = await response.json();
  assert.equal(result.shopifyLogin, 'ok');
  assert.deepEqual(result.missingScopes, []);
  assert.equal(result.paymentWebhook.ok, true);
  await new Promise((r) => setTimeout(r, 10));
  const connection = JSON.parse(db.status.get('connection').value);
  assert.equal(connection.shopifyLogin, 'ok');
  const rules = JSON.parse(db.status.get('rules').value);
  assert.equal(rules.source, 'theme "Dice Goblin 2.0" (42, preview)');
  assert.ok(rules.rooms.some((r) => r.startsWith('Fancy room: 1 × 12 seats, $15, min 4 people')));
  assert.ok(rules.hours.includes('mon 16:00-24:00'));
  resetConfigCache();
});

test('the app\'s own address shows a plain status page instead of "Not found"', async () => {
  const { resetConfigCache } = await import('../src/config.js');
  resetConfigCache();
  const db = fakeConfigDb({});
  db.prepare = (sql) => ({
    all: async () => (/FROM status/.test(sql)
      ? { results: [{ key: 'connection', value: JSON.stringify({ shopifyLogin: 'ok', missingScopes: [], paymentWebhook: { ok: false }, checkedAt: '2026-10-02T00:30:00Z' }), at: '2026-10-02T00:30:00Z' }] }
      : { results: [] }),
  });
  const res = await worker.fetch(new Request('https://lair.example.workers.dev/'), { CONFIG: db, SHOP: 'ep0qiq-rp.myshopify.com' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Dice Goblin booking app/);
  assert.match(html, /class="ok"><span aria-hidden="true">✓<\/span>Connected to the Shopify store/);
  assert.match(html, /Payment notifications not set up yet/);
  assert.match(html, /Waiting for the store link/);
  resetConfigCache();
});

test('Worker: a proxy URL entered without /proxy still works, and only signed requests count as the store', async () => {
  Date.now = realNow;
  const { resetConfigCache } = await import('../src/config.js');
  resetConfigCache();
  const seen = [];
  const env = {
    SHOP: 'ep0qiq-rp.myshopify.com', SHOPIFY_CLIENT_SECRET: 'hush',
    LAIR: { idFromName: () => 'id', get: () => ({ fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response('{}'); } }) },
  };
  const base = { shop: env.SHOP, path_prefix: '/apps/lair', timestamp: String(Math.floor(Date.now() / 1000)), logged_in_customer_id: '' };
  const bare = await worker.fetch(new Request(await signedUrl('/floor', { ...base, from: '1' })), env);
  assert.equal(bare.status, 200);
  assert.equal(seen.at(-1), '/floor');
  const root = await worker.fetch(new Request(await signedUrl('/', base)), env);
  assert.equal(root.status, 200);
  assert.equal(seen.at(-1), '/');
  assert.doesNotMatch(root.headers.get('Content-Type') || '', /html/);
  const before = seen.length;
  const forged = await worker.fetch(new Request(`https://worker.test/floor?shop=${env.SHOP}&signature=abc&timestamp=1`), env);
  assert.equal(forged.status, 401);
  assert.equal((await worker.fetch(new Request('https://worker.test/floor'), env)).status, 404);
  const page = await worker.fetch(new Request('https://worker.test/'), env);
  assert.match(page.headers.get('Content-Type'), /text\/html/);
  assert.equal(seen.length, before);
  resetConfigCache();
});

test('status: a booking route marks the store link as working; any other address is recorded as a miss', async () => {
  const db = fakeConfigDb({});
  const probe = new Lair(fakeCtx(), { CONFIG: db, CURRENCY: 'NZD' });
  probe.person = async () => ({ customerId: null, staff: false, gm: false });
  const proxied = (path) => probe.fetch(new Request(`https://lair.test${path}?path_prefix=%2Fapps%2Flair&from=${NOW}&to=${NOW + 24 * HOUR}`, {
    headers: { 'X-Lair-Origin': 'https://lair.example.workers.dev', 'X-Lair-Customer': '' },
  }));
  assert.equal((await proxied('/lair/floor')).status, 404);
  assert.equal((await proxied('/floor')).status, 200);
  await new Promise((r) => setTimeout(r, 10));
  const proxy = JSON.parse(db.status.get('proxy').value);
  assert.equal(proxy.seen, true);
  assert.equal(proxy.prefix, '/apps/lair');
  assert.equal(JSON.parse(db.status.get('proxyMiss').value).path, '/lair/floor');
});

test('status page: explains a wrong proxy address, and names the store address once it works', async () => {
  const { resetConfigCache } = await import('../src/config.js');
  const page = async (statusRows) => {
    resetConfigCache();
    const db = fakeConfigDb({});
    db.prepare = (sql) => ({ all: async () => ({ results: /FROM status/.test(sql) ? statusRows : [] }) });
    const res = await worker.fetch(new Request('https://lair.example.workers.dev/'), { CONFIG: db, SHOP: 'ep0qiq-rp.myshopify.com', PUBLIC_URL: 'https://lair.example.workers.dev' });
    return res.text();
  };
  const connected = { key: 'connection', value: JSON.stringify({ shopifyLogin: 'ok', missingScopes: [], paymentWebhook: { ok: true }, checkedAt: '2026-10-02T05:00:00Z' }), at: '2026-10-02T05:00:00Z' };
  const missed = await page([connected, { key: 'proxyMiss', value: JSON.stringify({ path: '/lair/floor', prefix: '/apps/lair' }), at: '2026-10-02T05:01:00Z' }]);
  assert.match(missed, /at &quot;\/lair\/floor&quot; instead of a booking address/);
  assert.match(missed, /https:\/\/lair\.example\.workers\.dev\/proxy/);
  const waiting = await page([connected]);
  assert.match(waiting, /Settings → Apps → Dice Goblin Lair should list an app proxy/);
  const working = await page([connected, { key: 'proxy', value: JSON.stringify({ seen: true, prefix: '/apps/lair' }), at: '2026-10-02T05:02:00Z' }]);
  assert.match(working, /class="ok"><span aria-hidden="true">✓<\/span>The website has reached the app through dicegoblin\.nz\/apps\/lair/);
  assert.doesNotMatch(working, /should list an app proxy/);
  resetConfigCache();
});

test('emails: a Resend error lands in the status table, and /setup can send a test email to the staff inbox', async () => {
  const db = fakeConfigDb({});
  const probe = new Lair(fakeCtx(), { CONFIG: db, CURRENCY: 'NZD', RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', REPLY_TO: 'shop@dicegoblin.test', STAFF_EMAIL: 'shop@dicegoblin.test' });
  probe.shopify.loadLairData = async () => ({ rooms: FALLBACK, events: [], settingsText: null });
  const sent = [];
  let reply = { status: 403, body: { statusCode: 403, message: 'The dicegoblin.test domain is not verified.' } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
  try {
    const failed = await probe.mail({ to: 'sam@example.com', subject: 'Hi', text: 'Hello' });
    assert.deepEqual([failed.ok, failed.status, failed.message], [false, 403, 'The dicegoblin.test domain is not verified.']);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(JSON.parse(db.status.get('email').value).ok, false);

    reply = { status: 200, body: { id: 'email-1' } };
    const res = await probe.fetch(new Request('https://lair.test/internal/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body: JSON.stringify({ testEmail: true }),
    }));
    const result = await res.json();
    assert.deepEqual([result.emailTest.ok, result.emailTest.to], [true, 'shop@dicegoblin.test']);
    assert.equal(sent.at(-1).url, 'https://api.resend.com/emails');
    assert.deepEqual(sent.at(-1).body.to, ['shop@dicegoblin.test']);
    assert.equal(sent.at(-1).body.reply_to, 'shop@dicegoblin.test');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(JSON.parse(db.status.get('email').value).ok, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('status page: shows whether booking emails work once they are set up', async () => {
  const { resetConfigCache } = await import('../src/config.js');
  const page = async (statusRows) => {
    resetConfigCache();
    const db = fakeConfigDb({});
    db.prepare = (sql) => ({ all: async () => ({ results: /FROM status/.test(sql) ? statusRows : [] }) });
    return (await worker.fetch(new Request('https://lair.example.workers.dev/'), { CONFIG: db, SHOP: 'ep0qiq-rp.myshopify.com' })).text();
  };
  const connection = (email) => ({ key: 'connection', value: JSON.stringify({ shopifyLogin: 'ok', missingScopes: [], paymentWebhook: { ok: true }, email, checkedAt: '2026-10-02T05:00:00Z' }), at: 'x' });
  assert.doesNotMatch(await page([connection(false)]), /Booking (confirmation )?emails/);
  assert.match(await page([connection(true)]), /✓<\/span>Booking confirmation emails are on/);
  const failing = await page([connection(true), { key: 'email', value: JSON.stringify({ ok: false, status: 403, message: 'The domain is not verified.' }), at: 'x' }]);
  assert.match(failing, /Booking emails are failing: The domain is not verified\./);
  resetConfigCache();
});

/* ---------------- 3 Oct 2026: shop tables, check-in, events, GM series, prizes, My Lair ---------------- */

test('shop tables: T1-T3 are closed to the public unless a manager opens them', async () => {
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS }, FALLBACK, []);
  const closed = await call('POST', 'bookings', tableBooking({ tables: ['T2'] }));
  assert.equal(closed.status, 422);
  assert.match(closed.data.error, /shop table/);
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T2'], name: 'Manager game' }), 'staff')).status, 200);
  assert.equal((await call('POST', 'openings', { tables: 'T1-T3', start: at('2026-10-01', 18), end: at('2026-10-01', 22) })).status, 403);
  const opened = await call('POST', 'openings', { tables: 'T1-T3', start: at('2026-10-01', 18), end: at('2026-10-01', 22), note: 'Quiet night' }, 'staff');
  assert.equal(opened.status, 200);
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T3'], start: at('2026-10-01', 18), end: at('2026-10-01', 20) }))).status, 200);
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T1'], start: at('2026-10-01', 21), end: at('2026-10-01', 23), email: 'x@example.com' }))).status, 422);
  const floor = (await call('GET', 'floor')).data;
  assert.deepEqual(floor.shopTables, ['T1', 'T2', 'T3']);
  assert.equal(floor.openings.length, 1);
  assert.equal(floor.openings[0].note, undefined);
  assert.equal((await call('GET', 'floor', null, 'staff')).data.openings[0].note, 'Quiet night');
  assert.equal((await call('POST', `openings/${opened.data.opening.id}/delete`, {}, 'staff')).status, 200);
  assert.equal((await call('GET', 'floor')).data.openings.length, 0);
});

test('check-in: scanners send the code with or without its dash; not-today and repeat scans are flagged', async () => {
  const today = (await call('POST', 'bookings', tableBooking({ tables: ['T5'], start: at('2026-10-01', 15), end: at('2026-10-01', 17) }))).data.booking;
  const later = (await call('POST', 'bookings', tableBooking({ tables: ['T6'], start: at('2026-10-03', 15), end: at('2026-10-03', 17), email: 'later@example.com' }))).data.booking;
  assert.equal((await call('POST', 'checkin', { code: today.ref })).status, 403);
  const scanned = await call('POST', 'checkin', { code: `  ${today.ref.replace('-', '').toLowerCase()}\n` }, 'staff');
  assert.equal(scanned.status, 200);
  assert.equal(scanned.data.checkedIn, true);
  assert.equal(scanned.data.due, 4000);
  assert.match(scanned.data.message, /Checked in: Sam, 4 people at T5\. Charge \$40\.00\./);
  assert.equal(lair.booking(today.id).status, 'seated');
  const again = await call('POST', 'checkin', { code: today.ref }, 'staff');
  assert.equal(again.data.reason, 'already');
  const early = await call('POST', 'checkin', { code: later.ref }, 'staff');
  assert.deepEqual([early.data.checkedIn, early.data.reason], [false, 'not-today']);
  assert.match(early.data.message, /not today/);
  assert.equal((await call('POST', 'checkin', { code: later.ref, force: true }, 'staff')).data.checkedIn, true);
  assert.equal((await call('POST', 'checkin', { code: 'GOB-ZZZZZZ' }, 'staff')).status, 404);
  assert.equal((await call('POST', 'checkin', { code: 'hello' }, 'staff')).status, 404);
});

test('events: repeating dates (weekly, monthly nth weekday, skips, until) and sign-ups with spaces', async () => {
  const { eventOccurrences, findOccurrence } = await import('../src/core.js');
  const events = [
    { id: 'dnd-monday', title: 'Dungeons & Dragons', start: at('2026-10-05', 18), end: at('2026-10-05', 22), tables: '', repeat: 'weekly', skipDates: ['2026-10-26'], capacity: 6 },
    { id: 'market', title: 'Oddity Alley Market', start: at('2026-10-17', 11), end: at('2026-10-17', 15), tables: 'B1-B4', repeat: 'monthly', repeatUntil: '2026-12-31' },
    { id: 'launch', title: 'Launch party', start: at('2026-10-09', 18), end: at('2026-10-09', 21), tables: '' },
  ];
  const rules = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, events);
  const dates = eventOccurrences(rules, at('2026-10-01', 0), at('2027-02-01', 0));
  const monday = dates.filter((o) => o.eventId === 'dnd-monday').map((o) => o.id.split('@')[1]);
  assert.deepEqual(monday.slice(0, 5), ['2026-10-05', '2026-10-12', '2026-10-19', '2026-11-02', '2026-11-09']);
  assert.deepEqual(dates.filter((o) => o.eventId === 'market').map((o) => o.id.split('@')[1]), ['2026-10-17', '2026-11-21', '2026-12-19']);
  assert.equal(dates.filter((o) => o.eventId === 'launch').length, 1);
  // Daylight saving doesn't move the wall-clock time.
  assert.equal(time.minutesOf(findOccurrence(rules, 'dnd-monday@2026-11-02').start), 18 * 60);
  assert.equal(findOccurrence(rules, 'dnd-monday@2026-10-26'), null);

  lair.rulesCache = rules;
  // The market holds B1-B4 on its dates only.
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['B1'], start: at('2026-10-17', 12), end: at('2026-10-17', 13) }))).status, 409);
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['B1'], start: at('2026-10-10', 12), end: at('2026-10-10', 13), email: 'b@example.com' }))).status, 200);

  const join = (id, body) => call('POST', `events/${encodeURIComponent(id)}/join`, { name: 'Aroha', email: 'aroha@example.com', people: 2, ...body });
  const first = await join('dnd-monday@2026-10-05', {});
  assert.equal(first.status, 200);
  assert.equal(first.data.spacesLeft, 4);
  assert.match(first.data.join.ref, /^GOB-/);
  assert.equal((await join('dnd-monday@2026-10-05', { people: 5, email: 'big@example.com' })).status, 409);
  assert.equal((await join('dnd-monday@2026-10-05', { people: 4, email: 'four@example.com' })).data.spacesLeft, 0);
  assert.equal((await join('dnd-monday@2026-10-26', {})).status, 404);
  assert.equal((await join('launch@2026-10-09', {})).status, 422);
  const floor = (await call('GET', 'floor', null, 'staff')).data;
  assert.equal(floor.eventJoins['dnd-monday@2026-10-05'], 6);
  assert.equal(floor.joins.length, 2);
  assert.equal((await call('GET', 'floor')).data.joins, undefined);
  // The sign-up's code checks in at the counter on the day.
  Date.now = () => at('2026-10-05', 17, 30);
  const checked = await call('POST', 'checkin', { code: first.data.join.ref }, 'staff');
  assert.deepEqual([checked.data.kind, checked.data.checkedIn], ['join', true]);
  assert.equal((await call('POST', `events/joins/${first.data.join.id}/cancel`, {}, 'staff')).status, 200);
});

test('GM games: weekly series, GM fees, seat names, approval for a whole series, and cancelling it', async () => {
  const game = {
    title: 'Weekly Pathfinder', system: 'Pathfinder 2e', gm: 'Tui', blurb: 'A long campaign.', seats: 4, tables: ['A1', 'A2'],
    start: at('2026-10-01', 18), end: at('2026-10-01', 21), schedule: 'weekly', gmFee: 1000, gmBio: 'GMing since the 90s.', characters: 'bring',
  };
  // A booking already holds A1 on 15 October: that week is skipped.
  await call('POST', 'bookings', tableBooking({ tables: ['A1'], start: at('2026-10-15', 18), end: at('2026-10-15', 19), email: 'clash@example.com' }));
  const listed = await call('POST', 'games', game, 'gm');
  assert.equal(listed.status, 200, listed.data.error);
  assert.equal(listed.data.pending, true, 'a $10 GM fee needs a manager OK, even for a trusted GM');
  assert.equal(listed.data.game.seatPrice, 2000);
  assert.ok(listed.data.sessions.length >= 7);
  assert.equal(listed.data.skipped.length, 1);
  assert.equal(time.key(listed.data.skipped[0].start), '2026-10-15');
  const seriesId = listed.data.game.seriesId;
  assert.ok(seriesId);
  assert.equal((await call('GET', 'floor')).data.games.length, 0);
  const own = (await call('GET', 'floor', null, 'gm')).data.games;
  assert.ok(own.length >= 1 && own.every((g) => g.status === 'pending'));

  assert.equal((await call('POST', `games/${listed.data.game.id}/update`, { status: 'open' }, 'staff')).status, 200);
  const open = (await call('GET', 'floor')).data.games.filter((g) => g.seriesId === seriesId);
  assert.ok(open.length >= 7 && open.every((g) => g.status === 'open' && g.gmFeeApproved));
  assert.equal(open[0].gmBio, 'GMing since the 90s.');
  assert.equal(open[0].players, undefined);

  const seat = await call('POST', 'bookings', {
    kind: 'gm-seat', gameId: open[0].id, people: 2, name: 'Mia', email: 'mia@example.com', pay: 'day',
    players: [{ name: 'Mia', character: 'Valeros' }, { name: 'Leo', character: '' }],
  });
  assert.equal(seat.status, 200, seat.data.error);
  assert.equal(seat.data.booking.amount, 4000);
  assert.equal((await call('POST', 'bookings', { kind: 'gm-seat', gameId: open[0].id, people: 2, name: 'Kai', email: 'kai@example.com', players: [{ name: 'Kai' }, { name: '' }] })).status, 422);
  const gmView = (await call('GET', 'floor', null, 'gm')).data.games.find((g) => g.id === open[0].id);
  assert.deepEqual(gmView.players.map((p) => [p.name, p.character]), [['Mia', 'Valeros'], ['Leo', '']]);

  await call('POST', `bookings/${seat.data.booking.id}/update`, { paid: true }, 'staff');
  Date.now = () => at('2026-10-01', 21, 30);
  const credit = await call('POST', `games/${open[0].id}/credit`, {}, 'staff');
  assert.deepEqual([credit.data.players, credit.data.amount], [2, 2000]);

  const cancelled = await call('POST', `games/${open[1].id}/update`, { status: 'cancelled', scope: 'series' }, 'gm');
  assert.equal(cancelled.status, 200, cancelled.data.error);
  assert.equal((await call('GET', 'floor')).data.games.filter((g) => g.seriesId === seriesId && g.start > Date.now()).length, 0);
  assert.equal(lair.sql.exec('SELECT status FROM series WHERE id = ?', seriesId).one().status, 'cancelled');
});

test('GM games: $0 fee means players pay the table fee only; flexible games add dates; pictures and profiles', async () => {
  const free = await call('POST', 'games', {
    title: 'Free one-shot', system: 'Other', gm: 'Ana', blurb: 'On the house.', seats: 3, tables: ['F1'], start: at('2026-10-01', 18), end: at('2026-10-01', 21), gmFee: 0,
  }, 'gm');
  assert.equal(free.status, 200, free.data.error);
  assert.equal(free.data.game.status, 'open');
  assert.equal(free.data.game.seatPrice, 1500, 'the fancy room table fee only');
  assert.equal((await call('POST', 'games', { ...free.data.game, title: 'Bad fee', tables: ['B4'], gmFee: 700 }, 'gm')).status, 422);

  const flexible = await call('POST', 'games', {
    title: 'Flexible campaign', system: 'Daggerheart', gm: 'Ana', blurb: 'When we can.', seats: 3, tables: ['B1'], start: at('2026-10-01', 18), end: at('2026-10-01', 21), schedule: 'flexible',
  }, 'gm');
  assert.equal(flexible.data.sessions.length, 1);
  assert.equal((await call('POST', `games/${flexible.data.game.id}/sessions`, { start: at('2026-10-08', 18), end: at('2026-10-08', 21) }, 'player9')).status, 403);
  const added = await call('POST', `games/${flexible.data.game.id}/sessions`, { start: at('2026-10-08', 18), end: at('2026-10-08', 21) }, 'gm');
  assert.equal(added.status, 200, added.data.error);
  assert.equal(added.data.game.seriesId, flexible.data.game.seriesId);

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal((await call('POST', `games/${flexible.data.game.id}/image`, { dataUrl: png }, 'player9')).status, 403);
  assert.equal((await call('POST', `games/${flexible.data.game.id}/image`, { dataUrl: 'data:text/html;base64,PGI+' }, 'gm')).status, 422);
  const pic = await call('POST', `games/${flexible.data.game.id}/image`, { dataUrl: png }, 'gm');
  assert.equal(pic.status, 200, pic.data.error);
  const imageId = pic.data.image.split('/img/')[1];
  const served = await lair.fetch(new Request(`https://lair.test/internal/img/${imageId}`, { headers: { 'X-Lair-Internal': '1' } }));
  assert.equal(served.headers.get('Content-Type'), 'image/png');
  assert.equal((await served.arrayBuffer()).byteLength, 70);
  const sessions = (await call('GET', 'floor')).data.games.filter((g) => g.seriesId === flexible.data.game.seriesId);
  assert.ok(sessions.length === 2 && sessions.every((g) => g.image === pic.data.image));

  assert.equal((await call('POST', 'gm-profile', { name: 'Ana', bio: 'Rules-light and story-heavy.' })).status, 401);
  assert.equal((await call('POST', 'gm-profile', { name: 'Ana', bio: 'Rules-light and story-heavy.' }, 'gm')).status, 200);
  const me = (await call('GET', 'me', null, 'gm')).data;
  assert.equal(me.gmProfile.bio, 'Rules-light and story-heavy.');
  assert.ok(me.games.some((g) => g.gmBio === 'Rules-light and story-heavy.'));
  assert.equal((await call('GET', 'me')).status, 401);
});

test('My Lair: a customer sees their own bookings, seats and sign-ups', async () => {
  const mine = await call('POST', 'bookings', tableBooking({ tables: ['T7'] }), 'cust1');
  await call('POST', 'bookings', tableBooking({ tables: ['T8'], email: 'other@example.com' }), 'cust2');
  const me = (await call('GET', 'me', null, 'cust1')).data;
  assert.deepEqual(me.bookings.map((b) => b.ref), [mine.data.booking.ref]);
  assert.equal(me.customer.id, 'cust1');
  assert.deepEqual([me.seats, me.games, me.joins, me.credits].map((x) => x.length), [0, 0, 0, 0]);
});

test('host your own event: the form reaches the team by email, replies go to the person', async () => {
  const sent = [];
  lair.mail = async (message) => {
    sent.push(message);
    return { ok: true, attempted: true, status: 200 };
  };
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_x', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'shop@dicegoblin.test' };
  const form = { kind: 'host-event', name: 'Kiri', email: 'kiri@example.com', phone: '021 000', eventType: 'Tournament', when: 'Saturdays', people: '20', details: 'A monthly Lorcana tournament.' };
  assert.equal((await call('POST', 'contact', { ...form, details: 'Hi' })).status, 422);
  const ok = await lair.fetch(new Request('https://lair.test/contact', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': '', 'X-Lair-Client': '203.0.113.5' }, body: JSON.stringify(form) }));
  assert.equal(ok.status, 200);
  assert.equal(sent[0].to, 'shop@dicegoblin.test');
  assert.equal(sent[0].replyTo, 'kiri@example.com');
  assert.match(sent[0].text, /monthly Lorcana tournament/);
});

test('dice roller: one prize roll a day; natural 20 and natural 1 make one-use codes; no code means claim at the counter', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  const codes = [];
  lair.shopify.createPrizeCode = async (input) => {
    codes.push(input);
    return 'gid://shopify/DiscountCodeNode/1';
  };
  const rolls = [20, 1, 7];
  const realRandom = crypto.getRandomValues.bind(crypto);
  crypto.getRandomValues = (array) => {
    if (array instanceof Uint32Array && rolls.length) {
      array[0] = rolls.shift() - 1;
      return array;
    }
    return realRandom(array);
  };
  const roll = (client, customer = '') => lair.fetch(new Request('https://lair.test/roll', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, 'X-Lair-Client': client }, body: '{}' })).then((r) => r.json());
  try {
    const nat20 = await roll('203.0.113.7', 'cust1');
    assert.deepEqual([nat20.roll, nat20.prizeRoll, nat20.prize.kind, nat20.prize.percent], [20, true, 'percent', 5]);
    assert.match(nat20.prize.code, /^NAT20-/);
    assert.equal(codes[0].percent, 0.05);
    assert.equal(codes[0].customerId, 'cust1');
    assert.equal(codes[0].endsAt - NOW, 24 * HOUR);

    const nat1 = await roll('203.0.113.8');
    assert.deepEqual([nat1.roll, nat1.prize.kind, nat1.prize.variantId], [1, 'dice', '50363551023207']);
    assert.equal(codes[1].percent, 1);
    assert.equal(codes[1].minSubtotalCents, 501);

    const second = await roll('203.0.113.7', 'cust1');
    assert.deepEqual([second.roll, second.prizeRoll], [7, false]);
    assert.equal(second.prize.code, nat20.prize.code, 'today’s prize comes back on later rolls');
    assert.equal(codes.length, 2);

    lair.shopify.createPrizeCode = async () => {
      throw new Error('Access denied for discountCodeBasicCreate');
    };
    rolls.push(20);
    const noScope = await roll('203.0.113.9');
    assert.equal(noScope.prize.code, null);
    assert.match(noScope.message, /counter/);
  } finally {
    crypto.getRandomValues = realRandom;
  }
});

/* ---------------- 3 Oct 2026, round 3 ---------------- */

/** Turn on emails for `target` and catch everything sent to Resend (single and batch). Call restore() when done. */
function captureEmails(target = lair) {
  target.baseEnv = { ...target.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test' };
  const sent = [];
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(String(url));
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0], batch: Array.isArray(body) });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return { sent, calls, restore: () => { globalThis.fetch = realFetch; } };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

test('emails: one layout with a big title, a details table, a button and a footer, plus a plain-text copy', async () => {
  const { renderEmail, hoursSummary } = await import('../src/email.js');
  const { parseHours, DEFAULT_HOURS } = await import('../src/core.js');
  const hours = hoursSummary(parseHours(DEFAULT_HOURS));
  assert.equal(hours, 'Mon–Fri 4pm–midnight, Sat 10am–midnight, Sun 10am–10pm');
  assert.equal(hoursSummary(parseHours('Mon closed\nTue 12:00-22:30')), 'Mon closed, Tue midday–10:30pm, Wed–Sun closed');
  const { html, text } = renderEmail({
    title: "You're booked in!",
    intro: 'Kia ora <Sam>, see you soon.',
    details: [['When', 'Friday 2 October, 6:00 pm'], ['Setup', ''], ['Ticket', 'SAM-4821']],
    button: { label: 'See it in My Lair', url: 'https://www.dicegoblin.nz/pages/my-lair' },
    footer: { name: 'Dice Goblin Lair', address: '1 Goblin Lane, Auckland 1010', phone: '021 159 6894', hours },
  });
  assert.match(html, /<h1[^>]*>You&#39;re booked in!<\/h1>/);
  assert.match(html, />Dice Goblin<\/td>/);
  assert.match(html, /Kia ora &lt;Sam&gt;/);
  assert.match(html, /font:700[^"]*">When<\/td><td[^>]*>Friday 2 October/);
  assert.doesNotMatch(html, />Setup</, 'empty rows are left out');
  assert.match(html, /href="https:\/\/www\.dicegoblin\.nz\/pages\/my-lair"/);
  assert.match(html, /1 Goblin Lane, Auckland 1010<br>021 159 6894 · Mon–Fri 4pm–midnight/);
  assert.match(html, /name="viewport"/);
  assert.match(text, /^YOU'RE BOOKED IN!/);
  assert.match(text, /Ticket: +SAM-4821/);
  assert.match(text, /See it in My Lair: https:\/\/www\.dicegoblin\.nz\/pages\/my-lair/);
  assert.match(text, /Gobgob/);
  assert.match(text, /--\nDice Goblin Lair\n1 Goblin Lane/);
  const sneaky = renderEmail({ title: 'x', button: { label: 'Click', url: 'javascript:alert(1)' } });
  assert.doesNotMatch(sneaky.html, /javascript:/);
});

test('emails: a booking confirmation goes out as HTML and text, with the shop address, phone and hours', async () => {
  const mail = captureEmails();
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '', store_phone: '021 159 6894' }, FALLBACK, [], { address: '1 Goblin Lane, Auckland 1010' });
  try {
    const { data } = await call('POST', 'bookings', tableBooking());
    assert.equal(data.emailed, true);
    await settle();
    assert.equal(mail.sent.length, 1);
    const [email] = mail.sent;
    assert.equal(email.to, 'sam@example.com');
    assert.match(email.subject, new RegExp(data.booking.ref));
    assert.match(email.html, /You&#39;re booked in!/);
    assert.match(email.html, /1 Goblin Lane, Auckland 1010<br>021 159 6894 · Mon closed, Tue–Thu midday–10pm/);
    assert.match(email.text, /When: +Thursday,? 1 October/);
    assert.match(email.text, /Fee: +\$40\.00, pay at the counter/);
  } finally {
    mail.restore();
  }
});

test('emails: several at once go to Resend as one batch call', async () => {
  const { sendEmails } = await import('../src/shopify.js');
  const env = { RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', REPLY_TO: 'shop@dicegoblin.test' };
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), JSON.parse(init.body)]);
    return new Response('{}', { status: 200 });
  };
  try {
    const three = await sendEmails(env, [1, 2, 3].map((n) => ({ to: `p${n}@example.com`, subject: 'Hi', text: 'Hello', html: '<p>Hello</p>' })));
    assert.deepEqual([three.ok, three.sent], [true, 3]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'https://api.resend.com/emails/batch');
    assert.deepEqual(calls[0][1].map((m) => [m.to[0], m.html, m.reply_to]), [1, 2, 3].map((n) => [`p${n}@example.com`, '<p>Hello</p>', 'shop@dicegoblin.test']));
    const one = await sendEmails(env, [{ to: 'solo@example.com', subject: 'Hi', text: 'Hello' }]);
    assert.equal(one.sent, 1);
    assert.equal(calls[1][0], 'https://api.resend.com/emails');
    assert.equal((await sendEmails({}, [{ to: 'x@example.com' }])).attempted, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

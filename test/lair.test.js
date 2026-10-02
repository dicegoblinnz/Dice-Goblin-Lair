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
  // Paid orders are looked up for members' spend; tests that care replace this.
  lair.shopify.orderSpend = async () => null;
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
  assert.match(data.booking.ref, /^SA-[A-Z]{3,9}-([1-9]|1\d|20)$/);
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

test('an event\'s tables are soft reserves anyone can book; only an event that locks them blocks bookings (staff excepted)', async () => {
  const soft = await call('POST', 'bookings', tableBooking({ tables: ['T12'], start: at('2026-10-02', 18), end: at('2026-10-02', 20) }));
  assert.equal(soft.status, 200, 'Friday Night Magic reserves T11-T20, but it doesn\'t lock them');
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [
    { id: 'fnm', title: 'Friday Night Magic', start: at('2026-10-02', 18, 30), end: at('2026-10-02', 22), tables: 'T11-T20', lockTables: true },
  ]);
  const locked = await call('POST', 'bookings', tableBooking({ tables: ['T13'], start: at('2026-10-02', 18), end: at('2026-10-02', 20), email: 'b@example.com' }));
  assert.deepEqual([locked.status, locked.data.error], [409, 'Table T13 is already taken then. Pick another.']);
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T13'], start: at('2026-10-02', 18), end: at('2026-10-02', 20), email: 'c@example.com' }), 'staff')).status, 409, 'the public page holds staff to the rules');
  const override = await call('POST', 'bookings', tableBooking({ tables: ['T13'], start: at('2026-10-02', 18), end: at('2026-10-02', 20), staffOverride: true }), 'staff');
  assert.equal(override.status, 200, 'locked tables are blocked for everyone except staff');
  const fine = await call('POST', 'bookings', tableBooking({ tables: ['T2'], start: at('2026-10-02', 18), end: at('2026-10-02', 20), email: 'd@example.com' }));
  assert.equal(fine.status, 200);
});

test('tables, walk-ins and game seats are paid at the counter: pay is ignored and there\'s never a checkout', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  let checkouts = 0;
  lair.shopify.createCheckout = async () => { checkouts += 1; return { draftOrderId: 'gid://shopify/DraftOrder/1', checkoutUrl: 'https://checkout.test/1' }; };
  const table = await call('POST', 'bookings', tableBooking({ pay: 'now' }));
  assert.equal(table.status, 200);
  assert.deepEqual([table.data.booking.status, table.data.booking.pay, table.data.booking.payment, table.data.checkoutUrl, table.data.notice], ['confirmed', 'day', 'store', undefined, null]);
  const game = await call('POST', 'games', { title: 'Counter game', system: 'Other', gm: 'Ana', blurb: 'x', seats: 3, tables: ['A1'], start: at('2026-10-01', 18), end: at('2026-10-01', 21) }, 'gm');
  const seat = await call('POST', 'bookings', { kind: 'gm-seat', gameId: game.data.game.id, people: 1, name: 'Mia', email: 'mia@example.com', pay: 'now' }, 'mia');
  assert.deepEqual([seat.data.booking.status, seat.data.booking.pay, seat.data.checkoutUrl], ['confirmed', 'day', undefined]);
  const walkin = await call('POST', 'bookings', { kind: 'walkin', tables: ['T8'], start: NOW, end: NOW + HOUR, people: 2, pay: 'now' }, 'staff');
  assert.deepEqual([walkin.data.booking.status, walkin.data.booking.pay], ['seated', 'day']);
  assert.equal(checkouts, 0);
  // The old "let people pay online" theme setting doesn't matter any more; payOnline only says Shopify checkout works.
  lair.rulesCache = { ...lair.rulesCache, payOnline: false };
  assert.deepEqual((await call('GET', 'floor')).data.features, { email: false, payOnline: true });
});

/** An event whose game spots are paid online: checkouts, holds and the payment webhook are tested with these. */
const onlineNight = (over = {}) => ({
  id: 'online-night', title: 'Online night', start: at('2026-10-01', 15), end: at('2026-10-01', 17), tables: '', gameTables: 'T3, T4, T5, T6, T7',
  payment: 'online', ...over,
});
const useOnlineNight = (over = {}) => {
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [onlineNight(over)]);
};
/** A game spot at the online night (T3 first, then T4, …): 2 people at the $10 table fee */
const spot = (body = {}, who = '') => call('POST', 'events/online-night@2026-10-01/reserve', { name: 'Sam', email: 'sam@example.com', people: 2, ...body }, who);

test('orders/paid confirms a held booking; unpaid holds lapse after 30 minutes', async () => {
  useOnlineNight();
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.createCheckout = async () => ({ draftOrderId: 'gid://shopify/DraftOrder/1', checkoutUrl: 'https://checkout.test/1' });
  lair.shopify.deleteDraftOrder = async () => {};
  lair.shopify.draftOrderOrderId = async (id) => (id === 'gid://shopify/DraftOrder/1' ? 'gid://shopify/Order/9' : null);
  const first = await spot();
  assert.equal(first.data.checkoutUrl, 'https://checkout.test/1');
  assert.equal(first.data.booking.status, 'held');
  const paid = await internal('orders-paid', { id: 9, admin_graphql_api_id: 'gid://shopify/Order/9', note_attributes: [{ name: '_booking', value: first.data.booking.ref }] });
  assert.deepEqual(paid.data.updated, [first.data.booking.ref]);
  const staffView = await call('GET', 'floor', null, 'staff');
  const saved = staffView.data.bookings.find((b) => b.ref === first.data.booking.ref);
  assert.equal(saved.status, 'confirmed');
  assert.equal(saved.paid, true);

  const second = await spot({ email: 'second@example.com' });
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
  assert.equal((await call('POST', 'bookings', seat)).status, 401, 'joining a game needs a login');
  const s1 = await call('POST', 'bookings', seat, 'mia');
  assert.equal(s1.data.booking.amount, 3000);
  assert.equal((await call('POST', 'bookings', { ...seat, name: 'Leo', email: 'leo@example.com' }, 'leo')).status, 409);
  const s2 = await call('POST', 'bookings', { ...seat, people: 1, name: 'Leo', email: 'leo@example.com' }, 'leo');
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
  useOnlineNight();
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.createCheckout = async () => ({ draftOrderId: 'gid://shopify/DraftOrder/2', checkoutUrl: 'https://checkout.test/2' });
  lair.shopify.draftOrderOrderId = async (id) => (id === 'gid://shopify/DraftOrder/2' ? 'gid://shopify/Order/10' : null);
  const onTheDay = await call('POST', 'bookings', tableBooking({ tables: ['T9'] }));
  const online = await spot();
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
  useOnlineNight();
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  let n = 0;
  lair.shopify.createCheckout = async () => { n += 1; return { draftOrderId: `gid://shopify/DraftOrder/3${n}`, checkoutUrl: 'https://checkout.test/3' }; };
  lair.shopify.deleteDraftOrder = async () => {};
  lair.shopify.draftOrderOrderId = async (id) => ({ 'gid://shopify/DraftOrder/31': 'gid://shopify/Order/12', 'gid://shopify/DraftOrder/32': 'gid://shopify/Order/13' })[id] || null;
  const a = await spot();
  const b = await spot({ email: 'b@example.com' });
  assert.deepEqual([a.data.booking.tables, b.data.booking.tables], [['T3'], ['T4']]);
  Date.now = () => NOW + 31 * 60_000;
  await call('GET', 'floor');
  await call('POST', 'bookings', tableBooking({ tables: ['T4'], email: 'c@example.com' }));
  await internal('orders-paid', { id: 12, admin_graphql_api_id: 'gid://shopify/Order/12', note_attributes: [{ name: '_booking', value: a.data.booking.ref }] });
  await internal('orders-paid', { id: 13, admin_graphql_api_id: 'gid://shopify/Order/13', note_attributes: [{ name: '_booking', value: b.data.booking.ref }] });
  const all = (await call('GET', 'floor', null, 'staff')).data.bookings;
  assert.equal(all.find((x) => x.ref === a.data.booking.ref).status, 'confirmed');
  const late = all.find((x) => x.ref === b.data.booking.ref);
  assert.equal(late.status, 'cancelled');
  assert.equal(late.paid, true);
  assert.match(late.notes, /refund or reseat/);
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
  const seat = await call('POST', 'bookings', { kind: 'gm-seat', gameId: listed.data.game.id, people: 2, name: 'Mia', email: 'mia@example.com', pay: 'day' }, 'mia');
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
  const seat = await call('POST', 'bookings', { kind: 'gm-seat', gameId: listed.data.game.id, people: 2, name: 'Mia', email: 'mia@example.com', pay: 'day' }, 'mia');
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
  // Staff on the public page get the same rules; the staff page sends staffOverride.
  assert.equal((await call('POST', 'bookings', tableBooking({ people: 1, tables: ['T5', 'T6', 'T7'], name: 'Staff setup' }), 'staff')).status, 422);
  assert.equal((await call('POST', 'bookings', tableBooking({ people: 1, tables: ['T5', 'T6', 'T7'], name: 'Staff setup', staffOverride: true }), 'staff')).status, 200);
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
  const seat = await call('POST', 'bookings', { kind: 'gm-seat', gameId: listed.data.game.id, people: 2, name: 'Mia', email: 'mia@example.com', pay: 'day' }, 'mia');
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

test('GMs: no cancelling more than an hour after the start, no cancelling the table hold alone, no reopening cancelled games', async () => {
  const game = { title: 'Rules game', system: 'D&D 5e', gm: 'Ellie', blurb: 'x', seats: 3, tables: ['B3'], start: at('2026-10-01', 15), end: at('2026-10-01', 18) };
  const listed = await call('POST', 'games', game, 'gm');
  const gmBooking = (await call('GET', 'floor', null, 'staff')).data.bookings.find((b) => b.gameId === listed.data.game.id);
  assert.equal((await call('POST', `bookings/${gmBooking.id}/update`, { status: 'cancelled' }, 'gm')).status, 403);
  Date.now = () => at('2026-10-01', 16, 1);
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

test('the floor sends event holds the way the app checks them: soft unless the event locks its tables, game-spot tables always soft', async () => {
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [
    { id: 'market', title: 'Bring and buy', start: at('2026-10-02', 18), end: at('2026-10-02', 21), tables: 'Side room 2' },
    { id: 'tourney', title: 'Tournament', start: at('2026-10-03', 12), end: at('2026-10-03', 18), tables: 'T1-T4', lockTables: true, gameTables: 'T3+T4, T5+T6' },
  ]);
  const { eventHolds } = (await call('GET', 'floor')).data;
  assert.deepEqual(eventHolds.map((e) => [e.id, e.eventId, e.occurrenceId, e.tables.join(','), e.soft, e.title, e.label, e.type, e.spots || false]), [
    ['ev-market@2026-10-02', 'market', 'market@2026-10-02', 'B1,B2,B3,B4', true, 'Bring and buy', 'Bring and buy', 'event', false],
    ['ev-tourney@2026-10-03', 'tourney', 'tourney@2026-10-03', 'T1,T2,T3,T4', false, 'Tournament', 'Tournament', 'event', false],
    ['ev-tourney@2026-10-03-spots', 'tourney', 'tourney@2026-10-03', 'T5,T6', true, 'Tournament', 'Tournament', 'event', true],
  ]);
  assert.deepEqual([eventHolds[1].start, eventHolds[1].end], [at('2026-10-03', 12), at('2026-10-03', 18)]);
});

test('soft reserves: GMs and the public can book an event\'s soft tables; locked ones block games too, except games staff list', async () => {
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [
    { id: 'wh', title: 'Warhammer & other wargames', start: at('2026-10-01', 17), end: at('2026-10-01', 21), tables: 'T14', gameTables: 'T15+T16' },
    { id: 'paint', title: 'Painting tables', start: at('2026-10-01', 17), end: at('2026-10-01', 21), tables: 'A1-A2', lockTables: true },
  ]);
  const game = (tables, who = 'gm') => call('POST', 'games', { title: 'Soft game', system: 'Other', gm: 'Ana', blurb: 'x', seats: 3, tables, start: at('2026-10-01', 18), end: at('2026-10-01', 20) }, who);
  assert.equal((await game(['T14'])).status, 200, "a soft-reserved table");
  assert.equal((await game(['T15'])).status, 200, 'a game-spot table is soft too');
  assert.equal((await game(['A1'])).status, 409, 'a locked table');
  assert.equal((await game(['A2'], 'staff')).status, 200, 'staff can list a game on a locked table');
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T16'], start: at('2026-10-01', 18), end: at('2026-10-01', 19) }))).status, 200);
  // A staff move onto a locked table is fine; a walk-in too.
  const walkin = await call('POST', 'bookings', { kind: 'walkin', tables: ['A1'], start: at('2026-10-01', 17), end: at('2026-10-01', 19), people: 2 }, 'staff');
  assert.equal(walkin.status, 200, walkin.data.error);
});

test('a payment that lands while staff are mid-update is kept (fresh read after waiting on Shopify)', async () => {
  useOnlineNight();
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.createCheckout = async () => ({ draftOrderId: 'gid://shopify/DraftOrder/7', checkoutUrl: 'https://checkout.test/7' });
  lair.shopify.draftOrderOrderId = async () => 'gid://shopify/Order/70';
  const held = await spot();
  let release;
  const gate = new Promise((r) => { release = r; });
  let loads = 0;
  lair.shopify.loadLairData = async () => {
    loads += 1;
    if (loads === 1) await gate;
    return { rooms: FALLBACK, events: [onlineNight()], settingsText: null };
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
  useOnlineNight();
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.createCheckout = async () => ({ draftOrderId: 'gid://shopify/DraftOrder/8', checkoutUrl: 'https://checkout.test/8' });
  let lookups = 0;
  lair.shopify.draftOrderOrderId = async () => { lookups += 1; return null; };
  lair.shopify.deleteDraftIfOpen = async () => true;
  const held = await spot();
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
  const pair = tableBooking({ tables: ['F1'], people: 2, start: at('2026-10-01', 18), end: at('2026-10-01', 19) });
  assert.equal((await call('POST', 'bookings', pair, 'staff')).status, 422);
  const staffPair = await call('POST', 'bookings', { ...pair, staffOverride: true }, 'staff');
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

test('refunds: a table booking paid online before v4, cancelled 24+ hours ahead, is refunded; later, or a no-show, keeps the fee', async () => {
  lair.shopify.deleteDraftIfOpen = async () => false;
  let n = 0;
  // Tables are paid at the counter now; these are like the first release's bookings that were paid online.
  const pay = async (over) => {
    const { data } = await call('POST', 'bookings', tableBooking(over));
    n += 1;
    const row = lair.booking(data.booking.id);
    lair.saveBooking({ ...row, pay: 'now', paid: true, paidAmount: row.amount, orderId: `gid://shopify/Order/9${n}`, draftOrderId: `gid://shopify/DraftOrder/9${n}` }, NOW);
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
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T2'], name: 'Manager game' }), 'staff')).status, 422);
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T2'], name: 'Manager game', staffOverride: true }), 'staff')).status, 200);
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
    { id: 'market', title: 'Oddity Alley Market', start: at('2026-10-17', 11), end: at('2026-10-17', 15), tables: 'B1-B4', lockTables: true, repeat: 'monthly', repeatUntil: '2026-12-31' },
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
  // The market locks B1-B4 on its dates only.
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['B1'], start: at('2026-10-17', 12), end: at('2026-10-17', 13) }))).status, 409);
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['B1'], start: at('2026-10-10', 12), end: at('2026-10-10', 13), email: 'b@example.com' }))).status, 200);

  const join = (id, body) => call('POST', `events/${encodeURIComponent(id)}/join`, { name: 'Aroha', email: 'aroha@example.com', people: 2, ...body });
  const first = await join('dnd-monday@2026-10-05', {});
  assert.equal(first.status, 200);
  assert.equal(first.data.spacesLeft, 4);
  assert.match(first.data.join.ref, /^AR-[A-Z]{3,9}-\d{1,2}$/);
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
  const trusted = await call('POST', 'games', { ...game, title: 'Trusted $10 game', tables: ['B1'], schedule: 'one-shot' }, 'gm');
  assert.equal(trusted.data.pending, false, 'no GM fee needs a manager OK: a trusted GM goes straight on the board');
  assert.equal(trusted.data.game.gmFeeApproved, true);
  await call('POST', `games/${trusted.data.game.id}/update`, { status: 'cancelled' }, 'gm');
  const listed = await call('POST', 'games', game, 'tui');
  assert.equal(listed.status, 200, listed.data.error);
  assert.equal(listed.data.pending, true, 'a GM who is not tagged gm waits for a manager OK');
  assert.equal(listed.data.game.seatPrice, 2000);
  assert.ok(listed.data.sessions.length >= 7);
  assert.equal(listed.data.skipped.length, 1);
  assert.equal(time.key(listed.data.skipped[0].start), '2026-10-15');
  const seriesId = listed.data.game.seriesId;
  assert.ok(seriesId);
  assert.equal((await call('GET', 'floor')).data.games.length, 0);
  const own = (await call('GET', 'floor', null, 'tui')).data.games;
  assert.ok(own.length >= 1 && own.every((g) => g.status === 'pending'));

  assert.equal((await call('POST', `games/${listed.data.game.id}/update`, { status: 'open' }, 'staff')).status, 200);
  const open = (await call('GET', 'floor')).data.games.filter((g) => g.seriesId === seriesId);
  assert.ok(open.length >= 7 && open.every((g) => g.status === 'open' && g.gmFeeApproved));
  assert.equal(open[0].gmBio, 'GMing since the 90s.');
  assert.equal(open[0].players, undefined);

  const seat = await call('POST', 'bookings', {
    kind: 'gm-seat', gameId: open[0].id, people: 2, name: 'Mia', email: 'mia@example.com', pay: 'day',
    players: [{ name: 'Mia', character: 'Valeros' }, { name: 'Leo', character: '' }],
  }, 'mia');
  assert.equal(seat.status, 200, seat.data.error);
  assert.equal(seat.data.booking.amount, 4000);
  assert.equal((await call('POST', 'bookings', { kind: 'gm-seat', gameId: open[0].id, people: 2, name: 'Kai', email: 'kai@example.com', players: [{ name: 'Kai' }, { name: '' }] }, 'kai')).status, 422);
  const gmView = (await call('GET', 'floor', null, 'tui')).data.games.find((g) => g.id === open[0].id);
  assert.deepEqual(gmView.players.map((p) => [p.name, p.character]), [['Mia', 'Valeros'], ['Leo', '']]);

  await call('POST', `bookings/${seat.data.booking.id}/update`, { paid: true }, 'staff');
  Date.now = () => at('2026-10-01', 21, 30);
  const credit = await call('POST', `games/${open[0].id}/credit`, {}, 'staff');
  assert.deepEqual([credit.data.players, credit.data.amount], [2, 2000]);

  const cancelled = await call('POST', `games/${open[1].id}/update`, { status: 'cancelled', scope: 'series' }, 'tui');
  assert.equal(cancelled.status, 200, cancelled.data.error);
  assert.equal((await call('GET', 'floor')).data.games.filter((g) => g.seriesId === seriesId && g.start > Date.now()).length, 0);
  assert.equal(lair.sql.exec('SELECT status FROM series WHERE id = ?', seriesId).one().status, 'cancelled');
});

test('GM games: $0 fee means players pay the table fee only; flexible games add dates; pictures and profiles', async () => {
  const free = await call('POST', 'games', {
    title: 'Free one-shot', system: 'Other', gm: 'Ana', blurb: 'On the house.', seats: 4, tables: ['F1'], start: at('2026-10-01', 18), end: at('2026-10-01', 21), gmFee: 0,
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

/** The next d20 rolls, in order (the server rolls with crypto.getRandomValues). Call the result to put it back. */
function loadDice(rolls) {
  const realRandom = crypto.getRandomValues.bind(crypto);
  crypto.getRandomValues = (array) => {
    if (array instanceof Uint32Array && array.length === 1 && rolls.length) {
      array[0] = rolls.shift() - 1;
      return array;
    }
    return realRandom(array);
  };
  return () => {
    crypto.getRandomValues = realRandom;
  };
}
const roll = (body, customer = '', client = '203.0.113.7') => lair
  .fetch(new Request('https://lair.test/roll', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, 'X-Lair-Client': client }, body: JSON.stringify(body) }))
  .then(async (r) => ({ status: r.status, data: await r.json() }));

test('dice: a fun roll (no body, kind fun, or logged out) is just the roll, never a prize', async () => {
  const unload = loadDice([20, 1, 20]);
  try {
    assert.deepEqual((await roll({})).data, { roll: 20 });
    assert.deepEqual((await roll({ kind: 'fun' }, '1001')).data, { roll: 1 });
    assert.deepEqual((await roll({ kind: 'daily' })).data, { roll: 20 }, 'logged out: always fun');
  } finally {
    unload();
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
    details: [['When', 'Friday 2 October, 6:00 pm'], ['Setup', ''], ['Your code', 'SJ-OWLBEAR-17']],
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
  assert.match(text, /Your code: +SJ-OWLBEAR-17/);
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
    assert.match(email.text, /Pay at the counter when you arrive\. Show your code and we'll ring it up\./);
    assert.match(email.text, /Your code: +SA-[A-Z]{3,9}-\d{1,2}/);
    assert.doesNotMatch(email.text, /Splitting the bill/);
    await call('POST', 'bookings', tableBooking({ tables: ['T4'], split: true, email: 'split@example.com' }));
    await settle();
    assert.match(mail.sent.find((m) => m.to === 'split@example.com').text, /Splitting the bill\? Each friend can pay their share at the counter\./);
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

test('codes: initials, a word and a d20 roll (SJ-OWLBEAR-17); "Zoë van der Berg" is ZB, "Sam" is SA, no name is DG', async () => {
  const { initialsOf, makeCode, codeKey, codeKeys, legacyRefs, CODE_WORDS } = await import('../src/core.js');
  assert.deepEqual(
    ['Zoë van der Berg', 'Sam', '', null, '   ', 'J', '李雷', 'Tūī Ngata', "Siobhán O'Neill", 'Mary-Jane Smith', 'sam jones'].map(initialsOf),
    ['ZB', 'SA', 'DG', 'DG', 'DG', 'DG', 'DG', 'TN', 'SO', 'MS', 'SJ'],
  );
  assert.equal(CODE_WORDS.length, 261);
  assert.equal(new Set(CODE_WORDS).size, 261);
  for (let i = 0; i < 300; i += 1) assert.match(makeCode('Sam Jones'), /^SJ-[A-Z]{3,9}-([1-9]|1\d|20)$/, 'a d20 roll, no leading zero');
  for (let i = 0; i < 100; i += 1) assert.match(makeCode('Sam', { big: true }), /^SA-[A-Z]{3,9}-(2[1-9]|[3-9]\d)$/);
  for (const typed of ['sj owlbear 17', 'SJOWLBEAR17', 'Sj-Owlbear-17', ' sj.owlbear_17\n']) assert.equal(codeKey(typed), 'SJOWLBEAR17', typed);
  assert.deepEqual(codeKeys('TICKET: sj-owlbear-17'), ['TICKETSJOWLBEAR17', 'SJOWLBEAR17'], 'a code inside other scanner text');
  assert.deepEqual([legacyRefs('gob7k2qxm'), legacyRefs('GOB-7K2QXM'), legacyRefs('7k2qxm'), legacyRefs('SJ-OWLBEAR-17')], [['GOB-7K2QXM'], ['GOB-7K2QXM'], ['GOB-7K2QXM'], []]);

  const named = await call('POST', 'bookings', tableBooking({ name: 'Tūī Ngata', email: 'tui@example.com' }));
  assert.match(named.data.booking.ref, /^TN-[A-Z]{3,9}-\d{1,2}$/);
  const walkin = await call('POST', 'bookings', { kind: 'walkin', tables: ['T9'], start: NOW, end: NOW + HOUR, people: 2 }, 'staff');
  assert.match(walkin.data.booking.ref, /^DG-/, 'a walk-in with no name');
  const game = await call('POST', 'games', { title: 'Ref game', system: 'Other', gm: 'Rangi Parata', blurb: 'x', seats: 3, tables: ['A3'], start: at('2026-10-01', 18), end: at('2026-10-01', 21) }, 'gm');
  assert.match(lair.gameBookings(game.data.game.id)[0].ref, /^RP-/, "the GM's hold");
  const row = lair.sql.exec('SELECT * FROM codes WHERE key = ?', codeKey(named.data.booking.ref)).one();
  assert.deepEqual([row.code, row.kind, row.target_id], [named.data.booking.ref, 'booking', named.data.booking.id]);
});

test('codes are unique across bookings, sign-ups and members, with 21-99 once the d20 can\'t find one', async () => {
  const { uniqueCode } = await import('../src/core.js');
  // Every roll is GOBLIN; the number counts up, so the d20 goes 1, 2, ... 20, 1, 2, ...
  let n = 0;
  const counting = () => new Uint32Array([0, n++]);
  const taken = new Set(Array.from({ length: 19 }, (_, i) => `SAGOBLIN${i + 1}`));
  assert.equal(uniqueCode('Sam', (key) => taken.has(key), { random: counting }), 'SA-GOBLIN-20');
  taken.add('SAGOBLIN20');
  n = 0;
  assert.equal(uniqueCode('Sam', (key) => taken.has(key), { random: counting }), 'SA-GOBLIN-61', '40 tries with a d20, then 21 + 40 % 79');

  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [
    { id: 'quiz', title: 'Trivia night', start: at('2026-10-01', 18), end: at('2026-10-01', 20), tables: '', capacity: 20 },
  ]);
  // Every code the server makes is GOBLIN with a d20 of 1; the big numbers still vary.
  const realRandom = crypto.getRandomValues.bind(crypto);
  let calls = 0;
  crypto.getRandomValues = (array) => {
    if (array instanceof Uint32Array && array.length === 2) {
      array[0] = 0;
      array[1] = 20 * calls;
      calls += 1;
      return array;
    }
    return realRandom(array);
  };
  try {
    const first = await call('POST', 'bookings', tableBooking({ name: 'Sam' }));
    const second = await call('POST', 'events/quiz@2026-10-01/join', { name: 'Sally', email: 'sally@example.com', people: 1 });
    const third = await call('POST', 'bookings', tableBooking({ name: 'Sasha', tables: ['T4'], email: 'sasha@example.com' }), '1001');
    assert.equal(first.data.booking.ref, 'SA-GOBLIN-1');
    assert.match(second.data.join.ref, /^SA-GOBLIN-(2[1-9]|[3-9]\d)$/, 'a sign-up never gets a booking\'s code');
    const member = lair.memberRow('1001').code;
    const codes = [first.data.booking.ref, second.data.join.ref, third.data.booking.ref, member];
    assert.ok(codes.every((c) => /^SA-GOBLIN-\d+$/.test(c)));
    assert.equal(new Set(codes).size, 4, 'one table of codes: bookings, sign-ups and members never share one');
  } finally {
    crypto.getRandomValues = realRandom;
  }
});

test('check-in: codes in lower case, with spaces or no dashes; the first release\'s GOB codes; member codes list today\'s bookings', async () => {
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [
    { id: 'quiz', title: 'Trivia night', start: at('2026-10-01', 18), end: at('2026-10-01', 20), tables: '', capacity: 20 },
  ]);
  const mine = (await call('POST', 'bookings', tableBooking({ tables: ['T5'] }), '7250013')).data.booking;
  const quiz = (await call('POST', 'events/quiz@2026-10-01/join', { name: 'Sam', email: 'sam@example.com', people: 2 }, '7250013')).data.join;
  await call('POST', 'bookings', tableBooking({ tables: ['T6'], start: at('2026-10-02', 15), end: at('2026-10-02', 17) }), '7250013');
  await call('POST', 'bookings', tableBooking({ tables: ['T7'], email: 'other@example.com' }), '9999');

  const memberCode = lair.memberRow('7250013').code;
  assert.match(memberCode, /^SA-[A-Z]{3,9}-\d{1,2}$/, "the member's code comes from the name they first booked with");
  const card = await call('POST', 'checkin', { code: memberCode.toLowerCase().replace(/-/g, ' ') }, 'staff');
  assert.equal(card.status, 200, card.data.error);
  assert.deepEqual([card.data.kind, card.data.checkedIn, card.data.customer.id, card.data.member.code], ['member', false, '7250013', memberCode]);
  assert.deepEqual(card.data.bookings.map((x) => [x.kind, x.ref]), [['booking', mine.ref], ['join', quiz.ref]]);
  assert.equal(card.data.due, 4000);
  assert.match(card.data.message, /Sam has 2 bookings today/);
  assert.equal(lair.booking(mine.id).status, 'confirmed', 'a member code checks nothing in by itself');

  for (const typed of [mine.ref.replace(/-/g, '').toLowerCase(), ` ${mine.ref.toLowerCase().replace(/-/g, ' ')} `, mine.ref.replace(/-/g, '.')]) {
    const scanned = await call('POST', 'checkin', { code: typed }, 'staff');
    assert.deepEqual([scanned.data.kind, scanned.data.checkedIn, scanned.data.booking.ref], ['booking', true, mine.ref], typed);
  }
  const joined = await call('POST', 'checkin', { code: `ticket: ${quiz.ref.toLowerCase()}` }, 'staff');
  assert.deepEqual([joined.data.kind, joined.data.join.ref], ['join', quiz.ref], 'a code inside other scanner text');

  // A booking from the first release keeps its GOB-XXXXXX code, with or without the dash.
  const legacy = { ...lair.booking(mine.id), id: 'bk_legacy', ref: 'GOB-7K2QXM', tables: ['T8'], status: 'confirmed', arrivedAt: null, customerId: null };
  lair.saveBooking(legacy, NOW);
  const old = await call('POST', 'checkin', { code: 'gob7k2qxm' }, 'staff');
  assert.deepEqual([old.data.booking.ref, old.data.checkedIn], ['GOB-7K2QXM', true]);
  assert.equal((await call('POST', 'checkin', { code: 'GOB-7K2QXM' }, 'staff')).data.reason, 'already');
  for (const nope of ['DGC-7250013', 'SAM-4821', 'hello', 'ZZ-GOBLIN-99']) {
    const missing = await call('POST', 'checkin', { code: nope }, 'staff');
    assert.deepEqual([missing.status, missing.data.error], [404, 'No booking, member or pass with that code.'], nope);
  }
  await call('GET', 'me', null, '5555');
  const quiet = await call('POST', 'checkin', { code: lair.memberRow('5555').code }, 'staff');
  assert.deepEqual([quiet.status, quiet.data.bookings.length], [200, 0]);
  assert.match(quiet.data.message, /nothing booked today/);
  assert.match(lair.memberRow('5555').code, /^DG-/, 'opening My Lair first, with no name yet');
});

test('member codes: given once and kept when the member renames themselves; staff can issue a new one, and the old one stops working', async () => {
  await call('POST', 'bookings', tableBooking({ name: 'Zoë van der Berg', email: 'zoe@example.com' }), '1001');
  const first = lair.memberRow('1001').code;
  assert.match(first, /^ZB-/);
  await call('POST', 'me/profile', { name: 'Zoe Smith', firstName: 'Zoe' }, '1001');
  await call('POST', 'bookings', tableBooking({ tables: ['T4'], name: 'Somebody Else', email: 'zoe@example.com' }), '1001');
  assert.equal(lair.memberRow('1001').code, first, 'permanent');
  assert.equal((await call('GET', 'me', null, '1001')).data.member.code, first);
  assert.equal((await call('POST', 'members/1001/new-code', {}, '1001')).status, 403);
  assert.equal((await call('POST', 'members/4040/new-code', {}, 'staff')).status, 404);
  const fresh = await call('POST', 'members/1001/new-code', {}, 'staff');
  assert.equal(fresh.status, 200, fresh.data.error);
  assert.match(fresh.data.code, /^ZS-/, 'a new code follows their name now');
  assert.notEqual(fresh.data.code, first);
  assert.equal((await call('POST', 'checkin', { code: first }, 'staff')).status, 404, 'the old code is retired');
  assert.equal((await call('POST', 'checkin', { code: fresh.data.code }, 'staff')).data.member.customerId, '1001');
  const search = await call('GET', `members?q=${encodeURIComponent(fresh.data.code.toLowerCase().replace(/-/g, ' '))}`, null, 'staff');
  assert.deepEqual(search.data.map((m) => [m.customerId, m.code]), [['1001', fresh.data.code]]);
  assert.equal((await call('GET', `members?q=${fresh.data.code.split('-')[1].toLowerCase()}`, null, 'staff')).data[0].customerId, '1001', 'part of a code');
});

test('the public booking page applies the house rules to staff too; walk-ins can take several tables', async () => {
  const tooSoon = tableBooking({ start: at('2026-10-01', 13, 30), end: at('2026-10-01', 14, 30), name: 'Staff pal' });
  const refused = await call('POST', 'bookings', tooSoon, 'staff');
  assert.equal(refused.status, 422);
  assert.match(refused.data.error, /too soon/);
  assert.equal((await call('POST', 'bookings', { ...tooSoon, staffOverride: 'yes' }, 'staff')).status, 422, 'only a real true skips the rules');
  assert.equal((await call('POST', 'bookings', { ...tooSoon, staffOverride: true }, 'someone')).status, 422, 'customers cannot skip them');
  const overridden = await call('POST', 'bookings', { ...tooSoon, staffOverride: true }, 'staff');
  assert.equal(overridden.status, 200);
  assert.equal(lair.booking(overridden.data.booking.id).customerId, null, 'made for someone else, so not linked to the staff account');
  const own = await call('POST', 'bookings', tableBooking({ tables: ['T9'], name: 'Staff pal' }), 'staff');
  assert.equal(lair.booking(own.data.booking.id).customerId, 'staff', 'a staff member booking for themselves keeps it');

  const walkin = await call('POST', 'bookings', { kind: 'walkin', tables: ['T11', 'T12', 'T13'], start: NOW, end: NOW + 2 * HOUR, people: 9, name: 'Big group' }, 'staff');
  assert.equal(walkin.status, 200, walkin.data.error);
  assert.deepEqual(walkin.data.booking.tables, ['T11', 'T12', 'T13']);
  assert.equal(walkin.data.booking.status, 'seated');
});

test('GM games: seats count players only, and a seat booking takes 1 up to the seats left (max 8)', async () => {
  const game = (over) => call('POST', 'games', { title: 'Seat test', system: 'Other', gm: 'Ana', blurb: 'x', start: at('2026-10-01', 18), end: at('2026-10-01', 21), ...over }, 'gm');
  assert.equal((await game({ seats: 4, tables: ['B1'] })).status, 200, 'four players fit a four-seat table; the GM is not counted');
  const crowded = await game({ seats: 5, tables: ['B2'] });
  assert.equal(crowded.status, 422);
  const big = await game({ seats: 8, tables: ['B3', 'B4'] });
  assert.equal(big.status, 200, big.data.error);
  const seat = (people, who) => call('POST', 'bookings', {
    kind: 'gm-seat', gameId: big.data.game.id, people, name: who, email: `${who}@example.com`, players: Array.from({ length: people }, (_, i) => ({ name: `${who} ${i + 1}` })),
  }, who);
  assert.equal((await seat(9, 'nine')).status, 422);
  assert.equal((await seat(6, 'six')).status, 200);
  const over = await seat(3, 'three');
  assert.equal(over.status, 409);
  assert.match(over.data.error, /Only 2 seats left/);
  assert.equal((await seat(2, 'two')).status, 200);
});

test('GM cancelling: up to an hour after the start, or a whole series; every player is emailed and paid seats are flagged for a refund', async () => {
  const mail = captureEmails();
  try {
    const listed = await call('POST', 'games', {
      title: 'Cancel me', system: 'Other', gm: 'Ellie', email: 'ellie@example.com', blurb: 'x', seats: 4, tables: ['A1'],
      start: at('2026-10-01', 15), end: at('2026-10-01', 18), schedule: 'weekly',
    }, 'gm');
    const [first, second] = listed.data.sessions;
    const seat = (gameId, name) => call('POST', 'bookings', { kind: 'gm-seat', gameId, people: 1, name, email: `${name.toLowerCase()}@example.com`, pay: 'day' }, name.toLowerCase());
    const mia = (await seat(first.id, 'Mia')).data.booking;
    const leo = (await seat(first.id, 'Leo')).data.booking;
    await seat(second.id, 'Kai');
    await call('POST', `bookings/${mia.id}/update`, { paid: true }, 'staff');
    await settle();
    mail.sent.length = 0;

    Date.now = () => at('2026-10-01', 15, 45);
    const res = await call('POST', `games/${first.id}/update`, { status: 'cancelled', scope: 'series' }, 'gm');
    assert.equal(res.status, 200, res.data.error);
    assert.equal(res.data.affected, 3);
    assert.ok(lair.sql.exec('SELECT status FROM games WHERE series_id = ?', listed.data.game.seriesId).toArray().every((r) => r.status === 'cancelled'));
    assert.deepEqual([lair.booking(mia.id).refund, lair.booking(leo.id).refund], ['due', null]);
    assert.equal(lair.booking(mia.id).refundDue, undefined, 'one field, refund, everywhere');
    await settle();
    const players = mail.sent.filter((m) => m.batch);
    assert.deepEqual(players.map((m) => m.to).sort(), ['kai@example.com', 'leo@example.com', 'mia@example.com']);
    assert.match(players.find((m) => m.to === 'mia@example.com').text, /you'll get your money back/);
    assert.doesNotMatch(players.find((m) => m.to === 'leo@example.com').text, /money back/);
    const staff = mail.sent.find((m) => m.to === 'staff@dicegoblin.test');
    assert.match(staff.subject, /Refunds due: Cancel me/);
    assert.match(staff.text, new RegExp(`${mia.ref}: +Mia: \\$15\\.00`));
  } finally {
    mail.restore();
  }
});

test('a player dropping their own seat emails the GM, and paid cancellations ahead of the cut-off are flagged', async () => {
  const mail = captureEmails();
  try {
    const listed = await call('POST', 'games', { title: 'Drop test', system: 'Other', gm: 'Ellie', email: 'ellie@example.com', blurb: 'x', seats: 4, tables: ['A2'], start: at('2026-10-03', 18), end: at('2026-10-03', 21) }, 'gm');
    const seat = await call('POST', 'bookings', {
      kind: 'gm-seat', gameId: listed.data.game.id, people: 2, name: 'Mia', email: 'mia@example.com', pay: 'day', players: [{ name: 'Mia', character: 'Valeros' }, { name: 'Leo' }],
    }, 'mia');
    // As if Mia had paid online through the checkout.
    lair.saveBooking({ ...lair.booking(seat.data.booking.id), paid: true, paidAmount: seat.data.booking.amount, pay: 'now', orderId: 'gid://shopify/Order/55' }, NOW);
    await settle();
    mail.sent.length = 0;
    assert.equal((await call('POST', `bookings/${seat.data.booking.id}/update`, { status: 'cancelled' }, 'leo')).status, 403);
    const dropped = await call('POST', `bookings/${seat.data.booking.id}/update`, { status: 'cancelled' }, 'mia');
    assert.equal(dropped.status, 200, dropped.data.error);
    assert.equal(dropped.data.refund.due, true);
    assert.equal(lair.booking(seat.data.booking.id).refund, 'due');
    await settle();
    const gm = mail.sent.find((m) => m.to === 'ellie@example.com');
    assert.match(gm.subject, /Seat dropped: Drop test/);
    assert.match(gm.text, /Mia dropped their 2 seats/);
    assert.match(gm.text, /Seats taken: +0 of 4/);
    assert.ok(mail.sent.some((m) => m.to === 'staff@dicegoblin.test' && /Refund due/.test(m.subject)));
    const count = mail.sent.length;
    await call('POST', `bookings/${seat.data.booking.id}/update`, { status: 'cancelled' }, 'mia');
    await settle();
    assert.equal(mail.sent.length, count, 'cancelling again sends nothing');
  } finally {
    mail.restore();
  }
});

test('no-shows: an unpaid one is just recorded; a paid one gets a Refund? note; staff mark paid bookings refunded', async () => {
  const mail = captureEmails();
  try {
    const unpaid = (await call('POST', 'bookings', tableBooking({ tables: ['T5'] }))).data.booking;
    const paid = (await call('POST', 'bookings', tableBooking({ tables: ['T6'], email: 'paid@example.com' }))).data.booking;
    await call('POST', `bookings/${paid.id}/update`, { paid: true }, 'staff');
    await settle();
    mail.sent.length = 0;
    const a = await call('POST', `bookings/${unpaid.id}/update`, { status: 'noshow' }, 'staff');
    assert.deepEqual([a.data.booking.status, a.data.booking.refund, a.data.refund.ask, a.data.booking.amount], ['noshow', null, false, 4000]);
    assert.equal((await call('POST', `bookings/${unpaid.id}/update`, { refunded: true }, 'staff')).status, 422);
    const b = await call('POST', `bookings/${paid.id}/update`, { status: 'noshow' }, 'staff');
    assert.deepEqual([b.data.booking.refund, b.data.refund.ask, b.data.refund.due], ['ask', true, false]);
    assert.match(b.data.booking.notes, /\[Refund\?\]/);
    assert.equal((await call('POST', `bookings/${paid.id}/update`, { refunded: true }, 'someone')).status, 403);
    const c = await call('POST', `bookings/${paid.id}/update`, { refunded: true }, 'staff');
    assert.deepEqual([c.data.booking.refund, c.data.booking.refunded, c.data.booking.paid], ['done', undefined, true]);
    await settle();
    assert.equal(mail.sent.length, 0, 'no-shows send no email');
  } finally {
    mail.restore();
  }
});

test('members: remembered when they book, sign up or open My Lair; a booking only fills in blanks; the profile form sets them', async () => {
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [
    { id: 'quiz', title: 'Trivia night', start: at('2026-10-01', 18), end: at('2026-10-01', 20), tables: '', capacity: 20 },
  ]);
  await call('POST', 'bookings', tableBooking({ name: 'Sam Smith' }), '1001');
  await call('POST', 'bookings', tableBooking({ tables: ['T4'], name: 'Birthday crew', email: 'crew@example.com' }), '1001');
  await call('POST', 'events/quiz@2026-10-01/join', { name: 'Aroha Ngata', email: 'aroha@example.com', people: 1 }, '1002');
  await call('POST', 'bookings', { kind: 'walkin', tables: ['T9'], start: NOW, end: NOW + HOUR, people: 2, name: 'Walk-in pal' }, 'staff');
  const sam = lair.memberRow('1001');
  assert.deepEqual([sam.name, sam.first_name, sam.email], ['Sam Smith', 'Sam', 'sam@example.com']);
  assert.equal(lair.memberRow('1002').first_name, 'Aroha');
  assert.equal(lair.memberRow('staff'), null, 'a staff walk-in is for someone else');

  assert.equal((await call('POST', 'me/profile', { firstName: 'Sammy' })).status, 401);
  assert.equal((await call('POST', 'me/profile', { birthday: '13-01' }, '1001')).status, 422);
  assert.equal((await call('POST', 'me/profile', { birthday: '02-30' }, '1001')).status, 422);
  assert.equal((await call('POST', 'me/profile', { email: 'not an email' }, '1001')).status, 422);
  const saved = await call('POST', 'me/profile', { firstName: 'Sammy', name: 'Samantha Smith', email: 'sammy@example.com', birthday: '02-29' }, '1001');
  assert.equal(saved.status, 200, saved.data.error);
  const code = lair.memberRow('1001').code;
  assert.match(code, /^SS-/, 'the code from the name they first booked with');
  assert.deepEqual([saved.data.member.firstName, saved.data.member.birthday, saved.data.member.code], ['Sammy', '02-29', code]);
  const me = (await call('GET', 'me', null, '1001')).data;
  assert.deepEqual(me.member, { firstName: 'Sammy', name: 'Samantha Smith', email: 'sammy@example.com', birthday: '02-29', spendYear: 0, spendTotal: 0, code });
  assert.equal((await call('POST', 'me/profile', { birthday: '' }, '1001')).data.member.birthday, '');
  assert.equal(lair.memberRow('1001').first_name, 'Sammy', 'only the fields sent change');
  await call('GET', 'me', null, '1003');
  assert.ok(lair.memberRow('1003').last_seen, 'opening My Lair is enough to be a member');
});

test('GET /members?q= (staff): search by name, email, member code or customer ID, with spend over the last 12 months and all time', async () => {
  await call('POST', 'bookings', tableBooking({ name: 'Sam Smith' }), '1001');
  await call('POST', 'bookings', tableBooking({ tables: ['T4'], name: 'Aroha Ngata', email: 'aroha@example.com' }), '1002');
  lair.write('INSERT INTO spend (order_id, customer_id, amount, source, created_at) VALUES (?, ?, ?, ?, ?)', 'gid://shopify/Order/1', '1001', 5000, 'web', NOW - 10 * 24 * HOUR);
  lair.write('INSERT INTO spend (order_id, customer_id, amount, source, created_at) VALUES (?, ?, ?, ?, ?)', 'gid://shopify/Order/2', '1001', 3000, 'pos', NOW - 400 * 24 * HOUR);
  assert.equal((await call('GET', 'members?q=sam', null, '1001')).status, 403);
  const bySam = (await call('GET', 'members?q=SAM', null, 'staff')).data;
  assert.equal(bySam.length, 1);
  assert.deepEqual(
    (({ customerId, name, email, birthday, spendYear, spendTotal, rollsFromSpend }) => ({ customerId, name, email, birthday, spendYear, spendTotal, rollsFromSpend }))(bySam[0]),
    { customerId: '1001', name: 'Sam Smith', email: 'sam@example.com', birthday: '', spendYear: 5000, spendTotal: 8000, rollsFromSpend: 4 },
  );
  assert.equal(bySam[0].lastSeen, NOW);
  assert.deepEqual((await call('GET', 'members?q=aroha%40', null, 'staff')).data.map((m) => m.customerId), ['1002']);
  const code = lair.memberRow('1002').code;
  assert.deepEqual((await call('GET', `members?q=${encodeURIComponent(code.toLowerCase())}`, null, 'staff')).data.map((m) => [m.customerId, m.code]), [['1002', code]]);
  assert.deepEqual((await call('GET', 'members?q=1002', null, 'staff')).data.map((m) => m.customerId), ['1002']);
  assert.deepEqual((await call('GET', 'members?q=100%25', null, 'staff')).data, [], 'a % is searched for, not a wildcard');
  assert.equal((await call('GET', 'members', null, 'staff')).data.length, 2);
});

test('spend: every paid order with a customer adds its subtotal once, even when Shopify sends the webhook again', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  const orders = {
    'gid://shopify/Order/501': { customerId: '1001', amount: 4550, source: 'web' },
    'gid://shopify/Order/502': { customerId: null, amount: 9900, source: 'web' },
    'gid://shopify/Order/503': { customerId: '1001', amount: 2000, source: 'pos' },
  };
  const asked = [];
  lair.shopify.orderSpend = async (id) => {
    asked.push(id);
    return orders[id] || null;
  };
  const paid = (n, source = 'web') => internal('orders-paid', { id: n, admin_graphql_api_id: `gid://shopify/Order/${n}`, source_name: source, line_items: [] });
  assert.equal((await paid(501)).data.spend, 4550);
  assert.equal((await paid(501)).data.spend, 0, 'the same order again counts nothing');
  assert.equal((await paid(502)).data.spend, 0, 'no customer, no spend');
  assert.equal((await paid(503, 'pos')).data.spend, 2000);
  assert.deepEqual(asked, ['gid://shopify/Order/501', 'gid://shopify/Order/501', 'gid://shopify/Order/502', 'gid://shopify/Order/503']);
  assert.deepEqual(lair.spendOf('1001', NOW), { total: 6550, year: 6550 });

  lair.shopify.orderSpend = async () => {
    throw new Error('Shopify API: Access denied for order field. Required access: `read_orders` access scope.');
  };
  const denied = await paid(504);
  assert.equal(denied.status, 200, 'a missing permission is noted, not retried forever');
  lair.shopify.orderSpend = async () => {
    throw new Error('Shopify API error 503');
  };
  assert.equal((await paid(505)).status, 500, 'Shopify being down fails the webhook so Shopify sends it again');
});

test('POS: a counter order with a _booking line pays that booking as it is; an online order can\'t, and paying twice is flagged', async () => {
  useOnlineNight();
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.draftOrderOrderId = async () => 'gid://shopify/Order/700';
  lair.shopify.createCheckout = async () => ({ draftOrderId: 'gid://shopify/DraftOrder/70', checkoutUrl: 'https://checkout.test/70' });
  const mail = captureEmails();
  try {
    const counter = (await call('POST', 'bookings', tableBooking({ tables: ['T9'] }))).data.booking;
    const line = (ref) => ({ title: 'Table fee', quantity: 1, price: '40.00', properties: [{ name: '_booking', value: ref }] });
    await settle();
    mail.sent.length = 0;
    const web = await internal('orders-paid', { id: 601, admin_graphql_api_id: 'gid://shopify/Order/601', source_name: 'web', line_items: [line(counter.ref)] });
    assert.deepEqual(web.data.updated, []);
    const pos = await internal('orders-paid', { id: 602, admin_graphql_api_id: 'gid://shopify/Order/602', source_name: 'pos', line_items: [line(counter.ref.toLowerCase())] });
    assert.deepEqual(pos.data.updated, [counter.ref]);
    const saved = lair.booking(counter.id);
    assert.deepEqual([saved.paid, saved.pay, saved.status, saved.orderId], [true, 'day', 'confirmed', 'gid://shopify/Order/602']);
    await settle();
    assert.equal(mail.sent.length, 0, 'paying at the counter sends no second confirmation');

    const online = (await spot({ email: 'online@example.com' })).data.booking;
    await internal('orders-paid', { id: 700, admin_graphql_api_id: 'gid://shopify/Order/700', source_name: 'shopify_draft_order', note_attributes: [{ name: '_booking', value: online.ref }] });
    await internal('orders-paid', { id: 701, admin_graphql_api_id: 'gid://shopify/Order/701', source_name: 'pos', line_items: [line(online.ref)] });
    const twice = lair.booking(online.id);
    assert.equal(twice.orderId, 'gid://shopify/Order/700', 'the first payment is kept');
    assert.match(twice.notes, /Paid twice/);
    await settle();
    assert.ok(mail.sent.some((m) => m.to === 'staff@dicegoblin.test' && /Paid twice/.test(m.subject)));
  } finally {
    mail.restore();
  }
});

test('dice: the daily roll has retired (410); spend rolls need rolls earned (409); logged out or fun is just a roll', async () => {
  const unload = loadDice([7, 7]);
  try {
    const daily = await roll({ kind: 'daily' }, '1001');
    assert.deepEqual([daily.status, daily.data.error], [410, 'The daily roll has retired. Every $20 you spend earns a roll.']);
    const none = await roll({ kind: 'spend' }, '1001');
    assert.deepEqual([none.status, none.data.error], [409, 'No rolls yet, friend. Every $20 you spend earns one.']);
    assert.deepEqual((await roll({ kind: 'spend' })).data, { roll: 7 }, 'logged out: always fun');
    assert.deepEqual((await roll({}, '1001')).data, { roll: 7 });
    const me = (await call('GET', 'me', null, '1001')).data;
    assert.deepEqual([me.rolls, me.prizes], [{ available: 0, toNext: 2000, per: 2000, bonus: 0 }, []]);
  } finally {
    unload();
  }
});

test('dice: one roll per $20 spent, stacking; every face pays as the table says ($1 a "1", $2 for 11, $20 for a natural 20); two quick taps can\'t spend one roll twice', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  const credits = [];
  lair.shopify.creditCustomer = async (customerId, cents) => {
    await new Promise((r) => setTimeout(r, 5));
    credits.push([customerId, cents]);
  };
  lair.shopify.createPrizeCode = async () => assert.fail('the dice never make discount codes');
  const spend = (n, cents) => lair.write('INSERT INTO spend (order_id, customer_id, amount, source, created_at) VALUES (?, ?, ?, ?, ?)', `gid://shopify/Order/${n}`, '1001', cents, 'pos', NOW);
  spend(1, 20 * 2000 + 550);
  const faces = Array.from({ length: 20 }, (_, i) => i + 1);
  const pays = { 1: 100, 10: 100, 11: 200, 12: 100, 13: 100, 14: 100, 15: 100, 16: 100, 17: 100, 18: 100, 19: 100, 20: 2000 };
  const messages = { 100: 'A 1 on the face: $1 store credit.', 200: 'Two ones! $2 store credit, friend.', 2000: 'Natural 20! $20 store credit is yours.' };
  const unload = loadDice([...faces, 5, 5]);
  try {
    assert.deepEqual((await call('GET', 'me', null, '1001')).data.rolls, { available: 20, toNext: 1450, per: 2000, bonus: 20 });
    for (const face of faces) {
      const res = await roll({ kind: face % 2 ? 'spend' : 'bonus' }, '1001');
      assert.equal(res.status, 200, res.data.error);
      const amount = pays[face] || 0;
      assert.deepEqual([res.data.roll, res.data.kind, res.data.prize?.amount ?? 0], [face, 'spend', amount], `face ${face}`);
      if (amount) assert.deepEqual([res.data.prize.kind, res.data.prize.status, res.data.message], ['credit', 'added', messages[amount]], `face ${face}`);
      else assert.deepEqual([res.data.prize, res.data.message], [null, 'No ones this time. Spend $20 for another go.'], `face ${face}`);
      assert.deepEqual(res.data.rolls, { available: 20 - face, toNext: 1450, per: 2000, bonus: 20 - face });
    }
    assert.equal(credits.reduce((sum, [, cents]) => sum + cents, 0), 100 * 10 + 200 + 2000);
    const me = (await call('GET', 'me', null, '1001')).data;
    assert.equal(me.prizes.length, 10, 'the last 10');
    assert.deepEqual(me.prizes[0], { id: me.prizes[0].id, kind: 'credit', amount: 2000, status: 'added', roll: 20, at: NOW });
    assert.equal((await roll({ kind: 'spend' }, '1001')).status, 409);
    // One roll left and two taps at once (Shopify is slow): only one of them gets it.
    spend(2, 1450);
    const [a, b] = await Promise.all([roll({ kind: 'spend' }, '1001'), roll({ kind: 'spend' }, '1001')]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const member = (await call('GET', 'members?q=1001', null, 'staff')).data[0];
    assert.deepEqual([member.rollsFromSpend, member.rollsUsed, member.pendingPrizes], [21, 21, []]);
  } finally {
    unload();
  }
});

test('dice: when Shopify can\'t add the store credit, the prize is kept as pending to claim at the counter; staff see it and mark it done', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.creditCustomer = async () => {
    throw new Error('Shopify API error 502');
  };
  lair.write('INSERT INTO spend (order_id, customer_id, amount, source, created_at) VALUES (?, ?, ?, ?, ?)', 'gid://shopify/Order/1', '1001', 4000, 'pos', NOW);
  await call('POST', 'me/profile', { name: 'Aroha Smith' }, '1001');
  const mail = captureEmails();
  const unload = loadDice([11, 20]);
  try {
    const eleven = await roll({ kind: 'spend' }, '1001');
    assert.equal(eleven.status, 200, eleven.data.error);
    assert.deepEqual([eleven.data.prize.amount, eleven.data.prize.status, eleven.data.message], [200, 'pending', 'Two ones! $2 store credit, friend. Show this screen at the counter to claim it.']);
    const twenty = await roll({ kind: 'spend' }, '1001');
    assert.deepEqual([twenty.data.prize.amount, twenty.data.prize.status], [2000, 'pending']);
    assert.match(twenty.data.message, /^Natural 20! \$20 store credit is yours\. Show this screen at the counter to claim it\.$/);
    await settle();
    const alerts = mail.sent.filter((m) => m.to === 'staff@dicegoblin.test');
    assert.equal(alerts.length, 2);
    assert.match(alerts[0].text, /\$2\.00 store credit/);
    assert.match(alerts[1].subject, /Prize to give at the counter: Aroha Smith/);
    const found = (await call('GET', 'members?q=aroha', null, 'staff')).data[0];
    assert.deepEqual(found.pendingPrizes.map((p) => [p.kind, p.amount, p.status, p.roll]), [['credit', 2000, 'pending', 20], ['credit', 200, 'pending', 11]]);
    assert.equal((await call('POST', `prizes/${eleven.data.prize.id}/done`, {}, '1001')).status, 403);
    const done = await call('POST', `prizes/${eleven.data.prize.id}/done`, {}, 'staff');
    assert.deepEqual(done.data.prize, { id: eleven.data.prize.id, kind: 'credit', amount: 200, status: 'done', roll: 11, at: NOW });
    assert.equal((await call('POST', 'prizes/pz_nope/done', {}, 'staff')).status, 404);
    assert.deepEqual((await call('GET', 'members?q=aroha', null, 'staff')).data[0].pendingPrizes.map((p) => p.amount), [2000]);
    assert.deepEqual((await call('GET', 'me', null, '1001')).data.prizes.map((p) => p.status), ['pending', 'done']);
  } finally {
    unload();
    mail.restore();
  }
});

test('birthdays: once a day after 9am, members with a birthday in the next 7 days get a code tiered by spend; once a year; staff get a list', async () => {
  const { nextBirthday } = await import('../src/core.js');
  assert.equal(nextBirthday('02-29', '2026-10-01'), '2027-02-28');
  assert.equal(nextBirthday('02-29', '2027-10-01'), '2028-02-29');
  assert.equal(nextBirthday('01-03', '2026-12-30'), '2027-01-03');
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.appInfo = async () => ({ app: 'Dice Goblin Lair', shop: 'Dice Goblin', scopes: [] });
  lair.shopify.webhookUris = async () => ['https://lair.test/webhooks/orders-paid'];
  const codes = [];
  lair.shopify.createPrizeCode = async (input) => codes.push(input);
  const member = (id, name, email, birthday, spend) => {
    lair.write('INSERT INTO members (customer_id, name, first_name, email, birthday, last_seen) VALUES (?, ?, ?, ?, ?, ?)', id, name, name.split(' ')[0], email, birthday, NOW);
    if (spend) lair.write('INSERT INTO spend (order_id, customer_id, amount, source, created_at) VALUES (?, ?, ?, ?, ?)', `o-${id}`, id, spend, 'pos', NOW - 30 * 24 * HOUR);
  };
  member('2001', 'Ana Small', 'ana@example.com', '10-04', 5000); // in 3 days, $50 → 10%
  member('2002', 'Ben Middle', 'ben@example.com', '10-07', 25000); // in 6 days, $250 → 15%
  member('2003', 'Cat Later', 'cat@example.com', '10-11', 90000); // in 10 days: not yet
  member('2004', 'Dee Today', 'dee@example.com', '10-01', 60000); // today, $600 → 20%
  member('2005', 'Eru Noemail', null, '10-03', 0); // no email: the code still shows in My Lair
  const mail = captureEmails();
  try {
    Date.now = () => at('2026-10-01', 8, 50);
    assert.equal(await lair.birthdays(lair.rulesCache, Date.now()), null, 'nothing before 9am');
    Date.now = () => NOW;
    const run = await internal('maintenance', { webhookUrl: 'https://lair.test/webhooks/orders-paid' });
    assert.deepEqual(run.data.birthdays, { sent: 4, codes: 4 });
    assert.deepEqual(codes.map((c) => [c.customerId, c.percent]), [['2004', 0.2], ['2005', 0.1], ['2001', 0.1], ['2002', 0.15]]);
    assert.ok(codes.every((c) => /^BDAY-/.test(c.code) && c.endsAt === NOW + 14 * 24 * HOUR && !c.combinesWith.orderDiscounts && !c.combinesWith.productDiscounts));
    await settle();
    const toMembers = mail.sent.filter((m) => m.to !== 'staff@dicegoblin.test');
    assert.deepEqual(toMembers.map((m) => m.to).sort(), ['ana@example.com', 'ben@example.com', 'dee@example.com']);
    const ben = toMembers.find((m) => m.to === 'ben@example.com');
    assert.match(ben.subject, /Happy birthday, Ben!/);
    assert.match(ben.text, /15% off one order/);
    assert.match(ben.text, new RegExp(codes[3].code));
    const summary = mail.sent.find((m) => m.to === 'staff@dicegoblin.test');
    assert.match(summary.subject, /Birthday codes: 4 sent/);
    assert.match(summary.text, /Eru Noemail: +10% off, BDAY-.*No email/);
    // Birthday codes are emailed; My Lair's prizes list is the dice.
    assert.deepEqual((await call('GET', 'me', null, '2002')).data.prizes, []);
    assert.equal(lair.sql.exec("SELECT status FROM prizes WHERE customer_id = '2002' AND source = 'birthday'").one().status, 'added');

    // Later runs that day, the next day, or after editing a birthday: no second code.
    assert.equal(await lair.birthdays(lair.rulesCache, NOW + HOUR), null);
    await call('POST', 'me/profile', { birthday: '10-05' }, '2001');
    Date.now = () => NOW + 24 * HOUR;
    assert.deepEqual(await lair.birthdays(lair.rulesCache, Date.now()), { sent: 0 });
    assert.equal(codes.length, 4);
  } finally {
    mail.restore();
  }
});

test('GET /members/birthdays (staff): the next 30 days, soonest first, with spend and the code each gets', async () => {
  const member = (id, name, birthday, spend) => {
    lair.write('INSERT INTO members (customer_id, name, first_name, email, birthday, last_seen) VALUES (?, ?, ?, ?, ?, ?)', id, name, name, `${id}@example.com`, birthday, NOW);
    if (spend) lair.write('INSERT INTO spend (order_id, customer_id, amount, source, created_at) VALUES (?, ?, ?, ?, ?)', `o-${id}`, id, spend, 'web', NOW);
  };
  member('3001', 'Later', '10-25', 12000);
  member('3002', 'Soon', '10-02', 0);
  member('3003', 'Too far', '11-15', 0);
  member('3004', 'Nobody knows', null, 0);
  assert.equal((await call('GET', 'members/birthdays', null, '3001')).status, 403);
  const list = (await call('GET', 'members/birthdays', null, 'staff')).data;
  assert.deepEqual(list.map((m) => [m.customerId, m.date, m.days, m.percent, m.sent, m.spendYear]), [
    ['3002', '2026-10-02', 1, 10, false, 0],
    ['3001', '2026-10-25', 24, 15, false, 12000],
  ]);
});

test('join every session: a seat at each upcoming session with room, the series growing seats members, and leaving frees the seats', async () => {
  const mail = captureEmails();
  try {
    const listed = await call('POST', 'games', {
      title: 'Weekly Mothership', system: 'Mothership', gm: 'Ellie', email: 'ellie@example.com', blurb: 'Space horror.', seats: 3, tables: ['A1'],
      start: at('2026-10-01', 18), end: at('2026-10-01', 21), schedule: 'weekly',
    }, 'gm');
    const { sessions } = listed.data;
    const seriesId = listed.data.game.seriesId;
    assert.equal(sessions.length, 9);
    await call('POST', 'bookings', { kind: 'gm-seat', gameId: sessions[1].id, people: 2, name: 'Kai', email: 'kai@example.com', players: [{ name: 'Kai' }, { name: 'Tama' }] }, 'kai');
    const join = { people: 2, players: [{ name: 'Mia', character: 'Ripley' }, { name: 'Leo' }], name: 'Mia', email: 'mia@example.com' };
    assert.equal((await call('POST', `games/${sessions[0].id}/join-series`, join)).status, 401);
    assert.equal((await call('POST', `games/${sessions[0].id}/join-series`, { ...join, people: 4 }, 'mia')).status, 422, 'no more people than the game has seats');
    await settle();
    mail.sent.length = 0;

    const joined = await call('POST', `games/${sessions[0].id}/join-series`, join, 'mia');
    assert.equal(joined.status, 200, joined.data.error);
    assert.deepEqual(joined.data.member, { seriesId, people: 2, players: [{ name: 'Mia', character: 'Ripley' }, { name: 'Leo', character: '' }] });
    assert.equal(joined.data.booked.length, 8);
    assert.deepEqual(joined.data.full.map((x) => x.gameId), [sessions[1].id], 'the session with one seat left is full for two');
    const seat = lair.booking(joined.data.booked[0].ref);
    assert.deepEqual([seat.kind, seat.status, seat.pay, seat.paid, seat.amount, seat.seriesId, seat.customerId], ['gm-seat', 'confirmed', 'day', false, 3000, seriesId, 'mia']);
    await settle();
    assert.match(mail.sent.find((m) => m.to === 'mia@example.com').text, /every upcoming session of Weekly Mothership/);
    assert.equal((await call('POST', 'bookings', tableBooking({ email: 'mia@example.com' }), 'mia')).status, 200, 'series seats leave room under the per-email limit');
    const again = await call('POST', `games/${sessions[0].id}/join-series`, join, 'mia');
    assert.deepEqual(again.data.booked.map((x) => x.ref), joined.data.booked.map((x) => x.ref), 'joining again keeps the same seats');

    // A week on, the series grows by a session, and Mia has a seat at it.
    Date.now = () => NOW + 7 * 24 * HOUR;
    lair.seriesDay = null;
    lair.extendSeries(lair.rulesCache, Date.now());
    const newest = lair.sql.exec('SELECT id FROM games WHERE series_id = ? ORDER BY starts_at DESC LIMIT 1', seriesId).one().id;
    assert.ok(!sessions.some((x) => x.id === newest));
    assert.deepEqual(lair.gameBookings(newest).filter((b) => b.kind === 'gm-seat').map((b) => b.customerId), ['mia']);
    assert.deepEqual((await call('GET', 'me', null, 'mia')).data.series.map((x) => [x.seriesId, x.title, x.people]), [[seriesId, 'Weekly Mothership', 2]]);

    mail.sent.length = 0;
    assert.equal((await call('POST', `series/${seriesId}/leave`, {}, 'kai')).status, 404);
    const left = await call('POST', `series/${seriesId}/leave`, {}, 'mia');
    assert.equal(left.status, 200, left.data.error);
    assert.equal(left.data.cancelled, 8, 'every upcoming seat it made (the first session is in the past now)');
    assert.equal(lair.booking(joined.data.booked[0].ref).status, 'confirmed', 'past sessions are left alone');
    await settle();
    const gm = mail.sent.filter((m) => m.to === 'ellie@example.com');
    assert.equal(gm.length, 1);
    assert.match(gm[0].text, /Mia has stopped coming to every session/);
    assert.deepEqual((await call('GET', 'me', null, 'mia')).data.series, []);
    Date.now = () => NOW + 14 * 24 * HOUR;
    lair.seriesDay = null;
    lair.extendSeries(lair.rulesCache, Date.now());
    const latest = lair.sql.exec('SELECT id FROM games WHERE series_id = ? ORDER BY starts_at DESC LIMIT 1', seriesId).one().id;
    assert.equal(lair.gameBookings(latest).filter((b) => b.kind === 'gm-seat').length, 0, 'no seats once she has left');
  } finally {
    mail.restore();
  }
});

test('join every session: a date the GM adds seats members and tells them; skipping one session keeps the rest; one-offs have no series', async () => {
  const mail = captureEmails();
  try {
    const flexible = await call('POST', 'games', {
      title: 'Flexible Blades', system: 'Blades in the Dark', gm: 'Ellie', email: 'ellie@example.com', blurb: 'Heists.', seats: 4, tables: ['B1'],
      start: at('2026-10-02', 18), end: at('2026-10-02', 21), schedule: 'flexible',
    }, 'gm');
    const joined = await call('POST', `games/${flexible.data.game.id}/join-series`, { people: 1, name: 'Mia', email: 'mia@example.com' }, 'mia');
    assert.equal(joined.data.booked.length, 1);
    await settle();
    mail.sent.length = 0;
    const added = await call('POST', `games/${flexible.data.game.id}/sessions`, { start: at('2026-10-09', 18), end: at('2026-10-09', 21) }, 'gm');
    assert.equal(added.status, 200, added.data.error);
    const seats = lair.gameBookings(added.data.game.id).filter((b) => b.kind === 'gm-seat');
    assert.deepEqual(seats.map((b) => [b.customerId, b.party[0].name]), [['mia', 'Mia']]);
    await settle();
    assert.match(mail.sent.find((m) => m.to === 'mia@example.com').subject, /New session: Flexible Blades/);

    const skipped = await call('POST', `bookings/${seats[0].id}/update`, { status: 'cancelled' }, 'mia');
    assert.equal(skipped.status, 200, skipped.data.error);
    assert.equal(lair.booking(joined.data.booked[0].ref).status, 'confirmed', 'the other session stays booked');
    await settle();
    assert.ok(mail.sent.some((m) => m.to === 'ellie@example.com' && /Seat dropped/.test(m.subject)));

    const oneOff = await call('POST', 'games', { title: 'One-off', system: 'Other', gm: 'Ellie', blurb: 'x', seats: 3, tables: ['B2'], start: at('2026-10-02', 18), end: at('2026-10-02', 21) }, 'gm');
    assert.equal((await call('POST', `games/${oneOff.data.game.id}/join-series`, { people: 1, name: 'Mia', email: 'mia@example.com' }, 'mia')).status, 422);
  } finally {
    mail.restore();
  }
});

test('GM messages: a session\'s players or a whole series, replies to the GM, 5 a game a day (staff aren\'t limited)', async () => {
  const listed = await call('POST', 'games', {
    title: 'Weekly Mothership', system: 'Mothership', gm: 'Ellie', email: 'ellie@example.com', blurb: 'Space horror.', seats: 4, tables: ['A1'],
    start: at('2026-10-01', 18), end: at('2026-10-01', 21), schedule: 'weekly',
  }, 'gm');
  const [first, second] = listed.data.sessions;
  const msg = (gameId, body, who = 'gm') => call('POST', `games/${gameId}/message`, body, who);
  assert.equal((await msg(first.id, { text: 'Hi all' })).status, 503, 'needs email');
  const mail = captureEmails();
  try {
    await call('POST', 'bookings', { kind: 'gm-seat', gameId: first.id, people: 1, name: 'Kai', email: 'kai@example.com' }, 'kai');
    await call('POST', 'bookings', { kind: 'gm-seat', gameId: second.id, people: 1, name: 'Ana', email: 'ana@example.com' }, 'ana');
    await call('POST', `games/${first.id}/join-series`, { people: 1, name: 'Mia', email: 'mia@example.com' }, 'mia');
    await settle();
    mail.sent.length = 0;
    assert.equal((await msg(first.id, { text: 'Hi' }, 'kai')).status, 403);
    assert.equal((await msg(first.id, { text: '   ' })).status, 422);

    const session = await msg(first.id, { text: 'Bring a pencil!\nAnd snacks.', scope: 'session' });
    assert.deepEqual(session.data, { sent: 2 });
    assert.deepEqual(mail.sent.map((m) => m.to).sort(), ['kai@example.com', 'mia@example.com']);
    const toKai = mail.sent.find((m) => m.to === 'kai@example.com');
    assert.equal(toKai.reply_to, 'ellie@example.com');
    assert.match(toKai.subject, /Weekly Mothership: a message from Ellie/);
    assert.match(toKai.text, /> Bring a pencil!\n> And snacks\./);
    assert.match(toKai.html, /Bring a pencil!<br>And snacks\./);

    mail.sent.length = 0;
    const series = await msg(second.id, { text: 'No game on the 22nd.', scope: 'series' });
    assert.equal(series.data.sent, 3, 'Mia is a member and has seats, but gets one email');
    assert.deepEqual(mail.sent.map((m) => m.to).sort(), ['ana@example.com', 'kai@example.com', 'mia@example.com']);

    for (let i = 0; i < 3; i += 1) assert.equal((await msg(first.id, { text: `Note ${i}` })).status, 200);
    const sixth = await msg(second.id, { text: 'One more' });
    assert.equal(sixth.status, 429, 'five a day for the whole series');
    assert.equal((await msg(second.id, { text: 'From the team' }, 'staff')).status, 200);
    assert.match(mail.sent.at(-1).subject, /a message from the Lair team/);
    Date.now = () => NOW + 25 * HOUR;
    assert.equal((await msg(second.id, { text: 'Next day' })).status, 200);
  } finally {
    mail.restore();
  }
});

test('staff edit a game: details change for the series from this session on; time and tables move this session, its GM hold and seats, onto free tables', async () => {
  const listed = await call('POST', 'games', {
    title: 'Weekly Edit', system: 'Other', gm: 'Ellie', email: 'ellie@example.com', blurb: 'x', seats: 4, tables: ['A1'],
    start: at('2026-10-01', 18), end: at('2026-10-01', 21), schedule: 'weekly',
  }, 'gm');
  const [first, second] = listed.data.sessions;
  const mia = (await call('POST', 'bookings', { kind: 'gm-seat', gameId: first.id, people: 2, name: 'Mia', email: 'mia@example.com' }, 'mia')).data.booking;
  const leo = (await call('POST', 'bookings', { kind: 'gm-seat', gameId: first.id, people: 1, name: 'Leo', email: 'leo@example.com' }, 'leo')).data.booking;
  await call('POST', `bookings/${leo.id}/update`, { paid: true }, 'staff');
  await call('POST', 'bookings', tableBooking({ tables: ['A2'], start: at('2026-10-01', 19), end: at('2026-10-01', 20), email: 'a2@example.com' }));
  const edit = (body, who = 'staff') => call('POST', `games/${first.id}/edit`, body, who);
  assert.equal((await edit({ title: 'Mine now' }, 'gm')).status, 403);
  assert.equal((await edit({ tables: ['A2'] })).status, 409, 'A2 is taken at 7pm');
  const tooFew = await edit({ seats: 2 });
  assert.equal(tooFew.status, 409);
  assert.match(tooFew.data.error, /already has 3 players/);

  const mail = captureEmails();
  try {
    const moved = await edit({ title: 'Weekly Edit II', gmFee: 1000, seats: 6, start: at('2026-10-01', 19), end: at('2026-10-01', 22), tables: ['A3'] });
    assert.equal(moved.status, 200, moved.data.error);
    assert.equal(lair.gameBookings(second.id).find((b) => b.kind === 'gm').people, 7, "the GM's hold keeps up with the seats");
    assert.equal(lair.game(second.id).seats, 6);
    assert.equal(moved.data.sessions, listed.data.sessions.length);
    assert.deepEqual([moved.data.game.title, moved.data.game.tables, moved.data.game.start, moved.data.game.seatPrice], ['Weekly Edit II', ['A3'], at('2026-10-01', 19), 2000]);
    const held = lair.gameBookings(first.id).filter((b) => ACTIVE_STATUSES.includes(b.status));
    assert.ok(held.length === 3 && held.every((b) => b.tables[0] === 'A3' && b.start === at('2026-10-01', 19) && b.end === at('2026-10-01', 22)));
    assert.equal(lair.booking(mia.id).amount, 4000, 'unpaid seats follow the new price');
    assert.equal(lair.booking(leo.id).amount, 1500, 'paid seats keep what they paid');
    const later = lair.game(second.id);
    assert.deepEqual([later.title, later.seatPrice, later.tables, later.start], ['Weekly Edit II', 2000, ['A1'], second.start], 'later sessions take the details but not the move');
    assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['A1'], start: at('2026-10-01', 18), end: at('2026-10-01', 19), email: 'free@example.com' }))).status, 200, 'A1 is free again');
    await settle();
    const moves = mail.sent.filter((m) => /^New time: Weekly Edit II/.test(m.subject));
    assert.deepEqual(moves.map((m) => m.to).sort(), ['leo@example.com', 'mia@example.com']);
  } finally {
    mail.restore();
  }
  Date.now = () => NOW + 7 * 24 * HOUR;
  lair.seriesDay = null;
  lair.extendSeries(lair.rulesCache, Date.now());
  const newest = lair.sql.exec('SELECT title, gm_fee FROM games WHERE series_id = ? ORDER BY starts_at DESC LIMIT 1', listed.data.game.seriesId).one();
  assert.deepEqual([newest.title, newest.gm_fee], ['Weekly Edit II', 1000], 'new sessions of the series get the new details');
});
const ACTIVE_STATUSES = ['held', 'confirmed', 'seated'];

test('staff add players to a game: no payment, no rule but the seats left, linked to a member by email', async () => {
  await call('POST', 'me/profile', { name: 'Sam Smith', email: 'sam@example.com' }, '1001');
  const game = await call('POST', 'games', { title: 'Staff seats', system: 'Other', gm: 'Ellie', blurb: 'x', seats: 3, tables: ['B2'], start: at('2026-10-01', 15), end: at('2026-10-01', 18) }, 'gm');
  const add = (body, who = 'staff') => call('POST', `games/${game.data.game.id}/players`, body, who);
  assert.equal((await add({ name: 'Sam', people: 1 }, '1001')).status, 403);
  const sam = await add({ name: 'Sam', email: 'SAM@example.com', people: 2, players: [{ name: 'Sam', character: 'Dax' }, { name: 'Jo' }] });
  assert.equal(sam.status, 200, sam.data.error);
  assert.deepEqual([sam.data.booking.customerId, sam.data.booking.amount, sam.data.booking.paid, sam.data.booking.status], ['1001', 3000, false, 'confirmed']);
  assert.deepEqual(sam.data.booking.players.map((p) => p.name), ['Sam', 'Jo']);
  assert.equal((await add({ name: 'Two more', people: 2 })).status, 409);
  Date.now = () => at('2026-10-01', 16);
  const late = await add({ name: 'Walk-up', people: 1, customerId: '4004' });
  assert.equal(late.status, 200, 'staff can add someone after the start');
  assert.equal(late.data.booking.customerId, '4004');
  assert.equal(late.data.game.status, 'full');
});

test('staff list a game for a GM: gmEmail is matched to a member, gmCustomerId links directly, and an unknown GM gets a notice', async () => {
  await call('POST', 'me/profile', { name: 'Ellie GM', email: 'ellie@example.com' }, '2001');
  const base = { title: 'For a GM', system: 'Other', gm: 'Ellie', blurb: 'x', seats: 3, start: at('2026-10-01', 18), end: at('2026-10-01', 21) };
  const mail = captureEmails();
  try {
    const matched = await call('POST', 'games', { ...base, tables: ['B1'], gmEmail: 'ELLIE@example.com' }, 'staff');
    assert.equal(matched.status, 200, matched.data.error);
    const game = lair.game(matched.data.game.id);
    assert.deepEqual([game.gmCustomerId, game.gmEmail, game.status], ['2001', 'ELLIE@example.com', 'open']);
    assert.equal(matched.data.notice, undefined);
    await settle();
    const live = mail.sent.find((m) => m.to === 'ELLIE@example.com');
    assert.match(live.text, /listed and on the games board/);

    const unknown = await call('POST', 'games', { ...base, tables: ['B2'], gmEmail: 'new.gm@example.com' }, 'staff');
    assert.deepEqual([lair.game(unknown.data.game.id).gmCustomerId, lair.game(unknown.data.game.id).gmEmail], [null, 'new.gm@example.com']);
    assert.match(unknown.data.notice, /isn't linked to their account/);
    const byId = await call('POST', 'games', { ...base, tables: ['B3'], gmCustomerId: '3003' }, 'staff');
    assert.equal(lair.game(byId.data.game.id).gmCustomerId, '3003');
    const own = await call('POST', 'games', { ...base, tables: ['B4'] }, 'staff');
    assert.equal(lair.game(own.data.game.id).gmCustomerId, 'staff');
    const sneaky = await call('POST', 'games', { ...base, tables: ['A4'], gmEmail: 'ellie@example.com' }, 'gm');
    assert.equal(lair.game(sneaky.data.game.id).gmCustomerId, 'gm', 'only staff can list a game for someone else');
  } finally {
    mail.restore();
  }
});

const warhammer = (over = {}) => ({
  id: 'warhammer', title: 'Warhammer night', start: at('2026-10-03', 18), end: at('2026-10-03', 22), tables: 'T20', capacity: 10, entryFee: 2000,
  gameTables: 'T14+T15, T16+T17, T18+T19', ...over,
});

test('event entry fees: paid online (held for 30 minutes, confirmed by the webhook) or at the counter; no fee, nothing to pay', async () => {
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [
    warhammer({ payment: 'either' }), { id: 'quiz', title: 'Trivia night', start: at('2026-10-03', 18), end: at('2026-10-03', 20), tables: '', capacity: 20, payment: 'either' },
  ]);
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  let n = 0;
  const checkouts = [];
  lair.shopify.createCheckout = async (input) => {
    n += 1;
    checkouts.push(input);
    return { draftOrderId: `gid://shopify/DraftOrder/8${n}`, checkoutUrl: `https://checkout.test/8${n}` };
  };
  lair.shopify.draftOrderOrderId = async (id) => id.replace('DraftOrder', 'Order');
  lair.shopify.deleteDraftIfOpen = async () => true;
  const mail = captureEmails();
  try {
    const join = (body, who = '') => call('POST', 'events/warhammer@2026-10-03/join', { name: 'Aroha', email: 'aroha@example.com', people: 2, ...body }, who);
    const online = await join({ pay: 'now' }, '1001');
    assert.equal(online.status, 200, online.data.error);
    assert.deepEqual([online.data.join.status, online.data.join.amount, online.data.join.pay, online.data.checkoutUrl, online.data.spacesLeft], ['held', 4000, 'now', 'https://checkout.test/81', 8]);
    assert.deepEqual([checkouts[0].ref, checkouts[0].unitPrice, checkouts[0].quantity, checkouts[0].title], [online.data.join.ref, 2000, 2, 'Event entry: Warhammer night']);
    await settle();
    assert.equal(mail.sent.length, 0, 'no confirmation until it is paid');
    const paid = await internal('orders-paid', { id: 81, admin_graphql_api_id: 'gid://shopify/Order/81', source_name: 'shopify_draft_order', note_attributes: [{ name: '_booking', value: online.data.join.ref }] });
    assert.deepEqual(paid.data.updated, [online.data.join.ref]);
    const saved = lair.joinById(online.data.join.id);
    assert.deepEqual([saved.status, saved.paid, saved.orderId], ['confirmed', true, 'gid://shopify/Order/81']);
    await settle();
    const lockedIn = mail.sent.find((m) => m.to === 'aroha@example.com').text;
    assert.match(lockedIn, /^YOU'RE LOCKED IN!/);
    assert.match(lockedIn, /Entry: +\$40\.00, paid online\. Thank you!/);
    assert.match(lockedIn, /Your code: +[A-Z]{2}-[A-Z]{3,9}-\d{1,2}/);
    assert.match(lockedIn, /You paid online, so you're locked in\. Can't make it after all\? Cancel in My Lair and have a chat with us about a refund\./);

    const counter = await join({ pay: 'day', email: 'kai@example.com', name: 'Kai', people: 1 });
    assert.deepEqual([counter.data.join.status, counter.data.join.amount, counter.data.join.paid, counter.data.checkoutUrl], ['confirmed', 2000, false, undefined]);
    Date.now = () => at('2026-10-03', 17, 30);
    const checked = await call('POST', 'checkin', { code: counter.data.join.ref }, 'staff');
    assert.deepEqual([checked.data.due, checked.data.checkedIn], [2000, true]);
    assert.match(checked.data.message, /Charge \$20\.00/);
    const pos = await internal('orders-paid', { id: 90, admin_graphql_api_id: 'gid://shopify/Order/90', source_name: 'pos', line_items: [{ id: 9001, quantity: 1, price: '20.00', properties: [{ name: '_booking', value: counter.data.join.ref }] }] });
    assert.deepEqual(pos.data.updated, [counter.data.join.ref]);
    assert.equal(lair.joinById(counter.data.join.id).paid, true);
    Date.now = () => NOW;

    const free = await call('POST', 'events/quiz@2026-10-03/join', { name: 'Mia', email: 'mia@example.com', people: 2, pay: 'now' });
    assert.deepEqual([free.data.join.amount, free.data.join.status, free.data.checkoutUrl], [0, 'confirmed', undefined]);
    assert.equal(checkouts.length, 1, 'no fee, no checkout');

    const lapsing = await join({ pay: 'now', email: 'late@example.com', people: 3 });
    assert.equal(lapsing.data.spacesLeft, 4);
    Date.now = () => NOW + 31 * 60_000;
    await call('GET', 'floor');
    assert.equal(lair.joinById(lapsing.data.join.id).status, 'cancelled', 'an unpaid hold lapses after 30 minutes');
    assert.equal((await call('GET', 'floor')).data.eventJoins['warhammer@2026-10-03'], 3);

    // Paid online means locked in: cancelling frees the spaces, and staff decide on a refund.
    mail.sent.length = 0;
    const cancelled = await call('POST', `events/joins/${online.data.join.id}/cancel`, {}, '1001');
    assert.equal(cancelled.status, 200);
    assert.deepEqual([cancelled.data.refund.due, cancelled.data.refund.ask, cancelled.data.join.refund], [false, true, 'ask']);
    assert.equal(cancelled.data.notice, 'Your spot is cancelled. You paid online, so have a chat with us about a refund.');
    assert.equal(lair.joinById(online.data.join.id).refund, 'ask');
    assert.equal((await call('GET', 'floor')).data.eventJoins['warhammer@2026-10-03'], 1, 'the place is freed');
    await settle();
    assert.ok(mail.sent.some((m) => m.to === 'staff@dicegoblin.test' && /^Refund\?/.test(m.subject)), 'the refund alert asks staff to decide');
    // Staff cancelling (the event's off) means the money goes back: refund 'due'.
    const staffOff = await call('POST', `events/joins/${counter.data.join.id}/cancel`, {}, 'staff');
    assert.deepEqual([staffOff.data.refund.due, lair.joinById(counter.data.join.id).refund], [true, 'due'], 'paid at the counter, cancelled by staff');
    const marked = await call('POST', `bookings/${counter.data.join.id}/update`, { refunded: true }, 'staff');
    assert.deepEqual([marked.status, marked.data.join.refund], [200, 'done']);
  } finally {
    mail.restore();
  }
});

test('event game spots: the first free spot is booked as a wargame table for the event\'s time; eventSpots counts what anyone has taken', async () => {
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [
    warhammer(),
    { id: 'painting', title: 'Paint night', start: at('2026-10-02', 18), end: at('2026-10-02', 21), tables: 'T11-T12', capacity: 8 },
    { id: 'tourney', title: 'Tournament', start: at('2026-10-04', 12), end: at('2026-10-04', 18), tables: 'T1-T4', lockTables: true, gameTables: 'T1+T2, T3+T4' },
  ]);
  const reserve = (id, body = {}) => call('POST', `events/${id}/reserve`, { name: 'Sam Smith', email: 'sam@example.com', people: 2, pay: 'day', ...body });
  // Someone books T14 through the booking page: those tables stay bookable by anyone.
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T14'], start: at('2026-10-03', 18), end: at('2026-10-03', 19), email: 'walk@example.com' }))).status, 200);
  assert.deepEqual((await call('GET', 'floor')).data.eventSpots['warhammer@2026-10-03'], { total: 3, taken: 1 });

  assert.equal((await reserve('warhammer@2026-10-03', { people: 3 })).status, 422);
  const first = await reserve('warhammer@2026-10-03');
  assert.equal(first.status, 200, first.data.error);
  const booking = lair.booking(first.data.booking.id);
  // A spot costs the event's entry fee a person ($20 here), paid at the counter: the event is paid in store.
  assert.deepEqual(
    [booking.kind, booking.tables, booking.extras, booking.occurrenceId, booking.start, booking.end, booking.amount, booking.status, booking.pay, first.data.spotsLeft],
    ['table', ['T16', 'T17'], ['wargame'], 'warhammer@2026-10-03', at('2026-10-03', 18), at('2026-10-03', 22), 4000, 'confirmed', 'day', 1],
  );
  assert.match(booking.ref, /^SS-[A-Z]{3,9}-\d{1,2}$/);
  assert.deepEqual([first.data.booking.occurrenceId, first.data.booking.extras], ['warhammer@2026-10-03', ['wargame']]);
  const second = await reserve('warhammer@2026-10-03', { name: 'Kai', email: 'kai@example.com' });
  assert.deepEqual([second.data.booking.tables, second.data.spotsLeft], [['T18', 'T19'], 0]);
  const full = await reserve('warhammer@2026-10-03', { name: 'Leo', email: 'leo@example.com' });
  assert.equal(full.status, 409);
  assert.deepEqual((await call('GET', 'floor')).data.eventSpots['warhammer@2026-10-03'], { total: 3, taken: 3 });
  assert.equal((await reserve('painting@2026-10-02')).status, 422, 'no game tables, nothing to reserve');
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T20'], start: at('2026-10-03', 19), end: at('2026-10-03', 20), email: 'hold@example.com' }))).status, 200, 'tables reserved for the event stay bookable');
  const tourney = await reserve('tourney@2026-10-04', { name: 'Ana', email: 'ana@example.com' });
  assert.deepEqual(tourney.data.booking?.tables, ['T1', 'T2'], "an event's own table hold doesn't block its game spots");
  Date.now = () => at('2026-10-03', 17, 45);
  const checkedIn = await call('POST', 'checkin', { code: first.data.booking.ref }, 'staff');
  assert.deepEqual([checkedIn.data.kind, checkedIn.data.checkedIn, checkedIn.data.due], ['booking', true, 4000]);
});

test('event game spots: paying online goes through checkout, and the confirmation names the event', async () => {
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [warhammer({ payment: 'either' })]);
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.createCheckout = async (input) => ({ draftOrderId: 'gid://shopify/DraftOrder/95', checkoutUrl: `https://checkout.test/${input.ref}` });
  lair.shopify.draftOrderOrderId = async () => 'gid://shopify/Order/95';
  const mail = captureEmails();
  try {
    const res = await call('POST', 'events/warhammer@2026-10-03/reserve', { name: 'Sam', email: 'sam@example.com', people: 1, pay: 'now' }, '1001');
    assert.equal(res.status, 200, res.data.error);
    assert.equal(res.data.booking.status, 'held');
    assert.equal(res.data.checkoutUrl, `https://checkout.test/${res.data.booking.ref}`);
    assert.equal(res.data.spotsLeft, 2);
    await internal('orders-paid', { id: 95, admin_graphql_api_id: 'gid://shopify/Order/95', source_name: 'shopify_draft_order', note_attributes: [{ name: '_booking', value: res.data.booking.ref }] });
    await settle();
    const confirmation = mail.sent.find((m) => m.to === 'sam@example.com');
    assert.match(confirmation.subject, /Game spot booked: Warhammer night/);
    assert.match(confirmation.text, /Setup: +Wargame/);
    assert.deepEqual((await call('GET', 'me', null, '1001')).data.bookings.map((b) => b.ref), [res.data.booking.ref]);
  } finally {
    mail.restore();
  }
});

test('events say how they\'re paid: in store ignores pay, either lets people choose, online always checks out and is refused (503) when it can\'t', async () => {
  const event = (id, payment, over = {}) => ({
    id, title: `${id} night`, start: at('2026-10-03', 18), end: at('2026-10-03', 22), tables: '', capacity: 10, entryFee: 1500, payment, ...over,
  });
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [
    event('store', 'store', { gameTables: 'T14+T15' }), event('either', 'either', { gameTables: 'T16+T17' }),
    event('online', 'online', { gameTables: 'T18+T19, T5+T6' }), event('free', 'online', { entryFee: 0 }),
  ]);
  const DOWN = "Online payment isn't working right now. Call us and we'll hold you a spot.";
  const join = (id, body = {}) => call('POST', `events/${id}@2026-10-03/join`, { name: 'Aroha', email: 'aroha@example.com', people: 2, ...body }, '1001');
  const reserve = (id, body = {}) => call('POST', `events/${id}@2026-10-03/reserve`, { name: 'Aroha', email: 'aroha@example.com', people: 2, ...body }, '1001');

  // Shopify isn't connected: an online-only event is refused, "either" falls back to the counter.
  const offline = await join('online');
  assert.deepEqual([offline.status, offline.data.error], [503, DOWN]);
  assert.deepEqual([(await reserve('online')).status, (await reserve('online')).data.error], [503, DOWN]);
  const either = await join('either', { pay: 'now' });
  assert.deepEqual([either.data.join.status, either.data.join.pay, either.data.join.payment, either.data.checkoutUrl], ['confirmed', 'day', 'store', undefined]);
  assert.match(either.data.notice, /pay at the counter/);
  let floor = (await call('GET', 'floor')).data;
  assert.equal(floor.eventJoins['online@2026-10-03'], undefined, 'nothing is saved for a refused sign-up');
  assert.deepEqual(floor.eventSpots['online@2026-10-03'], { total: 2, taken: 0 });
  assert.equal(floor.features.payOnline, false, 'payOnline only says Shopify checkout works');

  Object.defineProperty(lair.shopify, 'configured', { value: true });
  let broken = false;
  let n = 0;
  lair.shopify.createCheckout = async ({ ref }) => {
    if (broken) throw new Error('Shopify is having a moment');
    n += 1;
    return { draftOrderId: `gid://shopify/DraftOrder/6${n}`, checkoutUrl: `https://checkout.test/${ref}` };
  };
  lair.shopify.deleteDraftIfOpen = async () => true;
  // In store: confirmed straight away, paid at the counter, whatever pay says. Spots too.
  const store = await join('store', { pay: 'now' });
  assert.deepEqual([store.data.join.status, store.data.join.pay, store.data.join.payment, store.data.join.amount, store.data.checkoutUrl], ['confirmed', 'day', 'store', 3000, undefined]);
  const storeSpot = await reserve('store', { pay: 'now' });
  assert.deepEqual([storeSpot.data.booking.status, storeSpot.data.booking.payment, storeSpot.data.booking.amount, storeSpot.data.checkoutUrl], ['confirmed', 'store', 3000, undefined]);
  // Either: at the counter unless they ask to pay now.
  const day = await join('either', { email: 'kai@example.com' });
  assert.deepEqual([day.data.join.status, day.data.join.payment, day.data.checkoutUrl], ['confirmed', 'store', undefined], "pay defaults to 'day'");
  const now = await join('either', { pay: 'now', email: 'mia@example.com' });
  assert.deepEqual([now.data.join.status, now.data.join.payment, now.data.holdMinutes, now.data.checkoutUrl], ['held', 'online', 30, `https://checkout.test/${now.data.join.ref}`]);
  // Online: always held with a checkout, whatever pay says. Game spots follow the event too.
  const online = await join('online', { pay: 'day', email: 'leo@example.com' });
  assert.deepEqual([online.data.join.status, online.data.join.pay, online.data.join.payment, online.data.checkoutUrl], ['held', 'now', 'online', `https://checkout.test/${online.data.join.ref}`]);
  const onlineSpot = await reserve('online', { pay: 'day', email: 'leo@example.com' });
  assert.deepEqual([onlineSpot.data.booking.status, onlineSpot.data.booking.amount, onlineSpot.data.checkoutUrl], ['held', 3000, `https://checkout.test/${onlineSpot.data.booking.ref}`]);

  // The checkout can't be made: online-only is refused and its place let go; either is confirmed for the counter.
  broken = true;
  const refused = await join('online', { email: 'zoe@example.com' });
  assert.deepEqual([refused.status, refused.data.error], [503, DOWN]);
  const refusedSpot = await reserve('online', { email: 'zoe@example.com' });
  assert.deepEqual([refusedSpot.status, refusedSpot.data.error], [503, DOWN]);
  floor = (await call('GET', 'floor')).data;
  assert.equal(floor.eventJoins['online@2026-10-03'], 2, "only Leo's held sign-up takes places");
  assert.deepEqual(floor.eventSpots['online@2026-10-03'], { total: 2, taken: 1 });
  assert.equal(floor.features.payOnline, true);
  const fallback = await join('either', { pay: 'now', email: 'ana@example.com' });
  assert.deepEqual([fallback.status, fallback.data.join.status, fallback.data.join.pay], [200, 'confirmed', 'day']);
  assert.match(fallback.data.notice, /pay at the counter/);
  // No entry fee: nothing to pay, whatever the event says.
  const free = await join('free', { email: 'free@example.com', pay: 'now' });
  assert.deepEqual([free.status, free.data.join.status, free.data.join.amount, free.data.join.payment, free.data.checkoutUrl], [200, 'confirmed', 0, 'store', undefined]);
});

test('Shopify: lair_event entry_fee and game_tables are read, and the store address for email footers', async () => {
  const { ShopifyAdmin } = await import('../src/shopify.js');
  const admin = new ShopifyAdmin({ SHOP: 'shop.test', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret' }, null);
  const field = (key, value) => ({ key, value });
  admin.graphql = async () => ({
    rooms: { nodes: [] },
    events: {
      nodes: [
        {
          handle: 'warhammer', capabilities: { publishable: { status: 'ACTIVE' } },
          fields: [
            field('title', 'Warhammer night'), field('starts_at', '2026-10-03T05:00:00Z'), field('entry_fee', '12.50'), field('game_tables', 'T14+T15, T16+T17'),
            field('tables', 'T20-T21'), field('payment', 'Online or in store'), field('lock_tables', 'true'),
          ],
        },
        { handle: 'league', capabilities: { publishable: { status: 'ACTIVE' } }, fields: [field('title', 'League'), field('starts_at', '2026-10-04T05:00:00Z'), field('payment', 'Online')] },
        { handle: 'paint', capabilities: { publishable: { status: 'ACTIVE' } }, fields: [field('title', 'Paint night'), field('starts_at', '2026-10-05T05:00:00Z'), field('payment', 'In store'), field('lock_tables', 'false')] },
        { handle: 'open', capabilities: { publishable: { status: 'ACTIVE' } }, fields: [field('title', 'Open play'), field('starts_at', '2026-10-06T05:00:00Z')] },
      ],
    },
    main: { nodes: [] },
    shop: { name: 'Dice Goblin', shopAddress: { address1: 'Shop 7', address2: '12 Goblin Lane', city: 'Auckland', zip: '1010' } },
  });
  const data = await admin.loadLairData();
  assert.deepEqual([data.events[0].entryFee, data.events[0].gameTables, data.events[0].tables], [1250, 'T14+T15, T16+T17', 'T20-T21']);
  // payment: "Online or in store" is either, "Online" is online, anything else (or empty) is paid in store.
  // lock_tables: only true locks the event's tables; empty is false.
  assert.deepEqual(data.events.map((e) => [e.id, e.payment, e.lockTables]), [['warhammer', 'either', true], ['league', 'online', false], ['paint', 'store', false], ['open', 'store', false]]);
  const { eventPayment } = await import('../src/core.js');
  assert.deepEqual(
    ['Online or in store', 'ONLINE OR IN STORE', ' Online ', 'online', 'In store', '', null, 'Online only please', 'either', 'store'].map(eventPayment),
    ['either', 'either', 'online', 'online', 'store', 'store', 'store', 'store', 'either', 'store'],
  );
  assert.deepEqual(data.shop, { name: 'Dice Goblin', address: 'Shop 7, 12 Goblin Lane, Auckland 1010' });
  const { parseSpots, buildRooms } = await import('../src/core.js');
  const rooms = buildRooms(FALLBACK, 1000);
  assert.deepEqual(parseSpots('T14+T15, t16 + t17; T99, T4+A1, T20', rooms), [['T14', 'T15'], ['T16', 'T17'], ['T20']], 'unknown tables and spots across rooms are dropped');
});

/** A POS session token like Shopify POS makes: a JWT signed HS256 with the app's client secret. */
async function posToken(claims, { secret = 'hush', alg = 'HS256' } = {}) {
  const { createHmac } = await import('node:crypto');
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const body = `${part({ alg, typ: 'JWT' })}.${part(claims)}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
const posClaims = (over = {}) => ({
  iss: 'https://ep0qiq-rp.myshopify.com/admin', dest: 'https://ep0qiq-rp.myshopify.com', aud: 'client-id', sub: '42',
  exp: Math.floor(NOW / 1000) + 60, nbf: Math.floor(NOW / 1000) - 5, iat: Math.floor(NOW / 1000) - 5, jti: 'x', ...over,
});

test('POS session tokens: HS256 with the client secret, aud is the client ID, dest is the shop, exp and nbf with 60 seconds of leeway', async () => {
  const { verifySessionToken } = await import('../src/shopify.js');
  const opts = { secret: 'hush', clientId: 'client-id', shop: 'ep0qiq-rp.myshopify.com', now: NOW };
  const check = async (claims, tokenOpts) => verifySessionToken(await posToken(claims, tokenOpts), opts);
  assert.equal((await check(posClaims())).sub, '42');
  assert.equal(await check(posClaims(), { secret: 'wrong' }), null);
  assert.equal(await check(posClaims({ aud: 'another-app' })), null);
  assert.equal(await check(posClaims({ dest: 'https://evil.myshopify.com' })), null);
  assert.ok(await check(posClaims({ exp: Math.floor(NOW / 1000) - 30 })), 'just expired is inside the leeway');
  assert.equal(await check(posClaims({ exp: Math.floor(NOW / 1000) - 90 })), null);
  assert.equal(await check(posClaims({ nbf: Math.floor(NOW / 1000) + 120 })), null);
  assert.equal(await check(posClaims({ exp: undefined })), null);
  assert.equal(await check(posClaims(), { alg: 'none' }), null);
  assert.equal(await verifySessionToken('not.a.token', opts), null);
  assert.equal(await verifySessionToken(await posToken(posClaims()), { ...opts, secret: '' }), null);
});

test('Worker: POS routes answer CORS preflights, need a valid POS session token, and go to the Lair as staff', async () => {
  Date.now = realNow;
  const { resetConfigCache } = await import('../src/config.js');
  resetConfigCache();
  const seen = [];
  const env = {
    SHOP: 'ep0qiq-rp.myshopify.com', SHOPIFY_CLIENT_SECRET: 'hush', SHOPIFY_CLIENT_ID: 'client-id',
    LAIR: { idFromName: () => 'id', get: () => ({ fetch: async (req) => { seen.push({ path: new URL(req.url).pathname, internal: req.headers.get('X-Lair-Internal'), user: req.headers.get('X-Lair-Pos-User'), body: await req.text() }); return new Response('{"found":true}'); } }) },
  };
  const now = Math.floor(Date.now() / 1000);
  const token = await posToken(posClaims({ exp: now + 60, nbf: now - 5 }));
  const preflight = await worker.fetch(new Request('https://worker.test/pos/checkin', { method: 'OPTIONS', headers: { Origin: 'https://extensions.shopifycdn.com', 'Access-Control-Request-Headers': 'authorization' } }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /GET, POST/);
  const anonymous = await worker.fetch(new Request('https://worker.test/pos/checkin', { method: 'POST', body: '{"code":"SAM-1234"}' }), env);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('Access-Control-Allow-Origin'), '*');
  const signedLikeProxy = await worker.fetch(new Request(await signedUrl('/pos/checkin', { shop: env.SHOP, timestamp: String(now), logged_in_customer_id: '' }), { method: 'POST', body: '{}' }), env);
  assert.equal(signedLikeProxy.status, 401, 'the app proxy signature is no way in');
  assert.equal(seen.length, 0);
  const ok = await worker.fetch(new Request('https://worker.test/pos/checkin', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{"code":"SAM-1234"}' }), env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), '*');
  assert.deepEqual(seen[0], { path: '/internal/pos/checkin', internal: '1', user: '42', body: '{"code":"SAM-1234"}' });
  await worker.fetch(new Request('https://worker.test/pos/member', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{"code":"DGC-1"}' }), env);
  assert.equal(seen[1].path, '/internal/pos/member');
  // Round 4: GET /pos/today, and POST for scan, checkin-member, share and a tab in the cart.
  const auth = { Authorization: `Bearer ${token}` };
  assert.equal((await worker.fetch(new Request('https://worker.test/pos/today', { headers: auth }), env)).status, 200);
  for (const route of ['scan', 'checkin-member', 'share', 'tab/tb_0123abcd/added']) {
    assert.equal((await worker.fetch(new Request(`https://worker.test/pos/${route}`, { method: 'POST', headers: auth, body: '{"x":1}' }), env)).status, 200, route);
  }
  assert.deepEqual(seen.slice(2).map((s) => [s.path, s.body, s.user]), [
    ['/internal/pos/today', '{}', '42'], ['/internal/pos/scan', '{"x":1}', '42'], ['/internal/pos/checkin-member', '{"x":1}', '42'],
    ['/internal/pos/share', '{"x":1}', '42'], ['/internal/pos/tab/tb_0123abcd/added', '{"x":1}', '42'],
  ]);
  assert.equal((await worker.fetch(new Request('https://worker.test/pos/today'), env)).status, 401, 'today needs the token too');
  assert.equal((await worker.fetch(new Request('https://worker.test/pos/today', { method: 'POST', headers: auth }), env)).status, 404, 'today is a GET');
  assert.equal((await worker.fetch(new Request('https://worker.test/pos/tab/../../internal/setup/added', { method: 'POST', headers: auth }), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://worker.test/pos/other', { method: 'POST', headers: auth }), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://worker.test/pos/checkin', { headers: auth }), env)).status, 404);
  resetConfigCache();
});

test('POS check-in: the fee still to pay as cart lines with the ticket code, the customer to attach, and member cards', async () => {
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [
    { id: 'quiz', title: 'Trivia night', start: at('2026-10-01', 18), end: at('2026-10-01', 20), tables: '', capacity: 20, entryFee: 500 },
  ]);
  const pos = (path, body) => lair.fetch(new Request(`https://lair.test/internal/pos/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body: JSON.stringify(body) })).then(async (r) => ({ status: r.status, data: await r.json() }));
  const table = (await call('POST', 'bookings', tableBooking({ tables: ['T5'] }), '1001')).data.booking;
  const quiz = (await call('POST', 'events/quiz@2026-10-01/join', { name: 'Sam', email: 'sam@example.com', people: 2 }, '1001')).data.join;
  const later = (await call('POST', 'bookings', tableBooking({ tables: ['T6'], start: at('2026-10-02', 15), end: at('2026-10-02', 16), email: 'later@example.com' }))).data.booking;

  const one = await pos('checkin', { code: table.ref.replace('-', '') });
  assert.equal(one.status, 200, one.data.error);
  assert.deepEqual([one.data.kind, one.data.checkedIn, one.data.due, one.data.customer], ['booking', true, 4000, { id: '1001' }]);
  assert.deepEqual(one.data.lines, [{ title: `Table fee: ${table.ref} (T5, 4 people)`, price: '40.00', quantity: 1, taxable: true, properties: { _booking: table.ref } }]);
  const early = await pos('checkin', { code: later.ref });
  assert.deepEqual([early.data.reason, early.data.lines, early.data.customer], ['not-today', [], null], 'nothing to charge for another day');

  const memberCode = lair.memberRow('1001').code;
  const card = await pos('checkin', { code: memberCode });
  assert.deepEqual([card.data.kind, card.data.customer], ['member', { id: '1001' }]);
  assert.deepEqual(card.data.lines.map((l) => [l.price, l.properties._booking]), [['40.00', table.ref], ['10.00', quiz.ref]]);
  assert.equal(card.data.lines[1].title, `Event entry: Trivia night (${quiz.ref})`);

  // The POS order pays them; the next scan has nothing left to charge.
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  await internal('orders-paid', { id: 990, admin_graphql_api_id: 'gid://shopify/Order/990', source_name: 'pos', line_items: card.data.lines.map((l, i) => ({ id: 99000 + i, quantity: l.quantity, price: l.price, properties: [{ name: '_booking', value: l.properties._booking }] })) });
  assert.deepEqual((await pos('checkin', { code: memberCode })).data.lines, []);

  await call('GET', 'me', null, '1001');
  const member = await pos('member', { code: memberCode.toLowerCase().replace(/-/g, '') });
  assert.deepEqual([member.status, member.data.customerId, member.data.name, member.data.rolls.available], [200, '1001', 'Sam', 0]);
  assert.equal((await pos('member', { code: 'ZZ-GOBLIN-77' })).status, 404);
  assert.equal((await pos('member', { code: table.ref })).status, 404);
});

/* ---------------- 3 Oct 2026, round 4 ---------------- */

/** POST /passes as staff; returns the pass */
async function makePass(body = {}) {
  const res = await call('POST', 'passes', { label: 'Warhammer league: 10 sessions', sessions: 10, holderName: 'Sam Jones', ...body }, 'staff');
  assert.equal(res.status, 200, res.data.error);
  return res.data.pass;
}
const passNamed = async (code) => (await call('GET', `passes?status=all&q=${encodeURIComponent(code)}`, null, 'staff')).data.passes[0];

test('passes: staff make, find and change them; the code comes from the holder; a holder email links the member', async () => {
  assert.equal((await call('POST', 'passes', { label: 'x', sessions: 1, holderName: 'Sam' }, '1001')).status, 403);
  assert.equal((await call('GET', 'passes', null, '1001')).status, 403);
  const pass = await makePass({ note: 'Paid cash', pricePaid: 80, expires: '2026-12-31' });
  assert.match(pass.code, /^SJ-[A-Z]{3,9}-([1-9]|1\d|20)$/);
  assert.deepEqual(
    [pass.label, pass.sessionsTotal, pass.sessionsUsed, pass.sessionsLeft, pass.cover, pass.pricePaid, pass.status, pass.note, pass.holder, pass.uses, pass.createdAt],
    ['Warhammer league: 10 sessions', 10, 0, 10, 1000, 8000, 'active', 'Paid cash', { customerId: null, name: 'Sam Jones', email: '' }, [], NOW],
  );
  assert.equal(pass.expiresAt, at('2027-01-01', 0) - 1, 'it works until midnight on its last day');
  const { codeKey } = await import('../src/core.js');
  assert.deepEqual({ ...lair.sql.exec('SELECT kind, target_id FROM codes WHERE key = ?', codeKey(pass.code)).one() }, { kind: 'pass', target_id: pass.id });
  assert.match((await makePass({ holderName: '李雷', label: 'Door prize' })).code, /^DG-/, 'no usable letters: DG');

  const refused = async (body, status, error) => {
    const res = await call('POST', 'passes', { label: 'Gift pack', sessions: 5, holderName: 'Ana', ...body }, 'staff');
    assert.deepEqual([res.status, res.data.error], [status, error], JSON.stringify(body));
  };
  await refused({ label: ' ' }, 422, 'Add a label, like "Warhammer league: 10 sessions".');
  await refused({ sessions: 0 }, 422, 'A pass has 1 to 100 sessions.');
  await refused({ sessions: 101 }, 422, 'A pass has 1 to 100 sessions.');
  await refused({ holderName: '' }, 422, "Add the holder's name, or find them in the members.");
  await refused({ expires: '2026-09-30' }, 422, 'That expiry date has already passed.');
  await refused({ expires: '2026-02-30' }, 422, 'Pick the expiry date from the calendar.');
  await refused({ customerId: '4040' }, 404, 'That member could not be found.');
  await refused({ holderEmail: 'not an email' }, 422, "Check the holder's email address.");

  // A holder email that matches a member links them, with their name; cover is in dollars.
  await call('POST', 'bookings', tableBooking({ name: 'Kiri Smith', email: 'kiri@example.com' }), '2002');
  const gift = await makePass({ label: 'Gift pack: 10 sessions', holderName: '', holderEmail: 'KIRI@example.com', cover: 15 });
  assert.deepEqual([gift.holder, gift.cover], [{ customerId: '2002', name: 'Kiri Smith', email: 'KIRI@example.com' }, 1500]);
  assert.match(gift.code, /^KS-/);

  // Newest first; q looks in the label, the holder and the code (any way it's typed).
  const list = async (query) => (await call('GET', `passes${query}`, null, 'staff')).data.passes.map((p) => p.code);
  assert.equal((await list('')).length, 3);
  assert.equal((await list(''))[0], gift.code);
  assert.deepEqual(await list('?q=kiri'), [gift.code]);
  assert.deepEqual(await list(`?q=${pass.code.toLowerCase().replace(/-/g, ' ')}`), [pass.code]);
  assert.deepEqual(await list('?q=LEAGUE'), [pass.code]);
  // Changing a pass: void ones drop out of the default list.
  const changed = await call('POST', `passes/${pass.id}/update`, { label: 'League: 12 sessions', sessions: 12, note: '', status: 'void', expires: '' }, 'staff');
  assert.deepEqual([changed.data.pass.label, changed.data.pass.sessionsTotal, changed.data.pass.note, changed.data.pass.status, changed.data.pass.expiresAt], ['League: 12 sessions', 12, '', 'void', null]);
  assert.equal(changed.data.pass.code, pass.code, 'codes never change');
  assert.deepEqual(await list('?q=league'), []);
  assert.deepEqual(await list('?q=league&status=void'), [pass.code]);
  assert.equal((await list('?status=all')).length, 3);
  assert.equal((await call('POST', 'passes/ps_nope/update', { label: 'x' }, 'staff')).status, 404);
  assert.equal((await call('POST', `passes/${pass.id}/update`, { status: 'lost' }, 'staff')).status, 422);
});

test('passes at check-in: a $10 table is fully covered, the $15 room pays $5 a person, and a GM seat still pays its GM fee', async () => {
  const pass = await makePass({ sessions: 20 });
  const one = (await call('POST', 'bookings', tableBooking({ tables: ['T5'], people: 1 }))).data.booking;
  const res = await call('POST', 'checkin', { code: one.ref, pass: pass.code.toLowerCase() }, 'staff');
  assert.equal(res.status, 200, res.data.error);
  const { useId, ...used } = res.data.pass;
  assert.match(useId, /^pu_/);
  assert.deepEqual(used, { code: pass.code, label: pass.label, used: 1, left: 19, covered: 1000 });
  assert.deepEqual([res.data.checkedIn, res.data.due, res.data.notice], [true, 0, null]);
  assert.deepEqual([res.data.row.type, res.data.row.ref, res.data.row.amount, res.data.row.covered, res.data.row.due, res.data.row.paid], ['booking', one.ref, 1000, 1000, 0, true]);
  assert.deepEqual(res.data.row.pass, { code: pass.code, label: pass.label, left: 19 }, 'the pass is saved on the booking');
  assert.doesNotMatch(res.data.message, /Charge/);

  const fancy = (await call('POST', 'bookings', tableBooking({ tables: ['F1'], people: 4, email: 'f@example.com' }))).data.booking;
  const room = await call('POST', 'checkin', { code: fancy.ref, pass: pass.code }, 'staff');
  assert.deepEqual([room.data.pass.used, room.data.pass.covered, room.data.row.amount, room.data.due], [4, 4000, 6000, 2000], '$15 a person: the pass covers $10 of each');
  assert.match(room.data.message, /Charge \$20\.00\./);

  const game = await call('POST', 'games', { title: 'Curse of Strahd', system: 'D&D 5e', gm: 'Ana', blurb: 'x', seats: 4, tables: ['A1'], start: at('2026-10-01', 15), end: at('2026-10-01', 18) }, 'gm');
  const seat = (await call('POST', 'bookings', { kind: 'gm-seat', gameId: game.data.game.id, people: 2, name: 'Mia', email: 'mia@example.com' }, 'mia')).data.booking;
  const gm = await call('POST', 'checkin', { code: seat.ref, pass: pass.code }, 'staff');
  assert.deepEqual([gm.data.row.amount, gm.data.pass.used, gm.data.pass.covered, gm.data.due], [3000, 2, 2000, 1000], 'a $15 seat: $10 table part covered, the $5 GM fee is still paid');
  const free = await call('POST', 'games', { title: 'Free GM', system: 'Other', gm: 'Bo', blurb: 'x', seats: 4, tables: ['A2'], gmFee: 0, start: at('2026-10-01', 15), end: at('2026-10-01', 18) }, 'gm');
  const freeSeat = (await call('POST', 'bookings', { kind: 'gm-seat', gameId: free.data.game.id, people: 1, name: 'Leo', email: 'leo@example.com' }, 'leo')).data.booking;
  assert.deepEqual((await call('POST', 'checkin', { code: freeSeat.ref, pass: pass.code }, 'staff')).data.due, 0, 'no GM fee: the $10 seat is covered');

  // Checking in again uses nothing more; the floor shows the pass, what it covered and what's due.
  const again = await call('POST', 'checkin', { code: fancy.ref, pass: pass.code }, 'staff');
  assert.deepEqual([again.data.reason, again.data.pass, again.data.due], ['already', null, 2000]);
  assert.equal((await passNamed(pass.code)).sessionsUsed, 8);
  const floor = (await call('GET', 'floor', null, 'staff')).data.bookings.find((b) => b.id === fancy.id);
  assert.deepEqual([floor.covered, floor.due, floor.pass, floor.refund], [4000, 2000, { code: pass.code, label: pass.label, left: 12 }, null]);
  assert.equal((await call('GET', 'floor')).data.bookings.find((b) => b.id === fancy.id).covered, undefined, 'the public floor shows none of it');
  // An event entry fee is never covered.
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [
    { id: 'quiz', title: 'Trivia night', start: at('2026-10-01', 15), end: at('2026-10-01', 17), tables: '', capacity: 20, entryFee: 500 },
  ]);
  const quiz = (await call('POST', 'events/quiz@2026-10-01/join', { name: 'Sam', email: 'sam@example.com', people: 2 })).data.join;
  const entry = await call('POST', 'checkin', { code: quiz.ref, pass: pass.code }, 'staff');
  assert.deepEqual([entry.data.kind, entry.data.pass, entry.data.due, entry.data.notice], ['join', null, 1000, "Passes don't cover event entry, so no pass was used."]);
});

test('passes at check-in: 3 people with 2 sessions left pay for one; void and expired passes are skipped with a notice; undo gives sessions back', async () => {
  const pass = await makePass({ sessions: 2 });
  const three = (await call('POST', 'bookings', tableBooking({ tables: ['T5'], people: 3 }))).data.booking;
  const res = await call('POST', 'checkin', { code: three.ref, pass: pass.code }, 'staff');
  assert.deepEqual([res.data.pass.used, res.data.pass.left, res.data.pass.covered, res.data.due], [2, 0, 2000, 1000]);
  assert.equal(res.data.notice, `Pass ${pass.code} had 2 sessions left, so it covered 2 of 3 people.`);
  const listed = await passNamed(pass.code);
  assert.deepEqual([listed.status, listed.sessionsLeft], ['used', 0]);
  assert.deepEqual(listed.uses.map((u) => [u.id, u.bookingId, u.ref, u.people, u.covered, u.at, u.undone]), [[res.data.pass.useId, three.id, three.ref, 2, 2000, NOW, null]]);
  const another = (await call('POST', 'bookings', tableBooking({ tables: ['T6'], email: 'x@example.com' }))).data.booking;
  const empty = await call('POST', 'checkin', { code: another.ref, pass: pass.code }, 'staff');
  assert.deepEqual([empty.data.checkedIn, empty.data.pass, empty.data.due, empty.data.notice], [true, null, 4000, `Pass ${pass.code} has no sessions left, so it wasn't used.`]);
  const fewer = await call('POST', `passes/${pass.id}/update`, { sessions: 1 }, 'staff');
  assert.deepEqual([fewer.status, fewer.data.error], [422, "This pass has used 2 sessions, so it can't have fewer than 2."]);

  // Undo: the sessions go back and the booking owes the fee again. Twice is fine.
  assert.equal((await call('POST', `passes/uses/${res.data.pass.useId}/undo`, {}, '1001')).status, 403);
  const undone = await call('POST', `passes/uses/${res.data.pass.useId}/undo`, {}, 'staff');
  assert.equal(undone.status, 200, undone.data.error);
  assert.deepEqual([undone.data.pass.sessionsLeft, undone.data.pass.status, undone.data.pass.uses[0].undone, undone.data.row.covered, undone.data.row.due, undone.data.row.paid], [2, 'active', NOW, 0, 3000, false]);
  assert.equal((await call('POST', `passes/uses/${res.data.pass.useId}/undo`, {}, 'staff')).data.pass.sessionsLeft, 2);
  assert.equal((await call('POST', 'passes/uses/pu_nope/undo', {}, 'staff')).status, 404);

  // { id, type } checks one row in again, to apply a pass after all; 'none' skips the booking's saved pass.
  assert.equal((await call('POST', 'checkin', { id: three.id, type: 'booking', pass: 'none' }, 'staff')).data.due, 3000);
  const after = await call('POST', 'checkin', { id: three.id, type: 'booking' }, 'staff');
  assert.deepEqual([after.data.pass.used, after.data.due], [2, 1000], 'left out: the pass saved on the booking');
  await call('POST', `passes/uses/${after.data.pass.useId}/undo`, {}, 'staff');
  // Void and expired passes are skipped with a notice; the check-in still happens.
  await call('POST', `passes/${pass.id}/update`, { status: 'void' }, 'staff');
  const voided = await call('POST', 'checkin', { id: three.id, type: 'booking' }, 'staff');
  assert.deepEqual([voided.data.checkedIn, voided.data.pass, voided.data.notice, voided.data.due], [true, null, `Pass ${pass.code} is void, so it wasn't used.`, 3000]);
  const old = await makePass({ holderName: 'Old Timer' });
  lair.write('UPDATE passes SET expires_at = ? WHERE id = ?', NOW - 1, old.id);
  const expired = await call('POST', 'checkin', { id: another.id, type: 'booking', pass: old.code }, 'staff');
  assert.deepEqual([expired.data.pass, expired.data.notice, expired.data.due], [null, `Pass ${old.code} expired on 1 October 2026, so it wasn't used.`, 4000]);
  const typo = await call('POST', 'checkin', { id: another.id, type: 'booking', pass: 'ZZ-NOPE-4' }, 'staff');
  assert.deepEqual([typo.data.checkedIn, typo.data.notice], [true, 'No pass with that code, so no pass was used. Check the code and try again.']);
  assert.equal((await call('POST', 'checkin', { id: 'bk_nope', type: 'booking' }, 'staff')).status, 404);
  // A pass code at check-in shows the pass.
  const shown = await call('POST', 'checkin', { code: old.code }, 'staff');
  assert.deepEqual([shown.data.type, shown.data.checkedIn, shown.data.row, shown.data.pass.code, shown.data.message], ['pass', false, null, old.code, 'Warhammer league: 10 sessions: 10 sessions left of 10.']);
});

test('usePass: members save their own pass on a booking for check-in; someone else\'s is a 403; staff may use any active pass', async () => {
  await call('POST', 'me/profile', { name: 'Sam Jones' }, '1001');
  const mine = await makePass({ customerId: '1001', holderName: '' });
  assert.deepEqual([mine.holder.customerId, mine.holder.name], ['1001', 'Sam Jones']);
  const theirs = await makePass({ holderName: 'Someone Else' });
  const booked = await call('POST', 'bookings', tableBooking({ usePass: mine.code.toLowerCase() }), '1001');
  assert.equal(booked.status, 200, booked.data.error);
  assert.deepEqual([booked.data.booking.pass, booked.data.booking.covered, booked.data.booking.due], [{ code: mine.code, label: mine.label, sessionsLeft: 10 }, 0, 4000]);
  assert.equal((await passNamed(mine.code)).sessionsUsed, 0, 'nothing is used until check-in, so a no-show keeps the session');

  const notYours = await call('POST', 'bookings', tableBooking({ tables: ['T6'], usePass: theirs.code, email: 'x@example.com' }), '1001');
  assert.deepEqual([notYours.status, notYours.data.error], [403, "That pass isn't yours. Ask us at the counter."]);
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T6'], usePass: mine.code, email: 'y@example.com' }))).status, 403, 'logged out');
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T6'], usePass: 'ZZ-NOPE-1', email: 'z@example.com' }), '1001')).status, 403, "a code that isn't a pass");
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE tables LIKE '%T6%'").one().n, 0, 'nothing was booked');

  const forPal = await call('POST', 'bookings', tableBooking({ tables: ['T7'], usePass: theirs.code, name: 'Pal', email: 'pal@example.com' }), 'staff');
  assert.equal(forPal.data.booking.pass.code, theirs.code, 'staff may use any active pass');
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T8'], usePass: 'ZZ-NOPE-1', email: 'q@example.com' }), 'staff')).status, 404);
  await call('POST', `passes/${theirs.id}/update`, { status: 'void' }, 'staff');
  const cancelled = await call('POST', 'bookings', tableBooking({ tables: ['T8'], usePass: theirs.code, email: 'q@example.com' }), 'staff');
  assert.deepEqual([cancelled.status, cancelled.data.error], [409, 'That pass has been cancelled. Ask us at the counter.']);

  // Game seats and game spots take a pass too.
  const game = await call('POST', 'games', { title: 'Pass game', system: 'Other', gm: 'Ana', blurb: 'x', seats: 4, tables: ['A1'], start: at('2026-10-01', 15), end: at('2026-10-01', 18) }, 'gm');
  const seat = await call('POST', 'bookings', { kind: 'gm-seat', gameId: game.data.game.id, people: 1, name: 'Sam', email: 'sam@example.com', usePass: mine.code }, '1001');
  assert.equal(seat.data.booking.pass.code, mine.code);
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [warhammer()]);
  const spot = await call('POST', 'events/warhammer@2026-10-03/reserve', { name: 'Sam', email: 'sam@example.com', people: 1, usePass: mine.code }, '1001');
  assert.deepEqual([spot.status, spot.data.booking.pass?.code], [200, mine.code]);
  assert.equal((await call('POST', 'events/warhammer@2026-10-03/reserve', { name: 'Sam', email: 'sam@example.com', people: 1, usePass: theirs.code }, '1001')).status, 403);

  // At check-in the saved pass is used without being named.
  const checked = await call('POST', 'checkin', { code: booked.data.booking.ref }, 'staff');
  assert.deepEqual([checked.data.pass.used, checked.data.pass.covered, checked.data.due], [4, 4000, 0]);
  const me = (await call('GET', 'me', null, '1001')).data;
  assert.deepEqual(me.passes, [{ code: mine.code, label: mine.label, sessionsTotal: 10, sessionsLeft: 6, cover: 1000, expiresAt: null, status: 'active' }]);
  const mineBooked = me.bookings.find((b) => b.id === booked.data.booking.id);
  assert.deepEqual([mineBooked.pass, mineBooked.covered, mineBooked.due, mineBooked.payment, mineBooked.refund], [{ code: mine.code, label: mine.label, sessionsLeft: 6 }, 4000, 0, 'store', null]);
  assert.deepEqual([me.seats[0].pass.code, me.seats[0].covered], [mine.code, 0]);
});

test('claiming a pass: an unclaimed one joins the member\'s passes; someone else\'s is a 409 and an unknown code a 404', async () => {
  const gift = await makePass({ label: 'Gift pack: 10 sessions', holderName: 'Gift Voucher', sessions: 1 });
  assert.equal((await call('POST', 'me/passes/claim', { code: gift.code })).status, 401);
  const unknown = await call('POST', 'me/passes/claim', { code: 'ZZ-NOPE-3' }, '1001');
  assert.deepEqual([unknown.status, unknown.data.error], [404, 'No pass with that code. Check it and try again, friend.']);
  const ticket = (await call('POST', 'bookings', tableBooking())).data.booking;
  assert.equal((await call('POST', 'me/passes/claim', { code: ticket.ref }, '1001')).status, 404, "a booking's code isn't a pass");
  const claimed = await call('POST', 'me/passes/claim', { code: gift.code.toLowerCase().replace(/-/g, ' ') }, '1001');
  assert.equal(claimed.status, 200, claimed.data.error);
  assert.deepEqual(claimed.data.pass, { code: gift.code, label: 'Gift pack: 10 sessions', sessionsTotal: 1, sessionsLeft: 1, cover: 1000, expiresAt: null, status: 'active' });
  assert.equal((await passNamed(gift.code)).holder.customerId, '1001');
  assert.equal((await call('POST', 'me/passes/claim', { code: gift.code }, '1001')).status, 200, 'your own again is fine');
  const taken = await call('POST', 'me/passes/claim', { code: gift.code }, '2002');
  assert.deepEqual([taken.status, taken.data.error], [409, 'That pass already belongs to someone. Ask us at the counter.']);
  const voided = await makePass({ holderName: 'Gone' });
  await call('POST', `passes/${voided.id}/update`, { status: 'void' }, 'staff');
  assert.equal((await call('POST', 'me/passes/claim', { code: voided.code }, '1001')).status, 404);

  // Codes are easy to guess, so a member gets 10 tries in 10 minutes.
  for (let i = 0; i < 5; i += 1) await call('POST', 'me/passes/claim', { code: `ZZ-GUESS-${i + 1}` }, '3003');
  for (let i = 0; i < 5; i += 1) assert.equal((await call('POST', 'me/passes/claim', { code: `ZZ-GUESS-${i + 6}` }, '3003')).status, 404);
  const slow = await call('POST', 'me/passes/claim', { code: gift.code }, '3003');
  assert.deepEqual([slow.status, slow.data.error], [429, 'Too many tries in a row. Give it ten minutes, or ask us at the counter.']);
  Date.now = () => NOW + 11 * 60_000;
  assert.equal((await call('POST', 'me/passes/claim', { code: gift.code }, '3003')).status, 409, 'ten minutes later, another go');
  Date.now = () => NOW;

  // Used up: My Lair keeps showing it for 30 days after its last session.
  await call('POST', 'checkin', { code: ticket.ref, pass: gift.code }, 'staff');
  assert.deepEqual((await call('GET', 'me', null, '1001')).data.passes.map((p) => [p.code, p.status, p.sessionsLeft]), [[gift.code, 'used', 0]]);
  Date.now = () => NOW + 31 * 24 * HOUR;
  assert.deepEqual((await call('GET', 'me', null, '1001')).data.passes, []);
});

test('staff apply a pass to a booking for its check-in; not to a sign-up or a GM\'s own table', async () => {
  const pass = await makePass({ holderName: 'League Player' });
  const booking = (await call('POST', 'bookings', tableBooking({ people: 2 }))).data.booking;
  assert.equal((await call('POST', `passes/${pass.id}/apply`, { bookingId: booking.id }, '1001')).status, 403);
  const applied = await call('POST', `passes/${pass.id}/apply`, { bookingId: booking.id }, 'staff');
  assert.equal(applied.status, 200, applied.data.error);
  assert.deepEqual([applied.data.booking.id, applied.data.booking.pass, applied.data.booking.due, applied.data.pass.code], [booking.id, { code: pass.code, label: pass.label, left: 10 }, 2000, pass.code]);
  const checked = await call('POST', 'checkin', { code: booking.ref }, 'staff');
  assert.deepEqual([checked.data.pass.used, checked.data.due], [2, 0]);
  assert.equal((await call('POST', 'passes/ps_nope/apply', { bookingId: booking.id }, 'staff')).status, 404);
  assert.equal((await call('POST', `passes/${pass.id}/apply`, { bookingId: 'bk_nope' }, 'staff')).status, 404);
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [
    { id: 'quiz', title: 'Trivia night', start: at('2026-10-01', 18), end: at('2026-10-01', 20), tables: '', capacity: 20, entryFee: 500 },
  ]);
  const join = (await call('POST', 'events/quiz@2026-10-01/join', { name: 'Sam', email: 'sam@example.com', people: 1 })).data.join;
  const entry = await call('POST', `passes/${pass.id}/apply`, { bookingId: join.id }, 'staff');
  assert.deepEqual([entry.status, entry.data.error], [422, 'Passes cover table sessions, not event entry.']);
  const game = await call('POST', 'games', { title: 'Held', system: 'Other', gm: 'Ana', blurb: 'x', seats: 3, tables: ['A1'], start: at('2026-10-01', 18), end: at('2026-10-01', 21) }, 'gm');
  const hold = lair.gameBookings(game.data.game.id).find((b) => b.kind === 'gm');
  assert.equal((await call('POST', `passes/${pass.id}/apply`, { bookingId: hold.id }, 'staff')).status, 422);
});

/** A POS route on the Lair (the Worker has already checked the POS session token) */
const pos = (path, body = {}) => lair
  .fetch(new Request(`https://lair.test/internal/pos/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body: JSON.stringify(body) }))
  .then(async (r) => ({ status: r.status, data: await r.json() }));

test('the self-serve tab: today\'s tab in My Lair, checked and merged; at the counter it can\'t change; paying it at the POS marks it paid', async () => {
  const coffee = { variantId: '44100000000001', title: 'Flat white', variantTitle: 'Regular', price: 550, qty: 1 };
  const chips = { variantId: 44100000000002, title: `Chips ${'x'.repeat(100)}`, variantTitle: '', price: 300, qty: 2 };
  assert.equal((await call('POST', 'tab', { items: [coffee] })).status, 401);
  const saved = await call('POST', 'tab', { items: [coffee, chips, { ...coffee, qty: 2 }] }, '1001');
  assert.equal(saved.status, 200, saved.data.error);
  const tab = saved.data.tab;
  assert.match(tab.id, /^tb_/);
  assert.deepEqual([tab.day, tab.status, tab.total, tab.updatedAt], ['2026-10-01', 'open', 3 * 550 + 2 * 300, NOW]);
  assert.deepEqual(tab.items.map((x) => [x.variantId, x.qty, x.price, x.title.length]), [['44100000000001', 3, 550, 10], ['44100000000002', 2, 300, 80]], 'the same variant is one line; titles are cut at 80');
  assert.deepEqual((await call('GET', 'me', null, '1001')).data.tab, tab);

  const refused = async (items, error) => {
    const res = await call('POST', 'tab', { items }, '1001');
    assert.deepEqual([res.status, res.data.error], [422, error], JSON.stringify(items).slice(0, 80));
  };
  await refused([{ ...coffee, variantId: 'gid://shopify/ProductVariant/1' }], "Gobgob doesn't know that one. Pick it from the menu instead.");
  await refused([{ ...coffee, variantId: '1'.repeat(21) }], "Gobgob doesn't know that one. Pick it from the menu instead.");
  await refused([{ ...coffee, qty: 0 }], 'Pick 1 to 20 of each thing.');
  await refused([{ ...coffee, qty: 21 }], 'Pick 1 to 20 of each thing.');
  await refused([{ ...coffee, qty: 1.5 }], 'Pick 1 to 20 of each thing.');
  await refused([{ ...coffee, qty: 15 }, { ...coffee, qty: 6 }], 'Pick 1 to 20 of each thing.');
  await refused([{ ...coffee, price: -1 }], "That price doesn't look right. Pick it from the menu again.");
  await refused([{ ...coffee, price: 100001 }], "That price doesn't look right. Pick it from the menu again.");
  await refused(Array.from({ length: 31 }, (_, i) => ({ ...coffee, variantId: String(1000 + i) })), 'A tab holds up to 30 different things. Pay for this lot, then start a fresh one.');
  await refused('coffee', "Something on your tab didn't look right. Pick it from the menu again.");
  assert.equal((await call('POST', 'tab', { items: Array.from({ length: 30 }, (_, i) => ({ ...coffee, variantId: String(1000 + i), price: 100000 })) }, '1001')).status, 200, '30 lines at the top price');

  // Replacing the items keeps the same tab; an empty list deletes it; clear does too.
  const replaced = await call('POST', 'tab', { items: [chips] }, '1001');
  assert.deepEqual([replaced.data.tab.id, replaced.data.tab.total], [tab.id, 600]);
  assert.deepEqual((await call('POST', 'tab', { items: [] }, '1001')).data.tab, null);
  assert.equal((await call('GET', 'me', null, '1001')).data.tab, null);
  const again = (await call('POST', 'tab', { items: [coffee] }, '1001')).data.tab;
  assert.deepEqual((await call('POST', 'tab/clear', {}, '1001')).data.tab, null);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM tabs WHERE id = ?', again.id).one().n, 0);

  // At the counter: the POS puts it in the cart, and it can't change until it's paid.
  const counter = (await call('POST', 'tab', { items: [coffee, chips] }, '1001')).data.tab;
  const added = await pos(`tab/${counter.id}/added`);
  assert.deepEqual([added.status, added.data.tab.status, added.data.tab.total], [200, 'in-cart', 1150]);
  const locked = await call('POST', 'tab', { items: [coffee] }, '1001');
  assert.deepEqual([locked.status, locked.data.error], [409, 'Your tab is at the counter already. Pay for that one, then start a fresh one.']);
  assert.equal((await call('POST', 'tab/clear', {}, '1001')).status, 409);
  assert.equal((await pos('tab/tb_nope/added')).status, 404);

  // An online order can't pay a tab; a counter order with _tab lines does (once, however often Shopify sends it).
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  const line = (variant) => ({ id: Number(variant.variantId.slice(-3)), variant_id: Number(variant.variantId), quantity: 1, price: '5.50', properties: [{ name: '_tab', value: counter.id }] });
  await internal('orders-paid', { id: 500, admin_graphql_api_id: 'gid://shopify/Order/500', source_name: 'web', line_items: [line(coffee)] });
  assert.equal((await call('GET', 'me', null, '1001')).data.tab.status, 'in-cart');
  const paid = await internal('orders-paid', { id: 501, admin_graphql_api_id: 'gid://shopify/Order/501', source_name: 'pos', line_items: [line(coffee), line({ ...chips, variantId: String(chips.variantId) })] });
  assert.deepEqual(paid.data.tabs, [counter.id]);
  assert.deepEqual((await internal('orders-paid', { id: 501, admin_graphql_api_id: 'gid://shopify/Order/501', source_name: 'pos', line_items: [line(coffee)] })).data.tabs, [counter.id]);
  assert.equal(lair.sql.exec('SELECT order_id FROM tabs WHERE id = ?', counter.id).one().order_id, 'gid://shopify/Order/501');
  const me = (await call('GET', 'me', null, '1001')).data.tab;
  assert.deepEqual([me.id, me.status], [counter.id, 'paid'], "today's tab, paid");
  assert.equal((await pos(`tab/${counter.id}/added`)).status, 409);
  // Once it's paid, a new tab starts.
  const fresh = (await call('POST', 'tab', { items: [coffee] }, '1001')).data.tab;
  assert.notEqual(fresh.id, counter.id);
  assert.deepEqual([fresh.status, fresh.total], ['open', 550]);
  // Tomorrow is a new day: yesterday's tab isn't today's.
  Date.now = () => NOW + 24 * HOUR;
  assert.equal((await call('GET', 'me', null, '1001')).data.tab, null);
});

/** A POS order line that pays (part of) a booking or sign-up */
const payLine = (id, price, ref, extra = {}) => ({ id, quantity: 1, price, properties: [{ name: '_booking', value: ref }, { name: '_share', value: '1' }], ...extra });
const posOrder = (n, lines) => ({ id: n, admin_graphql_api_id: `gid://shopify/Order/${n}`, source_name: 'pos', line_items: lines });

test('split the bill: friends pay shares at the counter; each order line counts once; each payer is recorded and earns their own spend', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  const payers = { 'gid://shopify/Order/801': '2001', 'gid://shopify/Order/802': '2002' };
  lair.shopify.orderSpend = async (id) => ({ customerId: payers[id] || null, amount: 1000, source: 'pos' });
  await call('POST', 'me/profile', { name: 'Kiri Smith' }, '2001');
  await call('POST', 'me/profile', { name: 'Leo Brown' }, '2002');
  const booking = (await call('POST', 'bookings', tableBooking({ split: true }), '1001')).data.booking;
  assert.deepEqual([booking.split, booking.amount, booking.paidAmount, booking.due], [true, 4000, 0, 4000]);
  assert.equal((await call('POST', 'bookings', tableBooking({ tables: ['T4'], split: 'yes', email: 'x@example.com' }), '1001')).data.booking.split, false, 'only true splits');

  // One person's share by default, or any amount up to what's left.
  const share = await pos('share', { id: booking.id, type: 'booking' });
  assert.equal(share.status, 200, share.data.error);
  assert.deepEqual(share.data.line, { title: `Table fee share: ${booking.ref} ($10 of $40 left)`, price: '10.00', quantity: 1, taxable: true, properties: { _booking: booking.ref, _share: '1' } });
  assert.deepEqual([share.data.row.id, share.data.row.due, share.data.row.split, share.data.row.payments], [booking.id, 4000, true, []]);
  assert.equal((await pos('share', { id: booking.id, type: 'booking', amount: 2550 })).data.line.title, `Table fee share: ${booking.ref} ($25.50 of $40 left)`);
  assert.equal((await pos('share', { id: booking.id, type: 'booking', amount: 99999 })).data.line.price, '40.00', 'capped at what\'s left');
  assert.deepEqual([(await pos('share', { id: booking.id, type: 'booking', amount: 0 })).status, (await pos('share', { id: 'bk_nope' })).status], [422, 404]);

  // Kiri pays a $10 share with her member code on the order; Shopify sends the webhook twice.
  const kiri = posOrder(801, [payLine(8011, '10.00', booking.ref)]);
  assert.deepEqual((await internal('orders-paid', kiri)).data.updated, [booking.ref]);
  await internal('orders-paid', kiri);
  let row = (await pos('share', { id: booking.id, type: 'booking' })).data.row;
  assert.deepEqual([row.paidAmount, row.due, row.paid], [1000, 3000, false], 'the repeat counts nothing');
  assert.deepEqual(row.payments, [{ amount: 1000, customerId: '2001', name: 'Kiri Smith', at: NOW }]);
  // Leo pays from a $20 line with $5 off: $15 counts. Then the last $15 comes as 3 x $5 on an order with no customer.
  await internal('orders-paid', posOrder(802, [payLine(8021, '20.00', booking.ref.toLowerCase(), { discount_allocations: [{ amount: '5.00', discount_application_index: 0 }] })]));
  row = (await pos('share', { id: booking.id, type: 'booking' })).data.row;
  assert.deepEqual([row.paidAmount, row.due, row.paid], [2500, 1500, false]);
  assert.equal((await pos('share', { id: booking.id, type: 'booking' })).data.line.title, `Table fee share: ${booking.ref} ($10 of $15 left)`);
  await internal('orders-paid', posOrder(803, [payLine(8031, '5.00', booking.ref, { quantity: 3 })]));
  const paid = lair.booking(booking.id);
  assert.deepEqual([paid.paidAmount, paid.paid, paid.orderId, paid.status], [4000, true, 'gid://shopify/Order/801', 'confirmed']);
  assert.deepEqual((await pos('share', { id: booking.id, type: 'booking' })).status, 409, 'nothing left to pay');
  // Each payer's spend counts for them, so a friend who pays with their member code earns their own dice rolls.
  assert.deepEqual([lair.spendOf('2001', NOW).total, lair.spendOf('2002', NOW).total, lair.spendOf('1001', NOW).total], [1000, 1000, 0]);

  // Staff see who paid; the booker sees what's paid; friends don't get a copy.
  const floor = (await call('GET', 'floor', null, 'staff')).data.bookings.find((b) => b.id === booking.id);
  assert.deepEqual([floor.paidAmount, floor.due, floor.split], [4000, 0, true]);
  assert.deepEqual(floor.payments.map((p) => [p.amount, p.customerId, p.name]), [[1000, '2001', 'Kiri Smith'], [1500, '2002', 'Leo Brown'], [1500, null, null]]);
  const mine = (await call('GET', 'me', null, '1001')).data.bookings.find((b) => b.id === booking.id);
  assert.deepEqual([mine.paidAmount, mine.due, mine.split, mine.payments], [4000, 0, true, undefined]);
  assert.deepEqual((await call('GET', 'me', null, '2001')).data.bookings, []);
  // Checking in shows nothing more to charge.
  const checked = await call('POST', 'checkin', { code: booking.ref }, 'staff');
  assert.deepEqual([checked.data.due, checked.data.row.paidAmount], [0, 4000]);
  assert.match(checked.data.message, /Paid\.$/);

  // Paying again once it's paid is flagged for a refund.
  const mail = captureEmails();
  try {
    await internal('orders-paid', posOrder(804, [payLine(8041, '10.00', booking.ref)]));
    assert.match(lair.booking(booking.id).notes, /\[Paid twice: gid:\/\/shopify\/Order\/801 and gid:\/\/shopify\/Order\/804\. Refund one\.\]/);
    await settle();
    assert.ok(mail.sent.some((m) => m.to === 'staff@dicegoblin.test' && /^Paid twice/.test(m.subject)));
  } finally {
    mail.restore();
  }
});

test('split the bill: shares for game seats and event entry; the payer is filled in when Shopify answers late; paid by hand counts what was owed', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [
    { id: 'quiz', title: 'Trivia night', start: at('2026-10-01', 18), end: at('2026-10-01', 20), tables: '', capacity: 20, entryFee: 750 },
  ]);
  const game = await call('POST', 'games', { title: 'Curse of Strahd', system: 'D&D 5e', gm: 'Ana', blurb: 'x', seats: 4, tables: ['A1'], start: at('2026-10-01', 18), end: at('2026-10-01', 21) }, 'gm');
  const seat = (await call('POST', 'bookings', { kind: 'gm-seat', gameId: game.data.game.id, people: 3, name: 'Mia', email: 'mia@example.com' }, 'mia')).data.booking;
  assert.equal((await pos('share', { id: seat.id, type: 'booking' })).data.line.title, `GM seat share: ${seat.ref} ($15 of $45 left)`);
  const join = (await call('POST', 'events/quiz@2026-10-01/join', { name: 'Sam', email: 'sam@example.com', people: 2 })).data.join;
  const entry = await pos('share', { id: join.id, type: 'join' });
  assert.deepEqual([entry.data.line.title, entry.data.row.type, entry.data.row.due], [`Event entry share: ${join.ref} ($7.50 of $15 left)`, 'join', 1500]);

  // Shopify can't say who the customer is yet: the payment counts, and the payer is filled in when the webhook comes again.
  let down = true;
  lair.shopify.orderSpend = async () => {
    if (down) throw new Error('Shopify API error 503');
    return { customerId: '3003', amount: 750, source: 'pos' };
  };
  const order = posOrder(901, [payLine(9011, '7.50', join.ref)]);
  assert.equal((await internal('orders-paid', order)).status, 500, 'Shopify sends it again later');
  assert.deepEqual([lair.joinById(join.id).paidAmount, lair.joinById(join.id).paid], [750, false]);
  assert.deepEqual(lair.paymentsOf('join', join.id).map((p) => p.customerId), [null]);
  down = false;
  await internal('orders-paid', order);
  assert.deepEqual([lair.joinById(join.id).paidAmount, lair.paymentsOf('join', join.id).map((p) => p.customerId)], [750, ['3003']]);
  assert.equal(lair.spendOf('3003', NOW).total, 750);
  const staffJoin = (await call('GET', 'floor', null, 'staff')).data.joins.find((j) => j.id === join.id);
  assert.deepEqual([staffJoin.paidAmount, staffJoin.due, staffJoin.payments.length], [750, 750, 1]);

  // Staff mark the seat paid by hand (cash): what was owed counts as paid. Unmarked, only recorded payments count.
  const marked = await call('POST', `bookings/${seat.id}/update`, { paid: true }, 'staff');
  assert.deepEqual([marked.data.booking.paid, marked.data.booking.paidAmount, marked.data.booking.due], [true, 4500, 0]);
  const unmarked = await call('POST', `bookings/${seat.id}/update`, { paid: false }, 'staff');
  assert.deepEqual([unmarked.data.booking.paid, unmarked.data.booking.paidAmount, unmarked.data.booking.due], [false, 0, 4500]);
  // One more player joins a paid table: they owe for one.
  const table = (await call('POST', 'bookings', tableBooking({ tables: ['T8'], people: 2, email: 't@example.com' }))).data.booking;
  await call('POST', `bookings/${table.id}/update`, { paid: true }, 'staff');
  const bigger = await call('POST', `bookings/${table.id}/update`, { people: 3 }, 'staff');
  assert.deepEqual([bigger.data.booking.amount, bigger.data.booking.paid, bigger.data.booking.due], [3000, false, 1000]);
});

test('split the bill: a part-paid seat in a cancelled game gets back what was paid, and can be marked refunded', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  const game = await call('POST', 'games', { title: 'Short notice', system: 'Other', gm: 'Ana', blurb: 'x', seats: 4, tables: ['A1'], start: at('2026-10-01', 18), end: at('2026-10-01', 21) }, 'gm');
  const seat = (await call('POST', 'bookings', { kind: 'gm-seat', gameId: game.data.game.id, people: 2, name: 'Mia', email: 'mia@example.com' }, 'mia')).data.booking;
  await internal('orders-paid', posOrder(950, [payLine(9501, '15.00', seat.ref)]));
  assert.deepEqual([lair.booking(seat.id).paidAmount, lair.booking(seat.id).paid], [1500, false]);
  const mail = captureEmails();
  try {
    await call('POST', `games/${game.data.game.id}/update`, { status: 'cancelled' }, 'gm');
    assert.equal(lair.booking(seat.id).refund, 'due');
    await settle();
    assert.match(mail.sent.find((m) => m.to === 'staff@dicegoblin.test' && /Refunds due/.test(m.subject)).text, /Mia: \$15\.00 for/);
    assert.match(mail.sent.find((m) => m.to === 'mia@example.com').text, /Refund: +\$15\.00/);
  } finally {
    mail.restore();
  }
  const done = await call('POST', `bookings/${seat.id}/update`, { refunded: true }, 'staff');
  assert.deepEqual([done.status, done.data.booking.refund], [200, 'done']);
});

/** A day at the Lair for the POS tests: a GM game, two events, table bookings and a walk-in, all on Thursday 1 October */
async function busyDay() {
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [
    { id: 'quiz', title: 'Trivia night', start: at('2026-10-01', 18), end: at('2026-10-01', 20), tables: '', capacity: 20, entryFee: 500 },
    { id: 'wh', title: 'Warhammer night', start: at('2026-10-01', 17), end: at('2026-10-01', 21), tables: 'T20', gameTables: 'T16+T17, T18+T19' },
    { id: 'later', title: 'Saturday league', start: at('2026-10-03', 12), end: at('2026-10-03', 16), tables: '', capacity: 10 },
  ]);
  const game = (await call('POST', 'games', { title: 'Curse of Strahd', system: 'D&D 5e', gm: 'Ana', blurb: 'x', seats: 4, tables: ['A1'], start: at('2026-10-01', 15), end: at('2026-10-01', 18) }, 'gm')).data.game;
  const seat = (who, name, people) => call('POST', 'bookings', { kind: 'gm-seat', gameId: game.id, people, name, email: `${name.toLowerCase()}@example.com` }, who).then((r) => r.data.booking);
  const mia = await seat('mia', 'Mia', 2);
  const leo = await seat('leo', 'Leo', 1);
  const gone = await seat('zed', 'Zed', 1);
  await call('POST', `bookings/${gone.id}/update`, { status: 'cancelled' }, 'zed');
  const sam = (await call('POST', 'bookings', tableBooking({ tables: ['T5'], name: 'Sam', email: 'sam@example.com' }), '1001')).data.booking;
  const kai = (await call('POST', 'bookings', tableBooking({ tables: ['T6'], start: at('2026-10-01', 16), end: at('2026-10-01', 18), people: 2, name: 'Kai', email: 'kai@example.com' }))).data.booking;
  await call('POST', `bookings/${kai.id}/update`, { status: 'noshow' }, 'staff');
  const cancelled = (await call('POST', 'bookings', tableBooking({ tables: ['T7'], name: 'Gone', email: 'gone@example.com' }))).data.booking;
  await call('POST', `bookings/${cancelled.id}/update`, { status: 'cancelled' }, 'staff');
  const walkin = (await call('POST', 'bookings', { kind: 'walkin', tables: ['T8'], start: NOW, end: NOW + HOUR, people: 2, name: 'Walk In' }, 'staff')).data.booking;
  const spot = (await call('POST', 'events/wh@2026-10-01/reserve', { name: 'Aroha', email: 'aroha@example.com', people: 2 })).data.booking;
  const quizSam = (await call('POST', 'events/quiz@2026-10-01/join', { name: 'Sam', email: 'sam@example.com', people: 2 }, '1001')).data.join;
  const quizBo = (await call('POST', 'events/quiz@2026-10-01/join', { name: 'Bo', email: 'bo@example.com', people: 1 })).data.join;
  await call('POST', 'bookings', tableBooking({ tables: ['T9'], start: at('2026-10-02', 15), end: at('2026-10-02', 17), email: 'tomorrow@example.com' }));
  return { game, mia, leo, sam, kai, walkin, spot, quizSam, quizBo };
}

test('POS today: games, events and table bookings for today, grouped and in order; cancelled rows left out, no-shows kept', async () => {
  const day = await busyDay();
  const res = await call('GET', 'floor', null, 'staff');
  assert.equal(res.status, 200);
  const today = await pos('today');
  assert.equal(today.status, 200, today.data.error);
  assert.deepEqual([today.data.day, today.data.now], ['2026-10-01', NOW]);
  const groups = today.data.groups;
  assert.deepEqual(groups.map((g) => [g.key, g.kind, g.title, g.start, g.end, g.tables]), [
    ['tables', 'tables', 'Table bookings', NOW, at('2026-10-01', 18), ['T5', 'T6', 'T8']],
    [`game:${day.game.id}`, 'game', 'Curse of Strahd · GM Ana', at('2026-10-01', 15), at('2026-10-01', 18), ['A1']],
    ['event:wh@2026-10-01', 'event', 'Warhammer night', at('2026-10-01', 17), at('2026-10-01', 21), ['T20', 'T16', 'T17', 'T18', 'T19']],
    ['event:quiz@2026-10-01', 'event', 'Trivia night', at('2026-10-01', 18), at('2026-10-01', 20), []],
  ]);
  assert.deepEqual(groups.map((g) => g.rows.map((r) => [r.type, r.name, r.status])), [
    [['booking', 'Walk In', 'seated'], ['booking', 'Sam', 'confirmed'], ['booking', 'Kai', 'noshow']],
    [['booking', 'Leo', 'confirmed'], ['booking', 'Mia', 'confirmed']],
    [['booking', 'Aroha', 'confirmed']],
    [['join', 'Bo', 'confirmed'], ['join', 'Sam', 'confirmed']],
  ]);
  const sam = groups[0].rows[1];
  assert.deepEqual(sam, {
    id: day.sam.id, type: 'booking', kind: 'table', ref: day.sam.ref, name: 'Sam', people: 4, tables: ['T5'], start: at('2026-10-01', 15), end: at('2026-10-01', 17),
    status: 'confirmed', arrivedAt: null, paid: false, amount: 4000, covered: 0, due: 4000, paidAmount: 0, payments: [], split: false, customerId: '1001', pass: null,
    refund: null, note: '', title: 'Table T5', players: [], gameId: null, occurrenceId: null,
  });
  assert.deepEqual(groups[1].rows[1].players, [{ name: 'Mia', character: '' }, { name: 'Mia +1', character: '' }]);
  assert.deepEqual([groups[3].rows[1].id, groups[3].rows[1].due, groups[3].rows[1].title, groups[3].rows[1].occurrenceId], [day.quizSam.id, 1000, 'Trivia night', 'quiz@2026-10-01']);
  // An empty day still answers.
  Date.now = () => at('2026-10-05', 13);
  assert.deepEqual((await pos('today')).data, { day: '2026-10-05', now: at('2026-10-05', 13), groups: [] });
});

test('POS scan: a booking, seat, game spot or sign-up shows its row and group; a member their day, tab and passes; a pass itself; anything else is a 404', async () => {
  const day = await busyDay();
  const pass = await makePass({ customerId: '1001', holderName: 'Sam Jones' });
  const scan = (code) => pos('scan', { code });
  const booking = await scan(day.sam.ref.toLowerCase().replace(/-/g, ' '));
  assert.deepEqual([booking.status, booking.data.type, booking.data.row.id, booking.data.group], [200, 'booking', day.sam.id, { key: 'tables', kind: 'tables', title: 'Table bookings', start: NOW }]);
  assert.equal(lair.booking(day.sam.id).status, 'confirmed', 'scanning checks nobody in');
  assert.deepEqual((await scan(day.mia.ref)).data.group, { key: `game:${day.game.id}`, kind: 'game', title: 'Curse of Strahd · GM Ana', start: at('2026-10-01', 15) });
  assert.deepEqual((await scan(day.spot.ref)).data.group, { key: 'event:wh@2026-10-01', kind: 'event', title: 'Warhammer night', start: at('2026-10-01', 17) });
  const join = await scan(day.quizBo.ref);
  assert.deepEqual([join.data.type, join.data.row.type, join.data.row.due, join.data.group], ['join', 'join', 500, { key: 'event:quiz@2026-10-01', kind: 'event', title: 'Trivia night', start: at('2026-10-01', 18) }]);
  // A member: their rows today across every group, today's tab and their active passes.
  await call('POST', 'tab', { items: [{ variantId: '123', title: 'Flat white', variantTitle: '', price: 550, qty: 1 }] }, '1001');
  const member = await scan(lair.memberRow('1001').code);
  assert.deepEqual([member.data.type, member.data.member], ['member', { customerId: '1001', name: 'Sam', code: lair.memberRow('1001').code }]);
  assert.deepEqual(member.data.rows.map((r) => [r.type, r.ref]), [['booking', day.sam.ref], ['join', day.quizSam.ref]]);
  assert.deepEqual([member.data.tab.total, member.data.tab.status], [550, 'open']);
  assert.deepEqual(member.data.passes.map((p) => [p.code, p.sessionsLeft, p.uses]), [[pass.code, 10, undefined]]);
  const shown = await scan(pass.code);
  assert.deepEqual([shown.data.type, shown.data.pass.code, shown.data.pass.uses], ['pass', pass.code, []]);
  // The first release's GOB codes, and codes nobody has.
  lair.saveBooking({ ...lair.booking(day.kai.id), id: 'bk_old', ref: 'GOB-7K2QXM', tables: ['T9'], status: 'confirmed' }, NOW);
  assert.deepEqual([(await scan('gob7k2qxm')).data.row.ref], ['GOB-7K2QXM']);
  for (const code of ['ZZ-NOPE-1', 'hello', '']) assert.deepEqual([(await scan(code)).status, (await scan(code)).data.error], [404, 'No booking, member or pass with that code.'], code);
  // Round 3's /pos/member answers for member codes only.
  const old = await pos('member', { code: lair.memberRow('1001').code });
  assert.deepEqual([old.data.type, old.data.customerId, old.data.name, old.data.rolls.available], ['member', '1001', 'Sam', 0]);
  assert.equal((await pos('member', { code: day.sam.ref })).status, 404);
});

test('POS check-in: lines say what they\'re for and what\'s left after a pass; nothing due, no lines; checking in again gives the same lines', async () => {
  const day = await busyDay();
  const pass = await makePass({ sessions: 2, holderName: 'League' });
  const checkin = (body) => pos('checkin', body);
  const table = await checkin({ id: day.sam.id, type: 'booking', pass: pass.code });
  assert.equal(table.status, 200, table.data.error);
  assert.deepEqual(table.data.lines, [{ title: `Table fee: ${day.sam.ref} (T5, 4 people) (pass covered $20)`, price: '20.00', quantity: 1, taxable: true, properties: { _booking: day.sam.ref } }]);
  assert.deepEqual([table.data.row.arrivedAt, table.data.row.status, table.data.customer, table.data.pass.covered, table.data.notice], [NOW, 'seated', { id: '1001' }, 2000, `Pass ${pass.code} had 2 sessions left, so it covered 2 of 4 people.`]);
  assert.equal(lair.sql.exec('SELECT by FROM pass_uses').one().by, 'pos:', 'the POS user is kept with the use');
  const again = await checkin({ id: day.sam.id, type: 'booking' });
  assert.deepEqual([again.data.already, again.data.lines], [true, table.data.lines], 'the same lines, and the pass is not used twice');
  const seat = await checkin({ code: day.mia.ref });
  assert.deepEqual(seat.data.lines.map((l) => [l.title, l.price]), [[`GM seat: Curse of Strahd (${day.mia.ref})`, '30.00']]);
  assert.deepEqual(seat.data.customer, { id: 'mia' });
  Date.now = () => at('2026-10-01', 17, 30);
  const spot = await checkin({ id: day.spot.id, type: 'booking' });
  assert.deepEqual(spot.data.lines.map((l) => [l.title, l.price]), [[`Game spot: Warhammer night (${day.spot.ref})`, '20.00']]);
  const entry = await checkin({ id: day.quizBo.id, type: 'join' });
  assert.deepEqual([entry.data.row.type, entry.data.lines.map((l) => [l.title, l.price])], ['join', [[`Event entry: Trivia night (${day.quizBo.ref})`, '5.00']]]);
  // Nothing due, no lines: a walk-in marked paid, then a booking a pass covers in full.
  const walkin = (await call('POST', 'bookings', { kind: 'walkin', tables: ['T10'], start: Date.now(), end: Date.now() + HOUR, people: 1, paid: true }, 'staff')).data.booking;
  assert.deepEqual((await checkin({ id: walkin.id, type: 'booking' })).data.lines, []);
  const solo = (await call('POST', 'bookings', tableBooking({ tables: ['T11'], start: at('2026-10-01', 19), end: at('2026-10-01', 20), people: 1, email: 'solo@example.com' }))).data.booking;
  const covered = await checkin({ id: solo.id, type: 'booking', pass: (await makePass({ holderName: 'Solo' })).code });
  assert.deepEqual([covered.data.row.due, covered.data.lines], [0, []]);
  // Refused: the no-show and another day's booking give no lines.
  const noshow = await checkin({ id: day.kai.id, type: 'booking' });
  assert.deepEqual([noshow.data.checkedIn, noshow.data.reason, noshow.data.lines, noshow.data.notice], [false, 'cancelled', [], `This booking was marked as a no-show: Kai, 2 people at T6.`]);
  assert.equal((await checkin({ id: 'bk_nope', type: 'booking' })).status, 404);
});

test('POS check-in-member: every row a member has today is checked in (passes apply), with lines for what\'s left and notices', async () => {
  const day = await busyDay();
  await call('POST', 'me/profile', { name: 'Sam Jones' }, '1001');
  const pass = await makePass({ customerId: '1001', holderName: '', sessions: 1 });
  await call('POST', `passes/${pass.id}/apply`, { bookingId: day.sam.id }, 'staff');
  const res = await pos('checkin-member', { customerId: '1001' });
  assert.equal(res.status, 200, res.data.error);
  assert.deepEqual(res.data.rows.map((r) => [r.type, r.ref, Boolean(r.arrivedAt), r.due]), [['booking', day.sam.ref, true, 3000], ['join', day.quizSam.ref, true, 1000]], "the quiz is later today, and still checked in");
  assert.deepEqual(res.data.lines.map((l) => [l.title, l.price]), [[`Table fee: ${day.sam.ref} (T5, 4 people) (pass covered $10)`, '30.00'], [`Event entry: Trivia night (${day.quizSam.ref})`, '10.00']]);
  assert.deepEqual([res.data.customer, res.data.notices], [{ id: '1001' }, [`Pass ${pass.code} had 1 session left, so it covered 1 of 4 people.`]]);
  assert.equal(lair.joinById(day.quizSam.id).status, 'attended');
  // Again: the same rows and lines; the saved pass has nothing left to give. A no-show is left alone with a notice.
  const again = await pos('checkin-member', { customerId: '1001' });
  assert.deepEqual([again.data.lines.map((l) => l.price), again.data.notices], [['30.00', '10.00'], [`Pass ${pass.code} has no sessions left, so it wasn't used.`]]);
  lair.write("UPDATE bookings SET customer_id = '1001' WHERE id = ?", day.kai.id);
  const withNoShow = await pos('checkin-member', { customerId: '1001' });
  assert.ok(withNoShow.data.notices.includes(`${day.kai.ref} was marked as a no-show, so it wasn't checked in.`));
  assert.equal(lair.booking(day.kai.id).status, 'noshow');
  assert.equal((await pos('checkin-member', { customerId: '4040' })).status, 404);
  assert.equal((await pos('checkin-member', {})).status, 404);
});

/* ---------------- live data: the database the live app (round 8, main at adf6ad2) has ---------------- */

/** The live app has run these two migrations. Copied word for word from adf6ad2 (git show adf6ad2:src/lair.js). */
const LIVE_MIGRATIONS = [
  [
    `CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, status TEXT NOT NULL, tables TEXT NOT NULL,
      room TEXT, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, people INTEGER NOT NULL, name TEXT, email TEXT,
      phone TEXT, notes TEXT, activity TEXT, extras TEXT, pay TEXT, paid INTEGER NOT NULL DEFAULT 0, amount INTEGER NOT NULL DEFAULT 0,
      game_id TEXT, customer_id TEXT, hold_until INTEGER, draft_order_id TEXT, order_id TEXT, created_at INTEGER, updated_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS bookings_time ON bookings (ends_at, starts_at)',
    'CREATE INDEX IF NOT EXISTS bookings_game ON bookings (game_id)',
    `CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, system TEXT, gm TEXT, gm_customer_id TEXT, gm_email TEXT, level TEXT, age TEXT,
      tags TEXT, safety TEXT, pregens INTEGER, blurb TEXT, tables TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
      seats INTEGER NOT NULL, status TEXT NOT NULL, credited INTEGER, created_at INTEGER, updated_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS games_time ON games (ends_at, starts_at)',
    `CREATE TABLE IF NOT EXISTS blocks (
      id TEXT PRIMARY KEY, tables TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, label TEXT, type TEXT,
      created_by TEXT, created_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS blocks_time ON blocks (ends_at, starts_at)',
    `CREATE TABLE IF NOT EXISTS credits (
      id TEXT PRIMARY KEY, game_id TEXT NOT NULL, customer_id TEXT, players INTEGER NOT NULL, amount INTEGER NOT NULL,
      status TEXT NOT NULL, note TEXT, created_at INTEGER)`,
    // Hold expiry and the per-email limit run often; these keep them from reading the whole table.
    'CREATE INDEX IF NOT EXISTS bookings_hold ON bookings (status, hold_until)',
    'CREATE INDEX IF NOT EXISTS bookings_email_lower ON bookings (lower(email), ends_at)',
  ],
  // 3 Oct 2026: GM game series and fees, seat names, check-in, shop table openings, event sign-ups, GM profiles,
  // game pictures and the dice roller.
  [
    'ALTER TABLE games ADD COLUMN schedule TEXT',
    'ALTER TABLE games ADD COLUMN series_id TEXT',
    'ALTER TABLE games ADD COLUMN gm_fee INTEGER',
    'ALTER TABLE games ADD COLUMN seat_price INTEGER',
    'ALTER TABLE games ADD COLUMN room TEXT',
    'ALTER TABLE games ADD COLUMN characters TEXT',
    'ALTER TABLE games ADD COLUMN bring TEXT',
    'ALTER TABLE games ADD COLUMN content_notes TEXT',
    'ALTER TABLE games ADD COLUMN session_zero TEXT',
    'ALTER TABLE games ADD COLUMN gm_bio TEXT',
    'ALTER TABLE games ADD COLUMN image_id TEXT',
    'ALTER TABLE games ADD COLUMN fee_approved INTEGER',
    'CREATE INDEX IF NOT EXISTS games_series ON games (series_id)',
    'ALTER TABLE bookings ADD COLUMN party TEXT',
    'ALTER TABLE bookings ADD COLUMN arrived_at INTEGER',
    'CREATE INDEX IF NOT EXISTS bookings_customer ON bookings (customer_id, ends_at)',
    `CREATE TABLE IF NOT EXISTS series (
      id TEXT PRIMARY KEY, schedule TEXT NOT NULL, gm_customer_id TEXT, details TEXT NOT NULL, tables TEXT NOT NULL, clock INTEGER NOT NULL,
      length INTEGER NOT NULL, first_day TEXT NOT NULL, status TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0, image_id TEXT,
      created_at INTEGER, updated_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS openings (
      id TEXT PRIMARY KEY, tables TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, note TEXT, created_by TEXT, created_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS openings_time ON openings (ends_at, starts_at)',
    `CREATE TABLE IF NOT EXISTS event_joins (
      id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, occurrence_id TEXT NOT NULL, event_id TEXT NOT NULL, title TEXT, starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL, people INTEGER NOT NULL, name TEXT, email TEXT, note TEXT, status TEXT NOT NULL, customer_id TEXT,
      arrived_at INTEGER, created_at INTEGER, updated_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS event_joins_occurrence ON event_joins (occurrence_id)',
    'CREATE INDEX IF NOT EXISTS event_joins_time ON event_joins (ends_at, starts_at)',
    'CREATE TABLE IF NOT EXISTS gm_profiles (customer_id TEXT PRIMARY KEY, name TEXT, bio TEXT, updated_at INTEGER)',
    'CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, owner TEXT, created_at INTEGER)',
    `CREATE TABLE IF NOT EXISTS rolls (
      key TEXT NOT NULL, day TEXT NOT NULL, roll INTEGER NOT NULL, prize TEXT, code TEXT, expires_at INTEGER, created_at INTEGER,
      PRIMARY KEY (key, day))`,
  ],
];

/** Round 8's rows, the way its code wrote them (every column it had) */
function liveRows(sql) {
  const booking = (b) => sql.exec(
    `INSERT INTO bookings (id, ref, kind, status, tables, room, starts_at, ends_at, people, name, email, phone, notes, activity, extras, pay, paid, amount,
       game_id, customer_id, hold_until, draft_order_id, order_id, party, arrived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    b.id, b.ref, b.kind, b.status, JSON.stringify(b.tables), b.room, b.start, b.end, b.people, b.name, b.email || null, null, b.notes || null, b.activity || 'board',
    JSON.stringify(b.extras || []), b.pay || 'day', b.paid ? 1 : 0, b.amount, b.gameId || null, b.customerId || null, b.holdUntil || null, b.draftOrderId || null,
    b.orderId || null, b.party ? JSON.stringify(b.party) : null, null, NOW - 2 * 24 * HOUR, NOW - 2 * 24 * HOUR,
  );
  booking({ id: 'bk_live1', ref: 'GOB-7K2QXM', kind: 'table', status: 'confirmed', tables: ['T5'], room: 'common-room', start: at('2026-10-01', 15), end: at('2026-10-01', 17), people: 4, name: 'Sam Jones', email: 'sam@example.com', amount: 4000, customerId: '1001' });
  booking({ id: 'bk_live2', ref: 'GOB-PA7D22', kind: 'table', status: 'confirmed', tables: ['T6'], room: 'common-room', start: at('2026-10-01', 16), end: at('2026-10-01', 18), people: 3, name: 'Sam Jones', email: 'sam@example.com', pay: 'now', paid: true, amount: 3000, customerId: '1001', draftOrderId: 'gid://shopify/DraftOrder/50', orderId: 'gid://shopify/Order/500' });
  booking({ id: 'bk_live3', ref: 'GOB-HE7D33', kind: 'table', status: 'held', tables: ['T7'], room: 'common-room', start: at('2026-10-02', 15), end: at('2026-10-02', 17), people: 4, name: 'Aroha', email: 'aroha@example.com', pay: 'now', amount: 4000, holdUntil: NOW + 10 * 60_000, draftOrderId: 'gid://shopify/DraftOrder/51' });
  sql.exec(
    `INSERT INTO games (id, title, system, gm, gm_customer_id, gm_email, level, age, tags, safety, pregens, blurb, tables, starts_at, ends_at, seats, status, credited,
       schedule, series_id, gm_fee, seat_price, room, characters, bring, content_notes, session_zero, gm_bio, image_id, fee_approved, created_at, updated_at)
     VALUES ('gm_live1', 'Lost Mine', 'D&D 5e', 'Ana', 'gm', 'ana@example.com', 'new', 'All ages', '[]', '[]', 1, 'Goblins!', '["A1"]', ?, ?, 4, 'open', NULL,
       'weekly', 'sr_live1', 500, 1500, 'side-room-1', 'pregens', '', '', '', 'Runs a good table', NULL, 1, ?, ?)`,
    at('2026-10-01', 18), at('2026-10-01', 21), NOW - 5 * 24 * HOUR, NOW - 5 * 24 * HOUR,
  );
  sql.exec(
    `INSERT INTO series (id, schedule, gm_customer_id, details, tables, clock, length, first_day, status, approved, image_id, created_at, updated_at)
     VALUES ('sr_live1', 'weekly', 'gm', ?, '["A1"]', 1080, 10800000, '2026-10-01', 'active', 1, NULL, ?, ?)`,
    JSON.stringify({ title: 'Lost Mine', gm: 'Ana', blurb: 'Goblins!', seats: 4, gmFee: 500, schedule: 'weekly', system: 'D&D 5e', gmEmail: 'ana@example.com' }), NOW, NOW,
  );
  booking({ id: 'bk_gm1', ref: 'GOB-GMH9DX', kind: 'gm', status: 'confirmed', tables: ['A1'], room: 'side-room-1', start: at('2026-10-01', 18), end: at('2026-10-01', 21), people: 5, name: 'GM Ana', paid: true, amount: 0, gameId: 'gm_live1', customerId: 'gm', activity: 'rpg' });
  booking({ id: 'bk_seat1', ref: 'GOB-SEAT77', kind: 'gm-seat', status: 'confirmed', tables: ['A1'], room: 'side-room-1', start: at('2026-10-01', 18), end: at('2026-10-01', 21), people: 2, name: 'Mia', email: 'mia@example.com', amount: 3000, gameId: 'gm_live1', customerId: 'mia', activity: 'rpg', party: [{ name: 'Mia', character: 'Valeros' }, { name: 'Kai', character: '' }] });
  booking({ id: 'bk_seat2', ref: 'GOB-SEAT22', kind: 'gm-seat', status: 'confirmed', tables: ['A1'], room: 'side-room-1', start: at('2026-10-01', 18), end: at('2026-10-01', 21), people: 1, name: 'Leo', email: 'leo@example.com', pay: 'now', paid: true, amount: 1500, gameId: 'gm_live1', customerId: 'leo', activity: 'rpg', party: [{ name: 'Leo', character: 'Merisiel' }], orderId: 'gid://shopify/Order/502', draftOrderId: 'gid://shopify/DraftOrder/52' });
  sql.exec(
    `INSERT INTO event_joins (id, ref, occurrence_id, event_id, title, starts_at, ends_at, people, name, email, note, status, customer_id, arrived_at, created_at, updated_at)
     VALUES ('ej_live1', 'GOB-J9N22K', 'quiz@2026-10-01', 'quiz', 'Trivia night', ?, ?, 2, 'Bo', 'bo@example.com', 'Team Goblins', 'confirmed', '1001', NULL, ?, ?)`,
    at('2026-10-01', 18), at('2026-10-01', 20), NOW, NOW,
  );
  sql.exec("INSERT INTO credits (id, game_id, customer_id, players, amount, status, note, created_at) VALUES ('cr_live1', 'gm_live1', 'gm', 3, 1500, 'credited', '', ?)", NOW - 7 * 24 * HOUR);
  sql.exec("INSERT INTO rolls (key, day, roll, prize, code, expires_at, created_at) VALUES ('ip:203.0.113.7', '2026-09-30', 20, 'percent', 'NAT20-7K2QXM', ?, ?)", NOW + HOUR, NOW - 24 * HOUR);
  sql.exec("INSERT INTO blocks (id, tables, starts_at, ends_at, label, type, created_by, created_at) VALUES ('bl_live1', '[\"T15\"]', ?, ?, 'Pokémon league', 'tournament', 'staff', ?)", at('2026-10-01', 18), at('2026-10-01', 22), NOW);
  sql.exec("INSERT INTO openings (id, tables, starts_at, ends_at, note, created_by, created_at) VALUES ('op_live1', '[\"T1\"]', ?, ?, 'Quiet night', 'staff', ?)", at('2026-10-01', 12), at('2026-10-01', 23), NOW);
  sql.exec("INSERT INTO gm_profiles (customer_id, name, bio, updated_at) VALUES ('gm', 'Ana', 'Runs a good table', ?)", NOW);
}

test('live data: the live app\'s database (round 8) moves to round 4, and its bookings, games and sign-ups still read, list, check in and take payments', async () => {
  const { MIGRATIONS } = await import('../src/lair.js');
  assert.deepEqual(MIGRATIONS.slice(0, LIVE_MIGRATIONS.length), LIVE_MIGRATIONS, 'the migrations the live app has run are never edited');
  const ctx = fakeCtx();
  const { sql } = ctx.storage;
  sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  for (const statement of LIVE_MIGRATIONS.flat()) sql.exec(statement);
  sql.exec("INSERT INTO meta (key, value) VALUES ('schema', ?)", String(LIVE_MIGRATIONS.length));
  liveRows(sql);
  const counts = () => Object.fromEntries(['bookings', 'games', 'event_joins', 'credits', 'rolls', 'blocks', 'openings', 'series', 'gm_profiles'].map((t) => [t, sql.exec(`SELECT COUNT(*) AS n FROM ${t}`).one().n]));
  const before = counts();

  // Deploying round 4: its code opens the same database, and every migration since runs once.
  const open = () => {
    lair = new Lair(ctx, { CURRENCY: 'NZD' });
    lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: id === 'gm' });
    lair.shopify.orderSpend = async () => null;
    lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, [
      { id: 'quiz', title: 'Trivia night', start: at('2026-10-01', 18), end: at('2026-10-01', 20), tables: '', capacity: 20 },
    ]);
    lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  };
  open();
  assert.equal(sql.exec("SELECT value FROM meta WHERE key = 'schema'").one().value, String(MIGRATIONS.length));
  assert.deepEqual(counts(), before, 'no rows lost or added');

  // The old rows read as before, with the new fields filled in sensibly.
  const sam = lair.booking('bk_live1');
  assert.deepEqual([sam.ref, sam.status, sam.tables, sam.amount, sam.paid, sam.paidAmount, sam.covered, sam.passId, sam.refund, sam.split, sam.occurrenceId], ['GOB-7K2QXM', 'confirmed', ['T5'], 4000, false, 0, 0, null, null, false, null]);
  const online = lair.booking('bk_live2');
  assert.deepEqual([online.paid, online.paidAmount, online.pay, online.orderId], [true, 3000, 'now', 'gid://shopify/Order/500'], 'paid in full online: paidAmount is its amount');
  const join = lair.joinById('ej_live1');
  assert.deepEqual([join.ref, join.status, join.pay, join.paid, join.amount, join.paidAmount, join.refund, join.note], ['GOB-J9N22K', 'confirmed', 'day', false, 0, 0, null, 'Team Goblins']);
  assert.deepEqual([lair.game('gm_live1').title, lair.game('gm_live1').seriesId], ['Lost Mine', 'sr_live1']);
  // Every old ref is in the codes table, so a new code can never be the same.
  assert.deepEqual(sql.exec('SELECT key, kind, target_id FROM codes ORDER BY key').toArray().map((r) => [r.key, r.kind, r.target_id]), [
    ['GOBGMH9DX', 'booking', 'bk_gm1'], ['GOBHE7D33', 'booking', 'bk_live3'], ['GOBJ9N22K', 'join', 'ej_live1'], ['GOBPA7D22', 'booking', 'bk_live2'],
    ['GOBSEAT77', 'booking', 'bk_seat1'], ['GOBSEAT22', 'booking', 'bk_seat2'], ['GOB7K2QXM', 'booking', 'bk_live1'],
  ].sort((a, b) => a[0].localeCompare(b[0])));

  // They list: the staff floor, the public floor, My Lair and the POS Today list.
  const floor = (await call('GET', 'floor', null, 'staff')).data;
  const onFloor = (id) => floor.bookings.find((b) => b.id === id);
  assert.deepEqual([onFloor('bk_live1').due, onFloor('bk_live2').due, onFloor('bk_live2').paidAmount, onFloor('bk_live3').status, onFloor('bk_seat1').party.length], [4000, 0, 3000, 'held', 2]);
  assert.deepEqual(floor.games.find((g) => g.id === 'gm_live1').players.map((p) => p.name), ['Mia', 'Kai', 'Leo']);
  assert.deepEqual(floor.joins.map((j) => [j.ref, j.due, j.payment]), [['GOB-J9N22K', 0, 'store']]);
  assert.equal(floor.blocks[0].label, 'Pokémon league');
  assert.equal((await call('GET', 'floor')).data.bookings.find((b) => b.id === 'bk_live1').ref, undefined, 'the public still sees no names or codes');
  const me = (await call('GET', 'me', null, '1001')).data;
  assert.deepEqual(me.bookings.map((b) => [b.ref, b.payment, b.due]), [['GOB-7K2QXM', 'store', 4000], ['GOB-PA7D22', 'online', 0]]);
  assert.deepEqual(me.joins.map((j) => j.ref), ['GOB-J9N22K']);
  assert.match(me.member.code, /^[A-Z]{2}-[A-Z]{3,9}-\d{1,2}$/, 'a member record and code are made the first time');
  assert.deepEqual((await call('GET', 'me', null, 'gm')).data.games.map((g) => [g.title, g.players.length]), [['Lost Mine', 3]]);
  const today = await pos('today');
  assert.deepEqual(today.data.groups.map((g) => [g.key, g.rows.map((r) => r.ref)]), [
    ['tables', ['GOB-7K2QXM', 'GOB-PA7D22']], ['game:gm_live1', ['GOB-SEAT22', 'GOB-SEAT77']], ['event:quiz@2026-10-01', ['GOB-J9N22K']],
  ]);

  // They check in, with or without the dash, at the staff page and the POS.
  const checked = await call('POST', 'checkin', { code: 'gob7k2qxm' }, 'staff');
  assert.deepEqual([checked.status, checked.data.checkedIn, checked.data.row.ref, checked.data.due], [200, true, 'GOB-7K2QXM', 4000]);
  assert.match(checked.data.message, /Checked in: Sam Jones, 4 people at T5\. Charge \$40\.00\./);
  assert.deepEqual((await call('POST', 'checkin', { code: 'GOB-PA7D22' }, 'staff')).data.due, 0);
  Date.now = () => at('2026-10-01', 17, 30);
  const seat = await pos('checkin', { code: 'GOB-SEAT77' });
  assert.deepEqual(seat.data.lines, [{ title: 'GM seat: Lost Mine (GOB-SEAT77)', price: '30.00', quantity: 1, taxable: true, properties: { _booking: 'GOB-SEAT77' } }]);
  assert.deepEqual((await pos('checkin', { code: 'gob seat22' })).data.lines, [], 'paid online in round 8: nothing to pay');
  const quiz = await call('POST', 'checkin', { code: 'GOB-J9N22K' }, 'staff');
  assert.deepEqual([quiz.data.kind, quiz.data.checkedIn, quiz.data.due], ['join', true, 0]);
  Date.now = () => NOW;

  // Payments: Shopify sending round 8's payment again counts nothing; a hold paid after the deploy is recorded.
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.draftOrderOrderId = async (id) => ({ 'gid://shopify/DraftOrder/50': 'gid://shopify/Order/500', 'gid://shopify/DraftOrder/51': 'gid://shopify/Order/501' })[id] || null;
  const line = (id, qty, price, ref) => ({ id, quantity: qty, price, properties: [{ name: '_booking', value: ref }] });
  await internal('orders-paid', { id: 500, admin_graphql_api_id: 'gid://shopify/Order/500', source_name: 'shopify_draft_order', note_attributes: [{ name: '_booking', value: 'GOB-PA7D22' }], line_items: [line(5001, 3, '10.00', 'GOB-PA7D22')] });
  assert.deepEqual([lair.booking('bk_live2').paidAmount, lair.booking('bk_live2').notes], [3000, null], 'not paid twice');
  await internal('orders-paid', { id: 501, admin_graphql_api_id: 'gid://shopify/Order/501', source_name: 'shopify_draft_order', note_attributes: [{ name: '_booking', value: 'GOB-HE7D33' }], line_items: [line(5011, 4, '10.00', 'GOB-HE7D33')] });
  const held = lair.booking('bk_live3');
  assert.deepEqual([held.status, held.paid, held.paidAmount, held.orderId], ['confirmed', true, 4000, 'gid://shopify/Order/501']);
  // The counter pays the rest of a round 8 booking.
  await internal('orders-paid', { id: 503, admin_graphql_api_id: 'gid://shopify/Order/503', source_name: 'pos', line_items: [line(5031, 1, '40.00', 'GOB-7K2QXM')] });
  assert.deepEqual([lair.booking('bk_live1').paid, lair.booking('bk_live1').paidAmount], [true, 4000]);

  // New codes look like SJ-OWLBEAR-17.
  const fresh = await call('POST', 'bookings', tableBooking({ tables: ['T9'], name: 'New Person', email: 'new@example.com' }));
  assert.match(fresh.data.booking.ref, /^NP-[A-Z]{3,9}-\d{1,2}$/);

  // Opening the database again runs nothing twice.
  const after = counts();
  open();
  assert.equal(sql.exec("SELECT value FROM meta WHERE key = 'schema'").one().value, String(MIGRATIONS.length));
  assert.deepEqual(counts(), after);
  assert.equal(lair.booking('bk_live2').paidAmount, 3000);
});

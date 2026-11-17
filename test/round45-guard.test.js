// 17 Nov 2026, before the ads bring strangers (the 16 Nov review's three holes; contract v43-guard):
//  1. Fake bookings: a robot check (Cloudflare Turnstile) on every form that books, signs up or sends an email for
//     someone who isn't logged in, off until both its keys are set; a cap on bookings made without an account for any
//     one day; limits kept in the Durable Object's own tables, so a restart doesn't forget them; and one email to staff
//     when a burst is blocked (at most one an hour).
//  2. Guessable pass codes: a pass nobody is linked to gets a long random code (DG-OWLBEAR-17-K7QM), old codes keep
//     working, and wrong guesses across the whole shop are capped (20 in 24 hours pauses claiming by code online).
//  3. My tab: the Lair prices each thing on a tab itself (Shopify's price, or its own list for the counter's $3 can and
//     $2 water when Shopify can't answer) and ignores the price the page sends; GET /tab/prices gives the page the
//     counter drinks' prices.
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair, GUARD_WORDS, GUARD_LIMITS } from '../src/lair.js';
import { TAB_COUNTER_DRINKS, TAB_PRICE_WORDS } from '../src/tab.js';
import { LairTime, rulesFromSettings } from '../src/core.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const MIN = 60_000;
// Thursday 1 October 2026, 1:00pm in Auckland (NZDT, UTC+13), as in lair.test.js
const NOW = Date.UTC(2026, 9, 1, 0, 0);
const realNow = Date.now;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);

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
  { id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 },
  { id: 'side-room-1', name: 'Side room 1', code: 'A', tables: 4, seats: 4, order: 2 },
];
const TEST_HOURS = 'Mon closed\nTue 12:00-22:00\nWed 12:00-22:00\nThu 12:00-22:00\nFri 12:00-23:00\nSat 10:00-23:00\nSun 10:00-20:00';
const EVENTS = [
  { id: 'quiz', title: 'Trivia night', start: at('2026-10-03', 18), end: at('2026-10-03', 20), tables: '', capacity: 40, entryFee: 500 },
  { id: 'wh', title: 'Warhammer night', start: at('2026-10-03', 18), end: at('2026-10-03', 22), tables: '', gameTables: 'T14+T15, T16+T17, T18+T19', entryFee: 1000 },
];
const QUIZ = 'quiz@2026-10-03';
const WH = 'wh@2026-10-03';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

let lair;
let ctx;
const MOBILE_ROUTES = /^(?:bookings|events\/[^/]+\/(?:join|reserve))$/;
async function call(method, path, body, customer = '', client = '203.0.113.7') {
  const sent = method === 'POST' && body && MOBILE_ROUTES.test(path) && !('phone' in body) ? { ...body, phone: '021 555 0100' } : body;
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, 'X-Lair-Client': client },
    body: sent ? JSON.stringify(sent) : undefined,
  }));
  return { status: response.status, data: await response.json() };
}
const internal = (path, body) => lair.fetch(new Request(`https://lair.test/internal/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body: JSON.stringify(body),
})).then(async (r) => ({ status: r.status, data: await r.json() }));
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const settle = () => new Promise((r) => setTimeout(r, 10));

let n = 0;
/** A guest's table for 2 on Saturday 3 October (a different table, hour and email each time unless said) */
const guestTable = (over = {}) => {
  n += 1;
  const hour = 10 + (n % 12);
  return { kind: 'table', tables: [`T${1 + (n % 12)}`], start: at('2026-10-03', hour), end: at('2026-10-03', hour + 1), people: 2, name: `Guest ${n}`, email: `guest${n}@example.com`, ...over };
};

/** The network: Turnstile's siteverify ('good' passes), Resend (emails kept), and nothing else */
let verified;
let sent;
let siteverifyDown;
const realFetch = globalThis.fetch;
beforeEach(() => {
  verified = [];
  sent = [];
  siteverifyDown = false;
  n = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url) === SITEVERIFY) {
      if (siteverifyDown) throw new Error('Cloudflare is having a moment');
      const form = new URLSearchParams(init.body);
      verified.push(Object.fromEntries(form));
      return new Response(JSON.stringify({ success: form.get('response') === 'good' }), { status: 200 });
    }
    if (String(url).includes('resend')) {
      const body = JSON.parse(init.body);
      for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
      return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
    }
    throw new Error(`No network in tests: ${url}`);
  };
  Date.now = () => NOW;
  ctx = fakeCtx();
  start();
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
});

/** The Lair (again, on the same storage: a restart), emails on, with any config given */
function start(env = {}) {
  lair = new Lair(ctx, {
    CURRENCY: 'NZD', RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test', ...env,
  });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: false });
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, ROOMS, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  return lair;
}
const TURNSTILE = { TURNSTILE_SITE_KEY: '0x4AAAAAAAsitekey', TURNSTILE_SECRET_KEY: '0x4AAAAAAAsecret' };

/* ---------------- 1. the robot check ---------------- */

test('guard: the robot check is off until both keys are set; GET /guard gives the page the site key only', async () => {
  assert.deepEqual((await call('GET', 'guard')).data, { turnstile: null });
  assert.equal((await call('POST', 'bookings', guestTable())).status, 200, 'no keys: a guest books as before');
  for (const half of [{ TURNSTILE_SITE_KEY: 'x' }, { TURNSTILE_SECRET_KEY: 'y' }]) {
    start(half);
    assert.deepEqual((await call('GET', 'guard')).data, { turnstile: null }, 'one key alone is still off');
    assert.equal((await call('POST', 'bookings', guestTable())).status, 200);
  }
  assert.equal(verified.length, 0, 'Cloudflare is never asked while it is off');
  start(TURNSTILE);
  const on = await call('GET', 'guard');
  assert.deepEqual(on.data, { turnstile: { siteKey: '0x4AAAAAAAsitekey' } }, 'the secret never leaves the Lair');
});

test('guard: with the keys set, a guest books only with a token Cloudflare passes; members and staff are never asked', async () => {
  start(TURNSTILE);
  const none = await call('POST', 'bookings', guestTable());
  assert.equal(said(none), `403 ${GUARD_WORDS.robot}`);
  assert.equal(none.data.guard, 'turnstile', 'the page can tell it was the robot check');
  const bad = await call('POST', 'bookings', { ...guestTable(), turnstile: 'bad' });
  assert.equal(said(bad), `403 ${GUARD_WORDS.robot}`);
  const good = await call('POST', 'bookings', { ...guestTable(), turnstile: 'good' });
  assert.equal(good.status, 200, good.data.error);
  assert.deepEqual(verified.at(-1), { secret: '0x4AAAAAAAsecret', response: 'good', remoteip: '203.0.113.7' });
  const asked = verified.length;
  assert.equal((await call('POST', 'bookings', guestTable(), '1001')).status, 200, 'a logged-in member');
  assert.equal((await call('POST', 'bookings', guestTable(), 'staff')).status, 200, 'staff');
  assert.equal(verified.length, asked, 'nobody logged in is checked');
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed'").one().n, 3);
});

test('guard: every logged-out form that books, signs up or sends an email needs the check (seats, sign-ups, game spots, interest, the waitlist, event ideas, emailed picks)', async () => {
  start(TURNSTILE);
  const forms = [
    ['bookings', { kind: 'gm-seat', gameId: 'gm_nope', people: 1, name: 'Sam', email: 'sam@example.com' }],
    [`events/${QUIZ}/join`, { name: 'Sam', email: 'sam@example.com', people: 1 }],
    [`events/${WH}/reserve`, { name: 'Sam', email: 'sam@example.com', people: 2 }],
    ['interest', { kind: 'event', id: QUIZ, name: 'Sam', email: 'sam@example.com', phone: '021 555 0100' }],
    ['interest', { waitlist: true, kind: 'event', id: QUIZ, name: 'Sam', email: 'sam@example.com', phone: '021 555 0100' }],
    ['contact', { kind: 'host-event', name: 'Sam', email: 'sam@example.com', details: 'A big birthday party.' }],
    ['pick/pk_abc/email', { email: 'anyone@example.com', editKey: 'k' }],
  ];
  for (const [path, body] of forms) assert.equal(said(await call('POST', path, body)), `403 ${GUARD_WORDS.robot}`, path);
  // With a good token each goes on to its own rules (the sign-up is made; the rest answer as they always have)
  const joined = await call('POST', `events/${QUIZ}/join`, { name: 'Sam', email: 'sam@example.com', people: 1, turnstile: 'good' });
  assert.equal(joined.status, 200, joined.data.error);
  assert.notEqual((await call('POST', 'pick/pk_abc/email', { email: 'anyone@example.com', editKey: 'k', turnstile: 'good' })).status, 403);
});

test('guard: when Cloudflare cannot be reached the booking goes through (the other limits still hold), and it is noted', async () => {
  start(TURNSTILE);
  siteverifyDown = true;
  const res = await call('POST', 'bookings', { ...guestTable(), turnstile: 'anything' });
  assert.equal(res.status, 200, res.data.error);
  assert.ok(lair.statusSeen.turnstileDown, 'noted for the status table');
  assert.equal(said(await call('POST', 'bookings', guestTable())), `403 ${GUARD_WORDS.robot}`, 'no token at all is still refused');
});

/* ---------------- 1. the day's cap on bookings made without an account ---------------- */

test('guard: a day takes at most GUEST_NIGHT_CAP bookings and sign-ups made without an account; members, staff and other days are untouched', async () => {
  start({ GUEST_NIGHT_CAP: '3' });
  for (let i = 0; i < 2; i += 1) assert.equal((await call('POST', 'bookings', guestTable(), '', `198.51.100.${i}`)).status, 200);
  assert.equal((await call('POST', `events/${QUIZ}/join`, { name: 'Ana', email: 'ana@example.com', people: 1 }, '', '198.51.100.9')).status, 200, 'a sign-up counts too');
  const fourth = await call('POST', 'bookings', guestTable(), '', '198.51.100.20');
  assert.equal(said(fourth), `429 ${GUARD_WORDS.dayFull}`);
  assert.equal(said(await call('POST', `events/${WH}/reserve`, { name: 'Kai', email: 'kai@example.com', people: 2 }, '', '198.51.100.21')), `429 ${GUARD_WORDS.dayFull}`);
  assert.equal((await call('POST', 'bookings', guestTable(), '1001')).status, 200, 'logged in: no cap');
  assert.equal((await call('POST', 'bookings', guestTable(), 'staff')).status, 200, 'staff: no cap');
  assert.equal((await call('POST', 'bookings', guestTable({ start: at('2026-10-04', 12), end: at('2026-10-04', 13) }))).status, 200, 'Sunday has its own');
  // A cancelled one frees its place
  const first = lair.sql.exec("SELECT id FROM bookings WHERE customer_id IS NULL AND status = 'confirmed' ORDER BY created_at LIMIT 1").one().id;
  lair.sql.exec("UPDATE bookings SET status = 'cancelled' WHERE id = ?", first);
  lair.stateCache?.clear?.();
  assert.equal((await call('POST', 'bookings', guestTable(), '', '198.51.100.30')).status, 200);
});

test('guard: the cap is 20 a day unless set, and "off" switches it off', async () => {
  assert.equal(GUARD_LIMITS.guestsPerDay, 20);
  assert.equal(lair.guestDayCap(), 20);
  start({ GUEST_NIGHT_CAP: 'off' });
  assert.equal(lair.guestDayCap(), null);
  start({ GUEST_NIGHT_CAP: '0' });
  assert.equal(said(await call('POST', 'bookings', guestTable())), `429 ${GUARD_WORDS.dayFull}`, '0: no bookings without an account');
});

/* ---------------- 1. limits that survive a restart ---------------- */

test('guard: the 20 bookings in 10 minutes from one address are remembered across a restart', async () => {
  start({ GUEST_NIGHT_CAP: 'off' });
  for (let i = 0; i < 20; i += 1) {
    const res = await call('POST', 'bookings', guestTable({ start: at(i < 10 ? '2026-10-03' : '2026-10-04', 10 + (i % 10)), end: at(i < 10 ? '2026-10-03' : '2026-10-04', 11 + (i % 10)) }));
    assert.equal(res.status, 200, res.data.error);
  }
  start({ GUEST_NIGHT_CAP: 'off' }); // Cloudflare restarts the Durable Object: memory is gone, its tables aren't
  assert.equal(said(await call('POST', 'bookings', guestTable())), '429 Too many bookings in a short time. Call us and we will sort it out.');
  assert.equal((await call('POST', 'bookings', guestTable(), '', '203.0.113.99')).status, 200, 'another address is fine');
  Date.now = () => NOW + 11 * MIN;
  assert.equal((await call('POST', 'bookings', guestTable())).status, 200, 'ten minutes on, another go');
});

test('guard: event ideas (3 an hour) and wrong pass codes (10 in 10 minutes a member) are remembered across a restart too', async () => {
  for (let i = 0; i < 3; i += 1) assert.equal((await call('POST', 'contact', { kind: 'host-event', name: 'Sam', email: 'sam@example.com', details: `Party number ${i}` })).status, 200);
  start();
  assert.equal((await call('POST', 'contact', { kind: 'host-event', name: 'Sam', email: 'sam@example.com', details: 'Party number 4' })).status, 429);
  for (let i = 0; i < 10; i += 1) assert.equal((await call('POST', 'me/passes/claim', { code: `ZZ-GUESS-${i}` }, '1001')).status, 404);
  start();
  assert.equal(said(await call('POST', 'me/passes/claim', { code: 'ZZ-GUESS-11' }, '1001')), '429 Too many tries in a row. Give it ten minutes, or ask us at the counter.');
});

/* ---------------- 1. one email to staff when a burst is blocked ---------------- */

test('guard: a blocked burst sends staff one email, then nothing more for an hour', async () => {
  start({ GUEST_NIGHT_CAP: '1' });
  assert.equal((await call('POST', 'bookings', guestTable())).status, 200);
  sent.length = 0;
  for (let i = 0; i < 5; i += 1) assert.equal((await call('POST', 'bookings', guestTable(), '', `198.51.100.${i}`)).status, 429);
  await settle();
  const alerts = sent.filter((m) => m.to === 'staff@dicegoblin.test');
  assert.equal(alerts.length, 1, 'one email for the burst');
  assert.equal(alerts[0].subject, GUARD_WORDS.alertSubject);
  assert.match(alerts[0].text, /Saturday 3 October/, 'says which day filled up');
  // a restart doesn't make it send again
  start({ GUEST_NIGHT_CAP: '1' });
  await call('POST', 'bookings', guestTable(), '', '198.51.100.50');
  await settle();
  assert.equal(sent.filter((m) => m.to === 'staff@dicegoblin.test').length, 1);
  Date.now = () => NOW + 61 * MIN;
  await call('POST', 'bookings', guestTable(), '', '198.51.100.51');
  await settle();
  assert.equal(sent.filter((m) => m.to === 'staff@dicegoblin.test').length, 2, 'an hour on, still going: another');
});

test('guard: ten failed robot checks in ten minutes are a burst too', async () => {
  start(TURNSTILE);
  for (let i = 0; i < 9; i += 1) await call('POST', 'bookings', { ...guestTable(), turnstile: 'bad' }, '', `198.51.100.${i}`);
  await settle();
  assert.equal(sent.filter((m) => m.to === 'staff@dicegoblin.test').length, 0);
  await call('POST', 'bookings', { ...guestTable(), turnstile: 'bad' }, '', '198.51.100.77');
  await settle();
  const alerts = sent.filter((m) => m.to === 'staff@dicegoblin.test');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /robot check/);
});

/* ---------------- 2. pass codes nobody can guess ---------------- */

const LONG = /^[A-Z]{2}-[A-Z]+-\d{1,2}-[A-HJ-NP-Z2-9]{4}$/;
const SHORT = /^[A-Z]{2}-[A-Z]+-\d{1,2}$/;
const passOrder = (id, lines) => ({ id, admin_graphql_api_id: `gid://shopify/Order/${id}`, source_name: 'pos', line_items: lines });
const passLine = (id, sku, quantity = 1) => ({ id, sku, quantity, price: '100.00', title: 'Session pass', properties: [] });
const passOf = (orderId) => lair.sql.exec('SELECT * FROM passes WHERE order_id = ?', `gid://shopify/Order/${orderId}`).toArray()[0];

test('pass codes: a pass sold with nobody on it gets a long random code; one sold to a member keeps the short one', async () => {
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  lair.shopify.orderSpend = async (id) => ({ customerId: id.endsWith('/1603') ? '3003' : null, amount: 10000, source: 'pos', name: `#${id.split('/').pop()}` });
  lair.shopify.orderBuyer = async (id) => ({ name: `#${id.split('/').pop()}`, billingName: id.endsWith('/1600') ? 'Aroha Ngata' : '', shippingName: '', customerId: null, customerName: '', customerEmail: '' });
  for (const [id, line] of [[1600, 16001], [1601, 16011], [1603, 16031]]) assert.equal((await internal('orders-paid', passOrder(id, [passLine(line, 'LAIR-PASS-10')]))).status, 200);
  assert.match(passOf(1601).code, /^DG-/);
  assert.match(passOf(1601).code, LONG, 'no name at the counter: long');
  assert.match(passOf(1600).code, /^AN-/);
  assert.match(passOf(1600).code, LONG, 'a name but nobody linked: long');
  assert.match(passOf(1603).code, SHORT, 'linked to a member: short, as before');
  // A pass staff make with no member on it is long too; a group's keeps its short code (a group's pass can't be claimed)
  const loose = await call('POST', 'passes', { label: 'Door prize', sessions: 1, holderName: 'Sam Jones' }, 'staff');
  assert.match(loose.data.pass.code, LONG);
  // The long code is claimed like any, typed any way
  const claimed = await call('POST', 'me/passes/claim', { code: passOf(1601).code.toLowerCase().replace(/-/g, ' ') }, '1001');
  assert.equal(claimed.status, 200, claimed.data.error);
});

test('pass codes: a session gift (not an experience) is long too', () => {
  const rules = lair.rulesCache;
  const [made] = lair.issueGiftPasses('gid://shopify/Order/1700', [{ lineId: '17001', quantity: 1, sessions: 3, each: 3000 }], { firstName: 'Kiri' }, { orderName: '#1700', rules, now: NOW });
  assert.match(made.code, LONG);
});

test('pass codes: an old short code still claims; 20 wrong guesses across the shop in 24 hours pause claiming short codes online, and staff hear once', async () => {
  // An old pass, made before today with a short code
  const old = (await call('POST', 'passes', { label: 'Gift pack', sessions: 1, holderName: 'Old Gift' }, 'staff')).data.pass;
  const shortCode = 'OG-OWLBEAR-7';
  lair.sql.exec('UPDATE passes SET code = ? WHERE code = ?', shortCode, old.code);
  lair.sql.exec('UPDATE codes SET key = ?, code = ? WHERE code = ?', 'OGOWLBEAR7', shortCode, old.code);
  const fresh = (await call('POST', 'passes', { label: 'Door prize', sessions: 1, holderName: 'New Gift' }, 'staff')).data.pass;
  assert.match(fresh.code, LONG);
  sent.length = 0;
  // 20 wrong guesses from three accounts (each under its own 10 in 10 minutes), by both doors
  for (let i = 0; i < 20; i += 1) {
    const who = String(2000 + Math.floor(i / 7));
    const res = await call('POST', i % 2 ? 'me/passes/claim' : 'me/codes/redeem', { code: `ZZ-GUESS-${i}` }, who);
    assert.equal(res.status, 404, `guess ${i}`);
  }
  await settle();
  assert.equal(sent.filter((m) => m.to === 'staff@dicegoblin.test').length, 1, 'staff hear about it once');
  // Paused: a short code (real or not) gets the same answer, so nothing can be learned from it
  for (const route of ['me/passes/claim', 'me/codes/redeem']) {
    assert.equal(said(await call('POST', route, { code: shortCode }, '5005')), `429 ${GUARD_WORDS.codesPaused}`, route);
    assert.equal(said(await call('POST', route, { code: 'ZZ-NOPE-1' }, '5005')), `429 ${GUARD_WORDS.codesPaused}`, route);
  }
  // A long code still works, and so does a loot code
  assert.equal((await call('POST', 'me/passes/claim', { code: fresh.code }, '5005')).status, 200);
  assert.equal((await call('POST', 'me/codes/redeem', { code: 'ROLL-FOR-LOOT' }, '5005')).status, 200);
  // A restart doesn't lift it; 24 hours on it lifts, and the old short code is claimed
  start();
  assert.equal((await call('POST', 'me/passes/claim', { code: shortCode }, '5005')).status, 429);
  Date.now = () => NOW + 24 * HOUR + MIN;
  const claimed = await call('POST', 'me/passes/claim', { code: shortCode }, '5005');
  assert.equal(claimed.status, 200, claimed.data.error);
});

/* ---------------- 3. the tab's prices come from the Lair ---------------- */

const CAN = TAB_COUNTER_DRINKS.find((d) => /can/i.test(d.title));
const WATER = TAB_COUNTER_DRINKS.find((d) => /water/i.test(d.title));

test('tab: the counter drinks the Lair knows are the $3 can and the $2 water (the same variants as the theme and the till)', () => {
  assert.deepEqual(TAB_COUNTER_DRINKS.map((d) => [d.variantId, d.title, d.price]), [
    ['51525157716071', 'Can of Drink', 300],
    ['51525157683303', 'Water 600ml', 200],
  ]);
});

function shopifyPrices(prices) {
  const asked = [];
  lair.shopify.tabVariants = async (ids) => {
    asked.push(ids);
    return new Map(ids.filter((id) => prices[id]).map((id) => [id, { price: prices[id].price, title: prices[id].title, variantTitle: prices[id].variantTitle || 'Default Title', sellable: prices[id].sellable !== false }]));
  };
  return asked;
}

test('tab: the price the page sends is ignored; each thing is priced at Shopify\'s price, with Shopify\'s names', async () => {
  const asked = shopifyPrices({ [CAN.variantId]: { price: 300, title: 'Can of Drink' }, 5001: { price: 450, title: 'Pocky', variantTitle: 'Strawberry' } });
  const res = await call('POST', 'tab', { items: [
    { variantId: CAN.variantId, title: 'Can of Drink', variantTitle: '', price: 1, qty: 2 },
    { variantId: '5001', title: 'Free stuff', variantTitle: 'Strawberry', price: 0, qty: 1 },
  ] }, '1001');
  assert.equal(res.status, 200, res.data.error);
  assert.deepEqual(res.data.tab.items.map((x) => [x.variantId, x.title, x.price, x.qty]), [[CAN.variantId, 'Can of Drink', 300, 2], ['5001', 'Pocky', 450, 1]]);
  assert.equal(res.data.tab.total, 1050);
  assert.deepEqual(asked, [[CAN.variantId, '5001']]);
});

test('tab: something Shopify doesn\'t sell is refused, and when Shopify can\'t answer only the counter drinks go on, at the Lair\'s own price', async () => {
  shopifyPrices({ 5001: { price: 450, title: 'Pocky' }, 5002: { price: 9999, title: 'Gift card', sellable: false } });
  assert.equal(said(await call('POST', 'tab', { items: [{ variantId: '4040', title: 'Nope', price: 100, qty: 1 }] }, '1001')), "422 Gobgob doesn't know that one. Pick it from the menu instead.");
  assert.equal(said(await call('POST', 'tab', { items: [{ variantId: '5002', title: 'Gift card', price: 1, qty: 1 }] }, '1001')), "422 Gobgob doesn't know that one. Pick it from the menu instead.");
  lair.shopify.tabVariants = async () => { throw new Error('Shopify is down'); };
  const drinks = await call('POST', 'tab', { items: [{ variantId: WATER.variantId, title: 'Water', price: 0, qty: 1 }, { variantId: CAN.variantId, title: 'Can', price: 0, qty: 1 }] }, '1001');
  assert.equal(drinks.status, 200, drinks.data.error);
  assert.deepEqual(drinks.data.tab.items.map((x) => [x.title, x.price]), [['Water 600ml', 200], ['Can of Drink', 300]]);
  assert.equal(said(await call('POST', 'tab', { items: [{ variantId: '5001', title: 'Pocky', price: 450, qty: 1 }] }, '1001')), `503 ${TAB_PRICE_WORDS.down}`);
});

test('tab: GET /tab/prices gives the page the counter drinks at Shopify\'s price (or the Lair\'s own when Shopify can\'t answer)', async () => {
  shopifyPrices({ [CAN.variantId]: { price: 350, title: 'Can of Drink' }, [WATER.variantId]: { price: 200, title: 'Water 600ml' } });
  assert.equal((await call('GET', 'tab/prices')).status, 401, 'logged in only, like the tab');
  const res = await call('GET', 'tab/prices', null, '1001');
  assert.deepEqual(res.data, { drinks: [
    { productId: CAN.productId, variantId: CAN.variantId, title: 'Can of Drink', price: 350 },
    { productId: WATER.productId, variantId: WATER.variantId, title: 'Water 600ml', price: 200 },
  ] });
  lair.shopify.tabVariants = async () => { throw new Error('down'); };
  lair.tabPriceCache?.clear?.();
  assert.deepEqual((await call('GET', 'tab/prices', null, '1001')).data.drinks.map((d) => d.price), [300, 200]);
});

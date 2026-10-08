// Round 7, backend-a (contract v7.1, sections 1 to 7, 13 to 15): mobile numbers, the player profile, loot codes ("roll
// codes" in the code) and "Got a code?", the loyalty card's number, birthday gifts in words and claimed gifts, library
// holds until midnight, games at home and scanning, and the tab's barcode lookup. Run with: node --test test/
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair, MIGRATIONS } from '../src/lair.js';
import { LairTime, rulesFromSettings, checkMobile, mobileKey, MOBILE_MISSING, MOBILE_WRONG } from '../src/core.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Tuesday 6 October 2026, 1:00pm in Auckland (NZDT, UTC+13): the morning Mo asked for round 7
const NOW = Date.UTC(2026, 9, 6, 0, 0);
const realNow = Date.now;

/* ---------------- helpers (copied from test/lair.test.js) ---------------- */
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
const TEST_HOURS = 'Mon closed\nTue 12:00-22:00\nWed 12:00-22:00\nThu 12:00-22:00\nFri 12:00-23:00\nSat 10:00-23:00\nSun 10:00-20:00';
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Tonight's events: a quiz people sign up for, and Warhammer with game spots
const EVENTS = [
  { id: 'quiz', title: 'Trivia night', start: at('2026-10-06', 18), end: at('2026-10-06', 20), tables: '', capacity: 20 },
  { id: 'warhammer', title: 'Warhammer night', start: at('2026-10-06', 18), end: at('2026-10-06', 21), tables: '', gameTables: 'T14+T15, T16+T17' },
];
/** Library members: their Simplee plan is in their Shopify tags */
const TAGS = { 1001: ['Simplee: Stash'], 1002: ['library-member'], 1003: ['grab-member'], 1004: [], 1005: ['Simplee: HOARD'], staff: ['staff'] };

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
const pos = (path, body = {}) => internal(`pos/${path}`, body);
const maintenance = () => internal('maintenance', { webhookUrl: 'https://lair.test/webhooks/orders-paid' });
const MOBILE = '021 123 4567';
const table = (over = {}) => ({
  kind: 'table', tables: ['T3'], start: at('2026-10-06', 15), end: at('2026-10-06', 17), people: 4, name: 'Sam Jones', email: 'sam@example.com', phone: MOBILE, ...over,
});
const profile = (body, who = '1001') => call('POST', 'me/profile', body, who);
const me = async (who = '1001') => (await call('GET', 'me', null, who)).data;

/** Turn on emails for the Lair and catch everything sent to Resend. Call restore() when done. */
function captureEmails() {
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test' };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return { sent, restore: () => { globalThis.fetch = realFetch; } };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

/** Shopify connected, with the round 7 lookups answered by the test (each records its calls) */
function shopify({ variants = [], uses = {}, copies = {}, fail = null } = {}) {
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  const calls = { variant: [], gift: [], copies: [] };
  lair.shopify.variantByCode = async (code) => {
    calls.variant.push(code);
    if (fail?.variant) throw new Error(fail.variant);
    const same = (v) => String(v || '').toUpperCase() === code.toUpperCase();
    return variants.filter((v) => same(v.barcode) || same(v.sku) || String(v.barcode || '').toUpperCase().startsWith(code.toUpperCase()));
  };
  lair.shopify.giftCodeUse = async (code) => {
    calls.gift.push(code);
    if (fail?.gift) throw new Error(fail.gift);
    return code in uses ? { id: `gid://shopify/DiscountCodeNode/${code}`, status: 'ACTIVE', endsAt: null, uses: uses[code] } : null;
  };
  lair.shopify.variantCopies = async (ids) => {
    calls.copies.push(ids);
    return new Map(ids.map((id) => [id, copies[id] ? { quantity: copies[id], tracked: true } : null]));
  };
  lair.shopify.customerEmail = async () => null;
  lair.shopify.appInfo = async () => ({ app: 'Dice Goblin Lair', shop: 'Dice Goblin', scopes: [] });
  lair.shopify.webhookUris = async () => ['https://lair.test/webhooks/orders-paid'];
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  return calls;
}

/** A shop variant or library copy as LairVariantByCode gives it (shopify.js's variantByCode) */
const variant = (over = {}) => ({
  variantId: '5001', productId: '6001', handle: 'pocky-strawberry', title: 'Default Title', productTitle: 'Pocky (Strawberry)', sku: 'SNK-POCKY', barcode: '9300000000017',
  price: 450, available: true, image: null, productImage: 'https://cdn.shopify.com/s/files/1/pocky.jpg', status: 'ACTIVE', giftCard: false, sellingPlan: false, libraryCode: null,
  ...over,
});
const libraryCopy = (over = {}) => variant({
  variantId: '4401', productId: '9901', handle: 'wingspan-library', productTitle: 'Wingspan (Library)', sku: 'DGL34-001', barcode: 'DGL34-001', price: 0,
  productImage: 'https://cdn.shopify.com/s/files/1/wingspan.jpg', libraryCode: 'DGL34-001', ...over,
});

beforeEach(() => {
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'ep0qiq-rp.myshopify.com' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: id === 'gm', tags: TAGS[id] || [] });
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  // The first start makes the welcome loot code ROLL-FOR-LOOT (tested on its own below); these tests make their own
  lair.sql.exec("DELETE FROM codes WHERE kind = 'roll'");
  lair.sql.exec('DELETE FROM roll_codes');
});
afterEach(() => {
  Date.now = realNow;
});

/* ---------------- 1. mobile numbers ---------------- */

test('mobile numbers (1): New Zealand mobiles and overseas numbers pass, landlines and junk don\'t; kept as typed, compared by their digits', () => {
  for (const ok of ['021 123 4567', '027 1234 5678', '+64 21 123 456', '0211234567', '(021) 123-4567', '021.123.4567', '022 123 45678', '+1 415 555 2671', '+44 7911 123456', '  021   123   4567  ']) {
    assert.ok(checkMobile(ok), ok);
  }
  assert.equal(checkMobile('  021   123   4567  '), '021 123 4567', 'trimmed, runs of spaces made one');
  assert.equal(checkMobile('+64 (21) - 123 - 45678'), '+642112345678', 'longer than 20 characters: its digits and +');
  for (const bad of ['09 123 4567', '+64 9 123 4567', '03 477 1234', '04-123 4567', '021 12', '0800 838 383', 'call me', '+64', '123', '+64 21 123 456 7890 1', '021 123 4567 ext 2']) {
    assert.throws(() => checkMobile(bad), (e) => e.status === 422 && e.message === MOBILE_WRONG, bad);
  }
  assert.throws(() => checkMobile(''), (e) => e.status === 422 && e.message === MOBILE_MISSING);
  assert.throws(() => checkMobile('   '), (e) => e.message === MOBILE_MISSING);
  assert.equal(checkMobile('', { required: false }), '');
  assert.deepEqual([MOBILE_MISSING, MOBILE_WRONG], ['Add a mobile number so we can reach you on the day.', "That mobile number doesn't look right. Try one like 021 123 4567."]);
  assert.equal(mobileKey('021 123 4567'), mobileKey('+64 21 123 4567'));
  assert.equal(mobileKey('021-123-4567'), '64211234567');
  assert.notEqual(mobileKey('021 123 4567'), mobileKey('021 123 4568'));
});

test('mobile numbers (1): required on every customer booking (tables, TTRPG seats for guests and members, "Save my seat every week", event sign-ups and game spots); never on what staff make', async () => {
  const missing = [422, MOBILE_MISSING];
  const wrong = [422, MOBILE_WRONG];
  const said = (res) => [res.status, res.data.error];
  // Tables
  assert.deepEqual(said(await call('POST', 'bookings', table({ phone: undefined }), '1001')), missing);
  assert.deepEqual(said(await call('POST', 'bookings', table({ phone: '09 123 4567' }), '1001')), wrong, 'a landline is refused');
  assert.deepEqual(said(await call('POST', 'bookings', table({ phone: '' }), 'staff')), missing, 'the public page holds staff to it too');
  const booked = await call('POST', 'bookings', table({ phone: ' 021  123 4567 ' }), '1001');
  assert.equal(booked.status, 200, booked.data.error);
  assert.equal(lair.booking(booked.data.booking.id).phone, '021 123 4567', 'kept as typed, tidied');
  // Staff: table bookings with staffOverride and walk-ins need none
  assert.equal((await call('POST', 'bookings', table({ tables: ['T4'], phone: undefined, staffOverride: true }), 'staff')).status, 200);
  assert.equal((await call('POST', 'bookings', { kind: 'walkin', tables: ['T5'], start: NOW, end: NOW + HOUR, people: 2 }, 'staff')).status, 200);
  assert.deepEqual(said(await call('POST', 'bookings', table({ tables: ['T6'], phone: undefined, staffOverride: true }), '1002')), missing, 'staffOverride from someone who isn\'t staff is ignored');
  // TTRPG seats: guests and members
  const game = (await call('POST', 'games', { title: 'Masks', system: 'Masks', gm: 'Ana', email: 'ana@example.com', blurb: 'Teen heroes.', seats: 4, tables: ['A1'], start: at('2026-10-06', 19), end: at('2026-10-06', 22) }, 'gm')).data.game;
  const seat = (body, who = '') => call('POST', 'bookings', { kind: 'gm-seat', gameId: game.id, people: 1, name: 'Hemi Walker', email: 'hemi@example.com', ...body }, who);
  assert.deepEqual(said(await seat({})), missing, 'a guest');
  assert.deepEqual(said(await seat({ phone: '0'.repeat(31) })), wrong, 'round 6\'s 30-character phone retires');
  assert.deepEqual(said(await seat({}, '1001')), missing, 'a member');
  const guest = await seat({ phone: '+44 7911 123456' });
  assert.equal(guest.status, 200, guest.data.error);
  assert.equal(lair.booking(guest.data.booking.id).phone, '+44 7911 123456', 'a visitor\'s mobile');
  // Weekly regulars
  const weekly = (await call('POST', 'games', { title: 'Weekly Delta Green', system: 'Delta Green', gm: 'Ellie', email: 'ellie@example.com', blurb: 'Spooks.', seats: 4, tables: ['A3'], start: at('2026-10-06', 18), end: at('2026-10-06', 21), schedule: 'weekly' }, 'gm')).data.game;
  const join = (body, who = '1002') => call('POST', `games/${weekly.id}/join-series`, { people: 1, name: 'Kiri Smith', email: 'kiri@example.com', ...body }, who);
  assert.deepEqual(said(await join({})), missing);
  assert.deepEqual(said(await join({ phone: '0800 123 456' })), wrong);
  const regular = await join({ phone: '027 555 0123' });
  assert.equal(regular.status, 200, regular.data.error);
  assert.equal(lair.booking(regular.data.booked[0].ref).phone, '027 555 0123', 'their seat carries it');
  // Event sign-ups and game spots
  const signUp = (body) => call('POST', 'events/quiz@2026-10-06/join', { name: 'Leo Tane', email: 'leo@example.com', people: 2, ...body }, '1003');
  assert.deepEqual(said(await signUp({})), missing);
  assert.deepEqual(said(await signUp({ phone: 'nope' })), wrong);
  const signed = await signUp({ phone: '021 999 8888' });
  assert.equal(signed.status, 200, signed.data.error);
  assert.equal(lair.joinById(signed.data.join.id).phone, '021 999 8888', 'event_joins.phone');
  const spot = (body) => call('POST', 'events/warhammer@2026-10-06/reserve', { name: 'Ari Moana', email: 'ari@example.com', people: 2, ...body }, '1004');
  assert.deepEqual(said(await spot({})), missing);
  const spotted = await spot({ phone: '021 777 6666' });
  assert.equal(spotted.status, 200, spotted.data.error);
  assert.equal(lair.booking(spotted.data.booking.id).phone, '021 777 6666');
  // Staff see the sign-up's mobile on the floor and at check-in; the GM's email has the seat's
  const floor = (await call('GET', 'floor', null, 'staff')).data;
  assert.equal(floor.joins.find((j) => j.id === signed.data.join.id).phone, '021 999 8888');
  assert.equal(floor.bookings.find((b) => b.id === spotted.data.booking.id).phone, '021 777 6666');
  const checkin = await call('POST', 'checkin', { code: signed.data.join.ref }, 'staff');
  assert.equal(checkin.data.join.phone, '021 999 8888');
  // Staff adding a player to a game: no mobile needed
  assert.equal((await call('POST', `games/${game.id}/players`, { name: 'Tui Harper', people: 1 }, 'staff')).status, 200);
});

test('mobile numbers (1): a logged-in customer\'s booking saves its mobile to their player profile when it has none or a different one; a weekly regular\'s later seats take their profile mobile', async () => {
  const mobileOf = (id) => lair.memberRow(id)?.mobile ?? null;
  await call('POST', 'bookings', table({ phone: '021 123 4567' }), '1001');
  assert.equal(mobileOf('1001'), '021 123 4567', 'none before: this one');
  assert.equal(lair.memberRow('1001').profile_updated_at, NOW);
  await call('POST', 'bookings', table({ tables: ['T4'], phone: '+64 21 123 4567' }), '1001');
  assert.equal(mobileOf('1001'), '021 123 4567', 'the same number written another way: theirs stays as it was');
  await call('POST', 'bookings', table({ tables: ['T5'], phone: '027 000 1111' }), '1001');
  assert.equal(mobileOf('1001'), '027 000 1111', 'a different one: the new one');
  await call('POST', 'bookings', table({ tables: ['T6'], phone: '021 222 3333', staffOverride: true }), 'staff');
  assert.equal(mobileOf('staff'), null, 'staff making a booking for someone else never save it');
  await call('POST', 'bookings', table({ tables: ['T7'], phone: '021 444 5555', email: 'guest@example.com' }));
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM members WHERE mobile = '021 444 5555'").one().n, 0, 'a guest has no profile');
  // A weekly regular: maintenance's seats carry the mobile on their profile
  const weekly = (await call('POST', 'games', { title: 'Weekly Masks', system: 'Masks', gm: 'Ana', email: 'ana@example.com', blurb: 'Teen heroes.', seats: 4, tables: ['A2'], start: at('2026-10-06', 19), end: at('2026-10-06', 22), schedule: 'weekly' }, 'gm')).data.game;
  await call('POST', `games/${weekly.id}/join-series`, { people: 1, name: 'Sam Jones', email: 'sam@example.com', phone: '027 000 1111' }, '1001');
  await profile({ mobile: '021 888 9999' });
  Date.now = () => at('2026-10-06', 22, 30);
  Object.defineProperty(lair.shopify, 'configured', { value: false, configurable: true });
  await maintenance();
  const next = lair.sql.exec("SELECT * FROM bookings WHERE series_id IS NOT NULL AND customer_id = '1001' ORDER BY starts_at").toArray();
  assert.deepEqual(next.map((b) => [time.key(b.starts_at), b.phone]), [['2026-10-06', '027 000 1111'], ['2026-10-13', '021 888 9999']]);
});

/* ---------------- 2. the player profile ---------------- */

test('player profile (2): name, mobile, birthday, pronouns, favourite games and about me; only the fields sent change; long text is cut; GET /me and staff see it all', async () => {
  assert.deepEqual([(await profile({ pronouns: 'she/her' }, '')).status], [401]);
  const saved = await profile({
    name: 'Aroha Smith', email: 'aroha@example.com', mobile: '021 123 4567', birthday: '10-03', pronouns: '  she/her  ',
    favouriteGames: ['Wingspan', ' Root ', 'wingspan', '', 'Spirit Island', 'Cascadia', 'Azul', 'Catan', 'Everdell', 'Ark Nova', 'Dune: Imperium'],
    about: `  Painter of tiny goblins.\r\nAsk me about Root.  ${'x'.repeat(400)}`,
  });
  assert.equal(saved.status, 200, saved.data.error);
  const { profile: p } = saved.data;
  assert.deepEqual(p.favouriteGames, ['Wingspan', 'Root', 'Spirit Island', 'Cascadia', 'Azul', 'Catan', 'Everdell', 'Ark Nova'], 'repeats (ignoring case) and empty ones dropped, then 8 at most');
  assert.equal(p.about.length, 300);
  assert.ok(p.about.startsWith('Painter of tiny goblins.\nAsk me about Root.'), 'line breaks kept');
  assert.deepEqual([p.name, p.firstName, p.email, p.mobile, p.birthday, p.pronouns, p.updatedAt], ['Aroha Smith', 'Aroha', 'aroha@example.com', '021 123 4567', '10-03', 'she/her', NOW]);
  assert.equal(saved.data.member.customerId, '1001', 'and the member, as before');
  // Limits: pronouns 30, each game 40
  const long = (await profile({ pronouns: 'p'.repeat(40), favouriteGames: ['g'.repeat(50)] })).data.profile;
  assert.deepEqual([long.pronouns.length, long.favouriteGames[0].length], [30, 40]);
  // Only what's sent changes; '' and [] clear
  Date.now = () => NOW + HOUR;
  const cleared = (await profile({ pronouns: '', favouriteGames: [], mobile: '' })).data.profile;
  assert.deepEqual([cleared.pronouns, cleared.favouriteGames, cleared.mobile, cleared.birthday, cleared.email, cleared.updatedAt], ['', [], '', '10-03', 'aroha@example.com', NOW + HOUR]);
  // The mobile follows section 1's rule; the round 3 errors stay
  assert.deepEqual([(await profile({ mobile: '09 123 4567' })).status, (await profile({ mobile: '09 123 4567' })).data.error], [422, MOBILE_WRONG]);
  assert.deepEqual((await profile({ email: 'nope' })).data.error, "That email address doesn't look right.");
  assert.deepEqual((await profile({ birthday: '02-30' })).data.error, 'Pick a real birthday, or leave it empty.');
  await profile({ mobile: '+64 21 555 0100', pronouns: 'she/they', favouriteGames: ['Root'], about: 'Hi!' });
  // GET /me: the profile; the GM profile stays its own block
  const mine = await me();
  assert.deepEqual(mine.profile, {
    name: 'Aroha Smith', firstName: 'Aroha', email: 'aroha@example.com', mobile: '+64 21 555 0100', birthday: '10-03', pronouns: 'she/they',
    favouriteGames: ['Root'], about: 'Hi!', updatedAt: NOW + HOUR,
  });
  assert.equal(mine.gmProfile, null);
  // Staff: GET /members items and the member's own page carry it
  const listed = (await call('GET', 'members?q=aroha', null, 'staff')).data[0];
  assert.deepEqual([listed.mobile, listed.pronouns, listed.favouriteGames, listed.about], ['+64 21 555 0100', 'she/they', ['Root'], 'Hi!']);
  const page = await call('GET', 'members/1001', null, 'staff');
  assert.equal(page.status, 200, page.data.error);
  assert.deepEqual([page.data.member.mobile, page.data.member.profile.pronouns, page.data.member.code], ['+64 21 555 0100', 'she/they', listed.code]);
  assert.equal((await call('GET', 'members/1001', null, '1001')).status, 403);
  assert.deepEqual([(await call('GET', 'members/4040', null, 'staff')).status, (await call('GET', 'members/4040', null, 'staff')).data.error], [404, 'No member with that customer ID.']);
  assert.equal((await call('GET', 'members?q=1001', null, 'staff')).data[0].customerId, '1001', 'the old way to find one still works');
});

test('player profile (2): a game\'s players say who\'s on an account and who\'s a regular; the first player of an account\'s seat brings its pronouns, favourite games and about me, never a mobile, email or birthday', async () => {
  await profile({ name: 'Sam Jones', mobile: '021 123 4567', birthday: '03-04', pronouns: 'he/him', favouriteGames: ['Blades in the Dark'], about: 'Loves a heist.' });
  const weekly = (await call('POST', 'games', { title: 'Weekly Blades', system: 'Blades in the Dark', gm: 'Ana', email: 'ana@example.com', blurb: 'Heists.', seats: 5, tables: ['A1', 'A2'], start: at('2026-10-06', 19), end: at('2026-10-06', 22), schedule: 'weekly' }, 'gm')).data.game;
  await call('POST', `games/${weekly.id}/join-series`, { people: 2, name: 'Sam Jones', email: 'sam@example.com', phone: MOBILE, players: [{ name: 'Sam Jones', character: 'Vex' }, { name: 'Mia', character: 'Cutter' }] }, '1001');
  await call('POST', 'bookings', { kind: 'gm-seat', gameId: weekly.id, people: 1, name: 'Hemi Walker', email: 'hemi@example.com', phone: '021 555 0199' });
  const players = (await call('GET', 'floor', null, 'gm')).data.games.find((g) => g.id === weekly.id).players;
  assert.deepEqual(players, [
    { name: 'Sam Jones', character: 'Vex', ref: players[0].ref, paid: false, arrived: false, member: true, regular: true, pronouns: 'he/him', favouriteGames: ['Blades in the Dark'], about: 'Loves a heist.' },
    { name: 'Mia', character: 'Cutter', ref: players[0].ref, paid: false, arrived: false, member: true, regular: true },
    { name: 'Hemi Walker', character: '', ref: players[2].ref, paid: false, arrived: false, member: false, regular: false },
  ]);
  assert.ok(!JSON.stringify(players).includes('021'), 'no mobile on the board');
  assert.ok(!JSON.stringify(players).includes('03-04') && !JSON.stringify(players).includes('@'), 'nor a birthday or an email');
  assert.equal((await call('GET', 'floor', null, '1002')).data.games.find((g) => g.id === weekly.id).players, undefined, 'anyone else: no players at all');
});

/* ---------------- 3. loot codes ("roll codes") and "Got a code?" ---------------- */

const rollCodes = (status = '', who = 'staff') => call('GET', `roll-codes${status ? `?status=${status}` : ''}`, null, who);
const makeCode = (body, who = 'staff') => call('POST', 'roll-codes', body, who);
const redeem = (code, who = '1001') => call('POST', 'me/codes/redeem', { code }, who);

test('loot codes (3): staff make them, typed or made by Gobgob; every rule has its words; nobody else can', async () => {
  const said = async (body, status, error) => {
    const res = await makeCode(body);
    assert.deepEqual([res.status, res.data.error], [status, error], JSON.stringify(body));
  };
  assert.equal((await makeCode({ code: 'SNEAKY' }, '1001')).status, 403);
  assert.equal((await rollCodes('', '1001')).status, 403);
  // The welcome code everyone gets: typed, 1 roll, no limit, no expiry
  const welcome = await makeCode({ code: 'roll-for-loot', note: "Gobgob's welcome loot, for every customer" });
  assert.equal(welcome.status, 200, welcome.data.error);
  assert.deepEqual(welcome.data.code, {
    id: welcome.data.code.id, code: 'ROLL-FOR-LOOT', rolls: 1, limit: null, uses: 0, left: null, expiresAt: null, status: 'active',
    note: "Gobgob's welcome loot, for every customer", createdAt: NOW, createdBy: 'staff:staff', lastUsedAt: null, recent: [],
  }, 'kept in capitals, 1 roll by default');
  // Made by the Lair: GG-WORD-N
  const made = (await makeCode({ rolls: 3, limit: 50, expires: '2026-10-31', note: 'Market day' })).data.code;
  assert.match(made.code, /^GG-[A-Z]{2,9}-\d{1,2}$/);
  assert.deepEqual([made.rolls, made.limit, made.left, made.expiresAt], [3, 50, 50, at('2026-11-01', 0) - 1], 'the last day it works, until midnight Lair time');
  // Rules
  const CODE = 'Codes are 4 to 24 letters, numbers or dashes, like ROLL-FOR-LOOT.';
  for (const bad of ['ab', 'A-B-C', 'roll for loot', 'LOOT!', 'X'.repeat(25), '----']) await said({ code: bad }, 422, CODE);
  const TAKEN = "That code's taken. Pick another, or leave it empty and Gobgob will make one.";
  await said({ code: 'Roll For Loot'.replace(/ /g, '-').toLowerCase() }, 409, TAKEN);
  await said({ code: 'ROLLFORLOOT' }, 409, TAKEN);
  await profile({ name: 'Sam Jones' });
  await said({ code: lair.memberRow('1001').code }, 409, TAKEN);
  for (const rolls of [0, 21, 1.5, 'lots']) await said({ rolls }, 422, 'A code gives 1 to 20 rolls.');
  for (const limit of [0, -1, 100001, 2.5, 'many']) await said({ limit }, 422, 'The limit is how many times it can be used in all, from 1 up. Leave it empty for no limit.');
  for (const expires of ['soon', '2026-02-30', '31/10/2026']) await said({ expires }, 422, 'Pick the last day it works from the calendar.');
  await said({ expires: '2026-10-05' }, 422, 'That date has already passed.');
  assert.equal((await makeCode({ expires: '2026-10-06', limit: '' })).data.code.limit, null, 'today works until midnight; an empty limit is no limit');
  assert.equal((await makeCode({ note: 'n'.repeat(400) })).data.code.note.length, 300);
  // The list: newest first; active leaves out inactive ones; all is the last 200
  const list = (await rollCodes()).data.codes;
  assert.equal(list.at(-1).code, 'ROLL-FOR-LOOT');
  const off = await call('POST', `roll-codes/${made.id}/update`, { status: 'inactive' }, 'staff');
  assert.equal(off.data.code.status, 'inactive');
  assert.ok(!(await rollCodes('active')).data.codes.some((c) => c.id === made.id));
  assert.ok((await rollCodes('all')).data.codes.some((c) => c.id === made.id));
  // Updates
  const update = (id, body, who = 'staff') => call('POST', `roll-codes/${id}/update`, body, who);
  assert.equal((await update(made.id, { rolls: 2 }, '1001')).status, 403);
  assert.deepEqual([(await update('rc_nope', {})).status, (await update('rc_nope', {})).data.error], [404, 'That code could not be found.']);
  assert.deepEqual((await update(made.id, { status: 'paused' })).data.error, 'A code is active or inactive.');
  const changed = (await update(made.id, { rolls: 2, limit: null, expires: null, note: 'Changed', status: 'active' })).data.code;
  assert.deepEqual([changed.rolls, changed.limit, changed.expiresAt, changed.note, changed.status, changed.code], [2, null, null, 'Changed', 'active', made.code], 'the text never changes');
});

test('loot codes (3): the first start makes the welcome code ROLL-FOR-LOOT once; switched off, it isn\'t made again', async () => {
  const fresh = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'ep0qiq-rp.myshopify.com' });
  fresh.person = lair.person;
  fresh.rulesCache = lair.rulesCache;
  fresh.rulesLoadedAt = lair.rulesLoadedAt;
  const list = (await fresh.fetch(new Request('https://lair.test/roll-codes', { headers: { 'X-Lair-Customer': 'staff' } })).then((r) => r.json())).codes;
  assert.deepEqual(list.map((c) => [c.code, c.rolls, c.limit, c.expiresAt, c.status, c.note, c.createdBy]), [['ROLL-FOR-LOOT', 1, null, null, 'active', "Gobgob's welcome loot, for every customer", 'setup']]);
  fresh.sql.exec("UPDATE roll_codes SET status = 'inactive'");
  fresh.migrate();
  assert.equal(fresh.sql.exec('SELECT COUNT(*) AS n FROM roll_codes').one().n, 1, 'made once');
  assert.equal(fresh.sql.exec("SELECT status FROM roll_codes").one().status, 'inactive', 'switched off stays off');
});

test('loot codes (3): "Got a code?" gives a loot code\'s rolls once per customer, typed any way; the words say so; used up, expired or switched off it stops; it\'s never a ticket', async () => {
  const welcome = (await makeCode({ code: 'ROLL-FOR-LOOT' })).data.code;
  const triple = (await makeCode({ code: 'TRIPLE-LOOT', rolls: 3, limit: 2 })).data.code;
  await profile({ name: 'Sam Jones' });
  await profile({ name: 'Kiri Smith' }, '1002');
  await profile({ name: 'Leo Tane' }, '1003');
  // Nothing gives a welcome roll by itself any more (round 7)
  assert.deepEqual((await me()).loyalty.rolls, { available: 0, earned: { cards: 0, welcome: 0, birthday: 0, staff: 0, codes: 0 }, used: 0 });
  assert.deepEqual([(await redeem('ROLL-FOR-LOOT', '')).status, (await redeem('ROLL-FOR-LOOT', '')).data.error], [401, 'Log in to use a code.']);
  assert.deepEqual([(await redeem('  ')).status, (await redeem('  ')).data.error], [422, 'Type your code first.']);
  const got = await redeem('roll for loot');
  assert.equal(got.status, 200, got.data.error);
  assert.deepEqual([got.data.kind, got.data.rolls, got.data.message], ['roll', 1, "Loot! That's 1 roll for your loyalty card. Roll it on Home, friend."]);
  assert.deepEqual([got.data.loyalty.rolls.available, got.data.loyalty.rolls.earned.codes, got.data.loyalty.card], [1, 1, 1], 'loyalty as GET /me has it');
  const again = await redeem('ROLLFORLOOT');
  assert.deepEqual([again.status, again.data.error], [409, "You've used that code already, friend. It's one go each."]);
  const three = await redeem('triple-loot');
  assert.deepEqual([three.data.rolls, three.data.message], [3, "Loot! That's 3 rolls for your loyalty card. Roll them on Home, friend."]);
  assert.deepEqual((await me()).loyalty.rolls, { available: 4, earned: { cards: 0, welcome: 0, birthday: 0, staff: 0, codes: 4 }, used: 0 });
  // Its grant: kind 'code', the code's rolls, noted with the code, made by code:<id>
  assert.deepEqual(lair.sql.exec("SELECT count, note, created_by FROM loyalty_grants WHERE kind = 'code' ORDER BY created_at, rowid").toArray().map((r) => ({ ...r })), [
    { count: 1, note: 'ROLL-FOR-LOOT', created_by: `code:${welcome.id}` }, { count: 3, note: 'TRIPLE-LOOT', created_by: `code:${triple.id}` },
  ]);
  // Used up (a limit of 2), expired, or switched off: 410
  assert.equal((await redeem('TRIPLE-LOOT', '1002')).status, 200);
  const usedUp = await redeem('TRIPLE-LOOT', '1003');
  assert.deepEqual([usedUp.status, usedUp.data.error], [410, "That code isn't working any more. Ask us at the counter."]);
  const staffView = (await rollCodes()).data.codes.find((c) => c.id === triple.id);
  assert.deepEqual([staffView.status, staffView.uses, staffView.left, staffView.lastUsedAt], ['used-up', 2, 0, NOW]);
  assert.deepEqual(staffView.recent.map((r) => [r.customerId, r.name, r.code]), [['1002', 'Kiri Smith', lair.memberRow('1002').code], ['1001', 'Sam Jones', lair.memberRow('1001').code]], 'the last redeems, newest first');
  assert.deepEqual((await call('POST', `roll-codes/${triple.id}/update`, { limit: 1 }, 'staff')).data.error, "It's been used 2 times, so the limit can't be lower than 2.");
  await call('POST', `roll-codes/${welcome.id}/update`, { status: 'inactive' }, 'staff');
  assert.equal((await redeem('ROLL-FOR-LOOT', '1003')).status, 410, 'switched off');
  await makeCode({ code: 'LAST-DAY', expires: '2026-10-06' });
  Date.now = () => at('2026-10-07', 0, 1);
  assert.equal((await redeem('LAST-DAY', '1003')).status, 410, 'past its last day');
  assert.equal((await rollCodes('all')).data.codes.find((c) => c.code === 'LAST-DAY').status, 'expired');
  // Other codes: a pass is claimed (exactly the claim route), a gift's product code is for the shop, anything else is unknown
  const pass = (await call('POST', 'passes', { label: 'Gift: 5 sessions', sessions: 5, holderName: 'A friend' }, 'staff')).data.pass;
  lair.write('UPDATE passes SET customer_id = NULL, holder_name = NULL WHERE id = ?', pass.id);
  const claimed = await redeem(pass.code.toLowerCase(), '1003');
  assert.deepEqual([claimed.status, claimed.data.kind, claimed.data.pass.code, claimed.data.message], [200, 'pass', pass.code, 'Added to your wallet: Gift: 5 sessions.']);
  assert.deepEqual([(await redeem(pass.code, '1002')).status, (await redeem(pass.code, '1002')).data.error], [409, 'That pass already belongs to someone. Ask us at the counter.']);
  lair.write("INSERT INTO gifts (id, customer_id, year, credit, sessions, rolls, product_title, product_code, product_status, created_at) VALUES ('gf_p', '1001', '2026', 0, 0, 0, 'Blue d20 set', 'HBD-SJOWLBEAR17', 'added', ?)", NOW);
  assert.deepEqual([(await redeem('hbd sjowlbear17')).status, (await redeem('HBD-SJOWLBEAR17')).data.error], [422, "That's a shop discount code. Use it at checkout online, or show it at the counter."]);
  const booking = (await call('POST', 'bookings', table({ start: at('2026-10-07', 15), end: at('2026-10-07', 17) }), '1001')).data.booking;
  for (const code of ['NOPE-NOPE-1', lair.memberRow('1001').code, booking.ref]) {
    assert.deepEqual([(await redeem(code, '1005')).status, (await redeem(code, '1005')).data.error], [404, "Gobgob doesn't know that code. Check it and try again, friend."], code);
  }
  // A loot code is never a ticket: check-in, the POS and the member search don't know it
  assert.deepEqual([(await call('POST', 'checkin', { code: 'TRIPLE-LOOT' }, 'staff')).status, (await call('POST', 'checkin', { code: 'TRIPLE-LOOT' }, 'staff')).data.error], [404, 'No booking, member or pass with that code.']);
  assert.equal((await pos('scan', { code: 'TRIPLE-LOOT' })).status, 404);
  assert.deepEqual((await call('GET', 'members?q=TRIPLE-LOOT', null, 'staff')).data, []);
});

test('loot codes (3): ten tries in ten minutes a member, shared with the claim route; a pass code counts once', async () => {
  await makeCode({ code: 'ROLL-FOR-LOOT' });
  const pass = (await call('POST', 'passes', { label: 'Gift: 5 sessions', sessions: 5, holderName: 'A friend' }, 'staff')).data.pass;
  lair.write('UPDATE passes SET customer_id = NULL, holder_name = NULL WHERE id = ?', pass.id);
  for (let i = 0; i < 4; i += 1) assert.equal((await redeem(`WRONG-${i}`)).status, 404);
  for (let i = 0; i < 4; i += 1) assert.equal((await call('POST', 'me/passes/claim', { code: `WRONG-${i}` }, '1001')).status, 404);
  assert.equal((await redeem(pass.code)).status, 200, 'the 9th try: a pass, counted once');
  assert.equal((await redeem('ROLL-FOR-LOOT')).status, 200, 'the 10th');
  const eleventh = await redeem('ROLL-FOR-LOOT');
  assert.deepEqual([eleventh.status, eleventh.data.error], [429, 'Too many tries in a row. Give it ten minutes, or ask us at the counter.']);
  assert.equal((await call('POST', 'me/passes/claim', { code: pass.code }, '1001')).status, 429, 'the claim route shares the count');
  assert.equal((await redeem('ROLL-FOR-LOOT', '1002')).status, 200, 'per member');
  Date.now = () => NOW + 11 * 60_000;
  assert.equal((await redeem('ROLL-FOR-LOOT')).status, 409, 'ten minutes on, they can try again');
});

/* ---------------- 4. the loyalty card's number ---------------- */

test('loyalty card (4): card is the card they\'re on (cards + 1); a full card\'s roll waits and the next card starts at once; loot codes\' rolls count; staff and the POS see the card', async () => {
  await profile({ name: 'Sam Jones' });
  // 23 stamps: card 3 with 3 stamps, and 2 rolls from cards
  const walkins = [8, 8, 7];
  for (const [i, people] of walkins.entries()) {
    const w = await call('POST', 'bookings', { kind: 'walkin', tables: [`T${10 + i}`], start: NOW, end: NOW + HOUR, people, name: 'Sam Jones' }, 'staff');
    lair.write("UPDATE bookings SET customer_id = '1001' WHERE id = ?", w.data.booking.id);
  }
  const card = (await me()).loyalty;
  assert.deepEqual([card.stamps, card.cards, card.card, card.rolls.available, card.rolls.earned.cards], [3, 2, 3, 2, 2]);
  await makeCode({ code: 'ROLL-FOR-LOOT', rolls: 2 });
  await redeem('ROLL-FOR-LOOT');
  const after = (await me()).loyalty;
  assert.deepEqual([after.card, after.rolls.available, after.rolls.earned], [3, 4, { cards: 2, welcome: 0, birthday: 0, staff: 0, codes: 2 }]);
  assert.deepEqual((await call('GET', 'members?q=1001', null, 'staff')).data[0].loyalty, { stamps: 3, cards: 2, rollsAvailable: 4, card: 3 });
  const scan = await pos('scan', { code: lair.memberRow('1001').code });
  assert.deepEqual(scan.data.loyalty, { stamps: 3, cardSize: 10, rollsAvailable: 4, card: 3 });
  assert.deepEqual((await pos('member', { code: lair.memberRow('1001').code })).data.loyalty, scan.data.loyalty, '/pos/member too');
  // A round 6 welcome roll already given still counts
  lair.write("INSERT INTO loyalty_grants (id, customer_id, kind, count, note, created_by, created_at) VALUES ('lg_w', '1001', 'welcome', 1, NULL, 'lair', ?)", NOW - DAY);
  assert.deepEqual([(await me()).loyalty.rolls.available, (await me()).loyalty.rolls.earned.welcome], [5, 1]);
});

/* ---------------- 5. birthdays and gifts ---------------- */

const giveGift = (body, id = '1001') => call('POST', `members/${id}/gift`, body, 'staff');
/** Shopify for gifts: store credit and product codes work unless told otherwise */
function giftShop({ creditFails = false, codeFails = false } = {}) {
  const calls = shopify();
  lair.shopify.creditCustomer = async () => {
    if (creditFails) throw new Error('Shopify API: Access denied for storeCreditAccountCredit field.');
  };
  lair.shopify.createPrizeCode = async () => {
    if (codeFails) throw new Error('Shopify API: Access denied for discountCodeBasicCreate field.');
    return 'gid://shopify/DiscountCodeNode/1';
  };
  return calls;
}
/** An order paid with discount codes, through the orders/paid webhook */
async function paidWith(codes, { id = 701, name = '#1701', processedAt = NOW + HOUR, customerId = '1001' } = {}) {
  lair.shopify.orderSpend = async () => ({ customerId, amount: 0, source: 'pos', name, discountCodes: codes, processedAt });
  return internal('orders-paid', { id, admin_graphql_api_id: `gid://shopify/Order/${id}`, source_name: 'pos', line_items: [] });
}

test('gifts (5): what a gift was, in words, for staff and members; a product code is ready, then used (an order carried it, noticed from orders/paid once) or ran out; claimed gifts are one line for 30 days, then gone', async () => {
  giftShop();
  await profile({ name: 'Sam Jones', email: 'sam@example.com', birthday: '10-06' });
  lair.write("UPDATE members SET code = 'SJ-OWLBEAR-17' WHERE customer_id = '1001'");
  const gift = (await giveGift({ credit: 20, rolls: 5, productVariantId: '50371432939623', productTitle: 'Riftbound – Vendetta Booster Pack', note: 'Happy birthday, Sam!' })).data.gift;
  assert.deepEqual([gift.state, gift.claimedAt, gift.product.status, gift.product.code, gift.product.expiresAt, gift.note], ['ready', null, 'ready', 'HBD-SJOWLBEAR17', NOW + 30 * DAY, 'Happy birthday, Sam!']);
  assert.equal(gift.words, '$20 store credit, 5 rolls, Riftbound – Vendetta Booster Pack (code HBD-SJOWLBEAR17, until 5 Nov)');
  let mine = (await me()).gifts;
  assert.deepEqual(mine, [{
    id: gift.id, at: NOW, credit: 2000, sessions: 0, rolls: 5,
    product: { title: 'Riftbound – Vendetta Booster Pack', code: 'HBD-SJOWLBEAR17', status: 'ready', expiresAt: NOW + 30 * DAY, usedAt: null },
    state: 'ready', claimedAt: null, words: gift.words,
  }], 'the full card while there\'s something to collect');
  // Sam spends the code at the counter (any case): orders/paid notices, once
  const paid = await paidWith(['hbd-sjowlbear17', 'SOMETHING-ELSE']);
  assert.deepEqual(paid.data.giftCodes, ['HBD-SJOWLBEAR17']);
  assert.deepEqual((await paidWith(['HBD-SJOWLBEAR17'], { id: 702, name: '#1702', processedAt: NOW + 2 * HOUR })).data.giftCodes, [], 'only once');
  mine = (await me()).gifts;
  assert.deepEqual([mine[0].state, mine[0].claimedAt, mine[0].product.status, mine[0].product.usedAt], ['claimed', NOW + HOUR, 'used', NOW + HOUR]);
  assert.equal(mine[0].words, '$20 store credit, 5 rolls, Riftbound – Vendetta Booster Pack (code HBD-SJOWLBEAR17, used 6 Oct)', "Mo's example, word for word");
  const staffGift = (await call('GET', 'members/1001', null, 'staff')).data.member.gifts[0];
  assert.deepEqual([staffGift.product.order, staffGift.product.usedAt, staffGift.words, staffGift.note], ['#1701', NOW + HOUR, mine[0].words, 'Happy birthday, Sam!']);
  // A claimed gift stays a one-line note for 30 days, then it's gone from My Lair (staff still see it)
  Date.now = () => NOW + HOUR + 30 * DAY - 60_000;
  assert.equal((await me()).gifts.length, 1);
  Date.now = () => NOW + HOUR + 30 * DAY + 60_000;
  assert.deepEqual((await me()).gifts, []);
  assert.equal((await call('GET', 'members/1001', null, 'staff')).data.member.gifts.length, 1);
});

test('gifts (5): a code nobody used runs out after 30 days; Shopify couldn\'t make one: collect it at the counter while its days last; credit Shopify didn\'t add and gifts with no product read so; dates carry the year when it isn\'t this year', async () => {
  giftShop();
  await profile({ name: 'Sam Jones', email: 'sam@example.com' });
  const unused = (await giveGift({ productVariantId: '1', productTitle: 'Blue d20 set' })).data.gift;
  giftShop({ codeFails: true, creditFails: true });
  const failed = (await giveGift({ credit: 15, sessions: 3, productVariantId: '2', productTitle: 'Sticker pack' })).data.gift;
  const plain = (await giveGift({ rolls: 1 })).data.gift;
  assert.match(failed.words, /^\$15 store credit \(to give at the counter\), 3 sessions on pass [A-Z]{2}-[A-Z]+-\d+, Sticker pack \(no code yet: give it at the counter\)$/);
  assert.deepEqual([failed.state, failed.product.status, failed.product.code], ['ready', 'failed', null], 'something left to collect at the counter');
  assert.deepEqual([plain.state, plain.claimedAt, plain.words, plain.product], ['claimed', NOW, '1 roll', null], 'nothing left to collect: one line');
  assert.deepEqual((await me()).gifts.map((g) => [g.id, g.state]), [[plain.id, 'claimed'], [failed.id, 'ready'], [unused.id, 'ready']], 'newest first');
  // 30 days on: the code ran out; the failed one isn't listed any more; the roll's line is gone
  Date.now = () => NOW + 30 * DAY + 60_000;
  const later = (await me()).gifts;
  assert.deepEqual(later.map((g) => [g.id, g.state, g.claimedAt]), [[unused.id, 'claimed', NOW + 30 * DAY]]);
  assert.equal(later[0].words, `Blue d20 set (code ${unused.product.code}, ran out 5 Nov)`);
  assert.equal(later[0].product.status, 'expired');
  Date.now = () => NOW + 60 * DAY + 60_000;
  assert.deepEqual((await me()).gifts, [], '30 days after it ran out');
  // Last year's gift: its dates say 2025
  lair.write(
    `INSERT INTO gifts (id, customer_id, year, credit, credit_status, sessions, rolls, product_title, product_code, product_status, product_used_at, product_order, created_at)
     VALUES ('gf_2025', '1001', '2025', 1000, 'added', 0, 0, 'Catan', 'HBD-OLD', 'added', ?, '#1001', ?)`,
    at('2025-11-02', 12), at('2025-10-06', 12),
  );
  const old = (await call('GET', 'members/1001', null, 'staff')).data.member.gifts.find((g) => g.id === 'gf_2025');
  assert.equal(old.words, '$10 store credit, Catan (code HBD-OLD, used 2 Nov 2025)');
});

test('gifts (5): staff see each member\'s gifts this year in words, birthdays suggest no rolls, and a member\'s page has their gifts and library', async () => {
  giftShop();
  await profile({ name: 'Sam Jones', email: 'sam@example.com', birthday: '10-08' });
  await profile({ name: 'Kiri Smith', birthday: '10-20' }, '1002');
  const g1 = (await giveGift({ credit: 10 })).data.gift;
  Date.now = () => NOW + HOUR;
  const g2 = (await giveGift({ rolls: 2, note: 'Second thoughts' })).data.gift;
  lair.write("INSERT INTO gifts (id, customer_id, year, credit, credit_status, sessions, rolls, created_at) VALUES ('gf_last_year', '1001', '2025', 500, 'added', 0, 0, ?)", NOW - 300 * DAY);
  const sam = (await call('GET', 'members?q=1001', null, 'staff')).data[0];
  assert.deepEqual(sam.giftsThisYear, [{ id: g2.id, at: NOW + HOUR, words: '2 rolls' }, { id: g1.id, at: NOW, words: '$10 store credit' }], 'this Lair year\'s, newest first');
  assert.equal(sam.giftedThisYear, true);
  assert.deepEqual((await call('GET', 'members?q=1002', null, 'staff')).data[0].giftsThisYear, []);
  assert.deepEqual((await call('POST', 'members/1001/rolls', { count: 1 }, 'staff')).data.member.giftsThisYear.length, 2, 'the GET /members item, wherever it comes back');
  const birthdays = (await call('GET', 'members/birthdays', null, 'staff')).data;
  assert.deepEqual(birthdays.map((b) => [b.customerId, b.suggested.rolls, typeof b.yearsWithUs]), [['1001', 0, 'number'], ['1002', 0, 'number']]);
  assert.deepEqual(birthdays[0].lastGift.words, '2 rolls');
  const page = (await call('GET', 'members/1001', null, 'staff')).data.member;
  assert.deepEqual(page.gifts.map((g) => g.id), [g2.id, g1.id, 'gf_last_year'], 'every gift, newest first');
  // round 9: and the last few games they brought back
  assert.deepEqual(page.library, { plan: { name: 'Stash', games: 3 }, holds: [], atHome: [], returns: [] });
  assert.deepEqual((await call('GET', 'members/1004', null, 'staff')).status, 404);
});

test('gifts (5): codes from before round 7 are checked with Shopify once each (GET /me and a member\'s page: 5 at a time; maintenance: 20); a code that ran out with no recorded use is checked once more; a failed lookup waits 10 minutes', async () => {
  const calls = giftShop();
  lair.shopify.giftCodeUse = async (code) => {
    calls.gift.push(code);
    if (code === 'HBD-BROKEN' && !lair.fixed) throw new Error('Shopify API error 502');
    return { id: `gid://shopify/DiscountCodeNode/${code}`, status: 'ACTIVE', endsAt: null, uses: code.includes('USED') ? 1 : 0 };
  };
  await profile({ name: 'Sam Jones' });
  await profile({ name: 'Kiri Smith' }, '1002');
  const old = (id, customer, code, made = NOW - 2 * DAY) => lair.write(
    `INSERT INTO gifts (id, customer_id, year, credit, sessions, rolls, product_title, product_code, product_status, created_at)
     VALUES (?, ?, '2026', 0, 0, 0, 'Blue d20 set', ?, 'added', ?)`, id, customer, code, made,
  );
  assert.equal(lair.giftCodesFrom, NOW, 'round 7\'s first start');
  old('gf_a', '1001', 'HBD-SAM-USED');
  old('gf_b', '1001', 'HBD-SAM-FRESH');
  for (let i = 1; i <= 7; i += 1) old(`gf_k${i}`, '1002', `HBD-KIRI-${i}`, NOW - (10 - i) * DAY);
  // Sam opens My Lair: both his are checked; the used one is claimed, dated when it was checked
  Date.now = () => NOW + HOUR;
  const mine = (await me()).gifts;
  assert.deepEqual(calls.gift.slice().sort(), ['HBD-SAM-FRESH', 'HBD-SAM-USED']);
  assert.deepEqual(mine.map((g) => [g.id, g.state, g.product.status, g.product.usedAt]), [['gf_b', 'ready', 'ready', null], ['gf_a', 'claimed', 'used', NOW + HOUR]]);
  await me();
  assert.equal(calls.gift.length, 2, 'once each');
  // Kiri's page: 5 at a time, oldest first
  calls.gift.length = 0;
  await call('GET', 'members/1002', null, 'staff');
  assert.deepEqual(calls.gift, ['HBD-KIRI-1', 'HBD-KIRI-2', 'HBD-KIRI-3', 'HBD-KIRI-4', 'HBD-KIRI-5']);
  await me('1002');
  assert.deepEqual(calls.gift.slice(5), ['HBD-KIRI-6', 'HBD-KIRI-7']);
  // A failed lookup waits 10 minutes; maintenance picks it up later
  calls.gift.length = 0;
  old('gf_x', '1001', 'HBD-BROKEN');
  await me();
  assert.deepEqual(calls.gift, ['HBD-BROKEN']);
  await me();
  await maintenance();
  assert.equal(calls.gift.length, 1, 'not asked again for 10 minutes');
  lair.fixed = true;
  Date.now = () => NOW + HOUR + 11 * 60_000;
  const run = await maintenance();
  assert.deepEqual([calls.gift, run.data.giftCodes], [['HBD-BROKEN', 'HBD-BROKEN'], { checked: 1 }]);
  // A round 7 code is noticed through orders/paid, so it isn't checked... until it runs out with no recorded use: once
  calls.gift.length = 0;
  lair.write("INSERT INTO gifts (id, customer_id, year, credit, sessions, rolls, product_title, product_code, product_status, created_at) VALUES ('gf_new', '1001', '2026', 0, 0, 0, 'Azul', 'HBD-NEW-USED', 'added', ?)", NOW + HOUR);
  await me();
  await maintenance();
  assert.deepEqual(calls.gift, []);
  Date.now = () => NOW + HOUR + 30 * DAY + 60_000;
  await maintenance();
  await maintenance();
  assert.deepEqual(calls.gift, [1, 2, 3, 4, 5, 6, 7].map((i) => `HBD-KIRI-${i}`).concat(['HBD-SAM-FRESH', 'HBD-BROKEN', 'HBD-NEW-USED']), 'once each after their 30 days (the old ones too), oldest first');
  const after = lair.giftRow('gf_new');
  assert.deepEqual([after.product_used_at, after.product_checked_at], [NOW + HOUR + 30 * DAY + 60_000, NOW + HOUR + 30 * DAY + 60_000]);
});

/* ---------------- 6. library: holds until midnight, games at home, scanning ---------------- */

/** POST /library/holds for Wingspan's library copy (variant 4401), as the game's page sends it */
const reserve = (body = {}, who = '1001') => call('POST', 'library/holds', {
  variantId: '4401', productId: '9901', title: 'Wingspan', shelfCode: 'DGL34-001', handle: 'wingspan-library', copies: 2, ...body,
}, who);
const status = async (ids, who = '') => (await call('GET', `library/status?ids=${ids}`, null, who)).data.games;
const scan = (code, who = '1001', action) => call('POST', 'library/scan', { code, ...(action ? { action } : {}) }, who);
const people = async () => {
  for (const [id, name] of [['1001', 'Sam Jones'], ['1002', 'Kiri Smith'], ['1003', 'Leo Tane'], ['1004', 'Ari Moana'], ['1005', 'Tui Harper']]) {
    await profile({ name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, id);
  }
};

test('library (6): holds last until midnight on the third day; collected games are at home (a loan) until they\'re back; copies at home aren\'t on the shelf; a plan counts holds and games at home', async () => {
  await people();
  const mail = captureEmails();
  try {
    const made = await reserve({ image: '//www.dicegoblin.nz/cdn/shop/files/wingspan.jpg' });
    assert.equal(made.status, 200, made.data.error);
    const hold = made.data.hold;
    assert.deepEqual([hold.until, hold.image], [at('2026-10-09', 0), 'https://www.dicegoblin.nz/cdn/shop/files/wingspan.jpg'], 'made Tuesday: until 00:00 Friday ("midnight, Thu 8 Oct"); a // picture is kept as https:');
    assert.equal((await reserve()).data.error, "You've already reserved this one, friend. It's held until midnight, Thu 8 Oct.");
    await settle();
    const toSam = mail.sent.find((m) => m.to === 'sam@example.com');
    assert.match(toSam.text, /Wingspan is on hold for you until midnight on Thursday 8 October\. Collect it at the counter with your member code\./);
    assert.match(toSam.text, /See it in My Lair: https:\/\/www\.dicegoblin\.nz\/pages\/my-lair\?view=library/);
    assert.ok(mail.sent.some((m) => m.subject === 'Hold this game: Wingspan (DGL34-001) for Sam Jones, until midnight on Thursday 8 October'));
    // The Lair knows the game now: its shelf code finds it
    assert.deepEqual({ ...lair.libraryGame('4401') }, { variant_id: '4401', product_id: '9901', title: 'Wingspan', handle: 'wingspan-library', shelf_code: 'DGL34-001', image: 'https://www.dicegoblin.nz/cdn/shop/files/wingspan.jpg', checked_at: NOW });
    assert.equal(lair.sql.exec("SELECT variant_id FROM library_codes WHERE key = 'DGL34001'").one().variant_id, '4401');
    // Collected: the loan is made in the same write
    assert.equal((await call('POST', `library/holds/${hold.id}/update`, { status: 'collected' }, '1001')).status, 403);
    const collected = (await call('POST', `library/holds/${hold.id}/update`, { status: 'collected' }, 'staff')).data;
    assert.deepEqual([collected.hold.status, collected.hold.loanId, collected.loan.status, collected.loan.holdId, collected.loan.customerId, collected.loan.days], ['collected', collected.loan.id, 'out', hold.id, '1001', 0]);
    assert.deepEqual((await status('4401', '1001'))['4401'], { copies: 2, held: 0, out: 1, available: 1, nextFree: null, mine: null, atHome: { id: collected.loan.id, outAt: NOW } });
    // Kiri holds the other copy; Leo is told when it's back; once both are at home there's no date to give
    const kiris = (await reserve({}, '1002')).data.hold;
    assert.deepEqual([(await reserve({}, '1003')).status, (await reserve({}, '1003')).data.error], [409, "Every copy is reserved or out on loan right now. It's back on the shelf by midnight Thu if nobody collects it."]);
    assert.deepEqual((await status('4401'))['4401'], { copies: 2, held: 1, out: 1, available: 0, nextFree: at('2026-10-09', 0), mine: null, atHome: null });
    const kiriLoan = (await call('POST', `library/holds/${kiris.id}/update`, { status: 'collected' }, 'staff')).data.loan;
    assert.deepEqual((await reserve({}, '1003')).data.error, 'Every copy is out on loan right now. Check back soon, friend.');
    assert.deepEqual((await status('4401'))['4401'], { copies: 2, held: 0, out: 2, available: 0, nextFree: null, mine: null, atHome: null });
    // Put back to held (it never went home): the loan goes, and the hold gets a fresh until
    Date.now = () => at('2026-10-07', 10);
    const back = (await call('POST', `library/holds/${kiris.id}/update`, { status: 'held' }, 'staff')).data;
    assert.deepEqual([back.hold.status, back.hold.until, back.loan, lair.loanRow(kiriLoan.id)], ['held', at('2026-10-10', 0), null, null]);
    // Sam's plan (Stash: 3) counts his game at home
    for (const [variantId, title] of [['4402', 'Azul'], ['4403', 'Cascadia']]) assert.equal((await reserve({ variantId, title, shelfCode: '' })).status, 200, title);
    const full = await reserve({ variantId: '4404', title: 'Root', shelfCode: '' });
    assert.deepEqual([full.status, full.data.error], [409, "Your plan has 3 games at a time, and you've got 3: 2 reserved and 1 at home. Return one or cancel a hold first."]);
    const library = (await me()).library;
    assert.deepEqual([library.plan, library.used, library.holds.map((h) => h.title), library.atHome.map((l) => [l.title, l.image, l.status])], [
      { name: 'Stash', games: 3 }, 3, ['Azul', 'Cascadia'], [['Wingspan', 'https://www.dicegoblin.nz/cdn/shop/files/wingspan.jpg', 'out']],
    ]);
    assert.deepEqual(Object.keys(library.atHome[0]), ['id', 'variantId', 'productId', 'title', 'shelfCode', 'handle', 'image', 'status', 'outAt', 'returnedAt', 'holdId']);
    assert.deepEqual((await me()).holds.map((h) => [h.title, h.status]), [['Azul', 'held'], ['Cascadia', 'held'], ['Wingspan', 'collected']], 'round 6\'s holds stay as they were (active, then those that ended lately)');
    // The staff list: pictures, and the loan of a collected hold
    const all = (await call('GET', 'library/holds?status=all', null, 'staff')).data.holds;
    assert.deepEqual(all.find((h) => h.id === hold.id).loanId, collected.loan.id);
    assert.equal(all.find((h) => h.id === hold.id).image, 'https://www.dicegoblin.nz/cdn/shop/files/wingspan.jpg');
    assert.equal('loanId' in all.find((h) => h.id === kiris.id), false, 'only collected holds have one');
  } finally {
    mail.restore();
  }
});

test('library (6): a hold\'s picture is kept only when it\'s a Shopify address (cdn.shopify.com or the store\'s /cdn/shop/ path), up to 500 characters', () => {
  const ok = [
    ['https://cdn.shopify.com/s/files/1/0/wingspan.jpg?v=1', 'https://cdn.shopify.com/s/files/1/0/wingspan.jpg?v=1'],
    ['//www.dicegoblin.nz/cdn/shop/files/azul.png', 'https://www.dicegoblin.nz/cdn/shop/files/azul.png'],
    ['https://ep0qiq-rp.myshopify.com/cdn/shop/files/root.webp', 'https://ep0qiq-rp.myshopify.com/cdn/shop/files/root.webp'],
  ];
  for (const [given, kept] of ok) assert.equal(lair.shopImage(given), kept, given);
  for (const bad of ['http://cdn.shopify.com/s/files/x.jpg', 'https://evil.example/cdn/shop/x.jpg', 'https://www.dicegoblin.nz/pages/x.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', `https://cdn.shopify.com/${'x'.repeat(500)}`, '', null]) {
    assert.equal(lair.shopImage(bad), null, String(bad).slice(0, 40));
  }
});

test('library (6): members borrow and return in the Lair by scanning (a hold of theirs is collected); games the Lair doesn\'t know come from Shopify (read_products); shop products, unknown codes and Shopify being down each have their words', async () => {
  await people();
  const calls = shopify({
    variants: [libraryCopy(), libraryCopy({ variantId: '4402', productId: '9902', handle: 'azul-library', productTitle: 'Azul (Library)', sku: 'DGL34-002', barcode: '9780000000002', libraryCode: 'DGL34-002', productImage: null, image: 'https://cdn.shopify.com/s/files/1/azul-variant.jpg' }), variant()],
    copies: { 4401: 1, 4402: 1 },
  });
  assert.deepEqual([(await scan('DGL34-001', '')).status, (await scan('DGL34-001', '')).data.error], [401, 'Log in to borrow games.']);
  for (const bad of ['', 'DGL 34/001', 'x'.repeat(41)]) assert.deepEqual((await scan(bad)).data.error, 'Scan the barcode on the box, or type the code on its label.', bad);
  // Sam borrows Wingspan: Shopify finds the copy (its library_code), and the Lair remembers it
  const borrowed = await scan('dgl34-001');
  assert.equal(borrowed.status, 200, borrowed.data.error);
  assert.deepEqual([borrowed.data.result, borrowed.data.hold, borrowed.data.message], ['borrowed', null, 'Wingspan is yours to take home. Scan it again when you bring it back.']);
  assert.deepEqual([borrowed.data.loan.title, borrowed.data.loan.shelfCode, borrowed.data.loan.image, borrowed.data.loan.status], ['Wingspan', 'DGL34-001', 'https://cdn.shopify.com/s/files/1/wingspan.jpg', 'out']);
  assert.deepEqual([borrowed.data.library.used, borrowed.data.library.atHome.length], [1, 1], 'their library, fresh');
  assert.deepEqual(calls.variant, ['dgl34-001']);
  // Scanning it again brings it back (no Shopify: the Lair knows the game)
  const returned = await scan('DGL34-001');
  assert.deepEqual([returned.data.result, returned.data.loan.status, returned.data.loan.returnedAt, returned.data.message], ['returned', 'returned', NOW, 'Wingspan is checked back in. Thanks, friend!']);
  assert.equal(calls.variant.length, 1);
  assert.deepEqual([(await scan('DGL34-001', '1001', 'return')).status, (await scan('DGL34-001', '1001', 'return')).data.error], [404, "That game isn't on loan to you."]);
  // A barcode on the box finds it too (Azul's ISBN), with the variant's own picture
  const azul = await scan('9780000000002', '1002');
  assert.deepEqual([azul.data.result, azul.data.loan.title, azul.data.loan.image], ['borrowed', 'Azul', 'https://cdn.shopify.com/s/files/1/azul-variant.jpg']);
  // Rules: a plan, room on it, and a free copy
  assert.deepEqual([(await scan('DGL34-001', '1004')).status, (await scan('DGL34-001', '1004')).data.error], [403, 'Join the library to borrow games, friend.']);
  assert.deepEqual((await scan('DGL34-001', '1002')).data.error, "Your plan has 1 game at a time, and you've got 1: 1 at home. Return one or cancel a hold first.");
  assert.equal((await scan('DGL34-001', '1003')).status, 200, 'Leo takes the only copy');
  assert.deepEqual([(await scan('DGL34-001', '1005')).status, (await scan('DGL34-001', '1005')).data.error], [409, 'Every copy of Wingspan is reserved or out on loan. Ask us at the counter.']);
  // A hold of theirs is collected when they scan it
  await scan('DGL34-001', '1003');
  const held = (await reserve({ copies: 1 }, '1005')).data.hold;
  const collected = await scan('DGL34-001', '1005');
  assert.deepEqual([collected.data.result, collected.data.hold.id, collected.data.hold.status, collected.data.loan.holdId], ['borrowed', held.id, 'collected', held.id]);
  // The shop's barcode, a code nobody has (remembered for 10 minutes), and Shopify refusing (read_products not approved)
  assert.deepEqual([(await scan('9300000000017')).status, (await scan('9300000000017')).data.error], [422, "That's from the shop, not the library. Borrow games from the library shelves, friend."]);
  const before = calls.variant.length;
  assert.deepEqual([(await scan('DGL99-404')).status, (await scan('DGL99-404')).data.error], [404, "Gobgob can't find a library game with that code. Try the code on its label, or ask at the counter."]);
  assert.equal(calls.variant.length, before + 1, 'the miss is remembered');
  lair.shopify.variantByCode = async (code) => {
    calls.variant.push(code);
    throw new Error('Shopify API: Access denied for productVariants field. Required access: `read_products` access scope.');
  };
  const down = await scan('DGL56-002');
  assert.deepEqual([down.status, down.data.error], [503, "Gobgob can't look that game up just now. Ask at the counter and we'll sort it."]);
  assert.equal((await scan('DGL7+-001')).status, 503);
  assert.equal(calls.variant.at(-1), 'DGL56-002', 'not asked again for 10 minutes');
  assert.equal((await scan('DGL34-001', '1005')).data.result, 'returned', 'games the Lair knows still scan');
  // Members hand a game back from My Library too
  const loan = (await scan('DGL34-001', '1005')).data.loan;
  assert.deepEqual([(await call('POST', `library/loans/${loan.id}/return`, {}, '1003')).status, (await call('POST', `library/loans/${loan.id}/return`, {}, '1003')).data.error], [403, "That game isn't on loan to you."]);
  const mine = await call('POST', `library/loans/${loan.id}/return`, {}, '1005');
  assert.deepEqual([mine.data.loan.status, mine.data.library.atHome], ['returned', []]);
  assert.equal((await call('POST', `library/loans/${loan.id}/return`, {}, '1005')).data.loan.returnedAt, NOW, 'one already back comes back as it is');
  assert.deepEqual([(await call('POST', 'library/loans/ln_nope/return', {}, '1005')).status, (await call('POST', 'library/loans/ln_nope/return', {}, '1005')).data.error], [404, 'That loan could not be found.']);
});

test('library (6): staff check games out at the counter (a hold is collected; notices for a full plan, no plan, or no copy on the shelf) and in by scanning, mark any loan back on the shelf, and list games at home', async () => {
  await people();
  shopify({ copies: { 4401: 1 } });
  await reserve({ copies: 1 });
  const out = (body) => call('POST', 'library/loans', body, 'staff');
  assert.equal((await call('POST', 'library/loans', { customerId: '1001', code: 'DGL34-001' }, '1001')).status, 403);
  assert.deepEqual([(await out({ customerId: '4040', code: 'DGL34-001' })).status, (await out({ customerId: '4040', code: 'DGL34-001' })).data.error], [404, 'No member with that customer ID.']);
  const sams = await out({ customerId: '1001', code: 'DGL34-001' });
  assert.equal(sams.status, 200, sams.data.error);
  assert.deepEqual([sams.data.loan.title, sams.data.loan.name, sams.data.loan.code, sams.data.notice], ['Wingspan', 'Sam Jones', lair.memberRow('1001').code, null], 'his hold is collected; within his plan');
  assert.equal(lair.activeHolds('1001').length, 0);
  // A game typed in (no barcode): Kiri gets a second game though her plan is 1, and Shopify says there's 1 copy, at Sam's
  const kiri = await out({ customerId: '1002', variantId: '4401', title: 'Wingspan (Library)', shelfCode: 'DGL34-001', handle: 'wingspan-library' });
  assert.deepEqual(kiri.data.notice, 'Shopify thinks every copy is out. Check the copies on the product.');
  const more = await out({ customerId: '1002', variantId: 'gid://shopify/ProductVariant/4405', title: 'Catan', shelfCode: 'DGL56-001' });
  assert.deepEqual(more.data.notice, "That's more than Kiri's plan (1 game at a time).");
  assert.deepEqual((await out({ customerId: '1004', variantId: '4406', title: 'Root' })).data.notice, "Ari isn't on a library plan.");
  assert.deepEqual((await out({ customerId: '1001', variantId: 'root', title: 'Root' })).data.error, 'Scan the barcode on the box, or type the code on its label.');
  // Checking in by scanning: two copies of Wingspan out, so staff pick; one copy of Catan, so it's back
  const pick = await call('POST', 'library/return', { code: 'DGL34-001' }, 'staff');
  assert.deepEqual([pick.data.result, pick.data.loans.map((l) => l.name)], ['pick', ['Sam Jones', 'Kiri Smith']], 'longest at home first');
  const catan = await call('POST', 'library/return', { code: 'dgl56-001' }, 'staff');
  assert.deepEqual([catan.data.result, catan.data.loan.title, catan.data.loan.status, catan.data.loan.customerId], ['returned', 'Catan', 'returned', '1002']);
  assert.deepEqual([(await call('POST', 'library/return', { code: 'DGL56-001' }, 'staff')).status, (await call('POST', 'library/return', { code: 'DGL56-001' }, 'staff')).data.error], [404, "That game isn't out on loan. It must be on the shelf already."]);
  // "Back on the shelf" for any loan; the lists say how many days each has been at home
  Date.now = () => at('2026-10-09', 11);
  const list = (await call('GET', 'library/loans', null, 'staff')).data.loans;
  assert.deepEqual(list.map((l) => [l.title, l.name, l.days]), [['Wingspan', 'Sam Jones', 3], ['Wingspan', 'Kiri Smith', 3], ['Root', 'Ari Moana', 3]]);
  const shelf = await call('POST', `library/loans/${list[1].id}/return`, {}, 'staff');
  assert.deepEqual([shelf.data.loan.status, shelf.data.loan.returnedAt, shelf.data.loan.days, shelf.data.library], ['returned', at('2026-10-09', 11), 3, undefined]);
  assert.deepEqual((await call('GET', 'library/loans', null, 'staff')).data.loans.length, 2);
  const everything = (await call('GET', 'library/loans?status=all', null, 'staff')).data.loans;
  assert.deepEqual([everything.length, everything.filter((l) => l.status === 'returned').length], [4, 2]);
  assert.equal((await call('GET', 'library/loans', null, '1001')).status, 403);
});

test('migration 17: round 6\'s database moves to round 7 with every row kept; games collected in round 6 are at home; the games its holds named are known by their shelf codes; welcome rolls already given still count', async () => {
  const mine = MIGRATIONS.findIndex((m) => m.some((s) => /CREATE TABLE IF NOT EXISTS roll_codes/.test(s)));
  assert.ok(mine > 0, 'backend-a\'s migration is in the list');
  assert.ok(MIGRATIONS[mine].every((s) => /^\s*(ALTER TABLE \w+ ADD COLUMN|CREATE (UNIQUE )?INDEX IF NOT EXISTS|CREATE TABLE IF NOT EXISTS|INSERT OR IGNORE INTO (library_loans|library_games) )/.test(s)), 'only new columns, tables and indexes, and copies into its own new tables');
  const ctx = fakeCtx();
  const { sql } = ctx.storage;
  sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  for (const statement of MIGRATIONS.slice(0, mine).flat()) sql.exec(statement);
  sql.exec("INSERT INTO meta (key, value) VALUES ('schema', ?)", String(mine));
  sql.exec("INSERT INTO meta (key, value) VALUES ('loyalty-from', ?)", String(NOW - 2 * DAY));
  const row = (table, values) => sql.exec(`INSERT INTO ${table} (${Object.keys(values).join(', ')}) VALUES (${Object.keys(values).map(() => '?').join(', ')})`, ...Object.values(values));
  row('members', { customer_id: '1001', name: 'Sam Jones', first_name: 'Sam', email: 'sam@example.com', code: 'SJ-BADGER-2', last_seen: NOW - DAY, created_at: NOW - DAY, updated_at: NOW - DAY });
  row('loyalty_grants', { id: 'lg_w', customer_id: '1001', kind: 'welcome', count: 1, note: null, created_by: 'lair', created_at: NOW - DAY });
  const hold = (id, variant, status, extra = {}) => row('library_holds', {
    id, variant_id: variant, product_id: '99', title: 'Wingspan', shelf_code: 'DGL34-001', handle: 'wingspan-library', copies: 2, customer_id: '1001', status,
    until: at('2026-10-08', 12), staff_note: null, created_by: 'member', created_at: NOW - DAY, updated_at: NOW - DAY + HOUR, ended_at: status === 'held' ? null : NOW - DAY + HOUR, ...extra,
  });
  hold('lh_collected', '4401', 'collected');
  hold('lh_held', '4402', 'held', { title: 'Azul', shelf_code: 'DGL34-002' });
  hold('lh_gone', '4403', 'cancelled', { title: 'Root', shelf_code: null });
  row('gifts', { id: 'gf_old', customer_id: '1001', year: '2026', credit: 0, sessions: 0, rolls: 2, product_title: 'Blue d20 set', product_code: 'HBD-SJBADGER2', product_status: 'added', created_by: 'staff', created_at: NOW - DAY, updated_at: NOW - DAY });
  const tables = ['members', 'loyalty_grants', 'library_holds', 'gifts', 'codes'];
  // round 7's first start adds one row of its own, the welcome loot code (kind 'roll'), so it isn't counted
  const counts = () => Object.fromEntries(tables.map((t) => [t, sql.exec(t === 'codes' ? "SELECT COUNT(*) AS n FROM codes WHERE kind != 'roll'" : `SELECT COUNT(*) AS n FROM ${t}`).one().n]));
  const before = counts();
  lair = new Lair(ctx, { CURRENCY: 'NZD' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: false, tags: TAGS[id] || [] });
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  assert.equal(sql.exec("SELECT value FROM meta WHERE key = 'schema'").one().value, String(MIGRATIONS.length));
  assert.deepEqual(counts(), before, 'no rows lost or added');
  assert.deepEqual(sql.exec('SELECT * FROM library_loans').toArray().map((r) => ({ ...r })), [{
    id: 'ln_lh_collected', variant_id: '4401', product_id: '99', title: 'Wingspan', shelf_code: 'DGL34-001', handle: 'wingspan-library', image: null, customer_id: '1001',
    hold_id: 'lh_collected', status: 'out', out_at: NOW - DAY + HOUR, returned_at: null, out_by: 'staff', returned_by: null, staff_note: null,
    created_at: NOW - DAY + HOUR, updated_at: NOW - DAY + HOUR,
  }], 'the game collected in round 6 is at home');
  assert.deepEqual(sql.exec('SELECT variant_id, title, shelf_code FROM library_games ORDER BY variant_id').toArray().map((r) => [r.variant_id, r.title, r.shelf_code]), [['4401', 'Wingspan', 'DGL34-001'], ['4402', 'Azul', 'DGL34-002'], ['4403', 'Root', null]]);
  assert.deepEqual(sql.exec('SELECT key, variant_id FROM library_codes ORDER BY key').toArray().map((r) => [r.key, r.variant_id]), [['DGL34001', '4401'], ['DGL34002', '4402']]);
  assert.equal(lair.giftCodesFrom, NOW, 'gifts from before now are checked with Shopify once');
  // The member's view: the game at home, the old hold's 12pm, the welcome roll they had
  const view = await me();
  assert.deepEqual([view.library.atHome.map((l) => l.id), view.library.holds.map((h) => [h.id, h.until]), view.library.used], [['ln_lh_collected'], [['lh_held', at('2026-10-08', 12)]], 2]);
  assert.deepEqual(view.loyalty.rolls.earned, { cards: 0, welcome: 1, birthday: 2, staff: 0, codes: 0 });
  assert.equal(lair.holdDate(view.library.holds[0].until), 'Thu 8 Oct, 12pm', 'a hold from before round 7 keeps its 12pm');
  assert.equal((await call('POST', 'library/scan', { code: 'dgl34-001' }, '1001')).data.result, 'returned', 'a scan finds it by its shelf code');
  // Opening again runs nothing twice
  const after = { ...counts(), loans: sql.exec('SELECT COUNT(*) AS n FROM library_loans').one().n };
  lair = new Lair(ctx, { CURRENCY: 'NZD' });
  assert.deepEqual({ ...counts(), loans: sql.exec('SELECT COUNT(*) AS n FROM library_loans').one().n }, after);
});

/* ---------------- 7. the tab's scanner ---------------- */

test('tab lookup (7): a scanned barcode or SKU becomes a tab item (an Active product that isn\'t a library copy, a gift card or a selling plan); answers are kept 10 minutes; 60 lookups in 10 minutes; Shopify down is a 503', async () => {
  const calls = shopify({
    variants: [
      variant(), variant({ variantId: '5002', title: 'Large', productTitle: 'Flat white', sku: 'CAFE-FW-L', barcode: '', price: 600, available: false, image: 'https://cdn.shopify.com/s/files/1/fw.jpg' }),
      variant({ variantId: '5003', productTitle: 'Old stock', sku: 'OLD-1', barcode: '111', status: 'ARCHIVED' }),
      variant({ variantId: '5004', productTitle: 'Gift card', sku: 'GIFT-50', barcode: '222', giftCard: true }),
      variant({ variantId: '5005', productTitle: 'Dice of the month', sku: 'SUB-DICE', barcode: '333', sellingPlan: true }),
      libraryCopy({ variantId: '4499', sku: 'DGL12-009', barcode: 'DGL12-009', libraryCode: 'DGL12-009' }),
    ],
  });
  const lookup = (code, who = '1001') => call('GET', `tab/lookup?code=${encodeURIComponent(code)}`, null, who);
  assert.deepEqual([(await lookup('9300000000017', '')).status, (await lookup('9300000000017', '')).data.error], [401, 'Log in to start a tab.']);
  for (const bad of ['', 'two words', '<script>']) assert.deepEqual([(await lookup(bad)).status, (await lookup(bad)).data.error], [422, 'Scan a barcode, or type the code under it.'], bad);
  const pocky = await lookup('9300000000017');
  assert.equal(pocky.status, 200, pocky.data.error);
  assert.deepEqual(pocky.data.item, {
    variantId: '5001', productId: '6001', handle: 'pocky-strawberry', title: 'Pocky (Strawberry)', variantTitle: '', price: 450, image: 'https://cdn.shopify.com/s/files/1/pocky.jpg',
    available: true, barcode: '9300000000017', sku: 'SNK-POCKY',
  });
  const fw = (await lookup('cafe-fw-l')).data.item;
  assert.deepEqual([fw.title, fw.variantTitle, fw.price, fw.available, fw.image], ['Flat white', 'Large', 600, false, 'https://cdn.shopify.com/s/files/1/fw.jpg'], 'sold out isn\'t refused here; the variant\'s own picture first');
  const asked = calls.variant.length;
  await lookup('9300000000017');
  assert.equal(calls.variant.length, asked, 'kept 10 minutes');
  const refused = async (code, error) => assert.deepEqual([(await lookup(code)).status, (await lookup(code)).data.error], [422, error], code);
  await refused('111', "That one isn't on sale right now. Ask us at the counter, friend.");
  await refused('222', "That one can't go on a tab. Ask us at the counter, friend.");
  await refused('333', "That one can't go on a tab. Ask us at the counter, friend.");
  await refused('DGL12-009', "That's one of our library games. Borrow it in My Library, friend. It doesn't go on a tab.");
  lair.write("INSERT INTO library_codes (key, variant_id) VALUES ('DGL34001', '4401')");
  const before = calls.variant.length;
  await refused('DGL34-001', "That's one of our library games. Borrow it in My Library, friend. It doesn't go on a tab.");
  assert.equal(calls.variant.length, before, 'a library game the Lair knows needs no Shopify');
  assert.deepEqual([(await lookup('4242424242')).status, (await lookup('4242424242')).data.error], [404, "Gobgob doesn't know that one. Pick it from the menu instead."]);
  // 60 lookups a member in 10 minutes
  for (let i = 0; i < 60; i += 1) await lookup('9300000000017', '1002');
  assert.deepEqual([(await lookup('9300000000017', '1002')).status, (await lookup('9300000000017', '1002')).data.error], [429, 'Easy, friend. Give the scanner a minute.']);
  // Shopify refuses (read_products not approved yet): 503, and it isn't asked again for 10 minutes
  lair.shopify.variantByCode = async (code) => {
    calls.variant.push(code);
    throw new Error('Shopify API: Access denied for productVariants field.');
  };
  Date.now = () => NOW + 11 * 60_000;
  assert.deepEqual([(await lookup('9300000000017', '1003')).status, (await lookup('9300000000017', '1003')).data.error], [503, "Gobgob can't look up barcodes just now. Pick it from the menu instead."]);
  assert.equal(calls.variant.filter((c) => c === '9300000000017').length, 2, 'asked once after its 10 minutes, then not again');
});

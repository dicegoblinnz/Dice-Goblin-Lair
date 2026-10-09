// Round 11, Warhammer (contract v11-warhammer): game tables for 1 v 1 or 2 v 2, a pair of tables picked, the other
// players by member code or email. Mo (9 Oct, 7pm): "people inside the Warhammer group can book their spots with the code
// of Thier opponent or their email to help them join us. They can choose a specific table as well but it needs to be two
// at a time ... set the fee to $10 per person."
// Run with: node --test test/   (under TZ=UTC and TZ=Pacific/Auckland)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair, MIGRATIONS } from '../src/lair.js';
import { LairTime, rulesFromSettings } from '../src/core.js';
import { GAME_PEOPLE, INVITED_NAME, PLAYER_WORDS, spotKey } from '../src/warhammer.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Thursday 15 October 2026, 1:00pm in Auckland (NZDT, UTC+13): the first Warhammer night is tonight
const NOW = Date.UTC(2026, 9, 15, 0, 0);
const realNow = Date.now;

/* ---------------- helpers (as test/round8-guests.test.js) ---------------- */
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

const ROOMS = [
  { id: 'main-room', name: 'Main room', code: 'T', tables: 21, seats: 4, order: 1 },
  { id: 'party-room', name: 'Party room', code: 'P', tables: 4, seats: 4, order: 2 },
  { id: 'gaming-room', name: 'Gaming room', code: 'G', tables: 4, seats: 4, order: 3 },
  { id: 'fancy-room', name: 'Fancy room', code: 'F', tables: 1, seats: 12, price: 15, minPeople: 4, order: 4 },
];
const HOURS = 'Mon 16:00-24:00\nTue 16:00-24:00\nWed 16:00-24:00\nThu 16:00-24:00\nFri 16:00-24:00\nSat 10:00-24:00\nSun 10:00-22:00';
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const TODAY = '2026-10-15';
// Mo's Warhammer night: Thursdays 6pm to midnight, T8-T21 held, six pairs (T16-T17 is the painting station), $10 a person
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
const RUBY = '1004';

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
/** Reserve a game table tonight: Sam Jones by default, logged in, with a mobile */
const reserve = (body = {}, who = SAM, date = TONIGHT) => call('POST', `events/${date}/reserve`, { name: 'Sam Jones', email: 'sam@example.com', phone: MOBILE, people: 2, ...body }, who);
const staffCheckin = (body) => call('POST', 'checkin', body, 'staff');

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

/** Sam Jones books; Kiri Smith, Tama Rewiti and Ruby Hart are members too. Returns their member codes. */
async function members() {
  const codes = {};
  for (const [id, name] of [[SAM, 'Sam Jones'], [KIRI, 'Kiri Smith'], [TAMA, 'Tama Rewiti'], [RUBY, 'Ruby Hart']]) {
    codes[id] = (await call('GET', `me?name=${encodeURIComponent(name)}`, null, id)).data.member.code;
  }
  // members' emails, as their bookings and profiles give them
  for (const [id, email] of [[SAM, 'sam@example.com'], [KIRI, 'kiri@example.com'], [TAMA, 'tama@example.com'], [RUBY, 'ruby@example.com']]) {
    lair.sql.exec('UPDATE members SET email = ? WHERE customer_id = ?', email, id);
  }
  return codes;
}
const playerRows = () => lair.sql.exec('SELECT * FROM booking_players ORDER BY position, rowid').toArray();

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
});

/* ---------------- the table ---------------- */

test('warhammer (round 11): one new table for a game\'s players, in one migration entry, with its three indexes', () => {
  // found by what it makes, not where it sits (the coordinator merges round 11's entries)
  const mine = MIGRATIONS.filter((m) => m.some((s) => /booking_players/.test(s)));
  assert.equal(mine.length, 1);
  assert.match(mine[0][0], /CREATE TABLE IF NOT EXISTS booking_players/);
  const cols = lair.sql.exec("SELECT name FROM pragma_table_info('booking_players')").toArray().map((c) => c.name);
  assert.deepEqual(cols, ['id', 'booking_id', 'role', 'position', 'name', 'customer_id', 'email', 'code', 'invited_at', 'created_at']);
  const indexes = lair.sql.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'booking_players' AND name NOT LIKE 'sqlite_%' ORDER BY name").toArray().map((r) => r.name);
  assert.deepEqual(indexes, ['booking_players_booking', 'booking_players_customer', 'booking_players_email']);
  assert.deepEqual(GAME_PEOPLE, [1, 2, 4]);
  assert.equal(spotKey(['t9 ', 'T8']), 'T8+T9');
});

/* ---------------- picking the pair ---------------- */

test('warhammer (round 11): pick a pair, or get the first free one; the floor lists each pair and whether it\'s free', async () => {
  const codes = await members();
  const floor = (await call('GET', 'floor')).data;
  assert.deepEqual(floor.eventSpots[TONIGHT], { total: 6, taken: 0 }, 'eventSpots stays as it was');
  assert.deepEqual(floor.gameSpots[TONIGHT].map((s) => [s.id, s.label, s.free]), [
    ['T8+T9', 'T8 + T9', true], ['T10+T11', 'T10 + T11', true], ['T12+T13', 'T12 + T13', true], ['T14+T15', 'T14 + T15', true], ['T18+T19', 'T18 + T19', true], ['T20+T21', 'T20 + T21', true],
  ]);
  // "t20 + t21", any case and spacing, is that pair
  const picked = await reserve({ spot: 't20 + t21', players: [{ code: codes[KIRI] }] });
  assert.equal(picked.status, 200, said(picked));
  assert.deepEqual(picked.data.booking.tables, ['T20', 'T21']);
  assert.equal(picked.data.spotsLeft, 5);
  // Left out: the first free one, as before
  const first = await reserve({ name: 'Ruby Hart', email: 'ruby@example.com', players: [{ email: 'leo@example.com' }] }, RUBY);
  assert.deepEqual(first.data.booking.tables, ['T8', 'T9']);
  const after = (await call('GET', 'floor')).data;
  assert.deepEqual(after.gameSpots[TONIGHT].filter((s) => !s.free).map((s) => s.id), ['T8+T9', 'T20+T21']);
  assert.deepEqual(after.eventSpots[TONIGHT], { total: 6, taken: 2 });
  // Taken: a clear 409 (and nothing saved); unknown (the painting station isn't a game table): a 422
  const taken = await reserve({ name: 'Tama Rewiti', email: 'tama@example.com', spot: 'T20+T21', players: [{ email: 'mia@example.com' }] }, TAMA);
  assert.deepEqual([taken.status, taken.data.error], [409, 'T20 + T21 has just been reserved. Pick another pair of tables.']);
  assert.equal(taken.data.error, PLAYER_WORDS.taken('T20 + T21'));
  const painting = await reserve({ name: 'Tama Rewiti', email: 'tama@example.com', spot: 'T16+T17', players: [{ email: 'mia@example.com' }] }, TAMA);
  assert.deepEqual([painting.status, painting.data.error], [422, "T16 + T17 isn't one of this date's game tables. Pick a pair from the list."]);
  assert.equal((await reserve({ spot: 'T9+T10', players: [{ email: 'mia@example.com' }] }, TAMA)).status, 422, 'pairs are the ones staff set');
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM bookings').one().n, 2);
  // Next week's pairs are all free
  assert.ok((await call('GET', `floor?from=${at('2026-10-22', 0)}&to=${at('2026-10-23', 0)}`)).data.gameSpots[NEXT_WEEK].every((s) => s.free));
});

/* ---------------- 1 v 1 and 2 v 2 ---------------- */

test('warhammer (round 11): 1 v 1 (2 players) or 2 v 2 (4 players) at $10 a person; an older page\'s 1 or 2 with no players still works', async () => {
  const codes = await members();
  for (const people of [0, 3, 5, 8]) {
    const bad = await reserve({ people, players: [] });
    assert.deepEqual([bad.status, bad.data.error], [422, PLAYER_WORDS.size], `people ${people}`);
  }
  assert.equal(PLAYER_WORDS.size, 'A game table is for 1 v 1 (2 players) or 2 v 2 (4 players).');
  // 2 v 2: the teammate first, then two opponents; four people at $10 each, split at the counter
  const big = await reserve({ people: 4, players: [{ code: codes[TAMA] }, { code: codes[KIRI] }, { email: 'jo@example.com' }] });
  assert.equal(big.status, 200, said(big));
  const b = big.data.booking;
  assert.deepEqual([b.people, b.amount, b.split, b.gameSize], [4, 4000, true, '2 v 2']);
  assert.deepEqual(b.gamePlayers.map((p) => [p.name, p.role, p.member, p.invited, p.email]), [
    ['Tama Rewiti', 'teammate', true, false, 'tama@example.com'],
    ['Kiri Smith', 'opponent', true, false, 'kiri@example.com'],
    [INVITED_NAME, 'opponent', false, true, 'jo@example.com'],
  ], 'the booker sees the emails they typed (and the members\')');
  assert.deepEqual(playerRows().map((p) => [p.role, p.position, p.customer_id, p.code]), [['teammate', 1, TAMA, codes[TAMA]], ['opponent', 2, KIRI, codes[KIRI]], ['opponent', 3, null, null]]);
  // An older page: 1 or 2 people, no players, as before (no split, no players)
  const old = await reserve({ name: 'Ruby Hart', email: 'ruby@example.com', people: 1 }, RUBY);
  assert.equal(old.status, 200, said(old));
  assert.deepEqual([old.data.booking.people, old.data.booking.amount, old.data.booking.split, old.data.booking.gamePlayers], [1, 1000, false, undefined]);
  const pair = await reserve({ name: 'Leo Fontaine', email: 'leo@example.com', people: 2 }, '');
  assert.deepEqual([pair.status, pair.data.booking.amount], [200, 2000]);
});

test('warhammer (round 11): the other players are checked: the right number, codes members have, emails that are emails, never yourself or anyone twice', async () => {
  const codes = await members();
  const refused = async (body, who = SAM) => {
    const res = await reserve(body, who);
    return [res.status, res.data.error];
  };
  assert.deepEqual(await refused({ people: 4 }), [422, 'Add the other 3 players: a member code or an email each.'], '2 v 2 needs its players');
  assert.deepEqual(await refused({ people: 2, players: [] }), [422, 'Add your opponent: their member code or email.']);
  assert.deepEqual(await refused({ people: 4, players: [{ code: codes[KIRI] }] }), [422, PLAYER_WORDS.count(3)]);
  assert.deepEqual(await refused({ players: [{ code: '  ' }] }), [422, 'Add a member code or an email for each player.']);
  assert.deepEqual(await refused({ players: [{ code: 'zz-nope-1' }] }), [422, "Gobgob doesn't know the member code ZZ-NOPE-1. Check it, or use their email instead."]);
  assert.deepEqual(await refused({ players: [{ email: 'jo@example' }] }), [422, "jo@example doesn't look like an email address. Check it, or use their member code."]);
  assert.deepEqual(await refused({ players: [{ code: codes[SAM].toLowerCase() }] }), [422, "That's your own member code. Add the people you're playing with."]);
  assert.deepEqual(await refused({ players: [{ email: 'SAM@example.com' }] }), [422, "That's your own email. Add the people you're playing with."]);
  assert.deepEqual(await refused({ people: 4, players: [{ code: codes[KIRI] }, { email: 'kiri@example.com' }, { email: 'jo@example.com' }] }), [422, 'Kiri Smith is on the list twice.'], 'her code and her email');
  assert.deepEqual(await refused({ people: 4, players: [{ email: 'jo@example.com' }, { email: 'JO@example.com' }, { code: codes[KIRI] }] }), [422, 'JO@example.com is on the list twice.']);
  // Logged out, your own member code is still yours (it's the email you booked with)
  assert.deepEqual(await refused({ players: [{ code: codes[SAM] }] }, ''), [422, PLAYER_WORDS.own]);
  // Plain strings work as well as { code } and { email }, and a code typed in the email box still finds the member
  const ok = await reserve({ players: [codes[KIRI].replace(/-/g, ' ')] });
  assert.equal(ok.status, 200, said(ok));
  assert.deepEqual(ok.data.booking.gamePlayers.map((p) => p.name), ['Kiri Smith']);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM bookings').one().n, 1, 'nothing was saved for the refused ones');
});

test('warhammer (round 11): an email that belongs to a member links to them; any other email is an invite', async () => {
  const codes = await members();
  // Ruby's Shopify account email (verified) is different from the one in her profile: either finds her
  lair.sql.exec("UPDATE members SET account_email = 'ruby.h@example.com' WHERE customer_id = ?", RUBY);
  const res = await reserve({ people: 4, players: [{ email: 'Ruby.H@example.com' }, { email: 'kiri@example.com' }, { email: 'stranger@example.com' }] });
  assert.equal(res.status, 200, said(res));
  assert.deepEqual(playerRows().map((p) => [p.customer_id, p.email, p.code]), [
    [RUBY, 'Ruby.H@example.com', codes[RUBY]], [KIRI, 'kiri@example.com', codes[KIRI]], [null, 'stranger@example.com', null],
  ]);
});

/* ---------------- emails ---------------- */

test('warhammer (round 11): the booker\'s email says who\'s playing; every other player with an email gets one email (members and invites), once', async () => {
  const codes = await members();
  const mail = captureEmails();
  try {
    const res = await reserve({ people: 4, spot: 'T12+T13', players: [{ code: codes[TAMA] }, { code: codes[KIRI] }, { email: 'jo@example.com' }] });
    assert.equal(res.status, 200, said(res));
    await settle();
    assert.deepEqual(mail.sent.map((m) => m.to).sort(), ['jo@example.com', 'kiri@example.com', 'sam@example.com', 'tama@example.com']);
    const sam = mail.sent.find((m) => m.to === 'sam@example.com');
    assert.match(sam.subject, /^Game spot booked: Warhammer night: /);
    assert.match(sam.text, /Game: +2 v 2\n/);
    assert.match(sam.text, /Playing: +You and Tama Rewiti against Kiri Smith and jo@example\.com\n/);
    assert.match(sam.text, /Fee: +\$10 a person, paid at the counter\. Each player pays their own\.\n/);
    assert.match(sam.text, /Each player pays their own \$10 at the counter\. The others give their member code \(or this booking's code\) when they arrive\./);
    const kiri = mail.sent.find((m) => m.to === 'kiri@example.com');
    const ref = res.data.booking.ref;
    assert.equal(kiri.subject, `Warhammer night with Sam: Thursday, 15 October at 6:00 pm to 12:00 am (${ref})`);
    assert.match(kiri.text, /Kia ora Kiri, Sam Jones has booked a 2 v 2 game with you at Warhammer night, at the Dice Goblin Lair\. Gobgob has saved your tables\./);
    assert.match(kiri.text, /Where: +Tables T12 \+ T13\n/);
    assert.match(kiri.text, /Playing: +Sam Jones and Tama Rewiti against you and an invited player\n/);
    assert.match(kiri.text, /Fee: +\$10 a person, paid at the counter\n/);
    assert.match(kiri.text, /Give your member code at the counter when you arrive: it finds the game\./);
    assert.doesNotMatch(kiri.text, /jo@example\.com/, 'never another player\'s email');
    const tama = mail.sent.find((m) => m.to === 'tama@example.com');
    assert.match(tama.text, /You're on Sam's team\./);
    const jo = mail.sent.find((m) => m.to === 'jo@example.com');
    assert.match(jo.text, /Kia ora there, Sam Jones has booked a 2 v 2 game with you/);
    assert.match(jo.text, /Make your free Dice Goblin account with this email \(jo@example\.com\) and the game shows up in My Lair\. Until then, give the booking code above at the counter\./);
    assert.match(jo.text, /Can't make it\? Let Sam know, so they can find someone else\./);
    assert.match(jo.html, /Make your free account/);
    assert.ok(playerRows().every((p) => p.invited_at === NOW), 'each marked sent');
    // A second confirmation (an online payment, say) never emails the players again
    mail.sent.length = 0;
    lair.confirm(lair.booking(res.data.booking.id), lair.rulesCache);
    await settle();
    assert.deepEqual(mail.sent.map((m) => m.to), ['sam@example.com']);
  } finally {
    mail.restore();
  }
});

/* ---------------- My Lair ---------------- */

test('warhammer (round 11): My Lair: the booker sees the players; a named member sees whose game it is, the tables and their own $10, never an email', async () => {
  const codes = await members();
  const res = await reserve({ people: 4, spot: 'T10+T11', players: [{ code: codes[TAMA] }, { code: codes[KIRI] }, { email: 'jo@example.com' }] });
  const ref = res.data.booking.ref;
  const sam = (await me(SAM)).bookings.find((b) => b.ref === ref);
  assert.deepEqual([sam.gameSize, sam.gamePlayers.length, sam.gamePlayers[2].email, sam.playerOf], ['2 v 2', 3, 'jo@example.com', undefined]);
  const kiri = await me(KIRI);
  assert.equal(kiri.bookings.length, 1);
  const game = kiri.bookings[0];
  assert.deepEqual([game.ref, game.tables, game.playerOf, game.canCancel, game.role, game.ticketCode, game.title, game.gameSize], [ref, ['T10', 'T11'], { name: 'Sam' }, false, 'opponent', codes[KIRI], 'Warhammer night', '2 v 2']);
  assert.deepEqual([game.amount, game.due, game.paidAmount, game.payment, game.split], [1000, 1000, 0, 'store', false], 'their own share, at the counter');
  assert.deepEqual(game.gamePlayers.map((p) => [p.name, p.role, Boolean(p.you)]), [['Sam Jones', 'booker', false], ['Tama Rewiti', 'teammate', false], ['Kiri Smith', 'opponent', true], [INVITED_NAME, 'opponent', false]]);
  assert.ok(!/example\.com/.test(JSON.stringify(kiri.bookings)), 'no emails for a player');
  assert.ok(!JSON.stringify(kiri.bookings).includes(codes[TAMA]), 'nor anyone else\'s member code');
  // It's on what she can pay at the counter today
  assert.deepEqual(kiri.dueNow.map((d) => [d.title, d.due]), [['Game table at Warhammer night', 1000]]);
  // Sam cancels: it shows as cancelled for Kiri, with nothing to pay
  await call('POST', `bookings/${res.data.booking.id}/update`, { status: 'cancelled' }, SAM);
  const off = (await me(KIRI)).bookings[0];
  assert.deepEqual([off.status, off.due], ['cancelled', 0]);
});

test('warhammer (round 11): someone invited by email makes their account with it, and the game is in their My Lair', async () => {
  await members();
  const res = await reserve({ players: [{ email: 'Newbie@Example.com' }] });
  assert.equal(res.status, 200, said(res));
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  lair.shopify.customerEmail = async () => ({ email: 'newbie@example.com', verified: true });
  lair.shopify.checkGiftCodes = async () => 0;
  lair.shopify.giftCodeUse = async () => null;
  const ARI = '5005';
  const mine = (await call('GET', 'me?name=Ari%20Newbie', null, ARI)).data;
  assert.deepEqual(mine.bookings.map((b) => [b.ref, b.playerOf, b.ticketCode]), [[res.data.booking.ref, { name: 'Sam' }, mine.member.code]]);
  assert.deepEqual(playerRows().map((p) => [p.customer_id, p.name, p.code]), [[ARI, 'Ari Newbie', mine.member.code]]);
  // Sam's list now names Ari
  assert.deepEqual((await me(SAM)).bookings[0].gamePlayers.map((p) => [p.name, p.member]), [['Ari Newbie', true]]);
});

/* ---------------- check-in ---------------- */

test('warhammer (round 11): an opponent\'s member code at the staff page finds the game; checking it in checks the game in', async () => {
  const codes = await members();
  const res = await reserve({ spot: 'T14+T15', players: [{ code: codes[KIRI] }] });
  const id = res.data.booking.id;
  const card = await staffCheckin({ code: codes[KIRI] });
  assert.deepEqual([card.status, card.data.kind, card.data.due], [200, 'member', 1000], 'her own $10 is hers to pay');
  const row = card.data.rows.find((r) => r.playerOf);
  assert.deepEqual([row.id, row.bookingId, row.type, row.ref, row.name, row.due, row.amount, row.playerOf, row.player.role], [id, id, 'booking', res.data.booking.ref, 'Kiri Smith', 1000, 1000, { name: 'Sam' }, 'opponent']);
  assert.deepEqual(row.gamePlayers.map((p) => [p.name, p.code]), [['Kiri Smith', codes[KIRI]]], 'staff see the players and their codes');
  assert.equal(card.data.message, `Kiri Smith has no booking of their own today. Sam booked them into a game at Warhammer night at 6:00 pm (${res.data.booking.ref}, their share $10.00).`);
  const checked = await staffCheckin({ id: row.id, type: 'booking' });
  assert.deepEqual([checked.data.checkedIn, checked.data.booking.status], [true, 'seated']);
  assert.deepEqual(checked.data.booking.gamePlayers.map((p) => p.name), ['Kiri Smith']);
  // The staff floor shows the players too; the public floor doesn't
  const staffFloor = (await call('GET', 'floor', null, 'staff')).data;
  assert.deepEqual(staffFloor.bookings.find((b) => b.id === id).gamePlayers.map((p) => [p.name, p.email]), [['Kiri Smith', 'kiri@example.com']]);
  const publicFloor = (await call('GET', 'floor', null, '')).data;
  assert.equal(publicFloor.bookings.find((b) => b.id === id).gamePlayers, undefined);
  // Another day's game isn't on today's card
  await reserve({ players: [{ code: codes[TAMA] }] }, SAM, NEXT_WEEK);
  assert.ok(!(await staffCheckin({ code: codes[TAMA] })).data.rows.length);
});

test('warhammer (round 11): at the POS, an opponent\'s code finds the game with their own share; paying it pays their part of the booking', async () => {
  const codes = await members();
  const res = await reserve({ people: 4, spot: 'T18+T19', players: [{ code: codes[TAMA] }, { code: codes[KIRI] }, { email: 'jo@example.com' }] });
  const ref = res.data.booking.ref;
  const scan = await internal('pos/scan', { code: codes[KIRI] });
  assert.equal(scan.status, 200, said(scan));
  const row = scan.data.rows.find((r) => r.playerOf);
  assert.ok(row.id.startsWith('bp_'), 'the POS checks in her own row');
  assert.deepEqual([row.ref, row.name, row.customerId, row.due, row.split], [ref, 'Kiri Smith', KIRI, 1000, false]);
  // Checking her row in checks the game in, and her line is her $10, with the booking's code
  const checked = await internal('pos/checkin', { id: row.id, type: 'booking' });
  assert.equal(checked.status, 200, said(checked));
  assert.deepEqual([checked.data.checkedIn, checked.data.row.due, checked.data.customer], [true, 1000, { id: KIRI }]);
  assert.deepEqual(checked.data.lines, [{ title: `Game spot share: Warhammer night (${ref}, Kiri Smith)`, price: '10.00', quantity: 1, taxable: true, properties: { _booking: ref, _share: '1' } }]);
  assert.equal(lair.booking(res.data.booking.id).status, 'seated');
  // She pays at the POS with her account on the order: $10 off the booking, and her share is done
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  lair.shopify.orderSpend = async () => ({ customerId: KIRI, amount: 1000, source: 'pos' });
  const paid = await internal('orders-paid', { id: 9101, admin_graphql_api_id: 'gid://shopify/Order/9101', source_name: 'pos', line_items: [{ id: 91011, quantity: 1, price: '10.00', properties: [{ name: '_booking', value: ref }, { name: '_share', value: '1' }] }] });
  assert.equal(paid.status, 200, said(paid));
  const after = lair.booking(res.data.booking.id);
  assert.deepEqual([after.paidAmount, after.paid], [1000, false]);
  assert.deepEqual((await internal('pos/scan', { code: codes[KIRI] })).data.rows.find((r) => r.playerOf).due, 0, 'nothing more for her');
  assert.equal((await internal('pos/scan', { code: codes[TAMA] })).data.rows.find((r) => r.playerOf).due, 1000, 'Tama still owes his');
  assert.equal((await me(KIRI)).bookings[0].due, 0);
  // "Check in everyone" for Tama: the game's already in; his line is his share
  const tama = await internal('pos/checkin-member', { customerId: TAMA });
  assert.deepEqual(tama.data.lines.map((l) => [l.price, l.properties._booking]), [['10.00', ref]]);
  // The booker's own code still finds the whole booking ($30 left), for the split as before
  const sam = await internal('pos/scan', { code: codes[SAM] });
  assert.deepEqual(sam.data.rows.map((r) => [r.ref, r.due, r.split, Boolean(r.playerOf)]), [[ref, 3000, true, false]]);
});

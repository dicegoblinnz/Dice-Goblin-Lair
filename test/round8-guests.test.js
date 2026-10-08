// Round 8, guests (contract v8, section 2): friends on event sign-ups, each by member code or by name. Mo (6 Oct): "For
// signing up for events always ask if they intend to get another person and have it as a thing to add another and
// another etc.etc. with either their code and if they don't have one state their name etc."
// Run with: node --test test/   (under TZ=UTC and TZ=Pacific/Auckland)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair, MIGRATIONS } from '../src/lair.js';
import { LairTime, rulesFromSettings, guestList, GUEST_LIMIT, GUEST_MESSAGES } from '../src/core.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Friday 9 October 2026, 1:00pm in Auckland (NZDT, UTC+13): round 8
const NOW = Date.UTC(2026, 9, 9, 0, 0);
const realNow = Date.now;

/* ---------------- helpers (as test/round7-a.test.js) ---------------- */
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
  { id: 'fancy-room', name: 'Fancy room', code: 'F', tables: 1, seats: 12, price: 15, minPeople: 4, order: 4 },
];
const TEST_HOURS = 'Mon closed\nTue 12:00-22:00\nWed 12:00-22:00\nThu 12:00-22:00\nFri 12:00-23:00\nSat 10:00-23:00\nSun 10:00-20:00';
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const TODAY = '2026-10-09';
// Tonight's trivia ($5 at the counter, 20 places), paint night next week (4 places, free) and a tournament paid online
const EVENTS = [
  { id: 'quiz', title: 'Trivia night', start: at(TODAY, 18), end: at(TODAY, 20), tables: '', capacity: 20, entryFee: 500 },
  { id: 'paint', title: 'Paint night', start: at('2026-10-16', 18), end: at('2026-10-16', 21), tables: '', capacity: 4 },
  { id: 'champs', title: 'Riftbound championship', start: at('2026-10-18', 11), end: at('2026-10-18', 17), tables: '', capacity: 32, entryFee: 2500, payment: 'online' },
];
const QUIZ = `quiz@${TODAY}`;
const PAINT = 'paint@2026-10-16';
const CHAMPS = 'champs@2026-10-18';
const MOBILE = '021 555 0100';
const SAM = '1001';
const KIRI = '1002';
const TAMA = '1003';

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
/** Sign up for an event date: Sam Jones by default, logged in, with a mobile */
const join = (id, body = {}, who = SAM) => call('POST', `events/${encodeURIComponent(id).replace(/%40/g, '@')}/join`, { name: 'Sam Jones', email: 'sam@example.com', phone: MOBILE, ...body }, who);
const staffCheckin = (body) => call('POST', 'checkin', body, 'staff');
const loyalty = async (who) => (await me(who)).loyalty;

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

/** The three members: Sam Jones signs up, Kiri Smith and Tama Rewiti come along by their codes. Returns their codes. */
async function members() {
  const codes = {};
  for (const [id, name] of [[SAM, 'Sam Jones'], [KIRI, 'Kiri Smith'], [TAMA, 'Tama Rewiti']]) {
    codes[id] = (await call('GET', `me?name=${encodeURIComponent(name)}`, null, id)).data.member.code;
  }
  return codes;
}
const guestRows = () => lair.sql.exec('SELECT * FROM event_join_guests ORDER BY rowid').toArray();

beforeEach(() => {
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'ep0qiq-rp.myshopify.com' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: false, tags: [] });
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
});
afterEach(() => {
  Date.now = realNow;
});

/* ---------------- the table, and the guest list's shape ---------------- */

test('guests (round 8): one new table for guests on sign-ups, in the last migration, with its two indexes', () => {
  const last = MIGRATIONS[MIGRATIONS.length - 1].join('\n');
  assert.match(last, /CREATE TABLE IF NOT EXISTS event_join_guests/);
  const cols = lair.sql.exec("SELECT name FROM pragma_table_info('event_join_guests')").toArray().map((c) => c.name);
  assert.deepEqual(cols, ['id', 'join_id', 'customer_id', 'name', 'code', 'created_at']);
  const indexes = lair.sql.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event_join_guests' AND name NOT LIKE 'sqlite_%' ORDER BY name").toArray().map((r) => r.name);
  assert.deepEqual(indexes, ['event_join_guests_customer', 'event_join_guests_join']);
});

test('guests (round 8): the list is checked for shape first: up to 5, each with a code or a name; codes in capitals, names tidied', () => {
  assert.equal(GUEST_LIMIT, 5);
  assert.deepEqual(guestList([{ code: ' kiri-smith 3 ' }, { name: '  Jo   Bloggs ' }, { code: 'sj-owlbear-17', name: 'Sam' }]), [
    { code: 'KIRI-SMITH 3', key: 'KIRISMITH3', name: '' },
    { code: '', key: '', name: 'Jo Bloggs' },
    { code: 'SJ-OWLBEAR-17', key: 'SJOWLBEAR17', name: 'Sam' },
  ]);
  assert.equal(guestList([{ name: 'x'.repeat(90) }])[0].name.length, 80, 'names are cut to 80 characters');
  assert.deepEqual(guestList([{ code: '--', name: 'Jo' }])[0], { code: '', key: '', name: 'Jo' }, 'a code of only dashes is no code');
  assert.deepEqual(guestList([]), []);
  assert.throws(() => guestList(Array.from({ length: 6 }, (_, i) => ({ name: `Friend ${i}` }))), (e) => e.status === 422 && e.message === 'Sign up between 1 and 6 people.');
  for (const bad of [{}, { code: '', name: '   ' }, null, 'Jo']) {
    assert.throws(() => guestList([{ name: 'Jo' }, bad]), (e) => e.status === 422 && e.message === GUEST_MESSAGES.missing, JSON.stringify(bad));
  }
  assert.deepEqual([GUEST_MESSAGES.missing, GUEST_MESSAGES.unknown('ZZ-NOPE-1'), GUEST_MESSAGES.own, GUEST_MESSAGES.twice('Kiri Smith'), GUEST_MESSAGES.guestOnly], [
    'Add a name or a member code for each person coming, or take them off the list.',
    "Gobgob doesn't know the member code ZZ-NOPE-1. Check it, or put their name instead.",
    "That's your own member code, friend. Add the people coming with you.",
    'Kiri Smith is on the list twice.',
    'Only the person who signed up can change this. Ask them, or the counter.',
  ]);
});

/* ---------------- signing up with guests ---------------- */

test('guests (round 8): a member by their code (any case, no dashes) and a friend by name: 3 people, the fee for 3, the names the Lair has', async () => {
  const codes = await members();
  const typed = codes[KIRI].toLowerCase().replace(/-/g, '');
  const res = await join(QUIZ, { people: 1, guests: [{ code: typed }, { name: '  Jo  ' }] });
  assert.equal(res.status, 200, res.data.error);
  const j = res.data.join;
  assert.deepEqual([j.people, j.amount, j.due, res.data.spacesLeft], [3, 1500, 1500, 17], 'people is 1 + guests (the body\'s people is ignored), and the fee is for everyone');
  assert.deepEqual(j.guests, [{ name: 'Kiri Smith', member: true }, { name: 'Jo', member: false }], 'the person who signed up sees names and who has an account, never a code or an ID');
  assert.deepEqual(guestRows().map((g) => [g.join_id, g.customer_id, g.name, g.code]), [[j.id, KIRI, 'Kiri Smith', codes[KIRI]], [j.id, null, 'Jo', null]]);
  // The code wins over a name typed with it, and the name kept is the Lair's
  const both = await join(PAINT, { guests: [{ code: codes[TAMA], name: 'Tama the Great' }] });
  assert.deepEqual(both.data.join.guests, [{ name: 'Tama Rewiti', member: true }]);
  // The places left follow: 3 taken tonight
  assert.equal((await call('GET', 'floor')).data.eventJoins[QUIZ], 3);
});

test('guests (round 8): the messages, and nothing is saved when one is refused', async () => {
  const codes = await members();
  const refused = [
    [{ guests: [{ name: 'Jo' }, {}] }, `422 ${GUEST_MESSAGES.missing}`],
    [{ guests: [{ code: 'zz-nope-1', name: 'Zed' }] }, "422 Gobgob doesn't know the member code ZZ-NOPE-1. Check it, or put their name instead."],
    [{ guests: [{ code: codes[SAM].toLowerCase() }] }, "422 That's your own member code, friend. Add the people coming with you."],
    [{ guests: [{ code: codes[KIRI] }, { name: 'Jo' }, { code: codes[KIRI].replace(/-/g, ' ').toLowerCase() }] }, '422 Kiri Smith is on the list twice.'],
    [{ guests: Array.from({ length: 6 }, (_, i) => ({ name: `Friend ${i + 1}` })) }, '422 Sign up between 1 and 6 people.'],
  ];
  for (const [body, words] of refused) assert.equal(said(await join(QUIZ, body)), words, JSON.stringify(body));
  // A booking's or a pass's code isn't a member code
  const table = await call('POST', 'bookings', { kind: 'table', tables: ['T3'], start: at('2026-10-10', 15), end: at('2026-10-10', 17), people: 2, name: 'Kiri Smith', email: 'kiri@example.com', phone: MOBILE }, KIRI);
  assert.equal(said(await join(QUIZ, { guests: [{ code: table.data.booking.ref }] })), `422 Gobgob doesn't know the member code ${table.data.booking.ref}. Check it, or put their name instead.`);
  // A member code staff replaced finds nobody; the new one works
  const fresh = (await call('POST', `members/${KIRI}/new-code`, {}, 'staff')).data.code;
  assert.equal(said(await join(QUIZ, { guests: [{ code: codes[KIRI] }] })), `422 Gobgob doesn't know the member code ${codes[KIRI]}. Check it, or put their name instead.`);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM event_joins').one().n, 0, 'no sign-up was saved');
  assert.equal(guestRows().length, 0, 'no guest was saved');
  const ok = await join(QUIZ, { guests: [{ code: fresh }] });
  assert.equal(ok.status, 200, ok.data.error);
  // Logged out, their own code is just a member coming along (the Lair can't know it's them)
  const loggedOut = await join(PAINT, { guests: [{ code: codes[SAM] }] }, '');
  assert.deepEqual([loggedOut.status, loggedOut.data.join?.guests], [200, [{ name: 'Sam Jones', member: true }]]);
});

test('guests (round 8): places count everyone, the entry fee is for everyone, and paying online takes them all', async () => {
  const codes = await members();
  // Paint night has 4 places
  assert.equal((await join(PAINT, { guests: [] }, TAMA)).data.join.people, 1, 'an empty list is just them');
  const tooMany = await join(PAINT, { guests: [{ code: codes[KIRI] }, { name: 'Jo' }, { name: 'Ana' }] });
  assert.equal(said(tooMany), '409 Only 3 spaces left.');
  const fits = await join(PAINT, { guests: [{ code: codes[KIRI] }, { name: 'Jo' }] });
  assert.deepEqual([fits.status, fits.data.spacesLeft, fits.data.join.amount], [200, 0, 0]);
  assert.equal(said(await join(PAINT, { guests: [] }, '')), '409 This one is full.');
  // Paid online: the checkout is for 3 people at the entry fee
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  const checkouts = [];
  lair.shopify.createCheckout = async (input) => {
    checkouts.push(input);
    return { draftOrderId: 'gid://shopify/DraftOrder/81', checkoutUrl: 'https://checkout.test/81' };
  };
  const online = await join(CHAMPS, { guests: [{ code: codes[KIRI] }, { name: 'Jo' }] });
  assert.equal(online.status, 200, online.data.error);
  assert.deepEqual([online.data.join.status, online.data.join.amount, checkouts[0].quantity, checkouts[0].unitPrice], ['held', 7500, 3, 2500]);
  assert.deepEqual(online.data.join.guests, [{ name: 'Kiri Smith', member: true }, { name: 'Jo', member: false }]);
});

test('guests (round 8): an older page without guests works exactly as before (people 1 to 6, friends unnamed)', async () => {
  await members();
  const old = await join(QUIZ, { people: 3 });
  assert.equal(old.status, 200, old.data.error);
  assert.deepEqual([old.data.join.people, old.data.join.amount, old.data.join.guests], [3, 1500, []]);
  assert.equal(guestRows().length, 0);
  assert.equal(said(await join(QUIZ, { people: 7 })), '422 Sign up between 1 and 6 people.');
  assert.equal(said(await join(QUIZ, { people: 0 })), '422 Sign up between 1 and 6 people.');
  assert.equal(said(await join(QUIZ, {})), '422 Sign up between 1 and 6 people.');
});

/* ---------------- what each person sees ---------------- */

test('guests (round 8): staff see each guest with their account and member code (their code now); the public floor has no sign-ups', async () => {
  const codes = await members();
  const j = (await join(QUIZ, { guests: [{ code: codes[KIRI] }, { name: 'Jo' }] })).data.join;
  const floor = (await call('GET', 'floor', null, 'staff')).data;
  const staffView = floor.joins.find((x) => x.id === j.id);
  assert.deepEqual(staffView.guests, [
    { name: 'Kiri Smith', member: true, customerId: KIRI, code: codes[KIRI] },
    { name: 'Jo', member: false, customerId: null, code: null },
  ]);
  assert.equal((await call('GET', 'floor')).data.joins, undefined);
  // Staff give Kiri a new code: staff see the new one on the sign-up
  const fresh = (await call('POST', `members/${KIRI}/new-code`, {}, 'staff')).data.code;
  assert.equal((await call('GET', 'floor', null, 'staff')).data.joins.find((x) => x.id === j.id).guests[0].code, fresh);
  // Marking it paid (staff) answers the staff view, guests and all
  const paid = await call('POST', `bookings/${j.id}/update`, { paid: true }, 'staff');
  assert.deepEqual([paid.status, paid.data.join.guests.map((g) => g.name)], [200, ['Kiri Smith', 'Jo']]);
});

test('guests (round 8): My Lair: the person who signed up sees who\'s coming; the guest sees it with guestOf, no money, no other names, can\'t cancel', async () => {
  const codes = await members();
  const res = await join(QUIZ, { guests: [{ code: codes[KIRI] }, { name: 'Jo' }, { code: codes[TAMA] }] });
  const j = res.data.join;
  const mine = (await me(SAM)).joins.find((x) => x.id === j.id);
  assert.deepEqual(mine.guests, [{ name: 'Kiri Smith', member: true }, { name: 'Jo', member: false }, { name: 'Tama Rewiti', member: true }]);
  assert.equal(mine.guestOf, undefined);
  const theirs = (await me(KIRI)).joins;
  assert.equal(theirs.length, 1);
  const g = theirs[0];
  assert.deepEqual(
    [g.id, g.ref, g.title, g.start, g.people, g.status, g.name, g.guestOf, g.canCancel, g.amount, g.due, g.paidAmount, g.guests, g.ticketCode],
    [j.id, j.ref, 'Trivia night', at(TODAY, 18), 4, 'confirmed', 'Kiri Smith', { name: 'Sam' }, false, 0, 0, 0, [], codes[KIRI]],
  );
  assert.ok(!('checkoutUrl' in g));
  assert.ok(!JSON.stringify(g).includes('Jo') && !JSON.stringify(g).includes('Tama'), 'none of the other guests\' names');
  // Nothing of it is on Kiri's bill
  assert.deepEqual((await me(KIRI)).dueNow, []);
  // Their own sign-ups and the ones they're a guest on, soonest first
  await join(PAINT, { name: 'Kiri Smith', email: 'kiri@example.com', guests: [] }, KIRI);
  assert.deepEqual((await me(KIRI)).joins.map((x) => [x.title, Boolean(x.guestOf)]), [['Trivia night', true], ['Paint night', false]]);
});

test('guests (round 8): only the person who signed up (or staff) can cancel; a guest gets the contract\'s 403', async () => {
  const codes = await members();
  const j = (await join(QUIZ, { guests: [{ code: codes[KIRI] }] })).data.join;
  assert.equal(said(await call('POST', `events/joins/${j.id}/cancel`, {}, KIRI)), '403 Only the person who signed up can change this. Ask them, or the counter.');
  assert.equal(said(await call('POST', `events/joins/${j.id}/cancel`, {}, TAMA)), '403 Only staff can change that sign-up.');
  assert.equal(said(await call('POST', `events/joins/${j.id}/cancel`, {})), '403 Only staff can change that sign-up.');
  const cancelled = await call('POST', `events/joins/${j.id}/cancel`, {}, SAM);
  assert.deepEqual([cancelled.status, cancelled.data.join.status, cancelled.data.join.guests], [200, 'cancelled', [{ name: 'Kiri Smith', member: true }]]);
  assert.equal((await me(KIRI)).joins[0].status, 'cancelled', 'the guest sees it was cancelled');
});

/* ---------------- stamps ---------------- */

test('guests (round 8): checked in, each guest with an account gets their own stamp; the person who signed up gets theirs and one for each guest without', async () => {
  const codes = await members();
  const j = (await join(QUIZ, { guests: [{ code: codes[KIRI] }, { name: 'Jo' }, { name: 'Ana' }] })).data.join;
  assert.deepEqual([(await loyalty(SAM)).stamps, (await loyalty(KIRI)).stamps], [0, 0], 'nothing before check-in');
  const checked = await staffCheckin({ code: j.ref });
  assert.deepEqual([checked.status, checked.data.checkedIn, checked.data.join.guests.length, checked.data.row.guests.length], [200, true, 3, 3]);
  const sam = await loyalty(SAM);
  const kiri = await loyalty(KIRI);
  assert.deepEqual([sam.stamps, kiri.stamps], [3, 1], 'Sam: himself, Jo and Ana; Kiri: her own');
  assert.deepEqual(sam.recent, [{ at: at(TODAY, 18), title: 'Trivia night', people: 3 }]);
  assert.deepEqual(kiri.recent, [{ at: at(TODAY, 18), title: 'Trivia night', people: 1 }]);
  assert.equal(lair.stampedSessions(KIRI).length, 1);
  // The staff member lists follow
  const listed = (await call('GET', `members?q=${KIRI}`, null, 'staff')).data;
  assert.equal((Array.isArray(listed) ? listed : listed.members)[0].loyalty.stamps, 1);
  // Undoing the check-in takes them all back
  await call('POST', `bookings/${j.id}/update`, { status: 'confirmed' }, 'staff');
  assert.deepEqual([(await loyalty(SAM)).stamps, (await loyalty(KIRI)).stamps], [0, 0]);
  // A sign-up from an older page (3 people, unnamed) still gives the person who signed up 3
  const old = (await join(PAINT, { name: 'Tama Rewiti', email: 'tama@example.com', people: 3 }, TAMA)).data.join;
  await call('POST', `bookings/${old.id}/update`, { status: 'attended' }, 'staff');
  assert.equal((await loyalty(TAMA)).stamps, 3);
});

test('guests (round 8): a guest signed up by someone without an account still gets their stamp; and nobody is counted twice', async () => {
  const codes = await members();
  // A visitor (logged out) brings Kiri
  const visitor = (await join(QUIZ, { name: 'Ana Silva', email: 'ana@example.com', guests: [{ code: codes[KIRI] }] }, '')).data.join;
  await staffCheckin({ code: visitor.ref });
  assert.equal((await loyalty(KIRI)).stamps, 1);
  // Sam, logged out, put his own code on the list; then the sign-up joins his account (his verified email, round 6)
  const self = (await join(PAINT, { guests: [{ code: codes[SAM] }, { name: 'Jo' }] }, '')).data.join;
  lair.sql.exec('UPDATE event_joins SET customer_id = ? WHERE id = ?', SAM, self.id);
  await call('POST', `bookings/${self.id}/update`, { status: 'attended' }, 'staff');
  assert.equal((await loyalty(SAM)).stamps, 2, 'Sam and Jo: Sam once, not as his own guest too');
  assert.equal((await me(SAM)).joins.filter((x) => x.id === self.id).length, 1, 'and it\'s listed once, as his');
});

/* ---------------- check-in by a guest's member code ---------------- */

test('guests (round 8): at check-in, a guest\'s member code shows the sign-up they\'re on (guestOf), and checking it in checks in everyone', async () => {
  const codes = await members();
  const j = (await join(QUIZ, { guests: [{ code: codes[KIRI] }, { name: 'Jo' }] })).data.join;
  const card = await staffCheckin({ code: codes[KIRI].toLowerCase() });
  assert.deepEqual([card.status, card.data.kind, card.data.checkedIn, card.data.due], [200, 'member', false, 0], 'what\'s due on it is Sam\'s, not hers');
  const row = card.data.rows.find((r) => r.id === j.id);
  assert.deepEqual([row.type, row.ref, row.guestOf, row.due, row.people], ['join', j.ref, { name: 'Sam' }, 1500, 3]);
  assert.deepEqual(row.guests.map((g) => [g.name, g.member, g.code]), [['Kiri Smith', true, codes[KIRI]], ['Jo', false, null]]);
  assert.equal(card.data.message, `Kiri Smith has no booking of their own today. Sam signed them up for Trivia night at 6:00 pm (${j.ref}).`);
  assert.deepEqual(card.data.bookings, [], 'round 3\'s list is their own bookings');
  const checked = await staffCheckin({ id: row.id, type: 'join' });
  assert.deepEqual([checked.data.checkedIn, checked.data.join.status, checked.data.due], [true, 'attended', 1500]);
  assert.deepEqual([(await loyalty(SAM)).stamps, (await loyalty(KIRI)).stamps], [2, 1]);
  const again = await staffCheckin({ code: codes[KIRI] });
  assert.match(again.data.message, /\(.+, checked in\)\.$/);
  // With a booking of her own today too, both show; only hers is on her total
  await call('POST', 'bookings', { kind: 'table', tables: ['T3'], start: at(TODAY, 15), end: at(TODAY, 17), people: 2, name: 'Kiri Smith', email: 'kiri@example.com', phone: MOBILE }, KIRI);
  const both = await staffCheckin({ code: codes[KIRI] });
  assert.deepEqual(both.data.rows.map((r) => [r.type, Boolean(r.guestOf)]), [['booking', false], ['join', true]]);
  assert.equal(both.data.due, 2000, 'her table for 2, not Sam\'s sign-up');
  assert.match(both.data.message, /^Kiri Smith has 1 booking today\. .+\. Sam signed them up for Trivia night/);
  // The POS's member lookups are as they were (no guest sign-ups there)
  const scan = await internal('pos/scan', { code: codes[KIRI] });
  assert.deepEqual(scan.data.rows.map((r) => r.type), ['booking']);
  const posCode = await internal('pos/checkin', { code: codes[KIRI] });
  assert.ok(!posCode.data.rows.some((r) => r.guestOf), 'no guest sign-ups on the POS');
  // A cancelled sign-up, or another day's, isn't shown
  await call('POST', `events/joins/${j.id}/cancel`, {}, SAM);
  assert.ok(!(await staffCheckin({ code: codes[KIRI] })).data.rows.some((r) => r.guestOf));
  await join(PAINT, { guests: [{ code: codes[TAMA] }] });
  const tama = await staffCheckin({ code: codes[TAMA] });
  assert.deepEqual([tama.data.rows.length, tama.data.message], [0, 'Tama Rewiti has nothing booked today.']);
});

/* ---------------- the email ---------------- */

test('guests (round 8): the confirmation says who\'s coming; guests aren\'t emailed', async () => {
  const codes = await members();
  const mail = captureEmails();
  try {
    await join(QUIZ, { guests: [{ code: codes[KIRI] }, { name: 'Jo' }] });
    await settle();
    assert.equal(mail.sent.length, 1, 'one email, to Sam');
    assert.equal(mail.sent[0].to, 'sam@example.com');
    assert.match(mail.sent[0].text, /People: +3\n/);
    assert.match(mail.sent[0].text, /Coming: +Sam Jones, Kiri Smith, Jo\n/);
    assert.match(mail.sent[0].html, /Sam Jones, Kiri Smith, Jo/);
    // An older page's friends are "a friend" or "2 friends"; on your own there's no Coming line
    mail.sent.length = 0;
    await join(PAINT, { name: 'Aroha', email: 'aroha@example.com', people: 2 }, '');
    await join(PAINT, { name: 'Mia', email: 'mia@example.com', people: 1 }, '');
    await settle();
    assert.match(mail.sent.find((m) => m.to === 'aroha@example.com').text, /Coming: +Aroha, a friend\n/);
    assert.ok(!/Coming:/.test(mail.sent.find((m) => m.to === 'mia@example.com').text));
    assert.equal(lair.comingLine({ name: 'Sam Jones', people: 5 }, [{ name: 'Kiri Smith' }]), 'Sam Jones, Kiri Smith, 3 friends');
  } finally {
    mail.restore();
  }
});

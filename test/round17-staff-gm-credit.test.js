// Round 17: staff GMs and the GM credit (contract v17-staff-gm-credit). Mo (16 Oct 2026): staff he pays to run GM games
// don't get the $5-a-player GM credit, with "an option for me to toggle that ... or a toggle so during staff hours, so if
// they are on the clock they cannot earn any store credit but outside of their hours they can earn store credit as
// anyone else." Players pay the same either way. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import {
  STAFF_GM_CHOICES, STAFF_GM_DEFAULT, STAFF_GM_MESSAGES, STAFF_GM_MODES, cleanStaffHours, shiftFor, staffHoursText,
} from '../src/staff-gm.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
// Friday 16 October 2026, 1:00pm in Auckland (NZDT, UTC+13): round 17
const NOW = Date.UTC(2026, 9, 16, 0, 0);
const realNow = Date.now;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);

/* ---------------- helpers, as in test/round16-wishlist.test.js ---------------- */
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
  { id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 },
  { id: 'side-room-2', name: 'Side room 2', code: 'B', tables: 4, seats: 4, order: 3 },
];
// People by their Shopify customer IDs (made up): the main account, two helpers (Ana runs games), and a GM who isn't staff
const OWNER = '9001';
const ANA = '9101';
const HEMI = '9102';
const RANGI = '5001';
const MIA = '6001';

let lair;
async function call(method, path, body, customer = '') {
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer },
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, data: await response.json() };
}
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const team = () => call('GET', 'team', null, OWNER);
const setMode = (mode, who = OWNER) => call('POST', 'team/gm-credit', { mode }, who);
const setHours = (id, hours, who = OWNER) => call('POST', `team/${id}/hours`, { hours }, who);
const credit = (id, body = {}, who = OWNER) => call('POST', `games/${id}/credit`, body, who);
const creditRows = () => lair.sql.exec('SELECT game_id, customer_id, players, amount, status, note, by FROM credits ORDER BY rowid').toArray().map((r) => ({ ...r }));

// Shopify's store credit, as the tests see it: every credit asked for
let credited = [];

/** A session on Saturday 17 October (6pm to 10pm unless said), listed by the main account for gm, with paying players */
async function session({ gm = ANA, name = 'Ana', start = at('2026-10-17', 18), end = at('2026-10-17', 22), paying = 2, gmFee } = {}) {
  const listed = await call('POST', 'games', {
    title: `${name}'s one-shot`, system: 'D&D 5e', gm: name, blurb: 'A test session.', seats: 4, tables: ['B1'], start, end,
    gmCustomerId: gm, gmCustomerName: name, gmEmail: `${name.toLowerCase()}@example.com`, ...(gmFee === undefined ? {} : { gmFee }),
  }, OWNER);
  assert.equal(listed.status, 200, listed.data.error);
  const id = listed.data.game.id;
  if (paying) {
    const seat = await call('POST', 'bookings', { kind: 'gm-seat', gameId: id, people: paying, name: 'Mia', email: 'mia@example.com', phone: '021 555 0100', pay: 'day' }, MIA);
    assert.equal(seat.status, 200, seat.data.error);
    assert.equal((await call('POST', `bookings/${seat.data.booking.id}/update`, { paid: true }, OWNER)).status, 200);
  }
  return id;
}

// No network in these tests: no Shopify and no emails. Anything that reaches for it is noted, and the test fails.
const realFetch = globalThis.fetch;
let reached = [];
let asked = [];
// Shopify is on (for the store credit) unless a test turns it off; tagsDown: Shopify can't be asked for tags
let shopifyOn = true;
let tagsDown = false;

beforeEach(async () => {
  reached = [];
  asked = [];
  credited = [];
  shopifyOn = true;
  tagsDown = false;
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  // The main account is tagged staff in Shopify; helpers are the Lair's own (person() reads them fresh). Kept 5 minutes,
  // as the real one keeps them, unless Shopify can't be asked (tagsDown)
  lair.taggedPerson = async (id) => {
    asked.push(id);
    if (tagsDown) return { customerId: id || null, staff: false, gm: false, tags: [], tagsFailed: true };
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  // GET /team asks Shopify who's tagged staff: the main account, here
  lair.shopify.searchCustomers = async () => [{ customerId: OWNER, name: 'Mo', email: 'owner@example.com' }];
  // Shopify's store credit: on, and noted
  Object.defineProperty(lair.shopify, 'configured', { get: () => shopifyOn, configurable: true });
  lair.shopify.creditCustomer = async (customerId, cents) => {
    credited.push([customerId, cents]);
  };
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  // Ana and Hemi are helpers (GM games for Ana)
  for (const [id, name, perms] of [[ANA, 'Ana Ngata', ['sessions']], [HEMI, 'Hemi Walker', ['checkin', 'money']]]) {
    const made = await call('POST', 'team', { customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, perms }, OWNER);
    assert.equal(made.status, 200, made.data.error);
  }
  asked = [];
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

/* ---------------- the words, the choices and the hours ---------------- */

test('staff GM credit (round 17): the choices and words, word for word, and Never until the main account picks', () => {
  assert.deepEqual(STAFF_GM_MODES, ['never', 'shifts', 'earn']);
  assert.equal(STAFF_GM_DEFAULT, 'never');
  assert.deepEqual(STAFF_GM_CHOICES, {
    never: { label: 'Never', words: "Staff don't earn GM credit for the sessions they run: they're paid to be there." },
    shifts: { label: 'Not in their hours', words: 'No GM credit for a session in their hours, even partly. Outside their hours they earn it like any GM.' },
    earn: { label: 'Always', words: 'Staff earn GM credit like any GM.' },
  });
  assert.equal(STAFF_GM_MESSAGES.mode, 'Pick one of the three choices for GM credit for staff.');
  assert.equal(STAFF_GM_MESSAGES.hours, 'Send their hours as a list of times, each with a day, a start and an end.');
  assert.equal(STAFF_GM_MESSAGES.day, 'Each time needs a day: Mon, Tue, Wed, Thu, Fri, Sat or Sun.');
  assert.equal(STAFF_GM_MESSAGES.time('sat'), 'Each time on Saturday needs a start and an end, like 16:00 and 22:00.');
  assert.equal(STAFF_GM_MESSAGES.order('mon'), 'A time on Monday ends before it starts. Use 24:00 for midnight.');
  assert.equal(STAFF_GM_MESSAGES.overlap('sun'), 'Two of the times on Sunday overlap. Make them one.');
  assert.equal(STAFF_GM_MESSAGES.many('fri'), 'Friday has more than 3 times. Join some of them up.');
  assert.equal(STAFF_GM_MESSAGES.team, "They're not on the team. Make them a helper first.");
  assert.equal(STAFF_GM_MESSAGES.onShift, "onShift is true (they were working), false (they weren't) or left out (their hours decide).");
  assert.equal(STAFF_GM_MESSAGES.markOwner, 'Only the main account can mark whether a staff GM was working.');
  assert.equal(STAFF_GM_MESSAGES.expect, "expect is 'credit', 'none' or left out.");
  assert.equal(STAFF_GM_MESSAGES.expectChanged, 'GM credit for staff, their hours or the team changed since this page loaded. Check the session again.');
  assert.equal(STAFF_GM_MESSAGES.changed, "This session's GM changed. Check the session again.");
  assert.equal(STAFF_GM_MESSAGES.tags, "Gobgob couldn't check whether the GM is on the team just now. Try again in a moment.");
});

test('staff hours (round 17): cleaned and sorted, Monday first; 24:00 or an end of 00:00 is midnight; day names any case', () => {
  assert.deepEqual(cleanStaffHours([
    { day: 'Saturday', from: '10:00', to: '18:00' }, { day: 'mon', from: '16:00', to: '00:00' }, { day: 'SAT', from: '19:00', to: '24:00' },
    { day: 'Wed', from: '9:30', to: '12:00' },
  ]), [
    { day: 'mon', from: '16:00', to: '24:00' }, { day: 'wed', from: '09:30', to: '12:00' },
    { day: 'sat', from: '10:00', to: '18:00' }, { day: 'sat', from: '19:00', to: '24:00' },
  ]);
  assert.deepEqual(cleanStaffHours([]), []);
  // one time can start when another ends
  assert.equal(cleanStaffHours([{ day: 'fri', from: '16:00', to: '20:00' }, { day: 'fri', from: '20:00', to: '24:00' }]).length, 2);
  const refused = (list) => {
    try {
      cleanStaffHours(list);
      return 'kept';
    } catch (error) {
      return `${error.status} ${error.message}`;
    }
  };
  assert.equal(refused('Sat 10-6'), `422 ${STAFF_GM_MESSAGES.hours}`);
  assert.equal(refused([null]), `422 ${STAFF_GM_MESSAGES.hours}`);
  assert.equal(refused([{ day: 'someday', from: '10:00', to: '11:00' }]), `422 ${STAFF_GM_MESSAGES.day}`);
  assert.equal(refused([{ day: 'satx', from: '10:00', to: '11:00' }]), `422 ${STAFF_GM_MESSAGES.day}`);
  assert.equal(refused([{ day: 7, from: '10:00', to: '11:00' }]), `422 ${STAFF_GM_MESSAGES.day}`);
  assert.equal(refused([{ day: 'sat', from: '10am', to: '11:00' }]), `422 ${STAFF_GM_MESSAGES.time('sat')}`);
  assert.equal(refused([{ day: 'sat', from: '24:00', to: '24:00' }]), `422 ${STAFF_GM_MESSAGES.time('sat')}`);
  assert.equal(refused([{ day: 'sat', from: '10:00', to: '24:30' }]), `422 ${STAFF_GM_MESSAGES.time('sat')}`);
  assert.equal(refused([{ day: 'sat', from: '10:60', to: '11:00' }]), `422 ${STAFF_GM_MESSAGES.time('sat')}`);
  assert.equal(refused([{ day: 'sat', from: '18:00', to: '10:00' }]), `422 ${STAFF_GM_MESSAGES.order('sat')}`);
  assert.equal(refused([{ day: 'sat', from: '10:00', to: '10:00' }]), `422 ${STAFF_GM_MESSAGES.order('sat')}`);
  assert.equal(refused([{ day: 'sun', from: '10:00', to: '14:00' }, { day: 'sun', from: '13:00', to: '16:00' }]), `422 ${STAFF_GM_MESSAGES.overlap('sun')}`);
  assert.equal(refused(['10:00', '11:00', '12:00', '13:00'].map((from, i) => ({ day: 'tue', from, to: `${11 + i}:00` }))), `422 ${STAFF_GM_MESSAGES.many('tue')}`);
  assert.equal(refused(Array.from({ length: 22 }, () => ({ day: 'mon', from: '10:00', to: '11:00' }))), `422 ${STAFF_GM_MESSAGES.hours}`);
});

test('staff hours (round 17): said as people say them', () => {
  assert.equal(staffHoursText(cleanStaffHours([
    { day: 'sat', from: '10:00', to: '18:00' }, { day: 'mon', from: '16:30', to: '24:00' }, { day: 'sun', from: '12:00', to: '13:15' }, { day: 'wed', from: '00:00', to: '09:00' },
  ])), 'Mon 4:30pm–midnight, Wed midnight–9am, Sat 10am–6pm, Sun midday–1:15pm');
  assert.equal(staffHoursText([]), '');
});

test('staff hours (round 17): a session in someone hours, even partly, in Lair time (daylight saving too)', () => {
  const hours = cleanStaffHours([{ day: 'sat', from: '10:00', to: '18:00' }, { day: 'sun', from: '20:00', to: '24:00' }]);
  // Saturday 17 October: 6pm to 10pm starts as the time ends, so it's outside; 5pm to 9pm is partly in; 11am to 1pm is in
  assert.equal(shiftFor(hours, at('2026-10-17', 18), at('2026-10-17', 22), time), null);
  assert.deepEqual(shiftFor(hours, at('2026-10-17', 17), at('2026-10-17', 21), time), { day: 'sat', from: '10:00', to: '18:00' });
  assert.deepEqual(shiftFor(hours, at('2026-10-17', 11), at('2026-10-17', 13), time), { day: 'sat', from: '10:00', to: '18:00' });
  // ending as the time starts is outside too: Saturday 8am to 10am
  assert.equal(shiftFor(hours, at('2026-10-17', 8), at('2026-10-17', 10), time), null);
  // a Friday session that runs past midnight into Saturday's time
  assert.deepEqual(shiftFor(hours, at('2026-10-16', 23), at('2026-10-17', 10, 30), time), { day: 'sat', from: '10:00', to: '18:00' });
  // the weekend daylight saving ends (Sunday 4 April 2027, 3am NZDT): Saturday 3 April 5pm (NZDT) is in Saturday's time,
  // Sunday 4 April 9pm (NZST) is in Sunday's, and 6pm to 8pm that Sunday is in neither
  assert.ok(shiftFor(hours, at('2027-04-03', 17), at('2027-04-03', 19), time));
  assert.ok(shiftFor(hours, at('2027-04-04', 21), at('2027-04-04', 23), time));
  assert.equal(shiftFor(hours, at('2027-04-04', 18), at('2027-04-04', 20), time), null);
  // no hours: never in them
  assert.equal(shiftFor([], at('2026-10-17', 11), at('2026-10-17', 13), time), null);
});

/* ---------------- the Team tab: the setting and the hours ---------------- */

test('GET /team (round 17): the setting with its choices, and everyone on the team with their hours', async () => {
  const got = await team();
  assert.equal(got.status, 200, got.data.error);
  assert.deepEqual(got.data.gmCredit, {
    mode: 'never',
    choices: [
      { key: 'never', label: 'Never', words: STAFF_GM_CHOICES.never.words },
      { key: 'shifts', label: 'Not in their hours', words: STAFF_GM_CHOICES.shifts.words },
      { key: 'earn', label: 'Always', words: STAFF_GM_CHOICES.earn.words },
    ],
    changedBy: null,
    changedAt: null,
  });
  assert.deepEqual(got.data.owners.map((o) => [o.customerId, o.hours, o.hoursText]), [[OWNER, [], '']]);
  assert.deepEqual(got.data.helpers.map((h) => [h.customerId, h.hours, h.hoursText]).sort(), [[ANA, [], ''], [HEMI, [], '']]);
});

test('POST /team/gm-credit (round 17): the main account picks; a helper, even with Money, is refused; anything else is a 422', async () => {
  assert.equal(said(await setMode('shifts', ANA)), "403 That's not one of your staff permissions. Ask the main account to tick it on the Team tab.");
  assert.equal(said(await setMode('shifts', HEMI)), "403 That's not one of your staff permissions. Ask the main account to tick it on the Team tab.");
  assert.equal(said(await setMode('shifts', RANGI)), '403 Staff only. Log in with your staff account.');
  for (const bad of ['', 'sometimes', 'NEVER', null, 3]) assert.equal(said(await setMode(bad)), `422 ${STAFF_GM_MESSAGES.mode}`);
  assert.equal((await team()).data.gmCredit.mode, 'never', 'nothing changed');
  Date.now = () => NOW + HOUR;
  const set = await setMode('shifts');
  assert.equal(set.status, 200, set.data.error);
  assert.equal(set.data.gmCredit.mode, 'shifts');
  assert.deepEqual(set.data.gmCredit.changedBy, { customerId: OWNER, name: 'Mo Ashgrove' });
  assert.equal(set.data.gmCredit.changedAt, NOW + HOUR);
  assert.equal((await team()).data.gmCredit.mode, 'shifts');
  assert.equal((await setMode('earn')).data.gmCredit.mode, 'earn');
  assert.equal((await setMode('never')).data.gmCredit.mode, 'never');
  assert.equal(lair.staffGmMode(), 'never');
});

test('POST /team/:customerId/hours (round 17): the main account sets anyone on the team; [] clears; others are refused', async () => {
  const sat = [{ day: 'sat', from: '10:00', to: '18:00' }];
  const set = await setHours(ANA, [{ day: 'Saturday', from: '10:00', to: '18:00' }, { day: 'thu', from: '16:00', to: '00:00' }]);
  assert.equal(set.status, 200, set.data.error);
  assert.deepEqual(set.data, {
    customerId: ANA, hours: [{ day: 'thu', from: '16:00', to: '24:00' }, ...sat], hoursText: 'Thu 4pm–midnight, Sat 10am–6pm',
  });
  assert.equal((await setHours(OWNER, sat)).status, 200, 'the main account has hours too');
  let list = (await team()).data;
  assert.equal(list.helpers.find((h) => h.customerId === ANA).hoursText, 'Thu 4pm–midnight, Sat 10am–6pm');
  assert.equal(list.owners[0].hoursText, 'Sat 10am–6pm');
  // only the main account
  assert.equal(said(await setHours(ANA, sat, ANA)), "403 That's not one of your staff permissions. Ask the main account to tick it on the Team tab.");
  // someone not on the team, or nobody
  assert.equal(said(await setHours(RANGI, sat)), `404 ${STAFF_GM_MESSAGES.team}`);
  assert.equal(lair.staffHoursOf(RANGI).length, 0);
  // a bad time changes nothing
  assert.equal(said(await setHours(ANA, [{ day: 'sat', from: '18:00', to: '10:00' }])), `422 ${STAFF_GM_MESSAGES.order('sat')}`);
  assert.equal((await team()).data.helpers.find((h) => h.customerId === ANA).hours.length, 2);
  // [] clears them
  assert.deepEqual((await setHours(ANA, [])).data, { customerId: ANA, hours: [], hoursText: '' });
  list = (await team()).data;
  assert.deepEqual(list.helpers.find((h) => h.customerId === ANA).hours, []);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM staff_hours WHERE customer_id = ?', ANA).one().n, 0);
});

/* ---------------- the GM credit: POST /games/:id/credit ---------------- */

test('GM credit (round 17), Never: a helper GM’s session is done with no credit; a GM who isn’t staff is credited as before', async () => {
  const ana = await session();
  const rangi = await session({ gm: RANGI, name: 'Rangi', start: at('2026-10-17', 12), end: at('2026-10-17', 16), paying: 3 });
  Date.now = () => at('2026-10-17', 22, 30);
  const done = await credit(ana);
  assert.equal(done.status, 200, done.data.error);
  assert.deepEqual(done.data, {
    players: 2, amount: 0, status: 'staff', withheld: 1000,
    note: "No GM credit: Ana is staff, and staff don't earn GM credit (it would have been $10.00 for 2 paying players).",
  });
  assert.equal(said(await credit(ana)), '409 This GM has already been credited.');
  const paid = await credit(rangi);
  assert.deepEqual([paid.data.players, paid.data.amount, paid.data.status], [3, 1500, 'credited']);
  assert.deepEqual(credited, [[RANGI, 1500]], "Shopify only added Rangi's");
  assert.deepEqual(creditRows(), [
    { game_id: ana, customer_id: ANA, players: 2, amount: 0, status: 'staff', note: done.data.note, by: `staff:${OWNER}` },
    { game_id: rangi, customer_id: RANGI, players: 3, amount: 1500, status: 'credited', note: '', by: `staff:${OWNER}` },
  ]);
  assert.equal(lair.game(ana).credited, 2, 'marked done');
});

test('GM credit (round 17), Never: the main account running a session is staff too; a $0 fee is still "covering their players"', async () => {
  const own = await session({ gm: OWNER, name: 'Mo' });
  const free = await session({ start: at('2026-10-17', 12), end: at('2026-10-17', 16), gmFee: 0 });
  Date.now = () => at('2026-10-17', 22, 30);
  assert.equal((await credit(own)).data.status, 'staff');
  const nothing = await credit(free);
  assert.deepEqual([nothing.data.amount, nothing.data.status, nothing.data.note], [0, 'none', "This GM covers their players' fee, so there's no store credit to add."]);
  assert.deepEqual(credited, []);
});

test('GM credit (round 17), Not in their hours: none for a session in their hours, even partly; outside them, as any GM', async () => {
  await setMode('shifts');
  await setHours(ANA, [{ day: 'sat', from: '10:00', to: '19:00' }]);
  const inHours = await session({ start: at('2026-10-17', 12), end: at('2026-10-17', 16) });
  const partly = await session({ start: at('2026-10-17', 18), end: at('2026-10-17', 22) });
  const outside = await session({ start: at('2026-10-18', 12), end: at('2026-10-18', 16), paying: 3 });
  Date.now = () => at('2026-10-18', 17);
  assert.deepEqual((await credit(inHours)).data, {
    players: 2, amount: 0, status: 'staff', withheld: 1000,
    note: "No GM credit: it was in Ana's hours, Sat 10am–7pm (it would have been $10.00 for 2 paying players).",
  });
  assert.equal((await credit(partly)).data.status, 'staff');
  const earned = await credit(outside);
  assert.deepEqual(earned.data, { players: 3, amount: 1500, status: 'credited', note: "It was outside Ana's hours, so they earn it like any GM." });
  assert.deepEqual(credited, [[ANA, 1500]]);
});

test('GM credit (round 17), Not in their hours: staff can mark that the GM was working, or wasn’t, whatever the hours say', async () => {
  await setMode('shifts');
  await setHours(ANA, [{ day: 'sat', from: '10:00', to: '19:00' }]);
  const inHours = await session({ start: at('2026-10-17', 12), end: at('2026-10-17', 16) });
  const outside = await session({ start: at('2026-10-18', 12), end: at('2026-10-18', 16) });
  Date.now = () => at('2026-10-18', 17);
  for (const bad of ['yes', 1, 'true']) assert.equal(said(await credit(inHours, { onShift: bad })), `422 ${STAFF_GM_MESSAGES.onShift}`);
  const notWorking = await credit(inHours, { onShift: false });
  assert.deepEqual(notWorking.data, { players: 2, amount: 1000, status: 'credited', note: "Ana wasn't working then, as Mo marked on the staff page, so they earn it like any GM." });
  const working = await credit(outside, { onShift: true });
  assert.deepEqual(working.data, {
    players: 2, amount: 0, status: 'staff', withheld: 1000,
    note: 'No GM credit: Ana was working then, as Mo marked on the staff page (it would have been $10.00 for 2 paying players).',
  });
  assert.deepEqual(credited, [[ANA, 1000]]);
});

test('GM credit (round 17): Never ignores onShift; Always credits staff as before; a GM who isn’t staff never has a note', async () => {
  const one = await session({ start: at('2026-10-17', 12), end: at('2026-10-17', 16) });
  const two = await session({ start: at('2026-10-17', 18), end: at('2026-10-17', 22) });
  const rangi = await session({ gm: RANGI, name: 'Rangi', start: at('2026-10-18', 12), end: at('2026-10-18', 16) });
  Date.now = () => at('2026-10-18', 17);
  assert.equal((await credit(one, { onShift: false })).data.status, 'staff', 'Never is never');
  await setMode('earn');
  assert.deepEqual((await credit(two)).data, { players: 2, amount: 1000, status: 'credited', note: '' });
  await setMode('shifts');
  assert.deepEqual((await credit(rangi, { onShift: true })).data, { players: 2, amount: 1000, status: 'credited', note: '' });
  assert.deepEqual(credited, [[ANA, 1000], [RANGI, 1000]]);
});

test('GM credit (round 17): someone who stops being a helper is credited like any GM from then on', async () => {
  const ana = await session();
  Date.now = () => at('2026-10-17', 22, 30);
  assert.equal((await call('POST', `team/${ANA}/remove`, {}, OWNER)).status, 200);
  assert.equal((await credit(ana)).data.status, 'credited');
  assert.deepEqual(credited, [[ANA, 1000]]);
});

test('GM credit (round 17): only the main account marks whether a staff GM was working; Money helpers credit as the rule says', async () => {
  await setMode('shifts');
  await setHours(ANA, [{ day: 'sat', from: '10:00', to: '19:00' }]);
  const inHours = await session({ start: at('2026-10-17', 12), end: at('2026-10-17', 16) });
  Date.now = () => at('2026-10-17', 17);
  assert.equal(said(await credit(inHours, { onShift: false }, HEMI)), `403 ${STAFF_GM_MESSAGES.markOwner}`);
  assert.equal(lair.game(inHours).credited, null, 'nothing done');
  const done = await credit(inHours, {}, HEMI);
  assert.equal(done.data.status, 'staff');
  assert.equal(creditRows()[0].by, `staff:${HEMI}`, 'who pressed it is kept');
  assert.deepEqual(credited, []);
});

test('GM credit (round 17): expect is what the button said; if the setting changed since, a 409 and nothing done', async () => {
  const one = await session({ start: at('2026-10-17', 12), end: at('2026-10-17', 16) });
  const two = await session({ start: at('2026-10-17', 18), end: at('2026-10-17', 22) });
  Date.now = () => at('2026-10-17', 22, 30);
  assert.equal(said(await credit(one, { expect: 'maybe' })), `422 ${STAFF_GM_MESSAGES.expect}`);
  // the page said "Session done: no GM credit" (Never), but the main account switched to Always on another device
  await setMode('earn');
  assert.equal(said(await credit(one, { expect: 'none' })), `409 ${STAFF_GM_MESSAGES.expectChanged}`);
  assert.equal(lair.game(one).credited, null);
  assert.deepEqual(credited, []);
  assert.equal((await credit(one, { expect: 'credit' })).data.status, 'credited');
  // and the other way: the page said credit, the setting is Never now
  await setMode('never');
  assert.equal(said(await credit(two, { expect: 'credit' })), `409 ${STAFF_GM_MESSAGES.expectChanged}`);
  assert.equal((await credit(two, { expect: 'none' })).data.status, 'staff');
  assert.deepEqual(credited, [[ANA, 1000]]);
});

test('GM credit (round 17): Shopify can’t say whether a GM is the main account: a 503, never paid; Always doesn’t need to ask', async () => {
  const own = await session({ gm: OWNER, name: 'Mo' });
  const rangi = await session({ gm: RANGI, name: 'Rangi', start: at('2026-10-17', 12), end: at('2026-10-17', 16) });
  Date.now = () => at('2026-10-17', 22, 30);
  lair.people.clear();
  tagsDown = true;
  // a helper with Money presses it (the main account pressing it would need its own tags too)
  assert.equal(said(await credit(own, {}, HEMI)), `503 ${STAFF_GM_MESSAGES.tags}`);
  assert.equal(said(await credit(rangi, {}, HEMI)), `503 ${STAFF_GM_MESSAGES.tags}`);
  assert.equal(lair.game(own).credited, null);
  assert.deepEqual(credited, []);
  // (the main account needs its own tags to change the setting)
  tagsDown = false;
  await setMode('earn');
  tagsDown = true;
  assert.equal((await credit(rangi, {}, HEMI)).data.status, 'credited');
  tagsDown = false;
  await setMode('never');
  assert.equal((await credit(own, {}, HEMI)).data.status, 'staff');
  assert.deepEqual(credited, [[RANGI, 1000]]);
});

test('GM credit (round 17): a session whose GM changed while the team was checked is a 409', async () => {
  const ana = await session();
  Date.now = () => at('2026-10-17', 22, 30);
  const real = lair.person.bind(lair);
  lair.person = async (id) => {
    if (id === ANA) lair.sql.exec('UPDATE games SET gm_customer_id = ? WHERE id = ?', RANGI, ana);
    return real(id);
  };
  assert.equal(said(await credit(ana)), `409 ${STAFF_GM_MESSAGES.changed}`);
  assert.equal(lair.game(ana).credited, null);
  assert.deepEqual(credited, []);
});

test('GM credit (round 17): a GM listed by email only: added by hand, with a word about staff unless the setting is Always', async () => {
  const listed = await call('POST', 'games', {
    title: 'Emailed GM', system: 'D&D 5e', gm: 'Tui', blurb: 'x', seats: 4, tables: ['B1'], start: at('2026-10-17', 12), end: at('2026-10-17', 16), gmEmail: 'tui@example.com',
  }, OWNER);
  assert.equal(listed.status, 200, listed.data.error);
  const id = listed.data.game.id;
  const seat = await call('POST', 'bookings', { kind: 'gm-seat', gameId: id, people: 1, name: 'Mia', email: 'mia@example.com', phone: '021 555 0100', pay: 'day' }, MIA);
  await call('POST', `bookings/${seat.data.booking.id}/update`, { paid: true }, OWNER);
  Date.now = () => at('2026-10-17', 17);
  const manual = await credit(id);
  assert.deepEqual([manual.data.status, manual.data.note], ['manual', "The GM isn't linked to a customer account, so add the store credit in Shopify admin. If they're on the team, check GM credit for staff on the Team tab first."]);
});

/* ---------------- what staff and GMs see ---------------- */

test('floor (round 17): staff see what the setting says for a staff GM’s session ready for its credit, and what was recorded', async () => {
  await setHours(ANA, [{ day: 'sat', from: '10:00', to: '19:00' }]);
  const ana = await session();
  const rangi = await session({ gm: RANGI, name: 'Rangi', start: at('2026-10-17', 12), end: at('2026-10-17', 16) });
  const later = await session({ start: at('2026-10-24', 12), end: at('2026-10-24', 16), paying: 0 });
  const fresh = await session({ start: at('2026-10-17', 10), end: at('2026-10-17', 12) });
  Date.now = () => at('2026-10-17', 22, 30);
  const floor = async (who = OWNER) => (await call('GET', `floor?from=${at('2026-10-17', 0)}&to=${at('2026-10-25', 0)}`, null, who)).data;
  let games = (await floor()).games;
  const of = (id) => games.find((g) => g.id === id);
  assert.deepEqual(of(ana).staffGm, { mode: 'never', credit: false, onShift: null, shift: null, hours: '' });
  assert.equal(of(rangi).staffGm, undefined, 'Rangi is not staff');
  assert.equal(of(later).staffGm, undefined, 'not started yet');
  assert.equal(of(ana).credit, undefined, 'nothing recorded yet');
  await setMode('shifts');
  games = (await floor()).games;
  assert.deepEqual(of(ana).staffGm, { mode: 'shifts', credit: false, onShift: true, shift: 'Sat 10am–7pm', hours: 'Sat 10am–7pm' });
  await credit(ana);
  await credit(rangi);
  games = (await floor()).games;
  assert.equal(of(ana).staffGm, undefined, 'done');
  assert.deepEqual([of(ana).credit.status, of(ana).credit.amount, of(ana).credit.players], ['staff', 0, 2]);
  assert.match(of(ana).credit.note, /^No GM credit: it was in Ana's hours, Sat 10am–7pm/);
  assert.deepEqual([of(rangi).credit.status, of(rangi).credit.amount], ['credited', 1000]);
  // the public board never has either
  const board = (await floor(MIA)).games;
  assert.ok(board.every((g) => g.staffGm === undefined && g.credit === undefined));
  // a helper who only runs the desk (Check-in and Tables) doesn't see either
  assert.equal((await call('POST', 'team', { customerId: '9103', name: 'Kiri Hura', email: 'kiri@example.com', perms: ['checkin', 'tables'] }, OWNER)).status, 200);
  const desk = (await floor('9103')).games;
  assert.ok(desk.length && desk.every((g) => g.staffGm === undefined && g.credit === undefined), 'desk helper sees no GM credit');
  // the main account as GM: known from its tags when they're fresh; otherwise looked up after the answer, for next time
  const own = await session({ gm: OWNER, name: 'Mo', start: at('2026-10-24', 17), end: at('2026-10-24', 20) });
  Date.now = () => at('2026-10-24', 20) + 10 * 60_000;
  lair.people.clear();
  asked = [];
  games = (await floor(HEMI)).games;
  assert.equal(of(own).staffGm, undefined, 'not known yet: the usual card');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(asked.includes(OWNER), 'its tags were asked for after the answer');
  games = (await floor(HEMI)).games;
  assert.deepEqual(of(own).staffGm, { mode: 'shifts', credit: true, onShift: false, shift: null, hours: '' });
  // Always: nothing to ask Shopify about (only who's asking is looked up)
  assert.ok(of(fresh).staffGm, 'Never: fresh is waiting for its credit');
  await setMode('earn');
  asked = [];
  games = (await floor()).games;
  assert.equal(of(fresh).staffGm, undefined);
  assert.ok(asked.every((id) => id === OWNER), `no GM's tags asked for: ${asked}`);
  Date.now = () => at('2026-10-17', 22, 30);
});

test('GET /me (round 17): someone on the team sees how the setting touches them; anyone else, null', async () => {
  shopifyOn = false; // GET /me's own Shopify reads aren't what this is about
  const me = async (who) => (await call('GET', 'me', null, who)).data.customer;
  assert.deepEqual((await me(ANA)).staffGmCredit, { mode: 'never', hours: [], hoursText: '' });
  assert.equal((await me(RANGI)).staffGmCredit, null);
  await setMode('shifts');
  await setHours(ANA, [{ day: 'sat', from: '10:00', to: '18:00' }]);
  assert.deepEqual((await me(ANA)).staffGmCredit, { mode: 'shifts', hours: [{ day: 'sat', from: '10:00', to: '18:00' }], hoursText: 'Sat 10am–6pm' });
  assert.deepEqual((await me(OWNER)).staffGmCredit, { mode: 'shifts', hours: [], hoursText: '' });
  await setMode('earn');
  assert.equal((await me(ANA)).staffGmCredit, null);
});

test('GM emails (round 17): the "Your credit" line follows the setting for a staff GM', async () => {
  const rules = lair.rulesCache;
  const game = (over = {}) => ({ gmCustomerId: ANA, gmFee: 500, start: at('2026-10-17', 12), end: at('2026-10-17', 16), ...over });
  assert.equal(lair.gmCreditLine(game(), rules), "None: you're on the Dice Goblin team, and staff don't earn GM credit for the sessions they run");
  assert.equal(lair.gmCreditLine(game({ gmCustomerId: RANGI }), rules), '$5.00 store credit for each paying player, after the session');
  assert.equal(lair.gmCreditLine(game({ gmFee: 0 }), rules), "None: you're covering your players' GM fee, so they pay just the table fee");
  await setMode('shifts');
  await setHours(ANA, [{ day: 'sat', from: '10:00', to: '13:00' }]);
  assert.equal(lair.gmCreditLine(game(), rules), "None for this session: it's in your hours (Sat 10am–1pm). Staff don't earn GM credit in their hours");
  assert.equal(lair.gmCreditLine(game({ start: at('2026-10-17', 13), end: at('2026-10-17', 17) }), rules), "$5.00 store credit for each paying player, after the session (it's outside your hours)");
  await setMode('earn');
  assert.equal(lair.gmCreditLine(game(), rules), '$5.00 store credit for each paying player, after the session');
});

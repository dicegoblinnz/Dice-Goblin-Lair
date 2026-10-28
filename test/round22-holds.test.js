// 28 Oct 2026, every hold can be edited (contract v22-holds). Mo, with a screenshot of the staff page's holds: "I can't
// edit any of the weeklies for the events and only the ones I made. Please make it so that all that have been created
// can be edited." An event date's own tables (POST /events/:occurrenceId/hold), the staff floor's holdEvents, every
// date of an event (POST /events/:handle/update), and editing a staff hold (POST /blocks/:id/update). Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { DEFAULT_HOURS, LairTime, eventHolds, rulesFromSettings } from '../src/core.js';
import { HOLD_WORDS as W } from '../src/holds.js';

// The staff page's refusal for a permission someone hasn't got (TEAM_WORDS.notYours in src/lair.js)
const NOT_PERMITTED = "That's not one of your staff permissions. Ask the main account to tick it on the Team tab.";
const STAFF_ONLY = 'Staff only. Log in with your staff account.';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Wednesday 28 October 2026, 1:00pm in Auckland (NZDT, UTC+13): the day Mo asked
const NOW = Date.UTC(2026, 9, 28, 0, 0);
const realNow = Date.now;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);

/* ---------------- helpers, as in test/round21-tables.test.js ---------------- */
function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      // as SQLite in a Durable Object: at most 100 bound values a query (Cloudflare's limit; 27 Oct 2026)
      if (bindings.length > 100) throw new Error(`too many SQL variables: ${bindings.length}`);
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

// The Lair's rooms as the store has them: the main room (T1-T21), the party room (P1-P4) and the fancy room (F1)
const ROOMS = [
  { id: 'main-room', name: 'Main room', code: 'T', tables: 21, seats: 4, order: 1 },
  { id: 'party-room', name: 'Party room', code: 'P', tables: 4, seats: 4, order: 2 },
  { id: 'fancy-room', name: 'Fancy room', code: 'F', tables: 1, seats: 12, price: 15, minPeople: 4, order: 3 },
];
// The store's weekly events on 28 Oct 2026 (Shopify's lair_event entries), as the Lair's rules hold them
const EVENTS = [
  { id: 'gundam-night', title: 'Gundam Weeklies', start: at('2026-10-09', 18), end: at('2026-10-09', 22), repeat: 'weekly', tables: 'T10-T13, T18-T21', lockTables: true },
  { id: 'pokemon-night', title: 'Pokémon League Weekly', start: at('2026-10-09', 19), end: at('2026-10-10', 0), repeat: 'weekly', tables: 'T10-T13, T18-T21', lockTables: true },
  {
    id: 'warhammer-night', title: 'Warhammer Night', start: at('2026-10-15', 18), end: at('2026-10-16', 0), repeat: 'weekly', tables: 'T8-T21', lockTables: true,
    gameTables: 'T8+T9, T10+T11, T12+T13, T14+T15, T18+T19, T20+T21', entryFee: 1000,
  },
  { id: 'clocktower', title: 'Blood on the Clocktower', start: at('2026-11-29', 12), end: at('2026-11-29', 18), tables: 'F1, P1-P4', lockTables: true, capacity: 40 },
  // a soft one: its tables marked for it but bookable, and game tables of its own
  { id: 'learn-night', title: 'Learn to play', start: at('2026-10-14', 18), end: at('2026-10-14', 20), repeat: 'weekly', tables: 'T20-T21', gameTables: 'T14+T15' },
  // and one with no tables at all
  { id: 'riftbound-night', title: 'Riftbound Nexus Nights', start: at('2026-10-13', 18), end: at('2026-10-13', 22), repeat: 'weekly', tables: '' },
];
const GUNDAM = 'gundam-night@2026-10-30';
const POKEMON = 'pokemon-night@2026-10-30';
const WARHAMMER = 'warhammer-night@2026-10-29';
const USUAL = ['T10', 'T11', 'T12', 'T13', 'T18', 'T19', 'T20', 'T21'];

// People by their Shopify customer IDs (made up): the main account; helpers Hemi (Tables), Ana (Events) and Tama
// (Library only); Mia, a customer
const OWNER = '9001';
const HEMI = '9102';
const ANA = '9101';
const TAMA = '9103';
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
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const holdDate = (occurrenceId, body, who = OWNER) => call('POST', `events/${encodeURIComponent(occurrenceId)}/hold`, body, who);
const board = async (who = OWNER, from = at('2026-10-28', 0), to = at('2026-12-28', 0)) => ok(await call('GET', `floor?from=${from}&to=${to}`, null, who));
const holdFor = (floor, occurrenceId, spots = false) => floor.eventHolds.find((h) => h.id === `ev-${occurrenceId}${spots ? '-spots' : ''}`);
const eventOn = (floor, eventId) => floor.holdEvents.find((e) => e.eventId === eventId);
const dateOn = (floor, occurrenceId) => floor.holdEvents.flatMap((e) => e.dates).find((d) => d.occurrenceId === occurrenceId);
/** A table booked online by Mia (a customer), 1 to 4 people */
const book = (tables, start, end, who = MIA) => call('POST', 'bookings', {
  kind: 'table', tables, start, end, people: 2, name: 'Mia Chen', email: 'mia@example.com', phone: '021 555 0100', pay: 'day',
}, who);
/** A staff hold (POST /blocks), one-off unless repeat is said */
const makeHold = (over = {}) => call('POST', 'blocks', {
  tables: 'T14-T17', start: at('2026-11-01', 14), end: at('2026-11-01', 22), label: 'Cyberpunk TCG Pre Release', type: 'tournament', ...over,
}, OWNER);
const editHold = (id, body, who = OWNER) => call('POST', `blocks/${id}/update`, body, who);
const blockRow = (id) => lair.sql.exec('SELECT * FROM blocks WHERE id = ?', id).one();
const seriesHolds = (seriesId) => lair.sql.exec('SELECT * FROM blocks WHERE series_id = ? ORDER BY starts_at', seriesId).toArray();
const ownRows = () => lair.sql.exec('SELECT * FROM event_hold_dates ORDER BY occurrence_id').toArray();

const useRules = (events = EVENTS) => {
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, events);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
};

// No network in these tests (but the stand-ins for Shopify's events that some tests switch on)
const realFetch = globalThis.fetch;
let reached = [];
let shopifyOn = false;

beforeEach(async () => {
  reached = [];
  shopifyOn = false;
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  Object.defineProperty(lair.shopify, 'configured', { get: () => shopifyOn, configurable: true });
  useRules();
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  for (const [id, name, perms] of [[HEMI, 'Hemi Walker', ['tables']], [ANA, 'Ana Ngata', ['events']], [TAMA, 'Tama Rewi', ['library']]]) {
    ok(await call('POST', 'team', { customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, perms }, OWNER));
  }
  lair.makeMember({ customerId: MIA, name: 'Mia Chen', email: 'mia@example.com' }, NOW);
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

/* ---------------- an event date's own tables ---------------- */

test("an event date's own tables: that date holds them (locked, changed), every other date keeps the usual ones", async () => {
  const done = ok(await holdDate(GUNDAM, { tables: ['T18', 'T19', 'T20', 'T21'] }));
  assert.deepEqual(done.hold, {
    eventId: 'gundam-night', title: 'Gundam Weeklies', occurrenceId: GUNDAM, start: at('2026-10-30', 18), end: at('2026-10-30', 22),
    tables: ['T18', 'T19', 'T20', 'T21'], changed: true, by: `staff:${OWNER}`, at: NOW,
  });
  assert.deepEqual(done.clashes, []);
  const floor = await board();
  assert.deepEqual(holdFor(floor, GUNDAM), {
    eventId: 'gundam-night', occurrenceId: GUNDAM, start: at('2026-10-30', 18), end: at('2026-10-30', 22), label: 'Gundam Weeklies', title: 'Gundam Weeklies',
    type: 'event', id: `ev-${GUNDAM}`, tables: ['T18', 'T19', 'T20', 'T21'], soft: false, changed: true,
  });
  // the next Friday, and the other Friday event, are as they were
  assert.deepEqual(holdFor(floor, 'gundam-night@2026-11-06').tables, USUAL);
  assert.equal(holdFor(floor, 'gundam-night@2026-11-06').changed, undefined);
  assert.deepEqual(holdFor(floor, POKEMON).tables, USUAL);
  // the public floor holds the same tables (and says nothing about who changed it)
  const pub = await board('');
  assert.deepEqual(holdFor(pub, GUNDAM).tables, ['T18', 'T19', 'T20', 'T21']);
  assert.equal(pub.holdEvents, undefined, 'holdEvents is for staff');
});

test("tables a date doesn't hold any more can be booked that date; the ones it holds are locked as before", async () => {
  // Friday 30 October: Gundam (6pm to 10pm) and Pokémon (7pm to midnight) both lock T10-T13 and T18-T21
  assert.equal(said(await book(['T10'], at('2026-10-30', 18), at('2026-10-30', 19))), '409 Table T10 is already taken at that time. Pick another.');
  ok(await holdDate(GUNDAM, { tables: 'T18-T21' }));
  ok(await holdDate(POKEMON, { tables: 'T10-T13' }));
  // T10 between 6pm and 7pm: Gundam doesn't hold it now, and Pokémon starts at 7pm
  ok(await book(['T10'], at('2026-10-30', 18), at('2026-10-30', 19)));
  // T18 is Gundam's until 10pm; T11 is Pokémon's from 7pm
  assert.equal((await book(['T18'], at('2026-10-30', 20), at('2026-10-30', 21))).status, 409);
  assert.equal((await book(['T11'], at('2026-10-30', 19), at('2026-10-30', 20))).status, 409);
  // and the next Friday still holds both lots for both events
  assert.equal((await book(['T10'], at('2026-11-06', 18), at('2026-11-06', 19))).status, 409);
});

test('a date with no tables held: [] or an empty string frees them all, and the event stays on the calendar', async () => {
  const done = ok(await holdDate(GUNDAM, { tables: [] }));
  assert.deepEqual(done.hold.tables, []);
  assert.equal(done.hold.changed, true);
  const floor = await board();
  assert.equal(holdFor(floor, GUNDAM), undefined, 'no hold that date');
  assert.deepEqual(dateOn(floor, GUNDAM), { occurrenceId: GUNDAM, start: at('2026-10-30', 18), end: at('2026-10-30', 22), tables: [], changed: true, by: `staff:${OWNER}`, at: NOW });
  // Pokémon still holds T10 from 7pm, so book 6pm to 7pm
  ok(await book(['T10'], at('2026-10-30', 18), at('2026-10-30', 19)));
  ok(await holdDate(WARHAMMER, { tables: '' }));
  assert.equal(holdFor(await board(), WARHAMMER), undefined);
  // the dates are still dates of the events
  assert.ok(lair.rulesCache.events.find((e) => e.id === 'gundam-night'));
});

test('back to usual: usual: true, or the usual tables sent again, keeps nothing for the date', async () => {
  ok(await holdDate(GUNDAM, { tables: ['T18'] }));
  assert.equal(ownRows().length, 1);
  const back = ok(await holdDate(GUNDAM, { usual: true }));
  assert.deepEqual(back.hold.tables, USUAL);
  assert.equal(back.hold.changed, false);
  assert.equal(back.hold.by, undefined);
  assert.equal(ownRows().length, 0);
  ok(await holdDate(GUNDAM, { tables: [] }));
  const same = ok(await holdDate(GUNDAM, { tables: ['T21', 'T20', 'T19', 'T18', 'T13', 'T12', 'T11', 'T10'] }));
  assert.equal(same.hold.changed, false);
  assert.deepEqual(same.hold.tables, USUAL, 'in table order');
  assert.equal(ownRows().length, 0);
  assert.deepEqual(holdFor(await board(), GUNDAM).tables, USUAL);
});

test("a date's own tables, written the Tables reserved way: ranges, a room's name and all; in table order", async () => {
  assert.deepEqual(ok(await holdDate(GUNDAM, { tables: 't21, t1-t3' })).hold.tables, ['T1', 'T2', 'T3', 'T21']);
  assert.deepEqual(ok(await holdDate(GUNDAM, { tables: 'Party room' })).hold.tables, ['P1', 'P2', 'P3', 'P4']);
  assert.deepEqual(ok(await holdDate(GUNDAM, { tables: 'all' })).hold.tables.length, 26);
  assert.deepEqual(ok(await holdDate(GUNDAM, { tables: ['p2', 'T1'] })).hold.tables, ['T1', 'P2']);
});

test('the words: no tables or usual, tables that do not exist, a date that is not on the calendar or has finished', async () => {
  assert.equal(said(await holdDate(GUNDAM, {})), `422 ${W.sendTables}`);
  assert.equal(said(await holdDate(GUNDAM, { tables: 5 })), `422 ${W.sendTables}`);
  assert.equal(said(await holdDate(GUNDAM, { tables: 'T10-T30' })), `422 ${W.badTables}`);
  assert.equal(said(await holdDate(GUNDAM, { tables: ['T10', 'Z9'] })), `422 ${W.badTables}`);
  // Gundam is on Fridays: there's no Thursday date, and no such event
  assert.equal(said(await holdDate('gundam-night@2026-10-29', { tables: [] })), `404 ${W.noDate}`);
  assert.equal(said(await holdDate('no-such-event@2026-10-30', { tables: [] })), `404 ${W.noDate}`);
  assert.equal(said(await holdDate('gundam-night', { tables: [] })), `404 ${W.noDate}`);
  // last Friday (23 October) has finished; so has this Friday once it's over
  assert.equal(said(await holdDate('gundam-night@2026-10-23', { tables: [] })), `409 ${W.dateOver}`);
  Date.now = () => at('2026-10-30', 22);
  assert.equal(said(await holdDate(GUNDAM, { tables: [] })), `409 ${W.dateOver}`);
  // one under way can still change
  Date.now = () => at('2026-10-30', 21);
  ok(await holdDate(GUNDAM, { tables: ['T18'] }));
  assert.equal(ownRows().length, 1);
});

test('who: staff with Tables or Events, and the main account; not Library alone, a customer or someone logged out', async () => {
  ok(await holdDate(GUNDAM, { tables: ['T18'] }, HEMI));
  ok(await holdDate(GUNDAM, { tables: ['T19'] }, ANA));
  assert.equal(said(await holdDate(GUNDAM, { tables: [] }, TAMA)), `403 ${NOT_PERMITTED}`);
  assert.equal(said(await holdDate(GUNDAM, { tables: [] }, MIA)), `403 ${STAFF_ONLY}`);
  assert.equal(said(await holdDate(GUNDAM, { tables: [] }, '')), `403 ${STAFF_ONLY}`);
  assert.deepEqual(JSON.parse(ownRows()[0].tables), ['T19']);
  assert.equal(ownRows()[0].by, `staff:${ANA}`);
});

test('holding never moves a booking: clashes lists those on the tables it holds, but not the event’s own game tables', async () => {
  // Mia has T1 on Thursday 29 October, 7pm to 9pm; Sam has Warhammer's game table T8+T9 that night
  ok(await book(['T1'], at('2026-10-29', 19), at('2026-10-29', 21)));
  const spot = await call('POST', `events/${encodeURIComponent(WARHAMMER)}/reserve`, {
    spot: 'T8+T9', people: 2, name: 'Sam Lee', email: 'sam@example.com', phone: '021 555 0101',
  }, MIA);
  assert.equal(spot.status, 200, spot.data.error);
  const done = ok(await holdDate(WARHAMMER, { tables: 'T1-T9' }));
  assert.deepEqual(done.clashes.map((c) => [c.start]), [[at('2026-10-29', 19)]]);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed'").one().n, 2, 'both bookings stay');
});

test("game tables stay the event's, never repeating a table the date's locked hold has (usual or its own)", async () => {
  // Warhammer's pairs are inside its locked T8-T21: no game-table hold of their own
  let floor = await board();
  assert.equal(holdFor(floor, WARHAMMER, true), undefined);
  // this Thursday it holds T8-T13 only: the freed pairs aren't set aside for it (they're its usual tables)
  ok(await holdDate(WARHAMMER, { tables: 'T8-T13' }));
  floor = await board();
  assert.deepEqual(holdFor(floor, WARHAMMER).tables, ['T8', 'T9', 'T10', 'T11', 'T12', 'T13']);
  assert.equal(holdFor(floor, WARHAMMER, true), undefined);
  // a soft event's game tables stay set aside whatever its date holds
  ok(await holdDate('learn-night@2026-11-04', { tables: [] }));
  floor = await board();
  assert.equal(holdFor(floor, 'learn-night@2026-11-04'), undefined);
  assert.deepEqual(holdFor(floor, 'learn-night@2026-11-04', true).tables, ['T14', 'T15']);
  // and a locked date's own tables that are game tables aren't repeated as game tables
  ok(await holdDate('learn-night@2026-11-11', { tables: ['T14'] }));
  assert.deepEqual(holdFor(await board(), 'learn-night@2026-11-11', true).tables, ['T14', 'T15'], 'soft: the game tables still show');
});

test('an event with no Tables reserved can hold a date’s own; a locked one blocks bookings that date only', async () => {
  const riftbound = 'riftbound-night@2026-11-03';
  ok(await holdDate(riftbound, { tables: ['T1', 'T2'] }));
  const floor = await board();
  // Riftbound isn't locked, so its date's tables are soft (marked for it, still bookable)
  assert.deepEqual(holdFor(floor, riftbound), {
    eventId: 'riftbound-night', occurrenceId: riftbound, start: at('2026-11-03', 18), end: at('2026-11-03', 22), label: 'Riftbound Nexus Nights',
    title: 'Riftbound Nexus Nights', type: 'event', id: `ev-${riftbound}`, tables: ['T1', 'T2'], soft: true, changed: true,
  });
  ok(await book(['T1'], at('2026-11-03', 18), at('2026-11-03', 19)));
  // Clocktower (locked) moved to the main room's T1-T4 for its one date
  ok(await holdDate('clocktower@2026-11-29', { tables: 'T1-T4' }));
  assert.equal((await book(['T3'], at('2026-11-29', 13), at('2026-11-29', 14))).status, 409);
  ok(await book(['P1'], at('2026-11-29', 13), at('2026-11-29', 14)));
});

test("the staff floor's holdEvents: each event with tables held, its usual tables, tag, lock, game tables and every date", async () => {
  ok(await holdDate(GUNDAM, { tables: ['T18', 'T19', 'T20', 'T21'] }));
  ok(await holdDate('gundam-night@2026-11-13', { tables: [] }));
  ok(await holdDate('riftbound-night@2026-11-03', { tables: ['T1'] }));
  const floor = await board(OWNER, at('2026-10-28', 0), at('2026-11-21', 0));
  // soonest date first: Learn to play is tonight (Wednesday), Warhammer tomorrow, the Friday nights after that
  assert.deepEqual(floor.holdEvents.map((e) => e.eventId), ['learn-night', 'warhammer-night', 'gundam-night', 'pokemon-night', 'riftbound-night']);
  const gundam = eventOn(floor, 'gundam-night');
  assert.deepEqual({ ...gundam, dates: undefined }, {
    eventId: 'gundam-night', title: 'Gundam Weeklies', repeat: 'weekly', repeatTag: 'Weekly · Fridays 6pm', usual: USUAL, usualText: 'T10-T13, T18-T21',
    locked: true, gameTables: '', dates: undefined,
  });
  assert.deepEqual(gundam.dates, [
    { occurrenceId: GUNDAM, start: at('2026-10-30', 18), end: at('2026-10-30', 22), tables: ['T18', 'T19', 'T20', 'T21'], changed: true, by: `staff:${OWNER}`, at: NOW },
    { occurrenceId: 'gundam-night@2026-11-06', start: at('2026-11-06', 18), end: at('2026-11-06', 22), tables: USUAL, changed: false },
    { occurrenceId: 'gundam-night@2026-11-13', start: at('2026-11-13', 18), end: at('2026-11-13', 22), tables: [], changed: true, by: `staff:${OWNER}`, at: NOW },
    { occurrenceId: 'gundam-night@2026-11-20', start: at('2026-11-20', 18), end: at('2026-11-20', 22), tables: USUAL, changed: false },
  ]);
  assert.equal(eventOn(floor, 'warhammer-night').gameTables, 'T8+T9, T10+T11, T12+T13, T14+T15, T18+T19, T20+T21');
  assert.equal(eventOn(floor, 'learn-night').locked, false);
  // Riftbound has no Tables reserved: only its date with its own tables
  assert.deepEqual(eventOn(floor, 'riftbound-night').dates.map((d) => d.occurrenceId), ['riftbound-night@2026-11-03']);
  assert.deepEqual(eventOn(floor, 'riftbound-night').usual, []);
  // a one-off: no repeat, no tag
  const later = await board(OWNER, at('2026-11-28', 0), at('2026-11-30', 0));
  assert.deepEqual({ ...eventOn(later, 'clocktower'), dates: undefined }, {
    eventId: 'clocktower', title: 'Blood on the Clocktower', repeat: null, repeatTag: null, usual: ['F1', 'P1', 'P2', 'P3', 'P4'], usualText: 'F1, P1-P4',
    locked: true, gameTables: '', dates: undefined,
  });
  // helpers who see the staff floor get it too; the public and customers don't
  assert.ok((await board(HEMI)).holdEvents);
  assert.equal((await board(MIA)).holdEvents, undefined);
});

test("the POS's today: an event's group has its date's own tables", async () => {
  Date.now = () => at('2026-10-30', 12);
  ok(await holdDate(GUNDAM, { tables: ['T18', 'T19'] }));
  const today = await lair.posToday();
  assert.deepEqual(today.groups.find((g) => g.key === `event:${GUNDAM}`).tables, ['T18', 'T19']);
  // Pokémon's group keeps its usual tables
  assert.deepEqual(today.groups.find((g) => g.key === `event:${POKEMON}`).tables, USUAL);
  // and eventHolds, given the rules as the Lair keeps them, says the same
  const rules = await lair.rules();
  assert.deepEqual(eventHolds(rules, at('2026-10-30', 0), at('2026-10-31', 0)).find((h) => h.occurrenceId === GUNDAM).tables, ['T18', 'T19']);
});

test("a date keeps its own tables when the event's times change, and they come back with a date that comes back", async () => {
  ok(await holdDate(GUNDAM, { tables: ['T18'] }));
  // the event moves to 5pm to 9pm: the date keeps its own tables at its new times
  useRules(EVENTS.map((e) => (e.id === 'gundam-night' ? { ...e, start: at('2026-10-09', 17), end: at('2026-10-09', 21) } : e)));
  let hold = holdFor(await board(), GUNDAM);
  assert.deepEqual([hold.tables, hold.start, hold.end], [['T18'], at('2026-10-30', 17), at('2026-10-30', 21)]);
  // skipped in Shopify: nothing held; back again: its own tables again
  useRules(EVENTS.map((e) => (e.id === 'gundam-night' ? { ...e, skipDates: ['2026-10-30'] } : e)));
  assert.equal(holdFor(await board(), GUNDAM), undefined);
  useRules();
  hold = holdFor(await board(), GUNDAM);
  assert.deepEqual(hold.tables, ['T18']);
});

test('across daylight saving: a date after the clocks go back keeps its 6pm start and its own tables', async () => {
  // NZ clocks go back on Sunday 4 April 2027: Friday 9 April is NZST (UTC+12)
  const april = 'gundam-night@2027-04-09';
  const done = ok(await holdDate(april, { tables: ['T20'] }));
  assert.equal(done.hold.start, Date.UTC(2027, 3, 9, 6, 0));
  assert.equal(done.hold.start, at('2027-04-09', 18));
  const floor = await board(OWNER, at('2027-04-09', 0), at('2027-04-10', 0));
  assert.deepEqual(holdFor(floor, april).tables, ['T20']);
});

test("maintenance forgets a date's own tables 31 days after the date ends, not before", async () => {
  ok(await holdDate(GUNDAM, { tables: ['T18'] }));
  ok(await holdDate('gundam-night@2026-11-06', { tables: [] }));
  assert.equal(lair.tidyHoldDates(at('2026-11-30', 22)), 0);
  assert.equal(lair.tidyHoldDates(at('2026-12-01', 0)), 1, '31 days after 30 October 10pm');
  assert.deepEqual(ownRows().map((r) => r.occurrence_id), ['gundam-night@2026-11-06']);
});

/* ---------------- every date of an event (the Events tab's update) ---------------- */

/** Shopify's lair_event entries, held here (the Admin API's answers for the events editor and the rules) */
function eventsInShopify() {
  const nodes = new Map();
  const toField = (ms) => lair.lairIso(ms, TZ);
  let n = 1;
  for (const e of EVENTS) {
    const fields = {
      title: e.title, event_type: 'tcg', starts_at: toField(e.start), ends_at: toField(e.end), repeat: e.repeat || null, tables: e.tables || null,
      lock_tables: e.lockTables ? 'true' : 'false', game_tables: e.gameTables || null, entry_fee: e.entryFee ? (e.entryFee / 100).toFixed(2) : null,
      capacity: e.capacity ? String(e.capacity) : null,
    };
    nodes.set(e.id, { id: `gid://shopify/Metaobject/${n}`, handle: e.id, updatedAt: new Date(NOW).toISOString(), fields });
    n += 1;
  }
  const node = (x) => ({ id: x.id, handle: x.handle, updatedAt: x.updatedAt, fields: Object.entries(x.fields).map(([key, value]) => ({ key, type: 'single_line_text_field', value })) });
  shopifyOn = true;
  lair.shopify.lairEventByHandle = async (handle) => (nodes.has(handle) ? node(nodes.get(handle)) : null);
  lair.shopify.updateLairEvent = async (id, fields) => {
    const x = [...nodes.values()].find((v) => v.id === id);
    for (const { key, value } of fields) x.fields[key] = value === '' ? null : value;
    return { metaobject: node(x), userErrors: [] };
  };
  lair.shopify.deleteLairEvent = async (id) => {
    const x = [...nodes.values()].find((v) => v.id === id);
    nodes.delete(x.handle);
    return { deletedId: id, userErrors: [] };
  };
  lair.shopify.loadLairData = async () => ({
    rooms: ROOMS, events: [...nodes.values()].map((x) => lair.eventRule(x.handle, x.fields)), theme: null, shop: {},
    settingsText: JSON.stringify({ current: { lair_hours: DEFAULT_HOURS, lair_shop_tables: '' } }),
  });
  lair.rulesLoadedAt = 0;
  return nodes;
}

test("every date: new Tables reserved for the event; dates with their own keep them, those now the same go back to usual", async () => {
  const nodes = eventsInShopify();
  ok(await holdDate(GUNDAM, { tables: ['T18', 'T19', 'T20', 'T21'] }));
  ok(await holdDate('gundam-night@2026-11-13', { tables: [] }));
  const done = ok(await call('POST', 'events/gundam-night/update', { tables: 'T18-T21' }, OWNER));
  assert.equal(done.event.tables, 'T18-T21');
  assert.equal(nodes.get('gundam-night').fields.tables, 'T18-T21');
  // 30 October had T18-T21 of its own, the new usual: back to usual. 13 November keeps none.
  assert.deepEqual(ownRows().map((r) => [r.occurrence_id, JSON.parse(r.tables)]), [['gundam-night@2026-11-13', []]]);
  const floor = await board();
  assert.deepEqual(eventOn(floor, 'gundam-night').usual, ['T18', 'T19', 'T20', 'T21']);
  assert.deepEqual(dateOn(floor, GUNDAM), { occurrenceId: GUNDAM, start: at('2026-10-30', 18), end: at('2026-10-30', 22), tables: ['T18', 'T19', 'T20', 'T21'], changed: false });
  assert.deepEqual(dateOn(floor, 'gundam-night@2026-11-06').tables, ['T18', 'T19', 'T20', 'T21']);
  assert.deepEqual(dateOn(floor, 'gundam-night@2026-11-13').tables, []);
  // a change that isn't to its tables leaves every date be; Events alone (Ana) can change every date, Tables alone can't
  ok(await call('POST', 'events/gundam-night/update', { lockTables: false }, ANA));
  assert.equal(ownRows().length, 1);
  assert.equal(said(await call('POST', 'events/gundam-night/update', { tables: '' }, HEMI)), `403 ${NOT_PERMITTED}`);
  // no tables reserved any more: a date with tables of its own keeps them; one with none is the same as usual now
  ok(await holdDate('gundam-night@2026-11-20', { tables: ['T1'] }));
  ok(await call('POST', 'events/gundam-night/update', { tables: '' }, OWNER));
  assert.deepEqual(ownRows().map((r) => r.occurrence_id), ['gundam-night@2026-11-20']);
  const after = await board();
  assert.equal(holdFor(after, 'gundam-night@2026-11-06'), undefined);
  assert.deepEqual(holdFor(after, 'gundam-night@2026-11-20').tables, ['T1']);
  assert.deepEqual(eventOn(after, 'gundam-night').dates.map((d) => d.occurrenceId), ['gundam-night@2026-11-20'], 'only its date with its own');
});

test("a deleted event's dates' own tables go with it, so a new event with its handle starts clean", async () => {
  const nodes = eventsInShopify();
  ok(await holdDate('clocktower@2026-11-29', { tables: 'T1-T4' }));
  ok(await holdDate(GUNDAM, { tables: [] }));
  ok(await call('POST', 'events/clocktower/delete', {}, OWNER));
  assert.equal(nodes.has('clocktower'), false);
  assert.deepEqual(ownRows().map((r) => r.occurrence_id), [GUNDAM]);
});

/* ---------------- editing a staff hold ---------------- */

test('a one-off staff hold: its tables, day, times, what it is for and its type change; the floor and bookings follow', async () => {
  const { block } = ok(await makeHold());
  const done = ok(await editHold(block.id, { tables: ['T14', 'T15', 'T16', 'T17', 'T18'], start: at('2026-11-01', 13), end: at('2026-11-01', 21), label: 'Cyberpunk prerelease', type: 'event' }));
  assert.deepEqual(done.block, {
    id: block.id, tables: ['T14', 'T15', 'T16', 'T17', 'T18'], start: at('2026-11-01', 13), end: at('2026-11-01', 21), label: 'Cyberpunk prerelease', type: 'event',
    game: null, seriesId: null, repeat: null, repeatTag: null, until: null,
  });
  assert.deepEqual([done.clashes, done.series, done.kept], [[], null, []]);
  // to another day, written the Hold tables form's way
  ok(await editHold(block.id, { tables: 't20-t21', start: at('2026-11-02', 18), end: at('2026-11-02', 22) }));
  const row = blockRow(block.id);
  assert.deepEqual([JSON.parse(row.tables), row.starts_at, row.ends_at, row.label, row.changed], [['T20', 'T21'], at('2026-11-02', 18), at('2026-11-02', 22), 'Cyberpunk prerelease', 0]);
  // T14 on Sunday is free again; T20 on Monday isn't
  ok(await book(['T14'], at('2026-11-01', 14), at('2026-11-01', 15)));
  assert.equal((await book(['T20'], at('2026-11-02', 19), at('2026-11-02', 20))).status, 409);
  // the public floor sees a hold, as before
  const pub = (await board('')).blocks.find((b) => b.id === block.id);
  assert.deepEqual(Object.keys(pub).sort(), ['end', 'game', 'id', 'label', 'start', 'tables', 'type']);
  // an empty label is Held, as when it's made
  assert.equal(ok(await editHold(block.id, { label: '  ' })).block.label, 'Held');
});

test('a staff hold edit: holding never moves a booking, and clashes says who overlaps', async () => {
  ok(await book(['T2'], at('2026-11-02', 17), at('2026-11-02', 19)));
  const { block } = ok(await makeHold());
  const done = ok(await editHold(block.id, { tables: ['T1', 'T2'], start: at('2026-11-02', 18), end: at('2026-11-02', 22) }));
  assert.deepEqual(done.clashes.map((c) => c.start), [at('2026-11-02', 17)]);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed'").one().n, 1);
});

test("a staff hold edit's words: not found, finished, tables, times, and who may", async () => {
  const { block } = ok(await makeHold());
  assert.equal(said(await editHold('bl_nope', { label: 'x' })), `404 ${W.noHold}`);
  assert.equal(said(await editHold(block.id, { tables: [] })), `422 ${W.holdTables}`);
  assert.equal(said(await editHold(block.id, { tables: ['T99'] })), `422 ${W.holdTables}`);
  assert.equal(said(await editHold(block.id, { tables: 'nowhere' })), `422 ${W.holdTables}`);
  assert.equal(said(await editHold(block.id, { end: at('2026-11-01', 13) })), `422 ${W.endAfter}`);
  assert.equal(said(await editHold(block.id, { start: 'soon' })), `422 ${W.endAfter}`);
  assert.equal(said(await editHold(block.id, { start: at('2026-10-27', 18), end: at('2026-10-27', 22) })), `422 ${W.endPast}`);
  assert.equal(said(await editHold(block.id, { label: 'x' }, TAMA)), `403 ${NOT_PERMITTED}`);
  assert.equal(said(await editHold(block.id, { label: 'x' }, ANA)), `403 ${NOT_PERMITTED}`, 'Events alone is not Tables');
  assert.equal(said(await editHold(block.id, { label: 'x' }, MIA)), `403 ${STAFF_ONLY}`);
  ok(await editHold(block.id, { label: 'Pre Release' }, HEMI));
  Date.now = () => at('2026-11-01', 22);
  assert.equal(said(await editHold(block.id, { label: 'late' })), `409 ${W.holdOver}`);
  assert.equal(blockRow(block.id).label, 'Pre Release');
});

/** The Warhammer league's weekly hold: Thursdays 6pm to 10pm on T14-T17, from Thursday 29 October */
async function league() {
  const made = ok(await makeHold({ tables: 'T14-T17', start: at('2026-10-29', 18), end: at('2026-10-29', 22), label: 'Warhammer league', type: 'tournament', repeat: 'weekly' }));
  return { seriesId: made.series.id, ids: seriesHolds(made.series.id).map((r) => r.id) };
}

test("a weekly hold's date needs a scope: this date only, or every date to come", async () => {
  const { ids } = await league();
  assert.equal(said(await editHold(ids[1], { tables: ['T14'] })), `422 ${W.scope}`);
  assert.equal(said(await editHold(ids[1], { tables: ['T14'], scope: 'both' })), `422 ${W.scope}`);
});

test("a weekly hold's date on its own: its tables and times change, it's marked changed, what it's for stays the hold's", async () => {
  const { ids, seriesId } = await league();
  const done = ok(await editHold(ids[1], { scope: 'date', tables: ['T14', 'T15'], start: at('2026-11-05', 19), end: at('2026-11-05', 23), label: 'Not this' }));
  assert.deepEqual(done.block, {
    id: ids[1], tables: ['T14', 'T15'], start: at('2026-11-05', 19), end: at('2026-11-05', 23), label: 'Warhammer league', type: 'tournament', game: null,
    seriesId, repeat: 'weekly', repeatTag: 'Weekly · Thursdays 6pm', until: null, changed: true,
  });
  assert.equal(done.series.id, seriesId);
  // the other dates are as they were
  for (const id of [ids[0], ids[2]]) assert.deepEqual(JSON.parse(blockRow(id).tables), ['T14', 'T15', 'T16', 'T17']);
  // staff see it's changed; the public don't
  assert.equal((await board()).blocks.find((b) => b.id === ids[1]).changed, true);
  assert.equal((await board('')).blocks.find((b) => b.id === ids[1]).changed, undefined);
  // its own day only
  assert.equal(said(await editHold(ids[1], { scope: 'date', start: at('2026-11-06', 18), end: at('2026-11-06', 22) })), `422 ${W.sameDay}`);
  // a late night that ends after midnight is still its day
  ok(await editHold(ids[1], { scope: 'date', start: at('2026-11-05', 20), end: at('2026-11-06', 1) }));
  // back to usual: the hold's tables and times, not changed
  const back = ok(await editHold(ids[1], { scope: 'date', usual: true }));
  assert.deepEqual([back.block.tables, back.block.start, back.block.end, back.block.changed], [['T14', 'T15', 'T16', 'T17'], at('2026-11-05', 18), at('2026-11-05', 22), undefined]);
  assert.equal(blockRow(ids[1]).changed, 0);
  // the same tables and times as the hold's are not a change either
  ok(await editHold(ids[2], { scope: 'date', tables: 'T14-T17' }));
  assert.equal(blockRow(ids[2]).changed, 0);
});

test('every date to come: the dates and the series take the new tables, times and words; changed and started dates keep theirs', async () => {
  const { ids, seriesId } = await league();
  ok(await editHold(ids[2], { scope: 'date', tables: ['T17'] }));
  // it's Thursday 29 October, 7pm: the first date is under way
  Date.now = () => at('2026-10-29', 19);
  const done = ok(await editHold(ids[1], { scope: 'series', tables: 'T18-T21', start: at('2026-11-05', 17), end: at('2026-11-05', 21, 30), label: 'Warhammer league night', type: 'event' }));
  assert.deepEqual(done.kept, [{ id: ids[2], start: at('2026-11-12', 18) }]);
  assert.equal(done.series.tables.join(), 'T18,T19,T20,T21');
  assert.equal(done.series.startTime, '17:00');
  assert.equal(done.series.minutes, 270);
  assert.equal(done.series.label, 'Warhammer league night');
  assert.equal(done.series.repeatTag, 'Weekly · Thursdays 5pm');
  const rows = seriesHolds(seriesId);
  const view = (r) => [time.key(r.starts_at), JSON.parse(r.tables).join('+'), time.minutesOf(r.starts_at), (r.ends_at - r.starts_at) / MIN, r.label, r.type, r.changed];
  assert.deepEqual(view(rows[0]), ['2026-10-29', 'T14+T15+T16+T17', 18 * 60, 240, 'Warhammer league', 'tournament', 0], 'under way: as it was');
  assert.deepEqual(view(rows[1]), ['2026-11-05', 'T18+T19+T20+T21', 17 * 60, 270, 'Warhammer league night', 'event', 0]);
  assert.deepEqual(view(rows[2]), ['2026-11-12', 'T17', 18 * 60, 240, 'Warhammer league night', 'event', 1], 'changed on its own: its tables and times, the new words');
  for (const r of rows.slice(3)) assert.deepEqual(view(r).slice(1), ['T18+T19+T20+T21', 17 * 60, 270, 'Warhammer league night', 'event', 0], time.key(r.starts_at));
  // back to usual is the new usual
  const back = ok(await editHold(ids[2], { scope: 'date', usual: true }));
  assert.deepEqual([back.block.tables.join(), back.block.start, back.block.end], ['T18,T19,T20,T21', at('2026-11-12', 17), at('2026-11-12', 21, 30)]);
  // dates made later take the new hold
  Date.now = () => NOW + 21 * DAY;
  lair.extendHoldSeries(lair.rulesCache, Date.now());
  const last = seriesHolds(seriesId).at(-1);
  assert.ok(last.starts_at > rows.at(-1).starts_at, 'a later date was made');
  assert.deepEqual(view(last).slice(1), ['T18+T19+T20+T21', 17 * 60, 270, 'Warhammer league night', 'event', 0]);
});

test("every date to come: clashes across the dates it changed; skipping a changed date still skips it", async () => {
  const { ids, seriesId } = await league();
  ok(await book(['T1'], at('2026-11-12', 18), at('2026-11-12', 20)));
  const done = ok(await editHold(ids[0], { scope: 'series', tables: ['T1', 'T2'] }));
  assert.deepEqual(done.clashes.map((c) => c.start), [at('2026-11-12', 18)]);
  ok(await editHold(ids[3], { scope: 'date', tables: ['T2'] }));
  ok(await call('POST', `blocks/${ids[3]}/delete`, {}, OWNER));
  assert.equal(blockRow(ids[3]), undefined);
  assert.ok(JSON.parse(lair.sql.exec('SELECT skip_days FROM block_series WHERE id = ?', seriesId).one().skip_days).includes('2026-11-19'));
});

test("a two-day one-off (Oddity Alley): each day is its own date, with its own tables, both on holdEvents", async () => {
  useRules([...EVENTS, { id: 'oddity-alley-november', title: 'Oddity Alley', start: at('2026-11-21', 10), end: at('2026-11-21', 15), tables: 'T1-T21', lockTables: true, days: 2 }]);
  ok(await holdDate('oddity-alley-november@2026-11-22', { tables: 'T1-T10' }));
  const floor = await board(OWNER, at('2026-11-20', 0), at('2026-11-24', 0));
  const alley = eventOn(floor, 'oddity-alley-november');
  assert.deepEqual(alley.dates.map((d) => [d.occurrenceId, d.tables.length, d.changed]), [['oddity-alley-november@2026-11-21', 21, false], ['oddity-alley-november@2026-11-22', 10, true]]);
  assert.equal(alley.repeat, null);
  // Sunday's T15 can be booked; Saturday's can't
  ok(await book(['T15'], at('2026-11-22', 11), at('2026-11-22', 12)));
  assert.equal((await book(['T15'], at('2026-11-21', 11), at('2026-11-21', 12))).status, 409);
});

test("a date's own tables ride along when the rules load again (and only the methods here change them)", async () => {
  ok(await holdDate(GUNDAM, { tables: ['T18'] }));
  // the rules come back as a new object (Shopify read again): the date still has its own tables
  useRules();
  lair.holdDatesCache = null;
  assert.deepEqual(holdFor(await board(), GUNDAM).tables, ['T18']);
  // a second Lair (the Durable Object started again) reads them from its database
  const again = new Lair(lair.ctx, { CURRENCY: 'NZD' });
  again.rulesCache = lair.rulesCache;
  again.rulesLoadedAt = lair.rulesLoadedAt;
  const rules = await again.rules();
  assert.deepEqual(eventHolds(rules, at('2026-10-30', 0), at('2026-10-31', 0)).find((h) => h.occurrenceId === GUNDAM).tables, ['T18']);
});

test('a GM game, a staff hold and a walk-in are checked against the date’s own tables too (staff skip locked tables, as before)', async () => {
  ok(await holdDate(POKEMON, { tables: ['T1'] }));
  ok(await holdDate(GUNDAM, { tables: ['T2'] }));
  // a customer can't book T1 at 8pm that Friday now, but T10 (no longer held by either) is free
  assert.equal((await book(['T1'], at('2026-10-30', 20), at('2026-10-30', 21))).status, 409);
  ok(await book(['T10'], at('2026-10-30', 20), at('2026-10-30', 21)));
  // staff booking for someone skip locked event tables (blockingItems' staff), as before
  const staffBooking = await call('POST', 'bookings', {
    kind: 'table', tables: ['T1'], start: at('2026-10-30', 20), end: at('2026-10-30', 21), people: 2, name: 'Walk-in', pay: 'day', staffOverride: true,
  }, OWNER);
  assert.equal(staffBooking.status, 200, staffBooking.data.error);
});

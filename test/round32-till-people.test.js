// Round 32, the till, part 2: real people on the till (contract v32-till, section 5). Mo (6 Nov 2026): the counter faces
// customers, "people just scan their code and immediately start using it"; staff sign in to sort things out. A member's
// code opens their own screen (what they owe today, with the same basket lines the counter tile gets, their card, store
// credit, passes and games at home); staff on the till with Check-in also find people by name and see tonight's list.
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { TILL_PEOPLE_WORDS as P } from '../src/till-people.js';
import { TILL_WORDS as W } from '../src/till.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 60 * MIN;
// Sunday 25 October 2026, 10:00am in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 9, 24, 21, 0);
const DAY = '2026-10-25';
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const realNow = Date.now;
const nowIs = (ms) => {
  Date.now = () => ms;
};

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

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];
// Tonight's trivia night, $5 a person, paid at the counter
const EVENTS = [{ id: 'quiz', title: 'Trivia night', start: at(DAY, 18), end: at(DAY, 20), tables: '', capacity: 20, entryFee: 500 }];
// Mo (the owner); helpers Hemi (Check-in) and Tama (Library only); members Mia and Kai
const OWNER = '9001';
const HEMI = '9102';
const TAMA = '9103';
const MIA = '6001';
const KAI = '6002';

let lair;
let credit;
let creditAsks;
async function call(method, path, body, customer = '', client = '203.0.113.7') {
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, 'X-Lair-Client': client },
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, data: await response.json() };
}
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const said = (res, status, words) => {
  assert.equal(res.status, status, res.data.error);
  if (words) assert.equal(res.data.error, words);
};
const internal = (path, body) => lair.fetch(new Request(`https://lair.test/internal/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body: JSON.stringify(body),
})).then(async (r) => ({ status: r.status, data: await r.json() }));
// someone on the till with their own PIN (the counter tablet is logged in as the owner's account here)
const onTill = async (id, pin = '2580', as = OWNER) => {
  const u = ok(await call('POST', 'till/unlock', { id, pin: '1234' }, as));
  ok(await call('POST', 'till/pin', { token: u.token, pin }, as));
  return u.token;
};
const scan = (code, token, as = OWNER, client) => call('POST', 'till/scan', token ? { code, token } : { code }, as, client);

beforeEach(async () => {
  globalThis.fetch = async (url) => {
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  credit = { [MIA]: 450 };
  creditAsks = [];
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.searchCustomers = async () => [{ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }];
  lair.shopify.storeCreditBalance = async (id) => {
    creditAsks.push(id);
    if (credit === 'down') throw new Error('Shopify is down');
    return credit[id] ?? 0;
  };
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.notifyStaff = () => {};
  lair.mail = async () => ({ ok: true });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  for (const [id, name, perms] of [[HEMI, 'Hemi Walker', ['checkin']], [TAMA, 'Tama Rewi', ['library']]]) {
    ok(await call('POST', 'team', { customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, perms }, OWNER));
  }
  for (const [id, name] of [[MIA, 'Mia Tamaki'], [KAI, 'Kai Tane']]) {
    lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
  }
});

afterEach(() => {
  Date.now = realNow;
});

// Mia's night: a table for 2 at 6pm and two places at trivia, all paid at the counter
async function miasNight() {
  const table = ok(await call('POST', 'bookings', { kind: 'table', tables: ['T1'], start: at(DAY, 18), end: at(DAY, 20), people: 2, name: 'Mia', email: 'mia@example.com', phone: '021 555 0100', pay: 'day' }, MIA)).booking;
  const join = ok(await call('POST', `events/quiz@${DAY}/join`, { name: 'Mia', email: 'mia@example.com', phone: '021 555 0100', people: 2 }, MIA)).join;
  return { table, join };
}

test('round 32 part 2: scanning on the till needs a staff account', async () => {
  for (const as of ['', MIA]) {
    for (const path of ['till/scan', 'till/find', 'till/person', 'till/tonight']) said(await call('POST', path, {}, as), 403, W.staffOnly);
  }
});

test("round 32 part 2: a member's code opens their screen: today's rows with the counter tile's own lines, card, credit, passes", async () => {
  const { table, join } = await miasNight();
  const code = lair.memberRow(MIA).code;
  const res = ok(await scan(code));
  assert.equal(res.type, 'person');
  const p = res.person;
  assert.equal(p.id, MIA);
  assert.equal(p.first, 'Mia');
  // the customer screen: first name and initial; no email
  assert.equal(p.name, 'Mia T.');
  assert.equal(p.email, undefined);
  assert.equal(p.code, code);
  assert.equal(p.credit, 450);
  // the same rows and lines as the counter tile's /pos/scan
  const pos = ok(await internal('pos/scan', { code }));
  const tile = pos.rows.filter((r) => r.due > 0 && r.status !== 'noshow');
  assert.deepEqual(p.bookings.map((b) => b.code), pos.rows.map((r) => r.ref));
  assert.deepEqual(p.bookings.flatMap((b) => b.lines.map((l) => l.line)), tile.map((r) => lair.posLine(r, lair.rulesCache)));
  assert.deepEqual(p.bookings.flatMap((b) => b.lines.map((l) => l.price)), tile.map((r) => r.due));
  const quiz = p.bookings.find((b) => b.code === join.ref);
  assert.deepEqual([quiz.title, quiz.lines[0].sub, quiz.lines[0].price, quiz.lines[0].session], ['Trivia night', `Event entry · ${join.ref}`, 1000, true]);
  const t = p.bookings.find((b) => b.code === table.ref);
  assert.equal(t.lines[0].sub, `Table fee · T1, 2 people · ${table.ref}`);
  // their card as the counter shows it, and nothing at home or on a pass yet
  assert.deepEqual(p.loyalty, pos.loyalty);
  assert.deepEqual([p.passes, p.library, p.account.billing], [[], [], 'visit']);
  // a member with nothing today still opens (a quick visit for a drink)
  const kai = ok(await scan(lair.memberRow(KAI).code)).person;
  assert.deepEqual([kai.name, kai.bookings, kai.credit], ['Kai T.', [], 0]);
});

test("round 32 part 2: store credit is asked of Shopify at most once a minute, and says null when Shopify can't", async () => {
  const code = lair.memberRow(MIA).code;
  ok(await scan(code));
  ok(await scan(code));
  assert.deepEqual(creditAsks, [MIA]);
  nowIs(NOW + 2 * MIN);
  credit = 'down';
  assert.equal(ok(await scan(code)).person.credit, null);
});

test('round 32 part 2: a booking code alone shows that booking and a first name; staff on the till see its account holder', async () => {
  const { table } = await miasNight();
  const res = ok(await scan(table.ref));
  assert.equal(res.type, 'booking');
  assert.equal(res.name, 'Mia');
  assert.equal(res.booking.code, table.ref);
  assert.equal(res.booking.lines.length, 1);
  // nothing else of hers: no card, credit or other bookings
  assert.deepEqual(Object.keys(res).sort(), ['booking', 'name', 'type']);
  // staff on the till get the whole person, focused on that booking, with the full name
  const token = await onTill(HEMI);
  const staff = ok(await scan(table.ref, token));
  assert.deepEqual([staff.type, staff.focus, staff.person.name, staff.person.email], ['person', table.ref, 'Mia Tamaki', 'm•••@example.com']);
  // a guest's booking (no account) is just the booking, for staff too
  const guest = ok(await call('POST', 'bookings', { kind: 'table', tables: ['T2'], start: at(DAY, 14), end: at(DAY, 16), people: 3, name: 'Sam', email: 'sam@example.com', phone: '021 555 0102', pay: 'day' }, '')).booking;
  const g = ok(await scan(guest.ref, token));
  assert.deepEqual([g.type, g.name, g.booking.lines[0].price], ['booking', 'Sam', guest.amount]);
});

test("round 32 part 2: a cancelled booking's code, or one held for paying online, has nothing to pay at the till", async () => {
  const { table, join } = await miasNight();
  lair.sql.exec("UPDATE bookings SET status = 'cancelled' WHERE id = ?", table.id);
  lair.sql.exec("UPDATE event_joins SET status = 'held' WHERE id = ?", join.id);
  for (const ref of [table.ref, join.ref]) {
    const res = ok(await scan(ref));
    assert.equal(res.type, 'booking');
    assert.deepEqual([res.booking.lines, res.booking.paid], [[], false], ref);
  }
  // staff on the till see the same booking with nothing to pay
  const token = await onTill(HEMI);
  const staff = ok(await scan(table.ref, token));
  assert.deepEqual(staff.person.bookings.find((b) => b.code === table.ref)?.lines ?? [], []);
});

test('round 32 part 2: unknown codes are a 404, and 20 in 10 minutes make that tablet wait; staff on the till never wait', async () => {
  said(await scan('ZZ-NOTHING-99'), 404, P.unknown);
  for (let i = 0; i < 18; i += 1) said(await scan(`ZZ-NOPE-${i}`), 404, P.unknown);
  said(await scan('ZZ-NOPE-LAST'), 429, P.tooMany);
  // even a real code waits on that tablet, while another tablet doesn't
  const code = lair.memberRow(MIA).code;
  said(await scan(code), 429, P.tooMany);
  ok(await scan(code, undefined, OWNER, '198.51.100.4'));
  const token = await onTill(HEMI);
  ok(await scan(code, token));
  nowIs(NOW + 11 * MIN);
  ok(await scan(code));
});

test('round 32 part 2: a pass code says what it is; nothing else comes with it', async () => {
  const pass = ok(await call('POST', 'passes', { customerId: MIA, label: '5 sessions', sessions: 5 }, OWNER)).pass;
  lair.sql.exec('UPDATE passes SET sessions_used = 2 WHERE id = ?', pass.id);
  const res = ok(await scan(pass.code));
  assert.deepEqual(res, { type: 'pass', pass: { label: '5 sessions', left: 3 } });
  // and Mia's screen lists it
  assert.deepEqual(ok(await scan(lair.memberRow(MIA).code)).person.passes, [{ label: '5 sessions', left: 3 }]);
});

test("round 32 part 2: finding people, a person by ID and tonight's list are for staff on the till with Check-in", async () => {
  await miasNight();
  // no token, or someone still on 1234, or a helper without Check-in
  said(await call('POST', 'till/find', { q: 'mia' }, OWNER), 401, W.expired);
  const fresh = ok(await call('POST', 'till/unlock', { id: HEMI, pin: '1234' }, OWNER));
  said(await call('POST', 'till/find', { token: fresh.token, q: 'mia' }, OWNER), 403, W.chooseFirst);
  const tama = await onTill(TAMA, '1357');
  for (const [path, body] of [['till/find', { q: 'mia' }], ['till/person', { id: MIA }], ['till/tonight', {}]]) {
    said(await call('POST', path, { ...body, token: tama }, OWNER), 403, P.checkinOnly);
  }
  // Hemi (Check-in) finds Mia by name, opens her by ID, and sees tonight
  const token = await onTill(HEMI);
  said(await call('POST', 'till/find', { token, q: 'm' }, OWNER), 400, P.search);
  assert.deepEqual(ok(await call('POST', 'till/find', { token, q: 'mia' }, OWNER)).people, [{ id: MIA, name: 'Mia Tamaki', code: lair.memberRow(MIA).code }]);
  const p = ok(await call('POST', 'till/person', { token, id: MIA }, OWNER)).person;
  assert.deepEqual([p.name, p.bookings.length, p.credit], ['Mia Tamaki', 2, 450]);
  said(await call('POST', 'till/person', { token, id: '424242' }, OWNER), 404, P.noMember);
  // the owner too
  const mo = await onTill(OWNER, '2046');
  ok(await call('POST', 'till/find', { token: mo, q: 'kai' }, OWNER));
});

test("round 32 part 2: tonight's list has today's people with what they owe, and the event on soonest as the night", async () => {
  const { table, join } = await miasNight();
  const token = await onTill(HEMI);
  const res = ok(await call('POST', 'till/tonight', { token }, OWNER));
  const mine = res.rows.filter((r) => r.personId === MIA);
  assert.deepEqual(mine.map((r) => r.ref).sort(), [table.ref, join.ref].sort());
  const quiz = mine.find((r) => r.ref === join.ref);
  assert.deepEqual([quiz.name, quiz.what, quiz.due, quiz.paid, quiz.at], ['Mia', 'Trivia night', 1000, false, at(DAY, 18)]);
  // before 4:30pm there's no night yet; from then (90 minutes before) it's trivia
  assert.equal(res.night, null);
  nowIs(at(DAY, 16, 45));
  const later = ok(await call('POST', 'till/tonight', { token }, OWNER));
  assert.deepEqual([later.night.title, later.night.at, later.night.rows.map((r) => r.ref)], ['Trivia night', at(DAY, 18), [join.ref]]);
});

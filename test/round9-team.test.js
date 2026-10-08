// Round 9, team (team.md): helpers and permissions on the staff page, a member's store credit and emails, and adding
// people to games and events by member code or email. Mo (9 Oct): "since adding staff requires me to pay more which I
// don't want to, can we have a special option inside the main account … to give a member the staff option and they
// will gain access to what ever I allow but mainly about checking people in and booking tables out."
// Run with: node --test test/   (under TZ=UTC and TZ=Pacific/Auckland)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair, MIGRATIONS } from '../src/lair.js';
import { HELPER_DEFAULT, LairTime, STAFF_PERMS, canDo, cleanPerms, rulesFromSettings } from '../src/core.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Friday 9 October 2026, 1:00pm in Auckland (NZDT, UTC+13): round 9
const NOW = Date.UTC(2026, 9, 9, 0, 0);
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

const FALLBACK = [
  { id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 },
  { id: 'side-room-1', name: 'Side room 1', code: 'A', tables: 4, seats: 4, order: 2 },
];
const TEST_HOURS = 'Mon closed\nTue 12:00-22:00\nWed 12:00-22:00\nThu 12:00-22:00\nFri 12:00-23:00\nSat 10:00-23:00\nSun 10:00-20:00';
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const TODAY = '2026-10-09';
const EVENTS = [
  { id: 'quiz', title: 'Trivia night', start: at(TODAY, 18), end: at(TODAY, 20), tables: '', capacity: 4, entryFee: 500 },
  { id: 'paint', title: 'Paint night', start: at('2026-10-16', 18), end: at('2026-10-16', 21), tables: '', capacity: 20 },
  { id: 'market', title: 'Oddity Alley', start: at('2026-10-17', 10), end: at('2026-10-17', 14), tables: '' },
];
const QUIZ = `quiz@${TODAY}`;
const PAINT = 'paint@2026-10-16';
const MOBILE = '021 555 0100';
// The main account (tagged staff in Shopify), a helper-to-be, a customer, and two more members (example.com people)
const OWNER = '9001';
const RUBY = '1001';
const SAM = '1002';
const KIRI = '1003';
const TAMA = '1004';

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
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const NOT_YOURS = "403 That's not one of your staff permissions. Ask the main account to tick it on the Team tab.";
const STAFF_ONLY = '403 Staff only. Log in with your staff account.';

/** Turn on emails for the Lair and catch everything sent to Resend (failing: Resend says no). Call restore() when done. */
function captureEmails({ failing = false } = {}) {
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test' };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (failing) return new Response(JSON.stringify({ message: 'The domain is not verified' }), { status: 403 });
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return { sent, restore: () => { globalThis.fetch = realFetch; } };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

/** Members the Lair knows: each opens My Lair once (their member record and code). Returns their codes. */
async function members() {
  const codes = {};
  for (const [id, name] of [[OWNER, 'Mo Example'], [RUBY, 'Ruby Tane'], [SAM, 'Sam Jones'], [KIRI, 'Kiri Smith'], [TAMA, 'Tama Rewiti']]) {
    codes[id] = (await call('GET', `me?name=${encodeURIComponent(name)}`, null, id)).data.member.code;
    lair.sql.exec('UPDATE members SET email = ? WHERE customer_id = ?', `${name.split(' ')[0].toLowerCase()}@example.com`, id);
  }
  return codes;
}
/** Make Ruby a helper (the owner does it), with these perms (left out: the defaults) */
const makeHelper = (perms, who = RUBY) => call('POST', 'team', { customerId: who, ...(perms ? { perms } : {}) }, OWNER);

/** A fake Shopify store credit account per customer, in cents */
function fakeCredit(start = {}) {
  const balances = new Map(Object.entries(start));
  const calls = [];
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  lair.shopify.storeCreditBalance = async (id) => balances.get(id) || 0;
  lair.shopify.changeStoreCredit = async (id, cents) => {
    calls.push([id, cents]);
    const now = balances.get(id) || 0;
    if (now + cents < 0) throw Object.assign(new Error('Insufficient funds'), { code: 'INSUFFICIENT_FUNDS' });
    balances.set(id, now + cents);
    return { id: `gid://shopify/StoreCreditAccountTransaction/${calls.length}`, balanceAfter: now + cents };
  };
  lair.shopify.searchCustomers = async () => [];
  return { balances, calls };
}

beforeEach(() => {
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'ep0qiq-rp.myshopify.com' });
  // Tags come from Shopify: only the owner is tagged staff. person() then adds helpers from the Lair itself.
  lair.taggedPerson = async (id) => ({ customerId: id || null, staff: id === OWNER, gm: false, tags: [] });
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
});
afterEach(() => {
  Date.now = realNow;
});

/* ---------------- the pieces ---------------- */

test('team (round 9): one migration entry, found by what it makes: four new tables and the sign-up column', () => {
  const mine = MIGRATIONS.filter((m) => m.some((s) => /staff_helpers/.test(s)));
  assert.equal(mine.length, 1);
  for (const table of ['staff_helpers', 'staff_log', 'member_credit', 'member_emails']) {
    assert.ok(lair.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray().length, table);
  }
  const cols = lair.sql.exec("SELECT name FROM pragma_table_info('event_joins')").toArray().map((c) => c.name);
  assert.ok(cols.includes('added_by'));
});

test('team (round 9): the permission keys, the defaults, and who may do what', () => {
  assert.deepEqual(STAFF_PERMS, ['checkin', 'tables', 'sessions', 'events', 'members', 'money', 'library', 'community']);
  assert.deepEqual(HELPER_DEFAULT, ['checkin', 'tables']);
  assert.deepEqual(cleanPerms(['Money', 'team', 'checkin', 'nope', 'checkin']), ['checkin', 'money'], 'known keys once, in order; team never');
  assert.equal(cleanPerms('checkin'), null);
  const owner = { staff: true, role: 'owner', perms: [] };
  const helper = { staff: true, role: 'helper', perms: ['checkin', 'tables'] };
  const customer = { staff: false, role: null, perms: [] };
  assert.equal(canDo(owner, 'team'), true);
  assert.equal(canDo(owner, undefined), true);
  assert.equal(canDo(helper, 'checkin'), true);
  assert.equal(canDo(helper, ['money', 'tables']), true, 'any one of a list');
  assert.equal(canDo(helper, 'money'), false);
  assert.equal(canDo(helper, 'team'), false, 'team is the owner’s alone');
  assert.equal(canDo(helper, undefined), false, 'a missing permission is the owner’s alone');
  assert.equal(canDo(helper, 'shiny-new-thing'), false, 'an unknown one too');
  assert.equal(canDo({ ...helper, perms: ['team'] }, 'team'), false, 'even if a helper somehow had it');
  assert.equal(canDo(customer, 'checkin'), false);
  assert.equal(canDo({ staff: true }, 'money'), true, 'a who made in code with staff: true and no role is the owner, as before round 9');
  assert.equal(canDo({ staff: true, role: null }, 'checkin'), false);
});

/* ---------------- the team ---------------- */

test('team (round 9): GET /staff/me says who’s using the staff page: the owner, a helper with what they can do, or nobody', async () => {
  await members();
  assert.equal(said(await call('GET', 'staff/me', null, '')), '401 Log in to use the staff page.');
  assert.deepEqual((await call('GET', 'staff/me', null, SAM)).data, { staff: false });
  assert.deepEqual((await call('GET', 'staff/me', null, OWNER)).data, { staff: true, role: 'owner', perms: [...STAFF_PERMS, 'team'], name: 'Mo' });
  assert.equal((await makeHelper()).status, 200);
  assert.deepEqual((await call('GET', 'staff/me', null, RUBY)).data, { staff: true, role: 'helper', perms: ['checkin', 'tables'], name: 'Ruby' });
});

test('team (round 9): the owner makes a helper by member code or from the search; Check-in and Tables by default; the log says who did what', async () => {
  const codes = await members();
  fakeCredit();
  // by member code, however it's typed, with the defaults
  const made = await call('POST', 'team', { code: codes[RUBY].toLowerCase().replace(/-/g, ' ') }, OWNER);
  assert.equal(made.status, 200, said(made));
  assert.deepEqual(made.data.helper.perms, ['checkin', 'tables']);
  assert.equal(made.data.helper.name, 'Ruby Tane');
  assert.equal(made.data.helper.code, codes[RUBY]);
  assert.deepEqual(made.data.helper.madeBy, { customerId: OWNER, name: 'Mo Example' });
  assert.equal(made.data.helper.since, NOW);
  // from the search, someone the Lair hasn't met yet (they become a member), with what was ticked
  const fresh = await call('POST', 'team', { customerId: '7777', name: 'Jo Bloggs', email: 'jo@example.com', perms: ['library', 'team', 'members'] }, OWNER);
  assert.equal(fresh.status, 200, said(fresh));
  assert.deepEqual(fresh.data.helper.perms, ['members', 'library'], 'team is never given');
  assert.ok(fresh.data.helper.code, 'they got a member code');
  // the words for a bad pick
  assert.equal(said(await call('POST', 'team', { code: 'ZZ-NOBODY-99' }, OWNER)), '404 No member has that code. Check it, or find them in the search.');
  assert.equal(said(await call('POST', 'team', {}, OWNER)), '422 Pick a member from the search, or type their member code.');
  assert.equal(said(await call('POST', 'team', { customerId: SAM, perms: [] }, OWNER)), '422 Tick at least one thing they can do.');
  assert.equal(said(await call('POST', 'team', { customerId: OWNER }, OWNER)), "409 That's the main account. It can do everything already.");
  // the team, the owner first
  const team = (await call('GET', 'team', null, OWNER)).data;
  assert.deepEqual(team.owners.map((o) => o.customerId), [OWNER]);
  assert.deepEqual(team.helpers.map((h) => h.customerId), ['7777', RUBY], 'newest first');
  assert.deepEqual(team.perms.map((p) => p.key), STAFF_PERMS);
  assert.ok(team.perms.every((p) => p.words.length > 10));
  assert.deepEqual(team.defaults, ['checkin', 'tables']);
  assert.deepEqual(team.log.map((l) => [l.action, l.customerId, l.perms]), [['added', '7777', ['members', 'library']], ['added', RUBY, ['checkin', 'tables']]]);
  assert.deepEqual(team.log[0].by, { customerId: OWNER, name: 'Mo Example' });
});

test('team (round 9): a helper can’t reach the Team tab, change their own permissions or remove anyone; the owner can’t be removed', async () => {
  await members();
  await makeHelper();
  for (const [method, path, body] of [['GET', 'team'], ['POST', 'team', { customerId: SAM }], ['POST', `team/${RUBY}`, { perms: STAFF_PERMS }], ['POST', `team/${RUBY}/remove`, {}], ['POST', `team/${OWNER}/remove`, {}]]) {
    assert.equal(said(await call(method, path, body, RUBY)), NOT_YOURS, `${method} ${path}`);
    assert.equal(said(await call(method, path, body, SAM)), STAFF_ONLY, `${method} ${path} as a customer`);
  }
  assert.equal(said(await call('POST', `team/${OWNER}/remove`, {}, OWNER)), "409 That's you, the main account. It can't be removed here.");
  lair.taggedPerson = async (id) => ({ customerId: id || null, staff: id === OWNER || id === '9002', gm: false, tags: [] });
  assert.equal(said(await call('POST', 'team/9002/remove', {}, OWNER)), "409 That's the main account. It can't be removed here.");
  assert.equal(said(await call('POST', `team/${SAM}/remove`, {}, OWNER)), "404 They're not a helper.");
  assert.equal(said(await call('POST', `team/${OWNER}`, { perms: ['money'] }, OWNER)), "403 You can't change your own permissions. Ask the main account.");
  assert.equal(said(await call('POST', `team/${SAM}`, { perms: ['money'] }, OWNER)), "404 They're not a helper.");
});

test('team (round 9): a change counts straight away: ticked, unticked and removed', async () => {
  await members();
  await makeHelper();
  assert.equal(said(await call('GET', 'members', null, RUBY)), NOT_YOURS);
  const changed = await call('POST', `team/${RUBY}`, { perms: ['members'] }, OWNER);
  assert.deepEqual(changed.data.helper.perms, ['members']);
  assert.equal((await call('GET', 'members', null, RUBY)).status, 200, 'Members ticked: in');
  assert.equal(said(await call('POST', 'checkin', { code: 'XX' }, RUBY)), NOT_YOURS, 'Check-in unticked: out');
  assert.equal(said(await call('POST', `team/${RUBY}`, { perms: [] }, OWNER)), '422 Tick at least one thing they can do.');
  const gone = await call('POST', `team/${RUBY}/remove`, {}, OWNER);
  assert.deepEqual(gone.data, { ok: true, customerId: RUBY });
  assert.equal(said(await call('GET', 'members', null, RUBY)), STAFF_ONLY, 'removed: a customer again');
  assert.deepEqual((await call('GET', 'staff/me', null, RUBY)).data, { staff: false });
  // made a helper again: since starts again, and the log has it all
  const again = await makeHelper(['library']);
  assert.equal(again.data.helper.since, NOW);
  const log = (await call('GET', 'team', null, OWNER)).data.log.map((l) => l.action);
  assert.deepEqual(log, ['added', 'removed', 'changed', 'added']);
});

/* ---------------- every permission, owner vs helper vs customer ---------------- */

test('team (round 9): every staff area on a sample route: the owner gets in, a helper only with the box ticked, a customer never', async () => {
  const codes = await members();
  fakeCredit({ [SAM]: 2500 });
  const later = at('2026-10-10', 15);
  // a sample route for each permission, and what it answers when it's let in (any status but the permission 403s)
  const SAMPLES = {
    checkin: ['POST', 'checkin', { code: codes[SAM] }],
    tables: ['POST', 'blocks', { tables: ['T1'], start: later, end: later + HOUR, label: 'Held' }],
    sessions: ['POST', 'games/nope/edit', {}],
    events: ['POST', `events/${PAINT}/joins`, { code: codes[KIRI] }],
    members: ['GET', `members/${SAM}`],
    money: ['GET', 'roll-codes'],
    library: ['GET', 'library/holds'],
  };
  const out = async (method, path, body, who) => said(await call(method, path, body, who));
  for (const [perm, [method, path, body]] of Object.entries(SAMPLES)) {
    assert.notEqual(await out(method, path, body, OWNER), NOT_YOURS, `the owner: ${perm}`);
    assert.equal(await out(method, path, body, SAM), STAFF_ONLY, `a customer: ${perm}`);
  }
  // Ruby with each one ticked on its own: that area and no other
  for (const perm of Object.keys(SAMPLES)) {
    await call('POST', 'team', { customerId: RUBY, perms: [perm] }, OWNER);
    for (const [other, [method, path, body]] of Object.entries(SAMPLES)) {
      const answer = await out(method, path, body, RUBY);
      if (other === perm) assert.notEqual(answer, NOT_YOURS, `${perm} ticked: ${other} works`);
      else assert.equal(answer, NOT_YOURS, `${perm} ticked: ${other} is out`);
    }
  }
  // routes a list of permissions opens: the desk reads a member's passes, and the picker is everyone's
  await call('POST', 'team', { customerId: RUBY, perms: ['checkin'] }, OWNER);
  assert.equal((await call('GET', 'passes', null, RUBY)).status, 200, 'the desk reads passes');
  assert.equal(await out('POST', 'passes', { label: 'x', sessions: 5 }, RUBY), NOT_YOURS, 'but issuing one is money');
  assert.notEqual(await out('GET', 'customers?q=sam', null, RUBY), NOT_YOURS, 'the customer picker');
  assert.equal(await out('POST', 'games/x/credit', {}, RUBY), NOT_YOURS, 'a GM’s store credit is money');
  assert.equal(await out('GET', 'events', null, RUBY), NOT_YOURS, 'the events editor');
  assert.equal(await out('POST', `members/${SAM}/credit`, { amount: 100 }, RUBY), NOT_YOURS, 'store credit');
  assert.equal(await out('POST', `members/${SAM}/email`, { subject: 'Hi', message: 'Hello' }, RUBY), NOT_YOURS, 'emailing a member');
});

test('team (round 9): the floor: the desk, the floor, GM games and events see it as staff; a library helper sees what customers see', async () => {
  await members();
  const book = await call('POST', 'bookings', { tables: ['T5'], start: at(TODAY, 17), end: at(TODAY, 19), people: 2, name: 'Sam Jones', email: 'sam@example.com', phone: MOBILE }, SAM);
  assert.equal(book.status, 200, said(book));
  await makeHelper(['library']);
  const lib = (await call('GET', 'floor', null, RUBY)).data;
  assert.equal(lib.staff, false);
  assert.equal(lib.bookings[0].name, undefined, 'no names');
  assert.equal(lib.joins, undefined);
  await call('POST', `team/${RUBY}`, { perms: ['checkin'] }, OWNER);
  const desk = (await call('GET', 'floor', null, RUBY)).data;
  assert.equal(desk.staff, true);
  assert.equal(desk.bookings[0].name, 'Sam Jones');
  assert.ok(Array.isArray(desk.joins));
});

test('team (round 9): bookings at the desk: Check-in marks paid and no-shows; refunds and waiving are money; a helper can still cancel their own booking', async () => {
  await members();
  const theirs = (await call('POST', 'bookings', { tables: ['T5'], start: at(TODAY, 17), end: at(TODAY, 19), people: 2, name: 'Sam Jones', email: 'sam@example.com', phone: MOBILE }, SAM)).data.booking;
  const own = (await call('POST', 'bookings', { tables: ['T6'], start: at('2026-10-10', 17), end: at('2026-10-10', 19), people: 2, name: 'Ruby Tane', email: 'ruby@example.com', phone: MOBILE }, RUBY)).data.booking;
  await makeHelper(['checkin']);
  const paid = await call('POST', `bookings/${theirs.id}/update`, { paid: true }, RUBY);
  assert.equal(paid.status, 200, said(paid));
  assert.equal(paid.data.booking.paid, true);
  assert.equal(said(await call('POST', `bookings/${theirs.id}/update`, { refunded: true }, RUBY)), NOT_YOURS);
  assert.equal(said(await call('POST', `bookings/${theirs.id}/update`, { waived: true }, RUBY)), NOT_YOURS);
  assert.equal(said(await call('POST', `bookings/${theirs.id}/update`, { tables: ['T7'] }, RUBY)), NOT_YOURS, 'a move is Tables');
  assert.equal((await call('POST', `bookings/${theirs.id}/update`, { status: 'noshow' }, RUBY)).data.booking.status, 'noshow');
  // with only Library ticked, Ruby is a member here: her own booking she can cancel, anyone else's she can't touch
  await call('POST', `team/${RUBY}`, { perms: ['library'] }, OWNER);
  assert.equal(said(await call('POST', `bookings/${theirs.id}/update`, { status: 'confirmed' }, RUBY)), NOT_YOURS);
  const cancelled = await call('POST', `bookings/${own.id}/update`, { status: 'cancelled' }, RUBY);
  assert.equal(cancelled.status, 200, said(cancelled));
  assert.equal(cancelled.data.booking.status, 'cancelled');
  // walk-ins and staff bookings are Tables
  assert.equal(said(await call('POST', 'bookings', { kind: 'walkin', tables: ['T9'], people: 2, name: 'Walk-in' }, RUBY)), NOT_YOURS);
  assert.equal(said(await call('POST', 'bookings', { tables: ['T9'], start: at('2026-10-10', 17), end: at('2026-10-10', 19), people: 2, name: 'For someone', email: 'x@example.com', staffOverride: true }, RUBY)), NOT_YOURS);
});

/* ---------------- store credit ---------------- */

test('team (round 9): store credit: add, take off, never below zero, a note to take off, a repeat never moves money twice, and the history', async () => {
  await members();
  const shop = fakeCredit({ [SAM]: 2500 });
  const read = await call('GET', `members/${SAM}/credit`, null, OWNER);
  assert.deepEqual(read.data, { balance: 2500, currency: 'NZD', problem: null, history: [] });
  const added = await call('POST', `members/${SAM}/credit`, { amount: 1000, note: 'Paid up front', key: 'k1' }, OWNER);
  assert.equal(added.status, 200, said(added));
  assert.equal(added.data.balance, 3500);
  assert.equal(added.data.change.status, 'done');
  assert.deepEqual(added.data.change.by, { customerId: OWNER, name: 'Mo' });
  // the same request again (a double tap, a retry): the first answer, and Shopify isn't asked again
  const again = await call('POST', `members/${SAM}/credit`, { amount: 1000, note: 'Paid up front', key: 'k1' }, OWNER);
  assert.equal(again.data.repeated, true);
  assert.equal(shop.calls.length, 1);
  assert.equal(shop.balances.get(SAM), 3500);
  assert.equal(said(await call('POST', `members/${SAM}/credit`, { amount: -1000 }, OWNER)), '422 Add a note to say why the credit is coming off.');
  assert.equal(said(await call('POST', `members/${SAM}/credit`, { amount: -4000, note: 'Oops' }, OWNER)), '409 Sam has $35 of store credit, so you can take off $35 at most.');
  assert.equal(said(await call('POST', `members/${KIRI}/credit`, { amount: -100, note: 'Oops' }, OWNER)), '409 Kiri has no store credit to take off.');
  assert.equal(said(await call('POST', `members/${SAM}/credit`, { amount: 0 }, OWNER)), '422 Say how much to add or take off.');
  assert.equal(said(await call('POST', `members/${SAM}/credit`, { amount: 100001, note: 'x' }, OWNER)), '422 Store credit changes go up to $1000 at a time. Check the amount.');
  assert.equal(said(await call('POST', `members/${SAM}/credit`, { amount: 12.5 }, OWNER)), '422 Say how much to add or take off.');
  const off = await call('POST', `members/${SAM}/credit`, { amount: -1000, note: 'Took a $10 game home', key: 'k2' }, OWNER);
  assert.equal(off.data.balance, 2500);
  // Shopify still refuses when its balance is lower than the Lair could see: logged as failed, said plainly
  lair.shopify.storeCreditBalance = async () => { throw new Error('Shopify API: Access denied for storeCreditAccounts field.'); };
  const refused = await call('POST', `members/${SAM}/credit`, { amount: -5000, note: 'Too much', key: 'k3' }, OWNER);
  assert.equal(said(refused), "409 Sam doesn't have that much store credit, so nothing came off. Check their balance and take off less.");
  const history = (await call('GET', `members/${SAM}/credit`, null, OWNER)).data;
  assert.equal(history.balance, null);
  assert.equal(history.problem, "Shopify hasn't let the Lair read store credit balances yet. Approve the app's new permission in Shopify admin (Apps › Dice Goblin Lair).");
  assert.deepEqual(history.history.map((h) => [h.amount, h.status, h.note]), [[-5000, 'failed', 'Too much'], [-1000, 'done', 'Took a $10 game home'], [1000, 'done', 'Paid up front']]);
  assert.deepEqual(history.history.map((h) => h.balanceAfter), [null, 2500, 3500]);
  // Shopify not connected: nothing moves
  Object.defineProperty(lair.shopify, 'configured', { value: false, configurable: true });
  assert.equal(said(await call('POST', `members/${SAM}/credit`, { amount: 500 }, OWNER)), "503 Shopify isn't connected, so store credit can't change right now.");
  assert.equal(said(await call('GET', 'members/4040/credit', null, OWNER)), '404 No member with that customer ID.');
});

/* ---------------- emails ---------------- */

test('team (round 9): an email to a member: the shop’s look, the message as written, signed by the sender, logged, 30 a day each', async () => {
  await members();
  await makeHelper(['members']);
  const mail = captureEmails();
  try {
    const before = (await call('GET', `members/${SAM}/emails`, null, RUBY)).data;
    assert.deepEqual(before, { to: 'sam@example.com', emails: [], left: 30, limit: 30 });
    const message = 'Kia ora Sam,\n\nYour pre-order came in today.\nIt’s behind the counter.\n\n<b>See you soon</b>';
    const sent = await call('POST', `members/${SAM}/email`, { subject: 'Your pre-order is in', message }, RUBY);
    assert.equal(sent.status, 200, said(sent));
    assert.equal(sent.data.left, 29);
    assert.equal(sent.data.email.status, 'sent');
    assert.equal(mail.sent.length, 1);
    const [m] = mail.sent;
    assert.equal(m.to, 'sam@example.com');
    assert.equal(m.subject, 'Your pre-order is in');
    assert.equal(m.reply_to, 'staff@dicegoblin.test', 'replies go to the shop');
    assert.match(m.text, /Kia ora Sam,\n\nYour pre-order came in today\.\nIt’s behind the counter\./);
    assert.match(m.text, /Ruby, Dice Goblin/);
    assert.match(m.html, /&lt;b&gt;See you soon&lt;\/b&gt;/, 'no HTML from staff');
    assert.doesNotMatch(m.text, /Gobgob/, 'signed by the person, not Gobgob');
    // signed as someone else on the page (a shared account, say)
    await call('POST', `members/${SAM}/email`, { subject: 'Another', message: 'Hi', signedAs: 'Mo' }, RUBY);
    assert.match(mail.sent[1].text, /Mo, Dice Goblin/);
    // the log on their page
    const log = (await call('GET', `members/${SAM}/emails`, null, OWNER)).data;
    assert.deepEqual(log.emails.map((e) => [e.subject, e.status, e.by.name]), [['Another', 'sent', 'Ruby'], ['Your pre-order is in', 'sent', 'Ruby']]);
    assert.equal(log.left, 30, 'the owner has their own 30');
    // the words for a bad email
    assert.equal(said(await call('POST', `members/${SAM}/email`, { subject: '', message: 'Hi' }, RUBY)), '422 Add a subject, up to 120 characters.');
    assert.equal(said(await call('POST', `members/${SAM}/email`, { subject: 'x'.repeat(121), message: 'Hi' }, RUBY)), '422 Add a subject, up to 120 characters.');
    assert.equal(said(await call('POST', `members/${SAM}/email`, { subject: 'Hi', message: 'x'.repeat(4001) }, RUBY)), '422 Write the message, up to 4,000 characters.');
    lair.sql.exec('UPDATE members SET email = NULL WHERE customer_id = ?', KIRI);
    assert.equal(said(await call('POST', `members/${KIRI}/email`, { subject: 'Hi', message: 'Hi' }, RUBY)), "422 Kiri has no email on file, so there's nothing to send to.");
    assert.equal((await call('GET', `members/${KIRI}/emails`, null, RUBY)).data.to, '');
    // 30 a day each
    for (let i = 0; i < 28; i += 1) assert.equal((await call('POST', `members/${SAM}/email`, { subject: `No. ${i}`, message: 'Hi' }, RUBY)).status, 200);
    assert.equal(said(await call('POST', `members/${SAM}/email`, { subject: 'One more', message: 'Hi' }, RUBY)), "429 That's 30 emails from you today. Try again tomorrow.");
    assert.equal((await call('POST', `members/${SAM}/email`, { subject: 'From Mo', message: 'Hi' }, OWNER)).status, 200);
    Date.now = () => NOW + DAY + 1;
    assert.equal((await call('POST', `members/${SAM}/email`, { subject: 'Next day', message: 'Hi' }, RUBY)).status, 200);
  } finally {
    mail.restore();
  }
  // Resend says no: logged as failed, said plainly, and it doesn't count
  const failing = captureEmails({ failing: true });
  try {
    const res = await call('POST', `members/${TAMA}/email`, { subject: 'Hello', message: 'Hi' }, OWNER);
    assert.equal(said(res), '502 It didn\'t send (The domain is not verified). Try again in a minute.');
    const log = (await call('GET', `members/${TAMA}/emails`, null, OWNER)).data.emails;
    assert.deepEqual(log.map((e) => e.status), ['failed']);
  } finally {
    failing.restore();
  }
});

/* ---------------- adding people to events and games ---------------- */

test('team (round 9): staff add event sign-ups by member code (at once) or by name and email (invited); places and repeats checked', async () => {
  const codes = await members();
  const mail = captureEmails();
  try {
    const byCode = await call('POST', `events/${QUIZ}/joins`, { code: codes[SAM].toLowerCase(), people: 2, note: 'Bringing a friend' }, OWNER);
    assert.equal(byCode.status, 200, said(byCode));
    assert.equal(byCode.data.join.name, 'Sam Jones');
    assert.equal(byCode.data.join.customerId, SAM);
    assert.equal(byCode.data.join.amount, 1000, 'the entry fee, paid at the counter');
    assert.equal(byCode.data.join.payment, 'store');
    assert.equal(byCode.data.spacesLeft, 2);
    assert.equal(byCode.data.invited, false);
    await settle();
    assert.equal(mail.sent[0].subject.startsWith("You're in: Trivia night"), true, 'the usual email');
    assert.doesNotMatch(mail.sent[0].text, /Make your Dice Goblin account/);
    const added = lair.sql.exec('SELECT added_by FROM event_joins WHERE id = ?', byCode.data.join.id).one();
    assert.equal(added.added_by, `staff:${OWNER}`);
    // a repeat, too many, a code nobody has, no email for someone new
    assert.equal(said(await call('POST', `events/${QUIZ}/joins`, { code: codes[SAM] }, OWNER)), `409 Sam Jones is already on the list for this one (${byCode.data.join.ref}).`);
    assert.equal(said(await call('POST', `events/${QUIZ}/joins`, { code: codes[KIRI], people: 3 }, OWNER)), '409 Only 2 spaces left.');
    assert.equal(said(await call('POST', `events/${QUIZ}/joins`, { code: 'ZZ-NOBODY-99' }, OWNER)), '404 No member has that code. Check it, or find them in the search.');
    assert.equal(said(await call('POST', `events/${QUIZ}/joins`, { name: 'Jo Bloggs' }, OWNER)), '422 Add their email, so they get the confirmation and an invite to make an account.');
    assert.equal(said(await call('POST', `events/${QUIZ}/joins`, { email: 'jo@example.com' }, OWNER)), '422 Add their name.');
    assert.equal(said(await call('POST', `events/market@2026-10-17/joins`, { code: codes[KIRI] }, OWNER)), "422 This one doesn't take sign-ups: people just turn up.");
    assert.equal(said(await call('POST', 'events/nope@2026-10-17/joins', { code: codes[KIRI] }, OWNER)), '404 That event date could not be found.');
    // by name and email: invited, with the account line
    const invite = await call('POST', `events/${QUIZ}/joins`, { name: 'Jo Bloggs', email: 'Jo@Example.com' }, OWNER);
    assert.equal(invite.status, 200, said(invite));
    assert.equal(invite.data.invited, true);
    assert.equal(invite.data.join.customerId, null);
    await settle();
    const letter = mail.sent.find((x) => x.to === 'Jo@Example.com');
    assert.match(letter.text, /Make your Dice Goblin account with this email \(Jo@Example\.com\)/);
    // an email a member has links them
    const known = await call('POST', `events/${PAINT}/joins`, { name: 'Kiri', email: 'kiri@example.com' }, OWNER);
    assert.equal(known.data.join.customerId, KIRI);
    assert.equal(known.data.invited, false);
    // it's on the floor's sign-ups for staff (Today's list and the Events tab read these)
    const floor = (await call('GET', 'floor', null, OWNER)).data;
    assert.ok(floor.joins.some((j) => j.id === byCode.data.join.id && j.note === 'Bringing a friend'));
    // a customer can't
    assert.equal(said(await call('POST', `events/${PAINT}/joins`, { code: codes[TAMA] }, SAM)), STAFF_ONLY);
  } finally {
    mail.restore();
  }
});

test('team (round 9): a TTRPG player added by member code is found at once', async () => {
  const codes = await members();
  const game = await call('POST', 'games', {
    title: 'Curse of Strahd', system: 'D&D 5e', gm: 'Mo', tables: ['T3'], start: at('2026-10-13', 18), end: at('2026-10-13', 21), seats: 3, schedule: 'one-shot', gmFee: 500, blurb: 'Gothic horror in Barovia.',
  }, OWNER);
  assert.equal(game.status, 200, said(game));
  const added = await call('POST', `games/${game.data.game.id}/players`, { code: codes[TAMA] }, OWNER);
  assert.equal(added.status, 200, said(added));
  assert.equal(added.data.booking.customerId, TAMA);
  assert.equal(added.data.booking.name, 'Tama Rewiti');
  assert.equal(said(await call('POST', `games/${game.data.game.id}/players`, { code: 'ZZ-NOBODY-99' }, OWNER)), '404 No member has that code. Check it, or find them in the search.');
});

test('team (round 9): added three times under one email (an event, a game seat, a weekly seat), signs up once: all three join their account', async () => {
  await members();
  const email = 'newbie@example.com';
  // 1. an event sign-up by email
  const joined = await call('POST', `events/${PAINT}/joins`, { name: 'Ari Newbie', email }, OWNER);
  assert.equal(joined.status, 200, said(joined));
  // 2. a seat at a one-off game, and 3. a weekly game's seat with an invite to be a regular
  const oneOff = (await call('POST', 'games', { title: 'One-shot', system: 'Mothership', gm: 'Mo', tables: ['T3'], start: at('2026-10-13', 18), end: at('2026-10-13', 21), seats: 3, schedule: 'one-shot', gmFee: 500, blurb: 'Space horror.' }, OWNER)).data.game;
  const weekly = (await call('POST', 'games', { title: 'Weekly', system: 'Pathfinder', gm: 'Mo', tables: ['T4'], start: at('2026-10-14', 18), end: at('2026-10-14', 21), seats: 3, schedule: 'weekly', gmFee: 500, blurb: 'A weekly campaign.' }, OWNER)).data.game;
  const seat = await call('POST', `games/${oneOff.id}/players`, { name: 'Ari Newbie', email }, OWNER);
  assert.equal(seat.status, 200, said(seat));
  const regular = await call('POST', `games/${weekly.id}/players`, { name: 'Ari Newbie', email, weekly: true }, OWNER);
  assert.equal(regular.status, 200, said(regular));
  assert.ok(regular.data.invite);
  // Ari makes an account with that email (Shopify says it's verified) and opens My Lair once
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  lair.shopify.customerEmail = async () => ({ email: 'NEWBIE@example.com', verified: true });
  lair.shopify.checkGiftCodes = async () => 0;
  lair.shopify.giftCodeUse = async () => null;
  const ARI = '5005';
  const mine = (await call('GET', 'me?name=Ari%20Newbie', null, ARI)).data;
  assert.deepEqual(mine.joins.map((j) => j.title), ['Paint night'], 'the event sign-up');
  assert.deepEqual(mine.seats.map((s) => s.gameTitle).sort(), ['One-shot', 'Weekly'], 'both game seats');
  assert.deepEqual(mine.series.map((s) => s.title), ['Weekly'], 'and a regular from now on');
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM event_joins WHERE customer_id IS NULL AND lower(email) = 'newbie@example.com'").one().n, 0);
});

// Round 32, the till, part 1: who's on the till (contract v32-till). Mo (6 Nov 2026): everyone starts on 1234 and chooses
// their own PIN the first time they unlock, Caleb and Felix too; the owner resets PINs, switches till access off and on,
// and adds the till's own people. The PINs here are made up (never anyone's real one). Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { TILL_WORDS as W, TILL_SESSION_MS, tillLockMs } from '../src/till.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
// Friday 6 November 2026, 1:00pm in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 10, 6, 0, 0);
const realNow = Date.now;
const nowIs = (ms) => {
  Date.now = () => ms;
};

/* ---------------- helpers, as in test/round22-stamps.test.js ---------------- */
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
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: () => {}, kv };
}

// People by their Shopify customer IDs (made up): Mo, the owner (tagged staff); helpers Hemi (Check-in) and Tama (Library
// only); Mia, a player. Caleb and Felix are added on the till on its first start.
const OWNER = '9001';
const HEMI = '9102';
const TAMA = '9103';
const MIA = '6001';

let ctx;
let lair;
let shopifyOn;
let searches;
let searchFails;
function boot(context) {
  lair = new Lair(context, { CURRENCY: 'NZD' });
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.searchCustomers = async (query) => {
    searches.push(query);
    if (searchFails) throw new Error('Shopify is down');
    return [{ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }];
  };
  Object.defineProperty(lair.shopify, 'configured', { get: () => shopifyOn, configurable: true });
  lair.notifyStaff = () => {};
  return lair;
}
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
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const said = (res, status, words) => {
  assert.equal(res.status, status, res.data.error);
  if (words) assert.equal(res.data.error, words);
};
// the till runs on a tablet logged in as the owner's account, unless a test says otherwise
const team = async (as = OWNER) => ok(await call('GET', 'till/team', undefined, as)).team;
const idOf = async (name) => (await team()).find((p) => p.name === name)?.id;
const unlock = (id, pin, as = OWNER) => call('POST', 'till/unlock', { id, pin }, as);
const choose = (token, pin, as = OWNER) => call('POST', 'till/pin', { token, pin }, as);
const tillPost = (path, body, as = OWNER) => call('POST', `till/${path}`, body, as);
const allTillText = () => ['till_people', 'till_pins', 'till_sessions'].flatMap((t) => lair.sql.exec(`SELECT * FROM ${t}`).toArray()).map((r) => JSON.stringify(r)).join('\n');

beforeEach(async () => {
  shopifyOn = true;
  searches = [];
  searchFails = false;
  globalThis.fetch = async (url) => {
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  ctx = fakeCtx();
  boot(ctx);
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  for (const [id, name, perms] of [[HEMI, 'Hemi Walker', ['checkin']], [TAMA, 'Tama Rewi', ['library']]]) {
    ok(await call('POST', 'team', { customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, perms }, OWNER));
  }
  lair.makeMember({ customerId: MIA, name: 'Mia Chen', email: 'mia@example.com' }, NOW);
});

afterEach(() => {
  Date.now = realNow;
});

test('round 32: the till is for staff: nobody logged in and players get a 403, for every till route', async () => {
  for (const as of ['', MIA]) {
    said(await call('GET', 'till/team', undefined, as), 403, W.staffOnly);
    for (const path of ['unlock', 'pin', 'reset', 'access', 'people', 'people/remove']) said(await tillPost(path, {}, as), 403, W.staffOnly);
  }
});

test('round 32: the lock screen has the owner, the helpers, then Caleb and Felix, everyone on the starting PIN', async () => {
  const res = ok(await call('GET', 'till/team', undefined, OWNER));
  assert.equal(res.startPin, '1234');
  assert.equal(res.account, OWNER);
  assert.deepEqual(
    res.team.map((p) => [p.name, p.role, p.kind, p.roleWords, p.pin, p.off, p.locked]),
    [
      ['Mo', 'owner', 'team', 'Owner', 'start', false, false],
      ['Hemi', 'helper', 'team', 'Check-in', 'start', false, false],
      ['Tama', 'helper', 'team', 'Sales only', 'start', false, false],
      ['Caleb', 'helper', 'till', 'Check-in', 'start', false, false],
      ['Felix', 'helper', 'till', 'Check-in', 'start', false, false],
    ],
  );
  assert.equal(res.team[0].id, OWNER);
  assert.match(res.team[3].id, /^tp_[0-9a-f]{16}$/);
  // a helper's tablet lists the owner too, from Shopify's staff tag; Shopify is asked at most every 10 minutes
  assert.deepEqual((await team(HEMI)).map((p) => p.name), ['Mo', 'Hemi', 'Tama', 'Caleb', 'Felix']);
  await team(HEMI);
  assert.equal(searches.length, 1);
  nowIs(NOW + 11 * MIN);
  await team(HEMI);
  assert.equal(searches.length, 2);
});

test('round 32: Caleb and Felix are added once, and not when they are helpers already', async () => {
  // a restart (a new Lair on the same storage) doesn't add them again
  boot(ctx);
  assert.deepEqual((await team()).map((p) => p.name), ['Mo', 'Hemi', 'Tama', 'Caleb', 'Felix']);
  // on a Lair where Felix was a helper before the till came, only Caleb is added
  lair.sql.exec("DELETE FROM meta WHERE key = 'till-seeded'");
  lair.sql.exec('DELETE FROM till_people');
  lair.makeMember({ customerId: '9104', name: 'Felix Grange', email: 'felix@example.com' }, NOW);
  ok(await call('POST', 'team', { customerId: '9104', perms: ['checkin', 'money'] }, OWNER));
  lair.tillSeed(NOW);
  assert.deepEqual(
    (await team()).map((p) => [p.name, p.kind, p.roleWords]),
    [['Mo', 'team', 'Owner'], ['Hemi', 'team', 'Check-in'], ['Tama', 'team', 'Sales only'], ['Felix', 'team', 'Check-in and money'], ['Caleb', 'till', 'Check-in']],
  );
});

test('round 32: the first unlock is on 1234 and asks for their own PIN; after that only their own works', async () => {
  const first = ok(await unlock(OWNER, '1234'));
  assert.match(first.token, /^[0-9a-f]{48}$/);
  assert.equal(first.mustChange, true);
  assert.equal(first.staff.name, 'Mo');
  assert.equal(first.staff.pin, 'start');
  // 4 numbers, and not the starting PIN
  said(await choose(first.token, '1234'), 400, W.notStart);
  for (const pin of ['123', '12345', 'abcd', '19 9', '', null]) said(await choose(first.token, pin), 400, W.fourNumbers);
  const chosen = ok(await choose(first.token, '2046'));
  assert.equal(chosen.staff.pin, 'own');
  said(await unlock(OWNER, '1234'), 401, W.wrong);
  const again = ok(await unlock(OWNER, '2046'));
  assert.equal(again.mustChange, false);
  assert.notEqual(again.token, first.token);
  assert.equal((await team()).find((p) => p.id === OWNER).pin, 'own');
  // Caleb's first time, the same way, on the same tablet
  const caleb = await idOf('Caleb');
  const c = ok(await unlock(caleb, '1234'));
  assert.equal(c.mustChange, true);
  ok(await choose(c.token, '2580'));
  assert.equal(ok(await unlock(caleb, '2580')).mustChange, false);
  // nobody can unlock as someone who isn't on the till
  said(await unlock(MIA, '1234'), 404, W.notOnTill);
  said(await unlock('tp_0000000000000000', '1234'), 404, W.notOnTill);
});

test('round 32: PINs and tokens are never kept as typed, and the key is not in the tables', async () => {
  const mo = ok(await unlock(OWNER, '1234'));
  ok(await choose(mo.token, '2046'));
  const felix = await idOf('Felix');
  const f = ok(await unlock(felix, '1234'));
  ok(await choose(f.token, '2046'));
  const pins = lair.sql.exec('SELECT * FROM till_pins ORDER BY person_id').toArray();
  assert.equal(pins.length, 2);
  for (const row of pins) {
    assert.match(row.hash, /^[0-9a-f]{64}$/);
    assert.match(row.salt, /^[0-9a-f]{32}$/);
  }
  // the same PIN, a different salt, a different hash
  assert.notEqual(pins[0].hash, pins[1].hash);
  const text = allTillText();
  assert.ok(!text.includes('2046'), 'a PIN as typed is in a till table');
  assert.ok(!text.includes(mo.token) && !text.includes(f.token), 'a till token as given is in a till table');
  const key = await ctx.storage.get('till-pin-key');
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!text.includes(key), 'the PIN key is in a till table');
  // after a restart the same key is used: their own PINs still work
  boot(ctx);
  assert.equal(ok(await unlock(OWNER, '2046')).mustChange, false);
  assert.equal(ok(await unlock(felix, '2046')).mustChange, false);
});

test('round 32: five wrong PINs lock someone out for 5 minutes, then 10; a right PIN after the wait clears it', async () => {
  const caleb = await idOf('Caleb');
  for (let i = 0; i < 4; i += 1) said(await unlock(caleb, '0000'), 401, W.wrong);
  said(await unlock(caleb, '0000'), 429, W.locked(5));
  // even the right PIN waits
  said(await unlock(caleb, '1234'), 429, W.locked(5));
  const view = (await team()).find((p) => p.id === caleb);
  assert.equal(view.locked, true);
  assert.equal(view.lockedMinutes, 5);
  // someone else isn't held up
  ok(await unlock(OWNER, '1234'));
  // after the wait, five more wrong: 10 minutes this time
  nowIs(NOW + 5 * MIN + 1000);
  for (let i = 0; i < 4; i += 1) said(await unlock(caleb, '9999'), 401, W.wrong);
  said(await unlock(caleb, '9999'), 429, W.locked(10));
  nowIs(NOW + 15 * MIN + 2000);
  assert.equal(ok(await unlock(caleb, '1234')).mustChange, true);
  // the right PIN cleared it: the next lock-out is 5 minutes again
  for (let i = 0; i < 4; i += 1) said(await unlock(caleb, '1111'), 401, W.wrong);
  said(await unlock(caleb, '1111'), 429, W.locked(5));
  // the waits double up to an hour
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => tillLockMs(n) / MIN), [5, 10, 20, 40, 60, 60, 60]);
});

test('round 32: a till token lasts a long shift, then the PIN is asked for again', async () => {
  const mo = ok(await unlock(OWNER, '1234'));
  nowIs(NOW + TILL_SESSION_MS - 1000);
  ok(await choose(mo.token, '2046'));
  nowIs(NOW + TILL_SESSION_MS + 1000);
  said(await choose(mo.token, '4444'), 401, W.expired);
  said(await tillPost('reset', { token: mo.token, id: HEMI }), 401, W.expired);
  // a made-up token is no better
  said(await choose('f'.repeat(48), '4444'), 401, W.expired);
  said(await choose('not a token', '4444'), 401, W.expired);
  assert.equal(ok(await unlock(OWNER, '2046')).mustChange, false);
});

test("round 32: the owner resets someone's PIN: back to 1234 to choose again, lock-out cleared, their tills lock", async () => {
  const felix = await idOf('Felix');
  const f = ok(await unlock(felix, '1234'));
  ok(await choose(f.token, '5555'));
  const mo = ok(await unlock(OWNER, '1234'));
  const res = ok(await tillPost('reset', { token: mo.token, id: felix }));
  assert.equal(res.team.find((p) => p.id === felix).pin, 'start');
  said(await choose(f.token, '6666'), 401, W.expired);
  said(await unlock(felix, '5555'), 401, W.wrong);
  assert.equal(ok(await unlock(felix, '1234')).mustChange, true);
  // a lock-out is cleared too
  const caleb = await idOf('Caleb');
  for (let i = 0; i < 5; i += 1) await unlock(caleb, '0000');
  said(await unlock(caleb, '1234'), 429, W.locked(5));
  ok(await tillPost('reset', { token: mo.token, id: caleb }));
  ok(await unlock(caleb, '1234'));
  // the owner's own till stays open after resetting their own PIN with it
  ok(await tillPost('reset', { token: mo.token, id: OWNER }));
  ok(await choose(mo.token, '2046'));
  // only the owner
  const hemi = ok(await unlock(HEMI, '1234'));
  said(await tillPost('reset', { token: hemi.token, id: felix }), 403, W.ownerOnly);
  said(await tillPost('reset', { id: felix }, HEMI), 401, W.expired);
  said(await tillPost('reset', { token: mo.token, id: MIA }), 404, W.notOnTill);
});

test('round 32: an owner who forgot their PIN resets it while their own account is logged in, and only theirs', async () => {
  const mo = ok(await unlock(OWNER, '1234'));
  ok(await choose(mo.token, '2046'));
  for (let i = 0; i < 5; i += 1) await unlock(OWNER, '0000');
  said(await unlock(OWNER, '2046'), 429, W.locked(5));
  ok(await tillPost('reset', { id: OWNER }, OWNER));
  assert.equal(ok(await unlock(OWNER, '1234')).mustChange, true);
  // not someone else's without the owner on the till, and not from a helper's account
  said(await tillPost('reset', { id: await idOf('Caleb') }, OWNER), 401, W.expired);
  said(await tillPost('reset', { id: OWNER }, HEMI), 401, W.expired);
});

test("round 32: the owner switches someone's till access off and back on", async () => {
  const felix = await idOf('Felix');
  const f = ok(await unlock(felix, '1234'));
  ok(await choose(f.token, '4321'));
  const mo = ok(await unlock(OWNER, '1234'));
  const res = ok(await tillPost('access', { token: mo.token, id: felix, off: true }));
  assert.equal(res.team.find((p) => p.id === felix).off, true);
  said(await choose(f.token, '1357'), 401, W.expired);
  said(await unlock(felix, '4321'), 403, W.off);
  // not the owner's own, and only the owner
  said(await tillPost('access', { token: mo.token, id: OWNER, off: true }), 400, W.notSelf);
  const hemi = ok(await unlock(HEMI, '1234'));
  said(await tillPost('access', { token: hemi.token, id: felix, off: false }), 403, W.ownerOnly);
  // back on: their own PIN still works
  ok(await tillPost('access', { token: mo.token, id: felix, off: false }));
  assert.equal(ok(await unlock(felix, '4321')).mustChange, false);
  // switching off a helper works the same way
  ok(await tillPost('access', { token: mo.token, id: HEMI, off: true }));
  said(await tillPost('reset', { token: hemi.token, id: HEMI }), 401, W.expired);
  said(await unlock(HEMI, '1234'), 403, W.off);
});

test("round 32: the owner adds, changes and removes the till's own people", async () => {
  const mo = ok(await unlock(OWNER, '1234'));
  const added = ok(await tillPost('people', { token: mo.token, name: '  Aroha   Ngata ' }));
  assert.deepEqual([added.person.name, added.person.kind, added.person.roleWords, added.person.pin], ['Aroha Ngata', 'till', 'Check-in', 'start']);
  assert.equal(added.team.at(-1).id, added.person.id);
  const aroha = added.person.id;
  // names: there, not too long, not already on the till (first names count, any case)
  said(await tillPost('people', { token: mo.token, name: 'aroha ngata' }), 409, W.nameTaken('aroha ngata'));
  said(await tillPost('people', { token: mo.token, name: 'mo' }), 409, W.nameTaken('mo'));
  said(await tillPost('people', { token: mo.token, name: 'CALEB' }), 409, W.nameTaken('CALEB'));
  said(await tillPost('people', { token: mo.token, name: '   ' }), 400, W.name);
  said(await tillPost('people', { token: mo.token, name: 'x'.repeat(31) }), 400, W.name);
  said(await tillPost('people', { token: mo.token, name: '<b>Bo</b>' }), 400, W.name);
  // what they can do: Check-in and Money only
  const changed = ok(await tillPost('people', { token: mo.token, id: aroha, perms: ['money', 'tables', 'team', 'checkin'] }));
  assert.deepEqual(changed.person.perms, ['checkin', 'money']);
  assert.equal(changed.person.roleWords, 'Check-in and money');
  assert.equal(changed.person.name, 'Aroha Ngata');
  said(await tillPost('people', { token: mo.token, id: aroha, perms: 'money' }), 400, W.permsList);
  const salesOnly = ok(await tillPost('people', { token: mo.token, name: 'Bo', perms: [] }));
  assert.equal(salesOnly.person.roleWords, 'Sales only');
  // a rename keeps their perms; helpers are changed on the Team tab, not here
  const caleb = await idOf('Caleb');
  assert.equal(ok(await tillPost('people', { token: mo.token, id: caleb, name: 'Caleb R' })).person.roleWords, 'Check-in');
  said(await tillPost('people', { token: mo.token, id: HEMI, perms: ['money'] }), 404, W.notTillPerson);
  // a new person unlocks on 1234 and chooses their own
  const a = ok(await unlock(aroha, '1234'));
  assert.equal(a.mustChange, true);
  ok(await choose(a.token, '8642'));
  // removed: off the lock screen, their till locks, their PIN is gone
  const removed = ok(await tillPost('people/remove', { token: mo.token, id: aroha }));
  assert.ok(!removed.team.some((p) => p.id === aroha));
  said(await choose(a.token, '9753'), 401, W.expired);
  said(await unlock(aroha, '8642'), 404, W.notOnTill);
  assert.equal(lair.tillPinRow(aroha), null);
  said(await tillPost('people/remove', { token: mo.token, id: aroha }), 404, W.notTillPerson);
  said(await tillPost('people/remove', { token: mo.token, id: HEMI }), 404, W.notTillPerson);
  // only the owner
  const hemi = ok(await unlock(HEMI, '1234'));
  said(await tillPost('people', { token: hemi.token, name: 'Tia' }), 403, W.ownerOnly);
  said(await tillPost('people/remove', { token: hemi.token, id: caleb }), 403, W.ownerOnly);
});

test("round 32: a helper taken off the Team tab is off the till, and their till locks", async () => {
  const hemi = ok(await unlock(HEMI, '1234'));
  ok(await choose(hemi.token, '7777'));
  ok(await call('POST', `team/${HEMI}/remove`, {}, OWNER));
  assert.ok(!(await team()).some((p) => p.id === HEMI));
  said(await choose(hemi.token, '7778'), 401, W.expired);
  said(await unlock(HEMI, '7777'), 404, W.notOnTill);
});

test("round 32: when Shopify can't be asked, the till still has who's logged in, the helpers and its own people", async () => {
  searchFails = true;
  assert.deepEqual((await team()).map((p) => p.name), ['Mo', 'Hemi', 'Tama', 'Caleb', 'Felix']);
  // a helper's tablet, with Shopify never reached: no owner to show, everyone else still there
  assert.deepEqual((await team(HEMI)).map((p) => p.name), ['Hemi', 'Tama', 'Caleb', 'Felix']);
  // once Shopify answers, the owner is back, and kept when it fails again
  searchFails = false;
  nowIs(NOW + 11 * MIN);
  assert.equal((await team(HEMI))[0].name, 'Mo');
  searchFails = true;
  nowIs(NOW + 22 * MIN);
  assert.equal((await team(HEMI))[0].name, 'Mo');
  // with Shopify not connected at all, whoever's logged in and the rest
  shopifyOn = false;
  assert.deepEqual((await team()).map((p) => p.name), ['Mo', 'Hemi', 'Tama', 'Caleb', 'Felix']);
});

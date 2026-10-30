// Round 23: a loyalty roll can be taken as a sure $10 instead of rolling the d20 (contract v23-sure-ten).
// Mo (30 Oct 2026, 11:59pm): "make the rolling of the d20 have an option for someone to either get $10 store credit or
// roll a d20 and get store credit equal to the number they rolled. Make it a choice for the user if they feel their luck
// is bad." The rule is written there and in the README's loyalty card paragraph. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair, MIGRATIONS } from '../src/lair.js';
import { rulesFromSettings, DEFAULT_HOURS, LOYALTY_SURE, LOYALTY_PICKS, PICK_WORDS, loyaltySureMessage } from '../src/core.js';

const HOUR = 3_600_000;
// Saturday 31 October 2026, 7:00pm in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 9, 31, 6, 0);
const realNow = Date.now;

/* ---------------- helpers, as in test/round22-stamps.test.js ---------------- */
function fakeCtx(db = new DatabaseSync(':memory:')) {
  const sql = {
    exec(query, ...bindings) {
      // as SQLite in a Durable Object: Cloudflare's limits (test/cloudflare-sql.js)
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
// People by their Shopify customer IDs (made up): the main account and two members
const OWNER = '9001';
const MIA = '6001';
const KAI = '6002';

let lair;
// Each store credit Shopify was asked for ([customerId, cents]); creditFails makes Shopify refuse
let credited;
let creditFails;
let staffMail;

async function call(method, path, body, customer = '', extraHeaders = {}) {
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders },
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, data: await response.json() };
}
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
/** POST /roll as a member (a phone on one connection) */
const roll = (body, who = MIA) => call('POST', 'roll', body, who, { 'X-Lair-Client': '203.0.113.7' });
/** Staff give a member loyalty rolls (as the staff page's Members does) */
const give = async (who, count) => ok(await call('POST', `members/${who}/rolls`, { count }, OWNER));
const card = async (who = MIA) => ok(await call('GET', 'me', null, who)).loyalty;

/**
 * The next d20 faces, in order (the server rolls with crypto.getRandomValues). dice.left() is how many weren't rolled,
 * so a check can tell whether a d20 was rolled at all. Call dice.unload() to put it back.
 */
function loadDice(faces) {
  const queue = [...faces];
  const realRandom = crypto.getRandomValues.bind(crypto);
  crypto.getRandomValues = (array) => {
    if (array instanceof Uint32Array && array.length === 1 && queue.length) {
      array[0] = queue.shift() - 1;
      return array;
    }
    return realRandom(array);
  };
  return { left: () => queue.length, unload: () => { crypto.getRandomValues = realRandom; } };
}

// No network in these tests: Shopify's store credit is a stand-in, and anything else that reaches out fails the test.
const realFetch = globalThis.fetch;
let reached = [];

beforeEach(async () => {
  reached = [];
  credited = [];
  creditFails = false;
  staffMail = [];
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
  lair.shopify.customerEmail = async () => null;
  // the staff Members list asks Shopify when each member first became a customer
  lair.shopify.customersSince = async () => new Map();
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.creditCustomer = async (customerId, cents, currency) => {
    await new Promise((r) => setTimeout(r, 5)); // Shopify takes a moment
    if (creditFails) throw new Error('Shopify API error 502');
    credited.push([customerId, cents, currency]);
  };
  lair.shopify.createPrizeCode = async () => assert.fail('a loyalty roll never makes a discount code');
  lair.notifyStaff = (subject, body) => staffMail.push({ subject, ...body });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  for (const [id, name] of [[MIA, 'Mia Chen'], [KAI, 'Kai Tane']]) {
    lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
  }
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

/* ---------------- the words and the rule ---------------- */

test('round 23: the sure $10 and its words, word for word', () => {
  // $10 store credit, in cents. A d20 pays $1 to $20, $10.50 on average, so rolling stays (just) the better bet and the
  // sure $10 costs the shop nothing more than a roll does.
  assert.equal(LOYALTY_SURE, 1000);
  assert.deepEqual(LOYALTY_PICKS, ['roll', 'sure']);
  assert.equal(loyaltySureMessage(), 'You played it safe: $10 store credit is yours.');
  assert.equal(loyaltySureMessage(true), 'You played it safe: $10 store credit is yours. Show this screen at the counter to claim it.');
  assert.deepEqual(PICK_WORDS, {
    unknown: "That pick didn't come through properly. Try again.",
    staffPicked: 'Took $10 instead of rolling',
  });
});

/* ---------------- "either get $10 store credit or roll a d20" ---------------- */

test('a roll can be taken as $10 store credit instead (Mo, 30 Oct 2026): it uses one roll, adds exactly $10 at once, and no d20 is rolled', async () => {
  await give(MIA, 2);
  const dice = loadDice([13]);
  try {
    const res = await roll({ kind: 'loyalty', pick: 'sure' });
    assert.equal(res.status, 200, res.data.error);
    assert.equal(dice.left(), 1, 'the d20 stayed in the tray');
    const { roll: face, kind, pick, prize, message, loyalty } = res.data;
    assert.deepEqual([face, kind, pick, prize.kind, prize.amount, prize.status], [null, 'loyalty', 'sure', 'credit', 1000, 'added']);
    assert.equal(message, 'You played it safe: $10 store credit is yours.');
    assert.deepEqual(credited, [[MIA, 1000, 'NZD']], '$10 onto her Shopify store credit, once');
    assert.deepEqual([loyalty.rolls.available, loyalty.rolls.used], [1, 1], 'one roll used, one still ready');
    assert.deepEqual(loyalty.history, [{ id: prize.id, at: NOW, roll: null, pick: 'sure', amount: 1000, status: 'added' }]);
    // My Lair's Wallet lists it the same way, and its prizes list too
    const me = ok(await call('GET', 'me', null, MIA));
    assert.deepEqual(me.loyalty.history, loyalty.history);
    assert.deepEqual(me.prizes, [{ id: prize.id, kind: 'credit', amount: 1000, status: 'added', roll: null, pick: 'sure', at: NOW }]);
    assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM member_rolls WHERE customer_id = ? AND kind = 'loyalty'", MIA).one().n, 1);
  } finally {
    dice.unload();
  }
});

test('"or roll a d20 and get store credit equal to the number they rolled": rolling is as it was, with or without saying so', async () => {
  await give(MIA, 2);
  const dice = loadDice([13, 4]);
  try {
    const picked = ok(await roll({ kind: 'loyalty', pick: 'roll' }));
    assert.deepEqual([picked.roll, picked.pick, picked.prize.amount, picked.message], [13, 'roll', 1300, 'You rolled a 13: $13 store credit is yours.']);
    const plain = ok(await roll({ kind: 'loyalty' }));
    assert.deepEqual([plain.roll, plain.pick, plain.prize.amount], [4, 'roll', 400], 'no pick: the d20, as every page before round 23 asks');
    assert.deepEqual(credited.map(([, cents]) => cents), [1300, 400]);
    assert.deepEqual(plain.loyalty.history.map((h) => [h.roll, h.pick, h.amount]), [[4, 'roll', 400], [13, 'roll', 1300]]);
  } finally {
    dice.unload();
  }
});

test('"make it a choice": every roll gets its own pick, wherever it came from, and the card says the $10 is on offer', async () => {
  // rolls from staff now; the same pool holds full cards', birthday gifts' and loot codes' rolls
  assert.equal((await card()).sure, 1000, 'on offer before there are any rolls, so a page can explain it');
  await give(MIA, 3);
  const dice = loadDice([1, 20]);
  try {
    assert.equal(ok(await roll({ kind: 'loyalty' })).prize.amount, 100, 'a 1');
    assert.equal(ok(await roll({ kind: 'loyalty', pick: 'sure' })).prize.amount, 1000, 'then the safe $10');
    assert.equal(ok(await roll({ kind: 'loyalty', pick: 'roll' })).prize.amount, 2000, 'then a natural 20');
    const c = await card();
    assert.deepEqual([c.sure, c.rolls.available, c.rolls.used], [1000, 0, 3]);
    assert.deepEqual(c.history.map((h) => [h.pick, h.roll, h.amount]), [['roll', 20, 2000], ['sure', null, 1000], ['roll', 1, 100]], 'newest first');
    assert.equal((await roll({ kind: 'loyalty', pick: 'sure' })).status, 409, 'none left: no $10 either');
    assert.deepEqual(credited.map(([, cents]) => cents), [100, 1000, 2000]);
  } finally {
    dice.unload();
  }
});

/* ---------------- the pick is made first, and only once ---------------- */

test('the pick comes before the roll: one roll spent two ways at once (two taps on a slow phone) pays out once, and a face can\'t be swapped for the $10 after', async () => {
  await give(MIA, 1);
  let dice = loadDice([3]);
  try {
    const [a, b] = await Promise.all([roll({ kind: 'loyalty', pick: 'sure' }), roll({ kind: 'loyalty', pick: 'roll' })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], 'whichever reached the Lair first; the other found nothing left');
    const [won, lost] = a.status === 200 ? [a.data, b.data] : [b.data, a.data];
    assert.equal(lost.error, 'No rolls yet, friend. Fill your card: 10 sessions earn a roll.');
    assert.deepEqual(credited, [[MIA, won.prize.amount, 'NZD']], 'paid once');
    assert.equal(dice.left(), won.pick === 'sure' ? 1 : 0, 'and the refused tap rolled nothing');
  } finally {
    dice.unload();
  }
  // There's no way back: rolling a low face and then taking the $10 for that same roll can't happen
  credited = [];
  await give(MIA, 1);
  dice = loadDice([2]);
  try {
    assert.equal(ok(await roll({ kind: 'loyalty', pick: 'roll' })).roll, 2);
    assert.equal((await roll({ kind: 'loyalty', pick: 'sure' })).status, 409);
    assert.deepEqual(credited, [[MIA, 200, 'NZD']]);
  } finally {
    dice.unload();
  }
});

test('a pick the Lair doesn\'t know is refused, with nothing used, rolled or paid; logged out, a pick is just a fun roll', async () => {
  await give(MIA, 1);
  const dice = loadDice([9, 9]);
  try {
    for (const pick of ['ten', 'SURE', 'safe', '', 10, true, ['sure'], { pick: 'sure' }]) {
      const res = await roll({ kind: 'loyalty', pick });
      assert.deepEqual([res.status, res.data.error], [422, "That pick didn't come through properly. Try again."], JSON.stringify(pick));
    }
    assert.deepEqual([credited, dice.left(), (await card()).rolls.available], [[], 2, 1], 'the roll is still ready');
    // null is no pick: the d20, like an older page
    assert.equal(ok(await roll({ kind: 'loyalty', pick: null })).roll, 9);
    // Logged out there's no card, so no prize either way (the home page's fun roll)
    assert.deepEqual(ok(await roll({ kind: 'loyalty', pick: 'sure' }, '')), { roll: 9 });
    assert.deepEqual(credited.map(([, cents]) => cents), [900]);
  } finally {
    dice.unload();
  }
});

/* ---------------- when Shopify can't add it ---------------- */

test('when Shopify can\'t add the $10, it waits at the counter like a roll\'s prize: the member is told, staff are emailed what was picked, and mark it done', async () => {
  await give(MIA, 1);
  creditFails = true;
  const res = ok(await roll({ kind: 'loyalty', pick: 'sure' }));
  assert.deepEqual([res.roll, res.pick, res.prize.amount, res.prize.status], [null, 'sure', 1000, 'pending']);
  assert.equal(res.message, 'You played it safe: $10 store credit is yours. Show this screen at the counter to claim it.');
  assert.deepEqual(res.loyalty.history.map((h) => [h.pick, h.roll, h.amount, h.status]), [['sure', null, 1000, 'pending']]);
  assert.equal(staffMail.length, 1);
  assert.equal(staffMail[0].subject, 'Prize to give at the counter: Mia Chen');
  assert.deepEqual(Object.fromEntries(staffMail[0].details), {
    Member: `Mia Chen (${lair.memberRow(MIA).code})`, Picked: 'Took $10 instead of rolling', Prize: '$10.00 store credit', Why: 'Shopify API error 502',
  }, 'no "Roll" line: nothing was rolled');
  const listed = ok(await call('GET', 'members?q=mia', null, OWNER))[0];
  assert.deepEqual(listed.pendingPrizes, [{ id: res.prize.id, kind: 'credit', amount: 1000, status: 'pending', roll: null, pick: 'sure', at: NOW }]);
  const done = ok(await call('POST', `prizes/${res.prize.id}/done`, {}, OWNER));
  assert.deepEqual(done.prize, { id: res.prize.id, kind: 'credit', amount: 1000, status: 'done', roll: null, pick: 'sure', at: NOW });
  assert.deepEqual((await card()).history.map((h) => [h.pick, h.status]), [['sure', 'added']], 'given at the counter counts as added');
});

/* ---------------- older stores and older rows ---------------- */

test('a store from before round 23 gets the pick column on its next start, and its rolls read as rolls', async () => {
  // a Durable Object last started before round 23: every migration ran, but member_rolls has no pick column
  const db = new DatabaseSync(':memory:');
  const old = fakeCtx(db);
  lair = new Lair(old, { CURRENCY: 'NZD' });
  db.exec('ALTER TABLE member_rolls DROP COLUMN pick');
  assert.throws(() => db.prepare('SELECT pick FROM member_rolls').all(), /no such column/);
  db.prepare("INSERT INTO member_rolls (id, customer_id, kind, day, roll, prize_id, created_at) VALUES ('rl_old', ?, 'loyalty', '2026-10-30', 17, 'pz_old', ?)").run(KAI, NOW - HOUR);
  db.prepare("INSERT INTO prizes (id, customer_id, source, kind, amount, status, created_at, updated_at) VALUES ('pz_old', ?, 'loyalty', 'credit', 1700, 'added', ?, ?)").run(KAI, NOW - HOUR, NOW - HOUR);
  // the next start
  lair = new Lair(old, { CURRENCY: 'NZD' });
  lair.taggedPerson = async (id) => ({ customerId: id || null, staff: id === OWNER, gm: false, tags: [] });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  assert.deepEqual(db.prepare('SELECT pick FROM member_rolls').all().map((r) => ({ ...r })), [{ pick: null }]);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, String(MIGRATIONS.length), 'no migration step: the column is made sure of on every start');
  const c = lair.loyaltyOf(KAI, lair.rulesCache, { details: true });
  assert.deepEqual(c.history, [{ id: 'pz_old', at: NOW - HOUR, roll: 17, pick: 'roll', amount: 1700, status: 'added' }]);
  assert.deepEqual(lair.memberPrizes(KAI), [{ id: 'pz_old', kind: 'credit', amount: 1700, status: 'added', roll: 17, pick: 'roll', at: NOW - HOUR }]);
});

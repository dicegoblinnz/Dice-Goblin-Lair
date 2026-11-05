// Round 29: the head-start loyalty card (contract v29-roleplayers, section 1). Mo (2 Nov 2026) picked mockup A, "12
// slots, 2 from Gobgob", in the roleplayers, loyalty and community plan:
//  - "Every card shows 12 slots, the first 2 already filled as Gobgob's head start, so a d20 roll still takes 10 paid
//    visits. Cards in progress get the 2 as well: 7 of 10 shows as 9 of 12; 0 shows 2 of 12; 9 shows 11 of 12; the 10th
//    stamp completes the card, a roll becomes available exactly as today, and the next card shows 2 of 12."
//  - "This is presentation only. How stamps are earned, CARD_SIZE = 10 as the counting rule, cards, rolls, credit and
//    the sure $10 stay exactly as they are. No new credit or roll for anyone."
//  - Progress shows wherever people book (My Lair, the website's confirmations, booking emails, the staff page and the
//    counter), each saying "X of 12".
// Written from those words, not from the code. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { STAMP_WORDS } from '../src/stamps.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS, CARD_SIZE, CARD_HEAD_START, CARD_SLOTS, LOYALTY_SURE, loyaltyCard, cardView, cardSoFar } from '../src/core.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
// Monday 2 November 2026, the day Mo picked the head start; 5:00pm in Auckland (NZDT, UTC+13). Open 4pm to midnight.
const TODAY = '2026-11-02';
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const NOW = at(TODAY, 17);
const realNow = Date.now;
const nowIs = (ms) => {
  Date.now = () => ms;
};

/* ---------------- helpers, as in test/round28-booked.test.js ---------------- */
function fakeCtx() {
  const db = new DatabaseSync(':memory:');
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
// Tonight's events: trivia night at $5 a person
const EVENTS = [{ id: 'quiz', title: 'Trivia night', start: at(TODAY, 19), end: at(TODAY, 21), tables: '', capacity: 20, entryFee: 500 }];
// People by their Shopify customer IDs (made up): the main account, a helper with Check-in (Hemi), members, and a GM
const OWNER = '9001';
const HEMI = '9102';
const MIA = '6001';
const KAI = '6002';
const LEO = '6004';
const GM = '7001';
const ENV = { CURRENCY: 'NZD' };

let ctx;
let lair;
// Each store credit Shopify was asked for ([customerId, cents, currency])
let credited;
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
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const internal = (path, body) => call('POST', `internal/${path}`, body, '', { 'X-Lair-Internal': '1' });
const pos = (path, body) => internal(`pos/${path}`, body);
const card = async (who) => ok(await call('GET', 'me', null, who)).loyalty;
const codeOf = (id) => lair.memberRow(id).code;
/** POST /roll as a member: one of their loyalty rolls (pick: 'sure' for the sure $10) */
const roll = (who, pick) => call('POST', 'roll', { kind: 'loyalty', ...(pick ? { pick } : {}) }, who, { 'X-Lair-Client': '203.0.113.7' });
// Round 23's words when a member has no rolls: still true, as 10 paid visits still earn a roll
const NO_ROLLS = '409 No rolls yet, friend. Fill your card: 10 sessions earn a roll.';

/** Stamps on a member's card, added by the main account on their staff page (round 22), up to 10 a time */
async function stamp(who, count) {
  for (let left = count; left > 0; left -= 10) ok(await call('POST', `members/${who}/stamps`, { count: Math.min(10, left) }, OWNER));
}
/** A table booked online by a member (or a guest: who ''), tonight 7pm to 9pm unless said → the booking */
async function table(who, name, { tables = ['T3'], people = 1, start = at(TODAY, 19), end = at(TODAY, 21), ...more } = {}) {
  return ok(await call('POST', 'bookings', { kind: 'table', tables, start, end, people, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100', pay: 'day', ...more }, who)).booking;
}
/** A sign-up to tonight's trivia night → the answer */
async function signUp(who, name, more = {}) {
  return call('POST', `events/quiz@${TODAY}/join`, { name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100', people: 1, ...more }, who);
}
/** A TTRPG session the GM lists for tonight (schedule 'flexible' makes it one you can join every session) → the game */
async function session(more = {}) {
  return ok(await call('POST', 'games', {
    title: 'Blades at the Lair', system: 'Blades in the Dark', gm: 'Ellie', email: 'ellie@example.com', blurb: 'Heists.', seats: 4, tables: ['T12'],
    start: at(TODAY, 19), end: at(TODAY, 22), ...more,
  }, GM)).game;
}

/**
 * The next d20 faces, in order (the server rolls with crypto.getRandomValues), as in test/round23-sure-ten.test.js.
 * dice.unload() puts it back.
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

/** Emails through a stand-in Resend, as in test/round11-reminders.test.js: every one the Lair sends, in order */
function captureEmails() {
  const keys = { RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test' };
  lair.baseEnv = { ...lair.baseEnv, ...keys };
  lair.env = { ...lair.env, ...keys };
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (!/resend/i.test(String(url))) throw new Error(`No network in tests: ${url}`);
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return sent;
}
const settle = () => new Promise((r) => setTimeout(r, 10));
/** The "Loyalty card" row of an email's details: its plain-text line's value, or null when it has none */
const cardRow = (mail) => {
  const line = String(mail?.text || '').split('\n').find((l) => /^Loyalty card:/.test(l));
  return line ? line.replace(/^Loyalty card:\s*/, '') : null;
};

// What every card shape has in common, whichever screen it's for: stamps and cardSize as before (for older pages and
// counters), cards and card, and the head start's slots, headStart and onCard
const CARD_FIELDS = ['stamps', 'cardSize', 'cards', 'card', 'slots', 'headStart', 'onCard'];
const fieldsOf = (loyalty) => Object.fromEntries(CARD_FIELDS.map((k) => [k, loyalty?.[k]]));

// No network in these tests: Shopify's store credit is a stand-in, and anything else that reaches out fails the test.
const realFetch = globalThis.fetch;
let reached = [];

beforeEach(async () => {
  reached = [];
  credited = [];
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  ctx = fakeCtx();
  lair = new Lair(ctx, ENV);
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: id === GM, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  lair.shopify.customersSince = async () => new Map();
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.creditCustomer = async (customerId, cents, currency) => {
    credited.push([customerId, cents, currency]);
  };
  lair.shopify.createPrizeCode = async () => assert.fail('a loyalty roll never makes a discount code');
  lair.accountEmail = async () => ({ fetched: false, email: '' });
  lair.checkGiftCodes = async () => 0;
  lair.notifyStaff = () => {};
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  ok(await call('POST', 'team', { customerId: HEMI, name: 'Hemi Walker', email: 'hemi@example.com', perms: ['checkin'] }, OWNER));
  for (const [id, name] of [[MIA, 'Mia Chen'], [KAI, 'Kai Tane'], [LEO, 'Leo Park']]) {
    lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
  }
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

/* ---------------- the rule ---------------- */

test('round 29 (Mo, 2 Nov 2026): every card shows 12 slots, the first 2 already filled as Gobgob\'s head start, so a d20 roll still takes 10 paid visits', () => {
  assert.equal(CARD_SIZE, 10, 'the counting rule: 10 stamps fill a card');
  assert.equal(CARD_HEAD_START, 2);
  assert.equal(CARD_SLOTS, 12);
  // the card a total of stamps makes, as every screen shows it: onCard is the stamps plus the head start
  const view = (total) => cardView(loyaltyCard(total));
  assert.deepEqual(view(0), { stamps: 0, cardSize: 10, cards: 0, card: 1, slots: 12, headStart: 2, onCard: 2 }, '0 shows 2 of 12');
  assert.deepEqual(view(7), { stamps: 7, cardSize: 10, cards: 0, card: 1, slots: 12, headStart: 2, onCard: 9 }, '7 of 10 shows as 9 of 12');
  assert.deepEqual(view(9), { stamps: 9, cardSize: 10, cards: 0, card: 1, slots: 12, headStart: 2, onCard: 11 }, '9 shows 11 of 12');
  assert.deepEqual(view(10), { stamps: 0, cardSize: 10, cards: 1, card: 2, slots: 12, headStart: 2, onCard: 2 }, 'the 10th stamp completes the card, and the next shows 2 of 12');
  assert.deepEqual(view(27), { stamps: 7, cardSize: 10, cards: 2, card: 3, slots: 12, headStart: 2, onCard: 9 });
  // never a full 12 of 12 to wait on: a card is 2 to 11 of 12 while it's on the go
  for (let total = 0; total <= 40; total += 1) {
    const { onCard, slots, stamps } = view(total);
    assert.ok(onCard >= 2 && onCard <= 11, `${total} stamps: ${onCard} of ${slots}`);
    assert.equal(slots - onCard, CARD_SIZE - stamps, 'what\'s left on the card is the visits still to go');
  }
});

test('round 29 (Mo, 2 Nov 2026): cards in progress get the 2 as well: 0 shows 2 of 12, 7 of 10 shows as 9 of 12, 9 shows 11 of 12', async () => {
  const first = await card(MIA);
  assert.deepEqual(fieldsOf(first), { stamps: 0, cardSize: 10, cards: 0, card: 1, slots: 12, headStart: 2, onCard: 2 }, '0 shows 2 of 12');
  await stamp(MIA, 7);
  const seven = await card(MIA);
  assert.deepEqual(fieldsOf(seven), { stamps: 7, cardSize: 10, cards: 0, card: 1, slots: 12, headStart: 2, onCard: 9 }, '7 of 10 shows as 9 of 12');
  await stamp(MIA, 2);
  const nine = await card(MIA);
  assert.deepEqual(fieldsOf(nine), { stamps: 9, cardSize: 10, cards: 0, card: 1, slots: 12, headStart: 2, onCard: 11 }, '9 shows 11 of 12');
  // no roll for being nearly there: the head start fills slots, not the card
  assert.deepEqual([first.rolls.available, seven.rolls.available, nine.rolls.available], [0, 0, 0]);
  // (10 of 12 is 8 stamps: two to go, and still no roll)
  await stamp(KAI, 8);
  const kai = await card(KAI);
  assert.deepEqual([kai.onCard, kai.slots, kai.stamps, kai.cards, kai.rolls.available], [10, 12, 8, 0, 0], '10 of 12 is not a full card');
});

test('round 29 (Mo, 2 Nov 2026): the 10th stamp completes the card, a roll becomes available exactly as today, and the next card shows 2 of 12', async () => {
  await stamp(MIA, 9);
  const tonight = await table(MIA, 'Mia');
  // her 10th: checked in at the counter
  const checkin = ok(await pos('checkin', { id: tonight.id, type: 'booking' }));
  assert.deepEqual(fieldsOf(checkin.loyalty), { stamps: 0, cardSize: 10, cards: 1, card: 2, slots: 12, headStart: 2, onCard: 2 }, 'the counter sees card 2 at 2 of 12');
  assert.equal(checkin.loyalty.rollsAvailable, 1);
  const me = await card(MIA);
  assert.deepEqual(fieldsOf(me), { stamps: 0, cardSize: 10, cards: 1, card: 2, slots: 12, headStart: 2, onCard: 2 });
  assert.deepEqual(me.rolls, { available: 1, earned: { cards: 1, welcome: 0, birthday: 0, staff: 0, codes: 0 }, used: 0 }, 'one roll, from the full card, as today');
  assert.deepEqual(me.recent.map((s) => [s.title, s.people]), [['Table T3', 1], ['A stamp from Gobgob', 9]], 'how the stamps came: as before');
});

test('round 29 (Mo, 2 Nov 2026): presentation only: a roll is still the d20\'s face in store credit, the sure $10 is still $10, and no new credit or roll for anyone', async () => {
  await stamp(MIA, 20);
  await stamp(KAI, 9);
  const before = await card(MIA);
  assert.deepEqual([before.cards, before.card, before.onCard, before.rolls.available], [2, 3, 2, 2], 'two full cards: two rolls, card 3 at 2 of 12');
  assert.equal(before.sure, LOYALTY_SURE, 'the sure $10, as round 23 has it');
  const dice = loadDice([14]);
  try {
    const rolled = ok(await roll(MIA));
    assert.deepEqual([rolled.roll, rolled.prize.amount, rolled.loyalty.rolls.available], [14, 1400, 1], 'a 14 is $14');
    assert.deepEqual(fieldsOf(rolled.loyalty), { stamps: 0, cardSize: 10, cards: 2, card: 3, slots: 12, headStart: 2, onCard: 2 }, 'the roll\'s card says it too');
    const sure = ok(await roll(MIA, 'sure'));
    assert.deepEqual([sure.roll, sure.prize.amount, sure.loyalty.rolls.available], [null, 1000, 0]);
    assert.equal(said(await roll(MIA)), NO_ROLLS, 'two full cards, two rolls: no more');
  } finally {
    dice.unload();
  }
  // Kai is on 11 of 12: nothing to roll, and nothing for him from the head start
  assert.equal((await card(KAI)).rolls.available, 0);
  assert.equal(said(await roll(KAI)), NO_ROLLS);
  assert.deepEqual(credited, [[MIA, 1400, 'NZD'], [MIA, 1000, 'NZD']], 'only what Mia rolled and took: no credit from the head start');
});

test('round 29 (Mo, 2 Nov 2026): every card the Lair sends carries the same fields: My Lair, the staff page\'s check-in card and member pages, and the counter, each "X of 12"', async () => {
  await stamp(MIA, 17);
  const tonight = await table(MIA, 'Mia');
  const want = { stamps: 7, cardSize: 10, cards: 1, card: 2, slots: 12, headStart: 2, onCard: 9 };
  const shapes = {
    'GET /me': await card(MIA),
    'the check-in card (a member code)': ok(await call('POST', 'checkin', { code: codeOf(MIA) }, HEMI)).loyalty,
    'GET /members': ok(await call('GET', `members?q=${MIA}`, null, OWNER))[0].loyalty,
    'a member page': ok(await call('GET', `members/${MIA}`, null, OWNER)).member.loyalty,
    'the counter (a member code)': ok(await pos('scan', { code: codeOf(MIA) })).loyalty,
    'the counter (her ticket)': ok(await pos('scan', { code: tonight.ref })).loyalty,
    'the counter (round 3\'s member lookup)': ok(await pos('member', { code: codeOf(MIA) })).loyalty,
  };
  for (const [where, loyalty] of Object.entries(shapes)) {
    assert.deepEqual(fieldsOf(loyalty), want, where);
    if (where !== 'GET /me') assert.equal(loyalty.rollsAvailable, 1, `${where}: rollsAvailable as before`);
  }
  // the stamp routes' answers too, one stamp on: 10 of 12. Round 30: the counter adds no stamps (its screen faces
  // customers), so the one stamp on is the check-in card's, and Undo on a member page takes it back
  const next = { ...want, stamps: 8, onCard: 10 };
  assert.equal(said(await pos('stamp', { customerId: MIA, key: 'pos-headstart-1' })), `410 ${STAMP_WORDS.counter}`, 'round 30: no Add a stamp at the counter');
  const given = ok(await call('POST', `members/${MIA}/stamps`, { count: 1 }, HEMI));
  assert.deepEqual(fieldsOf(given.member.loyalty), next, 'Add a stamp on the check-in card');
  const page = ok(await call('POST', `members/${MIA}/stamps/${ok(await call('GET', `members/${MIA}`, null, OWNER)).member.stamps[0].id}/undo`, {}, OWNER));
  assert.deepEqual(fieldsOf(page.member.loyalty), want, 'Undo on a member page');
});

test('round 29 (Mo, 2 Nov 2026): booking emails say how a member\'s card is going, "X of 12 so far", and a guest\'s say nothing about a card', async () => {
  const sent = captureEmails();
  await stamp(MIA, 7);
  // a table, a member's TTRPG seat, an event sign-up and a weekly seat, each from a member with an account
  await table(MIA, 'Mia');
  await settle();
  const booked = sent.find((m) => m.to === 'mia@example.com' && /^You're booked/.test(m.subject));
  assert.equal(cardRow(booked), '9 of 12 so far. Stamps land when you check in.', 'Mia\'s table: 7 stamps');
  assert.match(booked.html, />Loyalty card<\/td><td[^>]*>9 of 12 so far\. Stamps land when you check in\.<\/td>/);
  const game = await session();
  ok(await call('POST', 'bookings', { kind: 'gm-seat', gameId: game.id, people: 1, name: 'Kai', email: 'kai@example.com', phone: '021 555 0100' }, KAI));
  ok(await signUp(LEO, 'Leo'));
  const weekly = await session({ title: 'Weekly Mothership', system: 'Mothership', tables: ['T14'], schedule: 'flexible' });
  ok(await call('POST', `games/${weekly.id}/join-series`, { people: 1, name: 'Mia', email: 'mia@example.com', phone: '021 555 0100' }, MIA));
  await settle();
  const seat = sent.find((m) => m.to === 'kai@example.com' && /^Seat saved/.test(m.subject));
  assert.equal(cardRow(seat), '2 of 12 so far. Stamps land when you check in.', 'Kai\'s TTRPG seat: a new card shows Gobgob\'s 2');
  const join = sent.find((m) => m.to === 'leo@example.com' && /^You're in/.test(m.subject));
  assert.equal(cardRow(join), '2 of 12 so far. Stamps land when you check in.', 'Leo\'s sign-up');
  const regular = sent.find((m) => m.to === 'mia@example.com' && /^You're a regular/.test(m.subject));
  assert.equal(cardRow(regular), '9 of 12 so far. Stamps land when you check in.', 'Mia\'s weekly seat');
  // guests: a TTRPG seat and a sign-up without an account, and a table booked logged out
  const before = sent.length;
  ok(await call('POST', 'bookings', { kind: 'gm-seat', gameId: game.id, people: 1, name: 'Ash', email: 'ash@example.com', phone: '021 555 0100' }, ''));
  ok(await signUp('', 'Rua'));
  await table('', 'Tui', { tables: ['T5'] });
  await settle();
  const guests = sent.slice(before).filter((m) => ['ash@example.com', 'rua@example.com', 'tui@example.com'].includes(m.to));
  assert.deepEqual(guests.map((m) => m.to).sort(), ['ash@example.com', 'rua@example.com', 'tui@example.com'], 'each guest was emailed');
  for (const m of guests) {
    assert.equal(cardRow(m), null, `${m.subject}: no card for a guest`);
    assert.doesNotMatch(m.html, /Loyalty card/);
  }
  // and nothing went to the GM or staff about it
  assert.ok(sent.filter((m) => /Loyalty card/.test(m.html)).every((m) => ['mia@example.com', 'kai@example.com', 'leo@example.com'].includes(m.to)));
});

test('round 29: cardLine, the card in one line for emails (booking reminders and the day-after email use it too): a member\'s "X of 12 so far", or null', async () => {
  assert.equal(cardSoFar({ onCard: 9, slots: 12 }), '9 of 12 so far. Stamps land when you check in.');
  assert.equal(lair.cardLine(MIA), '2 of 12 so far. Stamps land when you check in.', 'a new card');
  await stamp(MIA, 9);
  assert.equal(lair.cardLine(MIA, lair.rulesCache), '11 of 12 so far. Stamps land when you check in.');
  await stamp(MIA, 1);
  assert.equal(lair.cardLine(MIA), '2 of 12 so far. Stamps land when you check in.', 'card 2, straight after the 10th');
  for (const nobody of [null, undefined, '', 'not-a-customer', '424242']) assert.equal(lair.cardLine(nobody), null, `${nobody}: no member, no card`);
});

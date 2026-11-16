// Round 41: quests (contract v41-quests). Mo (16 Nov 2026): "I want to build a quest for my customers to help them get
// more stamps we can do a daily quest say 3 of them that refreshes daily a weekly quest maybe another 3 weekly and a one
// time quest etc." The pool as he settled it the same evening: "Gw dice don't count but all of my dice especially the
// ones with buy 2 get 3 free you get a stamp per dice bought", "dice bought online earn stamps too", "Buying a drink $6+
// gives you a stamp ... A $6+ snack and $6+ ice cream also adds a stamp", "Golden bounty once a week and that bounty
// once completed (daily bounty) you get double stamps for it", "Bounty hunter down to 5", "Library membership is every
// month they renew and once they join too", "Last one out ... when they pay after 11:30pm no need to mention it but
// that is the condition", and the riddle: "create a riddle ... relevant to the game in question". Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { QUESTS, QUEST_LIST, QUEST_WORDS as W, QUESTS_CONFIG, SEED_RIDDLES, inviteCode, linePaid, weekOf } from '../src/quests.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Wednesday 25 November 2026, 2pm in Auckland: the week of Monday 23 November
const TODAY = '2026-11-25';
const WEEK = '2026-11-23';
const NOW = at(TODAY, 14);
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

// Four rooms, as Mo named them: the main room, the gaming room, the party room and the Fancy room
const ROOMS = [
  { id: 'main', name: 'Main room', code: 'T', tables: 6, seats: 4, order: 1 },
  { id: 'gaming', name: 'Gaming room', code: 'G', tables: 2, seats: 4, order: 2 },
  { id: 'party', name: 'Party room', code: 'P', tables: 1, seats: 6, order: 3 },
  { id: 'fancy', name: 'Fancy room', code: 'F', tables: 1, seats: 12, order: 4, minPeople: 4 },
];
const SETTINGS = { lair_hours: DEFAULT_HOURS, lair_shop_tables: '', lair_quests: true };
const OWNER = '9001';
const MIA = '6001';
const KAI = '6002';
const GWEN = '6003';
const NOVA = '6004';
const NAMES = { [OWNER]: 'Mo Ashgrove', [MIA]: 'Mia Chen', [KAI]: 'Kai Tane', [GWEN]: 'Gwen Rua', [NOVA]: 'Nova Lee' };

// What Shopify says about the shop's products (questProducts)
const PRODUCTS = {
  101: { type: 'Dice & Accessories', vendor: 'Dice Goblin NZ', title: 'Galaxy Dice Set', dice: true, listedAt: at('2025-06-01', 9) },
  102: { type: 'Dice & Accessories', vendor: 'Oakie Doakie Dice', title: 'Oakie Doakie Marble RPG Dice Set', dice: true, listedAt: at('2026-10-14', 9) },
  103: { type: 'Paints & Hobby', vendor: 'Games Workshop', title: 'Warhammer Dice', dice: true, listedAt: at('2025-01-01', 9) },
  104: { type: 'Dice & Accessories', vendor: 'Dice Goblin NZ', title: 'Notebooks', dice: false, listedAt: at('2025-01-01', 9) },
  201: { type: 'Drinks', vendor: 'Dice Goblin NZ', title: 'Dragon Milk Tea', dice: false, listedAt: at('2026-11-08', 9) },
  202: { type: 'Snacks', vendor: 'Doritos', title: 'Doritos', dice: false, listedAt: at('2026-11-10', 9) },
  203: { type: 'Ice Cream', vendor: "Ben & Jerry's", title: 'Cookie Dough', dice: false, listedAt: at('2026-11-10', 9) },
  301: { type: 'Paints & Hobby', vendor: 'Games Workshop', title: 'Warhammer Colour Paints', dice: false, listedAt: at('2025-01-01', 9) },
  302: { type: 'Paints & Hobby', vendor: 'Games Workshop', title: 'Warhammer Pro: Painting Handle', dice: false, listedAt: at('2025-01-01', 9) },
  401: { type: 'Board Games', vendor: 'Next Move Games', title: 'Azul: Summer Pavilion', dice: false, listedAt: at('2026-11-15', 9) },
  402: { type: 'Board Games', vendor: 'Next Move Games', title: 'Azul', dice: false, listedAt: at('2024-01-01', 9) },
  501: { type: 'Lair', vendor: 'Dice Goblin NZ', title: 'Paint session', dice: false, listedAt: at('2026-11-01', 9) },
};

let lair;
let spends;
let asked;
let refunds;
const realFetch = globalThis.fetch;

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
const internal = (path, body) => call('POST', `internal/${path}`, body, '', { 'X-Lair-Internal': '1' });
const quests = async (who) => ok(await call('GET', 'me/quests', null, who));
/** The quest stamps on a member's card now: { [key without the customer]: count } */
function questStamps(who) {
  const rows = lair.sql.exec("SELECT key, count FROM loyalty_stamps WHERE customer_id = ? AND kind = 'quest' AND undone_at IS NULL ORDER BY key", who).toArray();
  return Object.fromEntries(rows.map((r) => [r.key.slice(`quest:${who}:`.length), r.count]));
}
const count = (who) => Object.values(questStamps(who)).reduce((a, b) => a + b, 0);
const sync = (who) => lair.questSync(who, Date.now(), lair.rulesCache, { force: true });

/** A line of product `pid`, $price each */
const line = (id, pid, price, quantity = 1, { discount = 0, sku = null } = {}) => ({
  id, product_id: Number(pid), variant_id: Number(pid) * 10, title: PRODUCTS[pid]?.title || 'Thing', vendor: PRODUCTS[pid]?.vendor || '',
  price: price.toFixed(2), quantity, sku, discount_allocations: discount ? [{ amount: discount.toFixed(2) }] : [],
});
/** A paid order: online, or at the counter (pos) */
function order(n, lineItems, { customer = MIA, paidAt = Date.now(), pos = false } = {}) {
  spends.set(String(n), { customerId: customer, amount: 0, source: pos ? 'pos' : 'web', name: `#${n}`, discountCodes: [], processedAt: paidAt });
  return {
    id: n, admin_graphql_api_id: `gid://shopify/Order/${n}`, name: `#${n}`, source_name: pos ? 'pos' : 'web', line_items: lineItems,
    processed_at: new Date(paidAt).toISOString(), customer: { id: Number(customer) },
  };
}
const paid = (o) => internal('orders-paid', o);

/** A stamped session, straight into the Lair's tables: a table, a walk-in or a TTRPG seat */
let made = 0;
function session(who, { kind = 'table', start, people = 1, tables = ['T1'], status = 'done', activity = null, extras = [], gameId = null, seriesId = null, phone = '021 555 0101', booker = who } = {}) {
  made += 1;
  const id = `bk${made}`;
  lair.sql.exec(
    `INSERT INTO bookings (id, ref, kind, status, tables, starts_at, ends_at, people, name, email, phone, activity, extras, paid, amount, paid_amount,
       game_id, customer_id, series_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1000, 1000, ?, ?, ?, ?, ?)`,
    id, `REF-${made}`, kind, status, JSON.stringify(tables), start, start + 2 * HOUR, people, NAMES[who] || 'Guest', 'x@example.com', phone, activity,
    JSON.stringify(extras), gameId, booker, seriesId, start - DAY, start - DAY,
  );
  return id;
}
/** A TTRPG session run by gm, in system, at start */
function game(gm, { system = 'D&D 5e', start, id = `gm${made + 1000}`, staff = false, status = 'open' } = {}) {
  made += 1;
  lair.sql.exec(
    'INSERT INTO games (id, title, system, gm, gm_customer_id, tables, starts_at, ends_at, seats, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 5, ?)',
    id, `${system} one-shot`, system, NAMES[gm], gm, '["G1"]', start, start + 3 * HOUR, status,
  );
  lair.sql.exec('INSERT OR REPLACE INTO gm_runs (game_id, customer_id, staff, at) VALUES (?, ?, ?, ?)', id, gm, staff ? 1 : 0, start);
  return id;
}
const seat = (who, gameId, start) => session(who, { kind: 'gm-seat', gameId, start, tables: ['G1'], activity: 'rpg' });

beforeEach(async () => {
  spends = new Map();
  asked = [];
  refunds = new Map();
  made = 0;
  globalThis.fetch = async (url) => {
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.orderSpend = async (orderId) => spends.get(String(orderId).split('/').pop()) || null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  lair.shopify.customersSince = async () => new Map();
  lair.shopify.gwOrderInfo = async () => null;
  lair.shopify.questProducts = async (ids) => {
    asked.push(...ids);
    return ids.filter((id) => PRODUCTS[id]).map((id) => ({ id: `gid://shopify/Product/${id}`, ...PRODUCTS[id] }));
  };
  lair.shopify.questOrderLines = async (ids) => ids.map((id) => ({ id, ...refunds.get(String(id).split('/').pop()) })).filter((o) => o.lines);
  lair.accountEmail = async () => ({ fetched: false, email: '' });
  lair.checkGiftCodes = async () => 0;
  lair.notifyStaff = () => {};
  lair.gmCreditSoon = () => null;
  lair.rulesCache = rulesFromSettings(SETTINGS, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  // stamps count from well before (sessions from October count for the one-off quests: "counted since the card began")
  lair.loyaltyFrom = at('2026-10-01', 0);
  for (const id of Object.keys(NAMES)) lair.makeMember({ customerId: id, name: NAMES[id], email: `${NAMES[id].split(' ')[0].toLowerCase()}@example.com` }, NOW);
  // quests began this week; this week's golden bounty is today's drink, and its weekly quests Bounty hunter and Clean sweep
  lair.sql.exec("INSERT INTO meta (key, value) VALUES ('quests-from', ?)", WEEK);
  lair.sql.exec('INSERT INTO quest_weeks (week, golden_day, golden_bounty, weeklies, created_at) VALUES (?, ?, ?, ?, ?)', WEEK, TODAY, 'drink', '["bounty-hunter","clean-sweep"]', NOW);
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
});

/* ---------------- the pool ---------------- */

test('round 41: the pool as Mo settled it: the numbers, the four layers and the words', () => {
  assert.deepEqual([QUESTS_CONFIG.bountyCents, QUESTS_CONFIG.goldenStamps, QUESTS_CONFIG.hunterBounties, QUESTS_CONFIG.dwellerSessions, QUESTS_CONFIG.fullHouse], [600, 2, 5, 3, 3]);
  const layer = (l) => QUEST_LIST.filter((q) => q.layer === l).map((q) => q.id);
  assert.deepEqual(layer('daily'), ['bounty-drink', 'bounty-snack', 'bounty-icecream']);
  assert.deepEqual(layer('weekly'), ['riddle', 'full-house', 'lair-dweller', 'bounty-hunter', 'clean-sweep']);
  assert.equal(QUESTS.hoarder.stamps, 10, 'Hoarder: 100 games, 10 stamps');
  assert.equal(QUESTS['last-one-out'].how, 'Found it.', 'Last one out: "no need to mention it"');
  assert.equal(QUESTS.demand.on, false);
  assert.equal(QUESTS.discord.on, false);
  assert.match(inviteCode(), /^FRIEND-[A-HJ-KM-NP-Z2-9]{6}$/);
  assert.equal(SEED_RIDDLES.length, 4, 'Mo: "4 riddles at a time"');
  assert.equal(W.riddleSolved('Azul'), "Azul! You solved Gobgob's riddle. That's a stamp.");
  assert.equal(linePaid(line(1, 101, 30, 3, { discount: 30 })), 6000);
  assert.equal(linePaid(line(1, 101, 30, 3, { discount: 30 }), 2), 4000, 'two of three keep their share of the discount');
});

test('round 41: off until the live theme says so: no Shopify, no facts, no stamps, and My Lair hears quests aren\'t open', async () => {
  lair.rulesCache = rulesFromSettings({ ...SETTINGS, lair_quests: undefined }, ROOMS, []);
  ok(await paid(order(1001, [line(1, 101, 30, 3)])));
  assert.deepEqual(asked, []);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM quest_facts').one().n, 0);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM quest_riddles').one().n, 0, 'the first riddles go in once quests are on');
  assert.equal(count(MIA), 0);
  const res = await call('GET', 'me/quests', null, MIA);
  assert.equal(res.status, 409);
  assert.equal(res.data.error, W.off);
  // a theme string 'true' isn't on
  assert.equal(rulesFromSettings({ lair_quests: 'true' }, ROOMS, []).quests.on, false);
});

/* ---------------- dice ---------------- */

test('dice (Mo: "all of my dice especially the ones with buy 2 get 3 free you get a stamp per dice bought", "Gw dice don\'t count"): a stamp a die, online or at the counter, once', async () => {
  // three Gobgob dice, the third free; two Oakie Doakie sets; GW's dice and a notebook
  const o = order(1001, [line(1, 101, 30, 3, { discount: 30 }), line(2, 102, 15, 2), line(3, 103, 25, 1), line(4, 104, 12, 1)]);
  const first = ok(await paid(o));
  assert.deepEqual(first.quests, { dice: 5, bounties: 0 });
  assert.equal(count(MIA), 5);
  // Shopify sends it again: nothing more
  ok(await paid(o));
  assert.equal(count(MIA), 5);
  // at the counter too
  ok(await paid(order(1002, [line(1, 101, 30, 1)], { pos: true })));
  assert.equal(count(MIA), 6);
  // the card counts them like any stamp
  const card = ok(await call('GET', 'me', null, MIA)).loyalty;
  assert.equal(card.stamps, 6);
  assert.equal(card.recent[0].title, 'Dice for the hoard');
  // what Shopify said about a product is kept: the second order asked only about nothing new
  assert.deepEqual(asked.sort(), ['101', '102', '103', '104']);
});

test('dice refunded: the 10-minute run takes back a refunded die\'s stamp, and a cancelled order\'s', async () => {
  ok(await paid(order(1001, [line(1, 101, 30, 3)])));
  ok(await paid(order(1002, [line(1, 102, 15, 2)])));
  assert.equal(count(MIA), 5);
  nowIs(NOW + 31 * MIN);
  refunds.set('1001', { cancelled: false, lines: [{ id: '1', product_id: '101', price: '30.00', quantity: 3, current_quantity: 1, discount_allocations: [] }] });
  refunds.set('1002', { cancelled: true, lines: [{ id: '1', product_id: '102', price: '15.00', quantity: 2, current_quantity: 2, discount_allocations: [] }] });
  const res = await lair.questUpkeep(Date.now(), lair.rulesCache);
  assert.equal(res.undone, 5);
  assert.deepEqual(questStamps(MIA), { 'dice:gid://shopify/Order/1001:1:1': 1 });
});

/* ---------------- daily bounties ---------------- */

test('daily bounties (Mo: "Buying a drink $6+ gives you a stamp ... A $6+ snack and $6+ ice cream"): $6 in one sale, once each a day; today\'s golden drink pays 2', async () => {
  nowIs(at('2026-11-24', 17));
  // $5.50 of drinks: not yet; then two $3 snacks in one sale count together
  ok(await paid(order(1001, [line(1, 201, 5.5, 1)], { pos: true })));
  ok(await paid(order(1002, [line(1, 202, 3, 2)], { pos: true })));
  assert.deepEqual(questStamps(MIA), { 'bounty:snack:2026-11-24': 1 });
  // a second snack sale the same day: still one
  ok(await paid(order(1003, [line(1, 202, 7, 1)], { pos: true })));
  assert.equal(count(MIA), 1);
  // today (Wednesday) the drink is golden: 2 stamps; the ice cream 1
  nowIs(at(TODAY, 18));
  ok(await paid(order(1004, [line(1, 201, 6, 1), line(2, 203, 6.5, 1)], { pos: true })));
  assert.equal(questStamps(MIA)['bounty:drink:2026-11-25'], 2);
  assert.equal(questStamps(MIA)['bounty:icecream:2026-11-25'], 1);
  const q = await quests(MIA);
  assert.deepEqual(q.bounties.map((b) => [b.id, b.done, b.golden, b.stamps]), [['bounty-drink', true, true, 2], ['bounty-snack', false, false, 1], ['bounty-icecream', true, false, 1]]);
  // tomorrow the golden one isn't golden, and it's out of sight
  nowIs(at('2026-11-26', 18));
  const next = await quests(MIA);
  assert.ok(next.bounties.every((b) => !b.golden && !b.done));
});

test('a bounty refunded down below $6 is taken back; one that still has $6 left stays', async () => {
  nowIs(at(TODAY, 18));
  ok(await paid(order(1001, [line(1, 202, 4, 3)], { pos: true })));
  ok(await paid(order(1002, [line(1, 203, 4, 2)], { pos: true })));
  assert.equal(count(MIA), 2);
  nowIs(at(TODAY, 19));
  refunds.set('1001', { lines: [{ id: '1', product_id: '202', price: '4.00', quantity: 3, current_quantity: 2, discount_allocations: [] }] });
  refunds.set('1002', { lines: [{ id: '1', product_id: '203', price: '4.00', quantity: 2, current_quantity: 1, discount_allocations: [] }] });
  await lair.questUpkeep(Date.now(), lair.rulesCache);
  assert.deepEqual(questStamps(MIA), { 'bounty:snack:2026-11-25': 1 });
});

/* ---------------- weekly quests ---------------- */

test('weekly: Clean sweep (all 3 bounties in a day) and Bounty hunter (Mo: "down to 5"), this week\'s two', async () => {
  nowIs(at('2026-11-23', 17));
  ok(await paid(order(1001, [line(1, 201, 6, 1), line(2, 202, 6, 1)], { pos: true })));
  nowIs(at('2026-11-24', 17));
  ok(await paid(order(1002, [line(1, 201, 6, 1), line(2, 202, 6, 1), line(3, 203, 6, 1)], { pos: true })));
  let s = questStamps(MIA);
  assert.equal(s[`weekly:clean-sweep:${WEEK}`], 1);
  assert.equal(s[`weekly:bounty-hunter:${WEEK}`], 1, 'five bounties: Monday\'s two and Tuesday\'s three');
  // this week's quests don't include Lair dweller: three sessions earn nothing more than their own stamps
  for (const d of ['2026-11-23', '2026-11-24']) session(MIA, { start: at(d, 18) });
  sync(MIA);
  s = questStamps(MIA);
  assert.equal(s[`weekly:lair-dweller:${WEEK}`], undefined);
  const q = await quests(MIA);
  assert.deepEqual(q.weekly.map((w) => [w.id, w.done]), [['riddle', false], ['bounty-hunter', true], ['clean-sweep', true]]);
});

test('weekly: Full house (a table they booked for 3 or more) and Lair dweller (3 sessions), in a week that has them', async () => {
  lair.sql.exec("UPDATE quest_weeks SET weeklies = '[\"full-house\",\"lair-dweller\"]' WHERE week = ?", WEEK);
  session(MIA, { start: at('2026-11-23', 18), people: 2 });
  session(MIA, { start: at('2026-11-24', 18), people: 1 });
  sync(MIA);
  assert.equal(count(MIA), 1, 'first-table, and nothing weekly yet');
  session(MIA, { start: at(TODAY, 12), people: 4 });
  sync(MIA);
  const s = questStamps(MIA);
  assert.equal(s[`weekly:full-house:${WEEK}`], 1);
  assert.equal(s[`weekly:lair-dweller:${WEEK}`], 1);
  // a Session rung up at the counter for a booked table is the same session: never two towards Lair dweller (the review)
  lair.sql.exec("UPDATE quest_weeks SET weeklies = '[\"lair-dweller\",\"clean-sweep\"]' WHERE week = ?", WEEK);
  session(NOVA, { start: at('2026-11-23', 18) });
  lair.sql.exec(
    "INSERT INTO loyalty_stamps (id, customer_id, kind, count, title, order_id, line_id, unit, at, created_at, amount) VALUES ('ls1', ?, 'sale', 1, 'Dice Goblin Day Pass', 'o1', 'l1', 1, ?, ?, 1000)",
    NOVA, at('2026-11-23', 19), NOW,
  );
  session(NOVA, { start: at('2026-11-24', 18) });
  sync(NOVA);
  assert.equal(questStamps(NOVA)[`weekly:lair-dweller:${WEEK}`], undefined, 'two sessions, one of them rung up again at the counter');
  assert.deepEqual((await quests(NOVA)).weekly.find((x) => x.id === 'lair-dweller').have, 2);
  lair.sql.exec("UPDATE quest_weeks SET weeklies = '[\"full-house\",\"lair-dweller\"]' WHERE week = ?", WEEK);
  // a table someone else booked for four, with Mia on it, isn't Mia's Full house
  lair.sql.exec("UPDATE quest_weeks SET weeklies = '[\"full-house\",\"clean-sweep\"]' WHERE week = ?", WEEK);
  session(KAI, { start: at(TODAY, 12), people: 4, booker: MIA });
  sync(KAI);
  assert.equal(questStamps(KAI)[`weekly:full-house:${WEEK}`], undefined);
});

/* ---------------- Gobgob's riddle ---------------- */

test('the riddle: staff set it for a Monday; it\'s out from 10am; scanning the answer\'s box to play here solves it, with a visit that week', async () => {
  lair.saveLibraryGame({ variantId: '9001', productId: '7001', title: 'Azul', handle: 'azul', shelfCode: 'DGL34-M007', image: null }, NOW, ['DGL34-M007']);
  lair.saveLibraryGame({ variantId: '9002', productId: '7002', title: 'Catan', handle: 'catan', shelfCode: 'DGL34-M011', image: null }, NOW, ['DGL34-M011']);
  // staff only; a Monday; not empty; the box's code
  assert.equal((await call('POST', 'quests/riddles', { week: WEEK, text: 'Tiles!', code: 'DGL34-M007' }, MIA)).status, 403);
  assert.equal((await call('POST', 'quests/riddles', { week: TODAY, text: 'Tiles!', code: 'DGL34-M007' }, OWNER)).data.error, W.riddleWeek);
  assert.equal((await call('POST', 'quests/riddles', { week: WEEK, text: ' ', code: 'DGL34-M007' }, OWNER)).data.error, W.riddleText);
  const riddle = ok(await call('POST', 'quests/riddles', { week: WEEK, text: 'Gobgob was hired to tile a palace wall.', hint: '3–4 player shelf', code: 'DGL34-M007' }, OWNER)).riddle;
  assert.deepEqual(riddle.answer, { productId: '7001', title: 'Azul', shelfCode: 'DGL34-M007' });
  assert.equal((await call('POST', 'quests/riddles', { week: WEEK, text: 'Another', code: 'DGL34-M011' }, OWNER)).status, 409);
  const listed = ok(await call('GET', 'quests/riddles', null, OWNER)).riddles;
  assert.deepEqual(listed.map((r) => r.week), [WEEK, '2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21'], 'this week\'s and the four seeded ones');
  // Monday 9am: not out yet, so a scan then doesn't solve it
  nowIs(at(WEEK, 9));
  const early = await quests(MIA);
  assert.deepEqual([early.riddle.out, early.riddle.text], [false, null]);
  ok(await call('POST', 'library/scan', { code: 'DGL34-M007', action: 'play' }, MIA));
  // the wrong game at 7pm, then the right one: solved, but no stamp until they've been in that week
  nowIs(at(WEEK, 19));
  const wrong = ok(await call('POST', 'library/scan', { code: 'DGL34-M011', action: 'play' }, MIA));
  assert.deepEqual([wrong.result, wrong.riddle, wrong.message], ['playing', false, W.playing('Catan')]);
  // the right one, but they haven't been in today: it doesn't count yet, and the reply gives nothing away
  const right = ok(await call('POST', 'library/scan', { code: 'DGL34-M007', action: 'play' }, MIA));
  assert.deepEqual([right.riddle, right.message], [false, W.playing('Azul')]);
  assert.equal(questStamps(MIA)[`weekly:riddle:${WEEK}`], undefined, 'a scan from a photo at home is not a visit');
  // their table that evening is the visit: that day's scan counts, and a scan now says so
  session(MIA, { start: at(WEEK, 18) });
  nowIs(at(WEEK, 20, 30));
  const again = ok(await call('POST', 'library/scan', { code: 'DGL34-M007', action: 'play' }, MIA));
  assert.deepEqual([again.riddle, again.message], [true, W.riddleSolved('Azul')]);
  assert.equal(questStamps(MIA)[`weekly:riddle:${WEEK}`], 1);
  // and once solved, another scan doesn't say it again
  nowIs(at(WEEK, 21, 30));
  assert.equal(ok(await call('POST', 'library/scan', { code: 'DGL34-M007', action: 'play' }, MIA)).riddle, false);
  const q = await quests(MIA);
  assert.equal(q.riddle.solved, true);
  // once someone has solved it, it stays
  assert.equal((await call('POST', `quests/riddles/${riddle.id}/remove`, {}, OWNER)).data.error, W.riddleSolvedAlready);
  // round 42: and its answer and week stay too, or the stamps of everyone who solved it would be taken back; its words
  // can still change
  const moved = await call('POST', 'quests/riddles', { id: riddle.id, week: WEEK, text: riddle.text, code: 'DGL34-M011' }, OWNER);
  assert.deepEqual([moved.status, moved.data.error], [409, W.riddleLocked]);
  const later = await call('POST', 'quests/riddles', { id: riddle.id, week: '2026-12-28', text: riddle.text, code: 'DGL34-M007' }, OWNER);
  assert.deepEqual([later.status, later.data.error], [409, W.riddleLocked]);
  const reworded = ok(await call('POST', 'quests/riddles', { id: riddle.id, week: WEEK, text: 'Tiles, tiles, tiles.', hint: '', code: 'DGL34-M007' }, OWNER)).riddle;
  assert.deepEqual([reworded.text, reworded.hint, reworded.answer.title, reworded.solvedBy], ['Tiles, tiles, tiles.', '', 'Azul', 1]);
  await quests(MIA);
  assert.equal(questStamps(MIA)[`weekly:riddle:${WEEK}`], 1, 'their stamp stays');
  // playing here needs no library plan, and is counted once a game an hour
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM quest_facts WHERE kind = 'play' AND customer_id = ?", MIA).one().n, 5);
});

// Round 44 (round 42's review): a riddle's answer is the game, not the code typed for it. A change that leaves the answer's
// box as it was (the form sends the riddle's own code, or none) keeps its answer without looking the code up again, so
// its words can still change after the box is relabelled, its old label goes on another game, or the game leaves the
// library, and while Shopify can't be asked
test('round 44: a riddle\'s words still change after its answer\'s box is relabelled or leaves the library', async () => {
  lair.saveLibraryGame({ variantId: '9001', productId: '7001', title: 'Azul', handle: 'azul', shelfCode: 'DGL34-M007', image: null }, NOW, ['DGL34-M007']);
  const riddle = ok(await call('POST', 'quests/riddles', { week: WEEK, text: 'Gobgob was hired to tile a palace wall.', code: 'DGL34-M007' }, OWNER)).riddle;
  session(MIA, { start: at(WEEK, 18) });
  nowIs(at(WEEK, 20, 30));
  assert.equal(ok(await call('POST', 'library/scan', { code: 'DGL34-M007', action: 'play' }, MIA)).riddle, true);
  // Azul gets a new label, and its old one goes on Ticket to Ride
  lair.saveLibraryGame({ variantId: '9001', productId: '7001', title: 'Azul', handle: 'azul', shelfCode: 'DGL34-M099', image: null }, NOW, ['DGL34-M099']);
  lair.saveLibraryGame({ variantId: '9003', productId: '7003', title: 'Ticket to Ride', handle: 'ticket-to-ride', shelfCode: 'DGL34-M007', image: null }, NOW, ['DGL34-M007']);
  // the form sends the riddle's own code: its words change, its answer is still Azul, now with Azul's new label
  const reworded = await call('POST', 'quests/riddles', { id: riddle.id, week: WEEK, text: 'Tiles, tiles, tiles.', hint: '', code: 'DGL34-M007' }, OWNER);
  assert.equal(reworded.status, 200, reworded.data.error);
  assert.deepEqual([reworded.data.riddle.text, reworded.data.riddle.answer, reworded.data.riddle.solvedBy],
    ['Tiles, tiles, tiles.', { productId: '7001', title: 'Azul', shelfCode: 'DGL34-M099' }, 1]);
  // a box that is a different game is still a change of answer, so still refused
  const moved = await call('POST', 'quests/riddles', { id: riddle.id, week: WEEK, text: 'Tiles, tiles, tiles.', code: 'DGL34-M007' }, OWNER);
  assert.deepEqual([moved.status, moved.data.error], [409, W.riddleLocked]);
  // Azul leaves the library (the Lair no longer knows its codes, and Shopify can't be asked): its words still change
  lair.sql.exec("DELETE FROM library_codes WHERE variant_id = '9001'");
  const later = await call('POST', 'quests/riddles', { id: riddle.id, week: WEEK, text: 'Blue tiles.', hint: 'Gone now', code: 'DGL34-M099' }, OWNER);
  assert.equal(later.status, 200, later.data.error);
  assert.deepEqual([later.data.riddle.text, later.data.riddle.hint, later.data.riddle.answer.title], ['Blue tiles.', 'Gone now', 'Azul']);
  // no code at all keeps the answer too
  assert.equal(ok(await call('POST', 'quests/riddles', { id: riddle.id, week: WEEK, text: 'Blue tiles!' }, OWNER)).riddle.answer.productId, '7001');
  await quests(MIA);
  assert.equal(questStamps(MIA)[`weekly:riddle:${WEEK}`], 1, 'their stamp stays');
  // an unsolved one too: a seeded riddle's box was never scanned into the Lair, and Shopify can't be asked
  const seeded = ok(await call('GET', 'quests/riddles', null, OWNER)).riddles.find((r) => r.week === '2026-11-30');
  const reseeded = await call('POST', 'quests/riddles', { id: seeded.id, week: seeded.week, text: 'New words.', code: seeded.answer.shelfCode }, OWNER);
  assert.equal(reseeded.status, 200, reseeded.data.error);
  assert.deepEqual([reseeded.data.riddle.text, reseeded.data.riddle.answer], ['New words.', seeded.answer]);
  // but a new box for it is still looked up
  assert.equal((await call('POST', 'quests/riddles', { id: seeded.id, week: seeded.week, text: 'New words.', code: 'DGL99-X' }, OWNER)).status, 503);
});

/* ---------------- one-off and secret quests from sessions ---------------- */

test('one-offs from sessions: the first of each kind of night, 3 systems, 3 GMs, a weekly seat, Four in a row; titles when a chapter\'s done', async () => {
  const g1 = game(GWEN, { system: 'D&D 5e', start: at('2026-11-02', 18) });
  const g2 = game(NOVA, { system: 'Call of Cthulhu', start: at('2026-11-09', 18) });
  const g3 = game(GWEN, { system: 'Blades in the Dark', start: at('2026-11-16', 18) });
  const g4 = game(OWNER, { system: 'Mothership', start: at('2026-11-23', 18) });
  seat(MIA, g1, at('2026-11-02', 18));
  seat(MIA, g2, at('2026-11-09', 18));
  seat(MIA, g3, at('2026-11-16', 18));
  session(MIA, { start: at('2026-11-23', 18), activity: 'wargame', extras: ['wargame'], tables: ['T5', 'T6'], people: 2 });
  sync(MIA);
  const s = questStamps(MIA);
  for (const q of ['first-ttrpg', 'three-systems', 'first-warhammer', 'four-weeks']) assert.equal(s[`once:${q}`], 1, q);
  assert.equal(s['once:three-gms'], undefined, 'Gwen twice and Nova: two GMs');
  seat(MIA, g4, at('2026-11-23', 18));
  sync(MIA);
  assert.equal(questStamps(MIA)['once:three-gms'], 1);
  assert.equal(questStamps(MIA)['once:first-table'], undefined, 'a Warhammer table isn\'t "book your first table"');
  // the weekly seat: four of one weekly game's sessions
  for (const d of ['2026-10-05', '2026-10-12', '2026-10-19']) lair.sql.exec('UPDATE bookings SET series_id = ? WHERE id = ?', 's1', seat(KAI, game(GWEN, { start: at(d, 18) }), at(d, 18)));
  sync(KAI);
  assert.equal(questStamps(KAI)['once:weekly-seat'], undefined);
  lair.sql.exec('UPDATE bookings SET series_id = ? WHERE id = ?', 's1', seat(KAI, game(GWEN, { start: at('2026-10-26', 18) }), at('2026-10-26', 18)));
  sync(KAI);
  assert.equal(questStamps(KAI)['once:weekly-seat'], 1);
  const chapters = (await quests(MIA)).chapters;
  assert.deepEqual(chapters.map((c) => [c.id, c.title]), [['wanderer', null], ['storyteller', null], ['librarian', null], ['regular', null]]);
});

test('secret quests from sessions: Fancy pants, Grand tour (each room), Every day of the week, and a new GM\'s first table', async () => {
  // a new GM's very first session: Mia plays at it; Kai plays at Gwen's second
  const first = game(GWEN, { start: at('2026-11-02', 18) });
  const second = game(GWEN, { start: at('2026-11-09', 18) });
  seat(MIA, first, at('2026-11-02', 18));
  seat(KAI, second, at('2026-11-09', 18));
  sync(MIA);
  sync(KAI);
  assert.equal(questStamps(MIA)['once:first-table-gm'], 1);
  assert.equal(questStamps(KAI)['once:first-table-gm'], undefined);
  // the main, gaming, party and Fancy rooms, over Monday to Sunday
  const days = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'];
  const tables = [['T1'], ['G2'], ['P1'], ['T2'], ['T3'], ['T4']];
  days.forEach((d, i) => session(NOVA, { start: at(d, 18), tables: tables[i] }));
  sync(NOVA);
  assert.equal(questStamps(NOVA)['once:every-day'], undefined, 'six days');
  assert.equal(questStamps(NOVA)['once:grand-tour'], undefined, 'three rooms');
  session(NOVA, { start: at('2026-11-22', 13), tables: ['F1'], people: 4 });
  sync(NOVA);
  const s = questStamps(NOVA);
  for (const q of ['every-day', 'grand-tour', 'fancy-pants']) assert.equal(s[`once:${q}`], 1, q);
  // My Lair: found secrets by name, the rest only counted
  const q = await quests(NOVA);
  assert.deepEqual(q.secrets.found.map((x) => x.id).sort(), ['every-day', 'fancy-pants', 'grand-tour']);
  assert.equal(q.secrets.left, QUEST_LIST.filter((x) => x.layer === 'secret').length - 3);
});

test('GMs: a stamp when a player\'s first TTRPG session is theirs, and another when that player comes back; never on the team\'s time', async () => {
  const g1 = game(GWEN, { start: at('2026-11-02', 18) });
  const g2 = game(GWEN, { start: at('2026-11-09', 18) });
  seat(MIA, g1, at('2026-11-02', 18));
  // Kai played with Nova first, then Gwen: not Gwen's newcomer
  seat(KAI, game(NOVA, { start: at('2026-10-26', 18) }), at('2026-10-26', 18));
  seat(KAI, g1, at('2026-11-02', 18));
  sync(GWEN);
  assert.deepEqual(Object.keys(questStamps(GWEN)).filter((k) => k.startsWith('gm-')), [`gm-new:${MIA}`]);
  seat(MIA, g2, at('2026-11-09', 18));
  sync(GWEN);
  assert.deepEqual(Object.keys(questStamps(GWEN)).filter((k) => k.startsWith('gm-')).sort(), [`gm-back:${MIA}`, `gm-new:${MIA}`]);
  // a game the GM ran while on the team earns them nothing for it
  const staffGame = game(OWNER, { start: at('2026-11-02', 18), staff: true });
  seat(NOVA, staffGame, at('2026-11-02', 18));
  sync(OWNER);
  assert.equal(Object.keys(questStamps(OWNER)).filter((k) => k.startsWith('gm-')).length, 0);
});

test('a session undone takes its quests with it; a quest stamp staff took back by hand stays out', async () => {
  const id = session(MIA, { start: at('2026-11-23', 18) });
  sync(MIA);
  assert.equal(questStamps(MIA)['once:first-table'], 1);
  lair.sql.exec("UPDATE bookings SET status = 'cancelled' WHERE id = ?", id);
  sync(MIA);
  assert.equal(questStamps(MIA)['once:first-table'], undefined);
  lair.sql.exec("UPDATE bookings SET status = 'done' WHERE id = ?", id);
  sync(MIA);
  assert.equal(questStamps(MIA)['once:first-table'], 1, 'back again with its session');
  lair.sql.exec("UPDATE loyalty_stamps SET undone_at = ?, undone_by = 'staff:9001' WHERE customer_id = ? AND key LIKE '%first-table'", NOW, MIA);
  sync(MIA);
  assert.equal(questStamps(MIA)['once:first-table'], undefined);
});

/* ---------------- secret quests from sales, rolls and the library ---------------- */

test('secrets from sales: Fresh blood, Fresh pot, Paint it, Rolled it and Last one out (paid after 11:30pm, never said)', async () => {
  // a paint handle isn't paint; a pot is
  ok(await paid(order(1001, [line(1, 302, 27, 1), line(2, 402, 60, 1)])));
  assert.equal(count(MIA), 0);
  ok(await paid(order(1002, [line(1, 301, 7.8, 1), line(2, 401, 70, 1), line(3, 501, 15, 1, { sku: 'LAIR-PAINT-SESSION' })], { pos: true })));
  const s = questStamps(MIA);
  for (const q of ['fresh-pot', 'fresh-blood', 'first-paint']) assert.equal(s[`once:${q}`], 1, q);
  assert.equal(s['once:last-one-out'], undefined);
  // the d20 picker landed on Azul for Kai; Kai buys it within 7 days
  ok(await call('POST', 'pick/rolled', { productId: '402' }, KAI));
  nowIs(NOW + 3 * DAY);
  ok(await paid(order(1003, [line(1, 402, 60, 1)], { customer: KAI })));
  assert.equal(questStamps(KAI)['once:rolled-it'], 1);
  // 11:45pm at the counter
  nowIs(at('2026-11-28', 23, 45));
  ok(await paid(order(1004, [line(1, 202, 3, 1)], { customer: KAI, pos: true })));
  assert.equal(questStamps(KAI)['once:last-one-out'], 1);
  const found = (await quests(KAI)).secrets.found.find((x) => x.id === 'last-one-out');
  assert.equal(found.how, 'Found it.');
  // online at 11:50pm isn't the counter
  nowIs(at('2026-11-28', 23, 50));
  ok(await paid(order(1005, [line(1, 202, 3, 1)], { customer: NOVA })));
  assert.equal(questStamps(NOVA)['once:last-one-out'], undefined);
});

test('secrets from loyalty rolls (Natural 20 and Natural 1) and the library: Take one home, Shelf of ten, Shelf diver, Hoarder (10 stamps)', async () => {
  lair.sql.exec("INSERT INTO member_rolls (id, customer_id, kind, day, roll, created_at, pick) VALUES ('r1', ?, 'loyalty', ?, 20, ?, 'roll')", MIA, TODAY, NOW);
  lair.sql.exec("INSERT INTO member_rolls (id, customer_id, kind, day, roll, created_at, pick) VALUES ('r2', ?, 'loyalty', ?, 1, ?, 'roll')", KAI, TODAY, NOW);
  // a sure $10 isn't a roll of anything
  lair.sql.exec("INSERT INTO member_rolls (id, customer_id, kind, day, roll, created_at, pick) VALUES ('r3', ?, 'loyalty', ?, 20, ?, 'sure')", NOVA, TODAY, NOW);
  sync(MIA);
  sync(KAI);
  sync(NOVA);
  assert.equal(questStamps(MIA)['once:nat-20'], 1);
  assert.equal(questStamps(KAI)['once:nat-1'], 1);
  assert.equal(questStamps(NOVA)['once:nat-20'], undefined);
  // 100 different games picked up: one borrowed, the rest scanned to play here on 20 days in the Lair, 5 a day
  lair.sql.exec("INSERT INTO library_loans (id, variant_id, product_id, title, customer_id, status, out_at, created_at) VALUES ('ln1', 'v0', '8000', 'Game 0', ?, 'out', ?, ?)", MIA, at('2026-10-05', 18), at('2026-10-05', 18));
  const play = (who, n, day, hh = 19) => {
    const when = at(day, hh) + n * MIN;
    lair.questFact({ key: `play:${who}:v${n}:${day}:${hh}`, customerId: who, kind: 'play', productId: String(8000 + n), variantId: `v${n}`, day, at: when }, NOW);
  };
  let n = 1;
  for (let d = 0; d < 19; d += 1) {
    const day = time.key(at('2026-10-06', 12) + d * DAY);
    session(MIA, { start: at(day, 18) });
    for (let k = 0; k < 5; k += 1) play(MIA, n++, day);
    // a sixth game that day doesn't count
    play(MIA, 900 + d, day, 20);
  }
  sync(MIA);
  let s = questStamps(MIA);
  for (const q of ['first-borrow', 'ten-games', 'shelf-diver']) assert.equal(s[`once:${q}`], 1, q);
  assert.equal(s['once:hoarder'], undefined, '96 games: 1 borrowed and 5 a day for 19 days');
  // more codes typed at home on a day they weren't in: nothing
  for (let k = 0; k < 5; k += 1) play(MIA, n++, '2026-11-24');
  sync(MIA);
  assert.equal(questStamps(MIA)['once:hoarder'], undefined);
  // that evening they come in: the day counts, and that's 101
  session(MIA, { start: at('2026-11-24', 18) });
  sync(MIA);
  s = questStamps(MIA);
  assert.equal(s['once:hoarder'], 10);
});

test('the library (Mo: "every month they renew and once they join too"): joining and each renewal paid', async () => {
  lair.sql.exec(
    `INSERT INTO memberships (id, contract_gid, customer_id, status, tier, billing_tier, created_at) VALUES ('m1', 'gid://shopify/SubscriptionContract/1', ?, 'active', 'grab', 'grab', ?)`,
    MIA, at('2026-10-20', 12),
  );
  for (const [id, status] of [['c1', 'paid'], ['c2', 'paid'], ['c3', 'failed']]) {
    lair.sql.exec(
      `INSERT INTO membership_charges (id, membership_id, cycle, attempt, idempotency_key, kind, status, amount, created_at, completed_at) VALUES (?, 'm1', ?, 1, ?, 'renewal', ?, 3000, ?, ?)`,
      id, Number(id.slice(1)), `k${id}`, status, NOW, NOW,
    );
  }
  lair.sql.exec(`INSERT INTO membership_charges (id, membership_id, cycle, attempt, idempotency_key, kind, status, amount, created_at, completed_at) VALUES ('c4', 'm1', 9, 1, 'kc4', 'fees', 'paid', 2000, ?, ?)`, NOW, NOW);
  sync(MIA);
  assert.equal(Object.keys(questStamps(MIA)).filter((k) => k.startsWith('library:')).length, 3, 'joining, and two renewals paid; a failed one and a damage bill don\'t count');
});

/* ---------------- the counter ---------------- */

test('Show your face: their Goblin card scanned at the counter, once', async () => {
  const code = lair.memberRow(MIA).code;
  ok(await internal('pos/scan', { code }));
  ok(await internal('pos/scan', { code }));
  assert.deepEqual(questStamps(MIA), { 'once:first-scan': 1 });
  // and it never makes them a returning player at the counter on their first day
  const again = ok(await internal('pos/scan', { code }));
  assert.equal(again.newHere, true);
});

/* ---------------- bring a friend ---------------- */

test('bring a friend: a code each, only for someone new, once, never their own; a stamp each once the friend\'s first paid session stamps', async () => {
  const mine = (await quests(MIA)).invite.code;
  assert.match(mine, /^FRIEND-/);
  assert.equal((await quests(MIA)).invite.code, mine, 'the same code each time');
  // their own
  assert.equal((await call('POST', 'me/codes/redeem', { code: mine }, MIA)).data.error, W.inviteOwn);
  // Kai has played before: not new
  session(KAI, { start: at('2026-11-20', 18) });
  assert.equal((await call('POST', 'me/codes/redeem', { code: mine.toLowerCase() }, KAI)).data.error, W.inviteNotNew);
  // Nova is new
  const used = ok(await call('POST', 'me/codes/redeem', { code: mine.replace('-', ' ') }, NOVA));
  assert.deepEqual([used.kind, used.message], ['invite', W.inviteDone('Mia')]);
  assert.equal((await call('POST', 'me/codes/redeem', { code: mine }, NOVA)).data.error, W.inviteOnce);
  assert.equal(count(NOVA), 0, 'nothing until they\'ve played and paid');
  session(NOVA, { start: at(TODAY, 12), phone: '022 777 0102' });
  sync(NOVA);
  sync(MIA);
  assert.equal(questStamps(NOVA)['invite-friend'], 1);
  assert.equal(questStamps(MIA)[`invite-bring:${NOVA}`], 1);
  assert.equal((await quests(MIA)).invite.brought, 1);
});

test('bring a friend: two new players can\'t swap codes and be each other\'s friend (the review)', async () => {
  const mias = (await quests(MIA)).invite.code;
  const novas = (await quests(NOVA)).invite.code;
  ok(await call('POST', 'me/codes/redeem', { code: mias }, NOVA));
  const back = await call('POST', 'me/codes/redeem', { code: novas }, MIA);
  assert.deepEqual([back.status, back.data.error], [409, W.inviteBack]);
});

test('bring a friend: someone "bringing" themselves (the same mobile number on their bookings) earns nothing', async () => {
  const code = (await quests(MIA)).invite.code;
  session(MIA, { start: at('2026-11-20', 18), phone: '021 555 0101' });
  ok(await call('POST', 'me/codes/redeem', { code }, NOVA));
  session(NOVA, { start: at(TODAY, 12), phone: '+64 21 555 0101' });
  sync(NOVA);
  sync(MIA);
  assert.equal(questStamps(NOVA)['invite-friend'], undefined);
  assert.equal(questStamps(MIA)[`invite-bring:${NOVA}`], undefined);
  assert.equal((await quests(MIA)).invite.notCounted, 1);
});

/* ---------------- My Lair ---------------- */

test('GET /me/quests: the day, the week, this week\'s three, the chapters and their quests, the secrets left, and the quest stamps on the card', async () => {
  const q = await quests(MIA);
  assert.equal(q.day, TODAY);
  assert.deepEqual(q.week, { key: WEEK, from: at(WEEK, 0), to: at('2026-11-30', 0) });
  assert.equal(q.weekly.length, 3);
  assert.deepEqual(q.chapters.map((c) => c.quests.length), [6, 4, 2, 4]);
  assert.equal(q.chapters[3].quests.find((x) => x.id === 'discord').on, false);
  assert.equal(q.secrets.found.length, 0);
  assert.equal(q.stamps, 0);
  assert.equal(q.loyalty.stamps, 0);
  assert.equal((await call('GET', 'me/quests', null, '')).status, 401);
  // a week nobody had made yet gets its own golden bounty and two weekly quests, kept from then on
  nowIs(at('2026-12-02', 14));
  const next = await quests(MIA);
  const row = lair.sql.exec("SELECT * FROM quest_weeks WHERE week = '2026-11-30'").one();
  assert.equal(JSON.parse(row.weeklies).length, 2);
  assert.ok(row.golden_day >= '2026-11-30' && row.golden_day <= '2026-12-06');
  assert.deepEqual(next.weekly.map((w) => w.id), ['riddle', ...JSON.parse(row.weeklies)]);
  // the seeded riddle for that week is out
  assert.equal(next.riddle.out, true);
  assert.equal(next.riddle.text, SEED_RIDDLES[0].text);
  assert.equal(weekOf('2026-12-06'), '2026-11-30');
});

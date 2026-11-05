// Round 30 (6 Nov 2026, contract v30-library): two library rules from Mo, 2 Nov 2026.
//  1. Board Game Night is free for library members: "library members (an active Lair library membership, Grab, Stash or
//     Hoard) get in free; everyone else pays the usual $10 at the counter." The lair_event field member_free ("Free for
//     library members") marks an event so. A membership whose last payment failed (borrowing paused) doesn't get in free.
//  2. Some library games "cannot even be borrowed only played in store": tagged In Store Only in Shopify (Mechs vs.
//     Minions and Firefly: The Game), they never go home: not by a member's scan, not lent by staff, not posted, and a
//     hold on one is collected for a table without a loan.
// Run with: node --test test/
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, eventOccurrences, findOccurrence, inStoreTagged, rulesFromSettings } from '../src/core.js';
import { ShopifyAdmin } from '../src/shopify.js';
import { IN_STORE_WORDS, LIBRARY_ENTRY_WORDS } from '../src/library-rules.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Wednesday 11 November 2026, 5:45pm in Auckland (NZDT): the first Board Game Night starts at 6pm
const NOW = at('2026-11-11', 17, 45);
const realNow = Date.now;
let clock = NOW;

/* ---------------- helpers (as test/round9-community.test.js and test/round16-lending.test.js) ---------------- */
function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      // as SQLite in a Durable Object: at most 100 bound values a query (27 Oct 2026) and 5 terms in a compound SELECT
      // (29 Oct 2026), Cloudflare's limits (test/cloudflare-sql.js)
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
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) }, waitUntil: () => {} };
}

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 21, seats: 4, order: 1 }];
const HOURS = 'Mon 16:00-24:00\nTue 16:00-24:00\nWed 16:00-24:00\nThu 16:00-24:00\nFri 16:00-24:00\nSat 10:00-24:00\nSun 10:00-22:00';
// Board Game Night as it is in Shopify: monthly, the second Wednesday from 11 Nov 2026, 6pm to 11pm, $10 in store, no
// capacity (people tap I'm coming), free for library members
const BGN = {
  id: 'board-game-night', title: 'Board Game Night', start: at('2026-11-11', 18), end: at('2026-11-11', 23), repeat: 'monthly', tables: 'T4-T9',
  entryFee: 1000, payment: 'store', memberFree: true, game: 'Board games', type: 'social',
};
// the same night: a $10 card night that isn't members-free, and a free one
const POKE = { id: 'pokemon-league', title: 'Pokémon league', start: at('2026-11-11', 18), end: at('2026-11-11', 21), tables: '', entryFee: 1000, type: 'tcg' };
const MAGIC = { id: 'commander-night', title: 'Commander night', start: at('2026-11-11', 18), end: at('2026-11-11', 22), tables: '', type: 'tcg' };
// Saturday: a members-free event that takes sign-ups (Board Game Night doesn't), and one that isn't members-free
const SOCIAL = { id: 'library-social', title: 'Library social', start: at('2026-11-14', 14), end: at('2026-11-14', 17), tables: '', capacity: 20, entryFee: 1000, memberFree: true, type: 'social' };
const QUIZ = { id: 'quiz-night', title: 'Quiz night', start: at('2026-11-14', 18), end: at('2026-11-14', 21), tables: '', capacity: 20, entryFee: 1000, type: 'social' };
const EVENTS = [BGN, POKE, MAGIC, SOCIAL, QUIZ];
const BGN_TODAY = 'board-game-night@2026-11-11';
const POKE_TODAY = 'pokemon-league@2026-11-11';
const MAGIC_TODAY = 'commander-night@2026-11-11';
const SOCIAL_DAY = 'library-social@2026-11-14';
const QUIZ_DAY = 'quiz-night@2026-11-14';
const MOBILE = '021 555 0100';

const SAM = '1001'; // a library member: Grab, active
const KIRI = '1002';
const TAMA = '1003';
const LEO = '1004'; // never a library member
const ARI = '1005';
const MIA = '1006';
const NIKAU = '1007';
const NAMES = { [SAM]: 'Sam Jones', [KIRI]: 'Kiri Smith', [TAMA]: 'Tama Rewiti', [LEO]: 'Leo Tane', [ARI]: 'Ari Moana', [MIA]: 'Mia Rua', [NIKAU]: 'Nikau Hohaia' };

let lair;
async function call(method, path, body, customer = '', extraHeaders = {}) {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: response.status, data: await response.json() };
}
const internal = (path, body) => call('POST', `internal/${path}`, body, '', { 'X-Lair-Internal': '1' });
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const me = async (who) => (await call('GET', 'me', null, who)).data;
const walk = (occurrence, code) => call('POST', `events/${occurrence}/attend`, { code }, 'staff');
const signUp = (occurrence, who, body = {}) => call('POST', `events/${occurrence}/join`, {
  name: NAMES[who], email: `${NAMES[who].split(' ')[0].toLowerCase()}@example.com`, phone: MOBILE, people: 1, ...body,
}, who);
const useRules = (events = EVENTS) => {
  lair.rulesCache = rulesFromSettings({ lair_hours: HOURS, lair_shop_tables: '' }, ROOMS, events);
  lair.rulesLoadedAt = NOW + 365 * DAY;
};

/** Everyone, by GET /me with their names (so each has a member code). Returns their codes. */
async function members() {
  const codes = {};
  for (const [id, name] of Object.entries(NAMES)) {
    codes[id] = (await call('GET', `me?name=${encodeURIComponent(name)}`, null, id)).data.member.code;
    lair.write('UPDATE members SET email = ? WHERE customer_id = ?', `${name.split(' ')[0].toLowerCase()}@example.com`, id);
  }
  return codes;
}

/** A Lair library membership as the memberships table keeps it (src/memberships.js). Returns its id. */
let contracts = 0;
function membership(customerId, status, { tier = 'grab', cancelAt = null } = {}) {
  contracts += 1;
  const id = `ms${contracts}`;
  lair.sql.exec(
    'INSERT INTO memberships (id, contract_gid, customer_id, status, tier, billing_tier, cancel_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, `gid://shopify/SubscriptionContract/${contracts}`, customerId, status, tier, tier, cancelAt, NOW - 30 * DAY,
  );
  return id;
}

beforeEach(() => {
  clock = NOW;
  Date.now = () => clock;
  // Simplee's tags are switched off (MEMBERSHIPS_SIMPLEE_TAGS = off since 9 Oct): a library member is a Lair membership
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'ep0qiq-rp.myshopify.com', MEMBERSHIPS_SIMPLEE_TAGS: 'off' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: false, tags: [] });
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  useRules();
});
afterEach(() => {
  Date.now = realNow;
});

/* ================ 1. Free for library members ================ */

test('Board Game Night is marked "Free for library members": member_free is read from Shopify into the event and every date of it', async () => {
  const admin = new ShopifyAdmin({ SHOP: 'shop.test', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret' }, null);
  const field = (key, value) => ({ key, value });
  const live = { publishable: { status: 'ACTIVE' } };
  admin.graphql = async () => ({
    rooms: { nodes: [] },
    events: {
      nodes: [
        {
          handle: 'board-game-night', capabilities: live,
          fields: [
            field('title', 'Board Game Night'), field('starts_at', '2026-11-11T18:00:00+13:00'), field('ends_at', '2026-11-11T23:00:00+13:00'), field('repeat', 'monthly'),
            field('entry_fee', '10.0'), field('payment', 'In store'), field('lock_tables', 'false'), field('member_free', 'true'),
          ],
        },
        { handle: 'pokemon-league', capabilities: live, fields: [field('title', 'Pokémon league'), field('starts_at', '2026-11-11T18:00:00+13:00'), field('entry_fee', '10.0'), field('member_free', 'false')] },
        { handle: 'commander-night', capabilities: live, fields: [field('title', 'Commander night'), field('starts_at', '2026-11-11T18:00:00+13:00')] },
      ],
    },
    main: { nodes: [] },
    shop: { name: 'Dice Goblin', shopAddress: {} },
  });
  const data = await admin.loadLairData();
  assert.deepEqual(data.events.map((e) => [e.id, e.memberFree, e.entryFee]), [['board-game-night', true, 1000], ['pokemon-league', false, 1000], ['commander-night', false, 0]]);
  // every date of it (monthly: the second Wednesday, 11 Nov then 9 Dec) says so
  const rules = rulesFromSettings({}, ROOMS, data.events);
  const dates = eventOccurrences(rules, at('2026-11-01', 0), at('2027-01-01', 0)).filter((o) => o.eventId === 'board-game-night');
  assert.deepEqual(dates.map((o) => [o.id, o.memberFree, o.entryFee]), [['board-game-night@2026-11-11', true, 1000], ['board-game-night@2026-12-09', true, 1000]]);
  assert.equal(findOccurrence(rules, 'pokemon-league@2026-11-11').memberFree, false);
  // the events editor reads an entry the same way
  assert.equal(lair.eventRule('board-game-night', { title: 'Board Game Night', starts_at: '2026-11-11T18:00:00+13:00', member_free: 'true' }).memberFree, true);
  assert.equal(lair.eventRule('quiz', { title: 'Quiz', starts_at: '2026-11-11T18:00:00+13:00' }).memberFree, false);
});

/** lair_event entries in a stand-in Shopify (as test/round22-holds.test.js): the editor's reads and writes, and the rules */
function eventsInShopify(entries) {
  const nodes = new Map();
  let n = 1;
  for (const [handle, fields] of entries) {
    nodes.set(handle, { id: `gid://shopify/Metaobject/${n}`, handle, updatedAt: new Date(NOW).toISOString(), fields: { ...fields } });
    n += 1;
  }
  const writes = [];
  const node = (x) => ({ id: x.id, handle: x.handle, updatedAt: x.updatedAt, fields: Object.entries(x.fields).map(([key, value]) => ({ key, type: 'single_line_text_field', value })) });
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  lair.shopify.lairEventsAdmin = async () => [...nodes.values()].map(node);
  lair.shopify.lairEventByHandle = async (handle) => (nodes.has(handle) ? node(nodes.get(handle)) : null);
  lair.shopify.createLairEvent = async (handle, fields) => {
    writes.push({ handle, fields: Object.fromEntries(fields.map((f) => [f.key, f.value])) });
    const x = { id: `gid://shopify/Metaobject/${n}`, handle, updatedAt: new Date(Date.now()).toISOString(), fields: Object.fromEntries(fields.map((f) => [f.key, f.value === '' ? null : f.value])) };
    n += 1;
    nodes.set(handle, x);
    return { metaobject: node(x), userErrors: [] };
  };
  lair.shopify.updateLairEvent = async (id, fields) => {
    const x = [...nodes.values()].find((v) => v.id === id);
    writes.push({ handle: x.handle, fields: Object.fromEntries(fields.map((f) => [f.key, f.value])) });
    for (const { key, value } of fields) x.fields[key] = value === '' ? null : value;
    return { metaobject: node(x), userErrors: [] };
  };
  lair.shopify.loadLairData = async () => ({
    rooms: ROOMS, events: [...nodes.values()].map((x) => lair.eventRule(x.handle, x.fields, x.id)), theme: null, shop: {},
    settingsText: JSON.stringify({ current: { lair_hours: HOURS, lair_shop_tables: '' } }),
  });
  lair.rulesLoadedAt = 0;
  return { nodes, writes };
}
// Board Game Night's entry as Shopify has it (2 Nov 2026)
const BGN_FIELDS = {
  title: 'Board Game Night', event_type: 'social', starts_at: '2026-11-11T18:00:00+13:00', ends_at: '2026-11-11T23:00:00+13:00', repeat: 'monthly',
  price_note: 'Library members free, everyone else $10', tables: 'T4-T9', entry_fee: '10.0', lock_tables: 'false', payment: 'In store', game: 'Board games',
  member_free: 'true',
};

test('the staff Events tab sees "Free for library members" (memberFree) and changes it: written as member_free true or false, only when it changes, and walk-ins follow at once', async () => {
  const codes = await members();
  membership(SAM, 'active');
  membership(KIRI, 'active');
  const { nodes, writes } = eventsInShopify([['board-game-night', BGN_FIELDS]]);
  // GET /events: the editor's view and the event as the calendar's config has it
  const list = await call('GET', 'events', null, 'staff');
  assert.equal(list.status, 200, said(list));
  const [bgn] = list.data.events;
  assert.deepEqual([bgn.handle, bgn.memberFree, bgn.config.memberFree, bgn.entryFee, bgn.lockTables], ['board-game-night', true, true, 1000, false]);
  // the same again: nothing goes to Shopify
  const same = await call('POST', 'events/board-game-night/update', { memberFree: true }, 'staff');
  assert.deepEqual([same.status, writes.length, same.data.event.memberFree], [200, 0, true]);
  // switched off: member_free 'false', and a library member walking in pays
  const off = await call('POST', 'events/board-game-night/update', { memberFree: false }, 'staff');
  assert.equal(off.status, 200, said(off));
  assert.deepEqual([writes.at(-1).fields, off.data.event.memberFree, off.data.event.config.memberFree], [{ member_free: 'false' }, false, false]);
  assert.equal((await walk(BGN_TODAY, codes[SAM])).data.message, 'Walk-in added and checked in: Sam Jones for Board Game Night. Charge $10.');
  // back on (the page may send it as text): member_free 'true', and the next member walks in free
  const on = await call('POST', 'events/board-game-night/update', { memberFree: 'true' }, 'staff');
  assert.deepEqual([writes.at(-1).fields, on.data.event.memberFree], [{ member_free: 'true' }, true]);
  assert.equal((await walk(BGN_TODAY, codes[KIRI])).data.message, 'Walk-in added and checked in: Kiri Smith for Board Game Night. Library member: free entry.');
  // a new event: written with the rest of its fields
  const made = await call('POST', 'events', { title: 'Library games afternoon', type: 'social', start: at('2026-11-21', 14), end: at('2026-11-21', 17), entryFee: 10, payment: 'store', memberFree: true }, 'staff');
  assert.equal(made.status, 200, said(made));
  assert.deepEqual([writes.at(-1).handle, writes.at(-1).fields.member_free, writes.at(-1).fields.entry_fee, made.data.event.memberFree], ['library-games-afternoon', 'true', '10.00', true]);
  // one sent without it says nothing about it (empty is not free, as the calendar reads it)
  const plain = await call('POST', 'events', { title: 'Paint night', type: 'social', start: at('2026-11-22', 14), payment: 'store' }, 'staff');
  assert.deepEqual([Object.hasOwn(writes.at(-1).fields, 'member_free'), plain.data.event.memberFree], [false, false]);
  assert.equal(nodes.get('board-game-night').fields.member_free, 'true');
});

test('a library member walks in to a members-free event: entry is free', async () => {
  const codes = await members();
  membership(SAM, 'active');
  const res = await walk(BGN_TODAY, codes[SAM]);
  assert.equal(res.status, 200, said(res));
  assert.equal(res.data.message, 'Walk-in added and checked in: Sam Jones for Board Game Night. Library member: free entry.');
  const j = res.data.join;
  assert.deepEqual([j.status, j.source, j.people, j.amount, j.due, j.memberFree, res.data.row.due, res.data.row.memberFree], ['attended', 'walk-in', 1, 0, 0, true, 0, true]);
  assert.equal(LIBRARY_ENTRY_WORDS.free, 'Library member: free entry.');
  // any plan (Hoard too), and a membership cancelled but still inside the month they paid for
  membership(NIKAU, 'active', { tier: 'hoard' });
  membership(TAMA, 'cancelling', { tier: 'stash', cancelAt: NOW + 10 * DAY });
  assert.equal((await walk(BGN_TODAY, codes[NIKAU])).data.join.amount, 0);
  assert.equal((await walk(BGN_TODAY, codes[TAMA])).data.message, 'Walk-in added and checked in: Tama Rewiti for Board Game Night. Library member: free entry.');
});

test('a member whose library payment failed pays the entry fee: borrowing is paused, so entry isn\'t free', async () => {
  const codes = await members();
  membership(KIRI, 'past_due', { tier: 'stash' });
  const res = await walk(BGN_TODAY, codes[KIRI]);
  assert.equal(res.status, 200, said(res));
  assert.equal(res.data.message, "Walk-in added and checked in: Kiri Smith for Board Game Night. Charge $10. Their last library payment didn't go through, so entry isn't free today.");
  assert.deepEqual([res.data.join.amount, res.data.join.due, Boolean(res.data.join.memberFree)], [1000, 1000, false]);
  // and while their bank wants them to confirm the payment (Shopify's bank check)
  const mia = membership(MIA, 'past_due');
  lair.sql.exec(
    "INSERT INTO membership_charges (id, membership_id, cycle, attempt, idempotency_key, kind, status, amount, created_at) VALUES ('mc1', ?, 2, 1, 'mia-2-1', 'cycle', 'challenged', 3000, ?)",
    mia, NOW,
  );
  const bank = await walk(BGN_TODAY, codes[MIA]);
  assert.equal(bank.data.message, "Walk-in added and checked in: Mia Rua for Board Game Night. Charge $10. Their last library payment is waiting on their bank's check, so entry isn't free today.");
  assert.equal(bank.data.join.amount, 1000);
});

test('a non-member walk-in pays the entry fee at a members-free event, and a membership that has ended is no membership', async () => {
  const codes = await members();
  membership(ARI, 'ended');
  const leo = await walk(BGN_TODAY, codes[LEO]);
  assert.equal(leo.status, 200, said(leo));
  assert.equal(leo.data.message, 'Walk-in added and checked in: Leo Tane for Board Game Night. Charge $10.');
  assert.deepEqual([leo.data.join.amount, leo.data.join.due], [1000, 1000]);
  assert.equal((await walk(BGN_TODAY, codes[ARI])).data.message, 'Walk-in added and checked in: Ari Moana for Board Game Night. Charge $10.');
});

test('at an event that isn\'t free for library members, a library member pays as usual, and a free event stays free', async () => {
  const codes = await members();
  membership(SAM, 'active');
  const poke = await walk(POKE_TODAY, codes[SAM]);
  assert.equal(poke.data.message, 'Walk-in added and checked in: Sam Jones for Pokémon league. Charge $10.');
  assert.deepEqual([poke.data.join.amount, Boolean(poke.data.join.memberFree)], [1000, false]);
  const magic = await walk(MAGIC_TODAY, codes[SAM]);
  assert.equal(magic.data.message, 'Walk-in added and checked in: Sam Jones for Commander night.');
  assert.deepEqual([magic.data.join.amount, Boolean(magic.data.join.memberFree)], [0, false]);
});

test("a library member's free entry is nothing to pay: the counter puts nothing in the cart for it, My Lair has nothing due, and it's never owed", async () => {
  const codes = await members();
  membership(SAM, 'active');
  const res = await walk(BGN_TODAY, codes[SAM]);
  const id = res.data.join.id;
  // the counter: their code scanned, then Add everything to cart
  const scan = await internal('pos/scan', { code: codes[SAM] });
  assert.equal(scan.status, 200, said(scan));
  assert.deepEqual(scan.data.rows.filter((r) => r.id === id).map((r) => [r.amount, r.due, r.status]), [[0, 0, 'attended']]);
  const counter = await internal('pos/checkin-member', { customerId: SAM });
  assert.equal(counter.status, 200, said(counter));
  assert.deepEqual(counter.data.lines, []);
  // My Lair: on their list, free, with nothing to pay at the counter
  const mine = await me(SAM);
  assert.deepEqual(mine.dueNow, []);
  assert.deepEqual(mine.joins.filter((x) => x.id === id).map((x) => [x.amount, x.due, x.memberFree]), [[0, 0, true]]);
  // the day after: nothing owed
  clock = at('2026-11-12', 12);
  assert.deepEqual((await me(SAM)).dueNow, []);
  assert.deepEqual(lair.owedRows(SAM, lair.rulesCache, clock), []);
});

test("a library member's free entry stamps their loyalty card the way a free event's walk-in does (the stamping rules don't change)", async () => {
  const codes = await members();
  membership(SAM, 'active');
  assert.equal(lair.loyaltyOf(SAM).stamps, 0);
  await walk(BGN_TODAY, codes[SAM]); // $0: a library member at Board Game Night
  await walk(MAGIC_TODAY, codes[LEO]); // $0: a card night with no fee
  await walk(BGN_TODAY, codes[ARI]); // $10, not paid yet: checked in, so it stamps too
  assert.deepEqual([SAM, LEO, ARI].map((id) => lair.loyaltyOf(id).stamps), [1, 1, 1]);
  // and as a free session it isn't a first paid session (round 24's welcome codes wait for one), like the card night
  assert.deepEqual([SAM, LEO].map((id) => lair.paidSession(id, lair.stampTally(id).sessions, clock)), [false, false]);
});

test("signing up for a members-free event: a library member's own place is free and guests added by name pay; a non-member, or a member whose payment failed, pays for every place", async () => {
  const codes = await members();
  membership(SAM, 'active');
  membership(KIRI, 'past_due');
  membership(NIKAU, 'active', { tier: 'stash' });
  const sam = await signUp(SOCIAL_DAY, SAM, { guests: [{ name: 'Mia' }, { name: 'Jo' }] });
  assert.equal(sam.status, 200, said(sam));
  assert.deepEqual([sam.data.join.people, sam.data.join.amount, sam.data.join.due, sam.data.join.memberFree], [3, 2000, 2000, true]);
  const nikau = await signUp(SOCIAL_DAY, NIKAU);
  assert.deepEqual([nikau.data.join.amount, nikau.data.join.due, nikau.data.join.memberFree], [0, 0, true]);
  const leo = await signUp(SOCIAL_DAY, LEO, { people: 2 });
  assert.deepEqual([leo.data.join.amount, Boolean(leo.data.join.memberFree)], [2000, false]);
  const kiri = await signUp(SOCIAL_DAY, KIRI);
  assert.deepEqual([kiri.data.join.amount, Boolean(kiri.data.join.memberFree)], [1000, false]);
  // an event that isn't members-free: everyone pays, members too
  const quiz = await signUp(QUIZ_DAY, SAM, { people: 2 });
  assert.deepEqual([quiz.data.join.amount, Boolean(quiz.data.join.memberFree)], [2000, false]);
  // staff adding someone (the Events tab): the same rule for the account they add
  membership(TAMA, 'active');
  const tama = await call('POST', `events/${SOCIAL_DAY}/joins`, { code: codes[TAMA], people: 2 }, 'staff');
  assert.equal(tama.status, 200, said(tama));
  assert.deepEqual([tama.data.join.amount, tama.data.join.due, tama.data.join.memberFree], [1000, 1000, true]);
  const ari = await call('POST', `events/${SOCIAL_DAY}/joins`, { code: codes[ARI] }, 'staff');
  assert.deepEqual([ari.data.join.amount, Boolean(ari.data.join.memberFree)], [1000, false]);
});

test("checking in a sign-up at a members-free event prices it for who they are that day: joined the library since, it's free; their payment failed since, they pay; something paid already, it stays as it is", async () => {
  const codes = await members();
  const kiriMs = membership(KIRI, 'active');
  const leo = (await signUp(SOCIAL_DAY, LEO)).data.join; // not a member yet: $10
  const kiri = (await signUp(SOCIAL_DAY, KIRI)).data.join; // a member: free
  const ari = (await signUp(SOCIAL_DAY, ARI)).data.join; // not a member yet, and pays ahead at the counter
  const nikau = (await signUp(SOCIAL_DAY, NIKAU, { guests: [{ name: 'Hemi' }] })).data.join; // not a member yet: $20 for two
  const tama = (await signUp(SOCIAL_DAY, TAMA)).data.join; // not a member yet: $10
  assert.deepEqual([leo, kiri, ari, nikau, tama].map((j) => j.amount), [1000, 0, 1000, 2000, 1000]);
  assert.equal((await call('POST', `bookings/${ari.id}/update`, { paid: true }, 'staff')).status, 200);
  // before Saturday: Leo, Ari, Nikau and Tama join the library, and Kiri's card is declined
  for (const id of [LEO, ARI, NIKAU, TAMA]) membership(id, 'active');
  lair.sql.exec("UPDATE memberships SET status = 'past_due' WHERE id = ?", kiriMs);
  clock = at('2026-11-14', 13, 45);
  const now = (j) => lair.joinById(j.id);
  // the till (their code scanned, Add everything to cart): Leo's place is free now, so nothing goes in the cart
  const till = await internal('pos/checkin-member', { customerId: LEO });
  assert.equal(till.status, 200, said(till));
  assert.deepEqual([till.data.lines, till.data.rows.find((r) => r.id === leo.id)?.due], [[], 0]);
  assert.deepEqual([now(leo).amount, now(leo).memberFree, now(leo).status], [0, true, 'attended']);
  // the staff page: Kiri's isn't free any more, and it says why
  const kiriIn = await call('POST', 'checkin', { id: kiri.id, type: 'join' }, 'staff');
  assert.equal(kiriIn.status, 200, said(kiriIn));
  assert.equal(kiriIn.data.message, "Checked in: Kiri Smith, 1 person for Library social. Charge $10.00. Their last library payment didn't go through, so entry isn't free today.");
  assert.deepEqual([now(kiri).amount, Boolean(now(kiri).memberFree), kiriIn.data.row.due], [1000, false, 1000]);
  // Nikau's own place comes off; his guest still pays
  const nikauIn = await call('POST', 'checkin', { id: nikau.id, type: 'join' }, 'staff');
  assert.equal(nikauIn.data.message, "Checked in: Nikau Hohaia, 2 people for Library social. Charge $10.00. Library member: their own entry's free.");
  assert.deepEqual([now(nikau).amount, now(nikau).memberFree], [1000, true]);
  // Ari paid ahead: it stays as it is (staff sort out anything owed back)
  await call('POST', 'checkin', { id: ari.id, type: 'join' }, 'staff');
  assert.deepEqual([now(ari).amount, now(ari).paidAmount, Boolean(now(ari).memberFree)], [1000, 1000, false]);
  // marked here on the staff floor (status attended): the same rule
  const floor = await call('POST', `bookings/${tama.id}/update`, { status: 'attended' }, 'staff');
  assert.equal(floor.status, 200, said(floor));
  assert.deepEqual([floor.data.join.amount, floor.data.join.due, floor.data.join.memberFree], [0, 0, true]);
  // checked in again later: nothing changes
  lair.sql.exec("UPDATE memberships SET status = 'past_due' WHERE customer_id = ?", LEO);
  await call('POST', 'checkin', { id: leo.id, type: 'join' }, 'staff');
  assert.equal(now(leo).amount, 0);
  assert.equal(codes[LEO].length > 0, true);
});

test("a members-free sign-up's reminder two days before says there's nothing to pay, not the event's price", async () => {
  await members();
  membership(SAM, 'active');
  const sam = (await signUp(SOCIAL_DAY, SAM)).data.join;
  const leo = (await signUp(SOCIAL_DAY, LEO)).data.join;
  const rules = lair.rulesCache;
  const o = findOccurrence(rules, SOCIAL_DAY);
  const row = (j) => lair.reminderTabRow({ x: lair.joinById(j.id), type: 'signup', game: null, o }, rules);
  assert.deepEqual(row(sam), ['On your tab', 'Nothing to pay']);
  assert.deepEqual(row(leo), ['On your tab', '$10, paid at the counter on the day']);
});

test("a members-free event's reminder says what's true for everyone (free for library members, $10 for everyone else), and to a library member that it's free for them (the review, 6 Nov 2026)", async () => {
  await members();
  membership(SAM, 'active');
  membership(KIRI, 'past_due');
  // Board Game Night's price note as Shopify has it; a members-free event whose note says something else
  useRules([{ ...BGN, priceNote: 'Library members free, everyone else $10' }, POKE, MAGIC, { ...SOCIAL, priceNote: 'Snacks on the house' }, QUIZ]);
  const rules = lair.rulesCache;
  const occurrence = (id) => findOccurrence(rules, id);
  const eventOf = (id) => rules.events.find((e) => e.id === id.split('@')[0]);
  const line = (id) => lair.eventPriceLine(occurrence(id), eventOf(id));
  // for everyone (the calendar file, the calendar feed, Google Calendar): the note isn't said twice
  assert.equal(line(BGN_TODAY), 'Free for library members, $10 for everyone else, paid at the counter on the day');
  assert.equal(line(SOCIAL_DAY), 'Free for library members, $10 for everyone else, paid at the counter on the day\nSnacks on the house');
  // an event that isn't members-free reads as before
  assert.equal(line(POKE_TODAY), '$10 a person, paid at the counter on the day');
  const ics = await (await lair.eventIcs(BGN_TODAY)).text();
  assert.match(ics.replace(/\r\n /g, ''), /DESCRIPTION:Free for library members\\, \$10 for everyone else\\, paid at the counter on the day/);
  // the reminder email someone asked for ("I'm coming"): a library member who can borrow is told it's free for them;
  // a member whose payment didn't go through, and anyone without an account, get the line for everyone
  const entry = (customerId) => {
    const row = { id: `in-${customerId || 'guest'}`, customer_id: customerId, email: 'someone@example.com', name: 'Someone', level: 'coming', target_id: BGN_TODAY, remove_key: 'k' };
    const letter = lair.reminderLetter(row, occurrence(BGN_TODAY), rules, 'tomorrow');
    const google = new URL(letter.text.match(/https:\/\/calendar\.google\.com\S+/)[0]).searchParams.get('details') || '';
    return [letter.text.match(/^Entry:\s+(.*)$/m)?.[1], google.includes('Free for you as a library member')];
  };
  assert.deepEqual(entry(SAM), ['Free for you as a library member', true]);
  assert.deepEqual(entry(KIRI), ['Free for library members, $10 for everyone else, paid at the counter on the day', false]);
  assert.deepEqual(entry(null), ['Free for library members, $10 for everyone else, paid at the counter on the day', false]);
});

test("a guest who's a library member, added by their member code, gets in free too; a guest added by name, or who isn't a member, pays; at the door each is priced for who they are that day (the review, 6 Nov 2026)", async () => {
  const codes = await members();
  for (const id of [SAM, MIA, KIRI, NIKAU]) membership(id, 'active');
  membership(TAMA, 'past_due');
  // Leo (not a member) brings Sam (a member) and Tama (her payment failed) by code, and Jo by name: Sam's free
  const leo = (await signUp(SOCIAL_DAY, LEO, { guests: [{ code: codes[SAM] }, { code: codes[TAMA] }, { name: 'Jo' }] })).data.join;
  assert.deepEqual([leo.people, leo.amount, Boolean(leo.memberFree), leo.freeGuests], [4, 3000, false, 1]);
  // Mia (a member) brings Kiri (a member): nothing to pay
  const mia = (await signUp(SOCIAL_DAY, MIA, { guests: [{ code: codes[KIRI] }] })).data.join;
  assert.deepEqual([mia.people, mia.amount, mia.due, mia.memberFree, mia.freeGuests], [2, 0, 0, true, 1]);
  // Nikau (a member) brings Ari (not a member) by code: Ari pays
  const nikau = (await signUp(SOCIAL_DAY, NIKAU, { guests: [{ code: codes[ARI] }] })).data.join;
  assert.deepEqual([nikau.amount, nikau.memberFree, nikau.freeGuests], [1000, true, undefined]);
  // staff see who's free on the floor's sign-ups
  const floor = (await call('GET', `floor?from=${at('2026-11-14', 0)}&to=${at('2026-11-15', 0)}`, null, 'staff')).data;
  assert.deepEqual(floor.joins.filter((j) => j.id === leo.id).map((j) => [j.amount, j.freeGuests]), [[3000, 1]]);
  // before Saturday: Tama's payment goes through, Kiri's fails, and Ari's sign-up is waived; then Ari joins the library
  lair.sql.exec("UPDATE memberships SET status = 'active' WHERE customer_id = ?", TAMA);
  lair.sql.exec("UPDATE memberships SET status = 'past_due' WHERE customer_id = ?", KIRI);
  assert.equal((await call('POST', `bookings/${nikau.id}/update`, { waived: true }, 'staff')).status, 200);
  membership(ARI, 'active');
  clock = at('2026-11-14', 13, 45);
  const checkIn = (j) => call('POST', 'checkin', { id: j.id, type: 'join' }, 'staff');
  // Leo's: Sam and Tama both get in free now
  const leoIn = await checkIn(leo);
  assert.equal(leoIn.data.message, 'Checked in: Leo Tane, 4 people for Library social. Charge $20.00. Library members: free entry for 2 of the 4.');
  assert.deepEqual([lair.joinById(leo.id).amount, lair.joinById(leo.id).freeGuests], [2000, 2]);
  // Mia's: Kiri pays now; Mia's own entry is still free
  const miaIn = await checkIn(mia);
  assert.equal(miaIn.data.message, "Checked in: Mia Rua, 2 people for Library social. Charge $10.00. Library member: their own entry's free.");
  assert.deepEqual([lair.joinById(mia.id).amount, lair.joinById(mia.id).freeGuests], [1000, 0]);
  // Nikau's was waived: it stays as it is
  await checkIn(nikau);
  assert.deepEqual([lair.joinById(nikau.id).amount, lair.joinById(nikau.id).freeGuests, lair.joinById(nikau.id).waived], [1000, 0, true]);
  // the words when everyone on it is a library member, and when one guest is (the account holder isn't)
  assert.equal(LIBRARY_ENTRY_WORDS.freeAll(3), 'Library members: free entry for all 3.');
  assert.equal(lair.entryWords({ holder: { free: false, plan: null }, free: 1 }, 2), 'Library member: free entry for 1 of the 2.');
});

test('a library member who is both the account holder and a guest on one sign-up (it joined their account later) gets one free place, not two', async () => {
  const codes = await members();
  membership(SAM, 'active');
  // signed up without an account, with Sam (a member) by code and Jo by name: Sam's place is free
  const made = await call('POST', `events/${SOCIAL_DAY}/join`, { name: 'Sam Jones', email: 'sam@example.com', phone: MOBILE, guests: [{ code: codes[SAM] }, { name: 'Jo' }] }, '');
  assert.equal(made.status, 200, said(made));
  assert.deepEqual([made.data.join.people, made.data.join.amount, made.data.join.freeGuests], [3, 2000, 1]);
  // then it joins Sam's account (he logs in with its email, round 8): he's the account holder and still a guest row
  lair.sql.exec('UPDATE event_joins SET customer_id = ? WHERE id = ?', SAM, made.data.join.id);
  clock = at('2026-11-14', 13, 45);
  const checked = await call('POST', 'checkin', { id: made.data.join.id, type: 'join' }, 'staff');
  assert.equal(checked.data.message, "Checked in: Sam Jones, 3 people for Library social. Charge $20.00. Library member: their own entry's free.");
  assert.deepEqual([lair.joinById(made.data.join.id).amount, lair.joinById(made.data.join.id).memberFree, lair.joinById(made.data.join.id).freeGuests], [2000, true, 0]);
});

/* ================ 2. Games that stay in the Lair ================ */

// The two library games tagged In Store Only on 2 Nov 2026, as Shopify has them, and two that go home
const MVM = {
  productId: '7498140319847', variantId: '42078232346727', code: 'DGL34-L016', title: 'Mechs vs. Minions (League of Legends)', handle: 'mechs-vs-minions',
  tags: ['Adventure', 'Board Game Rental', 'Co-op', 'In Store Only', 'Player Count 4', 'Shelf 3-4 players', 'Strategy'],
};
const FIREFLY = {
  productId: '10258379407463', variantId: '50475429855335', code: 'DGL34-L027', title: 'Firefly: The Game', handle: 'firefly-the-game',
  tags: ['Adventure', 'Board Game Rental', 'In Store Only', 'Player Count 4', 'Shelf 3-4 players', 'Solo', 'Strategy'],
};
const CATAN = { productId: '7000000000011', variantId: '7100000000011', code: 'DGL34-M011', title: 'Catan', handle: 'catan-library', tags: ['Board Game Rental', 'Shelf 3-4 players'] };
const AZUL = { productId: '7000000000004', variantId: '7100000000004', code: 'DGL34-S004', title: 'Azul', handle: 'azul-library', tags: ['Board Game Rental', 'Shelf 3-4 players'] };
const GAMES = [MVM, FIREFLY, CATAN, AZUL];
const tagged = (g) => g.tags.includes('In Store Only');

/** A library listing as the catalogue sync reads it from Shopify (LairPickCatalog) */
const catalogueNode = (g) => ({
  id: `gid://shopify/Product/${g.productId}`, handle: g.handle, title: `${g.title} (Library)`, status: 'ACTIVE', tags: g.tags, vendor: 'Test Games',
  createdAt: new Date(NOW - 400 * DAY).toISOString(), updatedAt: new Date(NOW - DAY).toISOString(), descriptionHtml: `<p>${g.title}</p>`, featuredMedia: null,
  variants: { nodes: [{ id: `gid://shopify/ProductVariant/${g.variantId}`, inventoryQuantity: 1, inventoryItem: { tracked: true } }] },
  libraryCode: { value: g.code }, players: null, playTime: null, difficulty: null, missingPieces: null, missingNote: null, blurb: null, shopCopy: null,
});
/** The catalogue as a sync saves it (src/pick.js saveCatalog) */
const catalogue = (...games) => lair.saveCatalog(games.map(catalogueNode), null, { full: true, now: Date.now() });

/**
 * Shopify connected: library copies found by their codes (LairVariantByCode) and their copies (VariantCopies), one copy
 * each. inStore: what Shopify's answers say about each game's In Store Only tag now (by variant ID): true or false, or
 * left out for an answer that says nothing about tags.
 */
let inStore;
function library({ tags = true } = {}) {
  inStore = new Map(tags ? GAMES.map((g) => [g.variantId, tagged(g)]) : []);
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  lair.shopify.variantByCode = async (code) => GAMES.filter((g) => g.code === String(code).toUpperCase()).map((g) => ({
    variantId: g.variantId, productId: g.productId, handle: g.handle, title: 'Default Title', productTitle: `${g.title} (Library)`, sku: g.code, barcode: '',
    price: 0, available: true, image: null, productImage: null, status: 'ACTIVE', giftCard: false, sellingPlan: false, libraryCode: g.code,
    ...(inStore.has(g.variantId) ? { inStoreOnly: inStore.get(g.variantId) } : {}),
  }));
  lair.shopify.variantCopies = async (ids) => new Map(ids.map((id) => [id, { quantity: 1, tracked: true, ...(inStore.has(id) ? { inStoreOnly: inStore.get(id) } : {}) }]));
  lair.shopify.customerEmail = async () => null;
  lair.shopify.giftCodeUse = async () => null;
}
const scan = (code, who) => call('POST', 'library/scan', { code }, who);
const lend = (body) => call('POST', 'library/loans', body, 'staff');
const hold = (g, who) => call('POST', 'library/holds', { variantId: g.variantId, productId: g.productId, title: g.title, shelfCode: g.code, handle: g.handle }, who);
const loans = () => lair.sql.exec('SELECT COUNT(*) AS n FROM library_loans').one().n;

test("an in-store-only game can't be borrowed by scanning: the catalogue's In Store Only tag keeps Mechs vs. Minions and Firefly in the Lair", async () => {
  await members();
  membership(SAM, 'active', { tier: 'stash' });
  library({ tags: false }); // Shopify's answers say nothing about tags here: the catalogue (synced from Shopify) does
  catalogue(MVM, FIREFLY, CATAN);
  assert.deepEqual(lair.sql.exec('SELECT product_id, in_store_only FROM pick_catalog ORDER BY title').toArray().map((r) => [r.product_id, r.in_store_only]), [
    [CATAN.productId, 0], [FIREFLY.productId, 1], [MVM.productId, 1],
  ]);
  const mvm = await scan(MVM.code, SAM);
  assert.deepEqual([mvm.status, mvm.data.error], [422, "Mechs vs. Minions (League of Legends) stays in the Lair, so it can't go home. Play it at your table instead."]);
  const firefly = await scan('dgl34-l027', SAM);
  assert.deepEqual([firefly.status, firefly.data.error], [422, IN_STORE_WORDS.scan('Firefly: The Game')]);
  assert.equal(loans(), 0, 'nothing went home');
  assert.equal((await me(SAM)).library.used, 0, 'and none of their plan is used');
  // a game that goes home still does
  const catan = await scan(CATAN.code, SAM);
  assert.deepEqual([catan.status, catan.data.result, catan.data.loan.title], [200, 'borrowed', 'Catan']);
});

test("a member's hold on an in-store-only game is collected for a table, never a loan: their scan is refused, the desk can't check it out, and staff marking it Collected ends the hold with nothing going home", async () => {
  await members();
  membership(SAM, 'active', { tier: 'stash' });
  library();
  catalogue(MVM, CATAN);
  // members can still reserve it: a hold is collected at the counter, to play here
  const held = await hold(MVM, SAM);
  assert.equal(held.status, 200, said(held));
  const id = held.data.hold.id;
  // their scan in My Library: refused, and the hold stays on
  const scanned = await scan(MVM.code, SAM);
  assert.deepEqual([scanned.status, scanned.data.error], [422, "Mechs vs. Minions (League of Legends) stays in the Lair, so it can't go home. It's on hold for you: collect it at the counter and play it at your table."]);
  assert.equal(lair.holdRow(id).status, 'held');
  // the desk's "Check out or lend a game" with Sam picked: refused, saying how to hand it over
  const out = await lend({ customerId: SAM, code: MVM.code });
  assert.deepEqual([out.status, out.data.error], [422, IN_STORE_WORDS.lendHeld(MVM.title, 'Sam')]);
  assert.equal(lair.holdRow(id).status, 'held');
  // the holds list's Collected: the hold ends collected, with no loan
  const collected = await call('POST', `library/holds/${id}/update`, { status: 'collected' }, 'staff');
  assert.equal(collected.status, 200, said(collected));
  assert.deepEqual([collected.data.hold.status, collected.data.loan, collected.data.notice], ['collected', null, IN_STORE_WORDS.collected(MVM.title)]);
  assert.equal(loans(), 0, 'nothing went home');
  const mine = (await me(SAM)).library;
  assert.deepEqual([mine.atHome, mine.holds.filter((h) => h.status === 'held'), mine.used], [[], [], 0]);
  // an ordinary game's hold still goes home when it's collected
  const catan = (await hold(CATAN, SAM)).data.hold;
  const home = await call('POST', `library/holds/${catan.id}/update`, { status: 'collected' }, 'staff');
  assert.deepEqual([home.data.hold.status, home.data.loan?.title, home.data.notice], ['collected', 'Catan', undefined]);
});

test("staff can't lend an in-store-only game: not to someone new, not to a member with no plan, not to a member with one", async () => {
  await members();
  membership(SAM, 'active', { tier: 'stash' });
  library();
  catalogue(MVM, FIREFLY, CATAN);
  const tries = [
    [{ guest: { name: 'Wiremu Brown', email: 'wiremu@example.com' }, code: MVM.code }, MVM],
    [{ customerId: LEO, code: MVM.code }, MVM],
    [{ customerId: SAM, code: 'dgl34-l016' }, MVM],
    [{ customerId: SAM, variantId: FIREFLY.variantId, title: FIREFLY.title, shelfCode: FIREFLY.code, handle: FIREFLY.handle }, FIREFLY],
  ];
  for (const [body, game] of tries) {
    const res = await lend(body);
    assert.deepEqual([res.status, res.data.error], [422, IN_STORE_WORDS.lend(game.title)], JSON.stringify(body));
  }
  assert.equal(IN_STORE_WORDS.lend('Mechs vs. Minions'), "Mechs vs. Minions stays in the Lair: it can't be lent. It's for playing at a table here.");
  assert.equal(IN_STORE_WORDS.lendHeld('Firefly: The Game', null), "Firefly: The Game stays in the Lair: it can't be lent. They have it on hold: mark the hold Collected when you hand it over for a table.");
  assert.equal(loans(), 0, 'nothing was lent');
  // an ordinary game is lent as before
  const catan = await lend({ guest: { name: 'Wiremu Brown', email: 'wiremu@example.com' }, code: CATAN.code });
  assert.deepEqual([catan.status, catan.data.lent, catan.data.loan.title], [200, true, 'Catan']);
});

test("the scan's own Shopify lookups read the In Store Only tag, so a catalogue that's behind never lets a game go home", async () => {
  await members();
  membership(SAM, 'active', { tier: 'hoard' });
  library();
  // the catalogue as it was before 2 Nov: Mechs vs. Minions untagged and Firefly not in it at all
  catalogue({ ...MVM, tags: MVM.tags.filter((t) => t !== 'In Store Only') }, CATAN, AZUL);
  // Firefly, a code the Lair hasn't seen: Shopify's answer (LairVariantByCode) says it stays
  const firefly = await scan(FIREFLY.code, SAM);
  assert.deepEqual([firefly.status, firefly.data.error], [422, IN_STORE_WORDS.scan(FIREFLY.title)]);
  // Mechs vs. Minions, a game the Lair knows (no code lookup): the scan's copies lookup (VariantCopies) says it stays
  lair.saveLibraryGame({ variantId: MVM.variantId, productId: MVM.productId, title: MVM.title, handle: MVM.handle, shelfCode: MVM.code }, Date.now());
  const mvm = await scan(MVM.code, SAM);
  assert.deepEqual([mvm.status, mvm.data.error], [422, IN_STORE_WORDS.scan(MVM.title)]);
  // and the other way: Catan's tag was taken off in Shopify, but the catalogue still has it: either saying so keeps it in
  // (the review, 6 Nov 2026), so it stays until the catalogue's next sync (within 10 minutes, or Sync with Shopify now)
  lair.sql.exec('UPDATE pick_catalog SET in_store_only = 1 WHERE product_id = ?', CATAN.productId);
  const kept = await scan(CATAN.code, SAM);
  assert.deepEqual([kept.status, kept.data.error], [422, IN_STORE_WORDS.scan(CATAN.title)]);
  lair.sql.exec('UPDATE pick_catalog SET in_store_only = 0 WHERE product_id = ?', CATAN.productId); // the next sync
  const catan = await scan(CATAN.code, SAM);
  assert.deepEqual([catan.status, catan.data.result], [200, 'borrowed']);
  // an answer that says nothing about tags (older than 10 minutes, or none): the catalogue says
  lair.sql.exec('UPDATE pick_catalog SET in_store_only = 1 WHERE product_id = ?', AZUL.productId);
  inStore.delete(AZUL.variantId);
  const azul = await scan(AZUL.code, SAM);
  assert.deepEqual([azul.status, azul.data.error], [422, IN_STORE_WORDS.scan(AZUL.title)]);
  assert.equal(loans(), 1, 'only Catan went home');
});

test("a game tagged In Store Only just after Shopify last said it wasn't stays in: a 'no' kept from a lookup in the last 10 minutes never beats the catalogue's newer 'yes' (the review, 6 Nov 2026)", async () => {
  await members();
  membership(SAM, 'active', { tier: 'hoard' });
  library();
  catalogue(CATAN, AZUL);
  // a game the Lair knows, so a scan asks Shopify only for its copies
  lair.saveLibraryGame({ variantId: AZUL.variantId, productId: AZUL.productId, title: AZUL.title, handle: AZUL.handle, shelfCode: AZUL.code }, Date.now());
  // a library page asks for its copies: Shopify says it isn't In Store Only, and that's kept for 10 minutes
  const status = await call('GET', `library/status?ids=${AZUL.variantId}`, null, SAM);
  assert.equal(status.status, 200, said(status));
  // a minute later staff tag it in Shopify, and the catalogue's next sync has the tag
  clock += MIN;
  inStore.set(AZUL.variantId, true);
  catalogue(CATAN, { ...AZUL, tags: [...AZUL.tags, 'In Store Only'] });
  // a scan inside the 10 minutes: the copies answer is the kept "no", but the catalogue's "yes" keeps it in
  clock += 4 * MIN;
  const azul = await scan(AZUL.code, SAM);
  assert.deepEqual([azul.status, azul.data.error], [422, IN_STORE_WORDS.scan(AZUL.title)]);
  assert.equal(loans(), 0, 'nothing went home');
});

test("Shopify's answers carry the In Store Only tag: LairVariantByCode and the copies lookup (VariantCopies) read each product's tags, as the theme does (its handle, in-store-only)", async () => {
  const admin = new ShopifyAdmin({ SHOP: 'ep0qiq-rp.myshopify.com' });
  const asked = [];
  const gid = (kind, id) => `gid://shopify/${kind}/${id}`;
  const variantNode = (g) => ({
    id: gid('ProductVariant', g.variantId), title: 'Default Title', sku: g.code, barcode: '', price: '0.00', availableForSale: true, media: { nodes: [] },
    product: { id: gid('Product', g.productId), handle: g.handle, title: `${g.title} (Library)`, status: 'ACTIVE', tags: g.tags, isGiftCard: false, requiresSellingPlan: false, featuredMedia: null, libraryCode: { value: g.code } },
  });
  admin.graphql = async (query) => {
    asked.push(query);
    if (/^\s*query LairVariantByCode\(/.test(query)) return { productVariants: { nodes: [variantNode(MVM), variantNode(CATAN)] } };
    if (/^\s*query VariantCopies\(/.test(query)) {
      return {
        nodes: [
          { id: gid('ProductVariant', MVM.variantId), inventoryQuantity: 1, inventoryItem: { tracked: true }, product: { tags: MVM.tags } },
          { id: gid('ProductVariant', CATAN.variantId), inventoryQuantity: 2, inventoryItem: { tracked: true }, product: { tags: CATAN.tags } },
          { id: gid('ProductVariant', '777'), inventoryQuantity: 1, inventoryItem: { tracked: true } },
        ],
      };
    }
    throw new Error(`unexpected query ${query.slice(0, 40)}`);
  };
  const found = await admin.variantByCode('DGL34-L016');
  assert.deepEqual(found.map((v) => [v.variantId, v.inStoreOnly]), [[MVM.variantId, true], [CATAN.variantId, false]]);
  assert.match(asked[0], /\btags\b/, 'LairVariantByCode asks for the product\'s tags');
  const copies = await admin.variantCopies([MVM.variantId, CATAN.variantId, '777']);
  assert.deepEqual([...copies.entries()].map(([id, v]) => [id, v.quantity, v.inStoreOnly]), [[MVM.variantId, 1, true], [CATAN.variantId, 2, false], ['777', 1, null]]);
  assert.match(asked[1], /product\s*\{\s*tags\s*\}/, 'VariantCopies asks for the product\'s tags');
  // the tag by its handle, as the theme's product page and the catalogue read it
  assert.deepEqual(['In Store Only', 'in store only', 'In-Store Only', 'IN STORE ONLY', ' In  Store  Only ', 'In Store', 'Store Only'].map((t) => inStoreTagged([t])), [true, true, true, true, true, false, false]);
  assert.equal(inStoreTagged(undefined), false);
});

test("a postal swap of an in-store-only game can't be packed or sent (it would go home): staff cancel it instead", async () => {
  await members();
  membership(SAM, 'active', { tier: 'stash' });
  library();
  catalogue(MVM, CATAN);
  // a swap from before the tag (the queue never holds an in-store-only game now), its postage paid
  const held = (await hold(MVM, SAM)).data.hold;
  lair.sql.exec(
    `INSERT INTO library_sends (id, customer_id, hold_id, product_id, title, shelf_code, area, postage, status, confirm_by, created_at, updated_at)
     VALUES ('ls1', ?, ?, ?, ?, ?, 'auckland', 1000, 'paid', ?, ?, ?)`,
    SAM, held.id, MVM.productId, MVM.title, MVM.code, NOW + DAY, NOW, NOW,
  );
  for (const status of ['packed', 'sent']) {
    const res = await call('POST', 'library/sends/ls1/update', { status }, 'staff');
    assert.deepEqual([res.status, res.data.error], [422, IN_STORE_WORDS.post(MVM.title)], status);
  }
  assert.equal(lair.sql.exec("SELECT status FROM library_sends WHERE id = 'ls1'").one().status, 'paid');
  assert.equal(loans(), 0);
  // cancelling it works as before
  const cancelled = await call('POST', 'library/sends/ls1/update', { status: 'cancelled' }, 'staff');
  assert.deepEqual([cancelled.status, cancelled.data.send.status], [200, 'cancelled']);
});

test('nothing else makes a loan of a game that stays in the Lair: a loan of one is refused wherever it comes from', async () => {
  await members();
  library();
  catalogue(MVM, CATAN);
  const game = { variantId: MVM.variantId, productId: MVM.productId, title: MVM.title, shelfCode: MVM.code, handle: MVM.handle };
  assert.throws(() => lair.makeLoan(game, SAM, Date.now()), { message: IN_STORE_WORDS.home(MVM.title) });
  membership(SAM, 'active', { tier: 'stash' });
  const held = (await hold(MVM, SAM)).data.hold;
  assert.throws(() => lair.collectHold(lair.holdRow(held.id), Date.now(), 'staff'), { message: IN_STORE_WORDS.home(MVM.title) });
  assert.deepEqual([loans(), lair.holdRow(held.id).status], [0, 'held']);
  // an ordinary game's loan is made as before
  assert.equal(lair.makeLoan({ variantId: CATAN.variantId, productId: CATAN.productId, title: CATAN.title }, SAM, Date.now()).status, 'out');
});

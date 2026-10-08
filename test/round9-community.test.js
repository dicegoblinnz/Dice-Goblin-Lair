// Round 9, community (contract v9-community): turnouts by game (check-ins, guests, walk-ins, TTRPG seats), lists of
// members, and early access offers for regulars (limits, units, windows, a draft order made for the member, expiry, the
// paid webhook). Mo: "the more you show up the more you get added into our list of say Pokemon turnouts … they will be
// the ones where we will give the option to buy our products before it goes to the rest of the shop".
// Run with: node --test test/   (under TZ=UTC and TZ=Pacific/Auckland)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair, MIGRATIONS } from '../src/lair.js';
import { LairTime, rulesFromSettings } from '../src/core.js';
import { monthsBefore, claimState, offerState, ON_SALE_ONLINE, OFFER_MESSAGES, LIST_MESSAGES } from '../src/community.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Friday 9 October 2026, 1:00pm in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 9, 9, 0, 0);
const realNow = Date.now;
let clock = NOW;

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
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) }, waitUntil: () => {} };
}

const FALLBACK = [
  { id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 },
  { id: 'fancy-room', name: 'Fancy room', code: 'F', tables: 1, seats: 12, price: 15, minPeople: 4, order: 4 },
];
const TEST_HOURS = 'Mon closed\nTue 12:00-22:00\nWed 12:00-22:00\nThu 12:00-22:00\nFri 12:00-23:00\nSat 10:00-23:00\nSun 10:00-20:00';
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const TODAY = '2026-10-09';
// Tonight's Pokémon league ($5 at the counter, 16 places), a second Pokémon night whose Game is typed differently, a
// board game night with no Game (its kind, social), a Magic night with no sign-ups (no capacity, free), and next week's
// Pokémon league
const EVENTS = [
  { id: 'poke', title: 'Pokémon league', start: at(TODAY, 18), end: at(TODAY, 21), tables: '', capacity: 16, entryFee: 500, game: 'Pokémon TCG', type: 'tcg' },
  { id: 'poke-cup', title: 'Pokémon cup', start: at('2026-09-26', 11), end: at('2026-09-26', 16), tables: '', capacity: 32, game: 'pokémon  tcg', type: 'tournament' },
  { id: 'boards', title: 'Board game night', start: at('2026-10-06', 18), end: at('2026-10-06', 22), tables: '', capacity: 20, type: 'social' },
  { id: 'magic', title: 'Commander night', start: at(TODAY, 18), end: at(TODAY, 22), tables: '', game: 'Magic: The Gathering', type: 'tcg' },
  { id: 'poke-next', title: 'Pokémon league', start: at('2026-10-16', 18), end: at('2026-10-16', 21), tables: '', capacity: 16, entryFee: 500, game: 'Pokémon TCG', type: 'tcg' },
];
const POKE = `poke@${TODAY}`;
const MAGIC = `magic@${TODAY}`;
const MOBILE = '021 555 0100';
const SAM = '1001';
const KIRI = '1002';
const TAMA = '1003';
const ARI = '1004'; // spends a lot, never turns up
const LEO = '1005'; // not on anything

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
const maintenance = () => internal('maintenance', { webhookUrl: 'https://lair.test/webhooks/orders-paid' });
const me = async (who) => (await call('GET', 'me', null, who)).data;
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const join = (id, body = {}, who = SAM) => call('POST', `events/${id}/join`, { name: 'Sam Jones', email: 'sam@example.com', phone: MOBILE, people: 1, ...body }, who);
const community = async (query = '') => (await call('GET', `community${query}`, null, 'staff')).data;
const settle = () => new Promise((r) => setTimeout(r, 10));

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

/** The members, by GET /me with their names. Returns their codes. */
async function members() {
  const codes = {};
  for (const [id, name] of [[SAM, 'Sam Jones'], [KIRI, 'Kiri Smith'], [TAMA, 'Tama Rewiti'], [ARI, 'Ari Moana'], [LEO, 'Leo Tane']]) {
    codes[id] = (await call('GET', `me?name=${encodeURIComponent(name)}`, null, id)).data.member.code;
    lair.write('UPDATE members SET email = ? WHERE customer_id = ?', `${name.split(' ')[0].toLowerCase()}@example.com`, id);
  }
  return codes;
}

/* A stand-in for Shopify's Admin API (the operations by name): products, draft orders and which order a draft became */
let shop;
function fakeShopify() {
  shop = {
    products: {
      7001: {
        id: 'gid://shopify/Product/7001', handle: 'riftbound-booster-box', title: 'Riftbound booster box', status: 'ACTIVE', onlineStoreUrl: null,
        featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/rb-box.jpg' } } },
        variants: { nodes: [
          { id: 'gid://shopify/ProductVariant/8001', title: 'Default Title', price: '219.00', inventoryQuantity: 6, availableForSale: true, media: { nodes: [] } },
        ] },
      },
      7002: {
        id: 'gid://shopify/Product/7002', handle: 'pokemon-etb', title: 'Pokémon elite trainer box', status: 'ACTIVE', onlineStoreUrl: 'https://www.dicegoblin.nz/products/pokemon-etb',
        featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/etb.jpg' } } },
        variants: { nodes: [
          { id: 'gid://shopify/ProductVariant/8101', title: 'Pikachu', price: '89.95', inventoryQuantity: 4, availableForSale: true, media: { nodes: [{ preview: { image: { url: 'https://cdn.shopify.com/etb-pika.jpg' } } }] } },
          { id: 'gid://shopify/ProductVariant/8102', title: 'Eevee', price: '89.95', inventoryQuantity: 2, availableForSale: true, media: { nodes: [] } },
        ] },
      },
      7003: {
        id: 'gid://shopify/Product/7003', handle: 'secret-lair', title: 'Secret thing', status: 'DRAFT', onlineStoreUrl: null, featuredMedia: null,
        variants: { nodes: [{ id: 'gid://shopify/ProductVariant/8201', title: 'Default Title', price: '50.00', inventoryQuantity: 1, availableForSale: false, media: { nodes: [] } }] },
      },
    },
    drafts: {}, // id -> { input, status, orderId }
    deleted: [],
    calls: [],
    denyStock: false,
    deny: false,
    delay: 0,
    seq: 0,
  };
  lair.shopify.graphql = async (query, variables = {}) => {
    const op = (String(query).match(/^\s*(?:query|mutation)\s+(\w+)/) || [])[1];
    shop.calls.push({ op, variables });
    if (shop.delay) await new Promise((r) => setTimeout(r, shop.delay));
    if (shop.deny || (shop.denyStock && /inventoryQuantity/.test(query))) throw new Error('Shopify API: Access denied for inventoryQuantity field. Required access: `read_inventory` access scope.');
    const strip = (p) => (p && !/inventoryQuantity/.test(query) ? { ...p, variants: { nodes: p.variants.nodes.map(({ inventoryQuantity, ...v }) => v) } } : p);
    if (op === 'LairOfferProducts' || op === 'LairOfferProductsPlain') {
      const q = String(variables.query || '').toLowerCase();
      return { products: { nodes: Object.values(shop.products).filter((p) => p.title.toLowerCase().includes(q)).map(strip) } };
    }
    if (op === 'LairOfferProduct' || op === 'LairOfferProductPlain') return { product: strip(shop.products[String(variables.id).split('/').pop()] || null) };
    if (op === 'LairOfferDraft') {
      if (shop.failDraft) return { draftOrderCreate: { draftOrder: null, userErrors: [{ field: ['input'], message: 'Nope' }] } };
      shop.seq += 1;
      const id = `gid://shopify/DraftOrder/${shop.seq}`;
      shop.drafts[id] = { input: variables.input, status: 'OPEN', orderId: null };
      return { draftOrderCreate: { draftOrder: { id, invoiceUrl: `https://dicegoblin.test/invoices/${shop.seq}` }, userErrors: [] } };
    }
    throw new Error(`fake Shopify: unknown operation ${op}`);
  };
  lair.shopify.draftOrderOrderId = async (id) => shop.drafts[id]?.orderId || null;
  lair.shopify.deleteDraftIfOpen = async (id) => {
    shop.deleted.push(id);
    return true;
  };
  lair.shopify.customerEmail = async () => null;
  lair.shopify.appInfo = async () => ({ app: 'Dice Goblin Lair', shop: 'Dice Goblin', scopes: [] });
  lair.shopify.webhookUris = async () => ['https://lair.test/webhooks/orders-paid'];
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
}

beforeEach(() => {
  clock = NOW;
  Date.now = () => clock;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'ep0qiq-rp.myshopify.com', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'hush' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff' || id === '9001', gm: false, tags: [] });
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  fakeShopify();
});
afterEach(() => {
  Date.now = realNow;
});

/* ---------------- storage ---------------- */

test('community: one migration entry, found by what it makes: only a new column, tables and indexes', () => {
  const mine = MIGRATIONS.filter((m) => m.some((s) => /early_offer_claims|community_lists/.test(s)));
  assert.equal(mine.length, 1);
  assert.ok(mine[0].every((s) => /^\s*(ALTER TABLE \w+ ADD COLUMN|CREATE (UNIQUE )?INDEX IF NOT EXISTS|CREATE TABLE IF NOT EXISTS)/.test(s)));
  assert.ok(mine[0].some((s) => /ALTER TABLE event_joins ADD COLUMN source/.test(s)));
});

test('community: months before a day, in Lair days (the end of a short month takes its last day)', () => {
  assert.equal(monthsBefore('2026-10-09', 3), '2026-07-09');
  assert.equal(monthsBefore('2026-10-09', 12), '2025-10-09');
  assert.equal(monthsBefore('2026-05-31', 3), '2026-02-28');
  assert.equal(monthsBefore('2026-02-15', 3), '2025-11-15');
  assert.equal(monthsBefore('2028-05-31', 3), '2028-02-29');
});

/* ---------------- turnouts ---------------- */

test('turnouts: a checked-in sign-up counts for whoever signed up and each member guest; undoing it takes them back; no-shows never count', async () => {
  const codes = await members();
  const signed = await join(POKE, { guests: [{ code: codes[KIRI] }, { name: 'Jo Bloggs' }] });
  assert.equal(signed.status, 200, `${said(signed)}`);
  const tama = await join(POKE, { name: 'Tama Rewiti', email: 'tama@example.com' }, TAMA);
  assert.equal(tama.status, 200);
  let c = await community();
  assert.deepEqual(c.games, [], 'nobody has turned up yet: signing up is not a turnout');
  const checked = await call('POST', 'checkin', { id: signed.data.join.id, type: 'join' }, 'staff');
  assert.equal(checked.data.checkedIn, true);
  c = await community();
  assert.deepEqual(c.games.map((g) => [g.name, g.turnouts.m3, g.people.m3]), [['Pokémon TCG', 2, 2]]);
  const row = (id) => c.members.find((m) => m.customerId === id);
  assert.deepEqual(row(SAM).turnouts, { m3: 1, m12: 1, all: 1 });
  assert.deepEqual(row(KIRI).turnouts, { m3: 1, m12: 1, all: 1 }, 'the member guest counts for themselves');
  assert.equal(row(TAMA), undefined, 'signed up and not checked in: no turnout');
  assert.equal(row(SAM).code, codes[SAM]);
  assert.equal(row(SAM).lastSeen, at(TODAY, 18));
  // staff undo the check-in: both turnouts go
  await call('POST', `bookings/${signed.data.join.id}/update`, { status: 'confirmed' }, 'staff');
  c = await community();
  assert.equal(c.members.length, 0);
  assert.deepEqual(c.games, []);
});

test('turnouts: TTRPG seats count under the session system (seated or done), never table bookings, no-shows or the GM; events with no Game count under their kind', async () => {
  await members();
  const game = (id, system, start) => lair.write(
    `INSERT INTO games (id, title, system, gm, gm_customer_id, tables, starts_at, ends_at, seats, status, created_at, updated_at)
     VALUES (?, 'Curse of Strahd', ?, 'Ana', '9100', '["T5"]', ?, ?, 4, 'open', ?, ?)`, id, system, start, start + 4 * HOUR, NOW, NOW,
  );
  game('g1', 'D&D 5e', at('2026-10-03', 18));
  game('g2', 'd&d 5E', at('2026-09-26', 18));
  game('g3', '', at('2026-09-19', 18));
  const seat = (id, kind, status, customerId, gameId, start) => lair.write(
    `INSERT INTO bookings (id, ref, kind, status, tables, starts_at, ends_at, people, name, customer_id, game_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, '["T5"]', ?, ?, 1, 'x', ?, ?, ?, ?)`, id, `R-${id}`, kind, status, start, start + 4 * HOUR, customerId, gameId, NOW, NOW,
  );
  seat('s1', 'gm-seat', 'seated', TAMA, 'g1', at('2026-10-03', 18));
  seat('s2', 'gm-seat', 'done', TAMA, 'g2', at('2026-09-26', 18));
  seat('s3', 'gm-seat', 'noshow', SAM, 'g1', at('2026-10-03', 18));
  seat('s4', 'gm-seat', 'confirmed', KIRI, 'g1', at('2026-10-03', 18));
  seat('s5', 'gm-seat', 'seated', KIRI, 'g3', at('2026-09-19', 18));
  seat('s6', 'table', 'seated', SAM, null, at('2026-10-03', 12));
  seat('s7', 'walkin', 'done', SAM, null, at('2026-10-03', 12));
  seat('s8', 'gm', 'seated', '9100', 'g1', at('2026-10-03', 18));
  // a board game night sign-up checked in (its event has no Game: it counts under its kind)
  lair.write(
    `INSERT INTO event_joins (id, ref, occurrence_id, event_id, title, starts_at, ends_at, people, name, status, customer_id, created_at, updated_at)
     VALUES ('j1', 'R-J1', 'boards@2026-10-06', 'boards', 'Board game night', ?, ?, 2, 'Sam', 'attended', ?, ?, ?)`, at('2026-10-06', 18), at('2026-10-06', 22), SAM, NOW, NOW,
  );
  const c = await community();
  assert.deepEqual(c.games.map((g) => [g.name, g.turnouts.all, g.people.all]).sort(), [['D&D 5e', 2, 1], ['Social games', 1, 1], ['TTRPG', 1, 1]].sort());
  assert.deepEqual(c.members.find((m) => m.customerId === TAMA).turnouts, { m3: 2, m12: 2, all: 2 }, 'D&D 5e and d&d 5E are one game');
  assert.equal(c.members.find((m) => m.customerId === '9100'), undefined, 'the GM running it is not a turnout');
  assert.deepEqual(c.members.find((m) => m.customerId === SAM).turnouts, { m3: 1, m12: 1, all: 1 }, 'tables, walk-in tables and no-shows never count');
  // one game: only its people, with its numbers
  const dnd = await community('?game=D%26D%205E');
  assert.equal(dnd.game, 'd&d 5e');
  assert.deepEqual(dnd.members.map((m) => [m.customerId, m.turnouts.all]), [[TAMA, 2]]);
});

test('turnouts: the 3- and 12-month windows start at midnight on the same day, Auckland time; game names merge without case', async () => {
  await members();
  const from3 = time.at('2026-07-09', 0);
  const from12 = time.at('2025-10-09', 0);
  let n = 0;
  const attended = (customerId, start, occurrence = 'poke-cup@2026-09-26') => {
    n += 1;
    lair.write(
      `INSERT INTO event_joins (id, ref, occurrence_id, event_id, title, starts_at, ends_at, people, name, status, customer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Pokémon', ?, ?, 1, 'x', 'attended', ?, ?, ?)`, `w${n}`, `W-${n}`, `${occurrence.split('@')[0]}@d${n}`, occurrence.split('@')[0], start, start + HOUR, customerId, NOW, NOW,
    );
  };
  attended(SAM, from3); // the first moment of the 3-month window
  attended(KIRI, from3 - 1); // a moment before: the year, not the quarter
  attended(TAMA, from12); // the first moment of the year
  attended(ARI, from12 - 1); // a moment before: all time only
  attended(SAM, at('2026-10-02', 18), 'poke@2026-10-02'); // 'Pokémon TCG' and 'pokémon  tcg' are one game
  const c = await community();
  assert.equal(c.windows.m3, from3);
  assert.equal(c.windows.m12, from12);
  const t = (id) => c.members.find((m) => m.customerId === id).turnouts;
  assert.deepEqual(t(SAM), { m3: 2, m12: 2, all: 2 });
  assert.deepEqual(t(KIRI), { m3: 0, m12: 1, all: 1 });
  assert.deepEqual(t(TAMA), { m3: 0, m12: 1, all: 1 });
  assert.deepEqual(t(ARI), { m3: 0, m12: 0, all: 1 });
  assert.equal(c.games.length, 1);
  assert.deepEqual(c.games[0].turnouts, { m3: 2, m12: 4, all: 5 });
  assert.deepEqual(c.games[0].people, { m3: 1, m12: 3, all: 4 });
  assert.equal(c.games[0].name, 'Pokémon TCG', 'named as its latest turnout spelled it');
});

test('turnouts: total spend is joined in; sorting by each measure, ties by the others; anyone with spend is on the all-games list', async () => {
  await members();
  let n = 0;
  const attended = (customerId, start) => {
    n += 1;
    lair.write(
      `INSERT INTO event_joins (id, ref, occurrence_id, event_id, title, starts_at, ends_at, people, name, status, customer_id, created_at, updated_at)
       VALUES (?, ?, ?, 'poke', 'Pokémon league', ?, ?, 1, 'x', 'attended', ?, ?, ?)`, `x${n}`, `X-${n}`, `poke@x${n}`, start, start + HOUR, customerId, NOW, NOW,
    );
  };
  for (let i = 0; i < 3; i += 1) attended(SAM, at('2026-09-04', 18) + i * 7 * DAY);
  for (let i = 0; i < 5; i += 1) attended(KIRI, at('2026-02-06', 18) + i * 7 * DAY); // last year, not this quarter
  attended(TAMA, at('2026-10-02', 18));
  const spend = (customerId, amount, i) => lair.write('INSERT INTO spend (order_id, customer_id, amount, source, created_at) VALUES (?, ?, ?, ?, ?)', `gid://shopify/Order/${i}`, customerId, amount, 'web', NOW - DAY);
  spend(ARI, 90000, 1);
  spend(KIRI, 20000, 2);
  spend(KIRI, 5000, 3);
  spend(TAMA, 1000, 4);
  const ids = (c) => c.members.map((m) => m.customerId);
  assert.deepEqual(ids(await community('?sort=3m')), [SAM, TAMA, KIRI, ARI], 'quarter first; ties broken by the year, all time, then spend');
  assert.deepEqual(ids(await community('?sort=12m')), [KIRI, SAM, TAMA, ARI]);
  assert.deepEqual(ids(await community('?sort=all')), [KIRI, SAM, TAMA, ARI]);
  const bySpend = await community('?sort=spend');
  assert.deepEqual(ids(bySpend), [ARI, KIRI, TAMA, SAM]);
  assert.equal(bySpend.members[0].spend, 90000);
  assert.equal(bySpend.members[1].spend, 25000);
  assert.deepEqual(bySpend.members[0].turnouts, { m3: 0, m12: 0, all: 0 }, 'Ari spends but never turns up: still on the all-games list');
  // one game: only those who turned up for it, spend still their total
  const poke = await community('?game=pok%C3%A9mon%20tcg&sort=spend');
  assert.deepEqual(ids(poke), [KIRI, TAMA, SAM]);
  assert.equal(poke.total, 3);
  // not staff: 403
  assert.equal(said(await call('GET', 'community', null, SAM)), '403 Staff only. Log in with your staff account.');
});

test('walk-ins: a member code on one of today\'s events makes a checked-in sign-up for one, with the usual fee; never twice; free events stay free', async () => {
  const codes = await members();
  const walk = (occurrence, code, who = 'staff') => call('POST', `events/${occurrence}/attend`, { code }, who);
  assert.equal(said(await walk(POKE, codes[TAMA], TAMA)), '403 Staff only. Log in with your staff account.');
  assert.equal(said(await walk('poke-next@2026-10-16', codes[TAMA])), "422 Walk-ins are for today's events. That one is on Fri 16 Oct.");
  assert.equal(said(await walk(POKE, 'zz-nope-1')), '404 No member has the code ZZ-NOPE-1. Check it, or find them under Members.');
  assert.equal(said(await walk('nope@2026-10-09', codes[TAMA])), '404 That event date could not be found.');
  const res = await walk(POKE, codes[TAMA].toLowerCase().replace(/-/g, ''));
  assert.equal(res.status, 200, said(res));
  assert.equal(res.data.message, `Walk-in added and checked in: Tama Rewiti for Pokémon league. Charge $5.`);
  assert.equal(res.data.join.status, 'attended');
  assert.equal(res.data.join.source, 'walk-in');
  assert.equal(res.data.join.customerId, TAMA);
  assert.equal(res.data.join.due, 500, 'the entry fee is due at the counter, like any sign-up');
  assert.equal(res.data.row.due, 500);
  const stored = lair.sql.exec('SELECT * FROM event_joins WHERE id = ?', res.data.join.id).toArray()[0];
  assert.equal(stored.source, 'walk-in');
  assert.equal(stored.people, 1);
  assert.ok(stored.arrived_at);
  assert.equal(said(await walk(POKE, codes[TAMA])), '409 Tama Rewiti is already checked in at Pokémon league.');
  // someone signed up already: refused plainly, pointing at their sign-up
  const sam = await join(POKE);
  assert.equal(sam.status, 200);
  assert.equal(said(await walk(POKE, codes[SAM])), '409 Sam Jones is already signed up for Pokémon league. Check them in from their sign-up under Event sign-ups today.');
  // a guest on someone's sign-up counts as signed up too
  await join(POKE, { name: 'Ari Moana', email: 'ari@example.com', guests: [{ code: codes[KIRI] }] }, ARI);
  assert.equal(said(await walk(POKE, codes[KIRI])), '409 Kiri Smith is already signed up for Pokémon league. Check them in from their sign-up under Event sign-ups today.');
  // an event with no sign-ups and no fee (a card night): free, still a turnout
  const magic = await walk(MAGIC, codes[LEO]);
  assert.equal(magic.status, 200, said(magic));
  assert.equal(magic.data.join.amount, 0);
  assert.equal(magic.data.message, 'Walk-in added and checked in: Leo Tane for Commander night.');
  const c = await community();
  assert.deepEqual(c.games.map((g) => [g.name, g.turnouts.all]).sort(), [['Magic: The Gathering', 1], ['Pokémon TCG', 1]]);
  // the floor shows it under today's sign-ups for staff, checked in
  const floor = (await call('GET', `floor?from=${at(TODAY, 0)}&to=${at(TODAY, 23)}`, null, 'staff')).data;
  assert.ok(floor.joins.some((j) => j.id === res.data.join.id && j.status === 'attended'));
});

/* ---------------- lists ---------------- */

test('lists: save a selection, rename, add and take people off, delete; the community list says who is on which', async () => {
  await members();
  const make = (body, who = 'staff') => call('POST', 'community/lists', body, who);
  assert.equal(said(await make({ name: 'x', customerIds: [SAM] }, SAM)), '403 Staff only. Log in with your staff account.');
  assert.equal(said(await make({ name: '  ', customerIds: [SAM] })), `422 ${LIST_MESSAGES.name}`);
  assert.equal(said(await make({ name: 'x'.repeat(61), customerIds: [SAM] })), `422 ${LIST_MESSAGES.long}`);
  assert.equal(said(await make({ name: 'Regulars', customerIds: [SAM, '424242'] })), `422 ${OFFER_MESSAGES.people}`);
  const made = await make({ name: 'Pokémon regulars, Oct', note: 'Top of the quarter', customerIds: [SAM, KIRI, SAM] }, '9001');
  assert.equal(made.status, 200, said(made));
  const L = made.data.list;
  assert.equal(L.name, 'Pokémon regulars, Oct');
  assert.equal(L.count, 2);
  assert.deepEqual(L.members.map((m) => m.name), ['Kiri Smith', 'Sam Jones']);
  assert.equal(L.createdBy.customerId, '9001');
  assert.equal(said(await make({ name: 'pokémon REGULARS, oct', customerIds: [] })), "409 There's already a list called pokémon REGULARS, oct. Pick another name.");
  const edited = await call('POST', `community/lists/${L.id}`, { name: 'Pokémon regulars', add: [TAMA], remove: [SAM] }, 'staff');
  assert.equal(edited.status, 200, said(edited));
  assert.deepEqual(edited.data.list.members.map((m) => m.customerId).sort(), [KIRI, TAMA]);
  assert.equal(edited.data.list.name, 'Pokémon regulars');
  assert.equal(edited.data.list.note, 'Top of the quarter');
  // the community view says who's on a list (members with any spend or turnouts show there)
  lair.write("INSERT INTO spend (order_id, customer_id, amount, source, created_at) VALUES ('o1', ?, 100, 'web', ?)", KIRI, NOW);
  const c = await community();
  assert.deepEqual(c.members.find((m) => m.customerId === KIRI).lists, [{ id: L.id, name: 'Pokémon regulars' }]);
  const lists = (await call('GET', 'community/lists', null, 'staff')).data.lists;
  assert.equal(lists.length, 1);
  assert.equal(said(await call('POST', 'community/lists/nope', { name: 'x' }, 'staff')), `404 ${LIST_MESSAGES.missing}`);
  const gone = await call('POST', `community/lists/${L.id}/remove`, {}, 'staff');
  assert.deepEqual(gone.data, { ok: true, id: L.id });
  assert.deepEqual((await call('GET', 'community/lists', null, 'staff')).data.lists, []);
  assert.equal((await call('POST', `community/lists/${L.id}/remove`, {}, 'staff')).status, 200, 'a second tap is fine');
});

/* ---------------- early access offers ---------------- */

const CLOSES = at('2026-10-18', 18);
async function offerFor(people, over = {}) {
  const res = await call('POST', 'offers', { productId: '7001', variantIds: ['8001'], perPerson: 2, totalUnits: 3, closes: '2026-10-18T18:00', message: 'Two a person, friends.', customerIds: people, ...over }, 'staff');
  assert.equal(res.status, 200, said(res));
  return res.data.offer;
}
const openIt = async (id, body = {}) => {
  const res = await call('POST', `offers/${id}/open`, body, 'staff');
  assert.equal(res.status, 200, said(res));
  return res.data;
};
const claim = (id, body, who) => call('POST', `offers/${id}/claim`, body, who);

test('products: the staff search through the Admin API, with what is published and whether it can be sold; read_inventory missing still works', async () => {
  assert.equal(said(await call('GET', 'products/search?q=r', null, 'staff')), "422 Type at least 2 letters of the product's name.");
  assert.equal((await call('GET', 'products/search?q=box', null, SAM)).status, 403);
  const found = (await call('GET', 'products/search?q=box', null, 'staff')).data.products;
  assert.deepEqual(found.map((p) => [p.title, p.active, p.published]), [['Riftbound booster box', true, false], ['Pokémon elite trainer box', true, true]]);
  assert.deepEqual(found[1].variants, [
    { id: '8101', title: 'Pikachu', price: 8995, stock: 4, available: true, image: 'https://cdn.shopify.com/etb-pika.jpg' },
    { id: '8102', title: 'Eevee', price: 8995, stock: 2, available: true, image: 'https://cdn.shopify.com/etb.jpg' },
  ]);
  assert.equal(found[0].variants[0].title, '', 'a single Default Title variant has no title');
  shop.denyStock = true;
  const plain = (await call('GET', 'products/search?q=secret', null, 'staff')).data.products;
  assert.deepEqual(plain.map((p) => [p.title, p.status, p.active, p.variants[0].stock]), [['Secret thing', 'DRAFT', false, null]]);
  shop.deny = true;
  assert.equal(said(await call('GET', 'products/search?q=box', null, 'staff')), "503 Shopify hasn't let the Lair read products yet. Approve the app's read_products permission in Shopify admin (Apps › Dice Goblin Lair), then try again.");
});

test('offers: the checks on making one: a draft product is refused, a published one warns, options must be its own, times and limits', async () => {
  await members();
  const make = (body) => call('POST', 'offers', { productId: '7001', variantIds: ['8001'], closes: '2026-10-18T18:00', customerIds: [SAM], ...body }, 'staff');
  assert.equal(said(await make({ productId: '7003', variantIds: ['8201'] })), "422 Secret thing is a draft in Shopify, so it can't be sold. Make it Active first: it can stay hidden from the online store.");
  assert.equal(said(await make({ productId: '' })), `422 ${OFFER_MESSAGES.product}`);
  assert.equal(said(await make({ variantIds: [] })), `422 ${OFFER_MESSAGES.variants}`);
  assert.equal(said(await make({ variantIds: ['8101'] })), "422 That option isn't part of Riftbound booster box. Search for it again.");
  assert.equal(said(await make({ perPerson: 0 })), `422 ${OFFER_MESSAGES.perPerson}`);
  assert.equal(said(await make({ totalUnits: -2 })), `422 ${OFFER_MESSAGES.units}`);
  assert.equal(said(await make({ closes: '' })), `422 ${OFFER_MESSAGES.closes}`);
  assert.equal(said(await make({ closes: '2026-10-08T18:00' })), `422 ${OFFER_MESSAGES.past}`);
  assert.equal(said(await make({ opens: '2026-10-19T09:00' })), `422 ${OFFER_MESSAGES.order}`);
  assert.equal(said(await make({ closes: '2026-02-30T18:00' })), `422 ${OFFER_MESSAGES.date}`);
  assert.equal(said(await make({ productId: '7999' })), `404 ${OFFER_MESSAGES.product404}`);
  assert.equal(said(await make({ listId: 'nope' })), `404 ${LIST_MESSAGES.missing}`);
  assert.equal((await call('POST', 'offers', { productId: '7001' }, SAM)).status, 403);
  const etb = await make({ productId: 'gid://shopify/Product/7002', variantIds: ['8101', '8102'] });
  assert.equal(etb.status, 200, said(etb));
  assert.equal(etb.data.warning, ON_SALE_ONLINE);
  assert.equal(etb.data.warning, 'Anyone can buy this online right now. Hide it from the online store in Shopify until early access ends.');
  const o = etb.data.offer;
  assert.equal(o.status, 'draft');
  assert.equal(o.closes, CLOSES, 'closing times are Lair time');
  assert.deepEqual(o.variants.map((v) => [v.id, v.title, v.price]), [['8101', 'Pikachu', 8995], ['8102', 'Eevee', 8995]]);
  assert.equal(o.perPerson, 1, 'one each unless staff say');
  assert.equal(o.totalUnits, null);
  assert.equal(o.unitsLeft, null);
  // a draft isn't anyone's yet
  assert.deepEqual((await me(SAM)).offers, []);
  assert.equal(said(await claim(o.id, { variantId: '8101', quantity: 1 }, SAM)), '404 That offer could not be found.');
  // opening it needs people on it
  const empty = await make({ customerIds: [] });
  assert.equal(said(await call('POST', `offers/${empty.data.offer.id}/open`, {}, 'staff')), `422 ${OFFER_MESSAGES.nobody}`);
});

test('offers: opened for a list and picked people, emailed; only they see it in My Lair; a claim makes a draft order for that customer', async () => {
  await members();
  const list = (await call('POST', 'community/lists', { name: 'Riftbound crew', customerIds: [SAM, KIRI] }, 'staff')).data.list;
  // Tama never typed an email into the Lair: his Shopify account's verified email (read when he opened My Lair) is used
  lair.write("UPDATE members SET email = NULL, account_email = 'tama.account@example.com' WHERE customer_id = ?", TAMA);
  const o = await offerFor([TAMA], { listId: list.id });
  assert.deepEqual(o.people.map((p) => p.customerId).sort(), [KIRI, SAM, TAMA].sort());
  assert.deepEqual(o.list, { id: list.id, name: 'Riftbound crew' });
  const mail = captureEmails();
  try {
    const opened = await openIt(o.id, { email: true });
    assert.equal(opened.offer.status, 'open');
    assert.equal(opened.emailed, 3);
    await settle();
    const toSam = mail.sent.find((m) => m.to === 'sam@example.com');
    assert.equal(toSam.subject, 'Early access: Riftbound booster box');
    assert.match(toSam.text, /Gobgob saved you a spot before anyone else\./);
    assert.match(toSam.text, /Grab it in My Lair before Sunday 18 October, 6pm\./);
    assert.match(toSam.text, /Two a person, friends\./);
    assert.ok(!mail.sent.some((m) => m.to === 'leo@example.com'));
    assert.ok(mail.sent.some((m) => m.to === 'tama.account@example.com'), 'no Lair email: the verified account email');
  } finally {
    mail.restore();
  }
  // Leo isn't on it: nothing in his My Lair, and his claim is a 404
  assert.deepEqual((await me(LEO)).offers, []);
  assert.equal(said(await claim(o.id, { variantId: '8001', quantity: 1 }, LEO)), '404 That offer could not be found.');
  assert.equal(said(await claim(o.id, { variantId: '8001', quantity: 1 }, '')), '401 Log in to claim early access, friend.');
  const mine = (await me(SAM)).offers;
  assert.equal(mine.length, 1);
  assert.deepEqual({ ...mine[0], variants: undefined }, {
    id: o.id, title: 'Riftbound booster box', image: 'https://cdn.shopify.com/rb-box.jpg', message: 'Two a person, friends.', variants: undefined, limit: 2, bought: 0,
    canBuy: 2, unitsLeft: 3, opens: NOW, closes: CLOSES, claim: null,
  });
  assert.equal(said(await claim(o.id, { variantId: '9999', quantity: 1 }, SAM)), '422 Pick one of the options on offer.');
  assert.equal(said(await claim(o.id, { variantId: '8001', quantity: 3 }, SAM)), '422 Pick how many: 1 to 2.');
  const got = await claim(o.id, { variantId: '8001', quantity: 2 }, SAM);
  assert.equal(got.status, 200, said(got));
  assert.equal(got.data.claim.status, 'waiting');
  assert.equal(got.data.claim.quantity, 2);
  assert.equal(got.data.claim.price, 21900);
  assert.equal(got.data.claim.checkoutUrl, 'https://dicegoblin.test/invoices/1');
  assert.equal(got.data.claim.expiresAt, NOW + 48 * HOUR);
  const draft = Object.values(shop.drafts)[0].input;
  assert.deepEqual(draft.purchasingEntity, { customerId: `gid://shopify/Customer/${SAM}` }, 'the draft order is made for Sam\'s own account');
  assert.deepEqual(draft.lineItems.map((l) => [l.variantId, l.quantity]), [['gid://shopify/ProductVariant/8001', 2]]);
  assert.deepEqual(draft.tags, ['lair-offer']);
  assert.ok(draft.customAttributes.some((a) => a.key === '_offer_claim' && a.value === got.data.claim.id));
  assert.equal(got.data.offer.unitsLeft, 1);
  // Sam's My Lair has his link; Kiri's has her offer with no claim and never Sam's link
  const samOffer = (await me(SAM)).offers[0];
  assert.equal(samOffer.claim.checkoutUrl, 'https://dicegoblin.test/invoices/1');
  const kiri = await me(KIRI);
  assert.equal(kiri.offers[0].claim, null);
  assert.ok(!JSON.stringify(kiri).includes('invoices/1'));
  assert.equal(kiri.offers[0].unitsLeft, 1);
  // staff see the claim: who, waiting, units left
  const detail = (await call('GET', `offers/${o.id}`, null, 'staff')).data;
  assert.deepEqual(detail.claims.map((c) => [c.customerId, c.name, c.quantity, c.status]), [[SAM, 'Sam Jones', 2, 'waiting']]);
  assert.equal(detail.offer.unitsLeft, 1);
  assert.deepEqual(detail.offer.claimed, { paid: 0, waiting: 2, people: 1 });
  assert.equal((await call('GET', `offers/${o.id}`, null, SAM)).status, 403);
});

test('offers: units hold under two members claiming at once, and per-person limits count what they paid for', async () => {
  await members();
  const o = await offerFor([SAM, KIRI, TAMA], { totalUnits: 2, perPerson: 2 });
  await openIt(o.id);
  shop.delay = 15; // Shopify is slow, so both claims are in flight together
  const [a, b] = await Promise.all([claim(o.id, { variantId: '8001', quantity: 2 }, SAM), claim(o.id, { variantId: '8001', quantity: 1 }, KIRI)]);
  shop.delay = 0;
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], `${said(a)} / ${said(b)}`);
  const refused = a.status === 409 ? a : b;
  assert.match(refused.data.error, /^(Every one has been claimed\. Sorry, friend\.|Only 0 left)/);
  const held = lair.sql.exec("SELECT COALESCE(SUM(quantity), 0) AS n FROM early_offer_claims WHERE status IN ('waiting', 'creating', 'paid')").one().n;
  assert.ok(held <= 2, `never more than the 2 units: ${held}`);
  // more than is left
  const o2 = await offerFor([SAM, KIRI], { totalUnits: 3, perPerson: 2 });
  await openIt(o2.id);
  assert.equal((await claim(o2.id, { variantId: '8001', quantity: 2 }, SAM)).status, 200);
  assert.equal(said(await claim(o2.id, { variantId: '8001', quantity: 2 }, KIRI)), '409 Only 1 left. Pick 1 or fewer.');
  // Sam pays for 2: then he's at his limit
  const c = lair.sql.exec("SELECT * FROM early_offer_claims WHERE offer_id = ? AND customer_id = ? AND status = 'waiting'", o2.id, SAM).toArray()[0];
  lair.write("UPDATE early_offer_claims SET status = 'paid', paid_at = ? WHERE id = ?", NOW, c.id);
  assert.equal(said(await claim(o2.id, { variantId: '8001', quantity: 1 }, SAM)), "409 You've got your 2 already, friend. That's the limit.");
  const view = (await me(SAM)).offers.find((x) => x.id === o2.id);
  assert.equal(view.bought, 2);
  assert.equal(view.canBuy, 0);
  assert.equal(view.claim.status, 'paid');
  assert.equal(view.claim.checkoutUrl, null, 'a paid claim has no link');
});

test('offers: claiming again replaces the unpaid claim (its checkout is deleted); unpaid claims are let go after 48 hours and the units come back', async () => {
  await members();
  const o = await offerFor([SAM, KIRI], { totalUnits: 3, perPerson: 3 });
  await openIt(o.id);
  const first = await claim(o.id, { variantId: '8001', quantity: 1 }, SAM);
  const second = await claim(o.id, { variantId: '8001', quantity: 3 }, SAM);
  assert.equal(second.status, 200, said(second));
  await settle();
  assert.deepEqual(shop.deleted, ['gid://shopify/DraftOrder/1'], 'the first checkout is deleted');
  const rows = lair.sql.exec('SELECT * FROM early_offer_claims WHERE offer_id = ? ORDER BY created_at, rowid', o.id).toArray();
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.reason]), [[first.data.claim.id, 'released', 'replaced'], [second.data.claim.id, 'waiting', null]]);
  assert.equal(said(await claim(o.id, { variantId: '8001', quantity: 1 }, KIRI)), '409 Every one has been claimed. Sorry, friend.');
  // 48 hours later it's let go straight away (before maintenance runs): Kiri can have them
  clock = NOW + 48 * HOUR + 1;
  assert.equal((await me(SAM)).offers[0].claim, null);
  assert.equal((await me(KIRI)).offers[0].unitsLeft, 3);
  assert.equal(claimState(lair.claimRow(second.data.claim.id), clock), 'released');
  const run = await maintenance();
  assert.deepEqual(run.data.offers, { released: 1, closed: 0, emailed: 0 });
  await settle();
  assert.ok(shop.deleted.includes('gid://shopify/DraftOrder/2'));
  assert.equal(lair.claimRow(second.data.claim.id).reason, 'expired');
  const kiri = await claim(o.id, { variantId: '8001', quantity: 3 }, KIRI);
  assert.equal(kiri.status, 200, said(kiri));
  // a claim never outlives its offer: on its last day, a claim lasts until it closes
  clock = at('2026-10-18', 6);
  const late = await claim(o.id, { variantId: '8001', quantity: 1 }, SAM);
  assert.equal(late.status, 200, said(late));
  assert.equal(late.data.claim.expiresAt, CLOSES);
});

test('offers: closing lets unpaid claims go and hides the offer; the closing time does the same; scheduled offers wait for their opening time', async () => {
  await members();
  const o = await offerFor([SAM, KIRI]);
  await openIt(o.id);
  const c = await claim(o.id, { variantId: '8001', quantity: 1 }, SAM);
  const closed = await call('POST', `offers/${o.id}/close`, {}, 'staff');
  assert.equal(closed.data.released, 1);
  assert.equal(closed.data.offer.status, 'closed');
  await settle();
  assert.ok(shop.deleted.includes(c.data.claim.checkoutUrl ? 'gid://shopify/DraftOrder/1' : ''));
  assert.deepEqual((await me(SAM)).offers, []);
  assert.equal(said(await claim(o.id, { variantId: '8001', quantity: 1 }, SAM)), '409 Early access to Riftbound booster box has closed.');
  assert.equal(said(await call('POST', `offers/${o.id}`, { message: 'x' }, 'staff')), `409 ${OFFER_MESSAGES.closed}`);
  // opening later: open now, but nobody sees it before its time; the email goes when it opens (maintenance)
  const later = await offerFor([SAM], { opens: '2026-10-10T09:00' });
  const mail = captureEmails();
  try {
    const opened = await openIt(later.id, { email: true });
    assert.equal(opened.offer.status, 'scheduled');
    assert.equal(opened.emailed, 0);
    assert.deepEqual((await me(SAM)).offers, []);
    assert.equal(said(await claim(later.id, { variantId: '8001', quantity: 1 }, SAM)), '409 Early access to Riftbound booster box opens Sat 10 Oct, 9am.');
    clock = at('2026-10-10', 9, 5);
    assert.equal((await me(SAM)).offers.length, 1);
    const run = await maintenance();
    assert.equal(run.data.offers.emailed, 1);
    await settle();
    assert.equal(mail.sent.filter((m) => m.subject === 'Early access: Riftbound booster box').length, 1);
    assert.equal((await maintenance()).data.offers, undefined, 'emailed once');
  } finally {
    mail.restore();
  }
  // its closing time passes: maintenance closes it
  const w = await claim(later.id, { variantId: '8001', quantity: 1 }, SAM);
  assert.equal(w.status, 200);
  clock = CLOSES + 1;
  assert.equal(offerState(lair.offerRow(later.id), clock), 'closed');
  const run = await maintenance();
  assert.deepEqual(run.data.offers, { released: 1, closed: 1, emailed: 0 });
});

test('offers: editing while open keeps the product and never goes below the units claimed; people with a claim stay on it', async () => {
  await members();
  const o = await offerFor([SAM, KIRI], { totalUnits: 5 });
  await openIt(o.id);
  await claim(o.id, { variantId: '8001', quantity: 2 }, SAM);
  assert.equal(said(await call('POST', `offers/${o.id}`, { totalUnits: 1 }, 'staff')), "422 2 units are claimed already, so the total can't go below 2.");
  assert.equal(said(await call('POST', `offers/${o.id}`, { productId: '7002', variantIds: ['8101'] }, 'staff')), `409 ${OFFER_MESSAGES.productChange}`);
  const edited = await call('POST', `offers/${o.id}`, { totalUnits: 2, customerIds: [KIRI], perPerson: 3 }, 'staff');
  assert.equal(edited.status, 200, said(edited));
  assert.equal(edited.data.notice, '1 person has a claim already, so they stay on it.');
  assert.deepEqual(edited.data.offer.people.map((p) => p.customerId).sort(), [SAM, KIRI].sort());
  assert.equal(edited.data.offer.unitsLeft, 0);
  assert.equal(edited.data.offer.perPerson, 3);
});

test('offers: the paid webhook marks the claim paid only for its own draft order; paid after it was let go, staff hear', async () => {
  await members();
  const o = await offerFor([SAM, KIRI]);
  await openIt(o.id);
  const c = (await claim(o.id, { variantId: '8001', quantity: 1 }, SAM)).data.claim;
  const draftId = 'gid://shopify/DraftOrder/1';
  const paid = (orderId, claimId = c.id) => internal('orders-paid', {
    id: orderId, admin_graphql_api_id: `gid://shopify/Order/${orderId}`, source_name: 'shopify_draft_order',
    note_attributes: [{ name: '_offer_claim', value: claimId }], line_items: [{ id: 1, sku: 'RB-BOX', quantity: 1, price: '219.00', properties: [{ name: '_offer_claim', value: claimId }] }],
  });
  // an order that isn't this claim's draft can't mark it
  shop.drafts[draftId].orderId = 'gid://shopify/Order/555';
  assert.equal((await paid(444)).status, 200);
  assert.equal(lair.claimRow(c.id).status, 'waiting');
  // a storefront order with the attribute typed in isn't a draft checkout
  await internal('orders-paid', { id: 555, admin_graphql_api_id: 'gid://shopify/Order/555', source_name: 'web', note_attributes: [{ name: '_offer_claim', value: c.id }], line_items: [] });
  assert.equal(lair.claimRow(c.id).status, 'waiting');
  assert.equal((await paid(555)).status, 200);
  assert.equal(lair.claimRow(c.id).status, 'paid');
  assert.equal(lair.claimRow(c.id).order_id, 'gid://shopify/Order/555');
  assert.equal((await paid(555)).status, 200, 'the same webhook again changes nothing');
  const view = (await me(SAM)).offers[0];
  assert.equal(view.claim.status, 'paid');
  assert.equal(view.bought, 1);
  const detail = (await call('GET', `offers/${o.id}`, null, 'staff')).data;
  assert.deepEqual(detail.offer.claimed, { paid: 1, waiting: 0, people: 1 });
  // Kiri's claim runs out, then she pays anyway: it's hers, and staff are told to check the stock
  const k = (await claim(o.id, { variantId: '8001', quantity: 1 }, KIRI)).data.claim;
  clock = NOW + 49 * HOUR;
  const mail = captureEmails();
  try {
    shop.drafts['gid://shopify/DraftOrder/2'].orderId = 'gid://shopify/Order/777';
    await paid(777, k.id);
    await settle();
    assert.equal(lair.claimRow(k.id).status, 'paid');
    assert.ok(mail.sent.some((m) => m.to === 'staff@dicegoblin.test' && /Early access paid late/.test(m.subject)));
  } finally {
    mail.restore();
  }
});

test('offers: Shopify failing to make the checkout lets the units go again and says so plainly', async () => {
  await members();
  const o = await offerFor([SAM], { totalUnits: 1, perPerson: 1 });
  await openIt(o.id);
  shop.failDraft = true;
  assert.equal(said(await claim(o.id, { variantId: '8001', quantity: 1 }, SAM)), "503 Shopify couldn't make your checkout just now. Try again in a minute.");
  shop.failDraft = false;
  assert.equal((await me(SAM)).offers[0].unitsLeft, 1);
  assert.equal((await claim(o.id, { variantId: '8001', quantity: 1 }, SAM)).status, 200);
});

test('offers: staff list them open first, with units left and the online-store warning', async () => {
  await members();
  const a = await offerFor([SAM]);
  const b = await offerFor([SAM], { productId: '7002', variantIds: ['8101'] });
  await openIt(b.id);
  const list = (await call('GET', 'offers', null, 'staff')).data.offers;
  assert.deepEqual(list.map((x) => [x.id, x.status]), [[b.id, 'open'], [a.id, 'draft']]);
  assert.equal(list[0].warning, ON_SALE_ONLINE);
  assert.equal(list[1].warning, null);
  assert.equal((await call('GET', 'offers', null, SAM)).status, 403);
});

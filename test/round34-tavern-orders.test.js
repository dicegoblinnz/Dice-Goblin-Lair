// Round 34a and 34b (contract v34-tavern): a drink ordered from a table goes on the member's tab as a locked line, and
// the staff's list shows what to make, with its recipe card, until it's done.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings } from '../src/core.js';
import { TAVERN_WORDS } from '../src/tavern.js';
import { TAVERN_MENU_WORDS, tavernSkus } from '../src/tavern-menu.js';
import { shopifyTabPrices } from './tab-prices.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const MIN = 60_000;
// Thursday 1 October 2026, 1pm in Auckland: the Lair is open (Thu 12:00-22:00 below)
const NOW = Date.UTC(2026, 9, 1, 0, 0);
const realNow = Date.now;
let now = NOW;

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
const TEST_HOURS = 'Mon closed\nTue 12:00-22:00\nWed 12:00-22:00\nThu 12:00-22:00\nFri 12:00-23:00\nSat 10:00-23:00\nSun 10:00-20:00';

let lair;
let catalogue;
async function call(method, path, body, customer = '') {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, 'X-Lair-Client': '203.0.113.7' },
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: response.status, data: await response.json() };
}
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();

/** Shopify's counter-only Tavern products: one variant a SKU, at the menu's price */
function tavernCatalogue() {
  return new Map(tavernSkus().map((s, i) => [s.sku, { variantId: String(900000 + i), price: s.price, title: s.title, variantTitle: 'Default Title', sellable: true }]));
}

beforeEach(() => {
  now = NOW;
  Date.now = () => now;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff' || id === 'caleb', gm: false });
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  catalogue = tavernCatalogue();
  lair.shopify.tavernVariants = async () => catalogue;
  shopifyTabPrices(lair);
});
afterEach(() => {
  Date.now = realNow;
});

/** A table's code, as its QR card carries it (staff list them) */
async function codeOf(table = 'T4') {
  const res = await call('GET', 'tavern/tables', null, 'staff');
  assert.equal(res.status, 200, said(res));
  // a QR card covers the tables next to each other, so find the card this table is on
  return res.data.tables.find((t) => t.tables.includes(table)).code;
}
const TARO = { item: 'taro-milk', options: {} };
const LEMONADE = { item: 'strawberry-lemonade', options: {} };
const tabOf = async (customer) => (await call('GET', 'me', null, customer)).data.tab;

test("the menu opens only from a table's code (its QR card); ordering is open only in opening hours", async () => {
  const code = await codeOf('T4');
  // Mo, 20 Nov 2026: "Make sure the link isn't able to be viewed unless someone is scanning the QR code"
  for (const path of ['tavern/menu', 'tavern/menu?t=', 'tavern/menu?t=NOPE1234']) {
    const plain = await call('GET', path);
    assert.deepEqual([plain.status, plain.data], [200, { locked: true, table: null }], path);
  }
  const seen = await call('GET', `tavern/menu?t=${code}`);
  assert.equal(seen.data.items.find((x) => x.id === 'taro-milk').price, 900);
  assert.equal(seen.data.open, true);
  assert.ok(!seen.data.locked && !JSON.stringify(seen.data).includes('scoops'), 'no recipes on the menu');

  const atTable = await call('GET', `tavern/menu?t=${code}`);
  assert.deepEqual(atTable.data.table, { id: 'T3 & T4', room: 'Common room', tables: ['T3', 'T4'] });

  now = NOW + 10 * HOUR; // 11pm: closed
  assert.equal((await call('GET', `tavern/menu?t=${code}`)).data.open, false);
});

test('an order needs someone logged in, a table code and the Lair open', async () => {
  const code = await codeOf();
  assert.equal(said(await call('POST', 'tavern/orders', { table: code, lines: [TARO] })), `401 ${TAVERN_WORDS.login}`);
  assert.equal(said(await call('POST', 'tavern/orders', { table: 'NOPE1234', lines: [TARO] }, 'sam')), `422 ${TAVERN_WORDS.table}`);
  assert.equal(said(await call('POST', 'tavern/orders', { table: code, lines: [] }, 'sam')), `422 ${TAVERN_MENU_WORDS.noLines}`);
  now = NOW + 10 * HOUR;
  assert.equal(said(await call('POST', 'tavern/orders', { table: code, lines: [TARO] }, 'sam')), `409 ${TAVERN_WORDS.closed}`);
  assert.equal(await tabOf('sam'), null);
});

test("an order goes on today's tab as locked lines at the Lair's prices, and My drinks shows it waiting", async () => {
  const code = await codeOf('T4');
  const res = await call('POST', 'tavern/orders', {
    table: code, lines: [{ item: 'taro-milk', options: { oat: true, price: 1 } }, LEMONADE],
  }, 'sam');
  assert.equal(res.status, 200, said(res));
  assert.equal(res.data.order.total, 900 + 100 + 800);
  assert.equal(res.data.order.table, 'T3 & T4');
  assert.deepEqual(res.data.order.drinks.map((d) => [d.name, d.status, d.price]), [['Taro Milk', 'waiting', 1000], ['Strawberry Lemonade', 'waiting', 800]]);
  assert.ok(!JSON.stringify(res.data).includes('scoops'), 'the recipe is for staff');

  const tab = await tabOf('sam');
  assert.equal(tab.status, 'open');
  assert.equal(tab.total, 1800);
  assert.deepEqual(tab.items.map((x) => [x.title, x.price, x.qty, x.locked]), [['Taro Milk', 900, 1, true], ['Oat milk', 100, 1, true], ['Strawberry Lemonade', 800, 1, true]]);

  const mine = await call('GET', 'tavern/mine', null, 'sam');
  assert.equal(mine.data.orders.length, 1);
  assert.equal(mine.data.orders[0].drinks.length, 2);
  assert.equal((await call('GET', 'tavern/mine', null, 'alex')).data.orders.length, 0);
});

test('the same drink ordered again is one tab line with a bigger count', async () => {
  const code = await codeOf();
  await call('POST', 'tavern/orders', { table: code, lines: [TARO] }, 'sam');
  await call('POST', 'tavern/orders', { table: code, lines: [TARO, TARO] }, 'sam');
  const tab = await tabOf('sam');
  assert.deepEqual(tab.items.map((x) => [x.title, x.qty]), [['Taro Milk', 3]]);
  assert.equal(tab.total, 2700);
});

test("My Lair's tab can't take a drink off: saving or clearing the tab keeps the locked lines", async () => {
  const code = await codeOf();
  await call('POST', 'tavern/orders', { table: code, lines: [TARO] }, 'sam');
  const taro = (await tabOf('sam')).items[0].variantId;
  // the page saves a snack, and sends the drink back too (as today's My Lair would)
  catalogue.get('TAVERN-X-OAT'); // (the catalogue is Shopify's: the tab prices the echo from it)
  lair.shopify.tabVariants = async (ids) => new Map(ids.map((id) => [id, id === '5001'
    ? { price: 450, title: 'Pocky', variantTitle: 'Strawberry', sellable: true }
    : { price: 900, title: 'Taro Milk', variantTitle: 'Default Title', sellable: true }]));
  let res = await call('POST', 'tab', { items: [{ variantId: '5001', qty: 1 }, { variantId: taro, qty: 1 }] }, 'sam');
  assert.equal(res.status, 200, said(res));
  assert.deepEqual(res.data.tab.items.map((x) => [x.title, x.qty, Boolean(x.locked)]), [['Pocky', 1, false], ['Taro Milk', 1, true]]);
  assert.equal(res.data.tab.total, 1350);
  // an empty save, then Clear: the snack goes, the drink stays
  res = await call('POST', 'tab', { items: [] }, 'sam');
  assert.deepEqual(res.data.tab.items.map((x) => x.title), ['Taro Milk']);
  await call('POST', 'tab', { items: [{ variantId: '5001', qty: 2 }] }, 'sam');
  res = await call('POST', 'tab/clear', null, 'sam');
  assert.deepEqual(res.data.tab.items.map((x) => [x.title, x.qty]), [['Taro Milk', 1]]);
  assert.equal(res.data.tab.total, 900);
});

test("a tab that's at the counter takes no more drinks until it's paid", async () => {
  const code = await codeOf();
  await call('POST', 'tavern/orders', { table: code, lines: [TARO] }, 'sam');
  lair.posTabAdded((await tabOf('sam')).id);
  assert.equal(said(await call('POST', 'tavern/orders', { table: code, lines: [TARO] }, 'sam')), `409 ${TAVERN_WORDS.atCounter}`);
  assert.equal((await call('GET', 'tavern/mine', null, 'sam')).data.orders.length, 1);
});

test("a drink Shopify doesn't have, or prices differently, isn't ordered and nothing goes on the tab", async () => {
  const code = await codeOf();
  catalogue.get('TAVERN-X-OAT').price = 150;
  assert.equal(said(await call('POST', 'tavern/orders', { table: code, lines: [{ item: 'taro-milk', options: { oat: true } }] }, 'sam')), `503 ${TAVERN_WORDS.notReady}`);
  catalogue.delete('TAVERN-X-OAT');
  assert.equal(said(await call('POST', 'tavern/orders', { table: code, lines: [{ item: 'taro-milk', options: { oat: true } }] }, 'sam')), `503 ${TAVERN_WORDS.notReady}`);
  lair.shopify.tavernVariants = async () => { throw new Error('Shopify is down'); };
  lair.tavernVariantCache = null;
  assert.equal(said(await call('POST', 'tavern/orders', { table: code, lines: [TARO] }, 'sam')), `503 ${TAVERN_WORDS.notReady}`);
  assert.equal(await tabOf('sam'), null);
  assert.equal((await call('GET', 'tavern/queue', null, 'staff')).data.orders.length, 0);
});

test("the staff's list: drinks to make, oldest first, each with its recipe card; On it, then Done", async () => {
  const code4 = await codeOf('T4');
  const code7 = await codeOf('T7');
  lair.touchMember('sam', { name: 'Sam Jones' });
  assert.equal(said(await call('GET', 'tavern/queue', null, 'sam')), `403 ${TAVERN_WORDS.team}`);
  assert.equal(said(await call('GET', 'tavern/queue')), `401 ${TAVERN_WORDS.staffLogin}`);

  const first = (await call('POST', 'tavern/orders', { table: code4, lines: [{ item: 'taro-milk', options: { note: 'birthday!' } }] }, 'sam')).data.order;
  now = NOW + 3 * MIN;
  const second = (await call('POST', 'tavern/orders', { table: code7, lines: [LEMONADE, TARO] }, 'alex')).data.order;
  now = NOW + 5 * MIN;

  let q = (await call('GET', 'tavern/queue', null, 'staff')).data;
  assert.deepEqual(q.orders.map((o) => [o.id, o.table, o.waited]), [[first.id, 'T3 & T4', 5 * MIN], [second.id, 'T7 & T8', 2 * MIN]]);
  assert.equal(q.orders[0].name, 'Sam');
  assert.equal(q.ringing, 2);
  const card = q.orders[0].drinks[0].recipe;
  assert.equal(card.title, 'Taro Milk');
  assert.equal(card.note, 'birthday!');
  assert.ok(card.ingredients.some((i) => i.what === 'Creamer' && i.amount === '3 scoops'));
  assert.ok(card.ingredients.some((i) => i.what === 'Taro powder' && i.amount === '2 scoops'), "Mo's creamy range: 3 scoops of creamer, 2 of the flavour");
  assert.ok(card.steps.length >= 3);

  // On it: the ring stops for that order, and the member sees it's being made
  let res = await call('POST', `tavern/orders/${first.id}/on-it`, null, 'sam');
  assert.equal(res.status, 403);
  res = await call('POST', `tavern/orders/${first.id}/on-it`, null, 'staff');
  assert.equal(res.status, 200, said(res));
  q = (await call('GET', 'tavern/queue', null, 'staff')).data;
  assert.equal(q.ringing, 1);
  assert.equal(q.orders[0].drinks[0].status, 'making');
  assert.equal((await call('GET', 'tavern/mine', null, 'sam')).data.orders[0].drinks[0].status, 'making');

  // Done: it leaves the list; an order leaves when its last drink is done
  res = await call('POST', `tavern/drinks/${q.orders[0].drinks[0].id}/done`, null, 'staff');
  assert.equal(res.status, 200, said(res));
  res = await call('POST', `tavern/drinks/${second.drinks[0].id}/done`, null, 'staff');
  q = (await call('GET', 'tavern/queue', null, 'staff')).data;
  assert.deepEqual(q.orders.map((o) => o.id), [second.id]);
  assert.deepEqual(q.orders[0].drinks.map((d) => d.name), ['Taro Milk']);
  assert.equal(q.ringing, 0, 'a drink done is someone on it');
  assert.equal((await call('GET', 'tavern/mine', null, 'sam')).data.orders[0].drinks[0].status, 'done');
  // done twice is fine, and the tab still holds every drink: made drinks are paid for
  assert.equal((await call('POST', `tavern/drinks/${second.drinks[0].id}/done`, null, 'staff')).status, 200);
  assert.equal((await tabOf('alex')).total, 1700);
});

test('staff can cancel a drink before it is made: it comes off the tab; a made drink stays', async () => {
  const code = await codeOf();
  const order = (await call('POST', 'tavern/orders', { table: code, lines: [{ item: 'taro-milk', options: { oat: true } }, TARO, LEMONADE] }, 'sam')).data.order;
  assert.equal((await call('POST', `tavern/drinks/${order.drinks[0].id}/cancel`, null, 'sam')).status, 403);
  let res = await call('POST', `tavern/drinks/${order.drinks[0].id}/cancel`, null, 'staff');
  assert.equal(res.status, 200, said(res));
  let tab = await tabOf('sam');
  assert.deepEqual(tab.items.map((x) => [x.title, x.qty]), [['Taro Milk', 1], ['Strawberry Lemonade', 1]]);
  assert.equal(tab.total, 1700);
  assert.equal((await call('GET', 'tavern/mine', null, 'sam')).data.orders[0].drinks[0].status, 'cancelled');
  assert.equal((await call('GET', 'tavern/queue', null, 'staff')).data.orders[0].drinks.length, 2);

  await call('POST', `tavern/drinks/${order.drinks[1].id}/done`, null, 'staff');
  assert.equal(said(await call('POST', `tavern/drinks/${order.drinks[1].id}/cancel`, null, 'staff')), `409 ${TAVERN_WORDS.madeAlready}`);

  // at the counter already: it can't change under the till, so the till takes it off
  lair.posTabAdded(tab.id);
  assert.equal(said(await call('POST', `tavern/drinks/${order.drinks[2].id}/cancel`, null, 'staff')), `409 ${TAVERN_WORDS.cancelAtCounter}`);
  tab = await tabOf('sam');
  assert.equal(tab.total, 1700);
});

test('the last drink cancelled empties the tab', async () => {
  const code = await codeOf();
  const order = (await call('POST', 'tavern/orders', { table: code, lines: [TARO] }, 'sam')).data.order;
  await call('POST', `tavern/drinks/${order.drinks[0].id}/cancel`, null, 'staff');
  assert.equal(await tabOf('sam'), null);
  assert.equal((await call('GET', 'tavern/queue', null, 'staff')).data.orders.length, 0);
});

test('the Rush sign: staff put it out, only the quick drinks can be ordered, and it comes in by itself the next day', async () => {
  const code = await codeOf();
  assert.equal((await call('POST', 'tavern/rush', { on: true }, 'sam')).status, 403);
  const res = await call('POST', 'tavern/rush', { on: true }, 'staff');
  assert.equal(res.data.rush, true);
  assert.equal((await call('GET', `tavern/menu?t=${code}`)).data.rush, true);
  assert.equal(said(await call('POST', 'tavern/orders', { table: code, lines: [{ item: 'cookies-cream-shake', options: {} }] }, 'sam')), `422 ${TAVERN_MENU_WORDS.rush}`);
  assert.equal((await call('POST', 'tavern/orders', { table: code, lines: [TARO] }, 'sam')).status, 200);
  assert.equal((await call('POST', 'tavern/rush', { on: false }, 'staff')).data.rush, false);
  await call('POST', 'tavern/rush', { on: true }, 'staff');
  now = NOW + 24 * HOUR;
  assert.equal((await call('GET', `tavern/menu?t=${code}`)).data.rush, false);
  assert.equal(time.key(now), '2026-10-02');
});

test("every QR card has its own code, staff only, and it stays the same", async () => {
  assert.equal((await call('GET', 'tavern/tables', null, 'sam')).status, 403);
  const a = (await call('GET', 'tavern/tables', null, 'staff')).data.tables;
  const b = (await call('GET', 'tavern/tables', null, 'staff')).data.tables;
  assert.equal(a.length, 10, 'twenty tables, two to a card');
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map((t) => t.code)).size, 10);
  assert.match(a[0].code, /^[A-HJ-NP-Z2-9]{8}$/);
});

test("a drink nobody ever made stops ringing: the staff's list holds the last 12 hours only", async () => {
  // review, 20 Nov 2026: an order left on the list at closing rang every phone the next morning, for good
  const code = await codeOf();
  await call('POST', 'tavern/orders', { table: code, lines: [TARO] }, 'sam');
  now = NOW + 11 * HOUR;
  let q = (await call('GET', 'tavern/queue', null, 'staff')).data;
  assert.deepEqual([q.orders.length, q.ringing], [1, 1], 'a late night past midnight is still on the list');
  now = NOW + 12 * HOUR + MIN;
  q = (await call('GET', 'tavern/queue', null, 'staff')).data;
  assert.deepEqual([q.orders.length, q.ringing], [0, 0]);
  // it's still on their tab: the till takes it off if it was never made
  assert.equal((await call('GET', 'tavern/mine', null, 'sam')).status, 200);
});

test('one QR card for two tables next to each other, one for the main table of three, one for a room with a single table', async () => {
  // Mo, 20 Nov 2026: "have one code per two tables next to each other the main table with 3 on it is one code and the
  // fancy room is another code"
  const rooms = [
    { id: 'main', name: 'Main room', code: 'T', tables: 8, seats: 4, order: 1 },
    { id: 'fancy', name: 'Fancy room', code: 'F', tables: 1, seats: 6, order: 2 },
  ];
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: 'T1-T3' }, rooms, []);
  const spots = (await call('GET', 'tavern/tables', null, 'staff')).data.tables;
  assert.deepEqual(spots.map((s) => [s.id, s.tables, s.room]), [
    ['T1, T2 & T3', ['T1', 'T2', 'T3'], 'Main room'],
    ['T4 & T5', ['T4', 'T5'], 'Main room'],
    ['T6 & T7', ['T6', 'T7'], 'Main room'],
    ['T8', ['T8'], 'Main room'], // the odd one out keeps a card of its own
    ['F1', ['F1'], 'Fancy room'],
  ]);
  assert.equal(new Set(spots.map((s) => s.code)).size, 5);
  for (const s of spots) assert.match(s.code, /^[A-HJ-NP-Z2-9]{8}$/);
  // the same cards and codes every time
  assert.deepEqual((await call('GET', 'tavern/tables', null, 'staff')).data.tables, spots);
  // an order from the pair's card names both tables to the staff
  const order = await call('POST', 'tavern/orders', { table: spots[1].code, lines: [TARO] }, 'sam');
  assert.equal(order.data.order.table, 'T4 & T5');
  assert.equal((await call('GET', 'tavern/queue', null, 'staff')).data.orders[0].table, 'T4 & T5');
  // a code from before the cards were paired (the pair's second table had its own) opens nothing now
  lair.sql.exec("INSERT INTO tavern_tables (table_id, code, made_at) VALUES ('T5', 'OLDCODE5', 1)");
  assert.deepEqual((await call('GET', 'tavern/menu?t=OLDCODE5')).data, { locked: true, table: null });
  assert.equal(said(await call('POST', 'tavern/orders', { table: 'OLDCODE5', lines: [TARO] }, 'sam')), `422 ${TAVERN_WORDS.table}`);
});

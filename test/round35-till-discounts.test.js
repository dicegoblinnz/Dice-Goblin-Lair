// Round 35, discounts on the till in dollars (contract v35-till-discounts). Mo (10 Nov 2026): "for the discount make it
// go off actual dollar value not % thanks no need to say no more than 25% but do not accept anything lower than 25%
// unless it is done on the item previously thanks. Actually make it 20%" (asked when something may sell for more than
// 20% off, he picked "Already on sale"). A discount is dollars off each one of a shop product; no item sells for less
// than 80% of its full price because of one (its compare-at price when it's on sale); a line on a deal can't have one
// too; Shopify's own figures are what's checked. Approving is round 34's (test/round34-till-discounts.test.js).
// The words are written out here as the contract has them, not taken from the code.
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { ShopifyAdmin, TILL_API_VERSION, tillDraftInput, tillFiguresOf } from '../src/shopify.js';
import { TILL_DISCOUNT_WORDS as D, TILL_DISCOUNT_MAX, tillDiscountIn, tillDiscountMost, tillOffIn } from '../src/till-discounts.js';
import { tillBasketIn } from '../src/till-sales.js';

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

let background = [];
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
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: (p) => background.push(p) };
}
/** Everything the Lair left running in the background, finished */
const settle = async () => {
  while (background.length) await background.shift();
};

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];
const EVENTS = [{ id: 'quiz', title: 'Trivia night', start: at(DAY, 18), end: at(DAY, 20), tables: '', capacity: 20, entryFee: 500 }];
// Mo (the owner); helpers Hemi (Check-in) and Tama (Library only: sales only on the till); members Mia and Kai
const OWNER = '9001';
const HEMI = '9102';
const TAMA = '9103';
const MIA = '6001';
const KAI = '6002';
// Rua: a helper with Money, who can approve discounts
const RUA = '9104';

/* ---------- the shop, as the fake Shopify has it ---------- */
const PRODUCTS = {
  oakie: { id: '101', title: 'Oakie Doakie Translucent RPG Dice Set', type: 'Dice & Accessories', vendor: 'Oakie Doakie Dice', status: 'ACTIVE', giftCard: false, dice: true },
  wave: { id: '102', title: 'Sea Wave Blossom D20 (33 mm)', type: 'Dice & Accessories', vendor: 'Dice Goblin NZ', status: 'ACTIVE', giftCard: false, dice: true },
  booster: { id: '103', title: 'Riftbound Radiance', type: 'Trading Card Games', vendor: 'Riot Games', status: 'ACTIVE', giftCard: false, dice: false },
  session: { id: '104', title: 'Session', type: '', vendor: 'Dice Goblin NZ', status: 'UNLISTED', giftCard: false, dice: false },
  drinks: { id: '105', title: 'Drinks', type: 'Food & Drink', vendor: 'Dice Goblin NZ', status: 'ACTIVE', giftCard: false, dice: false },
  old: { id: '106', title: 'Old promo', type: '', vendor: 'Dice Goblin NZ', status: 'ARCHIVED', giftCard: false, dice: false },
  libraryCopy: { id: '107', title: 'Catan (Library)', type: 'Board Games', vendor: 'Catan Studio', status: 'ACTIVE', giftCard: false, dice: false },
  card: { id: '108', title: 'Gift card', type: '', vendor: 'Dice Goblin NZ', status: 'ACTIVE', giftCard: true, dice: false },
  // (10 Nov 2026) different things on one barcode: two sets' boosters, and a dice set whose colours share one
  sparks: { id: '109', title: 'Pokemon Surging Sparks Booster', type: 'Trading Card Games', vendor: 'Pokemon', status: 'ACTIVE', giftCard: false, dice: false },
  prism: { id: '110', title: 'Pokemon Prismatic Evolutions Booster', type: 'Trading Card Games', vendor: 'Pokemon', status: 'ACTIVE', giftCard: false, dice: false },
  sparksCopy: { id: '111', title: 'Pokemon Surging Sparks Booster (Library)', type: 'Trading Card Games', vendor: 'Pokemon', status: 'ACTIVE', giftCard: false, dice: false },
  glow: { id: '112', title: 'Glow Dice Set', type: 'Dice & Accessories', vendor: 'Dice Goblin NZ', status: 'ACTIVE', giftCard: false, dice: true },  // round 35: a drink at half price, a game with a little off, a game at full price and a lolly too cheap for 20% to be a cent
  coke: { id: '113', title: 'Coca-Cola – Half Price (Flat)', type: 'Drinks', vendor: 'Dice Goblin NZ', status: 'ACTIVE', giftCard: false, dice: false },
  barrage: { id: '114', title: 'Barrage', type: 'Board Games', vendor: 'Cranio Creations', status: 'ACTIVE', giftCard: false, dice: false },
  wonders: { id: '115', title: '7 Wonders', type: 'Board Games', vendor: 'Repos Production', status: 'ACTIVE', giftCard: false, dice: false },
  lolly: { id: '116', title: 'Lolly', type: 'Food & Drink', vendor: 'Dice Goblin NZ', status: 'ACTIVE', giftCard: false, dice: false },
};
const VARIANTS = {
  5011: { product: 'oakie', id: '5011', title: 'Green', sku: null, barcodes: ['4056133701068'], price: 1599, tracked: true, stock: 35, oversell: false },
  5012: { product: 'wave', id: '5012', title: 'Default Title', sku: 'DGD-F2-D20-33', barcodes: [], price: 5000, tracked: true, stock: 0, oversell: false },
  5013: { product: 'booster', id: '5013', title: 'Booster Pack', sku: null, barcodes: ['810155276195'], price: 1100, tracked: true, stock: 12, oversell: false },
  5014: { product: 'session', id: '5014', title: 'RPG Session', sku: 'LAIR-SESSION-RPG', barcodes: ['31283123850'], price: 1500, tracked: false, stock: null, oversell: false },
  5015: { product: 'drinks', id: '5015', title: '$3 Drink', sku: null, barcodes: [], price: 300, tracked: false, stock: null, oversell: false },
  5016: { product: 'old', id: '5016', title: 'Default Title', sku: 'OLD-1', barcodes: ['9999000011'], price: 500, tracked: false, stock: null, oversell: false },
  5017: { product: 'libraryCopy', id: '5017', title: 'Default Title', sku: 'DGL34-M011', barcodes: [], price: 0, tracked: true, stock: 1, oversell: false },
  5018: { product: 'card', id: '5018', title: '$50', sku: null, barcodes: ['5555000011'], price: 5000, tracked: false, stock: null, oversell: false },
  5019: { product: 'sparks', id: '5019', title: 'Default Title', sku: 'PKM-SSP-BP', barcodes: ['820650857442'], price: 1000, tracked: true, stock: 20, oversell: false },
  5020: { product: 'prism', id: '5020', title: 'Default Title', sku: 'PKM-PRE-BP', barcodes: ['0820650857442'], price: 1400, tracked: true, stock: 0, oversell: false },
  5021: { product: 'sparksCopy', id: '5021', title: 'Default Title', sku: null, barcodes: ['820650857442'], price: 0, tracked: true, stock: 1, oversell: false },
  5022: { product: 'glow', id: '5022', title: 'Green', sku: null, barcodes: ['6900000000123'], price: 2000, tracked: true, stock: 3, oversell: false },
  5023: { product: 'glow', id: '5023', title: 'Blue', sku: null, barcodes: ['6900000000123'], price: 2000, tracked: true, stock: 2, oversell: false },  // (was: Shopify's compare-at price)
  5024: { product: 'coke', id: '5024', title: 'Classic', sku: null, barcodes: [], price: 300, was: 600, tracked: false, stock: null, oversell: false },
  5025: { product: 'barrage', id: '5025', title: 'Default Title', sku: null, barcodes: [], price: 9000, was: 10000, tracked: true, stock: 2, oversell: false },
  5026: { product: 'wonders', id: '5026', title: 'Default Title', sku: null, barcodes: [], price: 10500, tracked: true, stock: 4, oversell: false },
  5027: { product: 'lolly', id: '5027', title: 'Default Title', sku: null, barcodes: [], price: 4, tracked: false, stock: null, oversell: false },
};
const match = (id) => ({ product: { ...PRODUCTS[VARIANTS[id].product] }, variant: { ...VARIANTS[id] } });

/**
 * Shopify's figures as the fake works them out, the way the real one did when asked (draftOrderCalculate, 11 Nov 2026):
 * the shop's prices; a line's staff discount, dollars off each one of it (FIXED_AMOUNT: 2 at $5 off is $10, never more
 * than the price) or a percent of the line rounded down to the cent (PERCENTAGE: 2 x $15.99 at 20% is $6.39); then every
 * third dice free, at what it costs after its line's discount, its amount on the line it came from; a variant's
 * compare-at price (was); and GST. shop.staffExtra adds cents to each staff discount (Shopify going wrong).
 */
function figuresFor(lines) {
  const out = lines.map((l) => {
    if (l.variantId) {
      const v = VARIANTS[l.variantId];
      const unit = l.cents ?? v.price;
      const total = unit * l.qty;
      const taken = l.off ? Math.min(l.off, unit) * l.qty : l.discount ? Math.floor((total * l.discount) / 100) : null;
      const staff = taken == null ? null : taken + (shop?.staffExtra || 0);
      return {
        uuid: l.uuid, title: PRODUCTS[v.product].title, variantTitle: v.title === 'Default Title' ? '' : v.title, variantId: l.variantId, qty: l.qty, unit, total,
        paid: total - (staff || 0), custom: false, attributes: l.attributes || {}, ...(staff != null ? { staff } : {}), ...(v.was > unit ? { was: v.was } : {}),
        dice: PRODUCTS[v.product].dice && l.cents == null, each: Math.round((total - (staff || 0)) / l.qty),
      };
    }
    return { uuid: l.uuid, title: l.title, variantTitle: '', variantId: null, qty: 1, unit: l.cents, total: l.cents, paid: l.cents, custom: true, attributes: l.attributes || {}, dice: false, each: l.cents };
  });
  const units = [];
  out.forEach((l, i) => {
    if (l.dice) for (let n = 0; n < l.qty; n += 1) units.push({ unit: l.each, line: i });
  });
  units.sort((x, y) => y.unit - x.unit);
  let deal = 0;
  for (let i = 2; i < units.length; i += 3) {
    deal += units[i].unit;
    out[units[i].line].paid -= units[i].unit;
  }
  const subtotal = out.reduce((sum, l) => sum + l.total, 0);
  const staffTotal = out.reduce((sum, l) => sum + (l.staff || 0), 0);
  const total = subtotal - deal - staffTotal;
  return {
    subtotal, discounts: deal ? [{ title: 'Buy any 2 dice, get the 3rd free', amount: deal }] : [], total, gst: Math.round((total * 3) / 23), taxIncluded: true,
    lines: out.map(({ dice, each, ...l }) => l),
  };
}

let lair;
let shop;
function fakeShopify() {
  shop = { asked: [], drafts: [], deleted: [], completed: [], fulfilled: [], calculated: [], down: false, completeFails: 0, loseComplete: false, fulfilDenied: false, orderTotal: null };
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.tillVariants = async (code) => {
    shop.asked.push(code);
    if (shop.down) throw new Error('Shopify is down');
    // (Shopify's search ignores case, and finds a barcode in its other forms)
    return Object.keys(VARIANTS)
      .filter((id) => VARIANTS[id].barcodes.some((b) => b.replace(/^0+/, '') === code.replace(/^0+/, '')) || String(VARIANTS[id].sku || '').toLowerCase() === code.toLowerCase())
      .map(match);
  };
  lair.shopify.tillSearch = async (words) => {
    if (shop.down) throw new Error('Shopify is down');
    return Object.keys(PRODUCTS)
      .filter((key) => words.every((w) => PRODUCTS[key].title.toLowerCase().includes(w.toLowerCase())))
      .map((key) => ({ ...PRODUCTS[key], variants: Object.values(VARIANTS).filter((v) => v.product === key).map((v) => ({ ...v })) }));
  };
  lair.shopify.tillCalculate = async ({ lines }) => {
    if (shop.down) throw new Error('Shopify is down');
    shop.calculated.push(lines);
    return figuresFor(lines);
  };
  lair.shopify.createTillDraft = async (input) => {
    if (shop.down) throw new Error('Shopify is down');
    const draft = { id: `gid://shopify/DraftOrder/${900 + shop.drafts.length}`, input, figures: figuresFor(input.lines), order: null };
    shop.drafts.push(draft);
    return { id: draft.id, ready: true, ...draft.figures };
  };
  lair.shopify.tillDraft = async (id) => {
    const d = shop.drafts.find((x) => x.id === id && !shop.deleted.includes(id));
    return d ? { id, status: d.order ? 'COMPLETED' : 'OPEN', ready: true, order: d.order, ...d.figures } : null;
  };
  lair.shopify.completePaidDraft = async (id) => {
    const d = shop.drafts.find((x) => x.id === id && !shop.deleted.includes(id));
    if (shop.completeFails > 0) {
      shop.completeFails -= 1;
      throw new Error('Shopify is down');
    }
    if (!d) return { order: null, status: null, errors: ['Draft order not found'] };
    if (d.order) return { order: null, status: 'COMPLETED', errors: ['This draft order has already been completed'] };
    d.order = { id: `gid://shopify/Order/${8000 + shop.completed.length}`, name: `#${3000 + shop.completed.length}`, total: shop.orderTotal ?? d.figures.total };
    shop.completed.push(id);
    if (shop.loseComplete) throw new Error('No answer from Shopify');
    return { order: d.order, status: 'COMPLETED', errors: [] };
  };
  lair.shopify.draftOrderState = async (id) => {
    const d = shop.drafts.find((x) => x.id === id && !shop.deleted.includes(id));
    return d ? { id, status: d.order ? 'COMPLETED' : 'OPEN', ready: true, order: d.order } : null;
  };
  lair.shopify.deleteDraftIfOpen = async (id) => {
    const d = shop.drafts.find((x) => x.id === id);
    if (!d || d.order) return false;
    shop.deleted.push(id);
    return true;
  };
  lair.shopify.fulfilTillOrder = async (orderId, location) => {
    if (shop.fulfilDenied) throw new Error('Shopify API: Access denied for fulfillmentOrders field. Required access: `read_merchant_managed_fulfillment_orders` access scope.');
    shop.fulfilled.push({ orderId, location });
    return { fulfilled: 1, moved: 0 };
  };
}

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
// someone on the till with their own PIN (the counter tablet is logged in as the owner's account)
const onTill = async (id, pin = '2580', as = OWNER) => {
  const u = ok(await call('POST', 'till/unlock', { id, pin: '1234' }, as));
  ok(await call('POST', 'till/pin', { token: u.token, pin }, as));
  return u.token;
};
const TILL = 'counter-tablet-1';
const pay = (body, as = OWNER) => call('POST', 'till/pay', { till: TILL, ...body }, as);
const paid = (body, as = OWNER) => call('POST', 'till/paid', body, as);
const saleRow = (id) => lair.sql.exec('SELECT * FROM till_sales WHERE id = ?', id).one();

beforeEach(async () => {
  background = [];
  globalThis.fetch = async (url) => {
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'dice-goblin.myshopify.com' });
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.searchCustomers = async () => [{ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }];
  lair.shopify.storeCreditBalance = async () => 0;
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  fakeShopify();
  lair.alerts = [];
  lair.notifyStaff = (subject) => lair.alerts.push(subject);
  lair.mail = async () => ({ ok: true });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, EVENTS);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  for (const [id, name, perms] of [[HEMI, 'Hemi Walker', ['checkin']], [TAMA, 'Tama Rewi', ['library']], [RUA, 'Rua Parata', ['checkin', 'money']]]) {
    ok(await call('POST', 'team', { customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, perms }, OWNER));
  }
  for (const [id, name] of [[MIA, 'Mia Tamaki'], [KAI, 'Kai Tane']]) {
    lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
  }
});

afterEach(() => {
  Date.now = realNow;
});

/** Mia's table for 2 at 6pm tonight, paid at the counter → the booking */
async function miasTable() {
  return ok(await call('POST', 'bookings', { kind: 'table', tables: ['T1'], start: at(DAY, 18), end: at(DAY, 20), people: 2, name: 'Mia', email: 'mia@example.com', phone: '021 555 0100', pay: 'day' }, MIA)).booking;
}

const BOOSTER = '5013'; // Riftbound Radiance booster, $11, not dice: it can come down by $2.20
const OAKIE = '5011'; // a dice set, $15.99, in the dice deal: $3.19
const DRINK = '5015'; // a $3 drink: 60c
const COKE = '5024'; // $3, was $6: on sale already
const BARRAGE = '5025'; // $90, was $100: $10
const WONDERS = '5026'; // $105: $21
const LOLLY = '5027'; // 4c
/** A fresh PIN from Rua (Money), as the till's approval asks for one: unlocking gives the token that approves */
const approve = async (id = RUA, pin = '4711') => ok(await call('POST', 'till/unlock', { id, pin }, OWNER)).token;
const price = (lines, extra = {}) => call('POST', 'till/price', { lines, ...extra }, OWNER);
const refused = (status, words) => (e) => e.status === status && e.message === words;

/* ---------------- the rule ---------------- */
test('round 35: a discount is dollars off each one, in whole cents', () => {
  assert.equal(tillOffIn(500), 500);
  assert.equal(tillOffIn(1), 1);
  assert.equal(tillOffIn('250'), 250);
  for (const none of [null, undefined, '', 0, '0']) assert.equal(tillOffIn(none), null);
  // never dollars as text ("5.00" is not 5 cents), a part of a cent, less than nothing, or a typo of thousands
  for (const bad of [-5, 2.5, 'five', '5.00', '$5', Infinity, NaN, 1_000_001, true, [500], { cents: 500 }]) {
    assert.throws(() => tillOffIn(bad), refused(400, 'A discount is dollars and cents off each item.'), String(bad));
  }
});

test('round 35: no item sells for less than 80% of its full price because of a discount', () => {
  assert.equal(TILL_DISCOUNT_MAX, 20);
  // at full price: up to 20% of it, rounded down to the cent (the contract's $59.99: $11.99)
  assert.equal(tillDiscountMost(5999), 1199);
  assert.equal(tillDiscountMost(1100), 220);
  assert.equal(tillDiscountMost(10500), 2100);
  assert.equal(tillDiscountMost(1599), 319);
  // on sale: only as far as 80% of what it was ($100, now $90: $10)
  assert.equal(tillDiscountMost(9000, 10000), 1000);
  assert.equal(tillDiscountMost(8500, 10000), 500);
  // already at or under 80% of what it was: none ($6, now $3)
  assert.equal(tillDiscountMost(8000, 10000), 0);
  assert.equal(tillDiscountMost(300, 600), 0);
  // a compare-at price that isn't above the price is no sale
  assert.equal(tillDiscountMost(1000, 900), 200);
  assert.equal(tillDiscountMost(1000, 1000), 200);
  assert.equal(tillDiscountMost(1000, null), 200);
  // too cheap for 20% to be a cent
  assert.equal(tillDiscountMost(4), 0);
  assert.equal(tillDiscountMost(5), 1);
  assert.equal(tillDiscountMost(0), 0);
  // every price, on sale or not: the most is as far as 80% of the full price goes, and not a cent further
  for (let unit = 0; unit <= 4000; unit += 7) {
    for (const was of [null, unit, unit + 1, Math.round(unit * 1.1), Math.round(unit * 1.25), Math.round(unit * 1.26), unit * 2]) {
      const full = Math.max(unit, was || 0);
      const most = tillDiscountMost(unit, was);
      assert.ok(Number.isInteger(most) && most >= 0 && most <= unit, `${unit} was ${was}: ${most}`);
      assert.ok((unit - most) * 100 >= full * 80 || most === 0, `${unit} was ${was}: ${most} goes under 80%`);
      assert.ok(most === unit || (unit - most - 1) * 100 < full * 80, `${unit} was ${was}: ${most} could be a cent more`);
    }
  }
});

test("round 35: only the shop's products take dollars off, one discount a product", () => {
  assert.deepEqual(tillBasketIn([{ key: 'a', variantId: BOOSTER, qty: 2, off: 200 }]).items, [{ key: 'a', variantId: BOOSTER, qty: 2, off: 200 }]);
  const notProduct = refused(400, 'Discounts are for things from the shop. Bookings and tabs keep their price.');
  assert.throws(() => tillBasketIn([{ key: 'b', booking: 'MT-OWLBEAR-17', off: 200 }]), notProduct);
  assert.throws(() => tillBasketIn([{ key: 't', tab: 'tab_1', off: 200 }]), notProduct);
  const mistake = refused(400, "Something in the basket didn't look right. Take it out and add it again.");
  // dollars and a percent on one line
  assert.throws(() => tillBasketIn([{ variantId: BOOSTER, qty: 1, off: 200, discount: 10 }]), mistake);
  // the same product twice is one line: with two different discounts it's a mistake
  assert.throws(() => tillBasketIn([{ variantId: BOOSTER, qty: 1, off: 200 }, { variantId: BOOSTER, qty: 1 }]), mistake);
  assert.throws(() => tillBasketIn([{ variantId: BOOSTER, qty: 1 }, { variantId: BOOSTER, qty: 1, off: 200 }]), mistake);
  assert.throws(() => tillBasketIn([{ variantId: BOOSTER, qty: 1, off: 200 }, { variantId: BOOSTER, qty: 1, off: 100 }]), mistake);
  assert.throws(() => tillBasketIn([{ variantId: BOOSTER, qty: 1, off: 200 }, { variantId: BOOSTER, qty: 1, discount: 10 }]), mistake);
  assert.deepEqual(tillBasketIn([{ variantId: BOOSTER, qty: 1, off: 200 }, { variantId: BOOSTER, qty: 1, off: 200 }]).items, [{ key: `v:${BOOSTER}`, variantId: BOOSTER, qty: 2, off: 200 }]);
  // an amount that isn't whole cents
  assert.throws(() => tillBasketIn([{ variantId: BOOSTER, qty: 1, off: 2.5 }]), refused(400, 'A discount is dollars and cents off each item.'));
});

/* ---------------- what it comes to ---------------- */
test('round 35: the price shows the dollars off straight away, what each thing could come down by, and that it needs approving', async () => {
  const table = await miasTable();
  const answer = ok(await price([{ key: 'b', variantId: BOOSTER, qty: 2, off: 200 }, { key: 'd', variantId: DRINK, qty: 1 }, { key: 'bk', booking: table.ref }], { person: MIA }));
  const lines = answer.price.lines;
  // two boosters at $2 off each is $4 off
  assert.equal(answer.price.subtotal, 2200 + 300 + lines[2].total);
  assert.deepEqual(answer.price.discounts, [{ title: 'Staff discount', amount: 400 }]);
  assert.equal(answer.price.total, answer.price.subtotal - 400);
  assert.equal(answer.price.needsOk, true);
  assert.equal(answer.price.staffDiscount, 400);
  assert.deepEqual(lines[0].discount, { each: 200, amount: 400 });
  // what a discount could take off each one: the booster $2.20, the drink 60c; a booking keeps its price
  assert.equal(lines[0].most, 220);
  assert.equal(lines[1].discount, undefined);
  assert.equal(lines[1].most, 60);
  assert.equal(lines[2].booking, table.ref);
  assert.equal(lines[2].most, undefined);
  // with no discount, nothing about approving; things on sale say how far they can still come down
  const plain = ok(await price([{ key: 'c', variantId: COKE, qty: 1 }, { key: 'g', variantId: BARRAGE, qty: 1 }])).price;
  assert.equal(plain.needsOk, undefined);
  assert.deepEqual(plain.lines.map((l) => l.most), [0, 1000]);
  // and what they were before the sale; something at full price has no "was"
  assert.deepEqual(plain.lines.map((l) => l.was), [600, 10000]);
  assert.equal(lines[0].was, undefined);
  assert.equal(lines[2].was, undefined);
});

test('round 35: more than the item can come down by is refused, with the most it can', async () => {
  said(await price([{ key: 'b', variantId: BOOSTER, qty: 1, off: 221 }]), 422, 'Riftbound Radiance · Booster Pack can come down by $2.20 at most. Change the discount, or take it off.');
  said(await price([{ key: 'b', variantId: BOOSTER, qty: 3, off: 221 }]), 422, 'Riftbound Radiance · Booster Pack can come down by $2.20 each at most. Change the discount, or take it off.');
  said(await price([{ key: 'w', variantId: WONDERS, qty: 1, off: 2101 }]), 422, '7 Wonders can come down by $21.00 at most. Change the discount, or take it off.');
  // far more than its price (Shopify would take the whole price off and say nothing)
  said(await price([{ key: 'b', variantId: BOOSTER, qty: 1, off: 5000 }]), 422, 'Riftbound Radiance · Booster Pack can come down by $2.20 at most. Change the discount, or take it off.');
  // right on the most is fine
  assert.equal(ok(await price([{ key: 'b', variantId: BOOSTER, qty: 3, off: 220 }])).price.staffDiscount, 660);
  assert.equal(ok(await price([{ key: 'w', variantId: WONDERS, qty: 1, off: 2100 }])).price.total, 8400);
});

test("round 35: something on sale comes down only as far as 80% of what it was, and one already there can't have a discount", async () => {
  // $6, now $3: it's under 80% only because Shopify already has it there
  said(await price([{ key: 'c', variantId: COKE, qty: 1, off: 50 }]), 422, "Coca-Cola – Half Price (Flat) · Classic is on sale already, so it can't have a discount too. Take the discount off it.");
  // $100, now $90: $10 more and no further
  assert.equal(ok(await price([{ key: 'g', variantId: BARRAGE, qty: 1, off: 1000 }])).price.total, 8000);
  said(await price([{ key: 'g', variantId: BARRAGE, qty: 1, off: 1001 }]), 422, 'Barrage can come down by $10.00 at most. Change the discount, or take it off.');
  // too cheap for 20% to be a cent
  said(await price([{ key: 'l', variantId: LOLLY, qty: 5, off: 1 }]), 422, "Lolly can't have a discount. Take the discount off it.");
});

test("round 35: no dollars off on top of a deal: a die the dice deal takes off can't have a discount too", async () => {
  said(await price([{ key: 'o', variantId: OAKIE, qty: 3, off: 100 }]), 422, "Oakie Doakie Translucent RPG Dice Set · Green is on a deal already, so it can't have a discount too. Take the discount off it.");
  // two dice (no free one): the discount is fine, up to $3.19 each
  assert.equal(ok(await price([{ key: 'o', variantId: OAKIE, qty: 2, off: 319 }])).price.staffDiscount, 638);
  // three dice on three lines: the free one is another line's, so the dearest can still come down
  const mixed = ok(await price([{ key: 'g', variantId: '5022', qty: 1, off: 400 }, { key: 'o', variantId: OAKIE, qty: 2 }])).price;
  assert.deepEqual(mixed.discounts, [{ title: 'Buy any 2 dice, get the 3rd free', amount: 1599 }, { title: 'Staff discount', amount: 400 }]);
  assert.equal(mixed.total, 2000 + 3198 - 1599 - 400);
});

test('round 35: what Shopify took off is checked: something other than what was asked is refused, and nothing is sold', async () => {
  shop.staffExtra = 200;
  const words = "Riftbound Radiance · Booster Pack's discount didn't come out as asked. Take it off and add it again.";
  said(await price([{ key: 'b', variantId: BOOSTER, qty: 1, off: 100 }]), 422, words);
  await onTill(RUA, '4711');
  said(await pay({ lines: [{ key: 'b', variantId: BOOSTER, qty: 1, off: 100 }], method: 'card', discountOk: await approve() }), 422, words);
  await settle();
  // its draft was deleted and the sale let go: nothing to confirm
  assert.equal(shop.deleted.length, 1);
  assert.equal(lair.sql.exec('SELECT status, ended_why FROM till_sales').one().ended_why, 'discount');
});

test("round 35: a discounted line Shopify's figures don't have is refused, never let through unchecked", async () => {
  // Shopify answering with other lines than were asked (none of them this one, and not the same number)
  lair.shopify.tillCalculate = async ({ lines }) => {
    const figures = figuresFor(lines);
    return { ...figures, lines: [...figures.lines.map((l) => ({ ...l, uuid: 'another' })), { ...figures.lines[0], uuid: 'and-another' }] };
  };
  said(await price([{ key: 'b', variantId: BOOSTER, qty: 1, off: 100 }]), 422);
  said(await price([{ key: 'b', variantId: BOOSTER, qty: 1, discount: 10 }]), 422);
  // a basket with no discount isn't held up by it
  ok(await price([{ key: 'b', variantId: BOOSTER, qty: 1 }]));
});

test("round 35: a refusal over a line's discount says which line, with Shopify's figures for it now", async () => {
  // so the till can offer what the item can take: its price, the most it can come down by, and what it was when on sale
  const over = await price([{ key: 'w', variantId: WONDERS, qty: 1 }, { key: 'b', variantId: BOOSTER, qty: 2, off: 221 }]);
  said(over, 422);
  assert.deepEqual(over.data.line, { key: 'b', unit: 1100, most: 220 });
  assert.deepEqual((await price([{ key: 'c', variantId: COKE, qty: 1, off: 50 }])).data.line, { key: 'c', unit: 300, most: 0, was: 600 });
  assert.deepEqual((await price([{ key: 'g', variantId: BARRAGE, qty: 1, off: 1001 }])).data.line, { key: 'g', unit: 9000, most: 1000, was: 10000 });
  assert.deepEqual((await price([{ key: 'o', variantId: OAKIE, qty: 3, off: 100 }])).data.line, { key: 'o', unit: 1599, most: 319 });
  // at Pay too
  await onTill(RUA, '4711');
  const lines = [{ key: 'b', variantId: BOOSTER, qty: 1, off: 220 }];
  VARIANTS[BOOSTER].price = 1000;
  try {
    const refusedPay = await pay({ lines, method: 'card', discountOk: await approve() });
    said(refusedPay, 422);
    assert.deepEqual(refusedPay.data.line, { key: 'b', unit: 1000, most: 200 });
  } finally {
    VARIANTS[BOOSTER].price = 1100;
  }
  // every other refusal is its words alone, as it was
  assert.deepEqual((await pay({ lines, method: 'card' })).data, { error: 'A discount needs a PIN from someone with Money, or the owner, before it goes through.' });
  assert.deepEqual((await price([{ key: 'b', variantId: BOOSTER, qty: 1, off: 2.5 }])).data, { error: 'A discount is dollars and cents off each item.' });
});

/* ---------------- approving, as round 34 ---------------- */
test('round 35: Pay takes dollars off only with a PIN from someone with Money, or the owner', async () => {
  const lines = [{ key: 'b', variantId: BOOSTER, qty: 2, off: 200 }];
  const hemi = await onTill(HEMI, '1357');
  await onTill(RUA, '4711');
  said(await pay({ lines, method: 'card', token: hemi }), 403, 'A discount needs a PIN from someone with Money, or the owner, before it goes through.');
  said(await pay({ lines, method: 'card', token: hemi, discountOk: await approve(HEMI, '1357') }), 403, "Hemi can't approve discounts. That's for staff with Money, or the owner.");
  assert.equal(shop.drafts.length, 0);
  // Rua puts her PIN in: it goes through, Hemi still ringing it up
  const sale = ok(await pay({ lines, method: 'card', token: hemi, discountOk: await approve() })).sale;
  assert.equal(sale.total, 1800);
  assert.deepEqual(sale.staffDiscount, { amount: 400, by: 'Rua' });
  assert.deepEqual(sale.discounts, [{ title: 'Staff discount', amount: 400 }]);
  assert.deepEqual(sale.lines[0].discount, { each: 200, amount: 400 });
  // in Shopify: the line's staff discount is dollars off each and says who approved it; the order is tagged, its note says so
  const draft = shop.drafts.at(-1).input;
  assert.equal(draft.lines[0].off, 200);
  assert.equal(draft.lines[0].discount, undefined);
  assert.equal(draft.lines[0].discountNote, 'Approved by Rua on the till');
  assert.ok(draft.tags.includes('staff-discount'));
  assert.match(draft.note, /rung up by Hemi .*Staff discount approved by Rua\./);
  const done = ok(await paid({ sale: sale.id, token: hemi, expect: 1800 })).sale;
  assert.equal(done.status, 'paid');
  assert.equal(saleRow(sale.id).discount_by, RUA);
  assert.equal(saleRow(sale.id).discount_total, 400);
});

test('round 35: at Pay the draft is checked again: a price that dropped in Shopify since leaves less room, and nothing is sold', async () => {
  await onTill(RUA, '4711');
  const lines = [{ key: 'b', variantId: BOOSTER, qty: 1, off: 220 }];
  assert.equal(ok(await price(lines)).price.total, 880);
  // Mo drops the booster to $10 in Shopify before Pay: $2.20 off is more than 20% of it now
  VARIANTS[BOOSTER].price = 1000;
  try {
    said(await pay({ lines, method: 'card', discountOk: await approve() }), 422, 'Riftbound Radiance · Booster Pack can come down by $2.00 at most. Change the discount, or take it off.');
  } finally {
    VARIANTS[BOOSTER].price = 1100;
  }
  await settle();
  assert.equal(shop.deleted.length, 1);
  assert.equal(lair.sql.exec('SELECT status, ended_why FROM till_sales').one().ended_why, 'discount');
});

/* ---------------- Shopify's side ---------------- */
test('round 35: the draft asks Shopify for dollars off each one of the line, and its figures read the compare-at price', () => {
  const input = tillDraftInput({ currency: 'NZD', lines: [{ uuid: 'u1', variantId: BOOSTER, qty: 2, off: 250, discountNote: 'Approved by Rua on the till' }, { uuid: 'u2', variantId: DRINK, qty: 1 }, { uuid: 'u3', variantId: WONDERS, qty: 1, off: 1199 }] });
  assert.deepEqual(input.lineItems[0].appliedDiscount, { valueType: 'FIXED_AMOUNT', value: 2.5, title: 'Staff discount', description: 'Approved by Rua on the till' });
  assert.equal(input.lineItems[1].appliedDiscount, undefined);
  assert.deepEqual(input.lineItems[2].appliedDiscount, { valueType: 'FIXED_AMOUNT', value: 11.99, title: 'Staff discount' });
  // every amount in cents goes to Shopify as that many dollars and cents, exactly
  for (let cents = 1; cents <= 30000; cents += 1) {
    const { value } = tillDraftInput({ currency: 'NZD', lines: [{ variantId: BOOSTER, qty: 1, off: cents }] }).lineItems[0].appliedDiscount;
    assert.equal(JSON.stringify(value), String(cents / 100));
    assert.equal(Math.round(Number(JSON.stringify(value)) * 100), cents);
  }
  const money = (a) => ({ shopMoney: { amount: a, currencyCode: 'NZD' } });
  const line = (extra) => ({ uuid: 'u1', quantity: 2, title: 'Barrage', originalUnitPriceSet: money('90.0'), originalTotalSet: money('180.0'), discountedTotalSet: money('170.0'), appliedDiscount: { amountSet: money('10.0') }, ...extra });
  const figures = (extra) => tillFiguresOf({ taxesIncluded: true, totalPriceSet: money('170.0'), totalTaxSet: money('22.17'), platformDiscounts: [] }, [line(extra)]).lines[0];
  const onSale = figures({ variant: { id: 'gid://shopify/ProductVariant/5025', compareAtPrice: '100.00' } });
  assert.equal(onSale.was, 10000);
  assert.equal(onSale.staff, 1000);
  assert.equal(onSale.paid, 17000);
  assert.equal(onSale.variantId, '5025');
  // no compare-at price, or one that isn't above the price: not on sale
  assert.equal(figures({ variant: { id: 'gid://shopify/ProductVariant/5025', compareAtPrice: null } }).was, undefined);
  assert.equal(figures({ variant: { id: 'gid://shopify/ProductVariant/5025', compareAtPrice: '90.00' } }).was, undefined);
  assert.equal(figures({ variant: { id: 'gid://shopify/ProductVariant/5025', compareAtPrice: '80.00' } }).was, undefined);
  assert.equal(figures({ variant: null }).was, undefined);
});

test("round 35: the till asks Shopify for each line's compare-at price, for the price, the draft and the draft as it is now", async () => {
  const asked = [];
  const money = (a) => ({ shopMoney: { amount: a, currencyCode: 'NZD' } });
  const node = { uuid: 'u1', quantity: 1, title: 'Barrage', variant: { id: 'gid://shopify/ProductVariant/5025', compareAtPrice: '100.00' }, originalUnitPriceSet: money('90.0'), originalTotalSet: money('90.0'), discountedTotalSet: money('90.0'), appliedDiscount: null };
  const draft = { id: 'gid://shopify/DraftOrder/1', ready: true, status: 'OPEN', taxesIncluded: true, totalPriceSet: money('90.0'), totalTaxSet: money('11.74'), platformDiscounts: [], lineItems: { nodes: [node] } };
  const stub = {
    tillVersion: TILL_API_VERSION,
    graphql: async (query) => {
      asked.push(query);
      if (/draftOrderCalculate/.test(query)) return { draftOrderCalculate: { calculatedDraftOrder: { ...draft, lineItems: [node] }, userErrors: [] } };
      if (/draftOrderCreate/.test(query)) return { draftOrderCreate: { draftOrder: draft, userErrors: [] } };
      return { draftOrder: draft };
    },
  };
  const lines = [{ uuid: 'u1', variantId: BARRAGE, qty: 1 }];
  const calculated = await ShopifyAdmin.prototype.tillCalculate.call(stub, { lines, currency: 'NZD' });
  const made = await ShopifyAdmin.prototype.createTillDraft.call(stub, { customerId: null, lines, currency: 'NZD', tags: [], note: '', marker: {} });
  const now = await ShopifyAdmin.prototype.tillDraft.call(stub, 'gid://shopify/DraftOrder/1');
  assert.equal(asked.length, 3);
  for (const query of asked) assert.match(query, /variant \{ id compareAtPrice \}/);
  for (const figures of [calculated, made, now]) assert.equal(figures.lines[0].was, 10000);
});

/* ---------------- a till that hasn't reloaded ---------------- */
test("round 35: a till that hasn't reloaded still sends a percent: up to 20 now, held to the same 80%", async () => {
  assert.equal(tillDiscountIn(20), 20);
  assert.equal(tillDiscountIn('12.5'), 12.5);
  for (const bad of [20.01, 25, 26, 100, -5, 'ten', 10.123, Infinity]) assert.throws(() => tillDiscountIn(bad), refused(400, 'A discount can be up to 20% off each item.'));
  assert.equal(D.over, 'A discount can be up to 20% off each item.');
  said(await price([{ key: 'b', variantId: BOOSTER, qty: 1, discount: 25 }]), 400, 'A discount can be up to 20% off each item.');
  // 20% of two $15.99 dice sets is $6.39 as Shopify rounds the line: within a cent each of $3.19 off each, so it's fine
  const dice = ok(await price([{ key: 'o', variantId: OAKIE, qty: 2, discount: 20 }])).price;
  assert.equal(dice.staffDiscount, 639);
  assert.deepEqual(dice.lines[0].discount, { percent: 20, amount: 639 });
  // on sale already: no percent either; a little off already: only what's left of the 20%
  said(await price([{ key: 'c', variantId: COKE, qty: 1, discount: 10 }]), 422, "Coca-Cola – Half Price (Flat) · Classic is on sale already, so it can't have a discount too. Take the discount off it.");
  said(await price([{ key: 'g', variantId: BARRAGE, qty: 1, discount: 20 }]), 422, 'Barrage can come down by $10.00 at most. Change the discount, or take it off.');
  assert.equal(ok(await price([{ key: 'g', variantId: BARRAGE, qty: 1, discount: 10 }])).price.staffDiscount, 900);
  // and Shopify taking more than a percent should is still caught
  shop.staffExtra = 200;
  said(await price([{ key: 'b', variantId: BOOSTER, qty: 1, discount: 20 }]), 422, 'Riftbound Radiance · Booster Pack can come down by $2.20 at most. Change the discount, or take it off.');
});

// Round 36, a discount past 20% asks, is flagged and is emailed (contract v36-till-discount-over). Mo (13 Nov 2026): "for
// the discount limitation of 20% instead of locking it just create a warning message that this happened and flag it and
// send a special email when it happens so I would know [...] a warning message saying this exceeds the 20% threshold of
// discounts are you sure you wanna continue and when the transaction is done an automatic email is sent without alerting
// anyone etc. just for my information and if an investigation is needed I will deal with it myself I just want the
// information". So: a staff discount may take something more than 20% off its full price (as far as the whole price);
// the till asks first, and Pay goes through only when the till says yes was said; the sale's order is flagged in Shopify;
// and once it's paid one email goes to the address set for it, with nothing said at the till. Still as rounds 34 and 35:
// only the shop's products, never on top of a deal, a PIN from someone with Money or the owner, Shopify's own figures.
// The words are written out here as the contract has them, not taken from the code.
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { CONFIG_KEYS } from '../src/config.js';
import { TILL_DISCOUNT_MAX, TILL_OVER_WORDS, tillDiscountMost } from '../src/till-discounts.js';

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
  // (11 Nov 2026) the shop's other deal: a Commander deck comes with its sleeves free
  deck: { id: '117', title: 'Final Fantasy Commander Deck', type: 'Trading Card Games', vendor: 'Wizards of the Coast', status: 'ACTIVE', giftCard: false, dice: false },
  sleeves: { id: '118', title: 'Final Fantasy Commander Sleeves (100)', type: 'Trading Card Games', vendor: 'Ultra Pro', status: 'ACTIVE', giftCard: false, dice: false },
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
  5028: { product: 'deck', id: '5028', title: 'Default Title', sku: null, barcodes: [], price: 8999, tracked: true, stock: 3, oversell: false },
  5029: { product: 'sleeves', id: '5029', title: 'Default Title', sku: null, barcodes: [], price: 1999, tracked: true, stock: 6, oversell: false },
};
const match = (id) => ({ product: { ...PRODUCTS[VARIANTS[id].product] }, variant: { ...VARIANTS[id] } });

/**
 * Shopify's figures as the fake works them out, the way the real one did when asked (draftOrderCalculate, 11 Nov 2026):
 * the shop's prices; a line's staff discount, dollars off each one of it (FIXED_AMOUNT: 2 at $5 off is $10, never more
 * than the price) or a percent of the line rounded down to the cent (PERCENTAGE: 2 x $15.99 at 20% is $6.39); then every
 * third dice free, at what it costs after its line's discount, its amount on the line it came from; a variant's
 * compare-at price (was); and GST. shop.staffExtra adds cents to each staff discount (Shopify going wrong). And the
 * shop's other deal (10 Nov 2026, "Final Fantasy Commander deck + free sleeves": buy a deck, get one of its sleeves
 * free): the sleeves' price comes off the sleeves' own line.
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
  // a deck's sleeves, free: one for each deck, the cheapest first, at what they cost after their own line's discount
  // (the real store, asked on 11 Nov 2026 with a deck and two lines of sleeves, one with $1.35 off: the deal took
  // $23.65 off that line and left the other alone)
  const decks = out.reduce((n, l) => n + (l.variantId === '5028' ? l.qty : 0), 0);
  const packs = [];
  out.forEach((l, i) => {
    if (l.variantId === '5029') for (let n = 0; n < l.qty; n += 1) packs.push({ unit: l.each, line: i });
  });
  packs.sort((x, y) => x.unit - y.unit);
  let sleeves = 0;
  packs.slice(0, decks).forEach((u) => {
    sleeves += u.unit;
    out[u.line].paid -= u.unit;
  });
  const subtotal = out.reduce((sum, l) => sum + l.total, 0);
  const staffTotal = out.reduce((sum, l) => sum + (l.staff || 0), 0);
  const total = subtotal - deal - sleeves - staffTotal;
  return {
    subtotal, total, gst: Math.round((total * 3) / 23), taxIncluded: true,
    discounts: [...(deal ? [{ title: 'Buy any 2 dice, get the 3rd free', amount: deal }] : []), ...(sleeves ? [{ title: 'Final Fantasy Commander deck + free sleeves', amount: sleeves }] : [])],
    lines: out.map(({ dice, each, ...l }) => l),
  };
}

let lair;
let shop;
let mails = [];
let mailFails = 0;
/** Every email the Lair tried to send, whether or not it went; and how many the email service turns away as letters (a 422) */
let tried = [];
let mailTurnedAway = 0;
// the Worker's own settings (the Lair reads them afresh for each request)
let env;
// email set up, with an address of its own for the owner's note about a discount (made up: the real one is the Worker's)
const OWNER_NOTES = 'owner-notes@example.com';
const ENV = { CURRENCY: 'NZD', SHOP: 'dice-goblin.myshopify.com', RESEND_API_KEY: 'test-key', FROM_EMAIL: 'Dice Goblin <lair@example.com>', STAFF_EMAIL: 'team@example.com', DISCOUNT_EMAIL: OWNER_NOTES };
function fakeShopify() {
  shop = { asked: [], drafts: [], deleted: [], completed: [], fulfilled: [], calculated: [], marked: [], markFails: 0, owner: 'the-owner@example.com', ownerAsked: 0, ownerFails: false, down: false, completeFails: 0, loseComplete: false, fulfilDenied: false, orderTotal: null };
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
  // the shop owner's email address, as Shopify has it (Shop.email)
  lair.shopify.shopOwnerEmail = async () => {
    shop.ownerAsked += 1;
    if (shop.ownerFails) throw new Error('Shopify is down');
    return shop.owner;
  };
  // an order's tag and a paragraph on its note (round 25's gwMarkOrder, which round 36 uses for its flag)
  lair.shopify.gwMarkOrder = async (orderId, tag, paragraph) => {
    if (shop.markFails > 0) {
      shop.markFails -= 1;
      throw new Error('Shopify is down');
    }
    shop.marked.push({ orderId, tag, paragraph });
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
  env = { ...ENV };
  lair = new Lair(fakeCtx(), env);
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
  mails = [];
  mailFails = 0;
  tried = [];
  mailTurnedAway = 0;
  lair.mail = async (message) => {
    tried.push(message);
    if (mailTurnedAway > 0) {
      mailTurnedAway -= 1;
      return { ok: false, attempted: true, status: 422, code: 'validation_error', message: 'Invalid `to` field.' };
    }
    if (mailFails > 0) {
      mailFails -= 1;
      return { ok: false, attempted: true, status: 500, code: null, message: 'Resend is down' };
    }
    mails.push(message);
    return { ok: true, attempted: true, status: 200, code: null, message: 'Sent.' };
  };
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
const DECK = '5028'; // $89.99: $17.99; its sleeves come free with it
const SLEEVES = '5029'; // $19.99: $3.99, when they're paid for
/** A fresh PIN from Rua (Money), as the till's approval asks for one: unlocking gives the token that approves */
const approve = async (id = RUA, pin = '4711') => ok(await call('POST', 'till/unlock', { id, pin }, OWNER)).token;
const price = (lines, extra = {}) => call('POST', 'till/price', { lines, ...extra }, OWNER);
const refused = (status, words) => (e) => e.status === status && e.message === words;


/** Every key anywhere in an answer, for checking what the till is (and isn't) told */
const keysOf = (value, found = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      found.add(k);
      keysOf(v, found);
    }
  }
  return found;
};
/** A sale with 7 Wonders at $50 off (47.62% off), two half-price Cokes at 50c more off each, two boosters at $2 off each (within 20%) and a drink */
const OVER_LINES = [{ key: 'w', variantId: WONDERS, qty: 1, off: 5000 }, { key: 'c', variantId: COKE, qty: 2, off: 50 }, { key: 'b', variantId: BOOSTER, qty: 2, off: 200 }, { key: 'd', variantId: DRINK, qty: 1 }];
const OVER_TOTAL = 10500 - 5000 + 600 - 100 + 2200 - 400 + 300;
/** Hemi rings it up for Mia, Rua approves it, the till says yes was said: the open sale */
async function overSale(lines = OVER_LINES, extra = {}) {
  await onTill(RUA, '4711');
  const hemi = await onTill(HEMI, '1357');
  const sale = ok(await pay({ lines, person: MIA, method: 'card', token: hemi, discountOk: await approve(), overOk: true, ...extra })).sale;
  return { sale, hemi };
}

/* ---------------- the rule: nothing is locked at 20% ---------------- */
test('round 36: the 20% is still where the limit sits: what a thing can come down by before it is past it', () => {
  assert.equal(TILL_DISCOUNT_MAX, 20);
  assert.equal(tillDiscountMost(1100), 220);
  assert.equal(tillDiscountMost(9000, 10000), 1000);
  assert.equal(tillDiscountMost(300, 600), 0);
});

test("round 36: the flag and the email write how far off to one decimal place, worked out once, and never as 20% for something that's past it", () => {
  // (unit: its price; off: dollars off each; was: its price before its own sale)
  const line = (unit, off, was) => TILL_OVER_WORDS.noteLine({ title: 'Catan', qty: 1, unit, off, ...(was ? { was } : {}) });
  assert.equal(line(10500, 5000), 'Catan, $50.00 off (47.6% off)');
  assert.equal(line(2000, 500), 'Catan, $5.00 off (25% off)');
  assert.equal(line(500, 500), 'Catan, $5.00 off (100% off)');
  assert.equal(line(100000, 20090), 'Catan, $200.90 off (20.1% off)');
  // a cent past 20% on something dear is 20.001%: "20% off" would read as within it
  assert.equal(line(100000, 20001), 'Catan, $200.01 off (just over 20% off)');
  assert.equal(line(100000, 20040), 'Catan, $200.40 off (just over 20% off)');
  // $2.59 off $11 is 23.545%: 23.5%, not the 23.6% that rounding it to 23.55% first and then again would make
  assert.equal(line(1100, 259), 'Catan, $2.59 off (23.5% off)');
  // on sale already: a share of what it was
  assert.equal(line(300, 50, 600), 'Catan, $0.50 off (58.3% off what it was)');
  assert.equal(TILL_OVER_WORDS.overLine({ title: 'Booster', qty: 2, unit: 1100, off: 259, percent: 23.55 }), '2 × Booster: $2.59 off each, 23.5% off ($11.00 down to $8.41 each)');
});

test('round 36: a discount of more than 20% off is no longer refused: the price comes back, and says which things are past 20%', async () => {
  // an $11 booster: $2.20 is 20%, and a cent more is past it
  const over = ok(await price([{ key: 'b', variantId: BOOSTER, qty: 1, off: 221 }])).price;
  assert.equal(over.total, 1100 - 221);
  assert.equal(over.needsOk, true);
  assert.equal(over.staffDiscount, 221);
  assert.deepEqual(over.lines[0].discount, { each: 221, amount: 221, over: true });
  assert.equal(over.lines[0].most, 220);
  assert.deepEqual(over.over, [{ key: 'b', off: 221, most: 220, unit: 1100, percent: 20.09 }]);
  // right on 20% isn't past it, and says nothing about it
  const on = ok(await price([{ key: 'b', variantId: BOOSTER, qty: 3, off: 220 }])).price;
  assert.equal(on.over, undefined);
  assert.deepEqual(on.lines[0].discount, { each: 220, amount: 660 });
  // half off two games, with a booster within 20% and a drink: only what's past it is listed
  const mixed = ok(await price([{ key: 'w', variantId: WONDERS, qty: 2, off: 5250 }, { key: 'b', variantId: BOOSTER, qty: 1, off: 200 }, { key: 'd', variantId: DRINK, qty: 1 }])).price;
  assert.deepEqual(mixed.over, [{ key: 'w', off: 5250, most: 2100, unit: 10500, percent: 50 }]);
  assert.deepEqual(mixed.lines.map((l) => l.discount), [{ each: 5250, amount: 10500, over: true }, { each: 200, amount: 200 }, undefined]);
  assert.equal(mixed.total, 21000 - 10500 + 1100 - 200 + 300);
  assert.deepEqual(mixed.discounts, [{ title: 'Staff discount', amount: 10700 }]);
});

test('round 36: something on sale already can have a discount too now, and it is past 20% as soon as it sells for under 80% of what it was', async () => {
  // $6, now $3 (half price already): 50c more
  const coke = ok(await price([{ key: 'c', variantId: COKE, qty: 1, off: 50 }])).price;
  assert.equal(coke.total, 250);
  assert.deepEqual(coke.over, [{ key: 'c', off: 50, most: 0, unit: 300, was: 600, percent: 58.33 }]);
  // $100, now $90: $10 more is 20% off what it was; a cent more is past it
  assert.equal(ok(await price([{ key: 'g', variantId: BARRAGE, qty: 1, off: 1000 }])).price.over, undefined);
  assert.deepEqual(ok(await price([{ key: 'g', variantId: BARRAGE, qty: 1, off: 1001 }])).price.over, [{ key: 'g', off: 1001, most: 1000, unit: 9000, was: 10000, percent: 20.01 }]);
  // too cheap for 20% to be a cent: a cent off is past it
  assert.deepEqual(ok(await price([{ key: 'l', variantId: LOLLY, qty: 5, off: 1 }])).price.over, [{ key: 'l', off: 1, most: 0, unit: 4, percent: 25 }]);
});

test('round 36: a discount can be the whole price and no more, and a deal is still in the way', async () => {
  // free: the whole price off each one
  const free = ok(await price([{ key: 'b', variantId: BOOSTER, qty: 2, off: 1100 }])).price;
  assert.equal(free.total, 0);
  assert.deepEqual(free.over, [{ key: 'b', off: 1100, most: 220, unit: 1100, percent: 100 }]);
  // more than it costs (Shopify would take the whole price off and say nothing)
  const tooMuch = await price([{ key: 'b', variantId: BOOSTER, qty: 2, off: 1101 }]);
  said(tooMuch, 422, "Riftbound Radiance · Booster Pack is $11.00 each, so it can't come down by more than that. Change the discount, or take it off.");
  assert.deepEqual(tooMuch.data.line, { key: 'b', unit: 1100, most: 220 });
  said(await price([{ key: 'w', variantId: WONDERS, qty: 1, off: 20000 }]), 422, "7 Wonders is $105.00, so it can't come down by more than that. Change the discount, or take it off.");
  // on a deal already: refused as before, whatever the amount, its line saying it's the deal
  const dealt = await price([{ key: 'o', variantId: OAKIE, qty: 3, off: 100 }]);
  said(dealt, 422, "Oakie Doakie Translucent RPG Dice Set · Green is on a deal already, so it can't have a discount too. Take the discount off it.");
  assert.deepEqual(dealt.data.line, { key: 'o', unit: 1599, most: 0, deal: true });
  said(await price([{ key: 'k', variantId: DECK, qty: 1 }, { key: 's', variantId: SLEEVES, qty: 1, off: 1500 }]), 422, "Final Fantasy Commander Sleeves (100) is on a deal already, so it can't have a discount too. Take the discount off it.");
  // and what Shopify took off still has to be what was asked
  shop.staffExtra = 200;
  said(await price([{ key: 'b', variantId: BOOSTER, qty: 1, off: 500 }]), 422, "Riftbound Radiance · Booster Pack's discount didn't come out as asked. Take it off and add it again.");
});

/* ---------------- the warning: Pay needs the till's yes ---------------- */
test('round 36: Pay with something past 20% goes through only once the till says yes was said to its warning', async () => {
  await onTill(RUA, '4711');
  const hemi = await onTill(HEMI, '1357');
  const lines = [{ key: 'w', variantId: WONDERS, qty: 1, off: 5000 }, { key: 'b', variantId: BOOSTER, qty: 2, off: 200 }];
  // without the yes: refused, saying which things with Shopify's figures for them, and nothing is sold
  const asked = await pay({ lines, method: 'card', token: hemi, discountOk: await approve() });
  said(asked, 422, "7 Wonders would be more than 20% off, and the till hasn't asked about that yet. Change the discount, or tap Pay again to be asked.");
  assert.deepEqual(asked.data.over, [{ key: 'w', off: 5000, most: 2100, unit: 10500, percent: 47.62 }]);
  assert.deepEqual(asked.data.line, { key: 'w', unit: 10500, most: 2100 });
  await settle();
  assert.equal(shop.deleted.length, 1);
  assert.equal(lair.sql.exec('SELECT ended_why FROM till_sales').one().ended_why, 'discount');
  // anything but true isn't a yes
  for (const no of [false, 'true', 1, 'yes', null]) said(await pay({ lines, method: 'card', token: hemi, discountOk: await approve(), overOk: no }), 422);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM till_sales WHERE status != 'gone'").one().n, 0);
  // with it the sale goes on, and the Lair keeps which things were past 20%
  const sale = ok(await pay({ lines, method: 'card', token: hemi, discountOk: await approve(), overOk: true })).sale;
  assert.equal(sale.total, 10500 - 5000 + 2200 - 400);
  assert.deepEqual(sale.staffDiscount, { amount: 5400, by: 'Rua' });
  assert.deepEqual(JSON.parse(saleRow(sale.id).discount_over), [{ key: 'w', title: '7 Wonders', qty: 1, unit: 10500, off: 5000, most: 2100, percent: 47.62 }]);
  // a PIN from someone with Money, or the owner, is still what lets any discount through
  said(await pay({ lines, method: 'card', token: hemi, overOk: true }), 403, 'A discount needs a PIN from someone with Money, or the owner, before it goes through.');
  said(await pay({ lines, method: 'card', token: hemi, discountOk: await approve(HEMI, '1357'), overOk: true }), 403, "Hemi can't approve discounts. That's for staff with Money, or the owner.");
  // a yes with nothing past 20% changes nothing
  const plain = ok(await pay({ lines: [{ key: 'b', variantId: BOOSTER, qty: 2, off: 200 }], method: 'card', token: hemi, discountOk: await approve(), overOk: true })).sale;
  assert.equal(saleRow(plain.id).discount_over, null);
  assert.equal(saleRow(plain.id).over_mail, null);
});

test("round 36: at Pay the draft is checked again: a price that dropped in Shopify since puts it past 20%, so it's asked, not sold", async () => {
  await onTill(RUA, '4711');
  const lines = [{ key: 'b', variantId: BOOSTER, qty: 1, off: 220 }];
  assert.equal(ok(await price(lines)).price.over, undefined);
  // Mo drops the booster to $10 in Shopify before Pay: $2.20 off is more than 20% of it now
  VARIANTS[BOOSTER].price = 1000;
  try {
    const asked = await pay({ lines, method: 'card', discountOk: await approve() });
    said(asked, 422, "Riftbound Radiance · Booster Pack would be more than 20% off, and the till hasn't asked about that yet. Change the discount, or tap Pay again to be asked.");
    assert.deepEqual(asked.data.line, { key: 'b', unit: 1000, most: 200 });
    assert.deepEqual(asked.data.over, [{ key: 'b', off: 220, most: 200, unit: 1000, percent: 22 }]);
    await settle();
    assert.equal(shop.deleted.length, 1);
    // said yes to: sold at Shopify's price now
    assert.equal(ok(await pay({ lines, method: 'card', discountOk: await approve(), overOk: true })).sale.total, 780);
  } finally {
    VARIANTS[BOOSTER].price = 1100;
  }
});

/* ---------------- flagged, and the owner's email ---------------- */
test("round 36: once it's paid, its order is flagged in Shopify and one email goes to the owner's address, and nobody at the till is told", async () => {
  const { sale, hemi } = await overSale();
  assert.equal(sale.total, OVER_TOTAL);
  // not paid yet: nothing is flagged or sent
  await settle();
  assert.equal(mails.length, 0);
  assert.equal(shop.marked.length, 0);
  // the order isn't tagged past-20% as it's made: that comes once it's paid, on what Shopify took
  assert.deepEqual(shop.drafts.at(-1).input.tags.filter((t) => /discount/.test(t)), ['staff-discount']);
  nowIs(NOW + 2 * MIN);
  const done = ok(await paid({ sale: sale.id, token: hemi, expect: OVER_TOTAL })).sale;
  await settle();
  assert.equal(done.status, 'paid');
  // the order: its tag, and a paragraph on its note saying which things
  assert.deepEqual(shop.marked, [{
    orderId: done.order.id, tag: 'discount-over-20',
    paragraph: 'More than 20% off, said yes to at the till: 7 Wonders, $50.00 off (47.6% off); 2 × Coca-Cola – Half Price (Flat) · Classic, $0.50 off each (58.3% off what it was).',
  }]);
  // the email: one, to the address set for it
  assert.equal(mails.length, 1);
  const mail = mails[0];
  assert.equal(mail.to, OWNER_NOTES);
  assert.equal(mail.subject, `Till discount over 20%: ${done.order.name}, $55.00 off`);
  assert.equal(mail.idempotencyKey, `till-over-${sale.id}`);
  const text = mail.text.replace(/[ \t]+/g, ' ');
  for (const words of [
    'A DISCOUNT OVER 20%',
    'A sale at the till had a staff discount that took 2 things more than 20% off. Rua approved it with their PIN.',
    "Nobody at the till was told about this email. It's only so you know.",
    `Order: ${done.order.name}`,
    'Rung up by: Hemi',
    'Approved by: Rua',
    'Paid: $81.00 by card, taken by Hemi',
    'Sold to: Mia Tamaki',
    '7 Wonders: $50.00 off, 47.6% off ($105.00 down to $55.00)',
    '2 × Coca-Cola – Half Price (Flat) · Classic: $0.50 off each, 58.3% off what it was ($6.00 before its sale, $3.00 down to $2.50 each)',
    'Other discounts: 2 × Riftbound Radiance · Booster Pack: $2.00 off each',
    'Before discounts: $136.00',
    'Staff discounts: $55.00',
    `Open the order in Shopify: https://admin.shopify.com/store/dice-goblin/orders/${done.order.id.split('/').pop()}`,
    'Gobgob, keeping an eye on the till',
  ]) assert.ok(text.includes(words), `the email says: ${words}\n${text}`);
  // when: the minute it was paid, at the Lair
  assert.match(text, /When: .*25 October.*10:02/);
  assert.match(mail.html, /7 Wonders: \$50\.00 off/);
  // nobody else hears: no alert for the team, and what the till is told says nothing of a flag or an email
  assert.deepEqual(lair.alerts, []);
  for (const answer of [sale, done]) assert.deepEqual([...keysOf(answer)].filter((k) => /mail|flag|told|mark|tag|note/i.test(k)), []);
  // (the review, 13 Nov 2026) nor that it's past 20% at all: Pay's and Paid's answers are what they'd be for any
  // discounted sale, line for line (the price is where the till is told, before it asks)
  for (const answer of [sale, done]) assert.ok(!keysOf(answer).has('over'), JSON.stringify(answer.lines));
  assert.deepEqual(sale.lines.find((l) => l.key === 'w').discount, { each: 5000, amount: 5000 });
  assert.ok(!/"over"/.test(saleRow(sale.id).shown));
  const row = saleRow(sale.id);
  assert.equal(row.over_mark, 'done');
  assert.equal(row.over_mail, 'sent');
  assert.equal(row.over_next_at, null);
  // and the 10-minute run has nothing more to do for it, however often it runs
  for (const later of [11, 21, 31]) {
    nowIs(NOW + later * MIN);
    await lair.tillSalesUpkeep(Date.now());
    await settle();
  }
  assert.equal(mails.length, 1);
  assert.equal(shop.marked.length, 1);
});

test('round 36: a sale with every discount within 20% is not flagged, and no email goes', async () => {
  await onTill(RUA, '4711');
  const hemi = await onTill(HEMI, '1357');
  const lines = [{ key: 'w', variantId: WONDERS, qty: 1, off: 2100 }, { key: 'b', variantId: BOOSTER, qty: 2, off: 220 }, { key: 'g', variantId: BARRAGE, qty: 1, off: 1000 }];
  const sale = ok(await pay({ lines, person: MIA, method: 'card', token: hemi, discountOk: await approve() })).sale;
  ok(await paid({ sale: sale.id, token: hemi, expect: sale.total }));
  await settle();
  nowIs(NOW + 11 * MIN);
  await lair.tillSalesUpkeep(Date.now());
  await settle();
  assert.equal(mails.length, 0);
  assert.equal(shop.marked.length, 0);
  assert.equal(saleRow(sale.id).discount_over, null);
});

test('round 36: a customer paying at the counter with an approved discount past 20% is emailed about too, and one thing reads as one', async () => {
  await onTill(RUA, '4711');
  const hemi = await onTill(HEMI, '1357');
  // (no token at Pay: the customer screen; Hemi takes the money)
  const sale = ok(await pay({ lines: [{ key: 'b', variantId: BOOSTER, qty: 1, off: 1100 }, { key: 'd', variantId: DRINK, qty: 1 }], method: 'cash', discountOk: await approve(), overOk: true })).sale;
  const done = ok(await paid({ sale: sale.id, token: hemi, expect: 300, handed: 500 })).sale;
  await settle();
  const text = mails[0].text.replace(/[ \t]+/g, ' ');
  assert.equal(mails[0].subject, `Till discount over 20%: ${done.order.name}, $11.00 off`);
  for (const words of [
    'A sale at the till had a staff discount that took one thing more than 20% off. Rua approved it with their PIN.',
    'Rung up by: A customer, on the customer screen',
    'Paid: $3.00 in cash, taken by Hemi',
    'Sold to: A quick sale (no member)',
    'Riftbound Radiance · Booster Pack: $11.00 off, 100% off ($11.00 down to $0.00)',
  ]) assert.ok(text.includes(words), `the email says: ${words}\n${text}`);
  assert.ok(!text.includes('Other discounts'));
});

/* ---------------- it gets there: tried again, never twice ---------------- */
test("round 36: an email that didn't go is sent again by the 10-minute run, as the same email, until it does", async () => {
  const { sale, hemi } = await overSale();
  mailFails = 2;
  ok(await paid({ sale: sale.id, token: hemi, expect: OVER_TOTAL }));
  await settle();
  assert.equal(mails.length, 0);
  assert.equal(saleRow(sale.id).over_mail, 'due');
  // its order was flagged all the same
  assert.equal(saleRow(sale.id).over_mark, 'done');
  // too soon: the run leaves it
  nowIs(NOW + 5 * MIN);
  await lair.tillSalesUpkeep(Date.now());
  await settle();
  assert.equal(saleRow(sale.id).over_tries, 1);
  // then it tries, fails again, and tries again 10 minutes on
  nowIs(NOW + 11 * MIN);
  await lair.tillSalesUpkeep(Date.now());
  await settle();
  assert.equal(mails.length, 0);
  // (the settings change meanwhile: it still goes as it was first made, so the email service knows it for the same one)
  env.DISCOUNT_EMAIL = 'someone-else@example.com';
  env.FROM_EMAIL = 'Somebody else <else@example.com>';
  await lair.useConfig();
  nowIs(NOW + 22 * MIN);
  await lair.tillSalesUpkeep(Date.now());
  await settle();
  assert.equal(mails.length, 1);
  assert.equal(mails[0].idempotencyKey, `till-over-${sale.id}`);
  assert.equal(mails[0].to, OWNER_NOTES);
  assert.equal(mails[0].from, ENV.FROM_EMAIL);
  // three tries, one email: every try was word for word the same, under the same key
  assert.equal(tried.length, 3);
  for (const again of tried.slice(1)) assert.deepEqual(again, tried[0]);
  assert.equal(saleRow(sale.id).over_mail, 'sent');
  assert.equal(saleRow(sale.id).over_letter, null);
  assert.equal(shop.marked.length, 1);
  assert.deepEqual(lair.alerts, []);
});

test("round 36: an email that was tried before its order was made goes as it was first written, even once the order's there", async () => {
  // (the email service keeps a key for a day and turns the key away with other words: so a try that may have gone is
  // never followed by a different email under the same key)
  const { sale, hemi } = await overSale();
  shop.completeFails = 2;
  ok(await paid({ sale: sale.id, token: hemi, expect: OVER_TOTAL }));
  await settle();
  // 10 minutes on there's still no order: the email is written without one, and the email service doesn't answer
  mailFails = 1;
  nowIs(NOW + 10 * MIN + 1000);
  await lair.tillSalesUpkeep(Date.now());
  await settle();
  assert.equal(mails.length, 0);
  assert.equal(tried.length, 1);
  assert.equal(tried[0].subject, 'Till discount over 20%: $55.00 off, with no Shopify order yet');
  // the order is made half an hour later; the email's next try is the same email, and the order is flagged
  nowIs(NOW + 41 * MIN);
  await lair.tillSalesUpkeep(Date.now());
  await settle();
  nowIs(NOW + 52 * MIN);
  await lair.tillSalesUpkeep(Date.now());
  await settle();
  const row = saleRow(sale.id);
  assert.equal(row.order_status, 'made');
  assert.equal(row.over_mark, 'done');
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0], tried[0]);
  assert.equal(row.over_mail, 'sent');
});

test('round 36: a letter the email service turns away as a letter is written again, with a key of its own', async () => {
  const { sale, hemi } = await overSale();
  // (the address set for it isn't one the email service takes)
  mailTurnedAway = 1;
  ok(await paid({ sale: sale.id, token: hemi, expect: OVER_TOTAL }));
  await settle();
  assert.equal(mails.length, 0);
  assert.equal(tried.length, 1);
  let row = saleRow(sale.id);
  assert.equal(row.over_mail, 'due');
  assert.match(row.over_error, /email: 422: Invalid `to` field\./);
  // Mo puts the address right: the next try is a new letter to it, under a new key (the old key may be held for the old words)
  env.DISCOUNT_EMAIL = 'right@example.com';
  await lair.useConfig();
  nowIs(NOW + 11 * MIN);
  await lair.tillSalesUpkeep(Date.now());
  await settle();
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'right@example.com');
  assert.equal(mails[0].idempotencyKey, `till-over-${sale.id}-2`);
  row = saleRow(sale.id);
  assert.equal(row.over_mail, 'sent');
  assert.equal(row.over_error, null);
});

test("round 36: an email that never goes is given up on within a day, so the same email can't go twice", async () => {
  const { sale, hemi } = await overSale();
  mailFails = 1000;
  ok(await paid({ sale: sale.id, token: hemi, expect: OVER_TOTAL }));
  await settle();
  for (let m = 11; m < 23 * 60; m += 60) {
    nowIs(NOW + m * MIN);
    await lair.tillSalesUpkeep(Date.now());
    await settle();
  }
  assert.equal(saleRow(sale.id).over_mail, 'due');
  nowIs(NOW + 23 * HOUR + 5 * MIN);
  await lair.tillSalesUpkeep(Date.now());
  await settle();
  const row = saleRow(sale.id);
  assert.equal(row.over_mail, 'stopped');
  assert.match(row.over_error, /Resend is down/);
  // Resend working again a day on changes nothing: it's stopped
  mailFails = 0;
  nowIs(NOW + 25 * HOUR);
  await lair.tillSalesUpkeep(Date.now());
  await settle();
  assert.equal(mails.length, 0);
  assert.deepEqual(lair.alerts, []);
});

test("round 36: a flag Shopify didn't take is tried again, and the email doesn't wait for it", async () => {
  const { sale, hemi } = await overSale();
  shop.markFails = 1;
  const done = ok(await paid({ sale: sale.id, token: hemi, expect: OVER_TOTAL })).sale;
  await settle();
  assert.equal(mails.length, 1);
  assert.equal(shop.marked.length, 0);
  assert.equal(saleRow(sale.id).over_mark, 'due');
  nowIs(NOW + 11 * MIN);
  await lair.tillSalesUpkeep(Date.now());
  await settle();
  assert.deepEqual(shop.marked.map((m) => [m.orderId, m.tag]), [[done.order.id, 'discount-over-20']]);
  assert.equal(saleRow(sale.id).over_mark, 'done');
  assert.equal(mails.length, 1);
});

test("round 36: when Shopify is slow to make the order, the email waits for it, so it can name the order", async () => {
  const { sale, hemi } = await overSale();
  shop.completeFails = 1;
  const done = ok(await paid({ sale: sale.id, token: hemi, expect: OVER_TOTAL })).sale;
  await settle();
  assert.equal(done.order, null);
  assert.equal(mails.length, 0);
  assert.equal(shop.marked.length, 0);
  // the run makes the order 10 minutes on, and then it's flagged and the email goes
  nowIs(NOW + 10 * MIN + 1000);
  await lair.tillSalesUpkeep(Date.now());
  await settle();
  const row = saleRow(sale.id);
  assert.equal(row.order_status, 'made');
  assert.deepEqual(shop.marked.map((m) => m.orderId), [row.order_id]);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, `Till discount over 20%: ${row.order_name}, $55.00 off`);
});

test("round 36: but not for long: with no order after 10 minutes the email goes without one, and the order is flagged when it's made", async () => {
  const { sale, hemi } = await overSale();
  shop.completeFails = 2;
  ok(await paid({ sale: sale.id, token: hemi, expect: OVER_TOTAL }));
  await settle();
  // 10 minutes on: the order fails again, and the email goes anyway
  nowIs(NOW + 10 * MIN + 1000);
  await lair.tillSalesUpkeep(Date.now());
  await settle();
  assert.equal(saleRow(sale.id).order_status, 'failed');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, 'Till discount over 20%: $55.00 off, with no Shopify order yet');
  const text = mails[0].text.replace(/[ \t]+/g, ' ');
  assert.ok(text.includes("Order: Not in Shopify yet. The Lair is still making it: it will have the tag discount-over-20 when it's there."), text);
  assert.ok(!text.includes('Open the order in Shopify'));
  assert.equal(saleRow(sale.id).over_mark, 'due');
  // half an hour later the order is made: flagged then, and no second email
  nowIs(NOW + 41 * MIN);
  await lair.tillSalesUpkeep(Date.now());
  await settle();
  nowIs(NOW + 52 * MIN);
  await lair.tillSalesUpkeep(Date.now());
  await settle();
  const row = saleRow(sale.id);
  assert.equal(row.order_status, 'made');
  assert.deepEqual(shop.marked.map((m) => m.orderId), [row.order_id]);
  assert.equal(row.over_mark, 'done');
  assert.equal(mails.length, 1);
});

test("round 36: a sale whose order can't be made at all is still emailed about, saying so", async () => {
  const { sale, hemi } = await overSale();
  // someone deleted its draft in Shopify: the order can never be made, and the team hear about that as before
  shop.deleted.push(saleRow(sale.id).draft_id);
  ok(await paid({ sale: sale.id, token: hemi, expect: OVER_TOTAL }));
  await settle();
  const row = saleRow(sale.id);
  assert.equal(row.order_status, 'stopped');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, OWNER_NOTES);
  assert.equal(mails[0].subject, 'Till discount over 20%: $55.00 off, with no Shopify order');
  assert.ok(mails[0].text.replace(/[ \t]+/g, ' ').includes("Order: Shopify couldn't make its order, so there's nothing there to flag. The team have an email about making it by hand."));
  assert.equal(row.over_mark, 'stopped');
  assert.equal(row.over_mail, 'sent');
  assert.equal(shop.marked.length, 0);
  // (the team's own alert is about the order, as it always was: nothing in it about the discount)
  assert.equal(lair.alerts.length, 1);
  assert.match(lair.alerts[0], /^A till sale with no Shopify order/);
});

/* ---------------- where it goes ---------------- */
test("round 36: the email goes to the shop owner's own address, as Shopify has it, unless one is set for it; 'off' sends none", async () => {
  assert.ok(CONFIG_KEYS.includes('DISCOUNT_EMAIL'));
  /** A sale past 20%, paid, with whatever is due done → its row */
  const soldAt = async (ms) => {
    nowIs(ms);
    const hemi = await approve(HEMI, '1357');
    const sale = ok(await pay({ lines: OVER_LINES, person: MIA, method: 'card', token: hemi, discountOk: await approve(), overOk: true })).sale;
    ok(await paid({ sale: sale.id, token: hemi, expect: OVER_TOTAL }));
    await settle();
    return sale.id;
  };
  await onTill(RUA, '4711');
  await onTill(HEMI, '1357');
  // nothing set: the shop owner's email address in Shopify (Settings, Store details), asked for once an hour at most
  delete env.DISCOUNT_EMAIL;
  await soldAt(NOW);
  await soldAt(NOW + 5 * MIN);
  assert.deepEqual(mails.map((m) => m.to), ['the-owner@example.com', 'the-owner@example.com']);
  assert.equal(shop.ownerAsked, 1);
  // one set for it wins, and Shopify isn't asked
  env.DISCOUNT_EMAIL = OWNER_NOTES;
  await soldAt(NOW + 10 * MIN);
  assert.equal(mails.at(-1).to, OWNER_NOTES);
  assert.equal(shop.ownerAsked, 1);
  // off: no email, and the order is still flagged
  env.DISCOUNT_EMAIL = 'off';
  const off = await soldAt(NOW + 15 * MIN);
  assert.equal(mails.length, 3);
  assert.equal(saleRow(off).over_mail, 'off');
  assert.equal(saleRow(off).over_mark, 'done');
  assert.equal(shop.marked.length, 4);
  // set to something that isn't one address: nothing goes anywhere (it doesn't fall back), and it says why
  for (const [i, wrong] of ['mo@example.com, team@example.com', 'not an address'].entries()) {
    env.DISCOUNT_EMAIL = wrong;
    const id = await soldAt(NOW + (i + 1) * 2 * 24 * HOUR);
    assert.equal(saleRow(id).over_mail, 'due', wrong);
    assert.match(saleRow(id).over_error, /DISCOUNT_EMAIL/);
    nowIs(Date.now() + 23 * HOUR + 5 * MIN);
    await lair.tillSalesUpkeep(Date.now());
    await settle();
    assert.equal(saleRow(id).over_mail, 'stopped', wrong);
  }
  // nothing set and Shopify can't say whose shop it is: tried again, never sent to the team's address instead
  delete env.DISCOUNT_EMAIL;
  shop.ownerFails = true;
  const lost = await soldAt(NOW + 10 * 24 * HOUR);
  assert.equal(saleRow(lost).over_mail, 'due');
  assert.match(saleRow(lost).over_error, /owner/);
  shop.ownerFails = false;
  nowIs(Date.now() + 11 * MIN);
  await lair.tillSalesUpkeep(Date.now());
  await settle();
  assert.equal(saleRow(lost).over_mail, 'sent');
  assert.equal(mails.at(-1).to, 'the-owner@example.com');
  // and Shopify having no address for the owner sends none
  shop.owner = null;
  const none = await soldAt(NOW + 20 * 24 * HOUR);
  assert.equal(saleRow(none).over_mail, 'due');
  assert.equal(mails.length, 4);
  assert.ok(mails.every((m) => m.to !== ENV.STAFF_EMAIL));
  assert.deepEqual(lair.alerts, []);
});

test('round 36: with email not set up at all, the order is still flagged', async () => {
  delete env.RESEND_API_KEY;
  const { sale, hemi } = await overSale();
  ok(await paid({ sale: sale.id, token: hemi, expect: OVER_TOTAL }));
  await settle();
  assert.equal(shop.marked.length, 1);
  assert.equal(mails.length, 0);
  assert.equal(saleRow(sale.id).over_mail, 'due');
});

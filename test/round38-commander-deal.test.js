// Round 38, part 2: new Commander decks join the free sleeves deal by themselves (src/commander-deal.js). Mo, 15 Nov
// 2026, told that a new Commander deck had to go into Shopify's automatic discount "Free sleeves with a Commander deck"
// by hand: "Yes make a lair app to add them automatically". The decks are the ones the theme says come with free sleeves
// (snippets/deck-sleeves.liquid): "A Commander deck is Wizards of the Coast's, not a library copy, and its variant's
// title or its product's title says "Commander Deck" (or Decks), or its product's title ends in "Commander"", and "The
// automatic discount's decks are the same list". Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { ShopifyAdmin } from '../src/shopify.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { COMMANDER_DEAL, COMMANDER_DEAL_WORDS as W, deckProduct, deckOption, dealMissing } from '../src/commander-deal.js';

const time = new LairTime('Pacific/Auckland');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Sunday 15 November 2026, 9:00am in Auckland
const NOW = time.at('2026-11-15', 9 * 60);
const realNow = Date.now;
const realFetch = globalThis.fetch;
let clock = NOW;

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
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) }, waitUntil: () => {} };
}

/* ---------------- the shop, as Shopify had it on 15 Nov 2026 ---------------- */

const WOTC = 'Wizards of the Coast';
const P = (id) => `gid://shopify/Product/${id}`;
const V = (id) => `gid://shopify/ProductVariant/${id}`;
const product = (id, title, { vendor = WOTC, status = 'UNLISTED' } = {}) => ({ id: P(id), title, vendor, status });
const option = (id, title, of) => ({ id: V(id), title, product: of });

// The products Shopify finds with Commander in their titles (vendor Wizards of the Coast, not archived)
const BUNDLE = product('7496053522535', 'Magic MTG: Avatar the Last Airbender - Commander\'s Bundle');
const LIBRARY = product('10258368921703', 'Magic: The Gathering Commander Decks (Library)', { status: 'ACTIVE' });
const SUPER_HEROES = product('7777110425703', 'MTG - Super Heroes - Commander', { status: 'ACTIVE' });
const DECKS = [
  product('7505942118503', 'Magic the Gathering Lorwyn Eclipsed Commander Deck'),
  product('7505986322535', 'Magic the Gathering Bloomburrow Commander Decks'),
  product('7578798915687', 'Magic the Gathering: Tarkir Dragonstorm Commander Decks'),
  product('7578808877159', 'Magic the Gathering The Lost Caverns of Ixalan Commander Decks'),
  product('7578812612711', 'Magic the Gathering: TMNT Turtle Power Commander Deck'),
  product('7578816053351', 'Magic the Gathering: Edge of Eternities Commander Deck'),
  product('7642175045735', 'MTG - Aetherdrift - Commander Deck - Living Energy'),
  product('7642175307879', 'MTG - Aetherdrift - Commander Deck - Eternal Might'),
  product('7642175668327', 'MTG - LOTR - Commander Deck - Food and Fellowship'),
  product('7642175799399', 'MTG - LOTR - Commander Deck - Elven Council'),
  SUPER_HEROES,
  product('7815183401063', 'MTG - March of the Machine - Commander Deck - Call for Backup'),
  product('10305361444967', 'Magic the Gathering: Final Fantasy Commander Decks', { status: 'ACTIVE' }),
];
// The options Shopify finds with Commander in their own titles
const STAR_TREK = product('10293647507559', 'Magic the Gathering - Star Trek', { status: 'ACTIVE' });
const REALITY = product('10247872839783', 'Reality Fracture', { status: 'ACTIVE' });
const OPTION_DECKS = [
  option('50423747706983', 'Commander Deck', REALITY),
  option('51048858648679', 'Commander Deck - Klingon Fury', STAR_TREK),
  option('51048858681447', 'Commander Deck - We are the Borg', STAR_TREK),
  option('51048858714215', 'Commander Deck - Federation Fleet', STAR_TREK),
  option('51048858746983', 'Commander Deck - Landing Party', STAR_TREK),
  option('51049668378727', 'Collector Commander Deck - Klingon Fury', STAR_TREK),
  option('51049668411495', 'Collector Commander Deck - We are the Borg', STAR_TREK),
  option('51049668444263', 'Collector Commander Deck - Federation Fleet', STAR_TREK),
  option('51049668477031', 'Collector Commander Deck - Landing Party', STAR_TREK),
];
const COLLECTORS_SET = option('44556211421287', "Collector's Commander Deck Set", SUPER_HEROES);

// New this week, for the tests: a deck of its own, and a deck sold as an option beside its set's boosters
const STRIXHAVEN = product('10400000000001', 'MTG - Secrets of Strixhaven - Commander Deck - Witherbloom Witchcraft', { status: 'ACTIVE' });
const LORWYN_SET = product('10400000000002', 'MTG - Lorwyn Eclipsed', { status: 'ACTIVE' });
const ELEMENTAL = option('10400000000003', 'Commander Deck - Elemental Fury', LORWYN_SET);
const LORWYN_BOOSTER = option('10400000000004', 'Play Booster Box', LORWYN_SET);

const DEAL_ID = 'gid://shopify/DiscountAutomaticNode/1497965363303';
const TITLE = 'Free sleeves with a Commander deck';
const SETTINGS = { lair_hours: DEFAULT_HOURS, lair_shop_tables: '', deck_sleeves_show: true };
const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];

let lair;
// Shopify's side: what the searches find, the automatic Buy X get Y discounts (live and scheduled), each one's
// "Customer buys", and what was asked of it
let shop;
let staff;

function freshShop() {
  return {
    products: [BUNDLE, LIBRARY, ...DECKS],
    variants: [COLLECTORS_SET, ...OPTION_DECKS],
    more: false,
    deals: new Map([[DEAL_ID, { id: DEAL_ID, title: TITLE, status: 'ACTIVE', kind: 'products', value: { quantity: '1' }, products: DECKS.map((d) => d.id), variants: OPTION_DECKS.map((o) => o.id), more: false }]]),
    searches: 0,
    reads: [],
    adds: [],
    refuse: null,
    fail: null,
  };
}

const rulesWith = (settings = {}) => rulesFromSettings({ ...SETTINGS, ...settings }, ROOMS, []);
const upkeep = (options = {}) => lair.commanderDealUpkeep(lair.rulesCache, clock, options);
const dealOf = (id = DEAL_ID) => shop.deals.get(id);
const staffMails = () => staff.splice(0, staff.length);

beforeEach(() => {
  clock = NOW;
  Date.now = () => clock;
  globalThis.fetch = async (url) => {
    throw new Error(`No network in tests: ${url}`);
  };
  shop = freshShop();
  staff = [];
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.commanderDealSearch = async () => {
    shop.searches += 1;
    if (shop.fail) throw shop.fail;
    return {
      products: shop.products.map((p) => ({ ...p })),
      variants: shop.variants.map((v) => ({ ...v, product: { ...v.product } })),
      more: shop.more,
      deals: [...shop.deals.values()].map((d) => ({ id: d.id, title: d.title, status: d.status })),
    };
  };
  lair.shopify.freeSleevesDeal = async (id) => {
    shop.reads.push(id);
    const d = shop.deals.get(id);
    return { ...d, products: [...d.products], variants: [...d.variants] };
  };
  lair.shopify.addToFreeSleevesDeal = async (id, change) => {
    shop.adds.push({ id, ...change });
    if (shop.refuse) throw Object.assign(new Error(`Shopify said no: ${shop.refuse}`), { refused: true, said: shop.refuse });
    const d = shop.deals.get(id);
    for (const p of change.products || []) if (!d.products.includes(p)) d.products.push(p);
    for (const v of change.variants || []) if (!d.variants.includes(v)) d.variants.push(v);
    return true;
  };
  lair.notifyStaff = (subject, content) => staff.push({ subject, ...content });
  lair.rulesCache = rulesWith();
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
});

/* ================ 1. Which products are Commander decks: the theme's list ================ */

test("the decks are the theme's: Wizards of the Coast's, not a library copy, a product whose title says Commander Deck (or Decks) or ends in Commander counts whole, otherwise an option whose own title says Commander Deck counts alone", () => {
  // every product in the deal today counts whole, and every option in it counts alone
  for (const deck of DECKS) assert.equal(deckProduct(deck), true, deck.title);
  for (const deck of OPTION_DECKS) assert.equal(deckOption(deck), true, `${deck.product.title}: ${deck.title}`);
  // a Commander's Bundle isn't a deck (15 Nov 2026, the separate review), nor is a library copy
  assert.equal(deckProduct(BUNDLE), false);
  assert.equal(deckProduct(LIBRARY), false);
  // an option of a product that counts whole isn't added on its own: the product covers it
  assert.equal(deckOption(COLLECTORS_SET), false);
  // another make's deck case, a set's boxes beside its decks, and Wizards' own boxes with Commander in the name aren't
  assert.equal(deckProduct(product('1', 'Commander Deck Case', { vendor: 'Ultimate Guard' })), false);
  assert.equal(deckOption(LORWYN_BOOSTER), false);
  assert.equal(deckProduct(product('2', 'MTG - Commander Masters - Set Booster Box')), false);
  assert.equal(deckOption(option('3', 'Commander Deck', product('4', 'Commander Deck Box', { vendor: 'Ultimate Guard' }))), false);
  assert.equal(deckOption(option('5', 'Commander Deck', product('6', 'Magic the Gathering Commander Decks (Library)'))), false);
  // case and spaces at either end don't matter, as the theme downcases and strips them
  assert.equal(deckProduct(product('7', '  MTG - FOUNDATIONS - COMMANDER  ', { vendor: ' wizards of the COAST ' })), true);
  assert.equal(deckOption(option('8', 'COMMANDER DECK - Jump Scare', STAR_TREK)), true);
  // a deck being set up (draft) counts, ready for the day it's listed; an archived one doesn't
  assert.equal(deckProduct(product('9', 'MTG - Duskmourn - Commander Deck - Jump Scare', { status: 'DRAFT' })), true);
  assert.equal(deckProduct(product('10', 'MTG - Dominaria - Commander Deck - Legends Legacy', { status: 'ARCHIVED' })), false);
  assert.equal(deckOption(option('11', 'Commander Deck', product('12', 'MTG - Dominaria', { status: 'ARCHIVED' }))), false);
});

test("what a deal is missing: decks it doesn't have, never one already in it, never an option whose whole product is in it, and never one taken out by hand", () => {
  const deal = { products: new Set(DECKS.map((d) => d.id)), variants: new Set(OPTION_DECKS.map((o) => o.id)) };
  const found = { products: [BUNDLE, LIBRARY, ...DECKS, STRIXHAVEN], variants: [COLLECTORS_SET, ...OPTION_DECKS, ELEMENTAL, LORWYN_BOOSTER] };
  // today's deal has every deck: nothing missing
  assert.deepEqual(dealMissing(deal, { products: [BUNDLE, LIBRARY, ...DECKS], variants: [COLLECTORS_SET, ...OPTION_DECKS] }), { products: [], variants: [] });
  // this week's new deck and new option
  assert.deepEqual(dealMissing(deal, found), {
    products: [{ id: STRIXHAVEN.id, title: STRIXHAVEN.title }],
    variants: [{ id: ELEMENTAL.id, product: 'MTG - Lorwyn Eclipsed', option: 'Commander Deck - Elemental Fury' }],
  });
  // someone put the whole of Lorwyn Eclipsed in by hand: its deck option isn't added as well
  assert.deepEqual(dealMissing({ ...deal, products: new Set([...deal.products, LORWYN_SET.id]) }, found).variants, []);
  // taken out by hand: left out
  assert.deepEqual(dealMissing(deal, found, new Set([STRIXHAVEN.id, ELEMENTAL.id])), { products: [], variants: [] });
  // the same product found twice is added once
  assert.deepEqual(dealMissing(deal, { products: [STRIXHAVEN, STRIXHAVEN], variants: [] }).products.length, 1);
});

test("the theme's settings: on only once the live theme says Commander decks come with free sleeves, and the discount by Theme settings › Commander decks › Discount title (Free sleeves with a Commander deck when it's empty)", () => {
  assert.deepEqual(rulesWith().sleeves, { on: true, title: TITLE });
  assert.deepEqual(rulesFromSettings({ lair_hours: DEFAULT_HOURS }, ROOMS, []).sleeves, { on: false, title: TITLE });
  assert.equal(rulesWith({ deck_sleeves_show: false }).sleeves.on, false);
  assert.equal(rulesWith({ deck_sleeves_discount: '  Sleeves on us  ' }).sleeves.title, 'Sleeves on us');
  assert.equal(rulesWith({ deck_sleeves_discount: '   ' }).sleeves.title, TITLE);
  assert.equal(COMMANDER_DEAL.title, TITLE);
});

/* ================ 2. Every hour: what's missing is added, and staff are told ================ */

test("every hour, while the theme says Commander decks come with free sleeves: a new deck and a new deck option go into the deal, with its Customer buys quantity as it was, and staff hear which, word for word", async () => {
  shop.products.push(STRIXHAVEN);
  shop.variants.push(ELEMENTAL, LORWYN_BOOSTER);
  const result = await upkeep();
  assert.deepEqual(shop.adds, [{ id: DEAL_ID, products: [STRIXHAVEN.id], variants: [ELEMENTAL.id], value: { quantity: '1' } }]);
  assert.ok(dealOf().products.includes(STRIXHAVEN.id) && dealOf().variants.includes(ELEMENTAL.id));
  assert.ok(!dealOf().variants.includes(LORWYN_BOOSTER.id), "the set's boosters aren't");
  assert.deepEqual(result, { deals: 1, added: 2 });
  assert.deepEqual(staffMails(), [{
    subject: W.addedSubject,
    title: W.addedTitle,
    intro: W.addedIntro(2, TITLE),
    details: [[STRIXHAVEN.title, W.everyOption], ['MTG - Lorwyn Eclipsed', 'Commander Deck - Elemental Fury']],
    outro: W.addedOutro(TITLE),
  }]);
  assert.equal(W.addedSubject, 'New Commander decks in the free sleeves deal');
  assert.equal(W.addedTitle, 'Free sleeves with these too');
  assert.equal(W.addedIntro(1, TITLE), 'Gobgob added this to Shopify\'s automatic discount "Free sleeves with a Commander deck", so a pack of sleeves comes free with it, as its page already says.');
  assert.equal(W.addedIntro(2, TITLE), 'Gobgob added these 2 to Shopify\'s automatic discount "Free sleeves with a Commander deck", so a pack of sleeves comes free with each, as their pages already say.');
  assert.equal(W.everyOption, 'Every option');
  assert.equal(W.addedOutro(TITLE), 'If one shouldn\'t come with free sleeves, take it out of the discount in Shopify (Discounts › Free sleeves with a Commander deck) and Gobgob will leave it out.');
});

test("nothing missing (the deal as it is today): Shopify is asked, nothing is changed and nobody is emailed", async () => {
  assert.deepEqual(await upkeep(), { deals: 1, added: 0 });
  assert.equal(shop.searches, 1);
  assert.deepEqual(shop.adds, []);
  assert.deepEqual(staffMails(), []);
});

test('once an hour: a run 10 minutes later doesn\'t ask Shopify again, an hour after the last look does, and the setup check (force) looks straight away', async () => {
  await upkeep();
  clock += 10 * MIN;
  assert.equal(await upkeep(), null);
  clock += 49 * MIN;
  assert.equal(await upkeep(), null);
  assert.equal(shop.searches, 1);
  clock += MIN;
  shop.products.push(STRIXHAVEN);
  assert.deepEqual(await upkeep(), { deals: 1, added: 1 });
  assert.equal(shop.searches, 2);
  clock += MIN;
  assert.deepEqual(await upkeep({ force: true }), { deals: 1, added: 0 });
  assert.equal(shop.searches, 3);
});

test("off while the theme doesn't say Commander decks come with free sleeves: Shopify isn't asked, and nothing is used up (it looks as soon as it's on again)", async () => {
  lair.rulesCache = rulesWith({ deck_sleeves_show: false });
  shop.products.push(STRIXHAVEN);
  assert.equal(await upkeep(), null);
  assert.equal(shop.searches, 0);
  lair.rulesCache = rulesWith();
  clock += MIN;
  assert.deepEqual(await upkeep(), { deals: 1, added: 1 });
});

test("Cloudflare's free plan (50 outside calls an invocation): with fewer than 5 of the run's calls left it waits for the next run, and the hour isn't used up", async () => {
  assert.equal(COMMANDER_DEAL.calls, 5);
  const asked = [];
  assert.equal(await upkeep({ budget: { has: (n) => (asked.push(n), false) } }), null);
  assert.deepEqual(asked, [5]);
  assert.equal(shop.searches, 0);
  clock += 10 * MIN;
  assert.deepEqual(await upkeep({ budget: { has: () => true } }), { deals: 1, added: 0 });
});

test("it only ever adds: a deck renamed so it isn't one, an archived deck and anything staff put in by hand all stay in the deal", async () => {
  const handPicked = P('5550000000001');
  dealOf().products.push(handPicked);
  // Lorwyn's deck renamed, and Bloomburrow's archived (Shopify's search leaves archived products out)
  shop.products = shop.products.map((p) => (p.id === DECKS[0].id ? { ...p, title: 'Magic the Gathering Lorwyn Eclipsed Precon' } : p)).filter((p) => p.id !== DECKS[1].id);
  shop.products.push(STRIXHAVEN);
  await upkeep();
  assert.equal(shop.adds.length, 1);
  for (const key of Object.keys(shop.adds[0])) assert.ok(['id', 'products', 'variants', 'value'].includes(key), key);
  assert.ok([handPicked, DECKS[0].id, DECKS[1].id].every((id) => dealOf().products.includes(id)));
});

test('a deck someone took out of the discount by hand stays out, even one the Lair put in before its next look', async () => {
  // seen in the deal at the first look, then taken out
  await upkeep();
  dealOf().products = dealOf().products.filter((id) => id !== DECKS[2].id);
  clock += HOUR;
  assert.deepEqual(await upkeep(), { deals: 1, added: 0 });
  assert.ok(!dealOf().products.includes(DECKS[2].id));
  // the Lair adds a new deck, then someone takes it out before the next look
  shop.products.push(STRIXHAVEN);
  clock += HOUR;
  assert.deepEqual(await upkeep(), { deals: 1, added: 1 });
  dealOf().products = dealOf().products.filter((id) => id !== STRIXHAVEN.id);
  staffMails();
  clock += HOUR;
  assert.deepEqual(await upkeep(), { deals: 1, added: 0 });
  assert.deepEqual(staffMails(), []);
  assert.ok(!dealOf().products.includes(STRIXHAVEN.id));
});

test('a new deal with the same title (Mo made it again) gets every deck: what was taken out of the old one is the old one\'s', async () => {
  await upkeep();
  dealOf().products = dealOf().products.filter((id) => id !== DECKS[3].id);
  clock += HOUR;
  await upkeep();
  // the old deal ends; a new one starts with only Final Fantasy's decks in it
  shop.deals.delete(DEAL_ID);
  const fresh = 'gid://shopify/DiscountAutomaticNode/1499000000001';
  shop.deals.set(fresh, { id: fresh, title: TITLE, status: 'ACTIVE', kind: 'products', value: { quantity: '1' }, products: [DECKS[12].id], variants: [], more: false });
  clock += HOUR;
  const result = await upkeep();
  assert.deepEqual(result, { deals: 1, added: DECKS.length - 1 + OPTION_DECKS.length });
  assert.ok(DECKS.every((d) => dealOf(fresh).products.includes(d.id)));
  assert.ok(OPTION_DECKS.every((o) => dealOf(fresh).variants.includes(o.id)));
});

test('a deal scheduled to start later with the same title is filled too (at most two deals), and one with another title is never touched', async () => {
  const later = 'gid://shopify/DiscountAutomaticNode/1499000000002';
  const other = 'gid://shopify/DiscountAutomaticNode/1499000000003';
  shop.deals.set(later, { id: later, title: TITLE, status: 'SCHEDULED', kind: 'products', value: { quantity: '2' }, products: [], variants: [], more: false });
  shop.deals.set(other, { id: other, title: 'Buy any 2 dice, get the 3rd free', status: 'ACTIVE', kind: 'products', value: { quantity: '2' }, products: [], variants: [], more: false });
  assert.deepEqual(await upkeep(), { deals: 2, added: DECKS.length + OPTION_DECKS.length });
  assert.deepEqual(shop.adds.map((a) => [a.id, a.value]), [[later, { quantity: '2' }]]);
  assert.deepEqual(shop.reads, [DEAL_ID, later]);
  // a title has to match the theme's exactly (spaces at either end aside), as the cart's does
  shop.deals.delete(later);
  shop.deals.set(other, { ...dealOf(other), title: 'free sleeves with a commander deck' });
  shop.reads = [];
  clock += HOUR;
  assert.deepEqual(await upkeep(), { deals: 1, added: 0 });
  assert.deepEqual(shop.reads, [DEAL_ID]);
  shop.deals.set(other, { ...dealOf(other), title: `  ${TITLE} ` });
  clock += HOUR;
  assert.deepEqual(await upkeep(), { deals: 2, added: DECKS.length + OPTION_DECKS.length });
});

/* ================ 3. When the deal can't be kept, staff hear once ================ */

test("no live discount with the theme's title while the theme still says decks come with free sleeves: staff hear once, word for word, and again only after it's been put right and gone again", async () => {
  shop.deals.clear();
  assert.deepEqual(await upkeep(), { deals: 0, added: 0, problem: 'missing' });
  assert.deepEqual(staffMails(), [{ subject: W.missingSubject, title: W.missingTitle, intro: W.missingIntro(TITLE), outro: W.missingOutro }]);
  assert.equal(W.missingSubject, 'Free sleeves: the deal is missing in Shopify');
  assert.equal(W.missingTitle, "Shopify doesn't have the free sleeves deal");
  assert.equal(W.missingIntro(TITLE), 'The website says Commander decks come with free sleeves, but Shopify has no live automatic discount called "Free sleeves with a Commander deck", so Gobgob can\'t add new decks to it and the cart won\'t say the sleeves are free.');
  assert.equal(W.missingOutro, 'If the deal has ended, turn off Theme settings › Commander decks › Say Commander decks come with free sleeves. If the discount has a new name, put it in Theme settings › Commander decks › Discount title.');
  clock += HOUR;
  await upkeep();
  assert.deepEqual(staffMails(), [], 'once');
  shop.deals = freshShop().deals;
  clock += HOUR;
  assert.deepEqual(await upkeep(), { deals: 1, added: 0 });
  assert.deepEqual(staffMails(), [], 'nothing when it works again');
  shop.deals.clear();
  clock += HOUR;
  await upkeep();
  assert.equal(staffMails().length, 1, 'and again when it goes again');
});

test("a deal whose Customer buys is a collection, or too long to read whole (over 250 products or options): nothing is added, and staff hear once", async () => {
  shop.products.push(STRIXHAVEN);
  shop.deals.set(DEAL_ID, { ...dealOf(), kind: 'collections', products: [], variants: [] });
  assert.deepEqual(await upkeep(), { deals: 1, added: 0, problem: 'collections' });
  assert.deepEqual(shop.adds, []);
  assert.deepEqual(staffMails(), [{ subject: W.collectionSubject, title: W.collectionTitle, intro: W.collectionIntro(TITLE), outro: W.collectionOutro }]);
  assert.equal(W.collectionSubject, "Free sleeves: new decks can't go in");
  assert.equal(W.collectionTitle, 'The free sleeves deal picks a collection');
  assert.equal(W.collectionIntro(TITLE), 'Shopify\'s automatic discount "Free sleeves with a Commander deck" gets its decks from a collection, not a list of products, so Gobgob can\'t add new Commander decks to it.');
  assert.equal(W.collectionOutro, "Add new decks to that collection, or set the discount's Customer buys back to specific products.");
  clock += HOUR;
  await upkeep();
  assert.deepEqual(staffMails(), [], 'once');
  shop.deals = freshShop().deals;
  dealOf().more = true;
  clock += HOUR;
  assert.deepEqual(await upkeep(), { deals: 1, added: 0, problem: 'too-many' });
  assert.deepEqual(shop.adds, []);
  assert.deepEqual(staffMails(), [{ subject: W.longSubject, title: W.longTitle, intro: W.longIntro(TITLE), outro: W.longOutro }]);
  assert.equal(W.longSubject, "Free sleeves: the deal's too long to check");
  assert.equal(W.longTitle, 'The free sleeves deal is too long to check');
  assert.equal(W.longIntro(TITLE), 'Shopify\'s automatic discount "Free sleeves with a Commander deck" has more than 250 products or options, more than Gobgob reads at once, so Gobgob didn\'t add any new decks.');
  assert.equal(W.longOutro, 'Add new decks to it by hand until the Lair reads more of it.');
});

test('Shopify says no to adding them: tried again the next hour, staff hear once with what Shopify said and which decks, and nothing is counted as taken out', async () => {
  shop.products.push(STRIXHAVEN);
  shop.refuse = 'Customer buys must have fewer than 100 items';
  assert.deepEqual(await upkeep(), { deals: 1, added: 0, problem: 'refused' });
  assert.deepEqual(staffMails(), [{
    subject: W.refusedSubject,
    title: W.refusedTitle,
    intro: W.refusedIntro(TITLE, 'Customer buys must have fewer than 100 items'),
    details: [[STRIXHAVEN.title, W.everyOption]],
    outro: W.refusedOutro,
  }]);
  assert.equal(W.refusedSubject, 'Free sleeves: Shopify said no to new decks');
  assert.equal(W.refusedTitle, 'New decks not added');
  assert.equal(W.refusedIntro(TITLE, 'Customer buys must have fewer than 100 items'), 'Gobgob tried to add new Commander decks to Shopify\'s automatic discount "Free sleeves with a Commander deck", and Shopify said: Customer buys must have fewer than 100 items');
  assert.equal(W.refusedOutro, 'Gobgob tries again every hour. If Shopify keeps saying no, add them by hand.');
  clock += HOUR;
  await upkeep();
  assert.equal(shop.adds.length, 2, 'tried again');
  assert.deepEqual(staffMails(), [], 'once');
  shop.refuse = null;
  clock += HOUR;
  assert.deepEqual(await upkeep(), { deals: 1, added: 1 });
  assert.equal(staffMails()[0].subject, W.addedSubject);
});

test("Shopify can't be reached: the run's error is logged by the 10-minute run, and it looks again in an hour, not every 10 minutes", async () => {
  shop.fail = new Error('Shopify API error 502');
  await assert.rejects(upkeep(), /502/);
  clock += 10 * MIN;
  assert.equal(await upkeep(), null);
  shop.fail = null;
  clock += 50 * MIN;
  assert.deepEqual(await upkeep(), { deals: 1, added: 0 });
});

/* ================ 4. Shopify's side (src/shopify.js) ================ */

test("Shopify's side: one search finds products and options with Commander in their titles (Wizards', not archived) and the live and scheduled automatic Buy X get Y deals; a deal's Customer buys is read in full; adding sends only what's to add, with the quantity as it was", async () => {
  const admin = new ShopifyAdmin({ SHOP: 'dice-goblin.myshopify.com', SHOPIFY_CLIENT_ID: 'x', SHOPIFY_CLIENT_SECRET: 'y' }, null);
  const asked = [];
  let answer = null;
  admin.graphql = async (query, variables) => {
    asked.push({ query, variables });
    return answer;
  };
  answer = {
    products: { nodes: [{ id: STRIXHAVEN.id, title: STRIXHAVEN.title, vendor: WOTC, status: 'ACTIVE' }], pageInfo: { hasNextPage: false } },
    productVariants: { nodes: [{ id: ELEMENTAL.id, title: ELEMENTAL.title, product: { ...LORWYN_SET } }], pageInfo: { hasNextPage: true } },
    discountNodes: { nodes: [
      { id: DEAL_ID, discount: { __typename: 'DiscountAutomaticBxgy', title: TITLE, status: 'ACTIVE' } },
      { id: 'gid://shopify/DiscountAutomaticNode/2', discount: { __typename: 'DiscountAutomaticApp', title: TITLE, status: 'ACTIVE' } },
    ] },
  };
  const found = await admin.commanderDealSearch();
  assert.deepEqual(found, {
    products: [{ id: STRIXHAVEN.id, title: STRIXHAVEN.title, vendor: WOTC, status: 'ACTIVE' }],
    variants: [{ id: ELEMENTAL.id, title: ELEMENTAL.title, product: { ...LORWYN_SET } }],
    more: true,
    deals: [{ id: DEAL_ID, title: TITLE, status: 'ACTIVE' }],
  });
  assert.deepEqual(asked[0].variables, {
    products: "vendor:'Wizards of the Coast' AND -status:archived AND title:*commander*",
    variants: "vendor:'Wizards of the Coast' AND title:*commander*",
    deals: 'method:automatic AND type:bxgy AND status:active,scheduled',
  });
  assert.match(asked[0].query, /products\(first: 250, query: \$products\)/);
  assert.match(asked[0].query, /productVariants\(first: 250, query: \$variants\)/);
  assert.match(asked[0].query, /discountNodes\(first: 50, query: \$deals\)/);

  answer = { discountNode: { id: DEAL_ID, discount: { __typename: 'DiscountAutomaticBxgy', title: TITLE, status: 'ACTIVE', customerBuys: {
    value: { __typename: 'DiscountQuantity', quantity: '1' },
    items: { __typename: 'DiscountProducts', products: { nodes: [{ id: DECKS[0].id }], pageInfo: { hasNextPage: false } }, productVariants: { nodes: [{ id: OPTION_DECKS[0].id }], pageInfo: { hasNextPage: false } } },
  } } } };
  assert.deepEqual(await admin.freeSleevesDeal(DEAL_ID), { id: DEAL_ID, title: TITLE, status: 'ACTIVE', kind: 'products', value: { quantity: '1' }, products: [DECKS[0].id], variants: [OPTION_DECKS[0].id], more: false });
  assert.deepEqual(asked[1].variables, { id: DEAL_ID });
  assert.match(asked[1].query, /products\(first: 250\)/);
  assert.match(asked[1].query, /productVariants\(first: 250\)/);
  // a spend to reach (buy $X) is kept as it was; a collection is just that
  answer.discountNode.discount.customerBuys.value = { __typename: 'DiscountPurchaseAmount', amount: '50.0' };
  assert.deepEqual((await admin.freeSleevesDeal(DEAL_ID)).value, { amount: '50.0' });
  answer.discountNode.discount.customerBuys.items = { __typename: 'DiscountCollections' };
  assert.equal((await admin.freeSleevesDeal(DEAL_ID)).kind, 'collections');
  answer = { discountNode: null };
  assert.equal(await admin.freeSleevesDeal(DEAL_ID), null);

  answer = { discountAutomaticBxgyUpdate: { automaticDiscountNode: { id: DEAL_ID }, userErrors: [] } };
  assert.equal(await admin.addToFreeSleevesDeal(DEAL_ID, { products: [STRIXHAVEN.id], variants: [], value: { quantity: '1' } }), true);
  const sent = asked.at(-1);
  assert.match(sent.query, /discountAutomaticBxgyUpdate\(id: \$id, automaticBxgyDiscount: \{ customerBuys: \$buys \}\)/);
  assert.deepEqual(sent.variables, { id: DEAL_ID, buys: { value: { quantity: '1' }, items: { products: { productsToAdd: [STRIXHAVEN.id] } } } });
  await admin.addToFreeSleevesDeal(DEAL_ID, { products: [], variants: [ELEMENTAL.id], value: { quantity: '1' } });
  assert.deepEqual(asked.at(-1).variables.buys.items, { products: { productVariantsToAdd: [ELEMENTAL.id] } });
  answer = { discountAutomaticBxgyUpdate: { automaticDiscountNode: null, userErrors: [{ field: ['automaticBxgyDiscount'], message: 'Too many items', code: 'INVALID' }] } };
  await assert.rejects(admin.addToFreeSleevesDeal(DEAL_ID, { products: [STRIXHAVEN.id], value: { quantity: '1' } }), (error) => error.refused === true && error.said === 'Too many items');
});

/* ================ 5. The 10-minute run looks after it ================ */

test('the 10-minute run (maintenance) looks after the deal, with what is left of its outside calls, once an hour', async () => {
  lair.shopify.appInfo = async () => ({ app: { title: 'Dice Goblin Lair' }, shop: { name: 'Dice Goblin' }, scopes: ['write_discounts', 'read_products'] });
  lair.ensureWebhook = async () => ({ ok: true });
  shop.products.push(STRIXHAVEN);
  const first = await lair.checkConnection('https://lair.test/webhooks/orders-paid');
  assert.deepEqual(first.commanderDeal, { deals: 1, added: 1 });
  assert.ok(dealOf().products.includes(STRIXHAVEN.id));
  clock += 10 * MIN;
  const second = await lair.checkConnection('https://lair.test/webhooks/orders-paid');
  assert.equal(second.commanderDeal, undefined);
  assert.equal(shop.searches, 1);
});

// Round 38, part 2 (15 Nov 2026, contract v38-order-rolls, section 4c): new Commander decks join the free sleeves deal
// by themselves. Mo, told that a new Commander deck had to go into Shopify's discount by hand: "Yes make a lair app to
// add them automatically".
//
// These are methods of the Lair Durable Object (src/lair.js mixes them in with Object.assign(Lair.prototype, …)).
// - The deal is Shopify's automatic discount "Free sleeves with a Commander deck" (Buy X get Y: each Commander deck in
//   the cart makes one pack from the Card sleeves collection free, every time). The theme names it in Theme settings ›
//   Commander decks › Discount title, and says which products come with free sleeves (snippets/deck-sleeves.liquid):
//   Wizards of the Coast's, not a library copy, and the product's title says "Commander Deck" (or Decks) or ends in
//   "Commander" (the whole product, every option), or else the option's own title says "Commander Deck" (that option
//   alone: Star Trek's decks sit beside its boosters). The discount's decks are the same list. Archived products aren't.
// - Every hour while the live theme says Commander decks come with free sleeves, the 10-minute run asks Shopify for the
//   products and options with Commander in their titles and for the live (and scheduled) automatic discounts with that
//   title, and adds the decks each is missing, with its Customer buys quantity as it was.
// - It only ever adds: nothing comes out of the deal (a deck renamed or archived, anything staff put in by hand), so a
//   mistake can't end it. A deck that was in a deal when the Lair looked, and isn't now, was taken out in Shopify by
//   hand, and stays out: the deal is still Shopify's to change. Staff are emailed what was added, so one that shouldn't
//   count is caught, and once when the deal can't be kept (no live discount with that title while the theme still says
//   decks come with free sleeves, Customer buys that isn't a list of products, or Shopify saying no).
import { HOUR } from './core.js';

export const COMMANDER_DEAL = Object.freeze({
  // the theme's discount title when Theme settings › Commander decks › Discount title is empty
  title: 'Free sleeves with a Commander deck',
  vendor: 'wizards of the coast',
  everyMs: HOUR,
  // a deal's run makes at most this many outside calls (Cloudflare's free plan: 50 an invocation, src/shop-filters.js):
  // the search, each deal's Customer buys, and adding to each
  calls: 5,
  // the most deals with that title it looks after (one live, one scheduled to follow it)
  deals: 2,
});

export const COMMANDER_DEAL_TABLES = [
  // each product (gid://shopify/Product/…) and option (gid://shopify/ProductVariant/…) the Lair has seen in a deal, or
  // put in it: one seen before and missing now was taken out by hand
  `CREATE TABLE IF NOT EXISTS commander_deal_items (
     discount_id TEXT NOT NULL, item_id TEXT NOT NULL, title TEXT, seen_at INTEGER NOT NULL, added_at INTEGER,
     PRIMARY KEY (discount_id, item_id))`,
];

/** What staff read, word for word (test/round38-commander-deal.test.js) */
export const COMMANDER_DEAL_WORDS = Object.freeze({
  addedSubject: 'New Commander decks in the free sleeves deal',
  addedTitle: 'Free sleeves with these too',
  addedIntro: (n, title) =>
    n === 1
      ? `Gobgob added this to Shopify's automatic discount "${title}", so a pack of sleeves comes free with it, as its page already says.`
      : `Gobgob added these ${n} to Shopify's automatic discount "${title}", so a pack of sleeves comes free with each, as their pages already say.`,
  everyOption: 'Every option',
  addedOutro: (title) => `If one shouldn't come with free sleeves, take it out of the discount in Shopify (Discounts › ${title}) and Gobgob will leave it out.`,
  missingSubject: 'Free sleeves: the deal is missing in Shopify',
  missingTitle: "Shopify doesn't have the free sleeves deal",
  missingIntro: (title) =>
    `The website says Commander decks come with free sleeves, but Shopify has no live automatic discount called "${title}", so Gobgob can't add new decks to it and the cart won't say the sleeves are free.`,
  missingOutro:
    'If the deal has ended, turn off Theme settings › Commander decks › Say Commander decks come with free sleeves. If the discount has a new name, put it in Theme settings › Commander decks › Discount title.',
  collectionSubject: "Free sleeves: new decks can't go in",
  collectionTitle: 'The free sleeves deal picks a collection',
  collectionIntro: (title) =>
    `Shopify's automatic discount "${title}" gets its decks from a collection, not a list of products, so Gobgob can't add new Commander decks to it.`,
  collectionOutro: "Add new decks to that collection, or set the discount's Customer buys back to specific products.",
  longSubject: "Free sleeves: the deal's too long to check",
  longTitle: 'The free sleeves deal is too long to check',
  longIntro: (title) =>
    `Shopify's automatic discount "${title}" has more than 250 products or options, more than Gobgob reads at once, so Gobgob didn't add any new decks.`,
  longOutro: 'Add new decks to it by hand until the Lair reads more of it.',
  refusedSubject: 'Free sleeves: Shopify said no to new decks',
  refusedTitle: 'New decks not added',
  refusedIntro: (title, said) => `Gobgob tried to add new Commander decks to Shopify's automatic discount "${title}", and Shopify said: ${said}`,
  refusedOutro: 'Gobgob tries again every hour. If Shopify keeps saying no, add them by hand.',
});
const W = COMMANDER_DEAL_WORDS;

/* ---------------- which products are Commander decks: the theme's list (snippets/deck-sleeves.liquid) ---------------- */
// The theme downcases and strips the vendor and the product's title, and downcases an option's title
const low = (text) => String(text ?? '').toLowerCase().trim();
const wizards = (product) => Boolean(product) && product.status !== 'ARCHIVED' && low(product.vendor) === COMMANDER_DEAL.vendor && !low(product.title).includes('(library)');

/** A product that's Commander decks as a whole, every option: its title says Commander Deck (or Decks) or ends in Commander */
export function deckProduct(product) {
  if (!wizards(product)) return false;
  const title = low(product.title);
  return title.includes('commander deck') || title.endsWith('commander');
}

/** An option that's a Commander deck on its own: its product isn't one as a whole, and the option's title says Commander Deck */
export function deckOption(variant) {
  if (!variant || !wizards(variant.product) || deckProduct(variant.product)) return false;
  return low(variant.title).includes('commander deck');
}

/**
 * What a deal is missing, of the decks Shopify's search found: never one already in it, an option whose whole product
 * is in it, or one taken out by hand (gone). deal: { products: Set, variants: Set } of ids. Returns
 * { products: [{ id, title }], variants: [{ id, product, option }] } (option: its own title, product: its product's).
 */
export function dealMissing(deal, found, gone = new Set()) {
  const products = [];
  const variants = [];
  const taken = new Set();
  for (const p of found.products || []) {
    if (!deckProduct(p) || deal.products.has(p.id) || gone.has(p.id) || taken.has(p.id)) continue;
    taken.add(p.id);
    products.push({ id: p.id, title: p.title });
  }
  for (const v of found.variants || []) {
    if (!deckOption(v) || deal.variants.has(v.id) || deal.products.has(v.product.id) || gone.has(v.id) || taken.has(v.id)) continue;
    taken.add(v.id);
    variants.push({ id: v.id, product: v.product.title, option: v.title });
  }
  return { products, variants };
}

const metaValue = (lair, key) => lair.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray()[0]?.value ?? null;
const setMeta = (lair, key, value) => lair.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, String(value));
const detailsOf = (missing) => [...missing.products.map((p) => [p.title, W.everyOption]), ...missing.variants.map((v) => [v.product, v.option])];

export const commanderDealMethods = {
  /**
   * Every hour (force: now), while the theme says Commander decks come with free sleeves: each deal with the theme's
   * title gets the decks it's missing. budget: what's left of this invocation's outside calls (src/shop-filters.js
   * callBudget). Returns { deals, added, problem? }, or null when it didn't look. Shopify failing throws, for the
   * 10-minute run to log; the hour is claimed first, so it looks again in an hour, not every 10 minutes.
   */
  async commanderDealUpkeep(rules, now = Date.now(), { force = false, budget = null } = {}) {
    const sleeves = rules?.sleeves;
    if (!sleeves?.on || !this.shopify.configured) return null;
    if (!force && now - (Number(metaValue(this, 'commander-deal-at')) || 0) < COMMANDER_DEAL.everyMs) return null;
    if (budget && !budget.has(COMMANDER_DEAL.calls)) return null;
    setMeta(this, 'commander-deal-at', now);
    const title = sleeves.title;
    const found = await this.shopify.commanderDealSearch();
    const deals = (found.deals || []).filter((d) => String(d.title ?? '').trim() === title).slice(0, COMMANDER_DEAL.deals);
    const problems = [];
    let looked = 0;
    let added = 0;
    for (const { id } of deals) {
      const deal = await this.shopify.freeSleevesDeal(id);
      if (!deal) continue;
      looked += 1;
      // buy anything: every deck counts already
      if (deal.kind === 'all') continue;
      if (deal.kind !== 'products') {
        problems.push({ state: 'collections' });
        continue;
      }
      if (deal.more) {
        problems.push({ state: 'too-many' });
        continue;
      }
      const gone = this.commanderDealSeen(id, deal, now);
      const missing = dealMissing({ products: new Set(deal.products), variants: new Set(deal.variants) }, found, gone);
      if (!missing.products.length && !missing.variants.length) continue;
      try {
        await this.shopify.addToFreeSleevesDeal(id, { products: missing.products.map((p) => p.id), variants: missing.variants.map((v) => v.id), value: deal.value });
      } catch (error) {
        if (!error?.refused) throw error;
        problems.push({ state: 'refused', said: error.said || String(error.message || error), missing });
        continue;
      }
      // seen now, so one taken out by hand before the next look stays out
      for (const p of missing.products) this.commanderDealMark(id, p.id, p.title, now, true);
      for (const v of missing.variants) this.commanderDealMark(id, v.id, `${v.product}: ${v.option}`, now, true);
      added += missing.products.length + missing.variants.length;
      this.notifyStaff(W.addedSubject, { title: W.addedTitle, intro: W.addedIntro(missing.products.length + missing.variants.length, title), details: detailsOf(missing), outro: W.addedOutro(title) });
    }
    if (!looked) problems.unshift({ state: 'missing' });
    this.commanderDealState(problems[0] || { state: 'ok' }, title);
    return { deals: looked, added, ...(problems.length ? { problem: problems[0].state } : {}) };
  },

  /** Marks what's in a deal now as seen; returns what was seen in it before and is missing now (taken out by hand) */
  commanderDealSeen(discountId, deal, now) {
    const present = new Set([...deal.products, ...deal.variants]);
    const before = this.sql.exec('SELECT item_id FROM commander_deal_items WHERE discount_id = ?', discountId).toArray().map((r) => r.item_id);
    for (const id of present) this.commanderDealMark(discountId, id, null, now, false);
    return new Set(before.filter((id) => !present.has(id)));
  },

  commanderDealMark(discountId, itemId, title, now, added) {
    this.sql.exec(
      `INSERT INTO commander_deal_items (discount_id, item_id, title, seen_at, added_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(discount_id, item_id) DO UPDATE SET seen_at = excluded.seen_at, title = COALESCE(excluded.title, title),
          added_at = COALESCE(excluded.added_at, added_at)`,
      discountId, itemId, title, now, added ? now : null,
    );
  },

  /** Staff hear once when the deal can't be kept, and again only after it's worked in between */
  commanderDealState(problem, title) {
    const was = metaValue(this, 'commander-deal-state');
    if (was === problem.state) return;
    setMeta(this, 'commander-deal-state', problem.state);
    if (problem.state === 'missing') this.notifyStaff(W.missingSubject, { title: W.missingTitle, intro: W.missingIntro(title), outro: W.missingOutro });
    else if (problem.state === 'collections') this.notifyStaff(W.collectionSubject, { title: W.collectionTitle, intro: W.collectionIntro(title), outro: W.collectionOutro });
    else if (problem.state === 'too-many') this.notifyStaff(W.longSubject, { title: W.longTitle, intro: W.longIntro(title), outro: W.longOutro });
    else if (problem.state === 'refused') {
      this.notifyStaff(W.refusedSubject, { title: W.refusedTitle, intro: W.refusedIntro(title, problem.said), details: detailsOf(problem.missing), outro: W.refusedOutro });
    }
  },
};

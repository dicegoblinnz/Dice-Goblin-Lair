// Round 34, discounts on the till (contract docs/contracts/lair-api-contract-v34-till-discounts.md).
//
// Mo (10 Nov 2026): "for the till have an option to apply discounts but once applied the staff needs to 'log in' and
// that goes through make sure no item can go below 25% discount". With his 6 Nov decision that discounts are for the
// Money role. So:
//  - A discount is a percent off one of the shop's products in the basket (`discount` on its line), up to 25%. Bookings,
//    sign-ups and tabs keep their price: they have their own ways (passes, waiving, the tab's prices).
//  - The till shows what it comes to (POST /till/price) straight away, but Pay won't take it until someone with Money,
//    or the owner, has just put their PIN in for it (`discountOk`: the till token that PIN gave, from an unlock in the
//    last 10 minutes), even when they're the one on the till. One approval is one sale: a sale that's let go (Back,
//    Shopify failing) can use it again on the same till, a sale that's paid can't.
//  - The 25% is checked twice: the percent asked for, and what Shopify actually took off each line. A line on a deal
//    already (the dice deal) can't have a discount too, so no item ever sells for less than 75% of its price because of
//    a discount.
//  - Each discounted line says "Staff discount" in Shopify, with who approved it; the order is tagged staff-discount and
//    its note says who, so Mo can see them all in Shopify (Orders, filter by the tag).
//
// Round 35, in dollars (contract docs/contracts/lair-api-contract-v35-till-discounts.md). Mo (10 Nov 2026): "for the
// discount make it go off actual dollar value not % thanks no need to say no more than 25% but do not accept anything
// lower than 25% unless it is done on the item previously thanks. Actually make it 20%"; asked when something may sell
// for more than 20% off, he picked "Already on sale". So, in place of the percent and the 25% above:
//  - A discount is dollars off each one of a product (`off` on its line, in cents), as Shopify's own fixed amount on a
//    draft's line is: 2 of a $50 game with $5 off is $10 off.
//  - No item sells for less than 80% of its full price because of a discount. Its full price is Shopify's compare-at
//    price when it's on sale, else its price: so something on sale comes down only as far as 80% of what it was, and
//    something already there or under can't have a discount (it's under 80% only because Shopify already has it there).
//    A line on a deal still can't have one too.
//  - It's checked on Shopify's own figures, for the price and again on the draft at Pay: the price and compare-at price
//    Shopify has for the item as it works the sale out, and what it took off the line. Shopify takes a fixed amount of
//    more than the price as the whole price and says nothing, so what was asked is checked, and that what came off is
//    what was asked. A discounted line the figures don't have is refused.
//  - Nothing says the limit until it's passed: a refusal names the most that item can come down by, in dollars.
//  - The percent is still read (`discount`), from a till that hasn't reloaded since: at most 20 now, and held to the same
//    80%. It goes in a later round.
import { RuleError } from './core.js';

/** The most a discount takes off an item, as a percent of its full price (round 35: 20, was 25) */
export const TILL_DISCOUNT_MAX = 20;
/** The most `off` is read as, in cents: $10,000 off each is a typo, not a discount */
export const TILL_OFF_MOST = 1_000_000;
/** An approval is a PIN put in this recently */
export const TILL_DISCOUNT_FRESH_MS = 10 * 60_000;
/** The tag on a discounted sale's order */
export const TILL_DISCOUNT_TAG = 'staff-discount';
/** The title on a discounted line in Shopify (and on the till's total) */
export const TILL_DISCOUNT_TITLE = 'Staff discount';
/** The till_sales columns for discounts (added when missing, in lair.js's migrate) */
export const TILL_DISCOUNT_COLUMNS = [['till_sales', 'discount_by', 'TEXT'], ['till_sales', 'discount_by_name', 'TEXT'], ['till_sales', 'discount_ok', 'TEXT'], ['till_sales', 'discount_total', 'INTEGER']];

const dollars = (cents) => `$${(Math.round(Number(cents) || 0) / 100).toFixed(2)}`;

/** Every message about discounts, word for word in the contracts (v34, and v35 for dollars) */
export const TILL_DISCOUNT_WORDS = {
  amount: 'A discount is dollars and cents off each item.',
  over: `A discount can be up to ${TILL_DISCOUNT_MAX}% off each item.`,
  notProduct: 'Discounts are for things from the shop. Bookings and tabs keep their price.',
  needOk: 'A discount needs a PIN from someone with Money, or the owner, before it goes through.',
  notMoney: (name) => `${name} can't approve discounts. That's for staff with Money, or the owner.`,
  stale: 'That approval has run out. Put a PIN in again to approve the discount.',
  used: 'That approval was for another sale. Put a PIN in again to approve this one.',
  stacked: (title) => `${title} is on a deal already, so it can't have a discount too. Take the discount off it.`,
  // round 35: the most an item can come down by (each, when there are 2 or more of it), never the percent
  most: (title, cents, qty = 1) => `${title} can come down by ${dollars(cents)}${qty > 1 ? ' each' : ''} at most. Change the discount, or take it off.`,
  onSale: (title) => `${title} is on sale already, so it can't have a discount too. Take the discount off it.`,
  none: (title) => `${title} can't have a discount. Take the discount off it.`,
  wrong: (title) => `${title}'s discount didn't come out as asked. Take it off and add it again.`,
};

/**
 * A line's percent off as a till that hasn't reloaded since round 35 sends it: null for none, else the percent (more
 * than 0, up to 20, at most 2 decimal places), or a 400. No awaits.
 */
export function tillDiscountIn(value) {
  if (value == null || value === '' || value === 0 || value === '0') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || Math.abs(Math.round(n * 100) - n * 100) > 1e-6) throw new RuleError(TILL_DISCOUNT_WORDS.over, 400);
  if (n === 0) return null;
  if (n > TILL_DISCOUNT_MAX) throw new RuleError(TILL_DISCOUNT_WORDS.over, 400);
  return Math.round(n * 100) / 100;
}

/**
 * Round 35: a line's dollars off each one as sent (`off`): null for none, else whole cents from 1 to TILL_OFF_MOST (a
 * number, or its digits as text: never dollars as text, "5.00" isn't 5 cents), or a 400. How much an item can come down
 * by is checked once Shopify has said its price (tillDiscountCheck). No awaits.
 */
export function tillOffIn(value) {
  if (value == null || value === '' || value === 0 || value === '0') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,7}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > TILL_OFF_MOST) throw new RuleError(TILL_DISCOUNT_WORDS.amount, 400);
  return n;
}

/**
 * Round 35: the most a discount can take off each one of an item, in cents: as far as 80% of its full price (rounded up
 * to the cent, so never under it) and no further. unit: its price now; was: Shopify's compare-at price, its full price
 * when that's above the price (it's on sale). 0 when it's at or under 80% of what it was already, or 20% of it isn't a
 * cent. No awaits.
 */
export function tillDiscountMost(unit, was = null) {
  const price = Math.max(0, Math.round(Number(unit) || 0));
  const full = Math.max(price, Math.round(Number(was) || 0));
  const least = full - Math.floor((full * TILL_DISCOUNT_MAX) / 100);
  return Math.max(0, price - least);
}

/**
 * What Shopify took off the basket's discounted lines, checked on its own figures (round 35): the item can have a
 * discount at all (not on sale past 80% of what it was); dollars off are no more than it can come down by, and what
 * Shopify took off for them is what was asked (a cent either way); a percent comes to no more than it can come down by
 * (Shopify rounds the line, so a cent each either way); and nothing else came off the line (a deal). A discounted line
 * the figures don't have is refused too. Throws a 422 naming the line otherwise, with more.line: its key and Shopify's
 * figures for it ({ key, unit, most, was?, deal? }: most 0 and deal true when it's a deal that's in the way), which the
 * Lair's answer carries beside the words.
 * → { total, byKey: Map(key → cents) }. lines: the sale's lines (with key, uuid, off or discount); figures: tillFiguresOf's.
 * No awaits.
 */
export function tillDiscountCheck(lines, figures) {
  const byUuid = new Map((figures?.lines || []).filter((l) => l.uuid).map((l) => [l.uuid, l]));
  const samePlaces = (figures?.lines || []).length === lines.length;
  const byKey = new Map();
  let total = 0;
  lines.forEach((l, i) => {
    if (!l.discount && !l.off) return;
    const f = (l.uuid && byUuid.get(l.uuid)) || (samePlaces ? figures.lines[i] : null);
    if (!f) throw new RuleError(TILL_DISCOUNT_WORDS.wrong(l.title || 'That item'), 422);
    const name = [f.title, f.variantTitle].filter(Boolean).join(' · ') || 'That item';
    const qty = Math.max(1, Number(f.qty) || 1);
    const most = tillDiscountMost(f.unit, f.was);
    const off = Math.max(0, (f.total || 0) - (f.paid ?? f.total ?? 0));
    const staff = f.staff ?? off;
    // a refusal says which line, with Shopify's figures for it now, so the till can offer what it can take (nothing,
    // on a line a deal took something off)
    const no = (words, facts = {}) => Object.assign(new RuleError(words, 422), { more: { line: { key: l.key, unit: f.unit || 0, most, ...(f.was ? { was: f.was } : {}), ...facts } } });
    if (most <= 0) throw no((f.was || 0) > (f.unit || 0) ? TILL_DISCOUNT_WORDS.onSale(name) : TILL_DISCOUNT_WORDS.none(name));
    if (l.off) {
      if (l.off > most) throw no(TILL_DISCOUNT_WORDS.most(name, most, qty));
      if (Math.abs(staff - l.off * qty) > 1) throw no(TILL_DISCOUNT_WORDS.wrong(name));
    } else if (staff > (most + 1) * qty) {
      throw no(TILL_DISCOUNT_WORDS.most(name, most, qty));
    }
    if (off > staff + 1) throw no(TILL_DISCOUNT_WORDS.stacked(name), { most: 0, deal: true });
    byKey.set(l.key, staff);
    total += staff;
  });
  return { total, byKey };
}

/**
 * The figures' discounts with the staff discount among them: Shopify lists the shop's own discounts (the dice deal);
 * the staff discount is added once when it's taken something off and isn't listed already. No awaits.
 */
export function tillDiscountsShown(discounts, staffTotal) {
  const list = (discounts || []).filter((d) => d.title !== TILL_DISCOUNT_TITLE);
  return staffTotal > 0 ? [...list, { title: TILL_DISCOUNT_TITLE, amount: staffTotal }] : list;
}

/** Who can approve a discount: the owner, or anyone on the till with Money */
export function tillApprovesDiscounts(person) {
  return Boolean(person) && (person.role === 'owner' || (person.perms || []).includes('money'));
}

export const tillDiscountMethods = {
  /**
   * The person a discount approval is from: discountOk is the till token from a PIN put in within the last 10 minutes,
   * by the owner or someone with Money, and not already used for a sale that's paid or still open on another till.
   * → the person ({ id, name, ... }) and the token's hash, or throws. No awaits (tokenHash and team read already).
   */
  tillDiscountApprover(tokenHash, team, till, now = Date.now()) {
    if (!tokenHash) throw new RuleError(TILL_DISCOUNT_WORDS.needOk, 403);
    const session = this.sql.exec('SELECT * FROM till_sessions WHERE token_hash = ?', tokenHash).toArray()[0];
    if (!session || session.created_at < now - TILL_DISCOUNT_FRESH_MS) throw new RuleError(TILL_DISCOUNT_WORDS.stale, 401);
    const person = this.tillOn(tokenHash, team, { now });
    if (!tillApprovesDiscounts(person)) throw new RuleError(TILL_DISCOUNT_WORDS.notMoney(person.name), 403);
    const usedElsewhere = this.sql
      .exec("SELECT 1 AS n FROM till_sales WHERE discount_ok = ? AND (status = 'paid' OR (status IN ('making', 'open') AND till != ?)) LIMIT 1", tokenHash, till)
      .toArray().length;
    if (usedElsewhere) throw new RuleError(TILL_DISCOUNT_WORDS.used, 409);
    return { person, tokenHash };
  },
};

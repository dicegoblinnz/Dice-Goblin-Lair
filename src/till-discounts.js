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
import { RuleError } from './core.js';

/** The most a discount takes off an item, in percent */
export const TILL_DISCOUNT_MAX = 25;
/** An approval is a PIN put in this recently */
export const TILL_DISCOUNT_FRESH_MS = 10 * 60_000;
/** The tag on a discounted sale's order */
export const TILL_DISCOUNT_TAG = 'staff-discount';
/** The title on a discounted line in Shopify (and on the till's total) */
export const TILL_DISCOUNT_TITLE = 'Staff discount';
/** The till_sales columns for discounts (added when missing, in lair.js's migrate) */
export const TILL_DISCOUNT_COLUMNS = [['till_sales', 'discount_by', 'TEXT'], ['till_sales', 'discount_by_name', 'TEXT'], ['till_sales', 'discount_ok', 'TEXT'], ['till_sales', 'discount_total', 'INTEGER']];

/** Every message about discounts, word for word in the contract */
export const TILL_DISCOUNT_WORDS = {
  over: `A discount can be up to ${TILL_DISCOUNT_MAX}% off each item.`,
  notProduct: 'Discounts are for things from the shop. Bookings and tabs keep their price.',
  needOk: 'A discount needs a PIN from someone with Money, or the owner, before it goes through.',
  notMoney: (name) => `${name} can't approve discounts. That's for staff with Money, or the owner.`,
  stale: 'That approval has run out. Put a PIN in again to approve the discount.',
  used: 'That approval was for another sale. Put a PIN in again to approve this one.',
  stacked: (title) => `${title} is on a deal already, so it can't have a discount too. Take the discount off it.`,
  capped: (title) => `${title} came to more than ${TILL_DISCOUNT_MAX}% off. Take the discount off and add it again.`,
};

/**
 * A line's discount as sent: null for none, else the percent off (more than 0, up to 25, at most 2 decimal places), or a
 * 400. No awaits.
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
 * What Shopify took off the basket's discounted lines, checked: each discounted line's own discount is at most 25% of
 * its price (a cent over for rounding), and nothing else came off it (a deal). Throws a 422 naming the line otherwise.
 * → { total, byKey: Map(key → cents) }. lines: the sale's lines (with key, uuid, discount); figures: tillFiguresOf's.
 * No awaits.
 */
export function tillDiscountCheck(lines, figures) {
  const byUuid = new Map((figures?.lines || []).filter((l) => l.uuid).map((l) => [l.uuid, l]));
  const samePlaces = (figures?.lines || []).length === lines.length;
  const byKey = new Map();
  let total = 0;
  lines.forEach((l, i) => {
    if (!l.discount) return;
    const f = (l.uuid && byUuid.get(l.uuid)) || (samePlaces ? figures.lines[i] : null);
    if (!f) return;
    const name = [f.title, f.variantTitle].filter(Boolean).join(' · ') || 'That item';
    const off = Math.max(0, (f.total || 0) - (f.paid ?? f.total ?? 0));
    const staff = f.staff ?? off;
    if (staff > Math.round(((f.total || 0) * TILL_DISCOUNT_MAX) / 100) + 1) throw new RuleError(TILL_DISCOUNT_WORDS.capped(name), 422);
    if (off > staff + 1) throw new RuleError(TILL_DISCOUNT_WORDS.stacked(name), 422);
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

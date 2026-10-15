/**
 * Round 16: the wishlist (contract v16-wishlist). Mo (16 Oct 2026): "Add to wishlist should be done later for now just
 * build the infrastructure." So this is its storage and three routes, and nothing else: no emails, and nothing in the
 * theme shows it yet (the Add to wishlist button stays switched off until Mo says).
 *
 * One row in `wishlist` per member per Shopify product (customer_id and product_id, its primary key: the table is made
 * in lair.js, ROUND16_WISHLIST), with the handle and title the page sent and when it was added. Members only: a guest
 * gets the 401 every /me route gives, a member sees and changes only their own list, and staff have no view of anyone
 * else's. These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the
 * Lair. None of them waits on anything (no Shopify, no rules), so each is one synchronous read-check-write.
 */
import { RuleError } from './core.js';

/** The most products one member's wishlist holds. Adding one that's already on it is never refused for this. */
export const WISHLIST_MAX = 100;
/** The longest handle and title kept, in characters */
export const WISHLIST_TEXT_MAX = 255;
/** Every message a customer can see, word for word in the contract */
export const WISHLIST_MESSAGES = {
  login: 'Log in to keep a wishlist.',
  product: "That doesn't look like one of our products. Refresh the page and try again.",
  handle: "That product's link doesn't look right. Refresh the page and try again.",
  title: `That product's title doesn't look right. Keep it to ${WISHLIST_TEXT_MAX} characters.`,
  full: `Your wishlist is full (${WISHLIST_MAX} games). Take one off to add another.`,
};

/**
 * A Shopify product's number as the wishlist keeps it, 1 to 20 digits: 8123456789012 (a whole number),
 * "8123456789012" or "gid://shopify/Product/8123456789012" all give "8123456789012". null for anything else: another
 * kind of Shopify ID (a variant's), a number with a fraction, below zero or too big to be exact, or no digits at all.
 */
export const wishlistProductId = (value) => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value !== 'string') return null;
  return value.trim().match(/^(?:gid:\/\/shopify\/Product\/)?(\d{1,20})$/)?.[1] ?? null;
};

/** handle: left out, null or empty is none (null); otherwise lowercase letters, digits and hyphens, 255 at most (or 422) */
const wishlistHandle = (value) => {
  if (value === undefined || value === null) return null;
  const handle = typeof value === 'string' ? value.trim() : null;
  if (handle === '') return null;
  if (handle === null || handle.length > WISHLIST_TEXT_MAX || !/^[a-z0-9-]+$/.test(handle)) throw new RuleError(WISHLIST_MESSAGES.handle);
  return handle;
};

/**
 * title: left out, null or empty is none (null); otherwise text, trimmed, each run of white space (spaces, tabs, new
 * lines) one space, then 255 characters at most (or 422). Characters, not UTF-16 units, so an emoji counts as one (a
 * title over twice the limit can't be short enough, so it isn't split up to count).
 */
const wishlistTitle = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new RuleError(WISHLIST_MESSAGES.title);
  const title = value.replace(/\s+/g, ' ').trim();
  if (title.length > WISHLIST_TEXT_MAX && (title.length > 2 * WISHLIST_TEXT_MAX || [...title].length > WISHLIST_TEXT_MAX)) {
    throw new RuleError(WISHLIST_MESSAGES.title);
  }
  return title || null;
};

export const wishlistMethods = {
  /** GET /me/wishlist (logged in): { items }, newest first (wishlistItems). No awaits. */
  memberWishlist(who) {
    return { items: this.wishlistItems(this.wishlistOwner(who)) };
  },

  /**
   * POST /me/wishlist { productId, handle?, title? } (logged in): add a product. One already on it keeps its place and
   * when it was added, and takes the handle and title when they're sent (left out or empty, the kept ones stay); it's
   * never refused for a full list. A new one when there are WISHLIST_MAX already is a 409. → { ok, added, items }, added
   * false when it was on it already. No awaits: one read-check-write.
   */
  addToWishlist(input, who) {
    const owner = this.wishlistOwner(who);
    const productId = this.wishlistProduct(input);
    const handle = wishlistHandle(input?.handle);
    const title = wishlistTitle(input?.title);
    if (this.onWishlist(owner, productId)) {
      if (handle !== null || title !== null) {
        this.write(
          'UPDATE wishlist SET handle = COALESCE(?, handle), title = COALESCE(?, title) WHERE customer_id = ? AND product_id = ?',
          handle, title, owner, productId,
        );
      }
      return { ok: true, added: false, items: this.wishlistItems(owner) };
    }
    const count = this.sql.exec('SELECT COUNT(*) AS n FROM wishlist WHERE customer_id = ?', owner).one().n;
    if (count >= WISHLIST_MAX) throw new RuleError(WISHLIST_MESSAGES.full, 409);
    this.write('INSERT INTO wishlist (customer_id, product_id, handle, title, created_at) VALUES (?, ?, ?, ?, ?)', owner, productId, handle, title, Date.now());
    return { ok: true, added: true, items: this.wishlistItems(owner) };
  },

  /**
   * POST /me/wishlist/remove { productId } (logged in): take a product off. One that isn't on it is fine (removed:
   * false), never an error. → { ok, removed, items }. No awaits: one read-check-write.
   */
  removeFromWishlist(input, who) {
    const owner = this.wishlistOwner(who);
    const productId = this.wishlistProduct(input);
    const removed = this.onWishlist(owner, productId);
    if (removed) this.write('DELETE FROM wishlist WHERE customer_id = ? AND product_id = ?', owner, productId);
    return { ok: true, removed, items: this.wishlistItems(owner) };
  },

  /**
   * Whose wishlist it is: the logged-in member's customer ID, as every member table keeps it. A guest gets 401, as on
   * every /me route. Staff are members like anyone here: they only ever reach their own. No awaits.
   */
  wishlistOwner(who) {
    if (!who?.customerId) throw new RuleError(WISHLIST_MESSAGES.login, 401);
    return String(who.customerId);
  },

  /** The productId sent, as its digits (wishlistProductId), or 422. No awaits. */
  wishlistProduct(input) {
    const productId = wishlistProductId(input?.productId);
    if (!productId) throw new RuleError(WISHLIST_MESSAGES.product);
    return productId;
  },

  /** Whether that product is on that member's wishlist. No awaits. */
  onWishlist(customerId, productId) {
    return this.sql.exec('SELECT 1 AS here FROM wishlist WHERE customer_id = ? AND product_id = ?', customerId, productId).toArray().length > 0;
  },

  /**
   * A member's wishlist, newest first (two added in the same millisecond: the later one first), on its index
   * (wishlist_customer): [{ productId, handle, title, addedAt }]. productId is the product's digits as a string; handle
   * and title are '' when the page never sent them; addedAt is when it was first added (ms). No awaits.
   */
  wishlistItems(customerId) {
    return this.sql
      .exec('SELECT product_id, handle, title, created_at FROM wishlist WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC', customerId)
      .toArray()
      .map((r) => ({ productId: r.product_id, handle: r.handle || '', title: r.title || '', addedAt: r.created_at }));
  },
};

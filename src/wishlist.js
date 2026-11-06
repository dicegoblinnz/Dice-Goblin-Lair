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
 *
 * Round 31 (retail, contract v31-retail section 1): it keeps the exact option ("It remembers the sleeve colour or the paint
 * they wanted"), so one member can have several options of one product (variant_id; '' is any option, every row from
 * before), each item says what the Lair's last stock check found (src/wish-alerts.js keeps wish_stock), and My Lair's
 * "Email me when these come back" is a member's switch (wish_prefs). The table is rebuilt with the new key once, on start
 * (retailWishlistTable, called from lair.js's migrate).
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
  // Round 31
  variant: "That option doesn't look right. Refresh the page and try again.",
  alerts: 'Say whether to email you: on or off.',
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

/**
 * Round 31: a Shopify variant's number as the wishlist keeps it, like wishlistProductId: 8123456789012,
 * "8123456789012" or "gid://shopify/ProductVariant/8123456789012" all give "8123456789012". null for anything else.
 */
export const wishlistVariantId = (value) => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value !== 'string') return null;
  return value.trim().match(/^(?:gid:\/\/shopify\/ProductVariant\/)?(\d{1,20})$/)?.[1] ?? null;
};

/**
 * Round 31: the wishlist's table with the option in its key, and the rows from before kept as "any option" ('').
 * Made once: when wishlist has no variant_id yet (round 16's table, which lair.js still makes on a fresh start), its
 * rows move to the new table in one go. Also each member's switch for the emails (wish_prefs). No awaits.
 */
export const WISHLIST_V31 = [
  `CREATE TABLE IF NOT EXISTS wishlist_v31 (
    customer_id TEXT NOT NULL, product_id TEXT NOT NULL, variant_id TEXT NOT NULL DEFAULT '', handle TEXT, title TEXT,
    variant_title TEXT, created_at INTEGER NOT NULL, told_at INTEGER, asked_at INTEGER, PRIMARY KEY (customer_id, product_id, variant_id))`,
  `INSERT OR IGNORE INTO wishlist_v31 (customer_id, product_id, variant_id, handle, title, created_at)
    SELECT customer_id, product_id, '', handle, title, created_at FROM wishlist`,
  'DROP TABLE wishlist',
  'ALTER TABLE wishlist_v31 RENAME TO wishlist',
];
export const WISHLIST_V31_INDEXES = [
  'CREATE INDEX IF NOT EXISTS wishlist_customer ON wishlist (customer_id, created_at)',
  'CREATE INDEX IF NOT EXISTS wishlist_product ON wishlist (product_id)',
  'CREATE TABLE IF NOT EXISTS wish_prefs (customer_id TEXT PRIMARY KEY, alerts_off INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)',
];

/** variantTitle: as a title, and Shopify's "Default Title" (a product with one option) is none */
const wishlistVariantTitle = (value) => {
  const title = wishlistTitle(value);
  return title && title !== 'Default Title' ? title : null;
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
  /** GET /me/wishlist (logged in): { items, alerts: { on } }, newest first (wishlistItems). No awaits. */
  memberWishlist(who) {
    const owner = this.wishlistOwner(who);
    return { items: this.wishlistItems(owner), alerts: this.wishlistAlerts(owner) };
  },

  /**
   * POST /me/wishlist { productId, variantId?, handle?, title?, variantTitle? } (logged in): add a product, or one option
   * of it (round 31; left out or null is any option). One already on it keeps its place and when it was added, and takes
   * the handle and titles when they're sent (left out or empty, the kept ones stay); it's never refused for a full list.
   * A new one when there are WISHLIST_MAX already is a 409. → { ok, added, items, alerts }, added false when it was on
   * it already. No awaits: one read-check-write.
   * Round 31, from the review: `tell: true` is Tell me when it's back, a request for that option's email (asked_at, now),
   * which is sent even while "Email me when these come back" is off, and after an unsubscribe that came before it.
   */
  addToWishlist(input, who) {
    const owner = this.wishlistOwner(who);
    const productId = this.wishlistProduct(input);
    const variantId = this.wishlistVariant(input);
    const handle = wishlistHandle(input?.handle);
    const title = wishlistTitle(input?.title);
    const variantTitle = variantId ? wishlistVariantTitle(input?.variantTitle) : null;
    const asked = input?.tell === true ? Date.now() : null;
    if (this.onWishlist(owner, productId, variantId)) {
      if (handle !== null || title !== null || variantTitle !== null || asked !== null) {
        this.write(
          'UPDATE wishlist SET handle = COALESCE(?, handle), title = COALESCE(?, title), variant_title = COALESCE(?, variant_title), asked_at = COALESCE(?, asked_at) WHERE customer_id = ? AND product_id = ? AND variant_id = ?',
          handle, title, variantTitle, asked, owner, productId, variantId,
        );
      }
      return { ok: true, added: false, items: this.wishlistItems(owner), alerts: this.wishlistAlerts(owner) };
    }
    const count = this.sql.exec('SELECT COUNT(*) AS n FROM wishlist WHERE customer_id = ?', owner).one().n;
    if (count >= WISHLIST_MAX) throw new RuleError(WISHLIST_MESSAGES.full, 409);
    this.write(
      'INSERT INTO wishlist (customer_id, product_id, variant_id, handle, title, variant_title, created_at, asked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      owner, productId, variantId, handle, title, variantTitle, Date.now(), asked,
    );
    return { ok: true, added: true, items: this.wishlistItems(owner), alerts: this.wishlistAlerts(owner) };
  },

  /**
   * POST /me/wishlist/remove { productId, variantId? } (logged in): take one off: with variantId that option (or, null,
   * the any-option entry), without it every entry for the product (round 31). One that isn't on it is fine (removed:
   * false), never an error. → { ok, removed, items, alerts }. No awaits: one read-check-write.
   */
  removeFromWishlist(input, who) {
    const owner = this.wishlistOwner(who);
    const productId = this.wishlistProduct(input);
    const one = input && Object.prototype.hasOwnProperty.call(input, 'variantId');
    const variantId = one ? this.wishlistVariant(input) : null;
    const removed = one ? this.onWishlist(owner, productId, variantId) : this.onWishlist(owner, productId);
    if (removed && one) this.write('DELETE FROM wishlist WHERE customer_id = ? AND product_id = ? AND variant_id = ?', owner, productId, variantId);
    else if (removed) this.write('DELETE FROM wishlist WHERE customer_id = ? AND product_id = ?', owner, productId);
    return { ok: true, removed, items: this.wishlistItems(owner), alerts: this.wishlistAlerts(owner) };
  },

  /**
   * Round 31: POST /me/wishlist/alerts { on } (logged in): My Lair's "Email me when these come back". On until they say.
   * → { ok, alerts: { on } }. No awaits.
   */
  setWishlistAlerts(input, who) {
    const owner = this.wishlistOwner(who);
    if (typeof input?.on !== 'boolean') throw new RuleError(WISHLIST_MESSAGES.alerts);
    this.write(
      'INSERT INTO wish_prefs (customer_id, alerts_off, updated_at) VALUES (?, ?, ?) ON CONFLICT (customer_id) DO UPDATE SET alerts_off = excluded.alerts_off, updated_at = excluded.updated_at',
      owner, input.on ? 0 : 1, Date.now(),
    );
    return { ok: true, alerts: this.wishlistAlerts(owner) };
  },

  /** Round 31: { on }, whether a member's wishlist emails are on (they are until they switch them off). No awaits. */
  wishlistAlerts(customerId) {
    return { on: this.wishPrefs(customerId).on };
  },

  /** Round 31: the switch and when it was last set ({ on, at }; at 0 when never). No awaits. */
  wishPrefs(customerId) {
    const row = this.sql.exec('SELECT alerts_off, updated_at FROM wish_prefs WHERE customer_id = ?', String(customerId)).toArray()[0];
    return { on: !row?.alerts_off, at: Number(row?.updated_at) || 0 };
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

  /**
   * Round 31: the variantId sent, as its digits (wishlistVariantId): left out or null is any option (''), anything else
   * that isn't a variant's number is a 422. No awaits.
   */
  wishlistVariant(input) {
    const value = input?.variantId;
    if (value === undefined || value === null || value === '') return '';
    const variantId = wishlistVariantId(value);
    if (!variantId) throw new RuleError(WISHLIST_MESSAGES.variant);
    return variantId;
  },

  /**
   * Whether that product is on that member's wishlist: any entry for it, or (round 31) with variantId given, that one
   * ('' for the any-option entry). No awaits.
   */
  onWishlist(customerId, productId, variantId = null) {
    if (variantId === null) return this.sql.exec('SELECT 1 AS here FROM wishlist WHERE customer_id = ? AND product_id = ?', customerId, productId).toArray().length > 0;
    return this.sql.exec('SELECT 1 AS here FROM wishlist WHERE customer_id = ? AND product_id = ? AND variant_id = ?', customerId, productId, variantId).toArray().length > 0;
  },

  /**
   * A member's wishlist, newest first (two added in the same millisecond: the later one first), on its index
   * (wishlist_customer). Each: { productId, variantId (null for any option), handle, title, variantTitle, addedAt, image,
   * price, url, status, shelf, toldAt }: productId and variantId are digits as strings; handle, title and variantTitle
   * are '' when the page never sent them; addedAt is when it was first added (ms). Round 31: the rest is from the Lair's
   * last stock check (wishItemStock, src/wish-alerts.js), and toldAt is when they were last emailed it's back. No awaits.
   */
  wishlistItems(customerId) {
    return this.sql
      .exec('SELECT product_id, variant_id, handle, title, variant_title, created_at, told_at, asked_at FROM wishlist WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC', customerId)
      .toArray()
      .map((r) => ({
        productId: r.product_id, variantId: r.variant_id || null, handle: r.handle || '', title: r.title || '', variantTitle: r.variant_title || '',
        addedAt: r.created_at, ...this.wishItemStock(r), toldAt: r.told_at ?? null, asked: Boolean(r.asked_at),
      }));
  },
};

/**
 * Round 31, retail and shopping (contract v31-retail, section 5): free holds. Mo's picks of 6 Nov 2026 on the canvas
 * "Retail and shopping: mockups" (the hold sheet, My Lair's holds and the cases a hold can't happen: "as drawn"), and the
 * rules in the Decision log (1 Nov 2026): members only (logged in), up to 3 at a time, kept until closing time the next
 * day the shop is open; not on a trading card or Games Workshop release in its first 7 days on the site; staff switch
 * holds off for a product with its tag no-holds; after 2 holds that weren't collected, that member's holds pause until
 * staff switch them back on. While it's held it's off sale everywhere: a Shopify draft order for the member reserves
 * the stock until the hold ends (reserveInventoryUntil), and is deleted when it ends, is cancelled or is collected.
 *
 * Staff see each new hold on the staff page's To pull (with a chime) and by email; they Set it aside behind the counter,
 * or say it's Not on the shelf (the member hears, and the Lair's count goes to 0). It's collected when the counter adds
 * it to the sale (the counter tile), when a paid counter order has the member and that option on it, or when staff say.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 * Shopify is reached through this.shopHoldApi() (shopHoldCalls below), so the tests can stand in for it in one place.
 */
import { HOUR, LairTime, RuleError, addDays, openWindow } from './core.js';

const DAY = 24 * HOUR;
import { emailReady } from './shopify.js';

/** Holds a member can have at once, and the holds not collected that pause theirs */
export const SHOP_HOLD_MAX = 3;
export const SHOP_HOLD_MISSES = 2;
/** A trading card or Games Workshop product skips holds this long after it goes on the site */
export const SHOP_HOLD_RELEASE_WAIT = 7 * DAY;
/** The tag that switches holds off for a product (staff add it in Shopify) */
export const SHOP_HOLD_OFF_TAG = 'no-holds';

export const SHOP_HOLD_TABLES = [
  `CREATE TABLE IF NOT EXISTS shop_holds (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL, customer_name TEXT, email TEXT,
    product_id TEXT NOT NULL, variant_id TEXT NOT NULL, title TEXT, variant_title TEXT, handle TEXT, image TEXT, price INTEGER,
    quantity INTEGER NOT NULL DEFAULT 1, draft_order_id TEXT, status TEXT NOT NULL, made_at INTEGER NOT NULL, until INTEGER NOT NULL,
    set_at INTEGER, set_by TEXT, closed_at INTEGER, closed_how TEXT, closed_by TEXT, put_back INTEGER NOT NULL DEFAULT 0,
    release_due INTEGER NOT NULL DEFAULT 0)`,
  'CREATE INDEX IF NOT EXISTS shop_holds_customer ON shop_holds (customer_id, status)',
  "CREATE INDEX IF NOT EXISTS shop_holds_open ON shop_holds (until) WHERE status IN ('making', 'new', 'set')",
  'CREATE TABLE IF NOT EXISTS shop_hold_resets (customer_id TEXT PRIMARY KEY, at INTEGER NOT NULL, by TEXT)',
];

/** Statuses: making (Shopify asked), new (to set aside), set (behind the counter); then closed as collected, cancelled,
    ended (not collected in time), or missing (not on the shelf after all) */
const OPEN = "('making', 'new', 'set')";

/** Everything people read from here, word for word in the contract */
export const SHOP_HOLD_WORDS = {
  login: 'Log in to hold it.',
  off: "Free holds aren't on yet.",
  full: (n) => `You're holding ${n} things already. Collect one, or cancel one in My Lair, to hold this.`,
  paused: "Free holds are paused on your account, because 2 holds weren't collected. Ask at the counter and staff can switch them back on.",
  gone: "Someone grabbed the last one a moment ago. Gobgob can tell you when it's back.",
  release: (day) => `Free holds start ${day}. New card releases skip holds in their first week, so everyone gets a fair go.`,
  noHolds: "This one can't be held. You can still buy it online and collect it free.",
  notShelf: "It isn't on the shelf at the Lair, so it can't be held.",
  already: "You're holding this one already. It's in My Lair.",
  busy: 'Someone else is holding that one right now. Try again in a moment.',
  product: "That product doesn't look right. Refresh the page and try again.",
  shopify: "Shopify didn't answer, so nothing's held. Try again in a minute.",
  notFound: "That hold isn't one the Lair knows. Refresh the page.",
  notNew: 'That hold is already marked.',
  customer: 'Pick a member first.',
  // staff's email for each new one
  staffSubject: (what, who) => `Hold to set aside: ${what} (${who})`,
  staffTitle: 'A hold to set aside',
  staffIntro: (who, until) => `${who} is holding it free until ${until}, to pay at the counter. Set it aside behind the counter and tap Set aside on the staff page.`,
  // the member, when it isn't on the shelf after all
  missingSubject: "Sorry, your hold isn't on the shelf",
  missingTitle: "Sorry, it's not on the shelf",
  missingIntro: (what) => `We went to set aside ${what} for you, and it wasn't on the shelf. Our count was wrong, and that's on us.`,
  missingNothing: "Your hold's cancelled, so there's nothing to pay.",
  missingSignoff: 'Sorry again,\nGobgob, the Dice Goblin',
  countNotSet: (what) => `Shopify didn't take the new count. Set ${what} to 0 in Shopify yourself, so the website stops selling it.`,
};

const digitsOf = (value) => {
  const id = String(value ?? '').trim().split('/').pop();
  return /^\d{1,20}$/.test(id) ? id : null;
};
const gid = (kind, id) => `gid://shopify/${kind}/${id}`;
const cents = (amount) => {
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
/** "Ana P." from a member's name */
const shortOf = (first, last) => {
  const f = String(first || '').trim();
  const l = String(last || '').trim();
  if (!f && !l) return 'A member';
  return f ? `${f}${l ? ` ${l[0].toUpperCase()}.` : ''}` : `${l[0].toUpperCase()}.`;
};
const nameParts = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return [parts[0] || '', parts.length > 1 ? parts[parts.length - 1] : ''];
};
const label = (h) => `${h.title}${h.variant_title ? `: ${h.variant_title}` : ''}`;

/**
 * The Shopify calls holds make, on the Lair's ShopifyAdmin (src/shopify.js). Each throws when Shopify can't answer.
 */
export const shopHoldCalls = (shopify) => ({
  /**
   * One option as a hold needs it: its product's selling state and kind, and the Lair's count of it → { variantId,
   * productId, title, variantTitle, handle, image, price, sold, giftCard, tags, productType, vendor, publishedAt,
   * supplier, tracked, shelf } or null when there's no such option.
   */
  async holdVariant(variantId, locationId) {
    const data = await shopify.graphql(
      `query HoldVariant($id: ID!, $location: ID!) { productVariant(id: $id) { id title price image { url }
        inventoryItem { tracked inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } } }
        product { id title handle status onlineStoreUrl publishedAt productType vendor tags isGiftCard featuredMedia { preview { image { url } } }
          supplier: metafield(namespace: "supplier", key: "code") { value } } } }`,
      { id: gid('ProductVariant', variantId), location: gid('Location', locationId) },
      { timeout: 20_000 },
    );
    const v = data.productVariant;
    if (!v?.product) return null;
    const p = v.product;
    const level = v.inventoryItem?.inventoryLevel?.quantities?.find((q) => q.name === 'available');
    return {
      variantId: digitsOf(v.id), productId: digitsOf(p.id), title: p.title || '', variantTitle: v.title && v.title !== 'Default Title' ? v.title : '',
      handle: p.handle || '', image: v.image?.url || p.featuredMedia?.preview?.image?.url || null, price: cents(v.price),
      sold: p.status === 'ACTIVE' && Boolean(p.onlineStoreUrl), giftCard: Boolean(p.isGiftCard), tags: p.tags || [], productType: p.productType || '',
      vendor: p.vendor || '', publishedAt: Date.parse(p.publishedAt || '') || null, supplier: Boolean(p.supplier?.value),
      tracked: v.inventoryItem?.tracked !== false, shelf: level ? Number(level.quantity) : 0,
    };
  },

  /** A member's name and email from Shopify, when the Lair hasn't met them yet → { first, last, email } or null */
  async holdCustomer(customerId) {
    const data = await shopify.graphql(
      'query HoldCustomer($id: ID!) { customer(id: $id) { id firstName lastName defaultEmailAddress { emailAddress } } }',
      { id: gid('Customer', customerId) },
      { timeout: 15_000 },
    );
    const c = data.customer;
    return c ? { first: c.firstName || '', last: c.lastName || '', email: c.defaultEmailAddress?.emailAddress || null } : null;
  },

  /** The member's draft order that sets the stock aside until `until` → its id. Throws when Shopify says no. */
  async holdDraft({ holdId, customerId, variantId, quantity, until }) {
    const data = await shopify.graphql(
      'mutation HoldDraft($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id } userErrors { field message } } }',
      {
        input: {
          purchasingEntity: { customerId: gid('Customer', customerId) },
          lineItems: [{ variantId: gid('ProductVariant', variantId), quantity }],
          reserveInventoryUntil: new Date(until).toISOString(),
          tags: ['lair-hold'],
          note: 'Free hold from the website: pay at the counter. The Lair app deletes this draft when the hold ends.',
          customAttributes: [{ key: '_lair_hold', value: String(holdId) }],
        },
      },
      { timeout: 20_000 },
    );
    const result = data.draftOrderCreate;
    if (!result?.draftOrder?.id || result.userErrors?.length) throw new Error((result?.userErrors || []).map((e) => e.message).join('; ') || 'no draft order came back');
    return result.draftOrder.id;
  },

  /** Lets the stock go: the draft order deleted, unless it's already gone or became an order */
  async holdRelease(draftOrderId) {
    if (!draftOrderId) return true;
    await shopify.deleteDraftIfOpen(draftOrderId);
    return true;
  },
});

export const shopHoldMethods = {
  /** The Shopify calls (shopHoldCalls), on this Lair's Shopify. Tests stand in for it by setting lair.shopHoldApi. */
  shopHoldApi() {
    return shopHoldCalls(this.shopify);
  },

  /** The member asking: their customer ID, or 401 */
  shopHoldOwner(who) {
    if (!who?.customerId) throw new RuleError(SHOP_HOLD_WORDS.login, 401);
    return String(who.customerId);
  },

  /** The options being held right now, one hold at a time each (this Lair's own, made the first time) */
  shopHoldLocks() {
    if (!this.shopHoldLockSet) this.shopHoldLockSet = new Set();
    return this.shopHoldLockSet;
  },

  /**
   * When a hold made at `ms` ends: closing time of the first opening that starts after it (made Friday evening, until
   * Saturday's close; made before Saturday's opening, until Saturday's close too). Looks 8 days ahead. No awaits.
   */
  shopHoldUntil(rules, ms) {
    const time = new LairTime(rules.tz);
    const key = time.key(ms);
    for (let i = 0; i <= 8; i += 1) {
      const w = openWindow(rules, time, addDays(key, i));
      if (w && w.open > ms) return w.close;
    }
    return ms + DAY;
  },

  /** "midnight Saturday 7 November" or "10pm Sunday 8 November", for emails. No awaits. */
  shopHoldUntilWords(rules, ms) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-NZ', { timeZone: rules.tz, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms - 1)).map((p) => [p.type, p.value]));
    // a close at midnight belongs to the evening it ends
    const time = new LairTime(rules.tz);
    const m = time.minutesOf(ms);
    const clock = m === 0 ? 'midnight' : `${Math.floor(m / 60) % 12 || 12}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}${m < 720 ? 'am' : 'pm'}`;
    return `${clock} ${parts.weekday} ${parts.day} ${parts.month}`;
  },

  /** A member's holds not collected since staff last switched theirs back on, and whether that pauses them. No awaits. */
  shopHoldMisses(customerId) {
    const reset = this.sql.exec('SELECT at FROM shop_hold_resets WHERE customer_id = ?', String(customerId)).toArray()[0];
    const n = this.sql.exec("SELECT COUNT(*) AS n FROM shop_holds WHERE customer_id = ? AND status = 'ended' AND closed_at > ?", String(customerId), reset?.at || 0).one().n;
    return { misses: n, paused: n >= SHOP_HOLD_MISSES };
  },

  /** One hold as its member sees it. No awaits. */
  shopHoldView(h) {
    return {
      id: h.id, productId: h.product_id, variantId: h.variant_id, title: h.title || '', variantTitle: h.variant_title || '', handle: h.handle || '',
      image: h.image || null, price: h.price, quantity: h.quantity, until: h.until, madeAt: h.made_at, set: h.status === 'set',
      url: h.handle ? `/products/${h.handle}?variant=${h.variant_id}` : null,
    };
  },

  /** GET /me/holds (logged in): { holds, max, paused }, open holds soonest first. No awaits. */
  memberShopHolds(who) {
    const owner = this.shopHoldOwner(who);
    return this.shopHoldsOf(owner);
  },

  shopHoldsOf(owner) {
    const rows = this.sql.exec(`SELECT * FROM shop_holds WHERE customer_id = ? AND status IN ('new', 'set') ORDER BY until, id`, owner).toArray();
    return { holds: rows.map((h) => this.shopHoldView(h)), max: SHOP_HOLD_MAX, paused: this.shopHoldMisses(owner).paused };
  },

  /**
   * POST /me/holds { productId, variantId } (logged in): hold it free. Free holds on (the live theme's setting), not
   * paused, fewer than SHOP_HOLD_MAX open, not this option already, and (asked of Shopify) sold online, not a gift card, not
   * tagged no-holds, not the supplier's, not a card or GW release in its first week, and on the shelf at the Lair. Then
   * the draft order that sets it aside, and the shop hears. (The supplier's dice only when the Lair has some on its shelf.)
   * → { ok: true, hold, holds, max, paused }, or { ok: false, cant, message, holds, max, paused, startsAt? } when it
   * can't be held (cant: off, full, paused, already, busy, product, noHolds, notShelf, release, gone). A placeholder row
   * (making) counts towards the limit while Shopify is asked; every await is between it and the final write.
   */
  async makeShopHold(input, who) {
    const owner = this.shopHoldOwner(who);
    const rules = await this.rules();
    // --- no awaits until the placeholder is written ---
    const productId = digitsOf(input?.productId);
    const variantId = digitsOf(input?.variantId);
    if (!productId || !variantId) throw new RuleError(SHOP_HOLD_WORDS.product);
    const cant = (why, message, extra = {}) => ({ ok: false, cant: why, message, ...this.shopHoldsOf(owner), ...extra });
    if (!rules.retailHolds) return cant('off', SHOP_HOLD_WORDS.off);
    if (this.shopHoldMisses(owner).paused) return cant('paused', SHOP_HOLD_WORDS.paused);
    const open = this.sql.exec(`SELECT variant_id FROM shop_holds WHERE customer_id = ? AND status IN ${OPEN}`, owner).toArray();
    if (open.some((h) => h.variant_id === variantId)) return cant('already', SHOP_HOLD_WORDS.already);
    if (open.length >= SHOP_HOLD_MAX) return cant('full', SHOP_HOLD_WORDS.full(open.length));
    if (this.shopHoldLocks().has(variantId)) return cant('busy', SHOP_HOLD_WORDS.busy);
    const locationId = this.retailLocationId();
    if (!locationId || !this.shopify.configured) throw new RuleError(SHOP_HOLD_WORDS.shopify, 503);
    const now = Date.now();
    const until = this.shopHoldUntil(rules, now);
    this.write(
      `INSERT INTO shop_holds (customer_id, product_id, variant_id, quantity, status, made_at, until) VALUES (?, ?, ?, 1, 'making', ?, ?)`,
      owner, productId, variantId, now, until,
    );
    const id = this.sql.exec('SELECT last_insert_rowid() AS id').one().id;
    this.shopHoldLocks().add(variantId);
    try {
      return await this.makeShopHoldNow({ id, owner, productId, variantId, until, locationId, rules, now }, cant);
    } catch (error) {
      this.write("DELETE FROM shop_holds WHERE id = ? AND status = 'making'", id);
      throw error;
    } finally {
      this.shopHoldLocks().delete(variantId);
    }
  },

  /** makeShopHold's part with Shopify: the option's facts, the member's name, the draft order; then the hold. */
  async makeShopHoldNow({ id, owner, productId, variantId, until, locationId, rules, now }, cant) {
    const api = this.shopHoldApi();
    let v;
    try {
      v = await api.holdVariant(variantId, locationId);
    } catch {
      throw new RuleError(SHOP_HOLD_WORDS.shopify, 502);
    }
    const drop = () => this.write("DELETE FROM shop_holds WHERE id = ? AND status = 'making'", id);
    const refuse = (why, message, extra) => {
      drop();
      return cant(why, message, extra);
    };
    if (!v || v.productId !== productId || !v.sold || v.giftCard || !v.tracked) return refuse('product', SHOP_HOLD_WORDS.product);
    if (v.tags.some((t) => String(t).toLowerCase() === SHOP_HOLD_OFF_TAG)) return refuse('noHolds', SHOP_HOLD_WORDS.noHolds);
    const release = v.productType === 'Trading Card Games' || v.vendor === 'Games Workshop';
    if (release && v.publishedAt && now < v.publishedAt + SHOP_HOLD_RELEASE_WAIT) {
      const starts = v.publishedAt + SHOP_HOLD_RELEASE_WAIT;
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-NZ', { timeZone: rules.tz, weekday: 'long', day: 'numeric', month: 'long' })
        .formatToParts(new Date(starts)).map((p) => [p.type, p.value]));
      return refuse('release', SHOP_HOLD_WORDS.release(`${parts.weekday} ${parts.day} ${parts.month}`), { startsAt: starts });
    }
    // the Lair's own count: the supplier's dice are held only when the Lair has some on its shelf
    if (!(v.shelf >= 1)) return v.supplier ? refuse('notShelf', SHOP_HOLD_WORDS.notShelf) : refuse('gone', SHOP_HOLD_WORDS.gone);
    // the member's name and email: the Lair's, else Shopify's
    const member = this.memberRow(owner);
    let first = member?.first_name || nameParts(member?.name)[0];
    let last = nameParts(member?.name)[1];
    let email = member?.email || null;
    if (!first || !email) {
      try {
        const c = await api.holdCustomer(owner);
        if (c) {
          first = first || c.first;
          last = last || c.last;
          email = email || c.email;
        }
      } catch {
        /* staff still see "A member"; the email about a hold not on the shelf can't go */
      }
    }
    let draft;
    try {
      draft = await api.holdDraft({ holdId: id, customerId: owner, variantId, quantity: 1, until });
    } catch (error) {
      console.error('Lair: could not make a hold\'s draft order', error);
      throw new RuleError(SHOP_HOLD_WORDS.shopify, 502);
    }
    // --- no awaits from here ---
    const who = shortOf(first, last);
    this.write(
      `UPDATE shop_holds SET status = 'new', draft_order_id = ?, customer_name = ?, email = ?, title = ?, variant_title = ?, handle = ?, image = ?, price = ?
        WHERE id = ? AND status = 'making'`,
      draft, who, email, v.title, v.variantTitle, v.handle, v.image, v.price, id,
    );
    const hold = this.sql.exec('SELECT * FROM shop_holds WHERE id = ?', id).one();
    this.notifyStaff(SHOP_HOLD_WORDS.staffSubject(label(hold), who), {
      title: SHOP_HOLD_WORDS.staffTitle,
      intro: SHOP_HOLD_WORDS.staffIntro(who, this.shopHoldUntilWords(rules, until)),
      details: [['What', label(hold)], ['For', who], ['Price', `$${((hold.price || 0) / 100).toFixed(2)}`]],
    });
    return { ok: true, hold: this.shopHoldView(hold), ...this.shopHoldsOf(owner) };
  },

  /** A hold by id, open (new or set), or a 404; with owner, only that member's */
  shopHoldOpen(id, owner = null) {
    const n = Number(id);
    const row = Number.isInteger(n) && n > 0 ? this.sql.exec(`SELECT * FROM shop_holds WHERE id = ? AND status IN ('new', 'set')`, n).toArray()[0] : null;
    if (!row || (owner && row.customer_id !== owner)) throw new RuleError(SHOP_HOLD_WORDS.notFound, 404);
    return row;
  },

  /**
   * Closes an open hold (status: collected, cancelled, ended or missing) and lets its stock go (the draft deleted; one
   * Shopify didn't take is tried again by the 10-minute run: release_due). Set aside and not collected: staff put it
   * back on the shelf (put_back). The write first (no await before it), then the release.
   */
  async shopHoldClose(row, status, how, by) {
    const now = Date.now();
    const putBack = row.status === 'set' && (status === 'cancelled' || status === 'ended') ? 1 : 0;
    this.write(
      `UPDATE shop_holds SET status = ?, closed_at = ?, closed_how = ?, closed_by = ?, put_back = ?, release_due = 1 WHERE id = ? AND status IN ('new', 'set')`,
      status, now, how, by || null, putBack, row.id,
    );
    if (!this.retailChanged()) return false;
    await this.shopHoldLetGo(row);
    return true;
  },

  /** The draft order deleted (the stock back on sale); a failure stays release_due for the next run */
  async shopHoldLetGo(row) {
    try {
      await this.shopHoldApi().holdRelease(row.draft_order_id);
      this.write('UPDATE shop_holds SET release_due = 0 WHERE id = ?', row.id);
      return true;
    } catch (error) {
      console.error('Lair: could not let a hold\'s stock go', error);
      return false;
    }
  },

  /** POST /me/holds/cancel { id } (logged in, their own): → { ok, holds, max, paused } */
  async cancelShopHold(input, who) {
    const owner = this.shopHoldOwner(who);
    const row = this.shopHoldOpen(input?.id, owner);
    await this.shopHoldClose(row, 'cancelled', 'member', owner);
    return { ok: true, ...this.shopHoldsOf(owner) };
  },

  /** A hold as staff see it on To pull. No awaits. */
  shopHoldStaffView(h) {
    return {
      id: h.id, customer: h.customer_name || 'A member', customerId: h.customer_id, title: h.title || '', variantTitle: h.variant_title || '',
      quantity: h.quantity, price: h.price, madeAt: h.made_at, until: h.until, status: h.status, putBack: Boolean(h.put_back),
      closedHow: h.closed_how || null,
    };
  },

  /** To pull's holds: open ones (new, set), and ones to put back on the shelf; members whose holds are paused. No awaits. */
  shopHoldsForStaff() {
    const rows = this.sql.exec(`SELECT * FROM shop_holds WHERE status IN ('new', 'set') OR put_back = 1 ORDER BY made_at DESC LIMIT 200`).toArray();
    const ended = this.sql.exec("SELECT DISTINCT customer_id FROM shop_holds WHERE status = 'ended'").toArray().map((r) => r.customer_id);
    const paused = ended.map((id) => ({ id, ...this.shopHoldMisses(id) })).filter((m) => m.paused).map((m) => {
      const last = this.sql.exec('SELECT customer_name FROM shop_holds WHERE customer_id = ? ORDER BY made_at DESC LIMIT 1', m.id).one();
      return { customerId: m.id, customer: last.customer_name || 'A member', misses: m.misses };
    });
    return { holds: rows.map((h) => this.shopHoldStaffView(h)), paused };
  },

  /** POST /staff/holds/set { id } (Check-in): set aside behind the counter → { ok, hold }. No awaits. */
  setShopHoldAside(input, who) {
    this.requireStaff(who, 'checkin');
    const row = this.shopHoldOpen(input?.id);
    if (row.status !== 'new') throw new RuleError(SHOP_HOLD_WORDS.notNew, 409);
    this.write("UPDATE shop_holds SET status = 'set', set_at = ?, set_by = ? WHERE id = ? AND status = 'new'", Date.now(), String(who.customerId || ''), row.id);
    return { ok: true, hold: this.shopHoldStaffView(this.sql.exec('SELECT * FROM shop_holds WHERE id = ?', row.id).one()) };
  },

  /** POST /staff/holds/collected { id } (Check-in): paid for at the counter → { ok } */
  async shopHoldCollected(input, who) {
    this.requireStaff(who, 'checkin');
    const row = this.shopHoldOpen(input?.id);
    await this.shopHoldClose(row, 'collected', 'staff', String(who.customerId || ''));
    return { ok: true };
  },

  /**
   * POST /staff/holds/missing { id } (Check-in): not on the shelf after all. Closed first (so nothing else can collect or
   * set it aside), then the stock let go and the Lair's count set to 0 in Shopify, then the member hears that it's
   * cancelled and there's nothing to pay. → { ok, warning? }: warning when Shopify didn't take the count.
   */
  async shopHoldMissing(input, who) {
    this.requireStaff(who, 'checkin');
    const row = this.shopHoldOpen(input?.id);
    const closed = await this.shopHoldClose(row, 'missing', 'staff', String(who.customerId || ''));
    if (!closed) return { ok: true };
    let warning = null;
    const locationId = this.retailLocationId();
    if (locationId && this.shopify.configured) {
      try {
        const answer = await this.retail().setShelf([{ variantId: row.variant_id, quantity: 0 }], locationId, `hold-missing-${row.id}`, `logistics://dicegoblin.nz/hold/${row.id}`);
        if (answer?.errors?.length) throw new Error(answer.errors.join('; '));
      } catch (error) {
        console.error('Lair: could not set the count of a hold not on the shelf', error);
        warning = SHOP_HOLD_WORDS.countNotSet(label(row));
      }
    }
    // --- no awaits from here ---
    if (emailReady(this.env) && row.email) {
      this.later(this.mail(this.letter(row.email, SHOP_HOLD_WORDS.missingSubject, {
        title: SHOP_HOLD_WORDS.missingTitle,
        intro: [SHOP_HOLD_WORDS.missingIntro(label(row)), SHOP_HOLD_WORDS.missingNothing],
        signoff: SHOP_HOLD_WORDS.missingSignoff,
      })));
    }
    return warning ? { ok: true, warning } : { ok: true };
  },

  /** POST /staff/holds/done { id } (Check-in): put back on the shelf → { ok }. No awaits. */
  shopHoldPutBack(input, who) {
    this.requireStaff(who, 'checkin');
    const n = Number(input?.id);
    const row = Number.isInteger(n) && n > 0 ? this.sql.exec('SELECT * FROM shop_holds WHERE id = ? AND put_back = 1', n).toArray()[0] : null;
    if (!row) throw new RuleError(SHOP_HOLD_WORDS.notFound, 404);
    this.write('UPDATE shop_holds SET put_back = 0 WHERE id = ?', row.id);
    return { ok: true };
  },

  /** POST /staff/holds/resume { customerId } (Check-in): a paused member's holds back on → { ok }. No awaits. */
  resumeShopHolds(input, who) {
    this.requireStaff(who, 'checkin');
    const id = digitsOf(input?.customerId);
    if (!id) throw new RuleError(SHOP_HOLD_WORDS.customer);
    this.write(
      'INSERT INTO shop_hold_resets (customer_id, at, by) VALUES (?, ?, ?) ON CONFLICT (customer_id) DO UPDATE SET at = excluded.at, by = excluded.by',
      id, Date.now(), String(who.customerId || ''),
    );
    return { ok: true };
  },

  /**
   * From a paid order at the counter (lair.js ordersPaid): a member's open hold of an option on the order is collected.
   * → how many. Never throws.
   */
  async shopHoldsFromOrder(order) {
    try {
      const customerId = digitsOf(order?.customer?.id);
      if (!customerId) return 0;
      const variants = new Set((order.line_items || []).map((l) => digitsOf(l.variant_id)).filter(Boolean));
      const rows = this.sql.exec("SELECT * FROM shop_holds WHERE customer_id = ? AND status IN ('new', 'set')", customerId).toArray().filter((h) => variants.has(h.variant_id));
      let n = 0;
      for (const row of rows) if (await this.shopHoldClose(row, 'collected', 'order', null)) n += 1;
      return n;
    } catch (error) {
      console.error('Lair: could not match a paid order to holds', error);
      return 0;
    }
  },

  /**
   * The 10-minute run's part: holds past their time end (set aside ones are put back on the shelf by staff), and stock
   * Shopify didn't let go is tried again. → { ended, released } or null.
   */
  async shopHoldUpkeep(now) {
    const due = this.sql.exec(`SELECT * FROM shop_holds WHERE status IN ('new', 'set') AND until <= ? ORDER BY until LIMIT 50`, now).toArray();
    let ended = 0;
    for (const row of due) if (await this.shopHoldClose(row, 'ended', 'time', null)) ended += 1;
    // placeholders left by a restart while Shopify was asked
    this.write("DELETE FROM shop_holds WHERE status = 'making' AND made_at < ?", now - 10 * 60_000);
    let released = 0;
    const stuck = this.sql.exec('SELECT * FROM shop_holds WHERE release_due = 1 AND closed_at IS NOT NULL ORDER BY closed_at LIMIT 20').toArray();
    for (const row of stuck) if (await this.shopHoldLetGo(row)) released += 1;
    return ended || released ? { ended, released } : null;
  },
};

/**
 * Round 31, retail and shopping (contract v31-retail; the plan "Retail and shopping: plan", Mo's picks on the canvas
 * "Retail and shopping: mockups", 6 Nov 2026). What the shop's selling side shares: its tables, the Shopify calls it
 * makes, the Lair's own stock location, opening-time maths and who the regulars are. The parts: the wishlist's emails
 * (src/wish-alerts.js), pickups to pull (src/pickups.js) and Open a display (src/displays.js).
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 * Shopify is reached through this.retail() (retailApi below), so the tests can stand in for it in one place.
 */
import { LairTime, MIN, addDays, openWindow, windowAt } from './core.js';
import { WISHLIST_V31, WISHLIST_V31_INDEXES } from './wishlist.js';
import { REGULAR_MIN, REGULAR_WINDOW, mondayOf } from './report.js';

/**
 * The tables (made when missing, from lair.js's migrate through retailMigrate):
 *  - wish_stock: the Lair's last read of each option someone wishes for: its count at the Lair's location (shelf, null
 *    when Shopify didn't say), on_shelf (shelf above 0), sellable (Shopify's availableForSale), supplier (sold from
 *    somewhere that isn't the Lair: the dice "Delivered in about 10 days"), sold (active and on the online store), what
 *    the item's words and picture are, back_at (when it last went from off the shelf to on it) and checked_at.
 *  - wish_alerts: one email that something's back, per member, product and return (back_at): which options, whether
 *    they're a regular, when it may go (due_at), and when it went or why it didn't (skipped), with its unsubscribe key.
 *  - pickups: paid online orders collected at the Lair, from paid to collected (src/pickups.js).
 *  - display_packs: how many packs are in each product's box, as staff last said; display_opens: each box opened.
 */
export const RETAIL_TABLES = [
  `CREATE TABLE IF NOT EXISTS wish_stock (
    variant_id TEXT PRIMARY KEY, product_id TEXT NOT NULL, shelf INTEGER, on_shelf INTEGER NOT NULL DEFAULT 0,
    sellable INTEGER NOT NULL DEFAULT 0, supplier INTEGER NOT NULL DEFAULT 0, sold INTEGER NOT NULL DEFAULT 1, price INTEGER,
    title TEXT, variant_title TEXT, handle TEXT, image TEXT, options INTEGER, back_at INTEGER, checked_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS wish_stock_product ON wish_stock (product_id)',
  `CREATE TABLE IF NOT EXISTS wish_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL, product_id TEXT NOT NULL, back_at INTEGER NOT NULL,
    variants TEXT NOT NULL, regular INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
    sent_at INTEGER, skipped TEXT, email TEXT, key TEXT, UNIQUE (customer_id, product_id, back_at))`,
  'CREATE INDEX IF NOT EXISTS wish_alerts_due ON wish_alerts (due_at) WHERE sent_at IS NULL AND skipped IS NULL',
  `CREATE TABLE IF NOT EXISTS pickups (
    order_id TEXT PRIMARY KEY, name TEXT NOT NULL, customer_id TEXT, customer_name TEXT, email TEXT, lines TEXT NOT NULL,
    paid_at INTEGER NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new', ready_at INTEGER, ready_by TEXT,
    missing TEXT, missing_at INTEGER, missing_by TEXT, missing_mailed INTEGER NOT NULL DEFAULT 0, reminded INTEGER NOT NULL DEFAULT 0,
    refund_due_at INTEGER, refund_mailed INTEGER NOT NULL DEFAULT 0, staff_mailed INTEGER NOT NULL DEFAULT 0,
    closed_at INTEGER, closed_how TEXT, created_at INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS pickups_open ON pickups (paid_at) WHERE status IN ('new', 'ready', 'missing')",
  `CREATE TABLE IF NOT EXISTS display_packs (
    product_id TEXT PRIMARY KEY, box_variant_id TEXT NOT NULL, pack_variant_id TEXT NOT NULL, packs INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, updated_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS display_opens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, product_id TEXT NOT NULL, title TEXT,
    box_variant_id TEXT NOT NULL, pack_variant_id TEXT NOT NULL, boxes INTEGER NOT NULL, packs INTEGER NOT NULL,
    box_before INTEGER, pack_before INTEGER, at INTEGER NOT NULL, by TEXT, undone_at INTEGER, undone_by TEXT)`,
];

/** Variants asked about in one Shopify request, and products (each with its options) */
export const STOCK_PAGE = 100;
export const PRODUCT_PAGE = 20;

const gid = (kind, id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/${kind}/${id}`);
const digits = (id) => String(id || '').split('/').pop();
const cents = (amount) => {
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** One variant as the wishlist's stock check keeps it, from Shopify's answer */
const variantStock = (v, product) => {
  const level = v.inventoryItem?.inventoryLevel?.quantities?.find((q) => q.name === 'available');
  const shelf = level ? Number(level.quantity) : v.inventoryItem?.tracked === false ? null : 0;
  const total = Number(v.inventoryQuantity);
  return {
    variantId: digits(v.id), productId: digits(product.id), shelf: Number.isFinite(shelf) ? shelf : null,
    sellable: Boolean(v.availableForSale),
    // sold from somewhere that isn't the Lair: more in Shopify's total than on the Lair's shelf, or the supplier's code
    supplier: Boolean(product.supplier?.value) || (Number.isFinite(total) && Number.isFinite(shelf) && total > Math.max(0, shelf)),
    sold: product.status === 'ACTIVE' && Boolean(product.onlineStoreUrl),
    price: cents(v.price), title: product.title || '', variantTitle: v.title && v.title !== 'Default Title' ? v.title : '',
    handle: product.handle || '', image: v.image?.url || product.featuredMedia?.preview?.image?.url || null,
    options: Number(product.variantsCount?.count) || null,
  };
};

const VARIANT_FIELDS = `id title price availableForSale inventoryQuantity image { url }
  inventoryItem { tracked inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } } }`;
const PRODUCT_FIELDS = `id title handle status onlineStoreUrl variantsCount { count } featuredMedia { preview { image { url } } }
  supplier: metafield(namespace: "supplier", key: "code") { value }`;

/**
 * The Shopify calls the shop's selling side makes, on the Lair's ShopifyAdmin (src/shopify.js). Each throws when Shopify
 * can't answer, so the caller decides whether to wait for the next run.
 */
export const retailApi = (shopify) => ({
  /** The Lair's count and the rest of wish_stock for up to STOCK_PAGE variants → [variantStock] (gone ones left out) */
  async variantStock(variantIds, locationId) {
    if (!variantIds.length) return [];
    const data = await shopify.graphql(
      `query RetailVariantStock($ids: [ID!]!, $location: ID!) { nodes(ids: $ids) { ... on ProductVariant { ${VARIANT_FIELDS} product { ${PRODUCT_FIELDS} } } } }`,
      { ids: variantIds.slice(0, STOCK_PAGE).map((id) => gid('ProductVariant', id)), location: gid('Location', locationId) },
      { timeout: 20_000 },
    );
    return (data.nodes || []).filter((v) => v?.id && v.product).map((v) => variantStock(v, v.product));
  },

  /** Every option (up to 100) of up to PRODUCT_PAGE products, as variantStock → [variantStock] */
  async productStock(productIds, locationId) {
    if (!productIds.length) return [];
    const data = await shopify.graphql(
      `query RetailProductStock($ids: [ID!]!, $location: ID!) { nodes(ids: $ids) { ... on Product { ${PRODUCT_FIELDS} variants(first: 100) { nodes { ${VARIANT_FIELDS} } } } } }`,
      { ids: productIds.slice(0, PRODUCT_PAGE).map((id) => gid('Product', id)), location: gid('Location', locationId) },
      { timeout: 20_000 },
    );
    return (data.nodes || []).filter((p) => p?.id).flatMap((p) => (p.variants?.nodes || []).map((v) => variantStock(v, p)));
  },

  /**
   * Paid online orders collected at the Lair, made since `sinceMs` (newest first, at most 50): the shape pickups keep.
   * Shopify's own search (delivery_method:pick-up) says which are pickups. read_orders.
   */
  async pickupOrders(sinceMs, { orderId = null } = {}) {
    const terms = ['delivery_method:pick-up', `created_at:>='${new Date(sinceMs).toISOString()}'`];
    if (orderId) terms.push(`id:${digits(orderId)}`);
    const data = await shopify.graphql(
      `query RetailPickupOrders($query: String!) { orders(first: 50, query: $query, sortKey: CREATED_AT, reverse: true) { nodes {
        id name createdAt processedAt cancelledAt displayFinancialStatus displayFulfillmentStatus sourceName email
        customer { id firstName lastName defaultEmailAddress { emailAddress } }
        lineItems(first: 50) { nodes { id title variantTitle quantity currentQuantity variant { id } product { id }
          originalUnitPriceSet { shopMoney { amount } } discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } } } } } } }`,
      { query: terms.join(' ') },
      { timeout: 20_000 },
    );
    return (data.orders?.nodes || []).map((o) => ({
      orderId: digits(o.id), name: o.name || '', paidAt: Date.parse(o.processedAt || o.createdAt) || Date.now(),
      cancelled: Boolean(o.cancelledAt), financial: o.displayFinancialStatus || '', fulfilment: o.displayFulfillmentStatus || '',
      online: o.sourceName === 'web', customerId: o.customer?.id ? digits(o.customer.id) : null,
      firstName: o.customer?.firstName || '', lastName: o.customer?.lastName || '',
      email: o.email || o.customer?.defaultEmailAddress?.emailAddress || null,
      lines: (o.lineItems?.nodes || []).filter((l) => (l.currentQuantity ?? l.quantity) > 0).map((l) => ({
        lineId: digits(l.id), variantId: l.variant?.id ? digits(l.variant.id) : null, productId: l.product?.id ? digits(l.product.id) : null,
        title: l.title || '', variantTitle: l.variantTitle && l.variantTitle !== 'Default Title' ? l.variantTitle : '',
        // what was paid for one, after every discount (the review: never the price before a discount code)
        quantity: Number(l.currentQuantity ?? l.quantity) || 0,
        price: cents(l.discountedUnitPriceAfterAllDiscountsSet?.shopMoney?.amount ?? l.originalUnitPriceSet?.shopMoney?.amount) || 0,
      })),
    }));
  },

  /** Whether each order is fulfilled (picked up) or cancelled now: Map of orderId → { fulfilment, cancelled } */
  async ordersState(orderIds) {
    if (!orderIds.length) return new Map();
    const data = await shopify.graphql(
      'query RetailOrdersState($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id displayFulfillmentStatus cancelledAt } } }',
      { ids: orderIds.slice(0, 100).map((id) => gid('Order', id)) },
      { timeout: 20_000 },
    );
    return new Map((data.nodes || []).filter((o) => o?.id).map((o) => [digits(o.id), { fulfilment: o.displayFulfillmentStatus || '', cancelled: Boolean(o.cancelledAt) }]));
  },

  /**
   * Marks an order's pickup ready (Shopify sends its ready-for-pickup email). Needs
   * write_merchant_managed_fulfillment_orders. → { ok } or { errors: [message] }; throws when Shopify can't answer.
   */
  async markReady(orderId) {
    const data = await shopify.graphql(
      'query RetailPickupFulfilment($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status deliveryMethod { methodType } } } } }',
      { id: gid('Order', orderId) },
      { timeout: 20_000 },
    );
    const open = (data.order?.fulfillmentOrders?.nodes || []).filter((f) => f.deliveryMethod?.methodType === 'PICK_UP' && ['OPEN', 'IN_PROGRESS'].includes(f.status));
    if (!open.length) return { ok: true, none: true };
    const done = await shopify.graphql(
      'mutation RetailPickupReady($input: FulfillmentOrderLineItemsPreparedForPickupInput!) { fulfillmentOrderLineItemsPreparedForPickup(input: $input) { userErrors { field message } } }',
      { input: { lineItemsByFulfillmentOrder: open.map((f) => ({ fulfillmentOrderId: f.id })) } },
      { timeout: 20_000 },
    );
    const errors = done.fulfillmentOrderLineItemsPreparedForPickup?.userErrors || [];
    return errors.length ? { errors: errors.map((e) => String(e.message || '')) } : { ok: true };
  },

  /**
   * Sets the Lair's count of some variants (inventorySetQuantities, available), once per key: [{ variantId, quantity }].
   * write_inventory. → { ok } or { errors }.
   */
  async setShelf(changes, locationId, key, reference) {
    if (!changes.length) return { ok: true };
    const items = await shopify.graphql(
      'query RetailInventoryItems($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id inventoryItem { id } } } }',
      { ids: changes.map((c) => gid('ProductVariant', c.variantId)) },
      { timeout: 20_000 },
    );
    const itemOf = new Map((items.nodes || []).filter((v) => v?.inventoryItem?.id).map((v) => [digits(v.id), v.inventoryItem.id]));
    const quantities = changes.filter((c) => itemOf.has(String(c.variantId)))
      .map((c) => ({ inventoryItemId: itemOf.get(String(c.variantId)), locationId: gid('Location', locationId), quantity: c.quantity, changeFromQuantity: null }));
    if (!quantities.length) return { ok: true };
    const data = await shopify.graphql(
      `mutation RetailSetShelf($input: InventorySetQuantitiesInput!, $key: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { field message code } } }`,
      { key, input: { name: 'available', reason: 'correction', referenceDocumentUri: reference, quantities } },
      { timeout: 20_000 },
    );
    const errors = data.inventorySetQuantities?.userErrors || [];
    return errors.length ? { errors: errors.map((e) => String(e.message || '')) } : { ok: true };
  },

  /**
   * Products whose title has the words, with two or more options, and each option's Lair count (at most 20) →
   * [{ productId, title, variants: [{ variantId, title, shelf, inventoryItemId }] }]. read_products, read_inventory.
   */
  async displayProducts(words, locationId) {
    const text = String(words || '').replace(/["\\]/g, ' ').trim();
    const data = await shopify.graphql(
      `query RetailDisplayProducts($query: String!, $location: ID!) { products(first: 20, query: $query, sortKey: RELEVANCE) { nodes {
        id title status variants(first: 30) { nodes { id title inventoryItem { id tracked inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } } } } } } } }`,
      { query: `${text} AND status:active`, location: gid('Location', locationId) },
      { timeout: 20_000 },
    );
    return (data.products?.nodes || []).map((p) => ({
      productId: digits(p.id), title: p.title || '',
      variants: (p.variants?.nodes || []).map((v) => ({
        variantId: digits(v.id), title: v.title || '', inventoryItemId: v.inventoryItem?.id || null,
        shelf: Number(v.inventoryItem?.inventoryLevel?.quantities?.find((q) => q.name === 'available')?.quantity ?? 0),
      })),
    })).filter((p) => p.variants.length >= 2);
  },

  /** One product's options as displayProducts gives them, or null */
  async displayProduct(productId, locationId) {
    const data = await shopify.graphql(
      `query RetailDisplayProduct($id: ID!, $location: ID!) { product(id: $id) { id title variants(first: 30) { nodes {
        id title inventoryItem { id inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } } } } } } }`,
      { id: gid('Product', productId), location: gid('Location', locationId) },
      { timeout: 20_000 },
    );
    const p = data.product;
    if (!p?.id) return null;
    return {
      productId: digits(p.id), title: p.title || '',
      variants: (p.variants?.nodes || []).map((v) => ({
        variantId: digits(v.id), title: v.title || '', inventoryItemId: v.inventoryItem?.id || null,
        shelf: Number(v.inventoryItem?.inventoryLevel?.quantities?.find((q) => q.name === 'available')?.quantity ?? 0),
      })),
    };
  },

  /** Adds deltas to the Lair's counts in one go (inventoryAdjustQuantities, available), once per key → { ok } or { errors } */
  async adjustShelf(changes, locationId, key, reference) {
    const data = await shopify.graphql(
      `mutation RetailAdjustShelf($input: InventoryAdjustQuantitiesInput!, $key: String!) {
        inventoryAdjustQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { field message code } } }`,
      {
        key,
        input: {
          name: 'available', reason: 'correction', referenceDocumentUri: reference,
          changes: changes.map((c) => ({ inventoryItemId: c.inventoryItemId, locationId: gid('Location', locationId), delta: c.delta, changeFromQuantity: null })),
        },
      },
      { timeout: 20_000 },
    );
    const answer = data.inventoryAdjustQuantities;
    if (answer?.userErrors?.length) return { errors: answer.userErrors.map((e) => String(e.message || '')) };
    return { ok: true };
  },
});

export const retailMethods = {
  /**
   * Round 31's tables, made when missing (lair.js's migrate): the wishlist moved onto its new key once (WISHLIST_V31,
   * when it has no variant_id yet), then RETAIL_TABLES. No awaits.
   */
  retailMigrate() {
    try {
      this.sql.exec('SELECT variant_id FROM wishlist LIMIT 0');
    } catch {
      for (const statement of WISHLIST_V31) this.sql.exec(statement);
    }
    // from the review: Tell me when it's back's request (asked_at), on a table made before it
    try {
      this.sql.exec('SELECT asked_at FROM wishlist LIMIT 0');
    } catch {
      this.sql.exec('ALTER TABLE wishlist ADD COLUMN asked_at INTEGER');
    }
    for (const statement of [...WISHLIST_V31_INDEXES, ...RETAIL_TABLES]) this.sql.exec(statement);
  },

  /**
   * The 10-minute run's part for the selling side (lair.js's maintenance), each step on its own: the wishlist's stock
   * and what came back (src/wish-alerts.js), the back-on-the-shelf emails due, pickups the webhook missed or that were
   * collected, and pickups' reminders and refunds due (src/pickups.js). → what happened, or null.
   */
  async retailUpkeep(rules, now) {
    const out = {};
    try {
      const stock = await this.wishStockCheck(now);
      if (stock.back.length) out.back = stock.back.length;
      const queued = this.wishQueueAlerts(rules, stock.back, now);
      if (queued) out.queued = queued;
    } catch (error) {
      console.error('Lair: could not check the wishlist\'s stock', error);
    }
    try {
      const sent = await this.wishSendDue(rules, now);
      if (sent) out.wishEmails = sent;
    } catch (error) {
      console.error('Lair: could not send back-on-the-shelf emails', error);
    }
    try {
      const swept = await this.pickupSweep(rules, now);
      if (swept) out.pickups = swept;
    } catch (error) {
      console.error('Lair: could not look for pickups', error);
    }
    try {
      const kept = this.pickupUpkeep(rules, now);
      if (kept) out.pickupMail = kept;
    } catch (error) {
      console.error('Lair: could not remind pickups', error);
    }
    return Object.keys(out).length ? out : null;
  },

  /** Whether the write just before changed a row (SQLite's changes()). No awaits. */
  retailChanged() {
    return Number(this.sql.exec('SELECT changes() AS n').toArray()[0]?.n) > 0;
  },

  /** The Shopify calls (retailApi), on this Lair's Shopify. Tests stand in for it by setting lair.retail. */
  retail() {
    return retailApi(this.shopify);
  },

  /** The Lair's own stock location's number (LAIR_LOCATION_ID, else GW_LOCATION_ID), or null when neither is set */
  retailLocationId() {
    const id = String(this.env.LAIR_LOCATION_ID || this.env.GW_LOCATION_ID || '').split('/').pop();
    return /^\d+$/.test(id) ? id : null;
  },

  /**
   * Who's a regular at `now`, as Monday's numbers count them (src/report.js): an account and visits in at least
   * REGULAR_MIN different weeks of the REGULAR_WINDOW weeks that end with this one. → a Set of customer IDs. No awaits.
   */
  regularIdsAt(rules, now) {
    const time = new LairTime(rules.tz);
    const thisMonday = mondayOf(time, time.key(now));
    const mondays = Array.from({ length: REGULAR_WINDOW }, (_, i) => addDays(thisMonday, -7 * i)).sort();
    const starts = mondays.map((m) => [m, time.at(m, 0)]);
    const from = starts[0][1];
    const weekOf = (ms) => {
      if (ms < from || ms >= now) return null;
      let found = null;
      for (const [m, at] of starts) if (at <= ms) found = m;
      return found;
    };
    const seen = new Map();
    for (const ids of this.visitorsByWeek(from, now, weekOf).values()) for (const id of ids) seen.set(id, (seen.get(id) || 0) + 1);
    return new Set([...seen].filter(([, n]) => n >= REGULAR_MIN).map(([id]) => id));
  },

  /**
   * The moment `minutes` of opening time after `ms` (a pickup's "Promised by": 2 hours while the shop is open). Closed
   * at `ms`: counting starts when it next opens. Looks 14 days ahead at most (then null). No awaits.
   */
  openMinutesAfter(rules, ms, minutes) {
    const time = new LairTime(rules.tz);
    let left = minutes * MIN;
    let at = ms;
    for (let i = 0; i < 15 && left >= 0; i += 1) {
      const key = time.key(at);
      // the window `at` is in (today's, or yesterday's running past midnight), else today's and the days after
      const windows = [windowAt(rules, time, at), ...[0, 1].map((n) => openWindow(rules, time, addDays(key, n)))].filter(Boolean);
      const next = windows.filter((w) => w.close > at).sort((a, b) => a.open - b.open)[0];
      if (!next) {
        at = time.at(addDays(key, 1), 0);
        continue;
      }
      const start = Math.max(at, next.open);
      if (start + left <= next.close) return start + left;
      left -= next.close - start;
      at = next.close;
    }
    return null;
  },

  /**
   * Today's hours at the Lair in words for an email's details, like "4pm to midnight", or "Closed today". No awaits.
   */
  retailOpenLine(rules, now) {
    const time = new LairTime(rules.tz);
    const today = openWindow(rules, time, time.key(now));
    if (!today) return 'Closed today';
    const clock = (m) => {
      const h = Math.floor(m / 60) % 24;
      const mi = m % 60;
      if (h === 0 && mi === 0) return 'midnight';
      if (h === 12 && mi === 0) return 'midday';
      return `${h % 12 || 12}${mi ? `:${String(mi).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
    };
    return `${clock(today.openMin)} to ${clock(today.closeMin)}`;
  },
};

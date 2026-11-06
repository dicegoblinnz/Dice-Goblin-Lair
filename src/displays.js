/**
 * Round 31 (retail, contract v31-retail section 4): Open a display. Mo's pick on 1 Nov 2026 ("Open a display button"):
 * staff opening a booster box to sell its packs singly take the box off and put its packs on in one go, so the stock line
 * on the website stays true. Mockup K-open-display (Mo, 6 Nov 2026: "Love it!!!").
 *
 * - GET /staff/displays?q= (Check-in): products with two or more options whose title has the words, each option's Lair
 *   count, and what was last used for that product (box, pack and how many packs a box holds).
 * - POST /staff/displays/open: the Lair's counts change in Shopify (inventoryAdjustQuantities, once per key), then the
 *   opening is kept and the pack count remembered.
 * - POST /staff/displays/undo: put one back within a day, once.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { HOUR, RuleError } from './core.js';

/** At most this many boxes in one opening, and packs in one box */
export const DISPLAY_MAX_BOXES = 10;
export const DISPLAY_MAX_PACKS = 100;
/** An opening can be undone this long after */
export const DISPLAY_UNDO_FOR = 24 * HOUR;

/** Everything staff read from here, word for word in the contract */
export const DISPLAY_WORDS = {
  pick: "Pick the box you're opening and the packs it holds.",
  same: 'The box and the packs need to be different options.',
  boxes: `Open between 1 and ${DISPLAY_MAX_BOXES} boxes at a time.`,
  packs: `A box holds between 1 and ${DISPLAY_MAX_PACKS} packs.`,
  noBox: (n) => `Shopify has ${n} of that box on the shelf. Count them, then fix the count in Shopify first.`,
  undoLate: 'That was more than a day ago. Change the counts in Shopify instead.',
  undone: 'That one has already been put back.',
  notFound: "That opening isn't one the Lair knows. Refresh the page.",
  noProduct: "Shopify doesn't have that product any more. Refresh the page.",
  key: "That didn't come through properly. Try again.",
  // from the review: the same tap's key with other numbers, and two openings of one product at once
  keyUsed: 'That tap was already used for a different opening. Refresh the page, then try again.',
  busy: "Someone's opening or putting back that one right now. Try again in a moment.",
  shopify: "Shopify didn't take it. Nothing changed. Try again in a minute.",
  setup: "The Lair doesn't know which location is the shop's yet (LAIR_LOCATION_ID).",
  words: 'Type at least 2 letters of the product.',
};

const digitsOf = (value) => {
  const id = String(value ?? '').trim().split('/').pop();
  return /^\d{1,20}$/.test(id) ? id : null;
};

export const displayMethods = {
  /** What was last used for a product: { boxVariantId, packVariantId, packs }, or null. No awaits. */
  displayRemembered(productId) {
    const r = this.sql.exec('SELECT * FROM display_packs WHERE product_id = ?', String(productId)).toArray()[0];
    return r ? { boxVariantId: r.box_variant_id, packVariantId: r.pack_variant_id, packs: r.packs } : null;
  },

  /** The location stock changes go to, or a 503 when none is set */
  displayLocation() {
    const locationId = this.retailLocationId();
    if (!locationId) throw new RuleError(DISPLAY_WORDS.setup, 503);
    return locationId;
  },

  /**
   * GET /staff/displays?q= (Check-in): { products, recent }. products: Shopify's matches with two or more options, each
   * with its options' Lair counts and what was last used (remembered); recent: the last 5 openings, newest first.
   */
  async displaySearch(url, who) {
    this.requireStaff(who, 'checkin');
    const words = String(url.searchParams.get('q') || '').trim().slice(0, 80);
    const recent = this.sql.exec('SELECT * FROM display_opens ORDER BY at DESC, id DESC LIMIT 5').toArray().map((r) => this.displayView(r));
    if (!words) return { products: [], recent };
    if (words.length < 2) throw new RuleError(DISPLAY_WORDS.words);
    let found;
    try {
      found = await this.retail().displayProducts(words, this.displayLocation());
    } catch (error) {
      if (error instanceof RuleError) throw error;
      throw new RuleError(DISPLAY_WORDS.shopify, 502);
    }
    // --- no awaits from here ---
    return {
      products: found.map((p) => ({ productId: p.productId, title: p.title, variants: p.variants.map((v) => ({ variantId: v.variantId, title: v.title, shelf: v.shelf })), remembered: this.displayRemembered(p.productId) })),
      recent,
    };
  },

  /** One opening as staff see it. No awaits. */
  displayView(r) {
    return {
      id: r.id, productId: r.product_id, title: r.title || '', boxes: r.boxes, packs: r.packs, at: r.at, undone: Boolean(r.undone_at),
      box: { before: r.box_before, after: r.box_before === null ? null : r.box_before - r.boxes },
      pack: { before: r.pack_before, after: r.pack_before === null ? null : r.pack_before + r.boxes * r.packs },
      canUndo: !r.undone_at && Date.now() - r.at < DISPLAY_UNDO_FOR,
    };
  },

  /**
   * POST /staff/displays/open { productId, boxVariantId, packVariantId, boxes, packs, key } (Check-in): the boxes come off
   * and their packs go on at the Lair's location, in one change in Shopify, once per key (the same key again answers
   * with the same opening, repeated: true). → { ok, open, repeated? }. Every await first, then the writes.
   */
  async displayOpen(input, who) {
    this.requireStaff(who, 'checkin');
    const productId = digitsOf(input?.productId);
    const boxId = digitsOf(input?.boxVariantId);
    const packId = digitsOf(input?.packVariantId);
    if (!productId || !boxId || !packId) throw new RuleError(DISPLAY_WORDS.pick);
    if (boxId === packId) throw new RuleError(DISPLAY_WORDS.same);
    const boxes = Number(input?.boxes);
    const packs = Number(input?.packs);
    if (!Number.isInteger(boxes) || boxes < 1 || boxes > DISPLAY_MAX_BOXES) throw new RuleError(DISPLAY_WORDS.boxes);
    if (!Number.isInteger(packs) || packs < 1 || packs > DISPLAY_MAX_PACKS) throw new RuleError(DISPLAY_WORDS.packs);
    const key = typeof input?.key === 'string' ? input.key.trim() : '';
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new RuleError(DISPLAY_WORDS.key);
    const done = this.sql.exec('SELECT * FROM display_opens WHERE key = ?', key).toArray()[0];
    if (done) {
      // the same tap again (an answer lost on the way) is the same opening; other numbers on that tap are refused
      const same = done.product_id === productId && done.box_variant_id === boxId && done.pack_variant_id === packId && done.boxes === boxes && done.packs === packs;
      if (!same) throw new RuleError(DISPLAY_WORDS.keyUsed, 409);
      return { ok: true, open: this.displayView(done), repeated: true };
    }
    const locationId = this.displayLocation();
    // one opening (or undo) of a product at a time, so two can't both pass the box count (the review)
    if (this.displayLocks().has(productId)) throw new RuleError(DISPLAY_WORDS.busy, 409);
    this.displayLocks().add(productId);
    try {
      return await this.displayOpenNow({ productId, boxId, packId, boxes, packs, key, locationId }, who);
    } finally {
      this.displayLocks().delete(productId);
    }
  },

  /** The products being opened or put back right now, one at a time each (this Lair's own, made the first time) */
  displayLocks() {
    if (!this.displayLockSet) this.displayLockSet = new Set();
    return this.displayLockSet;
  },

  /** displayOpen's Shopify part and the record, once the checks are done (one product at a time: displayLocks) */
  async displayOpenNow({ productId, boxId, packId, boxes, packs, key, locationId }, who) {
    const api = this.retail();
    let product;
    try {
      product = await api.displayProduct(productId, locationId);
    } catch {
      throw new RuleError(DISPLAY_WORDS.shopify, 502);
    }
    if (!product) throw new RuleError(DISPLAY_WORDS.noProduct, 404);
    const box = product.variants.find((v) => v.variantId === boxId);
    const pack = product.variants.find((v) => v.variantId === packId);
    if (!box || !pack || !box.inventoryItemId || !pack.inventoryItemId) throw new RuleError(DISPLAY_WORDS.pick);
    if (box.shelf < boxes) throw new RuleError(DISPLAY_WORDS.noBox(box.shelf), 409);
    const before = { box: box.shelf, pack: pack.shelf };
    let answer;
    try {
      answer = await api.adjustShelf(
        [{ inventoryItemId: box.inventoryItemId, delta: -boxes }, { inventoryItemId: pack.inventoryItemId, delta: boxes * packs }],
        locationId, `open-display-${key}`, `logistics://dicegoblin.nz/open-display/${key}`,
      );
    } catch {
      throw new RuleError(DISPLAY_WORDS.shopify, 502);
    }
    if (answer.errors?.length) throw new RuleError(DISPLAY_WORDS.shopify, 502);
    // --- no awaits from here ---
    const again = this.sql.exec('SELECT * FROM display_opens WHERE key = ?', key).toArray()[0];
    if (again) return { ok: true, open: this.displayView(again), repeated: true };
    const now = Date.now();
    const by = String(who.customerId || '');
    this.write(
      `INSERT INTO display_opens (key, product_id, title, box_variant_id, pack_variant_id, boxes, packs, box_before, pack_before, at, by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      key, productId, `${product.title}`, boxId, packId, boxes, packs, before.box, before.pack, now, by,
    );
    this.write(
      `INSERT INTO display_packs (product_id, box_variant_id, pack_variant_id, packs, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (product_id) DO UPDATE SET box_variant_id = excluded.box_variant_id, pack_variant_id = excluded.pack_variant_id,
          packs = excluded.packs, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      productId, boxId, packId, packs, now, by,
    );
    return { ok: true, open: this.displayView(this.sql.exec('SELECT * FROM display_opens WHERE key = ?', key).one()) };
  },

  /**
   * POST /staff/displays/undo { id } (Check-in): within DISPLAY_UNDO_FOR, once: the packs come off and the boxes go back
   * on, in one change in Shopify. → { ok, undone }. Every await first, then the write.
   */
  async displayUndo(input, who) {
    this.requireStaff(who, 'checkin');
    const id = Number(input?.id);
    const row = Number.isInteger(id) && id > 0 ? this.sql.exec('SELECT * FROM display_opens WHERE id = ?', id).toArray()[0] : null;
    if (!row) throw new RuleError(DISPLAY_WORDS.notFound, 404);
    if (row.undone_at) throw new RuleError(DISPLAY_WORDS.undone, 409);
    if (Date.now() - row.at >= DISPLAY_UNDO_FOR) throw new RuleError(DISPLAY_WORDS.undoLate, 409);
    const locationId = this.displayLocation();
    if (this.displayLocks().has(row.product_id)) throw new RuleError(DISPLAY_WORDS.busy, 409);
    this.displayLocks().add(row.product_id);
    try {
      return await this.displayUndoNow(row, locationId, who);
    } finally {
      this.displayLocks().delete(row.product_id);
    }
  },

  /** displayUndo's Shopify part and the record (one product at a time: displayLocks) */
  async displayUndoNow(row, locationId, who) {
    const api = this.retail();
    let product;
    try {
      product = await api.displayProduct(row.product_id, locationId);
    } catch {
      throw new RuleError(DISPLAY_WORDS.shopify, 502);
    }
    const box = product?.variants.find((v) => v.variantId === row.box_variant_id);
    const pack = product?.variants.find((v) => v.variantId === row.pack_variant_id);
    if (!box?.inventoryItemId || !pack?.inventoryItemId) throw new RuleError(DISPLAY_WORDS.noProduct, 404);
    let answer;
    try {
      answer = await api.adjustShelf(
        [{ inventoryItemId: box.inventoryItemId, delta: row.boxes }, { inventoryItemId: pack.inventoryItemId, delta: -(row.boxes * row.packs) }],
        locationId, `undo-display-${row.key}`, `logistics://dicegoblin.nz/open-display/${row.key}/undo`,
      );
    } catch {
      throw new RuleError(DISPLAY_WORDS.shopify, 502);
    }
    if (answer.errors?.length) throw new RuleError(DISPLAY_WORDS.shopify, 502);
    // --- no awaits from here ---
    this.write('UPDATE display_opens SET undone_at = ?, undone_by = ? WHERE id = ? AND undone_at IS NULL', Date.now(), String(who.customerId || ''), row.id);
    return { ok: true, undone: this.displayView(this.sql.exec('SELECT * FROM display_opens WHERE id = ?', row.id).one()) };
  },
};

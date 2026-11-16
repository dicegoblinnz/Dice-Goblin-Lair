/**
 * Round 43 (17 Nov 2026, contract v43-shelf-picks): what's on the shelf right now, for the home page's d20 roller.
 *
 * Mo, 17 Nov 2026: "the home page d20 roller should only pick things on the shelf right now (stock above 0). No
 * ordered-in Warhammer, pre-orders or dropshipped dice." The website's own product list can't tell those apart: a
 * dropshipped dice set shows 100 (the dice maker's count, at the "Dice Hoard" location), and Games Workshop's ordered-in
 * kits and anything on pre-order keep selling at 0. Only the count at the shop's own location ("Dice Goblin", the one
 * Stock off takes from: stockOffLocation) says what's on the shelf, and only the Admin API can read it.
 *
 * So the Lair keeps a list (shelf_stock): every variant that's counted, has at least one free to sell at the shop's
 * location, a price, and a product the shop sells on the Online Store (shelfRowOf in src/shopify.js). GET /shelf/pick
 * answers from it at once with one product, every product equally likely, and the variants of it on the shelf; the
 * theme then reads the product's own page data, so the price and picture are always today's.
 *
 * Kept up to date two ways. The 10-minute run (maintenance) wakes the Durable Object's alarm when the list is older
 * than SHELF.fresh (or there's none), and the alarm reads it in its own invocation, so the list is ready before anyone
 * rolls, at any hour (17 Nov 2026: the first roll after going live found no list and showed nothing). And a pick from a
 * list older than SHELF.fresh starts a read in the background too (one at a time), answering from the list it has. A list older than SHELF.usable isn't used at all (the
 * roller falls back to its own careful pick), so a quiet week never sends anyone to something sold days ago. A read
 * is a page at a time, paced by Shopify's bucket, with at most SHELF.callsPerRun calls an invocation (Cloudflare's free
 * plan allows 50, counting what the request made before): what's left goes on with the next pick. The new list only
 * replaces the old once it's whole. A failed read waits SHELF.retry before the next.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { HOUR, MIN } from './core.js';
import { externalCalls, shopifyPaceWait } from './shopify.js';


/** The numbers in one place */
export const SHELF = {
  // a list this old starts a fresh read on the next pick
  fresh: 20 * MIN,
  // a list older than this isn't picked from
  usable: 2 * HOUR,
  // a failed read: the next waits this long
  retry: 5 * MIN,
  // the most Shopify calls one invocation's read makes (logins included), counting the request's own before it
  callsPerRun: 20,
  // the Durable Object's alarm keeps the list fresh between picks: the most calls its invocation makes, the filters'
  // upkeep before it included (Cloudflare's free plan allows 50)
  alarmCalls: 45,
  // the 10-minute run sets the alarm this soon when the list is due a read
  warmWait: 5_000,
  // a read that stopped part-way (its calls ran out) carries on with the next pick, unless it last moved this long ago
  stuck: 10 * MIN,
  // products the roller can ask to skip (the last few it showed)
  skip: 10,
};

export const SHELF_TABLES = [
  // the list picks come from, and the one being read (run 'next'), swapped in whole when its read finishes
  `CREATE TABLE IF NOT EXISTS shelf_stock (
    run TEXT NOT NULL, variant_id TEXT NOT NULL, product_id TEXT NOT NULL, handle TEXT NOT NULL, stock INTEGER NOT NULL,
    PRIMARY KEY (run, variant_id))`,
  // one row a run ('live', 'next'): when its read started, last read a page and finished, the next page's cursor, the
  // last failure
  `CREATE TABLE IF NOT EXISTS shelf_runs (
    run TEXT PRIMARY KEY, started_at INTEGER, moved_at INTEGER, done_at INTEGER, cursor TEXT, pages INTEGER NOT NULL DEFAULT 0,
    failed_at INTEGER, error TEXT)`,
];

/** A fair whole number from 0 to n - 1 */
function randomInt(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const box = new Uint32Array(1);
  do {
    crypto.getRandomValues(box);
  } while (box[0] >= limit);
  return box[0] % n;
}

/** The product numbers the roller asked to skip: ?not=1,2,3 (numbers only, the first SHELF.skip) */
export function shelfSkips(url) {
  return new Set(
    String(url?.searchParams?.get('not') || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{1,20}$/.test(s))
      .slice(0, SHELF.skip),
  );
}

export const shelfPickMethods = {
  /** A run's row, or an empty one. No awaits. */
  shelfRun(run) {
    return this.sql.exec('SELECT * FROM shelf_runs WHERE run = ?', run).toArray()[0] || { run, started_at: null, moved_at: null, done_at: null, cursor: null, pages: 0, failed_at: null, error: null };
  },

  /** The list picks come from, a product at a time ({ productId, handle, variants }), kept in memory until it changes. No awaits. */
  shelfProducts() {
    if (!this.shelfCache) {
      const byProduct = new Map();
      for (const r of this.sql.exec("SELECT product_id, handle, variant_id FROM shelf_stock WHERE run = 'live' ORDER BY product_id, variant_id").toArray()) {
        const p = byProduct.get(r.product_id) || { productId: r.product_id, handle: r.handle, variants: [] };
        p.variants.push(r.variant_id);
        byProduct.set(r.product_id, p);
      }
      this.shelfCache = [...byProduct.values()];
    }
    return this.shelfCache;
  },

  /**
   * GET /shelf/pick?not=<product numbers>: anyone, logged in or not. → { pick: { productId, handle, variants } | null,
   * count (products on the list), at (when the list was read, ISO, or null) }. pick is null when there's no usable list
   * yet, or nothing on it but what was skipped: the roller then picks for itself. A list older than SHELF.fresh (or
   * none) starts a fresh read in the background.
   */
  shelfPick(url, callsAtStart = externalCalls.count, now = Date.now()) {
    const live = this.shelfRun('live');
    const age = live.done_at ? now - live.done_at : Infinity;
    if (age > SHELF.fresh) this.shelfRefreshSoon(now, callsAtStart);
    const at = live.done_at ? new Date(live.done_at).toISOString() : null;
    if (age > SHELF.usable) return { pick: null, count: 0, at };
    const products = this.shelfProducts();
    const skip = shelfSkips(url);
    const choices = skip.size ? products.filter((p) => !skip.has(p.productId)) : products;
    const pick = choices.length ? choices[randomInt(choices.length)] : null;
    return { pick: pick ? { productId: pick.productId, handle: pick.handle, variants: [...pick.variants] } : null, count: products.length, at };
  },

  /** Whether the list is due a read: none yet, or older than SHELF.fresh, and the last failure (if any) long enough ago. No awaits. */
  shelfDue(now = Date.now()) {
    if (!this.shopify?.configured || this.shelfReading) return false;
    const live = this.shelfRun('live');
    if (live.done_at && now - live.done_at <= SHELF.fresh) return false;
    const next = this.shelfRun('next');
    return !(next.failed_at && now - next.failed_at < SHELF.retry);
  },

  /** The 10-minute run: when the list is due a read, the alarm does it in a few seconds. Never throws. No awaits. */
  shelfKeepWarm(now = Date.now()) {
    try {
      if (this.shelfDue(now)) this.wakeAt(now + SHELF.warmWait);
    } catch (error) {
      console.error('Lair: could not plan the shelf read', error);
    }
  },

  /** The alarm: read the list when it's due, within the alarm invocation's calls. Never throws. */
  async shelfAlarm(now = Date.now(), callsAtStart = externalCalls.count) {
    try {
      if (!this.shelfDue(now)) return null;
      this.shelfReading = this.shelfRead(now, callsAtStart, SHELF.alarmCalls);
      const out = await this.shelfReading;
      // more to read than the calls allowed: the alarm comes back in a minute, in a fresh invocation
      if (!out.done && !out.error) this.wakeAt(Date.now() + MIN);
      return out;
    } catch (error) {
      console.error('Lair: the shelf alarm failed', error);
      return null;
    } finally {
      this.shelfReading = null;
    }
  },

  /** Start a read in the background unless one is going or the last failed too recently. Never throws. No awaits. */
  shelfRefreshSoon(now = Date.now(), callsAtStart = externalCalls.count) {
    try {
      if (!this.shopify?.configured) return;
      if (this.shelfReading) return;
      const next = this.shelfRun('next');
      if (next.failed_at && now - next.failed_at < SHELF.retry) return;
      this.shelfReading = this.later(this.shelfRead(now, callsAtStart)).finally(() => {
        this.shelfReading = null;
      });
    } catch (error) {
      console.error('Lair: could not start the shelf read', error);
    }
  },

  /**
   * Read the shelf from Shopify, a page at a time, carrying on a read the last invocation didn't finish, with at most
   * `cap` calls this invocation (counting from callsAtStart). Swaps the new list in once the last page is read.
   * → { done, pages, rows, error? }
   */
  async shelfRead(now = Date.now(), callsAtStart = externalCalls.count, cap = SHELF.callsPerRun) {
    const location = this.stockOffLocation();
    let next = this.shelfRun('next');
    // a fresh read, unless the last one stopped part-way (its calls ran out) a short while ago: that one carries on
    if (!next.cursor || next.done_at || !next.started_at || now - (next.moved_at || next.started_at) > SHELF.stuck) {
      this.sql.exec("DELETE FROM shelf_stock WHERE run = 'next'");
      this.sql.exec(
        "INSERT INTO shelf_runs (run, started_at, done_at, cursor, pages, failed_at, error) VALUES ('next', ?, NULL, NULL, 0, NULL, NULL) ON CONFLICT(run) DO UPDATE SET started_at = excluded.started_at, moved_at = NULL, done_at = NULL, cursor = NULL, pages = 0, failed_at = NULL, error = NULL",
        now,
      );
      next = this.shelfRun('next');
    }
    let cursor = next.cursor;
    let pages = next.pages;
    let throttles = 0;
    try {
      for (;;) {
        // a login and a page: two calls at most
        if (cap - (externalCalls.count - callsAtStart) < 2) return { done: false, pages, rows: this.shelfCount('next') };
        let page;
        try {
          page = await this.shopify.shelfPage(cursor, location);
        } catch (error) {
          if (!error?.throttled || throttles >= 3) throw error;
          throttles += 1;
          await this.shopify.wait(shopifyPaceWait(error.cost) || 2000);
          continue;
        }
        throttles = 0;
        for (const r of page.rows) {
          this.sql.exec(
            "INSERT INTO shelf_stock (run, variant_id, product_id, handle, stock) VALUES ('next', ?, ?, ?, ?) ON CONFLICT(run, variant_id) DO UPDATE SET product_id = excluded.product_id, handle = excluded.handle, stock = excluded.stock",
            r.variantId, r.productId, r.handle, r.stock,
          );
        }
        pages += 1;
        cursor = page.next;
        this.sql.exec("UPDATE shelf_runs SET cursor = ?, pages = ?, moved_at = ?, failed_at = NULL, error = NULL WHERE run = 'next'", cursor, pages, Date.now());
        if (!cursor) break;
        // pace the next page by what Shopify's bucket has left
        const wait = shopifyPaceWait(this.shopify.lastCost);
        if (wait) await this.shopify.wait(wait);
      }
      // the whole list: it becomes the one picks come from
      const done = Date.now();
      this.sql.exec("DELETE FROM shelf_stock WHERE run = 'live'");
      this.sql.exec("UPDATE shelf_stock SET run = 'live' WHERE run = 'next'");
      this.sql.exec(
        "INSERT INTO shelf_runs (run, started_at, done_at, cursor, pages) VALUES ('live', ?, ?, NULL, ?) ON CONFLICT(run) DO UPDATE SET started_at = excluded.started_at, done_at = excluded.done_at, cursor = NULL, pages = excluded.pages, failed_at = NULL, error = NULL",
        next.started_at, done, pages,
      );
      this.sql.exec("UPDATE shelf_runs SET done_at = ?, cursor = NULL WHERE run = 'next'", done);
      this.shelfCache = null;
      return { done: true, pages, rows: this.shelfCount('live') };
    } catch (error) {
      const message = String(error?.message || error).slice(0, 300);
      this.sql.exec("UPDATE shelf_runs SET failed_at = ?, error = ? WHERE run = 'next'", Date.now(), message);
      console.error('Lair: the shelf read failed', error);
      return { done: false, pages, rows: this.shelfCount('next'), error: message };
    }
  },

  /** How many variants a run's list holds. No awaits. */
  shelfCount(run) {
    return this.sql.exec('SELECT COUNT(*) AS n FROM shelf_stock WHERE run = ?', run).one().n;
  },
};

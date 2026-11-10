/**
 * Round 34 (10 Nov 2026, contract v34-gw-pictures): Games Workshop's own pictures on the pad's products, and those
 * products online. Mo (10 Nov 2026): "please create a full product list with images and information for my customers to
 * order". Round 26 makes every line on GW's order pad a product on the till only, because a GW listing goes online only
 * with GW's own picture (trade terms 20.3 and 20.5: the trade site's Resources files, whole and uncropped). This is that
 * later step:
 *  - GW_PICTURES (src/gw-pictures-data.js) is which Resources files show each pad code: the files named with its code,
 *    a repacked kit's files under its short code, a paint pot by its colour in its range. It's made from the trade
 *    site's Resources library and the pad, and checked in, so the Lair never fetches the trade site itself.
 *  - The alarm's upkeep (src/shop-filters.js) runs gwPicturesUpkeep with what's left of its invocation's calls: it looks
 *    up a slice of codes in Shopify, adds the pictures to products with none (a paint colour's pot to its variant), and
 *    once Shopify has fetched a product's picture (READY) puts it on the Online Store and the Shop app. A picture
 *    Shopify couldn't fetch is deleted and the product stays on the till.
 *  - A product that already has pictures is left as it is, and so is its channels. A code with no product yet is looked
 *    for again a day later (a later pad may add it).
 *
 * Methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { GW_PICTURES } from './gw-pictures-data.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const GID = /^gid:\/\/shopify\/\w+\/\d+$/;

export const PICTURE_LIMITS = {
  // codes one Shopify lookup asks about, products one request gives pictures, products one status check asks about
  find: 50, add: 20, check: 25,
  // a picture is looked at this long after it was sent (Shopify fetches it from the trade site in the meantime)
  checkAfter: 2 * MIN,
  // still not fetched after this long: given up on, so the product stays on the till
  giveUpAfter: 6 * 60 * MIN,
  // a code with no product yet is looked for again this long after
  missingAgain: DAY,
};

const ASSETS = 'https://trade.games-workshop.com/assets/';
/**
 * A picture's address: a Resources file's path as the trade site names it (spaces and all), or, for a pad line with no
 * Resources file, GW's own picture where another stockist shows it, as its whole https address (Mo, 10 Nov 2026)
 */
export const pictureUrl = (path) => (/^https:\/\//.test(String(path)) ? String(path) : ASSETS + String(path).split('/').map(encodeURIComponent).join('/'));

export const GW_PICTURE_TABLES = [
  `CREATE TABLE IF NOT EXISTS gw_pictures (
    code TEXT PRIMARY KEY, status TEXT NOT NULL, product_id TEXT, variant_id TEXT, is_range INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL, sent_at INTEGER, live_at INTEGER, error TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS gw_pictures_status ON gw_pictures (status, at)',
];

/** The pictures for a code (paths), or [] */
export const picturesFor = (code) => (Array.isArray(GW_PICTURES[code]) ? GW_PICTURES[code] : []);

export const gwPictureMethods = {
  /** The Online Store's and Shop app's publications (wrangler.toml), or null when either is missing. No awaits. */
  gwOnlineIds() {
    const gid = (v) => {
      const text = String(v ?? '').trim();
      if (!text) return null;
      return text.startsWith('gid://') ? text : `gid://shopify/Publication/${text}`;
    };
    const online = gid(this.env?.GW_ONLINE_PUBLICATION_ID);
    const shop = gid(this.env?.GW_SHOP_PUBLICATION_ID);
    return online && shop ? [online, shop] : null;
  },

  /** Codes not looked up yet (or with no product last time, a day on), up to n. No awaits. */
  gwPictureCodesToFind(now, n) {
    const known = new Map(this.sql.exec('SELECT code, status, at FROM gw_pictures').toArray().map((r) => [r.code, r]));
    const out = [];
    for (const code of Object.keys(GW_PICTURES)) {
      const row = known.get(code);
      if (!row || (row.status === 'missing' && row.at <= now - PICTURE_LIMITS.missingAgain)) out.push(code);
      if (out.length >= n) break;
    }
    return out;
  },

  /** Record a code's state. No awaits. */
  gwPictureMark(code, status, now, extra = {}) {
    this.write(
      `INSERT INTO gw_pictures (code, status, product_id, variant_id, is_range, at, sent_at, live_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET status = excluded.status, product_id = COALESCE(excluded.product_id, product_id),
         variant_id = COALESCE(excluded.variant_id, variant_id), is_range = excluded.is_range, at = excluded.at,
         sent_at = COALESCE(excluded.sent_at, sent_at), live_at = COALESCE(excluded.live_at, live_at), error = excluded.error`,
      code, status, extra.productId || null, extra.variantId || null, extra.range ? 1 : 0, now, extra.sentAt || null, extra.liveAt || null, extra.error || null,
    );
  },

  /**
   * One slice of the work with the invocation's calls (budget, src/shop-filters.js's callBudget): look up codes, add
   * pictures, check the ones sent, put the fetched ones online. → { found, added, live, failed, left } or null when
   * there was nothing to do. Throws only when Shopify can't be reached (the upkeep counts it as a failure and backs off).
   */
  async gwPicturesUpkeep(now = Date.now(), budget) {
    const pubs = this.gwOnlineIds();
    if (!pubs || !this.shopify?.configured || !this.shopify.gwPictureTargets) return null;
    const out = { found: 0, added: 0, live: 0, failed: 0 };
    // 1. Look up a slice of codes: what product and variant each is, and whether it already has a picture
    const codes = this.gwPictureCodesToFind(now, PICTURE_LIMITS.find);
    const toAdd = [];
    if (codes.length && budget.has(1)) {
      const targets = await this.shopify.gwPictureTargets(codes);
      for (const code of codes) {
        const t = targets.get(code);
        if (!t) {
          this.gwPictureMark(code, 'missing', now);
          continue;
        }
        out.found += 1;
        const range = t.variants > 1;
        const has = range ? t.variantMedia > 0 : t.productMedia > 0;
        if (has) this.gwPictureMark(code, 'had', now, { productId: t.productId, variantId: t.variantId, range });
        else toAdd.push({ code, productId: t.productId, variantId: t.variantId, range, title: t.title });
      }
    }
    // 2. Add them: whole products a request at a time, a paint range's colours on their variants
    const singles = toAdd.filter((t) => !t.range);
    for (let i = 0; i < singles.length; i += PICTURE_LIMITS.add) {
      if (!budget.has(1)) break;
      const part = singles.slice(i, i + PICTURE_LIMITS.add);
      const results = await this.shopify.gwAddPictures(part.map((t) => ({ productId: t.productId, urls: picturesFor(t.code).map(pictureUrl), alt: t.title })));
      part.forEach((t, k) => {
        const r = results[k];
        if (r?.error) this.gwPictureMark(t.code, 'failed', now, { productId: t.productId, error: String(r.error.message || r.error).slice(0, 300) });
        else {
          this.gwPictureMark(t.code, 'sent', now, { productId: t.productId, sentAt: now });
          out.added += 1;
        }
      });
    }
    const byRange = new Map();
    for (const t of toAdd.filter((x) => x.range)) {
      if (!byRange.has(t.productId)) byRange.set(t.productId, []);
      byRange.get(t.productId).push(t);
    }
    for (const [productId, list] of byRange) {
      if (!budget.has(1)) break;
      const r = await this.shopify.gwAddVariantPictures(productId, list.map((t) => ({ variantId: t.variantId, url: pictureUrl(picturesFor(t.code)[0]) })));
      for (const t of list) {
        if (r?.error) this.gwPictureMark(t.code, 'failed', now, { productId, variantId: t.variantId, range: true, error: String(r.error.message || r.error).slice(0, 300) });
        else {
          this.gwPictureMark(t.code, 'sent', now, { productId, variantId: t.variantId, range: true, sentAt: now });
          out.added += 1;
        }
      }
    }
    // 3. Pictures sent a little while ago: fetched (READY) puts the product online; failed ones are deleted
    const due = this.sql.exec(
      "SELECT DISTINCT product_id FROM gw_pictures WHERE status = 'sent' AND sent_at <= ? AND product_id IS NOT NULL ORDER BY sent_at LIMIT ?",
      now - PICTURE_LIMITS.checkAfter, PICTURE_LIMITS.check,
    ).toArray().map((r) => r.product_id).filter((id) => GID.test(id));
    if (due.length && budget.has(1)) {
      const status = await this.shopify.gwPictureStatus(due);
      const ready = [];
      const dead = [];
      for (const productId of due) {
        const s = status.get(productId) || { ready: 0, failed: [], waiting: 0 };
        if (s.ready > 0) ready.push(productId);
        if (s.failed.length) dead.push(...s.failed);
        if (!s.ready && !s.waiting) {
          // nothing fetched and nothing still coming: it stays on the till
          this.write("UPDATE gw_pictures SET status = 'failed', at = ?, error = ? WHERE product_id = ? AND status = 'sent'", now, "Shopify couldn't fetch GW's picture.", productId);
          out.failed += 1;
        } else if (!s.ready) {
          this.write(
            "UPDATE gw_pictures SET status = 'failed', at = ?, error = ? WHERE product_id = ? AND status = 'sent' AND sent_at <= ?",
            now, "Shopify still hadn't fetched GW's picture.", productId, now - PICTURE_LIMITS.giveUpAfter,
          );
        }
      }
      if (dead.length && budget.has(1)) await this.shopify.gwDeleteFiles(dead);
      if (ready.length && budget.has(pubs.length)) {
        const ok = new Set(ready);
        for (const pub of pubs) {
          for (const r of await this.shopify.gwPublish(ready, pub)) if (r.error) ok.delete(r.productId);
        }
        for (const productId of ready) {
          if (!ok.has(productId)) continue;
          this.write("UPDATE gw_pictures SET status = 'live', live_at = ?, at = ? WHERE product_id = ? AND status = 'sent'", now, now, productId);
          out.live += 1;
        }
      }
    }
    const findLeft = this.gwPictureCodesToFind(now, 1).length;
    const sentLeft = this.sql.exec("SELECT COUNT(*) AS n FROM gw_pictures WHERE status = 'sent'").one().n;
    out.left = findLeft + sentLeft;
    if (!codes.length && !toAdd.length && !due.length) return out.left ? { left: out.left } : null;
    return out;
  },

  /** Where the pictures stand (GET /gw/pictures, owner only): counts by state, and the codes that couldn't be shown. No awaits. */
  gwPicturesView() {
    const counts = Object.fromEntries(this.sql.exec('SELECT status, COUNT(*) AS n FROM gw_pictures GROUP BY status').toArray().map((r) => [r.status, r.n]));
    const failed = this.sql.exec("SELECT code, product_id AS productId, error FROM gw_pictures WHERE status = 'failed' ORDER BY code LIMIT 200").toArray();
    return { codes: Object.keys(GW_PICTURES).length, counts, failed };
  },
};

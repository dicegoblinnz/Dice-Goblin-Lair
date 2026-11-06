/**
 * Round 31 (retail, contract v31-retail section 2): back on the shelf. Mo's plan: "Members keep a wishlist, and anything
 * on it that comes back in stock gets them an email, regulars a day before everyone else." Mockup T-email, Mo's picks of
 * 6 Nov 2026.
 *
 * - Every 10 minutes (retailUpkeep, from the Lair's maintenance) wishStockCheck reads the Lair's own count of every
 *   option on someone's wishlist (any-option entries: every option of the product) and keeps it in wish_stock. An option
 *   that goes from off the shelf (0 or below) to on it is back; the first read of an option only records it.
 * - wishQueueAlerts makes one wish_alerts row per member, product and return: regulars (as Monday's numbers count them)
 *   due straight away, everyone else OTHERS_WAIT later. Only entries made before it came back count.
 * - wishSendDue sends the ones due, 9am to 9pm at the Lair, at most WISH_ALERTS_A_RUN a run: never when it's off the shelf
 *   again by then (they wait for the next time), the product's no longer sold online, the member switched these off,
 *   or they've unsubscribed (the Lair's stop list or Shopify's setting) since the entry was made. Every await first, then
 *   the claim (sent_at and the key) and the send; a send Resend turns away is unclaimed for the next run.
 * - The email's "Don't send me emails like this" (/pages/my-lair#unsubscribe=WISH-<id>.<key>, and the one-click header
 *   on the Lair's own /unsubscribe/WISH-<id>/<key>) goes through wishUnsubscribe*: the email joins round 29's stop list
 *   (followup_stops, then Shopify, as round 29's pushStopsToShopify does) and the member's wishlist emails switch off.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { HOUR, LairTime, MIN, RuleError } from './core.js';
import { emailReady, safeEqual } from './shopify.js';
import { REMIND_FROM_HOUR, REMIND_UNTIL_HOUR } from './reminders.js';
import { CANCEL_TRIES } from './booking-reminders.js';
import { UNSUBSCRIBE_WORDS } from './first-game.js';
import { PRODUCT_PAGE, STOCK_PAGE } from './retail.js';

/** Everyone who isn't a regular hears this long after the regulars */
export const OTHERS_WAIT = 24 * HOUR;
/** Emails sent in one run, at most */
export const WISH_ALERTS_A_RUN = 100;
/** Options and products read in one run, at most (each request takes STOCK_PAGE options or PRODUCT_PAGE products) */
export const WISH_STOCK_A_RUN = 500;
export const WISH_PRODUCTS_A_RUN = 40;
/** Option names that only say the pack size, so the email names the product instead ("Riftbound Radiance is back…") */
const PACK_SIZES = /^(?:booster box|booster pack|booster|pack|box|display|bundle|single|case|default title)$/i;
/** The links' tags (the emails skill: utm_source is which email, utm_campaign the topic) */
const TAGS = 'utm_source=back-in-stock&utm_medium=email&utm_campaign=shop';
/** Wrong unsubscribe links from one place in this time, CANCEL_TRIES of them, before it's asked to wait */
const STOP_TRIES_WINDOW = 10 * MIN;
const NO_KEY = '0'.repeat(32);

/** Everything the email says, word for word in the contract (Gobgob signs it) */
export const WISH_WORDS = {
  subject: (label) => (`${label} is back on the shelf`.length <= 50 ? `${label} is back on the shelf` : cutAt(`Back on the shelf: ${label}`, 50)),
  preheader: (title, price, regular) => `${title}${price ? `, ${price}` : ''}. ${regular ? "You're hearing a day before everyone else." : 'On the shelf at the Lair now.'}`,
  title: (label) => `${label} is back`,
  intro: (several) => `You asked Gobgob to keep an eye out. ${several ? 'These are' : "It's"} back on the shelf at the Lair.`,
  onShelf: 'On the shelf at the Lair',
  fewLeft: (n) => `Only ${n} left at the Lair`,
  regular: "You're a regular, so you're hearing first. Everyone else hears tomorrow.",
  buy: 'Buy it online',
  collect: 'Collect it free at the Lair, or have it delivered for $10.',
  openToday: 'Open today',
  where: 'Where',
  whereWords: 'Upstairs in Royal Oak Mall, above Whitcoulls',
  why: (label) => `You're getting this because ${label} is on your wishlist.`,
  unsubscribe: "Don't send me emails like this",
};

/** text cut to at most n characters, on a word, with "…" */
function cutAt(text, n) {
  if (text.length <= n) return text;
  const cut = text.slice(0, n - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > n / 2 ? cut.slice(0, space) : cut).replace(/[\s:,-]+$/, '')}…`;
}
const lowerEmail = (email) => String(email || '').trim().toLowerCase();
const parse = (text, fallback) => {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) ?? fallback;
  } catch {
    return fallback;
  }
};
const money = (c) => (c === null || c === undefined ? '' : `$${(c / 100).toFixed(2)}`);
const newKey = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** What a wishlist entry's option is called in the email: its own name, unless that's only a pack size */
export function wishLabel(stock) {
  const option = String(stock?.variant_title || '').trim();
  if (option && (Number(stock?.options) || 0) > 1 && !PACK_SIZES.test(option)) return option;
  return String(stock?.title || '').trim() || 'Something on your wishlist';
}

export const wishAlertMethods = {
  /**
   * What the Lair's last check found for one wishlist row ({ product_id, variant_id }): { image, price, url, status,
   * shelf, supplier }, all null when it hasn't been checked yet. An any-option row: on the shelf when any option is
   * (shelf is then their total), its lowest price. No awaits.
   */
  wishItemStock(row) {
    const rows = row.variant_id
      ? this.sql.exec('SELECT * FROM wish_stock WHERE variant_id = ?', String(row.variant_id)).toArray()
      : this.sql.exec('SELECT * FROM wish_stock WHERE product_id = ?', String(row.product_id)).toArray();
    if (!rows.length) return { image: null, price: null, url: null, status: null, shelf: null, supplier: false };
    const first = rows[0];
    const prices = rows.map((r) => r.price).filter((p) => p !== null && p !== undefined);
    const onShelf = rows.filter((r) => r.on_shelf);
    const sold = rows.some((r) => r.sold);
    const sellable = rows.some((r) => r.sold && r.sellable);
    const status = !sold ? 'gone' : onShelf.length ? 'shelf' : sellable ? 'away' : 'out';
    const shelves = rows.map((r) => r.shelf).filter((n) => Number.isFinite(n));
    return {
      image: first.image || null,
      price: prices.length ? Math.min(...prices) : null,
      url: first.handle ? `/products/${first.handle}${row.variant_id ? `?variant=${row.variant_id}` : ''}` : null,
      status,
      shelf: shelves.length ? shelves.reduce((a, b) => a + Math.max(0, b), 0) : null,
      supplier: status === 'away' && rows.some((r) => r.supplier && r.sellable),
    };
  },

  /**
   * Reads the Lair's count of what's on wishlists (stalest first, up to WISH_STOCK_A_RUN options and WISH_PRODUCTS_A_RUN
   * any-option products) and keeps it. → { checked, back: [{ variantId, productId }] }: the options that came back on
   * the shelf this time. Every await first, then the writes.
   */
  async wishStockCheck(now) {
    const locationId = this.retailLocationId();
    if (!this.shopify.configured || !locationId) return { checked: 0, back: [] };
    const variantIds = this.sql.exec(
      `SELECT w.variant_id AS id FROM (SELECT DISTINCT variant_id FROM wishlist WHERE variant_id != '') w
        LEFT JOIN wish_stock s ON s.variant_id = w.variant_id ORDER BY COALESCE(s.checked_at, 0) LIMIT ?`,
      WISH_STOCK_A_RUN,
    ).toArray().map((r) => r.id);
    const productIds = this.sql.exec(
      `SELECT w.product_id AS id, MIN(COALESCE(s.checked_at, 0)) AS at FROM (SELECT DISTINCT product_id FROM wishlist WHERE variant_id = '') w
        LEFT JOIN wish_stock s ON s.product_id = w.product_id GROUP BY w.product_id ORDER BY at LIMIT ?`,
      WISH_PRODUCTS_A_RUN,
    ).toArray().map((r) => r.id);
    const api = this.retail();
    const read = [];
    for (let i = 0; i < variantIds.length; i += STOCK_PAGE) read.push(...await api.variantStock(variantIds.slice(i, i + STOCK_PAGE), locationId));
    for (let i = 0; i < productIds.length; i += PRODUCT_PAGE) read.push(...await api.productStock(productIds.slice(i, i + PRODUCT_PAGE), locationId));
    // --- no awaits from here ---
    const back = [];
    const seen = new Set();
    for (const v of read) {
      if (seen.has(v.variantId)) continue;
      seen.add(v.variantId);
      const was = this.sql.exec('SELECT on_shelf FROM wish_stock WHERE variant_id = ?', v.variantId).toArray()[0];
      const onShelf = v.sold && Number.isFinite(v.shelf) && v.shelf > 0 ? 1 : 0;
      const cameBack = Boolean(was) && !was.on_shelf && onShelf === 1;
      if (cameBack) back.push({ variantId: v.variantId, productId: v.productId });
      this.write(
        `INSERT INTO wish_stock (variant_id, product_id, shelf, on_shelf, sellable, supplier, sold, price, title, variant_title, handle, image, options, back_at, checked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
          ON CONFLICT (variant_id) DO UPDATE SET product_id = excluded.product_id, shelf = excluded.shelf, on_shelf = excluded.on_shelf,
            sellable = excluded.sellable, supplier = excluded.supplier, sold = excluded.sold, price = excluded.price, title = excluded.title,
            variant_title = excluded.variant_title, handle = excluded.handle, image = excluded.image, options = excluded.options,
            back_at = CASE WHEN ? THEN ? ELSE wish_stock.back_at END, checked_at = excluded.checked_at`,
        v.variantId, v.productId, v.shelf, onShelf, v.sellable ? 1 : 0, v.supplier ? 1 : 0, v.sold ? 1 : 0, v.price, v.title, v.variantTitle,
        v.handle, v.image, v.options, now, cameBack ? 1 : 0, now,
      );
    }
    // asked about and not answered: deleted in Shopify, so no longer sold
    for (const id of variantIds) {
      if (!seen.has(String(id))) this.write('UPDATE wish_stock SET sold = 0, on_shelf = 0, checked_at = ? WHERE variant_id = ?', now, String(id));
    }
    return { checked: seen.size, back };
  },

  /**
   * One wish_alerts row per member and product for what came back (back: [{ variantId, productId }]), from the
   * entries made before now: regulars due now, everyone else OTHERS_WAIT later; a member who switched these off is
   * recorded as skipped ('off'). The same return never makes two (its key). → how many were made. No awaits.
   */
  wishQueueAlerts(rules, back, now) {
    if (!back.length) return 0;
    const regulars = this.regularIdsAt(rules, now);
    const byProduct = new Map();
    for (const b of back) {
      if (!byProduct.has(b.productId)) byProduct.set(b.productId, new Set());
      byProduct.get(b.productId).add(b.variantId);
    }
    let made = 0;
    for (const [productId, variants] of byProduct) {
      const wanted = new Map();
      const rows = this.sql.exec('SELECT customer_id, variant_id, asked_at FROM wishlist WHERE product_id = ? AND created_at < ?', productId, now).toArray();
      for (const r of rows) {
        const these = r.variant_id ? (variants.has(r.variant_id) ? [r.variant_id] : []) : [...variants];
        if (!these.length) continue;
        // with the switch off, only what they asked for since (Tell me when it's back)
        const prefs = this.wishPrefs(r.customer_id);
        if (!prefs.on && !(r.asked_at != null && r.asked_at >= prefs.at)) {
          if (!wanted.has(r.customer_id)) wanted.set(r.customer_id, new Set());
          continue;
        }
        if (!wanted.has(r.customer_id)) wanted.set(r.customer_id, new Set());
        for (const v of these) wanted.get(r.customer_id).add(v);
      }
      for (const [customerId, asked] of wanted) {
        const regular = regulars.has(String(customerId));
        const off = !asked.size;
        const these = off ? new Set(rows.filter((r) => r.customer_id === customerId).flatMap((r) => (r.variant_id ? [r.variant_id] : [...variants])).filter((v) => variants.has(v))) : asked;
        this.write(
          `INSERT OR IGNORE INTO wish_alerts (customer_id, product_id, back_at, variants, regular, due_at, created_at, skipped)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          String(customerId), productId, now, JSON.stringify([...these].sort()), regular ? 1 : 0, regular ? now : now + OTHERS_WAIT, now, off ? 'off' : null,
        );
        if (this.retailChanged()) made += 1;
      }
    }
    return made;
  },

  /**
   * The emails due at `now` (9am to 9pm at the Lair), at most WISH_ALERTS_A_RUN, regulars first. → { sent, skipped } or
   * null outside those hours or with nothing due. Every await first (Shopify's marketing setting for each email), then
   * one synchronous pass that decides, claims and builds; then the send, unclaiming anything Resend turned away.
   */
  async wishSendDue(rules, now) {
    if (!emailReady(this.env)) return null;
    const time = new LairTime(rules.tz);
    const hour = Math.floor(time.minutesOf(now) / 60);
    if (hour < REMIND_FROM_HOUR || hour >= REMIND_UNTIL_HOUR) return null;
    const due = this.sql.exec(
      'SELECT * FROM wish_alerts WHERE sent_at IS NULL AND skipped IS NULL AND due_at <= ? ORDER BY regular DESC, due_at, id LIMIT ?',
      now, WISH_ALERTS_A_RUN,
    ).toArray();
    if (!due.length) return null;
    // Shopify's email marketing setting, once per email (an email it can't answer for waits for the next run)
    const marketing = new Map();
    if (this.shopify.configured) {
      for (const a of due) {
        const email = lowerEmail(this.memberRow(a.customer_id)?.email);
        if (!email || marketing.has(email)) continue;
        try {
          marketing.set(email, await this.shopify.marketingByEmail(email));
        } catch (error) {
          console.error('Lair: could not read email marketing settings from Shopify', error);
          marketing.set(email, undefined);
        }
      }
    }
    // --- no awaits from here until the send ---
    const skip = (a, why) => this.write('UPDATE wish_alerts SET skipped = ? WHERE id = ? AND sent_at IS NULL AND skipped IS NULL', why, a.id);
    const messages = [];
    const claimed = [];
    let skipped = 0;
    for (const a of due) {
      const member = this.memberRow(a.customer_id);
      const email = lowerEmail(member?.email);
      if (!email || !email.includes('@')) {
        skip(a, 'no-email');
        skipped += 1;
        continue;
      }
      if (this.shopify.configured && marketing.get(email) === undefined) continue;
      const all = parse(a.variants, []).map(String);
      const entries = this.sql.exec('SELECT variant_id, created_at, asked_at FROM wishlist WHERE customer_id = ? AND product_id = ?', a.customer_id, a.product_id).toArray()
        .filter((r) => !r.variant_id || all.includes(r.variant_id));
      // with the switch off, only the options they asked for since (Tell me when it's back: the review)
      const prefs = this.wishPrefs(a.customer_id);
      const use = prefs.on ? entries : entries.filter((r) => r.asked_at != null && r.asked_at >= prefs.at);
      const variants = prefs.on ? all : all.filter((v) => use.some((r) => !r.variant_id || r.variant_id === v));
      const stock = variants.map((v) => this.sql.exec('SELECT * FROM wish_stock WHERE variant_id = ?', v).toArray()[0]).filter(Boolean);
      const still = stock.filter((s) => s.sold && s.on_shelf);
      // a wish, or a Tell me, made after an unsubscribe is a fresh request for this email
      const made = Math.max(0, ...use.map((r) => Math.max(r.created_at, Number(r.asked_at) || 0)));
      const stop = this.sql.exec('SELECT at FROM followup_stops WHERE email = ?', email).toArray()[0];
      const m = marketing.get(email);
      let why = null;
      if (!entries.length) why = 'removed';
      else if (!use.length) why = 'off';
      else if (!stock.some((s) => s.sold)) why = 'gone';
      else if (!still.length) why = 'sold-out';
      else if (stop && stop.at >= made) why = 'stopped';
      else if (m && (m.state === 'INVALID' || m.state === 'REDACTED' || (m.state === 'UNSUBSCRIBED' && (m.at ?? Infinity) >= made))) why = 'shopify';
      if (why) {
        skip(a, why);
        skipped += 1;
        continue;
      }
      const key = newKey();
      this.write('UPDATE wish_alerts SET sent_at = ?, email = ?, key = ? WHERE id = ? AND sent_at IS NULL AND skipped IS NULL', now, email, key, a.id);
      if (!this.retailChanged()) continue;
      for (const r of use) this.write('UPDATE wishlist SET told_at = ? WHERE customer_id = ? AND product_id = ? AND variant_id = ?', now, a.customer_id, a.product_id, r.variant_id);
      claimed.push(a.id);
      messages.push(this.wishAlertMail({ ...a, key, email }, still, rules, now, member));
    }
    if (!messages.length) return skipped ? { sent: 0, skipped } : null;
    const result = await this.mailMany(messages);
    if (!result.ok) {
      for (const id of claimed) this.write('UPDATE wish_alerts SET sent_at = NULL, key = NULL WHERE id = ?', id);
      return { sent: 0, skipped, failed: claimed.length };
    }
    return { sent: claimed.length, skipped };
  },

  /** One back-on-the-shelf email (contract v31-retail section 2), for the options still on the shelf. No awaits. */
  wishAlertMail(a, still, rules, now, member) {
    const several = still.length > 1;
    const first = still[0];
    const label = wishLabel(first);
    const regular = Boolean(a.regular);
    const tag = (path) => `${this.link(path)}${path.includes('?') ? '&' : '?'}${TAGS}`;
    const page = (s) => `/products/${s.handle}${(Number(s.options) || 0) > 1 ? `?variant=${s.variant_id}` : ''}`;
    const cards = still.map((s) => ({
      title: (Number(s.options) || 0) > 1 && s.variant_title ? `${s.title}: ${s.variant_title}` : s.title,
      image: s.image || null,
      url: tag(page(s)),
      lines: [`${money(s.price)} · ${s.shelf >= 1 && s.shelf <= 3 ? WISH_WORDS.fewLeft(s.shelf) : WISH_WORDS.onShelf}`],
    }));
    const ref = `WISH-${a.id}`;
    const unsubscribe = {
      label: WISH_WORDS.unsubscribe,
      why: WISH_WORDS.why(label),
      url: `${this.page('myLair')}#unsubscribe=${encodeURIComponent(ref)}.${a.key}`,
    };
    const lair = String(this.env.PUBLIC_URL || '').replace(/\/$/, '');
    const extra = lair ? { headers: { 'List-Unsubscribe': `<${lair}/unsubscribe/${encodeURIComponent(ref)}/${a.key}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {};
    return this.letter(a.email, WISH_WORDS.subject(label), {
      title: WISH_WORDS.title(label),
      preheader: WISH_WORDS.preheader(first.title, money(first.price), regular),
      intro: WISH_WORDS.intro(several),
      cards,
      quote: regular ? WISH_WORDS.regular : null,
      button: { label: WISH_WORDS.buy, url: tag(page(first)) },
      outro: WISH_WORDS.collect,
      details: [[WISH_WORDS.openToday, this.retailOpenLine(rules, now)], [WISH_WORDS.where, WISH_WORDS.whereWords]],
      unsubscribe,
    }, extra);
  },

  /* ---------------- "Don't send me emails like this" in a back-on-the-shelf email ---------------- */
  /** Whether an unsubscribe link's code is one of these emails' (WISH-<id>) */
  isWishRef(ref) {
    return /^WISH-\d{1,12}$/.test(String(ref || '').trim());
  },

  /**
   * The email an unsubscribe link is for: its code (WISH-<id>) and key, the key compared in constant time. One answer for
   * a wrong key, a code that isn't one of these emails, and either left out; CANCEL_TRIES of those from one place in 10
   * minutes and it has to wait (as round 29's links). No awaits. → its wish_alerts row
   */
  wishUnsubscribeItem(input, client, now) {
    const where = String(client || '-');
    if (!this.wishStopMisses) this.wishStopMisses = new Map();
    const misses = (this.wishStopMisses.get(where) || []).filter((t) => now - t < STOP_TRIES_WINDOW);
    if (misses.length >= CANCEL_TRIES) throw new RuleError(UNSUBSCRIBE_WORDS.tooMany, 429);
    const ref = typeof input?.ref === 'string' ? input.ref.trim().slice(0, 40) : '';
    const key = typeof input?.key === 'string' ? input.key.trim().slice(0, 64) : '';
    const id = this.isWishRef(ref) ? Number(ref.slice(5)) : null;
    const row = id ? this.sql.exec('SELECT * FROM wish_alerts WHERE id = ?', id).toArray()[0] : null;
    const stored = row?.key || '';
    if (!(safeEqual(key || '-', stored || NO_KEY) && Boolean(stored) && Boolean(key))) {
      misses.push(now);
      if (this.wishStopMisses.size > 2000) this.wishStopMisses.clear();
      this.wishStopMisses.set(where, misses);
      throw new RuleError(UNSUBSCRIBE_WORDS.wrong, 404);
    }
    return row;
  },

  /** POST /unsubscribe/view { ref: 'WISH-<id>', key }: { link: { stopped } }, and nothing else about anyone. No awaits. */
  wishUnsubscribeView(input, client = '') {
    const row = this.wishUnsubscribeItem(input, client, Date.now());
    return { link: { stopped: this.followupStopped(row.email) } };
  },

  /**
   * POST /unsubscribe/stop { ref: 'WISH-<id>', key }: the tap. The email goes on the Lair's stop list straight away (round
   * 29's, so Shopify hears too) and the member's wishlist emails switch off. → { ok, already }. No awaits.
   */
  wishUnsubscribeStop(input, client = '', via = 'link') {
    const now = Date.now();
    const row = this.wishUnsubscribeItem(input, client, now);
    const mail = lowerEmail(row.email);
    const already = this.followupStopped(mail);
    if (mail && !already) {
      this.write('INSERT OR IGNORE INTO followup_stops (email, at, ref, via) VALUES (?, ?, ?, ?)', mail, now, `WISH-${row.id}`, via);
      this.later(this.pushStopsToShopify(now));
    }
    this.write(
      'INSERT INTO wish_prefs (customer_id, alerts_off, updated_at) VALUES (?, 1, ?) ON CONFLICT (customer_id) DO UPDATE SET alerts_off = 1, updated_at = excluded.updated_at',
      row.customer_id, now,
    );
    return { ok: true, already };
  },

  /**
   * The one-click unsubscribe on the Lair's own address for these emails (index.js: /unsubscribe/WISH-<id>/<key>), as
   * round 29's oneClickUnsubscribe: a POST stops it (200, plain words); a GET or HEAD only goes on to the page that asks.
   * body: { ref, key, stop, client }. → a Response.
   */
  wishOneClick(body) {
    const plain = (status, text) => new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    const ref = String(body?.ref || '');
    const key = String(body?.key || '');
    if (!body?.stop) {
      return new Response(null, { status: 303, headers: { Location: `${this.page('myLair')}#unsubscribe=${encodeURIComponent(ref)}.${encodeURIComponent(key)}`, 'Cache-Control': 'no-store' } });
    }
    try {
      this.wishUnsubscribeStop({ ref, key }, body.client || '', 'one-click');
      return plain(200, UNSUBSCRIBE_WORDS.done);
    } catch (error) {
      if (error instanceof RuleError) return plain(error.status, error.message);
      throw error;
    }
  },
};

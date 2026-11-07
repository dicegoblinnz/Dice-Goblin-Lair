// Round 32, the till, part 3: real products, prices and sales (contract docs/contracts/lair-api-contract-v32-till.md,
// section 6).
//
// Mo (6 Nov 2026): "Part 3 please": the shop's real products and prices (the dice deal) and stock, and each sale saved to
// Shopify as a paid order with the member and the basket's lines, paying a booking's line marking it paid as at the
// counter, and stamps. So:
//  - POST /till/product (a barcode or SKU) and POST /till/search (words of a title) find the shop's products in Shopify
//    admin, so the ones sold only at the counter and unlisted ones (the Session product) are found too, each with whether
//    it's in the dice deal and Shopify's stock count.
//  - POST /till/price: what the basket comes to, worked out by Shopify as at checkout (draftOrderCalculate: the shop's
//    prices, the dice deal and GST). Nothing is made.
//  - POST /till/pay (Pay by card, or Pay with cash): today's bookings in the basket are checked in (saved passes apply),
//    and the sale's draft order is made, so its price is fixed before the EFTPOS is charged or the cash counted. One sale
//    waits for its money at a time on each till; a new one lets the last one go.
//  - POST /till/paid: staff, with their own PIN, say they have the money. It's paid from then on, whatever Shopify does
//    next: its draft is made a paid order (tagged lair-till, and card or cash), fulfilled at the shop so stock comes off
//    there, and Shopify emails the member their receipt (its order confirmation). That order's orders/paid webhook does
//    the rest, as for Shopify POS's own sales (src/counter.js tillSale): bookings paid (_booking), tabs paid (_tab),
//    Session stamps, TTRPG seats, session passes and spend. When Shopify can't make the order there and then, the Lair
//    keeps trying (as cash's orders do), the till shows those bookings as paid meanwhile, and staff hear if it never can.
//  - POST /till/pay/cancel: back from paying: the sale and its draft go.
// Store credit and tabs as ways to pay are part 4. Round 33 (contract v33-credit-pay): store credit is in. Paying with it
// (method 'credit', or credit: true with card or cash) takes it off their Shopify store credit at Pay, once the draft has
// fixed the price, with no PIN (Mo: no extra guard on store credit at the till): it covers the sale, and the sale's paid
// there and then; or it covers part, and the rest is confirmed by card or cash as before (expect is what's left). A sale
// let go puts its store credit back on (src/credit-pay.js).
//
// These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair:
// every await first, then synchronous reads, checks and writes.
import { HOUR, LairTime, RuleError, codeKey, makeId, sameBarcode } from './core.js';
import { TILL_ORDER_TAG } from './counter.js';
import { maskEmail } from './till.js';
import { TILL_PEOPLE_WORDS, TILL_UNPAYABLE } from './till-people.js';
import { CREDIT_PAY, CREDIT_PAY_WORDS } from './credit-pay.js';

const MIN = 60_000;
const DAY = 24 * HOUR;

/** The marker on a till sale's draft (and so its order's attributes): the sale's id */
export const TILL_MARKER = '_lair_till';
/**
 * A sale that's waited this long for its money is let go (its draft deleted). Long (the review): the EFTPOS may have taken
 * the money for one still on the pay screen, so it can be confirmed until the till's day is done; the till itself lets a
 * sale go only on Back, a new sale, or staff saying it wasn't paid.
 */
export const TILL_SALE_OPEN_MS = 12 * HOUR;
/** The shop's own location, "Dice Goblin": a till sale is fulfilled there (env TILL_LOCATION_ID can name another) */
export const TILL_SHOP_LOCATION = 'gid://shopify/Location/72250359911';
/** The dice deal's collection, "All dice (buy 2, get the 3rd free)" (env TILL_DICE_COLLECTION can name another) */
export const TILL_DICE_COLLECTION = 'gid://shopify/Collection/491973738599';
/** The most lines a sale, and of one thing */
export const TILL_LINES = 60;
export const TILL_QTY = 99;
/** Cash handed over can't be more than this over the total (a typo, not a tip) */
export const TILL_CASH_OVER = 100_000;
/** Shopify's answers for a barcode are kept this long */
const PRODUCT_MS = 5 * MIN;
/**
 * How long the till waits for Shopify while someone's at the counter (making the sale's draft, and its order): the shop's
 * app proxy gives up on a slow answer, so the Lair answers first, and what's left happens in the background
 */
export const TILL_SHOPIFY_WAIT = 9_000;
// (the review, 8 Nov 2026) how long a Pay's key gives back its sale: a lost answer is asked again within moments
const TILL_KEY_KEPT = 30 * 60_000;
const READY_WAIT = 600;
/** Waits before each try again at a paid sale's order, as cash's: then staff hear */
const ORDER_RETRY = [10 * MIN, 30 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY];
/** A try that never finished (the Worker stopped) is taken over after this */
const STUCK = 15 * MIN;
/** Waits before each try again at fulfilling a sale's order: then it stops, and staff hear */
const FULFIL_RETRY = [10 * MIN, HOUR, 6 * HOUR, DAY, DAY];
/**
 * Shopify refusing for want of the fulfilment scopes (until Mo approves them): tried every 6 hours, never counted as a
 * failure, for up to 14 days, so the sales from before he approves them are fulfilled once he does (the review)
 */
const FULFIL_DENIED = 6 * HOUR;
const FULFIL_DENIED_FOR = 14 * DAY;
/** Orders and fulfilments looked after a run, so a run stays short */
const A_RUN = 10;
/** A paid sale's bookings show as paid at the till until its order has paid them (or this long) */
const PENDING_MS = 2 * DAY;

/** The tables (made when missing, in lair.js's migrate) */
export const TILL_SALE_TABLES = [
  `CREATE TABLE IF NOT EXISTS till_sales (
    id TEXT PRIMARY KEY, till TEXT NOT NULL, customer_id TEXT, method TEXT NOT NULL, status TEXT NOT NULL, lines TEXT NOT NULL,
    refs TEXT NOT NULL DEFAULT '[]', tabs TEXT NOT NULL DEFAULT '[]', subtotal INTEGER, total INTEGER, gst INTEGER, discounts TEXT, shown TEXT,
    draft_id TEXT, started_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER, paid_at INTEGER, by TEXT, by_name TEXT, handed INTEGER,
    change_given INTEGER, ended_at INTEGER, ended_why TEXT, order_status TEXT, order_tries INTEGER NOT NULL DEFAULT 0, order_next_at INTEGER,
    order_id TEXT, order_name TEXT, order_total INTEGER, order_error TEXT, fulfil_status TEXT, fulfil_tries INTEGER NOT NULL DEFAULT 0,
    fulfil_next_at INTEGER, fulfil_error TEXT)`,
  'CREATE INDEX IF NOT EXISTS till_sales_till ON till_sales (till, status)',
  'CREATE INDEX IF NOT EXISTS till_sales_status ON till_sales (status, created_at)',
  'CREATE INDEX IF NOT EXISTS till_sales_order ON till_sales (order_status, order_next_at)',
  'CREATE INDEX IF NOT EXISTS till_sales_fulfil ON till_sales (fulfil_status, fulfil_next_at)',
];

/** Every message the till shows from here, word for word in the contract */
export const TILL_SALE_WORDS = {
  code: 'Scan the barcode, or type the code under it.',
  noProduct: "Gobgob can't find that in the shop. Search for it by name instead.",
  notForSale: "That one isn't for sale at the till.",
  giftCard: 'Gift cards are sold on Shopify POS for now: the till sells them once Shopify lets the Lair app issue them.',
  library: "That's one of our library games, so it isn't for sale.",
  search: 'Type at least 2 letters to search.',
  shopify: "Shopify didn't answer. Try again in a moment.",
  empty: "There's nothing in the basket yet.",
  lines: "Something in the basket didn't look right. Take it out and add it again.",
  tooMany: "That's a lot for one sale. Split it into two.",
  booking: (code) => `${code} isn't one Gobgob knows. Scan their code again.`,
  nothingDue: (code) => `${code} has nothing left to pay. Scan their code again.`,
  paidElsewhere: (what) => `${what} was paid another way while this sale waited, so this sale wasn't saved. Tap Back to see what's left to pay; if the EFTPOS took this one already, refund the difference there.`,
  tab: 'Their tab has changed. Scan their code again.',
  method: 'Pay by card, with cash or with store credit.',
  refused: (why) => `Shopify wouldn't take this sale: ${why}`,
  noSale: "That sale isn't here any more. Tap Pay again.",
  gone: "That sale was let go before it was confirmed, so it wasn't saved. If the EFTPOS took the money, ring it up again and confirm it without charging again.",
  making: 'That sale is still being set up. Give it a moment, then try again.',
  // (the review, 8 Nov 2026) the till's key for a Pay
  key: "That didn't come through properly. Tap Pay again.",
  paid: "That sale's paid already.",
  expect: (total) => `This sale is ${dollars(total)}. Check that's what was paid, then confirm again.`,
  cash: 'Approving cash is for staff with Check-in or Money, or the owner.',
  handed: (total) => `Type how much cash they handed over: ${dollars(total)} or more.`,
};

/* ---------- small helpers ---------- */
const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
const dollars = (cents) => `$${(Math.round(Number(cents) || 0) / 100).toFixed(2)}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (error) => String(error?.message || error).slice(0, 300);

/** A product the till sells: active or unlisted, not a gift card, not a library copy */
export function tillSellable(product) {
  return ['ACTIVE', 'UNLISTED'].includes(product?.status) && !product.giftCard && !/\(library\)/i.test(product.title || '');
}

/** A variant as the till shows it: { id, title, price, sku, available, stock } (available: Shopify would sell one now) */
export function tillVariantView(v) {
  return { id: String(v.id), title: v.title || 'Default Title', price: v.price, sku: v.sku || null, available: !v.tracked || v.oversell || (v.stock ?? 0) > 0, stock: v.stock };
}

/** A product as the till shows it: { id, title, type, vendor, dice, variants } */
export function tillProductView(product, variants) {
  return { id: String(product.id), title: product.title, type: product.type || '', vendor: product.vendor || '', dice: Boolean(product.dice), variants: variants.map(tillVariantView) };
}

/** The variant a barcode or SKU is, from Shopify's matches: its barcode first, then its SKU; one for sale first. Or null. */
export function tillPick(matches, code) {
  const list = matches || [];
  const sellableFirst = (hits) => hits.find((m) => tillSellable(m.product)) || hits[0] || null;
  return sellableFirst(list.filter((m) => m.variant.barcodes.some((b) => sameBarcode(b, code)))) || sellableFirst(list.filter((m) => sameBarcode(m.variant.sku, code)));
}

/**
 * The till's basket, checked: products by variant ({ key, variantId, qty }: up to TILL_QTY of each, the same variant
 * twice is one line), bookings by their code ({ key, code }, each once) and tabs by their id. Up to TILL_LINES lines.
 * Anything else is a 400. No awaits.
 */
export function tillBasketIn(list) {
  if (!Array.isArray(list) || !list.length) throw new RuleError(TILL_SALE_WORDS.empty, 400);
  if (list.length > TILL_LINES) throw new RuleError(TILL_SALE_WORDS.tooMany, 400);
  const items = new Map();
  const codes = [];
  const tabs = [];
  for (const raw of list) {
    const key = String(raw?.key ?? '').slice(0, 80);
    if (raw?.tab != null && raw.tab !== '') {
      const id = String(raw.tab).trim();
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new RuleError(TILL_SALE_WORDS.lines, 400);
      if (!tabs.includes(id)) tabs.push(id);
      continue;
    }
    if (raw?.booking != null && raw.booking !== '') {
      const code = String(raw.booking).trim().toUpperCase();
      if (!/^[A-Z0-9+-]{1,40}$/.test(code)) throw new RuleError(TILL_SALE_WORDS.lines, 400);
      if (!codes.some((c) => c.code === code)) codes.push({ key, code });
      continue;
    }
    const variantId = String(raw?.variantId ?? '').trim().replace(/^gid:\/\/shopify\/ProductVariant\//, '');
    const qty = Number(raw?.qty);
    if (!/^\d{1,20}$/.test(variantId) || !Number.isInteger(qty) || qty < 1 || qty > TILL_QTY) throw new RuleError(TILL_SALE_WORDS.lines, 400);
    const have = items.get(variantId);
    if (have) {
      have.qty += qty;
      if (have.qty > TILL_QTY) throw new RuleError(TILL_SALE_WORDS.lines, 400);
    } else {
      items.set(variantId, { key: key || `v:${variantId}`, variantId, qty });
    }
  }
  return { items: [...items.values()], codes, tabs };
}

/**
 * The sale's lines as Shopify priced them, for the till: [{ key, title, qty, unit, total, booking?, tab? }] (unit and
 * total in cents, before discounts: the discounts are their own lines). Each is found by its uuid, or by its place.
 */
export function tillShownLines(lines, figures) {
  const byUuid = new Map((figures?.lines || []).filter((l) => l.uuid).map((l) => [l.uuid, l]));
  const samePlaces = (figures?.lines || []).length === lines.length;
  return lines.map((l, i) => {
    const f = (l.uuid && byUuid.get(l.uuid)) || (samePlaces ? figures.lines[i] : null);
    const qty = f?.qty ?? l.qty ?? 1;
    const unit = f?.unit ?? l.cents ?? 0;
    const title = l.variantId && f ? [f.title, f.variantTitle].filter(Boolean).join(' · ') : l.title || f?.title || '';
    return { key: l.key, title, qty, unit, total: f?.total ?? unit * qty, ...(l.booking ? { booking: l.booking } : {}), ...(l.tab ? { tab: l.tab } : {}) };
  });
}

/** Who can take cash: the owner, or anyone on the till with Check-in or Money */
export function tillTakesCash(person) {
  return Boolean(person) && (person.role === 'owner' || (person.perms || []).some((p) => p === 'checkin' || p === 'money'));
}

export const tillSalesMethods = {
  /* ---------------- reading ---------------- */
  tillSaleRow(id) {
    return id ? this.sql.exec('SELECT * FROM till_sales WHERE id = ?', String(id)).toArray()[0] || null : null;
  },

  /** The location a till sale is fulfilled at, and the dice deal's collection */
  tillShop() {
    return String(this.env?.TILL_LOCATION_ID || '').trim() || TILL_SHOP_LOCATION;
  },
  tillDice() {
    return String(this.env?.TILL_DICE_COLLECTION || '').trim() || TILL_DICE_COLLECTION;
  },

  /** Which till a request is from: the tablet's own id (the till sends one it keeps), or where it came from. No awaits. */
  tillFrom(who, body, client) {
    const own = String(body?.till ?? '').trim();
    return `${who.customerId}|${/^[A-Za-z0-9-]{6,40}$/.test(own) ? own : `ip:${client || ''}`}`;
  },

  /** A member on the sale by customer ID (null for nobody), or a 404. No awaits. */
  tillCustomerIn(value) {
    if (value == null || value === '') return null;
    const id = String(value).trim();
    if (!/^\d{1,20}$/.test(id) || !this.memberRow(id)) throw new RuleError(TILL_PEOPLE_WORDS.noMember, 404);
    return id;
  },

  /**
   * A sale as the till sees it: { id, status, method, total, subtotal, gst, discounts, lines, person, paidAt, by, handed,
   * change, order, saving, receipt }. saving: paid, and its Shopify order still being made. receipt: where Shopify emails
   * the member's receipt (masked). No awaits.
   */
  tillSaleView(r) {
    if (!r) return null;
    const member = r.customer_id ? this.memberRow(r.customer_id) : null;
    const first = member ? member.first_name || String(member.name || '').trim().split(/\s+/)[0] || null : null;
    return {
      id: r.id, status: r.status, method: r.method, total: r.total ?? null, subtotal: r.subtotal ?? null, gst: r.gst ?? null,
      discounts: parse(r.discounts, []), lines: parse(r.shown, []), person: r.customer_id ? { id: String(r.customer_id), first } : null,
      paidAt: r.paid_at || null, by: r.by_name || null, handed: r.handed ?? null, change: r.change_given ?? null,
      // round 33: store credit taken for it, and what's left to pay by card or cash
      credit: r.credit || 0, due: r.total == null ? null : r.total - (r.credit || 0),
      order: r.order_id ? { id: r.order_id, name: r.order_name || null } : null, saving: r.status === 'paid' && r.order_status !== 'made',
      receipt: r.status === 'paid' && member?.email ? maskEmail(member.email) : null,
    };
  },

  /**
   * The codes of bookings a paid till sale is paying, until its order has paid them (its payments are in) or two days
   * have gone: the till shows them as paid meanwhile, so nobody pays twice. No awaits.
   */
  tillPendingRefs(now = Date.now()) {
    const out = new Set();
    const rows = this.sql.exec("SELECT refs, order_id FROM till_sales WHERE status = 'paid' AND paid_at > ? AND refs != '[]'", now - PENDING_MS).toArray();
    for (const r of rows) {
      if (r.order_id && this.sql.exec('SELECT 1 AS n FROM payments WHERE order_id = ? LIMIT 1', r.order_id).toArray().length) continue;
      for (const ref of parse(r.refs, [])) out.add(String(ref).toUpperCase());
    }
    return out;
  },

  /** The tabs a paid till sale is paying, until they're paid (its order's webhook) or two days have gone. No awaits. */
  tillPendingTabs(now = Date.now(), except = null) {
    const out = new Set();
    const rows = this.sql.exec("SELECT id, tabs FROM till_sales WHERE status = 'paid' AND paid_at > ? AND tabs != '[]'", now - PENDING_MS).toArray();
    for (const r of rows) {
      if (r.id === except) continue;
      for (const tab of parse(r.tabs, [])) {
        const t = this.sql.exec('SELECT status FROM tabs WHERE id = ?', String(tab)).toArray()[0];
        if (t && t.status !== 'paid') out.add(String(tab));
      }
    }
    return out;
  },

  /**
   * What a sale waiting for its money pays (its lines' _booking and _tab) that's been paid since Pay: a booking or sign-up
   * with nothing left, cancelled or gone, or being paid by another till sale; a tab paid, gone, or another sale's. → its
   * code ('Their tab' for a tab), or null when everything's still to pay. No awaits.
   */
  tillPaidElsewhere(r, now = Date.now()) {
    const pending = this.tillPendingRefs(now);
    const pendingTabs = this.tillPendingTabs(now, r.id);
    for (const line of parse(r.lines, [])) {
      const ref = line.attributes?._booking ? String(line.attributes._booking).toUpperCase() : null;
      if (ref) {
        const item = this.bookingOrJoin(ref)?.item;
        const left = item && !item.paid && !item.waived ? Math.max(0, (item.amount || 0) - (item.covered || 0) - (item.paidAmount || 0)) : 0;
        if (!item || item.status === 'cancelled' || left <= 0 || pending.has(ref)) return ref;
      }
      const tab = line.attributes?._tab ? String(line.attributes._tab) : null;
      if (tab) {
        const t = this.sql.exec('SELECT status FROM tabs WHERE id = ?', tab).toArray()[0];
        if (!t || t.status === 'paid' || pendingTabs.has(tab)) return 'Their tab';
      }
    }
    return null;
  },

  /** A member's rows at the till: today's, then what they owe from before (as /pos/scan lists them). No awaits. */
  tillRowsOf(customerId, rules, now) {
    const id = String(customerId);
    const { member, today, owed } = this.memberDay(id, rules, now);
    return { member, rows: [...today, ...this.onAccountRows(id, owed), ...this.accountOwedRows(id, rules, now)] };
  },

  /**
   * The basket's bookings as lines to pay: each code found among the member's rows (or by itself: a ticket), with what's
   * left to pay and the very line the counter tile uses (_booking). One with nothing to pay, or being paid by a till sale
   * already (pending), is a 409, or with drop: true left out (dropped: its codes); unknown codes are a 404 (or dropped).
   * → { lines: [{ key, title, cents, attributes, booking, row }], refs, dropped }. No awaits.
   */
  tillOwedLines(codes, customerId, rules, now, pending, { drop = false } = {}) {
    const rows = customerId ? this.tillRowsOf(customerId, rules, now).rows : [];
    const payable = (r) => r.due > 0 && !TILL_UNPAYABLE.includes(r.status);
    const used = new Set();
    const lines = [];
    const refs = [];
    const dropped = [];
    for (const { key, code } of codes) {
      let row = rows.find((r) => String(r.ref || '').toUpperCase() === code && !used.has(r.id) && payable(r)) || null;
      if (!row) {
        const found = this.bookingOrJoin(code);
        row = found ? (found.type === 'join' ? this.joinRow(found.item, { now }) : this.bookingRow(found.item, rules, { now })) : null;
      }
      if (!row) {
        if (drop) {
          dropped.push(code);
          continue;
        }
        throw new RuleError(TILL_SALE_WORDS.booking(code), 404);
      }
      if (!payable(row) || pending.has(code) || used.has(row.id)) {
        if (drop) {
          dropped.push(code);
          continue;
        }
        throw new RuleError(TILL_SALE_WORDS.nothingDue(code), 409);
      }
      used.add(row.id);
      const line = row.line || this.posLine(row, rules);
      lines.push({ key: key || `b:${code}`, title: line.title, cents: row.due, attributes: line.properties || {}, booking: code, row });
      refs.push(String(row.ref || code).toUpperCase());
    }
    return { lines, refs, dropped };
  },

  /**
   * The basket's self-serve tabs: today's tab of the member on the sale (open, or at the counter), all its things at the
   * tab's prices, each tagged _tab, or a 409 when it's changed. → { lines, tabIds }. No awaits.
   */
  tillTabLines(tabs, customerId, rules, now) {
    const lines = [];
    const tabIds = [];
    for (const id of tabs) {
      const tab = customerId ? this.cashTab(customerId, rules, now) : null;
      if (!tab || tab.id !== id || this.tillPendingTabs(now).has(tab.id)) throw new RuleError(TILL_SALE_WORDS.tab, 409);
      parse(tab.items, []).forEach((t, i) => {
        lines.push({ key: `t:${tab.id}:${i}`, variantId: String(t.variantId), qty: Math.max(1, Number(t.qty) || 1), cents: Math.max(0, Number(t.price) || 0), title: t.title || '', attributes: { _tab: tab.id }, tab: tab.id });
      });
      tabIds.push(tab.id);
    }
    return { lines, tabIds };
  },

  /**
   * Check in one of the basket's rows, as the counter tile does when it's scanned (saved passes apply): today's
   * bookings, seats, sign-ups and a named player's game. What's owed from before, a tab and a GM's charge for a seat are
   * only paid. → the check-in's notice, or null. No awaits.
   */
  tillCheckIn(r, rules, now, by) {
    if (!r || r.owed || r.onAccount || ['tab', 'gm-cover', 'gm'].includes(r.kind)) return null;
    let result = null;
    if (r.playerOf && r.player?.id) result = this.checkInPlayer(r.player.id, rules, now, { by });
    else if (r.type === 'join') {
      const join = this.joinById(r.id);
      result = join ? this.checkInJoin(join, rules, now, {}) : null;
    } else {
      const booking = this.booking(r.bookingId || r.id);
      result = booking ? this.checkInBooking(booking, rules, now, { by }) : null;
    }
    return result?.checkedIn && result.notice ? result.notice : null;
  },

  /* ---------------- products ---------------- */
  /**
   * POST /till/product { code } (the tablet's staff account): a barcode or SKU → { product, variant }: the variant whose
   * barcode (in any of its forms), then SKU, it is, with its product (only that variant). Shopify's answers are kept 5
   * minutes. 404 when the shop has none, 422 for a library copy or something not for sale, 503 when Shopify can't say.
   */
  async tillProductFind(body, who) {
    this.tillGate(who);
    const code = String(body?.code ?? '').trim();
    if (!/^[A-Za-z0-9._+-]{1,40}$/.test(code)) throw new RuleError(TILL_SALE_WORDS.code, 400);
    if (this.sql.exec('SELECT 1 AS n FROM library_codes WHERE key = ?', codeKey(code)).toArray().length) throw new RuleError(TILL_SALE_WORDS.library, 422);
    const key = code.toUpperCase();
    if (!this.tillProducts || this.tillProducts.size > 2000) this.tillProducts = new Map();
    const kept = this.tillProducts.get(key);
    let found = kept && Date.now() - kept.at < PRODUCT_MS ? kept.found : undefined;
    if (found === undefined) {
      if (!this.shopify?.configured) throw new RuleError(TILL_SALE_WORDS.shopify, 503);
      try {
        found = tillPick(await this.shopify.tillVariants(code, this.tillDice()), code);
      } catch (error) {
        console.error('Lair: the till could not look a barcode up in Shopify', error);
        throw new RuleError(TILL_SALE_WORDS.shopify, 503);
      }
      this.tillProducts.set(key, { at: Date.now(), found });
    }
    // --- no awaits from here on ---
    if (!found) throw new RuleError(TILL_SALE_WORDS.noProduct, 404);
    if (/\(library\)/i.test(found.product.title || '')) throw new RuleError(TILL_SALE_WORDS.library, 422);
    // (the gift card waits for Shopify to grant gift card permissions, as the till's plan says)
    if (found.product.giftCard) throw new RuleError(TILL_SALE_WORDS.giftCard, 422);
    if (!tillSellable(found.product)) throw new RuleError(TILL_SALE_WORDS.notForSale, 422);
    return { product: tillProductView(found.product, [found.variant]), variant: tillVariantView(found.variant) };
  },

  /**
   * POST /till/search { q } (the tablet's staff account): the shop's products whose title has every word (up to 5) →
   * { products: [tillProductView] }, up to 12, by title: active and unlisted ones, never a library copy or a gift card.
   */
  async tillProductSearch(body, who) {
    this.tillGate(who);
    const words = String(body?.q ?? '')
      .normalize('NFKC')
      .split(/\s+/)
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 30))
      .filter(Boolean)
      .slice(0, 5);
    if (words.join('').length < 2) throw new RuleError(TILL_SALE_WORDS.search, 400);
    if (!this.shopify?.configured) throw new RuleError(TILL_SALE_WORDS.shopify, 503);
    let list;
    try {
      list = await this.shopify.tillSearch(words, this.tillDice());
    } catch (error) {
      console.error('Lair: the till could not search Shopify', error);
      throw new RuleError(TILL_SALE_WORDS.shopify, 503);
    }
    return { products: list.filter(tillSellable).filter((p) => p.variants.length).map((p) => tillProductView(p, p.variants)) };
  },

  /* ---------------- prices ---------------- */
  /**
   * POST /till/price { lines, person? } (the tablet's staff account): what the basket comes to, as Shopify works it out
   * at checkout (the shop's prices, the dice deal, GST), its bookings at what's left to pay and its tab at the tab's
   * prices. Nothing is made or checked in. → { price: { lines, subtotal, discounts, total, gst, taxIncluded }, dropped }
   * (dropped: booking codes with nothing to pay now).
   */
  async tillPriceOf(body, who) {
    this.tillGate(who);
    const basket = tillBasketIn(body?.lines);
    const rules = await this.rules();
    // --- no awaits from here on: the Lair's own lines ---
    const now = Date.now();
    const customerId = this.tillCustomerIn(body?.person);
    const owed = this.tillOwedLines(basket.codes, customerId, rules, now, this.tillPendingRefs(now), { drop: true });
    const tab = this.tillTabLines(basket.tabs, customerId, rules, now);
    const lines = [...basket.items, ...owed.lines.map(({ row, ...l }) => l), ...tab.lines].map((l) => ({ ...l, uuid: crypto.randomUUID() }));
    if (!lines.length) return { price: { lines: [], subtotal: 0, discounts: [], total: 0, gst: 0, taxIncluded: true }, dropped: owed.dropped };
    if (!this.shopify?.configured) throw new RuleError(TILL_SALE_WORDS.shopify, 503);
    let figures;
    try {
      figures = await this.shopify.tillCalculate({ lines, currency: this.env?.CURRENCY || 'NZD' }, { timeout: TILL_SHOPIFY_WAIT });
    } catch (error) {
      if (error?.refused) throw new RuleError(TILL_SALE_WORDS.refused(errorText(error)), 422);
      console.error('Lair: the till could not price a basket with Shopify', error);
      throw new RuleError(TILL_SALE_WORDS.shopify, 503);
    }
    return {
      price: { lines: tillShownLines(lines, figures), subtotal: figures.subtotal, discounts: figures.discounts, total: figures.total, gst: figures.gst, taxIncluded: figures.taxIncluded },
      dropped: owed.dropped,
    };
  },

  /* ---------------- paying ---------------- */
  /**
   * POST /till/pay { lines, person?, method, credit?, token?, till?, key? } (the tablet's staff account; staff on the till
   * or a customer at the counter): start paying. Today's bookings in the basket are checked in (saved passes apply), then
   * the sale's draft order is made: its price, fixed now, is what's taken. The till's sale still waiting for its money is
   * let go. → { sale, dropped, notices } (dropped: booking codes with nothing to pay now, left out: paid another way, or a
   * pass covered them at check-in); { sale: null } when nothing's left to pay. (the review, 8 Nov 2026) key: the till's own
   * for this Pay (8 to 64 letters, numbers, dashes or underscores): asking again with it gives back that sale as it stands
   * (repeated: true), so a lost answer never takes store credit twice; one still being made is a 409 `making`, and one
   * that was let go starts afresh.
   */
  async tillPay(body, who, client = '') {
    this.tillGate(who);
    const method = body?.method;
    if (!['card', 'cash', 'credit'].includes(method)) throw new RuleError(TILL_SALE_WORDS.method, 400);
    const key = body?.key == null || body.key === '' ? null : String(body.key);
    if (key !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new RuleError(TILL_SALE_WORDS.key, 400);
    // round 33: store credit pays all of it ('credit'), or first, with the rest by card or cash (credit: true)
    const useCredit = method === 'credit' || body?.credit === true;
    const basket = tillBasketIn(body?.lines);
    const till = this.tillFrom(who, body, client);
    const customerId = this.tillCustomerIn(body?.person);
    if (useCredit && !customerId) throw new RuleError(CREDIT_PAY_WORDS.tillPerson, 422);
    // (the review) the same Pay asked again (its answer was lost): that sale as it stands
    const repeated = this.tillPayRepeat(key, till, method, customerId);
    if (repeated) return repeated;
    if (useCredit) {
      // (the review) this till's last sale goes now, and their store credit on its way back on (Back, or that sale) lands
      // before their balance is read: paying again straight after Back sees all of it
      const before = Date.now();
      for (const old of this.sql.exec("SELECT * FROM till_sales WHERE till = ? AND status IN ('making', 'open')", till).toArray()) this.tillLetGo(old, 'another sale', before);
      await this.creditPaySettled(customerId);
    }
    const tokenHash = body?.token ? await this.tillTokenHash(body.token) : null;
    const tagged = tokenHash ? await this.tillTagged() : null;
    const rules = await this.rules();
    if (!this.shopify?.configured) throw new RuleError(TILL_SALE_WORDS.shopify, 503);
    // round 33: store credit needs a member on the sale, and their balance, read first
    let balance = null;
    if (useCredit) {
      balance = await this.creditBalanceOrNull(customerId);
      if (balance == null) throw new RuleError(CREDIT_PAY_WORDS.tillOff, 503);
      if (balance <= 0) throw new RuleError(CREDIT_PAY_WORDS.tillNone, 409);
    }
    // --- no awaits from here on: who's paying, check-ins, the lines and the sale ---
    const now = Date.now();
    // (the review) the same key asked again while this one was waiting on the above
    const raced = this.tillPayRepeat(key, till, method, customerId);
    if (raced) return raced;
    const me = tokenHash ? this.tillOn(tokenHash, this.tillTeamFrom(who, tagged)) : null;
    if (useCredit && this.creditPayBusy(customerId)) throw new RuleError(CREDIT_PAY_WORDS.tillBusy, 409);
    const pending = this.tillPendingRefs(now);
    // the bookings as the till showed them, checked in, then read again: one with nothing to pay now (paid another way,
    // or a pass covered it at check-in, on this try or one Shopify didn't finish: the review) is left out and said so.
    // Nothing's been taken yet, so the sale is simply what's left.
    const before = this.tillOwedLines(basket.codes, customerId, rules, now, pending, { drop: true });
    const notices = before.lines.map((l) => this.tillCheckIn(l.row, rules, now, me ? `till:${me.id}` : 'till')).filter(Boolean);
    const owed = this.tillOwedLines(basket.codes, customerId, rules, now, pending, { drop: true });
    const dropped = [...new Set([...before.dropped, ...owed.dropped])];
    const tab = this.tillTabLines(basket.tabs, customerId, rules, now);
    const lines = [...basket.items, ...owed.lines.map(({ row, ...l }) => l), ...tab.lines].map((l) => ({ ...l, uuid: crypto.randomUUID() }));
    for (const old of this.sql.exec("SELECT * FROM till_sales WHERE till = ? AND status IN ('making', 'open')", till).toArray()) this.tillLetGo(old, 'another sale', now);
    if (!lines.length) return { sale: null, dropped, notices };
    const id = makeId('ts');
    this.write(
      `INSERT INTO till_sales (id, till, customer_id, method, status, lines, refs, tabs, started_by, pay_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'making', ?, ?, ?, ?, ?, ?, ?)`,
      id, till, customerId, method, JSON.stringify(lines), JSON.stringify(owed.refs), JSON.stringify(tab.tabIds), me ? me.id : null, key, now, now,
    );
    // its tab can't change in My Lair while it's being paid
    for (const tabId of tab.tabIds) this.write("UPDATE tabs SET status = 'in-cart', updated_at = ? WHERE id = ? AND status IN ('open', 'in-cart')", now, tabId);
    const rest = method === 'card' ? 'by card on the EFTPOS' : 'in cash';
    const how = !useCredit ? rest : method === 'credit' ? 'with store credit' : `with store credit and ${rest}`;
    const note = `Sold on the Lair till, ${how}${me ? `, rung up by ${me.name}` : ''} (${id}).`;
    const tags = [TILL_ORDER_TAG, 'till', method, ...(useCredit && method !== 'credit' ? ['credit'] : []), ...(useCredit ? ['store-credit'] : [])];
    // --- Shopify: the draft, and its figures once it's worked them out ---
    const deadline = Date.now() + TILL_SHOPIFY_WAIT;
    const left = () => Math.max(1000, deadline - Date.now());
    let draft = null;
    try {
      draft = await this.shopify.createTillDraft(
        { customerId, lines, currency: this.env?.CURRENCY || 'NZD', tags, note, marker: { [TILL_MARKER]: id } },
        { timeout: left() },
      );
      while (!draft.ready && Date.now() + READY_WAIT < deadline) {
        await pause(READY_WAIT);
        const now2 = await this.shopify.tillDraft(draft.id, { timeout: left() });
        if (!now2) throw new Error('Its draft order went.');
        draft = { ...now2, id: draft.id };
      }
      if (!draft.ready) throw new Error("Shopify didn't finish working out the price in time.");
    } catch (error) {
      // --- no awaits from here on ---
      const fresh = this.tillSaleRow(id);
      if (fresh && ['making', 'open'].includes(fresh.status)) this.tillLetGo({ ...fresh, draft_id: fresh.draft_id || draft?.id || null }, 'shopify', Date.now());
      else if (draft?.id) this.later(this.shopify.deleteDraftIfOpen(draft.id));
      if (error?.refused) throw new RuleError(TILL_SALE_WORDS.refused(errorText(error)), 422);
      console.error('Lair: the till could not make a sale in Shopify', error);
      throw new RuleError(TILL_SALE_WORDS.shopify, 503);
    }
    // --- no awaits from here on ---
    const fresh = this.tillSaleRow(id);
    if (fresh?.status !== 'making') {
      this.later(this.shopify.deleteDraftIfOpen(draft.id));
      throw new RuleError(TILL_SALE_WORDS.gone, 409);
    }
    const shown = tillShownLines(lines, draft);
    this.write(
      `UPDATE till_sales SET status = 'open', draft_id = ?, subtotal = ?, total = ?, gst = ?, discounts = ?, shown = ?, updated_at = ?
         WHERE id = ? AND status = 'making'`,
      draft.id, draft.subtotal, draft.total, draft.gst, JSON.stringify(draft.discounts), JSON.stringify(shown), Date.now(), id,
    );
    if (useCredit) return this.tillTakeCredit(id, { customerId, balance, method, deadline, me, dropped, notices });
    return { sale: this.tillSaleView(this.tillSaleRow(id)), dropped, notices };
  },

  /**
   * (the review, 8 Nov 2026) Pay asked again with the till's key for it (its answer was lost): the sale as it stands, so
   * nothing is taken twice. A paid one, or an open one with its store credit taken, comes back as it is (repeated: true);
   * one still being made, or still taking store credit, is a 409 (try again in a moment); one that was let go, for
   * someone else or another way to pay, or from more than half an hour ago, starts afresh (null). No awaits.
   */
  tillPayRepeat(key, till, method, customerId) {
    if (!key) return null;
    const r = this.sql.exec('SELECT * FROM till_sales WHERE pay_key = ? AND till = ? AND created_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      key, till, Date.now() - TILL_KEY_KEPT).toArray()[0];
    if (!r || r.status === 'gone' || r.method !== method || String(r.customer_id || '') !== String(customerId || '')) return null;
    const taking = r.credit_id && this.creditPayRow(r.credit_id)?.status === 'taking';
    if (r.status === 'making' || (r.status === 'open' && taking)) throw new RuleError(TILL_SALE_WORDS.making, 409);
    return { sale: this.tillSaleView(r), dropped: [], notices: [], repeated: true };
  },

  /**
   * Round 33: a sale whose price is fixed (open) takes its store credit now: as much as it covers (all of it for
   * 'credit'), with no PIN. Covered, it's paid there and then and its order made; part, it waits for the rest by card or
   * cash (due). Shopify saying no, or not answering, lets the sale go (a lost answer's store credit goes back on once the
   * 10-minute run finds it, src/credit-pay.js). → tillPay's { sale, dropped, notices }, or throws.
   */
  async tillTakeCredit(id, { customerId, balance, method, deadline, me, dropped, notices }) {
    const r = this.tillSaleRow(id);
    const total = r?.total || 0;
    const now = Date.now();
    if (method === 'credit' && balance < total) {
      this.tillLetGo(r, 'store credit short', now);
      throw new RuleError(CREDIT_PAY_WORDS.tillShort(balance, total), 409);
    }
    const amount = Math.min(balance, total);
    if (amount <= 0) return { sale: this.tillSaleView(r), dropped, notices };
    const cpId = makeId('cp');
    const currency = this.env?.CURRENCY || 'NZD';
    const day = new LairTime(this.rulesCache?.tz || 'Pacific/Auckland').key(now);
    this.write(
      `INSERT INTO credit_payments (id, customer_id, source, sale_id, day, amount, currency, status, created_at, updated_at)
       VALUES (?, ?, 'till', ?, ?, ?, ?, 'taking', ?, ?)`,
      cpId, String(customerId), id, day, amount, currency, now, now,
    );
    this.write('UPDATE till_sales SET credit = ?, credit_id = ?, updated_at = ? WHERE id = ?', amount, cpId, now, id);
    let took;
    try {
      // (the review) its own time with Shopify, not just what the draft left of the sale's 9 seconds
      took = await this.shopify.changeStoreCredit(customerId, -amount, currency, { timeout: Math.max(CREDIT_PAY.tillTimeoutMs, deadline - Date.now()) });
    } catch (error) {
      // --- no awaits from here on ---
      this.creditPayForget(customerId);
      const fresh = this.tillSaleRow(id);
      if (!error?.refused) {
        // it may or may not have come off: the run looks, and it goes back on if it did
        console.error('Lair: store credit at the till had no answer', error);
        this.creditPayUpdate(cpId, { status: 'checking', stage: 'take', message: errorText(error) });
        if (fresh && ['making', 'open'].includes(fresh.status)) this.tillLetGo(fresh, 'store credit', Date.now());
        throw new RuleError(CREDIT_PAY_WORDS.tillLost, 503);
      }
      this.creditPayUpdate(cpId, { status: 'failed', message: errorText(error) });
      if (fresh && ['making', 'open'].includes(fresh.status)) this.tillLetGo(fresh, 'store credit', Date.now());
      throw new RuleError(error.code === 'INSUFFICIENT_FUNDS' ? CREDIT_PAY_WORDS.tillChanged : CREDIT_PAY_WORDS.tillNotTaken(errorText(error).slice(0, 160)), 409);
    }
    // --- no awaits from here on (until its order, when store credit paid it all) ---
    this.creditPayForget(customerId);
    this.creditPayUpdate(cpId, { status: 'taken', take_tx: took?.id || null, balance_after: took?.balanceAfter ?? null });
    const at = Date.now();
    const fresh = this.tillSaleRow(id);
    if (!fresh || fresh.status !== 'open') {
      // let go while it came off (a new sale on this till): its store credit goes back on
      this.creditPayReturnSoon(cpId, 'its till sale was let go');
      throw new RuleError(TILL_SALE_WORDS.gone, 409);
    }
    // (as at Paid) a booking or tab it pays that was paid another way meanwhile: nothing's saved, and the credit goes back
    const elsewhere = this.tillPaidElsewhere(fresh, at);
    if (elsewhere) {
      this.tillLetGo(fresh, 'paid elsewhere', at);
      throw new RuleError(TILL_SALE_WORDS.paidElsewhere(elsewhere), 409);
    }
    if (amount < total) return { sale: this.tillSaleView(this.tillSaleRow(id)), dropped, notices };
    // store credit paid all of it: paid now, by whoever's on the till (or the customer at the counter)
    this.write(
      `UPDATE till_sales SET status = 'paid', paid_at = ?, by = ?, by_name = ?, order_status = 'making', order_tries = 1, order_next_at = ?, updated_at = ?
         WHERE id = ? AND status = 'open'`,
      at, me ? me.id : 'customer', me ? me.name : null, at + STUCK, at, id,
    );
    this.creditPayUpdate(cpId, { status: 'paid', paid_at: at });
    const left = deadline - Date.now();
    if (left > 1500) await this.tillOrder(id, 1, { timeout: left });
    else this.later(this.tillOrder(id, 1));
    return { sale: this.tillSaleView(this.tillSaleRow(id)), dropped, notices };
  },

  /**
   * A sale that won't be paid: it's gone, its draft deleted, and its tab back to open (unless another sale has it).
   * Never one that's paid. No awaits.
   */
  tillLetGo(r, why, now) {
    this.write("UPDATE till_sales SET status = 'gone', ended_at = ?, ended_why = ?, updated_at = ? WHERE id = ? AND status IN ('making', 'open')", now, why, now, r.id);
    if (r.draft_id && this.shopify?.configured) this.later(this.shopify.deleteDraftIfOpen(r.draft_id));
    for (const tabId of parse(r.tabs, [])) {
      const others = this.sql
        .exec("SELECT tabs FROM till_sales WHERE id != ? AND status IN ('making', 'open', 'paid') AND created_at > ?", r.id, now - PENDING_MS)
        .toArray()
        .some((x) => parse(x.tabs, []).includes(tabId));
      if (!others) this.write("UPDATE tabs SET status = 'open', updated_at = ? WHERE id = ? AND status = 'in-cart'", now, tabId);
    }
    // round 33: store credit taken for it goes back on (one still coming off is looked after where it's taken)
    if (r.credit_id) this.creditPayReturnSoon(r.credit_id, `its till sale was let go (${why})`);
  },

  /** POST /till/pay/cancel { sale } (the tablet's staff account): back from paying: the sale's let go. → { sale: null } */
  tillPayCancel(body, who) {
    this.tillGate(who);
    const r = this.tillSaleRow(body?.sale);
    if (r?.status === 'paid') throw new RuleError(TILL_SALE_WORDS.paid, 409);
    if (r && ['making', 'open'].includes(r.status)) this.tillLetGo(r, 'back', Date.now());
    return { sale: null };
  },

  /**
   * POST /till/paid { sale, token, expect, handed? } (staff on the till with their own PIN; cash: the owner, Check-in or
   * Money): they have the money: card keyed into the EFTPOS and paid, or cash handed over (handed, in cents: change is
   * worked out). expect is the total they were shown (409 when it isn't the sale's). From here the sale is paid: its
   * Shopify order is made now (or in the background when Shopify's slow: saving), then fulfilled. Asking again for a
   * paid sale gives it as it is. → { sale }
   */
  async tillPaid(body, who) {
    this.tillGate(who);
    const tokenHash = await this.tillTokenHash(body?.token);
    const tagged = await this.tillTagged();
    // --- no awaits from here on, until its order ---
    const now = Date.now();
    const me = this.tillOn(tokenHash, this.tillTeamFrom(who, tagged));
    const r = this.tillSaleRow(body?.sale);
    if (!r) throw new RuleError(TILL_SALE_WORDS.noSale, 404);
    if (r.status === 'paid') return { sale: this.tillSaleView(r) };
    if (r.status === 'gone') throw new RuleError(TILL_SALE_WORDS.gone, 409);
    if (r.status !== 'open') throw new RuleError(TILL_SALE_WORDS.making, 409);
    // (the review) its store credit still coming off (Pay hasn't finished): not yet
    if (r.credit_id && this.creditPayRow(r.credit_id)?.status !== 'taken') throw new RuleError(TILL_SALE_WORDS.making, 409);
    if (r.method === 'cash' && !tillTakesCash(me)) throw new RuleError(TILL_SALE_WORDS.cash, 403);
    // round 33: what's left to pay once store credit took its part
    const due = r.total - (r.credit || 0);
    const expect = body?.expect == null || body.expect === '' ? NaN : Math.round(Number(body.expect));
    if (expect !== due) throw new RuleError(TILL_SALE_WORDS.expect(due), 409);
    // (the review) a booking or tab it pays that's been paid another way since Pay (another till, online, the counter
    // tile, cash in My Lair) would be paid twice: nothing's saved, and staff are told
    const elsewhere = this.tillPaidElsewhere(r, now);
    if (elsewhere) throw new RuleError(TILL_SALE_WORDS.paidElsewhere(elsewhere), 409);
    let handed = null;
    let change = null;
    if (r.method === 'cash') {
      handed = body?.handed == null || body.handed === '' ? NaN : Math.round(Number(body.handed));
      if (!Number.isFinite(handed) || handed < due || handed > due + TILL_CASH_OVER) throw new RuleError(TILL_SALE_WORDS.handed(due), 400);
      change = handed - due;
    }
    this.write(
      `UPDATE till_sales SET status = 'paid', paid_at = ?, by = ?, by_name = ?, handed = ?, change_given = ?, order_status = 'making', order_tries = 1,
         order_next_at = ?, updated_at = ? WHERE id = ? AND status = 'open'`,
      now, me.id, me.name, handed, change, now + STUCK, now, r.id,
    );
    // round 33: its store credit, taken at Pay, paid for it
    if (r.credit_id && this.creditPayRow(r.credit_id)?.status === 'taken') this.creditPayUpdate(r.credit_id, { status: 'paid', paid_at: now });
    await this.tillOrder(r.id, 1, { timeout: TILL_SHOPIFY_WAIT });
    return { sale: this.tillSaleView(this.tillSaleRow(r.id)) };
  },

  /* ---------------- its Shopify order ---------------- */
  /**
   * Make a paid sale's draft its paid order, never twice: a try after the first looks first at whether the draft became
   * one already (an answer that was lost). A draft that's gone (someone deleted it in Shopify) stops it and staff hear.
   * Returns the order, or null. Every await is followed by a check the try is still this one.
   */
  async tillOrder(id, tries, { timeout } = {}) {
    const mine = () => {
      const row = this.tillSaleRow(id);
      return row?.status === 'paid' && row.order_status === 'making' && row.order_tries === tries ? row : null;
    };
    let r = mine();
    if (!r) return null;
    const gone = () => Object.assign(new Error('Its draft order is gone from Shopify.'), { gone: true });
    let order = null;
    try {
      if (tries > 1) {
        const state = await this.shopify.draftOrderState(r.draft_id, timeout ? { timeout } : {});
        if (!(r = mine())) return null;
        if (!state) throw gone();
        order = state.order;
      }
      if (!order) {
        const done = await this.shopify.completePaidDraft(r.draft_id, timeout ? { timeout } : {});
        if (!(r = mine())) return null;
        order = done.order;
        if (!order) {
          const state = await this.shopify.draftOrderState(r.draft_id, timeout ? { timeout } : {});
          if (!(r = mine())) return null;
          if (!state) throw gone();
          order = state.order;
          if (!order) throw new Error(done.errors.join('; ') || 'Shopify made no order.');
        }
      }
    } catch (error) {
      // --- no awaits from here on ---
      console.error('Lair: could not make the Shopify order for a till sale', error);
      const fresh = mine();
      if (!fresh) return null;
      if (error?.gone) this.tillOrderStopped(fresh, errorText(error), Date.now());
      else this.tillOrderFailed(fresh, tries, errorText(error), Date.now());
      return null;
    }
    // --- no awaits from here on ---
    this.write(
      `UPDATE till_sales SET order_status = 'made', order_id = ?, order_name = ?, order_total = ?, order_error = NULL, order_next_at = NULL,
         fulfil_status = 'due', fulfil_next_at = NULL, updated_at = ? WHERE id = ? AND order_status = 'making' AND order_tries = ?`,
      order.id, order.name || null, order.total ?? null, Date.now(), id, tries,
    );
    if (order.total != null && order.total !== r.total) {
      const who = r.customer_id ? this.memberName(r.customer_id) : 'A quick sale';
      this.staffAlert(`till-total:${id}`, `A till sale that doesn't match: ${who}`, {
        title: "A till sale that doesn't match",
        intro: `${who} paid ${dollars(r.total)} at the till, and Shopify's order for it came to ${dollars(order.total)}, so Shopify's sales are out by ${dollars(Math.abs(order.total - r.total))}. Check the shop's discounts and tax settings, and put the order right in Shopify.`,
        details: [['Order', order.name || order.id], ['Paid at the till', dollars(r.total)], ['Order total', dollars(order.total)]],
      }, Date.now());
    }
    this.tillFulfilSoon(id);
    return order;
  },

  /** A try didn't go: tried again after the next wait; after the last, staff hear. No awaits. */
  tillOrderFailed(r, tries, error, now) {
    const wait = ORDER_RETRY[tries - 1];
    if (!wait) {
      this.tillOrderStopped(r, error, now);
      return;
    }
    this.write("UPDATE till_sales SET order_status = 'failed', order_error = ?, order_next_at = ?, updated_at = ? WHERE id = ?", String(error).slice(0, 300), now + wait, now, r.id);
  },

  /**
   * A paid sale's order couldn't be made, however many times the Lair tried (or its draft went): it stops, and staff hear
   * so they can finish it by hand. The money was taken either way: only Shopify's record of it is missing, and its
   * bookings stay unpaid in the Lair until the order is made (staff mark them paid if they make it some other way). No awaits.
   */
  tillOrderStopped(r, error, now) {
    this.write("UPDATE till_sales SET order_status = 'stopped', order_error = ?, order_next_at = NULL, updated_at = ? WHERE id = ?", String(error).slice(0, 300), now, r.id);
    const who = r.customer_id ? this.memberName(r.customer_id) : 'A quick sale';
    const draft = this.draftOrderUrl(r.draft_id);
    const lines = parse(r.shown, []);
    this.staffAlert(`till-order:${r.id}`, `A till sale with no Shopify order: ${who}`, {
      title: 'A till sale that needs its order made by hand',
      intro: `${who} paid ${dollars(r.total)} ${r.method === 'credit' || (r.credit && r.credit >= r.total) ? 'with store credit' : `${r.credit ? `(${dollars(r.credit)} of it from store credit) ` : ''}${r.method === 'cash' ? 'in cash' : 'by card'}`} at the till${r.by_name ? ` (${r.by_name} took it)` : ''}, but the Lair couldn't make its Shopify order, however many times it tried. ${draft
        ? 'Its draft order is in Shopify: open it (the link below) and mark it as paid. If it already shows as an order, there’s nothing to do.'
        : `Make it by hand in Shopify admin: Orders, Create order${r.customer_id ? ` for ${who}` : ''}, with what's below, then mark it as paid.`}`,
      details: [['Paid', dollars(r.total)], ['What it was for', lines.map((l) => (l.qty > 1 ? `${l.qty} × ${l.title}` : l.title)).join('\n')], ['Why', String(error).slice(0, 200)], ...(draft ? [['Draft order', draft]] : [])],
    }, now);
  },

  /** Claim and make a paid sale's order when its wait is up (or its try never finished). The try, or null. No awaits before the claim. */
  tillOrderClaim(id) {
    const r = this.tillSaleRow(id);
    if (!r || r.status !== 'paid' || !['making', 'failed'].includes(r.order_status) || !this.shopify?.configured) return null;
    const now = Date.now();
    if (r.order_next_at != null && r.order_next_at > now) return null;
    const tries = (r.order_tries || 0) + 1;
    if (tries > ORDER_RETRY.length + 1) {
      this.tillOrderStopped(r, r.order_error || "Shopify didn't answer.", now);
      return null;
    }
    this.write("UPDATE till_sales SET order_status = 'making', order_tries = ?, order_next_at = ?, updated_at = ? WHERE id = ?", tries, now + STUCK, now, id);
    return this.tillOrder(id, tries);
  },

  /* ---------------- fulfilling it at the shop ---------------- */
  /** Fulfil a sale's order in the background. No awaits. */
  tillFulfilSoon(id) {
    const making = this.tillFulfilClaim(id);
    if (making) this.later(making);
    return Boolean(making);
  },

  /** Claim a made order's fulfilment when it's due (or its try never finished). The try, or null. No awaits before the claim. */
  tillFulfilClaim(id) {
    const r = this.tillSaleRow(id);
    if (!r || r.order_status !== 'made' || !r.order_id || !['due', 'making', 'failed'].includes(r.fulfil_status) || !this.shopify?.configured) return null;
    const now = Date.now();
    if (r.fulfil_next_at != null && r.fulfil_next_at > now) return null;
    const tries = (r.fulfil_tries || 0) + 1;
    this.write("UPDATE till_sales SET fulfil_status = 'making', fulfil_tries = ?, fulfil_next_at = ? WHERE id = ?", tries, now + STUCK, id);
    return this.tillFulfil(id, tries);
  },

  /**
   * Mark a sale's order fulfilled at the shop (stock comes off there, and it never sits in Unfulfilled). When Shopify
   * refuses (the fulfilment scopes waiting for Mo), it's tried again later, then left for staff to mark by hand.
   */
  async tillFulfil(id, tries) {
    const mine = () => {
      const row = this.tillSaleRow(id);
      return row?.fulfil_status === 'making' && row.fulfil_tries === tries ? row : null;
    };
    const r = mine();
    if (!r) return null;
    let done;
    try {
      done = await this.shopify.fulfilTillOrder(r.order_id, this.tillShop());
    } catch (error) {
      // --- no awaits from here on ---
      const fresh = mine();
      if (!fresh) return null;
      const message = errorText(error);
      const at = Date.now();
      const denied = /access denied|ACCESS_DENIED|merchant_managed_fulfillment/i.test(message);
      if (denied) {
        // (the scopes still to approve: not counted, and tried every 6 hours for 14 days, then left for staff quietly)
        if (at - (fresh.paid_at || at) > FULFIL_DENIED_FOR) {
          this.write("UPDATE till_sales SET fulfil_status = 'stopped', fulfil_error = ?, fulfil_next_at = NULL WHERE id = ?", message, id);
        } else {
          this.write("UPDATE till_sales SET fulfil_status = 'failed', fulfil_tries = ?, fulfil_error = ?, fulfil_next_at = ? WHERE id = ?", tries - 1, message, at + FULFIL_DENIED, id);
        }
        return null;
      }
      const wait = FULFIL_RETRY[tries - 1];
      if (!wait) {
        this.write("UPDATE till_sales SET fulfil_status = 'stopped', fulfil_error = ?, fulfil_next_at = NULL WHERE id = ?", message, id);
        const who = fresh.customer_id ? this.memberName(fresh.customer_id) : 'A quick sale';
        this.staffAlert(`till-fulfil:${id}`, `A till sale to mark fulfilled by hand: ${who}`, {
          title: 'A till sale to mark fulfilled by hand',
          intro: `${who}'s till sale is paid and saved in Shopify, but the Lair couldn't mark it fulfilled at the shop, however many times it tried, so it's waiting in Orders › Unfulfilled. Open it and mark it fulfilled.`,
          details: [['Order', fresh.order_name || fresh.order_id || ''], ['Why', message.slice(0, 200)]],
        }, at);
      } else {
        this.write("UPDATE till_sales SET fulfil_status = 'failed', fulfil_error = ?, fulfil_next_at = ? WHERE id = ?", message, at + wait, id);
      }
      return null;
    }
    // --- no awaits from here on ---
    if (!mine()) return null;
    this.write("UPDATE till_sales SET fulfil_status = 'done', fulfil_error = NULL, fulfil_next_at = NULL WHERE id = ?", id);
    return done;
  },

  /* ---------------- the 10-minute run ---------------- */
  /**
   * Sales left waiting for their money for TILL_SALE_OPEN_MS are let go; paid sales' orders still to make, and made
   * orders still to fulfil, are tried again (a few a run). → { letGo, orders, fulfilled } (how many were looked at)
   */
  async tillSalesUpkeep(now = Date.now()) {
    const stale = this.sql.exec("SELECT * FROM till_sales WHERE status IN ('making', 'open') AND created_at < ?", now - TILL_SALE_OPEN_MS).toArray();
    for (const r of stale) this.tillLetGo(r, 'not paid', now);
    if (!this.shopify?.configured) return { letGo: stale.length, orders: 0, fulfilled: 0 };
    const orders = this.sql
      .exec(
        "SELECT id FROM till_sales WHERE status = 'paid' AND order_status IN ('making', 'failed') AND (order_next_at IS NULL OR order_next_at <= ?) ORDER BY paid_at LIMIT ?",
        now, A_RUN,
      )
      .toArray()
      .map((r) => r.id);
    for (const id of orders) {
      const making = this.tillOrderClaim(id);
      if (making) await making;
    }
    const fulfils = this.sql
      .exec(
        `SELECT id FROM till_sales WHERE order_status = 'made' AND fulfil_status IN ('due', 'making', 'failed') AND (fulfil_next_at IS NULL OR fulfil_next_at <= ?)
         ORDER BY paid_at LIMIT ?`,
        Date.now(), A_RUN,
      )
      .toArray()
      .map((r) => r.id);
    for (const id of fulfils) {
      const making = this.tillFulfilClaim(id);
      if (making) await making;
    }
    return { letGo: stale.length, orders: orders.length, fulfilled: fulfils.length };
  },
};

// Counter sales through Pay on Verifone (round 22, 28 Oct 2026; API contract v22-stamps, section 6).
//
// Card payments at the counter are taken by the Verifone terminal's app, "OrderMate: Reconcile Orders". It saves each
// sale as an order of its own (its source_name is OrderMate's app ID, and it's tagged OrderMate and Verifone), and on
// the way it drops the line properties the Lair check-in tile put on the cart's lines (_booking, _share, _tab). Every
// counter sale since 18 October 2026 came that way, so the Lair never heard that something was paid at the counter:
// owed seats stayed owed (and were sometimes paid again), tabs stayed at the counter, and paying stamped nothing.
//
// What survives is each line's title, product and quantity, and the customer on the sale. So:
//   - an OrderMate order is a counter sale, like Shopify POS's own (counterSale);
//   - every Lair line in the cart has its code in its title ("GM seat: Barons (MA-HARP-10)", "Owed: Barons (Sun 18 Oct,
//     MA-HARP-10)", "Tab: Tue 15 Sep (2 things, TAB-1A2B3C)"), so a custom sale on a counter sale that lost its
//     _booking or _tab pays the booking, sign-up or tab its title names, when it names exactly one (titleBooking,
//     titleTab);
//   - a member's tab goes in the cart as the shop's own products, so a tab at the counter ('in-cart') for the sale's
//     customer is paid by a counter sale that has every one of its items (cartTabsPaidBy).
// Only counter sales are read this way: customers can't make one (the online store's orders are 'web', our checkouts
// 'shopify_draft_order'), so a code typed into an online cart pays nothing.

/** The Verifone terminal's app: its orders' source_name, and their tag (lower case) */
export const ORDERMATE = Object.freeze({ app: '36219584513', tag: 'ordermate' });

/** A booking or sign-up code in a line's title (SJ-OWLBEAR-17, or the first release's GOB-7K2QXM), and a tab's ref */
const CODE_IN_TITLE = /\b(?:[A-Z]{2}-[A-Z]{3,9}-\d{1,2}|GOB-[A-Z0-9]{6})\b/g;
const TAB_IN_TITLE = /\bTAB-([A-Z0-9]{6})\b/g;

const parse = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

/** An order's tags, lower case: the webhook sends them as one comma-separated string, the Admin API as a list */
export function orderTags(order) {
  const raw = order?.tags;
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return list.map((tag) => String(tag ?? '').trim().toLowerCase()).filter(Boolean);
}

/**
 * Was this order rung up at the counter? Shopify POS's own orders (source_name 'pos'), and Pay on Verifone's (source_name
 * OrderMate's app ID; one from an app tagged OrderMate counts too, in case OrderMate's app ID ever changes).
 */
export function counterSale(order) {
  const source = String(order?.source_name ?? '');
  if (source === 'pos' || source === ORDERMATE.app) return true;
  return /^\d+$/.test(source) && orderTags(order).includes(ORDERMATE.tag);
}

/** A custom sale: no product behind it. The Lair tile's lines are custom sales; a product's title never names a booking. */
export function customSale(item) {
  return (item?.product_id ?? null) === null && (item?.variant_id ?? null) === null;
}

/** The booking and sign-up codes in a line's title, each once, as written (codes are in capitals) */
export function titleCodes(title) {
  return [...new Set(String(title ?? '').match(CODE_IN_TITLE) || [])];
}

/** The tab refs in a line's title (TAB-1A2B3C: the last six of the tab's id, in capitals), each once, without "TAB-" */
export function titleTabRefs(title) {
  return [...new Set([...String(title ?? '').matchAll(TAB_IN_TITLE)].map((m) => m[1]))];
}

export const counterMethods = {
  /**
   * The booking or sign-up a counter line's title names: { type, item } when exactly one of its codes is one, else null
   * (no code, or two different ones). No awaits.
   */
  titleBooking(title) {
    const found = new Map();
    for (const code of titleCodes(title)) {
      const hit = this.bookingOrJoin(code);
      if (hit) found.set(`${hit.type}:${hit.item.id}`, hit);
    }
    return found.size === 1 ? [...found.values()][0] : null;
  },

  /** The unpaid tab a counter line's title names (TAB-1A2B3C), when exactly one tab is: its id, else null. No awaits. */
  titleTab(title) {
    const ids = new Set();
    for (const ref of titleTabRefs(title).slice(0, 3)) {
      for (const row of this.sql.exec("SELECT id FROM tabs WHERE upper(substr(id, -6)) = ? AND status != 'paid' LIMIT 2", ref).toArray()) ids.add(row.id);
    }
    return ids.size === 1 ? [...ids][0] : null;
  },

  /**
   * The tabs a counter sale pays when its lines lost _tab (Pay on Verifone): the customer's tabs at the counter
   * ('in-cart', newest first), each paid when every one of its items is on the sale (the same product variant, at least
   * as many) among the lines without _tab that no other tab has taken. No awaits. Returns tab ids.
   */
  cartTabsPaidBy(order, customerId) {
    if (!customerId) return [];
    const left = new Map();
    for (const item of order?.line_items || []) {
      if ((item.properties || []).some((p) => p.name === '_tab' && p.value)) continue;
      const variant = item.variant_id == null ? '' : String(item.variant_id).trim();
      const quantity = Math.max(0, Math.floor(Number(item.quantity ?? 0)) || 0);
      if (variant && quantity) left.set(variant, (left.get(variant) || 0) + quantity);
    }
    if (!left.size) return [];
    const paid = [];
    const tabs = this.sql
      .exec("SELECT id, items FROM tabs WHERE customer_id = ? AND status = 'in-cart' ORDER BY updated_at DESC, rowid DESC LIMIT 5", String(customerId))
      .toArray();
    for (const tab of tabs) {
      const need = new Map();
      for (const x of parse(tab.items, [])) {
        const variant = String(x?.variantId ?? '').trim();
        if (!variant) continue;
        need.set(variant, (need.get(variant) || 0) + Math.max(1, Math.floor(Number(x.qty)) || 1));
      }
      if (!need.size || ![...need].every(([variant, n]) => (left.get(variant) || 0) >= n)) continue;
      for (const [variant, n] of need) left.set(variant, left.get(variant) - n);
      paid.push(tab.id);
    }
    return paid;
  },
};

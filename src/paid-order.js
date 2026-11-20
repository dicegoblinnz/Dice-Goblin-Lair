/**
 * Round 48 (contract v48-card-pay): the paid Shopify order behind a payment the Lair took itself, so Shopify's sales,
 * stock and the member's spend include it. Written once for any payments table that has the order_* columns
 * (PAID_ORDER_COLUMNS) plus id, customer_id, amount, currency, status ('paid'), lines and paid_at. Card payments use it;
 * cash (src/cash.js) and store credit (src/credit-pay.js) still carry their own copies of these steps and can move here.
 *
 * A kind says whose orders they are: { table, tag, tags, marker, note(id), how } where `how` finishes "paid $12.00 …"
 * in staff's alerts ("by card on their phone"). table comes from code only, never from a request.
 *
 * Never twice: a draft kept from an earlier try is looked at first; a try that may have made one looks for it by its
 * marker (as an order, then a draft); only then is a draft made, and kept at once. The try after the last only looks.
 * Methods of the Lair Durable Object: every await first, then synchronous reads, checks and writes.
 */
import { HOUR, MIN } from './core.js';

export const PAID_ORDER_COLUMNS = `order_status TEXT, order_tries INTEGER NOT NULL DEFAULT 0, order_next_at INTEGER, order_draft TEXT,
     order_sent_at INTEGER, order_id TEXT, order_name TEXT, order_error TEXT`;

const RETRY = [10 * MIN, 30 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR];
const LAST_LOOK = HOUR;
// a try that never finished (a restart mid-call) is taken up again after this
const STUCK = 15 * MIN;
// no order is asked for with less than this left before another run may take the payment up
const SEND_MARGIN = 5 * MIN;
const READY_WAIT = 1000;
const READY_TRIES = 5;
const A_RUN = 10;

const money = (cents) => `$${(Math.round(Number(cents) || 0) / 100).toFixed(2)}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

export const paidOrderMethods = {
  paidOrderRow(kind, id) {
    return this.sql.exec(`SELECT * FROM ${kind.table} WHERE id = ?`, String(id)).toArray()[0] || null;
  },

  /** Start a payment's Shopify order in the background. No awaits. */
  startPaidOrder(kind, id) {
    const making = this.paidOrder(kind, id);
    if (making) this.later(making);
    return Boolean(making);
  },

  /** Claim and make the order, or try again when an earlier try didn't finish. The try, or null. No awaits before the claim. */
  paidOrder(kind, id) {
    const r = this.paidOrderRow(kind, id);
    if (!r || r.status !== 'paid' || !['due', 'making', 'failed'].includes(r.order_status)) return null;
    const now = Date.now();
    if (r.order_next_at != null && r.order_next_at > now) return null;
    if (!this.shopify?.configured) return null;
    const tries = (r.order_tries || 0) + 1;
    if (tries > RETRY.length + 2) {
      this.paidOrderStopped(kind, r, r.order_error || "Shopify didn't answer.", now);
      return null;
    }
    this.write(`UPDATE ${kind.table} SET order_status = 'making', order_tries = ?, order_next_at = ? WHERE id = ?`, tries, now + STUCK, id);
    return this.sendPaidOrder(kind, id, tries);
  },

  async sendPaidOrder(kind, id, tries) {
    const shopify = this.shopify;
    const lookOnly = tries > RETRY.length + 1;
    const mine = () => {
      const row = this.paidOrderRow(kind, id);
      return row?.order_status === 'making' && row.order_tries === tries ? row : null;
    };
    const superseded = { id, superseded: true };
    let r = mine();
    if (!r) return superseded;
    let draft = r.order_draft || null;
    let order = null;
    try {
      if (draft) {
        const state = await shopify.draftOrderState(draft);
        if (!(r = mine())) return superseded;
        if (state?.order) order = state.order;
        else if (!state) {
          draft = null;
          this.write(`UPDATE ${kind.table} SET order_draft = NULL WHERE id = ?`, id);
        }
      }
      if (!order && !draft && (r.order_sent_at || lookOnly)) {
        order = await shopify.findMarkedOrder(r.customer_id, kind.tag, kind.marker, id);
        if (!(r = mine())) return superseded;
        if (!order && r.order_sent_at) {
          const found = await shopify.findMarkedDraft(r.customer_id, kind.tag, kind.marker, id);
          if (!(r = mine())) return superseded;
          if (found) {
            draft = found.id;
            order = found.order;
            this.write(`UPDATE ${kind.table} SET order_draft = ? WHERE id = ?`, draft, id);
          }
        }
      }
      if (!order && lookOnly) {
        // --- no awaits from here on ---
        this.paidOrderStopped(kind, r, r.order_error || 'Shopify made no order.', Date.now());
        return { id, order: null, stopped: true };
      }
      if (!order && !draft) {
        if ((r.order_next_at || 0) - Date.now() < SEND_MARGIN) throw new Error("Shopify was slow, so the order wasn't asked for this time.");
        this.write(`UPDATE ${kind.table} SET order_sent_at = COALESCE(order_sent_at, ?) WHERE id = ?`, Date.now(), id);
        const made = await shopify.createPaidLinesDraft({
          customerId: r.customer_id, lines: parse(r.lines, []), currency: r.currency || this.env?.CURRENCY || 'NZD', tags: [...kind.tags],
          note: kind.note(id), marker: { [kind.marker]: id },
        });
        this.write(`UPDATE ${kind.table} SET order_draft = COALESCE(order_draft, ?) WHERE id = ?`, made.id, id);
        if (this.paidOrderRow(kind, id)?.order_draft !== made.id) this.later(shopify.deleteDraftIfOpen(made.id));
        if (!(r = mine())) return superseded;
        draft = r.order_draft;
        for (let i = 0, ready = made.ready; !ready && i < READY_TRIES; i += 1) {
          await pause(READY_WAIT);
          ready = (await shopify.draftOrderState(draft))?.ready !== false;
          if (!(r = mine())) return superseded;
        }
      }
      if (!order) {
        const done = await shopify.completePaidDraft(draft);
        if (!(r = mine())) return superseded;
        order = done.order;
        if (!order) {
          const state = await shopify.draftOrderState(draft);
          if (!(r = mine())) return superseded;
          order = state?.order || null;
          if (!order) throw new Error(done.errors.join('; ') || 'Shopify made no order.');
        }
      }
    } catch (error) {
      // --- no awaits from here on ---
      console.error(`Lair: could not make the Shopify order for ${kind.table} ${id}`, error);
      const fresh = mine();
      if (!fresh) return superseded;
      const wait = RETRY[tries - 1] ?? (tries === RETRY.length + 1 ? LAST_LOOK : null);
      const said = String(error?.message || error).slice(0, 300);
      if (!wait) this.paidOrderStopped(kind, fresh, said, Date.now());
      else this.write(`UPDATE ${kind.table} SET order_status = 'failed', order_error = ?, order_next_at = ? WHERE id = ?`, said, Date.now() + wait, id);
      return { id, order: null };
    }
    // --- no awaits from here on ---
    this.write(
      `UPDATE ${kind.table} SET order_status = 'made', order_id = ?, order_name = ?, order_error = NULL, order_next_at = NULL WHERE id = ? AND order_tries = ?`,
      order.id, order.name || null, id, tries,
    );
    if (order.total != null && order.total !== r.amount) {
      const name = this.memberName(r.customer_id);
      this.staffAlert(`${kind.tag}-total:${id}`, `An order that doesn't match: ${name}`, {
        title: "An order that doesn't match what was paid",
        intro: `${name} paid ${money(r.amount)} ${kind.how}, and Shopify's order for it came to ${money(order.total)}, so Shopify's sales are out by ${money(Math.abs(order.total - r.amount))}. Check the shop's tax and discount settings, and put the order right in Shopify.`,
        details: [['Order', order.name || order.id], ['Paid', money(r.amount)], ['Order total', money(order.total)]],
      }, Date.now());
    }
    return { id, order: order.id };
  },

  /** The order couldn't be made however often the Lair tried: staff hear, to finish it by hand. Everything's paid either way. No awaits. */
  paidOrderStopped(kind, r, error, now) {
    this.write(`UPDATE ${kind.table} SET order_status = 'stopped', order_error = ?, order_next_at = NULL WHERE id = ?`, String(error).slice(0, 300), r.id);
    const name = this.memberName(r.customer_id);
    const draft = this.draftOrderUrl(r.order_draft);
    const lines = parse(r.lines, []);
    this.staffAlert(`${kind.tag}-order:${r.id}`, `A payment with no Shopify order: ${name}`, {
      title: 'An order that needs making by hand',
      intro: `${name} paid ${money(r.amount)} ${kind.how} and everything's marked paid, but the Lair couldn't make its Shopify order, however many times it tried. Only Shopify's record of it is missing. ${draft
        ? 'Its draft order is in Shopify: open it (the link below) and mark it as paid. If it already shows as an order, there’s nothing to do.'
        : `Make it by hand in Shopify admin: Orders, Create order for ${name}, with what's below, then mark it as paid.`}`,
      details: [['Paid', money(r.amount)], ['What it paid for', lines.map((l) => (l.variantId ? `${l.qty} × ${l.title}` : l.title)).join('\n')], ['Why', String(error).slice(0, 200)], ...(draft ? [['Draft order', draft]] : [])],
    }, now);
  },

  /** The 10-minute run: orders still to make, and ones whose wait is up or whose try never finished. → their ids */
  async retryPaidOrders(kind, now) {
    if (!this.shopify?.configured) return [];
    const due = this.sql.exec(
      `SELECT id FROM ${kind.table} WHERE status = 'paid' AND order_status IN ('due', 'making', 'failed') AND (order_next_at IS NULL OR order_next_at <= ?)
         ORDER BY COALESCE(order_next_at, 0), paid_at LIMIT ?`,
      now, A_RUN,
    ).toArray().map((r) => r.id);
    for (const id of due) {
      const making = this.paidOrder(kind, id);
      if (making) await making;
    }
    return due;
  },
};

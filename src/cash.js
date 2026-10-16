/**
 * Cash at the counter (17 Oct 2026, contract v18-cash). Mo: "cash I never thought about it, we should have something
 * made for that. But I don't want to let it happen so easily on the tablet since the tablet is admin signed in because
 * I don't want to pay for more shopify to get staff added. So we should have a button to push a client to paid in cash
 * and admin or staff checks the button on their account to clear it." He picked: build it now, and record it in
 * Shopify as a paid order.
 *
 *  - A member taps Pay with cash in My Lair (POST /me/cash): a request for what they'd pay at the counter now (today's
 *    bookings, seats and sign-ups with something to pay, what's owed and today's tab, as My Lair's bill shows it), for
 *    staff to see. Tapping it again brings it up to date; POST /me/cash/cancel takes it back.
 *  - Staff with Check-in or Money tap Got the cash (POST /cash/:id/paid { expect }) once they have it. The Lair checks
 *    them in as the till's "Add everything to cart" does (their saved passes apply), works out what's left to pay
 *    (those lines, what's owed and today's tab) and, when that's what staff were shown (expect), records it all paid
 *    from this request (payments with order cash:<id>, the tab paid), as a paid order's lines are. When it isn't (a
 *    pass took some off, or the tab changed), nothing's paid: the request shows the new total, to take and tap again.
 *  - Then, in the background, its Shopify order: a draft for the customer with a line for each thing paid (bookings
 *    and seats as custom lines at what they paid, the tab's things as their products at the tab's price, so stock comes
 *    off), tagged lair-cash, made a paid order, as store credit's damage orders are (src/memberships.js): claimed, tried
 *    again after waits, looked for by its marker before another is made, and staff told when it can't be made.
 *  - Not paid (POST /cash/:id/cancel, staff) ends a request without paying anything.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair:
 * every await first, then synchronous reads, checks and writes.
 */
import { HOUR, LairTime, RuleError, makeId } from './core.js';

const MIN = 60_000;
const DAY = 24 * HOUR;

/** Who takes cash: staff with Check-in or Money (the main account always) */
export const CASH_STAFF = ['checkin', 'money'];
/** The Shopify order's tag, and the marker on the draft that finds it again */
export const CASH_ORDER_TAG = 'lair-cash';
const CASH_MARKER = '_lair_cash';
/** Waits before each try again at the Shopify order, as store credit's: then one last look, then staff hear */
const ORDER_RETRY = [10 * MIN, 30 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY];
const ORDER_LAST_LOOK = HOUR;
/** A try that never finished (the Worker stopped) is taken over after this */
const ORDER_STUCK = 15 * MIN;
/** A new draft is only asked for while this much of its claim is left */
const ORDER_SEND_MARGIN = 5 * MIN;
const ORDER_READY_WAIT = 1000;
const ORDER_READY_TRIES = 5;
/** Orders made a run, so a run stays short */
const ORDERS_A_RUN = 10;

/** The tables (made when missing, in lair.js's migrate) */
export const CASH_TABLES = [
  `CREATE TABLE IF NOT EXISTS cash_requests (
    id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL, items TEXT NOT NULL,
    lines TEXT, created_at INTEGER NOT NULL, updated_at INTEGER, paid_at INTEGER, by TEXT, by_name TEXT, ended_at INTEGER, ended_by TEXT,
    order_status TEXT, order_tries INTEGER NOT NULL DEFAULT 0, order_next_at INTEGER, order_draft TEXT, order_sent_at INTEGER, order_id TEXT,
    order_name TEXT, order_error TEXT)`,
  'CREATE INDEX IF NOT EXISTS cash_requests_day ON cash_requests (day, status)',
  'CREATE INDEX IF NOT EXISTS cash_requests_customer ON cash_requests (customer_id, status)',
  'CREATE INDEX IF NOT EXISTS cash_requests_order ON cash_requests (order_status, order_next_at)',
];

/** Every message members and staff see, word for word in the contract */
export const CASH_WORDS = {
  login: 'Log in to pay with cash.',
  nothing: "There's nothing to pay right now.",
  monthly: "You're on a monthly account, so it all goes on your bill. Pay it online in My Lair, or at the counter.",
  noRequest: 'That cash payment could not be found.',
  done: (status) => (status === 'paid' ? "That's been paid in cash already." : 'They changed their mind, so there’s nothing to take.'),
  otherDay: 'That one was from another day. Ask them to tap Pay with cash again.',
  nothingNow: "There's nothing left to pay now, so there's no cash to take.",
  changed: (total) => `It's ${dollars(total)} now (a session pass took some off, or their tab changed). Take ${dollars(total)}, then tap Got the cash again.`,
  expect: 'expect is the amount you were shown, in cents.',
};

/* ---------- small helpers (the same as lair.js's) ---------- */
const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const cashMethods = {
  /* ---------------- reading ---------------- */
  cashRow(id) {
    return this.sql.exec('SELECT * FROM cash_requests WHERE id = ?', String(id ?? '')).toArray()[0] || null;
  },

  /** A request as members and staff see it (staff: true adds who, the member's name and code, and the Shopify order) */
  cashView(r, { staff = false } = {}) {
    if (!r) return null;
    const view = {
      id: r.id, status: r.status, total: r.total, items: parse(r.items, []), at: r.created_at, paidAt: r.paid_at || null,
    };
    if (!staff) return view;
    const member = this.memberRow(r.customer_id);
    return {
      ...view, customerId: r.customer_id, name: member?.name || member?.first_name || member?.code || 'A member', code: member?.code || null,
      by: r.by_name || null, order: r.order_id ? { id: r.order_id, name: r.order_name || null } : null, orderStatus: r.order_status || null,
    };
  },

  /** Today's request still waiting for a member, or null. No awaits. */
  cashWaitingFor(customerId, rules, now) {
    const day = new LairTime(rules.tz).key(now);
    const row = this.sql
      .exec("SELECT * FROM cash_requests WHERE customer_id = ? AND day = ? AND status = 'waiting' ORDER BY created_at DESC LIMIT 1", String(customerId), day)
      .toArray()[0];
    return row || null;
  },

  /** Today's requests waiting for staff, first asked first (the floor's cash, for staff who take cash). No awaits. */
  cashWaiting(rules, now) {
    const day = new LairTime(rules.tz).key(now);
    return this.sql
      .exec("SELECT * FROM cash_requests WHERE day = ? AND status = 'waiting' ORDER BY created_at", day)
      .toArray()
      .map((r) => this.cashView(r, { staff: true }));
  },

  /**
   * What a member would pay at the counter now, as My Lair's bill shows it: today's bookings, seats and sign-ups with
   * something to pay (not held for an online payment, not a no-show), what's owed, and today's tab (open, or at the
   * counter). → { items: [{ kind, id, ref?, title, amount, things? }], total }. No awaits.
   */
  cashBill(customerId, rules, now) {
    const day = this.memberDay(customerId, rules, now);
    const atCounter = (r) => (r.type === 'join' ? ['confirmed', 'attended'] : ['confirmed', 'seated']).includes(r.status);
    const items = [...day.today.filter((r) => r.due > 0 && atCounter(r)), ...day.owed].map((r) => ({
      kind: r.type === 'join' ? 'join' : 'booking', id: r.id, ref: r.ref, title: `${r.owed ? 'Owed: ' : ''}${this.dueTitle(r, rules)}`, amount: r.due,
    }));
    const tab = this.cashTab(customerId, rules, now);
    if (tab) items.push(this.cashTabItem(tab));
    return { items, total: items.reduce((sum, x) => sum + x.amount, 0) };
  },

  /** Today's tab when there's something on it to pay (open, or in the till's cart), or null. No awaits. */
  cashTab(customerId, rules, now) {
    const row = this.todayTabRow(customerId, rules, now);
    return row && ['open', 'in-cart'].includes(row.status) && Number(row.total) > 0 ? row : null;
  },

  /** A tab as one item on the bill: "Tab: 2 × Coke, 1 × Snickers" */
  cashTabItem(tab) {
    const things = parse(tab.items, []).map((t) => ({ title: t.variantTitle && !/^default title$/i.test(t.variantTitle) ? `${t.title} (${t.variantTitle})` : t.title, qty: t.qty }));
    const count = things.reduce((n, t) => n + (Number(t.qty) || 0), 0);
    return { kind: 'tab', id: tab.id, title: `Tab: ${plural(count, 'thing', 'things')}`, amount: Number(tab.total) || 0, things };
  },

  /* ---------------- the member ---------------- */
  /**
   * POST /me/cash (logged in): pay with cash at the counter. A request for what's on their bill now, for staff to see;
   * tapping again brings it up to date. A member on a monthly account pays their bill instead. → { cash }. No awaits
   * after the rules.
   */
  async payCash(who) {
    if (!who.customerId) throw new RuleError(CASH_WORDS.login, 401);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const customerId = String(who.customerId);
    if (this.accountRow(customerId)?.billing === 'monthly') throw new RuleError(CASH_WORDS.monthly, 409);
    const { items, total } = this.cashBill(customerId, rules, now);
    if (!total) throw new RuleError(CASH_WORDS.nothing, 409);
    const day = new LairTime(rules.tz).key(now);
    // one waiting a member: today's brought up to date, and any from another day ended
    this.write("UPDATE cash_requests SET status = 'ended', ended_at = ?, ended_by = 'another day', updated_at = ? WHERE customer_id = ? AND status = 'waiting' AND day != ?", now, now, customerId, day);
    const waiting = this.cashWaitingFor(customerId, rules, now);
    if (waiting) {
      this.write('UPDATE cash_requests SET total = ?, items = ?, updated_at = ? WHERE id = ?', total, JSON.stringify(items), now, waiting.id);
      return { cash: this.cashView(this.cashRow(waiting.id)) };
    }
    const id = makeId('cr');
    this.write(
      "INSERT INTO cash_requests (id, customer_id, day, status, total, items, created_at, updated_at) VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?)",
      id, customerId, day, total, JSON.stringify(items), now, now,
    );
    this.touchMember(customerId, {}, now);
    return { cash: this.cashView(this.cashRow(id)) };
  },

  /** POST /me/cash/cancel (logged in): they'll pay another way. → { cash: null }. No awaits after the rules. */
  async cancelCash(who) {
    if (!who.customerId) throw new RuleError(CASH_WORDS.login, 401);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const waiting = this.cashWaitingFor(who.customerId, rules, now);
    if (waiting) this.write("UPDATE cash_requests SET status = 'ended', ended_at = ?, ended_by = 'them', updated_at = ? WHERE id = ? AND status = 'waiting'", now, now, waiting.id);
    return { cash: null };
  },

  /* ---------------- staff ---------------- */
  /**
   * POST /cash/:id/paid { expect } (staff with Check-in or Money): they have the cash. Checked in as the till does it
   * (saved passes apply), then everything left is paid from this request, when it comes to expect (what staff were
   * shown); otherwise nothing's paid and the request shows the new total (409 changed). Its Shopify order is made in the
   * background. → { cash, notices }.
   */
  async cashPaid(id, input, who) {
    this.requireStaff(who, CASH_STAFF);
    const expect = input?.expect == null || input.expect === '' ? null : Math.round(Number(input.expect));
    if (expect != null && !(Number.isFinite(expect) && expect >= 0)) throw new RuleError(CASH_WORDS.expect, 422);
    const row = this.cashRow(id);
    if (!row) throw new RuleError(CASH_WORDS.noRequest, 404);
    if (row.status !== 'waiting') throw new RuleError(CASH_WORDS.done(row.status), 409);
    const rulesNow = await this.rules();
    if (row.day !== new LairTime(rulesNow.tz).key(Date.now())) {
      this.write("UPDATE cash_requests SET status = 'ended', ended_at = ?, ended_by = 'another day', updated_at = ? WHERE id = ? AND status = 'waiting'", Date.now(), Date.now(), row.id);
      throw new RuleError(CASH_WORDS.otherDay, 409);
    }
    // checked in as the till's "Add everything to cart" does: today's rows here (saved passes apply), with a line each
    // for what's left, and what's owed
    const counter = await this.posCheckInMember({ customerId: row.customer_id }, who.customerId ? `staff:${who.customerId}` : 'staff');
    const rules = await this.rules();
    // --- no awaits from here on: the request, the lines and the tab read fresh ---
    const now = Date.now();
    const fresh = this.cashRow(row.id);
    if (!fresh || fresh.status !== 'waiting') throw new RuleError(CASH_WORDS.done(fresh?.status), 409);
    const lines = (counter.lines || [])
      .map((l) => ({ ref: String(l.properties?._booking || '').trim().toUpperCase(), title: String(l.title || '').slice(0, 120), cents: Math.round(Number(l.price) * 100) * Math.max(1, Number(l.quantity) || 1) }))
      .filter((l) => l.ref && l.cents > 0);
    const tab = this.cashTab(fresh.customer_id, rules, now);
    const tabThings = tab ? parse(tab.items, []) : [];
    const total = lines.reduce((sum, l) => sum + l.cents, 0) + (tab ? Number(tab.total) || 0 : 0);
    const items = [
      ...lines.map((l) => {
        const found = this.bookingOrJoin(l.ref);
        return { kind: found?.type === 'join' ? 'join' : 'booking', id: found?.item.id || null, ref: l.ref, title: l.title, amount: l.cents };
      }),
      ...(tab ? [this.cashTabItem(tab)] : []),
    ];
    if (!total) {
      this.write("UPDATE cash_requests SET status = 'ended', total = 0, items = '[]', ended_at = ?, ended_by = 'nothing left', updated_at = ? WHERE id = ? AND status = 'waiting'", now, now, fresh.id);
      throw new RuleError(CASH_WORDS.nothingNow, 409);
    }
    if (expect != null && expect !== total) {
      // (shown again with what it comes to now; nothing's paid until staff tap again for this amount)
      this.write('UPDATE cash_requests SET total = ?, items = ?, updated_at = ? WHERE id = ?', total, JSON.stringify(items), now, fresh.id);
      throw new RuleError(CASH_WORDS.changed(total), 409);
    }
    // paid from this request, a payment for each line, as a paid order's lines are (order cash:<id>)
    const orderKey = `cash:${fresh.id}`;
    const paying = [];
    lines.forEach((l, i) => {
      const found = this.bookingOrJoin(l.ref);
      if (found) paying.push({ type: found.type, id: found.item.id, lineId: `line-${i + 1}`, amount: l.cents });
    });
    const paidRefs = this.recordPayments(paying, orderKey, rules, { pos: true, now });
    if (tab) this.markTabsPaid([tab.id], orderKey, now);
    if (paidRefs.length || tab) this.reconcileBills(rules, now, { orderId: orderKey, pos: true });
    // what its Shopify order is made of, fixed now: custom lines at what each paid, and the tab's things as products at
    // the tab's price (so stock comes off)
    const orderLines = [
      ...lines.map((l) => ({ title: l.title, cents: l.cents })),
      ...tabThings.map((t) => ({ variantId: String(t.variantId), qty: Number(t.qty) || 1, cents: Number(t.price) || 0, title: t.title })),
    ];
    const staffRow = who.customerId ? this.memberRow(who.customerId) : null;
    const byName = String(staffRow?.first_name || String(staffRow?.name || '').trim().split(/\s+/)[0] || '').slice(0, 40) || null;
    this.write(
      `UPDATE cash_requests SET status = 'paid', total = ?, items = ?, lines = ?, paid_at = ?, by = ?, by_name = ?, order_status = 'due', updated_at = ?
         WHERE id = ? AND status = 'waiting'`,
      total, JSON.stringify(items), JSON.stringify(orderLines), now, who.customerId ? String(who.customerId) : 'staff', byName, now, fresh.id,
    );
    this.startCashOrder(fresh.id);
    return { cash: this.cashView(this.cashRow(fresh.id), { staff: true }), notices: counter.notices || [] };
  },

  /** POST /cash/:id/cancel (staff with Check-in or Money): not paid. Nothing's paid or changed. → { cash }. No awaits. */
  cashNotPaid(id, who) {
    this.requireStaff(who, CASH_STAFF);
    const row = this.cashRow(id);
    if (!row) throw new RuleError(CASH_WORDS.noRequest, 404);
    if (row.status === 'paid') throw new RuleError(CASH_WORDS.done('paid'), 409);
    const now = Date.now();
    if (row.status === 'waiting') {
      this.write("UPDATE cash_requests SET status = 'ended', ended_at = ?, ended_by = 'staff', updated_at = ? WHERE id = ? AND status = 'waiting'", now, now, row.id);
    }
    return { cash: this.cashView(this.cashRow(row.id), { staff: true }) };
  },

  /* ---------------- its Shopify order (as store credit's damage orders) ---------------- */
  /** Start the Shopify order for cash taken, in the background. No awaits. */
  startCashOrder(id) {
    const making = this.cashOrder(id);
    if (making) this.later(making);
    return Boolean(making);
  },

  /**
   * Claim and make the Shopify order for cash taken, or try again when an earlier try didn't finish. One whose time
   * hasn't come is left alone, so overlapping runs never make it twice. Returns the try (to wait for), or null. No
   * awaits before the claim.
   */
  cashOrder(id) {
    const r = this.cashRow(id);
    if (!r || r.status !== 'paid' || !['due', 'making', 'failed'].includes(r.order_status)) return null;
    const now = Date.now();
    if (r.order_next_at != null && r.order_next_at > now) return null;
    // (Shopify not connected: it waits for the next run that can)
    if (!this.shopify?.configured) return null;
    const tries = (r.order_tries || 0) + 1;
    if (tries > ORDER_RETRY.length + 2) {
      this.cashOrderStopped(r, r.order_error || "Shopify didn't answer.", now);
      return null;
    }
    this.write("UPDATE cash_requests SET order_status = 'making', order_tries = ?, order_next_at = ? WHERE id = ?", tries, now + ORDER_STUCK, id);
    return this.sendCashOrder(id, tries);
  },

  /**
   * Ask Shopify for the order, never twice: a draft kept from an earlier try is looked at first; a try that may have
   * made one looks for it by its marker (as an order, then a draft); only then is a draft made (kept at once, before
   * it's completed). The try after the last only looks. Every Shopify call gives up after 30 seconds.
   */
  async sendCashOrder(id, tries) {
    const shopify = this.shopify;
    const lookOnly = tries > ORDER_RETRY.length + 1;
    const mine = () => {
      const row = this.cashRow(id);
      return row?.order_status === 'making' && row.order_tries === tries ? row : null;
    };
    const superseded = { cash: id, superseded: true };
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
          this.write('UPDATE cash_requests SET order_draft = NULL WHERE id = ?', id);
        }
      }
      let searched = false;
      if (!order && !draft && r.order_sent_at) {
        searched = true;
        order = await shopify.findMarkedOrder(r.customer_id, CASH_ORDER_TAG, CASH_MARKER, id);
        if (!(r = mine())) return superseded;
        if (!order) {
          const found = await shopify.findMarkedDraft(r.customer_id, CASH_ORDER_TAG, CASH_MARKER, id);
          if (!(r = mine())) return superseded;
          if (found) {
            draft = found.id;
            order = found.order;
            this.write('UPDATE cash_requests SET order_draft = ? WHERE id = ?', draft, id);
            r = mine();
          }
        }
      }
      if (!order && lookOnly) {
        if (!searched) {
          order = await shopify.findMarkedOrder(r.customer_id, CASH_ORDER_TAG, CASH_MARKER, id);
          if (!(r = mine())) return superseded;
        }
        if (!order) {
          // --- no awaits from here on ---
          this.cashOrderStopped(r, r.order_error || 'Shopify made no order.', Date.now());
          return { cash: id, order: null, stopped: true };
        }
      }
      if (!order && !draft) {
        if ((r.order_next_at || 0) - Date.now() < ORDER_SEND_MARGIN) throw new Error("Shopify was slow, so the order wasn't asked for this time.");
        this.write('UPDATE cash_requests SET order_sent_at = COALESCE(order_sent_at, ?) WHERE id = ?', Date.now(), id);
        const made = await shopify.createPaidLinesDraft({
          customerId: r.customer_id, lines: parse(r.lines, []), currency: this.env?.CURRENCY || 'NZD', tags: [CASH_ORDER_TAG, 'cash'],
          // (no booking codes in the note: the orders/paid webhook reads them from a draft's note)
          note: `Paid in cash at the Lair counter${r.by_name ? `, taken by ${r.by_name}` : ''} (${id}).`,
          marker: { [CASH_MARKER]: id },
        });
        this.write('UPDATE cash_requests SET order_draft = COALESCE(order_draft, ?) WHERE id = ?', made.id, id);
        if (this.cashRow(id)?.order_draft !== made.id) this.later(shopify.deleteDraftIfOpen(made.id));
        if (!(r = mine())) return superseded;
        draft = r.order_draft;
        for (let i = 0, ready = made.ready; !ready && i < ORDER_READY_TRIES; i += 1) {
          await pause(ORDER_READY_WAIT);
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
      console.error('Lair: could not make the Shopify order for cash taken at the counter', error);
      const fresh = mine();
      if (!fresh) return superseded;
      this.cashOrderFailed(fresh, tries, String(error?.message || error).slice(0, 300), Date.now());
      return { cash: id, order: null };
    }
    // --- no awaits from here on ---
    this.write(
      "UPDATE cash_requests SET order_status = 'made', order_id = ?, order_name = ?, order_error = NULL, order_next_at = NULL WHERE id = ? AND order_tries = ?",
      order.id, order.name || null, id, tries,
    );
    if (order.total != null && order.total !== r.total) {
      const name = this.memberName(r.customer_id);
      this.staffAlert(`cash-total:${id}`, `A cash order doesn't match: ${name}`, {
        title: "A cash order that doesn't match",
        intro: `${name} paid ${dollars(r.total)} in cash, and Shopify's order for it came to ${dollars(order.total)}, so Shopify's sales are out by ${dollars(Math.abs(order.total - r.total))}. Check the shop's tax and discount settings, and put the order right in Shopify.`,
        details: [['Order', order.name || order.id], ['Cash taken', dollars(r.total)], ['Order total', dollars(order.total)]],
      }, Date.now());
    }
    return { cash: id, order: order.id };
  },

  /** A try didn't go: tried again after the next wait; after the last, one more look; after that, staff hear. No awaits. */
  cashOrderFailed(r, tries, error, now) {
    const wait = ORDER_RETRY[tries - 1] ?? (tries === ORDER_RETRY.length + 1 ? ORDER_LAST_LOOK : null);
    if (!wait) {
      this.cashOrderStopped(r, error, now);
      return;
    }
    this.write("UPDATE cash_requests SET order_status = 'failed', order_error = ?, order_next_at = ? WHERE id = ?", String(error).slice(0, 300), now + wait, r.id);
  },

  /**
   * The order couldn't be made however many times the Lair tried: it stops, and staff hear so they can finish it by
   * hand. The cash was taken and everything's paid either way: only Shopify's record of it is missing. No awaits.
   */
  cashOrderStopped(r, error, now) {
    this.write("UPDATE cash_requests SET order_status = 'stopped', order_error = ?, order_next_at = NULL WHERE id = ?", String(error).slice(0, 300), r.id);
    const name = this.memberName(r.customer_id);
    const draft = this.draftOrderUrl(r.order_draft);
    const lines = parse(r.lines, []);
    this.staffAlert(`cash-order:${r.id}`, `Cash with no Shopify order: ${name}`, {
      title: 'A cash order that needs making by hand',
      intro: `${name} paid ${dollars(r.total)} in cash${r.by_name ? ` (taken by ${r.by_name})` : ''} and everything's marked paid, but the Lair couldn't make its Shopify order, however many times it tried. Only Shopify's record of it is missing. ${draft
        ? 'Its draft order is in Shopify: open it (the link below) and mark it as paid. If it already shows as an order, there’s nothing to do.'
        : `Make it by hand in Shopify admin: Orders, Create order for ${name}, with what's below, then mark it as paid.`}`,
      details: [['Cash taken', dollars(r.total)], ['What it paid for', lines.map((l) => (l.variantId ? `${l.qty} × ${l.title}` : l.title)).join('\n')], ['Why', String(error).slice(0, 200)], ...(draft ? [['Draft order', draft]] : [])],
    }, now);
  },

  /** The 10-minute run: cash orders still to make, and ones whose wait is up or whose try never finished. → their ids */
  async retryCashOrders(now) {
    if (!this.shopify?.configured) return [];
    const due = this.sql.exec(
      `SELECT id FROM cash_requests WHERE status = 'paid' AND order_status IN ('due', 'making', 'failed') AND (order_next_at IS NULL OR order_next_at <= ?)
         ORDER BY COALESCE(order_next_at, 0), paid_at LIMIT ?`,
      now, ORDERS_A_RUN,
    ).toArray().map((r) => r.id);
    for (const id of due) {
      const making = this.cashOrder(id);
      if (making) await making;
    }
    return due;
  },
};

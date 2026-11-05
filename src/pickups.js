/**
 * Round 31 (retail, contract v31-retail section 3): pickups to pull. Mo's plan: a paid online order collected at the Lair
 * is ready within 2 hours while the shop's open, staff hear on the counter tablet, the staff page (with a chime) and by
 * email, pull it and tap Ready to collect (Shopify's own ready-for-pickup email), it's kept 2 weeks with reminders after
 * 3 and 10 days, then refunded. Mockups K-to-pull and K-counter-tile (Mo, 6 Nov 2026: "Love it!!!").
 *
 * - A pickup comes from the order's paid webhook (pickupFromPaid, for online orders) and from a 10-minute look at the
 *   last PICKUP_LOOKBACK of Shopify's pickup orders (pickupSweep), which also closes the ones Shopify shows fulfilled
 *   (collected) or cancelled.
 * - Staff (Check-in): GET /staff/pull, and POST /staff/pull/ready, /missing and /done.
 * - pickupUpkeep sends the reminders (9am to 9pm at the Lair) and marks a pickup kept PICKUP_KEEP_DAYS as Refund due,
 *   with one email to the shop.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { HOUR, LairTime, RuleError } from './core.js';
import { emailReady } from './shopify.js';
import { REMIND_FROM_HOUR, REMIND_UNTIL_HOUR } from './reminders.js';

/** Ready within this much opening time of being paid (Shopify's pickup time setting says the same: 2 hours) */
export const PICKUP_PROMISE_MINUTES = 120;
/** Kept this many days after Ready, then refunded */
export const PICKUP_KEEP_DAYS = 14;
/** Reminders to the customer, this many days after Ready */
export const PICKUP_REMIND_DAYS = [3, 10];
/** How far back the 10-minute look goes for pickup orders the webhook missed */
export const PICKUP_LOOKBACK = 3 * 24 * HOUR;
const DAY = 24 * HOUR;

/** Everything customers and staff read from here, word for word in the contract */
export const PICKUP_WORDS = {
  notFound: "That pickup isn't on the list any more. Refresh the page.",
  notNew: 'That pickup is already marked.',
  noShopify: "Shopify didn't answer. Nothing changed. Try again in a minute.",
  noPermission: "Shopify won't let the Lair mark pickups ready yet. Approve the Lair app's new permission in Shopify (Apps › Dice Goblin Lair), or mark it ready in Shopify for now.",
  refused: (why) => `Shopify said no: ${why}`,
  lines: 'Say which lines are missing, or leave them out for the whole order.',
  // staff's email for each new one
  staffSubject: (name, what) => `Pickup ${name} to pull: ${what}`,
  staffTitle: 'A pickup to pull',
  staffIntro: (who, by) => `${who} paid online and collects at the counter. Pull it, put it behind the counter and tap Ready to collect on the staff page. Promised by ${by}.`,
  refundSubject: (name) => `Refund due: pickup ${name} wasn't collected`,
  refundIntro: (name, days) => `Pickup ${name} has waited ${days} days. Refund it to their card in Shopify (or store credit if they ask), and don't restock it unless it's back on the shelf. Then tap Done on the staff page.`,
  // the customer's reminders (transactional: about their own order)
  remindSubject: (name, last) => (last ? `Last reminder: your order ${name} is at the Lair` : `Your order ${name} is waiting at the Lair`),
  remindTitle: 'Your order is waiting',
  remindIntro: 'Gobgob is guarding your order behind the counter. Come and grab it whenever we\'re open.',
  keptUntil: (day) => `${day}, then it's refunded to your card`,
  directions: 'Get directions',
  // not on the shelf
  missingSubject: (name, all) => (all ? `Sorry, your order ${name} isn't here` : `Sorry, part of your order ${name} isn't here`),
  missingTitle: "Sorry, it's not on the shelf",
  missingIntro: (what) => `We went to pull your order and ${what} wasn't on the shelf. Our count was wrong, and that's on us.`,
  missingRefund: (amount) => `We're refunding ${amount} to your card. Shopify emails you when it's done.`,
  missingRest: 'The rest of your order is still ready to collect.',
  missingSignoff: 'Sorry again,\nGobgob, the Dice Goblin',
};

const parse = (text, fallback) => {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) ?? fallback;
  } catch {
    return fallback;
  }
};
const money = (c) => `$${(Math.max(0, c) / 100).toFixed(2)}`;
const lineWords = (l) => `${l.title}${l.variantTitle ? `: ${l.variantTitle}` : ''}${l.quantity > 1 ? ` × ${l.quantity}` : ''}`;
const whatOf = (lines) => {
  const words = lines.map(lineWords);
  if (words.length <= 1) return words[0] || 'your order';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
};
/** "Sam K.": a first name and the last name's initial, or "A customer" */
const shortName = (first, last) => {
  const f = String(first || '').trim();
  const l = String(last || '').trim();
  if (!f && !l) return 'A customer';
  return f ? `${f}${l ? ` ${l[0].toUpperCase()}.` : ''}` : `${l[0].toUpperCase()}.`;
};

export const pickupMethods = {
  /**
   * From the order's paid webhook (lair.js ordersPaid, online orders only): whether Shopify has it as a pickup, and if
   * so it goes on the list and the shop hears. Never throws: the 10-minute look catches anything missed.
   */
  async pickupFromPaid(orderId) {
    try {
      if (!this.shopify.configured) return null;
      const id = String(orderId || '').split('/').pop();
      if (!/^\d+$/.test(id)) return null;
      const rules = await this.rules();
      const found = await this.retail().pickupOrders(Date.now() - PICKUP_LOOKBACK, { orderId: id });
      // --- no awaits from here ---
      const now = Date.now();
      return found.filter((o) => o.orderId === id).map((o) => this.pickupAdd(o, rules, now)).filter(Boolean).length;
    } catch (error) {
      console.error('Lair: could not check a paid order for a pickup', error);
      return null;
    }
  },

  /**
   * A pickup order from Shopify onto the list, once: paid, not cancelled, online, with something to collect. Its
   * Promised by is PICKUP_PROMISE_MINUTES of opening time after it was paid, and the shop gets one email. → whether it
   * was new. No awaits.
   */
  pickupAdd(o, rules, now) {
    if (o.cancelled || !o.online || !o.lines.length || !['PAID', 'PARTIALLY_REFUNDED'].includes(o.financial)) return false;
    if (['FULFILLED', 'RESTOCKED'].includes(o.fulfilment)) return false;
    if (this.sql.exec('SELECT 1 AS n FROM pickups WHERE order_id = ?', o.orderId).toArray().length) return false;
    const due = this.openMinutesAfter(rules, o.paidAt, PICKUP_PROMISE_MINUTES) ?? o.paidAt + PICKUP_PROMISE_MINUTES * 60_000;
    const who = shortName(o.firstName, o.lastName);
    this.write(
      `INSERT OR IGNORE INTO pickups (order_id, name, customer_id, customer_name, email, lines, paid_at, due_at, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
      o.orderId, o.name, o.customerId, who, o.email, JSON.stringify(o.lines), o.paidAt, due, now,
    );
    if (!this.retailChanged()) return false;
    this.pickupTellStaff(o.orderId, rules);
    return true;
  },

  /** The shop's one email about a new pickup (STAFF_EMAIL), marked so it's never sent twice. No awaits. */
  pickupTellStaff(orderId, rules) {
    const row = this.sql.exec('SELECT * FROM pickups WHERE order_id = ?', orderId).toArray()[0];
    if (!row || row.staff_mailed) return;
    this.write('UPDATE pickups SET staff_mailed = 1 WHERE order_id = ?', orderId);
    const lines = parse(row.lines, []);
    const time = new LairTime(rules.tz);
    const by = this.pickupClock(time, row.due_at, Date.now());
    this.notifyStaff(PICKUP_WORDS.staffSubject(row.name, whatOf(lines)), {
      title: PICKUP_WORDS.staffTitle,
      intro: PICKUP_WORDS.staffIntro(row.customer_name || 'A customer', by),
      details: [['Order', row.name], ['What', lines.map(lineWords).join('\n')], ['For', row.customer_name], ['Promised by', by]],
    });
  },

  /** "6:12pm", "6:12pm tomorrow" or "6:12pm Saturday": a time staff and customers can read at a glance. No awaits. */
  pickupClock(time, ms, now) {
    const minutes = time.minutesOf(ms);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const clock = h === 0 && m === 0 ? 'midnight' : `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
    const days = time.daysBetween(time.key(now), time.key(ms));
    if (days === 0) return clock;
    if (days === 1) return `${clock} tomorrow`;
    const day = new Intl.DateTimeFormat('en-NZ', { timeZone: time.tz, weekday: 'long' }).format(new Date(ms));
    return `${clock} ${day}`;
  },

  /**
   * The 10-minute look: pickup orders from the last PICKUP_LOOKBACK the webhook missed go on the list, and open ones
   * Shopify shows collected (fulfilled) or cancelled come off. → { added, closed } or null. Every await first.
   */
  async pickupSweep(rules, now) {
    if (!this.shopify.configured) return null;
    const api = this.retail();
    const found = await api.pickupOrders(now - PICKUP_LOOKBACK);
    const open = this.sql.exec("SELECT order_id FROM pickups WHERE status IN ('new', 'ready', 'missing') ORDER BY paid_at LIMIT 100").toArray().map((r) => r.order_id);
    const state = open.length ? await api.ordersState(open) : new Map();
    // --- no awaits from here ---
    let added = 0;
    for (const o of found) if (this.pickupAdd(o, rules, now)) added += 1;
    let closed = 0;
    for (const id of open) {
      const s = state.get(id);
      if (!s) continue;
      const how = s.cancelled ? 'cancelled' : s.fulfilment === 'FULFILLED' ? 'collected' : null;
      if (!how) continue;
      this.write("UPDATE pickups SET status = 'closed', closed_at = ?, closed_how = ? WHERE order_id = ? AND status IN ('new', 'ready', 'missing')", now, how, id);
      if (this.retailChanged()) closed += 1;
    }
    return added || closed ? { added, closed } : null;
  },

  /** One pickup as staff see it (GET /staff/pull). No awaits. */
  pickupView(row, now) {
    const missing = parse(row.missing, []);
    return {
      orderId: row.order_id, name: row.name, customer: row.customer_name || 'A customer',
      items: parse(row.lines, []).map((l) => ({ lineId: l.lineId, title: l.title, variantTitle: l.variantTitle || '', quantity: l.quantity })),
      paidAt: row.paid_at, dueAt: row.due_at, status: row.status, readyAt: row.ready_at ?? null, missing,
      refundDue: row.status === 'missing' || Boolean(row.refund_due_at),
      waiting: row.ready_at ? Math.floor((now - row.ready_at) / DAY) : null,
    };
  },

  /** GET /staff/pull (Check-in): { pickups, newest }, open ones newest first. No awaits. */
  staffPull(who) {
    this.requireStaff(who, 'checkin');
    const now = Date.now();
    const rows = this.sql.exec("SELECT * FROM pickups WHERE status IN ('new', 'ready', 'missing') ORDER BY paid_at DESC LIMIT 200").toArray();
    return { pickups: rows.map((r) => this.pickupView(r, now)), newest: rows.length ? Math.max(...rows.map((r) => r.paid_at)) : null };
  },

  /** An open pickup by its order's number, or a 404 */
  pickupOpen(orderId) {
    const id = String(orderId ?? '').split('/').pop();
    const row = /^\d+$/.test(id) ? this.sql.exec("SELECT * FROM pickups WHERE order_id = ? AND status IN ('new', 'ready', 'missing')", id).toArray()[0] : null;
    if (!row) throw new RuleError(PICKUP_WORDS.notFound, 404);
    return row;
  },

  /**
   * POST /staff/pull/ready { orderId } (Check-in): Shopify marks it prepared for pickup and emails the customer, then it's
   * Ready here. → { ok, pickup }. Every await first (Shopify), then the write.
   */
  async pickupReady(input, who) {
    this.requireStaff(who, 'checkin');
    const row = this.pickupOpen(input?.orderId);
    if (row.status === 'ready') throw new RuleError(PICKUP_WORDS.notNew, 409);
    let answer;
    try {
      answer = await this.retail().markReady(row.order_id);
    } catch (error) {
      const text = String(error?.message || error);
      if (/access denied|access_denied|required access|not approved|merchant_managed/i.test(text)) throw new RuleError(PICKUP_WORDS.noPermission, 503);
      throw new RuleError(PICKUP_WORDS.noShopify, 502);
    }
    if (answer.errors?.length) throw new RuleError(PICKUP_WORDS.refused(answer.errors.join('; ')), 409);
    // --- no awaits from here ---
    const now = Date.now();
    this.write("UPDATE pickups SET status = 'ready', ready_at = COALESCE(ready_at, ?), ready_by = ? WHERE order_id = ?", now, String(who.customerId || ''), row.order_id);
    return { ok: true, pickup: this.pickupView(this.sql.exec('SELECT * FROM pickups WHERE order_id = ?', row.order_id).one(), now) };
  },

  /**
   * POST /staff/pull/missing { orderId, lineIds? } (Check-in): not on the shelf. The customer is emailed straight away
   * that it's being refunded, the Lair's count of what's missing goes to 0 in Shopify (once), and it shows Refund due
   * until staff tap Done. → { ok, pickup }. Every await first (Shopify's count), then the writes and the email.
   */
  async pickupMissing(input, who) {
    this.requireStaff(who, 'checkin');
    const row = this.pickupOpen(input?.orderId);
    const lines = parse(row.lines, []);
    let lineIds = lines.map((l) => String(l.lineId));
    if (input?.lineIds !== undefined) {
      if (!Array.isArray(input.lineIds) || !input.lineIds.length) throw new RuleError(PICKUP_WORDS.lines);
      const asked = input.lineIds.map((x) => String(x).split('/').pop());
      if (asked.some((x) => !lineIds.includes(x))) throw new RuleError(PICKUP_WORDS.lines);
      lineIds = [...new Set(asked)];
    }
    const gone = lines.filter((l) => lineIds.includes(String(l.lineId)));
    const locationId = this.retailLocationId();
    const changes = [...new Set(gone.map((l) => l.variantId).filter(Boolean))].map((variantId) => ({ variantId, quantity: 0 }));
    if (locationId && changes.length && this.shopify.configured) {
      try {
        await this.retail().setShelf(changes, locationId, `pickup-missing-${row.order_id}-${lineIds.join('-')}`.slice(0, 120), `logistics://dicegoblin.nz/pickup/${row.order_id}`);
      } catch (error) {
        console.error('Lair: could not set the count of a missing pickup line', error);
      }
    }
    // --- no awaits from here ---
    const now = Date.now();
    const missing = [...new Set([...parse(row.missing, []).map(String), ...lineIds])];
    this.write("UPDATE pickups SET status = 'missing', missing = ?, missing_at = ?, missing_by = ? WHERE order_id = ?", JSON.stringify(missing), now, String(who.customerId || ''), row.order_id);
    const all = missing.length >= lines.length;
    if (emailReady(this.env) && row.email) {
      const amount = gone.reduce((sum, l) => sum + (Number(l.price) || 0) * (Number(l.quantity) || 1), 0);
      this.later(this.mail(this.letter(row.email, PICKUP_WORDS.missingSubject(row.name, all), {
        title: PICKUP_WORDS.missingTitle,
        intro: [PICKUP_WORDS.missingIntro(whatOf(gone)), PICKUP_WORDS.missingRefund(money(amount)), ...(all ? [] : [PICKUP_WORDS.missingRest])],
        details: [['Order', row.name]],
        signoff: PICKUP_WORDS.missingSignoff,
      })));
      this.write('UPDATE pickups SET missing_mailed = 1 WHERE order_id = ?', row.order_id);
    }
    return { ok: true, pickup: this.pickupView(this.sql.exec('SELECT * FROM pickups WHERE order_id = ?', row.order_id).one(), now) };
  },

  /**
   * POST /staff/pull/done { orderId } (Check-in): refunded or sorted. A pickup with nothing left to collect comes off
   * the list; one with lines still to collect goes back to where it was (Ready, or to pull). → { ok }. No awaits.
   */
  pickupDone(input, who) {
    this.requireStaff(who, 'checkin');
    const row = this.pickupOpen(input?.orderId);
    const now = Date.now();
    const lines = parse(row.lines, []);
    const missing = parse(row.missing, []).map(String);
    const left = lines.filter((l) => !missing.includes(String(l.lineId)));
    if (!left.length || row.refund_due_at) {
      this.write("UPDATE pickups SET status = 'closed', closed_at = ?, closed_how = 'done' WHERE order_id = ?", now, row.order_id);
    } else {
      this.write('UPDATE pickups SET status = ?, lines = ?, missing = NULL WHERE order_id = ?', row.ready_at ? 'ready' : 'new', JSON.stringify(left), row.order_id);
    }
    return { ok: true };
  },

  /**
   * The customer's reminders, PICKUP_REMIND_DAYS after Ready (9am to 9pm at the Lair, one each), and Refund due once it's
   * been kept PICKUP_KEEP_DAYS (one email to the shop). → { reminded, refundDue } or null. No awaits until the sends.
   */
  pickupUpkeep(rules, now) {
    const time = new LairTime(rules.tz);
    const hour = Math.floor(time.minutesOf(now) / 60);
    const daytime = hour >= REMIND_FROM_HOUR && hour < REMIND_UNTIL_HOUR;
    let reminded = 0;
    let refundDue = 0;
    const rows = this.sql.exec("SELECT * FROM pickups WHERE status = 'ready' AND ready_at IS NOT NULL ORDER BY ready_at LIMIT 200").toArray();
    for (const row of rows) {
      const days = (now - row.ready_at) / DAY;
      if (days >= PICKUP_KEEP_DAYS && !row.refund_due_at) {
        this.write('UPDATE pickups SET refund_due_at = ? WHERE order_id = ? AND refund_due_at IS NULL', now, row.order_id);
        if (this.retailChanged()) {
          refundDue += 1;
          this.notifyStaff(PICKUP_WORDS.refundSubject(row.name), {
            title: 'A refund to do', intro: PICKUP_WORDS.refundIntro(row.name, PICKUP_KEEP_DAYS),
            details: [['Order', row.name], ['What', parse(row.lines, []).map(lineWords).join('\n')], ['For', row.customer_name]],
          });
        }
        continue;
      }
      const next = PICKUP_REMIND_DAYS[row.reminded];
      if (!daytime || next === undefined || days < next || row.refund_due_at || !row.email || !emailReady(this.env)) continue;
      this.write('UPDATE pickups SET reminded = ? WHERE order_id = ? AND reminded = ?', row.reminded + 1, row.order_id, row.reminded);
      if (!this.retailChanged()) continue;
      reminded += 1;
      const last = row.reminded + 1 >= PICKUP_REMIND_DAYS.length;
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-NZ', { timeZone: rules.tz, weekday: 'long', day: 'numeric', month: 'long' })
        .formatToParts(new Date(row.ready_at + PICKUP_KEEP_DAYS * DAY)).map((p) => [p.type, p.value]));
      const kept = `${parts.weekday} ${parts.day} ${parts.month}`;
      const maps = rules.contact?.maps || 'https://maps.app.goo.gl/7KdmJLTqZPe47kXG6';
      this.later(this.mail(this.letter(row.email, PICKUP_WORDS.remindSubject(row.name, last), {
        title: PICKUP_WORDS.remindTitle,
        intro: PICKUP_WORDS.remindIntro,
        details: [
          ['Order', row.name], ['What', parse(row.lines, []).map(lineWords).join('\n')], ['Open today', this.retailOpenLine(rules, now)],
          ['Where', 'Upstairs in Royal Oak Mall, above Whitcoulls'], ['Kept until', PICKUP_WORDS.keptUntil(kept)],
        ],
        button: { label: PICKUP_WORDS.directions, url: maps },
      })));
    }
    return reminded || refundDue ? { reminded, refundDue } : null;
  },
};

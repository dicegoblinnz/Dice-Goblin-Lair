/**
 * Round 25 (31 Oct 2026, contract v25-gw-orders): Games Workshop items ordered in. Mo: "If it's on our shelf, it says so.
 * If not, it's clearly ordered in from Games Workshop, not in store." Everything on GW's latest order pad keeps selling
 * when the shelf is empty (Shopify's "continue selling when out of stock"), and what the shelf can't cover is ordered in
 * from GW. Orders close at midnight at the end of Monday (Auckland); Mo orders on Tuesday, GW ships on Thursday, and it
 * should be with the customer two weeks after that Thursday: 17 days after the Monday ("Order by midnight Monday 2 Nov
 * and it should be with you by Thursday 19 Nov"). Mo picked one parcel: an order with ordered-in items goes out once it's
 * all in. Lair pickups get an email when it's in. The theme works out the same dates (snippets/gw-dates.liquid).
 *
 * What the Lair does:
 *  - A paid order with GW lines, online or at the counter (gwOrderPaid, from orders/paid): Shopify takes every sale off
 *    the stock, so a variant below zero right after the sale is short by that many. What the Lair already has down as
 *    ordered in for that variant is taken off first, and the rest (up to the line's quantity) is this line's ordered-in
 *    units. Only a variant that keeps selling counts (one that's dropped off the pad can't be ordered in). Worked out once
 *    per order. The order is tagged "Ordered in" with a note for the shop, and a customer with an email hears what's
 *    ordered in and when it should be with them. A product released after the order day counts from its release day.
 *  - From 6am on Tuesday, once per cutoff (gwOrderList): the GW order list, emailed to the shop: each code and how many
 *    packs to order, rounded up to GW's pack (variant metafield custom.gw_pack_size), ready to paste into the trade site
 *    and as a CSV, with the week's ordered-in sales, counter sales with no customer on them, and anything below zero that
 *    no order explains. A week the Warhammer tab skipped (gw.schedule) has no list: its orders are in the next week's.
 *  - Every maintenance run (gwReconcile): a line refunded or an order cancelled takes its ordered-in units off; stock going
 *    up (GW's delivery added to stock in Shopify) marks ordered-in units in, oldest order first. When all of an order's
 *    ordered-in units are in, a Lair pickup or counter customer hears it's in, and the shop hears what to pack or put aside.
 *    An order still waiting the day after its date is flagged to the shop once.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair. Each
 * async method does its awaits first, then reads fresh and writes with no awaits in between.
 */
import { LairTime, addDays } from './core.js';
import { emailReady } from './shopify.js';

const TZ = 'Pacific/Auckland';
const DAY = 24 * 3_600_000;

/** Whose products these are, as Shopify's vendor */
export const GW_VENDOR = 'Games Workshop';
/** A GW product code (the variant's SKU, from the order pad). Library copies' SKUs (DGLRPG-…) never match. */
const GW_CODE = /^\d{8,13}$/;
/** The Tuesday list goes out from this hour (Auckland) */
export const GW_LIST_HOUR = 6;
/** Days from the Monday cutoff: GW ships on the Thursday, and it should be with the customer two weeks after */
export const GW_SHIPS_DAYS = 3;
export const GW_PROMISE_DAYS = 17;
/** Most lines one order's GW check looks at, and ids one reconcile asks Shopify about */
const MOST_LINES = 50;
const MOST_IDS = 240;

/** Every word a customer or the shop reads, word for word in the contract */
export const GW_WORDS = {
  tag: 'Ordered in',
  note: (lines, promise) => `Ordered in from Games Workshop: ${lines}. Should be with them by ${promise}. One parcel: send it all once it's in.`,
  noteCounter: (lines, promise) => `Ordered in from Games Workshop at the counter: ${lines}. Should be in by ${promise}: put it aside for them.`,
  // the customer's email when it's ordered
  toldSubject: (name) => (name ? `Ordered in for you: order ${name}` : 'Ordered in for you'),
  toldTitle: 'Ordered in from Games Workshop',
  toldIntro: (first, some, promise) => `${first ? `Thanks, ${first}!` : 'Thanks for your order!'} ${some ? "Some of it isn't" : "It isn't"} on our shelf, so it's going on our next order from Games Workshop. It should be with you by ${promise}.`,
  toldRow: 'Ordered in',
  toldWhen: 'Should be with you by',
  toldOrder: 'Order',
  toldOutro: {
    ship: "We'll post your order in one parcel once everything's here.",
    pickup: "We'll email you when it's in at the Lair, ready to collect.",
    counter: "We'll email you when it's in, ready to collect at the Lair.",
  },
  refund: "If Games Workshop can't supply it, we'll let you know and refund it in full.",
  // the customer's email when it's in (Lair pickups and counter sales)
  inSubject: (name) => (name ? `It's in: order ${name} is ready to collect` : "It's in: your order is ready to collect"),
  inTitle: "It's in!",
  inIntro: (first) => `${first ? `${first}, your` : 'Your'} Games Workshop order has landed at the Lair. Gobgob has it behind the counter with your name on it.`,
  inRow: 'Ready to collect',
  inOutro: "Pop in and grab it whenever we're open.",
  signoff: 'Gobgob',
  // the shop's emails
  readySubject: (n) => `In from Games Workshop: ${n === 1 ? '1 order' : `${n} orders`} ready`,
  readyTitle: 'In from Games Workshop',
  readyIntro: "Everything these orders had ordered in is in stock now.",
  ready: {
    pickupTold: (who) => `${who} collects at the Lair: we've emailed them it's in.`,
    pickup: 'Collects at the Lair, no email on the order: let them know it\'s in.',
    ship: "Ready to pack and post: it's all in.",
    counterTold: (who) => `Counter sale for ${who}: we've emailed them. Put it aside.`,
    counter: 'Counter sale with no customer on it: put it aside for whoever ordered it.',
  },
  lateSubject: (n) => `Late from Games Workshop: ${n === 1 ? '1 order' : `${n} orders`}`,
  lateTitle: 'Still waiting on Games Workshop',
  lateIntro: 'These orders were due by the date shown and their ordered-in items aren\'t in stock yet. Check with GW, and let the customers know.',
  listSubject: (cutoff, codes) => `GW order for ${cutoff}: ${codes === 0 ? 'nothing ordered in' : codes === 1 ? '1 code' : `${codes} codes`}`,
  listTitle: "This week's Games Workshop order",
  listIntro: (cutoff) => `Orders closed at midnight on ${cutoff}. Here's what to order from Games Workshop for customers' ordered-in items, rounded up to GW's packs: paste these lines into the trade site, or use the CSV attached. Extras from a pack go on the shelf.`,
  listNothing: (cutoff) => `Orders closed at midnight on ${cutoff}, and nothing was ordered in from Games Workshop this week.`,
  listOutro: 'The Lair has these down as ordered. When GW\'s delivery comes, add it to stock in Shopify as usual, and the Lair emails the customers whose items are in.',
  listPacks: (title, units, packs, pack) => (pack > 1 ? `${title}: ${units} ordered in, so ${packs === 1 ? '1 pack' : `${packs} packs`} of ${pack} (${packs * pack - units} extra for the shelf)` : `${title}: ${units}`),
  weekRow: { online: 'Ordered in online', counter: 'Ordered in at the counter' },
  week: (orders, units, value) => `${orders === 1 ? '1 order' : `${orders} orders`}, ${units === 1 ? '1 item' : `${units} items`}, ${value}`,
  noCustomer: (name) => `Counter sale ${name}, no customer`,
  noCustomerWhat: (lines) => `${lines}: who's it for?`,
  belowZero: (code) => `${code} below zero`,
  belowZeroWhat: (title, n) => `${title}: ${n} below zero that no order explains. Check the count, and add it to the order if it's real.`,
  total: 'At NZ RRP',
};

/* ---------------- the dates ---------------- */

const validKey = (key) => /^\d{4}-\d{2}-\d{2}$/.test(String(key || ''));
const isoWeekday = (key) => new Date(`${key}T00:00:00Z`).getUTCDay() || 7;

/**
 * When an item ordered on `day` (YYYY-MM-DD, Auckland) should reach the customer: { cutoff (the Monday orders close at
 * midnight), ships (GW's Thursday), promise }. A product released after `day` counts from its release day. `overrides`
 * (shop metafield gw.schedule's): a Monday skipped joins the next week; ships or promise set for a Monday win.
 */
export function gwSchedule(day, release = '', overrides = {}) {
  const changes = overrides && typeof overrides === 'object' ? overrides : {};
  const start = validKey(release) && release > day ? release : day;
  let cutoff = addDays(start, (8 - isoWeekday(start)) % 7);
  for (let week = 0; week < 4 && changes[cutoff]?.skip === true; week += 1) cutoff = addDays(cutoff, 7);
  const change = changes[cutoff] || {};
  return {
    cutoff,
    ships: validKey(change.ships) ? change.ships : addDays(cutoff, GW_SHIPS_DAYS),
    promise: validKey(change.promise) ? change.promise : addDays(cutoff, GW_PROMISE_DAYS),
  };
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "Monday 9 Nov" (style 'cutoff'), "Thu 26 Nov" ('short') or "Thursday 26 November" (the default), as the theme says them */
export function gwLabel(key, style = 'long') {
  if (!validKey(key)) return '';
  const [, m, d] = key.split('-').map(Number);
  const day = DAYS[new Date(`${key}T00:00:00Z`).getUTCDay()];
  const month = MONTHS[m - 1];
  if (style === 'cutoff') return `${day} ${d} ${month.slice(0, 3)}`;
  if (style === 'short') return `${day.slice(0, 3)} ${d} ${month.slice(0, 3)}`;
  return `${day} ${d} ${month}`;
}

/* ---------------- small helpers ---------------- */

/** A line of a paid order that's a GW product (its vendor, and a GW code for its SKU) */
export const isGwItem = (item) => String(item?.vendor ?? '').trim() === GW_VENDOR && GW_CODE.test(String(item?.sku ?? '').trim());
/** Packs to order for `units`, GW's pack being `pack` */
export const packsFor = (units, pack) => Math.ceil(Math.max(0, units) / Math.max(1, Math.floor(pack) || 1));
const units = (n) => Math.max(0, Math.floor(Number(n) || 0));
const variantGid = (id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/ProductVariant/${id}`);
const lineGid = (id) => `gid://shopify/LineItem/${id}`;
const cents = (amount) => Math.max(0, Math.round(Number(amount || 0) * 100)) || 0;
/** $1,234 or $12.50 */
const money = (c) => {
  const whole = c % 100 === 0;
  const text = (c / 100).toLocaleString('en-NZ', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  return `$${text}`;
};
/** "2 × Combat Patrol: Space Marines" */
const lineText = (row, n = row.quantity) => `${n} × ${row.title}`;
const listText = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const base64 = (text) => btoa(unescape(encodeURIComponent(text)));
/** How it's reaching them: Shopify POS or Pay on Verifone ('counter'), a pickup at the Lair, posted, or none given */
export function deliveryOf(order, counter) {
  if (counter) return 'counter';
  const line = order?.shippingLine;
  if (!line) return 'none';
  return /pick|collect/i.test(`${line.deliveryCategory || ''} ${line.title || ''}`) ? 'pickup' : 'ship';
}

/**
 * The tables, made sure of on every start. gw_orders: one row per paid order with GW lines (units 0 when the shelf
 * covered them all) and every unit on the order (all_units: GW or not), who and how, and when the emails went.
 * gw_orderins: one row per order line with ordered-in units: how many (quantity), how many of those are in (arrived) or were taken off (cancelled), its GW code and pack, its dates,
 * and the cutoff whose Tuesday list it went on.
 */
export const GW_TABLES = [
  `CREATE TABLE IF NOT EXISTS gw_orders (
    order_id TEXT PRIMARY KEY, name TEXT, channel TEXT NOT NULL, delivery TEXT NOT NULL,
    customer_id TEXT, email TEXT, first_name TEXT, placed_at INTEGER NOT NULL, units INTEGER NOT NULL DEFAULT 0,
    all_units INTEGER NOT NULL DEFAULT 0, promise TEXT, told_at INTEGER, marked_at INTEGER, ready_at INTEGER, ready_told_at INTEGER, late_at INTEGER,
    created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gw_orderins (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL, line_id TEXT NOT NULL, variant_id TEXT NOT NULL, code TEXT NOT NULL,
    title TEXT NOT NULL, line_quantity INTEGER NOT NULL, quantity INTEGER NOT NULL, arrived INTEGER NOT NULL DEFAULT 0,
    cancelled INTEGER NOT NULL DEFAULT 0, pack INTEGER NOT NULL DEFAULT 1, price INTEGER NOT NULL DEFAULT 0,
    cutoff TEXT NOT NULL, promise TEXT NOT NULL, listed_for TEXT, placed_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS gw_orderins_variant ON gw_orderins (variant_id)',
  'CREATE INDEX IF NOT EXISTS gw_orderins_order ON gw_orderins (order_id)',
];

const OPEN = 'quantity > arrived + cancelled';

export const gwOrderMethods = {
  /** Ordered-in units of a variant not in yet and not taken off. No awaits. */
  gwOpenUnits(variantId) {
    return this.sql.exec(`SELECT COALESCE(SUM(quantity - arrived - cancelled), 0) AS n FROM gw_orderins WHERE variant_id = ? AND ${OPEN}`, variantId).one().n;
  },

  gwKnown(orderId) {
    return this.sql.exec('SELECT 1 AS n FROM gw_orders WHERE order_id = ?', orderId).toArray().length > 0;
  },

  /**
   * orders/paid: a paid order's GW lines (see the top of this file). Shopify is asked about the order and the lines'
   * variants in one request; if it can't answer, this throws and the webhook is sent again. Returns null when the order
   * has no GW lines (or they were worked out before), else { units, lines: [{ code, quantity, promise }] }.
   */
  async gwOrderPaid(order, orderId, { pos = false } = {}) {
    const items = (order?.line_items || []).filter((item) => isGwItem(item) && item.variant_id && units(item.quantity) > 0).slice(0, MOST_LINES);
    if (!items.length || !orderId || this.gwKnown(orderId)) return null;
    const found = await this.shopify.gwOrder(orderId, [...new Set(items.map((item) => variantGid(item.variant_id)))]);
    // --- no awaits from here on ---
    if (this.gwKnown(orderId)) return null; // another delivery of the webhook got here first
    const now = Date.now();
    const info = found?.order || {};
    const placedAt = Date.parse(info.createdAt || '') || now;
    const day = new LairTime(this.rulesCache?.tz || TZ).key(placedAt);
    const lines = [];
    for (const item of items) {
      const variant = found?.variants?.get(variantGid(item.variant_id));
      if (!variant || variant.tracked === false || variant.policy !== 'CONTINUE') continue;
      const quantity = units(item.quantity);
      const short = Math.max(0, -Math.floor(Number(variant.available) || 0));
      const ordered = Math.min(quantity, Math.max(0, short - this.gwOpenUnits(variant.id)));
      if (!ordered) continue;
      const when = gwSchedule(day, variant.release || '', found.overrides);
      const lineId = String(item.id ?? item.admin_graphql_api_id ?? '').split('/').pop();
      const row = {
        id: `${orderId}#${lineId}`, lineId, variantId: variant.id, code: String(item.sku).trim(),
        title: String(item.name || variant.title || item.title || 'Games Workshop item').replace(/ - Default Title$/, '').slice(0, 160),
        lineQuantity: quantity, quantity: ordered, pack: Math.max(1, Math.floor(Number(variant.pack) || 1)), price: cents(item.price), ...when,
      };
      this.write(
        `INSERT OR IGNORE INTO gw_orderins (id, order_id, line_id, variant_id, code, title, line_quantity, quantity, pack, price, cutoff, promise, placed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, orderId, row.lineId, row.variantId, row.code, row.title, row.lineQuantity, row.quantity, row.pack, row.price, row.cutoff, row.promise, placedAt, now,
      );
      lines.push(row);
    }
    const total = lines.reduce((sum, l) => sum + l.quantity, 0);
    const promise = lines.reduce((latest, l) => (l.promise > latest ? l.promise : latest), '') || null;
    const customer = info.customer || {};
    const email = String(info.email || customer.defaultEmailAddress?.emailAddress || '').trim().slice(0, 120);
    const fallback = String(customer.displayName || '').trim().split(/\s+/)[0] || '';
    const first = String(customer.firstName || info.billingAddress?.firstName || '').trim() || (fallback.includes('@') ? '' : fallback);
    this.write(
      `INSERT OR IGNORE INTO gw_orders (order_id, name, channel, delivery, customer_id, email, first_name, placed_at, units, all_units, promise, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      orderId, info.name || order.name || null, pos ? 'counter' : 'online', deliveryOf(info, pos),
      customer.id ? String(customer.id).split('/').pop() : null, email || null, first.slice(0, 40) || null, placedAt, total,
      (order.line_items || []).reduce((sum, item) => sum + units(item.quantity), 0), promise, now,
    );
    if (!total) return { units: 0, lines: [] };
    this.later(this.gwMark(orderId));
    if (email && emailReady(this.env)) this.later(this.gwTell(orderId));
    return { units: total, lines: lines.map((l) => ({ code: l.code, quantity: l.quantity, promise: l.promise })) };
  },

  /** An order's row and its ordered-in lines. No awaits. */
  gwOrderRows(orderId) {
    const order = this.sql.exec('SELECT * FROM gw_orders WHERE order_id = ?', orderId).toArray()[0] || null;
    const lines = this.sql.exec('SELECT * FROM gw_orderins WHERE order_id = ? ORDER BY id', orderId).toArray();
    return { order, lines };
  },

  /**
   * Tag the order "Ordered in" and add the shop's note (needs the app's write_orders). Never throws: when Shopify says no
   * (the scope not approved yet), maintenance tries again for two weeks.
   */
  async gwMark(orderId) {
    const { order, lines } = this.gwOrderRows(orderId);
    if (!order || order.marked_at || !lines.length) return false;
    const what = listText(lines.map((l) => `${lineText(l)} (${l.code})`));
    const promise = gwLabel(order.promise, 'short');
    const note = order.channel === 'counter' ? GW_WORDS.noteCounter(what, promise) : GW_WORDS.note(what, promise);
    try {
      await this.shopify.gwMarkOrder(orderId, GW_WORDS.tag, note);
    } catch (error) {
      console.error('Lair: could not tag a Games Workshop order', orderId, String(error?.message || error).slice(0, 200));
      return false;
    }
    this.write('UPDATE gw_orders SET marked_at = ? WHERE order_id = ? AND marked_at IS NULL', Date.now(), orderId);
    return true;
  },

  /** The customer's "ordered in for you" email, once */
  async gwTell(orderId) {
    const { order, lines } = this.gwOrderRows(orderId);
    if (!order?.email || order.told_at || !lines.length) return false;
    const some = order.units < order.all_units;
    const promise = gwLabel(order.promise);
    const outro = GW_WORDS.toldOutro[order.delivery] || GW_WORDS.toldOutro.pickup;
    const sent = await this.mail(this.letter(order.email, GW_WORDS.toldSubject(order.name), {
      title: GW_WORDS.toldTitle,
      intro: GW_WORDS.toldIntro(order.first_name, some, promise),
      details: [
        ...lines.map((l, i) => [i === 0 ? GW_WORDS.toldRow : '', lineText(l)]),
        [GW_WORDS.toldWhen, promise],
        [GW_WORDS.toldOrder, order.name || ''],
      ],
      outro: [outro, GW_WORDS.refund],
      signoff: GW_WORDS.signoff,
    }, { idempotencyKey: `gw-told-${String(orderId).split('/').pop()}` }));
    if (sent?.ok) this.write('UPDATE gw_orders SET told_at = ? WHERE order_id = ?', Date.now(), orderId);
    return Boolean(sent?.ok);
  },

  /**
   * Every maintenance run: refunds and cancellations, then what's come in (see the top of this file). Shopify is asked
   * about every open line's variant, order and order line in one request.
   */
  async gwReconcile(now = Date.now()) {
    const result = {};
    // tags and notes Shopify turned down before (the scope wasn't approved yet), a few a run for two weeks
    const unmarked = this.sql.exec('SELECT order_id FROM gw_orders WHERE units > 0 AND marked_at IS NULL AND created_at > ? ORDER BY created_at LIMIT 3', now - 14 * DAY).toArray();
    let marked = 0;
    for (const row of unmarked) if (await this.gwMark(row.order_id)) marked += 1;
    if (marked) result.marked = marked;
    const before = this.sql.exec(`SELECT order_id, line_id, variant_id FROM gw_orderins WHERE ${OPEN} ORDER BY placed_at, id LIMIT 80`).toArray();
    if (!before.length) return Object.keys(result).length ? result : null;
    const ids = [...new Set(before.flatMap((r) => [r.variant_id, r.order_id, lineGid(r.line_id)]))].slice(0, MOST_IDS);
    const state = await this.shopify.gwState(ids);
    // --- no awaits from here on: read the open lines fresh ---
    const open = this.sql.exec(`SELECT * FROM gw_orderins WHERE ${OPEN} ORDER BY placed_at, id`).toArray();
    const touched = new Set();
    let cancelled = 0;
    // 1. a cancelled order, or units taken off a line (a refund or an edit): its ordered-in units go first
    for (const row of open) {
      const order = state.get(row.order_id);
      const line = state.get(lineGid(row.line_id));
      let gone = row.cancelled;
      if (order?.cancelledAt) gone = row.quantity - row.arrived;
      else if (line && Number.isFinite(line.currentQuantity)) gone = Math.max(row.cancelled, Math.min(row.quantity - row.arrived, row.line_quantity - line.currentQuantity));
      if (gone > row.cancelled) {
        this.write('UPDATE gw_orderins SET cancelled = ? WHERE id = ?', gone, row.id);
        cancelled += gone - row.cancelled;
        row.cancelled = gone;
        touched.add(row.order_id);
      }
    }
    // 2. stock that's come in: what a variant has beyond what it's short goes to its open lines, oldest order first
    let arrived = 0;
    const byVariant = new Map();
    for (const row of open) if (row.quantity > row.arrived + row.cancelled) byVariant.set(row.variant_id, [...(byVariant.get(row.variant_id) || []), row]);
    for (const [variantId, rows] of byVariant) {
      const variant = state.get(variantId);
      if (!variant || !Number.isFinite(variant.available)) continue;
      const short = Math.max(0, -Math.floor(variant.available));
      let spare = rows.reduce((sum, r) => sum + r.quantity - r.arrived - r.cancelled, 0) - short;
      for (const row of rows) {
        if (spare <= 0) break;
        const take = Math.min(spare, row.quantity - row.arrived - row.cancelled);
        this.write('UPDATE gw_orderins SET arrived = ? WHERE id = ?', row.arrived + take, row.id);
        row.arrived += take;
        spare -= take;
        arrived += take;
        touched.add(row.order_id);
      }
    }
    if (cancelled) result.cancelled = cancelled;
    if (arrived) result.arrived = arrived;
    // 3. orders with nothing left to come: in (an email and the shop told), or all taken off (nothing to say)
    const ready = [];
    for (const orderId of touched) {
      const { order, lines } = this.gwOrderRows(orderId);
      if (!order || order.ready_at || lines.some((l) => l.quantity > l.arrived + l.cancelled)) continue;
      this.write('UPDATE gw_orders SET ready_at = ? WHERE order_id = ?', now, orderId);
      if (lines.some((l) => l.arrived > 0)) ready.push({ order, lines: lines.filter((l) => l.arrived > 0) });
    }
    if (ready.length) {
      result.ready = ready.map((r) => r.order.name || r.order.order_id);
      this.gwTellReady(ready);
    }
    // 4. orders past their date with something still to come: the shop hears once
    const today = new LairTime(this.rulesCache?.tz || TZ).key(now);
    const late = this.sql.exec(
      `SELECT * FROM gw_orders WHERE ready_at IS NULL AND late_at IS NULL AND units > 0 AND promise IS NOT NULL AND promise < ?
       AND order_id IN (SELECT order_id FROM gw_orderins WHERE ${OPEN}) ORDER BY placed_at LIMIT 20`,
      today,
    ).toArray();
    if (late.length) {
      for (const order of late) this.write('UPDATE gw_orders SET late_at = ? WHERE order_id = ?', now, order.order_id);
      this.notifyStaff(GW_WORDS.lateSubject(late.length), {
        title: GW_WORDS.lateTitle,
        intro: GW_WORDS.lateIntro,
        details: late.map((o) => {
          const waiting = this.sql.exec(`SELECT * FROM gw_orderins WHERE order_id = ? AND ${OPEN}`, o.order_id).toArray();
          return [`${o.name || 'Order'}${o.first_name ? ` (${o.first_name})` : ''}, due ${gwLabel(o.promise, 'short')}`, listText(waiting.map((l) => lineText(l, l.quantity - l.arrived - l.cancelled)))];
        }),
      });
      result.late = late.map((o) => o.name || o.order_id);
    }
    return Object.keys(result).length ? result : null;
  },

  /** Orders whose ordered-in items are all in: their customers (pickups and counter sales) and the shop. No awaits. */
  gwTellReady(ready) {
    const rows = [];
    for (const { order, lines } of ready) {
      const what = listText(lines.map((l) => lineText(l, l.arrived)));
      const collect = order.delivery !== 'ship';
      const tell = collect && order.email && emailReady(this.env);
      const who = order.first_name || order.email || '';
      let action;
      if (order.delivery === 'ship') action = GW_WORDS.ready.ship;
      else if (order.delivery === 'counter') action = tell ? GW_WORDS.ready.counterTold(who) : GW_WORDS.ready.counter;
      else action = tell ? GW_WORDS.ready.pickupTold(who) : GW_WORDS.ready.pickup;
      rows.push([`${order.name || 'Order'}: ${what}`, action]);
      if (!tell) continue;
      this.later((async () => {
        const sent = await this.mail(this.letter(order.email, GW_WORDS.inSubject(order.name), {
          title: GW_WORDS.inTitle,
          intro: GW_WORDS.inIntro(order.first_name),
          details: [[GW_WORDS.inRow, what], [GW_WORDS.toldOrder, order.name || '']],
          outro: GW_WORDS.inOutro,
          signoff: GW_WORDS.signoff,
        }, { idempotencyKey: `gw-in-${String(order.order_id).split('/').pop()}` }));
        if (sent?.ok) this.write('UPDATE gw_orders SET ready_told_at = ? WHERE order_id = ?', Date.now(), order.order_id);
      })());
    }
    this.notifyStaff(GW_WORDS.readySubject(ready.length), { title: GW_WORDS.readyTitle, intro: GW_WORDS.readyIntro, details: rows });
  },

  /** The cutoff whose Tuesday list is due at `now` (the last Monday before today), or null before 6am on the Tuesday */
  gwListDue(now, tz = TZ) {
    const time = new LairTime(tz);
    const today = time.key(now);
    const back = (time.weekday(today) + 6) % 7; // days since Monday, 0 on a Monday
    const cutoff = addDays(today, back === 0 ? -7 : -back);
    if (today === addDays(cutoff, 1) && time.parts(now).h < GW_LIST_HOUR) return null;
    return cutoff;
  },

  /**
   * From 6am on Tuesday, once per cutoff: the GW order list (see the top of this file). The first run after this goes
   * live only notes the week, so the first list is the first whole week. The list is marked as sent only once the email
   * has gone, so a failed send is tried again on the next run (Resend's key stops it going twice).
   */
  async gwOrderList(rules, now = Date.now()) {
    const to = String(this.env.GW_ORDER_EMAIL || this.env.STAFF_EMAIL || '').trim();
    if (!emailReady(this.env) || !to) return null;
    const cutoff = this.gwListDue(now, rules?.tz || TZ);
    if (!cutoff) return null;
    const last = () => this.sql.exec("SELECT value FROM meta WHERE key = 'gw-list'").toArray()[0]?.value || '';
    if (last() >= cutoff) return null;
    if (!last()) {
      this.write("INSERT OR REPLACE INTO meta (key, value) VALUES ('gw-list', ?)", cutoff);
      return { list: cutoff, baseline: true };
    }
    const found = await this.shopify.gwBelowZero();
    // --- no awaits from here on ---
    if (last() >= cutoff) return null;
    if (found?.overrides?.[cutoff]?.skip === true) {
      this.write("INSERT OR REPLACE INTO meta (key, value) VALUES ('gw-list', ?)", cutoff);
      return { list: cutoff, skipped: true };
    }
    const rows = this.sql.exec('SELECT * FROM gw_orderins WHERE listed_for IS NULL AND cutoff <= ? ORDER BY code, placed_at', cutoff).toArray();
    // each code: what's still to come from GW, in packs
    const codes = new Map();
    for (const row of rows) {
      const need = row.quantity - row.arrived - row.cancelled;
      if (need <= 0) continue;
      const code = codes.get(row.code) || { code: row.code, title: row.title, units: 0, pack: 1, price: row.price };
      code.units += need;
      code.pack = Math.max(code.pack, row.pack);
      codes.set(row.code, code);
    }
    const order = [...codes.values()].map((c) => ({ ...c, packs: packsFor(c.units, c.pack) }));
    const paste = order.map((c) => `${c.code},${c.packs}`).join('\n');
    const value = order.reduce((sum, c) => sum + c.packs * c.pack * c.price, 0);
    // the week's ordered-in sales, by where they were made
    const week = this.sql.exec(
      `SELECT o.channel AS channel, COUNT(DISTINCT o.order_id) AS orders, SUM(l.quantity - l.cancelled) AS units, SUM((l.quantity - l.cancelled) * l.price) AS value
       FROM gw_orderins l JOIN gw_orders o ON o.order_id = l.order_id WHERE l.cutoff = ? AND l.quantity > l.cancelled GROUP BY o.channel ORDER BY o.channel DESC`,
      cutoff,
    ).toArray();
    // counter sales with no customer on them, whose items are on this list
    const listedOrders = [...new Set(rows.map((r) => r.order_id))];
    const unknown = [];
    for (const orderId of listedOrders) {
      const { order: o, lines } = this.gwOrderRows(orderId);
      if (o?.channel === 'counter' && !o.email && !o.customer_id) unknown.push([GW_WORDS.noCustomer(o.name || ''), GW_WORDS.noCustomerWhat(listText(lines.map((l) => lineText(l))))]);
    }
    // below zero with no ordered-in units to explain it
    const odd = [];
    for (const v of found?.variants || []) {
      if (v.policy !== 'CONTINUE' || !GW_CODE.test(String(v.code || ''))) continue;
      const extra = Math.max(0, -Math.floor(Number(v.available) || 0)) - this.gwOpenUnits(v.id);
      if (extra > 0 && v.code) odd.push([GW_WORDS.belowZero(v.code), GW_WORDS.belowZeroWhat(v.title, extra)]);
    }
    const label = gwLabel(cutoff, 'cutoff');
    const details = [
      ...order.map((c) => [c.code, GW_WORDS.listPacks(c.title, c.units, c.packs, c.pack)]),
      ...(order.length ? [[GW_WORDS.total, money(value)]] : []),
      ...week.map((w) => [GW_WORDS.weekRow[w.channel] || w.channel, GW_WORDS.week(w.orders, w.units, money(w.value))]),
      ...unknown,
      ...odd,
    ];
    const csv = `Product code,Quantity\n${order.map((c) => `${c.code},${c.packs}`).join('\n')}${order.length ? '\n' : ''}`;
    const letter = this.letter(to, GW_WORDS.listSubject(label, order.length), {
      title: GW_WORDS.listTitle,
      intro: order.length ? GW_WORDS.listIntro(label) : GW_WORDS.listNothing(label),
      ...(order.length ? { quote: paste } : {}),
      details,
      outro: order.length ? GW_WORDS.listOutro : undefined,
      signoff: 'Gobgob, keeping count',
    }, {
      idempotencyKey: `gw-list-${cutoff}`,
      ...(order.length ? { attachments: [{ filename: `gw-order-${cutoff}.csv`, content: base64(csv) }] } : {}),
    });
    const ids = rows.map((r) => r.id);
    this.later((async () => {
      const sent = await this.mail(letter);
      if (!sent?.ok || last() >= cutoff) return;
      // marked 50 at a time: Cloudflare's SQL takes 100 values a statement
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        this.write(`UPDATE gw_orderins SET listed_for = ? WHERE listed_for IS NULL AND id IN (${chunk.map(() => '?').join(', ')})`, cutoff, ...chunk);
      }
      this.write("INSERT OR REPLACE INTO meta (key, value) VALUES ('gw-list', ?)", cutoff);
    })());
    return { list: cutoff, codes: order.length, packs: order.reduce((sum, c) => sum + c.packs, 0) };
  },
};

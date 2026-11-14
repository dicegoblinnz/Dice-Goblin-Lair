// Round 38 (14 Nov 2026, contract v38-order-rolls): d20 rolls on online orders. Mo, settling the shop's deals:
// "The $200 spend is online only no in-store correlation", "magic boxes always give a dice per $100 sold and anything
// else will be $200 normally and $100 if it was a special season thing", "The $200 is for a transaction not a running
// total", "they get the dice after purchase. And credit is immediately in Thier account", and "give them the ability to
// buy more products within the hour to add the items inside the same package if they chose to. To save on shipping
// again. Reason is if they got the dice and wanted to use it straight away they can buy something else and ship it at
// the same time".
//
// These are methods of the Lair Durable Object (src/lair.js mixes them in with Object.assign(Lair.prototype, …)).
// - ordersPaid (src/lair.js) calls orderRollsPaid for every paid order once the order's customer is known (orderSpend).
//   An online order (not a counter sale, not a draft order such as the Lair's own checkouts) with a customer earns a
//   loyalty roll for every $200 its products cost after discounts, each order on its own. Magic booster boxes count
//   double (a roll for every $100), and on a double day everything counts double (boxes too, not four times). The rolls
//   are the loyalty card's (loyaltyOf's earned.orders): rolled in My Lair, the d20's face in store credit or the sure $10.
// - The rules are the theme's (Theme settings › Lair bookings): on only once the live theme says so, like round 29's
//   reminders, so a Lair deployed before its theme gives none.
// - Once the rolls are kept, Gobgob emails the customer (ORDER_ROLL_EMAILS = off stops it). A posted order's email
//   carries an hour's free delivery for a second order in the same parcel: a code only that customer can use, once.
// - A paid order that used one of those codes is tagged with its first order, each with a line on its note, so the two
//   are packed together.
// - The 10-minute run (orderRollsUpkeep) finishes what a restart cut short: an email not yet sent, a tag not yet on.
import { HOUR, MIN, lairTime } from './core.js';
import { emailReady } from './shopify.js';
import { deliveryOf } from './gw-orders.js';

export const ORDER_ROLLS = Object.freeze({
  // a roll for every $200 (the theme's "A d20 roll for every" when it's empty or not a number)
  every: 200,
  // the most rolls one order earns: a guard against a mistake, not one of Mo's rules (50 is a $10,000 order, or $5,000
  // of Magic boxes)
  maxPerOrder: 50,
  // how long the same-parcel code works after the order was paid
  parcelMinutes: 60,
  // no code is made with less than this left of the hour (a late webhook): the email just leaves the parcel out
  parcelLeastMinutes: 10,
  // PARCEL-7KQ2XM: six letters and numbers, none of 0, O, 1, I or L
  parcelPrefix: 'PARCEL-',
  parcelAlphabet: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  parcelLength: 6,
  // both orders' tag once a second one is for the same parcel
  parcelTag: 'Same parcel',
  // the 10-minute run keeps trying an email for this long after the order, and a parcel tag for a day
  emailWithinMs: 2 * HOUR,
  tagWithinMs: 24 * HOUR,
});

export const ORDER_ROLL_TABLES = [
  `CREATE TABLE IF NOT EXISTS order_rolls (
     order_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, order_name TEXT, counted INTEGER NOT NULL, boxes INTEGER NOT NULL,
     doubled INTEGER NOT NULL DEFAULT 0, rolls INTEGER NOT NULL, paid_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
     parcel_ok INTEGER NOT NULL DEFAULT 0, parcel_code TEXT, parcel_ends INTEGER, parcel_tried_at INTEGER,
     parcel_order_id TEXT, parcel_order_name TEXT, parcel_tagged_at INTEGER, emailed_at INTEGER,
     status TEXT NOT NULL DEFAULT 'active')`,
  'CREATE INDEX IF NOT EXISTS order_rolls_customer ON order_rolls (customer_id, status)',
  'CREATE UNIQUE INDEX IF NOT EXISTS order_rolls_parcel ON order_rolls (parcel_code) WHERE parcel_code IS NOT NULL',
];

export const ORDER_ROLL_WORDS = Object.freeze({
  subject: (n, order) => `${n === 1 ? 'A d20 roll' : `${n} d20 rolls`} for your order ${order}`,
  title: (n) => (n === 1 ? 'A d20 roll, waiting in My Lair' : `${n} d20 rolls, waiting in My Lair`),
  thanks: (first, order, n) => `Kia ora ${first || 'friend'}, thanks for your order ${order}. It earned ${n === 1 ? 'a d20 roll' : `${n} d20 rolls`}.`,
  how: (n) => `Roll ${n === 1 ? 'it' : 'each one'} in My Lair and the number lands in your store credit straight away, $1 to $20. Or take a sure $10 instead.`,
  parcel: (clock, order) => `Want to spend it now? Order again before ${clock} and it goes in the same parcel as ${order}, with no extra delivery.`,
  button: (n) => (n === 1 ? 'Roll it in My Lair' : 'Roll them in My Lair'),
  parcelLink: 'Add to this parcel',
  // the code as Shopify admin lists it
  parcelTitle: (order) => `Same parcel as ${order}`,
  // a line on each order's note once a second one is for the same parcel
  secondNote: (first) => `Same parcel as ${first}: pack the two together.`,
  firstNote: (second) => `${second} goes in the same parcel as this one: pack the two together.`,
});

/* ---------------- which lines count, and how much ---------------- */

const WIZARDS = /^wizards of the coast$/i;
// a variant that is a box of Magic boosters: "Box", "Booster Box", "Collector Box", "Play Booster Box" and the like,
// never a scene box, a bundle, a Commander deck or a Draft Night
const BOX_VARIANT = /^(?:(?:play|set|draft|collector|jumpstart)\s+)?(?:booster\s+)?box$/i;
// a product with no variants of its own that is one ("MTG Foundations Play Booster Box")
const BOX_TITLE = /\b(?:booster|collector)\s+box\b/i;

/**
 * Whether an order line (the orders/paid webhook's line item) is a Magic booster box: Wizards of the Coast's, and its
 * variant is a box of boosters, or it has no variant of its own and its title says so.
 */
export function isMagicBox(line) {
  if (!WIZARDS.test(String(line?.vendor ?? '').trim())) return false;
  const variant = String(line?.variant_title ?? '').trim();
  if (variant && !/^default title$/i.test(variant)) return BOX_VARIANT.test(variant);
  return BOX_TITLE.test(String(line?.title ?? ''));
}

/** What an order line paid, in cents: its price times its quantity, less that line's discounts (as src/lair.js) */
export function paidCents(line) {
  const cents = (value) => Math.round(Number(value || 0) * 100) || 0;
  const gross = cents(line?.price ?? line?.price_set?.shop_money?.amount) * Math.max(0, Math.floor(Number(line?.quantity ?? 1)) || 0);
  const discounts = (line?.discount_allocations || []).reduce((sum, d) => sum + cents(d.amount ?? d.amount_set?.shop_money?.amount), 0);
  return Math.max(0, gross - discounts);
}

// a library damage charge (src/memberships.js, the product "Library damage charge") is a bill, not shopping
const NOT_SHOPPING = /^library damage charge$/i;

/**
 * The lines an order's rolls are counted from: { amount (cents), box }, gift cards left out (buying one isn't spending
 * at the shop: what it later pays for counts), and library damage charges.
 */
export function orderRollLines(lineItems) {
  return (Array.isArray(lineItems) ? lineItems : [])
    .filter((line) => line && line.gift_card !== true && !NOT_SHOPPING.test(String(line.title ?? '').trim()))
    .map((line) => ({ amount: paidCents(line), box: isMagicBox(line) }))
    .filter((line) => line.amount > 0);
}

/**
 * An order's rolls: a roll for every `every` dollars, Magic boxes counting double, and everything counting double on a
 * double day. Returns { rolls, counted (cents of products that counted), boxes (cents of Magic boxes), points (cents,
 * the doubles doubled) }.
 */
export function orderRollCount(lines, { every = ORDER_ROLLS.every, double = false, max = ORDER_ROLLS.maxPerOrder } = {}) {
  let counted = 0;
  let boxes = 0;
  let points = 0;
  for (const line of lines || []) {
    const amount = Math.max(0, Math.round(Number(line?.amount) || 0));
    counted += amount;
    if (line.box) boxes += amount;
    points += amount * (double || line.box ? 2 : 1);
  }
  const per = Math.round(Number(every) * 100);
  const rolls = per > 0 ? Math.min(max, Math.floor(points / per)) : 0;
  return { rolls, counted, boxes, points };
}

/** Whether the moment ms is on one of the double days ([from, to] day keys, in the shop's time zone) */
export function doubleDayOn(ms, days, tz = 'Pacific/Auckland') {
  if (!Array.isArray(days) || !days.length) return false;
  const key = lairTime(tz).key(ms);
  return days.some(([from, to]) => key >= from && key <= to);
}

/** A same-parcel code: PARCEL- and six letters and numbers, from crypto (never guessable) */
export function parcelCode(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const { parcelAlphabet: abc, parcelLength: length, parcelPrefix } = ORDER_ROLLS;
  const bytes = random(length * 4);
  let text = '';
  // rejection sampling, so every letter is as likely as the next
  const limit = 256 - (256 % abc.length);
  for (const b of bytes) {
    if (b >= limit) continue;
    text += abc[b % abc.length];
    if (text.length === length) break;
  }
  if (text.length < length) return parcelCode(random);
  return `${parcelPrefix}${text}`;
}

/* ---------------- the Lair's side ---------------- */

export const orderRollMethods = {
  /**
   * orders/paid (src/lair.js ordersPaid, after the spend is kept): this order's rolls, once per order, and a second
   * order in the same parcel tagged with its first. spend: orderSpend's answer (the customer, the order's name, its
   * discount codes and when it was paid). No awaits: the email, the parcel code and the tags go in the background.
   * Returns { rolls } when it earned some, { parcel: first order's name } when it's a second order for a parcel, both
   * or null.
   */
  orderRollsPaid(order, orderId, { pos = false, spend = null, rules = this.rulesCache, now = Date.now() } = {}) {
    const result = {};
    const first = this.parcelOrderPaid(orderId, spend);
    if (first) result.parcel = first.order_name || null;
    const setup = rules?.rolls;
    const source = String(order?.source_name ?? '');
    // online only: never a counter sale (Shopify POS, the till, Pay on Verifone), never a draft order (the Lair's own
    // checkouts and bills, and orders staff make in Shopify admin), never a subscription's own billing (a library
    // membership's month, a damage charge on its card), and only for an order with a customer
    const notOnline = pos || source === 'shopify_draft_order' || /subscription/i.test(source);
    if (!setup?.on || notOnline || !spend?.customerId) return Object.keys(result).length ? result : null;
    if (this.sql.exec('SELECT 1 AS n FROM order_rolls WHERE order_id = ?', orderId).toArray().length) return Object.keys(result).length ? result : null;
    const paidAt = Number(spend.processedAt) || now;
    const doubled = doubleDayOn(paidAt, setup.doubleDays, rules.tz);
    const { rolls, counted, boxes } = orderRollCount(orderRollLines(order?.line_items), { every: setup.every, double: doubled });
    if (rolls < 1) return Object.keys(result).length ? result : null;
    this.sql.exec(
      `INSERT INTO order_rolls (order_id, customer_id, order_name, counted, boxes, doubled, rolls, paid_at, created_at, parcel_ok, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      orderId, String(spend.customerId), spend.name || null, counted, boxes, doubled ? 1 : 0, rolls, paidAt, now, first ? 0 : 1,
    );
    this.later(this.orderRollsFollowUp(orderId));
    result.rolls = rolls;
    return result;
  },

  /** The rolls a customer's online orders have earned (loyaltyOf's earned.orders). No awaits. */
  orderRollsEarned(customerId) {
    return this.sql.exec("SELECT COALESCE(SUM(rolls), 0) AS n FROM order_rolls WHERE customer_id = ? AND status = 'active'", String(customerId)).one().n;
  },

  /**
   * A paid order that used a same-parcel code: the first order it goes with (its order_rolls row), linked to it once,
   * with both orders' tags and notes in the background. The code must be the customer's own. No awaits.
   */
  parcelOrderPaid(orderId, spend) {
    const prefix = ORDER_ROLLS.parcelPrefix;
    const codes = [...new Set((spend?.discountCodes || []).map((c) => String(c).trim().toUpperCase()).filter((c) => c.startsWith(prefix)))].slice(0, 5);
    if (!codes.length || !spend?.customerId) return null;
    const first = this.sql
      .exec(`SELECT * FROM order_rolls WHERE parcel_code IN (${codes.map(() => '?').join(', ')}) AND customer_id = ? LIMIT 1`, ...codes, String(spend.customerId))
      .toArray()[0];
    if (!first || first.order_id === orderId) return null;
    if (!first.parcel_order_id) {
      this.sql.exec('UPDATE order_rolls SET parcel_order_id = ?, parcel_order_name = ? WHERE order_id = ?', orderId, spend.name || null, first.order_id);
      this.later(this.parcelTags(first.order_id));
    }
    return first;
  },

  /** Both orders of a parcel tagged and noted (gwMarkOrder leaves a note that has its line already). Never throws. */
  async parcelTags(firstOrderId) {
    const row = this.sql.exec('SELECT * FROM order_rolls WHERE order_id = ?', firstOrderId).toArray()[0];
    if (!row?.parcel_order_id || row.parcel_tagged_at || !this.shopify.configured) return false;
    const words = ORDER_ROLL_WORDS;
    try {
      await this.shopify.gwMarkOrder(row.parcel_order_id, ORDER_ROLLS.parcelTag, words.secondNote(row.order_name || 'the first order'));
      await this.shopify.gwMarkOrder(row.order_id, ORDER_ROLLS.parcelTag, words.firstNote(row.parcel_order_name || 'A second order'));
      this.sql.exec('UPDATE order_rolls SET parcel_tagged_at = ? WHERE order_id = ?', Date.now(), row.order_id);
      return true;
    } catch (error) {
      this.note({ parcelTagError: { message: String(error.message || error).slice(0, 300), order: row.order_name, at: new Date().toISOString() } });
      return false;
    }
  },

  /**
   * After an order's rolls are kept (in the background, and again from the 10-minute run): Gobgob's email, sent once
   * (emailed_at is set before it goes, so it never goes twice), and for a posted order the same-parcel code it carries,
   * tried once. The code is only made for an email that's going: it's the only place it's told. Never throws.
   */
  async orderRollsFollowUp(orderId) {
    const read = () => this.sql.exec('SELECT * FROM order_rolls WHERE order_id = ?', orderId).toArray()[0];
    let row = read();
    if (!row || row.status !== 'active' || row.emailed_at) return false;
    if (String(this.env.ORDER_ROLL_EMAILS || '').trim().toLowerCase() === 'off' || !emailReady(this.env)) return false;
    const to = await this.orderRollEmailTo(row.customer_id);
    if (!to.email) return false;
    const rules = await this.rules();
    // read again after the awaits: another run (the 10-minute one) may have got here first. From the read to the mark
    // there's no await, so only one of them tries the code.
    row = read();
    if (!row || row.emailed_at) return false;
    if (row.parcel_ok && !row.parcel_tried_at && this.shopify.configured) {
      this.sql.exec('UPDATE order_rolls SET parcel_tried_at = ? WHERE order_id = ?', Date.now(), orderId);
      try {
        const ends = row.paid_at + ORDER_ROLLS.parcelMinutes * MIN;
        if (ends - Date.now() >= ORDER_ROLLS.parcelLeastMinutes * MIN) {
          const info = await this.shopify.gwOrderInfo(orderId);
          if (deliveryOf(info, false) === 'ship') {
            const code = parcelCode();
            await this.shopify.createParcelCode({ title: ORDER_ROLL_WORDS.parcelTitle(row.order_name || 'your order'), code, customerId: row.customer_id, endsAt: ends });
            this.sql.exec('UPDATE order_rolls SET parcel_code = ?, parcel_ends = ? WHERE order_id = ?', code, ends, orderId);
          }
        }
      } catch (error) {
        this.note({ parcelCodeError: { message: String(error.message || error).slice(0, 300), order: row.order_name, at: new Date().toISOString() } });
      }
      row = read();
    }
    // once: marked before it goes (and not at all when another run got there during the awaits above)
    if (!row || row.emailed_at) return false;
    this.sql.exec('UPDATE order_rolls SET emailed_at = ? WHERE order_id = ? AND emailed_at IS NULL', Date.now(), orderId);
    const sent = await this.mail(this.letter(to.email, ...this.orderRollLetter(row, to.first, rules)));
    if (!sent?.ok) this.note({ orderRollEmailError: { message: String(sent?.message || 'the email failed').slice(0, 300), order: row.order_name, at: new Date().toISOString() } });
    return Boolean(sent?.ok);
  },

  /** Who the email goes to: the member's email when the Lair knows them, else Shopify's for the customer. Never throws. */
  async orderRollEmailTo(customerId) {
    const member = this.memberRow(customerId);
    const first = member?.first_name || String(member?.name || '').trim().split(/\s+/)[0] || '';
    const known = String(member?.account_email || member?.email || '').trim();
    if (known && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(known)) return { email: known, first };
    try {
      const found = await this.shopify.customerEmail(customerId);
      const email = String(found?.email || '').trim();
      return { email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '', first };
    } catch (error) {
      this.note({ orderRollEmailError: { message: String(error.message || error).slice(0, 300), at: new Date().toISOString() } });
      return { email: '', first };
    }
  },

  /** The email's subject and content (for this.letter): the rolls, how they work, and the parcel when there's one */
  orderRollLetter(row, first, rules = this.rulesCache) {
    const w = ORDER_ROLL_WORDS;
    const order = row.order_name || 'with us';
    const intro = [w.thanks(first, order, row.rolls), w.how(row.rolls)];
    const links = [];
    if (row.parcel_code && row.parcel_ends > Date.now()) {
      intro.push(w.parcel(this.clockWord(row.parcel_ends, rules?.tz || 'Pacific/Auckland'), order));
      links.push({ label: w.parcelLink, url: this.link(`/discount/${encodeURIComponent(row.parcel_code)}?redirect=${encodeURIComponent('/collections/all')}`) });
    }
    return [w.subject(row.rolls, order), { title: w.title(row.rolls), intro, button: { label: w.button(row.rolls), url: this.page('myLair') }, links }];
  },

  /**
   * The 10-minute run: an email a restart cut short (within 2 hours of the order), and a parcel's tags not on yet
   * (within a day). Returns { emails, tags } done, or null.
   */
  async orderRollsUpkeep(now = Date.now()) {
    const due = this.sql
      .exec("SELECT order_id FROM order_rolls WHERE status = 'active' AND emailed_at IS NULL AND created_at > ? ORDER BY created_at LIMIT 10", now - ORDER_ROLLS.emailWithinMs)
      .toArray();
    let emails = 0;
    for (const { order_id: id } of due) if (await this.orderRollsFollowUp(id)) emails += 1;
    const untagged = this.sql
      .exec('SELECT order_id FROM order_rolls WHERE parcel_order_id IS NOT NULL AND parcel_tagged_at IS NULL AND paid_at > ? LIMIT 10', now - ORDER_ROLLS.tagWithinMs)
      .toArray();
    let tags = 0;
    for (const { order_id: id } of untagged) if (await this.parcelTags(id)) tags += 1;
    return emails || tags ? { emails, tags } : null;
  },
};

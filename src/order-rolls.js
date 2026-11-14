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
// - A refund takes back what the order no longer earns (Mo, 15 Nov 2026: "ultimately the dice gets removed if refunded.
//   And if it was used for credit that credit is removed instead", and "if it was used to buy something nothing we can
//   do about it"). The 10-minute run asks Shopify about orders with rolls (paid in the last 60 days, every 30 minutes),
//   counts each again on what's left of it with the roll size and double day it was paid on, and takes the difference
//   off the loyalty card: rolls not rolled yet first, and for the rest (rolled already) the store credit they gave, as
//   much of it as is still in their account. Rolls taken back stop counting as used, so the card's later rolls are
//   theirs. A line on the order's note says what was taken back.
import { HOUR, MIN, lairTime, makeId } from './core.js';
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
  // a follow-up under way is left alone this long by any other run (one a restart cut short is picked up after it)
  followClaimMs: 5 * MIN,
  // refunds: orders are asked about for 60 days after they're paid (Shopify's window for an app's orders), each at most
  // every 30 minutes, up to 100 a run; a refusal to take back store credit is tried 3 times before staff are told
  refundWithinMs: 60 * 24 * HOUR,
  refundEveryMs: 30 * MIN,
  refundBatch: 100,
  takeBackTries: 3,
  // the order's tag once a refund has taken rolls back
  takeBackTag: 'Rolls taken back',
});

export const ORDER_ROLL_TABLES = [
  `CREATE TABLE IF NOT EXISTS order_rolls (
     order_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, order_name TEXT, counted INTEGER NOT NULL, boxes INTEGER NOT NULL,
     doubled INTEGER NOT NULL DEFAULT 0, rolls INTEGER NOT NULL, paid_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
     parcel_ok INTEGER NOT NULL DEFAULT 0, parcel_code TEXT, parcel_ends INTEGER, parcel_tried_at INTEGER,
     parcel_order_id TEXT, parcel_order_name TEXT, parcel_tagged_at INTEGER, emailed_at INTEGER, follow_at INTEGER,
     status TEXT NOT NULL DEFAULT 'active', every_cents INTEGER, taken_back INTEGER NOT NULL DEFAULT 0, refund_checked_at INTEGER)`,
  'CREATE INDEX IF NOT EXISTS order_rolls_customer ON order_rolls (customer_id, status)',
  'CREATE UNIQUE INDEX IF NOT EXISTS order_rolls_parcel ON order_rolls (parcel_code) WHERE parcel_code IS NOT NULL',
  // a refund's take-back: how many rolls, how many of them were rolled already, the store credit those gave and what
  // came back of it; status 'credit' (to take back), 'done', or 'check' (staff to look: Shopify kept saying no, or never
  // answered, so it may have gone through)
  `CREATE TABLE IF NOT EXISTS roll_takebacks (
     id TEXT PRIMARY KEY, order_id TEXT NOT NULL, customer_id TEXT NOT NULL, order_name TEXT, rolls INTEGER NOT NULL,
     unrolled INTEGER NOT NULL, rolled INTEGER NOT NULL, credit_asked INTEGER NOT NULL DEFAULT 0, credit_taken INTEGER,
     status TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, note TEXT, claimed_at INTEGER, noted_at INTEGER,
     created_at INTEGER NOT NULL, updated_at INTEGER, debiting_at INTEGER, midway INTEGER NOT NULL DEFAULT 0)`,
  'CREATE INDEX IF NOT EXISTS roll_takebacks_status ON roll_takebacks (status, created_at)',
];

/** Columns added once the tables above are there: a loyalty roll a refund took back (and an older order_rolls's new
 * columns, for a Lair that ran round 38 before refunds) */
export const ORDER_ROLL_COLUMNS = [
  ['member_rolls', 'taken_back_at', 'INTEGER'], ['member_rolls', 'taken_back_id', 'TEXT'],
  ['order_rolls', 'every_cents', 'INTEGER'], ['order_rolls', 'taken_back', 'INTEGER NOT NULL DEFAULT 0'], ['order_rolls', 'refund_checked_at', 'INTEGER'],
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
  // a refund's line on the order's note
  takenBack: (rolls, rolled) => `Refund: ${rolls === 1 ? 'a d20 roll' : `${rolls} d20 rolls`} taken back${
    rolled ? ` (${rolls === 1 ? 'rolled already' : `${rolled} rolled already`})` : rolls === 1 ? ', not rolled yet' : ', none rolled yet'}.`,
  // a roll taken back while Shopify was still adding its credit, which landed after
  takenBackMidway: 'Refund: a d20 roll taken back as it was being rolled.',
  creditBack: (taken, asked, rolled) => {
    const gave = rolled === 1 ? 'it gave' : 'they gave';
    if (taken >= asked) return `${money(asked)} of the store credit ${gave} was taken back.`;
    if (taken > 0) return `${money(taken)} of the ${money(asked)} store credit ${gave} was taken back; the rest was spent.`;
    return `The ${money(asked)} store credit ${gave} was spent, so none was taken back.`;
  },
  // the staff email when the store credit couldn't be taken back
  checkTitle: 'Store credit to take back by hand',
  checkIntro:
    "A refund took back d20 rolls that had been rolled, and the Lair couldn't take back the store credit they gave. Check the customer's store credit in Shopify, and take it back by hand if it's still there.",
  checkNote: (asked) => `Refund: the Lair couldn't take back the ${money(asked)} store credit the rolled d20s gave. Staff are checking it by hand.`,
});

const money = (cents) => `$${(Math.max(0, Number(cents) || 0) / 100).toFixed(2)}`;

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

/**
 * What an order still earns once some of it is refunded: row is its order_rolls row (counted, boxes, doubled,
 * every_cents: what it was counted on when it was paid), lines Shopify's line items as they stand, each with quantity and
 * current_quantity (what's left of it after refunds) and read as orderRollLines reads them. The refunded part comes off
 * the points the order was counted on, so an order nothing came back from keeps its rolls exactly, whatever the theme's
 * settings are now. A cancelled order earns none.
 */
export function rollsAfterRefunds(row, lines, { cancelled = false } = {}) {
  if (cancelled) return 0;
  const per = Number(row?.every_cents) > 0 ? Number(row.every_cents) : ORDER_ROLLS.every * 100;
  const double = Boolean(row?.doubled);
  let refunded = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const quantity = Math.max(0, Math.floor(Number(line?.quantity) || 0));
    const left = Math.min(quantity, Math.max(0, Math.floor(Number(line?.current_quantity ?? quantity) || 0)));
    if (!quantity || left >= quantity) continue;
    const [counts] = orderRollLines([line]);
    if (!counts) continue;
    const back = Math.round((counts.amount * (quantity - left)) / quantity);
    refunded += back * (double || counts.box ? 2 : 1);
  }
  const counted = Math.max(0, Number(row?.counted) || 0);
  const points = (double ? 2 * counted : counted + Math.max(0, Number(row?.boxes) || 0)) - refunded;
  return Math.max(0, Math.min(ORDER_ROLLS.maxPerOrder, Math.floor(Math.max(0, points) / per)));
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
    // (no source at all is taken as a draft, as ordersPaid takes it)
    const notOnline = pos || !source || source === 'shopify_draft_order' || /subscription/i.test(source);
    if (!setup?.on || notOnline || !spend?.customerId) return Object.keys(result).length ? result : null;
    if (this.sql.exec('SELECT 1 AS n FROM order_rolls WHERE order_id = ?', orderId).toArray().length) return Object.keys(result).length ? result : null;
    const paidAt = Number(spend.processedAt) || now;
    const doubled = doubleDayOn(paidAt, setup.doubleDays, rules.tz);
    const { rolls, counted, boxes } = orderRollCount(orderRollLines(order?.line_items), { every: setup.every, double: doubled });
    if (rolls < 1) return Object.keys(result).length ? result : null;
    // every_cents: the roll size it was counted on, so a refund counts what's left the same way
    this.sql.exec(
      `INSERT INTO order_rolls (order_id, customer_id, order_name, counted, boxes, doubled, rolls, paid_at, created_at, parcel_ok, status, every_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      orderId, String(spend.customerId), spend.name || null, counted, boxes, doubled ? 1 : 0, rolls, paidAt, now, first ? 0 : 1,
      Math.round(Number(setup.every) * 100),
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
    // (none at all once a refund took them all back before the email went)
    if (!row || row.status !== 'active' || row.emailed_at || row.rolls < 1) return false;
    // one follow-up at a time (the separate review: the 10-minute run meeting one mid-way sent the email without its
    // parcel): claimed before the first await, and left alone by any other run for 5 minutes
    if (row.follow_at && Date.now() - row.follow_at < ORDER_ROLLS.followClaimMs) return false;
    this.sql.exec('UPDATE order_rolls SET follow_at = ? WHERE order_id = ?', Date.now(), orderId);
    if (String(this.env.ORDER_ROLL_EMAILS || '').trim().toLowerCase() === 'off' || !emailReady(this.env)) return false;
    const to = await this.orderRollEmailTo(row.customer_id);
    if (!to.email) return false;
    const rules = await this.rules();
    // read again after the awaits: from the read to the mark there's no await
    row = read();
    if (!row || row.emailed_at || row.rolls < 1) return false;
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
    if (!row || row.emailed_at || row.rolls < 1) return false;
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
   * The 10-minute run: refunds first (so an order refunded before its email goes gets none, or is told what it still
   * earns), then an email a restart cut short (within 2 hours of the order), a parcel's tags not on yet (within a day),
   * and a take-back's store credit or order line not done yet. Returns { emails, tags } and { takenBack } (rolls taken
   * back) when there were any, or null.
   */
  async orderRollsUpkeep(now = Date.now()) {
    const takenBack = await this.orderRollsRefunds(now);
    const due = this.sql
      .exec("SELECT order_id FROM order_rolls WHERE status = 'active' AND emailed_at IS NULL AND rolls > 0 AND created_at > ? ORDER BY created_at LIMIT 10", now - ORDER_ROLLS.emailWithinMs)
      .toArray();
    let emails = 0;
    for (const { order_id: id } of due) if (await this.orderRollsFollowUp(id)) emails += 1;
    const untagged = this.sql
      .exec('SELECT order_id FROM order_rolls WHERE parcel_order_id IS NOT NULL AND parcel_tagged_at IS NULL AND paid_at > ? LIMIT 10', now - ORDER_ROLLS.tagWithinMs)
      .toArray();
    let tags = 0;
    for (const { order_id: id } of untagged) if (await this.parcelTags(id)) tags += 1;
    // a take-back whose store credit Shopify refused, or a restart cut short (a claim older than 5 minutes), and order
    // lines not on yet, within a week
    const unfinished = this.sql
      .exec(
        `SELECT id FROM roll_takebacks WHERE created_at > ? AND (status = 'credit' OR noted_at IS NULL) AND (claimed_at IS NULL OR claimed_at < ?)
          ORDER BY created_at LIMIT 10`,
        now - 7 * 24 * HOUR, now - ORDER_ROLLS.followClaimMs,
      )
      .toArray();
    for (const { id } of unfinished) await this.rollTakebackFollowUp(id);
    const out = emails || tags ? { emails, tags } : {};
    if (takenBack) out.takenBack = takenBack;
    return Object.keys(out).length ? out : null;
  },

  /**
   * Orders with rolls left, paid in the last 60 days, asked about at most every 30 minutes (up to 100 a run): Shopify
   * says which have money back or are cancelled, with their lines as they stand, and each gives back what it no longer
   * earns. Never throws. Returns the rolls taken back.
   */
  async orderRollsRefunds(now = Date.now()) {
    if (!this.shopify.configured) return 0;
    const rows = this.sql
      .exec(
        `SELECT order_id FROM order_rolls WHERE status = 'active' AND rolls > 0 AND paid_at > ? AND (refund_checked_at IS NULL OR refund_checked_at <= ?)
          ORDER BY COALESCE(refund_checked_at, 0), paid_at LIMIT ?`,
        now - ORDER_ROLLS.refundWithinMs, now - ORDER_ROLLS.refundEveryMs, ORDER_ROLLS.refundBatch,
      )
      .toArray();
    if (!rows.length) return 0;
    let orders;
    try {
      orders = await this.shopify.orderRollRefunds(rows.map((r) => r.order_id));
    } catch (error) {
      this.note({ rollRefundError: { message: String(error.message || error).slice(0, 300), at: new Date().toISOString() } });
      return 0;
    }
    // --- no awaits from here on ---
    let back = 0;
    for (const order of Array.isArray(orders) ? orders : []) {
      back += this.orderRollsTakeBack(order.id, order.lines, { cancelled: Boolean(order.cancelled), now })?.rolls || 0;
    }
    for (const r of rows) this.sql.exec('UPDATE order_rolls SET refund_checked_at = ? WHERE order_id = ?', now, r.order_id);
    return back;
  },

  /**
   * One order's refunds (lines: Shopify's line items as they stand, cancelled: whether the order was cancelled): the
   * rolls it no longer earns come off the card. While the card has rolls not rolled yet, those go; any more were
   * rolled, so the newest loyalty rolls made since the order was paid are taken back with the store credit they gave
   * (a prize still waiting at the counter just isn't given). Rolls taken back stop counting as used. No awaits: the
   * store credit and the order's line follow in the background. Returns { rolls, unrolled, rolled, credit } or null.
   */
  orderRollsTakeBack(orderId, lines, { cancelled = false, now = Date.now() } = {}) {
    const row = this.sql.exec('SELECT * FROM order_rolls WHERE order_id = ?', String(orderId)).toArray()[0];
    if (!row || row.status !== 'active' || row.rolls < 1) return null;
    const left = Math.min(row.rolls, rollsAfterRefunds(row, lines, { cancelled }));
    const back = row.rolls - left;
    if (back < 1) return null;
    // the card as it stands, before this order's rolls come off it
    const available = this.loyaltyOf(row.customer_id).rolls.available;
    this.sql.exec('UPDATE order_rolls SET rolls = ?, taken_back = taken_back + ? WHERE order_id = ? AND rolls = ?', left, back, row.order_id, row.rolls);
    const wanted = Math.max(0, back - available);
    const rolled = wanted
      ? this.sql
        .exec(
          `SELECT r.id AS id, r.prize_id AS prize_id, p.amount AS amount, p.status AS status FROM member_rolls r LEFT JOIN prizes p ON p.id = r.prize_id
            WHERE r.customer_id = ? AND r.kind = 'loyalty' AND r.taken_back_at IS NULL AND r.created_at >= ?
            ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`,
          row.customer_id, row.paid_at, wanted,
        )
        .toArray()
      : [];
    const id = makeId('tb');
    let credit = 0;
    for (const r of rolled) {
      this.sql.exec('UPDATE member_rolls SET taken_back_at = ?, taken_back_id = ? WHERE id = ?', now, id, r.id);
      if (r.status === 'pending') this.sql.exec("UPDATE prizes SET status = 'taken back', updated_at = ? WHERE id = ? AND status = 'pending'", now, r.prize_id);
      else if (r.status === 'added' || r.status === 'done') credit += Math.max(0, Number(r.amount) || 0);
    }
    this.sql.exec(
      `INSERT INTO roll_takebacks (id, order_id, customer_id, order_name, rolls, unrolled, rolled, credit_asked, credit_taken, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, row.order_id, row.customer_id, row.order_name, back, back - wanted, rolled.length, credit, credit ? null : 0, credit ? 'credit' : 'done', now, now,
    );
    this.later(this.rollTakebackFollowUp(id));
    return { rolls: back, unrolled: back - wanted, rolled: rolled.length, credit };
  },

  /**
   * A take-back's store credit, then its line on the order's note. The credit comes off what's still in their account,
   * never more (spent credit stays spent). Claimed before the first await, so it's taken once: Shopify saying no is
   * tried again by the 10-minute run (3 times, then staff are told); no answer at all may have gone through, so staff
   * check it by hand and it's never tried again. So does one the Lair stopped in the middle of (debiting_at still set:
   * the separate review, 15 Nov 2026), since Shopify may have taken it before the Lair could say so. Never throws.
   */
  async rollTakebackFollowUp(id) {
    const read = () => this.sql.exec('SELECT * FROM roll_takebacks WHERE id = ?', id).toArray()[0];
    let tb = read();
    if (!tb || (tb.status !== 'credit' && tb.noted_at)) return false;
    if (tb.claimed_at && Date.now() - tb.claimed_at < ORDER_ROLLS.followClaimMs) return false;
    this.sql.exec('UPDATE roll_takebacks SET claimed_at = ? WHERE id = ?', Date.now(), id);
    const words = ORDER_ROLL_WORDS;
    if (tb.status === 'credit' && tb.debiting_at) {
      this.rollTakebackCheck(tb, 'The Lair stopped while Shopify was taking it back, so it may or may not have gone through.');
      tb = read();
    }
    if (tb.status === 'credit') {
      const currency = this.env.CURRENCY || 'NZD';
      let balance = null;
      try {
        balance = await this.shopify.storeCreditBalance(tb.customer_id, currency);
      } catch (error) {
        // nothing moved: the 10-minute run asks again
        this.sql.exec('UPDATE roll_takebacks SET note = ?, claimed_at = NULL, updated_at = ? WHERE id = ?', String(error.message || error).slice(0, 300), Date.now(), id);
        return false;
      }
      const take = Math.min(tb.credit_asked, Math.max(0, Math.round(Number(balance) || 0)));
      // debiting_at: set while Shopify is asked, so a Lair stopped in the middle never asks again (above)
      this.sql.exec('UPDATE roll_takebacks SET tries = tries + 1, debiting_at = ?, updated_at = ? WHERE id = ?', Date.now(), Date.now(), id);
      try {
        if (take > 0) await this.shopify.changeStoreCredit(tb.customer_id, -take, currency);
        this.sql.exec("UPDATE roll_takebacks SET status = 'done', credit_taken = ?, note = NULL, debiting_at = NULL, updated_at = ? WHERE id = ?", take, Date.now(), id);
      } catch (error) {
        const message = String(error.message || error).slice(0, 300);
        const tries = read()?.tries || 0;
        if (error.refused && tries < ORDER_ROLLS.takeBackTries) {
          // Shopify said no, so nothing moved: tried again by the 10-minute run
          this.sql.exec('UPDATE roll_takebacks SET note = ?, claimed_at = NULL, debiting_at = NULL, updated_at = ? WHERE id = ?', message, Date.now(), id);
          this.note({ rollTakebackError: { message, order: tb.order_name, at: new Date().toISOString() } });
          return false;
        }
        this.rollTakebackCheck(tb, message);
      }
      tb = read();
    }
    if (!tb || tb.noted_at || tb.status === 'credit' || !this.shopify.configured) return tb?.status === 'done';
    const head = tb.midway ? words.takenBackMidway : words.takenBack(tb.rolls, tb.rolled);
    const line = tb.status === 'check'
      ? `${head} ${words.checkNote(tb.credit_asked)}`
      : `${head}${tb.credit_asked > 0 ? ` ${words.creditBack(tb.credit_taken || 0, tb.credit_asked, tb.rolled)}` : ''}`;
    try {
      await this.shopify.gwMarkOrder(tb.order_id, ORDER_ROLLS.takeBackTag, line);
      this.sql.exec('UPDATE roll_takebacks SET noted_at = ?, claimed_at = NULL WHERE id = ?', Date.now(), id);
    } catch (error) {
      this.sql.exec('UPDATE roll_takebacks SET claimed_at = NULL WHERE id = ?', id);
      this.note({ rollTakebackError: { message: String(error.message || error).slice(0, 300), order: tb.order_name, at: new Date().toISOString() } });
    }
    return tb.status === 'done';
  },

  /** A take-back's store credit left for staff to check by hand (status 'check', never tried again), and the email */
  rollTakebackCheck(tb, message) {
    const words = ORDER_ROLL_WORDS;
    this.sql.exec("UPDATE roll_takebacks SET status = 'check', note = ?, debiting_at = NULL, updated_at = ? WHERE id = ?", message, Date.now(), tb.id);
    const member = this.memberRow(tb.customer_id);
    this.notifyStaff(`Store credit to take back: ${tb.order_name || 'a refunded order'}`, {
      title: words.checkTitle,
      intro: words.checkIntro,
      details: [
        ['Order', tb.order_name || tb.order_id], ['Store credit to take back', money(tb.credit_asked)],
        ['Customer', `${member?.name || 'Unknown'}${member?.code ? ` (${member.code})` : ''}`], ['Why', message],
      ],
    });
  },

  /**
   * roll() (src/lair.js) found its prize taken back by a refund while Shopify was adding the prize's credit, and
   * Shopify did add it (the separate review, 15 Nov 2026): that credit, and only that, comes back the way a rolled
   * roll's does, as a take-back of its own (midway) with its own line on the order. No awaits. Returns whether there
   * was one.
   */
  rollTakenBackMidway(prizeId, amount) {
    const r = this.sql.exec('SELECT taken_back_id FROM member_rolls WHERE prize_id = ?', String(prizeId)).toArray()[0];
    const tb = r?.taken_back_id ? this.sql.exec('SELECT * FROM roll_takebacks WHERE id = ?', r.taken_back_id).toArray()[0] : null;
    const cents = Math.round(Number(amount) || 0);
    if (!tb || cents < 1) return false;
    const id = makeId('tb');
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO roll_takebacks (id, order_id, customer_id, order_name, rolls, unrolled, rolled, credit_asked, credit_taken, status, created_at, updated_at, midway)
       VALUES (?, ?, ?, ?, 0, 0, 1, ?, NULL, 'credit', ?, ?, 1)`,
      id, tb.order_id, tb.customer_id, tb.order_name, cents, now, now,
    );
    this.later(this.rollTakebackFollowUp(id));
    return true;
  },
};

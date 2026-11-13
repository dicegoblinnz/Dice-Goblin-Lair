// Round 34, discounts on the till (contract docs/contracts/lair-api-contract-v34-till-discounts.md).
//
// Mo (10 Nov 2026): "for the till have an option to apply discounts but once applied the staff needs to 'log in' and
// that goes through make sure no item can go below 25% discount". With his 6 Nov decision that discounts are for the
// Money role. So:
//  - A discount is a percent off one of the shop's products in the basket (`discount` on its line), up to 25%. Bookings,
//    sign-ups and tabs keep their price: they have their own ways (passes, waiving, the tab's prices).
//  - The till shows what it comes to (POST /till/price) straight away, but Pay won't take it until someone with Money,
//    or the owner, has just put their PIN in for it (`discountOk`: the till token that PIN gave, from an unlock in the
//    last 10 minutes), even when they're the one on the till. One approval is one sale: a sale that's let go (Back,
//    Shopify failing) can use it again on the same till, a sale that's paid can't.
//  - The 25% is checked twice: the percent asked for, and what Shopify actually took off each line. A line on a deal
//    already (the dice deal) can't have a discount too, so no item ever sells for less than 75% of its price because of
//    a discount.
//  - Each discounted line says "Staff discount" in Shopify, with who approved it; the order is tagged staff-discount and
//    its note says who, so Mo can see them all in Shopify (Orders, filter by the tag).
//
// Round 35, in dollars (contract docs/contracts/lair-api-contract-v35-till-discounts.md). Mo (10 Nov 2026): "for the
// discount make it go off actual dollar value not % thanks no need to say no more than 25% but do not accept anything
// lower than 25% unless it is done on the item previously thanks. Actually make it 20%"; asked when something may sell
// for more than 20% off, he picked "Already on sale". So, in place of the percent and the 25% above:
//  - A discount is dollars off each one of a product (`off` on its line, in cents), as Shopify's own fixed amount on a
//    draft's line is: 2 of a $50 game with $5 off is $10 off.
//  - No item sells for less than 80% of its full price because of a discount. Its full price is Shopify's compare-at
//    price when it's on sale, else its price: so something on sale comes down only as far as 80% of what it was, and
//    something already there or under can't have a discount (it's under 80% only because Shopify already has it there).
//    A line on a deal still can't have one too.
//  - It's checked on Shopify's own figures, for the price and again on the draft at Pay: the price and compare-at price
//    Shopify has for the item as it works the sale out, and what it took off the line. Shopify takes a fixed amount of
//    more than the price as the whole price and says nothing, so what was asked is checked, and that what came off is
//    what was asked. A discounted line the figures don't have is refused.
//  - Nothing says the limit until it's passed: a refusal names the most that item can come down by, in dollars.
//  - The percent is still read (`discount`), from a till that hasn't reloaded since: at most 20 now, and held to the same
//    80%. It goes in a later round.
//
// Round 36, past 20% asks first, is flagged and is emailed (contract docs/contracts/lair-api-contract-v36-till-discount-over.md).
// Mo (13 Nov 2026): "for the discount limitation of 20% instead of locking it just create a warning message that this
// happened and flag it and send a special email when it happens so I would know [...] a warning message saying this
// exceeds the 20% threshold of discounts are you sure you wanna continue and when the transaction is done an automatic
// email is sent without alerting anyone etc. just for my information and if an investigation is needed I will deal with
// it myself I just want the information". So, for dollars off (a percent is held to the 80% as it was):
//  - Nothing is locked at 20%: dollars off can take an item past 80% of its full price, as far as its whole price. The
//    price says which lines are past it (`over`), with what each could come down by before it (`most`, as before).
//  - The till asks first, and Pay goes through only when the till says yes was said (`overOk: true`); without it the
//    Lair refuses, naming the lines, and nothing is sold. Still never on top of a deal, only the shop's products, and
//    only with a PIN from someone with Money, or the owner.
//  - Flagged: the sale keeps which lines were past 20% (`discount_over`), and once it's paid its Shopify order is tagged
//    discount-over-20 with a paragraph on its note.
//  - Emailed: once it's paid, one email to the shop owner's own address as Shopify has it (Shop.email: Settings, Store
//    details), or to DISCOUNT_EMAIL when that's set ('off' for none); never to STAFF_EMAIL. It says who rang it up,
//    who approved it, what came off what, and links to the order. It waits up to 10 minutes for the order so it can
//    name it. Both are tried again by the 10-minute run until they're done (the email for 23 hours: it's written
//    once and kept, and its Resend key keeps a second send of it from going for a day). Nothing the till is told
//    says any of this.
import { HOUR, LairTime, RuleError } from './core.js';
import { emailReady, emailSender } from './shopify.js';

const DAY = 24 * HOUR;

/** The most a discount takes off an item, as a percent of its full price (round 35: 20, was 25) */
export const TILL_DISCOUNT_MAX = 20;
/** The most `off` is read as, in cents: $10,000 off each is a typo, not a discount */
export const TILL_OFF_MOST = 1_000_000;
/** An approval is a PIN put in this recently */
export const TILL_DISCOUNT_FRESH_MS = 10 * 60_000;
/** The tag on a discounted sale's order */
export const TILL_DISCOUNT_TAG = 'staff-discount';
/** The title on a discounted line in Shopify (and on the till's total) */
export const TILL_DISCOUNT_TITLE = 'Staff discount';
/** Round 36: the tag on a sale's order when a discount took something more than 20% off */
export const TILL_DISCOUNT_OVER_TAG = 'discount-over-20';
/** Round 36: the email about it waits this long for the sale's order, so it can name it; then it goes without */
export const TILL_OVER_MAIL_WAIT = 10 * 60_000;
/** ... a flag or an email that didn't go is tried again by the 10-minute run after this (a minute under its 10, so the next run is never a moment too early for it) */
export const TILL_OVER_AGAIN = 9 * 60_000;
/** ... the email is tried for this long after the sale is paid, and the flag for this long, then given up on */
export const TILL_OVER_MAIL_FOR = 23 * HOUR;
export const TILL_OVER_FLAG_FOR = 3 * DAY;
/** ... a try that never finished (the Worker stopped) is taken over after this, and a run looks after this many */
const TILL_OVER_STUCK = 15 * 60_000;
export const TILL_OVER_A_RUN = 5;
/** ... the shop owner's address, once Shopify has said it, is kept this long */
const TILL_OWNER_KEPT = HOUR;
/**
 * The till_sales columns for discounts (added when missing, in lair.js's migrate). Round 36: discount_over, the lines a
 * discount took past 20% (JSON, null for none); started_by_name, who rang it up; over_mark and over_mail, where its
 * order's flag and the owner's email have got to ('due', then 'done' or 'sent'; 'stopped' when given up on, 'off' for
 * an email that's switched off); over_tries, over_next_at and over_error, for trying again; over_letter, the email as it
 * was written, kept until it's sent so every try sends the same one (over_letters: how many have been written).
 */
export const TILL_DISCOUNT_COLUMNS = [
  ['till_sales', 'discount_by', 'TEXT'], ['till_sales', 'discount_by_name', 'TEXT'], ['till_sales', 'discount_ok', 'TEXT'], ['till_sales', 'discount_total', 'INTEGER'],
  ['till_sales', 'discount_over', 'TEXT'], ['till_sales', 'started_by_name', 'TEXT'], ['till_sales', 'over_mark', 'TEXT'], ['till_sales', 'over_mail', 'TEXT'],
  ['till_sales', 'over_tries', 'INTEGER'], ['till_sales', 'over_next_at', 'INTEGER'], ['till_sales', 'over_error', 'TEXT'],
  ['till_sales', 'over_letter', 'TEXT'], ['till_sales', 'over_letters', 'INTEGER'],
];

const dollars = (cents) => `$${(Math.round(Number(cents) || 0) / 100).toFixed(2)}`;
const errorText = (error) => String(error?.message || error).slice(0, 300);
const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
const isOneEmail = (text) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(text || ''));

/** Every message about discounts, word for word in the contracts (v34, and v35 for dollars) */
export const TILL_DISCOUNT_WORDS = {
  amount: 'A discount is dollars and cents off each item.',
  over: `A discount can be up to ${TILL_DISCOUNT_MAX}% off each item.`,
  notProduct: 'Discounts are for things from the shop. Bookings and tabs keep their price.',
  needOk: 'A discount needs a PIN from someone with Money, or the owner, before it goes through.',
  notMoney: (name) => `${name} can't approve discounts. That's for staff with Money, or the owner.`,
  stale: 'That approval has run out. Put a PIN in again to approve the discount.',
  used: 'That approval was for another sale. Put a PIN in again to approve this one.',
  stacked: (title) => `${title} is on a deal already, so it can't have a discount too. Take the discount off it.`,
  // round 35: the most an item can come down by (each, when there are 2 or more of it), never the percent
  most: (title, cents, qty = 1) => `${title} can come down by ${dollars(cents)}${qty > 1 ? ' each' : ''} at most. Change the discount, or take it off.`,
  onSale: (title) => `${title} is on sale already, so it can't have a discount too. Take the discount off it.`,
  none: (title) => `${title} can't have a discount. Take the discount off it.`,
  wrong: (title) => `${title}'s discount didn't come out as asked. Take it off and add it again.`,
  // round 36: dollars off go as far as the whole price; past 20% the till asks first (Pay without its yes)
  tooMuch: (title, cents, qty = 1) => `${title} is ${dollars(cents)}${qty > 1 ? ' each' : ''}, so it can't come down by more than that. Change the discount, or take it off.`,
  overAsk: (title) => `${title} would be more than ${TILL_DISCOUNT_MAX}% off, and the till hasn't asked about that yet. Change the discount, or tap Pay again to be asked.`,
};

/** Round 36: every word of the flag on a sale's order and of the owner's email, word for word in the contract (v36) */
export const TILL_OVER_WORDS = {
  /**
   * How far under its full price a line past 20% sells, to one decimal place: "47.6%", "25%". Worked out once, on the
   * line's own figures (its price, what it was when it's on sale, the dollars off): its percent to 2 places rounded
   * again would make 23.6% of 23.545%. A hair past 20 is "just over 20%", never "20%".
   */
  percent: (l) => {
    const unit = Math.max(0, Math.round(Number(l.unit) || 0));
    const full = Math.max(unit, Math.round(Number(l.was) || 0));
    const one = full > 0 ? Math.round(((full - unit + Math.round(Number(l.off) || 0)) * 1000) / full) / 10 : 100;
    return one <= TILL_DISCOUNT_MAX ? `just over ${TILL_DISCOUNT_MAX}%` : `${one}%`;
  },
  /** One line past 20%, for the order's note: "2 × Catan, $5.00 off each (45% off)" */
  noteLine: (l) => `${l.qty > 1 ? `${l.qty} × ` : ''}${l.title}, ${dollars(l.off)} off${l.qty > 1 ? ' each' : ''} (${TILL_OVER_WORDS.percent(l)} off${l.was ? ' what it was' : ''})`,
  note: (lines) => `More than ${TILL_DISCOUNT_MAX}% off, said yes to at the till: ${lines.join('; ')}.`,
  noteMore: (n) => `and ${n} more`,
  subject: (order, total) => `Till discount over ${TILL_DISCOUNT_MAX}%: ${order}, ${dollars(total)} off`,
  subjectNotYet: (total) => `Till discount over ${TILL_DISCOUNT_MAX}%: ${dollars(total)} off, with no Shopify order yet`,
  subjectNoOrder: (total) => `Till discount over ${TILL_DISCOUNT_MAX}%: ${dollars(total)} off, with no Shopify order`,
  title: `A discount over ${TILL_DISCOUNT_MAX}%`,
  intro: (n, by) => `A sale at the till had a staff discount that took ${n === 1 ? 'one thing' : `${n} things`} more than ${TILL_DISCOUNT_MAX}% off.${by ? ` ${by} approved it with their PIN.` : ''}`,
  quiet: "Nobody at the till was told about this email. It's only so you know.",
  orderNotYet: `Not in Shopify yet. The Lair is still making it: it will have the tag ${TILL_DISCOUNT_OVER_TAG} when it's there.`,
  orderNone: "Shopify couldn't make its order, so there's nothing there to flag. The team have an email about making it by hand.",
  customer: 'A customer, on the customer screen',
  nobody: 'A quick sale (no member)',
  /** How it was paid: "$81.00 by card, taken by Hemi" */
  paid: (r) => {
    const rest = r.method === 'cash' ? 'in cash' : 'by card';
    const how = r.method === 'credit' || (r.credit && r.credit >= (r.total || 0)) ? 'with store credit' : r.credit ? `with ${dollars(r.credit)} of store credit and the rest ${rest}` : rest;
    return `${dollars(r.total)} ${how}${r.by_name ? `, taken by ${r.by_name}` : ''}`;
  },
  /** One line past 20%, for the email: "7 Wonders: $50.00 off, 47.6% off ($105.00 down to $55.00)" */
  overLine: (l) => `${l.qty > 1 ? `${l.qty} × ` : ''}${l.title}: ${dollars(l.off)} off${l.qty > 1 ? ' each' : ''}, ${TILL_OVER_WORDS.percent(l)} off${l.was ? ' what it was' : ''} (${l.was ? `${dollars(l.was)} before its sale, ` : ''}${dollars(l.unit)} down to ${dollars(l.unit - l.off)}${l.qty > 1 ? ' each' : ''})`,
  /** A discounted line within 20%: "2 × Riftbound Radiance · Booster Pack: $2.00 off each" */
  otherLine: (l) => `${l.qty > 1 ? `${l.qty} × ` : ''}${l.title}: ${dollars(l.discount.each ?? l.discount.amount)} off${l.qty > 1 && l.discount.each ? ' each' : ''}`,
  button: 'Open the order in Shopify',
  signoff: 'Gobgob, keeping an eye on the till',
};

/**
 * A line's percent off as a till that hasn't reloaded since round 35 sends it: null for none, else the percent (more
 * than 0, up to 20, at most 2 decimal places), or a 400. No awaits.
 */
export function tillDiscountIn(value) {
  if (value == null || value === '' || value === 0 || value === '0') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || Math.abs(Math.round(n * 100) - n * 100) > 1e-6) throw new RuleError(TILL_DISCOUNT_WORDS.over, 400);
  if (n === 0) return null;
  if (n > TILL_DISCOUNT_MAX) throw new RuleError(TILL_DISCOUNT_WORDS.over, 400);
  return Math.round(n * 100) / 100;
}

/**
 * Round 35: a line's dollars off each one as sent (`off`): null for none, else whole cents from 1 to TILL_OFF_MOST (a
 * number, or its digits as text: never dollars as text, "5.00" isn't 5 cents), or a 400. How much an item can come down
 * by is checked once Shopify has said its price (tillDiscountCheck). No awaits.
 */
export function tillOffIn(value) {
  if (value == null || value === '' || value === 0 || value === '0') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,7}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > TILL_OFF_MOST) throw new RuleError(TILL_DISCOUNT_WORDS.amount, 400);
  return n;
}

/**
 * Round 35: the most a discount can take off each one of an item, in cents: as far as 80% of its full price (rounded up
 * to the cent, so never under it) and no further. unit: its price now; was: Shopify's compare-at price, its full price
 * when that's above the price (it's on sale). 0 when it's at or under 80% of what it was already, or 20% of it isn't a
 * cent. No awaits.
 */
export function tillDiscountMost(unit, was = null) {
  const price = Math.max(0, Math.round(Number(unit) || 0));
  const full = Math.max(price, Math.round(Number(was) || 0));
  const least = full - Math.floor((full * TILL_DISCOUNT_MAX) / 100);
  return Math.max(0, price - least);
}

/**
 * What Shopify took off the basket's discounted lines, checked on its own figures (rounds 35 and 36): dollars off are
 * no more than the item's price, and what Shopify took off for them is what was asked (a cent either way); a percent
 * (a till that hasn't reloaded since round 35) is on an item that can have one (not on sale past 80% of what it was)
 * and comes to no more than it can come down by (Shopify rounds the line, so a cent each either way); and nothing else
 * came off the line (a deal). A discounted line the figures don't have is refused too. Throws a 422 naming the line
 * otherwise, with more.line: its key and Shopify's figures for it ({ key, unit, most, was?, deal? }: most 0 and deal
 * true when it's a deal that's in the way), which the Lair's answer carries beside the words.
 * Round 36: dollars off that take an item past 80% of its full price aren't refused: they're listed (over), for the
 * till to ask about and Pay to want its yes.
 * → { total, byKey: Map(key → cents), over: [{ key, title, qty, unit, was?, off, most, percent }] } (percent: how far
 * under its full price each one sells, to 2 places). lines: the sale's lines (with key, uuid, off or discount);
 * figures: tillFiguresOf's. No awaits.
 */
export function tillDiscountCheck(lines, figures) {
  const byUuid = new Map((figures?.lines || []).filter((l) => l.uuid).map((l) => [l.uuid, l]));
  const samePlaces = (figures?.lines || []).length === lines.length;
  const byKey = new Map();
  const over = [];
  let total = 0;
  lines.forEach((l, i) => {
    if (!l.discount && !l.off) return;
    const f = (l.uuid && byUuid.get(l.uuid)) || (samePlaces ? figures.lines[i] : null);
    if (!f) throw new RuleError(TILL_DISCOUNT_WORDS.wrong(l.title || 'That item'), 422);
    const name = [f.title, f.variantTitle].filter(Boolean).join(' · ') || 'That item';
    const qty = Math.max(1, Number(f.qty) || 1);
    const most = tillDiscountMost(f.unit, f.was);
    const off = Math.max(0, (f.total || 0) - (f.paid ?? f.total ?? 0));
    const staff = f.staff ?? off;
    // a refusal says which line, with Shopify's figures for it now, so the till can offer what it can take (nothing,
    // on a line a deal took something off)
    const no = (words, facts = {}) => Object.assign(new RuleError(words, 422), { more: { line: { key: l.key, unit: f.unit || 0, most, ...(f.was ? { was: f.was } : {}), ...facts } } });
    if (l.off) {
      // round 36: the whole price is as far as dollars off go (Shopify takes more as the whole price and says nothing)
      if (l.off > (f.unit || 0)) throw no(TILL_DISCOUNT_WORDS.tooMuch(name, f.unit || 0, qty));
      if (Math.abs(staff - l.off * qty) > 1) throw no(TILL_DISCOUNT_WORDS.wrong(name));
    } else {
      // (a percent, from a till that hasn't reloaded since round 35: held to the 80% as it was)
      if (most <= 0) throw no((f.was || 0) > (f.unit || 0) ? TILL_DISCOUNT_WORDS.onSale(name) : TILL_DISCOUNT_WORDS.none(name));
      if (staff > (most + 1) * qty) throw no(TILL_DISCOUNT_WORDS.most(name, most, qty));
    }
    if (off > staff + 1) throw no(TILL_DISCOUNT_WORDS.stacked(name), { most: 0, deal: true });
    // round 36: past 20% (under 80% of its full price) isn't refused: it's listed
    if (l.off && l.off > most) {
      const unit = f.unit || 0;
      const full = Math.max(unit, f.was || 0);
      const percent = full > 0 ? Math.round(((full - (unit - l.off)) / full) * 10000) / 100 : 100;
      // (never "20%" for something that's past it: a cent past on a dear thing rounds to it)
      over.push({ key: l.key, title: name, qty, unit, ...(f.was ? { was: f.was } : {}), off: l.off, most, percent: Math.max(percent, TILL_DISCOUNT_MAX + 0.01) });
    }
    byKey.set(l.key, staff);
    total += staff;
  });
  return { total, byKey, over };
}

/** Round 36: a line past 20% as the till is told of it: { key, off, most, unit, was?, percent } */
export const tillOverFacts = (l) => ({ key: l.key, off: l.off, most: l.most, unit: l.unit, ...(l.was ? { was: l.was } : {}), percent: l.percent });

/**
 * Round 36: Pay asked with lines past 20% and without the till's yes: a 422 naming the first, with more.over (every one,
 * tillOverFacts) and more.line (the first's figures, as any refusal over a line has). No awaits.
 */
export function tillOverAsk(over) {
  const first = over[0];
  return Object.assign(new RuleError(TILL_DISCOUNT_WORDS.overAsk(first.title), 422), {
    more: { over: over.map(tillOverFacts), line: { key: first.key, unit: first.unit, most: first.most, ...(first.was ? { was: first.was } : {}) } },
  });
}

/** Round 36: the paragraph on a flagged order's note (its first 8 lines, then how many more) */
export function tillOverNote(over) {
  const lines = over.slice(0, 8).map(TILL_OVER_WORDS.noteLine);
  if (over.length > 8) lines.push(TILL_OVER_WORDS.noteMore(over.length - 8));
  return TILL_OVER_WORDS.note(lines);
}

/**
 * The figures' discounts with the staff discount among them: Shopify lists the shop's own discounts (the dice deal);
 * the staff discount is added once when it's taken something off and isn't listed already. No awaits.
 */
export function tillDiscountsShown(discounts, staffTotal) {
  const list = (discounts || []).filter((d) => d.title !== TILL_DISCOUNT_TITLE);
  return staffTotal > 0 ? [...list, { title: TILL_DISCOUNT_TITLE, amount: staffTotal }] : list;
}

/** Who can approve a discount: the owner, or anyone on the till with Money */
export function tillApprovesDiscounts(person) {
  return Boolean(person) && (person.role === 'owner' || (person.perms || []).includes('money'));
}

export const tillDiscountMethods = {
  /**
   * The person a discount approval is from: discountOk is the till token from a PIN put in within the last 10 minutes,
   * by the owner or someone with Money, and not already used for a sale that's paid or still open on another till.
   * → the person ({ id, name, ... }) and the token's hash, or throws. No awaits (tokenHash and team read already).
   */
  tillDiscountApprover(tokenHash, team, till, now = Date.now()) {
    if (!tokenHash) throw new RuleError(TILL_DISCOUNT_WORDS.needOk, 403);
    const session = this.sql.exec('SELECT * FROM till_sessions WHERE token_hash = ?', tokenHash).toArray()[0];
    if (!session || session.created_at < now - TILL_DISCOUNT_FRESH_MS) throw new RuleError(TILL_DISCOUNT_WORDS.stale, 401);
    const person = this.tillOn(tokenHash, team, { now });
    if (!tillApprovesDiscounts(person)) throw new RuleError(TILL_DISCOUNT_WORDS.notMoney(person.name), 403);
    const usedElsewhere = this.sql
      .exec("SELECT 1 AS n FROM till_sales WHERE discount_ok = ? AND (status = 'paid' OR (status IN ('making', 'open') AND till != ?)) LIMIT 1", tokenHash, till)
      .toArray().length;
    if (usedElsewhere) throw new RuleError(TILL_DISCOUNT_WORDS.used, 409);
    return { person, tokenHash };
  },

  /* ---------------- round 36: a paid sale past 20% is flagged, and the owner emailed ---------------- */
  /** Flag a paid sale's order and send its email in the background, when either is due. No awaits. */
  tillOverSoon(id) {
    const telling = this.tillOverClaim(id);
    if (telling) this.later(telling);
    return Boolean(telling);
  },

  /**
   * Claim what's due for a paid sale past 20% (its order's flag, the owner's email), when its wait is up or its try
   * never finished. The try, or null. No awaits before the claim.
   */
  tillOverClaim(id, now = Date.now()) {
    const r = this.tillSaleRow(id);
    if (!r || r.status !== 'paid' || !r.discount_over || (r.over_mark !== 'due' && r.over_mail !== 'due')) return null;
    if (r.over_next_at != null && r.over_next_at > now) return null;
    const tries = (r.over_tries || 0) + 1;
    this.write('UPDATE till_sales SET over_tries = ?, over_next_at = ? WHERE id = ?', tries, now + TILL_OVER_STUCK, id);
    return this.tillOverTell(id, tries);
  },

  /**
   * Where the owner's email goes: DISCOUNT_EMAIL when it's set (it has to be one address), else the shop owner's own
   * address as Shopify has it (Shop.email), asked for at most once an hour. → the address, or throws saying why there
   * isn't one. Never STAFF_EMAIL: this one is the owner's alone.
   */
  async tillOverTo() {
    const setting = String(this.env?.DISCOUNT_EMAIL || '').trim();
    if (setting) {
      if (!isOneEmail(setting)) throw new Error("DISCOUNT_EMAIL isn't one email address");
      return setting;
    }
    const kept = this.tillOwner;
    if (kept && Date.now() - kept.at < TILL_OWNER_KEPT) return kept.email;
    if (!this.shopify?.configured) throw new Error("Shopify isn't set up, so there's no owner's address to send to");
    let email;
    try {
      email = String((await this.shopify.shopOwnerEmail()) || '').trim();
    } catch (e) {
      throw new Error(`Shopify couldn't say the owner's address (${errorText(e).slice(0, 120)})`);
    }
    if (!isOneEmail(email)) throw new Error('Shopify has no email address for the shop owner');
    this.tillOwner = { email, at: Date.now() };
    return email;
  },

  /**
   * One try at a paid sale's flag and email. The flag: its order tagged discount-over-20, with a paragraph on its note
   * (needs the order: it waits while the order is still being made, and stops when it can't be). The email: to the
   * owner (tillOverTo), once the order is made (or can't be, or 10 minutes have gone): written once and kept, and sent
   * with its Resend key, so the same email never goes twice and no second, different one ever follows it. What's still
   * due is looked at again by the next 10-minute run; the email is given up on 23 hours after the sale was paid, the
   * flag after 3 days. Every await is followed by a check the try is still this one.
   */
  async tillOverTell(id, tries) {
    const mine = () => {
      const row = this.tillSaleRow(id);
      return row?.status === 'paid' && row.over_tries === tries ? row : null;
    };
    let r = mine();
    if (!r) return null;
    const over = parse(r.discount_over, []);
    let error = null;
    // --- its order's tag and note ---
    if (r.over_mark === 'due') {
      if (r.order_id && this.shopify?.configured) {
        try {
          await this.shopify.gwMarkOrder(r.order_id, TILL_DISCOUNT_OVER_TAG, tillOverNote(over));
          if (!mine()) return null;
          this.write("UPDATE till_sales SET over_mark = 'done' WHERE id = ?", id);
        } catch (e) {
          console.error('Lair: could not flag a till sale past 20% in Shopify', e);
          error = `flag: ${errorText(e)}`;
        }
      } else if (r.order_status === 'stopped' && !r.order_id) {
        this.write("UPDATE till_sales SET over_mark = 'stopped' WHERE id = ?", id);
      }
    }
    // --- the owner's email ---
    if (!(r = mine())) return null;
    if (r.over_mail === 'due') {
      const paidFor = Date.now() - (r.paid_at || Date.now());
      if (String(this.env?.DISCOUNT_EMAIL || '').trim().toLowerCase() === 'off') {
        this.write("UPDATE till_sales SET over_mail = 'off' WHERE id = ?", id);
      } else if (paidFor < TILL_OVER_MAIL_FOR && (r.over_letter || r.order_id || r.order_status === 'stopped' || paidFor >= TILL_OVER_MAIL_WAIT)) {
        if (!emailReady(this.env)) error = 'email: email is not set up (RESEND_API_KEY and FROM_EMAIL)';
        else {
          // The letter is written once and kept, with its key and the sender it was written with, and every try sends
          // exactly that: the email service knows a second send of it by its key, and turns the key away with other
          // words. So a try that may have gone is never followed by a different email.
          let letter = parse(r.over_letter, null);
          if (!letter) {
            let to = null;
            try {
              to = await this.tillOverTo();
            } catch (e) {
              error = `email: ${errorText(e)}`;
            }
            if (!(r = mine())) return null;
            if (to) {
              const written = r.over_letters || 0;
              letter = { ...this.tillOverLetter(r, over, to), ...emailSender(this.env), pinned: true, idempotencyKey: written ? `till-over-${id}-${written + 1}` : `till-over-${id}` };
              this.write('UPDATE till_sales SET over_letter = ?, over_letters = ? WHERE id = ?', JSON.stringify(letter), written + 1, id);
            }
          }
          if (letter) {
            const sent = await this.mail(letter);
            if (!mine()) return null;
            if (sent?.ok) this.write("UPDATE till_sales SET over_mail = 'sent' WHERE id = ?", id);
            else {
              error = `email: ${[sent?.status || null, String(sent?.message || 'not sent')].filter(Boolean).join(': ').slice(0, 250)}`;
              // the letter itself was turned away (an address the email service won't take): it's written again next
              // time, to the address as it is then, with a key of its own
              if ([400, 422].includes(sent?.status)) this.write('UPDATE till_sales SET over_letter = NULL WHERE id = ?', id);
            }
          }
        }
      }
    }
    // --- what's left: tried again by the next 10-minute run (the email, once its wait for the order is up), or given up on ---
    if (!(r = mine())) return null;
    const now = Date.now();
    const paidFor = now - (r.paid_at || now);
    const mail = r.over_mail === 'due' && paidFor >= TILL_OVER_MAIL_FOR ? 'stopped' : r.over_mail;
    const mark = r.over_mark === 'due' && paidFor >= TILL_OVER_FLAG_FOR ? 'stopped' : r.over_mark;
    const waiting = mail === 'due' && !r.order_id && r.order_status !== 'stopped' && paidFor < TILL_OVER_MAIL_WAIT;
    const next = mail !== 'due' && mark !== 'due' ? null : waiting ? (r.paid_at || now) + TILL_OVER_MAIL_WAIT : now + TILL_OVER_AGAIN;
    // (the last thing that went wrong stays on the row until both are done)
    const clean = ['done', 'stopped'].includes(mark) && ['sent', 'off'].includes(mail) && !error && !(mark === 'stopped' && r.order_id);
    this.write(
      'UPDATE till_sales SET over_mark = ?, over_mail = ?, over_next_at = ?, over_error = ?, over_letter = ? WHERE id = ?',
      mark, mail, next, clean ? null : error || r.over_error || null, mail === 'due' ? r.over_letter : null, id,
    );
    if (error) this.note({ tillOver: { sale: id, error: String(error).slice(0, 200), at: new Date(now).toISOString() } });
    return { mark, mail };
  },

  /**
   * The owner's email about a paid sale past 20%: what was sold, by whom, what came off what, and its order.
   * → letter()'s { to, subject, html, text }. No awaits.
   */
  tillOverLetter(r, over, to) {
    const W = TILL_OVER_WORDS;
    const overKeys = new Set(over.map((l) => l.key));
    const others = parse(r.shown, []).filter((l) => l.discount && !overKeys.has(l.key));
    const shop = String(this.env?.SHOP || '').replace(/\.myshopify\.com$/, '');
    const orderUrl = r.order_id && shop ? `https://admin.shopify.com/store/${shop}/orders/${String(r.order_id).split('/').pop()}` : null;
    const order = r.order_id ? r.order_name || 'its order' : null;
    const staffTotal = r.discount_total || over.reduce((n, l) => n + l.off * l.qty, 0);
    const subject = order ? W.subject(order, staffTotal) : r.order_status === 'stopped' ? W.subjectNoOrder(staffTotal) : W.subjectNotYet(staffTotal);
    const when = new LairTime(this.rulesCache?.tz || 'Pacific/Auckland').label(r.paid_at || Date.now());
    return this.letter(to, subject, {
      title: W.title,
      intro: [W.intro(over.length, r.discount_by_name || null), W.quiet],
      details: [
        ['Order', order || (r.order_status === 'stopped' ? W.orderNone : W.orderNotYet)],
        ['When', when],
        ['Rung up by', r.started_by_name || W.customer],
        ['Approved by', r.discount_by_name || ''],
        ['Paid', W.paid(r)],
        ['Sold to', r.customer_id ? this.memberName(r.customer_id) : W.nobody],
        [`More than ${TILL_DISCOUNT_MAX}% off`, over.map(W.overLine).join('\n')],
        ['Other discounts', others.map(W.otherLine).join('\n')],
        ['Before discounts', dollars(r.subtotal)],
        ['Staff discounts', dollars(staffTotal)],
      ],
      button: orderUrl ? { label: W.button, url: orderUrl } : null,
      signoff: W.signoff,
    });
  },
};

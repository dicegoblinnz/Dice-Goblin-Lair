/**
 * Round 33 (7 Nov 2026, contract v33-credit-pay): store credit as a way to pay, in My Lair and at the till. Mo: "I want
 * to add pay using store credit for clients as an extra option thanks"; asked where, he picked both: the counter till
 * (store credit next to card and cash, src/till-sales.js) and My Lair's bill (Pay with store credit beside Pay with cash,
 * here). Online at Shopify's checkout and on Shopify POS, store credit already worked.
 *
 * Store credit is Shopify's: the Lair takes it off (storeCreditAccountDebit) and puts it back (storeCreditAccountCredit),
 * as damage charges (round 10) and gifts (round 30) do. Nothing the browser says about a balance or a total is trusted.
 * Each payment is a row in credit_payments, written before Shopify is asked, so store credit never moves twice:
 *  - 'taking': coming off their store credit now
 *  - 'taken': it came off (a till sale's, held while the rest is paid by card or cash)
 *  - 'paid': it paid for what it was taken for (My Lair's bill, or a till sale)
 *  - 'checking': Shopify didn't answer while it came off (it may or may not have): the 10-minute run looks in their store
 *    credit from CREDIT_PAY.lookAfter. A lost answer never pays anything: found, it goes back on; not there after
 *    CREDIT_PAY.goneAfter, it never came off ('failed')
 *  - 'returning': it came off, but it isn't paying for anything after all, so it's going back on now
 *  - 'returned': it came off and went back on: nothing moved in the end
 *  - 'failed': nothing came off (Shopify said no, there wasn't enough, or it never came off)
 *  - 'check': no answer while it went back on, or Shopify unreadable for CREDIT_PAY.askAfter: staff look in Shopify admin
 * A row left 'taking' by a restart mid-call (CREDIT_PAY.stale) counts as an answer lost; one left 'returning' goes to staff.
 *
 * My Lair's bill (POST /me/credit) is what Pay with cash pays (src/cash.js cashBill): today's bookings, seats and sign-ups
 * with something to pay, what's owed and today's tab. Saved passes on today's bookings are used first, as checking in
 * uses them (nobody's checked in). Its Shopify order is made in the background, as cash's are.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair:
 * every await first, then synchronous reads, checks and writes.
 */
import { HOUR, LairTime, MIN, RuleError, makeId } from './core.js';

export const CREDIT_PAY = Object.freeze({
  // how long My Lair's take-off may take before its answer counts as lost
  timeoutMs: 20_000,
  // a payment taking or returning this long had no answer (the Lair restarted mid-call)
  stale: 30 * MIN,
  // an answer lost while it came off: looked for in their store credit from lookAfter, until goneAfter (then it didn't
  // come off), allowing skew either side for the two clocks
  lookAfter: 2 * MIN,
  goneAfter: 30 * MIN,
  skew: 2 * MIN,
  // Shopify can't be read about it for this long: staff look
  askAfter: 2 * HOUR,
  // payments looked at in one 10-minute run
  perRun: 10,
});

/** The Shopify order for My Lair's bill paid from store credit: its tags, and the marker on the draft that finds it again */
export const CREDIT_ORDER_TAG = 'lair-credit';
const CREDIT_ORDER_TAGS = [CREDIT_ORDER_TAG, 'store-credit'];
const CREDIT_MARKER = '_lair_credit';
/** Waits before each try again at its Shopify order, as cash's: then one last look, then staff hear */
const ORDER_RETRY = [10 * MIN, 30 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR];
const ORDER_LAST_LOOK = HOUR;
/** A try that never finished (the Worker stopped) is taken over after this */
const ORDER_STUCK = 15 * MIN;
/** A new draft is only asked for while this much of its claim is left */
const ORDER_SEND_MARGIN = 5 * MIN;
const ORDER_READY_WAIT = 1000;
const ORDER_READY_TRIES = 5;
/** Orders made a run, so a run stays short */
const ORDERS_A_RUN = 10;

/** The ledger's table and indexes (made when missing) */
export const CREDIT_PAY_TABLES = [
  // source: 'me' (My Lair's bill) or 'till' (a till sale, sale_id). key: My Lair's own for the payment (none at the till).
  // items: what My Lair's bill was (as Pay with cash lists it); lines: its Shopify order's lines. stage: for 'check', the
  // change whose answer was lost ('take' or 'back'). take_tx, back_tx: Shopify's store credit transactions.
  `CREATE TABLE IF NOT EXISTS credit_payments (
     id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, sale_id TEXT, key TEXT, day TEXT NOT NULL,
     amount INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, stage TEXT, items TEXT, lines TEXT, take_tx TEXT,
     back_tx TEXT, balance_after INTEGER, message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, paid_at INTEGER,
     order_status TEXT, order_tries INTEGER NOT NULL DEFAULT 0, order_next_at INTEGER, order_draft TEXT, order_sent_at INTEGER,
     order_id TEXT, order_name TEXT, order_error TEXT)`,
  // the same tap again gives back the first payment and moves nothing
  'CREATE UNIQUE INDEX IF NOT EXISTS credit_payments_key ON credit_payments (customer_id, key)',
  'CREATE INDEX IF NOT EXISTS credit_payments_customer ON credit_payments (customer_id, status)',
  'CREATE INDEX IF NOT EXISTS credit_payments_status ON credit_payments (status, updated_at)',
  'CREATE INDEX IF NOT EXISTS credit_payments_order ON credit_payments (order_status, order_next_at)',
  'CREATE INDEX IF NOT EXISTS credit_payments_sale ON credit_payments (sale_id)',
];
/** A till sale's store credit: the cents taken for it, and its payment (made when missing) */
export const CREDIT_PAY_COLUMNS = [['till_sales', 'credit', 'INTEGER'], ['till_sales', 'credit_id', 'TEXT']];

const money = (cents) => `$${(Math.round(Number(cents) || 0) / 100).toFixed(2)}`;
const said = (error) => String(error?.message || error || 'no answer').replace(/^Shopify API:\s*/, '').slice(0, 160);
const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every message members and staff see, word for word in the contract */
export const CREDIT_PAY_WORDS = {
  login: 'Log in to pay with your store credit.',
  noAccount: 'Open My Lair once first, then try again.',
  key: "That didn't come through properly. Try again.",
  expect: 'expect is the amount you were shown, in cents.',
  monthly: "You're on a monthly account, so it all goes on your bill. Pay it online in My Lair, or at the counter.",
  nothing: "There's nothing to pay right now.",
  passCovered: "Your session pass covered it, so there's nothing to pay.",
  changed: (total) => `Your bill's ${money(total)} now (a session pass took some off, or something changed). Check it, then pay again.`,
  atCounter: "It's being rung up at the counter right now, so pay there.",
  off: "Store credit can't be used right now. Try again in a minute.",
  short: (balance, total) => (balance > 0
    ? `You have ${money(balance)} of store credit, so it doesn't cover ${money(total)}. Use it at the counter and pay the rest there.`
    : "You don't have any store credit right now."),
  shortNow: "You don't have that much store credit now. Check your balance, then try again.",
  notTaken: (why) => `Shopify didn't take the store credit off your account (${why}). Nothing moved. Try again in a minute.`,
  busy: 'Your last store credit payment is still being checked. Try again in a few minutes, or pay at the counter.',
  checking: "Shopify didn't answer, so your bill wasn't paid. If any store credit came off, Gobgob puts it back within 30 minutes.",
  paidElsewhere: "Something on your bill was paid another way just now, so your store credit's going back on. Check your bill, then pay again.",
  paid: (total, balance) => (balance != null
    ? `Paid! ${money(total)} came off your store credit, and ${money(balance)} is left.`
    : `Paid! ${money(total)} came off your store credit.`),
  tillPerson: 'Store credit needs a member on the sale: scan their code first.',
  tillOff: "Shopify didn't answer about their store credit. Try again in a moment, or pay another way.",
  tillNone: "They don't have any store credit right now.",
  tillShort: (balance, total) => `Their store credit is ${money(balance)}, so it doesn't cover ${money(total)}. Use it for part, and pay the rest by card or cash.`,
  tillChanged: "Their store credit changed while it was paying, so this sale wasn't saved. Scan their code again.",
  tillNotTaken: (why) => `Shopify wouldn't take their store credit (${why}), so this sale wasn't saved. Pay another way.`,
  tillLost: "Shopify didn't answer about their store credit, so this sale wasn't saved. Any that came off goes back on by itself within 30 minutes.",
  tillBusy: 'Their last store credit payment is still being checked. Pay another way, or try again in a few minutes.',
};
const W = CREDIT_PAY_WORDS;

// the statuses still with Shopify (or waiting to be looked for there): a member has one of these at a time
export const CREDIT_PAY_MOVING = ['taking', 'checking', 'returning'];
const MOVING_SQL = `(${CREDIT_PAY_MOVING.map((s) => `'${s}'`).join(', ')})`;

export const creditPayMethods = {
  /* ---------------- rows and views ---------------- */

  creditPayRow(id) {
    return id ? this.sql.exec('SELECT * FROM credit_payments WHERE id = ?', String(id)).toArray()[0] || null : null;
  },

  /** Change a payment's own row. No awaits. */
  creditPayUpdate(id, fields) {
    const sets = Object.keys(fields).map((k) => `${k} = ?`);
    this.write(`UPDATE credit_payments SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...Object.values(fields), Date.now(), id);
  },

  /** Whether a member has a payment still with Shopify (or waiting to be looked for there). No awaits. */
  creditPayBusy(customerId) {
    return this.sql.exec(`SELECT 1 AS n FROM credit_payments WHERE customer_id = ? AND status IN ${MOVING_SQL} LIMIT 1`, String(customerId)).toArray().length > 0;
  },

  /** A payment as the member sees it: { id, status ('paid' | 'checking' | 'failed' | 'returned'), amount, items, at, paidAt }. No awaits. */
  creditPayView(row) {
    if (!row) return null;
    const status = row.status === 'paid' ? 'paid' : ['failed', 'returned'].includes(row.status) ? row.status : 'checking';
    return { id: row.id, status, amount: row.amount, items: parse(row.items, []), at: row.created_at, paidAt: row.paid_at || null };
  },

  /** GET /me's creditPay: their payment from My Lair still being checked, or null. No awaits. */
  memberCreditPay(customerId) {
    const row = this.sql
      .exec(`SELECT * FROM credit_payments WHERE customer_id = ? AND source = 'me' AND status IN ${MOVING_SQL} ORDER BY created_at DESC, rowid DESC LIMIT 1`, String(customerId))
      .toArray()[0];
    return row ? this.creditPayView(row) : null;
  },

  /**
   * Every store credit debit the Lair knows it took (staff changes, damage charges, gifts and these payments), so a lost
   * answer is never matched to a debit that was something else's. No awaits.
   */
  creditKnownDebits() {
    return new Set([
      ...this.sql.exec('SELECT transaction_id AS id FROM member_credit WHERE transaction_id IS NOT NULL').toArray(),
      ...this.sql.exec('SELECT transaction_id AS id FROM damage_payments WHERE transaction_id IS NOT NULL').toArray(),
      ...this.sql.exec('SELECT take_tx AS id FROM credit_gifts WHERE take_tx IS NOT NULL').toArray(),
      ...this.sql.exec('SELECT take_tx AS id FROM credit_payments WHERE take_tx IS NOT NULL').toArray(),
    ].map((r) => r.id));
  },

  /* ---------------- My Lair's bill ---------------- */

  /**
   * Saved session passes on today's bookings that pay at the counter, used as checking in uses them (nobody's checked
   * in). Returns the notices. No awaits.
   */
  creditPayPasses(customerId, rules, now) {
    const day = this.memberDay(customerId, rules, now);
    const notices = [];
    for (const r of day.today) {
      if (r.type === 'join' || !(r.due > 0) || !['confirmed', 'seated'].includes(r.status)) continue;
      const booking = this.booking(r.id);
      if (!booking?.passId) continue;
      const used = this.usePassAtCheckIn(booking, undefined, rules, now, `credit:${customerId}`);
      if (used.notice) notices.push(used.notice);
    }
    return notices;
  },

  /**
   * Whether a member's bill is being rung up at the till now: today's tab at the counter, or a booking on it in a till
   * sale that isn't let go (or is paid and still paying it). No awaits.
   */
  creditPayAtCounter(customerId, bill, rules, now) {
    if (this.todayTabRow(customerId, rules, now)?.status === 'in-cart') return true;
    const refs = new Set(bill.items.filter((x) => x.ref).map((x) => String(x.ref).toUpperCase()));
    if (!refs.size) return false;
    const pending = this.tillPendingRefs(now);
    if ([...refs].some((ref) => pending.has(ref))) return true;
    return this.sql
      .exec("SELECT refs FROM till_sales WHERE status IN ('making', 'open')")
      .toArray()
      .some((s) => parse(s.refs, []).some((ref) => refs.has(String(ref).toUpperCase())));
  },

  /** The same bill: the same things at the same amounts. No awaits. */
  creditPaySameBill(a, b) {
    const shape = (bill) => JSON.stringify(bill.items.map((x) => [x.kind, x.id, x.amount]));
    return a.total === b.total && shape(a) === shape(b);
  },

  /**
   * POST /me/credit { expect, key } (logged in): pay what's on My Lair's bill now from their store credit. key (8 to 64
   * letters, numbers, dashes or underscores, the page's own for this payment) makes it safe to send again: the same key
   * gives back the first payment (repeated: true) and moves nothing. Returns { credit, balance (theirs after, in cents,
   * or null), message }. A lost answer is a 200 with credit.status 'checking'.
   */
  async payBillWithCredit(input, who) {
    if (!who?.customerId) throw new RuleError(W.login, 401);
    const customerId = String(who.customerId);
    if (!this.memberRow(customerId)) throw new RuleError(W.noAccount, 404);
    const key = typeof input?.key === 'string' ? input.key : '';
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new RuleError(W.key, 400);
    const repeat = () => this.sql.exec('SELECT * FROM credit_payments WHERE customer_id = ? AND key = ?', customerId, key).toArray()[0] || null;
    const again = repeat();
    if (again) return this.creditPayRepeat(again);
    const expect = input?.expect;
    if (typeof expect !== 'number' || !Number.isInteger(expect) || expect < 0) throw new RuleError(W.expect, 400);
    const rules = await this.rules();
    // their balance first, when Shopify will say, for a clear "you have $8.50" (Shopify refuses to take more anyway)
    const balance = this.shopify?.configured ? await this.creditBalanceOrNull(customerId) : null;
    // --- no awaits until it's claimed (a second tap may have come in meanwhile) ---
    const raced = repeat();
    if (raced) return this.creditPayRepeat(raced);
    if (this.accountRow(customerId)?.billing === 'monthly') throw new RuleError(W.monthly, 409);
    if (this.creditPayBusy(customerId)) throw new RuleError(W.busy, 409);
    const now = Date.now();
    const before = this.cashBill(customerId, rules, now);
    if (!before.total) throw new RuleError(W.nothing, 409);
    if (this.creditPayAtCounter(customerId, before, rules, now)) throw new RuleError(W.atCounter, 409);
    if (!this.shopify?.configured || balance == null) throw new RuleError(W.off, 503);
    // saved passes first, as at check-in: the bill they'd pay at the counter
    this.creditPayPasses(customerId, rules, now);
    const bill = this.cashBill(customerId, rules, now);
    if (!bill.total) throw new RuleError(W.passCovered, 409);
    if (bill.total !== expect) throw new RuleError(W.changed(bill.total), 409);
    if (balance < bill.total) throw new RuleError(W.short(balance, bill.total), 409);
    const id = makeId('cp');
    const currency = this.env?.CURRENCY || 'NZD';
    this.write(
      `INSERT INTO credit_payments (id, customer_id, source, key, day, amount, currency, status, items, created_at, updated_at)
       VALUES (?, ?, 'me', ?, ?, ?, ?, 'taking', ?, ?, ?)`,
      id, customerId, key, new LairTime(rules.tz).key(now), bill.total, currency, JSON.stringify(bill.items), now, now,
    );
    // --- claimed: now Shopify. Afterwards only this payment's own row, then the bill, are touched ---
    let took;
    try {
      took = await this.shopify.changeStoreCredit(customerId, -bill.total, currency, { timeout: CREDIT_PAY.timeoutMs });
    } catch (error) {
      // --- no awaits from here on ---
      this.creditPayForget(customerId);
      if (!error?.refused) {
        // it may or may not have come off: the 10-minute run looks in their store credit, and it pays nothing either way
        console.error('Lair: store credit for a bill had no answer taking it off', error);
        this.creditPayUpdate(id, { status: 'checking', stage: 'take', message: said(error) });
        return { credit: this.creditPayView(this.creditPayRow(id)), balance: null, message: W.checking };
      }
      const message = error.code === 'INSUFFICIENT_FUNDS' ? W.shortNow : W.notTaken(said(error));
      this.creditPayUpdate(id, { status: 'failed', message });
      throw new RuleError(message, 409);
    }
    // --- no awaits from here on: the bill read again, as it is now ---
    this.creditPayForget(customerId);
    this.creditPayUpdate(id, { status: 'taken', take_tx: took?.id || null, balance_after: took?.balanceAfter ?? null });
    const at = Date.now();
    const fresh = this.cashBill(customerId, rules, at);
    if (!this.creditPaySameBill(fresh, bill) || this.creditPayAtCounter(customerId, fresh, rules, at)) {
      // something on it was paid another way (or changed) while the store credit came off: it all goes back on
      this.creditPayReturnSoon(id, 'the bill changed while it came off', { message: W.paidElsewhere });
      throw new RuleError(W.paidElsewhere, 409);
    }
    this.creditPayBill(id, customerId, bill, rules, at);
    const row = this.creditPayRow(id);
    return { credit: this.creditPayView(row), balance: row.balance_after ?? null, message: W.paid(row.amount, row.balance_after ?? null) };
  },

  /** The same tap again: the first payment as it stands. No awaits. */
  creditPayRepeat(row) {
    const view = this.creditPayView(row);
    const message = view.status === 'paid' ? W.paid(row.amount, row.balance_after ?? null)
      : view.status === 'failed' ? row.message || W.shortNow
        : view.status === 'returned' ? row.message || W.checking : W.checking;
    return { credit: view, balance: row.balance_after ?? null, message, repeated: true };
  },

  /**
   * Store credit that came off for My Lair's bill pays it: a payment for each booking, seat and sign-up (order
   * credit:<id>, the member as the payer, as cash's), today's tab paid, what's owed settled, a TTRPG seat's GM credited, a
   * waiting Pay with cash request ended, and its Shopify order started. No awaits.
   */
  creditPayBill(id, customerId, bill, rules, now) {
    const orderKey = `credit:${id}`;
    const paying = [];
    const orderLines = [];
    for (const item of bill.items) {
      if (item.kind === 'tab') continue;
      paying.push({ type: item.kind === 'join' ? 'join' : 'booking', id: item.id, lineId: `line-${paying.length + 1}`, amount: item.amount });
      // (with its code, as the counter's own lines have, so staff can find the booking from Shopify's order)
      orderLines.push({ title: `${String(item.title || 'Lair booking')}${item.ref ? ` (${item.ref})` : ''}`.slice(0, 120), cents: item.amount });
    }
    const paidRefs = paying.length ? this.recordPayments(paying, orderKey, rules, { pos: true, now }) : [];
    if (paying.length) this.write('UPDATE payments SET customer_id = ? WHERE order_id = ? AND customer_id IS NULL', customerId, orderKey);
    const tab = bill.items.some((x) => x.kind === 'tab') ? this.cashTab(customerId, rules, now) : null;
    if (tab) {
      for (const t of parse(tab.items, [])) orderLines.push({ variantId: String(t.variantId), qty: Number(t.qty) || 1, cents: Number(t.price) || 0, title: t.title });
      this.markTabsPaid([tab.id], orderKey, now);
    }
    if (paidRefs.length || tab) this.reconcileBills(rules, now, { orderId: orderKey, pos: true });
    // (round 30) a TTRPG seat paid gives its GM their fee once its session has started (src/gm-credit.js)
    if (paidRefs.length) this.gmCreditSoon();
    // a Pay with cash request still waiting is for this same bill: it's paid now
    this.write("UPDATE cash_requests SET status = 'ended', ended_at = ?, ended_by = 'store credit', updated_at = ? WHERE customer_id = ? AND status = 'waiting'", now, now, customerId);
    this.creditPayUpdate(id, { status: 'paid', paid_at: now, lines: JSON.stringify(orderLines), order_status: 'due' });
    this.touchMember(customerId, {}, now);
    this.startCreditOrder(id);
  },

  /** The till keeps a member's store credit for a minute (src/till-people.js): once some has moved, it's read again, so
      their next sale doesn't show what they had before. No awaits. */
  creditPayForget(customerId) {
    if (this.tillCredits) this.tillCredits.delete(String(customerId));
  },

  /* ---------------- going back on ---------------- */

  /**
   * Store credit that came off but pays for nothing after all goes back on, in the background. from: the statuses it may
   * go back from ('taken' for a till sale let go or a bill that changed; the run also passes 'checking' for a lost answer
   * it found). message: kept for the member's same tap again. Returns whether it started. No awaits.
   */
  creditPayReturnSoon(id, why, { from = ['taken'], message = null } = {}) {
    const row = this.creditPayRow(id);
    if (!row || !from.includes(row.status)) return false;
    this.creditPayUpdate(id, { status: 'returning', stage: null, message: message || String(why).slice(0, 300) });
    this.later(this.creditPayReturn(id));
    return true;
  },

  /** Put a payment's store credit back on their account: 'returned', or 'check' (staff hear) when Shopify doesn't confirm it. */
  async creditPayReturn(id) {
    const row = this.creditPayRow(id);
    if (!row || row.status !== 'returning') return { id, already: row?.status || null };
    let back;
    try {
      back = await this.shopify.changeStoreCredit(row.customer_id, row.amount, row.currency, { timeout: CREDIT_PAY.timeoutMs });
    } catch (error) {
      // --- no awaits from here on ---
      this.creditPayForget(row.customer_id);
      console.error('Lair: store credit for a payment could not go back on', error);
      const fresh = this.creditPayRow(id);
      if (!fresh || fresh.status !== 'returning') return { id };
      this.creditPayUpdate(id, { status: 'check', stage: 'back', message: `back: ${said(error)}` });
      this.creditPayCheckAlert(this.creditPayRow(id));
      return { id, status: 'check' };
    }
    // --- no awaits from here on ---
    this.creditPayForget(row.customer_id);
    this.creditPayUpdate(id, { status: 'returned', stage: null, back_tx: back?.id || null, balance_after: back?.balanceAfter ?? null });
    return { id, status: 'returned' };
  },

  /** Staff hear about a payment Shopify didn't confirm, with what to look for and what to do by hand. Once a day each. No awaits. */
  creditPayCheckAlert(row) {
    const name = this.creditGiftName(row.customer_id);
    const first = this.creditGiftFirst(row.customer_id);
    const amount = money(row.amount);
    const time = new Intl.DateTimeFormat('en-NZ', { timeZone: this.rulesCache?.tz || 'Pacific/Auckland', hour: 'numeric', minute: '2-digit', hour12: true })
      .format(new Date(row.created_at)).replace(/\s/g, '').toLowerCase();
    const what = row.source === 'till' ? 'a till sale' : 'their bill in My Lair';
    const intro = row.stage === 'back'
      ? `${amount} of ${first}'s store credit came off for ${what} that didn't go ahead, so it was going back on, but Shopify didn't confirm it did. Look at ${first}'s store credit in Shopify admin: if ${amount} came back on after about ${time}, there's nothing to do. If it didn't, add ${amount} on ${first}'s member page, under Store credit. Gobgob won't try again by itself, so it never goes back twice.`
      : `${first} paid ${amount} of store credit for ${what} at about ${time}, but Shopify didn't answer, and the Lair can't read ${first}'s store credit to check. Nothing was paid with it. Look at it in Shopify admin: if ${amount} came off then, add ${amount} back on ${first}'s member page, under Store credit. If nothing came off, there's nothing to do.`;
    this.staffAlert(`credit-pay-check:${row.id}`, `Check a store credit payment: ${name}`, {
      title: row.stage === 'back' ? 'Did the store credit go back on?' : 'Did the store credit come off?',
      intro,
      details: [['Member', name], ['Amount', amount], ['For', what], ['Shopify said', row.message || 'no answer']],
    });
  },

  /* ---------------- My Lair's bill: its Shopify order (as cash's) ---------------- */

  /** Start the Shopify order for a bill paid from store credit, in the background. No awaits. */
  startCreditOrder(id) {
    const making = this.creditOrder(id);
    if (making) this.later(making);
    return Boolean(making);
  },

  /**
   * Claim and make the Shopify order for a bill paid from store credit, or try again when an earlier try didn't finish.
   * One whose time hasn't come is left alone, so overlapping runs never make it twice. The try, or null. No awaits
   * before the claim.
   */
  creditOrder(id) {
    const r = this.creditPayRow(id);
    if (!r || r.source !== 'me' || r.status !== 'paid' || !['due', 'making', 'failed'].includes(r.order_status)) return null;
    const now = Date.now();
    if (r.order_next_at != null && r.order_next_at > now) return null;
    if (!this.shopify?.configured) return null;
    const tries = (r.order_tries || 0) + 1;
    if (tries > ORDER_RETRY.length + 2) {
      this.creditOrderStopped(r, r.order_error || "Shopify didn't answer.", now);
      return null;
    }
    this.write("UPDATE credit_payments SET order_status = 'making', order_tries = ?, order_next_at = ? WHERE id = ?", tries, now + ORDER_STUCK, id);
    return this.sendCreditOrder(id, tries);
  },

  /**
   * Ask Shopify for the order, never twice: a draft kept from an earlier try is looked at first; a try that may have made
   * one looks for it by its marker (as an order, then a draft); only then is a draft made (kept at once, before it's
   * completed). The try after the last only looks.
   */
  async sendCreditOrder(id, tries) {
    const shopify = this.shopify;
    const lookOnly = tries > ORDER_RETRY.length + 1;
    const mine = () => {
      const row = this.creditPayRow(id);
      return row?.order_status === 'making' && row.order_tries === tries ? row : null;
    };
    const superseded = { credit: id, superseded: true };
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
          this.write('UPDATE credit_payments SET order_draft = NULL WHERE id = ?', id);
        }
      }
      let searched = false;
      if (!order && !draft && r.order_sent_at) {
        searched = true;
        order = await shopify.findMarkedOrder(r.customer_id, CREDIT_ORDER_TAG, CREDIT_MARKER, id);
        if (!(r = mine())) return superseded;
        if (!order) {
          const found = await shopify.findMarkedDraft(r.customer_id, CREDIT_ORDER_TAG, CREDIT_MARKER, id);
          if (!(r = mine())) return superseded;
          if (found) {
            draft = found.id;
            order = found.order;
            this.write('UPDATE credit_payments SET order_draft = ? WHERE id = ?', draft, id);
            r = mine();
          }
        }
      }
      if (!order && lookOnly) {
        if (!searched) {
          order = await shopify.findMarkedOrder(r.customer_id, CREDIT_ORDER_TAG, CREDIT_MARKER, id);
          if (!(r = mine())) return superseded;
        }
        if (!order) {
          // --- no awaits from here on ---
          this.creditOrderStopped(r, r.order_error || 'Shopify made no order.', Date.now());
          return { credit: id, order: null, stopped: true };
        }
      }
      if (!order && !draft) {
        if ((r.order_next_at || 0) - Date.now() < ORDER_SEND_MARGIN) throw new Error("Shopify was slow, so the order wasn't asked for this time.");
        this.write('UPDATE credit_payments SET order_sent_at = COALESCE(order_sent_at, ?) WHERE id = ?', Date.now(), id);
        const made = await shopify.createPaidLinesDraft({
          customerId: r.customer_id, lines: parse(r.lines, []), currency: r.currency || this.env?.CURRENCY || 'NZD', tags: [...CREDIT_ORDER_TAGS],
          // (no booking codes in the note: the orders/paid webhook reads them from a draft's note)
          note: `Paid from store credit in My Lair (${id}).`,
          marker: { [CREDIT_MARKER]: id },
        });
        this.write('UPDATE credit_payments SET order_draft = COALESCE(order_draft, ?) WHERE id = ?', made.id, id);
        if (this.creditPayRow(id)?.order_draft !== made.id) this.later(shopify.deleteDraftIfOpen(made.id));
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
      console.error('Lair: could not make the Shopify order for a bill paid from store credit', error);
      const fresh = mine();
      if (!fresh) return superseded;
      this.creditOrderFailed(fresh, tries, String(error?.message || error).slice(0, 300), Date.now());
      return { credit: id, order: null };
    }
    // --- no awaits from here on ---
    this.write(
      "UPDATE credit_payments SET order_status = 'made', order_id = ?, order_name = ?, order_error = NULL, order_next_at = NULL WHERE id = ? AND order_tries = ?",
      order.id, order.name || null, id, tries,
    );
    if (order.total != null && order.total !== r.amount) {
      const name = this.memberName(r.customer_id);
      this.staffAlert(`credit-total:${id}`, `A store credit order doesn't match: ${name}`, {
        title: "A store credit order that doesn't match",
        intro: `${name} paid ${money(r.amount)} from their store credit in My Lair, and Shopify's order for it came to ${money(order.total)}, so Shopify's sales are out by ${money(Math.abs(order.total - r.amount))}. Check the shop's tax and discount settings, and put the order right in Shopify.`,
        details: [['Order', order.name || order.id], ['Store credit taken', money(r.amount)], ['Order total', money(order.total)]],
      }, Date.now());
    }
    return { credit: id, order: order.id };
  },

  /** A try didn't go: tried again after the next wait; after the last, one more look; after that, staff hear. No awaits. */
  creditOrderFailed(r, tries, error, now) {
    const wait = ORDER_RETRY[tries - 1] ?? (tries === ORDER_RETRY.length + 1 ? ORDER_LAST_LOOK : null);
    if (!wait) {
      this.creditOrderStopped(r, error, now);
      return;
    }
    this.write("UPDATE credit_payments SET order_status = 'failed', order_error = ?, order_next_at = ? WHERE id = ?", String(error).slice(0, 300), now + wait, r.id);
  },

  /**
   * The order couldn't be made however many times the Lair tried: it stops, and staff hear so they can finish it by hand.
   * The store credit came off and everything's paid either way: only Shopify's record of it is missing. No awaits.
   */
  creditOrderStopped(r, error, now) {
    this.write("UPDATE credit_payments SET order_status = 'stopped', order_error = ?, order_next_at = NULL WHERE id = ?", String(error).slice(0, 300), r.id);
    const name = this.creditGiftName(r.customer_id);
    const draft = this.draftOrderUrl(r.order_draft);
    const lines = parse(r.lines, []);
    this.staffAlert(`credit-order:${r.id}`, `Store credit with no Shopify order: ${name}`, {
      title: 'A store credit order that needs making by hand',
      intro: `${name} paid ${money(r.amount)} from their store credit in My Lair and everything's marked paid, but the Lair couldn't make its Shopify order, however many times it tried. Only Shopify's record of it is missing. ${draft
        ? 'Its draft order is in Shopify: open it (the link below) and mark it as paid. If it already shows as an order, there’s nothing to do.'
        : `Make it by hand in Shopify admin: Orders, Create order for ${name}, with what's below, then mark it as paid.`}`,
      details: [['Store credit taken', money(r.amount)], ['What it paid for', lines.map((l) => (l.variantId ? `${l.qty} × ${l.title}` : l.title)).join('\n')], ['Why', String(error).slice(0, 200)], ...(draft ? [['Draft order', draft]] : [])],
    }, now);
  },

  /** The 10-minute run: store credit orders still to make, and ones whose wait is up or whose try never finished. → their ids */
  async retryCreditOrders(now) {
    if (!this.shopify?.configured) return [];
    const due = this.sql.exec(
      `SELECT id FROM credit_payments WHERE source = 'me' AND status = 'paid' AND order_status IN ('due', 'making', 'failed') AND (order_next_at IS NULL OR order_next_at <= ?)
         ORDER BY COALESCE(order_next_at, 0), paid_at LIMIT ?`,
      now, ORDERS_A_RUN,
    ).toArray().map((r) => r.id);
    for (const id of due) {
      const making = this.creditOrder(id);
      if (making) await making;
    }
    return due;
  },

  /* ---------------- the 10-minute run ---------------- */

  /**
   * The 10-minute run: a payment left mid-way by a restart counts as an answer lost (taking) or goes to staff (returning);
   * a till sale's store credit whose sale was let go goes back on; a payment whose answer was lost while it came off is
   * looked for in their store credit (found: it goes back on, since it paid nothing; not there after CREDIT_PAY.goneAfter:
   * it didn't come off; Shopify unreadable for CREDIT_PAY.askAfter: staff look). Returns { looked, returning?, failed?,
   * check? } when it did anything, else null.
   */
  async creditPayUpkeep(now = Date.now()) {
    if (!this.shopify?.configured) return null;
    const out = { looked: 0 };
    const add = (key) => {
      out[key] = (out[key] || 0) + 1;
    };
    for (const row of this.sql.exec("SELECT * FROM credit_payments WHERE status IN ('taking', 'returning') AND updated_at < ? LIMIT ?", now - CREDIT_PAY.stale, CREDIT_PAY.perRun).toArray()) {
      if (row.status === 'taking') this.creditPayUpdate(row.id, { status: 'checking', stage: 'take', message: 'no answer (the Lair restarted)' });
      else {
        this.creditPayUpdate(row.id, { status: 'check', stage: 'back', message: 'no answer (the Lair restarted)' });
        this.creditPayCheckAlert(this.creditPayRow(row.id));
        add('check');
      }
    }
    // a till sale let go while its store credit was taken, and the credit not on its way back (a restart in between)
    const orphans = this.sql.exec(
      "SELECT c.id FROM credit_payments c JOIN till_sales s ON s.id = c.sale_id WHERE c.status = 'taken' AND s.status = 'gone' LIMIT ?",
      CREDIT_PAY.perRun,
    ).toArray();
    for (const row of orphans) if (this.creditPayReturnSoon(row.id, 'its till sale was let go')) add('returning');
    const waiting = this.sql.exec("SELECT * FROM credit_payments WHERE status = 'checking' AND created_at <= ? ORDER BY created_at LIMIT ?", now - CREDIT_PAY.lookAfter, CREDIT_PAY.perRun).toArray();
    for (const row of waiting) {
      out.looked += 1;
      let debits = null;
      try {
        debits = await this.shopify.storeCreditDebits(row.customer_id, row.currency);
      } catch (error) {
        console.error('Lair: could not read store credit for a payment', error);
      }
      // --- no awaits from here on (for this one) ---
      const fresh = this.creditPayRow(row.id);
      if (!fresh || fresh.status !== 'checking') continue;
      const at = Date.now();
      if (!debits) {
        if (at - fresh.created_at >= CREDIT_PAY.askAfter) {
          this.creditPayUpdate(fresh.id, { status: 'check', stage: 'take' });
          this.creditPayCheckAlert(this.creditPayRow(fresh.id));
          add('check');
        }
        continue;
      }
      // a debit of this amount, taken by an app (not spent on an order) while it was with Shopify, that isn't anything
      // else the Lair took
      const known = this.creditKnownDebits();
      const match = debits
        .filter((d) => d.id && !d.fromOrder && d.amount === fresh.amount && !known.has(d.id)
          && d.createdAt >= fresh.created_at - CREDIT_PAY.skew && d.createdAt <= fresh.created_at + CREDIT_PAY.goneAfter)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (match) {
        // it came off after all, but a lost answer pays nothing: it goes back on
        this.creditPayUpdate(fresh.id, { take_tx: match.id });
        if (this.creditPayReturnSoon(fresh.id, 'no answer while it came off', { from: ['checking'], message: fresh.source === 'me' ? W.checking : null })) add('returning');
        continue;
      }
      if (at - fresh.created_at >= CREDIT_PAY.goneAfter) {
        this.creditPayUpdate(fresh.id, { status: 'failed', stage: null, message: 'Shopify has no record of it coming off, so nothing moved.' });
        add('failed');
      }
    }
    return out.looked || out.check || out.returning ? out : null;
  },
};

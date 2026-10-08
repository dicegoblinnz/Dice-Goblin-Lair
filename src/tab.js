// Round 9: the running tab and monthly accounts (contract v9-tab).
//
// Everything a member books (tables, TTRPG seats, events) and their snacks, in one list: what they owe now and what's
// coming up. By default people settle at the counter each visit, as before. For members staff trust, a monthly account
// with a credit limit: what they check in for (or put on their tab) goes on their account, and on the 1st they get a
// bill, a Shopify draft order for that customer, paid online or at the counter. Every payment is a Shopify order.
//
// These are Lair methods: lair.js copies them onto Lair.prototype, so `this` is the Durable Object. The same rule
// holds: every await first, then one synchronous read-check-write. A bill is claimed (its row written) before its draft
// order is made, and afterwards only its draft columns are written, and only while it's still open.
import { HOUR, LairTime, RuleError, makeId } from './core.js';
import { emailReady } from './shopify.js';

/* ---------- small helpers (the same as lair.js's) ---------- */
const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
const owing = (x) => Math.max(0, (x.amount || 0) - (x.covered || 0) - (x.paidAmount || 0));
const dueOf = (x) => (x.paid || x.kind === 'gm' || x.waived ? 0 : owing(x));
const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
const money = (cents) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const trimmed = (v, max) => String(v ?? '').trim().slice(0, max);
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
/** What an order line paid, in cents (lair.js's lineAmount) */
const lineAmount = (item) => {
  const cents = (value) => Math.round(Number(value || 0) * 100) || 0;
  const gross = cents(item.price ?? item.price_set?.shop_money?.amount) * Math.max(0, Math.floor(Number(item.quantity ?? 1)) || 0);
  const discounts = (item.discount_allocations || []).reduce((sum, d) => sum + cents(d.amount ?? d.amount_set?.shop_money?.amount), 0);
  return Math.max(0, gross - discounts);
};

/** The highest credit limit staff can set: $5,000 */
export const TAB_LIMIT_MAX = 500000;
/** An open bill gets one friendly reminder after this many days */
export const BILL_REMIND_DAYS = 14;
/** Coming up: at most this many items, up to this many days ahead */
const COMING_UP_MAX = 30;
const COMING_UP_DAYS = 120;
/** At most this many bills made (or retried) in one maintenance run, so a run stays short */
const BILLS_A_RUN = 20;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** The words staff and members see, kept together so the theme's demo can say the same */
export const TAB_MESSAGES = {
  billing: 'Pick pay each visit or a monthly account.',
  limit: 'A credit limit is $0 to $5,000.',
  needLimit: 'Set a credit limit for a monthly account, like $100.',
  noMember: 'No member with that customer ID.',
  notMonthly: (name) => `${name} pays each visit, so there's no account to bill. Switch them to a monthly account first.`,
  nothing: (name) => `${name} doesn't owe anything right now, so there's nothing to bill.`,
  noBill: 'That bill could not be found.',
  billPaid: 'That bill is paid already.',
  billVoid: 'That bill was cancelled. Make a new one with Bill now.',
  noEmail: (name) => `There's no email for ${name}, so the bill can't be sent. Add one to their profile, or give them the link.`,
  emailOff: "Emails aren't set up yet, so the bill can't be sent.",
  payAtCounter: "You pay each visit, so there's nothing to pay online. Show your member code at the counter and we'll ring it up.",
  nothingToPay: "There's nothing on your account to pay right now.",
  onlineDown: "Online payment isn't working right now. Pay at the counter next time you're in, or try again in a minute.",
  noLink: "Shopify didn't make the bill's payment link just now. Try again in a minute.",
  login: 'Log in to see your account.',
};

/** "Your Lair account is at its $100 limit. Pay your bill online or at the counter, then book again." */
export function limitWords(limit, used, what = 'book') {
  const again = { book: 'book again', join: 'sign up again', tab: 'add to your tab again' }[what] || 'try again';
  if (used >= limit) return `Your Lair account is at its ${money(limit)} limit. Pay your bill online or at the counter, then ${again}.`;
  return `That would take your Lair account over its ${money(limit)} limit (${money(limit - used)} left). Pay your bill online or at the counter, then ${again}.`;
}

export const runningTabMethods = {
  /* ---------------- accounts ---------------- */
  /** A member's account row, or null (pay each visit, never switched). No awaits. */
  accountRow(customerId) {
    return this.sql.exec('SELECT * FROM tab_accounts WHERE customer_id = ?', String(customerId ?? '')).toArray()[0] || null;
  },

  /** A row's monthly periods: [[from, until|null]], oldest first */
  accountPeriods(row) {
    return parse(row?.periods, []).filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0]))).map((p) => [Number(p[0]), p[1] == null ? null : Number(p[1])]);
  },

  /** Customer IDs on a monthly account now, for the staff page's floor ("On their account"). No awaits. */
  monthlyIds() {
    return this.sql.exec("SELECT customer_id FROM tab_accounts WHERE billing = 'monthly'").toArray().map((r) => String(r.customer_id));
  },

  /**
   * A member's running tab (contract v9-tab section 1), worked out from their bookings, seats, sign-ups and tabs every
   * time (nothing is copied):
   *   owed      what they owe now: weekly seats owed (as round 5), what they checked in for today and haven't paid, their
   *             tab today, and, from a monthly period of their account, what they checked in for or put on a tab then
   *             (from tabFrom on, so old records never start nagging). A one-off no-show is never owed.
   *   comingUp  their bookings, seats and sign-ups still to come, not checked in yet, with what's left to pay and how
   *             it's settled: 'day' (at the counter), 'account' (on their monthly bill), 'online' (a checkout is open)
   *             or 'paid'.
   * Each item: { type, id, ref, kind ('table'|'spot'|'seat'|'event'|'tab'), title, when, end, people, amount, status,
   * settle, bill (the open bill it's on, or null), onBill, weekly, today }. No awaits.
   */
  runningTab(customerId, rules, now = Date.now()) {
    const id = String(customerId);
    const row = this.accountRow(id);
    const monthly = row?.billing === 'monthly';
    const periods = this.accountPeriods(row);
    const time = new LairTime(rules.tz);
    const { from: dayFrom, to: dayTo } = this.dayWindow(rules, now);
    const todayKey = time.key(now);
    const onAccount = (t) => t >= this.tabFrom && periods.some(([a, b]) => t >= a && (b == null || t < b));
    const bill = this.openBillRow(id);
    const billed = new Set(bill ? parse(bill.items, []).map((i) => `${i.type}:${i.id}`) : []);
    const games = new Map();
    const gameOf = (gameId) => {
      if (!gameId) return null;
      if (!games.has(gameId)) games.set(gameId, this.game(gameId));
      return games.get(gameId);
    };
    const kindOf = (b) => (b.kind === 'gm-seat' ? 'seat' : b.occurrenceId ? 'spot' : 'table');
    const bookingTitle = (b) => this.dueTitle({ type: 'booking', kind: b.kind, title: this.rowTitle(b, rules, gameOf(b.gameId)), occurrenceId: b.occurrenceId, tables: b.tables }, rules);
    const item = (type, x, extra) => ({
      type, id: x.id, ref: x.ref, kind: type === 'join' ? 'event' : kindOf(x), title: type === 'join' ? x.title || 'Event' : bookingTitle(x), when: x.start, end: x.end,
      people: x.people, amount: dueOf(x), weekly: Boolean(x.seriesId && x.kind === 'gm-seat'), today: x.start >= dayFrom && x.start < dayTo,
      bill: billed.has(`${type}:${x.id}`) ? bill.id : null, onBill: billed.has(`${type}:${x.id}`), ...extra,
    });
    const owed = [];
    const seen = new Set();
    // weekly seats owed (round 5): owed for everyone, whether or not they came
    for (const r of this.owedRows(id, rules, now)) {
      const b = this.booking(r.id);
      if (!b) continue;
      seen.add(`booking:${b.id}`);
      owed.push(item('booking', b, { status: 'owed', settle: monthly ? 'account' : 'day', weekly: true }));
    }
    // checked in and not paid: today's, and a monthly period's
    const since = Math.min(this.tabFrom, dayFrom);
    const here = (t) => (t >= dayFrom && t < dayTo) || onAccount(t);
    const bookings = this.sql
      .exec(
        `SELECT * FROM bookings WHERE customer_id = ? AND kind != 'gm' AND status NOT IN ('cancelled', 'noshow', 'held') AND (arrived_at IS NOT NULL OR status IN ('seated', 'done'))
           AND paid = 0 AND waived = 0 AND COALESCE(arrived_at, starts_at) >= ? ORDER BY starts_at, id`,
        id, since,
      )
      .toArray().map((r) => this.rowToBooking(r));
    for (const b of bookings) {
      if (seen.has(`booking:${b.id}`) || dueOf(b) <= 0 || this.isOwed(b, now) || !here(b.arrivedAt || b.start)) continue;
      seen.add(`booking:${b.id}`);
      owed.push(item('booking', b, { status: 'owed', settle: onAccount(b.arrivedAt || b.start) ? 'account' : 'day' }));
    }
    const joins = this.sql
      .exec(
        `SELECT * FROM event_joins WHERE customer_id = ? AND status NOT IN ('cancelled', 'held') AND (arrived_at IS NOT NULL OR status = 'attended') AND paid = 0
           AND COALESCE(arrived_at, starts_at) >= ? ORDER BY starts_at, id`,
        id, since,
      )
      .toArray().map((r) => this.rowToJoin(r));
    for (const j of joins) {
      if (dueOf(j) <= 0 || !here(j.arrivedAt || j.start)) continue;
      owed.push(item('join', j, { status: 'owed', settle: onAccount(j.arrivedAt || j.start) ? 'account' : 'day' }));
    }
    // tabs not paid: today's, and a monthly period's
    for (const t of this.sql.exec("SELECT * FROM tabs WHERE customer_id = ? AND status IN ('open', 'in-cart') ORDER BY created_at, rowid", id).toArray()) {
      const today = t.day === todayKey;
      if (!(t.total > 0) || !(today || onAccount(t.created_at || 0))) continue;
      const things = parse(t.items, []).reduce((sum, x) => sum + (Number(x.qty) || 0), 0);
      owed.push({
        type: 'tab', id: t.id, ref: this.tabRef(t.id), kind: 'tab', title: today ? 'Your tab today' : `Your tab, ${this.shortDay(t.created_at, rules)}`, when: t.created_at,
        end: t.updated_at || t.created_at, people: 1, amount: t.total, things, tabStatus: t.status, weekly: false, today,
        bill: billed.has(`tab:${t.id}`) ? bill.id : null, onBill: billed.has(`tab:${t.id}`), status: 'owed',
        settle: onAccount(t.created_at || 0) ? 'account' : 'day',
      });
    }
    owed.sort((a, b) => a.when - b.when || a.title.localeCompare(b.title));
    // coming up: booked, not here yet, not over
    const until = now + COMING_UP_DAYS * 24 * HOUR;
    const upBookings = this.sql
      .exec(
        `SELECT * FROM bookings WHERE customer_id = ? AND kind != 'gm' AND status IN ('confirmed', 'held') AND arrived_at IS NULL AND ends_at > ? AND starts_at < ?
         ORDER BY starts_at, id LIMIT ?`,
        id, now, until, COMING_UP_MAX,
      )
      .toArray().map((r) => this.rowToBooking(r));
    const upJoins = this.sql
      .exec(
        `SELECT * FROM event_joins WHERE customer_id = ? AND status IN ('confirmed', 'held') AND arrived_at IS NULL AND ends_at > ? AND starts_at < ?
         ORDER BY starts_at, id LIMIT ?`,
        id, now, until, COMING_UP_MAX,
      )
      .toArray().map((r) => this.rowToJoin(r));
    const settleOf = (x) => {
      if (dueOf(x) <= 0) return 'paid';
      if (x.status === 'held' || x.pay === 'now') return 'online';
      return monthly ? 'account' : 'day';
    };
    const comingUp = [
      ...upBookings.map((b) => item('booking', b, { status: b.status === 'held' ? 'held' : 'booked', settle: settleOf(b) })),
      ...upJoins.map((j) => item('join', j, { status: j.status === 'held' ? 'held' : 'booked', settle: settleOf(j) })),
    ].sort((a, b) => a.when - b.when || a.title.localeCompare(b.title)).slice(0, COMING_UP_MAX);
    const owedTotal = owed.reduce((sum, x) => sum + x.amount, 0);
    const limit = monthly ? row.credit_limit || 0 : 0;
    return {
      billing: monthly ? 'monthly' : 'visit', creditLimit: limit,
      owed: { total: owedTotal, items: owed },
      // what's left to pay on what's coming up (not counting places paid online already)
      comingUp: { total: comingUp.reduce((sum, x) => sum + (x.settle === 'paid' ? 0 : x.amount), 0), items: comingUp },
      bill: bill ? this.billView(bill, rules) : null,
      // the limit less what's owed (the open bill's items are among what's owed, so they're counted once)
      available: monthly ? limit - owedTotal : null,
      overLimit: monthly && owedTotal > limit,
    };
  },

  /** A tab's code at the counter and on a bill line ("TAB-1A2B3C"): never a booking code. */
  tabRef(id) {
    return `TAB-${String(id).slice(-6).toUpperCase()}`;
  },

  /**
   * GET /me's `account` and the staff member page's: the running tab, plus (staff) the note, who set it and when, and
   * every bill, newest first. No awaits.
   */
  memberAccount(customerId, rules, now = Date.now(), { staff = false } = {}) {
    const tab = this.runningTab(customerId, rules, now);
    if (!staff) return tab;
    const row = this.accountRow(customerId);
    const bills = this.sql.exec('SELECT * FROM tab_bills WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 24', String(customerId)).toArray();
    return {
      ...tab, note: row?.note || '', setBy: row?.set_by || null, setAt: row?.set_at || null,
      monthlySince: tab.billing === 'monthly' ? this.accountPeriods(row).slice(-1)[0]?.[0] ?? null : null,
      bills: bills.map((b) => this.billView(b, rules, { staff: true, now })),
      warning: this.limitWarning(tab),
    };
  },

  /** What staff are told about a monthly account at or over its limit, or null. */
  limitWarning(tab) {
    if (tab.billing !== 'monthly' || tab.owed.total < tab.creditLimit) return null;
    return tab.owed.total > tab.creditLimit
      ? `Over their ${money(tab.creditLimit)} limit: ${money(tab.owed.total)} owed.`
      : `At their ${money(tab.creditLimit)} limit: ${money(tab.owed.total)} owed.`;
  },

  /** { accountWarning } for a staff answer about a member (their monthly account is at or over its limit), or {}. */
  accountWarning(customerId, rules, now = Date.now()) {
    if (!customerId || this.accountRow(customerId)?.billing !== 'monthly') return {};
    const warning = this.limitWarning(this.runningTab(customerId, rules, now));
    return warning ? { accountWarning: warning } : {};
  },

  /** The staff check-in card's word about a member's account: { billing, creditLimit, owed, available, warning }. */
  accountSummary(customerId, rules, now = Date.now()) {
    const row = this.accountRow(customerId);
    if (row?.billing !== 'monthly') return { billing: 'visit' };
    const tab = this.runningTab(customerId, rules, now);
    return { billing: 'monthly', creditLimit: tab.creditLimit, owed: tab.owed.total, available: tab.available, warning: this.limitWarning(tab) };
  },

  /**
   * A new booking, seat, sign-up or tab item paid at the counter that would take a monthly account over its credit
   * limit is refused (409), saying the limit and how to settle. Pay-each-visit members and staff making bookings for
   * someone (the floor's override) never get here. No awaits.
   */
  checkAccountLimit(customerId, amount, rules, now, what = 'book') {
    if (!customerId || !(amount > 0)) return;
    const row = this.accountRow(customerId);
    if (row?.billing !== 'monthly') return;
    const used = this.runningTab(customerId, rules, now).owed.total;
    if (used + amount <= (row.credit_limit || 0)) return;
    throw new RuleError(limitWords(row.credit_limit || 0, used, what), 409);
  },

  /**
   * POST /members/:customerId/account { billing, creditLimit, note } (staff, perm money): pay each visit ('visit') or a
   * monthly account ('monthly') with a credit limit in cents. Switching to monthly starts a monthly period now; back to
   * pay each visit ends it, and whatever they owe from it stays owed. Returns { account, said, before }.
   */
  async setMemberAccount(customerId, input, who) {
    this.requireStaff(who); // perm: money
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const id = trimmed(customerId, 40);
    const member = this.memberRow(id);
    if (!member) throw new RuleError(TAB_MESSAGES.noMember, 404);
    const row = this.accountRow(id);
    const was = { billing: row?.billing || 'visit', creditLimit: row?.credit_limit || 0 };
    const billing = input.billing == null || input.billing === '' ? was.billing : String(input.billing);
    if (!['visit', 'monthly'].includes(billing)) throw new RuleError(TAB_MESSAGES.billing);
    let limit = was.creditLimit;
    if (input.creditLimit != null && input.creditLimit !== '') {
      limit = Number(input.creditLimit);
      if (!Number.isInteger(limit) || limit < 0 || limit > TAB_LIMIT_MAX) throw new RuleError(TAB_MESSAGES.limit);
    }
    if (billing === 'monthly' && !(limit > 0)) throw new RuleError(TAB_MESSAGES.needLimit);
    const note = input.note === undefined ? row?.note || '' : trimmed(input.note, 300);
    const periods = this.accountPeriods(row);
    const open = periods.length && periods[periods.length - 1][1] == null;
    if (billing === 'monthly' && !open) periods.push([now, null]);
    if (billing === 'visit' && open) periods[periods.length - 1][1] = now;
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    this.write(
      `INSERT INTO tab_accounts (customer_id, billing, credit_limit, note, periods, set_by, set_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(customer_id) DO UPDATE SET billing = excluded.billing, credit_limit = excluded.credit_limit, note = excluded.note, periods = excluded.periods,
         set_by = excluded.set_by, set_at = excluded.set_at, updated_at = excluded.updated_at`,
      id, billing, limit, note || null, JSON.stringify(periods), by, now, now, now,
    );
    const name = member.first_name || String(member.name || '').split(/\s+/)[0] || 'They';
    const account = this.memberAccount(id, rules, now, { staff: true });
    const said = [];
    if (billing === 'monthly' && was.billing !== 'monthly') {
      said.push(`${name} is on a monthly account now, with a ${money(limit)} limit. What they check in for from now goes on their account, and their bill comes on the 1st.`);
    } else if (billing === 'monthly' && limit !== was.creditLimit) {
      said.push(`${name}'s credit limit went from ${money(was.creditLimit)} to ${money(limit)}.`);
    } else if (billing === 'visit' && was.billing === 'monthly') {
      said.push(`${name} pays each visit now.`);
      if (account.owed.total > 0) said.push(`They still owe ${money(account.owed.total)} from their account. That stays owed until they pay it, online or at the counter.`);
    } else {
      said.push('Saved.');
    }
    if (account.warning) said.push(account.warning);
    return { account, said: said.join(' '), before: was };
  },

  /**
   * GET /accounts (staff, perm money): every monthly account, and anyone who still owes from one, over-limit ones first:
   * { customerId, name, code, billing, creditLimit, owed, available, overLimit, bill (the open one), lastPaid }.
   */
  async listAccounts(who) {
    this.requireStaff(who); // perm: money
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const list = [];
    for (const row of this.sql.exec('SELECT * FROM tab_accounts ORDER BY customer_id').toArray()) {
      const tab = this.runningTab(row.customer_id, rules, now);
      // someone back on pay each visit is listed while they still owe from their account (not for today's visit)
      const onAccount = tab.owed.items.filter((i) => i.settle === 'account').reduce((sum, i) => sum + i.amount, 0);
      if (tab.billing !== 'monthly' && onAccount <= 0) continue;
      const member = this.memberRow(row.customer_id);
      const last = this.sql.exec("SELECT * FROM tab_bills WHERE customer_id = ? AND status = 'paid' ORDER BY paid_at DESC, rowid DESC LIMIT 1", String(row.customer_id)).toArray()[0];
      list.push({
        customerId: String(row.customer_id), name: member?.name || member?.first_name || member?.code || 'A member', code: member?.code || null,
        billing: tab.billing, creditLimit: tab.creditLimit, owed: tab.billing === 'monthly' ? tab.owed.total : onAccount, owedCount: tab.owed.items.length, available: tab.available,
        overLimit: tab.overLimit, bill: tab.bill, lastPaid: last ? { at: last.paid_at, total: last.total, how: last.paid_how || null } : null,
      });
    }
    const weight = (x) => (x.overLimit ? 0 : x.billing === 'monthly' && x.owed >= x.creditLimit ? 1 : 2);
    list.sort((a, b) => weight(a) - weight(b) || b.owed - a.owed || a.name.localeCompare(b.name));
    return { accounts: list, now };
  },

  /* ---------------- bills ---------------- */
  openBillRow(customerId) {
    return this.sql.exec("SELECT * FROM tab_bills WHERE customer_id = ? AND status = 'open' ORDER BY created_at DESC, rowid DESC LIMIT 1", String(customerId)).toArray()[0] || null;
  },

  billRow(id) {
    return this.sql.exec('SELECT * FROM tab_bills WHERE id = ?', String(id ?? '')).toArray()[0] || null;
  },

  /** "September 2026" for a monthly bill, "To Fri 9 Oct" for one made on request */
  billLabel(bill, rules) {
    if (bill.kind === 'month' && /^\d{4}-\d{2}$/.test(bill.month || '')) {
      const [y, m] = bill.month.split('-').map(Number);
      return `${MONTHS[m - 1]} ${y}`;
    }
    return `To ${this.shortDay(bill.created_at, rules)}`;
  },

  /**
   * A bill as its member sees it (and staff, with staff: true): { id, kind, month, label, total, items, status,
   * invoiceUrl (open bills only), createdAt, paidAt, paidHow, words }. No awaits.
   */
  billView(b, rules, { staff = false, now = Date.now() } = {}) {
    const label = this.billLabel(b, rules);
    const made = this.shortDay(b.created_at, rules);
    let words;
    if (b.status === 'paid') words = `Paid ${b.paid_how === 'counter' ? 'at the counter' : 'online'}${b.paid_at ? ` on ${this.shortDay(b.paid_at, rules)}` : ''}. Thanks, friend.`;
    else if (b.status === 'void') words = 'Cancelled. What was on it is still on your account.';
    else words = `Sent ${made}. Pay online any time, or at the counter next time you're in.`;
    const view = {
      id: b.id, kind: b.kind, month: b.month || null, label, total: b.total, items: parse(b.items, []), status: b.status,
      invoiceUrl: b.status === 'open' ? b.invoice_url || null : null, createdAt: b.created_at, paidAt: b.paid_at || null, paidHow: b.paid_how || null, words,
    };
    if (!staff) return view;
    return {
      ...view, draftOrderId: b.draft_order_id || null, orderId: b.order_id || null, voidReason: b.void_reason || null, madeBy: b.made_by || null,
      emailedAt: b.emailed_at || null, remindedAt: b.reminded_at || null, voidedAt: b.voided_at || null,
      ageDays: Math.max(0, Math.floor((now - b.created_at) / (24 * HOUR))),
    };
  },

  /** Cancel an open bill: its draft order goes, so its link stops working. No awaits (the delete goes afterwards). */
  voidBill(bill, reason, now) {
    this.write("UPDATE tab_bills SET status = 'void', void_reason = ?, voided_at = ?, updated_at = ? WHERE id = ? AND status = 'open'", reason, now, now, bill.id);
    if (bill.draft_order_id && this.shopify.configured) this.later(this.shopify.deleteDraftIfOpen(bill.draft_order_id));
  },

  /**
   * Claim a bill for what a member owes (from before `before`, when given): the row is written now, and any open bill
   * is cancelled (one open bill a member, and nothing on two). A monthly bill is made once per member and month. When
   * what's owed is exactly what the open bill has (and it has its link), that bill is the answer. No awaits. Returns
   * { bill, reused?, reason? }.
   */
  claimBill(customerId, { kind, month = null, before = null, by, rules, now }) {
    const id = String(customerId);
    if (kind === 'month' && this.sql.exec("SELECT 1 AS n FROM tab_bills WHERE customer_id = ? AND month = ? AND kind = 'month'", id, month).toArray().length) {
      return { bill: null, reason: 'made' };
    }
    const tab = this.runningTab(id, rules, now);
    const items = tab.owed.items
      .filter((i) => i.amount > 0 && (before == null || i.when < before))
      .map((i) => ({ type: i.type, id: i.id, ref: i.ref, kind: i.kind, title: i.title, when: i.when, people: i.people, amount: i.amount }));
    if (!items.length) return { bill: null, reason: 'nothing' };
    const open = this.openBillRow(id);
    const key = (list) => list.map((i) => `${i.type}:${i.id}:${i.amount}`).sort().join('|');
    if (open && kind !== 'month' && open.invoice_url && key(parse(open.items, [])) === key(items)) return { bill: open, reused: true };
    if (open) this.voidBill(open, 'replaced', now);
    const billId = makeId('bl');
    this.write(
      `INSERT INTO tab_bills (id, customer_id, kind, month, items, total, status, made_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      billId, id, kind, month, JSON.stringify(items), items.reduce((sum, i) => sum + i.amount, 0), by, now, now,
    );
    return { bill: this.billRow(billId) };
  },

  /** A bill line's title: "Table for 4 · Thu 3 Sep · SJ-OWLBEAR-17" */
  billLineTitle(item, rules) {
    const what = item.kind === 'table' ? `Table for ${item.people || 1}` : item.title;
    return `${what} · ${this.shortDay(item.when, rules)} · ${item.ref}`;
  },

  /**
   * A bill's draft order lines: bookings, seats and sign-ups as custom lines tagged _booking; tabs as their products
   * (custom: one custom line each, when Shopify wouldn't take the products), tagged _tab. Every line has _bill.
   */
  billLines(bill, rules, { custom = false } = {}) {
    const lines = [];
    for (const item of parse(bill.items, [])) {
      if (item.type === 'tab') {
        const tab = this.sql.exec('SELECT * FROM tabs WHERE id = ?', item.id).toArray()[0];
        const things = parse(tab?.items, []);
        if (!custom && things.length && things.every((x) => /^\d{1,20}$/.test(String(x.variantId)))) {
          for (const x of things) lines.push({ variantId: String(x.variantId), qty: Number(x.qty) || 1, cents: Number(x.price) || 0, title: x.title, attributes: { _tab: item.id, _bill: bill.id } });
        } else {
          lines.push({ title: `Tab · ${this.shortDay(item.when, rules)}`, cents: item.amount, attributes: { _tab: item.id, _bill: bill.id } });
        }
      } else {
        lines.push({ title: this.billLineTitle(item, rules), cents: item.amount, attributes: { _booking: item.ref, _bill: bill.id } });
      }
    }
    return lines;
  },

  /**
   * Make an open bill's Shopify draft order (for its customer, so their store credit can be used), once. If Shopify
   * won't take the tab's products, every line goes as a custom line. Afterwards (no awaits) the draft is kept only while
   * the bill is still open and has none; otherwise it's deleted. Returns the bill row as it is now.
   */
  async billDraft(billId, rules) {
    const bill = this.billRow(billId);
    if (!bill || bill.status !== 'open' || bill.draft_order_id || !this.shopify.configured) return bill;
    const member = this.memberRow(bill.customer_id);
    const email = isEmail(member?.account_email) ? member.account_email : isEmail(member?.email) ? member.email : '';
    const order = {
      billId: bill.id, customerId: bill.customer_id, email, currency: this.env.CURRENCY || 'NZD',
      note: `Lair bill: ${this.billLabel(bill, rules)}${member?.name ? ` (${member.name})` : ''}`,
    };
    let draft = null;
    try {
      draft = await this.shopify.createBill({ ...order, lines: this.billLines(bill, rules) });
    } catch (error) {
      try {
        if (!this.billLines(bill, rules).some((l) => l.variantId)) throw error;
        draft = await this.shopify.createBill({ ...order, lines: this.billLines(bill, rules, { custom: true }) });
      } catch (again) {
        console.error('Lair: bill draft order not made', again);
        this.note({ billError: { message: String(again.message || again).slice(0, 300), bill: bill.id, at: new Date().toISOString() } });
        return this.billRow(billId);
      }
    }
    // --- no awaits from here on ---
    const fresh = this.billRow(billId);
    if (!fresh || fresh.status !== 'open' || fresh.draft_order_id) {
      this.later(this.shopify.deleteDraftIfOpen(draft.draftOrderId));
      return fresh;
    }
    this.write(
      "UPDATE tab_bills SET draft_order_id = ?, invoice_url = ?, updated_at = ? WHERE id = ? AND status = 'open' AND draft_order_id IS NULL",
      draft.draftOrderId, draft.invoiceUrl || null, Date.now(), billId,
    );
    return this.billRow(billId);
  },

  /** Claim a bill, make its draft order, and (send) email it. Returns { bill (row), reused?, reason? }. */
  async makeBill(customerId, { kind = 'now', month = null, before = null, by = 'staff', send = false, rules, now = Date.now() }) {
    const claim = this.claimBill(customerId, { kind, month, before, by, rules, now });
    if (!claim.bill || claim.reused) return claim;
    const bill = await this.billDraft(claim.bill.id, rules);
    // --- no awaits from here on ---
    const sent = send && bill?.status === 'open' && bill.invoice_url ? this.sendBill(bill, rules) : null;
    return { bill: this.billRow(claim.bill.id), sent };
  },

  /**
   * Email a bill (or its reminder) to its member: what's on it, the total, a Pay online button (the invoice link) and
   * paying at the counter instead. Notes when it went. No awaits (the email goes afterwards). Returns { ok, message }.
   */
  sendBill(bill, rules, { reminder = false } = {}) {
    if (!emailReady(this.env)) return { ok: false, message: TAB_MESSAGES.emailOff };
    const member = this.memberRow(bill.customer_id);
    const to = isEmail(member?.account_email) ? member.account_email : isEmail(member?.email) ? member.email : '';
    const first = member?.first_name || String(member?.name || '').split(/\s+/)[0] || 'friend';
    if (!to) return { ok: false, message: TAB_MESSAGES.noEmail(member?.name || 'them') };
    const label = this.billLabel(bill, rules);
    const month = bill.kind === 'month' ? ` for ${label.split(' ')[0]}` : '';
    const total = dollars(bill.total);
    const items = parse(bill.items, []);
    const subject = reminder ? `A friendly reminder: your Lair bill${month} (${total})` : `Your Lair bill${month}: ${total}`;
    const now = Date.now();
    this.write(`UPDATE tab_bills SET ${reminder ? 'reminded_at' : 'emailed_at'} = ?, updated_at = ? WHERE id = ?`, now, now, bill.id);
    this.later(this.mail(this.letter(to, subject, {
      title: reminder ? `Your Lair bill${month} is still open` : `Your Lair bill${month}`,
      intro: reminder
        ? `Kia ora ${first}, Gobgob's just checking in: your Lair bill${month} (${total}) is still waiting to be paid.`
        : `Kia ora ${first}, here's what's on your Lair account${bill.kind === 'month' ? ` for ${label}` : ' so far'}. It comes to ${total}.`,
      details: [...items.map((i) => [this.shortDay(i.when, rules), `${i.kind === 'table' ? `Table for ${i.people || 1}` : i.title} (${i.ref}): ${dollars(i.amount)}`]), ['Total', total]],
      button: bill.invoice_url ? { label: 'Pay online', url: bill.invoice_url } : null,
      outro: [
        "Or pay at the counter next time you're in: show your member code and we'll ring it up.",
        'Store credit on your account is used when you pay.',
        ...(reminder ? ['Paid it already? Thanks, friend. You can ignore this one.'] : []),
      ],
    })));
    return { ok: true, to };
  },

  /**
   * POST /accounts/:customerId/bill (staff, perm money): make and send a bill now for everything they owe, replacing
   * an open one. Returns { bill, emailed, said, account }.
   */
  async billNow(customerId, who) {
    this.requireStaff(who); // perm: money
    const rules = await this.rules();
    const id = trimmed(customerId, 40);
    const member = this.memberRow(id);
    if (!member) throw new RuleError(TAB_MESSAGES.noMember, 404);
    const name = member.name || member.first_name || 'This member';
    if (this.accountRow(id)?.billing !== 'monthly') throw new RuleError(TAB_MESSAGES.notMonthly(name), 409);
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    const made = await this.makeBill(id, { kind: 'now', by, send: true, rules, now: Date.now() });
    // --- no awaits from here on ---
    if (!made.bill) throw new RuleError(TAB_MESSAGES.nothing(name), 409);
    const bill = this.billRow(made.bill.id);
    const sent = made.reused ? this.sendBill(bill, rules) : made.sent;
    const said = !bill.invoice_url
      ? `Bill made for ${dollars(bill.total)}, but Shopify didn't make its payment link yet, so it wasn't emailed. Gobgob tries again in 10 minutes.`
      : sent?.ok ? `Bill for ${dollars(bill.total)} emailed to ${sent.to}.` : `Bill made for ${dollars(bill.total)}. ${sent?.message || ''}`.trim();
    return { bill: this.billView(bill, rules, { staff: true }), emailed: Boolean(sent?.ok), said, account: this.memberAccount(id, rules, Date.now(), { staff: true }) };
  },

  /** POST /bills/:id/void (staff, perm money): cancel an open bill and delete its draft order. Returns { bill, account }. */
  async voidBillRoute(id, who) {
    this.requireStaff(who); // perm: money
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const bill = this.billRow(id);
    if (!bill) throw new RuleError(TAB_MESSAGES.noBill, 404);
    if (bill.status === 'paid') throw new RuleError(TAB_MESSAGES.billPaid, 409);
    if (bill.status === 'open') this.voidBill(bill, 'staff', now);
    return { bill: this.billView(this.billRow(id), rules, { staff: true, now }), account: this.memberAccount(bill.customer_id, rules, now, { staff: true }) };
  },

  /** POST /bills/:id/resend (staff, perm money): email an open bill again (making its link first if it has none). */
  async resendBill(id, who) {
    this.requireStaff(who); // perm: money
    const rules = await this.rules();
    const found = this.billRow(id);
    if (!found) throw new RuleError(TAB_MESSAGES.noBill, 404);
    if (found.status === 'paid') throw new RuleError(TAB_MESSAGES.billPaid, 409);
    if (found.status === 'void') throw new RuleError(TAB_MESSAGES.billVoid, 409);
    const bill = await this.billDraft(found.id, rules);
    // --- no awaits from here on ---
    if (!bill || bill.status !== 'open') throw new RuleError(bill?.status === 'paid' ? TAB_MESSAGES.billPaid : TAB_MESSAGES.billVoid, 409);
    if (!bill.invoice_url) throw new RuleError(TAB_MESSAGES.noLink, 503);
    const sent = this.sendBill(bill, rules);
    if (!sent.ok) throw new RuleError(sent.message, 409);
    return { bill: this.billView(this.billRow(id), rules, { staff: true }), emailed: true, said: `Bill for ${dollars(bill.total)} emailed to ${sent.to} again.` };
  },

  /**
   * POST /me/account/pay (a monthly member): "Pay online now": a fresh bill for everything they owe (the open one when
   * nothing has changed), and its link. Returns { bill, invoiceUrl, account }.
   */
  async payAccountNow(who) {
    if (!who.customerId) throw new RuleError(TAB_MESSAGES.login, 401);
    const rules = await this.rules();
    if (this.accountRow(who.customerId)?.billing !== 'monthly') throw new RuleError(TAB_MESSAGES.payAtCounter, 409);
    if (!this.shopify.configured) throw new RuleError(TAB_MESSAGES.onlineDown, 503);
    const made = await this.makeBill(who.customerId, { kind: 'now', by: 'member', rules, now: Date.now() });
    // --- no awaits from here on ---
    if (!made.bill) throw new RuleError(TAB_MESSAGES.nothingToPay, 409);
    const bill = this.billRow(made.bill.id);
    if (bill.status !== 'open' || !bill.invoice_url) throw new RuleError(TAB_MESSAGES.onlineDown, 503);
    return { bill: this.billView(bill, rules), invoiceUrl: bill.invoice_url, account: this.memberAccount(who.customerId, rules, Date.now()) };
  },

  /* ---------------- paying ---------------- */
  /**
   * The bills an order pays (its lines' _bill), each checked: a counter (POS) order is staff's; an online one must be
   * the bill's own draft order (Shopify is asked which order it became; a deleted draft counts when the order came from
   * a draft order, as for bookings). Throws when Shopify can't answer, so the webhook is sent again. Returns bill ids.
   */
  async verifiedBills(order, orderId, { pos, fromDraft, source }) {
    const ids = new Set();
    for (const item of order.line_items || []) for (const p of item.properties || []) if (p.name === '_bill' && p.value) ids.add(String(p.value).trim());
    if (fromDraft) for (const a of order.note_attributes || []) if (a.name === '_bill' && a.value) ids.add(String(a.value).trim());
    const out = [];
    for (const id of [...ids].slice(0, 5)) {
      const bill = this.billRow(id);
      if (!bill) continue;
      if (pos) out.push(bill.id);
      else if (fromDraft && bill.draft_order_id) {
        const linked = await this.shopify.draftOrderOrderId(bill.draft_order_id);
        if (linked === orderId || (linked === null && source === 'shopify_draft_order')) out.push(bill.id);
      }
    }
    return out;
  },

  /**
   * Record what an order paid on verified bills: each _booking line is a payment like any counter payment (no booking
   * confirmation goes out for it), each _tab marks that tab paid, and the bill is paid ('online', or 'counter' for a POS
   * order). A tab paid twice is flagged for staff. No awaits. Returns the bill ids.
   */
  payBills(billIds, order, orderId, rules, { pos = false, now = Date.now() } = {}) {
    const done = [];
    for (const id of billIds) {
      const bill = this.billRow(id);
      if (!bill) continue;
      const lines = [];
      const tabs = new Set();
      (order.line_items || []).forEach((item, index) => {
        const props = item.properties || [];
        if (!props.some((p) => p.name === '_bill' && String(p.value).trim() === id)) return;
        const lineId = String(item.id ?? item.admin_graphql_api_id ?? `line-${index}`);
        const ref = props.find((p) => p.name === '_booking' && p.value);
        const found = ref ? this.bookingOrJoin(String(ref.value).trim().toUpperCase()) : null;
        if (found) lines.push({ type: found.type, id: found.item.id, lineId, amount: lineAmount(item) });
        const tab = props.find((p) => p.name === '_tab' && p.value);
        if (tab) tabs.add(String(tab.value).trim());
      });
      // pos: true keeps recordPayments from sending booking confirmations: a bill is never a new booking
      this.recordPayments(lines, orderId, rules, { pos: true, now });
      this.payTabs([...tabs].slice(0, 30), orderId, now);
      if (bill.status === 'open') {
        this.write(
          "UPDATE tab_bills SET status = 'paid', paid_how = ?, order_id = ?, paid_at = ?, updated_at = ? WHERE id = ? AND status = 'open'",
          pos ? 'counter' : 'online', orderId, now, now, id,
        );
        if (pos && bill.draft_order_id && this.shopify.configured) this.later(this.shopify.deleteDraftIfOpen(bill.draft_order_id));
      } else if (bill.status === 'void' && !bill.order_id) {
        // a cancelled bill's link was paid after all (it was being replaced): the payments count, and the bill says so
        this.write('UPDATE tab_bills SET order_id = ?, paid_how = ?, paid_at = ?, updated_at = ? WHERE id = ?', orderId, pos ? 'counter' : 'online', now, now, id);
      }
      done.push(id);
    }
    return done;
  },

  /** Tabs paid by a bill's order: paid once; one already paid by another order is flagged for staff. No awaits. */
  payTabs(ids, orderId, now) {
    for (const id of ids) {
      const row = this.sql.exec('SELECT * FROM tabs WHERE id = ?', id).toArray()[0];
      if (!row) continue;
      if (row.status !== 'paid') {
        this.write("UPDATE tabs SET status = 'paid', order_id = ?, updated_at = ? WHERE id = ?", orderId, now, row.id);
      } else if (row.order_id && row.order_id !== orderId) {
        this.notifyStaff(`Paid twice: a tab (${this.tabRef(row.id)})`, {
          title: 'A tab was paid twice',
          intro: `A member's tab from ${row.day} was already paid, and their Lair bill paid for it again. Refund one of them.`,
          details: [['Tab', this.tabRef(row.id)], ['First order', row.order_id], ['This order', orderId], ['Amount', dollars(row.total || 0)]],
        });
      }
    }
  },

  /**
   * Keep open bills true (after anything is paid, waived, changed or undone): a bill stays open only while everything on
   * it is still owed at the amount billed. All of it paid (at the counter, say): the bill is paid and its draft order
   * deleted, so it can't be paid twice. Some paid, or something changed: the bill is cancelled (its draft deleted) and
   * what's still owed stays on the account for the next bill. No awaits. Returns the bill ids changed.
   */
  reconcileBills(rules, now = Date.now(), { orderId = null, pos = true } = {}) {
    const changed = [];
    const r = rules || this.rulesCache;
    if (!r) return changed;
    for (const bill of this.sql.exec("SELECT * FROM tab_bills WHERE status = 'open'").toArray()) {
      const owedNow = new Map(this.runningTab(bill.customer_id, r, now).owed.items.map((i) => [`${i.type}:${i.id}`, i.amount]));
      const states = parse(bill.items, []).map((i) => {
        if (this.billItemPaid(i)) return 'paid';
        return owedNow.get(`${i.type}:${i.id}`) === i.amount ? 'owed' : 'gone';
      });
      if (states.every((s) => s === 'owed')) continue;
      if (states.every((s) => s === 'paid')) {
        this.write(
          "UPDATE tab_bills SET status = 'paid', paid_how = ?, order_id = ?, paid_at = ?, updated_at = ? WHERE id = ? AND status = 'open'",
          pos ? 'counter' : 'online', orderId, now, now, bill.id,
        );
        if (bill.draft_order_id && this.shopify.configured) this.later(this.shopify.deleteDraftIfOpen(bill.draft_order_id));
      } else {
        this.voidBill(bill, states.includes('paid') ? 'part-paid' : 'changed', now);
      }
      changed.push(bill.id);
    }
    return changed;
  },

  /** Whether a bill's item has been paid (a tab marked paid, or a booking or sign-up with nothing left to pay that was paid) */
  billItemPaid(item) {
    if (item.type === 'tab') return this.sql.exec('SELECT status FROM tabs WHERE id = ?', item.id).toArray()[0]?.status === 'paid';
    const x = item.type === 'join' ? this.joinById(item.id) : this.booking(item.id);
    return Boolean(x && x.paid && !x.waived);
  },

  /**
   * The POS's rows for what a member owes on their account from earlier days (a monthly period's check-ins and tabs),
   * after their weekly seats: each owed: true, onAccount: true, with its cart line ("Owed: Table T3 (Thu 1 Oct)", or a
   * tab's "Tab: Thu 1 Oct (3 things)" tagged _tab). Today's are in their day already. No awaits.
   */
  accountOwedRows(customerId, rules, now) {
    if (!this.accountRow(customerId)) return [];
    const { from } = this.dayWindow(rules, now);
    const rows = [];
    for (const i of this.runningTab(customerId, rules, now).owed.items) {
      if (i.weekly || i.when >= from || i.settle !== 'account') continue;
      if (i.type === 'tab') {
        const t = this.sql.exec('SELECT * FROM tabs WHERE id = ?', i.id).toArray()[0];
        if (!t) continue;
        const title = `Tab: ${this.shortDay(t.created_at, rules)} (${plural(i.things || 0, 'thing', 'things')})`;
        rows.push({
          id: t.id, type: 'tab', kind: 'tab', ref: i.ref, name: '', people: 1, tables: [], start: t.created_at, end: t.updated_at || t.created_at, status: t.status,
          arrivedAt: null, paid: false, amount: t.total, covered: 0, due: t.total, paidAmount: 0, payments: [], split: false, customerId: String(customerId), pass: null,
          refund: null, note: '', title: 'Tab', players: [], gameId: null, occurrenceId: null, seriesId: null, owed: true, waived: false, onAccount: true,
          items: parse(t.items, []),
          line: { title: title.slice(0, 120), price: (t.total / 100).toFixed(2), quantity: 1, taxable: true, properties: { _tab: t.id } },
        });
        continue;
      }
      const x = i.type === 'join' ? this.joinById(i.id) : this.booking(i.id);
      if (!x) continue;
      const row = { ...(i.type === 'join' ? this.joinRow(x) : this.bookingRow(x, rules, { now })), owed: true, onAccount: true };
      rows.push({ ...row, line: this.posLine(row, rules) });
    }
    return rows;
  },

  /* ---------------- maintenance ---------------- */
  /**
   * Every maintenance run: (1) the monthly bills: the first run on or after the 1st (Lair time) makes, for each monthly
   * account that was monthly before that 1st and owes anything from before it, one bill for the month before, and emails
   * it (never two for one member and month); (2) open bills whose draft order couldn't be made are tried again and sent;
   * (3) a bill still open 14 days after it was sent gets one friendly reminder. Returns { made, retried, reminded }.
   */
  async billMaintenance(rules, now = Date.now()) {
    const time = new LairTime(rules.tz);
    const today = time.key(now);
    const firstKey = `${today.slice(0, 7)}-01`;
    const first = time.at(firstKey, 0);
    const lastMonth = new Date(Date.UTC(Number(firstKey.slice(0, 4)), Number(firstKey.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
    const out = { made: [], retried: [], reminded: [] };
    const due = this.sql.exec("SELECT * FROM tab_accounts WHERE billing = 'monthly' ORDER BY customer_id").toArray().filter((row) => {
      const since = this.accountPeriods(row).slice(-1)[0]?.[0];
      if (!(since < first)) return false;
      return !this.sql.exec("SELECT 1 AS n FROM tab_bills WHERE customer_id = ? AND month = ? AND kind = 'month'", row.customer_id, lastMonth).toArray().length;
    });
    for (const row of due.slice(0, BILLS_A_RUN)) {
      const made = await this.makeBill(row.customer_id, { kind: 'month', month: lastMonth, before: first, by: 'monthly', send: true, rules, now });
      if (made.bill) out.made.push(made.bill.id);
    }
    // open bills with no link yet (Shopify was down, at least 5 minutes ago): try again, then send the ones never sent
    const retryBefore = now - 5 * 60_000;
    for (const bill of this.sql.exec("SELECT * FROM tab_bills WHERE status = 'open' AND draft_order_id IS NULL AND created_at < ? ORDER BY created_at LIMIT ?", retryBefore, BILLS_A_RUN).toArray()) {
      const fresh = await this.billDraft(bill.id, rules);
      if (fresh?.invoice_url) {
        out.retried.push(bill.id);
        if (!fresh.emailed_at && fresh.made_by !== 'member') this.sendBill(fresh, rules);
      }
    }
    // --- no awaits from here on ---
    const remindBefore = now - BILL_REMIND_DAYS * 24 * HOUR;
    for (const bill of this.sql.exec("SELECT * FROM tab_bills WHERE status = 'open' AND emailed_at IS NOT NULL AND emailed_at <= ? AND reminded_at IS NULL AND invoice_url IS NOT NULL", remindBefore).toArray()) {
      if (this.sendBill(bill, rules, { reminder: true }).ok) out.reminded.push(bill.id);
    }
    return out;
  },
};

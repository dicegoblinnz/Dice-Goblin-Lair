/**
 * Round 48 (20 Nov 2026, contract v48-card-pay): My Lair's bill paid by card on the member's phone, beside Pay with cash
 * and Pay with store credit. Mo: "give people the ability to pay on their phone and account without having to go to the
 * till", with staff able to see who has paid, and "encourage one big transaction rather than many small ones".
 *
 * The bill is the one cash and store credit pay (src/cash.js cashBill): today's bookings, seats and sign-ups with
 * something to pay, what's owed and today's tab. It's always paid whole, in one payment. The card itself is taken by a
 * provider's hosted page (src/card-providers.js): the Lair never sees a card number.
 *
 * Each payment is a row in card_payments, written before the provider is asked:
 *  - 'starting': the card page is being made
 *  - 'open': the member has a card page to pay on, until expires_at
 *  - 'paid': the provider says it took exactly the bill, and the bill was still the same: it's paid
 *  - 'failed': the page couldn't be made, or the provider says the payment failed. Nothing was taken
 *  - 'expired': never paid in time, or replaced by a newer page
 * A page that closed unpaid ('expired', or 'failed' with a page made) is still asked about on every run until
 * CARD_PAY.watchMs after its time ran out (then looked_at is set), so a card charged late is never left in limbo
 *  - 'refunding': the card was charged, but the bill had changed or been paid another way, so it's all going back
 *  - 'refunded': it went back
 *  - 'check': the provider didn't confirm the refund, or took a different amount: staff sort it by hand
 * Nothing the browser says pays anything. Only the provider's own answer (look) does, with the amount it took.
 *
 * Methods of the Lair Durable Object (Object.assign onto its prototype in lair.js): every await first, then synchronous
 * reads, checks and writes.
 */
import { LairTime, MIN, RuleError, makeId } from './core.js';
import { cardProvider } from './card-providers.js';
import { PAID_ORDER_COLUMNS } from './paid-order.js';

export const CARD_PAY = Object.freeze({
  // how long a card page takes payment for
  openMs: 30 * MIN,
  // a page with less than this left isn't handed out again: a fresh one is made
  spareMs: 2 * MIN,
  // a row left 'starting' or 'refunding' this long was cut off by a restart
  stale: 5 * MIN,
  // a page that closed unpaid (expired, replaced, or a failed try) is still asked about for this long after its time ran
  // out, in case the card was charged late; then the Lair stops looking
  watchMs: 2 * 60 * MIN,
  // the provider is asked about one payment at most this often from the member's own page
  askEvery: 3000,
  // a payment staff are sorting by hand stops showing in My Lair after this
  checkShownMs: 3 * 24 * 60 * MIN,
  perRun: 20,
  // a bill under this gets the nudge to pay once at the end of the night (the provider charges per payment)
  nudgeUnder: 2000,
});

export const CARD_ORDER_TAG = 'lair-card';
/** Its Shopify order (src/paid-order.js) */
export const CARD_ORDER = Object.freeze({
  table: 'card_payments', tag: CARD_ORDER_TAG, tags: [CARD_ORDER_TAG, 'card'], marker: '_lair_card',
  // (no booking codes in the note: the orders/paid webhook reads them from a draft's note)
  note: (id) => `Paid by card in My Lair (${id}).`,
  how: 'by card on their phone',
});

export const CARD_PAY_TABLES = [
  // key: My Lair's own for the payment. items: what the bill was; lines: its Shopify order's lines. ref, url: the
  // provider's checkout and its page. refund_id: the provider's refund.
  `CREATE TABLE IF NOT EXISTS card_payments (
     id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, key TEXT NOT NULL, day TEXT NOT NULL, amount INTEGER NOT NULL,
     currency TEXT NOT NULL, status TEXT NOT NULL, provider TEXT, ref TEXT, url TEXT, items TEXT, lines TEXT, message TEXT,
     refund_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, paid_at INTEGER,
     looked_at INTEGER, ${PAID_ORDER_COLUMNS})`,
  'CREATE UNIQUE INDEX IF NOT EXISTS card_payments_key ON card_payments (customer_id, key)',
  'CREATE INDEX IF NOT EXISTS card_payments_customer ON card_payments (customer_id, status)',
  'CREATE INDEX IF NOT EXISTS card_payments_status ON card_payments (status, updated_at)',
  'CREATE INDEX IF NOT EXISTS card_payments_day ON card_payments (day, status)',
  'CREATE INDEX IF NOT EXISTS card_payments_order ON card_payments (order_status, order_next_at)',
];

const money = (cents) => `$${(Math.round(Number(cents) || 0) / 100).toFixed(2)}`;
const said = (error) => String(error?.message || error || 'no answer').slice(0, 160);
const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

/** Every message members see, word for word in the contract */
export const CARD_PAY_WORDS = {
  login: 'Log in to pay by card.',
  noAccount: 'Open My Lair once first, then try again.',
  key: "That didn't come through properly. Try again.",
  expect: 'expect is the amount you were shown, in cents.',
  monthly: "You're on a monthly account, so it all goes on your bill. Pay it online in My Lair, or at the counter.",
  nothing: "There's nothing to pay right now.",
  passCovered: "Your session pass covered it, so there's nothing to pay.",
  changed: (total) => `Your bill's ${money(total)} now (a session pass took some off, or something changed). Check it, then pay again.`,
  atCounter: "It's being rung up at the counter right now, so pay there.",
  off: "Paying by card on your phone isn't switched on right now. Pay at the counter.",
  notStarted: "The card page didn't open, so nothing was paid. Try again in a minute, or pay at the counter.",
  busy: 'Your last card payment is still being sorted out. Try again in a few minutes, or pay at the counter.',
  notFound: 'That card payment could not be found.',
  opening: 'Your card page is still opening. Give it a moment.',
  waiting: 'Your card page is ready. Finish paying there.',
  notYet: "That payment hasn't come through yet. Finish it on the card page, or pay at the counter.",
  failed: "That card payment didn't go through, so nothing was paid. Try again, or pay at the counter.",
  expired: 'That card page timed out, so nothing was paid. Tap Pay by card again.',
  paid: (total) => `Paid! ${money(total)} by card. Gobgob's ticked it off.`,
  refunding: 'Something on your bill was paid another way just now, so your card payment is going straight back to your card. Check your bill.',
  refunded: "Your bill had changed, so that card payment went back to your card. Check your bill, then pay again if there's anything left.",
  check: 'Your card was charged, but your bill had changed, and the refund needs a hand from staff. Show this at the counter and we will sort it.',
  // shown under the button while the bill is small (CARD_PAY.nudgeUnder)
  hint: 'Still playing? Pay once at the end of the night and it all goes through in one go.',
};
const W = CARD_PAY_WORDS;

// a member has one of these at a time, and can't start another payment while it's being sorted
const BUSY_SQL = "('starting', 'refunding')";
const STATUS_WORDS = { open: W.notYet, failed: W.failed, expired: W.expired, refunding: W.refunding, refunded: W.refunded, check: W.check };

export const cardPayMethods = {
  /* ---------------- rows and views ---------------- */

  /** Who takes the card now, or null when card pay is off. Tests set lair.cards. */
  cardsNow() {
    return this.cards !== undefined ? this.cards : cardProvider(this.env);
  },

  cardPayRow(id) {
    return id ? this.sql.exec('SELECT * FROM card_payments WHERE id = ?', String(id)).toArray()[0] || null : null;
  },

  /** Change a payment's own row. No awaits. */
  cardPayUpdate(id, fields) {
    const sets = Object.keys(fields).map((k) => `${k} = ?`);
    this.write(`UPDATE card_payments SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...Object.values(fields), Date.now(), id);
  },

  /** A payment as the member sees it. url only while its page still takes payment. No awaits. */
  cardPayView(row, now = Date.now()) {
    if (!row) return null;
    const status = row.status === 'starting' ? 'open' : row.status;
    return {
      id: row.id, status, amount: row.amount, items: parse(row.items, []), at: row.created_at, paidAt: row.paid_at || null,
      expiresAt: row.expires_at, url: row.status === 'open' && row.expires_at > now ? row.url : null,
    };
  },

  cardPayMessage(row) {
    return row.status === 'paid' ? W.paid(row.amount) : row.status === 'starting' ? W.opening : STATUS_WORDS[row.status] || W.notYet;
  },

  /** Their card page still open, newest first, or null. No awaits. */
  cardPayOpen(customerId) {
    return this.sql.exec("SELECT * FROM card_payments WHERE customer_id = ? AND status = 'open' ORDER BY created_at DESC, rowid DESC LIMIT 1", String(customerId)).toArray()[0] || null;
  },

  /**
   * GET /me's cardPay: { on, open, nudgeUnder, hint }. on: the button shows (a provider is set, and they pay each visit).
   * open: their payment still to finish or being sorted (a page to pay on, a refund on its way, one staff are sorting),
   * or null. The page shows `hint` under the button while the bill is under nudgeUnder. No awaits.
   */
  memberCardPay(customerId, now = Date.now()) {
    const row = this.sql
      .exec(
        "SELECT * FROM card_payments WHERE customer_id = ? AND (status IN ('starting', 'open', 'refunding') OR (status = 'check' AND updated_at > ?)) ORDER BY created_at DESC, rowid DESC LIMIT 1",
        String(customerId), now - CARD_PAY.checkShownMs,
      )
      .toArray()[0];
    return {
      on: Boolean(this.cardsNow()) && this.accountRow(customerId)?.billing !== 'monthly',
      open: row ? this.cardPayView(row, now) : null, nudgeUnder: CARD_PAY.nudgeUnder, hint: W.hint,
    };
  },

  /**
   * GET /floor's paidOnPhone (staff who take cash): everyone who paid their own bill on their phone today, by card or
   * store credit, newest first, so "I've paid" can be checked at a glance. No awaits.
   */
  paidOnPhone(rules, now) {
    const day = new LairTime(rules.tz).key(now);
    const rows = [
      ...this.sql.exec("SELECT id, customer_id, amount, items, paid_at, 'card' AS how FROM card_payments WHERE day = ? AND status = 'paid'", day).toArray(),
      ...this.sql.exec("SELECT id, customer_id, amount, items, paid_at, 'credit' AS how FROM credit_payments WHERE day = ? AND source = 'me' AND status = 'paid'", day).toArray(),
    ];
    return rows.sort((a, b) => b.paid_at - a.paid_at).slice(0, 60).map((r) => {
      const member = this.memberRow(r.customer_id);
      return {
        id: r.id, how: r.how, customerId: r.customer_id, name: member?.name || member?.first_name || member?.code || 'A member',
        code: member?.code || null, amount: r.amount, items: parse(r.items, []), paidAt: r.paid_at,
      };
    });
  },

  /* ---------------- paying ---------------- */

  /**
   * POST /me/card { expect, key, back? } (logged in): open a card page for everything on My Lair's bill. expect is the
   * total they were shown (cents); key (8 to 64 letters, numbers, dashes or underscores) makes it safe to send again;
   * back is the website path the card page returns to. Returns { card, url, message }. Nothing is paid here: the bill is
   * paid when the provider says the card was charged (cardPayLook).
   */
  async payBillByCard(input, who) {
    if (!who?.customerId) throw new RuleError(W.login, 401);
    const customerId = String(who.customerId);
    if (!this.memberRow(customerId)) throw new RuleError(W.noAccount, 404);
    const key = typeof input?.key === 'string' ? input.key : '';
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new RuleError(W.key, 400);
    const repeat = () => this.sql.exec('SELECT * FROM card_payments WHERE customer_id = ? AND key = ?', customerId, key).toArray()[0] || null;
    const handBack = (row) => ({ card: this.cardPayView(row), url: this.cardPayView(row).url, message: this.cardPayMessage(row), repeated: true });
    const again = repeat();
    if (again) return handBack(again);
    const expect = input?.expect;
    if (typeof expect !== 'number' || !Number.isInteger(expect) || expect < 0) throw new RuleError(W.expect, 400);
    // only a path on the website itself, so the card page can never send anyone elsewhere
    const back = typeof input?.back === 'string' && /^\/(?!\/)[\w\-./?=&%]{0,200}$/.test(input.back) ? input.back : '/';
    const rules = await this.rules();
    // --- no awaits until it's claimed (a second tap may have come in meanwhile) ---
    const raced = repeat();
    if (raced) return handBack(raced);
    if (this.accountRow(customerId)?.billing === 'monthly') throw new RuleError(W.monthly, 409);
    if (this.sql.exec(`SELECT 1 AS n FROM card_payments WHERE customer_id = ? AND status IN ${BUSY_SQL} LIMIT 1`, customerId).toArray().length) throw new RuleError(W.busy, 409);
    const now = Date.now();
    const before = this.cashBill(customerId, rules, now);
    if (!before.total) throw new RuleError(W.nothing, 409);
    if (this.creditPayAtCounter(customerId, before, rules, now)) throw new RuleError(W.atCounter, 409);
    const cards = this.cardsNow();
    if (!cards) throw new RuleError(W.off, 503);
    // saved passes first, as at check-in: the bill they'd pay at the counter
    this.creditPayPasses(customerId, rules, now);
    const bill = this.cashBill(customerId, rules, now);
    if (!bill.total) throw new RuleError(W.passCovered, 409);
    if (bill.total !== expect) throw new RuleError(W.changed(bill.total), 409);
    // a page of theirs still open: the same bill with time left is handed back; anything else is closed for a fresh one
    const open = this.cardPayOpen(customerId);
    if (open) {
      if (open.expires_at - now > CARD_PAY.spareMs && this.creditPaySameBill({ items: parse(open.items, []), total: open.amount }, bill)) {
        return { card: this.cardPayView(open, now), url: open.url, message: W.waiting, repeated: true };
      }
      this.write("UPDATE card_payments SET status = 'expired', message = 'replaced by a newer page', updated_at = ? WHERE customer_id = ? AND status = 'open'", now, customerId);
      // closed at the provider too, where it can be (it's still watched either way)
      if (cards.cancel) this.later(cards.cancel(open.ref).catch((error) => console.error('Lair: a replaced card page could not be closed', error)));
    }
    const id = makeId('kp');
    const currency = this.env?.CURRENCY || 'NZD';
    const expiresAt = now + CARD_PAY.openMs;
    this.write(
      `INSERT INTO card_payments (id, customer_id, key, day, amount, currency, status, provider, items, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?)`,
      id, customerId, key, new LairTime(rules.tz).key(now), bill.total, currency, String(cards.name || ''), JSON.stringify(bill.items), now, now, expiresAt,
    );
    // --- claimed: now the provider. Afterwards only this payment's own row is touched ---
    let made = null;
    try {
      made = await cards.start({ id, amount: bill.total, currency, title: 'Dice Goblin: your Lair bill', back, expiresAt });
    } catch (error) {
      console.error('Lair: a card page could not be made', error);
    }
    // --- no awaits from here on ---
    // (only while it's still 'starting': the run fails one that hung past CARD_PAY.stale)
    const set = (fields) => this.write(
      `UPDATE card_payments SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND status = 'starting'`,
      ...Object.values(fields), Date.now(), id,
    );
    if (!made?.ref || !/^https:\/\//.test(String(made.url || ''))) {
      set({ status: 'failed', message: made ? 'the provider gave no page' : 'no answer making the page' });
      throw new RuleError(W.notStarted, 503);
    }
    set({ status: 'open', ref: String(made.ref), url: String(made.url) });
    if (this.cardPayRow(id).status !== 'open') throw new RuleError(W.notStarted, 503);
    const row = this.cardPayRow(id);
    return { card: this.cardPayView(row), url: row.url, message: W.waiting };
  },

  /** Whether the provider is still asked about a payment: its page is open, or closed unpaid and inside the watch. No awaits. */
  cardPayWatched(row) {
    return Boolean(row?.ref) && (row.status === 'open' || (['expired', 'failed'].includes(row.status) && row.looked_at == null));
  },

  /** POST /me/card/:id (logged in, their own): ask the provider about it now, then how it stands → { card, message }. */
  async checkCardPay(id, who) {
    if (!who?.customerId) throw new RuleError(W.login, 401);
    const mine = () => {
      const row = this.cardPayRow(id);
      return row && row.customer_id === String(who.customerId) ? row : null;
    };
    if (!mine()) throw new RuleError(W.notFound, 404);
    // (a closed page still being watched is asked about too, so "I paid on the old page" gets a true answer)
    if (!this.cardAsked) this.cardAsked = new Map();
    const now = Date.now();
    if (this.cardPayWatched(mine()) && now - (this.cardAsked.get(id) || 0) >= CARD_PAY.askEvery) {
      if (this.cardAsked.size > 500) this.cardAsked.clear();
      this.cardAsked.set(id, now);
      await this.cardPayLook(id);
    }
    const row = mine();
    return { card: this.cardPayView(row), message: this.cardPayMessage(row) };
  },

  /**
   * Ask the provider how a payment stands, and act on its answer alone. Paid for exactly the bill, and the bill still the
   * same and not at the counter: it's paid. Paid, but the bill has changed or was paid another way: it all goes back.
   * Paid for some other amount: staff. Never throws. Returns the row's status after.
   */
  async cardPayLook(id) {
    const first = this.cardPayRow(id);
    if (!this.cardPayWatched(first)) return first?.status || null;
    const cards = this.cardsNow();
    if (!cards) return first.status;
    let rules;
    let seen;
    try {
      rules = await this.rules();
      seen = await cards.look(first.ref);
    } catch (error) {
      console.error('Lair: the card provider did not answer about a payment', error);
      // (touched, so one that never answers doesn't hold the front of the run's queue; the watch still ends on time)
      const stuck = this.cardPayRow(id);
      if (stuck && stuck.status === first.status) this.cardPayUpdate(id, stuck.status !== 'open' && Date.now() >= stuck.expires_at + CARD_PAY.watchMs ? { looked_at: Date.now() } : { message: stuck.message });
      return first.status;
    }
    // --- no awaits from here on ---
    const row = this.cardPayRow(id);
    if (!row || row.status !== first.status) return row?.status || null;
    const now = Date.now();
    if (seen?.status === 'paid') {
      if (seen.amount !== row.amount || (seen.currency && seen.currency !== row.currency)) {
        this.cardPayUpdate(id, { status: 'check', message: `the provider took ${money(seen.amount)}${seen.currency ? ` ${seen.currency}` : ''}, not ${money(row.amount)} ${row.currency}` });
        this.cardPayAlert(this.cardPayRow(id));
        return 'check';
      }
      const bill = { items: parse(row.items, []), total: row.amount };
      const live = this.cashBill(row.customer_id, rules, now);
      if (this.creditPaySameBill(live, bill) && !this.creditPayAtCounter(row.customer_id, live, rules, now)) {
        const lines = this.settleMyBill(`card:${id}`, row.customer_id, bill, rules, now, 'card');
        // (day: the day it was paid, which is the day staff see it under)
        this.cardPayUpdate(id, { status: 'paid', paid_at: now, day: new LairTime(rules.tz).key(now), lines: JSON.stringify(lines), order_status: 'due', message: null });
        this.touchMember(row.customer_id, {}, now);
        this.startPaidOrder(CARD_ORDER, id);
        return 'paid';
      }
      this.cardPayUpdate(id, { status: 'refunding', message: 'the bill changed before the card was charged' });
      this.later(this.cardPayRefund(id));
      return 'refunding';
    }
    // not paid: an open page fails or runs out; a closed one is watched until CARD_PAY.watchMs past its time, then let go
    if (row.status !== 'open') this.cardPayUpdate(id, now >= row.expires_at + CARD_PAY.watchMs ? { looked_at: now } : { message: row.message });
    else if (seen?.status === 'failed') this.cardPayUpdate(id, { status: 'failed', message: 'the provider says it failed' });
    else if (now >= row.expires_at) this.cardPayUpdate(id, { status: 'expired', message: 'never paid' });
    else this.cardPayUpdate(id, { message: row.message });
    return this.cardPayRow(id).status;
  },

  /** Send a charged card's money back: 'refunded', or 'check' (staff hear) when the provider doesn't confirm it. Never throws. */
  async cardPayRefund(id) {
    const row = this.cardPayRow(id);
    if (!row || row.status !== 'refunding') return row?.status || null;
    let back = null;
    let why = 'card pay is switched off';
    try {
      const cards = this.cardsNow();
      if (cards) back = await cards.refund(row.ref, row.amount, row.id);
    } catch (error) {
      console.error('Lair: a card payment could not be refunded', error);
      why = said(error);
    }
    // --- no awaits from here on ---
    const fresh = this.cardPayRow(id);
    if (!fresh || fresh.status !== 'refunding') return fresh?.status || null;
    if (back) {
      this.cardPayUpdate(id, { status: 'refunded', refund_id: back.id ? String(back.id) : null });
      return 'refunded';
    }
    this.cardPayUpdate(id, { status: 'check', message: `refund: ${why}` });
    this.cardPayAlert(this.cardPayRow(id));
    return 'check';
  },

  /** Staff hear about a card payment that needs sorting by hand, with what to do. Once each. No awaits. */
  cardPayAlert(row) {
    const name = this.memberName(row.customer_id);
    const amount = money(row.amount);
    this.staffAlert(`card-pay-check:${row.id}`, `Refund a card payment by hand: ${name}`, {
      title: 'A card payment to refund by hand',
      intro: `${name} paid by card on their phone, but it didn't pay their bill (${row.message || 'their bill had changed'}), and the Lair couldn't send the money back by itself. Nothing on their bill was marked paid by it. Find the payment in the card provider's portal by its reference below, refund what was taken, and tell ${name} it's on its way back. The Lair won't try again, so it never goes back twice.`,
      details: [['Member', name], ['Bill', amount], ['Provider', row.provider || ''], ['Reference', row.ref || row.id], ['Why', row.message || '']],
    }, Date.now());
  },

  /* ---------------- the 10-minute run ---------------- */

  /**
   * The 10-minute run: rows cut off by a restart ('starting' never got a page, so nothing was taken; 'refunding' goes to
   * staff), every open page asked about (so a member who paid and closed the tab is still marked paid), and each
   * page that closed unpaid asked about until its watch ends. Returns counts when it did anything, else null.
   */
  async cardPayUpkeep(now = Date.now()) {
    const out = {};
    const add = (key) => {
      out[key] = (out[key] || 0) + 1;
    };
    for (const row of this.sql.exec(`SELECT * FROM card_payments WHERE status IN ${BUSY_SQL} AND updated_at < ? LIMIT ?`, now - CARD_PAY.stale, CARD_PAY.perRun).toArray()) {
      if (row.status === 'starting') this.cardPayUpdate(row.id, { status: 'failed', message: 'no answer making the page (the Lair restarted)' });
      else {
        this.cardPayUpdate(row.id, { status: 'check', message: 'refund: no answer (the Lair restarted)' });
        this.cardPayAlert(this.cardPayRow(row.id));
      }
      add(row.status === 'starting' ? 'failed' : 'check');
    }
    if (!this.cardsNow()) return Object.keys(out).length ? out : null;
    // (the longest unasked first)
    const due = this.sql.exec(
      `SELECT id FROM card_payments WHERE ref IS NOT NULL AND (status = 'open' OR (status IN ('expired', 'failed') AND looked_at IS NULL))
         ORDER BY updated_at LIMIT ?`,
      CARD_PAY.perRun,
    ).toArray();
    for (const { id } of due) add(await this.cardPayLook(id) || 'gone');
    return Object.keys(out).length ? out : null;
  },
};

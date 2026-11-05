/**
 * Round 30 (6 Nov 2026, contract v30-credit): members send some of their store credit to another member. From Mo: "I
 * want the clients to have the ability to gift their store credit to another." Planned since round 6 as "sending store
 * credit to another member by their member code".
 *
 * In My Lair's Wallet a member types a friend's member code (from the friend's Goblin card), checks who it is ("Kai
 * T."), picks an amount and an optional note, and sends it. The Lair takes it off the sender's Shopify store credit,
 * then adds it to the friend's, and emails them both (the friend with who it's from and the note; the sender a receipt,
 * so a gift they didn't send is noticed). Nothing the browser says about balances is trusted: Shopify's store credit is
 * the balance, and Shopify refuses to take off more than there is.
 *
 * Each gift is a row in credit_gifts, written before Shopify is asked, so a gift never moves twice:
 *  - 'taking': its store credit is coming off the sender now
 *  - 'giving': it came off, and is going on the friend's now
 *  - 'returning': Shopify wouldn't add it to the friend's, so it's going back on the sender's now
 *  - 'checking': Shopify didn't answer while it came off (it may or may not have): the 10-minute run looks in the
 *    sender's store credit, and goes on to the friend's when it finds it, or calls it failed after CREDIT_GIFT.goneAfter
 *  - 'check': Shopify didn't answer while it went on the friend's (or back on the sender's), so it may have: never tried
 *    again by itself. Staff hear, look in Shopify admin and say what happened (settle: 'sent', 'returned' or 'failed')
 *  - 'sent': on the friend's store credit
 *  - 'failed': nothing moved (Shopify said no, there wasn't enough, or nothing came off)
 *  - 'returned': it came off and went back on the sender's: nothing moved in the end
 * A taking, giving or returning gift left by a restart mid-call (CREDIT_GIFT.stale) counts as an answer lost.
 *
 * Limits, so a slip or someone else on a member's phone can't empty their store credit: $1 to $200 a gift, $200 and 5
 * gifts a sender a Lair day (gifts that didn't go don't count), one gift at a time, and 20 member codes looked up an hour
 * (so nobody can trawl through codes for names). Only the friend's first name and initial ever show to the sender.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair:
 * every await first, then synchronous reads, checks and writes.
 */
import { HOUR, LairTime, MIN, RuleError, addDays, makeId } from './core.js';
import { emailReady } from './shopify.js';

export const CREDIT_GIFT = Object.freeze({
  // cents: the least and most one gift sends, and the most a sender sends in a Lair day
  min: 100,
  max: 20_000,
  dayMax: 20_000,
  // gifts a sender sends in a Lair day
  dayCount: 5,
  noteMax: 140,
  // member codes looked up (to check who it is, or to send) a member an hour
  lookups: 20,
  lookupWindow: HOUR,
  // how long one store credit change may take before its answer counts as lost
  timeoutMs: 20_000,
  // a gift taking, giving or returning this long had no answer (the Lair restarted mid-call)
  stale: 30 * MIN,
  // an answer lost while it came off: looked for in the sender's store credit from lookAfter, until goneAfter (then it
  // didn't come off), allowing skew either side for the two clocks
  lookAfter: 2 * MIN,
  goneAfter: 30 * MIN,
  skew: 2 * MIN,
  // Shopify can't be read about it for this long: staff look
  askAfter: 2 * HOUR,
  // gifts looked at in one 10-minute run, and gifts My Lair lists
  perRun: 10,
  listed: 10,
});

/** The ledger's table and indexes (made when missing) */
export const CREDIT_GIFT_TABLES = [
  // stage: for 'check', the change whose answer was lost ('take', 'give' or 'back'). take_tx, give_tx, back_tx: Shopify's
  // store credit transactions. balance_after: the sender's balance once it came off (cents, when Shopify said).
  `CREATE TABLE IF NOT EXISTS credit_gifts (
     id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, note TEXT,
     key TEXT NOT NULL, status TEXT NOT NULL, stage TEXT, take_tx TEXT, give_tx TEXT, back_tx TEXT, balance_after INTEGER, message TEXT,
     emailed INTEGER NOT NULL DEFAULT 0, settled_by TEXT, settled_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     sent_at INTEGER)`,
  // a request's own key, for each sender: the same tap again gives back the first and moves nothing
  'CREATE UNIQUE INDEX IF NOT EXISTS credit_gifts_key ON credit_gifts (from_id, key)',
  'CREATE INDEX IF NOT EXISTS credit_gifts_from ON credit_gifts (from_id, created_at)',
  'CREATE INDEX IF NOT EXISTS credit_gifts_to ON credit_gifts (to_id, created_at)',
  'CREATE INDEX IF NOT EXISTS credit_gifts_status ON credit_gifts (status, updated_at)',
];

const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const said = (error) => String(error?.message || error || 'no answer').replace(/^Shopify API:\s*/, '').slice(0, 160);

/** Every message members and staff can see, word for word in the contract */
export const CREDIT_GIFT_WORDS = {
  login: 'Log in to send store credit.',
  noAccount: 'Open My Lair once first, then try again.',
  code: "Type your friend's member code, like SJ-OWLBEAR-17. It's on their Goblin card in My Lair.",
  noMember: "There's no member with that code. Check it with your friend.",
  own: "That's your own member code. Pop in your friend's instead.",
  amount: `Send between ${money(CREDIT_GIFT.min).replace('.00', '')} and ${money(CREDIT_GIFT.max).replace('.00', '')} at a time.`,
  note: `Keep the note to ${CREDIT_GIFT.noteMax} characters.`,
  key: "That didn't come through properly. Try again.",
  daily: (left) => (left > 0 ? `You can send ${money(left)} more today.` : "That's all the store credit you can send today. More can go tomorrow."),
  count: `That's ${CREDIT_GIFT.dayCount} gifts sent today. More can go tomorrow.`,
  busy: 'Your last gift is still on its way. Try again in a few minutes.',
  lookups: "That's a lot of member codes in a row. Try again in an hour.",
  off: "Store credit can't be sent right now. Try again in a minute.",
  short: (balance) => (balance > 0 ? `You have ${money(balance)} of store credit, so you can send ${money(balance)} at most.` : "You don't have any store credit to send right now."),
  shortNow: "You don't have that much store credit. Check your balance and send less.",
  notTaken: (why) => `Shopify didn't take the store credit off your account (${why}). Nothing moved. Try again in a minute.`,
  returned: (first) => `Shopify wouldn't add it to ${first}'s account, so it's back on yours. Nothing's changed.`,
  backCheck: (first) => `Shopify wouldn't add it to ${first}'s account, and hasn't said it's back on yours yet. The team's checking, so nothing goes twice.`,
  sent: (amount, first) => `Sent! ${amount} is on ${first}'s account now.`,
  checking: "Shopify didn't answer, so Gobgob's checking whether it went. It shows here within 10 minutes.",
  onItsWay: (first) => `It came off your store credit, but Shopify hasn't said it reached ${first} yet. The team's checking, so it's never sent twice.`,
  gone: "Shopify has no record of it coming off, so nothing moved.",
  notCheck: "That gift isn't waiting to be checked.",
  outcome: 'Say what happened: sent, returned or failed.',
};

// the statuses still with Shopify (or waiting to be looked for there): a sender has one of these at a time
const MOVING = ['taking', 'giving', 'returning', 'checking'];
// the gifts that may have reached the friend (they see them in My Lair, and staff on their page): on their store credit,
// going on it now, or staff checking whether it went on it. One staff check about taking it off the sender, or putting
// it back on the sender's, never went the friend's way (round 30's review)
const REACHED = "(status IN ('sent', 'giving') OR (status = 'check' AND stage = 'give'))";

/** A note as kept: one line, no control characters, spaces tidied. No awaits. */
function cleanNote(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, (run) => (/[\r\n\t]/.test(run) ? ' ' : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

export const creditGiftMethods = {
  /* ---------------- names and views ---------------- */

  /** A member as the other side of a gift sees them: "Kai T." (first name and initial), or "A member". No awaits. */
  creditGiftName(customerId) {
    const m = this.memberRow(customerId);
    const words = String(m?.name || '').trim().split(/\s+/).filter(Boolean);
    const first = String(m?.first_name || words[0] || '').trim();
    if (!first) return 'A member';
    const last = words.length > 1 ? words[words.length - 1] : '';
    return last ? `${first} ${last[0].toUpperCase()}.` : first;
  },

  /** A member's first name for the emails and messages. No awaits. */
  creditGiftFirst(customerId) {
    const m = this.memberRow(customerId);
    return String(m?.first_name || String(m?.name || '').split(/\s+/)[0] || 'your friend').trim();
  },

  /** A gift as a member sees it in My Lair: { id, direction, name (the other side), amount, note, status, at }. No awaits. */
  creditGiftView(row, viewer) {
    const sent = String(row.from_id) === String(viewer);
    const status = ['sent', 'failed', 'returned'].includes(row.status) ? row.status : 'checking';
    return { id: row.id, direction: sent ? 'sent' : 'received', name: this.creditGiftName(sent ? row.to_id : row.from_id), amount: row.amount, note: row.note || '', status, at: row.created_at };
  },

  /**
   * A gift as staff see it: the member view's facts with both sides, its own status and, for one waiting to be checked,
   * what was lost (stage). No awaits.
   */
  creditGiftStaffView(row) {
    return {
      id: row.id, from: { customerId: row.from_id, name: this.creditGiftName(row.from_id) }, to: { customerId: row.to_id, name: this.creditGiftName(row.to_id) },
      amount: row.amount, note: row.note || '', status: row.status, stage: row.status === 'check' ? row.stage || null : null, message: row.message || null,
      at: row.created_at, sentAt: row.sent_at || null, settledAt: row.settled_at || null,
    };
  },

  /** GET /me's creditGifts: their last gifts sent, and received ones that reached them, newest first. No awaits. */
  memberCreditGifts(customerId) {
    const id = String(customerId);
    return this.sql
      .exec(
        `SELECT * FROM credit_gifts WHERE from_id = ? OR (to_id = ? AND ${REACHED})
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        id, id, CREDIT_GIFT.listed,
      )
      .toArray()
      .map((row) => this.creditGiftView(row, id));
  },

  /** GET /me's giftCredit: { min, max, left } (left: cents they can still send today). No awaits. */
  giftCreditLimits(customerId, now = Date.now()) {
    const today = this.creditGiftsToday(String(customerId), now);
    return { min: CREDIT_GIFT.min, max: CREDIT_GIFT.max, left: today.count >= CREDIT_GIFT.dayCount ? 0 : Math.max(0, CREDIT_GIFT.dayMax - today.sum) };
  },

  /**
   * The staff page's store credit history for a member (memberCredit): their gifts, sent (minus) and received (plus,
   * once they may have reached them), as creditView's shape with kind 'gift', giftId, check (waiting to be checked) and
   * stage. No awaits.
   */
  creditGiftHistory(customerId) {
    const id = String(customerId);
    return this.sql
      .exec(
        `SELECT * FROM credit_gifts WHERE from_id = ? OR (to_id = ? AND ${REACHED})
          ORDER BY created_at DESC, rowid DESC LIMIT 20`,
        id, id,
      )
      .toArray()
      .map((row) => {
        const sent = String(row.from_id) === id;
        const status = row.status === 'sent' ? 'done' : ['failed', 'returned'].includes(row.status) ? 'failed' : 'pending';
        const other = this.creditGiftName(sent ? row.to_id : row.from_id);
        return {
          id: `gift:${row.id}`, giftId: row.id, kind: 'gift', amount: sent ? -row.amount : row.amount, note: `${sent ? 'Gift to' : 'Gift from'} ${other}${row.note ? `: ${row.note}` : ''}`,
          status, check: row.status === 'check', stage: row.status === 'check' ? row.stage || null : null, balanceAfter: null, message: row.message || null,
          at: row.created_at, by: null, from: this.creditGiftName(row.from_id), to: this.creditGiftName(row.to_id),
        };
      });
  },

  /* ---------------- checks ---------------- */

  /** What a sender has sent today (Lair time), gifts that didn't go left out: { sum, count }. No awaits. */
  creditGiftsToday(fromId, now) {
    const time = new LairTime(this.rulesCache?.tz || 'Pacific/Auckland');
    const from = time.at(time.key(now), 0);
    const to = time.at(addDays(time.key(now), 1), 0);
    return this.sql
      .exec("SELECT COALESCE(SUM(amount), 0) AS sum, COUNT(*) AS count FROM credit_gifts WHERE from_id = ? AND created_at >= ? AND created_at < ? AND status NOT IN ('failed', 'returned')", fromId, from, to)
      .one();
  },

  /** One member code looked up by a member (to check or to send): 429 past CREDIT_GIFT.lookups an hour. No awaits. */
  creditGiftLookup(customerId, now) {
    if (!this.creditGiftLookups) this.creditGiftLookups = new Map();
    const hits = (this.creditGiftLookups.get(customerId) || []).filter((t) => now - t < CREDIT_GIFT.lookupWindow);
    if (hits.length >= CREDIT_GIFT.lookups) {
      this.creditGiftLookups.set(customerId, hits);
      throw new RuleError(CREDIT_GIFT_WORDS.lookups, 429);
    }
    hits.push(now);
    if (this.creditGiftLookups.size > 2000) this.creditGiftLookups.clear();
    this.creditGiftLookups.set(customerId, hits);
  },

  /** The member a code is (a member's own current code), for a gift from `fromId`: their row, or 422, 404 or 409. No awaits. */
  creditGiftRecipient(code, fromId, now) {
    const text = String(code ?? '').trim();
    if (!text || text.length > 40) throw new RuleError(CREDIT_GIFT_WORDS.code);
    this.creditGiftLookup(fromId, now);
    const found = this.findCode(text);
    if (!found || found.type !== 'member' || !found.item?.customer_id) throw new RuleError(CREDIT_GIFT_WORDS.noMember, 404);
    if (String(found.item.customer_id) === fromId) throw new RuleError(CREDIT_GIFT_WORDS.own, 409);
    return found.item;
  },

  /** POST /me/credit/gift/check { code } (logged in): who a member code is, before sending: { to: { name } }. No awaits. */
  checkCreditGift(input, who) {
    if (!who?.customerId) throw new RuleError(CREDIT_GIFT_WORDS.login, 401);
    const to = this.creditGiftRecipient(input?.code, String(who.customerId), Date.now());
    return { to: { name: this.creditGiftName(to.customer_id) } };
  },

  /* ---------------- sending ---------------- */

  /**
   * POST /me/credit/gift { code, amount (cents), note?, key } (logged in): send some of their store credit to the member
   * whose code it is. key (8 to 64 letters, numbers, dashes or underscores, the page's own for this gift) makes it safe
   * to send again: the same key gives back the first gift (repeated: true) and moves nothing. Returns { gift (as My
   * Lair lists it), balance (theirs after, in cents, or null), message }. A gift Shopify said no to, or that came back,
   * is a 409 with why; nothing moved.
   */
  async sendCreditGift(input, who) {
    if (!who?.customerId) throw new RuleError(CREDIT_GIFT_WORDS.login, 401);
    const from = String(who.customerId);
    if (!this.memberRow(from)) throw new RuleError(CREDIT_GIFT_WORDS.noAccount, 404);
    const key = typeof input?.key === 'string' ? input.key : '';
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new RuleError(CREDIT_GIFT_WORDS.key);
    const repeat = () => this.sql.exec('SELECT * FROM credit_gifts WHERE from_id = ? AND key = ?', from, key).toArray()[0] || null;
    const again = repeat();
    if (again) return this.creditGiftRepeat(again, from);
    const amount = input?.amount;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < CREDIT_GIFT.min || amount > CREDIT_GIFT.max) throw new RuleError(CREDIT_GIFT_WORDS.amount);
    const note = cleanNote(input?.note);
    if (note.length > CREDIT_GIFT.noteMax) throw new RuleError(CREDIT_GIFT_WORDS.note);
    const to = this.creditGiftRecipient(input?.code, from, Date.now());
    this.creditGiftLimitCheck(from, amount, Date.now());
    if (!this.shopify?.configured) throw new RuleError(CREDIT_GIFT_WORDS.off, 503);
    const currency = this.env?.CURRENCY || 'NZD';
    // their balance first, when Shopify will say, for a clear "you have $4" (Shopify refuses to take more anyway)
    let balance = null;
    try {
      balance = await this.shopify.storeCreditBalance(from, currency);
    } catch {
      balance = null;
    }
    // --- no awaits until the gift is claimed (a second tap, or another gift, may have come in meanwhile) ---
    const raced = repeat();
    if (raced) return this.creditGiftRepeat(raced, from);
    this.creditGiftLimitCheck(from, amount, Date.now());
    if (balance != null && balance < amount) throw new RuleError(CREDIT_GIFT_WORDS.short(balance), 409);
    const id = makeId('cg');
    const now = Date.now();
    this.write(
      `INSERT INTO credit_gifts (id, from_id, to_id, amount, currency, note, key, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'taking', ?, ?)`,
      id, from, String(to.customer_id), amount, currency, note || null, key, now, now,
    );
    // --- claimed: now Shopify. Afterwards only this gift's own row is touched ---
    let took;
    try {
      took = await this.shopify.changeStoreCredit(from, -amount, currency, { timeout: CREDIT_GIFT.timeoutMs });
    } catch (error) {
      // --- no awaits from here on ---
      if (!error?.refused) {
        // it may or may not have come off: the 10-minute run looks in their store credit, so it never goes twice
        console.error('Lair: a store credit gift had no answer taking it off', error);
        this.creditGiftUpdate(id, { status: 'checking', stage: 'take', message: said(error) });
        return { gift: this.creditGiftView(this.creditGiftRow(id), from), balance: null, message: CREDIT_GIFT_WORDS.checking };
      }
      const short = error.code === 'INSUFFICIENT_FUNDS';
      const message = short ? CREDIT_GIFT_WORDS.shortNow : CREDIT_GIFT_WORDS.notTaken(said(error));
      this.creditGiftUpdate(id, { status: 'failed', message });
      throw new RuleError(message, 409);
    }
    const done = await this.giveCreditGift(id, { tx: took?.id || null, balanceAfter: took?.balanceAfter ?? null });
    if (done.refuse) throw new RuleError(done.message, 409);
    return { gift: this.creditGiftView(this.creditGiftRow(id), from), balance: done.balance, message: done.message };
  },

  /** The same tap again: the first gift as it stands (still going: checking). No awaits. */
  creditGiftRepeat(row, from) {
    const view = this.creditGiftView(row, from);
    const first = this.creditGiftFirst(row.to_id);
    const message = view.status === 'sent' ? CREDIT_GIFT_WORDS.sent(money(row.amount), first)
      : view.status === 'returned' ? CREDIT_GIFT_WORDS.returned(first)
        : view.status === 'failed' ? row.message || CREDIT_GIFT_WORDS.shortNow
          : row.status === 'check' || row.status === 'giving' ? CREDIT_GIFT_WORDS.onItsWay(first) : CREDIT_GIFT_WORDS.checking;
    return { gift: view, balance: row.balance_after ?? null, message, repeated: true };
  },

  /** The sender's limits for a new gift: one at a time, and the day's sum and count. Throws 409. No awaits. */
  creditGiftLimitCheck(from, amount, now) {
    const moving = this.sql.exec(`SELECT 1 AS n FROM credit_gifts WHERE from_id = ? AND status IN (${MOVING.map(() => '?').join(', ')}) LIMIT 1`, from, ...MOVING).toArray().length;
    if (moving) throw new RuleError(CREDIT_GIFT_WORDS.busy, 409);
    const today = this.creditGiftsToday(from, now);
    if (today.count >= CREDIT_GIFT.dayCount) throw new RuleError(CREDIT_GIFT_WORDS.count, 409);
    if (today.sum + amount > CREDIT_GIFT.dayMax) throw new RuleError(CREDIT_GIFT_WORDS.daily(CREDIT_GIFT.dayMax - today.sum), 409);
  },

  creditGiftRow(id) {
    return this.sql.exec('SELECT * FROM credit_gifts WHERE id = ?', id).toArray()[0] || null;
  },

  /** Change a gift's own row (status and what came back). No awaits. */
  creditGiftUpdate(id, fields) {
    const sets = Object.keys(fields).map((k) => `${k} = ?`);
    this.write(`UPDATE credit_gifts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...Object.values(fields), Date.now(), id);
  },

  /**
   * A gift whose store credit came off the sender (tx, balanceAfter): on to the friend's. Shopify saying no gives it back
   * to the sender (returnCreditGift); no answer leaves it for staff ('check'). Returns { status, message, balance,
   * refuse } (refuse: a 409 for the sender, nothing moved in the end).
   */
  async giveCreditGift(id, { tx, balanceAfter }) {
    const row = this.creditGiftRow(id);
    this.creditGiftUpdate(id, { status: 'giving', stage: null, take_tx: tx, balance_after: balanceAfter });
    const first = this.creditGiftFirst(row.to_id);
    let gave;
    try {
      gave = await this.shopify.changeStoreCredit(row.to_id, row.amount, row.currency, { timeout: CREDIT_GIFT.timeoutMs });
    } catch (error) {
      if (error?.refused) return this.returnCreditGift(id, error);
      // --- no awaits from here on ---
      console.error('Lair: a store credit gift had no answer going on the friend\'s account', error);
      this.creditGiftUpdate(id, { status: 'check', stage: 'give', message: said(error) });
      this.creditGiftCheckAlert(this.creditGiftRow(id));
      return { status: 'check', message: CREDIT_GIFT_WORDS.onItsWay(first), balance: balanceAfter };
    }
    // --- no awaits from here on ---
    this.creditGiftUpdate(id, { status: 'sent', stage: null, give_tx: gave?.id || null, sent_at: Date.now(), message: null });
    this.creditGiftEmails(this.creditGiftRow(id));
    return { status: 'sent', message: CREDIT_GIFT_WORDS.sent(money(row.amount), first), balance: balanceAfter };
  },

  /** Shopify wouldn't add a gift to the friend's account: it goes back on the sender's. Returns giveCreditGift's shape. */
  async returnCreditGift(id, giveError) {
    const row = this.creditGiftRow(id);
    const first = this.creditGiftFirst(row.to_id);
    this.creditGiftUpdate(id, { status: 'returning', message: said(giveError) });
    let back;
    try {
      back = await this.shopify.changeStoreCredit(row.from_id, row.amount, row.currency, { timeout: CREDIT_GIFT.timeoutMs });
    } catch (error) {
      // --- no awaits from here on ---
      console.error('Lair: a store credit gift could not go back on the sender\'s account', error);
      this.creditGiftUpdate(id, { status: 'check', stage: 'back', message: `${said(giveError)}; back: ${said(error)}` });
      this.creditGiftCheckAlert(this.creditGiftRow(id));
      return { status: 'check', message: CREDIT_GIFT_WORDS.backCheck(first), balance: null };
    }
    // --- no awaits from here on ---
    this.creditGiftUpdate(id, { status: 'returned', stage: null, back_tx: back?.id || null, balance_after: back?.balanceAfter ?? null });
    return { status: 'returned', message: CREDIT_GIFT_WORDS.returned(first), balance: back?.balanceAfter ?? null, refuse: true };
  },

  /* ---------------- emails and staff ---------------- */

  /** A gift that reached the friend: they hear who it's from (and the note), and the sender gets a receipt. Once. No awaits. */
  creditGiftEmails(row) {
    if (!row || row.emailed || !emailReady(this.env)) return;
    this.write('UPDATE credit_gifts SET emailed = 1 WHERE id = ?', row.id);
    const sender = this.memberRow(row.from_id);
    const friend = this.memberRow(row.to_id);
    const fromFirst = this.creditGiftFirst(row.from_id);
    const toFirst = this.creditGiftFirst(row.to_id);
    const amount = money(row.amount);
    const wallet = `${this.page('myLair')}?view=wallet`;
    const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
    const to = (m) => (isEmail(m?.email) ? String(m.email).trim() : isEmail(m?.account_email) ? String(m.account_email).trim() : '');
    if (to(friend)) {
      this.later(this.mail(this.letter(to(friend), `${fromFirst} sent you ${amount} of store credit`, {
        title: `${fromFirst} sent you store credit`,
        intro: [`Kia ora ${toFirst}, ${fromFirst} just sent you ${amount} of Dice Goblin store credit.`, "It's on your account now. Spend it online while you're logged in, or at the counter."],
        quote: row.note || '',
        button: { label: 'See it in My Lair', url: wallet },
      })));
    }
    if (to(sender)) {
      this.later(this.mail(this.letter(to(sender), `You sent ${toFirst} ${amount} of store credit`, {
        title: 'Gift sent!',
        intro: `Kia ora ${fromFirst}, you sent ${toFirst} ${amount} of your store credit. It's on their account now.`,
        details: [['To', this.creditGiftName(row.to_id)], ['Amount', amount], ['Your store credit now', row.balance_after != null ? money(row.balance_after) : '']],
        outro: "Didn't send this? Reply to this email straight away and the team will look into it.",
        button: { label: 'See it in My Lair', url: wallet },
      })));
    }
  },

  /** Staff hear about a gift Shopify didn't confirm, with what to look for and what to tap. Once a day each. No awaits. */
  creditGiftCheckAlert(row) {
    const fromFirst = this.creditGiftFirst(row.from_id);
    const toFirst = this.creditGiftFirst(row.to_id);
    const amount = money(row.amount);
    const time = new Intl.DateTimeFormat('en-NZ', { timeZone: this.rulesCache?.tz || 'Pacific/Auckland', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(row.created_at)).replace(/\s/g, '').toLowerCase();
    const intro = row.stage === 'back'
      ? `${fromFirst} sent ${toFirst} ${amount} of store credit. Shopify wouldn't add it to ${toFirst}'s account, and didn't confirm it went back on ${fromFirst}'s, so it may have. Look at ${fromFirst}'s store credit in Shopify admin: if ${amount} came back on at about ${time}, tap Back on ${fromFirst}'s on ${fromFirst}'s member page, under Store credit. If it didn't, add ${amount} there first, then tap it. Gobgob won't try again by itself.`
      : row.stage === 'take'
        ? `${fromFirst} tried to send ${toFirst} ${amount} of store credit, but Shopify didn't answer, and the Lair can't read ${fromFirst}'s store credit to check. Look at it in Shopify admin: if ${amount} came off at about ${time}, add ${amount} to ${toFirst}'s store credit on their member page and tap ${toFirst} has it. If nothing came off, tap Nothing came off.`
        : `${fromFirst} sent ${toFirst} ${amount} of store credit. It came off ${fromFirst}'s store credit, but Shopify didn't confirm it reached ${toFirst}, so it may have. Look at ${toFirst}'s store credit in Shopify admin: if ${amount} came on at about ${time}, tap ${toFirst} has it on ${toFirst}'s member page, under Store credit. If it didn't, add ${amount} there first, then tap it. Gobgob won't try again by itself, so it's never sent twice.`;
    this.staffAlert(`credit-gift-check:${row.id}`, `Check a store credit gift: ${fromFirst} to ${toFirst}`, {
      title: 'Did the store credit gift go through?',
      intro,
      details: [['From', this.creditGiftName(row.from_id)], ['To', this.creditGiftName(row.to_id)], ['Amount', amount], ['Shopify said', row.message || 'no answer']],
    });
  },

  /**
   * POST /credit-gifts/:id/settle { outcome } (staff with Money): what happened to a gift waiting to be checked, as staff
   * found it in Shopify admin: 'sent' (it's on the friend's store credit, there or added by hand: they're emailed),
   * 'returned' (it's back on the sender's) or 'failed' (nothing came off the sender). Nothing moves here. Returns
   * { gift } (creditGiftStaffView). No awaits.
   */
  settleCreditGift(id, input, who) {
    this.requireStaff(who, 'money');
    const outcome = String(input?.outcome ?? '');
    if (!['sent', 'returned', 'failed'].includes(outcome)) throw new RuleError(CREDIT_GIFT_WORDS.outcome);
    const row = this.creditGiftRow(String(id || '').slice(0, 40));
    if (!row) throw new RuleError('No gift with that ID.', 404);
    if (row.status !== 'check') throw new RuleError(CREDIT_GIFT_WORDS.notCheck, 409);
    const now = Date.now();
    this.creditGiftUpdate(row.id, {
      status: outcome, stage: null, settled_by: who.customerId ? `staff:${who.customerId}` : 'staff', settled_at: now, ...(outcome === 'sent' ? { sent_at: now } : {}),
    });
    if (outcome === 'sent') this.creditGiftEmails(this.creditGiftRow(row.id));
    return { gift: this.creditGiftStaffView(this.creditGiftRow(row.id)) };
  },

  /* ---------------- the 10-minute run ---------------- */

  /**
   * The 10-minute run: a gift left mid-way by a restart counts as an answer lost; a gift whose answer was lost while it
   * came off is looked for in the sender's store credit (found: it goes on to the friend's; not there after
   * CREDIT_GIFT.goneAfter: it didn't come off, nothing moved; Shopify unreadable for CREDIT_GIFT.askAfter: staff look).
   * Returns { looked, sent?, failed?, returned?, check? } when it looked at any, else null.
   */
  async creditGiftUpkeep(now = Date.now()) {
    if (!this.shopify?.configured) return null;
    const out = { looked: 0 };
    const add = (key) => {
      out[key] = (out[key] || 0) + 1;
    };
    // left mid-way by a restart: taking is looked for like a lost answer; giving or returning goes to staff
    for (const row of this.sql.exec("SELECT * FROM credit_gifts WHERE status IN ('taking', 'giving', 'returning') AND updated_at < ? LIMIT ?", now - CREDIT_GIFT.stale, CREDIT_GIFT.perRun).toArray()) {
      if (row.status === 'taking') this.creditGiftUpdate(row.id, { status: 'checking', stage: 'take', message: 'no answer (the Lair restarted)' });
      else {
        this.creditGiftUpdate(row.id, { status: 'check', stage: row.status === 'giving' ? 'give' : 'back', message: 'no answer (the Lair restarted)' });
        this.creditGiftCheckAlert(this.creditGiftRow(row.id));
        add('check');
      }
    }
    const waiting = this.sql.exec("SELECT * FROM credit_gifts WHERE status = 'checking' AND created_at <= ? ORDER BY created_at LIMIT ?", now - CREDIT_GIFT.lookAfter, CREDIT_GIFT.perRun).toArray();
    for (const row of waiting) {
      out.looked += 1;
      let debits = null;
      try {
        debits = await this.shopify.storeCreditDebits(row.from_id, row.currency);
      } catch (error) {
        console.error('Lair: could not read store credit for a gift', error);
      }
      // --- no awaits from here on (for this one, until it goes on to the friend's) ---
      const fresh = this.creditGiftRow(row.id);
      if (!fresh || fresh.status !== 'checking') continue;
      const at = Date.now();
      if (!debits) {
        if (at - fresh.created_at >= CREDIT_GIFT.askAfter) {
          this.creditGiftUpdate(fresh.id, { status: 'check', stage: 'take' });
          this.creditGiftCheckAlert(this.creditGiftRow(fresh.id));
          add('check');
        }
        continue;
      }
      // a debit of this amount, taken by an app (not spent on an order) while it was with Shopify, that isn't anything
      // else the Lair took
      const known = new Set([
        ...this.sql.exec('SELECT transaction_id AS id FROM member_credit WHERE transaction_id IS NOT NULL').toArray(),
        ...this.sql.exec('SELECT transaction_id AS id FROM damage_payments WHERE transaction_id IS NOT NULL').toArray(),
        ...this.sql.exec('SELECT take_tx AS id FROM credit_gifts WHERE take_tx IS NOT NULL').toArray(),
      ].map((r) => r.id));
      const match = debits
        .filter((d) => d.id && !d.fromOrder && d.amount === fresh.amount && !known.has(d.id)
          && d.createdAt >= fresh.created_at - CREDIT_GIFT.skew && d.createdAt <= fresh.created_at + CREDIT_GIFT.goneAfter)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (match) {
        const done = await this.giveCreditGift(fresh.id, { tx: match.id, balanceAfter: match.balanceAfter ?? null });
        add(done.status);
        continue;
      }
      if (at - fresh.created_at >= CREDIT_GIFT.goneAfter) {
        this.creditGiftUpdate(fresh.id, { status: 'failed', stage: null, message: CREDIT_GIFT_WORDS.gone });
        add('failed');
      }
    }
    return out.looked || out.check ? out : null;
  },
};

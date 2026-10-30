/**
 * Round 22 (28 Oct 2026, contract v22-stamps): stamps that follow payment, sessions rung up by hand at the counter, and
 * stamps staff add. From Mo, 28 Oct 2026: "When someone pays for his sessions it doesn't add a new stamp", "each session
 * for DND sessions or table session added manually should be added as well" and "give the staff [a way] to add a stamp
 * on the area for the stamps".
 *
 * Paid sessions. Until now a session only stamped once it was checked in, so one paid but never scanned in (an owed seat
 * paid at a later visit, several paid at once, a bill paid online) never stamped. Now a table booking, game table, TTRPG
 * seat or event sign-up stamps once it's checked in, or once it's paid in full and its day has come (Lair time). Paid
 * ahead for a later date, its stamps land on that day: by then it's locked in, so only staff can take it off. No-shows,
 * cancellations and holds never stamp. As before nothing is stored: a session cancelled or marked a no-show afterwards
 * takes its stamps back, and one both paid and checked in stamps once. (bookingStamps and joinStamps, below, are the one
 * place that says so: the card, its list of stamped sessions and a GM's own-session stamp all read them.)
 *
 * No account on it. A session nobody's account is on (a guest's, a walk-in, a booking staff made for someone) stamps
 * whoever paid for it (Mo, Oct 2026: "if that person has no account the payer gets it"): the customer on its first
 * payment that had one, as if they'd booked it. Scanning someone's member code before they pay is what puts them on the
 * sale. Once the session joins an account (a guest logs in with its email), it's that account's.
 *
 * The stamp ledger (loyalty_stamps): stamps that don't come from a Lair booking, one row each time.
 *  - 'sale': a session product rung up at the counter: a line whose SKU starts LAIR-SESSION (the Session product's Day
 *    Pass, TCG League, RPG Session and RPG Kids Session) on a paid counter sale (Shopify POS's own, or Pay on Verifone's:
 *    src/counter.js). One stamp a unit, for the sale's customer, made once per order, line and unit however often
 *    Shopify sends the order. A sale with nobody on it stamps nobody, which is why scanning someone's code at the
 *    counter puts them on the sale straight away. A day's sales and its Lair sessions are the same sessions: the card
 *    counts whichever has more (stampTally in lair.js).
 *  - 'staff': stamps added by hand, at the counter (one a tap) or on a member's page (1 to 10), with who added them and
 *    a note. Each request carries its own key, so a double tap or a retry adds nothing more. After round 22's review: a
 *    helper never adds to their own card; the counter and helpers without Members add one at a time, two a member a day
 *    between them; the counter takes back only its own.
 * Undo takes a row back (undone_at, undone_by): it stays for the record and stops counting.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { LairTime, RuleError, addDays, makeId } from './core.js';

/** The ledger's table and indexes (made when missing) */
export const STAMP_TABLES = [
  `CREATE TABLE IF NOT EXISTS loyalty_stamps (
     id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL, title TEXT, note TEXT,
     order_id TEXT, order_name TEXT, line_id TEXT, unit INTEGER, key TEXT, at INTEGER NOT NULL, created_by TEXT,
     created_at INTEGER NOT NULL, undone_at INTEGER, undone_by TEXT)`,
  'CREATE INDEX IF NOT EXISTS loyalty_stamps_customer ON loyalty_stamps (customer_id, at)',
  // a sale's unit is stamped once, however often Shopify sends the order
  'CREATE UNIQUE INDEX IF NOT EXISTS loyalty_stamps_sale ON loyalty_stamps (order_id, line_id, unit) WHERE order_id IS NOT NULL',
  // a request's own key: a repeat (a double tap, a retry) gives back the first and adds nothing
  'CREATE UNIQUE INDEX IF NOT EXISTS loyalty_stamps_key ON loyalty_stamps (key) WHERE key IS NOT NULL',
  // a session with no account on it stamps whoever paid for it: their payments, found by who made them
  'CREATE INDEX IF NOT EXISTS payments_customer ON payments (customer_id, kind)',
];

export const STAMPS = Object.freeze({
  // a product whose SKU starts like this is a session: each one rung up at the counter is a stamp for the sale's customer
  sessionSku: /^LAIR-SESSION(?:-[A-Z0-9]+)*$/i,
  // the most stamps one order line gives (so a mistyped quantity can't fill a card)
  perLine: 10,
  // the most stamps staff add at once on a member's page (the counter adds one a tap)
  staffMax: 10,
  // (after round 22's review) the most stamps the counter and helpers without Members (the check-in card) add to one
  // member in a Lair day, between them: one a tap, for a session the Lair app doesn't know about. The main account and
  // helpers with Members add more on the staff page, under Members.
  byHandDaily: 2,
  // the ledger rows a member's page lists, newest first
  listed: 20,
});

/** Every message the counter and the staff page can see, word for word in the contract */
export const STAMP_WORDS = {
  count: `Add between 1 and ${STAMPS.staffMax} stamps.`,
  noMember: "There's no loyalty card for them yet: they need a Dice Goblin account. Scan the member code in their My Lair.",
  badKey: "That tap didn't come through properly. Try again.",
  notFound: "That stamp isn't on their card any more. Scan their code again.",
  notTheirs: "That stamp is on someone else's card. Scan their code again.",
  notHere: "That stamp didn't come from the counter, so take it back on the staff page, under Members.",
  // (after round 22's review) a helper's own card, more than one at once without Members, and the daily limit
  ownCard: "You can't add stamps to your own card. Ask the main account.",
  oneAtATime: 'More than one stamp at a time needs the Members permission. Ask the main account to tick it on the Team tab.',
  daily: `That's ${STAMPS.byHandDaily} stamps added at the counter or check-in for them today. Any more go on the staff page, under Members.`,
  // what My Lair's Wallet calls a stamp from the ledger
  staffTitle: 'A stamp from Gobgob',
  saleTitle: 'A session at the counter',
};

/**
 * Whether a booking's people earn stamps (alias b): checked in ('seated', or 'done' once they've left), or paid in full
 * once its day has come. One bound value: when today ends (stampsUntil).
 * @param {string} b
 */
export const bookingStamps = (b) => `(${b}.status IN ('seated', 'done') OR (${b}.status = 'confirmed' AND ${b}.paid = 1 AND ${b}.starts_at < ?))`;

/** The same for an event sign-up (alias j): 'attended', or paid in full once its day has come. One bound value. */
export const joinStamps = (j) => `(${j}.status = 'attended' OR (${j}.status = 'confirmed' AND ${j}.paid = 1 AND ${j}.starts_at < ?))`;

/** Why a booking that stamps (alias b) does: 'here' (checked in) or 'paid' (paid, not checked in). No bound values. */
export const bookingVia = (b) => `(CASE WHEN ${b}.status IN ('seated', 'done') THEN 'here' ELSE 'paid' END)`;

/** The same for an event sign-up (alias j). No bound values. */
export const joinVia = (j) => `(CASE WHEN ${j}.status = 'attended' THEN 'here' ELSE 'paid' END)`;

/** The customer number at the end of a Shopify id ("gid://shopify/Customer/123" or 123), or null */
const customerNumber = (value) => String(value ?? '').match(/(\d{1,20})$/)?.[1] || null;
const trimmed = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * The session products on an order's lines (round 22): each line whose SKU starts LAIR-SESSION, as
 * [{ lineId, title, quantity }]. title: the variant's name when it has one ("RPG Session", "Dice Goblin Day Pass"),
 * else the product's; quantity: its units, up to STAMPS.perLine. No awaits.
 * @param {{ line_items?: any[] }} order
 */
export function sessionLines(order) {
  const lines = [];
  (order?.line_items || []).forEach((item, index) => {
    if (!STAMPS.sessionSku.test(String(item?.sku ?? '').trim())) return;
    const quantity = Math.min(STAMPS.perLine, Math.max(0, Math.floor(Number(item.quantity ?? 1)) || 0));
    if (!quantity) return;
    const variant = String(item.variant_title ?? '').trim();
    const title = /[a-z]/i.test(variant) && variant !== 'Default Title' ? variant : String(item.title ?? item.name ?? '').trim();
    lines.push({ lineId: String(item.id ?? item.admin_graphql_api_id ?? `line-${index}`), title: title.slice(0, 120) || STAMP_WORDS.saleTitle, quantity });
  });
  return lines;
}

export const stampMethods = {
  /** When today ends, Lair time: a paid session stamps from its day on (bookingStamps' bound value). No awaits. */
  stampsUntil(now = Date.now()) {
    const time = new LairTime(this.rulesCache?.tz || 'Pacific/Auckland');
    return time.at(addDays(time.key(now), 1), 0);
  },

  /**
   * A card as the counter shows it: { stamps, cardSize, rollsAvailable, card }, or null for nobody. Round 24: and
   * rollsWaiting, a welcome code's rolls waiting for their first paid session, only while some do. No awaits.
   */
  posLoyalty(customerId, rules = this.rulesCache) {
    if (!customerId) return null;
    const card = this.loyaltyOf(customerId, rules);
    return {
      stamps: card.stamps, cardSize: card.cardSize, rollsAvailable: card.rolls.available, card: card.card,
      ...(card.rolls.waiting ? { rollsWaiting: card.rolls.waiting } : {}),
    };
  },

  /**
   * Stamps for session products rung up at the counter (ordersPaid, round 22): one for each unit of each line, for the
   * order's customer, made once per order, line and unit. Returns how many were made. No awaits.
   * @param {string} orderId
   * @param {{ lineId: string, title: string, quantity: number }[]} lines sessionLines
   * @param {unknown} customer the order's customer (an id, or a gid)
   */
  stampSessionSales(orderId, lines, customer, { orderName = null, now = Date.now() } = {}) {
    const customerId = customerNumber(customer);
    if (!orderId || !customerId || !lines?.length) return 0;
    let made = 0;
    for (const line of lines) {
      for (let unit = 0; unit < line.quantity; unit += 1) {
        if (this.sql.exec('SELECT 1 AS n FROM loyalty_stamps WHERE order_id = ? AND line_id = ? AND unit = ?', orderId, line.lineId, unit).toArray().length) continue;
        this.write(
          `INSERT INTO loyalty_stamps (id, customer_id, kind, count, title, note, order_id, order_name, line_id, unit, key, at, created_by, created_at)
           VALUES (?, ?, 'sale', 1, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?)`,
          makeId('st'), customerId, line.title, orderId, orderName || null, line.lineId, unit, now, `order:${orderName || orderId}`, now,
        );
        made += 1;
      }
    }
    return made;
  },

  /**
   * Stamps staff add by hand to a member's card ({ count, note?, key? }): one ledger row of `count` stamps (1 to
   * STAMPS.staffMax). key (8 to 64 letters, numbers, dashes or underscores) makes the request safe to repeat: the same
   * key again gives back the first row and adds nothing. limited (the counter, and helpers without Members): no more
   * than STAMPS.byHandDaily stamps on them this Lair day from the counter ('pos:…') and helpers without Members
   * ('checkin:…'). Returns { row, repeated }. No awaits.
   */
  addStamps(customerId, input, by, now = Date.now(), { limited = false } = {}) {
    const id = trimmed(customerId, 40);
    if (!/^\d{1,20}$/.test(id) || !this.memberRow(id)) throw new RuleError(STAMP_WORDS.noMember, 404);
    const count = Number(input?.count ?? 1);
    if (!Number.isInteger(count) || count < 1 || count > STAMPS.staffMax) throw new RuleError(STAMP_WORDS.count);
    const key = input?.key == null || input.key === '' ? null : String(input.key);
    if (key !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new RuleError(STAMP_WORDS.badKey);
    if (key) {
      const first = this.sql.exec('SELECT * FROM loyalty_stamps WHERE key = ?', key).toArray()[0];
      if (first && first.customer_id !== id) throw new RuleError(STAMP_WORDS.notTheirs, 409);
      if (first) return { row: first, repeated: true };
    }
    if (limited) {
      const time = new LairTime(this.rulesCache?.tz || 'Pacific/Auckland');
      const today = this.sql
        .exec(
          `SELECT COALESCE(SUM(count), 0) AS n FROM loyalty_stamps
            WHERE customer_id = ? AND kind = 'staff' AND undone_at IS NULL AND at >= ? AND (created_by LIKE 'pos%' OR created_by LIKE 'checkin:%')`,
          id, time.at(time.key(now), 0),
        )
        .one().n;
      if (today + count > STAMPS.byHandDaily) throw new RuleError(STAMP_WORDS.daily, 409);
    }
    const stampId = makeId('st');
    this.write(
      `INSERT INTO loyalty_stamps (id, customer_id, kind, count, title, note, order_id, order_name, line_id, unit, key, at, created_by, created_at)
       VALUES (?, ?, 'staff', ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
      stampId, id, count, STAMP_WORDS.staffTitle, trimmed(input?.note, 200) || null, key, now, by || 'staff', now,
    );
    return { row: this.sql.exec('SELECT * FROM loyalty_stamps WHERE id = ?', stampId).toArray()[0], repeated: false };
  },

  /**
   * Takes a ledger row back (Undo): it stays for the record and stops counting. Taking back one already taken back does
   * nothing more. kinds: which rows this caller may take back; madeBy: whose (the counter: only stamps it added by hand).
   * Returns { row, already }. No awaits.
   */
  undoStamp(customerId, stampId, by, { kinds = ['staff', 'sale'], madeBy = null, now = Date.now() } = {}) {
    const row = stampId ? this.sql.exec('SELECT * FROM loyalty_stamps WHERE id = ?', trimmed(stampId, 64)).toArray()[0] : null;
    if (!row) throw new RuleError(STAMP_WORDS.notFound, 404);
    if (row.customer_id !== trimmed(customerId, 40)) throw new RuleError(STAMP_WORDS.notTheirs, 409);
    if (!kinds.includes(row.kind) || (madeBy && !madeBy.test(String(row.created_by || '')))) throw new RuleError(STAMP_WORDS.notHere, 409);
    if (row.undone_at) return { row, already: true };
    this.write('UPDATE loyalty_stamps SET undone_at = ?, undone_by = ? WHERE id = ? AND undone_at IS NULL', now, by || 'staff', row.id);
    return { row: this.sql.exec('SELECT * FROM loyalty_stamps WHERE id = ?', row.id).toArray()[0], already: false };
  },

  /**
   * A ledger row as staff see it: { id, kind ('staff' or 'sale'), count, at, title, note, addedBy, orderName, undoneAt,
   * undoneBy }. addedBy and undoneBy: a team member's first name, 'the counter' (the POS) or null. No awaits.
   */
  stampView(row) {
    const who = (by) => {
      const text = String(by || '');
      if (text.startsWith('pos:')) return 'the counter';
      // staff:<id> on a member's page (or the main account anywhere), checkin:<id> a helper without Members (the check-in card)
      const staff = text.match(/^(?:staff|checkin):(\d{1,20})$/)?.[1];
      if (!staff) return null;
      const member = this.memberRow(staff);
      return member?.first_name || String(member?.name || '').split(/\s+/)[0] || null;
    };
    return {
      id: row.id, kind: row.kind, count: row.count, at: row.at, title: row.title || (row.kind === 'sale' ? STAMP_WORDS.saleTitle : STAMP_WORDS.staffTitle),
      note: row.note || '', addedBy: row.kind === 'sale' ? null : who(row.created_by), orderName: row.order_name || null,
      undoneAt: row.undone_at || null, undoneBy: row.undone_at ? who(row.undone_by) : null,
    };
  },

  /** A member's ledger for their staff page: the last STAMPS.listed rows, newest first, taken back ones too. No awaits. */
  stampLedger(customerId) {
    return this.sql
      .exec('SELECT * FROM loyalty_stamps WHERE customer_id = ? ORDER BY at DESC, rowid DESC LIMIT ?', String(customerId), STAMPS.listed)
      .toArray()
      .map((row) => this.stampView(row));
  },

  /** A member as the staff page lists them, with their ledger (the stamp routes' answer). No awaits. */
  memberWithStamps(customerId, rules, now = Date.now()) {
    const member = this.memberListItem(customerId, rules, now);
    return member ? { ...member, stamps: this.stampLedger(customerId) } : null;
  },

  /* ---------------- the counter (the POS extension) ---------------- */

  /**
   * POST /pos/stamp { customerId, key, note? }: a stamp on their card from the counter, one a tap, up to
   * STAMPS.byHandDaily a member a day. The same key again (a retry after a lost answer) adds nothing more. Returns
   * { stamp, repeated, loyalty }.
   */
  async posStamp(input, by = 'pos') {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const { row, repeated } = this.addStamps(input?.customerId, { count: 1, note: input?.note, key: input?.key }, by, Date.now(), { limited: true });
    return { stamp: this.stampView(row), repeated, loyalty: this.posLoyalty(row.customer_id, rules) };
  },

  /** POST /pos/stamp-undo { customerId, id }: takes back a stamp the counter added. Returns { stamp, already, loyalty }. */
  async posStampUndo(input, by = 'pos') {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const { row, already } = this.undoStamp(input?.customerId, input?.id, by, { kinds: ['staff'], madeBy: /^pos(?::|$)/ });
    return { stamp: this.stampView(row), already, loyalty: this.posLoyalty(row.customer_id, rules) };
  },

  /* ---------------- a member's page (the staff page) ---------------- */

  /**
   * POST /members/:customerId/stamps { count, note?, key? } (staff with Check-in or Members): 1 to 10 stamps on their
   * card. After round 22's review: a helper never adds stamps to their own card, and one without Members (the check-in
   * card) adds one at a time, up to STAMPS.byHandDaily a member a day, as the counter does. Returns { member } (as
   * GET /members lists them, plus stamps: their ledger) and repeated.
   */
  async giveStamps(customerId, input, who) {
    this.requireStaff(who, ['checkin', 'members']);
    if (who.role === 'helper' && who.customerId && String(who.customerId) === trimmed(customerId, 40)) throw new RuleError(STAMP_WORDS.ownCard, 403);
    const members = this.can(who, 'members');
    const count = Number(input?.count ?? 1);
    if (!members && Number.isInteger(count) && count > 1) throw new RuleError(STAMP_WORDS.oneAtATime, 403);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const by = who.customerId ? `${members ? 'staff' : 'checkin'}:${who.customerId}` : 'staff';
    const { row, repeated } = this.addStamps(customerId, input, by, Date.now(), { limited: !members });
    return { member: this.memberWithStamps(row.customer_id, rules), stamp: this.stampView(row), repeated };
  },

  /**
   * POST /members/:customerId/stamps/:id/undo (staff with Check-in or Members): takes back stamps added by hand or rung up
   * at the counter. Returns { member, stamp, already }.
   */
  async takeBackStamp(customerId, stampId, who) {
    this.requireStaff(who, ['checkin', 'members']);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const { row, already } = this.undoStamp(customerId, stampId, who.customerId ? `staff:${who.customerId}` : 'staff');
    return { member: this.memberWithStamps(row.customer_id, rules), stamp: this.stampView(row), already };
  },
};

// Round 44 (17 Nov 2026, contract docs/contracts/lair-api-contract-v44-library-hold.md): library copies bought online
// are held. From the website review: library copies ("(Library)" at the end of the title, custom.library_code) are on
// the Online Store, so anyone with a cart link can buy one, and 163 are still $0. Members may buy a library copy they've
// borrowed at 20% off from My Library (Mo, 2 Nov 2026: decided, not built yet). Any other order with a library copy must
// never be posted out or handed over by mistake, and a $0 library copy is always held, even for a member.
//
// These are methods of the Lair Durable Object (src/lair.js mixes them in with Object.assign(Lair.prototype, …)).
// - ordersPaid (src/lair.js) calls libraryHoldPaid for every paid order once its customer is known (orderSpend). Not a
//   counter sale (staff hand those over in person, and the till refuses library codes). Shopify says which lines are
//   library copies (libraryProducts); if it can't, a line that looks like one counts. A member's own purchase is worked
//   out from the Lair's loans, never from the order, so a cart link can't pass for one.
// - The order is kept once (library_order_holds), then in the background: Shopify's fulfilment hold, the tag "Library
//   copy" with a line on the note, and one email to staff (STAFF_EMAIL; LIBRARY_HOLD_EMAILS = off stops it).
// - The 10-minute run (libraryHoldUpkeep) finishes what a restart or Shopify cut short, for a day.
import { MIN, HOUR } from './core.js';
import { emailReady } from './shopify.js';

export const LIBRARY_HOLD = Object.freeze({
  // the order's tag, and the handle on Shopify's fulfilment hold (so it's the Lair's, and never placed twice)
  tag: 'Library copy',
  handle: 'lair-library-copy',
  // the 10-minute run keeps trying a hold, tag or email this long after the order
  retryForMs: 24 * HOUR,
  // a follow-up under way is left alone this long by any other run
  claimMs: 5 * MIN,
  // the most lines one order's check looks at, and held orders one run follows up
  mostLines: 50,
  batch: 20,
});

/** A library copy's title ends "(Library)" */
const LIBRARY_TITLE = /\(\s*library\s*\)\s*$/i;

const money = (cents) => `$${(Math.max(0, Number(cents) || 0) / 100).toFixed(2)}`;
const gameText = (l) => `${l.title}${l.code ? ` (${l.code})` : ''}`;
const listText = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** Every word staff read, word for word in the contract (section 3) */
export const LIBRARY_HOLD_WORDS = {
  subject: (name) => `Don't send order ${name}: it has a library copy`,
  title: 'A library copy was bought online',
  introHeld: (name) => `Order ${name} has a library copy in it, so Gobgob has put it on hold in Shopify. Don't post it or hand it over.`,
  introNotHeld: (name) => `Order ${name} has a library copy in it. Shopify wouldn't let Gobgob put it on hold, so it's tagged ${LIBRARY_HOLD.tag}. Don't post it or hand it over.`,
  why: { free: 'a $0 library copy', notTheirs: 'not a game they have on loan' },
  line: (l) => `${l.quantity > 1 ? `${l.quantity} × ` : ''}${gameText(l)}: ${money(l.each)}${l.quantity > 1 ? ' each' : ''}, ${LIBRARY_HOLD_WORDS.why[l.why] || LIBRARY_HOLD_WORDS.why.notTheirs}`,
  note: (lines) => `${lines.length > 1 ? 'Library copies' : 'Library copy'} in this order: ${listText(lines.map(gameText))}. Don't post it or hand it over. Refund or cancel unless there's a good reason.`,
  orderRow: 'Order',
  lineRow: 'Library copy',
  customerRow: 'Customer',
  notMember: 'Not a Lair member',
  noCustomer: 'No customer on the order',
  outro: [
    "What to do: refund or cancel it in Shopify, and let them know library copies aren't for sale online.",
    "Only keep it if there's a good reason, like a member buying a game they've borrowed. Then release the hold in Shopify (Orders, the order, Release hold) before you send it.",
  ],
};

export const LIBRARY_HOLD_TABLES = [
  `CREATE TABLE IF NOT EXISTS library_order_holds (
    order_id TEXT PRIMARY KEY, order_name TEXT, customer_id TEXT, lines TEXT NOT NULL, created_at INTEGER NOT NULL,
    held_at INTEGER, hold_note TEXT, hold_tries INTEGER NOT NULL DEFAULT 0, tagged_at INTEGER, mailed_at INTEGER, tried_at INTEGER)`,
  'CREATE INDEX IF NOT EXISTS library_order_holds_open ON library_order_holds (created_at)',
];

const units = (q) => Math.max(0, Math.floor(Number(q ?? 1)) || 0);
const numberOf = (id) => (id === null || id === undefined || id === '' ? '' : String(id).split('/').pop());
const cents = (value) => Math.round(Number(value || 0) * 100) || 0;
/** What one unit of a line paid, in cents, after the line's discounts */
const eachPaid = (item) => {
  const quantity = units(item.quantity);
  if (!quantity) return 0;
  const discounts = (item.discount_allocations || []).reduce((sum, d) => sum + cents(d.amount ?? d.amount_set?.shop_money?.amount), 0);
  return Math.max(0, Math.round((cents(item.price ?? item.price_set?.shop_money?.amount) * quantity - discounts) / quantity));
};
const parseLines = (text) => {
  try {
    const lines = JSON.parse(text || '[]');
    return Array.isArray(lines) ? lines : [];
  } catch {
    return [];
  }
};

export const libraryHoldMethods = {
  /**
   * orders/paid: hold this order when it has a library copy that isn't the buyer's own My Library purchase (contract
   * section 1). Its awaits first (Shopify's answer on the products), then its writes. Never throws. → { lines } (the
   * library copy lines held), or null.
   */
  async libraryHoldPaid(order, orderId, { pos = false, spend = null } = {}) {
    if (pos || !orderId) return null;
    if (this.libraryHoldRow(orderId)) return null;
    const withProduct = (order?.line_items || []).filter((item) => numberOf(item.product_id) && numberOf(item.variant_id) && units(item.quantity) > 0).slice(0, LIBRARY_HOLD.mostLines);
    if (!withProduct.length) return null;
    const variants = [...new Set(withProduct.map((item) => numberOf(item.variant_id)))];
    const known = new Map(
      this.sql.exec(`SELECT variant_id, title, shelf_code FROM library_games WHERE variant_id IN (${variants.map(() => '?').join(', ')})`, ...variants)
        .toArray().map((g) => [String(g.variant_id), g]),
    );
    const maybe = withProduct.filter((item) => LIBRARY_TITLE.test(String(item.title || '')) || known.has(numberOf(item.variant_id)));
    if (!maybe.length) return null;
    let products = null;
    try {
      products = await this.shopify.libraryProducts([...new Set(maybe.map((item) => numberOf(item.product_id)))]);
    } catch (error) {
      // holding by mistake costs a click; posting by mistake costs a game
      console.error('Lair: Shopify would not say whether an order has library copies; holding what looks like one', orderId, String(error?.message || error).slice(0, 200));
    }
    // --- no awaits from here on ---
    if (this.libraryHoldRow(orderId)) return null; // another delivery of the webhook got here first
    const copies = [];
    for (const item of maybe) {
      const product = products?.get(numberOf(item.product_id));
      // Shopify answered about this product: it's a library copy only with both the title and the code
      if (product && !(LIBRARY_TITLE.test(product.title) && product.libraryCode)) continue;
      const game = known.get(numberOf(item.variant_id));
      const title = String(product?.title || item.title || game?.title || 'Library copy').replace(LIBRARY_TITLE, '').trim() || 'Library copy';
      const code = String(product?.libraryCode || game?.shelf_code || item.sku || '').trim().toUpperCase().slice(0, 20);
      copies.push({ item, variantId: numberOf(item.variant_id), title: title.slice(0, 160), code, quantity: units(item.quantity), each: eachPaid(item) });
    }
    if (!copies.length) return null;
    // A member's own My Library purchase: the order's customer has that game at home, as many copies as they're buying
    const customerId = numberOf(spend?.customerId || order?.customer?.id) || null;
    const home = new Map();
    if (customerId) {
      for (const r of this.sql.exec("SELECT variant_id, COUNT(*) AS n FROM library_loans WHERE customer_id = ? AND status = 'out' GROUP BY variant_id", customerId).toArray()) {
        home.set(String(r.variant_id), Number(r.n) || 0);
      }
    }
    const buying = new Map();
    for (const c of copies) buying.set(c.variantId, (buying.get(c.variantId) || 0) + c.quantity);
    const held = [];
    for (const c of copies) {
      const free = cents(c.item.price ?? c.item.price_set?.shop_money?.amount) <= 0 || c.each <= 0;
      const theirs = (home.get(c.variantId) || 0) >= buying.get(c.variantId);
      if (!free && theirs) continue;
      held.push({ title: c.title, code: c.code, quantity: c.quantity, each: c.each, why: free ? 'free' : 'notTheirs' });
    }
    if (!held.length) return null;
    const now = Date.now();
    this.write(
      'INSERT OR IGNORE INTO library_order_holds (order_id, order_name, customer_id, lines, created_at) VALUES (?, ?, ?, ?, ?)',
      orderId, String(spend?.name || order?.name || '').slice(0, 40) || null, customerId, JSON.stringify(held), now,
    );
    this.later(this.libraryHoldFollowUp(orderId, now));
    return { lines: held.length };
  },

  /** A held order's row, or undefined */
  libraryHoldRow(orderId) {
    return this.sql.exec('SELECT * FROM library_order_holds WHERE order_id = ?', orderId).toArray()[0];
  },

  /** Whether the staff email is wanted: emails set up, a staff address, and LIBRARY_HOLD_EMAILS isn't off */
  libraryHoldMailOn() {
    return String(this.env?.LIBRARY_HOLD_EMAILS || '').trim().toLowerCase() !== 'off' && emailReady(this.env) && Boolean(this.env.STAFF_EMAIL);
  },

  /**
   * What's still to do for a held order (contract section 2): Shopify's hold, the tag and note, then the staff email
   * once the hold has been tried. Each step on its own, so one failing never stops the others. Never throws.
   * → { held, tagged, mailed } (what this run did: 0 or 1 each)
   */
  async libraryHoldFollowUp(orderId, now = Date.now()) {
    const done = { held: 0, tagged: 0, mailed: 0 };
    const row = this.libraryHoldRow(orderId);
    if (!row) return done;
    this.write('UPDATE library_order_holds SET tried_at = ? WHERE order_id = ?', now, orderId);
    const lines = parseLines(row.lines);
    const note = LIBRARY_HOLD_WORDS.note(lines);
    if (!row.held_at) {
      try {
        const result = await this.shopify.holdOrderFulfilment(orderId, { handle: LIBRARY_HOLD.handle, reasonNotes: note });
        if (Number(result?.held) > 0) {
          this.write('UPDATE library_order_holds SET held_at = ?, hold_note = NULL, hold_tries = hold_tries + 1 WHERE order_id = ?', Date.now(), orderId);
          done.held = 1;
        } else {
          this.write("UPDATE library_order_holds SET hold_note = 'Nothing in Shopify to hold', hold_tries = hold_tries + 1 WHERE order_id = ?", orderId);
        }
      } catch (error) {
        console.error('Lair: could not hold an order with a library copy', orderId, String(error?.message || error).slice(0, 200));
        this.write('UPDATE library_order_holds SET hold_note = ?, hold_tries = hold_tries + 1 WHERE order_id = ?', String(error?.message || error).slice(0, 300), orderId);
      }
    }
    if (!row.tagged_at) {
      try {
        await this.shopify.gwMarkOrder(orderId, LIBRARY_HOLD.tag, note);
        this.write('UPDATE library_order_holds SET tagged_at = ? WHERE order_id = ?', Date.now(), orderId);
        done.tagged = 1;
      } catch (error) {
        console.error('Lair: could not tag an order with a library copy', orderId, String(error?.message || error).slice(0, 200));
      }
    }
    if (!row.mailed_at && this.libraryHoldMailOn()) {
      const fresh = this.libraryHoldRow(orderId);
      const name = fresh.order_name || `#${numberOf(orderId)}`;
      const W = LIBRARY_HOLD_WORDS;
      const member = fresh.customer_id ? this.memberRow(fresh.customer_id) : null;
      const sent = await this.mail(this.letter(this.env.STAFF_EMAIL, W.subject(name), {
        title: W.title,
        intro: fresh.held_at ? W.introHeld(name) : W.introNotHeld(name),
        details: [
          [W.orderRow, name],
          ...lines.map((l, i) => [i === 0 ? W.lineRow : '', W.line(l)]),
          [W.customerRow, !fresh.customer_id ? W.noCustomer : member?.name || W.notMember],
        ],
        outro: W.outro,
        button: { label: 'Open the staff page', url: this.page('staff') },
        signoff: 'Gobgob, keeping an eye on the Lair',
      }, { idempotencyKey: `library-hold-${numberOf(orderId)}` }));
      if (sent?.ok) {
        this.write('UPDATE library_order_holds SET mailed_at = ? WHERE order_id = ?', Date.now(), orderId);
        done.mailed = 1;
      }
    }
    return done;
  },

  /**
   * The 10-minute run: held orders from the last day with a hold, tag or email still to do, not followed up in the last
   * few minutes. → { held, tagged, mailed } (what it did), or null when there was nothing to look at.
   */
  async libraryHoldUpkeep(now = Date.now()) {
    const mailOn = this.libraryHoldMailOn() ? 1 : 0;
    const due = this.sql.exec(
      `SELECT order_id FROM library_order_holds WHERE created_at > ? AND (tried_at IS NULL OR tried_at <= ?)
         AND (held_at IS NULL OR tagged_at IS NULL OR (mailed_at IS NULL AND ? = 1)) ORDER BY created_at LIMIT ?`,
      now - LIBRARY_HOLD.retryForMs, now - LIBRARY_HOLD.claimMs, mailOn, LIBRARY_HOLD.batch,
    ).toArray();
    if (!due.length) return null;
    const total = { held: 0, tagged: 0, mailed: 0 };
    for (const { order_id: orderId } of due) {
      const done = await this.libraryHoldFollowUp(orderId, now);
      for (const k of Object.keys(total)) total[k] += done[k];
    }
    return total;
  },
};

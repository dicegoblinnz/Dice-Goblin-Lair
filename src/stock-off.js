/**
 * Round 39 (15 Nov 2026, contract v39-stock-off): Stock off. Mo: "gives me the use of my camera and scan my items to
 * then click a button to decrease the quantity of that item by the amount scanned. meaning i will take products with me
 * to conventions and instead of doing stock take after i come back i instead scan each item and click a button to take
 * the stock off from the website [...] it would be cool to add a button to say that item is not sold so it doesnt count
 * as a sold itme and just taken off stock for what ever reason like damage maybe gift etc." His picks the same morning:
 * "Stock off only" (no prices and no order: the stock just drops, marked as sold at that event), "Leave dice out"
 * (Dice Goblin's own dice aren't counted one by one) and "Any staff, I get a list".
 *
 *  - GET /stock: the page's start (who's on it, the reasons, the last places).
 *  - POST /stock/product: a barcode or SKU → the thing and the shop's own count, or why it can't come off.
 *  - POST /stock/off: a lot (one tap of Sold or Not sold) comes off the shop's count in Shopify: never below zero, all
 *    of it or none of it, and once however often the phone sends it (its own key is Shopify's idempotency key, and each
 *    line carries the count it was read at, so a count that moved in between is read again, never guessed).
 *  - POST /stock/undo: a lot taken back within 24 hours: exactly what it took goes back on, once.
 *  - GET /stock/log: a day's lots.
 *  - The owner's list: each morning from 8am, one email to the shop's owner with every lot of the days before
 *    (stockOffUpkeep, from the 10-minute run).
 *
 * Sold or not, and where, are the Lair's own record (stock_offs): Shopify has no "sold" reason for a change to a count,
 * and no order is ever made here.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair. Each
 * async method does its awaits first, then reads fresh and writes with no awaits in between; a lot is written down as
 * sending before Shopify is asked, so an answer lost on the way is asked for again with the same key.
 */
import { HOUR, LairTime, RuleError, codeKey, makeId, sameBarcode } from './core.js';
import { emailReady, emailSender } from './shopify.js';

const TZ = 'Pacific/Auckland';
const MIN = 60_000;
const DAY = 24 * HOUR;

/** The shop's own location, "Dice Goblin": a lot comes off its count (env STOCK_OFF_LOCATION_ID can name another) */
export const STOCK_OFF_LOCATION = 'gid://shopify/Location/72250359911';
/** Dice Goblin's own dice are the dice deal's things with this vendor: the Dice price keys and the named sets */
export const STOCK_OFF_OWN_DICE = 'Dice Goblin NZ';
/** A lot: different things, and of one thing */
export const STOCK_OFF_LINES = 40;
export const STOCK_OFF_QTY = 99;
/** A lot can be taken back for this long after it came off */
export const STOCK_OFF_UNDO_HOURS = 24;
/** Shopify keeps an idempotency key for 24 hours: a lot sent this long ago with no answer isn't sent again */
const KEY_MS = 23 * HOUR;
/** A count that moved between the read and the change: read again and try again, this many tries a request */
const STALE_TRIES = 3;
/** Shopify's answers for a code are kept this long */
const PRODUCT_MS = MIN;
/** The phone's clock is believed this far back, and this far ahead */
const AT_BACK = 7 * DAY;
const AT_AHEAD = 5 * MIN;
/** GET /stock: the places of this long, this many */
const EVENTS_FOR = 90 * DAY;
const EVENTS_MOST = 8;
/** GET /stock/log: a day this far back, and at most this many lots of it */
const LOG_DAYS = 60;
const LOG_MOST = 600;
/** The owner's list: from 8am at the shop, the lots of one email, how long a try is kept up, and the owner's address kept */
const MAIL_FROM = 8 * 60;
const MAIL_LOTS = 1000;
const MAIL_FOR = 23 * HOUR;
const OWNER_KEPT = HOUR;

/** Why something isn't sold: [key, the page's label, the words in the owner's list, Shopify's reason for the change] */
const REASONS = [
  ['damaged', 'Damaged', 'damaged', 'damaged'],
  ['gift', 'Gift or giveaway', 'gift or giveaway', 'promotion'],
  ['prize', 'Prize', 'prize', 'promotion'],
  ['lost', 'Lost or stolen', 'lost or stolen', 'shrinkage'],
  ['other', 'Something else', 'something else', 'other'],
];
/** GET /stock's reasons: [key, label] */
export const STOCK_OFF_REASONS = REASONS.map(([key, label]) => [key, label]);
const reasonOf = (key) => REASONS.find((r) => r[0] === key) || null;

/** Every word staff or the owner reads, word for word in the contract */
export const STOCK_OFF_WORDS = {
  login: 'Log in with your staff account to use Stock off.',
  team: 'Stock off is for the Dice Goblin team.',
  // looking a code up
  code: "That doesn't look like a barcode. Scan it again, or type the numbers under it.",
  notFound: "Gobgob can't find that barcode in the shop.",
  library: "That's a library copy, not shop stock, so there's nothing to take off.",
  giftCard: "Gift cards aren't counted stock.",
  ownDice: "Dice Goblin's own dice aren't counted one by one, so leave them out.",
  untracked: (title) => `Shopify doesn't count ${title}, so there's nothing to take off.`,
  notHere: (title) => `${title} has no count at the shop in Shopify.`,
  shopify: "Shopify didn't answer. Try again in a moment.",
  // taking a lot off
  id: "That lot's details didn't come through. Try again.",
  outcome: 'Choose Sold or Not sold.',
  reason: "Choose why it isn't sold.",
  note: 'Say what happened in a few words, so the list makes sense later.',
  lines: `Scan at least one thing, and up to ${STOCK_OFF_LINES} different things a lot.`,
  qty: `Each thing needs a count from 1 to ${STOCK_OFF_QTY}, once a lot.`,
  changed: 'That lot was already sent with different things in it. Start a new one.',
  stale: 'That lot may already be off the count. Check it in Shopify, then start a new one.',
  problems: "Some of that lot can't come off the count. Take those out and send it again.",
  gone: "Gobgob can't find that in the shop any more.",
  shopifyNo: (words) => `Shopify said no: ${words}`,
  busy: 'Still taking the last lot off. Wait a moment, then try again.',
  notAnswered: "Shopify didn't answer. Try again: nothing comes off twice.",
  moved: "The shop's count kept changing while that lot was coming off. Try again.",
  // taking one back
  noLot: "Gobgob can't find that lot.",
  notOff: "That lot hasn't come off yet, so there's nothing to put back.",
  tooLate: 'That lot came off more than a day ago. Fix the count in Shopify instead.',
  undoStale: 'That lot may already be back on the count. Check it in Shopify.',
  undoNotAnswered: "Shopify didn't answer. Try again: nothing goes back twice.",
  // the list
  day: `Pick a day from the last ${LOG_DAYS} days.`,
  // the owner's list (an email)
  subject: (when, sold, notSold) => `Stock off, ${when}: ${sold} sold, ${notSold} not sold`,
  title: 'Stock off',
  intro: (when) => `Here's everything that came off the shop's count ${when}.`,
  quiet: "Nothing here made a sale in Shopify: Stock off only changes the count.",
  shop: 'At the shop',
  sold: 'Sold',
  notSold: 'Not sold',
  check: 'Counts to check',
  back: 'Taken back',
  scannedBy: (names) => `Scanned by ${names}`,
  shortLine: (title, qty, had) => `${title}: ${qty} scanned, ${had} on the count`,
  button: 'Open Stock off',
  signoff: 'Gobgob, the Dice Goblin',
};
const W = STOCK_OFF_WORDS;

/**
 * The tables, made sure of on every start. stock_offs: each lot (its key is the phone's): where, what happened and
 * why, its things as asked (canon: for telling the same lot from a different one under its key) and as they came off
 * (lines), where it stands with Shopify (checking: nothing sent, or turned down; sending: sent, answer not back; done;
 * stuck: Shopify says its key went with other figures) and its tries (each new try has a key of its own), who and when,
 * its undo, and the owner's list it was in. stock_off_mails: each owner's list, written once and kept.
 */
export const STOCK_OFF_TABLES = [
  `CREATE TABLE IF NOT EXISTS stock_offs (
    id TEXT PRIMARY KEY, event TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL, reason TEXT, note TEXT, canon TEXT NOT NULL,
    lines TEXT NOT NULL, status TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, sent_reason TEXT, error TEXT,
    units INTEGER NOT NULL DEFAULT 0, took INTEGER NOT NULL DEFAULT 0, short INTEGER NOT NULL DEFAULT 0, by_id TEXT, by_name TEXT,
    at INTEGER NOT NULL, day TEXT NOT NULL, heard_at INTEGER NOT NULL, sent_at INTEGER, done_at INTEGER,
    undo TEXT, undo_tries INTEGER NOT NULL DEFAULT 0, undo_sent_at INTEGER, undo_error TEXT, undone_at INTEGER, undone_by_id TEXT,
    undone_by TEXT, mail_id TEXT)`,
  'CREATE INDEX IF NOT EXISTS stock_offs_day ON stock_offs (day, at)',
  'CREATE INDEX IF NOT EXISTS stock_offs_mail ON stock_offs (status, mail_id)',
  `CREATE TABLE IF NOT EXISTS stock_off_mails (
    id TEXT PRIMARY KEY, day TEXT NOT NULL, lots INTEGER NOT NULL, letter TEXT NOT NULL, status TEXT NOT NULL,
    tries INTEGER NOT NULL DEFAULT 0, error TEXT, made_at INTEGER NOT NULL, sent_at INTEGER)`,
  'CREATE INDEX IF NOT EXISTS stock_off_mails_status ON stock_off_mails (status)',
];

/* ---------------- small helpers ---------------- */

const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
const errorText = (error) => String(error?.message || error).slice(0, 300);
const isOneEmail = (text) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(text || ''));
const LOT_ID = /^so-[0-9a-f]{32}$/;
const VARIANT_ID = /^\d{1,20}$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** Text someone typed, on one line: no control characters, single spaces, up to `most` characters */
const tidy = (text, most) => String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, most).trim();
/** Numbers kept as text, in number order */
const byNumber = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
const listText = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const realDay = (key) => DAY_KEY.test(key) && new Date(`${key}T00:00:00Z`).toISOString?.().slice(0, 10) === key;
const safeDay = (key) => {
  try {
    return realDay(key);
  } catch {
    return false;
  }
};

/* ---------------- the rules, on their own ---------------- */

/**
 * Never below zero: what comes off a thing is how many were scanned or the shop's count, whichever is smaller; a
 * count at or under zero gives nothing. → { took, short } (short: scanned, and not on the count)
 */
export function stockOffTake(qty, count) {
  const have = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const took = Math.min(qty, have);
  return { took, short: qty - took };
}

/** A thing's name on the list: its product's title, with its option after a · when it has one */
export function stockOffTitle(match) {
  const option = String(match?.variant?.title || '').trim();
  const title = String(match?.product?.title || '').trim() || 'A thing with no name';
  return option && option !== 'Default Title' ? `${title} · ${option}` : title;
}

/**
 * Why a thing can't come off the count, in the contract's words, or null when it can: a library copy, a gift card,
 * Dice Goblin's own dice (the dice deal's things with its own vendor), anything Shopify doesn't count, anything with
 * no count at the shop's location. match: ShopifyAdmin.stockOffByCode's { product, variant }.
 */
export function stockOffRefusal(match) {
  const product = match?.product || {};
  const variant = match?.variant || {};
  if (/\(library\)/i.test(product.title || '')) return W.library;
  if (product.giftCard) return W.giftCard;
  if (product.dice && String(product.vendor || '').trim().toLowerCase() === STOCK_OFF_OWN_DICE.toLowerCase()) return W.ownDice;
  if (!variant.tracked) return W.untracked(stockOffTitle(match));
  if (variant.stock == null || !Number.isFinite(Number(variant.stock))) return W.notHere(stockOffTitle(match));
  return null;
}

/**
 * The things a scanned code is, from Shopify's matches: the ones with that barcode (in any of its forms), else the ones
 * with that SKU, each once; an archived listing only when there's nothing else. → [{ product, variant }]
 */
export function stockOffHits(matches, code) {
  const list = (matches || []).filter((m) => m?.variant?.id && m.product);
  const once = (hits) => {
    const seen = new Set();
    return hits.filter((m) => !seen.has(String(m.variant.id)) && seen.add(String(m.variant.id)));
  };
  const byBarcode = once(list.filter((m) => (m.variant.barcodes || []).some((b) => sameBarcode(b, code))));
  const hits = byBarcode.length ? byBarcode : once(list.filter((m) => sameBarcode(m.variant.sku, code)));
  const current = hits.filter((m) => m.product.status !== 'ARCHIVED');
  return current.length ? current : hits;
}

/** A product and a variant as POST /stock/product answers them */
const productView = (p) => ({ id: String(p.id), title: p.title || '', vendor: p.vendor || '', type: p.type || '', status: p.status || null });
const variantView = (v) => ({ id: String(v.id), title: v.title || 'Default Title', sku: v.sku || null, stock: Number(v.stock), price: v.price ?? null });

/**
 * POST /stock/product's answer for a code, from Shopify's matches: the thing, with choices when several that can come
 * off share it; 404 when the shop has none, 422 with the first one's words when none of them can come off.
 */
export function stockOffAnswer(matches, code) {
  const hits = stockOffHits(matches, code);
  if (!hits.length) throw new RuleError(W.notFound, 404);
  const good = hits.filter((m) => !stockOffRefusal(m));
  if (!good.length) throw new RuleError(stockOffRefusal(hits[0]), 422);
  const view = (m) => ({ product: productView(m.product), variant: variantView(m.variant) });
  const answer = view(good[0]);
  if (good.length > 1) answer.choices = good.map(view);
  return answer;
}

/**
 * A lot as the page sent it, checked: { id, event, outcome, reason, note, lines: [{ variantId, qty }], canon } (canon:
 * the same for the same lot whatever order its things were scanned in). Anything else is a 400 in the contract's words.
 */
export function stockOffLotIn(body) {
  const id = typeof body?.id === 'string' ? body.id : '';
  if (!LOT_ID.test(id)) throw new RuleError(W.id, 400);
  const outcome = body?.outcome;
  if (outcome !== 'sold' && outcome !== 'not-sold') throw new RuleError(W.outcome, 400);
  let reason = null;
  let note = null;
  if (outcome === 'not-sold') {
    reason = typeof body?.reason === 'string' ? body.reason : '';
    if (!reasonOf(reason)) throw new RuleError(W.reason, 400);
    note = tidy(body?.note, 200) || null;
    if (reason === 'other' && String(note || '').replace(/[^\p{L}\p{N}]/gu, '').length < 3) throw new RuleError(W.note, 400);
  }
  const raw = body?.lines;
  if (!Array.isArray(raw) || !raw.length || raw.length > STOCK_OFF_LINES) throw new RuleError(W.lines, 400);
  const lines = raw.map((l) => ({
    variantId: typeof l?.variantId === 'string' ? l.variantId : Number.isSafeInteger(l?.variantId) ? String(l.variantId) : '',
    qty: l?.qty,
  }));
  if (lines.some((l) => !VARIANT_ID.test(l.variantId) || !Number.isInteger(l.qty) || l.qty < 1 || l.qty > STOCK_OFF_QTY)) throw new RuleError(W.qty, 400);
  if (new Set(lines.map((l) => l.variantId)).size !== lines.length) throw new RuleError(W.qty, 400);
  const event = tidy(body?.event, 60);
  const canon = JSON.stringify({ event, outcome, reason, note, lines: [...lines].sort((a, b) => byNumber(a.variantId, b.variantId)) });
  return { id, event, outcome, reason, note, lines, canon };
}

/** A lot's time: the phone's clock when it's within the last 7 days and no more than 5 minutes ahead, else the Lair's */
export function stockOffWhen(sent, now) {
  return typeof sent === 'number' && Number.isFinite(sent) && sent >= now - AT_BACK && sent <= now + AT_AHEAD ? Math.floor(sent) : now;
}

/* ---------------- the owner's list, in words ---------------- */

/** "Saturday 21 November" for a day key */
function dayWords(key) {
  const parts = new Intl.DateTimeFormat('en-NZ', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).formatToParts(new Date(`${key}T12:00:00Z`));
  const part = (type) => parts.find((p) => p.type === type)?.value || '';
  return { weekday: part('weekday'), day: part('day'), month: part('month'), text: `${part('weekday')} ${part('day')} ${part('month')}` };
}
/** The days of a list, for its subject: "Saturday 21 November", "21 to 22 November", "30 November to 1 December" */
function daysWords(days) {
  const first = dayWords(days[0]);
  if (days.length < 2) return first.text;
  const last = dayWords(days[days.length - 1]);
  return first.month === last.month ? `${first.day} to ${last.day} ${last.month}` : `${first.day} ${first.month} to ${last.day} ${last.month}`;
}

/**
 * The owner's list for these lots (stock_offs rows, oldest first): { subject, sold, notSold, details } with a details
 * row for each day and place of what sold (added up by thing, most first, and who scanned), each thing not sold (its
 * reason, who and when, and the note), the counts to check (scanned, and not on the count) and the lots taken back.
 * The numbers are what was scanned: what left the stall, whatever the count had.
 */
export function stockOffList(lots, tz = TZ) {
  const clock = new Intl.DateTimeFormat('en-NZ', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const days = [...new Set(lots.map((l) => l.day))].sort();
  const details = [];
  let sold = 0;
  let notSold = 0;
  for (const day of days) {
    const ofDay = lots.filter((l) => l.day === day);
    for (const event of [...new Set(ofDay.map((l) => l.event || ''))]) {
      const here = ofDay.filter((l) => (l.event || '') === event);
      const label = (what) => [days.length > 1 ? dayWords(day).text : null, event || W.shop, what].filter(Boolean).join(' · ');
      const live = here.filter((l) => l.undo !== 'done');
      const linesOf = (l) => parse(l.lines, []);
      // what sold, added up by thing, most first
      const sums = new Map();
      const scanners = [];
      for (const l of live.filter((x) => x.outcome === 'sold')) {
        for (const line of linesOf(l)) sums.set(line.title, (sums.get(line.title) || 0) + line.qty);
        if (l.by_name && !scanners.includes(l.by_name)) scanners.push(l.by_name);
        sold += l.units;
      }
      const soldLines = [...sums].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([title, units]) => `${units} × ${title}`);
      if (soldLines.length) details.push([label(W.sold), [...soldLines, scanners.length ? W.scannedBy(listText(scanners)) : null].filter(Boolean).join('\n')]);
      // each thing not sold, on a line of its own
      const notLines = [];
      for (const l of live.filter((x) => x.outcome === 'not-sold')) {
        const who = [l.by_name, clock.format(new Date(l.at))].filter(Boolean).join(', ');
        for (const line of linesOf(l)) notLines.push(`${line.qty} × ${line.title}: ${reasonOf(l.reason)?.[2] || l.reason} (${who})${l.note ? `. ${l.note}` : ''}`);
        notSold += l.units;
      }
      if (notLines.length) details.push([label(W.notSold), notLines.join('\n')]);
      // scanned, and not on the count
      const shortLines = live.flatMap((l) => linesOf(l).filter((line) => line.short > 0).map((line) => W.shortLine(line.title, line.qty, line.qty - line.short)));
      if (shortLines.length) details.push([label(W.check), shortLines.join('\n')]);
      // taken back
      const backLines = here.filter((l) => l.undo === 'done').map((l) => {
        const who = [l.by_name, clock.format(new Date(l.at))].filter(Boolean).join(', ');
        const what = l.outcome === 'sold' ? 'sold' : `not sold: ${reasonOf(l.reason)?.[2] || l.reason}`;
        return `${linesOf(l).map((line) => `${line.qty} × ${line.title}`).join(', ')}, ${what} (${who}), taken back${l.undone_by ? ` by ${l.undone_by}` : ''}`;
      });
      if (backLines.length) details.push([label(W.back), backLines.join('\n')]);
    }
  }
  const when = daysWords(days);
  return { subject: W.subject(when, sold, notSold), when: days.length > 1 ? `from ${when}` : `on ${when}`, sold, notSold, details };
}

/* ---------------- the Lair's methods ---------------- */

export const stockOffMethods = {
  /** Stock off is for anyone the staff page lets in: the owner or a helper, whatever their permissions */
  stockOffGate(who) {
    if (!who?.customerId) throw new RuleError(W.login, 401);
    if (!who.staff) throw new RuleError(W.team, 403);
  },

  /** The shop's own location: STOCK_OFF_LOCATION_ID (its number, or its whole id) when it's set */
  stockOffLocation() {
    const set = String(this.env?.STOCK_OFF_LOCATION_ID || '').trim();
    if (!set) return STOCK_OFF_LOCATION;
    return /^\d+$/.test(set) ? `gid://shopify/Location/${set}` : set;
  },

  /** Who did it: the staff member's first name */
  stockOffWho(who) {
    const member = this.memberRow(who?.customerId);
    return String(member?.first_name || member?.name || '').slice(0, 40) || null;
  },

  stockOffRow(id) {
    return this.sql.exec('SELECT * FROM stock_offs WHERE id = ?', String(id)).toArray()[0] || null;
  },

  /** A lot as the Lair answers it (the contract's section 3). No awaits. */
  stockOffView(row) {
    return {
      id: row.id, event: row.event || '', outcome: row.outcome, reason: row.reason || null, reasonLabel: reasonOf(row.reason)?.[1] || null,
      note: row.note || null, by: row.by_name || null, at: row.at, day: row.day, units: row.units, took: row.took, short: row.short,
      lines: parse(row.lines, []).map((l) => ({ variantId: l.variantId, title: l.title, qty: l.qty, took: l.took, short: l.short, left: l.left })),
      undone: row.undo === 'done' ? { at: row.undone_at, by: row.undone_by || null } : null,
    };
  },

  /** GET /stock: the page's start. No awaits. */
  stockOffStart(who, now = Date.now()) {
    this.stockOffGate(who);
    const events = this.sql
      .exec(
        "SELECT event, MAX(at) AS last FROM stock_offs WHERE status = 'done' AND event != '' AND at > ? GROUP BY event COLLATE NOCASE ORDER BY last DESC LIMIT ?",
        now - EVENTS_FOR, EVENTS_MOST,
      )
      .toArray()
      .map((r) => r.event);
    return {
      staff: { name: this.stockOffWho(who) || '', role: who.role === 'helper' ? 'helper' : 'owner' },
      day: new LairTime(this.rulesCache?.tz || TZ).key(now),
      undoHours: STOCK_OFF_UNDO_HOURS,
      reasons: STOCK_OFF_REASONS.map(([key, label]) => ({ key, label })),
      events,
    };
  },

  /**
   * POST /stock/product { code }: a barcode in any of its forms, or a SKU → { product, variant, choices? }, each with
   * the shop's own count, or why it can't come off (see the contract). Shopify's answers for a code are kept a minute.
   * (20 Nov 2026, Mo: "add the price of the item as well so I know the cost just give me the information don't do
   * anything else with it": each variant carries the shop's price for the page to show. A lot still has no prices.)
   */
  async stockOffProduct(body, who) {
    this.stockOffGate(who);
    const code = String(body?.code ?? '').trim();
    if (!/^[A-Za-z0-9._+-]{1,40}$/.test(code)) throw new RuleError(W.code, 400);
    // a shelf code the Lair knows is a library copy, whatever Shopify says of it (a product's own barcode is Shopify's to
    // say: a library copy can still carry the game's barcode, and the copy for sale has it too)
    if (/^DGL/i.test(code) && this.sql.exec('SELECT 1 AS n FROM library_codes WHERE key = ?', codeKey(code)).toArray().length) throw new RuleError(W.library, 422);
    const key = code.toUpperCase();
    if (!this.stockOffSeen || this.stockOffSeen.size > 2000) this.stockOffSeen = new Map();
    const kept = this.stockOffSeen.get(key);
    let matches = kept && Date.now() - kept.at < PRODUCT_MS ? kept.matches : null;
    if (!matches) {
      if (!this.shopify?.configured) throw new RuleError(W.shopify, 503);
      try {
        matches = await this.shopify.stockOffByCode(code, { location: this.stockOffLocation(), dice: this.tillDice() });
      } catch (error) {
        console.error('Lair: Stock off could not look a barcode up in Shopify', errorText(error));
        throw new RuleError(W.shopify, 503);
      }
      this.stockOffSeen.set(key, { at: Date.now(), matches });
    }
    // --- no awaits from here on ---
    return stockOffAnswer(matches, code);
  },

  /**
   * POST /stock/off { id, event?, outcome, reason?, note?, at?, lines: [{ variantId, qty }] }: a lot comes off the
   * shop's count (see the contract): never below zero, all of it or none of it, and once. → { lot }
   */
  async stockOffApply(body, who) {
    this.stockOffGate(who);
    const lot = stockOffLotIn(body);
    /** What the lot already is, when that settles it: its answer, or why it can't go again. Otherwise null. */
    const settled = (row, now) => {
      if (!row) return null;
      if (row.canon !== lot.canon) throw new RuleError(W.changed, 409);
      if (row.status === 'done') return { lot: this.stockOffView(row) };
      if (row.status === 'stuck') throw new RuleError(W.stale, 409);
      // Shopify keeps a key for 24 hours: one sent that long ago with no answer isn't sent again
      if (row.status === 'sending' && now - (row.sent_at || row.heard_at) > KEY_MS) throw new RuleError(W.stale, 409);
      return null;
    };
    const first = settled(this.stockOffRow(lot.id), Date.now());
    if (first) return first;
    if (!this.shopify?.configured) throw new RuleError(W.shopify, 503);
    const location = this.stockOffLocation();
    const dice = this.tillDice();
    const by = { id: String(who.customerId), name: this.stockOffWho(who) };
    for (let attempt = 0; attempt < STALE_TRIES; attempt += 1) {
      if (this.stockOffRow(lot.id)?.status !== 'sending') {
        // 1. the things, and the shop's count of each as it is now
        let found;
        try {
          found = await this.shopify.stockOffByIds(lot.lines.map((l) => l.variantId), { location, dice });
        } catch (error) {
          console.error('Lair: Stock off could not read the counts in Shopify', errorText(error));
          throw new RuleError(W.shopify, 503);
        }
        // --- no awaits until the change is sent ---
        const now = Date.now();
        const row = this.stockOffRow(lot.id);
        const already = settled(row, now);
        if (already) return already;
        // (another request for this lot got its change away while this one was reading: that change is the lot's)
        if (row?.status !== 'sending') {
          const problems = [];
          for (const line of lot.lines) {
            const match = found.get(line.variantId);
            const words = match ? stockOffRefusal(match) : W.gone;
            if (words) problems.push({ variantId: line.variantId, words });
          }
          // all or nothing: nothing has gone to Shopify, so the page can put the lot right and send it again
          if (problems.length) throw Object.assign(new RuleError(W.problems, 422), { more: { problems } });
          const lines = lot.lines.map((line) => {
            const match = found.get(line.variantId);
            const count = Number(match.variant.stock);
            const { took, short } = stockOffTake(line.qty, count);
            return { variantId: line.variantId, itemId: match.variant.itemId, title: stockOffTitle(match).slice(0, 200), qty: line.qty, took, short, from: count, left: count - took };
          });
          const units = lines.reduce((sum, l) => sum + l.qty, 0);
          const took = lines.reduce((sum, l) => sum + l.took, 0);
          // nothing could come off: kept, with its short, and Shopify isn't asked
          const status = took ? 'sending' : 'done';
          if (row) {
            this.write(
              'UPDATE stock_offs SET lines = ?, status = ?, units = ?, took = ?, short = ?, sent_at = ?, done_at = ?, error = NULL WHERE id = ?',
              JSON.stringify(lines), status, units, took, units - took, took ? now : null, took ? null : now, lot.id,
            );
          } else {
            const at = stockOffWhen(body?.at, now);
            this.write(
              `INSERT INTO stock_offs (id, event, outcome, reason, note, canon, lines, status, sent_reason, units, took, short, by_id, by_name, at, day, heard_at, sent_at, done_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              lot.id, lot.event, lot.outcome, lot.reason, lot.note, lot.canon, JSON.stringify(lines), status,
              lot.outcome === 'sold' ? 'other' : reasonOf(lot.reason)[3], units, took, units - took, by.id, by.name, at,
              new LairTime(this.rulesCache?.tz || TZ).key(at), now, took ? now : null, took ? null : now,
            );
          }
          if (!took) return { lot: this.stockOffView(this.stockOffRow(lot.id)) };
        }
      }
      // 2. the change, under the lot's key for this try
      const sent = await this.stockOffSend(lot.id, location);
      if (sent === 'done') return { lot: this.stockOffView(this.stockOffRow(lot.id)) };
      // a count moved in between (or Shopify wanted another reason): nothing came off, so read again and try again
    }
    throw new RuleError(W.moved, 503);
  },

  /**
   * One try at a lot's change in Shopify, as it's written down (its lines, each from the count it was read at, and its
   * key for this try). → 'done' once it's off, 'again' when Shopify took nothing and the lot should be read again (a
   * count that moved, or a reason Shopify turned away); throws the contract's words for everything else. A try Shopify
   * turned down has spent its key: the next has a new one. One with no answer keeps its key, so asking again is safe.
   */
  async stockOffSend(id, location) {
    const row = this.stockOffRow(id);
    if (!row || row.status !== 'sending') return row?.status === 'done' ? 'done' : 'again';
    const tries = row.tries || 0;
    const changes = parse(row.lines, []).filter((l) => l.took > 0).map((l) => ({ inventoryItemId: l.itemId, delta: -l.took, from: l.from }));
    /** Still this try's to settle: nothing else has moved the lot on */
    const mine = () => {
      const now = this.stockOffRow(id);
      return now && now.status === 'sending' && (now.tries || 0) === tries ? now : null;
    };
    const spent = (error, more = '') => this.write(`UPDATE stock_offs SET status = 'checking', tries = tries + 1, error = ?${more} WHERE id = ?`, String(error || '').slice(0, 300) || null, id);
    let answer;
    try {
      answer = await this.shopify.stockOffAdjust(changes, location, `${id}${tries ? `-${tries}` : ''}`, row.sent_reason || 'other', `gid://dice-goblin-lair/StockOff/${id}`);
    } catch (error) {
      if (error?.refused || error?.nothingRan) {
        // turned away before it ran: nothing came off, and a fresh key next time
        if (mine()) spent(errorText(error));
        throw new RuleError(W.shopifyNo(errorText(error)), 422);
      }
      // no answer: it may have come off, so the same key goes again
      console.error('Lair: Shopify did not answer a Stock off lot', errorText(error));
      throw new RuleError(W.notAnswered, 503);
    }
    // --- no awaits from here on ---
    if (this.stockOffRow(id)?.status === 'done') return 'done';
    if (answer?.errors) {
      const codes = answer.errors.map((e) => e.code);
      const words = answer.errors.map((e) => e.message).filter(Boolean).join('; ').slice(0, 300);
      if (codes.includes('IDEMPOTENCY_CONCURRENT_REQUEST') || !mine()) throw new RuleError(W.busy, 503);
      if (codes.includes('IDEMPOTENCY_KEY_PARAMETER_MISMATCH')) {
        // its key went to Shopify with other figures: whether those came off is Shopify's to say, so nobody guesses
        this.write("UPDATE stock_offs SET status = 'stuck', error = ? WHERE id = ?", words || 'key used with other figures', id);
        throw new RuleError(W.stale, 409);
      }
      // from here Shopify took nothing off and this try's key is spent
      if (codes.includes('CHANGE_FROM_QUANTITY_STALE')) {
        spent('a count moved');
        return 'again';
      }
      if (codes.includes('INVALID_REASON') && row.sent_reason !== 'other') {
        spent(words, ", sent_reason = 'other'");
        return 'again';
      }
      spent(words);
      if (codes.some((c) => ['IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED', 'SERVICE_UNAVAILABLE', 'ADJUST_QUANTITIES_FAILED'].includes(c))) throw new RuleError(W.notAnswered, 503);
      throw new RuleError(W.shopifyNo(words || 'it was turned down.'), 422);
    }
    this.write("UPDATE stock_offs SET status = 'done', done_at = ?, error = NULL WHERE id = ? AND status = 'sending'", Date.now(), id);
    return 'done';
  },

  /**
   * POST /stock/undo { id }: a lot taken back within 24 hours of coming off: exactly what it took goes back on the
   * count, once (its own key; an answer lost on the way is asked for again). → { lot }
   */
  async stockOffUndo(body, who) {
    this.stockOffGate(who);
    const id = typeof body?.id === 'string' ? body.id : '';
    let row = LOT_ID.test(id) ? this.stockOffRow(id) : null;
    if (!row) throw new RuleError(W.noLot, 404);
    if (row.undo === 'done') return { lot: this.stockOffView(row) };
    if (row.status !== 'done') throw new RuleError(W.notOff, 409);
    const now = Date.now();
    if (row.undo === 'sending') {
      if (now - (row.undo_sent_at || now) > KEY_MS) throw new RuleError(W.undoStale, 409);
    } else if (now - (row.done_at || row.heard_at) > STOCK_OFF_UNDO_HOURS * HOUR) throw new RuleError(W.tooLate, 409);
    const changes = parse(row.lines, []).filter((l) => l.took > 0).map((l) => ({ inventoryItemId: l.itemId, delta: l.took, from: null }));
    const finish = () => {
      this.write(
        "UPDATE stock_offs SET undo = 'done', undone_at = ?, undo_error = NULL WHERE id = ? AND (undo IS NULL OR undo != 'done')",
        Date.now(), id,
      );
      return { lot: this.stockOffView(this.stockOffRow(id)) };
    };
    const tries = row.undo_tries || 0;
    // who's taking it back is kept from the try that sends it
    if (row.undo !== 'sending') {
      this.write(
        "UPDATE stock_offs SET undo = ?, undo_sent_at = ?, undone_by_id = ?, undone_by = ? WHERE id = ?",
        changes.length ? 'sending' : null, changes.length ? now : null, String(who.customerId), this.stockOffWho(who), id,
      );
    }
    // nothing came off, so there's nothing to ask Shopify
    if (!changes.length) return finish();
    if (!this.shopify?.configured) throw new RuleError(W.shopify, 503);
    const mine = () => {
      const fresh = this.stockOffRow(id);
      return fresh && fresh.undo === 'sending' && (fresh.undo_tries || 0) === tries ? fresh : null;
    };
    const spent = (error) => this.write("UPDATE stock_offs SET undo = NULL, undo_sent_at = NULL, undo_tries = undo_tries + 1, undo_error = ? WHERE id = ?", String(error || '').slice(0, 300) || null, id);
    let answer;
    try {
      answer = await this.shopify.stockOffAdjust(changes, this.stockOffLocation(), `${id}-undo${tries ? `-${tries}` : ''}`, 'correction', `gid://dice-goblin-lair/StockOff/${id}`);
    } catch (error) {
      if (error?.refused || error?.nothingRan) {
        if (mine()) spent(errorText(error));
        throw new RuleError(W.shopifyNo(errorText(error)), 422);
      }
      console.error('Lair: Shopify did not answer a Stock off undo', errorText(error));
      throw new RuleError(W.undoNotAnswered, 503);
    }
    // --- no awaits from here on ---
    row = this.stockOffRow(id);
    if (row?.undo === 'done') return { lot: this.stockOffView(row) };
    if (answer?.errors) {
      const codes = answer.errors.map((e) => e.code);
      const words = answer.errors.map((e) => e.message).filter(Boolean).join('; ').slice(0, 300);
      if (codes.includes('IDEMPOTENCY_CONCURRENT_REQUEST') || !mine()) throw new RuleError(W.busy, 503);
      if (codes.includes('IDEMPOTENCY_KEY_PARAMETER_MISMATCH')) {
        this.write("UPDATE stock_offs SET undo_error = ? WHERE id = ?", words || 'key used with other figures', id);
        throw new RuleError(W.undoStale, 409);
      }
      // Shopify put nothing back, and this try's key is spent
      spent(words);
      if (codes.some((c) => ['IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED', 'SERVICE_UNAVAILABLE', 'ADJUST_QUANTITIES_FAILED'].includes(c))) throw new RuleError(W.undoNotAnswered, 503);
      throw new RuleError(W.shopifyNo(words || 'it was turned down.'), 422);
    }
    return finish();
  },

  /** GET /stock/log?day=: a day's lots, newest first, and what they came to (the contract's section 2). No awaits. */
  stockOffLog(url, who, now = Date.now()) {
    this.stockOffGate(who);
    const time = new LairTime(this.rulesCache?.tz || TZ);
    const today = time.key(now);
    const asked = url.searchParams.get('day');
    const day = asked == null || asked === '' ? today : asked;
    if (!safeDay(day)) throw new RuleError(W.day, 400);
    const back = time.daysBetween(day, today);
    if (back < 0 || back > LOG_DAYS) throw new RuleError(W.day, 400);
    const rows = this.sql.exec("SELECT * FROM stock_offs WHERE day = ? AND status = 'done' ORDER BY at DESC, heard_at DESC LIMIT ?", day, LOG_MOST).toArray();
    const totals = { lots: 0, sold: 0, notSold: 0, short: 0 };
    for (const row of rows) {
      if (row.undo === 'done') continue;
      totals.lots += 1;
      totals[row.outcome === 'sold' ? 'sold' : 'notSold'] += row.units;
      totals.short += row.short;
    }
    return { day, lots: rows.map((row) => this.stockOffView(row)), totals };
  },

  /* ---------------- the owner's list ---------------- */

  /**
   * Where the owner's list goes: STOCK_OFF_EMAIL when it's set (one address), else the shop owner's own address as
   * Shopify has it (asked for at most once an hour). → the address, or throws saying why there isn't one. Never
   * STAFF_EMAIL: this one is the owner's alone.
   */
  async stockOffTo() {
    const setting = String(this.env?.STOCK_OFF_EMAIL || '').trim();
    if (setting) {
      if (!isOneEmail(setting)) throw new Error("STOCK_OFF_EMAIL isn't one email address");
      return setting;
    }
    const kept = this.stockOffOwner;
    if (kept && Date.now() - kept.at < OWNER_KEPT) return kept.email;
    if (!this.shopify?.configured) throw new Error("Shopify isn't set up, so there's no owner's address to send to");
    let email;
    try {
      email = String((await this.shopify.shopOwnerEmail()) || '').trim();
    } catch (error) {
      throw new Error(`Shopify couldn't say the owner's address (${errorText(error).slice(0, 120)})`);
    }
    if (!isOneEmail(email)) throw new Error('Shopify has no email address for the shop owner');
    this.stockOffOwner = { email, at: Date.now() };
    return email;
  },

  /**
   * The 10-minute run's part (the contract's section 6). An owner's list that's waiting goes first, as it was written,
   * for 23 hours. Otherwise, from 8am at the shop and once a day: every lot that's come off on a day before today and
   * hasn't been in a list is written into one email, kept with its key, and sent. → { lots, sent, stopped? }, or null
   * when there was nothing to do.
   */
  async stockOffUpkeep(now = Date.now()) {
    const waiting = this.sql.exec("SELECT * FROM stock_off_mails WHERE status = 'due' ORDER BY made_at LIMIT 1").toArray()[0];
    if (waiting) {
      if (now - waiting.made_at >= MAIL_FOR) {
        this.write("UPDATE stock_off_mails SET status = 'stopped' WHERE id = ? AND status = 'due'", waiting.id);
        this.note({ stockOff: { error: `the owner's list of ${waiting.day} was never sent: ${waiting.error || 'no answer'}`, at: new Date(now).toISOString() } });
        return { lots: waiting.lots, sent: false, stopped: true };
      }
      return this.stockOffMail(waiting.id);
    }
    const time = new LairTime(this.rulesCache?.tz || TZ);
    if (time.minutesOf(now) < MAIL_FROM) return null;
    const today = time.key(now);
    if (this.sql.exec('SELECT 1 AS n FROM stock_off_mails WHERE day = ? LIMIT 1', today).toArray().length) return null;
    const due = () => this.sql.exec("SELECT * FROM stock_offs WHERE status = 'done' AND mail_id IS NULL AND day < ? ORDER BY day, at LIMIT ?", today, MAIL_LOTS).toArray();
    const mark = (rows, mailId) => {
      // (90 lots a statement: Cloudflare's SQL takes 100 values)
      for (let i = 0; i < rows.length; i += 90) {
        const ids = rows.slice(i, i + 90).map((r) => r.id);
        this.write(`UPDATE stock_offs SET mail_id = ? WHERE mail_id IS NULL AND id IN (${ids.map(() => '?').join(', ')})`, mailId, ...ids);
      }
    };
    let lots = due();
    if (!lots.length) return null;
    if (String(this.env?.STOCK_OFF_EMAIL || '').trim().toLowerCase() === 'off') {
      mark(lots, 'off');
      return null;
    }
    // lots that were all taken back are nobody's news
    if (lots.every((l) => l.undo === 'done')) {
      mark(lots, 'none');
      return null;
    }
    const trouble = (error) => {
      this.note({ stockOff: { error: String(error).slice(0, 200), at: new Date(now).toISOString() } });
      return { lots: lots.length, sent: false };
    };
    if (!emailReady(this.env)) return trouble('email is not set up (RESEND_API_KEY and FROM_EMAIL)');
    let to;
    try {
      to = await this.stockOffTo();
    } catch (error) {
      return trouble(errorText(error));
    }
    // --- no awaits: the lots as they stand now, written into one email and claimed for it ---
    lots = due();
    if (!lots.length || this.sql.exec("SELECT 1 AS n FROM stock_off_mails WHERE day = ? OR status = 'due' LIMIT 1", today).toArray().length) return null;
    const id = makeId('som');
    const list = stockOffList(lots, this.rulesCache?.tz || TZ);
    const letter = {
      ...this.letter(to, list.subject, {
        title: W.title,
        intro: [W.intro(list.when), W.quiet],
        details: list.details,
        button: { label: W.button, url: `${this.page('staff')}?view=stock` },
        signoff: W.signoff,
      }),
      ...emailSender(this.env), pinned: true, idempotencyKey: `stock-off-${id}`,
    };
    this.write("INSERT INTO stock_off_mails (id, day, lots, letter, status, made_at) VALUES (?, ?, ?, ?, 'due', ?)", id, today, lots.length, JSON.stringify(letter), now);
    mark(lots, id);
    return this.stockOffMail(id);
  },

  /**
   * One try at sending an owner's list, exactly as it was written (the email service knows a second send of it by its
   * key). An address the service won't take frees its lots for a list written afresh. → { lots, sent }
   */
  async stockOffMail(id) {
    const row = this.sql.exec('SELECT * FROM stock_off_mails WHERE id = ?', id).toArray()[0];
    if (!row || row.status !== 'due') return null;
    const letter = parse(row.letter, null);
    const sent = letter ? await this.mail(letter) : { ok: false, status: 400, message: 'the letter was lost' };
    // --- no awaits from here on ---
    if (sent?.ok) {
      this.write("UPDATE stock_off_mails SET status = 'sent', sent_at = ?, error = NULL WHERE id = ? AND status = 'due'", Date.now(), id);
      return { lots: row.lots, sent: true };
    }
    const error = [sent?.status || null, String(sent?.message || 'not sent')].filter(Boolean).join(': ').slice(0, 250);
    if ([400, 422].includes(sent?.status)) {
      this.write('DELETE FROM stock_off_mails WHERE id = ?', id);
      this.write('UPDATE stock_offs SET mail_id = NULL WHERE mail_id = ?', id);
    } else this.write('UPDATE stock_off_mails SET tries = tries + 1, error = ? WHERE id = ?', error, id);
    this.note({ stockOff: { error: `the owner's list: ${error}`, at: new Date().toISOString() } });
    return { lots: row.lots, sent: false };
  },
};

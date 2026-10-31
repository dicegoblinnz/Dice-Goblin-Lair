/**
 * Round 27 (31 Oct 2026, contract v27-gw-week): the rest of the staff page's Warhammer tab. The plan, agreed with Mo on
 * 31 Oct 2026: "Ready before the first Tuesday after going live: the Warhammer tab with the pad upload, the Tuesday list
 * and email, receiving, GW couldn't supply, holiday dates and weekly ordered-in sales." Rounds 25 and 26 did the pad, the
 * list and the email. This adds, owner only:
 *  - This week's order (GET /gw/week): the week whose list goes next (what customers have ordered in so far), the list
 *    that went last (as it went), shelf top-ups (POST /gw/topups: whole packs, in the email when added before it goes),
 *    GW couldn't supply (POST /gw/unsupplied: order it again next week, or refund it), the refunds still to do, and
 *    ordered-in sales week by week.
 *  - When the box comes (GET /gw/receiving, POST /gw/receive): what came, added to stock in Shopify in one go (never
 *    twice: each part's answer is kept, and Shopify's idempotency key covers a lost answer), then customers' units marked
 *    in straight away (round 25's arrivals, It's in emails and the shop's list).
 *  - Order dates (GET/POST /gw/dates): a week skipped or given its own dates, in the shop's gw.schedule (which the theme,
 *    round 25's emails and Tuesday's list already follow), and the dates of the orders still to come that week with it.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair. Each
 * async method does its awaits first, then reads fresh and writes with no awaits in between, apart from a delivery's
 * claim: written before Shopify is asked, so a part is never added twice.
 */
import { LairTime, RuleError, addDays } from './core.js';
import { emailReady } from './shopify.js';
import { GW_WORDS, GW_PROMISE_DAYS, GW_SHIPS_DAYS, gwLabel, packsFor } from './gw-orders.js';
import { PAD_WORDS } from './gw-pad.js';

const TZ = 'Pacific/Auckland';
const DAY = 24 * 3_600_000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const GW_CODE = /^\d{8,13}$/;
const OPEN = 'quantity > arrived + cancelled';
/** An open line something's still coming for (round 27: not one GW couldn't supply, being refunded) */
const WAITING = `${OPEN} AND unsupplied_at IS NULL`;
/** A list sent this many weeks back can still be changed (GW couldn't supply) */
export const LIST_WEEKS = 8;
/** A delivery: lines a part, parts a delivery, units a line */
export const RECEIVE_PART = 25;
export const RECEIVE_PARTS = 20;
const RECEIVE_MOST = 999;
/** Order dates: the weeks shown, the weeks that can be changed, and how long a past week's change is kept */
const DATES_BACK = 4;
const DATES_AHEAD = 12;
const CHANGE_BACK = 6;
const CHANGE_AHEAD = 26;
const KEEP_WEEKS = 8;
/** gwSchedule follows at most this many skipped Mondays in a row */
export const MOST_SKIPS = 4;
/** A week's own dates: within this many days of its Monday */
const MOST_DAYS = 56;

/** Every word staff or a customer reads, word for word in the contract */
export const GW_WEEK_WORDS = {
  // staff (the Warhammer tab)
  closed: "That week's order has closed.",
  notOnPad: "That code isn't on the latest order pad.",
  packs: 'Packs is a whole number from 0 to 99.',
  choice: 'Choose whether to order it again next week or refund it.',
  noLines: "Nothing from that list is still waiting on that code.",
  oldList: 'That list is too old to change here.',
  receipt: "That delivery's details didn't come through. Try again.",
  tooMany: `Send at most ${RECEIVE_PART} lines a part.`,
  units: `Each line needs a code and how many came (1 to ${RECEIVE_MOST}).`,
  twice: 'Each code once a part: add the counts together.',
  changed: 'That delivery was already added with different counts. Start a new one.',
  stale: 'That delivery may already be in stock: check the counts in Shopify, then start a new one.',
  repeat: (when) => `This looks the same as a delivery added ${when}. Add it to stock again?`,
  notInShop: (codes) => `These aren't in the shop yet: ${codes}. Update the shop from the latest pad, or take them off.`,
  untracked: (codes) => `Shopify doesn't count stock for these: ${codes}. Turn on Track quantity for them in Shopify, or take them off.`,
  busyAdding: 'Still adding the last lot to stock. Wait a moment, then try again.',
  notAnswered: "Shopify didn't answer. Try again: nothing is added twice.",
  shopifyNo: (words) => `Shopify said no: ${words}`,
  monday: 'Pick a Monday from the last six weeks or the next six months.',
  sentSkip: "That week's list has already gone, so it can't be skipped. Change its dates instead.",
  tooManySkips: "Four weeks in a row are skipped already. Change a week's dates instead.",
  dates: "Pick dates after that Monday: GW ships, then it's with customers by the second date, within eight weeks.",
  clash: 'The dates changed just now. Have another look, then try again.',
  // customers (Gobgob, plain first: these are about their order)
  againSubject: (name) => (name ? `A new date for order ${name}` : 'A new date for your order'),
  againTitle: 'A little longer',
  againIntro: (first, what, promise) => `${first ? `Hi ${first}! ` : ''}Games Workshop couldn't send ${what} this week, so it's on our next order. It should now be with you by ${promise}.`,
  againRow: 'On our next order',
  againOutro: (reply) => (reply ? "Rather not wait? Reply to this email and we'll refund it in full." : "Rather not wait? Let us know and we'll refund it in full."),
  refundSubject: (name) => (name ? `Sorry: part of order ${name} isn't coming` : "Sorry: part of your order isn't coming"),
  refundTitle: "Sorry, it's not coming",
  refundIntro: (first, what) => `${first ? `Hi ${first}. ` : ''}Games Workshop can't supply ${what}, so we're refunding it in full, back the way you paid.`,
  refundRow: 'Not coming',
  refundRest: 'The rest of your order is still on its way.',
  refundOutro: 'Gobgob is sorry about this one.',
  datesSubject: (name) => (name ? `A new date for order ${name}` : 'A new date for your order'),
  datesTitle: 'A new date',
  datesIntro: (first, promise, later) => (later
    ? `${first ? `Hi ${first}! ` : ''}Games Workshop's delivery is running later than usual, so your order should now be with you by ${promise}. Sorry for the wait.`
    : `${first ? `Hi ${first}! ` : ''}Good news: your order should now be with you by ${promise}.`),
};
const W = GW_WEEK_WORDS;

/**
 * The tables, made sure of on every start. gw_topups: shelf top-ups, whole GW packs a code, for a week's list.
 * gw_unsupplied: codes GW couldn't supply from a list, and what was done (again: on the next list; refund).
 * gw_receipts: each part of a delivery added to stock: its lines, where it stands with Shopify (checking: not sent yet or
 * turned down; sending: sent, answer not back; done) and its answer, kept so a part sent again is never added twice.
 */
export const GW_WEEK_TABLES = [
  `CREATE TABLE IF NOT EXISTS gw_topups (
    cutoff TEXT NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL, pack INTEGER NOT NULL DEFAULT 1, packs INTEGER NOT NULL,
    price INTEGER NOT NULL DEFAULT 0, who TEXT, added_at INTEGER NOT NULL, PRIMARY KEY (cutoff, code))`,
  `CREATE TABLE IF NOT EXISTS gw_unsupplied (
    cutoff TEXT NOT NULL, code TEXT NOT NULL, choice TEXT NOT NULL, units INTEGER NOT NULL, who TEXT, at INTEGER NOT NULL,
    PRIMARY KEY (cutoff, code))`,
  `CREATE TABLE IF NOT EXISTS gw_receipts (
    id TEXT PRIMARY KEY, receipt TEXT NOT NULL, part INTEGER NOT NULL, parts INTEGER NOT NULL, items TEXT NOT NULL,
    status TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, error TEXT, result TEXT, units INTEGER NOT NULL DEFAULT 0,
    lines INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 0, who TEXT, at INTEGER NOT NULL, done_at INTEGER)`,
  'CREATE INDEX IF NOT EXISTS gw_receipts_receipt ON gw_receipts (receipt)',
];

/* ---------------- small helpers ---------------- */

const int = (v) => (Number.isInteger(Number(v)) ? Number(v) : NaN);
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const isoWeekday = (key) => new Date(`${key}T00:00:00Z`).getUTCDay() || 7;
/** The Monday on or before a day */
export const mondayOf = (key) => addDays(key, 1 - isoWeekday(key));
const left = (row) => row.quantity - row.arrived - row.cancelled;
/** $1,234 or $12.50 */
const money = (c) => {
  const whole = c % 100 === 0;
  return `$${(c / 100).toLocaleString('en-NZ', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`;
};
const lineText = (row, n) => `${n} × ${row.title}`;
const listText = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const likeText = (text) => String(text).replace(/[\\%_]/g, (c) => `\\${c}`);
const metaText = (lair, key) => lair.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray()[0]?.value || '';
const metaJson = (lair, key) => {
  try {
    const value = metaText(lair, key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
};
const denied = (error) => /access denied|required access/i.test(String(error?.message || error || ''));
/** Shopify's trouble as words for staff: the permissions it needs, or try again (round 26's words) */
const trouble = (error) => new RuleError(denied(error) ? PAD_WORDS.scopes : PAD_WORDS.shopify, 503);

/** "today at 3:40pm" or "Thu 19 Nov at 4:05pm" (Auckland) */
function whenText(ms, now, tz = TZ) {
  const time = new LairTime(tz);
  const { h, mi } = time.parts(ms);
  const clock = `${h % 12 || 12}:${String(mi).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
  return `${time.key(ms) === time.key(now) ? 'today' : gwLabel(time.key(ms), 'short')} at ${clock}`;
}

/** A week's own dates or the usual ones: { ships, promise, skip } */
export function weekDates(monday, overrides = {}) {
  const change = (overrides && typeof overrides === 'object' && overrides[monday]) || {};
  return {
    ships: ISO.test(String(change.ships || '')) ? change.ships : addDays(monday, GW_SHIPS_DAYS),
    promise: ISO.test(String(change.promise || '')) ? change.promise : addDays(monday, GW_PROMISE_DAYS),
    skip: change.skip === true,
  };
}

/** The week a Monday's orders go on the list of: itself, or past skipped Mondays (as gwSchedule, up to MOST_SKIPS) */
export function listWeek(monday, overrides = {}) {
  let week = monday;
  for (let i = 0; i < MOST_SKIPS && overrides?.[week]?.skip === true; i += 1) week = addDays(week, 7);
  return week;
}

/** Skipped Mondays in a row a Monday would be part of, if it were skipped too (itself included) */
function skipRun(monday, overrides) {
  let run = 1;
  for (let week = addDays(monday, -7); overrides?.[week]?.skip === true && run <= MOST_SKIPS; week = addDays(week, -7)) run += 1;
  for (let week = addDays(monday, 7); overrides?.[week]?.skip === true && run <= MOST_SKIPS; week = addDays(week, 7)) run += 1;
  return run;
}

/** Each code's lines grouped: { code, title, units, pack, price } */
function byCode(rows) {
  const codes = new Map();
  for (const row of rows) {
    const units = left(row);
    if (units <= 0) continue;
    const code = codes.get(row.code) || { code: row.code, title: row.title, units: 0, pack: 1, price: row.price };
    code.units += units;
    code.pack = Math.max(code.pack, row.pack);
    codes.set(row.code, code);
  }
  return codes;
}

export const gwWeekMethods = {
  /* ---------------- the weeks ---------------- */

  /**
   * The Monday whose list goes next: today on a Monday; otherwise the last Monday until its list has gone, then the
   * Monday after; past any skipped Mondays. No awaits.
   */
  gwOpenWeek(now = Date.now(), overrides = {}) {
    const today = new LairTime(this.rulesCache?.tz || TZ).key(now);
    const monday = mondayOf(today);
    const sent = metaText(this, 'gw-list');
    const week = today === monday || !sent || sent < monday ? monday : addDays(monday, 7);
    return listWeek(week, overrides);
  },

  /** The list an open line is on, or will be on: its own, else the open week (or its own week, if it's later). No awaits. */
  gwLineWeek(row, open, overrides) {
    if (row.listed_for) return row.listed_for;
    return listWeek(row.cutoff > open ? row.cutoff : open, overrides);
  },

  /** The shop's schedule changes, from Shopify (kept for when it can't answer). Never throws. */
  async gwOverridesNow() {
    try {
      const read = await this.shopify.gwScheduleRead();
      this.write("INSERT OR REPLACE INTO meta (key, value) VALUES ('gw-schedule', ?)", JSON.stringify(read.overrides || {}));
      return read.overrides || {};
    } catch (error) {
      console.error('Lair: Shopify would not give the GW schedule', String(error?.message || error).slice(0, 200));
      return metaJson(this, 'gw-schedule') || {};
    }
  },

  /** Who did it: the staff member's first name */
  gwWho(who) {
    const row = this.memberRow(who?.customerId);
    return String(row?.first_name || row?.name || '').slice(0, 40) || null;
  },

  /* ---------------- this week's order ---------------- */

  /** GET /gw/week */
  async gwWeek(who) {
    this.requireStaff(who, 'warhammer');
    const overrides = await this.gwOverridesNow();
    // --- no awaits from here on ---
    return this.gwWeekView(overrides);
  },

  /** The week as GET /gw/week answers it (see the contract). No awaits. */
  gwWeekView(overrides = {}, now = Date.now()) {
    const today = new LairTime(this.rulesCache?.tz || TZ).key(now);
    const openWeek = this.gwOpenWeek(now, overrides);
    const topups = (cutoff) => this.sql.exec('SELECT * FROM gw_topups WHERE cutoff = ? AND packs > 0', cutoff).toArray();
    const finish = (codes, cutoff) => {
      for (const top of topups(cutoff)) {
        const code = codes.get(top.code) || { code: top.code, title: top.title, units: 0, pack: Math.max(1, top.pack), price: top.price };
        code.topup = top.packs;
        codes.set(top.code, code);
      }
      const list = [...codes.values()].map((c) => ({ ...c, packs: c.packs ?? packsFor(c.units, c.pack), topup: c.topup || 0 }))
        .sort((a, b) => a.code.localeCompare(b.code));
      return { codes: list, total: list.reduce((sum, c) => sum + (c.packs + c.topup) * c.pack * c.price, 0) };
    };
    // the week whose list goes next: what's not on a list yet and closes by then
    const unlisted = this.sql.exec(`SELECT * FROM gw_orderins WHERE listed_for IS NULL AND ${WAITING} AND cutoff <= ? ORDER BY code, placed_at`, openWeek).toArray();
    const open = { cutoff: openWeek, due: addDays(openWeek, 1), ...finish(byCode(unlisted), openWeek) };
    // the list that went last, as it went (top-ups added since are on it too)
    let sent = null;
    const kept = metaJson(this, 'gw-list-sent');
    if (kept?.cutoff && kept.cutoff >= addDays(today, -7 * LIST_WEEKS)) {
      const codes = new Map((kept.codes || []).map((c) => [c.code, { ...c }]));
      const list = finish(codes, kept.cutoff);
      const waiting = new Map(this.sql.exec(
        `SELECT code, SUM(quantity - arrived - cancelled) AS n FROM gw_orderins WHERE listed_for = ? AND ${WAITING} GROUP BY code`, kept.cutoff,
      ).toArray().map((r) => [r.code, r.n]));
      const gone = new Map(this.sql.exec('SELECT * FROM gw_unsupplied WHERE cutoff = ?', kept.cutoff).toArray().map((r) => [r.code, r]));
      const lines = list.codes.map((c) => ({
        ...c,
        waiting: waiting.get(c.code) || 0,
        unsupplied: gone.has(c.code) ? { choice: gone.get(c.code).choice, units: gone.get(c.code).units, at: gone.get(c.code).at } : null,
      }));
      const paste = lines.filter((c) => c.packs + c.topup > 0).map((c) => `${c.code},${c.packs + c.topup}`).join('\n');
      sent = { cutoff: kept.cutoff, at: kept.at || null, codes: lines, total: list.total, paste, csv: `Product code,Quantity\n${paste}${paste ? '\n' : ''}` };
    }
    // refunds still to do: lines GW couldn't supply that Shopify hasn't seen refunded yet
    const shop = String(this.env.SHOP || '').replace(/\.myshopify\.com$/, '');
    const refunds = this.sql.exec(
      `SELECT l.*, o.name AS order_name FROM gw_orderins l JOIN gw_orders o ON o.order_id = l.order_id
       WHERE l.unsupplied_at IS NOT NULL AND l.quantity > l.arrived + l.cancelled ORDER BY l.unsupplied_at, l.id LIMIT 100`,
    ).toArray().map((r) => ({
      id: r.id, order: r.order_name || 'Order', orderId: r.order_id,
      admin: shop ? `https://admin.shopify.com/store/${shop}/orders/${String(r.order_id).split('/').pop()}` : null,
      code: r.code, title: r.title, units: left(r), amount: left(r) * r.price, at: r.unsupplied_at,
    }));
    // ordered-in sales, week by week (as Tuesday's email has them)
    const rows = this.sql.exec(
      `SELECT l.cutoff AS cutoff, o.channel AS channel, COUNT(DISTINCT o.order_id) AS orders, SUM(l.quantity - l.cancelled) AS units,
         SUM((l.quantity - l.cancelled) * l.price) AS value
       FROM gw_orderins l JOIN gw_orders o ON o.order_id = l.order_id WHERE l.quantity > l.cancelled AND l.cutoff >= ?
       GROUP BY l.cutoff, o.channel ORDER BY l.cutoff DESC`,
      addDays(today, -7 * 12),
    ).toArray();
    const weeks = [];
    for (const r of rows) {
      let week = weeks.find((w) => w.cutoff === r.cutoff);
      if (!week) {
        if (weeks.length >= 6) continue;
        week = { cutoff: r.cutoff, online: { orders: 0, units: 0, value: 0 }, counter: { orders: 0, units: 0, value: 0 } };
        weeks.push(week);
      }
      week[r.channel === 'counter' ? 'counter' : 'online'] = { orders: r.orders, units: r.units, value: r.value };
    }
    return { today, open, sent, refunds, weeks };
  },

  /** GET /gw/find?q=: lines of the latest pad by barcode, code or words (up to 10) */
  gwFind(url, who) {
    this.requireStaff(who, 'warhammer');
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 60);
    if (q.length < 2) return { lines: [] };
    let rows;
    if (/^\d+$/.test(q)) {
      rows = this.sql.exec(
        `SELECT code, title, pack, barcode, mrp FROM gw_pad WHERE barcode = ? OR code LIKE ? ESCAPE '\\' ORDER BY barcode = ? DESC, code LIMIT 10`,
        q, `${likeText(q)}%`, q,
      ).toArray();
      // a GW product in the shop that's off the pad still has its barcode and code there
      if (!rows.length) {
        rows = this.sql.exec(
          `SELECT sku AS code, product_title AS title, pack, barcode, price AS mrp FROM gw_shop WHERE barcode = ? OR sku = ? LIMIT 10`, q, q,
        ).toArray().filter((r) => GW_CODE.test(r.code));
      }
    } else {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
      rows = this.sql.exec(
        `SELECT code, title, pack, barcode, mrp FROM gw_pad WHERE ${words.map(() => "LOWER(title) LIKE ? ESCAPE '\\'").join(' AND ')} ORDER BY title LIMIT 10`,
        ...words.map((w) => `%${likeText(w)}%`),
      ).toArray();
    }
    return { lines: rows.map((r) => ({ code: r.code, title: r.title, pack: Math.max(1, r.pack || 1), barcode: r.barcode || '', price: r.mrp || 0 })) };
  },

  /** POST /gw/topups { cutoff, code, packs }: a week's shelf top-up (0 packs takes it off). → the week. */
  async gwTopup(body, who) {
    this.requireStaff(who, 'warhammer');
    const packs = body?.packs === undefined || body?.packs === null || body?.packs === '' ? NaN : int(body.packs);
    if (!(packs >= 0 && packs <= 99)) throw new RuleError(W.packs);
    const code = String(body?.code || '').trim();
    const cutoff = String(body?.cutoff || '');
    const overrides = await this.gwOverridesNow();
    // --- no awaits from here on ---
    const pad = GW_CODE.test(code) ? this.sql.exec('SELECT * FROM gw_pad WHERE code = ?', code).toArray()[0] : null;
    if (!pad && packs > 0) throw new RuleError(W.notOnPad);
    const sent = metaJson(this, 'gw-list-sent');
    if (cutoff !== this.gwOpenWeek(Date.now(), overrides) && cutoff !== sent?.cutoff) throw new RuleError(W.closed);
    if (packs === 0) this.write('DELETE FROM gw_topups WHERE cutoff = ? AND code = ?', cutoff, code);
    else {
      this.write(
        'INSERT OR REPLACE INTO gw_topups (cutoff, code, title, pack, packs, price, who, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        cutoff, code, pad.title, Math.max(1, pad.pack || 1), packs, pad.mrp || 0, this.gwWho(who), Date.now(),
      );
    }
    return this.gwWeekView(overrides);
  },

  /**
   * POST /gw/unsupplied { cutoff, code, choice, tell }: a code GW couldn't supply from a list (see the contract).
   * → the week, with told.
   */
  async gwUnsupplied(body, who) {
    this.requireStaff(who, 'warhammer');
    const choice = ['again', 'refund'].includes(body?.choice) ? body.choice : null;
    if (!choice) throw new RuleError(W.choice);
    const cutoff = String(body?.cutoff || '');
    const code = String(body?.code || '').trim();
    const tell = body?.tell !== false;
    const overrides = await this.gwOverridesNow();
    // --- no awaits from here on ---
    const now = Date.now();
    const today = new LairTime(this.rulesCache?.tz || TZ).key(now);
    if (!ISO.test(cutoff) || !GW_CODE.test(code)) throw new RuleError(W.noLines);
    if (cutoff < addDays(today, -7 * LIST_WEEKS)) throw new RuleError(W.oldList);
    const rows = this.sql.exec(`SELECT * FROM gw_orderins WHERE listed_for = ? AND code = ? AND ${WAITING} ORDER BY placed_at, id`, cutoff, code).toArray();
    if (!rows.length) {
      // the same again (a second tap, or the answer lost on the way) changes nothing
      const done = this.sql.exec('SELECT choice FROM gw_unsupplied WHERE cutoff = ? AND code = ?', cutoff, code).toArray()[0];
      if (done?.choice === choice) return { ...this.gwWeekView(overrides, now), told: 0 };
      throw new RuleError(W.noLines);
    }
    const units = rows.reduce((sum, r) => sum + left(r), 0);
    this.write(
      'INSERT OR REPLACE INTO gw_unsupplied (cutoff, code, choice, units, who, at) VALUES (?, ?, ?, ?, ?, ?)',
      cutoff, code, choice, units, this.gwWho(who), now,
    );
    const orders = [...new Set(rows.map((r) => r.order_id))];
    const letters = [];
    if (choice === 'again') {
      // back on the next list, with that week's date
      const week = this.gwOpenWeek(now, overrides);
      const promise = weekDates(week, overrides).promise;
      for (const row of rows) this.write('UPDATE gw_orderins SET listed_for = NULL, promise = ? WHERE id = ?', promise, row.id);
      for (const orderId of orders) {
        const moved = this.gwOrderDate(orderId, today);
        const { order } = this.gwOrderRows(orderId);
        const mine = rows.filter((r) => r.order_id === orderId);
        if (!tell || !order || order.ready_at || !moved) continue;
        const what = listText(mine.map((r) => lineText(r, left(r))));
        const label = gwLabel(moved.after);
        letters.push(this.gwLetter(order, W.againSubject(order.name), {
          title: W.againTitle,
          intro: W.againIntro(order.first_name, what, label),
          details: [[W.againRow, what], [GW_WORDS.toldWhen, label], [GW_WORDS.toldOrder, order.name || '']],
          outro: [GW_WORDS.toldOutro[order.delivery] || GW_WORDS.toldOutro.none, W.againOutro(isEmail(this.env.STAFF_EMAIL))],
        }, `gw-again-${String(orderId).split('/').pop()}-${cutoff}-${code}`));
      }
    } else {
      // refunds to do: nothing waits for them, and an order with nothing else to come is ready
      for (const row of rows) this.write('UPDATE gw_orderins SET unsupplied_at = ? WHERE id = ?', now, row.id);
      for (const orderId of orders) {
        const { order, lines } = this.gwOrderRows(orderId);
        const mine = rows.filter((r) => r.order_id === orderId);
        if (!tell || !order) continue;
        const what = listText(mine.map((r) => lineText(r, left(r))));
        const rest = lines.some((l) => l.quantity > l.arrived + l.cancelled && !l.unsupplied_at);
        // (no amount: the line's price is before any discount, and Shopify's refund says what they paid)
        letters.push(this.gwLetter(order, W.refundSubject(order.name), {
          title: W.refundTitle,
          intro: W.refundIntro(order.first_name, what),
          details: [[W.refundRow, what], [GW_WORDS.toldOrder, order.name || '']],
          outro: [...(rest ? [W.refundRest] : []), W.refundOutro],
        }, `gw-refund-${String(orderId).split('/').pop()}-${cutoff}-${code}`));
      }
      this.gwSettle(orders, now);
    }
    // the customers' emails in one request (Resend takes a couple a second), after everything's kept
    const told = await this.gwSend(letters);
    return { ...this.gwWeekView(overrides, now), told };
  },

  /**
   * An order's date after its lines' dates changed: the latest of its lines still to come. An order told it was late is
   * told again if the new date passes too. { before, after } when it moved, else null. No awaits.
   */
  gwOrderDate(orderId, today) {
    const order = this.sql.exec('SELECT promise FROM gw_orders WHERE order_id = ?', orderId).toArray()[0];
    const dates = this.sql.exec(`SELECT promise FROM gw_orderins WHERE order_id = ? AND ${WAITING}`, orderId).toArray().map((r) => r.promise).filter(Boolean);
    if (!order || !dates.length) return null;
    const after = dates.reduce((a, b) => (b > a ? b : a));
    if (after === order.promise) return null;
    this.write('UPDATE gw_orders SET promise = ?, late_at = CASE WHEN ? >= ? THEN NULL ELSE late_at END WHERE order_id = ?', after, after, today, orderId);
    return { before: order.promise, after };
  },

  /** A customer's email about their order (from Gobgob; replies go to the shop), or null with no email to send to */
  gwLetter(order, subject, content, key) {
    if (!isEmail(order?.email) || !emailReady(this.env)) return null;
    const replyTo = isEmail(this.env.STAFF_EMAIL) ? this.env.STAFF_EMAIL : null;
    return this.letter(order.email, subject, { ...content, signoff: GW_WORDS.signoff }, { idempotencyKey: key, ...(replyTo ? { replyTo } : {}) });
  },

  /**
   * Customers' emails sent together, in one request to Resend (one by one, a burst of them would be turned away). Returns
   * how many went.
   */
  async gwSend(letters) {
    const list = letters.filter(Boolean);
    if (!list.length) return 0;
    // (one on its own goes as one, with its key, so it's never sent twice)
    const result = list.length === 1 ? await this.mail(list[0]) : await this.mailMany(list);
    return result?.ok ? list.length : Math.max(0, Number(result?.sent) || 0);
  },

  /* ---------------- when the box comes ---------------- */

  /** GET /gw/receiving (see the contract). No awaits. */
  gwReceiving(who) {
    this.requireStaff(who, 'warhammer');
    const waiting = this.sql.exec(
      `SELECT l.code AS code, MAX(l.title) AS title, MAX(l.pack) AS pack, SUM(l.quantity - l.arrived - l.cancelled) AS units,
         COUNT(DISTINCT l.order_id) AS orders, MAX(COALESCE(p.barcode, s.barcode, '')) AS barcode
       FROM gw_orderins l LEFT JOIN gw_pad p ON p.code = l.code LEFT JOIN gw_shop s ON s.sku = l.code
       WHERE l.listed_for IS NOT NULL AND l.quantity > l.arrived + l.cancelled AND l.unsupplied_at IS NULL
       GROUP BY l.code ORDER BY title LIMIT 300`,
    ).toArray().map((r) => ({ code: r.code, title: r.title, barcode: r.barcode || '', pack: Math.max(1, r.pack || 1), units: r.units, orders: r.orders }));
    const kept = metaJson(this, 'gw-list-sent');
    let lastList = null;
    if (kept?.cutoff) {
      const codes = new Map((kept.codes || []).map((c) => [c.code, { code: c.code, title: c.title, pack: Math.max(1, c.pack || 1), units: (c.packs || 0) * Math.max(1, c.pack || 1) }]));
      for (const top of this.sql.exec('SELECT * FROM gw_topups WHERE cutoff = ? AND packs > 0', kept.cutoff).toArray()) {
        const code = codes.get(top.code) || { code: top.code, title: top.title, pack: Math.max(1, top.pack), units: 0 };
        code.units += top.packs * code.pack;
        codes.set(top.code, code);
      }
      // not what GW said it couldn't supply from that list: it isn't in the box
      for (const gone of this.sql.exec('SELECT code FROM gw_unsupplied WHERE cutoff = ?', kept.cutoff).toArray()) codes.delete(gone.code);
      // their barcodes, from the pad (90 codes a statement: Cloudflare's SQL takes 100 values)
      const list = [...codes.values()].filter((c) => c.units > 0);
      const barcodes = new Map();
      for (let i = 0; i < list.length; i += 90) {
        const chunk = list.slice(i, i + 90).map((c) => c.code);
        for (const r of this.sql.exec(`SELECT code, barcode FROM gw_pad WHERE code IN (${chunk.map(() => '?').join(', ')})`, ...chunk).toArray()) barcodes.set(r.code, r.barcode || '');
      }
      lastList = { cutoff: kept.cutoff, codes: list.map((c) => ({ ...c, barcode: barcodes.get(c.code) || '' })).sort((a, b) => a.title.localeCompare(b.title)) };
    }
    const receipts = this.sql.exec(
      `SELECT receipt, MIN(at) AS at, MAX(who) AS who, SUM(units) AS units, SUM(lines) AS lines, SUM(ready) AS ready
       FROM gw_receipts WHERE status = 'done' AND at > ? GROUP BY receipt ORDER BY at DESC LIMIT 10`,
      Date.now() - 14 * DAY,
    ).toArray();
    return { waiting, lastList, receipts };
  },

  /**
   * POST /gw/receive { receipt, part, parts, items: [{ code, units }] }: a part of a delivery added to stock at the shop,
   * never twice (see the contract), then customers' units marked in. → { added, ready, later }.
   */
  async gwReceive(body, who) {
    this.requireStaff(who, 'warhammer');
    const receipt = String(body?.receipt || '');
    const part = int(body?.part);
    const parts = int(body?.parts);
    if (!/^[A-Za-z0-9-]{8,64}$/.test(receipt) || !(part >= 1 && parts >= part && parts <= RECEIVE_PARTS)) throw new RuleError(W.receipt);
    const raw = Array.isArray(body?.items) ? body.items : [];
    if (raw.length > RECEIVE_PART) throw new RuleError(W.tooMany, 413);
    const items = raw.map((i) => ({ code: String(i?.code || '').trim(), units: int(i?.units) }));
    if (!items.length || items.some((i) => !GW_CODE.test(i.code) || !(i.units >= 1 && i.units <= RECEIVE_MOST))) throw new RuleError(W.units);
    if (new Set(items.map((i) => i.code)).size !== items.length) throw new RuleError(W.twice);
    items.sort((a, b) => a.code.localeCompare(b.code));
    const canon = JSON.stringify(items);
    const id = `${receipt}#${part}`;
    const { locationId } = this.gwIds();
    const claimOf = () => this.sql.exec('SELECT * FROM gw_receipts WHERE id = ?', id).toArray()[0] || null;
    const claim0 = () => this.write(
      "INSERT OR IGNORE INTO gw_receipts (id, receipt, part, parts, items, status, who, at) VALUES (?, ?, ?, ?, ?, 'checking', ?, ?)",
      id, receipt, part, parts, canon, this.gwWho(who), Date.now(),
    );
    const first = claimOf();
    if (first && first.items !== canon) throw new RuleError(W.changed, 409);
    if (first?.status === 'done') return JSON.parse(first.result);
    // Shopify keeps an idempotency key for 24 hours: a part sent that long ago with no answer isn't sent again
    if (first?.status === 'sending' && Date.now() - first.at > 23 * 3_600_000) throw new RuleError(W.stale, 409);
    // the same lines and counts as a delivery added in the last day (the count sent again from another tab, or the box
    // counted twice): asked first, so it's added again only when they say so
    if (!first && body?.again !== true) {
      const same = this.sql.exec(
        "SELECT done_at FROM gw_receipts WHERE status = 'done' AND items = ? AND receipt != ? AND done_at > ? ORDER BY done_at DESC LIMIT 1",
        canon, receipt, Date.now() - DAY,
      ).toArray()[0];
      if (same) throw new RuleError(W.repeat(whenText(same.done_at, Date.now(), this.rulesCache?.tz || TZ)), 412);
    }
    if (!first) claim0();
    // 1. the variants
    let found;
    try {
      found = await this.shopify.gwReceiveLookup(items.map((i) => i.code));
    } catch (error) {
      throw trouble(error);
    }
    let claim = claimOf();
    if (claim && claim.items !== canon) throw new RuleError(W.changed, 409);
    if (claim?.status === 'done') return JSON.parse(claim.result);
    const missing = items.filter((i) => !found.has(i.code)).map((i) => i.code);
    const untracked = items.filter((i) => found.get(i.code)?.tracked === false).map((i) => i.code);
    if (missing.length || untracked.length) {
      // nothing went to Shopify: the part can come again, put right (a part that may have been added stays, so it's
      // never sent with other counts)
      if (!claim || claim.status === 'checking') this.write("DELETE FROM gw_receipts WHERE id = ? AND status = 'checking'", id);
      throw new RuleError(missing.length ? W.notInShop(missing.join(', ')) : W.untracked(untracked.join(', ')));
    }
    if (!claim) {
      claim0();
      claim = claimOf();
    }
    // 2. claimed: from here, an answer lost on the way is asked again with the same key, so Shopify adds it once
    this.write("UPDATE gw_receipts SET status = 'sending', error = NULL WHERE id = ?", id);
    const key = `${receipt}-${part}${claim.tries ? `-${claim.tries}` : ''}`;
    const changes = items.map((i) => ({ inventoryItemId: found.get(i.code).inventoryItemId, delta: i.units }));
    let answer;
    try {
      answer = await this.shopify.gwAdjust(changes, locationId, key, `logistics://dicegoblin.nz/gw-delivery/${receipt}`);
    } catch (error) {
      if (error?.refused || error?.nothingRan) {
        // turned away before it ran: nothing added, and a fresh key next time
        this.write("UPDATE gw_receipts SET status = 'checking', tries = tries + 1, error = ? WHERE id = ? AND status = 'sending'", String(error?.message || error).slice(0, 300), id);
        throw trouble(error);
      }
      // no answer: it may have been added, so the same key goes again
      console.error('Lair: Shopify did not answer a GW delivery', String(error?.message || error).slice(0, 200));
      throw new RuleError(W.notAnswered, 503);
    }
    if (answer.errors) {
      const codes = answer.errors.map((e) => e.code);
      const words = answer.errors.map((e) => e.message).filter(Boolean).join('; ').slice(0, 300);
      if (codes.includes('IDEMPOTENCY_CONCURRENT_REQUEST')) throw new RuleError(W.busyAdding, 503);
      if (codes.includes('IDEMPOTENCY_KEY_PARAMETER_MISMATCH')) {
        this.write("UPDATE gw_receipts SET status = 'error', error = ? WHERE id = ?", words, id);
        throw new RuleError(W.changed, 409);
      }
      // Shopify said no and added nothing: that key's spent, so the next try has a new one
      this.write("UPDATE gw_receipts SET status = 'checking', tries = tries + 1, error = ? WHERE id = ? AND status = 'sending'", words, id);
      if (codes.some((c) => ['IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED', 'SERVICE_UNAVAILABLE', 'ADJUST_QUANTITIES_FAILED'].includes(c))) throw new RuleError(W.notAnswered, 503);
      throw new RuleError(W.shopifyNo(words || 'it was turned down.'), 422);
    }
    // 3. added: the stock as it is now, to mark customers' units in
    const variantIds = items.map((i) => found.get(i.code).variantId);
    let state = null;
    try {
      state = await this.shopify.gwState(variantIds);
    } catch (error) {
      console.error('Lair: Shopify would not give the stock after a GW delivery (maintenance matches it)', String(error?.message || error).slice(0, 200));
    }
    // --- no awaits from here on ---
    claim = claimOf();
    if (claim?.status === 'done') return JSON.parse(claim.result);
    const now = Date.now();
    const touched = new Set();
    if (state) {
      for (const variantId of variantIds) {
        const available = state.get(variantId)?.available;
        if (!Number.isFinite(available)) continue;
        for (const done of this.gwArrive(variantId, -Math.floor(available))) touched.add(done.orderId);
      }
    }
    const ready = [];
    this.gwSettle(touched, now, ready);
    const result = { added: items.map((i) => ({ code: i.code, title: found.get(i.code).title, units: i.units })), ready, later: !state };
    this.write(
      "UPDATE gw_receipts SET status = 'done', result = ?, units = ?, lines = ?, ready = ?, error = NULL, done_at = ? WHERE id = ?",
      JSON.stringify(result), items.reduce((sum, i) => sum + i.units, 0), items.length, ready.length, now, id,
    );
    return result;
  },

  /* ---------------- order dates ---------------- */

  /** GET /gw/dates */
  async gwDates(who) {
    this.requireStaff(who, 'warhammer');
    const overrides = await this.gwOverridesNow();
    // --- no awaits from here on ---
    return this.gwDatesView(overrides);
  },

  /** The weeks as GET /gw/dates answers them (see the contract). No awaits. */
  gwDatesView(overrides = {}, now = Date.now()) {
    const today = new LairTime(this.rulesCache?.tz || TZ).key(now);
    const monday = mondayOf(today);
    const open = this.gwOpenWeek(now, overrides);
    const sentTo = metaText(this, 'gw-list');
    // orders with something still to come, by the week whose list they're on (or will be)
    const counts = new Map();
    for (const row of this.sql.exec(`SELECT order_id, listed_for, cutoff FROM gw_orderins WHERE ${WAITING}`).toArray()) {
      const week = this.gwLineWeek(row, open, overrides);
      if (!counts.has(week)) counts.set(week, new Set());
      counts.get(week).add(row.order_id);
    }
    const weeks = [];
    for (let i = -DATES_BACK; i <= DATES_AHEAD; i += 1) {
      const week = addDays(monday, 7 * i);
      const dates = weekDates(week, overrides);
      const sent = Boolean(sentTo) && week <= sentTo;
      weeks.push({
        monday: week, ships: dates.ships, promise: dates.promise, skip: dates.skip, changed: Boolean(overrides?.[week]),
        sent, orders: counts.get(week)?.size || 0, canSkip: !sent && !dates.skip && skipRun(week, overrides) <= MOST_SKIPS,
      });
    }
    return { today, open, weeks };
  },

  /** POST /gw/dates { monday, skip | reset | ships + promise, tell } (see the contract). → the dates, with told. */
  async gwDatesSave(body, who) {
    this.requireStaff(who, 'warhammer');
    const today = new LairTime(this.rulesCache?.tz || TZ).key(Date.now());
    const thisMonday = mondayOf(today);
    const monday = String(body?.monday || '');
    if (!ISO.test(monday) || isoWeekday(monday) !== 1 || monday < addDays(thisMonday, -7 * CHANGE_BACK) || monday > addDays(thisMonday, 7 * CHANGE_AHEAD)) {
      throw new RuleError(W.monday);
    }
    const skip = body?.skip === true;
    const reset = !skip && body?.reset === true;
    const ships = String(body?.ships || '');
    const promise = String(body?.promise || '');
    if (!skip && !reset && (!ISO.test(ships) || !ISO.test(promise) || ships <= monday || promise < ships || promise > addDays(monday, MOST_DAYS))) {
      throw new RuleError(W.dates);
    }
    const tell = body?.tell !== false;
    let read;
    try {
      read = await this.shopify.gwScheduleRead();
    } catch (error) {
      throw trouble(error);
    }
    if (!read?.shopId) throw new RuleError(PAD_WORDS.shopify, 503);
    const before = read.overrides || {};
    if (skip) {
      const sentTo = metaText(this, 'gw-list');
      if (sentTo && monday <= sentTo) throw new RuleError(W.sentSkip);
      if (before[monday]?.skip !== true && skipRun(monday, before) > MOST_SKIPS) throw new RuleError(W.tooManySkips);
    }
    const after = JSON.parse(JSON.stringify(before));
    if (skip) after[monday] = { skip: true };
    else if (reset) delete after[monday];
    else {
      const usual = weekDates(monday, {});
      if (ships === usual.ships && promise === usual.promise) delete after[monday];
      else after[monday] = { ships, promise };
    }
    for (const week of Object.keys(after)) if (week < addDays(thisMonday, -7 * KEEP_WEEKS)) delete after[week];
    let saved;
    try {
      saved = await this.shopify.gwScheduleSave(read.shopId, JSON.stringify({ overrides: after }), read.digest);
    } catch (error) {
      throw trouble(error);
    }
    if (saved?.stale) throw new RuleError(W.clash, 409);
    if (saved?.errors) throw new RuleError(W.shopifyNo(saved.errors.join('; ').slice(0, 300) || 'it was turned down.'), 422);
    // --- no awaits from here on (until the emails, once everything's kept) ---
    this.write("INSERT OR REPLACE INTO meta (key, value) VALUES ('gw-schedule', ?)", JSON.stringify(after));
    // (the review, 31 Oct 2026) a skipped week's shelf top-ups go with its orders, to the week whose list they're on now
    const to = listWeek(monday, after);
    if (skip && to !== monday) {
      for (const top of this.sql.exec('SELECT * FROM gw_topups WHERE cutoff = ?', monday).toArray()) {
        const there = this.sql.exec('SELECT packs FROM gw_topups WHERE cutoff = ? AND code = ?', to, top.code).toArray()[0];
        if (there) this.write('UPDATE gw_topups SET packs = ? WHERE cutoff = ? AND code = ?', Math.min(99, there.packs + top.packs), to, top.code);
        else {
          this.write(
            'INSERT INTO gw_topups (cutoff, code, title, pack, packs, price, who, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            to, top.code, top.title, top.pack, top.packs, top.price, top.who, top.added_at,
          );
        }
      }
      this.write('DELETE FROM gw_topups WHERE cutoff = ?', monday);
    }
    const letters = this.gwRedate(before, after, monday, tell);
    const told = await this.gwSend(letters);
    return { ...this.gwDatesView(after), told };
  },

  /**
   * After a week's dates changed: every line still to come whose week is (or was) that Monday gets its week's date, and
   * its order's date follows. Returns the emails for customers whose date moved, when `tell` (sent by the caller). No awaits.
   */
  gwRedate(before, after, monday, tell, now = Date.now()) {
    const today = new LairTime(this.rulesCache?.tz || TZ).key(now);
    const openBefore = this.gwOpenWeek(now, before);
    const openAfter = this.gwOpenWeek(now, after);
    const moved = new Set();
    for (const row of this.sql.exec(`SELECT * FROM gw_orderins WHERE ${WAITING}`).toArray()) {
      const was = this.gwLineWeek(row, openBefore, before);
      const is = this.gwLineWeek(row, openAfter, after);
      if (was !== monday && is !== monday) continue;
      const promise = weekDates(is, after).promise;
      if (promise === row.promise) continue;
      this.write('UPDATE gw_orderins SET promise = ? WHERE id = ?', promise, row.id);
      moved.add(row.order_id);
    }
    const letters = [];
    for (const orderId of moved) {
      const change = this.gwOrderDate(orderId, today);
      if (!tell || !change) continue;
      const { order } = this.gwOrderRows(orderId);
      if (!order || order.ready_at) continue;
      const label = gwLabel(change.after);
      letters.push(this.gwLetter(order, W.datesSubject(order.name), {
        title: W.datesTitle,
        intro: W.datesIntro(order.first_name, label, !change.before || change.after > change.before),
        details: [[GW_WORDS.toldWhen, label], [GW_WORDS.toldOrder, order.name || '']],
        outro: GW_WORDS.toldOutro[order.delivery] || GW_WORDS.toldOutro.none,
      }, `gw-dates-${String(orderId).split('/').pop()}-${change.after}`));
    }
    return letters;
  },
};

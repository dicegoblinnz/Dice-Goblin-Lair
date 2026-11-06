/**
 * Round 31, retail and shopping (contract v31-retail, section 6): "Tell us what you're after". Mo's pick of 6 Nov 2026
 * (the canvas "Retail and shopping: mockups", the empty search: "as drawn"), from the decision of 1 Nov 2026: an empty
 * search says it's not on the shelf right now and offers a short box; staff see the requests; nothing sold out is shown.
 *
 * - POST /requests { text, email?, query? } (anyone): what they're after, and an email if they'd like to hear back. A
 *   filled-in website field (a bot) is thanked and dropped. At most REQUEST_PER_CLIENT an hour from one address and
 *   REQUEST_PER_DAY a day in all.
 * - GET /staff/requests (Check-in): the last REQUEST_SHOW_DAYS days', new first. POST /staff/requests/done { id }.
 * Requests are deleted REQUEST_KEEP_DAYS after they're made (an email is someone's details).
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { HOUR, RuleError } from './core.js';

const DAY = 24 * HOUR;
export const REQUEST_PER_CLIENT = 5;
export const REQUEST_PER_DAY = 200;
export const REQUEST_SHOW_DAYS = 60;
export const REQUEST_KEEP_DAYS = 180;
export const REQUEST_MAX = 200;

export const REQUEST_TABLES = [
  `CREATE TABLE IF NOT EXISTS shop_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, query TEXT, email TEXT, customer_id TEXT, made_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'new', done_at INTEGER, done_by TEXT)`,
  'CREATE INDEX IF NOT EXISTS shop_requests_made ON shop_requests (made_at)',
];

/** Everything people read from here, word for word in the contract */
export const REQUEST_WORDS = {
  text: "Say what you're after, in a few words.",
  long: `Keep it to ${REQUEST_MAX} characters or fewer.`,
  email: "That email doesn't look right. Leave it out if you'd rather not hear back.",
  tooMany: "That's a lot of asks in a row. Try again in a little while, or tell us at the counter.",
  thanks: "Thanks! Staff read every one at the counter.",
  thanksEmail: "Thanks! Staff read every one at the counter, and we'll email you if we can get it in.",
  notFound: "That request isn't one the Lair knows. Refresh the page.",
};

const isEmail = (v) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v);
const tidy = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

export const shopRequestMethods = {
  /** The asks from each address in the last hour (this Lair's own, in memory; a restart forgets them) */
  shopRequestHits() {
    if (!this.shopRequestHitMap) this.shopRequestHitMap = new Map();
    return this.shopRequestHitMap;
  },

  /** POST /requests: → { ok, message }. No awaits. */
  makeShopRequest(input, who, client = '') {
    // a bot fills in the field people never see: thanked, and nothing kept
    if (tidy(input?.website)) return { ok: true, message: REQUEST_WORDS.thanks };
    const text = tidy(input?.text);
    if (!text) throw new RuleError(REQUEST_WORDS.text);
    if ([...text].length > REQUEST_MAX) throw new RuleError(REQUEST_WORDS.long);
    const email = tidy(input?.email).toLowerCase();
    if (email && (email.length > 254 || !isEmail(email))) throw new RuleError(REQUEST_WORDS.email);
    const query = tidy(input?.query).slice(0, 100) || null;
    const now = Date.now();
    if (!who?.staff) {
      if (client) {
        const hits = (this.shopRequestHits().get(client) || []).filter((t) => now - t < HOUR);
        if (hits.length >= REQUEST_PER_CLIENT) throw new RuleError(REQUEST_WORDS.tooMany, 429);
        hits.push(now);
        if (this.shopRequestHits().size > 2000) this.shopRequestHits().clear();
        this.shopRequestHits().set(client, hits);
      }
      const today = this.sql.exec('SELECT COUNT(*) AS n FROM shop_requests WHERE made_at > ?', now - DAY).one().n;
      if (today >= REQUEST_PER_DAY) throw new RuleError(REQUEST_WORDS.tooMany, 429);
    }
    this.write(
      'INSERT INTO shop_requests (text, query, email, customer_id, made_at) VALUES (?, ?, ?, ?, ?)',
      text, query, email || null, who?.customerId ? String(who.customerId) : null, now,
    );
    return { ok: true, message: email ? REQUEST_WORDS.thanksEmail : REQUEST_WORDS.thanks };
  },

  /** GET /staff/requests (Check-in): { requests, waiting }, new first, then newest. No awaits. */
  shopRequests(who) {
    this.requireStaff(who, 'checkin');
    const rows = this.sql.exec(
      "SELECT * FROM shop_requests WHERE made_at > ? ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END, made_at DESC, id DESC LIMIT 200",
      Date.now() - REQUEST_SHOW_DAYS * DAY,
    ).toArray();
    const name = (id) => {
      const m = id ? this.memberRow(id) : null;
      return m ? m.name || m.first_name || null : null;
    };
    return {
      requests: rows.map((r) => ({ id: r.id, text: r.text, query: r.query || null, email: r.email || null, member: name(r.customer_id), madeAt: r.made_at, done: r.status === 'done' })),
      waiting: rows.filter((r) => r.status === 'new').length,
    };
  },

  /** POST /staff/requests/done { id } (Check-in): seen to → { ok }. No awaits. */
  shopRequestDone(input, who) {
    this.requireStaff(who, 'checkin');
    const id = Number(input?.id);
    const row = Number.isInteger(id) && id > 0 ? this.sql.exec('SELECT id FROM shop_requests WHERE id = ?', id).toArray()[0] : null;
    if (!row) throw new RuleError(REQUEST_WORDS.notFound, 404);
    this.write("UPDATE shop_requests SET status = 'done', done_at = ?, done_by = ? WHERE id = ?", Date.now(), String(who.customerId || ''), id);
    return { ok: true };
  },

  /** The 10-minute run's part: requests older than REQUEST_KEEP_DAYS go. No awaits. */
  shopRequestUpkeep(now) {
    this.write('DELETE FROM shop_requests WHERE made_at < ?', now - REQUEST_KEEP_DAYS * DAY);
  },
};

/**
 * Round 40 (16 Nov 2026, contract v40-walkins): walk-ins from Google ads. From Mo, after the first Google search campaign
 * went live: "Can you set it up for me to track who actually walks in?"
 *
 * The click. Google adds a click ID (gclid) to the link of every ad click. The website keeps the latest one this browser
 * arrived by (90 days, Google's own limit) and sends it with a booking or sign-up, and once to My Lair's account when
 * someone's logged in (POST /me/click). The Lair keeps the member's latest click (members.click_gclid and click_at): a
 * later click replaces an earlier one, an older one never replaces a newer. Only the click ID and when: nothing about the
 * person goes to Google.
 *
 * The walk-in. A member's First visit is their first paid session at the Lair (paidSession's rule, the same as a welcome
 * code's: they came in and paid for themselves), counted for a click only when it came after the click, within Google's
 * 90 days, and they hadn't been to Dice Goblin before the click (playedBefore). Like stamps, nothing is stored: it's
 * worked out each time, so a session taken back drops off the list.
 *
 * The list. GET /ads/walkins.csv on the Lair app's own address, read by Google Ads' Data Manager every day: its column
 * names on the first line, times in Auckland time with their offset, one row per First visit in the last 60 days, its Order ID the session's
 * own random ID (fv-<id>), so a row read again on later days is counted once. Only with the list's password
 * (ADS_FEED_KEY, at least 24 characters, set in the config database, never in this public repository): by the username
 * google and that password, or ?key=<password>. With none set there's no list.
 *
 * Methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair. No awaits.
 */
import { RuleError } from './core.js';
import { safeEqual } from './shopify.js';

const DAY = 24 * 3_600_000;

/** The conversion Google Ads is told about, and the windows it allows */
export const WALKIN = Object.freeze({
  name: 'First visit',
  tz: 'Pacific/Auckland',
  /** Google keeps a click 90 days */
  clickDays: 90,
  /** a First visit stays on the list this long: plenty of daily reads, well inside the click's 90 days */
  listDays: 60,
  /** the list's password is at least this long */
  minKey: 24,
  /** the example row's click ID: never a real one */
  example: 'example-not-a-click',
});

/** Round 40's columns on members, made sure of on every start (added when missing) */
export const WALKIN_COLUMNS = [['members', 'click_gclid', 'TEXT'], ['members', 'click_at', 'INTEGER']];

/**
 * A Google click in a request ({ gclid, at? }), cleaned: the ID only if it looks like one (letters, numbers, _ and -,
 * 20 to 300 characters); at is when the browser heard it, never after `now` (no time, or a later one: now). Null for a
 * click older than 90 days or anything that isn't one: a click never stops a booking.
 * @param {unknown} input
 * @param {number} now
 * @returns {{ gclid: string, at: number } | null}
 */
export function cleanClick(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { gclid, at } = /** @type {{ gclid?: unknown, at?: unknown }} */ (input);
  if (typeof gclid !== 'string' || !/^[A-Za-z0-9_-]{20,300}$/.test(gclid)) return null;
  const heard = Number(at);
  const when = Number.isFinite(heard) && heard > 0 && heard <= now ? Math.floor(heard) : now;
  if (now - when > WALKIN.clickDays * DAY) return null;
  return { gclid, at: when };
}

/**
 * A time in Auckland time with its offset, as Google Ads' Data Manager reads it: 2026-11-01T14:00:00+13:00. (After going
 * live: Data Manager reads a file's first line as its column names, so the time zone rides on each time, not on a
 * Parameters:TimeZone line above the columns.)
 */
export function walkinTime(ms) {
  const whole = Math.floor(ms / 1000) * 1000;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: WALKIN.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(whole))
      .map((p) => [p.type, p.value]),
  );
  // the offset is how far Auckland's wall clock is from UTC at that moment (+13:00 in summer, +12:00 in winter)
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const minutes = Math.round((local - whole) / 60000);
  const sign = minutes < 0 ? '-' : '+';
  const offset = `${sign}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/**
 * Whether a request may read the list: the list's password (at least 24 characters) as the password of the username
 * google, or as ?key=. No password set: nobody.
 * @param {Request} request
 * @param {string | undefined} key
 */
export function feedAllowed(request, key) {
  if (typeof key !== 'string' || key.length < WALKIN.minKey) return false;
  const query = new URL(request.url).searchParams.get('key');
  if (query) return safeEqual(query, key);
  const basic = (request.headers.get('Authorization') || '').match(/^Basic\s+([A-Za-z0-9+/=]+)$/i)?.[1];
  if (!basic) return false;
  let pair = '';
  try {
    pair = atob(basic);
  } catch {
    return false;
  }
  const split = pair.indexOf(':');
  if (split < 0) return false;
  return pair.slice(0, split) === 'google' && safeEqual(pair.slice(split + 1), key);
}

export const walkinMethods = {
  /**
   * A member's latest Google click (cleanClick's), kept when it's newer than the one they have. Returns whether it was
   * saved. Someone the Lair hasn't met yet gets nothing (no member record is made here).
   */
  noteClick(customerId, click, now = Date.now()) {
    if (!click || !customerId || !this.memberRow(customerId)) return false;
    const before = this.sql.exec('SELECT click_at FROM members WHERE customer_id = ?', String(customerId)).one();
    if (before?.click_at != null && Number(before.click_at) >= click.at) return false;
    this.write('UPDATE members SET click_gclid = ?, click_at = ?, updated_at = ? WHERE customer_id = ?', click.gclid, click.at, now, String(customerId));
    return true;
  },

  /**
   * 17 Nov 2026 (the legal check): a click older than the 90 days it can lead to a First visit plus the 60 a visit stays on
   * the list can't count any more, so it's forgotten (each maintenance run). Returns how many were.
   */
  forgetOldClicks(now = Date.now()) {
    const before = now - (WALKIN.clickDays + WALKIN.listDays) * DAY;
    const n = this.sql.exec('SELECT COUNT(*) AS n FROM members WHERE click_gclid IS NOT NULL AND click_at < ?', before).one().n;
    if (n) this.write('UPDATE members SET click_gclid = NULL, click_at = NULL WHERE click_gclid IS NOT NULL AND click_at < ?', before);
    return n;
  },

  /** POST /me/click { gclid, at? } (logged in): their latest Google click, from the website. Returns { saved }. */
  meClick(input, who) {
    if (!who.customerId) throw new RuleError('Log in first.', 401);
    if (!this.memberRow(who.customerId)) throw new RuleError('No member with that customer ID.', 404);
    const now = Date.now();
    return { saved: this.noteClick(who.customerId, cleanClick(input, now), now) };
  },

  /**
   * The First visits to tell Google Ads about: [{ gclid, at, orderId }], oldest first. A member with a click from the
   * last 90 days whose first paid session (firstPaidSession) came after the click, within 90 days of it and in the last
   * 60 days, and who hadn't been to Dice Goblin before the click.
   */
  walkins(now = Date.now()) {
    const members = this.sql
      .exec('SELECT customer_id, click_gclid, click_at FROM members WHERE click_gclid IS NOT NULL AND click_at >= ?', now - (WALKIN.clickDays + WALKIN.listDays) * DAY)
      .toArray();
    const out = [];
    for (const m of members) {
      const id = String(m.customer_id);
      const clickAt = Number(m.click_at);
      const tally = this.stampTally(id, now);
      const first = this.firstPaidSession(id, tally.sessions, now);
      if (!first) continue;
      const at = Number(first.at);
      if (at < clickAt || at - clickAt > WALKIN.clickDays * DAY || at > now || now - at > WALKIN.listDays * DAY) continue;
      if (this.playedBefore(id, clickAt, tally)) continue;
      out.push({ gclid: m.click_gclid, at, orderId: `fv-${first.id}` });
    }
    return out.sort((a, b) => a.at - b.at || a.orderId.localeCompare(b.orderId));
  },

  /** GET /internal/walkins (the Worker checked the list's password): Google's conversions-from-clicks file */
  walkinFile(now = Date.now()) {
    const rows = this.walkins(now).map((w) => [w.gclid, WALKIN.name, walkinTime(w.at), w.orderId].join(','));
    // (After going live: Data Manager won't connect to a list with no rows, as it works out each column's type from them,
    // so the list always ends with one example row. Its Order ID is "example", which the connection's filter leaves out,
    // and its click ID isn't one, so Google could never count it either way.)
    const example = [WALKIN.example, WALKIN.name, walkinTime(now), 'example'].join(',');
    const body = ['Google Click ID,Conversion Name,Conversion Time,Order ID', ...rows, example].join('\n') + '\n';
    return new Response(body, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' } });
  },
};

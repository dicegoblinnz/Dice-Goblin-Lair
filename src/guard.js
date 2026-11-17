/**
 * 17 Nov 2026 (contract v43-guard): keeping strangers' robots off the website's forms before the ads bring strangers.
 *
 * The 16 Nov review found anyone logged out could fill a night with made-up names and make the Lair email any address,
 * that the limits lived in memory (a restart forgot them), and that a pass sold at the counter with no name got a code
 * from about 5,200 possibilities. So:
 *  - The robot check: Cloudflare Turnstile on every form that books, signs up or sends an email for someone who isn't
 *    logged in (guardedForm). The page gets a token from Turnstile's widget and sends it as `turnstile`; the Lair asks
 *    Cloudflare's siteverify before anything else. Off until both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set
 *    (D1 config or Worker secrets). Members and staff are never asked. When Cloudflare can't be reached, the request
 *    goes on (noted as turnstileDown): the limits below still hold, and a real customer isn't turned away by an outage.
 *  - A cap on bookings and sign-ups made without an account for any one day (GUEST_NIGHT_CAP, 20 unless set; 'off').
 *  - Limits kept in the Durable Object's own table (guard_hits), so a restart forgets nothing.
 *  - One email to staff (STAFF_EMAIL) when a burst is blocked, at most one an hour.
 *  - A cap on wrong code guesses across the whole shop (claiming a pass by its short code online pauses).
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { HOUR, MIN, LairTime, RuleError, addDays } from './core.js';
import { emailReady } from './shopify.js';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** The numbers in one place */
export const GUARD_LIMITS = {
  // bookings and sign-ups for one day from people who aren't logged in (GUEST_NIGHT_CAP changes it)
  guestsPerDay: 20,
  // bookings, sign-ups and interest from one address in 10 minutes
  bookingsPer10Min: 20,
  // event ideas from one address in an hour
  ideasPerHour: 3,
  // codes one member tries in 10 minutes
  triesPer10Min: 10,
  // wrong codes across the shop in 24 hours before claiming a pass by short code pauses
  wrongCodesPerDay: 20,
  // failed robot checks across the shop in 10 minutes that count as a burst (staff hear)
  failedChecksPer10Min: 10,
  // staff hear about a burst at most this often
  alertEvery: HOUR,
  // how long Cloudflare's siteverify gets
  verifyWait: 5000,
};

export const GUARD_TABLES = [
  // One row a counted try: bucket says what and whose ('book:<address>', 'claim:<customer>', 'wrong-code', 'alert'),
  // at when. Kept a little over a day.
  'CREATE TABLE IF NOT EXISTS guard_hits (bucket TEXT NOT NULL, at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS guard_hits_bucket ON guard_hits (bucket, at)',
  'CREATE INDEX IF NOT EXISTS guard_hits_at ON guard_hits (at)',
];

/** The words people see (customers) and the staff email's (plain: it's the shop talking to itself) */
export const GUARD_WORDS = {
  robot: "Gobgob couldn't tell you're not a robot. Refresh the page and try again, or log in to skip the check.",
  dayFull: "We've taken a lot of bookings without an account for that day. Log in or make a free account to book it, or give us a call.",
  codesPaused: "Lots of wrong codes have been tried today, so codes are paused online for now. Ask us at the counter and we'll add it for you.",
  alertSubject: 'Website: a burst was blocked',
  alertTitle: 'The website blocked a burst',
  alert: {
    rate: (n) => `One address tried to book or sign up more than ${n} times in 10 minutes, so the Lair stopped taking them from it for a while.`,
    day: (day, cap) => `Bookings and sign-ups without an account for ${day} reached the day's cap of ${cap}. Anyone else who isn't logged in is asked to log in or call.`,
    robot: (n) => `${n} bookings or messages failed the robot check in 10 minutes. They were turned away.`,
    codes: (n) => `${n} wrong codes were tried in My Lair in the last 24 hours, so claiming a pass by its short code online is paused until it's quieter. Long codes, loot codes and the counter still work.`,
  },
  alertOutro: [
    "Nothing to do unless real customers say they can't book. If it keeps happening, look over the latest bookings on the staff page for made-up names.",
    "You'll get at most one of these an hour.",
  ],
};

/** A route that books, signs up or sends an email for someone who may not be logged in (POST only) */
export function guardedForm(a, b, c, d) {
  if (a === 'bookings' && !b) return true;
  if (a === 'events' && b && b !== 'joins' && (c === 'join' || c === 'reserve') && !d) return true;
  if (a === 'interest' && !b) return true;
  if (a === 'contact' && !b) return true;
  return a === 'pick' && Boolean(b) && c === 'email' && !d;
}

/** A pass code nobody can guess: initials, a word, a d20 and 4 random letters (DG-OWLBEAR-17-K7QM) */
export const isLongCode = (code) => /^[A-Z]{2}-[A-Z]+-\d{1,2}-[A-Z2-9]{4}$/.test(String(code ?? ''));

/** "Saturday 3 October" for a time, in the shop's time zone */
function dayWords(ms, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.day} ${parts.month}`;
}

export const guardMethods = {
  /* ---------------- counted tries, kept in the Durable Object ---------------- */
  /** How many tries in `bucket` since `since`. No awaits. */
  guardCount(bucket, since) {
    return this.sql.exec('SELECT COUNT(*) AS n FROM guard_hits WHERE bucket = ? AND at > ?', bucket, since).one().n;
  },

  /** Count a try (and clear anything over a day old, every 10 minutes at most). No awaits. */
  guardHit(bucket, now) {
    this.sql.exec('INSERT INTO guard_hits (bucket, at) VALUES (?, ?)', bucket, now);
    if (!this.guardPrunedAt || now - this.guardPrunedAt > 10 * MIN) {
      this.guardPrunedAt = now;
      this.sql.exec('DELETE FROM guard_hits WHERE at < ?', now - 25 * HOUR);
    }
  },

  /**
   * At most `max` tries in `bucket` in `windowMs`: over that, a 429 with `message` (and staff hear, when `alert` says
   * what to tell them); under it, this try is counted. No awaits.
   */
  guardLimit(bucket, max, windowMs, now, message, alert = null) {
    if (this.guardCount(bucket, now - windowMs) >= max) {
      if (alert) this.guardAlert(alert, now);
      throw new RuleError(message, 429);
    }
    this.guardHit(bucket, now);
  },

  /** Tell staff a burst was blocked: one email an hour at most, however many are blocked. No awaits. */
  guardAlert({ what, from = null, details = [] }, now) {
    if (this.guardCount('alert', now - GUARD_LIMITS.alertEvery) > 0) return;
    this.guardHit('alert', now);
    console.log(JSON.stringify({ lair: 'guard', blocked: what, from }));
    if (!emailReady(this.env) || !this.env.STAFF_EMAIL) return;
    const tz = this.rulesCache?.tz || 'Pacific/Auckland';
    const when = new Date(now).toLocaleString('en-NZ', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
    this.later(this.mail(this.letter(this.env.STAFF_EMAIL, GUARD_WORDS.alertSubject, {
      title: GUARD_WORDS.alertTitle,
      intro: what,
      details: [['When', when], ...(from ? [['From address', from]] : []), ...details],
      outro: GUARD_WORDS.alertOutro,
      button: null,
      signoff: 'The Lair',
    })));
  },

  /* ---------------- the robot check (Cloudflare Turnstile) ---------------- */
  /** Both keys, or null while either is missing (the check is off) */
  turnstileKeys() {
    const siteKey = String(this.env.TURNSTILE_SITE_KEY || '').trim();
    const secret = String(this.env.TURNSTILE_SECRET_KEY || '').trim();
    return siteKey && secret ? { siteKey, secret } : null;
  },

  /** GET /guard (anyone): what the page needs to show the check → { turnstile: { siteKey } | null }. Never the secret. */
  guardView() {
    const keys = this.turnstileKeys();
    return { turnstile: keys ? { siteKey: keys.siteKey } : null };
  },

  /**
   * The robot check on a guarded form (guardedForm) for someone not logged in: the body's `turnstile` token, checked
   * with Cloudflare. 403 { error, guard: 'turnstile' } without a token or with one Cloudflare turns down; ten of those in
   * ten minutes across the shop are a burst staff hear about. Cloudflare not answering lets it through (noted).
   */
  async robotCheck(body, who, client) {
    if (who?.customerId || who?.staff) return;
    const keys = this.turnstileKeys();
    if (!keys) return;
    const token = typeof body?.turnstile === 'string' ? body.turnstile.trim().slice(0, 2048) : '';
    if (token) {
      let answer = null;
      try {
        const form = new URLSearchParams({ secret: keys.secret, response: token });
        if (client) form.set('remoteip', client);
        const res = await fetch(SITEVERIFY_URL, {
          method: 'POST', body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          ...(typeof AbortSignal?.timeout === 'function' ? { signal: AbortSignal.timeout(GUARD_LIMITS.verifyWait) } : {}),
        });
        if (!res.ok) throw new Error(`siteverify answered ${res.status}`);
        answer = await res.json();
      } catch (error) {
        console.error('Lair: Turnstile siteverify could not be reached', error);
        this.note({ turnstileDown: { at: new Date().toISOString(), message: String(error?.message || error).slice(0, 200) } });
        return;
      }
      if (answer?.success === true) return;
    }
    const now = Date.now();
    this.guardHit('robot-fail', now);
    if (this.guardCount('robot-fail', now - 10 * MIN) >= GUARD_LIMITS.failedChecksPer10Min) {
      this.guardAlert({ what: GUARD_WORDS.alert.robot(GUARD_LIMITS.failedChecksPer10Min), from: client || null }, now);
    }
    const error = new RuleError(GUARD_WORDS.robot, 403);
    error.more = { guard: 'turnstile' };
    throw error;
  },

  /* ---------------- the limits ---------------- */
  /** A soft limit per client address, so one person can't flood the floor with fake bookings. No awaits. */
  checkRate(who, client, now) {
    if (who.staff || !client) return;
    this.guardLimit(`book:${client}`, GUARD_LIMITS.bookingsPer10Min, 10 * MIN, now, 'Too many bookings in a short time. Call us and we will sort it out.', {
      what: GUARD_WORDS.alert.rate(GUARD_LIMITS.bookingsPer10Min), from: client,
    });
  },

  /** GUEST_NIGHT_CAP as a number (20 when unset), or null when it's 'off' */
  guestDayCap() {
    const raw = String(this.env.GUEST_NIGHT_CAP ?? '').trim().toLowerCase();
    if (!raw) return GUARD_LIMITS.guestsPerDay;
    if (raw === 'off') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : GUARD_LIMITS.guestsPerDay;
  },

  /**
   * The day's cap on bookings (tables, seats, game spots) and event sign-ups made without an account: one more for
   * the day `start` falls on (the shop's time zone) is a 429 once the day has `cap` that are still on. Members and
   * staff aren't counted or capped. No awaits.
   */
  checkGuestDay(who, start, rules, client, now) {
    if (who.customerId || who.staff) return;
    const cap = this.guestDayCap();
    if (cap == null) return;
    const time = new LairTime(rules.tz);
    const day = time.key(start);
    const from = time.at(day, 0);
    const to = time.at(addDays(day, 1), 0);
    const bookings = this.sql.exec(
      `SELECT COUNT(*) AS n FROM bookings WHERE customer_id IS NULL AND added_by IS NULL AND kind IN ('table', 'gm-seat')
         AND status IN ('held', 'confirmed', 'seated') AND starts_at >= ? AND starts_at < ?`, from, to,
    ).one().n;
    const joins = this.sql.exec(
      `SELECT COUNT(*) AS n FROM event_joins WHERE customer_id IS NULL AND added_by IS NULL AND status NOT IN ('cancelled', 'noshow')
         AND starts_at >= ? AND starts_at < ?`, from, to,
    ).one().n;
    if (bookings + joins < cap) return;
    this.guardAlert({ what: GUARD_WORDS.alert.day(dayWords(start, rules.tz), cap), from: client || null }, now);
    throw new RuleError(GUARD_WORDS.dayFull, 429);
  },

  /** Event ideas: 3 an hour from one address (staff aren't limited). No awaits. */
  checkIdeaRate(who, client, now) {
    if (who.staff) return;
    this.guardLimit(`idea:${client}`, GUARD_LIMITS.ideasPerHour, HOUR, now, "We've got your messages. The team will be in touch soon.");
  },

  /** A member's code tries: 10 in 10 minutes, shared by claiming a pass and "Got a code?". No awaits. */
  checkCodeTries(customerId, now) {
    this.guardLimit(`claim:${customerId}`, GUARD_LIMITS.triesPer10Min, 10 * MIN, now, 'Too many tries in a row. Give it ten minutes, or ask us at the counter.');
  },

  /** Too many wrong codes across the shop in 24 hours: claiming a pass by its short code online waits. No awaits. */
  codesPaused(now) {
    return this.guardCount('wrong-code', now - 24 * HOUR) >= GUARD_LIMITS.wrongCodesPerDay;
  },

  /** A wrong code (unknown, or someone else's pass): counted across the shop; staff hear when it pauses. No awaits. */
  wrongCode(now) {
    this.guardHit('wrong-code', now);
    if (this.codesPaused(now)) this.guardAlert({ what: GUARD_WORDS.alert.codes(GUARD_LIMITS.wrongCodesPerDay) }, now);
  },
};

/**
 * Round 24 (31 Oct 2026, contract v24-new-players): welcome codes that pay out at a new player's first paid session, "How
 * did you find us?", and the ad a booking came from, so the weekly numbers count new players by how they found the Lair
 * before the ads start (9 November). From Mo, 31 Oct 2026, planning the ads:
 *  - "The ad only welcome can be a hook for people joining dice goblin. So that could be cool."
 *  - "Happy with welcome codes but I want it only given out after their first event at dice goblin not a free dice roll.
 *    They need to come and pay using their id or qr etc. Then they get a dice for it. Otherwise it won't work for me to
 *    give people free credit."
 *
 * Welcome codes. A loot code (round 7) can be a welcome code: roll_codes.pays_on 'first-session'. Redeemed in "Got a
 * code?", its rolls wait (roll_code_uses.pays_on 'first-session', no grant) until the member has a paid session: a
 * table, walk-in, TTRPG seat or sign-up that stamps their card (round 22) with money paid towards it or a session pass
 * used on it, a Session product rung up at the counter for them, or a stamp staff added by hand. A free session, one
 * staff let them off, a seat their GM pays for and a GM's own session don't count. Like stamps, nothing about it is
 * stored: it's worked out every time (welcomeOf), so a paid session taken back (a no-show, a cancellation) puts the roll
 * back to waiting, unless it's been rolled. A welcome code is for players new to the Lair: one with a session before
 * today (playedBefore) is turned away, so the counter can still check someone in and pay for their first session before
 * they type it. One welcome code a member, kept by a unique index. The four channels' codes are made once on start.
 *
 * "How did you find us?" (members.found_us): one of FOUND_US_ANSWERS, from the member in My Lair, the counter (asked on a
 * new player's first day: the scan's newHere) or the staff page. The latest answer stands, with when and who.
 *
 * Ad tags (ad_source, ad_medium and ad_campaign on bookings, sign-ups and members): the website sends the tags of the
 * link someone arrived by (utm_source, utm_medium and utm_campaign) with a booking or sign-up, and My Lair sends them once
 * after logging in (POST /me/ad). A booking keeps its own; a member keeps the first they came with, never replaced.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair. No
 * awaits anywhere in here.
 */
import { LairTime, RuleError, codeKey, makeId } from './core.js';

/** roll_codes.pays_on and roll_code_uses.pays_on for a welcome code: its rolls wait for the first paid session */
export const WELCOME = 'first-session';

/**
 * Round 24's columns, made sure of on every start (added when missing) as round 15's are:
 *  - roll_codes.pays_on: 'first-session' for a welcome code, else null (its rolls are given at once, as before);
 *  - roll_code_uses.pays_on: the code's when it was used, so changing a code later never changes what a use is owed;
 *  - members.found_us, found_us_at, found_us_by ('me', 'pos:<user>' or 'staff:<customer id>'): "How did you find us?";
 *  - members.ad_source, ad_medium, ad_campaign, ad_at: the first ad tags they came with, and when the Lair heard them;
 *  - bookings' and event_joins' ad_source, ad_medium and ad_campaign: the ad tags it was booked with.
 */
export const NEW_PLAYER_COLUMNS = [
  ['roll_codes', 'pays_on', 'TEXT'], ['roll_code_uses', 'pays_on', 'TEXT'],
  ['members', 'found_us', 'TEXT'], ['members', 'found_us_at', 'INTEGER'], ['members', 'found_us_by', 'TEXT'],
  ['members', 'ad_source', 'TEXT'], ['members', 'ad_medium', 'TEXT'], ['members', 'ad_campaign', 'TEXT'], ['members', 'ad_at', 'INTEGER'],
  ['bookings', 'ad_source', 'TEXT'], ['bookings', 'ad_medium', 'TEXT'], ['bookings', 'ad_campaign', 'TEXT'],
  ['event_joins', 'ad_source', 'TEXT'], ['event_joins', 'ad_medium', 'TEXT'], ['event_joins', 'ad_campaign', 'TEXT'],
];

/** Round 24's index, made when missing: one welcome code a member, kept in the data itself */
export const NEW_PLAYER_TABLES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS roll_code_uses_welcome ON roll_code_uses (customer_id) WHERE pays_on = 'first-session'",
];

/**
 * The welcome codes made once on start (meta 'welcome-codes'), one for each channel in the ads plan, each 1 roll with no
 * limit and no last day. Staff switch any of them off on the Loot codes tab, and they're never made again. A code
 * whose text is taken already is skipped.
 */
export const WELCOME_CODES = [
  { code: 'SEARCH-ROLL', note: 'Welcome code for Google' },
  { code: 'SCROLL-ROLL', note: 'Welcome code for Facebook and Instagram' },
  { code: 'TOK-ROLL', note: 'Welcome code for TikTok' },
  { code: 'UPVOTE-ROLL', note: 'Welcome code for Reddit' },
];

/** "How did you find us?": each answer and how it reads, in the order the counter shows them */
export const FOUND_US_ANSWERS = [
  ['google', 'Google'], ['facebook', 'Facebook'], ['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['reddit', 'Reddit'],
  ['friend', 'A friend'], ['walked-past', 'Walked past'], ['discord', 'Discord'], ['other', 'Something else'],
];
const FOUND_US = new Map(FOUND_US_ANSWERS);

/** Every message a member, the counter or the staff page can see, word for word in the contract */
export const WELCOME_WORDS = {
  notNew: "That's a welcome code for players new to the Lair, and you've played with us before. Thanks for coming back!",
  oneEach: "You've used a welcome code already. It's one per player.",
  welcome: "That Welcome code tick didn't come through properly. Try again.",
  answer: 'Pick one of the answers.',
  noMember: 'No member with that customer ID.',
};

/**
 * What "Got a code?" says once a welcome code is saved: its rolls are ready (their first paid session came first, as
 * at the counter), or waiting for it.
 * @param {number} rolls
 * @param {boolean} ready
 */
export function welcomeMessage(rolls, ready) {
  const n = Math.max(1, Number(rolls) || 1);
  if (ready) return n === 1 ? 'Welcome to the Lair! Your welcome roll is ready on Home, friend.' : `Welcome to the Lair! Your ${n} welcome rolls are ready on Home, friend.`;
  return n === 1
    ? "Saved! Your welcome roll unlocks after your first paid session at the Lair. Show your member code at the counter when you pay, and it's yours."
    : `Saved! Your ${n} welcome rolls unlock after your first paid session at the Lair. Show your member code at the counter when you pay, and they're yours.`;
}

/**
 * The ad tags in a request ({ source, medium?, campaign? }: the link's utm_source, utm_medium and utm_campaign), cleaned:
 * lower case, letters, numbers, dots, underscores, pluses and dashes (anything else is a dash), at most 40 characters
 * (80 for the campaign). Null without a source, or for anything that isn't tags: an ad tag never stops a booking.
 * @param {unknown} input
 * @returns {{ source: string, medium: string | null, campaign: string | null } | null}
 */
export function cleanAd(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const tidy = (value, max) => (typeof value === 'string' || typeof value === 'number'
    ? String(value).toLowerCase().trim().replace(/[^a-z0-9._+-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '')
    : '');
  const { source, medium, campaign } = /** @type {{ source?: unknown, medium?: unknown, campaign?: unknown }} */ (input);
  const clean = tidy(source, 40);
  return clean ? { source: clean, medium: tidy(medium, 40) || null, campaign: tidy(campaign, 80) || null } : null;
}

export const newPlayerMethods = {
  /* ---------------- welcome codes ---------------- */

  /** The four channels' welcome codes (WELCOME_CODES), made once, as round 7 made ROLL-FOR-LOOT. From migrate. */
  seedWelcomeCodes(now = Date.now()) {
    if (this.sql.exec("SELECT value FROM meta WHERE key = 'welcome-codes'").toArray().length) return;
    for (const { code, note } of WELCOME_CODES) {
      if (this.codeTaken(codeKey(code))) continue;
      const id = makeId('rc');
      this.sql.exec("INSERT INTO codes (key, code, kind, target_id, created_at) VALUES (?, ?, 'roll', ?, ?)", codeKey(code), code, id, now);
      this.sql.exec(
        `INSERT INTO roll_codes (id, code, rolls, total_limit, expires_at, status, note, created_by, created_at, updated_at, pays_on)
         VALUES (?, ?, 1, NULL, NULL, 'active', ?, 'setup', ?, ?, ?)`,
        id, code, note, now, now, WELCOME,
      );
    }
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('welcome-codes', ?)", String(now));
  },

  /** When today began at the Lair (ms) */
  todayStarts(now = Date.now()) {
    const time = new LairTime(this.rulesCache?.tz || 'Pacific/Auckland');
    return time.at(time.key(now), 0);
  },

  /**
   * Whether a member played at the Lair before `before` (ms): one of their stamped sessions (stampTally's sessions: theirs,
   * as a named player or guest, paid for by them, run as a GM, or in the stamp ledger) started before it, or a table,
   * walk-in, TTRPG seat or sign-up on their account was checked in or paid before it, from before the loyalty card too.
   */
  playedBefore(customerId, before, tally = this.stampTally(customerId)) {
    if (tally.sessions.some((r) => r.at < before)) return true;
    const id = String(customerId);
    const booked = this.sql.exec(
      `SELECT 1 AS n FROM bookings WHERE customer_id = ? AND kind IN ('table', 'walkin', 'gm-seat') AND starts_at < ?
          AND (status IN ('seated', 'done') OR (paid_amount > 0 AND status NOT IN ('cancelled', 'noshow', 'held'))) LIMIT 1`,
      id, before,
    ).toArray();
    if (booked.length) return true;
    return this.sql.exec(
      `SELECT 1 AS n FROM event_joins WHERE customer_id = ? AND starts_at < ?
          AND (status = 'attended' OR (paid_amount > 0 AND status NOT IN ('cancelled', 'held'))) LIMIT 1`,
      id, before,
    ).toArray().length > 0;
  },

  /**
   * Whether any of a member's stamped sessions (stampTally's sessions) was paid for: a table, walk-in, TTRPG seat or
   * sign-up with money paid towards it or a session pass used on it, a Session product rung up at the counter, or a stamp
   * staff added by hand. A free session, one staff let them off, a seat their GM pays for and a GM's own session aren't.
   */
  paidSession(sessions) {
    for (const r of sessions) {
      if (r.kind === 'stamp-sale' || r.kind === 'stamp-staff') return true;
      if (r.kind === 'join') {
        if (this.sql.exec('SELECT 1 AS n FROM event_joins WHERE id = ? AND paid_amount > 0', r.id).toArray().length) return true;
      } else if (r.kind === 'table' || r.kind === 'walkin' || r.kind === 'gm-seat') {
        if (this.sql.exec('SELECT 1 AS n FROM bookings WHERE id = ? AND (paid_amount > 0 OR covered > 0)', r.id).toArray().length) return true;
      }
    }
    return false;
  },

  /**
   * A member's welcome code: { ready, waiting, code, at }. ready: rolls their first paid session has unlocked (loyaltyOf
   * counts them with the loot codes' rolls); waiting: rolls still waiting for it; code and at: the welcome code they
   * used and when, or null.
   */
  welcomeOf(customerId, tally = this.stampTally(customerId)) {
    const uses = this.sql
      .exec(
        `SELECT u.rolls AS rolls, u.at AS at, c.code AS code FROM roll_code_uses u LEFT JOIN roll_codes c ON c.id = u.code_id
          WHERE u.customer_id = ? AND u.pays_on = 'first-session' ORDER BY u.at, u.rowid`,
        String(customerId),
      )
      .toArray();
    if (!uses.length) return { ready: 0, waiting: 0, code: null, at: null };
    const rolls = uses.reduce((sum, u) => sum + Math.max(0, Number(u.rolls) || 0), 0);
    const paid = this.paidSession(tally.sessions);
    return { ready: paid ? rolls : 0, waiting: paid ? 0 : rolls, code: uses[0].code || null, at: uses[0].at };
  },

  /**
   * "Got a code?" with a welcome code (redeemCode, once the code is known to be theirs to use): one a member, for players
   * with no session at the Lair before today. Saved with no grant; its rolls are ready once they have a paid session
   * (welcomeOf). → { kind: 'welcome', rolls: 0, waiting, message, loyalty } while they wait, or { kind: 'roll', rolls,
   * waiting: 0, message, loyalty } when a paid session came first (as at the counter): an older page shows a 'welcome'
   * answer's message the way it shows a pass's, and offers no roll.
   */
  redeemWelcome(loot, customerId, rules, now) {
    const id = String(customerId);
    if (this.sql.exec("SELECT 1 AS n FROM roll_code_uses WHERE customer_id = ? AND pays_on = 'first-session'", id).toArray().length) {
      throw new RuleError(WELCOME_WORDS.oneEach, 409);
    }
    if (this.playedBefore(id, this.todayStarts(now), this.stampTally(id, now))) throw new RuleError(WELCOME_WORDS.notNew, 409);
    this.touchMember(id, {}, now);
    this.write(
      "INSERT INTO roll_code_uses (id, code_id, customer_id, rolls, grant_id, at, pays_on) VALUES (?, ?, ?, ?, NULL, ?, 'first-session')",
      makeId('ru'), loot.id, id, loot.rolls, now,
    );
    const loyalty = this.loyaltyOf(id, rules, { details: true });
    const ready = !loyalty.rolls.waiting;
    return ready
      ? { kind: 'roll', rolls: loot.rolls, waiting: 0, message: welcomeMessage(loot.rolls, true), loyalty }
      : { kind: 'welcome', rolls: 0, waiting: loot.rolls, message: welcomeMessage(loot.rolls, false), loyalty };
  },

  /**
   * A member's welcome code as their staff page shows it: { code, at, rolls, waiting } (waiting: true while it waits for
   * their first paid session), or null when they haven't used one.
   */
  welcomeView(customerId) {
    const w = this.welcomeOf(customerId);
    return w.code || w.at ? { code: w.code, at: w.at, rolls: w.ready + w.waiting, waiting: w.waiting > 0 } : null;
  },

  /* ---------------- "How did you find us?" ---------------- */

  /** A member's answer: { answer, label, at, by } (by: 'me', 'the counter' or a team member's first name), or null */
  foundUsView(row) {
    if (!row?.found_us || !FOUND_US.has(row.found_us)) return null;
    const by = String(row.found_us_by || '');
    let who = null;
    if (by === 'me') who = 'me';
    else if (by.startsWith('pos')) who = 'the counter';
    else {
      const staff = by.match(/^staff:(\d{1,20})$/)?.[1];
      const member = staff ? this.memberRow(staff) : null;
      who = member?.first_name || String(member?.name || '').split(/\s+/)[0] || (by.startsWith('staff') ? 'staff' : null);
    }
    return { answer: row.found_us, label: FOUND_US.get(row.found_us), at: row.found_us_at || null, by: who };
  },

  /**
   * Saves a member's answer to "How did you find us?" (one of FOUND_US_ANSWERS; staff may send null to clear it). The
   * latest answer stands. Returns the member's foundUs (foundUsView).
   */
  saveFoundUs(customerId, answer, by, { clear = false, now = Date.now() } = {}) {
    const id = String(customerId ?? '').trim().slice(0, 40);
    const row = /^\d{1,20}$/.test(id) ? this.memberRow(id) : null;
    if (!row) throw new RuleError(WELCOME_WORDS.noMember, 404);
    if (clear && (answer === null || answer === '')) {
      this.write('UPDATE members SET found_us = NULL, found_us_at = NULL, found_us_by = NULL, updated_at = ? WHERE customer_id = ?', now, id);
      return null;
    }
    if (typeof answer !== 'string' || !FOUND_US.has(answer)) throw new RuleError(WELCOME_WORDS.answer);
    this.write('UPDATE members SET found_us = ?, found_us_at = ?, found_us_by = ?, updated_at = ? WHERE customer_id = ?', answer, now, by, now, id);
    return this.foundUsView(this.memberRow(id));
  },

  /** POST /me/found-us { answer } (logged in): their own answer. Returns { foundUs }. */
  meFoundUs(input, who) {
    if (!who.customerId) throw new RuleError('Log in to tell us.', 401);
    const now = Date.now();
    this.touchMember(who.customerId, {}, now);
    return { foundUs: this.saveFoundUs(who.customerId, input?.answer, 'me', { now }) };
  },

  /** POST /pos/found-us { customerId, answer } (the counter): a new player's answer at their first visit. Returns { foundUs }. */
  posFoundUs(input, by = 'pos') {
    return { foundUs: this.saveFoundUs(input?.customerId, input?.answer, by) };
  },

  /**
   * POST /members/:customerId/found-us { answer } (staff with Check-in or Members): sets or changes a member's answer;
   * answer null clears it. Returns { foundUs }.
   */
  staffFoundUs(customerId, input, who) {
    this.requireStaff(who, ['checkin', 'members']);
    return { foundUs: this.saveFoundUs(customerId, input?.answer ?? null, who.customerId ? `staff:${who.customerId}` : 'staff', { clear: true }) };
  },

  /* ---------------- ad tags ---------------- */

  /**
   * A booking's or sign-up's ad tags (cleanAd's), saved on its row, and on the member as their first when they have none.
   * table: 'bookings' or 'event_joins'.
   */
  tagAd(table, rowId, customerId, ad, now = Date.now()) {
    if (!ad || !rowId || (table !== 'bookings' && table !== 'event_joins')) return;
    this.write(`UPDATE ${table} SET ad_source = ?, ad_medium = ?, ad_campaign = ? WHERE id = ?`, ad.source, ad.medium, ad.campaign, rowId);
    if (customerId) this.firstAd(customerId, ad, now);
  },

  /** A member's first ad tags, kept once: a later one never replaces them. Returns whether these were saved. */
  firstAd(customerId, ad, now = Date.now()) {
    if (!ad || !customerId || !this.memberRow(customerId)) return false;
    const id = String(customerId);
    if (this.sql.exec('SELECT 1 AS n FROM members WHERE customer_id = ? AND ad_source IS NOT NULL', id).toArray().length) return false;
    this.write('UPDATE members SET ad_source = ?, ad_medium = ?, ad_campaign = ?, ad_at = ? WHERE customer_id = ? AND ad_source IS NULL', ad.source, ad.medium, ad.campaign, now, id);
    return true;
  },

  /**
   * POST /me/ad { source, medium?, campaign? } (logged in): the ad tags of the link they first came by, sent by My Lair
   * once they've logged in. Kept only when they have none yet. Returns { saved }.
   */
  meAd(input, who) {
    if (!who.customerId) throw new RuleError('Log in first.', 401);
    const ad = cleanAd(input);
    if (!ad) return { saved: false };
    const now = Date.now();
    this.touchMember(who.customerId, {}, now);
    return { saved: this.firstAd(who.customerId, ad, now) };
  },
};

/**
 * Round 29, roleplayers phase 1, item 3: "Your first game" for beginners (contract v29-roleplayers section 3). Mo approved
 * it on 2 Nov 2026 from mockups A (the front door on the TTRPG page), B (the join sheet and "You're in") and D3 (the
 * email the day after a first game).
 *
 * - GET /me's ttrpgPlayed: whether a member has had a TTRPG seat at the Lair, checked in or paid in full once its day came
 *   (stamps.js's bookingStamps), by their account or their verified account email, the way gm-sessions.js isNewPlayer
 *   looks. The website's front door ("Your first game, sorted") hides for them, and the join sheet doesn't ask them.
 * - Joining a TTRPG seat (POST /bookings, and "Save my seat every week" for the seat it books now) takes firstGame
 *   (true: "Yes, my first", false: "I've played before", anything else: not answered) into bookings.first_game (1, 0 or
 *   null; never new_player, which is staff's own mark for the seats kept for new players). After "Yes, my first" it takes
 *   followUp, the unticked box "Email me the day after about keeping my seat", as 1 or 0 with when (followup_ok,
 *   followup_ok_at). The email the day after is marketing under New Zealand's Unsolicited Electronic Messages Act 2007,
 *   and the regulator doesn't infer consent from a single booking, so it only goes with that box ticked. The answer says
 *   which weekday the two-day reminder goes (reminderDay), or nothing.
 * - The GM's new-player email says "It's Ria's first roleplaying game." (lair.js tellGmNewPlayer), and staff see "First
 *   game" on that seat at the counter (firstGame on bookingRow and the staff floor; never on customer pages).
 * - The email the day after: to a first game's seat that was checked in ('seated' or 'done') with the box ticked, on the
 *   Lair day after the session, 9am to 9pm, once (claimed before it's sent, unmarked when Resend is down or busy), unless
 *   they've since booked a later session of that game, saved a weekly seat in it, or stopped these emails. A weekly game
 *   whose next session has seats gets mockup D3 ("Save my seat every week"); anything else the same thanks and "Fancy
 *   another?". Every one carries the shop's details (the footer) and "Don't send me emails like this".
 * - Stopping them: the link (/pages/my-lair#unsubscribe=<code>.<key>, the key in the #fragment so no server sees it) asks
 *   POST /unsubscribe/view and stops only on the tap (POST /unsubscribe/stop), never on a page load, since email scanners
 *   open links. The mail app's one-click unsubscribe (RFC 8058) POSTs to the Lair's own /unsubscribe/<code>/<key>. Both
 *   keep the email in followup_stops, straight away, and no follow-up goes to it again.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair; each
 * keeps its rule: every await first, then one synchronous read-check-write.
 */
import { CARD_ROW, LairTime, MIN, RuleError, addDays } from './core.js';
import { emailReady, safeEqual } from './shopify.js';
import { clockLabel } from './email.js';
import { CANCEL_LINK_WORDS, CANCEL_TRIES } from './booking-reminders.js';
import { REMIND_FROM_HOUR, REMIND_UNTIL_HOUR, REMINDERS_A_RUN } from './reminders.js';
import { bookingStamps } from './stamps.js';
import { seatPriceOf } from './gm-sessions.js';

/**
 * Made sure of on every start (added when missing), as round 15's columns are:
 *  - first_game: the answer to "Is this your first roleplaying game?" on a TTRPG seat: 1 yes, 0 no, null not answered;
 *  - followup_ok, followup_ok_at: the box "Email me the day after…", 1 ticked or 0 not, and when (only after "Yes, my first");
 *  - followup_at: when its email the day after was claimed (null again if Resend was down, so the next run sends it);
 *  - followup_key: that email's unsubscribe key (32 hex characters), made when it's claimed, and kept.
 */
export const FIRST_GAME_COLUMNS = [
  ['bookings', 'first_game', 'INTEGER'], ['bookings', 'followup_ok', 'INTEGER'], ['bookings', 'followup_ok_at', 'INTEGER'],
  ['bookings', 'followup_at', 'INTEGER'], ['bookings', 'followup_key', 'TEXT'],
  // its email didn't go: 'shopify' (they've since unsubscribed from Dice Goblin's emails in Shopify, or Shopify marks the
  // address invalid); followup_at says when that was settled
  ['bookings', 'followup_skipped', 'TEXT'],
  // the stop list reaching Shopify: when it did, how many tries have failed, and the last failure
  ['followup_stops', 'shopify_at', 'INTEGER'], ['followup_stops', 'shopify_tries', 'INTEGER'], ['followup_stops', 'shopify_error', 'TEXT'],
];
/**
 * The emails people have stopped (lower case), when, the code of the booking whose link they used and how ('link' or
 * 'one-click'); and the bookings the next-day run and Monday's numbers look for (only first games are in these). Made
 * before FIRST_GAME_COLUMNS are added (lair.js), so the stop list's columns have a table to go on.
 */
export const FIRST_GAME_TABLES = [
  'CREATE TABLE IF NOT EXISTS followup_stops (email TEXT PRIMARY KEY, at INTEGER NOT NULL, ref TEXT, via TEXT)',
  'CREATE INDEX IF NOT EXISTS bookings_followup_due ON bookings (starts_at) WHERE first_game = 1 AND followup_ok = 1 AND followup_at IS NULL',
  'CREATE INDEX IF NOT EXISTS bookings_first_game ON bookings (starts_at) WHERE first_game = 1',
];
/** Stops sent to Shopify in one go (each is a look-up and, when they're subscribed there, a change) */
const STOPS_A_RUN = 20;
/** "This week": the front door's cards and the email's counts look this far ahead */
export const BEGINNER_DAYS = 7;
/** Wrong unsubscribe links from one place in this time, CANCEL_TRIES of them, before it's asked to wait (as cancel links) */
const STOP_TRIES_WINDOW = 10 * MIN;
/** Compared against when there's no key to compare with, so a wrong code takes as long as a wrong key */
const NO_KEY = '0'.repeat(32);

/** Everything the GM's line and the email the day after say, word for word in the contract (D3; Gobgob signs it) */
export const FIRST_GAME_WORDS = {
  /** The GM's new-player email */
  gmLine: (first) => `It's ${first}'s first roleplaying game.`,
  subject: (name) => (name ? `How was your first game, ${name}?` : 'How was your first game?'),
  title: 'How was your first game?',
  thanks: (title, day, name) => `Thanks for coming to ${title} on ${day}${name ? `, ${name}` : ''}. Gobgob hopes the dice were kind.`,
  /** D3: a weekly game whose next session has seats */
  preheader: (title, day) => `${title} runs again on ${day}. Want your seat?`,
  sameTable: (day, clock) => `The same table plays every ${day} at ${clock}. Save your seat and it's yours each week until you give it up.`,
  payEach: (amount) => `You pay at the counter each time, ${amount}.`,
  save: 'Save my seat every week',
  justNext: (day) => `Just next ${day}`,
  different: 'Try a different game',
  nextSession: 'Next session',
  seatsLeft: 'Seats left',
  others: (n) => `Not quite your thing? That's fine. ${n} other beginner ${n === 1 ? 'game has' : 'games have'} seats this week.`,
  /**
   * Anything else (a one-shot, a full next session, none, or a game that isn't weekly), built like D3 (Mo, 6 Nov 2026:
   * "This one is the best please use that"): the soonest beginner game with seats this week. on: "on Wednesday",
   * "tomorrow" or "today"; clock: "6pm".
   */
  pickPreheader: (title, on) => `${title} has seats ${on}. Want one?`,
  pick: (title, on, clock) => `Fancy another? ${title} is ${on} at ${clock}, and new players are welcome.`,
  payOnDay: (amount) => `You pay at the counter on the day, ${amount}.`,
  saveOne: 'Save me a seat',
  when: 'When',
  /** No beginner game with seats this week */
  none: 'Fancy another? No beginner games have seats left this week, but GMs add new ones all the time.',
  find: 'Find your next game',
  unsubscribe: "Don't send me emails like this",
};

/** What the unsubscribe routes say when they can't, word for word in the contract */
export const UNSUBSCRIBE_WORDS = {
  /** A wrong key, a code that isn't a first game's email, or either left out: never saying which */
  wrong: "That link doesn't work. Check you have the whole link from your email.",
  tooMany: CANCEL_LINK_WORDS.tooMany,
  /** The one-click POST's plain answer: it stops all of Dice Goblin's marketing emails, as the law says it does */
  done: 'Done. No more news emails from Dice Goblin.',
};

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const lowerEmail = (v) => String(v || '').trim().toLowerCase();
const money = (cents) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
/** "Sunday 15 November" and "Sunday" in the Lair's time zone (some ICU versions put a comma after the weekday) */
const longDay = (ms, tz) => new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(ms)).replace(/,/g, '');
const weekdayOf = (ms, tz) => new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'long' }).format(new Date(ms));
/** The first word of the name on a seat ("Ria" for Ria Moana), or '' */
const firstWord = (name) => String(name || '').trim().split(/\s+/)[0] || '';

export const firstGameMethods = {
  /* ---------------- joining ---------------- */
  /**
   * The answer to "Is this your first roleplaying game?" on a TTRPG seat: { first: 1 (true) | 0 (false) | null (anything
   * else: not answered), ok: the box after "Yes, my first", 1 (followUp true) or 0, else null }. No awaits.
   */
  firstGameAnswer(input) {
    const first = input?.firstGame === true ? 1 : input?.firstGame === false ? 0 : null;
    return { first, ok: first === 1 ? (input?.followUp === true ? 1 : 0) : null };
  },

  /** Keeps the answer on the seat (first_game), with the consent and when it was given, once it's saved. No awaits. */
  markFirstGame(id, answer, now) {
    if (!answer || answer.first == null) return;
    this.write('UPDATE bookings SET first_game = ?, followup_ok = ?, followup_ok_at = ? WHERE id = ?', answer.first, answer.ok, answer.ok == null ? null : now, id);
  },

  /**
   * The weekday a one-off TTRPG seat's two-day reminder goes ("Friday"), or null when none will: emails off, the reminders
   * not switched on (only the live theme's settings saying true turns them on, the same check as booking-reminders.js's
   * claim), a weekly saved seat, or booked on the reminder day or later (as booking-reminders.js claims them). For the
   * confirmation's "We'll email you on Friday as a reminder." No awaits.
   */
  bookingReminderDay(x, rules, now) {
    if (!emailReady(this.env) || rules?.bookingReminders !== true) return null;
    if (!x || x.kind !== 'gm-seat' || x.seriesId || x.status !== 'confirmed' || !isEmail(x.email)) return null;
    const time = new LairTime(rules.tz);
    const remindDay = addDays(time.key(x.start), -2);
    if (!((x.createdAt ?? now) < time.at(remindDay, 0))) return null;
    return weekdayOf(time.at(remindDay, 12 * 60), rules.tz);
  },

  /* ---------------- has this member played? ---------------- */
  /**
   * Whether someone has had a TTRPG seat at the Lair: one on their account, or with their (verified) email, that was
   * checked in, or paid in full once its day came (bookingStamps). One look each way, so each uses its index
   * (bookings_customer, bookings_email_lower), as isNewPlayer does. No awaits.
   */
  ttrpgPlayed(customerId, email, now = Date.now()) {
    const id = customerId ? String(customerId) : '';
    const mail = isEmail(email) ? lowerEmail(email) : '';
    if (!id && !mail) return false;
    const until = this.stampsUntil(now);
    const seen = (column, value) => this.sql
      .exec(`SELECT 1 AS seen FROM bookings b WHERE ${column} = ? AND b.kind = 'gm-seat' AND ${bookingStamps('b')} LIMIT 1`, value, until)
      .toArray().length > 0;
    return (id !== '' && seen('b.customer_id', id)) || (mail !== '' && seen('lower(b.email)', mail));
  },

  /* ---------------- the email the day after ---------------- */
  /**
   * The 10-minute run's next-day emails: asks Shopify about the ones due (nextDaySkips), then claims them and sends them
   * in the background. Shopify not answering: none go this run, and the next run asks again. → { sent } or null.
   */
  async sendNextDay(rules, now) {
    const skips = await this.nextDaySkips(rules, now);
    if (!skips) return null;
    // --- no awaits from here ---
    const claim = this.claimNextDay(rules, now, skips);
    if (!claim) return null;
    this.later(this.deliverNextDay(claim));
    return claim.summary;
  },

  /** POST /internal/next-day { at }: the same run at a fixed time (the checks' clock), waiting for the send. → { sent, ok } or { sent: 0 } */
  async nextDayAt(at) {
    const rules = await this.rules();
    const skips = await this.nextDaySkips(rules, at);
    if (!skips) return { sent: 0 };
    // --- no awaits until they're claimed ---
    const claim = this.claimNextDay(rules, at, skips);
    if (!claim) return { sent: 0 };
    const result = await this.deliverNextDay(claim);
    return { ...claim.summary, ok: Boolean(result.ok) };
  },

  /**
   * Which of the ones due Shopify rules out. Using an unsubscribe withdraws consent to all of Dice Goblin's marketing
   * emails (the Unsolicited Electronic Messages Act 2007, sections 9(2) and 11(1)(a)), so the box counts only until they
   * unsubscribe: no email when Shopify has their email unsubscribed since they ticked it (or at a time it doesn't
   * know), or marked invalid or redacted. Unsubscribed before they ticked it: the box is fresh consent to this one email.
   * Asked before the claim (every await first). → a Map of booking id → 'shopify' (settled without an email); empty
   * without Shopify set up; null when Shopify doesn't answer.
   */
  async nextDaySkips(rules, now) {
    const skips = new Map();
    const due = this.nextDayDue(rules, now);
    if (!due.length || !this.shopify.configured) return skips;
    const known = new Map();
    for (const d of due) {
      const mail = lowerEmail(d.x.email);
      if (known.has(mail)) continue;
      try {
        known.set(mail, await this.shopify.marketingByEmail(mail));
      } catch (error) {
        console.error('Lair: could not read email marketing settings from Shopify', error);
        return null;
      }
    }
    for (const d of due) {
      const m = known.get(lowerEmail(d.x.email));
      if (!m) continue;
      const ticked = Number(d.row.followup_ok_at) || 0;
      if (m.state === 'INVALID' || m.state === 'REDACTED' || (m.state === 'UNSUBSCRIBED' && (m.at ?? Infinity) >= ticked)) skips.set(d.x.id, 'shopify');
    }
    return skips;
  },

  /**
   * Which next-day emails are due at `now`, Lair time, marked as sent (with their unsubscribe key) before anything goes:
   * nextDayDue's, less the ones Shopify ruled out (skips: settled here, with no email and no key, so they're never asked
   * about again). Once each, at most REMINDERS_A_RUN a run. No awaits.
   * → { at, ids, letters, summary: { sent } } or null.
   */
  claimNextDay(rules, now, skips = new Map()) {
    const found = this.nextDayDue(rules, now);
    if (!found.length) return null;
    // --- the ones Shopify ruled out are settled first: they never go ---
    for (const d of found) {
      if (skips.has(d.x.id)) this.write('UPDATE bookings SET followup_at = ?, followup_skipped = ? WHERE id = ? AND followup_at IS NULL', now, skips.get(d.x.id), d.x.id);
    }
    const due = found.filter((d) => !skips.has(d.x.id));
    if (!due.length) return null;
    // --- marked as sent first, with its key: it never goes twice, and a retry keeps the key ---
    for (const d of due) {
      d.key = d.row.followup_key || crypto.randomUUID().replace(/-/g, '');
      this.write('UPDATE bookings SET followup_at = ?, followup_key = COALESCE(followup_key, ?) WHERE id = ? AND followup_at IS NULL', now, d.key, d.x.id);
    }
    return { at: now, ids: due.map((d) => d.x.id), letters: due.map((d) => this.nextDayLetter(d, rules, now)), summary: { sent: due.length } };
  },

  /**
   * Who's due at `now`, Lair time (nothing marked): first games ('gm-seat', first_game 1) with the box ticked
   * (followup_ok 1), checked in ('seated', or 'done' once they've left), that started on the Lair day before today, with
   * an email that hasn't stopped these, and not taken up already (nextDayTaken). Only from 9am to 9pm, at most
   * REMINDERS_A_RUN. No awaits. → [{ x, row, game }]
   */
  nextDayDue(rules, now) {
    if (!emailReady(this.env) || !this.eventsKnown()) return [];
    const time = new LairTime(rules.tz);
    const hour = time.parts(now).h;
    if (hour < REMIND_FROM_HOUR || hour >= REMIND_UNTIL_HOUR) return [];
    const today = time.key(now);
    const rows = this.sql
      .exec(
        `SELECT * FROM bookings WHERE kind = 'gm-seat' AND first_game = 1 AND followup_ok = 1 AND followup_at IS NULL AND status IN ('seated', 'done')
           AND starts_at >= ? AND starts_at < ? ORDER BY starts_at, rowid`,
        time.at(addDays(today, -1), 0), time.at(today, 0),
      )
      .toArray();
    const due = [];
    for (const row of rows) {
      if (due.length >= REMINDERS_A_RUN) break;
      const x = this.rowToBooking(row);
      if (!isEmail(x.email) || this.followupStopped(x.email)) continue;
      const game = x.gameId ? this.game(x.gameId) : null;
      if (this.nextDayTaken(x, game)) continue;
      due.push({ x, row, game });
    }
    return due;
  },

  /**
   * Whether they've taken up that game already, so there's nothing to ask: a seat of theirs (their account, or their
   * email) in a later session of it, or a weekly seat they've saved in it. A one-shot has neither. No awaits.
   */
  nextDayTaken(x, game) {
    if (!game?.seriesId) return false;
    const id = x.customerId ? String(x.customerId) : '';
    if (id && this.sql.exec("SELECT 1 AS n FROM series_members WHERE series_id = ? AND customer_id = ? AND status = 'active'", game.seriesId, id).toArray().length) return true;
    return this.sql
      .exec(
        `SELECT 1 AS n FROM bookings b JOIN games g ON g.id = b.game_id
          WHERE g.series_id = ? AND b.kind = 'gm-seat' AND b.status IN ('held', 'confirmed', 'seated', 'done') AND b.starts_at > ?
            AND ((? != '' AND b.customer_id = ?) OR lower(b.email) = ?) LIMIT 1`,
        game.seriesId, x.start, id, id, lowerEmail(x.email),
      )
      .toArray().length > 0;
  },

  /**
   * Send what claimNextDay made, in one batch. Resend down or busy (5xx, 429): the rows this run marked are unmarked, so
   * the next run tries again (their keys stay); anything else (an address Resend refused) isn't tried again. After the
   * await only these rows' followup_at changes, and only where this run set it.
   */
  async deliverNextDay(claim) {
    const result = await this.mailMany(claim.letters);
    if (!result.ok && (result.status >= 500 || result.status === 429)) {
      for (const id of claim.ids) this.write('UPDATE bookings SET followup_at = NULL WHERE id = ? AND followup_at = ?', id, claim.at);
    }
    return result;
  },

  /**
   * The email the day after (Gobgob signs it; the footer has the shop's details). A weekly game whose next session has
   * seats (mockup D3): the thanks, the same table, "Save my seat every week" (the GM games page, opening that session's
   * join sheet with every week picked), "Just next Sunday" (the same, one-off) and "Try a different game", then the next
   * session, its seats left and their loyalty card, and the other beginner games with seats this week (left out when
   * none). Anything else is built the same way (Mo, 6 Nov 2026: "This one is the best please use that"): the soonest
   * beginner game with seats this week, "Save me a seat" (its join sheet) and "Try a different game", then when it is,
   * its seats left, their card and the others; with none, "Fancy another?", Find your next game and their card. All end
   * with "Don't send me emails like this", and carry the one-click unsubscribe headers. d: a claimed email. No awaits.
   */
  nextDayLetter(d, rules, now) {
    const W = FIRST_GAME_WORDS;
    const time = new LairTime(rules.tz);
    const { x, game } = d;
    const name = firstWord(x.name);
    const title = game?.title || 'your game';
    const thanks = W.thanks(title, weekdayOf(x.start, rules.tz), name);
    const gm = this.page('gm');
    const beginners = this.beginnerSessionsWithSeats(rules, now, { exceptSeries: game?.seriesId || null, exceptGame: game?.id || null });
    const others = beginners.length;
    const card = [CARD_ROW, this.cardLine(x.customerId, rules)];
    const lair = String(this.env.PUBLIC_URL || 'https://dice-goblin-lair.dicegoblinnz.workers.dev').replace(/\/$/, '');
    const unsubscribe = { label: W.unsubscribe, url: `${this.page('myLair')}#unsubscribe=${encodeURIComponent(x.ref)}.${d.key}` };
    const extra = { headers: { 'List-Unsubscribe': `<${lair}/unsubscribe/${encodeURIComponent(x.ref)}/${d.key}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
    const next = game?.seriesId && game.schedule === 'weekly' ? this.upcomingSession(game.seriesId, now) : null;
    const left = next ? this.publicSeatsLeft(next, rules) : 0;
    if (next && left > 0) {
      const day = weekdayOf(next.start, rules.tz);
      const price = seatPriceOf(next, rules);
      const join = `${gm}?join=${encodeURIComponent(next.id)}`;
      return this.letter(x.email, W.subject(name), {
        title: W.title,
        preheader: W.preheader(title, day),
        intro: [thanks, [W.sameTable(day, clockLabel(time.minutesOf(next.start))), price ? W.payEach(money(price)) : ''].filter(Boolean).join(' ')],
        button: { label: W.save, url: `${join}&every=1` },
        links: [{ label: W.justNext(day), url: join }, { label: W.different, url: gm }],
        details: [
          [W.nextSession, `${longDay(next.start, rules.tz)}, ${clockLabel(time.minutesOf(next.start))} to ${clockLabel(time.minutesOf(next.end))}`],
          [W.seatsLeft, String(left)],
          card,
        ],
        detailsAfter: true,
        outro: others > 0 ? W.others(others) : [],
        unsubscribe,
      }, extra);
    }
    const pick = beginners[0];
    if (pick) {
      const p = pick.g;
      const today = time.key(now);
      const day = time.key(p.start);
      const on = day === today ? 'today' : day === addDays(today, 1) ? 'tomorrow' : `on ${weekdayOf(p.start, rules.tz)}`;
      const clock = clockLabel(time.minutesOf(p.start));
      const price = seatPriceOf(p, rules);
      return this.letter(x.email, W.subject(name), {
        title: W.title,
        preheader: W.pickPreheader(p.title, on),
        intro: [thanks, [W.pick(p.title, on, clock), price ? W.payOnDay(money(price)) : ''].filter(Boolean).join(' ')],
        button: { label: W.saveOne, url: `${gm}?join=${encodeURIComponent(p.id)}` },
        links: [{ label: W.different, url: gm }],
        details: [
          [W.when, `${longDay(p.start, rules.tz)}, ${clock} to ${clockLabel(time.minutesOf(p.end))}`],
          [W.seatsLeft, String(pick.left)],
          card,
        ],
        detailsAfter: true,
        outro: others > 1 ? W.others(others - 1) : [],
        unsubscribe,
      }, extra);
    }
    return this.letter(x.email, W.subject(name), {
      title: W.title, intro: [thanks, W.none], button: { label: W.find, url: gm }, details: [card], detailsAfter: true, unsubscribe,
    }, extra);
  },

  /** A session's seats anyone can book now, as the board counts them (regulars' held seats and kept seats taken). No awaits. */
  publicSeatsLeft(g, rules) {
    const view = this.gameView(g, this.state(g.start - 1, g.end + 1), rules);
    return view.status === 'open' ? Math.max(0, view.seats - view.taken) : 0;
  },

  /**
   * Beginner games with seats this week, soonest first, as the website's front door finds them: public sessions (not
   * private, open, with a seat left) for new players (level 'new'), starting in the next BEGINNER_DAYS days, a series'
   * next session only (the one the public board shows). exceptSeries, exceptGame: the game they played. No awaits.
   * → [{ g, left }]
   */
  beginnerSessionsWithSeats(rules, now, { exceptSeries = null, exceptGame = null } = {}) {
    const until = now + BEGINNER_DAYS * 24 * 3_600_000;
    const st = this.state(now, until + 1);
    const info = this.seriesInfo(now);
    const found = [];
    for (const g of st.games) {
      if (!(g.start > now && g.start <= until) || g.private || g.level !== 'new' || g.id === exceptGame) continue;
      if (g.seriesId && (g.seriesId === exceptSeries || info.next.get(g.seriesId) !== g.id)) continue;
      const view = this.gameView(g, st, rules, info);
      if (view.status === 'open' && view.seats - view.taken > 0) found.push({ g, left: view.seats - view.taken });
    }
    return found.sort((a, b) => a.g.start - b.g.start || String(a.g.id).localeCompare(String(b.g.id)));
  },

  /* ---------------- "Don't send me emails like this" ---------------- */
  /** Whether that email has stopped these emails. No awaits. */
  followupStopped(email) {
    const mail = lowerEmail(email);
    return Boolean(mail) && this.sql.exec('SELECT 1 AS n FROM followup_stops WHERE email = ?', mail).toArray().length > 0;
  },

  /**
   * The first game an unsubscribe link is for: its code (ref) and key, the key compared in constant time (against a
   * stand-in when there's none to compare with). One answer for a wrong key, a code that isn't a first game's email, and
   * either left out; CANCEL_TRIES of those from one place in 10 minutes and it has to wait. No awaits. → its booking
   */
  unsubscribeItem(input, client, now) {
    const where = String(client || '-');
    if (!this.stopMisses) this.stopMisses = new Map();
    const misses = (this.stopMisses.get(where) || []).filter((t) => now - t < STOP_TRIES_WINDOW);
    if (misses.length >= CANCEL_TRIES) throw new RuleError(UNSUBSCRIBE_WORDS.tooMany, 429);
    const ref = typeof input?.ref === 'string' ? input.ref.trim().slice(0, 40) : '';
    const key = typeof input?.key === 'string' ? input.key.trim().slice(0, 64) : '';
    const row = ref ? this.sql.exec("SELECT * FROM bookings WHERE ref = ? AND kind = 'gm-seat'", ref).toArray()[0] : null;
    const stored = row?.followup_key || '';
    if (!(safeEqual(key || '-', stored || NO_KEY) && Boolean(stored) && Boolean(key))) {
      misses.push(now);
      if (this.stopMisses.size > 2000) this.stopMisses.clear();
      this.stopMisses.set(where, misses);
      throw new RuleError(UNSUBSCRIBE_WORDS.wrong, 404);
    }
    return this.rowToBooking(row);
  },

  /** POST /unsubscribe/view { ref, key } (anyone with the link): { link: { stopped } }, and nothing else about anyone. No awaits. */
  unsubscribeView(input, client = '') {
    const x = this.unsubscribeItem(input, client, Date.now());
    return { link: { stopped: this.followupStopped(x.email) } };
  },

  /**
   * POST /unsubscribe/stop { ref, key }: the tap. Its email goes on the stop list straight away (lower case, with when,
   * the code and how: 'link', or 'one-click' from the mail app), so no follow-up goes to it again. → { ok, already }.
   * No awaits.
   */
  unsubscribeStop(input, client = '', via = 'link') {
    const now = Date.now();
    const x = this.unsubscribeItem(input, client, now);
    const mail = lowerEmail(x.email);
    const already = this.followupStopped(mail);
    if (mail && !already) {
      this.write('INSERT OR IGNORE INTO followup_stops (email, at, ref, via) VALUES (?, ?, ?, ?)', mail, now, x.ref, via);
      // on to Shopify's email marketing setting, in the background (the 10-minute run tries again if it can't)
      this.later(this.pushStopsToShopify(now));
    }
    return { ok: true, already };
  },

  /**
   * The stop list reaching Shopify. Someone who used "Don't send me emails like this" has withdrawn consent to all of
   * Dice Goblin's marketing emails (the Unsolicited Electronic Messages Act 2007, sections 9(2) and 11(1)(a)), not just
   * these, so the customer with that email is set to unsubscribed in Shopify's email marketing setting (Shopify's one
   * list of who may get them) when it has them subscribed or pending. Straight after the tap, then by the 10-minute run
   * until Shopify takes it (Shopify down, or the write_customers permission not approved yet). One push at a time, each
   * after the last, so no stop is sent twice. → { done, failed }, or null with nothing to send or no Shopify.
   */
  pushStopsToShopify(now = Date.now()) {
    const run = (this.stopsPush || Promise.resolve()).catch(() => null).then(() => this.pushStopsOnce(now));
    this.stopsPush = run;
    return run;
  },

  /** One push of the stops not in Shopify yet, at most STOPS_A_RUN: every await first, then the marks. → as pushStopsToShopify */
  async pushStopsOnce(now) {
    if (!this.shopify.configured) return null;
    const rows = this.sql.exec('SELECT email, at FROM followup_stops WHERE shopify_at IS NULL ORDER BY at LIMIT ?', STOPS_A_RUN).toArray();
    if (!rows.length) return null;
    const done = [];
    const failed = [];
    for (const r of rows) {
      try {
        const m = await this.shopify.marketingByEmail(r.email);
        if (m && (m.state === 'SUBSCRIBED' || m.state === 'PENDING')) await this.shopify.unsubscribeMarketing(m.customerId, r.at);
        done.push(r.email);
      } catch (error) {
        failed.push({ email: r.email, error: String(error?.message || error).slice(0, 300) });
      }
    }
    // --- no awaits from here ---
    for (const email of done) this.write('UPDATE followup_stops SET shopify_at = ?, shopify_error = NULL WHERE email = ? AND shopify_at IS NULL', now, email);
    for (const f of failed) this.write('UPDATE followup_stops SET shopify_tries = COALESCE(shopify_tries, 0) + 1, shopify_error = ? WHERE email = ? AND shopify_at IS NULL', f.error, f.email);
    return { done: done.length, failed: failed.length };
  },

  /**
   * The one-click unsubscribe on the Lair's own address (index.js: /unsubscribe/<code>/<key>, RFC 8058). The mail app's
   * POST stops it (200, plain words); a GET or HEAD (someone opening it, or a scanner) only goes on to the page that asks
   * (303 to My Lair with the link in its #fragment) and stops nothing. body: { ref, key, stop, client }. → a Response.
   */
  oneClickUnsubscribe(body) {
    const plain = (status, text) => new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    const ref = String(body?.ref || '');
    const key = String(body?.key || '');
    if (!body?.stop) {
      return new Response(null, { status: 303, headers: { Location: `${this.page('myLair')}#unsubscribe=${encodeURIComponent(ref)}.${encodeURIComponent(key)}`, 'Cache-Control': 'no-store' } });
    }
    try {
      this.unsubscribeStop({ ref, key }, body.client || '', 'one-click');
      return plain(200, UNSUBSCRIBE_WORDS.done);
    } catch (error) {
      if (error instanceof RuleError) return plain(error.status, error.message);
      throw error;
    }
  },
};

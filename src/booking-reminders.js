/**
 * Round 29, roleplayers phase 1, item 1: "Reminders" (contract v29-roleplayers section 2). Mo approved it on 2 Nov 2026
 * (the plan's item 1, mockup D1 "warm first"): an email two days before each one-off booking, so people come, or let the
 * seat go while someone else can still have it.
 *
 * - Who: a confirmed one-off TTRPG seat (kind 'gm-seat' with no series_id: a weekly regular's saved seat has one, and gets
 *   none) on a session that's live ('open', or full), a confirmed table (kind 'table'; one at an event only while its date
 *   is on the calendar) and a confirmed event sign-up whose date is on the calendar, each with an email. Never a walk-in,
 *   a held or cancelled booking, a GM's charge for a player's seat ('gm-cover'), the GM's own booking ('gm'), or a session
 *   that's cancelled or waiting for approval.
 * - When: on the Lair day two days before the day it starts, from 9am, never from 9pm (reminders.js's window), once, and
 *   only for what was booked before that day began (anything booked later had its confirmation just now). If none went
 *   that day (Resend down all day), it can go the next day, 9am to 9pm, while it can still be cancelled free or has
 *   nothing to pay; never on the day itself. A booking that moves gets one again for its new time: reminded_start is the
 *   start it went for. At most REMINDERS_A_RUN a run, with the event reminders' batch rules: claimed before it's sent,
 *   and unmarked for the next run when Resend is down or busy (5xx, 429).
 * - Theme settings › Lair bookings › "Email a reminder two days before each booking" (lair_booking_reminders, on unless
 *   it's off) stops them. None go while the Lair has only its built-in rules (Shopify unread): a later run catches up.
 * - The cancel link: claiming a reminder gives its booking or sign-up a random cancel_key (kept from then on), and the
 *   email's link (/pages/my-lair?cancel=<code>&key=<key>) works without logging in. POST /cancel-links/view says what it
 *   is and whether it can be cancelled now; POST /cancel-links/cancel cancels it by the person's own path in My Lair
 *   (cancelOwnBooking and cancelOwnJoin in lair.js), with its rules and side effects. The key only ever cancels.
 * - GET /ics/b/<booking id>.ics: a seat or table as a calendar file, with nothing about the person in it.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair; each
 * keeps its rule: every await first, then one synchronous read-check-write.
 */
import { HOUR, MIN, LairTime, ONLINE_WORDS, RuleError, TAB_WORDS, addDays, findOccurrence } from './core.js';
import { emailReady, safeEqual } from './shopify.js';
import { clockLabel } from './email.js';
import { GM_COVER_WORDS } from './gm-cover.js';
import { seatPriceOf } from './gm-sessions.js';
import { REMIND_FROM_HOUR, REMIND_UNTIL_HOUR, REMINDERS_A_RUN, icsFold, icsText, stamp } from './reminders.js';

/**
 * Made sure of on every start (added when missing), as round 15's columns are:
 *  - reminded_at: when this run's reminder was claimed (null again if Resend was down, so the next run sends it);
 *  - reminded_start: the start it went for, so a booking that moves gets one again;
 *  - cancel_key: the cancel link's key (32 hex characters), made when its first reminder is claimed and kept.
 */
export const BOOKING_REMINDER_COLUMNS = [
  ['bookings', 'reminded_at', 'INTEGER'], ['bookings', 'reminded_start', 'INTEGER'], ['bookings', 'cancel_key', 'TEXT'],
  ['event_joins', 'reminded_at', 'INTEGER'], ['event_joins', 'reminded_start', 'INTEGER'], ['event_joins', 'cancel_key', 'TEXT'],
];
/** Monday's numbers count the reminders that went in a week (only reminded rows are in these) */
export const BOOKING_REMINDER_INDEXES = [
  'CREATE INDEX IF NOT EXISTS bookings_reminded ON bookings (reminded_at) WHERE reminded_at IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS event_joins_reminded ON event_joins (reminded_at) WHERE reminded_at IS NOT NULL',
];
/** Wrong cancel links from one place in CANCEL_TRIES_WINDOW before it's asked to wait */
export const CANCEL_TRIES = 10;
const CANCEL_TRIES_WINDOW = 10 * MIN;
/** Compared against when there's no key to compare with, so a wrong code takes as long as a wrong key */
const NO_KEY = '0'.repeat(32);

/** Everything the reminder says, word for word in the contract (D1, "warm first"; Gobgob signs it) */
export const BOOKING_REMINDER_WORDS = {
  subject: (day, clock) => `See you ${day} at ${clock}?`,
  title: (day, name) => (name ? `See you ${day}, ${name}?` : `See you ${day}?`),
  seat: (title, people) => (people > 1 ? `Your ${people} seats at ${title} are saved.` : `Your seat at ${title} is saved.`),
  counting: (others) => (others > 0 ? `Your GM and ${others} ${others === 1 ? 'player' : 'players'} are counting on you.` : 'Your GM is counting on you.'),
  table: (people, event) => `Your table for ${people}${event ? ` at ${event}` : ''} is saved.`,
  place: (title, people) => (people > 1 ? `Your ${people} places at ${title} are saved.` : `Your place at ${title} is saved.`),
  /** The preheader's second sentence, while it's free to cancel */
  freeUntil: (until) => `Cancel free until ${until}.`,
  /** "On your tab" */
  due: (amount) => `${amount}, paid at the counter on the day`,
  part: (due, paid, amount) => `${due} left to pay at the counter on the day (${paid} of ${amount} paid)`,
  paid: (amount) => `${amount}, paid already. Thank you!`,
  paidOnline: (amount) => `${amount}, paid online. Thank you!`,
  covered: (people) => `Nothing: your GM's paying for your ${people > 1 ? 'seats' : 'seat'}`,
  nothing: 'Nothing to pay',
  /** What cancelling frees up */
  back: {
    seat: (people) => (people > 1 ? 'your seats go back on the board for someone else' : 'your seat goes back on the board for someone else'),
    table: () => 'your table goes back for someone else',
    signup: (people) => (people > 1 ? 'your places go to someone else' : 'your place goes to someone else'),
  },
  /** The cancel paragraph, from the booking's cancelRule */
  cancelFree: (until, back) => `Can't make it? Cancel free until ${until} and ${back}.`,
  afterTab: (due) => `After that, the ${due} stays on your tab.`,
  afterGuest: "After that it's yours to pay, even if you can't come.",
  afterCovered: (full) => `After that, if you can't come, the full ${full} goes on your tab.`,
  afterCoveredGuest: (full) => `After that, if you can't come, the full ${full} is yours to pay.`,
  paidBack: (until, back, amount) => `Can't make it? Cancel free until ${until} and ${back}, and you'll get your ${amount} back. After that it stays paid, even if you can't come.`,
  anyTime: (back) => `Can't make it? Cancel in My Lair and ${back}.`,
  anyTimeGuest: (back) => `Can't make it? Cancel with the link above and ${back}.`,
  /** The button and the links under it */
  calendar: 'Add to my calendar',
  google: 'Google Calendar',
  myLair: 'See it in My Lair',
  cancel: {
    seat: (people) => (people > 1 ? 'Cancel my seats' : 'Cancel my seat'),
    table: () => 'Cancel my table',
    signup: () => 'Cancel my sign-up',
  },
  /** The calendar file and Google Calendar: what it is and a My Lair link, nothing about the person */
  seatEntry: (title) => `${title} at Dice Goblin`,
  tableEntry: (people, event) => (event ? `${event} at Dice Goblin` : `Table for ${people} at Dice Goblin`),
  inMyLair: (url) => `See it in My Lair: ${url}`,
  missing: 'That booking could not be found.',
};

/** What the cancel link's routes say when they can't, word for word in the contract (and the existing TAB_WORDS) */
export const CANCEL_LINK_WORDS = {
  /** A wrong key, a code that isn't a reminded booking or sign-up, or either left out: never saying which */
  wrong: "That cancel link doesn't work. Check you have the whole link from your email.",
  cancelled: "That's cancelled already.",
  tooMany: 'Too many tries. Wait a few minutes and try again, or give us a call.',
};

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const money = (cents) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
/** "Sunday 8 November" and "Sunday" in the Lair's time zone (some ICU versions put a comma after the weekday) */
const longDay = (ms, tz) => new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(ms)).replace(/,/g, '');
const weekdayOf = (ms, tz) => new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'long' }).format(new Date(ms));
/** The free-cancel deadline as people say it, in Lair time: "6pm Saturday", "midday Saturday" */
const deadline = (ms, time) => `${clockLabel(time.minutesOf(ms))} ${weekdayOf(ms, time.tz)}`;
/** A first name for "See you Sunday, Ria?": the first word of the name on it, or none */
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
/** What's left to pay (lair.js's dueOf): nothing once it's paid or waived */
const owing = (x) => (x.paid || x.waived ? 0 : Math.max(0, (x.amount || 0) - (x.covered || 0) - (x.paidAmount || 0)));
/** A session people can come to: on the board, full or not */
const live = (game) => Boolean(game) && ['open', 'full'].includes(game.status);
const slug = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export const bookingReminderMethods = {
  /* ---------------- the reminders ---------------- */
  /** The 10-minute run's booking reminders: claims the ones due at `now` and sends them in the background. → summary or null. No awaits. */
  sendBookingReminders(rules, now) {
    const claim = this.claimBookingReminders(rules, now);
    if (!claim) return null;
    this.later(this.deliverBookingReminders(claim));
    return claim.summary;
  },

  /**
   * Which booking reminders are due at `now`, Lair time, marked as sent (with the start they're for and the cancel key)
   * before anything goes, so none ever goes twice. Only from 9am to 9pm. At most REMINDERS_A_RUN (any more go in the
   * next run). No awaits. → { at, items: [{ table, id }], letters, summary: { sent, seats, tables, signUps } } or null.
   */
  claimBookingReminders(rules, now) {
    if (!emailReady(this.env) || rules?.bookingReminders === false || !this.eventsKnown()) return null;
    const time = new LairTime(rules.tz);
    const hour = time.parts(now).h;
    if (hour < REMIND_FROM_HOUR || hour >= REMIND_UNTIL_HOUR) return null;
    const today = time.key(now);
    // starting tomorrow (its reminder day was yesterday: the catch-up) or the day after (today's its reminder day)
    const from = time.at(addDays(today, 1), 0);
    const to = time.at(addDays(today, 3), 0);
    const due = [];
    const bookings = this.sql
      .exec(
        `SELECT * FROM bookings WHERE kind IN ('table', 'gm-seat') AND status = 'confirmed' AND series_id IS NULL
           AND ends_at > ? AND ends_at < ? AND starts_at >= ? AND starts_at < ?
           AND (reminded_at IS NULL OR reminded_start IS NULL OR reminded_start != starts_at)
         ORDER BY starts_at, rowid`,
        from, to + 2 * 24 * HOUR, from, to,
      )
      .toArray();
    for (const row of bookings) {
      if (due.length >= REMINDERS_A_RUN) break;
      const x = this.rowToBooking(row);
      if (!isEmail(x.email)) continue;
      const game = x.kind === 'gm-seat' ? this.game(x.gameId) : null;
      if (x.kind === 'gm-seat' && !live(game)) continue;
      const o = x.occurrenceId ? findOccurrence(rules, x.occurrenceId) : null;
      if (x.occurrenceId && !o) continue;
      if (!this.reminderDue(x, x.start, rules, now, time, today)) continue;
      due.push({ table: 'bookings', type: x.kind === 'gm-seat' ? 'seat' : 'table', x, row, game, o, start: x.start, end: x.end });
    }
    // sign-ups go by their date as the calendar has it now (a time changed in Shopify), so a day either side is read
    const joins = this.sql
      .exec(
        `SELECT * FROM event_joins WHERE status = 'confirmed' AND ends_at > ? AND ends_at < ? AND starts_at >= ? AND starts_at < ?
         ORDER BY starts_at, rowid`,
        from - 24 * HOUR, to + 3 * 24 * HOUR, from - 24 * HOUR, to + 24 * HOUR,
      )
      .toArray();
    for (const row of joins) {
      if (due.length >= REMINDERS_A_RUN) break;
      const x = this.rowToJoin(row);
      if (!isEmail(x.email)) continue;
      const o = findOccurrence(rules, x.occurrenceId);
      if (!o || o.end <= now || o.start < from || o.start >= to) continue;
      if (row.reminded_at && Number(row.reminded_start) === o.start) continue;
      if (!this.reminderDue(x, o.start, rules, now, time, today)) continue;
      due.push({ table: 'event_joins', type: 'signup', x, row, game: null, o, start: o.start, end: o.end });
    }
    due.sort((a, b) => a.start - b.start);
    if (!due.length) return null;
    // --- marked as sent first, with its key: a reminder never goes twice, and a booking keeps one key ---
    for (const d of due) {
      d.key = d.row.cancel_key || crypto.randomUUID().replace(/-/g, '');
      this.write(`UPDATE ${d.table} SET reminded_at = ?, reminded_start = ?, cancel_key = COALESCE(cancel_key, ?) WHERE id = ?`, now, d.start, d.key, d.x.id);
    }
    const count = (type) => due.filter((d) => d.type === type).length;
    return {
      at: now, items: due.map((d) => ({ table: d.table, id: d.x.id })), letters: due.map((d) => this.bookingReminderLetter(d, rules, now)),
      summary: { sent: due.length, seats: count('seat'), tables: count('table'), signUps: count('signup') },
    };
  },

  /**
   * Due today, at `now`: today is the reminder day (two days before the day it starts), or the day after it (the
   * catch-up: none went on the reminder day, it can still be cancelled free or has nothing to pay, and these reminders
   * were running that day, so their first start doesn't remind everything booked for tomorrow), and it was booked
   * before the reminder day began. Never on the day itself. No awaits.
   */
  reminderDue(x, start, rules, now, time, today) {
    const day = time.key(start);
    const remindDay = addDays(day, -2);
    if (today !== remindDay && today !== addDays(day, -1)) return false;
    if (!((x.createdAt ?? now) < time.at(remindDay, 0))) return false;
    if (today === remindDay) return true;
    if (Number(this.bookingRemindersFrom || 0) >= time.at(remindDay, REMIND_UNTIL_HOUR * 60)) return false;
    return !this.cancelRule(x, rules, now).locked;
  },

  /**
   * Send what claimBookingReminders made, in one batch. Resend down or busy (5xx, 429): the rows this run marked are
   * unmarked, so the next run tries again (their cancel keys stay); anything else (an address Resend refused) isn't tried
   * again. After the await only these rows' reminded_at changes, and only where this run set it.
   */
  async deliverBookingReminders(claim) {
    const result = await this.mailMany(claim.letters);
    if (!result.ok && (result.status >= 500 || result.status === 429)) {
      for (const { table, id } of claim.items) this.write(`UPDATE ${table} SET reminded_at = NULL WHERE id = ? AND reminded_at = ?`, id, claim.at);
    }
    return result;
  },

  /**
   * The reminder (D1, warm first; Gobgob signs it): "See you Sunday, Ria?", what's saved and who's counting on them, the
   * details as its confirmation had them (when, the game, table or event, where, what's on their tab, and the loyalty
   * card once that's merged), Add to my calendar, Google Calendar, My Lair (members), the cancel link while the rules let
   * them cancel online, and what cancelling means, from cancelRule. d: a claimed reminder. No awaits.
   */
  bookingReminderLetter(d, rules, now) {
    const W = BOOKING_REMINDER_WORDS;
    const time = new LairTime(rules.tz);
    const { x, type, game, o } = d;
    const people = Math.max(1, Number(x.people) || 1);
    const day = weekdayOf(d.start, rules.tz);
    const when = `${longDay(d.start, rules.tz)}, ${clockLabel(time.minutesOf(d.start))} to ${clockLabel(time.minutesOf(d.end))}`;
    const rule = this.cancelRule(x, rules, now);
    const until = rule.lockable && !rule.locked ? deadline(rule.cancelUntil, time) : null;
    const canCancel = !rule.locked && d.start > now;
    let saved;
    let intro;
    const details = [['When', when]];
    if (type === 'seat') {
      saved = W.seat(game.title, people);
      intro = `${saved} ${W.counting(Math.max(0, this.takenSeats(game.id) - people))}`;
      // "Candlekeep Mysteries, D&D 5e"; a game named for its system ("Monster of the Week") says it once
      const system = String(game.system || '').trim();
      const named = system && system.toLowerCase() !== String(game.title).trim().toLowerCase() ? `${game.title}, ${system}` : game.title;
      details.push(['Game', named], ['Players', people > 1 ? this.partyLine(x.party) : '']);
    } else if (type === 'table') {
      saved = W.table(people, o?.title || null);
      intro = saved;
      if (o) details.push(['Event', o.title]);
      details.push([x.tables.length > 1 ? 'Tables' : 'Table', x.tables.join(', ')]);
    } else {
      saved = W.place(o.title, people);
      intro = saved;
      details.push(['Event', o.title], ['Coming', people > 1 ? this.comingLine(x) : '']);
    }
    details.push(['Where', this.lairWhere({ start: d.start }, rules)], this.reminderTabRow(d, rules));
    // the loyalty card's line (the loyalty card round adds cardLine)
    const customerId = x.customerId;
    if (customerId && typeof this.cardLine === 'function') {
      const line = this.cardLine(customerId, rules);
      if (line) details.push(['Loyalty card', line]);
    }
    const prefix = { seat: 'st', table: 'bk', signup: 'ej' }[type];
    const myLair = this.page('myLair');
    const links = [{ label: W.google, url: this.reminderGoogleLink(d, rules) }];
    if (x.customerId) links.push({ label: W.myLair, url: `${myLair}?view=ml-${prefix}-${encodeURIComponent(x.ref)}` });
    if (canCancel) links.push({ label: W.cancel[type](people), url: `${myLair}?cancel=${encodeURIComponent(x.ref)}&key=${d.key}` });
    const ics = type === 'signup' ? this.icsLink(o) : `${String(this.env.PUBLIC_URL || 'https://dice-goblin-lair.dicegoblinnz.workers.dev').replace(/\/$/, '')}/ics/b/${encodeURIComponent(x.id)}.ics`;
    return this.letter(x.email, W.subject(day, clockLabel(time.minutesOf(d.start))), {
      title: W.title(day, firstName(x.name)),
      preheader: until && canCancel ? `${saved} ${W.freeUntil(until)}` : `${saved} ${when}.`,
      intro,
      details,
      button: { label: W.calendar, url: ics },
      links,
      outro: this.reminderCancelLine(d, rules, rule, until),
    });
  },

  /** The reminder's "On your tab" row (a sign-up with nothing to pay says what its event says about entry). No awaits. */
  reminderTabRow(d, rules) {
    const W = BOOKING_REMINDER_WORDS;
    const { x, type, game, o } = d;
    const people = Math.max(1, Number(x.people) || 1);
    const amount = x.amount || 0;
    const paidSoFar = x.paidAmount || 0;
    const due = owing(x);
    if (type === 'seat' && x.coveredBy && !game?.free) return ['On your tab', W.covered(people)];
    if (x.paid && x.pay === 'now' && amount > 0) return ['On your tab', W.paidOnline(money(paidSoFar || amount))];
    if (amount > 0 && !x.waived && due === 0) return ['On your tab', W.paid(money(paidSoFar || amount))];
    if (due > 0 && paidSoFar > 0) return ['On your tab', W.part(money(due), money(paidSoFar), money(amount))];
    if (due > 0) return ['On your tab', W.due(money(due))];
    if (type === 'signup' && !amount && !x.waived) {
      const said = this.eventPriceLine(o, (rules.events || []).find((e) => e.id === o.eventId) || {});
      if (said) return ['Entry', said];
    }
    return ['On your tab', W.nothing];
  },

  /**
   * What cancelling means, from cancelRule, never promising what the rules don't allow: free until the deadline (then
   * on their tab, theirs to pay, or the full price for a seat their GM pays for), any time before it starts (nothing to
   * pay, nothing locks), or locked in already (the tab's words). Paid online before round 15: its confirmation's words.
   * No awaits.
   */
  reminderCancelLine(d, rules, rule, until) {
    const W = BOOKING_REMINDER_WORDS;
    const { x, type, game } = d;
    const people = Math.max(1, Number(x.people) || 1);
    const member = Boolean(x.customerId);
    const back = W.back[type](people);
    const covered = type === 'seat' && Boolean(x.coveredBy) && !game?.free;
    if (x.paid && x.pay === 'now' && (x.amount || 0) > 0) return type === 'signup' || x.occurrenceId ? ONLINE_WORDS.lockedIn : ONLINE_WORDS.refund(rules.refundHours);
    if (rule.locked) {
      if (covered) return GM_COVER_WORDS.seatLocked(rules.refundHours);
      return member ? TAB_WORDS.lockedNow(rules.refundHours) : TAB_WORDS.lockedNowGuest(rules.refundHours);
    }
    if (!rule.lockable) return member ? W.anyTime(back) : W.anyTimeGuest(back);
    if (covered) {
      const full = money(seatPriceOf(game, rules) * people);
      return `${W.cancelFree(until, back)} ${member ? W.afterCovered(full) : W.afterCoveredGuest(full)}`;
    }
    const due = owing(x);
    const paidSoFar = x.paidAmount || 0;
    if (!due && paidSoFar > 0) return W.paidBack(until, back, money(paidSoFar));
    if (!due) return W.cancelFree(until, back);
    return `${W.cancelFree(until, back)} ${member ? W.afterTab(money(due)) : W.afterGuest}`;
  },

  /** Google Calendar for a reminder: a sign-up's event as round 11 makes it; a seat or table with nothing personal in it */
  reminderGoogleLink(d, rules) {
    if (d.type === 'signup') {
      const ev = (rules.events || []).find((e) => e.id === d.o.eventId) || {};
      return this.googleLink(d.o, rules, this.eventPriceLine(d.o, ev));
    }
    const query = new URLSearchParams({
      action: 'TEMPLATE', text: this.bookingEntryTitle(d.x, d.game, d.o), dates: `${stamp(d.start)}/${stamp(d.end)}`,
      details: BOOKING_REMINDER_WORDS.inMyLair(this.page('myLair')), location: this.lairPlace(rules), ctz: rules.tz,
    });
    return `https://calendar.google.com/calendar/render?${query}`;
  },

  /** A seat's or table's calendar title: "Candlekeep Mysteries at Dice Goblin", "Table for 4 at Dice Goblin". No awaits. */
  bookingEntryTitle(x, game, o) {
    const W = BOOKING_REMINDER_WORDS;
    return x.kind === 'gm-seat' ? W.seatEntry(game?.title || 'TTRPG session') : W.tableEntry(Math.max(1, Number(x.people) || 1), o?.title || null);
  },

  /**
   * GET /ics/b/<booking id>.ics (public: the booking's own id, 64 random bits, is the proof): a seat or table that gets
   * reminders, as a calendar file: its title, times, place and a My Lair link (one UID per booking, so adding it again
   * updates it), never a name, email, phone or code. 404 for anything else: an unknown id, cancelled or over, a weekly
   * saved seat, a walk-in, the GM's own booking, a session that isn't live, or an event date that's gone.
   */
  async bookingIcs(id) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const W = BOOKING_REMINDER_WORDS;
    const missing = () => new Response(W.missing, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    const key = String(id || '');
    const row = /^bk_[A-Za-z0-9]{8,40}$/.test(key) ? this.sql.exec('SELECT * FROM bookings WHERE id = ?', key).toArray()[0] : null;
    if (!row || !['table', 'gm-seat'].includes(row.kind) || row.series_id || !['confirmed', 'seated', 'done'].includes(row.status)) return missing();
    const x = this.rowToBooking(row);
    const game = x.kind === 'gm-seat' ? this.game(x.gameId) : null;
    if (x.kind === 'gm-seat' && !live(game)) return missing();
    if (x.occurrenceId && this.dateGone(rules, x.occurrenceId)) return missing();
    const o = x.occurrenceId ? findOccurrence(rules, x.occurrenceId) : null;
    const title = this.bookingEntryTitle(x, game, o);
    const url = this.page('myLair');
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Dice Goblin//Lair bookings//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
      `UID:${x.id}@dicegoblin.nz`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(x.start)}`, `DTEND:${stamp(x.end)}`,
      `SUMMARY:${icsText(title)}`, `DESCRIPTION:${icsText(W.inMyLair(url))}`, `LOCATION:${icsText(this.lairPlace(rules))}`, `URL:${url}`,
      'END:VEVENT', 'END:VCALENDAR',
    ].map(icsFold).join('\r\n');
    const name = slug(game ? game.title : o ? o.title : 'table') || 'booking';
    return new Response(`${ics}\r\n`, {
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="dice-goblin-${name}.ics"`, 'Cache-Control': 'private, no-cache' },
    });
  },

  /* ---------------- the cancel link: one tap, no login ---------------- */
  /**
   * POST /cancel-links/view { ref, key } (anyone: the reminder's key is the proof): what the link would cancel, and only
   * that: { link: { kind ('seat', 'table' or 'signup'), title (the game or event, null for a plain table), when ("Sunday
   * 8 November, 6pm"), people, cancellable, until (the free-cancel deadline, "6pm Saturday", while there is one), reason
   * (why not, in the existing words) } }. Never a name, email, phone or code.
   */
  async cancelLinkView(input, client = '') {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    return { link: this.cancelLinkFacts(this.cancelLinkItem(input, client, now, rules), rules, now) };
  },

  /**
   * POST /cancel-links/cancel { ref, key }: cancels it by the person's own path in My Lair (cancelOwnBooking, cancelOwnJoin
   * in lair.js), with the same rules and side effects: the seat back on the board, the GM told, a refund flagged and staff
   * told when one's due. Refused with nothing changed (409) once it's cancelled, started or locked in, in the existing
   * words. → { ok, kind, people, refund: { due, amount } | null, notice }
   */
  async cancelByLink(input, client = '') {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const found = this.cancelLinkItem(input, client, now, rules);
    const refusal = this.cancelLinkRefusal(found, rules, now);
    if (refusal) throw new RuleError(refusal, 409);
    const result = found.type === 'signup' ? this.cancelOwnJoin(found.x, rules, now) : this.cancelOwnBooking(found.x, rules, now);
    return {
      ok: true, kind: found.type, people: Math.max(1, Number(found.x.people) || 1),
      refund: result.refund?.due ? { due: true, amount: result.refund.amount } : null, notice: result.notice || null,
    };
  },

  /**
   * The booking or sign-up a cancel link is for: its code (ref) and key, the key compared in constant time (against a
   * stand-in when there's no key to compare with). One answer for a wrong key, a code that isn't a reminded booking or
   * sign-up, and either left out; CANCEL_TRIES of those from one place in 10 minutes and it has to wait. No awaits.
   * → { table, type, x, game, o }
   */
  cancelLinkItem(input, client, now, rules) {
    const where = String(client || '-');
    if (!this.cancelMisses) this.cancelMisses = new Map();
    const misses = (this.cancelMisses.get(where) || []).filter((t) => now - t < CANCEL_TRIES_WINDOW);
    if (misses.length >= CANCEL_TRIES) throw new RuleError(CANCEL_LINK_WORDS.tooMany, 429);
    const ref = typeof input?.ref === 'string' ? input.ref.trim().slice(0, 40) : '';
    const key = typeof input?.key === 'string' ? input.key.trim().slice(0, 64) : '';
    const booking = ref ? this.sql.exec("SELECT * FROM bookings WHERE ref = ? AND kind IN ('table', 'gm-seat') AND series_id IS NULL", ref).toArray()[0] : null;
    const join = ref && !booking ? this.sql.exec('SELECT * FROM event_joins WHERE ref = ?', ref).toArray()[0] : null;
    const row = booking || join;
    const stored = row?.cancel_key || '';
    const matches = safeEqual(key || '-', stored || NO_KEY) && Boolean(stored) && Boolean(key);
    if (!matches) {
      misses.push(now);
      if (this.cancelMisses.size > 2000) this.cancelMisses.clear();
      this.cancelMisses.set(where, misses);
      throw new RuleError(CANCEL_LINK_WORDS.wrong, 404);
    }
    if (join) {
      const x = this.rowToJoin(join);
      return { table: 'event_joins', type: 'signup', x, game: null, o: findOccurrence(rules, x.occurrenceId) };
    }
    const x = this.rowToBooking(booking);
    return {
      table: 'bookings', type: x.kind === 'gm-seat' ? 'seat' : 'table', x,
      game: x.kind === 'gm-seat' ? this.game(x.gameId) : null, o: x.occurrenceId ? findOccurrence(rules, x.occurrenceId) : null,
    };
  },

  /** Why it can't be cancelled by its link now, in the existing words (cancelled, started or checked in, locked in), or null. No awaits. */
  cancelLinkRefusal(found, rules, now) {
    const { x, type } = found;
    if (x.status === 'cancelled') return CANCEL_LINK_WORDS.cancelled;
    if (x.status !== 'confirmed' || x.start <= now) return TAB_WORDS.started;
    if (this.cancelRule(x, rules, now).locked) return type === 'seat' && x.coveredBy ? GM_COVER_WORDS.seatLocked(rules.refundHours) : TAB_WORDS.locked(rules.refundHours);
    return null;
  },

  /** What the cancel link's page shows (see cancelLinkView). No awaits. */
  cancelLinkFacts(found, rules, now) {
    const { x, type, game, o } = found;
    const time = new LairTime(rules.tz);
    const start = type === 'signup' && o ? o.start : x.start;
    const reason = this.cancelLinkRefusal(found, rules, now);
    const rule = this.cancelRule(x, rules, now);
    const title = type === 'seat' ? game?.title || null : type === 'signup' ? o?.title || x.title || null : o?.title || null;
    return {
      kind: type, title, when: `${longDay(start, rules.tz)}, ${clockLabel(time.minutesOf(start))}`, people: Math.max(1, Number(x.people) || 1),
      cancellable: !reason, until: !reason && rule.lockable ? deadline(rule.cancelUntil, time) : null, reason,
    };
  },
};

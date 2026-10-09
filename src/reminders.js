/**
 * Round 11, reminders (contract v11-reminders). Mo (9 Oct 2026, 7pm), on Oddity Alley: "Entry is free, so have a add to
 * calendar option on it and possibly a reminder the day prior if they opt for it?" On Blood on the Clocktower: "Maximum
 * capacity of 40 people but if we went more let it notify us so we cns try to organize a new group to accommodate."
 *
 * - "Remind me the day before" on an event date's "I'm coming" or "Maybe" (round 9's interests): `remind` on the row,
 *   and the 10-minute maintenance emails it once (sendReminders), between 9am and 9pm at the Lair, never at night.
 * - The waitlist for a full date: an interest with level 'waitlist' and its people (1 to 6). Never a sign-up and never
 *   counted in places taken. The staff are emailed each time someone joins, and so is the person.
 * - An event date as a calendar file (GET /ics/<id>.ics), for the reminder's Add to calendar.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair; each
 * keeps its rule: every await first, then one synchronous read-check-write.
 */
import { LairTime, RuleError, addDays, checkMobile, findOccurrence, makeId } from './core.js';
import { emailReady, safeEqual } from './shopify.js';
import { clockLabel } from './email.js';
import { INTEREST_MESSAGES, INTEREST_NOTE_MAX } from './interest.js';

/** Reminders go from 9am and stop at 9pm, Lair time: never late at night */
export const REMIND_FROM_HOUR = 9;
export const REMIND_UNTIL_HOUR = 21;
/** At most this many reminders a run (one batch to Resend); any more go in the next run, 10 minutes later */
export const REMINDERS_A_RUN = 100;
/** A waitlist row is for 1 to this many people, like a sign-up */
export const WAITLIST_MAX = 6;
/** Where the Lair is (the shop's facts), when Shopify has no store address for the email */
const LAIR_ADDRESS = '56/691 Manukau Road, Royal Oak, Auckland 1023';
const LAIR_WAY = 'Upstairs in Royal Oak Mall, above Whitcoulls. The lift is next to Whitcoulls.';
const WEEKEND_LIFT = 'On weekends the lift runs during mall hours, 10am to 5pm.';

/** Every message a customer can see, word for word in the contract */
export const REMINDER_MESSAGES = {
  choose: 'Say whether you want the reminder: on or off.',
  only: 'Reminders are for “I’m coming” and “Maybe” on an event date.',
  notYours: "That isn't yours to change.",
  kind: 'The waitlist is for event dates.',
  noSignUps: "This one doesn't take sign-ups, so there's no waitlist. Just turn up!",
  people: `Join the waitlist for 1 to ${WAITLIST_MAX} people.`,
  room: (left) => `There’s still room for ${left === 1 ? '1 person' : `${left} people`}, so sign up instead.`,
};

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const trimmed = (v, max) => String(v ?? '').trim().slice(0, max);
const money = (cents) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'friend';
/** "Saturday 21 November" and "Sat 21 Nov" in the Lair's time zone (some ICU versions put a comma after the weekday) */
const longDay = (ms, tz) => new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(ms)).replace(/,/g, '');
const shortDay = (ms, tz) => new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms)).replace(/,/g, '');
/** "10am to 4pm" */
const span = (o, time) => `${clockLabel(time.minutesOf(o.start))} to ${clockLabel(time.minutesOf(o.end))}`;
/** UTC for calendar files and links: 20261120T210000Z */
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/[\\,;]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
/** Calendar lines longer than 75 bytes are folded (RFC 5545), as the theme's Add to calendar does */
function icsFold(line) {
  const parts = [];
  let part = '';
  let bytes = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0);
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + size > (parts.length ? 74 : 75)) {
      parts.push(part);
      part = '';
      bytes = 0;
    }
    part += ch;
    bytes += size;
  }
  parts.push(part);
  return parts.join('\r\n ');
}

export const reminderMethods = {
  /* ---------------- "Remind me the day before" ---------------- */
  /**
   * After POST /interest saves a row (addInterest, round 9): the reminder choice (`remind: true | false`, event dates'
   * "I'm coming" and "Maybe" only; left out, it stays as it was), and a waitlist row that's now a maybe or coming loses
   * its people. A new row for a date whose reminder already went to that email (taken back, then said again) keeps that
   * it went, so it never goes twice. No awaits.
   */
  interestSaved(id, input, now) {
    const row = this.interestRow(id);
    if (!row) return;
    if (row.level !== 'waitlist' && row.people != null) this.write('UPDATE interests SET people = NULL WHERE id = ?', row.id);
    if (row.kind !== 'event' || !['maybe', 'coming'].includes(row.level)) return;
    if (!row.reminded_at) {
      const went = this.sql
        .exec("SELECT MAX(reminded_at) AS at FROM interests WHERE kind = 'event' AND target_id = ? AND lower(email) = lower(?) AND id != ?", row.target_id, row.email, row.id)
        .one()?.at;
      if (went) this.write('UPDATE interests SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL', went, row.id);
    }
    if (typeof input?.remind === 'boolean') this.setRemind(row, input.remind, now);
  },

  /** Turn the reminder on (remind_at: when, kept while it stays on) or off. No awaits. */
  setRemind(row, on, now) {
    if (on) this.write('UPDATE interests SET remind = 1, remind_at = CASE WHEN remind = 1 THEN remind_at ELSE ? END, updated_at = ? WHERE id = ?', now, now, row.id);
    else this.write('UPDATE interests SET remind = 0, updated_at = ? WHERE id = ?', now, row.id);
  },

  /**
   * POST /interest/:id/remind { remind: true | false, key? }: the reminder on or off for an "I'm coming" or "Maybe"
   * already made, with nothing else sent again. The member it belongs to, staff, or a guest with its key.
   * → { ok, interest }.
   */
  async remindInterest(id, input, who) {
    // --- no awaits: one read-check-write ---
    const now = Date.now();
    const row = this.interestRow(trimmed(id, 60));
    if (!row || row.status !== 'active') throw new RuleError(INTEREST_MESSAGES.missing, 404);
    const own = Boolean(who.customerId && row.customer_id && String(row.customer_id) === String(who.customerId));
    const keyed = typeof input?.key === 'string' && Boolean(row.remove_key) && safeEqual(input.key, row.remove_key);
    if (!who.staff && !own && !keyed) throw new RuleError(REMINDER_MESSAGES.notYours, 403);
    if (row.kind !== 'event' || !['maybe', 'coming'].includes(row.level)) throw new RuleError(REMINDER_MESSAGES.only);
    if (typeof input?.remind !== 'boolean') throw new RuleError(REMINDER_MESSAGES.choose);
    this.setRemind(row, input.remind, now);
    return { ok: true, interest: this.interestView(this.interestRow(row.id), { key: keyed }) };
  },

  /**
   * The maintenance run's reminders (every 10 minutes): claims the ones due at `now` and sends them in the background.
   * Returns { sent, dates } or null when none are due. No awaits.
   */
  sendReminders(rules, now) {
    const claim = this.claimReminders(rules, now);
    if (!claim) return null;
    this.later(this.deliverReminders(claim));
    return claim.summary;
  },

  /** POST /internal/reminders { at? }: the same run at a fixed time (the live checks' clock), waiting for the send */
  async remindersAt(at) {
    const rules = await this.rules();
    // --- no awaits until the reminders are claimed ---
    const claim = this.claimReminders(rules, at);
    if (!claim) return { sent: 0, dates: [] };
    const result = await this.deliverReminders(claim);
    return { ...claim.summary, ok: Boolean(result.ok) };
  },

  /**
   * Which reminders are due at `now`, Lair time, and marks them sent (so none ever goes twice). Only from 9am to 9pm.
   * Due: an active "I'm coming" or "Maybe" on an event date with remind on and no reminder yet, when the date is
   * tomorrow; or when it's today and hasn't started, if they turned the reminder on before today (they asked after 9pm
   * the day before, or that day's runs missed it), so it goes in the morning instead of late at night. Turned on on the
   * day itself: none (it's today). A date that's gone from the calendar gets none. At most REMINDERS_A_RUN. No awaits.
   * Returns { at, ids, letters, summary: { sent, dates } } or null.
   */
  claimReminders(rules, now) {
    if (!emailReady(this.env)) return null;
    const time = new LairTime(rules.tz);
    const hour = time.parts(now).h;
    if (hour < REMIND_FROM_HOUR || hour >= REMIND_UNTIL_HOUR) return null;
    const today = time.key(now);
    const tomorrow = addDays(today, 1);
    const midnight = time.at(today, 0);
    const rows = this.sql
      .exec(
        `SELECT * FROM interests WHERE remind = 1 AND reminded_at IS NULL AND kind = 'event' AND status = 'active' AND level IN ('maybe', 'coming')
           AND starts_at >= ? AND starts_at < ? ORDER BY starts_at, rowid`,
        midnight, time.at(addDays(today, 2), 0),
      )
      .toArray();
    const due = [];
    for (const row of rows) {
      if (due.length >= REMINDERS_A_RUN) break;
      const o = findOccurrence(rules, row.target_id);
      if (!o || o.end <= now || !isEmail(row.email)) continue;
      const day = time.key(o.start);
      const when = day === tomorrow ? 'tomorrow' : day === today && o.start > now && Number(row.remind_at || 0) < midnight ? 'today' : null;
      if (when) due.push({ row, o, when });
    }
    if (!due.length) return null;
    // --- marked as sent first: a reminder never goes twice ---
    for (const d of due) this.write('UPDATE interests SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL', now, d.row.id);
    return {
      at: now, ids: due.map((d) => d.row.id), letters: due.map((d) => this.reminderLetter(d.row, d.o, rules, d.when)),
      summary: { sent: due.length, dates: [...new Set(due.map((d) => d.o.id))] },
    };
  },

  /**
   * Send what claimReminders made, in one batch. If Resend was down or busy (5xx or 429), the rows this run marked are
   * unmarked so the next run tries again (still between 9am and 9pm); anything else (an address Resend refused) isn't
   * tried again. After the await only these rows' reminded_at changes, and only where this run set it.
   */
  async deliverReminders(claim) {
    const result = await this.mailMany(claim.letters);
    if (!result.ok && (result.status >= 500 || result.status === 429)) {
      for (const id of claim.ids) this.write('UPDATE interests SET reminded_at = NULL WHERE id = ? AND reminded_at = ?', id, claim.at);
    }
    return result;
  },

  /**
   * The reminder email (Gobgob signs it): what, when, where, the price as the event says it, Add to calendar (a calendar
   * file and Google Calendar), and how to take it back. when: 'tomorrow' or 'today'. No awaits.
   */
  reminderLetter(row, o, rules, when) {
    const time = new LairTime(rules.tz);
    const ev = (rules.events || []).find((e) => e.id === o.eventId) || {};
    const day = longDay(o.start, rules.tz);
    const hours = span(o, time);
    const coming = row.level === 'coming';
    const price = this.eventPriceLine(o, ev);
    const Day = when === 'today' ? 'Today' : 'Tomorrow';
    const outro = [];
    if (o.capacity) {
      outro.push(this.placesTaken(o.id) >= o.capacity
        ? 'It takes sign-ups and it’s full right now. Join the waitlist on the event’s page, and the team will be in touch if a place opens up.'
        : 'It takes sign-ups, so sign up on the event’s page to keep your place.');
    }
    outro.push(row.customer_id
      ? 'Not coming after all? Take it back on the event’s page or in My Lair, so the numbers stay right.'
      : 'Not coming after all? Take it back on the event’s page (the link above), so the numbers stay right.');
    return this.letter(row.email, `${Day}: ${o.title}, ${clockLabel(time.minutesOf(o.start))}`, {
      title: coming ? `See you ${when}!` : `${Day}’s the day`,
      intro: [
        `Kia ora ${firstName(row.name)}, here’s the reminder you asked for: ${o.title} is ${when}, ${day}, ${hours}.`,
        coming ? 'You said you’re coming, so Gobgob’s expecting you.' : 'You said maybe. No pressure, friend: come along if you can.',
      ],
      details: [['Event', o.title], ['When', `${day}, ${hours}`], ['Where', this.lairWhere(o, rules)], ['Entry', price], ['You said', coming ? 'I’m coming' : 'Maybe']],
      button: { label: 'Add to calendar', url: this.icsLink(o) },
      links: [{ label: 'Google Calendar', url: this.googleLink(o, rules, price) }, { label: 'The event’s page', url: this.interestLink(row) }],
      outro,
    });
  },

  /** The price as the event says it: its entry fee and how it's paid, its price note as written, or free entry. '' when
      the event says nothing about price. No awaits. */
  eventPriceLine(o, ev = {}) {
    const note = String(ev.priceNote || '').trim();
    if (o.entryFee) {
      const how = o.capacity && o.payment === 'online' ? 'paid online when you sign up' : o.capacity && o.payment === 'either' ? 'online or at the counter' : 'paid at the counter';
      return `${money(o.entryFee)} a person, ${how}${note ? `\n${note}` : ''}`;
    }
    if (ev.freeEntry) return /\bfree\b/i.test(note) ? note : `Free entry${note ? `\n${note}` : ''}`;
    return note;
  },

  /** "Dice Goblin, 56/691 Manukau Road, …", then how to get up there (the lift's weekend hours on a Saturday or Sunday) */
  lairWhere(o, rules) {
    const time = new LairTime(rules.tz);
    const weekend = [0, 6].includes(time.weekday(time.key(o.start)));
    return [this.lairPlace(rules), `${LAIR_WAY}${weekend ? ` ${WEEKEND_LIFT}` : ''}`].join('\n');
  },

  lairPlace(rules) {
    return `Dice Goblin, ${String(rules?.contact?.address || '').trim() || LAIR_ADDRESS}`;
  },

  /** The event date on the website: the events page opens its sheet (#event=<id>) */
  eventLink(o) {
    return `${this.page('events')}#event=${encodeURIComponent(o.id)}`;
  },

  /** An interest's event page: a guest's carries its key (and what they said), so that page can take it back or change
      the reminder from any device; a member's is the plain page (they're logged in) */
  interestLink(row) {
    const hash = `#event=${encodeURIComponent(row.target_id)}`;
    if (row.customer_id || !row.remove_key) return `${this.page('events')}${hash}`;
    const query = new URLSearchParams({ interest: row.id, key: row.remove_key, date: row.target_id, said: row.level });
    return `${this.page('events')}?${query}${hash}`;
  },

  /** The calendar file for an event date (GET /ics/<id>.ics on the Lair app's own address) */
  icsLink(o) {
    return `${String(this.env.PUBLIC_URL || 'https://dice-goblin-lair.dicegoblinnz.workers.dev').replace(/\/$/, '')}/ics/${encodeURIComponent(o.id)}.ics`;
  },

  googleLink(o, rules, price = '') {
    const query = new URLSearchParams({
      action: 'TEMPLATE', text: o.title, dates: `${stamp(o.start)}/${stamp(o.end)}`, details: [price, this.eventLink(o)].filter(Boolean).join('\n\n'),
      location: this.lairPlace(rules), ctz: rules.tz,
    });
    return `https://calendar.google.com/calendar/render?${query}`;
  },

  /**
   * GET /ics/<id>.ics (public): an event date as a calendar file, the same entry the events page's Add to calendar makes
   * (one UID per date, so adding it twice updates it). 404 for a date that isn't on the calendar.
   */
  async eventIcs(occurrenceId) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const o = findOccurrence(rules, String(occurrenceId || '').slice(0, 200));
    if (!o) return new Response('That event date could not be found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    const ev = (rules.events || []).find((e) => e.id === o.eventId) || {};
    const url = this.eventLink(o);
    const text = [this.eventPriceLine(o, ev), url].filter(Boolean).join('\n\n');
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Dice Goblin//Lair events//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
      `UID:${o.id.replace(/[^A-Za-z0-9._-]+/g, '-')}@dicegoblin.nz`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(o.start)}`, `DTEND:${stamp(o.end)}`,
      `SUMMARY:${icsText(o.title)}`, `DESCRIPTION:${icsText(text)}`, `LOCATION:${icsText(this.lairPlace(rules))}`, `URL:${url}`,
      'END:VEVENT', 'END:VCALENDAR',
    ].map(icsFold).join('\r\n');
    const name = `${String(o.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'event'}-${o.id.slice(-10)}`;
    return new Response(`${ics}\r\n`, {
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.ics"`, 'Cache-Control': 'public, max-age=300' },
    });
  },

  /* ---------------- the waitlist for a full date ---------------- */
  /** People on a date's waitlist: { entries, people }. No awaits. */
  waitingOn(targetId) {
    const r = this.sql
      .exec("SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(people, 1)), 0) AS p FROM interests WHERE kind = 'event' AND target_id = ? AND status = 'active' AND level = 'waitlist'", targetId)
      .one();
    return { entries: Number(r?.n || 0), people: Number(r?.p || 0) };
  },

  /** Places taken on a date with sign-ups, as joinEvent counts them. No awaits. */
  placesTaken(occurrenceId) {
    return Number(this.sql.exec("SELECT COALESCE(SUM(people), 0) AS n FROM event_joins WHERE occurrence_id = ? AND status != 'cancelled'", occurrenceId).one().n) || 0;
  },

  /**
   * POST /interest { waitlist: true, kind?: 'event', id, people (1 to 6, 1 when left out), name?, email?, phone?, note? }:
   * "Join the waitlist" for an event date with sign-ups that can't fit them (it's full, or has fewer places left than
   * people). Anyone: a member's name, email and saved mobile fill in when left out; a guest gives all three. Saved as an
   * interest with level 'waitlist' (one per person per date, as round 9: a "Maybe" they had becomes it): never a sign-up,
   * never counted in places taken. A new one emails the staff (the event, that it's full, who and how many, the total
   * waiting, replies to the person) and the person (nothing is booked or paid). Asking again changes the people or the
   * note, and emails nobody. → { interest, counts, already, emailed, staffEmailed, placesLeft }.
   */
  async joinWaitlist(input, who, client = '') {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    if (input.kind != null && input.kind !== 'event') throw new RuleError(REMINDER_MESSAGES.kind);
    const targetId = trimmed(input.id, 120);
    const occurrence = findOccurrence(rules, targetId);
    if (!occurrence) throw new RuleError(INTEREST_MESSAGES.event, 404);
    if (occurrence.end <= now) throw new RuleError(INTEREST_MESSAGES.over);
    if (!occurrence.capacity) throw new RuleError(REMINDER_MESSAGES.noSignUps);
    const people = input.people == null || input.people === '' ? 1 : Math.floor(Number(input.people));
    if (!(people >= 1 && people <= WAITLIST_MAX)) throw new RuleError(REMINDER_MESSAGES.people);
    const noteText = String(input.note ?? '').trim();
    if (noteText.length > INTEREST_NOTE_MAX) throw new RuleError(INTEREST_MESSAGES.note);
    const member = who.customerId ? this.memberRow(who.customerId) : null;
    const name = trimmed(input.name, 80) || trimmed(member?.name, 80);
    const email = trimmed(input.email, 120) || trimmed(member?.account_email || member?.email, 120);
    if (!name) throw new RuleError(INTEREST_MESSAGES.name);
    if (!isEmail(email)) throw new RuleError(INTEREST_MESSAGES.email);
    // a mobile for everyone, so the team can ring them: a member's saved one when they leave it out
    const phone = checkMobile(trimmed(input.phone, 40) || member?.mobile || '');
    this.checkRate(who, client, now);
    const me = who.customerId ? String(who.customerId) : null;
    const joined = this.sql
      .exec("SELECT COUNT(*) AS n FROM event_joins WHERE occurrence_id = ? AND status NOT IN ('cancelled', 'noshow') AND (customer_id = ? OR lower(email) = lower(?))", targetId, me || '', email)
      .one().n;
    if (joined) throw new RuleError(INTEREST_MESSAGES.joined, 409);
    const taken = this.placesTaken(targetId);
    const left = Math.max(0, occurrence.capacity - taken);
    if (people <= left) throw new RuleError(REMINDER_MESSAGES.room(left), 409);
    const note = noteText.slice(0, INTEREST_NOTE_MAX);
    const existing = this.sql
      .exec(
        `SELECT * FROM interests WHERE kind = 'event' AND target_id = ? AND status = 'active' AND ((customer_id IS NOT NULL AND customer_id = ?) OR lower(email) = lower(?))
         ORDER BY rowid LIMIT 1`,
        targetId, me || '', email,
      )
      .toArray()[0];
    let id;
    const already = existing?.level === 'waitlist';
    if (existing) {
      id = existing.id;
      // theirs already: the people and note change; a "Maybe" they had becomes the waitlist (and needs no reminder)
      this.write(
        `UPDATE interests SET level = 'waitlist', people = ?, note = ?, name = ?, phone = ?, customer_id = COALESCE(customer_id, ?), remind = 0, updated_at = ? WHERE id = ?`,
        people, note || existing.note || '', name, phone, me, now, id,
      );
    } else {
      id = makeId('in');
      this.write(
        `INSERT INTO interests (id, kind, target_id, level, status, name, email, phone, note, customer_id, remove_key, title, starts_at, ends_at, created_at, updated_at, people)
         VALUES (?, 'event', ?, 'waitlist', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, targetId, name, email, phone, note, me, crypto.randomUUID(), occurrence.title, occurrence.start, occurrence.end, now, now, people,
      );
    }
    this.touchMember(me, { name, email, mobile: phone }, now);
    // --- saved ---
    const row = this.interestRow(id);
    const told = already ? { staff: false, you: false } : this.tellWaitlist(row, occurrence, rules, taken);
    return {
      interest: this.interestView(row, { key: !me }), counts: this.interestCounts('event', targetId), already, emailed: told.you, staffEmailed: told.staff,
      placesLeft: left,
    };
  },

  /**
   * A new waitlist row: the staff hear plainly (the event, the date, that it's full, who joined and how many, the total
   * waiting, that it's the moment to organise another group; replies go to the person), and the person hears they're on
   * it with nothing booked or paid. Returns { staff, you }: whether each email went. No awaits.
   */
  tellWaitlist(row, o, rules, taken) {
    if (!emailReady(this.env)) return { staff: false, you: false };
    const time = new LairTime(rules.tz);
    const day = longDay(o.start, rules.tz);
    const when = `${day}, ${span(o, time)}`;
    const n = Number(row.people) || 1;
    const full = taken >= o.capacity;
    const waiting = this.waitingOn(row.target_id);
    let staff = false;
    if (this.env.STAFF_EMAIL) {
      this.notifyStaff(`Waitlist: ${o.title}, ${shortDay(o.start, rules.tz)} (${waiting.people} waiting)`, {
        title: 'Someone joined the waitlist',
        intro: [
          `${o.title} on ${day} ${full ? `is full (${taken} of ${o.capacity} places)` : `has ${plural(o.capacity - taken, 'place', 'places')} left (${taken} of ${o.capacity} taken), not enough for them`}. ${row.name} just joined the waitlist for ${plural(n, 'person', 'people')}.`,
          `${plural(waiting.people, 'person is', 'people are')} waiting now. This is the moment to organise another group, if you can.`,
        ],
        details: [
          ['Event', o.title], ['When', when], ['Places', `${taken} of ${o.capacity} taken`], ['Name', row.name], ['Email', row.email], ['Mobile', row.phone || ''],
          ['People', String(n)], ['Their note', row.note || ''], ['Waiting', `${plural(waiting.people, 'person', 'people')} (${plural(waiting.entries, 'name', 'names')} on the list)`],
        ],
        outro: 'Nothing is booked for them. If a place frees up, nothing happens by itself: who gets it is your call. Reply to this email to reach them.',
      }, { replyTo: isEmail(row.email) ? row.email : null });
      staff = true;
    }
    let you = false;
    if (isEmail(row.email)) {
      this.later(this.mail(this.letter(row.email, `You’re on the waitlist: ${o.title}, ${shortDay(o.start, rules.tz)}`, {
        title: 'You’re on the waitlist',
        intro: [
          `Kia ora ${firstName(row.name)}, ${o.title} on ${day} ${full ? 'is full' : `doesn’t have room for ${n} right now`}, so Gobgob has put you on the waitlist${n > 1 ? ` for ${n} people` : ''}.`,
          'Nothing is booked and nothing is paid. If a place opens up, or the team can start another group, they’ll be in touch.',
        ],
        details: [['Event', o.title], ['When', when], ['People', String(n)], ['Your note', row.note || '']],
        button: { label: 'See the event', url: this.interestLink(row) },
        outro: row.customer_id
          ? 'Changed your mind? Take yourself off the waitlist on the event’s page or in My Lair.'
          : 'Changed your mind? Take yourself off the waitlist on the event’s page (the button above).',
      })));
      you = true;
    }
    return { staff, you };
  },
};

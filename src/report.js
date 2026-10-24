// Round 19, the weekly numbers (24 Oct 2026, contract v19-report). From the website lab's brief: engagement at Dice Goblin
// is people coming to the Lair and coming back, and every change to the website is judged against it. Mo picked: the one
// number is regulars, with a visit counted when it was checked in or paid ("Checked in or paid", so a night staff took
// payment without scanning still counts, and the check-in rate shows beside it); a staff-only weekly report; and an
// anonymous count of bookings started and finished ("Yes, build both").
//
// These are methods of the Lair Durable Object (src/lair.js mixes them in with Object.assign(Lair.prototype, …)), kept in
// their own file so the feature stays in one place. Every await comes first (the rules), then synchronous reads. Nothing
// here changes a booking, a sign-up or a member.
//
// - A visit is a table booking, walk-in or TTRPG seat that was checked in ('seated' or 'done'), or an event sign-up checked
//   in ('attended'), or either of them paid around the session: still paid (in full or in part), and first paid from
//   PAID_BEFORE before it starts to PAID_AFTER after it ends (the shop opens at 4pm on weekdays, so a Paid ticked the next
//   afternoon still counts). Around the session because a seat nobody came to becomes owed and is paid at a later visit
//   (round 15), and something paid online days ahead says nothing about who came. Cancelled ones, no-shows and unpaid
//   online holds never count. A visit belongs to the week its session starts in: Monday to Sunday at the Lair.
// - When something was first paid is bookings.paid_at and event_joins.paid_at, and when someone first used the app is
//   members.first_seen: stampWrites sets them after every write to those tables (lair.js's write), so every way of paying
//   or turning up is covered, and what came before this went live is filled in on start (backfillStamps).
// - Regulars in a week: people with an account who had a visit in at least 2 different weeks of the 4 that end with it.
//   Each person counts for themselves: the booker, every named player with an account on a table or a game seat, every
//   guest with an account on a sign-up. Friends without an account are in the visits but can't be regulars. A GM running
//   their own session isn't a visit unless they also book.
// - Steps (POST /steps): how many times, each day at the Lair, the website's booking flows reached a step: start, login (they
//   started logged out, so the form asked them to log in first), done, and login-done (done, having started logged out: as
//   a guest or after logging in). login minus login-done is who gave up after being asked to log in. Nothing about who: no
//   customer, browser or address is stored, and a browser sending too many in a short time is ignored.
// - The report emails the team on Monday morning (after 8am at the Lair), once a week: last week next to the week before.
//   REPORT_EMAIL (config) sends it somewhere else, or 'off' stops it; otherwise it goes to STAFF_EMAIL.
import { HOUR, LairTime, MIN } from './core.js';
import { emailReady } from './shopify.js';

/** Booking flows on the website and the steps counted for each (anything else sent to POST /steps is ignored) */
export const STEP_FLOWS = ['table', 'ttrpg', 'event'];
export const STEP_NAMES = ['start', 'login', 'done', 'login-done'];
/** A browser's steps counted per window; more are quietly dropped, so nobody can run the numbers up */
export const STEP_LIMIT = 30;
const STEP_WINDOW = 10 * MIN;
/** How far back GET /report goes, at most, in whole weeks */
export const REPORT_WEEKS_MAX = 26;
const REPORT_WEEKS_DEFAULT = 8;
/** A regular: visits in at least REGULAR_MIN different weeks of the REGULAR_WINDOW weeks that end with this one */
export const REGULAR_WINDOW = 4;
export const REGULAR_MIN = 2;
/** The weekly email goes on Monday from this hour at the Lair */
export const REPORT_MAIL_HOUR = 8;
/** Paid around the session: first paid from PAID_BEFORE before it starts to PAID_AFTER after it ends */
export const PAID_BEFORE = 12 * HOUR;
export const PAID_AFTER = 24 * HOUR;
/** Writes after which stampWrites looks for rows just paid or members just seen (lair.js's write) */
export const STAMP_WRITES = /\b(?:INTO|UPDATE)\s+(?:bookings|event_joins|members)\b/i;

/** Steps and the report's tables and indexes (made when missing, in lair.js's migrate, after REPORT_COLUMNS) */
export const REPORT_TABLES = [
  `CREATE TABLE IF NOT EXISTS step_counts (
    day TEXT NOT NULL, flow TEXT NOT NULL, step TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, flow, step))`,
  'CREATE INDEX IF NOT EXISTS bookings_created ON bookings (created_at)',
  'CREATE INDEX IF NOT EXISTS event_joins_created ON event_joins (created_at)',
  // only rows paid or seen and not yet stamped are in these (normally none), so stampWrites costs next to nothing
  'CREATE INDEX IF NOT EXISTS bookings_paid_unstamped ON bookings (id) WHERE paid_at IS NULL AND (paid = 1 OR paid_amount > 0)',
  'CREATE INDEX IF NOT EXISTS event_joins_paid_unstamped ON event_joins (id) WHERE paid_at IS NULL AND (paid = 1 OR paid_amount > 0)',
  'CREATE INDEX IF NOT EXISTS members_seen_unstamped ON members (customer_id) WHERE first_seen IS NULL AND last_seen IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS members_first_seen ON members (first_seen)',
];
/**
 * bookings.added_by: who on the team made it for someone (staff:<customer id>, or staff); empty when it was made online.
 * bookings.paid_at and event_joins.paid_at: when it was first paid, in full or in part. members.first_seen: when they first
 * used the app themselves (their first last_seen). Both set by stampWrites.
 */
export const REPORT_COLUMNS = [
  ['bookings', 'added_by', 'TEXT'], ['bookings', 'paid_at', 'INTEGER'], ['event_joins', 'paid_at', 'INTEGER'], ['members', 'first_seen', 'INTEGER'],
];

const BOOKING_KINDS = "('table', 'walkin', 'gm-seat')";
/** Paid around the session (alias x): still paid, and first paid from PAID_BEFORE before it to PAID_AFTER after it */
const paidOnTheDay = (x) => `((${x}.paid = 1 OR ${x}.paid_amount > 0) AND ${x}.paid_at IS NOT NULL AND ${x}.paid_at >= ${x}.starts_at - ${PAID_BEFORE} AND ${x}.paid_at <= ${x}.ends_at + ${PAID_AFTER})`;
/** A booking that was a visit (alias b) */
const BOOKING_VISIT = `(b.status IN ('seated', 'done') OR (${paidOnTheDay('b')} AND b.status NOT IN ('cancelled', 'noshow', 'held')))`;
/** A sign-up that was a visit (alias j) */
const JOIN_VISIT = `(j.status = 'attended' OR (${paidOnTheDay('j')} AND j.status NOT IN ('cancelled', 'held')))`;
/** Made by staff for someone: a walk-in, a staff-page booking (added_by), or a seat staff added (round 7's note) */
const BOOKING_BY_STAFF = "(b.kind = 'walkin' OR COALESCE(b.added_by, '') != '' OR COALESCE(b.notes, '') LIKE 'Added by staff%')";
/** A sign-up staff made: added for someone (added_by), or a walk-in staff checked in at an event (round 9's source) */
const JOIN_BY_STAFF = "(COALESCE(j.added_by, '') != '' OR COALESCE(j.source, '') = 'walk-in')";

export const REPORT_WORDS = {
  visit: 'A visit is a table, walk-in or TTRPG seat, or an event sign-up, that was checked in, or paid on the day (from 12 hours before it to a day after). Cancellations, no-shows and unpaid holds never count, and nor does a seat paid later because nobody came.',
  regular: `A regular came in at least ${REGULAR_MIN} different weeks of the last ${REGULAR_WINDOW} (with an account, so each person counts once).`,
  week: 'Weeks run Monday to Sunday at the Lair.',
};

/** 'YYYY-MM-DD' plus n days */
export const addDays = (key, n) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
/** The Monday that starts the week of a day key */
export const mondayOf = (time, key) => addDays(key, -((time.weekday(key) + 6) % 7));

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const SHORT = new Intl.DateTimeFormat('en-NZ', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const LONG = new Intl.DateTimeFormat('en-NZ', { timeZone: 'UTC', day: 'numeric', month: 'long' });
const dayLabel = (key, fmt = SHORT) => fmt.format(new Date(`${key}T12:00:00Z`));
/** "19–25 Oct" (or "28 Sept – 4 Oct" across a month) */
export function weekLabel(monday) {
  const sunday = addDays(monday, 6);
  return monday.slice(0, 7) === sunday.slice(0, 7)
    ? `${Number(monday.slice(8))}–${dayLabel(sunday)}`
    : `${dayLabel(monday)} – ${dayLabel(sunday)}`;
}

export const reportMethods = {
  /**
   * GET /report?weeks= (staff with Community, or the main account): the weekly numbers, newest first. weeks: whole weeks
   * before this one (default 8, at most 26); this week so far comes first, with partial: true. Each week: { week (its
   * Monday, 'YYYY-MM-DD'), label, partial, regulars, visitors, visits, checkIns: { checkedIn, paidOnly, notRecorded,
   * rate }, noShows, bookingsMade: { online, staff, saved }, newMembers, ttrpg: { sessions, seats, taken }, library:
   * { loansOut }, steps: { table, ttrpg, event: { start, login, done } } }. Also asOf, tz, words (the definitions) and
   * library: { memberships } (current, not by week).
   */
  async weeklyNumbers(url, who) {
    this.requireStaff(who, 'community');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const asked = Number(url.searchParams.get('weeks'));
    const weeks = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, REPORT_WEEKS_MAX) : REPORT_WEEKS_DEFAULT;
    return this.reportFor(rules, Date.now(), weeks);
  },

  /** The report for `weeks` whole weeks before now, plus this week so far (first). No awaits. */
  reportFor(rules, now, weeks) {
    const time = new LairTime(rules.tz);
    const thisMonday = mondayOf(time, time.key(now));
    // this week, then the whole weeks before it, newest first; and the weeks before the oldest that its regulars look back on
    const mondays = Array.from({ length: weeks + 1 }, (_, i) => addDays(thisMonday, -7 * i));
    const lookback = Array.from({ length: REGULAR_WINDOW - 1 }, (_, i) => addDays(mondays[mondays.length - 1], -7 * (i + 1)));
    const all = [...mondays, ...lookback];
    const starts = new Map(all.map((m) => [m, time.at(m, 0)]));
    const from = starts.get(all[all.length - 1]);
    const until = Math.min(now, time.at(addDays(thisMonday, 7), 0));
    // the Monday a time falls in, among the weeks in play (null outside them)
    const ordered = [...all].sort();
    const weekOf = (ms) => {
      if (ms < from || ms >= until) return null;
      let found = null;
      for (const m of ordered) if (starts.get(m) <= ms) found = m;
      return found;
    };

    const people = this.visitorsByWeek(from, until, weekOf);
    const rows = mondays.map((monday, index) => {
      const window = all.slice(all.indexOf(monday), all.indexOf(monday) + REGULAR_WINDOW);
      const seen = new Map();
      for (const m of window) for (const id of people.get(m) || []) seen.set(id, (seen.get(id) || 0) + 1);
      return {
        week: monday, label: weekLabel(monday), partial: index === 0,
        regulars: [...seen.values()].filter((n) => n >= REGULAR_MIN).length,
        visitors: (people.get(monday) || new Set()).size,
        visits: 0, checkIns: { checkedIn: 0, paidOnly: 0, notRecorded: 0, rate: null }, noShows: 0,
        bookingsMade: { online: 0, staff: 0, saved: 0 }, newMembers: 0, ttrpg: { sessions: 0, seats: 0, taken: 0 },
        library: { loansOut: 0 },
        steps: Object.fromEntries(STEP_FLOWS.map((flow) => [flow, Object.fromEntries(STEP_NAMES.map((s) => [s, 0]))])),
      };
    });
    const byWeek = new Map(rows.map((r) => [r.week, r]));
    const add = (ms, fn) => {
      const row = byWeek.get(weekOf(ms));
      if (row) fn(row);
    };
    const start = starts.get(mondays[mondays.length - 1]);

    // visits (people, friends without an account included), check-ins and no-shows, by the session's week
    for (const r of this.sql.exec(
      `SELECT b.starts_at AS at, b.people AS people,
              CASE WHEN b.status IN ('seated', 'done') THEN 'in' WHEN b.status = 'noshow' THEN 'noshow'
                   WHEN ${paidOnTheDay('b')} THEN 'paid' ELSE 'open' END AS state
         FROM bookings b WHERE b.kind IN ${BOOKING_KINDS} AND b.status NOT IN ('cancelled', 'held') AND b.starts_at >= ? AND b.starts_at < ?
       UNION ALL
       SELECT j.starts_at, j.people,
              CASE WHEN j.status = 'attended' THEN 'in' WHEN ${paidOnTheDay('j')} THEN 'paid' ELSE 'open' END
         FROM event_joins j WHERE j.status NOT IN ('cancelled', 'held') AND j.starts_at >= ? AND j.starts_at < ?`,
      start, until, start, until,
    ).toArray()) {
      add(r.at, (row) => {
        if (r.state === 'noshow') row.noShows += 1;
        else if (r.state === 'in') row.checkIns.checkedIn += 1;
        else if (r.state === 'paid') row.checkIns.paidOnly += 1;
        else row.checkIns.notRecorded += 1;
        if (r.state === 'in' || r.state === 'paid') row.visits += Math.max(1, Number(r.people) || 1);
      });
    }
    for (const row of rows) {
      const c = row.checkIns;
      c.rate = pct(c.checkedIn, c.checkedIn + c.paidOnly + c.notRecorded);
    }

    // bookings and sign-ups made, by the week they were made: online, by staff, or saved by Gobgob for a weekly regular
    for (const r of this.sql.exec(
      `SELECT b.created_at AS at, CASE WHEN ${BOOKING_BY_STAFF} THEN 'staff' WHEN b.gob_saved = 1 THEN 'saved' ELSE 'online' END AS by
         FROM bookings b WHERE b.kind IN ${BOOKING_KINDS} AND b.status != 'held' AND b.created_at >= ? AND b.created_at < ?
       UNION ALL
       SELECT j.created_at, CASE WHEN ${JOIN_BY_STAFF} THEN 'staff' ELSE 'online' END
         FROM event_joins j WHERE j.status != 'held' AND j.created_at >= ? AND j.created_at < ?`,
      start, until, start, until,
    ).toArray()) add(r.at, (row) => { row.bookingsMade[r.by] += 1; });

    // people new to the Lair app, by when they first used it themselves (a row staff made for someone counts in the week
    // that person first turns up, never the week it was made)
    for (const r of this.sql.exec('SELECT first_seen AS at FROM members WHERE first_seen >= ? AND first_seen < ?', start, until).toArray()) {
      add(r.at, (row) => { row.newMembers += 1; });
    }

    // TTRPG sessions that ran (not cancelled, not waiting for approval): seats on offer and taken (booked seats plus
    // players the GM brought, up to the seats)
    for (const r of this.sql.exec(
      `SELECT g.starts_at AS at, g.seats AS seats, COALESCE(g.offline_players, 0) +
              (SELECT COALESCE(SUM(b.people), 0) FROM bookings b WHERE b.game_id = g.id AND b.kind = 'gm-seat' AND b.status NOT IN ('cancelled', 'noshow', 'held')) AS taken
         FROM games g WHERE g.status NOT IN ('cancelled', 'pending') AND g.starts_at >= ? AND g.starts_at < ?`,
      start, until,
    ).toArray()) {
      add(r.at, (row) => {
        row.ttrpg.sessions += 1;
        row.ttrpg.seats += Number(r.seats) || 0;
        row.ttrpg.taken += Math.min(Number(r.taken) || 0, Number(r.seats) || 0);
      });
    }

    // library games that went out (borrowed or swapped)
    for (const r of this.sql.exec('SELECT out_at AS at FROM library_loans WHERE out_at >= ? AND out_at < ?', start, until).toArray()) {
      add(r.at, (row) => { row.library.loansOut += 1; });
    }

    // the website's booking steps, by day at the Lair
    const firstDay = mondays[mondays.length - 1];
    for (const r of this.sql.exec('SELECT day, flow, step, n FROM step_counts WHERE day >= ? AND day < ?', firstDay, addDays(thisMonday, 7)).toArray()) {
      const row = byWeek.get(mondayOf(time, r.day));
      if (row?.steps[r.flow] && r.step in row.steps[r.flow]) row.steps[r.flow][r.step] += Number(r.n) || 0;
    }

    // library members now, as currentMembership (src/memberships.js) counts them: active, waiting on a payment, or cancelled
    // but still inside the month they paid for
    const memberships = this.sql.exec(
      "SELECT COUNT(DISTINCT customer_id) AS n FROM memberships WHERE status IN ('active', 'past_due') OR (status = 'cancelling' AND (cancel_at IS NULL OR cancel_at > ?))",
      now,
    ).one().n;
    return { asOf: new Date(now).toISOString(), tz: rules.tz, words: REPORT_WORDS, weeks: rows, library: { memberships } };
  },

  /**
   * Who had a visit, by week: Map(Monday → Set of customer ids). Bookers, named players with an account on a table or a
   * seat, and guests with an account on a sign-up each count for themselves. No awaits.
   */
  visitorsByWeek(from, until, weekOf) {
    const out = new Map();
    const rows = this.sql.exec(
      `SELECT b.customer_id AS id, b.starts_at AS at FROM bookings b
        WHERE b.customer_id IS NOT NULL AND b.customer_id != '' AND b.kind IN ${BOOKING_KINDS} AND b.starts_at >= ? AND b.starts_at < ? AND ${BOOKING_VISIT}
       UNION ALL
       SELECT p.customer_id, b.starts_at FROM booking_players p JOIN bookings b ON b.id = p.booking_id
        WHERE p.customer_id IS NOT NULL AND p.customer_id != '' AND (b.customer_id IS NULL OR b.customer_id != p.customer_id)
          AND b.kind IN ${BOOKING_KINDS} AND b.starts_at >= ? AND b.starts_at < ? AND ${BOOKING_VISIT}
       UNION ALL
       SELECT j.customer_id, j.starts_at FROM event_joins j
        WHERE j.customer_id IS NOT NULL AND j.customer_id != '' AND j.starts_at >= ? AND j.starts_at < ? AND ${JOIN_VISIT}
       UNION ALL
       SELECT x.customer_id, j.starts_at FROM event_join_guests x JOIN event_joins j ON j.id = x.join_id
        WHERE x.customer_id IS NOT NULL AND x.customer_id != '' AND (j.customer_id IS NULL OR j.customer_id != x.customer_id)
          AND j.starts_at >= ? AND j.starts_at < ? AND ${JOIN_VISIT}`,
      from, until, from, until, from, until, from, until,
    ).toArray();
    for (const r of rows) {
      const week = weekOf(r.at);
      if (!week) continue;
      if (!out.has(week)) out.set(week, new Set());
      out.get(week).add(String(r.id));
    }
    return out;
  },

  /**
   * POST /steps { flow, step } (anyone, nobody needs to be logged in): one more of that step today at the Lair. Only the
   * flows and steps in STEP_FLOWS and STEP_NAMES count; anything else, or a browser past STEP_LIMIT steps in 10 minutes, is
   * quietly ignored (still { ok: true }, so the page never waits on it or shows an error). Stores no customer, browser or
   * address. No awaits.
   */
  countStep(input, client, now = Date.now()) {
    const flow = typeof input?.flow === 'string' ? input.flow : '';
    const step = typeof input?.step === 'string' ? input.step : '';
    if (!STEP_FLOWS.includes(flow) || !STEP_NAMES.includes(step)) return { ok: true, counted: false };
    if (client) {
      if (!this.stepHits) this.stepHits = new Map();
      const hits = (this.stepHits.get(client) || []).filter((t) => now - t < STEP_WINDOW);
      if (hits.length >= STEP_LIMIT) return { ok: true, counted: false };
      hits.push(now);
      if (this.stepHits.size > 2000) this.stepHits.clear();
      this.stepHits.set(client, hits);
    }
    const rules = this.rulesCache;
    const day = new LairTime(rules?.tz || 'Pacific/Auckland').key(now);
    this.write(
      'INSERT INTO step_counts (day, flow, step, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, flow, step) DO UPDATE SET n = n + 1',
      day, flow, step,
    );
    return { ok: true, counted: true };
  },

  /**
   * The weekly numbers by email, from the 10-minute maintenance: from Monday at REPORT_MAIL_HOUR at the Lair (or the
   * first run after, if the app missed Monday), once a week (noted in the meta table, so a restart doesn't send it twice),
   * last week next to the week before. To REPORT_EMAIL when it's an address, nowhere when it's 'off' (or isn't an address,
   * which the result says), else STAFF_EMAIL. → { sent, week, to }, { sent: 0, week, baseline }, { sent: 0, error } or
   * null. No awaits.
   */
  weeklyReportMail(rules, now) {
    const time = new LairTime(rules.tz);
    const today = time.key(now);
    if (!emailReady(this.env)) return null;
    const monday = time.weekday(today) === 1;
    if (monday && time.parts(now).h < REPORT_MAIL_HOUR) return null;
    const setting = String(this.env.REPORT_EMAIL || '').trim();
    if (setting.toLowerCase() === 'off') return null;
    if (setting && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(setting)) return { sent: 0, error: 'REPORT_EMAIL is not one email address, so the weekly numbers were not sent.' };
    const to = setting || this.env.STAFF_EMAIL;
    if (!to) return null;
    const thisMonday = mondayOf(time, today);
    const week = addDays(thisMonday, -7);
    const sent = this.sql.exec("SELECT value FROM meta WHERE key = 'weekly-report'").toArray()[0]?.value;
    if (sent && sent >= week) return null;
    // The first run after this goes live only notes a week: the first email is the first whole week of counting (staff
    // bookings and the website's steps are only counted from now), the baseline every later week is compared with. Before
    // 8am on a Monday this week hasn't started for this; on any later day it has, so it's noted as if sent.
    if (!sent) {
      const noted = monday ? week : thisMonday;
      this.write("INSERT OR REPLACE INTO meta (key, value) VALUES ('weekly-report', ?)", noted);
      return { sent: 0, week: noted, baseline: true };
    }
    // the email is made before the week is noted, so a failure here leaves it to the next run
    const report = this.reportFor(rules, now, 2);
    const [, last, before] = report.weeks;
    const content = this.weeklyReportContent(last, before, report);
    const letter = this.letter(to, content.subject, {
      button: { label: 'Open the staff page', url: this.page('staff') }, signoff: 'Gobgob, keeping count', ...content.body,
    });
    this.write("INSERT OR REPLACE INTO meta (key, value) VALUES ('weekly-report', ?)", week);
    this.later(this.mail(letter));
    return { sent: 1, week, to };
  },

  /**
   * From lair.js's write, after a write to bookings, event_joins or members: rows paid just now (in full or in part) with no
   * paid_at get now, and members just seen for the first time get first_seen. The partial indexes in REPORT_TABLES hold only
   * those rows, so these are lookups in nearly empty indexes. Doesn't touch the floor's cache (nothing it reads changes).
   */
  stampWrites(query, now = Date.now()) {
    if (/\bmembers\b/i.test(query)) {
      this.sql.exec('UPDATE members SET first_seen = last_seen WHERE first_seen IS NULL AND last_seen IS NOT NULL');
      return;
    }
    this.sql.exec('UPDATE bookings SET paid_at = ? WHERE paid_at IS NULL AND (paid = 1 OR paid_amount > 0)', now);
    this.sql.exec('UPDATE event_joins SET paid_at = ? WHERE paid_at IS NULL AND (paid = 1 OR paid_amount > 0)', now);
  },

  /**
   * On every start, before anything is written (lair.js's migrate): bookings and sign-ups paid before paid_at existed get
   * their first Shopify payment's time, else their last change; members seen before first_seen existed get when their row
   * was made. Nothing is left for it after the first start.
   */
  backfillStamps() {
    for (const table of ['bookings', 'event_joins']) {
      this.sql.exec(
        `UPDATE ${table} SET paid_at = COALESCE((SELECT MIN(p.at) FROM payments p WHERE p.booking_id = ${table}.id), updated_at, created_at)
          WHERE paid_at IS NULL AND (paid = 1 OR paid_amount > 0)`,
      );
    }
    this.sql.exec('UPDATE members SET first_seen = COALESCE(created_at, last_seen) WHERE first_seen IS NULL AND last_seen IS NOT NULL');
  },

  /** The weekly email's words: { subject, body: { title, intro, details, outro } }. No awaits. */
  weeklyReportContent(last, before, report) {
    const was = (then) => (then == null ? '' : ` (${then} the week before)`);
    const c = last.checkIns;
    const details = [
      ['Regulars', `${last.regulars}${was(before?.regulars)}`],
      ['People with an account who came', `${last.visitors}${was(before?.visitors)}`],
      ['Visits, friends included', `${last.visits}${was(before?.visits)}`],
      ['Check-ins recorded', c.rate == null ? 'No sessions to check in' : `${c.rate}% (${plural(c.notRecorded, 'session', 'sessions')} with no check-in or payment, ${c.paidOnly} paid without a check-in)`],
      ['No-shows', String(last.noShows)],
      ['Bookings and sign-ups made', `${last.bookingsMade.online} online, ${last.bookingsMade.staff} by staff, ${last.bookingsMade.saved} saved for weekly regulars`],
      ['New to the Lair app', `${last.newMembers}${was(before?.newMembers)}`],
      ['TTRPG seats', last.ttrpg.sessions ? `${last.ttrpg.taken} of ${last.ttrpg.seats} taken, across ${plural(last.ttrpg.sessions, 'session', 'sessions')}` : 'No sessions'],
      ['Library games out', String(last.library.loansOut)],
      ['Library memberships now', String(report.library.memberships)],
    ];
    const names = { table: 'Tables', ttrpg: 'TTRPG seats', event: 'Event sign-ups' };
    for (const flow of STEP_FLOWS) {
      const s = last.steps[flow];
      if (!s.start && !s.login && !s.done) continue;
      const wall = s.login ? `; ${s.login} started logged out and were asked to log in first, and ${s['login-done']} of them finished` : '';
      details.push([`${names[flow]} on the website`, `${s.start} started, ${s.done} finished${wall}`]);
    }
    const sunday = addDays(last.week, 6);
    return {
      subject: `Lair numbers, ${dayLabel(last.week, LONG)} to ${dayLabel(sunday, LONG)}: ${plural(last.regulars, 'regular', 'regulars')}`,
      body: {
        title: `The Lair's week: ${weekLabel(last.week)}`,
        intro: [`Regulars is the one number to watch. ${REPORT_WORDS.regular}`, REPORT_WORDS.visit],
        details,
        outro: c.rate != null && c.rate < 80
          ? 'Under 80% of sessions were checked in, so some regulars may be missing from the count. Scanning everyone at the counter keeps it true.'
          : 'One week is noisy: a number moving the wrong way is a reason to look closer, not to undo a change.',
      },
    };
  },
};


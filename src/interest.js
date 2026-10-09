/**
 * Round 9, play: "I'm interested" for TTRPG sessions and "Maybe" (or "I'm coming", for events that take no sign-ups)
 * for event dates (contract v9-play). Mo (9 Oct 2026): "have the option to click on games with spaces in them to say you
 * are interested in joining or others can have an option to register interest and the gm will get back to you", and
 * "events for card games etc. where you say you are coming or even planning on coming … so that we can get rough
 * numbers".
 *
 * One row in `interests` per person per session or event date (status 'active', or 'removed' once they take it back).
 * A session's GM is emailed (replies go to the person) and sees who's interested on their own sessions; nothing is
 * booked. The public only ever get counts. These are methods of the Lair Durable Object (Object.assign onto its
 * prototype in lair.js), so `this` is the Lair, and each one keeps its rule: every await first, then one synchronous
 * read-check-write.
 */
import { ACTIVE, HOUR, LairTime, RuleError, checkMobile, findOccurrence, makeId } from './core.js';
import { emailReady, safeEqual } from './shopify.js';

/** Guest records join an account for this long after they end (as ADOPT_DAYS in lair.js) */
const ADOPT_DAYS = 30;
export const INTEREST_NOTE_MAX = 280;
export const INTEREST_KINDS = ['session', 'event'];
/** What each row says: a session's 'interested', an event date's 'maybe' or 'coming' (events with no sign-ups) */
export const INTEREST_LEVELS = ['interested', 'maybe', 'coming'];
/** Every message a customer can see, word for word in the contract */
export const INTEREST_MESSAGES = {
  kind: 'Say whether this is for a TTRPG session or an event.',
  session: 'That session could not be found. It may have finished or been cancelled.',
  event: 'That event date could not be found.',
  over: 'That one has already finished.',
  own: "That's your own game, friend. Your players can say they're interested.",
  name: 'Add your name.',
  email: 'Add your email so we can get back to you.',
  note: `Keep the note to ${INTEREST_NOTE_MAX} characters.`,
  seat: 'You already have a seat in this session. It’s in My Lair.',
  joined: 'You’re already signed up for this one. It’s in My Lair.',
  signUp: 'This one takes sign-ups, so sign up to keep your place.',
  missing: 'That could not be found. It may have been taken back already.',
  notYours: "That isn't yours to take back.",
};

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const trimmed = (v, max) => String(v ?? '').trim().slice(0, max);
/** "Thu 15 Oct" in the Lair's time zone */
const shortDay = (ms, tz) => new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms)).replace(/,/g, '');
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'Someone';

export const interestMethods = {
  /**
   * POST /interest { kind: 'session' | 'event', id, note?, coming?, name?, email?, phone? }. Anyone: a logged-in member
   * (their name and email fill in from their account when left out; a mobile is optional) or a guest with a name, email
   * and mobile. A session gets 'interested' and its GM is emailed; an event date gets 'maybe', or 'coming' with
   * coming: true when it takes no sign-ups (no capacity and no game tables). One per person (their account or their
   * email) per session or date: asking again changes the note or the level, and never emails the GM twice.
   * → { interest, counts, already, emailed }. A guest's interest carries its key, to take it back from that browser.
   */
  async addInterest(input, who, client = '') {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const kind = INTEREST_KINDS.includes(input.kind) ? input.kind : null;
    if (!kind) throw new RuleError(INTEREST_MESSAGES.kind);
    const targetId = trimmed(input.id, 120);
    let target;
    if (kind === 'session') {
      const game = targetId ? this.game(targetId) : null;
      if (!game || !['open', 'full'].includes(game.status)) throw new RuleError(INTEREST_MESSAGES.session, 404);
      if (game.end <= now) throw new RuleError(INTEREST_MESSAGES.over);
      if (who.customerId && String(game.gmCustomerId || '') === String(who.customerId)) throw new RuleError(INTEREST_MESSAGES.own);
      target = { title: game.title, start: game.start, end: game.end, game };
    } else {
      const occurrence = findOccurrence(rules, targetId);
      if (!occurrence) throw new RuleError(INTEREST_MESSAGES.event, 404);
      if (occurrence.end <= now) throw new RuleError(INTEREST_MESSAGES.over);
      target = { title: occurrence.title, start: occurrence.start, end: occurrence.end, occurrence };
    }
    const level = kind === 'session' ? 'interested' : input.coming === true ? 'coming' : 'maybe';
    if (level === 'coming' && (target.occurrence.capacity || target.occurrence.gameTables)) throw new RuleError(INTEREST_MESSAGES.signUp);
    const noteText = String(input.note ?? '').trim();
    if (noteText.length > INTEREST_NOTE_MAX) throw new RuleError(INTEREST_MESSAGES.note);
    const member = who.customerId ? this.memberRow(who.customerId) : null;
    const name = trimmed(input.name, 80) || trimmed(member?.name, 80);
    const email = trimmed(input.email, 120) || trimmed(member?.account_email || member?.email, 120);
    if (!name) throw new RuleError(INTEREST_MESSAGES.name);
    if (!isEmail(email)) throw new RuleError(INTEREST_MESSAGES.email);
    // a guest gives a mobile, as on a sign-up; a member's is optional (their profile has one)
    const phone = checkMobile(input.phone, { required: !who.customerId });
    this.checkRate(who, client, now);
    const me = who.customerId ? String(who.customerId) : null;
    // Already in: a seat at the session, or a sign-up or game table on the date, by their account or their email
    if (kind === 'session') {
      const seat = this.sql
        .exec("SELECT id, status FROM bookings WHERE game_id = ? AND kind = 'gm-seat' AND (customer_id = ? OR lower(email) = lower(?))", targetId, me || '', email)
        .toArray()
        .find((r) => ACTIVE.has(r.status));
      if (seat) throw new RuleError(INTEREST_MESSAGES.seat, 409);
    } else {
      const joined = this.sql
        .exec("SELECT COUNT(*) AS n FROM event_joins WHERE occurrence_id = ? AND status NOT IN ('cancelled', 'noshow') AND (customer_id = ? OR lower(email) = lower(?))", targetId, me || '', email)
        .one().n;
      const spot = this.sql
        .exec("SELECT COUNT(*) AS n FROM bookings WHERE occurrence_id = ? AND status IN ('held', 'confirmed', 'seated') AND (customer_id = ? OR lower(email) = lower(?))", targetId, me || '', email)
        .one().n;
      if (joined || spot) throw new RuleError(INTEREST_MESSAGES.joined, 409);
    }
    const note = noteText.slice(0, INTEREST_NOTE_MAX);
    const existing = this.sql
      .exec(
        `SELECT * FROM interests WHERE kind = ? AND target_id = ? AND status = 'active' AND ((customer_id IS NOT NULL AND customer_id = ?) OR lower(email) = lower(?))
         ORDER BY rowid LIMIT 1`,
        kind, targetId, me || '', email,
      )
      .toArray()[0];
    if (existing) {
      this.write(
        'UPDATE interests SET level = ?, note = ?, name = ?, phone = COALESCE(?, phone), customer_id = COALESCE(customer_id, ?), updated_at = ? WHERE id = ?',
        level, note || existing.note || '', name, phone || null, me, now, existing.id,
      );
      // Round 11: "Remind me the day before" (remind: true | false), and a waitlist row that's now a maybe (src/reminders.js)
      this.interestSaved(existing.id, input, now);
      const row = this.interestRow(existing.id);
      return { interest: this.interestView(row, { key: !me }), counts: this.interestCounts(kind, targetId), already: true, emailed: false };
    }
    const id = makeId('in');
    const key = crypto.randomUUID();
    this.write(
      `INSERT INTO interests (id, kind, target_id, level, status, name, email, phone, note, customer_id, remove_key, title, starts_at, ends_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, kind, targetId, level, name, email, phone || null, note, me, key, target.title, target.start, target.end, now, now,
    );
    // Round 11: "Remind me the day before" (src/reminders.js)
    this.interestSaved(id, input, now);
    this.touchMember(me, { name, email, mobile: phone }, now);
    // --- saved ---
    const row = this.interestRow(id);
    const emailed = kind === 'session' ? this.tellGmInterest(row, target.game, rules) : false;
    if (emailed) this.write('UPDATE interests SET notified_at = ? WHERE id = ?', now, id);
    return { interest: this.interestView(row, { key: !me }), counts: this.interestCounts(kind, targetId), already: false, emailed };
  },

  /**
   * POST /interest/:id/remove { key? }: take it back. The member it belongs to, staff, or a guest with its key (from
   * the answer that made it). → { ok, interest, counts }. Taking back one already taken back is fine.
   */
  async removeInterest(id, input, who) {
    // --- no awaits: one read-check-write ---
    const now = Date.now();
    const row = this.interestRow(trimmed(id, 60));
    if (!row) throw new RuleError(INTEREST_MESSAGES.missing, 404);
    const own = Boolean(who.customerId && row.customer_id && String(row.customer_id) === String(who.customerId));
    const keyed = typeof input?.key === 'string' && Boolean(row.remove_key) && safeEqual(input.key, row.remove_key);
    if (!who.staff && !own && !keyed) throw new RuleError(INTEREST_MESSAGES.notYours, 403);
    if (row.status === 'active') this.write("UPDATE interests SET status = 'removed', updated_at = ? WHERE id = ?", now, row.id);
    const fresh = this.interestRow(row.id);
    return { ok: true, interest: this.interestView(fresh), counts: this.interestCounts(fresh.kind, fresh.target_id) };
  },

  /** One row by id, or null. No awaits. */
  interestRow(id) {
    return id ? this.sql.exec('SELECT * FROM interests WHERE id = ?', String(id)).toArray()[0] || null : null;
  },

  /**
   * An interest as the person who left it sees it: { id, kind, targetId, level, status, note, title, start, end, at }, and
   * its key when it's a guest's (key: true), so that browser can take it back.
   */
  interestView(r, { key = false } = {}) {
    return {
      id: r.id, kind: r.kind, targetId: r.target_id, level: r.level, status: r.status, name: r.name, note: r.note || '', title: r.title || '',
      start: r.starts_at, end: r.ends_at, at: r.created_at, ...(key && r.remove_key ? { key: r.remove_key } : {}),
      // Round 11: the reminder the day before (remind: they want one; reminded: it went) and a waitlist row's people
      remind: Boolean(r.remind), reminded: Boolean(r.reminded_at), people: r.level === 'waitlist' ? Number(r.people) || 1 : null,
    };
  },

  /** How many: { interested } for a session, { maybe, coming } for an event date. Counts only, never names. No awaits. */
  interestCounts(kind, targetId) {
    const rows = this.sql.exec("SELECT level, COUNT(*) AS n FROM interests WHERE kind = ? AND target_id = ? AND status = 'active' GROUP BY level", kind, targetId).toArray();
    const n = (level) => Number(rows.find((r) => r.level === level)?.n || 0);
    if (kind === 'session') return { interested: n('interested') };
    // Round 11: waiting, the people on a full date's waitlist (never counted as places taken), when there are any
    const waiting = this.waitingOn(targetId).people;
    return { maybe: n('maybe'), coming: n('coming'), ...(waiting ? { waiting } : {}) };
  },

  /**
   * For GET /floor: every active interest in [from, to), as { events: { [occurrenceId]: { maybe, coming } }, sessions:
   * { [gameId]: count }, rows }. No awaits.
   */
  interestsIn(from, to) {
    const rows = this.sql.exec("SELECT * FROM interests WHERE status = 'active' AND ends_at > ? AND starts_at < ? ORDER BY created_at, rowid", from, to).toArray();
    const events = {};
    const sessions = {};
    for (const r of rows) {
      if (r.kind === 'event') {
        const c = events[r.target_id] || (events[r.target_id] = { maybe: 0, coming: 0 });
        if (r.level === 'coming') c.coming += 1;
        // Round 11: a waitlist row counts its people as waiting (there when anyone is), never as a maybe
        else if (r.level === 'waitlist') c.waiting = (c.waiting || 0) + (Number(r.people) || 1);
        else c.maybe += 1;
      } else sessions[r.target_id] = (sessions[r.target_id] || 0) + 1;
    }
    return { events, sessions, rows };
  },

  /**
   * Who's interested, for the session's GM and for staff: { id, name, email, phone, note, at, member }. The person asked
   * the GM to get back to them, so their email and mobile go with it (the GM's email says the same).
   */
  interestPerson(r) {
    return { id: r.id, name: r.name, email: r.email, phone: r.phone || '', note: r.note || '', at: r.created_at, member: Boolean(r.customer_id) };
  },

  /** Staff: an event date's interest with names, for the Events tab and Today's sign-ups */
  staffInterest(r) {
    return { ...this.interestPerson(r), kind: r.kind, level: r.level, occurrenceId: r.kind === 'event' ? r.target_id : null, gameId: r.kind === 'session' ? r.target_id : null, title: r.title || '', start: r.starts_at, end: r.ends_at, customerId: r.customer_id || null,
      // Round 11: a waitlist row's people, and whether they asked for a reminder the day before
      people: r.level === 'waitlist' ? Number(r.people) || 1 : null, remind: Boolean(r.remind) };
  },

  /** GET /me's interests: their active ones for sessions and dates still to come, soonest first. No awaits. */
  memberInterests(customerId, now) {
    if (!customerId) return [];
    return this.sql
      .exec("SELECT * FROM interests WHERE customer_id = ? AND status = 'active' AND ends_at > ? ORDER BY starts_at, rowid", String(customerId), now)
      .toArray()
      .map((r) => this.interestView(r));
  },

  /**
   * A guest's interest joins their account when they log in with that email (as adoptGuestBookings), and a second one
   * for the same session or date (theirs already, by account) is taken back so they're counted once. No awaits.
   */
  adoptInterests(customerId, email, now) {
    const since = now - ADOPT_DAYS * 24 * HOUR;
    const id = String(customerId);
    const n = this.sql.exec('SELECT COUNT(*) AS n FROM interests WHERE customer_id IS NULL AND lower(email) = lower(?) AND ends_at > ?', email, since).one().n;
    if (!n) return 0;
    this.write('UPDATE interests SET customer_id = ?, updated_at = ? WHERE customer_id IS NULL AND lower(email) = lower(?) AND ends_at > ?', id, now, email, since);
    this.write(
      `UPDATE interests SET status = 'removed', updated_at = ? WHERE customer_id = ? AND status = 'active'
         AND rowid NOT IN (SELECT MIN(rowid) FROM interests WHERE customer_id = ? AND status = 'active' GROUP BY kind, target_id)`,
      now, id, id,
    );
    return n;
  },

  /**
   * The GM hears that someone is interested in their session ("Ruby is interested in Curse of Strahd on Thu 15 Oct"),
   * with the note and how to reach them: replies go to the person. With no GM email on file, the staff get it to pass
   * on. Returns whether an email went. No awaits.
   */
  tellGmInterest(row, game, rules) {
    if (!game || !emailReady(this.env)) return false;
    const toGm = isEmail(game.gmEmail);
    if (!toGm && !this.env.STAFF_EMAIL) return false;
    const st = this.state(game.start - 1, game.end + 1);
    const { taken } = this.gameView(game, st, rules);
    const left = Math.max(0, game.seats - taken);
    const day = shortDay(game.start, rules.tz || new LairTime().tz);
    const subject = `${firstName(row.name)} is interested in ${game.title} on ${day}`;
    const content = {
      title: toGm ? 'Someone wants in!' : 'Someone wants in on a game',
      intro: toGm
        ? `Kia ora ${game.gm}, ${row.name} is interested in ${game.title} on ${day}. ${left ? `There ${left === 1 ? 'is 1 seat' : `are ${left} seats`} left.` : 'It’s full, so they’d like to hear if a seat comes up.'} Nothing is booked yet: get back to them and they can take a seat.`
        : `${row.name} is interested in ${game.gm ? `${game.gm}'s game ` : ''}${game.title} on ${day}. There's no email on file for the GM, so please pass this on.`,
      details: [['Name', row.name], ['Email', row.email], ['Mobile', row.phone || ''], ['Their note', row.note || ''], ['When', this.when(game, rules)], ['Seats left', `${left} of ${game.seats}`]],
      outro: 'Reply to this email to get back to them.',
      button: { label: 'See the games board', url: this.page('gm') },
    };
    const replyTo = isEmail(row.email) ? row.email : null;
    if (toGm) this.later(this.mail(this.letter(game.gmEmail, subject, { ...content, signoff: 'Gobgob' }, { replyTo })));
    else this.notifyStaff(subject, content, { replyTo });
    return true;
  },
};

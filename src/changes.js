/**
 * Round 37 (14 Nov 2026): changes people make themselves (contract v37-changes). Mo: "I want a way for the
 * users/customers to cancel table bookings down from a number of players to what ever number so one customer dropped
 * from 9 players to 6 and he was 3 days early so he completely had the chance to change but wasn't given an option other
 * than cancelling. [...] Also for gms and their games I want them to have the chance to cancel their games too so long
 * as they are before the 24 hour period and they even have the chance to change the time and date and given the option
 * to choose to keep that new date or is it a one off etc."
 *
 * One rule for all of it: whoever made it can change it themselves until refundHours (24) before it starts, the moment
 * round 15 locks a booking in. After that staff sort it out.
 *
 *  - A table booking's numbers (changeOwnBooking, from updateBooking): whoever booked it changes how many are coming, and
 *    which of its tables it keeps. The price follows, the tables it lets go are free at once, and they get an email.
 *    Nothing here ever makes a refund: a booking with more paid on it than the new amount is staff's to change.
 *  - A GM cancels until 24 hours before (gmCanChange, read by updateGame). It was an hour after the start.
 *  - A GM moves a session (moveGame, POST /games/:id/move): its day, time or tables, for that session only or, in a
 *    weekly or fortnightly game, for every later session too (the game takes the new day and time). Players hear, and
 *    a seat whose time changed can be dropped for 24 hours after the move even inside the usual lock (movedUntil, read
 *    by cancelRule).
 *  - games.slot_day: the game's date a session fills when it isn't the day it starts on, so the top-up (planSessions)
 *    never puts a second session on a date one left. Staff's Edit session keeps it too (sessionTimeMoved), which fixes a
 *    twin: a weekly session staff moved to another day used to come back on its old day at the next 10-minute run.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair; each
 * keeps its rule: every await first, then one synchronous read-check-write.
 */
import {
  ACTIVE, HOUR, MIN, LairTime, ONLINE_LIMITS, RuleError, addDays, cancelUntil, checkGameSession, makeId, maxGameTables, maxOnlineTables, tableIndex,
} from './core.js';
import { emailReady } from './shopify.js';
import { clockLabel } from './email.js';

/**
 * Made sure of on every start (added when missing), as round 15's columns are:
 *  - bookings.moved_at: when a seat's session last changed time under it (ms). Its player can drop it until refundHours
 *    after that, or until it starts if that's sooner.
 *  - games.slot_day: the series date ('YYYY-MM-DD') a session of a weekly or fortnightly game fills, kept once that isn't
 *    the day it starts on (moved on its own, or left where it was when the game took a new day).
 */
export const CHANGE_COLUMNS = [['bookings', 'moved_at', 'INTEGER'], ['games', 'slot_day', 'TEXT']];
/**
 * How often in 24 hours: a booking's numbers by whoever booked it (each change emails the address on the booking, which
 * they typed, so it's capped like any email someone can set off), and a game's sessions by its GM (each move emails
 * its players and the team; a whole series counts as one game). Staff aren't limited. Counted in `messages`, as the
 * GM's messages to players are (limit_key 'ch:<booking id>' and 'mv:<series or game id>').
 */
export const CHANGE_LIMITS = { numbers: 6, moves: 5 };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const tablesWord = (ids) => `${ids.length > 1 ? 'Tables' : 'Table'} ${ids.join(', ')}`;
const hoursOf = (rules) => (Number(rules?.refundHours) >= 0 ? Number(rules.refundHours) : 24);

/** Every message a customer, a GM, a player or the team can see, word for word in the contract (v37-changes) */
export const CHANGE_WORDS = {
  /* ---- a table booking's numbers ---- */
  notHere: "That booking's numbers can't be changed online. Have a chat with us and we'll sort it out.",
  cancelled: "That booking's been cancelled, so there's nothing to change.",
  started: "That one has already started, so it can't be changed online. Have a chat with us at the counter.",
  locked: (hours) => `It's less than ${hours} hours away, so it can't be changed online now: it stays on your tab as it is. Have a chat with us at the counter or give us a call, and we'll sort it out.`,
  people: 'Tell us how many people are coming. To call it off, cancel the booking instead.',
  minPeople: (room, min) => `${room} is for groups of ${min} or more. To come with fewer, cancel this booking and book another table.`,
  tooMany: (tables, seats) => `Your ${tables === 1 ? 'table seats' : 'tables seat'} ${seats}. For a bigger group, book another table or give us a call.`,
  tablesOwn: 'Pick from the tables on this booking.',
  tablesSeats: (people, seats) => `${plural(people, 'person needs', 'people need')} more tables than that (those seat ${seats}).`,
  tablesMany: (people, allowed) => `That's more tables than ${plural(people, 'person needs', 'people need')}. Keep up to ${allowed}.`,
  paid: "You've paid for more people than that already. Have a chat with us at the counter or give us a call, and we'll sort out the change and your money back.",
  tooOften: `That's ${CHANGE_LIMITS.numbers} changes to this booking today. Give us a call and we'll sort the rest out.`,
  /** on the booking's notes, for staff: "[Changed online: 9 to 6 people, T8 freed]" */
  note: (from, to, freed) => `[Changed online: ${from === to ? plural(to, 'person', 'people') : `${from} to ${plural(to, 'person', 'people')}`}${freed.length ? `, ${freed.join(', ')} freed` : ''}]`,
  /* ---- a GM cancelling ---- */
  gmCancelLocked: (hours) => `It's less than ${hours} hours away, so it can't be cancelled online now. Give us a call or see us at the counter, and we'll sort it out with your players.`,
  keptSessions: (whens, hours) => (whens.length === 1
    ? `${whens[0]} is less than ${hours} hours away, so it's still on. Give us a call if it can't run.`
    : `Those sessions are less than ${hours} hours away, so they're still on: ${whens.join('; ')}. Give us a call if one can't run.`),
  /* ---- a GM moving a session ---- */
  moveWho: 'Only the GM or staff can move a session.',
  moveCancelled: 'That game was cancelled. List it again as a new game.',
  moveOver: "That session's over, so there's nothing to move.",
  nothing: 'Pick the new day, time or tables.',
  time: 'That time is not valid.',
  scope: "Choose whether it's just this session or every later session too.",
  seriesKind: 'Only a weekly or fortnightly game has a usual day to change. Move this session on its own.',
  seriesWho: 'Only staff, or the GM who runs this game, can change every later session.',
  ownSlot: "This session was moved on its own before. Open one that's on the game's usual day to change every later session.",
  moveLocked: (hours) => `It's less than ${hours} hours away, so it can't be moved online now. Give us a call or see us at the counter, and we'll sort it out with your players.`,
  soon: "That's too soon. Pick a later time.",
  far: 'That date is too far ahead to book yet.',
  notice: (hours) => `Your players need a day's notice. Pick a time at least ${hours} hours from now.`,
  price: 'Those tables are in a room with a different table fee, which would change what your players pay. Pick tables in the same room, or ask the team.',
  between: (after, before) => `Keep it between the sessions before and after it: ${[after ? `after ${after}` : '', before ? `before ${before}` : ''].filter(Boolean).join(' and ')}. To move it further, cancel it and add a new date.`,
  shift: (step) => `That's ${step === 14 ? 'a fortnight' : 'a week'} or more from its usual day. Pick a day closer to it, or cancel sessions and add new dates.`,
  movesToday: `That's ${CHANGE_LIMITS.moves} changes to this game today. Try again tomorrow, or ask the team to help.`,
  /** why a later session stayed where it was */
  keptOwn: 'It was moved on its own before, so it stays where it is.',
  keptOther: "Another GM runs it, so it stays where it is.",
  keptClash: 'The session you moved is on those tables at that time.',
  /* ---- the emails ---- */
  changedSubject: (what, day) => `Booking changed: ${what} on ${day}`,
  changedTitle: "Your booking's changed",
  changedIntro: (name) => `Kia ora ${name}, Gobgob has updated your table at the Dice Goblin Lair.`,
  wasPeople: (now, was) => `${now} (it was ${was})`,
  freed: (kept, freed) => `${tablesWord(kept)} (${freed.join(', ')} ${freed.length === 1 ? 'is' : 'are'} back on the map for someone else)`,
  /** one more line under a table's confirmation and its two-day reminder, while its numbers can be changed */
  numbersBy: 'Numbers changed? Update them in My Lair by then too.',
  numbersAny: 'Numbers changed? Update them in My Lair any time before it starts.',
  movedSubject: (title, when) => `New time: ${title}, ${when}`,
  movedTitle: 'Your game has a new time',
  movedIntro: (title) => `Heads up, friend: ${title} has moved. Your seat moved with it.`,
  /** a regular whose seat at that session is saved, not booked yet (regulars are booked into the next session only) */
  movedSaved: (title) => `Heads up, friend: ${title} has moved. Gobgob saves your seat at the new time.`,
  dropBy: (until) => `Can't make the new time? Cancel your seat in My Lair by ${until} and Gobgob will let your GM know. After that it stays on your tab.`,
  dropByCovered: (until) => `Can't make the new time? Cancel your seat in My Lair by ${until} and Gobgob will let your GM know. After that it's locked in.`,
  dropAny: "Can't make the new time? Cancel your seat in My Lair any time before it starts and Gobgob will let your GM know.",
  dropByGuest: (until) => `Can't make the new time? Reply to this email or give us a call by ${until}.`,
  dropAnyGuest: "Can't make the new time? Reply to this email or give us a call before it starts.",
  seriesSubject: (title, day) => `New time from ${day}: ${title}`,
  seriesIntro: (title, slot, day) => `Heads up, friend: ${title} is moving to ${slot}, from ${day}.`,
  savedSeat: 'Gobgob saves it at the new time',
  regularOut: "Can't make the new time? Skip a session or stop saving your seat in My Lair.",
  staffSubject: (title) => `Moved by its GM: ${title}`,
  staffTitle: 'A GM moved a session',
  staffIntro: (gm, title, was, now) => `${gm} moved ${title} from ${was} to ${now}.`,
  staffTables: (gm, title, was, now, when) => `${gm} moved ${title} from ${was} to ${now}, at the same time: ${when}.`,
  staffSeries: (slot) => ` Every later session moves with it: ${slot} from now on.`,
  staffTold: (n) => (n ? ` ${plural(n, 'person was', 'people were')} told by email.` : ' Nobody had a seat, so there was no one to tell.'),
};

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
/** What's still owed on a booking, and whether it's paid up (lair.js's owing and settled) */
const owing = (x) => Math.max(0, (x.amount || 0) - (x.covered || 0) - (x.paidAmount || 0));
const settled = (x) => ((x.amount || 0) > 0 ? owing(x) === 0 : Boolean(x.paid));
/** Tables in table order: T2 before T10, a room's together */
const inTableOrder = (ids) => [...ids].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }));
const sameTables = (a, b) => inTableOrder(a).join() === inTableOrder(b).join();
/** "Tuesday 17 November" and "Friday" in the Lair's time zone (some ICU versions put a comma after the weekday) */
const longDay = (ms, tz) => new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(ms)).replace(/,/g, '');
const weekdayOf = (ms, tz) => new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'long' }).format(new Date(ms));
/** A series' step in days: 7, 14, or 0 when it has no usual day (a flexible game, or one that's stopped) */
const stepOf = (series) => (series?.status !== 'active' ? 0 : series.schedule === 'weekly' ? 7 : series.schedule === 'fortnightly' ? 14 : 0);
/** "Fridays at 7pm", "every second Friday at 7pm" */
const slotWords = (start, step, time) => `${step === 14 ? `every second ${weekdayOf(start, time.tz)}` : `${weekdayOf(start, time.tz)}s`} at ${clockLabel(time.minutesOf(start))}`;
/** "Fridays, 7pm to 11pm" */
const slotSpan = (start, end, time) => `${weekdayOf(start, time.tz)}s, ${clockLabel(time.minutesOf(start))} to ${clockLabel(time.minutesOf(end))}`;

export const changeMethods = {
  /* ---------------- a table booking's numbers ---------------- */
  /**
   * What a table booking's own account can change about it, from the rooms as they are now: the people it can have (min:
   * the room's minimum, or 1; max: the seats at its tables, 24 at most), the price a person, and how many of its tables
   * that many people may keep (the booking rule: enough to seat them, double for a wargame or big box game, 2 at least
   * with a library game on it; any tables beyond the rule that it already has, which staff gave it, it keeps). null when
   * its tables aren't on the floor any more. No awaits.
   */
  changeShape(booking, rules) {
    const index = tableIndex(rules.rooms);
    const known = (booking.tables || []).map((id) => index.get(id));
    if (!known.length || known.some((t) => !t)) return null;
    const room = known[0].roomObj;
    const seatsOf = (ids) => ids.reduce((sum, id) => sum + (index.get(id)?.seats || room.seats), 0);
    const per = Math.min(...known.map((t) => t.seats || room.seats));
    const rule = (people) => (booking.game ? maxGameTables(people, per) : maxOnlineTables(people, per, booking.extras || []));
    const extra = Math.max(0, booking.tables.length - rule(booking.people || 1));
    const min = Math.max(1, room.minPeople || 0);
    const max = Math.max(min, Math.min(ONLINE_LIMITS.people, seatsOf(booking.tables)));
    return { room, seatsOf, min, max, each: room.price, allowed: (people) => Math.min(booking.tables.length, rule(people) + extra) };
  },

  /**
   * Whether whoever booked a booking can change its numbers now, as changeOwnBooking would let them: their table (not a
   * game table at an event), confirmed, still to come and not locked in. No awaits.
   */
  canChangeOwn(booking, rules, now = Date.now()) {
    if (!booking || !rules || !booking.customerId || booking.kind !== 'table' || booking.occurrenceId) return false;
    if (booking.status !== 'confirmed' || booking.arrivedAt || booking.start <= now) return false;
    return !this.cancelRule(booking, rules, now).locked;
  },

  /**
   * `change` on their view of a booking: { until, min, max, each, keep } while they can change it, {} otherwise.
   * keep[i]: the tables it may keep with min + i people. No awaits.
   */
  changeView(booking, rules = this.rulesCache, now = Date.now()) {
    if (!this.canChangeOwn(booking, rules, now)) return {};
    const shape = this.changeShape(booking, rules);
    if (!shape) return {};
    const keep = [];
    for (let people = shape.min; people <= shape.max; people += 1) keep.push(shape.allowed(people));
    return { change: { until: this.cancelRule(booking, rules, now).cancelUntil, min: shape.min, max: shape.max, each: shape.each, keep } };
  },

  /**
   * Whoever booked a table changes how many are coming (people) and which of its tables it keeps (tables): from
   * updateBooking, once it's checked the booking is theirs. Until it's locked in, as cancelling is. Nothing is saved, and
   * nobody is emailed, when what's asked is how it stands. → { booking, changed }. No awaits.
   */
  changeOwnBooking(booking, patch, rules, now) {
    const W = CHANGE_WORDS;
    if (booking.status === 'cancelled') throw new RuleError(W.cancelled, 409);
    if (booking.kind !== 'table' || booking.occurrenceId || booking.status === 'held') throw new RuleError(W.notHere, 409);
    if (booking.status !== 'confirmed' || booking.arrivedAt || booking.start <= now) throw new RuleError(W.started, 409);
    if (this.cancelRule(booking, rules, now).locked) throw new RuleError(W.locked(hoursOf(rules)), 409);
    const shape = this.changeShape(booking, rules);
    if (!shape) throw new RuleError(W.notHere, 409);
    let people = booking.people;
    if (patch.people != null) {
      const raw = patch.people;
      people = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
      if (!Number.isInteger(people) || people < 1) throw new RuleError(W.people);
      if (people < shape.min) throw new RuleError(W.minPeople(shape.room.name, shape.min));
      if (people > shape.max) throw new RuleError(W.tooMany(booking.tables.length, shape.max));
    }
    const allowed = shape.allowed(people);
    let tables;
    if (Array.isArray(patch.tables)) {
      const asked = [...new Set(patch.tables.map(String))];
      if (!asked.length || asked.some((t) => !booking.tables.includes(t))) throw new RuleError(W.tablesOwn);
      tables = booking.tables.filter((t) => asked.includes(t));
      if (shape.seatsOf(tables) < people) throw new RuleError(W.tablesSeats(people, shape.seatsOf(tables)));
      if (tables.length > allowed) throw new RuleError(W.tablesMany(people, allowed));
    } else {
      tables = booking.tables.length <= allowed ? booking.tables : inTableOrder(booking.tables).slice(0, allowed);
    }
    if (people === booking.people && tables.length === booking.tables.length) return { booking: this.ownView(booking), changed: null };
    const amount = shape.each * people;
    // Money already on it for more people than this: staff make that change, with the money back (nothing here ever
    // makes a refund)
    if ((booking.paidAmount || 0) + (booking.covered || 0) > amount) throw new RuleError(W.paid, 409);
    // A monthly account: a bigger booking is held to its credit limit as a new booking of that size would be
    if (amount > (booking.amount || 0)) this.checkAccountLimit(booking.customerId, amount, rules, now, 'book');
    // Each change emails the address on the booking: a handful a day, then it's a call
    if (this.changesToday(`ch:${booking.id}`, now) >= CHANGE_LIMITS.numbers) throw new RuleError(W.tooOften, 429);
    const freed = booking.tables.filter((t) => !tables.includes(t));
    const note = W.note(booking.people, people, freed);
    const next = { ...booking, people, tables, amount, notes: `${booking.notes ? `${booking.notes} ` : ''}${note}`.slice(0, 500) };
    next.paid = settled(next);
    this.saveBooking(next, now);
    this.noteChange(`ch:${booking.id}`, booking.id, 'change', note, 'member', now);
    // its library game is kept true to it, and a bill with it on stays true (as a staff change does)
    if (next.game) this.bookingGameChanged(booking, now);
    this.reconcileBills(rules, now);
    const fresh = this.booking(booking.id);
    this.tellBookingChanged(booking, fresh, rules);
    return {
      booking: this.ownView(fresh),
      changed: {
        people: { from: booking.people, to: people }, tables: { from: booking.tables, to: tables, freed }, amount: { from: booking.amount || 0, to: amount },
      },
    };
  },

  /** How many changes were made under a limit key in the last 24 hours (CHANGE_LIMITS). No awaits. */
  changesToday(limitKey, now) {
    return this.sql.exec('SELECT COUNT(*) AS n FROM messages WHERE limit_key = ? AND created_at > ?', limitKey, now - 24 * HOUR).one().n;
  },

  /** One change counted under its limit key, with what it was (a row in `messages`, where such limits are kept). No awaits. */
  noteChange(limitKey, targetId, scope, text, sender, now) {
    this.write(
      'INSERT INTO messages (id, game_id, limit_key, scope, text, recipients, sent, sender, created_at) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)',
      makeId('ms'), targetId, limitKey, scope, String(text).slice(0, 500), sender, now,
    );
  },

  /**
   * One more line for a table's confirmation and its two-day reminder, while whoever booked it can change its numbers:
   * by the same moment as cancelling, or any time before it starts for one that never locks. '' otherwise. No awaits.
   */
  numbersLine(booking, rules, now = Date.now()) {
    if (!this.canChangeOwn(booking, rules, now)) return '';
    return this.cancelRule(booking, rules, now).lockable ? CHANGE_WORDS.numbersBy : CHANGE_WORDS.numbersAny;
  },

  /** "Your booking's changed", to whoever booked it: what it was and is, then its own tab lines. No awaits. */
  tellBookingChanged(before, after, rules) {
    if (!emailReady(this.env) || !isEmail(after.email)) return false;
    const W = CHANGE_WORDS;
    const freed = before.tables.filter((t) => !after.tables.includes(t));
    const due = after.paid || after.waived ? 0 : owing(after);
    const paidSoFar = after.paidAmount || 0;
    const fee = after.waived ? 'Nothing to pay'
      : due === 0 && after.amount > 0 ? `${dollars(after.amount)}, paid. Thank you!`
        : paidSoFar > 0 ? `${dollars(due)} left on your tab (${dollars(paidSoFar)} of ${dollars(after.amount)} paid)`
          : `${dollars(after.amount)}, ${after.customerId ? 'on your tab' : 'pay at the counter on the day'}`;
    const day = longDay(after.start, rules.tz);
    const what = after.people !== before.people ? plural(after.people, 'person', 'people') : tablesWord(after.tables);
    this.later(this.mail(this.letter(after.email, W.changedSubject(what, day), {
      title: W.changedTitle,
      intro: W.changedIntro(after.name),
      details: [
        ['When', this.when(after, rules)],
        ['People', after.people !== before.people ? W.wasPeople(after.people, before.people) : String(after.people)],
        ['Where', freed.length ? W.freed(after.tables, freed) : tablesWord(after.tables)],
        ['Fee', after.amount !== before.amount ? W.wasPeople(fee, dollars(before.amount || 0)) : fee],
      ],
      outro: this.tabLines(after, rules, { spot: 'table' }),
      button: { label: 'See it in My Lair', url: this.page('myLair') },
    })));
    return true;
  },

  /* ---------------- a GM's own changes: until 24 hours before ---------------- */
  /** Whether a session's GM can still cancel or move it online: more than refundHours before it starts. No awaits. */
  gmCanChange(game, rules, now = Date.now()) {
    return now < cancelUntil(game, rules);
  },

  /**
   * A seat whose session changed time under it can be dropped until refundHours after that (never after it starts), even
   * inside the usual lock: cancelRule takes the later of the two. 0 for anything else. No awaits.
   */
  movedUntil(x, rules) {
    if (x?.kind !== 'gm-seat' || !x.movedAt) return 0;
    return Math.min(x.start, x.movedAt + hoursOf(rules) * HOUR);
  },

  /**
   * The series date a session fills: the one kept on it (slot_day), else the day it starts on when that's one of the
   * game's dates (first_day, then every step days), else null (moved before round 37, or added by hand). No awaits.
   */
  slotOf(session, series, step, time) {
    if (session.slotDay) return session.slotDay;
    if (!series || !step) return null;
    const key = time.key(session.start);
    const off = time.daysBetween(series.first_day, key);
    return ((off % step) + step) % step === 0 ? key : null;
  },

  /**
   * A session's time has changed (place: where it is now; game: how it was): each seat still on is marked moved, so its
   * player has a day to drop out, and in a weekly or fortnightly game the date it left stays its date, so the top-up
   * never puts a second session there. For staff's Edit session and a move of one session. No awaits.
   */
  sessionTimeMoved(game, place, rules, now) {
    this.write("UPDATE bookings SET moved_at = ?, updated_at = ? WHERE game_id = ? AND kind = 'gm-seat' AND status IN ('held', 'confirmed', 'seated')", now, now, game.id);
    if (!game.seriesId) return;
    const series = this.sql.exec('SELECT * FROM series WHERE id = ?', game.seriesId).toArray()[0];
    const step = stepOf(series);
    if (!step) return;
    const time = new LairTime(rules.tz);
    const slot = this.slotOf(game, series, step, time);
    if (!slot) return;
    this.write('UPDATE games SET slot_day = ? WHERE id = ?', time.key(place.start) === slot ? null : slot, game.id);
  },

  /**
   * One session to its new place: the session itself, its GM's hold and every seat still on (a GM's charge for a seat
   * takes no table: only its times move), then the charges' own upkeep. The price stays (the caller keeps a move in
   * rooms with the same fee). No awaits.
   */
  placeSession(session, place, rules, now) {
    this.saveGame({ ...session, tables: place.tables, start: place.start, end: place.end, room: place.room }, now);
    this.write(
      "UPDATE bookings SET tables = ?, starts_at = ?, ends_at = ?, room = ?, updated_at = ? WHERE game_id = ? AND kind != 'gm-cover' AND status IN ('held', 'confirmed', 'seated')",
      JSON.stringify(place.tables), place.start, place.end, place.room, now, session.id,
    );
    this.write("UPDATE bookings SET starts_at = ?, ends_at = ?, updated_at = ? WHERE game_id = ? AND kind = 'gm-cover' AND status != 'cancelled'", place.start, place.end, now, session.id);
  },

  /** The last line of a "New time" email: how this seat's player drops out now, from its own cancel rule. No awaits. */
  moveCancelLine(seat, rules, now = Date.now()) {
    const W = CHANGE_WORDS;
    const rule = this.cancelRule(seat, rules, now);
    const member = Boolean(seat.customerId);
    if (!rule.lockable || rule.locked) return member ? W.dropAny : W.dropAnyGuest;
    const until = new LairTime(rules.tz).label(rule.cancelUntil);
    if (!member) return W.dropByGuest(until);
    return seat.coveredBy ? W.dropByCovered(until) : W.dropBy(until);
  },

  /**
   * "New time: <game>, <when>" for one session that moved (was: the session before): a letter for each seat on it with
   * an email, ending with that seat's own way out, and one for each regular whose seat there is saved but not booked
   * yet (regulars are booked into a game's next session only), so nobody turns up at the old time. For a move of one
   * session, by its GM or by staff (Edit session). → the letters. No awaits.
   */
  movedLetters(fresh, was, rules, now) {
    const W = CHANGE_WORDS;
    const base = {
      title: W.movedTitle,
      details: [['Game', fresh.title], ['Now', this.when(fresh, rules)], ['Was', this.when(was, rules)], ['Where', tablesWord(fresh.tables)]],
      button: { label: 'See it in My Lair', url: this.page('myLair') },
    };
    const subject = W.movedSubject(fresh.title, this.when(fresh, rules));
    const told = new Set();
    const letters = [];
    for (const seat of this.gameBookings(fresh.id).filter((b) => b.kind === 'gm-seat' && ACTIVE.has(b.status) && isEmail(b.email))) {
      told.add(seat.email.trim().toLowerCase());
      letters.push(this.letter(seat.email, subject, { ...base, intro: W.movedIntro(fresh.title), outro: this.moveCancelLine(seat, rules, now) }));
    }
    if (fresh.seriesId && fresh.start > now) {
      const st = this.state(fresh.start - 1, fresh.end + 1);
      for (const m of this.savedRegulars(st, st.games.find((g) => g.id === fresh.id))) {
        if (!isEmail(m.email) || told.has(m.email.trim().toLowerCase())) continue;
        told.add(m.email.trim().toLowerCase());
        letters.push(this.letter(m.email, subject, { ...base, intro: W.movedSaved(fresh.title), outro: W.regularOut }));
      }
    }
    return letters;
  },

  /**
   * POST /games/:id/move { start?, end?, tables?, scope? } (the session's GM, or staff with GM games): a session's day,
   * time or tables. Its GM: until refundHours before it starts, in a room with the same table fee, with a day's notice
   * when anyone has a seat, and never past the sessions either side of it. scope 'series' (a weekly or fortnightly game,
   * by whoever runs it): every later session on the game's usual day and time moves by the same number of days to the
   * new time, where its tables are free then, and the game takes the new day and time for the dates it adds later.
   * → { game, scope, moved, kept: [{ id, start, when, reason }], told }
   */
  async moveGame(id, body, who) {
    const input = body && typeof body === 'object' ? body : {};
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const W = CHANGE_WORDS;
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    const staffGames = this.can(who, 'sessions');
    const own = Boolean(who?.customerId) && String(game.gmCustomerId || '') === String(who.customerId);
    if (!staffGames && !own) throw new RuleError(W.moveWho, 403);
    if (game.status === 'cancelled') throw new RuleError(W.moveCancelled, 409);
    if (game.end <= now) throw new RuleError(W.moveOver, 409);
    const scope = input.scope == null || input.scope === '' ? 'session' : input.scope;
    if (!['session', 'series'].includes(scope)) throw new RuleError(W.scope);
    const time = new LairTime(rules.tz);
    const hours = hoursOf(rules);
    const series = game.seriesId ? this.sql.exec('SELECT * FROM series WHERE id = ?', game.seriesId).toArray()[0] : null;
    const step = stepOf(series);
    if (scope === 'series') {
      if (!step) throw new RuleError(W.seriesKind);
      if (!this.runsSeries(who, game.seriesId)) throw new RuleError(W.seriesWho, 403);
    }
    const wantsTables = Array.isArray(input.tables) && input.tables.length > 0;
    if (input.start == null && input.end == null && !wantsTables) throw new RuleError(W.nothing);
    const start = input.start != null ? Number(input.start) : game.start;
    const end = input.end != null ? Number(input.end) : start + (game.end - game.start);
    // (a real time, within a day's length and a few years of now, before anything is read or worked out from it)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 24 * HOUR || Math.abs(start - now) > 3 * 366 * 24 * HOUR) throw new RuleError(W.time);
    const tables = wantsTables ? [...new Set(input.tables.map(String))] : game.tables;
    const timeChanged = start !== game.start || end !== game.end;
    const tablesChanged = !sameTables(tables, game.tables);
    // Its GM: until refundHours before it starts, as for cancelling. Staff: until it ends.
    if (!staffGames && !this.gmCanChange(game, rules, now)) throw new RuleError(W.moveLocked(hours), 409);
    const view = (g) => this.gameView(g, this.state(g.start - 1, g.end + 1), rules, null, { staff: this.staffSees(who) });
    if (!timeChanged && !tablesChanged) return { game: view(game), scope, moved: 0, kept: [], told: 0 };
    const seats = this.gameBookings(game.id).filter((b) => b.kind === 'gm-seat' && ACTIVE.has(b.status));
    if (!staffGames && timeChanged) {
      // the lead time and how far ahead the Lair books, as for listing a game (staff skip both, as Edit session does)
      if (start < now + rules.leadMinutes * MIN) throw new RuleError(W.soon);
      if (start > now + rules.horizonDays * 24 * HOUR) throw new RuleError(W.far);
      // a day's notice, when anyone has a seat or a regular's is saved
      if ((seats.length || this.regularsWaiting(game, { now }) > 0) && start < now + hours * HOUR) throw new RuleError(W.notice(hours));
    }
    // Between its neighbours: after the session before it ends, and (on its own) before the one after it starts
    if (game.seriesId && timeChanged) {
      const near = (cmp, order) => this.sql
        .exec(`SELECT starts_at, ends_at FROM games WHERE series_id = ? AND id != ? AND status != 'cancelled' AND starts_at ${cmp} ? ORDER BY starts_at ${order} LIMIT 1`, game.seriesId, game.id, game.start)
        .toArray()[0];
      const prev = near('<', 'DESC');
      const next = scope === 'session' ? near('>', 'ASC') : null;
      if ((prev && start < prev.ends_at) || (next && end > next.starts_at)) {
        throw new RuleError(W.between(prev ? time.label(prev.ends_at) : null, next ? time.label(next.starts_at) : null));
      }
    }
    // 'series': how many days the game's day moves, measured from the date this session fills (usual: the game's day
    // and time until now, for the emails' "Was")
    let shift = 0;
    let usual = null;
    if (scope === 'series') {
      const slot = this.slotOf(game, series, step, time);
      if (!slot) throw new RuleError(W.ownSlot);
      shift = time.daysBetween(slot, time.key(start));
      if (Math.abs(shift) >= step) throw new RuleError(W.shift(step));
      usual = { start: time.at(slot, series.clock), end: time.at(slot, series.clock) + series.length };
    }
    const details = this.gameDetails(game);
    const index = tableIndex(rules.rooms);
    const feeOf = (roomId, ids) => (rules.rooms.find((r) => r.id === roomId) || index.get(ids[0])?.roomObj)?.price ?? rules.prices.table;
    // Shop tables: staff's to give. Its GM keeps the ones it's on, and may take the ones staff gave the game.
    const given = series && parse(series.details, {}).staffTables ? parse(series.tables, []) : null;
    const shopTables = staffGames || !tablesChanged || (Boolean(given) && sameTables(tables, given));
    // (a time of day and length that aren't changing aren't held to the whole hours again)
    const sameClock = time.minutesOf(start) === time.minutesOf(game.start) && end - start === game.end - game.start;
    const span = this.state(Math.min(start, game.start) - 24 * HOUR, Math.max(end, game.end) + 24 * HOUR);
    const moved = checkGameSession({ tables, start, end }, details, {
      state: span, rules, time, now, ignore: new Set(this.gameBookings(game.id).map((b) => b.id)), shopTables, editing: true, anyMinute: sameClock,
    });
    const place = { tables: moved.tables, start: moved.start, end: moved.end, room: moved.room };
    if (feeOf(place.room, place.tables) !== feeOf(game.room, game.tables)) throw new RuleError(W.price);

    // 'series': where each later session goes. One that can't move keeps its time and is listed (kept); slots: the
    // game's date each later session fills from now on, moved or not, so the top-up never doubles one up.
    const placeOf = new Map([[game.id, place]]);
    const sessionOf = new Map([[game.id, game]]);
    const slots = new Map();
    const kept = [];
    if (scope === 'series') {
      const clock = time.minutesOf(place.start);
      const length = place.end - place.start;
      const later = this.sql
        .exec('SELECT * FROM games WHERE series_id = ? AND id != ? AND starts_at > ? ORDER BY starts_at', game.seriesId, game.id, game.start)
        .toArray().map((r) => this.rowToGame(r));
      const live = later.filter((s) => s.status !== 'cancelled' && s.start > now);
      const state = live.length
        ? this.state(Math.min(...live.map((s) => s.start)) - (step + 1) * 24 * HOUR, Math.max(...live.map((s) => s.end)) + (step + 1) * 24 * HOUR)
        : null;
      const placed = [place];
      for (const s of later) {
        const slot = this.slotOf(s, series, step, time);
        const target = slot ? addDays(slot, shift) : null;
        if (target) slots.set(s.id, target);
        if (s.status === 'cancelled' || s.start <= now) continue;
        const keep = (reason) => kept.push({ id: s.id, start: s.start, when: time.label(s.start), reason });
        if (!staffGames && String(s.gmCustomerId || '') !== String(who.customerId)) {
          keep(W.keptOther);
          continue;
        }
        const onUsual = Boolean(slot) && time.key(s.start) === slot && time.minutesOf(s.start) === series.clock && s.end - s.start === series.length;
        if (!onUsual) {
          keep(W.keptOwn);
          continue;
        }
        const to = { tables: wantsTables ? place.tables : s.tables, start: time.at(target, clock) };
        to.end = to.start + length;
        if (placed.some((p) => p.start < to.end && to.start < p.end && p.tables.some((t) => to.tables.includes(t)))) {
          keep(W.keptClash);
          continue;
        }
        try {
          // (its day is the game's, already accepted, so only the place is checked; the time of day was checked above)
          const fits = checkGameSession({ tables: to.tables, start: to.start, end: to.end }, details, {
            state, rules, time, now, ignore: new Set(this.gameBookings(s.id).map((b) => b.id)), shopTables: staffGames || !wantsTables || shopTables, editing: true, anyMinute: true,
          });
          if (feeOf(fits.room, fits.tables) !== feeOf(s.room, s.tables)) throw new RuleError(W.price);
          const p = { tables: fits.tables, start: to.start, end: to.end, room: fits.room };
          placeOf.set(s.id, p);
          sessionOf.set(s.id, s);
          placed.push(p);
        } catch (error) {
          if (!(error instanceof RuleError)) throw error;
          keep(error.message);
        }
      }
      // (never past the session after it, wherever that one ends up)
      const after = live.map((s) => placeOf.get(s.id)?.start ?? s.start).sort((a, b) => a - b)[0];
      if (after != null && place.end > after) throw new RuleError(W.between(null, time.label(after)));
    }

    // Each move emails its players and the team: a GM gets a handful a game a day (a series is one game)
    const limitKey = `mv:${game.seriesId || game.id}`;
    if (!staffGames && this.changesToday(limitKey, now) >= CHANGE_LIMITS.moves) throw new RuleError(W.movesToday, 429);

    // --- every check has passed: the writes ---
    const changed = [];
    for (const [sessionId, p] of placeOf) {
      const session = sessionOf.get(sessionId);
      const timed = p.start !== session.start || p.end !== session.end;
      if (!timed && sameTables(p.tables, session.tables)) continue;
      this.placeSession(session, p, rules, now);
      if (timed && scope === 'session') this.sessionTimeMoved(session, p, rules, now);
      else if (timed) this.write("UPDATE bookings SET moved_at = ?, updated_at = ? WHERE game_id = ? AND kind = 'gm-seat' AND status IN ('held', 'confirmed', 'seated')", now, now, session.id);
      this.syncCoversOn(session.id, now, rules);
      changed.push({ session, place: p, timed });
    }
    if (scope === 'series') {
      // the game's day, time and length from here on (and its tables, when new ones were picked), for the dates it adds
      // later; staff's pick may be shop tables (staffTables, as Edit session's tables for later sessions)
      const kept2 = parse(series.details, {});
      this.write(
        'UPDATE series SET first_day = ?, clock = ?, length = ?, tables = ?, details = ?, updated_at = ? WHERE id = ?',
        time.key(place.start), time.minutesOf(place.start), place.end - place.start, wantsTables ? JSON.stringify(place.tables) : series.tables,
        JSON.stringify(wantsTables && staffGames ? { ...kept2, staffTables: true } : kept2), now, game.seriesId,
      );
      this.write('UPDATE games SET slot_day = NULL WHERE id = ?', game.id);
      for (const [sessionId, day] of slots) this.write('UPDATE games SET slot_day = ? WHERE id = ?', day, sessionId);
    }
    const fresh = this.game(game.id);
    if (!staffGames) this.noteChange(limitKey, game.id, 'move', `${this.when(game, rules)} to ${this.when(fresh, rules)}${scope === 'series' ? ', and every later session' : ''}`, 'gm', now);
    const told = this.tellMoved({ game, fresh, changed, kept, scope, step, usual, byGm: !staffGames, rules, now });
    return { game: view(fresh), scope, moved: changed.length, kept, told };
  },

  /**
   * Who hears about a move. One session: each seat on it, when its time changed. 'series': each person with a seat on a
   * session whose time changed, once, and each regular; all hear the game's new day and time. When its GM made the move,
   * the team gets one email. New tables at the same time email nobody. → how many people were emailed. No awaits.
   */
  tellMoved({ game, fresh, changed, kept, scope, step, usual, byGm, rules, now }) {
    const W = CHANGE_WORDS;
    const time = new LairTime(rules.tz);
    const timed = changed.filter((c) => c.timed);
    const letters = [];
    if (timed.length && emailReady(this.env)) {
      if (scope === 'session') {
        letters.push(...this.movedLetters(fresh, game, rules, now));
      } else {
        // one email a person: their seats on the sessions that moved, soonest first, then the regulars with none there
        const people = new Map();
        for (const { session } of timed) {
          const at = this.game(session.id);
          for (const seat of this.gameBookings(session.id).filter((b) => b.kind === 'gm-seat' && ACTIVE.has(b.status) && isEmail(b.email))) {
            const key = seat.email.trim().toLowerCase();
            if (!people.has(key)) people.set(key, { email: seat.email, seats: [] });
            people.get(key).seats.push({ seat, at });
          }
        }
        for (const m of this.sql.exec("SELECT name, email FROM series_members WHERE series_id = ? AND status = 'active'", game.seriesId).toArray()) {
          if (isEmail(m.email) && !people.has(m.email.trim().toLowerCase())) people.set(m.email.trim().toLowerCase(), { email: m.email, seats: [] });
        }
        const day = longDay(fresh.start, rules.tz);
        const staying = kept.length ? kept.map((k) => k.when).join('\n') : '';
        for (const person of people.values()) {
          const mine = person.seats.sort((a, b) => a.at.start - b.at.start);
          letters.push(this.letter(person.email, W.seriesSubject(fresh.title, day), {
            title: W.movedTitle,
            intro: W.seriesIntro(fresh.title, slotWords(fresh.start, step, time), day),
            details: [
              ['Game', fresh.title], ['Now', slotSpan(fresh.start, fresh.end, time)], ['Was', slotSpan(usual.start, usual.end, time)],
              mine.length ? [mine.length > 1 ? 'Your seats' : 'Your seat', mine.map((x) => this.when(x.at, rules)).join('\n')] : ['Your seat', W.savedSeat],
              ...(staying ? [['Staying put', staying]] : []),
            ],
            outro: mine.length ? this.moveCancelLine(mine[0].seat, rules, now) : W.regularOut,
            button: { label: 'See it in My Lair', url: this.page('myLair') },
          }));
        }
      }
      if (letters.length) this.later(this.mailMany(letters));
    }
    // The team hears when a GM moved it themselves (staff who move one know already)
    if (byGm && changed.length) {
      const was = this.when(game, rules);
      const is = this.when(fresh, rules);
      const lead = was === is ? W.staffTables(fresh.gm, fresh.title, tablesWord(game.tables), tablesWord(fresh.tables), is) : W.staffIntro(fresh.gm, fresh.title, was, is);
      this.notifyStaff(W.staffSubject(fresh.title), {
        title: W.staffTitle,
        intro: `${lead}${scope === 'series' ? W.staffSeries(slotWords(fresh.start, step, time)) : ''}${timed.length ? W.staffTold(letters.length) : ''}`,
        details: [
          ['Game', fresh.title], ['Was', `${was}, ${tablesWord(game.tables)}`], ['Now', `${is}, ${tablesWord(fresh.tables)}`],
          ...(kept.length ? [['Staying put', kept.map((k) => `${k.when}: ${k.reason}`).join('\n')]] : []),
        ],
      });
    }
    return letters.length;
  },
};

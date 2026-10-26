/**
 * Round 21, part 2 (26 Oct 2026, contract v21-gm-cover): a GM pays for one of their players. From Mo, 26 Oct 2026:
 * "have the option for the gm to pay for someone else if they wish from one of their players. Paying the full $10 for
 * Thier time and they don't get store credit for them playing." Then: where? "Both" (the website and the counter), and
 * until when? "Until the player has paid".
 *
 * The player's seat stays theirs (their stamp, their place on the roster), but costs them nothing: its amount is $0 and
 * covered_by says which GM pays for it (cover_was: what it cost when the GM started paying). The GM's charge is a
 * booking of its own, kind 'gm-cover' (cover_of: the seat), on the GM's account: the seat's table part (its price less
 * the GM's fee, $10 a person as the prices are) for each person on it. So everything that bills a booking bills the GM
 * for it (the counter, owed once the session's over, a monthly bill), and the GM gets no GM credit for that seat (a $0
 * seat isn't a paying player's). A charge is never a seat: it takes no table and no seat, earns no stamp, isn't a visit
 * and is never checked in.
 *
 * The seat is what's true, and the charge follows it (syncCover), whatever changed the seat or its session: the charge
 * is on while the seat is (a no-show's too) on a live session with a price, at the session's price for each person on
 * the seat, and off otherwise (money the GM paid on it is a refund due, and staff hear). Like any seat, it's locked in
 * refundHours (24) before the session: the player can't cancel it online then, the GM can't stop paying, and a no-show
 * still costs the GM. Staff can change anything. The GM's offer ends (endCover) when the player pays for their seat
 * themselves ("until the player has paid"), when the GM or staff stop it, and when the session gets another GM.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { RuleError, cancelUntil, lairTime, makeId } from './core.js';
import { seatPriceOf } from './gm-sessions.js';
import { emailReady } from './shopify.js';

/** Every message a GM, a player or staff can see, word for word in the contract */
export const GM_COVER_WORDS = {
  login: 'Log in to pay for a player.',
  notYours: "Only this session's GM or staff can do that.",
  noGame: 'Game not found.',
  cancelled: 'This session was cancelled.',
  pending: "This session isn't live yet.",
  free: "This session is free, so there's nothing to pay for.",
  noSeat: "That seat isn't on this session any more.",
  own: "That's your own seat.",
  noAccount: 'The GM needs a Dice Goblin account to pay for a player.',
  paid: (name) => `${name} has paid for their seat already, so there's nothing to pay for.`,
  nothing: (name) => `${name} has nothing to pay for their seat.`,
  already: (name) => `The GM is paying for ${name} already.`,
  notCovered: "The GM isn't paying for that seat.",
  coverPaid: "The GM has paid for that seat already, so it can't change now. Ask staff if it needs a refund.",
  /** The GM's Stop paying inside the lock */
  locked: (hours) => `It's less than ${hours} hours away, so it's locked in: you pay for this seat, the same as any seat. Ask staff if something's come up.`,
  /** The player's own cancel inside the lock */
  seatLocked: (hours) => `It's less than ${hours} hours away, so it can't be cancelled online now: your GM is paying for your seat. Have a chat with us at the counter or give us a call, and we'll sort it out.`,
  /** A new GM for a session its GM has paid a player's seat on already */
  gmPaid: (gm) => `${gm} has paid for a player's seat on this session already. Tap "Stop the GM paying" on that seat first (it flags ${gm}'s refund), then change the GM.`,
  /** The player's email when a new GM means their old GM stops paying for their seat */
  gmChanged: (title, when, gm, fee, until) => `Heads up: ${title} on ${when} has a new GM, so ${gm} isn't paying for your seat any more. It's ${fee} on your tab. Can't make it? Cancel it in My Lair by ${until}.`,
  stopFirst: 'To stop paying for them, tap "Stop paying" on the session.',
  title: (player, game) => `Paying for ${player}'s seat: ${game}`,
};

/** A covered seat's statuses that keep the GM's charge on (a no-show still costs the GM, as any seat costs its player) */
const COVER_ON = new Set(['confirmed', 'seated', 'done', 'noshow']);

/** A seat's first name, for messages: "Mia" */
const firstOf = (name) => String(name || '').trim().split(/\s+/)[0] || 'They';
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
/** Nothing left to pay (lair.js's settled) */
const settledOf = (x) => ((x.amount || 0) > 0 ? Math.max(0, (x.amount || 0) - (x.covered || 0) - (x.paidAmount || 0)) === 0 : Boolean(x.paid));

export const gmCoverMethods = {
  /**
   * Who can say a GM pays for a seat: the session's GM (logged in), or staff with GM games, Check-in or Money (the staff
   * page and the counter). No awaits.
   */
  canCover(who, game) {
    if (this.can(who, ['sessions', 'checkin', 'money'])) return true;
    return Boolean(who?.customerId && game?.gmCustomerId && String(game.gmCustomerId) === String(who.customerId));
  },

  /** The GM's part of a seat on this session, for each person: the seat price less the GM's fee; $0 when it's free. No awaits. */
  coverPer(game, rules = this.rulesCache) {
    if (!game || game.free) return 0;
    return Math.max(0, seatPriceOf(game, rules) - (game.gmFee ?? rules?.prices?.gmCredit ?? 500));
  },

  /** The GM's charge for a seat (its latest 'gm-cover' row), or null. No awaits. */
  coverOf(seatId) {
    const row = this.sql.exec("SELECT * FROM bookings WHERE kind = 'gm-cover' AND cover_of = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", String(seatId)).toArray()[0];
    return row ? this.rowToBooking(row) : null;
  },

  /** What the GM pays for a seat now: its charge's amount while it's on, else 0. No awaits. */
  coverAmountOf(seat) {
    if (!seat?.coveredBy) return 0;
    const cover = this.coverOf(seat.id);
    return cover && cover.status !== 'cancelled' ? cover.amount || 0 : 0;
  },

  /** Locked in: the GM's charge for the seat is on, and its session is refundHours (24) or less away. No awaits. */
  coverLocked(seat, rules = this.rulesCache, now = Date.now()) {
    return Boolean(seat?.coveredBy) && now >= cancelUntil(seat, rules) && this.coverAmountOf(seat) > 0;
  },

  /**
   * A seat as the GM's player list and the roster show it: covered (its GM pays for it, and coverLocked: it's locked in
   * now) and coverable (they could: a seat on, with something to pay and nothing paid on it yet, not the GM's own). No
   * awaits.
   */
  coverState(b, known = null) {
    if (!b || b.kind !== 'gm-seat') return { covered: false, coverable: false };
    if (b.coveredBy) return { covered: true, coverable: false, coverLocked: this.coverLocked(b) };
    const game = known && known.id === b.gameId ? known : b.gameId ? this.game(b.gameId) : null;
    const coverable = Boolean(game && game.gmCustomerId && !game.free && ['open', 'full'].includes(game.status))
      && ['confirmed', 'seated', 'done'].includes(b.status) && (b.amount || 0) > 0 && !b.paid && !b.waived
      && !((b.paidAmount || 0) > 0) && !((b.covered || 0) > 0) && String(b.customerId || '') !== String(game.gmCustomerId);
    return { covered: false, coverable };
  },

  /** A seat on a session for these routes: by its code or id, a player's seat on this game, or a 404. No awaits. */
  coverSeatOf(game, ref) {
    const seat = this.booking(String(ref || '').trim());
    if (!seat || seat.gameId !== game.id || seat.kind !== 'gm-seat') throw new RuleError(GM_COVER_WORDS.noSeat, 404);
    return seat;
  },

  /**
   * POST /games/:id/players/:ref/cover (the session's GM, or staff: GM games, Check-in or Money), and POST /pos/cover
   * { ref }: the GM pays for this player's seat. The seat costs the player nothing, and the GM's charge (the seat's
   * table part for each person on it) goes on the GM's account, to pay at the counter or owed once the session's over.
   * Only while the player hasn't paid anything for it (nor a pass, nor waived), on a live session that isn't free, for
   * a GM with an account. Inside the lock it's locked in at once. Returns { seat, cover } (coverView).
   */
  async coverSeat(gameId, ref, who) {
    if (!who?.customerId && !who?.staff) throw new RuleError(GM_COVER_WORDS.login, 401);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const game = this.game(gameId);
    if (!game) throw new RuleError(GM_COVER_WORDS.noGame, 404);
    if (!this.canCover(who, game)) throw new RuleError(GM_COVER_WORDS.notYours, 403);
    if (game.status === 'cancelled') throw new RuleError(GM_COVER_WORDS.cancelled, 409);
    if (game.status === 'pending') throw new RuleError(GM_COVER_WORDS.pending, 409);
    if (game.free) throw new RuleError(GM_COVER_WORDS.free, 409);
    if (!game.gmCustomerId) throw new RuleError(GM_COVER_WORDS.noAccount, 409);
    const seat = this.coverSeatOf(game, ref);
    const name = firstOf(seat.party?.[0]?.name || seat.name);
    if (!['confirmed', 'seated', 'done'].includes(seat.status)) throw new RuleError(GM_COVER_WORDS.noSeat, 404);
    if (seat.customerId && String(seat.customerId) === String(game.gmCustomerId)) throw new RuleError(GM_COVER_WORDS.own, 409);
    if (seat.coveredBy) throw new RuleError(GM_COVER_WORDS.already(name), 409);
    if (seat.paid && seat.amount > 0) throw new RuleError(GM_COVER_WORDS.paid(name), 409);
    if ((seat.paidAmount || 0) > 0 || (seat.covered || 0) > 0) throw new RuleError(GM_COVER_WORDS.paid(name), 409);
    if (seat.waived || !(seat.amount > 0)) throw new RuleError(GM_COVER_WORDS.nothing(name), 409);
    if (!(this.coverPer(game, rules) > 0)) throw new RuleError(GM_COVER_WORDS.nothing(name), 409);
    this.newCharge(seat, game, rules, now, who.customerId ? String(who.customerId) : 'staff');
    this.write(
      'UPDATE bookings SET covered_by = ?, cover_was = ?, amount = 0, paid = 0, updated_at = ? WHERE id = ?',
      String(game.gmCustomerId), seat.amount, now, seat.id,
    );
    // a bill with the seat on it stays true
    this.reconcileBills(rules, now);
    return this.coverView(game.id, seat.id, rules, who);
  },

  /**
   * POST /games/:id/players/:ref/uncover (the session's GM until it's locked in, or staff any time), and POST
   * /pos/uncover { ref }: the GM stops paying for this seat. The seat costs its players what a seat on the session costs
   * now, and the GM's charge goes. The GM can't once they've paid it; staff can, and what the GM paid is a refund due.
   * Returns { seat, cover: null }.
   */
  async uncoverSeat(gameId, ref, who) {
    if (!who?.customerId && !who?.staff) throw new RuleError(GM_COVER_WORDS.login, 401);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const game = this.game(gameId);
    if (!game) throw new RuleError(GM_COVER_WORDS.noGame, 404);
    if (!this.canCover(who, game)) throw new RuleError(GM_COVER_WORDS.notYours, 403);
    const seat = this.coverSeatOf(game, ref);
    if (!seat.coveredBy) throw new RuleError(GM_COVER_WORDS.notCovered, 409);
    if (!this.can(who, ['sessions', 'checkin', 'money'])) {
      const cover = this.coverOf(seat.id);
      if (cover && cover.status !== 'cancelled' && ((cover.paidAmount || 0) > 0 || (cover.paid && cover.amount > 0))) throw new RuleError(GM_COVER_WORDS.coverPaid, 409);
      if (this.coverLocked(seat, rules, now)) throw new RuleError(GM_COVER_WORDS.locked(rules.refundHours), 403);
    }
    this.endCover(seat, now, { why: 'stopped', rules });
    this.reconcileBills(rules, now);
    return this.coverView(game.id, seat.id, rules, who);
  },

  /**
   * What the cover routes answer: { seat (the session's roster item for it), cover: { ref, amount, people, paid, due,
   * status, locked } | null, game (as the board shows it to whoever asked) }. No awaits.
   */
  coverView(gameId, seatId, rules, who) {
    const seat = this.booking(seatId);
    const game = this.game(gameId);
    const st = this.state(game.start - 1, game.end + 1);
    const item = this.gameRoster(st, game).find((r) => r.ref === seat.ref) || null;
    const cover = seat.coveredBy ? this.coverOf(seat.id) : null;
    return {
      seat: item || { ref: seat.ref, people: seat.people, names: [seat.name], covered: Boolean(seat.coveredBy), due: 0, paid: false },
      cover: cover && cover.status !== 'cancelled'
        ? {
          ref: cover.ref, amount: cover.amount, people: cover.people, paid: Boolean(cover.paid && cover.amount > 0),
          due: Math.max(0, (cover.amount || 0) - (cover.paidAmount || 0)), status: cover.status, locked: this.coverLocked(seat, rules),
        }
        : null,
      game: this.gameView(game, st, rules, null, { staff: this.staffSees(who) }),
    };
  },

  /** A new charge for a seat: on its GM's account, the session's table part for each person on it. No awaits. */
  newCharge(seat, game, rules, now, by = 'staff') {
    const gm = String(seat.coveredBy || game.gmCustomerId);
    const member = this.memberRow(gm);
    const gmName = member?.name || member?.first_name || game.gm || 'GM';
    const id = makeId('bk');
    this.saveBooking({
      id, ref: this.newCode(gmName, 'booking', id, now), kind: 'gm-cover', status: 'confirmed', tables: [], room: null,
      start: seat.start, end: seat.end, people: seat.people, name: gmName, email: member?.email || game.gmEmail || null, phone: null,
      notes: `Paying for ${seat.name || firstOf(seat.party?.[0]?.name)}'s seat (${seat.ref})`, activity: 'rpg', extras: [], pay: 'day', paid: false,
      amount: this.coverPer(game, rules) * seat.people, gameId: game.id, customerId: gm,
    }, now);
    this.write('UPDATE bookings SET cover_of = ?, added_by = ?, updated_at = ? WHERE id = ?', seat.id, by, now, id);
    return this.booking(id);
  },

  /**
   * The GM's offer for a seat ends: their charge goes (money they'd paid on it is a refund due, and staff hear why), and
   * the seat costs its players a seat's price on the session now (amount: unless said; 0 keeps it free). why: 'stopped'
   * (the GM or staff), 'paid' (the player paid for it themselves) or 'gm' (the session has another GM). No awaits.
   */
  endCover(seat, now, { why = 'stopped', rules = this.rulesCache, amount = null } = {}) {
    const game = seat.gameId ? this.game(seat.gameId) : null;
    const cover = this.coverOf(seat.id);
    if (cover && cover.status !== 'cancelled') this.chargeOff(cover, seat, game, now, why);
    const price = amount != null ? amount : seatPriceOf(game, rules) * (seat.people || 1);
    const paid = settledOf({ ...seat, amount: price, paid: false });
    this.write('UPDATE bookings SET covered_by = NULL, cover_was = NULL, amount = ?, paid = ?, updated_at = ? WHERE id = ?', price, paid ? 1 : 0, now, seat.id);
  },

  /** A GM's charge goes. Money paid on it is a refund due (unless it's been refunded), and staff hear why. No awaits. */
  chargeOff(cover, seat, game, now, why) {
    const refund = (cover.paidAmount || 0) > 0 && cover.refund !== 'done';
    this.write("UPDATE bookings SET status = 'cancelled', hold_until = NULL, refund = ?, updated_at = ? WHERE id = ?", refund ? 'due' : cover.refund || null, now, cover.id);
    this.dropDraft(cover);
    if (refund) this.coverRefundDue(cover, seat, game, why);
  },

  /**
   * "Refund due": a GM paid for a seat they aren't paying for now. why: 'off' (the seat was taken off), 'free', 'paid'
   * (the player paid for it too), 'stopped' (staff stopped it), 'gm' (another GM), 'late' (paid after it had gone).
   * No awaits.
   */
  coverRefundDue(cover, seat, game, why, amount = cover.paidAmount || 0) {
    const gm = cover.name || 'The GM';
    const first = this.firstNameOf(gm);
    const player = seat?.name || 'a player';
    const reason = {
      off: `${player}'s seat was taken off, so ${first} doesn't pay for it`,
      free: "the session is free now, so there's nothing to pay for",
      paid: `${player} paid for their own seat too`,
      stopped: `staff stopped ${first} paying for it`,
      gm: 'the session has another GM now',
      late: `${first} wasn't paying for that seat any more`,
    }[why] || "the session isn't on now";
    this.notifyStaff(`Refund due: ${cover.ref}`, {
      title: 'Refund due',
      intro: `${gm} paid ${money(amount)} for ${player}'s seat at ${this.coverWhere(game)}, but ${reason}. Refund ${first} (or put it on their store credit), then mark it refunded.`,
      details: [["GM's charge", cover.ref], ['Seat', seat?.ref || ''], ['Refund', money(amount)]],
    });
  },

  /** "Session title, Tue 27 Oct, 6pm to 10pm" for staff emails. No awaits. */
  coverWhere(game) {
    return game ? `${game.title}, ${this.when(game, this.rulesCache)}` : 'a TTRPG session';
  },

  /**
   * Keep a GM's charge in step with the seat it pays for, after anything that changes the seat or its session
   * (cancelled, a no-show, put back, its people, its times, the session's price, free or not), and in the 10-minute run.
   *  - money paid on the seat itself (its own line on an order): the player has paid, so the GM's offer ends (endCover).
   *  - the seat costs its players nothing.
   *  - on (the seat's on, a no-show too, on a live session with a price): the charge is too, at the session's price for
   *    each person on the seat (a charge with money on it keeps the price it was paid at), over the seat's times. One
   *    that went comes back (a refund that was due isn't now: staff hear); one whose money went back to the GM is done,
   *    so a new one starts. Fewer people on a paid charge is money to give back: staff hear.
   *  - off: the charge goes (money on it is a refund due: staff hear).
   * Returns what changed ('ended', 'on', 'off', 'amount', 'seat') or null. No awaits.
   */
  syncCover(seatId, now = Date.now(), rules = this.rulesCache) {
    const seat = this.booking(seatId);
    if (!seat || seat.kind !== 'gm-seat' || !seat.coveredBy) return null;
    if ((seat.paidAmount || 0) > 0) {
      this.endCover(seat, now, { why: 'paid', rules });
      return 'ended';
    }
    const game = seat.gameId ? this.game(seat.gameId) : null;
    let changed = null;
    if ((seat.amount || 0) !== 0 || seat.paid) {
      this.write('UPDATE bookings SET amount = 0, paid = 0, updated_at = ? WHERE id = ?', now, seat.id);
      changed = 'seat';
    }
    let cover = this.coverOf(seat.id);
    const on = Boolean(game) && ['open', 'full'].includes(game.status) && !game.free && COVER_ON.has(seat.status);
    if (!on) {
      if (!cover || cover.status === 'cancelled') return changed;
      this.chargeOff(cover, seat, game, now, game?.free ? 'free' : seat.status === 'cancelled' ? 'off' : 'gone');
      return 'off';
    }
    if (!cover || (cover.status === 'cancelled' && cover.refund === 'done')) {
      cover = this.newCharge(seat, game, rules, now, 'gobgob');
      changed = 'on';
    } else if (cover.status === 'cancelled') {
      this.write("UPDATE bookings SET status = 'confirmed', refund = NULL, updated_at = ? WHERE id = ?", now, cover.id);
      if (cover.refund === 'due' && (cover.paidAmount || 0) > 0) {
        this.notifyStaff(`No refund now: ${cover.ref}`, {
          title: 'No refund now',
          intro: `${seat.name}'s seat at ${this.coverWhere(game)} is back on, so ${cover.name || 'the GM'} still pays for it: the ${money(cover.paidAmount)} they paid stays paid. There's no refund to make.`,
          details: [["GM's charge", cover.ref], ['Seat', seat.ref]],
        });
      }
      cover = this.booking(cover.id);
      changed = 'on';
    }
    const paidIn = cover.paidAmount || 0;
    const per = paidIn > 0 ? Math.round((cover.amount || 0) / Math.max(1, cover.people || 1)) : this.coverPer(game, rules);
    const amount = per * (seat.people || 1);
    if (cover.amount !== amount || cover.people !== seat.people || cover.start !== seat.start || cover.end !== seat.end) {
      const paid = amount > 0 ? paidIn >= amount : Boolean(cover.paid);
      // what the GM has paid over what it costs now, past what was over before (fewer people on it)
      const over = Math.max(0, paidIn - amount) - Math.max(0, paidIn - (cover.amount || 0));
      const note = over > 0 ? `[Overpaid ${money(over)}: the seat has fewer people now. Refund the difference.]` : '';
      this.write(
        'UPDATE bookings SET people = ?, amount = ?, paid = ?, starts_at = ?, ends_at = ?, notes = ?, updated_at = ? WHERE id = ?',
        seat.people, amount, paid ? 1 : 0, seat.start, seat.end, note ? `${cover.notes ? `${cover.notes} ` : ''}${note}` : cover.notes || null, now, cover.id,
      );
      if (over > 0) {
        this.notifyStaff(`Overpaid: ${cover.ref}`, {
          title: 'A GM paid too much for a seat',
          intro: `${seat.name}'s seat at ${this.coverWhere(game)} is for ${plural(seat.people, 'person', 'people')} now, and ${cover.name || 'the GM'} had paid ${money(paidIn)} for ${plural(cover.people, 'person', 'people')}. Refund ${this.firstNameOf(cover.name || 'them')} the difference, ${money(over)} (or put it on their store credit).`,
          details: [["GM's charge", cover.ref], ['Seat', seat.ref], ['Refund', money(over)]],
        });
      }
      changed = changed || 'amount';
    }
    return changed;
  },

  /** Every seat a GM pays for on a session, in step (syncCover). No awaits. */
  syncCoversOn(gameId, now = Date.now(), rules = this.rulesCache) {
    for (const r of this.sql.exec("SELECT id FROM bookings WHERE game_id = ? AND kind = 'gm-seat' AND covered_by IS NOT NULL", String(gameId)).toArray()) {
      this.syncCover(r.id, now, rules);
    }
  },

  /**
   * POST /games/:id/gm (changeGm) for sessions their GM pays for players on: the old GM's offers go with them. A paid one
   * stops the change (gmPaid: staff stop it first, which flags the refund): call this before anything's saved, with the
   * new GM's account (or null). No awaits.
   */
  coversBeforeGmChange(sessions, gmCustomerId) {
    for (const s of sessions) {
      if (!s.gmCustomerId || String(s.gmCustomerId) === String(gmCustomerId || '')) continue;
      const paid = this.sql
        .exec(
          `SELECT 1 AS n FROM bookings s JOIN bookings c ON c.cover_of = s.id AND c.kind = 'gm-cover' AND c.status != 'cancelled'
            WHERE s.game_id = ? AND s.kind = 'gm-seat' AND s.covered_by IS NOT NULL AND (COALESCE(c.paid_amount, 0) > 0 OR (c.paid = 1 AND c.amount > 0)) LIMIT 1`,
          s.id,
        )
        .toArray().length;
      if (paid) throw new RuleError(GM_COVER_WORDS.gmPaid(this.firstNameOf(s.gm || 'The GM')), 409);
    }
  },

  /**
   * After a session gets another GM: each seat the old GM was paying for costs its players again. One they can still
   * cancel online (more than refundHours before) gets the session's seat price, and its player is emailed; inside that
   * it stays free (they can't cancel it now, and didn't choose a price). Returns the people left free. No awaits.
   */
  coversAfterGmChange(session, oldGm, rules, now) {
    const seats = this.sql
      .exec("SELECT * FROM bookings WHERE game_id = ? AND kind = 'gm-seat' AND covered_by IS NOT NULL AND covered_by != ?", session.id, String(session.gmCustomerId || ''))
      .toArray()
      .map((r) => this.rowToBooking(r));
    const letters = [];
    let free = 0;
    for (const seat of seats) {
      const priced = cancelUntil(seat, rules) > now;
      this.endCover(seat, now, { why: 'gm', rules, ...(priced ? {} : { amount: 0 }) });
      if (!priced) free += seat.people;
      if (!priced || !['confirmed', 'seated'].includes(seat.status) || !isEmail(seat.email)) continue;
      const fee = seatPriceOf(session, rules) * seat.people;
      const until = lairTime(rules.tz).label(cancelUntil(seat, rules));
      letters.push(this.letter(seat.email, `${session.title}: your seat`, {
        title: 'Your seat has a price now',
        intro: GM_COVER_WORDS.gmChanged(session.title, this.when(session, rules), this.firstNameOf(oldGm || 'your GM'), money(fee), until),
        button: { label: 'See it in My Lair', url: this.page('myLair') },
        signoff: 'Gobgob',
      }));
    }
    if (letters.length && emailReady(this.env)) this.later(this.mailMany(letters));
    return free;
  },

  /** The 10-minute run's safety net: every seat a GM pays for in step (syncCover). Returns how many changed. No awaits. */
  coverUpkeep(now = Date.now()) {
    const rows = this.sql
      .exec("SELECT id FROM bookings WHERE kind = 'gm-seat' AND covered_by IS NOT NULL AND ends_at > ? ORDER BY starts_at LIMIT 500", now - 30 * 24 * 3_600_000)
      .toArray();
    let changed = 0;
    for (const r of rows) if (this.syncCover(r.id, now)) changed += 1;
    return changed;
  },
};

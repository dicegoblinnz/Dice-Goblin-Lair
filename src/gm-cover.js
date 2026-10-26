/**
 * Round 21, part 2 (26 Oct 2026, contract v21-gm-cover): a GM pays for one of their players. From Mo, 26 Oct 2026:
 * "have the option for the gm to pay for someone else if they wish from one of their players. Paying the full $10 for
 * Thier time and they don't get store credit for them playing." Then: where? "Both" (the website and the counter), and
 * until when? "Until the player has paid".
 *
 * The player's seat stays theirs (their stamp, their place on the roster), but costs them nothing: its amount is $0 and
 * covered_by says which GM pays for it (cover_was keeps what it cost, for when the GM stops). The GM's charge is a
 * booking of its own, kind 'gm-cover' (cover_of: the seat), on the GM's account: the seat's table part (its price less
 * the GM's fee, $10 a person as the prices are) for each person on it. So everything that bills a booking bills the GM
 * for it (the counter, owed once the session's over, a monthly bill), and the GM gets no GM credit for that seat (a $0
 * seat isn't a paying player's). A cover row is never a seat: it takes no table and no seat, earns no stamp, isn't a
 * visit and is never checked in.
 *
 * The cover lives and dies with the seat (syncCover): if the player cancels, is taken off or doesn't turn up, the GM pays
 * nothing (a cover they'd paid is a refund due); a seat put back brings it back.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { ACTIVE, RuleError, makeId } from './core.js';

/** Every message a GM or staff can see, word for word in the contract */
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
  started: 'The session has started, so ask staff to change it.',
  stopFirst: 'To stop paying for them, tap "Stop paying" on the session.',
  title: (player, game) => `Paying for ${player}'s seat: ${game}`,
};

/** A seat's first name, for messages: "Mia" */
const firstOf = (name) => String(name || '').trim().split(/\s+/)[0] || 'They';

export const gmCoverMethods = {
  /**
   * Who can say a GM pays for a seat: the session's GM (logged in), or staff with GM games, Check-in or Money (the staff
   * page and the counter). No awaits.
   */
  canCover(who, game) {
    if (this.can(who, ['sessions', 'checkin', 'money'])) return true;
    return Boolean(who?.customerId && game?.gmCustomerId && String(game.gmCustomerId) === String(who.customerId));
  },

  /**
   * A seat as the GM's player list and the roster show it: covered (its GM pays for it) and coverable (they could: a
   * seat on, with something to pay and nothing paid on it yet, not the GM's own). No awaits.
   */
  coverState(b, known = null) {
    if (!b || b.kind !== 'gm-seat') return { covered: false, coverable: false };
    if (b.coveredBy) return { covered: true, coverable: false };
    const game = known && known.id === b.gameId ? known : b.gameId ? this.game(b.gameId) : null;
    const coverable = Boolean(game && game.gmCustomerId && !game.free && ['open', 'full'].includes(game.status))
      && ['confirmed', 'seated', 'done'].includes(b.status) && (b.amount || 0) > 0 && !b.paid && !b.waived
      && !((b.paidAmount || 0) > 0) && !((b.covered || 0) > 0) && String(b.customerId || '') !== String(game.gmCustomerId);
    return { covered: false, coverable };
  },

  /** The GM's charge for a seat (its 'gm-cover' row), or null. No awaits. */
  coverOf(seatId) {
    const row = this.sql.exec("SELECT * FROM bookings WHERE kind = 'gm-cover' AND cover_of = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", String(seatId)).toArray()[0];
    return row ? this.rowToBooking(row) : null;
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
   * a GM with an account. Returns { seat, cover } (coverView).
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
    // the GM's part: the seat's table part (its price less this game's GM fee) for each person on it
    const per = this.coverablePerPerson(seat, rules);
    if (!(per > 0)) throw new RuleError(GM_COVER_WORDS.nothing(name), 409);
    const gm = String(game.gmCustomerId);
    const member = this.memberRow(gm);
    const gmName = member?.name || member?.first_name || game.gm || 'GM';
    const id = makeId('bk');
    const cover = {
      id, ref: this.newCode(gmName, 'booking', id, now), kind: 'gm-cover', status: 'confirmed', tables: [], room: null,
      start: seat.start, end: seat.end, people: seat.people, name: gmName, email: member?.email || game.gmEmail || null, phone: null,
      notes: `Paying for ${seat.name || name}'s seat (${seat.ref})`, activity: 'rpg', extras: [], pay: 'day', paid: false,
      amount: per * seat.people, gameId: game.id, customerId: gm,
    };
    this.saveBooking(cover, now);
    this.write('UPDATE bookings SET cover_of = ?, added_by = ?, updated_at = ? WHERE id = ?', seat.id, who.customerId ? String(who.customerId) : 'staff', now, id);
    this.write(
      'UPDATE bookings SET covered_by = ?, cover_was = ?, amount = 0, paid = 0, updated_at = ? WHERE id = ?',
      gm, seat.amount, now, seat.id,
    );
    // a bill with the seat on it stays true
    this.reconcileBills(rules, now);
    return this.coverView(game.id, seat.id, rules, who);
  },

  /**
   * POST /games/:id/players/:ref/uncover (the session's GM until it starts, or staff any time), and POST /pos/uncover
   * { ref }: the GM stops paying for this seat. The seat costs what it did before, and the GM's charge goes. Only while
   * the GM hasn't paid it. Returns { seat, cover: null }.
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
    const staff = this.can(who, ['sessions', 'checkin', 'money']);
    if (!staff && game.start <= now) throw new RuleError(GM_COVER_WORDS.started, 403);
    const cover = this.coverOf(seat.id);
    // (a charge that went with its seat and was paid, then refunded, is past changing: the seat just costs what it did)
    if (cover && cover.status !== 'cancelled' && ((cover.paidAmount || 0) > 0 || (cover.paid && cover.amount > 0))) throw new RuleError(GM_COVER_WORDS.coverPaid, 409);
    if (cover && cover.status !== 'cancelled') {
      this.write("UPDATE bookings SET status = 'cancelled', hold_until = NULL, updated_at = ? WHERE id = ?", now, cover.id);
      this.dropDraft?.(cover);
    }
    // what it cost before (a free session since then costs nothing)
    const amount = game.free ? 0 : Math.max(0, Number(seat.coverWas) || 0);
    this.write('UPDATE bookings SET covered_by = NULL, cover_was = NULL, amount = ?, paid = 0, updated_at = ? WHERE id = ?', amount, now, seat.id);
    this.reconcileBills(rules, now);
    return this.coverView(game.id, seat.id, rules, who);
  },

  /**
   * What the cover routes answer: { seat (the session's roster item for it), cover: { ref, amount, people, paid, due,
   * status } | null, game (as the board shows it to whoever asked) }. No awaits.
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
        ? { ref: cover.ref, amount: cover.amount, people: cover.people, paid: Boolean(cover.paid && cover.amount > 0), due: Math.max(0, (cover.amount || 0) - (cover.paidAmount || 0)), status: cover.status }
        : null,
      game: this.gameView(game, st, rules, null, { staff: this.staffSees(who) }),
    };
  },

  /**
   * Keep a GM's charge in step with the seat it pays for, after anything that changes the seat (cancelled, taken off,
   * a no-show, put back, more or fewer people). No awaits.
   *  - the seat ended (cancelled or a no-show): the charge goes. One the GM had paid is a refund due (staff hear).
   *  - the seat is on again: a charge that went with it comes back (unless the GM had paid and been refunded).
   *  - the seat's people changed: the charge follows, while it's unpaid.
   */
  syncCover(seatId, now = Date.now()) {
    const seat = this.booking(seatId);
    if (!seat || seat.kind !== 'gm-seat' || !seat.coveredBy) return null;
    const cover = this.coverOf(seat.id);
    if (!cover) return null;
    const ended = ['cancelled', 'noshow'].includes(seat.status);
    const paid = (cover.paidAmount || 0) > 0;
    if (ended && cover.status !== 'cancelled') {
      this.write("UPDATE bookings SET status = 'cancelled', hold_until = NULL, refund = ?, updated_at = ? WHERE id = ?", paid && cover.refund !== 'done' ? 'due' : cover.refund, now, cover.id);
      if (paid && cover.refund !== 'done') {
        this.notifyStaff(`Refund due: ${cover.ref}`, {
          title: 'Refund due',
          intro: `${cover.name} paid ${money(cover.paidAmount)} for ${seat.name}'s seat, and ${seat.name} ${seat.status === 'noshow' ? "didn't come" : "isn't coming now"}. A GM only pays for players who play, so it goes back to ${cover.name}. Refund it (or put it on their store credit), then mark it refunded.`,
          details: [['GM\'s charge', cover.ref], ['Seat', seat.ref], ['Refund', money(cover.paidAmount)]],
        });
      }
      return 'ended';
    }
    if (!ended && cover.status === 'cancelled' && cover.refund !== 'done' && !paid) {
      this.write("UPDATE bookings SET status = 'confirmed', refund = NULL, updated_at = ? WHERE id = ?", now, cover.id);
      return 'back';
    }
    if (!ended && cover.status !== 'cancelled' && !paid && cover.people !== seat.people) {
      const per = Math.round((cover.amount || 0) / Math.max(1, cover.people || 1));
      this.write('UPDATE bookings SET people = ?, amount = ?, updated_at = ? WHERE id = ?', seat.people, per * seat.people, now, cover.id);
      this.write('UPDATE bookings SET cover_was = ? WHERE id = ?', Math.round((Number(seat.coverWas) || 0) / Math.max(1, cover.people || 1)) * seat.people, seat.id);
      return 'people';
    }
    return null;
  },

  /**
   * The 10-minute run's safety net: every covered seat's charge in step (syncCover), in case anything changed a seat
   * without saying so. Returns how many changed. No awaits.
   */
  coverUpkeep(now = Date.now()) {
    const rows = this.sql
      .exec(
        `SELECT s.id AS id FROM bookings s
           JOIN bookings c ON c.id = (SELECT x.id FROM bookings x WHERE x.kind = 'gm-cover' AND x.cover_of = s.id ORDER BY x.created_at DESC, x.rowid DESC LIMIT 1)
          WHERE s.kind = 'gm-seat' AND s.covered_by IS NOT NULL AND s.ends_at > ?
            AND ((s.status IN ('cancelled', 'noshow') AND c.status != 'cancelled')
              OR (s.status NOT IN ('cancelled', 'noshow') AND c.status = 'cancelled' AND COALESCE(c.paid_amount, 0) = 0 AND COALESCE(c.refund, '') != 'done')
              OR (c.status != 'cancelled' AND c.people != s.people AND COALESCE(c.paid_amount, 0) = 0))
          LIMIT 200`,
        now - 30 * 24 * 3_600_000,
      )
      .toArray();
    let changed = 0;
    for (const r of rows) if (this.syncCover(r.id, now)) changed += 1;
    return changed;
  },
};

const money = (cents) => `$${(cents / 100).toFixed(2)}`;

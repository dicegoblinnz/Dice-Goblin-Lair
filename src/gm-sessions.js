/**
 * Round 18: more for GM sessions (contract v18-gm-sessions). Mo (16 Oct 2026): "I want the staff to be able to see each
 * player inside a gm session run game and have the ability to reserve seats to newer players. And have the ability to
 * kick players out of they need." He picked: staff GMs running their own game, and seats held for new players. Then:
 * "Also have staff have the ability to make certain games free for special events or just regular events, that are
 * specific gm run games." And: "Have the ability for staff to change the gm for a game even after it was set."
 *
 *  - Staff GMs run their own game: a session's GM who's on the team (the main account or a helper) can see its seats,
 *    reserve seats (POST /games/:id/players) and remove players (POST /games/:id/players/:ref/remove) from their own game,
 *    as staff with GM games can for any game.
 *  - Seats for new players (games.new_seats): some of a session's seats are kept for players new to the Lair's TTRPG
 *    sessions (no seat before at a session that had started). Online, anyone else can't take them; a new player can
 *    take any seat, and their seats fill the kept ones first (bookings.new_player). Staff, and the session's staff GM,
 *    set or release them, and can seat anyone in them.
 *  - Free sessions (games.free): staff make a session, or a series from a session on, free: its seats cost nothing, so
 *    nothing's on anyone's tab and there's no GM credit. The seat price it had comes back when it isn't free any more.
 *  - Changing the GM: staff give a session, or a series from a session on, to another GM (a customer, or an email
 *    that's invited), and the GMs are told.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { ACTIVE, RuleError, lairTime } from './core.js';
import { emailReady } from './shopify.js';

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());

/** Every message staff, GMs and players can see, word for word in the contract */
export const GM_SESSION_WORDS = {
  notYours: 'Only staff, or the GM of this game when they’re on the team, can do that.',
  login: 'Log in to do that.',
  scope: "scope is 'session' or 'series'.",
  // seats for new players
  newSeats: (seats) => `Seats for new players is a whole number from 0 to ${seats}.`,
  keptAll: 'The seats left are kept for players new to our TTRPG sessions. Bringing someone new? Have a chat with us.',
  keptSome: (open, kept) => `Only ${open} ${open === 1 ? 'seat is' : 'seats are'} left for you: ${kept} ${kept === 1 ? 'is' : 'are'} kept for players new to our TTRPG sessions.`,
  // free
  free: 'free is true or false.',
  paidAlready: (n) => `${n} ${n === 1 ? 'seat is' : 'seats are'} paid for already. Refund ${n === 1 ? 'it' : 'them'} first, then make it free.`,
  freeCredit: "This session was free, so there's no GM credit to add.",
  // removing a player
  noSeat: "That player isn't in this game.",
  // changing the GM
  gmWho: 'Pick the new GM from the customers, or add their email.',
  gmName: 'Add the name players see for the new GM.',
  gmSame: "That's the GM already.",
  gmCredited: "This session's GM credit is done, so its GM stays.",
  gmEmail: "That email address doesn't look right.",
};

const trim = (value, max) => String(value ?? '').trim().slice(0, max);
/** $15.00, as the Lair's emails write money */
const money = (cents) => `$${(cents / 100).toFixed(2)}`;

/** The seat price a session charges now: nothing when it's free, else its own price (or the usual GM seat) */
export const seatPriceOf = (game, rules) => (game?.free ? 0 : game?.seatPrice || rules?.prices?.gmSeat || 1500);

/**
 * A session's seats kept for new players that are still open, given the state's bookings: its newSeats (never more
 * than its seats) less the seats new players have, and never more than the seats still free. → { kept, newTaken }
 */
export function newSeatHold(game, state, taken = null) {
  const wanted = Math.max(0, Math.min(Number(game?.newSeats) || 0, Number(game?.seats) || 0));
  if (!wanted) return { kept: 0, newTaken: 0 };
  const seats = (state?.bookings || []).filter((b) => b.gameId === game.id && b.kind === 'gm-seat' && ACTIVE.has(b.status));
  const newTaken = seats.filter((b) => b.newPlayer).reduce((sum, b) => sum + (b.people || 0), 0);
  const all = taken ?? seats.reduce((sum, b) => sum + (b.people || 0), 0) + (Number(game.offlinePlayers) || 0);
  return { kept: Math.max(0, Math.min(wanted - newTaken, game.seats - all)), newTaken };
}

export const gmSessionMethods = {
  /** Staff with GM games, or this session's own GM when they're on the team (the main account or a helper). No awaits. */
  canRunGame(who, game) {
    if (this.can(who, 'sessions')) return true;
    return Boolean(who?.staff && who.customerId && game?.gmCustomerId && String(game.gmCustomerId) === String(who.customerId));
  },

  requireGameStaff(who, game) {
    if (!who?.customerId && !who?.staff) throw new RuleError(GM_SESSION_WORDS.login, 401);
    if (!this.canRunGame(who, game)) throw new RuleError(GM_SESSION_WORDS.notYours, 403);
  },

  /**
   * Whether someone is new to the Lair's TTRPG sessions: no seat (theirs by account, or for someone without one by
   * email) at a session that started before `before` (now, unless said), that wasn't cancelled or a no-show. Someone
   * with neither an account nor an email isn't known, so isn't new. No awaits.
   */
  isNewPlayer(customerId, email, before = Date.now()) {
    const id = customerId ? String(customerId) : '';
    const mail = isEmail(email) ? String(email).trim().toLowerCase() : '';
    if (!id && !mail) return false;
    // one look each way, so each uses its index (bookings_customer, bookings_email_lower)
    const seen = (column, value) => this.sql
      .exec(`SELECT 1 AS seen FROM bookings WHERE ${column} = ? AND kind = 'gm-seat' AND status IN ('confirmed', 'seated', 'done') AND starts_at < ? LIMIT 1`, value, before)
      .toArray().length > 0;
    return !(id && seen('customer_id', id)) && !(mail && seen('lower(email)', mail));
  },

  /**
   * A session's seats kept for new players still open, read from the database (newSeatHold's count for a session the
   * state doesn't hold): its newSeats, less the seats new players have, never more than the seats still free. No awaits.
   */
  newSeatsKept(game) {
    const wanted = Math.max(0, Math.min(Number(game?.newSeats) || 0, Number(game?.seats) || 0));
    if (!wanted) return 0;
    const newTaken = this.sql
      .exec("SELECT COALESCE(SUM(people), 0) AS n FROM bookings WHERE game_id = ? AND kind = 'gm-seat' AND status IN ('held', 'confirmed', 'seated') AND new_player = 1", game.id)
      .one().n;
    return Math.max(0, Math.min(wanted - (Number(newTaken) || 0), game.seats - this.takenSeats(game.id)));
  },

  /**
   * Seats held at a session for its series' waiting regulars, as the board holds them: the regulars' seats come from
   * the free seats that aren't kept for new players (regularsWaiting, kept to those). except: whose own hold doesn't
   * count (they're the one booking). No awaits.
   */
  regularsHeld(game, { except = null, now = Date.now() } = {}) {
    const waiting = this.regularsWaiting(game, { except, now });
    if (!waiting) return 0;
    const free = Math.max(0, game.seats - this.takenSeats(game.id));
    return Math.min(waiting, Math.max(0, free - this.newSeatsKept(game)));
  },

  /** A new seat booking's new_player mark (counted towards the seats kept for new players). No awaits. */
  markNewPlayer(bookingId, newPlayer) {
    if (newPlayer) this.write('UPDATE bookings SET new_player = 1 WHERE id = ?', bookingId);
  },

  /**
   * The online seat check for the seats kept for new players: someone who isn't new can't take them. people: the
   * seats wanted; open: the seats free for this booking (after the regulars' kept seats). → whether the booker is new.
   * No awaits.
   */
  checkNewSeats(game, _state, { people, open, customerId, email, now }) {
    const newPlayer = this.isNewPlayer(customerId, email, now);
    const kept = this.newSeatsKept(game);
    if (!kept || newPlayer) return newPlayer;
    const forThem = Math.max(0, open - kept);
    if (people > forThem) throw new RuleError(forThem > 0 ? GM_SESSION_WORDS.keptSome(forThem, Math.min(kept, open)) : GM_SESSION_WORDS.keptAll, 409);
    return false;
  },

  /**
   * A game's seats for whoever can run it (the floor's roster): one item per seat booking still on, first booked first:
   * { ref, people, names, characters, paid, due (cents), newPlayer, regular, member, here }. No emails. No awaits.
   */
  gameRoster(st, game) {
    return st.bookings
      .filter((b) => b.gameId === game.id && b.kind === 'gm-seat' && ACTIVE.has(b.status))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .map((b) => {
        const party = b.party?.length ? b.party : [{ name: b.name, character: '' }];
        // as the tab works it out (dueOf, settled): a $0 seat (a free session's) is neither paid nor owed
        const owing = Math.max(0, (b.amount || 0) - (b.paidAmount || 0) - (b.covered || 0));
        const due = b.paid || b.waived ? 0 : owing;
        return {
          ref: b.ref, people: b.people, names: party.map((p) => p.name), characters: party.map((p) => p.character || ''),
          paid: Boolean(b.paid) || ((b.amount || 0) > 0 && owing === 0),
          due, newPlayer: Boolean(b.newPlayer), regular: Boolean(b.seriesId && b.customerId), member: Boolean(b.customerId), here: b.status === 'seated' || Boolean(b.arrivedAt),
        };
      });
  },

  /** A session, and for scope 'series' every later session of its series that isn't cancelled. No awaits. */
  sessionsFor(game, scope) {
    if (!['session', 'series', undefined, null, ''].includes(scope)) throw new RuleError(GM_SESSION_WORDS.scope);
    if (scope !== 'series' || !game.seriesId) return [game];
    return this.sql
      .exec("SELECT * FROM games WHERE series_id = ? AND status != 'cancelled' AND (id = ? OR starts_at > ?) ORDER BY starts_at", game.seriesId, game.id, game.start)
      .toArray()
      .map((r) => this.rowToGame(r));
  },

  /** A series' kept details, with changes. No awaits. */
  patchSeries(seriesId, patch, now) {
    const row = seriesId ? this.sql.exec('SELECT details FROM series WHERE id = ?', seriesId).toArray()[0] : null;
    if (!row) return;
    let details = {};
    try {
      details = JSON.parse(row.details || '{}') || {};
    } catch {
      details = {};
    }
    this.write('UPDATE series SET details = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...details, ...patch }), now, seriesId);
  },

  /**
   * POST /games/:id/new-seats { seats, scope? } (staff with GM games, or the session's staff GM): how many of the
   * session's seats are kept for new players (0 releases them), for this session or ('series') it and every later one.
   * → { game, sessions }
   */
  async setNewSeats(id, input, who) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    this.requireGameStaff(who, game);
    if (game.status === 'cancelled') throw new RuleError('That game was cancelled.', 409);
    // a number (or a number as text, from a form): null, '' and true aren't 0 or 1
    const raw = input?.seats;
    const seats = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
    if (!Number.isInteger(seats) || seats < 0 || seats > game.seats) throw new RuleError(GM_SESSION_WORDS.newSeats(game.seats));
    const sessions = this.sessionsFor(game, input?.scope);
    for (const s of sessions) this.write('UPDATE games SET new_seats = ?, updated_at = ? WHERE id = ?', Math.min(seats, s.seats), now, s.id);
    if (input?.scope === 'series') this.patchSeries(game.seriesId, { newSeats: seats }, now);
    const fresh = this.game(game.id);
    return { game: this.gameView(fresh, this.state(fresh.start - 1, fresh.end + 1), rules), sessions: sessions.length };
  },

  /**
   * POST /games/:id/free { free, scope? } (staff with GM games): a session, or ('series') it and every later one, free
   * or not. Free: its seats cost nothing, unpaid seats on it come to $0, and there's no GM credit. Not free any more:
   * the seat price it had comes back on its unpaid seats. A seat paid for already stops it being made free (409).
   * → { game, sessions }
   */
  async setGameFree(id, input, who) {
    this.requireStaff(who, 'sessions');
    if (typeof input?.free !== 'boolean') throw new RuleError(GM_SESSION_WORDS.free);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    if (game.status === 'cancelled') throw new RuleError('That game was cancelled.', 409);
    const sessions = this.sessionsFor(game, input.scope);
    if (input.free) {
      const ids = sessions.map((s) => s.id);
      const paid = ids.length
        ? this.sql
          .exec(
            `SELECT COALESCE(SUM(people), 0) AS n FROM bookings WHERE kind = 'gm-seat' AND status IN ('held', 'confirmed', 'seated', 'done')
             AND (paid_amount > 0 OR (paid = 1 AND amount > 0)) AND game_id IN (${ids.map(() => '?').join(', ')})`,
            ...ids,
          )
          .one().n
        : 0;
      if (paid > 0) throw new RuleError(GM_SESSION_WORDS.paidAlready(paid), 409);
    }
    for (const s of sessions) {
      this.write('UPDATE games SET free = ?, updated_at = ? WHERE id = ?', input.free ? 1 : 0, now, s.id);
      // Free: nothing to pay on its seats not paid for yet (a $0 seat is never owed, a no-show's included). Not free any
      // more: the price comes back on the seats of a session still to start; anyone who's already played it free stays free.
      if (input.free) {
        this.write(
          "UPDATE bookings SET amount = 0, updated_at = ? WHERE game_id = ? AND kind = 'gm-seat' AND COALESCE(paid_amount, 0) = 0 AND status IN ('held', 'confirmed', 'seated', 'done', 'noshow')",
          now, s.id,
        );
      } else if (s.start > now) {
        this.write(
          "UPDATE bookings SET amount = ? * people, updated_at = ? WHERE game_id = ? AND kind = 'gm-seat' AND COALESCE(paid_amount, 0) = 0 AND status IN ('held', 'confirmed')",
          s.seatPrice || rules.prices.gmSeat, now, s.id,
        );
      }
    }
    if (input.scope === 'series') this.patchSeries(game.seriesId, { free: input.free }, now);
    const fresh = this.game(game.id);
    return { game: this.gameView(fresh, this.state(fresh.start - 1, fresh.end + 1), rules), sessions: sessions.length };
  },

  /**
   * POST /games/:id/players/:ref/remove (staff with GM games, or the session's staff GM): take a seat off the game, as
   * the staff page's Remove does (cancelled by staff: no email to the player; the GM isn't emailed either). ref: the
   * seat booking's reference or id. What they'd paid for it already (at the counter ahead of time) isn't theirs to
   * lose: before the session starts it's a refund due, and once it's started staff decide ('ask', with a note); either
   * way the staff are emailed. → { booking: { id, ref, status, people, name }, refund, game } (no email or phone).
   */
  async removePlayer(id, ref, who) {
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    this.requireGameStaff(who, game);
    const seat = this.booking(ref);
    if (!seat || seat.gameId !== game.id || seat.kind !== 'gm-seat' || !ACTIVE.has(seat.status)) throw new RuleError(GM_SESSION_WORDS.noSeat, 404);
    // the staff path of POST /bookings/:id/update, for someone this game lets do it
    const desk = who.role === 'owner' || this.can(who, ['checkin', 'tables'])
      ? who
      : { ...who, staff: true, role: 'helper', perms: [...new Set([...(who.perms || []), 'checkin', 'tables'])] };
    const done = await this.updateBooking(seat.id, { status: 'cancelled' }, desk);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    let refund = done.refund || { due: false, amount: 0 };
    const paid = Math.max(0, Number(seat.paidAmount) || 0);
    const after = this.booking(seat.id);
    if (paid > 0 && !refund.due && after.refund !== 'done') {
      const started = after.start <= now;
      const note = started && !(after.notes || '').includes('[Refund?]')
        ? `${after.notes ? `${after.notes} ` : ''}[Refund?] Paid, then taken off the game once it had started: refund it or keep the fee.`
        : after.notes || null;
      this.write('UPDATE bookings SET refund = ?, notes = ?, updated_at = ? WHERE id = ?', started ? 'ask' : 'due', note, now, seat.id);
      refund = started
        ? { due: false, ask: true, amount: paid, orderId: seat.orderId || null, reason: 'taken off the game once it had started, so staff decide' }
        : { due: true, amount: paid, orderId: seat.orderId || null, reason: 'taken off the game, paid ahead' };
      this.notifyStaff(`${started ? 'Refund?' : 'Refund due:'} ${seat.ref}`, {
        title: started ? 'A refund to decide' : 'Refund due',
        intro: started
          ? `${seat.name} was taken off ${game.title} once it had started, and they'd paid ${money(paid)} for their seat. It's your call whether to refund it. Have a chat with them, then mark it refunded if you do.`
          : `${seat.name} was taken off ${game.title}, and they'd paid ${money(paid)} for their seat already. Refund it (or put it on their store credit), then mark it refunded.`,
        details: [['Booking', seat.ref], ['Was for', this.when(game, rules)], ['Paid', money(paid)], ['Order', seat.orderId || 'See Orders in Shopify']],
      });
    }
    const fresh = this.booking(seat.id);
    return {
      booking: { id: fresh.id, ref: fresh.ref, status: fresh.status, people: fresh.people, name: fresh.name },
      refund,
      game: this.gameView(game, this.state(game.start - 1, game.end + 1), rules),
    };
  },

  /**
   * POST /games/:id/gm { gmCustomerId?, gmCustomerName?, gmEmail?, gm, scope? } (staff with GM games): give a session,
   * or ('series') it and every later one, to another GM: a customer picked from the search (gmCustomerId, with
   * gmCustomerName and gmEmail for one the Lair hasn't met), or an email (a member's links them; any other is invited to
   * make an account, which the game joins). gm: the name players see. A session already credited keeps its GM (409
   * for this one; skipped in a series). The new GM is told (or invited) and the old one too.
   * → { game, sessions, invited?, notice? }
   */
  async changeGm(id, input, who) {
    this.requireStaff(who, 'sessions');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    if (game.status === 'cancelled') throw new RuleError('That game was cancelled.', 409);
    if (game.credited != null) throw new RuleError(GM_SESSION_WORDS.gmCredited, 409);
    let gmCustomerId = null;
    let gmEmail = null;
    let picked = null;
    const sentEmail = trim(input?.gmEmail, 120);
    if (sentEmail && !isEmail(sentEmail)) throw new RuleError(GM_SESSION_WORDS.gmEmail);
    if (trim(input?.gmCustomerId, 40)) {
      picked = this.pickedCustomer({ customerId: input.gmCustomerId, name: input.gmCustomerName, email: sentEmail || null });
      gmCustomerId = String(picked.customerId);
      gmEmail = sentEmail || picked.email || this.memberRow(gmCustomerId)?.email || null;
    } else if (sentEmail) {
      gmEmail = sentEmail;
      gmCustomerId = this.memberByEmail(sentEmail)?.customer_id || null;
    } else {
      throw new RuleError(GM_SESSION_WORDS.gmWho);
    }
    const member = gmCustomerId ? this.memberRow(gmCustomerId) : null;
    const gm = trim(input?.gm, 60) || trim(picked?.name, 60) || trim(member?.name || member?.first_name, 60);
    if (!gm) throw new RuleError(GM_SESSION_WORDS.gmName);
    const sameAccount = gmCustomerId ? String(game.gmCustomerId || '') === gmCustomerId : !game.gmCustomerId && String(game.gmEmail || '').toLowerCase() === String(gmEmail).toLowerCase();
    if (sameAccount && gm === game.gm) throw new RuleError(GM_SESSION_WORDS.gmSame);
    if (picked) this.makeMember(picked, now);
    const sessions = this.sessionsFor(game, input?.scope).filter((s) => s.credited == null);
    for (const s of sessions) {
      this.saveGame({ ...s, gm, gmCustomerId, gmEmail }, now);
      this.write("UPDATE bookings SET customer_id = ?, name = ?, updated_at = ? WHERE game_id = ? AND kind = 'gm'", gmCustomerId, `GM ${gm}`, now, s.id);
    }
    if (input?.scope === 'series' && game.seriesId) {
      this.write('UPDATE series SET gm_customer_id = ?, updated_at = ? WHERE id = ?', gmCustomerId, now, game.seriesId);
      this.patchSeries(game.seriesId, { gm, gmEmail }, now);
    }
    if (gmCustomerId) {
      this.write('INSERT INTO gm_profiles (customer_id, name, bio, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(customer_id) DO NOTHING', gmCustomerId, gm, '', now);
    }
    const fresh = this.game(game.id);
    // the GMs are told: the new one (or invited, with no account), and the old one when they had an email
    let notice = null;
    const invited = !gmCustomerId;
    if (invited) {
      const sent = this.inviteGm(fresh, rules);
      notice = sent
        ? `Gobgob emailed ${gmEmail} to make an account. The game joins their account when they log in with that email.`
        : `Emails aren't set up, so Gobgob couldn't email ${gmEmail}. The game joins their account when they log in with that email.`;
    } else {
      this.tellGmLive(fresh, rules, { listedForThem: true });
    }
    if (game.gmEmail && isEmail(game.gmEmail) && String(game.gmEmail).toLowerCase() !== String(gmEmail || '').toLowerCase()) this.tellGmReplaced(game, sessions.length, rules);
    return {
      game: this.gameView(fresh, this.state(fresh.start - 1, fresh.end + 1), rules), sessions: sessions.length,
      ...(invited ? { invited: true } : {}), ...(notice ? { notice } : {}),
    };
  },

  /** "You're not running <title> any more", to the GM a session (or series) was taken from. No awaits. */
  tellGmReplaced(game, count, rules) {
    if (!emailReady(this.env) || !isEmail(game.gmEmail)) return;
    const time = lairTime(rules.tz);
    this.later(this.mail(this.letter(game.gmEmail, `${game.title}: a new GM`, {
      title: 'Your game has a new GM',
      intro: `Kia ora ${game.gm}, the Dice Goblin team has given ${game.title} to another GM${count > 1 ? `, from ${time.label(game.start)} on` : ` for ${time.label(game.start)}`}. Thanks for everything you've put into it!`,
      outro: ["Something not right? Have a chat with us and we'll sort it out."],
      button: { label: 'Open My Lair', url: this.page('myLair') },
      signoff: 'Gobgob',
    })));
  },
};

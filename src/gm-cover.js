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
 * themselves ("until the player has paid"), when the GM or staff stop it, and when the session gets another GM while it
 * could still be stopped.
 *
 * Money back to a GM is worked out, never guessed: what's due back on a charge is what they've paid on it, net of what's
 * been given back (staff marking it refunded records a payment of minus that much, order_id 'refund'), over what it costs now
 * (chargeBack). The refund flag follows that (settleChargeRefund), and staff hear when it starts, changes or stops.
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
  /** Staff marking a charge refunded with nothing due back on it */
  nothingBack: "There's nothing to give back on that one: what the GM has paid isn't more than it costs.",
  /** Staff marking a charge paid once it's gone (a page left open, say) */
  chargeGone: "That charge isn't on any more (the GM stopped paying, or the seat went), so there's nothing to pay for it.",
  /** Staff moving a charge as a booking: it goes where its seat goes */
  chargeFollows: "A GM's charge goes where the player's seat goes, so move the session or the seat instead.",
  /** Staff marking a seat its GM pays for paid by hand */
  coveredSeat: "The GM pays for this seat, so there's nothing for the player to pay. If they're paying for it themselves, stop the GM paying first.",
  /** The player's email when a new GM means their old GM stops paying for their seat */
  gmChanged: (title, when, gm, fee, until) => `Heads up: ${title} on ${when} has a new GM, so ${gm} isn't paying for your seat any more. It's ${fee} on your tab. Can't make it? Cancel it in My Lair by ${until}.`,
  stopFirst: 'To stop paying for them, tap "Stop paying" on the session.',
  title: (player, game) => `Paying for ${player}'s seat: ${game}`,
};

/** Why money's due back to a GM, the one to tell staff first when an order brings more than one */
const WHY_FIRST = ['paid', 'off', 'stopped', 'gm', 'free', 'gone', 'fewer', 'back', 'late', 'more'];

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
    const game = known && known.id === b.gameId ? known : b.gameId ? this.game(b.gameId) : null;
    if (b.coveredBy) {
      // (while the session is free there's nothing to pay: the offer waits, for if it has a price again)
      if (game?.free) return { covered: false, coverable: false };
      // coverBy: who pays, when it isn't the session's GM (an offer locked in before it got a new GM)
      const theirs = String(game?.gmCustomerId || '') === String(b.coveredBy);
      return { covered: true, coverable: false, coverLocked: this.coverLocked(b), ...(theirs ? {} : { coverBy: this.coverPayer(b) }) };
    }
    const coverable = Boolean(game && game.gmCustomerId && !game.free && ['open', 'full'].includes(game.status))
      && ['confirmed', 'seated', 'done'].includes(b.status) && (b.amount || 0) > 0 && !b.paid && !b.waived
      && !((b.paidAmount || 0) > 0) && !((b.covered || 0) > 0) && String(b.customerId || '') !== String(game.gmCustomerId);
    return { covered: false, coverable };
  },

  /** The first name of the GM paying for a seat. No awaits. */
  coverPayer(seat) {
    const cover = this.coverOf(seat.id);
    return this.firstNameOf(cover?.name || this.memberRow(seat.coveredBy)?.name || 'Another GM');
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
    // a GM on a monthly account pays for a player within their limit, as when they book (staff at the counter can always)
    if (!this.can(who, ['sessions', 'checkin', 'money'])) this.checkAccountLimit(String(game.gmCustomerId), this.coverPer(game, rules) * seat.people, rules, now, 'cover');
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
      // (only the GM paying: a session given to another GM keeps a locked-in offer with the GM before)
      if (String(seat.coveredBy) !== String(who.customerId)) throw new RuleError(GM_COVER_WORDS.notYours, 403);
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
   * the seat costs its players a seat's price on the session now (amount: unless said). why: 'stopped' (the GM or
   * staff), 'paid' (the player paid for it themselves) or 'gm' (the session has another GM). No awaits.
   */
  endCover(seat, now, { why = 'stopped', rules = this.rulesCache, amount = null } = {}) {
    const game = seat.gameId ? this.game(seat.gameId) : null;
    const cover = this.coverOf(seat.id);
    if (cover && cover.status !== 'cancelled') this.chargeOff(cover, seat, game, now, why);
    const price = amount != null ? amount : seatPriceOf(game, rules) * (seat.people || 1);
    const paid = settledOf({ ...seat, amount: price, paid: false });
    this.write('UPDATE bookings SET covered_by = NULL, cover_was = NULL, amount = ?, paid = ?, updated_at = ? WHERE id = ?', price, paid ? 1 : 0, now, seat.id);
  },

  /** A GM's charge goes; money on it is a refund due (settleChargeRefund: staff hear why). No awaits. */
  chargeOff(cover, seat, game, now, why) {
    this.write("UPDATE bookings SET status = 'cancelled', hold_until = NULL, updated_at = ? WHERE id = ?", now, cover.id);
    this.dropDraft(cover);
    this.settleChargeRefund(cover.id, now, why, { seat, game });
  },

  /**
   * What's due back to a GM on a charge: what they've paid on it (net of money given back) over what it costs now, which
   * is all of it once the charge has gone. No awaits.
   */
  chargeBack(cover) {
    const owed = cover.status === 'cancelled' ? 0 : cover.amount || 0;
    return Math.max(0, (cover.paidAmount || 0) - owed);
  },

  /**
   * A charge's refund in step with the money on it (chargeBack): refund 'due' with refund_amount what to give back, or
   * none. Staff hear when it starts, changes or stops being due (why says why); was: what they'd been told before, when
   * the flag's been cleared already. Inside an order (coverHold), they hear once, after it. Returns what's due back.
   * No awaits.
   */
  settleChargeRefund(coverId, now, why, { seat = null, game = null, was = null } = {}) {
    const cover = this.booking(coverId);
    if (!cover || cover.kind !== 'gm-cover') return 0;
    const back = this.chargeBack(cover);
    const before = was ?? (cover.refund === 'due' ? cover.refundAmount || 0 : 0);
    if (back > 0 && (cover.refund !== 'due' || cover.refundAmount !== back)) {
      this.write("UPDATE bookings SET refund = 'due', refund_amount = ?, updated_at = ? WHERE id = ?", back, now, cover.id);
    } else if (back === 0 && cover.refund === 'due') {
      this.write('UPDATE bookings SET refund = NULL, refund_amount = NULL, updated_at = ? WHERE id = ?', now, cover.id);
    }
    // (inside an order, every change is noted, with its why: what staff hear is decided once the order's done)
    if (back !== before || this.coverHold) this.tellChargeRefund(cover.id, { why, before, seat, game });
    return back;
  },

  /** Staff hear what's due back on a charge now (or held until the order's done: coverHold). No awaits. */
  tellChargeRefund(coverId, { why, before, seat = null, game = null }) {
    if (this.coverHold) {
      // (the email says what it was before the order, and the likeliest why: the player paying, say, over a GM's line)
      const held = this.coverHold.get(coverId);
      const rank = (w) => { const i = WHY_FIRST.indexOf(w); return i < 0 ? WHY_FIRST.length : i; };
      this.coverHold.set(coverId, {
        why: held && rank(held.why) <= rank(why) ? held.why : why, before: held ? held.before : before, seat: seat || held?.seat || null, game: game || held?.game || null,
      });
      return;
    }
    const cover = this.booking(coverId);
    const back = cover.refund === 'due' ? cover.refundAmount || 0 : 0;
    if (back === before) return;
    const theSeat = seat || (cover.coverOf ? this.booking(cover.coverOf) : null);
    const theGame = game || (cover.gameId ? this.game(cover.gameId) : null);
    const gm = cover.name || 'The GM';
    const first = this.firstNameOf(gm);
    const player = theSeat?.name || 'a player';
    const where = this.coverWhere(theGame);
    const paid = cover.paidAmount || 0;
    const details = [["GM's charge", cover.ref], ['Seat', theSeat?.ref || ''], ['Paid', money(paid)], ['To give back', money(back)]];
    if (back === 0) {
      const now = cover.status === 'cancelled' ? "it isn't on now" : `${player}'s seat is on, and it costs ${money(cover.amount || 0)}`;
      this.notifyStaff(`No refund now: ${cover.ref}`, {
        title: 'No refund now',
        intro: `There's nothing to give back to ${first} for ${player}'s seat at ${where} now: ${now}, and the ${money(paid)} they paid stays paid. Don't refund it. (If you already have, they owe it again: sort it out with them.)`,
        details,
      });
      return;
    }
    const reason = {
      off: `${player}'s seat was taken off, so ${first} doesn't pay for it`,
      free: "the session is free now, so there's nothing to pay for",
      paid: `${player} paid for their own seat too`,
      stopped: `staff stopped ${first} paying for it`,
      gm: `the session has another GM now, so ${first} doesn't pay for it`,
      late: `${first} wasn't paying for that seat any more`,
      fewer: `the seat is for ${plural(cover.people || 1, 'person', 'people')} now, so it costs ${money(cover.amount || 0)}`,
      more: `that's more than it costs (${money(cover.amount || 0)})`,
    }[why] || "the session isn't on now";
    const intro = before > 0
      ? `What to give back to ${first} for ${player}'s seat at ${where} is ${money(back)} now, not ${money(before)}: ${gm} has paid ${money(paid)} for it, and ${reason}. That's ${money(back)} in all: if you've given some back already without marking it, give back the rest. Then mark it refunded.`
      : `${gm} has paid ${money(paid)} for ${player}'s seat at ${where}, but ${reason}. Give ${first} back ${money(back)} (refund it, or put it on their store credit), then mark it refunded.`;
    this.notifyStaff(`Refund due: ${cover.ref}`, { title: 'Refund due', intro, details });
  },

  /** Inside an order: staff hear about charges' refunds once, after it (tellChargeRefund). No awaits. */
  holdChargeRefunds() {
    this.coverHold = new Map();
  },

  /** The order's done: what each charge's refund came to, against what staff had been told before it. No awaits. */
  flushChargeRefunds() {
    const held = this.coverHold;
    this.coverHold = null;
    if (!held) return;
    for (const [coverId, x] of held) this.tellChargeRefund(coverId, x);
  },

  /**
   * POST /bookings/:id/update { refunded } on a GM's charge (staff, as for any refund): true, what was due back to the
   * GM was given back. It's recorded as money back (a payment of minus that much, so every later sum goes by what the GM
   * has paid, net), and the charge says refunded. false undoes the last one. Returns the staff view. No awaits.
   */
  chargeRefunded(cover, refunded, rules, now) {
    if (refunded) {
      const back = this.chargeBack(cover);
      if (!(back > 0)) throw new RuleError(GM_COVER_WORDS.nothingBack, 409);
      this.write(
        "INSERT INTO payments (id, booking_id, kind, order_id, line_id, amount, customer_id, at) VALUES (?, ?, ?, 'refund', ?, ?, NULL, ?)",
        makeId('pm'), cover.id, 'booking', `refund:${makeId('rf')}`, -back, now,
      );
      const paidAmount = Math.max(0, (cover.paidAmount || 0) - back);
      const paid = cover.status !== 'cancelled' && (cover.amount || 0) > 0 ? paidAmount >= cover.amount : false;
      this.write("UPDATE bookings SET paid_amount = ?, paid = ?, refund = 'done', refund_amount = ?, updated_at = ? WHERE id = ?", paidAmount, paid ? 1 : 0, back, now, cover.id);
    } else {
      const last = this.sql.exec("SELECT * FROM payments WHERE booking_id = ? AND order_id = 'refund' ORDER BY at DESC, rowid DESC LIMIT 1", cover.id).toArray()[0];
      if (last) {
        this.write('DELETE FROM payments WHERE id = ?', last.id);
        const paidAmount = (cover.paidAmount || 0) - last.amount;
        const paid = cover.status !== 'cancelled' && (cover.amount || 0) > 0 ? paidAmount >= cover.amount : Boolean(cover.paid);
        this.write('UPDATE bookings SET paid_amount = ?, paid = ?, refund = NULL, refund_amount = NULL, updated_at = ? WHERE id = ?', paidAmount, paid ? 1 : 0, now, cover.id);
      } else this.write('UPDATE bookings SET refund = NULL, refund_amount = NULL, updated_at = ? WHERE id = ?', now, cover.id);
      // what's due back again, as before it was marked (staff were told then)
      this.settleChargeRefund(cover.id, now, 'more', { was: this.chargeBack(this.booking(cover.id)) });
    }
    this.reconcileBills(rules, now);
    return { booking: this.staffBooking(this.booking(cover.id)), refund: null };
  },

  /** "Session title, Tuesday 27 October at 6:00 pm to 10:00 pm" for staff emails. No awaits. */
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
   *    that went comes back, with what the GM has paid on it (net) counting.
   *  - off: the charge goes.
   * Either way, what's due back to the GM follows (settleChargeRefund). Returns what changed ('ended', 'on', 'off',
   * 'amount', 'seat') or null. No awaits.
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
    let was = null;
    if (!cover) {
      cover = this.newCharge(seat, game, rules, now, 'gobgob');
      changed = 'on';
    } else if (cover.status === 'cancelled') {
      // back on: what the GM has paid on it (net of anything given back) counts towards it again
      was = cover.refund === 'due' ? cover.refundAmount || 0 : 0;
      this.write("UPDATE bookings SET status = 'confirmed', refund = NULL, refund_amount = NULL, updated_at = ? WHERE id = ?", now, cover.id);
      cover = this.booking(cover.id);
      changed = 'on';
    }
    const paidIn = cover.paidAmount || 0;
    const per = paidIn > 0 ? Math.round((cover.amount || 0) / Math.max(1, cover.people || 1)) : this.coverPer(game, rules);
    const amount = per * (seat.people || 1);
    let why = 'back';
    if (cover.amount !== amount || cover.people !== seat.people || cover.start !== seat.start || cover.end !== seat.end) {
      const paid = amount > 0 ? paidIn >= amount : Boolean(cover.paid);
      this.write('UPDATE bookings SET people = ?, amount = ?, paid = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?', seat.people, amount, paid ? 1 : 0, seat.start, seat.end, now, cover.id);
      if (changed !== 'on') why = amount < (cover.amount || 0) ? 'fewer' : 'more';
      changed = changed || 'amount';
    } else if (changed === 'on') {
      const paid = amount > 0 ? paidIn >= amount : Boolean(cover.paid);
      if (Boolean(cover.paid) !== paid) this.write('UPDATE bookings SET paid = ?, updated_at = ? WHERE id = ?', paid ? 1 : 0, now, cover.id);
    }
    if (changed === 'on' || changed === 'amount') this.settleChargeRefund(cover.id, now, why, { seat, game, ...(was != null ? { was } : {}) });
    return changed;
  },

  /** Every seat a GM pays for on a session, in step (syncCover). No awaits. */
  syncCoversOn(gameId, now = Date.now(), rules = this.rulesCache) {
    for (const r of this.sql.exec("SELECT id FROM bookings WHERE game_id = ? AND kind = 'gm-seat' AND covered_by IS NOT NULL", String(gameId)).toArray()) {
      this.syncCover(r.id, now, rules);
    }
  },

  /**
   * After a session gets another GM (POST /games/:id/gm): each offer the GM before made, that they could still stop
   * (more than refundHours before), ends. The seat gets the session's seat price, its player is emailed, and what the
   * GM before had paid on it is a refund due. From refundHours before, an offer is locked in like any seat, so it stays
   * theirs: staff get one email listing those, to stop any that shouldn't. Returns { ended, kept } (people). No awaits.
   */
  coversAfterGmChange(session, oldGm, rules, now) {
    const seats = this.sql
      .exec("SELECT * FROM bookings WHERE game_id = ? AND kind = 'gm-seat' AND covered_by IS NOT NULL AND covered_by != ?", session.id, String(session.gmCustomerId || ''))
      .toArray()
      .map((r) => this.rowToBooking(r));
    const letters = [];
    const kept = [];
    let ended = 0;
    for (const seat of seats) {
      if (cancelUntil(seat, rules) <= now) {
        const cover = this.coverOf(seat.id);
        if (cover && cover.status !== 'cancelled') kept.push([seat.name || 'A player', `${seat.ref}: ${money(cover.amount || 0)}, ${cover.paid ? 'paid' : 'not paid yet'}`]);
        continue;
      }
      this.endCover(seat, now, { why: 'gm', rules });
      ended += seat.people;
      if (!['confirmed', 'seated'].includes(seat.status) || !isEmail(seat.email)) continue;
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
    if (kept.length) {
      const old = this.firstNameOf(oldGm || 'The GM');
      this.notifyStaff(`Still paying: ${session.title}`, {
        title: 'A GM still pays for players',
        intro: `${session.title}, ${this.when(session, rules)}, has a new GM, ${session.gm || 'someone else'}. ${old} was paying for ${kept.length === 1 ? "a player's seat" : `${kept.length} players' seats`} on it, and it's less than ${rules.refundHours} hours away (or it's started), so that's locked in: ${old} still pays. If ${old} shouldn't, tap "Stop the GM paying" on the seat: the player's seat then costs them its price (waive it if they shouldn't pay either).`,
        details: kept,
      });
    }
    return { ended, kept: kept.length };
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

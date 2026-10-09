/**
 * Round 11, Warhammer: game tables for 1 v 1 and 2 v 2 games, a pair of tables picked, the other players named by member
 * code or email (contract v11-warhammer). Mo (9 Oct 2026, 7pm): "Warhammer, Thursdays from 6pm till midnight. Book tables
 * from T8-T21 (with T16-T17 is the painting station) for Warhammer with games needing to be organized for one on one or two
 * on two games, and people inside the Warhammer group can book their spots with the code of their opponent or their email
 * to help them join us. They can choose a specific table as well but it needs to be two at a time so they choose the
 * following, T8-t9, t10-t11, t12-t13, t20-t21. Etc.etc. set the fee to $10 per person."
 *
 * An event date's game spot (POST /events/:id/reserve: a table booking linked to the date, as before) can now be the pair
 * the booker picks (`spot`), for 2 or 4 players (1 v 1 or 2 v 2), with the other players named by member code or email.
 * Each named player is a row in `booking_players` (role 'teammate' or 'opponent'): a member found by their code, an email
 * that belongs to a member (linked to them), or any other email (invited: the game joins their account when they make one
 * with it, like round 6's guest bookings). Every other player with an email gets one email; a named member sees the game in
 * My Lair; any named player's member code at the counter finds it. Each player pays their own share (the entry fee) at the
 * counter, so the booking splits its bill.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair. None
 * of them awaits: they run inside a handler's one synchronous read-check-write.
 */
import { HOUR, RuleError, codeKey, findOccurrence, makeId } from './core.js';
import { emailReady } from './shopify.js';

/** People on a game table: 2 (1 v 1) or 4 (2 v 2). 1 is an older page's "Just me", still taken. */
export const GAME_PEOPLE = [1, 2, 4];
/** A game's size in words, by its people */
export const GAME_SIZES = { 2: '1 v 1', 4: '2 v 2' };
/** Who the other players are, in the order the page sends them */
export const PLAYER_ROLES = { 2: ['opponent'], 4: ['teammate', 'opponent', 'opponent'] };
/** A named player's record joins the account with their email for this long after the game (as ADOPT_DAYS in lair.js) */
const ADOPT_DAYS = 30;
/** Every message a customer can see, word for word in the contract */
export const PLAYER_WORDS = {
  size: 'A game table is for 1 v 1 (2 players) or 2 v 2 (4 players).',
  spot: (label) => `${label} isn't one of this date's game tables. Pick a pair from the list.`,
  taken: (label) => `${label} has just been reserved. Pick another pair of tables.`,
  count: (n) => (n === 1 ? 'Add your opponent: their member code or email.' : `Add the other ${n} players: a member code or an email each.`),
  missing: 'Add a member code or an email for each player.',
  email: (text) => `${text} doesn't look like an email address. Check it, or use their member code.`,
  unknown: (code) => `Gobgob doesn't know the member code ${code}. Check it, or use their email instead.`,
  own: "That's your own member code. Add the people you're playing with.",
  ownEmail: "That's your own email. Add the people you're playing with.",
  twice: (who) => `${who} is on the list twice.`,
};
/** A player with no account, where only names are shown */
export const INVITED_NAME = 'Invited player';

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const trimmed = (v, max) => String(v ?? '').trim().slice(0, max);
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'Someone';
/** $10, or $12.50 */
const money = (cents) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
/** What's still to pay on a booking, as lair.js's dueOf: nothing once it's paid or waived */
const owing = (b) => Math.max(0, (b.amount || 0) - (b.covered || 0) - (b.paidAmount || 0));
const dueOf = (b) => (b.paid || b.kind === 'gm' || b.waived ? 0 : owing(b));
/** "T8 + T9" */
export const spotLabel = (tables) => tables.join(' + ');
/** A pair's key, however it was typed: "t9 + t8" and "T8+T9" are both "T8+T9" */
export const spotKey = (tables) => [...new Set(tables.map((t) => String(t).trim().toUpperCase()).filter(Boolean))]
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  .join('+');
const spotParts = (text) => String(text ?? '').split(/[+,&\s]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
/** "Sam, Kiri and Jo" */
const listText = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

export const gamePlayerMethods = {
  /**
   * The pair of tables asked for (`spot`: "T8+T9", any case, with "+", "," or spaces between), among an event date's game
   * spots, or null when none was asked for. One that isn't among them is a 422.
   */
  pickedSpot(spots, wanted) {
    const parts = spotParts(trimmed(wanted, 60));
    if (!parts.length) return null;
    const found = spots.find((s) => spotKey(s) === spotKey(parts));
    if (!found) throw new RuleError(PLAYER_WORDS.spot(spotLabel(parts.slice(0, 4))));
    return found;
  },

  /**
   * The other players on a game (`players`: [{ code } | { email }], or plain strings, in the order PLAYER_ROLES gives
   * them roles), checked and found. A code must be a member's; an email that belongs to a member links to them; any
   * other email is someone to invite. Left out: none (an older page), except for 2 v 2, which needs them. 422s: the
   * wrong number for the size, an empty one, an email that isn't one, a code nobody has, the booker themselves (their
   * code, their email, or a member that's them) and the same person twice. Returns
   * [{ role, position, name, customerId, email, code }].
   */
  gamePlayersFrom(value, people, { who, email }) {
    const roles = PLAYER_ROLES[people] || [];
    if (value == null) {
      if (people === 4) throw new RuleError(PLAYER_WORDS.count(roles.length));
      return [];
    }
    if (!Array.isArray(value) || !roles.length) throw new RuleError(roles.length ? PLAYER_WORDS.missing : PLAYER_WORDS.size);
    if (value.length !== roles.length) throw new RuleError(PLAYER_WORDS.count(roles.length));
    const me = who?.customerId ? String(who.customerId) : '';
    const mine = me ? this.memberRow(me) : null;
    const ownEmails = new Set([email, mine?.email, mine?.account_email].filter(isEmail).map((e) => String(e).trim().toLowerCase()));
    const isMine = (m) => Boolean(m) && ((me && String(m.customer_id) === me) || [m.email, m.account_email].some((e) => isEmail(e) && ownEmails.has(String(e).trim().toLowerCase())));
    const seen = new Set();
    return value.map((entry, i) => {
      const raw = typeof entry === 'string' ? entry : String(entry?.code || entry?.email || '');
      const text = raw.trim().replace(/\s+/g, ' ');
      if (!text) throw new RuleError(PLAYER_WORDS.missing);
      let member = null;
      let mail = '';
      if (text.includes('@')) {
        if (!isEmail(text) || text.length > 120) throw new RuleError(PLAYER_WORDS.email(text.slice(0, 80)));
        mail = text;
        if (ownEmails.has(mail.toLowerCase())) throw new RuleError(PLAYER_WORDS.ownEmail);
        member = this.memberForEmail(mail);
        if (isMine(member)) throw new RuleError(PLAYER_WORDS.ownEmail);
      } else {
        const code = text.toUpperCase().slice(0, 40);
        if (!codeKey(code)) throw new RuleError(PLAYER_WORDS.missing);
        member = this.memberByCode(code);
        if (!member) throw new RuleError(PLAYER_WORDS.unknown(code));
        if (isMine(member)) throw new RuleError(PLAYER_WORDS.own);
      }
      const name = member ? trimmed(member.name || member.first_name, 80) || member.code || '' : '';
      const key = member ? `m:${member.customer_id}` : `e:${mail.toLowerCase()}`;
      if (seen.has(key)) throw new RuleError(PLAYER_WORDS.twice(name || mail));
      seen.add(key);
      // The email they're reached at: the one typed, or the member's own
      const contact = mail || (isEmail(member?.email) ? member.email : isEmail(member?.account_email) ? member.account_email : '');
      return { role: roles[i], position: i + 1, name, customerId: member ? String(member.customer_id) : null, email: contact ? trimmed(contact, 120) : null, code: member?.code || null };
    });
  },

  /** A member whose email or Shopify account email is this one (the account's, verified, first), or null */
  memberForEmail(email) {
    if (!isEmail(email)) return null;
    const e = String(email).trim();
    return this.sql
      .exec(
        `SELECT * FROM members WHERE lower(email) = lower(?) OR lower(account_email) = lower(?)
         ORDER BY CASE WHEN lower(account_email) = lower(?) THEN 0 ELSE 1 END, last_seen DESC LIMIT 1`,
        e, e, e,
      )
      .toArray()[0] || null;
  },

  /** A game's players, saved with its booking (gamePlayersFrom's list) */
  saveGamePlayers(booking, players, now) {
    for (const p of players) {
      this.write(
        `INSERT INTO booking_players (id, booking_id, role, position, name, customer_id, email, code, invited_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        makeId('bp'), booking.id, p.role, p.position, p.name || '', p.customerId, p.email, p.code, now,
      );
    }
  },

  /** A booking's player rows, in order, each with their member record's name and code now */
  gamePlayerRows(bookingId) {
    return this.sql
      .exec(
        `SELECT p.*, m.name AS member_name, m.first_name AS member_first, m.code AS member_code
         FROM booking_players p LEFT JOIN members m ON m.customer_id = p.customer_id WHERE p.booking_id = ? ORDER BY p.position, p.rowid`,
        String(bookingId),
      )
      .toArray();
  },

  /** A player's name: a member's as the Lair has it now, or INVITED_NAME for someone invited by email */
  playerName(p) {
    if (!p.customer_id) return INVITED_NAME;
    return trimmed(p.member_name || p.member_first || p.name, 80) || p.member_code || p.code || 'A member';
  },

  /**
   * A game's players as someone sees them: { name, role, member, invited } each, plus you: true on the viewer's own
   * entry. staff: with email, code and customerId; booker: with email (they typed it). Nobody else gets an email or a
   * code. withBooker: the booker first, as role 'booker' (for the other players' views). [] when it has none.
   */
  gamePlayersOf(b, { staff = false, booker = false, viewer = null, withBooker = false } = {}) {
    const rows = this.gamePlayerRows(b.id);
    if (!rows.length) return [];
    const list = rows.map((p) => ({
      name: this.playerName(p), role: p.role, member: Boolean(p.customer_id), invited: !p.customer_id,
      ...(viewer && String(p.customer_id || '') === String(viewer) ? { you: true } : {}),
      ...(staff ? { email: p.email || '', code: p.member_code || p.code || null, customerId: p.customer_id || null } : booker ? { email: p.email || '' } : {}),
    }));
    if (!withBooker) return list;
    return [{ name: trimmed(b.name, 80) || 'The booker', role: 'booker', member: Boolean(b.customerId), invited: false }, ...list];
  },

  /** A booking with its game's players added (for its booker), when it has any: gameSize ('1 v 1' or '2 v 2') too */
  withGamePlayers(view, b) {
    const players = b.occurrenceId ? this.gamePlayersOf(b, { booker: true }) : [];
    return players.length ? { ...view, gamePlayers: players, gameSize: GAME_SIZES[b.people] || null } : view;
  },

  /** For staff views of a booking (the floor, check-in rows, the POS): its players with emails and codes, when it has any */
  staffGamePlayers(b) {
    const players = b.occurrenceId ? this.gamePlayersOf(b, { staff: true }) : [];
    return players.length ? { gamePlayers: players, gameSize: GAME_SIZES[b.people] || null } : {};
  },

  /** Who's playing, for an email: "You against Kiri", "You and Tama against Kiri and jo@example.com" (the booker's) */
  playingWords(b, rows, { forPlayer = null } = {}) {
    const who = (p) => {
      if (forPlayer && p.id === forPlayer.id) return 'you';
      if (forPlayer) return p.customer_id ? this.playerName(p) : 'an invited player';
      return p.customer_id ? this.playerName(p) : p.email || INVITED_NAME;
    };
    const booker = forPlayer ? trimmed(b.name, 80) || 'The booker' : 'You';
    const team = [booker, ...rows.filter((p) => p.role === 'teammate').map(who)];
    const them = rows.filter((p) => p.role === 'opponent').map(who);
    return `${listText(team)} against ${listText(them)}`;
  },

  /**
   * The booker's confirmation, for a game with named players: the extra details (the game's size and who's playing),
   * the fee a person, and the split-bill line. null for any other booking.
   */
  gameEmailParts(b) {
    const rows = b.occurrenceId ? this.gamePlayerRows(b.id) : [];
    if (!rows.length) return null;
    const unit = Math.round((b.amount || 0) / Math.max(1, b.people || 1));
    return {
      details: [['Game', GAME_SIZES[b.people] || ''], ['Playing', this.playingWords(b, rows)]],
      fee: unit ? `${money(unit)} a person, paid at the counter. Each player pays their own.` : 'Nothing to pay',
      split: unit
        ? `Each player pays their own ${money(unit)} at the counter. The others give their member code (or this booking's code) when they arrive.`
        : 'The others give their member code (or this booking\'s code) when they arrive.',
    };
  },

  /**
   * Every other player with an email who hasn't heard yet gets one email: who booked the game with them, when, which
   * tables, the fee ("$10 a person, paid at the counter") and, for someone without an account, how to make one so the game
   * shows up in My Lair. Marks each one sent (invited_at), so nobody hears twice. Returns how many went.
   */
  tellGamePlayers(b, rules) {
    if (!emailReady(this.env) || !b?.occurrenceId || b.status !== 'confirmed') return 0;
    const rows = this.gamePlayerRows(b.id);
    const event = findOccurrence(rules, b.occurrenceId);
    const title = event?.title || 'the event';
    const unit = Math.round((b.amount || 0) / Math.max(1, b.people || 1));
    const when = this.when(b, rules);
    const booker = trimmed(b.name, 80) || 'Someone';
    const now = Date.now();
    let sent = 0;
    for (const p of rows) {
      if (!isEmail(p.email) || p.invited_at) continue;
      const member = Boolean(p.customer_id);
      const hello = member ? firstName(this.playerName(p)) : 'there';
      const team = p.role === 'teammate' ? ` You're on ${firstName(booker)}'s team.` : '';
      this.later(this.mail(this.letter(p.email, `${title} with ${firstName(booker)}: ${when} (${b.ref})`, {
        title: "You've got a game!",
        intro: `Kia ora ${hello}, ${booker} has booked a ${GAME_SIZES[b.people] || ''} game with you at ${title}, at the Dice Goblin Lair.${team} Gobgob has saved your tables.`.replace(/ {2}/g, ' '),
        details: [
          ['Event', title], ['When', when], ['Where', `Tables ${spotLabel(b.tables || [])}`], ['Game', GAME_SIZES[b.people] || ''],
          ['Playing', this.playingWords(b, rows, { forPlayer: p })], ['Fee', unit ? `${money(unit)} a person, paid at the counter` : ''], ['Booking code', b.ref],
        ],
        outro: [
          member
            ? 'Give your member code at the counter when you arrive: it finds the game. Your code is in My Lair, and so is this game.'
            : `Make your free Dice Goblin account with this email (${p.email}) and the game shows up in My Lair. Until then, give the booking code above at the counter.`,
          `Can't make it? Let ${firstName(booker)} know, so they can find someone else.`,
        ],
        button: { label: member ? 'See it in My Lair' : 'Make your free account', url: this.page('myLair') },
      })));
      this.write('UPDATE booking_players SET invited_at = ? WHERE id = ? AND invited_at IS NULL', now, p.id);
      sent += 1;
    }
    return sent;
  },

  /**
   * What one named player pays for a game: their share (the booking's price a person), less what orders with them as
   * the customer paid toward it, and never more than is left on the booking. Nothing once it's paid, waived, cancelled
   * or a no-show. { amount, paid, due }.
   */
  playerShare(b, customerId) {
    const unit = Math.round((b.amount || 0) / Math.max(1, b.people || 1));
    const paid = customerId
      ? this.sql.exec('SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE booking_id = ? AND customer_id = ?', b.id, String(customerId)).one().n
      : 0;
    const over = ['cancelled', 'noshow'].includes(b.status) || b.paid || b.waived;
    return { amount: unit, paid, due: over ? 0 : Math.max(0, Math.min(unit - paid, dueOf(b))) };
  },

  /**
   * A game as a check-in row for one of its named players: bookingRow, with their own name and account, their share as
   * what's due (amount, paidAmount and due: playerShare), no pass and no split, playerOf (the booker's first name) and
   * player ({ id, role }). id: the player's own row id by default (the POS checks it in with POST /pos/checkin { id }:
   * the game is checked in and their share goes in the cart); the staff page's member card sends the booking's.
   */
  playerRow(b, p, rules, { id = p.id, now = Date.now() } = {}) {
    const row = this.bookingRow(b, rules, { now });
    const share = this.playerShare(b, p.customer_id);
    return {
      ...row, id, bookingId: b.id, name: this.playerName(p), customerId: p.customer_id || null, amount: share.amount, covered: 0, paidAmount: share.paid,
      due: share.due, payments: [], split: false, pass: null, playerOf: { name: firstName(b.name) }, player: { id: p.id, role: p.role },
    };
  },

  /** Today's games (not cancelled) a member is a named player in, someone else's booking: [{ booking, player }] */
  playerGamesToday(customerId, rules, now) {
    const { from, to } = this.dayWindow(rules, now);
    return this.sql
      .exec(
        `SELECT p.*, m.name AS member_name, m.first_name AS member_first, m.code AS member_code, b.id AS b_id
         FROM booking_players p JOIN bookings b ON b.id = p.booking_id LEFT JOIN members m ON m.customer_id = p.customer_id
         WHERE p.customer_id = ? AND b.ends_at > ? AND b.starts_at < ? AND b.status != 'cancelled' AND (b.customer_id IS NULL OR b.customer_id != p.customer_id)
         ORDER BY b.starts_at, p.rowid`,
        String(customerId), from, to,
      )
      .toArray()
      .map((p) => ({ booking: this.booking(p.b_id), player: p }))
      .filter((x) => x.booking);
  },

  /** Today's games a member is a named player in, as their check-in rows (playerRow) */
  playerRowsToday(customerId, rules, now, { bookingIds = false } = {}) {
    return this.playerGamesToday(customerId, rules, now).map(({ booking, player }) => this.playerRow(booking, player, rules, { now, ...(bookingIds ? { id: booking.id } : {}) }));
  },

  /**
   * Check in a game by one of its named players' row id (bp_…): the game is checked in (checkInBooking, so everyone on it
   * is here), and the answer's row is theirs (playerRow), so what's due is their own share. null when there's no such
   * player.
   */
  checkInPlayer(playerId, rules, now, options = {}) {
    const p = this.sql
      .exec('SELECT p.*, m.name AS member_name, m.first_name AS member_first, m.code AS member_code FROM booking_players p LEFT JOIN members m ON m.customer_id = p.customer_id WHERE p.id = ?', String(playerId))
      .toArray()[0];
    const booking = p ? this.booking(p.booking_id) : null;
    if (!booking) return null;
    const result = this.checkInBooking(booking, rules, now, options);
    const row = this.playerRow(this.booking(booking.id), p, rules, { now });
    return { ...result, row, due: row.due, customer: p.customer_id ? { id: String(p.customer_id) } : null };
  },

  /**
   * GET /me: the games a member is a named player in (someone else booked them), from `since` on, as bookings entries:
   * the booking's when and where, with playerOf (the booker's first name), canCancel: false, their member code as the
   * ticket (check-in finds the game by it), the players (names only, the booker first, `you` on their own) and their own
   * share as the money (amount, due, paidAmount). Never another player's email.
   */
  playerBookings(customerId, since, member, rules) {
    const rows = this.sql
      .exec(
        `SELECT p.id AS player_id, p.role AS player_role, b.* FROM booking_players p JOIN bookings b ON b.id = p.booking_id
         WHERE p.customer_id = ? AND b.ends_at > ? AND (b.customer_id IS NULL OR b.customer_id != p.customer_id) ORDER BY b.starts_at, p.rowid`,
        String(customerId), since,
      )
      .toArray();
    return rows.map((r) => {
      const b = this.rowToBooking(r);
      const share = this.playerShare(b, customerId);
      return {
        id: b.id, ref: b.ref, kind: b.kind, tables: b.tables, room: b.room, start: b.start, end: b.end, people: b.people, status: b.status,
        paid: share.due === 0 && (share.paid > 0 || b.paid), amount: share.amount, pay: 'day', extras: b.extras, players: [], occurrenceId: b.occurrenceId || null,
        refund: null, payment: 'store', pass: null, covered: 0, due: share.due, paidAmount: share.paid, split: false, owed: false, waived: Boolean(b.waived),
        title: findOccurrence(rules, b.occurrenceId)?.title || '', playerOf: { name: firstName(b.name) }, canCancel: false, role: r.player_role,
        gameSize: GAME_SIZES[b.people] || null, gamePlayers: this.gamePlayersOf(b, { viewer: customerId, withBooker: true }),
        ...(member?.code ? { ticketCode: member.code } : {}),
      };
    });
  },

  /**
   * Someone named by email makes their account (or logs in) with it: the games they're on with no account, upcoming or
   * ended in the last 30 days, become theirs, so they show in My Lair and their member code finds them at the counter.
   * Not a game they booked themselves. Returns how many joined.
   */
  adoptGamePlayers(customerId, email, now) {
    const since = now - ADOPT_DAYS * HOUR * 24;
    const id = String(customerId);
    const found = this.sql
      .exec(
        `SELECT p.id FROM booking_players p JOIN bookings b ON b.id = p.booking_id
         WHERE p.customer_id IS NULL AND lower(p.email) = lower(?) AND b.ends_at > ? AND (b.customer_id IS NULL OR b.customer_id != ?)`,
        email, since, id,
      )
      .toArray();
    if (!found.length) return 0;
    const member = this.memberRow(id);
    for (const { id: rowId } of found) {
      this.write('UPDATE booking_players SET customer_id = ?, name = ?, code = ? WHERE id = ? AND customer_id IS NULL', id, trimmed(member?.name || member?.first_name, 80), member?.code || null, rowId);
    }
    return found.length;
  },

  /** For the floor's eventSpots: an event date's pairs, each { id: 'T8+T9', label: 'T8 + T9', tables, free } */
  spotChoices(o, rules, st, spots) {
    const free = new Set(this.freeSpots(o, rules, st).map(spotKey));
    return spots.map((tables) => ({ id: spotKey(tables), label: spotLabel(tables), tables, free: free.has(spotKey(tables)) }));
  },
};

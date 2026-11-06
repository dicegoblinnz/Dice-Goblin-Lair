/**
 * Round 31, open games (contract v31-open-games; the Warhammer and hobby chat, Mo's picks 2 to 6 Nov 2026). A member with
 * no opponent books a pair of tables on a game night as looking for a game: POST /events/:id/reserve with `looking` (a
 * game and size from OPEN_GAME_LIST, new players welcome or not; no free text, so nothing to moderate). Until someone
 * joins, the booking is the booker alone (people 1, their own $10), so nothing more is ever owed for a game nobody
 * joined; the first member to join (POST /open-games/:id/join) makes it 1 v 1, each paying their own $10 at the counter
 * (round 11's split), and is a named opponent in booking_players like any other. Mo: "On the booking + Discord".
 *
 * - The list (GET /open-games): the next four game nights, each with its free pairs and its open games. Members see the
 *   booker's first name, logged out "A player"; never an email, an account, a member code or a booking's own id or code
 *   (a game's public id is its own, og_...). A taken game leaves the list, except for its two players.
 * - Cancelling: while nobody has joined, the booker cancels free right up until it starts (cancelRule in lair.js); once
 *   someone has, the usual rule (locked refundHours before). The player can drop out (POST /open-games/:id/leave) until
 *   then too, and the game is listed again. Each side hears about the other's change by email.
 * - The afternoon: from 2pm on the day, the booker of a game nobody has joined is asked once if they're still coming
 *   (to play whoever walks in, or paint), and can still cancel free before it starts. Not for a game listed from 2pm
 *   that day: they've only just said they're coming.
 * - The two players found each other on the list, so each sees the other's first name only, everywhere (the list, My
 *   Lair, the join's answer, emails): never an email, a phone, a last name, a member code or the booker's booking code.
 * - Discord: with DISCORD_WARHAMMER_WEBHOOK set (a secret, the channel's webhook address), each game is posted without
 *   anyone's name or tables, edited to "Game on!" once it's taken, and deleted when it's called off or the night's over.
 *   A post that fails is tried again by the 10-minute run (openGamesAt). Mentions are switched off, so a post never pings.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair. The
 * checks and writes of listing, joining and dropping out run in one synchronous read-check-write (the Durable Object
 * handles one request at a time), so two people can't both join a game; only emails and Discord calls happen after.
 */
import { HOUR, LairTime, RuleError, cancelUntil, eventOccurrences, findOccurrence, makeId, parseSpots } from './core.js';
import { emailReady } from './shopify.js';
import { GAME_SIZES, spotLabel } from './warhammer.js';

/** The games a listing can be (Mo's: "Warhammer 40,000, Age of Sigmar, Kill Team, Others (Old World, Bolt Action)"),
    with the sizes each offers. who and the: how a Discord post names a player and the game. */
export const OPEN_GAME_LIST = [
  { key: '40k', name: 'Warhammer 40,000', sizes: ['combat-patrol', '1000', '2000', 'any'], who: 'A Warhammer 40,000 player', the: 'The Warhammer 40,000 game' },
  { key: 'aos', name: 'Age of Sigmar', sizes: ['spearhead', '1000', '2000', 'any'], who: 'An Age of Sigmar player', the: 'The Age of Sigmar game' },
  { key: 'kill-team', name: 'Kill Team', sizes: [], who: 'A Kill Team player', the: 'The Kill Team game' },
  { key: 'old-world', name: 'The Old World', sizes: ['1000', '2000', 'any'], who: 'An Old World player', the: 'The Old World game' },
  { key: 'bolt-action', name: 'Bolt Action', sizes: ['1000', 'any'], who: 'A Bolt Action player', the: 'The Bolt Action game' },
  { key: 'other', name: 'Something else', sizes: [], who: 'A wargamer', the: 'The game' },
];
/** Each size as it's shown ("Not fussed" on the reserve sheet is 'any') */
export const OPEN_GAME_SIZES = { 'combat-patrol': 'Combat Patrol', spearhead: 'Spearhead', 1000: '1,000 points', 2000: '2,000 points', any: 'Any size' };

/** Every message a customer can see, word for word in the contract */
export const OPEN_GAME_WORDS = {
  login: 'Log in to list a game, so it shows in My Lair and Gobgob can tell you when someone joins.',
  loginJoin: 'Log in to join a game, so it shows in My Lair.',
  size: 'An open game is 1 v 1. For 2 v 2, add the other players.',
  both: 'Add your opponent, or let Gobgob find you one: not both.',
  game: 'Pick a game from the list.',
  points: 'Pick a size from the list.',
  online: "This night's game tables are paid online, so add your opponent instead of listing a game.",
  twice: "You've listed a game for this night already. It's in My Lair.",
  gone: "That game isn't listed any more. Pick another, or list your own.",
  own: "That's your own game. Someone else will join it.",
  taken: "Someone's just joined that game. Pick another, or list your own.",
  closed: "That night's nearly over, so the game can't be joined now.",
  listed: "You've listed a game of your own that night. Cancel it in My Lair first, or wait for someone to join it.",
  already: "You're already in a game that night. It's in My Lair.",
  notIn: "You're not in that game.",
  lockedLeave: (hours, name) => `It's less than ${hours} hours to the game, so you can't drop out online now. Let ${name} know, or give us a call.`,
  player: 'A player',
};

/** Made sure of on every start (lair.js). One row a listed game: its booking, the game and size, who joined (their
    booking_players row) and when, when the afternoon email went, and its Discord post (id, what it says now, last try). */
export const OPEN_GAME_TABLES = [
  `CREATE TABLE IF NOT EXISTS open_games (
    id TEXT PRIMARY KEY, booking_id TEXT NOT NULL UNIQUE, occurrence_id TEXT NOT NULL, game TEXT NOT NULL, size TEXT,
    new_players INTEGER NOT NULL DEFAULT 0, player_id TEXT, joined_at INTEGER, nudged_at INTEGER, post_id TEXT, post_state TEXT,
    post_tried_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER)`,
  'CREATE INDEX IF NOT EXISTS open_games_occurrence ON open_games (occurrence_id)',
];

/** Joining closes this long before the night ends */
const JOIN_CLOSES = 2 * HOUR;
/** The afternoon email goes from 2pm (Lair time) on the game's day */
const NUDGE_FROM = 14 * 60;
/** The list covers this many days ahead, and at most this many nights */
const LIST_DAYS = 28;
const LIST_NIGHTS = 8;
/** The Discord posts the 10-minute run looks after each time, at most */
const POSTS_A_RUN = 20;
/** A Discord webhook's address: https://discord.com/api/webhooks/<id>/<token> */
const HOOK = /^https:\/\/[a-z0-9.-]+\/api\/webhooks\/\d+\/[\w-]+$/i;

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const trimmed = (v, max) => String(v ?? '').trim().slice(0, max);
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const gameOf = (key) => OPEN_GAME_LIST.find((g) => g.key === key) || null;
/** "$10", "$12.50" */
const money = (cents) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
/** Paid in full, as lair.js's settled: what it costs (less a pass's cover) is paid; a booking that costs nothing keeps its flag */
const settled = (x) => ((x.amount || 0) > 0 ? Math.max(0, (x.amount || 0) - (x.covered || 0) - (x.paidAmount || 0)) === 0 : Boolean(x.paid));
const partsOf = (ms, tz, options) => Object.fromEntries(new Intl.DateTimeFormat('en-NZ', { timeZone: tz, ...options }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
/** "Thursday 15 October" */
const dayWords = (ms, tz) => {
  const p = partsOf(ms, tz, { weekday: 'long', day: 'numeric', month: 'long' });
  return `${p.weekday} ${p.day} ${p.month}`;
};
/** "6pm", "6:30pm" */
const clockWords = (ms, tz) => {
  const p = partsOf(ms, tz, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${p.minute === '00' ? p.hour : `${p.hour}:${p.minute}`}${String(p.dayPeriod || '').toLowerCase().replace(/[.\s]/g, '')}`;
};

export const openGameMethods = {
  /**
   * `looking` on POST /events/:id/reserve, checked: { game, size, newPlayers }, or null when it isn't an open game. A
   * logged-in member, 1 v 1, no named players, a game from the list and one of its sizes (none for a game without), and
   * not a second listing of theirs that night. No awaits.
   */
  openGameFrom(input, people, who, occurrence) {
    const value = input?.looking;
    if (value == null || value === false) return null;
    if (!who?.customerId) throw new RuleError(OPEN_GAME_WORDS.login, 401);
    if (people !== 2) throw new RuleError(OPEN_GAME_WORDS.size);
    if (Array.isArray(input.players) ? input.players.length > 0 : input.players != null) throw new RuleError(OPEN_GAME_WORDS.both);
    const game = gameOf(trimmed(value?.game, 40));
    if (!game) throw new RuleError(OPEN_GAME_WORDS.game);
    const size = trimmed(value?.size, 40) || null;
    if (game.sizes.length ? !game.sizes.includes(size) : size) throw new RuleError(OPEN_GAME_WORDS.points);
    if (this.openGameListed(who.customerId, occurrence.id)) throw new RuleError(OPEN_GAME_WORDS.twice, 409);
    return { game: game.key, size: game.sizes.length ? size : null, newPlayers: value?.newPlayers === true };
  },

  /** Whether a member has a game listed that night that's still on */
  openGameListed(customerId, occurrenceId) {
    return this.sql
      .exec(
        `SELECT o.id FROM open_games o JOIN bookings b ON b.id = o.booking_id
         WHERE o.occurrence_id = ? AND b.customer_id = ? AND b.status NOT IN ('cancelled', 'noshow') LIMIT 1`,
        String(occurrenceId), String(customerId),
      )
      .toArray().length > 0;
  },

  /** Whether a member is a named player in a game that night that's still on (someone else's booking) */
  openGamePlaying(customerId, occurrenceId) {
    return this.sql
      .exec(
        `SELECT p.id FROM booking_players p JOIN bookings b ON b.id = p.booking_id
         WHERE b.occurrence_id = ? AND p.customer_id = ? AND b.status NOT IN ('cancelled', 'noshow') LIMIT 1`,
        String(occurrenceId), String(customerId),
      )
      .toArray().length > 0;
  },

  /** A listed game saved with its booking; returns its public id */
  saveOpenGame(booking, looking, now) {
    const id = makeId('og');
    this.write(
      'INSERT INTO open_games (id, booking_id, occurrence_id, game, size, new_players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, booking.id, booking.occurrenceId, looking.game, looking.size, looking.newPlayers ? 1 : 0, now, now,
    );
    return id;
  },

  openGameById(id) {
    return this.sql.exec('SELECT * FROM open_games WHERE id = ?', String(id || '')).toArray()[0] || null;
  },

  openGameOf(bookingId) {
    return this.sql.exec('SELECT * FROM open_games WHERE booking_id = ?', String(bookingId || '')).toArray()[0] || null;
  },

  /** For cancelRule: a listed game nobody has joined yet (free to cancel until it starts) */
  openGameLooking(bookingId) {
    const row = bookingId ? this.openGameOf(bookingId) : null;
    return Boolean(row && !row.player_id);
  },

  /** The player who joined (their booking_players row, with their member record's name now), or null */
  openGamePlayer(row) {
    if (!row?.player_id) return null;
    return this.sql
      .exec(
        `SELECT p.*, m.name AS member_name, m.first_name AS member_first, m.code AS member_code
         FROM booking_players p LEFT JOIN members m ON m.customer_id = p.customer_id WHERE p.id = ?`,
        row.player_id,
      )
      .toArray()[0] || null;
  },

  /** The booker's name as members see it: their member record's, else the booking's */
  openGameBookerName(b) {
    const member = b?.customerId ? this.memberRow(b.customerId) : null;
    return trimmed(member?.first_name || member?.name || b?.name, 80);
  },

  /**
   * How an open game's two players name each other (they found each other on the list, so first names only, as the
   * list shows them): the booker's first name, and the player's (a booking_players row with its member's name). "A
   * player" when there's none: never round 11's member-code stand-in (playerName), since a code checks someone in.
   */
  openGameBookerFirst(b) {
    return firstName(this.openGameBookerName(b)) || OPEN_GAME_WORDS.player;
  },

  openGamePlayerName(p) {
    return firstName(trimmed(p?.member_name || p?.member_first || p?.name, 80)) || OPEN_GAME_WORDS.player;
  },

  /** { game, gameLabel, size, sizeLabel, newPlayers } */
  openGameWords(row) {
    return {
      game: row.game, gameLabel: gameOf(row.game)?.name || 'A game', size: row.size || null,
      sizeLabel: row.size ? OPEN_GAME_SIZES[row.size] || null : null, newPlayers: Boolean(row.new_players),
    };
  },

  /** On the booker's own booking (reserve's answer, My Lair): the game, whether it's on, and who joined (first name) */
  openGameOwnView(b) {
    const row = b?.occurrenceId ? this.openGameOf(b.id) : null;
    if (!row) return null;
    const p = this.openGamePlayer(row);
    return { id: row.id, ...this.openGameWords(row), status: p ? 'on' : 'looking', opponent: p ? this.openGamePlayerName(p) : null };
  },

  /** On the player's entry in My Lair (round 11's playerBookings): the game, and until when they can drop out online */
  openGamePlayerView(b, rules, now = Date.now()) {
    const row = b?.occurrenceId ? this.openGameOf(b.id) : null;
    if (!row) return null;
    const until = cancelUntil(b, rules);
    return { id: row.id, ...this.openGameWords(row), status: 'on', canLeave: b.status === 'confirmed' && now < until, leaveUntil: until };
  },

  /** A game as the list shows it to `viewer` (a customer id, or null when logged out) */
  openGameListView(row, b, viewer) {
    const p = this.openGamePlayer(row);
    const yours = viewer && String(b.customerId || '') === viewer ? 'booker' : viewer && p && String(p.customer_id || '') === viewer ? 'player' : null;
    return {
      id: row.id, ...this.openGameWords(row), tables: spotLabel(b.tables || []), start: b.start,
      player: viewer ? this.openGameBookerFirst(b) : OPEN_GAME_WORDS.player,
      status: p ? 'on' : 'looking',
      ...(yours ? { yours } : {}),
      ...(yours === 'booker' && p ? { opponent: this.openGamePlayerName(p) } : {}),
    };
  },

  /**
   * GET /open-games (?occurrence=<id> for one night): { choices, dates, discord }. dates: the next four weeks' game nights (at most
   * eight) with game tables, each { occurrenceId, title, start, end, spots: { total, free }, games }, games being its
   * listed games still looking (and, to its two players, one that's on). choices: the games and sizes a listing can be.
   */
  async openGamesList(url, who) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const viewer = who?.customerId ? String(who.customerId) : null;
    const wanted = trimmed(url.searchParams.get('occurrence'), 160);
    const hasPairs = (o) => o && o.end > now && parseSpots(o.gameTables, rules.rooms).length > 0;
    const nights = wanted
      ? [findOccurrence(rules, wanted)].filter(hasPairs)
      : eventOccurrences(rules, now, now + LIST_DAYS * 24 * HOUR).filter(hasPairs).sort((x, y) => x.start - y.start).slice(0, LIST_NIGHTS);
    const st = nights.length ? this.state(Math.min(...nights.map((o) => o.start)) - 1, Math.max(...nights.map((o) => o.end)) + 1) : null;
    const dates = nights.map((o) => {
      const rows = this.sql
        .exec(`SELECT o.* FROM open_games o JOIN bookings b ON b.id = o.booking_id WHERE o.occurrence_id = ? AND b.status = 'confirmed' ORDER BY o.created_at, o.rowid`, o.id)
        .toArray();
      const games = [];
      for (const row of rows) {
        const b = this.booking(row.booking_id);
        if (!b) continue;
        const view = this.openGameListView(row, b, viewer);
        // taken: only its two players still see it; looking: until joining closes
        if (view.status === 'on' ? !view.yours : now >= b.end - JOIN_CLOSES) continue;
        games.push(view);
      }
      return {
        occurrenceId: o.id, title: o.title, start: o.start, end: o.end,
        spots: { total: parseSpots(o.gameTables, rules.rooms).length, free: this.freeSpots(o, rules, st).length }, games,
      };
    });
    return {
      choices: OPEN_GAME_LIST.map((g) => ({ key: g.key, name: g.name, sizes: g.sizes.map((s) => ({ key: s, name: OPEN_GAME_SIZES[s] })) })),
      dates,
      // whether listed games go to Discord (its webhook is set), so the website only says so when they do
      discord: Boolean(this.openGameHook()),
    };
  },

  /**
   * POST /open-games/:id/join: the logged-in member joins as the opponent, first come. Errors, in this order: 401
   * loginJoin; 404 gone (no such game, or not on); 403 own; 409 taken; 409 closed (2 hours before the night ends); 409
   * listed (a game of their own that night); 409 already (in another game that night). → { game, booking } (the game as
   * the list shows it to them, and their My Lair entry).
   */
  async joinOpenGame(id, who) {
    const rules = await this.rules();
    // --- no awaits from here on: two people can't both get it ---
    const now = Date.now();
    if (!who?.customerId) throw new RuleError(OPEN_GAME_WORDS.loginJoin, 401);
    const me = String(who.customerId);
    const row = this.openGameById(trimmed(id, 60));
    const b = row ? this.booking(row.booking_id) : null;
    if (!row || !b || b.status !== 'confirmed') throw new RuleError(OPEN_GAME_WORDS.gone, 404);
    if (String(b.customerId || '') === me) throw new RuleError(OPEN_GAME_WORDS.own, 403);
    if (row.player_id) throw new RuleError(OPEN_GAME_WORDS.taken, 409);
    if (now >= b.end - JOIN_CLOSES) throw new RuleError(OPEN_GAME_WORDS.closed, 409);
    if (this.openGameListed(me, row.occurrence_id)) throw new RuleError(OPEN_GAME_WORDS.listed, 409);
    if (this.openGamePlaying(me, row.occurrence_id)) throw new RuleError(OPEN_GAME_WORDS.already, 409);
    const member = this.memberRow(me);
    const name = trimmed(member?.name || member?.first_name, 80);
    const email = [member?.email, member?.account_email].find(isEmail) || null;
    const unit = Math.round((b.amount || 0) / Math.max(1, b.people || 1));
    const playerId = makeId('bp');
    // invited_at: their email is the one below, so round 11's "has booked a game with you" never goes as well
    this.write(
      `INSERT INTO booking_players (id, booking_id, role, position, name, customer_id, email, code, invited_at, created_at)
       VALUES (?, ?, 'opponent', 1, ?, ?, ?, ?, ?, ?)`,
      playerId, b.id, name, me, email ? trimmed(email, 120) : null, member?.code || null, now, now,
    );
    b.people = 2;
    b.amount = unit * 2;
    b.split = true;
    // the booker may have paid their own $10 ahead: that's half the game now, so the player still pays theirs
    b.paid = settled(b);
    this.saveBooking(b, now);
    this.write('UPDATE open_games SET player_id = ?, joined_at = ?, updated_at = ? WHERE id = ? AND player_id IS NULL', playerId, now, now, row.id);
    // --- saved: the game is theirs ---
    const fresh = this.booking(b.id);
    const joined = this.openGameById(row.id);
    this.tellOpenGameJoined(fresh, joined, rules);
    this.later(this.syncOpenGamePost(row.id));
    return {
      game: this.openGameListView(joined, fresh, me),
      booking: this.playerBookings(me, now - 1, member, rules).find((x) => x.id === b.id) || null,
    };
  },

  /**
   * POST /open-games/:id/leave: the player who joined drops out, until refundHours before it starts. The game is the
   * booker's alone again ($10) and listed again, and the booker hears. Errors: 401 loginJoin; 404 notIn; 409
   * lockedLeave. → { left: true, game }.
   */
  async leaveOpenGame(id, who) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    if (!who?.customerId) throw new RuleError(OPEN_GAME_WORDS.loginJoin, 401);
    const me = String(who.customerId);
    const row = this.openGameById(trimmed(id, 60));
    const b = row ? this.booking(row.booking_id) : null;
    const p = row ? this.openGamePlayer(row) : null;
    if (!row || !b || !p || String(p.customer_id || '') !== me || b.status !== 'confirmed') throw new RuleError(OPEN_GAME_WORDS.notIn, 404);
    if (now >= cancelUntil(b, rules)) throw new RuleError(OPEN_GAME_WORDS.lockedLeave(rules.refundHours, firstName(this.openGameBookerName(b)) || 'the booker'), 409);
    // Paid their share at the counter ahead of time: it's money due back to them, for staff (as cancelOwnBooking), and
    // it stops counting toward the game (a payment of minus that much, order_id 'refund', as round 21's), so the booker
    // still pays their own and every later sum (paidSoFar) goes by what's paid toward it, net
    const paid = this.sql.exec('SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE booking_id = ? AND customer_id = ?', b.id, me).one().n;
    const unit = Math.round((b.amount || 0) / Math.max(1, b.people || 1));
    this.write('DELETE FROM booking_players WHERE id = ?', p.id);
    if (paid > 0) {
      this.write(
        "INSERT INTO payments (id, booking_id, kind, order_id, line_id, amount, customer_id, at) VALUES (?, ?, 'booking', 'refund', ?, ?, ?, ?)",
        makeId('pm'), b.id, `left:${p.id}`, -paid, me, now,
      );
      b.paidAmount = Math.max(0, (b.paidAmount || 0) - paid);
    }
    b.people = 1;
    b.amount = unit;
    b.split = false;
    b.paid = settled(b);
    this.saveBooking(b, now);
    this.write('UPDATE open_games SET player_id = NULL, joined_at = NULL, nudged_at = NULL, updated_at = ? WHERE id = ?', now, row.id);
    // --- saved ---
    if (paid > 0) {
      this.notifyStaff(`Refund due: ${b.ref}`, {
        title: 'Refund due',
        intro: `${this.playerName(p)} dropped out of ${b.name}'s open game in time, and had paid ${money(paid)} toward it at the counter already. Refund it (or put it on their store credit).`,
        details: [['Booking', b.ref], ['Was for', this.when(b, rules)], ['Refund', money(paid)]],
      });
    }
    // The booker had paid more than their game costs now (paid for both of them, say): the rest is theirs to have back
    const over = Math.max(0, (b.paidAmount || 0) - Math.max(0, (b.amount || 0) - (b.covered || 0)));
    if (over > 0) {
      this.notifyStaff(`Refund due: ${b.ref}`, {
        title: 'Refund due',
        intro: `${this.playerName(p)} dropped out of ${b.name}'s open game in time, and ${b.name} had paid ${money(b.paidAmount)} toward it, ${money(over)} more than their own game costs now. Refund ${b.name} the ${money(over)} (or put it on their store credit).`,
        details: [['Booking', b.ref], ['Was for', this.when(b, rules)], ['Refund', money(over)]],
      });
    }
    const fresh = this.booking(b.id);
    this.tellOpenGameLeft(fresh, row, p, rules);
    this.later(this.syncOpenGamePost(row.id));
    return { left: true, game: this.openGameListView(this.openGameById(row.id), fresh, me) };
  },

  /** After the booker cancels (cancelOwnBooking): the player who'd joined hears it's off, and its Discord post goes */
  openGameCancelled(booking, rules, now) {
    const row = booking?.occurrenceId ? this.openGameOf(booking.id) : null;
    if (!row) return;
    const p = this.openGamePlayer(row);
    if (p) this.tellOpenGameOff(booking, row, p, rules);
    this.write('UPDATE open_games SET updated_at = ? WHERE id = ?', now, row.id);
    this.later(this.syncOpenGamePost(row.id));
  },

  /** The game in words for emails: "Warhammer 40,000, 1,000 points, new players welcome" */
  openGameLine(row) {
    const w = this.openGameWords(row);
    return [w.gameLabel, w.sizeLabel, w.newPlayers ? 'new players welcome' : null].filter(Boolean).join(', ');
  },

  /** For confirm (round 11's gameEmailParts): a listed game's lines in the booker's confirmation */
  openGameEmailParts(row) {
    return {
      people: GAME_SIZES[2],
      details: [['Game', this.openGameLine(row)], ['Opponent', "Gobgob's finding you one"]],
      fee: null,
      // Discord only while its webhook is set (openGameHook), so the email never promises a post that can't happen
      note: this.openGameHook()
        ? "Your game's on our website for members, and on our Discord without your name. When someone joins, you both get an email."
        : "Your game's on our website for members. When someone joins, you both get an email.",
    };
  },

  /** The booker hears who's joined; the player gets their own confirmation (with until when they can drop out) */
  tellOpenGameJoined(b, row, rules) {
    if (!emailReady(this.env)) return;
    const p = this.openGamePlayer(row);
    if (!p) return;
    const event = findOccurrence(rules, b.occurrenceId);
    const title = event?.title || 'the game night';
    const when = this.when(b, rules);
    const booker = firstName(this.openGameBookerName(b)) || 'there';
    const player = this.openGamePlayerName(p);
    const hello = player === OPEN_GAME_WORDS.player ? 'there' : player;
    const unit = Math.round((b.amount || 0) / Math.max(1, b.people || 1));
    const where = `Tables ${spotLabel(b.tables || [])}`;
    const game = this.openGameLine(row);
    const bookerLines = this.tabLines(b, rules, { spot: 'game table' });
    if (isEmail(b.email)) {
      this.later(this.mail(this.letter(b.email, `Game on: ${player} has joined your game, ${when}`, {
        title: 'Game on!',
        intro: `Kia ora ${booker}, ${player} has joined your game at ${title}. Gobgob's saved your tables.`,
        details: [['Event', title], ['When', when], ['Where', where], ['Game', game], ['Playing', `You against ${player}`], ['Fee', unit ? `${money(unit)} a person, paid at the counter. Each player pays their own.` : '']],
        outro: [bookerLines[1]],
        button: { label: 'See it in My Lair', url: this.page('myLair') },
      })));
    }
    if (isEmail(p.email)) {
      const until = cancelUntil(b, rules);
      const label = new LairTime(rules.tz).label(until);
      this.later(this.mail(this.letter(p.email, `You're in: ${title} with ${booker}, ${when}`, {
        title: "You're in!",
        intro: `Kia ora ${hello}, you've joined ${booker}'s game at ${title}, at the Dice Goblin Lair. Gobgob's saved your tables.`,
        details: [['Event', title], ['When', when], ['Where', where], ['Game', game], ['Playing', `You against ${booker}`], ['Fee', unit ? `${money(unit)}, your own share, paid at the counter on the night` : '']],
        outro: [
          `Show your Goblin card from My Lair at the counter when you arrive (or give ${booker}'s name): it finds the game.`,
          Date.now() < until
            ? `Can't make it? Drop out in My Lair by ${label} (${rules.refundHours} hours before), so ${booker} can find someone else.`
            : `Can't make it? Let ${booker} know, or give us a call.`,
        ],
        button: { label: 'See it in My Lair', url: this.page('myLair') },
      })));
    }
  },

  /** The booker hears the player dropped out, and that the game's listed again */
  tellOpenGameLeft(b, row, p, rules) {
    if (!emailReady(this.env) || !isEmail(b.email)) return;
    const event = findOccurrence(rules, b.occurrenceId);
    const title = event?.title || 'the game night';
    const when = this.when(b, rules);
    const booker = firstName(this.openGameBookerName(b)) || 'there';
    const player = this.openGamePlayerName(p);
    this.later(this.mail(this.letter(b.email, `${player} can't make it: your game's listed again`, {
      title: 'Your game is listed again',
      intro: `Kia ora ${booker}, ${player} has dropped out of your game at ${title}. Gobgob's listed it again, so someone else can join.`,
      details: [['Event', title], ['When', when], ['Where', `Tables ${spotLabel(b.tables || [])}`], ['Game', this.openGameLine(row)]],
      outro: [this.tabLines(b, rules, { spot: 'game table' })[1]],
      button: { label: 'See it in My Lair', url: this.page('myLair') },
    })));
  },

  /** The player hears the booker has called it off */
  tellOpenGameOff(b, row, p, rules) {
    if (!emailReady(this.env) || !isEmail(p.email)) return;
    const event = findOccurrence(rules, b.occurrenceId);
    const title = event?.title || 'the game night';
    const when = this.when(b, rules);
    const booker = firstName(this.openGameBookerName(b)) || 'The booker';
    const hello = this.openGamePlayerName(p);
    const player = hello === OPEN_GAME_WORDS.player ? 'there' : hello;
    this.later(this.mail(this.letter(p.email, `Called off: ${booker}'s game, ${when}`, {
      title: 'That game is off',
      intro: `Kia ora ${player}, ${booker} has cancelled the game you'd joined at ${title}, so it's off. There's nothing to pay for it.`,
      details: [['Event', title], ['When', when], ['Game', this.openGameLine(row)]],
      outro: ['Other players might be looking for a game that night: see who on Find a game.'],
      button: { label: 'Find a game', url: this.page('wargames') },
    })));
  },

  /**
   * The 10-minute run's part (and POST /internal/open-games { at }, the live checks' clock): the afternoon emails, then
   * the Discord posts that aren't right yet. → { nudged, posted }.
   */
  async openGamesAt(at) {
    const rules = await this.rules();
    const now = Number(at) || Date.now();
    const nudged = this.nudgeOpenGames(rules, now);
    const posted = await this.syncOpenGamePosts(now);
    return { nudged, posted };
  },

  /**
   * From 2pm on the day, once: the booker of a game nobody has joined, listed before 2pm that day (or earlier), is asked
   * if they're still coming. No awaits.
   */
  nudgeOpenGames(rules, now) {
    if (!emailReady(this.env)) return 0;
    const time = new LairTime(rules.tz);
    if (time.minutesOf(now) < NUDGE_FROM) return 0;
    const rows = this.sql
      .exec(
        `SELECT o.* FROM open_games o JOIN bookings b ON b.id = o.booking_id
         WHERE o.player_id IS NULL AND o.nudged_at IS NULL AND b.status = 'confirmed' AND b.starts_at > ? AND b.starts_at < ?`,
        now, now + 24 * HOUR,
      )
      .toArray();
    let sent = 0;
    for (const row of rows) {
      const b = this.booking(row.booking_id);
      if (!b || !isEmail(b.email) || time.key(b.start) !== time.key(now)) continue;
      // listed from 2pm on the day: they've only just said they're coming
      if (time.key(row.created_at) === time.key(now) && time.minutesOf(row.created_at) >= NUDGE_FROM) continue;
      const event = findOccurrence(rules, b.occurrenceId);
      const title = event?.title || 'the game night';
      const booker = firstName(this.openGameBookerName(b)) || 'there';
      const starts = clockWords(b.start, rules.tz);
      this.later(this.mail(this.letter(b.email, `Nobody's joined your game yet: ${title} tonight`, {
        title: 'Still coming tonight?',
        intro: `Kia ora ${booker}, nobody's joined your game at ${title} tonight yet.`,
        details: [['When', this.when(b, rules)], ['Where', `Tables ${spotLabel(b.tables || [])}`], ['Game', this.openGameLine(row)]],
        outro: [
          "Still keen? Your tables are saved: play whoever walks in on the night, or paint at the painting station, free with your own paints.",
          `Not coming after all? Cancel free in My Lair before ${starts}, so the tables go to someone else.`,
        ],
        button: { label: 'See it in My Lair', url: this.page('myLair') },
      })));
      this.write('UPDATE open_games SET nudged_at = ? WHERE id = ? AND nudged_at IS NULL', now, row.id);
      sent += 1;
    }
    return sent;
  },

  /** The webhook's address when it's set and looks like one, else '' */
  openGameHook() {
    const hook = String(this.env?.DISCORD_WARHAMMER_WEBHOOK || '').trim();
    return HOOK.test(hook) ? hook : '';
  },

  /** What a game's post should say now: 'open', 'taken', or 'gone' (cancelled, or the night's over) */
  openGamePostWanted(row, b, now) {
    if (!b || b.status !== 'confirmed' || b.end <= now) return 'gone';
    return row.player_id ? 'taken' : 'open';
  },

  /** A post's words: never a name, an email or the tables */
  openGamePostText(row, b, rules, state) {
    const g = gameOf(row.game) || OPEN_GAME_LIST[OPEN_GAME_LIST.length - 1];
    const day = dayWords(b.start, rules.tz);
    if (state === 'taken') return `Game on! ${g.the} on ${day} has its opponent. Looking for a game too? ${this.page('wargames')}`;
    const w = this.openGameWords(row);
    const bits = [w.sizeLabel, w.newPlayers ? 'new players are welcome' : null].filter(Boolean);
    const more = bits.length === 2 ? ` ${bits[0]}, and ${bits[1]}.` : bits.length ? ` ${bits[0][0].toUpperCase()}${bits[0].slice(1)}.` : '';
    return `${g.who} is looking for a game on ${day}, from ${clockWords(b.start, rules.tz)}.${more}\nJoin them: ${this.page('wargames')}`;
  },

  /**
   * Make one game's Discord post say what it should (openGamePostWanted): post it (and keep its id), edit it, or delete
   * it. Nothing without the webhook. A game taken or called off before it was ever posted isn't posted. Returns whether
   * Discord changed; a failure is logged and the 10-minute run tries again.
   */
  async syncOpenGamePost(id, now = Date.now()) {
    const hook = this.openGameHook();
    if (!hook) return false;
    const rules = await this.rules();
    const row = this.openGameById(id);
    if (!row) return false;
    const b = this.booking(row.booking_id);
    const want = this.openGamePostWanted(row, b, now);
    if ((row.post_state || null) === want) return false;
    if (!row.post_id && want !== 'open') {
      this.write('UPDATE open_games SET post_state = ? WHERE id = ?', want === 'gone' ? 'gone' : null, id);
      return false;
    }
    this.write('UPDATE open_games SET post_tried_at = ? WHERE id = ?', now, id);
    const headers = { 'Content-Type': 'application/json' };
    try {
      if (!row.post_id) {
        const res = await fetch(`${hook}?wait=true`, {
          method: 'POST', headers, body: JSON.stringify({ content: this.openGamePostText(row, b, rules, 'open'), allowed_mentions: { parse: [] } }),
        });
        if (!res.ok) throw new Error(`Discord answered ${res.status}`);
        const data = await res.json().catch(() => ({}));
        if (!data?.id) throw new Error('Discord sent no message id');
        this.write('UPDATE open_games SET post_id = ?, post_state = ? WHERE id = ?', String(data.id), 'open', id);
        // joined or called off while it went up: put that right too
        const after = this.openGameById(id);
        if (this.openGamePostWanted(after, this.booking(after.booking_id), Date.now()) !== 'open') await this.syncOpenGamePost(id);
        return true;
      }
      const message = `${hook}/messages/${encodeURIComponent(row.post_id)}`;
      if (want === 'gone') {
        const res = await fetch(message, { method: 'DELETE' });
        if (!res.ok && res.status !== 404) throw new Error(`Discord answered ${res.status}`);
      } else {
        const res = await fetch(message, {
          method: 'PATCH', headers, body: JSON.stringify({ content: this.openGamePostText(row, b, rules, want), allowed_mentions: { parse: [] } }),
        });
        if (!res.ok) throw new Error(`Discord answered ${res.status}`);
      }
      this.write('UPDATE open_games SET post_state = ? WHERE id = ?', want, id);
      return true;
    } catch (error) {
      console.error(JSON.stringify({ message: 'Lair: an open game\'s Discord post failed', id, want, error: String(error?.message || error) }));
      return false;
    }
  },

  /** The 10-minute run: every game whose post isn't right yet (a failed try, or a night that's over), a few at a time */
  async syncOpenGamePosts(now) {
    if (!this.openGameHook()) return 0;
    const rows = this.sql
      .exec(
        `SELECT o.*, b.status AS b_status, b.ends_at AS b_end FROM open_games o JOIN bookings b ON b.id = o.booking_id
         WHERE (b.ends_at > ? AND b.status = 'confirmed') OR (o.post_id IS NOT NULL AND COALESCE(o.post_state, '') != 'gone')
         ORDER BY o.created_at`,
        now,
      )
      .toArray();
    let changed = 0;
    let tried = 0;
    for (const row of rows) {
      const want = row.b_status !== 'confirmed' || row.b_end <= now ? 'gone' : row.player_id ? 'taken' : 'open';
      if ((row.post_state || null) === want || (!row.post_id && want !== 'open')) continue;
      if (tried >= POSTS_A_RUN) break;
      tried += 1;
      if (await this.syncOpenGamePost(row.id, now)) changed += 1;
    }
    return changed;
  },
};

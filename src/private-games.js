/**
 * Private games (17 Oct 2026, contract v18-private). Mo: "I want my gms to be able to have a private game, and it
 * becomes an invite only game. But they can toggle a register interest button if they want otherwise it is locked to
 * the public." He picked: a private game still shows on the TTRPG sessions page, as Private, invite only, with no way to
 * join; and the GM shares an invite link.
 *
 *  - games.private (1: invite only), games.interest_open (1: a private game takes "Register interest") and
 *    games.invite_key (the invite link's key, one for a whole series). A series' details keep private, interestOpen and
 *    inviteKey, so sessions made later follow them.
 *  - Booking a seat (POST /bookings, gm-seat) or saving a seat every week (join-series) in a private game needs its
 *    invite key (`invite`), except for staff with GM games and the game's own GM. A regular who's in already doesn't.
 *  - The game's GM (a series: the series' GM) and staff with GM games make it private or not and switch "Register
 *    interest" on or off (POST /games/:id/private), and make a new link (POST /games/:id/invite/new: the old one stops).
 *  - GET /games/invite/:key: the game a link is for (its next session that hasn't ended), for anyone with the link.
 *  - Register interest on a private game only while it's on; the GM's email then carries their invite link.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair:
 * every await first, then synchronous reads, checks and writes.
 */
import { RuleError } from './core.js';
import { safeEqual } from './shopify.js';

/** Every message a GM, player or staff member sees, word for word in the contract */
export const PRIVATE_WORDS = {
  invite: 'This game is invite only. Ask the GM for the invite link.',
  badInvite: "That invite link doesn't work any more. Ask the GM for a new one.",
  noInterest: "This game is invite only, and the GM isn't taking interest right now. Ask them for the invite link.",
  private: 'private is true or false.',
  interest: 'interest is true or false.',
  notYours: 'Only the GM of this game, or staff with GM games, can change who can join it.',
  login: 'Log in to do that.',
  notPrivate: "This game isn't private, so it has no invite link. Make it private first.",
};

/** The columns (made on start when missing, as ROUND18_COLUMNS) and the index for finding a game by its link */
export const PRIVATE_COLUMNS = [
  ['games', 'private', 'INTEGER NOT NULL DEFAULT 0'], ['games', 'interest_open', 'INTEGER NOT NULL DEFAULT 0'], ['games', 'invite_key', 'TEXT'],
];
export const PRIVATE_INDEXES = ['CREATE INDEX IF NOT EXISTS games_invite ON games (invite_key)'];

/** Letters for invite keys: no look-alikes (no i, l, o, 0 or 1) */
const KEY_LETTERS = 'abcdefghjkmnpqrstuvwxyz23456789';
const KEY_LENGTH = 20;
const KEY_SHAPE = /^[a-z0-9]{12,40}$/;

/** A new invite key: 20 letters from crypto.getRandomValues (about 99 bits), never Math.random */
export function newInviteKey() {
  let out = '';
  while (out.length < KEY_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      // 248 is the largest multiple of 31 under 256: every letter equally likely
      if (byte < 248 && out.length < KEY_LENGTH) out += KEY_LETTERS[byte % KEY_LETTERS.length];
    }
  }
  return out;
}

/** A new game's privacy from POST /games: { private, interestOpen, inviteKey } (a private one gets a key) */
export function privacyOf(input) {
  const on = input?.private === true;
  return { private: on, interestOpen: on && input?.interest === true, inviteKey: on ? newInviteKey() : null };
}

const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

export const privateMethods = {
  /** The invite link for a key: the TTRPG sessions page with ?invite= */
  inviteUrl(key) {
    return key ? `${this.page('gm')}?invite=${encodeURIComponent(key)}` : null;
  },

  /** { key, url } for whoever can see a private game's link (its GM and staff), else nothing */
  inviteFor(game, who, staffView = false) {
    if (!game?.private || !game.inviteKey) return null;
    const own = Boolean(who?.customerId) && String(game.gmCustomerId || '') === String(who.customerId);
    return staffView || own || this.can(who, 'sessions') ? { key: game.inviteKey, url: this.inviteUrl(game.inviteKey) } : null;
  },

  /** A series' kept details. No awaits. */
  seriesKept(seriesId) {
    const row = seriesId ? this.sql.exec('SELECT details FROM series WHERE id = ?', seriesId).toArray()[0] : null;
    return parse(row?.details, {}) || {};
  },

  /** Whether who can change who can join: staff with GM games, the session's GM, or (a series) the series' GM. No awaits. */
  canSetPrivate(who, game, scope) {
    if (this.can(who, 'sessions')) return true;
    if (!who?.customerId) return false;
    if (scope === 'series' && game.seriesId) return this.runsSeries(who, game.seriesId);
    return String(game.gmCustomerId || '') === String(who.customerId);
  },

  /**
   * A seat in a private game needs its invite key (input.invite), except for staff with GM games and the game's own GM.
   * Throws 403 invite. No awaits.
   */
  checkInvite(game, input, who) {
    if (!game?.private) return;
    if (this.can(who, 'sessions')) return;
    if (who?.customerId && String(game.gmCustomerId || '') === String(who.customerId)) return;
    const key = String(input?.invite ?? '').trim().toLowerCase();
    if (!KEY_SHAPE.test(key) || !game.inviteKey || !safeEqual(key, game.inviteKey)) throw new RuleError(PRIVATE_WORDS.invite, 403);
  },

  /** A game as its GM or staff see it after a change: the board's view, with invite: { key, url } */
  privateView(game, rules, who) {
    const st = this.state(game.start - 1, game.end + 1);
    const view = this.gameView(game, st, rules, null, { staff: this.staffSees(who) });
    const invite = this.inviteFor(game, who);
    return invite ? { ...view, invite } : view;
  },

  /**
   * POST /games/:id/private { private, interest?, scope? }: invite only, or not; and whether a private game takes
   * "Register interest" (left out: as it was). scope 'series' (the default for a session of a series): this session and
   * every later one the caller runs, and sessions made later; 'session': this one. A private game gets an invite key
   * when it has none (a series shares one), and keeps it when it's made public again, so the same link works if it's
   * made private again. → { game (with invite), sessions }
   */
  async setGamePrivate(id, input, who) {
    if (!who.customerId && !who.staff) throw new RuleError(PRIVATE_WORDS.login, 401);
    if (typeof input?.private !== 'boolean') throw new RuleError(PRIVATE_WORDS.private, 422);
    if (input.interest !== undefined && typeof input.interest !== 'boolean') throw new RuleError(PRIVATE_WORDS.interest, 422);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    if (game.status === 'cancelled') throw new RuleError('That game was cancelled.', 409);
    const scope = input.scope || (game.seriesId ? 'series' : 'session');
    const sessions = this.sessionsFor(game, scope, who);
    if (!this.canSetPrivate(who, game, scope)) throw new RuleError(PRIVATE_WORDS.notYours, 403);
    const kept = game.seriesId ? this.seriesKept(game.seriesId) : {};
    const key = game.inviteKey || kept.inviteKey || (input.private ? newInviteKey() : null);
    const interest = input.private && Boolean(input.interest ?? game.interestOpen);
    for (const s of sessions) {
      this.write(
        'UPDATE games SET private = ?, interest_open = ?, invite_key = COALESCE(invite_key, ?), updated_at = ? WHERE id = ?',
        input.private ? 1 : 0, interest ? 1 : 0, key, now, s.id,
      );
    }
    if (scope === 'series' && game.seriesId) this.patchSeries(game.seriesId, { private: input.private, interestOpen: interest, ...(key ? { inviteKey: key } : {}) }, now);
    return { game: this.privateView(this.game(game.id), rules, who), sessions: sessions.length };
  },

  /**
   * POST /games/:id/invite/new: a new invite link for a private game (a series: every session that had the old key, and
   * sessions made later). The old link stops working; seats booked with it stay. → { game (with invite), sessions }
   */
  async newInviteLink(id, who) {
    if (!who.customerId && !who.staff) throw new RuleError(PRIVATE_WORDS.login, 401);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    if (game.status === 'cancelled') throw new RuleError('That game was cancelled.', 409);
    if (!this.canSetPrivate(who, game, game.seriesId ? 'series' : 'session')) throw new RuleError(PRIVATE_WORDS.notYours, 403);
    if (!game.private) throw new RuleError(PRIVATE_WORDS.notPrivate, 409);
    const key = newInviteKey();
    const old = game.inviteKey;
    const changed = old ? this.sql.exec('SELECT COUNT(*) AS n FROM games WHERE invite_key = ?', old).toArray()[0]?.n || 0 : 0;
    if (old) this.write('UPDATE games SET invite_key = ?, updated_at = ? WHERE invite_key = ?', key, now, old);
    this.write('UPDATE games SET invite_key = ?, updated_at = ? WHERE id = ?', key, now, game.id);
    if (game.seriesId) this.patchSeries(game.seriesId, { inviteKey: key }, now);
    return { game: this.privateView(this.game(game.id), rules, who), sessions: Math.max(1, changed) };
  },

  /**
   * GET /games/invite/:key (anyone with the link): the private game it's for, as the board shows it, with invited: true:
   * its next session that hasn't ended, open or full. → { game }, or 404 badInvite (an old link, or nothing to come).
   */
  async gameByInvite(key, who) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const k = String(key ?? '').trim().toLowerCase();
    if (!KEY_SHAPE.test(k)) throw new RuleError(PRIVATE_WORDS.badInvite, 404);
    const row = this.sql
      .exec("SELECT * FROM games WHERE invite_key = ? AND private = 1 AND status IN ('open', 'full') AND ends_at > ? ORDER BY starts_at, id LIMIT 1", k, now)
      .toArray()[0];
    if (!row || !safeEqual(k, String(row.invite_key || ''))) throw new RuleError(PRIVATE_WORDS.badInvite, 404);
    const game = this.rowToGame(row);
    const st = this.state(game.start - 1, game.end + 1);
    return { game: { ...this.gameView(game, st, rules, null, { staff: this.staffSees(who) }), invited: true } };
  },
};

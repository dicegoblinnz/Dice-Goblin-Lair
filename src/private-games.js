/**
 * Private games (17 Oct 2026, contract v18-private). Mo: "I want my gms to be able to have a private game, and it
 * becomes an invite only game. But they can toggle a register interest button if they want otherwise it is locked to
 * the public." He picked: a private game still shows on the TTRPG sessions page, as Private, invite only, with no way to
 * join; and the GM shares an invite link.
 *
 *  - games.private (1: invite only), games.interest_open (1: a private game takes "Register interest") and
 *    games.invite_key (the invite link's key: one for a whole series). Privacy belongs to the whole game: a series is
 *    private or not in every session, and its details keep private, interestOpen and inviteKey, so sessions made later
 *    follow them.
 *  - Booking a seat (POST /bookings, gm-seat) or saving a seat every week (join-series) in a private game needs its
 *    invite key (`invite`), except for staff with GM games, the game's own GM (a series: its GM now) and the game's
 *    regulars (who are in already).
 *  - The game's GM (a series: its GM now) and staff with GM games make it private or not and switch "Register interest"
 *    on or off (POST /games/:id/private), and make a new link (POST /games/:id/invite/new: the old one stops).
 *  - GET /games/invite/:key: the game a link is for (its next session that hasn't ended), for anyone with the link.
 *  - Register interest on a private game only while it's on. The GM's email about them says to send their invite link
 *    from their game: never the link itself, so a reply (that quotes it) to someone they turn down can't pass it on.
 *  - The link is the TTRPG sessions page with #invite=<key>: after the #, so it's never sent to a server or in a
 *    Referer.
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
  notYet: "That game isn't on the board yet: a staff goblin checks new games first. Try the link again soon.",
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
  /** The invite link for a key: the TTRPG sessions page with #invite= (never sent to a server, or in a Referer) */
  inviteUrl(key) {
    return key ? `${this.page('gm')}#invite=${encodeURIComponent(key)}` : null;
  },

  /** { key, url } for whoever can see a private game's link (its GM, and staff with GM games), else nothing */
  inviteFor(game, who) {
    if (!game?.private || !game.inviteKey) return null;
    const own = Boolean(who?.customerId) && String(game.gmCustomerId || '') === String(who.customerId);
    return own || this.can(who, 'sessions') ? { key: game.inviteKey, url: this.inviteUrl(game.inviteKey) } : null;
  },

  /** A series' kept details. No awaits. */
  seriesKept(seriesId) {
    const row = seriesId ? this.sql.exec('SELECT details FROM series WHERE id = ?', seriesId).toArray()[0] : null;
    return parse(row?.details, {}) || {};
  },

  /**
   * Whether a game is private, and the keys that open it: a series is private when its kept details say so or any
   * session of it to come is (normally both, with the one key). No awaits.
   */
  privacyOfGame(game, now = Date.now()) {
    if (!game) return { private: false, keys: [] };
    if (!game.seriesId) return { private: Boolean(game.private), keys: game.private && game.inviteKey ? [game.inviteKey] : [] };
    const kept = this.seriesKept(game.seriesId);
    const rows = this.sql
      .exec("SELECT invite_key FROM games WHERE series_id = ? AND private = 1 AND status != 'cancelled' AND ends_at > ?", game.seriesId, now)
      .toArray();
    const keys = [kept.private ? kept.inviteKey : null, game.private ? game.inviteKey : null, ...rows.map((r) => r.invite_key)].filter(Boolean);
    return { private: Boolean(kept.private) || Boolean(game.private) || rows.length > 0, keys: [...new Set(keys)] };
  },

  /** Whether who can change who can join: staff with GM games, a series' GM now, or a one-off's GM. No awaits. */
  canSetPrivate(who, game) {
    if (this.can(who, 'sessions')) return true;
    if (!who?.customerId) return false;
    if (game.seriesId) return this.runsSeries(who, game.seriesId);
    return String(game.gmCustomerId || '') === String(who.customerId);
  },

  /**
   * A seat in a private game needs its invite key (input.invite), except for staff with GM games, the game's own GM (a
   * series: its GM now) and its regulars (in already). Throws 403 invite. No awaits.
   */
  checkInvite(game, input, who) {
    const privacy = this.privacyOfGame(game);
    if (!privacy.private) return;
    if (this.can(who, 'sessions')) return;
    if (who?.customerId) {
      if (String(game.gmCustomerId || '') === String(who.customerId)) return;
      if (game.seriesId && (this.runsSeries(who, game.seriesId) || this.seriesMember(game.seriesId, who.customerId)?.status === 'active')) return;
    }
    const key = String(input?.invite ?? '').trim().toLowerCase();
    if (!KEY_SHAPE.test(key) || !privacy.keys.some((k) => safeEqual(key, String(k)))) throw new RuleError(PRIVATE_WORDS.invite, 403);
  },

  /** A game as its GM or staff see it after a change: the board's view, with invite: { key, url } */
  privateView(game, rules, who) {
    const st = this.state(game.start - 1, game.end + 1);
    const view = this.gameView(game, st, rules, null, { staff: this.staffSees(who) });
    const invite = this.inviteFor(game, who);
    return invite ? { ...view, invite } : view;
  },

  /** Every session of a game: a series' (but cancelled ones), or the one-off. No awaits. */
  wholeGame(game) {
    if (!game.seriesId) return [game];
    return this.sql
      .exec("SELECT * FROM games WHERE series_id = ? AND status != 'cancelled' ORDER BY starts_at", game.seriesId)
      .toArray()
      .map((r) => this.rowToGame(r));
  },

  /**
   * POST /games/:id/private { private, interest? }: invite only, or not; and whether a private game takes "Register
   * interest" (left out: as it was). It's the whole game's: a series' every session, and sessions made later. A private
   * game gets an invite key when it has none (a series: the one key for every session), and keeps it when it's made
   * public again, so the same link works if it's made private again. → { game (with invite), sessions (to come) }
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
    if (!this.canSetPrivate(who, game)) throw new RuleError(PRIVATE_WORDS.notYours, 403);
    const sessions = this.wholeGame(game);
    const kept = game.seriesId ? this.seriesKept(game.seriesId) : {};
    const key = kept.inviteKey || game.inviteKey || sessions.map((s) => s.inviteKey).find(Boolean) || (input.private ? newInviteKey() : null);
    const interest = input.private && Boolean(input.interest ?? game.interestOpen);
    if (game.seriesId) {
      this.write('UPDATE games SET private = ?, interest_open = ?, invite_key = ?, updated_at = ? WHERE series_id = ? AND status != \'cancelled\'',
        input.private ? 1 : 0, interest ? 1 : 0, key, now, game.seriesId);
      this.patchSeries(game.seriesId, { private: input.private, interestOpen: interest, ...(key ? { inviteKey: key } : {}) }, now);
    } else {
      this.write('UPDATE games SET private = ?, interest_open = ?, invite_key = ?, updated_at = ? WHERE id = ?', input.private ? 1 : 0, interest ? 1 : 0, key, now, game.id);
    }
    return { game: this.privateView(this.game(game.id), rules, who), sessions: sessions.filter((s) => s.end > now).length };
  },

  /**
   * POST /games/:id/invite/new: a new invite link for a private game (a series: every session, and sessions made
   * later). The old link stops working; seats booked with it stay. → { game (with invite), sessions (to come) }
   */
  async newInviteLink(id, who) {
    if (!who.customerId && !who.staff) throw new RuleError(PRIVATE_WORDS.login, 401);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    if (game.status === 'cancelled') throw new RuleError('That game was cancelled.', 409);
    if (!this.canSetPrivate(who, game)) throw new RuleError(PRIVATE_WORDS.notYours, 403);
    if (!this.privacyOfGame(game, now).private) throw new RuleError(PRIVATE_WORDS.notPrivate, 409);
    const key = newInviteKey();
    if (game.seriesId) {
      this.write('UPDATE games SET invite_key = ?, updated_at = ? WHERE series_id = ?', key, now, game.seriesId);
      this.patchSeries(game.seriesId, { inviteKey: key }, now);
    } else {
      this.write('UPDATE games SET invite_key = ?, updated_at = ? WHERE id = ?', key, now, game.id);
    }
    return { game: this.privateView(this.game(game.id), rules, who), sessions: this.wholeGame(game).filter((s) => s.end > now).length };
  },

  /**
   * GET /games/invite/:key (anyone with the link): the game it's for (its next session that hasn't ended, open or
   * full), as the board shows it: invited: true while it's private (one made public again is just the game). One still
   * waiting for staff to check it: 409 notYet. An old link, or nothing to come: 404 badInvite.
   */
  async gameByInvite(key, who) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const k = String(key ?? '').trim().toLowerCase();
    if (!KEY_SHAPE.test(k)) throw new RuleError(PRIVATE_WORDS.badInvite, 404);
    const row = this.sql
      .exec("SELECT * FROM games WHERE invite_key = ? AND status IN ('open', 'full', 'pending') AND ends_at > ? ORDER BY starts_at, id LIMIT 1", k, now)
      .toArray()[0];
    if (!row || !safeEqual(k, String(row.invite_key || ''))) throw new RuleError(PRIVATE_WORDS.badInvite, 404);
    if (row.status === 'pending') throw new RuleError(PRIVATE_WORDS.notYet, 409);
    const game = this.rowToGame(row);
    const st = this.state(game.start - 1, game.end + 1);
    const view = this.gameView(game, st, rules, null, { staff: this.staffSees(who) });
    return { game: game.private ? { ...view, invited: true } : view };
  },
};

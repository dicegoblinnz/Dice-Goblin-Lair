/**
 * Round 37 (14 Nov 2026, contract v37-gm-perk): the GM perk, the staff slot and a game's books. From Mo, 14 Nov 2026:
 *  - "I want a special tag that staff [can] give to certain customers who are gms, and given to the customers that sign
 *    up to run roleplaying games. As a perk they get the option to get one library copy of any RPG books, only one copy
 *    per person. And it is free as a perk of being a gm."
 *  - "when gms set up [to] run games they should ask for a copy of the game to be soft reserved for [their] game [...]
 *    this does not stop someone from taking a game but will be notified that there are games that want this game on such
 *    and such date. And it is implied that it would be good for them to bring the book back on that date nothing forced
 *    but we might send a nudge if a week or two passed and the book is not back."
 *  - "give any customer access to it when they sign up to a game and start running one. But after 3 games consecutively
 *    that have not been filled it will disable the perk. Staff can give permission directly and take it away as well.
 *    The three weeks no game remove perk function still applies to staff giving to customers the tag etc."
 *  - "Also give all staff the perk of adding any library game from dice goblin as a perk not just RPG books. One slot
 *    only."
 * And his answers the same morning: a session is filled with at least 1 player; the perk switches off both ways (3
 * unfilled sessions in a row, or 3 weeks with no session run and none coming up); a new GM gets it when their game is
 * listed.
 *
 * The GM perk. A record per customer (gm_perks): on, or off with a reason. It goes on by itself the first time someone
 * is the GM of a session on the board (gmPerkListed: listing, approval, a game joining their account, and the 10-minute
 * run for games from before), and when staff give it. It rests by itself (off: 'quiet' after GM_PERK.quiet sessions in a
 * row nobody played, 'idle' after GM_PERK.idleDays with none played and none coming up), comes back by itself when a
 * session of theirs that started after the rest has been played, and stays off once staff take it ('staff') until staff
 * give it back. Like a GM's stamp (round 21), nothing about sessions is stored: they're counted from the games and their
 * seats every time, so a seat cancelled afterwards, or a session given to another GM, counts as it stands now.
 *
 * The staff slot. Everyone on the team (the main account, tagged staff in Shopify, and the Team tab's helpers) has one
 * library game at home at a time from any shelf. It needs no record: being on the team is the perk.
 *
 * One slot a person: a game at home on either perk fills it. A perk game is a lent game (16 Oct 2026: library_loans.lent,
 * outside every plan, nothing charged) that also says which perk it went out on (library_loans.perk).
 *
 * A game's books. Up to GM_PERK.booksMax RPG-shelf books a game names (game_books, one row a session a book). It
 * reserves nothing: holds, copies and loans work as they did. A book is wanted by each session on the board that names
 * it, and whoever looks at it, takes it or has it at home is told (bookWanted), with one email a game and one nudge a
 * loan from the 10-minute run.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair, and
 * its rule holds: every await first, then one synchronous read-check-write.
 */
import { HOUR, MIN, RuleError, lairTime, makeId, tagHandle } from './core.js';
import { emailReady } from './shopify.js';

const DAY = 24 * HOUR;

export const GM_PERK = Object.freeze({
  // Mo: "after 3 games consecutively that have not been filled it will disable the perk"
  quiet: 3,
  // Mo: "The three weeks no game remove perk function"
  idleDays: 21,
  // a session cancelled inside this many hours of its start (or after it) is a quiet one; cancelled further ahead it
  // doesn't count either way. The Lair's own line for a late change: seats lock in 24 hours before (round 15)
  cancelHours: 24,
  // Mo: "we might send a nudge if a week or two passed and the book is not back"
  nudgeDays: 7,
  // a perk book still at home this long after the perk began its rest: one more ask
  backAskDays: 7,
  // books a game can name, and the sessions listed on a book
  booksMax: 3,
  wantedShown: 3,
  // the 10-minute run: new GMs looked at, Shopify tag lookups for them, perks and loans read, emails sent
  newPerRun: 20,
  lookupsPerRun: 10,
  perksPerRun: 500,
  loansPerRun: 500,
  emailsPerRun: 50,
  // the member's page: log lines shown, and a note's length
  logShown: 10,
  noteMax: 300,
  // the picker's list
  pickerMax: 12,
});

/** The RPG shelf: its shelf codes' start, and its tag's handle in the catalogue ("Shelf RPG books") */
export const RPG_SHELF = 'DGLRPG';
export const RPG_SHELF_TAG = 'shelf-rpg-books';
/** How long Shopify's answer about someone's tags is taken as fresh (as lair.js's PERSON_TTL), and how long the run
 *  leaves someone it found on the team before asking about them again */
const TAGS_FRESH = 5 * MIN;
const TEAM_SEEN = 6 * HOUR;

/** Columns made sure of on every start (lair.js's migrate), as each round's are */
export const GM_PERK_COLUMNS = [
  ['library_loans', 'perk', 'TEXT'], ['library_loans', 'wanted_told', 'TEXT'], ['library_loans', 'wanted_told_at', 'INTEGER'], ['library_loans', 'nudged_at', 'INTEGER'],
  ['library_loans', 'back_asked_at', 'INTEGER'],
  // when a session was cancelled (cancelSessions), so "inside 24 hours of its start" never depends on a later edit,
  // and what it was then ('open' or 'pending'): one that was never approved doesn't count either way (1.3)
  ['games', 'cancelled_at', 'INTEGER'], ['games', 'cancelled_from', 'TEXT'],
];

/** The round's tables and indexes, made when missing */
export const GM_PERK_TABLES = [
  `CREATE TABLE IF NOT EXISTS gm_perks (
     customer_id TEXT PRIMARY KEY, status TEXT NOT NULL, source TEXT NOT NULL, since INTEGER NOT NULL, off_reason TEXT, off_at INTEGER, by TEXT, note TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS gm_perks_status ON gm_perks (status, updated_at)',
  `CREATE TABLE IF NOT EXISTS gm_perk_log (
     id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, by TEXT, note TEXT, at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS gm_perk_log_customer ON gm_perk_log (customer_id, at)',
  `CREATE TABLE IF NOT EXISTS game_books (
     game_id TEXT NOT NULL, variant_id TEXT NOT NULL, product_id TEXT, title TEXT NOT NULL, handle TEXT, shelf_code TEXT, image TEXT,
     position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (game_id, variant_id))`,
  'CREATE INDEX IF NOT EXISTS game_books_variant ON game_books (variant_id)',
  // the 10-minute run reads each GM's sessions, newest first
  'CREATE INDEX IF NOT EXISTS games_gm_customer ON games (gm_customer_id, ends_at)',
];

/* ---------- small helpers (as lair.js's) ---------- */
const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const trimmed = (v, max) => String(v ?? '').trim().slice(0, max);
/** Where a member's emails go: the email they gave us, else their Shopify account's verified email (as src/queue.js) */
const emailOf = (member) => (isEmail(member?.email) ? String(member.email).trim() : isEmail(member?.account_email) ? String(member.account_email).trim() : '');
const firstOf = (member) => member?.first_name || String(member?.name || '').split(/\s+/)[0] || '';

/** "Sun 15 Nov": a day, the way the library's pages say it */
export function bookDay(ms, tz = 'Pacific/Auckland') {
  return new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms)).replace(',', '');
}
/** "Sun 15 Nov, 6pm", "Wed 18 Nov, 6:30pm": when a session that wants a book starts */
export function bookWhen(ms, tz = 'Pacific/Auckland') {
  const { h, mi } = lairTime(tz).parts(ms);
  return `${bookDay(ms, tz)}, ${h % 12 || 12}${mi ? `:${String(mi).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}
const listed = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** Every message a member or staff can see, word for word in the contract (section 4) */
export const GM_PERK_WORDS = {
  borrowedGm: (title) => `${title} is yours to take home, free with your GM perk. When you're done, bring it to the counter and we'll scan it back onto the shelf.`,
  borrowedStaff: (title) => `${title} is yours to take home on your staff slot. Scan it back onto the shelf when you're done.`,
  slotFullGm: (title) => `Your GM perk is one book at a time, and ${title} is at home with you. Bring it back to the counter to swap.`,
  slotFullStaff: (title) => `Your staff slot is one game at a time, and ${title} is at home with you. Scan it back in to swap.`,
  rpgOnly: 'Your GM perk covers the RPG shelf. Join the library to borrow board games.',
  resting: 'Your GM perk is having a rest until your next game runs. Join the library to borrow in the meantime.',
  /**
   * What whoever takes a wanted book is told. wanted: the sessions shown ([{ at, title, mine }], soonest first), more:
   * how many more there are. Their own games' dates aren't news: with only those, it says to bring it along.
   */
  wantedLine: (wanted, tz = 'Pacific/Auckland', more = 0) => {
    const list = Array.isArray(wanted) ? wanted : [];
    if (!list.length) return '';
    const others = list.filter((w) => !w.mine);
    if (!others.length) return `It's down for your own game on ${bookWhen(list[0].at, tz)}: bring it along.`;
    const extra = Math.max(0, Math.floor(Number(more) || 0));
    if (others.length === 1 && !extra) {
      return `Heads up: ${others[0].title || 'a private game'} would like this one on the table at the Lair on ${bookWhen(others[0].at, tz)}. Take it by all means, and bring it back by then if you can.`;
    }
    const dates = [...others.map((w) => bookWhen(w.at, tz)), ...(extra ? [`${extra} more date${extra === 1 ? '' : 's'}`] : [])];
    return `Heads up: tables at the Lair would like this one on ${listed(dates)}. Take it by all means, and bring it back in time if you can.`;
  },
  booksList: "Send the game's books as a list.",
  booksMax: `A game can name up to ${GM_PERK.booksMax} library books.`,
  bookUnknown: "That isn't one of the library's RPG books. Pick one from the list.",
  booksOwn: "Only the game's GM or staff can change its books.",
  booksCancelled: "That game was cancelled, so its books can't change.",
  action: 'Pick give or take.',
  giveTeam: (name) => `${name ? `${name} is` : 'They are'} on the team, so they have the staff slot already.`,
  giveOn: (name) => `${name || 'They'} already ${name ? 'has' : 'have'} the GM perk.`,
  takeOff: (name) => `${name ? `${name}'s` : 'Their'} GM perk is switched off already.`,
};
const W = GM_PERK_WORDS;

/** The player's seat that says a session was played: someone's seat that isn't the GM's own (as GM_STAMP_ROWS, round 21) */
const PLAYER_SEAT = `EXISTS (SELECT 1 FROM bookings s WHERE s.game_id = g.id AND s.kind = 'gm-seat' AND s.status IN ('confirmed', 'seated', 'done')
  AND (s.customer_id IS NULL OR s.customer_id != g.gm_customer_id))`;
/** A session on the board with at least one player (1.3): Mo's "filled" */
const PLAYED = `g.status = 'open' AND (COALESCE(g.offline_players, 0) > 0 OR ${PLAYER_SEAT})`;

export const gmPerkMethods = {
  /* ---------------- who has a perk ---------------- */

  /**
   * Whether someone is on the team, as far as the Lair knows without asking Shopify: true or false when it knows, null
   * when it doesn't. Whoever's asking says so themselves (who: their own request's person); a helper is in the Lair's own
   * table; the main account is known from its Shopify tags the last time they were read (since the Lair last started).
   * No awaits.
   */
  perkTeam(customerId, who = null) {
    const id = String(customerId ?? '').trim();
    if (!id) return false;
    if (who && String(who.customerId ?? '') === id) return Boolean(who.staff);
    if (this.helperRow(id)) return true;
    const seen = this.people.get(id);
    return seen ? Boolean(seen.person?.staff) : null;
  },

  /** Whether someone is known to be on the team (perkTeam): the staff slot is theirs. No awaits. */
  perkOnTeam(customerId, who = null) {
    return this.perkTeam(customerId, who) === true;
  },

  /**
   * Whether the Lair's own table says they were a helper and were taken off the team: kept for good, so it's known
   * after a restart too. Only a game at home's "perk ended" mark reads it (loanPerkFields); who gets a perk doesn't.
   * No awaits.
   */
  perkLeftTeam(customerId) {
    const id = String(customerId ?? '').trim();
    return Boolean(id) && this.sql.exec("SELECT 1 FROM staff_helpers WHERE customer_id = ? AND status = 'removed' LIMIT 1", id).toArray().length > 0;
  },

  /** Someone's GM perk record, or null. No awaits. */
  perkRecord(customerId) {
    const id = String(customerId ?? '').trim();
    return id ? this.sql.exec('SELECT * FROM gm_perks WHERE customer_id = ?', id).toArray()[0] || null : null;
  },

  /** The games at home with someone on a perk, longest out first (one fills their slot). No awaits. */
  perkLoans(customerId) {
    return this.loansOut(customerId).filter((l) => l.perk);
  },

  /**
   * Whether a library game ({ variantId, productId, shelfCode }) is on the RPG shelf: its own shelf code starts DGLRPG,
   * or the catalogue's copy of it does, or the catalogue has it tagged Shelf RPG books. No awaits.
   */
  onRpgShelf(game) {
    if (String(game?.shelfCode ?? '').trim().toUpperCase().startsWith(RPG_SHELF)) return true;
    const row = this.catalogueBook(game);
    if (!row) return false;
    return String(row.shelf_code ?? '').trim().toUpperCase().startsWith(RPG_SHELF) || parse(row.tags, []).some((t) => tagHandle(t) === RPG_SHELF_TAG);
  },

  /** The catalogue's row for a library game, by its variant, else its product (an active one first). No awaits. */
  catalogueBook(game) {
    const variantId = String(game?.variantId ?? game?.variant_id ?? '').trim();
    const productId = String(game?.productId ?? game?.product_id ?? '').trim();
    return (variantId && this.sql.exec("SELECT * FROM pick_catalog WHERE variant_id = ? ORDER BY status = 'active' DESC LIMIT 1", variantId).toArray()[0])
      || (productId && this.sql.exec('SELECT * FROM pick_catalog WHERE product_id = ?', productId).toArray()[0])
      || null;
  },

  /**
   * Someone's perk as it stands (1.1, 1.2): null with none, or { kind: 'staff' | 'gm', status: 'on' | 'resting' | 'off',
   * covers: 'any' | 'rpg', record } (record: their GM perk record, or null). The team has the staff slot whatever their
   * record says. No awaits.
   */
  perkState(customerId, who = null) {
    const id = String(customerId ?? '').trim();
    if (!id) return null;
    const record = this.perkRecord(id);
    if (this.perkOnTeam(id, who)) return { kind: 'staff', status: 'on', covers: 'any', record };
    if (!record) return null;
    return { kind: 'gm', status: record.status === 'on' ? 'on' : record.off_reason === 'staff' ? 'off' : 'resting', covers: 'rpg', record };
  },

  /** Whether a perk that's on covers a game (one that stays in the Lair is refused before this is asked). No awaits. */
  perkCovers(state, game) {
    return Boolean(state && state.status === 'on' && (state.covers === 'any' || this.onRpgShelf(game)));
  },

  /**
   * Whether their perk takes this game now (1.4): null with no perk; { take: true, kind }; or { take: false, kind, why:
   * 'resting' | 'off' | 'shelf' | 'full', loan } (loan: the game filling the slot). No awaits: the caller makes the loan
   * in the same breath, so two scans can't both find the slot free.
   */
  perkSlot(customerId, who, game) {
    const state = this.perkState(customerId, who);
    if (!state) return null;
    if (state.status !== 'on') return { take: false, kind: state.kind, why: state.status };
    if (!this.perkCovers(state, game)) return { take: false, kind: state.kind, why: 'shelf' };
    const mine = this.perkLoans(customerId);
    if (mine.length) return { take: false, kind: state.kind, why: 'full', loan: mine[0] };
    return { take: true, kind: state.kind };
  },

  /**
   * What a scan with no library plan is told when a perk of theirs didn't take the game (1.4): the slot's in use (409),
   * the GM perk covers the RPG shelf only (403), or it's having a rest (403). null: nothing to add ("Join the library
   * to borrow games." stands): no perk, or one staff took.
   */
  perkRefusal(slot) {
    if (!slot || slot.take) return null;
    if (slot.why === 'full') return new RuleError(slot.kind === 'staff' ? W.slotFullStaff(slot.loan.title) : W.slotFullGm(slot.loan.title), 409);
    if (slot.why === 'shelf') return new RuleError(W.rpgOnly, 403);
    if (slot.why === 'resting') return new RuleError(W.resting, 403);
    return null;
  },

  /** What a scan says when a game goes out on a perk */
  perkBorrowed(kind, title) {
    return kind === 'staff' ? W.borrowedStaff(title) : W.borrowedGm(title);
  },

  /**
   * The perk for its holder (3.1: GET /me's and the scan's library.perk): null with no perk and no record. No awaits.
   */
  perkView(customerId, who = null, now = Date.now()) {
    const state = this.perkState(customerId, who);
    if (!state) return null;
    const loan = this.perkLoans(customerId)[0] || null;
    const record = state.kind === 'gm' ? state.record : null;
    return {
      kind: state.kind, status: state.status, covers: state.covers, free: state.status === 'on' && !loan, loanId: loan ? loan.id : null,
      since: record ? record.since : null,
      quiet: record && state.status === 'on' ? this.perkQuiet(customerId, record.since, now) : 0, quietMax: GM_PERK.quiet,
      reason: state.status === 'resting' ? record.off_reason : null,
    };
  },

  /* ---------------- which sessions count (1.3) ---------------- */

  /**
   * How many of someone's sessions in a row were quiet, counting back from their latest (1.3): sessions that started
   * at or after `since` and have ended. Played (on the board with a player) ends the count; quiet (on the board with no
   * player, or cancelled inside GM_PERK.cancelHours of its start, or after it) adds one; one cancelled further ahead
   * doesn't count either way; one never approved isn't read at all, nor is one staff turned down while it waited
   * (cancelled_from 'pending'). No awaits.
   */
  perkQuiet(customerId, since, now = Date.now()) {
    const rows = this.sql.exec(
      `SELECT g.status AS status, g.starts_at AS starts_at, COALESCE(g.cancelled_at, g.updated_at) AS cancelled_at,
              CASE WHEN ${PLAYED} THEN 1 ELSE 0 END AS played
         FROM games g
        WHERE g.gm_customer_id = ? AND g.starts_at >= ? AND g.ends_at <= ?
          AND (g.status = 'open' OR (g.status = 'cancelled' AND COALESCE(g.cancelled_from, 'open') != 'pending'))
        ORDER BY g.ends_at DESC, g.starts_at DESC, g.id DESC LIMIT 40`,
      String(customerId), Number(since) || 0, now,
    ).toArray();
    let quiet = 0;
    for (const r of rows) {
      if (r.status === 'cancelled') {
        if (Number(r.cancelled_at) >= r.starts_at - GM_PERK.cancelHours * HOUR) quiet += 1;
        continue;
      }
      if (r.played) break;
      quiet += 1;
    }
    return quiet;
  },

  /** Whether a session of theirs that started at or after `from`, and has ended, was played. No awaits. */
  perkPlayedSince(customerId, from, now = Date.now()) {
    return this.sql.exec(
      `SELECT 1 AS yes FROM games g WHERE g.gm_customer_id = ? AND g.starts_at >= ? AND g.ends_at <= ? AND ${PLAYED} LIMIT 1`,
      String(customerId), Number(from) || 0, now,
    ).toArray().length > 0;
  },

  /** Whether a session of theirs is coming up: on the board or waiting for approval, and not ended. No awaits. */
  perkComingUp(customerId, now = Date.now()) {
    return this.sql.exec(
      "SELECT 1 AS yes FROM games g WHERE g.gm_customer_id = ? AND g.status IN ('open', 'pending') AND g.ends_at > ? LIMIT 1", String(customerId), now,
    ).toArray().length > 0;
  },

  /**
   * Why a perk that's on should rest now (1.2), or null: 'quiet' after GM_PERK.quiet quiet sessions in a row since it
   * went on; 'idle' once it's been on GM_PERK.idleDays with no session played in that many days and none coming up.
   */
  perkRestReason(record, now = Date.now()) {
    if (this.perkQuiet(record.customer_id, record.since, now) >= GM_PERK.quiet) return 'quiet';
    const idle = GM_PERK.idleDays * DAY;
    if (now - record.since >= idle && !this.perkPlayedSince(record.customer_id, now - idle, now) && !this.perkComingUp(record.customer_id, now)) return 'idle';
    return null;
  },

  /* ---------------- on and off ---------------- */

  /** One line in a perk's log. No awaits. */
  perkLog(customerId, action, reason, by, note, now) {
    this.sql.exec(
      'INSERT INTO gm_perk_log (id, customer_id, action, reason, by, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      makeId('pl'), String(customerId), action, reason, by || 'auto', note || null, now,
    );
  },

  /** The perk goes on now (source 'auto' or 'staff'), whatever it was, and the log says why. No awaits. */
  perkTurnOn(customerId, { source = 'auto', reason, by = 'auto', note = null, now = Date.now() }) {
    this.sql.exec(
      `INSERT INTO gm_perks (customer_id, status, source, since, off_reason, off_at, by, note, created_at, updated_at) VALUES (?, 'on', ?, ?, NULL, NULL, ?, ?, ?, ?)
       ON CONFLICT(customer_id) DO UPDATE SET status = 'on', source = excluded.source, since = excluded.since, off_reason = NULL, off_at = NULL, by = excluded.by,
         note = excluded.note, updated_at = excluded.updated_at`,
      String(customerId), source, now, by, note, now, now,
    );
    this.perkLog(customerId, 'on', reason, by, note, now);
  },

  /**
   * The perk goes off now ('quiet', 'idle' or 'staff'), and the log says why. For someone with no record (staff taking
   * it before they ever had it) the record starts here, so it never switches itself on. No awaits.
   */
  perkTurnOff(customerId, { reason, by = 'auto', note = null, now = Date.now() }) {
    const staff = reason === 'staff';
    this.sql.exec(
      `INSERT INTO gm_perks (customer_id, status, source, since, off_reason, off_at, by, note, created_at, updated_at) VALUES (?, 'off', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(customer_id) DO UPDATE SET status = 'off', off_reason = excluded.off_reason, off_at = excluded.off_at, by = excluded.by,
         note = CASE WHEN ? THEN excluded.note ELSE gm_perks.note END, updated_at = excluded.updated_at`,
      String(customerId), staff ? 'staff' : 'auto', now, reason, now, by, note, now, now, staff ? 1 : 0,
    );
    this.perkLog(customerId, 'off', reason, by, note, now);
  },

  /**
   * A new GM's perk (1.2): someone with no record, not on the team, who is the GM of a session on the board that hasn't
   * ended gets the perk now, and is told. Called wherever that can become true (a game listed or approved, a game
   * joining their account, My Lair opening) and by the 10-minute run. who: their own request's person when it's them
   * asking, so the main account is known; otherwise the Lair's own knowledge of the team decides (perkTeam), and someone
   * it knows nothing about waits for the 10-minute run, which asks Shopify first. → whether it went on. No awaits.
   */
  gmPerkListed(customerId, who = null, now = Date.now()) {
    const id = String(customerId ?? '').trim();
    if (!id || this.perkRecord(id) || this.perkTeam(id, who) !== false) return false;
    const game = this.sql.exec(
      "SELECT title FROM games WHERE gm_customer_id = ? AND status = 'open' AND ends_at > ? ORDER BY starts_at LIMIT 1", id, now,
    ).toArray()[0];
    if (!game) return false;
    this.perkTurnOn(id, { source: 'auto', reason: 'listed', now });
    this.perkTellOn(id, 'listed', { game: game.title });
    return true;
  },

  /* ---------------- staff give and take (1.8, 3.9), and staff's views ---------------- */

  /** Who changed a perk last, for staff: { customerId, name }, or null when it changed by itself. No awaits. */
  perkBy(by) {
    const id = String(by || '').replace(/^staff:/, '');
    if (!id || id === 'auto' || id === 'staff') return null;
    const m = this.memberRow(id);
    return { customerId: id, name: m?.name || m?.first_name || '' };
  },

  /**
   * The perk as staff see it (3.8). team: whether they're on the team (their person's staff when the caller has it,
   * else what the Lair knows). withLog: the last GM_PERK.logShown log lines, newest first. No awaits.
   */
  staffPerkView(customerId, { team = null, withLog = true, now = Date.now(), memo = null } = {}) {
    const id = String(customerId);
    const record = this.perkRecord(id);
    const onTeam = team == null ? this.perkOnTeam(id) : Boolean(team);
    const loan = this.perkLoans(id)[0] || null;
    const status = !record ? 'none' : record.status === 'on' ? 'on' : record.off_reason === 'staff' ? 'off' : 'resting';
    const lastPlayed = this.sql.exec(`SELECT MAX(g.starts_at) AS at FROM games g WHERE g.gm_customer_id = ? AND g.ends_at <= ? AND ${PLAYED}`, id, now).toArray()[0]?.at ?? null;
    const next = this.sql.exec("SELECT MIN(starts_at) AS at FROM games WHERE gm_customer_id = ? AND status = 'open' AND ends_at > ?", id, now).toArray()[0]?.at ?? null;
    return {
      kind: onTeam ? 'staff' : record ? 'gm' : null, status: onTeam ? 'on' : status,
      source: record?.source || null, since: record ? record.since : null, reason: record && record.status !== 'on' ? record.off_reason || null : null,
      offAt: record && record.status !== 'on' ? record.off_at || null : null, by: record ? this.perkBy(record.by) : null, note: record?.note || '',
      quiet: record && record.status === 'on' ? this.perkQuiet(id, record.since, now) : 0, quietMax: GM_PERK.quiet,
      lastPlayed, next, loan: loan ? this.staffLoanView(loan, now, memo) : null,
      ...(withLog ? {
        log: this.sql.exec('SELECT * FROM gm_perk_log WHERE customer_id = ? ORDER BY at DESC, rowid DESC LIMIT ?', id, GM_PERK.logShown).toArray()
          .map((l) => ({ at: l.at, action: l.action, reason: l.reason, by: this.perkBy(l.by), note: l.note || '' })),
      } : {}),
    };
  },

  /**
   * POST /members/:id/gm-perk { action: 'give' | 'take', note? } (staff with Members, GM games or Library): give the GM
   * perk (on now, whatever it was; they're emailed) or take it away (off until staff give it back; nobody is emailed).
   * 404 for no such member, 422 for another action, 409 when there's nothing to do. → { perk } (staffPerkView).
   */
  async staffGmPerk(customerId, input, who) {
    this.requireStaff(who, ['members', 'sessions', 'library']);
    const id = trimmed(customerId, 40);
    if (!this.memberRow(id)) throw new RuleError('No member with that customer ID.', 404);
    const action = String(input?.action ?? '').trim().toLowerCase();
    if (!['give', 'take'].includes(action)) throw new RuleError(W.action);
    // their tags say whether they're the main account (a helper is the Lair's own to know)
    const person = await this.person(id);
    // --- no awaits from here on ---
    const now = Date.now();
    const member = this.memberRow(id);
    if (!member) throw new RuleError('No member with that customer ID.', 404);
    const name = firstOf(member);
    const record = this.perkRecord(id);
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    const note = trimmed(input?.note, GM_PERK.noteMax) || null;
    if (action === 'give') {
      if (person?.staff) throw new RuleError(W.giveTeam(name), 409);
      if (record?.status === 'on') throw new RuleError(W.giveOn(name), 409);
      this.perkTurnOn(id, { source: 'staff', reason: 'staff', by, note, now });
      this.perkTellOn(id, 'staff');
    } else {
      if (record && record.status !== 'on' && record.off_reason === 'staff') throw new RuleError(W.takeOff(name), 409);
      this.perkTurnOff(id, { reason: 'staff', by, note, now });
    }
    return { perk: this.staffPerkView(id, { team: Boolean(person?.staff), now }) };
  },

  /**
   * GET /gm-perks (staff with Members, GM games or Library): everyone with a GM perk record (on, then resting, then off;
   * each newest change first) without their logs, and the team's slots in use. No awaits.
   */
  async listGmPerks(who) {
    this.requireStaff(who, ['members', 'sessions', 'library']);
    await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const memo = new Map();
    const perks = this.sql.exec(
      `SELECT customer_id FROM gm_perks ORDER BY CASE WHEN status = 'on' THEN 0 WHEN off_reason = 'staff' THEN 2 ELSE 1 END, updated_at DESC, customer_id LIMIT ?`,
      GM_PERK.perksPerRun,
    ).toArray().map((r) => {
      const m = this.memberRow(r.customer_id);
      return { customerId: r.customer_id, name: m?.name || m?.first_name || '', code: m?.code || null, ...this.staffPerkView(r.customer_id, { withLog: false, now, memo }) };
    });
    const team = this.sql.exec("SELECT * FROM library_loans WHERE status = 'out' AND perk = 'staff' ORDER BY out_at, created_at LIMIT ?", GM_PERK.loansPerRun).toArray().map((r) => {
      const loan = this.staffLoanView(this.rowToLoan(r), now, memo);
      return { customerId: loan.customerId, name: loan.name, loan };
    });
    return { perks, team };
  },

  /* ---------------- a game's books (1.6, 3.5 to 3.7) ---------------- */

  /** A catalogue row as a game's book: { variantId, productId, title, handle, shelfCode, image } */
  bookOf(row) {
    return {
      variantId: String(row.variant_id), productId: row.product_id ? String(row.product_id) : null, title: row.title, handle: row.handle || '',
      shelfCode: row.shelf_code || '', image: row.image || null,
    };
  },

  /**
   * GET /library/books?q= (logged in): the RPG shelf's books for the form's picker, from the catalogue: active listings
   * whose title has every word of q (ignoring case), A to Z, GM_PERK.pickerMax at most. No awaits.
   */
  libraryBooks(url, who) {
    if (!who.customerId) throw new RuleError('Log in to pick a book for your game.', 401);
    const words = trimmed(url.searchParams.get('q'), 60).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    const books = [];
    // the RPG shelf is a couple of hundred listings: the shelf's rows are read A to Z (without their long text) and the
    // words matched in code, so a tag's handle is read here as it is everywhere
    for (const row of this.sql.exec(
      `SELECT product_id, variant_id, title, handle, shelf_code, image, copies, tags FROM pick_catalog
        WHERE status = 'active' AND variant_id IS NOT NULL AND (shelf_code LIKE '${RPG_SHELF}%' OR tags LIKE '%shelf%rpg%books%')
        ORDER BY title COLLATE NOCASE, product_id`,
    ).toArray()) {
      if (!this.rpgShelfRow(row)) continue;
      const title = String(row.title || '').toLowerCase();
      if (!words.every((w) => title.includes(w))) continue;
      books.push({ ...this.bookOf(row), copies: Math.max(1, Number(row.copies) || 1) });
      if (books.length >= GM_PERK.pickerMax) break;
    }
    return { books };
  },

  /** Whether a catalogue row is an RPG-shelf book. No awaits. */
  rpgShelfRow(row) {
    return String(row?.shelf_code ?? '').trim().toUpperCase().startsWith(RPG_SHELF) || parse(row?.tags, []).some((t) => tagHandle(t) === RPG_SHELF_TAG);
  },

  /**
   * The books a game names, as sent (3.6): undefined when none were sent (nothing changes); else up to GM_PERK.booksMax
   * active RPG-shelf books of the catalogue, each by its variant id or product id, the same one twice counting once.
   * 422 with the contract's words otherwise. No awaits.
   */
  checkBooks(value) {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) throw new RuleError(W.booksList);
    const books = [];
    for (const item of value) {
      const id = String(item ?? '').trim().replace(/^gid:\/\/shopify\/(?:ProductVariant|Product)\//, '');
      if (!/^\d{1,20}$/.test(id)) throw new RuleError(W.bookUnknown);
      const row = this.sql.exec("SELECT * FROM pick_catalog WHERE (variant_id = ? OR product_id = ?) AND status = 'active' AND variant_id IS NOT NULL LIMIT 1", id, id).toArray()[0];
      if (!row || !this.rpgShelfRow(row)) throw new RuleError(W.bookUnknown);
      if (!books.some((b) => b.variantId === String(row.variant_id))) books.push(this.bookOf(row));
    }
    if (books.length > GM_PERK.booksMax) throw new RuleError(W.booksMax);
    return books;
  },

  /** A session's books as they're kept (game_books), in the GM's order. No awaits. */
  gameBookRows(gameId) {
    return this.sql.exec('SELECT * FROM game_books WHERE game_id = ? ORDER BY position, rowid', String(gameId)).toArray().map((r) => this.bookOf(r));
  },

  /** Set a session's books (all of them: the ones it had go). No awaits. */
  saveGameBooks(gameId, books, now = Date.now()) {
    this.sql.exec('DELETE FROM game_books WHERE game_id = ?', String(gameId));
    (books || []).slice(0, GM_PERK.booksMax).forEach((b, position) => {
      this.sql.exec(
        'INSERT OR REPLACE INTO game_books (game_id, variant_id, product_id, title, handle, shelf_code, image, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        String(gameId), String(b.variantId), b.productId || null, b.title, b.handle || null, b.shelfCode || null, b.image || null, position, now,
      );
    });
  },

  /**
   * A new session gets its game's books (saveSession): the ones it was made with (base.books: Run a game, or a series'
   * own for the sessions it adds), else its series' own, else those of the series' latest other session (a one-off that
   * just became a series). No awaits.
   */
  carryBooks(game, base, now = Date.now()) {
    let books = Array.isArray(base?.books) ? base.books : null;
    if (!books && game.seriesId) {
      const kept = parse(this.sql.exec('SELECT details FROM series WHERE id = ?', game.seriesId).toArray()[0]?.details, {}).books;
      if (Array.isArray(kept)) books = kept;
      else {
        const last = this.sql.exec('SELECT id FROM games WHERE series_id = ? AND id != ? ORDER BY starts_at DESC LIMIT 1', game.seriesId, game.id).toArray()[0];
        books = last ? this.gameBookRows(last.id) : null;
      }
    }
    if (books?.length) this.saveGameBooks(game.id, books, now);
  },

  /**
   * A session's books as its GM and staff see them (3.7): each with the catalogue's copies (1 when it doesn't say), how
   * many copies are at home with anyone (out) and whether one is with whoever's asking (withYou). No awaits.
   */
  gameBooksView(gameId, viewerId = null) {
    const me = viewerId ? String(viewerId) : '';
    return this.gameBookRows(gameId).map((b) => {
      const out = this.sql.exec("SELECT customer_id FROM library_loans WHERE variant_id = ? AND status = 'out'", b.variantId).toArray();
      return {
        ...b, copies: Math.max(1, Number(this.catalogueBook(b)?.copies) || 1), out: out.length,
        withYou: Boolean(me) && out.some((l) => String(l.customer_id) === me),
      };
    });
  },

  /** Whether someone may see and change a game's books: its GM (a series: whoever runs it) or staff with GM games. No awaits. */
  booksAreTheirs(game, who) {
    if (this.can(who, 'sessions')) return true;
    if (!who?.customerId) return false;
    return game.seriesId ? this.runsSeries(who, game.seriesId) || String(game.gmCustomerId || '') === String(who.customerId) : String(game.gmCustomerId || '') === String(who.customerId);
  },

  /** GET /games/:id/books (the game's GM, or staff with GM games) → { books, scope }. No awaits. */
  gameBooks(id, who) {
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    if (!this.booksAreTheirs(game, who)) throw new RuleError(W.booksOwn, 403);
    return { books: this.gameBooksView(game.id, who.customerId), scope: game.seriesId ? 'series' : 'session' };
  },

  /**
   * POST /games/:id/books { books, scope? } (the game's GM, or staff with GM games): the game's books from here on.
   * scope 'series' (the default for a session of a series): this session and every later one of its series that hasn't
   * ended and that they run, and the series' own, for the sessions it adds; 'session': this one only. → { books,
   * sessions } (how many sessions changed). No awaits.
   */
  setGameBooks(id, input, who) {
    const now = Date.now();
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    if (!this.booksAreTheirs(game, who)) throw new RuleError(W.booksOwn, 403);
    if (game.status === 'cancelled') throw new RuleError(W.booksCancelled, 409);
    // (the books are a list here, always: an empty one clears them, and a request without one changes nothing)
    if (!Array.isArray(input?.books)) throw new RuleError(W.booksList);
    const books = this.checkBooks(input.books);
    const scope = game.seriesId && input?.scope !== 'session' ? 'series' : 'session';
    let targets = [game];
    if (scope === 'series') {
      const later = this.sql.exec("SELECT * FROM games WHERE series_id = ? AND status != 'cancelled' AND starts_at >= ? AND ends_at > ? AND id != ?", game.seriesId, game.start, now, game.id)
        .toArray().map((r) => this.rowToGame(r));
      targets = [game, ...this.ownSessionsOnly(who, later)];
      if (this.runsSeries(who, game.seriesId)) this.patchSeries(game.seriesId, { books }, now);
    }
    for (const g of targets) this.saveGameBooks(g.id, books, now);
    return { books: this.gameBooksView(game.id, who.customerId), sessions: targets.length };
  },

  /* ---------------- who wants a book (1.7, 3.4) ---------------- */

  /**
   * The sessions that want each of these library games, soonest first: on the board, not ended, naming it. → a Map of
   * variant id → [{ gameId, key (its series, else itself), title, at, until, gm, private }]. At most 90 variants a query
   * (Cloudflare's 100 bound values). No awaits.
   */
  wantedSessions(variantIds, now = Date.now()) {
    const ids = [...new Set((variantIds || []).map((x) => String(x ?? '').trim()).filter(Boolean))];
    const out = new Map(ids.map((id) => [id, []]));
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      const rows = this.sql.exec(
        `SELECT b.variant_id AS variant_id, g.id AS id, g.series_id AS series_id, g.title AS title, g.starts_at AS starts_at, g.ends_at AS ends_at,
                g.gm_customer_id AS gm, g.private AS private
           FROM game_books b JOIN games g ON g.id = b.game_id
          WHERE g.status = 'open' AND g.ends_at > ? AND b.variant_id IN (${part.map(() => '?').join(', ')})
          ORDER BY g.starts_at, g.id`,
        now, ...part,
      ).toArray();
      for (const r of rows) {
        out.get(String(r.variant_id))?.push({
          gameId: r.id, key: r.series_id || r.id, title: r.title, at: r.starts_at, until: r.ends_at, gm: r.gm ? String(r.gm) : '', private: Boolean(r.private),
        });
      }
    }
    return out;
  },

  /**
   * A wanted session as someone sees it (3.4): { at, until, title, mine }. mine: `forId` is its GM. A private game's
   * title is only its GM's and staff's to see (null for everyone else).
   */
  wantedView(w, forId, staff) {
    const mine = Boolean(forId) && w.gm === String(forId);
    return { at: w.at, until: w.until, title: w.private && !mine && !staff ? null : w.title, mine };
  },

  /**
   * Who wants one library game, as someone sees it: { wanted: the soonest GM_PERK.wantedShown, wantedMore: how many more,
   * all } (all: every session, for the emails). forId: whose loan or look it is (their own games are `mine`); staff:
   * whether private games' titles show. memo: a staff list's Map, so a game on several rows is read once. No awaits.
   */
  bookWanted(variantId, now = Date.now(), { forId = null, staff = false, memo = null } = {}) {
    const id = String(variantId ?? '').trim();
    const key = `wanted:${id}`;
    let all = memo?.get(key);
    if (!all) {
      all = this.wantedSessions([id], now).get(id) || [];
      memo?.set(key, all);
    }
    return { ...this.wantedShown(all, forId, staff), all };
  },

  /** The soonest GM_PERK.wantedShown sessions that want a game, as someone sees them, and how many more there are (3.4). */
  wantedShown(all, forId = null, staff = false) {
    return {
      wanted: all.slice(0, GM_PERK.wantedShown).map((w) => this.wantedView(w, forId, staff)),
      wantedMore: Math.max(0, all.length - GM_PERK.wantedShown),
    };
  },

  /**
   * What a loan view adds (3.2): perk ('gm', 'staff' or null), perkEnded (it went out on a perk that doesn't cover it
   * any more: resting, taken, or known to be off the team) and wanted (who wants it, as its borrower would see it; staff see private
   * games' titles too). No awaits.
   */
  loanPerkFields(l, { staff = false, now = Date.now(), memo = null } = {}) {
    const perk = l.perk || null;
    const out = l.status === 'out';
    // A staff slot's game has ended once the Lair KNOWS they're off the team (and no GM perk of theirs covers it). The
    // main account is on the team by its Shopify tags, which the Lair remembers only until it next restarts: not having
    // heard yet is not "ended" (their own next request says). A helper taken off the team is in the Lair's own table,
    // so that stays known across a restart.
    const unheard = perk === 'staff' && this.perkTeam(l.customerId) === null && !this.perkLeftTeam(l.customerId);
    const ended = Boolean(perk) && out && !this.perkCovers(this.perkState(l.customerId), l) && !unheard;
    return {
      perk, perkEnded: ended,
      wanted: out ? this.bookWanted(l.variantId, now, { forId: l.customerId, staff, memo }).wanted : [],
    };
  },

  /**
   * The heads-up for whoever's taking a game (wantedLine), from bookWanted's answer: other tables' next dates (the
   * soonest GM_PERK.wantedShown, and how many more), or, when only their own games want it, to bring it along. '' when
   * nobody wants it. forId: who's taking it; staff: whether a private game is named. No awaits.
   */
  wantedWords(found, forId = null, staff = false) {
    const all = found?.all || [];
    if (!all.length) return '';
    const me = forId ? String(forId) : '';
    const tz = this.rulesCache?.tz || 'Pacific/Auckland';
    const others = all.filter((w) => !me || w.gm !== me);
    if (!others.length) return W.wantedLine([this.wantedView(all[0], me, staff)], tz);
    return W.wantedLine(others.slice(0, GM_PERK.wantedShown).map((w) => this.wantedView(w, me, staff)), tz, Math.max(0, others.length - GM_PERK.wantedShown));
  },

  /* ---------------- emails (section 5) ---------------- */

  /** Whether this round's emails go at all: config GM_PERK_EMAILS = 'off' stops every one of them (nothing else changes) */
  perkMailsOn() {
    return emailReady(this.env) && String(this.env.GM_PERK_EMAILS ?? '').trim().toLowerCase() !== 'off';
  },

  /**
   * Whether Gobgob can email someone about their GM perk: this round's emails are on, they have an address, and they're
   * not on the team. → the member row, or null. No awaits.
   */
  perkMailTo(customerId) {
    if (!this.perkMailsOn() || this.perkOnTeam(customerId)) return null;
    const member = this.memberRow(customerId);
    return emailOf(member) ? member : null;
  },

  /** 5.1: the perk's on ('listed', 'staff'), or back after a rest ('played'). An account notice, not marketing. No awaits. */
  perkTellOn(customerId, reason, { game = '' } = {}) {
    const member = this.perkMailTo(customerId);
    if (!member) return false;
    const first = firstOf(member) || 'friend';
    const back = reason === 'played';
    const perk = "one book from the library's RPG shelf to take home at a time, free";
    const opening = back
      ? `${game || 'Your game'} had players at the table, so your GM perk is back: ${perk}.`
      : reason === 'staff'
        ? `The team's switched on your GM perk: ${perk}. Swap it as often as you like.`
        : `${game || 'Your game'} is on the board, and GMs at the Lair get a perk: ${perk}. Swap it as often as you like.`;
    this.later(this.mail(this.letter(emailOf(member), back ? 'Your GM perk is back' : 'Your GM perk is on: borrow an RPG book, free', {
      title: back ? 'Your GM perk is back!' : 'Your GM perk is on!',
      preheader: back ? 'One RPG book at home at a time, same as before.' : 'One book from the RPG shelf at home at a time, while your games have players.',
      intro: [`Kia ora ${first}!`, opening],
      details: [
        ['How', 'Scan it in My Lair at the shelf, or ask at the counter'], ['Bringing it back', 'Hand it in at the counter, then pick your next one'],
        ['It stays on', 'While your games have players'],
      ],
      outro: back ? [] : [
        'Three sessions in a row with nobody at the table, or three weeks with no game, and the perk has a rest until your next game runs.',
        'Running something off the shelf? Add the book to your game in My Lair, and whoever has it at home hears your table would like it back that day.',
      ],
      button: { label: 'Browse the RPG shelf', url: this.link('/collections/library-rpg-books') },
      signoff: 'Happy GMing!\nGobgob, the Dice Goblin',
    })));
    return true;
  },

  /** 5.2: the perk's resting ('quiet' or 'idle'), with the ask for a perk book at home. No awaits. */
  perkTellRest(customerId, reason) {
    const member = this.perkMailTo(customerId);
    if (!member) return false;
    const first = firstOf(member) || 'friend';
    const loan = this.perkLoans(customerId)[0] || null;
    this.later(this.mail(this.letter(emailOf(member), 'Your GM perk is having a rest', {
      title: 'Your GM perk is having a rest',
      preheader: 'It comes back by itself when a game of yours runs with players.',
      intro: [
        `Kia ora ${first}!`,
        reason === 'quiet'
          ? 'Your last three sessions had nobody at the table, so your GM perk is having a rest.'
          : "It's been three weeks with no game of yours running at the Lair, so your GM perk is having a rest.",
        'It comes back by itself as soon as a game of yours runs with players.',
        ...(loan ? [`You've still got ${loan.title} at home. Could you bring it back next time you're in? There's nothing to pay.`] : []),
      ],
      details: loan ? [['At home with you', loan.title], ['Shelf', loan.shelfCode]] : [],
      button: { label: 'Run a game', url: this.page('gm') },
    })));
    return true;
  },

  /**
   * An email's subject with a game's title in it (section 5): as written when that's under 50 characters, so it fits a
   * phone's inbox; else with "your library book" in the title's place (the email itself still names it). No awaits.
   */
  perkSubject(write, title) {
    const named = write(title);
    return named.length < 50 ? named : write('your library book');
  },

  /** 5.3: games that want a book someone has at home, each with its next dates. → the email. No awaits. */
  wantedLetter(loan, member, games, tz) {
    const first = firstOf(member) || 'friend';
    const soonest = Math.min(...games.map((g) => g.dates[0]));
    const one = games.length === 1 ? games[0] : null;
    return this.letter(emailOf(member), this.perkSubject((book) => `A table wants ${book} on ${bookDay(soonest, tz)}`, loan.title), {
      title: 'A table would love this one back',
      preheader: "Nothing's forced. If you can drop it back by then, they'll thank you.",
      intro: [
        `Kia ora ${first}!`,
        one
          ? `You've got ${loan.title} at home, and ${one.title} would love it on the table at the Lair on ${bookWhen(one.dates[0], tz)}.`
          : `You've got ${loan.title} at home, and ${games.length} games at the Lair would love it on their tables.`,
        "Nothing's forced: if you can drop it back by then, the table will thank you. Hand it in at the counter and we'll scan it back onto the shelf.",
      ],
      details: [['Book', loan.title], ...games.map((g) => [g.title, g.dates.map((d) => bookWhen(d, tz)).join('; ')])],
      button: { label: 'See it in My Lair', url: `${this.page('myLair')}?view=library` },
    });
  },

  /** 5.4: the one nudge: a session that wanted the book came and went a week ago, and it's still at home. No awaits. */
  nudgeLetter(loan, member, session, tz) {
    const first = firstOf(member) || 'friend';
    return this.letter(emailOf(member), this.perkSubject((book) => `Could you bring ${book} back?`, loan.title), {
      title: `Still got ${loan.title}?`,
      preheader: `${session.title} wanted it on the table on ${bookDay(session.at, tz)}.`,
      intro: [
        `Kia ora ${first}!`,
        `${session.title} wanted ${loan.title} on the table at the Lair on ${bookDay(session.at, tz)}, and it's still at home with you. Could you bring it back next time you're in?`,
        "Still using it for a game of your own? Tell us at the counter and we'll sort it out.",
      ],
      details: [['Book', loan.title], ['Shelf', loan.shelfCode]],
      button: { label: 'See it in My Lair', url: `${this.page('myLair')}?view=library` },
    });
  },

  /** 5.5: a perk book still at home a week into the perk's rest: one more ask. No awaits. */
  backAskLetter(loan, member) {
    const first = firstOf(member) || 'friend';
    return this.letter(emailOf(member), this.perkSubject((book) => `Could you bring ${book} back?`, loan.title), {
      title: `Still got ${loan.title}?`,
      preheader: "Your GM perk's been resting for a week.",
      intro: [
        `Kia ora ${first}!`,
        `Your GM perk's been resting for a week, and ${loan.title} is still at home with you. Could you bring it back next time you're in?`,
        'The perk comes back by itself as soon as a game of yours runs with players.',
      ],
      details: [['Book', loan.title], ['Shelf', loan.shelfCode]],
      button: { label: 'Run a game', url: this.page('gm') },
    });
  },

  /* ---------------- the 10-minute run (section 6) ---------------- */

  /**
   * Part of the Lair's maintenance. New GMs' perks go on (after asking Shopify whether each is on the team: at most
   * GM_PERK.lookupsPerRun a run, and someone it couldn't ask about waits); perks that are on rest when 1.2 says so;
   * resting perks come back when a session since has been played; and the loans' emails go (5.3 to 5.5), at most
   * GM_PERK.emailsPerRun a run. → { on, rested, back, told, nudged, asked }.
   */
  async gmPerkUpkeep(now = Date.now()) {
    const out = { on: 0, rested: 0, back: 0, told: 0, nudged: 0, asked: 0 };
    // 1. GMs of sessions on the board with no record: who's on the team is asked first, a few a run
    this.perkTeamSeen = this.perkTeamSeen || new Map();
    const fresh = this.sql.exec(
      `SELECT DISTINCT g.gm_customer_id AS id FROM games g
        WHERE g.status = 'open' AND g.ends_at > ? AND g.gm_customer_id IS NOT NULL AND g.gm_customer_id != ''
          AND NOT EXISTS (SELECT 1 FROM gm_perks p WHERE p.customer_id = g.gm_customer_id)
          AND NOT EXISTS (SELECT 1 FROM staff_helpers h WHERE h.customer_id = g.gm_customer_id AND h.status = 'active')
        ORDER BY g.gm_customer_id LIMIT ?`,
      now, GM_PERK.newPerRun + this.perkTeamSeen.size,
    ).toArray().map((r) => String(r.id));
    const notTeam = [];
    let lookups = 0;
    for (const id of fresh) {
      if (now - (this.perkTeamSeen.get(id) || 0) < TEAM_SEEN) continue;
      const cached = this.people.get(id);
      let person = cached && Date.now() - cached.at < TAGS_FRESH ? cached.person : null;
      if (!person) {
        if (lookups >= GM_PERK.lookupsPerRun) continue;
        lookups += 1;
        person = await this.taggedPerson(id);
      }
      // Shopify couldn't say: they wait for the next run, so the main account is never given a GM perk by a blip
      if (!person || person.tagsFailed) continue;
      if (person.staff) {
        if (this.perkTeamSeen.size > 200) this.perkTeamSeen.clear();
        this.perkTeamSeen.set(id, now);
        continue;
      }
      notTeam.push(id);
    }
    // --- no awaits from here on ---
    for (const id of notTeam.slice(0, GM_PERK.newPerRun)) {
      if (this.gmPerkListed(id, { customerId: id, staff: false }, now)) out.on += 1;
    }
    // 2. perks that are on: rested when the sessions say so
    for (const record of this.sql.exec("SELECT * FROM gm_perks WHERE status = 'on' ORDER BY updated_at, customer_id LIMIT ?", GM_PERK.perksPerRun).toArray()) {
      const reason = this.perkRestReason(record, now);
      if (!reason) continue;
      this.perkTurnOff(record.customer_id, { reason, now });
      this.perkTellRest(record.customer_id, reason);
      out.rested += 1;
    }
    // 3. resting perks: back when a session that started since the rest began has been played
    for (const record of this.sql.exec(
      "SELECT * FROM gm_perks WHERE status = 'off' AND off_reason IN ('quiet', 'idle') ORDER BY updated_at, customer_id LIMIT ?", GM_PERK.perksPerRun,
    ).toArray()) {
      if (!this.perkPlayedSince(record.customer_id, record.off_at, now)) continue;
      const game = this.sql.exec(
        `SELECT g.title AS title FROM games g WHERE g.gm_customer_id = ? AND g.starts_at >= ? AND g.ends_at <= ? AND ${PLAYED} ORDER BY g.starts_at DESC LIMIT 1`,
        record.customer_id, record.off_at, now,
      ).toArray()[0];
      this.perkTurnOn(record.customer_id, { source: 'auto', reason: 'played', now });
      this.perkTellOn(record.customer_id, 'played', { game: game?.title || '' });
      out.back += 1;
    }
    // 4. the loans' emails
    Object.assign(out, this.perkLoanMails(now));
    return out;
  },

  /**
   * The emails about games at home (1.5, 1.7), at most GM_PERK.emailsPerRun a run, each marked before it goes so none
   * goes twice: a game that wants a book someone has (once a game a loan), the nudge a week after a session that wanted
   * it and a week after that email (once a loan), and one more ask for a perk book a week into the perk's rest (once a
   * loan). What each letter marked is kept (claims), so a batch Resend couldn't take is unmarked and goes on the next
   * run (deliverPerkLoanMails). → { told, nudged, asked }. No awaits.
   */
  perkLoanMails(now = Date.now()) {
    const sent = { told: 0, nudged: 0, asked: 0 };
    if (!this.perkMailsOn()) return sent;
    const tz = this.rulesCache?.tz || 'Pacific/Auckland';
    const loans = this.sql.exec("SELECT * FROM library_loans WHERE status = 'out' AND customer_id != '' ORDER BY out_at, created_at LIMIT ?", GM_PERK.loansPerRun).toArray();
    if (!loans.length) return sent;
    const letters = [];
    const claims = [];
    const room = () => letters.length < GM_PERK.emailsPerRun;
    const members = new Map();
    const memberOf = (id) => {
      if (!members.has(id)) members.set(id, this.memberRow(id));
      const m = members.get(id);
      return emailOf(m) ? m : null;
    };
    // (a) games that want a book someone has at home, not told about yet
    const wanted = this.wantedSessions(loans.map((l) => l.variant_id), now);
    for (const l of loans) {
      if (!room()) break;
      const borrower = String(l.customer_id);
      const told = new Set(parse(l.wanted_told, []));
      const games = new Map();
      for (const w of wanted.get(String(l.variant_id)) || []) {
        if (w.gm === borrower || told.has(w.key)) continue;
        if (!games.has(w.key)) games.set(w.key, { title: w.private ? 'A private game' : w.title, dates: [] });
        if (games.get(w.key).dates.length < GM_PERK.wantedShown) games.get(w.key).dates.push(w.at);
      }
      if (!games.size) continue;
      const member = memberOf(borrower);
      // told or not, these games are done for this loan: someone with no address can't be told later either. When the
      // email goes is kept too: the nudge never follows it inside a week
      const marked = JSON.stringify([...told, ...games.keys()].slice(-60));
      this.sql.exec(
        'UPDATE library_loans SET wanted_told = ?, wanted_told_at = CASE WHEN ? THEN ? ELSE wanted_told_at END WHERE id = ?',
        marked, member ? 1 : 0, now, l.id,
      );
      if (!member) continue;
      letters.push(this.wantedLetter(this.rowToLoan(l), member, [...games.values()], tz));
      claims.push({ kind: 'told', id: l.id, marked, was: l.wanted_told ?? null, wasAt: l.wanted_told_at ?? null });
      sent.told += 1;
    }
    // (b) the nudge: a session that wanted it started a week ago or more, while it was out, and its borrower was emailed
    // that a table wants it a week ago or more (so the two never land together after emails have been off)
    const due = now - GM_PERK.nudgeDays * DAY;
    const waiting = loans.filter((l) => !l.nudged_at && l.out_at < due && l.wanted_told_at && l.wanted_told_at <= due);
    if (waiting.length && room()) {
      const past = new Map();
      const ids = [...new Set(waiting.map((l) => String(l.variant_id)))];
      // (never about a session from more than 5 weeks back: emails that were off for a while don't nudge about old news)
      const oldest = Math.max(Math.min(...waiting.map((l) => l.out_at)), now - 35 * DAY);
      for (let i = 0; i < ids.length; i += 90) {
        const part = ids.slice(i, i + 90);
        for (const r of this.sql.exec(
          `SELECT b.variant_id AS variant_id, g.title AS title, g.starts_at AS starts_at, g.gm_customer_id AS gm, g.private AS private
             FROM game_books b JOIN games g ON g.id = b.game_id
            WHERE g.status = 'open' AND g.starts_at <= ? AND g.starts_at > ? AND b.variant_id IN (${part.map(() => '?').join(', ')})
            ORDER BY g.starts_at, g.id`,
          due, oldest, ...part,
        ).toArray()) {
          if (!past.has(String(r.variant_id))) past.set(String(r.variant_id), []);
          past.get(String(r.variant_id)).push({ title: r.private ? 'A private game' : r.title, at: r.starts_at, gm: r.gm ? String(r.gm) : '' });
        }
      }
      for (const l of waiting) {
        if (!room()) break;
        const session = (past.get(String(l.variant_id)) || []).find((s) => s.at > l.out_at && s.gm !== String(l.customer_id));
        if (!session) continue;
        this.sql.exec('UPDATE library_loans SET nudged_at = ? WHERE id = ? AND nudged_at IS NULL', now, l.id);
        const member = memberOf(String(l.customer_id));
        if (!member) continue;
        letters.push(this.nudgeLetter(this.rowToLoan(l), member, session, tz));
        claims.push({ kind: 'nudged', id: l.id });
        sent.nudged += 1;
      }
    }
    // (c) a perk book still at home a week into its GM perk's rest
    const restedBy = now - GM_PERK.backAskDays * DAY;
    for (const l of loans) {
      if (!room()) break;
      if (l.perk !== 'gm' || l.back_asked_at) continue;
      const record = this.perkRecord(l.customer_id);
      if (!record || record.status === 'on' || !['quiet', 'idle'].includes(record.off_reason) || !(record.off_at <= restedBy)) continue;
      this.sql.exec('UPDATE library_loans SET back_asked_at = ? WHERE id = ? AND back_asked_at IS NULL', now, l.id);
      const member = this.perkMailTo(l.customer_id);
      if (!member) continue;
      letters.push(this.backAskLetter(this.rowToLoan(l), member));
      claims.push({ kind: 'asked', id: l.id });
      sent.asked += 1;
    }
    if (letters.length) this.later(this.deliverPerkLoanMails(letters, claims, now));
    return sent;
  },

  /**
   * Send perkLoanMails' letters in one batch. Resend down or busy (a 5xx or a 429): what this run marked for them is
   * unmarked, so the next run tries again; anything else (an address Resend refused, or no answer at all) isn't tried
   * again, as with the booking reminders (deliverBookingReminders). After the await only these loans' marks change, and
   * only where they're still as this run set them.
   */
  async deliverPerkLoanMails(letters, claims, at) {
    const result = await this.mailMany(letters);
    if (!result.ok && (result.status >= 500 || result.status === 429)) {
      for (const c of claims) {
        if (c.kind === 'told') {
          this.sql.exec('UPDATE library_loans SET wanted_told = ?, wanted_told_at = ? WHERE id = ? AND wanted_told = ? AND wanted_told_at = ?', c.was, c.wasAt, c.id, c.marked, at);
        } else if (c.kind === 'nudged') this.sql.exec('UPDATE library_loans SET nudged_at = NULL WHERE id = ? AND nudged_at = ?', c.id, at);
        else this.sql.exec('UPDATE library_loans SET back_asked_at = NULL WHERE id = ? AND back_asked_at = ?', c.id, at);
      }
    }
    return result;
  },
};

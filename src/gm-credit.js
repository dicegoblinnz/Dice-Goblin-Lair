/**
 * Round 21 (26 Oct 2026, contract v21-gm-credit): a GM's own stamps, and GM credit that adds itself. From Mo, 26 Oct 2026:
 *  - "make sure to make the gm gets entry stamps even if they don't pay for the session. Unless the session got
 *    canceled." Then: "Staff gms don't get it. But yes since the card began is fine".
 *  - "have each player give the gm credit only when the payment have went through." Then: "Automatic from today."
 *
 * GM stamps. A GM's loyalty card gets one stamp for each session they ran since the card began, as a player's does for a
 * checked-in seat. A session counts once it has started, unless it's cancelled, and only with at least one player
 * booked on it (one nobody booked didn't run). Someone on the team (the main account, tagged staff in Shopify, or a
 * helper) gets none for the sessions they run. Whether a session's GM was on the team is looked up once, when the
 * 10-minute run first sees the session under way (gm_runs), so the card never waits on Shopify and a later change on
 * the Team tab doesn't move old stamps. Like every stamp, it's counted every time, never stored: a session cancelled
 * afterwards takes its stamp back.
 *
 * GM credit. For sessions from 26 October 2026 (Lair time), each player's seat gives its GM their GM fee in store credit
 * once the session has started and that seat is paid: online, at the counter, on a tab or bill, or by a session pass.
 * Round 30 (6 Nov 2026), from Mo: "have the ability to add the gm store credit after every client is paid inside a
 * game. So gms are incentivized to keep the players inside the system and using Thier app to pay for things". So a
 * seat's fee goes as soon as it's paid (a payment sets the run going at once: gmCreditSoon), not once the session's
 * over; one paid before the session goes when it starts. A seat paid later gives it later, and one never paid gives
 * nothing (nor do cancelled seats and no-shows). Each run gives one store credit for each GM; the 10-minute run catches
 * anything a payment didn't. Round 30, from Mo: "One email for all the players per session." So Shopify doesn't email
 * the GM about each one (notify false, the seat marked quiet), and an hour after the session ends Gobgob emails them
 * once (gmCreditMails, gm_credit_mails): who paid and what's landed. Anything that lands after that email does so
 * quietly. The team's "GM credit for staff" setting still decides
 * for staff GMs, by their hours for 'shifts'. Sessions from before 26 October keep the staff page's "Session done"
 * button (POST /games/:id/credit), and a session someone already credited that way is left alone. Nothing is taken
 * back by itself: a credited seat cancelled, marked a no-show or unpaid, or its session cancelled, tells staff.
 *
 * Each seat is recorded in gm_credit_seats before Shopify is asked, so no seat is ever credited twice:
 *  - 'sending': with Shopify now (one older than GM_CREDIT.sendingStale had no answer: it's 'check')
 *  - 'credited': on the GM's store credit
 *  - 'staff': kept from a staff GM (amount 0; note says what it would have been)
 *  - 'manual': the GM has no account in the Lair, so staff add it in Shopify admin (they get an email)
 *  - 'retry': Shopify said no, so nothing moved; tried again GM_CREDIT.retryAfter (10 minutes) later at the soonest,
 *    GM_CREDIT.maxTries times in all
 *  - 'failed': Shopify said no every time (staff get an email)
 *  - 'check': Shopify didn't answer, so it may have gone; never tried again by itself (staff get an email)
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { HOUR, RuleError, makeId } from './core.js';
import { bookingStamps } from './stamps.js';
import { emailReady } from './shopify.js';

export const GM_CREDIT = Object.freeze({
  // Mo, 26 Oct 2026: "Automatic from today": sessions starting from midnight that day, Lair time (NZDT, UTC+13)
  autoFrom: Date.parse('2026-10-26T00:00:00+13:00'),
  // GMs given store credit in one run (each is one call to Shopify and one email from it); the rest wait for the next run
  gmsPerRun: 20,
  // seats looked at in one run
  seatsPerRun: 500,
  // sessions whose GM is checked against the team in one run, and the GMs asked about (Shopify tags, kept 5 minutes)
  runsPerRun: 50,
  lookupsPerRun: 10,
  // how long one store credit may take before it gives up, and how long one may stay with Shopify before it counts as
  // unanswered (the Lair restarted mid-call)
  timeoutMs: 20_000,
  sendingStale: 30 * 60_000,
  // Shopify said no: tried again this many times in all, each at least retryAfter after the last (round 30: a payment
  // starts a run of its own, so without the wait a busy Shopify could use every try up in a couple of minutes)
  maxTries: 5,
  retryAfter: 10 * 60_000,
  // round 30, one email a session: sent this long after the session ends (late payers at the counter still count), or
  // once some of its credit lands, when that's later (a monthly account's bill); never when none of it landed in the
  // last mailWithin (email that was off for days doesn't send about old sessions); at most this many a run; and a claim
  // with no answer after mailStale (the Lair restarted mid-send) is tried again, with the same key
  mailAfter: HOUR,
  mailWithin: 48 * HOUR,
  mailsPerRun: 20,
  mailStale: 30 * 60_000,
});

/** Whether a session's GM credit adds itself (round 21), rather than waiting for "Session done" */
export const autoCredit = (game) => Number(game?.start ?? game?.starts_at) >= GM_CREDIT.autoFrom;

/**
 * Round 17's mark on a round 21 session, for the 'shifts' setting (creditGmNow): the main account said its staff GM was
 * working then (gm_on_shift 1) or wasn't (0), whatever their hours say, and who said so (made when missing)
 */
export const GM_CREDIT_COLUMNS = [['games', 'gm_on_shift', 'INTEGER'], ['games', 'gm_on_shift_by', 'TEXT']];

/** The round 21 tables (made when missing) */
export const GM_CREDIT_TABLES = [
  // gm_runs: for each session under way, whether its GM was on the team then (staff 1: no GM stamp). customer_id is the
  // GM it was checked for: a session given to another GM is checked again.
  `CREATE TABLE IF NOT EXISTS gm_runs (
     game_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, staff INTEGER NOT NULL, at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS gm_runs_customer ON gm_runs (customer_id)',
  // gm_credit_seats: each player's seat in a session from round 21 on, once its GM credit is decided (status above).
  // customer_id: the GM (null: no account); people: the players on it; amount: cents to the GM (0 when kept); batch: the
  // one store credit it went in
  `CREATE TABLE IF NOT EXISTS gm_credit_seats (
     booking_id TEXT PRIMARY KEY, game_id TEXT NOT NULL, customer_id TEXT, people INTEGER NOT NULL, amount INTEGER NOT NULL,
     status TEXT NOT NULL, batch TEXT, note TEXT, tries INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS gm_credit_seats_game ON gm_credit_seats (game_id)',
  'CREATE INDEX IF NOT EXISTS gm_credit_seats_status ON gm_credit_seats (status, updated_at)',
  // round 30: one email a session, to each GM who had credit for it (status 'sending' while it goes, 'sent', 'failed')
  `CREATE TABLE IF NOT EXISTS gm_credit_mails (
     game_id TEXT NOT NULL, customer_id TEXT NOT NULL, players INTEGER NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL,
     created_at INTEGER NOT NULL, sent_at INTEGER, PRIMARY KEY (game_id, customer_id))`,
];

/**
 * Round 30: quiet, on a seat whose credit Shopify didn't email the GM about (1): the session's one email covers it.
 * Made sure of once gm_credit_seats is there; 0 for every seat credited before.
 */
export const GM_CREDIT_SEAT_COLUMNS = [['gm_credit_seats', 'quiet', 'INTEGER NOT NULL DEFAULT 0']];

/**
 * The sessions that earn their GM a stamp, as stampedSessions' columns (id, kind 'gm-run', at, people 1, tables,
 * occurrence_id, game_title, join_title, via 'run'). Three bound values: the GM's customer ID, the loyalty start, then when today
 * ends (round 22's stampsUntil). A player's seat is what says it ran (not the GM's own, if they booked one), or players
 * the group had who don't book through the Lair (offline_players); a GM with a seat of their own session that stamps
 * (checked in, or round 22: paid once its day has come) has that seat's stamp already, so the session gives them no
 * second one.
 */
export const GM_STAMP_ROWS = `
  SELECT g.id AS id, 'gm-run' AS kind, g.starts_at AS at, 1 AS people, g.tables AS tables, NULL AS occurrence_id, g.title AS game_title, NULL AS join_title,
         'run' AS via
    FROM gm_runs r JOIN games g ON g.id = r.game_id AND g.gm_customer_id = r.customer_id
   WHERE r.customer_id = ? AND r.staff = 0 AND g.status IN ('open', 'full') AND g.starts_at >= ?
     AND (COALESCE(g.offline_players, 0) > 0
       OR EXISTS (SELECT 1 FROM bookings s WHERE s.game_id = g.id AND s.kind = 'gm-seat' AND s.status IN ('confirmed', 'seated', 'done')
                   AND (s.customer_id IS NULL OR s.customer_id != r.customer_id)))
     AND NOT EXISTS (SELECT 1 FROM bookings s WHERE s.game_id = g.id AND s.kind = 'gm-seat' AND s.customer_id = r.customer_id AND ${bookingStamps('s')})`;

/** Every message the staff page or a GM can see, word for word in the contract */
export const GM_CREDIT_WORDS = {
  stampTitle: (title) => `${title || 'TTRPG session'} (you ran it)`,
  // (round 30: once it's started, as each player pays; it was once it was over)
  notStarted: "GM credit adds itself for this session: once it's started, the GM gets their fee as each player pays. There's nothing to tap.",
  nothingYet: "Nothing to add yet: the GM gets their fee for each player once they've paid.",
  allDone: "Done: the GM has had their fee for every player who's paid.",
  /** (round 21, part 2) */
  covered: "The GM pays for their players' seats on this session, so there's no GM credit to add.",
  sending: "Gobgob is adding the GM's credit right now. Check again in a minute.",
  free: "This session was free, so there's no GM credit to add.",
  noFee: "This GM covers their players' fee, so there's no store credit to add.",
  marked: "The GM's credit has gone to them already, so it can't be kept now. Take it off their store credit on their member page if it shouldn't have gone.",
  markedOn: "Marked: they were working, so there's no GM credit for this session.",
  markedOff: "Marked: they weren't working, so they get their GM credit as their players pay.",
  undone: (gm, amount, seat, why) => `${gm} got ${amount} GM credit for ${seat}, but that seat ${why}. If ${gm} shouldn't keep it, take it off their store credit on their member page.`,
  // the seat's why, for undone
  unpaid: "isn't marked paid any more",
  noShow: 'was marked a no-show',
  cancelled: 'was cancelled',
  noAccount: "The GM isn't linked to a customer account, so add the store credit in Shopify admin.",
  // round 30: the one email a session
  mailSubject: (title, amount) => `Your GM credit for ${title}: ${amount}`,
  mailTitle: (title) => `Thanks for running ${title}!`,
  mailIntro: (first, amount, title, each, players) => `Kia ora ${first}, ${amount} of store credit is on your account for ${title}: ${
    each ? (players === 1 ? `${each} for the 1 player who paid` : `${each} for each of the ${players} players who paid`) : `for the ${players} players who paid`}.`,
  mailLater: (each) => `Anyone who pays later still sends you their ${each || 'GM fee'}. It lands on your store credit without an email, and My Lair shows it under Games I run.`,
  refused: (said) => `Shopify didn't add the store credit (${said}). Nothing moved. Gobgob tries again in 10 minutes.`,
  failed: (said) => `Shopify didn't add the store credit after ${GM_CREDIT.maxTries} tries (${said}). Nothing moved. Add it in Shopify admin.`,
  check: (said) => `Shopify didn't confirm the store credit (${said}), so it may have gone through. Check the GM's store credit in Shopify admin before adding any.`,
  stale: "Shopify didn't answer about the store credit, so it may have gone through. Check the GM's store credit in Shopify admin before adding any.",
};

const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const players = (n) => `${n} ${n === 1 ? 'player' : 'players'}`;
const said = (error) => String(error?.message || error || 'no answer').replace(/^Shopify API:\s*/, '').slice(0, 160);
// the ledger's statuses that count as done for the session (its "credited" count)
const DONE = ['credited', 'staff'];

export const gmCreditMethods = {
  /* ---------------- GM stamps ---------------- */

  /**
   * The 10-minute run: for sessions under way or over since the loyalty start (not cancelled, with a GM account), whether
   * their GM was on the team then, once each (gm_runs): the main account (tagged staff in Shopify), or a helper at the
   * time the session started (the team's log, staff_log, says when each was made a helper and when they stopped). A GM
   * whose tags Shopify couldn't read is asked again next run, unless they were a helper then. Returns { looked } or
   * null. Awaits Shopify's tags (taggedPerson: kept 5 minutes).
   */
  async gmRunUpkeep(now = Date.now()) {
    const rows = this.sql
      .exec(
        `SELECT g.id AS id, g.gm_customer_id AS gm, g.starts_at AS start FROM games g
          WHERE g.gm_customer_id IS NOT NULL AND g.status IN ('open', 'full') AND g.starts_at >= ? AND g.starts_at <= ?
            AND NOT EXISTS (SELECT 1 FROM gm_runs r WHERE r.game_id = g.id AND r.customer_id = g.gm_customer_id)
          ORDER BY g.starts_at LIMIT ?`,
        this.loyaltyFrom, now, GM_CREDIT.runsPerRun,
      )
      .toArray();
    if (!rows.length) return null;
    // the main account's tags (null: Shopify couldn't say)
    const owner = new Map();
    for (const id of [...new Set(rows.map((r) => String(r.gm)))].slice(0, GM_CREDIT.lookupsPerRun)) {
      const person = await this.taggedPerson(id);
      owner.set(id, person?.tagsFailed ? null : Boolean(person?.staff));
    }
    // --- no awaits from here on ---
    let looked = 0;
    for (const r of rows) {
      const id = String(r.gm);
      if (!owner.has(id)) continue;
      const helper = this.helperAt(id, r.start);
      // (a GM Shopify couldn't say about waits for the next run, unless they were a helper then)
      if (owner.get(id) === null && !helper) continue;
      const staff = helper || owner.get(id);
      this.write(
        `INSERT INTO gm_runs (game_id, customer_id, staff, at) VALUES (?, ?, ?, ?)
         ON CONFLICT(game_id) DO UPDATE SET customer_id = excluded.customer_id, staff = excluded.staff, at = excluded.at`,
        r.id, id, staff ? 1 : 0, Date.now(),
      );
      looked += 1;
    }
    return looked ? { looked } : null;
  },

  /**
   * Whether someone was a helper at a time (ms), from the team's log (staff_log: 'added', 'changed', 'removed'): the
   * last entry before then says. Nothing logged before then: not a helper then (they were made one later), unless
   * nothing's logged for them at all, when it's whether they're one now. No awaits.
   */
  helperAt(customerId, at) {
    const before = this.sql.exec('SELECT action FROM staff_log WHERE customer_id = ? AND at <= ? ORDER BY at DESC, rowid DESC LIMIT 1', String(customerId), at).toArray()[0];
    if (before) return before.action !== 'removed';
    if (this.sql.exec('SELECT 1 FROM staff_log WHERE customer_id = ? LIMIT 1', String(customerId)).toArray().length) return false;
    return Boolean(this.helperRow(customerId));
  },

  /* ---------------- GM credit that adds itself ---------------- */

  /**
   * The seats ready for their GM's credit now: in a round 21 session that has started (round 30: it was one that was
   * over) and isn't cancelled, free or without a GM fee, that nobody credited with "Session done" (a credits row of
   * theirs, or credited set with nothing in the ledger: a tap whose answer never came back); paid (amount over $0: a
   * free seat isn't a paying player's) and not cancelled or a no-show; not decided yet, or Shopify said no last time
   * and that was GM_CREDIT.retryAfter ago or more (retryNow: whenever it was, for staff's Session done). gameId: just
   * that session's. No awaits.
   */
  gmCreditReady(now, rules, gameId = null, { retryNow = false } = {}) {
    return this.sql
      .exec(
        `SELECT b.id AS booking_id, b.game_id AS game_id, b.people AS people, g.gm_customer_id AS gm,
             COALESCE(g.gm_fee, ?) AS fee, s.status AS was, COALESCE(s.tries, 0) AS tries
           FROM bookings b JOIN games g ON g.id = b.game_id
           LEFT JOIN gm_credit_seats s ON s.booking_id = b.id
          WHERE b.kind = 'gm-seat' AND b.paid = 1 AND b.amount > 0 AND b.status IN ('confirmed', 'seated', 'done')
            AND g.starts_at >= ? AND g.starts_at <= ? AND g.status IN ('open', 'full') AND COALESCE(g.free, 0) = 0
            AND COALESCE(g.gm_fee, ?) > 0
            AND NOT EXISTS (SELECT 1 FROM credits c WHERE c.game_id = g.id AND COALESCE(c.by, '') != 'auto')
            AND NOT (g.credited IS NOT NULL AND NOT EXISTS (SELECT 1 FROM gm_credit_seats x WHERE x.game_id = g.id))
            AND (s.booking_id IS NULL OR (s.status = 'retry' AND s.updated_at <= ?))
            ${gameId ? 'AND g.id = ?' : ''}
          ORDER BY g.ends_at, b.created_at, b.id LIMIT ?`,
        rules.prices.gmCredit, GM_CREDIT.autoFrom, now, rules.prices.gmCredit, retryNow ? now : now - GM_CREDIT.retryAfter, ...(gameId ? [gameId] : []), GM_CREDIT.seatsPerRun,
      )
      .toArray();
  },

  /**
   * The 10-minute run, a payment's run (gmCreditSoon) and "Session done" on a round 21 session that's started: every seat
   * ready for its GM's credit gets it, one store credit for each GM. gameId: just that session's seats. Returns
   * { credited, amount, staff, manual, retry, failed, check } (players each, amount in cents) when anything was decided,
   * else null. Never throws for Shopify: what Shopify says is recorded on the seats. retryNow: seats Shopify said no to
   * are tried again however recently that was (staff's Session done; the runs wait GM_CREDIT.retryAfter).
   */
  async autoGmCredit(now = Date.now(), { gameId = null, retryNow = false } = {}) {
    if (!this.shopify?.configured) return null;
    const rules = await this.rules();
    const out = { credited: 0, amount: 0, staff: 0, manual: 0, retry: 0, failed: 0, check: 0 };
    this.staleGmCredits(Date.now(), out);
    const ready = this.gmCreditReady(now, rules, gameId, { retryNow });
    const gms = [...new Set(ready.map((r) => String(r.gm || '')))];
    // GMs with no account: staff add it in Shopify admin
    if (gms.includes('')) this.gmCreditManual(ready.filter((r) => !r.gm), rules, out);
    for (const gm of gms.filter(Boolean).slice(0, GM_CREDIT.gmsPerRun)) {
      const person = await this.person(gm);
      // (as "Session done": a GM whose tags couldn't be read isn't paid while the setting could keep it from them)
      if (person?.tagsFailed && !person.staff && this.staffGmMode() !== 'earn') continue;
      // --- no awaits from here until the seats are claimed ---
      const mine = this.gmCreditReady(Date.now(), rules, gameId, { retryNow }).filter((r) => String(r.gm || '') === gm);
      if (!mine.length) continue;
      const batch = makeId('gc');
      const at = Date.now();
      const sending = [];
      for (const [id, seats] of groupBy(mine, (r) => r.game_id)) {
        const game = this.game(id);
        if (!game || String(game.gmCustomerId || '') !== gm) continue;
        const count = seats.reduce((n, r) => n + r.people, 0);
        const due = seats.reduce((n, r) => n + r.people * r.fee, 0);
        // (round 17's mark, for 'shifts': the main account said they were working then, or weren't)
        const rule = this.staffGmRule(game, person, rules, game.gmOnShift ?? null);
        const markedBy = rule?.marked ? this.markerName(game.gmOnShiftBy) : '';
        if (rule && !rule.credit) {
          const note = this.staffGmNote(rule, game, due, count, markedBy);
          for (const r of seats) this.saveGmCreditSeat(r, gm, { amount: 0, status: 'staff', batch, note, at });
          this.recordGmCredit(id, gm, { players: count, amount: 0, status: 'staff', note, at });
          out.staff += count;
          continue;
        }
        const note = rule ? this.staffGmNote(rule, game, due, count, markedBy) : '';
        for (const r of seats) this.saveGmCreditSeat(r, gm, { amount: r.people * r.fee, status: 'sending', batch, note, at });
        sending.push({ id, count, due, note });
      }
      const total = sending.reduce((n, s) => n + s.due, 0);
      if (!total) continue;
      // --- claimed: now Shopify. Afterwards only this batch's seats are touched ---
      let error = null;
      try {
        // (round 30: no email from Shopify each time; the session's one email from Gobgob covers it)
        await this.shopify.creditCustomer(gm, total, this.env.CURRENCY || 'NZD', { timeout: GM_CREDIT.timeoutMs, notify: false });
      } catch (e) {
        error = e;
        console.error('Lair: GM store credit failed', e);
      }
      // --- no awaits from here on (for this GM) ---
      this.finishGmCredit(batch, gm, sending, error, out);
    }
    const decided = out.credited + out.staff + out.manual + out.retry + out.failed + out.check;
    return decided ? out : null;
  },

  /**
   * Round 30: GM credit straight after a payment (a seat paid at the counter, online, on a tab or bill, with cash, or
   * marked paid by staff), so a GM sees their fee as each player pays instead of after the 10-minute run. It runs the
   * same autoGmCredit in the background, one run at a time: a payment while one is going asks it to look again once
   * it's done, so nothing waits for the next 10 minutes. Seats are claimed before Shopify is asked, so this and the
   * 10-minute run never pay a seat twice. Returns the run (gmCreditRun, kept until it's done), or null. No awaits.
   */
  gmCreditSoon() {
    if (!this.shopify?.configured) return null;
    if (this.gmCreditRun) {
      this.gmCreditAgain = true;
      return this.gmCreditRun;
    }
    // nothing ready (a seat paid ahead of its session, or no GM fee to give): nothing to ask Shopify, the runs take it
    if (this.rulesCache && !this.gmCreditReady(Date.now(), this.rulesCache).length) return null;
    const run = (async () => {
      // (after whatever wrote the payment has finished)
      await Promise.resolve();
      try {
        do {
          this.gmCreditAgain = false;
          await this.autoGmCredit(Date.now());
        } while (this.gmCreditAgain);
      } finally {
        this.gmCreditRun = null;
        this.gmCreditAgain = false;
      }
    })();
    this.gmCreditRun = run;
    return this.later(run);
  },

  /**
   * Whether a session's GM credit has started going (a seat with Shopify, credited, kept, to check or added by hand), so
   * its GM can't change now (POST /games/:id/gm). Shopify saying no left nothing moved, so that doesn't count. No awaits.
   */
  gmCreditStarted(gameId) {
    return this.sql.exec("SELECT 1 FROM gm_credit_seats WHERE game_id = ? AND status IN ('sending', 'credited', 'staff', 'check', 'manual') LIMIT 1", gameId).toArray().length > 0;
  },

  /**
   * After staff change a seat (updateBooking): one whose GM credit has gone to its GM, now not marked paid (its payment
   * undone) or taken off (cancelled, or a no-show), means the GM may have credit for a seat nobody paid for. Nothing's
   * taken back by itself: staff hear, once a day for each seat, and decide. No awaits.
   */
  gmCreditUndone(before, after) {
    const row = this.sql.exec("SELECT * FROM gm_credit_seats WHERE booking_id = ? AND status = 'credited'", after.id).toArray()[0];
    if (!row) return;
    const unpaid = before.paid && !after.paid;
    const off = !['cancelled', 'noshow'].includes(before.status) && ['cancelled', 'noshow'].includes(after.status);
    if (!unpaid && !off) return;
    const game = this.game(row.game_id);
    const gm = (row.customer_id && this.memberName ? this.memberName(row.customer_id) : '') || game?.gm || 'The GM';
    const seat = `${String(after.name || 'a player').split(' ')[0]}'s seat at ${game?.title || 'their session'}`;
    const why = unpaid ? GM_CREDIT_WORDS.unpaid : after.status === 'noshow' ? GM_CREDIT_WORDS.noShow : GM_CREDIT_WORDS.cancelled;
    this.staffAlert(`gm-credit-undone:${after.id}`, `GM credit to check: ${gm}`, {
      title: 'GM credit to check',
      intro: GM_CREDIT_WORDS.undone(gm, money(row.amount), seat, why),
      details: [['GM', gm], ['Seat', after.ref], ['GM credit', money(row.amount)]],
    });
  },

  /** One seat's record, written before Shopify is asked (or with what was decided). No awaits. */
  saveGmCreditSeat(r, gm, { amount, status, batch, note, at }) {
    this.write(
      `INSERT INTO gm_credit_seats (booking_id, game_id, customer_id, people, amount, status, batch, note, tries, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(booking_id) DO UPDATE SET customer_id = excluded.customer_id, people = excluded.people, amount = excluded.amount,
         status = excluded.status, batch = excluded.batch, note = excluded.note, updated_at = excluded.updated_at`,
      r.booking_id, r.game_id, gm || null, r.people, amount, status, batch, note || null, r.tries || 0, at, at,
    );
  },

  /**
   * After Shopify answered (or didn't) for one GM's store credit: the batch's seats are credited, tried again next run
   * (Shopify said no: nothing moved), failed (it said no every time) or to check (no answer). No awaits.
   */
  finishGmCredit(batch, gm, sending, error, out) {
    const at = Date.now();
    const seats = this.sql.exec("SELECT * FROM gm_credit_seats WHERE batch = ? AND status = 'sending'", batch).toArray();
    if (!error) {
      this.write("UPDATE gm_credit_seats SET status = 'credited', quiet = 1, updated_at = ? WHERE batch = ? AND status = 'sending'", at, batch);
      for (const s of sending) this.recordGmCredit(s.id, gm, { players: s.count, amount: s.due, status: 'credited', note: s.note, at });
      out.credited += seats.reduce((n, r) => n + r.people, 0);
      out.amount += seats.reduce((n, r) => n + r.amount, 0);
      return;
    }
    const name = this.memberName ? this.memberName(gm) : gm;
    const total = seats.reduce((n, r) => n + r.amount, 0);
    const count = seats.reduce((n, r) => n + r.people, 0);
    const refused = Boolean(error?.refused);
    if (refused) {
      // each seat counts its own tries: one new to this batch isn't failed by another's fifth
      const failed = [];
      for (const r of seats) {
        const last = (r.tries || 0) + 1 >= GM_CREDIT.maxTries;
        this.write(
          'UPDATE gm_credit_seats SET status = ?, tries = tries + 1, note = ?, updated_at = ? WHERE booking_id = ? AND status = \'sending\'',
          last ? 'failed' : 'retry', last ? GM_CREDIT_WORDS.failed(said(error)) : GM_CREDIT_WORDS.refused(said(error)), at, r.booking_id,
        );
        if (last) failed.push(r);
        else out.retry += r.people;
      }
      if (failed.length) {
        const lost = failed.reduce((n, r) => n + r.amount, 0);
        const who = failed.reduce((n, r) => n + r.people, 0);
        out.failed += who;
        this.staffAlert(`gm-credit-failed:${batch}`, `GM credit to add by hand: ${name}`, {
          title: 'GM credit Shopify wouldn\'t add',
          intro: `Shopify said no to ${name}'s GM credit ${GM_CREDIT.maxTries} times, so nothing was added. Add ${money(lost)} to their store credit in Shopify admin.`,
          details: [['GM', name], ['Store credit', money(lost)], ['For', players(who)], ['Shopify said', said(error)]],
        }, at);
      }
      return;
    }
    const note = GM_CREDIT_WORDS.check(said(error));
    this.write("UPDATE gm_credit_seats SET status = 'check', note = ?, updated_at = ? WHERE batch = ? AND status = 'sending'", note, at, batch);
    out.check += count;
    this.staffAlert(`gm-credit-check:${batch}`, `Check a GM's store credit: ${name}`, {
      title: 'Did the GM credit go through?',
      intro: `Gobgob asked Shopify to add ${money(total)} to ${name}'s store credit, but Shopify didn't answer, so it may have gone through. Look at their store credit in Shopify admin: if it's there, you're done. If it isn't, add it there. Gobgob won't try again by itself, so it's never added twice.`,
      details: [['GM', name], ['Store credit', money(total)], ['For', players(count)], ['Shopify said', said(error)]],
    }, at);
  },

  /** Seats a GM with no account would earn for: staff add it in Shopify admin (an email for each session). No awaits. */
  gmCreditManual(rows, rules, out) {
    const at = Date.now();
    for (const [id, seats] of groupBy(rows, (r) => r.game_id)) {
      const game = this.game(id);
      if (!game || game.gmCustomerId) continue;
      const count = seats.reduce((n, r) => n + r.people, 0);
      const due = seats.reduce((n, r) => n + r.people * r.fee, 0);
      const batch = makeId('gc');
      for (const r of seats) this.saveGmCreditSeat(r, null, { amount: r.people * r.fee, status: 'manual', batch, note: GM_CREDIT_WORDS.noAccount, at });
      this.recordGmCredit(id, null, { players: count, amount: due, status: 'manual', note: GM_CREDIT_WORDS.noAccount, at });
      out.manual += count;
      this.staffAlert(`gm-credit-manual:${batch}`, `GM credit to add by hand: ${game.gm || 'a GM'}`, {
        title: 'GM credit to add by hand',
        intro: `${game.gm || 'The GM'} ran ${game.title}, and ${players(count)} paid, but the session isn't linked to their customer account. Add ${money(due)} to their store credit in Shopify admin.`,
        details: [['GM', `${game.gm || 'Unknown'}${game.gmEmail ? ` (${game.gmEmail})` : ''}`], ['Session', `${game.title}, ${this.shortDay ? this.shortDay(game.start, rules) : new Date(game.start).toISOString().slice(0, 10)}`], ['Store credit', money(due)], ['For', players(count)]],
      }, at);
    }
  },

  /**
   * A store credit that's been with Shopify too long had no answer (the Lair restarted mid-call): it may have gone, so
   * its seats are 'check' and staff hear. No awaits.
   */
  staleGmCredits(now, out) {
    const stale = this.sql.exec("SELECT * FROM gm_credit_seats WHERE status = 'sending' AND updated_at < ?", now - GM_CREDIT.sendingStale).toArray();
    for (const [batch, seats] of groupBy(stale, (r) => r.batch)) {
      this.write("UPDATE gm_credit_seats SET status = 'check', note = ?, updated_at = ? WHERE batch = ? AND status = 'sending'", GM_CREDIT_WORDS.stale, now, batch);
      const gm = seats[0].customer_id;
      const name = gm && this.memberName ? this.memberName(gm) : 'a GM';
      const total = seats.reduce((n, r) => n + r.amount, 0);
      const count = seats.reduce((n, r) => n + r.people, 0);
      out.check += count;
      this.staffAlert(`gm-credit-check:${batch}`, `Check a GM's store credit: ${name}`, {
        title: 'Did the GM credit go through?',
        intro: `Gobgob asked Shopify to add ${money(total)} to ${name}'s store credit, but Shopify didn't answer, so it may have gone through. Look at their store credit in Shopify admin: if it's there, you're done. If it isn't, add it there. Gobgob won't try again by itself, so it's never added twice.`,
        details: [['GM', name], ['Store credit', money(total)], ['For', players(count)]],
      }, now);
    }
  },

  /**
   * A session's GM credit, as the staff page and My Lair have always seen it: a credits row (by 'auto'), and the
   * session's credited count (the players credited or kept so far), so "Session done" and a GM change see it's done.
   * No awaits.
   */
  recordGmCredit(gameId, gm, { players: count, amount, status, note, at }) {
    this.write(
      'INSERT INTO credits (id, game_id, customer_id, players, amount, status, note, created_at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      makeId('cr'), gameId, gm || null, count, amount, status, note || '', at, 'auto',
    );
    const done = this.sql
      .exec(`SELECT COALESCE(SUM(people), 0) AS n, COUNT(*) AS rows FROM gm_credit_seats WHERE game_id = ? AND status IN (${DONE.map(() => '?').join(', ')})`, gameId, ...DONE)
      .one();
    this.write('UPDATE games SET credited = ?, updated_at = ? WHERE id = ?', done.rows ? done.n : null, at, gameId);
  },

  /**
   * POST /games/:id/credit for a round 21 session (creditGm hands it here): GM credit adds itself, so this just does
   * now what the next run would, for this session. onShift (the main account, the 'shifts' setting; creditGm checked
   * who may send it): round 17's mark that a staff GM was working then (true) or wasn't (false), whatever their hours
   * say, kept on the session for the runs to come. Marked "wasn't working" after their seats were kept from them, those
   * seats are decided again (so they're paid now); marked "was working" once something's gone to them: 409 (marked).
   * Before the session's started (round 30: it was before it was over): 409 (notStarted), or with a mark, { status:
   * 'marked', note } (kept for the runs once it's started). After: { players, amount, status, note, auto: true }
   * for what this tap did: 'credited' (amount), 'staff', 'manual' (amount: to add by hand), 'check', 'retry' or 'failed'
   * (with that seat's note). With nothing to do now: where the session is up to ('sending' while another run has it
   * with Shopify, then 'check', 'failed', 'retry' or 'manual'), or 'none' with why (a free session, a $0 GM fee, a
   * seat still to pay, or all done).
   */
  async creditGmNow(game, now = Date.now(), { onShift = null, who = null } = {}) {
    if (typeof onShift === 'boolean') {
      this.markOnShift(game, onShift, who);
      // marked ahead of time: kept for the runs once it's started
      if (game.start > now) return { players: 0, amount: 0, status: 'marked', note: onShift ? GM_CREDIT_WORDS.markedOn : GM_CREDIT_WORDS.markedOff, auto: true };
    }
    if (game.start > now) throw new RuleError(GM_CREDIT_WORDS.notStarted, 409);
    // what this tap did: this session's seats that changed while it ran (another session's are never counted)
    const read = () => this.sql.exec('SELECT booking_id, status, people, amount, note, batch, updated_at FROM gm_credit_seats WHERE game_id = ? ORDER BY updated_at DESC, booking_id', game.id).toArray();
    const key = (r) => `${r.status}|${r.batch || ''}|${r.updated_at}`;
    const was = new Map(read().map((r) => [r.booking_id, key(r)]));
    // (a tap is staff asking for it now: a seat Shopify said no to is tried again straight away)
    await this.autoGmCredit(now, { gameId: game.id, retryNow: true });
    const seats = read();
    const sum = (list) => ({ players: list.reduce((n, s) => n + s.people, 0), amount: list.reduce((n, s) => n + s.amount, 0) });
    const order = ['check', 'failed', 'retry', 'manual', 'staff', 'credited'];
    const mine = seats.filter((s) => was.get(s.booking_id) !== key(s));
    const happened = order.find((k) => mine.some((s) => s.status === k));
    const answer = (status, list) => {
      const { players, amount } = sum(list);
      return { players, amount: ['credited', 'manual'].includes(status) ? amount : 0, status, note: list[0]?.note || '', auto: true };
    };
    if (happened) return answer(happened, mine.filter((s) => s.status === happened));
    // nothing done now: where it's up to
    const sending = seats.filter((s) => s.status === 'sending');
    if (sending.length) return { ...answer('sending', sending), note: GM_CREDIT_WORDS.sending };
    const before = order.slice(0, 4).find((k) => seats.some((s) => s.status === k));
    if (before) return answer(before, seats.filter((s) => s.status === before));
    const fresh = this.game(game.id) || game;
    if (fresh.free) return { players: 0, amount: 0, status: 'none', note: GM_CREDIT_WORDS.free, auto: true };
    if ((fresh.gmFee ?? 1) === 0) return { players: 0, amount: 0, status: 'none', note: GM_CREDIT_WORDS.noFee, auto: true };
    const unpaid = this.sql
      .exec("SELECT COUNT(*) AS n FROM bookings WHERE game_id = ? AND kind = 'gm-seat' AND paid = 0 AND waived = 0 AND amount > 0 AND status IN ('confirmed', 'seated', 'done')", game.id)
      .one().n;
    // (round 21, part 2: a session whose GM pays for every player's seat has no GM credit to come)
    const covered = !unpaid && !seats.length && this.sql
      .exec("SELECT COUNT(*) AS n FROM bookings WHERE game_id = ? AND kind = 'gm-seat' AND covered_by IS NOT NULL AND status IN ('confirmed', 'seated', 'done')", game.id)
      .one().n;
    if (covered) return { players: 0, amount: 0, status: 'none', note: GM_CREDIT_WORDS.covered, auto: true };
    return { players: 0, amount: 0, status: 'none', note: unpaid || !seats.length ? GM_CREDIT_WORDS.nothingYet : GM_CREDIT_WORDS.allDone, auto: true };
  },

  /**
   * Round 17's mark on a round 21 session (creditGmNow): kept on the session (gm_on_shift, gm_on_shift_by). "Wasn't
   * working" frees the seats kept from them to be decided again; "was working" once anything's gone to them: 409. No
   * awaits.
   */
  markOnShift(game, onShift, who) {
    if (onShift) {
      const gone = this.sql.exec("SELECT COUNT(*) AS n FROM gm_credit_seats WHERE game_id = ? AND status IN ('sending', 'credited', 'check')", game.id).one().n;
      if (gone) throw new RuleError(GM_CREDIT_WORDS.marked, 409);
    }
    const now = Date.now();
    this.write('UPDATE games SET gm_on_shift = ?, gm_on_shift_by = ?, updated_at = ? WHERE id = ?', onShift ? 1 : 0, who?.customerId ? String(who.customerId) : null, now, game.id);
    if (!onShift) {
      this.write("DELETE FROM gm_credit_seats WHERE game_id = ? AND status = 'staff'", game.id);
      // (the session's credited count follows: only what's credited stays)
      const done = this.sql.exec(`SELECT COALESCE(SUM(people), 0) AS n, COUNT(*) AS rows FROM gm_credit_seats WHERE game_id = ? AND status IN (${DONE.map(() => '?').join(', ')})`, game.id, ...DONE).one();
      this.write('UPDATE games SET credited = ?, updated_at = ? WHERE id = ?', done.rows ? done.n : null, now, game.id);
    }
  },

  /** The first name of whoever marked a staff GM's session (the main account), for the note. No awaits. */
  markerName(customerId) {
    if (!customerId) return '';
    const m = this.memberRow(customerId);
    return m ? m.first_name || String(m.name || '').split(' ')[0] || '' : '';
  },

  /**
   * For the floor (staff who see GM credit): round 21 sessions' GM credit so far, by game ID, from..to: { auto: true,
   * credited, staff, manual, check, failed, retry: { players, amount } (what's been decided, whatever's happened to the
   * seat since), toCome: { players } (paid seats not decided yet: the session hasn't started, or a run has them now),
   * unpaid: { players } (seats still to pay), covered: { players } (part 2: seats the GM pays for, no credit) }. A
   * session someone credited with Session done before round 21 went live isn't in it (its card says what that did).
   * No awaits.
   */
  gmCreditsIn(from, to, rules) {
    const fee = rules.prices.gmCredit;
    const out = new Map();
    // The sessions, as a filter the later queries reuse as a subquery: never one bound value per session, because SQLite
    // in a Durable Object takes at most 100 bound values a query (27 Oct 2026: a list of them broke the staff floor)
    const PICK = `FROM games g
          WHERE g.starts_at >= ? AND g.ends_at > ? AND g.starts_at < ?
            AND NOT EXISTS (SELECT 1 FROM credits c WHERE c.game_id = g.id AND COALESCE(c.by, '') != 'auto')
            AND NOT (g.credited IS NOT NULL AND NOT EXISTS (SELECT 1 FROM gm_credit_seats x WHERE x.game_id = g.id))`;
    const picked = [GM_CREDIT.autoFrom, from, to];
    const games = this.sql.exec(`SELECT g.id AS id, g.free AS free, COALESCE(g.gm_fee, ?) AS fee ${PICK}`, fee, ...picked).toArray();
    const byId = new Map(games.map((g) => [g.id, g]));
    for (const g of games) out.set(g.id, this.gmCreditBlank());
    if (!games.length) return out;
    // what's been decided, whatever's happened to the seat since
    for (const r of this.sql.exec(`SELECT game_id, status, people, amount FROM gm_credit_seats WHERE game_id IN (SELECT g.id ${PICK})`, ...picked).toArray()) {
      const view = out.get(r.game_id);
      if (r.status === 'sending') view.toCome.players += r.people;
      else if (view[r.status]) {
        view[r.status].players += r.people;
        view[r.status].amount += r.status === 'staff' ? r.people * byId.get(r.game_id).fee : r.amount;
      }
    }
    // the seats on now that nothing's been decided for (or Shopify said no to last time: they're in retry)
    const seats = this.sql
      .exec(
        `SELECT b.game_id AS game_id, b.people AS people, b.paid AS paid, b.amount AS amount, b.waived AS waived, b.covered_by AS covered_by
           FROM bookings b LEFT JOIN gm_credit_seats s ON s.booking_id = b.id
          WHERE b.game_id IN (SELECT g.id ${PICK}) AND b.kind = 'gm-seat' AND b.status IN ('confirmed', 'seated', 'done') AND s.booking_id IS NULL`,
        ...picked,
      )
      .toArray();
    for (const r of seats) {
      const g = byId.get(r.game_id);
      const view = out.get(r.game_id);
      // (round 21, part 2: a seat its GM pays for gives them no GM credit)
      if (r.covered_by && !g.free) view.covered.players += r.people;
      else if (g.free || !(g.fee > 0) || !(r.amount > 0) || r.waived) continue;
      else if (r.paid) view.toCome.players += r.people;
      else view.unpaid.players += r.people;
    }
    return out;
  },

  /**
   * Round 30: for a GM's players list (gamePlayers), where each seat's GM fee is up to: { of(seat) } giving 'credited'
   * (it's on the GM's store credit), 'coming' (paid, and the fee's on its way: the session hasn't started yet, a run has
   * it now, or Shopify's still to say or staff add it by hand) or null (not paid yet, or there's none for this seat: a
   * free session, a $0 GM fee, a $0 seat, one the GM pays for, or a staff GM the team's setting keeps it from); and
   * each, what the GM gets for each person who pays (cents, 0 when there's none for them: GET /me's gmCreditEach). No
   * awaits.
   */
  gmSeatCredits(game) {
    const ledger = new Map(this.sql.exec('SELECT booking_id, status FROM gm_credit_seats WHERE game_id = ?', game.id).toArray().map((r) => [r.booking_id, r.status]));
    // (a session with no fee of its own takes the shop's, as the runs do: round 30's review)
    const fee = game.gmFee ?? this.rulesCache?.prices.gmCredit ?? 500;
    const none = game.free || !(fee > 0);
    // a staff GM's sessions follow the team's setting (as gmCreditLine reads it: never waiting on Shopify)
    const id = game.gmCustomerId ? String(game.gmCustomerId) : '';
    const staff = Boolean(id) && (Boolean(this.helperRow(id)) || Boolean(this.people?.get(id)?.person?.staff));
    const rule = staff && this.rulesCache ? this.staffGmRule(game, { customerId: id, staff: true }, this.rulesCache, game.gmOnShift ?? null) : null;
    const kept = Boolean(rule && !rule.credit);
    return {
      // what the GM gets for each person who pays (cents): the fee, or 0 when there's none for them to get
      each: none || kept || !id ? 0 : fee,
      of: (seat) => {
        const status = ledger.get(seat.id);
        if (status === 'credited') return 'credited';
        if (['sending', 'retry', 'check', 'failed', 'manual'].includes(status)) return 'coming';
        if (status || none || kept || !id || !seat.paid || !((seat.amount || 0) > 0) || seat.coveredBy) return null;
        return 'coming';
      },
    };
  },

  /**
   * Round 30, the 10-minute run (Mo, 6 Nov 2026: "One email for all the players per session"): an hour after a session
   * ends (GM_CREDIT.mailAfter), Gobgob emails each GM who had credit for it once: who paid and what's on their store
   * credit, counting the seats credited quietly (Shopify didn't email them). Nobody paid by then (a monthly account's
   * bill): it goes once some does. None when none of its credit landed in the last GM_CREDIT.mailWithin, nor for a
   * session whose GM had credit with Shopify's email (before this went live), so it's never part of the story. Each is
   * claimed in gm_credit_mails before it's sent, with an idempotency key of its own; Resend down, busy or not answering
   * (5xx, 429, a timeout): unclaimed, so the next run tries again (never sent twice), as is a claim left with no answer
   * (GM_CREDIT.mailStale: the Lair restarted mid-send); anything else Resend refused, or no address: not tried again.
   * Returns { sent, retry, failed } when it looked at any, else null.
   */
  async gmCreditMails(now = Date.now()) {
    if (!emailReady(this.env)) return null;
    const rules = await this.rules();
    // --- no awaits until this run's emails are claimed ---
    const due = this.sql
      .exec(
        `SELECT s.game_id AS game_id, s.customer_id AS gm, SUM(s.people) AS players, SUM(s.amount) AS amount
           FROM gm_credit_seats s JOIN games g ON g.id = s.game_id
          WHERE s.status = 'credited' AND s.quiet = 1 AND s.amount > 0 AND s.customer_id IS NOT NULL AND g.ends_at <= ?
            AND NOT EXISTS (SELECT 1 FROM gm_credit_mails m WHERE m.game_id = s.game_id AND m.customer_id = s.customer_id
                             AND NOT (m.status = 'sending' AND m.created_at <= ?))
            AND NOT EXISTS (SELECT 1 FROM gm_credit_seats o WHERE o.game_id = s.game_id AND o.customer_id = s.customer_id
                             AND o.status = 'credited' AND o.quiet = 0)
          GROUP BY s.game_id, s.customer_id HAVING MAX(s.updated_at) > ?
          ORDER BY MIN(g.ends_at), s.game_id LIMIT ?`,
        now - GM_CREDIT.mailAfter, now - GM_CREDIT.mailStale, now - GM_CREDIT.mailWithin, GM_CREDIT.mailsPerRun,
      )
      .toArray();
    if (!due.length) return null;
    const out = {};
    const add = (key) => {
      out[key] = (out[key] || 0) + 1;
    };
    const mark = (d, status) => this.write('UPDATE gm_credit_mails SET status = ?, sent_at = ? WHERE game_id = ? AND customer_id = ?', status, status === 'sent' ? Date.now() : null, d.game_id, d.gm);
    const letters = [];
    for (const d of due) {
      // (a claim still here is one left with no answer: the same email, its same key)
      this.write("DELETE FROM gm_credit_mails WHERE game_id = ? AND customer_id = ? AND status = 'sending'", d.game_id, d.gm);
      this.write("INSERT INTO gm_credit_mails (game_id, customer_id, players, amount, status, created_at) VALUES (?, ?, ?, ?, 'sending', ?)", d.game_id, d.gm, d.players, d.amount, Date.now());
      let letter = null;
      try {
        letter = this.gmCreditLetter(d, rules);
      } catch (error) {
        console.error('Lair: could not write a GM credit email', d.game_id, error);
      }
      if (letter) letters.push({ d, letter });
      else {
        console.error('Lair: no GM credit email for this session: no email address for its GM', d.game_id);
        mark(d, 'failed');
        add('failed');
      }
    }
    // --- claimed: now Resend. Afterwards only each email's own row changes ---
    for (const { d, letter } of letters) {
      const result = await this.mail(letter);
      if (result.ok) {
        mark(d, 'sent');
        add('sent');
      } else if (!result.attempted || !result.status || result.status >= 500 || result.status === 429) {
        // (no status: Resend didn't answer in time, and may have taken it; its key means a second try never sends twice)
        this.write("DELETE FROM gm_credit_mails WHERE game_id = ? AND customer_id = ? AND status = 'sending'", d.game_id, d.gm);
        add('retry');
      } else {
        console.error('Lair: Resend refused a GM credit email', d.game_id, result.status, result.message);
        mark(d, 'failed');
        add('failed');
      }
    }
    return out;
  },

  /** The one email for a session (gmCreditMails' row d: game_id, gm, players, amount), or null with no address. No awaits. */
  gmCreditLetter(d, rules) {
    const game = this.game(d.game_id);
    if (!game) return null;
    const member = this.memberRow(d.gm);
    const to = [member?.email, member?.account_email, String(game.gmCustomerId || '') === String(d.gm) ? game.gmEmail : null].find(isEmail);
    if (!to) return null;
    const first = String(member?.first_name || String(member?.name || '').split(/\s+/)[0] || game.gm || 'there').trim();
    const seats = this.sql
      .exec(
        `SELECT s.people AS people, s.amount AS amount, b.name AS name FROM gm_credit_seats s LEFT JOIN bookings b ON b.id = s.booking_id
          WHERE s.game_id = ? AND s.customer_id = ? AND s.status = 'credited' AND s.quiet = 1 AND s.amount > 0 ORDER BY s.updated_at, s.booking_id`,
        d.game_id, d.gm,
      )
      .toArray();
    // each player's fee, when they're all the same (they are, unless the fee changed part-way)
    const per = d.players ? d.amount / d.players : 0;
    const each = Number.isInteger(per) && seats.every((x) => x.amount === x.people * per) ? money(per) : '';
    const names = seats.map((x) => {
      const name = String(x.name || 'A player').trim().split(/\s+/)[0];
      return x.people > 1 ? `${name} (${x.people})` : name;
    });
    const shown = names.length > 8 ? `${names.slice(0, 8).join(', ')} and ${names.length - 8} more` : names.join(', ');
    const amount = money(d.amount);
    return this.letter(to.trim(), GM_CREDIT_WORDS.mailSubject(game.title, amount), {
      title: GM_CREDIT_WORDS.mailTitle(game.title),
      intro: GM_CREDIT_WORDS.mailIntro(first, amount, game.title, each, d.players),
      details: [['Session', this.when(game, rules)], ['Players who paid', shown], ['Store credit', amount]],
      outro: GM_CREDIT_WORDS.mailLater(each),
      button: { label: 'See it in My Lair', url: `${this.page('myLair')}?view=ml-games` },
      signoff: 'Happy GMing!\nGobgob',
    }, { idempotencyKey: `gm-credit-mail-${d.game_id}-${d.gm}` });
  },

  /** A round 21 session's GM credit with nothing on it yet (gmCreditsIn's shape). No awaits. */
  gmCreditBlank() {
    const none = () => ({ players: 0, amount: 0 });
    return { auto: true, credited: none(), staff: none(), manual: none(), check: none(), failed: none(), retry: none(), toCome: { players: 0 }, unpaid: { players: 0 }, covered: { players: 0 } };
  },
};

/** [[key, rows]] in the order keys are first seen */
function groupBy(rows, keyOf) {
  const map = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return [...map];
}

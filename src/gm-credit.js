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
 * once the session is over and that seat is paid: online, at the counter, on a tab or bill, or by a session pass. A seat
 * paid later gives it later, and one never paid gives nothing (nor do cancelled seats and no-shows). The 10-minute run
 * does it, with one store credit for each GM a run (Shopify emails the GM each time). The team's "GM credit for staff"
 * setting still decides for staff GMs, by their hours for 'shifts'. Sessions from before then keep the staff page's
 * "Session done" button (POST /games/:id/credit), and a session someone already credited that way is left alone.
 *
 * Each seat is recorded in gm_credit_seats before Shopify is asked, so no seat is ever credited twice:
 *  - 'sending': with Shopify now (one older than GM_CREDIT.sendingStale had no answer: it's 'check')
 *  - 'credited': on the GM's store credit
 *  - 'staff': kept from a staff GM (amount 0; note says what it would have been)
 *  - 'manual': the GM has no account in the Lair, so staff add it in Shopify admin (they get an email)
 *  - 'retry': Shopify said no, so nothing moved; tried again next run, GM_CREDIT.maxTries times in all
 *  - 'failed': Shopify said no every time (staff get an email)
 *  - 'check': Shopify didn't answer, so it may have gone; never tried again by itself (staff get an email)
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { RuleError, makeId } from './core.js';

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
  // Shopify said no: tried again each run, this many times in all
  maxTries: 5,
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
];

/**
 * The sessions that earn their GM a stamp, as stampedSessions' columns (id, kind 'gm-run', at, people 1, tables,
 * occurrence_id, game_title, join_title). Two bound values: the GM's customer ID, then the loyalty start. A player's
 * seat is what says it ran (not the GM's own, if they booked one), or players the group had who don't book through the
 * Lair (offline_players); a GM checked in on a seat of their own session has that seat's stamp already, so the session
 * gives them no second one.
 */
export const GM_STAMP_ROWS = `
  SELECT g.id AS id, 'gm-run' AS kind, g.starts_at AS at, 1 AS people, g.tables AS tables, NULL AS occurrence_id, g.title AS game_title, NULL AS join_title
    FROM gm_runs r JOIN games g ON g.id = r.game_id AND g.gm_customer_id = r.customer_id
   WHERE r.customer_id = ? AND r.staff = 0 AND g.status IN ('open', 'full') AND g.starts_at >= ?
     AND (COALESCE(g.offline_players, 0) > 0
       OR EXISTS (SELECT 1 FROM bookings s WHERE s.game_id = g.id AND s.kind = 'gm-seat' AND s.status IN ('confirmed', 'seated', 'done')
                   AND (s.customer_id IS NULL OR s.customer_id != r.customer_id)))
     AND NOT EXISTS (SELECT 1 FROM bookings s WHERE s.game_id = g.id AND s.kind = 'gm-seat' AND s.customer_id = r.customer_id AND s.status IN ('seated', 'done'))`;

/** Every message the staff page or a GM can see, word for word in the contract */
export const GM_CREDIT_WORDS = {
  stampTitle: (title) => `${title || 'TTRPG session'} (you ran it)`,
  notOver: "GM credit adds itself for this session: once it's over, the GM gets their fee for each player who's paid. There's nothing to tap.",
  nothingYet: "Nothing to add yet: the GM gets their fee for each player once they've paid.",
  allDone: "Done: the GM has had their fee for every player who's paid.",
  sending: "Gobgob is adding the GM's credit right now. Check again in a minute.",
  free: "This session was free, so there's no GM credit to add.",
  noFee: "This GM covers their players' fee, so there's no store credit to add.",
  marked: "The GM's credit has gone to them already, so it can't be kept now. Take it off their store credit on their member page if it shouldn't have gone.",
  markedOn: "Marked: they were working, so there's no GM credit for this session.",
  markedOff: "Marked: they weren't working, so they get their GM credit once it's over.",
  undone: (gm, amount, seat, why) => `${gm} got ${amount} GM credit for ${seat}, but that seat ${why}. If ${gm} shouldn't keep it, take it off their store credit on their member page.`,
  noAccount: "The GM isn't linked to a customer account, so add the store credit in Shopify admin.",
  refused: (said) => `Shopify didn't add the store credit (${said}). Nothing moved. Gobgob tries again in 10 minutes.`,
  failed: (said) => `Shopify didn't add the store credit after ${GM_CREDIT.maxTries} tries (${said}). Nothing moved. Add it in Shopify admin.`,
  check: (said) => `Shopify didn't confirm the store credit (${said}), so it may have gone through. Check the GM's store credit in Shopify admin before adding any.`,
  stale: "Shopify didn't answer about the store credit, so it may have gone through. Check the GM's store credit in Shopify admin before adding any.",
};

const money = (cents) => `$${(cents / 100).toFixed(2)}`;
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
   * The seats ready for their GM's credit now: in a round 21 session that's over and isn't cancelled, free or without a
   * GM fee, that nobody credited with "Session done" (a credits row of theirs, or credited set with nothing in the
   * ledger: a tap whose answer never came back); paid (amount over $0: a free seat isn't a paying player's) and not
   * cancelled or a no-show; not decided yet, or Shopify said no last time. gameId: just that session's. No awaits.
   */
  gmCreditReady(now, rules, gameId = null) {
    return this.sql
      .exec(
        `SELECT b.id AS booking_id, b.game_id AS game_id, b.people AS people, g.gm_customer_id AS gm,
             COALESCE(g.gm_fee, ?) AS fee, s.status AS was, COALESCE(s.tries, 0) AS tries
           FROM bookings b JOIN games g ON g.id = b.game_id
           LEFT JOIN gm_credit_seats s ON s.booking_id = b.id
          WHERE b.kind = 'gm-seat' AND b.paid = 1 AND b.amount > 0 AND b.status IN ('confirmed', 'seated', 'done')
            AND g.starts_at >= ? AND g.ends_at <= ? AND g.status IN ('open', 'full') AND COALESCE(g.free, 0) = 0
            AND COALESCE(g.gm_fee, ?) > 0
            AND NOT EXISTS (SELECT 1 FROM credits c WHERE c.game_id = g.id AND COALESCE(c.by, '') != 'auto')
            AND NOT (g.credited IS NOT NULL AND NOT EXISTS (SELECT 1 FROM gm_credit_seats x WHERE x.game_id = g.id))
            AND (s.booking_id IS NULL OR s.status = 'retry')
            ${gameId ? 'AND g.id = ?' : ''}
          ORDER BY g.ends_at, b.created_at, b.id LIMIT ?`,
        rules.prices.gmCredit, GM_CREDIT.autoFrom, now, rules.prices.gmCredit, ...(gameId ? [gameId] : []), GM_CREDIT.seatsPerRun,
      )
      .toArray();
  },

  /**
   * The 10-minute run (and "Session done" on a round 21 session that's over): every seat ready for its GM's credit gets
   * it, one store credit for each GM. gameId: just that session's seats. Returns { credited, amount, staff, manual,
   * retry, failed, check } (players each, amount in cents) when anything was decided, else null. Never throws for
   * Shopify: what Shopify says is recorded on the seats.
   */
  async autoGmCredit(now = Date.now(), { gameId = null } = {}) {
    if (!this.shopify?.configured) return null;
    const rules = await this.rules();
    const out = { credited: 0, amount: 0, staff: 0, manual: 0, retry: 0, failed: 0, check: 0 };
    this.staleGmCredits(Date.now(), out);
    const ready = this.gmCreditReady(now, rules, gameId);
    const gms = [...new Set(ready.map((r) => String(r.gm || '')))];
    // GMs with no account: staff add it in Shopify admin
    if (gms.includes('')) this.gmCreditManual(ready.filter((r) => !r.gm), rules, out);
    for (const gm of gms.filter(Boolean).slice(0, GM_CREDIT.gmsPerRun)) {
      const person = await this.person(gm);
      // (as "Session done": a GM whose tags couldn't be read isn't paid while the setting could keep it from them)
      if (person?.tagsFailed && !person.staff && this.staffGmMode() !== 'earn') continue;
      // --- no awaits from here until the seats are claimed ---
      const mine = this.gmCreditReady(Date.now(), rules, gameId).filter((r) => String(r.gm || '') === gm);
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
        await this.shopify.creditCustomer(gm, total, this.env.CURRENCY || 'NZD', { timeout: GM_CREDIT.timeoutMs });
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
    const why = unpaid ? "isn't marked paid any more" : after.status === 'noshow' ? 'was marked a no-show' : 'was cancelled';
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
      this.write("UPDATE gm_credit_seats SET status = 'credited', updated_at = ? WHERE batch = ? AND status = 'sending'", at, batch);
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
   * Before the session's over: 409 (notOver), or with a mark, { status: 'marked', note } (kept for the run once it's
   * over). After: { players, amount, status, note, auto: true }
   * for what this tap did: 'credited' (amount), 'staff', 'manual' (amount: to add by hand), 'check', 'retry' or 'failed'
   * (with that seat's note). With nothing to do now: where the session is up to ('sending' while another run has it
   * with Shopify, then 'check', 'failed', 'retry' or 'manual'), or 'none' with why (a free session, a $0 GM fee, a
   * seat still to pay, or all done).
   */
  async creditGmNow(game, now = Date.now(), { onShift = null, who = null } = {}) {
    if (typeof onShift === 'boolean') {
      this.markOnShift(game, onShift, who);
      // marked ahead of time: kept for the run once it's over
      if (game.end > now) return { players: 0, amount: 0, status: 'marked', note: onShift ? GM_CREDIT_WORDS.markedOn : GM_CREDIT_WORDS.markedOff, auto: true };
    }
    if (game.end > now) throw new RuleError(GM_CREDIT_WORDS.notOver, 409);
    // what this tap did: this session's seats that changed while it ran (another session's are never counted)
    const read = () => this.sql.exec('SELECT booking_id, status, people, amount, note, batch, updated_at FROM gm_credit_seats WHERE game_id = ? ORDER BY updated_at DESC, booking_id', game.id).toArray();
    const key = (r) => `${r.status}|${r.batch || ''}|${r.updated_at}`;
    const was = new Map(read().map((r) => [r.booking_id, key(r)]));
    await this.autoGmCredit(now, { gameId: game.id });
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
   * seat since), toCome: { players } (paid seats not decided yet: the session isn't over, or the next run has them),
   * unpaid: { players } (seats still to pay) }. A
   * session someone credited with Session done before round 21 went live isn't in it (its card says what that did).
   * No awaits.
   */
  gmCreditsIn(from, to, rules) {
    const fee = rules.prices.gmCredit;
    const out = new Map();
    const games = this.sql
      .exec(
        `SELECT g.id AS id, g.free AS free, COALESCE(g.gm_fee, ?) AS fee FROM games g
          WHERE g.starts_at >= ? AND g.ends_at > ? AND g.starts_at < ?
            AND NOT EXISTS (SELECT 1 FROM credits c WHERE c.game_id = g.id AND COALESCE(c.by, '') != 'auto')
            AND NOT (g.credited IS NOT NULL AND NOT EXISTS (SELECT 1 FROM gm_credit_seats x WHERE x.game_id = g.id))`,
        fee, GM_CREDIT.autoFrom, from, to,
      )
      .toArray();
    const byId = new Map(games.map((g) => [g.id, g]));
    for (const g of games) out.set(g.id, this.gmCreditBlank());
    if (!games.length) return out;
    const ids = games.map((g) => g.id);
    const marks = ids.map(() => '?').join(', ');
    // what's been decided, whatever's happened to the seat since
    for (const r of this.sql.exec(`SELECT game_id, status, people, amount FROM gm_credit_seats WHERE game_id IN (${marks})`, ...ids).toArray()) {
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
        `SELECT b.game_id AS game_id, b.people AS people, b.paid AS paid, b.amount AS amount, b.waived AS waived
           FROM bookings b LEFT JOIN gm_credit_seats s ON s.booking_id = b.id
          WHERE b.game_id IN (${marks}) AND b.kind = 'gm-seat' AND b.status IN ('confirmed', 'seated', 'done') AND s.booking_id IS NULL`,
        ...ids,
      )
      .toArray();
    for (const r of seats) {
      const g = byId.get(r.game_id);
      const view = out.get(r.game_id);
      if (g.free || !(g.fee > 0) || !(r.amount > 0) || r.waived) continue;
      else if (r.paid) view.toCome.players += r.people;
      else view.unpaid.players += r.people;
    }
    return out;
  },

  /** A round 21 session's GM credit with nothing on it yet (gmCreditsIn's shape). No awaits. */
  gmCreditBlank() {
    const none = () => ({ players: 0, amount: 0 });
    return { auto: true, credited: none(), staff: none(), manual: none(), check: none(), failed: none(), retry: none(), toCome: { players: 0 }, unpaid: { players: 0 } };
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

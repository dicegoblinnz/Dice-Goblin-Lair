/**
 * Round 11: jobs the owner queues for the Lair, for bulk changes there's no page for. Mo (9 Oct 2026): "remove all
 * the gm games and all of the events … Can you help create all the events and GM games and have images for all of
 * them". A job is a row in the config database's admin_jobs table (id, kind, payload JSON, status 'pending'); the
 * Worker's cron (every 10 minutes) claims each pending row, runs it here through the internal route
 * /internal/admin-job, and writes the result back to the row. Only someone who can write to that database (the
 * Cloudflare account) can queue one; the public proxy can never reach /internal.
 *
 * Kinds:
 *  - games.reset {}: every GM game and series off the board, silently (they were tests): games and series cancelled,
 *    the GMs' table holds and the seats cancelled, the regulars and seat invites ended, the interest in them closed.
 *    → { games, series, bookings }
 *  - events.reset {}: every sign-up, game spot, "I'm coming", "Maybe" and waitlist place on an event date still to come
 *    off the board, silently (Mo: the ones there were tests). Ones paid online are left for staff, and listed.
 *    → { joins, spots, interests, paidLeft: [{ ref, kind, title, start }] }
 *  - games.add { games: [spec] }: GM games for named GMs who have no account here yet (nobody is emailed), straight on
 *    the board, each checked like a game staff list (opening hours, free tables, tables events lock), except that a
 *    start may fall between the hours. spec: { title, system, gm, blurb, seats, offlinePlayers (players already in
 *    the group, counted as taken), gmFee (cents: 0, 500 or 1000), schedule ('one-shot', 'weekly', 'fortnightly' or
 *    'flexible'), start, end (ms: the first session), tables, imageUrl (a https://cdn.shopify.com/ picture), level,
 *    age, tags, characters, bring }. Weekly and fortnightly games get their sessions to the booking horizon (and the
 *    daily top-up keeps going); dates whose tables aren't free are skipped and listed.
 *    → { added: [{ title, id, seriesId, sessions, first, skipped: [{ start, reason }] }], failed: [{ title, error }] }
 *  - games.update { updates: [{ seriesId | gameId, set }] }: change a game's details for every session still to come
 *    of its series (or the one game), like staff editing a game, without emails. set: any of title, system, gm, blurb,
 *    seats, offlinePlayers, level, age, tags, characters, bring, gmFee, imageUrl (a https://cdn.shopify.com/ picture,
 *    or null for none). Seats can't go below the players already booked through the Lair plus offlinePlayers.
 *    → { updated: [{ id, title, sessions, seats, offlinePlayers, system, imageUrl }], failed: [{ id, error }] }
 *  - memberships.setup {}: round 10's Lair Memberships setup, as /setup?key=…&memberships=plans does it (the plans made
 *    once and put on MEMBERSHIPS_PRODUCT_ID, the damage charge product, the webhooks), without the setup key.
 *    → membershipSetup's answer
 *  - games.openSeats { dryRun? } (16 Oct 2026): the players each group already had (offlinePlayers) off every session
 *    that hasn't started and every series, silently, so everyone signs up on the website; what's booked through the
 *    Lair stays, and is listed. dryRun changes nothing. → see adminOpenSeats
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair:
 * every await first, then synchronous reads, checks and writes.
 */
import { HOUR, LairTime, RuleError, checkGameDetails, checkGameSession, makeId, tableIndex } from './core.js';

/** A picture the import may use: one already in the store's Shopify Files */
const SHOPIFY_PICTURE = /^https:\/\/cdn\.shopify\.com\/[^\s"'<>]+$/;
const SCHEDULES = ['one-shot', 'weekly', 'fortnightly', 'flexible'];

export const adminMethods = {
  /** The internal route's entry: { id, kind, payload } from the Worker's cron */
  async adminJob(body) {
    const kind = String(body?.kind || '');
    const payload = body && typeof body.payload === 'object' && body.payload ? body.payload : {};
    if (kind === 'games.reset') return this.adminResetGames(Date.now());
    if (kind === 'events.reset') return this.adminResetEvents(Date.now());
    if (kind === 'games.add') {
      const rules = await this.rules();
      // --- no awaits from here on ---
      return this.adminAddGames(payload, rules, Date.now());
    }
    if (kind === 'games.update') {
      const rules = await this.rules();
      // --- no awaits from here on ---
      return this.adminUpdateGames(payload, rules, Date.now());
    }
    if (kind === 'memberships.setup') {
      const base = String(this.env?.PUBLIC_URL || '').replace(/\/$/, '');
      return this.membershipSetup(base ? `${base}/webhooks/memberships` : null);
    }
    if (kind === 'games.openSeats') {
      const rules = await this.rules();
      // --- no awaits from here on ---
      return this.adminOpenSeats(payload, rules, Date.now());
    }
    throw new RuleError(`Unknown job: ${kind || '(none)'}`, 422);
  },

  /**
   * games.openSeats { dryRun? }: Mo (16 Oct 2026): "remove all the players from the games and have them be bookable so
   * that players are able to join … I will want players to all sign up on the website for their respective games". The
   * players each group already had (round 11's offlinePlayers, counted as seats taken but never named) come off every
   * session that hasn't started and off every series, so sessions made later have none either: their seats are open to
   * book. A session under way keeps its count (nobody books into it now). Seats booked through the Lair, regulars and
   * invites are left as they are, and listed, for staff to keep or take off on the staff page. dryRun: nothing changes;
   * the answer says what would. No awaits.
   * → { dryRun, games: [{ id, title, gm, sessions, offlinePlayers, next }], sessions, series, players, booked: [{ ref,
   *   title, when, name, people, regular, account, paid }], regulars: [{ title, name, people }], invites: [{ title, name }] }
   */
  adminOpenSeats(payload, rules, now) {
    // a dry run however it's written (true, or "true" in the job's JSON); only false, "false", 0 or none really runs
    const dryRun = Boolean(payload.dryRun) && !['false', '0'].includes(String(payload.dryRun).trim().toLowerCase());
    const time = new LairTime(rules.tz);
    const details = (text) => {
      try {
        return JSON.parse(text || '{}') || {};
      } catch {
        return {};
      }
    };
    // the sessions to open: not cancelled, not started, with players the group had
    const sessions = this.sql
      .exec("SELECT * FROM games WHERE status != 'cancelled' AND starts_at > ? AND offline_players > 0 ORDER BY starts_at", now)
      .toArray().map((r) => this.rowToGame(r));
    const series = this.sql.exec("SELECT id, details FROM series WHERE status != 'cancelled'").toArray()
      .map((s) => ({ id: s.id, details: details(s.details) }))
      .filter((s) => Number(s.details.offlinePlayers) > 0);
    // one line per game (a series, or a one-off session): its next session's count, and how many sessions it's in
    const games = new Map();
    for (const g of sessions) {
      const key = g.seriesId || g.id;
      const line = games.get(key) || { id: key, title: g.title, gm: g.gm, sessions: 0, offlinePlayers: g.offlinePlayers, next: g.start, when: time.label(g.start) };
      line.sessions += 1;
      games.set(key, line);
    }
    // a series with none still to come (a flexible one with no dates yet, say) is listed too: sessions made later had them
    for (const s of series) {
      if (!games.has(s.id)) games.set(s.id, { id: s.id, title: s.details.title || 'GM game', gm: s.details.gm || '', sessions: 0, offlinePlayers: Number(s.details.offlinePlayers), next: null, when: '' });
    }
    // everyone booked through the Lair in a session that hasn't started, so staff know who's there already
    const booked = this.sql
      .exec(`SELECT b.ref, b.name, b.people, b.series_id, b.customer_id, b.paid, b.paid_amount, b.covered, g.title, g.starts_at
             FROM bookings b JOIN games g ON g.id = b.game_id
             WHERE b.kind = 'gm-seat' AND b.status IN ('held', 'confirmed', 'seated') AND g.status != 'cancelled' AND g.starts_at > ?
             ORDER BY g.starts_at, b.created_at`, now)
      .toArray()
      .map((b) => ({
        ref: b.ref, title: b.title, when: time.label(b.starts_at), name: b.name, people: Number(b.people) || 1,
        regular: Boolean(b.series_id && b.customer_id), account: Boolean(b.customer_id), paid: Number(b.paid) === 1 || Number(b.paid_amount) > 0 || Number(b.covered) > 0,
      }));
    const regulars = this.sql
      .exec("SELECT m.name, m.people, s.details FROM series_members m JOIN series s ON s.id = m.series_id WHERE m.status = 'active' AND s.status != 'cancelled' ORDER BY m.created_at")
      .toArray().map((m) => ({ title: details(m.details).title || 'GM game', name: m.name, people: Number(m.people) || 1 }));
    const invites = this.sql
      .exec("SELECT i.name, s.details FROM series_invites i JOIN series s ON s.id = i.series_id WHERE i.status = 'waiting' AND s.status != 'cancelled' ORDER BY i.created_at")
      .toArray().map((i) => ({ title: details(i.details).title || 'GM game', name: i.name || 'Someone invited' }));
    if (!dryRun) {
      this.write("UPDATE games SET offline_players = 0, updated_at = ? WHERE status != 'cancelled' AND starts_at > ? AND offline_players > 0", now, now);
      for (const s of series) {
        this.write('UPDATE series SET details = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...s.details, offlinePlayers: 0 }), now, s.id);
      }
    }
    const lines = [...games.values()].sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity) || a.title.localeCompare(b.title));
    return {
      dryRun,
      games: lines,
      sessions: sessions.length,
      series: series.length,
      players: lines.reduce((n, line) => n + line.offlinePlayers, 0),
      booked,
      regulars,
      invites,
    };
  },

  /** games.reset: everything about GM games off the board, without emails. No awaits. */
  adminResetGames(now) {
    const count = (sql) => Number(this.sql.exec(sql).one().n) || 0;
    const games = count("SELECT COUNT(*) AS n FROM games WHERE status != 'cancelled'");
    const series = count("SELECT COUNT(*) AS n FROM series WHERE status != 'cancelled'");
    const bookings = count("SELECT COUNT(*) AS n FROM bookings WHERE kind IN ('gm', 'gm-seat') AND status IN ('held', 'confirmed', 'seated')");
    this.write("UPDATE games SET status = 'cancelled', updated_at = ? WHERE status != 'cancelled'", now);
    this.write("UPDATE series SET status = 'cancelled', updated_at = ? WHERE status != 'cancelled'", now);
    this.write("UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE kind IN ('gm', 'gm-seat') AND status IN ('held', 'confirmed', 'seated')", now);
    this.write("UPDATE series_members SET status = 'left', updated_at = ? WHERE status = 'active'", now);
    this.write("UPDATE series_invites SET status = 'cancelled', updated_at = ? WHERE status = 'waiting'", now);
    this.write("UPDATE interests SET status = 'removed', updated_at = ? WHERE kind = 'session' AND status = 'active'", now);
    return { games, series, bookings };
  },

  /** events.reset: the sign-ups, game spots and interest for event dates still to come, without emails. No awaits. */
  adminResetEvents(now) {
    const count = (sql) => Number(this.sql.exec(sql, now).one().n) || 0;
    const JOINS = "FROM event_joins WHERE status NOT IN ('cancelled', 'attended') AND ends_at > ?";
    const SPOTS = "FROM bookings WHERE occurrence_id IS NOT NULL AND status IN ('held', 'confirmed', 'seated') AND ends_at > ?";
    const paidLeft = [
      ...this.sql.exec(`SELECT ref, title, starts_at ${JOINS} AND paid_amount > 0`, now).toArray().map((r) => ({ ref: r.ref, kind: 'sign-up', title: r.title, start: r.starts_at })),
      ...this.sql.exec(`SELECT ref, starts_at ${SPOTS} AND paid_amount > 0`, now).toArray().map((r) => ({ ref: r.ref, kind: 'game spot', title: null, start: r.starts_at })),
    ];
    const joins = count(`SELECT COUNT(*) AS n ${JOINS} AND paid_amount = 0`);
    const spots = count(`SELECT COUNT(*) AS n ${SPOTS} AND paid_amount = 0`);
    const interests = count("SELECT COUNT(*) AS n FROM interests WHERE kind = 'event' AND status = 'active' AND ends_at > ?");
    this.write(`UPDATE event_joins SET status = 'cancelled', hold_until = NULL, updated_at = ? WHERE id IN (SELECT id ${JOINS} AND paid_amount = 0)`, now, now);
    this.write(`UPDATE bookings SET status = 'cancelled', hold_until = NULL, updated_at = ? WHERE id IN (SELECT id ${SPOTS} AND paid_amount = 0)`, now, now);
    this.write("UPDATE interests SET status = 'removed', updated_at = ? WHERE kind = 'event' AND status = 'active' AND ends_at > ?", now, now);
    return { joins, spots, interests, paidLeft };
  },

  /** games.update: each change on its own, so one that can't go on doesn't stop the rest. No awaits. */
  adminUpdateGames(payload, rules, now) {
    const list = Array.isArray(payload.updates) ? payload.updates : [];
    if (!list.length) throw new RuleError('Add at least one change.', 422);
    if (list.length > 60) throw new RuleError('Change 60 games at most at a time.', 422);
    const updated = [];
    const failed = [];
    for (const change of list) {
      const id = String(change?.seriesId || change?.gameId || '').trim() || '(none)';
      try {
        updated.push(this.adminUpdateGame(change, rules, now));
      } catch (error) {
        if (!(error instanceof RuleError)) throw error;
        failed.push({ id, error: error.message });
      }
    }
    return { updated, failed };
  },

  /** One game's change, for every session still to come of its series (or the one game). Throws a RuleError. No awaits. */
  adminUpdateGame(change, rules, now) {
    const set = change && typeof change.set === 'object' && change.set ? change.set : {};
    const time = new LairTime(rules.tz);
    let series = null;
    let sessions;
    if (change?.seriesId) {
      series = this.sql.exec('SELECT * FROM series WHERE id = ?', String(change.seriesId)).toArray()[0] || null;
      if (!series || series.status === 'cancelled') throw new RuleError('That series was not found.', 404);
      sessions = this.sql
        .exec("SELECT * FROM games WHERE series_id = ? AND status != 'cancelled' AND ends_at > ? ORDER BY starts_at", series.id, now)
        .toArray()
        .map((r) => this.rowToGame(r));
    } else {
      const game = this.game(String(change?.gameId || ''));
      if (!game || game.status === 'cancelled') throw new RuleError('That game was not found.', 404);
      sessions = [game];
    }
    const before = sessions[0] ? this.gameDetails(sessions[0]) : JSON.parse(series?.details || '{}');
    const editable = ['title', 'system', 'gm', 'blurb', 'seats', 'level', 'age', 'tags', 'characters', 'bring', 'gmFee'];
    const details = checkGameDetails({ ...before, ...Object.fromEntries(editable.filter((k) => set[k] !== undefined).map((k) => [k, set[k]])) });
    const offlinePlayers = Math.max(0, Math.floor(Number(set.offlinePlayers !== undefined ? set.offlinePlayers : before.offlinePlayers) || 0));
    if (offlinePlayers > details.seats) throw new RuleError(`${offlinePlayers} players already in the group won't fit in ${details.seats} seats.`);
    let imageId = sessions[0]?.imageId ?? series?.image_id ?? null;
    if (set.imageUrl !== undefined) {
      imageId = set.imageUrl ? String(set.imageUrl).trim() : null;
      if (imageId && !SHOPIFY_PICTURE.test(imageId)) throw new RuleError('Pictures for loaded games have to be in the store’s Shopify Files (https://cdn.shopify.com/…).');
    }
    // every session to come must still fit the players booked through the Lair, plus the group's own
    for (const session of sessions) {
      const booked = Number(this.sql.exec("SELECT COALESCE(SUM(people), 0) AS n FROM bookings WHERE game_id = ? AND kind = 'gm-seat' AND status IN ('held', 'confirmed', 'seated')", session.id).one().n) || 0;
      if (booked + offlinePlayers > details.seats) {
        throw new RuleError(`${time.label(session.start)} already has ${booked} ${booked === 1 ? 'player' : 'players'} booked, so it needs at least ${booked + offlinePlayers} seats.`, 409);
      }
    }
    const shared = {
      title: details.title, system: details.system, blurb: details.blurb, seats: details.seats, level: details.level, age: details.age,
      tags: details.tags, characters: details.characters, pregens: details.pregens, bring: details.bring, gmFee: details.gmFee,
    };
    // Round 18: the GM's name only when the job changes it (a series can have more than one GM once staff give some of
    // it to another, so the first session's name isn't every session's)
    if (set.gm !== undefined) shared.gm = details.gm;
    for (const session of sessions) {
      const room = rules.rooms.find((r) => r.id === session.room) || tableIndex(rules.rooms).get(session.tables[0])?.roomObj;
      const seatPrice = (room?.price ?? rules.prices.table) + details.gmFee;
      this.saveGame({ ...session, ...shared, offlinePlayers, imageId, seatPrice }, now);
      // Round 18: a free session keeps its seats at $0 (its price is kept for when it isn't free any more)
      this.write("UPDATE bookings SET amount = ? * people, updated_at = ? WHERE game_id = ? AND kind = 'gm-seat' AND paid = 0 AND status IN ('held', 'confirmed', 'seated')", session.free ? 0 : seatPrice, now, session.id);
      this.write("UPDATE bookings SET people = ?, updated_at = ? WHERE game_id = ? AND kind = 'gm'", details.seats + 1, now, session.id);
    }
    if (series) {
      const kept = JSON.parse(series.details || '{}');
      this.write('UPDATE series SET details = ?, image_id = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...kept, ...shared, offlinePlayers }), imageId, now, series.id);
    }
    return {
      id: series ? series.id : sessions[0].id, title: details.title, sessions: sessions.length, seats: details.seats, offlinePlayers, system: details.system,
      imageUrl: imageId,
    };
  },

  /** games.add: each game on its own, so one that doesn't fit doesn't stop the rest. No awaits. */
  adminAddGames(payload, rules, now) {
    const list = Array.isArray(payload.games) ? payload.games : [];
    if (!list.length) throw new RuleError('Add at least one game.', 422);
    if (list.length > 60) throw new RuleError('Load 60 games at most at a time.', 422);
    const time = new LairTime(rules.tz);
    const added = [];
    const failed = [];
    for (const spec of list) {
      const title = String(spec?.title || '').trim() || '(no title)';
      try {
        added.push(this.adminAddGame(spec, rules, time, now));
      } catch (error) {
        if (!(error instanceof RuleError)) throw error;
        failed.push({ title, error: error.message });
      }
    }
    return { added, failed };
  },

  /** One game (and its series, with its sessions to the horizon). Throws a RuleError when it can't go on. No awaits. */
  adminAddGame(spec, rules, time, now) {
    const schedule = SCHEDULES.includes(spec.schedule) ? spec.schedule : 'one-shot';
    const details = checkGameDetails({ ...spec, schedule, gmFee: spec.gmFee ?? 500 });
    const offlinePlayers = Math.max(0, Math.min(details.seats, Math.floor(Number(spec.offlinePlayers) || 0)));
    const imageId = spec.imageUrl ? String(spec.imageUrl).trim() : null;
    if (imageId && !SHOPIFY_PICTURE.test(imageId)) throw new RuleError('Pictures for loaded games have to be in the store’s Shopify Files (https://cdn.shopify.com/…).');
    const start = Number(spec.start);
    const end = Number(spec.end);
    // a start between the hours (1:30pm) is fine for these, and every later session of the series too
    const anyMinute = Number.isFinite(start) && time.minutesOf(start) % 60 !== 0;
    const st = this.state(now - 24 * HOUR, now + (rules.horizonDays + 2) * 24 * HOUR);
    const first = checkGameSession({ tables: spec.tables, start, end }, details, { state: st, rules, time, now, shopTables: true, anyMinute });
    const seriesId = schedule === 'one-shot' ? null : makeId('sr');
    const seriesDetails = { ...details, gmEmail: null, staffCreated: true, imported: true, offlinePlayers, ...(anyMinute ? { anyMinute: true } : {}) };
    if (seriesId) {
      this.write(
        `INSERT INTO series (id, schedule, gm_customer_id, details, tables, clock, length, first_day, status, approved, image_id, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
        seriesId, schedule, JSON.stringify(seriesDetails), JSON.stringify(first.tables), time.minutesOf(first.start), first.end - first.start,
        time.key(first.start), imageId, now, now,
      );
    }
    const base = {
      ...details, offlinePlayers, gmCustomerId: null, gmEmail: null, status: 'open', credited: null, seriesId, feeApproved: true, imageId,
    };
    const game = this.saveSession(base, first, now);
    let sessions = 1;
    let skipped = [];
    if (seriesId && ['weekly', 'fortnightly'].includes(schedule)) {
      const row = this.sql.exec('SELECT * FROM series WHERE id = ?', seriesId).one();
      const planned = this.planSessions(row, rules, now, this.state(now - 24 * HOUR, now + (rules.horizonDays + 2) * 24 * HOUR));
      sessions += planned.created.length;
      skipped = planned.skipped.map((x) => ({ start: x.start, when: time.label(x.start), reason: x.reason }));
    }
    return { title: game.title, id: game.id, seriesId, sessions, first: game.start, skipped };
  },
};

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
    throw new RuleError(`Unknown job: ${kind || '(none)'}`, 422);
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
      title: details.title, system: details.system, gm: details.gm, blurb: details.blurb, seats: details.seats, level: details.level, age: details.age,
      tags: details.tags, characters: details.characters, pregens: details.pregens, bring: details.bring, gmFee: details.gmFee,
    };
    for (const session of sessions) {
      const room = rules.rooms.find((r) => r.id === session.room) || tableIndex(rules.rooms).get(session.tables[0])?.roomObj;
      const seatPrice = (room?.price ?? rules.prices.table) + details.gmFee;
      this.saveGame({ ...session, ...shared, offlinePlayers, imageId, seatPrice }, now);
      this.write("UPDATE bookings SET amount = ? * people, updated_at = ? WHERE game_id = ? AND kind = 'gm-seat' AND paid = 0 AND status IN ('held', 'confirmed', 'seated')", seatPrice, now, session.id);
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

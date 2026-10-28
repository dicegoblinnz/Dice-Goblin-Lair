/**
 * Round 22 (28 Oct 2026, contract v22-holds): every hold can be edited. Mo, with a screenshot of the staff page's Current
 * and upcoming holds: "I can't edit any of the weeklies for the events and only the ones I made. Please make it so that
 * all that have been created can be edited."
 *
 *  - An event date's own tables (event_hold_dates): staff change the tables one date of an event holds, or hold none
 *    that date, without touching the event in Shopify (POST /events/:occurrenceId/hold). eventHolds (src/core.js) holds
 *    them in place of the usual ones, so bookings, games, holds and the POS follow at once. Every date's tables are the
 *    event's Tables reserved, changed on the Events tab or from the holds list (POST /events/:handle/update).
 *  - The staff floor's holdEvents: each event with tables held, its usual tables and its dates, for the holds list.
 *  - Editing a staff hold (POST /blocks/:id/update): a one-off's tables, times, what it's for and its type; a weekly
 *    hold's date on its own (marked changed) or every date to come.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair. Each
 * handler does its one await (the rules) first, then reads, checks and writes with none in between.
 */
import { ACTIVE, HOUR, MIN, LairTime, RuleError, dateTables, eventOccurrences, findOccurrence, inTableOrder, parseTableList, sameTables, tableIndex } from './core.js';

/** Every message staff can see, word for word in the contract */
export const HOLD_WORDS = {
  noDate: 'That event date could not be found.',
  dateOver: "That date has finished, so its tables can't change.",
  badTables: "Some of those tables don't exist. Use table codes like T20-T21, a room's name, or all.",
  sendTables: 'Send the tables to hold that date, or usual: true.',
  noHold: 'That hold could not be found.',
  holdOver: "That hold has finished, so it can't change.",
  scope: 'Choose whether the change is for this date only or every date to come.',
  holdTables: 'Pick tables that exist, like T11-T20.',
  endAfter: 'The hold needs an end time after the start.',
  endPast: 'That would end the hold before now. Remove it instead.',
  sameDay: 'A date of a weekly hold stays on its day. Skip it and hold the other day instead.',
};

/** A date's own tables are forgotten this long after the date ends */
const KEEP_DATES_DAYS = 31;

/**
 * Made on every start when missing (as ROUND16_WISHLIST is), so they never wait on a step in MIGRATIONS:
 *  - event_hold_dates: an event date's own tables (contract v22-holds section 1), one row per date. event_gid is the
 *    lair_event entry's Shopify id when the date was changed: a handle can be used again by a new entry (one deleted in
 *    Shopify admin, then made again with the same title), and the new one never takes the old one's dates.
 */
export const HOLD_TABLES = [
  `CREATE TABLE IF NOT EXISTS event_hold_dates (
    occurrence_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, event_gid TEXT, tables TEXT NOT NULL, starts_at INTEGER, ends_at INTEGER,
    by TEXT, updated_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS event_hold_dates_event ON event_hold_dates (event_id)',
];
/** blocks.changed: 1 for a weekly hold's date changed on its own, so a change to every date leaves it be */
export const HOLD_COLUMNS = [['blocks', 'changed', 'INTEGER NOT NULL DEFAULT 0']];

const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
const has = (input, key) => Boolean(input) && Object.prototype.hasOwnProperty.call(input, key);
const byOf = (who) => (who.customerId ? `staff:${who.customerId}` : 'staff');

/**
 * A time sent as ms: a number, or the digits of one. Nothing else is a time (null, '' and false aren't 1970, and true
 * isn't 1 ms after it). → ms, or NaN.
 */
export function timeOf(raw) {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : NaN;
}

export const holdMethods = {
  /* ---------------- an event date's own tables ---------------- */

  /**
   * Every event date's own tables as a Map of occurrence id → { eventId, gid, tables, by, at }, read once and kept until
   * one changes (only the methods here write them). No awaits.
   */
  holdDatesMap() {
    if (!this.holdDatesCache) {
      this.holdDatesCache = new Map(
        this.sql.exec('SELECT * FROM event_hold_dates').toArray()
          .map((r) => [r.occurrence_id, { eventId: r.event_id, gid: r.event_gid || null, tables: parse(r.tables, []), by: r.by || null, at: r.updated_at }]),
      );
    }
    return this.holdDatesCache;
  },

  /**
   * rules with rules.holdDates current (the rules are kept for 5 minutes; the dates' own tables change any time): the
   * dates' own tables less any changed for an earlier entry with the same handle (its Shopify id isn't the event's now).
   * Worked out again only when either changes. No awaits.
   */
  withHoldDates(rules) {
    if (!rules) return rules;
    const all = this.holdDatesMap();
    const memo = this.holdDatesMemo;
    if (!memo || memo.all !== all || memo.events !== rules.events) {
      const gids = new Map((rules.events || []).map((e) => [e.id, e.gid || null]));
      const mine = new Map([...all].filter(([, row]) => {
        const gid = gids.get(row.eventId);
        return !(row.gid && gid && row.gid !== gid);
      }));
      this.holdDatesMemo = { all, events: rules.events, mine };
    }
    rules.holdDates = this.holdDatesMemo.mine;
    return rules;
  },

  /** Every write to event_hold_dates goes through here, so the floor and rules.holdDates follow it at once. */
  writeHoldDate(query, ...bindings) {
    this.write(query, ...bindings);
    this.holdDatesCache = null;
  },

  /**
   * POST /events/:occurrenceId/hold { tables } or { usual: true } (staff with Tables or Events, contract v22-holds
   * section 1): the tables one date of an event holds. [] or '' holds none that date; the usual ones (or usual: true)
   * are back to usual. Holding never moves a booking. → { hold, clashes }.
   */
  async holdEventDate(occurrenceId, input, who) {
    this.requireStaff(who, ['tables', 'events']);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const id = String(occurrenceId || '').slice(0, 160);
    const o = findOccurrence(rules, id);
    if (!o) throw new RuleError(HOLD_WORDS.noDate, 404);
    if (o.end <= now) throw new RuleError(HOLD_WORDS.dateOver, 409);
    const { usual } = dateTables(o, rules);
    let tables = null;
    if (input?.usual === true) tables = usual;
    else if (Array.isArray(input?.tables)) {
      const index = tableIndex(rules.rooms);
      const ids = [...new Set(input.tables.map((t) => String(t ?? '').trim().toUpperCase()).filter(Boolean))];
      if (ids.some((t) => !index.has(t))) throw new RuleError(HOLD_WORDS.badTables);
      tables = ids;
    } else if (typeof input?.tables === 'string') {
      const spec = input.tables.trim();
      if (spec && !this.tablesExist(spec, rules.rooms)) throw new RuleError(HOLD_WORDS.badTables);
      tables = parseTableList(spec, rules.rooms);
    } else {
      throw new RuleError(HOLD_WORDS.sendTables);
    }
    tables = inTableOrder(tables, rules.rooms);
    if (sameTables(tables, usual)) {
      this.writeHoldDate('DELETE FROM event_hold_dates WHERE occurrence_id = ?', o.id);
    } else {
      const gid = (rules.events || []).find((e) => e.id === o.eventId)?.gid || null;
      this.writeHoldDate(
        `INSERT INTO event_hold_dates (occurrence_id, event_id, event_gid, tables, starts_at, ends_at, by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(occurrence_id) DO UPDATE SET event_id = excluded.event_id, event_gid = excluded.event_gid, tables = excluded.tables,
         starts_at = excluded.starts_at, ends_at = excluded.ends_at, by = excluded.by, updated_at = excluded.updated_at`,
        o.id, o.eventId, gid, JSON.stringify(tables), o.start, o.end, byOf(who), now,
      );
    }
    // (the rules then have the date's tables as they are now)
    const hold = { eventId: o.eventId, title: o.title, ...this.holdDateView(o, this.withHoldDates(rules)) };
    return { hold, clashes: this.eventDateClashes(o, hold.tables) };
  },

  /** A date as holdEvents has it: { occurrenceId, start, end, tables, changed, by?, at? }. No awaits. */
  holdDateView(o, rules) {
    const { tables, changed } = dateTables(o, rules);
    const own = changed ? rules.holdDates?.get(o.id) : null;
    return { occurrenceId: o.id, start: o.start, end: o.end, tables, changed, ...(own ? { by: own.by, at: own.at } : {}) };
  },

  /** The active bookings that overlap an event date on these tables, other than the event's own: [{ ref, start }]. No awaits. */
  eventDateClashes(o, tables) {
    if (!tables.length) return [];
    return this.sql
      .exec('SELECT * FROM bookings WHERE ends_at > ? AND starts_at < ?', o.start, o.end).toArray()
      .map((r) => this.rowToBooking(r))
      .filter((b) => ACTIVE.has(b.status) && b.occurrenceId !== o.id && b.tables.some((t) => tables.includes(t)))
      .sort((a, b) => a.start - b.start || a.ref.localeCompare(b.ref))
      .map((b) => ({ ref: b.ref, start: b.start }));
  },

  /**
   * The staff floor's holdEvents (contract v22-holds section 3): each event with tables held in [from, to) (its usual
   * tables, or a date's own), soonest date first, with every date in the window. An event with no Tables reserved lists
   * only its dates with their own tables. No awaits.
   */
  holdEventsIn(rules, from, to) {
    const own = rules.holdDates instanceof Map ? rules.holdDates : new Map();
    const changedEvents = new Set([...own.values()].map((c) => c.eventId));
    const events = (rules.events || []).filter((e) => e.tables || changedEvents.has(e.id));
    const byId = new Map(events.map((e) => [e.id, e]));
    const out = new Map();
    for (const o of eventOccurrences({ ...rules, events }, from, to)) {
      const date = this.holdDateView(o, rules);
      const { usual } = dateTables(o, rules);
      if (!usual.length && !date.changed) continue;
      if (!out.has(o.eventId)) {
        const e = byId.get(o.eventId);
        const repeat = ['weekly', 'fortnightly', 'monthly'].includes(String(e.repeat || '').toLowerCase()) ? String(e.repeat).toLowerCase() : null;
        out.set(o.eventId, {
          eventId: o.eventId, title: o.title, repeat, repeatTag: repeat ? this.repeatTag(e, rules) : null, usual, usualText: String(e.tables || '').trim(),
          locked: Boolean(o.lockTables), gameTables: String(e.gameTables || '').trim(), dates: [],
        });
      }
      out.get(o.eventId).dates.push(date);
    }
    return [...out.values()].sort((a, b) => a.dates[0].start - b.dates[0].start || a.title.localeCompare(b.title));
  },

  /**
   * After an event's Tables reserved changed (updateEvent): its dates' own tables that are now the same as the new usual
   * ones go back to usual. Others are kept. No awaits.
   */
  dropMatchingDates(handle, usual) {
    const rows = this.sql.exec('SELECT occurrence_id, tables FROM event_hold_dates WHERE event_id = ?', String(handle)).toArray();
    const same = rows.filter((r) => sameTables(parse(r.tables, []), usual));
    for (const r of same) this.writeHoldDate('DELETE FROM event_hold_dates WHERE occurrence_id = ?', r.occurrence_id);
    return same.length;
  },

  /** An event that's gone (deleted): its dates' own tables go too, so a new event with its handle starts clean. No awaits. */
  forgetEventDates(handle) {
    this.writeHoldDate('DELETE FROM event_hold_dates WHERE event_id = ?', String(handle));
  },

  /** Maintenance: dates' own tables are forgotten 31 days after the date ends. → how many. No awaits. */
  tidyHoldDates(now) {
    const before = now - KEEP_DATES_DAYS * 24 * HOUR;
    const n = this.sql.exec('SELECT COUNT(*) AS n FROM event_hold_dates WHERE ends_at < ?', before).one().n;
    if (n) this.writeHoldDate('DELETE FROM event_hold_dates WHERE ends_at < ?', before);
    return n;
  },

  /* ---------------- editing a staff hold ---------------- */

  /**
   * What an edit to a staff hold says, checked against the hold as it is (current: rowToBlock's). Returns the hold
   * after the change: { tables, start, end, label, type, game }. No awaits.
   */
  holdEdit(input, rules, current) {
    const out = { ...current };
    if (has(input, 'tables')) {
      const index = tableIndex(rules.rooms);
      // written as the Hold tables form takes them: every part has to be tables that exist ('T14, T99' isn't T14)
      if (!Array.isArray(input.tables) && !this.tablesExist(String(input.tables ?? ''), rules.rooms)) throw new RuleError(HOLD_WORDS.holdTables);
      const tables = (Array.isArray(input.tables) ? input.tables : parseTableList(String(input.tables), rules.rooms)).map((t) => String(t ?? '').trim().toUpperCase());
      if (!tables.length || tables.some((t) => !index.has(t))) throw new RuleError(HOLD_WORDS.holdTables);
      out.tables = inTableOrder([...new Set(tables)], rules.rooms);
    }
    for (const key of ['start', 'end']) {
      if (!has(input, key)) continue;
      const value = timeOf(input[key]);
      if (!Number.isFinite(value)) throw new RuleError(HOLD_WORDS.endAfter);
      out[key] = value;
    }
    if (!(out.end > out.start)) throw new RuleError(HOLD_WORDS.endAfter);
    if (has(input, 'label')) out.label = String(input.label ?? '').trim().slice(0, 80) || 'Held';
    if (has(input, 'type')) out.type = String(input.type ?? '').trim().slice(0, 20) || 'event';
    if (has(input, 'game')) out.game = String(input.game ?? '').trim().slice(0, 40) || null;
    return out;
  },

  /**
   * POST /blocks/:id/update (staff with Tables, contract v22-holds section 4): a one-off's tables, times, what it's for,
   * type and game; a weekly hold's date on its own (scope 'date': its tables and times, on its own day; usual: true puts
   * it back) or every date to come (scope 'series'). Holding never moves a booking. → { block, clashes, series, kept }.
   */
  async updateBlock(id, input, who) {
    this.requireStaff(who, 'tables');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const time = new LairTime(rules.tz);
    const row = this.sql.exec('SELECT * FROM blocks WHERE id = ?', String(id || '')).toArray()[0];
    if (!row) throw new RuleError(HOLD_WORDS.noHold, 404);
    if (row.ends_at <= now) throw new RuleError(HOLD_WORDS.holdOver, 409);
    const series = row.series_id ? this.sql.exec('SELECT * FROM block_series WHERE id = ?', row.series_id).toArray()[0] || null : null;
    const current = this.rowToBlock(row);
    const body = input || {};
    if (!series) {
      const next = this.holdEdit(body, rules, current);
      if (next.end <= now) throw new RuleError(HOLD_WORDS.endPast);
      this.saveHoldEdit(row.id, next, row.changed ? 1 : 0);
      return { block: this.blockOf(row.id, rules), clashes: this.holdClashes([next], next.tables), series: null, kept: [] };
    }
    if (body.scope !== 'date' && body.scope !== 'series') throw new RuleError(HOLD_WORDS.scope);
    const usual = this.seriesHoldOn(series, time.key(row.starts_at), time);
    if (body.scope === 'date') {
      // its tables and times only (what it's for, its type and game are the whole hold's)
      const next = body.usual === true ? usual : this.holdEdit(pick(body, ['tables', 'start', 'end']), rules, current);
      if (time.key(next.start) !== time.key(row.starts_at)) throw new RuleError(HOLD_WORDS.sameDay);
      if (next.end <= now) throw new RuleError(HOLD_WORDS.endPast);
      const changed = body.usual === true ? 0 : sameHold(next, usual) ? 0 : 1;
      this.saveHoldEdit(row.id, next, changed);
      return { block: this.blockOf(row.id, rules), clashes: this.holdClashes([next], next.tables), series: this.seriesView(series, rules, now), kept: [] };
    }
    // every date to come: the series' tables, clock time and length, label, type and game, read on this date
    const next = this.holdEdit(body, rules, usual);
    const startMin = time.minutesOf(next.start);
    const minutes = Math.max(1, Math.round((next.end - next.start) / MIN));
    this.write(
      'UPDATE block_series SET tables = ?, start_min = ?, minutes = ?, label = ?, type = ?, game = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(next.tables), startMin, minutes, next.label, next.type, next.game || null, now, series.id,
    );
    const fresh = this.sql.exec('SELECT * FROM block_series WHERE id = ?', series.id).toArray()[0];
    const moved = [];
    const kept = [];
    for (const r of this.sql.exec('SELECT * FROM blocks WHERE series_id = ? AND starts_at > ? ORDER BY starts_at, id', series.id, now).toArray()) {
      if (r.changed) {
        // a date changed on its own keeps its tables and times; what it's for is the whole hold's
        this.write('UPDATE blocks SET label = ?, type = ?, game = ? WHERE id = ?', next.label, next.type, next.game || null, r.id);
        kept.push({ id: r.id, start: r.starts_at });
        continue;
      }
      const hold = this.seriesHoldOn(fresh, time.key(r.starts_at), time);
      this.saveHoldEdit(r.id, hold, 0);
      moved.push(hold);
    }
    const block = this.blockOf(row.id, rules);
    return { block, clashes: this.holdClashes(moved, next.tables), series: this.seriesView(fresh, rules, now), kept };
  },

  /** A hold series' hold on a day, as it makes them: its tables, Lair clock time and length, label, type and game. No awaits. */
  seriesHoldOn(series, day, time) {
    const start = time.at(day, series.start_min);
    return {
      tables: parse(series.tables, []), start, end: start + series.minutes * MIN, label: series.label || 'Held', type: series.type || 'event',
      game: series.game || null,
    };
  },

  /** A staff hold's row after an edit. No awaits. */
  saveHoldEdit(id, hold, changed) {
    this.write(
      'UPDATE blocks SET tables = ?, starts_at = ?, ends_at = ?, label = ?, type = ?, game = ?, changed = ? WHERE id = ?',
      JSON.stringify(hold.tables), hold.start, hold.end, hold.label, hold.type, hold.game || null, changed, id,
    );
  },

  /** A staff hold as the staff floor has it (staffBlocks: its series and whether it's changed). No awaits. */
  blockOf(id, rules) {
    const row = this.sql.exec('SELECT * FROM blocks WHERE id = ?', id).toArray()[0];
    return row ? this.staffBlocks([this.rowToBlock(row)], rules)[0] : null;
  },
};

/** Only these keys of an object (the ones it has) */
function pick(input, keys) {
  return Object.fromEntries(keys.filter((k) => has(input, k)).map((k) => [k, input[k]]));
}

/** Two holds with the same tables and times */
function sameHold(a, b) {
  return a.start === b.start && a.end === b.end && sameTables(a.tables, b.tables);
}

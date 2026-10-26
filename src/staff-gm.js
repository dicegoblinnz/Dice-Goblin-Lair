/**
 * Round 17: staff GMs and the GM credit (contract v17-staff-gm-credit). Mo (16 Oct 2026): "I want to make the staff
 * assigned to run roleplaying games for GM games don't get the store credit of $5 per player as I pay them to be there
 * and it needs to not go to them. Please make an option for me to toggle that so that the players still gets charged
 * $15 and the GMs don't get $5 store credit as they are staff or a toggle so during staff hours, so if they are on the
 * clock they cannot earn any store credit but outside of their hours they can earn store credit as anyone else."
 *
 * One setting for the whole team, the main account's (on the Team tab), kept in meta ('staff-gm-credit'):
 *  - 'never': staff earn no GM credit for a session they run (the setting until the main account changes it).
 *  - 'shifts': staff earn none for a session that overlaps their hours, even partly; outside them, like any GM.
 *  - 'earn': staff earn it like any GM (as before round 17).
 * "Staff" is the team: the main account (tagged staff in Shopify) and the helpers (the Team tab). Each person's hours are
 * weekly times in Lair time, in the table staff_hours. Players pay what they always pay: only the GM's credit changes,
 * and only when staff tap "Session done" on the GM games tab (POST /games/:id/credit), where a staff GM's session is
 * recorded with no credit (credits.status 'staff', amount 0) and can't be credited again.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { RuleError, addDays, lairTime } from './core.js';
import { autoCredit } from './gm-credit.js';

/** The three choices, in the order the Team tab shows them, and the one used until the main account picks */
export const STAFF_GM_MODES = ['never', 'shifts', 'earn'];
export const STAFF_GM_DEFAULT = 'never';
/** Each choice's words, as the Team tab shows them (GET /team gmCredit.choices) */
export const STAFF_GM_CHOICES = {
  never: { label: 'Never', words: "Staff don't earn GM credit for the sessions they run: they're paid to be there." },
  shifts: { label: 'Not in their hours', words: 'No GM credit for a session in their hours, even partly. Outside their hours they earn it like any GM.' },
  earn: { label: 'Always', words: 'Staff earn GM credit like any GM.' },
};
/** Days as hours are kept (Monday first, as the Team tab lists them), and as LairTime.weekday numbers them (Sunday 0) */
export const HOURS_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const DAY_SHORT = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
/** The most times one person has on one day */
export const HOURS_PER_DAY_MAX = 3;
/** Every message staff can see, word for word in the contract */
export const STAFF_GM_MESSAGES = {
  mode: 'Pick one of the three choices for GM credit for staff.',
  hours: 'Send their hours as a list of times, each with a day, a start and an end.',
  day: 'Each time needs a day: Mon, Tue, Wed, Thu, Fri, Sat or Sun.',
  time: (day) => `Each time on ${DAY_NAMES[day]} needs a start and an end, like 16:00 and 22:00.`,
  order: (day) => `A time on ${DAY_NAMES[day]} ends before it starts. Use 24:00 for midnight.`,
  overlap: (day) => `Two of the times on ${DAY_NAMES[day]} overlap. Make them one.`,
  many: (day) => `${DAY_NAMES[day]} has more than ${HOURS_PER_DAY_MAX} times. Join some of them up.`,
  team: "They're not on the team. Make them a helper first.",
  onShift: "onShift is true (they were working), false (they weren't) or left out (their hours decide).",
  markOwner: 'Only the main account can mark whether a staff GM was working.',
  expect: "expect is 'credit', 'none' or left out.",
  expectChanged: 'GM credit for staff, their hours or the team changed since this page loaded. Check the session again.',
  changed: "This session's GM changed. Check the session again.",
  tags: "Gobgob couldn't check whether the GM is on the team just now. Try again in a moment.",
};

const META_KEY = 'staff-gm-credit';
const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
const players = (n) => `${n} paying player${n === 1 ? '' : 's'}`;

/** "16:00" or "4:00" → minutes. A start is 00:00 to 23:59; an end is 00:01 to 24:00, and an end of 00:00 is midnight. */
function clockMinutes(value, end) {
  const m = typeof value === 'string' ? value.trim().match(/^(\d{1,2}):(\d{2})$/) : null;
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[2]) > 59) return null;
  if (end) {
    if (minutes === 0 || minutes === 24 * 60) return 24 * 60;
    return minutes < 24 * 60 ? minutes : null;
  }
  return minutes < 24 * 60 ? minutes : null;
}
const clockText = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
/** A time as people say it: 4pm, 4:30pm, 10am, midday, midnight */
function sayClock(minutes) {
  if (minutes === 0 || minutes === 24 * 60) return 'midnight';
  if (minutes === 12 * 60) return 'midday';
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Someone's hours as sent: a list of { day, from, to }. day is mon to sun (any case, a whole day name too); from and to
 * are "HH:MM" in Lair time, from before to, with 24:00 (or 00:00 as an end) for midnight; times on one day can't
 * overlap (one can start when another ends), and a day has HOURS_PER_DAY_MAX at most. → the same list, cleaned and
 * sorted (Monday first, then by start): [{ day, from: 'HH:MM', to: 'HH:MM' }]. An empty list clears their hours.
 * Throws a RuleError (422) for anything else.
 */
export function cleanStaffHours(list) {
  if (!Array.isArray(list) || list.length > HOURS_DAYS.length * HOURS_PER_DAY_MAX) throw new RuleError(STAFF_GM_MESSAGES.hours);
  const byDay = new Map(HOURS_DAYS.map((d) => [d, []]));
  for (const item of list) {
    if (!item || typeof item !== 'object') throw new RuleError(STAFF_GM_MESSAGES.hours);
    const day = typeof item.day === 'string' ? item.day.trim().toLowerCase().slice(0, 3) : '';
    if (!byDay.has(day) || (item.day.trim().length > 3 && !DAY_NAMES[day].toLowerCase().startsWith(item.day.trim().toLowerCase()))) {
      throw new RuleError(STAFF_GM_MESSAGES.day);
    }
    const from = clockMinutes(item.from, false);
    const to = clockMinutes(item.to, true);
    if (from === null || to === null) throw new RuleError(STAFF_GM_MESSAGES.time(day));
    if (to <= from) throw new RuleError(STAFF_GM_MESSAGES.order(day));
    byDay.get(day).push([from, to]);
  }
  const out = [];
  for (const day of HOURS_DAYS) {
    const times = byDay.get(day).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (times.length > HOURS_PER_DAY_MAX) throw new RuleError(STAFF_GM_MESSAGES.many(day));
    times.forEach(([from, to], i) => {
      if (i && from < times[i - 1][1]) throw new RuleError(STAFF_GM_MESSAGES.overlap(day));
      out.push({ day, from: clockText(from), to: clockText(to) });
    });
  }
  return out;
}

/** One time as people say it: "Sat 10am–6pm" */
export const shiftText = (s) => `${DAY_SHORT[s.day]} ${sayClock(toMinutes(s.from))}–${sayClock(toMinutes(s.to))}`;
/** Someone's hours as the Team tab and the notes say them: "Mon 4pm–10pm, Sat 10am–6pm", or '' for none */
export const staffHoursText = (hours) => (hours || []).map(shiftText).join(', ');

/**
 * The first of someone's times that a session overlaps, even partly (the session from start to end, in ms), or null.
 * Each day the session touches is checked against that weekday's times, in Lair time (so daylight saving is right).
 */
export function shiftFor(hours, start, end, time) {
  if (!Array.isArray(hours) || !hours.length || !(end > start)) return null;
  const last = time.key(end - 1);
  for (let key = time.key(start), guard = 0; key <= last && guard < 3; key = addDays(key, 1), guard += 1) {
    const day = WEEKDAY_KEYS[time.weekday(key)];
    for (const s of hours) {
      if (s.day !== day) continue;
      if (time.at(key, toMinutes(s.from)) < end && start < time.at(key, toMinutes(s.to))) return s;
    }
  }
  return null;
}

/** A session ready for its GM's credit: it has a GM account and a GM fee, has started, isn't cancelled and isn't credited */
// (round 18: a free session has no GM credit to give, so nothing for staff to weigh. Round 21: nor does a session from
// 26 Oct 2026 on, whose GM credit adds itself)
export const readyForCredit = (g, now) => Boolean(g?.gmCustomerId) && g.credited == null && g.start <= now && g.status !== 'cancelled' && (g.gmFee ?? 1) > 0 && !g.free && !autoCredit(g);

export const staffGmMethods = {
  /** The team's setting: 'never', 'shifts' or 'earn' (STAFF_GM_DEFAULT until the main account picks). No awaits. */
  staffGmMode() {
    return this.staffGmSaved()?.mode || STAFF_GM_DEFAULT;
  },

  /** What meta keeps: { mode, by, at }, or null when it's never been set. No awaits. */
  staffGmSaved() {
    const row = this.sql.exec('SELECT value FROM meta WHERE key = ?', META_KEY).toArray()[0];
    if (!row) return null;
    try {
      const saved = JSON.parse(row.value);
      return saved && STAFF_GM_MODES.includes(saved.mode) ? saved : null;
    } catch {
      return null;
    }
  },

  /**
   * The setting as GET /team sends it: { mode, choices: [{ key, label, words }], changedBy: { customerId, name } | null,
   * changedAt (ms) | null }. No awaits.
   */
  staffGmSetting() {
    const saved = this.staffGmSaved();
    const by = saved?.by ? this.memberRow(saved.by) : null;
    return {
      mode: saved?.mode || STAFF_GM_DEFAULT,
      choices: STAFF_GM_MODES.map((key) => ({ key, ...STAFF_GM_CHOICES[key] })),
      changedBy: saved?.by ? { customerId: String(saved.by), name: by?.name || by?.first_name || '' } : null,
      changedAt: saved?.at || null,
    };
  },

  /** POST /team/gm-credit { mode } (the main account): the setting → { gmCredit } (staffGmSetting). No awaits. */
  setStaffGmMode(input, who) {
    this.requireStaff(who, 'team');
    const mode = typeof input?.mode === 'string' ? input.mode.trim() : '';
    if (!STAFF_GM_MODES.includes(mode)) throw new RuleError(STAFF_GM_MESSAGES.mode);
    const value = JSON.stringify({ mode, by: who.customerId ? String(who.customerId) : null, at: Date.now() });
    this.write('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', META_KEY, value);
    return { gmCredit: this.staffGmSetting() };
  },

  /** Someone's hours as kept (cleanStaffHours' shape), or [] when they have none. No awaits. */
  staffHoursOf(customerId) {
    if (!customerId) return [];
    const row = this.sql.exec('SELECT hours FROM staff_hours WHERE customer_id = ?', String(customerId)).toArray()[0];
    if (!row) return [];
    try {
      const hours = JSON.parse(row.hours);
      return Array.isArray(hours) ? hours.filter((s) => s && HOURS_DAYS.includes(s.day) && /^\d{2}:\d{2}$/.test(s.from) && /^\d{2}:\d{2}$/.test(s.to)) : [];
    } catch {
      return [];
    }
  },

  /** { hours, hoursText } for GET /team's owners and helpers. No awaits. */
  staffHoursView(customerId) {
    const hours = this.staffHoursOf(customerId);
    return { hours, hoursText: staffHoursText(hours) };
  },

  /**
   * POST /team/:customerId/hours { hours: [{ day, from, to }] } (the main account): someone on the team's weekly hours,
   * all of them at once ([] clears them). Only someone on the team (the main account or a helper) has hours: anyone
   * else is a 404. → { customerId, hours, hoursText }.
   */
  async setStaffHours(customerId, input, who) {
    this.requireStaff(who, 'team');
    const id = String(customerId || '').trim();
    const hours = cleanStaffHours(input?.hours);
    const person = id ? await this.person(id) : null;
    if (!person?.staff) throw new RuleError(STAFF_GM_MESSAGES.team, 404);
    // --- no awaits from here on ---
    if (hours.length) {
      this.write(
        `INSERT INTO staff_hours (customer_id, hours, by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(customer_id) DO UPDATE SET hours = excluded.hours, by = excluded.by, updated_at = excluded.updated_at`,
        id, JSON.stringify(hours), who.customerId ? String(who.customerId) : null, Date.now(),
      );
    } else {
      this.write('DELETE FROM staff_hours WHERE customer_id = ?', id);
    }
    return { customerId: id, hours, hoursText: staffHoursText(hours) };
  },

  /**
   * Whether the team's setting keeps a session's GM credit from its GM. gm is the GM as person() gives them (staff for
   * the main account and helpers). onShift (POST /games/:id/credit, the 'shifts' setting only) is staff marking that
   * the GM was working (true) or wasn't (false) whatever their hours say. → null when the setting doesn't touch this
   * GM (not staff, or 'earn'), else { mode, credit (whether they get it), onShift (true, false, or null for 'never'),
   * marked (onShift came from staff, not their hours), shift (the time it overlapped, as shiftText, or null), hours (all
   * their hours, as staffHoursText) }. No awaits.
   */
  staffGmRule(game, gm, rules, onShift = null) {
    if (!game?.gmCustomerId || !gm?.staff || String(gm.customerId) !== String(game.gmCustomerId)) return null;
    const mode = this.staffGmMode();
    if (mode === 'earn') return null;
    if (mode === 'never') return { mode, credit: false, onShift: null, marked: false, shift: null, hours: '' };
    const hours = this.staffHoursOf(game.gmCustomerId);
    const shift = shiftFor(hours, game.start, game.end, lairTime(rules?.tz));
    const marked = typeof onShift === 'boolean';
    const on = marked ? onShift : Boolean(shift);
    return { mode, credit: !on, onShift: on, marked, shift: shift ? shiftText(shift) : null, hours: staffHoursText(hours) };
  },

  /**
   * The credit record's note for a staff GM (credits.note, and the answer the staff page shows). markedBy: the first name
   * of whoever marked whether they were working (the main account), when the note is about that. No awaits.
   */
  staffGmNote(rule, game, due, count, markedBy = '') {
    const name = String(game.gm || '').trim() || 'The GM';
    const would = `${dollars(due)} for ${players(count)}`;
    const marked = `as ${markedBy ? `${markedBy} marked` : 'marked'} on the staff page`;
    if (rule.mode === 'never') return `No GM credit: ${name} is staff, and staff don't earn GM credit (it would have been ${would}).`;
    if (!rule.credit) {
      return rule.marked
        ? `No GM credit: ${name} was working then, ${marked} (it would have been ${would}).`
        : `No GM credit: it was in ${name}'s hours, ${rule.shift} (it would have been ${would}).`;
    }
    return rule.marked
      ? `${name} wasn't working then, ${marked}, so they earn it like any GM.`
      : `It was outside ${name}'s hours, so they earn it like any GM.`;
  },

  /**
   * The GM emails' "Your credit" line (tellGmLive and inviteGm), with the team's setting for a staff GM. Staff here is
   * a helper, or the main account when its tags are already known (the emails don't wait on Shopify). No awaits.
   */
  gmCreditLine(game, rules) {
    // Round 18: a free session's players pay nothing, so there's no GM fee to pass on
    if (game.free) return 'None: this session is free for the players, so there are no GM fees';
    const credit = game.gmFee ?? rules.prices.gmCredit;
    if (!credit) return "None: you're covering your players' GM fee, so they pay just the table fee";
    const usual = `${dollars(credit)} store credit for each paying player, after the session`;
    const id = game.gmCustomerId;
    const staff = Boolean(id) && (Boolean(this.helperRow(id)) || Boolean(this.people?.get(id)?.person?.staff));
    if (!staff) return usual;
    const rule = this.staffGmRule(game, { customerId: id, staff: true }, rules);
    if (!rule) return usual;
    if (rule.mode === 'never') return "None: you're on the Dice Goblin team, and staff don't earn GM credit for the sessions they run";
    if (!rule.credit) return `None for this session: it's in your hours (${rule.shift}). Staff don't earn GM credit in their hours`;
    return `${usual} (it's outside your hours)`;
  },

  /**
   * For the floor (staff): the GMs on the team among the sessions ready for their GM credit (started, not credited, not
   * cancelled, with a GM fee), by customer ID, as { customerId, staff: true }. The floor never waits on Shopify: a helper
   * is read here, and the main account counts when its tags are already known (kept 5 minutes). A GM whose tags aren't
   * known is looked up after the answer goes (at most once a minute each), for the next time; until then the card
   * shows the usual credit, and "Session done" (which asks Shopify itself) says what it did. null for 'earn'. No awaits.
   */
  staffGmTeam(games, now) {
    if (this.staffGmMode() === 'earn') return null;
    const ids = [...new Set((games || []).filter((g) => readyForCredit(g, now)).map((g) => String(g.gmCustomerId)))];
    const team = new Map();
    if (!this.staffGmAsked) this.staffGmAsked = new Map();
    for (const id of ids) {
      if (this.helperRow(id)) team.set(id, { customerId: id, staff: true });
      const known = this.people?.get(id);
      if (known && Date.now() - known.at < 5 * 60_000) {
        if (known.person.staff) team.set(id, { customerId: id, staff: true });
      } else if (!team.has(id) && Date.now() - (this.staffGmAsked.get(id) || 0) > 60_000) {
        if (this.staffGmAsked.size > 500) this.staffGmAsked.clear();
        this.staffGmAsked.set(id, Date.now());
        this.later(this.taggedPerson(id));
      }
    }
    return team;
  },

  /** For the floor (staff): the GM credit recorded for each session from..to, by game ID: { status, amount, players, note, at }. No awaits. */
  creditsIn(from, to) {
    const rows = this.sql
      .exec(
        'SELECT c.game_id, c.status, c.amount, c.players, c.note, c.created_at FROM credits c JOIN games g ON g.id = c.game_id WHERE g.ends_at > ? AND g.starts_at < ? ORDER BY c.created_at, c.rowid',
        from, to,
      )
      .toArray();
    return new Map(rows.map((r) => [r.game_id, { status: r.status, amount: r.amount, players: r.players, note: r.note || '', at: r.created_at }]));
  },

  /**
   * GET /me's customer.staffGmCredit for someone on the team, so the GM pages say it right: { mode: 'never' | 'shifts',
   * hours (theirs, cleanStaffHours' shape), hoursText }, or null (not staff, or the setting is 'earn'). No awaits.
   */
  staffGmFor(who) {
    if (!who?.staff || !who.customerId) return null;
    const mode = this.staffGmMode();
    if (mode === 'earn') return null;
    return { mode, ...this.staffHoursView(who.customerId) };
  },
};

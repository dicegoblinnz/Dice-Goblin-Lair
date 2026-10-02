// Dice Goblin Lair — shared booking rules (no Cloudflare or Shopify APIs here, so it is unit-testable).

export const MIN = 60_000;
export const HOUR = 60 * MIN;
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const REF_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ACTIVE = new Set(['held', 'confirmed', 'seated']);

/** The first release's references, like GOB-7K2QXM: 6 characters, no look-alikes (0/O, 1/I/L). Still valid at the counter. */
export const makeRef = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `GOB-${Array.from(bytes, (b) => REF_CHARS[b % REF_CHARS.length]).join('')}`;
};

/**
 * The name part of a ticket code: the booker's first name in capitals, A–Z only (Tūī → TUI), cut to 10 letters.
 * GOB when there are fewer than 2 letters to use. Never DGC, which is kept for member cards.
 */
export function refName(name) {
  const first = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().split(/\s+/)[0] || '';
  const letters = first.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10);
  return letters.length >= 2 && letters !== 'DGC' ? letters : 'GOB';
}

/** Ticket codes like SAM-4821: the booker's first name and 4 digits. Callers check they're unused. */
export const makeNameRef = (name) => `${refName(name)}-${String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0')}`;

/**
 * What staff scanned or typed at the counter. Scanners send a code with or without its dash, sometimes with other
 * characters around it. Returns { card: customerId } for a member card (DGC-<customer id>), { refs } with every
 * ticket code it could be (GOBAB2345 could be GOB-AB2345 or GOBAB-2345; the caller looks each up), or null.
 */
export function parseTicketCode(text) {
  const upper = String(text || '').toUpperCase();
  const bare = upper.replace(/[^A-Z0-9]/g, '');
  const card = bare.match(/^DGC(\d{1,20})$/);
  if (card) return { card: card[1], refs: [] };
  const refs = [];
  const add = (ref) => {
    if (!refs.includes(ref)) refs.push(ref);
  };
  for (const m of upper.matchAll(/(?:^|[^A-Z])([A-Z]{2,10})-(\d{4})(?!\d)/g)) add(`${m[1]}-${m[2]}`);
  for (const m of upper.matchAll(/GOB-([A-Z0-9]{6})(?![A-Z0-9])/g)) add(`GOB-${m[1]}`);
  if (refs.length) return { card: null, refs };
  // No dash: every way the letters and digits could split.
  let m = bare.match(/^([A-Z]{2,10})(\d{4})$/);
  if (m) add(`${m[1]}-${m[2]}`);
  m = bare.match(/GOB([A-Z0-9]{6})/);
  if (m) add(`GOB-${m[1]}`);
  m = bare.match(/^([A-Z0-9]{6})$/);
  if (m) add(`GOB-${m[1]}`);
  return refs.length ? { card: null, refs } : null;
}
/** Online bookings (not staff) can't be bigger than this; bigger groups call the shop. */
export const ONLINE_LIMITS = { people: 24, tables: 10 };
/** What we should know about a booking: the only extras the app keeps. Wargames and big box games get double tables. */
export const BOOKING_EXTRAS = ['wargame', 'bigbox', 'celebrating'];
const DOUBLE_EXTRAS = new Set(['wargame', 'bigbox']);
/**
 * Most tables an online booking may take: enough tables to seat the group (4 to a table in most rooms), doubled
 * for a wargame or big box game. 1-4 people get 1 table (2 for a wargame), 5-8 get 2 (or 4), and so on.
 */
export const maxOnlineTables = (people, seatsPerTable = 4, extras = []) =>
  Math.min(ONLINE_LIMITS.tables, Math.max(1, Math.ceil(people / Math.max(1, seatsPerTable))) * (extras.some((x) => DOUBLE_EXTRAS.has(x)) ? 2 : 1));
/** GM games may take enough tables for the players, and always at least 2 (a GM decides their own setup). The GM isn't counted. */
export const maxGameTables = (people, seatsPerTable = 4) => Math.min(ONLINE_LIMITS.tables, Math.max(2, Math.ceil(people / Math.max(1, seatsPerTable))));
export const makeId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
export const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/* ---------- Lair wall-clock time ---------- */
export class LairTime {
  constructor(tz = 'Pacific/Auckland') {
    this.tz = tz;
    this.fmt = new Intl.DateTimeFormat('en-NZ', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  }

  parts(ms) {
    const out = {};
    for (const p of this.fmt.formatToParts(new Date(ms))) out[p.type] = p.value;
    return { y: +out.year, m: +out.month, d: +out.day, h: +out.hour % 24, mi: +out.minute };
  }

  offset(ms) {
    const p = this.parts(ms);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ms / MIN) * MIN;
  }

  toUtc(y, m, d, h = 0, mi = 0) {
    const guess = Date.UTC(y, m - 1, d, h, mi);
    const first = guess - this.offset(guess);
    return guess - this.offset(first);
  }

  key(ms) {
    const p = this.parts(ms);
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  }

  at(key, minutes) {
    const [y, m, d] = key.split('-').map(Number);
    return this.toUtc(y, m, d, Math.floor(minutes / 60), minutes % 60);
  }

  weekday(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  /** Whole days from day key a to day key b */
  daysBetween(a, b) {
    const [y1, m1, d1] = a.split('-').map(Number);
    const [y2, m2, d2] = b.split('-').map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / (24 * HOUR));
  }

  minutesOf(ms) {
    const p = this.parts(ms);
    return p.h * 60 + p.mi;
  }

  label(ms) {
    return new Intl.DateTimeFormat('en-NZ', { timeZone: this.tz, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
  }
}

/* ---------- opening hours: "Tue 12:00-22:00" per line ---------- */
export function parseHours(text) {
  const week = Object.fromEntries(DAY_KEYS.map((k) => [k, null]));
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z]{3})[a-z]*\s+(.+)$/);
    if (!match) continue;
    const day = match[1].toLowerCase();
    if (!(day in week) || /closed/i.test(match[2])) continue;
    const t = match[2].match(/(\d{1,2})(?::(\d{2}))?\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?/);
    if (!t) continue;
    const open = +t[1] * 60 + +(t[2] || 0);
    let close = +t[3] * 60 + +(t[4] || 0);
    if (close <= open) close += 24 * 60;
    week[day] = [open, close];
  }
  return week;
}

export function openWindow(rules, time, key) {
  const hours = rules.hours[DAY_KEYS[time.weekday(key)]];
  if (!hours) return null;
  return { openMin: hours[0], closeMin: hours[1], open: time.at(key, hours[0]), close: time.at(key, hours[1]) };
}

/** Calendar arithmetic on a "YYYY-MM-DD" day key (no time zones involved). */
export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * The opening window a moment falls in: that day's, or the day before's when its hours run past midnight.
 * Otherwise that day's window (so the caller can say "outside opening hours"), or null on a closed day.
 */
export function windowAt(rules, time, ms) {
  const key = time.key(ms);
  const today = openWindow(rules, time, key);
  if (today && ms >= today.open && ms < today.close) return today;
  const yesterday = openWindow(rules, time, addDays(key, -1));
  if (yesterday && ms >= yesterday.open && ms < yesterday.close) return yesterday;
  return today;
}

/* ---------- rooms and tables ---------- */
/** Build the table list exactly the way the theme does (code + number, or layout ids). */
export function buildRooms(rawRooms, defaultPrice) {
  return rawRooms
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((r, i) => {
      const code = String(r.code || r.name || 'T').trim().slice(0, 2).toUpperCase();
      let layout = r.layout;
      if (typeof layout === 'string') {
        try {
          layout = JSON.parse(layout);
        } catch {
          layout = null;
        }
      }
      const seats = Number(r.seats) || 4;
      // Same rule as the theme: a custom layout needs both a room box and table positions.
      const tables = layout && Array.isArray(layout.tables) && Array.isArray(layout.box)
        ? layout.tables.map((t, ti) => ({ id: t.id || `${code}${ti + 1}`, seats: t.seats || seats }))
        : Array.from({ length: Number(r.tables) || 0 }, (_, ti) => ({ id: `${code}${ti + 1}`, seats }));
      return {
        id: r.id || `room-${i + 1}`, name: r.name || `Room ${i + 1}`, code, seats,
        price: r.price ? Math.round(Number(r.price) * 100) : defaultPrice,
        bookable: r.bookable !== false, minPeople: Math.max(0, Math.floor(Number(r.minPeople ?? r.min_people) || 0)),
        tables: tables.map((t) => ({ ...t, room: r.id || `room-${i + 1}` })),
      };
    });
}

export function parseTableList(spec, rooms) {
  if (!spec) return [];
  const all = rooms.flatMap((r) => r.tables.map((t) => t.id));
  const text = String(spec).trim();
  if (/^all$/i.test(text)) return all;
  const ids = new Set();
  for (const part of text.split(/[,;]+/).map((p) => p.trim()).filter(Boolean)) {
    const room = rooms.find((r) => r.id.toLowerCase() === part.toLowerCase() || r.name.toLowerCase() === part.toLowerCase());
    if (room) {
      room.tables.forEach((t) => ids.add(t.id));
      continue;
    }
    for (const token of part.split(/\s+/)) {
      const range = token.match(/^([A-Za-z]+)(\d+)\s*-\s*(?:[A-Za-z]+)?(\d+)$/);
      if (range) {
        for (let i = +range[2]; i <= +range[3]; i += 1) ids.add(`${range[1].toUpperCase()}${i}`);
      } else {
        ids.add(token.toUpperCase());
      }
    }
  }
  return [...ids].filter((id) => all.includes(id));
}

export function tableIndex(rooms) {
  const map = new Map();
  for (const room of rooms) for (const t of room.tables) map.set(t.id, { ...t, roomObj: room });
  return map;
}

/* ---------- events: repeating events, one item per date ----------
   The same rules as the theme. An event's start/end are its first date. Later dates keep the same Lair wall-clock
   start and the same length. weekly = every 7 days, fortnightly = 14, monthly = the same nth weekday as the first
   date (n = ceil(day / 7)); a month without one is skipped. Dates run to repeatUntil (inclusive) and dates in
   skipDates are left out. Each date's id is `${handle}@${YYYY-MM-DD}` (its Lair start date), one-off events included. */
const REPEAT_DAYS = { weekly: 7, fortnightly: 14 };
const dayKey = (value) => (/^\d{4}-\d{2}-\d{2}/.test(String(value || '')) ? String(value).slice(0, 10) : null);
const times = new Map();
export const lairTime = (tz = 'Pacific/Auckland') => {
  if (!times.has(tz)) times.set(tz, new LairTime(tz));
  return times.get(tz);
};

function eventDates(e, time, fromKey, toKey) {
  const first = time.key(e.start);
  const repeat = String(e.repeat || '').trim().toLowerCase();
  const until = dayKey(e.repeatUntil);
  const last = until && until < toKey ? until : toKey;
  const keys = [];
  if (REPEAT_DAYS[repeat]) {
    const step = REPEAT_DAYS[repeat];
    // Jump close to the window instead of walking from the first date.
    const skipSteps = Math.max(0, Math.floor(time.daysBetween(first, fromKey) / step) - 1);
    for (let key = addDays(first, skipSteps * step); key <= last; key = addDays(key, step)) keys.push(key);
  } else if (repeat === 'monthly') {
    const [fy, fm, fd] = first.split('-').map(Number);
    const nth = Math.ceil(fd / 7);
    const weekday = time.weekday(first);
    let y = fy;
    let m = fm;
    for (let monthStart = `${y}-${String(m).padStart(2, '0')}-01`; monthStart <= last; monthStart = `${y}-${String(m).padStart(2, '0')}-01`) {
      const key = addDays(monthStart, ((weekday - time.weekday(monthStart) + 7) % 7) + (nth - 1) * 7);
      if (key.slice(0, 7) === monthStart.slice(0, 7) && key >= first && key <= last) keys.push(key);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
  } else {
    keys.push(first);
  }
  const skip = new Set((e.skipDates || []).map(dayKey).filter(Boolean));
  return keys.filter((key) => key >= fromKey && !skip.has(key));
}

/** Every date of the Lair's events that overlaps [from, to) */
export function eventOccurrences(rules, from, to) {
  const time = lairTime(rules.tz);
  const out = [];
  for (const e of rules.events || []) {
    if (!Number.isFinite(e.start)) continue;
    const length = Number.isFinite(e.end) && e.end > e.start ? e.end - e.start : 3 * HOUR;
    const clock = time.minutesOf(e.start);
    const fromKey = time.key(from - length - 24 * HOUR);
    const toKey = time.key(to);
    for (const key of eventDates(e, time, fromKey, toKey)) {
      const start = time.at(key, clock);
      if (!overlaps(start, start + length, from, to)) continue;
      out.push({
        id: `${e.id}@${key}`, eventId: e.id, title: e.title, start, end: start + length, tables: e.tables || '',
        capacity: Number(e.capacity) > 0 ? Math.floor(Number(e.capacity)) : null,
      });
    }
  }
  return out;
}

/** One date of an event, by its occurrence id (`handle@YYYY-MM-DD`), or null */
export function findOccurrence(rules, occurrenceId) {
  const match = String(occurrenceId || '').match(/^(.+)@(\d{4}-\d{2}-\d{2})$/);
  if (!match) return null;
  const event = (rules.events || []).find((e) => e.id === match[1]);
  if (!event) return null;
  const time = lairTime(rules.tz);
  const dayStart = time.at(match[2], 0);
  return eventOccurrences({ ...rules, events: [event] }, dayStart, dayStart + 24 * HOUR).find((o) => o.id === occurrenceId) || null;
}

/* ---------- availability ---------- */
/** Staff holds plus the event dates that hold tables, overlapping [from, to) */
export function blockingItems(state, rules, from = -Infinity, to = Infinity) {
  const lo = Number.isFinite(from) ? from : Date.now() - 31 * 24 * HOUR;
  const hi = Number.isFinite(to) ? to : Date.now() + 400 * 24 * HOUR;
  const fromEvents = eventOccurrences({ ...rules, events: (rules.events || []).filter((e) => e.tables) }, lo, hi)
    .map((o) => ({ id: `ev-${o.id}`, tables: parseTableList(o.tables, rules.rooms), start: o.start, end: o.end, label: o.title }));
  return [...state.blocks.filter((b) => overlaps(b.start, b.end, lo, hi)), ...fromEvents];
}

/** Shop tables (staff only) are open to everyone while an opening covers the whole time. */
export function shopTableOpen(state, tableId, start, end) {
  return (state.openings || []).some((o) => o.tables.includes(tableId) && o.start <= start && o.end >= end);
}

/** ignore: a booking id, or a Set of ids (a GM game's own bookings when moving the game) */
export function isFree(state, rules, tableId, start, end, ignore = null) {
  const skip = ignore instanceof Set ? ignore : new Set(ignore ? [ignore] : []);
  for (const b of blockingItems(state, rules, start, end)) {
    if (b.tables.includes(tableId) && overlaps(start, end, b.start, b.end)) return false;
  }
  for (const b of state.bookings) {
    if (skip.has(b.id) || !ACTIVE.has(b.status)) continue;
    if (b.tables.includes(tableId) && overlaps(start, end, b.start, b.end)) return false;
  }
  return true;
}

/** All tables in one room (prices and the floor map are per room). Returns that room. */
export function oneRoom(tables, rules) {
  const index = tableIndex(rules.rooms);
  const known = tables.map((id) => index.get(id));
  if (!tables.length) throw new RuleError('Pick at least one table.');
  if (known.some((t) => !t)) throw new RuleError('One of those tables does not exist.');
  const room = known[0].roomObj;
  if (known.some((t) => t.roomObj.id !== room.id)) throw new RuleError('Keep a booking in one room.');
  return { room, known };
}

/* ---------- validation ---------- */
export class RuleError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);

/**
 * Check a table booking against the house rules. Returns the normalised booking fields.
 * staff = true skips the lead-time rule and lets staff seat people without contact details.
 */
export function checkTableBooking(input, { state, rules, time, now, staff = false }) {
  const tables = Array.isArray(input.tables) ? [...new Set(input.tables.map(String))] : [];
  const { room, known } = oneRoom(tables, rules);
  if (!room.bookable && !staff) throw new RuleError(`${room.name} can't be booked online.`);

  const start = Number(input.start);
  const end = Number(input.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new RuleError('That time is not valid.');
  const minutes = (end - start) / MIN;
  if (!staff) {
    if (minutes % 60 !== 0) throw new RuleError('Bookings are in one-hour blocks.');
    if (minutes / 60 > rules.maxHours) throw new RuleError(`Bookings can be up to ${rules.maxHours} hours.`);
    if (start < now + rules.leadMinutes * MIN) throw new RuleError('That time is too soon to book online. Walk in instead.');
    if (start > now + rules.horizonDays * 24 * HOUR) throw new RuleError('That date is too far ahead to book yet.');
    const win = windowAt(rules, time, start);
    if (!win) throw new RuleError("We're closed then.");
    if (start < win.open || end > win.close) throw new RuleError('That time is outside opening hours.');
    if (((start - win.open) / MIN) % 60 !== 0) throw new RuleError('Bookings start on the hour.');
  }

  const people = Math.floor(Number(input.people));
  if (!(people >= 1 && people <= 60)) throw new RuleError('Tell us how many people are coming.');
  const seats = known.reduce((sum, t) => sum + (t.seats || room.seats), 0);
  const extras = Array.isArray(input.extras) ? [...new Set(input.extras.map((x) => clean(x, 30)))].filter((x) => BOOKING_EXTRAS.includes(x)) : [];
  if (!staff) {
    if (people > ONLINE_LIMITS.people) throw new RuleError(`For groups over ${ONLINE_LIMITS.people}, give us a call and we'll set it up.`);
    if (room.minPeople && people < room.minPeople) throw new RuleError(`${room.name} is for groups of ${room.minPeople} or more.`);
    if (people > seats) throw new RuleError(`${people} people need more tables (these seat ${seats}).`);
    const perTable = Math.min(...known.map((t) => t.seats || room.seats));
    const allowed = input.game ? maxGameTables(people, perTable) : maxOnlineTables(people, perTable, extras);
    if (tables.length > allowed) {
      throw new RuleError(
        input.game
          ? `That's more tables than your game needs. Pick up to ${allowed}.`
          : `That's more tables than your group needs. We seat ${perTable} at a table, so pick fewer tables, or tick Wargame or Big box game for a double setup.`,
      );
    }
    for (const id of tables) {
      if ((rules.shopTables || []).includes(id) && !shopTableOpen(state, id, start, end)) {
        throw new RuleError(`${id} is a shop table, kept for the team's own games. Pick another table.`);
      }
    }
  }

  for (const id of tables) {
    if (!isFree(state, rules, id, start, end, input.ignoreBookingId)) throw new RuleError(`Table ${id} is already taken then. Pick another.`, 409);
  }

  const name = clean(input.name, 80);
  const email = clean(input.email, 120);
  if (!staff) {
    if (!name) throw new RuleError('Add a name for the booking.');
    if (!isEmail(email)) throw new RuleError('Add an email so we can send your confirmation.');
  }
  return {
    tables, room: room.id, start, end, people, name: name || 'Walk-in', email, phone: clean(input.phone, 40),
    notes: clean(input.notes, 500), activity: clean(input.activity, 30) || 'board', extras,
    amount: room.price * people,
  };
}

export function checkSeatBooking(input, { state, rules, now }) {
  const game = state.games.find((g) => g.id === input.gameId);
  if (!game || !['open', 'full'].includes(game.status)) throw new RuleError('That game is not open for players.', 404);
  if (game.end <= now) throw new RuleError('That game has finished.');
  const people = Math.floor(Number(input.people));
  if (!(people >= 1 && people <= 8)) throw new RuleError('Book between 1 and 8 seats.');
  const left = game.seats - seatsTaken(state, game.id);
  if (people > left) throw new RuleError(left > 0 ? `Only ${left} ${left === 1 ? 'seat' : 'seats'} left.` : 'This table is full.', 409);
  const name = clean(input.name, 80);
  const email = clean(input.email, 120);
  if (!name) throw new RuleError('Add your name.');
  if (!isEmail(email)) throw new RuleError('Add an email so we can send your confirmation.');
  const players = seatPlayers(input.players, people, name);
  const unit = game.seatPrice || rules.prices.gmSeat;
  return { game, people, name, email, players, tables: game.tables, start: game.start, end: game.end, amount: unit * people };
}

/**
 * One name per seat (the GM sees who's coming), each with an optional character name. The booking page always
 * sends them; an older page that doesn't gets the booker's name on every seat.
 */
export function seatPlayers(given, people, name) {
  const list = Array.isArray(given) ? given : null;
  const players = Array.from({ length: people }, (_, i) => ({
    name: list ? clean(list[i]?.name, 60) || (i === 0 ? name : '') : i === 0 ? name : `${name} +${i}`,
    character: list ? clean(list[i]?.character, 60) : '',
  }));
  if (players.some((p) => !p.name)) throw new RuleError('Add a name for every seat.');
  return players;
}

export function seatsTaken(state, gameId) {
  return state.bookings
    .filter((b) => b.gameId === gameId && b.kind === 'gm-seat' && ACTIVE.has(b.status))
    .reduce((sum, b) => sum + b.people, 0);
}

export const GM_FEES = [0, 500, 1000];
export const SCHEDULES = ['one-shot', 'weekly', 'fortnightly', 'flexible'];
const CHARACTERS = ['pregens', 'bring', 'at-table'];

/** The details of a GM game every session shares (checked once, when the game is listed) */
export function checkGameDetails(input) {
  const title = clean(input.title, 80);
  const gm = clean(input.gm, 60);
  const blurb = clean(input.blurb, 1200);
  if (!title || !gm || !blurb) throw new RuleError('Add a title, your GM name and a short pitch.');
  const seats = Math.floor(Number(input.seats));
  if (!(seats >= 2 && seats <= 8)) throw new RuleError('Games can have 2 to 8 player seats.');
  const gmFee = Number(input.gmFee ?? 500);
  if (!GM_FEES.includes(gmFee)) throw new RuleError('Pick a GM fee of $0, $5 or $10.');
  const schedule = SCHEDULES.includes(input.schedule) ? input.schedule : 'one-shot';
  const characters = CHARACTERS.includes(input.characters) ? input.characters : (input.pregens ? 'pregens' : '');
  return {
    title, gm, blurb, seats, gmFee, schedule, characters,
    system: clean(input.system, 40) || 'Other', level: clean(input.level, 20) || 'new',
    age: clean(input.age, 20) || 'All ages', tags: (Array.isArray(input.tags) ? input.tags : []).map((x) => clean(x, 30)).slice(0, 8),
    safety: (Array.isArray(input.safety) ? input.safety : []).map((x) => clean(x, 30)).slice(0, 6), pregens: characters === 'pregens',
    bring: clean(input.bring, 300), contentNotes: clean(input.contentNotes, 500), sessionZero: clean(input.sessionZero, 300),
    gmBio: clean(input.gmBio, 600),
  };
}

/**
 * One session's tables and time, checked like a table booking for its players: they must fit at the tables (the GM
 * isn't counted). ignore: the game's own bookings, when a session moves.
 */
export function checkGameSession(input, details, { state, rules, time, now, staff = false, ignore = null }) {
  const booking = checkTableBooking(
    { tables: input.tables, start: input.start, end: input.end, people: details.seats, name: `GM ${details.gm}`, email: 'gm@lair.local', game: true, ignoreBookingId: ignore },
    { state, rules, time, now, staff },
  );
  const room = tableIndex(rules.rooms).get(booking.tables[0]).roomObj;
  return { tables: booking.tables, start: booking.start, end: booking.end, room: room.id, seatPrice: room.price + details.gmFee };
}

export function checkGame(input, ctx) {
  const details = checkGameDetails(input);
  return { ...details, ...checkGameSession(input, details, ctx) };
}

/* ---------- members ---------- */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** A birthday as 'MM-DD' (a full date's year is dropped), null when it's left empty. Anything else is refused. */
export function parseBirthday(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const m = text.match(/^(?:\d{4}-)?(\d{2})-(\d{2})$/);
  if (!m || +m[1] < 1 || +m[1] > 12 || +m[2] < 1 || +m[2] > MONTH_DAYS[+m[1] - 1]) throw new RuleError('Pick a real birthday, or leave it empty.');
  return `${m[1]}-${m[2]}`;
}

/** Spend earns a bonus dice roll every $20. */
export const ROLL_EVERY = 2000;
/** Prize codes from the dice last 30 days. */
export const PRIZE_CODE_DAYS = 30;

/**
 * What a member's prize roll wins. daily: a natural 1 is $1 store credit and a natural 20 a personal 10% off code.
 * bonus: any face with a 1 in it (1, 10-19) is $1 store credit, 11 is $2, and a 20 is the 10% code.
 */
export function rollPrize(kind, roll) {
  if (roll === 20) return { kind: 'percent', percent: 10 };
  if (kind === 'daily') return roll === 1 ? { kind: 'credit', amount: 100 } : null;
  if (kind === 'bonus') {
    if (roll === 11) return { kind: 'credit', amount: 200 };
    if (String(roll).includes('1')) return { kind: 'credit', amount: 100 };
  }
  return null;
}

/* ---------- what the public may see ---------- */
export function publicBooking(b) {
  return { id: b.id, kind: b.kind, tables: b.tables, start: b.start, end: b.end, status: b.status, gameId: b.gameId || null, people: b.kind === 'walkin' || b.kind === 'table' ? undefined : b.people };
}

export function publicGame(g, state, rules = null) {
  const taken = seatsTaken(state, g.id);
  const gmFee = g.gmFee ?? rules?.prices.gmCredit ?? 500;
  return {
    id: g.id, title: g.title, system: g.system, gm: g.gm, level: g.level, age: g.age, tags: g.tags, safety: g.safety,
    pregens: g.pregens, blurb: g.blurb, tables: g.tables, start: g.start, end: g.end, seats: g.seats, taken,
    status: g.status === 'open' && taken >= g.seats ? 'full' : g.status, campaign: g.campaign || null, credited: g.credited ?? null,
    schedule: g.schedule || 'one-shot', seriesId: g.seriesId || null, gmFee, seatPrice: g.seatPrice || rules?.prices.gmSeat || 1500,
    room: g.room || null, characters: g.characters || (g.pregens ? 'pregens' : ''), bring: g.bring || '', contentNotes: g.contentNotes || '',
    sessionZero: g.sessionZero || '', gmBio: g.gmBio || '', image: g.image || null,
    // No GM fee needs a manager's OK any more ($0, $5 and $10 are all fine).
    gmFeeApproved: true,
  };
}

/* ---------- settings from the theme's settings_data.json ---------- */
/** The Lair's opening hours (also the theme's default): weekdays 4pm to midnight, Saturday 10am to midnight, Sunday 10am to 10pm. */
export const DEFAULT_HOURS = 'Mon 16:00-24:00\nTue 16:00-24:00\nWed 16:00-24:00\nThu 16:00-24:00\nFri 16:00-24:00\nSat 10:00-24:00\nSun 10:00-22:00';

/**
 * Cancellation policy: a booking paid online gets a refund when it is cancelled at least `refundHours`
 * before it starts. Later cancellations and no-shows keep the fee. Paying at the counter has nothing to refund.
 */
export function refundFor(booking, rules, cancelledAt) {
  if (!booking.paid || booking.pay !== 'now' || !booking.amount) return { due: false, amount: 0, reason: 'nothing paid online' };
  const cutoff = booking.start - rules.refundHours * HOUR;
  if (cancelledAt <= cutoff) return { due: true, amount: booking.amount, orderId: booking.orderId || null, reason: `cancelled more than ${rules.refundHours} hours ahead` };
  return { due: false, amount: 0, orderId: booking.orderId || null, reason: `cancelled less than ${rules.refundHours} hours before the start` };
}

export function rulesFromSettings(settings = {}, rooms = [], events = [], shop = {}) {
  const prices = {
    table: Math.round(Number(settings.price_table ?? 10) * 100),
    gmSeat: Math.round(Number(settings.price_gm_seat ?? 15) * 100),
    gmCredit: Math.round(Number(settings.gm_credit ?? 5) * 100),
  };
  const builtRooms = buildRooms(rooms, prices.table);
  // Page settings hold a page handle; the theme's defaults are used until they're set.
  const page = (value, fallback) => `/pages/${String(value || '').trim().replace(/^\/?(pages\/)?/, '') || fallback}`;
  return {
    // For email footers and buttons: the theme's phone setting and the store address from Shopify.
    contact: { phone: String(settings.store_phone || '').trim(), address: String(shop.address || '').trim() },
    pages: {
      book: page(settings.page_book, 'book-a-table'), gm: page(settings.page_gm, 'gm-games'), events: page(settings.page_events, 'events-calendar'),
      staff: page(settings.page_staff, 'lair-staff'), myLair: '/pages/my-lair',
    },
    tz: settings.lair_timezone || 'Pacific/Auckland',
    hours: parseHours(settings.lair_hours || DEFAULT_HOURS),
    // The shop's own tables (managers run games there): closed to the public unless a manager opens them.
    shopTables: parseTableList(settings.lair_shop_tables ?? 'T1-T3', builtRooms),
    leadMinutes: Number(settings.lair_lead_minutes ?? 60),
    horizonDays: Number(settings.lair_horizon_days ?? 60),
    maxHours: Number(settings.lair_max_hours ?? 8),
    payOnline: settings.lair_pay_online !== false,
    refundHours: Number(settings.lair_refund_hours ?? 24),
    prices,
    rooms: builtRooms,
    events,
  };
}

/** settings_data.json may start with a comment block and keep values under "current" (object or preset name) */
export function readSettingsData(text) {
  const json = JSON.parse(String(text).replace(/^\s*\/\*[\s\S]*?\*\//, ''));
  const current = typeof json.current === 'string' ? json.presets?.[json.current] || {} : json.current || {};
  return current;
}

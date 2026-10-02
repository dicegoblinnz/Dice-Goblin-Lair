// Dice Goblin Lair — shared booking rules (no Cloudflare or Shopify APIs here, so it is unit-testable).

export const MIN = 60_000;
export const HOUR = 60 * MIN;
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const REF_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ACTIVE = new Set(['held', 'confirmed', 'seated']);

/** Booking references like GOB-7K2QXM: 6 characters, no look-alikes (0/O, 1/I/L). Callers check they're unused. */
export const makeRef = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `GOB-${Array.from(bytes, (b) => REF_CHARS[b % REF_CHARS.length]).join('')}`;
};
/** Online bookings (not staff) can't be bigger than this; bigger groups call the shop. */
export const ONLINE_LIMITS = { people: 24, tables: 10 };
/** Most tables an online booking may take: enough for the group plus one, at least 3 (a big-box or wargame setup). */
export const maxOnlineTables = (people) => Math.min(ONLINE_LIMITS.tables, Math.max(3, people + 1));
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

/* ---------- availability ---------- */
export function blockingItems(state, rules) {
  const fromEvents = (rules.events || [])
    .filter((e) => e.tables)
    .map((e) => ({ id: `ev-${e.id}`, tables: parseTableList(e.tables, rules.rooms), start: e.start, end: e.end, label: e.title }));
  return [...state.blocks, ...fromEvents];
}

/** ignore: a booking id, or a Set of ids (a GM game's own bookings when moving the game) */
export function isFree(state, rules, tableId, start, end, ignore = null) {
  const skip = ignore instanceof Set ? ignore : new Set(ignore ? [ignore] : []);
  for (const b of blockingItems(state, rules)) {
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
  if (!staff) {
    if (people > ONLINE_LIMITS.people) throw new RuleError(`For groups over ${ONLINE_LIMITS.people}, give us a call and we'll set it up.`);
    if (room.minPeople && people < room.minPeople) throw new RuleError(`${room.name} is for groups of ${room.minPeople} or more.`);
    if (people > seats) throw new RuleError(`${people} people need more tables (these seat ${seats}).`);
    if (tables.length > maxOnlineTables(people)) throw new RuleError('That is more tables than your group needs. Call us for bigger setups.');
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
    notes: clean(input.notes, 500), activity: clean(input.activity, 30) || 'board',
    extras: Array.isArray(input.extras) ? input.extras.map((x) => clean(x, 30)).slice(0, 10) : [],
    amount: room.price * people,
  };
}

export function checkSeatBooking(input, { state, rules, now }) {
  const game = state.games.find((g) => g.id === input.gameId);
  if (!game || !['open', 'full'].includes(game.status)) throw new RuleError('That game is not open for players.', 404);
  if (game.end <= now) throw new RuleError('That game has finished.');
  const people = Math.floor(Number(input.people));
  if (!(people >= 1 && people <= 4)) throw new RuleError('Book between 1 and 4 seats.');
  const left = game.seats - seatsTaken(state, game.id);
  if (people > left) throw new RuleError(left > 0 ? `Only ${left} seats left.` : 'This table is full.', 409);
  const name = clean(input.name, 80);
  const email = clean(input.email, 120);
  if (!name) throw new RuleError('Add your name.');
  if (!isEmail(email)) throw new RuleError('Add an email so we can send your confirmation.');
  return { game, people, name, email, tables: game.tables, start: game.start, end: game.end, amount: rules.prices.gmSeat * people };
}

export function seatsTaken(state, gameId) {
  return state.bookings
    .filter((b) => b.gameId === gameId && b.kind === 'gm-seat' && ACTIVE.has(b.status))
    .reduce((sum, b) => sum + b.people, 0);
}

export function checkGame(input, { state, rules, time, now, staff = false }) {
  const title = clean(input.title, 80);
  const gm = clean(input.gm, 60);
  const blurb = clean(input.blurb, 600);
  if (!title || !gm || !blurb) throw new RuleError('Add a title, your GM name and a short pitch.');
  const seats = Math.floor(Number(input.seats));
  if (!(seats >= 2 && seats <= 8)) throw new RuleError('Games can have 2 to 8 player seats.');
  const booking = checkTableBooking(
    { tables: input.tables, start: input.start, end: input.end, people: seats + 1, name: `GM ${gm}`, email: input.email || 'gm@lair.local' },
    { state, rules, time, now, staff },
  );
  return {
    title, gm, blurb, seats, system: clean(input.system, 40) || 'Other', level: clean(input.level, 20) || 'new',
    age: clean(input.age, 20) || 'All ages', tags: (input.tags || []).map((x) => clean(x, 30)).slice(0, 6),
    safety: (input.safety || []).map((x) => clean(x, 30)).slice(0, 4), pregens: Boolean(input.pregens),
    tables: booking.tables, start: booking.start, end: booking.end,
  };
}

/* ---------- what the public may see ---------- */
export function publicBooking(b) {
  return { id: b.id, kind: b.kind, tables: b.tables, start: b.start, end: b.end, status: b.status, gameId: b.gameId || null, people: b.kind === 'walkin' || b.kind === 'table' ? undefined : b.people };
}

export function publicGame(g, state) {
  const taken = seatsTaken(state, g.id);
  return {
    id: g.id, title: g.title, system: g.system, gm: g.gm, level: g.level, age: g.age, tags: g.tags, safety: g.safety,
    pregens: g.pregens, blurb: g.blurb, tables: g.tables, start: g.start, end: g.end, seats: g.seats, taken,
    status: g.status === 'open' && taken >= g.seats ? 'full' : g.status, campaign: g.campaign || null, credited: g.credited ?? null,
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

export function rulesFromSettings(settings = {}, rooms = [], events = []) {
  const prices = {
    table: Math.round(Number(settings.price_table ?? 10) * 100),
    gmSeat: Math.round(Number(settings.price_gm_seat ?? 15) * 100),
    gmCredit: Math.round(Number(settings.gm_credit ?? 5) * 100),
  };
  return {
    tz: settings.lair_timezone || 'Pacific/Auckland',
    hours: parseHours(settings.lair_hours || DEFAULT_HOURS),
    leadMinutes: Number(settings.lair_lead_minutes ?? 60),
    horizonDays: Number(settings.lair_horizon_days ?? 60),
    maxHours: Number(settings.lair_max_hours ?? 8),
    payOnline: settings.lair_pay_online !== false,
    refundHours: Number(settings.lair_refund_hours ?? 24),
    prices,
    rooms: buildRooms(rooms, prices.table),
    events,
  };
}

/** settings_data.json may start with a comment block and keep values under "current" (object or preset name) */
export function readSettingsData(text) {
  const json = JSON.parse(String(text).replace(/^\s*\/\*[\s\S]*?\*\//, ''));
  const current = typeof json.current === 'string' ? json.presets?.[json.current] || {} : json.current || {};
  return current;
}

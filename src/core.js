// Dice Goblin Lair — shared booking rules (no Cloudflare or Shopify APIs here, so it is unit-testable).

export const MIN = 60_000;
export const HOUR = 60 * MIN;
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const REF_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ACTIVE = new Set(['held', 'confirmed', 'seated']);

/**
 * 6 random characters with no look-alikes (0/O, 1/I/L), like 7K2QXM. Birthday discount codes use them (BDAY-7K2QXM),
 * and the first release's booking refs looked like GOB-7K2QXM; those still check in.
 */
export const makeRef = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `GOB-${Array.from(bytes, (b) => REF_CHARS[b % REF_CHARS.length]).join('')}`;
};

/* ---------- codes: SJ-OWLBEAR-17 ----------
   One format for tickets, game seats, event sign-ups, member codes and session passes: the person's initials, a
   random word and a d20 roll. The same text is the QR code, the words printed under it and what staff type in.
   Matching ignores case, spaces, dashes, dots and underscores: the lookup key is the code reduced to [A-Z0-9]. The
   theme's lair-core.js has the same word list and rules. */
export const CODE_WORDS = [
  'GOBLIN','KOBOLD','OWLBEAR','MIMIC','GOLEM','WYVERN','DRAGON','DRAKE','HYDRA','KRAKEN','GRIFFIN','PHOENIX',
  'UNICORN','PEGASUS','BASILISK','CHIMERA','SPHINX','TROLL','OGRE','GNOME','PIXIE','SPRITE','FAERIE','BROWNIE',
  'IMP','GREMLIN','BUGBEAR','HOBGOBLIN','YETI','GHOST','BANSHEE','WISP','DJINN','GENIE','SELKIE','KELPIE',
  'SATYR','CENTAUR','MINOTAUR','CYCLOPS','HARPY','GORGON','KITSUNE','TANUKI','KAPPA','TENGU','DRYAD','TREANT',
  'WEREWOLF','MUMMY','ZOMBIE','SKELETON','SLIME','OOZE','BLOB',
  'BADGER','OTTER','FERRET','HEDGEHOG','RACCOON','WOMBAT','PLATYPUS','AXOLOTL','NEWT','TOAD','FROG','GECKO',
  'BEETLE','MOTH','SNAIL','CRAB','SQUID','OCTOPUS','NARWHAL','WALRUS','PENGUIN','PUFFIN','RAVEN','MAGPIE',
  'OWL','BAT','FOX','WOLF','BEAR','BOAR','STAG','HARE','LLAMA','ALPACA','CAPYBARA','PANDA','YAK','GOAT',
  'MOOSE','LOBSTER','TORTOISE','TURTLE','LEMUR','SLOTH','KOALA','QUOKKA','MEERKAT','KITTEN','PUPPY',
  'KIWI','KEA','KAKA','TUI','WETA','MOA','TUATARA','KAKAPO','PUKEKO','TAKAHE','KOKAKO','FANTAIL','MOREPORK',
  'RURU','KERERU','WEKA','PAUA','KUMARA','PAVLOVA','JANDAL','LAMINGTON','FEIJOA','PIKELET',
  'MEEPLE','DICE','POTION','SCROLL','WAND','STAFF','SWORD','SHIELD','LANTERN','TORCH','MAP','COMPASS','CROWN',
  'GOBLET','CHEST','RUNE','TOME','AMULET','RING','CLOAK','BOOTS','HELM','AXE','BOW','ARROW','DAGGER','HAMMER',
  'LUTE','HARP','DRUM','QUILL','INKPOT','CANDLE','KEY','ROPE','BACKPACK','CAULDRON','BROOM','MIRROR','ORB',
  'GEM','RUBY','OPAL','AMBER','JADE','PEARL','TOPAZ','GARNET','COIN','DOUBLOON','TREASURE','BANNER','TOKEN',
  'PAWN','ROOK','KNIGHT','BISHOP','QUEEN','KING',
  'PIE','PRETZEL','MUFFIN','SCONE','CRUMPET','PANCAKE','WAFFLE','DUMPLING','NOODLE','PICKLE','TURNIP','RADISH',
  'CARROT','MUSHROOM','TRUFFLE','CHEESE','BISCUIT','COOKIE','TOFFEE','FUDGE','NOUGAT','TOASTIE','NACHO','TACO',
  'BAGEL','DONUT','CUPCAKE','PUDDING','JELLY','CUSTARD',
  'QUEST','SAGA','LEGEND','RIDDLE','SPELL','HEX','CHARM','JINX','OMEN','LOOT','CRIT','BOSS','DUNGEON','TAVERN',
  'CASTLE','TOWER','CAVE','LAIR','PORTAL','MAZE','VAULT','CRYPT','SWAMP','FOREST','MEADOW','GROTTO','ISLAND',
  'VOLCANO','GLACIER',
  'EMBER','SPARK','FROST','THUNDER','STORM','GUST','MIST','SHADOW','STAR','MOON','COMET','NOVA','AURORA',
  'ECLIPSE','RAINBOW','BLIZZARD',
];

/**
 * A code's initials: the first letters of the first and last words, accents stripped ("Zoë van der Berg" → ZB),
 * the first two letters of a single word ("Sam" → SA), or DG when there's nothing to go on.
 */
export function initialsOf(name) {
  const words = String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .split(/\s+/).map((w) => w.replace(/[^A-Z]/g, '')).filter(Boolean);
  if (!words.length) return 'DG';
  if (words.length === 1) return words[0].length >= 2 ? words[0].slice(0, 2) : 'DG';
  return `${words[0][0]}${words[words.length - 1][0]}`;
}

/** n random 32-bit numbers. Two per code, so a test's loaded d20 (one number at a time) is never used up by a code. */
const randomNumbers = (n) => crypto.getRandomValues(new Uint32Array(n));

/** A fresh code like SJ-OWLBEAR-17. big: a number from 21 to 99, for when the d20 numbers are taken. */
export function makeCode(name, { big = false, random = randomNumbers } = {}) {
  const [w, r] = random(2);
  return `${initialsOf(name)}-${CODE_WORDS[w % CODE_WORDS.length]}-${big ? 21 + (r % 79) : 1 + (r % 20)}`;
}

/** What a code is matched on: letters and digits only, in capitals ("sj owlbear 17" → SJOWLBEAR17) */
export const codeKey = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Round 8: the forms a product barcode can be read in. A 12-digit UPC-A (195166315386) is the same code as the 13-digit
 * EAN-13 with a 0 in front (0195166315386) and the 14-digit GTIN with two, and phone cameras report either, while
 * Shopify keeps whichever was typed in. For 8 to 14 digits: the code as given, then without its leading zeros, then
 * padded to 12, 13 and 14 digits (at least 8). Anything else: just the code.
 */
export function barcodeForms(code) {
  const text = String(code ?? '').trim();
  if (!/^\d{8,14}$/.test(text)) return text ? [text] : [];
  const bare = text.replace(/^0+/, '');
  const forms = [text, bare, bare.padStart(12, '0'), bare.padStart(13, '0'), bare.padStart(14, '0')];
  return [...new Set(forms.filter((f) => f.length >= 8 && f.length <= 14))];
}

/** Round 8: the same barcode or SKU? All digits on both sides: equal once leading zeros go. Otherwise ignoring case. */
export function sameBarcode(a, b) {
  const x = String(a ?? '').trim();
  const y = String(b ?? '').trim();
  if (!x || !y) return false;
  if (/^\d+$/.test(x) && /^\d+$/.test(y)) return x.replace(/^0+/, '') === y.replace(/^0+/, '');
  return x.toUpperCase() === y.toUpperCase();
}

/** A code nobody has had (taken(key) says): 40 tries with a d20, then numbers from 21 to 99. */
export function uniqueCode(name, taken, { random = randomNumbers } = {}) {
  for (let i = 0; i < 40; i += 1) {
    const code = makeCode(name, { random });
    if (!taken(codeKey(code))) return code;
  }
  for (let i = 0; i < 2000; i += 1) {
    const code = makeCode(name, { big: true, random });
    if (!taken(codeKey(code))) return code;
  }
  throw new Error('Could not find a free code');
}

/**
 * The keys a scan or typed code could be, most likely first: the whole text, then any SJ-OWLBEAR-17 inside it (a
 * scanner can send other characters around the code).
 */
export function codeKeys(text) {
  const upper = String(text ?? '').toUpperCase();
  const keys = [];
  const add = (key) => {
    if (key && !keys.includes(key)) keys.push(key);
  };
  add(codeKey(upper));
  for (const m of upper.matchAll(/(?:^|[^A-Z0-9])([A-Z]{2})[\s._-]+([A-Z]{3,9})[\s._-]+(\d{1,2})(?![0-9])/g)) add(`${m[1]}${m[2]}${m[3]}`);
  return keys;
}

/** The first release's refs a scan could hold (GOB-7K2QXM, with or without its dash), matched on the booking itself. */
export function legacyRefs(text) {
  const upper = String(text ?? '').toUpperCase();
  const bare = upper.replace(/[^A-Z0-9]/g, '');
  const refs = [];
  const add = (ref) => {
    if (!refs.includes(ref)) refs.push(ref);
  };
  for (const m of upper.matchAll(/GOB-([A-Z0-9]{6})(?![A-Z0-9])/g)) add(`GOB-${m[1]}`);
  const joined = bare.match(/^GOB([A-Z0-9]{6})$/) || bare.match(/^([A-Z0-9]{6})$/);
  if (joined) add(`GOB-${joined[1]}`);
  return refs;
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

/**
 * An event's game spots: "T14+T15, T16+T17" is two spots of two tables each. Unknown tables are dropped, and a spot
 * has to stay in one room.
 */
export function parseSpots(spec, rooms) {
  const index = tableIndex(rooms);
  return String(spec || '')
    .split(/[,;\n]+/)
    .map((part) => [...new Set(part.split('+').map((t) => t.trim().toUpperCase()).filter((t) => index.has(t)))])
    .filter((spot) => spot.length && spot.every((t) => index.get(t).roomObj.id === index.get(spot[0]).roomObj.id));
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

/**
 * How an event's entry fee (and its game spots) are paid, from the lair_event "payment" field: "Online or in store" is
 * 'either', "Online" is 'online', and anything else (empty, "In store") is 'store', paid at the counter.
 */
export function eventPayment(value) {
  const text = String(value ?? '').trim();
  if (['store', 'online', 'either'].includes(text)) return text;
  if (/^online or/i.test(text)) return 'either';
  if (/^online$/i.test(text)) return 'online';
  return 'store';
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
        entryFee: Number(e.entryFee) > 0 ? Math.round(Number(e.entryFee)) : 0, gameTables: e.gameTables || '',
        payment: eventPayment(e.payment), lockTables: e.lockTables === true,
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
/**
 * Event dates' table holds overlapping [from, to), the way the floor sends eventHolds (and the theme works them
 * out). An event's "Tables reserved" (tables) are soft: marked for the event on the booking page but bookable by
 * anyone, unless the event locks them (lockTables), which makes them hard holds. Its game-spot tables
 * (game_tables) are soft-reserved for it too. Each item: { id, eventId, occurrenceId, tables, start, end, label,
 * title, type: 'event', soft, spots? }, with id ev-<occurrence id> for the event's tables and ev-<occurrence id>-spots
 * for its game-spot tables.
 */
export function eventHolds(rules, from, to) {
  const out = [];
  const events = (rules.events || []).filter((e) => e.tables || e.gameTables);
  for (const o of eventOccurrences({ ...rules, events }, from, to)) {
    const tables = parseTableList(o.tables, rules.rooms);
    const base = { eventId: o.eventId, occurrenceId: o.id, start: o.start, end: o.end, label: o.title, title: o.title, type: 'event' };
    if (tables.length) out.push({ ...base, id: `ev-${o.id}`, tables, soft: !o.lockTables });
    const spots = [...new Set(parseSpots(o.gameTables, rules.rooms).flat())].filter((t) => !(o.lockTables && tables.includes(t)));
    if (spots.length) out.push({ ...base, id: `ev-${o.id}-spots`, tables: spots, soft: true, spots: true });
  }
  return out;
}

/**
 * What makes a table unavailable over [from, to): staff holds, and the tables of events that lock them. Soft holds
 * never block. staff: true (the staff page's walk-ins, overrides and moves, and games staff list) skips locked event
 * tables too: those are blocked for everyone except staff.
 */
export function blockingItems(state, rules, from = -Infinity, to = Infinity, { staff = false } = {}) {
  const lo = Number.isFinite(from) ? from : Date.now() - 31 * 24 * HOUR;
  const hi = Number.isFinite(to) ? to : Date.now() + 400 * 24 * HOUR;
  const locked = staff ? [] : eventHolds(rules, lo, hi).filter((h) => !h.soft);
  return [...state.blocks.filter((b) => overlaps(b.start, b.end, lo, hi)), ...locked];
}

/** Shop tables (staff only) are open to everyone while an opening covers the whole time. */
export function shopTableOpen(state, tableId, start, end) {
  return (state.openings || []).some((o) => o.tables.includes(tableId) && o.start <= start && o.end >= end);
}

/**
 * ignore: a booking id, or a Set of ids (a GM game's own bookings when moving the game, or an event's own hold,
 * ev-<occurrence id>). staff: skip locked event tables (see blockingItems).
 */
export function isFree(state, rules, tableId, start, end, ignore = null, { staff = false } = {}) {
  const skip = ignore instanceof Set ? ignore : new Set(ignore ? [ignore] : []);
  for (const b of blockingItems(state, rules, start, end, { staff })) {
    if (skip.has(b.id)) continue;
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
 * Round 7, for TTRPG sessions staff make under the GMs' rules: shopTables = true lets them use the shop tables (the
 * team's own, like an opening), and editing = true skips only the lead time and the booking horizon (moving a session
 * that's already listed, tonight's included). Everything else is the house rule.
 */
export function checkTableBooking(input, { state, rules, time, now, staff = false, shopTables = false, editing = false }) {
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
    if (!editing && start < now + rules.leadMinutes * MIN) throw new RuleError('That time is too soon to book online. Walk in instead.');
    if (!editing && start > now + rules.horizonDays * 24 * HOUR) throw new RuleError('That date is too far ahead to book yet.');
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
      if (!shopTables && (rules.shopTables || []).includes(id) && !shopTableOpen(state, id, start, end)) {
        throw new RuleError(`${id} is a shop table, kept for the team's own games. Pick another table.`);
      }
    }
  }

  for (const id of tables) {
    if (!isFree(state, rules, id, start, end, input.ignoreBookingId, { staff })) throw new RuleError(`Table ${id} is already taken then. Pick another.`, 409);
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

/**
 * A seat at a GM game, checked. held: seats kept for the game's weekly regulars who don't have their seat yet (they
 * aren't anyone else's to take).
 */
export function checkSeatBooking(input, { state, rules, now, held = 0 }) {
  const game = state.games.find((g) => g.id === input.gameId);
  if (!game || !['open', 'full'].includes(game.status)) throw new RuleError('That game is not open for players.', 404);
  if (game.end <= now) throw new RuleError('That game has finished.');
  const people = Math.floor(Number(input.people));
  if (!(people >= 1 && people <= 8)) throw new RuleError('Book between 1 and 8 seats.');
  const left = game.seats - seatsTaken(state, game.id) - Math.max(0, held);
  if (people > left) throw new RuleError(left > 0 ? `Only ${left} ${left === 1 ? 'seat' : 'seats'} left.` : 'This table is full.', 409);
  const name = clean(input.name, 80);
  const email = clean(input.email, 120);
  if (!name) throw new RuleError('Add your name.');
  if (!isEmail(email)) throw new RuleError('Add an email so we can send your confirmation.');
  // Round 7: a mobile number is required on every customer booking. The Lair app checks it (checkMobile) and the GM
  // gets it with the player's details.
  const phone = String(input.phone ?? '').trim();
  const players = seatPlayers(input.players, people, name);
  const unit = game.seatPrice || rules.prices.gmSeat;
  return {
    game, people, name, email, players, tables: game.tables, start: game.start, end: game.end, amount: unit * people, phone, notes: clean(input.notes, 500),
  };
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
/** How a series of sessions repeats (a one-shot isn't a series) */
export const SERIES_SCHEDULES = ['weekly', 'fortnightly', 'flexible'];
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
 * isn't counted). ignore: the game's own bookings, when a session moves. Round 7: staff-made sessions follow the GM
 * rules too, with shopTables (the shop tables are open to staff) and editing (a move skips only the lead time and the
 * horizon); see checkTableBooking.
 */
export function checkGameSession(input, details, { state, rules, time, now, staff = false, ignore = null, shopTables = false, editing = false }) {
  const booking = checkTableBooking(
    { tables: input.tables, start: input.start, end: input.end, people: details.seats, name: `GM ${details.gm}`, email: 'gm@lair.local', game: true, ignoreBookingId: ignore },
    { state, rules, time, now, staff, shopTables, editing },
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

/** Birthday codes follow spend over the last 12 months: under $100 is 10% off, $100-$499 15%, $500 and up 20%. */
export const birthdayPercent = (spendYear) => (spendYear >= 50000 ? 20 : spendYear >= 10000 ? 15 : 10);
export const BIRTHDAY_CODE_DAYS = 14;

/** The next date (YYYY-MM-DD, fromKey or later) a 'MM-DD' birthday falls on. 29 February is the 28th in other years. */
export function nextBirthday(mmdd, fromKey) {
  if (!/^\d{2}-\d{2}$/.test(String(mmdd || ''))) return null;
  const year = Number(fromKey.slice(0, 4));
  for (const y of [year, year + 1]) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const date = `${y}-${mmdd === '02-29' && !leap ? '02-28' : mmdd}`;
    if (date >= fromKey) return date;
  }
  return null;
}

/** Whole years from one day key to another, the way birthdays count them (never below 0). */
export function wholeYears(fromKey, toKey) {
  const [y1, m1, d1] = String(fromKey).split('-').map(Number);
  const [y2, m2, d2] = String(toKey).split('-').map(Number);
  if (![y1, m1, d1, y2, m2, d2].every(Number.isFinite)) return 0;
  return Math.max(0, y2 - y1 - (m2 < m1 || (m2 === m1 && d2 < d1) ? 1 : 0));
}

/**
 * When a member became a customer, as staff set it (round 6): 'YYYY-MM-DD', or 'YYYY' for 1 January that year. null or
 * empty clears it (null). A date that doesn't exist, or one after today (todayKey), is refused.
 */
export function parseSince(value, todayKey) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const key = /^\d{4}$/.test(text) ? `${text}-01-01` : text;
  const real = /^\d{4}-\d{2}-\d{2}$/.test(key) && !Number.isNaN(Date.parse(`${key}T00:00:00Z`)) && new Date(`${key}T00:00:00Z`).toISOString().slice(0, 10) === key;
  if (!real || key < '1900-01-01') throw new RuleError('Pick a real date, like 2019-06-01, or just the year, like 2019.');
  if (key > todayKey) throw new RuleError("That date hasn't happened yet. Pick when they first became a customer.");
  return key;
}

/**
 * The New Zealand financial year (1 April to 31 March) that starts in `start`: { fy: '2026/27', from: '2026-04-01',
 * to: '2027-03-31', start }.
 */
export const financialYearFrom = (start) => ({ fy: `${start}/${String((start + 1) % 100).padStart(2, '0')}`, from: `${start}-04-01`, to: `${start + 1}-03-31`, start });

/** The financial year a Lair day key ('YYYY-MM-DD') falls in: 31 March is the old year, 1 April the new one. */
export function financialYear(key) {
  const [y, m] = String(key).split('-').map(Number);
  return financialYearFrom(m >= 4 ? y : y - 1);
}

/** Spend earns a dice roll every $20. Rolls stack and never expire. */
export const ROLL_EVERY = 2000;

/**
 * What a spend roll wins, in store credit: $1 for each "1" on the face (1, 10 and 12-19 pay $1, 11 pays $2), and a
 * natural 20 pays $20. Anything else wins nothing. The dice never give discount codes.
 */
export function rollPrize(roll) {
  if (roll === 20) return { kind: 'credit', amount: 2000 };
  const ones = [...String(roll)].filter((c) => c === '1').length;
  return ones ? { kind: 'credit', amount: ones * 100 } : null;
}

/* ---------- the loyalty card (round 6: it replaces the spend dice) ----------
   A stamp for each person at each session they turn up to; 10 stamps fill a card, and a full card earns a d20 roll
   whose face is the prize in store credit ($1 to $20). */
export const CARD_SIZE = 10;

/** The card from all the stamps someone has: { stamps (0-9 on the current card), cards (full cards so far) } */
export const loyaltyCard = (total) => {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  return { stamps: n % CARD_SIZE, cards: Math.floor(n / CARD_SIZE) };
};

/** A loyalty roll's prize: whatever the d20 shows, in store credit */
export const loyaltyPrize = (roll) => ({ kind: 'credit', amount: roll * 100 });

/**
 * What Gobgob says about a loyalty roll. pending: Shopify couldn't add the credit, so it's claimed at the counter. "An"
 * for 8, 11 and 18, the faces said with a vowel sound.
 */
export function loyaltyMessage(roll, pending = false) {
  const said = roll === 20 ? 'Natural 20! $20 store credit is yours.'
    : roll === 1 ? "A 1! $1 store credit, and Gobgob's still proud of it."
      : `You rolled ${[8, 11, 18].includes(roll) ? 'an' : 'a'} ${roll}: $${roll} store credit is yours.`;
  return pending ? `${said} Show this screen at the counter to claim it.` : said;
}

/* ---------- library holds (round 6): reserve a board game from the library ---------- */
/**
 * Round 7 (Mo, 6 Oct): a hold lasts until midnight at the end of the third day, the day it's made counting as the
 * first: made any time Tuesday, held until midnight Thursday (00:00 Friday, Lair time).
 */
export const HOLD_DAYS = 3;

/** When a hold made at `ms` ends, in Lair time (right across daylight saving changes: the days are counted, not hours) */
export const holdUntil = (time, ms) => time.at(addDays(time.key(ms), HOLD_DAYS), 0);

/**
 * A member's library plan from their Shopify customer tags (Simplee Memberships), matched without case: a tag containing
 * "hoard" is 5 games at a time, "stash" or "treasure" 3, "grab" or "loot" 1, and a plain "library-member" tag with none
 * of those 1. null: no plan.
 */
export function libraryPlan(tags) {
  const list = (Array.isArray(tags) ? tags : []).map((t) => String(t).trim().toLowerCase());
  const has = (...words) => list.some((t) => words.some((w) => t.includes(w)));
  if (has('hoard')) return { name: 'Hoard', games: 5 };
  if (has('stash', 'treasure')) return { name: 'Stash', games: 3 };
  if (has('grab', 'loot')) return { name: 'Grab', games: 1 };
  if (list.includes('library-member')) return { name: 'Library', games: 1 };
  return null;
}

/* ---------- mobile numbers (round 7): required on every customer booking ---------- */
export const MOBILE_MISSING = 'Add a mobile number so we can reach you on the day.';
export const MOBILE_WRONG = "That mobile number doesn't look right. Try one like 021 123 4567.";

/**
 * A mobile number, checked: spaces, dashes, dots and brackets don't count, and it's a New Zealand mobile (021 123 4567,
 * +64 21 123 456) or an overseas number starting with + (not +64: a visitor's mobile). New Zealand landlines are
 * refused, since Mo asked for a mobile. Returns it as typed (trimmed, runs of spaces made one, at most 20 characters; a
 * longer one keeps just its digits and +), or '' when it's empty and not required.
 */
export function checkMobile(value, { required = true } = {}) {
  const typed = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!typed) {
    if (required) throw new RuleError(MOBILE_MISSING);
    return '';
  }
  const bare = typed.replace(/[\s\-.()]/g, '');
  const nz = /^(?:\+?64|0)2\d{7,9}$/.test(bare);
  const overseas = /^\+[1-9]\d{6,14}$/.test(bare) && !bare.startsWith('+64');
  if (!nz && !overseas) throw new RuleError(MOBILE_WRONG);
  return typed.length <= 20 ? typed : bare;
}

/** A mobile number to compare: its digits, with a leading 0 read as +64 (021 123 4567 and +64 21 123 4567 are one) */
export function mobileKey(value) {
  const text = String(value ?? '').trim();
  const digits = text.replace(/\D/g, '');
  return !text.startsWith('+') && digits.startsWith('0') ? `64${digits.slice(1)}` : digits;
}

/* ---------- what the public may see ---------- */
export function publicBooking(b) {
  return { id: b.id, kind: b.kind, tables: b.tables, start: b.start, end: b.end, status: b.status, gameId: b.gameId || null, people: b.kind === 'walkin' || b.kind === 'table' ? undefined : b.people };
}

/**
 * A GM game as the games board shows it. held: seats kept for weekly regulars who don't have their seat at this
 * session yet; they count as taken, so the board never offers them to anyone else. Only seats still free can be held
 * (the theme's demo works it out the same way), so held never says more than that, taken (booked plus held) never
 * passes the seats because of regulars, and an open game is full once taken reaches its seats.
 */
export function publicGame(g, state, rules = null, held = 0) {
  const booked = seatsTaken(state, g.id);
  const holding = Math.max(0, Math.min(Number(held) || 0, g.seats - booked));
  const taken = booked + holding;
  const gmFee = g.gmFee ?? rules?.prices.gmCredit ?? 500;
  return {
    id: g.id, title: g.title, system: g.system, gm: g.gm, level: g.level, age: g.age, tags: g.tags, safety: g.safety,
    pregens: g.pregens, blurb: g.blurb, tables: g.tables, start: g.start, end: g.end, seats: g.seats, taken, held: holding,
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
    // The old "let people pay online" setting: nothing reads it any more (tables, seats and walk-ins are paid at the
    // counter; each event says how it's paid).
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

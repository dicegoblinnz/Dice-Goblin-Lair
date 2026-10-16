/**
 * Round 17: Help me pick (contract v17, docs/contracts/lair-api-contract-v17-help-me-pick.md). Mo (16 Oct 2026): a quiz
 * that takes anyone from "what should we play?" to three good library games plus a wildcard in about 30 seconds, for
 * playing here or for borrowing.
 *
 * This is the Lair's half of it: its own copy of the library catalogue from Shopify (pick_catalog, and the for-sale
 * board games in pick_shop for "Buy your own copy"), each game's facts (pick_facts: the seed Claude wrote, basic facts
 * from a new listing, Workers AI's tags, staff's checks), the matcher, quiz sessions and their events, ratings, a
 * member's taste, the staff check list and the demand report. The borrow queue, postal sends, watches and booking holds
 * are src/queue.js's (section 5).
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair. The
 * matcher never calls Shopify: everything it reads is in the Lair's own tables. Routes do their waiting first (Shopify,
 * Workers AI, the rules) and then read, check and write with no awaits in between, as everywhere else in the Lair.
 * Nothing here changes what the floor shows, so writes go straight to this.sql (not this.write, which drops the floor's
 * cache): a busy night of quizzes never slows the staff floor.
 */
import { HOUR, MIN, RuleError, addDays, lairTime } from './core.js';
import { emailReady, safeEqual } from './shopify.js';
import { wishlistProductId } from './wishlist.js';
import { PICK_VOCAB } from './pick-vocab.js';
import { PICK_SEED, PICK_SEED_VERSION } from './pick-seed.js';
import { PICK_KNOWN } from './pick-known.js';

/** Every message a customer or staff member can see from these routes, word for word in the contract (section 8) */
export const PICK_MESSAGES = {
  login: 'Log in to save your picks.',
  loginRate: 'Log in to rate games.',
  product: "That isn't one of our library games. Refresh the page and try again.",
  gone: 'Those picks have gone. Take the quiz again for fresh ones.',
  notYours: "Those picks aren't yours to change. Take the quiz again to make your own.",
  email: "That email address doesn't look right. Check it and try again.",
  busy: 'Gobgob needs a breather. Try again in a few minutes.',
  game: 'Pick a game from the library to bring to your table.',
  facts: "That game's details don't look right: <field>.",
};
/** The facts message with the field named: "That game's details don't look right: players.max." */
export const factsMessage = (field) => PICK_MESSAGES.facts.replace('<field>', field);

/**
 * The seed and the famous games the Lair uses. Tests (and nothing else) swap these for their own before a Lair starts,
 * since the seed is applied as the Lair starts.
 */
export const PICK_DATA = { seedVersion: PICK_SEED_VERSION, seed: PICK_SEED, known: PICK_KNOWN };

const DAY = 24 * HOUR;
/** The contract's numbers in one place */
export const PICK_LIMITS = {
  quizPer10Min: 60, emailsPerSession: 3, emailsPerHour: 10, eventsPerSession: 50, sessionDays: 180, prunePerRun: 500, autoTagPerRun: 5,
  aiTries: 3, fullSyncHours: 6, savedShown: 5, toRateDays: 30, toRateShown: 5, tasteKept: 50, lovesKept: 5,
};
/** Workers AI's model for tagging new games, unless config PICK_AI_MODEL names another (it supports JSON mode) */
export const PICK_AI_MODEL = '@cf/google/gemma-4-26b-a4b-it';
/** Shopify's search for library listings, and for the for-sale board games ("Buy your own copy") */
export const PICK_LIBRARY_QUERY = "tag:'Board Game Rental' AND status:active";
export const PICK_SHOP_QUERY = "product_type:'Board Games' AND -tag:'Board Game Rental' AND status:active";

const PICK_MODES = ['play', 'borrow', 'rpg'];
const PICK_TIMES = ['short', 'medium', 'long', 'epic'];
/** Brain power: the weights each answer covers (weights have one decimal place) */
const BRAINS = { easy: [1.0, 1.9], some: [2.0, 2.9], big: [3.0, 5.0] };
const PICK_TEAMS = ['coop', 'competitive', 'either'];
const PICK_DOORS = ['library', 'collection', 'booking', 'kiosk', 'table', 'page', 'my-lair', 'share'];
/** Pick tracking's actions (POST /pick/:id/event); anything else is ignored */
export const PICK_ACTIONS = ['view', 'reserve', 'queue', 'book', 'buy', 'shelf', 'save', 'share', 'email', 'video', 'more', 'watch', 'again', 'swipe-skip'];
/** The fine-tune's theme chips (section 2.6): each group and the themes it covers */
export const PICK_THEME_GROUPS = {
  fantasy: ['fantasy', 'mythology'], scifi: ['sci-fi', 'space'], spooky: ['spooky', 'horror'], mystery: ['mystery', 'crime'],
  history: ['history', 'war'], nature: ['nature', 'animals', 'farming'], cute: ['cute'], food: ['food'], adventure: ['adventure', 'pirates'],
  travel: ['travel', 'trains', 'city'], heroes: ['superheroes', 'film-tv'], abstract: ['abstract'], words: ['words'], funny: ['humour'],
  sports: ['sports'], science: ['science', 'art'],
};
/** Player types (section 2.9): the styles that count for each, the themes that count for adventurers, and the tie order */
const TYPE_STYLES = {
  party: ['party', 'dexterity', 'drawing', 'word', 'trivia', 'hidden-roles'],
  thinker: ['puzzle', 'engine-building', 'abstract', 'worker-placement', 'economic'],
  competitor: ['area-control', 'take-that', 'auction', 'negotiation'],
  adventurer: ['campaign', 'storytelling', 'dungeon-crawl'],
  chill: ['tile-laying', 'pattern-building', 'set-collection'],
};
const ADVENTURE_THEMES = ['adventure', 'fantasy', 'mythology', 'pirates'];
export const PICK_PLAYER_TYPES = ['team', 'party', 'thinker', 'competitor', 'adventurer', 'chill'];
/** A library shelf section's player counts, for a listing that doesn't say (basic facts) */
const SHELF_PLAYERS = { DGL12: [1, 2], DGL34: [2, 4], DGL56: [2, 6], 'DGL7+': [3, 8], DGLF: [2, 4], DGLRPG: [2, 6] };

/* ---------------- small helpers ---------------- */
const parseJson = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
const uniq = (list) => [...new Set(list)];
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
/** A number from a number or a plain numeric string, else NaN */
const numberOf = (value) => (typeof value === 'number' ? value : typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value) ? Number(value) : NaN);
/** A whole number inside lo..hi (a number or a string of digits), else null */
const wholeIn = (value, lo, hi) => {
  const n = numberOf(value);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};
/** A Shopify product's number from its digits, a number or its gid (as the wishlist reads them), else null */
export const pickProductId = (value) => wishlistProductId(value);
/** Shopify's handle for a tag: "In Store Only" → "in-store-only" */
const tagHandle = (tag) => String(tag ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/** Text cut to max characters at a word, with "…" when it was cut */
const cutText = (text, max) => {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(' ');
  return `${(space > max * 0.6 ? room.slice(0, space) : room).replace(/[\s,;:.-]+$/, '')}…`;
};

/**
 * The matching key for titles (section 1.1): lower case, "(library)" and any bracketed edition words removed, "&" →
 * "and", accents dropped, every run of non-letters-or-digits one space, trimmed. "Catan (Library)", "CATAN (5th
 * Edition)" and "Catán" are all "catan".
 */
export function pickNorm(text) {
  return String(text ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(\s*library\s*\)/g, ' ')
    .replace(/\([^)]*\bedition\b[^)]*\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
/** A series key: a title's first two words (as pickNorm reads them), so "Adventure Games: The Dungeon" and "Adventure Games: Monochrome Inc." match */
export const pickSeries = (title) => pickNorm(title).split(' ').filter(Boolean).slice(0, 2).join(' ');

/** A shelf code's parts: "DGL34-M011" → { section: 'DGL34', size: 'M', number: 11 }; "DGLRPG-021" has no size. null for anything else. */
export function shelfParts(code) {
  const m = String(code ?? '').trim().toUpperCase().match(/^(DGL(?:12|34|56|7\+|F|RPG))-([SML])?(\d{1,4})$/);
  return m ? { section: m[1], size: m[2] || null, number: Number(m[3]) } : null;
}

/** A weight in the quiz's words: easy (under 2.0), some (2.0 to 2.9) or big (3.0 and up) */
export const brainOf = (weight) => (weight < 2 ? 'easy' : weight < 3 ? 'some' : 'big');

/* ---------------- a pick in plain words (the "Your picks" email) ---------------- */
/** "2–4 players", "2 players", "1 player" */
export const playersWords = (p) => (!p ? '' : p.min === p.max ? `${p.min} ${p.min === 1 ? 'player' : 'players'}` : `${p.min}–${p.max} players`);
/** "45 min", "60–90 min" */
export const timeWords = (t) => (!t ? '' : t.min === t.max ? `${t.min} min` : `${t.min}–${t.max} min`);
const BRAIN_WORDS = { easy: 'Easy to learn', some: 'Some brain power', big: 'Big brain power' };
const VIBE_WORDS = { chill: 'Chill', laughs: 'Lots of laughs', thinky: 'Thinky', cutthroat: 'Cutthroat' };
const GROUP_WORDS = {
  fantasy: 'Fantasy', scifi: 'Sci-fi', spooky: 'Spooky', mystery: 'Mystery', history: 'History', nature: 'Nature', cute: 'Cute', food: 'Food',
  adventure: 'Adventure', travel: 'Travel', heroes: 'Heroes', abstract: 'Abstract', words: 'Words', funny: 'Funny', sports: 'Sports', science: 'Science',
};
/** A pick's reasons (why) as one plain line: "Best at 4 players. Co-op. Lots of laughs." */
export function reasonWords(why) {
  const say = (r) => {
    switch (r?.code) {
      case 'best-at': return `Best at ${r.n} players`;
      case 'players': return `Fits ${r.n} ${r.n === 1 ? 'player' : 'players'}`;
      case 'time': return `About ${timeWords(r)}`;
      case 'brain': return BRAIN_WORDS[r.value] || '';
      case 'coop': return 'Co-op: you win or lose together';
      case 'competitive': return 'Head to head';
      case 'team': return 'Play in teams';
      case 'vibe': return VIBE_WORDS[r.vibe] || '';
      case 'like': return r.title ? `A bit like ${r.title}` : '';
      case 'theme': return GROUP_WORDS[r.group] || '';
      case 'kids': return `Ages ${r.age}+`;
      case 'rated': return `${r.ups} members gave it a thumbs up`;
      case 'staff-pick': return 'Staff pick';
      case 'new': return 'New in the library';
      case 'underplayed': return 'Nobody has borrowed it for a while';
      case 'stretch': return 'Something a little different';
      default: return '';
    }
  };
  return (Array.isArray(why) ? why : []).map(say).filter(Boolean).map((s) => `${s}.`).join(' ');
}

/* ---------------- reading a listing (basic facts, section 1.2) ---------------- */
/**
 * Players from the listing's text: "2–4" and "2-4" → 2 to 4, "1–6+" → 1 to 6, "2+" → 2 to 6 (the minimum plus 4, never
 * 99), "2" → 2. null when there's no number.
 */
export function parsePlayersText(text) {
  const s = String(text ?? '').replace(/[–—−]/g, '-').replace(/\s+to\s+/gi, '-').trim();
  let m = s.match(/(\d{1,2})\s*-\s*(\d{1,2})/);
  if (m && Number(m[1]) >= 1 && Number(m[2]) >= Number(m[1])) return { min: Math.min(20, Number(m[1])), max: Math.min(99, Number(m[2])) };
  m = s.match(/(\d{1,2})\s*\+/);
  if (m && Number(m[1]) >= 1) return { min: Math.min(20, Number(m[1])), max: Math.min(99, Number(m[1]) + 4) };
  m = s.match(/(\d{1,2})/);
  if (m && Number(m[1]) >= 1) return { min: Math.min(20, Number(m[1])), max: Math.min(99, Number(m[1])) };
  return null;
}

/**
 * Play time from the listing's text, in minutes: "60–90 min" → 60 to 90, "1–2 hours" → 60 to 120, "60+ min" → 60 to 90,
 * and one number the way the tagging work reads a box: "20 min" → 15 to 20 (about 75% of it, then the number). "per
 * player" times are multiplied by `players` (the best count). null when there's no number.
 */
export function parseTimeText(text, players = 1) {
  const s = String(text ?? '').toLowerCase().replace(/[–—−]/g, '-').replace(/\s+to\s+/g, '-');
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?\s*(\+)?\s*(hours?|hrs?|h\b|minutes?|mins?|m\b)?/);
  if (!m) return null;
  const unit = /^h/.test(m[4] || '') ? 60 : 1;
  const each = /per\s+player/.test(s) ? Math.max(1, players) : 1;
  const a = Number(m[1]) * unit * each;
  const b = m[2] != null ? Number(m[2]) * unit * each : null;
  let min;
  let max;
  if (b != null && b >= a) [min, max] = [a, b];
  else if (m[3]) [min, max] = [a, a * 1.5];
  else [min, max] = [a * 0.75, a];
  min = Math.min(1440, Math.max(1, Math.round(min)));
  return { min, max: Math.min(1440, Math.max(min, Math.round(max))) };
}

/** The youngest age a listing names ("ages 8+", "Ages 6+", "age 10 and up"), 2 to 18, else null */
export function parseAge(texts) {
  for (const text of texts) {
    const m = String(text ?? '').match(/\bages?\s*:?\s*(\d{1,2})\s*(?:\+|and up|years)/i);
    if (m) return Math.min(18, Math.max(2, Number(m[1])));
  }
  return null;
}

/** A blurb's first sentence (an exclamation mark made a full stop), or '' */
const firstSentence = (text) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : s).replace(/!+$/, '.').trim();
};

/**
 * Basic facts for a library game the seed doesn't know (a game added since), made at once from its catalogue row, as
 * the contract lists them (1.2, 2): the listing's players, play time and difficulty, ages from the tags, blurb or
 * description, co-op from the tags, vibes, themes and styles from the tags, reading some, table single, confidence low.
 * Where the listing says nothing: players from the shelf section, time 30 to 60 minutes (20 to 30 with the "30 min or
 * less" tag; 3 to 4 hours for an RPG book). An RPG book (DGLRPG) also gets the rpg object validFacts needs. The caller
 * checks it with validFacts.
 */
export function basicFacts(row) {
  const tags = (Array.isArray(row.tags) ? row.tags : parseJson(row.tags, [])).map(String);
  const handles = tags.map(tagHandle);
  const shelf = String(row.shelf_code ?? row.shelfCode ?? '').toUpperCase();
  const title = String(row.title || '').trim() || 'A library game';
  const kind = /\bexpansion\b/i.test(row.raw_title || title) ? 'expansion' : shelf.startsWith('DGLRPG') ? 'rpg' : 'game';
  const rpg = kind === 'rpg';
  const section = shelfParts(shelf)?.section || '';
  const [pMin, pMax] = (() => {
    const p = parsePlayersText(row.players_text);
    if (p) return [p.min, p.max];
    return SHELF_PLAYERS[section] || [2, 4];
  })();
  const best = Math.min(pMax, Math.max(pMin, Math.round((pMin + pMax) / 2)));
  const time = parseTimeText(row.time_text, best) || (handles.includes('30-min-or-less') ? { min: 20, max: 30 } : rpg ? { min: 180, max: 240 } : { min: 30, max: 60 });
  const weight = { easy: 1.5, medium: 2.5, hard: 3.5 }[String(row.difficulty ?? '').trim().toLowerCase()] ?? 2.0;
  const age = parseAge([...tags, row.blurb, row.description]) ?? 8;
  const coop = handles.some((h) => /^(co-op|coop|cooperative|co-operative)$/.test(h));
  const vibes = uniq([
    ...(handles.includes('party') ? ['laughs'] : []),
    ...(coop || handles.some((h) => h.startsWith('family')) ? ['chill'] : []),
    ...(handles.includes('strategy') ? ['thinky'] : []),
  ]).slice(0, 2);
  const themes = uniq(handles.filter((h) => PICK_VOCAB.themes.includes(h))).slice(0, 3);
  const styles = uniq(handles.filter((h) => PICK_VOCAB.styles.includes(h))).slice(0, 4);
  const blurbLine = firstSentence(row.blurb);
  const summary = blurbLine.length >= 10 && blurbLine.length <= 140 ? blurbLine : `${cutText(title, 120)}, from the library.`;
  const starter = /starter|beginner|essentials|quick-?start/i.test(title);
  return {
    kind,
    players: { min: pMin, max: pMax, best: [best] },
    time,
    weight,
    age,
    mode: coop ? 'coop' : 'competitive',
    vibes: vibes.length ? vibes : ['thinky'],
    themes: themes.length ? themes : ['abstract'],
    styles: styles.length ? styles : ['set-collection'],
    reading: 'some',
    access: { colourBlind: null, easyPieces: null },
    table: 'single',
    expansionOf: null,
    rpg: rpg ? { system: cutText(title, 80), starter, setting: themes[0] || 'fantasy', type: starter ? 'starter' : 'core' } : null,
    summary,
    confidence: 'low',
  };
}

/* ---------------- checking facts (validFacts, section 1.2) ---------------- */
/**
 * Check a facts object against the contract's shape and PICK_VOCAB. Returns { ok: true, facts } (the facts, tidied: words
 * lower case, lists without repeats, in the contract's key order) or { ok: false, field } naming the first field that's
 * wrong (players.max, vibes, rpg.setting…), for staff's 422.
 *
 * clamp (Workers AI's answers): numbers are clamped into range and rounded, unknown words dropped (a list left empty is
 * still wrong), a long summary is cut at a word, a missing access answer is null, best defaults to the middle count, and
 * an rpg or expansionOf that doesn't belong to the kind is dropped. Without clamp (staff, the seed) any of those is wrong.
 */
export function validFacts(input, { clamp = false } = {}) {
  const bad = (field) => ({ ok: false, field });
  if (!isObject(input)) return bad('facts');
  const V = PICK_VOCAB;
  const word = (value, list) => {
    const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return list.includes(text) ? text : null;
  };
  const words = (value, list, most) => {
    const given = Array.isArray(value) ? value : [];
    const known = uniq(given.map((v) => word(v, list)).filter(Boolean));
    if (clamp) return known.length ? known.slice(0, most) : null;
    return given.length >= 1 && given.length <= most && known.length === given.length ? known : null;
  };
  const range = (obj, lo, hi, field, top = hi) => {
    if (!isObject(obj)) return bad(field);
    let a = numberOf(obj.min);
    let b = numberOf(obj.max);
    if (clamp) {
      if (!Number.isFinite(a) || !Number.isFinite(b)) return bad(field);
      a = Math.min(hi, Math.max(lo, Math.round(a)));
      b = Math.min(top, Math.max(a, Math.round(b)));
    } else {
      if (!Number.isInteger(a) || a < lo || a > hi) return bad(`${field}.min`);
      if (!Number.isInteger(b) || b < a || b > top) return bad(`${field}.max`);
    }
    return { min: a, max: b };
  };

  const kind = word(input.kind, V.kinds);
  if (!kind) return bad('kind');
  const players = range(input.players, 1, 20, 'players', 99);
  if (players.ok === false) return players;
  const bestGiven = Array.isArray(input.players.best) ? input.players.best.map(numberOf) : [];
  let best;
  if (clamp) {
    best = uniq(bestGiven.filter(Number.isFinite).map(Math.round).filter((b) => b >= players.min && b <= players.max)).slice(0, 3);
    if (!best.length) best = [Math.min(players.max, Math.max(players.min, Math.round((players.min + players.max) / 2)))];
  } else {
    if (!bestGiven.length || bestGiven.length > 3 || bestGiven.some((b) => !Number.isInteger(b) || b < players.min || b > players.max)) return bad('players.best');
    best = uniq(bestGiven);
  }
  const time = range(input.time, 1, 1440, 'time');
  if (time.ok === false) return time;
  let weight = numberOf(input.weight);
  if (clamp && Number.isFinite(weight)) weight = Math.round(Math.min(5, Math.max(1, weight)) * 10) / 10;
  if (!Number.isFinite(weight) || weight < 1 || weight > 5 || Math.abs(Math.round(weight * 10) / 10 - weight) > 1e-9) return bad('weight');
  let age = numberOf(input.age);
  if (clamp && Number.isFinite(age)) age = Math.min(18, Math.max(2, Math.round(age)));
  if (!Number.isInteger(age) || age < 2 || age > 18) return bad('age');
  const mode = word(input.mode, V.modes);
  if (!mode) return bad('mode');
  const vibes = words(input.vibes, V.vibes, 2);
  if (!vibes) return bad('vibes');
  const themes = words(input.themes, V.themes, 3);
  if (!themes) return bad('themes');
  const styles = words(input.styles, V.styles, 4);
  if (!styles) return bad('styles');
  const reading = word(input.reading, V.reading);
  if (!reading) return bad('reading');
  const access = {};
  const givenAccess = isObject(input.access) ? input.access : clamp ? {} : null;
  if (!givenAccess) return bad('access');
  for (const key of ['colourBlind', 'easyPieces']) {
    const v = givenAccess[key];
    if (v === true || v === false || v === null) access[key] = v;
    else if (clamp || v === undefined) access[key] = null;
    else return bad(`access.${key}`);
  }
  const table = word(input.table, V.tables);
  if (!table) return bad('table');
  let expansionOf = input.expansionOf ?? null;
  if (expansionOf === '') expansionOf = null;
  if (expansionOf !== null) {
    const id = pickProductId(expansionOf);
    if (id && kind === 'expansion') expansionOf = id;
    else if (clamp) expansionOf = null;
    else return bad('expansionOf');
  }
  let rpg = null;
  if (kind === 'rpg') {
    const r = isObject(input.rpg) ? input.rpg : null;
    if (!r) return bad('rpg');
    const system = typeof r.system === 'string' ? r.system.replace(/\s+/g, ' ').trim() : '';
    if (!system || (!clamp && system.length > 80)) return bad('rpg.system');
    if (!clamp && typeof r.starter !== 'boolean') return bad('rpg.starter');
    const starter = clamp ? r.starter === true : r.starter;
    const setting = word(r.setting, V.themes) || (clamp ? themes[0] : null);
    if (!setting) return bad('rpg.setting');
    const type = word(r.type, V.rpgTypes) || (clamp ? (starter ? 'starter' : 'core') : null);
    if (!type) return bad('rpg.type');
    rpg = { system: cutText(system, 80), starter, setting, type };
  } else if (input.rpg != null && !clamp) {
    return bad('rpg');
  }
  let summary = typeof input.summary === 'string' ? input.summary.replace(/\s+/g, ' ').trim() : '';
  if (clamp) summary = cutText(summary, 140);
  if (summary.length < 10 || summary.length > 140) return bad('summary');
  const confidence = word(input.confidence, V.confidence) || (clamp ? 'low' : null);
  if (!confidence) return bad('confidence');
  return {
    ok: true,
    facts: {
      kind, players: { min: players.min, max: players.max, best }, time, weight, age, mode, vibes, themes, styles, reading, access, table,
      expansionOf, rpg, summary, confidence,
    },
  };
}

/* ---------------- reading Shopify's answers (syncCatalog) ---------------- */
const digitsOf = (gid) => String(gid ?? '').split('/').pop();
const msOf = (value) => {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
};
const centsOf = (amount) => {
  const cents = Math.round(Number(amount) * 100);
  return Number.isFinite(cents) && cents >= 0 ? cents : null;
};
/** Text from a listing's HTML: tags dropped, the common entities read, white space collapsed */
export function plainText(html) {
  return String(html ?? '')
    .replace(/<\s*(br|\/p|\/li|\/h\d)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
/**
 * The first how-to-play video in a listing's HTML, as https://www.youtube.com/watch?v=<id>: a youtube.com/watch?v= or
 * youtu.be/ link. A YouTube search link (youtube.com/results?…) doesn't count. null when there's none.
 */
export function firstVideo(html) {
  const m = String(html ?? '').match(/(?:https?:)?\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?(?:[^"'<>\s]*?&(?:amp;)?)?v=|youtu\.be\/)([A-Za-z0-9_-]{6,20})/i);
  return m ? `https://www.youtube.com/watch?v=${m[1]}` : null;
}
/** The listing's Google blurb without its leading "Borrow <title> at Dice Goblin.", else null */
export function blurbOf(text) {
  const rest = String(text ?? '').replace(/^\s*Borrow\b.*?\bat Dice Goblin\.\s*/i, '').trim();
  return rest || null;
}

/**
 * A library listing from Shopify (LairPickCatalog) as a pick_catalog row's values. copies: the first variant's stock
 * when it's tracked and at least 1 (99 at most), else null. shopCopy: the shop copy staff linked (custom.shop_copy), as
 * { productId, handle, title, price (cents), available, image }, or null.
 */
export function catalogRowOf(node, now) {
  const variant = node.variants?.nodes?.[0] || null;
  const quantity = Number(variant?.inventoryQuantity);
  const tracked = variant?.inventoryItem?.tracked !== false;
  const tags = (node.tags || []).map(String);
  const rawTitle = String(node.title || '').trim();
  const shop = node.shopCopy?.reference;
  const libraryCode = String(node.libraryCode?.value || '').trim().toUpperCase();
  return {
    productId: digitsOf(node.id),
    variantId: variant?.id ? digitsOf(variant.id) : null,
    handle: String(node.handle || ''),
    rawTitle,
    title: rawTitle.replace(/\s*\(\s*library\s*\)\s*$/i, '').trim() || rawTitle,
    image: node.featuredMedia?.preview?.image?.url || null,
    shelfCode: libraryCode || null,
    copies: tracked && Number.isInteger(quantity) && quantity >= 1 ? Math.min(99, quantity) : null,
    inStoreOnly: tags.some((t) => tagHandle(t) === 'in-store-only') ? 1 : 0,
    missingPieces: String(node.missingPieces?.value ?? '').trim().toLowerCase() === 'true' ? 1 : 0,
    missingNote: String(node.missingNote?.value ?? '').trim() || null,
    tags,
    playersText: String(node.players?.value ?? '').trim() || null,
    timeText: String(node.playTime?.value ?? '').trim() || null,
    difficulty: String(node.difficulty?.value ?? '').trim() || null,
    blurb: blurbOf(node.blurb?.value),
    video: firstVideo(node.descriptionHtml),
    description: plainText(node.descriptionHtml).slice(0, 1500) || null,
    vendor: String(node.vendor || '').trim() || null,
    createdAt: msOf(node.createdAt),
    updatedAt: msOf(node.updatedAt),
    shopCopy: shop?.id
      ? {
        productId: digitsOf(shop.id), handle: String(shop.handle || ''), title: String(shop.title || '').trim(),
        price: centsOf(shop.priceRangeV2?.minVariantPrice?.amount),
        available: shop.status === 'ACTIVE' && (shop.tracksInventory === false || Number(shop.totalInventory) > 0),
        image: shop.featuredMedia?.preview?.image?.url || null,
      }
      : null,
    seenAt: now,
  };
}

/** A for-sale board game from Shopify (LairPickShop) as a pick_shop row's values */
export function shopRowOf(node) {
  const title = String(node.title || '').trim();
  const variants = node.variants?.nodes || [];
  return {
    productId: digitsOf(node.id), handle: String(node.handle || ''), title, norm: pickNorm(title),
    price: centsOf(node.priceRangeV2?.minVariantPrice?.amount),
    available: Number(node.totalInventory) > 0 || variants.some((v) => v?.availableForSale === true) ? 1 : 0,
    image: node.featuredMedia?.preview?.image?.url || null,
  };
}

/* ---------------- Workers AI (autoTag, section 1.2) ---------------- */
/** The JSON schema Workers AI answers in (JSON mode): the facts object, with the base game's title for an expansion */
export const PICK_AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'players', 'time', 'weight', 'age', 'mode', 'vibes', 'themes', 'styles', 'reading', 'access', 'table', 'expansionOfTitle', 'rpg', 'summary', 'confidence'],
  properties: {
    kind: { type: 'string', enum: PICK_VOCAB.kinds },
    players: {
      type: 'object', additionalProperties: false, required: ['min', 'max', 'best'],
      properties: { min: { type: 'integer' }, max: { type: 'integer' }, best: { type: 'array', items: { type: 'integer' } } },
    },
    time: { type: 'object', additionalProperties: false, required: ['min', 'max'], properties: { min: { type: 'integer' }, max: { type: 'integer' } } },
    weight: { type: 'number' },
    age: { type: 'integer' },
    mode: { type: 'string', enum: PICK_VOCAB.modes },
    vibes: { type: 'array', items: { type: 'string', enum: PICK_VOCAB.vibes } },
    themes: { type: 'array', items: { type: 'string', enum: PICK_VOCAB.themes } },
    styles: { type: 'array', items: { type: 'string', enum: PICK_VOCAB.styles } },
    reading: { type: 'string', enum: PICK_VOCAB.reading },
    access: {
      type: 'object', additionalProperties: false, required: ['colourBlind', 'easyPieces'],
      properties: { colourBlind: { type: ['boolean', 'null'] }, easyPieces: { type: ['boolean', 'null'] } },
    },
    table: { type: 'string', enum: PICK_VOCAB.tables },
    expansionOfTitle: { type: ['string', 'null'] },
    rpg: {
      type: ['object', 'null'], additionalProperties: false, required: ['system', 'starter', 'setting', 'type'],
      properties: { system: { type: 'string' }, starter: { type: 'boolean' }, setting: { type: 'string', enum: PICK_VOCAB.themes }, type: { type: 'string', enum: PICK_VOCAB.rpgTypes } },
    },
    summary: { type: 'string' },
    confidence: { type: 'string', enum: PICK_VOCAB.confidence },
  },
};

/** What Workers AI is told (the tagging work's rules, short) */
const PICK_AI_RULES = [
  "You tag one board game from Dice Goblin's library (Auckland, New Zealand) for a quiz that recommends games.",
  'Answer with the JSON object only, using only the allowed words. Use what you know about the game together with the listing; when the listing and your knowledge disagree on players, time or age, the listing wins.',
  'kind: game; expansion (needs its base game; give expansionOfTitle, the base game\'s name); rpg (a roleplaying book or box, or a library code starting DGLRPG); other (not a game).',
  'players: min and max from the box; best: the 1 to 3 counts it plays best at, inside min..max. time: minutes for a whole game (one number on the box: about 75% of it as min, the number as max).',
  'weight: 1.0 to 5.0 with one decimal, BoardGameGeek\'s scale (Uno 1.1, Ticket to Ride 1.8, Catan 2.3, Wingspan 2.4, Scythe 3.4, Gloomhaven 3.9). age: the youngest age on the box.',
  'mode: competitive (the default), coop (everyone against the game, hidden traitors too), team (team against team, or one against many), solo (only playable alone).',
  'vibes: 1 or 2 of chill, laughs, thinky, cutthroat. themes: 1 to 3, strongest first (abstract when there is no real theme). styles: 1 to 4, strongest first.',
  'reading: light (icons and numbers), some (short card text), heavy (lots of text, word, trivia and story games, every RPG book).',
  'access: colourBlind true when colours always come with a symbol, false when it leans on telling colours apart, null when unsure; easyPieces true for big chunky pieces, false for fiddly bits, null when unsure. Prefer null to a guess.',
  'table: double only when it sprawls past one 4-seat cafe table (about 120 x 75 cm), else single. rpg: only for kind rpg, else null ({ system, starter, setting, type }).',
  'summary: one plain sentence, 10 to 140 characters, saying what you do in the game, in NZ English. No hype, no exclamation marks, no em dashes.',
  'confidence: medium when you know the game, low when you worked mostly from the listing.',
].join('\n');

/** The listing Workers AI reads: the title, vendor, tags, the listing's own fields and the description's text */
const aiListing = (row) => ({
  title: row.title, vendor: row.vendor || null, tags: parseJson(row.tags, []), libraryCode: row.shelf_code || null, players: row.players_text || null,
  playTime: row.time_text || null, difficulty: row.difficulty || null, blurb: row.blurb || null, description: String(row.description || '').slice(0, 1500),
});

/**
 * Workers AI's answer as an object: the JSON in an OpenAI-style answer (choices[0].message.content) or an older model's
 * `response` (text or already an object), with any ```json fence taken off. Throws when there's no JSON.
 */
export function aiAnswerObject(answer) {
  const content = answer?.choices?.[0]?.message?.content ?? answer?.response ?? answer;
  if (isObject(content)) return content;
  const text = String(content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Workers AI gave no JSON.');
  return JSON.parse(text.slice(start, end + 1));
}

/* ---------------- what the quiz sends (section 2.1) ---------------- */
/** Each time answer's minutes, for the score's "inside the bucket" (short: under 30, medium: 30–60, long: 1–2 hours, epic: longer) */
const TIME_BUCKETS = { short: [0, 30], medium: [30, 60], long: [60, 120], epic: [120, Infinity] };
const dayKeyOf = (value) => {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const d = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === text ? text : null;
};

/** Up to 5 loved games, each { productId } (a library game) or { known } (a famous game's title), repeats dropped */
function cleanLoves(value) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    if (out.length >= PICK_LIMITS.lovesKept) break;
    const productId = isObject(item) ? pickProductId(item.productId) : null;
    const known = isObject(item) && typeof item.known === 'string' ? item.known.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    const key = productId ? `p:${productId}` : known ? `k:${pickNorm(known)}` : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(productId ? { productId } : { known });
  }
  return out;
}

/**
 * The quiz's answers as the matcher uses them: anything missing or out of range is "not asked" (players 4, time any,
 * brain any, team either, no kids, mode play), never a 422, so an old page or a half-filled quiz still gets picks.
 * Returns { answers (2.1 without context: what's saved and sent back), context }.
 */
export function cleanAnswers(input) {
  const body = isObject(input) ? input : {};
  const mode = PICK_MODES.includes(body.mode) ? body.mode : 'play';
  const players = wholeIn(body.players, 1, 8) ?? 4;
  const youngest = body.kids === true ? wholeIn(body.youngest, 2, 17) : null;
  const f = isObject(body.filters) ? body.filters : {};
  const swipes = {};
  if (isObject(body.swipes)) {
    for (const [key, value] of Object.entries(body.swipes).slice(0, 60)) {
      const id = pickProductId(key);
      if (id && ['like', 'nope', 'skip'].includes(value)) swipes[id] = value;
    }
  }
  const r = isObject(body.rpg) ? body.rpg : {};
  const c = isObject(body.context) ? body.context : {};
  const table = typeof c.table === 'string' && /^[A-Za-z]{1,3}\d{1,3}$/.test(c.table.trim()) ? c.table.trim().toUpperCase() : null;
  const bookingId = typeof c.bookingId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(c.bookingId) ? c.bookingId : null;
  return {
    answers: {
      mode, players, kids: youngest != null, youngest,
      time: PICK_TIMES.includes(body.time) ? body.time : null,
      brain: Object.hasOwn(BRAINS, String(body.brain)) ? body.brain : null,
      team: PICK_TEAMS.includes(body.team) ? body.team : 'either',
      vibes: uniq((Array.isArray(body.vibes) ? body.vibes : []).filter((v) => PICK_VOCAB.vibes.includes(v))),
      filters: {
        themes: uniq((Array.isArray(f.themes) ? f.themes : []).filter((g) => Object.hasOwn(PICK_THEME_GROUPS, String(g)))),
        loves: cleanLoves(f.loves), lightReading: f.lightReading === true, colourBlind: f.colourBlind === true, easyPieces: f.easyPieces === true,
        hideHad: f.hideHad === true,
      },
      swipes,
      rpg: mode === 'rpg'
        ? {
          tried: ['never', 'some', 'lots'].includes(r.tried) ? r.tried : null, players: wholeIn(r.players, 1, 8) ?? players,
          setting: PICK_VOCAB.themes.includes(r.setting) ? r.setting : 'any', gm: ['lair', 'own'].includes(r.gm) ? r.gm : null,
        }
        : null,
      useTaste: body.useTaste === true,
    },
    context: { door: PICK_DOORS.includes(c.door) ? c.door : null, table, bookingId, date: dayKeyOf(c.date) },
  };
}

/* ---------------- comparing games (section 2.3) ---------------- */
const jaccard = (a, b) => {
  const A = new Set(Array.isArray(a) ? a : []);
  const B = new Set(Array.isArray(b) ? b : []);
  if (!A.size && !B.size) return 0;
  let both = 0;
  for (const x of A) if (B.has(x)) both += 1;
  return both / (A.size + B.size - both);
};
/**
 * How alike two games are, 0 to 1: 0.35 × Jaccard(styles) + 0.25 × Jaccard(themes) + 0.2 × Jaccard(vibes) + 0.1 × (1 −
 * |weight difference| / 4) + 0.1 × (same mode). Works on facts and on a famous game's fields alike.
 */
export function similarity(a, b) {
  if (!a || !b) return 0;
  const wa = Number(a.weight);
  const wb = Number(b.weight);
  const weight = Number.isFinite(wa) && Number.isFinite(wb) ? 1 - Math.min(4, Math.abs(wa - wb)) / 4 : 0;
  return 0.35 * jaccard(a.styles, b.styles) + 0.25 * jaccard(a.themes, b.themes) + 0.2 * jaccard(a.vibes, b.vibes) + 0.1 * weight
    + 0.1 * (a.mode && a.mode === b.mode ? 1 : 0);
}

/** The theme chip a theme word belongs to ('horror' → 'spooky'), or null */
export const themeGroupOf = (theme) => Object.keys(PICK_THEME_GROUPS).find((g) => PICK_THEME_GROUPS[g].includes(theme)) || null;

/** Whether n players fit a game's players (8 means "8 or more": its max is 8 or more), and how far off the closest end it is */
export function playersFit(players, n) {
  if (n >= 8) return players.max >= 8 && players.min <= 8 ? 0 : players.max < 8 ? 8 - players.max : players.min - 8;
  return n < players.min ? players.min - n : n > players.max ? n - players.max : 0;
}
const bestAt = (players, n) => (n >= 8 ? players.best.some((b) => b >= 8) : players.best.includes(n));

/** The time rule (2.2): short → min ≤ 35; medium → min ≤ 70 and max ≥ 25; long → min ≤ 135 and max ≥ 45; epic → max ≥ 90 */
export function timeFits(time, bucket) {
  if (bucket === 'short') return time.min <= 35;
  if (bucket === 'medium') return time.min <= 70 && time.max >= 25;
  if (bucket === 'long') return time.min <= 135 && time.max >= 45;
  if (bucket === 'epic') return time.max >= 90;
  return true;
}

/** A game's nudges, for breaking ties and the wildcard */
const nudgeCount = (g) => (g.staffPick ? 1 : 0) + (g.underplayed ? 1 : 0) + (g.isNew ? 1 : 0);
/** Ranking order: score, then the nudges (staff pick, underplayed, new), then title */
const byRank = (a, b) => b.score - a.score || Number(b.game.staffPick) - Number(a.game.staffPick) || Number(b.game.underplayed) - Number(a.game.underplayed)
  || Number(b.game.isNew) - Number(a.game.isNew) || a.game.title.localeCompare(b.game.title, 'en') || a.game.productId.localeCompare(b.game.productId);

/**
 * One game's score for these answers (2.3, or 2.10 in the roleplaying branch), with its reasons (2.8), each with the
 * points it brought (strength). The nudges aren't points: Mo's rule (16 Oct) is that they only break ties and fill the
 * wildcard. ctx: { likes, nopes, loves, tasteLikes, tasteDowns: [{ productId, title, facts }], myUps: Set, ratings: Map
 * productId → { ups, downs } }.
 */
export function scoreGame(g, ask, ctx) {
  const f = g.facts;
  let score = 0;
  const reasons = [];
  const add = (points, reason = null) => {
    score += points;
    if (reason && points > 0) reasons.push({ ...reason, strength: points });
  };
  const said = (reason, strength) => reasons.push({ ...reason, strength });
  const bestOf = (list) => {
    let top = null;
    for (const item of list) {
      const s = item.productId && item.productId === g.productId ? 1 : similarity(f, item.facts);
      if (!top || s > top.s) top = { s, item };
    }
    return top;
  };
  if (ask.mode === 'rpg') {
    const r = ask.rpg;
    const n = r.players;
    if (playersFit(f.players, n) === 0) said(bestAt(f.players, n) ? { code: 'best-at', n } : { code: 'players', n }, 1);
    if (r.setting !== 'any' && f.rpg?.setting === r.setting) add(15, { code: 'theme', group: themeGroupOf(r.setting) || r.setting });
    const type = f.rpg?.type;
    if (r.tried === 'never') {
      if (f.rpg?.starter) add(20);
      add({ starter: 12, core: 8, adventure: -5, supplement: -15, setting: -10 }[type] || 0);
    } else if (r.tried === 'some') {
      add({ core: 8, adventure: 6, starter: 4 }[type] || 0);
    } else if (r.tried === 'lots') {
      add({ adventure: 8, supplement: 4, setting: 4 }[type] || 0);
    }
    return { score: Math.round(score * 1000) / 1000, reasons };
  }
  const n = ask.players;
  if (playersFit(f.players, n) === 0) add(bestAt(f.players, n) ? 12 : 4, bestAt(f.players, n) ? { code: 'best-at', n } : { code: 'players', n });
  if (ask.time) {
    const [lo, hi] = TIME_BUCKETS[ask.time];
    if (f.time.min >= lo && f.time.max <= hi) add(10, { code: 'time', min: f.time.min, max: f.time.max });
    else if (f.time.min <= hi && f.time.max >= lo) add(4, { code: 'time', min: f.time.min, max: f.time.max });
  }
  if (ask.brain) {
    const [lo, hi] = BRAINS[ask.brain];
    const outside = f.weight < lo ? lo - f.weight : f.weight > hi ? f.weight - hi : 0;
    if (outside < 1e-9) add(15, { code: 'brain', value: ask.brain });
    else add(-6 * (outside / 0.5));
  }
  if (ask.team === 'coop') {
    if (f.mode === 'coop') add(15, { code: 'coop' });
    else if (f.mode === 'team') add(4, { code: 'team' });
    else if (f.mode === 'competitive') add(-15);
  } else if (ask.team === 'competitive') {
    if (f.mode === 'competitive') add(8, { code: 'competitive' });
    else if (f.mode === 'team') add(8, { code: 'team' });
    else if (f.mode === 'coop') add(-10);
  }
  let vibePoints = 0;
  for (const vibe of ask.vibes) {
    if (f.vibes.includes(vibe) && vibePoints < 16) {
      vibePoints += 8;
      add(8, { code: 'vibe', vibe });
    }
  }
  if (ask.vibes.includes('chill') && f.vibes.includes('cutthroat')) add(-8);
  if (ask.vibes.includes('cutthroat') && f.vibes.includes('chill')) add(-4);
  // a reason "like <title>" only for a game alike enough, and never a game named after itself
  const likeReason = (top) => (top.s >= 0.5 && top.item.productId !== g.productId ? { code: 'like', title: top.item.title } : null);
  const liked = bestOf(ctx.likes);
  if (liked) add(20 * liked.s + (liked.item.productId === g.productId ? 10 : 0), likeReason(liked));
  const noped = bestOf(ctx.nopes);
  if (noped) add(-12 * noped.s);
  const loved = bestOf(ctx.loves);
  if (loved) add(20 * loved.s, likeReason(loved));
  if (ask.filters.themes.length) {
    const group = ask.filters.themes.find((key) => PICK_THEME_GROUPS[key].some((t) => f.themes.includes(t)));
    add(group ? 20 : -10, group ? { code: 'theme', group } : null);
  }
  for (const key of ['colourBlind', 'easyPieces']) {
    if (ask.filters[key]) add(f.access[key] === true ? 6 : f.access[key] === false ? -20 : 0);
  }
  const fond = bestOf(ctx.tasteLikes);
  if (fond) add(10 * fond.s, likeReason(fond));
  const disliked = bestOf(ctx.tasteDowns);
  if (disliked) add(-8 * disliked.s);
  if (ctx.myUps.has(g.productId)) add(5);
  const rated = ctx.ratings.get(g.productId);
  if (rated) add(6 * ((rated.ups - rated.downs) / (rated.ups + rated.downs + 3)));
  if (rated && rated.ups >= 3) said({ code: 'rated', ups: rated.ups }, 6);
  if (ask.kids) {
    const family = ask.youngest <= 7 && shelfParts(g.shelfCode)?.section === 'DGLF';
    if (family) add(5);
    said({ code: 'kids', age: f.age }, family ? 5 : 2);
  }
  if (ask.mode === 'borrow' && g.inStoreOnly) add(-10);
  return { score: Math.round(score * 1000) / 1000, reasons };
}

/** Up to 3 reasons, strongest first (the order they came in breaks ties), without their points */
const topReasons = (reasons, room = 3) => reasons
  .map((r, i) => ({ r, i }))
  .sort((a, b) => b.r.strength - a.r.strength || a.i - b.i)
  .slice(0, room)
  .map(({ r }) => {
    const { strength, ...rest } = r;
    return rest;
  });

/** The wildcard's own reason: staff pick, new arrival or underplayed (in that order), else a stretch */
export const wildcardReason = (g) => ({ code: g.staffPick ? 'staff-pick' : g.isNew ? 'new' : g.underplayed ? 'underplayed' : 'stretch' });

/**
 * The player type (2.9): each vibe asked +2 to its type, coop +3 to team, competitive +1 to competitor, and each liked
 * swipe +1 to the types its styles point to and +1 to adventurer for an adventure theme. Highest wins; ties go team, party, thinker,
 * competitor, adventurer, chill. The roleplaying branch is always adventurer.
 */
export function playerTypeOf(ask, likedFacts = []) {
  if (ask.mode === 'rpg') return 'adventurer';
  const points = Object.fromEntries(PICK_PLAYER_TYPES.map((t) => [t, 0]));
  const vibeType = { laughs: 'party', thinky: 'thinker', cutthroat: 'competitor', chill: 'chill' };
  for (const vibe of ask.vibes) points[vibeType[vibe]] += 2;
  if (ask.team === 'coop') points.team += 3;
  if (ask.team === 'competitive') points.competitor += 1;
  // each liked swipe: +1 to each type its styles point to, and +1 to adventurer when it has an adventure theme
  for (const facts of likedFacts) {
    for (const [type, list] of Object.entries(TYPE_STYLES)) if ((facts.styles || []).some((style) => list.includes(style))) points[type] += 1;
    if ((facts.themes || []).some((theme) => ADVENTURE_THEMES.includes(theme))) points.adventurer += 1;
  }
  return PICK_PLAYER_TYPES.reduce((best, t) => (points[t] > points[best] ? t : best), PICK_PLAYER_TYPES[0]);
}

/** A whole number from a text (FNV-1a), for seeding the wildcard */
const hashText = (text) => {
  let h = 0x811c9dc5;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};
/** A number 0 to 1 from a seed (mulberry32's first draw) */
const seeded = (seed) => {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/**
 * Which of `count` wildcards to take: a number seeded by the session id and how many times it's asked for different
 * picks (round), so the same session and round always give the same one (a page refresh asks again with the same
 * round) and each "Show me different picks" a new draw.
 */
export const wildcardIndex = (sessionId, round, count) => (count > 0 ? Math.floor(seeded(hashText(`${sessionId}#${Math.max(0, round)}`)) * count) : -1);

/**
 * Pick three and a wildcard (2.2 to 2.7) from `games` (each { productId, title, facts, staffPick, isNew, underplayed,
 * inStoreOnly, shelfCode }). ctx adds to scoreGame's: available(g) (play mode: a copy free for them), had(g) (borrowed
 * by them before), down (Set: their thumbs down), member (logged in), sessionId and round (seed the wildcard), demote
 * ([Set]: what to put last for "Show me different picks"; the first that leaves 3 others is used). Returns { picks:
 * [{ game, score, why }], wildcard, fitCount, relaxed, candidates, demoted (the ids put last) }.
 */
export function matchGames(games, ask, ctx) {
  const rpgMode = ask.mode === 'rpg';
  const n = rpgMode ? ask.rpg.players : ask.players;
  const order = rpgMode ? ['players'] : ['time', 'filters', 'availability', 'players'];
  const active = {
    time: !rpgMode && Boolean(ask.time),
    filters: !rpgMode && (ask.filters.lightReading || (ask.filters.hideHad && ctx.member)),
    availability: !rpgMode && ask.mode === 'play',
    players: true,
  };
  const checked = [];
  for (const g of games) {
    const f = g.facts;
    if (f.kind !== (rpgMode ? 'rpg' : 'game')) continue;
    if (ctx.down.has(g.productId) || ask.swipes[g.productId] === 'nope') continue;
    if (!rpgMode && ask.kids && f.age > ask.youngest) continue;
    const fails = new Set();
    const distance = playersFit(f.players, n);
    if (distance > 0) fails.add('players');
    if (active.time && !timeFits(f.time, ask.time)) fails.add('time');
    if (active.filters && ((ask.filters.lightReading && f.reading !== 'light') || (ask.filters.hideHad && ctx.member && ctx.had(g)))) fails.add('filters');
    if (active.availability && !ctx.available(g)) fails.add('availability');
    checked.push({ g, fails, distance });
  }
  const passing = (loose, cutoff = Infinity) => checked.filter((c) => [...c.fails].every((rule) => loose.has(rule)) && (!c.fails.has('players') || c.distance <= cutoff));
  let candidates = passing(new Set());
  const fitCount = candidates.length;
  const loose = new Set();
  for (const rule of order) {
    if (candidates.length >= 4) break;
    if (!active[rule]) continue;
    loose.add(rule);
    let cutoff = Infinity;
    if (rule === 'players') {
      const distances = passing(loose).map((c) => c.distance).sort((a, b) => a - b);
      if (distances.length >= 4) cutoff = distances[3];
    }
    candidates = passing(loose, cutoff);
  }
  const relaxed = order.filter((rule) => loose.has(rule) && candidates.some((c) => c.fails.has(rule)));
  let ranked = candidates.map((c) => ({ game: c.g, ...scoreGame(c.g, ask, ctx) })).sort(byRank);
  // "Show me different picks": what this session has shown already goes to the back, while 3 others are left (the
  // first set that leaves 3: everything shown so far, else the last picks)
  let demoted = new Set();
  for (const demote of ctx.demote || []) {
    if (demote.size && ranked.filter((r) => !demote.has(r.game.productId)).length >= 3) {
      ranked = [...ranked.filter((r) => !demote.has(r.game.productId)), ...ranked.filter((r) => demote.has(r.game.productId))];
      demoted = demote;
      break;
    }
  }
  const sameSeries = (a, b) => {
    const key = pickSeries(a.title);
    return Boolean(key) && key === pickSeries(b.title);
  };
  const tooClose = (r, chosen) => chosen.some((p) => similarity(r.game.facts, p.game.facts) > 0.85 || sameSeries(r.game, p.game));
  const picks = [];
  const left = [...ranked];
  while (picks.length < 3 && left.length) {
    let take = -1;
    for (let i = 0; i < left.length; i += 1) {
      const r = left[i];
      if (!tooClose(r, picks)) {
        take = i;
        break;
      }
      // left is best first, so the others within 85% of its score are the run after it
      const floor = r.score - 0.15 * Math.abs(r.score);
      let other = false;
      for (let j = i + 1; j < left.length && left[j].score >= floor; j += 1) {
        if (!tooClose(left[j], picks)) {
          other = true;
          break;
        }
      }
      if (!other) {
        take = i;
        break;
      }
    }
    if (take < 0) take = 0;
    picks.push(left.splice(take, 1)[0]);
  }
  let wildcard = null;
  if (ranked.length >= 4) {
    // the candidates ranked 4th to 30th, those unlike every pick; nudged ones first (most nudges first), then by score;
    // one of the first five, chosen by the session's own seeded number (none: the 4th best)
    const rest = left.slice(0, 27);
    const eligible = rest.filter((r) => picks.every((p) => similarity(r.game.facts, p.game.facts) < 0.6));
    const nudged = eligible.filter((r) => nudgeCount(r.game) > 0).sort((a, b) => nudgeCount(b.game) - nudgeCount(a.game) || byRank(a, b));
    const pool = [...nudged, ...eligible.filter((r) => nudgeCount(r.game) === 0)];
    const fresh = pool.filter((r) => !demoted.has(r.game.productId));
    const shortlist = (fresh.length ? fresh : pool).slice(0, 5);
    wildcard = shortlist.length ? shortlist[wildcardIndex(ctx.sessionId || '', ctx.round || 0, shortlist.length)] : rest[0] || null;
  }
  return {
    picks: picks.map((r) => ({ game: r.game, score: r.score, why: topReasons(r.reasons) })),
    wildcard: wildcard ? { game: wildcard.game, score: wildcard.score, why: [wildcardReason(wildcard.game), ...topReasons(wildcard.reasons, 2)] } : null,
    fitCount,
    relaxed,
    candidates: ranked.length,
    demoted: [...demoted],
  };
}

/**
 * Up to 8 games for the swipe round (3.2), as different as possible: the best known first (high confidence, then a
 * picture), then each next one the game least like those already chosen (spread over vibes, themes, styles and
 * weight), better known games winning near ties.
 */
export function swipeChoices(games, count = 8) {
  const known = (g) => ({ high: 2, medium: 1, low: 0 }[g.facts.confidence] || 0) + (g.image ? 1 : 0);
  const pool = [...games].sort((a, b) => known(b) - known(a) || a.title.localeCompare(b.title, 'en') || a.productId.localeCompare(b.productId));
  const chosen = [];
  while (chosen.length < count && pool.length) {
    let best = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const nearest = chosen.length ? Math.max(...chosen.map((c) => similarity(c.facts, pool[i].facts))) : 0;
      const value = (1 - nearest) + 0.05 * known(pool[i]);
      if (value > bestValue + 1e-9) {
        bestValue = value;
        best = i;
      }
    }
    chosen.push(pool.splice(best, 1)[0]);
  }
  return chosen;
}

/* ---------------- the tables (made when missing as the Lair starts: lair.js's migrate) ---------------- */
/**
 * Round 17's tables and indexes, made on every start when they're missing (as round 16's wishlist is), so they never wait
 * on a step in MIGRATIONS. Beyond the contract's columns: pick_catalog.description (the listing's text, for Workers AI)
 * and shop_copy (the shop copy staff linked, custom.shop_copy, as JSON); pick_sessions.round (how many times "Show me
 * different picks" was asked: it seeds the wildcard), shown (every game it has shown, for the report), hide (the games
 * this round puts last, so asking again without again: true gives the same picks) and why (each pick's reasons, so a
 * shared link reads as it did).
 */
export const PICK_TABLES = [
  `CREATE TABLE IF NOT EXISTS pick_catalog (
    product_id TEXT PRIMARY KEY, variant_id TEXT, handle TEXT, raw_title TEXT, title TEXT NOT NULL, image TEXT, shelf_code TEXT, copies INTEGER,
    in_store_only INTEGER NOT NULL DEFAULT 0, missing_pieces INTEGER NOT NULL DEFAULT 0, missing_note TEXT, tags TEXT NOT NULL DEFAULT '[]',
    players_text TEXT, time_text TEXT, difficulty TEXT, blurb TEXT, video TEXT, vendor TEXT, description TEXT, shop_copy TEXT,
    created_at_shopify INTEGER, updated_at_shopify INTEGER, status TEXT NOT NULL DEFAULT 'active', seen_at INTEGER, synced_at INTEGER)`,
  'CREATE INDEX IF NOT EXISTS pick_catalog_variant ON pick_catalog (variant_id)',
  `CREATE TABLE IF NOT EXISTS pick_shop (
    product_id TEXT PRIMARY KEY, handle TEXT, title TEXT, norm TEXT, price INTEGER, available INTEGER NOT NULL DEFAULT 0, image TEXT, seen_at INTEGER,
    synced_at INTEGER)`,
  'CREATE INDEX IF NOT EXISTS pick_shop_norm ON pick_shop (norm)',
  `CREATE TABLE IF NOT EXISTS pick_facts (
    product_id TEXT PRIMARY KEY, facts TEXT NOT NULL, source TEXT NOT NULL, checked INTEGER NOT NULL DEFAULT 0, checked_by TEXT, checked_at INTEGER,
    staff_pick INTEGER NOT NULL DEFAULT 0, seed_version TEXT, ai_tries INTEGER NOT NULL DEFAULT 0, ai_error TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS pick_sessions (
    id TEXT PRIMARY KEY, edit_key TEXT NOT NULL, customer_id TEXT, saved INTEGER NOT NULL DEFAULT 0, door TEXT, mode TEXT, table_code TEXT,
    booking_id TEXT, answers TEXT, picks TEXT NOT NULL DEFAULT '[]', wildcard TEXT, player_type TEXT, fit_count INTEGER NOT NULL DEFAULT 0,
    relaxed TEXT NOT NULL DEFAULT '[]', requests INTEGER NOT NULL DEFAULT 1, emails INTEGER NOT NULL DEFAULT 0, round INTEGER NOT NULL DEFAULT 0,
    shown TEXT NOT NULL DEFAULT '[]', hide TEXT NOT NULL DEFAULT '[]', why TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL,
    updated_at INTEGER)`,
  'CREATE INDEX IF NOT EXISTS pick_sessions_customer ON pick_sessions (customer_id, saved, created_at)',
  'CREATE INDEX IF NOT EXISTS pick_sessions_created ON pick_sessions (created_at)',
  'CREATE TABLE IF NOT EXISTS pick_events (session_id TEXT NOT NULL, product_id TEXT, action TEXT NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS pick_events_session ON pick_events (session_id)',
  'CREATE INDEX IF NOT EXISTS pick_events_created ON pick_events (created_at)',
  `CREATE TABLE IF NOT EXISTS pick_taste (
    customer_id TEXT PRIMARY KEY, likes TEXT NOT NULL DEFAULT '[]', nopes TEXT NOT NULL DEFAULT '[]', answers TEXT, player_type TEXT, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS game_ratings (
    customer_id TEXT NOT NULL, product_id TEXT NOT NULL, rating INTEGER NOT NULL, source TEXT, created_at INTEGER NOT NULL, updated_at INTEGER,
    PRIMARY KEY (customer_id, product_id))`,
  'CREATE INDEX IF NOT EXISTS game_ratings_product ON game_ratings (product_id)',
];

/** Session ids and edit keys: letters and digits with no look-alikes (no 0 O o 1 I i l L) */
const KEY_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
/** `length` characters from crypto.getRandomValues, each byte taken only below a multiple of the alphabet (no bias) */
export function pickKey(length) {
  const limit = 256 - (256 % KEY_CHARS.length);
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out += KEY_CHARS[byte % KEY_CHARS.length];
    }
  }
  return out;
}

export const pickMethods = {
  /* ---------------- the seed (section 1.2, 1) ---------------- */
  /**
   * Apply the seed once per version, as the Lair starts: when meta 'pick-seed' is older than the seed's version, a
   * product with no facts gets the seed's (source 'seed'), and a row nobody has touched (not checked, source seed,
   * basic or auto) takes the new facts. A row a person has checked or edited (checked = 1, or source 'staff') is never
   * overwritten. A seed entry that fails validFacts is skipped. One pass, no awaits. Returns { version, added, updated,
   * kept, skipped }, or null when it had nothing to do.
   */
  applyPickSeed(now = Date.now()) {
    const version = String(PICK_DATA.seedVersion ?? '');
    const stored = this.sql.exec("SELECT value FROM meta WHERE key = 'pick-seed'").toArray()[0]?.value ?? null;
    if (stored !== null && !(stored < version)) return null;
    const out = { version, added: 0, updated: 0, kept: 0, skipped: 0 };
    for (const [key, raw] of Object.entries(PICK_DATA.seed || {})) {
      const productId = pickProductId(key);
      const checked = productId ? validFacts(raw) : { ok: false };
      if (!checked.ok) {
        out.skipped += 1;
        continue;
      }
      const facts = JSON.stringify(checked.facts);
      const row = this.sql.exec('SELECT source, checked FROM pick_facts WHERE product_id = ?', productId).toArray()[0];
      if (!row) {
        this.sql.exec(
          `INSERT INTO pick_facts (product_id, facts, source, checked, staff_pick, seed_version, ai_tries, created_at, updated_at)
           VALUES (?, ?, 'seed', 0, 0, ?, 0, ?, ?)`,
          productId, facts, version, now, now,
        );
        out.added += 1;
      } else if (row.checked || row.source === 'staff') {
        out.kept += 1;
      } else {
        this.sql.exec(
          "UPDATE pick_facts SET facts = ?, source = 'seed', seed_version = ?, ai_error = NULL, updated_at = ? WHERE product_id = ? AND checked = 0 AND source != 'staff'",
          facts, version, now, productId,
        );
        out.updated += 1;
      }
    }
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('pick-seed', ?)", version);
    this.pickCache = null;
    return out;
  },

  /* ---------------- the games the quiz knows ---------------- */
  /**
   * Every catalogue row with facts, as games: { productId, variantId, handle, title, image, shelfCode, copies (the
   * catalogue's, or null), inStoreOnly, missingPieces, missingNote, blurb, video, status, facts, source, checked,
   * staffPick, createdAt, shopCopy (the linked one, or null) }. Kept until the catalogue or facts change. No awaits.
   */
  pickGames() {
    if (this.pickCache) return this.pickCache;
    const rows = this.sql.exec(
      `SELECT c.product_id, c.variant_id, c.handle, c.title, c.image, c.shelf_code, c.copies, c.in_store_only, c.missing_pieces, c.missing_note, c.blurb,
         c.video, c.status, c.created_at_shopify, c.shop_copy, f.facts AS facts_json, f.source AS facts_source, f.checked AS facts_checked, f.checked_by,
         f.checked_at, f.staff_pick
       FROM pick_catalog c JOIN pick_facts f ON f.product_id = c.product_id ORDER BY c.title, c.product_id`,
    ).toArray();
    const games = [];
    for (const r of rows) {
      const facts = parseJson(r.facts_json, null);
      if (!isObject(facts) || !facts.players || !facts.time) continue;
      games.push({
        productId: r.product_id, variantId: r.variant_id || null, handle: r.handle || '', title: r.title, image: r.image || null, shelfCode: r.shelf_code || '',
        copies: r.copies ?? null, inStoreOnly: Boolean(r.in_store_only), missingPieces: Boolean(r.missing_pieces), missingNote: r.missing_note || '',
        blurb: r.blurb || null, video: r.video || null, status: r.status, facts, source: r.facts_source, checked: Boolean(r.facts_checked),
        checkedBy: r.checked_by || null, checkedAt: r.checked_at || null, staffPick: Boolean(r.staff_pick), createdAt: r.created_at_shopify || null,
        shopCopy: parseJson(r.shop_copy, null),
      });
    }
    this.pickCache = { games, byId: new Map(games.map((g) => [g.productId, g])) };
    return this.pickCache;
  },

  /** An active library game with facts by its product id (pickGames), or null. No awaits. */
  pickGameRow(productId) {
    const g = this.pickGames().byId.get(String(productId ?? ''));
    return g && g.status === 'active' ? g : null;
  },

  /**
   * For src/queue.js (section 5, the other half of round 17): an active library game with facts, or null. copies: the
   * catalogue's, else what a library page last sent, else 1 (the rules libraryStatus uses). No awaits.
   * → { productId, variantId, title, handle, image, shelfCode, copies, inStoreOnly, kind, table, status }
   */
  pickGame(productId) {
    const g = this.pickGameRow(pickProductId(productId));
    if (!g) return null;
    return {
      productId: g.productId, variantId: g.variantId, title: g.title, handle: g.handle, image: g.image, shelfCode: g.shelfCode,
      copies: this.pickCopies(g), inStoreOnly: g.inStoreOnly, kind: g.facts.kind, table: g.facts.table, status: g.status,
    };
  },

  /**
   * A game's copies: the catalogue's, else what a library page last sent (pages: pickPageCopies, else it's looked up),
   * else 1. No awaits.
   */
  pickCopies(g, pages = null) {
    if (g.copies != null) return g.copies;
    if (!g.variantId) return 1;
    return (pages ? pages.get(g.variantId) : this.pageCopies(g.variantId)) ?? 1;
  },

  /** The copies library pages last sent with a hold, for every variant at once (pageCopies for all). No awaits. */
  pickPageCopies() {
    const out = new Map();
    for (const r of this.sql.exec('SELECT variant_id, copies FROM library_holds WHERE copies IS NOT NULL ORDER BY created_at DESC').toArray()) {
      if (!out.has(r.variant_id)) out.set(r.variant_id, r.copies);
    }
    return out;
  },

  /**
   * Each game's nudges now: isNew (on Shopify in the last 60 days) and underplayed (on Shopify 30 days or more, and no
   * hold or loan in the last 90: none made, out, back or still at home in that time). No awaits.
   */
  pickNudges(games, now = Date.now()) {
    const since = now - 90 * DAY;
    const busy = new Set();
    for (const r of this.sql.exec('SELECT DISTINCT variant_id, product_id FROM library_holds WHERE created_at >= ? OR until >= ?', since, since).toArray()) {
      busy.add(`v:${r.variant_id}`);
      if (r.product_id) busy.add(`p:${r.product_id}`);
    }
    for (const r of this.sql.exec("SELECT DISTINCT variant_id, product_id FROM library_loans WHERE out_at >= ? OR returned_at >= ? OR status = 'out'", since, since).toArray()) {
      busy.add(`v:${r.variant_id}`);
      if (r.product_id) busy.add(`p:${r.product_id}`);
    }
    for (const g of games) {
      const age = g.createdAt ? now - g.createdAt : null;
      g.isNew = age != null && age <= 60 * DAY;
      g.underplayed = age != null && age >= 30 * DAY && !busy.has(`p:${g.productId}`) && !(g.variantId && busy.has(`v:${g.variantId}`));
    }
    return games;
  },

  /**
   * Where each game stands now, by product id: libraryStatus's shape { copies, available, held, out, nextFree, mine,
   * atHome } (mine and atHome for the logged-in member). Booking holds (src/queue.js) are library holds, so they count.
   * No awaits.
   */
  pickAvailability(games, who, now = Date.now()) {
    // Every active hold and every game at home, read whole (two queries for any number of games: SQLite in a Durable
    // Object takes at most 100 bound values a query, so no IN list of 680 variants), then grouped by variant
    const wanted = new Set(games.map((g) => g.variantId).filter(Boolean));
    const held = new Map();
    for (const r of this.sql.exec("SELECT * FROM library_holds WHERE status = 'held' AND until > ? ORDER BY until, created_at", now).toArray()) {
      if (!wanted.has(r.variant_id)) continue;
      if (!held.has(r.variant_id)) held.set(r.variant_id, []);
      held.get(r.variant_id).push(this.rowToHold(r));
    }
    const loans = new Map();
    for (const r of this.sql.exec("SELECT * FROM library_loans WHERE status = 'out' ORDER BY out_at, created_at").toArray()) {
      if (!wanted.has(r.variant_id)) continue;
      if (!loans.has(r.variant_id)) loans.set(r.variant_id, []);
      loans.get(r.variant_id).push(this.rowToLoan(r));
    }
    const me = who?.customerId ? String(who.customerId) : null;
    const pages = this.pickPageCopies();
    const out = new Map();
    for (const g of games) {
      const holds = (g.variantId && held.get(g.variantId)) || [];
      const home = (g.variantId && loans.get(g.variantId)) || [];
      const copies = this.pickCopies(g, pages);
      const available = Math.max(0, copies - holds.length - home.length);
      const mine = me ? holds.find((h) => h.customerId === me) : null;
      const atHome = me ? home.find((l) => l.customerId === me) : null;
      out.set(g.productId, {
        copies, available, held: holds.length, out: home.length, nextFree: !available && holds.length ? holds[0].until : null,
        mine: mine ? { id: mine.id, until: mine.until } : null, atHome: atHome ? { id: atHome.id, outAt: atHome.outAt } : null,
      });
    }
    return out;
  },

  /**
   * The booking door's window (2.5): a booking's start and end, or a whole Lair day for context.date, else null. No awaits.
   */
  pickWindow(context) {
    if (context?.bookingId) {
      const b = this.booking(context.bookingId);
      if (b && b.start && b.end) return { start: b.start, end: b.end };
    }
    if (context?.date) {
      const time = lairTime(this.rulesCache?.tz || 'Pacific/Auckland');
      return { start: time.at(context.date, 0), end: time.at(addDays(context.date, 1), 0) };
    }
    return null;
  },

  /**
   * Whether each game has a copy free for them to play (2.5), as a function of a game. Now: available ≥ 1. The booking
   * door (a booking or a date) also keeps a copy for another booking that has the game in that window
   * (src/queue.js's bookedGamesOverlapping, a Set of product ids; a missing method is an empty Set): one already held
   * for a booking is counted in held, so only a booking whose hold isn't made yet takes one more. The booking's own game
   * isn't another booking's. No awaits.
   */
  pickPlayable(status, context, games = []) {
    const window = this.pickWindow(context);
    let booked = new Set();
    if (window) {
      try {
        booked = new Set(this.bookedGamesOverlapping?.(window.start, window.end) || []);
      } catch (error) {
        console.error('Lair: booked games could not be read', error);
        booked = new Set();
      }
      const own = context.bookingId ? this.sql.exec('SELECT * FROM bookings WHERE id = ? OR ref = ?', context.bookingId, context.bookingId).toArray()[0] : null;
      if (own?.game_product_id) booked.delete(String(own.game_product_id));
    }
    const pending = new Set();
    if (booked.size) {
      const now = Date.now();
      for (const g of games) {
        if (!booked.has(g.productId) || !g.variantId) continue;
        const holds = this.sql.exec("SELECT * FROM library_holds WHERE variant_id = ? AND status = 'held' AND until > ?", g.variantId, now).toArray();
        if (!holds.some((h) => h.kind === 'booking')) pending.add(g.productId);
      }
    }
    return (g) => {
      const s = status.get(g.productId);
      if (!s || s.available < 1) return false;
      return !pending.has(g.productId) || s.available >= 2;
    };
  },

  /** A game's shop copy for "Buy your own copy": the one staff linked when it's on sale and in stock, else (no link) the title match. No awaits. */
  pickShopCopy(g) {
    const link = g.shopCopy;
    if (link?.productId) {
      const row = this.sql.exec('SELECT * FROM pick_shop WHERE product_id = ?', link.productId).toArray()[0];
      const copy = row ? { handle: row.handle, title: row.title, price: row.price, available: Boolean(row.available) } : link;
      return copy.available && copy.handle ? { handle: copy.handle, title: copy.title, price: copy.price ?? null } : null;
    }
    const norm = pickNorm(g.title);
    const row = norm ? this.sql.exec('SELECT * FROM pick_shop WHERE norm = ? AND available = 1 ORDER BY price, product_id LIMIT 1', norm).toArray()[0] : null;
    return row ? { handle: row.handle, title: row.title, price: row.price ?? null } : null;
  },

  /**
   * A game as the quiz shows it (3.3). why: its reasons, or undefined to leave the field out (GET /pick/game). status
   * and games: from pickAvailability and pickGames. No awaits.
   */
  pickCard(g, status, games, why = undefined) {
    const f = g.facts;
    const parts = shelfParts(g.shelfCode);
    const addOns = games
      .filter((x) => x.status === 'active' && x.facts.kind === 'expansion' && x.facts.expansionOf === g.productId)
      .map((x) => ({ productId: x.productId, title: x.title, handle: x.handle, available: status.get(x.productId)?.available ?? 0 }));
    return {
      productId: g.productId, variantId: g.variantId, handle: g.handle, title: g.title, image: g.image, summary: f.summary, blurb: g.blurb,
      shelfCode: g.shelfCode || null, shelf: parts ? { section: parts.section, size: parts.size, number: parts.number } : null,
      players: f.players, time: f.time, weight: f.weight, brain: brainOf(f.weight), age: f.age, mode: f.mode, vibes: f.vibes, themes: f.themes,
      reading: f.reading, access: f.access, table: f.table, video: g.video, inStoreOnly: g.inStoreOnly, missingPieces: g.missingPieces,
      missingNote: g.missingNote || '', availability: status.get(g.productId) || null, staffPick: g.staffPick, isNew: Boolean(g.isNew),
      underplayed: Boolean(g.underplayed), addOns, shopCopy: this.pickShopCopy(g), ...(why === undefined ? {} : { why }), rpg: f.rpg,
    };
  },

  /** Cards for these games (and their add-ons), worked out now. why: productId → reasons. No awaits. */
  pickCards(list, who, whyOf = null) {
    const { games } = this.pickGames();
    const addOnGames = games.filter((x) => x.status === 'active' && x.facts.kind === 'expansion' && list.some((g) => x.facts.expansionOf === g.productId));
    const now = Date.now();
    this.pickNudges(list, now);
    const status = this.pickAvailability([...list, ...addOnGames], who, now);
    return list.map((g) => this.pickCard(g, status, games, whyOf ? whyOf(g) || [] : undefined));
  },

  /* ---------------- the quiz (section 3) ---------------- */
  /**
   * The quiz's rate limit (3): 60 requests a connection (X-Lair-Client) in 10 minutes, across POST /pick, /pick/swipes,
   * GET /pick/known and /pick/game, then 429 busy. Staff aren't limited. Kept in memory, like the Lair's other soft
   * limits. No awaits.
   */
  pickRate(who, client, now = Date.now()) {
    if (who?.staff || !client) return;
    this.pickHits = this.pickHits || new Map();
    const hits = (this.pickHits.get(client) || []).filter((t) => now - t < 10 * MIN);
    if (hits.length >= PICK_LIMITS.quizPer10Min) throw new RuleError(PICK_MESSAGES.busy, 429);
    hits.push(now);
    if (this.pickHits.size > 2000) this.pickHits.clear();
    this.pickHits.set(client, hits);
  },

  /** A pick_sessions row by id (exactly 10 key characters), or null. No awaits. */
  pickSessionRow(id) {
    const text = String(id ?? '');
    if (!/^[A-Za-z0-9]{10}$/.test(text)) return null;
    return this.sql.exec('SELECT * FROM pick_sessions WHERE id = ?', text).toArray()[0] || null;
  },

  /** Whether the edit key sent is this session's (compared in constant time) */
  pickKeyMatches(row, key) {
    return typeof key === 'string' && safeEqual(key, row.edit_key);
  },

  /**
   * What the matcher needs about this person (no awaits): their thumbs up and down, the games they've borrowed, their
   * saved taste, and the members' ratings of every game.
   */
  pickPerson(who) {
    const me = who?.customerId ? String(who.customerId) : null;
    const ratings = new Map();
    for (const r of this.sql.exec('SELECT product_id, SUM(rating = 1) AS ups, SUM(rating = -1) AS downs FROM game_ratings GROUP BY product_id').toArray()) {
      ratings.set(r.product_id, { ups: Number(r.ups) || 0, downs: Number(r.downs) || 0 });
    }
    const mine = me ? this.sql.exec('SELECT product_id, rating FROM game_ratings WHERE customer_id = ?', me).toArray() : [];
    const had = new Set();
    if (me) {
      for (const r of this.sql.exec('SELECT variant_id, product_id FROM library_loans WHERE customer_id = ?', me).toArray()) {
        had.add(`v:${r.variant_id}`);
        if (r.product_id) had.add(`p:${r.product_id}`);
      }
    }
    const taste = me ? this.sql.exec('SELECT * FROM pick_taste WHERE customer_id = ?', me).toArray()[0] || null : null;
    return {
      me, ratings, had, taste,
      ups: new Set(mine.filter((r) => r.rating === 1).map((r) => r.product_id)),
      downs: new Set(mine.filter((r) => r.rating === -1).map((r) => r.product_id)),
    };
  },

  /**
   * Match these answers for this person (no awaits): the games, their nudges and where they stand, the matching
   * context, and matchGames' answer. session: { id, round, demote } for the wildcard and "Show me different picks".
   */
  pickMatch(answers, context, who, session) {
    const now = Date.now();
    const { games, byId } = this.pickGames();
    const live = this.pickNudges(games.filter((g) => g.status === 'active'), now);
    const person = this.pickPerson(who);
    const status = this.pickAvailability(live, who, now);
    const named = (id) => {
      const g = byId.get(id);
      return g ? { productId: g.productId, title: g.title, facts: g.facts } : null;
    };
    const known = (title) => {
      const key = pickNorm(title);
      const k = (PICK_DATA.known || []).find((x) => pickNorm(x.title) === key || (x.aliases || []).some((a) => pickNorm(a) === key));
      return k ? { productId: null, title: k.title, facts: k } : null;
    };
    const likes = Object.entries(answers.swipes).filter(([, v]) => v === 'like').map(([id]) => named(id)).filter(Boolean);
    const nopes = Object.entries(answers.swipes).filter(([, v]) => v === 'nope').map(([id]) => named(id)).filter(Boolean);
    const loves = answers.filters.loves.map((l) => (l.productId ? named(l.productId) : known(l.known))).filter(Boolean);
    let tasteLikes = [];
    let tasteDowns = [];
    if (answers.useTaste && person.me) {
      // their saved likes and thumbs up count as likes at half weight (the score table's taste row: +10, not +20)
      tasteLikes = uniq([...parseJson(person.taste?.likes, []), ...person.ups]).map(named).filter(Boolean);
      tasteDowns = [...person.downs].map(named).filter(Boolean);
    }
    const ctx = {
      likes, nopes, loves, tasteLikes, tasteDowns, myUps: person.ups, ratings: person.ratings, down: person.downs, member: Boolean(person.me),
      had: (g) => person.had.has(`p:${g.productId}`) || Boolean(g.variantId && person.had.has(`v:${g.variantId}`)),
      available: this.pickPlayable(status, context, live), sessionId: session.id, round: session.round, demote: session.demote,
    };
    const result = matchGames(live, answers, ctx);
    return { ...result, likes, status, games };
  },

  /**
   * POST /pick (anyone, 3.1): the picks for these answers. With the session's id and edit key it's that session asked
   * again (a fine-tune, or "Show me different picks" with again: true); otherwise a new session. A logged-in member's
   * taste is saved. → { session: { id, editKey }, mode, picks, wildcard, playerType, fitCount, relaxed, answers }.
   */
  async pick(body, who, client) {
    this.pickRate(who, client);
    await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const { answers, context } = cleanAnswers(body);
    let row = body?.sessionId ? this.pickSessionRow(body.sessionId) : null;
    if (row && !this.pickKeyMatches(row, body?.editKey)) row = null;
    const again = Boolean(row) && body?.again === true;
    const id = row ? row.id : pickKey(10);
    const editKey = row ? row.edit_key : pickKey(20);
    const round = row ? row.round + (again ? 1 : 0) : 0;
    const shown = new Set(row ? parseJson(row.shown, []) : []);
    const lastPicks = row ? parseJson(row.picks, []) : [];
    // "Show me different picks" puts what this session has shown last; asking again with the same answers (a refresh)
    // keeps that, and a fine-tune (new answers) starts from the best again
    const sameAnswers = Boolean(row) && row.answers === JSON.stringify(answers);
    const demote = again ? [shown, new Set([...lastPicks, row.wildcard].filter(Boolean))] : sameAnswers ? [new Set(parseJson(row.hide, []))] : [];
    const result = this.pickMatch(answers, context, who, { id, round, demote });
    const pickIds = result.picks.map((p) => p.game.productId);
    const wildcardId = result.wildcard?.game.productId || null;
    for (const pid of [...pickIds, wildcardId].filter(Boolean)) shown.add(pid);
    const playerType = playerTypeOf(answers, result.likes.map((l) => l.facts));
    const why = Object.fromEntries([...result.picks, ...(result.wildcard ? [result.wildcard] : [])].map((p) => [p.game.productId, p.why]));
    const me = who?.customerId ? String(who.customerId) : null;
    if (row) {
      this.sql.exec(
        `UPDATE pick_sessions SET customer_id = COALESCE(customer_id, ?), door = COALESCE(?, door), mode = ?, table_code = COALESCE(?, table_code),
           booking_id = COALESCE(?, booking_id), answers = ?, picks = ?, wildcard = ?, player_type = ?, fit_count = ?, relaxed = ?, requests = requests + 1,
           round = ?, shown = ?, hide = ?, why = ?, updated_at = ? WHERE id = ?`,
        me, context.door, answers.mode, context.table, context.bookingId, JSON.stringify(answers), JSON.stringify(pickIds), wildcardId, playerType,
        result.fitCount, JSON.stringify(result.relaxed), round, JSON.stringify([...shown]), JSON.stringify(result.demoted), JSON.stringify(why), now, id,
      );
    } else {
      this.sql.exec(
        `INSERT INTO pick_sessions (id, edit_key, customer_id, saved, door, mode, table_code, booking_id, answers, picks, wildcard, player_type, fit_count,
           relaxed, requests, emails, round, shown, hide, why, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, '[]', ?, ?, ?)`,
        id, editKey, me, context.door, answers.mode, context.table, context.bookingId, JSON.stringify(answers), JSON.stringify(pickIds), wildcardId,
        playerType, result.fitCount, JSON.stringify(result.relaxed), JSON.stringify([...shown]), JSON.stringify(why), now, now,
      );
    }
    if (me) this.savePickTaste(me, answers, playerType, now);
    const list = [...result.picks.map((p) => p.game), ...(result.wildcard ? [result.wildcard.game] : [])];
    const cards = this.pickCards(list, who, (g) => why[g.productId]);
    return {
      session: { id, editKey }, mode: answers.mode, picks: cards.slice(0, result.picks.length), wildcard: result.wildcard ? cards[cards.length - 1] : null,
      playerType, fitCount: result.fitCount, relaxed: result.relaxed, answers,
    };
  },

  /**
   * A logged-in member's taste (2.4), saved on every POST /pick: their swipes' likes and nopes (the newest last, 50 of
   * each at most; a game moves from one list to the other when they change their mind), their last core answers and
   * player type. No awaits.
   */
  savePickTaste(customerId, answers, playerType, now) {
    const row = this.sql.exec('SELECT * FROM pick_taste WHERE customer_id = ?', customerId).toArray()[0];
    let likes = parseJson(row?.likes, []);
    let nopes = parseJson(row?.nopes, []);
    for (const [id, value] of Object.entries(answers.swipes)) {
      if (value === 'like') {
        likes = [...likes.filter((x) => x !== id), id];
        nopes = nopes.filter((x) => x !== id);
      } else if (value === 'nope') {
        nopes = [...nopes.filter((x) => x !== id), id];
        likes = likes.filter((x) => x !== id);
      }
    }
    const core = { mode: answers.mode, players: answers.players, kids: answers.kids, youngest: answers.youngest, time: answers.time, brain: answers.brain, team: answers.team, vibes: answers.vibes };
    this.sql.exec(
      `INSERT INTO pick_taste (customer_id, likes, nopes, answers, player_type, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(customer_id) DO UPDATE SET likes = excluded.likes, nopes = excluded.nopes, answers = excluded.answers, player_type = excluded.player_type,
         updated_at = excluded.updated_at`,
      customerId, JSON.stringify(likes.slice(-PICK_LIMITS.tasteKept)), JSON.stringify(nopes.slice(-PICK_LIMITS.tasteKept)), JSON.stringify(core), playerType, now,
    );
  },

  /**
   * POST /pick/swipes (anyone, 3.2): up to 8 games for the swipe round that pass the hard rules for these answers (kind,
   * players, time, age, availability in play mode), as different as possible, never one they rated down. → { candidates:
   * [{ productId, title, image, summary, players, time, weight }] }.
   */
  async pickSwipes(body, who, client) {
    this.pickRate(who, client);
    await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const { answers, context } = cleanAnswers(isObject(body) ? { ...body, filters: {}, swipes: {}, vibes: [] } : {});
    const live = this.pickGames().games.filter((g) => g.status === 'active');
    const person = this.pickPerson(who);
    const status = answers.mode === 'play' ? this.pickAvailability(live, who, now) : null;
    const playable = status ? this.pickPlayable(status, context, live) : () => true;
    const rpg = answers.mode === 'rpg';
    const n = rpg ? answers.rpg.players : answers.players;
    const pass = live.filter((g) => {
      const f = g.facts;
      if (f.kind !== (rpg ? 'rpg' : 'game') || person.downs.has(g.productId) || playersFit(f.players, n) > 0) return false;
      if (!rpg && answers.kids && f.age > answers.youngest) return false;
      if (!rpg && answers.time && !timeFits(f.time, answers.time)) return false;
      return !status || playable(g);
    });
    return {
      candidates: swipeChoices(pass, 8).map((g) => ({ productId: g.productId, title: g.title, image: g.image, summary: g.facts.summary, players: g.facts.players, time: g.facts.time, weight: g.facts.weight })),
    };
  },

  /**
   * GET /pick/:id (anyone, 3.4): a shared session, read only, with where each game stands worked out now. → { session:
   * { id }, mode, picks, wildcard, playerType, answers, createdAt }. A game no longer in the library is left out. 404
   * gone when there's no such session.
   */
  async sharedPicks(id, who) {
    await this.rules();
    // --- no awaits from here on ---
    const row = this.pickSessionRow(id);
    if (!row) throw new RuleError(PICK_MESSAGES.gone, 404);
    const { picks, wildcard } = this.sharedPicksNow(row, who);
    return { session: { id: row.id }, mode: row.mode, picks, wildcard, playerType: row.player_type, answers: parseJson(row.answers, null), createdAt: row.created_at };
  },

  /**
   * GET /pick/known?q= (anyone, 3.5): "Games you already love". q is 2 to 60 characters (else no games). Up to 8: library
   * games (kind game or rpg) then famous games, whose title (or a famous game's alias) starts with or contains q, case
   * and accents ignored, starts-with first, no title twice. → { games: [{ key, title, productId | null }] }.
   */
  async pickKnown(url, who, client) {
    this.pickRate(who, client);
    const q = String(url.searchParams.get('q') ?? '').trim();
    if (q.length < 2 || q.length > 60) return { games: [] };
    const key = pickNorm(q);
    if (!key) return { games: [] };
    const rank = (names) => {
      let best = 0;
      for (const name of names) {
        const n = pickNorm(name);
        if (n.startsWith(key)) return 2;
        if (n.includes(key)) best = 1;
      }
      return best;
    };
    const library = this.pickGames().games
      .filter((g) => g.status === 'active' && ['game', 'rpg'].includes(g.facts.kind))
      .map((g) => ({ r: rank([g.title]), item: { key: g.productId, title: g.title, productId: g.productId } }))
      .filter((x) => x.r > 0);
    const famous = (PICK_DATA.known || [])
      .filter((k) => typeof k?.title === 'string' && k.title.trim())
      .map((k) => ({ r: rank([k.title, ...(Array.isArray(k.aliases) ? k.aliases : [])]), item: { key: `known:${k.title}`, title: k.title, productId: null } }))
      .filter((x) => x.r > 0);
    const order = (a, b) => b.r - a.r || a.item.title.localeCompare(b.item.title, 'en');
    const out = [];
    const titles = new Set();
    for (const x of [...library.sort(order), ...famous.sort(order)]) {
      const t = pickNorm(x.item.title);
      if (titles.has(t)) continue;
      titles.add(t);
      out.push(x.item);
      if (out.length >= 8) break;
    }
    return { games: out };
  },

  /** GET /pick/game/:productId (anyone, 3.6): one active library game as a card, without why. 404 game when it isn't one. */
  async pickGameCard(productId, who, client) {
    this.pickRate(who, client);
    await this.rules();
    // --- no awaits from here on ---
    const g = this.pickGameRow(pickProductId(decodeURIComponent(productId || '')));
    if (!g) throw new RuleError(PICK_MESSAGES.game, 404);
    return { game: this.pickCards([g], who)[0] };
  },

  /**
   * POST /pick/:id/event { action, productId? } (anyone, 3.7): pick tracking. Unknown actions, unknown sessions and a
   * session's 51st event on are ignored, and the answer is { ok: true } whatever happens. No awaits.
   */
  pickEvent(id, body) {
    const row = this.pickSessionRow(id);
    const action = String(body?.action ?? '');
    if (!row || !PICK_ACTIONS.includes(action)) return { ok: true };
    const count = this.sql.exec('SELECT COUNT(*) AS n FROM pick_events WHERE session_id = ?', row.id).one().n;
    if (count >= PICK_LIMITS.eventsPerSession) return { ok: true };
    this.sql.exec('INSERT INTO pick_events (session_id, product_id, action, created_at) VALUES (?, ?, ?, ?)', row.id, pickProductId(body?.productId), action, Date.now());
    return { ok: true };
  },

  /**
   * POST /pick/:id/save { editKey } (logged in, 3.8): keep the session on their account (My Lair's saved picks). → { ok,
   * saved (their last 5, as GET /me/picks has them) }. 401 login, 404 gone, 403 notYours (a wrong edit key, or a
   * session another member has made theirs). No awaits.
   */
  savePicks(id, body, who) {
    if (!who?.customerId) throw new RuleError(PICK_MESSAGES.login, 401);
    const me = String(who.customerId);
    const row = this.pickSessionRow(id);
    if (!row) throw new RuleError(PICK_MESSAGES.gone, 404);
    if (!this.pickKeyMatches(row, body?.editKey) || (row.customer_id && row.customer_id !== me)) throw new RuleError(PICK_MESSAGES.notYours, 403);
    this.sql.exec('UPDATE pick_sessions SET customer_id = ?, saved = 1, updated_at = ? WHERE id = ?', me, Date.now(), row.id);
    return { ok: true, saved: this.savedPicks(me) };
  },

  /**
   * POST /pick/:id/email { email, editKey } (anyone, 3.9): email the picks to that address. At most 3 a session and 10
   * an hour a connection (429 busy); 404 gone, 403 notYours, 422 email. → { ok: true }. The newsletter tick is the
   * theme's (Shopify's own form), never the Lair's.
   */
  async emailPicks(id, body, who, client) {
    // (the rules give the email's footer and links)
    await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const row = this.pickSessionRow(id);
    if (!row) throw new RuleError(PICK_MESSAGES.gone, 404);
    if (!this.pickKeyMatches(row, body?.editKey)) throw new RuleError(PICK_MESSAGES.notYours, 403);
    const to = String(body?.email ?? '').trim();
    if (!isEmail(to) || to.length > 200) throw new RuleError(PICK_MESSAGES.email);
    if (row.emails >= PICK_LIMITS.emailsPerSession) throw new RuleError(PICK_MESSAGES.busy, 429);
    if (!who?.staff && client) {
      this.pickMails = this.pickMails || new Map();
      const sent = (this.pickMails.get(client) || []).filter((t) => now - t < HOUR);
      if (sent.length >= PICK_LIMITS.emailsPerHour) throw new RuleError(PICK_MESSAGES.busy, 429);
      if (this.pickMails.size > 2000) this.pickMails.clear();
      this.pickMails.set(client, [...sent, now]);
    }
    this.sql.exec('UPDATE pick_sessions SET emails = emails + 1, updated_at = ? WHERE id = ?', now, row.id);
    const shared = this.sharedPicksNow(row, who);
    if (emailReady(this.env)) this.later(this.mail(this.letter(to, 'Your game picks from Dice Goblin', this.picksLetter(shared))));
    return { ok: true };
  },

  /** sharedPicks without the rules wait (the caller has them). No awaits. */
  sharedPicksNow(row, who) {
    const why = parseJson(row.why, {});
    const ids = parseJson(row.picks, []);
    const games = [...ids, row.wildcard].filter(Boolean).map((pid) => this.pickGameRow(pid)).filter(Boolean);
    const cards = this.pickCards(games, who, (g) => why[g.productId]);
    const byId = new Map(cards.map((c) => [c.productId, c]));
    return { id: row.id, picks: ids.map((pid) => byId.get(pid)).filter(Boolean), wildcard: (row.wildcard && byId.get(row.wildcard)) || null };
  },

  /**
   * The "Your picks" email (3.9, section 8): each pick (and the wildcard) with its picture, players, time and the reason
   * line's facts in plain words, a link to its page, "See them again" (the shared link), and "Book a table" and "Join
   * the library". No awaits.
   */
  picksLetter(shared) {
    const all = [...shared.picks, ...(shared.wildcard ? [{ ...shared.wildcard, wild: true }] : [])];
    const games = all.map((c) => ({
      title: c.wild ? `${c.title} (wildcard)` : c.title,
      image: c.image,
      url: c.handle ? this.link(`/products/${c.handle}`) : null,
      lines: [
        [playersWords(c.players), timeWords(c.time), c.age ? `ages ${c.age}+` : ''].filter(Boolean).join(' · '),
        reasonWords(c.why || []),
      ].filter(Boolean),
    }));
    return {
      title: 'Your game picks',
      intro: ['Kia ora! Here are the games Gobgob picked for you from the Dice Goblin library.'],
      cards: games,
      button: { label: 'See them again', url: `${this.link('/pages/help-me-pick')}?p=${encodeURIComponent(shared.id)}` },
      links: [{ label: 'Book a table', url: this.page('book') }, { label: 'Join the library', url: this.link('/pages/board-game-rental') }],
      outro: all.length ? 'Play them at the Lair, or borrow them with a library membership.' : 'Nothing in the library fits those answers right now. Take the quiz again for fresh picks.',
    };
  },

  /* ---------------- ratings and a member's picks (section 4) ---------------- */
  /**
   * POST /library/rate { productId, rating: 'up' | 'down' | null, source? } (logged in): a thumbs up or down for a
   * library game in the catalogue (null takes it off). source: 'return', 'page' or 'pick' ('page' otherwise). Any other
   * rating changes nothing. → { ok: true, productId, rating } (what it is now). 401 loginRate; 422 product. No awaits.
   */
  rateGame(body, who) {
    if (!who?.customerId) throw new RuleError(PICK_MESSAGES.loginRate, 401);
    const me = String(who.customerId);
    const productId = pickProductId(body?.productId);
    const known = productId ? this.sql.exec('SELECT 1 AS here FROM pick_catalog WHERE product_id = ?', productId).toArray().length > 0 : false;
    if (!known) throw new RuleError(PICK_MESSAGES.product);
    const now = Date.now();
    const value = body?.rating === 'up' ? 1 : body?.rating === 'down' ? -1 : body?.rating == null ? 0 : null;
    const source = ['return', 'page', 'pick'].includes(body?.source) ? body.source : 'page';
    if (value === 0) {
      this.sql.exec('DELETE FROM game_ratings WHERE customer_id = ? AND product_id = ?', me, productId);
    } else if (value) {
      this.sql.exec(
        `INSERT INTO game_ratings (customer_id, product_id, rating, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(customer_id, product_id) DO UPDATE SET rating = excluded.rating, source = excluded.source, updated_at = excluded.updated_at`,
        me, productId, value, source, now, now,
      );
    }
    const row = this.sql.exec('SELECT rating FROM game_ratings WHERE customer_id = ? AND product_id = ?', me, productId).toArray()[0];
    return { ok: true, productId, rating: row ? (row.rating === 1 ? 'up' : 'down') : null };
  },

  /** A member's last 5 saved picks, newest first: [{ id, createdAt, playerType, picks: [{ productId, title, handle, image }] }]. No awaits. */
  savedPicks(customerId) {
    const rows = this.sql.exec(
      'SELECT * FROM pick_sessions WHERE customer_id = ? AND saved = 1 ORDER BY created_at DESC, rowid DESC LIMIT ?',
      String(customerId), PICK_LIMITS.savedShown,
    ).toArray();
    const lookup = (pid) => this.sql.exec('SELECT product_id, title, handle, image FROM pick_catalog WHERE product_id = ?', pid).toArray()[0];
    return rows.map((r) => ({
      id: r.id, createdAt: r.created_at, playerType: r.player_type || null,
      picks: parseJson(r.picks, []).map(lookup).filter(Boolean).map((c) => ({ productId: c.product_id, title: c.title, handle: c.handle || '', image: c.image || null })),
    }));
  },

  /**
   * GET /me/picks (logged in): { saved (savedPicks), taste: { has } (3 or more games liked in the quiz or rated), toRate
   * (their games back on the shelf in the last 30 days that they haven't rated, newest first, 5 at most), ratings: {
   * [productId]: 'up' | 'down' } }. 401 login. No awaits.
   */
  myPicks(who) {
    if (!who?.customerId) throw new RuleError(PICK_MESSAGES.login, 401);
    const me = String(who.customerId);
    const now = Date.now();
    const ratings = {};
    for (const r of this.sql.exec('SELECT product_id, rating FROM game_ratings WHERE customer_id = ? ORDER BY updated_at DESC', me).toArray()) {
      ratings[r.product_id] = r.rating === 1 ? 'up' : 'down';
    }
    const taste = this.sql.exec('SELECT likes FROM pick_taste WHERE customer_id = ?', me).toArray()[0];
    const has = new Set([...parseJson(taste?.likes, []), ...Object.keys(ratings)]).size >= 3;
    const toRate = [];
    const seen = new Set();
    const loans = this.sql.exec(
      "SELECT * FROM library_loans WHERE customer_id = ? AND status = 'returned' AND returned_at >= ? ORDER BY returned_at DESC, rowid DESC",
      me, now - PICK_LIMITS.toRateDays * DAY,
    ).toArray();
    for (const l of loans) {
      if (toRate.length >= PICK_LIMITS.toRateShown) break;
      const c = (l.product_id && this.sql.exec('SELECT * FROM pick_catalog WHERE product_id = ?', l.product_id).toArray()[0])
        || this.sql.exec('SELECT * FROM pick_catalog WHERE variant_id = ?', l.variant_id).toArray()[0] || null;
      const productId = c?.product_id || l.product_id || null;
      if (!productId || seen.has(productId) || ratings[productId]) continue;
      seen.add(productId);
      toRate.push({ loanId: l.id, productId, title: c?.title || l.title, handle: c?.handle || l.handle || '', image: l.image || c?.image || null, returnedAt: l.returned_at });
    }
    return { saved: this.savedPicks(me), taste: { has }, toRate, ratings };
  },

  /* ---------------- staff: checking games (section 6) ---------------- */
  /**
   * A game as the staff check page shows it. checkedBy: who checked it, by first name, from their member record (the
   * Lair keeps their customer ID in checked_by), or null when that isn't known; the page says "Checked by Mo". names:
   * customer ID → name, shared across one answer's games. No awaits.
   */
  staffPickView(g, names = new Map()) {
    let checkedBy = null;
    if (g.checkedBy) {
      if (!names.has(g.checkedBy)) {
        const m = this.memberRow(g.checkedBy);
        names.set(g.checkedBy, m?.first_name || String(m?.name || '').trim().split(/\s+/)[0] || null);
      }
      checkedBy = names.get(g.checkedBy);
    }
    return {
      productId: g.productId, title: g.title, handle: g.handle, image: g.image, shelfCode: g.shelfCode || null, facts: g.facts, source: g.source,
      checked: g.checked, checkedBy, checkedAt: g.checkedAt, staffPick: g.staffPick, status: g.status,
    };
  },

  /**
   * GET /pick/games?filter=check|low|auto|basic|staff-picks|all&q=&offset=&limit= (perm library): { games, total }.
   * check: active games not checked yet, low confidence first, then auto, basic, seed. low: low confidence; auto,
   * basic: by where the facts came from (low, auto and basic: only those not checked yet); staff-picks; all (gone
   * games too). q: in the title or shelf code. limit 1 to
   * 100 (50). No awaits.
   */
  staffPickGames(url, who) {
    this.requireStaff(who, 'library');
    const filter = ['check', 'low', 'auto', 'basic', 'staff-picks', 'all'].includes(url.searchParams.get('filter')) ? url.searchParams.get('filter') : 'check';
    const q = pickNorm(url.searchParams.get('q') || '');
    const code = String(url.searchParams.get('q') || '').trim().toUpperCase();
    const offset = wholeIn(url.searchParams.get('offset'), 0, 100000) ?? 0;
    const limit = wholeIn(url.searchParams.get('limit'), 1, 100) ?? 50;
    let list = this.pickGames().games.filter((g) => filter === 'all' || g.status === 'active');
    if (filter === 'check') list = list.filter((g) => !g.checked);
    // low, auto and basic are work lists: a game staff have checked has left them (its confidence stays the tagger's)
    if (filter === 'low') list = list.filter((g) => !g.checked && g.facts.confidence === 'low');
    if (filter === 'auto' || filter === 'basic') list = list.filter((g) => !g.checked && g.source === filter);
    if (filter === 'staff-picks') list = list.filter((g) => g.staffPick);
    if (q || code) list = list.filter((g) => (q && pickNorm(g.title).includes(q)) || (code && g.shelfCode.toUpperCase().includes(code)));
    if (filter === 'check') {
      // low confidence first, then by where the facts came from (auto, basic, seed), then by title
      const low = (g) => (g.facts.confidence === 'low' ? 0 : 1);
      const source = { auto: 0, basic: 1, seed: 2, staff: 3 };
      list = [...list].sort((a, b) => low(a) - low(b) || (source[a.source] ?? 4) - (source[b.source] ?? 4) || a.title.localeCompare(b.title, 'en'));
    }
    const names = new Map();
    return { games: list.slice(offset, offset + limit).map((g) => this.staffPickView(g, names)), total: list.length };
  },

  /**
   * POST /pick/games/:productId { facts?, checked?, staffPick? } (perm library): change a game's facts (checked with
   * validFacts: 422 "…: <field>"), mark it checked ("Looks right") or not, or make it a staff pick. Facts saved mark it
   * checked, with who and when (unless checked: false is sent too); they make it source 'staff' only when they changed.
   * → { game }. 422 product for a game that isn't in the catalogue. No awaits.
   */
  staffPickEdit(productId, body, who) {
    this.requireStaff(who, 'library');
    const id = pickProductId(decodeURIComponent(productId || ''));
    const row = id ? this.sql.exec('SELECT * FROM pick_catalog WHERE product_id = ?', id).toArray()[0] : null;
    if (!row) throw new RuleError(PICK_MESSAGES.product);
    const now = Date.now();
    const by = who.customerId ? String(who.customerId) : 'staff';
    let current = this.sql.exec('SELECT * FROM pick_facts WHERE product_id = ?', id).toArray()[0] || null;
    let next = null;
    if (body?.facts !== undefined) {
      const checked = validFacts(body.facts);
      if (!checked.ok) throw new RuleError(factsMessage(checked.field));
      next = checked.facts;
    }
    if (!current) {
      const basic = next || validFacts(basicFacts(row), { clamp: true }).facts;
      this.sql.exec(
        "INSERT INTO pick_facts (product_id, facts, source, checked, staff_pick, ai_tries, created_at, updated_at) VALUES (?, ?, 'basic', 0, 0, 0, ?, ?)",
        id, JSON.stringify(basic), now, now,
      );
      current = this.sql.exec('SELECT * FROM pick_facts WHERE product_id = ?', id).one();
    }
    if (next && JSON.stringify(next) !== current.facts) {
      this.sql.exec("UPDATE pick_facts SET facts = ?, source = 'staff', checked = 1, checked_by = ?, checked_at = ?, updated_at = ? WHERE product_id = ?", JSON.stringify(next), by, now, now, id);
    } else if (next && body?.checked !== false) {
      this.sql.exec('UPDATE pick_facts SET checked = 1, checked_by = ?, checked_at = ?, updated_at = ? WHERE product_id = ?', by, now, now, id);
    }
    if (body?.checked === true) this.sql.exec('UPDATE pick_facts SET checked = 1, checked_by = ?, checked_at = ?, updated_at = ? WHERE product_id = ?', by, now, now, id);
    if (body?.checked === false) this.sql.exec('UPDATE pick_facts SET checked = 0, checked_by = NULL, checked_at = NULL, updated_at = ? WHERE product_id = ?', now, id);
    if (typeof body?.staffPick === 'boolean') this.sql.exec('UPDATE pick_facts SET staff_pick = ?, updated_at = ? WHERE product_id = ?', body.staffPick ? 1 : 0, now, id);
    this.pickCache = null;
    return { game: this.staffPickView(this.pickGames().byId.get(id)) };
  },

  /* ---------------- the catalogue from Shopify (1.1) ---------------- */
  /**
   * Sync the catalogue with Shopify (syncCatalog). full: read every library listing (marking rows not seen as gone) and
   * every shop copy; it runs on the first maintenance after the Lair starts, then every 6 hours, and when staff press
   * "Sync with Shopify now". Otherwise an update: only listings changed since the last sync less 5 minutes. Skipped while
   * Shopify isn't configured, read_products isn't granted or Shopify is backing off (the copies back-off). Never throws: errors go
   * to note({ catalogError }). Then basic facts for new games. Returns { synced, added, gone, shop, basic, kind }, or
   * { skipped } when it didn't run.
   */
  async syncCatalog({ full = null, now = Date.now() } = {}) {
    if (!this.shopify.configured) return { skipped: 'shopify' };
    // the scopes the store granted, once the health check has read them: no read_products (or write_products), no sync
    const scopes = this.grantedScopes;
    if (Array.isArray(scopes) && !scopes.includes('read_products') && !scopes.includes('write_products')) return { skipped: 'scope' };
    if (now < (this.retryAt.get('copies') || 0)) return { skipped: 'waiting' };
    const lastFull = Number(this.sql.exec("SELECT value FROM meta WHERE key = 'pick-catalog-full'").toArray()[0]?.value) || 0;
    const lastSync = Number(this.sql.exec("SELECT value FROM meta WHERE key = 'pick-catalog-sync'").toArray()[0]?.value) || 0;
    const isFull = full ?? (!this.pickFullDone || !lastFull || now - lastFull >= PICK_LIMITS.fullSyncHours * HOUR);
    let library;
    let shop = null;
    try {
      const since = new Date(Math.max(0, lastSync - 5 * MIN)).toISOString().replace(/\.\d{3}Z$/, 'Z');
      library = await this.shopify.pickCatalogPages(isFull || !lastSync ? PICK_LIBRARY_QUERY : `${PICK_LIBRARY_QUERY} AND updated_at:>'${since}'`);
      if (isFull) shop = await this.shopify.pickShopPages(PICK_SHOP_QUERY);
    } catch (error) {
      this.backoff('copies');
      this.note({ catalogError: { message: String(error?.message || error).slice(0, 300), at: new Date().toISOString() } });
      return { skipped: 'error' };
    }
    // --- no awaits from here on ---
    const stamp = Date.now();
    const result = this.saveCatalog(library, shop, { full: isFull || !lastSync, now: stamp });
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('pick-catalog-sync', ?)", String(stamp));
    if (isFull || !lastSync) {
      this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('pick-catalog-full', ?)", String(stamp));
      this.pickFullDone = true;
    }
    return { ...result, kind: isFull || !lastSync ? 'full' : 'update' };
  },

  /**
   * Save what Shopify gave (no awaits): each listing's row (new ones added, the rest updated, a gone one active again),
   * on a full sync the active rows not seen marked gone and the shop copies replaced, then basic facts for any game with
   * none. Returns { synced, added, gone, shop, basic }.
   */
  saveCatalog(nodes, shopNodes, { full, now }) {
    let added = 0;
    const seen = new Set();
    for (const node of nodes || []) {
      if (!node?.id) continue;
      const c = catalogRowOf(node, now);
      if (!/^\d{1,20}$/.test(c.productId) || seen.has(c.productId)) continue;
      seen.add(c.productId);
      const had = this.sql.exec('SELECT 1 AS here FROM pick_catalog WHERE product_id = ?', c.productId).toArray().length > 0;
      if (!had) added += 1;
      this.sql.exec(
        `INSERT INTO pick_catalog (product_id, variant_id, handle, raw_title, title, image, shelf_code, copies, in_store_only, missing_pieces, missing_note, tags,
           players_text, time_text, difficulty, blurb, video, vendor, description, shop_copy, created_at_shopify, updated_at_shopify, status, seen_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET variant_id = excluded.variant_id, handle = excluded.handle, raw_title = excluded.raw_title, title = excluded.title,
           image = excluded.image, shelf_code = excluded.shelf_code, copies = excluded.copies, in_store_only = excluded.in_store_only,
           missing_pieces = excluded.missing_pieces, missing_note = excluded.missing_note, tags = excluded.tags, players_text = excluded.players_text,
           time_text = excluded.time_text, difficulty = excluded.difficulty, blurb = excluded.blurb, video = excluded.video, vendor = excluded.vendor,
           description = excluded.description, shop_copy = excluded.shop_copy, created_at_shopify = excluded.created_at_shopify,
           updated_at_shopify = excluded.updated_at_shopify, status = 'active', seen_at = excluded.seen_at, synced_at = excluded.synced_at`,
        c.productId, c.variantId, c.handle, c.rawTitle, c.title, c.image, c.shelfCode, c.copies, c.inStoreOnly, c.missingPieces, c.missingNote,
        JSON.stringify(c.tags), c.playersText, c.timeText, c.difficulty, c.blurb, c.video, c.vendor, c.description, c.shopCopy ? JSON.stringify(c.shopCopy) : null,
        c.createdAt, c.updatedAt, now, now,
      );
    }
    let gone = 0;
    if (full) {
      for (const r of this.sql.exec("SELECT product_id FROM pick_catalog WHERE status = 'active'").toArray()) {
        if (seen.has(r.product_id)) continue;
        this.sql.exec("UPDATE pick_catalog SET status = 'gone', synced_at = ? WHERE product_id = ?", now, r.product_id);
        gone += 1;
      }
    }
    let shop = null;
    if (shopNodes) {
      this.sql.exec('DELETE FROM pick_shop');
      shop = 0;
      for (const node of shopNodes) {
        if (!node?.id) continue;
        const s = shopRowOf(node);
        if (!/^\d{1,20}$/.test(s.productId)) continue;
        this.sql.exec(
          `INSERT OR REPLACE INTO pick_shop (product_id, handle, title, norm, price, available, image, seen_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          s.productId, s.handle, s.title, s.norm, s.price, s.available, s.image, now, now,
        );
        shop += 1;
      }
    }
    this.pickCache = null;
    const basic = this.fillBasicFacts(now);
    return { synced: seen.size, added, gone, shop, basic };
  },

  /**
   * Basic facts (1.2, 2) for every catalogue game with none: made from its listing, checked with validFacts (clamped),
   * source 'basic', not checked. No awaits. Returns how many were made.
   */
  fillBasicFacts(now = Date.now()) {
    const rows = this.sql.exec('SELECT c.* FROM pick_catalog c LEFT JOIN pick_facts f ON f.product_id = c.product_id WHERE f.product_id IS NULL').toArray();
    let made = 0;
    for (const row of rows) {
      const checked = validFacts(basicFacts(row), { clamp: true });
      if (!checked.ok) continue;
      this.sql.exec(
        "INSERT OR IGNORE INTO pick_facts (product_id, facts, source, checked, staff_pick, ai_tries, created_at, updated_at) VALUES (?, ?, 'basic', 0, 0, 0, ?, ?)",
        row.product_id, JSON.stringify(checked.facts), now, now,
      );
      made += 1;
    }
    if (made) this.pickCache = null;
    return made;
  },

  /**
   * Auto facts (1.2, 3): up to 5 games whose facts are still 'basic' with fewer than 3 tries, oldest first, are sent to
   * Workers AI with their listing; an answer that passes validFacts (clamped: numbers into range, unknown words
   * dropped) becomes their facts, source 'auto', confidence as given but never high, not checked. A failure adds a try
   * and keeps the error; the basic facts stay. Skipped with no AI binding or PICK_AI = 'off'. Never throws. Returns {
   * tagged, failed } or { skipped }.
   */
  async autoTag({ limit = PICK_LIMITS.autoTagPerRun } = {}) {
    if (!this.env?.AI?.run) return { skipped: 'no-ai' };
    if (String(this.env.PICK_AI ?? '').trim().toLowerCase() === 'off') return { skipped: 'off' };
    const model = String(this.env.PICK_AI_MODEL || '').trim() || PICK_AI_MODEL;
    const rows = this.sql.exec(
      `SELECT c.*, f.facts AS facts_json FROM pick_facts f JOIN pick_catalog c ON c.product_id = f.product_id
       WHERE f.source = 'basic' AND f.ai_tries < ? AND c.status = 'active' ORDER BY f.created_at, f.product_id LIMIT ?`,
      PICK_LIMITS.aiTries, limit,
    ).toArray();
    let tagged = 0;
    let failed = 0;
    for (const row of rows) {
      let facts = null;
      let error = null;
      try {
        const answer = await this.env.AI.run(model, {
          messages: [{ role: 'system', content: PICK_AI_RULES }, { role: 'user', content: JSON.stringify(aiListing(row)) }],
          response_format: { type: 'json_schema', json_schema: { name: 'game_facts', schema: PICK_AI_SCHEMA, strict: true } },
          chat_template_kwargs: { enable_thinking: false },
          max_tokens: 1200,
          temperature: 0.2,
        });
        const raw = aiAnswerObject(answer);
        const checked = validFacts({ ...raw, expansionOf: null }, { clamp: true });
        if (!checked.ok) throw new Error(`Workers AI's answer didn't fit: ${checked.field}.`);
        facts = checked.facts;
        if (facts.confidence === 'high') facts.confidence = 'medium';
        if (facts.kind === 'expansion' && typeof raw.expansionOfTitle === 'string') facts.expansionOf = this.pickBaseGame(raw.expansionOfTitle, row);
      } catch (e) {
        error = String(e?.message || e).slice(0, 300);
      }
      // --- no awaits between reading the row again and saving: a person may have changed it meanwhile ---
      const now = Date.now();
      const current = this.sql.exec('SELECT source, checked FROM pick_facts WHERE product_id = ?', row.product_id).toArray()[0];
      if (!current || current.source !== 'basic' || current.checked) continue;
      if (facts) {
        this.sql.exec("UPDATE pick_facts SET facts = ?, source = 'auto', ai_error = NULL, updated_at = ? WHERE product_id = ? AND source = 'basic' AND checked = 0", JSON.stringify(facts), now, row.product_id);
        tagged += 1;
      } else {
        this.sql.exec('UPDATE pick_facts SET ai_tries = ai_tries + 1, ai_error = ?, updated_at = ? WHERE product_id = ?', error, now, row.product_id);
        failed += 1;
      }
    }
    if (tagged || failed) this.pickCache = null;
    if (failed) this.note({ pickAiError: { failed, at: new Date().toISOString() } });
    return { tagged, failed };
  },

  /** An expansion's base game from Workers AI's title: the library game (not an expansion) with that title, else the longest title the expansion's own title starts with, else null. No awaits. */
  pickBaseGame(title, row) {
    const want = pickNorm(title);
    const own = pickNorm(row.title);
    const bases = this.pickGames().games.filter((g) => g.facts.kind !== 'expansion' && g.productId !== row.product_id);
    const exact = bases.find((g) => pickNorm(g.title) === want);
    if (exact) return exact.productId;
    const starts = bases.filter((g) => {
      const t = pickNorm(g.title);
      return t && (own.startsWith(`${t} `) || want.startsWith(`${t} `));
    }).sort((a, b) => pickNorm(b.title).length - pickNorm(a.title).length);
    return starts[0]?.productId || null;
  },

  /**
   * POST /pick/sync (perm library): a full sync now, then up to 5 auto-tags. → { synced, added, gone, tagged }. Shopify
   * not answering is a 503 with what it said.
   */
  async staffPickSync(who) {
    this.requireStaff(who, 'library');
    this.retryAt.delete('copies');
    const result = await this.syncCatalog({ full: true });
    if (result.skipped) throw new RuleError(result.skipped === 'shopify' ? "Shopify isn't connected yet, so there's nothing to sync." : "Shopify didn't answer just now. Try again in a minute.", 503);
    const tags = await this.autoTag();
    return { synced: result.synced, added: result.added, gone: result.gone, tagged: tags.tagged || 0 };
  },

  /* ---------------- staff: the demand report (section 6) ---------------- */
  /**
   * GET /pick/report?days=7|30|90 (perm library or community): what people asked for and what they did, over sessions
   * made in the last `days` (30 otherwise). asks: the core answers grouped (players, time, brain, team, vibes), with how
   * many asked, the median fitCount and the gap (median under 5); picked: the games shown most (each session counts a
   * game once) and how many sessions acted on each; acted: the games acted on most (each action counts: actions), in
   * picked's shape too (shown, acted), so the page can show either list the same way; neverPicked: active games (and
   * RPG books) no session in the window showed; relaxed: how many sessions had to loosen each rule. No awaits.
   */
  pickReport(url, who) {
    this.requireStaff(who, ['library', 'community']);
    const days = [7, 30, 90].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 30;
    const to = Date.now();
    const from = to - days * DAY;
    const sessions = this.sql.exec('SELECT * FROM pick_sessions WHERE created_at >= ? AND created_at <= ? ORDER BY created_at', from, to).toArray();
    const events = this.sql.exec('SELECT e.* FROM pick_events e JOIN pick_sessions s ON s.id = e.session_id WHERE s.created_at >= ? AND s.created_at <= ?', from, to).toArray();
    const count = (map, key) => map.set(key, (map.get(key) || 0) + 1);
    const byDoor = {};
    const byMode = {};
    const relaxed = { time: 0, filters: 0, availability: 0, players: 0 };
    const asks = new Map();
    const shown = new Map();
    let finished = 0;
    for (const s of sessions) {
      byDoor[s.door || 'none'] = (byDoor[s.door || 'none'] || 0) + 1;
      byMode[s.mode || 'play'] = (byMode[s.mode || 'play'] || 0) + 1;
      if (parseJson(s.picks, []).length) finished += 1;
      for (const rule of parseJson(s.relaxed, [])) if (Object.hasOwn(relaxed, rule)) relaxed[rule] += 1;
      for (const pid of uniq(parseJson(s.shown, []))) count(shown, pid);
      const a = parseJson(s.answers, {}) || {};
      const ask = { players: a.players ?? null, time: a.time ?? null, brain: a.brain ?? null, team: a.team ?? 'either', vibes: [...(a.vibes || [])].sort() };
      const key = JSON.stringify(ask);
      if (!asks.has(key)) asks.set(key, { ...ask, fits: [] });
      asks.get(key).fits.push(Number(s.fit_count) || 0);
    }
    const median = (list) => {
      const sorted = [...list].sort((x, y) => x - y);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    const askList = [...asks.values()].map((x) => {
      const fitCount = median(x.fits);
      return { players: x.players, time: x.time, brain: x.brain, team: x.team, vibes: x.vibes, count: x.fits.length, fitCount, gap: fitCount < 5 };
    }).sort((x, y) => y.count - x.count || x.fitCount - y.fitCount);
    const actions = {};
    const acted = new Map();
    const actedBy = new Map();
    for (const e of events) {
      actions[e.action] = (actions[e.action] || 0) + 1;
      if (!e.product_id || ['view', 'swipe-skip', 'again'].includes(e.action)) continue;
      count(acted, e.product_id);
      if (!actedBy.has(e.product_id)) actedBy.set(e.product_id, new Set());
      actedBy.get(e.product_id).add(e.session_id);
    }
    const { byId, games } = this.pickGames();
    const titleOf = (pid) => byId.get(pid)?.title || this.sql.exec('SELECT title FROM pick_catalog WHERE product_id = ?', pid).toArray()[0]?.title || '';
    const ratings = this.sql.exec('SELECT product_id, SUM(rating = 1) AS ups, SUM(rating = -1) AS downs FROM game_ratings GROUP BY product_id').toArray()
      .map((r) => ({ productId: r.product_id, title: titleOf(r.product_id), ups: Number(r.ups) || 0, downs: Number(r.downs) || 0 }));
    const everShown = new Set(sessions.flatMap((s) => parseJson(s.shown, [])));
    return {
      from, to, sessions: sessions.length, byDoor, byMode, finished, actions,
      asks: askList.slice(0, 20),
      gaps: askList.filter((x) => x.gap).sort((x, y) => x.fitCount - y.fitCount || y.count - x.count).slice(0, 10),
      picked: [...shown.entries()].sort((x, y) => y[1] - x[1] || titleOf(x[0]).localeCompare(titleOf(y[0]), 'en')).slice(0, 20)
        .map(([productId, n]) => ({ productId, title: titleOf(productId), shown: n, acted: actedBy.get(productId)?.size || 0 })),
      acted: [...acted.entries()].sort((x, y) => y[1] - x[1] || titleOf(x[0]).localeCompare(titleOf(y[0]), 'en')).slice(0, 20)
        .map(([productId, n]) => ({ productId, title: titleOf(productId), shown: shown.get(productId) || 0, acted: actedBy.get(productId)?.size || 0, actions: n })),
      neverPicked: games.filter((g) => g.status === 'active' && ['game', 'rpg'].includes(g.facts.kind) && !everShown.has(g.productId)).length,
      ratings: {
        up: ratings.filter((r) => r.ups > 0).sort((x, y) => y.ups - x.ups || x.downs - y.downs || x.title.localeCompare(y.title, 'en')).slice(0, 20),
        down: ratings.filter((r) => r.downs > 0).sort((x, y) => y.downs - x.downs || x.ups - y.ups || x.title.localeCompare(y.title, 'en')).slice(0, 20),
      },
      relaxed,
    };
  },

  /* ---------------- maintenance (section 7, steps 1 and 6) ---------------- */
  /**
   * Step 1: the catalogue sync (full on the first run after the Lair starts and every 6 hours, otherwise an update),
   * basic facts for new games and up to 5 auto-tags. Never throws. Returns what happened, or null when nothing did.
   */
  async pickUpkeep() {
    let catalog = null;
    let tags = null;
    try {
      catalog = await this.syncCatalog();
    } catch (error) {
      this.note({ catalogError: { message: String(error?.message || error).slice(0, 300), at: new Date().toISOString() } });
    }
    try {
      tags = await this.autoTag();
    } catch (error) {
      console.error('Lair: auto-tagging failed', error);
    }
    const did = (catalog && !catalog.skipped) || (tags && (tags.tagged || tags.failed));
    return did ? { catalog, tags } : null;
  },

  /** Step 6: quiz sessions older than 180 days that aren't saved are deleted, with their events, 500 a run. No awaits. */
  prunePickSessions(now = Date.now()) {
    const old = this.sql.exec('SELECT id FROM pick_sessions WHERE saved = 0 AND created_at < ? ORDER BY created_at LIMIT ?', now - PICK_LIMITS.sessionDays * DAY, PICK_LIMITS.prunePerRun).toArray();
    for (const r of old) {
      this.sql.exec('DELETE FROM pick_events WHERE session_id = ?', r.id);
      this.sql.exec('DELETE FROM pick_sessions WHERE id = ?', r.id);
    }
    return old.length;
  },
};

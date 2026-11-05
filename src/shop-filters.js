/**
 * Round 31 (6 Nov 2026, contract v31-library-filters): filters on the library shelves and the shop's board games.
 *
 * Mo approved them on 6 Nov 2026: Players, Play time, Youngest player, Weight, How you play and On the shelf now, with
 * Library discovery's numbers (Help me pick's facts, src/pick.js) copied into Shopify and staff able to correct any game
 * (Check games). Shopify's search and the theme filter on these product metafields:
 *  - custom.plays_with: every count the game plays ("8+ players" when it plays 8 or more);
 *  - custom.play_time_band: each band its usual length touches (Under 30 is below 30; 30 to 60 includes both ends; 1 to 2
 *    hours is over 60 to 120; 2 hours plus is over 120), a time per chapter counting per chapter;
 *  - custom.suits_age: the ages a child can be to play it (a game for 7+ gets Age 8, 10, 12, 14; for 15+ none);
 *  - custom.how_you_play: its mode, plus Solo when it plays with one person;
 *  - custom.difficulty (Weight, the field the shop already had): filled only where it's empty, from the facts' weight, with
 *    the cut-offs that agree best with the games that already have one;
 *  - custom.on_shelf (library games only): true while at least one copy is free now, as GET /library/status counts it.
 * Library games (active, kind game or expansion) take theirs from their live facts; the shop's board games from their
 * library twin's facts, else from their own listing, leaving a field empty rather than guessing. Staff see the games with
 * gaps.
 *
 * When: every night from 3am (the scheduled maintenance), when staff press the button, straight after staff save a game on
 * Check games (the alarm, a few seconds later), and On the shelf now within a minute of any change to a hold or loan (the
 * Durable Object's alarm, which batches them; maintenance every 10 minutes is its safety net). Shopify is only ever written
 * after the Lair's own change is saved, so a Shopify failure never breaks a borrow, hold or return: it's tried again later.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair. They
 * read Shopify first, then work out what to write from the Lair's own tables, then write only what's different.
 */
import { HOUR, MIN, RuleError, lairTime, tagHandle } from './core.js';
import { shopifyPaceWait } from './shopify.js';
import { pickNorm } from './pick.js';

/* ---------------- the fields, as Shopify defines them (read with the Admin API on 6 Nov 2026) ---------------- */
/** Each filter's choices, in Shopify's order: a value outside them is turned away */
export const FILTER_CHOICES = {
  plays_with: ['1 player', '2 players', '3 players', '4 players', '5 players', '6 players', '7 players', '8+ players'],
  play_time_band: ['Under 30 min', '30 to 60 min', '1 to 2 hours', '2 hours plus'],
  suits_age: ['Age 4', 'Age 6', 'Age 8', 'Age 10', 'Age 12', 'Age 14'],
  how_you_play: ['Co-op', 'Competitive', 'Team', 'Solo'],
  difficulty: ['Easy', 'Medium', 'Hard'],
};
/** The four list filters, in the order the website shows them */
export const FILTER_LISTS = ['plays_with', 'play_time_band', 'suits_age', 'how_you_play'];
const LIST_TYPE = 'list.single_line_text_field';
/** The filters' names as customers see them, for staff's list of games with gaps */
export const FILTER_NAMES = { plays_with: 'Players', play_time_band: 'Play time', suits_age: 'Youngest player', how_you_play: 'How you play', difficulty: 'Weight' };
/** The library games that get filters: board games and their expansions (never RPG books or kind other) */
export const FILTER_KINDS = ['game', 'expansion'];

/** The numbers in one place */
export const FILTER_LIMITS = {
  readIds: 50, writeMetafields: 25, shelfPerRun: 100, queuePerRun: 20, queueTries: 10, nightlyHour: 3,
  // On the shelf now is checked this long after a hold or loan changes (more changes in the meantime join it)
  shelfWait: MIN,
  // a game staff saved goes to Shopify this long after
  saveWait: 5_000,
  // the alarm wakes this long after a hold ends, to put its game back on the shelf
  holdEndWait: 5_000,
};
/** After 1, 2, 3… failures in a row, try again in this long */
const RETRY_WAITS = [MIN, 2 * MIN, 5 * MIN, 15 * MIN, 30 * MIN, HOUR];
const retryWait = (failures) => RETRY_WAITS[Math.min(RETRY_WAITS.length, Math.max(1, failures)) - 1];

/** Every message staff see from these routes, word for word in the contract */
export const FILTER_WORDS = {
  changed: (n) => `${n} ${n === 1 ? 'game' : 'games'} changed in Shopify.`,
  same: "Every game's filters were already up to date.",
  gaps: (n) => `${n} ${n === 1 ? 'game is' : 'games are'} missing something: they're listed below.`,
  failed: (n) => `${n} ${n === 1 ? "game couldn't" : "games couldn't"} be written just now: the Lair tries again tonight.`,
  notConnected: "Shopify isn't connected yet, so there's nothing to write.",
  noScope: "Shopify hasn't let the Lair app change products yet (write_products), so the filters can't be written.",
  noAnswer: "Shopify didn't answer just now. Try again in a minute.",
};

/* ---------------- the rules ---------------- */
/** Every count from min to max; past 8 they're all "8 or more", so 8 stands for them (or min, when min is over 8). */
export function countsBetween(min, max) {
  const out = [];
  const top = Math.min(max, Math.max(min, 8));
  for (let n = min; n <= top; n += 1) out.push(n);
  return out;
}

/** Players: "1 player", "2 players" … "7 players", and "8+ players" for 8 or more, for each count it plays */
export function playsWith(counts) {
  const said = new Set();
  for (const n of counts) {
    if (Number.isInteger(n) && n >= 1) said.add(n >= 8 ? '8+ players' : `${n} ${n === 1 ? 'player' : 'players'}`);
  }
  return FILTER_CHOICES.plays_with.filter((c) => said.has(c));
}

/**
 * Play time: each band a usual length (minutes, min to max) touches. Under 30 is below 30; 30 to 60 includes both ends;
 * 1 to 2 hours is over 60 to 120; 2 hours plus is over 120.
 */
export function timeBands({ min, max }) {
  const out = [];
  if (min < 30) out.push('Under 30 min');
  if (min <= 60 && max >= 30) out.push('30 to 60 min');
  if (min <= 120 && max > 60) out.push('1 to 2 hours');
  if (max > 120) out.push('2 hours plus');
  return out;
}

/** Youngest player: the ages a child can be to play it, each choice at or above the youngest age (15 or over: none) */
export const suitsAge = (youngest) => [4, 6, 8, 10, 12, 14].filter((age) => age >= youngest).map((age) => `Age ${age}`);

const MODE_WORDS = { coop: 'Co-op', competitive: 'Competitive', team: 'Team', solo: 'Solo' };
/** How you play: its mode, plus Solo when it plays with one person; null when neither is known */
export function howYouPlay(mode, playsAlone) {
  const said = new Set();
  if (MODE_WORDS[mode]) said.add(MODE_WORDS[mode]);
  if (playsAlone) said.add('Solo');
  const list = FILTER_CHOICES.how_you_play.filter((c) => said.has(c));
  return list.length ? list : null;
}

/**
 * Weight's cut-offs: Easy below easyBelow, Hard from hardFrom, Medium between, on the facts' weights (one decimal), chosen
 * to agree with as many of the games that already have a difficulty as can be (pairs: [{ weight, difficulty }]). Ties go
 * to the cut-offs nearest Help me pick's own (Easy below 2.0, Hard from 3.0), then the lower ones; with no games to go by,
 * those. → { easyBelow, hardFrom, agree, of }
 */
export function bestCutoffs(pairs) {
  const count = { Easy: new Array(52).fill(0), Medium: new Array(52).fill(0), Hard: new Array(52).fill(0) };
  let of = 0;
  for (const p of pairs || []) {
    const tenths = Math.round(Number(p?.weight) * 10);
    const said = FILTER_CHOICES.difficulty.find((d) => d.toLowerCase() === String(p?.difficulty ?? '').trim().toLowerCase());
    if (!said || !Number.isInteger(tenths) || tenths < 10 || tenths > 50) continue;
    count[said][tenths] += 1;
    of += 1;
  }
  // below[d][t]: how many of difficulty d weigh under t tenths
  const below = (d) => {
    const out = new Array(53).fill(0);
    for (let t = 1; t <= 52; t += 1) out[t] = out[t - 1] + count[d][t - 1];
    return out;
  };
  const easy = below('Easy');
  const medium = below('Medium');
  const hard = below('Hard');
  let best = null;
  for (let e = 10; e <= 51; e += 1) {
    for (let h = e; h <= 51; h += 1) {
      const agree = easy[e] + (medium[h] - medium[e]) + (hard[52] - hard[h]);
      const off = Math.abs(e - 20) + Math.abs(h - 30);
      if (!best || agree > best.agree || (agree === best.agree && (off < best.off || (off === best.off && (e < best.e || (e === best.e && h < best.h)))))) {
        best = { e, h, agree, off };
      }
    }
  }
  return { easyBelow: best.e / 10, hardFrom: best.h / 10, agree: best.agree, of };
}

/** A weight's difficulty by the cut-offs: Easy, Medium or Hard */
export function difficultyOf(weight, cutoffs) {
  const tenths = Math.round(Number(weight) * 10);
  if (tenths < Math.round(cutoffs.easyBelow * 10)) return 'Easy';
  return tenths >= Math.round(cutoffs.hardFrom * 10) ? 'Hard' : 'Medium';
}

/* ---------------- reading a listing as it says (no guesses) ---------------- */
/**
 * Players from a listing's text, every count it says: "2–4", "2", "1–4 or 6", "3–10+", "8+". null when it has no number,
 * or no top below 8 ("2+": it doesn't say how many at most, so it can't say every count).
 */
export function readPlayers(text) {
  const s = String(text ?? '').toLowerCase().replace(/[–—−]/g, '-').replace(/\s+to\s+/g, '-').replace(/\b(players?|people|persons?)\b/g, ' ').trim();
  if (!s) return null;
  const counts = new Set();
  for (const part of s.split(/\s*(?:,|\bor\b|\/|&|\band\b)\s*/).filter(Boolean)) {
    const m = part.match(/^(\d{1,2})\s*(?:-\s*(\d{1,2}))?\s*(\+)?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] != null ? Number(m[2]) : a;
    if (a < 1 || b < a || (m[3] && b < 8)) return null;
    for (const n of countsBetween(a, b)) counts.add(n);
  }
  return counts.size ? [...counts].sort((x, y) => x - y) : null;
}

const UNIT = '(hours?|hrs?|h|minutes?|mins?|m)';
const minutesIn = (unit) => (unit ? (/^h/.test(unit) ? 60 : 1) : null);
/**
 * Play time from a listing's text, in minutes, as it says: "45 min" is 45, "30–45 min", "1–2 hours", "30 min – 2 hours".
 * A time per chapter, adventure or scenario counts as it is; one per player is times each count it plays (counts). null
 * when it has no number, or no top or bottom ("60+ min", "up to 30 min").
 */
export function readTime(text, counts = null) {
  let s = String(text ?? '').toLowerCase().replace(/[–—−]/g, '-').replace(/\s+to\s+/g, '-').replace(/~/g, '')
    .replace(/\b(about|around|approx\.?|approximately|roughly)\s*/g, '').trim();
  if (!s || /\+|\bplus\b|\bup-?\s*to\b|\bover\b|\bunder\b|\bless\b|\bmore\b/.test(s)) return null;
  let perPlayer = false;
  const per = s.match(/\bper\s+([a-z]+)/);
  if (per) {
    perPlayer = /^players?$/.test(per[1]);
    s = s.slice(0, per.index).trim();
  }
  const m = s.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*${UNIT}?\\s*(?:-\\s*(\\d+(?:\\.\\d+)?)\\s*${UNIT}?)?$`));
  if (!m) return null;
  const second = minutesIn(m[4]);
  const first = minutesIn(m[2]) ?? second ?? 1;
  let lo = Number(m[1]) * first;
  let hi = m[3] != null ? Number(m[3]) * (second ?? first) : lo;
  if (perPlayer) {
    if (!counts?.length) return null;
    lo *= Math.min(...counts);
    hi *= Math.max(...counts);
  }
  if (!(lo > 0) || hi < lo) return null;
  return { min: Math.round(lo), max: Math.round(hi) };
}

/**
 * The youngest age an age group says (Shopify's shopify--recommended-age-group entries): "8 years or older" 8, "13-18
 * years" 13, "6-12 months" 0, "Teens" 13, "Adults" 18, "All ages" 0. null for anything else.
 */
export function youngestOf(label) {
  const s = String(label ?? '').trim().toLowerCase();
  if (s === 'all ages') return 0;
  if (s === 'teens' || s === 'teen') return 13;
  if (s === 'adults' || s === 'adult') return 18;
  const m = s.match(/^(\d{1,2})\s*(?:-\s*\d{1,2}\s*)?(years?|yrs?|months?)\b/);
  if (!m) return null;
  return /^m/.test(m[2]) ? 0 : Number(m[1]);
}

/* ---------------- what a game's filters say ---------------- */
/**
 * From Library discovery's facts (contract v17 1.2): every count from players.min to players.max, the bands its time
 * touches, the ages from its youngest, its mode (plus Solo when players.min is 1), and its weight.
 */
export function filtersFromFacts(f) {
  return {
    plays_with: playsWith(countsBetween(f.players.min, f.players.max)),
    play_time_band: timeBands(f.time),
    suits_age: suitsAge(f.age),
    how_you_play: howYouPlay(f.mode, f.players.min <= 1),
    modeKnown: Boolean(MODE_WORDS[f.mode]),
    weight: Number.isFinite(Number(f.weight)) ? Number(f.weight) : null,
  };
}

/**
 * From a listing as it says (a shop game with no library twin, or a library game whose facts are still the basic ones):
 * its custom.players and custom.play_time text, the youngest age its age group says, and its tags (Co-op, Solo). Anything
 * it doesn't say is null (left empty, never guessed); its mode is only known from a Co-op tag, so how_you_play may say Solo
 * alone. No weight: a difficulty is only filled from facts.
 */
export function filtersFromListing({ playersText, timeText, youngest, tags }) {
  const counts = readPlayers(playersText);
  const handles = (tags || []).map(tagHandle);
  const coop = handles.some((h) => /^(co-op|coop|cooperative|co-operative)$/.test(h));
  const time = readTime(timeText, counts);
  return {
    plays_with: counts ? playsWith(counts) : null,
    play_time_band: time ? timeBands(time) : null,
    suits_age: youngest == null ? null : suitsAge(youngest),
    how_you_play: howYouPlay(coop ? 'coop' : null, handles.includes('solo') || Boolean(counts?.includes(1))),
    modeKnown: coop,
    weight: null,
  };
}

/** A list as it's compared and written: the choices it has, in Shopify's order */
const tidyList = (key, list) => FILTER_CHOICES[key].filter((c) => (list || []).includes(c));
const sameList = (key, a, b) => JSON.stringify(tidyList(key, a)) === JSON.stringify(tidyList(key, b));
/** Lists in groups of size */
const chunksOf = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
const errorText = (error) => String(error?.message || error).slice(0, 300);
const productGid = (id) => `gid://shopify/Product/${id}`;

/** The tables (made when missing, lair.js's migrate) */
export const SHOP_FILTER_TABLES = [
  // what Shopify's On the shelf now says for each library game, as the Lair last read or wrote it
  'CREATE TABLE IF NOT EXISTS shelf_state (product_id TEXT PRIMARY KEY, on_shelf INTEGER NOT NULL, at INTEGER NOT NULL)',
  // games staff saved on Check games, waiting for their filters to go to Shopify (and those that failed, waiting to try again)
  'CREATE TABLE IF NOT EXISTS filter_queue (product_id TEXT PRIMARY KEY, due_at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, error TEXT)',
  // shop board games linked to their library copy by their own Library copy field (custom.library_copy), as last read
  'CREATE TABLE IF NOT EXISTS shop_twins (shop_id TEXT PRIMARY KEY, library_id TEXT NOT NULL, seen_at INTEGER NOT NULL)',
  // the holds still on (the alarm and maintenance ask every few minutes, and library_holds keeps every hold ever made),
  // so those reads touch only the active ones (the free plan counts rows read)
  'CREATE INDEX IF NOT EXISTS library_holds_status ON library_holds (status, until)',
];
/** A write that changes a library hold or loan (lair.js's write): On the shelf now may have changed */
export const SHELF_WRITES = /\blibrary_(?:holds|loans)\b/;

export const shopFilterMethods = {
  /* ---------------- when ---------------- */
  /** Whether the Lair can write the filters: Shopify connected, and write_products granted (when the scopes are known). No awaits. */
  filtersReady() {
    if (!this.shopify?.configured) return false;
    const scopes = this.grantedScopes;
    return !Array.isArray(scopes) || scopes.includes('write_products');
  },

  /**
   * Wake the Lair at `at` with its one Durable Object alarm, unless it's already waking sooner (a wake overdue by more
   * than two minutes is taken as lost and set again). Never throws. No awaits.
   */
  wakeAt(at) {
    try {
      const storage = this.ctx?.storage;
      if (typeof storage?.setAlarm !== 'function' || !Number.isFinite(at)) return;
      if (this.alarmAt && this.alarmAt <= at && this.alarmAt > Date.now() - 2 * MIN) return;
      this.alarmAt = at;
      this.later(storage.setAlarm(at));
    } catch (error) {
      console.error('Lair: could not set the alarm', error);
    }
  },

  /** A library hold or loan changed (lair.js's write): On the shelf now is checked within a minute. Never throws. No awaits. */
  shelfTouched(now = Date.now()) {
    try {
      if (this.filtersReady()) this.wakeAt(now + FILTER_LIMITS.shelfWait);
    } catch (error) {
      console.error('Lair: could not plan the shelf check', error);
    }
  },

  /** One filter run at a time (the alarm, maintenance and the staff button never overlap): each waits for the one before. */
  filterWork(job) {
    const run = (this.filterChain || Promise.resolve()).then(job);
    this.filterChain = run.catch(() => {});
    return run;
  },

  /** The alarm went off (lair.js's alarm): the upkeep below, never throwing. */
  async filterAlarm(now = Date.now()) {
    this.alarmAt = null;
    if (!this.filtersReady()) return null;
    return this.filterWork(() => this.filterUpkeep(now));
  },

  /**
   * On the shelf now where it changed, then games staff saved, then the next wake: sooner when work is left or failed
   * (1, 2, 5, 15, 30 then 60 minutes after failures in a row), else when the next hold ends. Run by the alarm and, as its
   * safety net, by maintenance. Never throws. → what it did, or null.
   */
  async filterUpkeep(now = Date.now()) {
    if (!this.filtersReady()) return null;
    const out = {};
    let again = Infinity;
    try {
      const shelf = await this.shelfUpkeep(now);
      if (shelf.written || shelf.failed) out.shelf = shelf;
      if (shelf.failed) throw new Error(shelf.error || "Shopify didn't take every change");
      this.shelfFailures = 0;
      if (shelf.left) again = Math.min(again, Date.now() + FILTER_LIMITS.shelfWait);
    } catch (error) {
      this.shelfFailures = (this.shelfFailures || 0) + 1;
      again = Math.min(again, Date.now() + retryWait(this.shelfFailures));
      out.shelfError = errorText(error);
      this.note({ shelfError: { message: out.shelfError, at: new Date().toISOString() } });
    }
    try {
      const queued = await this.filterQueueUpkeep(Date.now());
      if (queued?.written || queued?.failed) out.saved = { written: queued.written, failed: queued.failed };
      if (queued?.next) again = Math.min(again, queued.next);
    } catch (error) {
      out.savedError = errorText(error);
      again = Math.min(again, Date.now() + retryWait(1));
    }
    const holdEnds = this.nextHoldEnd(Date.now());
    const wake = Math.min(again, holdEnds ? holdEnds + FILTER_LIMITS.holdEndWait : Infinity);
    if (Number.isFinite(wake)) this.wakeAt(wake);
    return Object.keys(out).length ? out : null;
  },

  /** When the next active hold ends (its game is back on the shelf then), or null. No awaits. */
  nextHoldEnd(now) {
    return this.sql.exec("SELECT MIN(until) AS until FROM library_holds WHERE status = 'held' AND until > ?", now).toArray()[0]?.until ?? null;
  },

  /**
   * Maintenance from 3am Lair time, once a Lair day: every game's filters and On the shelf now (runShopFilters). A run
   * that couldn't read Shopify tries again at the next maintenance (10 minutes on); one that ran is the night's, its
   * failures tried again tomorrow (On the shelf now's sooner, by the upkeep). Never throws. → its summary, or null.
   */
  async shopFiltersNightly(now = Date.now()) {
    if (!this.filtersReady()) return null;
    const time = lairTime(this.rulesCache?.tz || 'Pacific/Auckland');
    if (time.minutesOf(now) < FILTER_LIMITS.nightlyHour * 60) return null;
    const today = time.key(now);
    if (this.sql.exec("SELECT value FROM meta WHERE key = 'shop-filters-day'").toArray()[0]?.value === today) return null;
    if (now < (this.retryAt.get('shop-filters') || 0)) return null;
    try {
      const result = await this.filterWork(() => this.runShopFilters({ reason: 'nightly', now }));
      this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('shop-filters-day', ?)", today);
      return { games: result.games, changed: result.changed, fields: result.fields, failed: result.failed, gaps: result.gaps.length };
    } catch (error) {
      this.backoff('shop-filters');
      this.note({ shopFiltersError: { message: errorText(error), at: new Date().toISOString() } });
      return { error: errorText(error) };
    }
  },

  /* ---------------- staff ---------------- */
  /**
   * POST /pick/filters (perm library, as "Sync with Shopify now"): every game's filters and On the shelf now, written now.
   * → { games, changed, fields, failed, gaps, cutoffs, message }. Shopify not connected, or not answering: 503.
   */
  async staffShopFilters(who) {
    this.requireStaff(who, 'library');
    if (!this.shopify.configured) throw new RuleError(FILTER_WORDS.notConnected, 503);
    if (!this.filtersReady()) throw new RuleError(FILTER_WORDS.noScope, 503);
    let result;
    try {
      result = await this.filterWork(() => this.runShopFilters({ reason: 'staff', now: Date.now() }));
    } catch (error) {
      this.note({ shopFiltersError: { message: errorText(error), at: new Date().toISOString() } });
      throw new RuleError(FILTER_WORDS.noAnswer, 503);
    }
    const message = [
      result.changed ? FILTER_WORDS.changed(result.changed) : FILTER_WORDS.same,
      ...(result.failed ? [FILTER_WORDS.failed(result.failed)] : []),
      ...(result.gaps.length ? [FILTER_WORDS.gaps(result.gaps.length)] : []),
    ].join(' ');
    return { ...result, message };
  },

  /** GET /pick/filters (perm library): the last whole run { at, reason, games, changed, fields, failed }, its gaps and cut-offs. No awaits. */
  shopFiltersView(who) {
    this.requireStaff(who, 'library');
    let last = null;
    try {
      last = JSON.parse(this.sql.exec("SELECT value FROM meta WHERE key = 'shop-filters-last'").toArray()[0]?.value || 'null');
    } catch {
      last = null;
    }
    return {
      last: last ? { at: last.at, reason: last.reason, games: last.games, changed: last.changed, fields: last.fields, failed: last.failed } : null,
      gaps: last?.gaps || [], cutoffs: last?.cutoffs || null,
    };
  },

  /**
   * Straight after staff save a game on Check games (POST /pick/games/:productId): it and its shop twins (its Shop copy,
   * the shop games with its title, and those whose Library copy is it) wait a few seconds for the alarm. Never throws. No
   * awaits.
   */
  filtersAfterSave(productId, now = Date.now()) {
    try {
      if (!this.filtersReady()) return;
      const id = String(decodeURIComponent(String(productId ?? ''))).replace(/^gid:\/\/shopify\/Product\//, '').trim();
      if (!/^\d{1,20}$/.test(id)) return;
      const game = this.pickGames().byId.get(id);
      const twins = new Set();
      if (game?.shopCopy?.productId) twins.add(String(game.shopCopy.productId));
      const norm = game ? pickNorm(game.title) : '';
      if (norm) for (const r of this.sql.exec('SELECT product_id FROM pick_shop WHERE norm = ?', norm).toArray()) twins.add(r.product_id);
      for (const r of this.sql.exec('SELECT shop_id FROM shop_twins WHERE library_id = ?', id).toArray()) twins.add(r.shop_id);
      const due = now + FILTER_LIMITS.saveWait;
      for (const pid of [id, ...twins]) {
        this.sql.exec(
          'INSERT INTO filter_queue (product_id, due_at, tries, error) VALUES (?, ?, 0, NULL) ON CONFLICT(product_id) DO UPDATE SET due_at = excluded.due_at, tries = 0, error = NULL',
          pid, due,
        );
      }
      this.wakeAt(due);
    } catch (error) {
      console.error('Lair: could not queue a saved game for Shopify', error);
    }
  },

  /**
   * The games waiting in filter_queue whose time has come (20 a run): their filters written (writeShopFilters). Each
   * written leaves the queue (unless saved again meanwhile); each that failed waits longer (1, 2, 5, 15, 30, 60 minutes),
   * and after 10 tries is left to the nightly run. → { written, failed, next (when the next one's due) }, or null.
   */
  async filterQueueUpkeep(now = Date.now()) {
    const due = this.sql.exec('SELECT * FROM filter_queue WHERE due_at <= ? ORDER BY due_at, product_id LIMIT ?', now, FILTER_LIMITS.queuePerRun).toArray();
    const nextDue = () => this.sql.exec('SELECT MIN(due_at) AS at FROM filter_queue').toArray()[0]?.at ?? null;
    if (!due.length) {
      const next = nextDue();
      return next ? { written: 0, failed: 0, next } : null;
    }
    let result = null;
    let error = null;
    try {
      result = await this.writeShopFilters({ ids: due.map((r) => r.product_id), now });
    } catch (caught) {
      error = errorText(caught);
    }
    const at = Date.now();
    let failed = 0;
    for (const r of due) {
      const bad = error || result.failedIds.get(r.product_id);
      if (!bad) {
        this.sql.exec('DELETE FROM filter_queue WHERE product_id = ? AND due_at = ?', r.product_id, r.due_at);
        continue;
      }
      failed += 1;
      if (r.tries + 1 >= FILTER_LIMITS.queueTries) this.sql.exec('DELETE FROM filter_queue WHERE product_id = ? AND due_at = ?', r.product_id, r.due_at);
      else this.sql.exec('UPDATE filter_queue SET tries = tries + 1, due_at = ?, error = ? WHERE product_id = ? AND due_at = ?', at + retryWait(r.tries + 1), String(bad).slice(0, 300), r.product_id, r.due_at);
    }
    return { written: result?.changed || 0, failed, next: nextDue() };
  },

  /* ---------------- On the shelf now ---------------- */
  /**
   * What On the shelf now should say for each active library game (kind game or expansion), by product id: at least one
   * copy free now, as GET /library/status counts it (copies less active holds less loans out; the copies from the
   * catalogue's copy of Shopify's count). In Store Only games count the same way. No awaits.
   */
  shelfWanted(now = Date.now()) {
    const games = this.pickGames().games.filter((g) => g.status === 'active' && FILTER_KINDS.includes(g.facts.kind));
    const status = this.pickAvailability(games, null, now);
    return new Map(games.map((g) => [g.productId, (status.get(g.productId)?.available || 0) >= 1]));
  },

  /** What Shopify's On the shelf now says for each game, as the Lair last read or wrote it (shelf_state, kept in memory). No awaits. */
  shelfKnown() {
    if (!this.shelfCache) {
      this.shelfCache = new Map(this.sql.exec('SELECT product_id, on_shelf FROM shelf_state').toArray().map((r) => [r.product_id, r.on_shelf === 1]));
    }
    return this.shelfCache;
  },

  /** Remember what Shopify's On the shelf now says for a game (written only when it's different). No awaits. */
  rememberShelf(productId, onShelf, now = Date.now()) {
    const known = this.shelfKnown();
    if (known.get(productId) === onShelf) return;
    this.sql.exec(
      'INSERT INTO shelf_state (product_id, on_shelf, at) VALUES (?, ?, ?) ON CONFLICT(product_id) DO UPDATE SET on_shelf = excluded.on_shelf, at = excluded.at',
      productId, onShelf ? 1 : 0, now,
    );
    known.set(productId, onShelf);
  },

  /**
   * On the shelf now for the games where it's changed (or the Lair doesn't know what Shopify says), 100 a run: Shopify read
   * first (50 a read), then only what's different written (25 a write). → { checked, written, failed, left, error }.
   * Throws when Shopify can't be read.
   */
  async shelfUpkeep(now = Date.now()) {
    const wanted = this.shelfWanted(now);
    const known = this.shelfKnown();
    const todo = [...wanted.keys()].filter((id) => known.get(id) !== wanted.get(id));
    const batch = todo.slice(0, FILTER_LIMITS.shelfPerRun);
    const out = { checked: wanted.size, written: 0, failed: 0, left: todo.length - batch.length };
    if (!batch.length) return out;
    const current = new Map();
    for (const ids of chunksOf(batch, FILTER_LIMITS.readIds)) {
      for (const [id, value] of await this.shopifyPaced(() => this.shopify.shelfValues(ids))) current.set(id, value);
    }
    // what should be, worked out again now Shopify has answered (a hold may have changed meanwhile)
    const fresh = this.shelfWanted(Date.now());
    const sets = [];
    for (const id of batch) {
      if (!current.has(id) || !fresh.has(id)) continue;
      if (current.get(id) !== fresh.get(id)) sets.push({ productId: id, metafields: [{ ownerId: productGid(id), namespace: 'custom', key: 'on_shelf', type: 'boolean', value: String(fresh.get(id)) }] });
    }
    const result = await this.writeFilterMetafields(sets, []);
    const at = Date.now();
    for (const id of batch) {
      if (!current.has(id) || !fresh.has(id) || result.failed.has(id)) continue;
      this.rememberShelf(id, fresh.get(id), at);
    }
    out.written = result.done.size;
    out.failed = result.failed.size;
    if (result.failed.size) out.error = [...result.failed.values()][0];
    return out;
  },

  /* ---------------- every game's filters ---------------- */
  /** The whole run (nightly and the staff button), its summary kept for GET /pick/filters. Throws when Shopify can't be read. */
  async runShopFilters({ reason = 'nightly', now = Date.now() } = {}) {
    const result = await this.writeShopFilters({ ids: null, now });
    const summary = {
      at: now, reason, games: result.games, changed: result.changed, fields: result.fields, failed: result.failedIds.size, gaps: result.gaps,
      cutoffs: result.cutoffs,
    };
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('shop-filters-last', ?)", JSON.stringify(summary));
    return summary;
  },

  /** A library game's facts count for the filters when they're not the basic ones made from its listing, or staff checked them. */
  factsUsable(g) {
    return Boolean(g?.facts) && (g.source !== 'basic' || Boolean(g.checked));
  },

  /** The catalogue's copy of a library listing's custom.difficulty (Easy, Medium, Hard), or null. No awaits. */
  catalogDifficulty(productId) {
    if (!this.difficultyMemo) {
      this.difficultyMemo = new Map(this.sql.exec('SELECT product_id, difficulty FROM pick_catalog').toArray().map((r) => [r.product_id, r.difficulty || null]));
    }
    return this.difficultyMemo.get(productId) ?? null;
  },

  /**
   * Every game's filters, or only those in ids: the library games (active, kind game or expansion) and the shop's board
   * games (pick_shop: active, product type Board Games, not library copies; one sold on a plan, the membership, isn't a
   * board game). Read first (50 products a read), then what each should say worked out from the Lair's own tables, then
   * only what's different written (25 metafields a write, a product's together), a known-empty list taken off (Shopify
   * won't take an empty one). → { games, changed, fields, failedIds (Map productId → why), gaps, cutoffs }. Throws when
   * Shopify can't be read.
   */
  async writeShopFilters({ ids = null, now = Date.now() } = {}) {
    // --- which products (the Lair's own tables) ---
    const libraryIds = this.pickGames().games.filter((g) => g.status === 'active' && FILTER_KINDS.includes(g.facts.kind)).map((g) => g.productId);
    const shopIds = this.sql.exec('SELECT product_id FROM pick_shop ORDER BY product_id').toArray().map((r) => r.product_id);
    const want = ids ? new Set(ids.map(String)) : null;
    const targets = [...new Set([...libraryIds, ...shopIds])].filter((id) => !want || want.has(id));
    // --- read first: what Shopify has, and what each listing says ---
    const nodes = new Map();
    for (const chunk of chunksOf(targets, FILTER_LIMITS.readIds)) {
      for (const [id, node] of await this.shopifyPaced(() => this.shopify.filterProducts(chunk))) nodes.set(id, node);
    }
    const labels = await this.ageGroupLabels([...nodes.values()].flatMap((n) => n.ageGroups));
    // --- what each should say, from the Lair's tables as they are now (no awaits from here to the write) ---
    this.difficultyMemo = null;
    const { games } = this.pickGames();
    const byId = new Map(games.map((g) => [g.productId, g]));
    const library = new Set(games.filter((g) => g.status === 'active' && FILTER_KINDS.includes(g.facts.kind)).map((g) => g.productId));
    const twinOk = (g) => g && FILTER_KINDS.includes(g.facts.kind) && this.factsUsable(g);
    // a twin by its Shop copy, or by title (an active one, with checked facts, first)
    const rank = (g) => (g.status === 'active' ? 0 : 2) + (g.checked ? 0 : 1);
    const ordered = [...games].filter(twinOk).sort((a, b) => rank(a) - rank(b) || a.productId.localeCompare(b.productId));
    const byShopCopy = new Map();
    const byTitle = new Map();
    for (const g of ordered) {
      if (g.shopCopy?.productId && !byShopCopy.has(String(g.shopCopy.productId))) byShopCopy.set(String(g.shopCopy.productId), g);
      const norm = pickNorm(g.title);
      if (norm && !byTitle.has(norm)) byTitle.set(norm, g);
    }
    // Weight's cut-offs: from the library games with a difficulty (the catalogue's copy of custom.difficulty) and facts a
    // person or the tagging work made (basic facts take their weight from the difficulty, so they'd only agree with it)
    const cutoffs = bestCutoffs(games.filter((g) => library.has(g.productId) && this.factsUsable(g)).map((g) => ({ weight: g.facts.weight, difficulty: this.catalogDifficulty(g.productId) })));
    const shelf = this.shelfWanted(Date.now());
    const sets = [];
    const deletes = [];
    const gaps = [];
    const twinsSeen = new Map();
    let counted = 0;
    for (const id of targets) {
      const node = nodes.get(id);
      if (!node) continue;
      const isLibrary = library.has(id);
      // a membership (sold on a plan) or a gift card isn't a board game
      if (!isLibrary && (node.sellingPlan || node.giftCard)) continue;
      counted += 1;
      let values;
      let twin = null;
      if (isLibrary) {
        const g = byId.get(id);
        values = this.factsUsable(g) ? filtersFromFacts(g.facts) : filtersFromListing({ ...node, youngest: this.youngestIn(node.ageGroups, labels) });
      } else {
        const linked = node.libraryCopy && byId.get(node.libraryCopy);
        twin = (twinOk(linked) && linked) || byShopCopy.get(id) || byTitle.get(pickNorm(node.title)) || null;
        if (node.libraryCopy && twinOk(linked)) twinsSeen.set(id, node.libraryCopy);
        values = twin ? filtersFromFacts(twin.facts) : filtersFromListing({ ...node, youngest: this.youngestIn(node.ageGroups, labels) });
      }
      const mine = [];
      const takeOff = [];
      for (const key of FILTER_LISTS) {
        const value = values[key];
        if (value == null) continue;
        const has = node.current[key];
        if (value.length) {
          if (!has || !sameList(key, has, value)) mine.push({ ownerId: productGid(id), namespace: 'custom', key, type: LIST_TYPE, value: JSON.stringify(tidyList(key, value)) });
        } else if (has && has.length) {
          takeOff.push({ ownerId: productGid(id), namespace: 'custom', key });
        }
      }
      // Weight: only where it's empty, and only while it still is (compareDigest null: Shopify refuses it once it's set)
      const fill = !node.current.difficulty && values.weight != null ? difficultyOf(values.weight, cutoffs) : null;
      if (fill) mine.push({ ownerId: productGid(id), namespace: 'custom', key: 'difficulty', type: 'single_line_text_field', value: fill, compareDigest: null });
      if (isLibrary && shelf.has(id) && node.current.on_shelf !== shelf.get(id)) {
        mine.push({ ownerId: productGid(id), namespace: 'custom', key: 'on_shelf', type: 'boolean', value: String(shelf.get(id)) });
      }
      if (mine.length) sets.push({ productId: id, metafields: mine });
      if (takeOff.length) deletes.push({ productId: id, metafields: takeOff });
      const missing = FILTER_LISTS.filter((key) => values[key] == null || (key === 'how_you_play' && !values.modeKnown)).map((key) => FILTER_NAMES[key]);
      if (!node.current.difficulty && !fill) missing.push(FILTER_NAMES.difficulty);
      if (missing.length) {
        gaps.push({
          productId: id, title: node.title.replace(/\s*\(\s*library\s*\)\s*$/i, '').trim(), handle: node.handle, where: isLibrary ? 'library' : 'shop', missing,
          // a shop game's library twin, when it has one (linking one fills its gaps)
          ...(isLibrary ? {} : { twin: twin ? { productId: twin.productId, title: twin.title } : null }),
        });
      }
    }
    const result = await this.writeFilterMetafields(sets, deletes);
    // --- remember: what On the shelf now says, and the shop games' own Library copy links ---
    const at = Date.now();
    for (const id of targets) {
      const node = nodes.get(id);
      if (!node || !library.has(id) || !shelf.has(id) || result.failed.has(id)) continue;
      this.rememberShelf(id, shelf.get(id), at);
    }
    this.rememberTwins(twinsSeen, [...nodes.keys()].filter((id) => !library.has(id)), at);
    gaps.sort((a, b) => (a.where === b.where ? 0 : a.where === 'library' ? -1 : 1) || a.title.localeCompare(b.title, 'en') || a.productId.localeCompare(b.productId));
    return { games: counted, changed: result.done.size, fields: result.fields, failedIds: result.failed, gaps, cutoffs };
  },

  /** The youngest age a product's age groups say (youngestOf, the youngest of them), or null when none says. No awaits. */
  youngestIn(groupIds, labels) {
    const ages = (groupIds || []).map((gid) => youngestOf(labels.get(gid))).filter((n) => n != null);
    return ages.length ? Math.min(...ages) : null;
  },

  /** The labels of the store's age group entries (a handful), read from Shopify once and kept. → Map gid → label */
  async ageGroupLabels(gids) {
    this.ageLabels = this.ageLabels || new Map();
    const ask = [...new Set(gids)].filter((gid) => gid && !this.ageLabels.has(gid));
    for (const chunk of chunksOf(ask, FILTER_LIMITS.readIds)) {
      const found = await this.shopifyPaced(() => this.shopify.ageGroupLabels(chunk));
      for (const gid of chunk) this.ageLabels.set(gid, found.get(gid) ?? null);
    }
    return this.ageLabels;
  },

  /** The shop games linked to a library copy by their own Library copy field (shop_twins), changed rows only. No awaits. */
  rememberTwins(links, shopIds, now) {
    const had = new Map(this.sql.exec('SELECT shop_id, library_id FROM shop_twins').toArray().map((r) => [r.shop_id, r.library_id]));
    for (const shopId of shopIds) {
      const libraryId = links.get(shopId) || null;
      if (libraryId && had.get(shopId) !== libraryId) {
        this.sql.exec('INSERT INTO shop_twins (shop_id, library_id, seen_at) VALUES (?, ?, ?) ON CONFLICT(shop_id) DO UPDATE SET library_id = excluded.library_id, seen_at = excluded.seen_at', shopId, libraryId, now);
      } else if (!libraryId && had.has(shopId)) {
        this.sql.exec('DELETE FROM shop_twins WHERE shop_id = ?', shopId);
      }
    }
  },

  /**
   * Write metafields and take some off: sets and deletes are [{ productId, metafields }]; each product's stay together in
   * one call of up to 25 (Shopify's limit; metafieldsSet is all or nothing), paced by Shopify's bucket. A call that fails
   * fails only its products. → { done: Set of products changed, failed: Map productId → why, fields (how many written or
   * taken off) }
   */
  async writeFilterMetafields(sets, deletes) {
    const done = new Set();
    const failed = new Map();
    let fields = 0;
    const pack = (groups) => {
      const calls = [];
      let current = [];
      let size = 0;
      for (const g of groups) {
        if (size + g.metafields.length > FILTER_LIMITS.writeMetafields && current.length) {
          calls.push(current);
          current = [];
          size = 0;
        }
        current.push(g);
        size += g.metafields.length;
      }
      if (current.length) calls.push(current);
      return calls;
    };
    for (const [list, write] of [[sets, (m) => this.shopify.setProductMetafields(m)], [deletes, (m) => this.shopify.deleteProductMetafields(m)]]) {
      for (const call of pack(list)) {
        const metafields = call.flatMap((g) => g.metafields);
        let problem = null;
        try {
          const answer = await this.shopifyPaced(() => write(metafields));
          if (answer?.userErrors?.length) problem = answer.userErrors.map((e) => e.message).join('; ');
        } catch (error) {
          problem = errorText(error);
        }
        for (const g of call) {
          if (problem) {
            failed.set(g.productId, problem);
            done.delete(g.productId);
          } else if (!failed.has(g.productId)) {
            done.add(g.productId);
          }
        }
        if (!problem) fields += metafields.length;
      }
    }
    return { done, failed, fields };
  },

  /** A Shopify call paced by its query bucket: a throttled one asked again once there's room (5 tries), and a pause after for the next. */
  async shopifyPaced(call) {
    for (let tries = 1; ; tries += 1) {
      try {
        const out = await call();
        const room = shopifyPaceWait(this.shopify.lastCost);
        if (room) await this.shopify.wait(room);
        return out;
      } catch (error) {
        if (!error?.throttled || tries >= 5) throw error;
        await this.shopify.wait(shopifyPaceWait(error.cost) || 2000);
      }
    }
  },
};

// Dice Goblin Lair — one Durable Object holds every booking, game and hold.
//
// Concurrency: a Durable Object runs one piece of code at a time, but while it waits on Shopify (an outbound
// fetch) another request can run. So every handler does its Shopify waiting first, then reads, checks and writes
// with no `await` in between. Where a Shopify call has to come after a write (checkouts, store credit), the
// handler claims the row first and afterwards only updates the columns it owns.
import {
  ACTIVE, BIRTHDAY_CODE_DAYS, HOUR, MIN, PRIZE_CODE_DAYS, ROLL_EVERY, LairTime, RuleError, addDays, birthdayPercent, blockingItems, checkGameDetails,
  checkGameSession, checkSeatBooking, checkTableBooking, codeKey, codeKeys, eventOccurrences, findOccurrence, isFree, legacyRefs, makeId, makeRef,
  nextBirthday, oneRoom, parseBirthday, parseSpots, parseTableList, publicBooking, publicGame, readSettingsData, refundFor, rollPrize, rulesFromSettings,
  seatPlayers, seatsTaken, tableIndex, uniqueCode,
} from './core.js';
import { ShopifyAdmin, emailReady, sendEmail, sendEmails } from './shopify.js';
import { recordStatus, withConfig } from './config.js';
import { hoursSummary, renderEmail } from './email.js';

const FALLBACK_ROOMS = [
  { id: 'main-room', name: 'Main room', code: 'T', tables: 21, seats: 4, order: 1 },
  { id: 'party-room', name: 'Party room', code: 'P', tables: 4, seats: 4, order: 2 },
  { id: 'gaming-room', name: 'Gaming room', code: 'G', tables: 4, seats: 4, order: 3 },
  { id: 'fancy-room', name: 'Fancy room', code: 'F', tables: 1, seats: 12, price: 15, minPeople: 4, order: 4 },
];
/** Permissions the Shopify app needs (checked by the health check) */
const REQUIRED_SCOPES = ['read_customers', 'read_metaobjects', 'read_themes', 'read_orders', 'write_draft_orders', 'write_store_credit_account_transactions'];
/** Permissions only some features need: everything else works without them */
const FEATURE_SCOPES = { write_discounts: 'dice prize and birthday codes' };
const IMAGE_LIMIT = 700 * 1024;
const HOLD_MINUTES = 30;
const RULES_TTL = 5 * MIN;
const PERSON_TTL = 5 * MIN;
const STATE_TTL = 60_000;
/** Abuse limits for people who are not staff */
const LIMITS = { perClientPer10Min: 20, activePerEmail: 6, messagesPerGamePerDay: 5 };
/** What the public sees for a staff hold (staff labels can hold names or notes) */
const PUBLIC_HOLD = { tournament: 'Tournament', market: 'Market', event: 'Event', maintenance: 'Out of action' };
/** An event that's paid online only, when Shopify can't make the checkout */
const ONLINE_DOWN = "Online payment isn't working right now. Call us and we'll hold you a spot.";
/** Cancelling a sign-up or game spot that was paid online: it's locked in, so staff decide on a refund */
const LOCKED_IN = 'Your spot is cancelled. You paid online, so have a chat with us about a refund.';

/** Schema changes go at the end of this list; each entry runs once. Entry 1 is the first release's schema. */
const MIGRATIONS = [
  [
    `CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, status TEXT NOT NULL, tables TEXT NOT NULL,
      room TEXT, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, people INTEGER NOT NULL, name TEXT, email TEXT,
      phone TEXT, notes TEXT, activity TEXT, extras TEXT, pay TEXT, paid INTEGER NOT NULL DEFAULT 0, amount INTEGER NOT NULL DEFAULT 0,
      game_id TEXT, customer_id TEXT, hold_until INTEGER, draft_order_id TEXT, order_id TEXT, created_at INTEGER, updated_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS bookings_time ON bookings (ends_at, starts_at)',
    'CREATE INDEX IF NOT EXISTS bookings_game ON bookings (game_id)',
    `CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, system TEXT, gm TEXT, gm_customer_id TEXT, gm_email TEXT, level TEXT, age TEXT,
      tags TEXT, safety TEXT, pregens INTEGER, blurb TEXT, tables TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
      seats INTEGER NOT NULL, status TEXT NOT NULL, credited INTEGER, created_at INTEGER, updated_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS games_time ON games (ends_at, starts_at)',
    `CREATE TABLE IF NOT EXISTS blocks (
      id TEXT PRIMARY KEY, tables TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, label TEXT, type TEXT,
      created_by TEXT, created_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS blocks_time ON blocks (ends_at, starts_at)',
    `CREATE TABLE IF NOT EXISTS credits (
      id TEXT PRIMARY KEY, game_id TEXT NOT NULL, customer_id TEXT, players INTEGER NOT NULL, amount INTEGER NOT NULL,
      status TEXT NOT NULL, note TEXT, created_at INTEGER)`,
    // Hold expiry and the per-email limit run often; these keep them from reading the whole table.
    'CREATE INDEX IF NOT EXISTS bookings_hold ON bookings (status, hold_until)',
    'CREATE INDEX IF NOT EXISTS bookings_email_lower ON bookings (lower(email), ends_at)',
  ],
  // 3 Oct 2026: GM game series and fees, seat names, check-in, shop table openings, event sign-ups, GM profiles,
  // game pictures and the dice roller.
  [
    'ALTER TABLE games ADD COLUMN schedule TEXT',
    'ALTER TABLE games ADD COLUMN series_id TEXT',
    'ALTER TABLE games ADD COLUMN gm_fee INTEGER',
    'ALTER TABLE games ADD COLUMN seat_price INTEGER',
    'ALTER TABLE games ADD COLUMN room TEXT',
    'ALTER TABLE games ADD COLUMN characters TEXT',
    'ALTER TABLE games ADD COLUMN bring TEXT',
    'ALTER TABLE games ADD COLUMN content_notes TEXT',
    'ALTER TABLE games ADD COLUMN session_zero TEXT',
    'ALTER TABLE games ADD COLUMN gm_bio TEXT',
    'ALTER TABLE games ADD COLUMN image_id TEXT',
    'ALTER TABLE games ADD COLUMN fee_approved INTEGER',
    'CREATE INDEX IF NOT EXISTS games_series ON games (series_id)',
    'ALTER TABLE bookings ADD COLUMN party TEXT',
    'ALTER TABLE bookings ADD COLUMN arrived_at INTEGER',
    'CREATE INDEX IF NOT EXISTS bookings_customer ON bookings (customer_id, ends_at)',
    `CREATE TABLE IF NOT EXISTS series (
      id TEXT PRIMARY KEY, schedule TEXT NOT NULL, gm_customer_id TEXT, details TEXT NOT NULL, tables TEXT NOT NULL, clock INTEGER NOT NULL,
      length INTEGER NOT NULL, first_day TEXT NOT NULL, status TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0, image_id TEXT,
      created_at INTEGER, updated_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS openings (
      id TEXT PRIMARY KEY, tables TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, note TEXT, created_by TEXT, created_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS openings_time ON openings (ends_at, starts_at)',
    `CREATE TABLE IF NOT EXISTS event_joins (
      id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, occurrence_id TEXT NOT NULL, event_id TEXT NOT NULL, title TEXT, starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL, people INTEGER NOT NULL, name TEXT, email TEXT, note TEXT, status TEXT NOT NULL, customer_id TEXT,
      arrived_at INTEGER, created_at INTEGER, updated_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS event_joins_occurrence ON event_joins (occurrence_id)',
    'CREATE INDEX IF NOT EXISTS event_joins_time ON event_joins (ends_at, starts_at)',
    'CREATE TABLE IF NOT EXISTS gm_profiles (customer_id TEXT PRIMARY KEY, name TEXT, bio TEXT, updated_at INTEGER)',
    'CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, owner TEXT, created_at INTEGER)',
    `CREATE TABLE IF NOT EXISTS rolls (
      key TEXT NOT NULL, day TEXT NOT NULL, roll INTEGER NOT NULL, prize TEXT, code TEXT, expires_at INTEGER, created_at INTEGER,
      PRIMARY KEY (key, day))`,
  ],
  // 3 Oct 2026, round 3: money owed back is flagged on the booking: 'due' (refund it), 'ask' (a paid no-show: staff
  // decide) or 'done' (refunded).
  [
    'ALTER TABLE bookings ADD COLUMN refund TEXT',
  ],
  // Members: one per Shopify customer who has used the Lair logged in. Their spend is one row per paid order.
  [
    `CREATE TABLE IF NOT EXISTS members (
      customer_id TEXT PRIMARY KEY, name TEXT, first_name TEXT, email TEXT, birthday TEXT, last_seen INTEGER, created_at INTEGER, updated_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS members_email ON members (lower(email))',
    'CREATE INDEX IF NOT EXISTS members_birthday ON members (birthday)',
    `CREATE TABLE IF NOT EXISTS spend (
      order_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, amount INTEGER NOT NULL, source TEXT, created_at INTEGER NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS spend_customer ON spend (customer_id, created_at)',
  ],
  // Members' dice: every daily and bonus roll (one daily roll per Lair day) and every prize they've won.
  [
    `CREATE TABLE IF NOT EXISTS member_rolls (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL, roll INTEGER NOT NULL, prize_id TEXT, created_at INTEGER)`,
    "CREATE UNIQUE INDEX IF NOT EXISTS member_rolls_daily ON member_rolls (customer_id, day) WHERE kind = 'daily'",
    'CREATE INDEX IF NOT EXISTS member_rolls_customer ON member_rolls (customer_id, kind)',
    `CREATE TABLE IF NOT EXISTS prizes (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER, percent INTEGER, code TEXT,
      expires_at INTEGER, status TEXT NOT NULL, period TEXT, note TEXT, created_at INTEGER, updated_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS prizes_customer ON prizes (customer_id, created_at)',
  ],
  // Birthday codes are prizes too (source 'birthday', period = the birthday's year): one per member per birthday.
  [
    "CREATE UNIQUE INDEX IF NOT EXISTS prizes_birthday ON prizes (customer_id, period) WHERE source = 'birthday'",
  ],
  // "Join every session": a player's standing seat at a game series. The seats it makes carry the series id.
  [
    `CREATE TABLE IF NOT EXISTS series_members (
      series_id TEXT NOT NULL, customer_id TEXT NOT NULL, people INTEGER NOT NULL, players TEXT, name TEXT, email TEXT, status TEXT NOT NULL,
      created_at INTEGER, updated_at INTEGER, PRIMARY KEY (series_id, customer_id))`,
    'ALTER TABLE bookings ADD COLUMN series_id TEXT',
    'CREATE INDEX IF NOT EXISTS bookings_series ON bookings (series_id, customer_id)',
  ],
  // Messages from a GM (or staff) to a game's players: kept for the daily limit and the record.
  [
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, game_id TEXT NOT NULL, limit_key TEXT NOT NULL, scope TEXT NOT NULL, text TEXT NOT NULL, recipients INTEGER, sent INTEGER,
      sender TEXT, created_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS messages_limit ON messages (limit_key, created_at)',
  ],
  // Events: entry fees paid online or at the counter (sign-ups get the same payment columns as bookings), and game
  // spots booked as tables linked to the event date.
  [
    'ALTER TABLE event_joins ADD COLUMN pay TEXT',
    'ALTER TABLE event_joins ADD COLUMN paid INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE event_joins ADD COLUMN amount INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE event_joins ADD COLUMN hold_until INTEGER',
    'ALTER TABLE event_joins ADD COLUMN draft_order_id TEXT',
    'ALTER TABLE event_joins ADD COLUMN order_id TEXT',
    'ALTER TABLE event_joins ADD COLUMN refund TEXT',
    'CREATE INDEX IF NOT EXISTS event_joins_hold ON event_joins (status, hold_until)',
    'CREATE INDEX IF NOT EXISTS event_joins_customer ON event_joins (customer_id, ends_at)',
    'ALTER TABLE bookings ADD COLUMN occurrence_id TEXT',
    'CREATE INDEX IF NOT EXISTS bookings_occurrence ON bookings (occurrence_id)',
  ],
  // Round 4: one table of every code (SJ-OWLBEAR-17) for bookings, sign-ups, members and session passes, so no code
  // is ever used twice. The refs already given out (the first release's GOB-7K2QXM) go in too, so a new code can't
  // clash with one. Members keep the code they were first given.
  [
    'CREATE TABLE IF NOT EXISTS codes (key TEXT PRIMARY KEY, code TEXT, kind TEXT, target_id TEXT, created_at INTEGER)',
    "INSERT OR IGNORE INTO codes (key, code, kind, target_id, created_at) SELECT replace(upper(ref), '-', ''), ref, 'booking', id, created_at FROM bookings",
    "INSERT OR IGNORE INTO codes (key, code, kind, target_id, created_at) SELECT replace(upper(ref), '-', ''), ref, 'join', id, created_at FROM event_joins",
    'ALTER TABLE members ADD COLUMN code TEXT',
  ],
];

const BOOKING_COLUMNS = [
  'id', 'ref', 'kind', 'status', 'tables', 'room', 'starts_at', 'ends_at', 'people', 'name', 'email', 'phone', 'notes', 'activity',
  'extras', 'pay', 'paid', 'amount', 'game_id', 'customer_id', 'hold_until', 'draft_order_id', 'order_id', 'party', 'arrived_at',
  'refund', 'series_id', 'occurrence_id', 'created_at', 'updated_at',
];
const GAME_COLUMNS = [
  'id', 'title', 'system', 'gm', 'gm_customer_id', 'gm_email', 'level', 'age', 'tags', 'safety', 'pregens', 'blurb', 'tables',
  'starts_at', 'ends_at', 'seats', 'status', 'credited', 'schedule', 'series_id', 'gm_fee', 'seat_price', 'room', 'characters', 'bring',
  'content_notes', 'session_zero', 'gm_bio', 'image_id', 'fee_approved', 'created_at', 'updated_at',
];
/** Insert, or update everything except id and created_at. A clash on ref fails loudly instead of replacing a row. */
const upsert = (table, columns) =>
  `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
   ON CONFLICT(id) DO UPDATE SET ${columns.filter((c) => c !== 'id' && c !== 'created_at').map((c) => `${c} = excluded.${c}`).join(', ')}`;
const SAVE_BOOKING = upsert('bookings', BOOKING_COLUMNS);
const SAVE_GAME = upsert('games', GAME_COLUMNS);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const trimmed = (v, max) => String(v ?? '').trim().slice(0, max);
const YEAR = 365 * 24 * HOUR;

export class Lair {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.baseEnv = env;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.shopify = new ShopifyAdmin(env, ctx.storage);
    this.credentials = [env.SHOP, env.SHOPIFY_CLIENT_ID, env.SHOPIFY_CLIENT_SECRET].join('|');
    this.statusSeen = {};
    this.rulesCache = null;
    this.rulesLoadedAt = 0;
    this.people = new Map();
    this.recent = new Map();
    this.webhookRetryAt = 0;
    this.version = 0;
    this.stateCache = new Map();
    this.migrate();
  }

  /* ---------------- settings from the config database ---------------- */
  /** Pick up config changes (new Shopify credentials, email keys) without a redeploy. */
  async useConfig() {
    const env = await withConfig(this.baseEnv);
    const credentials = [env.SHOP, env.SHOPIFY_CLIENT_ID, env.SHOPIFY_CLIENT_SECRET].join('|');
    if (credentials !== this.credentials) {
      this.shopify = new ShopifyAdmin(env, this.ctx.storage);
      this.credentials = credentials;
      this.people.clear();
      this.rulesCache = null;
      this.webhookRetryAt = 0;
    }
    this.env = env;
  }

  /** Write to the status table only when something changed, so the health check costs almost nothing. */
  note(entries) {
    const changed = {};
    for (const [key, value] of Object.entries(entries)) {
      const text = JSON.stringify(value);
      if (this.statusSeen[key] !== text) {
        this.statusSeen[key] = text;
        changed[key] = value;
      }
    }
    if (Object.keys(changed).length) this.later(recordStatus(this.env, changed));
  }

  /* ---------------- storage ---------------- */
  migrate() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    const row = this.sql.exec("SELECT value FROM meta WHERE key = 'schema'").toArray()[0];
    for (let version = row ? Number(row.value) : 0; version < MIGRATIONS.length; version += 1) {
      for (const statement of MIGRATIONS[version]) this.sql.exec(statement);
      this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)", String(version + 1));
    }
  }

  /** Every write goes through here, so cached floor data is dropped the moment anything changes. */
  write(query, ...bindings) {
    this.sql.exec(query, ...bindings);
    this.version += 1;
    this.stateCache.clear();
  }

  rowToBooking(r) {
    return {
      id: r.id, ref: r.ref, kind: r.kind, status: r.status, tables: parse(r.tables, []), room: r.room, start: r.starts_at, end: r.ends_at,
      people: r.people, name: r.name, email: r.email, phone: r.phone, notes: r.notes, activity: r.activity, extras: parse(r.extras, []),
      pay: r.pay, paid: Boolean(r.paid), amount: r.amount, gameId: r.game_id, customerId: r.customer_id, holdUntil: r.hold_until,
      draftOrderId: r.draft_order_id, orderId: r.order_id, party: parse(r.party, []), arrivedAt: r.arrived_at || null,
      // refund: null, 'ask' (staff decide), 'due' (refund it) or 'done' (refunded): one field everywhere.
      refund: r.refund || null, seriesId: r.series_id || null, occurrenceId: r.occurrence_id || null,
    };
  }

  rowToGame(r) {
    return {
      id: r.id, title: r.title, system: r.system, gm: r.gm, gmCustomerId: r.gm_customer_id, gmEmail: r.gm_email, level: r.level, age: r.age,
      tags: parse(r.tags, []), safety: parse(r.safety, []), pregens: Boolean(r.pregens), blurb: r.blurb, tables: parse(r.tables, []),
      start: r.starts_at, end: r.ends_at, seats: r.seats, status: r.status, credited: r.credited,
      schedule: r.schedule || 'one-shot', seriesId: r.series_id || null, gmFee: r.gm_fee ?? null, seatPrice: r.seat_price ?? null, room: r.room || null,
      characters: r.characters || '', bring: r.bring || '', contentNotes: r.content_notes || '', sessionZero: r.session_zero || '',
      gmBio: r.gm_bio || '', imageId: r.image_id || null, feeApproved: Boolean(r.fee_approved),
    };
  }

  rowToBlock(r) {
    return { id: r.id, tables: parse(r.tables, []), start: r.starts_at, end: r.ends_at, label: r.label, type: r.type };
  }

  rowToOpening(r) {
    return { id: r.id, tables: parse(r.tables, []), start: r.starts_at, end: r.ends_at, note: r.note || '' };
  }

  rowToJoin(r) {
    return {
      id: r.id, ref: r.ref, occurrenceId: r.occurrence_id, eventId: r.event_id, title: r.title, start: r.starts_at, end: r.ends_at,
      people: r.people, name: r.name, email: r.email, note: r.note || '', status: r.status, customerId: r.customer_id, arrivedAt: r.arrived_at || null,
      pay: r.pay || 'day', paid: Boolean(r.paid), amount: r.amount || 0, holdUntil: r.hold_until || null, draftOrderId: r.draft_order_id || null,
      orderId: r.order_id || null, refund: r.refund || null,
    };
  }

  joinById(id) {
    const row = this.sql.exec('SELECT * FROM event_joins WHERE id = ? OR ref = ?', id, id).toArray()[0];
    return row ? this.rowToJoin(row) : null;
  }

  /**
   * A sign-up as its owner sees it. payment: how it is or will be paid ('online' once it went to checkout, otherwise
   * 'store', at the counter). refund: null, 'ask' (staff decide), 'due' or 'done'.
   */
  joinView(j) {
    return {
      id: j.id, ref: j.ref, occurrenceId: j.occurrenceId, title: j.title, start: j.start, end: j.end, people: j.people, name: j.name, status: j.status,
      pay: j.pay, paid: j.paid, amount: j.amount, payment: j.pay === 'now' ? 'online' : 'store', refund: j.refund || null,
    };
  }

  /** A sign-up as staff see it */
  staffJoinView(j) {
    return {
      ...this.joinView(j), email: j.email, note: j.note, arrivedAt: j.arrivedAt, customerId: j.customerId || null, orderId: j.orderId || null,
      due: j.paid ? 0 : j.amount || 0,
    };
  }

  /** A game picture's public address (pictures are served by the Worker at /img/<id>) */
  imageUrl(id) {
    return id ? `${String(this.env.PUBLIC_URL || '').replace(/\/$/, '')}/img/${id}` : null;
  }

  /** The public view of a game, with its picture */
  gameView(g, st, rules) {
    return { ...publicGame(g, st, rules), image: this.imageUrl(g.imageId) };
  }

  /** Who's in a game's seats (for its GM and for staff) */
  gamePlayers(st, gameId) {
    return st.bookings
      .filter((b) => b.gameId === gameId && b.kind === 'gm-seat' && ACTIVE.has(b.status))
      .flatMap((b) => {
        const party = b.party?.length ? b.party : [{ name: b.name, character: '' }];
        return party.map((p) => ({ name: p.name, character: p.character || '', ref: b.ref, paid: b.paid, arrived: Boolean(b.arrivedAt) || b.status === 'seated' }));
      });
  }

  /** Everything that touches the window [from, to) */
  state(from, to) {
    return {
      bookings: this.sql.exec('SELECT * FROM bookings WHERE ends_at > ? AND starts_at < ?', from, to).toArray().map((r) => this.rowToBooking(r)),
      games: this.sql.exec('SELECT * FROM games WHERE ends_at > ? AND starts_at < ?', from, to).toArray().map((r) => this.rowToGame(r)),
      blocks: this.sql.exec('SELECT * FROM blocks WHERE ends_at > ? AND starts_at < ?', from, to).toArray().map((r) => this.rowToBlock(r)),
      openings: this.sql.exec('SELECT * FROM openings WHERE ends_at > ? AND starts_at < ?', from, to).toArray().map((r) => this.rowToOpening(r)),
    };
  }

  /** The floor is polled by every open booking page; serve repeats from memory until something changes. */
  cachedState(from, to) {
    const key = `${from}:${to}`;
    const hit = this.stateCache.get(key);
    if (hit && hit.version === this.version && Date.now() - hit.at < STATE_TTL) return hit.st;
    const st = this.state(from, to);
    if (this.stateCache.size > 10) this.stateCache.clear();
    this.stateCache.set(key, { version: this.version, at: Date.now(), st });
    return st;
  }

  saveBooking(b, now) {
    this.write(
      SAVE_BOOKING,
      b.id, b.ref, b.kind, b.status, JSON.stringify(b.tables), b.room || null, b.start, b.end, b.people, b.name || null, b.email || null,
      b.phone || null, b.notes || null, b.activity || null, JSON.stringify(b.extras || []), b.pay || 'day', b.paid ? 1 : 0, b.amount || 0,
      b.gameId || null, b.customerId || null, b.holdUntil || null, b.draftOrderId || null, b.orderId || null,
      b.party?.length ? JSON.stringify(b.party) : null, b.arrivedAt || null, b.refund || null, b.seriesId || null, b.occurrenceId || null, now, now,
    );
  }

  saveGame(g, now) {
    this.write(
      SAVE_GAME,
      g.id, g.title, g.system, g.gm, g.gmCustomerId || null, g.gmEmail || null, g.level, g.age, JSON.stringify(g.tags || []),
      JSON.stringify(g.safety || []), g.pregens ? 1 : 0, g.blurb, JSON.stringify(g.tables), g.start, g.end, g.seats, g.status,
      g.credited ?? null, g.schedule || 'one-shot', g.seriesId || null, g.gmFee ?? null, g.seatPrice ?? null, g.room || null,
      g.characters || null, g.bring || null, g.contentNotes || null, g.sessionZero || null, g.gmBio || null, g.imageId || null,
      g.feeApproved ? 1 : 0, now, now,
    );
  }

  booking(id) {
    const row = this.sql.exec('SELECT * FROM bookings WHERE id = ? OR ref = ?', id, id).toArray()[0];
    return row ? this.rowToBooking(row) : null;
  }

  game(id) {
    const row = this.sql.exec('SELECT * FROM games WHERE id = ?', id).toArray()[0];
    return row ? this.rowToGame(row) : null;
  }

  gameBookings(gameId) {
    return this.sql.exec('SELECT * FROM bookings WHERE game_id = ?', gameId).toArray().map((r) => this.rowToBooking(r));
  }

  /* ---------------- codes (SJ-OWLBEAR-17) ---------------- */
  codeTaken(key) {
    return this.sql.exec('SELECT 1 AS n FROM codes WHERE key = ?', key).toArray().length > 0;
  }

  /**
   * A new code for a booking ('booking'), event sign-up ('join'), member or pass, from the person's name. It goes in
   * the codes table straight away, so it's never given out again. No awaits.
   */
  newCode(name, kind, targetId, now = Date.now()) {
    const code = uniqueCode(name, (key) => this.codeTaken(key));
    this.write('INSERT INTO codes (key, code, kind, target_id, created_at) VALUES (?, ?, ?, ?, ?)', codeKey(code), code, kind, String(targetId), now);
    return code;
  }

  /**
   * What a scanned or typed code belongs to: { type: 'booking'|'join'|'member'|'pass', item }, or null. Case, spaces,
   * dashes, dots and underscores don't matter. A member's old code (staff gave them a new one) no longer counts. The
   * first release's GOB-7K2QXM refs are matched on the booking or sign-up itself, with or without the dash.
   */
  findCode(text) {
    for (const key of codeKeys(text)) {
      const row = this.sql.exec('SELECT * FROM codes WHERE key = ?', key).toArray()[0];
      const found = row ? this.codeTarget(row) : null;
      if (found) return found;
    }
    for (const ref of legacyRefs(text)) {
      const booking = this.sql.exec('SELECT * FROM bookings WHERE ref = ?', ref).toArray()[0];
      if (booking) return { type: 'booking', item: this.rowToBooking(booking) };
      const join = this.sql.exec('SELECT * FROM event_joins WHERE ref = ?', ref).toArray()[0];
      if (join) return { type: 'join', item: this.rowToJoin(join) };
    }
    return null;
  }

  codeTarget(row) {
    if (row.kind === 'booking') {
      const found = this.sql.exec('SELECT * FROM bookings WHERE id = ?', row.target_id).toArray()[0];
      return found ? { type: 'booking', item: this.rowToBooking(found) } : null;
    }
    if (row.kind === 'join') {
      const found = this.sql.exec('SELECT * FROM event_joins WHERE id = ?', row.target_id).toArray()[0];
      return found ? { type: 'join', item: this.rowToJoin(found) } : null;
    }
    if (row.kind === 'member') {
      const member = this.memberRow(row.target_id);
      return member && codeKey(member.code) === row.key ? { type: 'member', item: member } : null;
    }
    if (row.kind === 'pass') {
      const found = this.sql.exec('SELECT * FROM passes WHERE id = ?', row.target_id).toArray()[0];
      return found ? { type: 'pass', item: found } : null;
    }
    return null;
  }

  /** A booking or event sign-up by its id or code (an order's _booking property, a staff link) */
  bookingOrJoin(ref) {
    const booking = this.booking(ref);
    if (booking) return { type: 'booking', item: booking };
    const join = this.joinById(ref);
    if (join) return { type: 'join', item: join };
    const found = this.findCode(ref);
    return found && ['booking', 'join'].includes(found.type) ? found : null;
  }

  later(promise) {
    const safe = Promise.resolve(promise).catch((error) => console.error('Lair background task failed', error));
    this.ctx.waitUntil?.(safe);
    return safe;
  }

  /** Stop an unpaid checkout link working. A checkout that was just paid is left alone; its webhook records the payment. */
  dropDraft(booking) {
    if (booking.draftOrderId && !booking.paid && this.shopify.configured) this.later(this.shopify.deleteDraftIfOpen(booking.draftOrderId));
  }

  /** Unpaid holds lapse after HOLD_MINUTES; their draft orders are deleted so the payment link stops working. */
  expireHolds(now) {
    const expired = this.sql.exec("SELECT * FROM bookings WHERE status = 'held' AND hold_until < ?", now).toArray();
    for (const row of expired) {
      this.write("UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE id = ?", now, row.id);
      this.dropDraft(this.rowToBooking(row));
    }
    // Event sign-ups waiting for their entry fee lapse the same way.
    const lapsed = this.sql.exec("SELECT * FROM event_joins WHERE status = 'held' AND hold_until < ?", now).toArray();
    for (const row of lapsed) {
      this.write("UPDATE event_joins SET status = 'cancelled', updated_at = ? WHERE id = ?", now, row.id);
      this.dropDraft(this.rowToJoin(row));
    }
  }

  /**
   * Make sure Shopify tells us about paid orders. Runs on its own when the store first talks to the app and
   * re-checks once a day; /setup forces a check. After a failure it waits 10 minutes before trying again.
   */
  async ensureWebhook(url, { force = false } = {}) {
    if (!this.shopify.configured || !url) return { ok: false, reason: 'Shopify is not connected yet.' };
    if (!force && Date.now() < this.webhookRetryAt) return { ok: false, reason: 'Waiting to retry.' };
    const saved = await this.ctx.storage.get?.('webhook');
    if (!force && saved?.url === url && Date.now() - saved.checkedAt < 24 * HOUR) return { ok: true, url };
    this.webhookRetryAt = Date.now() + 10 * MIN;
    try {
      const existing = await this.shopify.webhookUris();
      if (!existing.includes(url)) {
        const result = await this.shopify.registerWebhook(url);
        const errors = result?.userErrors || [];
        if (errors.length && !errors.some((e) => /taken|already/i.test(e.message))) {
          console.error('Lair: payment webhook not registered', errors);
          return { ok: false, reason: errors.map((e) => e.message).join('; ') };
        }
      }
      await this.ctx.storage.put?.('webhook', { url, checkedAt: Date.now() });
      this.webhookRetryAt = 0;
      return { ok: true, url };
    } catch (error) {
      console.error('Lair: payment webhook not registered', error);
      return { ok: false, reason: String(error.message || error) };
    }
  }

  /* ---------------- rules and people ---------------- */
  async rules() {
    if (this.rulesCache && Date.now() - this.rulesLoadedAt < RULES_TTL) return this.rulesCache;
    let rules = null;
    let source = 'built-in defaults';
    if (this.shopify.configured) {
      try {
        const { rooms, events, settingsText, theme, shop } = await this.shopify.loadLairData(this.env.THEME_ID);
        const settings = settingsText ? readSettingsData(settingsText) : {};
        rules = rulesFromSettings(settings, rooms.length ? rooms : FALLBACK_ROOMS, events, shop || {});
        const hasLair = Object.keys(settings).some((key) => key.startsWith('lair_'));
        source = theme && hasLair ? `theme "${theme.name}" (${theme.id}${theme.live ? ', live' : ', preview'})` : 'Shopify rooms, default rules (no theme has the booking settings)';
      } catch (error) {
        console.error('Lair: could not load settings from Shopify', error);
      }
    }
    if (rules || !this.rulesCache) {
      this.rulesCache = rules || rulesFromSettings({}, FALLBACK_ROOMS, []);
      this.rulesSource = source;
    }
    // After a failed load, keep what we had and try again in a minute rather than on every request.
    this.rulesLoadedAt = rules || !this.shopify.configured ? Date.now() : Date.now() - RULES_TTL + MIN;
    const r = this.rulesCache;
    this.note({
      rules: {
        source: this.rulesSource,
        timezone: r.tz,
        rooms: r.rooms.map((room) => `${room.name}: ${room.tables.length} × ${room.seats} seats, $${room.price / 100}${room.minPeople ? `, min ${room.minPeople} people` : ''}${room.bookable ? '' : ', not bookable online'}`),
        hours: Object.entries(r.hours).map(([day, h]) => `${day} ${h ? `${String(Math.floor(h[0] / 60)).padStart(2, '0')}:${String(h[0] % 60).padStart(2, '0')}-${String(Math.floor(h[1] / 60)).padStart(2, '0')}:${String(h[1] % 60).padStart(2, '0')}` : 'closed'}`),
        refundHours: r.refundHours,
        events: r.events.length,
      },
    });
    return this.rulesCache;
  }

  /** Staff and trusted GMs are customers tagged "staff" or "gm" in Shopify. */
  async person(customerId) {
    if (!customerId) return { customerId: null, staff: false, gm: false };
    const cached = this.people.get(customerId);
    if (cached && Date.now() - cached.at < PERSON_TTL) return cached.person;
    let tags = [];
    let ok = true;
    try {
      tags = this.shopify.configured ? await this.shopify.customerTags(customerId) : [];
    } catch (error) {
      ok = false;
      console.error('Lair: could not read customer tags', error);
    }
    const person = { customerId, staff: tags.includes('staff'), gm: tags.includes('gm') };
    if (ok) {
      if (this.people.size > 500) this.people.clear();
      this.people.set(customerId, { at: Date.now(), person });
    }
    return person;
  }

  /** A soft limit per client address, so one person can't flood the floor with fake bookings. */
  checkRate(who, client, now) {
    if (who.staff || !client) return;
    const hits = (this.recent.get(client) || []).filter((t) => now - t < 10 * MIN);
    if (hits.length >= LIMITS.perClientPer10Min) throw new RuleError('Too many bookings in a short time. Call us and we will sort it out.', 429);
    hits.push(now);
    if (this.recent.size > 2000) this.recent.clear();
    this.recent.set(client, hits);
  }

  /* ---------------- HTTP ---------------- */
  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      await this.useConfig();
      this.expireHolds(Date.now());
      const [a, b, c] = parts;
      if (a === 'internal') {
        if (request.headers.get('X-Lair-Internal') !== '1') return json({ error: 'Not found' }, 404);
        if (request.method === 'GET' && b === 'img') return this.image(c);
        if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
        const body = await request.json().catch(() => ({}));
        if (b === 'orders-paid') return json(await this.ordersPaid(body));
        if (b === 'setup') return json(await this.checkConnection(body.webhookUrl, { force: true, testEmail: body.testEmail === true }));
        if (b === 'maintenance') return json(await this.checkConnection(body.webhookUrl, { force: false }));
        // The POS extension's routes: the Worker has checked the POS session token, so these act for staff.
        if (b === 'pos' && c === 'checkin') return json(await this.posCheckIn(body));
        if (b === 'pos' && c === 'member') return json(await this.posMember(body));
        return json({ error: 'Not found' }, 404);
      }
      const origin = request.headers.get('X-Lair-Origin');
      if (origin) {
        this.later(this.ensureWebhook(`${origin}/webhooks/orders-paid`));
        // For the status page: did the website reach a booking route, and through which store address?
        const day = new Date().toISOString().slice(0, 10);
        const prefix = url.searchParams.get('path_prefix') || null;
        const known = (request.method === 'GET' && ['floor', 'me', 'members'].includes(a))
          || (request.method === 'POST' && ['bookings', 'games', 'series', 'blocks', 'openings', 'checkin', 'events', 'contact', 'roll', 'gm-profile', 'me', 'members'].includes(a));
        this.note(known ? { proxy: { seen: true, prefix, day } } : { proxyMiss: { path: url.pathname, method: request.method, prefix, day } });
      }
      const who = await this.person(request.headers.get('X-Lair-Customer') || '');
      const client = request.headers.get('X-Lair-Client') || '';
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      if (request.method === 'GET' && a === 'floor') return json(await this.floor(url, who));
      if (request.method === 'GET' && a === 'me' && !b) return json(await this.me(who));
      if (request.method === 'GET' && a === 'members' && !b) return json(this.members(url, who));
      if (request.method === 'GET' && a === 'members' && b === 'birthdays') return json(await this.birthdayList(who));
      if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
      const d = parts[3];
      if (a === 'me' && b === 'profile') return json(await this.saveProfile(body, who));
      if (a === 'members' && b && c === 'new-code') return json(await this.newMemberCode(decodeURIComponent(b), who));
      if (a === 'bookings' && !b) return json(await this.createBooking(body, who, client));
      if (a === 'bookings' && c === 'update') return json(await this.updateBooking(b, body, who));
      if (a === 'games' && !b) return json(await this.createGame(body, who, client));
      if (a === 'games' && c === 'update') return json(await this.updateGame(b, body, who));
      if (a === 'games' && c === 'credit') return json(await this.creditGm(b, who));
      if (a === 'games' && c === 'sessions') return json(await this.addSession(b, body, who));
      if (a === 'games' && c === 'join-series') return json(await this.joinSeries(b, body, who, client));
      if (a === 'games' && c === 'message') return json(await this.messagePlayers(b, body, who));
      if (a === 'games' && c === 'edit') return json(await this.editGame(b, body, who));
      if (a === 'games' && c === 'players') return json(await this.addPlayers(b, body, who));
      if (a === 'series' && c === 'leave') return json(await this.leaveSeries(b, who));
      if (a === 'games' && c === 'image') return json(await this.gameImage(b, body, who));
      if (a === 'gm-profile' && !b) return json(await this.saveGmProfile(body, who));
      if (a === 'blocks' && !b) return json(await this.createBlock(body, who));
      if (a === 'blocks' && c === 'delete') return json(await this.removeBlock(b, who));
      if (a === 'openings' && !b) return json(await this.createOpening(body, who));
      if (a === 'openings' && c === 'delete') return json(await this.removeOpening(b, who));
      if (a === 'checkin' && !b) return json(await this.checkIn(body, who));
      if (a === 'events' && b === 'joins' && d === 'cancel') return json(await this.cancelJoin(c, who));
      if (a === 'events' && b && c === 'join') return json(await this.joinEvent(decodeURIComponent(b), body, who, client));
      if (a === 'events' && b && c === 'reserve') return json(await this.reserveSpot(decodeURIComponent(b), body, who, client));
      if (a === 'contact' && !b) return json(await this.contact(body, who, client));
      if (a === 'roll' && !b) return json(await this.roll(body, who, client));
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      if (error instanceof RuleError) return json({ error: error.message }, error.status);
      console.error('Lair error', error);
      this.note({ lastError: { message: String(error.message || error).slice(0, 300), path: url.pathname, at: new Date().toISOString() } });
      return json({ error: 'Something went wrong on our side. Please try again or call us.' }, 500);
    }
  }

  requireStaff(who) {
    if (!who.staff) throw new RuleError('Staff only. Log in with your staff account.', 403);
  }

  async floor(url, who) {
    const rules = await this.rules();
    const now = Date.now();
    const from = Math.max(Number(url.searchParams.get('from')) || now - 24 * HOUR, now - 31 * 24 * HOUR);
    const to = Math.min(Number(url.searchParams.get('to')) || now + rules.horizonDays * 24 * HOUR, now + 400 * 24 * HOUR);
    const st = this.cachedState(from, to);
    const view = (bk) => {
      if (who.staff) return bk;
      if (who.customerId && bk.customerId === who.customerId) return { ...publicBooking(bk), ref: bk.ref, name: bk.name, people: bk.people, paid: bk.paid };
      return publicBooking(bk);
    };
    const visibleGames = st.games.filter(
      (g) => who.staff || ['open', 'full'].includes(g.status) || (who.customerId && g.gmCustomerId === who.customerId && g.status === 'pending'),
    );
    // Calendar events that hold tables, resolved exactly the way bookings are checked.
    const eventHolds = blockingItems({ blocks: [] }, rules, from, to)
      .filter((e) => e.tables.length)
      .map((e) => ({ ...e, eventId: e.id.replace(/^ev-/, '').replace(/@.*$/, ''), occurrenceId: e.id.replace(/^ev-/, ''), type: 'event' }));
    const joinRows = this.sql
      .exec("SELECT * FROM event_joins WHERE ends_at > ? AND starts_at < ? AND status != 'cancelled'", from, to)
      .toArray()
      .map((r) => this.rowToJoin(r));
    const eventJoins = {};
    for (const j of joinRows) eventJoins[j.occurrenceId] = (eventJoins[j.occurrenceId] || 0) + j.people;
    // Event dates with game spots: how many there are and how many are taken (by anyone, through any booking).
    const eventSpots = {};
    for (const o of eventOccurrences(rules, from, to)) {
      const total = parseSpots(o.gameTables, rules.rooms).length;
      if (total) eventSpots[o.id] = { total, taken: total - this.freeSpots(o, rules, st).length };
    }
    return {
      now,
      bookings: st.bookings.filter((bk) => who.staff || ACTIVE.has(bk.status)).map(view),
      blocks: who.staff ? st.blocks : st.blocks.map((bl) => ({ ...bl, label: PUBLIC_HOLD[bl.type] || 'Reserved' })),
      eventHolds,
      games: visibleGames.map((g) => {
        const game = this.gameView(g, st, rules);
        if (who.staff || (who.customerId && g.gmCustomerId === who.customerId)) game.players = this.gamePlayers(st, g.id);
        return game;
      }),
      events: [],
      eventJoins,
      eventSpots,
      ...(who.staff ? { joins: joinRows.map((j) => this.staffJoinView(j)) } : {}),
      shopTables: rules.shopTables || [],
      openings: st.openings.map((o) => (who.staff ? o : { id: o.id, tables: o.tables, start: o.start, end: o.end })),
      staff: who.staff,
      // payOnline: Shopify checkout works, for events paid online. Tables, seats and walk-ins are paid at the counter.
      features: { email: emailReady(this.env), payOnline: this.shopify.configured },
    };
  }

  async createBooking(input, who, client = '') {
    if (input.kind === 'gm-seat' && !who.customerId) throw new RuleError('Log in to join a game.', 401);
    const rules = await this.rules();
    // --- no awaits from here until the booking is saved ---
    const now = Date.now();
    const time = new LairTime(rules.tz);
    const st = this.state(now - 24 * HOUR, now + (rules.horizonDays + 2) * 24 * HOUR);
    const kind = input.kind === 'gm-seat' ? 'gm-seat' : input.kind === 'walkin' ? 'walkin' : 'table';
    if (kind === 'walkin') this.requireStaff(who);
    // The public booking page applies the house rules to everyone, staff included. Only the staff page skips them:
    // walk-ins, and table bookings sent with staffOverride. Those are made for someone else, so they aren't linked
    // to the staff member's own account.
    const override = Boolean(who.staff) && (kind === 'walkin' || (kind === 'table' && input.staffOverride === true));
    this.checkRate(who, client, now);
    let booking;
    let game = null;
    if (kind === 'gm-seat') {
      const seat = checkSeatBooking(input, { state: st, rules, now });
      game = seat.game;
      booking = {
        kind, gameId: game.id, tables: seat.tables, room: tableIndex(rules.rooms).get(seat.tables[0])?.roomObj.id, start: seat.start,
        end: seat.end, people: seat.people, name: seat.name, email: seat.email, amount: seat.amount, activity: 'rpg', party: seat.players,
      };
    } else {
      const checked = checkTableBooking(input, { state: st, rules, time, now, staff: override });
      booking = { kind, ...checked };
    }
    if (!who.staff) this.checkEmailLimit(booking.email, now);
    // Tables, walk-ins and game seats are paid at the counter on the day (show the code, we ring it up): `pay` is ignored.
    const id = makeId('bk');
    Object.assign(booking, {
      id, ref: this.newCode(trimmed(input.name, 80), 'booking', id, now), pay: 'day', paid: kind === 'walkin' ? Boolean(input.paid) : false,
      status: kind === 'walkin' ? 'seated' : 'confirmed', holdUntil: null, customerId: override ? null : who.customerId || null,
    });
    this.saveBooking(booking, now);
    if (!override) this.touchMember(who.customerId, { name: booking.name, email: booking.email }, now);
    // --- saved: the table is ours ---

    return this.payOrConfirm(booking, rules, { game });
  }

  /** At most 6 upcoming bookings per email for anyone but staff (seats from "join every session" don't count). */
  checkEmailLimit(email, now) {
    if (!email) return;
    const active = this.sql
      .exec("SELECT COUNT(*) AS n FROM bookings WHERE lower(email) = lower(?) AND ends_at > ? AND status IN ('held', 'confirmed') AND series_id IS NULL", email, now)
      .one().n;
    if (active >= LIMITS.activePerEmail) throw new RuleError(`You already have ${active} bookings coming up. Call us to book more.`, 429);
  }

  /**
   * How an event sells its entry or a game spot (the event's `payment`): 'store' at the counter; 'online' always
   * through checkout, refused with a 503 when Shopify can't make one; 'either' online when they ask (pay: 'now'), at
   * the counter otherwise. No awaits.
   */
  paymentPlan(payment, pay) {
    const online = payment === 'online' || (payment === 'either' && pay === 'now');
    if (payment === 'online' && !this.shopify.configured) throw new RuleError(ONLINE_DOWN, 503);
    return { wantsPayNow: online, payNow: online && this.shopify.configured, required: payment === 'online' };
  }

  /**
   * After a booking is saved: send it to checkout (an event game spot paid online) or email the confirmation. If
   * Shopify can't make the checkout, the booking stays, to be paid at the counter; unless online is the only way
   * (required), and then it's taken back and refused.
   */
  async payOrConfirm(saved, rules, { game = null, wantsPayNow = false, payNow = false, required = false, title = null } = {}) {
    let booking = saved;
    let notice = wantsPayNow && !payNow ? "Online payment isn't available, so pay at the counter. Your booking is confirmed." : null;
    if (payNow) {
      try {
        const { draftOrderId, checkoutUrl } = await this.shopify.createCheckout({
          ref: booking.ref,
          title: title || (booking.kind === 'gm-seat' ? `GM game seat: ${game.title}` : `Lair table fee (${booking.tables.join(', ')})`),
          unitPrice: Math.round(booking.amount / booking.people),
          quantity: booking.people,
          email: booking.email,
          currency: this.env.CURRENCY || 'NZD',
          attributes: {
            Booking: booking.ref, When: this.when(booking, rules), Tables: booking.tables.join(', '), Name: booking.name,
            Cancelling: "Paid online, so you're locked in. Have a chat with us if plans change.",
          },
        });
        this.write('UPDATE bookings SET draft_order_id = ?, updated_at = ? WHERE id = ?', draftOrderId, Date.now(), booking.id);
        const fresh = this.booking(booking.id);
        if (fresh.status === 'held') return { booking: this.ownView(fresh), checkoutUrl, holdMinutes: HOLD_MINUTES };
        this.dropDraft(fresh);
        return { booking: this.ownView(fresh), notice: 'This booking changed while we set up payment. Please call us.' };
      } catch (error) {
        console.error('Lair: checkout could not be created', error);
        if (required) {
          // --- only this booking's own row changes: it was never confirmed, so it goes ---
          this.write("DELETE FROM bookings WHERE id = ? AND status = 'held' AND paid = 0", booking.id);
          throw new RuleError(ONLINE_DOWN, 503);
        }
        this.write(
          "UPDATE bookings SET pay = 'day', status = CASE WHEN status = 'held' THEN 'confirmed' ELSE status END, hold_until = NULL, updated_at = ? WHERE id = ?",
          Date.now(), booking.id,
        );
        booking = this.booking(booking.id);
        notice = "Online payment isn't working right now, so pay at the counter. Your booking is confirmed.";
      }
    }
    const emailed = booking.kind !== 'walkin' && booking.status === 'confirmed' && this.confirm(booking, rules, game);
    return { booking: this.ownView(booking), notice, emailed };
  }

  when(booking, rules) {
    const time = new LairTime(rules.tz);
    const clock = new Intl.DateTimeFormat('en-NZ', { timeZone: rules.tz, hour: 'numeric', minute: '2-digit' });
    return `${time.label(booking.start)} to ${clock.format(new Date(booking.end))}`;
  }

  /* ---------------- email ---------------- */
  /** A link into the website, for email buttons */
  link(path) {
    return `${String(this.env.STORE_URL || 'https://www.dicegoblin.nz').replace(/\/$/, '')}${path || '/'}`;
  }

  /** A finished email: the layout with the shop's address, phone and hours in the footer. */
  letter(to, subject, content, extra = {}) {
    const rules = this.rulesCache || rulesFromSettings({}, FALLBACK_ROOMS, []);
    const footer = { name: 'Dice Goblin Lair', address: rules.contact?.address, phone: rules.contact?.phone, hours: hoursSummary(rules.hours) };
    return { to, subject, ...renderEmail({ ...content, footer }), ...extra };
  }

  /** Where a page lives on the website (theme settings, with the theme's defaults) */
  page(name) {
    return this.link((this.rulesCache?.pages || rulesFromSettings({}, [], []).pages)[name]);
  }

  /** "Mia (Valeros), Leo" */
  partyLine(party) {
    return (party || []).map((p) => (p.character ? `${p.name} (${p.character})` : p.name)).join(', ');
  }

  /** Booking confirmation email: tables, game seats and event game spots. Returns whether one was sent (needs RESEND_API_KEY and FROM_EMAIL). */
  confirm(booking, rules, game = null) {
    if (!emailReady(this.env) || !isEmail(booking.email)) return false;
    const when = this.when(booking, rules);
    const fee = !booking.amount ? 'Nothing to pay' : booking.paid ? `${dollars(booking.amount)}, paid. Thank you!` : `${dollars(booking.amount)}, pay at the counter`;
    const show = `Show ${booking.ref} at the counter when you arrive (the QR code in My Lair works too).`;
    const changes = booking.paid && booking.pay === 'now'
      ? `Need to cancel? Do it in My Lair or call us at least ${rules.refundHours} hours before, and you'll get your money back. After that the fee can't be refunded.`
      : null;
    const tables = `${booking.tables.length > 1 ? 'Tables' : 'Table'} ${booking.tables.join(', ')}`;
    const event = booking.occurrenceId ? findOccurrence(rules, booking.occurrenceId) : null;
    let subject;
    let content;
    if (game) {
      subject = `Seat saved: ${game.title}, ${when} (${booking.ref})`;
      content = {
        title: 'Your seat is saved!',
        intro: `Kia ora ${booking.name}, you're in for ${game.title}${game.gm ? ` with GM ${game.gm}` : ''}. Gobgob has pulled up a chair for you.`,
        details: [
          ['Game', `${game.title}${game.system ? ` (${game.system})` : ''}`], ['When', when], ['Players', this.partyLine(booking.party)], ['Where', tables],
          ['Fee', fee], ['Ticket', booking.ref],
        ],
        outro: [show, changes || "Can't make it after all? Drop your seat in My Lair and Gobgob will let your GM know."],
      };
    } else {
      const extras = { wargame: 'Wargame (double tables)', bigbox: 'Big box game (double tables)', celebrating: 'Celebrating something' };
      subject = `${event ? `Game spot booked: ${event.title}` : "You're booked"}: ${when} (${booking.ref})`;
      content = {
        title: event ? 'Your game spot is booked!' : "You're booked in!",
        intro: event
          ? `Kia ora ${booking.name}, you've got a game spot at ${event.title}. Gobgob's guarding your tables.`
          : `Kia ora ${booking.name}, your table at the Dice Goblin Lair is booked. Gobgob's already guarding it.`,
        details: [
          ['When', when], ['Where', tables], ['People', String(booking.people)],
          ['Setup', (booking.extras || []).map((x) => extras[x]).filter(Boolean).join(', ')], ['Fee', fee], ['Ticket', booking.ref],
        ],
        outro: [show, changes || 'Plans changed? Cancel in My Lair or give us a call, so someone else can have the table.'],
      };
    }
    this.later(this.mail(this.letter(booking.email, subject, { ...content, button: { label: 'See it in My Lair', url: this.page('myLair') } })));
    return true;
  }

  /** An alert for the team (STAFF_EMAIL). content: { title, intro, details, outro }. */
  notifyStaff(subject, content) {
    if (!emailReady(this.env) || !this.env.STAFF_EMAIL) return;
    this.later(this.mail(this.letter(this.env.STAFF_EMAIL, subject, {
      button: { label: 'Open the staff page', url: this.page('staff') }, signoff: 'Gobgob, keeping an eye on the Lair', ...content,
    })));
  }

  /** Someone cancelled a sign-up or game spot they'd paid online: it was locked in, so staff decide on a refund. */
  askAboutRefund(item, rules, what) {
    const event = item.title || (item.occurrenceId ? findOccurrence(rules, item.occurrenceId)?.title : null);
    this.notifyStaff(`Refund? ${item.ref}`, {
      title: 'A refund to decide',
      intro: `${item.name} cancelled their ${what} ${item.ref}${event ? ` for ${event}` : ''}. They paid online, so it was locked in: it's your call whether to refund it. Have a chat with them, then mark it refunded if you do.`,
      details: [['Code', item.ref], ['Was for', this.when(item, rules)], ['Paid', dollars(item.amount)], ['Order', item.orderId || 'See Orders in Shopify']],
    });
  }

  /** Record an email result in the status table, so a wrong key or an unverified domain shows up there. */
  noteEmail(result) {
    if (!result.attempted) return;
    const day = new Date().toISOString().slice(0, 10);
    this.note({ email: result.ok ? { ok: true, day } : { ok: false, status: result.status, message: result.message, day } });
  }

  /** Send one email */
  async mail(message) {
    const result = await sendEmail(this.env, message);
    this.noteEmail(result);
    return result;
  }

  /** Send many emails in one go (Resend's batch endpoint). Returns { ok, sent, … }. */
  async mailMany(messages) {
    const result = await sendEmails(this.env, messages);
    this.noteEmail(result);
    return result;
  }

  /** A booking as the person who made it sees it. payment and refund as in joinView. */
  ownView(b) {
    return {
      ...publicBooking(b), ref: b.ref, name: b.name, email: b.email, people: b.people, paid: b.paid, amount: b.amount, pay: b.pay, room: b.room,
      extras: b.extras || [], occurrenceId: b.occurrenceId || null, payment: b.pay === 'now' ? 'online' : 'store', refund: b.refund || null,
    };
  }

  async updateBooking(id, patch, who) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const booking = this.booking(id);
    if (!booking) {
      // An event sign-up: staff mark its entry fee paid or refunded here too (cancelling is POST /events/joins/:id/cancel).
      const join = who.staff ? this.joinById(id) : null;
      if (join) return this.updateJoin(join, patch, now);
      throw new RuleError('Booking not found.', 404);
    }
    if (!who.staff) {
      const own = who.customerId && booking.customerId === who.customerId;
      if (own && booking.kind === 'gm') throw new RuleError('To cancel your game, cancel it from the games board.', 403);
      if (!own || patch.status !== 'cancelled' || booking.start <= now) throw new RuleError('Only staff can change that booking.', 403);
      if (booking.status === 'cancelled') return { booking: this.ownView(booking), refund: { due: false, amount: 0, reason: 'already cancelled' } };
      // An event game spot paid online is locked in: cancelling frees the spot and staff decide on a refund. Anything
      // else paid online (from before everything moved to the counter) keeps the cancellation policy it was sold with.
      const lockedIn = Boolean(booking.occurrenceId && booking.paid && booking.pay === 'now');
      const refund = lockedIn
        ? { due: false, ask: true, amount: booking.amount, orderId: booking.orderId || null, reason: 'paid online, so staff decide' }
        : refundFor(booking, rules, now);
      booking.status = 'cancelled';
      booking.holdUntil = null;
      if (booking.refund !== 'done') booking.refund = refund.due ? 'due' : lockedIn ? 'ask' : booking.refund;
      this.saveBooking(booking, now);
      this.dropDraft(booking);
      if (refund.due) {
        this.notifyStaff(`Refund due: ${booking.ref}`, {
          title: 'Refund due',
          intro: `${booking.name} cancelled ${booking.ref} more than ${rules.refundHours} hours ahead, so they get their money back. Refund it in Shopify.`,
          details: [['Booking', booking.ref], ['Was for', this.when(booking, rules)], ['Refund', dollars(refund.amount)], ['Order', refund.orderId || 'See Orders in Shopify']],
        });
      } else if (lockedIn) this.askAboutRefund(booking, rules, 'game spot');
      if (booking.kind === 'gm-seat') this.tellGmSeatDropped(booking, rules);
      return { booking: this.ownView(this.booking(booking.id)), refund, ...(lockedIn ? { notice: LOCKED_IN } : {}) };
    }
    const st = this.state(now - 24 * HOUR, now + (rules.horizonDays + 2) * 24 * HOUR);
    const next = { ...booking };
    if (patch.status && ['confirmed', 'seated', 'done', 'cancelled', 'noshow'].includes(patch.status)) next.status = patch.status;
    if (next.status !== 'held') next.holdUntil = null;
    if (patch.status === 'done') next.end = Math.max(Math.min(next.end, now), next.start);
    if (typeof patch.paid === 'boolean') next.paid = patch.paid;
    if (typeof patch.refunded === 'boolean') {
      if (patch.refunded && !next.paid) throw new RuleError('Only a paid booking can be marked as refunded.');
      next.refund = patch.refunded ? 'done' : null;
    }
    if (patch.people != null) {
      next.people = Math.max(1, Math.min(60, Math.floor(Number(patch.people)) || 1));
      const seatGame = next.kind === 'gm-seat' && next.gameId ? this.game(next.gameId) : null;
      // A game spot keeps its price a person (the event's entry fee, or the table fee).
      const unit = next.kind === 'gm-seat' ? seatGame?.seatPrice || rules.prices.gmSeat
        : next.occurrenceId && booking.people ? Math.round(booking.amount / booking.people)
          : tableIndex(rules.rooms).get(next.tables[0])?.roomObj.price || rules.prices.table;
      next.amount = unit * next.people;
    }
    let moveGame = null;
    if (Array.isArray(patch.tables) || patch.end != null) {
      const tables = Array.isArray(patch.tables) ? [...new Set(patch.tables.map(String))] : next.tables;
      const end = patch.end != null ? Number(patch.end) : next.end;
      if (!Number.isFinite(end) || end <= next.start) throw new RuleError('The new end time must be after the start.');
      const { room } = oneRoom(tables, rules);
      // A GM game's table, GM and players move and stretch together.
      const game = next.gameId ? this.game(next.gameId) : null;
      const together = game ? this.gameBookings(game.id).filter((b) => ACTIVE.has(b.status) || b.id === next.id) : [next];
      const ignore = new Set(together.map((b) => b.id));
      const from = Math.max(now, next.start);
      for (const t of tables) {
        if (end > from && !isFree(st, rules, t, from, end, ignore)) throw new RuleError(`Table ${t} is taken then.`, 409);
      }
      next.tables = tables;
      next.end = end;
      next.room = room.id;
      if (game) moveGame = { game, together, tables, end, room: room.id };
    }
    // Cancelled or a no-show: what's owed back, worked out before saving.
    const ending = ['cancelled', 'noshow'].includes(next.status) && booking.status !== next.status;
    let refund;
    if (ending && next.status === 'cancelled' && booking.occurrenceId && booking.paid && booking.amount > 0) {
      // Staff cancelling an event's game spot (the event's off, or they've sorted it out): what was paid comes back.
      refund = { due: true, amount: booking.amount, orderId: booking.orderId || null, reason: 'cancelled by staff' };
      if (next.refund !== 'done') next.refund = 'due';
    } else if (ending && next.status === 'cancelled') {
      // Paid online and cancelled: the cancellation policy says whether the money goes back.
      refund = refundFor(booking, rules, now);
      if (refund.due && next.refund !== 'done') next.refund = 'due';
    } else if (ending) {
      // A no-show is only recorded: no email and nothing charged. If they'd paid, a "Refund?" note lets staff decide.
      const paid = Boolean(booking.paid && booking.amount > 0);
      refund = { ...refundFor(booking, rules, Infinity), reason: 'no-show', ask: paid };
      if (paid && next.refund !== 'done') {
        next.refund = 'ask';
        if (!(next.notes || '').includes('[Refund?]')) next.notes = `${next.notes ? `${next.notes} ` : ''}[Refund?] Paid, then didn't come: refund it or keep the fee.`;
      }
    }
    // Back on (staff undid a cancellation or a no-show): nothing is owed any more.
    if (['due', 'ask'].includes(next.refund) && !['cancelled', 'noshow'].includes(next.status)) next.refund = null;
    this.saveBooking(next, now);
    if (moveGame) {
      const { game, together, tables, end, room } = moveGame;
      this.write('UPDATE games SET tables = ?, ends_at = ?, updated_at = ? WHERE id = ?', JSON.stringify(tables), end, now, game.id);
      for (const b of together) {
        if (b.id === next.id) continue;
        this.write('UPDATE bookings SET tables = ?, ends_at = ?, room = ?, updated_at = ? WHERE id = ?', JSON.stringify(tables), end, room, now, b.id);
      }
    }
    if (['cancelled', 'noshow'].includes(next.status)) this.dropDraft(next);
    return { booking: this.booking(next.id), refund };
  }

  /** Staff: an event sign-up's { paid, refunded }. refunded: true is 'done', false clears the flag. No awaits. */
  updateJoin(join, patch, now) {
    let { paid, refund } = join;
    if (typeof patch.paid === 'boolean') paid = patch.paid;
    if (typeof patch.refunded === 'boolean') {
      if (patch.refunded && !paid) throw new RuleError('Only a paid sign-up can be marked as refunded.');
      refund = patch.refunded ? 'done' : null;
    }
    this.write('UPDATE event_joins SET paid = ?, refund = ?, updated_at = ? WHERE id = ?', paid ? 1 : 0, refund || null, now, join.id);
    return { join: this.staffJoinView(this.joinById(join.id)) };
  }

  /** A player dropped their own seat: the GM hears about it. */
  tellGmSeatDropped(seat, rules) {
    const game = seat.gameId ? this.game(seat.gameId) : null;
    if (!game || !emailReady(this.env) || !isEmail(game.gmEmail)) return;
    const taken = seatsTaken(this.state(game.start - 1, game.end + 1), game.id);
    this.later(this.mail(this.letter(game.gmEmail, `Seat dropped: ${game.title}, ${this.when(game, rules)}`, {
      title: 'A player dropped out',
      intro: `Kia ora ${game.gm}, ${seat.name} dropped ${seat.people === 1 ? 'their seat' : `their ${seat.people} seats`} at ${game.title}. The spot's back on the games board for someone else.`,
      details: [['Game', game.title], ['When', this.when(game, rules)], ['Players', this.partyLine(seat.party)], ['Seats taken', `${taken} of ${game.seats}`]],
      button: { label: 'See the games board', url: this.page('gm') },
      signoff: 'Gobgob',
    })));
  }

  /** The details every session of a game shares, from one of its sessions */
  gameDetails(g) {
    return {
      title: g.title, gm: g.gm, blurb: g.blurb, seats: g.seats, gmFee: g.gmFee ?? 500, schedule: g.schedule || 'one-shot',
      characters: g.characters || '', system: g.system, level: g.level, age: g.age, tags: g.tags || [], safety: g.safety || [],
      pregens: g.pregens, bring: g.bring || '', contentNotes: g.contentNotes || '', sessionZero: g.sessionZero || '', gmBio: g.gmBio || '',
    };
  }

  /** Save one session of a game and the GM's hold on its tables. No awaits: call it after the checks. */
  saveSession(base, session, now) {
    const game = { id: makeId('gm'), ...base, ...session };
    this.saveGame(game, now);
    const holdId = makeId('bk');
    this.saveBooking({
      id: holdId, ref: this.newCode(game.gm, 'booking', holdId, now), kind: 'gm', gameId: game.id, tables: game.tables, room: game.room, start: game.start, end: game.end,
      people: game.seats + 1, name: `GM ${game.gm}`, status: 'confirmed', pay: 'day', paid: true, amount: 0, activity: 'rpg', customerId: game.gmCustomerId,
    }, now);
    return game;
  }

  /**
   * Add the missing weekly or fortnightly sessions of a series up to the booking horizon. A date whose tables are
   * taken (or that breaks a rule) is skipped and reported. No awaits.
   */
  planSessions(row, rules, now, st) {
    const step = row.schedule === 'weekly' ? 7 : row.schedule === 'fortnightly' ? 14 : 0;
    if (!step) return { created: [], skipped: [] };
    const time = new LairTime(rules.tz);
    const details = parse(row.details, {});
    const tables = parse(row.tables, []);
    const have = new Set(this.sql.exec('SELECT starts_at FROM games WHERE series_id = ?', row.id).toArray().map((r) => time.key(r.starts_at)));
    const lastKey = time.key(now + rules.horizonDays * 24 * HOUR);
    const created = [];
    const skipped = [];
    const sample = this.sql.exec('SELECT * FROM games WHERE series_id = ? ORDER BY starts_at DESC LIMIT 1', row.id).toArray()[0];
    const latest = sample ? this.rowToGame(sample) : null;
    for (let key = row.first_day; key <= lastKey; key = addDays(key, step)) {
      if (have.has(key)) continue;
      const start = time.at(key, row.clock);
      if (start <= now) continue;
      const end = start + row.length;
      try {
        const session = checkGameSession({ tables, start, end }, details, { state: st, rules, time, now, staff: Boolean(details.staffCreated) });
        const base = {
          ...details, gmCustomerId: row.gm_customer_id, gmEmail: details.gmEmail || null, seriesId: row.id, credited: null,
          status: row.approved ? 'open' : 'pending', feeApproved: true,
          imageId: row.image_id || latest?.imageId || null, gmBio: latest?.gmBio ?? details.gmBio,
        };
        const game = this.saveSession(base, session, now);
        this.seatSeriesMembers(game, rules, now);
        created.push(game);
      } catch (error) {
        if (!(error instanceof RuleError)) throw error;
        skipped.push({ start, reason: error.message });
      }
    }
    return { created, skipped };
  }

  /** Once a day, top up every weekly and fortnightly series so its sessions stay bookable as far ahead as anything else. */
  extendSeries(rules, now) {
    const day = new LairTime(rules.tz).key(now);
    if (this.seriesDay === day) return [];
    this.seriesDay = day;
    const rows = this.sql.exec("SELECT * FROM series WHERE status = 'active' AND schedule IN ('weekly', 'fortnightly')").toArray();
    if (!rows.length) return [];
    const st = this.state(now - 24 * HOUR, now + (rules.horizonDays + 2) * 24 * HOUR);
    const report = [];
    for (const row of rows) {
      const { created, skipped } = this.planSessions(row, rules, now, st);
      if (created.length || skipped.length) report.push({ series: row.id, created: created.length, skipped: skipped.length });
      if (skipped.length) {
        const details = parse(row.details, {});
        this.notifyStaff(`Game series needs a table: ${details.title}`, {
          title: 'A game series needs a table',
          intro: `${details.gm}'s ${row.schedule} game ${details.title} couldn't get its tables on these dates. Find them another table on the staff page, or let the GM know.`,
          details: skipped.map((x) => [new LairTime(rules.tz).label(x.start), x.reason]),
        });
      }
    }
    return report;
  }

  async createGame(input, who, client = '') {
    if (!who.customerId && !who.staff) throw new RuleError('Log in to run a game, so we know who to pay your store credit to.', 401);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    this.checkRate(who, client, now);
    const time = new LairTime(rules.tz);
    const st = this.state(now - 24 * HOUR, now + (rules.horizonDays + 2) * 24 * HOUR);
    const details = checkGameDetails(input);
    const first = checkGameSession(input, details, { state: st, rules, time, now, staff: who.staff });
    // Staff can list a game for a GM: gmCustomerId, or gmEmail matched against members. A GM who isn't a member yet
    // still gets the emails, but the game isn't linked to an account (their store credit is added by hand).
    let gmCustomerId = who.customerId;
    let gmEmail = isEmail(input.email) ? trimmed(input.email, 120) : null;
    let notice = null;
    const forGm = Boolean(who.staff && (input.gmCustomerId || input.gmEmail));
    if (forGm) {
      const byEmail = this.memberByEmail(input.gmEmail);
      gmCustomerId = input.gmCustomerId ? trimmed(input.gmCustomerId, 40) : byEmail?.customer_id || null;
      gmEmail = isEmail(input.gmEmail) ? trimmed(input.gmEmail, 120) : this.memberRow(gmCustomerId)?.email || gmEmail;
      if (!gmCustomerId) notice = "No member has that email yet, so this game isn't linked to their account. Add their store credit in Shopify admin after each session.";
    }
    // Staff and trusted GMs (tagged gm) go straight on the board; anyone else waits for a manager's OK. GM fees of
    // $0, $5 and $10 never need one.
    const approved = Boolean(who.staff || who.gm);
    const feeApproved = true;
    const seriesId = details.schedule === 'one-shot' ? null : makeId('sr');
    if (seriesId) {
      this.write(
        `INSERT INTO series (id, schedule, gm_customer_id, details, tables, clock, length, first_day, status, approved, image_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?)`,
        seriesId, details.schedule, gmCustomerId, JSON.stringify({ ...details, gmEmail, staffCreated: Boolean(who.staff) }), JSON.stringify(first.tables),
        time.minutesOf(first.start), first.end - first.start, time.key(first.start), approved ? 1 : 0, now, now,
      );
    }
    const base = { ...details, gmCustomerId, gmEmail, status: approved ? 'open' : 'pending', credited: null, seriesId, feeApproved };
    const game = this.saveSession(base, first, now);
    let skipped = [];
    let sessions = [game];
    if (seriesId && ['weekly', 'fortnightly'].includes(details.schedule)) {
      const row = this.sql.exec('SELECT * FROM series WHERE id = ?', seriesId).one();
      const planned = this.planSessions(row, rules, now, st);
      sessions = [game, ...planned.created];
      skipped = planned.skipped.map((x) => ({ start: x.start, reason: x.reason }));
    }
    if (gmCustomerId && (details.gmBio || details.gm)) {
      this.write(
        'INSERT INTO gm_profiles (customer_id, name, bio, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(customer_id) DO UPDATE SET name = excluded.name, bio = CASE WHEN excluded.bio != \'\' THEN excluded.bio ELSE gm_profiles.bio END, updated_at = excluded.updated_at',
        gmCustomerId, details.gm, details.gmBio || '', now,
      );
    }
    if (!approved) {
      this.notifyStaff(`Game to approve: ${game.title}`, {
        title: 'A game to approve',
        intro: `${game.gm} wants to run ${game.title}. Approve it on the staff page and it goes on the games board.`,
        details: [
          ['Game', `${game.title} (${game.system})`], ['GM', game.gm], [details.schedule === 'one-shot' ? 'When' : 'First session', this.when(game, rules)],
          ['Schedule', details.schedule === 'one-shot' ? '' : `${details.schedule}, ${sessions.length} session${sessions.length === 1 ? '' : 's'} listed so far`],
          ['Tables', game.tables.join(', ')], ['Player seats', String(game.seats)], ['GM fee', `${dollars(details.gmFee)} a player (seats are ${dollars(first.seatPrice)})`],
        ],
      });
    }
    if (forGm) this.tellGmLive(game, rules, { listedForThem: true });
    const view = this.state(game.start - 1, game.end + 1);
    return {
      game: this.gameView(game, view, rules), sessions: sessions.map((g) => ({ id: g.id, start: g.start })), skipped, pending: !approved,
      emailed: emailReady(this.env) && Boolean(gmEmail), ...(notice ? { notice } : {}),
    };
  }

  /** "Your game is on the board": when staff approve a game, or list one for a GM. */
  tellGmLive(game, rules, { listedForThem = false } = {}) {
    if (!emailReady(this.env) || !isEmail(game.gmEmail)) return;
    const credit = game.gmFee ?? rules.prices.gmCredit;
    this.later(this.mail(this.letter(game.gmEmail, `Your game is live: ${game.title}`, {
      title: 'Your game is on the board!',
      intro: `Kia ora ${game.gm}, ${game.title} is ${listedForThem ? 'listed' : 'approved'} and on the games board.${game.seriesId && !listedForThem ? ' Every session of it is approved.' : ''} Time to start plotting, friend.`,
      details: [
        ['Game', game.title], [game.seriesId ? 'Next session' : 'When', this.when(game, rules)], ['Tables', game.tables.join(', ')],
        ['Player seats', String(game.seats)],
        ['Your credit', credit ? `${dollars(credit)} store credit for each paying player, after the session` : "None: you're covering your players' GM fee, so they pay just the table fee"],
      ],
      button: { label: 'See the games board', url: this.page('gm') },
      signoff: 'Happy GMing!\nGobgob',
    })));
  }

  /**
   * POST /games/:id/edit (staff). The details (title, system, blurb, seats, level, age, tags, safety, characters,
   * bring, contentNotes, sessionZero, gmFee) change for this session and every later session of its series. start,
   * end and tables move this session only: its GM hold and every seat move with it, onto tables that are free.
   * Unpaid seats follow a new price; paid ones keep what they paid. Players hear if the time changes.
   */
  async editGame(id, input, who) {
    this.requireStaff(who);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    if (game.status === 'cancelled') throw new RuleError('That game was cancelled. List it again as a new game.', 409);
    const time = new LairTime(rules.tz);
    const editable = ['title', 'system', 'blurb', 'seats', 'level', 'age', 'tags', 'safety', 'characters', 'bring', 'contentNotes', 'sessionZero', 'gmFee'];
    const details = checkGameDetails({ ...this.gameDetails(game), ...Object.fromEntries(editable.filter((k) => input[k] !== undefined).map((k) => [k, input[k]])) });
    const sessions = game.seriesId
      ? this.sql.exec("SELECT * FROM games WHERE series_id = ? AND status != 'cancelled' AND (id = ? OR starts_at > ?) ORDER BY starts_at", game.seriesId, game.id, game.start).toArray().map((r) => this.rowToGame(r))
      : [game];
    for (const session of sessions) {
      const taken = this.takenSeats(session.id);
      if (details.seats < taken) throw new RuleError(`${time.label(session.start)} already has ${taken} players. Remove some first, or keep ${taken} seats.`, 409);
    }
    const moving = input.start != null || input.end != null || (Array.isArray(input.tables) && input.tables.length > 0);
    let place = { tables: game.tables, start: game.start, end: game.end, room: game.room };
    if (moving) {
      const tables = Array.isArray(input.tables) && input.tables.length ? input.tables.map(String) : game.tables;
      const start = input.start != null ? Number(input.start) : game.start;
      const end = input.end != null ? Number(input.end) : game.end;
      const own = new Set(this.gameBookings(game.id).map((b) => b.id));
      const st = this.state(Math.min(start, game.start) - 24 * HOUR, Math.max(end, game.end) + 24 * HOUR);
      const moved = checkGameSession({ tables, start, end }, details, { state: st, rules, time, now, staff: true, ignore: own });
      place = { tables: moved.tables, start: moved.start, end: moved.end, room: moved.room };
    }
    const shared = {
      title: details.title, system: details.system, blurb: details.blurb, seats: details.seats, level: details.level, age: details.age, tags: details.tags,
      safety: details.safety, characters: details.characters, pregens: details.pregens, bring: details.bring, contentNotes: details.contentNotes,
      sessionZero: details.sessionZero, gmFee: details.gmFee,
    };
    for (const session of sessions) {
      const here = session.id === game.id ? place : session;
      const room = rules.rooms.find((r) => r.id === here.room) || tableIndex(rules.rooms).get(here.tables[0])?.roomObj;
      const seatPrice = (room?.price ?? rules.prices.table) + details.gmFee;
      this.saveGame({ ...session, ...shared, ...(session.id === game.id ? place : {}), seatPrice }, now);
      this.write("UPDATE bookings SET amount = ? * people, updated_at = ? WHERE game_id = ? AND kind = 'gm-seat' AND paid = 0 AND status IN ('held', 'confirmed', 'seated')", seatPrice, now, session.id);
      this.write("UPDATE bookings SET people = ?, updated_at = ? WHERE game_id = ? AND kind = 'gm'", details.seats + 1, now, session.id);
    }
    if (moving) {
      this.write(
        "UPDATE bookings SET tables = ?, starts_at = ?, ends_at = ?, room = ?, updated_at = ? WHERE game_id = ? AND status IN ('held', 'confirmed', 'seated')",
        JSON.stringify(place.tables), place.start, place.end, place.room, now, game.id,
      );
    }
    if (game.seriesId) {
      const series = this.sql.exec('SELECT details FROM series WHERE id = ?', game.seriesId).toArray()[0];
      if (series) this.write('UPDATE series SET details = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...parse(series.details, {}), ...shared }), now, game.seriesId);
    }
    const fresh = this.game(game.id);
    if ((place.start !== game.start || place.end !== game.end) && emailReady(this.env)) {
      const seats = this.gameBookings(game.id).filter((b) => b.kind === 'gm-seat' && ACTIVE.has(b.status) && isEmail(b.email));
      this.later(this.mailMany(seats.map((seat) => this.letter(seat.email, `New time: ${fresh.title}, ${this.when(fresh, rules)}`, {
        title: 'Your game has a new time',
        intro: `Heads up, friend: ${fresh.title} has moved. Your seat moved with it.`,
        details: [['Game', fresh.title], ['Now', this.when(fresh, rules)], ['Was', this.when(game, rules)], ['Where', `${fresh.tables.length > 1 ? 'Tables' : 'Table'} ${fresh.tables.join(', ')}`], ['Ticket', seat.ref]],
        outro: "Can't make the new time? Cancel your seat in My Lair and Gobgob will let your GM know.",
        button: { label: 'See it in My Lair', url: this.page('myLair') },
      }))));
    }
    return { game: this.gameView(fresh, this.state(fresh.start - 1, fresh.end + 1), rules), sessions: sessions.length };
  }

  /**
   * POST /games/:id/players { name, email, people, players, customerId? } (staff): seat someone at a game, with no
   * payment and no rule but the seats left. Their account is linked when customerId is given or their email matches
   * a member.
   */
  async addPlayers(id, input, who) {
    this.requireStaff(who);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    if (game.status === 'cancelled') throw new RuleError('That game was cancelled.', 409);
    const people = Math.floor(Number(input.people ?? 1));
    if (!(people >= 1 && people <= 8)) throw new RuleError('Add between 1 and 8 players.');
    const left = game.seats - this.takenSeats(game.id);
    if (people > left) throw new RuleError(left > 0 ? `Only ${left} ${left === 1 ? 'seat' : 'seats'} left.` : 'This table is full.', 409);
    const name = trimmed(input.name, 80);
    if (!name) throw new RuleError('Add their name.');
    const email = trimmed(input.email, 120);
    if (email && !isEmail(email)) throw new RuleError("That email address doesn't look right.");
    const players = seatPlayers(input.players, people, name);
    const customerId = trimmed(input.customerId, 40) || this.memberByEmail(email)?.customer_id || null;
    const seatId = makeId('bk');
    const seat = {
      id: seatId, ref: this.newCode(name, 'booking', seatId, now), kind: 'gm-seat', status: 'confirmed', gameId: game.id, tables: game.tables, room: game.room,
      start: game.start, end: game.end, people, name, email, amount: (game.seatPrice || rules.prices.gmSeat) * people, pay: 'day', paid: false,
      activity: 'rpg', party: players, customerId, notes: 'Added by staff',
    };
    this.saveBooking(seat, now);
    const emailed = this.confirm(seat, rules, game);
    return { booking: { ...this.ownView(seat), players, customerId }, game: this.gameView(game, this.state(game.start - 1, game.end + 1), rules), emailed };
  }

  /** A GM (or staff) adds a date to a flexible or repeating game. A one-shot becomes a flexible series. */
  async addSession(id, input, who) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    const own = who.customerId && game.gmCustomerId === who.customerId;
    if (!who.staff && !own) throw new RuleError('Only the GM or staff can add a session.', 403);
    if (game.status === 'cancelled') throw new RuleError('That game was cancelled. List it again as a new game.', 409);
    const time = new LairTime(rules.tz);
    const st = this.state(now - 24 * HOUR, now + (rules.horizonDays + 2) * 24 * HOUR);
    const details = this.gameDetails(game);
    const tables = Array.isArray(input.tables) && input.tables.length ? input.tables : game.tables;
    const session = checkGameSession({ tables, start: input.start, end: input.end }, details, { state: st, rules, time, now, staff: who.staff });
    let seriesId = game.seriesId;
    let series = seriesId ? this.sql.exec('SELECT * FROM series WHERE id = ?', seriesId).toArray()[0] : null;
    if (!seriesId) {
      seriesId = makeId('sr');
      this.write(
        `INSERT INTO series (id, schedule, gm_customer_id, details, tables, clock, length, first_day, status, approved, image_id, created_at, updated_at)
         VALUES (?, 'flexible', ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        seriesId, game.gmCustomerId, JSON.stringify({ ...details, schedule: 'flexible', gmEmail: game.gmEmail }), JSON.stringify(game.tables),
        time.minutesOf(game.start), game.end - game.start, time.key(game.start), game.status === 'open' ? 1 : 0, game.imageId, now, now,
      );
      this.write("UPDATE games SET series_id = ?, schedule = 'flexible', updated_at = ? WHERE id = ?", seriesId, now, game.id);
      series = this.sql.exec('SELECT * FROM series WHERE id = ?', seriesId).one();
    }
    const approved = Boolean(series?.approved) || game.status === 'open' || who.staff;
    const base = {
      ...details, schedule: game.seriesId ? game.schedule : 'flexible', gmCustomerId: game.gmCustomerId, gmEmail: game.gmEmail, seriesId,
      status: approved ? 'open' : 'pending', credited: null, feeApproved: true, imageId: game.imageId,
    };
    const created = this.saveSession(base, session, now);
    const seated = this.seatSeriesMembers(created, rules, now);
    if (seated.length && emailReady(this.env)) {
      this.later(this.mailMany(seated.filter((x) => isEmail(x.member.email)).map(({ member, result }) => this.letter(member.email, `New session: ${created.title}, ${this.when(created, rules)}`, {
        title: 'New session, same seat',
        intro: `Kia ora ${member.name}, ${created.gm} added a session of ${created.title}, and Gobgob saved your seat.`,
        details: [['When', this.when(created, rules)], ['Players', this.partyLine(result.seat.party)], ['Fee', `${dollars(result.seat.amount)}, pay at the counter`], ['Ticket', result.seat.ref]],
        outro: "Can't make this one? Cancel it in My Lair and your other sessions stay booked.",
        button: { label: 'See it in My Lair', url: this.page('myLair') },
      }))));
    }
    if (!approved) {
      this.notifyStaff(`Game to approve: ${created.title}`, {
        title: 'A session to approve',
        intro: `${created.gm} added a session of ${created.title}. Approve it on the staff page and it goes on the games board.`,
        details: [['Game', created.title], ['When', this.when(created, rules)], ['Tables', created.tables.join(', ')]],
      });
    }
    return { game: this.gameView(created, this.state(created.start - 1, created.end + 1), rules) };
  }

  /* ---------------- joining every session of a game ---------------- */
  seriesMember(seriesId, customerId) {
    return this.sql.exec('SELECT * FROM series_members WHERE series_id = ? AND customer_id = ?', seriesId, String(customerId)).toArray()[0] || null;
  }

  /** Seats taken at one session */
  takenSeats(gameId) {
    return this.sql.exec("SELECT COALESCE(SUM(people), 0) AS n FROM bookings WHERE game_id = ? AND kind = 'gm-seat' AND status IN ('held', 'confirmed', 'seated')", gameId).one().n;
  }

  /**
   * A series member's seat at one session: theirs already, a new one when there's room, or null when it's full.
   * Series members pay at the counter each session. No awaits.
   */
  seatSeriesMember(session, member, rules, now) {
    const existing = this.sql
      .exec("SELECT * FROM bookings WHERE game_id = ? AND customer_id = ? AND kind = 'gm-seat' AND status IN ('held', 'confirmed', 'seated') LIMIT 1", session.id, member.customer_id)
      .toArray()[0];
    if (existing) return { seat: this.rowToBooking(existing), created: false };
    if (session.seats - this.takenSeats(session.id) < member.people) return null;
    const seatId = makeId('bk');
    const seat = {
      id: seatId, ref: this.newCode(member.name, 'booking', seatId, now), kind: 'gm-seat', status: 'confirmed', gameId: session.id, seriesId: session.seriesId,
      tables: session.tables, room: session.room, start: session.start, end: session.end, people: member.people, name: member.name, email: member.email,
      amount: (session.seatPrice || rules.prices.gmSeat) * member.people, pay: 'day', paid: false, activity: 'rpg', party: parse(member.players, []),
      customerId: member.customer_id,
    };
    this.saveBooking(seat, now);
    return { seat, created: true };
  }

  /** A new open session seats the series' members while there's room, first to join first. Returns the new seats. No awaits. */
  seatSeriesMembers(session, rules, now) {
    if (session.status !== 'open' || !session.seriesId) return [];
    const members = this.sql.exec("SELECT * FROM series_members WHERE series_id = ? AND status = 'active' ORDER BY created_at", session.seriesId).toArray();
    return members.map((member) => ({ member, result: this.seatSeriesMember(session, member, rules, now) })).filter((x) => x.result?.created);
  }

  /**
   * POST /games/:id/join-series { people, players, name, email } (logged in): a seat at every upcoming session of the
   * game's series that has room, now and as new sessions appear. Skip one session by cancelling that seat; leave with
   * POST /series/:id/leave. Joining again (to change who's coming) books every session again.
   */
  async joinSeries(gameId, input, who, client = '') {
    if (!who.customerId) throw new RuleError('Log in to join a game.', 401);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const game = this.game(gameId);
    if (!game || !['open', 'full'].includes(game.status)) throw new RuleError('That game is not open for players.', 404);
    if (!game.seriesId) throw new RuleError("This game is a one-off, so there's only the one session. Book a seat instead.", 422);
    const series = this.sql.exec('SELECT * FROM series WHERE id = ?', game.seriesId).toArray()[0];
    if (!series || series.status !== 'active') throw new RuleError("This game isn't running any more.", 409);
    const most = Math.min(8, game.seats);
    const people = Math.floor(Number(input.people));
    if (!(people >= 1 && people <= most)) throw new RuleError(`Join with 1 to ${most} people.`);
    const name = trimmed(input.name, 80);
    const email = trimmed(input.email, 120);
    if (!name) throw new RuleError('Add your name.');
    if (!isEmail(email)) throw new RuleError('Add an email so we can send your confirmation.');
    const players = seatPlayers(input.players, people, name);
    this.checkRate(who, client, now);
    this.write(
      `INSERT INTO series_members (series_id, customer_id, people, players, name, email, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(series_id, customer_id) DO UPDATE SET people = excluded.people, players = excluded.players, name = excluded.name, email = excluded.email,
         status = 'active', updated_at = excluded.updated_at`,
      game.seriesId, who.customerId, people, JSON.stringify(players), name, email, now, now,
    );
    this.touchMember(who.customerId, { name, email }, now);
    const member = this.seriesMember(game.seriesId, who.customerId);
    const booked = [];
    const full = [];
    const sessions = this.sql.exec("SELECT * FROM games WHERE series_id = ? AND status = 'open' AND starts_at > ? ORDER BY starts_at", game.seriesId, now).toArray().map((r) => this.rowToGame(r));
    for (const session of sessions) {
      const got = this.seatSeriesMember(session, member, rules, now);
      if (got) booked.push({ gameId: session.id, start: session.start, ref: got.seat.ref });
      else full.push({ gameId: session.id, start: session.start });
    }
    if (emailReady(this.env)) {
      const dates = (list) => list.map((x) => `${this.when(sessions.find((g) => g.id === x.gameId), rules)}${x.ref ? ` (${x.ref})` : ''}`).join('\n');
      this.later(this.mail(this.letter(email, `You're in for every session: ${game.title}`, {
        title: "You're in for every session!",
        intro: `Kia ora ${name}, you've got a seat at every upcoming session of ${game.title}${game.gm ? ` with GM ${game.gm}` : ''}. New sessions get your seat too, while there's room.`,
        details: [
          ['Game', game.title], ['Players', this.partyLine(players)], ['Booked', dates(booked)], ['Already full', dates(full)],
          ['Fee', `${dollars((game.seatPrice || rules.prices.gmSeat) * people)} a session, paid at the counter`],
        ],
        outro: ["Pay at the counter each session: show that session's code, or your member code from My Lair, and we'll ring it up.", "Skipping one? Cancel that session's seat in My Lair. To stop coming altogether, leave the game in My Lair."],
        button: { label: 'See it in My Lair', url: this.page('myLair') },
      })));
    }
    return { member: { seriesId: game.seriesId, people, players }, booked, full };
  }

  /** POST /series/:id/leave (logged in): stop being seated at every session, and free the upcoming seats it made. */
  async leaveSeries(seriesId, who) {
    if (!who.customerId) throw new RuleError('Log in to manage your games.', 401);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const member = this.seriesMember(seriesId, who.customerId);
    if (!member || member.status !== 'active') throw new RuleError("You're not signed up for every session of that game.", 404);
    this.write("UPDATE series_members SET status = 'left', updated_at = ? WHERE series_id = ? AND customer_id = ?", now, seriesId, who.customerId);
    const seats = this.sql
      .exec("SELECT * FROM bookings WHERE series_id = ? AND customer_id = ? AND kind = 'gm-seat' AND status IN ('held', 'confirmed') AND starts_at > ? ORDER BY starts_at", seriesId, who.customerId, now)
      .toArray().map((r) => this.rowToBooking(r));
    for (const seat of seats) {
      const refund = refundFor(seat, rules, now);
      this.write("UPDATE bookings SET status = 'cancelled', hold_until = NULL, refund = ?, updated_at = ? WHERE id = ?", refund.due ? 'due' : seat.refund, now, seat.id);
      this.dropDraft(seat);
    }
    const game = seats.length ? this.game(seats[0].gameId) : null;
    if (game && emailReady(this.env) && isEmail(game.gmEmail)) {
      this.later(this.mail(this.letter(game.gmEmail, `Player left: ${game.title}`, {
        title: 'A player left your game',
        intro: `Kia ora ${game.gm}, ${member.name} has stopped coming to every session of ${game.title}. Their ${seats.length === 1 ? 'seat' : 'seats'} at the next ${seats.length === 1 ? 'session is' : `${seats.length} sessions are`} free again.`,
        details: [['Game', game.title], ['Player', `${member.name}${member.people > 1 ? ` (${member.people} seats)` : ''}`], ['Sessions freed', seats.map((x) => this.when(x, rules)).join('\n')]],
        button: { label: 'See the games board', url: this.page('gm') },
        signoff: 'Gobgob',
      })));
    }
    return { ok: true, cancelled: seats.length };
  }

  /* ---------------- messages to players ---------------- */
  /**
   * POST /games/:id/message { text, scope: 'session'|'series' } (the game's GM, or staff). Emails everyone with a seat
   * at that session, or for 'series' every member of the series and everyone with a seat at an upcoming session.
   * Replies go to the GM. A game (a whole series counts as one) can send 5 a day; staff aren't limited. Returns { sent }.
   */
  async messagePlayers(gameId, input, who) {
    const rules = await this.rules();
    // --- no awaits until the message is recorded ---
    const now = Date.now();
    const game = this.game(gameId);
    if (!game) throw new RuleError('Game not found.', 404);
    const own = Boolean(who.customerId && game.gmCustomerId === who.customerId);
    if (!who.staff && !own) throw new RuleError('Only the GM or staff can message the players.', 403);
    const text = String(input.text ?? '').trim().slice(0, 2000);
    if (!text) throw new RuleError('Write a message first.');
    const scope = input.scope === 'series' && game.seriesId ? 'series' : 'session';
    if (!emailReady(this.env)) throw new RuleError("Emails aren't set up yet, so messages can't go out. Call the shop instead.", 503);
    const limitKey = game.seriesId || game.id;
    if (!who.staff) {
      const recent = this.sql.exec('SELECT COUNT(*) AS n FROM messages WHERE limit_key = ? AND created_at > ?', limitKey, now - 24 * HOUR).one().n;
      if (recent >= LIMITS.messagesPerGamePerDay) throw new RuleError("That's 5 messages for this game today. Try again tomorrow, or ask the team to pass it on.", 429);
    }
    const active = "status IN ('held', 'confirmed', 'seated')";
    const people = scope === 'series'
      ? [
        ...this.sql.exec("SELECT name, email FROM series_members WHERE series_id = ? AND status = 'active'", game.seriesId).toArray(),
        ...this.sql.exec(`SELECT b.name, b.email FROM bookings b JOIN games g ON g.id = b.game_id WHERE g.series_id = ? AND b.kind = 'gm-seat' AND b.${active} AND b.ends_at > ?`, game.seriesId, now).toArray(),
      ]
      : this.sql.exec(`SELECT name, email FROM bookings WHERE game_id = ? AND kind = 'gm-seat' AND ${active}`, game.id).toArray();
    const recipients = new Map();
    for (const p of people) if (isEmail(p.email) && !recipients.has(p.email.trim().toLowerCase())) recipients.set(p.email.trim().toLowerCase(), p);
    if (!recipients.size) return { sent: 0 };
    const id = makeId('ms');
    this.write(
      'INSERT INTO messages (id, game_id, limit_key, scope, text, recipients, sent, sender, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
      id, game.id, limitKey, scope, text, recipients.size, who.staff && !own ? 'staff' : 'gm', now,
    );
    const next = scope === 'series'
      ? this.sql.exec("SELECT * FROM games WHERE series_id = ? AND status = 'open' AND ends_at > ? ORDER BY starts_at LIMIT 1", game.seriesId, now).toArray().map((r) => this.rowToGame(r))[0] || game
      : game;
    const replyTo = own && isEmail(game.gmEmail) ? game.gmEmail : null;
    const letters = [...recipients.values()].map((p) => this.letter(p.email, `${game.title}: a message from ${own ? game.gm : 'the Lair team'}`, {
      title: own ? 'A message from your GM' : 'A message from the Lair team',
      intro: `Kia ora ${p.name || 'friend'}, ${own ? `${game.gm}, your GM for ${game.title},` : 'the Dice Goblin team'} sent this to everyone playing${scope === 'series' ? '' : ` on ${this.when(game, rules)}`}:`,
      quote: text,
      details: [['Game', game.title], [scope === 'series' ? 'Next session' : 'When', this.when(next, rules)]],
      outro: replyTo ? `Reply to this email to answer ${game.gm}.` : 'Reply to this email to answer the team.',
      button: { label: 'See your games in My Lair', url: this.page('myLair') },
    }, { replyTo }));
    const result = await this.mailMany(letters);
    // --- only this message's own row changes ---
    this.write('UPDATE messages SET sent = ? WHERE id = ?', result.sent, id);
    return { sent: result.sent };
  }

  /**
   * Cancel sessions with their seats and GM holds, and email every player. A seat that was paid for is flagged
   * "refund due" (a cancelled game is always refunded, whatever the cut-off) and staff get one list of refunds to
   * make. No awaits.
   */
  cancelSessions(games, rules, now) {
    let affected = 0;
    const letters = [];
    const refunds = [];
    for (const game of games) {
      const linked = this.gameBookings(game.id).filter((b) => ACTIVE.has(b.status));
      this.write("UPDATE games SET status = 'cancelled', updated_at = ? WHERE id = ?", now, game.id);
      this.write("UPDATE bookings SET status = 'cancelled', hold_until = NULL, updated_at = ? WHERE game_id = ? AND status IN ('held', 'confirmed', 'seated')", now, game.id);
      for (const seat of linked.filter((b) => b.kind === 'gm-seat')) {
        affected += 1;
        this.dropDraft(seat);
        const refund = Boolean(seat.paid && seat.amount > 0);
        if (refund) {
          this.write("UPDATE bookings SET refund = 'due', updated_at = ? WHERE id = ? AND (refund IS NULL OR refund != 'done')", now, seat.id);
          refunds.push([seat.ref, `${seat.name}: ${dollars(seat.amount)} for ${this.when(game, rules)}${seat.pay === 'now' ? ', paid online' : ', paid at the counter'}${seat.orderId ? ` (order ${String(seat.orderId).split('/').pop()})` : ''}`]);
        }
        if (!isEmail(seat.email)) continue;
        letters.push(this.letter(seat.email, `Cancelled: ${game.title}, ${this.when(game, rules)}`, {
          title: "Your game's been cancelled",
          intro: [
            `Sorry, friend: ${game.title} on ${this.when(game, rules)} has been cancelled, so your seat is cancelled too.`,
            ...(refund
              ? [seat.pay === 'now'
                ? "You paid online, so you'll get all your money back. The team will refund your card in the next few days."
                : "You've already paid, so you'll get all your money back. Pop in or reply to this email and the team will sort it."]
              : []),
          ],
          details: [['Game', game.title], ['Was on', this.when(game, rules)], ['Ticket', seat.ref], ['Refund', refund ? dollars(seat.amount) : '']],
          button: { label: 'Find another game', url: this.page('gm') },
          signoff: 'Sorry again,\nGobgob',
        }));
      }
    }
    if (letters.length && emailReady(this.env)) this.later(this.mailMany(letters));
    if (refunds.length) {
      this.notifyStaff(`Refunds due: ${games[0].title}`, {
        title: 'Refunds due for a cancelled game',
        intro: `${games[0].title} was cancelled, so these players get their money back. Refund them in Shopify (or at the counter), then mark each booking refunded.`,
        details: refunds,
      });
    }
    return affected;
  }

  async updateGame(id, patch, who) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    const own = who.customerId && game.gmCustomerId === who.customerId;
    const scope = patch.scope === 'series' && game.seriesId ? 'series' : 'session';
    // GMs can cancel a session until an hour after it starts (the group didn't show, the GM is sick).
    const cancellable = (g) => now <= g.start + HOUR;
    if (!who.staff) {
      if (!own || patch.status !== 'cancelled') throw new RuleError('Only staff can change that game.', 403);
      if (scope === 'session' && !cancellable(game)) throw new RuleError('This session started more than an hour ago. Talk to staff at the counter.', 403);
    }
    if (game.status === 'cancelled' && patch.status && patch.status !== 'cancelled') {
      throw new RuleError('Cancelled games stay cancelled. List it again as a new game.', 409);
    }
    const before = game.status;
    let affected = 0;
    if (patch.status === 'cancelled') {
      // A series: every future session, and this one too while it can still be cancelled.
      const targets = scope === 'series'
        ? this.sql.exec("SELECT * FROM games WHERE series_id = ? AND status != 'cancelled' AND (starts_at > ? OR (id = ? AND starts_at >= ?))", game.seriesId, now, game.id, now - HOUR)
          .toArray().map((r) => this.rowToGame(r))
        : before === 'cancelled' ? [] : [game];
      if (scope === 'series') this.write("UPDATE series SET status = 'cancelled', updated_at = ? WHERE id = ?", now, game.seriesId);
      affected = this.cancelSessions(targets, rules, now);
      game.status = 'cancelled';
    } else if (patch.status && ['open', 'pending'].includes(patch.status)) {
      game.status = patch.status;
      if (game.status === 'open') game.feeApproved = true;
      this.saveGame(game, now);
      // Approving one session of a series approves every waiting session of it (and the series' future ones).
      if (game.seriesId && game.status === 'open') {
        this.write("UPDATE games SET status = 'open', fee_approved = 1, updated_at = ? WHERE series_id = ? AND status = 'pending'", now, game.seriesId);
        this.write('UPDATE series SET approved = 1, updated_at = ? WHERE id = ?', now, game.seriesId);
      }
    }
    if (before === 'pending' && game.status === 'open') this.tellGmLive(game, rules);
    const fresh = this.game(id);
    return { game: this.gameView(fresh, this.state(fresh.start - 1, fresh.end + 1), rules), affected };
  }

  async creditGm(id, who) {
    this.requireStaff(who);
    const rules = await this.rules();
    // --- no awaits until the game is claimed, so two staff tapping "credit" at once can't pay twice ---
    const now = Date.now();
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    if (game.status === 'cancelled') throw new RuleError('This game was cancelled.', 409);
    if (game.start > now) throw new RuleError('Credit the GM once the session has started.');
    if (game.credited != null) throw new RuleError('This GM has already been credited.', 409);
    const players = this.sql
      .exec("SELECT COALESCE(SUM(people), 0) AS n FROM bookings WHERE game_id = ? AND kind = 'gm-seat' AND paid = 1 AND status NOT IN ('cancelled', 'noshow')", id)
      .one().n;
    // Each game's own GM fee: $0 (the GM covers their players), $5 standard, or more with a manager's OK.
    const amount = players * (game.gmFee ?? rules.prices.gmCredit);
    this.write('UPDATE games SET credited = ?, updated_at = ? WHERE id = ?', players, now, id);
    let status = 'none';
    let note = game.gmFee === 0 ? "This GM covers their players' fee, so there's no store credit to add." : '';
    try {
      if (amount > 0 && game.gmCustomerId && this.shopify.configured) {
        await this.shopify.creditCustomer(game.gmCustomerId, amount, this.env.CURRENCY || 'NZD');
        status = 'credited';
      } else if (amount > 0) {
        status = 'manual';
        note = "The GM isn't linked to a customer account, so add the store credit in Shopify admin.";
      }
    } catch (error) {
      this.write('UPDATE games SET credited = NULL, updated_at = ? WHERE id = ?', Date.now(), id);
      console.error('Lair: store credit failed', error);
      throw new RuleError(`Shopify didn't add the store credit (${error.message}). Try again, or add it in Shopify admin.`, 502);
    }
    this.write(
      'INSERT INTO credits (id, game_id, customer_id, players, amount, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      makeId('cr'), id, game.gmCustomerId, players, amount, status, note, Date.now(),
    );
    return { players, amount, status, note };
  }

  /** A GM's picture for their game (every session of a series). The browser shrinks it first. */
  async gameImage(id, input, who) {
    const now = Date.now();
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    const own = who.customerId && game.gmCustomerId === who.customerId;
    if (!who.staff && !own) throw new RuleError('Only the GM or staff can change the picture.', 403);
    const match = String(input.dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match) throw new RuleError('Pick a JPEG, PNG or WebP picture.');
    const raw = atob(match[2].replace(/\s+/g, ''));
    if (raw.length > IMAGE_LIMIT) throw new RuleError('That picture is too big. Try a smaller one.', 413);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    const imageId = `${makeId('img')}.${match[1].split('/')[1].replace('jpeg', 'jpg')}`;
    this.write('INSERT INTO images (id, mime, data, owner, created_at) VALUES (?, ?, ?, ?, ?)', imageId, match[1], bytes, who.customerId || null, now);
    if (game.seriesId) {
      this.write('UPDATE games SET image_id = ?, updated_at = ? WHERE series_id = ?', imageId, now, game.seriesId);
      this.write('UPDATE series SET image_id = ?, updated_at = ? WHERE id = ?', imageId, now, game.seriesId);
    } else {
      this.write('UPDATE games SET image_id = ?, updated_at = ? WHERE id = ?', imageId, now, game.id);
    }
    return { image: this.imageUrl(imageId) };
  }

  /** Serve a game picture (the Worker caches it) */
  image(id) {
    const row = this.sql.exec('SELECT mime, data FROM images WHERE id = ?', String(id || '')).toArray()[0];
    if (!row) return new Response('Not found', { status: 404 });
    return new Response(row.data, { headers: { 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=31536000, immutable' } });
  }

  async saveGmProfile(input, who) {
    if (!who.customerId) throw new RuleError('Log in to save your GM profile.', 401);
    const name = String(input.name || '').trim().slice(0, 60);
    const bio = String(input.bio || '').trim().slice(0, 600);
    if (!name) throw new RuleError('Add the name players will see.');
    const now = Date.now();
    this.write(
      'INSERT INTO gm_profiles (customer_id, name, bio, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(customer_id) DO UPDATE SET name = excluded.name, bio = excluded.bio, updated_at = excluded.updated_at',
      who.customerId, name, bio, now,
    );
    // Upcoming games show the GM's latest profile.
    this.write('UPDATE games SET gm = ?, gm_bio = ?, updated_at = ? WHERE gm_customer_id = ? AND starts_at > ?', name, bio, now, who.customerId, now);
    return { profile: { name, bio } };
  }

  async createBlock(input, who) {
    this.requireStaff(who);
    const rules = await this.rules();
    const now = Date.now();
    const tables = (Array.isArray(input.tables) ? input.tables : parseTableList(input.tables, rules.rooms)).map(String);
    const index = tableIndex(rules.rooms);
    if (!tables.length || tables.some((t) => !index.has(t))) throw new RuleError('Pick tables that exist, like T11-T20.');
    const start = Number(input.start);
    const end = Number(input.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) throw new RuleError('The hold needs an end time after the start.');
    const block = { id: makeId('bl'), tables, start, end, label: String(input.label || 'Held').slice(0, 80), type: String(input.type || 'event').slice(0, 20) };
    this.write(
      'INSERT INTO blocks (id, tables, starts_at, ends_at, label, type, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      block.id, JSON.stringify(tables), start, end, block.label, block.type, who.customerId, now,
    );
    const st = this.state(start, end);
    const clashes = st.bookings.filter((bk) => ACTIVE.has(bk.status) && bk.tables.some((t) => tables.includes(t))).map((bk) => bk.ref);
    return { block, clashes };
  }

  async removeBlock(id, who) {
    this.requireStaff(who);
    this.write('DELETE FROM blocks WHERE id = ?', id);
    return { ok: true };
  }

  /**
   * orders/paid webhook (signature already checked by the Worker). Two jobs:
   *
   * Payments for bookings. Customers can put any text in a cart note or cart attribute, so an online order only counts
   * when it came from a draft order (our checkouts; customers can't make those), and only for a booking that was sent
   * to checkout: Shopify is asked which order the booking's draft became, and if the draft is gone (deleted as the
   * hold ran out) or not linked yet, the draft-order source is the proof. POS orders are made by staff at the
   * counter, so a POS line with a _booking property pays for that booking as it is.
   *
   * Members' spend. Every paid order with a customer (online, draft or POS) adds its subtotal after discounts to that
   * customer's spend, once per order: Shopify retries webhooks, and the order id is the key.
   */
  async ordersPaid(order) {
    const orderId = order.admin_graphql_api_id || (order.id ? `gid://shopify/Order/${order.id}` : '');
    if (!orderId || !this.shopify.configured) return { updated: [] };
    const source = order.source_name || '';
    const pos = source === 'pos';
    const fromDraft = !source || source === 'shopify_draft_order';
    const refs = new Set();
    for (const item of order.line_items || []) for (const p of item.properties || []) if (p.name === '_booking' && p.value) refs.add(String(p.value).trim().toUpperCase());
    if (fromDraft) {
      for (const a of order.note_attributes || []) if (a.name === '_booking' && a.value) refs.add(String(a.value).trim().toUpperCase());
      for (const match of String(order.note || '').matchAll(/\b(?:[A-Z]{2}-[A-Z]{3,9}-\d{1,2}|GOB-[A-Z0-9]{6})\b/g)) refs.add(match[0]);
    }
    const rules = await this.rules();
    const verified = [];
    for (const ref of [...refs].slice(0, 10)) {
      const found = this.bookingOrJoin(ref);
      if (!found || verified.some((x) => x.id === found.item.id)) continue;
      const candidate = found.item;
      const item = { type: found.type, id: candidate.id };
      if (pos) {
        verified.push(item);
      } else if (fromDraft && candidate.draftOrderId) {
        // If Shopify can't answer, this throws: the webhook gets a 500 and Shopify sends it again later.
        const linked = await this.shopify.draftOrderOrderId(candidate.draftOrderId);
        if (linked === orderId || (linked === null && source === 'shopify_draft_order')) verified.push(item);
      }
    }
    // --- no awaits from here on: read each booking or sign-up fresh and update it ---
    const of = (type) => verified.filter((x) => x.type === type).map((x) => x.id);
    const updated = [...this.markPaid(of('booking'), orderId, rules, { pos }), ...this.markJoinsPaid(of('join'), orderId, rules, { pos })];

    // Payments are recorded, so if Shopify can't say who the customer is right now, failing the webhook (Shopify
    // sends it again) only repeats work that's already done.
    const spend = await this.orderSpend(orderId);
    // --- no awaits from here on ---
    let counted = 0;
    if (spend?.customerId && spend.amount > 0 && !this.sql.exec('SELECT 1 AS n FROM spend WHERE order_id = ?', orderId).toArray().length) {
      this.write('INSERT INTO spend (order_id, customer_id, amount, source, created_at) VALUES (?, ?, ?, ?, ?)', orderId, spend.customerId, spend.amount, spend.source || source || null, Date.now());
      counted = spend.amount;
    }
    return { updated, spend: counted };
  }

  /** Bookings paid by an order: online through their checkout, or at the counter (pos). No awaits. */
  markPaid(ids, orderId, rules, { pos = false } = {}) {
    const now = Date.now();
    const updated = [];
    for (const id of ids) {
      const booking = this.booking(id);
      const firstTime = !booking.paid;
      if (!firstTime && booking.orderId && booking.orderId !== orderId) {
        // Already paid by another order: money to give back, never a second confirmation.
        if (!(booking.notes || '').includes(orderId)) {
          booking.notes = `${booking.notes ? `${booking.notes} ` : ''}[Paid twice: ${booking.orderId} and ${orderId}. Refund one.]`;
          this.saveBooking(booking, now);
          this.notifyStaff(`Paid twice: ${booking.ref}`, {
            title: 'A booking was paid twice',
            intro: `${booking.name}'s booking ${booking.ref} was paid by two orders. Refund one of them.`,
            details: [['Booking', booking.ref], ['First order', booking.orderId], ['Second order', orderId], ['Amount', dollars(booking.amount)]],
          });
        }
        updated.push(booking.ref);
        continue;
      }
      booking.paid = true;
      booking.orderId = orderId;
      if (booking.status === 'held') booking.status = 'confirmed';
      if (booking.status === 'cancelled' && firstTime) {
        // Paid after the hold ran out (or after a cancellation): take the spot back if it is still free.
        const game = booking.gameId ? this.game(booking.gameId) : null;
        let ok = false;
        if (booking.holdUntil && (!game || game.status !== 'cancelled')) {
          const st = this.state(booking.start - 1, booking.end + 1);
          const free = booking.kind === 'gm-seat' || booking.tables.every((t) => isFree(st, rules, t, booking.start, booking.end, booking.id));
          const seatsOk = booking.kind !== 'gm-seat' || (game && seatsTaken(st, game.id) + booking.people <= game.seats);
          ok = free && seatsOk;
        }
        if (ok) {
          booking.status = 'confirmed';
        } else {
          booking.notes = `${booking.notes ? `${booking.notes} ` : ''}[Paid after it was cancelled or the spot was re-booked: refund or reseat]`;
          this.notifyStaff(`Paid but cancelled: ${booking.ref}`, {
            title: 'Paid for a cancelled booking',
            intro: `${booking.name} paid for ${booking.ref}, but that booking was cancelled or its spot was re-booked. Refund the order or find them another spot.`,
            details: [['Booking', booking.ref], ['Name', booking.name], ['Email', booking.email || 'none'], ['Was for', this.when(booking, rules)], ['Order', orderId]],
          });
        }
      }
      booking.holdUntil = null;
      this.saveBooking(booking, now);
      // Paying online confirms a held booking: that's when its confirmation goes out. Paying at the counter doesn't need one.
      if (firstTime && !pos && booking.status === 'confirmed') this.confirm(booking, rules, booking.gameId ? this.game(booking.gameId) : null);
      updated.push(booking.ref);
    }
    return updated;
  }

  /** Event sign-ups paid by an order (their entry fee), online or at the counter. Like markPaid. No awaits. */
  markJoinsPaid(ids, orderId, rules, { pos = false } = {}) {
    const now = Date.now();
    const updated = [];
    for (const id of ids) {
      const join = this.joinById(id);
      const firstTime = !join.paid;
      if (!firstTime && join.orderId && join.orderId !== orderId) {
        this.notifyStaff(`Paid twice: ${join.ref}`, {
          title: 'A sign-up was paid twice',
          intro: `${join.name}'s sign-up ${join.ref} for ${join.title} was paid by two orders. Refund one of them.`,
          details: [['Sign-up', join.ref], ['First order', join.orderId], ['Second order', orderId], ['Amount', dollars(join.amount)]],
        });
        updated.push(join.ref);
        continue;
      }
      let status = join.status === 'held' ? 'confirmed' : join.status;
      if (join.status === 'cancelled' && firstTime) {
        // Paid after the hold ran out: keep the spot if the event still has room.
        const occurrence = findOccurrence(rules, join.occurrenceId);
        const others = this.sql.exec("SELECT COALESCE(SUM(people), 0) AS n FROM event_joins WHERE occurrence_id = ? AND status != 'cancelled' AND id != ?", join.occurrenceId, join.id).one().n;
        if (join.holdUntil && occurrence?.capacity && others + join.people <= occurrence.capacity) {
          status = 'confirmed';
        } else {
          this.notifyStaff(`Paid but cancelled: ${join.ref}`, {
            title: 'Paid for a cancelled sign-up',
            intro: `${join.name} paid the entry fee for ${join.ref}, but that sign-up was cancelled or the event filled up. Refund the order or find them a spot.`,
            details: [['Sign-up', join.ref], ['Event', `${join.title}, ${this.when(join, rules)}`], ['Email', join.email || 'none'], ['Order', orderId]],
          });
        }
      }
      this.write('UPDATE event_joins SET paid = 1, order_id = ?, status = ?, hold_until = NULL, updated_at = ? WHERE id = ?', orderId, status, now, join.id);
      if (firstTime && !pos && status === 'confirmed') this.confirmJoin({ ...join, paid: true, status }, rules);
      updated.push(join.ref);
    }
    return updated;
  }

  /**
   * An order's customer and subtotal after discounts. A missing permission (or protected customer data not
   * approved) is noted on the status page and skipped, so it can't block the webhook; anything else, like Shopify
   * being down, throws and Shopify sends the webhook again later.
   */
  async orderSpend(orderId) {
    try {
      return await this.shopify.orderSpend(orderId);
    } catch (error) {
      const message = String(error.message || error);
      if (!/access denied|access_denied|not approved|protected customer|doesn't exist|cannot query/i.test(message)) throw error;
      this.note({ spendError: { message: message.slice(0, 300), at: new Date().toISOString() } });
      return null;
    }
  }

  /* ---------------- shop tables ---------------- */
  /** Managers open shop tables (T1-T3 by default) for public bookings for a while. */
  async createOpening(input, who) {
    this.requireStaff(who);
    const rules = await this.rules();
    const now = Date.now();
    const tables = (Array.isArray(input.tables) ? input.tables : parseTableList(input.tables, rules.rooms)).map(String);
    const index = tableIndex(rules.rooms);
    if (!tables.length || tables.some((t) => !index.has(t))) throw new RuleError('Pick tables that exist, like T1-T3.');
    const start = Number(input.start);
    const end = Number(input.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) throw new RuleError('The opening needs an end time after the start.');
    const opening = { id: makeId('op'), tables, start, end, note: String(input.note || '').trim().slice(0, 120) };
    this.write(
      'INSERT INTO openings (id, tables, starts_at, ends_at, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      opening.id, JSON.stringify(tables), start, end, opening.note, who.customerId, now,
    );
    return { opening };
  }

  async removeOpening(id, who) {
    this.requireStaff(who);
    this.write('DELETE FROM openings WHERE id = ?', id);
    return { ok: true };
  }

  /* ---------------- check-in at the counter ---------------- */
  /**
   * Staff scan a code or type it: SJ-OWLBEAR-17 however it's typed, or the first release's GOB-7K2QXM. A booking's or
   * sign-up's code checks it in and the reply says what's left to pay; a member code lists that person's bookings and
   * sign-ups for today, for staff to pick from.
   */
  async checkIn(input, who) {
    this.requireStaff(who);
    const rules = await this.rules();
    // --- no awaits from here on ---
    return this.ticketCheckIn(input, rules, Date.now());
  }

  /** The check-in itself, shared by the staff page and the POS. No awaits. */
  ticketCheckIn(input, rules, now) {
    const found = this.findCode(input.code);
    if (!found) throw new RuleError('No booking, member or pass with that code.', 404);
    if (found.type === 'member') return this.memberCard(found.item.customer_id, rules, now);
    const force = input.force === true;
    if (found.type === 'booking') return this.checkInBooking(found.item, rules, now, force);
    if (found.type === 'join') return this.checkInJoin(found.item, rules, now, force);
    throw new RuleError('No booking, member or pass with that code.', 404);
  }

  clock(ms, rules) {
    return new Intl.DateTimeFormat('en-NZ', { timeZone: rules.tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
  }

  checkInBooking(booking, rules, now, force) {
    const time = new LairTime(rules.tz);
    const game = booking.gameId ? this.game(booking.gameId) : null;
    const due = booking.paid ? 0 : booking.amount || 0;
    const base = { found: true, kind: 'booking', booking: { ...booking, players: booking.party }, game: game ? this.gameView(game, this.state(game.start - 1, game.end + 1), rules) : null, due };
    const who = `${booking.name}${booking.people ? `, ${booking.people} ${booking.people === 1 ? 'person' : 'people'}` : ''}${booking.tables.length ? ` at ${booking.tables.join(', ')}` : ''}`;
    const pay = due ? ` Charge ${dollars(due)}.` : booking.paid ? ' Paid online.' : '';
    if (['cancelled', 'noshow'].includes(booking.status) && !force) {
      return { ...base, checkedIn: false, reason: 'cancelled', message: `This booking was ${booking.status === 'noshow' ? 'marked as a no-show' : 'cancelled'}: ${who}.` };
    }
    if ((booking.status === 'seated' || booking.status === 'done' || booking.arrivedAt) && !force) {
      return { ...base, checkedIn: true, reason: 'already', message: `Already checked in${booking.arrivedAt ? ` at ${this.clock(booking.arrivedAt, rules)}` : ''}: ${who}.${pay}` };
    }
    if (!(now >= booking.start - 3 * HOUR && now <= booking.end) && !force) {
      return { ...base, checkedIn: false, reason: 'not-today', message: `This booking is for ${time.label(booking.start)}, not today: ${who}.` };
    }
    booking.status = 'seated';
    booking.arrivedAt = now;
    booking.holdUntil = null;
    this.saveBooking(booking, now);
    return { ...base, booking: { ...booking, players: booking.party }, checkedIn: true, message: `Checked in: ${who}.${pay}` };
  }

  checkInJoin(join, rules, now, force) {
    const time = new LairTime(rules.tz);
    const due = join.paid ? 0 : join.amount || 0;
    const base = { found: true, kind: 'join', join, due };
    const label = `${join.name}, ${join.people} ${join.people === 1 ? 'person' : 'people'} for ${join.title || 'the event'}`;
    const pay = due ? ` Charge ${dollars(due)}.` : join.paid ? ' Paid online.' : '';
    if (join.status === 'cancelled' && !force) return { ...base, checkedIn: false, reason: 'cancelled', message: `This sign-up was cancelled: ${label}.` };
    if (join.arrivedAt && !force) return { ...base, checkedIn: true, reason: 'already', message: `Already checked in: ${label}.${pay}` };
    if (!(now >= join.start - 3 * HOUR && now <= join.end) && !force) return { ...base, checkedIn: false, reason: 'not-today', message: `This sign-up is for ${time.label(join.start)}, not today: ${label}.` };
    this.write("UPDATE event_joins SET status = 'attended', arrived_at = ?, hold_until = NULL, updated_at = ? WHERE id = ?", now, now, join.id);
    return { ...base, join: { ...join, status: 'attended', arrivedAt: now }, checkedIn: true, message: `Checked in: ${label}.${pay}` };
  }

  /** One of a member's bookings or sign-ups today, as the counter sees it */
  dayItem(item, rules, type) {
    if (type === 'join') {
      return {
        kind: 'join', id: item.id, ref: item.ref, title: item.title || 'Event', start: item.start, end: item.end, people: item.people, tables: [],
        status: item.status, checkedIn: Boolean(item.arrivedAt), due: item.paid ? 0 : item.amount || 0, occurrenceId: item.occurrenceId,
      };
    }
    const game = item.gameId ? this.game(item.gameId) : null;
    const where = `${item.tables.length > 1 ? 'Tables' : 'Table'} ${item.tables.join(', ')}`;
    const title = item.kind === 'gm-seat' ? game?.title || 'GM game' : item.kind === 'gm' ? `Running ${game?.title || 'a game'}` : where;
    return {
      kind: 'booking', id: item.id, ref: item.ref, title, start: item.start, end: item.end, people: item.people, tables: item.tables, status: item.status,
      checkedIn: Boolean(item.arrivedAt) || ['seated', 'done'].includes(item.status), due: item.paid ? 0 : item.amount || 0, gameId: item.gameId || null,
    };
  }

  /** A member card at the counter: that person's bookings and sign-ups today (none are checked in until staff pick one). */
  memberCard(customerId, rules, now) {
    const time = new LairTime(rules.tz);
    const today = time.key(now);
    const from = time.at(today, 0);
    const to = time.at(addDays(today, 1), 0);
    const bookings = this.sql
      .exec("SELECT * FROM bookings WHERE customer_id = ? AND ends_at > ? AND starts_at < ? AND status NOT IN ('cancelled', 'noshow') ORDER BY starts_at", customerId, from, to)
      .toArray().map((r) => this.rowToBooking(r));
    const joins = this.sql
      .exec("SELECT * FROM event_joins WHERE customer_id = ? AND ends_at > ? AND starts_at < ? AND status != 'cancelled' ORDER BY starts_at", customerId, from, to)
      .toArray().map((r) => this.rowToJoin(r));
    const member = this.memberRow(customerId);
    if (!member && !bookings.length && !joins.length) throw new RuleError('No booking, member or pass with that code.', 404);
    const items = [...bookings.map((b) => this.dayItem(b, rules, 'booking')), ...joins.map((j) => this.dayItem(j, rules, 'join'))].sort((a, b) => a.start - b.start);
    const name = member?.name || member?.first_name || bookings[0]?.name || joins[0]?.name || member?.code || 'This member';
    const due = items.reduce((sum, x) => sum + x.due, 0);
    const list = items.map((x) => `${x.ref}: ${x.title} at ${this.clock(x.start, rules)}${x.checkedIn ? ', checked in' : ''}${x.due ? `, charge ${dollars(x.due)}` : ''}`).join('; ');
    return {
      found: true, kind: 'member', member: { customerId, name, firstName: member?.first_name || '', email: member?.email || '', code: member?.code || null }, customer: { id: customerId },
      bookings: items, checkedIn: false, due,
      message: items.length ? `${name} has ${items.length} ${items.length === 1 ? 'booking' : 'bookings'} today. ${list}.` : `${name} has nothing booked today.`,
    };
  }

  /* ---------------- the POS at the counter ---------------- */
  /**
   * POST /pos/checkin { code, force? } from the POS extension: the same as /checkin, plus `lines` (the fee still to pay,
   * ready to add to the POS cart as custom sales; each carries its ticket code in _booking, so paying the order marks
   * it paid) and `customer` (to attach to the cart, so the spend counts). A member card's lines cover everything
   * still to pay today.
   */
  async posCheckIn(input) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const result = this.ticketCheckIn(input, rules, Date.now());
    let lines = [];
    let customerId = null;
    if (result.kind === 'member') {
      customerId = result.customer.id;
      lines = result.bookings.filter((x) => x.due > 0).map((x) => this.posLine(x.kind === 'join' ? this.joinById(x.id) : this.booking(x.id), x.kind, x.due));
    } else {
      const item = result.kind === 'join' ? result.join : result.booking;
      customerId = item.customerId || null;
      if (result.checkedIn && result.due > 0) lines = [this.posLine(item, result.kind, result.due)];
    }
    return { ...result, lines, customer: customerId ? { id: customerId } : null };
  }

  /** One custom sale for the POS cart */
  posLine(item, type, due) {
    let title;
    if (type === 'join') title = `Event entry: ${item.title || 'event'} (${item.ref})`;
    else if (item.kind === 'gm-seat') title = `GM game seat: ${this.game(item.gameId)?.title || 'game'} (${item.ref})`;
    else title = `Table fee: ${item.ref} (${item.tables.join(', ')}, ${item.people} ${item.people === 1 ? 'person' : 'people'})`;
    return { title: title.slice(0, 120), price: (due / 100).toFixed(2), quantity: 1, taxable: true, properties: { _booking: item.ref } };
  }

  /** POST /pos/member { code } from the POS extension: who a member code belongs to, to attach them to the cart. */
  async posMember(input) {
    const rules = await this.rules();
    const now = Date.now();
    const found = this.findCode(input.code);
    if (found?.type !== 'member') throw new RuleError("That isn't a member code. Members find theirs in My Lair on the website.", 404);
    const row = found.item;
    return {
      customerId: row.customer_id, name: row.name || row.first_name || '', code: row.code,
      rolls: this.rollsState(row.customer_id, now, new LairTime(rules.tz).key(now)),
    };
  }

  /* ---------------- events ---------------- */
  async joinEvent(occurrenceId, input, who, client = '') {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const occurrence = findOccurrence(rules, occurrenceId);
    if (!occurrence) throw new RuleError('That event date could not be found.', 404);
    if (!occurrence.capacity) throw new RuleError("No need to sign up for this one. Just turn up!", 422);
    if (occurrence.end <= now) throw new RuleError('That one has already finished.');
    const people = Math.floor(Number(input.people));
    if (!(people >= 1 && people <= 6)) throw new RuleError('Sign up between 1 and 6 people.');
    const name = String(input.name || '').trim().slice(0, 80);
    const email = String(input.email || '').trim().slice(0, 120);
    if (!name) throw new RuleError('Add your name.');
    if (!isEmail(email)) throw new RuleError('Add an email so we can send your confirmation.');
    this.checkRate(who, client, now);
    const taken = this.sql
      .exec("SELECT COALESCE(SUM(people), 0) AS n FROM event_joins WHERE occurrence_id = ? AND status != 'cancelled'", occurrenceId)
      .one().n;
    const left = occurrence.capacity - taken;
    if (people > left) throw new RuleError(left > 0 ? `Only ${left} ${left === 1 ? 'space' : 'spaces'} left.` : 'This one is full.', 409);
    // The entry fee is paid the way the event says (paymentPlan): at the counter, online (held for 30 minutes until
    // it's paid), or either. No fee, nothing to pay.
    const fee = occurrence.entryFee || 0;
    const plan = this.paymentPlan(fee > 0 ? occurrence.payment : 'store', input.pay);
    const { payNow } = plan;
    const joinId = makeId('ej');
    const join = {
      id: joinId, ref: this.newCode(name, 'join', joinId, now), occurrenceId, eventId: occurrence.eventId, title: occurrence.title, start: occurrence.start,
      end: occurrence.end, people, name, email, note: String(input.note || '').trim().slice(0, 300), status: payNow ? 'held' : 'confirmed',
      pay: payNow ? 'now' : 'day', paid: false, amount: fee * people, holdUntil: payNow ? now + HOLD_MINUTES * MIN : null,
    };
    this.write(
      `INSERT INTO event_joins (id, ref, occurrence_id, event_id, title, starts_at, ends_at, people, name, email, note, status, customer_id, pay, paid, amount,
         hold_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      join.id, join.ref, occurrenceId, join.eventId, join.title, join.start, join.end, people, name, email, join.note, join.status, who.customerId || null,
      join.pay, join.amount, join.holdUntil, now, now,
    );
    this.touchMember(who.customerId, { name, email }, now);
    // --- saved: the spaces are ours ---
    return { ...(await this.payOrConfirmJoin(join, rules, plan)), spacesLeft: left - people };
  }

  /**
   * After a sign-up is saved: send it to checkout (paying online) or email the confirmation. Like payOrConfirm: when
   * online is the only way and Shopify can't make the checkout, the sign-up is taken back and refused.
   */
  async payOrConfirmJoin(join, rules, { wantsPayNow = false, payNow = false, required = false } = {}) {
    let notice = wantsPayNow && !payNow ? "Online payment isn't available, so pay at the counter. You're on the list." : null;
    if (payNow) {
      try {
        const { draftOrderId, checkoutUrl } = await this.shopify.createCheckout({
          ref: join.ref,
          title: `Event entry: ${join.title}`,
          unitPrice: join.amount / join.people,
          quantity: join.people,
          email: join.email,
          currency: this.env.CURRENCY || 'NZD',
          attributes: {
            Booking: join.ref, When: this.when(join, rules), Event: join.title, Name: join.name,
            Cancelling: "Paid online, so you're locked in. Have a chat with us if plans change.",
          },
        });
        this.write('UPDATE event_joins SET draft_order_id = ?, updated_at = ? WHERE id = ?', draftOrderId, Date.now(), join.id);
        const fresh = this.joinById(join.id);
        if (fresh.status === 'held') return { join: this.joinView(fresh), checkoutUrl, holdMinutes: HOLD_MINUTES };
        this.dropDraft(fresh);
        return { join: this.joinView(fresh), notice: 'This sign-up changed while we set up payment. Please call us.' };
      } catch (error) {
        console.error('Lair: checkout could not be created', error);
        if (required) {
          // --- only this sign-up's own row changes: it was never confirmed, so it goes ---
          this.write("DELETE FROM event_joins WHERE id = ? AND status = 'held' AND paid = 0", join.id);
          throw new RuleError(ONLINE_DOWN, 503);
        }
        this.write(
          "UPDATE event_joins SET pay = 'day', status = CASE WHEN status = 'held' THEN 'confirmed' ELSE status END, hold_until = NULL, updated_at = ? WHERE id = ?",
          Date.now(), join.id,
        );
        notice = "Online payment isn't working right now, so pay at the counter. You're on the list.";
      }
    }
    const fresh = this.joinById(join.id);
    const emailed = fresh.status === 'confirmed' && this.confirmJoin(fresh, rules);
    return { join: this.joinView(fresh), notice, emailed };
  }

  /**
   * POST /events/:id/reserve { name, email, people (1-2), pay } books the first free game spot of that event date
   * (its game_tables, like T14+T15) as a normal table booking for the event's time: a wargame setup, linked to the
   * date. It costs the event's entry fee a person when it has one, otherwise the table fee, paid the way the event
   * says (paymentPlan). The same tables stay bookable through the booking page. Returns { booking, spotsLeft, checkoutUrl? }.
   */
  async reserveSpot(occurrenceId, input, who, client = '') {
    const rules = await this.rules();
    // --- no awaits until the booking is saved ---
    const now = Date.now();
    const occurrence = findOccurrence(rules, occurrenceId);
    if (!occurrence) throw new RuleError('That event date could not be found.', 404);
    if (occurrence.end <= now) throw new RuleError('That one has already finished.');
    const spots = parseSpots(occurrence.gameTables, rules.rooms);
    if (!spots.length) throw new RuleError("This event doesn't have game tables to book.", 422);
    const people = Math.floor(Number(input.people));
    if (!(people >= 1 && people <= 2)) throw new RuleError('A game table is for 1 or 2 people.');
    const name = trimmed(input.name, 80);
    const email = trimmed(input.email, 120);
    if (!name) throw new RuleError('Add a name for the booking.');
    if (!isEmail(email)) throw new RuleError('Add an email so we can send your confirmation.');
    this.checkRate(who, client, now);
    if (!who.staff) this.checkEmailLimit(email, now);
    const free = this.freeSpots(occurrence, rules, this.state(occurrence.start - 1, occurrence.end + 1));
    if (!free.length) throw new RuleError('All the game tables are taken for this one. Try another date.', 409);
    const { room } = oneRoom(free[0], rules);
    const unit = occurrence.entryFee || room.price;
    const plan = this.paymentPlan(unit > 0 ? occurrence.payment : 'store', input.pay);
    const { payNow } = plan;
    const spotId = makeId('bk');
    const booking = {
      id: spotId, ref: this.newCode(name, 'booking', spotId, now), kind: 'table', tables: free[0], room: room.id, start: occurrence.start, end: occurrence.end, people,
      name, email, phone: trimmed(input.phone, 40), notes: trimmed(input.notes, 500), activity: 'wargame', extras: ['wargame'], amount: unit * people,
      occurrenceId: occurrence.id, pay: payNow ? 'now' : 'day', paid: false, status: payNow ? 'held' : 'confirmed',
      holdUntil: payNow ? now + HOLD_MINUTES * MIN : null, customerId: who.customerId || null,
    };
    this.saveBooking(booking, now);
    this.touchMember(who.customerId, { name, email }, now);
    // --- saved: the spot is ours ---
    const result = await this.payOrConfirm(booking, rules, { ...plan, title: `Game spot at ${occurrence.title} (${free[0].join(', ')})` });
    return { ...result, spotsLeft: free.length - 1 };
  }

  /** An event date's game spots that are free for its whole time (the event's own table hold doesn't count against them) */
  freeSpots(occurrence, rules, st) {
    const ignore = new Set([`ev-${occurrence.id}`]);
    return parseSpots(occurrence.gameTables, rules.rooms).filter((spot) => spot.every((t) => isFree(st, rules, t, occurrence.start, occurrence.end, ignore)));
  }

  /** "You're on the list" email for an event sign-up */
  confirmJoin(join, rules) {
    if (!emailReady(this.env) || !isEmail(join.email)) return false;
    const fee = !join.amount ? '' : join.paid ? `${dollars(join.amount)}, paid. Thank you!` : `${dollars(join.amount)}, pay at the counter`;
    this.later(this.mail(this.letter(join.email, `You're in: ${join.title}, ${this.when(join, rules)} (${join.ref})`, {
      title: "You're on the list!",
      intro: `Kia ora ${join.name}, you're signed up for ${join.title} at the Dice Goblin Lair. Gobgob's saving your spot.`,
      details: [['Event', join.title], ['When', this.when(join, rules)], ['People', String(join.people)], ['Entry', fee], ['Ticket', join.ref]],
      outro: [`Show ${join.ref} at the counter when you arrive (the QR code in My Lair works too).`, "Can't make it? Cancel in My Lair or reply to this email, so someone else can have your spot."],
      button: { label: 'See it in My Lair', url: this.page('myLair') },
    })));
    return true;
  }

  async cancelJoin(id, who) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const join = this.joinById(id);
    if (!join) throw new RuleError('Sign-up not found.', 404);
    const own = who.customerId && join.customerId === who.customerId;
    if (!who.staff && !own) throw new RuleError('Only staff can change that sign-up.', 403);
    if (join.status === 'cancelled') return { ok: true, join: this.joinView(join) };
    const paid = Boolean(join.paid && join.amount > 0);
    let refund;
    let flag = join.refund;
    let notice = null;
    if (who.staff) {
      // Staff cancelling (the event's off, or they've sorted it out with the person): what was paid comes back.
      refund = paid ? { due: true, amount: join.amount, orderId: join.orderId || null, reason: 'cancelled by staff' } : { due: false, amount: 0, reason: 'nothing paid' };
      if (paid && flag !== 'done') flag = 'due';
    } else if (paid && join.pay === 'now') {
      // Paid online means locked in: the space is freed, and staff decide on a refund.
      refund = { due: false, ask: true, amount: join.amount, orderId: join.orderId || null, reason: 'paid online, so staff decide' };
      if (flag !== 'done') flag = 'ask';
      notice = LOCKED_IN;
    } else {
      refund = { due: false, amount: 0, reason: 'nothing paid online' };
    }
    this.write("UPDATE event_joins SET status = 'cancelled', hold_until = NULL, refund = ?, updated_at = ? WHERE id = ?", flag || null, now, join.id);
    this.dropDraft(join);
    if (refund.due) {
      this.notifyStaff(`Refund due: ${join.ref}`, {
        title: 'Refund due',
        intro: `${join.name}'s sign-up ${join.ref} for ${join.title} was cancelled, so they get their entry fee back. Refund it in Shopify (or at the counter), then mark it refunded.`,
        details: [['Sign-up', join.ref], ['Event', `${join.title}, ${this.when(join, rules)}`], ['Refund', dollars(refund.amount)], ['Order', refund.orderId || 'See Orders in Shopify']],
      });
    } else if (refund.ask) this.askAboutRefund(join, rules, 'sign-up');
    return { ok: true, join: this.joinView(this.joinById(join.id)), refund, ...(notice ? { notice } : {}) };
  }

  /** "Host your own event": the form goes to the team by email, with replies going straight to the person. */
  async contact(input, who, client = '') {
    const now = Date.now();
    const name = String(input.name || '').trim().slice(0, 80);
    const email = String(input.email || '').trim().slice(0, 120);
    const details = String(input.details || '').trim().slice(0, 2000);
    if (!name) throw new RuleError('Add your name.');
    if (!isEmail(email)) throw new RuleError('Add your email so the team can reply.');
    if (details.length < 10) throw new RuleError('Tell us a little about your event.');
    if (!who.staff) {
      const hits = (this.contactHits?.get(client) || []).filter((t) => now - t < HOUR);
      if (hits.length >= 3) throw new RuleError("We've got your messages. The team will be in touch soon.", 429);
      this.contactHits = this.contactHits || new Map();
      this.contactHits.set(client, [...hits, now]);
    }
    if (!emailReady(this.env) || !this.env.STAFF_EMAIL) throw new RuleError("We can't send messages from here right now. Email or call us instead.", 503);
    const field = (value) => String(value ?? '').trim().slice(0, 200);
    const sent = await this.mail(this.letter(this.env.STAFF_EMAIL, `Event idea from ${name}${input.eventType ? `: ${String(input.eventType).slice(0, 60)}` : ''}`, {
      title: 'Someone wants to host an event',
      intro: `${name} wants to host an event at the Lair. Reply to this email to answer them.`,
      details: [['Name', name], ['Email', email], ['Phone', field(input.phone)], ['Kind of event', field(input.eventType)], ['When', field(input.when)], ['How many people', field(input.people)]],
      quote: details,
      button: null,
      signoff: 'Gobgob, passing it on',
    }, { replyTo: email }));
    if (!sent.ok) throw new RuleError("That didn't send. Email or call us instead.", 502);
    return { ok: true };
  }

  /* ---------------- dice ---------------- */
  /**
   * POST /roll: a d20 rolled on the server.
   *   fun (no body, { kind: 'fun' }, or not logged in): just the roll, never a prize. The home page uses this.
   *   daily (logged in, once per Lair day): a natural 1 is $1 store credit and a natural 20 a personal 10% off code.
   *   bonus (logged in, one of the rolls their spend has earned, one per $20): 1 and 10-19 are $1 store credit, 11 is
   *     $2, and 20 is the 10% code.
   * The roll is claimed in the database before Shopify is asked for anything, so two quick taps can't spend one roll
   * twice. If Shopify can't give the prize, it's kept as owed: the member shows the screen at the counter and staff
   * get an email.
   */
  async roll(input, who, client = '') {
    const rules = await this.rules();
    // --- no awaits until the roll and its prize are saved ---
    const now = Date.now();
    const key = who.customerId ? `c:${who.customerId}` : client ? `ip:${client}` : '';
    if (key) {
      const hits = (this.rollHits?.get(key) || []).filter((t) => now - t < 10 * MIN);
      if (hits.length >= 40) throw new RuleError('Easy, tiger. Give the dice a minute to cool down.', 429);
      this.rollHits = this.rollHits || new Map();
      if (this.rollHits.size > 5000) this.rollHits.clear();
      this.rollHits.set(key, [...hits, now]);
    }
    const d20 = () => (crypto.getRandomValues(new Uint32Array(1))[0] % 20) + 1;
    const kind = who.customerId && ['daily', 'bonus'].includes(input?.kind) ? input.kind : 'fun';
    if (kind === 'fun') return { roll: d20() };
    const day = new LairTime(rules.tz).key(now);
    const before = this.rollsState(who.customerId, now, day);
    if (kind === 'daily' && !before.daily) throw new RuleError("You've had today's free roll. Come back tomorrow!", 409);
    if (kind === 'bonus' && before.bonus < 1) throw new RuleError(`No bonus rolls yet. Spend ${dollars(before.toNext)} more in the shop for your next one.`, 409);
    const roll = d20();
    const won = rollPrize(kind, roll);
    const prizeId = won ? makeId('pz') : null;
    const code = won?.kind === 'percent' ? `NAT20-${makeRef().slice(4)}` : null;
    const expiresAt = won?.kind === 'percent' ? now + PRIZE_CODE_DAYS * 24 * HOUR : null;
    this.write('INSERT INTO member_rolls (id, customer_id, kind, day, roll, prize_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', makeId('rl'), who.customerId, kind, day, roll, prizeId, now);
    if (won) {
      this.write(
        "INSERT INTO prizes (id, customer_id, source, kind, amount, percent, code, expires_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'pending', ?, ?)",
        prizeId, who.customerId, kind, won.kind, won.amount || null, won.percent || null, expiresAt, now, now,
      );
    }
    this.touchMember(who.customerId, {}, now);
    // --- claimed ---
    if (!won) return { roll, kind, prize: null, message: this.noPrizeMessage(kind, this.rollsState(who.customerId, now, day)), rolls: this.rollsState(who.customerId, now, day) };
    let problem = null;
    try {
      if (!this.shopify.configured) throw new Error('Shopify is not connected.');
      if (won.kind === 'credit') {
        await this.shopify.creditCustomer(who.customerId, won.amount, this.env.CURRENCY || 'NZD');
      } else {
        await this.shopify.createPrizeCode({
          title: `Natural 20: 10% off (${code})`, code, percent: won.percent / 100, endsAt: expiresAt, customerId: who.customerId,
          combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: false },
        });
      }
    } catch (error) {
      problem = String(error.message || error).slice(0, 300);
      console.error('Lair: dice prize failed', error);
      this.note({ prizeError: { message: problem, at: new Date().toISOString() } });
    }
    // --- no awaits from here on: only this prize's own row changes ---
    this.write('UPDATE prizes SET status = ?, code = ?, note = ?, updated_at = ? WHERE id = ?', problem ? 'owed' : 'given', problem ? null : code, problem, Date.now(), prizeId);
    const prize = this.prizeView(this.sql.exec('SELECT * FROM prizes WHERE id = ?', prizeId).one());
    if (problem) {
      const member = this.memberRow(who.customerId);
      this.notifyStaff(`Prize to give at the counter: ${member?.name || member?.code || 'a member'}`, {
        title: 'A dice prize to give at the counter',
        intro: "Shopify couldn't hand over a dice prize, so the member will show their screen at the counter. Give it to them there.",
        details: [
          ['Member', `${member?.name || 'Unknown'}${member?.code ? ` (${member.code})` : ''}`], ['Roll', `${roll} on a ${kind} roll`],
          ['Prize', won.kind === 'credit' ? `${dollars(won.amount)} store credit` : `${won.percent}% off one order`], ['Why', problem],
        ],
      });
    }
    return {
      roll, kind, prize, message: problem ? 'Show this screen at the counter to claim it.' : this.prizeMessage(kind, roll, won),
      rolls: this.rollsState(who.customerId, Date.now(), day),
    };
  }

  prizeMessage(kind, roll, won) {
    if (won.kind === 'percent') return `Natural 20! Your own 10% off code is ready. Use it within ${PRIZE_CODE_DAYS} days; it doesn't combine with other discounts.`;
    if (kind === 'daily') return "Natural 1, and Gobgob's feeling generous: $1 store credit is on your account.";
    if (roll === 11) return 'Double 1s! That\'s $2 store credit on your account.';
    return `A ${roll} has a 1 in it, so $1 store credit is on your account.`;
  }

  noPrizeMessage(kind, rolls) {
    if (kind === 'daily') return 'No prize this time. Your next free roll is tomorrow.';
    return rolls.bonus ? `No prize this time. You've got ${rolls.bonus} bonus ${rolls.bonus === 1 ? 'roll' : 'rolls'} left.` : 'No prize this time. Every $20 you spend in the shop earns another roll.';
  }

  /** A member's rolls: whether today's free roll is still there, bonus rolls banked from spend, and spend until the next one. */
  rollsState(customerId, now, day) {
    const spend = this.spendOf(customerId, now);
    const used = this.sql.exec("SELECT COUNT(*) AS n FROM member_rolls WHERE customer_id = ? AND kind = 'bonus'", String(customerId)).one().n;
    const rolledToday = this.sql.exec("SELECT 1 AS n FROM member_rolls WHERE customer_id = ? AND kind = 'daily' AND day = ?", String(customerId), day).toArray().length > 0;
    return { daily: !rolledToday, bonus: Math.max(0, Math.floor(spend.total / ROLL_EVERY) - used), toNext: ROLL_EVERY - (spend.total % ROLL_EVERY) };
  }

  /** A prize as My Lair shows it. owed: Shopify couldn't hand it over yet, so it's claimed at the counter. */
  prizeView(p) {
    return {
      kind: p.kind, source: p.source, ...(p.kind === 'credit' ? { amount: p.amount } : { percent: p.percent, code: p.code || null, expiresAt: p.expires_at }),
      at: p.created_at, owed: p.status !== 'given',
    };
  }

  /* ---------------- members ---------------- */
  memberRow(customerId) {
    return customerId ? this.sql.exec('SELECT * FROM members WHERE customer_id = ?', String(customerId)).toArray()[0] || null : null;
  }

  /** A known member whose email matches, most recently seen first */
  memberByEmail(email) {
    if (!isEmail(email)) return null;
    return this.sql.exec('SELECT * FROM members WHERE lower(email) = lower(?) ORDER BY last_seen DESC LIMIT 1', String(email).trim()).toArray()[0] || null;
  }

  /**
   * A logged-in customer booked, joined or opened My Lair: remember them. A booking only fills in a name or email we
   * don't have yet (people book for friends and groups); My Lair's profile form sets them. A new member gets their
   * code here, from the name we have (DG with none), and keeps it: renaming themselves doesn't change it. No awaits.
   */
  touchMember(customerId, { name, email } = {}, now = Date.now()) {
    if (!customerId) return;
    const full = trimmed(name, 80) || null;
    const first = full ? full.split(/\s+/)[0].slice(0, 40) : null;
    const row = this.memberRow(customerId);
    const code = row?.code || this.newCode(row?.name || full || '', 'member', customerId, now);
    this.write(
      `INSERT INTO members (customer_id, name, first_name, email, code, last_seen, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(customer_id) DO UPDATE SET name = COALESCE(members.name, excluded.name), first_name = COALESCE(members.first_name, excluded.first_name),
         email = COALESCE(members.email, excluded.email), code = COALESCE(members.code, excluded.code), last_seen = excluded.last_seen,
         updated_at = excluded.updated_at`,
      String(customerId), full, first, isEmail(email) ? trimmed(email, 120) : null, code, now, now, now,
    );
  }

  /** POST /members/:customerId/new-code (staff): a fresh member code (a lost or shared one). The old one stops working. */
  async newMemberCode(customerId, who) {
    this.requireStaff(who);
    // --- no awaits from here on ---
    const now = Date.now();
    const row = this.memberRow(trimmed(customerId, 40));
    if (!row) throw new RuleError('No member with that customer ID.', 404);
    const code = this.newCode(row.name || row.first_name || '', 'member', row.customer_id, now);
    this.write('UPDATE members SET code = ?, updated_at = ? WHERE customer_id = ?', code, now, row.customer_id);
    return { code };
  }

  /** Spend from paid orders: all of it, and the last 12 months */
  spendOf(customerId, now = Date.now()) {
    const row = this.sql
      .exec('SELECT COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(CASE WHEN created_at > ? THEN amount ELSE 0 END), 0) AS year FROM spend WHERE customer_id = ?', now - YEAR, String(customerId))
      .one();
    return { total: row?.total || 0, year: row?.year || 0 };
  }

  /** A member as staff see them */
  memberView(row, now = Date.now()) {
    const spend = this.spendOf(row.customer_id, now);
    return {
      customerId: row.customer_id, name: row.name || '', firstName: row.first_name || '', email: row.email || '', birthday: row.birthday || '',
      spendYear: spend.year, spendTotal: spend.total, rollsFromSpend: Math.floor(spend.total / ROLL_EVERY),
      rollsUsed: this.sql.exec("SELECT COUNT(*) AS n FROM member_rolls WHERE customer_id = ? AND kind = 'bonus'", row.customer_id).one().n,
      lastSeen: row.last_seen || null, code: row.code || null,
    };
  }

  /** POST /me/profile: the member's own name, email and birthday ('MM-DD' or empty). Only the fields sent change. */
  async saveProfile(input, who) {
    if (!who.customerId) throw new RuleError('Log in to save your details.', 401);
    const now = Date.now();
    const row = this.memberRow(who.customerId) || {};
    const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
    const name = has('name') ? trimmed(input.name, 80) || null : row.name || null;
    const firstName = has('firstName') ? trimmed(input.firstName, 40) || null : row.first_name || (name ? name.split(/\s+/)[0].slice(0, 40) : null);
    let email = row.email || null;
    if (has('email')) {
      email = trimmed(input.email, 120) || null;
      if (email && !isEmail(email)) throw new RuleError("That email address doesn't look right.");
    }
    const birthday = has('birthday') ? parseBirthday(input.birthday) : row.birthday || null;
    const code = row.code || this.newCode(name || firstName || '', 'member', who.customerId, now);
    this.write(
      `INSERT INTO members (customer_id, name, first_name, email, birthday, code, last_seen, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(customer_id) DO UPDATE SET name = excluded.name, first_name = excluded.first_name, email = excluded.email,
         birthday = excluded.birthday, code = COALESCE(members.code, excluded.code), last_seen = excluded.last_seen, updated_at = excluded.updated_at`,
      who.customerId, name, firstName, email, birthday, code, now, now, now,
    );
    return { member: this.memberView(this.memberRow(who.customerId), now) };
  }

  /** GET /members?q= (staff): find members by name, email, member code (any way it's typed) or customer ID. */
  members(url, who) {
    this.requireStaff(who);
    const now = Date.now();
    const q = trimmed(url.searchParams.get('q'), 80).toLowerCase();
    if (!q) return this.sql.exec('SELECT * FROM members ORDER BY last_seen DESC LIMIT 25').toArray().map((r) => this.memberView(r, now));
    const found = this.findCode(q);
    const id = found?.type === 'member' ? found.item.customer_id : /^\d{3,20}$/.test(q) ? q : '';
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.sql
      .exec(
        `SELECT * FROM members WHERE customer_id = ? OR lower(name) LIKE ? ESCAPE '\\' OR lower(first_name) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\'
           OR lower(code) LIKE ? ESCAPE '\\'
         ORDER BY customer_id = ? DESC, last_seen DESC LIMIT 25`,
        id, like, like, like, like, id,
      )
      .toArray()
      .map((r) => this.memberView(r, now));
  }

  /* ---------------- birthdays ---------------- */
  /** Members whose birthday falls from today to `days` days ahead, soonest first */
  upcomingBirthdays(rules, now, days) {
    const time = new LairTime(rules.tz);
    const today = time.key(now);
    const until = addDays(today, days);
    return this.sql
      .exec("SELECT * FROM members WHERE birthday IS NOT NULL AND birthday != ''")
      .toArray()
      .map((row) => {
        const date = nextBirthday(row.birthday, today);
        return date && date <= until ? { row, date, days: time.daysBetween(today, date) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.days - b.days || String(a.row.name || '').localeCompare(String(b.row.name || '')));
  }

  /**
   * The daily birthday run, from the 10-minute maintenance once it's past 9am at the Lair: members with a birthday in
   * the next 7 days get a personal code, by email, and staff get a list. The discount follows spend over the last 12
   * months (birthdayPercent) and the code lasts 14 days. One code per member per birthday, and none within 300 days
   * of the last (a birthday can be edited). Codes are claimed in the database before Shopify is asked, so a second
   * run can't double up.
   */
  async birthdays(rules, now) {
    const time = new LairTime(rules.tz);
    const today = time.key(now);
    if (this.birthdayDay === today || time.parts(now).h < 9) return null;
    this.birthdayDay = today;
    const claimed = [];
    for (const { row, date } of this.upcomingBirthdays(rules, now, 7)) {
      const had = this.sql
        .exec("SELECT 1 AS n FROM prizes WHERE customer_id = ? AND source = 'birthday' AND (period = ? OR created_at > ?)", row.customer_id, date.slice(0, 4), now - 300 * 24 * HOUR)
        .toArray().length;
      if (had) continue;
      const prize = {
        id: makeId('pz'), row, date, code: `BDAY-${makeRef().slice(4)}`, percent: birthdayPercent(this.spendOf(row.customer_id, now).year),
        expiresAt: now + BIRTHDAY_CODE_DAYS * 24 * HOUR, problem: null,
      };
      this.write(
        "INSERT INTO prizes (id, customer_id, source, kind, percent, expires_at, status, period, created_at, updated_at) VALUES (?, ?, 'birthday', 'percent', ?, ?, 'pending', ?, ?, ?)",
        prize.id, row.customer_id, prize.percent, prize.expiresAt, date.slice(0, 4), now, now,
      );
      claimed.push(prize);
    }
    if (!claimed.length) return { sent: 0 };
    // --- claimed: now ask Shopify for the codes ---
    for (const prize of claimed) {
      try {
        if (!this.shopify.configured) throw new Error('Shopify is not connected.');
        await this.shopify.createPrizeCode({
          title: `Birthday ${prize.percent}% off: ${prize.row.name || prize.row.code || prize.row.customer_id} (${prize.code})`, code: prize.code, percent: prize.percent / 100,
          endsAt: prize.expiresAt, customerId: prize.row.customer_id, combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: false },
        });
      } catch (error) {
        prize.problem = String(error.message || error).slice(0, 300);
        console.error('Lair: birthday code failed', error);
      }
    }
    // --- no awaits from here on: only these prizes' own rows change ---
    const later = Date.now();
    for (const p of claimed) this.write('UPDATE prizes SET status = ?, code = ?, note = ?, updated_at = ? WHERE id = ?', p.problem ? 'owed' : 'given', p.problem ? null : p.code, p.problem, later, p.id);
    const day = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: rules.tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(time.at(key, 12 * 60)));
    const until = (ms) => new Intl.DateTimeFormat('en-NZ', { timeZone: rules.tz, day: 'numeric', month: 'long' }).format(new Date(ms));
    const letters = claimed.filter((p) => isEmail(p.row.email)).map((p) => {
      const first = p.row.first_name || String(p.row.name || '').split(/\s+/)[0] || 'friend';
      return this.letter(p.row.email, `Happy birthday, ${first}! A present from Dice Goblin`, {
        title: `Happy birthday, ${first}!`,
        intro: p.problem
          ? `Gobgob heard your birthday's coming up (${day(p.date)}), so here's a present: ${p.percent}% off one order. Show this email at the counter to use it.`
          : `Gobgob heard your birthday's coming up (${day(p.date)}), so here's a present: ${p.percent}% off one order, in the shop or online.`,
        details: [
          ['Your code', p.problem ? 'Show this email at the counter' : p.code], ['Discount', `${p.percent}% off one order`], ['Use it by', until(p.expiresAt)],
          ['Online', p.problem ? '' : 'Log in, then enter the code at checkout'],
        ],
        outro: "It's just for you, works once, and doesn't combine with other discounts.",
        button: { label: 'Treat yourself', url: this.link('/') },
        signoff: 'Have a great one, friend!\nGobgob',
      });
    });
    if (letters.length && emailReady(this.env)) this.later(this.mailMany(letters));
    this.notifyStaff(`Birthday codes: ${claimed.length} sent`, {
      title: 'Birthday codes went out',
      intro: `${claimed.length} ${claimed.length === 1 ? 'member has' : 'members have'} a birthday in the next week, so Gobgob sent ${claimed.length === 1 ? 'a code' : 'codes'}.${claimed.some((p) => p.problem) ? " Shopify couldn't make some of them: those members will show their email at the counter." : ''}`,
      details: claimed.map((p) => [p.row.name || p.row.code || p.row.customer_id, `${p.percent}% off, ${p.problem ? 'give it at the counter' : p.code}. Birthday ${day(p.date)}.${isEmail(p.row.email) ? '' : ' No email, so it shows in My Lair only.'}`]),
    });
    return { sent: claimed.length, codes: claimed.filter((p) => !p.problem).length };
  }

  /** GET /members/birthdays (staff): the next 30 days of birthdays, with spend and the code each gets (or got). */
  async birthdayList(who) {
    this.requireStaff(who);
    const rules = await this.rules();
    const now = Date.now();
    return this.upcomingBirthdays(rules, now, 30).map(({ row, date, days }) => {
      const view = this.memberView(row, now);
      const given = this.sql.exec("SELECT * FROM prizes WHERE customer_id = ? AND source = 'birthday' AND period = ?", row.customer_id, date.slice(0, 4)).toArray()[0];
      return { ...view, date, days, percent: given?.percent ?? birthdayPercent(view.spendYear), code: given?.code || null, sent: Boolean(given) };
    });
  }

  /* ---------------- My Lair ---------------- */
  async me(who) {
    if (!who.customerId) throw new RuleError('Log in to see your bookings.', 401);
    const rules = await this.rules();
    const now = Date.now();
    this.touchMember(who.customerId, {}, now);
    const member = this.memberView(this.memberRow(who.customerId), now);
    const since = now - 30 * 24 * HOUR;
    const own = this.sql.exec('SELECT * FROM bookings WHERE customer_id = ? AND ends_at > ? ORDER BY starts_at', who.customerId, since).toArray().map((r) => this.rowToBooking(r));
    const view = (b) => ({
      id: b.id, ref: b.ref, kind: b.kind, tables: b.tables, room: b.room, start: b.start, end: b.end, people: b.people, status: b.status,
      paid: b.paid, amount: b.amount, pay: b.pay, extras: b.extras, players: b.party || [], occurrenceId: b.occurrenceId || null, refund: b.refund || null,
      payment: b.pay === 'now' ? 'online' : 'store',
    });
    const gameRows = this.sql.exec('SELECT * FROM games WHERE gm_customer_id = ? AND ends_at > ? ORDER BY starts_at', who.customerId, since).toArray().map((r) => this.rowToGame(r));
    const span = gameRows.length ? this.state(Math.min(...gameRows.map((g) => g.start)) - 1, Math.max(...gameRows.map((g) => g.end)) + 1) : null;
    const seatGames = new Map();
    for (const b of own.filter((x) => x.kind === 'gm-seat' && x.gameId)) if (!seatGames.has(b.gameId)) seatGames.set(b.gameId, this.game(b.gameId));
    const profile = this.sql.exec('SELECT name, bio FROM gm_profiles WHERE customer_id = ?', who.customerId).toArray()[0] || null;
    const credits = this.sql
      .exec('SELECT c.*, g.title AS title FROM credits c LEFT JOIN games g ON g.id = c.game_id WHERE c.customer_id = ? ORDER BY c.created_at DESC LIMIT 20', who.customerId)
      .toArray()
      .map((c) => ({ gameId: c.game_id, title: c.title, players: c.players, amount: c.amount, status: c.status, at: c.created_at }));
    const joins = this.sql.exec('SELECT * FROM event_joins WHERE customer_id = ? AND ends_at > ? ORDER BY starts_at', who.customerId, since).toArray().map((r) => this.rowToJoin(r));
    return {
      customer: { id: who.customerId, staff: who.staff, gm: who.gm },
      gmProfile: profile ? { name: profile.name, bio: profile.bio } : null,
      bookings: own.filter((b) => b.kind === 'table' || b.kind === 'walkin').map(view),
      seats: own.filter((b) => b.kind === 'gm-seat').map((b) => {
        const g = seatGames.get(b.gameId);
        return {
          ...view(b), gameId: b.gameId, gameTitle: g?.title || 'GM game', system: g?.system || '', gm: g?.gm || '', image: this.imageUrl(g?.imageId),
          seriesId: b.seriesId || null,
        };
      }),
      games: gameRows.map((g) => ({ ...this.gameView(g, span, rules), players: this.gamePlayers(span, g.id) })),
      joins: joins.map((j) => this.joinView(j)),
      credits,
      member: {
        firstName: member.firstName, name: member.name, email: member.email, birthday: member.birthday, spendYear: member.spendYear,
        spendTotal: member.spendTotal, code: member.code,
      },
      // Games they're seated at every session of (POST /series/:id/leave stops it)
      series: this.sql
        .exec("SELECT m.*, s.details AS details FROM series_members m JOIN series s ON s.id = m.series_id WHERE m.customer_id = ? AND m.status = 'active' AND s.status = 'active'", who.customerId)
        .toArray()
        .map((m) => ({ seriesId: m.series_id, title: parse(m.details, {}).title || 'GM game', people: m.people, players: parse(m.players, []) })),
      rolls: this.rollsState(who.customerId, now, new LairTime(rules.tz).key(now)),
      prizes: this.sql.exec('SELECT * FROM prizes WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10', who.customerId).toArray().map((p) => this.prizeView(p)),
    };
  }

  /** Health check, run by /setup (forced) and every 10 minutes by the cron trigger. The result is saved in the status table. */
  async checkConnection(webhookUrl, { force = false, testEmail = false } = {}) {
    if (force) this.rulesCache = null;
    const rules = await this.rules();
    const result = {
      checkedAt: new Date().toISOString(),
      shopify: this.shopify.configured,
      email: emailReady(this.env),
      timezone: rules.tz,
      rooms: rules.rooms.map((r) => `${r.name}: ${r.tables.length} ${r.tables.length === 1 ? 'table' : 'tables'} (${r.tables[0]?.id || '-'}…), ${dollars(r.price)} per person`),
    };
    if (this.shopify.configured) {
      try {
        const info = await this.shopify.appInfo();
        result.shopifyLogin = 'ok';
        result.app = info.app;
        result.shop = info.shop;
        result.missingScopes = REQUIRED_SCOPES.filter(
          (scope) => !info.scopes.includes(scope) && !(scope.startsWith('read_') && info.scopes.includes(scope.replace(/^read_/, 'write_'))),
        );
        if (result.missingScopes.length) result.advice = `Add these permissions to the app's version in the Dev Dashboard, release it, and approve the update in Shopify: ${result.missingScopes.join(', ')}`;
        const missingFeatures = Object.keys(FEATURE_SCOPES).filter((scope) => !info.scopes.includes(scope));
        if (missingFeatures.length) {
          result.missingFeatureScopes = missingFeatures;
          result.featureAdvice = `Optional permissions still to approve in Shopify admin (Apps → Dice Goblin Lair): ${missingFeatures.map((x) => `${x} (${FEATURE_SCOPES[x]})`).join(', ')}`;
        }
      } catch (error) {
        result.shopifyLogin = String(error.message || error).slice(0, 300);
        result.advice = /app_not_installed/.test(result.shopifyLogin)
          ? 'The app is not installed on the store yet: Dev Dashboard → the app → Install app → choose the Dice Goblin store.'
          : /invalid|client|credential|401/i.test(result.shopifyLogin)
            ? 'Shopify did not accept the client ID or secret: check SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in the config table.'
            : 'Shopify could not be reached just now; the app retries every 10 minutes.';
      }
      result.paymentWebhook = await this.ensureWebhook(webhookUrl, { force });
      if (!result.paymentWebhook.ok && /Shopify login failed/.test(result.paymentWebhook.reason || '')) result.paymentWebhook.reason = 'Waiting for the Shopify login to work.';
    } else {
      result.advice = 'Add SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET to the config table.';
    }
    if (testEmail) {
      // /setup?key=…&email=test sends one email to the staff inbox, to prove the Resend key and domain work.
      const to = this.env.STAFF_EMAIL || this.env.REPLY_TO;
      if (!emailReady(this.env)) result.emailTest = { ok: false, message: 'Add RESEND_API_KEY and FROM_EMAIL to the config table first.' };
      else if (!isEmail(to)) result.emailTest = { ok: false, message: 'Add STAFF_EMAIL to the config table to receive the test.' };
      else {
        const sent = await this.mail(this.letter(to, 'Dice Goblin booking emails are working', {
          title: 'Booking emails are working',
          intro: [
            'Kia ora! This is a test from the Dice Goblin booking app. If you can read this, Gobgob can send emails.',
            `Booking emails go out from ${this.env.FROM_EMAIL}${this.env.REPLY_TO ? `, and replies come back to ${this.env.REPLY_TO}` : ''}.`,
          ],
        }));
        result.emailTest = { ok: sent.ok, to, status: sent.status, message: sent.message };
      }
    }
    try {
      const extended = this.extendSeries(rules, Date.now());
      if (extended.length) result.series = extended;
    } catch (error) {
      console.error('Lair: could not extend game series', error);
    }
    // The same daily maintenance sends birthday codes (once a day, after 9am).
    try {
      const birthdays = await this.birthdays(rules, Date.now());
      if (birthdays) result.birthdays = birthdays;
    } catch (error) {
      console.error('Lair: birthday codes failed', error);
    }
    this.note({ connection: result });
    return result;
  }
}

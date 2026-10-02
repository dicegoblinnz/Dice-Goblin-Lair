// Dice Goblin Lair — one Durable Object holds every booking, game and hold.
//
// Concurrency: a Durable Object runs one piece of code at a time, but while it waits on Shopify (an outbound
// fetch) another request can run. So every handler does its Shopify waiting first, then reads, checks and writes
// with no `await` in between. Where a Shopify call has to come after a write (checkouts, store credit), the
// handler claims the row first and afterwards only updates the columns it owns.
import {
  ACTIVE, HOUR, MIN, LairTime, RuleError, addDays, blockingItems, checkGameDetails, checkGameSession, checkSeatBooking, checkTableBooking,
  ROLL_EVERY, eventOccurrences, findOccurrence, isFree, makeId, makeNameRef, makeRef, oneRoom, parseBirthday, parseTableList, parseTicketCode,
  publicBooking, publicGame, readSettingsData, refName, refundFor, rulesFromSettings, seatsTaken, tableIndex,
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
const FEATURE_SCOPES = { write_discounts: 'dice roller prize codes' };
/** The Dice Chest prize: a free dice with any purchase, for a natural 1 on the home page roller */
const DICE_CHEST = { variantId: '50363551023207', price: 500 };
const IMAGE_LIMIT = 700 * 1024;
const HOLD_MINUTES = 30;
const RULES_TTL = 5 * MIN;
const PERSON_TTL = 5 * MIN;
const STATE_TTL = 60_000;
/** Abuse limits for people who are not staff */
const LIMITS = { perClientPer10Min: 20, activePerEmail: 6 };
/** What the public sees for a staff hold (staff labels can hold names or notes) */
const PUBLIC_HOLD = { tournament: 'Tournament', market: 'Market', event: 'Event', maintenance: 'Out of action' };

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
];

const BOOKING_COLUMNS = [
  'id', 'ref', 'kind', 'status', 'tables', 'room', 'starts_at', 'ends_at', 'people', 'name', 'email', 'phone', 'notes', 'activity',
  'extras', 'pay', 'paid', 'amount', 'game_id', 'customer_id', 'hold_until', 'draft_order_id', 'order_id', 'party', 'arrived_at',
  'refund', 'created_at', 'updated_at',
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
      refund: r.refund || null, refundDue: r.refund === 'due', refunded: r.refund === 'done',
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
      b.party?.length ? JSON.stringify(b.party) : null, b.arrivedAt || null, b.refund || null, now, now,
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

  /**
   * A ticket code nobody has used, booking or event sign-up: SAM-4821 from the booker's first name. If that name's
   * 10,000 codes are nearly all used, GOB-4821, and after that the first release's GOB-7K2QXM style.
   */
  uniqueRef(name = '') {
    const used = (ref) => this.sql.exec('SELECT 1 AS n FROM bookings WHERE ref = ? UNION ALL SELECT 1 AS n FROM event_joins WHERE ref = ?', ref, ref).toArray().length > 0;
    for (const prefix of [...new Set([refName(name), 'GOB'])]) {
      for (let i = 0; i < 25; i += 1) {
        const ref = makeNameRef(prefix);
        if (!used(ref)) return ref;
      }
    }
    for (let i = 0; i < 20; i += 1) {
      const ref = makeRef();
      if (!used(ref)) return ref;
    }
    throw new Error('Could not find a free booking reference');
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
        payOnline: r.payOnline,
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
        return json({ error: 'Not found' }, 404);
      }
      const origin = request.headers.get('X-Lair-Origin');
      if (origin) {
        this.later(this.ensureWebhook(`${origin}/webhooks/orders-paid`));
        // For the status page: did the website reach a booking route, and through which store address?
        const day = new Date().toISOString().slice(0, 10);
        const prefix = url.searchParams.get('path_prefix') || null;
        const known = (request.method === 'GET' && ['floor', 'me', 'members'].includes(a))
          || (request.method === 'POST' && ['bookings', 'games', 'series', 'blocks', 'openings', 'checkin', 'events', 'contact', 'roll', 'gm-profile', 'me'].includes(a));
        this.note(known ? { proxy: { seen: true, prefix, day } } : { proxyMiss: { path: url.pathname, method: request.method, prefix, day } });
      }
      const who = await this.person(request.headers.get('X-Lair-Customer') || '');
      const client = request.headers.get('X-Lair-Client') || '';
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      if (request.method === 'GET' && a === 'floor') return json(await this.floor(url, who));
      if (request.method === 'GET' && a === 'me' && !b) return json(await this.me(who));
      if (request.method === 'GET' && a === 'members' && !b) return json(this.members(url, who));
      if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
      const d = parts[3];
      if (a === 'me' && b === 'profile') return json(await this.saveProfile(body, who));
      if (a === 'bookings' && !b) return json(await this.createBooking(body, who, client));
      if (a === 'bookings' && c === 'update') return json(await this.updateBooking(b, body, who));
      if (a === 'games' && !b) return json(await this.createGame(body, who, client));
      if (a === 'games' && c === 'update') return json(await this.updateGame(b, body, who));
      if (a === 'games' && c === 'credit') return json(await this.creditGm(b, who));
      if (a === 'games' && c === 'sessions') return json(await this.addSession(b, body, who));
      if (a === 'games' && c === 'image') return json(await this.gameImage(b, body, who));
      if (a === 'gm-profile' && !b) return json(await this.saveGmProfile(body, who));
      if (a === 'blocks' && !b) return json(await this.createBlock(body, who));
      if (a === 'blocks' && c === 'delete') return json(await this.removeBlock(b, who));
      if (a === 'openings' && !b) return json(await this.createOpening(body, who));
      if (a === 'openings' && c === 'delete') return json(await this.removeOpening(b, who));
      if (a === 'checkin' && !b) return json(await this.checkIn(body, who));
      if (a === 'events' && b === 'joins' && d === 'cancel') return json(await this.cancelJoin(c, who));
      if (a === 'events' && b && c === 'join') return json(await this.joinEvent(decodeURIComponent(b), body, who, client));
      if (a === 'contact' && !b) return json(await this.contact(body, who, client));
      if (a === 'roll' && !b) return json(await this.roll(who, client));
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
      ...(who.staff ? { joins: joinRows.map((j) => ({ id: j.id, ref: j.ref, occurrenceId: j.occurrenceId, title: j.title, start: j.start, end: j.end, name: j.name, email: j.email, people: j.people, note: j.note, status: j.status, arrivedAt: j.arrivedAt })) } : {}),
      shopTables: rules.shopTables || [],
      openings: st.openings.map((o) => (who.staff ? o : { id: o.id, tables: o.tables, start: o.start, end: o.end })),
      staff: who.staff,
      features: { email: emailReady(this.env), payOnline: rules.payOnline && this.shopify.configured },
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
    if (!who.staff && booking.email) {
      const active = this.sql
        .exec("SELECT COUNT(*) AS n FROM bookings WHERE lower(email) = lower(?) AND ends_at > ? AND status IN ('held', 'confirmed')", booking.email, now)
        .one().n;
      if (active >= LIMITS.activePerEmail) throw new RuleError(`You already have ${active} bookings coming up. Call us to book more.`, 429);
    }
    const wantsPayNow = input.pay === 'now' && kind !== 'walkin';
    const payNow = wantsPayNow && rules.payOnline && this.shopify.configured;
    Object.assign(booking, {
      id: makeId('bk'), ref: this.uniqueRef(input.name), pay: payNow ? 'now' : 'day', paid: kind === 'walkin' ? Boolean(input.paid) : false,
      status: kind === 'walkin' ? 'seated' : payNow ? 'held' : 'confirmed', holdUntil: payNow ? now + HOLD_MINUTES * MIN : null,
      customerId: override ? null : who.customerId || null,
    });
    this.saveBooking(booking, now);
    if (!override) this.touchMember(who.customerId, { name: booking.name, email: booking.email }, now);
    // --- saved: the table is ours ---

    let notice = wantsPayNow && !payNow ? "Online payment isn't available, so pay at the counter. Your booking is confirmed." : null;
    if (payNow) {
      try {
        const unit = kind === 'gm-seat' ? game.seatPrice || rules.prices.gmSeat : tableIndex(rules.rooms).get(booking.tables[0]).roomObj.price;
        const { draftOrderId, checkoutUrl } = await this.shopify.createCheckout({
          ref: booking.ref,
          title: kind === 'gm-seat' ? `GM game seat: ${game.title}` : `Lair table fee (${booking.tables.join(', ')})`,
          unitPrice: unit,
          quantity: booking.people,
          email: booking.email,
          currency: this.env.CURRENCY || 'NZD',
          attributes: {
            Booking: booking.ref, When: this.when(booking, rules), Tables: booking.tables.join(', '), Name: booking.name,
            Cancelling: `Full refund if you cancel at least ${rules.refundHours} hours before`,
          },
        });
        this.write('UPDATE bookings SET draft_order_id = ?, updated_at = ? WHERE id = ?', draftOrderId, Date.now(), booking.id);
        const fresh = this.booking(booking.id);
        if (fresh.status === 'held') return { booking: this.ownView(fresh), checkoutUrl, holdMinutes: HOLD_MINUTES };
        this.dropDraft(fresh);
        return { booking: this.ownView(fresh), notice: 'This booking changed while we set up payment. Please call us.' };
      } catch (error) {
        console.error('Lair: checkout could not be created', error);
        this.write(
          "UPDATE bookings SET pay = 'day', status = CASE WHEN status = 'held' THEN 'confirmed' ELSE status END, hold_until = NULL, updated_at = ? WHERE id = ?",
          Date.now(), booking.id,
        );
        booking = this.booking(booking.id);
        notice = "Online payment isn't working right now, so pay at the counter. Your booking is confirmed.";
      }
    }
    const emailed = kind !== 'walkin' && booking.status === 'confirmed' && this.confirm(booking, rules, game);
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

  ownView(b) {
    return { ...publicBooking(b), ref: b.ref, name: b.name, email: b.email, people: b.people, paid: b.paid, amount: b.amount, pay: b.pay, room: b.room };
  }

  async updateBooking(id, patch, who) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const booking = this.booking(id);
    if (!booking) throw new RuleError('Booking not found.', 404);
    if (!who.staff) {
      const own = who.customerId && booking.customerId === who.customerId;
      if (own && booking.kind === 'gm') throw new RuleError('To cancel your game, cancel it from the games board.', 403);
      if (!own || patch.status !== 'cancelled' || booking.start <= now) throw new RuleError('Only staff can change that booking.', 403);
      if (booking.status === 'cancelled') return { booking: this.ownView(booking), refund: { due: false, amount: 0, reason: 'already cancelled' } };
      const refund = refundFor(booking, rules, now);
      booking.status = 'cancelled';
      booking.holdUntil = null;
      if (refund.due) booking.refund = 'due';
      this.saveBooking(booking, now);
      this.dropDraft(booking);
      if (refund.due) {
        this.notifyStaff(`Refund due: ${booking.ref}`, {
          title: 'Refund due',
          intro: `${booking.name} cancelled ${booking.ref} more than ${rules.refundHours} hours ahead, so they get their money back. Refund it in Shopify.`,
          details: [['Booking', booking.ref], ['Was for', this.when(booking, rules)], ['Refund', dollars(refund.amount)], ['Order', refund.orderId || 'See Orders in Shopify']],
        });
      }
      if (booking.kind === 'gm-seat') this.tellGmSeatDropped(booking, rules);
      return { booking: this.ownView(this.booking(booking.id)), refund };
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
      const unit = next.kind === 'gm-seat' ? seatGame?.seatPrice || rules.prices.gmSeat : tableIndex(rules.rooms).get(next.tables[0])?.roomObj.price || rules.prices.table;
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
    if (ending && next.status === 'cancelled') {
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
    this.saveBooking({
      id: makeId('bk'), ref: this.uniqueRef(game.gm), kind: 'gm', gameId: game.id, tables: game.tables, room: game.room, start: game.start, end: game.end,
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
        created.push(this.saveSession(base, session, now));
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
    const gmCustomerId = who.staff && input.gmCustomerId ? String(input.gmCustomerId) : who.customerId;
    const gmEmail = isEmail(input.email) ? String(input.email).trim().slice(0, 120) : null;
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
    const view = this.state(game.start - 1, game.end + 1);
    return {
      game: this.gameView(game, view, rules), sessions: sessions.map((g) => ({ id: g.id, start: g.start })), skipped, pending: !approved,
      emailed: emailReady(this.env) && Boolean(gmEmail),
    };
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
    if (!approved) {
      this.notifyStaff(`Game to approve: ${created.title}`, {
        title: 'A session to approve',
        intro: `${created.gm} added a session of ${created.title}. Approve it on the staff page and it goes on the games board.`,
        details: [['Game', created.title], ['When', this.when(created, rules)], ['Tables', created.tables.join(', ')]],
      });
    }
    return { game: this.gameView(created, this.state(created.start - 1, created.end + 1), rules) };
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
    if (before === 'pending' && game.status === 'open' && emailReady(this.env) && isEmail(game.gmEmail)) {
      const credit = game.gmFee ?? rules.prices.gmCredit;
      this.later(this.mail(this.letter(game.gmEmail, `Your game is live: ${game.title}`, {
        title: 'Your game is on the board!',
        intro: `Kia ora ${game.gm}, ${game.title} is approved and on the games board.${game.seriesId ? ' Every session of it is approved.' : ''} Time to start plotting, friend.`,
        details: [
          ['Game', game.title], [game.seriesId ? 'Next session' : 'When', this.when(game, rules)], ['Tables', game.tables.join(', ')],
          ['Player seats', String(game.seats)],
          ['Your credit', credit ? `${dollars(credit)} store credit for each paying player, after the session` : "None: you're covering your players' GM fee, so they pay just the table fee"],
        ],
        button: { label: 'See the games board', url: this.page('gm') },
        signoff: 'Happy GMing!\nGobgob',
      })));
    }
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
   * orders/paid webhook (signature already checked by the Worker). Customers can put any text in a cart note or
   * cart attribute, so only orders that came from a draft order (our checkouts; customers can't make those) count,
   * and only for bookings that were sent to checkout. Shopify is asked which order the booking's draft became; if
   * the draft is gone (deleted as the hold ran out) or not linked yet, the draft-order source is the proof.
   */
  async ordersPaid(order) {
    const orderId = order.admin_graphql_api_id || (order.id ? `gid://shopify/Order/${order.id}` : '');
    const source = order.source_name;
    if (!orderId || !this.shopify.configured || (source && source !== 'shopify_draft_order')) return { updated: [] };
    const refs = new Set();
    for (const a of order.note_attributes || []) if (a.name === '_booking' && a.value) refs.add(String(a.value));
    for (const item of order.line_items || []) for (const p of item.properties || []) if (p.name === '_booking' && p.value) refs.add(String(p.value));
    for (const match of String(order.note || '').matchAll(/\b(?:[A-Z]{2,10}-\d{4}|GOB-[A-Z0-9]{6})\b/g)) refs.add(match[0]);
    if (!refs.size) return { updated: [] };
    const rules = await this.rules();
    const verified = [];
    for (const ref of [...refs].slice(0, 5)) {
      const candidate = this.booking(ref);
      if (!candidate?.draftOrderId) continue;
      // If Shopify can't answer, this throws: the webhook gets a 500 and Shopify sends it again later.
      const linked = await this.shopify.draftOrderOrderId(candidate.draftOrderId);
      if (linked === orderId || (linked === null && source === 'shopify_draft_order')) verified.push(candidate.id);
    }
    // --- no awaits from here on: read each booking fresh and update it ---
    const now = Date.now();
    const updated = [];
    for (const id of verified) {
      const booking = this.booking(id);
      const firstTime = !booking.paid;
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
      if (firstTime && booking.status === 'confirmed') this.confirm(booking, rules, booking.gameId ? this.game(booking.gameId) : null);
      updated.push(booking.ref);
    }
    return { updated };
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
   * Staff scan a ticket or type its code: SAM-4821 (with or without the dash), the first release's GOB-7K2QXM, or a
   * member card DGC-<customer id>. A ticket is checked in and the reply says what's left to pay; a member card lists
   * that person's bookings and sign-ups for today, for staff to pick from.
   */
  async checkIn(input, who) {
    this.requireStaff(who);
    const rules = await this.rules();
    // --- no awaits from here on ---
    return this.ticketCheckIn(input, rules, Date.now());
  }

  /** The check-in itself, shared by the staff page and the POS. No awaits. */
  ticketCheckIn(input, rules, now) {
    const code = parseTicketCode(input.code);
    if (!code) throw new RuleError("That doesn't look like a ticket code. They look like SAM-4821, or DGC- and a number on a member card.", 404);
    if (code.card) return this.memberCard(code.card, rules, now);
    const force = input.force === true;
    for (const ref of code.refs) {
      const booking = this.booking(ref);
      if (booking) return this.checkInBooking(booking, rules, now, force);
      const row = this.sql.exec('SELECT * FROM event_joins WHERE ref = ?', ref).toArray()[0];
      if (row) return this.checkInJoin(this.rowToJoin(row), rules, now, force);
    }
    throw new RuleError(`No booking or sign-up with the code ${code.refs[0]}.`, 404);
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
    this.write("UPDATE event_joins SET status = 'attended', arrived_at = ?, updated_at = ? WHERE id = ?", now, now, join.id);
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
    if (!member && !bookings.length && !joins.length) throw new RuleError(`No member with the card DGC-${customerId}.`, 404);
    const items = [...bookings.map((b) => this.dayItem(b, rules, 'booking')), ...joins.map((j) => this.dayItem(j, rules, 'join'))].sort((a, b) => a.start - b.start);
    const name = member?.name || bookings[0]?.name || joins[0]?.name || `DGC-${customerId}`;
    const due = items.reduce((sum, x) => sum + x.due, 0);
    const list = items.map((x) => `${x.ref}: ${x.title} at ${this.clock(x.start, rules)}${x.checkedIn ? ', checked in' : ''}${x.due ? `, charge ${dollars(x.due)}` : ''}`).join('; ');
    return {
      found: true, kind: 'member', member: { customerId, name, firstName: member?.first_name || '', email: member?.email || '' }, customer: { id: customerId },
      bookings: items, checkedIn: false, due,
      message: items.length ? `${name} has ${items.length} ${items.length === 1 ? 'booking' : 'bookings'} today. ${list}.` : `${name} has nothing booked today.`,
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
    const join = {
      id: makeId('ej'), ref: this.uniqueRef(name), occurrenceId, eventId: occurrence.eventId, title: occurrence.title, start: occurrence.start,
      end: occurrence.end, people, name, email, note: String(input.note || '').trim().slice(0, 300), status: 'confirmed',
    };
    this.write(
      `INSERT INTO event_joins (id, ref, occurrence_id, event_id, title, starts_at, ends_at, people, name, email, note, status, customer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
      join.id, join.ref, occurrenceId, join.eventId, join.title, join.start, join.end, people, name, email, join.note, who.customerId || null, now, now,
    );
    this.touchMember(who.customerId, { name, email }, now);
    this.confirmJoin(join, rules);
    return { join: { id: join.id, ref: join.ref, occurrenceId, people, name }, spacesLeft: left - people };
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
    const now = Date.now();
    const row = this.sql.exec('SELECT * FROM event_joins WHERE id = ? OR ref = ?', id, id).toArray()[0];
    if (!row) throw new RuleError('Sign-up not found.', 404);
    const join = this.rowToJoin(row);
    const own = who.customerId && join.customerId === who.customerId;
    if (!who.staff && !own) throw new RuleError('Only staff can change that sign-up.', 403);
    this.write("UPDATE event_joins SET status = 'cancelled', updated_at = ? WHERE id = ?", now, join.id);
    return { ok: true };
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

  /* ---------------- the home page dice ---------------- */
  /**
   * A d20 rolled on the server. The first roll of the Lair day per visitor is the prize roll: a natural 20 is a
   * personal 5% off code and a natural 1 is a free dice from the Dice Chest (both one use, for 24 hours).
   */
  async roll(who, client = '') {
    const rules = await this.rules();
    const now = Date.now();
    const key = who.customerId ? `c:${who.customerId}` : client ? `ip:${client}` : '';
    if (key) {
      const hits = (this.rollHits?.get(key) || []).filter((t) => now - t < 10 * MIN);
      if (hits.length >= 40) throw new RuleError('Easy, tiger. Give the dice a minute to cool down.', 429);
      this.rollHits = this.rollHits || new Map();
      if (this.rollHits.size > 5000) this.rollHits.clear();
      this.rollHits.set(key, [...hits, now]);
    }
    const roll = (crypto.getRandomValues(new Uint32Array(1))[0] % 20) + 1;
    const day = new LairTime(rules.tz).key(now);
    const earlier = key ? this.sql.exec('SELECT * FROM rolls WHERE key = ? AND day = ?', key, day).toArray()[0] : null;
    const prizeOf = (row) =>
      row?.prize
        ? { kind: row.prize, code: row.code || null, percent: row.prize === 'percent' ? 5 : undefined, variantId: row.prize === 'dice' ? DICE_CHEST.variantId : undefined, productUrl: row.prize === 'dice' ? '/products/dice-chest-prize' : undefined, expiresAt: row.expires_at }
        : null;
    if (!key || earlier) {
      return { roll, prizeRoll: false, prize: prizeOf(earlier), message: 'Prizes are once a day. Come back tomorrow for another lucky roll.' };
    }
    const prize = roll === 20 ? 'percent' : roll === 1 ? 'dice' : null;
    const expiresAt = now + 24 * HOUR;
    // Claim today's prize roll before talking to Shopify, so two quick rolls can't both win.
    this.write('INSERT OR IGNORE INTO rolls (key, day, roll, prize, code, expires_at, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)', key, day, roll, prize, prize ? expiresAt : null, now);
    if (!prize) return { roll, prizeRoll: true, prize: null, message: null };
    const code = `${prize === 'percent' ? 'NAT20' : 'NAT1'}-${makeRef().slice(4)}`;
    let made = false;
    try {
      if (this.shopify.configured) {
        await this.shopify.createPrizeCode(
          prize === 'percent'
            ? { title: `Natural 20: 5% off (${code})`, code, percent: 0.05, endsAt: expiresAt, customerId: who.customerId || null }
            : { title: `Natural 1: free Dice Chest dice (${code})`, code, percent: 1, variantId: DICE_CHEST.variantId, minSubtotalCents: Number(this.env.DICE_CHEST_PRICE || DICE_CHEST.price) + 1, endsAt: expiresAt, customerId: who.customerId || null },
        );
        made = true;
      }
    } catch (error) {
      console.error('Lair: prize code failed', error);
      this.note({ prizeError: { message: String(error.message || error).slice(0, 300), at: new Date().toISOString() } });
    }
    if (made) this.write('UPDATE rolls SET code = ? WHERE key = ? AND day = ?', code, key, day);
    const row = this.sql.exec('SELECT * FROM rolls WHERE key = ? AND day = ?', key, day).one();
    return { roll, prizeRoll: true, prize: prizeOf(row), message: made ? null : 'Show this screen at the counter to claim it.' };
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
   * don't have yet (people book for friends and groups); My Lair's profile form sets them. No awaits.
   */
  touchMember(customerId, { name, email } = {}, now = Date.now()) {
    if (!customerId) return;
    const full = trimmed(name, 80) || null;
    const first = full ? full.split(/\s+/)[0].slice(0, 40) : null;
    this.write(
      `INSERT INTO members (customer_id, name, first_name, email, last_seen, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(customer_id) DO UPDATE SET name = COALESCE(members.name, excluded.name), first_name = COALESCE(members.first_name, excluded.first_name),
         email = COALESCE(members.email, excluded.email), last_seen = excluded.last_seen, updated_at = excluded.updated_at`,
      String(customerId), full, first, isEmail(email) ? trimmed(email, 120) : null, now, now, now,
    );
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
      spendYear: spend.year, spendTotal: spend.total, rollsFromSpend: Math.floor(spend.total / ROLL_EVERY), lastSeen: row.last_seen || null,
      card: `DGC-${row.customer_id}`,
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
    this.write(
      `INSERT INTO members (customer_id, name, first_name, email, birthday, last_seen, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(customer_id) DO UPDATE SET name = excluded.name, first_name = excluded.first_name, email = excluded.email,
         birthday = excluded.birthday, last_seen = excluded.last_seen, updated_at = excluded.updated_at`,
      who.customerId, name, firstName, email, birthday, now, now, now,
    );
    return { member: this.memberView(this.memberRow(who.customerId), now) };
  }

  /** GET /members?q= (staff): find members by name, email or card number. */
  members(url, who) {
    this.requireStaff(who);
    const now = Date.now();
    const q = trimmed(url.searchParams.get('q'), 80).toLowerCase();
    if (!q) return this.sql.exec('SELECT * FROM members ORDER BY last_seen DESC LIMIT 25').toArray().map((r) => this.memberView(r, now));
    const card = parseTicketCode(q)?.card || (/^\d{3,20}$/.test(q) ? q : '');
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.sql
      .exec(
        `SELECT * FROM members WHERE customer_id = ? OR lower(name) LIKE ? ESCAPE '\\' OR lower(first_name) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\'
         ORDER BY last_seen DESC LIMIT 25`,
        card, like, like, like,
      )
      .toArray()
      .map((r) => this.memberView(r, now));
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
      paid: b.paid, amount: b.amount, pay: b.pay, extras: b.extras, players: b.party || [],
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
        return { ...view(b), gameId: b.gameId, gameTitle: g?.title || 'GM game', system: g?.system || '', gm: g?.gm || '', image: this.imageUrl(g?.imageId) };
      }),
      games: gameRows.map((g) => ({ ...this.gameView(g, span, rules), players: this.gamePlayers(span, g.id) })),
      joins: joins.map((j) => ({ id: j.id, ref: j.ref, occurrenceId: j.occurrenceId, title: j.title, start: j.start, end: j.end, people: j.people, status: j.status })),
      credits,
      member: {
        firstName: member.firstName, name: member.name, email: member.email, birthday: member.birthday, spendYear: member.spendYear,
        spendTotal: member.spendTotal, card: member.card,
      },
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
      payOnline: rules.payOnline,
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
    this.note({ connection: result });
    return result;
  }
}

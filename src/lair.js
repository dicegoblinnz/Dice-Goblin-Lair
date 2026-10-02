// Dice Goblin Lair — one Durable Object holds every booking, game and hold.
//
// Concurrency: a Durable Object runs one piece of code at a time, but while it waits on Shopify (an outbound
// fetch) another request can run. So every handler does its Shopify waiting first, then reads, checks and writes
// with no `await` in between. Where a Shopify call has to come after a write (checkouts, store credit), the
// handler claims the row first and afterwards only updates the columns it owns.
import {
  ACTIVE, HOUR, MIN, LairTime, RuleError, blockingItems, checkGame, checkSeatBooking, checkTableBooking, isFree, makeId,
  makeRef, oneRoom, parseTableList, publicBooking, publicGame, readSettingsData, refundFor, rulesFromSettings, seatsTaken, tableIndex,
} from './core.js';
import { ShopifyAdmin, emailReady, sendEmail } from './shopify.js';
import { recordStatus, withConfig } from './config.js';

const FALLBACK_ROOMS = [
  { id: 'main-room', name: 'Main room', code: 'T', tables: 21, seats: 4, order: 1 },
  { id: 'party-room', name: 'Party room', code: 'P', tables: 4, seats: 4, order: 2 },
  { id: 'gaming-room', name: 'Gaming room', code: 'G', tables: 4, seats: 4, order: 3 },
  { id: 'fancy-room', name: 'Fancy room', code: 'F', tables: 1, seats: 12, price: 15, minPeople: 4, order: 4 },
];
/** Permissions the Shopify app needs (checked by the health check) */
const REQUIRED_SCOPES = ['read_customers', 'read_metaobjects', 'read_themes', 'read_orders', 'write_draft_orders', 'write_store_credit_account_transactions'];
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
];

const BOOKING_COLUMNS = [
  'id', 'ref', 'kind', 'status', 'tables', 'room', 'starts_at', 'ends_at', 'people', 'name', 'email', 'phone', 'notes', 'activity',
  'extras', 'pay', 'paid', 'amount', 'game_id', 'customer_id', 'hold_until', 'draft_order_id', 'order_id', 'created_at', 'updated_at',
];
const GAME_COLUMNS = [
  'id', 'title', 'system', 'gm', 'gm_customer_id', 'gm_email', 'level', 'age', 'tags', 'safety', 'pregens', 'blurb', 'tables',
  'starts_at', 'ends_at', 'seats', 'status', 'credited', 'created_at', 'updated_at',
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
      draftOrderId: r.draft_order_id, orderId: r.order_id,
    };
  }

  rowToGame(r) {
    return {
      id: r.id, title: r.title, system: r.system, gm: r.gm, gmCustomerId: r.gm_customer_id, gmEmail: r.gm_email, level: r.level, age: r.age,
      tags: parse(r.tags, []), safety: parse(r.safety, []), pregens: Boolean(r.pregens), blurb: r.blurb, tables: parse(r.tables, []),
      start: r.starts_at, end: r.ends_at, seats: r.seats, status: r.status, credited: r.credited,
    };
  }

  rowToBlock(r) {
    return { id: r.id, tables: parse(r.tables, []), start: r.starts_at, end: r.ends_at, label: r.label, type: r.type };
  }

  /** Everything that touches the window [from, to) */
  state(from, to) {
    return {
      bookings: this.sql.exec('SELECT * FROM bookings WHERE ends_at > ? AND starts_at < ?', from, to).toArray().map((r) => this.rowToBooking(r)),
      games: this.sql.exec('SELECT * FROM games WHERE ends_at > ? AND starts_at < ?', from, to).toArray().map((r) => this.rowToGame(r)),
      blocks: this.sql.exec('SELECT * FROM blocks WHERE ends_at > ? AND starts_at < ?', from, to).toArray().map((r) => this.rowToBlock(r)),
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
      b.gameId || null, b.customerId || null, b.holdUntil || null, b.draftOrderId || null, b.orderId || null, now, now,
    );
  }

  saveGame(g, now) {
    this.write(
      SAVE_GAME,
      g.id, g.title, g.system, g.gm, g.gmCustomerId || null, g.gmEmail || null, g.level, g.age, JSON.stringify(g.tags || []),
      JSON.stringify(g.safety || []), g.pregens ? 1 : 0, g.blurb, JSON.stringify(g.tables), g.start, g.end, g.seats, g.status,
      g.credited ?? null, now, now,
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

  uniqueRef() {
    for (let i = 0; i < 20; i += 1) {
      const ref = makeRef();
      if (!this.sql.exec('SELECT id FROM bookings WHERE ref = ?', ref).toArray().length) return ref;
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
        const { rooms, events, settingsText, theme } = await this.shopify.loadLairData(this.env.THEME_ID);
        const settings = settingsText ? readSettingsData(settingsText) : {};
        rules = rulesFromSettings(settings, rooms.length ? rooms : FALLBACK_ROOMS, events);
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
        if (request.headers.get('X-Lair-Internal') !== '1' || request.method !== 'POST') return json({ error: 'Not found' }, 404);
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
        const known = (request.method === 'GET' && a === 'floor') || (request.method === 'POST' && ['bookings', 'games', 'blocks'].includes(a));
        this.note(known ? { proxy: { seen: true, prefix, day } } : { proxyMiss: { path: url.pathname, method: request.method, prefix, day } });
      }
      const who = await this.person(request.headers.get('X-Lair-Customer') || '');
      const client = request.headers.get('X-Lair-Client') || '';
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      if (request.method === 'GET' && a === 'floor') return json(await this.floor(url, who));
      if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
      if (a === 'bookings' && !b) return json(await this.createBooking(body, who, client));
      if (a === 'bookings' && c === 'update') return json(await this.updateBooking(b, body, who));
      if (a === 'games' && !b) return json(await this.createGame(body, who, client));
      if (a === 'games' && c === 'update') return json(await this.updateGame(b, body, who));
      if (a === 'games' && c === 'credit') return json(await this.creditGm(b, who));
      if (a === 'blocks' && !b) return json(await this.createBlock(body, who));
      if (a === 'blocks' && c === 'delete') return json(await this.removeBlock(b, who));
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
    const eventHolds = blockingItems({ blocks: [] }, rules)
      .filter((e) => e.tables.length && e.end > from && e.start < to)
      .map((e) => ({ ...e, eventId: e.id.replace(/^ev-/, ''), type: 'event' }));
    return {
      now,
      bookings: st.bookings.filter((bk) => who.staff || ACTIVE.has(bk.status)).map(view),
      blocks: who.staff ? st.blocks : st.blocks.map((bl) => ({ ...bl, label: PUBLIC_HOLD[bl.type] || 'Reserved' })),
      eventHolds,
      games: visibleGames.map((g) => publicGame(g, st)),
      events: [],
      staff: who.staff,
      features: { email: emailReady(this.env), payOnline: rules.payOnline && this.shopify.configured },
    };
  }

  async createBooking(input, who, client = '') {
    const rules = await this.rules();
    // --- no awaits from here until the booking is saved ---
    const now = Date.now();
    const time = new LairTime(rules.tz);
    const st = this.state(now - 24 * HOUR, now + (rules.horizonDays + 2) * 24 * HOUR);
    const kind = input.kind === 'gm-seat' ? 'gm-seat' : input.kind === 'walkin' ? 'walkin' : 'table';
    if (kind === 'walkin') this.requireStaff(who);
    this.checkRate(who, client, now);
    let booking;
    let game = null;
    if (kind === 'gm-seat') {
      const seat = checkSeatBooking(input, { state: st, rules, now });
      game = seat.game;
      booking = {
        kind, gameId: game.id, tables: seat.tables, room: tableIndex(rules.rooms).get(seat.tables[0])?.roomObj.id, start: seat.start,
        end: seat.end, people: seat.people, name: seat.name, email: seat.email, amount: seat.amount, activity: 'rpg',
      };
    } else {
      const checked = checkTableBooking(input, { state: st, rules, time, now, staff: who.staff });
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
      id: makeId('bk'), ref: this.uniqueRef(), pay: payNow ? 'now' : 'day', paid: kind === 'walkin' ? Boolean(input.paid) : false,
      status: kind === 'walkin' ? 'seated' : payNow ? 'held' : 'confirmed', holdUntil: payNow ? now + HOLD_MINUTES * MIN : null,
      customerId: who.customerId || null,
    });
    this.saveBooking(booking, now);
    // --- saved: the table is ours ---

    let notice = wantsPayNow && !payNow ? "Online payment isn't available, so pay at the counter. Your booking is confirmed." : null;
    if (payNow) {
      try {
        const unit = kind === 'gm-seat' ? rules.prices.gmSeat : tableIndex(rules.rooms).get(booking.tables[0]).roomObj.price;
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

  /** Booking confirmation email. Returns whether one was sent (needs RESEND_API_KEY and FROM_EMAIL). */
  confirm(booking, rules, game = null) {
    if (!emailReady(this.env) || !isEmail(booking.email)) return false;
    const what = game
      ? `${booking.people} ${booking.people === 1 ? 'seat' : 'seats'} at ${game.title} (${game.system}, GM ${game.gm})`
      : `${booking.people} ${booking.people === 1 ? 'person' : 'people'} at table${booking.tables.length > 1 ? 's' : ''} ${booking.tables.join(', ')}`;
    const fee = booking.paid ? `${dollars(booking.amount)}, paid. Thank you!` : `${dollars(booking.amount)}, pay at the counter.`;
    const changes = booking.paid
      ? `Need to cancel? Reply to this email or call us at least ${rules.refundHours} hours before your booking and we'll refund you. After that the fee can't be refunded.`
      : 'Plans changed? Reply to this email or give us a call so we can free up the table.';
    this.later(
      this.mail({
        to: booking.email,
        subject: `Booked: ${this.when(booking, rules)} (${booking.ref})`,
        text: `Kia ora ${booking.name},\n\nYou're booked at the Dice Goblin Lair.\n\nWhen: ${this.when(booking, rules)}\nWhat: ${what}\nFee: ${fee}\nBooking: ${booking.ref}\n\nShow ${booking.ref} at the counter when you arrive.\n${changes}\n\nSee you at the Lair!\nDice Goblin`,
      }),
    );
    return true;
  }

  notifyStaff(subject, text) {
    if (!emailReady(this.env) || !this.env.STAFF_EMAIL) return;
    this.later(this.mail({ to: this.env.STAFF_EMAIL, subject, text }));
  }

  /** Send an email and keep the outcome in the status table, so a wrong key or an unverified domain shows up there. */
  async mail(message) {
    const result = await sendEmail(this.env, message);
    if (result.attempted) {
      const day = new Date().toISOString().slice(0, 10);
      this.note({ email: result.ok ? { ok: true, day } : { ok: false, status: result.status, message: result.message, day } });
    }
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
      const refund = refundFor(booking, rules, now);
      booking.status = 'cancelled';
      booking.holdUntil = null;
      this.saveBooking(booking, now);
      this.dropDraft(booking);
      if (refund.due) this.notifyStaff(`Refund due: ${booking.ref}`, `${booking.name} cancelled ${booking.ref} more than ${rules.refundHours} hours ahead. Refund ${dollars(refund.amount)} in Shopify (order ${refund.orderId || 'see Orders'}).`);
      return { booking: this.ownView(booking), refund };
    }
    const st = this.state(now - 24 * HOUR, now + (rules.horizonDays + 2) * 24 * HOUR);
    const next = { ...booking };
    if (patch.status && ['confirmed', 'seated', 'done', 'cancelled', 'noshow'].includes(patch.status)) next.status = patch.status;
    if (next.status !== 'held') next.holdUntil = null;
    if (patch.status === 'done') next.end = Math.max(Math.min(next.end, now), next.start);
    if (typeof patch.paid === 'boolean') next.paid = patch.paid;
    if (patch.people != null) {
      next.people = Math.max(1, Math.min(60, Math.floor(Number(patch.people)) || 1));
      const unit = next.kind === 'gm-seat' ? rules.prices.gmSeat : tableIndex(rules.rooms).get(next.tables[0])?.roomObj.price || rules.prices.table;
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
    // Paid online and cancelled: tell staff whether the policy gives the money back. No-shows keep the fee.
    const ending = ['cancelled', 'noshow'].includes(next.status) && booking.status !== next.status;
    const refund = ending ? (next.status === 'cancelled' ? refundFor(booking, rules, now) : { ...refundFor(booking, rules, Infinity), reason: 'no-show' }) : undefined;
    return { booking: next, refund };
  }

  async createGame(input, who, client = '') {
    if (!who.customerId && !who.staff) throw new RuleError('Log in first so we know who to pay your store credit to.', 401);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    this.checkRate(who, client, now);
    const time = new LairTime(rules.tz);
    const st = this.state(now - 24 * HOUR, now + (rules.horizonDays + 2) * 24 * HOUR);
    const g = checkGame(input, { state: st, rules, time, now, staff: who.staff });
    const game = {
      id: makeId('gm'), ...g, gmCustomerId: who.staff && input.gmCustomerId ? String(input.gmCustomerId) : who.customerId,
      gmEmail: isEmail(input.email) ? String(input.email).trim().slice(0, 120) : null,
      status: who.staff || who.gm ? 'open' : 'pending', credited: null,
    };
    this.saveGame(game, now);
    const room = tableIndex(rules.rooms).get(game.tables[0])?.roomObj.id;
    this.saveBooking({
      id: makeId('bk'), ref: this.uniqueRef(), kind: 'gm', gameId: game.id, tables: game.tables, room, start: game.start, end: game.end,
      people: game.seats + 1, name: `GM ${game.gm}`, status: 'confirmed', pay: 'day', paid: true, amount: 0, activity: 'rpg', customerId: game.gmCustomerId,
    }, now);
    if (game.status === 'pending') {
      this.notifyStaff(`Game to approve: ${game.title}`, `${game.gm} wants to run ${game.title} (${game.system}), ${this.when(game, rules)}, tables ${game.tables.join(', ')}, ${game.seats} seats.\n\nApprove it on the staff page.`);
    }
    return { game: publicGame(game, this.state(game.start - 1, game.end + 1)), emailed: emailReady(this.env) && Boolean(game.gmEmail) };
  }

  async updateGame(id, patch, who) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    const own = who.customerId && game.gmCustomerId === who.customerId;
    if (!who.staff) {
      if (!own || patch.status !== 'cancelled') throw new RuleError('Only staff can change that game.', 403);
      if (game.start <= now) throw new RuleError('This game has already started. Talk to staff at the counter.', 403);
    }
    if (game.status === 'cancelled' && patch.status && patch.status !== 'cancelled') {
      throw new RuleError('Cancelled games stay cancelled. List it again as a new game.', 409);
    }
    const before = game.status;
    if (patch.status && ['open', 'pending', 'cancelled'].includes(patch.status)) game.status = patch.status;
    this.saveGame(game, now);
    let affected = 0;
    if (game.status === 'cancelled' && before !== 'cancelled') {
      const linked = this.gameBookings(id).filter((b) => ACTIVE.has(b.status));
      this.write("UPDATE bookings SET status = 'cancelled', hold_until = NULL, updated_at = ? WHERE game_id = ? AND status IN ('held', 'confirmed', 'seated')", now, id);
      for (const seat of linked.filter((b) => b.kind === 'gm-seat')) {
        affected += 1;
        this.dropDraft(seat);
        if (emailReady(this.env) && isEmail(seat.email)) {
          this.later(this.mail({
            to: seat.email,
            subject: `Cancelled: ${game.title}, ${this.when(game, rules)}`,
            text: `Kia ora ${seat.name},\n\nSorry, ${game.title} on ${this.when(game, rules)} has been cancelled.${seat.paid ? ' You paid online, so we will refund you.' : ''}\nBooking: ${seat.ref}\n\nCheck the games board for another session.\nDice Goblin`,
          }));
        }
      }
    }
    if (before === 'pending' && game.status === 'open' && emailReady(this.env) && game.gmEmail) {
      this.later(this.mail({
        to: game.gmEmail,
        subject: `Your game is live: ${game.title}`,
        text: `Kia ora ${game.gm},\n\n${game.title} on ${this.when(game, rules)} is now on the games board, tables ${game.tables.join(', ')}.\nYou earn ${dollars(rules.prices.gmCredit)} store credit for each paying player after the session.\n\nHappy GMing!\nDice Goblin`,
      }));
    }
    return { game: publicGame(game, this.state(game.start - 1, game.end + 1)), affected };
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
    const amount = players * rules.prices.gmCredit;
    this.write('UPDATE games SET credited = ?, updated_at = ? WHERE id = ?', players, now, id);
    let status = 'none';
    let note = '';
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
    for (const match of String(order.note || '').matchAll(/GOB-[A-Z0-9]{4,8}/g)) refs.add(match[0]);
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
          this.notifyStaff(`Paid but cancelled: ${booking.ref}`, `${booking.name} (${booking.email || 'no email'}) paid for ${booking.ref}, but that booking was cancelled or its spot was re-booked. Refund the order or find them another spot.`);
        }
      }
      booking.holdUntil = null;
      this.saveBooking(booking, now);
      if (firstTime && booking.status === 'confirmed') this.confirm(booking, rules, booking.gameId ? this.game(booking.gameId) : null);
      updated.push(booking.ref);
    }
    return { updated };
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
        const sent = await this.mail({
          to,
          subject: 'Dice Goblin booking emails are working',
          text: `Kia ora,\n\nThis is a test from the Dice Goblin booking app. Booking confirmations go out from ${this.env.FROM_EMAIL}${this.env.REPLY_TO ? `, and replies come back to ${this.env.REPLY_TO}` : ''}.\n\nDice Goblin`,
        });
        result.emailTest = { ok: sent.ok, to, status: sent.status, message: sent.message };
      }
    }
    this.note({ connection: result });
    return result;
  }
}

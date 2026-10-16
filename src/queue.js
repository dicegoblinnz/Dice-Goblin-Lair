/**
 * Round 17: borrowing, the second half of "Help me pick" (contract v17-help-me-pick, section 5). Four things, all about
 * getting a library game into someone's hands:
 *  - the borrow queue (old-school Netflix): a member lines up games, and whenever their plan has room and the next one
 *    has a copy free it's held for them (an ordinary library hold, made by the queue). In the Lair it's held as any hold
 *    is; one that isn't collected stalls the queue, so holds don't stack up while someone's away (Mo, 16 Oct). By post
 *    it's held until the next Wednesday 10pm cutoff at least a day away, and a postal send waits for the postage.
 *  - postal sends: the checkout (a Shopify draft order for the member), the payment (orders/paid, checked against the
 *    send's own draft order), the cutoff, and the staff's list (packed, sent, cancelled).
 *  - "Tell me when it's back": one email when a watched game has a copy free, then the watch goes.
 *  - a library game on a table booking, held from midnight (Lair time) three days before the booking's day until it
 *    ends. Booking holds count for copies, never against a plan, and never show in a member's holds.
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair, and
 * its rule holds: every await first, then one synchronous read-check-write, so two requests can never take the same copy
 * or the same slot. The games come from the other half of round 17, this.pickGame(productId) (no awaits): until it's
 * there, nothing is a library game here.
 */
import { ACTIVE, HOUR, MIN, RuleError, addDays, holdUntil, lairTime, makeId } from './core.js';
import { emailReady } from './shopify.js';
import { wishlistProductId } from './wishlist.js';

/** A member's queue holds up to this many games (queued and held) */
export const QUEUE_MAX = 30;
/** A member watches up to this many games */
export const WATCH_MAX = 50;
/** Postage by area, in cents: the website's shipping rates (config LIBRARY_POSTAGE changes them) */
export const POSTAGE_DEFAULT = { auckland: 1000, 'auckland-rural': 1500, nationwide: 2000, 'nationwide-rural': 3000 };
export const AREAS = Object.keys(POSTAGE_DEFAULT);
export const AREA_WORDS = { auckland: 'Auckland', 'auckland-rural': 'Auckland rural', nationwide: 'Nationwide', 'nationwide-rural': 'Nationwide rural' };
/** The postal cutoff: Wednesday (3) at 10pm, Lair time, for Thursday's post */
export const CUTOFF = { weekday: 3, minutes: 22 * 60 };
/** A booking's game is held from midnight at the start of the day this many days before the booking's day */
export const BOOKING_HOLD_DAYS = 3;
/** A send at the checkout keeps its hold this long past the cutoff, for a payment in flight */
export const CHECKOUT_GRACE = 30 * MIN;
/** A checkout being made: another confirm waits this long before making a fresh one (an answer that never came) */
const CREATING_MS = 2 * MIN;
/** A paid send's hold lasts until this many days after its Thursday, while staff pack and post it */
const PAID_HOLD_DAYS = 28;
/** Maintenance: queues moved on, and watchers told, in one run */
const QUEUES_A_RUN = 200;
const WATCH_EMAILS_A_RUN = 100;
/** Sends that are still going somewhere: the staff's open list, and the holds maintenance leaves to the cutoff */
const OPEN_SENDS = ['waiting', 'checkout', 'paid', 'packed'];
const SEND_STATUSES = ['packed', 'sent', 'cancelled'];

/**
 * Every message a member or staff can see. The first ten are the contract's table (section 8), word for word; the rest
 * are for answers the contract doesn't word.
 */
export const QUEUE_MESSAGES = {
  loginQueue: 'Log in to see your queue.',
  member: 'Join the library to start a queue.',
  full: `Your queue is full (${QUEUE_MAX} games). Take one off to add another.`,
  inStoreOnly: "That one's rare, so it stays in the Lair. Book a table and play it here instead.",
  product: "That isn't one of our library games. Refresh the page and try again.",
  game: 'Pick a game from the library to bring to your table.',
  started: "That booking has started, so its game can't change now.",
  lapsed: "The cutoff for this Thursday has passed, so it's back on the shelf. It's still in your queue.",
  shopify: "We couldn't open the checkout just now. Try again in a minute, or call us.",
  watchFull: `You're watching ${WATCH_MAX} games already. Stop watching one to add another.`,
  // not in the contract's table
  creating: "Hang on: Gobgob's still setting up your checkout. Try again in a moment.",
  delivery: 'Pick how you swap: in the Lair or by post.',
  area: "Pick where it's going: Auckland, Auckland rural, nationwide or nationwide rural.",
  position: 'Pick a place in your queue, like 1 for the top.',
  send: 'That postal swap could not be found.',
  skipped: "You skipped that one, so it's back in your queue.",
  paid: "That one's paid for, so it's on its way. Have a chat with us if plans change.",
  sendStatus: 'A postal swap can be marked packed, sent or cancelled.',
  sendDone: (status) => `That postal swap is ${status} already, so it can't change now.`,
  unpaid: "That one's postage isn't paid yet, so it can't be packed or sent.",
  noBooking: 'Booking not found.',
  notYourBooking: 'Only staff can change that booking.',
  bookingOff: "That booking isn't on any more, so it can't take a game.",
};

/* ---------- small helpers (as lair.js's) ---------- */
const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
/**
 * Where a member's emails go: the email they gave us (a booking or their profile), else their Shopify account's
 * verified email (GET /me keeps it as account_email), else ''. A member who has only ever borrowed has no email of
 * their own, and still hears that a game is held for them, ready to post, or back on the shelf.
 */
const emailOf = (member) => (isEmail(member?.email) ? String(member.email).trim() : isEmail(member?.account_email) ? String(member.account_email).trim() : '');
const money = (cents) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
const firstOf = (member) => member?.first_name || String(member?.name || '').split(/\s+/)[0] || 'friend';
const nameOf = (member) => member?.name || member?.first_name || member?.code || 'a member';

/**
 * When a postal hold made at `now` must be confirmed and paid: the next Wednesday 10pm (Lair time) at least 24 hours
 * away (a Monday: this Wednesday; a Wednesday afternoon or night: next week's). sendDay is the Thursday after it
 * ('YYYY-MM-DD'). Days are counted on the Lair's calendar, so a daylight saving change in between moves nothing.
 */
export function postalCutoff(time, now) {
  const today = time.key(now);
  for (let n = 0; n <= 14; n += 1) {
    const day = addDays(today, n);
    if (time.weekday(day) !== CUTOFF.weekday) continue;
    const at = time.at(day, CUTOFF.minutes);
    if (at - now >= 24 * HOUR) return { confirmBy: at, sendDay: addDays(day, 1) };
  }
  return null;
}

/** When a booking's game is held from: midnight (Lair time) at the start of the day 3 days before the booking's day */
export function bookingHoldFrom(time, start) {
  return time.at(addDays(time.key(start), -BOOKING_HOLD_DAYS), 0);
}

/**
 * The postage by area, in cents: config LIBRARY_POSTAGE (JSON, like {"auckland":1000}) where it gives a whole number
 * of cents from 0 to $1,000 for an area, else the website's rate (POSTAGE_DEFAULT).
 */
export function libraryPostage(env) {
  const given = parse(String(env?.LIBRARY_POSTAGE || ''), {});
  const out = { ...POSTAGE_DEFAULT };
  for (const area of AREAS) {
    const cents = Number(given?.[area]);
    if (Number.isInteger(cents) && cents >= 0 && cents <= 100000) out[area] = cents;
  }
  return out;
}

/** An area as sent: one of AREAS (any case, spaces or underscores for dashes), '' or null for none, else undefined */
const areaOf = (value) => {
  if (value === null || value === '') return null;
  const key = String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  return AREAS.includes(key) ? key : undefined;
};

export const queueMethods = {
  /* ---------------- who, which game, how many copies ---------------- */
  /** The logged-in member a /me route is for (401 with `message` for a guest). No awaits. */
  queueOwner(who, message = QUEUE_MESSAGES.loginQueue) {
    if (!who?.customerId) throw new RuleError(message, 401);
    return String(who.customerId);
  },

  /** The productId sent, as its digits (a number, digits or the product's gid), or 422 product. No awaits. */
  queueProductId(input) {
    const id = wishlistProductId(input?.productId);
    if (!id) throw new RuleError(QUEUE_MESSAGES.product);
    return id;
  },

  /**
   * An active library game from the catalogue, by product id: the other half of round 17's pickGame (no awaits), or
   * null when it isn't one (or pickGame isn't there yet). { productId, variantId, title, handle, image, shelfCode, copies,
   * inStoreOnly, kind, table, status }.
   */
  libraryPick(productId) {
    const game = typeof this.pickGame === 'function' && productId ? this.pickGame(String(productId)) : null;
    return game && game.variantId && (game.status ?? 'active') === 'active' ? game : null;
  },

  /**
   * How many copies of a game there are: the catalogue's number when it has one, else what Shopify last said
   * (shopifyCopies' cache), else the copies a page last sent with a hold, else 1. No awaits.
   */
  queueCopies(game) {
    const n = Number(game?.copies);
    if (Number.isInteger(n) && n >= 1) return Math.min(n, 99);
    const variantId = String(game?.variantId || '');
    const cached = this.copiesCache?.get(variantId);
    if (cached && cached.copies != null) return cached.copies;
    return this.pageCopies(variantId) ?? 1;
  },

  /** Copies of a game on the shelf now: its copies less active holds (booking holds too) and games at home. No awaits. */
  queueFree(game, now = Date.now()) {
    return game?.variantId ? this.copiesFree(String(game.variantId), this.queueCopies(game), now).free : 0;
  },

  /** The Simplee tags planOf may need: the caller's own (a request), else the last ones the Lair saw for them */
  queueTags(customerId, who = null) {
    if (who?.customerId && String(who.customerId) === String(customerId)) return who.tags || [];
    return this.people?.get(String(customerId))?.person?.tags || [];
  },

  /* ---------------- the queue's rows and settings ---------------- */
  /** A member's queue: their queued and held rows, by position. No awaits. */
  queueRows(customerId) {
    return this.sql
      .exec("SELECT * FROM library_queue WHERE customer_id = ? AND status IN ('queued', 'held') ORDER BY position, added_at, rowid", String(customerId))
      .toArray();
  },

  /** A member's queued or held row for a product, or null. No awaits. */
  queueRowFor(customerId, productId) {
    return this.sql
      .exec("SELECT * FROM library_queue WHERE customer_id = ? AND product_id = ? AND status IN ('queued', 'held')", String(customerId), String(productId))
      .toArray()[0] || null;
  },

  /** Positions 1, 2, 3… again, in their order, after a row leaves or moves. No awaits. */
  queueRenumber(customerId, now, rows = this.queueRows(customerId)) {
    rows.forEach((r, i) => {
      if (r.position !== i + 1) this.write('UPDATE library_queue SET position = ?, updated_at = ? WHERE id = ?', i + 1, now, r.id);
    });
  },

  /** A member's queue settings (the defaults when they have none): { paused, delivery, area, stalled, stalledReason, stalledAt } */
  queueSettings(customerId) {
    const r = this.sql.exec('SELECT * FROM library_queue_settings WHERE customer_id = ?', String(customerId)).toArray()[0];
    return {
      paused: Boolean(r?.paused), delivery: r?.delivery === 'post' ? 'post' : 'store', area: AREAS.includes(r?.area) ? r.area : null,
      stalled: Boolean(r?.stalled), stalledReason: r?.stalled ? r.stalled_reason || null : null, stalledAt: r?.stalled ? r.stalled_at || null : null,
    };
  },

  /** Save some of a member's queue settings (the rest stay). No awaits. */
  saveQueueSettings(customerId, patch, now) {
    const s = { ...this.queueSettings(customerId), ...patch };
    this.write(
      `INSERT INTO library_queue_settings (customer_id, paused, delivery, area, stalled, stalled_reason, stalled_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(customer_id) DO UPDATE SET paused = excluded.paused, delivery = excluded.delivery, area = excluded.area, stalled = excluded.stalled,
         stalled_reason = excluded.stalled_reason, stalled_at = excluded.stalled_at, updated_at = excluded.updated_at`,
      String(customerId), s.paused ? 1 : 0, s.delivery, s.area, s.stalled ? 1 : 0, s.stalled ? s.stalledReason || null : null,
      s.stalled ? s.stalledAt || now : null, now,
    );
  },

  /** The queue stalls (reason 'missed', 'lapsed' or 'skipped'): nothing more is held until they act. No awaits. */
  queueStall(customerId, reason, now) {
    this.saveQueueSettings(customerId, { stalled: true, stalledReason: reason, stalledAt: now }, now);
  },

  /**
   * They acted (any change to their queue, a restart, unpausing, changing how they swap, a reserve or a borrow): the
   * stall clears, and games whose hold they (or staff) cancelled are no longer passed over. No awaits.
   */
  queueActed(customerId, now) {
    const id = String(customerId);
    if (this.queueSettings(id).stalled) this.saveQueueSettings(id, { stalled: false, stalledReason: null, stalledAt: null }, now);
    if (this.sql.exec("SELECT 1 AS n FROM library_queue WHERE customer_id = ? AND status = 'queued' AND passed_at IS NOT NULL LIMIT 1", id).toArray().length) {
      this.write("UPDATE library_queue SET passed_at = NULL, updated_at = ? WHERE customer_id = ? AND status = 'queued' AND passed_at IS NOT NULL", now, id);
    }
  },

  /* ---------------- views ---------------- */
  /** A queue row as its member sees it: GET /me/queue's item. No awaits. */
  queueItem(r, now) {
    const g = this.libraryPick(r.product_id);
    const variantId = g?.variantId || r.variant_id || null;
    const hold = r.status === 'held' && r.hold_id ? this.holdRow(r.hold_id) : null;
    return {
      productId: r.product_id, variantId, title: g?.title || r.title || '', handle: g?.handle || r.handle || '', image: g?.image || r.image || null,
      shelfCode: g?.shelfCode || r.shelf_code || '', position: r.position, status: r.status, holdId: r.status === 'held' ? r.hold_id || null : null,
      hold: hold && hold.status === 'held' ? { until: hold.until } : null,
      available: this.queueFree({ ...g, variantId }, now) > 0,
    };
  },

  /** A postal send as its member sees it (the checkout link only while it's at the checkout). No awaits. */
  sendView(s) {
    return {
      id: s.id, productId: s.product_id || null, title: s.title || '', shelfCode: s.shelf_code || '', area: s.area || null, postage: s.postage ?? null,
      status: s.status, confirmBy: s.confirm_by, sendDay: s.send_day || null, holdId: s.hold_id || null,
      checkoutUrl: s.status === 'checkout' ? s.checkout_url || null : null, orderName: s.order_name || null, createdAt: s.created_at,
    };
  },

  /** A postal send as staff see it: the member's view (no checkout link) with who it's for and its order. No awaits. */
  staffSendView(s, memo = null) {
    let m = memo?.get(s.customer_id);
    if (m === undefined) {
      m = this.memberRow(s.customer_id);
      memo?.set(s.customer_id, m);
    }
    const { checkoutUrl, ...view } = this.sendView(s);
    return {
      ...view, customerId: s.customer_id, name: m?.name || m?.first_name || '', email: m?.email || '', code: m?.code || null,
      orderId: s.order_id || null, draftOrderId: s.draft_order_id || null, queueId: s.queue_id || null, late: Boolean(s.late), note: s.staff_note || '',
      paidAt: s.paid_at || null, updatedAt: s.updated_at || null,
    };
  },

  /**
   * GET /me/queue's answer: { queue, settings, sends (the ones still going: waiting, checkout, paid, packed), watching,
   * plan: { name, games, holds, atHome } | null, postage }. No awaits.
   */
  queueView(customerId, who = null, now = Date.now()) {
    const id = String(customerId);
    const s = this.queueSettings(id);
    const plan = this.planOf(id, this.queueTags(id, who), now);
    return {
      queue: this.queueRows(id).map((r) => this.queueItem(r, now)),
      settings: { paused: s.paused, delivery: s.delivery, area: s.area, stalled: s.stalled, stalledReason: s.stalledReason },
      sends: this.sql
        .exec(`SELECT * FROM library_sends WHERE customer_id = ? AND status IN (${OPEN_SENDS.map(() => '?').join(', ')}) ORDER BY confirm_by, created_at`, id, ...OPEN_SENDS)
        .toArray().map((x) => this.sendView(x)),
      watching: this.sql.exec('SELECT * FROM library_watch WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC', id).toArray()
        .map((w) => ({ productId: w.product_id, variantId: w.variant_id || null, title: w.title || '', handle: w.handle || '', since: w.created_at })),
      // atHome: the games at home that use up the plan (not those staff lent outside it, 16 Oct 2026)
      plan: plan ? { name: plan.name, games: plan.games, holds: this.activeHolds(id, now).length, atHome: this.planLoans(id).length } : null,
      postage: libraryPostage(this.env),
    };
  },

  /* ---------------- the member's routes ---------------- */
  /** GET /me/queue (logged in). No awaits. */
  memberQueue(who) {
    return this.queueView(this.queueOwner(who), who);
  },

  /**
   * POST /me/queue { productId } (a library member): a game goes on the end of their queue. One already on it keeps its
   * place (added: false). 403 member (no plan), 422 product, 422 inStoreOnly, 409 full. Adding is acting: the stall
   * clears, and the queue moves on. No awaits.
   */
  addToQueue(input, who) {
    const id = this.queueOwner(who);
    const now = Date.now();
    if (!this.planOf(id, who.tags, now)) throw new RuleError(QUEUE_MESSAGES.member, 403);
    const productId = this.queueProductId(input);
    const game = this.libraryPick(productId);
    if (!game) throw new RuleError(QUEUE_MESSAGES.product);
    if (game.inStoreOnly) throw new RuleError(QUEUE_MESSAGES.inStoreOnly);
    if (this.queueRowFor(id, productId)) return { ok: true, added: false, ...this.queueView(id, who, now) };
    const rows = this.queueRows(id);
    if (rows.length >= QUEUE_MAX) throw new RuleError(QUEUE_MESSAGES.full, 409);
    this.write(
      `INSERT INTO library_queue (id, customer_id, product_id, variant_id, title, handle, image, shelf_code, position, status, hold_id, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?)`,
      makeId('lq'), id, productId, String(game.variantId), String(game.title || '').slice(0, 120), game.handle || null, this.shopImage(game.image),
      game.shelfCode ? String(game.shelfCode).toUpperCase().slice(0, 20) : null, rows.length + 1, now, now,
    );
    this.queueActed(id, now);
    this.queueAdvance(id, { now, who });
    return { ok: true, added: true, ...this.queueView(id, who, now) };
  },

  /** POST /me/queue/remove { productId }: it leaves the queue (a held one keeps its hold). removed: false when it wasn't on it. */
  removeFromQueue(input, who) {
    const id = this.queueOwner(who);
    const productId = this.queueProductId(input);
    const now = Date.now();
    const row = this.queueRowFor(id, productId);
    if (row) {
      this.write("UPDATE library_queue SET status = 'removed', updated_at = ? WHERE id = ?", now, row.id);
      this.queueRenumber(id, now);
      this.queueActed(id, now);
      this.queueAdvance(id, { now, who });
    }
    return { ok: true, removed: Boolean(row), ...this.queueView(id, who, now) };
  },

  /** POST /me/queue/move { productId, to }: to its new place (1-based; past the end is the end). 422 for a bad place or a game not in it. */
  moveInQueue(input, who) {
    const id = this.queueOwner(who);
    const productId = this.queueProductId(input);
    const sent = input?.to;
    const to = typeof sent === 'number' || (typeof sent === 'string' && /^\s*\d{1,4}\s*$/.test(sent)) ? Number(sent) : NaN;
    if (!Number.isInteger(to) || to < 1) throw new RuleError(QUEUE_MESSAGES.position);
    const now = Date.now();
    const rows = this.queueRows(id);
    const at = rows.findIndex((r) => r.product_id === productId);
    if (at < 0) throw new RuleError(QUEUE_MESSAGES.product);
    const [row] = rows.splice(at, 1);
    rows.splice(Math.min(to, rows.length + 1) - 1, 0, row);
    this.queueRenumber(id, now, rows);
    this.queueActed(id, now);
    this.queueAdvance(id, { now, who });
    return { ok: true, ...this.queueView(id, who, now) };
  },

  /**
   * POST /me/queue/settings { paused?, delivery?, area? }: only what's sent changes. Unpausing, or changing how they
   * swap, clears the stall; then the queue moves on. 422 for a delivery or area that isn't one. No awaits.
   */
  saveQueueSettingsRoute(input, who) {
    const id = this.queueOwner(who);
    const now = Date.now();
    const before = this.queueSettings(id);
    const patch = {};
    const has = (key) => input && typeof input === 'object' && Object.hasOwn(input, key);
    if (has('paused')) patch.paused = input.paused === true;
    if (has('delivery')) {
      if (!['store', 'post'].includes(input.delivery)) throw new RuleError(QUEUE_MESSAGES.delivery);
      patch.delivery = input.delivery;
    }
    if (has('area')) {
      const area = areaOf(input.area);
      if (area === undefined) throw new RuleError(QUEUE_MESSAGES.area);
      patch.area = area;
    }
    this.saveQueueSettings(id, patch, now);
    if ((before.paused && patch.paused === false) || (patch.delivery && patch.delivery !== before.delivery)) this.queueActed(id, now);
    this.queueAdvance(id, { now, who });
    return { ok: true, ...this.queueView(id, who, now) };
  },

  /** POST /me/queue/restart: "Start my queue again": the stall clears and it moves on. No awaits. */
  restartQueue(who) {
    const id = this.queueOwner(who);
    const now = Date.now();
    this.queueActed(id, now);
    this.queueAdvance(id, { now, who });
    return { ok: true, ...this.queueView(id, who, now) };
  },
  /* ---------------- moving the queue on ---------------- */
  /**
   * queueAdvance(customerId): unless their queue is paused or stalled, or their plan is missing or paused for a
   * payment, while their plan has room (its games less their holds and games at home; booking holds never count), the
   * first queued game by position that has a copy free now and that they don't already hold or have at home is held
   * for them (createdBy 'queue'), and its row is held. Games with no free copy, games that aren't in the library any
   * more and games whose hold they cancelled (until they next act) are passed over and keep their place. By post, the
   * hold lasts until the cutoff and a postal send waits for the postage. Every read and write here is synchronous, so a
   * free copy or a free slot can only ever be taken once. Returns the holds made.
   */
  queueAdvance(customerId, { now = Date.now(), who = null, rules = this.rulesCache } = {}) {
    const id = String(customerId);
    const settings = this.queueSettings(id);
    if (settings.paused || settings.stalled) return [];
    const plan = this.planOf(id, this.queueTags(id, who), now);
    if (!plan || plan.blocked) return [];
    // a hold of theirs ran out and maintenance hasn't caught it yet: wait for it (it may stall the queue)
    if (this.sql.exec("SELECT 1 AS n FROM library_holds WHERE customer_id = ? AND status = 'held' AND until <= ? AND kind != 'booking' LIMIT 1", id, now).toArray().length) return [];
    const time = lairTime(rules?.tz);
    const made = [];
    for (let guard = 0; guard < QUEUE_MAX; guard += 1) {
      // the plan's room: holds and games at home, less those staff lent outside the plan (16 Oct 2026)
      const home = this.loansOut(id);
      if (this.activeHolds(id, now).length + home.filter((l) => !l.lent).length >= plan.games) break;
      // what they have already: any hold of theirs (a table's too) and anything at home
      const mine = new Set([
        ...this.sql.exec("SELECT variant_id FROM library_holds WHERE customer_id = ? AND status = 'held' AND until > ?", id, now).toArray().map((r) => String(r.variant_id)),
        ...home.map((l) => String(l.variantId)),
      ]);
      let next = null;
      for (const row of this.sql.exec("SELECT * FROM library_queue WHERE customer_id = ? AND status = 'queued' AND passed_at IS NULL ORDER BY position, added_at, rowid", id).toArray()) {
        const game = this.libraryPick(row.product_id);
        if (!game || game.inStoreOnly || mine.has(String(game.variantId)) || this.queueFree(game, now) < 1) continue;
        next = { row, game };
        break;
      }
      if (!next) break;
      made.push(this.queueHold(id, next.row, next.game, settings, { now, time, rules }));
    }
    return made;
  },

  /**
   * Hold a queued game for its member (no awaits): the hold (createdBy 'queue'), the row held, and by post a send that
   * waits for the postage. The game becomes one the Lair knows (a scan of its label finds it). The staff and member
   * emails go out afterwards. Returns the hold.
   */
  queueHold(customerId, row, game, settings, { now, time, rules }) {
    const post = settings.delivery === 'post' ? postalCutoff(time, now) : null;
    const until = post ? post.confirmBy : holdUntil(time, now);
    const holdId = makeId('lh');
    const title = String(game.title || row.title || 'A library game').slice(0, 120);
    const shelfCode = String(game.shelfCode || row.shelf_code || '').toUpperCase().slice(0, 20);
    const handle = game.handle || row.handle || null;
    const image = this.shopImage(game.image) || row.image || null;
    this.write(
      `INSERT INTO library_holds (id, variant_id, product_id, title, shelf_code, handle, copies, customer_id, status, until, staff_note, created_by, created_at, updated_at,
         ended_at, image, kind, booking_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'held', ?, NULL, 'queue', ?, ?, NULL, ?, 'member', NULL)`,
      holdId, String(game.variantId), row.product_id, title, shelfCode || null, handle, customerId, until, now, now, image,
    );
    this.write("UPDATE library_queue SET status = 'held', hold_id = ?, variant_id = ?, updated_at = ? WHERE id = ?", holdId, String(game.variantId), now, row.id);
    this.saveLibraryGame({ variantId: game.variantId, productId: row.product_id, title, handle, shelfCode, image }, now);
    let send = null;
    if (post) {
      const sendId = makeId('ls');
      const postage = settings.area ? libraryPostage(this.env)[settings.area] : null;
      this.write(
        `INSERT INTO library_sends (id, customer_id, hold_id, queue_id, product_id, title, shelf_code, area, postage, status, confirm_by, send_day, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?)`,
        sendId, customerId, holdId, row.id, row.product_id, title, shelfCode || null, settings.area, postage, post.confirmBy, post.sendDay, now, now,
      );
      send = this.sendRow(sendId);
    }
    const hold = this.holdRow(holdId);
    this.tellQueueHold(hold, send, this.memberRow(customerId), rules);
    return hold;
  },

  /* ---------------- holds ending, and coming back ---------------- */
  /**
   * A hold ended (how: 'cancelled', 'released' or 'expired'), from cancelHold, updateHold or maintenance: a booking's
   * game is let go; a hold the queue made puts its game back in the queue at its place. Expired in the Lair, the queue
   * stalls ('missed'); a postal one lapses (its send too: 'lapsed'); cancelled or released, it doesn't stall, and that
   * game is passed over until they next act. Then their queue moves on and watchers hear if a copy is free. Returns true
   * when the member was emailed about it here (expireLibraryHolds then sends nothing of its own). No awaits.
   */
  queueHoldEnded(hold, how, now = Date.now()) {
    if (!hold) return false;
    if (hold.kind === 'booking') {
      // staff let a table's game go early (the holds list): it stays let go
      if (hold.bookingId && how !== 'expired') this.write("UPDATE bookings SET game_state = 'released', updated_at = ? WHERE id = ? AND game_hold_id = ? AND game_state = 'held'", now, hold.bookingId, hold.id);
      this.queueGameFree(hold.productId, now, { variantId: hold.variantId });
      return true;
    }
    const send = this.sql.exec('SELECT * FROM library_sends WHERE hold_id = ? ORDER BY created_at DESC LIMIT 1', hold.id).toArray()[0] || null;
    if (send && ['waiting', 'checkout'].includes(send.status)) {
      if (how === 'expired') return this.lapseSend(send, now);
      this.write("UPDATE library_sends SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('waiting', 'checkout')", now, send.id);
      if (send.draft_order_id) this.dropSendDraft(send.draft_order_id);
    } else if (send && ['paid', 'packed'].includes(send.status)) {
      // paid for: staff sort it out on the postal swaps list (the member isn't told the hold ended)
      return true;
    }
    const row = this.sql.exec("SELECT * FROM library_queue WHERE hold_id = ? AND status = 'held'", hold.id).toArray()[0] || null;
    // an uncollected hold the queue made stalls it, even when they took the game off their queue meanwhile
    if (how === 'expired' && (row || hold.createdBy === 'queue')) {
      if (row) this.write("UPDATE library_queue SET status = 'queued', updated_at = ? WHERE id = ?", now, row.id);
      this.queueStall(hold.customerId, 'missed', now);
      this.tellQueuePaused(hold, 'missed');
      this.queueGameFree(hold.productId, now, { variantId: hold.variantId });
      return true;
    }
    if (row) this.write("UPDATE library_queue SET status = 'queued', passed_at = ?, updated_at = ? WHERE id = ?", now, now, row.id);
    this.queueAdvance(hold.customerId, { now });
    this.queueGameFree(hold.productId, now, { variantId: hold.variantId });
    return false;
  },

  /**
   * A game went home with a member (a hold collected, a scan, the counter, a postal swap sent): it's done in their
   * queue, whichever way they got it. No awaits.
   */
  queueLoanMade(loan, now = Date.now()) {
    if (!loan?.customerId) return;
    this.write(
      "UPDATE library_queue SET status = 'done', updated_at = ? WHERE customer_id = ? AND status IN ('held', 'queued') AND (hold_id = ? OR variant_id = ?)",
      now, String(loan.customerId), loan.holdId || '', String(loan.variantId || ''),
    );
  },

  /**
   * Staff held a hold again: a queue row it came from is held again; a table's game is held until its booking ends
   * again (not the 3 days a member's hold gets). No awaits.
   */
  queueHoldAgain(hold, now = Date.now()) {
    if (!hold) return;
    if (hold.kind === 'booking') {
      const b = hold.bookingId ? this.booking(hold.bookingId) : null;
      if (b && b.end > now) {
        this.write('UPDATE library_holds SET until = ?, updated_at = ? WHERE id = ?', b.end, now, hold.id);
        this.write("UPDATE bookings SET game_state = 'held', game_hold_id = ?, updated_at = ? WHERE id = ? AND game_product_id = ?", hold.id, now, b.id, hold.productId);
      }
      return;
    }
    this.write("UPDATE library_queue SET status = 'held', passed_at = NULL, updated_at = ? WHERE hold_id = ? AND status = 'queued'", now, hold.id);
  },

  /** A game of theirs was checked back in: their queue moves on, and watchers hear it's back. No awaits. */
  queueLoanBack(loan, now = Date.now()) {
    if (!loan) return;
    this.queueAdvance(loan.customerId, { now });
    this.queueGameFree(loan.productId, now, { variantId: loan.variantId });
  },

  /** A member reserved or borrowed: that's acting, so a stalled queue starts again (and moves on). No awaits. */
  queueMemberActed(customerId, who = null, now = Date.now()) {
    if (!customerId || !this.sql.exec('SELECT 1 AS n FROM library_queue WHERE customer_id = ? LIMIT 1', String(customerId)).toArray().length) return;
    this.queueActed(customerId, now);
    this.queueAdvance(customerId, { now, who });
  },

  /**
   * A library membership webhook was handled (lair.js): a plan that may have changed moves its member's queue on. The
   * answer names the membership (created, updated) or the charge it was about. No awaits.
   */
  queueAfterPlanChange(result, now = Date.now()) {
    try {
      this.queueAfterPlanChangeNow(result, now);
    } catch (error) {
      // never fails the webhook: maintenance moves the queue on within 10 minutes anyway
      console.error('Lair: could not move a borrow queue on after a plan change', error);
    }
  },

  queueAfterPlanChangeNow(result, now) {
    const ids = new Set();
    for (const m of [result?.created, result?.updated]) {
      const row = m ? this.sql.exec('SELECT customer_id FROM memberships WHERE id = ?', String(m)).toArray()[0] : null;
      if (row) ids.add(String(row.customer_id));
    }
    if (result?.charge) {
      const row = this.sql.exec('SELECT m.customer_id FROM membership_charges c JOIN memberships m ON m.id = c.membership_id WHERE c.id = ?', String(result.charge)).toArray()[0];
      if (row) ids.add(String(row.customer_id));
    }
    for (const id of ids) this.queueAdvance(id, { now });
  },
  /* ---------------- postal sends ---------------- */
  sendRow(id) {
    return id ? this.sql.exec('SELECT * FROM library_sends WHERE id = ?', String(id)).toArray()[0] || null : null;
  },

  /** A member's own send, or 404 (someone else's is never found). No awaits. */
  ownSend(id, customerId) {
    const send = this.sendRow(id);
    if (!send || String(send.customer_id) !== String(customerId)) throw new RuleError(QUEUE_MESSAGES.send, 404);
    return send;
  },

  /** Stop a send's checkout link working (unless it was just paid: Shopify keeps a completed one). Afterwards, never throws. */
  dropSendDraft(draftOrderId) {
    if (draftOrderId && this.shopify.configured) this.later(this.shopify.deleteDraftIfOpen(draftOrderId));
  },

  /**
   * The cutoff passed with the postage unpaid: the send lapses, its checkout stops working, the hold ends (the game's
   * back on the shelf), the game goes back in the queue at its place, and the queue stalls ('lapsed'), with the member
   * told. Once only: a send that has moved on is left alone. Returns whether it lapsed. No awaits.
   */
  lapseSend(send, now = Date.now()) {
    const fresh = send ? this.sendRow(send.id) : null;
    if (!fresh || !['waiting', 'checkout'].includes(fresh.status)) return false;
    this.write("UPDATE library_sends SET status = 'lapsed', creating_at = NULL, updated_at = ? WHERE id = ? AND status IN ('waiting', 'checkout')", now, fresh.id);
    this.dropSendDraft(fresh.draft_order_id);
    const hold = this.holdRow(fresh.hold_id);
    if (hold?.status === 'held') this.write("UPDATE library_holds SET status = 'expired', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'held'", Math.min(now, hold.until), now, hold.id);
    this.write("UPDATE library_queue SET status = 'queued', updated_at = ? WHERE (id = ? OR hold_id = ?) AND status = 'held'", now, fresh.queue_id || '', fresh.hold_id || '');
    this.queueStall(fresh.customer_id, 'lapsed', now);
    this.tellQueuePaused({ ...(hold || {}), title: fresh.title, customerId: fresh.customer_id }, 'lapsed');
    this.queueGameFree(fresh.product_id, now);
    return true;
  },

  /**
   * Maintenance step 3: sends past their cutoff lapse: waiting ones at the cutoff, ones at the checkout 30 minutes
   * later (a payment in flight). Returns how many lapsed. No awaits.
   */
  lapseSends(now = Date.now()) {
    const due = this.sql
      .exec("SELECT * FROM library_sends WHERE (status = 'waiting' AND confirm_by <= ?) OR (status = 'checkout' AND confirm_by <= ?) ORDER BY confirm_by", now, now - CHECKOUT_GRACE)
      .toArray();
    let lapsed = 0;
    for (const send of due) if (this.lapseSend(send, now)) lapsed += 1;
    return lapsed;
  },

  /**
   * POST /me/queue/sends/:id/confirm { area } (theirs): the checkout for the postage, a Shopify draft order made for them
   * (src/shopify.js createLibrarySend), so their store credit and saved cards work and checkout takes their address.
   * The send is claimed before Shopify is asked, so two taps make one checkout; confirming again while it's open reuses
   * it (a new area makes a new one, and the old link stops working). → { send, checkoutUrl }. 422 area, 404 send, 409
   * lapsed after the cutoff (or skipped, or paid), 503 shopify when the checkout can't be made.
   */
  async confirmSend(id, input, who) {
    const owner = this.queueOwner(who);
    await this.rules();
    let now = Date.now();
    let send = this.ownSend(id, owner);
    this.checkSendOpen(send, now);
    const area = input?.area === undefined ? send.area || this.queueSettings(owner).area : areaOf(input.area);
    if (!area) throw new RuleError(QUEUE_MESSAGES.area);
    const postage = libraryPostage(this.env)[area];
    if (send.status === 'checkout' && send.checkout_url && send.area === area && send.postage === postage) {
      return { send: this.sendView(send), checkoutUrl: send.checkout_url };
    }
    if (send.creating_at && now - send.creating_at < CREATING_MS) throw new RuleError(QUEUE_MESSAGES.creating, 409);
    if (!this.shopify.configured) throw new RuleError(QUEUE_MESSAGES.shopify, 503);
    // --- claimed: this tap makes the checkout, and no other until it's back (or CREATING_MS has passed) ---
    const claim = now;
    this.write("UPDATE library_sends SET creating_at = ?, updated_at = ? WHERE id = ? AND status IN ('waiting', 'checkout')", claim, now, send.id);
    this.saveQueueSettings(owner, { area }, now);
    const member = this.memberRow(owner);
    let draft;
    try {
      draft = await this.shopify.createLibrarySend({
        sendId: send.id, customerId: owner, email: isEmail(member?.account_email) ? member.account_email : isEmail(member?.email) ? member.email : '',
        title: send.title || 'A library game', shelfCode: send.shelf_code || '', areaWords: AREA_WORDS[area], postage, currency: this.env.CURRENCY || 'NZD',
      });
    } catch (error) {
      console.error('Lair: postal swap checkout could not be made', error);
      this.note({ librarySendError: { message: String(error.message || error).slice(0, 300), send: send.id, at: new Date().toISOString() } });
      this.write('UPDATE library_sends SET creating_at = NULL WHERE id = ? AND creating_at = ?', send.id, claim);
      throw new RuleError(QUEUE_MESSAGES.shopify, 503);
    }
    // --- no awaits from here on: only this send's own row, while it's still waiting for its postage ---
    now = Date.now();
    send = this.sendRow(send.id);
    if (!send || !['waiting', 'checkout'].includes(send.status) || send.creating_at !== claim || now >= send.confirm_by) {
      this.dropSendDraft(draft.draftOrderId);
      if (send?.creating_at === claim) this.write('UPDATE library_sends SET creating_at = NULL WHERE id = ?', send.id);
      this.checkSendOpen(send, now);
      throw new RuleError(QUEUE_MESSAGES.creating, 409);
    }
    const drafts = [...new Set([...parse(send.drafts, []), draft.draftOrderId])];
    this.write(
      "UPDATE library_sends SET status = 'checkout', area = ?, postage = ?, draft_order_id = ?, checkout_url = ?, drafts = ?, creating_at = NULL, updated_at = ? WHERE id = ?",
      area, postage, draft.draftOrderId, draft.checkoutUrl || null, JSON.stringify(drafts), now, send.id,
    );
    // the copy stays theirs through the 30 minutes' grace after the cutoff, for a payment in flight
    this.write("UPDATE library_holds SET until = ?, updated_at = ? WHERE id = ? AND status = 'held' AND until < ?", send.confirm_by + CHECKOUT_GRACE, now, send.hold_id, send.confirm_by + CHECKOUT_GRACE);
    if (send.draft_order_id && send.draft_order_id !== draft.draftOrderId) this.dropSendDraft(send.draft_order_id);
    return { send: this.sendView(this.sendRow(send.id)), checkoutUrl: draft.checkoutUrl || null };
  },

  /**
   * A send that can't take a checkout any more: 409 with why (paid or on its way, skipped, or past the cutoff). One past
   * its cutoff is lapsed now, unless it's at the checkout inside its 30 minutes' grace (a payment may be in flight).
   */
  checkSendOpen(send, now) {
    if (!send) throw new RuleError(QUEUE_MESSAGES.send, 404);
    if (['paid', 'packed', 'sent'].includes(send.status)) throw new RuleError(QUEUE_MESSAGES.paid, 409);
    if (send.status === 'cancelled') throw new RuleError(QUEUE_MESSAGES.skipped, 409);
    if (send.status === 'lapsed') throw new RuleError(QUEUE_MESSAGES.lapsed, 409);
    if (now >= send.confirm_by) {
      if (send.status === 'waiting' || now >= send.confirm_by + CHECKOUT_GRACE) this.lapseSend(send, now);
      throw new RuleError(QUEUE_MESSAGES.lapsed, 409);
    }
  },

  /**
   * POST /me/queue/sends/:id/skip (theirs): "Not this time": the hold ends now (back on the shelf), the game goes back
   * in their queue at its place, the send is cancelled (its checkout stops working) and the queue stalls ('skipped').
   * One already skipped is fine. 409 paid or lapsed. → { ok, ...GET /me/queue }. No awaits.
   */
  skipSend(id, who) {
    const owner = this.queueOwner(who);
    const now = Date.now();
    const send = this.ownSend(id, owner);
    if (['paid', 'packed', 'sent'].includes(send.status)) throw new RuleError(QUEUE_MESSAGES.paid, 409);
    if (send.status === 'lapsed') throw new RuleError(QUEUE_MESSAGES.lapsed, 409);
    if (send.status !== 'cancelled') {
      this.write("UPDATE library_sends SET status = 'cancelled', creating_at = NULL, updated_at = ? WHERE id = ? AND status IN ('waiting', 'checkout')", now, send.id);
      this.dropSendDraft(send.draft_order_id);
      this.write("UPDATE library_holds SET status = 'cancelled', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'held'", now, now, send.hold_id || '');
      this.write("UPDATE library_queue SET status = 'queued', updated_at = ? WHERE (id = ? OR hold_id = ?) AND status = 'held'", now, send.queue_id || '', send.hold_id || '');
      this.queueStall(owner, 'skipped', now);
      this.queueGameFree(send.product_id, now);
    }
    return { ok: true, ...this.queueView(owner, who, now) };
  },

  /**
   * orders/paid (the webhook): a paid postal swap. The send's id is on the order (_libsend, on the order or a line), and
   * one of the send's own draft orders must have become this order (Shopify is asked; its latest draft, gone from
   * Shopify, counts when the order came from a draft order, as bills do; one still open never does), so nothing else can
   * mark a send paid. Paid: its order and name are
   * kept, the copy stays held until staff post it, and STAFF_EMAIL hears "Post this Thursday". Paid after it lapsed or
   * was skipped: it's paid all the same, and staff are asked to send it next Thursday or refund. Paid twice: staff hear
   * to refund one. Throws when Shopify can't answer, so the webhook comes again. Returns the sends marked paid.
   */
  async librarySendsPaid(order, orderId) {
    const source = order?.source_name || '';
    if (source && source !== 'shopify_draft_order') return [];
    const ids = new Set();
    for (const a of order?.note_attributes || []) if (a.name === '_libsend' && a.value) ids.add(String(a.value).trim());
    for (const item of order?.line_items || []) for (const p of item.properties || []) if (p.name === '_libsend' && p.value) ids.add(String(p.value).trim());
    const verified = [];
    for (const id of [...ids].slice(0, 5)) {
      const send = this.sendRow(id);
      if (!send?.draft_order_id) continue;
      if (send.order_id === orderId) {
        verified.push(id);
        continue;
      }
      for (const draftId of [send.draft_order_id, ...parse(send.drafts, []).filter((d) => d !== send.draft_order_id)]) {
        // If Shopify can't answer, this throws: the webhook gets a 500 and Shopify sends it again later.
        const linked = await this.shopify.draftOrderOrderId(draftId);
        if (linked === orderId) {
          verified.push(id);
          break;
        }
        // Shopify names no order for the send's latest draft: it only counts when the order came from a draft order and
        // that draft is gone (as bills, but stricter: a draft that's still open never became this order)
        if (linked === null && source === 'shopify_draft_order' && draftId === send.draft_order_id && !(await this.shopify.draftOrderState(draftId))) {
          verified.push(id);
          break;
        }
      }
    }
    // --- no awaits from here on ---
    const now = Date.now();
    const time = lairTime(this.rulesCache?.tz);
    const marked = [];
    for (const id of verified) {
      const s = this.sendRow(id);
      if (!s || s.order_id === orderId) continue;
      const m = this.memberRow(s.customer_id);
      const game = `${s.title}${s.shelf_code ? ` (${s.shelf_code})` : ''}`;
      if (['paid', 'packed', 'sent'].includes(s.status)) {
        this.notifyStaff(`Paid twice: postage for ${s.title}`, {
          title: 'A postal swap was paid twice',
          intro: `${nameOf(m)} paid the postage for ${game} twice. Refund one of the orders.`,
          details: [['Game', game], ['Member', nameOf(m)], ['Member code', m?.code || ''], ['First order', s.order_name || s.order_id || ''], ['This order', order?.name || orderId]],
        });
        continue;
      }
      // paid after the cutoff and its 30 minutes' grace: it lapsed, whether or not maintenance has got to it yet
      if (['waiting', 'checkout'].includes(s.status) && now >= s.confirm_by + CHECKOUT_GRACE) this.lapseSend(s, now);
      const late = ['lapsed', 'cancelled'].includes(this.sendRow(id).status);
      const sendDay = late ? postalCutoff(time, now)?.sendDay || s.send_day : s.send_day;
      this.write(
        "UPDATE library_sends SET status = 'paid', order_id = ?, order_name = ?, paid_at = ?, late = ?, send_day = ?, creating_at = NULL, updated_at = ? WHERE id = ?",
        orderId, order?.name ? String(order.name).slice(0, 40) : null, now, late ? 1 : 0, sendDay, now, id,
      );
      marked.push(id);
      if (late) {
        this.notifyStaff(`Postage paid after the cutoff: ${s.title} for ${nameOf(m)}`, {
          title: 'Posted after the cutoff',
          intro: `${nameOf(m)} paid the postage for ${game} after the cutoff, so it's back on the shelf. Posted after the cutoff: send it next Thursday or refund.`,
          details: [['Game', game], ['Member', nameOf(m)], ['Member code', m?.code || ''], ['Email', m?.email || ''], ['Order', order?.name || orderId]],
        });
        continue;
      }
      // the copy stays theirs while staff pack and post it
      this.write("UPDATE library_holds SET until = MAX(until, ?), updated_at = ? WHERE id = ? AND status = 'held'", time.at(addDays(s.send_day, PAID_HOLD_DAYS), 0), now, s.hold_id || '');
      this.notifyStaff(`Post this Thursday: ${s.title} for ${nameOf(m)}`, {
        title: 'A library game to post',
        intro: `Post this Thursday: ${game} for ${nameOf(m)}. The postage is paid. Pack it, then mark it sent on the Library tab's postal swaps.`,
        details: [['Game', game], ['For', nameOf(m)], ['Member code', m?.code || ''], ['Email', m?.email || ''], ['Area', AREA_WORDS[s.area] || ''], ['Order', order?.name || orderId]],
      });
    }
    return marked;
  },

  /** GET /library/sends?status=open|all (perm library): open (waiting, checkout, paid, packed) by send day, then name; all, the last 200. */
  listSends(url, who) {
    this.requireStaff(who, 'library');
    const all = url.searchParams.get('status') === 'all';
    const rows = all
      ? this.sql.exec('SELECT * FROM library_sends ORDER BY created_at DESC, rowid DESC LIMIT 200').toArray()
      : this.sql.exec(`SELECT * FROM library_sends WHERE status IN (${OPEN_SENDS.map(() => '?').join(', ')})`, ...OPEN_SENDS).toArray();
    const memo = new Map();
    const sends = rows.map((r) => this.staffSendView(r, memo));
    if (!all) sends.sort((a, b) => String(a.sendDay || '').localeCompare(String(b.sendDay || '')) || a.name.localeCompare(b.name) || a.createdAt - b.createdAt);
    return { sends };
  },

  /**
   * POST /library/sends/:id/update { status: 'packed' | 'sent' | 'cancelled', note? } (perm library). Packed and sent
   * need the postage paid (409 otherwise). Sent collects the hold: the game is at home with them (a loan) and its queue
   * row is done. Cancelled ends the hold (back on the shelf), stops the checkout and puts the game back in their queue
   * (a paid one is staff's to refund). A send that's sent, cancelled or lapsed can't change (409). → { send, loan }.
   */
  updateSend(id, input, who) {
    this.requireStaff(who, 'library');
    const now = Date.now();
    const send = this.sendRow(id);
    if (!send) throw new RuleError(QUEUE_MESSAGES.send, 404);
    const status = input?.status;
    if (status != null && !SEND_STATUSES.includes(status)) throw new RuleError(QUEUE_MESSAGES.sendStatus);
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    let loan = null;
    if (status && status !== send.status) {
      if (['sent', 'cancelled', 'lapsed'].includes(send.status)) throw new RuleError(QUEUE_MESSAGES.sendDone(send.status), 409);
      if (status !== 'cancelled' && !['paid', 'packed'].includes(send.status)) throw new RuleError(QUEUE_MESSAGES.unpaid, 409);
      this.write('UPDATE library_sends SET status = ?, creating_at = NULL, updated_at = ? WHERE id = ?', status, now, send.id);
      const hold = this.holdRow(send.hold_id);
      if (status === 'sent' && hold) {
        loan = this.collectHold(hold, now, by);
        this.write("UPDATE library_queue SET status = 'done', updated_at = ? WHERE id = ? AND status IN ('held', 'queued')", now, send.queue_id || '');
      } else if (status === 'cancelled') {
        this.dropSendDraft(send.draft_order_id);
        if (hold?.status === 'held') this.write("UPDATE library_holds SET status = 'released', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'held'", now, now, hold.id);
        this.write("UPDATE library_queue SET status = 'queued', passed_at = ?, updated_at = ? WHERE (id = ? OR hold_id = ?) AND status = 'held'", now, now, send.queue_id || '', send.hold_id || '');
        this.queueAdvance(send.customer_id, { now });
        this.queueGameFree(send.product_id, now);
      }
    }
    if (input?.note != null) this.write('UPDATE library_sends SET staff_note = ?, updated_at = ? WHERE id = ?', String(input.note).trim().slice(0, 300) || null, now, send.id);
    return { send: this.staffSendView(this.sendRow(send.id)), loan: loan ? this.staffLoanView(loan, now) : null };
  },
  /* ---------------- tell me when it's back ---------------- */
  /** POST /library/watch { productId } (logged in): watch a library game. 401 login, 422 product, 409 watchFull (50). No awaits. */
  watchGame(input, who) {
    const id = this.queueOwner(who);
    const productId = this.queueProductId(input);
    const game = this.libraryPick(productId);
    if (!game) throw new RuleError(QUEUE_MESSAGES.product);
    const now = Date.now();
    if (!this.sql.exec('SELECT 1 AS n FROM library_watch WHERE customer_id = ? AND product_id = ?', id, productId).toArray().length) {
      const count = this.sql.exec('SELECT COUNT(*) AS n FROM library_watch WHERE customer_id = ?', id).one().n;
      if (count >= WATCH_MAX) throw new RuleError(QUEUE_MESSAGES.watchFull, 409);
      this.write(
        'INSERT INTO library_watch (customer_id, product_id, variant_id, title, handle, created_at, told_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
        id, productId, String(game.variantId), String(game.title || '').slice(0, 120), game.handle || null, now,
      );
    }
    return { ok: true, watching: true };
  },

  /** POST /library/watch/remove { productId } (logged in): stop watching (one never watched is fine). No awaits. */
  unwatchGame(input, who) {
    const id = this.queueOwner(who);
    const productId = this.queueProductId(input);
    this.write('DELETE FROM library_watch WHERE customer_id = ? AND product_id = ?', id, productId);
    return { ok: true, watching: false };
  },

  /**
   * A game may have a copy free (a check-in, a hold ending, a send cancelled, or maintenance looking): queues waiting on
   * it move on first (the members who queued it first, first), then, if a copy is still free, its watchers hear. No awaits.
   */
  queueGameFree(productId, now = Date.now(), { variantId = null } = {}) {
    const pid = productId || (variantId ? this.libraryGame(variantId)?.product_id : null);
    if (!pid) return 0;
    const waiting = this.sql
      .exec("SELECT customer_id, MIN(added_at) AS at FROM library_queue WHERE product_id = ? AND status = 'queued' AND passed_at IS NULL GROUP BY customer_id ORDER BY at LIMIT 20", String(pid))
      .toArray();
    for (const w of waiting) this.queueAdvance(w.customer_id, { now });
    return this.tellWatchers(pid, { now });
  },

  /**
   * Watchers of a game with a copy free now each get one email ("<title> is back on the shelf"), oldest watch first, up
   * to `limit` emails, and their watch is deleted in the same pass, so nobody is told twice. A watcher who has it at
   * home or on hold isn't told: they have it, so their watch just goes. Returns the emails sent. No awaits.
   */
  tellWatchers(productId, { now = Date.now(), limit = WATCH_EMAILS_A_RUN } = {}) {
    // with emails off nobody could be told, so the watches wait
    if (!productId || limit < 1 || !emailReady(this.env)) return 0;
    const watchers = this.sql.exec('SELECT * FROM library_watch WHERE product_id = ? ORDER BY created_at, rowid', String(productId)).toArray();
    if (!watchers.length) return 0;
    const game = this.libraryPick(productId);
    if (!game || this.queueFree(game, now) < 1) return 0;
    const variantId = String(game.variantId);
    const letters = [];
    for (const w of watchers) {
      if (letters.length >= limit) break;
      this.write('DELETE FROM library_watch WHERE customer_id = ? AND product_id = ?', w.customer_id, w.product_id);
      const has = this.sql.exec("SELECT 1 AS n FROM library_holds WHERE customer_id = ? AND variant_id = ? AND status = 'held' AND until > ? LIMIT 1", w.customer_id, variantId, now).toArray().length
        || this.loansOut(w.customer_id).some((l) => String(l.variantId) === variantId);
      if (has) continue;
      const to = emailOf(this.memberRow(w.customer_id));
      if (!to) continue;
      const title = game.title || w.title || 'A library game';
      const handle = game.handle || w.handle;
      letters.push(this.letter(to, `${title} is back on the shelf`, {
        title: "It's back!",
        intro: [`Good news, friend: ${title} is back. Reserve it before someone else does.`],
        button: { label: 'Reserve it', url: handle ? this.link(`/products/${handle}`) : `${this.page('myLair')}?view=library` },
      }));
    }
    if (letters.length) this.later(this.mailMany(letters));
    return letters.length;
  },

  /* ---------------- a library game on a table booking ---------------- */
  /**
   * The game a booking asks for ({ productId }): an active library game of kind 'game' in the catalogue, or 422 game.
   * No awaits.
   */
  bookingGamePick(value) {
    const productId = value && typeof value === 'object' ? wishlistProductId(value.productId) : null;
    const game = productId ? this.libraryPick(productId) : null;
    if (!game || (game.kind ?? 'game') !== 'game') throw new RuleError(QUEUE_MESSAGES.game);
    return { ...game, productId };
  },

  /**
   * A booking's game as the booker and staff see it: { productId, title, handle, image, state, holdFrom, holdId, double }
   * (double: a big box that needs a double table), or null. No awaits.
   */
  bookingGameView(b) {
    const g = b?.game;
    if (!g?.productId) return null;
    const pick = this.libraryPick(g.productId);
    return {
      productId: g.productId, title: g.title || pick?.title || '', handle: g.handle || pick?.handle || '', image: g.image || null, state: g.state || 'waiting',
      holdFrom: bookingHoldFrom(lairTime(this.rulesCache?.tz), b.start), holdId: g.holdId || null, double: pick?.table === 'double',
    };
  },

  /** Staff's view of a booking hold's booking: { id, code, start, name }, or null. No awaits. */
  holdBooking(h) {
    const b = h?.bookingId ? this.booking(h.bookingId) : null;
    return b ? { id: b.id, code: b.ref, start: b.start, name: b.name || '' } : null;
  },

  /**
   * Staff marked a table's game collected (handed to the table): it's played, and stays held until the booking ends (a
   * table's game is never a loan). No awaits.
   */
  bookingHoldPlayed(hold, now = Date.now()) {
    if (hold?.bookingId) this.write("UPDATE bookings SET game_state = 'played', updated_at = ? WHERE id = ? AND game_hold_id = ? AND game_state = 'held'", now, hold.bookingId, hold.id);
  },

  /** End a booking's hold now (status 'released'), if it's still on. Returns whether it was. No awaits. */
  releaseBookingHold(holdId, now, endedAt = now) {
    const hold = holdId ? this.holdRow(holdId) : null;
    if (!hold || hold.status !== 'held') return false;
    this.write("UPDATE library_holds SET status = 'released', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'held'", endedAt, now, hold.id);
    return true;
  },

  /**
   * Put a game on a booking (or take it off: game null). A game it had is let go (its hold released); a new one starts
   * 'waiting' and is held at once when the window has opened. No awaits.
   */
  setBookingGame(bookingId, game, now = Date.now()) {
    const b = this.booking(bookingId);
    if (!b) return null;
    // the same game again keeps its place (one that was let go starts over)
    if (b.game?.productId && game && b.game.productId === game.productId && b.game.state !== 'released') return b;
    const freed = b.game?.holdId ? this.releaseBookingHold(b.game.holdId, now) : false;
    this.write(
      'UPDATE bookings SET game_product_id = ?, game_title = ?, game_handle = ?, game_image = ?, game_state = ?, game_hold_id = NULL, game_told_at = NULL, updated_at = ? WHERE id = ?',
      game ? game.productId : null, game ? String(game.title || '').slice(0, 120) : null, game?.handle || null, game ? this.shopImage(game.image) : null,
      game ? 'waiting' : null, now, b.id,
    );
    if (game) this.bookingGameSync(b.id, now);
    if (freed) this.queueGameFree(b.game.productId, now);
    return this.booking(b.id);
  },

  /**
   * Keep a booking's game true to the booking now (after it's made, changed, checked in, cancelled or moved, and every
   * maintenance run): cancelled or a no-show, its hold goes ('released'); over, its hold goes quietly; checked in, it's
   * 'played' (and back to 'held' if the check-in is undone); before its window (moved later), its hold goes and it waits
   * again; inside it, the hold lasts until the booking ends, and a game still waiting (or that had no copy) is held when
   * a copy is free. No awaits. Returns what it did: 'held', 'unavailable', 'released' or null.
   */
  bookingGameSync(bookingId, now = Date.now()) {
    const b = typeof bookingId === 'object' ? bookingId : this.booking(bookingId);
    if (!b?.game?.productId) return null;
    const state = b.game.state || 'waiting';
    const set = (next) => this.write('UPDATE bookings SET game_state = ?, updated_at = ? WHERE id = ?', next, now, b.id);
    const hold = b.game.holdId ? this.holdRow(b.game.holdId) : null;
    const live = hold?.status === 'held';
    if (['cancelled', 'noshow'].includes(b.status)) {
      if (live) this.releaseBookingHold(hold.id, now);
      if (state !== 'released') set('released');
      if (live) this.queueGameFree(b.game.productId, now);
      return live ? 'released' : null;
    }
    if (b.end <= now || b.status === 'done') {
      if (live) {
        this.releaseBookingHold(hold.id, now, Math.min(now, b.end));
        this.queueGameFree(b.game.productId, now);
      }
      return null;
    }
    if (now < bookingHoldFrom(lairTime(this.rulesCache?.tz), b.start)) {
      if (live) this.releaseBookingHold(hold.id, now);
      if (state !== 'waiting' || hold) this.write("UPDATE bookings SET game_state = 'waiting', game_hold_id = NULL, updated_at = ? WHERE id = ?", now, b.id);
      if (live) this.queueGameFree(b.game.productId, now);
      return null;
    }
    if (live && hold.until !== b.end) this.write('UPDATE library_holds SET until = ?, updated_at = ? WHERE id = ?', b.end, now, hold.id);
    if (live && b.status === 'seated' && state === 'held') set('played');
    if (live && b.status !== 'seated' && state === 'played') set('held');
    if (['waiting', 'unavailable'].includes(state) || (state === 'held' && !live && hold?.status !== 'released')) return this.bookingHoldTry(b, now);
    return null;
  },

  /**
   * Staff changed a booking with a game (`before` is how it was): a cancelled or no-show booking put back on wants its
   * game again (it waits, then is held as usual); then its game is kept true to it (bookingGameSync). No awaits.
   */
  bookingGameChanged(before, now = Date.now()) {
    const b = this.booking(before.id);
    if (!b?.game) return null;
    if (['cancelled', 'noshow'].includes(before.status) && ACTIVE.has(b.status) && b.game.state === 'released') {
      this.write("UPDATE bookings SET game_state = 'waiting', game_hold_id = NULL, game_told_at = NULL, updated_at = ? WHERE id = ?", now, b.id);
    }
    return this.bookingGameSync(b.id, now);
  },

  /**
   * The window is open: hold a copy for the table until the booking ends (a hold of kind 'booking', for the booking's
   * account or ''), or, with none free, mark it 'unavailable' and email the booker once. Read and written with no awaits,
   * so a free copy is only ever taken once. Returns 'held' or 'unavailable'.
   */
  bookingHoldTry(b, now) {
    const game = this.libraryPick(b.game.productId);
    if (!game || this.queueFree(game, now) < 1) {
      if (b.game.state !== 'unavailable') this.write("UPDATE bookings SET game_state = 'unavailable', updated_at = ? WHERE id = ?", now, b.id);
      if (!b.game.toldAt) {
        this.write('UPDATE bookings SET game_told_at = ? WHERE id = ? AND game_told_at IS NULL', now, b.id);
        this.tellBookingGameUnavailable(b);
      }
      return 'unavailable';
    }
    const holdId = makeId('lh');
    const title = String(game.title || b.game.title || 'A library game').slice(0, 120);
    const shelfCode = String(game.shelfCode || '').toUpperCase().slice(0, 20);
    const image = this.shopImage(game.image) || b.game.image || null;
    this.write(
      `INSERT INTO library_holds (id, variant_id, product_id, title, shelf_code, handle, copies, customer_id, status, until, staff_note, created_by, created_at, updated_at,
         ended_at, image, kind, booking_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'held', ?, NULL, 'booking', ?, ?, NULL, ?, 'booking', ?)`,
      holdId, String(game.variantId), b.game.productId, title, shelfCode || null, game.handle || b.game.handle || null, b.customerId || '', b.end, now, now, image, b.id,
    );
    this.write("UPDATE bookings SET game_state = ?, game_hold_id = ?, updated_at = ? WHERE id = ?", b.status === 'seated' ? 'played' : 'held', holdId, now, b.id);
    this.saveLibraryGame({ variantId: game.variantId, productId: b.game.productId, title, handle: game.handle || b.game.handle, shelfCode, image }, now);
    return 'held';
  },

  /**
   * Product ids of the library games attached to bookings that aren't cancelled (or no-shows) whose hold window
   * (midnight 3 days before the booking's day until it ends) overlaps [startMs, endMs): waiting, held, played or
   * unavailable (still wanted that day); one staff let go isn't. exceptBookingId leaves one booking out (the booking
   * door's own). For the quiz's availability (the other half of round 17). No awaits.
   */
  bookedGamesOverlapping(startMs, endMs, { exceptBookingId = null } = {}) {
    const out = new Set();
    const from = Number(startMs);
    const to = Number(endMs);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return out;
    const time = lairTime(this.rulesCache?.tz);
    const rows = this.sql
      .exec(
        `SELECT id, starts_at, ends_at, game_product_id FROM bookings WHERE game_product_id IS NOT NULL AND COALESCE(game_state, 'waiting') != 'released'
         AND status NOT IN ('cancelled', 'noshow') AND ends_at > ? AND starts_at < ?`,
        from, to + (BOOKING_HOLD_DAYS + 2) * 24 * HOUR,
      )
      .toArray();
    for (const r of rows) {
      if (exceptBookingId && r.id === exceptBookingId) continue;
      if (bookingHoldFrom(time, r.starts_at) < to && r.ends_at > from) out.add(String(r.game_product_id));
    }
    return out;
  },

  /**
   * POST /bookings/:id/game { productId | null } (the booking's owner, or staff with tables): attach, change or take off
   * a table booking's game until it starts. A guest booking has no owner to do this, so it gets a game only when it's
   * made (or from staff). 404, 403, 422 game, 409 started. → { ok, booking, game }. No awaits after the rules.
   */
  async bookingGame(id, input, who) {
    await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const booking = this.booking(String(id || ''));
    if (!booking) throw new RuleError(QUEUE_MESSAGES.noBooking, 404);
    const own = Boolean(who.customerId && booking.customerId === String(who.customerId));
    const staff = this.can(who, 'tables');
    if (!own && !staff) throw new RuleError(who.staff ? 'That\'s not one of your staff permissions. Ask the main account to tick it on the Team tab.' : QUEUE_MESSAGES.notYourBooking, 403);
    if (booking.kind !== 'table') throw new RuleError(QUEUE_MESSAGES.game);
    if (booking.start <= now) throw new RuleError(QUEUE_MESSAGES.started, 409);
    if (!ACTIVE.has(booking.status)) throw new RuleError(QUEUE_MESSAGES.bookingOff, 409);
    if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'productId')) throw new RuleError(QUEUE_MESSAGES.game);
    const game = input.productId === null ? null : this.bookingGamePick({ productId: input.productId });
    const fresh = this.setBookingGame(booking.id, game, now);
    const view = own ? this.ownView(fresh) : this.staffBooking(fresh);
    return { ok: true, booking: view, game: this.bookingGameView(fresh) };
  },

  /**
   * Maintenance step 2: booking holds kept true. Holds whose booking is cancelled, over or gone are let go; games whose
   * window has opened are held (or marked unavailable, the booker emailed once). Returns { held, unavailable, released }.
   * No awaits.
   */
  bookingHoldUpkeep(now = Date.now()) {
    const out = { held: 0, unavailable: 0, released: 0 };
    // every table's hold still on: let go when its booking is gone, holds another game, is over, cancelled or moved later
    for (const h of this.sql.exec("SELECT * FROM library_holds WHERE kind = 'booking' AND status = 'held'").toArray().map((r) => this.rowToHold(r))) {
      const b = h.bookingId ? this.booking(h.bookingId) : null;
      if (!b || b.game?.holdId !== h.id) {
        if (this.releaseBookingHold(h.id, now)) out.released += 1;
        continue;
      }
      this.bookingGameSync(b, now);
      if (this.holdRow(h.id)?.status !== 'held') out.released += 1;
    }
    // games whose window has opened and that aren't held yet (or had no copy free): held now if a copy is free
    const time = lairTime(this.rulesCache?.tz);
    const rows = this.sql
      .exec(
        `SELECT * FROM bookings WHERE game_product_id IS NOT NULL AND game_state IN ('waiting', 'unavailable', 'held', 'played')
         AND status NOT IN ('cancelled', 'noshow') AND ends_at > ? AND starts_at < ? ORDER BY starts_at, created_at`,
        now, now + (BOOKING_HOLD_DAYS + 2) * 24 * HOUR,
      )
      .toArray();
    for (const r of rows) {
      const b = this.rowToBooking(r);
      if (bookingHoldFrom(time, b.start) > now) continue;
      if (b.game.holdId && this.holdRow(b.game.holdId)?.status === 'held') continue;
      const did = this.bookingGameSync(b, now);
      if (did === 'held') out.held += 1;
      else if (did === 'unavailable' && b.game.state !== 'unavailable') out.unavailable += 1;
    }
    return out;
  },

  /* ---------------- maintenance: queues and watches ---------------- */
  /** Maintenance step 4: queues move on for members with a queued game, at most 200 a run (taking turns). Returns { members, held }. No awaits. */
  queueUpkeep(now = Date.now()) {
    const after = this.queueCursor || '';
    let ids = this.sql
      .exec("SELECT DISTINCT customer_id FROM library_queue WHERE status = 'queued' AND customer_id > ? ORDER BY customer_id LIMIT ?", after, QUEUES_A_RUN)
      .toArray().map((r) => r.customer_id);
    if (ids.length < QUEUES_A_RUN && after) {
      const more = this.sql.exec("SELECT DISTINCT customer_id FROM library_queue WHERE status = 'queued' AND customer_id <= ? ORDER BY customer_id LIMIT ?", after, QUEUES_A_RUN - ids.length).toArray();
      ids = [...ids, ...more.map((r) => r.customer_id)];
    }
    let held = 0;
    for (const id of ids) held += this.queueAdvance(id, { now }).length;
    this.queueCursor = ids.length >= QUEUES_A_RUN ? ids[ids.length - 1] : '';
    return { members: ids.length, held };
  },

  /** Maintenance step 5: watchers of games with a copy free are told, at most 100 emails a run. Returns how many. No awaits. */
  watchUpkeep(now = Date.now()) {
    let told = 0;
    const products = this.sql.exec('SELECT product_id, MIN(created_at) AS at FROM library_watch GROUP BY product_id ORDER BY at').toArray();
    for (const p of products) {
      if (told >= WATCH_EMAILS_A_RUN) break;
      told += this.tellWatchers(p.product_id, { now, limit: WATCH_EMAILS_A_RUN - told });
    }
    return told;
  },
  /* ---------------- emails ---------------- */
  /** "10pm on Wednesday 21 October": a postal cutoff, in Lair time */
  cutoffWords(ms, rules = this.rulesCache) {
    const tz = rules?.tz || 'Pacific/Auckland';
    const day = new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(ms)).replace(',', '');
    return `${this.clockWord(ms, tz)} on ${day}`;
  },

  /** "Saturday 24 October": a booking's day, in Lair time */
  bookingDayWords(ms, rules = this.rulesCache) {
    return new Intl.DateTimeFormat('en-NZ', { timeZone: rules?.tz || 'Pacific/Auckland', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(ms)).replace(',', '');
  },

  /**
   * A game the queue held: the staff hear it (as any hold, with queue words) and so does the member, in the Lair
   * ("<title> is next in your queue and on hold for you") or by post ("Your next game is ready to post: <title>", with
   * the postage and the cutoff). No awaits (the emails go afterwards).
   */
  tellQueueHold(hold, send, member, rules = this.rulesCache) {
    if (!emailReady(this.env) || !hold) return;
    const game = `${hold.title}${hold.shelfCode ? ` (${hold.shelfCode})` : ''}`;
    const name = nameOf(member);
    const library = `${this.page('myLair')}?view=library`;
    const postage = send ? (send.postage != null ? money(send.postage) : `from ${money(Math.min(...Object.values(libraryPostage(this.env))))}`) : null;
    const to = emailOf(member);
    if (send) {
      const by = this.cutoffWords(send.confirm_by, rules);
      this.notifyStaff(`Hold this game for the post: ${game} for ${name}`, {
        title: 'A library game to hold for the post',
        intro: `Hold this game: ${game} for ${name}. It came up next in their queue, to go by post. They have until ${by} to pay the postage; if they don't, it goes back on the shelf by itself.`,
        details: [['Game', hold.title], ['Shelf', hold.shelfCode], ['For', name], ['Member code', member?.code || ''], ['Email', to], ['Postage paid by', by]],
      });
      if (!to) return;
      this.later(this.mail(this.letter(to, `Your next game is ready to post: ${hold.title}`, {
        title: 'Your next game is ready to post',
        intro: [`Kia ora ${firstOf(member)}!`, `${hold.title} came up next in your queue. Confirm and pay the postage (${postage}) by ${by} and it goes out on Thursday. Not this time? Skip it and it stays in your queue.`],
        details: [['Game', hold.title], ['Postage', postage], ['Pay by', by]],
        button: { label: 'Send it', url: library },
      })));
      return;
    }
    const when = this.holdWhen(hold.until, rules);
    this.notifyStaff(`Hold this game: ${game} for ${name}, until ${when}`, {
      title: 'A library game to hold',
      intro: `Hold this game: ${game} for ${name}, until ${when}. It came up next in their queue. Pop it behind the counter; if they don't collect it by then, it goes back on the shelf by itself.`,
      details: [['Game', hold.title], ['Shelf', hold.shelfCode], ['For', name], ['Member code', member?.code || ''], ['Email', to], ['Until', when]],
    });
    if (!to) return;
    this.later(this.mail(this.letter(to, `${hold.title} is next in your queue and on hold for you`, {
      title: "It's on hold for you!",
      intro: [`Kia ora ${firstOf(member)}! ${hold.title} came up next in your queue, so it's on hold for you until ${when}. Collect it at the counter with your member code.`],
      details: [['Game', hold.title], ['Shelf', hold.shelfCode], ['Held until', when], ['Your member code', member.code || '']],
      button: { label: 'See your queue', url: library },
    })));
  },

  /** Their queue stalled on a game they didn't collect ('missed') or didn't confirm by the cutoff ('lapsed'). No awaits. */
  tellQueuePaused(hold, why) {
    const member = this.memberRow(hold?.customerId);
    const to = emailOf(member);
    if (!emailReady(this.env) || !to) return;
    const what = why === 'lapsed' ? "wasn't confirmed by the cutoff" : "wasn't collected";
    this.later(this.mail(this.letter(to, 'Your queue is paused', {
      title: 'Your queue is paused',
      intro: [`Kia ora ${firstOf(member)}!`, `${hold.title} ${what}, so it's back on the shelf and your queue is paused. Start it again in My Lair whenever you're ready.`],
      button: { label: 'Start my queue again', url: `${this.page('myLair')}?view=library` },
    })));
  },

  /** A table's game had no copy free when its window opened: the booker hears once, to pick another. No awaits. */
  tellBookingGameUnavailable(b) {
    const member = b.customerId ? this.memberRow(b.customerId) : null;
    const to = isEmail(b.email) ? b.email : emailOf(member);
    if (!emailReady(this.env) || !isEmail(to)) return;
    const day = this.bookingDayWords(b.start);
    const title = b.game.title || 'that game';
    this.later(this.mail(this.letter(to, `Pick another game for ${day}`, {
      title: 'Pick another game',
      intro: [`Kia ora ${firstOf(member || { name: b.name })}!`, `Every copy of ${title} is out right now, so we can't hold it for your table on ${day}. Pick another game in My Lair, or grab something off the shelves on the night.`],
      details: [['Booking', b.ref], ['When', this.when(b, this.rulesCache || { tz: 'Pacific/Auckland' })]],
      button: { label: 'Pick another game', url: this.page('myLair') },
    })));
  },
  // (end of queueMethods)
};

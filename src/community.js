// Round 9, community (9 Oct 2026): turnouts, saved lists of members and early access offers for regulars.
// Mo: "the more you show up the more you get added into our list of say Pokemon turnouts … they will be the ones where we
// will give the option to buy our products before it goes to the rest of the shop … have the allocation be present from 3
// avenues the last 3 months turnouts, the last year turnouts and total spend at dice goblin."
//
// These are methods of the Lair Durable Object (src/lair.js mixes them in with Object.assign(Lair.prototype, …)), kept in
// their own file so the feature stays in one place. The Durable Object rule holds throughout: every await first (the rules,
// Shopify), then one synchronous read-check-write. A claim's checkout is made after its row is saved (the units are
// reserved first), and afterwards only that row's own columns change.
//
// - A turnout is a member checked in: at an event (a sign-up checked in, each member guest on it for themselves, an event
//   game spot checked in) or at a TTRPG session (a seat checked in). Table bookings, no-shows and cancellations never count,
//   and nothing is stored: undoing a check-in takes the turnout back. Turnouts group by game: the event's Game field, else
//   its kind; a session's system, else "TTRPG". Names as staff wrote them, merged without case.
// - Lists: staff save a selection of members ("Pokémon regulars, Oct").
// - Early access offers: a Shopify product (some of its variants) for a list and/or picked members, with a per-person
//   limit, optional total units, an opening and closing time and a short message. Each member sees it in My Lair and
//   claims it: a Shopify draft order made for their own account (its checkout link only ever goes to them). Unpaid claims
//   are let go after 48 hours or when the offer closes, whichever is first.
import { HOUR, MIN, RuleError, findOccurrence, lairTime, makeId } from './core.js';
import { emailReady } from './shopify.js';

/** An unpaid claim is let go this long after it's made (or when its offer closes, if that's sooner) */
export const CLAIM_HOURS = 48;
/** A claim whose checkout is still being made holds its units this long at most (the Worker was stopped mid-way) */
const CREATING_MS = 5 * MIN;
/** Limits: people on a list, the per-person limit, total units, a message, a note */
export const LIST_MAX = 2000;
export const PER_PERSON_MAX = 50;
const UNITS_MAX = 10000;
/** At most this many members in GET /community (sorted, so the top of the list is always there) */
const COMMUNITY_MAX = 1000;
/** What an event with no Game counts under: its kind (the lair_event definition's choices) */
export const KIND_GAMES = {
  tcg: 'TCGs', rpg: 'TTRPG', wargame: 'Wargames', market: 'Markets', social: 'Social games', tournament: 'Tournaments', learn: 'Learn to play',
  launch: 'Launches', other: 'Other events',
};
const SORTS = ['3m', '12m', 'all', 'spend'];
/** The words staff see when a product is already for sale online */
export const ON_SALE_ONLINE = 'Anyone can buy this online right now. Hide it from the online store in Shopify until early access ends.';
const READ_PRODUCTS = "Shopify hasn't let the Lair read products yet. Approve the app's read_products permission in Shopify admin (Apps › Dice Goblin Lair), then try again.";
const SHOPIFY_QUIET = "Shopify didn't answer just now. Try again in a minute.";
const NOT_FOUND = 'That offer could not be found.';
export const OFFER_MESSAGES = {
  product: 'Pick a product from the search.',
  variants: 'Pick at least one of its options to offer.',
  perPerson: `The limit per person is a number from 1 to ${PER_PERSON_MAX}.`,
  units: 'Total units is a number from 1 up, or leave it empty for no limit.',
  closes: 'Pick when early access closes.',
  date: 'Pick a real date and time, like 2026-10-18 18:00.',
  order: 'It has to close after it opens.',
  past: 'That closing time has already passed. Pick a later one.',
  message: 'Keep the message to 300 characters or fewer.',
  people: "Gobgob doesn't know some of those people. Pick them from the Community list again.",
  nobody: 'Add a list or some people before opening it.',
  closed: 'That offer has closed. Make a new one.',
  product404: "Shopify doesn't have that product any more. Search for it again.",
  productChange: "The product can't change once early access is open. Close it and make a new one.",
};
export const LIST_MESSAGES = {
  name: 'Give the list a name.',
  long: 'Keep the name to 60 characters or fewer.',
  note: 'Keep the note to 300 characters or fewer.',
  big: `A list holds up to ${LIST_MAX} people.`,
  missing: 'That list could not be found.',
  taken: (name) => `There's already a list called ${name}. Pick another name.`,
};

const trimmed = (v, max) => String(v ?? '').trim().slice(0, max);
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
const money = (cents) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** A Shopify id as its number: 123, "123" or "gid://shopify/Product/123" → "123" (null when it isn't one) */
export const shopifyNumber = (value) => String(value ?? '').trim().match(/^(?:gid:\/\/shopify\/\w+\/)?(\d{1,20})$/)?.[1] || null;
/** A game's name as staff wrote it, spaces tidied ('' when there's none) */
const gameName = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
const gameKey = (name) => name.toLocaleLowerCase('en');

/** The Lair day n calendar months before `key` ('YYYY-MM-DD'): the same day of the month, or that month's last day */
export function monthsBefore(key, n) {
  const [y, m, d] = String(key).split('-').map(Number);
  const total = y * 12 + (m - 1) - n;
  const yy = Math.floor(total / 12);
  const mm = total - yy * 12 + 1;
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Shopify's product search for early access, and one product by id (contract v9-community, Shopify operations) */
const PRODUCT_FIELDS = (stock) => `id handle title status onlineStoreUrl featuredMedia { preview { image { url } } }
  variants(first: 100) { nodes { id title price ${stock ? 'inventoryQuantity ' : ''}availableForSale media(first: 1) { nodes { preview { image { url } } } } } }`;
const SEARCH = (stock) => `query LairOfferProducts${stock ? '' : 'Plain'}($query: String!) { products(first: 10, query: $query, sortKey: RELEVANCE) { nodes { ${PRODUCT_FIELDS(stock)} } } }`;
const ONE = (stock) => `query LairOfferProduct${stock ? '' : 'Plain'}($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS(stock)} } }`;
const DRAFT = 'mutation LairOfferDraft($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id invoiceUrl } userErrors { field message } } }';
const denied = (error) => /access denied|access_denied|required access|not approved/i.test(String(error?.message || error));

/** A product as staff pick it: { id, title, handle, status, active, published, image, variants: [{ id, title, price, stock, available, image }] } */
export function productView(n) {
  if (!n?.id) return null;
  const image = n.featuredMedia?.preview?.image?.url || null;
  const status = String(n.status || '').toUpperCase() || null;
  return {
    id: shopifyNumber(n.id), title: n.title || 'Product', handle: n.handle || '', status, active: status === 'ACTIVE' || status === 'UNLISTED',
    published: Boolean(n.onlineStoreUrl), image,
    variants: (n.variants?.nodes || []).filter((v) => v?.id).map((v) => {
      const cents = Math.round(Number(v.price || 0) * 100);
      const stock = v.inventoryQuantity == null ? null : Number(v.inventoryQuantity);
      return {
        id: shopifyNumber(v.id), title: v.title && v.title !== 'Default Title' ? v.title : '', price: Number.isFinite(cents) ? cents : 0,
        stock: Number.isFinite(stock) ? stock : null, available: v.availableForSale !== false, image: v.media?.nodes?.[0]?.preview?.image?.url || image,
      };
    }),
  };
}

/** Every claim's state now: 'paid', 'waiting' (unpaid, its link works), 'creating' (its checkout is being made) or 'released' */
export function claimState(c, now) {
  if (c.status === 'paid') return 'paid';
  if (c.status === 'waiting' && (c.expires_at || 0) > now) return 'waiting';
  if (c.status === 'creating' && (c.created_at || 0) > now - CREATING_MS && (c.expires_at || 0) > now) return 'creating';
  return 'released';
}

/** An offer's state now: 'draft', 'scheduled' (open, before its opening time), 'open' or 'closed' */
export function offerState(o, now) {
  if (o.status === 'draft') return 'draft';
  if (o.status === 'closed' || (o.closes_at || 0) <= now) return 'closed';
  if (o.opens_at && o.opens_at > now) return 'scheduled';
  return 'open';
}

/** The SQL for claims holding units at `now` (paid, waiting, or still being made): bind now, now - CREATING_MS, now */
const HOLDING = "(status = 'paid' OR (status = 'waiting' AND expires_at > ?) OR (status = 'creating' AND created_at > ? AND expires_at > ?))";

export const communityMethods = {
  /* ---------------- turnouts ---------------- */

  /**
   * Every turnout there is, one row each: { customer_id, kind ('event' | 'session'), place (the event date's occurrence id,
   * or the session's game id), event_id, system, at }. A sign-up checked in ('attended') is one for whoever signed up and
   * one for each member guest on it (round 8); an event game spot (a table booking for an event date) and a TTRPG seat are
   * one once they're seated or done. No awaits.
   */
  turnoutRows() {
    return this.sql
      .exec(
        `SELECT j.customer_id AS customer_id, 'event' AS kind, j.occurrence_id AS place, j.event_id AS event_id, NULL AS system, j.starts_at AS at
           FROM event_joins j WHERE j.status = 'attended' AND j.customer_id IS NOT NULL
         UNION ALL
         SELECT x.customer_id, 'event', j.occurrence_id, j.event_id, NULL, j.starts_at
           FROM event_join_guests x JOIN event_joins j ON j.id = x.join_id
          WHERE j.status = 'attended' AND x.customer_id IS NOT NULL AND (j.customer_id IS NULL OR j.customer_id != x.customer_id)
         UNION ALL
         SELECT b.customer_id, 'session', b.game_id, NULL, g.system, b.starts_at
           FROM bookings b LEFT JOIN games g ON g.id = b.game_id
          WHERE b.kind = 'gm-seat' AND b.status IN ('seated', 'done') AND b.customer_id IS NOT NULL
         UNION ALL
         SELECT b.customer_id, 'event', b.occurrence_id, NULL, NULL, b.starts_at
           FROM bookings b WHERE b.kind = 'table' AND b.occurrence_id IS NOT NULL AND b.status IN ('seated', 'done') AND b.customer_id IS NOT NULL`,
      )
      .toArray();
  },

  /**
   * The game a turnout counts under: an event's Game field (as staff wrote it), else its kind ("TCGs", "Wargames"…); a
   * TTRPG session's system, else "TTRPG". An event the Lair no longer has (deleted) is "Other events". events: the rules'
   * events by id. No awaits.
   */
  turnoutGame(r, events) {
    if (r.kind === 'session') return gameName(r.system) || 'TTRPG';
    const e = events.get(r.event_id || String(r.place || '').split('@')[0]);
    return gameName(e?.game) || KIND_GAMES[String(e?.type || '').trim().toLowerCase()] || 'Other events';
  },

  /**
   * GET /community?game=&sort=3m|12m|all|spend (staff, perm community): who turns up, by game. One pass over every turnout
   * (no lookups per member):
   *   games: [{ key, name, turnouts: { m3, m12, all }, people: { m3, m12, all } }], busiest in the last 3 months first;
   *   members: for the chosen game (or every game): [{ customerId, name, code, turnouts: { m3, m12, all }, spend, lastSeen,
   *     lists: [{ id, name }] }], sorted by the chosen measure, ties by the others. Every game: anyone with a turnout or any
   *     spend; one game: anyone who's turned up for it. spend is total spend at Dice Goblin (round 6's spend: online and at
   *     the POS). lastSeen: their latest turnout (for that game), or null.
   * The windows are Lair days: the last 3 months runs from midnight on the same day 3 calendar months ago (today, 9 Oct:
   * from 9 Jul), the last 12 months likewise.
   */
  async communityStats(url, who) {
    this.requireStaff(who, 'community');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const time = lairTime(rules.tz);
    const today = time.key(now);
    const from3 = time.at(monthsBefore(today, 3), 0);
    const from12 = time.at(monthsBefore(today, 12), 0);
    const sort = SORTS.includes(url.searchParams.get('sort')) ? url.searchParams.get('sort') : '3m';
    const asked = gameKey(gameName(url.searchParams.get('game')));
    const wanted = asked && asked !== 'all' ? asked : '';
    const events = new Map((rules.events || []).map((e) => [e.id, e]));
    const games = new Map();
    const people = new Map();
    const seen = new Set();
    const count = (box, at) => {
      box.all += 1;
      if (at >= from12) box.m12 += 1;
      if (at >= from3) box.m3 += 1;
      if (at > (box.last || 0)) box.last = at;
    };
    const blank = () => ({ m3: 0, m12: 0, all: 0, last: 0 });
    for (const r of this.turnoutRows()) {
      const customerId = String(r.customer_id);
      const once = `${customerId}|${r.kind}|${r.place}`;
      if (seen.has(once)) continue;
      seen.add(once);
      const name = this.turnoutGame(r, events);
      const key = gameKey(name);
      if (!games.has(key)) games.set(key, { key, name, latest: 0, turnouts: blank(), people: { m3: new Set(), m12: new Set(), all: new Set() } });
      const g = games.get(key);
      // the spelling of its latest turnout names the game
      if (r.at >= g.latest) Object.assign(g, { latest: r.at, name });
      count(g.turnouts, r.at);
      g.people.all.add(customerId);
      if (r.at >= from12) g.people.m12.add(customerId);
      if (r.at >= from3) g.people.m3.add(customerId);
      if (!people.has(customerId)) people.set(customerId, { any: blank(), game: blank() });
      const p = people.get(customerId);
      count(p.any, r.at);
      if (wanted && key === wanted) count(p.game, r.at);
    }
    const spend = new Map(this.sql.exec('SELECT customer_id, COALESCE(SUM(amount), 0) AS total FROM spend GROUP BY customer_id').toArray().map((r) => [String(r.customer_id), r.total]));
    const rows = new Map(this.sql.exec('SELECT customer_id, name, first_name, code FROM members').toArray().map((r) => [String(r.customer_id), r]));
    const lists = this.listsByMember();
    const ids = wanted
      ? [...people.keys()].filter((id) => people.get(id).game.all > 0)
      : [...new Set([...people.keys(), ...[...spend.entries()].filter(([, total]) => total > 0).map(([id]) => id)])];
    const members = ids.map((customerId) => {
      const p = people.get(customerId);
      const box = (wanted ? p?.game : p?.any) || blank();
      const row = rows.get(customerId);
      return {
        customerId, name: row?.name || row?.first_name || 'A member', code: row?.code || null, turnouts: { m3: box.m3, m12: box.m12, all: box.all },
        spend: spend.get(customerId) || 0, lastSeen: box.last || null, lists: lists.get(customerId) || [],
      };
    });
    const order = { '3m': ['m3', 'm12', 'all', 'spend'], '12m': ['m12', 'm3', 'all', 'spend'], all: ['all', 'm12', 'm3', 'spend'], spend: ['spend', 'm3', 'm12', 'all'] }[sort];
    const measure = (m, k) => (k === 'spend' ? m.spend : m.turnouts[k]);
    members.sort((a, b) => {
      for (const k of order) if (measure(b, k) !== measure(a, k)) return measure(b, k) - measure(a, k);
      return a.name.localeCompare(b.name, 'en') || a.customerId.localeCompare(b.customerId);
    });
    const gameList = [...games.values()]
      .map((g) => ({
        key: g.key, name: g.name, turnouts: { m3: g.turnouts.m3, m12: g.turnouts.m12, all: g.turnouts.all },
        people: { m3: g.people.m3.size, m12: g.people.m12.size, all: g.people.all.size },
      }))
      .sort((a, b) => b.turnouts.m3 - a.turnouts.m3 || b.turnouts.all - a.turnouts.all || a.name.localeCompare(b.name, 'en'));
    return {
      games: gameList, game: wanted || 'all', sort, members: members.slice(0, COMMUNITY_MAX), total: members.length,
      windows: { m3: from3, m12: from12 }, at: now,
    };
  },

  /* ---------------- walk-ins ---------------- */

  /**
   * POST /events/:occurrenceId/attend { code } (staff, perm checkin): someone turned up to one of today's events without
   * signing up. Their member code (scanned or typed, any case) makes a checked-in sign-up for one (source 'walk-in'), with
   * the event's usual entry fee due at the counter like any sign-up (a free event stays free). Works for events with no
   * sign-ups too (card nights). A second one for the same person and date is refused. Returns { join, row, message, notice }.
   */
  async attendEvent(occurrenceId, input, who) {
    this.requireStaff(who, 'checkin');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const occurrence = findOccurrence(rules, occurrenceId);
    if (!occurrence) throw new RuleError('That event date could not be found.', 404);
    if (!this.onTheDay(occurrence, rules, now)) {
      const day = new Intl.DateTimeFormat('en-NZ', { timeZone: rules.tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(occurrence.start)).replace(',', '');
      throw new RuleError(`Walk-ins are for today's events. That one is on ${day}.`, 422);
    }
    const typed = trimmed(input.code, 40);
    if (!typed) throw new RuleError('Scan or type their member code.', 422);
    const member = this.memberByCode(typed);
    if (!member) throw new RuleError(`No member has the code ${typed.toUpperCase()}. Check it, or find them under Members.`, 404);
    const customerId = String(member.customer_id);
    const name = trimmed(member.name || member.first_name, 80) || member.code;
    const own = this.sql
      .exec("SELECT * FROM event_joins WHERE occurrence_id = ? AND customer_id = ? AND status != 'cancelled' ORDER BY created_at LIMIT 1", occurrence.id, customerId)
      .toArray()[0];
    const along = own ? null : this.sql
      .exec(
        `SELECT j.* FROM event_join_guests x JOIN event_joins j ON j.id = x.join_id
         WHERE j.occurrence_id = ? AND x.customer_id = ? AND j.status != 'cancelled' ORDER BY j.created_at LIMIT 1`,
        occurrence.id, customerId,
      )
      .toArray()[0];
    const already = own || along;
    if (already) {
      if (already.status === 'attended') throw new RuleError(`${name} is already checked in at ${occurrence.title}.`, 409);
      throw new RuleError(`${name} is already signed up for ${occurrence.title}. Check them in from their sign-up under Event sign-ups today.`, 409);
    }
    const taken = this.sql.exec("SELECT COALESCE(SUM(people), 0) AS n FROM event_joins WHERE occurrence_id = ? AND status != 'cancelled'", occurrence.id).one().n;
    const id = makeId('ej');
    const fee = occurrence.entryFee || 0;
    this.write(
      `INSERT INTO event_joins (id, ref, occurrence_id, event_id, title, starts_at, ends_at, people, name, email, note, status, customer_id, arrived_at, pay, paid,
         amount, created_at, updated_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, '', 'attended', ?, ?, 'day', 0, ?, ?, ?, 'walk-in')`,
      id, this.newCode(name, 'join', id, now), occurrence.id, occurrence.eventId, occurrence.title, occurrence.start, occurrence.end, name,
      isEmail(member.email) ? member.email : null, customerId, now, fee, now, now,
    );
    const join = this.joinById(id);
    const full = occurrence.capacity && taken + 1 > occurrence.capacity;
    return {
      join: { ...this.staffJoinView(join), source: 'walk-in' }, row: this.joinRow(join),
      message: `Walk-in added and checked in: ${name} for ${occurrence.title}.${fee ? ` Charge ${money(fee)}.` : ''}`,
      notice: full ? `That's ${taken + 1} people for ${occurrence.capacity} places.` : null,
    };
  },

  /* ---------------- lists ---------------- */

  /** Every list each member is on: customer ID → [{ id, name }]. No awaits. */
  listsByMember() {
    const out = new Map();
    const rows = this.sql
      .exec('SELECT m.customer_id AS customer_id, l.id AS id, l.name AS name FROM community_list_members m JOIN community_lists l ON l.id = m.list_id ORDER BY l.name')
      .toArray();
    for (const r of rows) {
      const id = String(r.customer_id);
      if (!out.has(id)) out.set(id, []);
      out.get(id).push({ id: r.id, name: r.name });
    }
    return out;
  },

  listRow(id) {
    return this.sql.exec('SELECT * FROM community_lists WHERE id = ?', String(id ?? '')).toArray()[0] || null;
  },

  /** Who made something: { customerId, name } from 'staff:<customer id>' */
  staffWho(by) {
    const customerId = String(by || '').startsWith('staff:') ? String(by).slice(6) : null;
    const row = customerId ? this.memberRow(customerId) : null;
    return { customerId, name: row?.name || row?.first_name || 'Staff' };
  },

  /** A list as staff see it: { id, name, note, members: [{ customerId, name, code }], count, createdBy, createdAt, updatedAt } */
  listView(row) {
    const members = this.sql
      .exec(
        `SELECT x.customer_id AS customer_id, m.name AS name, m.first_name AS first_name, m.code AS code FROM community_list_members x
         LEFT JOIN members m ON m.customer_id = x.customer_id WHERE x.list_id = ? ORDER BY lower(COALESCE(m.name, m.first_name, '')), x.customer_id`,
        row.id,
      )
      .toArray()
      .map((m) => ({ customerId: String(m.customer_id), name: m.name || m.first_name || 'A member', code: m.code || null }));
    return {
      id: row.id, name: row.name, note: row.note || '', members, count: members.length, createdBy: this.staffWho(row.created_by), createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
    };
  },

  /** A list's name and note, checked (422s) */
  listFields(input, existing = null) {
    const out = {};
    if (!existing || input.name !== undefined) {
      const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
      if (!name) throw new RuleError(LIST_MESSAGES.name, 422);
      if (name.length > 60) throw new RuleError(LIST_MESSAGES.long, 422);
      out.name = name;
    }
    if (input.note !== undefined) {
      const note = String(input.note ?? '').trim();
      if (note.length > 300) throw new RuleError(LIST_MESSAGES.note, 422);
      out.note = note || null;
    }
    return out;
  },

  /** Customer IDs staff picked, each one a member the Lair knows (422 otherwise), without repeats. No awaits. */
  knownMembers(list) {
    const ids = [...new Set([].concat(list ?? []).map((x) => String(x ?? '').trim()).filter(Boolean))];
    if (ids.some((id) => !this.memberRow(id))) throw new RuleError(OFFER_MESSAGES.people, 422);
    return ids;
  },

  checkListName(name, except = null) {
    const clash = this.sql.exec('SELECT id FROM community_lists WHERE lower(name) = lower(?) AND id != ?', name, String(except ?? '')).toArray()[0];
    if (clash) throw new RuleError(LIST_MESSAGES.taken(name), 409);
  },

  /** GET /community/lists (staff, perm community) → { lists }, the latest changed first */
  communityLists(who) {
    this.requireStaff(who, 'community');
    return { lists: this.sql.exec('SELECT * FROM community_lists ORDER BY COALESCE(updated_at, created_at) DESC, rowid DESC').toArray().map((r) => this.listView(r)) };
  },

  /** POST /community/lists { name, note?, customerIds } (staff, perm community) → { list } */
  async createCommunityList(input, who) {
    this.requireStaff(who, 'community');
    // --- no awaits from here on ---
    const now = Date.now();
    const fields = this.listFields(input);
    const ids = this.knownMembers(input.customerIds);
    if (ids.length > LIST_MAX) throw new RuleError(LIST_MESSAGES.big, 422);
    this.checkListName(fields.name);
    const id = makeId('cl');
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    this.write('INSERT INTO community_lists (id, name, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, fields.name, fields.note || null, by, now, now);
    for (const customerId of ids) {
      this.write('INSERT OR IGNORE INTO community_list_members (list_id, customer_id, added_by, created_at) VALUES (?, ?, ?, ?)', id, customerId, by, now);
    }
    return { list: this.listView(this.listRow(id)) };
  },

  /** POST /community/lists/:id { name?, note?, add?: [customerId], remove?: [customerId] } (staff, perm community) → { list } */
  async updateCommunityList(id, input, who) {
    this.requireStaff(who, 'community');
    // --- no awaits from here on ---
    const now = Date.now();
    const row = this.listRow(id);
    if (!row) throw new RuleError(LIST_MESSAGES.missing, 404);
    const fields = this.listFields(input, row);
    const add = this.knownMembers(input.add);
    const remove = [...new Set([].concat(input.remove ?? []).map((x) => String(x ?? '').trim()).filter(Boolean))];
    if (fields.name) this.checkListName(fields.name, row.id);
    const size = this.sql.exec('SELECT COUNT(*) AS n FROM community_list_members WHERE list_id = ?', row.id).one().n;
    const fresh = add.filter((c) => !this.sql.exec('SELECT 1 AS n FROM community_list_members WHERE list_id = ? AND customer_id = ?', row.id, c).toArray().length);
    if (size + fresh.length - remove.length > LIST_MAX) throw new RuleError(LIST_MESSAGES.big, 422);
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    if (fields.name !== undefined || fields.note !== undefined) {
      this.write('UPDATE community_lists SET name = ?, note = ?, updated_at = ? WHERE id = ?', fields.name ?? row.name, fields.note !== undefined ? fields.note : row.note, now, row.id);
    }
    for (const customerId of fresh) this.write('INSERT OR IGNORE INTO community_list_members (list_id, customer_id, added_by, created_at) VALUES (?, ?, ?, ?)', row.id, customerId, by, now);
    for (const customerId of remove) this.write('DELETE FROM community_list_members WHERE list_id = ? AND customer_id = ?', row.id, customerId);
    this.write('UPDATE community_lists SET updated_at = ? WHERE id = ?', now, row.id);
    return { list: this.listView(this.listRow(row.id)) };
  },

  /**
   * POST /community/lists/:id/remove (staff, perm community): the list goes. Offers made from it keep their own copy of
   * who's on them. → { ok: true, id } (one that's gone already answers the same, so a second tap isn't an error)
   */
  async removeCommunityList(id, who) {
    this.requireStaff(who, 'community');
    // --- no awaits from here on ---
    const row = this.listRow(id);
    if (row) {
      this.write('DELETE FROM community_list_members WHERE list_id = ?', row.id);
      this.write('DELETE FROM community_lists WHERE id = ?', row.id);
    }
    return { ok: true, id: String(id) };
  },

  /* ---------------- early access offers: Shopify ---------------- */

  /** Shopify's products for a search, with stock when read_inventory allows it (else without). Throws when Shopify won't say. */
  async offerProducts(q) {
    const query = String(q).replace(/["\\]/g, ' ').trim();
    try {
      return ((await this.shopify.graphql(SEARCH(true), { query })).products?.nodes || []).map(productView).filter(Boolean);
    } catch (error) {
      if (!denied(error)) throw error;
      return ((await this.shopify.graphql(SEARCH(false), { query })).products?.nodes || []).map(productView).filter(Boolean);
    }
  },

  /** One product by its id (productView), or null when Shopify has none. Throws when Shopify won't say. */
  async offerProduct(productId) {
    const id = `gid://shopify/Product/${shopifyNumber(productId)}`;
    try {
      return productView((await this.shopify.graphql(ONE(true), { id })).product);
    } catch (error) {
      if (!denied(error)) throw error;
      return productView((await this.shopify.graphql(ONE(false), { id })).product);
    }
  },

  /** What staff hear when Shopify can't answer a product question: 503, a missing permission or Shopify being quiet */
  productsFailed(error) {
    this.note({ offerProductsError: { message: String(error?.message || error).slice(0, 300), at: new Date().toISOString() } });
    return new RuleError(denied(error) ? READ_PRODUCTS : SHOPIFY_QUIET, 503);
  },

  /** A product that can't be sold (a draft or archived): the 422 */
  notForSale(product) {
    const what = product.status === 'ARCHIVED' ? 'archived' : 'a draft';
    return new RuleError(`${product.title} is ${what} in Shopify, so it can't be sold. Make it Active first: it can stay hidden from the online store.`, 422);
  },

  /**
   * GET /products/search?q= (staff, perm community): Shopify's products for early access → { products: [{ id, title, handle,
   * status, active, published, image, variants: [{ id, title, price, stock, available, image }] }] }, up to 10. published:
   * it's on the online store (anyone can buy it there). stock is null without read_inventory.
   */
  async productSearch(url, who) {
    this.requireStaff(who, 'community');
    const q = trimmed(url.searchParams.get('q'), 80);
    if (q.length < 2) throw new RuleError("Type at least 2 letters of the product's name.", 422);
    if (!this.shopify.configured) throw new RuleError(SHOPIFY_QUIET, 503);
    try {
      return { products: await this.offerProducts(q) };
    } catch (error) {
      throw this.productsFailed(error);
    }
  },

  /* ---------------- early access offers: staff ---------------- */

  offerRow(id) {
    return this.sql.exec('SELECT * FROM early_offers WHERE id = ?', String(id ?? '')).toArray()[0] || null;
  },

  claimRow(id) {
    return this.sql.exec('SELECT * FROM early_offer_claims WHERE id = ?', String(id ?? '')).toArray()[0] || null;
  },

  /** Units an offer's claims hold now (paid, waiting or being made), leaving out one claim (except). No awaits. */
  unitsHeld(offerId, now, except = null) {
    return this.sql
      .exec(`SELECT COALESCE(SUM(quantity), 0) AS n FROM early_offer_claims WHERE offer_id = ? AND id != ? AND ${HOLDING}`, offerId, String(except ?? ''), now, now - CREATING_MS, now)
      .one().n;
  },

  /** A time staff gave: ms, an ISO time with its offset, or 'YYYY-MM-DDTHH:mm' / 'YYYY-MM-DD HH:mm' in Lair time. null when empty. */
  offerTime(value, tz) {
    if (value == null || value === '') return null;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new RuleError(OFFER_MESSAGES.date, 422);
      return Math.round(value);
    }
    const text = String(value).trim();
    const local = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})$/);
    if (local) {
      const [, day, h, m] = local;
      if (Number(h) > 23 || Number(m) > 59 || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
        throw new RuleError(OFFER_MESSAGES.date, 422);
      }
      return lairTime(tz).at(day, Number(h) * 60 + Number(m));
    }
    const ms = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text) ? Date.parse(text) : NaN;
    if (!Number.isFinite(ms)) throw new RuleError(OFFER_MESSAGES.date, 422);
    return ms;
  },

  /**
   * An offer's fields from the staff form, checked (422s), before Shopify is asked: { productId, variantIds, perPerson,
   * totalUnits, opens, closes, message, listId, customerIds, email }. On an edit, only the fields sent change. No awaits.
   */
  offerInput(input, rules, now, existing = null) {
    const out = {};
    const has = (k) => !existing || input[k] !== undefined;
    if (has('productId')) {
      out.productId = shopifyNumber(input.productId);
      if (!out.productId) throw new RuleError(OFFER_MESSAGES.product, 422);
    }
    if (has('variantIds') || out.productId) {
      const ids = [...new Set([].concat(input.variantIds ?? []).map(shopifyNumber))];
      if (!ids.length || ids.some((x) => !x)) throw new RuleError(OFFER_MESSAGES.variants, 422);
      out.variantIds = ids;
    }
    if (has('perPerson')) {
      const n = input.perPerson == null || input.perPerson === '' ? 1 : Number(input.perPerson);
      if (!Number.isInteger(n) || n < 1 || n > PER_PERSON_MAX) throw new RuleError(OFFER_MESSAGES.perPerson, 422);
      out.perPerson = n;
    }
    if (has('totalUnits')) {
      const raw = input.totalUnits;
      const n = raw == null || raw === '' ? null : Number(raw);
      if (n !== null && (!Number.isInteger(n) || n < 1 || n > UNITS_MAX)) throw new RuleError(OFFER_MESSAGES.units, 422);
      out.totalUnits = n;
    }
    if (has('opens')) out.opens = this.offerTime(input.opens, rules.tz);
    if (has('closes')) {
      out.closes = this.offerTime(input.closes, rules.tz);
      if (!out.closes) throw new RuleError(OFFER_MESSAGES.closes, 422);
    }
    const opens = out.opens !== undefined ? out.opens : existing?.opens_at ?? null;
    const closes = out.closes !== undefined ? out.closes : existing?.closes_at;
    if (out.opens !== undefined || out.closes !== undefined) {
      if (opens && closes <= opens) throw new RuleError(OFFER_MESSAGES.order, 422);
      if (closes <= now) throw new RuleError(OFFER_MESSAGES.past, 422);
    }
    if (has('message')) {
      const message = String(input.message ?? '').trim();
      if (message.length > 300) throw new RuleError(OFFER_MESSAGES.message, 422);
      out.message = message || null;
    }
    if (input.listId !== undefined) out.listId = trimmed(input.listId, 40) || null;
    if (input.customerIds !== undefined) out.customerIds = [].concat(input.customerIds ?? []);
    if (input.email !== undefined) out.email = input.email === true;
    return out;
  },

  /** The variants on offer from the product Shopify gave (each must be one of its own: 422 otherwise) */
  offerVariants(product, variantIds) {
    const byId = new Map(product.variants.map((v) => [v.id, v]));
    if (variantIds.some((id) => !byId.has(id))) throw new RuleError(`That option isn't part of ${product.title}. Search for it again.`, 422);
    return variantIds.map((id) => {
      const v = byId.get(id);
      return { id: v.id, title: v.title, price: v.price, image: v.image || product.image || null };
    });
  },

  /** Who an offer is for: the list's members and the people picked (each a member the Lair knows). No awaits. */
  offerPeople(listId, customerIds) {
    const ids = new Set(this.knownMembers(customerIds || []));
    if (listId) {
      if (!this.listRow(listId)) throw new RuleError(LIST_MESSAGES.missing, 404);
      for (const r of this.sql.exec('SELECT customer_id FROM community_list_members WHERE list_id = ?', listId).toArray()) ids.add(String(r.customer_id));
    }
    return ids;
  },

  /** Put the people on an offer (replacing who was on it, except anyone with a claim, who stays). Returns how many stayed that way. */
  setOfferPeople(offerId, ids, source, now) {
    const claimed = new Set(this.sql.exec('SELECT DISTINCT customer_id FROM early_offer_claims WHERE offer_id = ?', offerId).toArray().map((r) => String(r.customer_id)));
    const current = this.sql.exec('SELECT customer_id FROM early_offer_members WHERE offer_id = ?', offerId).toArray().map((r) => String(r.customer_id));
    let kept = 0;
    for (const c of current) {
      if (ids.has(c)) continue;
      if (claimed.has(c)) kept += 1;
      else this.write('DELETE FROM early_offer_members WHERE offer_id = ? AND customer_id = ?', offerId, c);
    }
    for (const c of ids) this.write('INSERT OR IGNORE INTO early_offer_members (offer_id, customer_id, source, created_at) VALUES (?, ?, ?, ?)', offerId, c, source, now);
    return kept;
  },

  /** "Sun 18 Oct, 6pm" (pages), or "Sunday 18 October, 6pm" (emails): when an offer opens or closes, in Lair time */
  offerWhen(ms, tz, { long = false } = {}) {
    const day = new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: long ? 'long' : 'short', day: 'numeric', month: long ? 'long' : 'short' }).format(new Date(ms)).replace(',', '');
    return `${day}, ${this.clockWord(ms, tz)}`;
  },

  /**
   * An offer as staff see it: { id, status ('draft' | 'scheduled' | 'open' | 'closed'), product: { id, title, handle, image,
   * status, published }, variants: [{ id, title, price, image }], perPerson, totalUnits, unitsLeft, claimed: { paid, waiting,
   * people }, opens, closes, message, list: { id, name } | null, people: [{ customerId, name, code }], count, email,
   * emailedAt, createdBy, createdAt, updatedAt, openedAt, closedAt, warning }. No awaits.
   */
  offerView(o, now = Date.now()) {
    const claims = this.sql.exec('SELECT * FROM early_offer_claims WHERE offer_id = ?', o.id).toArray();
    const sum = (state) => claims.filter((c) => claimState(c, now) === state).reduce((n, c) => n + c.quantity, 0);
    const paid = sum('paid');
    const waiting = sum('waiting') + sum('creating');
    const people = this.sql
      .exec(
        `SELECT x.customer_id AS customer_id, m.name AS name, m.first_name AS first_name, m.code AS code FROM early_offer_members x
         LEFT JOIN members m ON m.customer_id = x.customer_id WHERE x.offer_id = ? ORDER BY lower(COALESCE(m.name, m.first_name, '')), x.customer_id`,
        o.id,
      )
      .toArray()
      .map((m) => ({ customerId: String(m.customer_id), name: m.name || m.first_name || 'A member', code: m.code || null }));
    const list = o.list_id ? this.listRow(o.list_id) : null;
    const state = offerState(o, now);
    return {
      id: o.id, status: state,
      product: { id: o.product_id, title: o.product_title, handle: o.product_handle || '', image: o.image || null, status: o.product_status || null, published: Boolean(o.published) },
      variants: parse(o.variants, []), perPerson: o.per_person, totalUnits: o.total_units ?? null,
      unitsLeft: o.total_units == null ? null : Math.max(0, o.total_units - paid - waiting), claimed: { paid, waiting, people: new Set(claims.filter((c) => claimState(c, now) !== 'released').map((c) => c.customer_id)).size },
      opens: o.opens_at || null, closes: o.closes_at, message: o.message || '', list: o.list_id ? { id: o.list_id, name: list?.name || 'A deleted list' } : null,
      people, count: people.length, email: Boolean(o.email), emailedAt: o.emailed_at || null, createdBy: this.staffWho(o.created_by), createdAt: o.created_at,
      updatedAt: o.updated_at || o.created_at, openedAt: o.opened_at || null, closedAt: o.closed_at || null,
      warning: o.published && state !== 'closed' ? ON_SALE_ONLINE : null,
    };
  },

  /** A claim as staff see it: { id, customerId, name, code, variantId, variantTitle, price, quantity, status, expiresAt, paidAt, orderId, createdAt } */
  staffClaimView(c, now = Date.now()) {
    const m = this.memberRow(c.customer_id);
    return {
      id: c.id, customerId: String(c.customer_id), name: m?.name || m?.first_name || 'A member', code: m?.code || null, variantId: c.variant_id,
      variantTitle: c.variant_title || '', price: c.price || 0, quantity: c.quantity, status: claimState(c, now), reason: c.reason || null,
      expiresAt: c.expires_at || null, paidAt: c.paid_at || null, orderId: c.order_id || null, createdAt: c.created_at,
    };
  },

  /** GET /offers (staff, perm community) → { offers }: open and waiting ones first (soonest closing), then drafts, then closed, newest first */
  listOffers(who) {
    this.requireStaff(who, 'community');
    const now = Date.now();
    const rank = { open: 0, scheduled: 1, draft: 2, closed: 3 };
    const offers = this.sql.exec('SELECT * FROM early_offers ORDER BY created_at DESC, rowid DESC LIMIT 200').toArray().map((o) => this.offerView(o, now));
    offers.sort((a, b) => rank[a.status] - rank[b.status] || (a.status === 'closed' || a.status === 'draft' ? b.createdAt - a.createdAt : a.closes - b.closes));
    return { offers };
  },

  /** GET /offers/:id (staff, perm community) → { offer, claims }: every claim, newest first, with who, what, paid or waiting */
  offerDetail(id, who) {
    this.requireStaff(who, 'community');
    const now = Date.now();
    const o = this.offerRow(id);
    if (!o) throw new RuleError(NOT_FOUND, 404);
    const claims = this.sql.exec('SELECT * FROM early_offer_claims WHERE offer_id = ? ORDER BY created_at DESC, rowid DESC', o.id).toArray().map((c) => this.staffClaimView(c, now));
    return { offer: this.offerView(o, now), claims };
  },

  /**
   * POST /offers { productId, variantIds, perPerson, totalUnits?, opens?, closes, message?, listId?, customerIds?, email? }
   * (staff, perm community): a draft offer. Shopify is asked about the product first: one that isn't Active (a draft or
   * archived) is refused, and one on the online store comes back with `warning`. → { offer, warning }
   */
  async createOffer(input, who) {
    this.requireStaff(who, 'community');
    const rules = await this.rules();
    const fields = this.offerInput(input, rules, Date.now());
    if (!this.shopify.configured) throw new RuleError(SHOPIFY_QUIET, 503);
    let product;
    try {
      product = await this.offerProduct(fields.productId);
    } catch (error) {
      throw this.productsFailed(error);
    }
    // --- no awaits from here on ---
    const now = Date.now();
    if (!product) throw new RuleError(OFFER_MESSAGES.product404, 404);
    if (!product.active) throw this.notForSale(product);
    const variants = this.offerVariants(product, fields.variantIds);
    const people = this.offerPeople(fields.listId, fields.customerIds);
    const id = makeId('of');
    this.write(
      `INSERT INTO early_offers (id, product_id, product_title, product_handle, image, product_status, published, variants, per_person, total_units, opens_at,
         closes_at, message, status, list_id, email, emailed_at, created_by, created_at, updated_at, opened_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, NULL, ?, ?, ?, NULL, NULL)`,
      id, product.id, product.title, product.handle, product.image, product.status, product.published ? 1 : 0, JSON.stringify(variants), fields.perPerson,
      fields.totalUnits, fields.opens, fields.closes, fields.message, fields.listId || null, fields.email ? 1 : 0,
      who.customerId ? `staff:${who.customerId}` : 'staff', now, now,
    );
    this.setOfferPeople(id, people, fields.listId ? 'list' : 'picked', now);
    return { offer: this.offerView(this.offerRow(id), now), warning: product.published ? ON_SALE_ONLINE : null };
  },

  /**
   * POST /offers/:id { …the fields that change } (staff, perm community): edit a draft or open offer. Once it's open the
   * product stays; the total can't go below the units already claimed; people with a claim stay on it. → { offer, warning,
   * notice }
   */
  async updateOffer(id, input, who) {
    this.requireStaff(who, 'community');
    const rules = await this.rules();
    const before = this.offerRow(id);
    if (!before) throw new RuleError(NOT_FOUND, 404);
    const fields = this.offerInput(input, rules, Date.now(), before);
    const productId = fields.productId || before.product_id;
    let product = null;
    if (fields.productId || fields.variantIds) {
      if (!this.shopify.configured) throw new RuleError(SHOPIFY_QUIET, 503);
      try {
        product = await this.offerProduct(productId);
      } catch (error) {
        throw this.productsFailed(error);
      }
    }
    // --- no awaits from here on ---
    const now = Date.now();
    const o = this.offerRow(id);
    if (!o) throw new RuleError(NOT_FOUND, 404);
    const state = offerState(o, now);
    if (state === 'closed') throw new RuleError(OFFER_MESSAGES.closed, 409);
    if (fields.productId && fields.productId !== o.product_id && state !== 'draft') throw new RuleError(OFFER_MESSAGES.productChange, 409);
    if (product === null && (fields.productId || fields.variantIds)) throw new RuleError(OFFER_MESSAGES.product404, 404);
    if (product && !product.active) throw this.notForSale(product);
    const variants = product ? this.offerVariants(product, fields.variantIds || parse(o.variants, []).map((v) => v.id)) : null;
    const held = this.unitsHeld(o.id, now);
    if (fields.totalUnits != null && fields.totalUnits < held) throw new RuleError(`${plural(held, 'unit is', 'units are')} claimed already, so the total can't go below ${held}.`, 422);
    const people = fields.listId !== undefined || fields.customerIds !== undefined
      ? this.offerPeople(fields.listId !== undefined ? fields.listId : o.list_id, fields.customerIds !== undefined ? fields.customerIds : [])
      : null;
    const pick = (k, column) => (fields[k] !== undefined ? fields[k] : o[column]);
    this.write(
      `UPDATE early_offers SET product_id = ?, product_title = ?, product_handle = ?, image = ?, product_status = ?, published = ?, variants = ?, per_person = ?,
         total_units = ?, opens_at = ?, closes_at = ?, message = ?, list_id = ?, email = ?, updated_at = ? WHERE id = ?`,
      product ? product.id : o.product_id, product ? product.title : o.product_title, product ? product.handle : o.product_handle, product ? product.image : o.image,
      product ? product.status : o.product_status, product ? (product.published ? 1 : 0) : o.published, variants ? JSON.stringify(variants) : o.variants,
      pick('perPerson', 'per_person'), pick('totalUnits', 'total_units'), pick('opens', 'opens_at'), pick('closes', 'closes_at'), pick('message', 'message'),
      fields.listId !== undefined ? fields.listId : o.list_id, fields.email !== undefined ? (fields.email ? 1 : 0) : o.email, now, o.id,
    );
    const kept = people ? this.setOfferPeople(o.id, people, (fields.listId !== undefined ? fields.listId : o.list_id) ? 'list' : 'picked', now) : 0;
    // A claim still waiting keeps its time unless the offer now closes sooner
    if (fields.closes !== undefined) this.write("UPDATE early_offer_claims SET expires_at = MIN(expires_at, ?) WHERE offer_id = ? AND status IN ('waiting', 'creating')", fields.closes, o.id);
    const fresh = this.offerRow(o.id);
    return {
      offer: this.offerView(fresh, now), warning: fresh.published ? ON_SALE_ONLINE : null,
      notice: kept ? `${plural(kept, 'person has', 'people have')} a claim already, so they stay on it.` : null,
    };
  },

  /**
   * POST /offers/:id/open { email? } (staff, perm community): open early access. Shopify is asked about the product again
   * (it has to be Active). It opens at its opening time, or now; with email, everyone on it with an email hears (now, or
   * when it opens). → { offer, emailed, warning }
   */
  async openOffer(id, input, who) {
    this.requireStaff(who, 'community');
    await this.rules();
    const before = this.offerRow(id);
    if (!before) throw new RuleError(NOT_FOUND, 404);
    if (!this.shopify.configured) throw new RuleError(SHOPIFY_QUIET, 503);
    let product;
    try {
      product = await this.offerProduct(before.product_id);
    } catch (error) {
      throw this.productsFailed(error);
    }
    // --- no awaits from here on ---
    const now = Date.now();
    const o = this.offerRow(id);
    if (!o) throw new RuleError(NOT_FOUND, 404);
    const state = offerState(o, now);
    if (state === 'closed') throw new RuleError(OFFER_MESSAGES.closed, 409);
    if (!product) throw new RuleError(OFFER_MESSAGES.product404, 404);
    if (!product.active) throw this.notForSale(product);
    if (o.closes_at <= now) throw new RuleError(OFFER_MESSAGES.past, 422);
    const count = this.sql.exec('SELECT COUNT(*) AS n FROM early_offer_members WHERE offer_id = ?', o.id).one().n;
    if (!count) throw new RuleError(OFFER_MESSAGES.nobody, 422);
    const email = input.email !== undefined ? input.email === true : Boolean(o.email);
    const opens = o.opens_at && o.opens_at > now ? o.opens_at : now;
    const already = state === 'open' || state === 'scheduled';
    this.write(
      `UPDATE early_offers SET status = 'open', opens_at = ?, opened_at = COALESCE(opened_at, ?), email = ?, product_status = ?, published = ?, product_title = ?,
         image = COALESCE(?, image), updated_at = ? WHERE id = ?`,
      opens, now, email ? 1 : 0, product.status, product.published ? 1 : 0, product.title, product.image, now, o.id,
    );
    const emailed = email && opens <= now && !o.emailed_at && !already ? this.emailOffer(this.offerRow(o.id), now) : 0;
    return { offer: this.offerView(this.offerRow(o.id), now), emailed, warning: product.published ? ON_SALE_ONLINE : null };
  },

  /** POST /offers/:id/close (staff, perm community): early access ends now; unpaid claims are let go. → { offer, released } */
  async closeOffer(id, who) {
    this.requireStaff(who, 'community');
    // --- no awaits from here on ---
    const now = Date.now();
    const o = this.offerRow(id);
    if (!o) throw new RuleError(NOT_FOUND, 404);
    if (o.status !== 'closed') this.write("UPDATE early_offers SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?", Math.min(now, o.closes_at || now), now, o.id);
    const released = this.releaseClaims("offer_id = ? AND status IN ('waiting', 'creating')", [o.id], 'closed', now);
    return { offer: this.offerView(this.offerRow(o.id), now), released };
  },

  /**
   * Let unpaid claims go (where: an SQL condition on early_offer_claims, with its bindings): released, with the reason, and
   * their checkouts deleted (a checkout that was just paid stays: the paid webhook still marks its claim). No awaits.
   * Returns how many.
   */
  releaseClaims(where, bindings, reason, now) {
    const rows = this.sql.exec(`SELECT * FROM early_offer_claims WHERE ${where}`, ...bindings).toArray();
    for (const c of rows) {
      this.write("UPDATE early_offer_claims SET status = 'released', reason = ?, ended_at = ?, updated_at = ? WHERE id = ? AND status IN ('waiting', 'creating')", reason, now, now, c.id);
      if (c.draft_order_id && this.shopify.configured) this.later(this.shopify.deleteDraftIfOpen(c.draft_order_id));
    }
    return rows.length;
  },

  /**
   * "Early access: <product>" to everyone on an offer with an email (Gobgob's voice; the staff's message under it), with a
   * button to My Lair. No awaits (the emails go out afterwards). Returns how many were sent.
   */
  emailOffer(o, now) {
    if (!emailReady(this.env)) return 0;
    const tz = this.rulesCache?.tz || 'Pacific/Auckland';
    // the email in their Lair profile, else their Shopify account's verified email (read when they open My Lair)
    const people = this.sql
      .exec('SELECT m.* FROM early_offer_members x JOIN members m ON m.customer_id = x.customer_id WHERE x.offer_id = ?', o.id)
      .toArray()
      .map((m) => ({ ...m, email: isEmail(m.email) ? m.email : isEmail(m.account_email) ? m.account_email : null }))
      .filter((m) => m.email);
    this.write('UPDATE early_offers SET emailed_at = ? WHERE id = ?', now, o.id);
    if (!people.length) return 0;
    const when = this.offerWhen(o.closes_at, tz, { long: true });
    const messages = people.map((m) => this.letter(m.email, `Early access: ${o.product_title}`, {
      title: `Early access: ${o.product_title}`,
      intro: [`Kia ora ${m.first_name || String(m.name || '').split(/\s+/)[0] || 'friend'}, Gobgob saved you a spot before anyone else.`, `Grab it in My Lair before ${when}.`],
      details: [['Limit', `${o.per_person} per person`]],
      outro: o.message ? [o.message] : [],
      button: { label: 'Open My Lair', url: this.page('myLair') },
    }));
    this.later(this.mailMany(messages));
    return people.length;
  },

  /**
   * Maintenance (every 10 minutes): unpaid claims past their time are let go, offers past their closing time close (and
   * their unpaid claims go), and offers that opened since the last run send their emails. No awaits. Returns { released,
   * closed, emailed } when anything happened, else null.
   */
  offerUpkeep(now) {
    const ended = this.sql.exec("SELECT * FROM early_offers WHERE status = 'open' AND closes_at <= ?", now).toArray();
    for (const o of ended) this.write("UPDATE early_offers SET status = 'closed', closed_at = closes_at, updated_at = ? WHERE id = ?", now, o.id);
    let released = 0;
    for (const o of ended) released += this.releaseClaims("offer_id = ? AND status IN ('waiting', 'creating')", [o.id], 'closed', now);
    released += this.releaseClaims("(status = 'waiting' AND expires_at <= ?) OR (status = 'creating' AND (created_at <= ? OR expires_at <= ?))", [now, now - CREATING_MS, now], 'expired', now);
    let emailed = 0;
    const due = this.sql.exec("SELECT * FROM early_offers WHERE status = 'open' AND email = 1 AND emailed_at IS NULL AND opens_at <= ? AND closes_at > ?", now, now).toArray();
    for (const o of due) emailed += this.emailOffer(o, now);
    return released || ended.length || emailed ? { released, closed: ended.length, emailed } : null;
  },

  /* ---------------- early access offers: the member's side ---------------- */

  /**
   * A member's own claim: { id, variantId, variantTitle, price, quantity, status ('waiting' | 'paid'), checkoutUrl (waiting
   * only: their own link), expiresAt, paidAt }
   */
  ownClaimView(c, now) {
    const state = claimState(c, now);
    return {
      id: c.id, variantId: c.variant_id, variantTitle: c.variant_title || '', price: c.price || 0, quantity: c.quantity, status: state === 'creating' ? 'waiting' : state,
      checkoutUrl: state === 'waiting' ? c.checkout_url || null : null, expiresAt: c.expires_at || null, paidAt: c.paid_at || null,
    };
  },

  /**
   * GET /me's offers: the open offers this member is on, soonest closing first: { id, title, image, message, variants: [{ id,
   * title, price, image }], limit (per person), bought (paid so far), canBuy (left of their limit), unitsLeft (null when the
   * offer has no total), opens, closes, claim (their waiting claim, else their latest paid one, else null) }. Only their own
   * claims and links. No awaits.
   */
  memberOffers(customerId, now = Date.now()) {
    const id = String(customerId);
    const offers = this.sql
      .exec(
        `SELECT o.* FROM early_offers o JOIN early_offer_members x ON x.offer_id = o.id AND x.customer_id = ?
         WHERE o.status = 'open' AND o.closes_at > ? AND (o.opens_at IS NULL OR o.opens_at <= ?) ORDER BY o.closes_at, o.id`,
        id, now, now,
      )
      .toArray();
    return offers.map((o) => {
      const mine = this.sql.exec('SELECT * FROM early_offer_claims WHERE offer_id = ? AND customer_id = ? ORDER BY created_at DESC, rowid DESC', o.id, id).toArray();
      const bought = mine.filter((c) => claimState(c, now) === 'paid').reduce((n, c) => n + c.quantity, 0);
      const live = mine.find((c) => ['waiting', 'creating'].includes(claimState(c, now)));
      const paid = mine.find((c) => claimState(c, now) === 'paid');
      const claim = live || paid || null;
      return {
        id: o.id, title: o.product_title, image: o.image || null, message: o.message || '', variants: parse(o.variants, []), limit: o.per_person, bought,
        canBuy: Math.max(0, o.per_person - bought), unitsLeft: o.total_units == null ? null : Math.max(0, o.total_units - this.unitsHeld(o.id, now)),
        opens: o.opens_at || null, closes: o.closes_at, claim: claim ? this.ownClaimView(claim, now) : null,
      };
    });
  },

  /**
   * POST /offers/:id/claim { variantId, quantity } (logged in, on the offer): a Shopify draft order made for this member
   * (their customer attached, one line: the variant and quantity, tagged lair-offer) with the units reserved first. One
   * unpaid claim a member an offer: claiming again replaces it. Unpaid, it's let go after 48 hours or when the offer
   * closes, whichever is first. → { claim (with their checkoutUrl), offer (memberOffers' view) }
   */
  async claimOffer(id, input, who) {
    if (!who.customerId) throw new RuleError('Log in to claim early access, friend.', 401);
    const customerId = String(who.customerId);
    const first = this.offerRow(id);
    const onIt = (o) => o && o.status !== 'draft' && this.sql.exec('SELECT 1 AS n FROM early_offer_members WHERE offer_id = ? AND customer_id = ?', o.id, customerId).toArray().length > 0;
    if (!onIt(first)) throw new RuleError(NOT_FOUND, 404);
    if (!this.shopify.configured) throw new RuleError("Gobgob can't make checkouts right now. Try again soon, or ask at the counter.", 503);
    let product;
    try {
      product = await this.offerProduct(first.product_id);
    } catch (error) {
      this.note({ offerProductsError: { message: String(error?.message || error).slice(0, 300), at: new Date().toISOString() } });
      throw new RuleError("Shopify didn't answer just now. Try again in a minute.", 503);
    }
    // --- no awaits until the claim is saved ---
    let now = Date.now();
    const o = this.offerRow(id);
    if (!onIt(o)) throw new RuleError(NOT_FOUND, 404);
    const tz = this.rulesCache?.tz || 'Pacific/Auckland';
    const state = offerState(o, now);
    if (state === 'closed') throw new RuleError(`Early access to ${o.product_title} has closed.`, 409);
    if (state === 'scheduled') throw new RuleError(`Early access to ${o.product_title} opens ${this.offerWhen(o.opens_at, tz)}.`, 409);
    if (!product || !product.active) throw new RuleError(`${o.product_title} can't be bought right now. Have a chat with us at the counter.`, 409);
    const offered = parse(o.variants, []);
    const variantId = shopifyNumber(input.variantId) || (offered.length === 1 ? offered[0].id : null);
    const variant = offered.find((v) => v.id === variantId);
    if (!variant) throw new RuleError('Pick one of the options on offer.', 422);
    const live = product.variants.find((v) => v.id === variantId);
    if (!live) throw new RuleError(`${o.product_title} can't be bought right now. Have a chat with us at the counter.`, 409);
    const quantity = input.quantity == null ? 1 : Number(input.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > o.per_person) throw new RuleError(`Pick how many: 1 to ${o.per_person}.`, 422);
    const mine = this.sql.exec('SELECT * FROM early_offer_claims WHERE offer_id = ? AND customer_id = ?', o.id, customerId).toArray();
    if (mine.some((c) => claimState(c, now) === 'creating')) throw new RuleError("Hang on: Gobgob's still setting up your last one. Try again in a moment.", 409);
    const bought = mine.filter((c) => claimState(c, now) === 'paid').reduce((n, c) => n + c.quantity, 0);
    if (bought + quantity > o.per_person) {
      const left = o.per_person - bought;
      throw new RuleError(left > 0 ? `That's more than your limit of ${o.per_person}: you've got ${bought} already, so ${left} more at most.` : `You've got your ${o.per_person} already, friend. That's the limit.`, 409);
    }
    const waiting = mine.find((c) => claimState(c, now) === 'waiting');
    if (o.total_units != null) {
      const left = o.total_units - this.unitsHeld(o.id, now, waiting?.id);
      if (left <= 0) throw new RuleError('Every one has been claimed. Sorry, friend.', 409);
      if (quantity > left) throw new RuleError(`Only ${left} left. Pick ${left} or fewer.`, 409);
    }
    const claimId = makeId('oc');
    const expires = Math.min(now + CLAIM_HOURS * HOUR, o.closes_at);
    this.write(
      `INSERT INTO early_offer_claims (id, offer_id, customer_id, variant_id, variant_title, price, quantity, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?)`,
      claimId, o.id, customerId, variant.id, variant.title || '', live.price, quantity, expires, now, now,
    );
    // --- saved: the units are this claim's. Now the checkout ---
    let draft;
    try {
      draft = await this.offerDraft({ claimId, customerId, variantId: variant.id, quantity, title: o.product_title });
    } catch (error) {
      console.error('Lair: early access checkout could not be made', error);
      this.write("UPDATE early_offer_claims SET status = 'released', reason = 'failed', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'creating'", Date.now(), Date.now(), claimId);
      throw new RuleError("Shopify couldn't make your checkout just now. Try again in a minute.", 503);
    }
    // --- no awaits from here on: only this claim's row, and the claim it replaces ---
    now = Date.now();
    const offerNow = this.offerRow(o.id);
    const row = this.claimRow(claimId);
    if (!row || row.status !== 'creating' || offerState(offerNow, now) === 'closed') {
      this.write("UPDATE early_offer_claims SET status = 'released', reason = 'closed', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'creating'", now, now, claimId);
      this.later(this.shopify.deleteDraftIfOpen(draft.draftOrderId));
      throw new RuleError(`Early access to ${o.product_title} has closed.`, 409);
    }
    this.write("UPDATE early_offer_claims SET status = 'waiting', draft_order_id = ?, checkout_url = ?, updated_at = ? WHERE id = ? AND status = 'creating'", draft.draftOrderId, draft.checkoutUrl, now, claimId);
    if (waiting) {
      this.write("UPDATE early_offer_claims SET status = 'released', reason = 'replaced', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'waiting'", now, now, waiting.id);
      if (waiting.draft_order_id) this.later(this.shopify.deleteDraftIfOpen(waiting.draft_order_id));
    }
    const view = this.memberOffers(customerId, now).find((x) => x.id === o.id) || null;
    return { claim: this.ownClaimView(this.claimRow(claimId), now), offer: view };
  },

  /**
   * The draft order behind a claim: this customer's (purchasingEntity), one line (the variant and quantity), tagged
   * lair-offer, the claim's id on the order (_offer_claim) for the paid webhook. Throws when Shopify says no.
   */
  async offerDraft({ claimId, customerId, variantId, quantity, title }) {
    const data = await this.shopify.graphql(DRAFT, {
      input: {
        purchasingEntity: { customerId: `gid://shopify/Customer/${customerId}` },
        tags: ['lair-offer'],
        note: 'Lair early access claim',
        customAttributes: [{ key: '_offer_claim', value: claimId }],
        lineItems: [{ variantId: `gid://shopify/ProductVariant/${variantId}`, quantity, customAttributes: [{ key: '_offer_claim', value: claimId }, { key: 'Early access', value: title }] }],
      },
    });
    const result = data.draftOrderCreate;
    if (!result || result.userErrors?.length || !result.draftOrder?.id) throw new Error((result?.userErrors || []).map((e) => e.message).join('; ') || 'no draft order came back');
    return { draftOrderId: result.draftOrder.id, checkoutUrl: result.draftOrder.invoiceUrl };
  },

  /**
   * orders/paid (the webhook): a paid early access checkout marks its claim paid. The claim's id is on the order
   * (_offer_claim), and the claim's own draft order must have become this order (Shopify is asked), so nothing else can
   * mark a claim paid. One paid after it was let go is still marked paid (they paid), and staff hear to check the stock.
   * Returns the claims marked.
   */
  async offerClaimsPaid(order, orderId) {
    const source = order.source_name || '';
    if (source && source !== 'shopify_draft_order') return [];
    const ids = new Set();
    for (const a of order.note_attributes || []) if (a.name === '_offer_claim' && a.value) ids.add(String(a.value).trim());
    for (const item of order.line_items || []) for (const p of item.properties || []) if (p.name === '_offer_claim' && p.value) ids.add(String(p.value).trim());
    const verified = [];
    for (const id of [...ids].slice(0, 5)) {
      const claim = this.claimRow(id);
      if (!claim?.draft_order_id || claim.status === 'paid') continue;
      // If Shopify can't answer, this throws: the webhook gets a 500 and Shopify sends it again later.
      const linked = await this.shopify.draftOrderOrderId(claim.draft_order_id);
      if (linked === orderId || (linked === null && source === 'shopify_draft_order')) verified.push(id);
    }
    // --- no awaits from here on ---
    const now = Date.now();
    const marked = [];
    for (const id of verified) {
      const c = this.claimRow(id);
      if (!c || c.status === 'paid') continue;
      const letGo = claimState(c, now) === 'released';
      this.write("UPDATE early_offer_claims SET status = 'paid', order_id = ?, paid_at = ?, updated_at = ? WHERE id = ?", orderId, now, now, id);
      marked.push(id);
      if (letGo) {
        const o = this.offerRow(c.offer_id);
        const m = this.memberRow(c.customer_id);
        this.notifyStaff(`Early access paid late: ${o?.product_title || 'an offer'}`, {
          title: 'An early access claim was paid after it was let go',
          intro: `${m?.name || m?.first_name || 'A member'} paid for ${c.quantity} × ${o?.product_title || 'the product'} after their claim had been let go. It's theirs now: check there's enough stock for everyone.`,
          details: [['Member', m?.name || ''], ['Code', m?.code || ''], ['Order', orderId]],
        });
      }
    }
    return marked;
  },
};


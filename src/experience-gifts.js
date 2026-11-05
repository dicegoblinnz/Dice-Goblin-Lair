/**
 * Round 31 (6 Nov 2026, contract v31-gifts): experience gifts for Christmas, from the parties, families and newcomers
 * work. Mo's calls, 1 and 6 Nov 2026: "Your first roleplaying game" ($30: a seat at any beginner game and a set of dice
 * up to $30 to keep, "so effectively it would look like the session is free") and "Learn to paint" ($10: a seat at Learn
 * to paint with the Lair's miniature, brushes and paints), sold email only like the session gift, lasting "3 years,
 * experience honoured". He approved the mockups on 6 Nov 2026 ("Yes, as drawn"). The gift card is Shopify's own.
 *
 * Sold as products. An order line whose SKU is LAIR-XP-<KIND> (online or at the counter) makes one gift a unit: an
 * unlinked one-use pass of that kind (source 'gift', kind, gift_from: the buyer's first name), made once per order, line
 * and unit as session gifts are (lair.js issueGiftPasses), and the buyer gets every code by email ("Your gift is ready",
 * sendExperienceGifts), or the staff do. A kind the Lair doesn't know makes nothing and is noted for the health check.
 *
 * Use by. Every gift sold from now on, session gifts too, lasts until the end of its sale day 3 years on, Lair time
 * (giftUseBy: 29 February becomes 1 March, so it's never short). New Zealand's Fair Trading Act wants at least 3 years
 * for gift cards and vouchers sold since 16 March 2026, and the date shown, so the email, My Lair and the staff page all
 * show it.
 *
 * Codes. A gift is a bearer code worth money, handed on in a card and claimed by whoever types it first, so its code is
 * DG, a word and 4 letters or digits (newGiftCode: about 240 million of them) rather than a booking's DG-WORD-12 (about 5
 * thousand), which 10 tries in 10 minutes a member could find.
 *
 * At the counter (lair.js usePassAtCheckIn and useGiftOnJoin). A gift covers its experience whatever it costs on the
 * day, since prices may go up in 3 years:
 *  - first-game: one person's whole seat at a TTRPG session (a gm-seat booking), GM's fee and all, so the seat is paid
 *    and its GM is credited as for any paid seat. Staff are reminded about the dice (GIFT_WORDS.dice). Nothing else.
 *  - paint: one person's entry on a sign-up at Learn to paint (an event whose id or title says painting). Nothing else.
 *  - "Use it now" (POST /passes/:id/use, staff): a gift used for its experience with nothing booked: a kid at the kids'
 *    table rung up at the counter, a painter at the station. One go; undo puts it back.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { CODE_WORDS, LairTime, RuleError, addDays, codeKey, eventOccurrences, makeId } from './core.js';
import { emailReady } from './shopify.js';

/** How long a gift lasts, in years from the day it's sold */
export const GIFT_YEARS = 3;
/** A gift sold as a product: LAIR-XP-<KIND>, any case */
export const XP_SKU = /^LAIR-XP-([A-Z0-9-]{1,30})$/i;
/** How to use any gift, in its email (as drawn) */
const HOW_TO = 'Log in at dicegoblin.nz, open My Lair › Wallet and enter the code under "Got a code?". Or just show it at the counter.';

/**
 * The gifts, word for word in the contract. sku: the product's SKU. name: what it's called. label: the pass's label (the
 * staff page, the counter). covers: the line in its email's box. staff: what it covers, for staff. details: its email's
 * rows (How to use it comes first, once). button: its email's button and the page it opens. honoured: the promise if
 * prices go up. usedNow: what staff are told when they use it with nothing booked.
 */
export const GIFT_KINDS = Object.freeze({
  'first-game': Object.freeze({
    sku: 'LAIR-XP-FIRSTGAME',
    name: 'Your first roleplaying game',
    label: 'Gift: Your first roleplaying game',
    covers: 'A seat at any beginner game at the Lair, and a set of dice to keep.',
    staff: "Covers one person's whole seat at a TTRPG session, GM's fee and all, and a set of dice up to $30 to keep.",
    details: Object.freeze([
      ['Kids 8 to 14', "Kids' games, weekdays 4 to 6pm. Staff look after them until pick-up."],
      ['Teens and adults', 'Any game that takes beginners. Under-14s come with a grown-up.'],
      ['The dice', 'Picked at the counter on the day: any set up to $30.'],
    ]),
    button: 'See beginner games',
    page: 'gm',
    honoured: 'If prices go up, the gift still covers the game. If the Lair ever stops running beginner games, it becomes store credit for what you paid.',
    usedNow: "Used: Your first roleplaying game. Don't charge for their seat today, and let them pick a set of dice up to $30.",
    notFor: "This gift is for a seat at a roleplaying game, so it wasn't used here.",
  }),
  paint: Object.freeze({
    sku: 'LAIR-XP-PAINT',
    name: 'Learn to paint',
    label: 'Gift: Learn to paint',
    covers: "A seat at Learn to paint, with the Lair's miniature, brushes and paints.",
    staff: "Covers one person's seat at Learn to paint: the Lair's paints, brushes and a miniature from the shelf. Keeping the miniature is extra.",
    details: Object.freeze([
      // the first row is the next class, from the events (nextClassLine)
      ['Who can paint', 'Ages 8 and up. Under-12s come with a grown-up, who watches free.'],
      ['Keep the miniature', '$5 more on the night, or $20 for a large one.'],
    ]),
    button: 'See the next class',
    page: 'events',
    honoured: 'If prices go up, the gift still covers the class. If the Lair ever stops running Learn to paint, it becomes store credit for what you paid.',
    usedNow: "Used: Learn to paint. Don't charge for their seat today. Keeping the miniature is extra.",
    notFor: "This gift is for a seat at Learn to paint, so it wasn't used here.",
  }),
});

/** The rest of what gifts say, word for word in the contract */
export const GIFT_WORDS = Object.freeze({
  subject: (many) => (many ? 'Your gifts are ready' : 'Your gift is ready'),
  hello: (name, many) => `Kia ora ${name || 'friend'}, thanks for buying ${many ? 'gifts' : 'a gift'} from the Lair. Gobgob wrapped ${many ? 'them' : 'it'} themselves.`,
  passOn: (many) => `Pass ${many ? 'them' : 'it'} on however you like: forward this email, print it, or write ${many ? 'each code' : 'the code'} in a card.`,
  howTo: HOW_TO,
  useBy: (day) => `Use by ${day}`,
  /** a Learn to paint gift's first row: its next class, from the events */
  nextClass: (when, seats) => `Next class: ${when}.${seats ? ` ${seats} seats, so book ahead.` : ''}`,
  noClass: "It's the first Thursday of the month: the events page has the next one.",
  /** a session gift (LAIR-GIFT-N) in the same email */
  sessions: (n) => `${n} table ${n === 1 ? 'session' : 'sessions'} at the Lair, each covering one person's table fee.`,
  honouredAll: "If prices go up, each gift still covers what it's for. If the Lair ever stops running one, it becomes store credit for what you paid.",
  openMyLair: 'Open My Lair',
  seeWhatsOn: "See what's on",
  /** the staff, when the buyer can't be emailed */
  staffSubject: (orderName) => `Gift codes to pass on${orderName ? `: ${orderName}` : ''}`,
  staffTitle: 'Gift codes to pass on',
  noEmail: (many) => `Someone bought ${many ? 'gifts' : 'a gift'}, but there's no email address on the order, so Gobgob couldn't send ${many ? 'the codes' : 'the code'}.`,
  bounced: (orderName, email, why) => `The gift ${orderName ? `codes for ${orderName}` : 'codes'} couldn't be emailed to ${email} (${why}).`,
  giveThem: (many, orderName) => `Give ${many ? 'these codes' : 'this code'} to whoever bought ${orderName || 'the gift'}. ${many ? 'They also show' : 'It also shows'} under Passes on the staff page.`,
  /** the counter */
  dice: "It's their first roleplaying game gift: they pick a set of dice to keep too, up to $30.",
  notFor: (kind) => GIFT_KINDS[kind]?.notFor || "That gift isn't for this, so it wasn't used here.",
  onePerson: (people) => `The gift covered one of the ${people} people.`,
  usedNow: (kind) => GIFT_KINDS[kind]?.usedNow || 'Used.',
  onlyGifts: 'Only a gift is used with nothing booked. A session pass is used when they check in.',
  used: 'That gift has been used. Undo its use first if that was a mistake.',
  void: 'That gift has been cancelled. Ask the main account about it.',
  expired: (day) => `That gift expired on ${day}.`,
  /** My Lair's "Got a code?" */
  added: (name, day) => `Added to your wallet: ${name}. Use it by ${day}.`,
});

/**
 * The columns made sure of on every start (lair.js's migrate): passes.kind ('first-game', 'paint'; null on every other
 * pass) and passes.gift_from (the buyer's first name, for "A gift from Sam" in My Lair); on a sign-up, event_joins.covered
 * (what gifts covered) and event_joins.pass_id (the gift saved or used on it, as bookings have); on a pass's use,
 * pass_uses.join_id (the sign-up it covered; its booking_id is then '') and pass_uses.note (staff's words on a gift used
 * with nothing booked, when both are '' and null).
 */
export const GIFT_COLUMNS = [
  ['passes', 'kind', 'TEXT'],
  ['passes', 'gift_from', 'TEXT'],
  ['event_joins', 'covered', 'INTEGER NOT NULL DEFAULT 0'],
  ['event_joins', 'pass_id', 'TEXT'],
  ['pass_uses', 'join_id', 'TEXT'],
  ['pass_uses', 'note', 'TEXT'],
];
export const GIFT_INDEXES = ['CREATE INDEX IF NOT EXISTS pass_uses_join ON pass_uses (join_id) WHERE join_id IS NOT NULL'];

/** The kind a SKU makes: 'first-game', 'paint', { unknown: sku } for a LAIR-XP-… the Lair doesn't know, or null */
export function giftKindOfSku(sku) {
  const text = String(sku ?? '').trim();
  if (!XP_SKU.test(text)) return null;
  const upper = text.toUpperCase();
  const kind = Object.keys(GIFT_KINDS).find((k) => GIFT_KINDS[k].sku === upper);
  return kind || { unknown: upper };
}

/**
 * The last moment a gift sold at soldAt can be used: the end of its sale day GIFT_YEARS on, Lair time (tz). A sale on
 * 29 February lasts until the end of 1 March when that year has no 29 February, so it's never under 3 years.
 */
export function giftUseBy(soldAt, tz = 'Pacific/Auckland') {
  const time = new LairTime(tz);
  const [y, m, d] = time.key(soldAt).split('-').map(Number);
  const year = y + GIFT_YEARS;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const day = m === 2 && d === 29 && !leap ? `${year}-03-01` : `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return time.at(addDays(day, 1), 0) - 1;
}

/** "6 November 2029", Lair time */
export function giftDay(ms, tz = 'Pacific/Auckland') {
  return new Intl.DateTimeFormat('en-NZ', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(ms));
}

/** An event Learn to paint covers: its id or title says painting (lair_event learn-to-paint, "Learn to paint") */
const paintEvent = (eventId, title) => /paint/i.test(String(eventId || '')) || /paint/i.test(String(title || ''));

/** The letters and digits a gift code ends with: none that read as another (0 O, 1 I L) */
const TAIL = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const experienceGiftMethods = {
  /**
   * A new gift code, kept in the codes table for the pass with this id: DG, a word, and 4 letters or digits
   * (DG-GRIFFIN-7KQ4). No awaits.
   */
  newGiftCode(passId, now = Date.now()) {
    for (let i = 0; i < 50; i += 1) {
      const r = crypto.getRandomValues(new Uint32Array(5));
      const tail = [1, 2, 3, 4].map((n) => TAIL[r[n] % TAIL.length]).join('');
      const code = `DG-${CODE_WORDS[r[0] % CODE_WORDS.length]}-${tail}`;
      if (this.codeTaken(codeKey(code))) continue;
      this.write('INSERT INTO codes (key, code, kind, target_id, created_at) VALUES (?, ?, ?, ?, ?)', codeKey(code), code, 'pass', String(passId), now);
      return code;
    }
    throw new Error('Could not find a free gift code');
  },

  /**
   * Whether a gift of this kind covers this: { type: 'booking', kind } (a booking's kind: first-game covers a 'gm-seat')
   * or { type: 'join', eventId, title } (a sign-up: paint covers Learn to paint). No awaits.
   */
  giftFits(kind, target) {
    if (kind === 'first-game') return target?.type === 'booking' && target.kind === 'gm-seat';
    if (kind === 'paint') return target?.type === 'join' && paintEvent(target.eventId, target.title);
    return false;
  },

  /** Learn to paint's next date, in the next 120 days (an event date, with its end and capacity), or null. No awaits. */
  paintClass(rules = this.rulesCache, now = Date.now()) {
    if (!rules) return null;
    return eventOccurrences(rules, now, now + 120 * 24 * 3_600_000)
      .filter((o) => o.start > now && paintEvent(o.eventId, o.title))
      .sort((a, b) => a.start - b.start)[0] || null;
  },

  /**
   * The next class a gift of this kind is for (paint: Learn to paint's next date), as My Lair shows it: { occurrenceId,
   * title, start, full }, or null. No awaits.
   */
  nextGiftClass(kind, rules = this.rulesCache, now = Date.now()) {
    const o = kind === 'paint' ? this.paintClass(rules, now) : null;
    if (!o) return null;
    const taken = o.capacity
      ? this.sql.exec("SELECT COALESCE(SUM(people), 0) AS n FROM event_joins WHERE occurrence_id = ? AND status != 'cancelled'", o.id).one().n
      : 0;
    return { occurrenceId: o.id, title: o.title, start: o.start, full: Boolean(o.capacity && taken >= o.capacity) };
  },

  /** An event date in words: "Thursday 3 December, 6 to 8pm" (Lair time). No awaits. */
  classWhen(o, rules = this.rulesCache) {
    const tz = rules?.tz || 'Pacific/Auckland';
    const day = new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(o.start)).replace(',', '');
    const time = new LairTime(tz);
    const clock = (ms) => {
      const m = time.minutesOf(ms);
      return { h: Math.floor(m / 60) % 12 || 12, mi: m % 60, pm: m >= 720 };
    };
    const fmt = (c, suffix) => `${c.h}${c.mi ? `:${String(c.mi).padStart(2, '0')}` : ''}${suffix ? (c.pm ? 'pm' : 'am') : ''}`;
    const a = clock(o.start);
    if (!(o.end > o.start)) return `${day}, ${fmt(a, true)}`;
    const b = clock(o.end);
    return `${day}, ${fmt(a, a.pm !== b.pm)} to ${fmt(b, true)}`;
  },

  /**
   * "Your gift is ready" (mockup GiftEmail, approved 6 Nov 2026): every code just made on an order with an experience gift
   * on it, each in its box with its name, what it covers and its use-by; how to use them once, then each kind's rows; one
   * kind's button (several: My Lair's); the promise if prices go up. With no email on the order, or when the email
   * fails, the staff get the codes to pass on. gifts: [{ code, kind, sessions, expiresAt }]. No awaits (the email goes
   * out afterwards).
   */
  sendExperienceGifts(gifts, giver, { orderName, rules }) {
    if (!emailReady(this.env) || !gifts.length) return;
    const tz = rules?.tz || 'Pacific/Auckland';
    const many = gifts.length > 1;
    const kinds = [...new Set(gifts.map((g) => g.kind).filter((k) => GIFT_KINDS[k]))];
    const next = kinds.includes('paint') ? this.paintClass(rules) : null;
    const codes = gifts.map((g) => {
      const k = GIFT_KINDS[g.kind];
      return {
        code: g.code,
        label: (k ? k.name : `${g.sessions} ${g.sessions === 1 ? 'session' : 'sessions'} at the Lair`).toUpperCase(),
        lines: [k ? k.covers : GIFT_WORDS.sessions(g.sessions)],
        strong: g.expiresAt ? GIFT_WORDS.useBy(giftDay(g.expiresAt, tz)) : null,
      };
    });
    const details = [['How to use it', HOW_TO]];
    for (const kind of kinds) {
      if (kind === 'paint') details.push(['Learn to paint', next ? GIFT_WORDS.nextClass(this.classWhen(next, rules), next.capacity) : GIFT_WORDS.noClass]);
      details.push(...GIFT_KINDS[kind].details);
    }
    const one = kinds.length === 1 && gifts.every((g) => g.kind === kinds[0]) ? GIFT_KINDS[kinds[0]] : null;
    let button;
    if (!one) button = { label: GIFT_WORDS.openMyLair, url: this.page('myLair') };
    else if (one === GIFT_KINDS.paint) {
      button = next ? { label: one.button, url: `${this.page('events')}#event=${encodeURIComponent(next.id)}` } : { label: GIFT_WORDS.seeWhatsOn, url: this.page('events') };
    } else button = { label: one.button, url: this.page(one.page) };
    const outro = one ? one.honoured : GIFT_WORDS.honouredAll;
    const toStaff = (why) => this.notifyStaff(GIFT_WORDS.staffSubject(orderName), {
      title: GIFT_WORDS.staffTitle, intro: [why, GIFT_WORDS.giveThem(many, orderName)], codes, details: [['How to use it', HOW_TO]],
    });
    const email = String(giver?.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toStaff(GIFT_WORDS.noEmail(many));
      return;
    }
    this.later((async () => {
      const sent = await this.mail(this.letter(email, GIFT_WORDS.subject(many), {
        title: GIFT_WORDS.subject(many),
        intro: [GIFT_WORDS.hello(giver.firstName, many), GIFT_WORDS.passOn(many)],
        codes, details, button, outro,
      }));
      if (!sent.ok) toStaff(GIFT_WORDS.bounced(orderName, email, sent.message || 'the email failed'));
    })());
  },

  /**
   * POST /passes/:id/use { note? } (staff with Check-in or Money): "Use it now": a gift used for its experience with
   * nothing booked (a kid at the kids' table, rung up at the counter). One go: a gift that's used, void or past its
   * use-by is refused (409); a session pass is used at check-in instead (422). The use keeps who did it and their note;
   * undo (POST /passes/uses/:id/undo) puts it back. Returns { pass, message }.
   */
  async useGiftNow(id, input, who) {
    this.requireStaff(who, ['checkin', 'money']);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const p = this.passRow(id);
    if (!p) throw new RuleError('That pass could not be found.', 404);
    if (!GIFT_KINDS[p.kind]) throw new RuleError(GIFT_WORDS.onlyGifts, 422);
    const status = this.passStatus(p, now);
    if (status === 'void') throw new RuleError(GIFT_WORDS.void, 409);
    if (status === 'expired') throw new RuleError(GIFT_WORDS.expired(giftDay(p.expiresAt, rules.tz)), 409);
    if (status === 'used') throw new RuleError(GIFT_WORDS.used, 409);
    const note = String(input?.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    this.write(
      "INSERT INTO pass_uses (id, pass_id, booking_id, people, covered, at, by, undone_at, join_id, note) VALUES (?, ?, '', 1, 0, ?, ?, NULL, NULL, ?)",
      makeId('pu'), p.id, now, by, note,
    );
    this.write('UPDATE passes SET sessions_used = sessions_used + 1 WHERE id = ? AND sessions_used < sessions_total', p.id);
    return { pass: this.passView(this.passRow(p.id), { now }), message: GIFT_WORDS.usedNow(p.kind) };
  },
};

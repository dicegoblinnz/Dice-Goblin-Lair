// Round 32, the till, part 2: real people on the till (contract docs/contracts/lair-api-contract-v32-till.md, section 5).
//
// Mo (6 Nov 2026): the counter faces customers, "people just scan their code and immediately start using it", and staff
// sign in to sort things out. So:
//  - POST /till/scan: any code at the counter, from the tablet's staff account with nobody signed in. A member's code is
//    their own screen: what they owe today and from before, each with the very line the counter tile puts in the cart
//    (posLine, so paying it marks it paid in part 3), their loyalty card, store credit, passes and games at home. The
//    customer screen gets a first name and initial, never an email. A booking's code alone is just that booking and a
//    first name (whoever holds a ticket isn't always its booker). Codes Gobgob doesn't know are counted per tablet: 20 in
//    10 minutes and that tablet waits, so nobody guesses codes at the counter.
//  - Staff on the till (a till token from their own PIN) with Check-in, or the owner: a booking's code opens its account
//    holder; find people by name (POST /till/find), open one by ID (POST /till/person), and tonight's list with the event
//    that's on as the night (POST /till/tonight).
// Paying for any of it is part 3: nothing here changes a booking.
import { RuleError } from './core.js';

/** Unknown codes from one tablet before it waits, and over how long */
export const TILL_SCAN_MISSES = 20;
export const TILL_SCAN_WINDOW_MS = 10 * 60 * 1000;
/** How long a store credit balance from Shopify is kept */
const TILL_CREDIT_MS = 60 * 1000;
/** How early an event becomes the till's night: 90 minutes before it starts */
const TILL_NIGHT_AHEAD_MS = 90 * 60 * 1000;
/** A row with one of these statuses has nothing to pay at the till */
export const TILL_UNPAYABLE = ['noshow', 'cancelled', 'held'];
/** Rows that put a stamp on the account holder's card once paid (round 22) */
const STAMP_KINDS = ['table', 'walkin', 'gm-seat', 'join'];

export const TILL_PEOPLE_WORDS = {
  unknown: "Gobgob doesn't know that code. Try your member code from My Lair.",
  tooMany: "Too many codes Gobgob didn't know. Ask staff for a hand.",
  checkinOnly: 'Finding people is for staff with Check-in.',
  noMember: 'No member with that customer ID.',
  search: 'Type at least 2 letters to search.',
};

const money = (cents) => `$${(Math.round(Number(cents) || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const maskEmail = (email) => {
  const [name, domain] = String(email || '').trim().split('@');
  return name && domain ? `${name[0]}•••@${domain}` : '';
};

export const tillPeopleMethods = {
  /** A tablet's unknown codes: a 429 once it's had TILL_SCAN_MISSES in the window. No awaits. */
  tillScanGuard(key, now) {
    const misses = (this.tillMisses?.get(key) || []).filter((t) => now - t < TILL_SCAN_WINDOW_MS);
    if (misses.length >= TILL_SCAN_MISSES) throw new RuleError(TILL_PEOPLE_WORDS.tooMany, 429);
  },

  /** One more unknown code from a tablet: the 20th is a 429 at once. No awaits. */
  tillScanMiss(key, now) {
    if (!this.tillMisses || this.tillMisses.size > 500) this.tillMisses = new Map();
    const misses = (this.tillMisses.get(key) || []).filter((t) => now - t < TILL_SCAN_WINDOW_MS);
    misses.push(now);
    this.tillMisses.set(key, misses);
    if (misses.length >= TILL_SCAN_MISSES) throw new RuleError(TILL_PEOPLE_WORDS.tooMany, 429);
  },

  /** A member's store credit in cents, from Shopify, kept a minute; null when Shopify can't say */
  async tillCredit(customerId) {
    const id = String(customerId || '');
    if (!/^\d{1,20}$/.test(id) || !this.shopify?.configured) return null;
    if (!this.tillCredits || this.tillCredits.size > 500) this.tillCredits = new Map();
    const kept = this.tillCredits.get(id);
    if (kept && Date.now() - kept.at < TILL_CREDIT_MS) return kept.cents;
    try {
      const cents = Math.max(0, Math.round(Number(await this.shopify.storeCreditBalance(id, this.env.CURRENCY || 'NZD')) || 0));
      this.tillCredits.set(id, { at: Date.now(), cents });
      return cents;
    } catch (error) {
      console.error('Lair: the till could not ask Shopify for store credit', error);
      return null;
    }
  },

  /** Staff on the till with their own PIN who may find people: the owner, or Check-in. No awaits. */
  tillStaffOn(tokenHash, team) {
    const me = this.tillOn(tokenHash, team);
    if (me.role !== 'owner' && !me.perms.includes('checkin')) throw new RuleError(TILL_PEOPLE_WORDS.checkinOnly, 403);
    return me;
  },

  /** What a row is, for the basket's second line: "Event entry · MT-OWLBEAR-17", "Owed from Thu 1 Oct · …". No awaits. */
  tillRowWords(r, rules) {
    let what;
    if (r.type === 'join') what = 'Event entry';
    else if (r.kind === 'gm-seat') what = 'GM seat';
    else if (r.kind === 'gm-cover') what = "A player's seat";
    else if (r.playerOf) what = 'Your share of a game';
    else if (r.occurrenceId) what = 'Game spot';
    else if (r.kind === 'tab') what = 'Tab';
    else what = `Table fee · ${[...(r.tables || [])].join(', ')}, ${plural(r.people || 1, 'person', 'people')}`;
    const parts = [r.owed ? `Owed from ${this.shortDay(r.start, rules)}` : what, r.ref];
    if (r.covered > 0 && !r.owed) parts.push(`a pass covered ${money(r.covered)}`);
    return parts.filter(Boolean).join(' · ');
  },

  /**
   * A row as the till shows it: { code, title, at, kind, paid, owed, onAccount, status, paying?, lines: [{ title, sub,
   * price, session, line }] }. Nothing to pay for a no-show (staff settle those), a cancelled booking, or one held for
   * paying online (its checkout is still open): a booking's code reaches here without memberToday's own filter (the
   * review). Part 3: nor for one a paid till sale is paying while its Shopify order is made (pending: tillPendingRefs),
   * shown as paid with paying: true, so nobody pays it twice.
   */
  tillRowView(r, rules, pending = null) {
    const paying = Boolean(r.ref && pending?.has(String(r.ref).toUpperCase()) && r.due > 0);
    const payable = r.due > 0 && !TILL_UNPAYABLE.includes(r.status) && !paying;
    return {
      code: r.ref || '', title: r.title || 'Booking', at: r.start ?? null, kind: r.kind || r.type, paid: !(r.due > 0) || paying, owed: Boolean(r.owed),
      onAccount: Boolean(r.onAccount), status: r.status || null, ...(paying ? { paying: true } : {}),
      lines: payable
        ? [{ title: r.title || 'Booking', sub: this.tillRowWords(r, rules), price: r.due, session: STAMP_KINDS.includes(r.kind), line: r.line || this.posLine(r, rules) }]
        : [],
    };
  },

  /**
   * A member as the till shows them (null when there's no such member): today's rows and what they owe from before
   * (as /pos/scan lists them), their card, passes, games at home, today's self-serve tab and their account. staff: the
   * full name and a masked email; the customer screen gets "Mia T." and no email. credit is added by the caller. No awaits.
   */
  tillMemberView(customerId, rules, now, { staff = false } = {}) {
    const id = String(customerId);
    // (part 3: the same rows a sale pays from, src/till-sales.js)
    const { member, rows } = this.tillRowsOf(id, rules, now);
    if (!member) return null;
    const pending = this.tillPendingRefs(now);
    const full = String(member.name || member.first_name || '').trim();
    const first = member.first_name || full.split(/\s+/)[0] || 'friend';
    const rest = full.split(/\s+/).slice(1);
    const since = member.created_at
      ? new Intl.DateTimeFormat('en-NZ', { timeZone: rules?.tz || 'Pacific/Auckland', month: 'long', year: 'numeric' }).format(new Date(member.created_at))
      : '';
    const tab = this.tabView(this.todayTabRow(id, rules, now));
    return {
      id, first, name: staff ? full || first : `${first}${rest.length ? ` ${rest[rest.length - 1][0].toUpperCase()}.` : ''}`, code: member.code || '', since,
      ...(staff ? { email: maskEmail(member.email) } : {}),
      loyalty: this.staffCard(id, rules),
      passes: this.activePasses(id, now).map((p) => ({ label: p.label, left: Math.max(0, (p.sessionsTotal || 0) - (p.sessionsUsed || 0)) })),
      library: this.loansOut(id).map((l) => ({ name: l.title || l.name || 'A library game' })),
      bookings: rows.map((r) => this.tillRowView(r, rules, pending)),
      tab: tab && tab.status !== 'paid' ? tab : null,
      account: this.accountSummary(id, rules, now),
    };
  },

  /**
   * POST /till/scan { code, token? }: a code at the counter (contract section 5). A member's code → { type: 'person',
   * person }; a booking's or sign-up's → { type: 'booking', booking, name } (a first name only), or with staff on the till
   * and an account holder → { type: 'person', person, focus: its code }; a pass → { type: 'pass', pass: { label, left } }.
   * Unknown: a 404, and the tablet's 20th in 10 minutes a 429.
   */
  async tillScan(body, who, client = '') {
    this.tillGate(who);
    const code = String(body?.code ?? '').trim().slice(0, 60);
    const key = `${who.customerId}|${client}`;
    const tokenHash = body?.token ? await this.tillTokenHash(body.token) : null;
    const tagged = tokenHash ? await this.tillTagged() : null;
    const rules = await this.rules();
    // staff on the till are checked before anything is looked up; a tablet with nobody on it can be made to wait
    if (tokenHash) this.tillStaffOn(tokenHash, this.tillTeamFrom(who, tagged));
    else this.tillScanGuard(key, Date.now());
    // the store credit to show is asked for first: a member's, or with staff on the till, a booking's account holder's
    const first = code ? this.findCode(code) : null;
    const holder = first?.type === 'member' ? first.item.customer_id : tokenHash && ['booking', 'join'].includes(first?.type) ? first.item.customerId : null;
    const credit = holder && this.memberRow(holder) ? await this.tillCredit(holder) : null;
    // --- no awaits from here on ---
    const now = Date.now();
    const found = code ? this.findCode(code) : null;
    if (!found) {
      if (!tokenHash) this.tillScanMiss(key, now);
      throw new RuleError(TILL_PEOPLE_WORDS.unknown, 404);
    }
    if (found.type === 'pass') {
      const p = found.item;
      return { type: 'pass', pass: { label: p.label, left: Math.max(0, (p.sessionsTotal || 0) - (p.sessionsUsed || 0)) } };
    }
    if (found.type === 'member') {
      const person = this.tillMemberView(found.item.customer_id, rules, now, { staff: Boolean(tokenHash) });
      if (!person) throw new RuleError(TILL_PEOPLE_WORDS.unknown, 404);
      return { type: 'person', person: { ...person, credit } };
    }
    const row = found.type === 'join' ? this.joinRow(found.item, { now }) : this.bookingRow(found.item, rules, { now });
    if (tokenHash && row.customerId) {
      const person = this.tillMemberView(row.customerId, rules, now, { staff: true });
      if (person) return { type: 'person', person: { ...person, credit }, focus: row.ref };
    }
    return { type: 'booking', booking: this.tillRowView(row, rules, this.tillPendingRefs(now)), name: String(row.name || '').trim().split(/\s+/)[0] || 'friend' };
  },

  /** POST /till/find { token, q } (staff on the till with Check-in): members by name, email or code → { people: [{ id, name, code }] } */
  async tillFind(body, who) {
    this.tillGate(who);
    const tokenHash = await this.tillTokenHash(body?.token);
    const tagged = await this.tillTagged();
    // --- no awaits from here on ---
    this.tillStaffOn(tokenHash, this.tillTeamFrom(who, tagged));
    const q = String(body?.q ?? '').trim().slice(0, 80);
    if (q.length < 2) throw new RuleError(TILL_PEOPLE_WORDS.search, 400);
    return { people: this.matchMembers(q, 12).map((m) => ({ id: String(m.customer_id), name: m.name || m.first_name || '', code: m.code || '' })) };
  },

  /** POST /till/person { token, id } (staff on the till with Check-in): a member by customer ID → { type: 'person', person } */
  async tillPerson(body, who) {
    this.tillGate(who);
    const tokenHash = await this.tillTokenHash(body?.token);
    const tagged = await this.tillTagged();
    this.tillStaffOn(tokenHash, this.tillTeamFrom(who, tagged));
    const id = String(body?.id ?? '');
    if (!/^\d{1,20}$/.test(id) || !this.memberRow(id)) throw new RuleError(TILL_PEOPLE_WORDS.noMember, 404);
    const rules = await this.rules();
    const credit = await this.tillCredit(id);
    // --- no awaits from here on ---
    const person = this.tillMemberView(id, rules, Date.now(), { staff: true });
    if (!person) throw new RuleError(TILL_PEOPLE_WORDS.noMember, 404);
    return { type: 'person', person: { ...person, credit } };
  },

  /**
   * POST /till/tonight { token } (staff on the till with Check-in): today's people (as the counter tile's Today list has
   * them) → { rows: [{ ref, personId, name, what, kind, at, due, paid, status }], night }, night being the event on now or
   * starting within 90 minutes (the soonest), with its rows, or null.
   */
  async tillTonight(body, who) {
    this.tillGate(who);
    const tokenHash = await this.tillTokenHash(body?.token);
    const tagged = await this.tillTagged();
    this.tillStaffOn(tokenHash, this.tillTeamFrom(who, tagged));
    const today = await this.posToday();
    // --- no awaits from here on ---
    const now = Date.now();
    // (part 3: one a paid till sale is paying shows as paid)
    const pending = this.tillPendingRefs(now);
    const rowOf = (g, r) => ({
      ref: r.ref, personId: r.customerId ? String(r.customerId) : null, name: r.name || '', what: g.kind === 'tables' ? 'Table booking' : g.title.replace(/ · GM .*$/, ''),
      kind: r.kind || r.type, at: r.start, due: r.due, paid: !(r.due > 0) || Boolean(r.ref && pending.has(String(r.ref).toUpperCase())), status: r.status,
    });
    const rows = today.groups.flatMap((g) => g.rows.map((r) => rowOf(g, r))).sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
    const events = today.groups.filter((g) => g.kind === 'event' && g.end > now && g.start - now <= TILL_NIGHT_AHEAD_MS).sort((a, b) => a.start - b.start);
    const night = events[0] ? { title: events[0].title, at: events[0].start, rows: events[0].rows.map((r) => rowOf(events[0], r)) } : null;
    return { rows, night };
  },
};

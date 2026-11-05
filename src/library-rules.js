/**
 * Round 30 (6 Nov 2026, contract v30-library): two library rules from Mo (2 Nov 2026).
 *
 * Members free. An event marked "Free for library members" (lair_event member_free, Board Game Night from 11 Nov 2026)
 * lets library members in free; everyone else pays the usual entry at the counter. A library member is someone whose
 * library plan lets them borrow today (planOf, as the library's scan reads it: an active Grab, Stash or Hoard, or one
 * cancelled but inside the month they paid for). A membership whose last payment didn't go through has borrowing
 * paused (planOf's blocked), so it doesn't get them in free either.
 *
 * Games that stay in the Lair. A library game tagged In Store Only in Shopify (handle in-store-only, the theme's rule)
 * is played at a table here and never goes home: not by a member's scan, not lent by staff, not posted, and a hold on
 * one is collected for a table without a loan.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { RuleError, findOccurrence } from './core.js';

/** What Shopify said about a game's In Store Only tag counts this long: the copies lookup's 10 minutes (COPIES_TTL) */
const IN_STORE_TTL = 10 * 60_000;

/**
 * The column made sure of on every start (lair.js's migrate): event_joins.member_free, 1 when the account holder's own
 * place on a sign-up is free because they're a library member (the price it says is everyone else's on it)
 */
export const MEMBER_FREE_COLUMNS = [['event_joins', 'member_free', 'INTEGER NOT NULL DEFAULT 0']];

/** What staff see about a members-free event's entry, word for word in the contract */
export const LIBRARY_ENTRY_WORDS = {
  /** a library member, on their own */
  free: 'Library member: free entry.',
  /** a library member with others on their sign-up, who pay */
  freeOwn: "Library member: their own entry's free.",
  /** a membership whose last payment didn't go through: borrowing's paused, so entry isn't free */
  blocked: "Their last library payment didn't go through, so entry isn't free today.",
  /** the same while their bank wants them to confirm it */
  bankCheck: "Their last library payment is waiting on their bank's check, so entry isn't free today.",
};

/** What's said when a game that stays in the Lair would go home, word for word in the contract */
export const IN_STORE_WORDS = {
  /** a member scanning it in My Library (an error: plain, no "friend") */
  scan: (title) => `${title} stays in the Lair, so it can't go home. Play it at your table instead.`,
  /** the same, when it's on hold for them */
  scanHeld: (title) => `${title} stays in the Lair, so it can't go home. It's on hold for you: collect it at the counter and play it at your table.`,
  /** staff lending it or checking it out at the desk */
  lend: (title) => `${title} stays in the Lair: it can't be lent. It's for playing at a table here.`,
  /** the same, when the member has it on hold (name: their first name, or none) */
  lendHeld: (title, name) => `${title} stays in the Lair: it can't be lent. ${name ? `${name} has` : 'They have'} it on hold: mark the hold Collected when you hand it over for a table.`,
  /** staff marking a hold on it collected: it's played here, so nothing goes home */
  collected: (title) => `${title} stays in the Lair: the hold's collected for a table, and nothing goes home.`,
  /** staff packing or sending a postal swap of it */
  post: (title) => `${title} stays in the Lair, so it can't be posted. Cancel this swap and refund any postage.`,
  /** anything else that would make it a loan */
  home: (title) => `${title} stays in the Lair, so it can't go home.`,
};

export const libraryRuleMethods = {
  /* ---------------- free for library members ---------------- */

  /**
   * Whether someone gets in free at an event that's free for library members: their library plan lets them borrow today
   * (planOf, as the library's scan and checkPlanOpen read it). → { free, plan }: plan is planOf's (null without one; a
   * blocked one says why it isn't free). tags: their Shopify tags when the caller has them, else the last ones the Lair
   * saw (queueTags); they only count while Simplee's tags do (MEMBERSHIPS_SIMPLEE_TAGS isn't off). No awaits.
   */
  libraryEntry(customerId, tags = null, now = Date.now()) {
    const id = customerId == null ? '' : String(customerId).trim();
    if (!/^\d{1,20}$/.test(id)) return { free: false, plan: null };
    const plan = this.planOf(id, tags ?? this.queueTags(id), now);
    return { free: Boolean(plan && !plan.blocked), plan };
  },

  /** An event date that lets library members in free, with an entry fee to let them off. No awaits. */
  memberFreeDate(o) {
    return Boolean(o?.memberFree && (o.entryFee || 0) > 0);
  },

  /**
   * What staff are told about a members-free entry (libraryEntry's): free (on their own, or with others on it who pay),
   * not free because borrowing's paused (a payment that failed, or one waiting on the bank's check), or nothing. No awaits.
   */
  entryWords(entry, { others = false } = {}) {
    if (entry?.free) return others ? LIBRARY_ENTRY_WORDS.freeOwn : LIBRARY_ENTRY_WORDS.free;
    if (entry?.plan?.blocked) return entry.plan.bankCheck ? LIBRARY_ENTRY_WORDS.bankCheck : LIBRARY_ENTRY_WORDS.blocked;
    return '';
  },

  /**
   * A sign-up checked in at an event free for library members (checkInJoin, and staff marking it here on the floor):
   * entry is paid at the counter, so it's priced for who the account holder is today. Joined the library since signing
   * up, their own place comes off; their payment failed since, it goes back on; their guests pay either way. Only while
   * nothing's been paid, marked paid or waived on it: one that's settled stays as it is, for staff to sort out.
   * → { join (fresh), words (for the check-in's message) }. No awaits.
   */
  memberEntryAtDoor(join, rules, now = Date.now()) {
    const o = join?.occurrenceId && rules ? findOccurrence(rules, join.occurrenceId) : null;
    if (!this.memberFreeDate(o) || !join.customerId) return { join, words: '' };
    if (join.paid || (join.paidAmount || 0) > 0 || join.waived) return { join, words: '' };
    const entry = this.libraryEntry(join.customerId, null, now);
    const words = this.entryWords(entry, { others: (join.people || 1) > 1 });
    if (entry.free === Boolean(join.memberFree)) return { join, words };
    // a paying place costs what it did when they signed up (the event's entry now, when theirs was the only place)
    const paying = Math.max(0, (join.people || 1) - (join.memberFree ? 1 : 0));
    const unit = paying > 0 ? Math.round((join.amount || 0) / paying) : o.entryFee;
    const amount = Math.max(0, (join.amount || 0) + (entry.free ? -unit : unit));
    this.write(
      'UPDATE event_joins SET amount = ?, member_free = ?, updated_at = ? WHERE id = ? AND paid = 0 AND COALESCE(paid_amount, 0) = 0',
      amount, entry.free ? 1 : 0, now, join.id,
    );
    // a bill with this sign-up on it stays true, as when staff change one
    this.reconcileBills(rules, now);
    return { join: this.joinById(join.id), words };
  },

  /* ---------------- games that stay in the Lair ---------------- */

  /** Keep what Shopify just said about a variant's In Store Only tag (true or false; anything else isn't an answer). No awaits. */
  noteInStore(variantId, inStoreOnly, at = Date.now()) {
    if (!variantId || typeof inStoreOnly !== 'boolean') return;
    this.inStoreSeen = this.inStoreSeen || new Map();
    if (this.inStoreSeen.size > 2000) this.inStoreSeen.clear();
    this.inStoreSeen.set(String(variantId), { at, inStoreOnly });
  },

  /**
   * Whether a library game ({ variantId, productId }) stays in the Lair: what Shopify said in the last 10 minutes (the
   * scan's own lookups: noteInStore), else the catalogue's copy of its tags (pick_catalog.in_store_only, synced from
   * Shopify every 10 minutes, src/pick.js). Neither knowing the game, it isn't one. No awaits.
   */
  staysInLair(game, now = Date.now()) {
    const variantId = String(game?.variantId ?? '').trim();
    const seen = variantId ? this.inStoreSeen?.get(variantId) : null;
    if (seen && now - seen.at < IN_STORE_TTL) return seen.inStoreOnly;
    const productId = String(game?.productId ?? '').trim();
    const row = (variantId && this.sql.exec("SELECT in_store_only FROM pick_catalog WHERE variant_id = ? ORDER BY status = 'active' DESC LIMIT 1", variantId).toArray()[0])
      || (productId && this.sql.exec('SELECT in_store_only FROM pick_catalog WHERE product_id = ?', productId).toArray()[0])
      || null;
    return Boolean(row?.in_store_only);
  },

  /** The last word on a loan (makeLoan, collectHold): a game that stays in the Lair never goes home (422). No awaits. */
  refuseGoingHome(game, words = IN_STORE_WORDS.home) {
    if (this.staysInLair(game)) throw new RuleError(words(game?.title || 'That game'), 422);
  },

  /**
   * Staff marked a hold on a game that stays in the Lair collected: it's handed over for a table, so the hold ends
   * collected with no loan, and a queue row for it (from before the tag) is done. No awaits.
   */
  collectedForTable(hold, now = Date.now()) {
    if (hold.status !== 'collected') this.write("UPDATE library_holds SET status = 'collected', ended_at = ?, updated_at = ? WHERE id = ?", now, now, hold.id);
    this.write("UPDATE library_queue SET status = 'done', updated_at = ? WHERE hold_id = ? AND status IN ('held', 'queued')", now, hold.id);
  },
};

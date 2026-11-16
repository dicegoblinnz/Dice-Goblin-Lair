/**
 * Round 41, quests (16 Nov 2026, contract v41-quests). Mo: "I want to build a quest for my customers to help them get
 * more stamps we can do a daily quest say 3 of them that refreshes daily a weekly quest maybe another 3 weekly and a one
 * time quest etc. and have them be exciting for customers to explore". The pool was settled with him the same evening:
 * a stamp for every Dice Goblin die bought ("Gw dice don't count but all of my dice especially the ones with buy 2 get 3
 * free you get a stamp per dice bought", online too), a stamp for joining the library and every month it renews, three
 * daily bounties ($6 or more on drinks, snacks or ice cream in one sale; a golden one a week pays double), weekly quests
 * (Gobgob's riddle every week, and two of Full house, Lair dweller, Bounty hunter (5) and Clean sweep), one-off quests in
 * chapters, secret quests, bring a friend (a stamp each), and GMs' stamps for new players.
 *
 * How it hangs together:
 *  - Facts (quest_facts): what the Lair sees that it doesn't keep anywhere else: dice bought, a sale's drinks, snacks and
 *    ice cream, each product line, a late counter sale, a code scanned at the counter, a library bill paid, a box
 *    scanned to play here, the d20 picker's game. One row a fact, unique by key; a refund undoes a fact, never deletes it.
 *  - The quests themselves are worked out (questEarned) from those facts and what the Lair already keeps: stamped
 *    sessions (stampTally), library loans, loyalty rolls, Library discovery's picks, invite codes and riddles.
 *  - questSync makes the stamp ledger (loyalty_stamps, kind 'quest') match: new stamps in, stamps whose reason went
 *    (undone_by 'quest') out. A quest stamp staff took back by hand stays out. The card counts quest stamps like any
 *    ledger stamp, so every page that shows a card has them.
 *  - Everything is off until the live theme says so (Theme settings › Lair bookings › lair_quests), like order rolls:
 *    the Lair can go live first, and with it off nothing here asks Shopify or writes anything.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { LairTime, RuleError, addDays, makeId } from './core.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const QUESTS_CONFIG = Object.freeze({
  // a daily bounty: this much (cents, after discounts) of one kind in one sale
  bountyCents: 600,
  // the golden bounty pays this many
  goldenStamps: 2,
  // Bounty hunter: this many bounties in a week (Mo: "Bounty hunter down to 5")
  hunterBounties: 5,
  // Lair dweller: this many stamped sessions in a week
  dwellerSessions: 3,
  // Full house: a table they booked for at least this many
  fullHouse: 3,
  // the most dice stamps one order line gives (a mistyped quantity can't fill cards)
  dicePerLine: 30,
  // the riddle is out from this time on its Monday (minutes after midnight, Lair time)
  riddleOutMinutes: 10 * 60,
  // Last one out: a counter sale paid from 11:30pm until 4am
  lateFrom: 23 * 60 + 30,
  lateUntil: 4 * 60,
  // Fresh blood: a product listed this many days before it was bought
  freshDays: 30,
  // Rolled it: the d20 picker's game bought within this many days
  rolledDays: 7,
  // Ask Gobgob: one of Library discovery's picks played, borrowed or bought within this many days
  askDays: 14,
  // a member's quests are worked out again at most this often (GET /me and GET /me/quests)
  syncEvery: MIN,
  // what Shopify says about a product is kept this long
  productMs: DAY,
  // refunds: orders with facts from this far back are asked about, each this often
  refundDays: 60,
  refundEvery: 30 * MIN,
  // the d20 picker's games remembered for a member, a day
  rolledDaily: 10,
  // Playing it here: scans kept a member a day (the rest are answered but not kept)
  playScansDaily: 30,
  // Playing it here: at most this many different games a day count, and only on a day they were in the Lair
  playsDaily: 5,
  // a riddle's words
  riddleChars: 400,
  hintChars: 200,
});

/** The product types the daily bounties count */
export const BOUNTY_TYPES = Object.freeze({ Drinks: 'drink', Snacks: 'snack', 'Ice Cream': 'icecream' });
export const BOUNTIES = ['drink', 'snack', 'icecream'];

/** The four weekly quests the Lair picks two of each week; the riddle is every week */
export const WEEKLY_POOL = ['full-house', 'lair-dweller', 'bounty-hunter', 'clean-sweep'];

/** Every quest, in the order My Lair lists them. on: false for one whose feature isn't built yet. */
export const QUEST_LIST = Object.freeze([
  { id: 'dice', layer: 'always', name: 'Dice for the hoard', how: 'A stamp for every die or set of our dice you buy, online or in the Lair.' },
  { id: 'library', layer: 'always', name: 'Library member', how: 'A stamp when you join the library, and another every month it renews.' },
  { id: 'bounty-drink', layer: 'daily', name: 'Thirsty work', how: '$6 or more on Tavern drinks in one go.' },
  { id: 'bounty-snack', layer: 'daily', name: 'Snack tax', how: '$6 or more on snacks in one go.' },
  { id: 'bounty-icecream', layer: 'daily', name: 'Brain freeze', how: '$6 or more on ice cream in one go.' },
  { id: 'riddle', layer: 'weekly', name: "Gobgob's riddle", how: "Solve this week's riddle: find the game and scan its box in My Lair." },
  { id: 'full-house', layer: 'weekly', name: 'Full house', how: 'Book a table for 3 or more and play it.' },
  { id: 'lair-dweller', layer: 'weekly', name: 'Lair dweller', how: '3 paid sessions this week.' },
  { id: 'bounty-hunter', layer: 'weekly', name: 'Bounty hunter', how: '5 bounties this week.' },
  { id: 'clean-sweep', layer: 'weekly', name: 'Clean sweep', how: 'All 3 bounties in one day.' },
  { id: 'first-scan', layer: 'once', chapter: 'wanderer', name: 'Show your face', how: 'Scan your Goblin card at the counter.' },
  { id: 'first-ttrpg', layer: 'once', chapter: 'wanderer', name: 'Take a seat', how: 'Play your first TTRPG session.' },
  { id: 'first-warhammer', layer: 'once', chapter: 'wanderer', name: 'Dice down', how: 'Play your first Warhammer game.' },
  { id: 'first-card-night', layer: 'once', chapter: 'wanderer', name: 'Card night', how: 'Come to your first card night.' },
  { id: 'first-table', layer: 'once', chapter: 'wanderer', name: 'Pull up a chair', how: 'Book your first table and play.' },
  { id: 'first-paint', layer: 'once', chapter: 'wanderer', name: 'Paint it', how: 'Your first paint session.' },
  { id: 'first-gm', layer: 'once', chapter: 'storyteller', name: 'Behind the screen', how: 'Run your first game as GM.' },
  { id: 'three-systems', layer: 'once', chapter: 'storyteller', name: 'Rules lawyer', how: 'Play 3 different TTRPG systems.' },
  { id: 'three-gms', layer: 'once', chapter: 'storyteller', name: 'Table hopper', how: "Play at 3 different GMs' tables." },
  { id: 'weekly-seat', layer: 'once', chapter: 'storyteller', name: 'Saved seat', how: 'Save a weekly seat and play 4 of its sessions.' },
  { id: 'first-borrow', layer: 'once', chapter: 'librarian', name: 'Take one home', how: 'Borrow your first library game.' },
  { id: 'ten-games', layer: 'once', chapter: 'librarian', name: 'Shelf of ten', how: 'Pick up 10 different library games: borrow them, or scan them to play here.' },
  { id: 'four-weeks', layer: 'once', chapter: 'regular', name: 'Four in a row', how: 'Play in 4 weeks in a row.' },
  { id: 'eight-weeks', layer: 'once', chapter: 'regular', name: 'Eight in a row', how: 'Play in 8 weeks in a row.' },
  { id: 'demand', layer: 'once', chapter: 'regular', name: 'Wish list', how: "Tell us what you'd play.", on: false },
  { id: 'discord', layer: 'once', chapter: 'regular', name: 'Linked up', how: 'Link your Discord.', on: false },
  { id: 'fresh-blood', layer: 'secret', name: 'Fresh blood', how: 'Buy something new to the shop.' },
  { id: 'rolled-it', layer: 'secret', name: 'Rolled it', how: "Buy the game Gobgob's d20 rolled for you." },
  { id: 'ask-gobgob', layer: 'secret', name: 'Ask Gobgob', how: "Play, borrow or buy one of Library discovery's picks." },
  { id: 'fresh-pot', layer: 'secret', name: 'Fresh pot', how: 'Buy your first paint.' },
  { id: 'fancy-pants', layer: 'secret', name: 'Fancy pants', how: 'Play in the Fancy room.' },
  { id: 'first-table-gm', layer: 'secret', name: 'First table', how: "Play at a new GM's very first session." },
  { id: 'shelf-diver', layer: 'secret', name: 'Shelf diver', how: '3 different library games in one week.' },
  { id: 'treasure-hunter', layer: 'secret', name: 'Treasure hunter', how: "Solve 5 of Gobgob's riddles." },
  { id: 'hoarder', layer: 'secret', name: 'Hoarder', how: 'Pick up 100 different library games.', stamps: 10 },
  { id: 'nat-20', layer: 'secret', name: 'Natural 20', how: 'Roll a 20 on your loyalty roll.' },
  { id: 'nat-1', layer: 'secret', name: 'Natural 1', how: 'Gobgob feels bad. Have a stamp.' },
  { id: 'grand-tour', layer: 'secret', name: 'Grand tour', how: 'Play in every room of the Lair.' },
  { id: 'every-day', layer: 'secret', name: 'Every day of the week', how: 'Play on every day of the week.' },
  // Mo: "no need to mention it but that is the condition"
  { id: 'last-one-out', layer: 'secret', name: 'Last one out', how: 'Found it.' },
  { id: 'invite-friend', layer: 'invite', name: 'Brought by a friend', how: "Your friend's invite code, and your first paid session." },
  { id: 'invite-bring', layer: 'invite', name: 'Bring a friend', how: 'A friend used your invite code and played.' },
  { id: 'gm-new', layer: 'gm', name: 'A new player at your table', how: 'Their first TTRPG session was yours.' },
  { id: 'gm-back', layer: 'gm', name: 'They came back', how: 'A player you started came back to your table.' },
]);
export const QUESTS = Object.freeze(Object.fromEntries(QUEST_LIST.map((q) => [q.id, { stamps: 1, on: true, ...q }])));

export const CHAPTERS = Object.freeze([
  { id: 'wanderer', name: 'Wanderer' },
  { id: 'storyteller', name: 'Storyteller' },
  { id: 'librarian', name: 'Librarian' },
  { id: 'regular', name: 'Regular' },
]);

/** The first four riddles (Mo read and approved them, 16 Nov 2026), for the four weeks from the next Monday */
export const SEED_RIDDLES = Object.freeze([
  { text: "Four treasures, one sinking island, and the sea wants it back. Grab them together, then everyone to the helicopter. Gobgob can't swim.", hint: '3–4 player shelf, small boxes.', productId: '7498136846439', title: 'Forbidden Island', shelfCode: 'DGL34-S014' },
  { text: 'Gobgob was hired to tile a palace wall. Take your tiles from the plates, but leftovers land on the floor, and the floor costs points. Pretty. Ruthless.', hint: '3–4 player shelf, medium boxes.', productId: '7498131210343', title: 'Azul', shelfCode: 'DGL34-M007' },
  { text: "Say the words in order. When the card matches the word, slap. Last hand on the pile takes the lot. Gobgob's palm is still red.", hint: 'The 7+ shelf, small boxes.', productId: '7498145824871', title: 'Taco Cat Goat Cheese Pizza', shelfCode: 'DGL7+-S046' },
  { text: 'Gobgob mixed two mushrooms and grew a second nose. Here you test potions on your students, or yourself, and an app tells you what happened. Publish first, but be right.', hint: '3–4 player shelf, medium boxes.', productId: '7498130391143', title: 'Alchemists', shelfCode: 'DGL34-M002' },
]);

/** Every message a member or staff member can see, word for word in the contract */
export const QUEST_WORDS = Object.freeze({
  off: "Quests aren't open yet. Gobgob's still hiding the loot.",
  login: 'Log in to see your quests.',
  playing: (title) => `Enjoy ${title}! Gobgob's counted it.`,
  riddleSolved: (title) => `${title}! You solved Gobgob's riddle. That's a stamp.`,
  rolledProduct: 'Which game did the d20 land on?',
  rolledMany: "That's plenty of rolls for one day. Go play one!",
  inviteNotNew: 'Invite codes are for players new to Dice Goblin. Welcome back, friend!',
  inviteOnce: "You've used an invite code already. It's one each.",
  inviteOwn: "That's your own invite code. Send it to a friend!",
  inviteBack: "You brought them, so their code can't bring you too. Send yours to someone new!",
  inviteDone: (first) => `You're in, friend! Once you've played your first paid session, you and ${first || 'your friend'} each get a stamp.`,
  riddleWeek: 'Pick the Monday the riddle goes out.',
  riddleText: `Write the riddle: up to ${QUESTS_CONFIG.riddleChars} characters.`,
  riddleHint: `Keep the hint to ${QUESTS_CONFIG.hintChars} characters.`,
  riddleTaken: 'That week has a riddle already. Change that one, or pick another week.',
  riddleMissing: "That riddle isn't there any more.",
  riddleSolvedAlready: 'Someone has solved that riddle already, so it stays.',
});

export const QUEST_TABLES = [
  `CREATE TABLE IF NOT EXISTS quest_facts (
     id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, customer_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT, day TEXT, at INTEGER NOT NULL,
     amount INTEGER, product_id TEXT, variant_id TEXT, order_id TEXT, line_id TEXT, unit INTEGER, pos INTEGER NOT NULL DEFAULT 0,
     flags TEXT, checked_at INTEGER, undone_at INTEGER, created_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS quest_facts_customer ON quest_facts (customer_id, kind, at)',
  'CREATE INDEX IF NOT EXISTS quest_facts_order ON quest_facts (order_id) WHERE order_id IS NOT NULL',
  `CREATE TABLE IF NOT EXISTS quest_products (
     product_id TEXT PRIMARY KEY, type TEXT, vendor TEXT, title TEXT, listed_at INTEGER, dice INTEGER NOT NULL DEFAULT 0, checked_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS quest_weeks (
     week TEXT PRIMARY KEY, golden_day TEXT NOT NULL, golden_bounty TEXT NOT NULL, weeklies TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS quest_riddles (
     id TEXT PRIMARY KEY, week TEXT NOT NULL UNIQUE, text TEXT NOT NULL, hint TEXT, product_id TEXT NOT NULL, title TEXT NOT NULL,
     shelf_code TEXT, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER)`,
  'CREATE TABLE IF NOT EXISTS quest_invites (customer_id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS quest_invited (friend_id TEXT PRIMARY KEY, bringer_id TEXT NOT NULL, at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS quest_invited_bringer ON quest_invited (bringer_id)',
  // a quest stamp's own key, so it's in the ledger once
  'CREATE INDEX IF NOT EXISTS loyalty_stamps_quest ON loyalty_stamps (customer_id, kind)',
];

/* ---------------- pure helpers ---------------- */

/** A Shopify id (gid or number) as its number, or '' */
export const plainId = (value) => {
  const text = String(value ?? '').trim().split('/').pop();
  return /^\d{1,20}$/.test(text) ? text : '';
};

/** What an order line paid, in cents: its price times its quantity, less that line's discounts (as src/lair.js) */
export function linePaid(line, quantity = null) {
  const cents = (value) => Math.round(Number(value || 0) * 100) || 0;
  const qty = quantity ?? Math.max(0, Math.floor(Number(line?.quantity ?? 1)) || 0);
  const full = Math.max(0, Math.floor(Number(line?.quantity ?? 1)) || 0);
  const gross = cents(line?.price ?? line?.price_set?.shop_money?.amount) * qty;
  const discounts = (line?.discount_allocations || []).reduce((sum, d) => sum + cents(d.amount ?? d.amount_set?.shop_money?.amount), 0);
  // a part of a line (after a refund) keeps its share of the line's discounts
  const share = full > 0 ? Math.round((discounts * qty) / full) : 0;
  return Math.max(0, gross - share);
}

/** The Monday a Lair day (YYYY-MM-DD) is in */
export function weekOf(day) {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

/** The day of the week of a Lair day: 0 Sunday to 6 Saturday */
export const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();

/** n random whole numbers below `below`, from crypto.getRandomValues, without bias */
export function randomBelow(below, random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const limit = 256 - (256 % below);
  for (;;) {
    for (const byte of random(8)) if (byte < limit) return byte % below;
  }
}

/** A fresh invite code: FRIEND- and 6 letters and numbers (no 0, O, 1, I or L) */
export function inviteCode(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  while (out.length < 6) out += letters[randomBelow(letters.length, random)];
  return `FRIEND-${out}`;
}

/** The mobile numbers' last 9 digits, for telling whether two people are one */
const phoneKey = (text) => {
  const digits = String(text ?? '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-9) : '';
};

const parseList = (text) => {
  try {
    const value = JSON.parse(text || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const CARD_NIGHT = /\b(tcg|pok[eé]mon|magic|mtg|commander|one piece|riftbound|gundam|lorcana|yu-?gi-?oh|card night|flesh and blood|star wars unlimited)\b/i;
const RPG_SALE = /\brpg\b/i;
const TCG_SALE = /\btcg\b/i;
const PAINT_SESSION_SKU = /^LAIR-PAINT-SESSION(?:-[A-Z0-9]+)*$/i;
// what Fresh blood never counts: the Lair's own things, gift cards and library copies
const NOT_FRESH = new Set(['Lair', 'Drinks', 'Snacks', 'Ice Cream', 'Session pass', 'Session gift', 'Experience gift', 'Gift card', 'deposit', 'Library', 'Staff test']);
// the stamped sessions that are visits (stampTally's sessions less the ledger's own stamps)
const VISIT_KINDS = new Set(['table', 'walkin', 'gm-seat', 'join', 'gm-run', 'stamp-sale']);

export const questMethods = {
  /* ---------------- on and off ---------------- */

  /** Whether quests are on: the live theme's lair_quests (Theme settings › Lair bookings) */
  questsOn(rules = this.rulesCache) {
    return rules?.quests?.on === true;
  },

  /** The Lair's time helpers in the shop's time zone */
  questTime(rules = this.rulesCache) {
    return new LairTime(rules?.tz || 'Pacific/Auckland');
  },

  /**
   * The week quests started (the Monday of the day they were first on): weekly quests, riddles' stamps and golden
   * bounties count from then. Kept in meta the first time it's asked while quests are on. No awaits.
   */
  questsFromWeek(now = Date.now(), rules = this.rulesCache) {
    const time = this.questTime(rules);
    // the first four riddles go in the first time quests are on (the review: seeded at deploy they could all be past)
    this.questSeedRiddles(now, rules);
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('quests-from', ?)", weekOf(time.key(now)));
    return this.sql.exec("SELECT value FROM meta WHERE key = 'quests-from'").one().value;
  },

  /** The first four riddles, for the four weeks from the next Monday, once ever. No awaits. */
  questSeedRiddles(now = Date.now(), rules = this.rulesCache) {
    if (this.sql.exec("SELECT 1 AS n FROM meta WHERE key = 'quest-riddles-seeded'").toArray().length) return;
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('quest-riddles-seeded', ?)", String(now));
    const time = this.questTime(rules);
    const first = addDays(weekOf(time.key(now)), 7);
    SEED_RIDDLES.forEach((r, i) => {
      this.sql.exec(
        'INSERT OR IGNORE INTO quest_riddles (id, week, text, hint, product_id, title, shelf_code, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        makeId('qr'), addDays(first, 7 * i), r.text, r.hint, r.productId, r.title, r.shelfCode, 'seed', now, now,
      );
    });
  },

  /**
   * A week's golden bounty and its two weekly quests: made the first time the week is asked for (from the week quests
   * started), with crypto randomness; a week before then, or one not made when create is false, is null. No awaits.
   */
  questWeek(week, now = Date.now(), { create = true, rules = this.rulesCache } = {}) {
    const row = this.sql.exec('SELECT * FROM quest_weeks WHERE week = ?', week).toArray()[0];
    if (row) return { week, goldenDay: row.golden_day, goldenBounty: row.golden_bounty, weeklies: ['riddle', ...parseList(row.weeklies)] };
    if (!create || week < this.questsFromWeek(now, rules)) return null;
    const pool = [...WEEKLY_POOL];
    const picked = [];
    while (picked.length < 2) picked.push(pool.splice(randomBelow(pool.length), 1)[0]);
    const goldenDay = addDays(week, randomBelow(7));
    const goldenBounty = BOUNTIES[randomBelow(BOUNTIES.length)];
    this.sql.exec(
      'INSERT OR IGNORE INTO quest_weeks (week, golden_day, golden_bounty, weeklies, created_at) VALUES (?, ?, ?, ?, ?)',
      week, goldenDay, goldenBounty, JSON.stringify(picked), now,
    );
    return this.questWeek(week, now, { create: false, rules });
  },

  /* ---------------- facts ---------------- */

  /** Keep a fact once (its key); a repeat changes nothing. Returns whether it's new. No awaits. */
  questFact(fact, now = Date.now()) {
    if (this.sql.exec('SELECT 1 AS n FROM quest_facts WHERE key = ?', fact.key).toArray().length) return false;
    this.sql.exec(
      `INSERT INTO quest_facts (id, key, customer_id, kind, ref, day, at, amount, product_id, variant_id, order_id, line_id, unit, pos, flags, checked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      makeId('qf'), fact.key, String(fact.customerId), fact.kind, fact.ref ?? null, fact.day ?? null, fact.at, fact.amount ?? null,
      fact.productId || null, fact.variantId || null, fact.orderId || null, fact.lineId || null, fact.unit ?? null, fact.pos ? 1 : 0,
      fact.flags?.length ? fact.flags.join(',') : null, now, now,
    );
    return true;
  },

  /**
   * What Shopify says about these products (numeric ids): Map id → { type, vendor, title, listedAt, dice }. Kept a day
   * in quest_products; only the ones not known (or kept too long) are asked, 50 a call. Throws when Shopify can't answer
   * (the webhook comes again).
   */
  async questProductFacts(ids, now = Date.now()) {
    const wanted = [...new Set(ids.map(plainId).filter(Boolean))];
    const known = new Map();
    for (let i = 0; i < wanted.length; i += 90) {
      const part = wanted.slice(i, i + 90);
      for (const r of this.sql.exec(`SELECT * FROM quest_products WHERE product_id IN (${part.map(() => '?').join(', ')})`, ...part).toArray()) {
        if (now - r.checked_at < QUESTS_CONFIG.productMs) known.set(r.product_id, { type: r.type || '', vendor: r.vendor || '', title: r.title || '', listedAt: r.listed_at, dice: r.dice === 1 });
      }
    }
    const ask = wanted.filter((id) => !known.has(id));
    for (let i = 0; i < ask.length; i += 50) {
      const found = await this.shopify.questProducts(ask.slice(i, i + 50), this.tillDice());
      for (const p of found) {
        const id = plainId(p.id);
        if (!id) continue;
        const fact = { type: p.type || '', vendor: p.vendor || '', title: p.title || '', listedAt: Number(p.listedAt) || null, dice: p.dice === true };
        known.set(id, fact);
        this.sql.exec(
          `INSERT INTO quest_products (product_id, type, vendor, title, listed_at, dice, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (product_id) DO UPDATE SET type = excluded.type, vendor = excluded.vendor, title = excluded.title,
             listed_at = excluded.listed_at, dice = excluded.dice, checked_at = excluded.checked_at`,
          id, fact.type, fact.vendor, fact.title, fact.listedAt, fact.dice ? 1 : 0, now,
        );
      }
    }
    return known;
  },

  /**
   * orders/paid (src/lair.js ordersPaid): a paid order's facts for its customer (a member or not; their quests follow
   * when they are one): each Dice Goblin die (a fact a unit), the order's drinks, snacks and ice cream (one each, with
   * the amount), each product line (for Fresh blood, Fresh pot, Paint it, Rolled it and Ask Gobgob) and, at the counter
   * between 11:30pm and 4am, a late sale. Once per order: every fact has its own key. Off unless quests are on. Returns
   * { dice, bounties } or null.
   */
  async questOrderPaid(order, orderId, { pos = false, spend = null, rules = this.rulesCache } = {}) {
    if (!this.questsOn(rules)) return null;
    const customerId = plainId(spend?.customerId || order?.customer?.id);
    if (!customerId) return null;
    const lines = (order?.line_items || []).filter((l) => l && l.gift_card !== true);
    if (!lines.length) return null;
    const products = await this.questProductFacts(lines.map((l) => l.product_id));
    // --- no awaits from here on ---
    const now = Date.now();
    const paidAt = Number(spend?.processedAt) || Date.parse(order.processed_at || order.created_at || '') || now;
    const time = this.questTime(rules);
    const day = time.key(paidAt);
    const base = { customerId, orderId, pos, day, at: paidAt };
    let dice = 0;
    const kinds = new Map();
    lines.forEach((line, index) => {
      const lineId = String(line.id ?? line.admin_graphql_api_id ?? `line-${index}`);
      const productId = plainId(line.product_id);
      const facts = products.get(productId);
      const quantity = Math.max(0, Math.floor(Number(line.quantity ?? 1)) || 0);
      if (facts?.dice && !/games workshop/i.test(facts.vendor || line.vendor || '')) {
        for (let unit = 1; unit <= Math.min(quantity, QUESTS_CONFIG.dicePerLine); unit += 1) {
          if (this.questFact({ ...base, key: `dice:${orderId}:${lineId}:${unit}`, kind: 'dice', productId, lineId, unit }, now)) dice += 1;
        }
      }
      const kind = BOUNTY_TYPES[facts?.type];
      if (kind) kinds.set(kind, (kinds.get(kind) || 0) + linePaid(line));
      const flags = [];
      if (PAINT_SESSION_SKU.test(String(line.sku ?? '').trim())) flags.push('paint-session');
      if (facts && facts.type === 'Paints & Hobby' && /\bpaints?\b/i.test(facts.title)) flags.push('paint');
      if (facts?.listedAt && !NOT_FRESH.has(facts.type) && paidAt - facts.listedAt <= QUESTS_CONFIG.freshDays * DAY && paidAt >= facts.listedAt) flags.push('fresh');
      if (productId || flags.length) {
        this.questFact({ ...base, key: `line:${orderId}:${lineId}`, kind: 'line', productId, variantId: plainId(line.variant_id), lineId, amount: linePaid(line), flags }, now);
      }
    });
    let bounties = 0;
    for (const [kind, amount] of kinds) {
      if (this.questFact({ ...base, key: `buy:${orderId}:${kind}`, kind: 'buy', ref: kind, amount }, now) && amount >= QUESTS_CONFIG.bountyCents) bounties += 1;
    }
    if (pos) {
      const minutes = Math.round((paidAt - time.at(day, 0)) / MIN);
      if (minutes >= QUESTS_CONFIG.lateFrom || minutes < QUESTS_CONFIG.lateUntil) this.questFact({ ...base, key: `late:${orderId}`, kind: 'late' }, now);
    }
    this.questSafeSync(customerId, now, rules);
    return dice || bounties ? { dice, bounties } : null;
  },

  /** A member's code scanned at the counter (the till, or Shopify POS's tile): one fact a Lair day. No awaits. */
  questCounterScan(customerId, now = Date.now(), rules = this.rulesCache) {
    const id = plainId(customerId);
    if (!id || !this.questsOn(rules)) return;
    try {
      const day = this.questTime(rules).key(now);
      if (this.questFact({ key: `scan:${id}:${day}`, customerId: id, kind: 'scan', day, at: now, pos: true }, now)) this.questSafeSync(id, now, rules);
    } catch (error) {
      // never in the way of the counter
      console.error('Lair: Show your face could not be kept', error);
    }
  },

  /**
   * POST /library/scan { code, action: 'play' } (logged in): "Playing it here". A library box scanned to play in the
   * Lair: no plan needed, In Store Only games too, nothing goes home. One fact a game an hour. → { result: 'playing', game,
   * riddle, message }. (libraryScan hands over once it has the game.)
   */
  libraryPlayHere(game, who, rules = this.rulesCache, now = Date.now()) {
    if (!this.questsOn(rules)) throw new RuleError(QUEST_WORDS.off, 409);
    const me = String(who.customerId);
    const time = this.questTime(rules);
    const day = time.key(now);
    const week = weekOf(day);
    const productId = plainId(game.productId);
    // one fact a game an hour (a riddle that comes out at 10am is solved by a scan after it, the same day), and at most
    // playScansDaily a day kept (the review: nothing else limited the writes)
    const hour = Math.floor((now - time.at(day, 0)) / HOUR);
    const today = this.sql.exec("SELECT COUNT(*) AS n FROM quest_facts WHERE customer_id = ? AND kind = 'play' AND day = ?", me, day).one().n;
    if (today < QUESTS_CONFIG.playScansDaily) {
      this.questFact({ key: `play:${me}:${game.variantId}:${day}:${hour}`, customerId: me, kind: 'play', productId, variantId: String(game.variantId), day, at: now }, now);
    }
    this.touchMember(me, {}, now);
    const key = `quest:${me}:weekly:riddle:${week}`;
    const had = this.sql.exec("SELECT 1 AS n FROM loyalty_stamps WHERE key = ? AND undone_at IS NULL", key).toArray().length > 0;
    this.questSafeSync(me, now, rules);
    // solved: the week's riddle stamp landed with this scan. Only then is it said, so a scan from home, or before
    // they've been in that day, never gives the answer away (the review: the reply was an answer oracle)
    const solved = !had && this.sql.exec("SELECT 1 AS n FROM loyalty_stamps WHERE key = ? AND undone_at IS NULL", key).toArray().length > 0;
    return {
      result: 'playing', game: { title: game.title, shelfCode: game.shelfCode || '' }, riddle: solved,
      message: solved ? QUEST_WORDS.riddleSolved(game.title) : QUEST_WORDS.playing(game.title),
    };
  },

  /** Whether picking up this product now answers the week's riddle (out already). No awaits. */
  questRiddleSolvedBy(customerId, productId, now = Date.now(), rules = this.rulesCache) {
    if (!productId) return false;
    const time = this.questTime(rules);
    const week = weekOf(time.key(now));
    const riddle = this.sql.exec('SELECT * FROM quest_riddles WHERE week = ?', week).toArray()[0];
    return Boolean(riddle && riddle.product_id === productId && now >= time.at(week, QUESTS_CONFIG.riddleOutMinutes));
  },

  /** POST /pick/rolled { productId } (logged in): the website's d20 picker landed on this game for them → { ok: true } */
  async pickRolled(input, who) {
    if (!who.customerId) throw new RuleError(QUEST_WORDS.login, 401);
    const rules = await this.rules();
    // --- no awaits from here on ---
    if (!this.questsOn(rules)) return { ok: true };
    const productId = plainId(input?.productId);
    if (!productId) throw new RuleError(QUEST_WORDS.rolledProduct, 422);
    const now = Date.now();
    const me = String(who.customerId);
    const day = this.questTime(rules).key(now);
    const today = this.sql.exec("SELECT COUNT(*) AS n FROM quest_facts WHERE customer_id = ? AND kind = 'rolled' AND day = ?", me, day).one().n;
    if (today >= QUESTS_CONFIG.rolledDaily) throw new RuleError(QUEST_WORDS.rolledMany, 429);
    this.questFact({ key: `rolled:${me}:${productId}:${day}`, customerId: me, kind: 'rolled', productId, day, at: now }, now);
    return { ok: true };
  },

  /* ---------------- bring a friend ---------------- */

  /** A member's own invite code, made the first time it's asked for. No awaits. */
  questInviteCode(customerId, now = Date.now()) {
    const id = String(customerId);
    const row = this.sql.exec('SELECT code FROM quest_invites WHERE customer_id = ?', id).toArray()[0];
    if (row) return row.code;
    for (let tries = 0; tries < 5; tries += 1) {
      const code = inviteCode();
      if (this.sql.exec('SELECT 1 AS n FROM quest_invites WHERE code = ?', code).toArray().length) continue;
      this.sql.exec('INSERT INTO quest_invites (customer_id, code, created_at) VALUES (?, ?, ?)', id, code, now);
      return code;
    }
    throw new RuleError("Gobgob couldn't make your invite code just now. Try again in a moment.", 503);
  },

  /** Whose invite code this typed text is (FRIEND-ABC123, any case, dashes or not), or null. No awaits. */
  questInviteByText(text) {
    const key = String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^FRIEND[A-Z0-9]{6}$/.test(key)) return null;
    return this.sql.exec('SELECT customer_id, code FROM quest_invites WHERE code = ?', `FRIEND-${key.slice(6)}`).toArray()[0] || null;
  },

  /**
   * "Got a code?" with an invite code (redeemCode): only someone new (no session at Dice Goblin before today), once ever,
   * never their own. → { kind: 'invite', message, loyalty }. No awaits.
   */
  redeemInvite(invite, customerId, rules, now) {
    const id = String(customerId);
    if (!this.questsOn(rules)) throw new RuleError(QUEST_WORDS.off, 409);
    if (invite.customer_id === id) throw new RuleError(QUEST_WORDS.inviteOwn, 422);
    if (this.sql.exec('SELECT 1 AS n FROM quest_invited WHERE friend_id = ?', id).toArray().length) throw new RuleError(QUEST_WORDS.inviteOnce, 409);
    // two new players swapping codes would each be the other's friend: one way only (the review)
    if (this.sql.exec('SELECT 1 AS n FROM quest_invited WHERE friend_id = ? AND bringer_id = ?', invite.customer_id, id).toArray().length) {
      throw new RuleError(QUEST_WORDS.inviteBack, 409);
    }
    if (this.playedBefore(id, this.todayStarts(now), this.stampTally(id, now))) throw new RuleError(QUEST_WORDS.inviteNotNew, 409);
    this.touchMember(id, {}, now);
    this.sql.exec('INSERT INTO quest_invited (friend_id, bringer_id, at) VALUES (?, ?, ?)', id, invite.customer_id, now);
    this.questSafeSync(id, now, rules);
    const bringer = this.memberRow(invite.customer_id);
    const first = bringer?.first_name || String(bringer?.name || '').split(/\s+/)[0] || '';
    return { kind: 'invite', message: QUEST_WORDS.inviteDone(first), loyalty: this.loyaltyOf(id, rules, { details: true }) };
  },

  /** When a member's first paid session stamped (src/newplayers.js firstPaidSession), or null. No awaits. */
  questFirstPaid(customerId, sessions, now = Date.now()) {
    const first = this.firstPaidSession(customerId, sessions, now);
    return first ? Number(first.at) : null;
  },

  /** Whether two members share a mobile number on their bookings. No awaits. */
  questSamePhone(a, b) {
    const phones = (id) => new Set(this.sql.exec('SELECT DISTINCT phone FROM bookings WHERE customer_id = ? AND phone IS NOT NULL', String(id)).toArray().map((r) => phoneKey(r.phone)).filter(Boolean));
    const mine = phones(a);
    if (!mine.size) return false;
    for (const p of phones(b)) if (mine.has(p)) return true;
    return false;
  },

  /* ---------------- working quests out ---------------- */

  /**
   * Every quest stamp a member has earned: Map key → { quest, count, at, title }. Worked out from scratch each time, so a
   * refund, a booking undone or a loan taken back takes its quest with it. No awaits.
   */
  questEarned(customerId, now = Date.now(), rules = this.rulesCache) {
    const id = String(customerId);
    const time = this.questTime(rules);
    const earned = new Map();
    const give = (key, quest, at, count = QUESTS[quest].stamps) => {
      if (at == null || earned.has(key)) return;
      earned.set(key, { quest, count, at: Number(at), title: QUESTS[quest].name });
    };
    const facts = this.sql.exec('SELECT * FROM quest_facts WHERE customer_id = ? AND undone_at IS NULL ORDER BY at, rowid', id).toArray();
    const ofKind = (kind) => facts.filter((f) => f.kind === kind);
    const tally = this.stampTally(id, now, rules);
    const visits = tally.sessions.filter((r) => VISIT_KINDS.has(r.kind)).sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
    // the sessions as the card counts them (stampTally's rows): a Session rung up at the counter for a booked table is
    // the same session, so it drops out here (the review, 16 Nov 2026: Lair dweller counted it twice)
    const counted = tally.rows.filter((r) => VISIT_KINDS.has(r.kind)).sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
    const details = this.questVisitDetails(visits);
    const dayOf = (ms) => time.key(ms);

    // Always on
    for (const f of ofKind('dice')) give(`dice:${f.order_id}:${f.line_id}:${f.unit}`, 'dice', f.at);
    // the library: joining (each membership, once its first payment made it), and every renewal paid
    for (const m of this.sql.exec("SELECT id, created_at FROM memberships WHERE customer_id = ? AND COALESCE(shopify_status, '') != 'FAILED' ORDER BY created_at, rowid", id).toArray()) {
      give(`library:join:${m.id}`, 'library', m.created_at);
    }
    for (const c of this.sql.exec(
      "SELECT c.id AS id, COALESCE(c.completed_at, c.updated_at) AS at FROM membership_charges c JOIN memberships m ON m.id = c.membership_id WHERE m.customer_id = ? AND c.kind = 'renewal' AND c.status = 'paid'",
      id,
    ).toArray()) give(`library:renew:${c.id}`, 'library', c.at);

    // Daily bounties: one of each a day, from a sale with $6 or more of it; the week's golden one pays 2
    const bounties = [];
    for (const f of ofKind('buy')) {
      if (Number(f.amount) < QUESTS_CONFIG.bountyCents || !BOUNTIES.includes(f.ref)) continue;
      if (bounties.some((b) => b.day === f.day && b.kind === f.ref)) continue;
      const wk = this.questWeek(weekOf(f.day), now, { create: false, rules });
      const golden = Boolean(wk && wk.goldenDay === f.day && wk.goldenBounty === f.ref);
      bounties.push({ day: f.day, kind: f.ref, at: f.at, golden });
      give(`bounty:${f.ref}:${f.day}`, `bounty-${f.ref}`, f.at, golden ? QUESTS_CONFIG.goldenStamps : 1);
    }

    // Library pick-ups: loans and play-here scans, with the product each was
    // A box scanned to play here counts on a day they were in the Lair (a session that stamps, or their code or a sale
    // at the counter), at most 5 different games a day: a shelf code typed at home is never a game played
    const loans = this.sql.exec('SELECT variant_id, product_id, out_at FROM library_loans WHERE customer_id = ? ORDER BY out_at, rowid', id).toArray();
    const inDays = new Set([...visits.map((v) => dayOf(v.at)), ...facts.filter((f) => f.pos === 1).map((f) => f.day || dayOf(f.at))]);
    const playsByDay = new Map();
    const plays = [];
    for (const f of ofKind('play')) {
      const day = f.day || dayOf(f.at);
      if (!inDays.has(day)) continue;
      const product = f.product_id || `v${f.variant_id}`;
      const seen = playsByDay.get(day) || new Set();
      if (!seen.has(product) && seen.size >= QUESTS_CONFIG.playsDaily) continue;
      seen.add(product);
      playsByDay.set(day, seen);
      plays.push({ product, at: Number(f.at) });
    }
    const pickups = [
      ...loans.map((l) => ({ product: plainId(l.product_id) || `v${l.variant_id}`, at: Number(l.out_at) })),
      ...plays,
    ].sort((a, b) => a.at - b.at);
    const distinctAt = (list, n) => {
      const seen = new Set();
      for (const p of list) {
        seen.add(p.product);
        if (seen.size >= n) return p.at;
      }
      return null;
    };

    // Weekly quests, week by week from when quests started
    const fromWeek = this.questsFromWeek(now, rules);
    const thisWeek = weekOf(time.key(now));
    const counterAt = facts.filter((f) => f.pos === 1).map((f) => Number(f.at));
    let riddlesSolved = 0;
    let riddleFifth = null;
    for (let week = fromWeek; week <= thisWeek; week = addDays(week, 7)) {
      const wk = this.questWeek(week, now, { create: week === thisWeek, rules });
      const from = time.at(week, 0);
      const to = time.at(addDays(week, 7), 0);
      const inWeek = (ms) => ms >= from && ms < to;
      const weekVisits = visits.filter((v) => inWeek(v.at));
      const visitAt = [...weekVisits.map((v) => v.at), ...counterAt.filter(inWeek)].sort((a, b) => a - b)[0] ?? null;
      // the riddle: its answer picked up from Monday 10am, and a visit that week
      const riddle = this.sql.exec('SELECT product_id FROM quest_riddles WHERE week = ?', week).toArray()[0];
      if (riddle && visitAt != null) {
        const out = time.at(week, QUESTS_CONFIG.riddleOutMinutes);
        const scan = pickups.find((p) => p.product === riddle.product_id && p.at >= out && p.at < to);
        if (scan) {
          riddlesSolved += 1;
          const at = Math.max(scan.at, visitAt);
          if (riddlesSolved === 5) riddleFifth = at;
          if (wk?.weeklies.includes('riddle')) give(`weekly:riddle:${week}`, 'riddle', at);
        }
      }
      if (!wk) continue;
      for (const quest of wk.weeklies) {
        if (quest === 'full-house') {
          const v = weekVisits.find((x) => x.kind === 'table' && details.bookings.get(String(x.id))?.customer_id === id && Number(details.bookings.get(String(x.id))?.people) >= QUESTS_CONFIG.fullHouse);
          if (v) give(`weekly:full-house:${week}`, 'full-house', v.at);
        } else if (quest === 'lair-dweller') {
          const ids = [...new Map(counted.filter((v) => inWeek(v.at)).map((v) => [`${v.kind}:${v.id}`, v])).values()];
          if (ids.length >= QUESTS_CONFIG.dwellerSessions) give(`weekly:lair-dweller:${week}`, 'lair-dweller', ids[QUESTS_CONFIG.dwellerSessions - 1].at);
        } else if (quest === 'bounty-hunter') {
          const done = bounties.filter((b) => inWeek(b.at));
          if (done.length >= QUESTS_CONFIG.hunterBounties) give(`weekly:bounty-hunter:${week}`, 'bounty-hunter', done[QUESTS_CONFIG.hunterBounties - 1].at);
        } else if (quest === 'clean-sweep') {
          const byDay = new Map();
          for (const b of bounties.filter((x) => inWeek(x.at))) byDay.set(b.day, [...(byDay.get(b.day) || []), b]);
          const full = [...byDay.values()].find((list) => new Set(list.map((b) => b.kind)).size === BOUNTIES.length);
          if (full) give(`weekly:clean-sweep:${week}`, 'clean-sweep', Math.max(...full.map((b) => b.at)));
        }
      }
    }

    // One-off quests
    const first = (pred) => visits.find(pred)?.at ?? null;
    const booking = (v) => details.bookings.get(String(v.id));
    const game = (v) => details.games.get(String(booking(v)?.game_id));
    const isTtrpg = (v) => v.kind === 'gm-seat' || (v.kind === 'stamp-sale' && RPG_SALE.test(v.join_title || ''));
    const isWargame = (v) => ['table', 'walkin'].includes(v.kind) && (booking(v)?.activity === 'wargame' || parseList(booking(v)?.extras).includes('wargame'));
    const isCardNight = (v) => (v.kind === 'join' && CARD_NIGHT.test(v.join_title || '')) || (v.kind === 'stamp-sale' && TCG_SALE.test(v.join_title || ''));
    give(`once:first-scan`, 'first-scan', ofKind('scan')[0]?.at ?? null);
    give(`once:first-ttrpg`, 'first-ttrpg', first(isTtrpg));
    give(`once:first-warhammer`, 'first-warhammer', first(isWargame));
    give(`once:first-card-night`, 'first-card-night', first(isCardNight));
    give(`once:first-table`, 'first-table', first((v) => v.kind === 'table' && booking(v)?.customer_id === id && !isWargame(v)));
    give(`once:first-paint`, 'first-paint', ofKind('line').find((f) => String(f.flags || '').split(',').includes('paint-session'))?.at ?? null);
    give(`once:first-gm`, 'first-gm', first((v) => v.kind === 'gm-run'));
    const seats = visits.filter((v) => v.kind === 'gm-seat' && game(v));
    const distinctBy = (list, keyOf, n) => {
      const seen = new Set();
      for (const v of list) {
        const key = keyOf(v);
        if (!key) continue;
        seen.add(key);
        if (seen.size >= n) return v.at;
      }
      return null;
    };
    give(`once:three-systems`, 'three-systems', distinctBy(seats, (v) => String(game(v)?.system || '').trim().toLowerCase(), 3));
    give(`once:three-gms`, 'three-gms', distinctBy(seats, (v) => game(v)?.gm_customer_id || String(game(v)?.gm || '').trim().toLowerCase(), 3));
    const bySeries = new Map();
    for (const v of seats) {
      const series = booking(v)?.series_id;
      if (!series) continue;
      bySeries.set(series, [...(bySeries.get(series) || []), v]);
    }
    give(`once:weekly-seat`, 'weekly-seat', [...bySeries.values()].filter((l) => l.length >= 4).map((l) => l[3].at).sort((a, b) => a - b)[0] ?? null);
    give(`once:first-borrow`, 'first-borrow', loans[0]?.out_at ?? null);
    give(`once:ten-games`, 'ten-games', distinctAt(pickups, 10));
    const streak = (n) => {
      const weeks = [...new Set(visits.map((v) => weekOf(dayOf(v.at))))].sort();
      let run = 0;
      let last = null;
      for (const w of weeks) {
        run = last && addDays(last, 7) === w ? run + 1 : 1;
        last = w;
        if (run >= n) return visits.find((v) => weekOf(dayOf(v.at)) === w).at;
      }
      return null;
    };
    give(`once:four-weeks`, 'four-weeks', streak(4));
    give(`once:eight-weeks`, 'eight-weeks', streak(8));

    // Secret quests
    const lines = ofKind('line');
    const flagged = (flag) => lines.find((f) => String(f.flags || '').split(',').includes(flag))?.at ?? null;
    give(`once:fresh-blood`, 'fresh-blood', flagged('fresh'));
    give(`once:fresh-pot`, 'fresh-pot', flagged('paint'));
    const twinsOf = (productId) => new Set([productId, ...this.sql.exec('SELECT shop_id FROM shop_twins WHERE library_id = ?', productId).toArray().map((r) => plainId(r.shop_id))].filter(Boolean));
    let rolled = null;
    for (const r of ofKind('rolled')) {
      const ids = twinsOf(r.product_id);
      const bought = lines.find((f) => ids.has(f.product_id) && f.at >= r.at && f.at <= r.at + QUESTS_CONFIG.rolledDays * DAY);
      if (bought && (rolled == null || bought.at < rolled)) rolled = bought.at;
    }
    give(`once:rolled-it`, 'rolled-it', rolled);
    let asked = null;
    for (const s of this.sql.exec('SELECT picks, wildcard, created_at FROM pick_sessions WHERE customer_id = ?', id).toArray()) {
      const picks = new Set([...parseList(s.picks), s.wildcard].map(plainId).filter(Boolean));
      if (!picks.size) continue;
      const until = Number(s.created_at) + QUESTS_CONFIG.askDays * DAY;
      const wanted = new Set([...picks].flatMap((p) => [...twinsOf(p)]));
      const hit = [...pickups.filter((p) => picks.has(p.product)), ...lines.filter((f) => wanted.has(f.product_id))].map((x) => Number(x.at)).filter((t) => t >= s.created_at && t <= until).sort((a, b) => a - b)[0];
      if (hit != null && (asked == null || hit < asked)) asked = hit;
    }
    give(`once:ask-gobgob`, 'ask-gobgob', asked);
    const roomOf = this.questRoomOf(rules);
    const roomsOf = (v) => parseList(v.tables).map((t) => roomOf.get(String(t))).filter(Boolean);
    give(`once:fancy-pants`, 'fancy-pants', first((v) => roomsOf(v).some((r) => /fancy/i.test(r.name))));
    give(`once:first-table-gm`, 'first-table-gm', first((v) => {
      const g = game(v);
      if (v.kind !== 'gm-seat' || !g?.gm_customer_id || g.gm_customer_id === id) return false;
      const firstGame = this.sql.exec("SELECT id FROM games WHERE gm_customer_id = ? AND status NOT IN ('cancelled') ORDER BY starts_at, rowid LIMIT 1", g.gm_customer_id).toArray()[0];
      return firstGame?.id === g.id;
    }));
    let diver = null;
    for (const p of pickups) {
      const wk = weekOf(dayOf(p.at));
      const same = new Set(pickups.filter((x) => weekOf(dayOf(x.at)) === wk && x.at <= p.at).map((x) => x.product));
      if (same.size >= 3) {
        diver = p.at;
        break;
      }
    }
    give(`once:shelf-diver`, 'shelf-diver', diver);
    give(`once:treasure-hunter`, 'treasure-hunter', riddleFifth);
    give(`once:hoarder`, 'hoarder', distinctAt(pickups, 100));
    const natural = (n) => this.sql.exec(
      "SELECT MIN(created_at) AS at FROM member_rolls WHERE customer_id = ? AND kind = 'loyalty' AND roll = ? AND (pick IS NULL OR pick = 'roll') AND taken_back_at IS NULL",
      id, n,
    ).one()?.at ?? null;
    give(`once:nat-20`, 'nat-20', natural(20));
    give(`once:nat-1`, 'nat-1', natural(1));
    const rooms = (rules?.rooms || []).filter((r) => r.bookable !== false && r.tables?.length);
    if (rooms.length) {
      const seen = new Set();
      for (const v of visits) {
        for (const r of roomsOf(v)) seen.add(r.id);
        if (rooms.every((r) => seen.has(r.id))) {
          give(`once:grand-tour`, 'grand-tour', v.at);
          break;
        }
      }
    }
    const weekdays = new Set();
    for (const v of visits) {
      weekdays.add(weekdayOf(dayOf(v.at)));
      if (weekdays.size === 7) {
        give(`once:every-day`, 'every-day', v.at);
        break;
      }
    }
    give(`once:last-one-out`, 'last-one-out', ofKind('late')[0]?.at ?? null);

    // Bring a friend: both sides once the friend's first paid session has stamped, unless they share a mobile number
    const invited = this.sql.exec('SELECT bringer_id, at FROM quest_invited WHERE friend_id = ?', id).toArray()[0];
    if (invited && !this.questSamePhone(id, invited.bringer_id)) {
      const paidAt = this.questFirstPaid(id, tally.sessions, now);
      if (paidAt != null) give('invite-friend', 'invite-friend', Math.max(paidAt, Number(invited.at)));
    }
    for (const f of this.sql.exec('SELECT friend_id, at FROM quest_invited WHERE bringer_id = ? ORDER BY at, rowid', id).toArray()) {
      if (this.questSamePhone(id, f.friend_id)) continue;
      const paidAt = this.questFirstPaid(f.friend_id, this.stampTally(f.friend_id, now, rules).sessions, now);
      if (paidAt != null) give(`invite-bring:${f.friend_id}`, 'invite-bring', Math.max(paidAt, Number(f.at)));
    }

    // GMs: a player whose first TTRPG seat was at one of their sessions, and that player back at one of their sessions
    for (const g of this.questGmPlayers(id, now)) {
      if (g.firstHere) give(`gm-new:${g.player}`, 'gm-new', g.firstAt);
      if (g.firstHere && g.backAt != null) give(`gm-back:${g.player}`, 'gm-back', g.backAt);
    }
    return earned;
  },

  /** The bookings and games behind a member's visits (90 at a time): { bookings: Map, games: Map }. No awaits. */
  questVisitDetails(visits) {
    const ids = [...new Set(visits.filter((v) => ['table', 'walkin', 'gm-seat'].includes(v.kind)).map((v) => String(v.id)))];
    const bookings = new Map();
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      for (const b of this.sql.exec(`SELECT id, kind, activity, extras, game_id, customer_id, people, series_id FROM bookings WHERE id IN (${part.map(() => '?').join(', ')})`, ...part).toArray()) {
        bookings.set(String(b.id), b);
      }
    }
    const gameIds = [...new Set([...bookings.values()].map((b) => b.game_id).filter(Boolean).map(String))];
    const games = new Map();
    for (let i = 0; i < gameIds.length; i += 90) {
      const part = gameIds.slice(i, i + 90);
      for (const g of this.sql.exec(`SELECT id, system, gm, gm_customer_id, starts_at FROM games WHERE id IN (${part.map(() => '?').join(', ')})`, ...part).toArray()) {
        games.set(String(g.id), g);
      }
    }
    return { bookings, games };
  },

  /** Each table's room: Map table id → room ({ id, name }). No awaits. */
  questRoomOf(rules = this.rulesCache) {
    const map = new Map();
    for (const r of rules?.rooms || []) for (const t of r.tables || []) map.set(String(t.id), { id: r.id, name: r.name });
    return map;
  },

  /**
   * The players at a GM's sessions (not ones they ran on the team's time): [{ player, firstHere, firstAt, backAt }].
   * firstHere: the player's first TTRPG seat anywhere was at one of this GM's sessions; backAt: their second seat at one
   * of this GM's sessions. Seats that stamp only. No awaits.
   */
  questGmPlayers(gmId, now = Date.now()) {
    const until = this.stampsUntil(now);
    const stamps = "(b.status IN ('seated', 'done') OR (b.status = 'confirmed' AND b.paid = 1 AND b.starts_at < ?))";
    const seats = this.sql.exec(
      `SELECT b.customer_id AS player, b.starts_at AS at, b.game_id AS game_id FROM bookings b JOIN games g ON g.id = b.game_id
        WHERE g.gm_customer_id = ? AND b.kind = 'gm-seat' AND b.customer_id IS NOT NULL AND b.customer_id != ? AND b.starts_at >= ? AND ${stamps}
          AND NOT EXISTS (SELECT 1 FROM gm_runs r WHERE r.game_id = g.id AND r.customer_id = g.gm_customer_id AND r.staff = 1)
        ORDER BY b.starts_at, b.rowid`,
      String(gmId), String(gmId), this.loyaltyFrom, until,
    ).toArray();
    const byPlayer = new Map();
    for (const s of seats) byPlayer.set(String(s.player), [...(byPlayer.get(String(s.player)) || []), s]);
    const out = [];
    for (const [player, list] of byPlayer) {
      const firstAnywhere = this.sql.exec(
        `SELECT b.game_id AS game_id, b.starts_at AS at FROM bookings b WHERE b.customer_id = ? AND b.kind = 'gm-seat' AND ${stamps} ORDER BY b.starts_at, b.rowid LIMIT 1`,
        player, until,
      ).toArray()[0];
      const firstHere = Boolean(firstAnywhere && list.some((s) => s.game_id === firstAnywhere.game_id && s.at === firstAnywhere.at));
      out.push({ player, firstHere, firstAt: list[0].at, backAt: list[1]?.at ?? null });
    }
    return out;
  },

  /**
   * Make the stamp ledger match what a member has earned: new quest stamps in, ones whose reason went taken back
   * (undone_by 'quest'), ones staff took back left out. At most once a minute a member unless forced. No awaits.
   * Returns { added, taken } or null when it didn't run.
   */
  questSync(customerId, now = Date.now(), rules = this.rulesCache, { force = false } = {}) {
    const id = plainId(customerId);
    if (!id || !this.questsOn(rules) || !this.memberRow(id)) return null;
    this.questSynced = this.questSynced || new Map();
    if (!force && now - (this.questSynced.get(id) || 0) < QUESTS_CONFIG.syncEvery) return null;
    if (this.questSynced.size > 5000) this.questSynced.clear();
    this.questSynced.set(id, now);
    const earned = this.questEarned(id, now, rules);
    const rows = new Map(this.sql.exec("SELECT id, key, count, at, undone_at, undone_by FROM loyalty_stamps WHERE customer_id = ? AND kind = 'quest'", id).toArray().map((r) => [r.key, r]));
    let added = 0;
    let taken = 0;
    for (const [key, e] of earned) {
      const full = `quest:${id}:${key}`;
      const row = rows.get(full);
      if (!row) {
        this.write(
          "INSERT INTO loyalty_stamps (id, customer_id, kind, count, title, note, key, at, created_by, created_at) VALUES (?, ?, 'quest', ?, ?, ?, ?, ?, 'quest', ?)",
          makeId('st'), id, e.count, e.title, e.quest, full, e.at, now,
        );
        added += e.count;
      } else if (row.undone_at && row.undone_by === 'quest') {
        this.write('UPDATE loyalty_stamps SET undone_at = NULL, undone_by = NULL, count = ?, at = ? WHERE id = ?', e.count, e.at, row.id);
        added += e.count;
      } else if (!row.undone_at && Number(row.count) !== e.count) {
        this.write('UPDATE loyalty_stamps SET count = ? WHERE id = ?', e.count, row.id);
      }
    }
    for (const [key, row] of rows) {
      if (row.undone_at || earned.has(key.slice(`quest:${id}:`.length))) continue;
      this.write("UPDATE loyalty_stamps SET undone_at = ?, undone_by = 'quest' WHERE id = ?", now, row.id);
      taken += Number(row.count) || 0;
    }
    return { added, taken };
  },

  /** questSync that never throws: a quest bug must never break the route it rides on (GET /me, a sale, a scan) */
  questSafeSync(customerId, now = Date.now(), rules = this.rulesCache, options = { force: true }) {
    try {
      return this.questSync(customerId, now, rules, options);
    } catch (error) {
      console.error('Lair: quests could not be worked out', error);
      return null;
    }
  },

  /* ---------------- My Lair ---------------- */

  /** GET /me/quests (logged in): the member's quests, as the contract's section 5. */
  async myQuests(who) {
    if (!who.customerId) throw new RuleError(QUEST_WORDS.login, 401);
    const rules = await this.rules();
    // --- no awaits from here on ---
    if (!this.questsOn(rules)) throw new RuleError(QUEST_WORDS.off, 409);
    const now = Date.now();
    const id = String(who.customerId);
    this.touchMember(id, {}, now);
    this.questSafeSync(id, now, rules);
    const time = this.questTime(rules);
    const day = time.key(now);
    const week = weekOf(day);
    const wk = this.questWeek(week, now, { rules });
    const done = new Map(
      this.sql.exec("SELECT key, note, count, at FROM loyalty_stamps WHERE customer_id = ? AND kind = 'quest' AND undone_at IS NULL", id).toArray()
        .map((r) => [r.key.slice(`quest:${id}:`.length), r]),
    );
    const doneAt = (key) => done.get(key)?.at ?? null;
    const bounties = BOUNTIES.map((kind) => {
      const row = done.get(`bounty:${kind}:${day}`);
      const golden = Boolean(wk && wk.goldenDay === day && wk.goldenBounty === kind);
      return { id: `bounty-${kind}`, name: QUESTS[`bounty-${kind}`].name, how: QUESTS[`bounty-${kind}`].how, done: Boolean(row), stamps: golden ? QUESTS_CONFIG.goldenStamps : 1, golden };
    });
    const progress = this.questWeekProgress(id, week, now, rules);
    const weekly = (wk?.weeklies || []).map((q) => ({ id: q, name: QUESTS[q].name, how: QUESTS[q].how, done: doneAt(`weekly:${q}:${week}`) != null, ...(progress[q] || {}) }));
    const riddleRow = this.sql.exec('SELECT * FROM quest_riddles WHERE week = ?', week).toArray()[0];
    const out = riddleRow ? now >= time.at(week, QUESTS_CONFIG.riddleOutMinutes) : false;
    const riddle = riddleRow ? { text: out ? riddleRow.text : null, hint: out ? riddleRow.hint || null : null, out, outAt: time.at(week, QUESTS_CONFIG.riddleOutMinutes), solved: doneAt(`weekly:riddle:${week}`) != null } : null;
    const chapters = CHAPTERS.map((c) => {
      const quests = QUEST_LIST.filter((q) => q.chapter === c.id).map((q) => {
        const at = doneAt(`once:${q.id}`);
        return { id: q.id, name: q.name, how: q.how, done: at != null, at, on: QUESTS[q.id].on };
      });
      const finished = quests.filter((q) => q.on).every((q) => q.done);
      return { id: c.id, name: c.name, title: finished ? c.name : null, done: finished, quests };
    });
    const secretList = QUEST_LIST.filter((q) => q.layer === 'secret');
    const found = secretList.filter((q) => doneAt(`once:${q.id}`) != null).map((q) => ({ id: q.id, name: q.name, how: q.how, at: doneAt(`once:${q.id}`), stamps: QUESTS[q.id].stamps }));
    const invites = this.sql.exec('SELECT friend_id FROM quest_invited WHERE bringer_id = ?', id).toArray();
    const brought = invites.filter((f) => done.has(`invite-bring:${f.friend_id}`)).length;
    const notCounted = invites.filter((f) => this.questSamePhone(id, f.friend_id)).length;
    const keys = [...done.keys()];
    const stamps = [...done.values()].reduce((sum, r) => sum + (Number(r.count) || 0), 0);
    return {
      day, week: { key: week, from: time.at(week, 0), to: time.at(addDays(week, 7), 0) }, bounties, weekly, riddle, chapters,
      secrets: { found, left: secretList.length - found.length },
      always: { dice: keys.filter((k) => k.startsWith('dice:')).length, library: keys.filter((k) => k.startsWith('library:')).length },
      invite: { code: this.questInviteCode(id, now), brought, waiting: invites.length - brought - notCounted, notCounted },
      gm: { newcomers: keys.filter((k) => k.startsWith('gm-new:')).length, returns: keys.filter((k) => k.startsWith('gm-back:')).length },
      stamps, loyalty: this.loyaltyOf(id, rules, { details: true }),
    };
  },

  /** How far along this week's counting quests are: { [quest]: { have, need } }. No awaits. */
  questWeekProgress(customerId, week, now, rules) {
    const time = this.questTime(rules);
    const from = time.at(week, 0);
    const to = time.at(addDays(week, 7), 0);
    const visits = this.stampTally(customerId, now, rules).rows.filter((r) => VISIT_KINDS.has(r.kind) && r.at >= from && r.at < to);
    const bounties = this.sql.exec(
      "SELECT key FROM loyalty_stamps WHERE customer_id = ? AND kind = 'quest' AND undone_at IS NULL AND note LIKE 'bounty-%' AND at >= ? AND at < ?",
      String(customerId), from, to,
    ).toArray().length;
    return {
      'lair-dweller': { have: Math.min(new Set(visits.map((v) => `${v.kind}:${v.id}`)).size, QUESTS_CONFIG.dwellerSessions), need: QUESTS_CONFIG.dwellerSessions },
      'bounty-hunter': { have: Math.min(bounties, QUESTS_CONFIG.hunterBounties), need: QUESTS_CONFIG.hunterBounties },
    };
  },

  /* ---------------- riddles (staff with Members) ---------------- */

  /** A riddle as staff see it */
  questRiddleView(r) {
    const solvedBy = this.sql.exec(
      "SELECT COUNT(DISTINCT customer_id) AS n FROM loyalty_stamps WHERE kind = 'quest' AND undone_at IS NULL AND note = 'riddle' AND key LIKE ?",
      `%:weekly:riddle:${r.week}`,
    ).one().n;
    return { id: r.id, week: r.week, text: r.text, hint: r.hint || '', answer: { productId: r.product_id, title: r.title, shelfCode: r.shelf_code || '' }, solvedBy };
  },

  /** GET /quests/riddles (staff, Members): every riddle from last week on, oldest first */
  async listRiddles(who) {
    this.requireStaff(who, 'members');
    const rules = await this.rules();
    if (this.questsOn(rules)) this.questSeedRiddles(Date.now(), rules);
    const since = addDays(weekOf(this.questTime(rules).key(Date.now())), -7);
    return { riddles: this.sql.exec('SELECT * FROM quest_riddles WHERE week >= ? ORDER BY week', since).toArray().map((r) => this.questRiddleView(r)) };
  },

  /** POST /quests/riddles { id?, week, text, hint?, code } (staff, Members): a new riddle or a change to one → { riddle } */
  async saveRiddle(input, who) {
    this.requireStaff(who, 'members');
    await this.rules();
    const week = String(input?.week ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || weekOf(week) !== week) throw new RuleError(QUEST_WORDS.riddleWeek, 422);
    const text = String(input?.text ?? '').trim();
    if (!text || text.length > QUESTS_CONFIG.riddleChars) throw new RuleError(QUEST_WORDS.riddleText, 422);
    const hint = String(input?.hint ?? '').trim();
    if (hint.length > QUESTS_CONFIG.hintChars) throw new RuleError(QUEST_WORDS.riddleHint, 422);
    const { game, save } = await this.findLibraryGame(input?.code);
    // --- no awaits from here on ---
    const now = Date.now();
    if (save) this.saveLibraryGame(save.game, now, save.codes);
    const existing = input?.id ? this.sql.exec('SELECT * FROM quest_riddles WHERE id = ?', String(input.id)).toArray()[0] : null;
    if (input?.id && !existing) throw new RuleError(QUEST_WORDS.riddleMissing, 404);
    const taken = this.sql.exec('SELECT id FROM quest_riddles WHERE week = ?', week).toArray()[0];
    if (taken && taken.id !== existing?.id) throw new RuleError(QUEST_WORDS.riddleTaken, 409);
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    const productId = plainId(game.productId);
    if (existing) {
      this.write('UPDATE quest_riddles SET week = ?, text = ?, hint = ?, product_id = ?, title = ?, shelf_code = ?, updated_at = ? WHERE id = ?',
        week, text, hint || null, productId, game.title, game.shelfCode || null, now, existing.id);
    } else {
      this.write('INSERT INTO quest_riddles (id, week, text, hint, product_id, title, shelf_code, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        makeId('qr'), week, text, hint || null, productId, game.title, game.shelfCode || null, by, now, now);
    }
    const row = this.sql.exec('SELECT * FROM quest_riddles WHERE week = ?', week).toArray()[0];
    return { riddle: this.questRiddleView(row) };
  },

  /** POST /quests/riddles/:id/remove (staff, Members): a riddle nobody has solved comes off → { ok: true } */
  async removeRiddle(id, who) {
    this.requireStaff(who, 'members');
    await this.rules();
    const row = this.sql.exec('SELECT * FROM quest_riddles WHERE id = ?', String(id)).toArray()[0];
    if (!row) throw new RuleError(QUEST_WORDS.riddleMissing, 404);
    if (this.questRiddleView(row).solvedBy > 0) throw new RuleError(QUEST_WORDS.riddleSolvedAlready, 409);
    this.write('DELETE FROM quest_riddles WHERE id = ?', row.id);
    return { ok: true };
  },

  /* ---------------- refunds and upkeep ---------------- */

  /** Which daily bounty a product counts towards ('drink', 'snack', 'icecream' or null), from what Shopify said of it */
  questBountyKind(productId) {
    const row = this.sql.exec('SELECT type FROM quest_products WHERE product_id = ?', plainId(productId)).toArray()[0];
    return BOUNTY_TYPES[row?.type] || null;
  },

  /**
   * The 10-minute run: this week's golden bounty and weekly quests picked, and refunds: every 30 minutes, orders with
   * facts from the last 60 days are asked about; a refunded die's fact is undone and a sale's drinks, snacks and ice
   * cream are counted again on what's left, then those members' quests are synced. Off unless quests are on.
   */
  async questUpkeep(now = Date.now(), rules = this.rulesCache) {
    if (!this.questsOn(rules)) return null;
    this.questWeek(weekOf(this.questTime(rules).key(now)), now, { rules });
    const since = now - QUESTS_CONFIG.refundDays * DAY;
    const due = this.sql.exec(
      `SELECT order_id, MIN(customer_id) AS customer_id FROM quest_facts WHERE order_id IS NOT NULL AND kind IN ('dice', 'buy') AND undone_at IS NULL AND at >= ?
        GROUP BY order_id HAVING MAX(COALESCE(checked_at, 0)) < ? LIMIT 100`,
      since, now - QUESTS_CONFIG.refundEvery,
    ).toArray();
    if (!due.length) return null;
    const orders = await this.shopify.questOrderLines(due.map((d) => d.order_id));
    // --- no awaits from here on ---
    const at = Date.now();
    let undone = 0;
    const touched = new Set();
    const byId = new Map(orders.map((o) => [String(o.id), o]));
    for (const d of due) {
      this.sql.exec('UPDATE quest_facts SET checked_at = ? WHERE order_id = ?', at, d.order_id);
      const o = byId.get(String(d.order_id));
      if (!o) continue;
      const lines = new Map((o.lines || []).map((l) => [plainId(l.id), l]));
      for (const f of this.sql.exec("SELECT * FROM quest_facts WHERE order_id = ? AND undone_at IS NULL AND kind IN ('dice', 'buy', 'line')", d.order_id).toArray()) {
        let gone = o.cancelled;
        if (!gone && f.kind === 'dice') {
          const line = lines.get(plainId(f.line_id));
          gone = Boolean(line) && Number(f.unit) > Math.max(0, Number(line.current_quantity) || 0);
        } else if (!gone && f.kind === 'line') {
          const line = lines.get(plainId(f.line_id));
          gone = Boolean(line) && Number(line.current_quantity) <= 0;
        } else if (!gone && f.kind === 'buy') {
          const left = (o.lines || []).filter((l) => this.questBountyKind(l.product_id) === f.ref).reduce((sum, l) => sum + linePaid(l, Math.max(0, Number(l.current_quantity) || 0)), 0);
          if (left !== Number(f.amount)) this.sql.exec('UPDATE quest_facts SET amount = ? WHERE id = ?', left, f.id);
          gone = left <= 0;
        }
        if (gone) {
          this.sql.exec('UPDATE quest_facts SET undone_at = ? WHERE id = ?', at, f.id);
          undone += 1;
          touched.add(f.customer_id);
        } else if (f.kind === 'buy') {
          touched.add(f.customer_id);
        }
      }
    }
    for (const id of touched) this.questSync(id, at, rules, { force: true });
    return undone ? { undone } : null;
  },
};

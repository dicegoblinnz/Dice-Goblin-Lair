// Dice Goblin Lair — one Durable Object holds every booking, game and hold.
//
// Concurrency: a Durable Object runs one piece of code at a time, but while it waits on Shopify (an outbound
// fetch) another request can run. So every handler does its Shopify waiting first, then reads, checks and writes
// with no `await` in between. Where a Shopify call has to come after a write (checkouts, store credit), the
// handler claims the row first and afterwards only updates the columns it owns.
import {
  ACTIVE, HOUR, MIN, ROLL_EVERY, LairTime, RuleError, addDays, birthdayPercent, checkGameDetails,
  checkGameSession, checkSeatBooking, checkTableBooking, codeKey, codeKeys, eventHolds, eventOccurrences, findOccurrence, isFree, legacyRefs, makeId,
  nextBirthday, oneRoom, parseBirthday, parseSpots, parseTableList, publicBooking, publicGame, readSettingsData, refundFor, rulesFromSettings,
  SERIES_SCHEDULES, seatPlayers, seatsTaken, tableIndex, uniqueCode,
  CARD_SIZE, financialYear, financialYearFrom, holdUntil, lairTime, libraryPlan, loyaltyCard, loyaltyMessage, loyaltyPrize, parseSince, wholeYears,
} from './core.js';
import { ShopifyAdmin, emailReady, sendEmail, sendEmails } from './shopify.js';
import { recordStatus, withConfig } from './config.js';
import { hoursSummary, renderEmail } from './email.js';
// Round 7: mobile numbers on customer bookings and in the player profile
import { checkMobile, mobileKey } from './core.js';
import { eventPayment } from './core.js';
// Round 8: friends on event sign-ups, each by member code or by name
import { GUEST_MESSAGES, guestList } from './core.js';
// Round 8: barcodes match with or without leading zeros
import { sameBarcode } from './core.js';
// Round 8: staff table holds that repeat weekly or fortnightly
import { HOLD_REPEATS, holdSeriesDays } from './core.js';
// Round 9, team: helpers and what they can do on the staff page
import { HELPER_DEFAULT, PERM_WORDS, STAFF_PERMS, canDo, cleanPerms } from './core.js';
// Round 9: the running tab and monthly accounts (their methods are copied onto Lair at the end of this file)
import { runningTabMethods } from './tab.js';
// Round 9, play: "I'm interested" for TTRPG sessions and "Maybe" for event dates (src/interest.js)
import { interestMethods } from './interest.js';
// Round 9: turnouts, lists of members and early access offers for regulars (their own file, mixed in at the end)
import { communityMethods } from './community.js';

const FALLBACK_ROOMS = [
  { id: 'main-room', name: 'Main room', code: 'T', tables: 21, seats: 4, order: 1 },
  { id: 'party-room', name: 'Party room', code: 'P', tables: 4, seats: 4, order: 2 },
  { id: 'gaming-room', name: 'Gaming room', code: 'G', tables: 4, seats: 4, order: 3 },
  { id: 'fancy-room', name: 'Fancy room', code: 'F', tables: 1, seats: 12, price: 15, minPeople: 4, order: 4 },
];
/** Permissions the Shopify app needs (checked by the health check) */
const REQUIRED_SCOPES = ['read_customers', 'read_metaobjects', 'read_themes', 'read_orders', 'write_draft_orders', 'write_store_credit_account_transactions'];
/** Permissions only some features need: everything else works without them */
const FEATURE_SCOPES = { write_discounts: 'birthday gift product codes', read_products: 'library copies, scanning library games and tab items', read_inventory: 'library copies on the shelf', write_metaobjects: 'staff adding and editing events', write_files: 'event pictures' };
// Round 9, team: a member's store credit balance on their staff page
FEATURE_SCOPES.read_store_credit_accounts = 'store credit balances on the staff member page';
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
/** Email wording: paying at the counter, being locked in after paying online, and splitting the bill */
const COUNTER = "Pay at the counter when you arrive. Show your code and we'll ring it up.";
const SHOW_CODE = 'Show your code at the counter when you arrive. Its QR code is in My Lair too.';
const LOCKED_IN_EMAIL = "You paid online, so you're locked in. Can't make it after all? Cancel in My Lair and have a chat with us about a refund.";
const SPLIT = 'Splitting the bill? Each friend can pay their share at the counter.';
/** A session pass sold as a product: an order line with this SKU makes `quantity` passes of N sessions each. */
const PASS_SKU = /^LAIR-PASS-(\d{1,3})$/i;
/** The most passes one order line makes (a typo in a quantity shouldn't make thousands) */
const PASSES_A_LINE = 100;
/** The holder of a pass sold with no customer on the sale and no name on the order */
const SOLD_AT_COUNTER = 'Sold at the counter';
/** How long a birthday gift's product code works */
const GIFT_CODE_DAYS = 30;
/** A session gift sold as a product (round 6): an order line with this SKU makes `quantity` unlinked gift passes of N sessions. */
const GIFT_SKU = /^LAIR-GIFT-(\d{1,3})$/i;
/** How to redeem a session gift, in the buyer's email (round 7: one box for every code, "Got a code?") */
const GIFT_REDEEM = "Log in at dicegoblin.nz, open My Lair › Wallet and enter the code under 'Got a code?'";
/** The roll Mo retired in round 6, and what's said when it's asked for */
const SPEND_RETIRED = 'The spend dice have retired. Fill your loyalty card: 10 sessions earn a roll.';
/** A library game's copies from Shopify are kept this long (10 minutes) */
const COPIES_TTL = 10 * MIN;
/** At most this many library games in one GET /library/status */
const STATUS_IDS = 60;
/** Round 7: a group (a league or a club, with passes of its own) has up to this many people */
const GROUP_MAX = 200;
/** Round 7, the events editor: an event's kinds and repeats (the lair_event definition's choices), and its "How people
    pay" words for the Lair's payment values */
const EVENT_TYPES = ['tcg', 'rpg', 'wargame', 'market', 'social', 'tournament', 'learn', 'launch', 'other'];
const EVENT_REPEATS = ['weekly', 'fortnightly', 'monthly'];
const EVENT_PAYMENT_WORDS = { store: 'In store', online: 'Online', either: 'Online or in store' };
/** How far ahead the events editor looks for an event's dates that people have signed up for */
const EVENT_DAYS = 400;
/** The events editor's answer while write_metaobjects or write_files waits for Mo's approval */
const EVENTS_DENIED = "Shopify hasn't let the Lair change events yet. Approve the app's new permissions in Shopify admin (Apps › Dice Goblin Lair), then try again.";
/** Shopify down (not a missing permission) while staff use the events editor */
const SHOPIFY_DOWN = "Shopify didn't answer just now. Try again in a minute.";
/** Picking a customer the Lair has never met, with no name to make their member record from */
const PICK_AGAIN = 'That customer could not be found. Pick them from the search again.';
/** A guest seat or sign-up joins the account with its email if it's upcoming or ended in the last 30 days */
const ADOPT_DAYS = 30;
/** Round 7: a barcode Shopify answered for (a tab item, or a code it didn't know) is kept 10 minutes */
const LOOKUP_TTL = 10 * MIN;
/** Round 7: tab barcode lookups a member can make in 10 minutes */
const TAB_LOOKUPS = 60;
/** Round 7: gifts from before round 7 whose product code is checked with Shopify, a maintenance run and a page view */
const GIFT_CHECKS_A_RUN = 20;
const GIFT_CHECKS_A_PAGE = 5;
/** Round 7: a gift's product code, and a claimed gift in My Lair, last this long (the code's 30 days) */
const GIFT_DAYS_MS = GIFT_CODE_DAYS * 24 * HOUR;
/** Round 7: what a scanned or typed library or tab code may hold */
const SCAN_CODE = /^[A-Za-z0-9._+-]{1,40}$/;
/** Round 7: the welcome loot code everyone gets (made on the staff page), and loot codes' own rules */
const ROLL_CODE_TEXT = /^[A-Z0-9-]{4,24}$/;
const ROLL_CODE_MESSAGES = {
  code: 'Codes are 4 to 24 letters, numbers or dashes, like ROLL-FOR-LOOT.',
  taken: "That code's taken. Pick another, or leave it empty and Gobgob will make one.",
  rolls: 'A code gives 1 to 20 rolls.',
  limit: 'The limit is how many times it can be used in all, from 1 up. Leave it empty for no limit.',
  date: 'Pick the last day it works from the calendar.',
  past: 'That date has already passed.',
  status: 'A code is active or inactive.',
};
/** Round 9, team: the staff page's member tools. Store credit goes on or off up to $1000 at a time (the birthday gift's
    cap); a staff member's emails to members are 120 and 4,000 characters at most, and 30 a day each. */
const CREDIT_MAX = 100000;
const MEMBER_EMAIL = { subject: 120, message: 4000, perDay: 30 };
const TEAM_WORDS = {
  notYours: "That's not one of your staff permissions. Ask the main account to tick it on the Team tab.",
  owner: 'Only the main account can change who helps on the staff page.',
  pickMember: 'Pick a member from the search, or type their member code.',
  noMember: 'No member has that code. Check it, or find them in the search.',
  ownerAlready: "That's the main account. It can do everything already.",
  self: "You can't change your own permissions. Ask the main account.",
  notHelper: "They're not a helper.",
  noPerms: 'Tick at least one thing they can do.',
};
/** Round 9: the permissions that see the floor as staff do (the desk, the floor, GM games and events all work from it) */
const FLOOR_STAFF = ['checkin', 'tables', 'sessions', 'events'];
/** Round 9: who changes a booking at the desk or on the floor (status, paid, people, moves); refunds and waiving are money */
const BOOKING_STAFF = ['checkin', 'tables'];

/** Schema changes go at the end of this list; each entry runs once. Entry 1 is the first release's schema. */
export const MIGRATIONS = [
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
  // Round 4: session passes ("Warhammer league: 10 sessions"). A use is recorded at check-in, so a no-show never
  // burns a session; covered is what passes have taken off a booking, and pass_id the pass saved for its check-in.
  [
    `CREATE TABLE IF NOT EXISTS passes (
      id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, label TEXT NOT NULL, sessions_total INTEGER NOT NULL, sessions_used INTEGER NOT NULL DEFAULT 0,
      cover INTEGER NOT NULL, customer_id TEXT, holder_name TEXT, holder_email TEXT, note TEXT, price_paid INTEGER, created_at INTEGER, created_by TEXT,
      expires_at INTEGER, status TEXT NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS passes_customer ON passes (customer_id)',
    `CREATE TABLE IF NOT EXISTS pass_uses (
      id TEXT PRIMARY KEY, pass_id TEXT NOT NULL, booking_id TEXT NOT NULL, people INTEGER NOT NULL, covered INTEGER NOT NULL, at INTEGER NOT NULL, by TEXT,
      undone_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS pass_uses_pass ON pass_uses (pass_id)',
    'CREATE INDEX IF NOT EXISTS pass_uses_booking ON pass_uses (booking_id)',
    'ALTER TABLE bookings ADD COLUMN pass_id TEXT',
    'ALTER TABLE bookings ADD COLUMN covered INTEGER NOT NULL DEFAULT 0',
  ],
  // Round 4: the self-serve tab. A member adds drinks and snacks in My Lair; at the counter the POS puts them in the
  // cart ('in-cart') and the paid order marks the tab 'paid'. One open tab a member a Lair day.
  [
    `CREATE TABLE IF NOT EXISTS tabs (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, day TEXT NOT NULL, items TEXT NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL,
      order_id TEXT, created_at INTEGER, updated_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS tabs_customer ON tabs (customer_id, day)',
  ],
  // Round 4: split the bill. paid_amount is what's been paid so far; payments has a row for each order line that paid
  // for a booking or sign-up, with who paid, and an order's line only ever counts once. split: the booker will split
  // the bill at the counter. Anything already marked paid was paid in full, so its paid_amount is its amount.
  [
    `CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, kind TEXT NOT NULL, order_id TEXT NOT NULL, line_id TEXT NOT NULL, amount INTEGER NOT NULL,
      customer_id TEXT, at INTEGER NOT NULL, UNIQUE (order_id, line_id))`,
    'CREATE INDEX IF NOT EXISTS payments_booking ON payments (booking_id)',
    'ALTER TABLE bookings ADD COLUMN paid_amount INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE bookings ADD COLUMN split INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE event_joins ADD COLUMN paid_amount INTEGER NOT NULL DEFAULT 0',
    'UPDATE bookings SET paid_amount = amount WHERE paid = 1 AND amount > 0',
    'UPDATE event_joins SET paid_amount = amount WHERE paid = 1 AND amount > 0',
  ],
  // Round 4: the checkout link of a sign-up or game spot held while it's paid online, so its owner can finish paying
  // from My Lair or the event on any device (GET /me sends it with held items, and only to the owner).
  [
    'ALTER TABLE bookings ADD COLUMN checkout_url TEXT',
    'ALTER TABLE event_joins ADD COLUMN checkout_url TEXT',
  ],
  // Round 5 (4 Oct 2026). Only new columns, tables and indexes, so the live rows stay as they are:
  //  - passes say where they came from: source 'staff' (empty on older passes), 'order' or 'birthday'. A pass sold as a
  //    product keeps its order, line and unit, and that triple is unique, so a repeated webhook never makes a second.
  //  - waived: staff let a weekly regular off a seat they owe.
  //  - series_alerts: "the next session is full" emails for weekly regulars, once per session and member.
  //  - gifts: birthday gifts staff give (store credit, a pass, dice rolls, a product code), one row each.
  [
    'ALTER TABLE passes ADD COLUMN source TEXT',
    'ALTER TABLE passes ADD COLUMN order_id TEXT',
    'ALTER TABLE passes ADD COLUMN order_name TEXT',
    'ALTER TABLE passes ADD COLUMN order_line TEXT',
    'ALTER TABLE passes ADD COLUMN order_unit INTEGER',
    'CREATE UNIQUE INDEX IF NOT EXISTS passes_order_unit ON passes (order_id, order_line, order_unit) WHERE order_id IS NOT NULL',
    'ALTER TABLE bookings ADD COLUMN waived INTEGER NOT NULL DEFAULT 0',
    'CREATE TABLE IF NOT EXISTS series_alerts (game_id TEXT NOT NULL, customer_id TEXT NOT NULL, at INTEGER, PRIMARY KEY (game_id, customer_id))',
    `CREATE TABLE IF NOT EXISTS gifts (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, year TEXT NOT NULL, credit INTEGER NOT NULL DEFAULT 0, credit_status TEXT,
      sessions INTEGER NOT NULL DEFAULT 0, pass_id TEXT, rolls INTEGER NOT NULL DEFAULT 0, product_variant_id TEXT, product_title TEXT,
      product_code TEXT, product_status TEXT, note TEXT, emailed INTEGER NOT NULL DEFAULT 0, problems TEXT, created_by TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS gifts_customer ON gifts (customer_id, created_at)',
    'CREATE UNIQUE INDEX IF NOT EXISTS gifts_product_code ON gifts (product_code) WHERE product_code IS NOT NULL',
  ],
  // Round 6 (5 Oct 2026). Only new columns, tables and indexes, so the live rows stay as they are:
  //  - loyalty_grants: loyalty rolls that don't come from the card: each member's welcome roll (once, a unique index)
  //    and rolls staff give. Stamps aren't stored: they're counted from checked-in bookings and sign-ups whenever
  //    they're read, so undoing a check-in takes its stamps back and nothing can drift.
  //  - members: customer_since (staff set it), shopify_since (when their Shopify account was made, read from Shopify;
  //    0 when Shopify has none) and account_email (their Shopify account's verified email: guest bookings with it become
  //    theirs), with when it was read.
  //  - spend_backfills: customers whose older orders were read from Shopify for the spend report, and how far back that
  //    could see ('recent': Shopify's last 60 days; 'all': with read_all_orders).
  //  - library_holds: board games reserved from the library ('held', 'collected', 'cancelled', 'expired', 'released').
  //  - blocks.game: the game a staff hold is for, like "Pokémon".
  [
    `CREATE TABLE IF NOT EXISTS loyalty_grants (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL, note TEXT, created_by TEXT, created_at INTEGER NOT NULL)`,
    "CREATE UNIQUE INDEX IF NOT EXISTS loyalty_grants_welcome ON loyalty_grants (customer_id) WHERE kind = 'welcome'",
    'CREATE INDEX IF NOT EXISTS loyalty_grants_customer ON loyalty_grants (customer_id, kind)',
    'ALTER TABLE members ADD COLUMN customer_since TEXT',
    'ALTER TABLE members ADD COLUMN shopify_since INTEGER',
    'ALTER TABLE members ADD COLUMN account_email TEXT',
    'ALTER TABLE members ADD COLUMN account_email_at INTEGER',
    'CREATE TABLE IF NOT EXISTS spend_backfills (customer_id TEXT PRIMARY KEY, scope TEXT NOT NULL, orders INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL)',
    `CREATE TABLE IF NOT EXISTS library_holds (
      id TEXT PRIMARY KEY, variant_id TEXT NOT NULL, product_id TEXT, title TEXT NOT NULL, shelf_code TEXT, handle TEXT, copies INTEGER,
      customer_id TEXT NOT NULL, status TEXT NOT NULL, until INTEGER NOT NULL, staff_note TEXT, created_by TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER, ended_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS library_holds_variant ON library_holds (variant_id, status)',
    'CREATE INDEX IF NOT EXISTS library_holds_customer ON library_holds (customer_id, status)',
    'CREATE INDEX IF NOT EXISTS library_holds_until ON library_holds (status, until)',
    'ALTER TABLE blocks ADD COLUMN game TEXT',
    // Guest sign-ups are matched to an account by email (bookings already have this index)
    'CREATE INDEX IF NOT EXISTS event_joins_email_lower ON event_joins (lower(email), ends_at)',
  ],
  // Round 7, backend-a (6 Oct 2026). New columns, tables and indexes only, plus two one-off copies into its own new
  // tables, so the live rows stay as they are:
  //  - members: the player profile (mobile, pronouns, favourite games as a JSON list, about me) and when it changed;
  //    event_joins.phone: the mobile on a sign-up.
  //  - roll_codes ("loot codes" to people): codes staff make that give loyalty rolls, once per customer
  //    (roll_code_uses); their text is in the codes table with kind 'roll', so no code is ever used twice.
  //  - gifts: when a gift's product code was used (and on which order), and when Shopify was last asked about it.
  //  - library: a hold's picture; games at home (library_loans: 'out' or 'returned', linked to the hold that was
  //    collected); the library games the Lair knows (library_games) and the codes that find them (library_codes:
  //    shelf codes, SKUs and barcodes, filled in code). The games handed over in round 6 are at home until staff say
  //    otherwise, and the games round 6's holds named are known.
  [
    'ALTER TABLE members ADD COLUMN mobile TEXT',
    'ALTER TABLE members ADD COLUMN pronouns TEXT',
    'ALTER TABLE members ADD COLUMN favourite_games TEXT',
    'ALTER TABLE members ADD COLUMN about TEXT',
    'ALTER TABLE members ADD COLUMN profile_updated_at INTEGER',
    'ALTER TABLE event_joins ADD COLUMN phone TEXT',
    `CREATE TABLE IF NOT EXISTS roll_codes (
      id TEXT PRIMARY KEY, code TEXT NOT NULL, rolls INTEGER NOT NULL, total_limit INTEGER, expires_at INTEGER, status TEXT NOT NULL,
      note TEXT, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS roll_code_uses (
      id TEXT PRIMARY KEY, code_id TEXT NOT NULL, customer_id TEXT NOT NULL, rolls INTEGER NOT NULL, grant_id TEXT, at INTEGER NOT NULL,
      UNIQUE (code_id, customer_id))`,
    'CREATE INDEX IF NOT EXISTS roll_code_uses_code ON roll_code_uses (code_id, at)',
    'ALTER TABLE gifts ADD COLUMN product_used_at INTEGER',
    'ALTER TABLE gifts ADD COLUMN product_order TEXT',
    'ALTER TABLE gifts ADD COLUMN product_checked_at INTEGER',
    'ALTER TABLE library_holds ADD COLUMN image TEXT',
    `CREATE TABLE IF NOT EXISTS library_loans (
      id TEXT PRIMARY KEY, variant_id TEXT NOT NULL, product_id TEXT, title TEXT NOT NULL, shelf_code TEXT, handle TEXT, image TEXT,
      customer_id TEXT NOT NULL, hold_id TEXT, status TEXT NOT NULL, out_at INTEGER NOT NULL, returned_at INTEGER, out_by TEXT,
      returned_by TEXT, staff_note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS library_loans_variant ON library_loans (variant_id, status)',
    'CREATE INDEX IF NOT EXISTS library_loans_customer ON library_loans (customer_id, status)',
    'CREATE UNIQUE INDEX IF NOT EXISTS library_loans_hold ON library_loans (hold_id) WHERE hold_id IS NOT NULL',
    `CREATE TABLE IF NOT EXISTS library_games (
      variant_id TEXT PRIMARY KEY, product_id TEXT, title TEXT NOT NULL, handle TEXT, shelf_code TEXT, image TEXT, checked_at INTEGER NOT NULL)`,
    'CREATE TABLE IF NOT EXISTS library_codes (key TEXT PRIMARY KEY, variant_id TEXT NOT NULL)',
    // the games handed over in round 6 are at home until staff say otherwise
    `INSERT OR IGNORE INTO library_loans (id, variant_id, product_id, title, shelf_code, handle, image, customer_id, hold_id, status, out_at,
      returned_at, out_by, returned_by, staff_note, created_at, updated_at)
      SELECT 'ln_' || id, variant_id, product_id, title, shelf_code, handle, NULL, customer_id, id, 'out',
        COALESCE(ended_at, updated_at, created_at), NULL, 'staff', NULL, NULL, COALESCE(ended_at, updated_at, created_at), COALESCE(ended_at, updated_at, created_at)
      FROM library_holds WHERE status = 'collected'`,
    // the games round 6's holds already named
    `INSERT OR IGNORE INTO library_games (variant_id, product_id, title, handle, shelf_code, image, checked_at)
      SELECT variant_id, MAX(product_id), MAX(title), MAX(handle), MAX(shelf_code), NULL, MAX(created_at) FROM library_holds GROUP BY variant_id`,
  ],
  // Round 7, groups and staff sessions (6 Oct 2026). Only new tables, columns and indexes:
  //  - lair_groups and lair_group_members: groups of customers (GROUPS is an SQLite keyword); a pass can belong to a
  //    group (passes.group_id), and any member of an active group can use it.
  //  - series_invites: a seat staff reserved under a name and email at a weekly game, waiting for that person to make an
  //    account ('waiting', 'joined' or 'cancelled'). A GM invite needs no table: a game with gm_email and no account.
  [
    `CREATE TABLE IF NOT EXISTS lair_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, organiser_id TEXT, note TEXT, status TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS lair_group_members (
      group_id TEXT NOT NULL, customer_id TEXT NOT NULL, added_by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (group_id, customer_id))`,
    'CREATE INDEX IF NOT EXISTS lair_group_members_customer ON lair_group_members (customer_id)',
    'ALTER TABLE passes ADD COLUMN group_id TEXT',
    'CREATE INDEX IF NOT EXISTS passes_group ON passes (group_id)',
    `CREATE TABLE IF NOT EXISTS series_invites (
      id TEXT PRIMARY KEY, series_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, people INTEGER NOT NULL, players TEXT,
      status TEXT NOT NULL, customer_id TEXT, booking_id TEXT, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS series_invites_email ON series_invites (lower(email), status)',
    'CREATE INDEX IF NOT EXISTS games_gm_email ON games (lower(gm_email))',
  ],
  // Round 8, weekly table holds (9 Oct 2026). Only a new column, index and table, so the live rows stay as they are:
  //  - block_series: a staff hold that repeats every 7 or 14 days (every_days) from first_day at the same Lair clock time
  //    (start_min) for `minutes`, up to until_day (included) when it has one, leaving out skip_days (a JSON list of
  //    'YYYY-MM-DD'). status 'active' or 'stopped'. Its dates are ordinary blocks rows with series_id, so availability,
  //    the floor and every check read them as before.
  [
    'ALTER TABLE blocks ADD COLUMN series_id TEXT',
    'CREATE INDEX IF NOT EXISTS blocks_series ON blocks (series_id, starts_at)',
    `CREATE TABLE IF NOT EXISTS block_series (
      id TEXT PRIMARY KEY, tables TEXT NOT NULL, start_min INTEGER NOT NULL, minutes INTEGER NOT NULL, every_days INTEGER NOT NULL,
      first_day TEXT NOT NULL, until_day TEXT, skip_days TEXT, label TEXT, type TEXT, game TEXT, status TEXT NOT NULL,
      created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER)`,
  ],
  // Round 8, guests (9 Oct 2026): friends on event sign-ups. A new table only: one row for each person coming with
  // whoever signed up, by member code (their customer ID, the name the Lair has for them and their code) or by name.
  [
    `CREATE TABLE IF NOT EXISTS event_join_guests (
      id TEXT PRIMARY KEY, join_id TEXT NOT NULL, customer_id TEXT, name TEXT NOT NULL, code TEXT, created_at INTEGER NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS event_join_guests_join ON event_join_guests (join_id)',
    'CREATE INDEX IF NOT EXISTS event_join_guests_customer ON event_join_guests (customer_id)',
  ],
  // Round 9, team (9 Oct 2026): helpers and the staff page's member tools. New tables and one new column only:
  //  - staff_helpers: members the owner made helpers (perms: a JSON list of permission keys), 'active' or 'removed' (a
  //    removed helper's row stays for the record), who made them and since when.
  //  - staff_log: every grant, change and removal (customer, action, perms after, by, when).
  //  - member_credit: store credit staff added (+) or took off (−), in cents, with the note, who, when, and Shopify's
  //    transaction and balance after ('pending' while Shopify is asked, then 'done' or 'failed'). key: the page's own
  //    key for one change, so a repeated request never moves money twice.
  //  - member_emails: emails staff sent a member from their page (subject, 'sending', 'sent' or 'failed', who, when).
  //  - event_joins.added_by: the staff member who added a sign-up for someone (staff:<customer id>), else empty.
  [
    `CREATE TABLE IF NOT EXISTS staff_helpers (
      customer_id TEXT PRIMARY KEY, perms TEXT NOT NULL, status TEXT NOT NULL, made_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS staff_log (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, action TEXT NOT NULL, perms TEXT, by TEXT, at INTEGER NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS staff_log_customer ON staff_log (customer_id, at)',
    `CREATE TABLE IF NOT EXISTS member_credit (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, amount INTEGER NOT NULL, note TEXT, status TEXT NOT NULL, transaction_id TEXT,
      balance_after INTEGER, message TEXT, key TEXT UNIQUE, by TEXT, at INTEGER NOT NULL, updated_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS member_credit_customer ON member_credit (customer_id, at)',
    `CREATE TABLE IF NOT EXISTS member_emails (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, email TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL, message TEXT, by TEXT,
      at INTEGER NOT NULL, updated_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS member_emails_customer ON member_emails (customer_id, at)',
    'CREATE INDEX IF NOT EXISTS member_emails_by ON member_emails (by, at)',
    'ALTER TABLE event_joins ADD COLUMN added_by TEXT',
  ],
  // Round 9, the running tab (9 Oct 2026). Only new tables, so the live rows stay as they are:
  //  - tab_accounts: a member staff put on a monthly account ('monthly') or back to paying each visit ('visit'), with
  //    their credit limit in cents, a note, who set it and when. periods: a JSON list of [from, until] (until null while
  //    it's monthly): what was checked in, or put on a tab, in a monthly period is on their account until it's paid.
  //  - tab_bills: a member's bill ('month': the monthly bill, one per member and month; 'now': one made on request) with
  //    its items (JSON), total, status ('open', 'paid' or 'void'), the Shopify draft order and its invoice URL, and how
  //    it was paid ('online' or 'counter').
  [
    `CREATE TABLE IF NOT EXISTS tab_accounts (
      customer_id TEXT PRIMARY KEY, billing TEXT NOT NULL, credit_limit INTEGER NOT NULL DEFAULT 0, note TEXT, periods TEXT NOT NULL DEFAULT '[]',
      set_by TEXT, set_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS tab_bills (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, kind TEXT NOT NULL, month TEXT, items TEXT NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL,
      draft_order_id TEXT, invoice_url TEXT, order_id TEXT, paid_how TEXT, void_reason TEXT, made_by TEXT, created_at INTEGER NOT NULL,
      emailed_at INTEGER, reminded_at INTEGER, paid_at INTEGER, voided_at INTEGER, updated_at INTEGER)`,
    "CREATE UNIQUE INDEX IF NOT EXISTS tab_bills_month ON tab_bills (customer_id, month) WHERE kind = 'month'",
    'CREATE INDEX IF NOT EXISTS tab_bills_customer ON tab_bills (customer_id, status)',
    'CREATE INDEX IF NOT EXISTS tab_bills_status ON tab_bills (status, created_at)',
  ],
  // Round 9, play (9 Oct 2026): "I'm interested" in a TTRPG session and "Maybe" (or "I'm coming", for an event with no
  // sign-ups) for an event date. A new table only: one row per person (customer_id, or their email) per session or date
  // (kind 'session' with target_id the game's id, or 'event' with the occurrence id), level 'interested', 'maybe' or
  // 'coming', status 'active' or 'removed'. remove_key lets a guest take theirs back from the browser that made it.
  [
    `CREATE TABLE IF NOT EXISTS interests (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_id TEXT NOT NULL, level TEXT NOT NULL, status TEXT NOT NULL, name TEXT NOT NULL,
      email TEXT NOT NULL, phone TEXT, note TEXT, customer_id TEXT, remove_key TEXT, title TEXT, starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL, notified_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS interests_target ON interests (kind, target_id, status)',
    'CREATE INDEX IF NOT EXISTS interests_time ON interests (ends_at, starts_at)',
    'CREATE INDEX IF NOT EXISTS interests_customer ON interests (customer_id, ends_at)',
    'CREATE UNIQUE INDEX IF NOT EXISTS interests_one ON interests (kind, target_id, lower(email)) WHERE status = \'active\'',
  ],
  // Round 9, community (9 Oct 2026). Only a new column, new tables and indexes, so the live rows stay as they are:
  //  - event_joins.source: 'walk-in' for someone staff checked in at an event they hadn't signed up for (null otherwise).
  //  - community_lists and community_list_members: lists of members staff save ("Pokémon regulars, Oct").
  //  - early_offers, early_offer_members and early_offer_claims: early access to a Shopify product for some members, who
  //    it's for (a copy of the list and the people picked when it was saved), and each member's claims ('creating' while
  //    the checkout is made, 'waiting' unpaid, 'paid', 'released' when let go, with the reason).
  [
    'ALTER TABLE event_joins ADD COLUMN source TEXT',
    `CREATE TABLE IF NOT EXISTS community_lists (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS community_list_members (
      list_id TEXT NOT NULL, customer_id TEXT NOT NULL, added_by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (list_id, customer_id))`,
    'CREATE INDEX IF NOT EXISTS community_list_members_customer ON community_list_members (customer_id)',
    `CREATE TABLE IF NOT EXISTS early_offers (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, product_title TEXT NOT NULL, product_handle TEXT, image TEXT, product_status TEXT, published INTEGER,
      variants TEXT NOT NULL, per_person INTEGER NOT NULL, total_units INTEGER, opens_at INTEGER, closes_at INTEGER NOT NULL, message TEXT, status TEXT NOT NULL,
      list_id TEXT, email INTEGER NOT NULL DEFAULT 0, emailed_at INTEGER, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER, opened_at INTEGER,
      closed_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS early_offer_members (
      offer_id TEXT NOT NULL, customer_id TEXT NOT NULL, source TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (offer_id, customer_id))`,
    'CREATE INDEX IF NOT EXISTS early_offer_members_customer ON early_offer_members (customer_id)',
    `CREATE TABLE IF NOT EXISTS early_offer_claims (
      id TEXT PRIMARY KEY, offer_id TEXT NOT NULL, customer_id TEXT NOT NULL, variant_id TEXT NOT NULL, variant_title TEXT, price INTEGER, quantity INTEGER NOT NULL,
      status TEXT NOT NULL, reason TEXT, draft_order_id TEXT, checkout_url TEXT, order_id TEXT, expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER,
      paid_at INTEGER, ended_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS early_offer_claims_offer ON early_offer_claims (offer_id, status)',
    'CREATE INDEX IF NOT EXISTS early_offer_claims_customer ON early_offer_claims (customer_id, offer_id)',
  ],
];

const BOOKING_COLUMNS = [
  'id', 'ref', 'kind', 'status', 'tables', 'room', 'starts_at', 'ends_at', 'people', 'name', 'email', 'phone', 'notes', 'activity',
  'extras', 'pay', 'paid', 'amount', 'game_id', 'customer_id', 'hold_until', 'draft_order_id', 'order_id', 'party', 'arrived_at',
  'refund', 'series_id', 'occurrence_id', 'pass_id', 'covered', 'paid_amount', 'split', 'waived', 'created_at', 'updated_at',
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
/** Short money for titles and notices: $10, or $12.50 */
const money = (cents) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** What's still owed on a booking or sign-up: its amount less what passes covered and what's been paid. */
const owing = (x) => Math.max(0, (x.amount || 0) - (x.covered || 0) - (x.paidAmount || 0));
/** What's left to pay at the counter: nothing for a GM's own table, once it's paid, or when staff waived it. */
const dueOf = (x) => (x.paid || x.kind === 'gm' || x.waived ? 0 : owing(x));
/** paid, worked out again after a payment or a pass: true once something was owed and nothing is left. */
const settled = (x) => ((x.amount || 0) > 0 ? owing(x) === 0 : Boolean(x.paid));
/** What an order line paid, in cents: its price times its quantity, less that line's discounts. */
const lineAmount = (item) => {
  const cents = (value) => Math.round(Number(value || 0) * 100) || 0;
  const gross = cents(item.price ?? item.price_set?.shop_money?.amount) * Math.max(0, Math.floor(Number(item.quantity ?? 1)) || 0);
  const discounts = (item.discount_allocations || []).reduce((sum, d) => sum + cents(d.amount ?? d.amount_set?.shop_money?.amount), 0);
  return Math.max(0, gross - discounts);
};
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
    // Round 6: library copies from Shopify (variant ID → { at, copies }), Shopify lookups waiting to retry after a
    // failure (key → ms), spend backfills under way (customer ID → promise) and the scopes the store granted.
    this.copiesCache = new Map();
    this.retryAt = new Map();
    this.backfilling = new Map();
    this.grantedScopes = null;
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
    // A weekly regular owes for a seat they didn't pay for (round 5), but only for seats made once round 5 is running:
    // a seat booked under the old rules is never owed. The first start of round 5 notes when that was.
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('owed-from', ?)", String(Date.now()));
    this.owedFrom = Number(this.sql.exec("SELECT value FROM meta WHERE key = 'owed-from'").toArray()[0]?.value) || 0;
    // Round 9: the running tab only counts what's checked in (or put on a tab) from its first start, so old records
    // never start nagging.
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('tab-from', ?)", String(Date.now()));
    this.tabFrom = Number(this.sql.exec("SELECT value FROM meta WHERE key = 'tab-from'").toArray()[0]?.value) || 0;
    // The loyalty card (round 6) starts brand new: only sessions starting from round 6's first start earn stamps.
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('loyalty-from', ?)", String(Date.now()));
    this.loyaltyFrom = Number(this.sql.exec("SELECT value FROM meta WHERE key = 'loyalty-from'").toArray()[0]?.value) || 0;
    // Round 7: from its first start the orders/paid webhook notices a birthday gift's product code being used; gifts
    // made before then are checked with Shopify once each (checkGiftCodes).
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('gift-codes-from', ?)", String(Date.now()));
    this.giftCodesFrom = Number(this.sql.exec("SELECT value FROM meta WHERE key = 'gift-codes-from'").toArray()[0]?.value) || 0;
    // Round 7: the library games round 6's holds named are found by their shelf codes too, once (a scan of the label)
    if (!this.sql.exec("SELECT value FROM meta WHERE key = 'library-codes-filled'").toArray().length) {
      for (const g of this.sql.exec("SELECT variant_id, shelf_code FROM library_games WHERE shelf_code IS NOT NULL AND shelf_code != ''").toArray()) {
        if (codeKey(g.shelf_code)) this.sql.exec('INSERT OR IGNORE INTO library_codes (key, variant_id) VALUES (?, ?)', codeKey(g.shelf_code), g.variant_id);
      }
      this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('library-codes-filled', ?)", String(Date.now()));
    }
    // Round 7: Gobgob's welcome loot code, made once (Mo, 6 Oct: ROLL-FOR-LOOT, 1 roll for every customer, no limit, no
    // last day). Staff change it or switch it off on the Loot codes tab, and it's never made again.
    if (!this.sql.exec("SELECT value FROM meta WHERE key = 'welcome-loot-code'").toArray().length) {
      const code = 'ROLL-FOR-LOOT';
      if (!this.codeTaken(codeKey(code))) {
        const id = makeId('rc');
        const now = Date.now();
        this.sql.exec("INSERT INTO codes (key, code, kind, target_id, created_at) VALUES (?, ?, 'roll', ?, ?)", codeKey(code), code, id, now);
        this.sql.exec(
          `INSERT INTO roll_codes (id, code, rolls, total_limit, expires_at, status, note, created_by, created_at, updated_at)
           VALUES (?, ?, 1, NULL, NULL, 'active', ?, 'setup', ?, ?)`,
          id, code, "Gobgob's welcome loot, for every customer", now, now,
        );
      }
      this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('welcome-loot-code', ?)", String(Date.now()));
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
      // passId: the session pass to use at check-in; covered: what passes have taken off it so far.
      passId: r.pass_id || null, covered: r.covered || 0,
      // paidAmount: what's been paid so far (a split bill is paid in parts); split: the booker is splitting the bill.
      paidAmount: r.paid_amount || 0, split: Boolean(r.split),
      // waived: staff let a weekly regular off what they owed for this seat, so nothing is due.
      waived: Boolean(r.waived), createdAt: r.created_at || null,
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
    // game (round 6): what a staff hold is for, like "Pokémon", for the calendar's sub-categories (null when not said).
    // seriesId (round 8): the weekly or fortnightly hold it's a date of, or null (only staff see it: floor()).
    return {
      id: r.id, tables: parse(r.tables, []), start: r.starts_at, end: r.ends_at, label: r.label, type: r.type, game: r.game || null,
      seriesId: r.series_id || null,
    };
  }

  rowToOpening(r) {
    return { id: r.id, tables: parse(r.tables, []), start: r.starts_at, end: r.ends_at, note: r.note || '' };
  }

  rowToJoin(r) {
    return {
      id: r.id, ref: r.ref, occurrenceId: r.occurrence_id, eventId: r.event_id, title: r.title, start: r.starts_at, end: r.ends_at,
      people: r.people, name: r.name, email: r.email, note: r.note || '', status: r.status, customerId: r.customer_id, arrivedAt: r.arrived_at || null,
      pay: r.pay || 'day', paid: Boolean(r.paid), amount: r.amount || 0, holdUntil: r.hold_until || null, draftOrderId: r.draft_order_id || null,
      orderId: r.order_id || null, refund: r.refund || null, paidAmount: r.paid_amount || 0,
      // round 7: the mobile they gave (sign-ups from before have none)
      phone: r.phone || '',
    };
  }

  joinById(id) {
    const row = this.sql.exec('SELECT * FROM event_joins WHERE id = ? OR ref = ?', id, id).toArray()[0];
    return row ? this.rowToJoin(row) : null;
  }

  /**
   * A sign-up as its owner sees it. payment: how it is or will be paid ('online' once it went to checkout, otherwise
   * 'store', at the counter). refund: null, 'ask' (staff decide), 'due' or 'done'. Round 8: guests, who's coming with
   * them ({ name, member }: member when they have an account; never a code or an ID). guests: the sign-up's guest rows
   * when a list has them already (guestsIn), or they're looked up.
   */
  joinView(j, guests = null) {
    return {
      id: j.id, ref: j.ref, occurrenceId: j.occurrenceId, title: j.title, start: j.start, end: j.end, people: j.people, name: j.name, status: j.status,
      pay: j.pay, paid: j.paid, amount: j.amount, payment: j.pay === 'now' ? 'online' : 'store', refund: j.refund || null,
      paidAmount: j.paidAmount || 0, due: dueOf(j),
      guests: (guests || this.joinGuests(j.id)).map((g) => ({ name: g.name, member: Boolean(g.customer_id) })),
    };
  }

  /**
   * A sign-up as staff see it, with who paid what (payments: from a list's paymentsIn, or looked up), and (round 7) their
   * mobile. Round 8: guests adds each one's customerId and member code (their code now, if staff have given them a new
   * one since). guests: as joinView.
   */
  staffJoinView(j, payments = null, guests = null) {
    const list = guests || this.joinGuests(j.id);
    return {
      ...this.joinView(j, list), email: j.email, note: j.note, arrivedAt: j.arrivedAt, customerId: j.customerId || null, orderId: j.orderId || null,
      due: dueOf(j), payments: payments || this.paymentsOf('join', j.id), phone: j.phone || '', guests: list.map((g) => this.staffGuest(g)),
    };
  }

  /** The floor's sign-ups for staff (round 8: with their guests): staffJoinView for each, the window's payments and guests read once */
  staffJoins(joinRows, payments, from, to) {
    const guests = this.guestsIn(from, to);
    return joinRows.map((j) => this.staffJoinView(j, payments.get(j.id) || [], guests.get(j.id) || []));
  }

  /** Round 8: a guest on a sign-up as staff see it: { name, member, customerId, code } */
  staffGuest(g) {
    return { name: g.name, member: Boolean(g.customer_id), customerId: g.customer_id || null, code: g.member_code || g.code || null };
  }

  /** Round 8: one sign-up's guest rows, in the order they were added, with each member's code now (member_code). No awaits. */
  joinGuests(joinId) {
    return this.sql
      .exec('SELECT g.*, m.code AS member_code FROM event_join_guests g LEFT JOIN members m ON m.customer_id = g.customer_id WHERE g.join_id = ? ORDER BY g.rowid', String(joinId))
      .toArray();
  }

  /** Round 8: the guest rows of every sign-up in [from, to), by its id, for lists (as joinGuests). No awaits. */
  guestsIn(from, to) {
    const byJoin = new Map();
    const rows = this.sql
      .exec(
        `SELECT g.*, m.code AS member_code FROM event_join_guests g JOIN event_joins j ON j.id = g.join_id LEFT JOIN members m ON m.customer_id = g.customer_id
         WHERE j.ends_at > ? AND j.starts_at < ? ORDER BY g.rowid`,
        from, to,
      )
      .toArray();
    for (const r of rows) {
      if (!byJoin.has(r.join_id)) byJoin.set(r.join_id, []);
      byJoin.get(r.join_id).push(r);
    }
    return byJoin;
  }

  /** A game picture's public address (pictures are served by the Worker at /img/<id>) */
  imageUrl(id) {
    return id ? `${String(this.env.PUBLIC_URL || '').replace(/\/$/, '')}/img/${id}` : null;
  }

  /**
   * A game as the games board and its GM see it, with its picture. A session of a series adds series: { id, schedule,
   * regulars } (regulars: how many people are regulars, each with their seats saved every session, however many seats
   * that is) and nextOnly: true when it's the series'
   * next session that hasn't ended, the only one the public board shows. taken counts the seats held for regulars
   * (held) too. info: seriesInfo, shared by a list.
   */
  gameView(g, st, rules, info = null) {
    const series = g.seriesId ? info || this.seriesInfo(Date.now()) : null;
    const held = g.seriesId ? this.heldIn(st).get(g.id) || 0 : 0;
    return {
      ...publicGame(g, st, rules, held), image: this.imageUrl(g.imageId),
      series: series ? { id: g.seriesId, schedule: SERIES_SCHEDULES.includes(g.schedule) ? g.schedule : 'flexible', regulars: series.regulars.get(g.seriesId) || 0 } : null,
      nextOnly: Boolean(series && series.next.get(g.seriesId) === g.id),
    };
  }

  /**
   * Weekly regulars ("join every session"), for game views: each series' next session that hasn't ended (cancelled
   * ones don't count), and how many people are regulars (members, not seats: a regular who brings a friend is one,
   * as the theme's demo counts them; the seats they hold are in heldIn). No awaits.
   */
  seriesInfo(now) {
    const next = this.sql
      .exec("SELECT series_id, id, MIN(starts_at) AS first FROM games WHERE series_id IS NOT NULL AND status != 'cancelled' AND ends_at > ? GROUP BY series_id", now)
      .toArray();
    const regulars = this.sql.exec("SELECT series_id, COUNT(*) AS n FROM series_members WHERE status = 'active' GROUP BY series_id").toArray();
    return { next: new Map(next.map((r) => [r.series_id, r.id])), regulars: new Map(regulars.map((r) => [r.series_id, r.n])) };
  }

  /** A series' next session that hasn't ended (cancelled ones don't count), or null. No awaits. */
  nextSession(seriesId, now) {
    const row = this.sql.exec("SELECT * FROM games WHERE series_id = ? AND status != 'cancelled' AND ends_at > ? ORDER BY starts_at, id LIMIT 1", seriesId, now).toArray()[0];
    return row ? this.rowToGame(row) : null;
  }

  /**
   * A series' next session that hasn't started, or null: where a regular joining now gets their seat. (A session
   * already under way is never booked for them: they'd owe for a session they weren't at.) No awaits.
   */
  upcomingSession(seriesId, now) {
    const row = this.sql.exec("SELECT * FROM games WHERE series_id = ? AND status != 'cancelled' AND starts_at > ? ORDER BY starts_at, id LIMIT 1", seriesId, now).toArray()[0];
    return row ? this.rowToGame(row) : null;
  }

  /**
   * Seats held for weekly regulars at each series session in a state's window that hasn't started, by game id: the
   * people of every active member with no booking there yet (one they cancelled counts as a booking: they're skipping
   * that session). A cancelled session holds nothing. Worked out once per state. (publicGame keeps the count to the
   * seats still free.)
   */
  heldIn(st) {
    if (!st.held) {
      const rows = this.sql.exec(
        `SELECT g.id AS game_id, SUM(m.people) AS n FROM games g JOIN series s ON s.id = g.series_id AND s.status = 'active'
           JOIN series_members m ON m.series_id = g.series_id AND m.status = 'active'
         WHERE g.series_id IS NOT NULL AND g.status != 'cancelled' AND g.ends_at > ? AND g.starts_at < ? AND g.starts_at > ?
           AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.game_id = g.id AND b.kind = 'gm-seat' AND b.customer_id = m.customer_id)
         GROUP BY g.id`,
        st.from ?? 0, st.to ?? Number.MAX_SAFE_INTEGER, Date.now(),
      ).toArray();
      st.held = new Map(rows.map((r) => [r.game_id, r.n]));
    }
    return st.held;
  }

  /**
   * Seats held at one session for its series' regulars with no booking there yet (as heldIn; nothing once it has
   * started, since nobody is seated in a session under way, or once it's cancelled): what anyone who isn't a regular
   * there has to leave free. except: a customer whose own hold doesn't count (they're the one booking). No awaits.
   */
  regularsWaiting(game, { except = null, now = Date.now() } = {}) {
    if (!game?.seriesId || game.start <= now || game.status === 'cancelled') return 0;
    return this.sql.exec(
      `SELECT COALESCE(SUM(m.people), 0) AS n FROM series_members m JOIN series s ON s.id = m.series_id AND s.status = 'active'
       WHERE m.series_id = ? AND m.status = 'active' AND m.customer_id != ?
         AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.game_id = ? AND b.kind = 'gm-seat' AND b.customer_id = m.customer_id)`,
      game.seriesId, String(except ?? ''), game.id,
    ).one().n;
  }

  /**
   * The seats a regular has to leave at one session for the regulars who joined before them and are still waiting
   * for a seat there. Regulars are seated first to join first, each taking their seats while there's room, and one who
   * doesn't fit keeps nothing from the next: the same queue maintenance seats them in (rollSeries), so someone joining
   * hears what maintenance would do. No awaits.
   */
  seatsAhead(session, member, now = Date.now()) {
    if (!session?.seriesId || session.start <= now || session.status === 'cancelled') return 0;
    // rollSeries's order: when they joined (a row without a time sorts first, as SQLite sorts NULLs), then customer ID.
    const joined = member.created_at ?? -1;
    const waiting = this.sql.exec(
      `SELECT m.people FROM series_members m JOIN series s ON s.id = m.series_id AND s.status = 'active'
       WHERE m.series_id = ? AND m.status = 'active' AND m.customer_id != ?
         AND (COALESCE(m.created_at, -1) < ? OR (COALESCE(m.created_at, -1) = ? AND m.customer_id < ?))
         AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.game_id = ? AND b.kind = 'gm-seat' AND b.customer_id = m.customer_id)
       ORDER BY m.created_at, m.customer_id`,
      session.seriesId, String(member.customer_id), joined, joined, String(member.customer_id), session.id,
    ).toArray();
    let free = session.seats - this.takenSeats(session.id);
    let ahead = 0;
    for (const { people } of waiting) {
      if (people > free) continue;
      free -= people;
      ahead += people;
    }
    return ahead;
  }

  /**
   * Who's in a game's seats (for its GM and for staff). Round 7: each player says whether the seat is on an account
   * (member) and whether it's a weekly regular's (regular), and the first player of a seat on an account brings that
   * account's pronouns, favourite games and about me from their player profile. Never a mobile, email or birthday.
   */
  gamePlayers(st, gameId) {
    const profiles = new Map();
    const profileOf = (customerId) => {
      if (!profiles.has(customerId)) {
        const m = this.memberRow(customerId);
        profiles.set(customerId, { pronouns: m?.pronouns || '', favouriteGames: parse(m?.favourite_games, []), about: m?.about || '' });
      }
      return profiles.get(customerId);
    };
    return st.bookings
      .filter((b) => b.gameId === gameId && b.kind === 'gm-seat' && ACTIVE.has(b.status))
      .flatMap((b) => {
        const party = b.party?.length ? b.party : [{ name: b.name, character: '' }];
        return party.map((p, i) => ({
          name: p.name, character: p.character || '', ref: b.ref, paid: b.paid, arrived: Boolean(b.arrivedAt) || b.status === 'seated',
          member: Boolean(b.customerId), regular: Boolean(b.seriesId), ...(i === 0 && b.customerId ? profileOf(b.customerId) : {}),
        }));
      });
  }

  /** Everything that touches the window [from, to) */
  state(from, to) {
    return {
      from, to,
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
      b.party?.length ? JSON.stringify(b.party) : null, b.arrivedAt || null, b.refund || null, b.seriesId || null, b.occurrenceId || null,
      b.passId || null, b.covered || 0, b.paidAmount || 0, b.split ? 1 : 0, b.waived ? 1 : 0, now, now,
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
      const found = this.passRow(row.target_id);
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

  /**
   * Staff and trusted GMs are customers tagged "staff" or "gm" in Shopify. Round 9: role 'owner' (tagged staff: every
   * permission, 'team' too), 'helper' (made a helper on the staff page: staff, with the permissions ticked) or null, and
   * perms. Tags are kept for 5 minutes; whether someone is a helper is read fresh every time, so a change on the Team tab
   * counts straight away.
   */
  async person(customerId) {
    return this.withRole(await this.taggedPerson(customerId));
  }

  /** Round 9: a person from their tags (person() before round 9), not yet with their role. */
  async taggedPerson(customerId) {
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
    // tags (lower case) also say their library plan (Simplee's tags, round 6)
    const person = { customerId, staff: tags.includes('staff'), gm: tags.includes('gm'), tags };
    if (ok) {
      if (this.people.size > 500) this.people.clear();
      this.people.set(customerId, { at: Date.now(), person });
    }
    return person;
  }

  /** Round 9: a tagged person with their role and perms, read now (a new object: the cached one never changes). No awaits. */
  withRole(person) {
    if (!person?.customerId) return { ...person, role: null, perms: [] };
    if (person.staff) return { ...person, role: 'owner', perms: [...STAFF_PERMS, 'team'] };
    const helper = this.helperRow(person.customerId);
    if (helper) return { ...person, staff: true, role: 'helper', perms: cleanPerms(parse(helper.perms, [])) || [] };
    return { ...person, role: null, perms: [] };
  }

  /** Round 9: an active helper's row, or null. No awaits. */
  helperRow(customerId) {
    return customerId
      ? this.sql.exec("SELECT * FROM staff_helpers WHERE customer_id = ? AND status = 'active'", String(customerId)).toArray()[0] || null
      : null;
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
        const by = `pos:${request.headers.get('X-Lair-Pos-User') || ''}`;
        if (b === 'pos' && c === 'today') return json(await this.posToday());
        if (b === 'pos' && c === 'scan') return json(await this.posScan(body));
        if (b === 'pos' && c === 'checkin') return json(await this.posCheckIn(body, by));
        if (b === 'pos' && c === 'checkin-member') return json(await this.posCheckInMember(body, by));
        if (b === 'pos' && c === 'share') return json(await this.posShare(body));
        if (b === 'pos' && c === 'pass-undo') return json(await this.undoPassUse(String(body.useId || ''), { staff: true, customerId: null }));
        if (b === 'pos' && c === 'member') return json(await this.posMember(body));
        if (b === 'pos' && c === 'tab' && parts[3] && parts[4] === 'added') return json(this.posTabAdded(decodeURIComponent(parts[3])));
        return json({ error: 'Not found' }, 404);
      }
      const origin = request.headers.get('X-Lair-Origin');
      if (origin) {
        this.later(this.ensureWebhook(`${origin}/webhooks/orders-paid`));
        // For the status page: did the website reach a booking route, and through which store address?
        const day = new Date().toISOString().slice(0, 10);
        const prefix = url.searchParams.get('path_prefix') || null;
        const known = (request.method === 'GET' && ['floor', 'me', 'members', 'passes', 'library', 'tab', 'roll-codes', 'groups', 'customers', 'events', 'community', 'offers', 'products', 'staff', 'team', 'accounts'].includes(a))
          || (request.method === 'POST' && ['bookings', 'games', 'series', 'blocks', 'openings', 'checkin', 'events', 'contact', 'roll', 'gm-profile', 'me', 'members', 'passes', 'prizes', 'tab', 'library', 'roll-codes', 'groups', 'community', 'offers', 'team', 'accounts', 'bills', 'interest'].includes(a));
        this.note(known ? { proxy: { seen: true, prefix, day } } : { proxyMiss: { path: url.pathname, method: request.method, prefix, day } });
      }
      const who = await this.person(request.headers.get('X-Lair-Customer') || '');
      const client = request.headers.get('X-Lair-Client') || '';
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      if (request.method === 'GET' && a === 'floor') return json(await this.floor(url, who));
      if (request.method === 'GET' && a === 'me' && !b) return json(await this.me(who, url));
      if (request.method === 'GET' && a === 'members' && !b) return json(await this.members(url, who));
      if (request.method === 'GET' && a === 'members' && b === 'birthdays') return json(await this.birthdayList(who));
      if (request.method === 'GET' && a === 'members' && b && c === 'spend') return json(await this.memberSpend(decodeURIComponent(b), who));
      if (request.method === 'GET' && a === 'members' && b && !c) return json(await this.memberDetail(decodeURIComponent(b), who));
      // Round 9, team: who's using the staff page, the team, and a member's store credit and emails
      if (request.method === 'GET' && a === 'staff' && b === 'me' && !c) return json(this.staffMe(who));
      if (request.method === 'GET' && a === 'team' && !b) return json(await this.listTeam(who));
      if (request.method === 'GET' && a === 'members' && b && c === 'credit') return json(await this.memberCredit(decodeURIComponent(b), who));
      if (request.method === 'GET' && a === 'members' && b && c === 'emails') return json(this.memberEmails(decodeURIComponent(b), who));
      // Round 9: monthly accounts for staff (the Accounts tab)
      if (request.method === 'GET' && a === 'accounts' && !b) return json(await this.listAccounts(who));
      if (request.method === 'GET' && a === 'roll-codes' && !b) return json(this.listRollCodes(url, who));
      if (request.method === 'GET' && a === 'passes' && !b) return json(this.listPasses(url, who));
      if (request.method === 'GET' && a === 'groups' && !b) return json(this.listGroups(url, who));
      if (request.method === 'GET' && a === 'customers' && !b) return json(await this.findCustomers(url, who));
      if (request.method === 'GET' && a === 'events' && !b) return json(await this.listEvents(who));
      // Round 9 (community): turnouts by game, saved lists, early access offers and the product search for them
      if (request.method === 'GET' && a === 'community' && !b) return json(await this.communityStats(url, who));
      if (request.method === 'GET' && a === 'community' && b === 'lists' && !c) return json(this.communityLists(who));
      if (request.method === 'GET' && a === 'offers' && !b) return json(this.listOffers(who));
      if (request.method === 'GET' && a === 'offers' && b && !c) return json(this.offerDetail(decodeURIComponent(b), who));
      if (request.method === 'GET' && a === 'products' && b === 'search' && !c) return json(await this.productSearch(url, who));
      if (request.method === 'GET' && a === 'library' && b === 'status' && !c) return json(await this.libraryStatus(url, who));
      if (request.method === 'GET' && a === 'library' && b === 'holds' && !c) return json(await this.listHolds(url, who));
      if (request.method === 'GET' && a === 'library' && b === 'loans' && !c) return json(await this.listLoans(url, who));
      if (request.method === 'GET' && a === 'tab' && b === 'lookup' && !c) return json(await this.tabLookup(url, who));
      if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
      const d = parts[3];
      if (a === 'me' && b === 'profile') return json(await this.saveProfile(body, who));
      if (a === 'me' && b === 'passes' && c === 'claim') return json(await this.claimPass(body, who));
      if (a === 'me' && b === 'codes' && c === 'redeem') return json(await this.redeemCode(body, who));
      // Round 9: "Pay online now" for everything on a monthly account
      if (a === 'me' && b === 'account' && c === 'pay') return json(await this.payAccountNow(who));
      if (a === 'passes' && !b) return json(await this.createPass(body, who));
      if (a === 'passes' && b === 'uses' && c && d === 'undo') return json(await this.undoPassUse(decodeURIComponent(c), who));
      if (a === 'passes' && b && c === 'update') return json(await this.updatePass(decodeURIComponent(b), body, who));
      if (a === 'passes' && b && c === 'apply') return json(await this.applyPass(decodeURIComponent(b), body, who));
      if (a === 'groups' && !b) return json(await this.createGroup(body, who));
      if (a === 'groups' && b && c === 'update') return json(await this.updateGroup(decodeURIComponent(b), body, who));
      if (a === 'groups' && b && c === 'members') return json(await this.groupMembers(decodeURIComponent(b), body, who));
      // Round 9 (community): lists of members, early access offers, and a member claiming one
      if (a === 'community' && b === 'lists' && !c) return json(await this.createCommunityList(body, who));
      if (a === 'community' && b === 'lists' && c && !d) return json(await this.updateCommunityList(decodeURIComponent(c), body, who));
      if (a === 'community' && b === 'lists' && c && d === 'remove') return json(await this.removeCommunityList(decodeURIComponent(c), who));
      if (a === 'offers' && !b) return json(await this.createOffer(body, who));
      if (a === 'offers' && b && !c) return json(await this.updateOffer(decodeURIComponent(b), body, who));
      if (a === 'offers' && b && c === 'open') return json(await this.openOffer(decodeURIComponent(b), body, who));
      if (a === 'offers' && b && c === 'close') return json(await this.closeOffer(decodeURIComponent(b), who));
      if (a === 'offers' && b && c === 'claim') return json(await this.claimOffer(decodeURIComponent(b), body, who));
      if (a === 'members' && b && c === 'new-code') return json(await this.newMemberCode(decodeURIComponent(b), who));
      if (a === 'members' && b && c === 'gift') return json(await this.giveGift(decodeURIComponent(b), body, who));
      if (a === 'members' && b && c === 'rolls') return json(await this.giveRolls(decodeURIComponent(b), body, who));
      if (a === 'members' && b && c === 'since') return json(await this.setCustomerSince(decodeURIComponent(b), body, who));
      // Round 9, team: helpers, and store credit and emails from a member's page
      if (a === 'team' && !b) return json(await this.addHelper(body, who));
      if (a === 'team' && b && c === 'remove' && !d) return json(await this.removeHelper(decodeURIComponent(b), who));
      if (a === 'team' && b && !c) return json(await this.updateHelper(decodeURIComponent(b), body, who));
      if (a === 'members' && b && c === 'credit') return json(await this.changeMemberCredit(decodeURIComponent(b), body, who));
      if (a === 'members' && b && c === 'email') return json(await this.emailMember(decodeURIComponent(b), body, who));
      // Round 9: a member's billing (pay each visit or a monthly account) and credit limit, and their bills
      if (a === 'members' && b && c === 'account') return json(await this.setMemberAccount(decodeURIComponent(b), body, who));
      if (a === 'accounts' && b && c === 'bill') return json(await this.billNow(decodeURIComponent(b), who));
      if (a === 'bills' && b && c === 'void') return json(await this.voidBillRoute(decodeURIComponent(b), who));
      if (a === 'bills' && b && c === 'resend') return json(await this.resendBill(decodeURIComponent(b), who));
      if (a === 'roll-codes' && !b) return json(await this.createRollCode(body, who));
      if (a === 'roll-codes' && b && c === 'update') return json(await this.updateRollCode(decodeURIComponent(b), body, who));
      if (a === 'library' && b === 'holds' && !c) return json(await this.createHold(body, who));
      if (a === 'library' && b === 'holds' && c && d === 'cancel') return json(await this.cancelHold(decodeURIComponent(c), who));
      if (a === 'library' && b === 'holds' && c && d === 'update') return json(await this.updateHold(decodeURIComponent(c), body, who));
      if (a === 'library' && b === 'scan' && !c) return json(await this.libraryScan(body, who));
      if (a === 'library' && b === 'loans' && !c) return json(await this.checkOutLoan(body, who));
      if (a === 'library' && b === 'loans' && c && d === 'return') return json(await this.returnLoan(decodeURIComponent(c), who));
      if (a === 'library' && b === 'return' && !c) return json(await this.checkInLoan(body, who));
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
      if (a === 'series' && c === 'leave') return json(await this.leaveSeries(b, who, body));
      if (a === 'games' && c === 'image') return json(await this.gameImage(b, body, who));
      if (a === 'gm-profile' && !b) return json(await this.saveGmProfile(body, who));
      if (a === 'blocks' && !b) return json(await this.createBlock(body, who));
      if (a === 'blocks' && c === 'delete') return json(await this.removeBlock(b, who, body));
      if (a === 'openings' && !b) return json(await this.createOpening(body, who));
      if (a === 'openings' && c === 'delete') return json(await this.removeOpening(b, who));
      if (a === 'checkin' && !b) return json(await this.checkIn(body, who));
      if (a === 'events' && b === 'joins' && d === 'cancel') return json(await this.cancelJoin(c, who));
      if (a === 'events' && b && c === 'join') return json(await this.joinEvent(decodeURIComponent(b), body, who, client));
      // Round 9, team: staff add someone to an event date's sign-ups, by member code or by name and email
      if (a === 'events' && b && b !== 'joins' && c === 'joins' && !d) return json(await this.staffJoin(decodeURIComponent(b), body, who));
      if (a === 'events' && b && c === 'attend') return json(await this.attendEvent(decodeURIComponent(b), body, who));
      if (a === 'events' && b && c === 'reserve') return json(await this.reserveSpot(decodeURIComponent(b), body, who, client));
      // Round 9, play: "I'm interested" in a TTRPG session, "Maybe" for an event date, and taking it back
      if (a === 'interest' && !b) return json(await this.addInterest(body, who, client));
      if (a === 'interest' && b && c === 'remove') return json(await this.removeInterest(decodeURIComponent(b), body, who));
      if (a === 'events' && !b) return json(await this.createEvent(body, who));
      if (a === 'events' && b === 'pictures' && !c) return json(await this.eventPicture(body, who));
      if (a === 'events' && b && c === 'update') return json(await this.updateEvent(decodeURIComponent(b), body, who));
      if (a === 'events' && b && c === 'delete') return json(await this.deleteEvent(decodeURIComponent(b), who));
      if (a === 'contact' && !b) return json(await this.contact(body, who, client));
      if (a === 'roll' && !b) return json(await this.roll(body, who, client));
      if (a === 'prizes' && b && c === 'done') return json(await this.prizeDone(decodeURIComponent(b), who));
      if (a === 'tab' && !b) return json(await this.saveTab(body, who));
      if (a === 'tab' && b === 'clear') return json(await this.clearTab(who));
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      if (error instanceof RuleError) return json({ error: error.message }, error.status);
      console.error('Lair error', error);
      this.note({ lastError: { message: String(error.message || error).slice(0, 300), path: url.pathname, at: new Date().toISOString() } });
      return json({ error: 'Something went wrong on our side. Please try again or call us.' }, 500);
    }
  }

  /**
   * The one staff gate. Round 9: perm says what the route needs (a key, or a list where any one will do: see canDo). The
   * owner passes every gate; a helper passes when they were given it; a missing or unknown perm is the owner's alone.
   */
  requireStaff(who, perm) {
    if (!who.staff) throw new RuleError('Staff only. Log in with your staff account.', 403);
    if (!canDo(who, perm)) throw new RuleError(TEAM_WORDS.notYours, 403);
  }

  /** Round 9: whether this person may do what perm covers (canDo). For the reads that only add staff fields. No awaits. */
  can(who, perm) {
    return canDo(who, perm);
  }

  /* ---------------- the team: the owner and helpers (round 9) ---------------- */
  /**
   * GET /staff/me (logged in): who's using the staff page, for it to build itself. { staff: false }, or { staff: true,
   * role: 'owner' | 'helper', perms (the owner's include 'team'), name (their first name) }. No awaits.
   */
  staffMe(who) {
    if (!who.customerId) throw new RuleError('Log in to use the staff page.', 401);
    if (!who.staff) return { staff: false };
    const row = this.memberRow(who.customerId);
    const owner = who.role !== 'helper';
    return { staff: true, role: owner ? 'owner' : 'helper', perms: owner ? [...STAFF_PERMS, 'team'] : cleanPerms(who.perms) || [], name: row?.first_name || row?.name || '' };
  }

  /** Round 9: a helper as the Team tab shows them. No awaits. */
  helperView(row) {
    const m = this.memberRow(row.customer_id);
    const by = String(row.made_by || '').replace(/^staff:/, '');
    const maker = by ? this.memberRow(by) : null;
    return {
      customerId: row.customer_id, name: m?.name || m?.first_name || '', firstName: m?.first_name || '', email: m?.email || '', code: m?.code || null,
      perms: cleanPerms(parse(row.perms, [])) || [], since: row.created_at, updatedAt: row.updated_at || row.created_at,
      madeBy: by ? { customerId: by, name: maker?.name || maker?.first_name || '' } : null,
    };
  }

  /** Round 9: one line in the team's log (who, when, what). No awaits. */
  logTeam(customerId, action, perms, who, now) {
    this.write(
      'INSERT INTO staff_log (id, customer_id, action, perms, by, at) VALUES (?, ?, ?, ?, ?, ?)',
      makeId('tl'), String(customerId), action, perms ? JSON.stringify(perms) : null, who.customerId ? `staff:${who.customerId}` : 'staff', now,
    );
  }

  /**
   * GET /team (owner): who can use the staff page. { owners: [{ customerId, name, email, code }] (tagged staff in Shopify:
   * whoever's asking, and the others Shopify finds), helpers (helperView, newest first), perms: [{ key, words }] (what can
   * be ticked, in order), defaults (ticked for a new helper), log: the last 30 grants, changes and removals ({ at, action:
   * 'added' | 'changed' | 'removed', customerId, name, perms, by: { customerId, name } }) }.
   */
  async listTeam(who) {
    this.requireStaff(who, 'team');
    let tagged = [];
    if (this.shopify.configured) {
      try {
        tagged = await this.shopify.searchCustomers('tag:staff');
      } catch (error) {
        tagged = [];
        this.note({ teamError: { message: String(error.message || error).slice(0, 300), at: new Date().toISOString() } });
      }
    }
    // --- no awaits from here on ---
    const owners = new Map();
    const ownerOf = (id, fallback = {}) => {
      const m = this.memberRow(id);
      return { customerId: String(id), name: m?.name || m?.first_name || fallback.name || '', email: m?.email || fallback.email || '', code: m?.code || null };
    };
    if (who.customerId) owners.set(String(who.customerId), ownerOf(who.customerId));
    for (const c of tagged) if (c.customerId && !owners.has(c.customerId) && !this.helperRow(c.customerId)) owners.set(c.customerId, ownerOf(c.customerId, c));
    const helpers = this.sql.exec("SELECT * FROM staff_helpers WHERE status = 'active' ORDER BY created_at DESC, rowid DESC").toArray().map((r) => this.helperView(r));
    const log = this.sql.exec('SELECT * FROM staff_log ORDER BY at DESC, rowid DESC LIMIT 30').toArray().map((r) => {
      const m = this.memberRow(r.customer_id);
      const by = String(r.by || '').replace(/^staff:/, '');
      const maker = by && by !== 'staff' ? this.memberRow(by) : null;
      return {
        at: r.at, action: r.action, customerId: r.customer_id, name: m?.name || m?.first_name || '', perms: cleanPerms(parse(r.perms, [])),
        by: by && by !== 'staff' ? { customerId: by, name: maker?.name || maker?.first_name || '' } : null,
      };
    });
    return { owners: [...owners.values()], helpers, perms: STAFF_PERMS.map((key) => ({ key, words: PERM_WORDS[key] })), defaults: HELPER_DEFAULT, log };
  }

  /**
   * POST /team { code } or { customerId, name?, email? } (owner), and perms ([keys]; Check-in and Tables when left out):
   * make a member a helper. A customer from the search the Lair hasn't met becomes a member first. Someone tagged staff
   * is the main account already (409). Already a helper: their permissions change. Returns { helper }.
   */
  async addHelper(input, who) {
    this.requireStaff(who, 'team');
    const typed = String(input?.code ?? '').trim();
    const byCode = typed ? this.memberByCode(typed) : null;
    if (typed && !byCode) throw new RuleError(TEAM_WORDS.noMember, 404);
    if (!byCode && !String(input?.customerId ?? '').trim()) throw new RuleError(TEAM_WORDS.pickMember);
    const picked = byCode
      ? { customerId: String(byCode.customer_id), row: byCode }
      : this.pickedCustomer({ customerId: input.customerId, name: input.name, email: input.email });
    const perms = input?.perms === undefined ? HELPER_DEFAULT.slice() : cleanPerms(input.perms);
    if (!perms || !perms.length) throw new RuleError(TEAM_WORDS.noPerms);
    if (String(picked.customerId) === String(who.customerId)) throw new RuleError(TEAM_WORDS.ownerAlready, 409);
    // the main account is tagged staff in Shopify (asked first: no awaits after this)
    const tagged = await this.taggedPerson(picked.customerId);
    // --- no awaits from here on ---
    if (tagged.staff) throw new RuleError(TEAM_WORDS.ownerAlready, 409);
    const now = Date.now();
    if (!picked.row) this.makeMember(picked, now);
    const was = this.helperRow(picked.customerId);
    this.write(
      `INSERT INTO staff_helpers (customer_id, perms, status, made_by, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)
       ON CONFLICT(customer_id) DO UPDATE SET perms = excluded.perms, status = 'active',
         made_by = CASE WHEN staff_helpers.status = 'active' THEN staff_helpers.made_by ELSE excluded.made_by END,
         created_at = CASE WHEN staff_helpers.status = 'active' THEN staff_helpers.created_at ELSE excluded.created_at END,
         updated_at = excluded.updated_at`,
      String(picked.customerId), JSON.stringify(perms), who.customerId ? `staff:${who.customerId}` : 'staff', now, now,
    );
    this.logTeam(picked.customerId, was ? 'changed' : 'added', perms, who, now);
    return { helper: this.helperView(this.helperRow(picked.customerId)) };
  }

  /** POST /team/:customerId { perms } (owner): what a helper can do. Returns { helper }. */
  async updateHelper(customerId, input, who) {
    this.requireStaff(who, 'team');
    // --- no awaits from here on ---
    const id = trimmed(customerId, 40);
    if (id === String(who.customerId)) throw new RuleError(TEAM_WORDS.self, 403);
    const row = this.helperRow(id);
    if (!row) throw new RuleError(TEAM_WORDS.notHelper, 404);
    const perms = cleanPerms(input?.perms);
    if (!perms || !perms.length) throw new RuleError(TEAM_WORDS.noPerms);
    const now = Date.now();
    this.write('UPDATE staff_helpers SET perms = ?, updated_at = ? WHERE customer_id = ?', JSON.stringify(perms), now, id);
    this.logTeam(id, 'changed', perms, who, now);
    return { helper: this.helperView(this.helperRow(id)) };
  }

  /**
   * POST /team/:customerId/remove (owner): they stop being a helper, straight away. The main account can't be removed
   * here (409). Returns { ok, customerId }.
   */
  async removeHelper(customerId, who) {
    this.requireStaff(who, 'team');
    const id = trimmed(customerId, 40);
    if (id === String(who.customerId)) throw new RuleError("That's you, the main account. It can't be removed here.", 409);
    const tagged = /^\d{1,20}$/.test(id) ? await this.taggedPerson(id) : { staff: false };
    // --- no awaits from here on ---
    if (tagged.staff) throw new RuleError("That's the main account. It can't be removed here.", 409);
    if (!this.helperRow(id)) throw new RuleError(TEAM_WORDS.notHelper, 404);
    const now = Date.now();
    this.write("UPDATE staff_helpers SET status = 'removed', updated_at = ? WHERE customer_id = ?", now, id);
    this.logTeam(id, 'removed', null, who, now);
    return { ok: true, customerId: id };
  }

  async floor(url, who) {
    const rules = await this.rules();
    const now = Date.now();
    const from = Math.max(Number(url.searchParams.get('from')) || now - 24 * HOUR, now - 31 * 24 * HOUR);
    const to = Math.min(Number(url.searchParams.get('to')) || now + rules.horizonDays * 24 * HOUR, now + 400 * 24 * HOUR);
    const st = this.cachedState(from, to);
    const memo = new Map();
    // Round 9: the floor's staff view (names, emails, payments, every sign-up) for the owner and helpers who run the desk,
    // the floor, GM games or events; anyone else sees the public floor
    const staffView = this.can(who, FLOOR_STAFF);
    const paid = staffView ? { booking: this.paymentsIn('booking', from, to), join: this.paymentsIn('join', from, to) } : null;
    const view = (bk) => {
      // Staff see everything, plus the saved pass, what passes covered, what's due, the refund state and who paid.
      if (staffView) return this.staffBooking(bk, memo, paid.booking.get(bk.id) || []);
      if (who.customerId && bk.customerId === who.customerId) return { ...publicBooking(bk), ref: bk.ref, name: bk.name, people: bk.people, paid: bk.paid };
      return publicBooking(bk);
    };
    // Weekly regulars: the public board shows a series' next session that hasn't ended, and no later ones. Staff and
    // the game's own GM see every session. (Kept with the cached state, so it's at most a minute behind.)
    if (!st.seriesInfo) st.seriesInfo = this.seriesInfo(now);
    const info = st.seriesInfo;
    const visibleGames = st.games.filter((g) => {
      if (staffView) return true;
      const own = Boolean(who.customerId && g.gmCustomerId === who.customerId);
      if (!['open', 'full'].includes(g.status) && !(own && g.status === 'pending')) return false;
      return own || !g.seriesId || info.next.get(g.seriesId) === g.id;
    });
    // Calendar events' tables: soft (marked for the event, still bookable) unless the event locks them. Bookings
    // and games are checked against the locked ones only.
    const holds = eventHolds(rules, from, to);
    // Staff see every sign-up, like every booking: a cancelled one can still be waiting on a refund ('ask' or 'due')
    // under "Refunds to sort". Places taken only count the ones still on.
    const joinRows = this.sql
      .exec(`SELECT * FROM event_joins WHERE ends_at > ? AND starts_at < ?${staffView ? '' : " AND status != 'cancelled'"}`, from, to)
      .toArray()
      .map((r) => this.rowToJoin(r));
    const eventJoins = {};
    for (const j of joinRows) if (j.status !== 'cancelled') eventJoins[j.occurrenceId] = (eventJoins[j.occurrenceId] || 0) + j.people;
    // Event dates with game spots: how many there are and how many are taken (by anyone, through any booking).
    const eventSpots = {};
    for (const o of eventOccurrences(rules, from, to)) {
      const total = parseSpots(o.gameTables, rules.rooms).length;
      if (total) eventSpots[o.id] = { total, taken: total - this.freeSpots(o, rules, st).length };
    }
    // Round 7: waiting series invites, by series, for the games below (staff and GMs only)
    const waiting = staffView || who.customerId ? this.waitingInvites() : new Map();
    // Round 9, play: who's interested in sessions and maybe (or coming) to event dates: counts for everyone, names for
    // staff and a session's own GM only
    const interest = this.interestsIn(from, to);
    return {
      now,
      bookings: st.bookings.filter((bk) => staffView || ACTIVE.has(bk.status)).map(view),
      // Round 8: staff see a hold's series (seriesId, repeat, repeatTag, until); the public see nothing new
      blocks: staffView ? this.staffBlocks(st.blocks, rules) : st.blocks.map(({ seriesId, ...bl }) => ({ ...bl, label: PUBLIC_HOLD[bl.type] || 'Reserved' })),
      eventHolds: holds,
      games: visibleGames.map((g) => {
        const game = this.gameView(g, st, rules, info);
        if (staffView || (who.customerId && g.gmCustomerId === who.customerId)) game.players = this.gamePlayers(st, g.id);
        // Round 7: for staff and the session's GM, the seats of its series reserved for someone who's still to make an
        // account (a GM never sees a player's email on the board); for staff, the GM's email and whether the game is on
        // their account ('linked'), waiting for them to make one ('invited': an email nobody has used yet) or neither ('none')
        if (staffView || (who.customerId && g.gmCustomerId === who.customerId)) {
          game.invites = ((g.seriesId && waiting.get(g.seriesId)) || []).map((x) => (staffView ? x : { ...x, email: '' }));
        }
        if (staffView) Object.assign(game, { gmEmail: g.gmEmail || '', gmAccount: this.gmAccount(g) });
        // Round 9, play: how many are interested (everyone), and who (staff and the session's GM)
        game.interested = interest.sessions[g.id] || 0;
        if (staffView || (who.customerId && g.gmCustomerId === who.customerId)) game.interest = interest.rows.filter((r) => r.kind === 'session' && r.target_id === g.id).map((r) => this.interestPerson(r));
        return game;
      }),
      events: [],
      eventJoins,
      eventSpots,
      // Round 9, play: "Maybe" and "I'm coming" (events with no sign-ups) per event date, as counts; staff get the names
      eventInterest: interest.events,
      ...(staffView ? { interests: interest.rows.filter((r) => r.kind === 'event').map((r) => this.staffInterest(r)) } : {}),
      ...(staffView ? { joins: this.staffJoins(joinRows, paid.join, from, to) } : {}),
      // Round 9: staff see who's on a monthly account, so their fees read "On their account"
      ...(staffView ? { monthlyAccounts: this.monthlyIds() } : {}),
      shopTables: rules.shopTables || [],
      openings: st.openings.map((o) => (staffView ? o : { id: o.id, tables: o.tables, start: o.start, end: o.end })),
      staff: staffView,
      // payOnline: Shopify checkout works, for events paid online. Tables, seats and walk-ins are paid at the counter.
      features: { email: emailReady(this.env), payOnline: this.shopify.configured },
    };
  }

  async createBooking(input, who, client = '') {
    // Round 6: a seat at a TTRPG session needs no account (a guest gives a name and email, and the GM is emailed);
    // "Save my seat every week" (join-series) still does, since the member code is the ticket.
    const rules = await this.rules();
    // --- no awaits from here until the booking is saved ---
    const now = Date.now();
    const time = new LairTime(rules.tz);
    const st = this.state(now - 24 * HOUR, now + (rules.horizonDays + 2) * 24 * HOUR);
    const kind = input.kind === 'gm-seat' ? 'gm-seat' : input.kind === 'walkin' ? 'walkin' : 'table';
    if (kind === 'walkin') this.requireStaff(who, 'tables');
    // Round 9: a staff booking from the staff page needs Tables too
    if (kind === 'table' && input.staffOverride === true && who.staff) this.requireStaff(who, 'tables');
    // The public booking page applies the house rules to everyone, staff included. Only the staff page skips them:
    // walk-ins, and table bookings sent with staffOverride. Those are made for someone else, so they aren't linked
    // to the staff member's own account.
    const override = Boolean(who.staff) && (kind === 'walkin' || (kind === 'table' && input.staffOverride === true));
    this.checkRate(who, client, now);
    let booking;
    let game = null;
    if (kind === 'gm-seat') {
      // A series session keeps seats for its weekly regulars who don't have theirs yet (the booker's own excepted).
      const wanted = st.games.find((g) => g.id === input.gameId);
      const held = wanted ? this.regularsWaiting(wanted, { except: who.customerId, now }) : 0;
      const seat = checkSeatBooking(input, { state: st, rules, now, held });
      game = seat.game;
      booking = {
        kind, gameId: game.id, tables: seat.tables, room: tableIndex(rules.rooms).get(seat.tables[0])?.roomObj.id, start: seat.start,
        end: seat.end, people: seat.people, name: seat.name, email: seat.email, amount: seat.amount, activity: 'rpg', party: seat.players,
        phone: seat.phone, notes: seat.notes,
      };
    } else {
      const checked = checkTableBooking(input, { state: st, rules, time, now, staff: override });
      booking = { kind, ...checked };
    }
    // Round 7: a mobile number on every customer booking (tables, game seats); not on what staff make for someone
    if (!override) booking.phone = checkMobile(input.phone);
    if (!who.staff) this.checkEmailLimit(booking.email, now);
    // Round 9: on a monthly account, not over its credit limit (staff booking for someone, the override, skip this)
    if (!override) this.checkAccountLimit(who.customerId, booking.amount, rules, now, 'book');
    // usePass: the member's own session pass (staff may use any active one), saved for the check-in.
    const pass = input.usePass && ['table', 'gm-seat'].includes(kind) ? this.passForBooking(input.usePass, who, now) : null;
    // Tables, walk-ins and game seats are paid at the counter on the day (show the code, we ring it up): `pay` is ignored.
    const id = makeId('bk');
    // A walk-in staff mark paid as they seat it was paid in full. split: the booker will split the bill at the counter.
    const paidNow = kind === 'walkin' && Boolean(input.paid);
    Object.assign(booking, {
      id, ref: this.newCode(trimmed(input.name, 80), 'booking', id, now), pay: 'day', paid: paidNow, paidAmount: paidNow ? booking.amount : 0,
      status: kind === 'walkin' ? 'seated' : 'confirmed', holdUntil: null, customerId: override ? null : who.customerId || null, passId: pass?.id || null,
      split: kind === 'table' && input.split === true,
    });
    this.saveBooking(booking, now);
    if (!override) this.touchMember(who.customerId, { name: booking.name, email: booking.email, mobile: booking.phone }, now);
    // --- saved: the table is ours ---
    // Every new player at a game emails its GM (a guest, a member or anyone else), with their details.
    if (game) this.tellGmNewPlayer(booking, game, rules);

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
        this.write('UPDATE bookings SET draft_order_id = ?, checkout_url = ?, updated_at = ? WHERE id = ?', draftOrderId, checkoutUrl || null, Date.now(), booking.id);
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

  /**
   * Booking confirmation email: tables, game seats and event game spots. Returns whether one was sent (needs RESEND_API_KEY
   * and FROM_EMAIL). invite (round 7): the schedule of the game a seat staff reserved for someone without an account was
   * also invited to every session of ('weekly', 'fortnightly' or 'flexible'), for its last line.
   */
  confirm(booking, rules, game = null, { invite = null } = {}) {
    if (!emailReady(this.env) || !isEmail(booking.email)) return false;
    const when = this.when(booking, rules);
    const online = Boolean(booking.paid && booking.pay === 'now');
    const fee = !booking.amount ? 'Nothing to pay' : booking.paid ? `${dollars(booking.amount)}, paid${online ? ' online' : ''}. Thank you!` : `${dollars(booking.amount)}, pay at the counter`;
    const pay = dueOf(booking) > 0 ? COUNTER : SHOW_CODE;
    // A game spot paid online is locked in. A table the first release took payment for online keeps its old policy.
    const lockedIn = online && Boolean(booking.occurrenceId);
    const changes = lockedIn ? LOCKED_IN_EMAIL : online
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
          ['Fee', fee], ['Your code', booking.ref],
        ],
        outro: [
          pay, changes || "Can't make it after all? Drop your seat in My Lair and Gobgob will let your GM know.",
          // A seat with no account (a guest, or a player staff added): it joins their account once they make one (round 6).
          // Round 7: a seat staff reserved at a weekly game says the account also saves their seat every week.
          ...(booking.customerId ? [] : [invite ? this.inviteLine(invite) : 'Make an account with this email any time, and your seats will show up in My Lair.']),
        ],
      };
    } else {
      const extras = { wargame: 'Wargame (double tables)', bigbox: 'Big box game (double tables)', celebrating: 'Celebrating something' };
      subject = `${event ? `Game spot booked: ${event.title}` : "You're booked"}: ${when} (${booking.ref})`;
      content = {
        title: lockedIn ? "You're locked in!" : event ? 'Your game spot is booked!' : "You're booked in!",
        intro: event
          ? `Kia ora ${booking.name}, you've got a game spot at ${event.title}. Your tables are saved: bring your army.`
          : `Kia ora ${booking.name}, your table at the Dice Goblin Lair is booked. Gobgob's already guarding it.`,
        details: [
          ['When', when], ['Where', tables], ['People', String(booking.people)],
          ['Setup', (booking.extras || []).map((x) => extras[x]).filter(Boolean).join(', ')], ['Fee', fee], ['Your code', booking.ref],
        ],
        outro: [pay, ...(booking.split ? [SPLIT] : []), changes || 'Plans changed? Cancel in My Lair or give us a call, so someone else can have the table.'],
      };
    }
    this.later(this.mail(this.letter(booking.email, subject, { ...content, button: { label: 'See it in My Lair', url: this.page('myLair') } })));
    return true;
  }

  /** The last line of a reserved seat's confirmation when its person is invited to every session (round 7) */
  inviteLine(schedule) {
    if (schedule === 'fortnightly') return "It's a fortnightly game: make your Dice Goblin account with this email and Gobgob will save your seat every fortnight.";
    if (schedule === 'flexible') return "It's a regular game: make your Dice Goblin account with this email and Gobgob will save your seat every session.";
    return "It's a weekly game: make your Dice Goblin account with this email and Gobgob will save your seat every week.";
  }

  /** An alert for the team (STAFF_EMAIL). content: { title, intro, details, outro }. extra: { replyTo }. */
  notifyStaff(subject, content, extra = {}) {
    if (!emailReady(this.env) || !this.env.STAFF_EMAIL) return;
    this.later(this.mail(this.letter(this.env.STAFF_EMAIL, subject, {
      button: { label: 'Open the staff page', url: this.page('staff') }, signoff: 'Gobgob, keeping an eye on the Lair', ...content,
    }, extra)));
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

  /**
   * A booking as the person who made it sees it. payment and refund as in joinView; pass is the session pass saved
   * for its check-in ({ code, label, sessionsLeft }), covered what passes took off, and due what's left to pay.
   */
  ownView(b) {
    return {
      ...publicBooking(b), ref: b.ref, name: b.name, email: b.email, people: b.people, paid: b.paid, amount: b.amount, pay: b.pay, room: b.room,
      extras: b.extras || [], occurrenceId: b.occurrenceId || null, payment: b.pay === 'now' ? 'online' : 'store', refund: b.refund || null,
      pass: this.ownPass(b), covered: b.covered || 0, due: dueOf(b), paidAmount: b.paidAmount || 0, split: Boolean(b.split),
      seriesId: b.seriesId || null, ticketCode: this.ticketCode(b), owed: this.isOwed(b), waived: Boolean(b.waived),
    };
  }

  /**
   * What a booking's ticket and QR show: a weekly regular's seat is their member code (one code for every session);
   * anything else its own code. The seat keeps its own ref for the POS's _booking lines. member: their member row,
   * when the caller has it.
   */
  ticketCode(b, member = undefined) {
    if (b?.seriesId && b.kind === 'gm-seat' && b.customerId) {
      const row = member !== undefined ? member : this.memberRow(b.customerId);
      if (row?.code) return row.code;
    }
    return b?.ref || '';
  }

  /**
   * A weekly regular's seat (from "join every session") whose session has ended unpaid: owed, whether or not they
   * came, until it's paid or staff waive it. One-off bookings are never owed (an unpaid no-show is just recorded), and
   * neither are seats booked before round 5 went live (owedFrom), under the old rules.
   */
  isOwed(b, now = Date.now()) {
    return Boolean(b?.seriesId) && b.kind === 'gm-seat' && b.status !== 'cancelled' && b.end <= now && (b.createdAt || 0) >= this.owedFrom && dueOf(b) > 0;
  }

  /**
   * A member's owed seats, oldest first, as check-in rows (owed: true) each with the cart line that pays it ("Owed:
   * Curse of Strahd (Thu 1 Oct)"). memo: see savedPass. No awaits.
   */
  owedRows(customerId, rules, now, memo = new Map()) {
    return this.sql
      .exec(
        `SELECT * FROM bookings WHERE customer_id = ? AND series_id IS NOT NULL AND kind = 'gm-seat' AND status != 'cancelled' AND ends_at <= ? AND created_at >= ?
           AND paid = 0 AND waived = 0 ORDER BY starts_at, id`,
        String(customerId), now, this.owedFrom,
      )
      .toArray()
      .map((r) => this.rowToBooking(r))
      .filter((b) => this.isOwed(b, now))
      .map((b) => {
        const row = this.bookingRow(b, rules, { memo, now });
        return { ...row, line: this.posLine(row, rules) };
      });
  }

  async updateBooking(id, patch, who) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const booking = this.booking(id);
    if (!booking) {
      // An event sign-up: staff mark its entry fee paid or refunded here too (cancelling is POST /events/joins/:id/cancel).
      const join = who.staff ? this.joinById(id) : null;
      // Round 9: checked in or paid at the desk or on the Events tab; refunded is money
      if (join) for (const need of this.joinPerms(patch)) this.requireStaff(who, need);
      if (join) return this.updateJoin(join, patch, now);
      throw new RuleError('Booking not found.', 404);
    }
    // Round 9: staff change a booking with the permission each change needs (bookingPerms). A helper without them is a
    // member here: they can still cancel their own booking.
    const staffEdit = Boolean(who.staff) && this.bookingPerms(patch).every((need) => this.can(who, need));
    if (who.staff && !staffEdit && !(who.customerId && booking.customerId === who.customerId)) throw new RuleError(TEAM_WORDS.notYours, 403);
    if (!staffEdit) {
      const own = who.customerId && booking.customerId === who.customerId;
      if (own && booking.kind === 'gm') throw new RuleError('To cancel your game, cancel it from the games board.', 403);
      if (!own || patch.status !== 'cancelled' || booking.start <= now) throw new RuleError('Only staff can change that booking.', 403);
      if (booking.status === 'cancelled') return { booking: this.ownView(booking), refund: { due: false, amount: 0, reason: 'already cancelled' } };
      // An event game spot paid online is locked in: cancelling frees the spot and staff decide on a refund. Anything
      // else paid online (from before everything moved to the counter) keeps the cancellation policy it was sold with.
      const lockedIn = Boolean(booking.occurrenceId && booking.paidAmount > 0 && booking.pay === 'now');
      const refund = lockedIn
        ? { due: false, ask: true, amount: booking.paidAmount, orderId: booking.orderId || null, reason: 'paid online, so staff decide' }
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
    // Back to 'confirmed' from seated or done undoes the check-in (and its loyalty stamps, round 6): checking in again works.
    if (next.status === 'confirmed' && ['seated', 'done'].includes(booking.status)) next.arrivedAt = null;
    if (next.status !== 'held') next.holdUntil = null;
    if (patch.status === 'done') next.end = Math.max(Math.min(next.end, now), next.start);
    if (patch.people != null) {
      next.people = Math.max(1, Math.min(60, Math.floor(Number(patch.people)) || 1));
      const seatGame = next.kind === 'gm-seat' && next.gameId ? this.game(next.gameId) : null;
      // A game spot keeps its price a person (the event's entry fee, or the table fee).
      const unit = next.kind === 'gm-seat' ? seatGame?.seatPrice || rules.prices.gmSeat
        : next.occurrenceId && booking.people ? Math.round(booking.amount / booking.people)
          : tableIndex(rules.rooms).get(next.tables[0])?.roomObj.price || rules.prices.table;
      next.amount = unit * next.people;
      // A bigger group owes more; a smaller one may be paid up already.
      next.paid = settled(next);
    }
    if (typeof patch.paid === 'boolean') {
      // Marked paid by hand (cash, or sorted out another way): what was owed counts as paid. Unmarked: only the
      // payments the shop recorded count.
      next.paid = patch.paid;
      next.paidAmount = patch.paid ? Math.max(next.paidAmount || 0, (next.amount || 0) - (next.covered || 0)) : this.paidSoFar('booking', next.id);
    }
    if (typeof patch.refunded === 'boolean') {
      if (patch.refunded && !next.paid && !(next.paidAmount > 0)) throw new RuleError('Only a paid booking can be marked as refunded.');
      next.refund = patch.refunded ? 'done' : null;
    }
    // Waived: staff let them off what's left (a weekly regular's owed seat, say). Nothing is due and it's not owed;
    // whatever was paid stays paid. false puts it back.
    if (typeof patch.waived === 'boolean') {
      if (patch.waived && next.kind === 'gm') throw new RuleError("The GM's own table has nothing to pay.");
      next.waived = patch.waived;
    }
    // A game seat can't grow into seats held for the series' weekly regulars (they aren't anyone else's to take), the
    // same as staff adding players: more people on a seat, or a cancelled seat put back, takes free seats nobody is
    // holding. The seats held are the board's held: the regulars still waiting, up to the seats free. When none are
    // held (a full table, or no regulars waiting), staff can still squeeze someone in, as before.
    if (next.kind === 'gm-seat' && next.gameId) {
      const before = ACTIVE.has(booking.status) ? booking.people : 0;
      const after = ACTIVE.has(next.status) ? next.people : 0;
      const game = after > before ? this.game(next.gameId) : null;
      if (game) {
        const free = Math.max(0, game.seats - this.takenSeats(game.id));
        const kept = Math.min(this.regularsWaiting(game, { except: next.customerId, now }), free);
        if (kept > 0 && after - before > free - kept) {
          const what = before ? `No room for ${plural(after - before, 'more person', 'more people')}` : 'No room to put this seat back';
          throw new RuleError(`${what}: ${plural(kept, 'seat is', 'seats are')} kept for regulars.`, 409);
        }
      }
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
        // Staff moves skip locked event tables (blocked for everyone except staff).
        if (end > from && !isFree(st, rules, t, from, end, ignore, { staff: true })) throw new RuleError(`Table ${t} is taken at that time.`, 409);
      }
      next.tables = tables;
      next.end = end;
      next.room = room.id;
      if (game) moveGame = { game, together, tables, end, room: room.id };
    }
    // Cancelled or a no-show: what's owed back, worked out before saving.
    const ending = ['cancelled', 'noshow'].includes(next.status) && booking.status !== next.status;
    let refund;
    if (ending && next.status === 'cancelled' && booking.occurrenceId && booking.paidAmount > 0) {
      // Staff cancelling an event's game spot (the event's off, or they've sorted it out): what was paid comes back.
      refund = { due: true, amount: booking.paidAmount, orderId: booking.orderId || null, reason: 'cancelled by staff' };
      if (next.refund !== 'done') next.refund = 'due';
    } else if (ending && next.status === 'cancelled') {
      // Paid online and cancelled: the cancellation policy says whether the money goes back.
      refund = refundFor(booking, rules, now);
      if (refund.due && next.refund !== 'done') next.refund = 'due';
    } else if (ending) {
      // A no-show is only recorded: no email and nothing charged. If they'd paid, a "Refund?" note lets staff decide.
      const paid = booking.paidAmount > 0;
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
    // Round 9: a bill with this on it stays true (paid by hand, waived or changed: see reconcileBills)
    this.reconcileBills(rules, now);
    return { booking: this.staffBooking(this.booking(next.id)), refund };
  }

  /**
   * Round 9: what a staff change to a booking needs, one entry per kind of change (each a key, or a list where any one
   * will do): status, paid and people at the desk or on the floor (Check-in or Tables), a move (Tables), and refunded or
   * waived (Money). An empty patch needs Check-in or Tables. No awaits.
   */
  bookingPerms(patch = {}) {
    const needs = [];
    if (patch.status != null || typeof patch.paid === 'boolean' || patch.people != null) needs.push(BOOKING_STAFF);
    if (Array.isArray(patch.tables) || patch.end != null) needs.push('tables');
    if (typeof patch.refunded === 'boolean' || typeof patch.waived === 'boolean') needs.push('money');
    return needs.length ? needs : [BOOKING_STAFF];
  }

  /** Round 9: what a staff change to an event sign-up needs: checked in or paid (Check-in or Events), refunded (Money) */
  joinPerms(patch = {}) {
    const needs = [];
    if (patch.status != null || typeof patch.paid === 'boolean') needs.push(['checkin', 'events']);
    if (typeof patch.refunded === 'boolean') needs.push('money');
    return needs.length ? needs : [['checkin', 'events']];
  }

  /**
   * Staff: an event sign-up's { paid, refunded, status }. Marked paid by hand, what was owed counts as paid (unmarked,
   * only recorded payments count); refunded: true is 'done', false clears the flag. status (round 6): 'confirmed' undoes
   * a check-in (and the loyalty stamps it earned), 'attended' checks them in. No awaits.
   */
  updateJoin(join, patch, now) {
    if (['confirmed', 'attended'].includes(patch.status) && ['confirmed', 'attended'].includes(join.status) && patch.status !== join.status) {
      this.write(
        'UPDATE event_joins SET status = ?, arrived_at = ?, updated_at = ? WHERE id = ?',
        patch.status, patch.status === 'attended' ? join.arrivedAt || now : null, now, join.id,
      );
      join = this.joinById(join.id);
    }
    let { paid, refund, paidAmount } = join;
    if (typeof patch.paid === 'boolean') {
      paid = patch.paid;
      paidAmount = paid ? Math.max(paidAmount || 0, join.amount || 0) : this.paidSoFar('join', join.id);
    }
    if (typeof patch.refunded === 'boolean') {
      if (patch.refunded && !paid && !(paidAmount > 0)) throw new RuleError('Only a paid sign-up can be marked as refunded.');
      refund = patch.refunded ? 'done' : null;
    }
    this.write('UPDATE event_joins SET paid = ?, paid_amount = ?, refund = ?, updated_at = ? WHERE id = ?', paid ? 1 : 0, paidAmount || 0, refund || null, now, join.id);
    // Round 9: a bill with this sign-up on it stays true
    this.reconcileBills(this.rulesCache, now);
    return { join: this.staffJoinView(this.joinById(join.id)) };
  }

  /**
   * A player dropped their own seat: the GM hears about it. Seats taken counts the seats held for weekly regulars, as
   * the games board does ("3 of 4, 1 held for regulars"), and a seat that's now held for a regular isn't promised to
   * the board.
   */
  tellGmSeatDropped(seat, rules) {
    const game = seat.gameId ? this.game(seat.gameId) : null;
    if (!game || !emailReady(this.env) || !isEmail(game.gmEmail)) return;
    const { taken, held } = this.gameView(game, this.state(game.start - 1, game.end + 1), rules);
    const where = held > 0 && taken >= game.seats ? "Gobgob's keeping the spot for one of your regulars." : "The spot's back on the games board for someone else.";
    this.later(this.mail(this.letter(game.gmEmail, `Seat dropped: ${game.title}, ${this.when(game, rules)}`, {
      title: 'A player dropped out',
      intro: `Kia ora ${game.gm}, ${seat.name} dropped ${seat.people === 1 ? 'their seat' : `their ${seat.people} seats`} at ${game.title}. ${where}`,
      details: [
        ['Game', game.title], ['When', this.when(game, rules)], ['Players', this.partyLine(seat.party)],
        ['Seats taken', `${taken} of ${game.seats}${held > 0 ? `, ${held} held for regulars` : ''}`],
      ],
      button: { label: 'See the games board', url: this.page('gm') },
      signoff: 'Gobgob',
    })));
  }

  /**
   * A new player at a game (round 6): every new seat emails the GM the player's details, whoever made it (a guest, a
   * member, a weekly regular's first seat, or a player staff add). With no GM email on file, the staff get it instead.
   * Seats maintenance rolls forward for regulars never come here. Replies go to the player. No awaits.
   */
  tellGmNewPlayer(seat, game, rules) {
    if (!game || !emailReady(this.env)) return false;
    const toGm = isEmail(game.gmEmail);
    if (!toGm && !this.env.STAFF_EMAIL) return false;
    const { taken } = this.gameView(game, this.state(game.start - 1, game.end + 1), rules);
    const left = Math.max(0, game.seats - taken);
    const when = this.when(game, rules);
    const content = {
      title: toGm ? 'A new player for your game!' : 'A new player for a game',
      intro: toGm
        ? `Kia ora ${game.gm}, ${seat.name} just joined ${game.title}. Gobgob's pulled up ${seat.people === 1 ? 'a chair' : `${seat.people} chairs`}.`
        : `${seat.name} just joined ${game.gm ? `${game.gm}'s game ` : ''}${game.title}. There's no email on file for the GM, so please pass this on.`,
      details: [
        ['Name', seat.name], ['Email', seat.email], ['Phone', seat.phone], ['Seats', String(seat.people)], ['Players', this.partyLine(seat.party)],
        ['Notes', seat.notes], ['When', when], ['Seats left', `${left} of ${game.seats}`],
      ],
      outro: 'They pay at the counter when they arrive.',
      button: { label: 'See the games board', url: this.page('gm') },
    };
    const subject = `New player for ${game.title}, ${when}: ${seat.name}`;
    const replyTo = isEmail(seat.email) ? seat.email : null;
    if (toGm) this.later(this.mail(this.letter(game.gmEmail, subject, { ...content, signoff: 'Gobgob' }, { replyTo })));
    else this.notifyStaff(subject, content, { replyTo });
    return true;
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
        // A staff-made series' dates follow the GM rules plus the shop tables, like its first session (round 7)
        const session = checkGameSession({ tables, start, end }, details, { state: st, rules, time, now, shopTables: Boolean(details.staffCreated) });
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

  /**
   * Round 8: every maintenance run, top up each hold series that's still going (active, and not past its last day) to
   * the booking horizon plus 7 days, as extendSeries does for TTRPG sessions (topUpHoldSeries: skipped days, dates
   * already made and anything in the past are left alone). Returns [{ series, created }] for the ones that got dates.
   * No awaits.
   */
  extendHoldSeries(rules, now) {
    const today = new LairTime(rules.tz).key(now);
    const report = [];
    for (const row of this.sql.exec("SELECT * FROM block_series WHERE status = 'active' AND (until_day IS NULL OR until_day >= ?)", today).toArray()) {
      const made = this.topUpHoldSeries(row, rules, now);
      if (made.length) report.push({ series: row.id, created: made.length });
    }
    return report;
  }

  async createGame(input, who, client = '') {
    if (!who.customerId && !who.staff) throw new RuleError('Log in to run a game, so we know who to pay your store credit to.', 401);
    // Round 9: listing a game for a GM needs GM games; staff games (shop tables, straight on the board) need it too
    if (who.staff && (input.gmCustomerId || input.gmEmail)) this.requireStaff(who, 'sessions');
    const staffGames = this.can(who, 'sessions');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    this.checkRate(who, client, now);
    const time = new LairTime(rules.tz);
    const st = this.state(now - 24 * HOUR, now + (rules.horizonDays + 2) * 24 * HOUR);
    const details = checkGameDetails(input);
    // Round 7: staff make sessions under the GMs' rules (hours, whole hours, lead time, horizon, locked event tables),
    // with the shop tables open to them
    const first = checkGameSession(input, details, { state: st, rules, time, now, shopTables: staffGames });
    // Staff can list a game for a GM (round 7): gmCustomerId, picked from the customers (with gmCustomerName and gmEmail
    // from the picker when they aren't a member yet), or gmEmail with the board name in gm. An email a member has links
    // them; any other is an invite: the game waits on that email with no account, the GM is emailed to make one, and
    // GET /me links it when they log in with it. Until then their store credit is added by hand.
    let gmCustomerId = who.customerId;
    let gmEmail = isEmail(input.email) ? trimmed(input.email, 120) : null;
    let notice = null;
    let picked = null;
    let invited = false;
    const forGm = Boolean(staffGames && (input.gmCustomerId || input.gmEmail));
    if (forGm && input.gmCustomerId) {
      picked = this.pickedCustomer({ customerId: input.gmCustomerId, name: input.gmCustomerName, email: input.gmEmail });
      gmCustomerId = picked.customerId;
      gmEmail = isEmail(input.gmEmail) ? trimmed(input.gmEmail, 120) : picked.email || null;
    } else if (forGm) {
      if (!isEmail(input.gmEmail)) throw new RuleError("That email address doesn't look right.");
      gmEmail = trimmed(input.gmEmail, 120);
      gmCustomerId = this.memberByEmail(gmEmail)?.customer_id || null;
      invited = !gmCustomerId;
    }
    if (picked) this.makeMember(picked, now);
    // Staff and trusted GMs (tagged gm) go straight on the board; anyone else waits for a manager's OK. GM fees of
    // $0, $5 and $10 never need one.
    const approved = Boolean(staffGames || who.gm);
    const feeApproved = true;
    const seriesId = details.schedule === 'one-shot' ? null : makeId('sr');
    if (seriesId) {
      this.write(
        `INSERT INTO series (id, schedule, gm_customer_id, details, tables, clock, length, first_day, status, approved, image_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?)`,
        seriesId, details.schedule, gmCustomerId, JSON.stringify({ ...details, gmEmail, staffCreated: staffGames }), JSON.stringify(first.tables),
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
    if (forGm && invited) {
      // Round 7: a GM who isn't a customer yet: invited by email to make an account, which the game joins
      this.inviteGm(game, rules);
      notice = emailReady(this.env)
        ? `Gobgob emailed ${gmEmail} to make an account. The game joins their account when they log in with that email.`
        : `Emails aren't set up, so Gobgob couldn't email ${gmEmail}. The game joins their account when they log in with that email.`;
    } else if (forGm) this.tellGmLive(game, rules, { listedForThem: true });
    const view = this.state(game.start - 1, game.end + 1);
    return {
      game: this.gameView(game, view, rules), sessions: sessions.map((g) => ({ id: g.id, start: g.start })), skipped, pending: !approved,
      emailed: emailReady(this.env) && Boolean(gmEmail), ...(invited ? { invited: true } : {}), ...(notice ? { notice } : {}),
    };
  }

  /**
   * A game staff listed for a GM who isn't a customer yet (round 7): "You're running <title> at the Dice Goblin Lair",
   * with the game's details and how its account works (make one with this email and the game joins it). No awaits.
   */
  inviteGm(game, rules) {
    if (!emailReady(this.env) || !isEmail(game.gmEmail)) return false;
    const credit = game.gmFee ?? rules.prices.gmCredit;
    this.later(this.mail(this.letter(game.gmEmail, `You're running ${game.title} at the Dice Goblin Lair`, {
      title: 'Your game is on the board!',
      intro: `Kia ora ${game.gm}, the Dice Goblin team has put ${game.title} on the games board for you.`,
      details: [
        ['Game', game.title], [game.seriesId ? 'First session' : 'When', this.when(game, rules)], ['Tables', game.tables.join(', ')],
        ['Player seats', String(game.seats)],
        ['Your credit', credit ? `${dollars(credit)} store credit for each paying player, after the session` : "None: you're covering your players' GM fee, so they pay just the table fee"],
      ],
      outro: [
        `Make your Dice Goblin account with this email (${game.gmEmail}), or log in at dicegoblin.nz with it, and the game joins your account. From My Lair you can see who's coming, message your players and add dates. Your store credit goes onto your account after each session.`,
        'Players can book already. Gobgob will email you each time someone joins.',
      ],
      button: { label: 'Open My Lair', url: this.page('myLair') },
      signoff: 'Happy GMing!\nGobgob',
    })));
    return true;
  }

  /** Whose a game is, for staff (round 7): 'linked' (a GM's account), 'invited' (an email waiting for an account) or 'none' */
  gmAccount(g) {
    if (g.gmCustomerId) return 'linked';
    return isEmail(g.gmEmail) ? 'invited' : 'none';
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
    this.requireStaff(who, 'sessions');
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
      // Round 7: a move follows the GM rules too, skipping only the lead time and the horizon (tonight's session can
      // still move); locked event tables, bookings and holds block it, and the shop tables are open to staff.
      const moved = checkGameSession({ tables, start, end }, details, { state: st, rules, time, now, ignore: own, shopTables: true, editing: true });
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
        details: [['Game', fresh.title], ['Now', this.when(fresh, rules)], ['Was', this.when(game, rules)], ['Where', `${fresh.tables.length > 1 ? 'Tables' : 'Table'} ${fresh.tables.join(', ')}`], ['Your code', seat.ref]],
        outro: "Can't make the new time? Cancel your seat in My Lair and Gobgob will let your GM know.",
        button: { label: 'See it in My Lair', url: this.page('myLair') },
      }))));
    }
    return { game: this.gameView(fresh, this.state(fresh.start - 1, fresh.end + 1), rules), sessions: sessions.length };
  }

  /**
   * POST /games/:id/players { customerId?, customerName?, name, email?, phone?, people, players?, weekly? } (staff): seat
   * someone at a game, with no payment and no rule but the seats left. Their account is linked when customerId is given
   * (picked from the customers: one the Lair hasn't met comes with customerName and email, and their member record is
   * made) or their email matches a member. Round 7, weekly: true at a session of a series:
   *  - a customer becomes a regular from now on, exactly as "Save my seat every week" makes one (this seat is their
   *    first), and gets "You're a regular" too;
   *  - someone without an account (their email needed) is invited: their seat is reserved under their name, and when
   *    they log in with that email the invite becomes their regular membership (adoptGuestBookings). Until then it
   *    holds no later seats.
   * Returns { booking, game, emailed, regular: { seriesId, customerId } | null, invite: { id, email } | null }.
   */
  async addPlayers(id, input, who) {
    this.requireStaff(who, 'sessions');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    if (game.status === 'cancelled') throw new RuleError('That game was cancelled.', 409);
    // Round 9: a member code finds the member at once (their name and email come from their member record)
    const typed = String(input.code ?? '').trim();
    const byCode = typed ? this.memberByCode(typed) : null;
    if (typed && !byCode) throw new RuleError(TEAM_WORDS.noMember, 404);
    if (byCode) input = { ...input, customerId: byCode.customer_id, name: trimmed(input.name, 80) || byCode.name || byCode.first_name || byCode.code, email: trimmed(input.email, 120) || byCode.email || '' };
    const people = Math.floor(Number(input.people ?? 1));
    if (!(people >= 1 && people <= 8)) throw new RuleError('Add between 1 and 8 players.');
    const name = trimmed(input.name, 80);
    if (!name) throw new RuleError('Add their name.');
    let email = trimmed(input.email, 120);
    if (email && !isEmail(email)) throw new RuleError("That email address doesn't look right.");
    const weekly = input.weekly === true;
    if (weekly && !game.seriesId) throw new RuleError("This game is a one-off, so a seat can't be saved every week.");
    const series = weekly ? this.sql.exec('SELECT * FROM series WHERE id = ?', game.seriesId).toArray()[0] : null;
    if (weekly && (!series || series.status !== 'active')) throw new RuleError("This game isn't running any more.", 409);
    // A customer picked from the search (round 7: one the Lair hasn't met comes with their name and email)
    const picked = String(input.customerId ?? '').trim() ? this.pickedCustomer({ customerId: input.customerId, name: input.customerName || name, email }) : null;
    const customerId = picked?.customerId || this.memberByEmail(email)?.customer_id || null;
    if (!email && picked?.email) email = picked.email;
    if (weekly && !customerId && !email) throw new RuleError('Add their email, so Gobgob can invite them to keep the seat.');
    // Seats kept for the series' weekly regulars aren't free (unless it's a regular being added). The number kept is the
    // board's held: never more than the seats still free.
    const held = this.regularsWaiting(game, { except: customerId, now });
    const taken = this.takenSeats(game.id);
    const left = game.seats - taken - held;
    if (people > left) {
      const kept = Math.min(held, Math.max(0, game.seats - taken));
      const why = kept ? ` ${plural(kept, 'seat is', 'seats are')} kept for regulars.` : '';
      throw new RuleError(left > 0 ? `Only ${left} ${left === 1 ? 'seat' : 'seats'} left.${why}` : `This table is full.${why}`, 409);
    }
    const players = seatPlayers(input.players, people, name);
    if (picked) this.makeMember(picked, now);
    const regular = weekly && customerId ? { seriesId: game.seriesId, customerId } : null;
    const seatId = makeId('bk');
    const seat = {
      id: seatId, ref: this.newCode(name, 'booking', seatId, now), kind: 'gm-seat', status: 'confirmed', gameId: game.id, tables: game.tables, room: game.room,
      start: game.start, end: game.end, people, name, email, amount: (game.seatPrice || rules.prices.gmSeat) * people, pay: 'day', paid: false,
      activity: 'rpg', party: players, customerId, notes: 'Added by staff',
      // Round 7: an optional phone (staff-made, so not required), and a new regular's first seat carries the series
      phone: trimmed(input.phone, 40).replace(/\s+/g, ' ').slice(0, 20) || null, seriesId: regular ? game.seriesId : null,
    };
    this.saveBooking(seat, now);
    let invite = null;
    if (regular) {
      // A regular from now on, as "Save my seat every week" makes one (joinSeries): later seats are theirs, and
      // maintenance books each next session. Someone already a regular keeps their place in the queue.
      this.write(
        `INSERT INTO series_members (series_id, customer_id, people, players, name, email, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(series_id, customer_id) DO UPDATE SET people = excluded.people, players = excluded.players, name = excluded.name, email = excluded.email,
           status = 'active', created_at = CASE WHEN series_members.status = 'active' THEN series_members.created_at ELSE excluded.created_at END,
           updated_at = excluded.updated_at`,
        game.seriesId, customerId, people, JSON.stringify(players), name, email || this.memberRow(customerId)?.email || null, now, now,
      );
    } else if (weekly) {
      // An invite to be a regular, for someone still to make an account: one waiting invite per series and email
      const by = who.customerId ? `staff:${who.customerId}` : 'staff';
      const waiting = this.sql.exec("SELECT id FROM series_invites WHERE series_id = ? AND lower(email) = lower(?) AND status = 'waiting'", game.seriesId, email).toArray()[0];
      const inviteId = waiting?.id || makeId('si');
      if (waiting) {
        this.write(
          'UPDATE series_invites SET name = ?, phone = ?, people = ?, players = ?, booking_id = ?, updated_at = ? WHERE id = ?',
          name, seat.phone, people, JSON.stringify(players), seatId, now, inviteId,
        );
      } else {
        this.write(
          `INSERT INTO series_invites (id, series_id, email, name, phone, people, players, status, customer_id, booking_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', NULL, ?, ?, ?, ?)`,
          inviteId, game.seriesId, email, name, seat.phone, people, JSON.stringify(players), seatId, by, now, now,
        );
      }
      invite = { id: inviteId, email };
    }
    this.tellGmNewPlayer(seat, game, rules);
    const emailed = this.confirm(seat, rules, game, { invite: invite ? game.schedule : null });
    if (regular) this.tellStaffRegular(seat, game, rules);
    return {
      booking: { ...this.ownView(seat), players, customerId }, game: this.gameView(game, this.state(game.start - 1, game.end + 1), rules), emailed,
      regular, invite,
      // Round 9: staff can still add someone whose monthly account is at its limit, and see a warning
      ...this.accountWarning(customerId, rules, now),
    };
  }

  /**
   * "You're a regular: <title>" for someone staff made a regular (round 7): round 5's email, with the team saving their
   * seat every week (fortnight, or session, to match the game). No awaits.
   */
  tellStaffRegular(seat, game, rules) {
    const member = this.memberRow(seat.customerId);
    const to = isEmail(seat.email) ? seat.email : member?.email;
    if (!emailReady(this.env) || !isEmail(to)) return false;
    const every = game.schedule === 'weekly' ? 'week' : game.schedule === 'fortnightly' ? 'fortnight' : 'session';
    this.later(this.mail(this.letter(to, `You're a regular: ${game.title}`, {
      title: "You're a regular!",
      intro: `Kia ora ${seat.name}, the Dice Goblin team has saved your seat at ${game.title}${game.gm ? ` with GM ${game.gm}` : ''} every ${every}.`,
      details: [
        ['Game', game.title], ['Players', this.partyLine(seat.party)], ['Next session', this.when(game, rules)],
        ['Fee', `${dollars((game.seatPrice || rules.prices.gmSeat) * seat.people)} a session, paid at the counter`], ['Your code', member?.code || ''],
      ],
      outro: [
        "Your member code is your ticket every session (it's in My Lair). Show it at the counter and we'll ring up your seat.",
        "Can't make one? Cancel that session's seat in My Lair before it starts. A seat you keep is yours to pay for, even if you don't come.",
        'To stop coming, leave the game in My Lair.',
      ],
      button: { label: 'See it in My Lair', url: this.page('myLair') },
    })));
    return true;
  }

  /** A GM (or staff) adds a date to a flexible or repeating game. A one-shot becomes a flexible series. */
  async addSession(id, input, who) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const game = this.game(id);
    if (!game) throw new RuleError('Game not found.', 404);
    const own = who.customerId && game.gmCustomerId === who.customerId;
    // Round 9: staff here means GM games
    const staffGames = this.can(who, 'sessions');
    if (!staffGames && !own) throw new RuleError('Only the GM or staff can add a session.', 403);
    if (game.status === 'cancelled') throw new RuleError('That game was cancelled. List it again as a new game.', 409);
    const time = new LairTime(rules.tz);
    const st = this.state(now - 24 * HOUR, now + (rules.horizonDays + 2) * 24 * HOUR);
    const details = this.gameDetails(game);
    const tables = Array.isArray(input.tables) && input.tables.length ? input.tables : game.tables;
    // Round 7: staff adding a date follow the GM rules too, with the shop tables open to them
    const session = checkGameSession({ tables, start: input.start, end: input.end }, details, { state: st, rules, time, now, shopTables: staffGames });
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
    const approved = Boolean(series?.approved) || game.status === 'open' || staffGames;
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
        details: [
          ['When', this.when(created, rules)], ['Players', this.partyLine(result.seat.party)], ['Fee', `${dollars(result.seat.amount)}, pay at the counter`],
          ['Your code', this.ticketCode(result.seat)],
        ],
        outro: [COUNTER, "Can't make this one? Cancel it in My Lair before it starts, and you're still a regular. A seat you keep is yours to pay for, even if you don't come."],
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
   * Regulars are seated in the order they joined. ahead: seats to keep for regulars who joined earlier; left out, it's
   * the seats those still waiting for one there would take (seatsAhead), so someone joining doesn't take an earlier
   * regular's seat. Callers that seat every regular in join order pass 0, so one who doesn't fit never keeps a seat
   * from the next. Series members pay at the counter each session. No awaits.
   */
  seatSeriesMember(session, member, rules, now, { ahead = null } = {}) {
    const existing = this.sql
      .exec("SELECT * FROM bookings WHERE game_id = ? AND customer_id = ? AND kind = 'gm-seat' AND status IN ('held', 'confirmed', 'seated') LIMIT 1", session.id, member.customer_id)
      .toArray()[0];
    if (existing) return { seat: this.rowToBooking(existing), created: false };
    const earlier = ahead ?? this.seatsAhead(session, member, now);
    if (session.seats - this.takenSeats(session.id) - earlier < member.people) return null;
    const seatId = makeId('bk');
    const seat = {
      id: seatId, ref: this.newCode(member.name, 'booking', seatId, now), kind: 'gm-seat', status: 'confirmed', gameId: session.id, seriesId: session.seriesId,
      tables: session.tables, room: session.room, start: session.start, end: session.end, people: member.people, name: member.name, email: member.email,
      amount: (session.seatPrice || rules.prices.gmSeat) * member.people, pay: 'day', paid: false, activity: 'rpg', party: parse(member.players, []),
      // round 7: a regular's seat carries the mobile on their player profile
      customerId: member.customer_id, phone: this.memberRow(member.customer_id)?.mobile || null,
    };
    this.saveBooking(seat, now);
    return { seat, created: true };
  }

  /**
   * A new open session seats the series' members while there's room, first to join first, but only when it's the
   * series' next session: regulars hold a seat in the next session only, and roll forward as sessions end (rollSeries).
   * Returns the new seats. No awaits.
   */
  seatSeriesMembers(session, rules, now) {
    if (session.status !== 'open' || !session.seriesId || session.start <= now) return [];
    if (this.nextSession(session.seriesId, now)?.id !== session.id) return [];
    const members = this.sql.exec("SELECT * FROM series_members WHERE series_id = ? AND status = 'active' ORDER BY created_at, customer_id", session.seriesId).toArray();
    return members.map((member) => ({ member, result: this.seatSeriesMember(session, member, rules, now, { ahead: 0 }) })).filter((x) => x.result?.created);
  }

  /** Whether a customer has any seat at a session, even one they cancelled (they're skipping it). No awaits. */
  hasSeatAt(gameId, customerId) {
    return this.sql.exec("SELECT 1 AS n FROM bookings WHERE game_id = ? AND customer_id = ? AND kind = 'gm-seat' LIMIT 1", gameId, String(customerId)).toArray().length > 0;
  }

  /**
   * Weekly regulars roll forward: every active member of an active series has a seat in its next session, booked in
   * the order they joined. Run by the 10-minute maintenance, so once a session ends the regulars get the next one (a
   * session under way is left alone until it ends). Anyone with any booking there (even one they cancelled, to skip it)
   * is left alone, so nothing is ever booked twice or undone. A regular who doesn't fit gets the staff an alert, once
   * per member and session; if a seat frees up before it starts, a later run books it and emails them, so nobody owes
   * for a seat they didn't know about. No awaits. Returns { seated, full }.
   */
  rollSeries(rules, now) {
    const members = this.sql
      .exec(
        `SELECT m.* FROM series_members m JOIN series s ON s.id = m.series_id WHERE m.status = 'active' AND s.status = 'active'
         ORDER BY m.series_id, m.created_at, m.customer_id`,
      )
      .toArray();
    const sessions = new Map();
    let seated = 0;
    const full = [];
    const freed = [];
    for (const member of members) {
      if (!sessions.has(member.series_id)) sessions.set(member.series_id, this.nextSession(member.series_id, now));
      const next = sessions.get(member.series_id);
      if (!next || next.status !== 'open' || next.start <= now || this.hasSeatAt(next.id, member.customer_id)) continue;
      // An alert row means they know this session was full: the staff were told (at is when), or they were told
      // themselves when they joined (at is empty until the staff hear too). Either way a seat that comes free gets them
      // an email.
      const alert = this.sql.exec('SELECT at FROM series_alerts WHERE game_id = ? AND customer_id = ?', next.id, member.customer_id).toArray()[0];
      // In join order, so earlier regulars pick first; one who doesn't fit doesn't keep a seat from the next.
      const got = this.seatSeriesMember(next, member, rules, now, { ahead: 0 });
      if (got?.created) {
        seated += 1;
        if (alert) freed.push({ game: next, member, seat: got.seat });
        continue;
      }
      if (got || alert?.at != null) continue;
      if (alert) this.write('UPDATE series_alerts SET at = ? WHERE game_id = ? AND customer_id = ?', now, next.id, member.customer_id);
      else this.write('INSERT INTO series_alerts (game_id, customer_id, at) VALUES (?, ?, ?)', next.id, member.customer_id, now);
      full.push({ game: next, member });
    }
    // A regular who missed out has a seat after all: tell them, since it's theirs to pay for if they keep it.
    if (freed.length && emailReady(this.env)) {
      this.later(this.mailMany(freed.filter((x) => isEmail(x.member.email)).map(({ game, member, seat }) => this.letter(member.email, `A seat came free: ${game.title}, ${this.when(game, rules)}`, {
        title: 'A seat came free!',
        intro: `Kia ora ${member.name || 'friend'}, the next session of ${game.title} was full, but a seat's come free and Gobgob saved it for you.`,
        details: [
          ['When', this.when(game, rules)], ['Players', this.partyLine(seat.party)], ['Fee', `${dollars(seat.amount)}, pay at the counter`],
          ['Your code', this.ticketCode(seat)],
        ],
        outro: "Can't make it? Cancel it in My Lair before it starts. A seat you keep is yours to pay for, even if you don't come.",
        button: { label: 'See it in My Lair', url: this.page('myLair') },
      }))));
    }
    // One email for each session that's full, naming the regulars who couldn't get their seat. Seats taken is the
    // games board's count (seats held for regulars included).
    const byGame = new Map();
    for (const x of full) byGame.set(x.game.id, [...(byGame.get(x.game.id) || []), x]);
    for (const list of byGame.values()) {
      const game = list[0].game;
      const names = list.map(({ member }) => `${member.name || 'A regular'}${member.people > 1 ? ` (${member.people} seats)` : ''}`);
      const { taken, held } = this.gameView(game, this.state(game.start - 1, game.end + 1), rules);
      this.notifyStaff(`No seat for a regular: ${game.title}, ${this.when(game, rules)}`, {
        title: "A regular couldn't get their seat",
        intro: `The next session of ${game.title} is full, so Gobgob couldn't save ${list.length === 1 ? 'a seat' : 'seats'} for ${names.join(', ')}. Find them a seat on the staff page, or let them know.`,
        details: [
          ['Game', `${game.title}${game.gm ? `, GM ${game.gm}` : ''}`], ['When', this.when(game, rules)], ['Regulars without a seat', names.join('\n')],
          ['Seats taken', `${taken} of ${game.seats}${held > 0 ? `, ${held} held for regulars` : ''}`],
        ],
      });
    }
    return { seated, full: full.length };
  }

  /**
   * POST /games/:id/join-series { people, players, name, email } (logged in): a weekly regular. Their membership is
   * saved and they get a seat in the series' next session, if it has room (one already under way doesn't count: they'd
   * owe for a session they weren't at); after each session ends, maintenance gives them the next one (rollSeries).
   * Their member code is the ticket. A seat they keep is theirs to pay for, whether or not they come (owed once the
   * session ends); skip one by cancelling that seat, and leave with POST /series/:id/leave. Joining again (to change
   * who's coming) saves the change and books the next session if they have no seat there. Returns { member, booked, full }.
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
    // Round 7: a mobile number, saved to their profile, so their seats (this one and maintenance's) carry it
    const mobile = checkMobile(input.phone);
    const players = seatPlayers(input.players, people, name);
    this.checkRate(who, client, now);
    // Round 9: a weekly seat on a monthly account: not over its credit limit
    this.checkAccountLimit(who.customerId, (game.seatPrice || rules.prices.gmSeat) * people, rules, now, 'book');
    // created_at is when they joined, which sets their place in the queue for seats (first to join is seated first).
    // Joining again to change who's coming keeps it; someone who left and comes back joins at the back, so they never
    // take a seat held for a regular who stayed.
    this.write(
      `INSERT INTO series_members (series_id, customer_id, people, players, name, email, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(series_id, customer_id) DO UPDATE SET people = excluded.people, players = excluded.players, name = excluded.name, email = excluded.email,
         status = 'active', created_at = CASE WHEN series_members.status = 'active' THEN series_members.created_at ELSE excluded.created_at END,
         updated_at = excluded.updated_at`,
      game.seriesId, who.customerId, people, JSON.stringify(players), name, email, now, now,
    );
    this.touchMember(who.customerId, { name, email, mobile }, now);
    const member = this.seriesMember(game.seriesId, who.customerId);
    const code = this.memberRow(who.customerId)?.code || null;
    const booked = [];
    const full = [];
    // Only the next session still to start: later ones roll forward as each session ends. When it's full they're told
    // so (and the email promises to let them know if a seat comes free), which is noted for maintenance: if it seats
    // them before the staff hear, it still sends "A seat came free".
    const next = this.upcomingSession(game.seriesId, now);
    if (next && next.status === 'open') {
      const got = this.seatSeriesMember(next, member, rules, now);
      if (got) booked.push({ gameId: next.id, start: next.start, ref: got.seat.ref, ticketCode: code || got.seat.ref });
      // A weekly regular's first seat is a new player: the GM hears (round 6). Seats maintenance rolls forward don't.
      if (got?.created) this.tellGmNewPlayer(got.seat, next, rules);
      if (!got) {
        full.push({ gameId: next.id, start: next.start });
        this.write('INSERT OR IGNORE INTO series_alerts (game_id, customer_id, at) VALUES (?, ?, NULL)', next.id, who.customerId);
      }
    }
    if (emailReady(this.env)) {
      const gm = game.gm ? ` with GM ${game.gm}` : '';
      const intro = booked.length
        ? `Kia ora ${name}, you're a regular at ${game.title}${gm}. Gobgob's booked your seat for the next session and will save you one every session after that.`
        : full.length
          ? `Kia ora ${name}, you're a regular at ${game.title}${gm}. The next session's full, sorry. If a seat comes free before it starts, Gobgob will grab it and let you know, and your seat's saved from the one after.`
          : `Kia ora ${name}, you're a regular at ${game.title}${gm}. Gobgob will save your seat as soon as the next session's on the board.`;
      this.later(this.mail(this.letter(email, `You're a regular: ${game.title}`, {
        title: "You're a regular!",
        intro,
        details: [
          ['Game', game.title], ['Players', this.partyLine(players)], ['Next session', booked.length ? this.when(next, rules) : ''],
          ['Already full', full.length ? this.when(next, rules) : ''],
          ['Fee', `${dollars((game.seatPrice || rules.prices.gmSeat) * people)} a session, paid at the counter`], ['Your code', code || ''],
        ],
        outro: [
          "Your member code is your ticket every session (it's in My Lair). Show it at the counter and we'll ring up your seat.",
          "Can't make one? Cancel that session's seat in My Lair before it starts. A seat you keep is yours to pay for, even if you don't come.",
          'To stop coming, leave the game in My Lair.',
        ],
        button: { label: 'See it in My Lair', url: this.page('myLair') },
      })));
    }
    return { member: { seriesId: game.seriesId, people, players }, booked, full };
  }

  /**
   * POST /series/:id/leave (logged in): stop being seated at every session, and free the upcoming seats it made. Round
   * 7, staff: { customerId } stops a regular (the same as them leaving, with the GM's email), and { inviteId } cancels a
   * waiting invite (the seat reserved with it stays until staff remove it).
   */
  async leaveSeries(seriesId, who, input = {}) {
    if (!who.customerId) throw new RuleError('Log in to manage your games.', 401);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    // Round 9: stopping someone else's seat or invite needs GM games
    if (who.staff && (input?.inviteId || input?.customerId)) this.requireStaff(who, 'sessions');
    if (who.staff && input?.inviteId) {
      const invite = this.sql.exec('SELECT * FROM series_invites WHERE id = ? AND series_id = ?', trimmed(input.inviteId, 40), String(seriesId)).toArray()[0];
      if (!invite || invite.status !== 'waiting') throw new RuleError('That invite could not be found.', 404);
      this.write("UPDATE series_invites SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'waiting'", now, invite.id);
      return { ok: true, cancelled: 0, invite: { id: invite.id, email: invite.email, status: 'cancelled' } };
    }
    const forThem = Boolean(who.staff && input?.customerId);
    const customerId = forThem ? trimmed(input.customerId, 40) : String(who.customerId);
    const member = this.seriesMember(seriesId, customerId);
    if (!member || member.status !== 'active') throw new RuleError(forThem ? "They're not a regular at that game." : "You're not signed up for every session of that game.", 404);
    this.write("UPDATE series_members SET status = 'left', updated_at = ? WHERE series_id = ? AND customer_id = ?", now, seriesId, customerId);
    const seats = this.sql
      .exec("SELECT * FROM bookings WHERE series_id = ? AND customer_id = ? AND kind = 'gm-seat' AND status IN ('held', 'confirmed') AND starts_at > ? ORDER BY starts_at", seriesId, customerId, now)
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
    // Round 9: staff here means GM games
    const staffGames = this.can(who, 'sessions');
    if (!staffGames && !own) throw new RuleError('Only the GM or staff can message the players.', 403);
    const text = String(input.text ?? '').trim().slice(0, 2000);
    if (!text) throw new RuleError('Write a message first.');
    const scope = input.scope === 'series' && game.seriesId ? 'series' : 'session';
    if (!emailReady(this.env)) throw new RuleError("Emails aren't set up yet, so messages can't go out. Call the shop instead.", 503);
    const limitKey = game.seriesId || game.id;
    if (!staffGames) {
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
      id, game.id, limitKey, scope, text, recipients.size, staffGames && !own ? 'staff' : 'gm', now,
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
   * make. Returns { affected (seats cancelled), refunds (paid seats flagged) }. No awaits.
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
        // Whatever was paid for the seat comes back (a split bill may be part paid).
        const refund = seat.paidAmount > 0;
        if (refund) {
          this.write("UPDATE bookings SET refund = 'due', updated_at = ? WHERE id = ? AND (refund IS NULL OR refund != 'done')", now, seat.id);
          refunds.push([seat.ref, `${seat.name}: ${dollars(seat.paidAmount)} for ${this.when(game, rules)}${seat.pay === 'now' ? ', paid online' : ', paid at the counter'}${seat.orderId ? ` (order ${String(seat.orderId).split('/').pop()})` : ''}`]);
        }
        if (!isEmail(seat.email)) continue;
        letters.push(this.letter(seat.email, `Cancelled: ${game.title}, ${this.when(game, rules)}`, {
          title: "Your game's been cancelled",
          intro: [
            `Sorry, friend: ${game.title} on ${this.when(game, rules)} has been cancelled, so your seat is cancelled too.`,
            ...(refund
              ? [seat.pay === 'now'
                ? "You paid online, so you'll get your money back. The team will refund your card in the next few days."
                : "You've paid already, so you'll get your money back. Pop in or reply to this email and the team will sort it."]
              : []),
          ],
          details: [['Game', game.title], ['Was on', this.when(game, rules)], ['Your code', seat.ref], ['Refund', refund ? dollars(seat.paidAmount) : '']],
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
    return { affected, refunds: refunds.length };
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
    // Round 9: staff here means GM games
    if (!this.can(who, 'sessions')) {
      if (!own || patch.status !== 'cancelled') throw new RuleError('Only staff can change that game.', 403);
      if (scope === 'session' && !cancellable(game)) throw new RuleError('This session started more than an hour ago. Talk to staff at the counter.', 403);
    }
    if (game.status === 'cancelled' && patch.status && patch.status !== 'cancelled') {
      throw new RuleError('Cancelled games stay cancelled. List it again as a new game.', 409);
    }
    const before = game.status;
    let affected = 0;
    let refunds = 0;
    if (patch.status === 'cancelled') {
      // A series: every future session, and this one too while it can still be cancelled.
      const targets = scope === 'series'
        ? this.sql.exec("SELECT * FROM games WHERE series_id = ? AND status != 'cancelled' AND (starts_at > ? OR (id = ? AND starts_at >= ?))", game.seriesId, now, game.id, now - HOUR)
          .toArray().map((r) => this.rowToGame(r))
        : before === 'cancelled' ? [] : [game];
      if (scope === 'series') this.write("UPDATE series SET status = 'cancelled', updated_at = ? WHERE id = ?", now, game.seriesId);
      ({ affected, refunds } = this.cancelSessions(targets, rules, now));
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
    // affected: seats cancelled (each player is emailed); refunds: how many of them were paid, so are flagged 'due'
    return { game: this.gameView(fresh, this.state(fresh.start - 1, fresh.end + 1), rules), affected, refunds };
  }

  async creditGm(id, who) {
    // Round 9: the GM's store credit is money
    this.requireStaff(who, 'money');
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
    if (!this.can(who, 'sessions') && !own) throw new RuleError('Only the GM or staff can change the picture.', 403);
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

  /**
   * Staff hold tables. Round 8: a hold can repeat (`repeat`: 'weekly' or 'fortnightly'; '' or left out is a one-off, as
   * before) up to `until` ('YYYY-MM-DD', the last day one can start on; empty: no end). Then it's a hold series
   * (block_series) and one blocks row a date, made up to the booking horizon plus 7 days (maintenance makes the rest as
   * the days go by: extendHoldSeries). Holding never moves a booking: clashes lists the active bookings on those tables
   * at any date made, [{ ref, start }]. Answer: { block (the first hold), clashes, series: seriesView | null }.
   */
  async createBlock(input, who) {
    this.requireStaff(who, 'tables');
    const rules = await this.rules();
    // --- no awaits from here on: the checks, the holds and their clashes in one go ---
    const now = Date.now();
    const time = new LairTime(rules.tz);
    const tables = (Array.isArray(input.tables) ? input.tables : parseTableList(input.tables, rules.rooms)).map(String);
    const index = tableIndex(rules.rooms);
    if (!tables.length || tables.some((t) => !index.has(t))) throw new RuleError('Pick tables that exist, like T11-T20.');
    const start = Number(input.start);
    const end = Number(input.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) throw new RuleError('The hold needs an end time after the start.');
    const repeat = String(input.repeat ?? '').trim().toLowerCase();
    if (repeat && !HOLD_REPEATS[repeat]) throw new RuleError('Pick how often it repeats: weekly or fortnightly. Or leave it as a one-off.');
    const firstDay = time.key(start);
    const untilText = repeat ? String(input.until ?? '').trim() : '';
    if (untilText && !(/^\d{4}-\d{2}-\d{2}$/.test(untilText) && addDays(untilText, 0) === untilText && untilText >= firstDay)) {
      throw new RuleError("'Repeat until' has to be a date on or after the first one.");
    }
    // game (round 6): what it's for, like "Pokémon" or "Magic: The Gathering", up to 40 characters, for the calendar's
    // sub-categories
    const block = {
      id: makeId('bl'), tables, start, end, label: String(input.label || 'Held').slice(0, 80), type: String(input.type || 'event').slice(0, 20),
      game: trimmed(input.game, 40) || null,
    };
    let series = null;
    if (repeat) {
      series = {
        id: makeId('hs'), tables: JSON.stringify(tables), start_min: time.minutesOf(start), minutes: Math.max(1, Math.round((end - start) / MIN)),
        every_days: HOLD_REPEATS[repeat], first_day: firstDay, until_day: untilText || null, skip_days: '[]', label: block.label, type: block.type,
        game: block.game, status: 'active', created_by: who.customerId || null, created_at: now, updated_at: now,
      };
      this.write(
        `INSERT INTO block_series (id, tables, start_min, minutes, every_days, first_day, until_day, skip_days, label, type, game, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        series.id, series.tables, series.start_min, series.minutes, series.every_days, series.first_day, series.until_day, series.skip_days,
        series.label, series.type, series.game, series.status, series.created_by, now, now,
      );
    }
    // The first hold is the one asked for, as it was asked for (even beyond the horizon); a series' later dates follow
    this.insertBlock({ ...block, seriesId: series?.id || null }, who.customerId, now);
    const made = [block, ...(series ? this.topUpHoldSeries(series, rules, now) : [])];
    return { block, clashes: this.holdClashes(made, tables), series: series ? this.seriesView(series, rules, now) : null };
  }

  /** One staff hold's row (a series' date carries its seriesId). No awaits. */
  insertBlock(b, by, now) {
    this.write(
      'INSERT INTO blocks (id, tables, starts_at, ends_at, label, type, created_by, created_at, game, series_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      b.id, JSON.stringify(b.tables), b.start, b.end, b.label, b.type, by || null, now, b.game || null, b.seriesId || null,
    );
  }

  /** Round 8: the active bookings on any of these tables at any of these holds' times, once each, soonest first: [{ ref, start }]. No awaits. */
  holdClashes(holds, tables) {
    if (!holds.length) return [];
    const from = Math.min(...holds.map((h) => h.start));
    const to = Math.max(...holds.map((h) => h.end));
    const found = new Map();
    for (const bk of this.sql.exec('SELECT * FROM bookings WHERE ends_at > ? AND starts_at < ?', from, to).toArray().map((r) => this.rowToBooking(r))) {
      if (!ACTIVE.has(bk.status) || found.has(bk.id) || !bk.tables.some((t) => tables.includes(t))) continue;
      if (holds.some((h) => bk.start < h.end && h.start < bk.end)) found.set(bk.id, { ref: bk.ref, start: bk.start });
    }
    return [...found.values()].sort((a, b) => a.start - b.start || a.ref.localeCompare(b.ref));
  }

  /**
   * Round 8: a hold series' dates still to make, made: each day it falls on (holdSeriesDays: up to its last day, not the
   * skipped ones) that has no hold yet, hasn't ended (one under way is held, as its first date would be) and starts no
   * more than the booking horizon plus 7 days ahead, at its Lair clock time for its length (so daylight saving never
   * moves one). Returns the holds made. No awaits.
   */
  topUpHoldSeries(row, rules, now) {
    const time = new LairTime(rules.tz);
    const latest = now + (rules.horizonDays + 7) * 24 * HOUR;
    // from yesterday: a hold that crosses midnight can still be under way
    const yesterday = addDays(time.key(now), -1);
    const have = new Set(
      this.sql.exec('SELECT starts_at FROM blocks WHERE series_id = ? AND starts_at >= ?', row.id, time.at(yesterday, 0)).toArray().map((r) => time.key(r.starts_at)),
    );
    const days = holdSeriesDays({ firstDay: row.first_day, every: row.every_days, until: row.until_day, skip: parse(row.skip_days, []) }, yesterday, time.key(latest));
    const made = [];
    for (const day of days) {
      if (have.has(day)) continue;
      const start = time.at(day, row.start_min);
      if (start + row.minutes * MIN <= now || start > latest) continue;
      const hold = {
        id: makeId('bl'), tables: parse(row.tables, []), start, end: start + row.minutes * MIN, label: row.label, type: row.type, game: row.game || null,
        seriesId: row.id,
      };
      this.insertBlock(hold, row.created_by, now);
      made.push(hold);
    }
    return made;
  }

  /** Round 8: 'weekly' or 'fortnightly' for a hold series' row */
  holdRepeat(row) {
    return row.every_days === HOLD_REPEATS.fortnightly ? 'fortnightly' : 'weekly';
  }

  /** Round 8: "Weekly · Thursdays 6pm", like an event's tag (its first date's weekday and Lair clock time) */
  holdRepeatTag(row, rules) {
    return this.repeatTag({ repeat: this.holdRepeat(row), start: new LairTime(rules.tz).at(row.first_day, row.start_min) }, rules);
  }

  /**
   * Round 8: a hold series as staff see it: { id, label, type, game, tables, repeat, repeatTag, startTime ('18:00'),
   * minutes, firstDay, until, skipDays, status, next: [{ id, start, end }] (up to 6 dates to come: holds not started yet) }.
   * status: 'stopped' (staff stopped it from its first date to come), 'ended' (it has a last day and nothing's left to
   * come) or 'active'. No awaits.
   */
  seriesView(row, rules, now = Date.now()) {
    const time = new LairTime(rules.tz);
    const next = this.sql.exec('SELECT id, starts_at, ends_at FROM blocks WHERE series_id = ? AND starts_at > ? ORDER BY starts_at, id LIMIT 6', row.id, now).toArray();
    const skipDays = parse(row.skip_days, []);
    let status = row.status === 'stopped' ? 'stopped' : 'active';
    if (status === 'active' && row.until_day && !next.length) {
      // nothing to come: ended, unless a date before its last day is still to be made
      const left = holdSeriesDays({ firstDay: row.first_day, every: row.every_days, until: row.until_day, skip: skipDays }, time.key(now), row.until_day);
      if (!left.some((day) => time.at(day, row.start_min) > now)) status = 'ended';
    }
    return {
      id: row.id, label: row.label, type: row.type, game: row.game || null, tables: parse(row.tables, []), repeat: this.holdRepeat(row),
      repeatTag: this.holdRepeatTag(row, rules), startTime: `${String(Math.floor(row.start_min / 60)).padStart(2, '0')}:${String(row.start_min % 60).padStart(2, '0')}`,
      minutes: row.minutes, firstDay: row.first_day, until: row.until_day || null, skipDays, status,
      next: next.map((r) => ({ id: r.id, start: r.starts_at, end: r.ends_at })),
    };
  }

  /** Round 8: the staff floor's holds, each with its series: seriesId, repeat, repeatTag and until (nulls for a one-off). No awaits. */
  staffBlocks(blocks, rules) {
    const ids = [...new Set(blocks.map((bl) => bl.seriesId).filter(Boolean))];
    const rows = ids.length ? this.sql.exec(`SELECT * FROM block_series WHERE id IN (${ids.map(() => '?').join(', ')})`, ...ids).toArray() : [];
    const series = new Map(rows.map((r) => [r.id, { repeat: this.holdRepeat(r), repeatTag: this.holdRepeatTag(r, rules), until: r.until_day || null }]));
    return blocks.map((bl) => {
      const s = (bl.seriesId && series.get(bl.seriesId)) || null;
      return { ...bl, seriesId: s ? bl.seriesId : null, repeat: s?.repeat || null, repeatTag: s?.repeatTag || null, until: s?.until || null };
    });
  }

  /**
   * Staff release a hold. Round 8, a date of a hold series: on its own (no `later`) its day goes on the series' skip list,
   * so maintenance never makes it again; with `later: true`, it goes with every later date that hasn't ended, and the
   * series ends the day before the first of them (until_day). Stopped from its first date to come (nothing of it left to
   * come), the series is 'stopped'. Holds that have ended are never removed that way. { ok, removed }: an id that isn't
   * there removes nothing, so a second tap isn't an error.
   */
  async removeBlock(id, who, input = {}) {
    this.requireStaff(who, 'tables');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const time = new LairTime(rules.tz);
    const row = this.sql.exec('SELECT * FROM blocks WHERE id = ?', String(id || '')).toArray()[0];
    if (!row) return { ok: true, removed: 0 };
    const series = row.series_id ? this.sql.exec('SELECT * FROM block_series WHERE id = ?', row.series_id).toArray()[0] : null;
    if (!series || input?.later !== true) {
      this.write('DELETE FROM blocks WHERE id = ?', row.id);
      if (series) {
        const skip = new Set(parse(series.skip_days, []));
        skip.add(time.key(row.starts_at));
        this.write('UPDATE block_series SET skip_days = ?, updated_at = ? WHERE id = ?', JSON.stringify([...skip].sort()), now, series.id);
      }
      return { ok: true, removed: 1 };
    }
    const going = this.sql.exec('SELECT id, starts_at FROM blocks WHERE series_id = ? AND starts_at >= ? AND ends_at > ? ORDER BY starts_at, id', series.id, row.starts_at, now).toArray();
    for (const x of going) this.write('DELETE FROM blocks WHERE id = ?', x.id);
    // the series ends the day before the first date that went (never later than the last day it had); nothing went
    // (the hold had ended, and nothing after it was left): it ends today
    let until = going.length ? addDays(time.key(going[0].starts_at), -1) : time.key(now);
    if (series.until_day && series.until_day < until) until = series.until_day;
    const toCome = this.sql.exec('SELECT 1 AS n FROM blocks WHERE series_id = ? AND starts_at > ? LIMIT 1', series.id, now).toArray().length > 0;
    this.write('UPDATE block_series SET until_day = ?, status = ?, updated_at = ? WHERE id = ?', until, toCome ? series.status : 'stopped', now, series.id);
    return { ok: true, removed: going.length };
  }

  /**
   * orders/paid webhook (signature already checked by the Worker). Three jobs:
   *
   * Payments for bookings and sign-ups. Customers can put any text in a cart note or cart attribute, so an online
   * order only counts when it came from a draft order (our checkouts; customers can't make those), and only for a
   * booking or sign-up that was sent to checkout: Shopify is asked which order its draft became, and if the draft is
   * gone (deleted as the hold ran out) or not linked yet, the draft-order source is the proof. POS orders are made by
   * staff at the counter, so a POS line with a _booking property pays for that booking. Each such line adds what it
   * paid (price × quantity, less the line's discounts) to the booking's paidAmount, once per order line however often
   * Shopify sends the webhook; a bill can be split between several orders. The order's customer is the payer.
   *
   * Tabs. A POS line with a _tab property marks that self-serve tab paid.
   *
   * Session passes. A line whose SKU is LAIR-PASS-N (online or at the POS) makes a pass of N sessions for each one
   * bought, once per order, line and unit (issueOrderPasses).
   *
   * Members' spend. Every paid order with a customer (online, draft or POS) adds its subtotal after discounts to that
   * customer's spend, once per order: the order id is the key.
   */
  async ordersPaid(order) {
    const orderId = order.admin_graphql_api_id || (order.id ? `gid://shopify/Order/${order.id}` : '');
    if (!orderId || !this.shopify.configured) return { updated: [] };
    const source = order.source_name || '';
    const pos = source === 'pos';
    const fromDraft = !source || source === 'shopify_draft_order';
    // The lines that pay for a booking or sign-up (its code in _booking), with what each paid; tabs paid; and session
    // passes bought (their SKU), with what each one cost after the line's discounts.
    const lines = [];
    const tabs = new Set();
    const passLines = [];
    const giftLines = [];
    (order.line_items || []).forEach((item, index) => {
      const props = item.properties || [];
      const lineId = String(item.id ?? item.admin_graphql_api_id ?? `line-${index}`);
      const booking = props.find((p) => p.name === '_booking' && p.value);
      if (booking) lines.push({ ref: String(booking.value).trim().toUpperCase(), lineId, amount: lineAmount(item) });
      // A self-serve tab's items, rung up at the counter. Only staff make POS orders, so only those count.
      const tab = props.find((p) => p.name === '_tab' && p.value);
      if (tab && pos) tabs.add(String(tab.value).trim());
      const sku = String(item.sku ?? '').trim().match(PASS_SKU);
      const quantity = Math.max(0, Math.floor(Number(item.quantity ?? 1)) || 0);
      if (sku && Number(sku[1]) > 0 && quantity > 0) {
        passLines.push({ lineId, sessions: Number(sku[1]), quantity: Math.min(quantity, PASSES_A_LINE), each: Math.round(lineAmount(item) / quantity) });
      }
      // Round 6: a session gift (LAIR-GIFT-N) makes unlinked gift passes, whoever bought it
      const gift = String(item.sku ?? '').trim().match(GIFT_SKU);
      if (gift && Number(gift[1]) > 0 && quantity > 0) {
        giftLines.push({ lineId, sessions: Number(gift[1]), quantity: Math.min(quantity, PASSES_A_LINE), each: Math.round(lineAmount(item) / quantity) });
      }
    });
    const refs = new Set(lines.map((l) => l.ref));
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
    // Round 9: the Lair bills this order pays (its _bill lines), each checked against the bill's own draft order
    const bills = await this.verifiedBills(order, orderId, { pos, fromDraft, source });
    // --- no awaits from here on: read each booking or sign-up fresh and record what this order paid ---
    const now = Date.now();
    const paying = [];
    for (const v of verified) {
      const own = lines.filter((l) => this.bookingOrJoin(l.ref)?.item.id === v.id);
      // A checkout found by its note (no line names it) paid what was left.
      if (own.length) paying.push(...own.map((l) => ({ ...v, lineId: l.lineId, amount: l.amount })));
      else paying.push({ ...v, lineId: `order:${v.id}`, amount: null });
    }
    const updated = this.recordPayments(paying, orderId, rules, { pos, now });
    const tabsPaid = this.markTabsPaid([...tabs].slice(0, 10), orderId, now);
    // Round 9: a bill paid (its items too), then every open bill kept true: one whose items were all paid at the counter
    // is paid and its draft order deleted, so it can't be paid twice; one partly paid or changed is cancelled
    const billsPaid = this.payBills(bills, order, orderId, rules, { pos, now });
    if (updated.length || tabsPaid.length || billsPaid.length) this.reconcileBills(rules, now, { orderId, pos });

    // Payments are recorded, so if Shopify can't say who the customer is right now, failing the webhook (Shopify
    // sends it again) only repeats work that's already done.
    const spend = await this.orderSpend(orderId);
    const buyer = await this.passBuyer(order, orderId, spend, passLines);
    const giver = await this.giftBuyer(orderId, spend, giftLines);
    // Round 9: a paid early access checkout marks its claim paid (its own awaits, then its own writes)
    await this.offerClaimsPaid(order, orderId);
    // --- no awaits from here on ---
    // The order's customer paid: a friend paying their share with their own member code attached is the payer.
    if (spend?.customerId) this.write('UPDATE payments SET customer_id = ? WHERE order_id = ? AND customer_id IS NULL', spend.customerId, orderId);
    let counted = 0;
    if (spend?.customerId && spend.amount > 0 && !this.sql.exec('SELECT 1 AS n FROM spend WHERE order_id = ?', orderId).toArray().length) {
      this.write('INSERT INTO spend (order_id, customer_id, amount, source, created_at) VALUES (?, ?, ?, ?, ?)', orderId, spend.customerId, spend.amount, spend.source || source || null, Date.now());
      counted = spend.amount;
    }
    const passes = this.issueOrderPasses(orderId, passLines, buyer, { pos, rules, now: Date.now() });
    const gifts = this.issueGiftPasses(orderId, giftLines, giver, { orderName: giver.orderName || spend?.name || buyer.orderName, rules, now: Date.now() });
    if (gifts.length) this.sendGiftCodes(gifts, giver, { orderName: giver.orderName || spend?.name || buyer.orderName, rules });
    // Round 7: a birthday gift's product code on this order (online or at the POS) has been used
    const giftCodes = this.markGiftCodesUsed(spend, Date.now());
    return { updated, tabs: tabsPaid, spend: counted, passes, gifts: gifts.map((g) => g.code), giftCodes, bills: billsPaid };
  }

  /**
   * Who bought an order's session gifts (round 6), to email them the codes: the order's email and the buyer's first name
   * (for the passes' note, "A gift from Sam"). Shopify is only asked while gift passes are still to be made. Names and
   * emails are protected customer data: if Shopify won't say, a member on the order fills in what the Lair knows, and
   * with no email the staff get the codes. Never throws. Returns { email, firstName, orderName }.
   */
  async giftBuyer(orderId, spend, giftLines) {
    if (!giftLines.length || !this.passUnitsToMake(orderId, giftLines).length) return { email: '', firstName: '', orderName: null };
    const member = spend?.customerId ? this.memberRow(spend.customerId) : null;
    const known = {
      email: isEmail(member?.email) ? trimmed(member.email, 120) : '', firstName: member?.first_name || String(member?.name || '').split(/\s+/)[0] || '',
      orderName: spend?.name || null,
    };
    try {
      const found = await this.shopify.orderGiftBuyer(orderId);
      if (found) return { email: isEmail(found.email) ? trimmed(found.email, 120) : known.email, firstName: found.firstName || known.firstName, orderName: found.name || known.orderName };
    } catch (error) {
      this.note({ giftBuyerError: { message: String(error.message || error).slice(0, 300), at: new Date().toISOString() } });
    }
    return known;
  }

  /**
   * Session gifts bought on an order (round 6): each unit of a LAIR-GIFT-N line is an unlinked pass of N sessions, for
   * the buyer to give away and the friend to claim in My Lair: "Gift: N sessions", source 'gift', covering the table fee,
   * no holder, noted "A gift from <first name>" when it's known, made once per order, line and unit (the same unique
   * key as passes, so a webhook sent again makes nothing new). Its code starts DG (it isn't the buyer's). No awaits.
   * Returns [{ code, sessions }].
   */
  issueGiftPasses(orderId, giftLines, giver, { orderName, rules, now }) {
    const made = [];
    for (const { line, unit } of this.passUnitsToMake(orderId, giftLines)) {
      const id = makeId('ps');
      const code = this.newCode('', 'pass', id, now);
      this.write(
        `INSERT INTO passes (id, code, label, sessions_total, sessions_used, cover, customer_id, holder_name, holder_email, note, price_paid, created_at,
           created_by, expires_at, status, source, order_id, order_name, order_line, order_unit) VALUES (?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, 'active', 'gift', ?, ?, ?, ?)`,
        id, code, `Gift: ${plural(line.sessions, 'session', 'sessions')}`, line.sessions, rules.prices.table,
        giver.firstName ? `A gift from ${giver.firstName}` : null, line.each, now, `order:${orderName || orderId}`, orderId, orderName || null, line.lineId, unit,
      );
      made.push({ code, sessions: line.sessions });
    }
    return made;
  }

  /**
   * "Your session gift is ready": every code just made, emailed to the buyer, each in big letters with how many sessions
   * it is and how to redeem it. With no email on the order, or when the email fails, the staff get the codes instead to
   * pass on. No awaits (the email goes out afterwards).
   */
  sendGiftCodes(gifts, giver, { orderName, rules }) {
    if (!emailReady(this.env)) return;
    const many = gifts.length > 1;
    const codes = gifts.map((g) => ({ code: g.code, lines: [`${plural(g.sessions, 'session', 'sessions')} at the Dice Goblin Lair`, GIFT_REDEEM] }));
    const cover = `Each session covers one person's table fee (up to ${money(rules.prices.table)}) at the Dice Goblin Lair.`;
    const toStaff = (why) => this.notifyStaff(`Session gift codes to pass on${orderName ? `: ${orderName}` : ''}`, {
      title: 'Session gift codes to pass on',
      intro: [why, `Give ${many ? 'these codes' : 'this code'} to whoever bought ${orderName || 'the gift'}. ${many ? 'They also show' : 'It also shows'} under Passes on the staff page.`],
      codes, outro: cover,
    });
    if (!isEmail(giver.email)) {
      toStaff("Someone bought a session gift, but there's no email address on the order, so Gobgob couldn't send them the codes.");
      return;
    }
    this.later((async () => {
      const sent = await this.mail(this.letter(giver.email, 'Your session gift is ready', {
        title: many ? 'Your session gifts are ready' : 'Your session gift is ready',
        intro: [
          `Kia ora ${giver.firstName || 'friend'}, thanks for buying ${many ? 'session gifts' : 'a session gift'}. Gobgob wrapped ${many ? 'them' : 'it'} themselves.`,
          `Here ${many ? `are your ${gifts.length} gift codes` : 'is your gift code'}. Hand ${many ? 'each one' : 'it'} to whoever it's for: they add it to their account and play at the Lair.`,
        ],
        codes,
        outro: cover,
        button: { label: 'Open My Lair', url: this.page('myLair') },
      }));
      if (!sent.ok) toStaff(`The session gift codes${orderName ? ` for ${orderName}` : ''} couldn't be emailed to ${giver.email} (${sent.message || 'the email failed'}).`);
    })());
  }

  /** The units of an order's pass lines that don't have their pass yet. No awaits. */
  passUnitsToMake(orderId, passLines) {
    const units = [];
    for (const line of passLines) {
      for (let unit = 0; unit < line.quantity; unit += 1) {
        const made = this.sql.exec('SELECT 1 AS n FROM passes WHERE order_id = ? AND order_line = ? AND order_unit = ?', orderId, line.lineId, unit).toArray().length > 0;
        if (!made) units.push({ line, unit });
      }
    }
    return units;
  }

  /**
   * Who an order's session passes are for: the order's customer (orderSpend found them; their name and email come from
   * their member record), or with no customer, the billing or shipping name. Shopify is only asked when passes are still
   * to be made and the Lair doesn't know the buyer. Names and emails are protected customer data, so without Shopify's
   * approval for them that answer fails: it's noted, and the pass is made with what the Lair has. Never throws.
   * Returns { customerId, orderName, name, email }.
   */
  async passBuyer(order, orderId, spend, passLines) {
    const idOf = (value) => String(value ?? '').match(/(\d+)$/)?.[1] || null;
    const buyer = {
      customerId: spend?.customerId || idOf(order.customer?.id) || null,
      orderName: spend?.name || (order.name ? String(order.name) : null),
      name: trimmed(order.billing_address?.name || order.shipping_address?.name, 80),
      email: '',
    };
    if (!passLines.length || !this.passUnitsToMake(orderId, passLines).length) return buyer;
    const member = buyer.customerId ? this.memberRow(buyer.customerId) : null;
    if (member) return { ...buyer, name: trimmed(member.name || member.first_name, 80), email: isEmail(member.email) ? trimmed(member.email, 120) : '' };
    if (!buyer.customerId && buyer.name) return buyer;
    try {
      const found = await this.shopify.orderBuyer(orderId);
      if (found) {
        const customerId = buyer.customerId || found.customerId;
        return {
          customerId,
          orderName: buyer.orderName || found.name,
          name: trimmed(customerId ? found.customerName : found.billingName || found.shippingName, 80),
          email: customerId && isEmail(found.customerEmail) ? trimmed(found.customerEmail, 120) : '',
        };
      }
    } catch (error) {
      this.note({ passBuyerError: { message: String(error.message || error).slice(0, 300), at: new Date().toISOString() } });
    }
    return buyer;
  }

  /**
   * Session passes bought on an order: each unit of a LAIR-PASS-N line is a pass of N sessions covering the standard
   * table fee, made once (its order, line and unit are kept, so Shopify sending the webhook again makes nothing new).
   * It's linked to the order's customer, or unlinked with the buyer's name ("Sold at the counter" when there's none) for
   * them to claim in My Lair. pricePaid is what the unit cost after the line's discounts. Returns the codes made. No
   * awaits.
   */
  issueOrderPasses(orderId, passLines, buyer, { pos, rules, now }) {
    const made = [];
    for (const { line, unit } of this.passUnitsToMake(orderId, passLines)) {
      const id = makeId('ps');
      const code = this.newCode(buyer.name, 'pass', id, now);
      this.write(
        `INSERT INTO passes (id, code, label, sessions_total, sessions_used, cover, customer_id, holder_name, holder_email, note, price_paid, created_at,
           created_by, expires_at, status, source, order_id, order_name, order_line, order_unit) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', 'order', ?, ?, ?, ?)`,
        id, code, `Session pass: ${plural(line.sessions, 'session', 'sessions')}`, line.sessions, rules.prices.table, buyer.customerId || null,
        buyer.name || (buyer.customerId ? null : SOLD_AT_COUNTER), buyer.email || null, pos ? 'Bought at the counter' : 'Bought online', line.each, now,
        `order:${buyer.orderName || orderId}`, orderId, buyer.orderName || null, line.lineId, unit,
      );
      made.push(code);
    }
    return made;
  }

  /**
   * What one order paid for bookings and sign-ups: [{ type, id, lineId, amount }] (amount null: what was left). Each
   * order line counts once. paid becomes true when nothing is left to pay. A held booking or sign-up is confirmed, and
   * one paid after its hold ran out keeps its place if it's still free (otherwise staff are told). Paying more than was
   * owed is flagged for a refund. The first online payment sends the confirmation. No awaits. Returns the codes paid.
   */
  recordPayments(lines, orderId, rules, { pos = false, now = Date.now() } = {}) {
    const updated = [];
    const groups = new Map();
    for (const l of lines) {
      const key = `${l.type}:${l.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(l);
    }
    for (const group of groups.values()) {
      const { type, id } = group[0];
      const item = type === 'join' ? this.joinById(id) : this.booking(id);
      if (!item) continue;
      updated.push(item.ref);
      const counted = (lineId) => this.sql.exec('SELECT 1 AS n FROM payments WHERE order_id = ? AND line_id = ?', orderId, lineId).toArray().length > 0;
      const fresh = group.filter((l) => !counted(l.lineId));
      // The first release marked a booking paid by this same order before payments were kept: that's counted already.
      const legacy = item.orderId === orderId && !this.sql.exec('SELECT 1 AS n FROM payments WHERE order_id = ? AND booking_id = ?', orderId, item.id).toArray().length;
      if (!fresh.length || legacy) continue;
      const firstTime = !item.paid && !(item.paidAmount > 0);
      const owedBefore = item.paid ? 0 : owing(item);
      let added = 0;
      for (const l of fresh) {
        const amount = l.amount == null ? owedBefore : l.amount;
        this.write(
          'INSERT INTO payments (id, booking_id, kind, order_id, line_id, amount, customer_id, at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
          makeId('pm'), item.id, type, orderId, l.lineId, amount, now,
        );
        added += amount;
      }
      const next = { ...item, paidAmount: (item.paidAmount || 0) + added, orderId: item.orderId || orderId };
      next.paid = Boolean(item.paid) || settled(next);
      if (next.status === 'held') next.status = 'confirmed';
      const notes = [];
      if (item.status === 'cancelled' && firstTime) {
        // Paid after the hold ran out (or after a cancellation): take the place back if it's still free.
        if (item.holdUntil && this.placeStillFree(type, item, rules)) {
          next.status = 'confirmed';
        } else {
          notes.push('[Paid after it was cancelled or the spot was re-booked: refund or reseat]');
          this.notifyStaff(`Paid but cancelled: ${item.ref}`, {
            title: type === 'join' ? 'Paid for a cancelled sign-up' : 'Paid for a cancelled booking',
            intro: `${item.name} paid for ${item.ref}, but it was cancelled or its place was taken. Refund the order or find them another spot.`,
            details: [['Code', item.ref], ['Name', item.name], ['Email', item.email || 'none'], ['Was for', `${item.title ? `${item.title}, ` : ''}${this.when(item, rules)}`], ['Order', orderId]],
          });
        }
      }
      // Paid more than was owed: already paid in full, or this order paid more than was left.
      const over = (item.amount || 0) > 0 ? Math.max(0, added - owedBefore) : 0;
      if (over > 0) {
        const twice = owedBefore === 0;
        notes.push(twice ? `[Paid twice: ${item.orderId || 'an earlier order'} and ${orderId}. Refund one.]` : `[Overpaid ${dollars(over)} by ${orderId}: refund the difference.]`);
        this.notifyStaff(`${twice ? 'Paid twice' : 'Overpaid'}: ${item.ref}`, {
          title: twice ? `A ${type === 'join' ? 'sign-up' : 'booking'} was paid twice` : `A ${type === 'join' ? 'sign-up' : 'booking'} was overpaid`,
          intro: twice
            ? `${item.name}'s ${item.ref} was already paid, and another order paid for it again. Refund one of them.`
            : `${item.name}'s ${item.ref} was paid ${dollars(over)} more than was left to pay. Refund the difference.`,
          details: [['Code', item.ref], ['First order', item.orderId || ''], ['This order', orderId], ['Amount', dollars(item.amount || 0)], ['Paid so far', dollars(next.paidAmount)]],
        });
      }
      if (type === 'join') {
        this.write(
          'UPDATE event_joins SET paid = ?, paid_amount = ?, order_id = ?, status = ?, hold_until = NULL, updated_at = ? WHERE id = ?',
          next.paid ? 1 : 0, next.paidAmount, next.orderId, next.status, now, item.id,
        );
      } else {
        const text = notes.filter((n) => !(item.notes || '').includes(n)).join(' ');
        this.write(
          'UPDATE bookings SET paid = ?, paid_amount = ?, order_id = ?, status = ?, hold_until = NULL, notes = ?, updated_at = ? WHERE id = ?',
          next.paid ? 1 : 0, next.paidAmount, next.orderId, next.status, text ? `${item.notes ? `${item.notes} ` : ''}${text}` : item.notes || null, now, item.id,
        );
      }
      // Paying online confirms a held booking or sign-up: that's when its confirmation goes out. The counter needs none.
      if (firstTime && !pos && next.status === 'confirmed') {
        if (type === 'join') this.confirmJoin(this.joinById(item.id), rules);
        else this.confirm(this.booking(item.id), rules, item.gameId ? this.game(item.gameId) : null);
      }
    }
    return updated;
  }

  /**
   * A booking or sign-up whose hold ran out, paid after all: is its place still free? A game seat needs seats nobody
   * has taken and nobody is holding: seats kept for weekly regulars aren't free (the payer's own hold aside). No awaits.
   */
  placeStillFree(type, item, rules) {
    if (type === 'join') {
      const occurrence = findOccurrence(rules, item.occurrenceId);
      const others = this.sql.exec("SELECT COALESCE(SUM(people), 0) AS n FROM event_joins WHERE occurrence_id = ? AND status != 'cancelled' AND id != ?", item.occurrenceId, item.id).one().n;
      return Boolean(occurrence?.capacity && others + item.people <= occurrence.capacity);
    }
    const game = item.gameId ? this.game(item.gameId) : null;
    if (game && game.status === 'cancelled') return false;
    const st = this.state(item.start - 1, item.end + 1);
    const free = item.kind === 'gm-seat' || item.tables.every((t) => isFree(st, rules, t, item.start, item.end, item.id));
    const held = game ? this.regularsWaiting(game, { except: item.customerId }) : 0;
    const seatsOk = item.kind !== 'gm-seat' || (game && seatsTaken(st, game.id) + held + item.people <= game.seats);
    return Boolean(free && seatsOk);
  }

  /** What's been paid for a booking or sign-up through the shop so far, from its recorded payments */
  paidSoFar(kind, id) {
    return this.sql.exec('SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE kind = ? AND booking_id = ?', kind, id).one().n;
  }

  /** A payment as staff and the POS see it: { amount, customerId, name, at } (name: the payer, when they're a member) */
  paymentView(r) {
    return { amount: r.amount, customerId: r.customer_id || null, name: r.payer || null, at: r.at };
  }

  /** One booking's or sign-up's payments, oldest first */
  paymentsOf(kind, id) {
    return this.sql
      .exec(
        `SELECT p.*, COALESCE(m.name, m.first_name) AS payer FROM payments p LEFT JOIN members m ON m.customer_id = p.customer_id
         WHERE p.kind = ? AND p.booking_id = ? ORDER BY p.at, p.rowid`,
        kind, id,
      )
      .toArray()
      .map((r) => this.paymentView(r));
  }

  /** The payments of every booking (kind 'booking') or sign-up ('join') in [from, to), by its id, for lists */
  paymentsIn(kind, from, to) {
    const table = kind === 'join' ? 'event_joins' : 'bookings';
    const byItem = new Map();
    const rows = this.sql
      .exec(
        `SELECT p.*, COALESCE(m.name, m.first_name) AS payer FROM payments p JOIN ${table} x ON x.id = p.booking_id
         LEFT JOIN members m ON m.customer_id = p.customer_id WHERE p.kind = ? AND x.ends_at > ? AND x.starts_at < ? ORDER BY p.at, p.rowid`,
        kind, from, to,
      )
      .toArray();
    for (const r of rows) {
      if (!byItem.has(r.booking_id)) byItem.set(r.booking_id, []);
      byItem.get(r.booking_id).push(this.paymentView(r));
    }
    return byItem;
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
    this.requireStaff(who, 'tables');
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
    this.requireStaff(who, 'tables');
    this.write('DELETE FROM openings WHERE id = ?', id);
    return { ok: true };
  }

  /* ---------------- check-in at the counter ---------------- */
  /**
   * POST /checkin (staff). { code } is whatever the scanner typed: SJ-OWLBEAR-17 however it's typed, or the first
   * release's GOB-7K2QXM. A booking's, seat's or sign-up's code checks it in; a member code lists that member's day
   * (nothing is checked in until staff pick a row), and a pass code shows the pass. { id, type } checks in one row,
   * from a member's list, or again to apply a pass after all. pass: a pass code, 'none', or left out for the
   * booking's saved pass. force: check in a cancelled booking or one for another day. Returns { row, pass, notice,
   * customer, due } and the round 3 fields (found, kind, booking or join, game, checkedIn, reason, message).
   */
  async checkIn(input, who) {
    this.requireStaff(who, 'checkin');
    const rules = await this.rules();
    // --- no awaits from here on ---
    // A member code on the staff page also lists what they owe from earlier sessions (owed rows), for Waive and Mark paid,
    // and (round 8) today's sign-ups someone else put them on as a guest.
    return this.ticketCheckIn(input, rules, Date.now(), who.customerId ? `staff:${who.customerId}` : 'staff', { owed: true, guests: true });
  }

  /**
   * The check-in itself, shared by the staff page and the POS. by: who did it, kept with any pass use. owed: a member
   * code also lists their owed rows (the staff page asks for them; the POS's round 3 member-code lines don't). guests
   * (round 8, the staff page): and the sign-ups today they're a guest on. No awaits.
   */
  ticketCheckIn(input, rules, now, by = null, { owed = false, guests = false } = {}) {
    const options = { force: input.force === true, pass: input.pass, by };
    if (input.id != null && input.id !== '') {
      const id = String(input.id);
      const booking = input.type === 'join' ? null : this.booking(id);
      const join = booking ? null : this.joinById(id);
      if (booking) return this.checkInBooking(booking, rules, now, options);
      if (join) return this.checkInJoin(join, rules, now, options);
      throw new RuleError('That booking could not be found. Refresh the list and try again.', 404);
    }
    const found = this.findCode(input.code);
    if (!found) throw new RuleError('No booking, member or pass with that code.', 404);
    if (found.type === 'member') return this.memberCard(found.item.customer_id, rules, now, { owed, guests });
    if (found.type === 'pass') {
      const pass = this.passView(found.item, { now });
      return {
        found: true, kind: 'pass', type: 'pass', checkedIn: false, row: null, pass, notice: null, due: 0,
        customer: found.item.customerId ? { id: found.item.customerId } : null,
        message: `${pass.label}: ${plural(pass.sessionsLeft, 'session', 'sessions')} left of ${pass.sessionsTotal}.`,
      };
    }
    if (found.type === 'booking') return this.checkInBooking(found.item, rules, now, options);
    return this.checkInJoin(found.item, rules, now, options);
  }

  clock(ms, rules) {
    return new Intl.DateTimeFormat('en-NZ', { timeZone: rules.tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
  }

  /** The end of a check-in message: what to charge, that a pass covers it, or that it's paid */
  payWords(item) {
    const due = dueOf(item);
    if (due) return ` Charge ${dollars(due)}.`;
    if (item.waived && !(item.paidAmount > 0)) return ' Waived: nothing to pay.';
    const amount = item.amount || 0;
    // paid is set once nothing is left, but when a pass covered the lot no money changed hands
    if (amount > 0 && !(item.paidAmount > 0) && (item.covered || 0) >= amount) return ' Their pass covers it.';
    if (item.paid && amount > 0) return item.pay === 'now' ? ' Paid online.' : ' Paid.';
    return '';
  }

  /**
   * Whether a booking or sign-up can check in now: any time on its own Lair day (the POS Today list shows the whole
   * day, and people turn up early), or from 3 hours before it starts until it ends, so a session running past
   * midnight still counts. Anything else is "not today" unless staff force it.
   */
  onTheDay(item, rules, now) {
    const time = new LairTime(rules.tz);
    return time.key(item.start) === time.key(now) || (now >= item.start - 3 * HOUR && now <= item.end);
  }

  /**
   * Check in a booking or game seat: it's seated and arrived, and a pass is used (usePassAtCheckIn). Someone already
   * in stays in, and a pass can still be applied. A cancelled booking, a no-show or another day's booking comes back
   * unchecked with a reason unless force is set. No awaits.
   */
  checkInBooking(booking, rules, now, { force = false, pass: choice, by = null, sameDay = false } = {}) {
    const time = new LairTime(rules.tz);
    const game = booking.gameId ? this.game(booking.gameId) : null;
    const base = {
      found: true, kind: 'booking', type: 'booking', game: game ? this.gameView(game, this.state(game.start - 1, game.end + 1), rules) : null,
      customer: booking.customerId ? { id: booking.customerId } : null,
    };
    const result = (item, extra) => {
      const row = this.bookingRow(item, rules);
      return { ...base, booking: { ...this.staffBooking(item), players: item.party }, row, due: row.due, ...extra };
    };
    const who = (item) => `${item.name}${item.people ? `, ${plural(item.people, 'person', 'people')}` : ''}${item.tables.length ? ` at ${item.tables.join(', ')}` : ''}`;
    if (['cancelled', 'noshow'].includes(booking.status) && !force) {
      const message = `This booking was ${booking.status === 'noshow' ? 'marked as a no-show' : 'cancelled'}: ${who(booking)}.`;
      return result(booking, { checkedIn: false, reason: 'cancelled', message, notice: message, pass: null });
    }
    const already = !force && (booking.status === 'seated' || booking.status === 'done' || Boolean(booking.arrivedAt));
    if (!already && !force && !sameDay && !this.onTheDay(booking, rules, now)) {
      const message = `This booking is for ${time.label(booking.start)}, not today: ${who(booking)}.`;
      return result(booking, { checkedIn: false, reason: 'not-today', message, notice: message, pass: null });
    }
    if (!already) {
      booking.status = 'seated';
      booking.arrivedAt = now;
      booking.holdUntil = null;
      this.saveBooking(booking, now);
    }
    const used = this.usePassAtCheckIn(this.booking(booking.id), choice, rules, now, by);
    const fresh = this.booking(booking.id);
    const message = already
      ? `Already checked in${fresh.arrivedAt ? ` at ${this.clock(fresh.arrivedAt, rules)}` : ''}: ${who(fresh)}.${this.payWords(fresh)}`
      : `Checked in: ${who(fresh)}.${this.payWords(fresh)}`;
    return result(fresh, { checkedIn: true, already, ...(already ? { reason: 'already' } : {}), message, notice: used.notice, pass: used.pass });
  }

  /** Check in an event sign-up. Passes never cover event entry. Like checkInBooking. No awaits. */
  checkInJoin(join, rules, now, { force = false, pass: choice, sameDay = false } = {}) {
    const time = new LairTime(rules.tz);
    const base = { found: true, kind: 'join', type: 'join', customer: join.customerId ? { id: join.customerId } : null, pass: null };
    const result = (item, extra) => {
      const row = this.joinRow(item);
      return { ...base, join: this.staffJoinView(item), row, due: row.due, ...extra };
    };
    const label = (item) => `${item.name}, ${plural(item.people, 'person', 'people')} for ${item.title || 'the event'}`;
    if (join.status === 'cancelled' && !force) {
      const message = `This sign-up was cancelled: ${label(join)}.`;
      return result(join, { checkedIn: false, reason: 'cancelled', message, notice: message });
    }
    const already = !force && Boolean(join.arrivedAt);
    if (!already && !force && !sameDay && !this.onTheDay(join, rules, now)) {
      const message = `This sign-up is for ${time.label(join.start)}, not today: ${label(join)}.`;
      return result(join, { checkedIn: false, reason: 'not-today', message, notice: message });
    }
    if (!already) this.write("UPDATE event_joins SET status = 'attended', arrived_at = ?, hold_until = NULL, updated_at = ? WHERE id = ?", now, now, join.id);
    const fresh = this.joinById(join.id);
    const notice = choice && choice !== 'none' ? "Passes don't cover event entry, so no pass was used." : null;
    const message = already ? `Already checked in: ${label(fresh)}.${this.payWords(fresh)}` : `Checked in: ${label(fresh)}.${this.payWords(fresh)}`;
    return result(fresh, { checkedIn: true, already, ...(already ? { reason: 'already' } : {}), message, notice });
  }

  /**
   * A booking as staff see it on the floor and at check-in: its saved pass, what passes covered, what's due, the refund,
   * what's been paid (paidAmount) and by whom (payments). memo and payments: see savedPass and paymentsIn.
   */
  staffBooking(b, memo = null, payments = null) {
    return {
      ...b, pass: this.savedPass(b, memo), covered: b.covered || 0, due: dueOf(b), refund: b.refund || null, paidAmount: b.paidAmount || 0,
      split: Boolean(b.split), payments: payments || this.paymentsOf('booking', b.id), owed: this.isOwed(b), waived: Boolean(b.waived),
    };
  }

  /** What a booking is, in a few words: the game, the event, or the tables */
  rowTitle(b, rules, game = null) {
    if (b.kind === 'gm-seat') return game?.title || 'GM game';
    if (b.kind === 'gm') return `Running ${game?.title || 'a game'}`;
    if (b.occurrenceId) return findOccurrence(rules, b.occurrenceId)?.title || 'Event game spot';
    return `${b.tables.length > 1 ? 'Tables' : 'Table'} ${b.tables.join(', ')}`;
  }

  /**
   * A row's title on the member's own bill (GET /me dueNow), as My Lair words it: a table booking or walk-in is "Table
   * T3" or "Tables T6 and T7", and an event game spot "Game table at Warhammer night", since the event's name alone
   * reads like the event's entry. A game seat is its game and a sign-up its event, as on the counter's rows. No awaits.
   */
  dueTitle(row, rules) {
    if (row.type !== 'booking' || row.kind === 'gm-seat' || row.kind === 'gm') return row.title;
    const event = row.occurrenceId ? findOccurrence(rules, row.occurrenceId)?.title : null;
    if (event) return `Game table at ${event}`;
    return this.tablesTitle(row.tables || []);
  }

  /** "Table T3", "Tables T6 and T7" or "Tables T8, T9 and T10" */
  tablesTitle(tables) {
    const names = tables.length < 2 ? tables.join('') : `${tables.slice(0, -1).join(', ')} and ${tables[tables.length - 1]}`;
    return `${tables.length > 1 ? 'Tables' : 'Table'} ${names}`;
  }

  /**
   * A booking or game seat as a check-in row (POST /checkin, the POS and its Today list): { id, type, ref, name, people,
   * tables, start, end, status, arrivedAt, paid, amount, covered, due, customerId, pass, refund, note } plus kind, title,
   * players, gameId, occurrenceId, seriesId (a weekly regular's seat), owed (a regular's seat that ended unpaid) and
   * waived (staff let them off). memo: see savedPass.
   */
  bookingRow(b, rules, { memo = null, game, payments = null, now = Date.now() } = {}) {
    const g = game !== undefined ? game : b.gameId ? this.game(b.gameId) : null;
    return {
      id: b.id, type: 'booking', kind: b.kind, ref: b.ref, name: b.name || '', people: b.people, tables: b.tables, start: b.start, end: b.end,
      status: b.status, arrivedAt: b.arrivedAt || null, paid: b.paid, amount: b.amount || 0, covered: b.covered || 0, due: dueOf(b),
      paidAmount: b.paidAmount || 0, payments: payments || this.paymentsOf('booking', b.id), split: Boolean(b.split),
      customerId: b.customerId || null, pass: this.savedPass(b, memo), refund: b.refund || null, note: b.notes || '',
      title: this.rowTitle(b, rules, g), players: b.party || [], gameId: b.gameId || null, occurrenceId: b.occurrenceId || null,
      seriesId: b.seriesId || null, owed: this.isOwed(b, now), waived: Boolean(b.waived),
    };
  }

  /**
   * An event sign-up as a check-in row. Its entry fee is never covered by a pass. payments: see bookingRow. Round 8: guests,
   * who's coming with them, as staff see them (staffGuest); guests: the sign-up's guest rows when a list has them (guestsIn).
   */
  joinRow(j, { payments = null, guests = null } = {}) {
    return {
      id: j.id, type: 'join', kind: 'join', ref: j.ref, name: j.name || '', people: j.people, tables: [], start: j.start, end: j.end,
      status: j.status, arrivedAt: j.arrivedAt || null, paid: j.paid, amount: j.amount || 0, covered: 0, due: dueOf(j),
      paidAmount: j.paidAmount || 0, payments: payments || this.paymentsOf('join', j.id), split: false,
      customerId: j.customerId || null, pass: null, refund: j.refund || null, note: j.note || '', title: j.title || 'Event', players: [],
      gameId: null, occurrenceId: j.occurrenceId, seriesId: null, owed: false, waived: false,
      guests: (guests || this.joinGuests(j.id)).map((g) => this.staffGuest(g)),
    };
  }

  /** The Lair day `now` falls in: its key and [midnight, next midnight) */
  dayWindow(rules, now) {
    const time = new LairTime(rules.tz);
    const day = time.key(now);
    return { day, from: time.at(day, 0), to: time.at(addDays(day, 1), 0) };
  }

  /**
   * A member's bookings, game seats and sign-ups today, cancelled ones left out: theirs by account, or by their email.
   * A GM's own table isn't one (the GM isn't a row). Returns { member, bookings, joins }.
   */
  memberToday(customerId, rules, now) {
    const { from, to } = this.dayWindow(rules, now);
    const member = this.memberRow(customerId);
    const email = member?.email || '';
    const bookings = this.sql
      .exec(
        `SELECT * FROM bookings WHERE (customer_id = ? OR (? != '' AND lower(email) = lower(?))) AND kind != 'gm' AND ends_at > ? AND starts_at < ?
           AND status != 'cancelled' ORDER BY starts_at`,
        String(customerId), email, email, from, to,
      )
      .toArray().map((r) => this.rowToBooking(r));
    const joins = this.sql
      .exec(
        `SELECT * FROM event_joins WHERE (customer_id = ? OR (? != '' AND lower(email) = lower(?))) AND ends_at > ? AND starts_at < ? AND status != 'cancelled'
         ORDER BY starts_at`,
        String(customerId), email, email, from, to,
      )
      .toArray().map((r) => this.rowToJoin(r));
    return { member, bookings, joins };
  }

  /**
   * A member at the counter or in My Lair: their rows today (memberToday, as check-in rows, sorted) and their owed seats
   * (owedRows, each with its cart line). A seat of today's that has already ended unpaid is owed, so it's there and not
   * in today. No awaits.
   */
  memberDay(customerId, rules, now) {
    const { member, bookings, joins } = this.memberToday(customerId, rules, now);
    const memo = new Map();
    const today = [...bookings.filter((b) => !this.isOwed(b, now)).map((b) => this.bookingRow(b, rules, { memo, now })), ...joins.map((j) => this.joinRow(j))]
      .sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
    return { member, bookings, joins, today, owed: this.owedRows(customerId, rules, now, memo) };
  }

  /**
   * A member code at the counter: that member's rows today (each with what's left to pay) and their active passes.
   * Nothing is checked in until staff pick a row. bookings is the round 3 list of the same day. owed (the staff page):
   * their owed rows come after today's, oldest first (owedRows, owed: true), the ones not already among today's. They
   * are never checked in, only paid or waived; due counts them, and the message says what they owe.
   */
  memberCard(customerId, rules, now, { owed: withOwed = false, guests: withGuests = false } = {}) {
    const { member, bookings, joins } = this.memberToday(customerId, rules, now);
    // Round 8 (the staff page): today's sign-ups someone else put them on, as rows with guestOf (who signed them up).
    // What's due on one is the signer's, so it isn't in their total; checking it in checks in everyone on it.
    const guestOf = withGuests ? this.guestSignUps(customerId, rules, now).filter((j) => !joins.some((x) => x.id === j.id)) : [];
    if (!member && !bookings.length && !joins.length && !guestOf.length) throw new RuleError('No booking, member or pass with that code.', 404);
    const memo = new Map();
    const rows = [...bookings.map((b) => this.bookingRow(b, rules, { memo })), ...joins.map((j) => this.joinRow(j))].sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
    const along = guestOf.map((j) => ({ ...this.joinRow(j), guestOf: { name: this.firstNameOf(j.name) } }));
    const today = new Set(rows.map((x) => x.id));
    // The staff page's rows, without the POS's cart line
    const owed = withOwed ? this.owedRows(customerId, rules, now, memo).filter((x) => !today.has(x.id)).map(({ line, ...x }) => x) : [];
    const name = member?.name || member?.first_name || bookings[0]?.name || joins[0]?.name || member?.code || 'This member';
    const due = [...rows, ...owed].reduce((sum, x) => sum + x.due, 0);
    const owedDue = owed.reduce((sum, x) => sum + x.due, 0);
    const here = (x) => Boolean(x.arrivedAt) || ['seated', 'done', 'attended'].includes(x.status);
    const list = rows.map((x) => `${x.ref}: ${x.title} at ${this.clock(x.start, rules)}${here(x) ? ', checked in' : ''}${x.due ? `, charge ${dollars(x.due)}` : ''}`).join('; ');
    let said = rows.length ? `${name} has ${plural(rows.length, 'booking', 'bookings')} today. ${list}.` : `${name} has nothing booked today.`;
    if (along.length) {
      if (!rows.length) said = `${name} has no booking of their own today.`;
      said += ` ${along.map((x) => `${x.guestOf.name} signed them up for ${x.title} at ${this.clock(x.start, rules)} (${x.ref}${here(x) ? ', checked in' : ''})`).join('; ')}.`;
    }
    return {
      found: true, kind: 'member', type: 'member', checkedIn: false, customer: { id: String(customerId) },
      member: { customerId: String(customerId), name, firstName: member?.first_name || '', email: member?.email || '', code: member?.code || null },
      rows: [...[...rows, ...along].sort((a, b) => a.start - b.start || a.name.localeCompare(b.name)), ...owed], passes: this.activePasses(customerId, now), due,
      bookings: rows.map((x) => ({
        kind: x.type, id: x.id, ref: x.ref, title: x.title, start: x.start, end: x.end, people: x.people, tables: x.tables, status: x.status,
        checkedIn: here(x), due: x.due, gameId: x.gameId, occurrenceId: x.occurrenceId,
      })),
      message: owed.length ? `${said} They owe ${money(owedDue)} from ${plural(owed.length, 'earlier session', 'earlier sessions')}.` : said,
      // Round 9: their billing; a monthly account's fees go on it (with what's owed, the limit and any warning)
      account: this.accountSummary(customerId, rules, now),
    };
  }

  /**
   * Round 8: today's sign-ups (not cancelled) a member is a guest on: someone else signed them up. One they signed up
   * themselves (their own account on it) isn't one. No awaits.
   */
  guestSignUps(customerId, rules, now) {
    const { from, to } = this.dayWindow(rules, now);
    return this.sql
      .exec(
        `SELECT j.* FROM event_join_guests x JOIN event_joins j ON j.id = x.join_id
         WHERE x.customer_id = ? AND j.ends_at > ? AND j.starts_at < ? AND j.status != 'cancelled' AND (j.customer_id IS NULL OR j.customer_id != x.customer_id)
         ORDER BY j.starts_at`,
        String(customerId), from, to,
      )
      .toArray()
      .map((r) => this.rowToJoin(r));
  }

  /** Round 8: the first name on a sign-up ("Sam" for Sam Jones): who signed a guest up, as their My Lair and staff say it */
  firstNameOf(name) {
    return String(name || '').trim().split(/\s+/)[0] || 'A friend';
  }

  /* ---------------- the POS at the counter ---------------- */
  // The POS extension's routes. The Worker checks its session token first, so these act for staff; `by` names the POS
  // user for pass uses.

  /**
   * GET /pos/today: everything booked today, grouped for the counter. { day, now, groups }; each group { key, kind,
   * title, start, end, tables, rows }:
   *   game    one per GM game session today ("Curse of Strahd · GM Ana"); its rows are the seats (the GM isn't one)
   *   event   one per event date today; its rows are sign-ups and the event's game-spot bookings
   *   tables  "Table bookings": every other table booking and walk-in today
   * Groups are in start order and rows in start, then name order. Cancelled rows are left out; no-shows stay.
   */
  async posToday() {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const { day, from, to } = this.dayWindow(rules, now);
    const st = this.state(from, to);
    const memo = new Map();
    const paid = { booking: this.paymentsIn('booking', from, to), join: this.paymentsIn('join', from, to) };
    const games = new Map(st.games.map((g) => [g.id, g]));
    const rowOf = (b) => this.bookingRow(b, rules, { memo, game: b.gameId ? games.get(b.gameId) ?? undefined : null, payments: paid.booking.get(b.id) || [] });
    const groups = new Map();
    const group = (key, make) => {
      if (!groups.has(key)) groups.set(key, { ...make(), rows: [] });
      return groups.get(key);
    };
    for (const g of st.games.filter((x) => x.status !== 'cancelled')) {
      group(`game:${g.id}`, () => ({ key: `game:${g.id}`, kind: 'game', title: `${g.title} · GM ${g.gm}`, start: g.start, end: g.end, tables: g.tables }));
    }
    for (const o of eventOccurrences(rules, from, to)) {
      const tables = [...new Set([...parseTableList(o.tables, rules.rooms), ...parseSpots(o.gameTables, rules.rooms).flat()])];
      group(`event:${o.id}`, () => ({ key: `event:${o.id}`, kind: 'event', title: o.title, start: o.start, end: o.end, tables }));
    }
    const live = st.bookings.filter((b) => b.status !== 'cancelled' && b.kind !== 'gm');
    for (const b of live) {
      if (b.kind === 'gm-seat' && b.gameId) {
        const g = games.get(b.gameId) || this.game(b.gameId);
        group(`game:${b.gameId}`, () => ({ key: `game:${b.gameId}`, kind: 'game', title: g ? `${g.title} · GM ${g.gm}` : 'GM game', start: b.start, end: b.end, tables: b.tables })).rows.push(rowOf(b));
      } else if (b.occurrenceId) {
        group(`event:${b.occurrenceId}`, () => ({ key: `event:${b.occurrenceId}`, kind: 'event', title: findOccurrence(rules, b.occurrenceId)?.title || 'Event', start: b.start, end: b.end, tables: b.tables })).rows.push(rowOf(b));
      } else {
        group('tables', () => ({ key: 'tables', kind: 'tables', title: 'Table bookings', start: b.start, end: b.end, tables: [] })).rows.push(rowOf(b));
      }
    }
    const joins = this.sql.exec("SELECT * FROM event_joins WHERE ends_at > ? AND starts_at < ? AND status != 'cancelled'", from, to).toArray().map((r) => this.rowToJoin(r));
    for (const j of joins) {
      group(`event:${j.occurrenceId}`, () => ({ key: `event:${j.occurrenceId}`, kind: 'event', title: j.title || 'Event', start: j.start, end: j.end, tables: [] }))
        .rows.push(this.joinRow(j, { payments: paid.join.get(j.id) || [] }));
    }
    const tables = groups.get('tables');
    if (tables) {
      tables.start = Math.min(...tables.rows.map((r) => r.start));
      tables.end = Math.max(...tables.rows.map((r) => r.end));
      tables.tables = [...new Set(tables.rows.flatMap((r) => r.tables))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    }
    const order = { game: 0, event: 1, tables: 2 };
    for (const g of groups.values()) g.rows.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
    return { day, now, groups: [...groups.values()].sort((a, b) => a.start - b.start || order[a.kind] - order[b.kind] || a.title.localeCompare(b.title)) };
  }

  /** The Today group a booking or sign-up belongs to: { key, kind, title, start } */
  groupOf(type, item, rules) {
    if (type === 'join' || item.occurrenceId) {
      const o = findOccurrence(rules, item.occurrenceId);
      return { key: `event:${item.occurrenceId}`, kind: 'event', title: o?.title || item.title || 'Event', start: o?.start ?? item.start };
    }
    if (item.gameId) {
      const g = this.game(item.gameId);
      return { key: `game:${item.gameId}`, kind: 'game', title: g ? `${g.title} · GM ${g.gm}` : 'GM game', start: g?.start ?? item.start };
    }
    const { from, to } = this.dayWindow(rules, item.start);
    const first = this.sql
      .exec("SELECT MIN(starts_at) AS start FROM bookings WHERE kind IN ('table', 'walkin') AND occurrence_id IS NULL AND status != 'cancelled' AND ends_at > ? AND starts_at < ?", from, to)
      .one().start;
    return { key: 'tables', kind: 'tables', title: 'Table bookings', start: first ?? item.start };
  }

  /**
   * POST /pos/scan { code }: what a code is, without checking anyone in. A booking or sign-up: { type, row, group }. A
   * member: { type: 'member', member: { customerId, name, code }, rows (theirs today, then their owed seats: owed: true,
   * each with its cart line), tab (today's), passes (active) }. A pass: { type: 'pass', pass }. The first release's
   * GOB- codes work too.
   */
  async posScan(input) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const found = this.findCode(input.code);
    if (!found) throw new RuleError('No booking, member or pass with that code.', 404);
    if (found.type === 'pass') return { type: 'pass', pass: this.passView(found.item, { now }) };
    if (found.type === 'member') {
      const customerId = found.item.customer_id;
      const { member, today, owed } = this.memberDay(customerId, rules, now);
      // loyalty (round 6): their card, for the counter to show (display only)
      const card = this.loyaltyOf(customerId, rules);
      return {
        type: 'member', member: { customerId, name: member?.name || member?.first_name || '', code: member?.code || null },
        // round 9: after their weekly seats, what a monthly account owes from earlier days (none for pay-each-visit members)
        rows: [...today, ...owed, ...this.accountOwedRows(customerId, rules, now)], tab: this.tabView(this.todayTabRow(customerId, rules, now)), passes: this.activePasses(customerId, now),
        // round 7: card is the number of the card they're on
        loyalty: { stamps: card.stamps, cardSize: card.cardSize, rollsAvailable: card.rolls.available, card: card.card },
        // round 9: their billing ({ billing: 'visit' }, or a monthly account's limit and what's owed)
        account: this.accountSummary(customerId, rules, now),
      };
    }
    const row = found.type === 'join' ? this.joinRow(found.item) : this.bookingRow(found.item, rules);
    return { type: found.type, row, group: this.groupOf(found.type, found.item, rules) };
  }

  /**
   * POST /pos/checkin { id, type, pass?, force? } (or { code }): check one person in, the same as /checkin, plus `lines`:
   * what's left to pay, ready to add to the POS cart as a custom sale carrying its code in _booking (paying the order
   * marks it paid), or none when nothing is due. customer: the account to attach to the cart, so the spend counts.
   * Checking in someone already here gives the same lines. A member code ({ code }, as in round 3) checks nothing in
   * and gives lines for everything still to pay today.
   */
  async posCheckIn(input, by = 'pos') {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const result = this.ticketCheckIn(input, rules, Date.now(), by);
    if (result.kind === 'pass') return { ...result, lines: [] };
    if (result.kind === 'member') return { ...result, lines: result.rows.filter((r) => r.due > 0 && r.status !== 'noshow').map((r) => this.posLine(r, rules)) };
    const { row } = result;
    return { ...result, lines: result.checkedIn && row.due > 0 ? [this.posLine(row, rules)] : [], customer: row.customerId ? { id: row.customerId } : null };
  }

  /**
   * POST /pos/checkin-member { customerId }: check in all of that member's rows today (their saved passes apply), with
   * lines for everything left to pay. Their owed seats (a weekly regular's unpaid sessions) come after today's rows, not
   * checked in, with a line each: "Owed: Curse of Strahd (Thu 1 Oct)". Returns { rows, lines, customer, notices }.
   */
  async posCheckInMember(input, by = 'pos') {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const customerId = trimmed(input.customerId, 40);
    const { member, bookings, joins } = customerId ? this.memberToday(customerId, rules, now) : {};
    // round 9: and what a monthly account owes from earlier days, as /pos/scan lists it
    const owed = customerId ? [...this.owedRows(customerId, rules, now), ...this.accountOwedRows(customerId, rules, now)] : [];
    if (!customerId || (!member && !bookings.length && !joins.length && !owed.length)) throw new RuleError('No member with that customer ID.', 404);
    const notices = [];
    const rows = [];
    const take = (result) => {
      rows.push(result.row);
      if (result.notice && result.checkedIn) notices.push(result.notice);
    };
    for (const b of bookings) {
      // An owed seat (it ended today, unpaid) is paid, not checked in: it's with the owed rows.
      if (this.isOwed(b, now)) continue;
      if (b.status === 'noshow') {
        notices.push(`${b.ref} was marked as a no-show, so it wasn't checked in.`);
        rows.push(this.bookingRow(b, rules, { now }));
      } else {
        take(this.checkInBooking(b, rules, now, { by, sameDay: true }));
      }
    }
    for (const j of joins) take(this.checkInJoin(j, rules, now, { sameDay: true }));
    rows.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
    const lines = [...rows.filter((r) => r.due > 0 && r.status !== 'noshow').map((r) => this.posLine(r, rules)), ...owed.map((r) => r.line)];
    return { rows: [...rows, ...owed], lines, customer: { id: customerId }, notices };
  }

  /**
   * One custom sale for the POS cart, from a row: what's left to pay for it. "Table fee: SJ-OWLBEAR-17 (T4, 3 people)",
   * "GM seat: Curse of Strahd (SJ-OWLBEAR-17)", "Game spot: Warhammer night (SJ-OWLBEAR-17)" or "Event entry: Pokémon
   * TCG league (SJ-OWLBEAR-17)", plus "(pass covered $20)" when a pass took some off. A weekly regular's owed seat is
   * "Owed: Curse of Strahd (Thu 1 Oct)".
   */
  posLine(row, rules = this.rulesCache) {
    let title;
    if (row.owed) title = `Owed: ${row.title} (${this.shortDay(row.start, rules)})`;
    else if (row.type === 'join') title = `Event entry: ${row.title} (${row.ref})`;
    else if (row.kind === 'gm-seat') title = `GM seat: ${row.title} (${row.ref})`;
    else if (row.occurrenceId) title = `Game spot: ${row.title} (${row.ref})`;
    else title = `Table fee: ${row.ref} (${row.tables.join(', ')}, ${plural(row.people, 'person', 'people')})`;
    if (row.covered > 0 && !row.owed) title += ` (pass covered ${money(row.covered)})`;
    return { title: title.slice(0, 120), price: (row.due / 100).toFixed(2), quantity: 1, taxable: true, properties: { _booking: row.ref } };
  }

  /** "Thu 1 Oct", in Lair time */
  shortDay(ms, rules = this.rulesCache) {
    return new Intl.DateTimeFormat('en-NZ', { timeZone: rules?.tz || 'Pacific/Auckland', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms)).replace(',', '');
  }

  /**
   * POST /pos/share { id, type, amount? }: one custom sale for part of a bill, so friends can each pay their share.
   * amount is in cents, capped at what's left; with none it's one person's share, ceil(amount ÷ people). The line
   * carries _booking and _share, so paying it adds to the booking's paidAmount. Returns { row, line }.
   */
  async posShare(input) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const id = String(input.id ?? '');
    const booking = id && input.type !== 'join' ? this.booking(id) : null;
    const join = !booking && id ? this.joinById(id) : null;
    const item = booking || join;
    if (!item) throw new RuleError('That booking could not be found. Refresh the list and try again.', 404);
    if (item.status === 'cancelled') throw new RuleError("That booking was cancelled, so there's nothing to pay.", 409);
    const due = dueOf(item);
    if (due <= 0) throw new RuleError('Nothing is left to pay on this one.', 409);
    let share;
    if (input.amount != null && input.amount !== '') {
      share = Math.round(Number(input.amount));
      if (!Number.isFinite(share) || share < 1) throw new RuleError('Enter an amount more than $0.');
    } else {
      share = Math.ceil((item.amount || 0) / Math.max(1, item.people || 1));
    }
    share = Math.min(share, due);
    const what = join ? 'Event entry' : item.kind === 'gm-seat' ? 'GM seat' : 'Table fee';
    return {
      row: join ? this.joinRow(item) : this.bookingRow(item, rules),
      line: {
        title: `${what} share: ${item.ref} (${money(share)} of ${money(due)} left)`, price: (share / 100).toFixed(2), quantity: 1, taxable: true,
        properties: { _booking: item.ref, _share: '1' },
      },
    };
  }

  /**
   * POST /pos/member { code }: the round 3 route, now /pos/scan for member codes only. Returns the scan plus round 3's
   * customerId, name, code and rolls.
   */
  async posMember(input) {
    const found = this.findCode(input.code);
    if (found?.type !== 'member') throw new RuleError("That isn't a member code. Members find theirs in My Lair on the website.", 404);
    const scan = await this.posScan(input);
    // --- no awaits from here on ---
    // rolls: round 3's field, now mirroring the loyalty rolls (the spend dice retired in round 6)
    return { ...scan, customerId: scan.member.customerId, name: scan.member.name, code: scan.member.code, rolls: this.legacyRolls(this.loyaltyOf(scan.member.customerId)) };
  }

  /* ---------------- events ---------------- */
  /**
   * POST /events/:occurrenceId/join { name, email, phone, note?, pay?, guests? | people }. Round 8: guests, the people
   * coming along ([{ code?, name? }], up to 5): a member code finds that member, a name is for someone without one, and
   * people is 1 + guests. Without guests it's people (1 to 6, friends unnamed), as before.
   */
  async joinEvent(occurrenceId, input, who, client = '') {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const occurrence = findOccurrence(rules, occurrenceId);
    if (!occurrence) throw new RuleError('That event date could not be found.', 404);
    if (!occurrence.capacity) throw new RuleError("No need to sign up for this one. Just turn up!", 422);
    if (occurrence.end <= now) throw new RuleError('That one has already finished.');
    const listed = Array.isArray(input.guests) ? guestList(input.guests) : null;
    const people = listed ? 1 + listed.length : Math.floor(Number(input.people));
    if (!(people >= 1 && people <= 6)) throw new RuleError('Sign up between 1 and 6 people.');
    const name = String(input.name || '').trim().slice(0, 80);
    const email = String(input.email || '').trim().slice(0, 120);
    if (!name) throw new RuleError('Add your name.');
    if (!isEmail(email)) throw new RuleError('Add an email so we can send your confirmation.');
    // Round 7: a mobile number on every sign-up
    const phone = checkMobile(input.phone);
    this.checkRate(who, client, now);
    // Round 8: after the rate limit, so trying member codes counts towards it
    const guests = listed ? this.findGuests(listed, who) : [];
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
    // Round 9: paid at the counter on a monthly account: not over its credit limit (paid online now, nothing goes on it)
    if (!payNow) this.checkAccountLimit(who.customerId, fee * people, rules, now, 'join');
    const joinId = makeId('ej');
    const join = {
      id: joinId, ref: this.newCode(name, 'join', joinId, now), occurrenceId, eventId: occurrence.eventId, title: occurrence.title, start: occurrence.start,
      end: occurrence.end, people, name, email, note: String(input.note || '').trim().slice(0, 300), status: payNow ? 'held' : 'confirmed',
      pay: payNow ? 'now' : 'day', paid: false, amount: fee * people, holdUntil: payNow ? now + HOLD_MINUTES * MIN : null,
    };
    this.write(
      `INSERT INTO event_joins (id, ref, occurrence_id, event_id, title, starts_at, ends_at, people, name, email, note, status, customer_id, pay, paid, amount,
         hold_until, created_at, updated_at, phone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      join.id, join.ref, occurrenceId, join.eventId, join.title, join.start, join.end, people, name, email, join.note, join.status, who.customerId || null,
      join.pay, join.amount, join.holdUntil, now, now, phone,
    );
    for (const g of guests) {
      this.write('INSERT INTO event_join_guests (id, join_id, customer_id, name, code, created_at) VALUES (?, ?, ?, ?, ?, ?)', makeId('eg'), join.id, g.customerId, g.name, g.code, now);
    }
    this.touchMember(who.customerId, { name, email, mobile: phone }, now);
    // --- saved: the spaces are ours ---
    return { ...(await this.payOrConfirmJoin(join, rules, plan)), spacesLeft: left - people };
  }

  /**
   * Round 8: who's coming with someone who signs up (guestList's entries, in order). A code finds that member, however
   * it's typed, and keeps their customer ID, the name the Lair has for them and their code; a name is just a name. The
   * 422s: a code nobody has, the person's own code (logged in) and the same member twice. No awaits.
   */
  findGuests(listed, who) {
    const seen = new Set();
    return listed.map((g) => {
      if (!g.key) return { customerId: null, name: g.name, code: null };
      const member = this.memberByCode(g.code);
      if (!member) throw new RuleError(GUEST_MESSAGES.unknown(g.code));
      if (who.customerId && String(member.customer_id) === String(who.customerId)) throw new RuleError(GUEST_MESSAGES.own);
      const name = trimmed(member.name || member.first_name || g.name, 80) || member.code;
      if (seen.has(String(member.customer_id))) throw new RuleError(GUEST_MESSAGES.twice(name));
      seen.add(String(member.customer_id));
      return { customerId: String(member.customer_id), name, code: member.code };
    });
  }

  /**
   * Round 8: the member a typed member code belongs to (any case, dashes optional, as check-in reads codes), or null. Only
   * a member's code now counts: one staff replaced finds nobody. No awaits.
   */
  memberByCode(text) {
    for (const key of codeKeys(text)) {
      const row = this.sql.exec("SELECT target_id FROM codes WHERE key = ? AND kind = 'member'", key).toArray()[0];
      const member = row ? this.memberRow(row.target_id) : null;
      if (member && codeKey(member.code) === key) return member;
    }
    return null;
  }

  /**
   * POST /events/:occurrenceId/joins (Events, round 9): staff add someone to an event date's sign-ups. Who: { code }
   * (their member code: found at once), { customerId, name?, email? } (picked from the search), or { name, email } for
   * someone without an account (an email a member has links them; otherwise they're invited, and the sign-up joins their
   * account when they log in with that email, like everything else staff add under it). people (1 to 6, 1 when left
   * out), phone? and note?. The same places and rules as a customer's sign-up, paid at the counter (no checkout, no
   * mobile needed). Someone already on that date's list is a 409. They get the usual "You're on the list" email; an
   * invitee's also says how their account picks it up. Returns { join (as staff see it), spacesLeft, emailed, invited }.
   */
  async staffJoin(occurrenceId, input, who) {
    this.requireStaff(who, 'events');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const occurrence = findOccurrence(rules, occurrenceId);
    if (!occurrence) throw new RuleError('That event date could not be found.', 404);
    if (!occurrence.capacity) throw new RuleError("This one doesn't take sign-ups: people just turn up.", 422);
    if (occurrence.end <= now) throw new RuleError('That one has already finished.');
    const people = input?.people == null || input.people === '' ? 1 : Math.floor(Number(input.people));
    if (!(people >= 1 && people <= 6)) throw new RuleError('Add between 1 and 6 people.');
    const typed = String(input?.code ?? '').trim();
    const byCode = typed ? this.memberByCode(typed) : null;
    if (typed && !byCode) throw new RuleError(TEAM_WORDS.noMember, 404);
    const picked = !byCode && String(input?.customerId ?? '').trim()
      ? this.pickedCustomer({ customerId: input.customerId, name: input.name, email: input.email })
      : null;
    let email = trimmed(input?.email, 120);
    if (email && !isEmail(email)) throw new RuleError("That email address doesn't look right.");
    const row = byCode || picked?.row || (!picked && email ? this.memberByEmail(email) : null);
    const customerId = row?.customer_id || picked?.customerId || null;
    const name = trimmed(row?.name || row?.first_name || picked?.name || input?.name, 80) || (row?.code ?? '');
    if (!name) throw new RuleError('Add their name.');
    if (!email) email = trimmed((isEmail(row?.email) ? row.email : '') || (isEmail(row?.account_email) ? row.account_email : '') || picked?.email || '', 120);
    if (!customerId && !isEmail(email)) throw new RuleError('Add their email, so they get the confirmation and an invite to make an account.');
    const already = customerId
      ? this.sql.exec("SELECT ref FROM event_joins WHERE occurrence_id = ? AND customer_id = ? AND status != 'cancelled'", occurrenceId, String(customerId)).toArray()[0]
      : this.sql.exec("SELECT ref FROM event_joins WHERE occurrence_id = ? AND customer_id IS NULL AND lower(email) = lower(?) AND status != 'cancelled'", occurrenceId, email).toArray()[0];
    if (already) throw new RuleError(`${name} is already on the list for this one (${already.ref}).`, 409);
    const taken = this.sql
      .exec("SELECT COALESCE(SUM(people), 0) AS n FROM event_joins WHERE occurrence_id = ? AND status != 'cancelled'", occurrenceId)
      .one().n;
    const left = occurrence.capacity - taken;
    if (people > left) throw new RuleError(left > 0 ? `Only ${left} ${left === 1 ? 'space' : 'spaces'} left.` : 'This one is full.', 409);
    const phone = trimmed(input?.phone, 40).replace(/\s+/g, ' ').slice(0, 20) || null;
    if (picked && !picked.row) this.makeMember(picked, now);
    const joinId = makeId('ej');
    const fee = occurrence.entryFee || 0;
    this.write(
      `INSERT INTO event_joins (id, ref, occurrence_id, event_id, title, starts_at, ends_at, people, name, email, note, status, customer_id, pay, paid, amount,
         hold_until, created_at, updated_at, phone, added_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, 'day', 0, ?, NULL, ?, ?, ?, ?)`,
      joinId, this.newCode(name, 'join', joinId, now), occurrenceId, occurrence.eventId, occurrence.title, occurrence.start, occurrence.end, people, name,
      email || null, trimmed(input?.note, 300), customerId ? String(customerId) : null, fee * people, now, now, phone,
      who.customerId ? `staff:${who.customerId}` : 'staff',
    );
    // --- saved: the spaces are theirs ---
    const join = this.joinById(joinId);
    const invited = !customerId;
    const emailed = this.confirmStaffJoin(join, rules, { invited });
    return { join: this.staffJoinView(join), spacesLeft: left - people, emailed, invited };
  }

  /**
   * Round 9: the confirmation for a sign-up staff added: the usual "You're on the list" (confirmJoin) for a member; for
   * someone invited by email, the same email with how their account picks it up. No awaits. Returns whether one went.
   */
  confirmStaffJoin(join, rules, { invited = false } = {}) {
    if (!invited) return this.confirmJoin(join, rules);
    if (!emailReady(this.env) || !isEmail(join.email)) return false;
    const fee = join.amount ? `${dollars(join.amount)}, pay at the counter` : '';
    this.later(this.mail(this.letter(join.email, `You're in: ${join.title}, ${this.when(join, rules)} (${join.ref})`, {
      title: "You're on the list!",
      intro: `Kia ora ${join.name}, the Dice Goblin team has signed you up for ${join.title} at the Dice Goblin Lair. Gobgob's saving your spot.`,
      details: [['Event', join.title], ['When', this.when(join, rules)], ['People', String(join.people)], ['Entry', fee], ['Your code', join.ref]],
      outro: [
        dueOf(join) > 0 ? COUNTER : SHOW_CODE,
        `Make your Dice Goblin account with this email (${join.email}), or log in with it if you have one: this sign-up shows up in My Lair, and so does anything else the team adds for you.`,
        "Can't make it? Reply to this email, so someone else can have your spot.",
      ],
      button: { label: 'Make your account', url: this.page('myLair') },
    })));
    return true;
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
        this.write('UPDATE event_joins SET draft_order_id = ?, checkout_url = ?, updated_at = ? WHERE id = ?', draftOrderId, checkoutUrl || null, Date.now(), join.id);
        const fresh = this.joinById(join.id);
        if (fresh.status === 'held') return { join: this.joinView(fresh), checkoutUrl, holdMinutes: HOLD_MINUTES };
        this.dropDraft(fresh);
        return { join: this.joinView(fresh), notice: 'This sign-up changed while we set up payment. Please call us.' };
      } catch (error) {
        console.error('Lair: checkout could not be created', error);
        if (required) {
          // --- only this sign-up's own row changes: it was never confirmed, so it goes ---
          this.write("DELETE FROM event_joins WHERE id = ? AND status = 'held' AND paid = 0", join.id);
          // Round 8: and the people coming with them go with it (only once it's gone)
          this.write('DELETE FROM event_join_guests WHERE join_id = ? AND NOT EXISTS (SELECT 1 FROM event_joins WHERE id = ?)', join.id, join.id);
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
    // Round 7: a mobile number on every game spot
    const phone = checkMobile(input.phone);
    this.checkRate(who, client, now);
    if (!who.staff) this.checkEmailLimit(email, now);
    const free = this.freeSpots(occurrence, rules, this.state(occurrence.start - 1, occurrence.end + 1));
    if (!free.length) throw new RuleError('All the game tables are taken for this one. Try another date.', 409);
    const { room } = oneRoom(free[0], rules);
    const unit = occurrence.entryFee || room.price;
    const plan = this.paymentPlan(unit > 0 ? occurrence.payment : 'store', input.pay);
    const { payNow } = plan;
    // Round 9: paid at the counter on a monthly account: not over its credit limit
    if (!payNow) this.checkAccountLimit(who.customerId, unit * people, rules, now, 'book');
    // usePass: a session pass covers a game spot's price a person at check-in, like a table.
    const pass = input.usePass ? this.passForBooking(input.usePass, who, now) : null;
    const spotId = makeId('bk');
    const booking = {
      id: spotId, ref: this.newCode(name, 'booking', spotId, now), kind: 'table', tables: free[0], room: room.id, start: occurrence.start, end: occurrence.end, people,
      name, email, phone, notes: trimmed(input.notes, 500), activity: 'wargame', extras: ['wargame'], amount: unit * people,
      occurrenceId: occurrence.id, pay: payNow ? 'now' : 'day', paid: false, status: payNow ? 'held' : 'confirmed',
      holdUntil: payNow ? now + HOLD_MINUTES * MIN : null, customerId: who.customerId || null, passId: pass?.id || null,
    };
    this.saveBooking(booking, now);
    this.touchMember(who.customerId, { name, email, mobile: phone }, now);
    // --- saved: the spot is ours ---
    const result = await this.payOrConfirm(booking, rules, { ...plan, title: `Game spot at ${occurrence.title} (${free[0].join(', ')})` });
    return { ...result, spotsLeft: free.length - 1 };
  }

  /** An event date's game spots that are free for its whole time (the event's own table hold doesn't count against them) */
  freeSpots(occurrence, rules, st) {
    const ignore = new Set([`ev-${occurrence.id}`]);
    return parseSpots(occurrence.gameTables, rules.rooms).filter((spot) => spot.every((t) => isFree(st, rules, t, occurrence.start, occurrence.end, ignore)));
  }

  /**
   * "You're on the list" email for an event sign-up ("You're locked in" once it's paid online). Round 8: with more than
   * one person, Coming says who (comingLine). Guests aren't emailed.
   */
  confirmJoin(join, rules) {
    if (!emailReady(this.env) || !isEmail(join.email)) return false;
    const online = Boolean(join.paid && join.pay === 'now');
    const fee = !join.amount ? '' : join.paid ? `${dollars(join.amount)}, paid${online ? ' online' : ''}. Thank you!` : `${dollars(join.amount)}, pay at the counter`;
    this.later(this.mail(this.letter(join.email, `You're in: ${join.title}, ${this.when(join, rules)} (${join.ref})`, {
      title: online ? "You're locked in!" : "You're on the list!",
      intro: `Kia ora ${join.name}, you're signed up for ${join.title} at the Dice Goblin Lair. Gobgob's saving your spot.`,
      details: [
        ['Event', join.title], ['When', this.when(join, rules)], ['People', String(join.people)], ['Coming', join.people > 1 ? this.comingLine(join) : ''],
        ['Entry', fee], ['Your code', join.ref],
      ],
      outro: [
        dueOf(join) > 0 ? COUNTER : SHOW_CODE,
        online ? LOCKED_IN_EMAIL : "Can't make it? Cancel in My Lair or reply to this email, so someone else can have your spot.",
      ],
      button: { label: 'See it in My Lair', url: this.page('myLair') },
    })));
    return true;
  }

  /**
   * Round 8: who's coming on a sign-up, in its email: "Sam Jones, Kiri Smith, a friend". Whoever signed up, each guest,
   * then anyone unnamed (an older page's friends): "a friend", or "2 friends". No awaits.
   */
  comingLine(join, guests = this.joinGuests(join.id)) {
    const unnamed = Math.max(0, (join.people || 1) - 1 - guests.length);
    const names = [join.name, ...guests.map((g) => g.name)];
    if (unnamed) names.push(unnamed === 1 ? 'a friend' : `${unnamed} friends`);
    return names.filter(Boolean).join(', ');
  }

  async cancelJoin(id, who) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const join = this.joinById(id);
    if (!join) throw new RuleError('Sign-up not found.', 404);
    const own = who.customerId && join.customerId === who.customerId;
    // Round 9: staff here means the desk or the Events tab
    const staffJoin = this.can(who, ['checkin', 'events']);
    // Round 8: someone else signed a guest up, so only that person (or the counter) changes it
    const guest = !staffJoin && !own && who.customerId && this.joinGuests(join.id).some((g) => String(g.customer_id || '') === String(who.customerId));
    if (guest) throw new RuleError(GUEST_MESSAGES.guestOnly, 403);
    if (who.staff && !staffJoin && !own) throw new RuleError(TEAM_WORDS.notYours, 403);
    if (!staffJoin && !own) throw new RuleError('Only staff can change that sign-up.', 403);
    if (join.status === 'cancelled') return { ok: true, join: this.joinView(join) };
    const paid = join.paidAmount > 0;
    let refund;
    let flag = join.refund;
    let notice = null;
    if (staffJoin) {
      // Staff cancelling (the event's off, or they've sorted it out with the person): what was paid comes back.
      refund = paid ? { due: true, amount: join.paidAmount, orderId: join.orderId || null, reason: 'cancelled by staff' } : { due: false, amount: 0, reason: 'nothing paid' };
      if (paid && flag !== 'done') flag = 'due';
    } else if (paid && join.pay === 'now') {
      // Paid online means locked in: the space is freed, and staff decide on a refund.
      refund = { due: false, ask: true, amount: join.paidAmount, orderId: join.orderId || null, reason: 'paid online, so staff decide' };
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

  /* ---------------- the events editor (round 7) ---------------- */
  // Events are the lair_event metaobjects: the Lair reads and writes them through the Admin API and copies nothing in.
  // Every change is checked against the sign-ups first (a date people signed up for can't move or go); Shopify's write
  // comes after that check, so a sign-up landing in between is the one case staff sort by hand.

  /** A Shopify call in the events editor failed: a missing permission is the 503 Mo fixes by approving it; anything else, try again */
  eventsFailed(error) {
    if (error instanceof RuleError) return error;
    const message = String(error?.message || error);
    this.note({ eventsError: { message: message.slice(0, 300), at: new Date().toISOString() } });
    return /access denied|access_denied|required access|not approved/i.test(message) ? new RuleError(EVENTS_DENIED, 503) : new RuleError(SHOPIFY_DOWN, 502);
  }

  /** After every write: the next request loads the events again (a failed load keeps the ones the Lair has), so sign-ups, game spots and table holds follow at once */
  dropEvents() {
    this.rulesLoadedAt = 0;
  }

  /** A metaobject's fields as { key: value } (null when empty), remembering any picture or product it names for later views */
  eventFieldMap(fields) {
    this.eventRefs = this.eventRefs || new Map();
    if (this.eventRefs.size > 2000) this.eventRefs.clear();
    const out = {};
    for (const f of fields || []) {
      out[f.key] = f.value == null || f.value === '' ? null : String(f.value);
      const ref = f.reference;
      if (ref?.__typename === 'MediaImage' && ref.id) this.eventRefs.set(ref.id, { url: ref.image?.url || null, alt: ref.alt ?? '' });
      if (ref?.__typename === 'Product' && ref.id) this.eventRefs.set(ref.id, { handle: ref.handle || null, title: ref.title || null });
    }
    return out;
  }

  /** An event's fields the way the Lair's rules hold events (as shopify.js loadLairData reads them), for its dates */
  eventRule(handle, f) {
    const start = Date.parse(f.starts_at || '');
    const fee = Math.round(Number(f.entry_fee || 0) * 100);
    return {
      id: handle, title: f.title || '', start, end: f.ends_at ? Date.parse(f.ends_at) : start + 3 * HOUR, tables: f.tables || '',
      repeat: f.repeat || '', repeatUntil: f.repeat_until || null, skipDates: this.eventSkipDates(f.skip_dates),
      capacity: f.capacity ? Number(f.capacity) : null, entryFee: Number.isFinite(fee) && fee > 0 ? fee : 0, gameTables: f.game_tables || '',
      payment: eventPayment(f.payment), lockTables: String(f.lock_tables || '').trim().toLowerCase() === 'true',
    };
  }

  eventSkipDates(value) {
    try {
      const list = JSON.parse(value || '[]');
      return Array.isArray(list) ? list.map((d) => String(d).slice(0, 10)) : [];
    } catch {
      return [];
    }
  }

  /** "Weekly · Thursdays 6pm", "Fortnightly · Thursdays 6:30pm", "Monthly · Third Saturday 11am" (the calendar's tag), or null for a one-off */
  repeatTag(ev, rules) {
    const repeat = String(ev.repeat || '').trim().toLowerCase();
    if (!EVENT_REPEATS.includes(repeat) || !Number.isFinite(ev.start)) return null;
    const weekday = new Intl.DateTimeFormat('en-NZ', { timeZone: rules.tz, weekday: 'long' }).format(new Date(ev.start));
    const clock = this.clockWord(ev.start, rules.tz);
    if (repeat === 'monthly') {
      const nth = ['First', 'Second', 'Third', 'Fourth', 'Fifth'][Math.ceil(Number(lairTime(rules.tz).key(ev.start).slice(8, 10)) / 7) - 1];
      return `Monthly · ${nth} ${weekday} ${clock}`;
    }
    return `${repeat === 'weekly' ? 'Weekly' : 'Fortnightly'} · ${weekday}s ${clock}`;
  }

  /**
   * An event's dates from now: upcoming (every date that hasn't ended, up to 400 days ahead), next (the first one's start)
   * and last (the last date to come: a one-off's own, a repeating event's last before Repeat until, null when it goes on)
   */
  eventDatesFrom(ev, rules, now) {
    if (!Number.isFinite(ev.start)) return { upcoming: [], next: null, last: null };
    const one = { tz: rules.tz, events: [ev] };
    const upcoming = eventOccurrences(one, now, now + EVENT_DAYS * 24 * HOUR);
    const next = upcoming[0]?.start ?? null;
    let last = null;
    if (!ev.repeat) last = next;
    else if (ev.repeatUntil) {
      const until = lairTime(rules.tz).at(addDays(ev.repeatUntil, 1), 0);
      const all = until > now ? eventOccurrences(one, now, until) : [];
      last = all.length ? all[all.length - 1].start : null;
    }
    return { upcoming, next, last };
  }

  /**
   * An event's upcoming dates with anyone on them, soonest first: [{ occurrenceId, start, people (sign-ups that aren't
   * cancelled), spots (game spots: active bookings) }]. No awaits.
   */
  eventBookings(handle, now) {
    // Its dates' ids are `<handle>@YYYY-MM-DD`: everything from "<handle>@" up to "<handle>A" ('A' follows '@'), on the index
    const [from, to] = [`${handle}@`, `${handle}A`];
    const byDate = new Map();
    const add = (r, key) => {
      const item = byDate.get(r.occurrence_id) || { occurrenceId: r.occurrence_id, start: r.start, people: 0, spots: 0 };
      item.start = Math.min(item.start, r.start);
      item[key] += r.n;
      byDate.set(r.occurrence_id, item);
    };
    for (const r of this.sql.exec(
      "SELECT occurrence_id, MIN(starts_at) AS start, COALESCE(SUM(people), 0) AS n FROM event_joins WHERE occurrence_id >= ? AND occurrence_id < ? AND status != 'cancelled' AND ends_at > ? GROUP BY occurrence_id",
      from, to, now,
    ).toArray()) add(r, 'people');
    for (const r of this.sql.exec(
      "SELECT occurrence_id, MIN(starts_at) AS start, COUNT(*) AS n FROM bookings WHERE occurrence_id >= ? AND occurrence_id < ? AND status IN ('held', 'confirmed', 'seated') AND ends_at > ? GROUP BY occurrence_id",
      from, to, now,
    ).toArray()) add(r, 'spots');
    return [...byDate.values()].filter((x) => x.people > 0 || x.spots > 0).sort((a, b) => a.start - b.start || a.occurrenceId.localeCompare(b.occurrenceId));
  }

  /** A picture's address at a width, the way the theme's image_url filter asks for one */
  withWidth(url, width) {
    return url ? `${url}${url.includes('?') ? '&' : '?'}width=${width}` : null;
  }

  /**
   * An event as the staff page's editor sees it (contract v7 section 10), with config: the event exactly as
   * lair-config.liquid writes it, for the staff page's store.cfg.events. booked: its dates with sign-ups (looked up when
   * not given). Returns { view, ev } (ev: the event as the Lair's rules hold it). No awaits.
   */
  eventEntry(node, rules, now, booked = null) {
    const f = this.eventFieldMap(node.fields);
    const ev = this.eventRule(node.handle, f);
    const dates = this.eventDatesFrom(ev, rules, now);
    const refs = this.eventRefs || new Map();
    const picture = f.image ? refs.get(f.image) || null : null;
    const ticket = f.product ? refs.get(f.product) || null : null;
    const fee = f.entry_fee != null ? Math.round(Number(f.entry_fee) * 100) : null;
    const productUrl = ticket?.handle ? `/products/${ticket.handle}` : null;
    const view = {
      id: node.id, handle: node.handle, title: f.title || '', type: f.event_type || 'other', game: f.game || '', start: Number.isFinite(ev.start) ? ev.start : null,
      end: f.ends_at ? Date.parse(f.ends_at) : null, repeat: ev.repeat, repeatUntil: ev.repeatUntil, skipDates: ev.skipDates, description: f.description || '',
      image: f.image ? { id: f.image, url: picture?.url || null, alt: picture ? picture.alt ?? '' : null } : null,
      capacity: ev.capacity, priceNote: f.price_note || '', entryFee: Number.isFinite(fee) ? fee : null, payment: ev.payment, tables: f.tables || '',
      gameTables: f.game_tables || '', lockTables: ev.lockTables, link: f.link || '',
      product: f.product ? { id: f.product, handle: ticket?.handle || null, title: ticket?.title || null } : null,
      repeatTag: this.repeatTag(ev, rules), next: dates.next, last: dates.last, booked: booked || this.eventBookings(node.handle, now),
      updatedAt: Date.parse(node.updatedAt || '') || null,
      config: {
        id: node.handle, title: f.title || '', type: f.event_type || 'other', game: f.game || '', start: f.starts_at, end: f.ends_at, repeat: ev.repeat,
        repeatUntil: ev.repeatUntil, skipDates: ev.skipDates, capacity: ev.capacity, tables: f.tables, entryFee: Number.isFinite(fee) ? fee : null,
        gameTables: f.game_tables, payment: ev.payment, lockTables: ev.lockTables, price: f.price_note, url: productUrl || f.link, link: f.link,
        product: productUrl ? { url: productUrl, title: ticket.title || '', price: null, available: null, stock: null } : null,
        blurb: f.description, image: this.withWidth(picture?.url || null, 800), imageAlt: picture?.alt || '',
      },
    };
    return { view, ev, upcoming: dates.upcoming };
  }

  /**
   * GET /events (staff): every lair_event entry, those with dates to come first (soonest next), then the rest (the most
   * recent first). Read with the pictures and products (read_files, read_products); if Shopify won't give those yet,
   * read again without them (ids only).
   */
  async listEvents(who) {
    this.requireStaff(who, 'events');
    const rules = await this.rules();
    if (!this.shopify.configured) throw new RuleError(SHOPIFY_DOWN, 503);
    let nodes;
    try {
      nodes = await this.shopify.lairEventsAdmin({ refs: true });
    } catch (error) {
      if (!/access denied|access_denied|required access/i.test(String(error?.message || error))) throw this.eventsFailed(error);
      try {
        nodes = await this.shopify.lairEventsAdmin({ refs: false });
      } catch (again) {
        throw this.eventsFailed(again);
      }
    }
    // --- no awaits from here on ---
    const now = Date.now();
    const entries = nodes.map((n) => this.eventEntry(n, rules, now));
    const latest = (x) => {
      if (!Number.isFinite(x.ev.start)) return 0;
      const past = eventOccurrences({ tz: rules.tz, events: [x.ev] }, x.ev.start - 1, now);
      return past.length ? past[past.length - 1].start : x.ev.start;
    };
    const coming = entries.filter((x) => x.view.next != null).sort((a, b) => a.view.next - b.view.next || a.view.title.localeCompare(b.view.title));
    const done = entries.filter((x) => x.view.next == null).map((x) => ({ x, at: latest(x) })).sort((a, b) => b.at - a.at || a.x.view.title.localeCompare(b.x.view.title)).map((y) => y.x);
    return { events: [...coming, ...done].map((x) => x.view) };
  }

  /** A real date, 'YYYY-MM-DD', or null */
  dayOf(value) {
    const text = String(value ?? '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const ms = Date.parse(`${text}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === text ? text : null;
  }

  /** A moment as the events keep it in Shopify: Lair wall-clock time with its offset, like 2026-10-08T18:00:00+13:00 */
  lairIso(ms, tz) {
    const time = lairTime(tz);
    const p = time.parts(ms);
    const offset = Math.round(time.offset(ms) / MIN);
    const pad = (n) => String(Math.abs(n)).padStart(2, '0');
    return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:00${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  }

  /** Whether "Tables reserved" reads as tables that exist: table codes and ranges (T20-T21), rooms by name, or all */
  tablesExist(spec, rooms) {
    const text = String(spec).trim();
    if (/^all$/i.test(text)) return true;
    const index = tableIndex(rooms);
    const parts = text.split(/[,;]+/).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return false;
    return parts.every((part) => {
      if (rooms.some((r) => r.id.toLowerCase() === part.toLowerCase() || r.name.toLowerCase() === part.toLowerCase())) return true;
      return part.split(/\s+/).every((token) => {
        const range = token.match(/^([A-Za-z]+)(\d+)-(?:([A-Za-z]+))?(\d+)$/);
        if (!range) return index.has(token.toUpperCase());
        if (range[3] && range[3].toUpperCase() !== range[1].toUpperCase()) return false;
        if (+range[2] > +range[4]) return false;
        for (let i = +range[2]; i <= +range[4]; i += 1) if (!index.has(`${range[1].toUpperCase()}${i}`)) return false;
        return true;
      });
    });
  }

  /** Whether "Game tables" reads as spots of tables that exist, each spot in one room: T14+T15, T16+T17 */
  spotsExist(spec, rooms) {
    const index = tableIndex(rooms);
    const parts = String(spec).split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return false;
    return parts.every((part) => {
      const tables = part.split('+').map((t) => t.trim().toUpperCase());
      return tables.every((t) => index.has(t)) && tables.every((t) => index.get(t).roomObj.id === index.get(tables[0]).roomObj.id);
    });
  }

  /**
   * The editor's fields, checked (contract v7 section 10), as the lair_event fields to write: { set: { key: value } }
   * with only what was sent ('' clears an optional field), and merged: the entry after the change. current: the entry's
   * fields now ({} for a new one). A one-off keeps no Repeat until or skip dates. No awaits.
   */
  eventFields(input, rules, current = {}) {
    const creating = !Object.keys(current).length;
    const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
    const empty = (k) => input[k] == null || String(input[k]).trim() === '';
    const set = {};
    if (creating || has('title')) {
      const title = trimmed(input.title, 80);
      if (!title) throw new RuleError('Give the event a title.');
      set.title = title;
    }
    if (creating || has('type')) {
      if (!EVENT_TYPES.includes(input.type)) throw new RuleError('Pick what kind of event it is.');
      set.event_type = input.type;
    }
    if (has('game')) {
      const game = String(input.game ?? '').trim();
      if (game.length > 40) throw new RuleError("The game's name is 40 characters at most.");
      set.game = game;
    }
    if (creating || has('start')) {
      const start = Number(input.start);
      if (empty('start') || !Number.isFinite(start)) throw new RuleError('Pick when it starts.');
      set.starts_at = this.lairIso(start, rules.tz);
    }
    if (has('end')) {
      const end = Number(input.end);
      if (!empty('end') && !Number.isFinite(end)) throw new RuleError('It has to finish after it starts.');
      set.ends_at = empty('end') ? '' : this.lairIso(end, rules.tz);
    }
    if (has('repeat')) {
      const repeat = empty('repeat') ? '' : String(input.repeat).trim().toLowerCase();
      if (repeat && !EVENT_REPEATS.includes(repeat)) throw new RuleError('Pick how often it repeats: weekly, fortnightly or monthly. Or leave it as a one-off.');
      set.repeat = repeat;
    }
    if (has('repeatUntil')) {
      const day = empty('repeatUntil') ? '' : this.dayOf(input.repeatUntil);
      if (day === null) throw new RuleError("'Repeat until' has to be on or after the first date.");
      set.repeat_until = day;
    }
    if (has('skipDates')) {
      const raw = Array.isArray(input.skipDates) ? input.skipDates : String(input.skipDates ?? '').split(/[\s,;]+/);
      const days = raw.map((d) => String(d ?? '').trim()).filter(Boolean).map((d) => this.dayOf(d));
      if (days.some((d) => d === null) || days.length > 52) throw new RuleError('Skip dates have to be real dates, on or after the first date.');
      set.skip_dates = days.length ? JSON.stringify([...new Set(days)].sort()) : '';
    }
    if (has('description')) set.description = String(input.description ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 2000);
    if (has('imageId')) {
      const id = String(input.imageId ?? '').trim();
      const digits = id.match(/^(?:gid:\/\/shopify\/MediaImage\/)?(\d{1,20})$/);
      if (id && !digits) throw new RuleError('Pick a JPEG, PNG or WebP picture.');
      set.image = id ? `gid://shopify/MediaImage/${digits[1]}` : '';
    }
    if (has('capacity')) {
      const capacity = Number(input.capacity);
      if (!empty('capacity') && !(Number.isInteger(capacity) && capacity >= 1 && capacity <= 500)) throw new RuleError('Capacity is a number of people, from 1 to 500.');
      set.capacity = empty('capacity') ? '' : String(capacity);
    }
    if (has('priceNote')) {
      const note = String(input.priceNote ?? '').trim();
      if (note.length > 60) throw new RuleError('Keep the price note short: 60 characters at most.');
      set.price_note = note;
    }
    if (has('entryFee')) {
      const fee = Number(input.entryFee);
      if (!empty('entryFee') && !(Number.isFinite(fee) && fee >= 0 && fee <= 1000)) throw new RuleError('The entry fee is in dollars, from $0 to $1000.');
      set.entry_fee = empty('entryFee') ? '' : (Math.round(fee * 100) / 100).toFixed(2);
    }
    if (has('payment')) {
      if (!empty('payment') && !EVENT_PAYMENT_WORDS[input.payment]) throw new RuleError('Pick how people pay: in store, online, or either.');
      set.payment = empty('payment') ? '' : EVENT_PAYMENT_WORDS[input.payment];
    }
    if (has('tables')) {
      const tables = String(input.tables ?? '').trim();
      if (tables && !this.tablesExist(tables, rules.rooms)) throw new RuleError("Some of those tables don't exist. Use table codes like T20-T21, a room's name, or all.");
      set.tables = tables;
    }
    if (has('gameTables')) {
      const spots = String(input.gameTables ?? '').trim();
      if (spots && !this.spotsExist(spots, rules.rooms)) throw new RuleError('Game tables are pairs like T14+T15, T16+T17, with tables that exist.');
      set.game_tables = spots;
    }
    if (has('lockTables')) set.lock_tables = input.lockTables === true || input.lockTables === 'true' ? 'true' : 'false';
    if (has('link')) {
      const link = String(input.link ?? '').trim();
      let ok = !link;
      if (link && /^https?:\/\//i.test(link) && link.length <= 300) {
        try {
          ok = Boolean(new URL(link).hostname);
        } catch {
          ok = false;
        }
      }
      if (!ok) throw new RuleError('Links start with https://.');
      set.link = link;
    }
    if (has('productId')) {
      const id = String(input.productId ?? '').trim();
      const digits = id.match(/^(?:gid:\/\/shopify\/Product\/)?(\d{1,20})$/);
      if (id && !digits) throw new RuleError("That ticket product doesn't look right. Pick it again.");
      set.product = id ? `gid://shopify/Product/${digits[1]}` : '';
    }
    // The entry after the change, checked as a whole: the end after the start (24 hours at most), and Repeat until and the
    // skip dates on or after the first date. A one-off keeps neither (a skip date would hide its only date).
    const merged = { ...current };
    for (const [key, value] of Object.entries(set)) merged[key] = value === '' ? null : value;
    const start = Date.parse(merged.starts_at || '');
    const first = Number.isFinite(start) ? lairTime(rules.tz).key(start) : null;
    if ((set.starts_at || set.ends_at) && merged.ends_at) {
      const end = Date.parse(merged.ends_at);
      if (!(end > start)) throw new RuleError('It has to finish after it starts.');
      if (end - start > 24 * HOUR) throw new RuleError('Keep an event to 24 hours or less. Use Repeats for more dates.');
    }
    if (!merged.repeat) {
      for (const key of ['repeat_until', 'skip_dates']) {
        if (merged[key] != null) {
          set[key] = '';
          merged[key] = null;
        }
      }
    } else {
      if ((set.repeat_until || set.starts_at || 'repeat' in set) && merged.repeat_until && first && merged.repeat_until < first) {
        throw new RuleError("'Repeat until' has to be on or after the first date.");
      }
      if ((set.skip_dates || set.starts_at || 'repeat' in set) && first && this.eventSkipDates(merged.skip_dates).some((d) => d < first)) {
        throw new RuleError('Skip dates have to be real dates, on or after the first date.');
      }
    }
    // Only what changes goes to Shopify
    for (const [key, value] of Object.entries(set)) {
      const now = current[key] ?? '';
      const same = ['starts_at', 'ends_at'].includes(key) ? now && value && Date.parse(now) === Date.parse(value)
        : key === 'entry_fee' ? now !== '' && value !== '' && Number(now) === Number(value)
          : key === 'skip_dates' ? JSON.stringify(this.eventSkipDates(now)) === JSON.stringify(this.eventSkipDates(value))
            : String(now) === String(value);
      if (same || (!creating ? false : value === '')) delete set[key];
    }
    return { set, merged };
  }

  /** Lower case, letters, numbers and dashes from the title, up to 50 characters (with room for a -2) */
  eventHandleBase(title, room = 0) {
    const slug = String(title || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return (slug || 'event').slice(0, 50 - room).replace(/-+$/, '') || 'event';
  }

  /** A handle nobody has: the title's, then -2, -3… (joins and pictures are routes, never handles) */
  async freeEventHandle(title) {
    for (let n = 1; n <= 20; n += 1) {
      const suffix = n === 1 ? '' : `-${n}`;
      const handle = `${this.eventHandleBase(title, suffix.length)}${suffix}`;
      if (['joins', 'pictures'].includes(handle)) continue;
      if (!(await this.shopify.lairEventByHandle(handle))) return handle;
    }
    return `${this.eventHandleBase(title, 7)}-${makeId('x').slice(2, 8)}`;
  }

  /**
   * Save an event in Shopify, once more after a second if Shopify says its picture isn't ready yet (a file still being
   * processed). Returns { metaobject, userErrors }.
   */
  async writeEvent(write, picture) {
    let result = await write();
    const notReady = (e) => /image|file|media/i.test(`${(e.field || []).join(' ')} ${e.message || ''}`);
    if (picture && result.userErrors?.some(notReady)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      result = await write();
    }
    return result;
  }

  /** Shopify's userErrors, as the editor shows them */
  shopifySaidNo(userErrors) {
    return new RuleError(`Shopify said no: ${userErrors.map((e) => e.message).filter(Boolean).join('; ') || 'it would not save that'}`, 422);
  }

  /** POST /events { …fields } (staff): a new event. Its handle comes from the title and never changes. Returns { event, notice }. */
  async createEvent(input, who) {
    this.requireStaff(who, 'events');
    const rules = await this.rules();
    if (!this.shopify.configured) throw new RuleError(SHOPIFY_DOWN, 503);
    const { set } = this.eventFields(input || {}, rules);
    let result;
    try {
      const handle = await this.freeEventHandle(set.title);
      // A new handle has no sign-ups, so there's nothing to check before Shopify saves it
      result = await this.writeEvent(() => this.shopify.createLairEvent(handle, Object.entries(set).map(([key, value]) => ({ key, value }))), Boolean(set.image));
    } catch (error) {
      throw this.eventsFailed(error);
    }
    if (result.userErrors?.length || !result.metaobject) throw this.shopifySaidNo(result.userErrors || []);
    // --- no awaits from here on ---
    this.dropEvents();
    return { event: this.eventEntry(result.metaobject, rules, Date.now()).view, notice: null };
  }

  /**
   * POST /events/:handle/update { …the fields that change } (staff). A date people have signed up for (sign-ups or game
   * spots) can't move or go: 409, and nothing changes. A lower capacity is fine (notice: nobody's cancelled). Returns
   * { event, notice }.
   */
  async updateEvent(handle, input, who) {
    this.requireStaff(who, 'events');
    const rules = await this.rules();
    if (!this.shopify.configured) throw new RuleError(SHOPIFY_DOWN, 503);
    let node;
    try {
      node = await this.shopify.lairEventByHandle(String(handle || '').slice(0, 120));
    } catch (error) {
      throw this.eventsFailed(error);
    }
    if (!node) throw new RuleError('That event could not be found.', 404);
    // --- no awaits until Shopify saves it: the sign-up check ---
    const now = Date.now();
    const current = this.eventFieldMap(node.fields);
    const { set, merged } = this.eventFields(input || {}, rules, current);
    const booked = this.eventBookings(node.handle, now);
    const before = this.eventDatesFrom(this.eventRule(node.handle, current), rules, now).upcoming;
    const after = new Map(this.eventDatesFrom(this.eventRule(node.handle, merged), rules, now).upcoming.map((o) => [o.id, o]));
    const was = new Map(before.map((o) => [o.id, o]));
    for (const b of booked) {
      const old = was.get(b.occurrenceId);
      if (!old) continue;
      const next = after.get(b.occurrenceId);
      if (!next || next.start !== old.start || next.end !== old.end) {
        throw new RuleError(`People have signed up for ${this.shortDay(old.start, rules)}, so that date can't move or go. Cancel their sign-ups on the staff page first, or make the change from a date nobody's signed up for.`, 409);
      }
    }
    const capacity = merged.capacity ? Number(merged.capacity) : null;
    const over = 'capacity' in set && capacity ? booked.find((b) => after.has(b.occurrenceId) && b.people > capacity) : null;
    const notice = over ? `${this.shortDay(over.start, rules)} already has ${plural(over.people, 'person', 'people')}, more than the new capacity. Nobody's been cancelled.` : null;
    const fields = Object.entries(set).map(([key, value]) => ({ key, value }));
    if (!fields.length) return { event: this.eventEntry(node, rules, now, booked).view, notice };
    let result;
    try {
      result = await this.writeEvent(() => this.shopify.updateLairEvent(node.id, fields), Boolean(set.image));
    } catch (error) {
      throw this.eventsFailed(error);
    }
    if (result.userErrors?.length || !result.metaobject) throw this.shopifySaidNo(result.userErrors || []);
    // --- no awaits from here on ---
    this.dropEvents();
    return { event: this.eventEntry(result.metaobject, rules, Date.now()).view, notice };
  }

  /** POST /events/:handle/delete (staff): not while any date to come has people on it (409). The picture stays in Shopify's Files. */
  async deleteEvent(handle, who) {
    this.requireStaff(who, 'events');
    const rules = await this.rules();
    if (!this.shopify.configured) throw new RuleError(SHOPIFY_DOWN, 503);
    let node;
    try {
      node = await this.shopify.lairEventByHandle(String(handle || '').slice(0, 120));
    } catch (error) {
      throw this.eventsFailed(error);
    }
    if (!node) throw new RuleError('That event could not be found.', 404);
    // --- no awaits until Shopify deletes it: the sign-up check ---
    const booked = this.eventBookings(node.handle, Date.now());
    if (booked.length) {
      throw new RuleError(`People have signed up for ${this.shortDay(booked[0].start, rules)}. Cancel their sign-ups first, or end the event after that date with Repeat until.`, 409);
    }
    let result;
    try {
      result = await this.shopify.deleteLairEvent(node.id);
    } catch (error) {
      throw this.eventsFailed(error);
    }
    if (result.userErrors?.length) throw this.shopifySaidNo(result.userErrors);
    // --- no awaits from here on ---
    this.dropEvents();
    return { ok: true, handle: node.handle };
  }

  /**
   * POST /events/pictures { dataUrl, alt? } (staff): a picture for an event, into Shopify's Files. The browser shrinks it
   * first (JPEG, PNG or WebP, 700 KB at most); the Worker sends it to Shopify's upload target itself. Returns { image:
   * { id, url, alt, status } }: id is the MediaImage to save as imageId; url can be null while Shopify processes it.
   */
  async eventPicture(input, who) {
    this.requireStaff(who, 'events');
    const match = String(input?.dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match) throw new RuleError('Pick a JPEG, PNG or WebP picture.');
    let raw;
    try {
      raw = atob(match[2].replace(/\s+/g, ''));
    } catch {
      throw new RuleError('Pick a JPEG, PNG or WebP picture.');
    }
    if (raw.length > IMAGE_LIMIT) throw new RuleError('That picture is too big. Try a smaller one.', 413);
    if (!this.shopify.configured) throw new RuleError(SHOPIFY_DOWN, 503);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    const filename = `lair-event-${makeId('x').slice(2, 14)}.${match[1].split('/')[1].replace('jpeg', 'jpg')}`;
    let result;
    try {
      result = await this.shopify.uploadEventPicture({ bytes, mimeType: match[1], filename, alt: trimmed(input?.alt, 200) });
    } catch (error) {
      throw this.eventsFailed(error);
    }
    if (result.problem) throw new RuleError(`Shopify didn't take the picture (${String(result.problem).slice(0, 160)}). Try again.`, 502);
    this.eventRefs = this.eventRefs || new Map();
    this.eventRefs.set(result.image.id, { url: result.image.url, alt: result.image.alt ?? '' });
    return { image: result.image };
  }

  /* ---------------- dice ---------------- */
  /**
   * POST /roll: a d20 rolled on the server.
   *   fun (no body, { kind: 'fun' }, or not logged in): just the roll, never a prize. The home page uses this.
   *   loyalty (logged in, round 6): uses one of their loyalty rolls (a full card, a round 6 welcome roll, birthday gifts,
   *     rolls staff gave or, round 7, loot codes). Whatever the d20 shows is the prize: $1 to $20 store credit.
   *   spend and bonus: the spend dice retired in round 6 (410). daily: retired in round 4 (410).
   * The roll is claimed in the database before Shopify is asked for anything, so two quick taps can't spend one roll
   * twice. If Shopify can't add the store credit, the prize is kept as pending: the member shows the screen at the
   * counter, staff get an email and mark it done (POST /prizes/:id/done).
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
    const asked = input?.kind;
    if (!who.customerId || !['loyalty', 'spend', 'bonus', 'daily'].includes(asked)) return { roll: d20() };
    if (asked === 'daily') throw new RuleError('The daily roll has retired. Fill your loyalty card: 10 sessions earn a roll.', 410);
    if (asked !== 'loyalty') throw new RuleError(SPEND_RETIRED, 410);
    if (this.loyaltyOf(who.customerId).rolls.available < 1) throw new RuleError('No rolls yet, friend. Fill your card: 10 sessions earn a roll.', 409);
    const roll = d20();
    const won = loyaltyPrize(roll);
    const prizeId = makeId('pz');
    this.write(
      "INSERT INTO member_rolls (id, customer_id, kind, day, roll, prize_id, created_at) VALUES (?, ?, 'loyalty', ?, ?, ?, ?)",
      makeId('rl'), who.customerId, new LairTime(rules.tz).key(now), roll, prizeId, now,
    );
    this.write(
      "INSERT INTO prizes (id, customer_id, source, kind, amount, status, created_at, updated_at) VALUES (?, ?, 'loyalty', 'credit', ?, 'pending', ?, ?)",
      prizeId, who.customerId, won.amount, now, now,
    );
    this.touchMember(who.customerId, {}, now);
    // --- claimed ---
    let problem = null;
    try {
      if (!this.shopify.configured) throw new Error('Shopify is not connected.');
      await this.shopify.creditCustomer(who.customerId, won.amount, this.env.CURRENCY || 'NZD');
    } catch (error) {
      problem = String(error.message || error).slice(0, 300);
      console.error('Lair: dice prize failed', error);
      this.note({ prizeError: { message: problem, at: new Date().toISOString() } });
    }
    // --- no awaits from here on: only this prize's own row changes ---
    this.write("UPDATE prizes SET status = ?, note = ?, updated_at = ? WHERE id = ? AND status = 'pending'", problem ? 'pending' : 'added', problem, Date.now(), prizeId);
    const prize = this.prizeRow(prizeId);
    if (problem) {
      const member = this.memberRow(who.customerId);
      this.notifyStaff(`Prize to give at the counter: ${member?.name || member?.code || 'a member'}`, {
        title: 'A dice prize to give at the counter',
        intro: "Shopify couldn't add a loyalty roll's prize to a member's account, so they'll show their screen at the counter. Add the store credit there, then mark the prize done on the staff page.",
        details: [['Member', `${member?.name || 'Unknown'}${member?.code ? ` (${member.code})` : ''}`], ['Roll', String(roll)], ['Prize', `${dollars(won.amount)} store credit`], ['Why', problem]],
      });
    }
    return {
      roll, kind: 'loyalty', prize: { id: prize.id, kind: 'credit', amount: prize.amount, status: prize.status },
      message: loyaltyMessage(roll, Boolean(problem)), loyalty: this.loyaltyOf(who.customerId, rules, { details: true }),
    };
  }

  /* ---------------- the loyalty card (round 6) ---------------- */
  /**
   * The sessions that earn a member stamps, newest first: their table bookings, game spots and TTRPG seats that were
   * checked in ('seated', or 'done' once they left) and their event sign-ups that were 'attended', for sessions that
   * start on or after the loyalty start. Each is a stamp for every person on it (friends without an account go on the
   * booker's card). No-shows, cancellations and holds never count, and undoing a check-in takes its stamps back,
   * because nothing is stored: it's counted here every time. A GM's own table isn't one. Round 8: a guest with an
   * account on someone's sign-up gets their own stamp (one person, on their card), so the sign-up's own card counts its
   * people less its guests with an account. One who signed up is never their own guest too (a guest row with the sign-up's
   * own account, from before it joined their account, counts once). No awaits.
   */
  stampedSessions(customerId, limit = -1) {
    return this.sql
      .exec(
        `SELECT b.id AS id, b.kind AS kind, b.starts_at AS at, b.people AS people, b.tables AS tables, b.occurrence_id AS occurrence_id,
             g.title AS game_title, NULL AS join_title
           FROM bookings b LEFT JOIN games g ON g.id = b.game_id
          WHERE b.customer_id = ? AND b.kind IN ('table', 'walkin', 'gm-seat') AND b.status IN ('seated', 'done') AND b.starts_at >= ?
         UNION ALL
         SELECT j.id, 'join', j.starts_at, MAX(j.people - (SELECT COUNT(*) FROM event_join_guests x WHERE x.join_id = j.id AND x.customer_id IS NOT NULL), 0),
             '[]', j.occurrence_id, NULL, j.title
           FROM event_joins j WHERE j.customer_id = ? AND j.status = 'attended' AND j.starts_at >= ?
         UNION ALL
         SELECT j.id, 'join', j.starts_at, 1, '[]', j.occurrence_id, NULL, j.title
           FROM event_join_guests x JOIN event_joins j ON j.id = x.join_id
          WHERE x.customer_id = ? AND j.status = 'attended' AND j.starts_at >= ? AND (j.customer_id IS NULL OR j.customer_id != x.customer_id)
         ORDER BY at DESC, id DESC LIMIT ?`,
        String(customerId), this.loyaltyFrom, String(customerId), this.loyaltyFrom, String(customerId), this.loyaltyFrom, limit,
      )
      .toArray();
  }

  /** All the stamps a member has earned: one a person a checked-in session (stampedSessions). No awaits. */
  stampCount(customerId) {
    return this.sql
      .exec(
        `SELECT COALESCE(SUM(people), 0) AS n FROM (
           SELECT people FROM bookings WHERE customer_id = ? AND kind IN ('table', 'walkin', 'gm-seat') AND status IN ('seated', 'done') AND starts_at >= ?
           UNION ALL
           SELECT MAX(j.people - (SELECT COUNT(*) FROM event_join_guests x WHERE x.join_id = j.id AND x.customer_id IS NOT NULL), 0)
             FROM event_joins j WHERE j.customer_id = ? AND j.status = 'attended' AND j.starts_at >= ?
           UNION ALL
           SELECT 1 FROM event_join_guests x JOIN event_joins j ON j.id = x.join_id
            WHERE x.customer_id = ? AND j.status = 'attended' AND j.starts_at >= ? AND (j.customer_id IS NULL OR j.customer_id != x.customer_id))`,
        String(customerId), this.loyaltyFrom, String(customerId), this.loyaltyFrom, String(customerId), this.loyaltyFrom,
      )
      .one().n;
  }

  /**
   * A member's loyalty card (GET /me, the roll, staff views): { stamps (0-9 on this card), cardSize, cards (full cards),
   * card (round 7: the number of the card they're on, cards + 1), rolls: { available, earned: { cards, welcome,
   * birthday, staff, codes }, used } }. A full card earns a roll and the next card starts at once; so do the welcome
   * rolls given in round 6, birthday gifts' rolls, rolls staff give and (round 7) loot codes' rolls. used: loyalty rolls
   * rolled (the old spend dice's rolls never count). details adds recent (the last 10 stamped sessions, newest first:
   * { at, title, people }) and history (the last 20 loyalty rolls, newest first: { id, at, roll, amount, status:
   * 'added'|'pending' }). No awaits.
   */
  loyaltyOf(customerId, rules = this.rulesCache, { details = false } = {}) {
    const id = String(customerId);
    const { stamps, cards } = loyaltyCard(this.stampCount(id));
    const grants = new Map(this.sql.exec('SELECT kind, COALESCE(SUM(count), 0) AS n FROM loyalty_grants WHERE customer_id = ? GROUP BY kind', id).toArray().map((r) => [r.kind, r.n]));
    const earned = { cards, welcome: grants.get('welcome') || 0, birthday: this.giftedRolls(id), staff: grants.get('staff') || 0, codes: grants.get('code') || 0 };
    const used = this.sql.exec("SELECT COUNT(*) AS n FROM member_rolls WHERE customer_id = ? AND kind = 'loyalty'", id).one().n;
    const available = Math.max(0, earned.cards + earned.welcome + earned.birthday + earned.staff + earned.codes - used);
    const card = { stamps, cardSize: CARD_SIZE, cards, card: cards + 1, rolls: { available, earned, used } };
    if (!details) return card;
    const recent = this.stampedSessions(id, 10).map((s) => ({ at: s.at, title: this.stampTitle(s, rules), people: s.people }));
    const history = this.sql
      .exec(
        `SELECT r.id AS roll_id, r.prize_id AS prize_id, r.created_at AS at, r.roll AS roll, p.amount AS amount, p.status AS status
           FROM member_rolls r LEFT JOIN prizes p ON p.id = r.prize_id WHERE r.customer_id = ? AND r.kind = 'loyalty'
          ORDER BY r.created_at DESC, r.rowid DESC LIMIT 20`,
        id,
      )
      .toArray()
      .map((r) => ({ id: r.prize_id || r.roll_id, at: r.at, roll: r.roll, amount: r.amount ?? r.roll * 100, status: r.status === 'pending' ? 'pending' : 'added' }));
    return { ...card, recent, history };
  }

  /** A stamped session's title, as My Lair shows it: "Table T4", a game's title, or an event's */
  stampTitle(s, rules = this.rulesCache) {
    if (s.kind === 'join') return s.join_title || 'Event';
    if (s.kind === 'gm-seat') return s.game_title || 'TTRPG session';
    if (s.occurrence_id) return (rules && findOccurrence(rules, s.occurrence_id)?.title) || 'Event game spot';
    return this.tablesTitle(parse(s.tables, []));
  }

  /** The old dice's `rolls` (GET /me, the POS member lookup), for clients from before round 6: it mirrors the loyalty rolls. */
  legacyRolls(loyalty) {
    const available = loyalty?.rolls?.available || 0;
    return { available, toNext: null, per: null, bonus: available };
  }

  /**
   * POST /members/:customerId/rolls { count, note? } (staff): extra loyalty rolls, 1 to 20 at a time. Each grant is a
   * row of its own, kept with who gave it. Returns { member } (as GET /members lists them).
   */
  async giveRolls(customerId, input, who) {
    this.requireStaff(who, 'members');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const member = this.memberRow(trimmed(customerId, 40));
    if (!member) throw new RuleError('No member with that customer ID.', 404);
    const count = Number(input?.count);
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new RuleError('Give between 1 and 20 rolls.');
    this.write(
      "INSERT INTO loyalty_grants (id, customer_id, kind, count, note, created_by, created_at) VALUES (?, ?, 'staff', ?, ?, ?, ?)",
      makeId('lg'), member.customer_id, count, trimmed(input?.note, 300) || null, who.customerId ? `staff:${who.customerId}` : 'staff', now,
    );
    return { member: this.memberListItem(member.customer_id, rules, now) };
  }

  /* ---------------- loot codes (round 7: "roll codes" in the code) ---------------- */
  rollCodeRow(id) {
    return id ? this.sql.exec('SELECT * FROM roll_codes WHERE id = ?', String(id)).toArray()[0] || null : null;
  }

  /** The loot code a typed code is (its text in the codes table, kind 'roll'), however it's typed, or null. No awaits. */
  rollCodeByText(text) {
    for (const key of codeKeys(text)) {
      const row = this.sql.exec("SELECT target_id FROM codes WHERE key = ? AND kind = 'roll'", key).toArray()[0];
      if (row) return this.rollCodeRow(row.target_id);
    }
    return null;
  }

  /** Whether a code is a birthday gift's product code (HBD-…), however it's typed. No awaits. */
  isGiftProductCode(text) {
    const key = codeKey(text);
    return Boolean(key) && this.sql.exec("SELECT 1 AS n FROM gifts WHERE product_code IS NOT NULL AND replace(upper(product_code), '-', '') = ? LIMIT 1", key).toArray().length > 0;
  }

  /**
   * A loot code as staff see it: { id, code, rolls, limit (null: none), uses, left (null with no limit), expiresAt (the
   * last moment it works, or null), status: 'active' | 'inactive' | 'expired' | 'used-up', note, createdAt, createdBy,
   * lastUsedAt, recent: the last 10 redeems, newest first ({ customerId, name, code (their member code), at }) }.
   */
  rollCodeView(r, now = Date.now()) {
    const used = this.sql.exec('SELECT COUNT(*) AS n, MAX(at) AS last FROM roll_code_uses WHERE code_id = ?', r.id).one();
    const recent = this.sql
      .exec(
        `SELECT u.customer_id AS customer_id, u.at AS at, m.name AS name, m.first_name AS first_name, m.code AS code FROM roll_code_uses u
         LEFT JOIN members m ON m.customer_id = u.customer_id WHERE u.code_id = ? ORDER BY u.at DESC, u.rowid DESC LIMIT 10`,
        r.id,
      )
      .toArray();
    const limit = r.total_limit ?? null;
    const status = r.status === 'inactive' ? 'inactive' : r.expires_at && r.expires_at < now ? 'expired' : limit != null && used.n >= limit ? 'used-up' : 'active';
    return {
      id: r.id, code: r.code, rolls: r.rolls, limit, uses: used.n, left: limit == null ? null : Math.max(0, limit - used.n), expiresAt: r.expires_at || null,
      status, note: r.note || '', createdAt: r.created_at, createdBy: r.created_by || null, lastUsedAt: used.last || null,
      recent: recent.map((u) => ({ customerId: u.customer_id, name: u.name || u.first_name || '', code: u.code || null, at: u.at })),
    };
  }

  /**
   * A staff form's loot code fields, checked (creating and updating share the rules; only what was sent is returned,
   * and a new code gets 1 roll when none is sent): rolls 1 to 20; limit 1 to 100,000 in all, or null for none;
   * expires 'YYYY-MM-DD' (the last day it works, until midnight Lair time) or null; note up to 300 characters; status
   * 'active' or 'inactive'. No awaits.
   */
  rollCodeFields(input, rules, now, existing = null) {
    const out = {};
    const has = (key) => Object.prototype.hasOwnProperty.call(input, key) && !(existing && input[key] === undefined);
    if (!existing || (has('rolls') && input.rolls != null && input.rolls !== '')) {
      const rolls = input.rolls == null || input.rolls === '' ? 1 : Number(input.rolls);
      if (!Number.isInteger(rolls) || rolls < 1 || rolls > 20) throw new RuleError(ROLL_CODE_MESSAGES.rolls);
      out.rolls = rolls;
    }
    if (has('limit')) {
      if (input.limit == null || input.limit === '') out.limit = null;
      else {
        const limit = Number(input.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100000) throw new RuleError(ROLL_CODE_MESSAGES.limit);
        out.limit = limit;
      }
    }
    if (has('expires')) {
      if (input.expires == null || input.expires === '') out.expiresAt = null;
      else {
        const text = String(input.expires).trim();
        const real = /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
        if (!real) throw new RuleError(ROLL_CODE_MESSAGES.date);
        out.expiresAt = new LairTime(rules.tz).at(addDays(text, 1), 0) - 1;
        if (out.expiresAt < now) throw new RuleError(ROLL_CODE_MESSAGES.past);
      }
    }
    if (has('note')) out.note = trimmed(input.note, 300) || null;
    if (existing && has('status')) {
      if (!['active', 'inactive'].includes(input.status)) throw new RuleError(ROLL_CODE_MESSAGES.status);
      out.status = input.status;
    }
    return out;
  }

  /** GET /roll-codes?status=active|all (staff): loot codes, newest first: active (the default) leaves out inactive ones; all is the last 200. */
  listRollCodes(url, who) {
    this.requireStaff(who, 'money');
    const now = Date.now();
    const all = url.searchParams.get('status') === 'all';
    const rows = this.sql.exec(`SELECT * FROM roll_codes${all ? '' : " WHERE status != 'inactive'"} ORDER BY created_at DESC, rowid DESC LIMIT 200`).toArray();
    return { codes: rows.map((r) => this.rollCodeView(r, now)) };
  }

  /**
   * POST /roll-codes { code?, rolls?, limit?, expires?, note? } (staff): a loot code. Typed: 4 to 24 letters, numbers or
   * dashes, kept in capitals, at least 4 letters or numbers; left empty, Gobgob makes one like GG-KOBOLD-14. Its text goes
   * in the codes table (kind 'roll'), so no code of any kind is used twice, and it never changes. Returns { code }.
   */
  async createRollCode(input, who) {
    this.requireStaff(who, 'money');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const f = this.rollCodeFields(input || {}, rules, now);
    const typed = String(input?.code ?? '').trim().toUpperCase();
    let code;
    if (typed) {
      if (!ROLL_CODE_TEXT.test(typed) || codeKey(typed).length < 4) throw new RuleError(ROLL_CODE_MESSAGES.code);
      if (this.codeTaken(codeKey(typed)) || this.isGiftProductCode(typed)) throw new RuleError(ROLL_CODE_MESSAGES.taken, 409);
      code = typed;
    } else {
      code = uniqueCode('Gobgob Gift', (key) => this.codeTaken(key));
    }
    const id = makeId('rc');
    this.write("INSERT INTO codes (key, code, kind, target_id, created_at) VALUES (?, ?, 'roll', ?, ?)", codeKey(code), code, id, now);
    this.write(
      `INSERT INTO roll_codes (id, code, rolls, total_limit, expires_at, status, note, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      id, code, f.rolls, f.limit ?? null, f.expiresAt ?? null, f.note ?? null, who.customerId ? `staff:${who.customerId}` : 'staff', now, now,
    );
    return { code: this.rollCodeView(this.rollCodeRow(id), now) };
  }

  /** POST /roll-codes/:id/update { rolls?, limit?, expires?, note?, status? } (staff). The limit can't go below the uses so far. Returns { code }. */
  async updateRollCode(id, input, who) {
    this.requireStaff(who, 'money');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const row = this.rollCodeRow(id);
    if (!row) throw new RuleError('That code could not be found.', 404);
    const f = this.rollCodeFields(input || {}, rules, now, row);
    if (f.limit != null) {
      const uses = this.sql.exec('SELECT COUNT(*) AS n FROM roll_code_uses WHERE code_id = ?', row.id).one().n;
      if (f.limit < uses) throw new RuleError(`It's been used ${plural(uses, 'time', 'times')}, so the limit can't be lower than ${uses}.`, 409);
    }
    const columns = { rolls: 'rolls', limit: 'total_limit', expiresAt: 'expires_at', note: 'note', status: 'status' };
    const keys = Object.keys(f).filter((k) => columns[k]);
    if (keys.length) this.write(`UPDATE roll_codes SET ${keys.map((k) => `${columns[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => f[k] ?? null), now, row.id);
    return { code: this.rollCodeView(this.rollCodeRow(row.id), now) };
  }

  /**
   * POST /me/codes/redeem { code } (logged in): "Got a code?", one box for pass codes, session gift codes and loot codes.
   * A pass nobody has claimed is claimed exactly as POST /me/passes/claim does ({ kind: 'pass', pass, message }). A loot
   * code gives its rolls, once per customer ({ kind: 'roll', rolls, message, loyalty }). A birthday gift's product code
   * is for the shop's checkout (422); anything else Gobgob doesn't know (404). Ten tries in ten minutes a member, shared
   * with the claim route (a pass code counts once, in claimPass).
   */
  async redeemCode(input, who) {
    if (!who.customerId) throw new RuleError('Log in to use a code.', 401);
    const text = String(input?.code ?? '').trim();
    if (!text) throw new RuleError('Type your code first.');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const tries = (this.claimHits?.get(who.customerId) || []).filter((t) => now - t < 10 * MIN);
    if (tries.length >= 10) throw new RuleError('Too many tries in a row. Give it ten minutes, or ask us at the counter.', 429);
    // A pass or session gift: exactly the claim route (claimPass has no awaits of its own, so it reads, checks and saves
    // straight through, and counts the try itself)
    if (this.findCode(text)?.type === 'pass') {
      const { pass } = await this.claimPass({ code: text }, who);
      return { kind: 'pass', pass, message: `Added to your wallet: ${pass.label}.` };
    }
    this.claimHits = this.claimHits || new Map();
    if (this.claimHits.size > 2000) this.claimHits.clear();
    this.claimHits.set(who.customerId, [...tries, now]);
    const loot = this.rollCodeByText(text);
    if (loot) {
      const me = String(who.customerId);
      if (this.sql.exec('SELECT 1 AS n FROM roll_code_uses WHERE code_id = ? AND customer_id = ?', loot.id, me).toArray().length) {
        throw new RuleError("You've used that code already. It's one go each.", 409);
      }
      if (this.rollCodeView(loot, now).status !== 'active') throw new RuleError("That code isn't working any more. Ask us at the counter.", 410);
      this.touchMember(me, {}, now);
      const grantId = makeId('lg');
      this.write(
        "INSERT INTO loyalty_grants (id, customer_id, kind, count, note, created_by, created_at) VALUES (?, ?, 'code', ?, ?, ?, ?)",
        grantId, me, loot.rolls, loot.code, `code:${loot.id}`, now,
      );
      this.write('INSERT INTO roll_code_uses (id, code_id, customer_id, rolls, grant_id, at) VALUES (?, ?, ?, ?, ?, ?)', makeId('ru'), loot.id, me, loot.rolls, grantId, now);
      const message = loot.rolls === 1
        ? "Loot! That's 1 roll for your loyalty card. Roll it on Home, friend."
        : `Loot! That's ${loot.rolls} rolls for your loyalty card. Roll them on Home, friend.`;
      return { kind: 'roll', rolls: loot.rolls, message, loyalty: this.loyaltyOf(me, rules, { details: true }) };
    }
    if (this.isGiftProductCode(text)) throw new RuleError("That's a shop discount code. Use it at checkout online, or show it at the counter.");
    throw new RuleError("Gobgob doesn't know that code. Check it and try again.", 404);
  }

  /** Extra dice rolls a member has been given as birthday gifts */
  giftedRolls(customerId) {
    return this.sql.exec('SELECT COALESCE(SUM(rolls), 0) AS n FROM gifts WHERE customer_id = ?', String(customerId)).one().n;
  }

  /** One prize with its roll, or null */
  prizeRow(id) {
    return this.sql.exec('SELECT p.*, r.roll AS roll FROM prizes p LEFT JOIN member_rolls r ON r.prize_id = p.id WHERE p.id = ?', String(id)).toArray()[0] || null;
  }

  /**
   * A dice prize as My Lair and staff see it: { id, kind: 'credit', amount, status, roll, at }. status: 'added' (on
   * their account), 'pending' (to give at the counter) or 'done' (staff gave it).
   */
  prizeView(p) {
    return { id: p.id, kind: p.kind, amount: p.amount || 0, status: p.status, roll: p.roll ?? null, at: p.created_at };
  }

  /** A member's last 10 dice prizes (birthday codes are emailed, so they aren't in this list), or only the pending ones */
  memberPrizes(customerId, { pending = false } = {}) {
    return this.sql
      .exec(
        `SELECT p.*, r.roll AS roll FROM prizes p LEFT JOIN member_rolls r ON r.prize_id = p.id
         WHERE p.customer_id = ? AND p.source != 'birthday' ${pending ? "AND p.status = 'pending'" : ''} ORDER BY p.created_at DESC, p.rowid DESC LIMIT 10`,
        String(customerId),
      )
      .toArray()
      .map((p) => this.prizeView(p));
  }

  /** POST /prizes/:id/done (staff): a dice prize waiting at the counter has been given. */
  async prizeDone(id, who) {
    // Round 9: a dice prize handed over at the counter, from the desk or a member's page
    this.requireStaff(who, ['checkin', 'members']);
    // --- no awaits from here on ---
    const prize = this.prizeRow(id);
    if (!prize || prize.source === 'birthday') throw new RuleError('That prize could not be found.', 404);
    if (prize.status === 'added') throw new RuleError('That store credit is on their account already, so there is nothing to give.', 409);
    if (prize.status === 'pending') this.write("UPDATE prizes SET status = 'done', updated_at = ? WHERE id = ? AND status = 'pending'", Date.now(), prize.id);
    return { prize: this.prizeView(this.prizeRow(prize.id)) };
  }

  /* ---------------- the self-serve tab ---------------- */
  /** A tab as My Lair and the POS see it: { id, day, items: [{ variantId, title, variantTitle, price, qty }], total, status, updatedAt } */
  tabView(r) {
    return r ? { id: r.id, day: r.day, items: parse(r.items, []), total: r.total, status: r.status, updatedAt: r.updated_at } : null;
  }

  /** Today's tab row: the one still open or at the counter, or else the last one paid today; null when there's none */
  todayTabRow(customerId, rules, now) {
    const day = new LairTime(rules.tz).key(now);
    const rows = this.sql.exec('SELECT * FROM tabs WHERE customer_id = ? AND day = ? ORDER BY created_at DESC, rowid DESC', String(customerId), day).toArray();
    return rows.find((r) => r.status !== 'paid') || rows[0] || null;
  }

  /**
   * A tab's items from My Lair, checked: up to 30 lines, 1 to 20 of each, numeric Shopify variant ids, prices from 0 to
   * 100000 cents and titles up to 80 characters. The same variant twice is one line. No awaits.
   */
  tabItems(list) {
    if (!Array.isArray(list) || list.length > 100) throw new RuleError("Something on your tab didn't look right. Pick it from the menu again.");
    const lines = new Map();
    for (const raw of list) {
      const variantId = String(raw?.variantId ?? '').trim();
      if (!/^\d{1,20}$/.test(variantId)) throw new RuleError("Gobgob doesn't know that one. Pick it from the menu instead.");
      const qty = Number(raw.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw new RuleError('Pick 1 to 20 of each thing.');
      const price = Number(raw.price);
      if (!Number.isFinite(price) || price < 0 || price > 100000) throw new RuleError("That price doesn't look right. Pick it from the menu again.");
      const line = lines.get(variantId);
      if (line) {
        line.qty += qty;
        if (line.qty > 20) throw new RuleError('Pick 1 to 20 of each thing.');
      } else {
        lines.set(variantId, { variantId, title: trimmed(raw.title, 80), variantTitle: trimmed(raw.variantTitle, 80), price: Math.round(price), qty });
      }
    }
    if (lines.size > 30) throw new RuleError('A tab holds up to 30 different things. Pay for this lot, then start a fresh one.');
    return [...lines.values()];
  }

  /**
   * POST /tab { items } (logged in): save today's tab, replacing its items. Empty items deletes the open tab. A tab at
   * the counter can't change (409); once today's tab is paid, a new one starts. Returns { tab }.
   */
  async saveTab(input, who) {
    if (!who.customerId) throw new RuleError('Log in to start a tab.', 401);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const items = this.tabItems(input.items);
    const current = this.todayTabRow(who.customerId, rules, now);
    const open = current && current.status !== 'paid' ? current : null;
    if (open?.status === 'in-cart') throw new RuleError('Your tab is at the counter already. Pay for that one, then start a fresh one.', 409);
    if (!items.length) {
      if (open) this.write("DELETE FROM tabs WHERE id = ? AND status = 'open'", open.id);
      // Round 9: a bill with this tab on it is cancelled (what it charges has changed)
      if (open) this.reconcileBills(rules, now);
      return { tab: this.tabView(this.todayTabRow(who.customerId, rules, now)) };
    }
    const total = items.reduce((sum, x) => sum + x.price * x.qty, 0);
    // Round 9: on a monthly account, more on the tab can't take it over its credit limit
    this.checkAccountLimit(who.customerId, total - (open?.total || 0), rules, now, 'tab');
    let id = open?.id;
    if (open) {
      this.write("UPDATE tabs SET items = ?, total = ?, updated_at = ? WHERE id = ? AND status = 'open'", JSON.stringify(items), total, now, id);
    } else {
      id = makeId('tb');
      this.write(
        "INSERT INTO tabs (id, customer_id, day, items, total, status, order_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, ?)",
        id, String(who.customerId), new LairTime(rules.tz).key(now), JSON.stringify(items), total, now, now,
      );
    }
    // Round 9: a bill with this tab on it is cancelled (what it charges has changed)
    if (open) this.reconcileBills(rules, now);
    this.touchMember(who.customerId, {}, now);
    return { tab: this.tabView(this.sql.exec('SELECT * FROM tabs WHERE id = ?', id).one()) };
  }

  /** POST /tab/clear (logged in): delete today's open tab. Returns { tab } (null, or one already paid today). */
  async clearTab(who) {
    if (!who.customerId) throw new RuleError('Log in to see your tab.', 401);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const current = this.todayTabRow(who.customerId, rules, now);
    if (current?.status === 'in-cart') throw new RuleError('Your tab is at the counter already. Pay for that one, then start a fresh one.', 409);
    if (current?.status === 'open') this.write("DELETE FROM tabs WHERE id = ? AND status = 'open'", current.id);
    // Round 9: a bill with this tab on it is cancelled
    if (current?.status === 'open') this.reconcileBills(rules, now);
    return { tab: this.tabView(this.todayTabRow(who.customerId, rules, now)) };
  }

  /** POST /pos/tab/:id/added (the POS): the tab's items are in the cart, so it can't change while they pay. Returns { tab }. */
  posTabAdded(id) {
    // --- no awaits ---
    const row = this.sql.exec('SELECT * FROM tabs WHERE id = ?', String(id)).toArray()[0];
    if (!row) throw new RuleError('That tab is gone. Scan their member code again.', 404);
    if (row.status === 'paid') throw new RuleError('That tab is paid already.', 409);
    if (row.status === 'open') this.write("UPDATE tabs SET status = 'in-cart', updated_at = ? WHERE id = ? AND status = 'open'", Date.now(), row.id);
    return { tab: this.tabView(this.sql.exec('SELECT * FROM tabs WHERE id = ?', row.id).one()) };
  }

  /** Tabs paid by a counter order (its lines carry _tab). No awaits. */
  markTabsPaid(ids, orderId, now) {
    const paid = [];
    for (const id of ids) {
      const row = this.sql.exec('SELECT * FROM tabs WHERE id = ?', id).toArray()[0];
      if (!row) continue;
      if (row.status !== 'paid') this.write("UPDATE tabs SET status = 'paid', order_id = ?, updated_at = ? WHERE id = ?", orderId, now, row.id);
      paid.push(row.id);
    }
    return paid;
  }

  /* ---------------- session passes ---------------- */
  rowToPass(r) {
    return {
      id: r.id, code: r.code, label: r.label, sessionsTotal: r.sessions_total, sessionsUsed: r.sessions_used, cover: r.cover,
      customerId: r.customer_id || null, holderName: r.holder_name || '', holderEmail: r.holder_email || '', note: r.note || '',
      pricePaid: r.price_paid || 0, createdAt: r.created_at, createdBy: r.created_by || null, expiresAt: r.expires_at || null, status: r.status,
      // Where it came from: 'staff' (made on the staff page; older passes have no source), 'order' (bought as a product)
      // or 'birthday' (a birthday gift). orderName is the order that bought it, like "#1550".
      source: r.source || 'staff', orderId: r.order_id || null, orderName: r.order_name || null,
      // Round 7: the group it belongs to (any member of the group can use it), or null
      groupId: r.group_id || null,
    };
  }

  passRow(id) {
    const row = id ? this.sql.exec('SELECT * FROM passes WHERE id = ?', String(id)).toArray()[0] : null;
    return row ? this.rowToPass(row) : null;
  }

  /** A pass by its code, however it's typed */
  passByCode(code) {
    const found = String(code ?? '').trim() ? this.findCode(code) : null;
    return found?.type === 'pass' ? found.item : null;
  }

  /** 'void' (staff cancelled it), 'expired', 'used' (no sessions left) or 'active' */
  passStatus(p, now = Date.now()) {
    if (p.status === 'void') return 'void';
    if (p.expiresAt && p.expiresAt < now) return 'expired';
    if (p.sessionsTotal - p.sessionsUsed <= 0) return 'used';
    return 'active';
  }

  /**
   * A pass as its holder sees it (GET /me, claiming one). source: 'staff', 'order' or 'birthday', the same as the staff
   * view. A pass bought as a product also has orderName (like "#1550") and note: how it was bought, "Bought online" or
   * "Bought at the counter". Notes are otherwise for staff only, so that's all a member ever sees of one: a pass staff
   * made has no note here, and a bought pass's note gives only how it was bought, even after staff add to it ('' once
   * they've replaced that). orderName is null for passes that weren't bought.
   */
  memberPassView(p, now = Date.now()) {
    const bought = p.source === 'order';
    return {
      code: p.code, label: p.label, sessionsTotal: p.sessionsTotal, sessionsLeft: Math.max(0, p.sessionsTotal - p.sessionsUsed), cover: p.cover,
      expiresAt: p.expiresAt, status: this.passStatus(p, now), source: p.source, orderName: bought ? p.orderName || null : null,
      ...(bought ? { note: this.boughtNote(p.note) } : {}),
      // Round 7: a group's pass, which shows in each member's Wallet with the group's name ("Warhammer League group")
      group: this.passGroup(p),
    };
  }

  /** The group a pass belongs to, as pass views show it: { id, name }, or null (round 7). No awaits. */
  passGroup(p) {
    if (!p?.groupId) return null;
    const g = this.groupRow(p.groupId);
    return g ? { id: g.id, name: g.name } : null;
  }

  /** How a pass from an order was bought, from the note the order gave it: "Bought online", "Bought at the counter", or '' */
  boughtNote(note) {
    const text = String(note || '').trim();
    if (/^bought at the counter\b/i.test(text)) return 'Bought at the counter';
    if (/^bought online\b/i.test(text)) return 'Bought online';
    return '';
  }

  /**
   * A pass as staff see it, with its uses (newest first) unless uses is false. source: 'staff', 'order' (bought on
   * orderName) or 'birthday'. A pass bought with no customer on the sale has no holder.customerId: its code is for them
   * to claim in My Lair.
   */
  passView(p, { uses = true, now = Date.now() } = {}) {
    // Round 7: a group's pass reads as the group: { customerId: null, name: <group name>, email: '' }
    const group = this.passGroup(p);
    const view = {
      id: p.id, code: p.code, label: p.label, sessionsTotal: p.sessionsTotal, sessionsUsed: p.sessionsUsed, sessionsLeft: Math.max(0, p.sessionsTotal - p.sessionsUsed),
      cover: p.cover, holder: group ? { customerId: null, name: group.name, email: '' } : { customerId: p.customerId, name: p.holderName, email: p.holderEmail },
      note: p.note, pricePaid: p.pricePaid, expiresAt: p.expiresAt, status: this.passStatus(p, now), createdAt: p.createdAt, source: p.source, orderName: p.orderName,
      group,
    };
    if (uses) {
      view.uses = this.sql
        .exec('SELECT u.*, b.ref AS ref FROM pass_uses u LEFT JOIN bookings b ON b.id = u.booking_id WHERE u.pass_id = ? ORDER BY u.at DESC', p.id)
        .toArray()
        .map((u) => ({ id: u.id, bookingId: u.booking_id, ref: u.ref || '', people: u.people, covered: u.covered, at: u.at, undone: u.undone_at || null }));
    }
    return view;
  }

  /** A booking's saved pass as staff and the POS see it: { code, label, left }. memo: a Map that saves lookups in lists. */
  savedPass(b, memo = null) {
    if (!b?.passId) return null;
    let p = memo?.get(b.passId);
    if (p === undefined) {
      p = this.passRow(b.passId);
      memo?.set(b.passId, p);
    }
    return p ? { code: p.code, label: p.label, left: Math.max(0, p.sessionsTotal - p.sessionsUsed) } : null;
  }

  /** A booking's saved pass as the person who booked sees it: { code, label, sessionsLeft } */
  ownPass(b) {
    const p = this.savedPass(b);
    return p ? { code: p.code, label: p.label, sessionsLeft: p.left } : null;
  }

  /**
   * A member's passes for My Lair: active ones, and ones used up in the last 30 days. Round 7: their own, plus the passes
   * of the active groups they're in (each with its group).
   */
  memberPasses(customerId, now) {
    return this.sql
      .exec(
        `SELECT p.*, (SELECT MAX(u.at) FROM pass_uses u WHERE u.pass_id = p.id AND u.undone_at IS NULL) AS last_used
         FROM passes p WHERE (p.customer_id = ? OR p.group_id IN (${this.memberGroupsSql()})) AND p.status = 'active' ORDER BY p.created_at DESC, p.rowid DESC`,
        String(customerId), String(customerId),
      )
      .toArray()
      .filter((r) => {
        const status = this.passStatus(this.rowToPass(r), now);
        return status === 'active' || (status === 'used' && (r.last_used || 0) > now - 30 * 24 * HOUR);
      })
      .map((r) => this.memberPassView(this.rowToPass(r), now));
  }

  /**
   * A member's passes that can be used now, as staff see them (the POS shows them when it scans a member code, and so
   * does check-in). Round 7: their own, plus their active groups' passes, each with its group.
   */
  activePasses(customerId, now) {
    return this.sql.exec(
      `SELECT * FROM passes WHERE (customer_id = ? OR group_id IN (${this.memberGroupsSql()})) AND status = 'active' ORDER BY created_at DESC, rowid DESC`,
      String(customerId), String(customerId),
    ).toArray()
      .map((r) => this.rowToPass(r))
      .filter((p) => this.passStatus(p, now) === 'active')
      .map((p) => this.passView(p, { uses: false, now }));
  }

  /** SQL for the ids of the active groups a customer (one bound value) is in: for `group_id IN (…)` (round 7) */
  memberGroupsSql() {
    return "SELECT m.group_id FROM lair_group_members m JOIN lair_groups g ON g.id = m.group_id AND g.status = 'active' WHERE m.customer_id = ?";
  }

  /** The last moment of a Lair day ('YYYY-MM-DD'): a pass that expires that day works until midnight. */
  endOfDay(key, rules) {
    const text = String(key || '').trim();
    const real = /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
    if (!real) throw new RuleError('Pick the expiry date from the calendar.');
    return new LairTime(rules.tz).at(addDays(text, 1), 0) - 1;
  }

  /**
   * A staff form's pass fields (creating and updating share the rules). Only what was sent is returned. A holder email
   * that matches a member links them. Round 7: a pass belongs to exactly one of a group (groupId: any active member can
   * use it), a customer (customerId, picked from the search: one the Lair hasn't met comes with holderName and
   * holderEmail, and out.picked makes their member record), or a name typed by hand (holderName, holderEmail optional).
   * On an update, groupId: null takes it off its group. No awaits, no writes.
   */
  passFields(input, rules, now, existing = null) {
    const out = {};
    if (input.label != null || !existing) {
      out.label = trimmed(input.label, 80);
      if (!out.label) throw new RuleError('Add a label, like "Warhammer league: 10 sessions".');
    }
    if (input.sessions != null || !existing) {
      const sessions = Math.floor(Number(input.sessions));
      if (!(sessions >= 1 && sessions <= 100)) throw new RuleError('A pass has 1 to 100 sessions.');
      if (existing && sessions < existing.sessionsUsed) {
        throw new RuleError(`This pass has used ${plural(existing.sessionsUsed, 'session', 'sessions')}, so it can't have fewer than ${existing.sessionsUsed}.`);
      }
      out.sessionsTotal = sessions;
    }
    if (input.note != null) out.note = trimmed(input.note, 300);
    if (input.expires != null) {
      out.expiresAt = input.expires ? this.endOfDay(input.expires, rules) : null;
      if (out.expiresAt && out.expiresAt < now) throw new RuleError('That expiry date has already passed.');
    }
    if (input.status != null) {
      if (!['active', 'void'].includes(input.status)) throw new RuleError('A pass is active or void.');
      out.status = input.status;
    }
    if (input.pricePaid != null && input.pricePaid !== '') {
      const value = Number(input.pricePaid);
      if (!(value >= 0 && value <= 10000)) throw new RuleError('Check the price paid.');
      out.pricePaid = Math.round(value * 100);
    }
    if (input.cover != null && input.cover !== '') {
      const value = Number(input.cover);
      if (!(value > 0 && value <= 1000)) throw new RuleError('Check how much a session covers.');
      out.cover = Math.round(value * 100);
    }
    const email = input.holderEmail != null ? trimmed(input.holderEmail, 120) : null;
    if (email && !isEmail(email)) throw new RuleError("Check the holder's email address.");
    const wanted = input.customerId != null && input.customerId !== '' ? trimmed(input.customerId, 40) : null;
    // Round 7: the owner. A group, or a person (a customer or a typed name), never both.
    const groupSent = Object.prototype.hasOwnProperty.call(input, 'groupId');
    const groupWanted = groupSent && input.groupId != null && String(input.groupId).trim() !== '' ? trimmed(input.groupId, 40) : null;
    if (groupWanted && (wanted || trimmed(input.holderName, 80))) throw new RuleError('A pass belongs to a group or a person, not both.');
    if (groupWanted) {
      const group = this.groupRow(groupWanted);
      if (!group) throw new RuleError('That group could not be found.', 404);
      if (group.status !== 'active') throw new RuleError('That group is archived. Pick another, or bring it back first.', 409);
      Object.assign(out, { groupId: group.id, customerId: null, holderName: '', holderEmail: '', groupName: group.name });
      return out;
    }
    if (groupSent) out.groupId = null;
    const member = (wanted && this.memberRow(wanted)) || (email && this.memberByEmail(email)) || null;
    if (member) {
      Object.assign(out, { customerId: member.customer_id, holderName: trimmed(input.holderName, 80) || member.name || member.first_name || '', holderEmail: email || member.email || '' });
    } else if (wanted) {
      // A customer the Lair hasn't met, picked from the search with their name and email: their member record is made
      // with the pass. With no name it's the round 4 404.
      out.picked = this.pickedCustomer({ customerId: wanted, name: input.holderName, email }, { missing: 'That member could not be found.' });
      Object.assign(out, { customerId: out.picked.customerId, holderName: out.picked.name, holderEmail: out.picked.email });
    } else {
      if (input.customerId === null || input.customerId === '') out.customerId = null;
      if (input.holderName != null) out.holderName = trimmed(input.holderName, 80);
      if (email != null) out.holderEmail = email;
    }
    const holderName = out.holderName ?? existing?.holderName ?? '';
    const customerId = out.customerId !== undefined ? out.customerId : existing?.customerId ?? null;
    const groupId = out.groupId !== undefined ? out.groupId : existing?.groupId ?? null;
    if (groupId && (customerId || holderName)) throw new RuleError('A pass belongs to a group or a person, not both.');
    if (!groupId && !customerId && !holderName) throw new RuleError('Pick a group, pick a customer, or type a name.');
    return out;
  }

  /**
   * POST /passes (staff): { label, sessions (1-100), customerId?, holderName?, holderEmail?, note?, pricePaid? (dollars),
   * expires? ('YYYY-MM-DD'), cover? (dollars) }. Each session covers one person's table fee up to cover, the standard
   * table price unless it says otherwise. The code comes from the holder's name (DG with none). Returns { pass }.
   */
  async createPass(input, who) {
    this.requireStaff(who, 'money');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const f = this.passFields(input, rules, now);
    if (f.picked) this.makeMember(f.picked, now);
    const id = makeId('ps');
    // A group's pass takes its code from the group's name (Warhammer League: WL-…), round 7
    const code = this.newCode(f.groupName || f.holderName || '', 'pass', id, now);
    this.write(
      `INSERT INTO passes (id, code, label, sessions_total, sessions_used, cover, customer_id, holder_name, holder_email, note, price_paid, created_at,
         created_by, expires_at, status, group_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      id, code, f.label, f.sessionsTotal, f.cover ?? rules.prices.table, f.customerId || null, f.holderName || null, f.holderEmail || null, f.note || null,
      f.pricePaid || 0, now, who.customerId || 'staff', f.expiresAt || null, f.groupId || null,
    );
    return { pass: this.passView(this.passRow(id), { now }) };
  }

  /**
   * GET /passes?q=&status=active|void|all (staff): newest first, up to 100. q looks in the label, holder, code and order
   * name, and (round 7) the name of the group a pass belongs to.
   */
  listPasses(url, who) {
    // Round 9: Passes is money; the desk and a member's page read a member's passes too
    this.requireStaff(who, ['money', 'checkin', 'members']);
    const now = Date.now();
    const q = trimmed(url.searchParams.get('q'), 80).toLowerCase();
    const key = codeKey(q);
    const wanted = url.searchParams.get('status');
    const status = ['active', 'void', 'all'].includes(wanted) ? wanted : 'active';
    const rows = status === 'all'
      ? this.sql.exec('SELECT p.*, g.name AS group_name FROM passes p LEFT JOIN lair_groups g ON g.id = p.group_id ORDER BY p.created_at DESC, p.rowid DESC').toArray()
      : this.sql.exec('SELECT p.*, g.name AS group_name FROM passes p LEFT JOIN lair_groups g ON g.id = p.group_id WHERE p.status = ? ORDER BY p.created_at DESC, p.rowid DESC', status).toArray();
    const matches = (r) => !q || [r.label, r.holder_name, r.holder_email, r.order_name, r.group_name].some((v) => String(v || '').toLowerCase().includes(q)) || (key.length >= 2 && codeKey(r.code).includes(key));
    return { passes: rows.filter(matches).slice(0, 100).map((r) => this.passView(this.rowToPass(r), { now })) };
  }

  /**
   * POST /passes/:id/update (staff): label, sessions (never below the sessions used), note, expires, status or holder; round
   * 7: groupId (a group, or null to take it off its group, when it then needs a customer or a holder's name).
   */
  async updatePass(id, input, who) {
    this.requireStaff(who, 'money');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const p = this.passRow(id);
    if (!p) throw new RuleError('That pass could not be found.', 404);
    const f = this.passFields(input, rules, now, p);
    if (f.picked) this.makeMember(f.picked, now);
    const columns = {
      label: 'label', sessionsTotal: 'sessions_total', note: 'note', expiresAt: 'expires_at', status: 'status', pricePaid: 'price_paid', cover: 'cover',
      customerId: 'customer_id', holderName: 'holder_name', holderEmail: 'holder_email', groupId: 'group_id',
    };
    const keys = Object.keys(f).filter((k) => columns[k]);
    if (keys.length) this.write(`UPDATE passes SET ${keys.map((k) => `${columns[k]} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => (f[k] === '' ? null : f[k] ?? null)), p.id);
    return { pass: this.passView(this.passRow(p.id), { now }) };
  }

  /** POST /passes/:id/apply { bookingId } (staff): save the pass on a booking, to be used when they check in. */
  async applyPass(id, input, who) {
    // Round 9: using a member's pass at the desk is check-in, as checking in with a pass is
    this.requireStaff(who, ['checkin', 'money']);
    // --- no awaits from here on ---
    const now = Date.now();
    const p = this.passRow(id);
    if (!p) throw new RuleError('That pass could not be found.', 404);
    const bookingId = trimmed(input.bookingId, 80);
    const booking = bookingId ? this.booking(bookingId) : null;
    if (!booking) {
      if (bookingId && this.joinById(bookingId)) throw new RuleError('Passes cover table sessions, not event entry.');
      throw new RuleError('That booking could not be found.', 404);
    }
    if (booking.kind === 'gm') throw new RuleError("The GM's own table has nothing to pay.");
    this.write('UPDATE bookings SET pass_id = ?, updated_at = ? WHERE id = ?', p.id, now, booking.id);
    return { booking: this.staffBooking(this.booking(booking.id)), pass: this.passView(p, { now }) };
  }

  /** POST /passes/uses/:useId/undo (staff): the sessions go back on the pass, and the booking owes what the pass covered. */
  async undoPassUse(useId, who) {
    this.requireStaff(who, ['checkin', 'money']);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const use = this.sql.exec('SELECT * FROM pass_uses WHERE id = ?', String(useId)).toArray()[0];
    if (!use) throw new RuleError('That pass use could not be found.', 404);
    if (!use.undone_at) {
      this.write('UPDATE pass_uses SET undone_at = ? WHERE id = ?', now, use.id);
      this.write('UPDATE passes SET sessions_used = MAX(0, sessions_used - ?) WHERE id = ?', use.people, use.pass_id);
      const booking = this.booking(use.booking_id);
      if (booking) {
        const next = { ...booking, covered: Math.max(0, booking.covered - use.covered) };
        this.write('UPDATE bookings SET covered = ?, paid = ?, updated_at = ? WHERE id = ?', next.covered, settled(next) ? 1 : 0, now, booking.id);
      }
    }
    const booking = this.booking(use.booking_id);
    return { pass: this.passView(this.passRow(use.pass_id), { now }), row: booking ? this.bookingRow(booking, rules) : null };
  }

  /** POST /me/passes/claim { code } (logged in): link a pass nobody has claimed yet to this member. */
  async claimPass(input, who) {
    if (!who.customerId) throw new RuleError('Log in to add a pass to your account.', 401);
    // --- no awaits from here on ---
    const now = Date.now();
    // Codes are easy to read out, so they're easy to guess: 10 tries in 10 minutes per member.
    const tries = (this.claimHits?.get(who.customerId) || []).filter((t) => now - t < 10 * MIN);
    if (tries.length >= 10) throw new RuleError('Too many tries in a row. Give it ten minutes, or ask us at the counter.', 429);
    this.claimHits = this.claimHits || new Map();
    if (this.claimHits.size > 2000) this.claimHits.clear();
    this.claimHits.set(who.customerId, [...tries, now]);
    const p = this.passByCode(input.code);
    if (!p || p.status === 'void') throw new RuleError('No pass with that code. Check it and try again.', 404);
    // Round 7: a group's pass stays the group's (its members use it as it is)
    if (p.groupId) throw new RuleError('That pass belongs to a group. Ask us at the counter.', 409);
    const me = String(who.customerId);
    if (p.customerId && p.customerId !== me) throw new RuleError('That pass already belongs to someone. Ask us at the counter.', 409);
    if (!p.customerId) {
      // A pass sold with no name on the order ("Sold at the counter") takes the name of whoever claims it.
      const member = this.memberRow(me);
      this.write(
        `UPDATE passes SET customer_id = ?, holder_name = CASE WHEN holder_name IS NULL OR holder_name = ? THEN COALESCE(?, holder_name) ELSE holder_name END,
           holder_email = COALESCE(holder_email, ?) WHERE id = ? AND customer_id IS NULL`,
        me, SOLD_AT_COUNTER, member?.name || null, member?.email || null, p.id,
      );
    }
    return { pass: this.memberPassView(this.passRow(p.id), now) };
  }

  /**
   * usePass on POST /bookings and POST /events/:id/reserve: the code of a pass linked to the logged-in member, saved on
   * the booking for its check-in. Staff may use any active pass; anyone else's is a 403. Round 7: a member may use the
   * pass of an active group they're in. No awaits.
   */
  passForBooking(code, who, now) {
    const p = this.passByCode(code);
    // Round 9: staff who make bookings, check people in or run passes may use any pass
    const anyPass = this.can(who, ['checkin', 'tables', 'money']);
    if (!p && anyPass) throw new RuleError('No pass with that code. Check it and try again.', 404);
    const mine = Boolean(p && who.customerId && (p.customerId === String(who.customerId) || (p.groupId && this.inActiveGroup(p.groupId, who.customerId))));
    if (!p || (!anyPass && !mine)) throw new RuleError("That pass isn't yours. Ask us at the counter.", 403);
    const status = this.passStatus(p, now);
    if (status === 'void') throw new RuleError('That pass has been cancelled. Ask us at the counter.', 409);
    if (status === 'expired') throw new RuleError('That pass has expired. Ask us at the counter about a new one.', 409);
    if (status === 'used') throw new RuleError('That pass has no sessions left. Book without it, or ask us about a new one.', 409);
    return p;
  }

  /* ---------------- finding a customer, and groups (round 7) ---------------- */
  /**
   * GET /customers?q= (staff): the picker that groups, pass owners, GMs and players all use. Lair members first, matched
   * like GET /members?q= (name, email, member code or customer ID), up to 10; then Shopify's customers not already
   * listed (LairCustomers: Shopify's own search over name and email), up to 20 in all. member: false is someone the
   * Lair hasn't met (no code yet): routes that take their customerId also take the name and email the picker gave, and
   * make their member record. shopify: false when Shopify couldn't be asked (protected customer data not approved, or
   * Shopify down; then it isn't asked again for 10 minutes), so only Lair members show.
   */
  async findCustomers(url, who) {
    // Round 9: the picker every staff form uses (members, passes and groups, GM games, events, the library desk, team)
    this.requireStaff(who, ['members', 'money', 'sessions', 'events', 'library', 'checkin', 'tables', 'community']);
    const q = trimmed(url.searchParams.get('q'), 80);
    if (q.length < 2) throw new RuleError('Type at least 2 letters to search.');
    // Shopify's search gets letters, numbers, spaces and @ . _ - + ' only, in quotes
    const clean = q.replace(/[^\p{L}\p{N}\s@._+'-]/gu, ' ').replace(/\s+/g, ' ').trim();
    let found = null;
    if (this.shopify.configured && Date.now() >= (this.retryAt.get('customers') || 0)) {
      try {
        found = clean ? await this.shopify.searchCustomers(`"${clean}"`) : [];
      } catch (error) {
        found = null;
        this.backoff('customers');
        this.note({ customersError: { message: String(error.message || error).slice(0, 300), at: new Date().toISOString() } });
      }
    }
    // --- no awaits from here on ---
    const customers = this.matchMembers(q, 10).map((row) => this.customerItem(row));
    const listed = new Set(customers.map((c) => c.customerId));
    for (const c of found || []) {
      if (customers.length >= 20) break;
      if (!c.customerId || listed.has(c.customerId)) continue;
      listed.add(c.customerId);
      const row = this.memberRow(c.customerId);
      customers.push(row ? this.customerItem(row) : { customerId: c.customerId, name: c.name, firstName: c.firstName, email: c.email, code: null, member: false });
    }
    return { customers, shopify: found !== null };
  }

  /** Members whose name, email or code has `text` in it, or whose member code or customer ID it is (exact first). No awaits. */
  matchMembers(text, limit) {
    const q = String(text || '').toLowerCase();
    const found = this.findCode(q);
    const exact = found?.type === 'member' ? found.item.customer_id : /^\d{3,20}$/.test(q) ? q : '';
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.sql
      .exec(
        `SELECT * FROM members WHERE customer_id = ? OR lower(name) LIKE ? ESCAPE '\\' OR lower(first_name) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\'
           OR lower(code) LIKE ? ESCAPE '\\' ORDER BY (customer_id = ?) DESC, COALESCE(last_seen, 0) DESC, customer_id LIMIT ?`,
        exact, like, like, like, like, exact, limit,
      )
      .toArray();
  }

  /** A member as the picker lists them */
  customerItem(row) {
    return { customerId: row.customer_id, name: row.name || row.first_name || '', firstName: row.first_name || '', email: row.email || '', code: row.code || null, member: true };
  }

  /**
   * A customer staff picked: { customerId, name?, email? }, from GET /customers. A member is theirs as they are. Someone
   * the Lair hasn't met (member: false in the search) comes with the name and email the picker showed, to make their
   * member record from (makeMember, once every check has passed). A customerId the Lair doesn't know, sent with no
   * name (or one that isn't a Shopify customer ID): a 404 (`missing`). Returns { customerId, row (null until it's
   * made), name, email }. No awaits, no writes.
   */
  pickedCustomer(person, { missing = PICK_AGAIN } = {}) {
    const raw = person && typeof person === 'object' ? person : { customerId: person };
    const customerId = trimmed(raw.customerId, 40);
    const row = customerId ? this.memberRow(customerId) : null;
    if (row) return { customerId: row.customer_id, row, name: row.name || row.first_name || '', email: row.email || '' };
    const name = trimmed(raw.name, 80);
    if (!/^\d{1,20}$/.test(customerId) || !name) throw new RuleError(missing, 404);
    const email = trimmed(raw.email, 120);
    return { customerId, row: null, name, email: isEmail(email) ? email : '' };
  }

  /**
   * The member record of a customer staff picked who the Lair hadn't met (round 7): a member code from their name, and
   * the name and email from the picker. No welcome roll (those are codes now). One already made is left as it is. No
   * awaits. Returns their member row.
   */
  makeMember(picked, now = Date.now()) {
    const existing = this.memberRow(picked.customerId);
    if (existing) return existing;
    const name = trimmed(picked.name, 80) || null;
    this.write(
      `INSERT INTO members (customer_id, name, first_name, email, code, last_seen, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(customer_id) DO NOTHING`,
      String(picked.customerId), name, name ? name.split(/\s+/)[0].slice(0, 40) : null, isEmail(picked.email) ? trimmed(picked.email, 120) : null,
      this.newCode(name || '', 'member', picked.customerId, now), now, now,
    );
    return this.memberRow(picked.customerId);
  }

  groupRow(id) {
    return id ? this.sql.exec('SELECT * FROM lair_groups WHERE id = ?', String(id)).toArray()[0] || null : null;
  }

  /** Whether a customer is in a group that's active (so they can use its passes). No awaits. */
  inActiveGroup(groupId, customerId) {
    return this.sql
      .exec("SELECT 1 AS n FROM lair_group_members m JOIN lair_groups g ON g.id = m.group_id AND g.status = 'active' WHERE m.group_id = ? AND m.customer_id = ?", String(groupId), String(customerId))
      .toArray().length > 0;
  }

  /**
   * A group as staff see it: { id, name, organiser, members: [{ customerId, name, email, code }], note, status, passes:
   * [{ id, code, label, sessionsLeft, sessionsTotal, status }], createdAt, updatedAt }. No awaits.
   */
  groupView(g, now = Date.now()) {
    const members = this.sql
      .exec(
        `SELECT m.customer_id, x.name, x.first_name, x.email, x.code FROM lair_group_members m LEFT JOIN members x ON x.customer_id = m.customer_id
         WHERE m.group_id = ? ORDER BY m.created_at, m.rowid`,
        g.id,
      )
      .toArray()
      .map((r) => ({ customerId: r.customer_id, name: r.name || r.first_name || '', email: r.email || '', code: r.code || null }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    const organiser = g.organiser_id ? members.find((m) => m.customerId === g.organiser_id) || null : null;
    const passes = this.sql.exec('SELECT * FROM passes WHERE group_id = ? ORDER BY created_at DESC, rowid DESC', g.id).toArray()
      .map((r) => this.rowToPass(r))
      .map((p) => ({ id: p.id, code: p.code, label: p.label, sessionsLeft: Math.max(0, p.sessionsTotal - p.sessionsUsed), sessionsTotal: p.sessionsTotal, status: this.passStatus(p, now) }));
    return {
      id: g.id, name: g.name, organiser, members, note: g.note || '', status: g.status, passes, createdAt: g.created_at, updatedAt: g.updated_at || g.created_at,
    };
  }

  /** A group's name from a staff form: 2 to 60 characters, spaces tidied. No awaits. */
  groupName(value) {
    const name = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 60) throw new RuleError('Give the group a name (up to 60 characters).');
    return name;
  }

  /** No two active groups share a name (ignoring case). except: the group being changed. No awaits. */
  checkGroupName(name, except = null) {
    const taken = this.sql.exec("SELECT id, name FROM lair_groups WHERE status = 'active'").toArray()
      .find((g) => g.id !== except && g.name.toLocaleLowerCase('en') === name.toLocaleLowerCase('en'));
    if (taken) throw new RuleError(`There's already a group called ${taken.name}.`, 409);
  }

  /** The customers a staff form sent (people, or customer IDs), checked and without repeats. No awaits, no writes. */
  pickedPeople(list) {
    const out = new Map();
    for (const person of [].concat(list ?? [])) {
      const picked = this.pickedCustomer(person);
      if (!out.has(picked.customerId)) out.set(picked.customerId, picked);
    }
    return [...out.values()];
  }

  /**
   * GET /groups?q=&status=active|archived|all (staff): up to 100, by name. active is the default. q looks in the group's
   * name and its members' names, emails and member codes.
   */
  listGroups(url, who) {
    this.requireStaff(who, 'money');
    const now = Date.now();
    const q = trimmed(url.searchParams.get('q'), 80).toLocaleLowerCase('en');
    const key = codeKey(q);
    const wanted = url.searchParams.get('status');
    const status = ['active', 'archived', 'all'].includes(wanted) ? wanted : 'active';
    let rows = (status === 'all'
      ? this.sql.exec('SELECT * FROM lair_groups').toArray()
      : this.sql.exec('SELECT * FROM lair_groups WHERE status = ?', status).toArray());
    if (q) {
      const hits = new Set(this.sql
        .exec('SELECT m.group_id, x.name, x.first_name, x.email, x.code FROM lair_group_members m JOIN members x ON x.customer_id = m.customer_id')
        .toArray()
        .filter((r) => [r.name, r.first_name, r.email, r.code].some((v) => String(v || '').toLocaleLowerCase('en').includes(q)) || (key.length >= 2 && codeKey(r.code).includes(key)))
        .map((r) => r.group_id));
      rows = rows.filter((g) => g.name.toLocaleLowerCase('en').includes(q) || hits.has(g.id));
    }
    rows.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.created_at - b.created_at);
    return { groups: rows.slice(0, 100).map((g) => this.groupView(g, now)) };
  }

  /**
   * POST /groups { name, organiser?: person, members?: [person], note? } (staff): a group of customers. person is
   * { customerId, name?, email? } from the picker (GET /customers). The organiser is always one of its members.
   * Returns { group }.
   */
  async createGroup(input, who) {
    this.requireStaff(who, 'money');
    // --- no awaits from here on ---
    const now = Date.now();
    const name = this.groupName(input?.name);
    this.checkGroupName(name);
    const organiser = input?.organiser ? this.pickedCustomer(input.organiser) : null;
    const people = this.pickedPeople(input?.members);
    if (organiser && !people.some((p) => p.customerId === organiser.customerId)) people.unshift(organiser);
    if (people.length > GROUP_MAX) throw new RuleError(`A group can have up to ${GROUP_MAX} people.`);
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    for (const p of people) this.makeMember(p, now);
    const id = makeId('gr');
    this.write(
      "INSERT INTO lair_groups (id, name, organiser_id, note, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)",
      id, name, organiser?.customerId || null, trimmed(input?.note, 300) || null, by, now, now,
    );
    for (const p of people) this.write('INSERT OR IGNORE INTO lair_group_members (group_id, customer_id, added_by, created_at) VALUES (?, ?, ?, ?)', id, p.customerId, by, now);
    return { group: this.groupView(this.groupRow(id), now) };
  }

  /**
   * POST /groups/:id/update { name?, organiser?: person (null: none), note?, status?: 'active'|'archived' } (staff). An
   * organiser who isn't in the group yet joins it. Archiving stops its members using its passes (staff can still use
   * them by code at the counter). Returns { group }.
   */
  async updateGroup(id, input, who) {
    this.requireStaff(who, 'money');
    // --- no awaits from here on ---
    const now = Date.now();
    const group = this.groupRow(id);
    if (!group) throw new RuleError('That group could not be found.', 404);
    const has = (k) => Object.prototype.hasOwnProperty.call(input || {}, k);
    if (has('status') && !['active', 'archived'].includes(input.status)) throw new RuleError('A group is active or archived.');
    const status = has('status') ? input.status : group.status;
    const name = has('name') ? this.groupName(input.name) : group.name;
    if (status === 'active') this.checkGroupName(name, group.id);
    const organiser = has('organiser') && input.organiser ? this.pickedCustomer(input.organiser) : null;
    const joining = organiser && !this.sql.exec('SELECT 1 AS n FROM lair_group_members WHERE group_id = ? AND customer_id = ?', group.id, organiser.customerId).toArray().length;
    if (joining && this.groupSize(group.id) + 1 > GROUP_MAX) throw new RuleError(`A group can have up to ${GROUP_MAX} people.`);
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    if (organiser) this.makeMember(organiser, now);
    if (joining) this.write('INSERT OR IGNORE INTO lair_group_members (group_id, customer_id, added_by, created_at) VALUES (?, ?, ?, ?)', group.id, organiser.customerId, by, now);
    this.write(
      'UPDATE lair_groups SET name = ?, organiser_id = ?, note = ?, status = ?, updated_at = ? WHERE id = ?',
      name, has('organiser') ? organiser?.customerId || null : group.organiser_id, has('note') ? trimmed(input.note, 300) || null : group.note, status, now, group.id,
    );
    return { group: this.groupView(this.groupRow(group.id), now) };
  }

  groupSize(groupId) {
    return this.sql.exec('SELECT COUNT(*) AS n FROM lair_group_members WHERE group_id = ?', String(groupId)).one().n;
  }

  /**
   * POST /groups/:id/members { add?: [person], remove?: [customerId] } (staff). Someone removed stops using the group's
   * passes. The organiser can't be removed until there's a new one. Returns { group }.
   */
  async groupMembers(id, input, who) {
    this.requireStaff(who, 'money');
    // --- no awaits from here on ---
    const now = Date.now();
    const group = this.groupRow(id);
    if (!group) throw new RuleError('That group could not be found.', 404);
    const remove = [...new Set([].concat(input?.remove ?? []).map((x) => trimmed(x && typeof x === 'object' ? x.customerId : x, 40)).filter(Boolean))];
    if (group.organiser_id && remove.includes(group.organiser_id)) throw new RuleError("That's the organiser. Pick a new organiser first.", 409);
    const add = this.pickedPeople(input?.add);
    const current = new Set(this.sql.exec('SELECT customer_id FROM lair_group_members WHERE group_id = ?', group.id).toArray().map((r) => r.customer_id));
    const joining = add.filter((p) => !current.has(p.customerId));
    const leaving = remove.filter((c) => current.has(c) && !joining.some((p) => p.customerId === c));
    if (current.size + joining.length - leaving.length > GROUP_MAX) throw new RuleError(`A group can have up to ${GROUP_MAX} people.`);
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    for (const p of joining) {
      this.makeMember(p, now);
      this.write('INSERT OR IGNORE INTO lair_group_members (group_id, customer_id, added_by, created_at) VALUES (?, ?, ?, ?)', group.id, p.customerId, by, now);
    }
    for (const c of leaving) this.write('DELETE FROM lair_group_members WHERE group_id = ? AND customer_id = ?', group.id, c);
    if (joining.length || leaving.length) this.write('UPDATE lair_groups SET updated_at = ? WHERE id = ?', now, group.id);
    return { group: this.groupView(this.groupRow(group.id), now) };
  }

  /**
   * One person's part of a booking a pass can cover: the table fee (tables and walk-ins pay the room price), a GM
   * seat's table part (its price less the game's GM fee, which is still paid), or a game spot's price a person.
   */
  coverablePerPerson(b, rules) {
    const unit = Math.round((b.amount || 0) / Math.max(1, b.people || 1));
    if (b.kind !== 'gm-seat') return unit;
    const game = b.gameId ? this.game(b.gameId) : null;
    return Math.max(0, unit - (game?.gmFee ?? rules.prices.gmCredit));
  }

  /**
   * A pass at check-in. choice: a pass code, 'none', or left out for the booking's saved pass. One session covers one
   * person's coverable part up to the pass's cover; sessions used = the people not covered or paid yet, up to the
   * sessions left. Nothing already paid is covered, and a void or expired pass is skipped with a notice. Returns
   * { pass: { code, label, used, left, covered, useId } | null, notice }. No awaits.
   */
  usePassAtCheckIn(booking, choice, rules, now, by = null) {
    if (choice === 'none') return { pass: null, notice: null };
    const explicit = typeof choice === 'string' && choice.trim() !== '';
    const p = explicit ? this.passByCode(choice) : this.passRow(booking.passId);
    if (!p) return { pass: null, notice: explicit ? 'No pass with that code, so no pass was used. Check the code and try again.' : null };
    if (booking.kind === 'gm') return { pass: null, notice: explicit ? "The GM's own table has nothing to pay, so no pass was used." : null };
    if (dueOf(booking) <= 0) {
      return { pass: null, notice: explicit ? `${booking.paid ? 'This booking is already paid' : 'Nothing is left to pay on this booking'}, so no pass was used.` : null };
    }
    const status = this.passStatus(p, now);
    if (status === 'void') return { pass: null, notice: `Pass ${p.code} is void, so it wasn't used.` };
    if (status === 'expired') {
      const day = new Intl.DateTimeFormat('en-NZ', { timeZone: rules.tz, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(p.expiresAt));
      return { pass: null, notice: `Pass ${p.code} expired on ${day}, so it wasn't used.` };
    }
    const left = Math.max(0, p.sessionsTotal - p.sessionsUsed);
    const owed = owing(booking);
    const unit = Math.max(1, Math.round((booking.amount || 0) / Math.max(1, booking.people || 1)));
    const coveredPeople = this.sql.exec('SELECT COALESCE(SUM(people), 0) AS n FROM pass_uses WHERE booking_id = ? AND undone_at IS NULL', booking.id).one().n;
    const unpaid = Math.min(Math.max(0, (booking.people || 1) - coveredPeople), Math.ceil(owed / unit));
    if (unpaid <= 0) return { pass: null, notice: null };
    if (!left) return { pass: null, notice: `Pass ${p.code} has no sessions left, so it wasn't used.` };
    const per = Math.min(p.cover, this.coverablePerPerson(booking, rules));
    if (per <= 0) return { pass: null, notice: explicit ? "There's no table fee on this booking for a pass to cover, so no pass was used." : null };
    const sessions = Math.min(unpaid, left);
    const covered = Math.min(sessions * per, owed);
    const useId = makeId('pu');
    this.write('INSERT INTO pass_uses (id, pass_id, booking_id, people, covered, at, by, undone_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)', useId, p.id, booking.id, sessions, covered, now, by);
    this.write('UPDATE passes SET sessions_used = sessions_used + ? WHERE id = ?', sessions, p.id);
    const next = { ...booking, covered: (booking.covered || 0) + covered };
    this.write('UPDATE bookings SET covered = ?, pass_id = ?, paid = ?, updated_at = ? WHERE id = ?', next.covered, explicit ? p.id : booking.passId, settled(next) ? 1 : 0, now, booking.id);
    const notice = sessions < unpaid ? `Pass ${p.code} had ${plural(left, 'session', 'sessions')} left, so it covered ${sessions} of ${plural(unpaid, 'person', 'people')}.` : null;
    return { pass: { code: p.code, label: p.label, used: sessions, left: left - sessions, covered, useId }, notice };
  }

  /* ---------------- library holds (round 6): reserving a board game ---------------- */
  rowToHold(r) {
    return {
      id: r.id, variantId: r.variant_id, productId: r.product_id || null, title: r.title, shelfCode: r.shelf_code || '', handle: r.handle || '',
      copies: r.copies || null, customerId: r.customer_id, status: r.status, until: r.until, staffNote: r.staff_note || '', createdAt: r.created_at,
      endedAt: r.ended_at || null, image: r.image || null,
    };
  }

  holdRow(id) {
    const row = id ? this.sql.exec('SELECT * FROM library_holds WHERE id = ?', String(id)).toArray()[0] : null;
    return row ? this.rowToHold(row) : null;
  }

  /** A hold's status now: one past its time that maintenance hasn't caught yet has expired all the same */
  holdStatus(h, now = Date.now()) {
    return h.status === 'held' && h.until <= now ? 'expired' : h.status;
  }

  /**
   * A hold as its member sees it: { id, variantId, productId, title, shelfCode, handle, until, status, createdAt,
   * endedAt, image }. image (round 7): the game's picture (the one the page sent, else the one the Lair knows), or null.
   */
  holdView(h, now = Date.now()) {
    const status = this.holdStatus(h, now);
    return {
      id: h.id, variantId: h.variantId, productId: h.productId, title: h.title, shelfCode: h.shelfCode, handle: h.handle, until: h.until, status,
      createdAt: h.createdAt, endedAt: h.endedAt || (status === 'expired' ? h.until : null), image: h.image || this.libraryGame(h.variantId)?.image || null,
    };
  }

  /**
   * A hold as staff see it: the member's view plus customerId, name, email, code (their member code) and staffNote, and
   * (round 7) loanId on a collected one
   */
  staffHoldView(h, now = Date.now(), memo = null) {
    let m = memo?.get(h.customerId);
    if (m === undefined) {
      m = this.memberRow(h.customerId);
      memo?.set(h.customerId, m);
    }
    const loan = h.status === 'collected' ? this.sql.exec('SELECT id FROM library_loans WHERE hold_id = ?', h.id).toArray()[0] : null;
    return {
      ...this.holdView(h, now), customerId: h.customerId, name: m?.name || m?.first_name || '', email: m?.email || '', code: m?.code || null, staffNote: h.staffNote,
      ...(h.status === 'collected' ? { loanId: loan?.id || null } : {}),
    };
  }

  /** A member's active holds, soonest end first. No awaits. */
  activeHolds(customerId, now = Date.now()) {
    return this.sql
      .exec("SELECT * FROM library_holds WHERE customer_id = ? AND status = 'held' AND until > ? ORDER BY until, created_at", String(customerId), now)
      .toArray().map((r) => this.rowToHold(r));
  }

  /** GET /me holds: their active holds, soonest first, then any that ended in the last 3 days (so My Lair can say so). No awaits. */
  memberHolds(customerId, now = Date.now()) {
    const since = now - 3 * 24 * HOUR;
    const ended = this.sql
      .exec(
        `SELECT * FROM library_holds WHERE customer_id = ? AND ((status = 'held' AND until <= ? AND until > ?) OR (status != 'held' AND COALESCE(ended_at, updated_at, created_at) > ?))
         ORDER BY COALESCE(ended_at, until) DESC, created_at DESC`,
        String(customerId), now, since, since,
      )
      .toArray().map((r) => this.rowToHold(r));
    return [...this.activeHolds(customerId, now), ...ended].map((h) => this.holdView(h, now));
  }

  /**
   * Round 7: a hold that ends exactly at midnight (Lair time) ends with the day before: "midnight on Thursday 8 October"
   * is 00:00 on Friday. Returns the moment to name the day by and whether it's midnight.
   */
  holdEnd(ms, tz) {
    const { h, mi } = lairTime(tz).parts(ms);
    return h === 0 && mi === 0 ? { day: ms - 1, midnight: true } : { day: ms, midnight: false };
  }

  /** "midnight on Thursday 8 October" (round 7), or "Thursday 8 October, 12pm" (holds from before): when a hold ends, in emails */
  holdWhen(ms, rules = this.rulesCache) {
    const tz = rules?.tz || 'Pacific/Auckland';
    const end = this.holdEnd(ms, tz);
    const day = new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(end.day)).replace(',', '');
    return end.midnight ? `midnight on ${day}` : `${day}, ${this.clockWord(ms, tz)}`;
  }

  /** "midnight, Thu 8 Oct" (round 7), or "Thu 8 Oct, 12pm": when a hold ends, as the library page shows it (for messages on the page) */
  holdDate(ms, rules = this.rulesCache) {
    const tz = rules?.tz || 'Pacific/Auckland';
    const end = this.holdEnd(ms, tz);
    const day = new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(end.day)).replace(',', '');
    return end.midnight ? `midnight, ${day}` : `${day}, ${this.clockWord(ms, tz)}`;
  }

  /** "midnight Thu" (round 7), or "Thu 12pm": the weekday and time a hold ends */
  holdDay(ms, rules = this.rulesCache) {
    const tz = rules?.tz || 'Pacific/Auckland';
    const end = this.holdEnd(ms, tz);
    const day = new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'short' }).format(new Date(end.day));
    return end.midnight ? `midnight ${day}` : `${day} ${this.clockWord(ms, tz)}`;
  }

  /** "12pm", "4:30pm": a time of day in Lair time, the way Mo says it */
  clockWord(ms, tz) {
    const { h, mi } = lairTime(tz).parts(ms);
    return `${h % 12 || 12}${mi ? `:${String(mi).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
  }

  /**
   * How many copies of each library game there are: the variant's inventory quantity in Shopify (read_products and
   * read_inventory, which Mo approves once in Shopify admin), kept for 10 minutes. A variant Shopify doesn't track or
   * shows with none, and any failed lookup (the scopes not approved yet, say: then Shopify isn't asked again for 10
   * minutes), is unknown (null), and the caller falls back to the copies the page sent, then 1. One Shopify call for
   * every variant not already known. Never throws. Returns a Map of variant ID → copies | null.
   */
  async shopifyCopies(variantIds) {
    const now = Date.now();
    const out = new Map();
    const ask = [];
    for (const id of variantIds) {
      const hit = this.copiesCache.get(id);
      if (hit && now - hit.at < COPIES_TTL) out.set(id, hit.copies);
      else ask.push(id);
    }
    if (ask.length && this.shopify.configured && now >= (this.retryAt.get('copies') || 0)) {
      try {
        const found = await this.shopify.variantCopies(ask);
        if (this.copiesCache.size > 2000) this.copiesCache.clear();
        for (const id of ask) {
          const v = found.get(id);
          const copies = v && v.tracked && v.quantity >= 1 ? Math.min(v.quantity, 99) : null;
          this.copiesCache.set(id, { at: Date.now(), copies });
          out.set(id, copies);
        }
      } catch (error) {
        this.backoff('copies');
        this.note({ copiesError: { message: String(error.message || error).slice(0, 300), at: new Date().toISOString() } });
      }
    }
    for (const id of ask) if (!out.has(id)) out.set(id, null);
    return out;
  }

  /** The copies a library page last sent for a variant (kept with its holds), or null. No awaits. */
  pageCopies(variantId) {
    return this.sql.exec('SELECT copies FROM library_holds WHERE variant_id = ? AND copies IS NOT NULL ORDER BY created_at DESC LIMIT 1', String(variantId)).toArray()[0]?.copies ?? null;
  }

  /** Each variant's active holds (anyone's), soonest end first, by variant ID. No awaits. */
  heldByVariant(variantIds, now) {
    const ids = [...new Set(variantIds.map(String))];
    const out = new Map(ids.map((id) => [id, []]));
    if (!ids.length) return out;
    const rows = this.sql
      .exec(`SELECT * FROM library_holds WHERE status = 'held' AND until > ? AND variant_id IN (${ids.map(() => '?').join(', ')}) ORDER BY until, created_at`, now, ...ids)
      .toArray();
    for (const r of rows) out.get(r.variant_id)?.push(this.rowToHold(r));
    return out;
  }

  /** A variant ID from the page: digits, or the variant's gid. '' when it isn't one. */
  variantIdOf(value) {
    const id = String(value ?? '').trim().replace(/^gid:\/\/shopify\/ProductVariant\//, '');
    return /^\d{1,20}$/.test(id) ? id : '';
  }

  /** Round 7: each variant's loans still out (games at home with members), longest out first, by variant ID. No awaits. */
  outByVariant(variantIds) {
    const ids = [...new Set(variantIds.map(String))];
    const out = new Map(ids.map((id) => [id, []]));
    if (!ids.length) return out;
    const rows = this.sql
      .exec(`SELECT * FROM library_loans WHERE status = 'out' AND variant_id IN (${ids.map(() => '?').join(', ')}) ORDER BY out_at, created_at`, ...ids)
      .toArray();
    for (const r of rows) out.get(r.variant_id)?.push(this.rowToLoan(r));
    return out;
  }

  /**
   * GET /library/status?ids=<variantId>,… (anyone; at most 60): each game's { copies, held, out, available, nextFree,
   * mine, atHome }. copies: Shopify's (shopifyCopies), else the copies a page last sent with a hold, else 1. out (round
   * 7): copies at home with members. available = copies less active holds and copies out, never below 0. nextFree:
   * when none is available and something's held, the soonest an active hold ends (ms), else null. mine: { id, until }
   * when the logged-in member holds a copy; atHome: { id, outAt } when they have one at home; else null.
   */
  async libraryStatus(url, who) {
    const ids = [...new Set(String(url.searchParams.get('ids') || '').split(',').map((x) => this.variantIdOf(x)).filter(Boolean))];
    if (ids.length > STATUS_IDS) throw new RuleError(`Ask about up to ${STATUS_IDS} games at a time.`);
    const fromShopify = await this.shopifyCopies(ids);
    // --- no awaits from here on ---
    const now = Date.now();
    const held = this.heldByVariant(ids, now);
    const loans = this.outByVariant(ids);
    const games = {};
    for (const id of ids) {
      const holds = held.get(id) || [];
      const out = loans.get(id) || [];
      const copies = fromShopify.get(id) ?? this.pageCopies(id) ?? 1;
      const available = Math.max(0, copies - holds.length - out.length);
      const mine = who.customerId ? holds.find((h) => h.customerId === String(who.customerId)) : null;
      const home = who.customerId ? out.find((l) => l.customerId === String(who.customerId)) : null;
      games[id] = {
        copies, held: holds.length, out: out.length, available, nextFree: !available && holds.length ? holds[0].until : null,
        mine: mine ? { id: mine.id, until: mine.until } : null, atHome: home ? { id: home.id, outAt: home.outAt } : null,
      };
    }
    return { games };
  }

  /**
   * POST /library/holds { variantId, productId, title, shelfCode, handle, copies?, image? } (a library member): reserve a
   * game until midnight on the third day, the day it's made counting as the first (holdUntil). Their plan (from their
   * Shopify tags) says how many games they can have at once: holds plus games at home (round 7). Staff may add
   * customerId to reserve for someone, with no plan limit. Copies: shopifyCopies, else the page's (1-10), else 1; the
   * copies reserved and at home aren't free. image (round 7): the game's picture from the page (a Shopify CDN address,
   * else null). The game becomes one the Lair knows (library_games, and its shelf code in library_codes). The staff and
   * the member are emailed. Returns { hold, holds } (holds: that member's active holds).
   */
  async createHold(input, who) {
    if (!who.customerId) throw new RuleError('Log in to reserve a game.', 401);
    const rules = await this.rules();
    const variantId = this.variantIdOf(input?.variantId);
    if (!variantId) throw new RuleError('Pick a game from the library to reserve.');
    const title = trimmed(input?.title, 120);
    if (!title) throw new RuleError('Pick a game from the library to reserve.');
    // Round 9: reserving for someone else is the library's staff side
    if (who.staff && String(input?.customerId ?? '').trim()) this.requireStaff(who, 'library');
    const forSomeone = Boolean(who.staff && String(input?.customerId ?? '').trim());
    const plan = forSomeone ? null : libraryPlan(who.tags);
    if (!forSomeone && !plan) throw new RuleError('Join the library to reserve games.', 403);
    const sent = Number(input?.copies);
    const fromPage = Number.isInteger(sent) && sent >= 1 && sent <= 10 ? sent : null;
    const fromShopify = (await this.shopifyCopies([variantId])).get(variantId);
    // --- no awaits from here on: read, check and save the hold together, so two people can't take the last copy ---
    const now = Date.now();
    const customerId = forSomeone ? trimmed(input.customerId, 40) : String(who.customerId);
    const member = this.memberRow(customerId);
    if (forSomeone && !member) throw new RuleError('No member with that customer ID.', 404);
    const theirs = this.activeHolds(customerId, now);
    const same = theirs.find((h) => h.variantId === variantId);
    if (same) {
      const named = forSomeone ? member.name || member.first_name : '';
      throw new RuleError(forSomeone
        ? `${named ? `${named} already has` : 'They already have'} this one on hold, until ${this.holdDate(same.until, rules)}.`
        : `You've already reserved this one, friend. It's held until ${this.holdDate(same.until, rules)}.`, 409);
    }
    // Round 7: a plan's limit counts holds and games at home
    const home = this.loansOut(customerId);
    if (plan && theirs.length + home.length >= plan.games) throw new RuleError(this.planFull(plan, theirs.length, home.length), 409);
    const copies = fromShopify ?? fromPage ?? this.pageCopies(variantId) ?? 1;
    const holding = this.heldByVariant([variantId], now).get(variantId) || [];
    const out = this.outByVariant([variantId]).get(variantId) || [];
    if (holding.length + out.length >= copies) {
      throw new RuleError(holding.length
        ? `Every copy is reserved or out on loan right now. It's back on the shelf by ${this.holdDay(holding[0].until, rules)} if nobody collects it.`
        : 'Every copy is out on loan right now. Check back soon, friend.', 409);
    }
    const handle = trimmed(input?.handle, 120);
    const productId = String(input?.productId ?? '').trim().replace(/^gid:\/\/shopify\/Product\//, '');
    const hold = {
      id: makeId('lh'), variantId, productId: /^\d{1,20}$/.test(productId) ? productId : null, title, shelfCode: trimmed(input?.shelfCode, 20).toUpperCase(),
      handle: /^[a-z0-9][a-z0-9-]*$/i.test(handle) ? handle.toLowerCase() : '', copies: fromPage, customerId, status: 'held',
      until: holdUntil(new LairTime(rules.tz), now), createdAt: now, image: this.shopImage(input?.image),
    };
    this.write(
      `INSERT INTO library_holds (id, variant_id, product_id, title, shelf_code, handle, copies, customer_id, status, until, staff_note, created_by, created_at, updated_at, ended_at, image)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, NULL, ?, ?, ?, NULL, ?)`,
      hold.id, variantId, hold.productId, title, hold.shelfCode || null, hold.handle || null, fromPage, customerId, hold.until,
      forSomeone ? `staff:${who.customerId}` : 'member', now, now, hold.image,
    );
    // Round 7: the Lair knows this game now, so a scan of its label finds it without asking Shopify
    this.saveLibraryGame({ variantId, productId: hold.productId, title, handle: hold.handle, shelfCode: hold.shelfCode, image: hold.image }, now);
    if (!forSomeone) this.touchMember(customerId, {}, now);
    // --- saved: the copy is theirs until then ---
    this.tellHold(this.holdRow(hold.id), this.memberRow(customerId), rules);
    return { hold: this.holdView(this.holdRow(hold.id), now), holds: this.activeHolds(customerId, now).map((h) => this.holdView(h, now)) };
  }

  /**
   * A new hold's emails: the staff ("Hold this game: <title> (<shelf code>) for <name>, until <when>", with the member's
   * code and email) and the member ("<title> is on hold for you until <when>. …"). No awaits.
   */
  tellHold(hold, member, rules) {
    if (!emailReady(this.env)) return;
    const when = this.holdWhen(hold.until, rules);
    const name = member?.name || member?.first_name || member?.code || 'a member';
    const game = `${hold.title}${hold.shelfCode ? ` (${hold.shelfCode})` : ''}`;
    this.notifyStaff(`Hold this game: ${game} for ${name}, until ${when}`, {
      title: 'A library game to hold',
      intro: `Hold this game: ${game} for ${name}, until ${when}. Pop it behind the counter; if they don't collect it by then, it goes back on the shelf by itself.`,
      details: [['Game', hold.title], ['Shelf', hold.shelfCode], ['For', name], ['Member code', member?.code || ''], ['Email', member?.email || ''], ['Until', when]],
    });
    if (!isEmail(member?.email)) return;
    const first = member.first_name || String(member.name || '').split(/\s+/)[0] || 'friend';
    this.later(this.mail(this.letter(member.email, `${hold.title} is on hold for you`, {
      title: "It's on hold for you!",
      intro: [`Kia ora ${first}!`, `${hold.title} is on hold for you until ${when}. Collect it at the counter with your member code.`],
      details: [['Game', hold.title], ['Shelf', hold.shelfCode], ['Held until', when], ['Your member code', member.code || '']],
      outro: "Changed your mind? Cancel the hold in My Lair, so someone else can grab it. If it's not collected by then, it goes back on the shelf.",
      // round 7: straight to My Library
      button: { label: 'See it in My Lair', url: `${this.page('myLair')}?view=library` },
    })));
  }

  /** POST /library/holds/:id/cancel (the member it's for, or staff): it's cancelled and goes back on the shelf. Returns { hold, holds }. */
  async cancelHold(id, who) {
    if (!who.customerId) throw new RuleError('Log in to manage your holds.', 401);
    await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const hold = this.holdRow(id);
    if (!hold) throw new RuleError('That hold could not be found.', 404);
    // Round 9: staff here means the library
    const staffLibrary = this.can(who, 'library');
    if (!staffLibrary && hold.customerId !== String(who.customerId)) throw new RuleError("That hold isn't yours to cancel.", 403);
    const status = this.holdStatus(hold, now);
    if (status === 'held') {
      this.write("UPDATE library_holds SET status = 'cancelled', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'held'", now, now, hold.id);
    } else if (status !== 'cancelled') {
      throw new RuleError(status === 'collected' ? "That game's been collected already." : 'That hold has already ended.', 409);
    }
    const fresh = this.holdRow(hold.id);
    const memo = new Map();
    const view = (h) => (staffLibrary ? this.staffHoldView(h, now, memo) : this.holdView(h, now));
    return { hold: view(fresh), holds: this.activeHolds(fresh.customerId, now).map(view) };
  }

  /**
   * GET /library/holds?status=active|all (staff): { holds } as staff see them. active: the holds still on, soonest end
   * first; all: the last 200, newest first.
   */
  async listHolds(url, who) {
    this.requireStaff(who, 'library');
    await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const rows = url.searchParams.get('status') === 'all'
      ? this.sql.exec('SELECT * FROM library_holds ORDER BY created_at DESC, rowid DESC LIMIT 200').toArray()
      : this.sql.exec("SELECT * FROM library_holds WHERE status = 'held' AND until > ? ORDER BY until, created_at", now).toArray();
    const memo = new Map();
    return { holds: rows.map((r) => this.staffHoldView(this.rowToHold(r), now, memo)) };
  }

  /**
   * POST /library/holds/:id/update { status: 'collected'|'released'|'held', note? } (staff): handed over, put back on the
   * shelf early, or held again (a hold released or expired by mistake), with a fresh until. note: the staff note.
   * Round 7: collected makes the game's loan (it's at home with them) in the same write; held again takes back a loan
   * that's still out (it never went home). Returns { hold, loan } (loan: the collected hold's, as staff see it, or null).
   */
  async updateHold(id, input, who) {
    this.requireStaff(who, 'library');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const hold = this.holdRow(id);
    if (!hold) throw new RuleError('That hold could not be found.', 404);
    const status = input?.status;
    if (status != null && !['collected', 'released', 'held'].includes(status)) throw new RuleError('A hold can be marked collected, released or held again.');
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    if (status === 'held') {
      this.write("UPDATE library_holds SET status = 'held', until = ?, ended_at = NULL, updated_at = ? WHERE id = ?", holdUntil(new LairTime(rules.tz), now), now, hold.id);
      this.write("DELETE FROM library_loans WHERE hold_id = ? AND status = 'out'", hold.id);
    } else if (status === 'collected') {
      this.collectHold(hold, now, by);
    } else if (status) {
      this.write('UPDATE library_holds SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?', status, now, now, hold.id);
    }
    if (input?.note != null) this.write('UPDATE library_holds SET staff_note = ?, updated_at = ? WHERE id = ?', trimmed(input.note, 300) || null, now, hold.id);
    const fresh = this.holdRow(hold.id);
    const loan = fresh.status === 'collected' ? this.sql.exec('SELECT * FROM library_loans WHERE hold_id = ?', hold.id).toArray()[0] : null;
    return { hold: this.staffHoldView(fresh, now), loan: loan ? this.staffLoanView(this.rowToLoan(loan), now) : null };
  }

  /**
   * Round 7: a hold handed over: it's 'collected' and the game is at home with them, a loan linked to the hold (made
   * once: the hold's loan is unique). Staff's own collected time stays when it's marked collected again. No awaits.
   */
  collectHold(hold, now, by) {
    if (hold.status !== 'collected') this.write("UPDATE library_holds SET status = 'collected', ended_at = ?, updated_at = ? WHERE id = ?", now, now, hold.id);
    const game = this.libraryGame(hold.variantId);
    this.write(
      `INSERT OR IGNORE INTO library_loans (id, variant_id, product_id, title, shelf_code, handle, image, customer_id, hold_id, status, out_at, returned_at,
         out_by, returned_by, staff_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'out', ?, NULL, ?, NULL, NULL, ?, ?)`,
      makeId('ln'), hold.variantId, hold.productId || game?.product_id || null, hold.title, hold.shelfCode || game?.shelf_code || null, hold.handle || game?.handle || null,
      hold.image || game?.image || null, hold.customerId, hold.id, now, by, now, now,
    );
    return this.rowToLoan(this.sql.exec('SELECT * FROM library_loans WHERE hold_id = ?', hold.id).one());
  }

  /**
   * Maintenance: holds still 'held' past their time weren't collected, so they're 'expired' and back on the shelf, and
   * each member gets an email. Each hold expires once (its status is checked as it changes). No awaits. Returns how
   * many expired.
   */
  expireLibraryHolds(rules, now) {
    const due = this.sql.exec("SELECT * FROM library_holds WHERE status = 'held' AND until <= ?", now).toArray().map((r) => this.rowToHold(r));
    const letters = [];
    for (const hold of due) {
      this.write("UPDATE library_holds SET status = 'expired', ended_at = until, updated_at = ? WHERE id = ? AND status = 'held'", now, hold.id);
      const member = this.memberRow(hold.customerId);
      if (!isEmail(member?.email)) continue;
      const first = member.first_name || String(member.name || '').split(/\s+/)[0] || 'friend';
      letters.push(this.letter(member.email, `Your hold on ${hold.title} ended`, {
        title: 'Your hold ended',
        intro: [`Kia ora ${first}!`, `Your hold on ${hold.title} ended, so it's back on the shelf. Reserve it again any time.`],
        button: { label: 'Reserve it again', url: hold.handle ? this.link(`/products/${hold.handle}`) : this.page('myLair') },
      }));
    }
    if (letters.length && emailReady(this.env)) this.later(this.mailMany(letters));
    return due.length;
  }

  /* ---------------- library loans and scanning (round 7): games at home ---------------- */
  rowToLoan(r) {
    return {
      id: r.id, variantId: r.variant_id, productId: r.product_id || null, title: r.title, shelfCode: r.shelf_code || '', handle: r.handle || '',
      image: r.image || null, status: r.status, outAt: r.out_at, returnedAt: r.returned_at || null, holdId: r.hold_id || null,
      customerId: r.customer_id, staffNote: r.staff_note || '',
    };
  }

  loanRow(id) {
    const row = id ? this.sql.exec('SELECT * FROM library_loans WHERE id = ?', String(id)).toArray()[0] : null;
    return row ? this.rowToLoan(row) : null;
  }

  /**
   * A game at home as its member sees it: { id, variantId, productId, title, shelfCode, handle, image, status: 'out' |
   * 'returned', outAt, returnedAt, holdId }. image: the loan's picture, else the one the Lair knows for the game.
   */
  loanView(l) {
    return {
      id: l.id, variantId: l.variantId, productId: l.productId, title: l.title, shelfCode: l.shelfCode, handle: l.handle,
      image: l.image || this.libraryGame(l.variantId)?.image || null, status: l.status, outAt: l.outAt, returnedAt: l.returnedAt, holdId: l.holdId,
    };
  }

  /** A loan as staff see it: the member's view plus customerId, name, email, code (member code), days (whole Lair days at home) and staffNote */
  staffLoanView(l, now = Date.now(), memo = null) {
    let m = memo?.get(l.customerId);
    if (m === undefined) {
      m = this.memberRow(l.customerId);
      memo?.set(l.customerId, m);
    }
    const time = lairTime(this.rulesCache?.tz);
    return {
      ...this.loanView(l), customerId: l.customerId, name: m?.name || m?.first_name || '', email: m?.email || '', code: m?.code || null,
      days: Math.max(0, time.daysBetween(time.key(l.outAt), time.key(l.returnedAt || now))), staffNote: l.staffNote,
    };
  }

  /** A member's games at home, longest out first. No awaits. */
  loansOut(customerId) {
    return this.sql.exec("SELECT * FROM library_loans WHERE customer_id = ? AND status = 'out' ORDER BY out_at, created_at", String(customerId)).toArray().map((r) => this.rowToLoan(r));
  }

  /** A library game the Lair knows (library_games), or null */
  libraryGame(variantId) {
    return variantId ? this.sql.exec('SELECT * FROM library_games WHERE variant_id = ?', String(variantId)).toArray()[0] || null : null;
  }

  /**
   * Remember a library game (its title without " (Library)", handle, product, shelf code and picture) and the codes that
   * find it: its shelf code, plus any SKU and barcode Shopify gave. What's known already stays unless there's something
   * new. No awaits.
   */
  saveLibraryGame(game, now = Date.now(), codes = []) {
    const title = String(game.title || '').replace(/\s*\(library\)\s*$/i, '').trim().slice(0, 120) || 'A library game';
    this.write(
      `INSERT INTO library_games (variant_id, product_id, title, handle, shelf_code, image, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(variant_id) DO UPDATE SET product_id = COALESCE(excluded.product_id, library_games.product_id), title = excluded.title,
         handle = COALESCE(excluded.handle, library_games.handle), shelf_code = COALESCE(excluded.shelf_code, library_games.shelf_code),
         image = COALESCE(excluded.image, library_games.image), checked_at = excluded.checked_at`,
      String(game.variantId), game.productId || null, title, game.handle || null, game.shelfCode || null, game.image || null, now,
    );
    for (const code of [game.shelfCode, ...codes]) {
      const key = codeKey(code);
      if (key) this.write('INSERT OR REPLACE INTO library_codes (key, variant_id) VALUES (?, ?)', key, String(game.variantId));
    }
  }

  /**
   * A game's picture from a page or Shopify, kept only when it's a Shopify CDN address (cdn.shopify.com, or the store's
   * own /cdn/shop/ path, which Liquid's image_url gives), up to 500 characters; a // address is kept as https:. Anything
   * else is null.
   */
  shopImage(value) {
    let text = String(value ?? '').trim();
    if (!text || text.length > 500) return null;
    if (text.startsWith('//')) text = `https:${text}`;
    let url;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    const shop = String(this.env.SHOP || '').toLowerCase();
    const store = /(^|\.)dicegoblin\.nz$/.test(host) || host.endsWith('.myshopify.com') || (shop && host === shop);
    return host === 'cdn.shopify.com' || (store && url.pathname.startsWith('/cdn/shop/')) ? url.toString() : null;
  }

  /** "Your plan has 3 games at a time, and you've got 3: 2 reserved and 1 at home. Return one or cancel a hold first." */
  planFull(plan, holds, home) {
    const parts = [holds ? `${holds} reserved` : '', home ? `${home} at home` : ''].filter(Boolean).join(' and ');
    return `Your plan has ${plural(plan.games, 'game', 'games')} at a time, and you've got ${holds + home}${parts ? `: ${parts}` : ''}. Return one or cancel a hold first.`;
  }

  /**
   * GET /me's library (round 7): { plan: { name, games } | null (from their Shopify tags), used (active holds + games at
   * home), holds (active, soonest until first), atHome (out, longest at home first) }. No awaits.
   */
  libraryFor(customerId, tags, now = Date.now()) {
    const plan = libraryPlan(tags);
    const holds = this.activeHolds(customerId, now);
    const atHome = this.loansOut(customerId);
    return { plan: plan ? { name: plan.name, games: plan.games } : null, used: holds.length + atHome.length, holds: holds.map((h) => this.holdView(h, now)), atHome: atHome.map((l) => this.loanView(l)) };
  }

  /** A scanned or typed code, cleaned: trimmed, 1 to 40 letters, numbers and . _ - +. Anything else is a 422 with `message`. */
  scanCode(value, message) {
    const code = String(value ?? '').trim();
    if (!SCAN_CODE.test(code)) throw new RuleError(message);
    return code;
  }

  /**
   * Which product variant a barcode or SKU is, from Shopify (LairVariantByCode): the one whose barcode, then SKU, equals
   * the code (ignoring case), or null. Answers (a miss too) are kept 10 minutes. If Shopify refuses (read_products not
   * approved yet) or is down, it isn't asked again for 10 minutes and this throws a 503 with `down`.
   */
  async variantForCode(code, down) {
    const key = codeKey(code);
    const now = Date.now();
    this.codeLookups = this.codeLookups || new Map();
    const hit = this.codeLookups.get(key);
    if (hit && now - hit.at < LOOKUP_TTL) return hit.variant;
    if (!this.shopify.configured || now < (this.retryAt.get('variant-code') || 0)) throw new RuleError(down, 503);
    let found;
    try {
      found = await this.shopify.variantByCode(code);
    } catch (error) {
      this.backoff('variant-code');
      this.note({ variantCodeError: { message: String(error.message || error).slice(0, 300), at: new Date().toISOString() } });
      throw new RuleError(down, 503);
    }
    // Round 8: a barcode matches in any of its forms (sameBarcode: leading zeros don't count), a SKU ignoring case
    const variant = found.find((v) => sameBarcode(v.barcode, code)) || found.find((v) => sameBarcode(v.sku, code)) || null;
    if (this.codeLookups.size > 2000) this.codeLookups.clear();
    this.codeLookups.set(key, { at: Date.now(), variant });
    return variant;
  }

  /**
   * Which library game a scanned code is (section 6): one the Lair knows (library_codes), else Shopify's variant with that
   * barcode or SKU when its product has custom.library_code. Returns { game, save } (save: from Shopify, to remember in
   * the no-awaits part with saveLibraryGame). 422 for a bad code or a shop product, 404 when nothing has it, 503 when
   * Shopify can't be asked.
   */
  async findLibraryGame(value) {
    const code = this.scanCode(value, 'Scan the barcode on the box, or type the code on its label.');
    const known = this.sql.exec('SELECT g.* FROM library_codes c JOIN library_games g ON g.variant_id = c.variant_id WHERE c.key = ?', codeKey(code)).toArray()[0];
    if (known) return { game: this.libraryGameView(known), save: null };
    const variant = await this.variantForCode(code, "Gobgob can't look that game up just now. Ask at the counter and we'll sort it.");
    if (!variant) throw new RuleError("Gobgob can't find a library game with that code. Try the code on its label, or ask at the counter.", 404);
    if (!variant.libraryCode) throw new RuleError("That's from the shop, not the library. Borrow games from the library shelves.", 422);
    const game = {
      variantId: variant.variantId, productId: variant.productId, title: String(variant.productTitle || '').replace(/\s*\(library\)\s*$/i, '').trim(),
      handle: variant.handle || '', shelfCode: String(variant.libraryCode).trim().toUpperCase().slice(0, 20), image: variant.productImage || variant.image || null,
    };
    return { game, save: { game, codes: [variant.sku, variant.barcode].filter(Boolean) } };
  }

  /** A library_games row as a game: { variantId, productId, title, handle, shelfCode, image } */
  libraryGameView(row) {
    return { variantId: row.variant_id, productId: row.product_id || null, title: row.title, handle: row.handle || '', shelfCode: row.shelf_code || '', image: row.image || null };
  }

  /** Copies of a game on the shelf now: copies less active holds and loans out (except what's left out), never below 0. No awaits. */
  copiesFree(variantId, copies, now, { exceptHold = null } = {}) {
    const holds = (this.heldByVariant([variantId], now).get(String(variantId)) || []).filter((h) => h.id !== exceptHold);
    const out = this.outByVariant([variantId]).get(String(variantId)) || [];
    return { free: Math.max(0, copies - holds.length - out.length), holds, out };
  }

  /** A new loan: the game goes home with the member. hold: the hold it collected, or null. No awaits. */
  makeLoan(game, customerId, now, { holdId = null, by = 'member', note = null } = {}) {
    const id = makeId('ln');
    this.write(
      `INSERT INTO library_loans (id, variant_id, product_id, title, shelf_code, handle, image, customer_id, hold_id, status, out_at, returned_at,
         out_by, returned_by, staff_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'out', ?, NULL, ?, NULL, ?, ?, ?)`,
      id, String(game.variantId), game.productId || null, game.title, game.shelfCode || null, game.handle || null, game.image || null, String(customerId),
      holdId, now, by, note, now, now,
    );
    return this.loanRow(id);
  }

  /** A loan comes back: it's 'returned' (once; one already returned stays as it was). No awaits. */
  endLoan(loan, now, by) {
    if (loan.status === 'out') this.write("UPDATE library_loans SET status = 'returned', returned_at = ?, returned_by = ?, updated_at = ? WHERE id = ? AND status = 'out'", now, by, now, loan.id);
    return this.loanRow(loan.id);
  }

  /**
   * POST /library/scan { code, action? } (logged in): borrow or return a library game in the Lair with the camera.
   * action 'borrow' or 'return'; left out, it's a return when the game is at home with them, otherwise a borrow.
   *   return: { result: 'returned', loan, library, message } (404 when that game isn't on loan to them)
   *   borrow: a library plan is needed (403). Held for them: the hold is collected and the loan made. Otherwise the plan
   *     needs room (holds + games at home) and a copy must be free (409). { result: 'borrowed', loan, hold, library, message }
   * library is their GET /me library, fresh. Every await (Shopify: the game, its copies) comes first.
   */
  async libraryScan(input, who) {
    if (!who.customerId) throw new RuleError('Log in to borrow games.', 401);
    const rules = await this.rules();
    const action = ['borrow', 'return'].includes(input?.action) ? input.action : null;
    const { game, save } = await this.findLibraryGame(input?.code);
    const fromShopify = (await this.shopifyCopies([game.variantId])).get(game.variantId);
    // --- no awaits from here on: read, check and save together, so two people can't take the last copy ---
    const now = Date.now();
    const me = String(who.customerId);
    if (save) this.saveLibraryGame(save.game, now, save.codes);
    const mine = this.loansOut(me).filter((l) => l.variantId === game.variantId);
    if (action === 'return' || (!action && mine.length)) {
      if (!mine.length) throw new RuleError("That game isn't on loan to you.", 404);
      const loan = this.endLoan(mine[0], now, 'member');
      return { result: 'returned', loan: this.loanView(loan), library: this.libraryFor(me, who.tags, now), message: `${game.title} is checked back in. Thanks, friend!` };
    }
    const plan = libraryPlan(who.tags);
    if (!plan) throw new RuleError('Join the library to borrow games.', 403);
    const holds = this.activeHolds(me, now);
    const hold = holds.find((h) => h.variantId === game.variantId) || null;
    let loan;
    if (hold) {
      loan = this.collectHold(hold, now, 'member');
    } else {
      const home = this.loansOut(me);
      if (holds.length + home.length >= plan.games) throw new RuleError(this.planFull(plan, holds.length, home.length), 409);
      const copies = fromShopify ?? this.pageCopies(game.variantId) ?? 1;
      if (this.copiesFree(game.variantId, copies, now).free < 1) throw new RuleError(`Every copy of ${game.title} is reserved or out on loan. Ask us at the counter.`, 409);
      loan = this.makeLoan(game, me, now);
    }
    this.touchMember(me, {}, now);
    return {
      result: 'borrowed', loan: this.loanView(loan), hold: hold ? this.holdView(this.holdRow(hold.id), now) : null, library: this.libraryFor(me, who.tags, now),
      message: `${game.title} is yours to take home. Scan it again when you bring it back.`,
    };
  }

  /**
   * POST /library/loans/:id/return (the member it's with, or staff: "Back on the shelf"): the game is returned. One
   * already returned comes back as it is. The member gets { loan, library }, staff { loan: staffLoan }.
   */
  async returnLoan(id, who) {
    if (!who.customerId && !who.staff) throw new RuleError('Log in to borrow games.', 401);
    await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    // Round 9: staff here means the library
    const staffLibrary = this.can(who, 'library');
    const loan = this.loanRow(id);
    if (!loan) throw new RuleError('That loan could not be found.', 404);
    if (!staffLibrary && loan.customerId !== String(who.customerId)) throw new RuleError("That game isn't on loan to you.", 403);
    const back = this.endLoan(loan, now, staffLibrary ? (who.customerId ? `staff:${who.customerId}` : 'staff') : 'member');
    if (staffLibrary) return { loan: this.staffLoanView(back, now) };
    return { loan: this.loanView(back), library: this.libraryFor(who.customerId, who.tags, now) };
  }

  /**
   * POST /library/loans { customerId, code } (staff), or { customerId, variantId, title, shelfCode, handle } for a game
   * typed in: check a game out to a member at the counter. Their hold on it, if any, is collected. No plan or copies
   * check (what's in the staff member's hands goes out), but notice says when it's more than their plan or Shopify
   * thinks every copy is out. Returns { loan, notice }.
   */
  async checkOutLoan(input, who) {
    this.requireStaff(who, 'library');
    const rules = await this.rules();
    const customerId = trimmed(input?.customerId, 40);
    let found;
    if (input?.code != null && String(input.code).trim() !== '') {
      found = await this.findLibraryGame(input.code);
    } else {
      const variantId = this.variantIdOf(input?.variantId);
      const title = trimmed(input?.title, 120);
      if (!variantId || !title) throw new RuleError('Scan the barcode on the box, or type the code on its label.');
      const known = this.libraryGame(variantId);
      const handle = trimmed(input?.handle, 120);
      const game = {
        variantId, productId: known?.product_id || null, title: title.replace(/\s*\(library\)\s*$/i, '').trim(), shelfCode: trimmed(input?.shelfCode, 20).toUpperCase() || known?.shelf_code || '',
        handle: /^[a-z0-9][a-z0-9-]*$/i.test(handle) ? handle.toLowerCase() : known?.handle || '', image: known?.image || null,
      };
      found = { game, save: { game, codes: [] } };
    }
    const { game, save } = found;
    const person = customerId ? await this.person(customerId) : null;
    const fromShopify = (await this.shopifyCopies([game.variantId])).get(game.variantId);
    // --- no awaits from here on ---
    const now = Date.now();
    const member = this.memberRow(customerId);
    if (!member) throw new RuleError('No member with that customer ID.', 404);
    if (save) this.saveLibraryGame(save.game, now, save.codes);
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    const hold = this.activeHolds(member.customer_id, now).find((h) => h.variantId === game.variantId) || null;
    const copies = fromShopify ?? this.pageCopies(game.variantId) ?? 1;
    const before = this.copiesFree(game.variantId, copies, now, { exceptHold: hold?.id });
    const loan = hold ? this.collectHold(hold, now, by) : this.makeLoan(game, member.customer_id, now, { by });
    const plan = libraryPlan(person?.tags);
    const used = this.activeHolds(member.customer_id, now).length + this.loansOut(member.customer_id).length;
    const name = member.first_name || String(member.name || '').split(/\s+/)[0] || 'They';
    const notices = [];
    if (!plan) notices.push(`${name === 'They' ? 'They aren\'t' : `${name} isn't`} on a library plan.`);
    else if (used > plan.games) notices.push(`That's more than ${name === 'They' ? 'their' : `${name}'s`} plan (${plural(plan.games, 'game', 'games')} at a time).`);
    if (before.free < 1) notices.push('Shopify thinks every copy is out. Check the copies on the product.');
    return { loan: this.staffLoanView(loan, now), notice: notices.length ? notices.join(' ') : null };
  }

  /**
   * POST /library/return { code } (staff): check a game in by scanning it. One copy out: it's returned ({ result:
   * 'returned', loan }). Several out: nothing changes, and staff pick one ({ result: 'pick', loans }). None: 404.
   */
  async checkInLoan(input, who) {
    this.requireStaff(who, 'library');
    await this.rules();
    const { game, save } = await this.findLibraryGame(input?.code);
    // --- no awaits from here on ---
    const now = Date.now();
    if (save) this.saveLibraryGame(save.game, now, save.codes);
    const out = this.outByVariant([game.variantId]).get(game.variantId) || [];
    if (!out.length) throw new RuleError("That game isn't out on loan. It must be on the shelf already.", 404);
    const memo = new Map();
    if (out.length > 1) return { result: 'pick', loans: out.map((l) => this.staffLoanView(l, now, memo)) };
    const loan = this.endLoan(out[0], now, who.customerId ? `staff:${who.customerId}` : 'staff');
    return { result: 'returned', loan: this.staffLoanView(loan, now, memo) };
  }

  /** GET /library/loans?status=out|all (staff): out (the default), longest at home first; all, the last 200, newest first. */
  async listLoans(url, who) {
    this.requireStaff(who, 'library');
    await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const rows = url.searchParams.get('status') === 'all'
      ? this.sql.exec('SELECT * FROM library_loans ORDER BY out_at DESC, rowid DESC LIMIT 200').toArray()
      : this.sql.exec("SELECT * FROM library_loans WHERE status = 'out' ORDER BY out_at, created_at").toArray();
    const memo = new Map();
    return { loans: rows.map((r) => this.staffLoanView(this.rowToLoan(r), now, memo)) };
  }

  /* ---------------- the tab's scanner (round 7) ---------------- */
  /**
   * GET /tab/lookup?code= (logged in): a scanned barcode or SKU → { item: { variantId, productId, handle, title,
   * variantTitle ('' for "Default Title"), price (cents), image, available, barcode, sku } }. A tab takes an Active
   * product that isn't a library copy, a gift card or something that needs a selling plan; stock isn't refused here
   * (available is Shopify's availableForSale). 60 lookups a member in 10 minutes; Shopify's answers are kept 10 minutes.
   */
  async tabLookup(url, who) {
    if (!who.customerId) throw new RuleError('Log in to start a tab.', 401);
    const code = this.scanCode(url.searchParams.get('code'), 'Scan a barcode, or type the code under it.');
    const now = Date.now();
    const key = String(who.customerId);
    this.tabHits = this.tabHits || new Map();
    const hits = (this.tabHits.get(key) || []).filter((t) => now - t < 10 * MIN);
    if (hits.length >= TAB_LOOKUPS) throw new RuleError('Easy, friend. Give the scanner a minute.', 429);
    if (this.tabHits.size > 2000) this.tabHits.clear();
    this.tabHits.set(key, [...hits, now]);
    const library = "That's one of our library games, so it doesn't go on a tab. Borrow it in My Library.";
    if (this.sql.exec('SELECT 1 AS n FROM library_codes WHERE key = ?', codeKey(code)).toArray().length) throw new RuleError(library, 422);
    const v = await this.variantForCode(code, "Gobgob can't look up barcodes just now. Pick it from the menu instead.");
    // --- no awaits from here on ---
    if (!v) throw new RuleError("Gobgob doesn't know that one. Pick it from the menu instead.", 404);
    if (v.libraryCode) throw new RuleError(library, 422);
    if (v.status !== 'ACTIVE') throw new RuleError("That one isn't on sale right now. Ask us at the counter.", 422);
    if (v.giftCard || v.sellingPlan) throw new RuleError("That one can't go on a tab. Ask us at the counter.", 422);
    return {
      item: {
        variantId: v.variantId, productId: v.productId, handle: v.handle, title: v.productTitle, variantTitle: v.title === 'Default Title' ? '' : v.title || '',
        price: v.price, image: v.image || v.productImage || null, available: v.available, barcode: v.barcode || '', sku: v.sku || '',
      },
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
   * code here, from the name we have (DG with none), and keeps it: renaming themselves doesn't change it. Round 7: no
   * welcome roll any more (a loot code does that job), and mobile (checked already) is a booking's mobile: it becomes
   * their profile's when they have none or a different one. No awaits.
   */
  touchMember(customerId, { name, email, mobile } = {}, now = Date.now()) {
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
    if (mobile && mobileKey(mobile) !== mobileKey(row?.mobile)) {
      this.write('UPDATE members SET mobile = ?, profile_updated_at = ? WHERE customer_id = ?', mobile, now, String(customerId));
    }
  }

  /** POST /members/:customerId/new-code (staff): a fresh member code (a lost or shared one). The old one stops working. */
  async newMemberCode(customerId, who) {
    this.requireStaff(who, 'members');
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

  /** Spend in the current New Zealand financial year so far (from 1 April, Lair time). No awaits. */
  spendFy(customerId, now = Date.now()) {
    const time = lairTime(this.rulesCache?.tz);
    const from = time.at(financialYear(time.key(now)).from, 0);
    return this.sql.exec('SELECT COALESCE(SUM(amount), 0) AS n FROM spend WHERE customer_id = ? AND created_at >= ?', String(customerId), from).one().n;
  }

  /**
   * Whole years a member has been with Dice Goblin (round 6): since the date staff set (customer_since), or else since
   * their Shopify account was made (shopify_since), or else since the Lair first saw them. At least 0. No awaits.
   */
  yearsWithUs(row, now = Date.now()) {
    const time = lairTime(this.rulesCache?.tz);
    const from = row.customer_since || (row.shopify_since > 0 ? time.key(row.shopify_since) : null) || time.key(row.created_at || row.last_seen || now);
    return wholeYears(from, time.key(now));
  }

  /**
   * A member as staff see them. rollsFromSpend, rollsGifted and rollsUsed are the old spend dice's (staff history only).
   * Round 6 adds loyalty ({ stamps, cards, rollsAvailable }), customerSince ('YYYY-MM-DD' staff set, or null),
   * yearsWithUs and spendFy (the financial year so far). Round 7 adds the player profile (mobile, pronouns,
   * favouriteGames, about) and loyalty.card (the card they're on).
   */
  memberView(row, now = Date.now()) {
    const spend = this.spendOf(row.customer_id, now);
    const card = this.loyaltyOf(row.customer_id);
    return {
      customerId: row.customer_id, name: row.name || '', firstName: row.first_name || '', email: row.email || '', birthday: row.birthday || '',
      spendYear: spend.year, spendTotal: spend.total, rollsFromSpend: Math.floor(spend.total / ROLL_EVERY), rollsGifted: this.giftedRolls(row.customer_id),
      rollsUsed: this.sql.exec("SELECT COUNT(*) AS n FROM member_rolls WHERE customer_id = ? AND kind IN ('spend', 'bonus')", row.customer_id).one().n,
      lastSeen: row.last_seen || null, code: row.code || null,
      // Dice prizes Shopify couldn't add: staff give them at the counter (POST /prizes/:id/done)
      pendingPrizes: this.memberPrizes(row.customer_id, { pending: true }),
      loyalty: { stamps: card.stamps, cards: card.cards, rollsAvailable: card.rolls.available, card: card.card },
      customerSince: row.customer_since || null, yearsWithUs: this.yearsWithUs(row, now), spendFy: this.spendFy(row.customer_id, now),
      mobile: row.mobile || '', pronouns: row.pronouns || '', favouriteGames: parse(row.favourite_games, []), about: row.about || '',
    };
  }

  /**
   * The player profile (round 7), as the member (GET /me) and staff see it: { name, firstName, email, mobile, birthday,
   * pronouns, favouriteGames, about, updatedAt }.
   */
  profileView(row) {
    return {
      name: row?.name || '', firstName: row?.first_name || '', email: row?.email || '', mobile: row?.mobile || '', birthday: row?.birthday || '',
      pronouns: row?.pronouns || '', favouriteGames: parse(row?.favourite_games, []), about: row?.about || '', updatedAt: row?.profile_updated_at || null,
    };
  }

  /**
   * One member as GET /members lists them: memberView plus owed, owedCount, openTab, giftedThisYear and (round 7)
   * giftsThisYear ([{ id, at, words }], newest first). No awaits.
   */
  memberListItem(customerId, rules, now = Date.now()) {
    const row = this.memberRow(customerId);
    if (!row) return null;
    const money = this.membersMoney(rules, now);
    const owed = money.owed.get(row.customer_id) || { amount: 0, count: 0 };
    return {
      ...this.memberView(row, now), owed: owed.amount, owedCount: owed.count, openTab: money.tabs.get(row.customer_id) || 0, giftedThisYear: money.gifted.has(row.customer_id),
      giftsThisYear: this.giftsThisYear(rules, now, row.customer_id).get(row.customer_id) || [],
    };
  }

  /**
   * POST /members/:customerId/since { since } (staff): when they became a customer, for years with us: 'YYYY-MM-DD',
   * 'YYYY' (taken as 1 January) or null to clear it. Returns { member } (as GET /members lists them).
   */
  async setCustomerSince(customerId, input, who) {
    this.requireStaff(who, 'members');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const member = this.memberRow(trimmed(customerId, 40));
    if (!member) throw new RuleError('No member with that customer ID.', 404);
    if (!input || !Object.prototype.hasOwnProperty.call(input, 'since')) throw new RuleError('Say when they became a customer, like 2019-06-01 or 2019 (or null to clear it).');
    const since = parseSince(input.since, new LairTime(rules.tz).key(now));
    this.write('UPDATE members SET customer_since = ?, updated_at = ? WHERE customer_id = ?', since, now, member.customer_id);
    return { member: this.memberListItem(member.customer_id, rules, now) };
  }

  /**
   * When members' Shopify accounts were made (years with us falls back to it), read once per member and kept (0 when
   * Shopify has no such customer). Up to 100 members a call, with read_customers. A failed lookup waits 10 minutes
   * before trying again. Never throws.
   */
  async fillShopifySince(customerIds) {
    if (!this.shopify.configured || Date.now() < (this.retryAt.get('since') || 0)) return;
    const ids = [...new Set(customerIds.map(String))].filter((id) => /^\d{1,20}$/.test(id)).slice(0, 100);
    if (!ids.length) return;
    let found;
    try {
      found = await this.shopify.customersSince(ids);
    } catch (error) {
      this.backoff('since');
      this.note({ sinceError: { message: String(error.message || error).slice(0, 300), at: new Date().toISOString() } });
      return;
    }
    // --- no awaits from here on: facts from Shopify, kept once ---
    for (const [id, ms] of found) this.write('UPDATE members SET shopify_since = ? WHERE customer_id = ? AND shopify_since IS NULL', ms ?? 0, id);
  }

  /**
   * POST /me/profile: the member's own player profile (round 7): name, firstName, email, birthday ('MM-DD' or empty),
   * mobile (section 1's rule, '' clears it), pronouns (up to 30 characters), favouriteGames (up to 8 names of 1 to 40
   * characters, repeats dropped ignoring case), about (up to 300 characters, line breaks kept). Only the fields sent
   * change; longer text is cut to its limit and a 9th game is dropped. Returns { member, profile }.
   */
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
    const mobile = has('mobile') ? checkMobile(input.mobile, { required: false }) || null : row.mobile || null;
    const pronouns = has('pronouns') ? trimmed(input.pronouns, 30) || null : row.pronouns || null;
    const games = has('favouriteGames') ? JSON.stringify(this.favouriteGames(input.favouriteGames)) : row.favourite_games || null;
    const about = has('about') ? String(input.about ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 300) || null : row.about || null;
    const code = row.code || this.newCode(name || firstName || '', 'member', who.customerId, now);
    this.write(
      `INSERT INTO members (customer_id, name, first_name, email, birthday, code, last_seen, created_at, updated_at, mobile, pronouns, favourite_games, about,
         profile_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(customer_id) DO UPDATE SET name = excluded.name, first_name = excluded.first_name, email = excluded.email,
         birthday = excluded.birthday, code = COALESCE(members.code, excluded.code), last_seen = excluded.last_seen, updated_at = excluded.updated_at,
         mobile = excluded.mobile, pronouns = excluded.pronouns, favourite_games = excluded.favourite_games, about = excluded.about,
         profile_updated_at = excluded.profile_updated_at`,
      who.customerId, name, firstName, email, birthday, code, now, now, now, mobile, pronouns, games === '[]' ? null : games, about, now,
    );
    const fresh = this.memberRow(who.customerId);
    return { member: this.memberView(fresh, now), profile: this.profileView(fresh) };
  }

  /** Favourite games from the profile form: up to 8 names, each trimmed to 40 characters, empty ones and repeats (ignoring case) dropped */
  favouriteGames(value) {
    const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]+/) : [];
    const seen = new Set();
    const out = [];
    for (const raw of list) {
      const name = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 40).trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push(name);
    }
    return out.slice(0, 8);
  }

  /**
   * GET /members?q=&sort=spend|recent|owing&owing=1 (staff). q finds members by name, email, member code (any way it's
   * typed) or customer ID, up to 25; with no q it's the top 100 by sort. sort: spend (the last 12 months, then all
   * time), recent (last seen) or owing (owed seats plus open tabs), most first; with q and no sort, an exact customer
   * ID comes first, then the most recently seen. owing=1 keeps only members with owed + openTab > 0. Each member is a
   * memberView plus owed (cents, their owed seats), owedCount, openTab (cents: what's on an unpaid tab from an earlier
   * day, or today's open tab) and giftedThisYear.
   */
  async members(url, who) {
    this.requireStaff(who, 'members');
    const rules = await this.rules();
    // Round 6: when their Shopify accounts were made (years with us), asked once per member, before anything is read
    await this.fillShopifySince(this.sql.exec('SELECT customer_id FROM members WHERE shopify_since IS NULL ORDER BY last_seen DESC LIMIT 100').toArray().map((r) => r.customer_id));
    // --- no awaits from here on ---
    const now = Date.now();
    const q = trimmed(url.searchParams.get('q'), 80).toLowerCase();
    const wanted = url.searchParams.get('sort');
    const sort = ['spend', 'recent', 'owing'].includes(wanted) ? wanted : null;
    let exact = '';
    let rows;
    if (q) {
      const found = this.findCode(q);
      exact = found?.type === 'member' ? found.item.customer_id : /^\d{3,20}$/.test(q) ? q : '';
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      rows = this.sql
        .exec(
          `SELECT * FROM members WHERE customer_id = ? OR lower(name) LIKE ? ESCAPE '\\' OR lower(first_name) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\'
             OR lower(code) LIKE ? ESCAPE '\\'`,
          exact, like, like, like, like,
        )
        .toArray();
    } else {
      rows = this.sql.exec('SELECT * FROM members').toArray();
    }
    const money = this.membersMoney(rules, now);
    let list = rows.map((row) => {
      const owed = money.owed.get(row.customer_id) || { amount: 0, count: 0 };
      return { row, spend: money.spend.get(row.customer_id) || { total: 0, year: 0 }, owed, openTab: money.tabs.get(row.customer_id) || 0, gifted: money.gifted.has(row.customer_id) };
    });
    if (url.searchParams.get('owing') === '1') list = list.filter((x) => x.owed.amount + x.openTab > 0);
    const recent = (a, b) => (b.row.last_seen || 0) - (a.row.last_seen || 0) || String(a.row.customer_id).localeCompare(String(b.row.customer_id));
    const orders = {
      spend: (a, b) => b.spend.year - a.spend.year || b.spend.total - a.spend.total || recent(a, b),
      recent,
      owing: (a, b) => b.owed.amount + b.openTab - (a.owed.amount + a.openTab) || recent(a, b),
    };
    list.sort(orders[sort] || ((a, b) => Number(b.row.customer_id === exact) - Number(a.row.customer_id === exact) || recent(a, b)));
    // Round 7: what each was gifted this year, in words
    const gifts = this.giftsThisYear(rules, now);
    return list.slice(0, q ? 25 : 100).map((x) => ({
      ...this.memberView(x.row, now), owed: x.owed.amount, owedCount: x.owed.count, openTab: x.openTab, giftedThisYear: x.gifted,
      giftsThisYear: gifts.get(x.row.customer_id) || [],
    }));
  }

  /**
   * GET /members/:customerId (staff, round 7): one member for their page: the GET /members item, plus their player
   * profile (also as profile), every gift (newest first, as staff see them) and library: { plan (from their Shopify
   * tags, null without one), holds (active), atHome }. Gifts from before round 7 are checked with Shopify first (up to 5).
   */
  async memberDetail(customerId, who) {
    this.requireStaff(who, 'members');
    const rules = await this.rules();
    const id = trimmed(customerId, 40);
    if (!this.memberRow(id)) throw new RuleError('No member with that customer ID.', 404);
    const person = await this.person(id);
    await this.checkGiftCodes({ customerId: id, limit: GIFT_CHECKS_A_PAGE });
    // --- no awaits from here on ---
    const now = Date.now();
    const row = this.memberRow(id);
    const gifts = this.sql.exec('SELECT g.*, p.code AS pass_code FROM gifts g LEFT JOIN passes p ON p.id = g.pass_id WHERE g.customer_id = ? ORDER BY g.created_at DESC, g.rowid DESC', id).toArray();
    const plan = libraryPlan(person?.tags);
    const memo = new Map();
    return {
      member: {
        ...this.memberListItem(id, rules, now), profile: this.profileView(row), gifts: gifts.map((g) => this.giftView(g, now)),
        library: {
          plan: plan ? { name: plan.name, games: plan.games } : null, holds: this.activeHolds(id, now).map((h) => this.staffHoldView(h, now, memo)),
          atHome: this.loansOut(id).map((l) => this.staffLoanView(l, now, memo)),
          // Round 9: the last 5 games they brought back, newest first
          returns: this.sql.exec("SELECT * FROM library_loans WHERE customer_id = ? AND status = 'returned' ORDER BY returned_at DESC, rowid DESC LIMIT 5", id).toArray().map((r) => this.staffLoanView(this.rowToLoan(r), now, memo)),
        },
        // Round 9: their tab and account (GET /me's, plus the note, who set it, their bills and a limit warning)
        account: this.memberAccount(id, rules, now, { staff: true }),
      },
    };
  }

  /**
   * Every member's money at once, for GET /members: spend (all time and the last 12 months), owed seats (amount and
   * count), open tabs (an unpaid tab from an earlier day, or today's open one) and who has had a gift this year, by
   * customer ID. No awaits.
   */
  membersMoney(rules, now) {
    const time = new LairTime(rules.tz);
    const today = time.key(now);
    const spend = new Map(this.sql
      .exec('SELECT customer_id, SUM(amount) AS total, SUM(CASE WHEN created_at > ? THEN amount ELSE 0 END) AS year FROM spend GROUP BY customer_id', now - YEAR)
      .toArray().map((r) => [r.customer_id, { total: r.total || 0, year: r.year || 0 }]));
    const owed = new Map();
    const seats = this.sql
      .exec(
        `SELECT * FROM bookings WHERE series_id IS NOT NULL AND kind = 'gm-seat' AND status != 'cancelled' AND ends_at <= ? AND created_at >= ? AND paid = 0
           AND waived = 0 AND customer_id IS NOT NULL`,
        now, this.owedFrom,
      )
      .toArray().map((r) => this.rowToBooking(r));
    for (const b of seats.filter((x) => this.isOwed(x, now))) {
      const sum = owed.get(b.customerId) || { amount: 0, count: 0 };
      owed.set(b.customerId, { amount: sum.amount + dueOf(b), count: sum.count + 1 });
    }
    const tabs = new Map(this.sql
      .exec("SELECT customer_id, SUM(total) AS n FROM tabs WHERE status != 'paid' AND (day < ? OR (day = ? AND status = 'open')) GROUP BY customer_id", today, today)
      .toArray().map((r) => [r.customer_id, r.n || 0]));
    const gifted = new Set(this.sql.exec('SELECT DISTINCT customer_id FROM gifts WHERE year = ?', today.slice(0, 4)).toArray().map((r) => r.customer_id));
    return { spend, owed, tabs, gifted };
  }

  /* ---------------- spend by month and financial year (round 6) ---------------- */
  /**
   * GET /members/:customerId/spend (staff): a member's spend by month and by New Zealand financial year (1 April to 31
   * March), in Lair time:
   *   months  the last 24 months, oldest first, months with nothing as 0: [{ month: 'YYYY-MM', amount, orders }]
   *   years   up to the last 4 financial years, newest first, back to the year of their first order:
   *           [{ fy: '2026/27', from: '2026-04-01', to: '2027-03-31', amount, orders }]
   *   total   all of it; since: the first order the Lair knows about ('YYYY-MM-DD'), or null
   * The first time (once per customer), their older orders are filled in from Shopify first (backfillSpend).
   */
  async memberSpend(customerId, who) {
    this.requireStaff(who, 'members');
    const rules = await this.rules();
    const id = trimmed(customerId, 40);
    if (!this.memberRow(id)) throw new RuleError('No member with that customer ID.', 404);
    await this.backfillSpend(id);
    // --- no awaits from here on ---
    return this.spendReport(id, rules, Date.now());
  }

  /* ---------------- store credit and emails from a member's page (round 9, team) ---------------- */
  /** Round 9: a member's first name for staff words ("Ruby"), else their name or code. No awaits. */
  memberFirst(row) {
    return trimmed(row?.first_name || String(row?.name || '').split(/\s+/)[0] || row?.code || 'They', 40);
  }

  /** Round 9: why Shopify wouldn't show or change store credit, in staff words */
  creditTrouble(error, doing) {
    const message = String(error?.message || error);
    this.note({ creditError: { message: message.slice(0, 300), at: new Date().toISOString() } });
    if (/access denied|access_denied|required access|not approved/i.test(message)) {
      return doing === 'read'
        ? "Shopify hasn't let the Lair read store credit balances yet. Approve the app's new permission in Shopify admin (Apps › Dice Goblin Lair)."
        : "Shopify hasn't let the Lair change store credit. Check the app's permissions in Shopify admin (Apps › Dice Goblin Lair).";
    }
    return doing === 'read' ? "Shopify didn't answer just now, so the balance isn't showing. Try again in a minute." : null;
  }

  /** Round 9: a store credit change as the member page lists it. No awaits. */
  creditView(r) {
    const by = String(r.by || '').replace(/^staff:/, '');
    const m = by && by !== 'staff' ? this.memberRow(by) : null;
    return {
      id: r.id, amount: r.amount, note: r.note || '', status: r.status, balanceAfter: r.balance_after ?? null, message: r.message || null, at: r.at,
      by: by && by !== 'staff' ? { customerId: by, name: m?.first_name || m?.name || '' } : null,
    };
  }

  /**
   * GET /members/:customerId/credit (Money): { balance (cents, or null when Shopify won't say), currency, problem (why
   * there's no balance, or null), history: the last 20 changes from the staff page, newest first (creditView) }.
   */
  async memberCredit(customerId, who) {
    this.requireStaff(who, 'money');
    const id = trimmed(customerId, 40);
    if (!this.memberRow(id)) throw new RuleError('No member with that customer ID.', 404);
    const currency = this.env.CURRENCY || 'NZD';
    let balance = null;
    let problem = null;
    if (!this.shopify.configured) problem = "Shopify isn't connected, so the balance can't show.";
    else {
      try {
        balance = await this.shopify.storeCreditBalance(id, currency);
      } catch (error) {
        problem = this.creditTrouble(error, 'read');
      }
    }
    // --- no awaits from here on ---
    const history = this.sql.exec('SELECT * FROM member_credit WHERE customer_id = ? ORDER BY at DESC, rowid DESC LIMIT 20', id).toArray().map((r) => this.creditView(r));
    return { balance, currency, problem, history };
  }

  /**
   * POST /members/:customerId/credit { amount (cents: + adds, − takes off), note (needed to take off), key? } (Money):
   * change their Shopify store credit (no email from Shopify). Up to $1000 at a time; a take-off can't take the balance
   * below zero. key: the page's own key for this change, so sending it again never moves money twice (the first
   * answer comes back, with repeated: true). Logged first ('pending'), then 'done' or 'failed'. Returns { change, balance }.
   */
  async changeMemberCredit(customerId, input, who) {
    this.requireStaff(who, 'money');
    const id = trimmed(customerId, 40);
    const member = this.memberRow(id);
    if (!member) throw new RuleError('No member with that customer ID.', 404);
    const amount = Number(input?.amount);
    if (!Number.isInteger(amount) || amount === 0) throw new RuleError('Say how much to add or take off.');
    if (Math.abs(amount) > CREDIT_MAX) throw new RuleError('Store credit changes go up to $1000 at a time. Check the amount.');
    const note = trimmed(input?.note, 300);
    if (amount < 0 && !note) throw new RuleError('Add a note to say why the credit is coming off.');
    const key = trimmed(input?.key, 64) || null;
    const first = this.memberFirst(member);
    const repeat = () => (key ? this.sql.exec('SELECT * FROM member_credit WHERE key = ?', key).toArray()[0] : null);
    const again = repeat();
    if (again) return { change: this.creditView(again), balance: again.balance_after ?? null, repeated: true };
    if (!this.shopify.configured) throw new RuleError("Shopify isn't connected, so store credit can't change right now.", 503);
    const currency = this.env.CURRENCY || 'NZD';
    // Taking off: the balance first, when Shopify will say, so it never goes below zero (Shopify refuses that too)
    let balance = null;
    if (amount < 0) {
      try {
        balance = await this.shopify.storeCreditBalance(id, currency);
      } catch {
        balance = null;
      }
    }
    // --- no awaits until the change is claimed ---
    const raced = repeat();
    if (raced) return { change: this.creditView(raced), balance: raced.balance_after ?? null, repeated: true };
    const tooMuch = (left) => (left > 0
      ? `${first} has ${money(left)} of store credit, so you can take off ${money(left)} at most.`
      : `${first} has no store credit to take off.`);
    if (amount < 0 && balance != null && balance + amount < 0) throw new RuleError(tooMuch(balance), 409);
    const changeId = makeId('mc');
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    this.write(
      "INSERT INTO member_credit (id, customer_id, amount, note, status, key, by, at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
      changeId, id, amount, note || null, key, by, Date.now(), Date.now(),
    );
    // --- claimed: now Shopify. Afterwards only this change's own row is touched ---
    let done;
    try {
      done = await this.shopify.changeStoreCredit(id, amount, currency);
    } catch (error) {
      const insufficient = error?.code === 'INSUFFICIENT_FUNDS';
      const message = insufficient
        ? `${first} doesn't have that much store credit, so nothing came off. Check their balance and take off less.`
        : this.creditTrouble(error, 'change') || `Shopify didn't change the store credit (${String(error?.message || error).replace(/^Shopify API:\s*/, '').slice(0, 160)}). Nothing changed. Try again.`;
      this.write("UPDATE member_credit SET status = 'failed', message = ?, updated_at = ? WHERE id = ?", message, Date.now(), changeId);
      throw new RuleError(message, insufficient ? 409 : 502);
    }
    this.write(
      "UPDATE member_credit SET status = 'done', transaction_id = ?, balance_after = ?, updated_at = ? WHERE id = ?",
      done.id, done.balanceAfter, Date.now(), changeId,
    );
    const row = this.sql.exec('SELECT * FROM member_credit WHERE id = ?', changeId).toArray()[0];
    return { change: this.creditView(row), balance: done.balanceAfter };
  }

  /** Round 9: an email staff sent a member, as their page lists it. No awaits. */
  memberEmailView(r) {
    const by = String(r.by || '').replace(/^staff:/, '');
    const m = by && by !== 'staff' ? this.memberRow(by) : null;
    return {
      id: r.id, subject: r.subject, email: r.email, status: r.status, message: r.message || null, at: r.at,
      by: by && by !== 'staff' ? { customerId: by, name: m?.first_name || m?.name || '' } : null,
    };
  }

  /** Round 9: emails this staff member sent (or is sending) in the last 24 hours. No awaits. */
  emailsToday(who, now) {
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    return this.sql.exec("SELECT COUNT(*) AS n FROM member_emails WHERE by = ? AND at > ? AND status != 'failed'", by, now - 24 * HOUR).one().n;
  }

  /**
   * GET /members/:customerId/emails (Members): { to (their email, or ''), emails: the last 20 staff sent them, newest
   * first (memberEmailView), left: how many more this staff member can send today, limit }. No awaits.
   */
  memberEmails(customerId, who) {
    this.requireStaff(who, 'members');
    const id = trimmed(customerId, 40);
    const member = this.memberRow(id);
    if (!member) throw new RuleError('No member with that customer ID.', 404);
    const now = Date.now();
    const emails = this.sql.exec('SELECT * FROM member_emails WHERE customer_id = ? ORDER BY at DESC, rowid DESC LIMIT 20', id).toArray().map((r) => this.memberEmailView(r));
    const to = isEmail(member.email) ? member.email : isEmail(member.account_email) ? member.account_email : '';
    return { to, emails, left: Math.max(0, MEMBER_EMAIL.perDay - this.emailsToday(who, now)), limit: MEMBER_EMAIL.perDay };
  }

  /**
   * POST /members/:customerId/email { subject, message, signedAs? } (Members): an email to the member from the shop's
   * address, in the shop's email look, with the message as written (paragraphs kept, no HTML), signed "<first name>,
   * Dice Goblin" (signedAs, else the sender's first name). Replies go to the shop (STAFF_EMAIL). 30 a day per staff
   * member. Logged ('sending', then 'sent' or 'failed'). Returns { email (memberEmailView), left }.
   */
  async emailMember(customerId, input, who) {
    this.requireStaff(who, 'members');
    const now = Date.now();
    const id = trimmed(customerId, 40);
    const member = this.memberRow(id);
    if (!member) throw new RuleError('No member with that customer ID.', 404);
    const to = isEmail(member.email) ? trimmed(member.email, 120) : isEmail(member.account_email) ? trimmed(member.account_email, 120) : '';
    if (!to) throw new RuleError(`${this.memberFirst(member)} has no email on file, so there's nothing to send to.`, 422);
    const subject = String(input?.subject ?? '').replace(/\s+/g, ' ').trim();
    if (!subject || subject.length > MEMBER_EMAIL.subject) throw new RuleError(`Add a subject, up to ${MEMBER_EMAIL.subject} characters.`);
    const message = String(input?.message ?? '').replace(/\r\n?/g, '\n').trim();
    if (!message || message.length > MEMBER_EMAIL.message) throw new RuleError('Write the message, up to 4,000 characters.');
    if (!emailReady(this.env)) throw new RuleError("Emails aren't set up, so nothing can be sent from here yet.", 503);
    if (this.emailsToday(who, now) >= MEMBER_EMAIL.perDay) throw new RuleError(`That's ${MEMBER_EMAIL.perDay} emails from you today. Try again tomorrow.`, 429);
    const sender = who.customerId ? this.memberRow(who.customerId) : null;
    const signer = trimmed(String(input?.signedAs ?? '').replace(/\s+/g, ' '), 40) || this.memberFirst(sender || { first_name: 'The team' });
    const emailId = makeId('me');
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    this.write(
      "INSERT INTO member_emails (id, customer_id, email, subject, status, message, by, at, updated_at) VALUES (?, ?, ?, ?, 'sending', NULL, ?, ?, ?)",
      emailId, id, to, subject, by, now, now,
    );
    // --- claimed (it counts towards today's 30): now Resend. Afterwards only this email's own row is touched ---
    const paragraphs = message.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const sent = await this.mail(this.letter(to, subject, { title: subject, intro: paragraphs, button: null, signoff: `${signer}, Dice Goblin` }, { replyTo: this.env.STAFF_EMAIL || null }));
    const failure = sent.ok ? null : `It didn't send (${String(sent.message || 'no answer').slice(0, 160)}).`;
    this.write('UPDATE member_emails SET status = ?, message = ?, updated_at = ? WHERE id = ?', sent.ok ? 'sent' : 'failed', failure, Date.now(), emailId);
    if (!sent.ok) throw new RuleError(`${failure} Try again in a minute.`, 502);
    const row = this.sql.exec('SELECT * FROM member_emails WHERE id = ?', emailId).toArray()[0];
    return { email: this.memberEmailView(row), left: Math.max(0, MEMBER_EMAIL.perDay - this.emailsToday(who, Date.now())) };
  }

  /** The spend report from the spend table (see memberSpend). No awaits. */
  spendReport(customerId, rules, now) {
    const time = new LairTime(rules.tz);
    const rows = this.sql.exec('SELECT amount, created_at FROM spend WHERE customer_id = ? ORDER BY created_at, order_id', String(customerId)).toArray();
    const [y, m] = time.key(now).split('-').map(Number);
    const months = Array.from({ length: 24 }, (_, i) => ({ month: new Date(Date.UTC(y, m - 24 + i, 1)).toISOString().slice(0, 7), amount: 0, orders: 0 }));
    const byMonth = new Map(months.map((x) => [x.month, x]));
    const since = rows.length ? time.key(rows[0].created_at) : null;
    const current = financialYear(time.key(now)).start;
    const oldest = since ? Math.max(Math.min(financialYear(since).start, current), current - 3) : current;
    const years = [];
    for (let start = current; start >= oldest; start -= 1) {
      const { fy, from, to } = financialYearFrom(start);
      years.push({ fy, from, to, amount: 0, orders: 0 });
    }
    const byYear = new Map(years.map((x) => [Number(x.from.slice(0, 4)), x]));
    let total = 0;
    for (const r of rows) {
      const key = time.key(r.created_at);
      total += r.amount;
      for (const bucket of [byMonth.get(key.slice(0, 7)), byYear.get(financialYear(key).start)]) {
        if (!bucket) continue;
        bucket.amount += r.amount;
        bucket.orders += 1;
      }
    }
    return { months, years, total, since };
  }

  /**
   * Fill in a customer's older paid orders from Shopify for the spend report, once per customer: orders/paid only
   * counts orders paid since the Lair started listening. Which orders Shopify shows depends on the app's scopes:
   * read_orders gives Shopify's last 60 days only; with read_all_orders granted it's every order, and a customer filled
   * in with only 60 days is filled in again then. Idempotent by order ID (the spend table's key), so an order the
   * orders/paid webhook already counted, or counts later, is never counted twice. A failed lookup waits 10 minutes
   * before trying again; two at once share one lookup. Never throws.
   */
  async backfillSpend(customerId) {
    const id = String(customerId);
    if (!this.shopify.configured || !/^\d{1,20}$/.test(id)) return null;
    const scope = (this.grantedScopes || []).includes('read_all_orders') ? 'all' : 'recent';
    const done = this.sql.exec('SELECT scope FROM spend_backfills WHERE customer_id = ?', id).toArray()[0];
    if (done && (done.scope === 'all' || scope === 'recent')) return null;
    if (this.backfilling.has(id)) return this.backfilling.get(id);
    if (Date.now() < (this.retryAt.get(`spend:${id}`) || 0)) return null;
    const work = (async () => {
      let found;
      try {
        found = await this.shopify.customerOrders(id);
      } catch (error) {
        this.backoff(`spend:${id}`);
        this.note({ spendBackfillError: { message: String(error.message || error).slice(0, 300), at: new Date().toISOString() } });
        return null;
      }
      // --- no awaits from here on: each paid order is added once, keyed by its ID ---
      const now = Date.now();
      let added = 0;
      for (const o of found.orders) {
        if (!o.id || !o.paid || !(o.amount > 0)) continue;
        if (this.sql.exec('SELECT 1 AS n FROM spend WHERE order_id = ?', o.id).toArray().length) continue;
        this.write('INSERT INTO spend (order_id, customer_id, amount, source, created_at) VALUES (?, ?, ?, ?, ?)', o.id, id, o.amount, o.source || null, o.at || now);
        added += 1;
      }
      this.write(
        `INSERT INTO spend_backfills (customer_id, scope, orders, at) VALUES (?, ?, ?, ?)
         ON CONFLICT(customer_id) DO UPDATE SET scope = excluded.scope, orders = spend_backfills.orders + excluded.orders, at = excluded.at`,
        id, scope, added, now,
      );
      if (found.createdAt) this.write('UPDATE members SET shopify_since = ? WHERE customer_id = ? AND (shopify_since IS NULL OR shopify_since = 0)', found.createdAt, id);
      return { added, scope };
    })().finally(() => this.backfilling.delete(id));
    this.backfilling.set(id, work);
    return work;
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

  /** A birthday gift's suggested size, in dollars: 2% and 5% of the last 12 months' spend, rounded, at least $2 each */
  suggestedGift(spendYear) {
    const dollarsOf = (share) => Math.max(2, Math.round(((spendYear || 0) * share) / 100));
    return { low: dollarsOf(0.02), high: dollarsOf(0.05) };
  }

  /** Whether a member has had a birthday gift in this (Lair) year. No awaits. */
  giftedIn(customerId, year) {
    return this.sql.exec('SELECT 1 AS n FROM gifts WHERE customer_id = ? AND year = ? LIMIT 1', String(customerId), year).toArray().length > 0;
  }

  /**
   * The daily birthday summary, from the 10-minute maintenance once it's past 9am at the Lair: one email to the staff
   * listing the members with a birthday in the next 7 days, each with a suggested gift (2% to 5% of their last 12
   * months' spend) and whether they've had one this year, and a link to the staff page's Members tab. Staff pick and
   * give the gifts there (POST /members/:id/gift): nothing is made automatically any more. Once a day (noted in the
   * meta table, so a restart doesn't send it twice), and only when someone has a birthday coming up. No awaits.
   */
  birthdaySummary(rules, now) {
    const time = new LairTime(rules.tz);
    const today = time.key(now);
    if (time.parts(now).h < 9 || !emailReady(this.env) || !this.env.STAFF_EMAIL) return null;
    if (this.sql.exec("SELECT value FROM meta WHERE key = 'birthday-summary'").toArray()[0]?.value === today) return null;
    const list = this.upcomingBirthdays(rules, now, 7);
    if (!list.length) return { sent: 0 };
    this.write("INSERT OR REPLACE INTO meta (key, value) VALUES ('birthday-summary', ?)", today);
    // "Saturday 3 October": some ICU versions put a comma after the weekday, so it comes out either way
    const day = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: rules.tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(time.at(key, 12 * 60))).replace(',', '');
    this.notifyStaff(`Birthdays this week: ${list.length}`, {
      title: 'Birthdays coming up',
      intro: `${list.length === 1 ? 'One member has' : `${list.length} members have`} a birthday in the next week. Pick a gift for each on the staff page, under Members: store credit, a session pass, dice rolls or something from the shop.`,
      details: list.map(({ row, date, days }) => {
        const range = this.suggestedGift(this.spendOf(row.customer_id, now).year);
        const gifted = this.giftedIn(row.customer_id, today.slice(0, 4)) ? ' Already had a gift this year.' : '';
        return [row.name || row.first_name || row.code || row.customer_id, `${days === 0 ? 'Today' : day(date)}. Suggested gift: $${range.low} to $${range.high}.${gifted}`];
      }),
      button: { label: 'Open Members', url: `${this.page('staff')}#members` },
    });
    return { sent: 1, birthdays: list.length };
  }

  /**
   * GET /members/birthdays (staff): the next 30 days of birthdays, soonest first. Each is the member as GET /members
   * sends them (code is their member code, so the staff page can merge these rows into its members), plus date, days,
   * suggested: { low, high } (dollars, see suggestedGift) and rolls, always 0 since round 7 (Mo: no suggested rolls;
   * staff can still add rolls to a gift by hand); giftedThisYear and lastGift (their latest gift, or null). percent,
   * birthdayCode and sent are the birthday discount code round 4 sent by itself (birthdayCode null when none).
   */
  async birthdayList(who) {
    this.requireStaff(who, 'members');
    const rules = await this.rules();
    // Their years with us can fall back to when their Shopify account was made: asked once per member, first
    await this.fillShopifySince(this.upcomingBirthdays(rules, Date.now(), 30).filter((x) => x.row.shopify_since == null).map((x) => x.row.customer_id));
    // --- no awaits from here on ---
    const now = Date.now();
    const year = new LairTime(rules.tz).key(now).slice(0, 4);
    return this.upcomingBirthdays(rules, now, 30).map(({ row, date, days }) => {
      const view = this.memberView(row, now);
      const given = this.sql.exec("SELECT * FROM prizes WHERE customer_id = ? AND source = 'birthday' AND period = ?", row.customer_id, date.slice(0, 4)).toArray()[0];
      const last = this.sql.exec('SELECT g.*, p.code AS pass_code FROM gifts g LEFT JOIN passes p ON p.id = g.pass_id WHERE g.customer_id = ? ORDER BY g.created_at DESC, g.rowid DESC LIMIT 1', row.customer_id).toArray()[0];
      return {
        ...view, date, days, percent: given?.percent ?? birthdayPercent(view.spendYear), code: view.code, birthdayCode: given?.code || null, sent: Boolean(given),
        suggested: { ...this.suggestedGift(view.spendYear), rolls: 0 }, giftedThisYear: this.giftedIn(row.customer_id, year),
        lastGift: last ? this.giftView(last, now) : null,
      };
    });
  }

  /* ---------------- birthday gifts ---------------- */
  /**
   * A gift from the staff form, checked: credit (dollars, more than $0 and up to $1000), sessions and rolls (1 to 20
   * each), productVariantId (digits, or the variant's gid) with productTitle, and a note. At least one gift. No awaits.
   */
  giftFields(input) {
    const count = (value, what) => {
      if (value == null || value === '' || Number(value) === 0) return 0;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 20) throw new RuleError(`${what} go from 1 to 20.`);
      return n;
    };
    let credit = 0;
    if (input.credit != null && input.credit !== '' && Number(input.credit) !== 0) {
      const value = Number(input.credit);
      if (!(value > 0 && value <= 1000) || Math.round(value * 100) < 1) throw new RuleError('Store credit goes up to $1000. Check the amount.');
      credit = Math.round(value * 100);
    }
    const sessions = count(input.sessions, 'Sessions');
    const rolls = count(input.rolls, 'Dice rolls');
    const variantId = String(input.productVariantId ?? '').trim().replace(/^gid:\/\/shopify\/ProductVariant\//, '');
    if (variantId && !/^\d{1,20}$/.test(variantId)) throw new RuleError("That product doesn't look right. Pick it again.");
    if (!credit && !sessions && !rolls && !variantId) throw new RuleError('Pick at least one gift: store credit, sessions, dice rolls or a product.');
    return { credit, sessions, rolls, variantId, title: variantId ? trimmed(input.productTitle, 120) || 'A birthday pick' : '', note: trimmed(input.note, 300) };
  }

  /** "HBD-SJOWLBEAR17": a gift's product code, from the member code, with -2, -3 and so on once that's been given. No awaits. */
  giftCode(member) {
    const base = `HBD-${codeKey(member.code || member.customer_id)}`;
    const taken = (code) => this.sql.exec('SELECT 1 AS n FROM gifts WHERE product_code = ?', code).toArray().length > 0;
    if (!taken(base)) return base;
    for (let n = 2; n < 1000; n += 1) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
    return `${base}-${makeId('x').slice(2, 8).toUpperCase()}`;
  }

  giftRow(id) {
    return this.sql.exec('SELECT g.*, p.code AS pass_code FROM gifts g LEFT JOIN passes p ON p.id = g.pass_id WHERE g.id = ?', String(id)).toArray()[0] || null;
  }

  /**
   * A gift as staff see it: { id, at, credit (cents), sessions, passCode, rolls, product: { title, code, status,
   * expiresAt, usedAt, order } | null, emailed, problems: [{ part, message }], state, claimedAt, words, note }.
   * product.code is null when Shopify couldn't make it. Round 7: the product code's status, the gift's state and what
   * it was, in words (giftState, giftWords).
   */
  giftView(r, now = Date.now()) {
    const s = this.giftState(r, now);
    return {
      id: r.id, at: r.created_at, credit: r.credit || 0, sessions: r.sessions || 0, passCode: r.pass_code || null, rolls: r.rolls || 0,
      product: s.product, emailed: Boolean(r.emailed), problems: this.giftProblems(r.problems), state: s.state, claimedAt: s.claimedAt,
      words: this.giftWords(r, s.product, now), note: r.note || '',
    };
  }

  /**
   * Round 7: where a birthday gift is at. Its product code is 'ready' (Shopify made it, it's unused and its 30 days
   * aren't over), 'used' (an order carried it), 'expired' (30 days with no use) or 'failed' (Shopify couldn't make it,
   * so they collect it at the counter). The gift is 'ready' while there's something left to collect (a ready code, or a
   * failed one within its 30 days), else 'claimed': claimedAt is when the code was used, when it ran out, or for a gift
   * with no product, when it was given. listed: My Lair shows it (ready, or claimed in the last 30 days; a failed one
   * isn't listed once its 30 days are over). product is the staff view's ({ title, code, status, expiresAt, usedAt,
   * order }). No awaits.
   */
  giftState(r, now = Date.now()) {
    if (!r.product_title) {
      return { product: null, state: 'claimed', claimedAt: r.created_at, listed: r.created_at > now - GIFT_DAYS_MS };
    }
    const expiresAt = r.created_at + GIFT_DAYS_MS;
    const made = r.product_status === 'added';
    const status = r.product_used_at && made ? 'used' : !made ? 'failed' : now >= expiresAt ? 'expired' : 'ready';
    const product = {
      title: r.product_title, code: made ? r.product_code : null, status, expiresAt, usedAt: status === 'used' ? r.product_used_at : null,
      order: status === 'used' ? r.product_order || null : null,
    };
    const ready = status === 'ready' || (status === 'failed' && now < expiresAt);
    const claimedAt = ready ? null : status === 'used' ? r.product_used_at : expiresAt;
    return { product, state: ready ? 'ready' : 'claimed', claimedAt, listed: ready || (status !== 'failed' && claimedAt > now - GIFT_DAYS_MS) };
  }

  /**
   * What a gift was, in words, one rule for staff and members: "$20 store credit, 5 rolls, Riftbound – Vendetta Booster
   * Pack (code HBD-SJOWLBEAR17, used 6 Oct)". Store credit Shopify didn't add is "(to give at the counter)"; sessions are
   * "3 sessions on pass SJ-KOBOLD-3"; a product's code is "until 5 Nov", "used 6 Oct" or "ran out 5 Nov", or "no code
   * yet: give it at the counter". Dates in Lair time, with the year when it isn't this year. No awaits.
   */
  giftWords(r, product, now = Date.now()) {
    const parts = [];
    if (r.credit) parts.push(`${money(r.credit)} store credit${r.credit_status === 'added' ? '' : ' (to give at the counter)'}`);
    if (r.sessions) parts.push(`${plural(r.sessions, 'session', 'sessions')}${r.pass_code ? ` on pass ${r.pass_code}` : ''}`);
    if (r.rolls) parts.push(plural(r.rolls, 'roll', 'rolls'));
    if (product) {
      const day = (ms) => this.giftDate(ms, now);
      const code = product.code;
      const state = !code ? 'no code yet: give it at the counter'
        : product.status === 'used' ? `code ${code}, used ${day(product.usedAt)}`
          : product.status === 'expired' ? `code ${code}, ran out ${day(product.expiresAt)}`
            : `code ${code}, until ${day(product.expiresAt)}`;
      parts.push(`${product.title} (${state})`);
    }
    return parts.join(', ');
  }

  /** "6 Oct", or "6 Oct 2025" when it isn't this year: a day in Lair time */
  giftDate(ms, now = Date.now()) {
    const tz = this.rulesCache?.tz || 'Pacific/Auckland';
    const time = lairTime(tz);
    const thisYear = time.key(ms).slice(0, 4) === time.key(now).slice(0, 4);
    return new Intl.DateTimeFormat('en-NZ', { timeZone: tz, day: 'numeric', month: 'short', ...(thisYear ? {} : { year: 'numeric' }) }).format(new Date(ms)).replace(',', '');
  }

  /** This Lair year's gifts, newest first, as GET /members lists them ({ id, at, words }), by customer ID (one member's, or everyone's). No awaits. */
  giftsThisYear(rules, now = Date.now(), customerId = null) {
    const year = new LairTime(rules.tz).key(now).slice(0, 4);
    const rows = this.sql
      .exec(
        `SELECT g.*, p.code AS pass_code FROM gifts g LEFT JOIN passes p ON p.id = g.pass_id WHERE g.year = ?${customerId ? ' AND g.customer_id = ?' : ''}
         ORDER BY g.created_at DESC, g.rowid DESC`,
        year, ...(customerId ? [String(customerId)] : []),
      )
      .toArray();
    const out = new Map();
    for (const r of rows) {
      if (!out.has(r.customer_id)) out.set(r.customer_id, []);
      out.get(r.customer_id).push({ id: r.id, at: r.created_at, words: this.giftWords(r, this.giftState(r, now).product, now) });
    }
    return out;
  }

  /**
   * Round 7: an order paid with a birthday gift's product code (its discount codes, from orderSpend): that gift's code is
   * used, once, at the order's time (or now), with the order's name. Ignores case. No awaits. Returns the codes marked.
   */
  markGiftCodesUsed(spend, now = Date.now()) {
    const marked = [];
    for (const code of new Set((spend?.discountCodes || []).map((c) => String(c).trim().toUpperCase()).filter(Boolean))) {
      const gift = this.sql.exec('SELECT id, product_code FROM gifts WHERE upper(product_code) = ? AND product_used_at IS NULL LIMIT 1', code).toArray()[0];
      if (!gift) continue;
      this.write('UPDATE gifts SET product_used_at = ?, product_order = ?, updated_at = ? WHERE id = ? AND product_used_at IS NULL', spend.processedAt || now, spend.name || null, now, gift.id);
      marked.push(gift.product_code);
    }
    return marked;
  }

  /**
   * Round 7: birthday gifts' product codes checked with Shopify (LairGiftCodeUse), for uses the orders/paid webhook
   * couldn't see: each gift made before round 7 once, and (maintenance only, expired: true) each code that reached its
   * 30 days with no recorded use, once more. Used once or more means used, dated when it was checked. Up to `limit`
   * gifts (one member's, or anyone's), all asked first and saved afterwards with no awaits. A failed lookup waits 10
   * minutes. Never throws. Returns how many were checked.
   */
  async checkGiftCodes({ customerId = null, limit = GIFT_CHECKS_A_RUN, expired = false } = {}) {
    if (!this.shopify.configured || Date.now() < (this.retryAt.get('gift-codes') || 0)) return 0;
    const now = Date.now();
    const rows = this.sql
      .exec(
        `SELECT id, product_code FROM gifts WHERE product_code IS NOT NULL AND product_status = 'added' AND product_used_at IS NULL
           AND ((created_at < ? AND product_checked_at IS NULL)${expired ? ' OR (created_at + ? <= ? AND (product_checked_at IS NULL OR product_checked_at < created_at + ?))' : ''})
           ${customerId ? 'AND customer_id = ?' : ''} ORDER BY created_at, rowid LIMIT ?`,
        this.giftCodesFrom, ...(expired ? [GIFT_DAYS_MS, now, GIFT_DAYS_MS] : []), ...(customerId ? [String(customerId)] : []), limit,
      )
      .toArray();
    if (!rows.length) return 0;
    const answers = await Promise.allSettled(rows.map((r) => this.shopify.giftCodeUse(r.product_code)));
    // --- no awaits from here on: each gift's own row; a use the webhook noted meanwhile stays as it was ---
    const at = Date.now();
    let checked = 0;
    answers.forEach((answer, i) => {
      if (answer.status !== 'fulfilled') return;
      const used = (answer.value?.uses || 0) >= 1;
      this.write(
        'UPDATE gifts SET product_checked_at = ?, product_used_at = CASE WHEN ? = 1 AND product_used_at IS NULL THEN ? ELSE product_used_at END, updated_at = ? WHERE id = ?',
        at, used ? 1 : 0, at, at, rows[i].id,
      );
      checked += 1;
    });
    const failed = answers.find((a) => a.status === 'rejected');
    if (failed) {
      this.backoff('gift-codes');
      this.note({ giftCodesError: { message: String(failed.reason?.message || failed.reason).slice(0, 300), at: new Date().toISOString() } });
    }
    return checked;
  }

  /**
   * A gift's problems, each { part, message } with part 'credit', 'sessions', 'rolls', 'product' or 'email'. A gift saved
   * before v5.1 kept plain sentences: their part comes from how the app worded them (credit, the product's code, or the
   * email, the only parts that could fail). No awaits.
   */
  giftProblems(text) {
    const PARTS = ['credit', 'sessions', 'rolls', 'product', 'email'];
    return parse(text, []).filter(Boolean).map((p) => {
      if (typeof p === 'object' && PARTS.includes(p.part)) return { part: p.part, message: String(p.message ?? '') };
      const message = String(typeof p === 'object' ? p.message ?? '' : p);
      const part = /^The \$[\d.]+ store credit\b/.test(message) ? 'credit' : /^Shopify couldn't make the code\b/.test(message) ? 'product' : 'email';
      return { part, message };
    });
  }

  /**
   * A gift as its member sees it in My Lair: { id, at, credit, sessions, rolls, product: { title, code, status,
   * expiresAt, usedAt } | null, state, claimedAt, words } (round 7: giftState, giftWords)
   */
  memberGiftView(r, now = Date.now()) {
    const { id, at, credit, sessions, rolls, product, state, claimedAt, words } = this.giftView(r, now);
    return { id, at, credit, sessions, rolls, product: product ? { title: product.title, code: product.code, status: product.status, expiresAt: product.expiresAt, usedAt: product.usedAt } : null, state, claimedAt, words };
  }

  /**
   * POST /members/:customerId/gift (staff): a birthday gift, any mix of { credit (dollars), sessions, rolls,
   * productVariantId and productTitle, note, notify }. sessions is a pass of theirs ("Birthday gift: 3 sessions",
   * source 'birthday'); rolls are extra dice rolls that never expire; the product is a one-use code, just for them, for
   * that one variant at 100% off, for 30 days (HBD-<their code>); credit goes on their Shopify store credit. The gift,
   * the pass and the rolls are saved first; then Shopify is asked for the credit and the code. A part that fails goes in
   * problems and the rest still goes through. notify: true sends "Happy birthday from Gobgob!" listing every part.
   * Returns { gift }.
   */
  async giveGift(customerId, input, who) {
    this.requireStaff(who, 'members');
    const rules = await this.rules();
    // --- no awaits until the gift is saved ---
    const now = Date.now();
    const member = this.memberRow(trimmed(customerId, 40));
    if (!member) throw new RuleError('No member with that customer ID.', 404);
    const f = this.giftFields(input || {});
    const id = makeId('gf');
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    const name = trimmed(member.name || member.first_name, 80);
    let passId = null;
    if (f.sessions) {
      passId = makeId('ps');
      this.write(
        `INSERT INTO passes (id, code, label, sessions_total, sessions_used, cover, customer_id, holder_name, holder_email, note, price_paid, created_at,
           created_by, expires_at, status, source) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, ?, NULL, 'active', 'birthday')`,
        passId, this.newCode(name, 'pass', passId, now), `Birthday gift: ${plural(f.sessions, 'session', 'sessions')}`, f.sessions, rules.prices.table,
        member.customer_id, name || null, isEmail(member.email) ? trimmed(member.email, 120) : null, f.note || null, now, by,
      );
    }
    const productCode = f.variantId ? this.giftCode(member) : null;
    this.write(
      `INSERT INTO gifts (id, customer_id, year, credit, credit_status, sessions, pass_id, rolls, product_variant_id, product_title, product_code,
         product_status, note, emailed, problems, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
      id, member.customer_id, new LairTime(rules.tz).key(now).slice(0, 4), f.credit, f.credit ? 'pending' : null, f.sessions, passId, f.rolls,
      f.variantId || null, f.title || null, productCode, f.variantId ? 'pending' : null, f.note || null, by, now, now,
    );
    // --- saved: the pass and the rolls are theirs. Now Shopify, for the credit and the product code ---
    // Each part that fails: { part: 'credit'|'sessions'|'rolls'|'product'|'email', message }. (The pass and the rolls are
    // saved above, so only the credit, the product code and the email can fail here.)
    const problems = [];
    const said = (error) => String(error?.message || error).replace(/^Shopify API:\s*/, '').slice(0, 200).replace(/[.\s]+$/, '');
    let creditStatus = null;
    if (f.credit) {
      try {
        if (!this.shopify.configured) throw new Error('Shopify is not connected');
        await this.shopify.creditCustomer(member.customer_id, f.credit, this.env.CURRENCY || 'NZD');
        creditStatus = 'added';
      } catch (error) {
        creditStatus = 'failed';
        console.error('Lair: birthday store credit failed', error);
        problems.push({ part: 'credit', message: `The ${money(f.credit)} store credit didn't go on (${said(error)}). Add it in Shopify admin, or give it at the counter.` });
      }
    }
    let productStatus = null;
    if (f.variantId) {
      try {
        if (!this.shopify.configured) throw new Error('Shopify is not connected');
        await this.shopify.createPrizeCode({
          title: `Birthday gift: ${f.title} for ${name || member.code || member.customer_id} (${productCode})`, code: productCode, percent: 1,
          variantId: f.variantId, endsAt: now + GIFT_CODE_DAYS * 24 * HOUR, customerId: member.customer_id,
        });
        productStatus = 'added';
      } catch (error) {
        productStatus = 'failed';
        console.error('Lair: birthday product code failed', error);
        problems.push({ part: 'product', message: `Shopify couldn't make the code for ${f.title} (${said(error)}). Give it to them at the counter.` });
      }
    }
    // --- no awaits from here on: only this gift's own row changes ---
    const fresh = this.memberRow(member.customer_id) || member;
    let emailed = false;
    if (input?.notify === true) {
      if (!emailReady(this.env)) problems.push({ part: 'email', message: "Emails aren't set up, so no birthday email went out. Let them know at the counter." });
      else if (!isEmail(fresh.email)) problems.push({ part: 'email', message: 'They have no email on file, so no birthday email went out. Let them know at the counter.' });
      else emailed = true;
    }
    this.write(
      'UPDATE gifts SET credit_status = ?, product_status = ?, emailed = ?, problems = ?, updated_at = ? WHERE id = ?',
      creditStatus, productStatus, emailed ? 1 : 0, problems.length ? JSON.stringify(problems) : null, Date.now(), id,
    );
    const gift = this.giftView(this.giftRow(id));
    if (emailed) this.giftEmail(fresh, gift, { creditAdded: creditStatus === 'added', note: f.note }, rules);
    return { gift };
  }

  /** "Happy birthday from Gobgob!", listing every part of a gift (the product with its code). No awaits. */
  giftEmail(member, gift, { creditAdded, note }, rules) {
    const first = member.first_name || String(member.name || '').split(/\s+/)[0] || 'friend';
    const until = new Intl.DateTimeFormat('en-NZ', { timeZone: rules.tz, day: 'numeric', month: 'long' }).format(new Date(gift.at + GIFT_CODE_DAYS * 24 * HOUR));
    const details = [];
    if (gift.credit) details.push(['Store credit', creditAdded ? `${money(gift.credit)}, on your account now. Spend it in the shop or online.` : `${money(gift.credit)}. We'll pop it on your account at the counter.`]);
    if (gift.sessions) details.push(['Table sessions', `${plural(gift.sessions, 'session', 'sessions')} on a pass, ${gift.passCode}. Use it when you book, or show the code at the counter.`]);
    if (gift.rolls) details.push(['Dice rolls', `${plural(gift.rolls, 'extra roll', 'extra rolls')}. Roll them in My Lair whenever you like.`]);
    if (gift.product) {
      details.push([gift.product.title, gift.product.code
        ? `Yours free with code ${gift.product.code}, in the shop or online. It works once, just for you, until ${until}.`
        : 'Yours free: show this email at the counter to pick it up.']);
    }
    this.later(this.mail(this.letter(member.email, `Happy birthday from Gobgob, ${first}!`, {
      title: 'Happy birthday from Gobgob!',
      intro: `Kia ora ${first}, Gobgob heard it's your birthday, so the team put together a present for you.`,
      quote: note || '',
      details,
      outro: 'Your gifts are in My Lair too.',
      button: { label: 'See it in My Lair', url: this.page('myLair') },
      signoff: 'Have a great one, friend!\nGobgob',
    })));
  }

  /* ---------------- My Lair ---------------- */
  /**
   * GET /me (logged in). The first visit makes their member record, and its code comes from their name, like
   * SJ-OWLBEAR-17. The app proxy only says who's logged in, so the theme sends the name on their shop account
   * (?name=). Like a booking's name, it only fills in a name the member doesn't have yet.
   */
  async me(who, url = null) {
    if (!who.customerId) throw new RuleError('Log in to see your bookings.', 401);
    const rules = await this.rules();
    // Round 6: their Shopify account's verified email (asked at most once a day): guest bookings and sign-ups made with
    // it become theirs below.
    const account = await this.accountEmail(who.customerId);
    // Round 7: their birthday gifts from before round 7 are checked with Shopify once (has the product code been used?)
    await this.checkGiftCodes({ customerId: who.customerId, limit: GIFT_CHECKS_A_PAGE });
    // --- no awaits from here on ---
    const now = Date.now();
    this.touchMember(who.customerId, { name: trimmed(url?.searchParams.get('name'), 80) }, now);
    if (account.fetched) this.write('UPDATE members SET account_email = ?, account_email_at = ? WHERE customer_id = ?', account.email, now, String(who.customerId));
    if (account.email) this.adoptGuestBookings(who.customerId, account.email, now);
    const member = this.memberView(this.memberRow(who.customerId), now);
    // The loyalty card (round 6); the old `rolls` mirrors its rolls for clients from before
    const loyalty = this.loyaltyOf(who.customerId, rules, { details: true });
    const since = now - 30 * 24 * HOUR;
    // A place held while it's paid online keeps its checkout link (checkout_url) and when the hold ends, so they can
    // finish paying from any device. Only the owner ever gets these, here: staff views and the floor never do.
    const withLink = (item, row) => ({ ...item, checkoutUrl: row.checkout_url || null });
    const heldLink = (x) => (x.status === 'held' && x.checkoutUrl ? { checkoutUrl: x.checkoutUrl, holdUntil: x.holdUntil || null } : {});
    const own = this.sql.exec('SELECT * FROM bookings WHERE customer_id = ? AND ends_at > ? ORDER BY starts_at', who.customerId, since).toArray()
      .map((r) => withLink(this.rowToBooking(r), r));
    // ticketCode: what the ticket and its QR show (a weekly regular's seat is their member code).
    const memberRow = this.memberRow(who.customerId);
    const view = (b) => ({
      id: b.id, ref: b.ref, kind: b.kind, tables: b.tables, room: b.room, start: b.start, end: b.end, people: b.people, status: b.status,
      paid: b.paid, amount: b.amount, pay: b.pay, extras: b.extras, players: b.party || [], occurrenceId: b.occurrenceId || null, refund: b.refund || null,
      payment: b.pay === 'now' ? 'online' : 'store', pass: this.ownPass(b), covered: b.covered || 0, due: dueOf(b), paidAmount: b.paidAmount || 0,
      split: Boolean(b.split), ticketCode: this.ticketCode(b, memberRow), owed: this.isOwed(b, now), waived: Boolean(b.waived), ...heldLink(b),
    });
    // dueNow: everything they can pay at the counter now: today's bookings and seats that are confirmed or seated, and
    // sign-ups confirmed or checked in ('attended'), with something due, then their owed seats. A place held while it's
    // paid online isn't on it (its checkout is still open), and neither is a no-show or a table they've left ('done').
    const day = this.memberDay(who.customerId, rules, now);
    const atCounter = (r) => (r.type === 'join' ? ['confirmed', 'attended'] : ['confirmed', 'seated']).includes(r.status);
    const dueNow = [...day.today.filter((r) => r.due > 0 && atCounter(r)), ...day.owed].map((r) => ({
      id: r.id, type: r.type, ref: r.ref, title: this.dueTitle(r, rules), start: r.start, end: r.end, amount: r.amount, covered: r.covered,
      paidAmount: r.paidAmount, due: r.due, owed: Boolean(r.owed),
    }));
    const gameRows = this.sql.exec('SELECT * FROM games WHERE gm_customer_id = ? AND ends_at > ? ORDER BY starts_at', who.customerId, since).toArray().map((r) => this.rowToGame(r));
    const span = gameRows.length ? this.state(Math.min(...gameRows.map((g) => g.start)) - 1, Math.max(...gameRows.map((g) => g.end)) + 1) : null;
    const seriesInfo = gameRows.some((g) => g.seriesId) ? this.seriesInfo(now) : null;
    const seatGames = new Map();
    for (const b of own.filter((x) => x.kind === 'gm-seat' && x.gameId)) if (!seatGames.has(b.gameId)) seatGames.set(b.gameId, this.game(b.gameId));
    const profile = this.sql.exec('SELECT name, bio FROM gm_profiles WHERE customer_id = ?', who.customerId).toArray()[0] || null;
    const credits = this.sql
      .exec('SELECT c.*, g.title AS title FROM credits c LEFT JOIN games g ON g.id = c.game_id WHERE c.customer_id = ? ORDER BY c.created_at DESC LIMIT 20', who.customerId)
      .toArray()
      .map((c) => ({ gameId: c.game_id, title: c.title, players: c.players, amount: c.amount, status: c.status, at: c.created_at }));
    const joins = this.sql.exec('SELECT * FROM event_joins WHERE customer_id = ? AND ends_at > ? ORDER BY starts_at', who.customerId, since).toArray()
      .map((r) => withLink(this.rowToJoin(r), r));
    // Round 8: and the sign-ups they're a guest on (someone else signed them up), in among their own, soonest first
    const joinList = [...joins.map((j) => ({ ...this.joinView(j), ...heldLink(j) })), ...this.guestJoins(who.customerId, since, memberRow)].sort((a, b) => a.start - b.start);
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
      games: gameRows.map((g) => ({ ...this.gameView(g, span, rules, seriesInfo), players: this.gamePlayers(span, g.id) })),
      joins: joinList,
      credits,
      member: {
        firstName: member.firstName, name: member.name, email: member.email, birthday: member.birthday, spendYear: member.spendYear,
        spendTotal: member.spendTotal, code: member.code,
      },
      // Games they're seated at every session of (POST /series/:id/leave stops it). schedule: how the series repeats,
      // 'weekly', 'fortnightly' or 'flexible', as the games board's series.schedule says it.
      series: this.sql
        .exec(
          `SELECT m.*, s.details AS details, s.schedule AS schedule FROM series_members m JOIN series s ON s.id = m.series_id
           WHERE m.customer_id = ? AND m.status = 'active' AND s.status = 'active'`,
          who.customerId,
        )
        .toArray()
        .map((m) => ({
          seriesId: m.series_id, title: parse(m.details, {}).title || 'GM game', people: m.people, players: parse(m.players, []),
          schedule: SERIES_SCHEDULES.includes(m.schedule) ? m.schedule : 'flexible',
        })),
      // Dice: the loyalty card (round 6: stamps, cards, rolls, the last 10 stamped sessions and the last 20 rolls); rolls
      // is the old field, mirroring loyalty's rolls ({ available, toNext: null, per: null, bonus }); the last 10 prizes
      loyalty,
      rolls: this.legacyRolls(loyalty),
      prizes: this.memberPrizes(who.customerId),
      // Library holds (round 6): active ones, soonest first, then any that ended in the last 3 days
      holds: this.memberHolds(who.customerId, now),
      // Round 7: My Library: their plan, how many they have (holds and games at home), their holds and games at home
      library: this.libraryFor(who.customerId, who.tags, now),
      // Round 7: the player profile (the GM profile stays its own block, gmProfile)
      profile: this.profileView(this.memberRow(who.customerId)),
      // Session passes: active ones, and ones used up in the last 30 days
      passes: this.memberPasses(who.customerId, now),
      // Round 9: early access offers open to them now, each with their own claim (and only their own checkout link)
      offers: this.memberOffers(who.customerId, now),
      // Today's self-serve tab, or null
      tab: this.tabView(this.todayTabRow(who.customerId, rules, now)),
      // What they can pay at the counter now: { id, type, ref, title, start, end, amount, covered, paidAmount, due, owed }
      dueNow,
      // Round 9: the running tab (owed now, coming up) and, on a monthly account, the limit and the open bill
      account: this.memberAccount(who.customerId, rules, now),
      // Round 9, play: the sessions they're interested in and the event dates they said maybe (or coming) to, still to come
      interests: this.memberInterests(who.customerId, now),
      // Birthday gifts (round 7): those with something left to collect ('ready'), and those claimed in the last 30 days,
      // whatever year they were given: { id, at, credit, sessions, rolls, product, state, claimedAt, words }
      gifts: this.sql
        .exec('SELECT g.*, p.code AS pass_code FROM gifts g LEFT JOIN passes p ON p.id = g.pass_id WHERE g.customer_id = ? ORDER BY g.created_at DESC, g.rowid DESC', who.customerId)
        .toArray()
        .filter((r) => this.giftState(r, now).listed)
        .map((r) => this.memberGiftView(r, now)),
    };
  }

  /**
   * Round 8: GET /me's sign-ups a member is a guest on (someone else signed them up), from `since` on: joinView without
   * its money (amount, due and paidAmount 0, no refund) or the other guests' names, with their own name, guestOf (the
   * first name of whoever signed them up), canCancel: false and their member code as the ticket (ticketCode: check-in
   * finds the sign-up by it). No awaits.
   */
  guestJoins(customerId, since, member) {
    return this.sql
      .exec(
        `SELECT j.*, x.name AS guest_name FROM event_join_guests x JOIN event_joins j ON j.id = x.join_id
         WHERE x.customer_id = ? AND j.ends_at > ? AND (j.customer_id IS NULL OR j.customer_id != x.customer_id) ORDER BY j.starts_at, x.rowid`,
        String(customerId), since,
      )
      .toArray()
      .map((r) => ({
        ...this.joinView(this.rowToJoin(r), []), name: r.guest_name, amount: 0, due: 0, paidAmount: 0, refund: null,
        guestOf: { name: this.firstNameOf(r.name) }, canCancel: false, ...(member?.code ? { ticketCode: member.code } : {}),
      }));
  }

  /**
   * The email on a member's own Shopify account, once Shopify says it's verified (round 6): what their guest bookings
   * are matched to. Never the email in their Lair profile, which anyone can type. Asked at most once a day per member;
   * a failed lookup waits 10 minutes. Without Shopify there's none. Never throws. Returns { email, fetched } (fetched:
   * Shopify answered just now, so it's saved).
   */
  async accountEmail(customerId) {
    const id = String(customerId);
    const row = this.memberRow(id);
    const kept = { email: row?.account_email || null, fetched: false };
    if (!this.shopify.configured || !/^\d{1,20}$/.test(id)) return kept;
    if (row?.account_email_at && Date.now() - row.account_email_at < 24 * HOUR) return kept;
    if (Date.now() < (this.retryAt.get(`email:${id}`) || 0)) return kept;
    try {
      const found = await this.shopify.customerEmail(id);
      return { email: found?.verified && isEmail(found.email) ? trimmed(found.email, 120) : null, fetched: true };
    } catch (error) {
      this.backoff(`email:${id}`);
      this.note({ accountEmailError: { message: String(error.message || error).slice(0, 300), at: new Date().toISOString() } });
      return kept;
    }
  }

  /** Don't ask Shopify for `key` again for 10 minutes (a failed lookup) */
  backoff(key) {
    if (this.retryAt.size > 5000) this.retryAt.clear();
    this.retryAt.set(key, Date.now() + 10 * MIN);
  }

  /**
   * Guest bookings and sign-ups join an account (round 6): those with no account whose email is the member's verified
   * account email (ignoring case), upcoming or ended in the last 30 days, become theirs, so they show in My Lair and
   * their stamps follow. A GM's own table never moves. No awaits. Returns how many joined.
   */
  adoptGuestBookings(customerId, email, now) {
    const since = now - ADOPT_DAYS * 24 * HOUR;
    const id = String(customerId);
    const bookings = this.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE customer_id IS NULL AND kind != 'gm' AND lower(email) = lower(?) AND ends_at > ?", email, since).one().n;
    const joins = this.sql.exec('SELECT COUNT(*) AS n FROM event_joins WHERE customer_id IS NULL AND lower(email) = lower(?) AND ends_at > ?', email, since).one().n;
    if (bookings) this.write("UPDATE bookings SET customer_id = ?, updated_at = ? WHERE customer_id IS NULL AND kind != 'gm' AND lower(email) = lower(?) AND ends_at > ?", id, now, email, since);
    if (joins) this.write('UPDATE event_joins SET customer_id = ?, updated_at = ? WHERE customer_id IS NULL AND lower(email) = lower(?) AND ends_at > ?', id, now, email, since);
    // Round 9, play: and their "I'm interested" and "Maybe"
    this.adoptInterests(id, email, now);
    return bookings + joins + this.adoptGmGames(id, email, now) + this.takeUpInvites(id, email, now);
  }

  /**
   * Round 7: a GM staff invited by email makes their account. Sessions with no GM account whose GM email is theirs
   * (ignoring case), upcoming or ended in the last 30 days, become theirs, with their series (so later dates are theirs
   * too) and the GM's own table holds. No awaits. Returns how many sessions joined.
   */
  adoptGmGames(id, email, now) {
    const since = now - ADOPT_DAYS * 24 * HOUR;
    const games = this.sql.exec('SELECT COUNT(*) AS n FROM games WHERE gm_customer_id IS NULL AND lower(gm_email) = lower(?) AND ends_at > ?', email, since).one().n;
    if (!games) return 0;
    this.write('UPDATE games SET gm_customer_id = ?, updated_at = ? WHERE gm_customer_id IS NULL AND lower(gm_email) = lower(?) AND ends_at > ?', id, now, email, since);
    this.write(
      `UPDATE series SET gm_customer_id = ?, updated_at = ? WHERE gm_customer_id IS NULL
         AND id IN (SELECT series_id FROM games WHERE series_id IS NOT NULL AND gm_customer_id = ? AND lower(gm_email) = lower(?))`,
      id, now, id, email,
    );
    this.write(
      `UPDATE bookings SET customer_id = ?, updated_at = ? WHERE kind = 'gm' AND customer_id IS NULL
         AND game_id IN (SELECT id FROM games WHERE gm_customer_id = ? AND lower(gm_email) = lower(?) AND ends_at > ?)`,
      id, now, id, email, since,
    );
    return games;
  }

  /**
   * Round 7: someone staff reserved a weekly seat for makes their account. Each waiting invite with their email becomes
   * their regular membership, queued from when they were invited (a regular already keeps their place), or is cancelled
   * when its series has ended. No awaits. Returns how many invites there were.
   */
  takeUpInvites(id, email, now) {
    const invites = this.sql
      .exec(
        `SELECT i.*, s.status AS series_status FROM series_invites i LEFT JOIN series s ON s.id = i.series_id
         WHERE i.status = 'waiting' AND lower(i.email) = lower(?) ORDER BY i.created_at, i.id`,
        email,
      )
      .toArray();
    for (const invite of invites) {
      if (invite.series_status !== 'active') {
        this.write("UPDATE series_invites SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'waiting'", now, invite.id);
        continue;
      }
      const already = this.seriesMember(invite.series_id, id);
      if (already?.status !== 'active') {
        this.write(
          `INSERT INTO series_members (series_id, customer_id, people, players, name, email, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT(series_id, customer_id) DO UPDATE SET people = excluded.people, players = excluded.players, name = excluded.name, email = excluded.email,
             status = 'active', created_at = excluded.created_at, updated_at = excluded.updated_at`,
          invite.series_id, id, invite.people, invite.players || '[]', invite.name, invite.email, invite.created_at, now,
        );
      }
      this.write("UPDATE series_invites SET status = 'joined', customer_id = ?, updated_at = ? WHERE id = ? AND status = 'waiting'", id, now, invite.id);
    }
    return invites.length;
  }

  /** Waiting series invites by series id, for the floor: { id, name, email, people } each (round 7). No awaits. */
  waitingInvites() {
    const out = new Map();
    for (const r of this.sql.exec("SELECT * FROM series_invites WHERE status = 'waiting' ORDER BY created_at, id").toArray()) {
      if (!out.has(r.series_id)) out.set(r.series_id, []);
      out.get(r.series_id).push({ id: r.id, name: r.name, email: r.email, people: r.people });
    }
    return out;
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
        // Round 6: the spend report's backfill reaches every order once read_all_orders is granted
        this.grantedScopes = info.scopes;
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
    // Round 8: weekly and fortnightly table holds get their dates up to the horizon plus 7 days, every run
    try {
      const holds = this.extendHoldSeries(rules, Date.now());
      if (holds.length) result.holdSeries = holds;
    } catch (error) {
      console.error('Lair: could not extend table hold series', error);
    }
    // Weekly regulars roll forward: once a session ends, they get a seat in the next one.
    try {
      const rolled = this.rollSeries(rules, Date.now());
      if (rolled.seated || rolled.full) result.regulars = rolled;
    } catch (error) {
      console.error('Lair: could not roll weekly regulars forward', error);
    }
    // The same maintenance emails the staff the week's birthdays, once a day after 9am, so they can pick gifts.
    try {
      const birthdays = this.birthdaySummary(rules, Date.now());
      if (birthdays) result.birthdays = birthdays;
    } catch (error) {
      console.error('Lair: birthday summary failed', error);
    }
    // Library holds (round 6) that weren't collected in time go back on the shelf, and the member hears.
    try {
      const expired = this.expireLibraryHolds(rules, Date.now());
      if (expired) result.libraryHolds = { expired };
    } catch (error) {
      console.error('Lair: could not expire library holds', error);
    }
    // Round 9: early access: unpaid claims let go after 48 hours, offers past their closing time closed (their unpaid claims
    // let go), and the emails of offers that open later sent when they open
    try {
      const offers = this.offerUpkeep(Date.now());
      if (offers) result.offers = offers;
    } catch (error) {
      console.error('Lair: early access upkeep failed', error);
    }
    // Round 7: birthday gifts' product codes the webhook couldn't see used (gifts from before round 7, and codes that ran
    // out with no recorded use) are checked with Shopify, a few a run.
    try {
      const giftCodes = await this.checkGiftCodes({ limit: GIFT_CHECKS_A_RUN, expired: true });
      if (giftCodes) result.giftCodes = { checked: giftCodes };
    } catch (error) {
      console.error('Lair: could not check gift codes', error);
    }
    // Round 9: monthly accounts' bills on the 1st, bills whose payment link couldn't be made yet, and one reminder after
    // 14 days
    try {
      const bills = await this.billMaintenance(rules, Date.now());
      if (bills.made.length || bills.retried.length || bills.reminded.length) result.bills = bills;
    } catch (error) {
      console.error('Lair: could not make monthly bills', error);
    }
    this.note({ connection: result });
    return result;
  }
}

// Round 9: the running tab and monthly accounts (src/tab.js)
Object.assign(Lair.prototype, runningTabMethods);
// Round 9, play: "I'm interested" and "Maybe" (src/interest.js)
Object.assign(Lair.prototype, interestMethods);
// Round 9: turnouts, lists and early access offers (src/community.js)
Object.assign(Lair.prototype, communityMethods);

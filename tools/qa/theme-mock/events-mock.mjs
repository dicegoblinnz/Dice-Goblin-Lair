// Mock lair_event metaobjects for render.mjs: the 30 real weekly events created in the store
// (events-qa/events-data.json, the same data the Shopify entries were made from). That file isn't in this repo: without
// it, QA_EVENTS below stands in, the weekly events the live flows use (tools/qa/live), with made-up details.
// Images render as /img/event-<slug>__WxH.svg placeholders; events-qa/shot.mjs serves the real PNG crops there.
//
// Round 4 (3 Oct, ev3 worktree): every event also has `payment` ("In store", "Online", "Online or in store", or
// empty, which means in store), `lock_tables` (true, false or empty, which means false) and a price note, and two
// one-off events are added, so every payment and table case shows in the preview:
//   - Pokémon TCG league: "Online or in store", $10 entry, price note "$10, or buy a booster". It gets a capacity
//     here (24) so it can be joined: the Lair app only takes sign-ups for events with a capacity.
//   - Warhammer & other wargames: empty payment (in store), soft tables T20-T21, game tables
//     "T14+T15, T16+T17, T18+T19", $10 a player, lock_tables false.
//   - Riftbound store championship (new, one-off, the Sunday after next): "Online", $25 entry, 32 places,
//     tables T4-T13 locked.
//   - Learn to play: Riftbound (new, one-off, next Sunday): free, 8 places, no payment at all.
//   - Every other event: empty payment and empty lock_tables, as in the store today.
//
// Round 6 (5 Oct, sessions worktree): every event has a `game` (contract v6 section 6: the calendar's second row of
// chips, under TCGs by game and under TTRPG by game or system), and the prices show each case the calendar shows:
// an entry fee (D&D), a price note on its own (Commander night: "Entry: a booster pack", as TCG nights now are),
// Free for a $0 fee (board game night) and nothing at all (Learn to play: Riftbound).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'events-qa', 'events-data.json');
const SIZES = { 'cyberpunk-red': '400x225', daggerheart: '400x225', 'dc-universe': '400x225', 'mtg-premodern': '320x180', rapscallion: '320x180' };

const field = (value) => ({ value });

/**
 * The stand-in for events-data.json: weekly events from early September 2026, so every date the flows pick is on.
 *   - D&D on Saturdays 6pm and Sundays 10am, $15 at the counter, 12 places
 *   - Pokémon TCG league on Fridays 5pm (round 4 makes it "Online or in store", $10, 24 places)
 *   - Warhammer & other wargames on Thursdays 6pm (round 4 gives it soft tables and game tables)
 *   - Commander on Wednesdays and board games on Tuesdays: free, no sign-ups (no capacity)
 */
const QA_EVENTS = [
  {
    handle: 'dnd-saturday-6pm', title: 'Dungeons & Dragons', event_type: 'rpg', starts_at: '2026-09-05T18:00:00+12:00', ends_at: '2026-09-05T22:00:00+12:00',
    repeat: 'weekly', capacity: 12, entry_fee: 15, image_slug: 'dnd', game: 'D&D 5e',
    description: 'Daring heroes, dodgy decisions and dice that never roll what you need. New players welcome.\n\nBring dice and a pencil, or borrow ours.',
  },
  {
    handle: 'dnd-sunday-10am', title: 'Dungeons & Dragons', event_type: 'rpg', starts_at: '2026-09-06T10:00:00+12:00', ends_at: '2026-09-06T14:00:00+12:00',
    repeat: 'weekly', capacity: 12, entry_fee: 15, image_slug: 'dnd', game: 'D&D 5e',
    description: 'A Sunday morning table for adventurers of every level.\n\nBring dice and a pencil, or borrow ours.',
  },
  {
    handle: 'pokemon-tcg-league', title: 'Pokémon TCG league', event_type: 'tcg', starts_at: '2026-09-04T17:00:00+12:00', ends_at: '2026-09-04T20:00:00+12:00',
    repeat: 'weekly', image_slug: 'pokemon', game: 'Pokémon', description: 'League play every Friday: bring a deck, earn points, win promos.',
  },
  {
    handle: 'warhammer-wargames', title: 'Warhammer & other wargames', event_type: 'wargame', starts_at: '2026-09-03T18:00:00+12:00', ends_at: '2026-09-03T23:00:00+12:00',
    repeat: 'weekly', image_slug: 'warhammer', game: 'Warhammer', description: 'Bring your army and find a game: Warhammer 40,000, Age of Sigmar, Kill Team and friends.',
  },
  {
    handle: 'commander-night', title: 'Commander night', event_type: 'tcg', starts_at: '2026-09-02T18:00:00+12:00', ends_at: '2026-09-02T22:00:00+12:00',
    repeat: 'weekly', image_slug: 'mtg', game: 'Magic: The Gathering', price_note: 'Entry: a booster pack',
    description: 'Casual Magic: The Gathering Commander pods. Just turn up.',
  },
  {
    handle: 'board-game-night', title: 'Board game night', event_type: 'social', starts_at: '2026-09-01T18:00:00+12:00', ends_at: '2026-09-01T22:00:00+12:00',
    repeat: 'weekly', image_slug: 'board-games', entry_fee: 0, description: 'Grab a game off the library shelf and a table. Free, and the goblins can teach you.',
  },
];

/** Round 4 changes to the real events, by handle */
const ROUND4 = {
  'pokemon-tcg-league': { payment: 'Online or in store', entry_fee: 10, price_note: '$10, or buy a booster', capacity: 24 },
  'warhammer-wargames': { payment: null, lock_tables: false, tables: 'T20-T21', game_tables: 'T14+T15, T16+T17, T18+T19', entry_fee: 10 },
};

/* ---------- Lair wall-clock times (Pacific/Auckland) for the one-off events, counted from today ---------- */
const lairParts = (ms) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Pacific/Auckland', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute) };
};
const pad = (n) => String(n).padStart(2, '0');
/** The Lair date `days` from today, as { y, m, d } */
const lairDay = (days) => {
  const today = lairParts(Date.now());
  const dt = new Date(Date.UTC(today.y, today.m - 1, today.d + days));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};
/** A Lair date and hour as an ISO string with Auckland's offset that day, like 2026-10-11T11:00:00+13:00 */
const lairIso = ({ y, m, d }, hour) => {
  const guess = Date.UTC(y, m - 1, d, hour);
  const shown = lairParts(guess);
  const offset = Math.round((Date.UTC(shown.y, shown.m - 1, shown.d, shown.h, shown.mi) - guess) / 60000);
  const sign = offset < 0 ? '-' : '+';
  return `${y}-${pad(m)}-${pad(d)}T${pad(hour)}:00:00${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
};

/**
 * The one-off events: next Sunday (a week on when today is Sunday) and the Sunday after, and tonight's D&D (6-10pm on
 * the day of the run, $15 at the counter), so the live flows have an event today whatever the day.
 */
function oneOffs() {
  const today = lairParts(Date.now());
  const weekday = new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay();
  const toSunday = (7 - weekday) % 7 || 7;
  const next = lairDay(toSunday);
  const after = lairDay(toSunday + 7);
  const tonight = lairDay(0);
  return [
    {
      handle: 'dnd-tonight', title: 'Dungeons & Dragons', event_type: 'rpg',
      starts_at: lairIso(tonight, 18), ends_at: lairIso(tonight, 22), repeat: null, capacity: 12, entry_fee: 15, game: 'D&D 5e',
      description: 'A one-shot for anyone who wants to roll some dice tonight. Pregens provided.',
      image_slug: 'dnd',
    },
    {
      handle: 'learn-riftbound', title: 'Learn to play: Riftbound', event_type: 'learn',
      starts_at: lairIso(next, 13), ends_at: lairIso(next, 15), repeat: null, capacity: 8, game: 'Riftbound',
      description: 'New to Riftbound? A staff goblin walks you through your first games with starter decks, so you don’t need cards of your own.\n\nIt’s free. Places are limited, so join to save yours.',
      image_slug: 'riftbound',
    },
    {
      handle: 'riftbound-store-championship', title: 'Riftbound store championship', event_type: 'tournament',
      starts_at: lairIso(after, 11), ends_at: lairIso(after, 17), repeat: null, capacity: 32, entry_fee: 25, game: 'Riftbound',
      payment: 'Online', tables: 'T4-T13', lock_tables: true,
      description: 'Swiss rounds, a top cut and prizes for the best decks in the Lair, plus a promo card for everyone who plays.\n\nBring a legal deck and sleeves. Entry is paid online when you join, and that locks in your place.',
      image_slug: 'riftbound',
    },
  ];
}

export function lairEvents() {
  let rows = QA_EVENTS;
  try {
    rows = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  } catch {
    // no events-data.json here: the stand-in
  }
  rows = [...rows.map((e) => ({ ...e, ...(ROUND4[e.handle] || {}) })), ...oneOffs()];
  return rows.map((e) => ({
    system: { handle: e.handle, type: 'lair_event' },
    title: field(e.title),
    event_type: field(e.event_type),
    // game (single-line text, round 6): what it's for, under the calendar's TCG and TTRPG chips
    game: field(e.game || null),
    starts_at: field(e.starts_at),
    ends_at: field(e.ends_at),
    repeat: field(e.repeat || null),
    repeat_until: field(e.repeat_until || null),
    skip_dates: field(e.skip_dates || null),
    capacity: field(e.capacity || null),
    tables: field(e.tables || null),
    // entry_fee (number_decimal) and game_tables were added to lair_event on 3 Oct (ev2 worktree)
    entry_fee: field(e.entry_fee != null ? Number(e.entry_fee) : null),
    game_tables: field(e.game_tables || null),
    // payment (single-line text: "In store", "Online", "Online or in store") and lock_tables (boolean): round 4
    payment: field(e.payment || null),
    lock_tables: field(typeof e.lock_tables === 'boolean' ? e.lock_tables : null),
    price_note: field(e.price_note || null),
    product: field(null),
    link: field(null),
    description: field(e.description),
    image: field({ __seed: `event-${e.image_slug}__${SIZES[e.image_slug] || '240x135'}`, alt: e.title, width: 240, height: 135 }),
  }));
}

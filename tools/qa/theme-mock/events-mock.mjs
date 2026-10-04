// Mock lair_event metaobjects for render.mjs: the 30 real weekly events created in the store
// (events-qa/events-data.json, the same data the Shopify entries were made from).
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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'events-qa', 'events-data.json');
const SIZES = { 'cyberpunk-red': '400x225', daggerheart: '400x225', 'dc-universe': '400x225', 'mtg-premodern': '320x180', rapscallion: '320x180' };

const field = (value) => ({ value });

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

/** The two one-off events: next Sunday (a week on when today is Sunday) and the Sunday after */
function oneOffs() {
  const today = lairParts(Date.now());
  const weekday = new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay();
  const toSunday = (7 - weekday) % 7 || 7;
  const next = lairDay(toSunday);
  const after = lairDay(toSunday + 7);
  return [
    {
      handle: 'learn-riftbound', title: 'Learn to play: Riftbound', event_type: 'learn',
      starts_at: lairIso(next, 13), ends_at: lairIso(next, 15), repeat: null, capacity: 8,
      description: 'New to Riftbound? A staff goblin walks you through your first games with starter decks, so you don’t need cards of your own.\n\nIt’s free. Places are limited, so join to save yours.',
      image_slug: 'riftbound',
    },
    {
      handle: 'riftbound-store-championship', title: 'Riftbound store championship', event_type: 'tournament',
      starts_at: lairIso(after, 11), ends_at: lairIso(after, 17), repeat: null, capacity: 32, entry_fee: 25,
      payment: 'Online', tables: 'T4-T13', lock_tables: true,
      description: 'Swiss rounds, a top cut and prizes for the best decks in the Lair, plus a promo card for everyone who plays.\n\nBring a legal deck and sleeves. Entry is paid online when you join, and that locks in your place.',
      image_slug: 'riftbound',
    },
  ];
}

export function lairEvents() {
  let rows = [];
  try {
    rows = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  } catch {
    return [];
  }
  rows = [...rows.map((e) => ({ ...e, ...(ROUND4[e.handle] || {}) })), ...oneOffs()];
  return rows.map((e) => ({
    system: { handle: e.handle, type: 'lair_event' },
    title: field(e.title),
    event_type: field(e.event_type),
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

// Round 13: follow a game (contract v13-feeds). Mo (10 Oct 2026), looking at five calendar ideas: "I did like option 5
// but I didn't want to get rid of what we have. Is there a way to have both? Like a see what we have page and the actual
// booking page which is what we have?" The theme's Our games page shows a tile per game; its Follow button subscribes
// people to GET /feeds/<key>.ics, every date of that game's events, which their calendar app fetches again by itself.
// Run with: node --test test/   (under TZ=UTC and TZ=Pacific/Auckland)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings } from '../src/core.js';
import { FEED_MESSAGES, feedKeys, feedSlug } from '../src/reminders.js';
import worker from '../src/index.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Saturday 10 October 2026, 6am in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 9, 9, 17, 0);
const realNow = Date.now;

function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      if (/^\s*(select|with)/i.test(query)) {
        const rows = stmt.all(...bindings);
        return { toArray: () => rows, one: () => rows[0] };
      }
      stmt.run(...bindings);
      return { toArray: () => [], one: () => undefined };
    },
  };
  const kv = new Map();
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: () => {} };
}

const ROOMS = [{ id: 'main-room', name: 'Main room', code: 'T', tables: 21, seats: 4, order: 1 }];
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// The store's regular events, as the Lair reads them from Shopify (src/shopify.js): Magic on Mondays and Wednesdays (two
// entries, one game), Pokémon on Fridays, Warhammer on Thursdays with game tables, Blood on the Clocktower a week early
// in October (a one-off) and then monthly, and Oddity Alley (no Game: its title) over a weekend.
const EVENTS = [
  { id: 'magic-night-monday', title: 'Magic night', game: 'Magic: The Gathering', type: 'tcg', start: at('2026-10-12', 18), end: at('2026-10-12', 22), repeat: 'weekly', priceNote: 'A booster pack, with a promo when we have them' },
  { id: 'magic-night-wednesday', title: 'Magic night', game: 'Magic: The Gathering', type: 'tcg', start: at('2026-10-14', 18), end: at('2026-10-14', 22), repeat: 'weekly', skipDates: ['2026-10-28'], priceNote: 'A booster pack, with a promo when we have them' },
  { id: 'pokemon-night', title: 'Pokémon night', game: 'Pokémon', type: 'tcg', start: at('2026-10-09', 19), end: at('2026-10-10', 0), repeat: 'weekly' },
  { id: 'warhammer-night', title: 'Warhammer night', game: 'Warhammer', type: 'wargame', start: at('2026-10-15', 18), end: at('2026-10-16', 0), repeat: 'weekly', entryFee: 1000, gameTables: 'T8+T9, T10+T11', tables: 'T8-T11' },
  { id: 'blood-on-the-clocktower-october', title: 'Blood on the Clocktower', game: 'Blood on the Clocktower', type: 'social', start: at('2026-10-18', 12), end: at('2026-10-18', 18), capacity: 40, entryFee: 1000 },
  { id: 'blood-on-the-clocktower', title: 'Blood on the Clocktower', game: 'Blood on the Clocktower', type: 'social', start: at('2026-11-22', 12), end: at('2026-11-22', 18), repeat: 'monthly', capacity: 40, entryFee: 1000 },
  { id: 'oddity-alley-november', title: 'Oddity Alley', game: null, type: 'market', start: at('2026-11-21', 10), end: at('2026-11-21', 16), days: 2, freeEntry: true },
  // past the 60-day horizon (9 December), but a one-off: in, as the calendar shows one-offs whatever their date
  { id: 'oddity-alley-december', title: 'Oddity Alley', game: null, type: 'market', start: at('2026-12-12', 10), end: at('2026-12-12', 16), days: 2, freeEntry: true },
];
const useEvents = (events, settings = {}) => {
  lair.rulesCache = rulesFromSettings({ lair_horizon_days: 60, ...settings }, ROOMS, events);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  lair.rulesSource = 'theme "Dice Goblin 2.0" (1, live)';
};

let lair;
let looked;
const feed = async (key, { proxy = false, method = 'GET' } = {}) => {
  const path = proxy ? `feeds/${key}.ics` : `internal/feed/${key}`;
  const headers = proxy ? { 'X-Lair-Origin': 'https://www.dicegoblin.nz', 'X-Lair-Customer': '' } : { 'X-Lair-Internal': '1' };
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, { method, headers }));
  return { status: response.status, type: response.headers.get('Content-Type'), headers: response.headers, text: await response.text() };
};
/** The VEVENTs of a calendar, unfolded, as { UID, DTSTART, DTEND, SUMMARY, DESCRIPTION, URL } */
const vevents = (text) => text.replace(/\r\n /g, '').split('BEGIN:VEVENT').slice(1).map((block) => Object.fromEntries(
  block.split('\r\n').map((line) => line.match(/^([A-Z-]+)(?:;[^:]*)?:(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]),
));
const header = (text, name) => text.replace(/\r\n /g, '').split('\r\n').find((line) => line.startsWith(`${name}:`) || line.startsWith(`${name};`));
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

beforeEach(() => {
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'example-shop.myshopify.com', PUBLIC_URL: 'https://lair.test' });
  looked = 0;
  lair.person = async (id) => {
    looked += 1;
    return { customerId: id || null, staff: false, gm: false, tags: [] };
  };
  useEvents(EVENTS);
});
afterEach(() => {
  Date.now = realNow;
});

test('round 13: a game\'s feed key is its Game (else its title) the way the theme writes it, plus its kind\'s and "all"', () => {
  assert.equal(feedSlug('Magic: The Gathering'), 'magic-the-gathering');
  assert.equal(feedSlug('Pokémon'), 'pokemon');
  assert.equal(feedSlug('  Blood on the Clocktower '), 'blood-on-the-clocktower');
  assert.equal(feedSlug('Warhammer & friends'), 'warhammer-and-friends');
  assert.equal(feedSlug('ONE PIECE'), 'one-piece');
  assert.equal(feedSlug('!!!'), '');
  assert.equal(feedSlug('x'.repeat(100)).length, 80);
  assert.deepEqual(feedKeys(EVENTS[0]), ['magic-the-gathering', 'kind-tcg', 'all']);
  assert.deepEqual(feedKeys(EVENTS[6]), ['oddity-alley', 'kind-market', 'all'], 'no Game: its title');
  assert.deepEqual(feedKeys({ title: 'Quiz night', game: '  ', type: null }), ['quiz-night', 'kind-other', 'all']);
});

test('round 13: a game\'s feed has every date of its events from a fortnight back to the horizon, skips left out, one UID per date', async () => {
  const res = await feed('magic-the-gathering');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.type, 'text/calendar; charset=utf-8');
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=900');
  assert.match(res.headers.get('Content-Disposition'), /^inline; filename="dice-goblin-magic-the-gathering\.ics"$/);
  assert.equal(header(res.text, 'X-WR-CALNAME'), 'X-WR-CALNAME:Magic: The Gathering at Dice Goblin');
  assert.equal(header(res.text, 'X-WR-TIMEZONE'), 'X-WR-TIMEZONE:Pacific/Auckland');
  assert.equal(header(res.text, 'REFRESH-INTERVAL'), 'REFRESH-INTERVAL;VALUE=DURATION:PT6H');
  const dates = vevents(res.text);
  // Mondays from 12 Oct to 7 Dec (9) and Wednesdays from 14 Oct to 2 Dec without 28 Oct (7); 9 Dec 6pm is past the horizon
  assert.equal(dates.length, 16);
  assert.ok(dates.every((d) => d.SUMMARY === 'Magic night'));
  const first = dates[0];
  assert.equal(first.UID, 'magic-night-monday-2026-10-12@dicegoblin.nz');
  assert.equal(first.DTSTART, stamp(at('2026-10-12', 18)));
  assert.equal(first.DTEND, stamp(at('2026-10-12', 22)));
  assert.equal(first.URL, 'https://www.dicegoblin.nz/pages/events-calendar#event=magic-night-monday%402026-10-12');
  assert.equal(first.DESCRIPTION, 'A booster pack\\, with a promo when we have them\\n\\nhttps://www.dicegoblin.nz/pages/events-calendar#event=magic-night-monday%402026-10-12');
  assert.match(first.LOCATION, /^Dice Goblin\\, /);
  assert.ok(!dates.some((d) => d.UID.includes('2026-10-28')), 'the skipped Wednesday');
  assert.ok(dates.every((d, i) => i === 0 || d.DTSTART >= dates[i - 1].DTSTART), 'in date order');
  assert.ok(!res.text.includes('Pokémon'), 'only its own game');
  // RFC 5545: CRLF lines, none over 75 octets, and the calendar closes
  assert.ok(res.text.endsWith('END:VCALENDAR\r\n'));
  assert.ok(res.text.split('\r\n').every((line) => Buffer.byteLength(line) <= 75), 'folded');
  assert.ok(!/[^\r]\n/.test(res.text), 'CRLF only');
});

test('round 13: the last fortnight stays in; a one-off with a series is one game; a weekend market is a date a day', async () => {
  const pokemon = vevents((await feed('pokemon')).text);
  assert.equal(pokemon[0].UID, 'pokemon-night-2026-10-09@dicegoblin.nz', 'last night, still there');
  assert.equal(pokemon[0].DTSTART, stamp(at('2026-10-09', 19)));
  assert.equal(pokemon.at(-1).UID, 'pokemon-night-2026-12-04@dicegoblin.nz');

  const clock = await feed('blood-on-the-clocktower');
  assert.equal(header(clock.text, 'X-WR-CALNAME'), 'X-WR-CALNAME:Blood on the Clocktower at Dice Goblin');
  assert.deepEqual(vevents(clock.text).map((d) => d.UID), ['blood-on-the-clocktower-october-2026-10-18@dicegoblin.nz', 'blood-on-the-clocktower-2026-11-22@dicegoblin.nz']);
  assert.match(vevents(clock.text)[0].DESCRIPTION, /^\$10 a person\\, paid at the counter\\n\\n/);

  const alley = vevents((await feed('oddity-alley')).text);
  assert.deepEqual(alley.map((d) => [d.UID, d.DTSTART, d.DTEND]), [
    ['oddity-alley-november-2026-11-21@dicegoblin.nz', stamp(at('2026-11-21', 10)), stamp(at('2026-11-21', 16))],
    ['oddity-alley-november-2026-11-22@dicegoblin.nz', stamp(at('2026-11-22', 10)), stamp(at('2026-11-22', 16))],
    ['oddity-alley-december-2026-12-12@dicegoblin.nz', stamp(at('2026-12-12', 10)), stamp(at('2026-12-12', 16))],
    ['oddity-alley-december-2026-12-13@dicegoblin.nz', stamp(at('2026-12-13', 10)), stamp(at('2026-12-13', 16))],
  ], 'a one-off past the horizon is in; a series stops at it');
  assert.match(alley[0].DESCRIPTION, /^Free entry\\n\\n/);

  const warhammer = vevents((await feed('warhammer')).text);
  assert.match(warhammer[0].DESCRIPTION, /^\$10 a person\\, paid at the counter\\n\\n/);
});

test('round 13: a kind\'s feed and "all"', async () => {
  const cards = await feed('kind-tcg');
  assert.equal(header(cards.text, 'X-WR-CALNAME'), 'X-WR-CALNAME:Card nights at Dice Goblin');
  const uids = vevents(cards.text).map((d) => d.UID);
  assert.ok(uids.some((u) => u.startsWith('magic-night-monday-')) && uids.some((u) => u.startsWith('pokemon-night-')));
  assert.ok(!uids.some((u) => u.startsWith('warhammer-night-')));
  const all = await feed('all');
  assert.equal(header(all.text, 'X-WR-CALNAME'), 'X-WR-CALNAME:Events at Dice Goblin');
  const every = vevents(all.text).map((d) => d.UID.replace(/-\d{4}-\d{2}-\d{2}@dicegoblin\.nz$/, ''));
  for (const id of EVENTS.map((e) => e.id)) assert.ok(every.includes(id), id);
  assert.equal((await feed('kind-wargame')).status, 200);
  assert.equal((await feed('kind-rpg')).status, 404, 'no TTRPG events here');
});

test('round 13: an unknown key is a 404; without Shopify\'s events it\'s a 503 to try later, never an empty calendar', async () => {
  for (const key of ['dungeons-and-dragons', 'magic', 'kind-', '']) {
    const res = await feed(key);
    assert.equal(res.status, 404, key);
    assert.equal(res.text, FEED_MESSAGES.unknown);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  }
  lair.rulesSource = 'built-in defaults';
  const later = await feed('magic-the-gathering');
  assert.equal(later.status, 503);
  assert.equal(later.text, FEED_MESSAGES.later);
  assert.equal(later.headers.get('Retry-After'), '900');
});

test('round 13: through the app proxy it\'s public and looks nobody up; HEAD works; a date that moves keeps its UID', async () => {
  const res = await feed('pokemon', { proxy: true });
  assert.equal(res.status, 200, res.text);
  assert.equal(looked, 0, 'no customer lookup for a calendar app');
  assert.equal((await feed('pokemon', { proxy: true, method: 'HEAD' })).status, 200);
  assert.equal((await feed('pokemon/extra', { proxy: true })).status, 404);
  // the per-date calendar file (the reminder email's Add to calendar) has the same UID, so it's the same entry
  const one = await lair.fetch(new Request('https://lair.test/internal/eventics/pokemon-night%402026-10-16', { headers: { 'X-Lair-Internal': '1' } }));
  assert.match(await one.text(), /\r\nUID:pokemon-night-2026-10-16@dicegoblin\.nz\r\n/);
  // Pokémon moves to 6:30pm in Shopify: the same dates (same UIDs) at the new time, so calendars move them
  useEvents(EVENTS.map((e) => (e.id === 'pokemon-night' ? { ...e, start: at('2026-10-09', 18, 30) } : e)));
  const moved = vevents((await feed('pokemon')).text).find((d) => d.UID === 'pokemon-night-2026-10-16@dicegoblin.nz');
  assert.equal(moved.DTSTART, stamp(at('2026-10-16', 18, 30)));
});

test('round 13: the Worker serves /feeds/<key>.ics publicly on its own address, and only lower-case keys', async () => {
  const seen = [];
  const env = {
    SHOP: 'ep0qiq-rp.myshopify.com', SHOPIFY_CLIENT_SECRET: 'hush',
    LAIR: { idFromName: () => 'id', get: () => ({ fetch: async (req) => { seen.push({ url: req.url, internal: req.headers.get('X-Lair-Internal'), method: req.method }); return new Response('BEGIN:VCALENDAR'); } }) },
  };
  assert.equal((await worker.fetch(new Request('https://worker.test/feeds/magic-the-gathering.ics'), env)).status, 200);
  assert.deepEqual(seen.at(-1), { url: 'https://worker.test/internal/feed/magic-the-gathering', internal: '1', method: 'GET' });
  assert.equal((await worker.fetch(new Request('https://worker.test/feeds/kind-tcg.ics', { method: 'HEAD' }), env)).status, 200);
  assert.equal(seen.at(-1).url, 'https://worker.test/internal/feed/kind-tcg');
  const before = seen.length;
  for (const path of ['/feeds/Magic.ics', '/feeds/../internal/setup.ics', '/feeds/magic', '/feeds/a/b.ics']) {
    assert.equal((await worker.fetch(new Request(`https://worker.test${path}`), env)).status, 404, path);
  }
  assert.equal((await worker.fetch(new Request('https://worker.test/feeds/pokemon.ics', { method: 'POST' }), env)).status, 404);
  assert.equal(seen.length, before);
});

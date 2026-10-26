// Round 20, the TTRPG page's sessions in the page (26 Oct 2026, contract v20-sessions-feed). Mo: "Sessions in the page".
// On the theme mock, with the shop metafield lair.sessions stubbed (mockState.sessionsFeed):
//  1. Live mode, the page as Shopify serves it (no script): the list is in the HTML, day by day, the board's rows, each
//     opening its session with #game=<id>; a session that has started is left out; nothing about the GM.
//  2. Live mode with the script, against a stubbed Lair app: the rows are drawn again from the board's data (a seat taken
//     since shows; private, pending and started sessions and a weekly game's later sessions stay out; no GM names); a row
//     opens its session's sheet; the row is the tap target (44px or more); no sideways scroll at 390px.
//  3. The Lair app down: the printed list stays. 4. No metafield: no list, and the page works. 5. Book a table: no list.
//  6. Demo mode (the lab): no real sessions printed; the script fills the list from the demo board, and a row opens it.
// No console errors throughout. Screenshots in OUT.
// Usage: TZ=Pacific/Auckland DG_THEME=/path/to/theme [PORT=4996] [OUT=dir] node tools/qa/round20/sessions.mjs
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round20-sessions');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, watch, go, shot, flat, overflowX, lairKey, iso, today, OUT } = lib;
const PORT = Number(process.env.PORT || 4996);
const BASE = `http://localhost:${PORT}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TZ = 'Pacific/Auckland';
const addDays = (key, n) => lairKey(Date.parse(iso(key, '12:00')) + n * DAY);
const at = (key, hm) => Date.parse(iso(key, hm));
// The page as Shopify makes it runs on the real clock, so these checks do too: no page clock here (lib.context sets one)
const NOW = Date.now();
const TOMORROW = addDays(today, 1);
const clock = (ms) => {
  const [h, mi] = new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)).split(':').map(Number);
  if (h === 0 && mi === 0) return 'midnight';
  return `${h % 12 === 0 ? 12 : h % 12}${mi ? `:${String(mi).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
};
const dayLabel = (ms) => {
  const key = lairKey(ms);
  if (key === today) return 'Today';
  if (key === TOMORROW) return 'Tomorrow';
  return new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(ms)).replace(',', '');
};
const realContext = (size, js = true) => browser.newContext({
  ...(size === 'phone' ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } }),
  javaScriptEnabled: js,
});

const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 500) => page.waitForTimeout(ms);

/* ---------- what the Lair app has: the board's games (with the GM's name, as the board gets them) ---------- */
const game = (id, title, system, start, hours, extra = {}) => ({
  id, title, system, gm: 'Rangi Hohaia', gmBio: 'Rangi has run games since 1999.', level: 'some', blurb: 'Secret notes for the table.',
  start, end: start + hours * HOUR, seats: 5, taken: 1, status: 'open', schedule: 'one-shot', seriesId: null, seatPrice: 1500,
  private: false, tables: ['T3'], room: 'main-room', ...extra,
});
// two hours from now, on the hour
const SOON = Math.ceil((NOW + 2 * HOUR) / HOUR) * HOUR;
const boardGames = [
  game('g-on-now', 'Already rolling', 'D&D 5e', NOW - HOUR, 3),
  game('g-soon', 'Tomb of Horrors', 'AD&D', SOON, 4, { taken: 4 }),
  game('g-weekly-1', 'The Sunless Citadel', 'D&D 5e', at(addDays(today, 2), '18:30'), 3.5, { schedule: 'weekly', seriesId: 'sr_1', level: 'new' }),
  game('g-weekly-2', 'The Sunless Citadel', 'D&D 5e', at(addDays(today, 9), '18:30'), 3.5, { schedule: 'weekly', seriesId: 'sr_1', level: 'new' }),
  game('g-full', 'Curse of Strahd', 'D&D 5e', at(addDays(today, 3), '14:00'), 4, { taken: 5, status: 'full', seatPrice: 2000 }),
  game('g-private', 'The Secret Keep', 'Pathfinder 2e', at(addDays(today, 3), '18:00'), 4, { private: true }),
  game('g-pending', 'Waiting for an OK', 'Mothership', at(addDays(today, 3), '18:00'), 4, { status: 'pending' }),
  game('g-own-name', 'Daggerheart', 'Daggerheart', at(addDays(today, 4), '12:00'), 4, { taken: 0, seats: 4 }),
];
const LISTED = ['g-soon', 'g-weekly-1', 'g-full', 'g-own-name'];
const listedGames = LISTED.map((id) => boardGames.find((g) => g.id === id));
const TITLES = listedGames.map((g) => g.title);
const DAYS = [...new Set(listedGames.map((g) => dayLabel(g.start)))];
const TIMES = listedGames.map((g) => `${clock(g.start)} to ${clock(g.end)}`);
/** The metafield as the Lair app writes it (src/sessions-feed.js), made before a seat went at Tomb of Horrors */
const feed = {
  v: 1,
  updated: new Date(NOW - 5 * 60_000).toISOString(),
  days: 14,
  sessions: boardGames
    .filter((g) => !g.private && ['open', 'full'].includes(g.status) && g.id !== 'g-weekly-2')
    .map((g) => ({
      id: g.id, title: g.title, system: g.system, start: new Date(g.start).toISOString(), end: new Date(g.end).toISOString(),
      schedule: g.schedule, newPlayers: g.level === 'new', price: g.seatPrice,
      seatsLeft: g.id === 'g-soon' ? 2 : Math.max(0, g.seats - g.taken), full: g.status === 'full',
    })),
};

let floorDown = false;
m.mockState.before = async (req, res, url) => {
  if (!url.pathname.startsWith('/apps/liar/')) return false;
  for await (const chunk of req) void chunk;
  const route = url.pathname.replace('/apps/liar', '');
  if (floorDown && route === '/floor') {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end('{"error":"down"}');
    return true;
  }
  let body = { ok: true };
  if (route === '/floor') {
    body = { now: Date.now(), bookings: [], blocks: [], games: boardGames, events: [], eventJoins: {}, eventSpots: {}, gameSpots: {}, eventInterest: {}, shopTables: [], openings: [], features: {} };
  } else if (route === '/me') body = { customer: null };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
};

const listRows = (page) => page.$$eval('[data-play-sessions] .play-row', (rows) => rows.map((r) => ({
  time: r.querySelector('.play-row__time')?.textContent.trim(),
  title: r.querySelector('.play-row__title')?.textContent.trim(),
  href: r.querySelector('.play-row__title')?.getAttribute('href'),
  meta: r.querySelector('.play-row__meta')?.textContent.replace(/\s+/g, ' ').trim(),
  left: r.querySelector('.play-row__left')?.textContent.trim(),
  full: r.querySelector('.play-row__left')?.classList.contains('is-full'),
})));
const days = (page) => page.$$eval('[data-play-sessions] .play-week__head', (hs) => hs.map((h) => h.textContent.trim()));
const sessionsText = (page) => page.$eval('[data-play-sessions]', (el) => el.textContent).catch(() => '');

m.globalSettings.lair_mode = 'live';
m.mockState.sessionsFeed = feed;

/* ---------- 1. the page as Shopify serves it, with no script ---------- */
{
  const ctx = await realContext('phone', false);
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gm-games', null);
  const rows = await listRows(page);
  check('served: the heading says what it is', flat(await page.$eval('#play-sessions-title', (h) => h.textContent)) === 'TTRPG sessions in the next two weeks');
  check('served: every public session to come, soonest first (the one on now left out)', JSON.stringify(rows.map((r) => r.title)) === JSON.stringify(TITLES), rows.map((r) => r.title));
  check('served: grouped by day, today and tomorrow by name', JSON.stringify(await days(page)) === JSON.stringify(DAYS), [await days(page), DAYS]);
  check('served: the board\'s clock and words', JSON.stringify(rows.map((r) => r.time)) === JSON.stringify(TIMES), [rows.map((r) => r.time), TIMES]);
  check('served: the system, how often, the price, and New players welcome', rows[1].meta === 'D&D 5e · Weekly · $15 a seat · New players welcome', rows[1].meta);
  check('served: a game named after its system says TTRPG', rows[3].meta === 'TTRPG · One-shot · $15 a seat', rows[3].meta);
  check('served: seats left, one seat, and full', rows[0].left === '2 seats left' && rows[2].left === 'Full' && rows[2].full && rows[3].left === '4 seats left', rows.map((r) => r.left));
  check('served: each row opens its session on the page', rows.every((r, i) => r.href === `#game=${LISTED[i]}`), rows.map((r) => r.href));
  const text = await sessionsText(page);
  check('served: nothing about the GM, and no private or pending games', !/Rangi|since 1999|Secret|Waiting for an OK|T3/.test(text), text.slice(0, 300));
  await shot(page, 'served-phone', '[data-play-sessions]');
  await ctx.close();
}

/* ---------- 2. with the script: drawn again from the board's data ---------- */
{
  const ctx = await realContext('phone');
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gm-games', null);
  await page.waitForFunction(() => window.Lair && window.Lair.store && !window.Lair.store.isDemo, null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('[data-play-sessions-body]')?.dataset.html, null, { timeout: 15000 });
  const rows = await listRows(page);
  check('script: the same sessions, from the board\'s data', JSON.stringify(rows.map((r) => r.title)) === JSON.stringify(TITLES), rows.map((r) => r.title));
  check('script: a seat taken since the page was made shows', rows[0].left === '1 seat left', rows[0].left);
  check('script: a weekly game once (its next session), with the same words as the page', rows.filter((r) => r.title === 'The Sunless Citadel').length === 1 && rows[1].meta === 'D&D 5e · Weekly · $15 a seat · New players welcome', rows[1]);
  check('script: the full one at its own price', rows[2].meta === 'D&D 5e · One-shot · $20 a seat' && rows[2].full, rows[2]);
  const text = await sessionsText(page);
  check('script: no GM names, no private, pending or started sessions', !/Rangi|since 1999|Secret|Waiting for an OK|Already rolling/.test(text), text.slice(0, 300));
  const box = await page.$eval('[data-play-sessions] .play-row', (r) => r.getBoundingClientRect().height);
  check('script: the whole row is the tap target (44px or more)', box >= 44, box);
  check('script: no sideways scroll at 390px', (await overflowX(page)) <= 0, await overflowX(page));
  await page.locator('[data-play-sessions] .play-row').nth(1).scrollIntoViewIfNeeded();
  await shot(page, 'script-phone', '[data-play-sessions]');
  await shot(page, 'script-phone-page', null, true);
  // tapping a row (not just its title) opens that session's sheet
  const row = page.locator('[data-play-sessions] .play-row').nth(1);
  await row.scrollIntoViewIfNeeded();
  const rb = await row.boundingBox();
  await page.mouse.click(rb.x + rb.width - 12, rb.y + rb.height - 8);
  await settle(page, 900);
  const sheet = await page.evaluate(() => {
    const open = [...document.querySelectorAll('dialog[open]')];
    return { hash: window.location.hash, open: open.map((d) => flat(d.textContent).slice(0, 200)) };
    function flat(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  });
  check('script: tapping a row opens its session', sheet.hash === '#game=g-weekly-1' && sheet.open.some((t) => t.includes('The Sunless Citadel')), sheet);
  await shot(page, 'script-phone-sheet');
  check('script: no console errors', page.errors.length === 0, page.errors);
  await ctx.close();
}

/* ---------- 2b. a computer ---------- */
{
  const ctx = await realContext('desktop');
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gm-games', null);
  await page.waitForFunction(() => document.querySelector('[data-play-sessions-body]')?.dataset.html, null, { timeout: 15000 });
  await page.locator('[data-play-sessions]').scrollIntoViewIfNeeded();
  await shot(page, 'script-desktop', '[data-play-sessions]');
  check('desktop: no console errors', page.errors.length === 0, page.errors);
  await ctx.close();
}

/* ---------- 3. the Lair app down: the printed list stays ---------- */
{
  floorDown = true;
  const ctx = await realContext('phone');
  const page = watch(await ctx.newPage());
  page.errors = [];
  await go(page, BASE, '/pages/gm-games', null);
  await settle(page, 1500);
  const rows = await listRows(page);
  check('app down: the printed list stays, as Shopify served it', rows.length === 4 && rows[0].left === '2 seats left', rows.map((r) => `${r.title}: ${r.left}`));
  await ctx.close();
  floorDown = false;
}

/* ---------- 3b. nothing in the next two weeks ---------- */
{
  m.mockState.sessionsFeed = { ...feed, sessions: [] };
  const saved = boardGames.splice(0, boardGames.length);
  const ctx = await realContext('phone', false);
  const plain = await ctx.newPage();
  await go(plain, BASE, '/pages/gm-games', null);
  const served = await plain.$eval('[data-play-sessions-body]', (el) => el.textContent.trim()).catch(() => '');
  check('empty, served: says so, and how to fill it', /^Nothing on the list for the next two weeks yet/.test(served), served);
  await ctx.close();
  const ctx2 = await realContext('phone');
  const page = watch(await ctx2.newPage());
  await go(page, BASE, '/pages/gm-games', null);
  await page.waitForFunction(() => document.querySelector('[data-play-sessions-body]')?.dataset.html, null, { timeout: 15000 });
  const drawn = await page.$eval('[data-play-sessions-body]', (el) => el.textContent.trim());
  check('empty, script: the same words', drawn === served, [drawn, served]);
  check('empty: no console errors', page.errors.length === 0, page.errors);
  await ctx2.close();
  boardGames.push(...saved);
  m.mockState.sessionsFeed = feed;
}

/* ---------- 4. no metafield, and 5. Book a table ---------- */
{
  m.mockState.sessionsFeed = null;
  const ctx = await realContext('phone');
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gm-games', null);
  await page.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.data, null, { timeout: 15000 });
  await settle(page, 800);
  check('no metafield: no list, and the board still works', !(await page.$('[data-play-sessions]')) && Boolean(await page.$('.play__layout')));
  check('no metafield: no console errors', page.errors.length === 0, page.errors);
  m.mockState.sessionsFeed = feed;
  await go(page, BASE, '/pages/book-a-table', null);
  await settle(page, 800);
  check('Book a table: no sessions list (TTRPG sessions page only)', !(await page.$('[data-play-sessions]')));
  check('Book a table: no console errors', page.errors.length === 0, page.errors);
  await ctx.close();
}

/* ---------- 6. demo mode (the lab) ---------- */
{
  m.globalSettings.lair_mode = 'demo';
  const ctx = await realContext('phone', false);
  const plain = await ctx.newPage();
  await go(plain, BASE, '/pages/gm-games', null);
  const served = await plain.$eval('[data-play-sessions-body]', (el) => ({ rows: el.querySelectorAll('.play-row').length, text: el.textContent.trim() })).catch(() => null);
  check('demo, served: no real sessions in the page (the board is pretend), just the board\'s loading line', served && served.rows === 0 && served.text.length > 0 && !/Tomb of Horrors|Sunless|Strahd/.test(served.text), served);
  await ctx.close();
  const ctx2 = await realContext('phone');
  const page = watch(await ctx2.newPage());
  await go(page, BASE, '/pages/gm-games', null);
  await page.waitForFunction(() => document.querySelector('[data-play-sessions-body]')?.dataset.html, null, { timeout: 15000 });
  const rows = await listRows(page);
  check('demo: the list comes from the demo board', rows.length > 0 && !rows.some((r) => /Tomb of Horrors|Strahd/.test(r.title)), rows.map((r) => r.title));
  if (rows.length) {
    const first = page.locator('[data-play-sessions] .play-row').first();
    await first.scrollIntoViewIfNeeded();
    await shot(page, 'demo-phone', '[data-play-sessions]');
    const fb = await first.boundingBox();
    await page.mouse.click(fb.x + fb.width - 12, fb.y + fb.height - 8);
    await settle(page, 900);
    const opened = await page.evaluate((title) => [...document.querySelectorAll('dialog[open]')].some((d) => d.textContent.includes(title)), rows[0].title);
    check('demo: a row opens its demo session', opened, rows[0]);
  }
  check('demo: no console errors', page.errors.length === 0, page.errors);
  await ctx2.close();
}

const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed. Screenshots: ${OUT}`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

// Round 14b, the one booking page after an independent check against the mock-up Mo approved (12 Oct 2026). What it
// changed, checked in demo mode on the theme mock:
//   1. the first screen: the intro is just its heading (one line at 320 to 414px and on desktop), no sideways scroll,
//      See all our games under Run a game and Host your own event, which sit side by side on a 390px phone
//   2. wide screens: a table's sheet opens beside it without the page jumping, on screen under the header (1366x768,
//      1280x720, a tablet), and it's the short popover: no blurb, the time and GM on one line, seats and price on the next
//   3. phones: the page dims behind the sheet; Back closes the sheet (then leaves the page); closed with its X, Back
//      leaves at once; the sheet's Join, then Back closes the board's form; Book, then Back leaves the booking; a #game=
//      link's sheet closes on Back and stays closed; dragging the handle down closes it
//   4. a game waiting for staff to approve it isn't on the public map (its tables are taken)
//   5. a free table's How long: 2, 3 or 4 hours (and till close), 3 to start with; Book says 3 hours
//   6. ?show=none stays none on a reload; the badge sits at the top right of a game's tables; at the same time the
//      events come before the games; Looking for players says spaces; on desktop the month counts each day's games
//      looking for players; the booking's map draws an event's tables blue
//   7. no console errors
// Usage: DG_THEME=/path/to/theme PORT=4955 [OUT=/dir] node tools/qa/round14/one-page-b.mjs
// Exits 1 on a FAIL.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round14b-one-page');
fs.mkdirSync(OUT, { recursive: true });
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || process.env.QA_PORT || 4955);
const BASE = `http://localhost:${PORT}`;

/* ---------- the page clock: today, 1pm in Auckland ---------- */
const TZ = 'Pacific/Auckland';
const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const offset = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${key}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const today = lairKey(Date.now());
const AT = Date.parse(`${today}T13:00:00${offset(today)}`);
const CLOCK = `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  return ok;
};

const server = await m.serve(PORT);
const browser = await chromium.launch();
const errors = [];

async function session({ width, height, phone }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, timezoneId: TZ, locale: 'en-NZ' });
  await ctx.addInitScript(CLOCK);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${width}: ${e.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(`${width}: ${msg.text()}`); });
  const open = async (where, { blank = true } = {}) => {
    if (blank) await page.goto('about:blank');
    await page.goto(`${BASE}${where}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('lair-play')?.ready === true, null, { timeout: 20000 });
    await page.waitForTimeout(300);
  };
  const tap = async (selector) => {
    const el = page.locator(selector).first();
    await el.scrollIntoViewIfNeeded();
    if (phone) await el.tap();
    else await el.click();
    await page.waitForTimeout(250);
  };
  /** The day and hour the map shows (the page's own selectDay, as a pick) */
  const at = async (day, minutes) => {
    await page.evaluate(([d, mins]) => document.querySelector('lair-play').selectDay(d, { from: 'pick', time: mins }), [day, minutes]);
    await page.waitForTimeout(250);
  };
  return { ctx, page, open, tap, at };
}

/* ---------- 1. the first screen ---------- */
for (const width of [320, 360, 390, 414]) {
  const { ctx, page, open } = await session({ width, height: 844, phone: true });
  for (const where of ['/pages/book-a-table', '/pages/gm-games', '/pages/events-calendar', '/pages/events-calendar?show=events,ttrpg,tables']) {
    await open(where);
    const first = await page.evaluate(() => {
      const h1 = document.querySelector('.page-intro__title');
      const range = document.createRange();
      range.selectNodeContents(h1);
      const shown = (s) => Boolean(document.querySelector(s)?.getClientRects().length);
      const extras = [...document.querySelectorAll('.play__extra')].map((b) => Math.round(b.getBoundingClientRect().top));
      const games = document.querySelector('.play__games');
      const dow = document.querySelector('[data-play-strip] .is-today .play-sday__dow');
      return {
        heading: h1.textContent.trim(), lines: range.getClientRects().length, lede: shown('.page-intro .lede'), gob: shown('.page-intro__gob'),
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        extras, gamesAfter: Boolean(games && games.compareDocumentPosition(document.querySelector('.play__extras')) & Node.DOCUMENT_POSITION_PRECEDING),
        today: dow ? dow.scrollWidth <= dow.clientWidth + 1 : true,
        strip: Math.round(document.querySelector('[data-play-strip]').getBoundingClientRect().top),
      };
    });
    check(`${width}px ${where}: the heading on one line ("${first.heading}"), the intro's words and Gobgob hidden, no sideways scroll`, first.lines === 1 && !first.lede && !first.gob && first.sideways <= 0, first);
    if (where === '/pages/book-a-table') {
      check(`${width}px: See all our games under Run a game and Host your own event; Today fits its day`, first.gamesAfter && first.today, first);
      if (width === 390) check('390px: Run a game and Host your own event side by side', first.extras.length === 2 && first.extras[0] === first.extras[1], first.extras);
    }
  }
  await ctx.close();
}

/* ---------- 2. wide screens: the popover in place, on screen, short ---------- */
for (const vp of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 820, height: 1180 }]) {
  const { ctx, page, open, at } = await session({ ...vp, phone: false });
  await open('/pages/events-calendar?show=events,ttrpg,tables');
  const plan = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const t = window.Lair.store.time;
    for (let i = 0; i < 10; i += 1) {
      const day = t.addDays(t.today(), i);
      if (!play.selectable(play.dayInfo(day))) continue;
      const items = play.dayItems(day);
      const game = items.find((x) => x.kind === 'game' && !x.projected);
      if (game) return { day, minutes: Math.ceil(t.minutesOf(game.start) / 60) * 60 };
    }
    return null;
  });
  if (!check(`${vp.width}x${vp.height}: a day with a game`, Boolean(plan), plan)) {
    await ctx.close();
    continue;
  }
  await at(plan.day, plan.minutes);
  const ids = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const at2 = play.mapMoment();
    const kinds = {};
    for (const b of document.querySelectorAll('lair-play-floor [data-table]')) {
      const k = play.tableAt(b.dataset.table, at2).kind;
      if (!kinds[k]) kinds[k] = b.dataset.table;
    }
    return [kinds.game, kinds.event, kinds.free, 'F1', 'G1', 'T20', 'T4'].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  });
  for (const id of ids) {
    // the line above the map just under the header, as someone reading it would have it
    await page.evaluate(() => {
      const play = document.querySelector('lair-play');
      if (play.sheet.open) play.closeSheet({ restore: false });
      const r = document.querySelector('[data-play-summary]').getBoundingClientRect();
      window.scrollBy(0, r.top - 80);
    });
    await page.waitForTimeout(250);
    const before = await page.evaluate((i) => {
      const r = document.querySelector(`lair-play-floor [data-table="${i}"]`).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, scroll: Math.round(scrollY), shown: r.top >= 0 && r.bottom <= innerHeight };
    }, id);
    if (!before.shown) {
      // a table below the fold: the person scrolls to it first
      await page.evaluate((i) => document.querySelector(`lair-play-floor [data-table="${i}"]`).scrollIntoView({ block: 'center' }), id);
      await page.waitForTimeout(200);
    }
    const target = await page.evaluate((i) => {
      const r = document.querySelector(`lair-play-floor [data-table="${i}"]`).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, scroll: Math.round(scrollY) };
    }, id);
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(800);
    const after = await page.evaluate((i) => {
      const sheet = document.querySelector('[data-play-sheet]');
      const s = sheet.getBoundingClientRect();
      const t = document.querySelector(`lair-play-floor [data-table="${i}"]`).getBoundingClientRect();
      const top = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sticky-top')) || 72;
      return {
        open: sheet.open, view: sheet.dataset.view, docked: sheet.classList.contains('is-docked'), scroll: Math.round(scrollY),
        sheet: [Math.round(s.top), Math.round(s.bottom)], table: [Math.round(t.top), Math.round(t.bottom)], header: Math.round(top), vh: innerHeight,
        blurb: Boolean(sheet.querySelector('.play-sheet__text')) && sheet.dataset.view !== 'free' && sheet.dataset.view !== 'booked',
        brief: Boolean(sheet.querySelector('.play-sheet__brief')), focus: document.activeElement?.id,
      };
    }, id);
    const onScreen = after.sheet[0] >= after.header && after.sheet[1] <= after.vh;
    const tableShown = after.table[0] >= after.header && after.table[1] <= after.vh;
    const both = Math.max(after.sheet[1], after.table[1]) - Math.min(after.sheet[0], after.table[0]) <= after.vh - after.header - 16;
    const jump = Math.abs(after.scroll - target.scroll);
    // it may scroll, but never more than it takes to show the sheet (round 14's jumped 500 to 700px, off the sheet)
    check(`${vp.width}x${vp.height} ${id} (${after.view}): the sheet opens beside the table, both on screen under the header, the page moving ${jump}px at most the sheet's height`, after.open && !after.docked && onScreen && (tableShown || !both) && jump <= after.sheet[1] - after.sheet[0] + 20 && after.focus === 'play-sheet-title', { target, after });
    if (after.view === 'game' || after.view === 'event') check(`${vp.width}x${vp.height} ${id}: the short popover (no blurb; the time and the rest on a line)`, after.brief && !after.blurb, after);
  }
  await page.screenshot({ path: `${OUT}/wide-${vp.width}x${vp.height}.png` });
  await ctx.close();
}

/* ---------- 3. phones: dimmed, Back, the X, Join, Book, a #game= link, a drag ---------- */
{
  const { ctx, page, open, tap, at } = await session({ width: 390, height: 844, phone: true });
  await open('/pages/gm-games');
  const game = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const t = window.Lair.store.time;
    for (let i = 1; i < 10; i += 1) {
      const day = t.addDays(t.today(), i);
      if (!play.selectable(play.dayInfo(day))) continue;
      const item = play.dayItems(day).find((x) => x.kind === 'game' && !x.projected && play.gameOf(x)?.status === 'open');
      if (item) return { day, minutes: Math.ceil(t.minutesOf(item.start) / 60) * 60, table: play.gameOf(item).tables[0], id: item.gameId };
    }
    return null;
  });
  if (check('phone: a game with seats to try the sheet on', Boolean(game), game)) {
    const where = async () => page.evaluate(() => ({
      url: window.location.href, sheet: Boolean(document.querySelector('[data-play-sheet]')?.open),
      dialogs: [...document.querySelectorAll('lair-play dialog[open]')].map((d) => d.className || d.localName), depth: history.state?.playDepth || 0,
      mode: document.querySelector('lair-play')?.dataset.mode,
    }));
    // dimmed, Back closes the sheet, Back again leaves
    await at(game.day, game.minutes);
    await tap(`lair-play-floor [data-table="${game.table}"]`);
    const dim = await page.evaluate((id) => ({
      docked: document.querySelector('lair-play').hasAttribute('data-sheet-docked'),
      overlay: getComputedStyle(document.querySelector('lair-play'), '::before').content !== 'none',
      lifted: getComputedStyle(document.querySelector(`lair-play-floor [data-table="${id}"]`)).zIndex,
      depth: history.state?.playDepth || 0,
    }), game.table);
    check('phone: the sheet dims the page, all but its table, and is a step in the history', dim.docked && dim.overlay && dim.lifted === '4' && dim.depth === 1, dim);
    await page.screenshot({ path: `${OUT}/phone-dim.png` });
    await page.goBack();
    await page.waitForTimeout(500);
    const b1 = await where();
    check('phone: Back closes the sheet and stays on the page', !b1.sheet && /\/pages\/gm-games/.test(b1.url), b1);
    await page.goBack();
    await page.waitForTimeout(500);
    check('phone: Back again leaves the page', (await page.evaluate(() => window.location.href)) === 'about:blank', await page.evaluate(() => window.location.href));

    // the X: Back then leaves at once
    await open('/pages/gm-games');
    await at(game.day, game.minutes);
    await tap(`lair-play-floor [data-table="${game.table}"]`);
    await tap('[data-play-sheet] [data-play-close]');
    await page.waitForTimeout(500);
    const x1 = await where();
    await page.goBack();
    await page.waitForTimeout(500);
    check('phone: closed with its X, the sheet leaves no step behind: Back leaves the page', !x1.sheet && x1.depth === 0 && (await page.evaluate(() => window.location.href)) === 'about:blank', x1);

    // Join: the board's form takes the sheet's step; Back closes it
    await open('/pages/gm-games');
    await at(game.day, game.minutes);
    await tap(`lair-play-floor [data-table="${game.table}"]`);
    await tap('[data-play-sheet] [data-play-sheet-act="join-game"]');
    await page.waitForSelector('gm-board [data-sheet][open] [data-session-join]', { timeout: 8000 });
    await page.waitForTimeout(400);
    const j1 = await where();
    const len1 = await page.evaluate(() => history.length);
    await page.goBack();
    await page.waitForTimeout(800);
    const j2 = await where();
    check('phone: the sheet\'s Join hands its step to the board\'s form, and Back closes the form on the page', j1.depth === 1 && !j1.sheet && j1.dialogs.length === 1 && !j2.dialogs.length && !j2.sheet && /\/pages\/gm-games/.test(j2.url), { j1, j2, len1 });
    await page.goBack();
    await page.waitForTimeout(500);
    check('phone: then Back leaves the page', (await page.evaluate(() => window.location.href)) === 'about:blank', await page.evaluate(() => window.location.href));

    // a #game= link: its sheet closes on Back and stays closed
    await open(`/pages/gm-games#game=${encodeURIComponent(game.id)}`);
    await page.waitForTimeout(600);
    const l1 = await where();
    await page.goBack();
    await page.waitForTimeout(1000);
    const l2 = await where();
    check('phone: a #game= link opens its sheet; Back closes it and it stays closed', l1.dialogs.length === 1 && !l2.dialogs.length && /\/pages\/gm-games/.test(l2.url), { l1, l2 });
    await page.goBack();
    await page.waitForTimeout(500);
    check('phone: then Back leaves the page', (await page.evaluate(() => window.location.href)) === 'about:blank', await page.evaluate(() => window.location.href));

    // Host your own event with the sheet open: the calendar's form takes the sheet's step; Back closes it
    await open('/pages/gm-games');
    await at(game.day, game.minutes);
    await tap(`lair-play-floor [data-table="${game.table}"]`);
    await page.evaluate(() => document.querySelector('[data-cal-host]').click());
    await page.waitForTimeout(600);
    const h1 = await where();
    await page.goBack();
    await page.waitForTimeout(800);
    const h2 = await where();
    check('phone: with the sheet open, Host your own event opens its form in the sheet\'s step, and Back closes the form on the page', !h1.sheet && h1.dialogs.length === 1 && h1.depth === 1 && !h2.dialogs.length && /\/pages\/gm-games/.test(h2.url), { h1, h2 });
    await page.goBack();
    await page.waitForTimeout(500);
    check('phone: then Back leaves the page', (await page.evaluate(() => window.location.href)) === 'about:blank', await page.evaluate(() => window.location.href));

    // a switch (or Looking for players) tapped with the sheet open: the address keeps it, through a reload
    for (const [label, selector] of [['Events', '[data-play-layer="events"]'], ['Looking for players', '[data-play-show] [data-play-players]']]) {
      await open('/pages/gm-games');
      await at(game.day, game.minutes);
      await tap(`lair-play-floor [data-table="${game.table}"]`);
      await tap(selector);
      await page.waitForTimeout(800);
      const shown = () => page.evaluate(() => ({
        on: [...document.querySelectorAll('[data-play-layer][aria-pressed="true"]')].map((b) => b.dataset.playLayer).join(),
        players: document.querySelector('lair-play').players, url: window.location.search,
      }));
      const s1 = await shown();
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.querySelector('lair-play')?.ready === true, null, { timeout: 20000 });
      const s2 = await shown();
      check(`phone: ${label} tapped with the sheet open stays in the address (and a reload keeps it)`, s1.on === s2.on && s1.players === s2.players && s1.url === s2.url, { s1, s2 });
    }

    // a link to another page with the sheet open: it goes there, and stays (no Back from the sheet stops it)
    await open('/pages/gm-games');
    await at(game.day, game.minutes);
    await tap(`lair-play-floor [data-table="${game.table}"]`);
    await page.locator('header a[href="/"]').first().tap();
    await page.waitForTimeout(1500);
    const away = await page.evaluate(() => window.location.pathname);
    check('phone: with the sheet open, the logo still goes to the home page (and stays)', away === '/', away);

    // a drag down on the handle closes it, and leaves no step behind
    await open('/pages/gm-games');
    await at(game.day, game.minutes);
    await tap(`lair-play-floor [data-table="${game.table}"]`);
    const grip = await page.evaluate(() => {
      const r = document.querySelector('[data-play-sheet] .play-sheet__grip').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i += 1) {
      await page.mouse.move(grip.x, grip.y + i * 22);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(500);
    const d1 = await where();
    await page.goBack();
    await page.waitForTimeout(500);
    check('phone: dragging the handle down closes the sheet, and Back then leaves the page', !d1.sheet && d1.depth === 0 && (await page.evaluate(() => window.location.href)) === 'about:blank', d1);
  }

  // a free table: Book takes the sheet's step; Back leaves the booking, then the page
  await open('/pages/book-a-table');
  const free = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const store = window.Lair.store;
    const t = store.time;
    for (let i = 1; i < 10; i += 1) {
      const day = t.addDays(t.today(), i);
      const slot = store.slots(day).find((x) => x.bookable && x.minutes >= 17 * 60 && x.minutes <= store.openWindow(day).closeMin - 240);
      if (!slot) continue;
      const id = ['G1', 'T4', 'P3', 'T18'].find((x) => play.canBook(x, slot.start, slot.start + 4 * 3600000) && !store.softHold(x, slot.start, slot.start + 4 * 3600000));
      if (id) return { day, minutes: slot.minutes, id };
    }
    return null;
  });
  if (check('phone: a free table to book', Boolean(free), free)) {
    await at(free.day, free.minutes);
    await tap(`lair-play-floor [data-table="${free.id}"]`);
    const lengths = await page.evaluate(() => ({
      chips: [...document.querySelectorAll('[data-play-sheet] [data-play-len]')].map((b) => `${b.textContent.trim()}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`),
      book: document.querySelector('[data-play-sheet] [data-play-book-table]')?.textContent.trim(),
    }));
    const end = new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, hour: 'numeric', hourCycle: 'h12' }).format(new Date(Date.parse(`${free.day}T${String(free.minutes / 60 + 3).padStart(2, '0')}:00:00${offset(free.day)}`))).replace(/\s/g, '').toLowerCase();
    check('phone: How long is 2, 3 or 4 hours (then till close), 3 to start with, and Book says so', lengths.chips.slice(0, 3).join() === '2 hours,3 hours*,4 hours' && !lengths.chips.some((c) => /^1 hour/.test(c)) && new RegExp(`to ${end}$`).test(lengths.book || ''), { lengths, end });
    await tap('[data-play-sheet] [data-play-book-table]');
    await page.waitForTimeout(600);
    const k1 = await page.evaluate(() => ({ mode: document.querySelector('lair-play').dataset.mode, depth: history.state?.playDepth || 0, book: Boolean(history.state?.playBook) }));
    await page.goBack();
    await page.waitForTimeout(600);
    const k2 = await page.evaluate(() => ({ mode: document.querySelector('lair-play')?.dataset.mode, url: window.location.pathname }));
    check('phone: Book turns to the booking (taking the sheet\'s step), and Back comes back to the map', k1.mode === 'book' && k1.book && k1.depth === 0 && k2.mode === 'browse' && k2.url === '/pages/book-a-table', { k1, k2 });
    await page.goBack();
    await page.waitForTimeout(500);
    check('phone: then Back leaves the page', (await page.evaluate(() => window.location.href)) === 'about:blank', await page.evaluate(() => window.location.href));
  }

  /* ---------- 4. a game waiting for approval isn't public ---------- */
  await open('/pages/gm-games');
  const pending = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const t = window.Lair.store.time;
    const g = window.Lair.store.data.games.find((x) => x.status === 'pending' && x.start > Date.now());
    if (!g) return null;
    return { day: t.key(g.start), minutes: Math.ceil(t.minutesOf(g.start) / 60) * 60, tables: g.tables, title: g.title, shown: play.shown(g) };
  });
  if (check('a game waiting for approval in the demo', Boolean(pending), pending)) {
    await at(pending.day, pending.minutes);
    const seen = await page.evaluate((p) => {
      const kinds = p.tables.map((id) => document.querySelector(`lair-play-floor [data-table="${id}"]`)?.dataset.kind);
      const labels = p.tables.map((id) => document.querySelector(`lair-play-floor [data-table="${id}"]`)?.getAttribute('aria-label') || '');
      const rows = [...document.querySelectorAll('[data-play-list-body] [data-play-open]')].map((n) => n.textContent.trim());
      return { kinds, named: labels.some((l) => l.includes(p.title)) || rows.includes(p.title) };
    }, pending);
    check(`a game waiting for approval (${pending.title}) isn't on the public map or the list: its tables are taken`, !pending.shown && seen.kinds.every((k) => k === 'booked') && !seen.named, { pending, seen });
  }

  /* ---------- 6. the smaller things ---------- */
  await open('/pages/book-a-table?show=none');
  const none = await page.evaluate(() => ({ on: [...document.querySelectorAll('[data-play-layer][aria-pressed="true"]')].length, url: window.location.search }));
  check('?show=none: everything stays switched off on a reload', none.on === 0 && /show=none/.test(none.url), none);
  await open('/pages/events-calendar?show=events,ttrpg,tables');
  const more = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const store = window.Lair.store;
    const t = store.time;
    const out = { badges: [], order: true, orderDays: 0 };
    for (let i = 0; i < 14; i += 1) {
      const day = t.addDays(t.today(), i);
      if (!play.selectable(play.dayInfo(day))) continue;
      const items = play.dayItems(day);
      for (let j = 1; j < items.length; j += 1) {
        if (items[j].start === items[j - 1].start && items[j].kind === 'event' && items[j - 1].kind === 'game') out.order = false;
      }
      if (items.some((x, j) => j && x.start === items[j - 1].start && x.kind !== items[j - 1].kind)) out.orderDays += 1;
    }
    // the badges at this moment: one per game, at the top right of its tables
    const at = play.mapMoment();
    const seen = new Map();
    for (const b of document.querySelectorAll('lair-play-floor [data-table]')) {
      const s = play.tableAt(b.dataset.table, at);
      if (s.kind !== 'game' || seen.has(s.game.id)) continue;
      seen.set(s.game.id, true);
      const tables = s.game.tables || [b.dataset.table];
      const withBadge = tables.filter((id) => document.querySelector(`lair-play-floor [data-table="${id}"]`)?.dataset.seats);
      const corner = tables.slice().sort((a, c) => {
        const A = store.table(a);
        const C = store.table(c);
        return (C.x + C.w) - (A.x + A.w) || A.y - C.y;
      })[0];
      out.badges.push({ game: s.game.title, tables, withBadge, corner, left: Math.max(0, s.game.seats - s.game.taken) });
    }
    return out;
  });
  check('at the same time, the day\'s events come before its games', more.order, more);
  check('a game\'s seats-left badge: one, at the top right of its tables', more.badges.every((b) => (b.left ? b.withBadge.length === 1 && b.withBadge[0] === b.corner : !b.withBadge.length)), more.badges);
  await tap('[data-play-show] [data-play-players]');
  const lfp = await page.evaluate(() => document.querySelector('[data-play-lfp-text]')?.textContent || '');
  check('Looking for players says spaces, as the rows do', !/\bplaces?\b/.test(lfp), lfp);
  await ctx.close();
}

/* ---------- 6b. desktop: the month counts Looking for players; the booking's map draws events blue ---------- */
{
  const { ctx, page, open, tap } = await session({ width: 1280, height: 900, phone: false });
  await open('/pages/gm-games?players=1');
  const month = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const t = window.Lair.store.time;
    const week = play.lookingWeek();
    const out = [];
    for (let i = 0; i < 7; i += 1) {
      const key = t.addDays(t.today(), i);
      const cell = document.querySelector(`[data-play-days] [data-play-date="${key}"]`);
      if (!cell || cell.disabled) continue;
      const n = week.filter((x) => x.day === key).length;
      out.push({ key, want: n ? String(n) : '–', got: cell.querySelector('.play-sday__count')?.textContent.trim() || null, label: cell.getAttribute('aria-label') });
    }
    return out;
  });
  check('desktop, Looking for players: each of the next seven days in the month says how many', month.length > 0 && month.every((d) => d.got === d.want && /looking for players|closed/.test(d.label)), month);
  await open('/pages/events-calendar');
  const ev = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const store = window.Lair.store;
    const t = store.time;
    for (let i = 1; i < 10; i += 1) {
      const day = t.addDays(t.today(), i);
      // an event's tables at a bookable time (the demo's events set their tables aside: still bookable, ringed)
      const slot = store.slots(day).find((x) => x.bookable && store.allBlocks().some((b) => b.occurrenceId && !b.spots && (b.tables || []).length && b.start <= x.start && x.start < b.end));
      if (slot) return { day, minutes: slot.minutes };
    }
    return null;
  });
  if (check('desktop: a time with an event holding tables', Boolean(ev), ev)) {
    await page.evaluate(([d, mins]) => {
      const play = document.querySelector('lair-play');
      play.selectDay(d, { from: 'pick', time: mins });
      play.enterBooking({ minutes: mins });
    }, [ev.day, ev.minutes]);
    await page.waitForTimeout(800);
    const colours = await page.evaluate(() => {
      const probe = document.createElement('i');
      probe.style.background = 'var(--c-mana)';
      document.body.append(probe);
      const mana = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const held = [...document.querySelectorAll('.play__book .floor__table[data-status="event"]')];
      const soft = [...document.querySelectorAll('.play__book .floor__table[data-soft]')];
      return {
        mana, n: held.length + soft.length,
        colours: [...new Set([...held.map((b) => getComputedStyle(b).backgroundColor), ...soft.map((b) => (getComputedStyle(b).boxShadow.includes(mana) ? mana : getComputedStyle(b).boxShadow))])],
      };
    });
    check('desktop: the booking\'s map draws an event\'s tables blue, as the map above does', colours.n > 0 && colours.colours.every((c) => c === colours.mana), colours);
  }
  await ctx.close();
}

check('no console errors', !errors.length, errors.slice(0, 5).join(' / '));
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
server?.close?.();
process.exit(fail ? 1 : 0);

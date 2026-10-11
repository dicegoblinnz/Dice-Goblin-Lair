// Round 14, the one booking page (Mo, 11 Oct: "Why not have a single page for the table and event and GM bookings ...
// have it toggle events, ttrpg games or just table space or toggle all of them or any combination of them", approved 12
// Oct). In place of round 9's tabs (round9/play.mjs, round10/tables.mjs): Show (Events, TTRPG games, Free tables), the
// map at a day and time, a sheet per table, everything on the day, Looking for players, and Book.
// Demo mode on the theme mock, phone (390px) then desktop (1280px), each in a fresh browser (a fresh demo):
//   1. each page opens with its own switch on (and its heading); switches go in the address without a reload; ?tab=,
//      ?show= and ?players= pick them; the heading follows (more than one on: "What's on at the Lair")
//   2. the days: the strip (phones), the month (a tap away on phones, always there on desktop), shading with words and
//      pips, today ringed, past days greyed
//   3. picking a day and a time: the line above the map, the map's moment, the counts on the switches, the list, and the
//      table booking follows the day
//   4. the map follows the switches (a kind switched off steps back); a TTRPG game's sheet (time, GM, seats, price) and
//      Join, which opens the board's join form: a guest joins, and the focus comes back to the table
//   5. a free table's sheet: How long, the table beside it, Book: the booking with that table and time, Who's coming
//      next; booked end to end (the ticket); Back to what's on, and the browser's Back
//   6. "I'm interested" as a guest from a game's sheet (the board's form, its checks, the thanks, the count)
//   7. an event sign-up with a guest by name, from the list's Sign up; an event's table sheet (Warhammer: Reserve)
//   8. "I'm coming" in one tap as a member (and Take it back); a guest's goes to the calendar's short form
//   9. Looking for players: the week's games with seats (and events with places), lit on the map, counts on the strip
//  10. Run a game and Host your own event open their forms; old links (#game=, #event=, ?join=, #host) open their sheets
//  11. keyboard (the strip, the month, the times, a table's sheet with Esc), axe (WCAG 2.1 A and AA), no sideways
//      scroll, no console errors
// Screenshots go to OUT, or a folder in the system's temp directory. Without AXE (axe-core's axe.min.js) the axe part is
// skipped, and says so.
// Usage: DG_THEME=/path/to/theme PORT=4953 [AXE=/path/to/axe.min.js] [OUT=/dir] node tools/qa/round14/one-page.mjs [phone|desktop]
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
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round14-one-page');
const AXE = process.env.AXE || '';
const axe = AXE && fs.existsSync(AXE) ? fs.readFileSync(AXE, 'utf8') : null;
fs.mkdirSync(OUT, { recursive: true });
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || process.env.QA_PORT || 4953);
const BASE = `http://localhost:${PORT}`;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };

/* ---------- the page clock: today, 1pm in Auckland (the Lair opens at 4pm on weekdays, 10am at weekends) ---------- */
const TZ = 'Pacific/Auckland';
const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const offset = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${key}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const iso = (key, hm) => `${key}T${hm}:00${offset(key)}`;
const today = lairKey(Date.now());
const AT = Date.parse(iso(today, '13:00'));
const CLOCK = `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;
const minutesOf = (ms) => {
  const [h, mm] = new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).format(new Date(ms)).split(':').map(Number);
  return h * 60 + mm;
};

const RUBY = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [] };
const HEADINGS = { tables: 'Book a table', ttrpg: 'Book a TTRPG session', events: 'Events calendar', all: 'What’s on at the Lair' };

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  return ok;
};
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
let axeTotal = 0;
async function scan(page, label, selector) {
  if (!axe) return;
  await page.addScriptTag({ content: axe });
  const found = await page.evaluate(async (sel) => {
    const nodes = [...document.querySelectorAll(sel)].filter((n) => n.offsetParent || n.matches('dialog[open]'));
    const out = [];
    for (const node of nodes) {
      const r = await window.axe.run(node, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
      out.push(...r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`));
    }
    return out;
  }, selector);
  axeTotal += found.length;
  check(`axe: ${label}: no WCAG 2.1 A/AA violations`, !found.length, found.join(' / '));
}
const shot = async (page, name, full = false) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full }).catch(() => {});
};

const server = await m.serve(PORT);
const browser = await chromium.launch();

for (const size of process.argv[2] ? [process.argv[2]] : ['phone', 'desktop']) {
  const phone = size === 'phone';
  const tag = size;
  const ctx = await browser.newContext({ viewport: SIZES[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, timezoneId: TZ, locale: 'en-NZ' });
  await ctx.addInitScript(CLOCK);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()); });
  const open = async (where, customer = null) => {
    m.mockState.customer = customer;
    await page.goto('about:blank');
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
  const state = () => page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    return {
      layers: [...document.querySelectorAll('[data-play-layer]')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.playLayer),
      counts: Object.fromEntries([...document.querySelectorAll('[data-play-layer]')].map((b) => [b.dataset.playLayer, Number(b.querySelector('[data-play-count]').textContent)])),
      players: play.players, mode: play.dataset.mode, day: play.day, time: play.time,
      url: window.location.pathname + window.location.search, h1: document.querySelector('h1')?.textContent.trim(),
      summary: flat(document.querySelector('[data-play-summary]')?.textContent),
      list: document.querySelector('[data-play-list-title]')?.textContent || '',
      rows: [...document.querySelectorAll('[data-play-list-body] .play-row [data-play-open]')].map((n) => n.textContent.trim()),
      booking: document.querySelector('lair-booking')?.state?.day || null,
      at: document.querySelector('lair-play-floor')?.at,
      marker: window.__playMarker || null,
    };
  });
  /** Pick a day: the strip on phones when it's there, else the month (a tap away on phones) */
  const pickDay = async (key) => {
    const strip = page.locator(`[data-play-strip] [data-play-date="${key}"]`);
    if (phone && (await strip.count()) && (await strip.first().isVisible())) {
      await tap(`[data-play-strip] [data-play-date="${key}"]`);
      return;
    }
    if (phone && (await page.getAttribute('[data-play-cal]', 'aria-expanded')) !== 'true') await tap('[data-play-cal]');
    for (let i = 0; i < 3 && !(await page.locator(`[data-play-days] [data-play-date="${key}"]`).count()); i += 1) await tap('[data-play-month="1"]');
    await tap(`[data-play-days] [data-play-date="${key}"]`);
  };
  const days = () => page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const out = [];
    for (let i = 0; i < 21; i += 1) {
      const key = window.Lair.store.time.addDays(window.Lair.store.time.today(), i);
      if (play.selectable(play.dayInfo(key))) out.push(key);
    }
    return out;
  });
  await open('/pages/book-a-table');
  await page.evaluate(() => localStorage.clear());

  /* ---------- 1. the switches each page opens with, the address and the heading ---------- */
  for (const [door, layer] of [['/pages/book-a-table', 'tables'], ['/pages/gm-games', 'ttrpg'], ['/pages/events-calendar', 'events']]) {
    await open(door);
    const s = await state();
    check(`${tag}: ${door} opens with ${layer} on (the others off) and its own heading`, s.layers.join() === layer && s.h1 === HEADINGS[layer] && !s.players, s);
  }
  await open('/pages/book-a-table');
  await page.evaluate(() => { window.__playMarker = 'same-page'; });
  const before = await page.evaluate(() => history.length);
  await tap('[data-play-layer="events"]');
  let s = await state();
  check(`${tag}: switching Events on too: no reload, ?show= in the address, and the heading is What's on`, s.marker === 'same-page' && s.url === '/pages/book-a-table?show=events%2Ctables' && s.layers.join() === 'events,tables' && s.h1 === HEADINGS.all, s);
  await tap('[data-play-layer="tables"]');
  s = await state();
  check(`${tag}: just Events on: its heading`, s.layers.join() === 'events' && s.h1 === HEADINGS.events && s.url === '/pages/book-a-table?show=events', s);
  await tap('[data-play-layer="tables"]');
  await tap('[data-play-layer="events"]');
  s = await state();
  const after = await page.evaluate(() => history.length);
  check(`${tag}: back to the page's own switch drops ?show= and adds no history (Back leaves the page)`, s.url === '/pages/book-a-table' && after === before && s.h1 === HEADINGS.tables, { s, before, after });
  await open('/pages/book-a-table?tab=events');
  s = await state();
  check(`${tag}: the old ?tab=events on the tables page switches Events on`, s.layers.join() === 'events' && s.h1 === HEADINGS.events, s);
  await open('/pages/gm-games?show=events,ttrpg,tables');
  s = await state();
  check(`${tag}: ?show= picks any mix`, s.layers.join() === 'events,ttrpg,tables' && s.h1 === HEADINGS.all, s);

  /* ---------- 2. the days ---------- */
  await open('/pages/events-calendar');
  const month = await page.evaluate(() => {
    const days = [...document.querySelectorAll('[data-play-days] [data-play-date]')];
    const open = days.filter((d) => !d.disabled);
    const busy = open.filter((d) => ['busy', 'full'].includes(d.dataset.busy));
    const strip = [...document.querySelectorAll('[data-play-strip] [data-play-date]')];
    const panel = document.querySelector('[data-play-month-panel]');
    return {
      open: open.length, shaded: open.filter((d) => d.dataset.busy).length,
      words: busy.map((d) => d.querySelector('.play-day__busy b')?.textContent.trim()),
      levels: [...new Set(open.map((d) => d.dataset.busy))].sort(),
      pips: open.every((d) => d.querySelectorAll('.play-pips i').length === 4),
      labels: busy.slice(0, 2).map((d) => d.getAttribute('aria-label')),
      today: document.querySelector('[data-play-days] [data-play-date].is-today')?.dataset.playDate,
      pastDisabled: days.filter((d) => d.classList.contains('is-past')).every((d) => d.disabled),
      legend: [...document.querySelectorAll('.play__legend li')].map((li) => li.textContent.trim()),
      monthShown: getComputedStyle(panel).display !== 'none',
      strip: strip.map((d) => d.dataset.playDate), stripShown: strip.length && strip[0].getClientRects().length > 0,
      stripLabels: strip.slice(0, 2).map((d) => d.getAttribute('aria-label')), stripPips: strip.filter((d) => !d.disabled).every((d) => d.querySelectorAll('.play-pips i').length === 4),
    };
  });
  check(`${tag}: every open day of the month is shaded, with a 4-pip meter`, month.open > 10 && month.shaded === month.open && month.pips, month);
  check(`${tag}: the four steps show (the demo seeds busy days), and Busy and Full are words on the day too`, ['busy', 'filling', 'full', 'quiet'].every((l) => month.levels.includes(l)) && month.words.length > 0 && month.words.every((w) => w === 'Busy' || w === 'Full'), month);
  check(`${tag}: a busy day's label says it in words`, month.labels.every((l) => /, (busy|full)/.test(l)), month.labels);
  check(`${tag}: today is ringed; past days are greyed and can't be picked`, month.today === today && month.pastDisabled, month);
  check(`${tag}: the legend names the four steps and the marks`, ['Quiet', 'Filling up', 'Busy', 'Full', 'Events', 'TTRPG seats'].every((w) => month.legend.includes(w)), month.legend);
  if (phone) {
    check(`${tag}: phones: a strip of seven days from today (with pips and words for each), the month a tap away`, month.stripShown && month.strip.length === 7 && month.strip[0] === today && month.stripPips && /, (quiet|filling up|busy|full|closed)/.test(month.stripLabels.join(' ')) && !month.monthShown, month);
    await tap('[data-play-cal]');
    const opened = await page.evaluate(() => ({ shown: getComputedStyle(document.querySelector('[data-play-month-panel]')).display !== 'none', expanded: document.querySelector('[data-play-cal]').getAttribute('aria-expanded'), focus: document.activeElement?.dataset.playDate || null }));
    check(`${tag}: the calendar button opens the month (aria-expanded) with the focus on a day`, opened.shown && opened.expanded === 'true' && Boolean(opened.focus), opened);
    await shot(page, `${tag}-1-month`);
    await tap('[data-play-cal]');
  } else {
    check(`${tag}: desktop: the month is always there, the strip isn't`, month.monthShown && !month.stripShown, month);
    await shot(page, `${tag}-1-month`);
  }

  /* ---------- 3. picking a day and a time ---------- */
  const open3 = await days();
  const target = await page.evaluate((keys) => {
    const play = document.querySelector('lair-play');
    return keys.find((k) => k !== play.day && play.dayItems(k).length >= 2 && play.dayInfo(k).level >= 1) || keys.find((k) => k !== play.day && play.dayItems(k).length) || keys[1];
  }, open3);
  const mapBefore = (await state()).at;
  await pickDay(target);
  s = await state();
  const after3 = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const items = play.dayItems(play.day);
    return {
      pressed: [...document.querySelectorAll(`[data-play-date="${play.day}"]`)].filter((d) => d.getClientRects().length).map((d) => d.getAttribute('aria-pressed')),
      events: items.filter((i) => i.kind === 'event').length, games: items.filter((i) => i.kind === 'game').length,
      times: document.querySelectorAll('[data-play-time]').length,
    };
  });
  const longDay = new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${target}T00:00:00${offset(target)}`)).replace(',', '');
  check(`${tag}: picking a day changes the line above the map, the map's day and the list`, s.day === target && lairKey(s.at) === target && s.at !== mapBefore && after3.pressed.every((p) => p === 'true') && s.summary.includes(longDay) && s.list === `Everything on ${longDay}`, { s, after3, target, longDay });
  check(`${tag}: the switches count that day's events (and TTRPG games)`, s.counts.events === after3.events && s.counts.ttrpg === after3.games, { counts: s.counts, after3 });
  check(`${tag}: the table booking follows the day picked`, s.booking === target, s);
  const chip = await page.$('[data-play-time]:not([aria-pressed="true"])');
  if (chip) {
    const value = await chip.getAttribute('data-play-time');
    await tap(`[data-play-time="${value}"]`);
    const s3 = await state();
    const clock = new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, hour: 'numeric', hourCycle: 'h12' }).format(new Date(s3.at)).replace(/\s/g, '').toLowerCase();
    check(`${tag}: a time chip shows the tables at that time, and the line above the map says it`, String(minutesOf(s3.at)) === value && s3.summary.includes(`at ${clock}`), { value, at: minutesOf(s3.at), summary: s3.summary, clock });
  }
  await shot(page, `${tag}-2-day`);

  /* ---------- 4. the map, a TTRPG game's sheet and Join ---------- */
  await open('/pages/gm-games?show=events,ttrpg,tables');
  const gameAt = await page.evaluate((keys) => {
    const play = document.querySelector('lair-play');
    for (const k of keys) {
      const g = play.dayItems(k).find((i) => i.kind === 'game' && !i.projected && i.seats - i.taken >= 1 && (play.gameOf(i)?.tables || []).length);
      if (g) {
        // the first hour on the hour it's on at, as the page picks it (a game at 1:30pm shows from 2pm)
        const m = window.Lair.store.time.minutesOf(g.start);
        const minutes = m % 60 ? Math.ceil(m / 60) * 60 : m;
        return { day: k, minutes, id: g.gameId, title: g.title, tables: play.gameOf(g).tables };
      }
    }
    return null;
  }, await days());
  if (!check(`${tag}: the demo has a TTRPG game with seats and tables this week`, Boolean(gameAt), gameAt)) continue;
  await pickDay(gameAt.day);
  await tap(`[data-play-time="${gameAt.minutes}"]`);
  const map4 = await page.evaluate((tables) => {
    const kind = (id) => document.querySelector(`lair-play-floor [data-table="${id}"]`);
    const all = [...document.querySelectorAll('lair-play-floor [data-table]')];
    return {
      game: tables.map((id) => kind(id)?.dataset.kind), seats: kind(tables[0])?.dataset.seats || null,
      label: kind(tables[0])?.getAttribute('aria-label'), dim: all.filter((b) => 'dim' in b.dataset).length,
      kinds: [...new Set(all.map((b) => b.dataset.kind))].sort(),
    };
  }, gameAt.tables);
  check(`${tag}: the game's tables are a TTRPG game on the map, with its seats left on a badge and in words`, map4.game.every((k) => k === 'game') && Number(map4.seats) >= 1 && /a TTRPG game/.test(map4.label) && /seats? left/.test(map4.label) && map4.dim === 0, map4);
  await tap('[data-play-layer="ttrpg"]');
  const dimmed = await page.evaluate((id) => 'dim' in (document.querySelector(`lair-play-floor [data-table="${id}"]`)?.dataset || {}), gameAt.tables[0]);
  check(`${tag}: switching TTRPG games off steps the game's tables back`, dimmed, dimmed);
  await tap('[data-play-layer="ttrpg"]');
  await tap(`lair-play-floor [data-table="${gameAt.tables[0]}"]`);
  const sheet4 = await page.evaluate(() => {
    const d = document.querySelector('[data-play-sheet]');
    const flat = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    return {
      open: d.open, view: d.dataset.view, title: flat(d.querySelector('#play-sheet-title')?.textContent), tag: flat(d.querySelector('.play-tag')?.textContent),
      where: flat(d.querySelector('.play-sheet__where')?.textContent), facts: [...d.querySelectorAll('.play-fact')].map((f) => flat(f.textContent)),
      join: flat(d.querySelector('[data-play-sheet-act="join-game"]')?.textContent), ask: Boolean(d.querySelector('[data-play-sheet-act="interest-game"]')), more: Boolean(d.querySelector('[data-play-sheet-act="game"]')),
      focus: document.activeElement?.id, picked: [...document.querySelectorAll('lair-play-floor .is-picked')].map((b) => b.dataset.table),
      docked: d.classList.contains('is-docked'),
    };
  });
  check(`${tag}: a game's table opens its sheet: TTRPG, where, the title, time, GM, seats, price, Join · $15, I'm interested, All about this game`, sheet4.open && sheet4.view === 'game' && sheet4.tag === 'TTRPG' && sheet4.title === gameAt.title && sheet4.facts.length >= 4 && /seats? left/.test(sheet4.facts.join(' ')) && /a seat/.test(sheet4.facts.join(' ')) && /^Join · \$\d+$/.test(sheet4.join) && sheet4.ask && sheet4.more, sheet4);
  check(`${tag}: the sheet takes the focus, and the game's tables are ringed on the map`, sheet4.focus === 'play-sheet-title' && sheet4.picked.join() === gameAt.tables.join(), sheet4);
  check(`${tag}: ${phone ? 'along the bottom on phones' : 'beside the table on desktop'}`, sheet4.docked === phone, sheet4);
  await shot(page, `${tag}-3-game-sheet`);
  await tap('[data-play-sheet] [data-play-sheet-act="join-game"]');
  await page.waitForSelector('gm-board [data-sheet][open] [data-session-join]', { timeout: 8000 });
  check(`${tag}: Join opens the board's join form (our sheet closes)`, !(await page.$eval('[data-play-sheet]', (d) => d.open)), 'still open');
  await page.fill('[data-session-join] [name="name"]', 'Jo Example');
  await page.fill('[data-session-join] [name="email"]', 'jo@example.com');
  await page.fill('[data-session-join] [name="phone"]', '021 555 0102');
  await page.click('[data-join-submit]');
  await page.waitForSelector('gm-board .gm-done', { timeout: 8000 }).catch(() => {});
  const joined = await page.evaluate(() => ({ done: Boolean(document.querySelector('gm-board .gm-done')), text: document.querySelector('gm-board .gm-done')?.textContent.replace(/\s+/g, ' ').slice(0, 120) }));
  check(`${tag}: a guest joins the game from its table and gets their ticket`, joined.done, joined);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const back4 = await page.evaluate(() => document.activeElement?.dataset?.table || document.activeElement?.tagName);
  check(`${tag}: closing the board's sheet puts the focus back on the table`, back4 === gameAt.tables[0], back4);

  /* ---------- 5. a free table: its sheet, Book, the booking and back ---------- */
  await open('/pages/book-a-table');
  const free = await page.evaluate((keys) => {
    const play = document.querySelector('lair-play');
    const store = window.Lair.store;
    for (const k of keys.slice(1)) {
      const slot = store.slots(k).find((x) => x.bookable && x.minutes >= 17 * 60 && x.minutes <= store.openWindow(k).closeMin - 180);
      if (!slot) continue;
      const pair = [['G1', 'G2'], ['T4', 'T5'], ['P1', 'P2']].find(([a, b]) => play.canBook(a, slot.start, slot.start + 3 * 3600000) && play.canBook(b, slot.start, slot.start + 3 * 3600000) && !store.softHold(a, slot.start, slot.start + 3 * 3600000));
      if (pair) return { day: k, minutes: slot.minutes, pair };
    }
    return null;
  }, await days());
  if (!check(`${tag}: a free pair of tables to book`, Boolean(free), free)) continue;
  await pickDay(free.day);
  await tap(`[data-play-time="${free.minutes}"]`);
  await tap(`lair-play-floor [data-table="${free.pair[0]}"]`);
  const sheet5 = await page.evaluate(() => {
    const d = document.querySelector('[data-play-sheet]');
    const flat = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    return {
      view: d.dataset.view, title: flat(d.querySelector('#play-sheet-title')?.textContent), tag: flat(d.querySelector('.play-tag')?.textContent),
      lengths: [...d.querySelectorAll('[data-play-len]')].map((b) => `${b.textContent.trim()}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`),
      add: flat(d.querySelector('.play-check')?.textContent), book: flat(d.querySelector('[data-play-book-table]')?.textContent), small: flat(d.querySelector('.play-sheet__small')?.textContent),
    };
  });
  const clock5 = new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, hour: 'numeric', hourCycle: 'h12' }).format(new Date(`${free.day}T${String(free.minutes / 60).padStart(2, '0')}:00:00${offset(free.day)}`)).replace(/\s/g, '').toLowerCase();
  check(`${tag}: a free table's sheet: Free table, "${free.pair[0]} is free from ${clock5}", How long (2 hours picked), the table beside it, Book, and what comes next`, sheet5.view === 'free' && sheet5.tag === 'Free table' && sheet5.title === `${free.pair[0]} is free from ${clock5}` && sheet5.lengths.includes('2 hours*') && new RegExp(`^Add ${free.pair[1]}`).test(sheet5.add) && /^Book /.test(sheet5.book) && /Next you tell us who’s coming\. Nothing to pay till you’re here\./.test(sheet5.small), sheet5);
  await tap('[data-play-sheet] [data-play-len="3"]');
  await tap('[data-play-sheet] [data-play-add]');
  const book5 = await page.evaluate(() => ({ book: document.querySelector('[data-play-book-table]')?.textContent.trim(), picked: [...document.querySelectorAll('lair-play-floor .is-picked')].map((b) => b.dataset.table) }));
  check(`${tag}: 3 hours and the table beside it: the Book button and the map say both`, new RegExp(`^Book ${free.pair[0]} and ${free.pair[1]}, `).test(book5.book) && book5.picked.join() === free.pair.join(), book5);
  await shot(page, `${tag}-4-free-sheet`);
  const hist5 = await page.evaluate(() => history.length);
  await tap('[data-play-sheet] [data-play-book-table]');
  await page.waitForTimeout(400);
  const booking5 = await page.evaluate(() => {
    const b = document.querySelector('lair-booking');
    return {
      mode: document.querySelector('lair-play').dataset.mode, state: { day: b.state.day, start: b.state.start, hours: b.state.hours, tables: b.state.tables, people: b.state.people },
      shown: !document.querySelector('[data-play-booking]').hidden, mapHidden: getComputedStyle(document.querySelector('.play__map')).display === 'none',
      focus: document.activeElement?.dataset?.step || document.activeElement?.tagName, who: document.querySelector('[data-who-note]')?.textContent.replace(/\s+/g, ' ').trim(),
      starts: [...document.querySelectorAll('[data-play-start]')].filter((x) => x.getAttribute('aria-pressed') === 'true').map((x) => x.dataset.playStart),
      label: document.querySelector('[data-play-times-label]').textContent, history: history.length,
    };
  });
  check(`${tag}: Book turns the page to the booking with those tables, that time and 3 hours, enough people for two tables`, booking5.mode === 'book' && booking5.shown && booking5.mapHidden && booking5.state.day === free.day && booking5.state.start === free.minutes && booking5.state.hours === 3 && booking5.state.tables.join() === free.pair.join() && booking5.state.people === 5, booking5);
  check(`${tag}: Who's coming is next (the focus is there), it says the tables are sorted, and the times above are the start times`, booking5.focus === 'who' && /^Sorted: /.test(booking5.who) && booking5.label === 'Start time' && booking5.starts.join() === String(free.minutes) && booking5.history === hist5 + 1, booking5);
  await shot(page, `${tag}-5-booking`);
  // the page leaves the booking alone: a tick, the people and the times stay as they're set
  await page.check('lair-booking input[name="extra"][value="celebrating"]');
  const stuck = await page.evaluate(() => {
    const b = document.querySelector('lair-booking');
    return { ticked: b.state.extras.has('celebrating') && document.querySelector('lair-booking input[name="extra"][value="celebrating"]').checked, tables: b.state.tables, mode: document.querySelector('lair-play').dataset.mode };
  });
  check(`${tag}: a tick in the booking sticks, and the tables stay picked`, stuck.ticked && stuck.tables.join() === free.pair.join() && stuck.mode === 'book', stuck);
  await page.click('[data-stepper="people"] [data-step-down]');
  await page.fill('#bk-name', 'Aroha Example');
  await page.fill('#bk-email', 'aroha@example.com');
  await page.fill('#bk-phone', '021 555 0101');
  if (await page.$('lair-booking input[name="agree"]')) await page.check('lair-booking input[name="agree"]');
  // four people at two tables: tick Wargame for the double setup, as the booking says
  const fit = await page.evaluate(() => document.querySelector('[data-who-note]')?.textContent || '');
  if (/Remove|tick/.test(fit)) await page.check('lair-booking input[name="extra"][value="wargame"]');
  await page.click('lair-booking [data-submit]');
  await page.waitForSelector('lair-booking [data-done]:not([hidden])', { timeout: 10000 }).catch(() => {});
  const ticket = await page.evaluate(() => ({ ref: document.querySelector('lair-booking .ticket-qr__ref')?.textContent.trim(), qr: Boolean(document.querySelector('lair-booking [data-ticket-code] svg')), title: document.querySelector('lair-booking .ticket__title')?.textContent.trim(), tables: document.querySelector('lair-booking [data-done] .summary')?.textContent.replace(/\s+/g, ' ') }));
  check(`${tag}: booked end to end from the free table's sheet: the ticket, its QR and the tables`, /^[A-Z]{1,3}-[A-Z]+-\d{1,2}$/.test(ticket.ref || '') && ticket.qr && /See you/.test(ticket.title || '') && ticket.tables.includes(`${free.pair[0]}, ${free.pair[1]}`), { ticket, free });
  await shot(page, `${tag}-6-booked`);
  await tap('[data-play-back]');
  await page.waitForTimeout(500);
  const back5 = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const ids = window.__booked || [];
    return { mode: play.dataset.mode, url: window.location.pathname + window.location.search, map: getComputedStyle(document.querySelector('.play__map')).display !== 'none', kinds: ids.map((id) => document.querySelector(`lair-play-floor [data-table="${id}"]`)?.dataset.kind) };
  });
  const kinds5 = await page.evaluate((ids) => ids.map((id) => document.querySelector(`lair-play-floor [data-table="${id}"]`)?.dataset.kind), free.pair);
  check(`${tag}: Back to what's on: the map again, at the time booked, with those tables booked now`, back5.mode === 'browse' && back5.map && back5.url === '/pages/book-a-table' && kinds5.every((k) => k === 'booked'), { back5, kinds5 });
  // the browser's Back leaves the booking too (and stays on the page)
  await tap('[data-play-book]');
  await page.waitForTimeout(300);
  const mode5 = await page.evaluate(() => document.querySelector('lair-play').dataset.mode);
  await page.goBack();
  await page.waitForTimeout(500);
  const pop5 = await page.evaluate(() => ({ mode: document.querySelector('lair-play')?.dataset.mode, url: window.location.pathname }));
  check(`${tag}: Book a table opens the booking, and the browser's Back comes back to the map on the same page`, mode5 === 'book' && pop5.mode === 'browse' && pop5.url === '/pages/book-a-table', { mode5, pop5 });

  /* ---------- 6. "I'm interested", as a guest, from a game's sheet ---------- */
  await open('/pages/gm-games');
  await pickDay(gameAt.day);
  await tap(`[data-play-time="${gameAt.minutes}"]`);
  await tap(`lair-play-floor [data-table="${gameAt.tables[0]}"]`);
  await tap('[data-play-sheet] [data-play-sheet-act="interest-game"]');
  await page.waitForSelector('gm-board [data-sheet][open] [data-interest-form]', { timeout: 8000 });
  const form = await page.evaluate(() => {
    const f = document.querySelector('gm-board [data-interest-form]');
    return { title: document.querySelector('gm-board [data-sheet-title]').textContent, fields: [...f.elements].map((x) => x.name).filter(Boolean), send: document.querySelector('gm-board [data-interest-send]')?.textContent.trim() };
  });
  check(`${tag}: "I'm interested" opens the board's short form: name, email, mobile and a note`, /^I’m interested: /.test(form.title) && form.fields.join() === 'name,email,phone,note' && /^Send to /.test(form.send), form);
  await page.click('gm-board [data-interest-send]');
  const problems = await page.evaluate(() => [...document.querySelectorAll('gm-board [data-interest-form] [data-field-error]:not([hidden])')].map((e) => e.textContent.trim()));
  check(`${tag}: sending it empty says what's missing, in the Lair app's words`, problems.includes('Add your name.') && problems.includes('Add your email so we can get back to you.') && problems.some((p) => /mobile/.test(p)), problems);
  await page.fill('gm-board [data-interest-form] [name="name"]', 'Kiri Example');
  await page.fill('gm-board [data-interest-form] [name="email"]', 'kiri@example.com');
  await page.fill('gm-board [data-interest-form] [name="phone"]', '021 555 0103');
  await page.fill('gm-board [data-interest-form] [name="note"]', 'First time playing. Is that OK?');
  await scan(page, `${tag}: the interest form`, 'gm-board [data-sheet][open]');
  await page.click('gm-board [data-interest-send]');
  await page.waitForSelector('gm-board .gm-flash', { timeout: 8000 }).catch(() => {});
  const sent = await page.evaluate((id) => ({ flash: document.querySelector('gm-board .gm-flash')?.textContent.trim(), count: window.Lair.store.data.games.find((g) => g.id === id)?.interested }), gameAt.id);
  check(`${tag}: it's sent: the thanks says the GM gets back to them, nothing is booked; the board counts them`, /will get back to you by email\. Nothing is booked yet\./.test(sent.flash || '') && sent.count >= 1, sent);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await tap(`lair-play-floor [data-table="${gameAt.tables[0]}"]`);
  const said6 = await page.evaluate(() => ({ said: document.querySelector('[data-play-sheet] .play-said')?.textContent.trim(), count: document.querySelector('[data-play-sheet] .play-sheet__count')?.textContent.trim() }));
  check(`${tag}: the game's sheet now says "You're interested", and how many are`, said6.said === 'You’re interested' && /\d+ interested/.test(said6.count || ''), said6);
  await page.keyboard.press('Escape');

  /* ---------- 7. an event sign-up with a guest, and an event's table ---------- */
  await open('/pages/events-calendar');
  const signUp = await page.evaluate((keys) => {
    const play = document.querySelector('lair-play');
    for (const k of keys) {
      const item = play.dayItems(k).find((i) => i.kind === 'event' && i.capacity && !i.gameTables && !i.product && i.end > Date.now());
      if (item) return { day: k, id: item.id };
    }
    return null;
  }, await days());
  await pickDay(signUp.day);
  const row7 = await page.evaluate((id) => document.querySelector(`[data-play-act][data-play-target="${CSS.escape(id)}"]`)?.textContent.trim(), signUp.id);
  check(`${tag}: an event with sign-ups says Sign up in the day's list`, row7 === 'Sign up', row7);
  await tap(`[data-play-act="join"][data-play-target="${signUp.id}"]`);
  await page.waitForSelector('lair-calendar [data-join-form]', { timeout: 8000 });
  await page.fill('[data-join-form] [name="name"]', 'Mere Example');
  await page.fill('[data-join-form] [name="email"]', 'mere@example.com');
  await page.fill('[data-join-form] [name="phone"]', '021 555 0104');
  await page.click('[data-guest-add]');
  await page.fill('[data-guest] [name="guestName"]', 'Jo Bloggs');
  await page.click('button[form="cal-join-form"]');
  await page.waitForSelector('lair-calendar .cal-done', { timeout: 8000 }).catch(() => {});
  const ticket7 = await page.evaluate(() => document.querySelector('lair-calendar [data-dialog]')?.textContent.replace(/\s+/g, ' ').slice(0, 300));
  check(`${tag}: Sign up is the calendar's form, and a sign-up with a guest by name goes through`, /Jo Bloggs/.test(ticket7 || '') && /(You’re in|See you|code)/i.test(ticket7 || ''), ticket7);
  await page.keyboard.press('Escape');
  // Warhammer (Thursdays): its tables and game tables are the event's on the map; its sheet offers Reserve a game table
  const war = await page.evaluate((keys) => {
    const play = document.querySelector('lair-play');
    for (const k of keys) {
      const item = play.dayItems(k).find((i) => i.kind === 'event' && i.gameTables && i.end > Date.now());
      if (item) return { day: k, minutes: Math.floor(window.Lair.store.time.minutesOf(item.start) / 60) * 60, id: item.id, title: item.title };
    }
    return null;
  }, await days());
  if (war) {
    await pickDay(war.day);
    await tap(`[data-play-time="${war.minutes}"]`);
    const table = await page.evaluate(() => document.querySelector('lair-play-floor [data-kind="event"]:not([data-dim])')?.dataset.table || null);
    if (table) {
      await tap(`lair-play-floor [data-table="${table}"]`);
      const sheet7 = await page.evaluate(() => {
        const d = document.querySelector('[data-play-sheet]');
        return { view: d.dataset.view, title: d.querySelector('#play-sheet-title')?.textContent.trim(), reserve: Boolean(d.querySelector('[data-play-sheet-act="reserve"]')), more: Boolean(d.querySelector('[data-play-sheet-act="event"]')), aside: d.querySelector('.play-sheet__aside')?.textContent.replace(/\s+/g, ' ').trim() || '' };
      });
      check(`${tag}: an event's table opens the event: ${war.title}, Reserve a game table, All about this event (and the table's still bookable)`, sheet7.view === 'event' && sheet7.title === war.title && sheet7.reserve && sheet7.more && /you can still book it/.test(sheet7.aside), sheet7);
      await shot(page, `${tag}-7-event-sheet`);
      await tap('[data-play-sheet] [data-play-free]');
      const free7 = await page.evaluate(() => document.querySelector('[data-play-sheet]').dataset.view);
      check(`${tag}: Book from the event's sheet switches it to the table's own (How long, Book)`, free7 === 'free', free7);
      await page.keyboard.press('Escape');
    } else check(`${tag}: Warhammer's tables show on the map`, false, war);
  }

  /* ---------- 8. "I'm coming", one tap for a member; a guest's is the calendar's form ---------- */
  await open('/pages/events-calendar', RUBY);
  const turnup = await page.evaluate((keys) => {
    const play = document.querySelector('lair-play');
    for (const k of keys) {
      const item = play.dayItems(k).find((i) => i.kind === 'event' && !i.capacity && !i.gameTables && !i.product && i.end > Date.now());
      if (item) return { day: k, id: item.id, title: item.title };
    }
    return null;
  }, await days());
  await pickDay(turnup.day);
  await tap(`[data-play-act="coming"][data-play-target="${turnup.id}"]`);
  await page.waitForTimeout(500);
  const coming = await page.evaluate((id) => {
    const row = document.querySelector(`[data-play-open="${CSS.escape(id)}"]`)?.closest('.play-row');
    return { said: row?.querySelector('.play-said')?.textContent.trim(), back: Boolean(row?.querySelector('[data-play-act="unsay"]')), dialog: Boolean(document.querySelector('dialog[open]:modal')), left: row?.querySelector('.play-row__left')?.textContent.trim() || '' };
  }, turnup.id);
  check(`${tag}: a member's "I'm coming" is one tap: "You're coming" with Take it back, no form, and the row counts them`, coming.said === 'You’re coming' && coming.back && !coming.dialog && /\d+ coming/.test(coming.left), coming);
  await tap(`[data-play-act="unsay"][data-play-target="${turnup.id}"]`);
  await page.waitForTimeout(400);
  const unsaid = await page.evaluate((id) => Boolean(document.querySelector(`[data-play-act="coming"][data-play-target="${CSS.escape(id)}"]`)), turnup.id);
  check(`${tag}: Take it back takes it back`, unsaid, unsaid);
  await open('/pages/events-calendar');
  await pickDay(turnup.day);
  await tap(`[data-play-act="coming"][data-play-target="${turnup.id}"]`);
  await page.waitForSelector('lair-calendar [data-dialog][open] [data-interest-form]', { timeout: 8000 });
  const guestForm = await page.evaluate(() => ({ title: document.querySelector('lair-calendar [data-dialog-title]').textContent, fields: [...document.querySelector('lair-calendar [data-interest-form]').elements].map((x) => x.name).filter(Boolean) }));
  check(`${tag}: a guest's "I'm coming" asks for a name, email and mobile in the calendar's sheet`, /^I’m coming: /.test(guestForm.title) && guestForm.fields.join() === 'name,email,phone,note,remind', guestForm);
  await scan(page, `${tag}: the I'm coming form`, 'lair-calendar [data-dialog][open]');
  await page.keyboard.press('Escape');

  /* ---------- 9. Looking for players ---------- */
  await open('/pages/gm-games');
  await tap('[data-play-show] [data-play-players]');
  await page.waitForTimeout(300);
  const lfp = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const store = window.Lair.store;
    const t = store.time;
    const last = t.addDays(t.today(), 6);
    const games = store.data.games.filter((g) => g.status === 'open' && g.seats - g.taken > 0 && g.end > Date.now() && t.key(g.start) <= last);
    const rows = [...document.querySelectorAll('[data-play-list-body] .play-row[data-kind="game"] [data-play-open]')].map((b) => b.dataset.playOpen.replace(/^game:/, ''));
    const lit = [...document.querySelectorAll('lair-play-floor .is-lit')].map((b) => b.dataset.table);
    const strip = [...document.querySelectorAll('[data-play-strip] [data-play-date]')].map((d) => [d.dataset.playDate, d.querySelector('.play-sday__count')?.textContent.trim()]);
    // at the map's moment: the tables of games with seats, and of events with places to sign up
    const at = document.querySelector('lair-play-floor').at;
    const want = new Set(store.cfg.tables.map((tb) => tb.id).filter((id) => {
      const s = play.tableAt(id, at);
      if (s.kind === 'game') return s.game.status === 'open' && s.game.seats - s.game.taken > 0;
      if (s.kind === 'event') return Boolean(s.ev.capacity) && (play.factsOf(s.ev).spaces?.left || 0) > 0;
      return false;
    }));
    return {
      on: play.players, url: window.location.search, show: getComputedStyle(document.querySelector('[data-play-show]')).display, panel: document.querySelector('[data-play-lfp-text]')?.textContent.trim(),
      title: document.querySelector('[data-play-list-title]').textContent, rows, games: games.map((g) => g.id), lit, want: [...want],
      litOk: lit.length === want.size && lit.every((id) => want.has(id)) && want.size > 0,
      strip, perDay: Object.fromEntries(strip.map(([k]) => [k, play.lookingWeek().filter((x) => x.day === k).length])),
    };
  });
  check(`${tag}: Looking for players: the switches step aside for its panel, and the address keeps it`, lfp.on && lfp.show === 'none' && /seats for new players this week/.test(lfp.panel) && /players=1/.test(lfp.url), lfp);
  check(`${tag}: it lists every game with seats in the next seven days`, lfp.title === 'Games with seats this week' && lfp.games.every((id) => lfp.rows.includes(id)) && lfp.rows.every((id) => lfp.games.includes(id)), { rows: lfp.rows, games: lfp.games });
  check(`${tag}: each day in the strip says how many it has`, !phone || lfp.strip.every(([k, n]) => (n === '–' ? 0 : Number(n)) === lfp.perDay[k]), lfp.strip);
  check(`${tag}: their tables light up on the map (and only theirs)`, lfp.litOk, { lit: lfp.lit, want: lfp.want });
  await shot(page, `${tag}-8-players`, true);
  await tap('[data-play-lfp] [data-play-players]');
  const off9 = await page.evaluate(() => ({ on: document.querySelector('lair-play').players, show: getComputedStyle(document.querySelector('[data-play-show]')).display !== 'none', focus: document.activeElement?.closest('[data-play-show]') ? 'show' : document.activeElement?.tagName }));
  check(`${tag}: On ✕ turns it off, and the focus lands on its button among the switches`, !off9.on && off9.show && off9.focus === 'show', off9);

  /* ---------- 10. Run a game, Host your own event, and old links ---------- */
  await open('/pages/events-calendar', RUBY);
  await tap('[data-play-host]');
  await page.waitForSelector('gm-board [data-sheet][open] lair-session-form', { timeout: 8000 }).catch(() => {});
  const gm = await page.evaluate(() => Boolean(document.querySelector('gm-board [data-sheet][open] lair-session-form')));
  check(`${tag}: Run a game opens the GM steps (on any of the three pages)`, gm, gm);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await tap('[data-cal-host]');
  await page.waitForSelector('lair-calendar [data-dialog][open] [data-host-form]', { timeout: 8000 }).catch(() => {});
  const host = await page.evaluate(() => ({ title: document.querySelector('lair-calendar [data-dialog-title]')?.textContent, intro: document.querySelector('lair-calendar .cal-form__intro')?.textContent }));
  check(`${tag}: Host your own event opens the hosting form with the section's words`, host.title === 'Host your own event at the Lair' && /Tournaments, club nights/.test(host.intro || ''), host);
  await page.keyboard.press('Escape');
  await open(`/pages/gm-games#game=${encodeURIComponent(gameAt.id)}`);
  const link1 = await page.evaluate(() => ({ title: document.querySelector('gm-board [data-sheet][open] [data-sheet-title]')?.textContent, day: document.querySelector('lair-play').day, time: document.querySelector('lair-play').time }));
  check(`${tag}: #game= opens the game in the board's sheet, on its day and at its time`, link1.title === gameAt.title && link1.day === gameAt.day && link1.time === gameAt.minutes, link1);
  await page.keyboard.press('Escape');
  await open(`/pages/book-a-table#event=${encodeURIComponent(signUp.id)}`);
  const link2 = await page.evaluate(() => ({ open: Boolean(document.querySelector('lair-calendar [data-dialog][open]')), day: document.querySelector('lair-play').day, layers: [...document.querySelectorAll('[data-play-layer][aria-pressed="true"]')].map((b) => b.dataset.playLayer) }));
  check(`${tag}: #event= on another page opens the event's sheet on its day, with Events switched on`, link2.open && link2.day === signUp.day && link2.layers.includes('events'), link2);
  await page.keyboard.press('Escape');
  await open(`/pages/gm-games?join=${encodeURIComponent(gameAt.id)}`);
  await page.waitForSelector('gm-board [data-sheet][open] [data-session-join]', { timeout: 8000 }).catch(() => {});
  check(`${tag}: ?join= (back from logging in) opens the join form`, Boolean(await page.$('gm-board [data-sheet][open] [data-session-join]')), page.url());
  await page.keyboard.press('Escape');

  /* ---------- 11. keyboard, axe, no sideways scroll ---------- */
  await open('/pages/book-a-table?show=events,ttrpg,tables');
  if (phone) {
    await page.focus('[data-play-strip] [data-play-date][tabindex="0"]');
    const from = await page.evaluate(() => document.activeElement.dataset.playDate);
    await page.keyboard.press('ArrowRight');
    const to = await page.evaluate(() => document.activeElement.dataset.playDate);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    const picked = await page.evaluate(() => document.querySelector('lair-play').day);
    check(`${tag}: arrow keys move along the strip (one Tab stop) and Enter picks a day`, to > from && picked === to, { from, to, picked });
  } else {
    await page.focus('[data-play-days] [data-play-date][tabindex="0"]');
    const from = await page.evaluate(() => document.activeElement.dataset.playDate);
    await page.keyboard.press('ArrowRight');
    const to = await page.evaluate(() => document.activeElement.dataset.playDate);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    const picked = await page.evaluate(() => document.querySelector('lair-play').day);
    check(`${tag}: arrow keys move between the month's days (one Tab stop) and Enter picks one`, to > from && picked === to, { from, to, picked });
    await page.keyboard.press('ArrowDown');
    const down = await page.evaluate(() => document.activeElement.dataset.playDate);
    check(`${tag}: Down goes a week on`, down > to, { to, down });
  }
  await page.focus('[data-play-times] [tabindex="0"]');
  const t0 = await page.evaluate(() => document.activeElement.dataset.playTime);
  await page.keyboard.press('ArrowRight');
  const t1 = await page.evaluate(() => document.activeElement.dataset.playTime);
  check(`${tag}: arrow keys move along the times`, t0 !== t1 && Boolean(t1), { t0, t1 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  await page.focus('lair-play-floor [data-table][tabindex="0"]');
  const tableId = await page.evaluate(() => document.activeElement.dataset.table);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const kb = await page.evaluate(() => ({ open: document.querySelector('[data-play-sheet]').open, focus: document.activeElement?.id }));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const kb2 = await page.evaluate(() => ({ open: document.querySelector('[data-play-sheet]').open, focus: document.activeElement?.dataset?.table }));
  check(`${tag}: Enter on a table opens its sheet with the focus in it; Esc closes it and the focus goes back to the table`, kb.open && kb.focus === 'play-sheet-title' && !kb2.open && kb2.focus === tableId, { kb, kb2, tableId });
  for (const [door, label] of [['/pages/book-a-table', 'Book a table'], ['/pages/gm-games', 'TTRPG sessions'], ['/pages/events-calendar?show=events,ttrpg,tables', 'Everything']]) {
    await open(door);
    await scan(page, `${tag}: ${label}: the days, the switches, the map and the list`, 'lair-play .play__day, lair-play .play__extras');
    check(`${tag}: ${label}: no sideways scroll`, (await overflowX(page)) === 0, await overflowX(page));
  }
  // a sheet open, for axe
  const any = await page.evaluate(() => document.querySelector('lair-play-floor [data-kind="free"]')?.dataset.table);
  if (any) {
    await tap(`lair-play-floor [data-table="${any}"]`);
    await scan(page, `${tag}: a table's sheet`, 'lair-play [data-play-sheet][open]');
    await page.keyboard.press('Escape');
  }
  await shot(page, `${tag}-9-everything`, true);
  check(`${tag}: no console errors`, !errors.length, errors);
  await ctx.close();
}

await browser.close();
server.close();
if (!axe) console.log('NOTE axe skipped: set AXE to axe-core’s axe.min.js');
console.log(`\n${pass} passed, ${fail} failed${axe ? `, ${axeTotal} axe violations` : ''}`);
process.exit(fail ? 1 : 0);

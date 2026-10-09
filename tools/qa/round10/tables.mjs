// Round 10, Tables: the Tables tab picks its time the way the TTRPG and Events tabs do. Mo (9 Oct, 4pm): "For tables
// it's a different time check than the ttrpg and events can you make it the same as ttrpg and events for table booking".
// The day comes from the month view (as on every tab); the start times sit under the day as the same chips, in the same
// row, as the other tabs' "See the tables at"; How long sits under them; the booking's own When card (its strip of days,
// start times and How long) and its step numbers step aside.
// Demo mode on the theme mock, phone (390px) then desktop (1280px), each in a fresh browser (a fresh demo):
//   1. the Tables tab: "Start time" chips under the day (the day's booking hours, no Now), the lead-time hint and How
//      long; no When card and no step numbers
//   2. the other tabs keep "See the tables at" (Now first, today while open); back on Tables it's "Start time" again
//   3. a start time picks the booking's time (tables picked, the map's window, the until words); How long's + and −
//      change its hours, − stops at 1 hour; the other tabs then show the tables at that time
//   4. a day on the month view moves the booking there and clears the start time; the chips are that day's
//   5. Book with no start time: "Pick a start time." under the times, the ring, the focus there; the bar's Next too
//   6. keyboard: one Tab stop in the start times, arrows move along them, Enter picks
//   7. too soon (the clock at 7:30pm): earlier times are crossed out and can't be picked, the arrows skip them, and +
//      stops at closing time
//   8. a table booked for 3 hours from the month view and the start times, ending on its ticket
//   9. desktop: the booking's left column starts at Who's coming, level with the map (no empty When row)
//  10. axe (WCAG 2.1 A and AA) on the day with the start times, and with the note; no sideways scroll; no console errors
// Screenshots go to OUT, or a folder in the system's temp directory. Without AXE (axe-core's axe.min.js) the axe part is
// skipped, and says so.
// Usage: DG_THEME=/path/to/theme PORT=4993 [AXE=/path/to/axe.min.js] [OUT=/dir] node tools/qa/round10/tables.mjs [phone|desktop]
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
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round10-tables');
const AXE = process.env.AXE || '';
const axe = AXE && fs.existsSync(AXE) ? fs.readFileSync(AXE, 'utf8') : null;
fs.mkdirSync(OUT, { recursive: true });
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || process.env.QA_PORT || 4993);
const BASE = `http://localhost:${PORT}`;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };

/* ---------- the page clock: today in Auckland, at 1pm (the Lair opens at 4pm on weekdays, 10am at weekends) ---------- */
const TZ = 'Pacific/Auckland';
const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const offset = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${key}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const iso = (key, hm) => `${key}T${hm}:00${offset(key)}`;
const today = lairKey(Date.now());
const clock = (hm) => `(() => { const OFFSET = ${Date.parse(iso(today, hm))} - Date.now(); const Real = Date;
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
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
let axeTotal = 0;
async function scan(page, label, selector) {
  if (!axe) return;
  await page.addScriptTag({ content: axe });
  const found = await page.evaluate(async (sel) => {
    const nodes = [...document.querySelectorAll(sel)].filter((n) => n.offsetParent);
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
const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false }).catch(() => {});
};

/** What the day's times and the booking say right now */
const look = (page) => page.evaluate(() => {
  const play = document.querySelector('lair-play');
  const b = document.querySelector('lair-booking');
  const shown = (el) => Boolean(el && el.offsetParent !== null);
  const chips = [...document.querySelectorAll('[data-play-times] button')];
  const hint = document.querySelector('[data-play-starts-hint]');
  const note = document.querySelector('[data-play-when-note]');
  const active = document.activeElement;
  return {
    tab: play.dataset.activeTab,
    day: play.day,
    label: document.querySelector('[data-play-times-label]')?.textContent.trim(),
    group: document.querySelector('[data-play-times]')?.getAttribute('aria-labelledby'),
    starts: chips.filter((c) => c.matches('[data-play-start]')).map((c) => ({ v: Number(c.dataset.playStart), on: c.getAttribute('aria-pressed') === 'true', off: c.disabled, stop: c.tabIndex === 0, cls: c.className, title: c.title, text: c.textContent.trim(), struck: getComputedStyle(c).textDecorationLine })),
    times: chips.filter((c) => c.matches('[data-play-time]')).map((c) => ({ v: c.dataset.playTime, on: c.getAttribute('aria-pressed') === 'true', cls: c.className })),
    hint: shown(hint) ? hint.textContent.trim() : null,
    length: shown(document.querySelector('[data-play-length]')),
    hours: document.querySelector('[data-play-hours-value]')?.textContent.trim(),
    until: document.querySelector('[data-play-until]')?.textContent.trim(),
    minus: document.querySelector('[data-play-hours="-1"]')?.disabled,
    plus: document.querySelector('[data-play-hours="1"]')?.disabled,
    note: shown(note) ? note.textContent.trim() : null,
    problem: document.querySelector('[data-play-times-wrap]')?.classList.contains('is-problem'),
    whenCard: shown(b.querySelector('.booking__when')),
    nums: [...b.querySelectorAll('.booking__num')].filter(shown).length,
    booking: { day: b.state.day, start: b.state.start, hours: b.state.hours, tables: [...b.state.tables] },
    slots: window.Lair.store.slots(b.state.day).map((s) => ({ v: s.minutes, ok: s.bookable, label: s.label })),
    win: (() => { const w = window.Lair.store.openWindow(b.state.day); return w ? { open: w.openMin, close: w.closeMin } : null; })(),
    maxHours: window.Lair.store.cfg.maxHours,
    showing: b.querySelector('[data-showing]')?.textContent.replace(/\s+/g, ' ').trim() || '',
    active: active?.dataset?.playStart ? `start:${active.dataset.playStart}` : active?.matches?.('[data-play-times-wrap]') ? 'times' : active?.tagName || null,
  };
});

const server = await m.serve(PORT);
const browser = await chromium.launch();

for (const size of process.argv[2] ? [process.argv[2]] : ['phone', 'desktop']) {
  const phone = size === 'phone';
  const tag = size;
  const fresh = async (hm) => {
    const ctx = await browser.newContext({ viewport: SIZES[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
    await ctx.addInitScript(clock(hm));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()); });
    return { ctx, page, errors };
  };
  const open = async (page, where) => {
    await page.goto('about:blank');
    await page.goto(`${BASE}${where}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('lair-play')?.ready === true, null, { timeout: 20000 });
    await page.waitForSelector('[data-play-times] button', { timeout: 20000 });
    await page.waitForTimeout(300);
  };
  const head = (page) => page.evaluate(() => document.querySelector('.play__head').scrollIntoView({ block: 'start' }));
  const { ctx, page, errors } = await fresh('13:00');
  await open(page, '/pages/book-a-table');
  await page.evaluate(() => localStorage.clear());
  await open(page, '/pages/book-a-table');

  /* ---------- 1. the Tables tab: the start times under the day ---------- */
  let s = await look(page);
  const expected = s.slots.map((x) => x.v).join();
  check(`${tag}: the Tables tab labels the times under the day "Start time"`, s.tab === 'tables' && s.label === 'Start time' && s.group === 'play-times-label', s);
  check(`${tag}: the chips are the booking's start times for the day (no Now), as the same chips as the other tabs' times`, s.starts.length > 0 && s.starts.map((x) => x.v).join() === expected && s.starts.every((x) => x.cls.split(' ').includes('play-time') && x.cls.split(' ').includes('slot')) && !s.times.length && !s.starts.some((x) => /now/i.test(x.text)), s.starts);
  check(`${tag}: nothing is picked yet, with one Tab stop on the first time that can be booked`, s.booking.start === null && !s.starts.some((x) => x.on) && s.starts.filter((x) => x.stop).length === 1 && s.starts.find((x) => x.stop).v === s.starts.find((x) => !x.off).v, s.starts);
  check(`${tag}: the lead-time hint and How long sit under them`, s.hint === 'Book at least 1 hour ahead. Sooner than that, just walk in.' && s.length && s.hours === `${s.booking.hours}h` && s.until === '', s);
  check(`${tag}: the booking's own When card and its step numbers step aside`, !s.whenCard && s.nums === 0, s);
  await head(page);
  await shot(page, `${tag}-1-start-times`);
  await scan(page, `${tag}: the day with the start times`, 'lair-play .play__head');

  /* ---------- 2. the other tabs keep "See the tables at" ---------- */
  for (const other of ['ttrpg', 'events']) {
    await page.click(`[data-play-tab="${other}"]`);
    await page.waitForTimeout(250);
    s = await look(page);
    check(`${tag}: ${other}: "See the tables at", with the hour chips (no start times, hint or How long)`, s.tab === other && s.label === 'See the tables at' && s.times.length > 0 && !s.starts.length && s.hint === null && !s.length && s.note === null, s);
  }
  await page.click('[data-play-tab="tables"]');
  await page.waitForTimeout(250);
  s = await look(page);
  check(`${tag}: back on Tables: "Start time" again`, s.label === 'Start time' && s.starts.length > 0 && !s.times.length, s);

  /* ---------- 3. a start time and How long drive the booking ---------- */
  const six = s.starts.find((x) => !x.off && x.v >= 18 * 60) || s.starts.find((x) => !x.off);
  await page.click(`[data-play-start="${six.v}"]`);
  await page.waitForTimeout(300);
  s = await look(page);
  const picked = s.starts.find((x) => x.v === six.v);
  check(`${tag}: a start time picks the booking's time, and the chip shows it`, s.booking.start === six.v && picked.on && picked.stop && s.starts.filter((x) => x.on).length === 1, s);
  check(`${tag}: the booking picks tables for that time and the map shows it`, s.booking.tables.length > 0 && s.showing.includes(six.text.replace(/\s/g, '')) && !/next time you can book/i.test(s.showing), { tables: s.booking.tables, showing: s.showing, six });
  check(`${tag}: How long shows the booking's hours, with the start and end`, s.hours === `${s.booking.hours}h` && /^\d{1,2}(:\d\d)?(am|pm) to \d{1,2}(:\d\d)?(am|pm)$/.test(s.until) && s.until.startsWith(six.text), s);
  const hoursBefore = s.booking.hours;
  await page.click('[data-play-hours="1"]');
  await page.waitForTimeout(200);
  s = await look(page);
  check(`${tag}: + adds an hour to the booking (and the until words)`, s.booking.hours === hoursBefore + 1 && s.hours === `${hoursBefore + 1}h` && s.until !== '', s);
  for (let i = 0; i < 10 && !s.minus; i += 1) {
    await page.click('[data-play-hours="-1"]');
    await page.waitForTimeout(120);
    s = await look(page);
  }
  check(`${tag}: − takes it down to 1 hour and stops there`, s.booking.hours === 1 && s.hours === '1h' && s.minus === true, s);
  await page.click('[data-play-hours="1"]');
  await page.waitForTimeout(150);
  // the time picked is the time the other tabs show the tables at
  await page.click('[data-play-tab="events"]');
  await page.waitForTimeout(250);
  s = await look(page);
  check(`${tag}: the other tabs then show the tables at the start time picked`, s.times.some((x) => x.on && Number(x.v) === six.v), s.times);
  await page.click('[data-play-tab="tables"]');
  await page.waitForTimeout(250);
  s = await look(page);
  check(`${tag}: and back on Tables, the start time is still picked`, s.booking.start === six.v && s.starts.find((x) => x.v === six.v)?.on, s);
  await head(page);
  await shot(page, `${tag}-2-picked`);

  /* ---------- 4. a day on the month view ---------- */
  const other = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const keys = [...document.querySelectorAll('[data-play-date]:not([disabled])')].map((d) => d.dataset.playDate);
    const weekday = (k) => new Date(`${k}T12:00:00Z`).getUTCDay();
    // a day with other hours than today's, if there's one (a weekend against a weekday)
    return keys.find((k) => k > play.day && (weekday(k) === 6) !== (weekday(play.day) === 6)) || keys.find((k) => k > play.day);
  });
  await page.click(`[data-play-date="${other}"]`);
  await page.waitForTimeout(300);
  s = await look(page);
  check(`${tag}: a day on the month view moves the booking there and clears the start time`, s.day === other && s.booking.day === other && s.booking.start === null && !s.starts.some((x) => x.on), { other, s });
  check(`${tag}: the start times are that day's`, s.starts.map((x) => x.v).join() === s.slots.map((x) => x.v).join() && s.starts[0].v === s.win.open, { starts: s.starts.map((x) => x.v), win: s.win });

  /* ---------- 5. Book with no start time ---------- */
  await page.click('lair-booking [data-submit]');
  const settled = () => page.waitForFunction(() => {
    const r = document.querySelector('[data-play-times-wrap]').getBoundingClientRect();
    return r.top >= 0 && r.top < window.innerHeight;
  }, null, { timeout: 3000 }).catch(() => {});
  await settled();
  await page.waitForTimeout(300);
  s = await look(page);
  const problems = await page.evaluate(() => [...document.querySelectorAll('lair-booking [data-problems] .booking__problem')].map((b) => b.textContent.trim()));
  check(`${tag}: Book with no start time says "Pick a start time." under the times, rings them, and puts the focus there`, s.note === 'Pick a start time.' && s.problem && s.active === 'times' && problems[0] === 'Pick a start time.', { s, problems });
  const inView = await page.evaluate(() => { const r = document.querySelector('[data-play-times-wrap]').getBoundingClientRect(); return r.top >= 0 && r.top < window.innerHeight; });
  check(`${tag}: and the times are on screen`, inView, inView);
  await shot(page, `${tag}-3-pick-a-start-time`);
  await scan(page, `${tag}: the day with the note`, 'lair-play .play__head');
  // the problem list's own link goes there too
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.click('lair-booking [data-problems] [data-goto="when"]');
  await settled();
  await page.waitForTimeout(300);
  s = await look(page);
  check(`${tag}: the "Pick a start time." link in the list goes to the times`, s.active === 'times', s.active);
  // the bar's Next (no start time): the focus on the start time to pick
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.evaluate(() => document.querySelector('lair-booking').stepNext());
  await settled();
  await page.waitForTimeout(300);
  s = await look(page);
  check(`${tag}: Next with no start time puts the focus on the first start time`, s.active === `start:${s.starts.find((x) => x.stop)?.v}`, s.active);
  // picking a time clears the note and the ring
  const first = s.starts.find((x) => !x.off);
  await page.click(`[data-play-start="${first.v}"]`);
  await page.waitForTimeout(300);
  s = await look(page);
  check(`${tag}: a start time clears the note and the ring`, s.note === null && !s.problem && s.booking.start === first.v, s);

  /* ---------- 6. keyboard ---------- */
  await open(page, '/pages/book-a-table');
  await page.focus('[data-play-start][tabindex="0"]');
  const from = await page.evaluate(() => document.activeElement.dataset.playStart);
  await page.keyboard.press('ArrowRight');
  const to = await page.evaluate(() => document.activeElement.dataset.playStart);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  s = await look(page);
  check(`${tag}: arrows move along the start times and Enter picks one`, Number(to) > Number(from) && s.booking.start === Number(to) && s.active === `start:${to}`, { from, to, s: s.booking, active: s.active });
  await page.keyboard.press('End');
  const end = await page.evaluate(() => document.activeElement.dataset.playStart);
  await page.keyboard.press('Home');
  const home = await page.evaluate(() => document.activeElement.dataset.playStart);
  const ends = s.starts.filter((x) => !x.off);
  check(`${tag}: Home and End go to the first and last start times`, Number(end) === ends[ends.length - 1].v && Number(home) === ends[0].v, { end, home });
  const stops = await page.evaluate(() => [...document.querySelectorAll('[data-play-start]')].filter((b) => b.tabIndex === 0).length);
  check(`${tag}: one Tab stop in the start times`, stops === 1, stops);
  check(`${tag}: no sideways scroll`, (await overflowX(page)) === 0, await overflowX(page));

  /* ---------- 9. desktop: the booking's columns ---------- */
  if (!phone) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    const grid = await page.evaluate(() => {
      const who = document.querySelector('lair-booking .booking__who').getBoundingClientRect();
      const map = document.querySelector('lair-booking .booking__map').getBoundingClientRect();
      return { who: Math.round(who.top), map: Math.round(map.top), whoLeft: Math.round(who.left), mapLeft: Math.round(map.left), areas: getComputedStyle(document.querySelector('lair-booking .booking')).gridTemplateAreas };
    });
    check(`${tag}: the booking's left column starts at Who's coming, level with the map (no empty When row)`, Math.abs(grid.who - grid.map) <= 2 && grid.whoLeft < grid.mapLeft && !/when/.test(grid.areas), grid);
  }

  /* ---------- 8. a table booked for 3 hours ---------- */
  await open(page, '/pages/book-a-table');
  const day8 = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const keys = [...document.querySelectorAll('[data-play-date]:not([disabled])')].map((d) => d.dataset.playDate);
    return keys.find((k) => k > play.day && play.dayInfo(k).level === 0) || keys[1];
  });
  await page.click(`[data-play-date="${day8}"]`);
  await page.waitForTimeout(250);
  s = await look(page);
  const start8 = (s.starts.find((x) => !x.off && x.v === 18 * 60) || s.starts.find((x) => !x.off)).v;
  await page.click(`[data-play-start="${start8}"]`);
  await page.waitForTimeout(200);
  s = await look(page);
  while (s.booking.hours < 3 && !s.plus) {
    await page.click('[data-play-hours="1"]');
    await page.waitForTimeout(120);
    s = await look(page);
  }
  while (s.booking.hours > 3) {
    await page.click('[data-play-hours="-1"]');
    await page.waitForTimeout(120);
    s = await look(page);
  }
  await page.fill('#bk-name', 'Aroha Example');
  await page.fill('#bk-email', 'aroha@example.com');
  await page.fill('#bk-phone', '021 555 0101');
  if (await page.$('lair-booking input[name="agree"]')) await page.check('lair-booking input[name="agree"]');
  await page.click('lair-booking [data-submit]');
  await page.waitForSelector('lair-booking [data-done]:not([hidden])', { timeout: 10000 }).catch(() => {});
  const ticket = await page.evaluate(() => {
    const ref = document.querySelector('lair-booking .ticket-qr__ref')?.textContent.trim();
    const row = (window.Lair.store.backend.state.bookings || []).find((b) => b.ref === ref);
    return { ref, qr: Boolean(document.querySelector('lair-booking [data-ticket-code] svg')), title: document.querySelector('lair-booking .ticket__title')?.textContent.trim(), hours: row ? (row.end - row.start) / 3600000 : null, start: row ? row.start : null };
  });
  const startMins = ticket.start ? Number(new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).format(new Date(ticket.start)).split(':').reduce((h, mm) => Number(h) * 60 + Number(mm))) : null;
  check(`${tag}: a table booked from the month view and the start times, for 3 hours, ends on its ticket with a QR code`, /^[A-Z]{1,3}-[A-Z]+-\d{1,2}$/.test(ticket.ref || '') && ticket.qr && /See you/.test(ticket.title || '') && ticket.hours === 3 && startMins === start8 && lairKey(ticket.start) === day8, { ticket, day8, start8, startMins });
  await shot(page, `${tag}-4-booked`);
  check(`${tag}: no console errors`, !errors.length, errors);
  await ctx.close();

  /* ---------- 7. too soon: the clock at 7:30pm ---------- */
  {
    const late = await fresh('19:30');
    await open(late.page, '/pages/book-a-table');
    if ((await look(late.page)).day !== today) await late.page.click(`[data-play-date="${today}"]`);
    await late.page.waitForTimeout(250);
    s = await look(late.page);
    const soon = s.starts.filter((x) => x.v < 20 * 60 + 30);
    const later = s.starts.filter((x) => x.v >= 20 * 60 + 30);
    check(`${tag}: at 7:30pm, today's times before 8:30pm are crossed out and can't be picked`, s.day === today && soon.length > 0 && soon.every((x) => x.off && x.title === 'Too soon to book. Walk in instead.' && /line-through/.test(x.struck)), soon);
    check(`${tag}: and the later ones can`, later.length > 0 && later.some((x) => !x.off) && s.starts.find((x) => x.stop)?.v === later.find((x) => !x.off).v, later);
    await late.page.click(`[data-play-start="${soon[0].v}"]`, { force: true }).catch(() => {});
    await late.page.waitForTimeout(150);
    check(`${tag}: a crossed-out time does nothing`, (await look(late.page)).booking.start === null, (await look(late.page)).booking);
    await late.page.focus('[data-play-start][tabindex="0"]');
    await late.page.keyboard.press('Home');
    const homeLate = await late.page.evaluate(() => document.activeElement.dataset.playStart);
    await late.page.keyboard.press('ArrowLeft');
    const leftLate = await late.page.evaluate(() => document.activeElement.dataset.playStart);
    check(`${tag}: the arrows skip the crossed-out times`, Number(homeLate) === later.find((x) => !x.off).v && leftLate === homeLate, { homeLate, leftLate });
    // the first time that can be picked: + stops at closing time (3 hours from 9pm to midnight, or 1 on a Sunday)
    const last = later.find((x) => !x.off);
    await late.page.click(`[data-play-start="${last.v}"]`);
    await late.page.waitForTimeout(200);
    s = await look(late.page);
    for (let i = 0; i < 10 && !s.plus; i += 1) {
      await late.page.click('[data-play-hours="1"]');
      await late.page.waitForTimeout(120);
      s = await look(late.page);
    }
    const most = Math.max(1, Math.min(s.maxHours, Math.floor((s.win.close - last.v) / 60)));
    check(`${tag}: + stops at closing time (${most}h from ${last.text})`, s.booking.hours === most && s.plus === true && s.booking.start === last.v, { s: s.booking, most, plus: s.plus, win: s.win });
    await head(late.page);
    await shot(late.page, `${tag}-5-too-soon`);
    check(`${tag}: no console errors (7:30pm)`, !late.errors.length, late.errors);
    await late.ctx.close();
  }
}

await browser.close();
server.close();
if (!axe) console.log('NOTE axe skipped: set AXE to axe-core’s axe.min.js');
console.log(`\n${pass} passed, ${fail} failed${axe ? `, ${axeTotal} axe violations` : ''}`);
process.exit(fail ? 1 : 0);

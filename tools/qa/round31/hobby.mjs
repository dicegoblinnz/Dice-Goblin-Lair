// Round 31, the hobby page (/pages/warhammer, templates/page.warhammer.json; Mo picked "A · Every Thursday"), in demo
// mode on the theme mock at phone (390px) then desktop (1280px), each in a fresh demo, with a Warhammer night tonight
// and Learn to paint on a later date:
//   1. Every Thursday: the next night (its date, free pairs, one player looking, Book a game table to the calendar)
//   2. Looking for a game: Ruby's game for a member (first name, the game, size, start, tables, Join to the calendar's
//      join sheet); logged out "A player" and the note, and Join's sheet and the event sheet say Log in to join, coming
//      straight back to that game (the review, 6 Nov 2026); the filter (Kill Team: nobody); Post a game for a night
//   3. Learn to paint: its next date, and Book a seat opening it on the calendar
//   4. the links work: Join opens the calendar's join sheet for that game; Post a game opens Reserve with Find me one
//   5. axe (WCAG 2.2 A and AA) on the section; no sideways scroll; no console errors
// Usage: DG_THEME=/path/to/theme [PORT=4996] [AXE=/path/to/axe.min.js] [OUT=/dir] node tools/qa/round31/hobby.mjs [phone|desktop]
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
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round31-hobby');
const AXE = process.env.AXE && fs.existsSync(process.env.AXE) ? fs.readFileSync(process.env.AXE, 'utf8') : null;
fs.mkdirSync(OUT, { recursive: true });
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
const ev = await import(new URL('../theme-mock/events-mock.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4996);
const BASE = `http://localhost:${PORT}`;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };

const TZ = 'Pacific/Auckland';
const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const offset = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${key}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const iso = (key, hm) => `${key}T${hm}:00${offset(key)}`;
const today = lairKey(Date.now());
const plusDays = (n) => lairKey(Date.parse(iso(today, '12:00')) + n * 24 * 3600 * 1000);
const AT = Date.parse(iso(today, '13:00'));
const CLOCK = `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;
const HANDLE = 'r31h-warhammer-night';
ev.extraEvents.push({
  handle: HANDLE, title: 'Warhammer night (hobby page)', event_type: 'wargame', starts_at: iso(today, '18:00'), ends_at: iso(plusDays(1), '00:00'), image_slug: 'warhammer', game: 'Warhammer',
  description: 'Bring your army.', tables: 'T8-T21', lock_tables: true, game_tables: 'T8+T9, T10+T11, T12+T13, T14+T15, T18+T19, T20+T21', entry_fee: 10, payment: null,
});
ev.extraEvents.push({
  handle: 'learn-to-paint', title: 'Learn to paint', event_type: 'learn', starts_at: iso(plusDays(9), '18:00'), ends_at: iso(plusDays(9), '20:00'), image_slug: 'paint', game: 'Painting',
  description: 'Learn to paint.', capacity: 8, entry_fee: 10, payment: null,
});
const RUBY = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [] };

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  return ok;
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
async function scan(page, label, selector) {
  if (!AXE) return;
  await page.addScriptTag({ content: AXE });
  const found = await page.evaluate(async (sel) => {
    const r = await window.axe.run(document.querySelector(sel), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  }, selector);
  check(`axe: ${label}`, !found.length, found.join(' / '));
}

const server = await m.serve(PORT);
const browser = await chromium.launch();
for (const size of process.argv[2] ? [process.argv[2]] : ['phone', 'desktop']) {
  const phone = size === 'phone';
  console.log(`\n== ${size} ==`);
  const ctx = await browser.newContext({ viewport: SIZES[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(CLOCK);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text());
  });
  const open = async (where, customer) => {
    m.mockState.customer = customer;
    await page.goto('about:blank');
    await page.goto(`${BASE}${where}`, { waitUntil: 'networkidle', timeout: 60000 });
  };
  // a fresh demo, and Ruby's game listed tonight (as the calendar's Find me one does)
  await open('/pages/events-calendar', RUBY);
  await page.evaluate(() => localStorage.clear());
  await open('/pages/events-calendar', RUBY);
  await page.waitForSelector('lair-calendar .cal-card', { state: 'attached', timeout: 20000 });
  const id = await page.evaluate((h) => (document.querySelector('lair-calendar').all().find((i) => i.handle === h) || {}).id, HANDLE);
  const listed = await page.evaluate(async (occ) => {
    const r = await window.Lair.store.backend.reserveEvent(occ, { name: 'Ruby Tane', email: 'ruby@example.com', phone: '021 555 0123', people: 2, spot: 'T10+T11', looking: { game: '40k', size: '1000', newPlayers: true } });
    return r.booking.openGame.id;
  }, id);
  const mia = await page.evaluate(() => {
    const x = window.Lair.store.backend.staffMembers().find((p) => p.name === 'Mia Chen');
    return { id: Number(x.customerId), first_name: 'Mia', last_name: 'Chen', name: 'Mia Chen', email: x.email, phone: null, tags: [] };
  });

  // 1 to 3, as Mia
  await open('/pages/warhammer', mia);
  await page.waitForSelector('[data-wt-list] .wt__night', { timeout: 15000 }).catch(() => {});
  const next = flat(await page.innerText('[data-wt-next]'));
  check(`${size}: the next night: its date, 5 of 6 free, one player looking`, /^Next one/i.test(next) && /5 of 6 game tables free/.test(next) && /1 player looking for a game/.test(next) && /Painting station open/.test(next), next);
  check(`${size}: Book a game table opens tonight on the calendar`, (await page.getAttribute('[data-wt-next] a', 'href')) === `/pages/events-calendar#event=${encodeURIComponent(id)}`);
  const list = flat(await page.innerText('[data-wt-list]'));
  check(`${size}: Ruby's game, by first name, with its size, start and tables`, /Ruby · Warhammer 40,000/.test(list) && /1,000 points · from 6\s?pm · T10 \+ T11/i.test(list) && /New players welcome/.test(list), list.slice(0, 300));
  const join = await page.getAttribute('[data-wt-list] a.button--ruby', 'href');
  check(`${size}: Join goes to the calendar's join sheet for that game`, join === `/pages/events-calendar?game=${encodeURIComponent(listed)}#event=${encodeURIComponent(id)}`, join);
  check(`${size}: each night has Post a game`, (await page.locator('.wt__post').count()) >= 3);
  check(`${size}: a night nobody's posted for says Post the first game for others to join (no Discord without its webhook)`, /Nobody’s looking yet\. Post the first game for others to join\./.test(list) && !/Discord/.test(list), list.slice(0, 400));
  check(`${size}: no note for a member`, await page.locator('[data-wt-note]').isHidden());
  await page.check('[data-wt-filters] input[value="kill-team"]');
  check(`${size}: the filter: nobody's looking for Kill Team`, /Nobody’s looking for that game yet/.test(flat(await page.innerText('[data-wt-list]'))) && !/Ruby/.test(flat(await page.innerText('[data-wt-list]'))));
  await page.check('[data-wt-filters] input[value="all"]');
  await page.waitForSelector('[data-wt-learn-when]:not([hidden])', { timeout: 10000 }).catch(() => {});
  const learn = flat(await page.innerText('.wt__learn'));
  check(`${size}: Learn to paint: its next date and the prices`, /Next: \w+ \d+ \w+, \d.* to \d/i.test(learn) && /\$10/.test(learn) && /\$5 more/.test(learn), learn.slice(-160));
  check(`${size}: Book a seat opens it on the calendar`, /\/pages\/events-calendar#event=(learn-to-paint|demo-learn)%40/.test(await page.getAttribute('[data-wt-learn-book]', 'href')));
  await page.waitForTimeout(400); // the chip just picked fades to its colour; axe measures after
  await scan(page, `${size} the hobby page's Thursdays`, 'warhammer-thursdays');
  if (phone) await page.screenshot({ path: `${OUT}/${size}-hobby.png`, fullPage: true });
  check(`${size}: no sideways scroll`, (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);

  // logged out: "A player", and the note
  await open('/pages/warhammer', null);
  await page.waitForSelector('[data-wt-list] .wt__night', { timeout: 15000 }).catch(() => {});
  const out = flat(await page.innerText('[data-wt-list]'));
  check(`${size}: logged out: "A player", never Ruby`, /A player · Warhammer 40,000/.test(out) && !/Ruby/.test(out), out.slice(0, 200));
  check(`${size}: logged out: the note says to log in`, await page.locator('[data-wt-note]').isVisible());
  // and Join opens the join sheet with Log in to join, which comes straight back to it (from the review, 6 Nov 2026)
  await open(`/pages/events-calendar?game=${encodeURIComponent(listed)}#event=${encodeURIComponent(id)}`, null);
  await page.waitForSelector('.cal-open-join', { timeout: 15000 }).catch(() => {});
  const back = await page.evaluate(() => {
    const a = document.querySelector('[data-open-login]');
    return a ? new URL(a.href, location.href).searchParams.get('return_to') : null;
  });
  check(`${size}: logged out, the join sheet has Log in to join (no Join the game), back to this game`,
    (await page.locator('[data-open-go]').count()) === 0 && back === `/pages/events-calendar?game=${encodeURIComponent(listed)}#event=${encodeURIComponent(id)}`, back);
  check(`${size}: logged out, the sheet says why`, /Log in to join a game, so it shows in My Lair/.test(flat(await page.innerText('.cal-open-join'))));
  await open('/pages/events-calendar', null);
  await page.waitForSelector('lair-calendar .cal-card', { state: 'attached', timeout: 20000 });
  await page.evaluate((occ) => document.querySelector('lair-calendar').openItem(occ), id);
  await page.waitForSelector('[data-open-games] .cal-open__game', { timeout: 15000 }).catch(() => {});
  const listBack = await page.evaluate(() => {
    const a = document.querySelector('[data-open-games] a[href*="customer_authentication"]');
    return a ? new URL(a.href, location.href).searchParams.get('return_to') : null;
  });
  check(`${size}: logged out, the event sheet's Log in to join comes back to that game's join sheet`, listBack === `/pages/events-calendar?game=${encodeURIComponent(listed)}#event=${encodeURIComponent(id)}`, listBack);

  // 4. the links
  await open(`/pages/events-calendar?game=${encodeURIComponent(listed)}#event=${encodeURIComponent(id)}`, mia);
  await page.waitForSelector('[data-open-go]', { timeout: 15000 }).catch(() => {});
  check(`${size}: Join's link opens the join sheet for Ruby's game`, (await page.locator('[data-open-go]').count()) === 1 && /Join Ruby’s game/.test(flat(await page.innerText('body'))));
  check(`${size}: and leaves the address clean`, !(await page.evaluate(() => location.search.includes('game='))));
  await open(`/pages/events-calendar?find=1#event=${encodeURIComponent(id)}`, mia);
  await page.waitForSelector('[data-reserve-form]', { timeout: 15000 }).catch(() => {});
  check(`${size}: Post a game's link opens Reserve with Find me one picked`, await page.evaluate(() => Boolean(document.querySelector('[data-reserve-form] [name="opponent"][value="find"]')?.checked) && !document.querySelector('[data-looking]').hidden));
  check(`${size}: no console errors`, !errors.length, errors);
  await ctx.close();
}
await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed. Screenshots in ${OUT}`);
process.exit(fail ? 1 : 0);

// Round 31, open games (contract v31-open-games), the theme's side in demo mode on the theme mock, with a Warhammer night
// tonight (6pm to midnight, six pairs, $10 a person), at phone (390px) then desktop (1280px), each in a fresh demo:
//   1. the night's sheet: "Looking for a game", nobody yet
//   2. Ruby reserves with Find me one: the player box goes, Game (six), Size ("Not fussed" picked; none for Kill Team) and
//      new players come; the button says List my game; the ticket says Game listed, 1 v 1, the game, Gobgob's finding one
//   3. logged out: "A player · Warhammer 40,000", and Log in to join
//   4. Mia joins from the list: the join sheet (the game, when, the tables, $10), Join the game, then the sheet says
//      she's in and her row says You're in; Ruby's says Game on with Mia
//   5. axe (WCAG 2.2 A and AA) on Find me one and the join sheet; no sideways scroll; no console errors
// Usage: DG_THEME=/path/to/theme [PORT=4995] [AXE=/path/to/axe.min.js] [OUT=/dir] node tools/qa/round31/open-games.mjs [phone|desktop]
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
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round31-open-games');
const AXE = process.env.AXE && fs.existsSync(process.env.AXE) ? fs.readFileSync(process.env.AXE, 'utf8') : null;
fs.mkdirSync(OUT, { recursive: true });
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
const ev = await import(new URL('../theme-mock/events-mock.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4995);
const BASE = `http://localhost:${PORT}`;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };

/* ---------- the page clock (today, 1pm in Auckland) and a Warhammer night tonight ---------- */
const TZ = 'Pacific/Auckland';
const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const offset = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${key}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const iso = (key, hm) => `${key}T${hm}:00${offset(key)}`;
const today = lairKey(Date.now());
const tomorrow = lairKey(Date.parse(iso(today, '12:00')) + 24 * 3600 * 1000);
const AT = Date.parse(iso(today, '13:00'));
const CLOCK = `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;
const HANDLE = 'r31-warhammer-night';
ev.extraEvents.push({
  handle: HANDLE, title: 'Warhammer night (round 31)', event_type: 'wargame', starts_at: iso(today, '18:00'), ends_at: iso(tomorrow, '00:00'), image_slug: 'warhammer', game: 'Warhammer',
  description: 'Bring your army.', tables: 'T8-T21', lock_tables: true, game_tables: 'T8+T9, T10+T11, T12+T13, T14+T15, T18+T19, T20+T21', entry_fee: 10, payment: null,
});
// and one in three days, to drop out of from My Lair (more than 24 hours away)
const LATER = lairKey(Date.parse(iso(today, '12:00')) + 3 * 24 * 3600 * 1000);
const LATER_END = lairKey(Date.parse(iso(LATER, '12:00')) + 24 * 3600 * 1000);
const LATER_HANDLE = 'r31-warhammer-later';
ev.extraEvents.push({
  handle: LATER_HANDLE, title: 'Warhammer night (round 31, later)', event_type: 'wargame', starts_at: iso(LATER, '18:00'), ends_at: iso(LATER_END, '00:00'), image_slug: 'warhammer', game: 'Warhammer',
  description: 'Bring your army.', tables: 'T8-T21', lock_tables: true, game_tables: 'T8+T9, T10+T11, T12+T13, T14+T15, T18+T19, T20+T21', entry_fee: 10, payment: null,
});
const RUBY = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [] };
const MOBILE = '021 555 0123';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  return ok;
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
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
  await open('/pages/events-calendar', RUBY);
  await page.evaluate(() => localStorage.clear());
  await open('/pages/events-calendar', RUBY);
  await page.waitForSelector('lair-calendar .cal-card', { state: 'attached', timeout: 20000 });
  const id = await page.evaluate((h) => (document.querySelector('lair-calendar').all().find((i) => i.handle === h) || {}).id, HANDLE);
  check(`${size}: the Warhammer night is on the calendar tonight`, Boolean(id), id);
  const mia = await page.evaluate(() => {
    const x = window.Lair.store.backend.staffMembers().find((p) => p.name === 'Mia Chen');
    return { id: Number(x.customerId), first_name: 'Mia', last_name: 'Chen', name: 'Mia Chen', email: x.email, phone: null, tags: [] };
  });
  const sheet = async (customer) => {
    await open(`/pages/events-calendar#event=${encodeURIComponent(id)}`, customer);
    await page.waitForSelector('[data-open-games] .cal-open__title', { timeout: 10000 }).catch(() => {});
  };

  // 1. nobody yet
  await sheet(RUBY);
  check(`${size}: the night's sheet says nobody's looking yet`, /^Looking for a game Nobody’s looking yet/.test(flat(await page.innerText('[data-open-games]'))), await page.innerText('[data-open-games]'));

  // 2. Find me one
  await page.click(`[data-reserve="${id}"]`);
  await page.waitForSelector('[data-reserve-form]');
  const before = await page.evaluate(() => ({
    opponent: [...document.querySelectorAll('[data-reserve-form] [name="opponent"]')].map((r) => [r.value, r.checked, r.closest('label').textContent.trim()]),
    looking: document.querySelector('[data-looking]').hidden,
  }));
  check(`${size}: "Your opponent": I've got one (picked) or Find me one`, JSON.stringify(before.opponent) === JSON.stringify([['named', true, 'I’ve got one'], ['find', false, 'Find me one']]) && before.looking, before);
  await page.check('[data-reserve-form] [name="opponent"][value="find"]');
  const find = await page.evaluate(() => ({
    players: document.querySelector('[data-players]').hidden,
    looking: document.querySelector('[data-looking]').hidden,
    games: [...document.querySelectorAll('[data-reserve-form] [name="game"]')].map((r) => r.closest('label').textContent.trim()),
    sizes: [...document.querySelectorAll('[data-reserve-form] [name="size"]')].map((r) => [r.closest('label').textContent.trim(), r.checked]),
    button: document.querySelector('[data-reserve-submit]').textContent.trim(),
  }));
  check(`${size}: Find me one: no player box, the game and size instead, and List my game`, find.players && !find.looking && /^List my game · \$10 on your tab/.test(find.button), find);
  check(`${size}: six games to pick from`, JSON.stringify(find.games) === JSON.stringify(['Warhammer 40,000', 'Age of Sigmar', 'Kill Team', 'The Old World', 'Bolt Action', 'Something else']), find.games);
  check(`${size}: 40k's sizes, Not fussed picked`, JSON.stringify(find.sizes) === JSON.stringify([['Combat Patrol', false], ['1,000 points', false], ['2,000 points', false], ['Not fussed', true]]), find.sizes);
  await page.check('[data-reserve-form] [name="game"][value="kill-team"]');
  check(`${size}: Kill Team has no size to pick`, await page.evaluate(() => document.querySelector('[data-looking-sizes]').hidden && !document.querySelector('[data-reserve-form] [name="size"]')));
  await page.check('[data-reserve-form] [name="game"][value="40k"]');
  await page.check('[data-reserve-form] [name="size"][value="1000"]');
  await page.check('[data-reserve-form] [name="newPlayers"]');
  await page.fill('[data-reserve-form] [name="phone"]', MOBILE);
  await scan(page, `${size} Find me one`, '[data-reserve-form]');
  if (phone) await page.screenshot({ path: `${OUT}/${size}-find-me-one.png` });
  await page.click('[data-reserve-submit]');
  await page.waitForTimeout(800);
  const ticket = flat(await page.innerText('.cal-ticket').catch(() => ''));
  check(`${size}: the ticket: Game listed, 1 v 1, the game, Gobgob's finding one`, /Game listed/.test(ticket) && /Players 1 v 1/.test(ticket) && /Game Warhammer 40,000, 1,000 points, new players welcome/.test(ticket) && /Gobgob’s finding you one/.test(ticket), ticket.slice(0, 600));

  // 3. logged out
  await sheet(null);
  const out = flat(await page.innerText('[data-open-games]'));
  check(`${size}: logged out: "A player", the game, and Log in to join`, /A player · Warhammer 40,000/.test(out) && /1,000 points · from 6\s?pm · T8 \+ T9/i.test(out) && /New players welcome/.test(out) && (await page.locator('[data-open-games] a', { hasText: 'Log in to join' }).count()) === 1 && !/Ruby/.test(out), out);

  // 4. Mia joins
  await sheet(mia);
  const list = flat(await page.innerText('[data-open-games]'));
  check(`${size}: Mia sees Ruby's game, with Join`, /Ruby · Warhammer 40,000/.test(list) && (await page.locator('[data-open-join]').count()) === 1, list);
  await page.click('[data-open-join]');
  await page.waitForSelector('[data-open-go]');
  const join = flat(await page.innerText('.cal-open-join'));
  check(`${size}: the join sheet: the game, when, the tables, $10`, /Warhammer 40,000, 1,000 points, new players welcome/.test(join) && /from 6\s?pm/i.test(join) && /Tables T8 \+ T9, terrain ready/.test(join) && /\$10 at the counter on the night/.test(join), join);
  await scan(page, `${size} the join sheet`, '.cal-open-join');
  if (phone) await page.screenshot({ path: `${OUT}/${size}-join.png` });
  await page.click('[data-open-go]');
  await page.waitForSelector('.cal-flash', { timeout: 10000 }).catch(() => {});
  const after = flat(await page.textContent('.cal-flash').catch(() => ''));
  check(`${size}: she's in, the sheet says so`, /You’re in Ruby’s game/.test(after), after);
  await page.waitForSelector('[data-open-games] .cal-open__badge', { timeout: 10000 }).catch(() => {});
  check(`${size}: her row says You're in`, flat(await page.innerText('[data-open-games]')).includes('You’re in'));
  await sheet(RUBY);
  check(`${size}: Ruby's row says Game on with Mia`, flat(await page.innerText('[data-open-games]')).includes('Game on with Mia'));
  // 5. three days out: Ruby lists, Mia joins, then drops out from My Lair; it's listed again
  const later = await page.evaluate((h) => (document.querySelector('lair-calendar').all().find((i) => i.handle === h) || {}).id, LATER_HANDLE);
  await open(`/pages/events-calendar#event=${encodeURIComponent(later)}`, RUBY);
  await page.waitForTimeout(700);
  await page.click(`[data-reserve="${later}"]`);
  await page.waitForSelector('[data-reserve-form]');
  await page.check('[data-reserve-form] [name="opponent"][value="find"]');
  await page.fill('[data-reserve-form] [name="phone"]', MOBILE);
  await page.click('[data-reserve-submit]');
  await page.waitForTimeout(800);
  await open(`/pages/events-calendar#event=${encodeURIComponent(later)}`, mia);
  await page.waitForSelector('[data-open-join]', { timeout: 10000 });
  await page.click('[data-open-join]');
  await page.waitForSelector('[data-open-go]');
  check(`${size}: three days out, the join sheet says she can drop out in My Lair`, /Drop out in My Lair until 24 hours before/.test(flat(await page.innerText('.cal-open-join'))));
  await page.click('[data-open-go]');
  await page.waitForSelector('.cal-flash', { timeout: 10000 }).catch(() => {});
  await open('/pages/my-lair#bookings', mia);
  await page.waitForSelector('[data-drop-out]', { timeout: 15000 }).catch(() => {});
  check(`${size}: My Lair: Mia's ticket has Drop out`, (await page.locator('[data-drop-out]').count()) === 1);
  if ((await page.locator('[data-drop-out]').count()) === 1) {
    // My Lair redraws as it loads, so Playwright's wait for a still button never settles: scroll and tap from the page
    await page.evaluate(() => (document.querySelector('[data-drop-out]').closest('.ml-ticket') || document.querySelector('[data-drop-out]')).scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(400);
    if (phone) await page.screenshot({ path: `${OUT}/${size}-my-lair-drop-out.png` });
    await page.evaluate(() => document.querySelector('[data-drop-out]').click());
    await page.waitForSelector('[data-confirm-drop-out]');
    check(`${size}: the dialog asks first`, /Drop out of Ruby’s game\?/.test(flat(await page.innerText('[data-cancel-title]'))));
    await scan(page, `${size} the drop out dialog`, '[data-cancel-dialog]');
    await page.evaluate(() => document.querySelector('[data-confirm-drop-out]').click());
    await page.waitForTimeout(800);
    check(`${size}: done, and it says so`, /You’ve dropped out of Ruby’s game, and Gobgob has listed it again/.test(flat(await page.innerText('body'))));
    await open(`/pages/events-calendar#event=${encodeURIComponent(later)}`, mia);
    await page.waitForSelector('[data-open-games] .cal-open__title', { timeout: 10000 }).catch(() => {});
    check(`${size}: the game is listed again, with Join`, (await page.locator('[data-open-join]').count()) === 1);
  }
  check(`${size}: no sideways scroll`, (await overflowX(page)) <= 0);
  check(`${size}: no console errors`, !errors.length, errors);
  await ctx.close();
}
await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed. Screenshots in ${OUT}`);
process.exit(fail ? 1 : 0);

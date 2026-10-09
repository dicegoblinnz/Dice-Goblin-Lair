// Round 8, holds (contract v8 section 1): staff table holds that repeat weekly or fortnightly (Mo, 6 Oct: "make the
// session or event holding can have the option to hold weekly just like ttrpg sessions"). Demo mode on the theme mock,
// phone (390px) then desktop (1280px):
//   - the Hold tables form: Repeats (Doesn't repeat, Weekly, Fortnightly) and, when it repeats, Last date (optional)
//   - a weekly hold made from the form: the toast, one card in the holds list (tag, tables, next dates with Skip this
//     date, Stop repeating), its dates in the demo up to the horizon plus 7 days
//   - Skip this date, and Stop repeating (asks first, Keep it, then Yes), with focus kept where it makes sense
//   - the floor: Remove on a weekly hold's date asks "Just this date, or stop repeating?" (Keep it, Just this date, Stop
//     repeating); the floor's quick hold has no Repeats and stays a one-off
//   - a one-off made from the Holds tab is as before; the demo's messages; no script errors, nothing wider than the page
// Then, once, in live mode with the Lair app's routes answered here: LiveBackend's removeBlock(id, options) and
// createBlock send what the contract says.
// Usage: DG_THEME=/path/to/theme PORT=4911 [SHOTS=/dir] node tools/qa/round8/holds.mjs [phone|desktop]   (exits 1 on a FAIL)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4911);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const shot = async (page, name, selector = null) => {
  if (!SHOTS) return;
  const file = path.join(SHOTS, `${name}.png`);
  if (selector) await page.locator(selector).first().screenshot({ path: file }).catch(() => page.screenshot({ path: file }));
  else await page.screenshot({ path: file });
};

const server = await m.serve(PORT);
const browser = await chromium.launch();
m.mockState.customer = STAFF;
for (const size of process.argv[2] ? [process.argv[2]] : ['phone', 'desktop']) {
  const phone = size === 'phone';
  const ctx = await browser.newContext({ viewport: SIZES[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto(`${BASE}/pages/lair-staff`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.data, null, { timeout: 15000 });
  const toast = async () => clean(await page.locator('.toast').last().textContent().catch(() => ''));
  const focused = () => page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName.toLowerCase()}${el.dataset.act ? `[${el.dataset.act}]` : ''}${el.id ? `#${el.id}` : ''}|${clean(el.textContent)}`.slice(0, 120) : '';
    function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  });
  // what the demo knows, worked out in the page (Lair time)
  const info = await page.evaluate(() => {
    const { store } = window.Lair;
    const t = store.time;
    const day = t.addDays(t.today(), 2);
    return { day, weekday: t.fmtLong(day).split(/[ ,]/)[0], horizon: store.cfg.horizonDays, today: t.today() };
  });

  /* ---- the Hold tables form ---- */
  await page.click('[data-tab="holds"]');
  await page.waitForSelector('[data-panel="holds"] [data-hold-form]');
  const chips = await page.$$eval('[data-panel="holds"] [data-hold-repeat]', (els) => els.map((e) => [e.value, e.checked, e.closest('label').textContent.trim()]));
  check(`${size}: the form's Repeats: Doesn't repeat (chosen), Weekly, Fortnightly`, JSON.stringify(chips) === JSON.stringify([['', true, 'Doesn’t repeat'], ['weekly', false, 'Weekly'], ['fortnightly', false, 'Fortnightly']]), chips);
  check(`${size}: no last date while it doesn't repeat`, await page.locator('[data-hold-last]').isHidden());
  await page.check('[data-hold-repeat][value="weekly"]', { force: true });
  const lastLabel = clean(await page.textContent('label[for="holdx-last"]'));
  const hintWeek = clean(await page.textContent('[data-hold-last-hint]'));
  check(`${size}: Weekly shows "Last date (optional)" with its hint`, (await page.locator('[data-hold-last]').isVisible()) && lastLabel === 'Last date (optional)' && hintWeek === 'Leave it empty to keep holding every week.', [lastLabel, hintWeek]);
  await page.check('[data-hold-repeat][value="fortnightly"]', { force: true });
  check(`${size}: Fortnightly's hint says fortnight`, clean(await page.textContent('[data-hold-last-hint]')) === 'Leave it empty to keep holding every fortnight.');
  await page.check('[data-hold-repeat][value="weekly"]', { force: true });
  // the form survives the floor updating (it used to be drawn again on every change)
  await page.fill('#holdx-tables', 'T14-T17');
  await page.fill('#holdx-label', 'Pokémon league (r8)');
  await page.selectOption('#holdx-type', 'tournament');
  await page.fill('#holdx-day', info.day);
  await page.fill('#holdx-from', '18:00');
  await page.fill('#holdx-to', '22:00');
  await page.locator('#holdx-to').blur();
  await page.evaluate(() => window.Lair.store.mutate('createBooking', { kind: 'walkin', tables: ['P1'], room: 'party-room', start: Date.now(), end: Date.now() + 3600000, people: 2, name: 'Walk-in', status: 'seated', pay: 'day', staffOverride: true }));
  await page.waitForTimeout(300);
  const kept = await page.evaluate(() => [document.querySelector('#holdx-tables').value, document.querySelector('#holdx-label').value, document.querySelector('[data-hold-repeat]:checked').value]);
  check(`${size}: what's typed stays when the floor updates`, JSON.stringify(kept) === JSON.stringify(['T14-T17', 'Pokémon league (r8)', 'weekly']), kept);
  check(`${size}: the last date can't be before the Day`, (await page.getAttribute('#holdx-last', 'min')) === info.day, await page.getAttribute('#holdx-last', 'min'));
  await shot(page, `${size}-form-weekly`, '[data-panel="holds"] [data-hold-form]');

  /* ---- a weekly hold from the form ---- */
  await page.click('[data-panel="holds"] [data-hold-form] button[type="submit"]');
  await page.waitForSelector('[data-series]', { timeout: 10000 }).catch(() => {});
  const made = await toast();
  check(`${size}: the toast says what's held`, made.startsWith(`Holding T14–T17 every ${info.weekday}, 6pm–10pm.`), made);
  const series = await page.evaluate((label) => {
    const { store } = window.Lair;
    const s = (store.backend.state.holdSeries || []).find((x) => x.label === label);
    const dates = store.backend.state.blocks.filter((b) => b.seriesId === (s && s.id)).sort((a, b) => a.start - b.start).map((b) => [store.time.key(b.start), store.time.minutesOf(b.start), b.end - b.start]);
    return { id: s && s.id, dates };
  }, 'Pokémon league (r8)');
  const expectDays = await page.evaluate(({ day, horizon }) => {
    const t = window.Lair.store.time;
    const out = [];
    for (let d = day; t.at(d, 18 * 60) <= Date.now() + (horizon + 7) * 86400000; d = t.addDays(d, 7)) out.push(d);
    return out;
  }, info);
  check(`${size}: a hold every week at 6pm for 4 hours, up to the horizon plus 7 days (${expectDays.length})`, JSON.stringify(series.dates.map((d) => d[0])) === JSON.stringify(expectDays) && series.dates.every((d) => d[1] === 18 * 60 && d[2] === 4 * 3600000), series.dates.map((d) => d[0]));
  const card = `[data-series="${series.id}"]`;
  const cardText = clean(await page.textContent(card).catch(() => ''));
  check(`${size}: one card for it: label, tag, tables and times`, cardText.includes('Pokémon league (r8)') && cardText.includes(`Weekly · ${info.weekday}s 6pm`) && cardText.includes('T14–T17 · 6pm–10pm'), cardText.slice(0, 160));
  const rows = await page.$$eval(`${card} .staff-series__date`, (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  check(`${size}: its next 4 dates, each with Skip this date`, rows.length === 4 && rows.every((r) => r.endsWith('Skip this date')), rows);
  check(`${size}: "Then every ${info.weekday}." and Stop repeating`, cardText.includes(`Then every ${info.weekday}.`) && (await page.locator(`${card} [data-act="series-stop"]`).count()) === 1, cardText);
  check(`${size}: the form starts again (Doesn't repeat, no last date)`, (await page.evaluate(() => document.querySelector('[data-hold-repeat]:checked').value)) === '' && (await page.locator('[data-hold-last]').isHidden()) && (await page.inputValue('#holdx-label')) === '');
  const cardsForIt = await page.$$eval('[data-holds-list] > article', (els) => els.filter((e) => e.textContent.includes('Pokémon league (r8)')).length);
  check(`${size}: the weekly hold is one card, not one a week`, (await page.locator(card).count()) === 1 && cardsForIt === 1, cardsForIt);
  await page.locator(card).scrollIntoViewIfNeeded();
  await shot(page, `${size}-series-card`, card);

  /* ---- Skip this date ---- */
  const skipName = await page.getAttribute(`${card} [data-act="skipdate"]`, 'aria-label');
  await page.click(`${card} [data-act="skipdate"]`);
  await page.waitForTimeout(400);
  const skipped = await toast();
  const firstDay = await page.evaluate((d) => window.Lair.store.time.fmtDate(d).replace(',', ''), info.day);
  check(`${size}: Skip this date: the toast`, skipped === `Skipped ${firstDay}: T14–T17 are free at that time.`, skipped);
  check(`${size}: …its Skip button's name says the date`, skipName === `Skip this date, ${firstDay}`, skipName);
  const afterSkip = await page.evaluate((id) => {
    const { store } = window.Lair;
    const s = store.backend.state.holdSeries.find((x) => x.id === id);
    return { days: store.backend.state.blocks.filter((b) => b.seriesId === id).map((b) => store.time.key(b.start)).sort(), skip: s.skipDays };
  }, series.id);
  check(`${size}: …that date is gone and on the skip list`, !afterSkip.days.includes(info.day) && JSON.stringify(afterSkip.skip) === JSON.stringify([info.day]) && afterSkip.days.length === expectDays.length - 1, afterSkip);
  check(`${size}: …focus goes on to the next date's Skip`, (await focused()).startsWith('button[skipdate]'), await focused());

  /* ---- Stop repeating: asks first ---- */
  await page.click(`${card} [data-act="series-stop"]`);
  await page.waitForTimeout(200);
  const ask = clean(await page.textContent(`${card} .staff-confirm`).catch(() => ''));
  const nextDay = await page.evaluate((d) => window.Lair.store.time.fmtDate(d).replace(',', ''), expectDays[1]);
  check(`${size}: Stop repeating asks: "Stop holding T14–T17 every ${info.weekday} from ${nextDay}? Earlier dates stay."`, ask.startsWith(`Stop holding T14–T17 every ${info.weekday} from ${nextDay}? Earlier dates stay.`), ask);
  check(`${size}: …with focus on Yes`, (await focused()).startsWith('button[series-stop-yes]'), await focused());
  await shot(page, `${size}-series-stop-ask`, card);
  await page.click(`${card} [data-act="series-stop-no"]`);
  await page.waitForTimeout(200);
  check(`${size}: Keep it: nothing changes, focus back on Stop repeating`, (await page.locator(`${card} .staff-confirm`).count()) === 0 && (await focused()).startsWith('button[series-stop]'), await focused());
  await page.click(`${card} [data-act="series-stop"]`);
  await page.click(`${card} [data-act="series-stop-yes"]`);
  await page.waitForTimeout(400);
  const stopped = await toast();
  check(`${size}: Yes: stopped, with the toast`, stopped === `Stopped repeating: Pokémon league (r8) isn’t held from ${nextDay} on. Earlier dates stay.`, stopped);
  const afterStop = await page.evaluate((id) => {
    const { store } = window.Lair;
    const s = store.backend.state.holdSeries.find((x) => x.id === id);
    return { left: store.backend.state.blocks.filter((b) => b.seriesId === id).length, status: s.status, until: s.until, view: store.backend.holdSeriesView(s).status };
  }, series.id);
  check(`${size}: …no dates left, the series stopped the day before`, afterStop.left === 0 && afterStop.status === 'stopped' && afterStop.view === 'stopped', afterStop);
  check(`${size}: …its card goes, focus on the list's heading`, (await page.locator(card).count()) === 0 && (await focused()).startsWith('h3#holds-list-title'), await focused());

  /* ---- a fortnightly hold with a last date, from the form ---- */
  await page.fill('#holdx-tables', 'G3-G4');
  await page.fill('#holdx-label', 'Kill Team league (r8)');
  await page.fill('#holdx-day', info.day);
  await page.check('[data-hold-repeat][value="fortnightly"]', { force: true });
  const lastDate = await page.evaluate((d) => window.Lair.store.time.addDays(d, 28), info.day);
  await page.fill('#holdx-last', lastDate);
  await page.click('[data-panel="holds"] [data-hold-form] button[type="submit"]');
  await page.waitForTimeout(400);
  const fort = await page.evaluate(() => {
    const { store } = window.Lair;
    const s = store.backend.state.holdSeries.find((x) => x.label === 'Kill Team league (r8)');
    return { id: s && s.id, days: store.backend.state.blocks.filter((b) => b.seriesId === (s && s.id)).map((b) => store.time.key(b.start)).sort() };
  });
  const lastShort = await page.evaluate((d) => window.Lair.store.time.fmtDate(d).replace(',', ''), lastDate);
  const fortText = clean(await page.textContent(`[data-series="${fort.id}"]`).catch(() => ''));
  check(`${size}: fortnightly until a last date: 3 dates, the tag and the last date on the card`, fort.days.length === 3 && fortText.includes(`Fortnightly · ${info.weekday}s 6pm · last date ${lastShort}`), { days: fort.days, fortText: fortText.slice(0, 140) });
  check(`${size}: …the toast says every second ${info.weekday}, until the last date`, (await toast()).startsWith(`Holding G3–G4 every second ${info.weekday}, 6pm–10pm, until ${lastShort}.`), await toast());

  /* ---- the messages ---- */
  await page.fill('#holdx-tables', 'P3');
  await page.fill('#holdx-label', 'Too early (r8)');
  await page.fill('#holdx-day', info.day);
  await page.check('[data-hold-repeat][value="weekly"]', { force: true });
  await page.fill('#holdx-last', info.today);
  await page.locator('#holdx-last').dispatchEvent('change');
  const tooEarly = "'Repeat until' has to be a date on or after the first one.";
  check(`${size}: a last date before the Day: the field says so, in the Lair app's words`, (await page.$eval('#holdx-last', (el) => el.validationMessage)) === tooEarly, await page.$eval('#holdx-last', (el) => el.validationMessage));
  await page.click('[data-panel="holds"] [data-hold-form] button[type="submit"]');
  await page.waitForTimeout(300);
  check(`${size}: …and nothing is held`, !(await page.evaluate(() => window.Lair.store.data.blocks.some((b) => b.label === 'Too early (r8)'))));
  // past the browser's own check (a typed date, an old browser): the demo answers as the Lair app does, by the form
  await page.$eval('[data-panel="holds"] [data-hold-form]', (f) => { f.noValidate = true; });
  await page.click('[data-panel="holds"] [data-hold-form] button[type="submit"]');
  await page.waitForTimeout(300);
  const formError = clean(await page.textContent('[data-panel="holds"] [data-form-error]'));
  check(`${size}: …the app's message shows by the form`, formError === tooEarly && (await page.locator('[data-panel="holds"] [data-form-error]').isVisible()), formError);
  await page.$eval('[data-panel="holds"] [data-hold-form]', (f) => { f.noValidate = false; });
  const monthly = await page.evaluate(() => window.Lair.store.backend.createBlock({ tables: ['T1'], start: Date.now() + 86400000, end: Date.now() + 90000000, label: 'x', repeat: 'monthly' }).then(() => 'made', (e) => e.message));
  check(`${size}: the demo's message for another repeat`, monthly === 'Pick how often it repeats: weekly or fortnightly. Or leave it as a one-off.', monthly);
  // back to Doesn't repeat with that last date still in the (hidden) field: it doesn't stop a one-off
  await page.check('[data-hold-repeat][value=""]', { force: true });
  check(`${size}: Doesn't repeat switches the last date off`, await page.$eval('#holdx-last', (el) => el.disabled && el.closest('[data-hold-last]').hidden));
  await page.fill('#holdx-label', 'Quick market (r8)');
  await page.click('[data-panel="holds"] [data-hold-form] button[type="submit"]');
  await page.waitForTimeout(300);
  /* ---- a one-off from the Holds tab is as before ---- */
  check(`${size}: a one-off: "Held 1 table", the error gone, a plain card with Remove`, (await toast()) === 'Held 1 table' && (await page.locator('[data-panel="holds"] [data-form-error]').isHidden())
    && clean(await page.textContent('[data-holds-list]')).includes('Quick market (r8)'), await toast());
  const oneOff = await page.evaluate(() => window.Lair.store.data.blocks.find((b) => b.label === 'Quick market (r8)'));
  check(`${size}: …it doesn't repeat (no series)`, oneOff && oneOff.seriesId === null && oneOff.repeat === null && oneOff.repeatTag === null && oneOff.until === null, oneOff);

  /* ---- the floor: a weekly hold's date asks first ---- */
  const now = await page.evaluate(async () => {
    const { store } = window.Lair;
    const t = store.time;
    const start = Date.now() - 3600000;
    const a = await store.mutate('createBlock', { tables: ['P2'], start, end: start + 3 * 3600000, label: 'Painting club (r8)', type: 'event', repeat: 'weekly' });
    const b = await store.mutate('createBlock', { tables: ['T21'], start, end: start + 3 * 3600000, label: 'Book club (r8)', type: 'event', repeat: 'weekly' });
    return { a: a.series.id, b: b.series.id, weekday: t.fmtLong(t.today()).split(/[ ,]/)[0] };
  });
  await page.click('[data-tab="floor"]');
  await page.evaluate(() => document.querySelector('[data-table="P2"]').click());
  await page.waitForTimeout(300);
  const sheet = clean(await page.textContent('[data-sheet]'));
  check(`${size}: the floor's sheet shows the weekly hold with its tag`, sheet.includes('Painting club (r8)') && sheet.includes(`Weekly · ${now.weekday}s`), sheet.slice(0, 200));
  await page.click('[data-sheet] [data-act="unhold"]');
  await page.waitForTimeout(200);
  const question = clean(await page.textContent('[data-sheet] .staff-confirm').catch(() => ''));
  const buttons = await page.$$eval('[data-sheet] .staff-confirm button', (els) => els.map((e) => e.textContent.trim()));
  check(`${size}: Remove asks "Just this date, or stop repeating?"`, question.startsWith('Just this date, or stop repeating?') && JSON.stringify(buttons) === JSON.stringify(['Just this date', 'Stop repeating', 'Keep it']), { question, buttons });
  check(`${size}: …with focus on Just this date`, (await focused()).startsWith('button[unhold-date]'), await focused());
  await page.locator('[data-sheet]').scrollIntoViewIfNeeded();
  await shot(page, `${size}-floor-question`, '[data-sheet]');
  await page.click('[data-sheet] [data-act="unhold-keep"]');
  await page.waitForTimeout(200);
  check(`${size}: Keep it: back to Remove hold, focused`, (await page.locator('[data-sheet] .staff-confirm').count()) === 0 && (await focused()).startsWith('button[unhold]'), await focused());
  await page.click('[data-sheet] [data-act="unhold"]');
  await page.click('[data-sheet] [data-act="unhold-date"]');
  await page.waitForTimeout(400);
  const justOne = await page.evaluate((id) => {
    const { store } = window.Lair;
    const s = store.backend.state.holdSeries.find((x) => x.id === id);
    return { left: store.backend.state.blocks.filter((b) => b.seriesId === id).length, skip: s.skipDays, today: store.time.today(), status: s.status };
  }, now.a);
  check(`${size}: Just this date: today's goes (skipped), the later dates stay`, justOne.left > 3 && JSON.stringify(justOne.skip) === JSON.stringify([justOne.today]) && justOne.status === 'active', justOne);
  check(`${size}: …the toast`, (await toast()) === 'Painting club (r8) isn’t held today. Its other dates stay.', await toast());
  check(`${size}: …P2 is free now, focus stays in the sheet`, !clean(await page.textContent('[data-sheet]')).includes('Painting club (r8)') && (await focused()).startsWith('h3'), await focused());
  await page.evaluate(() => document.querySelector('[data-table="T21"]').click());
  await page.waitForTimeout(300);
  await page.click('[data-sheet] [data-act="unhold"]');
  await page.click('[data-sheet] [data-act="unhold-later"]');
  await page.waitForTimeout(400);
  const stoppedFloor = await page.evaluate((id) => {
    const { store } = window.Lair;
    const s = store.backend.state.holdSeries.find((x) => x.id === id);
    return { left: store.backend.state.blocks.filter((b) => b.seriesId === id).length, status: s.status };
  }, now.b);
  check(`${size}: Stop repeating from the floor: today's and every later date go, stopped`, stoppedFloor.left === 0 && stoppedFloor.status === 'stopped', stoppedFloor);
  check(`${size}: …the toast`, (await toast()) === 'Stopped repeating: Book club (r8) isn’t held from today on. Earlier dates stay.', await toast());

  /* ---- the floor's quick hold stays a one-off ---- */
  await page.evaluate(() => {
    const staff = document.querySelector('lair-staff');
    staff.selected = [];
    staff.tapTable('T19');
  });
  await page.waitForTimeout(300);
  const quick = page.locator('[data-sheet] .staff-hold');
  check(`${size}: the floor's quick hold has no Repeats`, (await quick.count()) === 1 && (await page.locator('[data-sheet] [data-hold-repeat]').count()) === 0);
  await page.click('[data-sheet] .staff-hold summary');
  await page.fill('#hold-label', 'Impromptu (r8)');
  await page.fill('#hold-from', '');
  await page.click('[data-sheet] [data-hold-form] button[type="submit"]');
  await page.waitForTimeout(400);
  const quickHold = await page.evaluate(() => window.Lair.store.data.blocks.find((b) => b.label === 'Impromptu (r8)'));
  check(`${size}: …and makes a one-off ("Held 1 table")`, quickHold && quickHold.seriesId === null && (await toast()) === 'Held 1 table', { quickHold, toast: await toast() });

  /* ---- the page ---- */
  await page.click('[data-tab="holds"]');
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${size}: nothing wider than the page`, overflow <= 0, overflow);
  await shot(page, `${size}-holds-tab`);
  check(`${size}: no script errors`, !errors.length, errors);
  await ctx.close();
}

/* ---- LiveBackend: what goes to the Lair app (live mode, the app's routes answered here) ---- */
{
  m.globalSettings.lair_mode = 'live';
  const ctx = await browser.newContext({ viewport: SIZES.desktop });
  const page = await ctx.newPage();
  const sent = [];
  await page.route('**/apps/liar/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.endsWith('/floor')) return route.fulfill({ json: { now: Date.now(), bookings: [], blocks: [], games: [], events: [], eventJoins: {}, eventSpots: {}, joins: [], openings: [], shopTables: [], features: {} } });
    sent.push({ method: req.method(), path: url.pathname, body: req.postData() });
    if (url.pathname.endsWith('/delete')) return route.fulfill({ json: { ok: true, removed: 1 } });
    if (url.pathname.endsWith('/blocks')) return route.fulfill({ json: { block: { id: 'bl_x' }, clashes: [], series: null } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${BASE}/pages/lair-staff`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction(() => window.Lair && window.Lair.store && !window.Lair.store.isDemo, null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(async () => {
    const be = window.Lair.store.backend;
    await be.removeBlock('bl_one');
    await be.removeBlock('bl_two', { later: true });
    await be.createBlock({ tables: ['T14'], start: 1, end: 2, label: 'x', type: 'event', repeat: 'weekly', until: '2026-12-31' });
  });
  const of = (p) => sent.find((x) => x.path.endsWith(p));
  check('live: removeBlock(id) posts {} to /blocks/:id/delete', of('/blocks/bl_one/delete')?.method === 'POST' && of('/blocks/bl_one/delete')?.body === '{}', sent);
  check('live: removeBlock(id, { later: true }) sends the options as the body', of('/blocks/bl_two/delete')?.body === '{"later":true}', sent);
  check('live: createBlock sends repeat and until', JSON.parse(of('/blocks')?.body || '{}').repeat === 'weekly' && JSON.parse(of('/blocks')?.body || '{}').until === '2026-12-31', of('/blocks'));
  await ctx.close();
  m.globalSettings.lair_mode = 'demo';
}
await browser.close();
server.close();
console.log(`holds r8: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

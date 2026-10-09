// Round 11, days: an event that runs several days in a row. Mo (9 Oct 2026): "Oddity Alley third Saturday and Sunday of
// each month … book out the entire floor t1-t21", 10am–4pm both days. On the mock store in demo mode, phone (390) and
// desktop (1280), two extra events: a monthly two-day market (third Saturday and the Sunday after, 10am–4pm, T1–T21
// locked) and a one-off two-day fair (a Saturday and Sunday, 11am–3pm, free).
//   1. lair-config writes "days": 2 for both (and 1 for the rest)
//   2. the calendar has each day as its own date (handle@Saturday and handle@Sunday), the same hours; the Sunday words
//      the series from its Saturday: "Monthly · Third Saturday and Sunday 10am"; weekly two-day reads "Saturdays and
//      Sundays"
//   3. the demo locks T1–T21 on the Sunday as well as the Saturday
//   4. what's on (Liquid): "Monthly · Third Saturday and Sunday 10am to 4pm … Next: Sat …", and the fair "Saturday …
//      and Sunday …, 11am–3pm"; its Event JSON-LD ends on the Sunday
//   5. the staff events editor (as staff): Runs for, the tag as the calendar will say it, a one-off over 2 days, saved
//      (listed with its tag; the config has days 2), edited back to 1 day
//   6. no sideways scroll and no console errors
// Usage: DG_THEME=/path/to/theme PORT=4911 node tools/qa/round11/days.mjs [phone|desktop]
// Exits 1 on a FAIL.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
const ev = await import(new URL('../theme-mock/events-mock.mjs', import.meta.url).href);
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || process.env.QA_PORT || 4911);
const BASE = `http://localhost:${PORT}`;
const ONLY = process.argv[2] || '';
const SIZES = [['phone', 390, 844], ['desktop', 1280, 800]].filter(([tag]) => !ONLY || tag === ONLY);
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };

/* ---------- dates in Lair time ---------- */
const TZ = 'Pacific/Auckland';
const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dow = (key) => new Date(`${key}T12:00:00Z`).getUTCDay();
const today = lairKey(Date.now());
const nextDow = (d, from) => { let k = from; while (dow(k) !== d) k = addDays(k, 1); return k; };
const thirdSaturday = (y, mo) => addDays(nextDow(6, `${y}-${String(mo).padStart(2, '0')}-01`), 14);
const offset = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${key}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const iso = (key, hm) => `${key}T${hm}:00${offset(key)}`;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = (key) => `${DAY_NAMES[dow(key)].slice(0, 3)} ${Number(key.slice(8))} ${MONTHS[Number(key.slice(5, 7)) - 1].slice(0, 3)}`;
const LONG = (key) => `${DAY_NAMES[dow(key)]} ${Number(key.slice(8))} ${MONTHS[Number(key.slice(5, 7)) - 1]}`;

// the monthly market: its first date the third Saturday of last month; the next is the first third Saturday after today
const [ty, tm] = today.split('-').map(Number);
const monthAt = (n) => { const i = ty * 12 + (tm - 1) + n; return [Math.floor(i / 12), (i % 12) + 1]; };
const FIRST = thirdSaturday(...monthAt(-1));
const NS = [0, 1, 2].map((n) => thirdSaturday(...monthAt(n))).find((k) => k > today);
const market = {
  handle: 'two-day-market', title: 'Two-day market', event_type: 'market', starts_at: iso(FIRST, '10:00'), ends_at: iso(FIRST, '16:00'), repeat: 'monthly', days: 2,
  tables: 'T1-T21', lock_tables: true, entry_fee: 0, image_slug: 'market', description: 'The in-store market, Saturday and Sunday.',
};
// the one-off fair: a Saturday at least ten days away, and its Sunday
const FAIR = nextDow(6, addDays(today, 10));
const fair = {
  handle: 'two-day-fair', title: 'Two-day fair', event_type: 'market', starts_at: iso(FAIR, '11:00'), ends_at: iso(FAIR, '15:00'), repeat: null, days: 2,
  entry_fee: 0, image_slug: 'market', description: 'A weekend fair.',
};
ev.extraEvents.push(market, fair);

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' && detail !== undefined ? ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const server = await m.serve(PORT);
const browser = await chromium.launch();
async function open(width, height, url, customer = null) {
  m.mockState.customer = customer;
  const phone = width < 700;
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(`console: ${msg.text()}`); });
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(500);
  return { ctx, page, errors };
}
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

try {
  for (const [tag, width, height] of SIZES) {
    /* ---------- 1–4: the calendar page ---------- */
    {
      const o = await open(width, height, '/pages/events-calendar');
      const p = o.page;
      await p.waitForSelector('lair-calendar .cal-card', { state: 'attached', timeout: 15000 });
      const r = await p.evaluate(({ NS, FAIR }) => {
        const L = window.Lair;
        const t = L.store.time;
        const cfg = Object.fromEntries(L.store.cfg.events.map((e) => [e.id, e.days]));
        const items = document.querySelector('lair-calendar').all();
        const mk = items.filter((i) => i.handle === 'two-day-market');
        const fr = items.filter((i) => i.handle === 'two-day-fair');
        const sun = t.addDays(NS, 1);
        const at = (list, key) => list.find((i) => i.date === key);
        const ms = (v) => (typeof v === 'number' ? v : Date.parse(v));
        const hours = (i) => (i ? `${t.minutesOf(Number.isFinite(i.startMs) ? i.startMs : ms(i.start))}-${t.minutesOf(Number.isFinite(i.endMs) ? i.endMs : ms(i.end))}` : null);
        const be = L.store.backend;
        const occ = be && typeof be.occurrences === 'function' ? be.occurrences() : [];
        const sunOcc = occ.find((o) => o.id === `two-day-market@${sun}`);
        return {
          cfg: { market: cfg['two-day-market'], fair: cfg['two-day-fair'], others: Object.entries(cfg).filter(([id]) => !id.startsWith('two-day-')).every(([, d]) => d === 1) },
          market: { sat: Boolean(at(mk, NS)), sun: Boolean(at(mk, sun)), satHours: hours(at(mk, NS)), sunHours: hours(at(mk, sun)), sunId: at(mk, sun) && at(mk, sun).id },
          fair: { sat: Boolean(at(fr, FAIR)), sun: Boolean(at(fr, t.addDays(FAIR, 1))), sunHours: hours(at(fr, t.addDays(FAIR, 1))), count: fr.length },
          tags: { sat: at(mk, NS) ? L.repeatTag(at(mk, NS), t) : null, sun: at(mk, sun) ? L.repeatTag(at(mk, sun), t) : null, weekly: L.repeatTag({ repeat: 'weekly', start: '2026-10-17T10:00:00+13:00', days: 2 }, t), one: L.repeatTag({ repeat: 'monthly', start: '2026-10-25T12:00:00+13:00', days: 1 }, t) },
          lock: sunOcc ? { lock: sunOcc.lockTables, tables: sunOcc.tables } : null,
        };
      }, { NS, FAIR });
      check(`${tag} config: "days" 2 for the two-day events, 1 for every other`, r.cfg.market === 2 && r.cfg.fair === 2 && r.cfg.others, r.cfg);
      check(`${tag} calendar: the market's next weekend is two dates, Saturday ${SHORT(NS)} and Sunday, both 10am–4pm`, r.market.sat && r.market.sun && r.market.satHours === '600-960' && r.market.sunHours === '600-960' && r.market.sunId === `two-day-market@${addDays(NS, 1)}`, r.market);
      check(`${tag} calendar: the one-off fair is on its Saturday and its Sunday, 11am–3pm`, r.fair.sat && r.fair.sun && r.fair.count === 2 && r.fair.sunHours === '660-900', r.fair);
      check(`${tag} tags: "Monthly · Third Saturday and Sunday 10am" on both days; weekly "Saturdays and Sundays"; one day as before`, r.tags.sat === 'Monthly · Third Saturday and Sunday 10am' && r.tags.sun === r.tags.sat && r.tags.weekly === 'Weekly · Saturdays and Sundays 10am' && r.tags.one === 'Monthly · Fourth Sunday 12pm', r.tags);
      check(`${tag} demo: the Sunday locks T1–T21 too`, Boolean(r.lock) && r.lock.lock === true && r.lock.tables === 'T1-T21', r.lock);
      const whats = await p.evaluate(() => [...document.querySelectorAll('.whats-on li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
      const mk = whats.find((l) => l.startsWith('Two-day market'));
      const fr = whats.find((l) => l.startsWith('Two-day fair'));
      check(`${tag} what's on: "Monthly · Third Saturday and Sunday 10am to 4pm", next ${SHORT(NS)}`, Boolean(mk) && mk.includes('Monthly · Third Saturday and Sunday 10am to 4pm') && mk.endsWith(`Next: ${SHORT(NS)}`), mk);
      check(`${tag} what's on: the fair "${LONG(FAIR)} and ${LONG(addDays(FAIR, 1))}, 11am–3pm"`, Boolean(fr) && fr.includes(`${LONG(FAIR)} and ${LONG(addDays(FAIR, 1))}, 11am–3pm`), fr);
      const ld = await p.evaluate(() => [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap((s) => { try { const j = JSON.parse(s.textContent); return j['@graph'] || [j]; } catch { return []; } }).filter((x) => x['@type'] === 'Event' && /^Two-day fair/.test(x.name)).map((x) => [x.startDate, x.endDate]));
      check(`${tag} JSON-LD: the fair starts Saturday 11am and ends Sunday 3pm`, ld.length === 1 && ld[0][0].startsWith(`${FAIR}T11:00`) && ld[0][1].startsWith(`${addDays(FAIR, 1)}T15:00`), ld);
      check(`${tag} calendar: no sideways scroll, no console errors`, (await overflowX(p)) <= 0 && !o.errors.length, o.errors.slice(0, 3));
      await o.ctx.close();
    }

    /* ---------- 5: the staff events editor ---------- */
    {
      const o = await open(width, height, '/pages/lair-staff#events', STAFF);
      const p = o.page;
      await p.waitForSelector('.sa-event', { timeout: 15000 });
      await p.click('[data-event-new]');
      await p.waitForSelector('[data-event-form]');
      const first = thirdSaturday(...monthAt(1));
      await p.fill('#sa-ev-title', 'QA Weekend market');
      await p.selectOption('#sa-ev-type', 'market');
      await p.fill('#sa-ev-date', first);
      await p.fill('#sa-ev-from', '10:00');
      await p.fill('#sa-ev-until', '16:00');
      const field = await p.evaluate(() => {
        const s = document.querySelector('#sa-ev-days');
        const label = document.querySelector('label[for="sa-ev-days"]');
        return s ? { value: s.value, options: [...s.options].map((x) => x.textContent), label: label && label.textContent.trim(), hint: document.querySelector('#sa-ev-days-hint')?.textContent.trim() } : null;
      });
      check(`${tag} editor: "Runs for", 1 day to start, up to 7 days in a row`, Boolean(field) && field.label === 'Runs for' && field.value === '1' && field.options.length === 7 && field.options[0] === '1 day' && field.options[1] === '2 days in a row', field);
      await p.selectOption('#sa-ev-days', '2');
      await p.waitForTimeout(150);
      const oneOff = flat(await p.textContent('[data-event-tag]'));
      check(`${tag} editor: a one-off over two days says so`, oneOff === 'Just the one date, over 2 days.', oneOff);
      await p.check('[data-event-form] [name="repeat"][value="monthly"]', { force: true });
      await p.waitForTimeout(150);
      const preview = flat(await p.textContent('[data-event-tag]'));
      check(`${tag} editor: the tag as the calendar will say it`, preview === 'On the calendar: Monthly · Third Saturday and Sunday 10am', preview);
      check(`${tag} editor: no sideways scroll`, (await overflowX(p)) <= 0, await overflowX(p));
      await p.click('[data-event-form] button[type="submit"]');
      await p.waitForSelector('.sa-event.is-new', { timeout: 10000 });
      const listed = flat(await p.locator('.sa-event', { hasText: 'QA Weekend market' }).innerText());
      const cfg = await p.evaluate(() => (window.Lair.store.cfg.events.find((x) => x.title === 'QA Weekend market') || {}).days);
      check(`${tag} editor: saved, listed as "Monthly · Third Saturday and Sunday 10am", the config with days 2`, listed.includes('Monthly · Third Saturday and Sunday 10am') && cfg === 2, `${listed} | ${cfg}`);
      await p.locator('.sa-event', { hasText: 'QA Weekend market' }).locator('[data-event-edit]').click();
      await p.waitForSelector('[data-event-form="qa-weekend-market"]');
      const kept = await p.inputValue('#sa-ev-days');
      await p.selectOption('#sa-ev-days', '1');
      await p.click('[data-event-form] button[type="submit"]');
      await p.waitForTimeout(700);
      const after = await p.evaluate(() => (window.Lair.store.cfg.events.find((x) => x.title === 'QA Weekend market') || {}).days);
      const relisted = flat(await p.locator('.sa-event', { hasText: 'QA Weekend market' }).innerText().catch(() => ''));
      check(`${tag} editor: an edit opens on 2 days, and back to 1 day saves ("Monthly · Third Saturday 10am")`, kept === '2' && after === 1 && relisted.includes('Monthly · Third Saturday 10am') && !relisted.includes('and Sunday'), `${kept} → ${after} | ${relisted}`);
      check(`${tag} editor: no console errors`, !o.errors.length, o.errors.slice(0, 3));
      await o.ctx.close();
    }
  }
} catch (error) {
  check('the run finished', false, error.stack || error.message);
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `\n${fails} FAIL` : '\nall PASS');
process.exit(fails ? 1 : 0);

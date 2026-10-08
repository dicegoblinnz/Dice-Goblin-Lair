// Round 9, play: one booking page with three doors (Tables, TTRPG sessions, Events), a month view shaded by how busy
// each day is, the live table map for the day, "I'm interested" for TTRPG sessions and "Maybe" for events (contract
// v9-play). Mo (9 Oct): "book a table, book a ttrpg or event, can all live in the same page with the live table view".
// Demo mode on the theme mock, phone (390px) then desktop (1280px), each in a fresh browser (a fresh demo):
//   1. each door opens its tab (and its heading); ?tab= switches without a reload; the heading follows the tab
//   2. the month: shading with words and pips (Busy, Full), the legend, today ringed, past days greyed
//   3. picking a day updates the heading, the map's time and the list, and the table booking follows the day
//   4. booking a table end to end from the Tables tab (the ticket and its code)
//   5. joining a TTRPG session from the day's list (the board's join form and ticket)
//   6. "I'm interested" as a guest (the form, its checks, the thanks, the count, Take it back), and the staff view of who
//   7. an event sign-up with a guest by name (round 8's form, from "I'm coming")
//   8. "Maybe" as a member (one tap) and as a guest (the short form), with the rough numbers on the card; "I'm coming"
//      for an event with no sign-ups
//   9. the GM form: "For GMs: run a game" opens Run a game's first step
//  10. keyboard through the tabs and the days; axe (WCAG 2.1 A and AA) on the page and the forms; no sideways scroll,
//      no console errors
// Screenshots go to OUT, or a folder in the system's temp directory. Without AXE (axe-core's axe.min.js) the axe part is
// skipped, and says so.
// Usage: DG_THEME=/path/to/theme PORT=4952 [AXE=/path/to/axe.min.js] [OUT=/dir] node tools/qa/round9/play.mjs [phone|desktop]
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
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round9-play');
const AXE = process.env.AXE || '';
const axe = AXE && fs.existsSync(AXE) ? fs.readFileSync(AXE, 'utf8') : null;
fs.mkdirSync(OUT, { recursive: true });
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || process.env.QA_PORT || 4952);
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

const RUBY = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [] };
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const HEADINGS = { tables: 'Book a table', ttrpg: 'Book a TTRPG session', events: 'Events calendar' };

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
const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false }).catch(() => {});
};

const server = await m.serve(PORT);
const browser = await chromium.launch();

for (const size of process.argv[2] ? [process.argv[2]] : ['phone', 'desktop']) {
  const phone = size === 'phone';
  const tag = size;
  const ctx = await browser.newContext({ viewport: SIZES[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(CLOCK);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()); });
  const open = async (where, customer = null) => {
    m.mockState.customer = customer;
    await page.goto('about:blank');
    await page.goto(`${BASE}${where}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector('lair-play [data-play-date]', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('lair-play')?.ready === true, null, { timeout: 20000 });
    await page.waitForTimeout(300);
  };
  const state = () => page.evaluate(() => {
    const play = document.querySelector('lair-play');
    return {
      tab: play.dataset.activeTab, day: play.day, url: window.location.pathname + window.location.search, h1: document.querySelector('h1')?.textContent.trim(),
      selected: [...document.querySelectorAll('[data-play-tab]')].filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.dataset.playTab),
      shown: [...document.querySelectorAll('[data-play-panel]')].filter((p) => !p.hidden).map((p) => p.dataset.playPanel),
      title: document.querySelector('[data-play-day-title]')?.textContent || '',
      list: document.querySelector('[data-play-list-title]')?.textContent || '',
      items: [...document.querySelectorAll('.play-item .cal-card__title')].map((n) => n.textContent.trim()),
      booking: document.querySelector('lair-booking')?.state?.day || null,
      marker: window.__playMarker || null,
    };
  });
  await open('/pages/book-a-table');
  await page.evaluate(() => localStorage.clear());

  /* ---------- 1. the doors, ?tab= and the heading ---------- */
  for (const [door, tab] of [['/pages/book-a-table', 'tables'], ['/pages/gm-games', 'ttrpg'], ['/pages/events-calendar', 'events']]) {
    await open(door);
    const s = await state();
    check(`${tag}: ${door} opens on its tab (${tab}), the others hidden, with its heading`, s.tab === tab && s.selected.join() === tab && s.shown.join() === tab && s.h1 === HEADINGS[tab], s);
  }
  await open('/pages/book-a-table');
  await page.evaluate(() => { window.__playMarker = 'same-page'; });
  const before = await page.evaluate(() => history.length);
  await page.click('[data-play-tab="ttrpg"]');
  let s = await state();
  check(`${tag}: a tab switches without a reload, with ?tab= in the address and the heading following`, s.marker === 'same-page' && s.url === '/pages/book-a-table?tab=ttrpg' && s.shown.join() === 'ttrpg' && s.h1 === HEADINGS.ttrpg, s);
  await page.click('[data-play-tab="tables"]');
  s = await state();
  const after = await page.evaluate(() => history.length);
  check(`${tag}: back to the door's own tab drops ?tab= and adds no history (Back leaves the page)`, s.url === '/pages/book-a-table' && after === before && s.h1 === HEADINGS.tables, { s, before, after });
  await open('/pages/book-a-table?tab=events');
  s = await state();
  check(`${tag}: ?tab=events on the tables door opens Events`, s.tab === 'events' && s.shown.join() === 'events' && s.h1 === HEADINGS.events, s);

  /* ---------- 2. the month ---------- */
  await open('/pages/events-calendar');
  const month = await page.evaluate(() => {
    const days = [...document.querySelectorAll('[data-play-date]')];
    const open = days.filter((d) => !d.disabled);
    const busy = open.filter((d) => ['busy', 'full'].includes(d.dataset.busy));
    return {
      days: days.length, open: open.length, shaded: open.filter((d) => d.dataset.busy).length,
      words: busy.map((d) => d.querySelector('.play-day__busy b')?.textContent.trim()),
      levels: [...new Set(open.map((d) => d.dataset.busy))].sort(),
      pips: open.every((d) => d.querySelectorAll('.play-pips i').length === 4),
      labels: busy.slice(0, 2).map((d) => d.getAttribute('aria-label')),
      today: document.querySelector('[data-play-date].is-today')?.dataset.playDate,
      pastDisabled: days.filter((d) => d.classList.contains('is-past')).every((d) => d.disabled),
      legend: [...document.querySelectorAll('.play__legend li')].map((li) => li.textContent.trim()),
      marks: document.querySelectorAll('.play-day .play-mark--event').length,
      ttrpg: document.querySelectorAll('.play-day .play-mark--ttrpg').length,
    };
  });
  check(`${tag}: every open day ahead is shaded, with a 4-pip meter`, month.open > 10 && month.shaded === month.open && month.pips, month);
  check(`${tag}: the four steps show (the demo seeds busy days), and Busy and Full are words on the day too`, ['busy', 'filling', 'full', 'quiet'].every((l) => month.levels.includes(l)) && month.words.length > 0 && month.words.every((w) => w === 'Busy' || w === 'Full'), month);
  check(`${tag}: a busy day's label says it in words`, month.labels.every((l) => /, (busy|full)/.test(l)), month.labels);
  check(`${tag}: today is ringed; past days are greyed and can't be picked`, month.today === today && month.pastDisabled, month);
  check(`${tag}: the legend names the four steps and the marks`, ['Quiet', 'Filling up', 'Busy', 'Full', 'Events', 'TTRPG seats'].every((w) => month.legend.includes(w)) && month.marks > 0 && month.ttrpg > 0, month);
  await shot(page, `${tag}-1-month`);

  /* ---------- 3. picking a day ---------- */
  const target = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const days = [...document.querySelectorAll('[data-play-date]:not([disabled])')].map((d) => d.dataset.playDate).filter((k) => k !== play.day);
    return days.find((k) => play.dayItems(k).length >= 1 && play.dayInfo(k).level >= 2) || days.find((k) => play.dayItems(k).length) || days[0];
  });
  const mapBefore = await page.evaluate(() => document.querySelector('lair-play-floor').at);
  await page.click(`[data-play-date="${target}"]`);
  await page.waitForTimeout(300);
  s = await state();
  const after3 = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const floor = document.querySelector('lair-play-floor');
    return { at: floor.at, pressed: document.querySelector(`[data-play-date="${play.day}"]`)?.getAttribute('aria-pressed'), items: play.dayItems(play.day).length, times: document.querySelectorAll('[data-play-time]').length };
  });
  const atKey = lairKey(after3.at);
  check(`${tag}: picking a day changes the heading, the map's day and the list`, s.day === target && atKey === target && after3.at !== mapBefore && after3.pressed === 'true' && /What’s on/.test(s.list) && s.items.length === after3.items, { s, after3, target });
  check(`${tag}: the table booking follows the day picked`, s.booking === target, s);
  // a time chip moves the map
  const chip = await page.$('[data-play-time]:not([aria-pressed="true"])');
  if (chip) {
    const value = await chip.getAttribute('data-play-time');
    await chip.click();
    const at = await page.evaluate(() => document.querySelector('lair-play-floor').at);
    const minutes = Number(new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).format(new Date(at)).split(':').reduce((h, mm) => Number(h) * 60 + Number(mm)));
    check(`${tag}: a time chip shows the tables at that time`, String(minutes) === value, { value, minutes });
  }
  await shot(page, `${tag}-2-day`);

  /* ---------- 4. booking a table, end to end ---------- */
  await open('/pages/book-a-table');
  const tomorrow = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const keys = [...document.querySelectorAll('[data-play-date]:not([disabled])')].map((d) => d.dataset.playDate);
    return keys.find((k) => k > play.day && play.dayInfo(k).level === 0) || keys[1];
  });
  await page.click(`[data-play-date="${tomorrow}"]`);
  await page.waitForTimeout(250);
  const slot = await page.evaluate(() => [...document.querySelectorAll('lair-booking [data-slot]:not([disabled])')].map((b) => b.dataset.slot).find((v) => Number(v) >= 18 * 60) || document.querySelector('lair-booking [data-slot]:not([disabled])')?.dataset.slot);
  await page.click(`lair-booking [data-slot="${slot}"]`);
  await page.fill('#bk-name', 'Aroha Example');
  await page.fill('#bk-email', 'aroha@example.com');
  await page.fill('#bk-phone', '021 555 0101');
  if (await page.$('lair-booking input[name="agree"]')) await page.check('lair-booking input[name="agree"]');
  await page.click('lair-booking [data-submit]');
  await page.waitForSelector('lair-booking [data-done]:not([hidden])', { timeout: 10000 }).catch(() => {});
  const ticket = await page.evaluate(() => ({ ref: document.querySelector('lair-booking .ticket-qr__ref')?.textContent.trim(), qr: Boolean(document.querySelector('lair-booking [data-ticket-code] svg')), title: document.querySelector('lair-booking .ticket__title')?.textContent.trim() }));
  check(`${tag}: a table booked from the Tables tab, on the day picked in the month, ends on its ticket with a QR code`, /^[A-Z]{1,3}-[A-Z]+-\d{1,2}$/.test(ticket.ref || '') && ticket.qr && /See you/.test(ticket.title || ''), { ticket, tomorrow, slot });
  await shot(page, `${tag}-3-booked`);

  /* ---------- 5. joining a TTRPG session from the day's list ---------- */
  await open('/pages/gm-games');
  const sessionDay = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const keys = [...document.querySelectorAll('[data-play-date]:not([disabled])')].map((d) => d.dataset.playDate);
    return keys.find((k) => play.dayItems(k).some((i) => i.kind === 'game' && !i.projected && (i.seats - i.taken) >= 1)) || null;
  });
  if (sessionDay !== (await state()).day) await page.click(`[data-play-date="${sessionDay}"]`);
  await page.waitForTimeout(250);
  const joinBtn = page.locator('.play-item[data-kind="game"] [data-play-act="join"]').first();
  await joinBtn.click();
  await page.waitForSelector('gm-board [data-sheet][open] [data-session-join]', { timeout: 8000 });
  await page.fill('[data-session-join] [name="name"]', 'Jo Example');
  await page.fill('[data-session-join] [name="email"]', 'jo@example.com');
  await page.fill('[data-session-join] [name="phone"]', '021 555 0102');
  await page.click('[data-join-submit]');
  await page.waitForSelector('gm-board .gm-done', { timeout: 8000 }).catch(() => {});
  const joined = await page.evaluate(() => ({ done: Boolean(document.querySelector('gm-board .gm-done')), tab: document.querySelector('lair-play').dataset.activeTab, text: document.querySelector('gm-board .gm-done')?.textContent.replace(/\s+/g, ' ').slice(0, 120) }));
  check(`${tag}: Join on a session in the day's list opens the board's join form, and a guest gets their ticket`, joined.done && joined.tab === 'ttrpg', joined);
  await page.keyboard.press('Escape');

  /* ---------- 6. "I'm interested", as a guest ---------- */
  await open('/pages/gm-games');
  if (sessionDay !== (await state()).day) await page.click(`[data-play-date="${sessionDay}"]`);
  await page.waitForTimeout(250);
  const gameId = await page.evaluate(() => document.querySelector('lair-play').dayItems(document.querySelector('lair-play').day).find((i) => i.kind === 'game' && !i.projected).gameId);
  await page.click('.play-item[data-kind="game"] [data-play-act="interest"]');
  await page.waitForSelector('gm-board [data-sheet][open] [data-interest-form]', { timeout: 8000 });
  const form = await page.evaluate(() => {
    const f = document.querySelector('gm-board [data-interest-form]');
    return { title: document.querySelector('gm-board [data-sheet-title]').textContent, lead: f.querySelector('.interest-form__lead').textContent.trim(), fields: [...f.elements].map((x) => x.name).filter(Boolean), focus: document.activeElement?.name || null, send: document.querySelector('gm-board [data-interest-send]')?.textContent.trim() };
  });
  check(`${tag}: "I'm interested" opens a short form in the board's sheet: name, email, mobile and a note, focus on the first`, /^I’m interested: /.test(form.title) && form.fields.join() === 'name,email,phone,note' && form.focus === 'name' && /Nothing is booked or paid yet/.test(form.lead) && /^Send to /.test(form.send), form);
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
  const sent = await page.evaluate((id) => ({
    flash: document.querySelector('gm-board .gm-flash')?.textContent.trim(), said: document.querySelector('gm-board .gm-interest-said')?.textContent.replace(/\s+/g, ' ').trim(),
    row: (JSON.parse(localStorage.getItem('dg-lair-demo-v3') || '{}').interests || []).find((r) => r.targetId === id && r.status === 'active') || null,
    count: window.Lair.store.data.games.find((g) => g.id === id)?.interested,
  }), gameId);
  check(`${tag}: it's sent: the thanks says the GM gets back to them and nothing is booked; the sheet says "You're interested"`, /will get back to you by email\. Nothing is booked yet\./.test(sent.flash || '') && /You’re interested/.test(sent.said || '') && sent.row && sent.row.note === 'First time playing. Is that OK?' && sent.row.level === 'interested', sent);
  check(`${tag}: the board counts them (a number, not a name)`, sent.count === 1, sent);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const listed = await page.evaluate(() => ({ said: document.querySelector('.play-item[data-kind="game"] .play-item__said')?.textContent.trim(), count: document.querySelector('.play-item[data-kind="game"] .play-item__count')?.textContent.trim() }));
  check(`${tag}: the day's list shows "You're interested", Take it back and "1 interested"`, listed.said === 'You’re interested' && listed.count === '1 interested', listed);
  await page.click('.play-item[data-kind="game"] [data-play-act="unsay"]');
  await page.waitForTimeout(400);
  const back = await page.evaluate((id) => ({ ask: Boolean(document.querySelector('.play-item[data-kind="game"] [data-play-act="interest"]')), active: (JSON.parse(localStorage.getItem('dg-lair-demo-v3') || '{}').interests || []).filter((r) => r.targetId === id && r.status === 'active').length }), gameId);
  check(`${tag}: Take it back (a guest, by the key this browser kept) takes it back`, back.ask && back.active === 0, back);
  // staff (and the session's GM) see who's interested
  await interestAs(page, gameId);
  await open(`/pages/gm-games#game=${encodeURIComponent(gameId)}`, STAFF);
  await page.waitForSelector('gm-board [data-sheet][open] .gm-interest', { timeout: 8000 }).catch(() => {});
  const who = await page.evaluate(() => document.querySelector('gm-board .gm-interest')?.textContent.replace(/\s+/g, ' ').trim() || '');
  check(`${tag}: staff (as the GM would) see who's interested, their note and a way to email them`, /Interested/.test(who) && /Tui Example/.test(who) && /Keen to try/.test(who) && /Email Tui/.test(who), who);
  await page.keyboard.press('Escape');

  /* ---------- 7. an event sign-up with a guest, from "I'm coming" ---------- */
  await open('/pages/events-calendar');
  const signUp = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const keys = [...document.querySelectorAll('[data-play-date]:not([disabled])')].map((d) => d.dataset.playDate);
    for (const k of keys) {
      const item = play.dayItems(k).find((i) => i.kind === 'event' && i.capacity && !i.gameTables && !i.product && i.end > Date.now());
      if (item) return { day: k, id: item.id };
    }
    return null;
  });
  if (signUp.day !== (await state()).day) await page.click(`[data-play-date="${signUp.day}"]`);
  await page.waitForTimeout(250);
  await page.click(`.play-item [data-play-act="join"][data-play-target="${signUp.id}"]`);
  await page.waitForSelector('lair-calendar [data-join-form]', { timeout: 8000 });
  await page.fill('[data-join-form] [name="name"]', 'Mere Example');
  await page.fill('[data-join-form] [name="email"]', 'mere@example.com');
  await page.fill('[data-join-form] [name="phone"]', '021 555 0104');
  await page.click('[data-guest-add]');
  await page.fill('[data-guest] [name="guestName"]', 'Jo Bloggs');
  await page.click('button[form="cal-join-form"]');
  await page.waitForSelector('lair-calendar .cal-done', { timeout: 8000 }).catch(() => {});
  const ticket7 = await page.evaluate(() => ({ text: document.querySelector('lair-calendar [data-dialog]')?.textContent.replace(/\s+/g, ' ').slice(0, 300), tab: document.querySelector('lair-play').dataset.activeTab }));
  check(`${tag}: "I'm coming" on a date with sign-ups is the sign-up form, and a sign-up with a guest by name goes through`, ticket7.tab === 'events' && /Jo Bloggs/.test(ticket7.text || '') && /(You’re in|See you|code)/i.test(ticket7.text || ''), ticket7);
  await page.keyboard.press('Escape');

  /* ---------- 8. "Maybe" (and "I'm coming" with no sign-ups) ---------- */
  await open('/pages/events-calendar', RUBY);
  const turnup = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const keys = [...document.querySelectorAll('[data-play-date]:not([disabled])')].map((d) => d.dataset.playDate);
    for (const k of keys) {
      const item = play.dayItems(k).find((i) => i.kind === 'event' && !i.capacity && !i.gameTables && !i.product && i.end > Date.now());
      if (item) return { day: k, id: item.id, title: item.title };
    }
    return null;
  });
  if (turnup.day !== (await state()).day) await page.click(`[data-play-date="${turnup.day}"]`);
  await page.waitForTimeout(250);
  const countOf = () => page.evaluate((id) => document.querySelector(`.play-item [data-item="${id}"] .cal-card__said`)?.textContent.trim() || '', turnup.id);
  const before8 = await countOf();
  const buttons8 = await page.evaluate((id) => [...document.querySelectorAll(`.play-item [data-play-target="${id}"]`)].map((b) => b.textContent.trim()), turnup.id);
  check(`${tag}: an event with no sign-ups offers "I'm coming" and "Maybe"`, buttons8.join('|') === 'I’m coming|Maybe', buttons8);
  await page.click(`.play-item [data-play-act="maybe"][data-play-target="${turnup.id}"]`);
  await page.waitForTimeout(500);
  const after8 = await page.evaluate((id) => ({
    said: document.querySelector(`.play-item [data-item="${id}"]`)?.closest('.play-item')?.querySelector('.play-item__said')?.textContent.trim(),
    dialog: Boolean(document.querySelector('dialog[open]')),
    row: (JSON.parse(localStorage.getItem('dg-lair-demo-v3') || '{}').interests || []).find((r) => r.targetId === id && r.status === 'active') || null,
  }), turnup.id);
  const count8 = await countOf();
  const n = (text, word) => Number((new RegExp(`(\\d+) ${word}`).exec(text) || [0, 0])[1]);
  check(`${tag}: a member's Maybe is one tap: "You're a maybe", no form, and the card's maybe count goes up by one`, after8.said === 'You’re a maybe' && !after8.dialog && after8.row && after8.row.customerId === String(RUBY.id) && n(count8, 'maybe') === n(before8, 'maybe') + 1, { before8, count8, after8 });
  check(`${tag}: the card's numbers are counts only, never names`, /^(\d+ coming · )?\d+ maybe$/.test(count8) && !/Ruby/.test(count8), count8);
  // Change your mind: Take it back, then "I'm coming"
  await page.click(`.play-item [data-play-act="unsay"][data-play-target="${turnup.id}"]`);
  await page.waitForTimeout(400);
  await page.click(`.play-item [data-play-act="coming"][data-play-target="${turnup.id}"]`);
  await page.waitForTimeout(400);
  const coming8 = await page.evaluate((id) => document.querySelector(`.play-item [data-item="${id}"]`)?.closest('.play-item')?.querySelector('.play-item__said')?.textContent.trim(), turnup.id);
  check(`${tag}: "I'm coming" on a date with no sign-ups counts them as coming`, coming8 === 'You’re coming', coming8);
  // a guest's Maybe: the short form in the calendar's sheet
  await open('/pages/events-calendar');
  if (turnup.day !== (await state()).day) await page.click(`[data-play-date="${turnup.day}"]`);
  await page.waitForTimeout(250);
  await page.click(`.play-item [data-play-act="maybe"][data-play-target="${turnup.id}"]`);
  await page.waitForSelector('lair-calendar [data-dialog][open] [data-interest-form]', { timeout: 8000 });
  const guestForm = await page.evaluate(() => ({ title: document.querySelector('lair-calendar [data-dialog-title]').textContent, fields: [...document.querySelector('lair-calendar [data-interest-form]').elements].map((x) => x.name).filter(Boolean) }));
  check(`${tag}: a guest's Maybe asks for a name, email and mobile in the calendar's sheet`, /^Maybe: /.test(guestForm.title) && guestForm.fields.join() === 'name,email,phone,note', guestForm);
  await page.fill('lair-calendar [data-interest-form] [name="name"]', 'Sam Example');
  await page.fill('lair-calendar [data-interest-form] [name="email"]', 'sam@example.com');
  await page.fill('lair-calendar [data-interest-form] [name="phone"]', '021 555 0105');
  await scan(page, `${tag}: the Maybe form`, 'lair-calendar [data-dialog][open]');
  await page.click('lair-calendar [data-interest-send]');
  await page.waitForSelector('lair-calendar .cal-flash', { timeout: 8000 }).catch(() => {});
  const guestSaid = await page.evaluate(() => ({ flash: document.querySelector('lair-calendar .cal-flash')?.textContent.trim(), note: document.querySelector('lair-calendar .cal-note--said')?.textContent.trim(), facts: document.querySelector('lair-calendar .cal-facts__said')?.textContent.trim() }));
  check(`${tag}: the guest is a maybe, the sheet says so with Take it back, and its facts show the numbers`, /You’re a maybe/.test(guestSaid.flash || '') && /You’re a maybe\./.test(guestSaid.note || '') && /\d+ maybe/.test(guestSaid.facts || ''), guestSaid);
  await page.keyboard.press('Escape');

  /* ---------- 9. the GM form ---------- */
  await open('/pages/gm-games', RUBY);
  // the toolbar's "For GMs: run a game" on phones; the side panel's "Run a game" on desktop
  await page.locator('gm-board [data-host]:visible').first().click();
  await page.waitForSelector('gm-board [data-sheet][open] lair-session-form', { timeout: 8000 }).catch(() => {});
  const gm = await page.evaluate(() => ({ form: Boolean(document.querySelector('gm-board [data-sheet][open] lair-session-form')), title: document.querySelector('gm-board [data-sheet-title]')?.textContent, tab: document.querySelector('lair-play').dataset.activeTab }));
  check(`${tag}: Run a game (for GMs) opens its steps in the TTRPG tab`, gm.form && gm.tab === 'ttrpg', gm);
  await page.keyboard.press('Escape');

  /* ---------- 10. keyboard, axe, no sideways scroll ---------- */
  await open('/pages/book-a-table');
  await page.focus('[data-play-tab="tables"]');
  await page.keyboard.press('ArrowRight');
  let kb = await page.evaluate(() => ({ focus: document.activeElement?.dataset.playTab, tab: document.querySelector('lair-play').dataset.activeTab }));
  check(`${tag}: arrow keys move along the tabs and show the tab`, kb.focus === 'ttrpg' && kb.tab === 'ttrpg', kb);
  await page.keyboard.press('End');
  kb = await page.evaluate(() => ({ focus: document.activeElement?.dataset.playTab, tab: document.querySelector('lair-play').dataset.activeTab }));
  check(`${tag}: End goes to the last tab`, kb.focus === 'events' && kb.tab === 'events', kb);
  await page.focus('[data-play-date][tabindex="0"]');
  const from = await page.evaluate(() => document.activeElement.dataset.playDate);
  await page.keyboard.press('ArrowRight');
  const to = await page.evaluate(() => document.activeElement.dataset.playDate);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const picked = await page.evaluate(() => document.querySelector('lair-play').day);
  check(`${tag}: arrow keys move between days (one Tab stop) and Enter picks one`, to > from && picked === to, { from, to, picked });
  await page.keyboard.press('ArrowDown');
  const down = await page.evaluate(() => document.activeElement.dataset.playDate);
  check(`${tag}: Down goes a week on`, down > to, { to, down });
  for (const [door, label] of [['/pages/book-a-table', 'Tables'], ['/pages/gm-games', 'TTRPG sessions'], ['/pages/events-calendar', 'Events']]) {
    await open(door);
    await scan(page, `${tag}: ${label}: the tabs, the month, the day and what's on`, 'lair-play .play__tabs, lair-play .play__day, lair-play .play__after');
    check(`${tag}: ${label}: no sideways scroll`, (await overflowX(page)) === 0, await overflowX(page));
  }
  await shot(page, `${tag}-4-events`);
  check(`${tag}: no console errors`, !errors.length, errors);
  await ctx.close();
}

/** A guest says they're interested in a session through the page's own kit (for the staff view) */
async function interestAs(page, gameId) {
  await page.evaluate(async (id) => {
    await window.Lair.store.mutate('addInterest', { kind: 'session', id, name: 'Tui Example', email: 'tui@example.com', phone: '021 555 0106', note: 'Keen to try. Can I bring my own character?' });
  }, gameId);
}

await browser.close();
server.close();
if (!axe) console.log('NOTE axe skipped: set AXE to axe-core’s axe.min.js');
console.log(`\n${pass} passed, ${fail} failed${axe ? `, ${axeTotal} axe violations` : ''}`);
process.exit(fail ? 1 : 0);

// 28 Oct 2026 (contract v22-holds): every hold can be edited, on the theme mock (demo mode). Mo, with a screenshot of the
// staff page's holds: "I can't edit any of the weeklies for the events and only the ones I made. Please make it so that
// all that have been created can be edited."
//  1. The holds list: a weekly event is one card (its tag, "From the events calendar", its usual tables and times,
//     locked or not, its next four dates, Then every …), a one-off event's card, and game tables named (with Change them
//     under Events). No card for every date any more. A monthly market's card says which weekend of the month.
//  2. One date of an event: Edit (its tables, what they read as while typing, Save), Free the tables, Back to usual;
//     the toasts; focus kept in the card; a date's own tables hold the floor that date (and only that date).
//  3. Every date of an event: Edit every date (the usual tables and Lock these tables, the times are the event's),
//     dates with their own keeping them, and the Events tab's form has the new tables; Stop holding tables asks first
//     (Keep them, then Yes).
//  4. Escape closes an editor; a mistake stays in it with the Lair app's words; what's typed survives the floor updating.
//  5. A staff one-off: Edit (what for, type, tables, day, from, until); a table that doesn't exist is refused, even when
//     the floor draws the list again while it saves.
//  6. A staff weekly hold: a date's Edit (tables and times) and Back to usual; Edit every date (dates changed on their
//     own keep theirs).
//  7. The floor, on a night an event holds tables: Free this table today (focus stays in the sheet), and Edit the hold
//     (the Holds tab, on that date's editor). A staff hold's Edit there too.
//  8. A Lair app from before round 22 (no holdEvents): event holds show as before, and staff holds have no Edit.
//  9. A weekly hold changed while tonight's date is on: the card and Edit every date have the new usual.
// 10. The booking page's list and the calendar follow a date's own tables (and game tables on a date that holds none).
// LiveBackend's routes. (Items 3, 5, 9 and 10's checks came from the independent review, 28 Oct.)
// No sideways scroll and axe at each. Phone and desktop. The events are stand-ins shaped like the store's on 28 Oct 2026
// (two Friday nights holding the same locked tables, a locked Thursday with game tables inside them, a one-off).
// Usage: DG_THEME=/path/to/theme [PORT=4992] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round22/holds.mjs [phone|desktop]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TZ = 'Pacific/Auckland';
const keyOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (key, n) => new Date(Date.parse(`${key}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekday = (key) => new Date(`${key}T12:00:00Z`).getUTCDay();
// The page's day: the next Thursday (today, when it's Thursday), so the Thursday night is on at 7pm
let thursday = keyOf(Date.now());
while (weekday(thursday) !== 4) thursday = addDays(thursday, 1);
process.env.QA_TODAY = process.env.QA_TODAY || thursday;
process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round22-holds');

// The events (QA_EVENTS' shape), counted from that Thursday, in a file of their own for the mock
const offset = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${key}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const iso = (key, hm) => `${key}T${hm}:00${offset(key)}`;
const T = process.env.QA_TODAY;
const weekly = (handle, title, firstDay, from, to, extra = {}) => ({
  handle, title, event_type: 'tcg', starts_at: iso(firstDay, from), ends_at: iso(to === '00:00' ? addDays(firstDay, 1) : firstDay, to), repeat: 'weekly',
  image_slug: 'mtg', description: `${title}, every week.`, ...extra,
});
const EVENTS = [
  weekly('qa-cards-early', 'Friday cards', addDays(T, -13), '18:00', '22:00', { tables: 'T10-T13, T18-T21', lock_tables: true }),
  weekly('qa-cards-late', 'Friday league', addDays(T, -13), '19:00', '00:00', { tables: 'T10-T13, T18-T21', lock_tables: true }),
  weekly('qa-wargames', 'Wargames night', addDays(T, -14), '18:00', '00:00', {
    event_type: 'wargame', tables: 'T8-T21', lock_tables: true, game_tables: 'T8+T9, T10+T11, T12+T13, T14+T15, T18+T19, T20+T21', entry_fee: 10, payment: 'In store',
  }),
  weekly('qa-monday', 'Monday cards', addDays(T, -10), '18:00', '22:00', { tables: 'T10-T13, T18-T21', lock_tables: true }),
  weekly('qa-killteam', 'Kill Team night', addDays(T, -13), '17:00', '21:00', { event_type: 'wargame', game_tables: 'G1+G2, G3+G4', entry_fee: 10 }),
  {
    handle: 'qa-social', title: 'Social deduction', event_type: 'social', starts_at: iso(addDays(T, 10), '12:00'), ends_at: iso(addDays(T, 10), '18:00'),
    tables: 'F1, P1-P4', lock_tables: true, capacity: 40, entry_fee: 10, image_slug: 'board-games', description: 'A one-off.',
  },
  // a market over a weekend each month, like Oddity Alley: the third Saturday and the Sunday after, from two months back
  (() => {
    let day = `${addDays(T, -45).slice(0, 8)}01`;
    while (weekday(day) !== 6) day = addDays(day, 1);
    day = addDays(day, 14);
    return { handle: 'qa-market', title: 'Weekend market', event_type: 'market', starts_at: iso(day, '10:00'), ends_at: iso(day, '15:00'), repeat: 'monthly', days: 2, tables: 'T1-T7', lock_tables: true, image_slug: 'board-games', description: 'Monthly.' };
  })(),
];
const eventsFile = path.join(os.tmpdir(), 'dg-round22-events.json');
fs.writeFileSync(eventsFile, JSON.stringify(EVENTS));
process.env.DG_SIM_EVENTS = eventsFile;

const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, context, watch, go, STAFF } = lib;
const PORT = Number(process.env.PORT || 4992);
const BASE = `http://localhost:${PORT}`;
const sizes = process.argv[2] ? [process.argv[2]] : ['phone', 'desktop'];
const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 350) => page.waitForTimeout(ms);
const FRI = addDays(T, 1);
const card = (id) => `[data-hold-event="${id}"]`;
const row = (id, n) => `${card(id)} .staff-series__date:nth-child(${n})`;

for (const size of sizes) {
  const ctx = await context(browser, size, '19:00');
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/lair-staff', STAFF);
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.Lair && window.Lair.store && Array.isArray(window.Lair.store.data.holdEvents), null, { timeout: 15000 });
  const toast = async () => flat(await page.locator('.toast').last().textContent().catch(() => ''));
  const focused = () => page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return '';
    return `${el.tagName.toLowerCase()}${el.dataset.act ? `[${el.dataset.act}]` : ''}${el.name ? `(${el.name})` : ''}${el.id ? `#${el.id}` : ''}|${String(el.textContent || el.value || '').replace(/\s+/g, ' ').trim()}`.slice(0, 120);
  });
  const words = await page.evaluate(([fri]) => {
    const t = window.Lair.store.time;
    const short = (key) => t.fmtDate(key).replace(',', '');
    return { fri2: short(t.addDays(fri, 7)), fri3: short(t.addDays(fri, 14)), fri: short(fri) };
  }, [FRI]);
  const noSideways = async (label) => check(`${size}: ${label}: nothing wider than the page`, (await overflowX(page)) <= 0, await overflowX(page));
  await page.click('[data-tab="holds"]');
  await page.waitForSelector('[data-holds-list] article');

  /* ---------------- 1. the list ---------------- */
  const counts = await page.evaluate(() => {
    const list = document.querySelector('[data-holds-list]');
    const n = (text) => [...list.querySelectorAll(':scope > article')].filter((a) => a.querySelector('strong')?.textContent.trim() === text).length;
    return { early: n('Friday cards'), late: n('Friday league'), war: n('Wargames night'), monday: n('Monday cards'), social: n('Social deduction'), kill: n('Kill Team night') };
  });
  check(`${size}: one card for each event, not one a date`, JSON.stringify(counts) === JSON.stringify({ early: 1, late: 1, war: 1, monday: 1, social: 1, kill: 1 }), counts);
  const war = flat(await page.textContent(card('qa-wargames')));
  check(`${size}: the Thursday's card: tag, from the calendar, usual tables and times, locked`, war.includes('Weekly · Thursdays 6pm · From the events calendar') && war.includes('T8–T21 · 6pm–midnight · locked'), war.slice(0, 200));
  const warRows = await page.$$eval(`${card('qa-wargames')} .staff-series__date`, (els) => els.map((e) => e.querySelector('.staff-series__when').textContent.replace(/\s+/g, ' ').trim() + ' | ' + [...e.querySelectorAll('button')].map((b) => b.textContent.trim()).join(', ')));
  check(`${size}: …its next four dates, tonight's on now, each with Edit and Free the tables`, warRows.length === 4 && warRows[0].startsWith('Today, on now') && warRows.every((r) => r.endsWith('| Edit, Free the tables')), warRows);
  const warEdits = await page.$$eval(`${card('qa-wargames')} .staff-series__date [data-act="hold-edit"]`, (els) => els.map((b) => b.getAttribute('aria-expanded')));
  check(`${size}: …each date's Edit says it's shut (aria-expanded false)`, warEdits.length === 4 && warEdits.every((x) => x === 'false'), warEdits);
  check(`${size}: …Then every Thursday, Edit every date and Stop holding tables`, war.includes('Then every Thursday.') && (await page.locator(`${card('qa-wargames')} [data-act="hold-edit"][data-id="event:qa-wargames"]`).textContent()).trim() === 'Edit every date' && (await page.locator(`${card('qa-wargames')} [data-act="event-stop"]`).count()) === 1);
  check(`${size}: …its game tables named, with Change them under Events`, war.includes('Game tables people book for it: T8+T9, T10+T11, T12+T13, T14+T15, T18+T19, T20+T21.') && (await page.locator(`${card('qa-wargames')} [data-act="open-event"]`).count()) === 1, war.slice(-160));
  const social = flat(await page.textContent(card('qa-social')));
  check(`${size}: a one-off event's card: its date, tables, locked, Edit and Free the tables`, social.includes('From the events calendar') && /F1, P1–P4, locked/.test(social) && social.endsWith('Edit Free the tables'), social);
  const market = flat(await page.textContent(card('qa-market')));
  check(`${size}: a monthly market's card: Then the third Saturday and Sunday of every month`, market.includes('Monthly · Third Saturday and Sunday 10am · From the events calendar') && market.includes('Then the third Saturday and Sunday of every month.'), market.slice(0, 260));
  const kill = flat(await page.textContent('[data-hold-card="spots:qa-killteam"]').catch(() => ''));
  check(`${size}: an event with only game tables: named, set aside, changed under Events`, kill.includes('Kill Team night') && kill.includes('set aside, still bookable') && kill.includes('Game tables people book for it: G1+G2, G3+G4.'), kill);
  const firstCard = await page.$eval('[data-holds-list] > article', (a) => a.querySelector('strong').textContent.trim());
  check(`${size}: soonest first (tonight's Thursday)`, firstCard === 'Wargames night', firstCard);
  await noSideways('the list');
  await axe(page, `${size}: the holds list`, '[data-holds-list]');
  await page.locator(card('qa-cards-early')).scrollIntoViewIfNeeded();
  await shot(page, `${size}-1-event-card`, card('qa-cards-early'));

  /* ---------------- 2. one date of an event ---------------- */
  await page.click(`${row('qa-cards-early', 1)} [data-act="hold-edit"]`);
  await settle(page);
  const editor = `${row('qa-cards-early', 1)} [data-hold-edit-form]`;
  const label = flat(await page.textContent(`${editor} label`).catch(() => ''));
  check(`${size}: Edit opens the date's editor in its row, with its tables, focused, and says it's open`, (await page.getAttribute(`${row('qa-cards-early', 1)} [data-act="hold-edit"]`, 'aria-expanded')) === 'true' && (await page.inputValue(`${editor} [name="tables"]`)) === 'T10-T13, T18-T21' && label === `Tables on ${words.fri}` && (await focused()).startsWith('input(tables)'), { label, focused: await focused() });
  await page.fill(`${editor} [name="tables"]`, 't18-t21');
  check(`${size}: …it says what they read as while typing`, flat(await page.textContent(`${editor} [data-tables-read]`)) === 'Reads as 4 tables: T18–T21.', await page.textContent(`${editor} [data-tables-read]`));
  // the floor updating while it's open never loses what's typed
  await page.evaluate(() => window.Lair.store.refresh());
  await settle(page, 200);
  check(`${size}: …what's typed survives the floor updating`, (await page.inputValue(`${editor} [name="tables"]`)) === 't18-t21');
  await axe(page, `${size}: a date's editor`, card('qa-cards-early'));
  await shot(page, `${size}-2-date-editor`, card('qa-cards-early'));
  await page.click(`${editor} [type="submit"]`);
  await settle(page, 500);
  check(`${size}: Save: the toast says what it holds tomorrow`, (await toast()) === 'Friday cards holds T18–T21 tomorrow.', await toast());
  const row1 = flat(await page.innerText(row('qa-cards-early', 1)));
  check(`${size}: …the row says so, with Back to usual; focus on its Edit`, row1 === 'Tomorrow T18–T21 this date Edit Back to usual' && (await focused()).startsWith('button[hold-edit]|Edit'), { row1, focused: await focused() });
  const floorThen = await page.evaluate((fri) => {
    const { store } = window.Lair;
    const t = store.time;
    return {
      t10Early: store.isFree('T10', t.at(fri, 18 * 60), t.at(fri, 19 * 60)), t10Late: store.isFree('T10', t.at(fri, 19 * 60), t.at(fri, 20 * 60)),
      t18: store.isFree('T18', t.at(fri, 20 * 60), t.at(fri, 21 * 60)), t10Next: store.isFree('T10', t.at(t.addDays(fri, 7), 18 * 60), t.at(t.addDays(fri, 7), 19 * 60)),
    };
  }, FRI);
  check(`${size}: …T10 is bookable at 6pm that Friday only (the late night holds it from 7pm); T18 stays held`, JSON.stringify(floorThen) === JSON.stringify({ t10Early: true, t10Late: false, t18: false, t10Next: false }), floorThen);
  await page.click(`${row('qa-cards-early', 2)} [data-act="edate-free"]`);
  await settle(page, 500);
  check(`${size}: Free the tables: the toast`, (await toast()) === `Friday cards isn’t holding tables on ${words.fri2}. It’s still on the events calendar.`, await toast());
  check(`${size}: …the row says none, with Back to usual (focused)`, flat(await page.innerText(row('qa-cards-early', 2))) === `${words.fri2} No tables held this date Edit Back to usual` && (await focused()).startsWith('button[edate-usual]'), { row: flat(await page.innerText(row('qa-cards-early', 2))), focused: await focused() });
  await page.click(`${row('qa-cards-early', 1)} [data-act="edate-usual"]`);
  await settle(page, 500);
  check(`${size}: Back to usual: the toast, and the row as it was`, (await toast()) === 'Friday cards is back to its usual tables tomorrow: T10–T13, T18–T21.' && flat(await page.innerText(row('qa-cards-early', 1))) === 'Tomorrow Edit Free the tables', [await toast(), flat(await page.innerText(row('qa-cards-early', 1)))]);
  await noSideways('a changed date');
  await page.locator(card('qa-cards-early')).scrollIntoViewIfNeeded();
  await shot(page, `${size}-2-dates-changed`, card('qa-cards-early'));

  /* ---------------- 4. Escape, and a mistake ---------------- */
  await page.click(`${row('qa-wargames', 2)} [data-act="hold-edit"]`);
  await settle(page);
  await page.keyboard.press('Escape');
  await settle(page);
  check(`${size}: Escape closes the editor, back on its Edit`, (await page.locator(`${card('qa-wargames')} [data-hold-edit-form]`).count()) === 0 && (await focused()).startsWith('button[hold-edit]|Edit'), await focused());
  await page.click(`${row('qa-wargames', 2)} [data-act="hold-edit"]`);
  await settle(page);
  await page.fill(`${row('qa-wargames', 2)} [name="tables"]`, 'Z99');
  check(`${size}: …nonsense reads as no tables`, flat(await page.textContent(`${row('qa-wargames', 2)} [data-tables-read]`)) === 'None of those are tables.');
  await page.click(`${row('qa-wargames', 2)} [data-hold-edit-form] [type="submit"]`);
  await settle(page);
  const said = flat(await page.textContent(`${row('qa-wargames', 2)} [data-form-error]`).catch(() => ''));
  check(`${size}: …Save keeps it open with the Lair app's words, focus back in the tables`, said === "Some of those tables don't exist. Use table codes like T20-T21, a room's name, or all." && (await focused()).startsWith('input(tables)'), { said, focused: await focused() });
  // one that exists and one that doesn't is refused too (it isn't the one that exists)
  await page.fill(`${row('qa-wargames', 2)} [name="tables"]`, 'T12, T99');
  await page.click(`${row('qa-wargames', 2)} [data-hold-edit-form] [type="submit"]`);
  await settle(page);
  const said2 = flat(await page.textContent(`${row('qa-wargames', 2)} [data-form-error]`).catch(() => ''));
  check(`${size}: …T12, T99 too: nothing saved`, said2 === "Some of those tables don't exist. Use table codes like T20-T21, a room's name, or all." && !(await page.evaluate((occ) => (window.Lair.store.data.holdEvents || []).flatMap((e) => e.dates).find((d) => d.occurrenceId === occ)?.changed, `qa-wargames@${addDays(T, 7)}`)), said2);
  await page.click(`${row('qa-wargames', 2)} [data-act="hold-edit-cancel"]`);
  await settle(page);

  /* ---------------- 3. every date of an event ---------------- */
  // the Events tab's list is loaded first (review, 28 Oct: after a change here its form showed the old tables)
  await page.click('[data-tab="events"]');
  await page.waitForFunction(() => (document.querySelector('staff-events')?.state?.list || []).length > 0, null, { timeout: 15000 });
  await page.click('[data-tab="holds"]');
  await settle(page);
  // the late Friday's third date gets tables of its own first
  await page.click(`${row('qa-cards-late', 3)} [data-act="hold-edit"]`);
  await settle(page);
  await page.fill(`${row('qa-cards-late', 3)} [name="tables"]`, 'T20-T21');
  await page.click(`${row('qa-cards-late', 3)} [data-hold-edit-form] [type="submit"]`);
  await settle(page, 500);
  await page.click(`${card('qa-cards-late')} [data-act="hold-edit"][data-id="event:qa-cards-late"]`);
  await settle(page);
  const all = `${card('qa-cards-late')} > [data-hold-edit-form]`;
  const allText = flat(await page.textContent(all));
  check(`${size}: Edit every date: the usual tables, Lock these tables ticked, the times are the event's, the date with its own named`,
    (await page.inputValue(`${all} [name="tables"]`)) === 'T10-T13, T18-T21' && (await page.isChecked(`${all} [name="lock"]`)) && allText.includes('The times are the event’s. Change them under Events') && allText.includes(`${words.fri3} keeps the tables it has of its own.`),
    allText.slice(0, 300));
  await axe(page, `${size}: every date's editor`, card('qa-cards-late'));
  await shot(page, `${size}-3-every-date`, card('qa-cards-late'));
  await page.fill(`${all} [name="tables"]`, 't10-t13');
  await page.click(`${all} [type="submit"]`);
  await settle(page, 600);
  check(`${size}: …Save: the toast, and the date with its own keeps it`, (await toast()) === `Friday league holds T10–T13 every date, locked. ${words.fri3} keeps its own.`, await toast());
  const late = flat(await page.textContent(card('qa-cards-late')));
  const cfgTables = await page.evaluate(() => window.Lair.store.cfg.events.find((e) => e.id === 'qa-cards-late').tables);
  check(`${size}: …the card's usual tables follow, and the page's events have them`, late.includes('T10–T13 · 7pm–midnight · locked') && late.includes('T20–T21 this date') && cfgTables === 'T10-T13', { late: late.slice(0, 220), cfgTables });
  await page.click(`${card('qa-cards-late')} [data-act="hold-edit"][data-id="event:qa-cards-late"]`);
  await settle(page);
  await page.click(`${card('qa-cards-late')} > [data-hold-edit-form] [data-act="open-event"]`);
  await page.waitForFunction(() => document.querySelector('staff-events form [name="tables"]'), null, { timeout: 15000 });
  const evForm = await page.evaluate(() => ({ tab: document.querySelector('lair-staff').tab, tables: document.querySelector('staff-events form [name="tables"]').value }));
  check(`${size}: …Change them under Events: the event's form has its new tables`, evForm.tab === 'events' && evForm.tables === 'T10-T13', evForm);
  await page.click('[data-tab="holds"]');
  await settle(page);
  if (await page.locator(`${card('qa-cards-late')} > [data-hold-edit-form]`).count()) await page.click(`${card('qa-cards-late')} [data-act="hold-edit-cancel"]`);
  await settle(page);
  await page.click(`${card('qa-monday')} [data-act="event-stop"]`);
  await settle(page);
  const ask = flat(await page.textContent(`${card('qa-monday')} .staff-confirm`).catch(() => ''));
  check(`${size}: Stop holding tables asks first, focus on Yes`, ask.startsWith('Stop holding T10–T13, T18–T21 for Monday cards every Monday? It stays on the events calendar, and nobody’s booking changes.') && (await focused()).startsWith('button[event-stop-yes]'), { ask, focused: await focused() });
  await axe(page, `${size}: Stop holding's question`, card('qa-monday'));
  await page.click(`${card('qa-monday')} [data-act="event-stop-no"]`);
  await settle(page);
  check(`${size}: …Keep them: back on Stop holding tables`, (await page.locator(`${card('qa-monday')} .staff-confirm`).count()) === 0 && (await focused()).startsWith('button[event-stop]'), await focused());
  await page.click(`${card('qa-monday')} [data-act="event-stop"]`);
  await page.click(`${card('qa-monday')} [data-act="event-stop-yes"]`);
  await settle(page, 600);
  check(`${size}: …Yes: the toast, the card goes, focus on the list's heading`, (await toast()) === 'Monday cards isn’t holding tables any more. It’s still on the events calendar.' && (await page.locator(card('qa-monday')).count()) === 0 && (await focused()).startsWith('h3#holds-list-title'), [await toast(), await focused()]);

  /* ---------------- 5. a staff one-off ---------------- */
  const day3 = addDays(T, 3);
  await page.fill('#holdx-tables', 'T14-T17');
  await page.fill('#holdx-label', 'Card prerelease (r22)');
  await page.selectOption('#holdx-type', 'tournament');
  await page.fill('#holdx-day', day3);
  await page.fill('#holdx-from', '14:00');
  await page.fill('#holdx-to', '22:00');
  await page.click('[data-panel="holds"] [data-hold-form] button[type="submit"]');
  await settle(page, 500);
  const oneId = await page.evaluate(() => window.Lair.store.data.blocks.find((b) => b.label === 'Card prerelease (r22)').id);
  const one = `[data-hold-card="block:${oneId}"]`;
  check(`${size}: a hold staff made: Edit and Remove`, flat(await page.innerText(one)).endsWith('Edit Remove'), flat(await page.innerText(one)));
  await page.click(`${one} [data-act="hold-edit"]`);
  await settle(page);
  const filled = await page.evaluate((sel) => Object.fromEntries([...document.querySelectorAll(`${sel} [data-hold-edit-form] [name]`)].map((el) => [el.name, el.value])), one);
  check(`${size}: …Edit: what for, type, tables, day, from and until, filled in; focus on What for`, JSON.stringify(filled) === JSON.stringify({ label: 'Card prerelease (r22)', type: 'tournament', tables: 'T14-T17', day: day3, from: '14:00', to: '22:00' }) && (await focused()).startsWith('input(label)'), { filled, focused: await focused() });
  await axe(page, `${size}: a staff hold's editor`, one);
  await shot(page, `${size}-5-staff-edit`, one);
  await page.fill(`${one} [name="tables"]`, 'T14, T99');
  await page.click(`${one} [data-hold-edit-form] [type="submit"]`);
  await settle(page, 400);
  const bad = flat(await page.textContent(`${one} [data-form-error]`).catch(() => ''));
  check(`${size}: …T14, T99: the Lair app's words, focus in the tables, nothing saved`, bad === 'Pick tables that exist, like T11-T20.' && (await focused()).startsWith('input(tables)') && (await page.evaluate((id) => window.Lair.store.data.blocks.find((b) => b.id === id).tables.join(), oneId)) === 'T14,T15,T16,T17', { bad, focused: await focused() });
  // the floor draws the list again while it saves: the new editor's Save is busy, and the error is said in it
  await page.evaluate(() => {
    const { store } = window.Lair;
    const staff = document.querySelector('lair-staff');
    const real = store.mutate;
    store.mutate = function again(...args) {
      store.mutate = real;
      const list = staff.querySelector('[data-holds-list]');
      list.dataset.html = '';
      staff.renderHolds();
      window.qaBusyMid = staff.querySelector('[data-holds-list] [data-hold-edit-form] [type="submit"]')?.getAttribute('aria-busy') || null;
      return real.apply(store, args);
    };
  });
  await page.click(`${one} [data-hold-edit-form] [type="submit"]`);
  await settle(page, 400);
  const mid = await page.evaluate(() => window.qaBusyMid);
  const bad2 = flat(await page.textContent(`${one} [data-form-error]`).catch(() => ''));
  const busyAfter = await page.getAttribute(`${one} [data-hold-edit-form] [type="submit"]`, 'aria-busy');
  check(`${size}: …drawn again while it saves: its Save is busy meanwhile, then the words are in the editor on the page`, mid === 'true' && bad2 === 'Pick tables that exist, like T11-T20.' && busyAfter === null && (await focused()).startsWith('input(tables)'), { mid, bad2, busyAfter, focused: await focused() });
  await page.fill(`${one} [name="tables"]`, 'T14-T18');
  await page.fill(`${one} [name="from"]`, '13:00');
  await page.click(`${one} [data-hold-edit-form] [type="submit"]`);
  await settle(page, 500);
  const dayName = await page.evaluate((d) => window.Lair.store.time.fmtDate(d).replace(',', ''), day3);
  check(`${size}: …Save: the toast, the card, focus on Edit`, (await toast()) === `Saved Card prerelease (r22): ${dayName}, 1pm–10pm, T14–T18.` && flat(await page.innerText(one)).includes('1pm–10pm · T14–T18') && (await focused()).startsWith('button[hold-edit]|Edit'), [await toast(), flat(await page.innerText(one)), await focused()]);

  /* ---------------- 6. a staff weekly hold ---------------- */
  const monday = (() => {
    let d = addDays(T, 1);
    while (weekday(d) !== 1) d = addDays(d, 1);
    return d;
  })();
  await page.fill('#holdx-tables', 'T1-T4');
  await page.fill('#holdx-label', 'League (r22)');
  await page.selectOption('#holdx-type', 'event');
  await page.fill('#holdx-day', monday);
  await page.fill('#holdx-from', '18:00');
  await page.fill('#holdx-to', '22:00');
  await page.check('[data-hold-repeat][value="weekly"]', { force: true });
  await page.click('[data-panel="holds"] [data-hold-form] button[type="submit"]');
  await settle(page, 500);
  const seriesId = await page.evaluate(() => window.Lair.store.data.blocks.find((b) => b.label === 'League (r22)').seriesId);
  const sc = `[data-series="${seriesId}"]`;
  const srow = (n) => `${sc} .staff-series__date:nth-child(${n})`;
  const sRows = await page.$$eval(`${sc} .staff-series__date`, (els) => els.map((e) => [...e.querySelectorAll('button')].map((b) => b.textContent.trim()).join(', ')));
  check(`${size}: a weekly hold: each date has Edit and Skip this date, the card Edit every date`, sRows.length === 4 && sRows.every((r) => r === 'Edit, Skip this date') && (await page.locator(`${sc} [data-act="hold-edit"][data-id="series:${seriesId}"]`).count()) === 1, sRows);
  await page.click(`${srow(2)} [data-act="hold-edit"]`);
  await settle(page);
  await page.fill(`${srow(2)} [name="to"]`, '21:00');
  await page.click(`${srow(2)} [data-hold-edit-form] [type="submit"]`);
  await settle(page, 500);
  const second = await page.evaluate((d) => window.Lair.store.time.fmtDate(window.Lair.store.time.addDays(d, 7)).replace(',', ''), monday);
  check(`${size}: …a date's Edit: the toast, and the row says what it has, with Back to usual`, (await toast()) === `Saved ${second}: T1–T4, 6pm–9pm.` && flat(await page.innerText(srow(2))) === `${second} T1–T4 · 6pm–9pm this date Edit Back to usual Skip this date`, [await toast(), flat(await page.innerText(srow(2)))]);
  await page.click(`${sc} [data-act="hold-edit"][data-id="series:${seriesId}"]`);
  await settle(page);
  check(`${size}: …Edit every date: the hold's usual tables and times (not the changed date's)`, (await page.inputValue(`${sc} > [data-hold-edit-form] [name="tables"]`)) === 'T1-T4' && (await page.inputValue(`${sc} > [data-hold-edit-form] [name="to"]`)) === '22:00');
  await page.fill(`${sc} > [data-hold-edit-form] [name="tables"]`, 'T1-T6');
  await page.click(`${sc} > [data-hold-edit-form] [type="submit"]`);
  await settle(page, 500);
  check(`${size}: …Save every date: the toast names the date that keeps its own`, (await toast()) === `Saved every date to come: T1–T6, 6pm–10pm. ${second} keeps its own.`, await toast());
  const sText = flat(await page.innerText(sc));
  check(`${size}: …the card's usual is new, the changed date kept`, sText.includes('T1–T6 · 6pm–10pm') && flat(await page.innerText(srow(2))).startsWith(`${second} T1–T4 · 6pm–9pm this date`), sText.slice(0, 260));
  await page.click(`${srow(2)} [data-act="bdate-usual"]`);
  await settle(page, 500);
  check(`${size}: …Back to usual: the hold's new tables and times`, (await toast()) === `${second} is back to usual: T1–T6, 6pm–10pm.` && flat(await page.innerText(srow(2))) === `${second} Edit Skip this date`, [await toast(), flat(await page.innerText(srow(2)))]);
  await noSideways('a weekly hold');
  await page.locator(sc).scrollIntoViewIfNeeded();
  await shot(page, `${size}-6-weekly-hold`, sc);

  /* ---------------- 7. the floor, tonight's Thursday ---------------- */
  await page.click('[data-tab="floor"]');
  await page.evaluate(() => {
    const staff = document.querySelector('lair-staff');
    staff.selected = [];
    staff.tapTable('T12');
  });
  await settle(page);
  const sheet = flat(await page.textContent('[data-sheet]'));
  check(`${size}: the floor: a table the Thursday holds says so, with Free T12 today and Edit the hold`, sheet.includes('Wargames night') && sheet.includes('From the events calendar.') && sheet.includes('Free T12 today') && sheet.includes('Edit the hold'), sheet.slice(0, 260));
  await axe(page, `${size}: the floor's sheet (the hold)`, '[data-sheet] article.staff-card:not([class*="staff-card--"])');
  await page.locator('[data-sheet]').scrollIntoViewIfNeeded();
  await shot(page, `${size}-7-floor-sheet`, '[data-sheet]');
  await page.click('[data-sheet] [data-act="floor-free-table"]');
  await settle(page, 500);
  const freed = await page.evaluate(() => {
    const { store } = window.Lair;
    return { status: store.statusAt('T12', Date.now()).status, t13: store.statusAt('T13', Date.now()).status };
  });
  check(`${size}: …Free T12 today: the toast, T12 free now, T13 still held`, (await toast()) === 'T12 is free: Wargames night doesn’t hold it today.' && freed.status !== 'event' && freed.t13 === 'event', [await toast(), freed]);
  check(`${size}: …focus stays in the sheet (its heading)`, await page.evaluate(() => Boolean(document.activeElement && document.activeElement.closest('[data-sheet]') && document.activeElement.tagName === 'H3')), await focused());
  await page.evaluate(() => {
    const staff = document.querySelector('lair-staff');
    staff.selected = [];
    staff.tapTable('T13');
  });
  await settle(page);
  await page.click('[data-sheet] [data-act="floor-edit-hold"]');
  await settle(page, 600);
  const onHolds = await page.evaluate(() => ({ tab: document.querySelector('lair-staff').tab, value: document.activeElement && document.activeElement.value, name: document.activeElement && document.activeElement.name }));
  check(`${size}: …Edit the hold: the Holds tab, that date's editor with its tables now (T12 gone), focused`, onHolds.tab === 'holds' && onHolds.name === 'tables' && onHolds.value === 'T8-T11, T13-T21', onHolds);
  await page.keyboard.press('Escape');
  await settle(page);
  // a staff hold on the floor: Edit too
  const nowHold = await page.evaluate(async () => {
    const { store } = window.Lair;
    const start = Date.now() - 1800000;
    const { block } = await store.mutate('createBlock', { tables: ['P3'], start, end: start + 3 * 3600000, label: 'Painting (r22)', type: 'event' });
    return block.id;
  });
  await page.click('[data-tab="floor"]');
  await page.evaluate(() => {
    const staff = document.querySelector('lair-staff');
    staff.selected = [];
    staff.tapTable('P3');
  });
  await settle(page);
  await page.click('[data-sheet] [data-act="floor-edit-hold"]');
  await settle(page, 600);
  check(`${size}: a staff hold on the floor: Edit opens its editor on the Holds tab`, (await page.locator(`[data-hold-card="block:${nowHold}"] [data-hold-edit-form]`).count()) === 1 && (await focused()).startsWith('input(label)'), await focused());
  await page.keyboard.press('Escape');

  /* ---------------- 8. an older Lair app, and the live routes ---------------- */
  const older = await page.evaluate(() => {
    const staff = document.querySelector('lair-staff');
    const { store } = window.Lair;
    const kept = store.data.holdEvents;
    store.data.holdEvents = null;
    staff.renderHolds();
    const cards = [...document.querySelectorAll('[data-holds-list] > article')].filter((a) => a.querySelector('strong').textContent.trim() === 'Friday cards');
    const edits = document.querySelectorAll('[data-holds-list] [data-act="hold-edit"], [data-holds-list] [data-act="bdate-usual"]').length;
    const out = { cards: cards.length, buttons: cards.reduce((n, a) => n + a.querySelectorAll('button').length, 0), says: cards[0] && cards[0].textContent.includes('From the events calendar'), edits };
    store.data.holdEvents = kept;
    staff.renderHolds();
    return out;
  });
  check(`${size}: a Lair app with no holdEvents: event holds as before (a card a date, nothing to tap), and no Edit on staff holds`, older.cards > 3 && older.buttons === 0 && older.says && older.edits === 0, older);
  const both = await page.evaluate(() => {
    const staff = document.querySelector('lair-staff');
    const d = { start: Date.now() };
    return [staff.everyText({ repeat: null }, [d, d]), staff.everyText({ repeat: null }, [d, d, d]), staff.everyText({ repeat: 'fortnightly', repeatTag: 'Fortnightly · Thursdays 6:30pm' }, [d]), staff.everyText({ repeat: 'weekly', repeatTag: 'Weekly · Saturdays and Sundays 10am' }, [d])];
  });
  check(`${size}: Stop holding's words: a one-off over two days "on both days"; fortnightly; a weekend`, JSON.stringify(both) === JSON.stringify(['on both days', 'on all 3 days', 'every second Thursday', 'every Saturday and Sunday']), both);

  /* ---------------- 9. a weekly hold changed while tonight's date is on (review, 28 Oct) ---------------- */
  await page.click('[data-tab="holds"]');
  await settle(page);
  const painting = await page.evaluate(async (today) => {
    const { store } = window.Lair;
    const t = store.time;
    const { series } = await store.mutate('createBlock', { tables: ['P1', 'P2'], start: t.at(today, 18 * 60), end: t.at(today, 22 * 60), label: 'Painting club (r22)', type: 'event', repeat: 'weekly' });
    return series.id;
  }, T);
  const pc = `[data-series="${painting}"]`;
  await page.waitForSelector(pc);
  await page.click(`${pc} [data-act="hold-edit"][data-id="series:${painting}"]`);
  await settle(page);
  await page.fill(`${pc} > [data-hold-edit-form] [name="tables"]`, 'P3-P4');
  await page.fill(`${pc} > [data-hold-edit-form] [name="from"]`, '17:00');
  await page.fill(`${pc} > [data-hold-edit-form] [name="to"]`, '21:00');
  await page.fill(`${pc} > [data-hold-edit-form] [name="label"]`, 'Painting night (r22)');
  await page.click(`${pc} > [data-hold-edit-form] [type="submit"]`);
  await settle(page, 500);
  const pText = flat(await page.innerText(pc));
  const pRow1 = flat(await page.innerText(`${pc} .staff-series__date:nth-child(1)`));
  check(`${size}: a weekly hold changed while tonight's is on: the card has its new name, tables and times; tonight keeps what it had`, pText.startsWith('Painting night (r22)') && pText.includes('P3–P4 · 5pm–9pm') && pRow1.startsWith('Today, on now P1–P2 · 6pm–10pm this date'), { pText: pText.slice(0, 200), pRow1 });
  await page.click(`${pc} [data-act="hold-edit"][data-id="series:${painting}"]`);
  await settle(page);
  const againVals = await page.evaluate((sel) => Object.fromEntries([...document.querySelectorAll(`${sel} > [data-hold-edit-form] [name]`)].map((el) => [el.name, el.value])), pc);
  check(`${size}: …Edit every date again: the new usual, not tonight's`, againVals.tables === 'P3-P4' && againVals.from === '17:00' && againVals.to === '21:00' && againVals.label === 'Painting night (r22)', againVals);
  await page.click(`${pc} [data-act="hold-edit-cancel"]`);
  await settle(page);
  await noSideways('a weekly hold under way');
  await axe(page, `${size}: a weekly hold under way`, pc);

  /* ---------------- 10. the booking page and the calendar (review, 28 Oct) ---------------- */
  const warNext = `qa-wargames@${addDays(T, 7)}`;
  await page.evaluate(async ([tonight, next]) => {
    const { store } = window.Lair;
    await store.mutate('holdEventDate', tonight, { tables: 'T8-T9' });
    await store.mutate('holdEventDate', next, { tables: '' });
  }, [`qa-wargames@${T}`, warNext]);
  await go(page, BASE, '/pages/book-a-table?show=events');
  await page.waitForSelector('.play-row', { timeout: 20000 });
  const rowMeta = await page.evaluate(() => {
    const r = [...document.querySelectorAll('.play-row')].find((x) => x.querySelector('.play-row__title')?.textContent.trim() === 'Wargames night');
    return r ? r.querySelector('.play-row__meta')?.textContent.replace(/\s+/g, ' ').trim() : null;
  });
  check(`${size}: the booking page: tonight's Wargames night says the tables it holds tonight`, Boolean(rowMeta) && rowMeta.endsWith('T8 + T9'), rowMeta);
  await go(page, BASE, `/pages/events-calendar#event=${encodeURIComponent(warNext)}`);
  await page.waitForSelector('lair-calendar [data-dialog][open]', { timeout: 20000 });
  await settle(page);
  const calNote = flat(await page.textContent('lair-calendar [data-dialog] .cal-note--early, lair-calendar [data-dialog] .cal-note--held').catch(() => ''));
  const floorSays = await page.evaluate((occ) => (window.Lair.store.data.eventHolds || []).filter((h) => h.occurrenceId === occ).map((h) => `${h.spots ? 'spots' : 'held'}:${h.tables.join('+')}`), warNext);
  check(`${size}: the calendar: next week's Wargames night holds none, and its game tables are set aside as the floor marks them`,
    calNote === 'T8–T15 and T18–T21 are set aside for wargames night. Anyone can still book them, but expect armies.' && JSON.stringify(floorSays) === JSON.stringify(['spots:T8+T9+T10+T11+T12+T13+T14+T15+T18+T19+T20+T21']), { calNote, floorSays });
  await noSideways('the end');
  check(`${size}: no script errors`, !page.errors.length, page.errors);
  await ctx.close();
}

/* LiveBackend: what goes to the Lair app (live mode, the app's routes answered here) */
{
  m.globalSettings.lair_mode = 'live';
  const ctx = await context(browser, 'desktop', '19:00');
  const page = watch(await ctx.newPage());
  const sent = [];
  await page.route('**/apps/liar/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'POST') sent.push({ path: url.pathname.replace(/^.*\/apps\/liar/, ''), body: req.postData() });
    if (url.pathname.endsWith('/floor')) return route.fulfill({ json: { now: Date.now(), bookings: [], blocks: [], games: [], events: [], eventJoins: {}, eventSpots: {}, joins: [], openings: [], shopTables: [], features: {}, eventHolds: [], holdEvents: [] } });
    if (url.pathname.endsWith('/hold')) return route.fulfill({ json: { hold: { occurrenceId: 'x', tables: [], changed: true, start: Date.now(), end: Date.now() + 1, title: 'X' }, clashes: [] } });
    if (url.pathname.endsWith('/update')) return route.fulfill({ json: { block: { id: 'bl_x' }, clashes: [], series: null, kept: [] } });
    return route.fulfill({ json: {} });
  });
  await go(page, BASE, '/pages/lair-staff', STAFF);
  await page.waitForFunction(() => window.Lair && window.Lair.store, null, { timeout: 15000 });
  await page.evaluate(async () => {
    const be = window.Lair.store.backend;
    await be.holdEventDate('qa-cards-early@2026-10-30', { tables: ['T18'] });
    await be.holdEventDate('qa-cards-early@2026-11-06', { usual: true });
    await be.updateBlock('bl_one', { scope: 'date', tables: ['T1'] });
  });
  const of = (p) => sent.filter((s) => s.path === p).map((s) => s.body);
  check('live: holdEventDate posts the tables to /events/:occurrenceId/hold', JSON.stringify(of('/events/qa-cards-early%402026-10-30/hold')) === JSON.stringify(['{"tables":["T18"]}']), sent);
  check('live: …and usual: true', JSON.stringify(of('/events/qa-cards-early%402026-11-06/hold')) === JSON.stringify(['{"usual":true}']), sent);
  check('live: updateBlock posts to /blocks/:id/update', JSON.stringify(of('/blocks/bl_one/update')) === JSON.stringify(['{"scope":"date","tables":["T1"]}']), sent);
  await ctx.close();
}

await browser.close();
server.close?.();
const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

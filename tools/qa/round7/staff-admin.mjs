// Round 7, staff-admin: the staff page's new tabs and changes (contract v7 sections 3, 5, 8, 9, 10 and 18.4), in demo
// mode through theme-mock, at 390px and then 1280px, as a staff customer:
//   - the ten tabs in the contract's order, and deep links (#events, ?tab=codes, #groups);
//   - Events: add a weekly event with a picture (shrunk to 1600px wide) and see it listed with its repeat tag, edit it,
//     a 422 beside its field, a date with sign-ups refusing to move (409), remove one, and Shopify's 503;
//   - Groups: make one with an organiser and people from the customer search (one not yet a Lair member), add and take
//     out people, issue the group a pass, archive it;
//   - Session passes: for a group, for a picked customer (their name and email filled in, read only), for a typed name;
//   - Loot codes: the panel line, a typed one, a generated one (GG-WORD-N), a taken one (409 beside the field), edit,
//     set inactive;
//   - Members: a gift in words, the player profile, birthdays with no suggested rolls (the gift form's rolls start at 0);
//   - Check-in: a member card shows their group's pass;
//   - no sideways scroll and no console errors.
// Prints PASS or FAIL lines and a summary; exits 1 if anything fails. Screenshots go to SHOTS (default: ./shots/).
// Usage: DG_THEME=/path/to/theme PORT=4842 node tools/qa/round7/staff-admin.mjs [phone|desktop]
// LAIR_AT=YYYY-MM-DDTHH:MM pins the page clock in Auckland (default 5pm today), so tonight's event still has sign-ups.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4842);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS || new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(SHOTS, { recursive: true });
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
// round 9: the main account also has the Team tab, last
const TABS = ['Floor', 'Today’s bookings', 'Passes', 'Groups', 'Members', 'Loot codes', 'Holds and openings', 'GM games', 'Events', 'Library', 'Team'];

// The page clock: LAIR_AT, or 5pm today in Auckland
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(new Date());
const [d, hm] = (process.env.LAIR_AT || `${today}T17:00`).split('T');
const AT = (() => {
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  const parts = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return guess - (Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - guess);
})();
const CLOCK = `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = await m.serve(PORT);
const browser = await chromium.launch();
m.mockState.customer = STAFF;

async function open(size, path) {
  const vp = SIZES[size];
  const phone = size === 'phone';
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(CLOCK);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) page.errors.push(`console: ${msg.text()}`);
  });
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(700);
  return { ctx, page };
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const shot = async (page, name, sel) => {
  const file = `${SHOTS}${name}.png`;
  if (sel) {
    const el = await page.$(sel);
    if (el) await el.screenshot({ path: file });
  } else await page.screenshot({ path: file, fullPage: false });
};
const tab = async (page, id) => {
  await page.click(`[data-tab="${id}"]`);
  await page.waitForTimeout(400);
};
const toast = async (page) => flat(await page.locator('.toast').innerText().catch(() => ''));
/** Pick someone with a customer picker: type, wait for the results, click the one whose text has `who` */
const pick = async (page, picker, q, who) => {
  await page.fill(`${picker} .sa-pick__input`, q);
  await page.waitForSelector(`${picker} [data-pick]`, { timeout: 5000 });
  await page.locator(`${picker} [data-pick]`, { hasText: who }).first().click();
  await page.waitForTimeout(300);
};

const sizes = process.argv[2] ? [process.argv[2]] : ['phone', 'desktop'];
for (const size of sizes) {
  // ---------- tabs and deep links ----------
  {
    const { ctx, page } = await open(size, '/pages/lair-staff#events');
    const tabs = await page.$$eval('.staff-tab', (els) => els.map((el) => ({ text: el.childNodes[0].textContent.trim(), id: el.dataset.tab, on: el.getAttribute('aria-selected') })));
    check(`${size}: the tabs in the contract's order (round 9: Team last)`, JSON.stringify(tabs.map((x) => x.text)) === JSON.stringify(TABS), tabs.map((x) => x.text));
    const panels = await page.$$eval('.staff-panel', (els) => els.map((el) => el.id));
    check(`${size}: groups, codes and events panels sit right after passes`, panels.join(',').includes('panel-passes,panel-groups,panel-codes,panel-events'), panels.join(','));
    check(`${size}: #events opens the Events tab`, tabs.find((x) => x.id === 'events').on === 'true' && !(await page.isHidden('#panel-events')), tabs);
    await page.waitForSelector('.sa-event', { timeout: 10000 });
    check(`${size}: the Events tab loads when a deep link opens it`, (await page.locator('.sa-event').count()) > 3);
    await ctx.close();
    const codes = await open(size, '/pages/lair-staff?tab=codes');
    check(`${size}: ?tab=codes opens Loot codes`, (await codes.page.getAttribute('#tab-codes', 'aria-selected')) === 'true');
    await codes.ctx.close();
    const groups = await open(size, '/pages/lair-staff#groups');
    check(`${size}: #groups opens Groups`, (await groups.page.getAttribute('#tab-groups', 'aria-selected')) === 'true');
    // the tab event: the new tabs load the first time they open
    const seen = await groups.page.evaluate(() => new Promise((resolve) => {
      document.addEventListener('lair-staff:tab', (e) => resolve(e.detail.id), { once: true });
      document.querySelector('[data-tab="codes"]').click();
    }));
    check(`${size}: opening a tab sends lair-staff:tab with its id`, seen === 'codes', seen);
    await groups.ctx.close();
  }

  const { ctx, page } = await open(size, '/pages/lair-staff');
  const be = (fn, ...args) => page.evaluate(([f, a]) => window.Lair.store.backend[f](...a), [fn, args]);

  // ---------- events: add a weekly event with a picture ----------
  await tab(page, 'events');
  await page.waitForSelector('.sa-event', { timeout: 10000 });
  await page.click('[data-event-new]');
  await page.waitForSelector('[data-event-form]');
  const first = await page.evaluate(() => window.Lair.store.time.addDays(window.Lair.store.time.today(), 9));
  const weekday = await page.evaluate((key) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][window.Lair.store.time.weekday(key)], first);
  const skip = await page.evaluate((key) => window.Lair.store.time.addDays(key, 14), first);
  await page.fill('#sa-ev-title', 'QA Goblin Gauntlet');
  await page.selectOption('#sa-ev-type', 'wargame');
  await page.fill('#sa-ev-game', 'Kill Team');
  await page.fill('#sa-ev-description', 'Pick-up Kill Team games. Bring your team.');
  await page.fill('#sa-ev-date', first);
  await page.fill('#sa-ev-from', '18:30');
  await page.fill('#sa-ev-until', '22:00');
  await page.check('[data-event-form] [name="repeat"][value="weekly"]', { force: true });
  await page.waitForTimeout(200);
  const tagPreview = flat(await page.textContent('[data-event-tag]'));
  check(`${size}: the form shows the repeat tag as the calendar will`, tagPreview === `On the calendar: Weekly · ${weekday}s 6:30pm`, tagPreview);
  await page.fill('#sa-ev-skipDate', skip);
  await page.click('[data-skip-add]');
  check(`${size}: a skip date joins the list`, (await page.locator('.sa-skip').count()) === 1, await page.locator('[data-skips]').innerText().catch(() => ''));
  await page.fill('#sa-ev-capacity', '16');
  await page.fill('#sa-ev-entryFee', '10');
  await page.fill('#sa-ev-priceNote', '$10 a player');
  await page.check('[data-event-form] [name="payment"][value="either"]', { force: true });
  await page.fill('#sa-ev-tables', 't20-t21');
  await page.waitForTimeout(150);
  check(`${size}: tables read back as the codes they are`, /Reads as 2 tables: T20, T21/.test(await page.textContent('[data-tables-read]')), await page.textContent('[data-tables-read]'));
  await page.check('[data-event-form] [name="lockTables"]', { force: true });
  await page.fill('#sa-ev-gameTables', 'T14+T15');
  await page.fill('#sa-ev-link', 'https://example.com/gauntlet');
  // a big picture: the browser shrinks it to 1600px wide and 700 KB
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2400;
    canvas.height = 1350;
    const g = canvas.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 2400, 1350);
    grad.addColorStop(0, '#3fd16b');
    grad.addColorStop(1, '#5a3fa6');
    g.fillStyle = grad;
    g.fillRect(0, 0, 2400, 1350);
    for (let i = 0; i < 400; i += 1) {
      g.fillStyle = `hsl(${(i * 37) % 360} 70% 55%)`;
      g.fillRect((i * 97) % 2400, (i * 53) % 1350, 60, 60);
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const input = document.querySelector('[data-event-file]');
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'gauntlet.png', { type: 'image/png' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForSelector('[data-picture-note]', { timeout: 10000 });
  const note = flat(await page.textContent('[data-picture-note]'));
  const [w, kb] = [Number((/Ready: (\d+)×/.exec(note) || [])[1]), Number((/, (\d+) KB/.exec(note) || [])[1])];
  check(`${size}: the picture is shrunk in the browser (at most 1600px wide, 700 KB)`, w === 1600 && kb > 0 && kb <= 700, note);
  if (size === 'phone') await shot(page, `${size}-events-form`, '[data-event-form]');
  await page.click('[data-event-form] button[type="submit"]');
  await page.waitForSelector('.sa-event.is-new', { timeout: 10000 });
  const added = page.locator('.sa-event', { hasText: 'QA Goblin Gauntlet' });
  const addedText = flat(await added.innerText());
  check(`${size}: the new event is listed with its repeat tag and next date`, addedText.includes(`Weekly · ${weekday}s 6:30pm`) && /Next: \w{3} \d+ \w{3}/.test(addedText) && addedText.includes('16 places'), addedText);
  check(`${size}: …and its picture`, (await added.locator('img.sa-event__img').getAttribute('src') || '').startsWith('data:image/jpeg'));
  const cfg = await page.evaluate(() => {
    const e = window.Lair.store.cfg.events.find((x) => x.title === 'QA Goblin Gauntlet');
    const dates = window.Lair.store.data.events.filter((o) => o.title === 'QA Goblin Gauntlet');
    return e ? { id: e.id, repeat: e.repeat, start: e.start, skip: e.skipDates, entryFee: e.entryFee, payment: e.payment, lock: e.lockTables, image: String(e.image || '').slice(0, 20), dates: dates.length } : null;
  });
  check(`${size}: store.cfg.events has its config, and the floor's events follow`, cfg && cfg.id === 'qa-goblin-gauntlet' && cfg.repeat === 'weekly' && /T18:30:00\+1[23]:00$/.test(cfg.start) && cfg.skip.length === 1 && cfg.entryFee === 1000 && cfg.payment === 'either' && cfg.lock === true && cfg.image.startsWith('data:image') && cfg.dates > 0, cfg);
  check(`${size}: saved: a toast says so`, /Added QA Goblin Gauntlet/.test(await toast(page)), await toast(page));
  if (size === 'phone') await shot(page, `${size}-events-list`, '.sa-event.is-new');

  // edit it
  await added.locator('[data-event-edit]').click();
  await page.waitForSelector('[data-event-form="qa-goblin-gauntlet"]');
  await page.fill('#sa-ev-title', 'QA Goblin Gauntlet: league night');
  await page.fill('#sa-ev-capacity', '12');
  await page.click('[data-event-form] button[type="submit"]');
  await page.waitForTimeout(600);
  const edited = flat(await page.locator('.sa-event', { hasText: 'league night' }).innerText().catch(() => ''));
  check(`${size}: an edit saves (title and places)`, edited.includes('QA Goblin Gauntlet: league night') && edited.includes('12 places'), edited);
  const editedCfg = await page.evaluate(() => window.Lair.store.cfg.events.filter((x) => x.id === 'qa-goblin-gauntlet').map((x) => `${x.title}/${x.capacity}`));
  check(`${size}: the edit replaces its config (same handle)`, JSON.stringify(editedCfg) === JSON.stringify(['QA Goblin Gauntlet: league night/12']), editedCfg);

  // a 422 beside its field: tables that don't exist
  await page.locator('.sa-event', { hasText: 'league night' }).locator('[data-event-edit]').click();
  await page.waitForSelector('[data-event-form="qa-goblin-gauntlet"]');
  await page.fill('#sa-ev-tables', 'T99');
  await page.click('[data-event-form] button[type="submit"]');
  await page.waitForTimeout(500);
  const tablesError = flat(await page.textContent('[data-error-name="tables"]'));
  const invalid = await page.getAttribute('#sa-ev-tables', 'aria-invalid');
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  check(`${size}: a 422 shows beside its field, marked and focused`, tablesError === "Some of those tables don't exist. Use table codes like T20-T21, a room's name, or all." && invalid === 'true' && focused === 'sa-ev-tables' && await page.isVisible('[data-error-name="tables"]'), { tablesError, invalid, focused });
  if (size === 'phone') await shot(page, `${size}-events-422`, '#sa-ev-tables >> xpath=ancestor::div[contains(@class,"field")]');
  await page.click('[data-event-back]');
  await page.waitForTimeout(300);

  // a date with sign-ups can't move (409)
  const signed = await page.evaluate(async () => (await window.Lair.store.backend.listEvents()).events.find((e) => e.booked && e.booked.length));
  if (!signed) check(`${size}: an event with sign-ups to try the 409 on`, false, 'none in the demo');
  else {
    await page.locator(`[data-event-handle="${signed.handle}"] [data-event-edit]`).click();
    await page.waitForSelector(`[data-event-form="${signed.handle}"]`);
    check(`${size}: the form says which dates have sign-ups`, /People have signed up for/.test(await page.textContent('.sa-event-form__booked')));
    await page.fill('#sa-ev-from', '19:15');
    await page.click('[data-event-form] button[type="submit"]');
    await page.waitForTimeout(500);
    const msg = flat(await page.textContent('[data-event-form] [data-form-error]'));
    const day = await page.evaluate((ms) => window.Lair.store.time.fmtDate(window.Lair.store.time.key(ms)).replace(',', ''), signed.booked[0].start);
    check(`${size}: a date with sign-ups refuses to move (409), said plainly over the form`, msg === `People have signed up for ${day}, so that date can't move or go. Cancel their sign-ups on the staff page first, or make the change from a date nobody's signed up for.` && await page.isVisible('[data-event-form] [data-form-error]'), msg);
    if (size === 'phone') await shot(page, `${size}-events-409`, '[data-event-form] [data-form-error]');
    const still = await page.evaluate((h) => window.Lair.store.cfg.events.find((x) => x.id === h).start, signed.handle);
    check(`${size}: …and nothing changed`, still === signed.config.start, still);
    await page.click('[data-event-back]');
    await page.waitForTimeout(300);
    // removing it says why it can't go, with no Remove button
    await page.locator(`[data-event-handle="${signed.handle}"] [data-event-ask]`).click();
    const ask = flat(await page.locator(`[data-event-handle="${signed.handle}"] .staff-confirm`).innerText());
    check(`${size}: Remove on a date with sign-ups says it can't go yet`, /People have signed up for .*, so it can’t go yet/.test(ask) && !(await page.locator(`[data-event-handle="${signed.handle}"] [data-event-remove]`).count()), ask);
    await page.locator(`[data-event-handle="${signed.handle}"] [data-event-ask=""]`).click();
  }

  // remove one
  const row = page.locator('[data-event-handle="qa-goblin-gauntlet"]');
  await row.locator('[data-event-ask]').click();
  const askText = flat(await row.locator('.staff-confirm').innerText());
  check(`${size}: Remove asks first and says what happens`, /Remove QA Goblin Gauntlet: league night\?/.test(askText) && /off the events calendar and the booking map/.test(askText), askText);
  if (size === 'phone') await shot(page, `${size}-events-remove`, '[data-event-handle="qa-goblin-gauntlet"]');
  await row.locator('[data-event-remove]').click();
  await page.waitForTimeout(600);
  const gone = await page.evaluate(() => ({ row: Boolean(document.querySelector('[data-event-handle="qa-goblin-gauntlet"]')), cfg: window.Lair.store.cfg.events.some((x) => x.id === 'qa-goblin-gauntlet'), dates: window.Lair.store.data.events.some((o) => o.handle === 'qa-goblin-gauntlet') }));
  check(`${size}: removed: off the list, store.cfg.events and the floor`, !gone.row && !gone.cfg && !gone.dates, gone);

  // ---------- groups ----------
  await tab(page, 'groups');
  await page.waitForSelector('.sa-row', { timeout: 10000 });
  check(`${size}: the demo's league group is listed`, /Thursday Warhammer league/.test(await page.textContent('[data-group-list]')));
  await page.click('[data-group-new]');
  await page.waitForSelector('[data-group-form]');
  await page.fill('#sa-group-name', 'QA Dice Club');
  await pick(page, 'staff-customer-pick[data-id="sa-group-organiser"]', 'sam', 'Sam Tautahi');
  const organiserShown = flat(await page.textContent('staff-customer-pick[data-id="sa-group-organiser"] [data-pick-picked]'));
  check(`${size}: the organiser is picked from the customer search`, /Sam Tautahi/.test(organiserShown), organiserShown);
  await pick(page, 'staff-customer-pick[data-id="sa-group-people"]', 'aroha', 'Aroha Ngata');
  await page.fill('staff-customer-pick[data-id="sa-group-people"] .sa-pick__input', 'mere');
  await page.waitForSelector('staff-customer-pick[data-id="sa-group-people"] [data-pick]', { timeout: 5000 });
  const nonMember = flat(await page.locator('staff-customer-pick[data-id="sa-group-people"] [data-pick]').first().innerText());
  check(`${size}: the search finds a customer who isn't a Lair member yet`, /Mere Paewai/.test(nonMember) && /Not a Lair member yet/.test(nonMember), nonMember);
  await page.locator('staff-customer-pick[data-id="sa-group-people"] [data-pick]').first().click();
  await page.waitForTimeout(200);
  if (size === 'phone') await shot(page, `${size}-groups-new`, '[data-group-form]');
  await page.click('[data-group-form] button[type="submit"]');
  await page.waitForSelector('[data-group-people] .sa-person', { timeout: 10000 });
  const people = await page.$$eval('[data-group-people] .sa-person', (els) => els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()));
  check(`${size}: made the group: organiser, a member and a new member`, people.length === 3 && people.some((p) => /Sam Tautahi Organiser/.test(p)) && people.some((p) => /Mere Paewai/.test(p) && /[A-Z]{2}-[A-Z]+-\d+/.test(p)), people);
  // add and take out
  await pick(page, '[data-group-add] staff-customer-pick', 'grace', 'Grace Liu');
  await page.waitForTimeout(400);
  check(`${size}: someone added from the search is in`, (await page.locator('[data-group-people] .sa-person').count()) === 4 && /Grace Liu is in QA Dice Club/.test(await toast(page)), await toast(page));
  const aroha = page.locator('[data-group-people] .sa-person', { hasText: 'Aroha Ngata' });
  await aroha.locator('[data-group-confirm^="remove:"]').click();
  const removeAsk = flat(await page.locator('[data-group-people] .staff-confirm').innerText());
  check(`${size}: taking someone out asks first, and says what happens`, /Take Aroha Ngata out of QA Dice Club\?/.test(removeAsk) && /can’t use the group’s passes/.test(removeAsk), removeAsk);
  await page.click('[data-group-remove]');
  await page.waitForTimeout(400);
  const after = await page.$$eval('[data-group-people] .sa-person', (els) => els.map((el) => el.innerText));
  check(`${size}: …and they're out`, after.length === 3 && !after.some((p) => /Aroha/.test(p)), after);
  const organiserOut = await page.evaluate(async () => {
    const b = window.Lair.store.backend;
    const g = (await b.listGroups({ q: 'QA Dice Club' })).groups[0];
    try {
      await b.groupMembers(g.id, { remove: [g.organiser.customerId] });
      return 'removed';
    } catch (e) {
      return `${e.status} ${e.message}`;
    }
  });
  check(`${size}: the organiser can't be taken out (409)`, organiserOut === "409 That's the organiser. Pick a new organiser first.", organiserOut);
  if (size === 'phone') await shot(page, `${size}-groups-page`, '.sa-group');

  // ---------- passes: for the group, a picked customer and a typed name ----------
  await page.click('[data-group-issue]');
  await page.waitForSelector('[data-pass-new]');
  await page.waitForFunction(() => document.querySelector('[data-pass-group] option:checked')?.textContent.includes('QA Dice Club'), null, { timeout: 5000 });
  check(`${size}: "Issue a pass for this group" opens the form on that group`, (await page.isVisible('[data-owner-panel="group"]')) && await page.isChecked('[data-pass-owner-pick][value="group"]'));
  await page.click('[data-pass-preset="Gift pack: 10 sessions"]');
  await page.click('[data-pass-new] button[type="submit"]');
  await page.waitForSelector('[data-pass-card]', { timeout: 10000 });
  await page.waitForTimeout(300);
  const groupCard = flat(await page.textContent('[data-pass-card]'));
  check(`${size}: a group's pass reads as the group`, /Group\s*QA Dice Club/.test(groupCard) && !/Not on anyone/.test(groupCard), groupCard.slice(0, 220));
  check(`${size}: …and its code comes from the group's name`, /^QC-[A-Z]+-\d+$/.test(flat(await page.textContent('.staff-pass__code'))), await page.textContent('.staff-pass__code'));
  await page.click('[data-pass-back]');
  await page.waitForTimeout(500);
  const listRow = flat(await page.locator('.staff-pass-row', { hasText: 'Gift pack: 10 sessions' }).first().innerText().catch(() => ''));
  check(`${size}: the pass list shows the group's name`, /QA Dice Club group/.test(listRow), listRow);
  await page.fill('#pass-find', 'dice club');
  await page.waitForTimeout(700);
  check(`${size}: finding passes by a group's name`, /QA Dice Club group/.test(await page.textContent('[data-pass-list]')));
  // a picked customer
  await page.click('[data-pass-issue]');
  await page.waitForSelector('[data-pass-new]');
  check(`${size}: the pass form starts on Group`, await page.isChecked('[data-pass-owner-pick][value="group"]'));
  await page.check('[data-pass-owner-pick][value="customer"]', { force: true });
  await page.fill('#pass-new-label', 'Session pass: 5 sessions');
  await pick(page, '[data-owner-panel="customer"] staff-customer-pick', 'hemi', 'Hemi Walker');
  const filled = await page.evaluate(() => ({ name: document.querySelector('#pass-new-cname').value, email: document.querySelector('#pass-new-cemail').value, ro: document.querySelector('#pass-new-cname').readOnly && document.querySelector('#pass-new-cemail').readOnly }));
  check(`${size}: a picked customer fills their name and email, read only`, filled.name === 'Hemi Walker' && filled.email === 'hemi@example.com' && filled.ro, filled);
  if (size === 'phone') await shot(page, `${size}-pass-customer`, '[data-pass-owner]');
  await page.click('[data-pass-new] button[type="submit"]');
  await page.waitForSelector('[data-pass-card]', { timeout: 10000 });
  await page.waitForTimeout(300);
  const hemiCard = flat(await page.textContent('[data-pass-card]'));
  check(`${size}: the pass goes on their account`, /Holder\s*Hemi Walker\s*Member/.test(hemiCard) && /hemi@example\.com/.test(hemiCard), hemiCard.slice(0, 220));
  // a typed name
  await page.click('[data-pass-back]');
  await page.waitForTimeout(300);
  await page.click('[data-pass-issue]');
  await page.waitForSelector('[data-pass-new]');
  await page.check('[data-pass-owner-pick][value="name"]', { force: true });
  await page.fill('#pass-new-label', 'Visitor pass: 2 sessions');
  await page.fill('[data-pass-new] [name="sessions"]', '2');
  await page.fill('#pass-new-name', 'Visiting Vicky');
  await page.click('[data-pass-new] button[type="submit"]');
  await page.waitForSelector('[data-pass-card]', { timeout: 10000 });
  await page.waitForTimeout(300);
  const typedCard = flat(await page.textContent('[data-pass-card]'));
  check(`${size}: a pass for a typed name`, /Holder\s*Visiting Vicky/.test(typedCard) && !/Visiting Vicky\s*Member/.test(typedCard), typedCard.slice(0, 220));
  // nobody: the form says so
  await page.click('[data-pass-back]');
  await page.waitForTimeout(300);
  await page.click('[data-pass-issue]');
  await page.waitForSelector('[data-pass-new]');
  await page.fill('#pass-new-label', 'Nobody pass');
  await page.click('[data-pass-new] button[type="submit"]');
  await page.waitForTimeout(400);
  check(`${size}: no owner picked: the form says what to do`, /Pick a group, pick a customer, or type a name\./.test(await page.textContent('[data-pass-new] [data-form-error]')), await page.textContent('[data-pass-new] [data-form-error]'));
  await page.click('[data-pass-back]');

  // ---------- check-in: a member card shows their group's pass ----------
  const sam = (await be('members', { q: 'sam', sort: 'spend' }))[0];
  await page.evaluate(() => document.querySelector('.checkin').scrollIntoView({ block: 'start' }));
  await page.fill('#checkin-code', sam.code);
  await page.click('.checkin__go');
  await page.waitForSelector('.checkin-card--member', { timeout: 10000 });
  const passes = flat(await page.textContent('.checkin-card__passes').catch(() => ''));
  check(`${size}: check-in: a member card lists their group's pass, with the group`, /Gift pack: 10 sessions QA Dice Club group/.test(passes), passes);
  if (size === 'phone') await shot(page, `${size}-checkin-group`, '.checkin-card--member');
  await page.click('[data-checkin-clear]');

  // archive the group
  await tab(page, 'groups');
  // the tab keeps the group's page open from before; back to the list, then open it again
  if (await page.isVisible('[data-group-back]')) await page.click('[data-group-back]');
  await page.locator('.sa-row', { hasText: 'QA Dice Club' }).click();
  await page.waitForSelector('[data-group-danger]');
  await page.click('[data-group-confirm="archive"]');
  const archiveAsk = flat(await page.textContent('[data-group-danger]'));
  check(`${size}: Archive asks first, and says the passes stop working for its people`, /Archive QA Dice Club\?/.test(archiveAsk) && /can’t use its passes/.test(archiveAsk), archiveAsk);
  await page.click('[data-group-status-set="archived"]');
  await page.waitForTimeout(500);
  check(`${size}: archived`, /Archived/.test(await page.textContent('[data-group-head]')) && /Bring it back/.test(await page.textContent('[data-group-danger]')));
  const archivedPass = await page.evaluate(async (code) => {
    const card = await window.Lair.store.backend.checkin({ code });
    return card.passes.map((p) => p.label);
  }, sam.code);
  check(`${size}: its people can't use its passes once it's archived`, !archivedPass.includes('Gift pack: 10 sessions'), archivedPass);
  const groupPassToArchived = await page.evaluate(async () => {
    const b = window.Lair.store.backend;
    const g = (await b.listGroups({ q: 'QA Dice Club', status: 'all' })).groups[0];
    try {
      await b.createPass({ label: 'x', sessions: 1, groupId: g.id });
      return 'made';
    } catch (e) {
      return `${e.status} ${e.message}`;
    }
  });
  check(`${size}: no new pass for an archived group (409)`, groupPassToArchived === '409 That group is archived. Pick another, or bring it back first.', groupPassToArchived);

  // ---------- loot codes ----------
  await tab(page, 'codes');
  await page.waitForSelector('.sa-code', { timeout: 10000 });
  check(`${size}: the Loot codes panel says what a loot code is`, flat(await page.textContent('staff-codes .sa-lede')) === 'Each loot code gives rolls on the loyalty card, once per customer.');
  check(`${size}: the welcome code ROLL-FOR-LOOT is there`, /ROLL-FOR-LOOT/.test(await page.textContent('[data-code-list]')));
  await page.click('[data-code-make]');
  await page.waitForSelector('[data-code-form]');
  await page.fill('#sa-code-code', 'qa-goblin-hoard');
  await page.click('[data-code-form] [data-sa-step="1"]');
  await page.fill('#sa-code-limit', '50');
  const later = await page.evaluate(() => window.Lair.store.time.addDays(window.Lair.store.time.today(), 30));
  await page.fill('#sa-code-expires', later);
  await page.fill('#sa-code-note', 'Flyers at the expo');
  if (size === 'phone') await shot(page, `${size}-codes-form`, '[data-code-form]');
  await page.click('[data-code-form] button[type="submit"]');
  await page.waitForSelector('.sa-code.is-new', { timeout: 10000 });
  const typed = flat(await page.locator('.sa-code', { hasText: 'QA-GOBLIN-HOARD' }).innerText());
  check(`${size}: a typed loot code, in capitals, with its rolls, limit and last day`, /QA-GOBLIN-HOARD/.test(typed) && /2 rolls each time/.test(typed) && /Used 0 of 50/.test(typed) && /Works until/.test(typed), typed);
  // taken: 409 beside the code
  await page.click('[data-code-make]');
  await page.fill('#sa-code-code', 'ROLL-FOR-LOOT');
  await page.click('[data-code-form] button[type="submit"]');
  await page.waitForTimeout(400);
  const taken = flat(await page.textContent('[data-code-form] [data-error-name="code"]'));
  check(`${size}: a taken code says so beside the field (409)`, taken === "That code's taken. Pick another, or leave it empty and Gobgob will make one." && (await page.getAttribute('#sa-code-code', 'aria-invalid')) === 'true', taken);
  await page.fill('#sa-code-code', 'AB');
  await page.click('[data-code-form] button[type="submit"]');
  await page.waitForTimeout(400);
  check(`${size}: a code that's too short says so beside the field (422)`, flat(await page.textContent('[data-code-form] [data-error-name="code"]')) === 'Codes are 4 to 24 letters, numbers or dashes, like ROLL-FOR-LOOT.');
  if (size === 'phone') await shot(page, `${size}-codes-422`, '[data-code-form]');
  // generated
  await page.fill('#sa-code-code', '');
  await page.click('[data-code-form] button[type="submit"]');
  await page.waitForSelector('.sa-code.is-new .sa-code__code', { timeout: 10000 });
  await page.waitForTimeout(300);
  const made = flat(await page.textContent('.sa-code.is-new .sa-code__code'));
  check(`${size}: left empty, Gobgob makes one like GG-KOBOLD-14`, /^GG-[A-Z]+-\d{1,2}$/.test(made), made);
  // edit, then set inactive
  const hoard = page.locator('.sa-code', { hasText: 'QA-GOBLIN-HOARD' });
  await hoard.locator('.sa-code__edit > summary').click();
  await hoard.locator('[data-sa-step="1"]').click();
  await hoard.locator('[name="note"]').fill('Flyers at the expo, round two');
  await hoard.locator('button[type="submit"]').click();
  await page.waitForTimeout(500);
  const editedCode = flat(await page.locator('.sa-code', { hasText: 'QA-GOBLIN-HOARD' }).innerText());
  check(`${size}: editing a loot code (rolls and note)`, /3 rolls each time/.test(editedCode) && /round two/.test(editedCode), editedCode);
  const again = page.locator('.sa-code', { hasText: 'QA-GOBLIN-HOARD' });
  await again.locator('.sa-code__edit > summary').click();
  await again.locator('[name="status"][value="inactive"]').check({ force: true });
  if (size === 'phone') await shot(page, `${size}-codes-edit`, '.sa-code >> nth=0');
  await again.locator('button[type="submit"]').click();
  await page.waitForTimeout(500);
  check(`${size}: set inactive: it leaves the Active list`, !(/QA-GOBLIN-HOARD/.test(await page.textContent('[data-code-list]'))) && /off/.test(await toast(page)), await toast(page));
  await page.check('[data-code-status][value="all"]', { force: true });
  await page.waitForTimeout(500);
  const inactive = flat(await page.locator('.sa-code', { hasText: 'QA-GOBLIN-HOARD' }).innerText().catch(() => ''));
  check(`${size}: …and shows as Inactive under All`, /Inactive/.test(inactive), inactive);
  const redeemed = await page.evaluate(async () => {
    const b = window.Lair.store.backend;
    if (typeof b.redeemCode !== 'function') return 'no redeem yet';
    return 'has redeem';
  });
  console.log(`  (My Lair's redeemCode in this theme: ${redeemed})`);

  // ---------- members: profile, gifts in words, birthdays ----------
  await tab(page, 'members');
  await page.waitForSelector('.staff-mem-row', { timeout: 10000 });
  await page.locator('.staff-mem-row', { hasText: 'Sam Tautahi' }).click();
  await page.waitForSelector('[data-person-profile]:not([hidden]) .sa-profile__facts', { timeout: 10000 });
  const profile = flat(await page.textContent('[data-person-profile]'));
  check(`${size}: a member's page shows their player profile`, /Mobile\s*021 123 4567/.test(profile) && /Pronouns\s*he\/him/.test(profile) && /Favourite games\s*Wingspan, Root/.test(profile) && /About me\s*Board game night regular/.test(profile), profile);
  check(`${size}: …the mobile is a tap to call`, (await page.getAttribute('[data-person-profile] a[href^="tel:"]', 'href')) === 'tel:0211234567');
  await page.click('[data-person-card] [data-gift-open]');
  await page.waitForSelector('[data-gift-form]');
  check(`${size}: the gift form's rolls start at 0`, (await page.inputValue('[data-gift-form] [name="rolls"]')) === '0' && !/each year with us/.test(await page.textContent('#gift-rolls-hint')), await page.textContent('#gift-rolls-hint'));
  await page.fill('#gift-credit', '20');
  await page.fill('[data-gift-form] [name="rolls"]', '5');
  await page.fill('#gift-product', 'wing');
  await page.waitForSelector('[data-gift-pick]', { timeout: 8000 });
  await page.locator('[data-gift-pick]').first().click();
  await page.waitForSelector('[data-gift-unpick]', { timeout: 8000 });
  await page.click('[data-gift-form] button[type="submit"]');
  await page.waitForSelector('.staff-gift--done', { timeout: 10000 });
  await page.click('.staff-gift--done [data-member-view]');
  await page.waitForSelector('[data-person-gifts] .staff-gifts__item', { timeout: 10000 });
  const gifts = flat(await page.textContent('[data-person-gifts]'));
  check(`${size}: a member's gifts say what they were, in words`, /\$20 store credit, 5 rolls, Wingspan \(code HBD-[A-Z0-9-]+, until \d+ \w{3}\)/.test(gifts) && !/has had a birthday gift this year\./.test(gifts), gifts);
  if (size === 'phone') await shot(page, `${size}-member-page`, '.staff-person');
  const words = await page.evaluate(async (id) => (await window.Lair.store.backend.members({ q: id }))[0].giftsThisYear.map((g) => g.words), sam.customerId);
  check(`${size}: the members list sends this year's gifts in words`, words.some((w) => /^\$20 store credit, 5 rolls, Wingspan \(code HBD-/.test(w)), words);
  const detail = await page.evaluate(async (id) => (await window.Lair.store.backend.memberDetail(id)).member, sam.customerId);
  check(`${size}: memberDetail: profile, every gift with its state, and library`, detail.pronouns === 'he/him' && detail.gifts.length >= 1 && detail.gifts[0].state === 'ready' && detail.gifts[0].product.status === 'ready' && detail.library && Array.isArray(detail.library.holds), { pronouns: detail.pronouns, gift: detail.gifts[0] });
  const missing = await page.evaluate(async () => {
    try {
      await window.Lair.store.backend.memberDetail('999');
      return 'found';
    } catch (e) {
      return `${e.status} ${e.message}`;
    }
  });
  check(`${size}: memberDetail of nobody is the 404`, missing === '404 No member with that customer ID.', missing);
  // Issue a pass from their page: the form opens on them, their name and email filled in
  await page.click('[data-person-card] [data-member-pass]');
  await page.waitForSelector('[data-pass-new]');
  await page.waitForFunction(() => document.querySelector('#pass-new-cname')?.value, null, { timeout: 5000 }).catch(() => {});
  const prefill = await page.evaluate(() => ({ owner: document.querySelector('[data-pass-owner-pick]:checked')?.value, name: document.querySelector('#pass-new-cname').value, email: document.querySelector('#pass-new-cemail').value }));
  check(`${size}: "Issue a pass" on a member's page opens on that customer`, prefill.owner === 'customer' && prefill.name === 'Sam Tautahi' && prefill.email === 'sam@example.com', prefill);
  await page.click('[data-pass-back]');
  await tab(page, 'members');
  await page.click('[data-members-back]');
  await page.waitForSelector('[data-birthdays] .staff-birthday', { timeout: 10000 });
  const bdays = await page.$$eval('[data-birthdays] .staff-birthday__meta', (els) => els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()));
  check(`${size}: birthdays coming up suggest no rolls, and say how long they've been with us`, bdays.length > 0 && !bdays.some((b) => /\d+ rolls?\b/.test(b)) && bdays.some((b) => /with us/.test(b)), bdays);
  const sugg = await page.evaluate(async () => (await window.Lair.store.backend.birthdays()).map((b) => b.suggested.rolls));
  check(`${size}: the birthdays list's suggested.rolls is always 0`, sugg.length > 0 && sugg.every((r) => r === 0), sugg);
  const arohaGift = flat(await page.locator('[data-birthdays] .staff-birthday', { hasText: 'Aroha' }).innerText().catch(() => ''));
  check(`${size}: a birthday who's had a gift says what it was`, /\$15 store credit, 2 sessions on pass [A-Z]{2}-[A-Z]+-\d+/.test(arohaGift), arohaGift);
  if (size === 'phone') await shot(page, `${size}-birthdays`, '[data-birthdays]');
  await page.locator('[data-birthdays] [data-gift-open]').first().click();
  await page.waitForSelector('[data-gift-form]');
  check(`${size}: from the birthdays list too, the gift's rolls start at 0`, (await page.inputValue('[data-gift-form] [name="rolls"]')) === '0');
  await page.click('[data-gift-back]');

  // ---------- every tab: no sideways scroll ----------
  const wide = [];
  for (const id of ['floor', 'today', 'passes', 'groups', 'members', 'codes', 'holds', 'games', 'events', 'library']) {
    await tab(page, id);
    await page.waitForTimeout(250);
    const over = await overflow(page);
    if (over > 0) wide.push(`${id}: ${over}`);
  }
  check(`${size}: no tab scrolls sideways`, !wide.length, wide);
  check(`${size}: no console errors`, !page.errors.length, page.errors.slice(0, 4));
  await ctx.close();

  // ---------- Shopify hasn't allowed writes yet: the 503, plainly ----------
  {
    const denied = await open(size, '/pages/lair-staff?eventwrite=denied#events');
    await denied.page.waitForSelector('.sa-event', { timeout: 10000 });
    await denied.page.click('[data-event-new]');
    await denied.page.fill('#sa-ev-title', 'QA blocked event');
    await denied.page.selectOption('#sa-ev-type', 'social');
    await denied.page.fill('#sa-ev-date', first);
    await denied.page.click('[data-event-form] button[type="submit"]');
    await denied.page.waitForTimeout(500);
    const msg = flat(await denied.page.textContent('[data-event-form] [data-form-error]'));
    check(`${size}: before Shopify allows writes, saving says so plainly (503)`, msg === "Shopify hasn't let the Lair change events yet. Approve the app's new permissions in Shopify admin (Apps › Dice Goblin Lair), then try again.", msg);
    if (size === 'phone') await shot(denied.page, `${size}-events-503`, '[data-event-form] [data-form-error]');
    check(`${size}: …no console errors there either`, !denied.page.errors.length, denied.page.errors.slice(0, 3));
    await denied.ctx.close();
  }
}

console.log(`staff-admin: ${pass} passed, ${fail} failed`);
await browser.close();
server.close();
process.exitCode = fail ? 1 : 0;

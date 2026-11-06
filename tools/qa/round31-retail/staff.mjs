// Round 31, retail (contract v31-retail, sections 3 and 4): the staff page's To pull and Open a display tabs, end to end
// on the demo, at 320, 390 and 1280px with the page's clock at 6pm on a Friday (the shop's open). To pull: the tab's
// count and the page's title, the card (what, who, promised by), Ready to collect, a new order coming in (the chime, the
// note), Not on the shelf (which lines, then Refund due and Done), Behind the counter and Refund due. Open a display:
// search, the box and packs picked from the options' names, before and after, the packs remembered, and Undo.
// DG_THEME=/path/to/theme PORT=4964 [OUT=dir] node tools/qa/round31-retail/staff.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node-tools/node_modules/playwright'));
}
const HERE = path.dirname(new URL(import.meta.url).pathname);
const m = await import(path.join(HERE, '../theme-mock/render.mjs'));
m.globalSettings.lair_mode = 'demo';
m.globalSettings.retail_holds = false; // step 1 as it goes live on its own (holds.mjs has step 2)
m.globalSettings.lair_hours = 'Mon 16:00-24:00\nTue 16:00-24:00\nWed 16:00-24:00\nThu 16:00-24:00\nFri 16:00-24:00\nSat 10:00-24:00\nSun 10:00-22:00';
const PORT = Number(process.env.PORT || 4964);
const OUT = process.env.OUT || null;
if (OUT) fs.mkdirSync(OUT, { recursive: true });
m.serve(PORT);
const base = `http://localhost:${PORT}`;
const STAFF = { id: 7001, first_name: 'Mo', last_name: 'Ashgrove', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };

// 6pm on the coming Friday in Auckland (the shop opens at 4pm)
const TZ = 'Pacific/Auckland';
const keyOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const dayOf = (ms) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, weekday: 'short' }).format(new Date(ms));
let friday = Date.now();
while (dayOf(friday) !== 'Fri') friday += 24 * 3600000;
const KEY = keyOf(friday);
const offset = new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${KEY}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const AT = Date.parse(`${KEY}T18:00:00${offset}`);
const CLOCK = `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;
// the chime: count the notes it starts (an AudioContext that's always allowed to play)
const SOUND = `(() => { window.__notes = 0; const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
  const make = Ctx.prototype.createOscillator; Ctx.prototype.createOscillator = function () { window.__notes += 1; return make.call(this); }; })();`;

let passed = 0;
const failed = [];
const check = (ok, what) => {
  if (ok) passed += 1;
  else failed.push(what);
};
const text = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
for (const width of [320, 390, 1280]) {
  const ctx = await browser.newContext({ viewport: { width, height: width > 1000 ? 900 : 844 } });
  await ctx.addInitScript(CLOCK);
  await ctx.addInitScript(SOUND);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()); });
  m.mockState.customer = STAFF;
  await page.goto(`${base}/pages/lair-staff`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/pages/lair-staff`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-tab="pull"]', { timeout: 15000 }).catch(() => null);
  await page.waitForTimeout(600);

  /* ---------- the tabs ---------- */
  const tabs = await page.locator('[role="tab"]').evaluateAll((els) => els.map((el) => el.dataset.tab));
  check(tabs[tabs.indexOf('today') + 1] === 'pull', `${width} To pull comes after Bookings: ${tabs.join(',')}`);
  check(tabs.indexOf('stock') > -1 && tabs.indexOf('stock') === tabs.indexOf('warhammer') - 1, `${width} Stock (Open a display) comes before Warhammer: ${tabs.join(',')}`);
  check(text(await page.locator('[data-tab="pull"]').innerText()) === 'To pull 1', `${width} the tab counts 1 to pull: ${await page.locator('[data-tab="pull"]').innerText()}`);
  check(/^\(1\) /.test(await page.title()), `${width} the title says (1): ${await page.title()}`);

  /* ---------- To pull ---------- */
  await page.locator('[data-tab="pull"]').click();
  await page.waitForTimeout(300);
  const card = page.locator('[data-pull-card="5001"]');
  const cardText = text(await card.innerText());
  check(cardText.includes('Online pickup #2031') && cardText.includes('Paid') && cardText.includes('Riftbound Radiance: Booster Box × 1'), `${width} the card: ${cardText}`);
  check(/For Sam K\. · ordered 5:38pm/.test(cardText), `${width} who and when: ${cardText}`);
  check(/Promised by 7:38pm · 1 hr 38 min left/.test(cardText), `${width} promised by: ${cardText}`);
  check(text(await page.locator('[data-pull-new]').innerText()) === '1 new', `${width} 1 new`);
  check(await page.locator('[data-pull-chime]').isChecked(), `${width} the chime is on to start`);
  const behind = text(await page.locator('.spull-rows').innerText());
  check(behind.includes('Pickup #2028 · Gundam Card Game - Freedom Ascension: Booster Box × 1') && behind.includes('Ready') && behind.includes('Jo T. · waiting 3 days · reminded once'), `${width} behind the counter: ${behind}`);
  const refund = text(await page.locator('[data-pull-card="5003"]').innerText());
  check(refund.includes('Refund due') && refund.includes('Not collected in 2 weeks') && refund.includes('Restock ticked') && refund.includes('Done'), `${width} refund due: ${refund}`);
  if (OUT && width !== 320) await page.screenshot({ path: `${OUT}/staff-pull-${width}.png`, fullPage: true });

  // Ready to collect: off the list to pull, onto Behind the counter, the count and the title clear
  await card.locator('[data-pull-ready]').click();
  await page.waitForTimeout(400);
  check(!(await page.locator('[data-pull-card="5001"]').count()), `${width} #2031 left the list to pull`);
  check(text(await page.locator('.spull-rows').innerText()).includes('Pickup #2031'), `${width} #2031 is behind the counter`);
  check(text(await page.locator('[data-tab="pull"]').innerText()) === 'To pull', `${width} the tab's count cleared`);
  check(!/^\(\d+\)/.test(await page.title()), `${width} the title cleared: ${await page.title()}`);
  check(text(await page.locator('.spull-none').innerText()) === 'Nothing to pull right now.', `${width} nothing to pull`);
  check(/#2031 is ready\. Shopify emails Sam K\. to come and get it\./.test(text(await page.locator('lair-staff').innerText())), `${width} the note says Shopify emails them`);

  // a new order comes in: the chime, the note, the count
  const before = await page.evaluate(() => window.__notes);
  await page.locator('[data-pull-try]').click();
  await page.waitForTimeout(500);
  const fresh = page.locator('.spull-card:not(.spull-card--refund)').first();
  const freshText = text(await fresh.innerText());
  check(/Online pickup #2035/.test(freshText) && /For Lee W\./.test(freshText) && /Promised by 8pm · 2 hr left/.test(freshText), `${width} the new one: ${freshText}`);
  check((await page.evaluate(() => window.__notes)) - before === 2, `${width} it chimed (two notes): ${(await page.evaluate(() => window.__notes)) - before}`);
  check(/New online pickup to pull: #2035, for Lee W\./.test(text(await page.locator('lair-staff').innerText())), `${width} the note for the new one`);
  check(text(await page.locator('[data-tab="pull"]').innerText()) === 'To pull 1' && /^\(1\) /.test(await page.title()), `${width} counted again`);

  // Not on the shelf: asks first, then Refund due with what to do, then Done
  await fresh.locator('[data-pull-missing]').click();
  await page.waitForTimeout(200);
  const ask = text(await page.locator('.spull-ask').innerText());
  check(ask.includes('Gobgob emails Lee W. straight away to say sorry') && ask.includes('Yes, email Lee W.') && ask.includes('Back'), `${width} asks first: ${ask}`);
  check(await page.evaluate(() => document.activeElement && document.activeElement.matches('[data-pull-missing-yes]')), `${width} the focus is on Yes`);
  await page.locator('[data-pull-back]').click();
  await page.waitForTimeout(150);
  check(!(await page.locator('.spull-ask').count()) && await page.evaluate(() => document.activeElement && document.activeElement.matches('[data-pull-missing]')), `${width} Back puts it back`);
  await page.locator('.spull-card:not(.spull-card--refund) [data-pull-missing]').first().click();
  await page.locator('[data-pull-missing-yes]').click();
  await page.waitForTimeout(400);
  const gone = text(await page.locator('.spull-card--refund', { hasText: '#2035' }).innerText());
  check(gone.includes('Refund due') && gone.includes('Lee W. has been emailed') && gone.includes('Restock unticked'), `${width} refund due after Not on the shelf: ${gone}`);
  await page.locator('.spull-card--refund', { hasText: '#2035' }).locator('[data-pull-done]').click();
  await page.waitForTimeout(400);
  check(!(await page.locator('.spull-card--refund', { hasText: '#2035' }).count()), `${width} Done takes it off`);

  // the chime off: a new one doesn't chime (on this device, kept)
  await page.locator('[data-pull-chime]').uncheck();
  const quiet = await page.evaluate(() => window.__notes);
  await page.locator('[data-pull-try]').click();
  await page.waitForTimeout(500);
  check((await page.evaluate(() => window.__notes)) === quiet, `${width} no chime when it's off`);
  check(await page.evaluate(() => localStorage.getItem('dg-staff-chime')) === 'off', `${width} the chime's off is kept`);
  check(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, `${width} To pull: no sideways scroll`);
  // the review (6 Nov 2026): when Shopify didn't take the count of 0, the card says what to do, and so does the note
  await page.evaluate(() => {
    const api = window.Lair.store.backend;
    const real = api.pullMissing.bind(api);
    api.pullMissing = async (...a) => ({ ...(await real(...a)), warning: "Shopify didn't take the new count. Set Dragon Shield Matte Sleeves: Jet to 0 in Shopify yourself, so the website stops selling it." });
  });
  await page.locator('.spull-card:not(.spull-card--refund) [data-pull-missing]').first().click();
  await page.locator('[data-pull-missing-yes]').click();
  await page.waitForTimeout(400);
  const warned = text(await page.locator('.spull-card--refund', { hasText: '#2036' }).innerText());
  check(warned.includes("Shopify didn't take the new count. Set Dragon Shield Matte Sleeves: Jet to 0 in Shopify yourself"), `${width} the count warning on the card: ${warned}`);

  /* ---------- Open a display ---------- */
  await page.locator('[data-tab="stock"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-disp-q]').fill('night city');
  await page.waitForSelector('[data-disp-pick]', { timeout: 4000 }).catch(() => null);
  const result = text(await page.locator('[data-disp-pick]').first().innerText());
  check(result.includes('Cyberpunk TCG - Welcome to Night City - Booster') && result.includes('Booster Box: 45 · Booster Pack: 25'), `${width} the search finds it: ${result}`);
  await page.locator('[data-disp-pick]').first().click();
  await page.waitForTimeout(250);
  check(await page.locator('[data-disp-find]').isHidden(), `${width} the search hides once picked`);
  check(await page.locator('[data-disp-box] option:checked').innerText() === 'Booster Box (45 on the shelf)' && await page.locator('[data-disp-pack] option:checked').innerText() === 'Booster Pack (25 on the shelf)', `${width} the box and packs guessed from their names`);
  check(text(await page.locator('[data-disp-label]').innerText()) === 'Booster Boxes to open', `${width} the stepper's label`);
  check(await page.locator('[data-disp-packs]').inputValue() === '' && text(await page.locator('#sdisp-packs-hint').innerText()) === 'Remembered for this product after the first time.', `${width} packs empty the first time`);
  await page.locator('[data-disp-go]').click();
  await page.waitForTimeout(200);
  check(text(await page.locator('[data-disp-error]').innerText()) === 'A box holds between 1 and 100 packs.', `${width} asks for the packs: ${await page.locator('[data-disp-error]').innerText()}`);
  await page.locator('[data-disp-packs]').fill('36');
  await page.waitForTimeout(100);
  const ba = text(await page.locator('[data-disp-ba]').innerText());
  check(/Booster Box 45 → after: 44/.test(ba) && /Booster Pack 25 → after: 61/.test(ba), `${width} before and after: ${ba}`);
  check(await page.locator('[data-disp-error]').isHidden(), `${width} the error goes once it's right`);
  await page.locator('[data-disp-step="1"]').click();
  check(/Booster Pack 25 → after: 97/.test(text(await page.locator('[data-disp-ba]').innerText())), `${width} two boxes: 97 packs`);
  await page.locator('[data-disp-step="-1"]').click();
  if (OUT && width !== 320) await page.screenshot({ path: `${OUT}/staff-display-${width}.png`, fullPage: true });
  await page.locator('[data-disp-go]').click();
  await page.waitForTimeout(400);
  check(/Done: 1 Booster Box off, 36 Booster Packs on\./.test(text(await page.locator('lair-staff').innerText())), `${width} the note says what changed`);
  check(await page.locator('[data-disp-box] option:checked').innerText() === 'Booster Box (44 on the shelf)' && await page.locator('[data-disp-pack] option:checked').innerText() === 'Booster Pack (61 on the shelf)', `${width} the counts moved`);
  check(await page.locator('[data-disp-packs]').inputValue() === '36' && /Remembered from last time/.test(await page.locator('#sdisp-packs-hint').innerText()), `${width} the packs are remembered`);
  const opened = text(await page.locator('.sdisp-open').first().innerText());
  check(opened.includes('1 box opened, 36 packs on the shelf') && opened.includes('Box 45 → 44 · Packs 25 → 61') && opened.includes('Undo'), `${width} opened in the last day: ${opened}`);
  // pick it again from a new search: what was used is remembered
  await page.locator('[data-disp-change]').click();
  await page.locator('[data-disp-q]').fill('cyberpunk');
  await page.waitForTimeout(700);
  await page.locator('[data-disp-pick]').first().click();
  await page.waitForTimeout(200);
  check(await page.locator('[data-disp-packs]').inputValue() === '36', `${width} remembered on a new search`);
  // Undo: asks, then puts it back
  await page.locator('[data-disp-undo]').first().click();
  check(text(await page.locator('.sdisp-open .staff-confirm').innerText()).startsWith('Put the box back on and take 36 packs off?'), `${width} Undo asks first`);
  await page.locator('[data-disp-undo-yes]').click();
  await page.waitForTimeout(600);
  check(text(await page.locator('.sdisp-open').first().innerText()).includes('Put back. The box is on again and its packs are off.'), `${width} put back`);
  check(await page.locator('[data-disp-box] option:checked').innerText() === 'Booster Box (45 on the shelf)', `${width} the form's counts are back: ${await page.locator('[data-disp-box] option:checked').innerText()}`);
  // the review (6 Nov 2026): a lost answer tried again with the same numbers keeps its key; other numbers get a new one
  await page.evaluate(() => {
    const api = window.Lair.store.backend;
    const real = api.displayOpen.bind(api);
    window.__keys = [];
    window.__fail = 1;
    api.displayOpen = async (input) => {
      window.__keys.push(input.key);
      if (window.__fail > 0) {
        window.__fail -= 1;
        throw new TypeError('Failed to fetch');
      }
      return real(input);
    };
  });
  await page.locator('[data-disp-go]').click();
  await page.waitForTimeout(250);
  await page.locator('[data-disp-go]').click();
  await page.waitForTimeout(400);
  let keys = await page.evaluate(() => window.__keys);
  check(keys.length === 2 && keys[0] === keys[1], `${width} the same numbers again: the same key ${JSON.stringify(keys)}`);
  await page.evaluate(() => { window.__keys = []; window.__fail = 1; });
  await page.locator('[data-disp-go]').click();
  await page.waitForTimeout(250);
  await page.locator('[data-disp-step="1"]').click();
  await page.locator('[data-disp-go]').click();
  await page.waitForTimeout(400);
  keys = await page.evaluate(() => window.__keys);
  check(keys.length === 2 && keys[0] !== keys[1], `${width} other numbers: a new key ${JSON.stringify(keys)}`);
  check(/Done: 2 Booster Boxes off, 72 Booster Packs on\./.test(text(await page.locator('lair-staff').innerText())), `${width} the note says what was opened`);
  check(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, `${width} Open a display: no sideways scroll`);

  check(!errors.length, `${width} no script errors: ${errors.join(' | ')}`);
  await ctx.close();
}
await browser.close();
console.log(`${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log(`FAIL ${f}`);
process.exit(failed.length ? 1 : 0);

// Round 31, retail, step 2 (contract v31-retail, sections 5 and 6): free holds and an empty search's "Tell us what you're
// after", end to end on the demo, at 320, 390 and 1280px with the page's clock at 6pm on a Friday (the shop's open).
// Product page: Hold it free opens the sheet (what, price, kept till, pay at the counter), Hold it for me holds it and
// the card says so; logged out it's Log in to hold it (and back with ?hold=1); three held is the limit; a card release
// in its first week says when holds start. My Lair: Held for you, 3 of 3, Cancel (asks first). Staff page: To pull's
// free holds (Set aside, Not on the shelf, Collected, a new one chimes), and Stock's Asked for. Search: nothing found
// says it's not on the shelf, and the box sends what they're after (it shows on Stock).
// DG_THEME=/path/to/theme PORT=4972 [OUT=dir] node tools/qa/round31-retail/holds.mjs
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
m.globalSettings.wishlist_enabled = true;
m.globalSettings.retail_holds = true;
m.globalSettings.lair_hours = 'Mon 16:00-24:00\nTue 16:00-24:00\nWed 16:00-24:00\nThu 16:00-24:00\nFri 16:00-24:00\nSat 10:00-24:00\nSun 10:00-22:00';
const PORT = Number(process.env.PORT || 4972);
const OUT = process.env.OUT || null;
if (OUT) fs.mkdirSync(OUT, { recursive: true });
m.serve(PORT);
const base = `http://localhost:${PORT}`;
const RUBY = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', tags: [], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const STAFF = { id: 7001, first_name: 'Mo', last_name: 'Ashgrove', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };

// 6pm on the coming Friday in Auckland (the shop opens at 4pm): a hold made now is kept till midnight Saturday
const TZ = 'Pacific/Auckland';
const keyOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const dayOf = (ms) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, weekday: 'short' }).format(new Date(ms));
let friday = Date.now();
while (dayOf(friday) !== 'Fri') friday += 24 * 3600000;
const KEY = keyOf(friday);
const offset = new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${KEY}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const AT = Date.parse(`${KEY}T18:00:00${offset}`);
const SATURDAY = new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).formatToParts(new Date(AT + 24 * 3600000));
const SAT = `${SATURDAY.find((p) => p.type === 'weekday').value} ${SATURDAY.find((p) => p.type === 'day').value} ${SATURDAY.find((p) => p.type === 'month').value}`;
const CLOCK = `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;
const SOUND = `(() => { window.__notes = 0; const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
  const make = Ctx.prototype.createOscillator; Ctx.prototype.createOscillator = function () { window.__notes += 1; return make.call(this); }; })();`;
// a card release from two days ago: no holds in its first week
m.allProducts['cyberpunk-tcg-welcome-to-night-city-booster'].published_at = new Date(AT - 2 * 24 * 3600000).toISOString();

let passed = 0;
const failed = [];
const check = (ok, what) => {
  if (ok) passed += 1;
  else failed.push(what);
};
const text = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
// one width; a step that times out is a failure, not the end of the run
const run = async (width) => {
  const ctx = await browser.newContext({ viewport: { width, height: width > 1000 ? 900 : 844 } });
  await ctx.addInitScript(CLOCK);
  await ctx.addInitScript(SOUND);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()); });
  const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  /* ---------- logged out: Log in to hold it, which comes back with ?hold=1 ---------- */
  m.mockState.customer = null;
  await page.goto(`${base}/products/riftbound-radiance`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/products/riftbound-radiance`, { waitUntil: 'networkidle' });
  const row = page.locator('[data-lair-card-hold]');
  check(text(await row.innerText()).startsWith('Hold it free Kept till midnight Saturday. Pay at the counter.'), `${width} the hold row: ${await row.innerText()}`);
  await page.locator('[data-lair-card-hold-button]').click();
  await page.waitForTimeout(200);
  const sheet = page.locator('dialog[data-lair-hold]');
  check(await sheet.isVisible(), `${width} the sheet opens`);
  check(text(await sheet.innerText()).includes("Log in to hold it. Shopify emails you a code, so there's no password to remember."), `${width} logged out: ${await sheet.innerText()}`);
  const login = await sheet.locator('a.button').getAttribute('href');
  check(/^\/customer_authentication\/login\?return_to=%2Fproducts%2Friftbound-radiance%3Fvariant%3D\d+%26hold%3D1$/.test(login || ''), `${width} the login comes back with hold=1: ${login}`);
  await page.keyboard.press('Escape');

  /* ---------- logged in: the sheet, Hold it for me, the card says so ---------- */
  m.mockState.customer = RUBY;
  await page.goto(`${base}/products/riftbound-radiance?hold=1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  check(await sheet.isVisible() && !page.url().includes('hold=1'), `${width} back with ?hold=1: the sheet's open and the address lost it`);
  const form = text(await sheet.innerText());
  check(form.includes('Riftbound Radiance: Booster Box') && form.includes('$240.00'), `${width} what and its price: ${form}`);
  check(form.includes(`Kept till midnight ${SAT}, then back on the shelf`), `${width} kept till: ${form}`);
  check(form.includes('Pay $240.00 at the counter when you collect it. Nothing to pay now.') && form.includes('Staff scan your member code.') && form.includes('Gobgob will guard it behind the counter.'), `${width} the sheet's words: ${form}`);
  check(form.includes('You can hold up to 3 things at a time. Changed your mind? Cancel it in My Lair.'), `${width} the small print`);
  check(await page.evaluate(() => document.activeElement && document.activeElement.matches('[data-hold-go]')), `${width} the focus is on Hold it for me`);
  if (OUT && width !== 320) await page.screenshot({ path: `${OUT}/hold-sheet-${width}.png` });
  await sheet.locator('[data-hold-go]').click();
  await page.waitForTimeout(400);
  const done = text(await sheet.innerText());
  check(done.includes(`Held for you till midnight ${SAT}. Gobgob's on guard.`) && done.includes('See it in My Lair'), `${width} held: ${done}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check(text(await row.innerText()).startsWith(`Held for you till midnight ${SAT} See it`), `${width} the card's row says it's held: ${await row.innerText()}`);
  check(await page.evaluate(() => document.activeElement && document.activeElement.matches('[data-lair-card-hold] a')), `${width} the focus is back on the row`);
  // the pack: the row follows the option picked, and it's held too
  await page.locator('label.chip', { hasText: 'Booster Pack' }).click();
  await page.waitForTimeout(150);
  check(text(await row.innerText()).startsWith('Hold it free'), `${width} another option: Hold it free again: ${await row.innerText()}`);
  await page.locator('[data-lair-card-hold-button]').click();
  await page.waitForTimeout(300);
  await sheet.locator('[data-hold-go]').click();
  await page.waitForTimeout(300);
  check(text(await sheet.innerText()).includes('Riftbound Radiance: Booster Pack') && text(await sheet.innerText()).includes('Held for you till'), `${width} the pack held: ${await sheet.innerText()}`);
  await page.keyboard.press('Escape');
  await page.locator('label.chip', { hasText: 'Booster Box' }).click();
  await page.waitForTimeout(150);
  check(text(await row.innerText()).startsWith('Held for you till'), `${width} back on the box: held: ${await row.innerText()}`);
  // a third, held elsewhere; then the dice on the Lair's shelf: three is the limit
  await page.evaluate(() => window.Lair.store.backend.makeShopHold({ productId: '1', variantId: '999', title: 'Catan' }));
  await page.goto(`${base}/products/porcelain-blossom-d20-33mm`, { waitUntil: 'networkidle' });
  await page.locator('[data-lair-card-hold-button]').click();
  await page.waitForTimeout(300);
  const full = text(await sheet.innerText());
  check(full.includes("You're holding 3 things already. Collect one, or cancel one in My Lair, to hold this.") && full.includes('See your holds'), `${width} three is the limit: ${full}`);
  await page.keyboard.press('Escape');
  await page.goto(`${base}/products/blossom-sky-dice-set`, { waitUntil: 'networkidle' });
  check(!(await page.locator('[data-lair-card-hold]').isVisible()), `${width} the supplier's dice not at the Lair: no hold`);
  check((await sideways()) <= 0, `${width} product page: no sideways scroll`);

  // a card release in its first week: no Hold it, and when holds start
  await page.goto(`${base}/products/cyberpunk-tcg-welcome-to-night-city-booster`, { waitUntil: 'networkidle' });
  const release = text(await page.locator('lair-card').innerText());
  check(!(await page.locator('[data-lair-card-hold]').count()) && /New this week/.test(release) && /Free holds start \w+day \d{1,2} \w+\. New card releases skip holds in their first week, so everyone gets a fair go\. Collect it free in the meantime\./.test(release), `${width} a release: ${release}`);

  /* ---------- My Lair: Held for you ---------- */
  await page.goto(`${base}/pages/my-lair`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.mlh-list', { timeout: 8000 }).catch(() => null);
  const card = page.locator('#ml-holds');
  check(await card.isVisible(), `${width} Held for you shows`);
  check(text(await card.locator('[data-mlh-count]').innerText()) === '3 of 3', `${width} 3 of 3: ${await card.locator('[data-mlh-count]').innerText()}`);
  const items = await card.locator('.mlh-item').evaluateAll((els) => els.map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
  check(items.some((i) => i.startsWith('Riftbound Radiance: Booster Box Held till midnight Sat Pay $240 at the counter when you collect it.')), `${width} the box: ${JSON.stringify(items)}`);
  check(items.some((i) => i.startsWith('Catan Held till midnight Sat')), `${width} the third: ${JSON.stringify(items)}`);
  check(text(await card.innerText()).includes('Show your Goblin card at the counter. Staff scan it and your hold goes straight into the sale.'), `${width} how it's collected`);
  await card.locator('.mlh-item', { hasText: 'Booster Pack' }).locator('[data-mlh-cancel]').click();
  check(text(await card.locator('.mlh-ask').innerText()).startsWith('Cancel it? It goes back on the shelf for someone else.'), `${width} Cancel asks first`);
  await card.locator('[data-mlh-yes]').click();
  await page.waitForTimeout(300);
  check((await card.locator('.mlh-item').count()) === 2 && text(await card.innerText()).includes("Hold cancelled. It's back on the shelf for someone else.") && text(await card.locator('[data-mlh-count]').innerText()) === '2 of 3', `${width} cancelled: ${await card.innerText()}`);
  check((await sideways()) <= 0, `${width} My Lair: no sideways scroll`);
  if (OUT && width !== 320) await card.screenshot({ path: `${OUT}/hold-mylair-${width}.png` });

  /* ---------- search: nothing found, Tell us what you're after ---------- */
  await page.goto(`${base}/search?q=pitch+black`, { waitUntil: 'networkidle' });
  const empty = text(await page.locator('.search-page .empty-state').innerText());
  check(empty.startsWith('Not on the shelf right now') && empty.includes('Gobgob checked every pile for “pitch black”. Nothing on the shelf today.'), `${width} nothing found: ${empty}`);
  check(await page.locator('#search-ask-text').inputValue() === 'pitch black', `${width} the box has what they searched`);
  await page.locator('#search-ask-email').fill('ruby@example.com');
  await page.locator('[data-ask-send]').click();
  await page.waitForTimeout(300);
  check(text(await page.locator('.search-ask__thanks').innerText()) === "Thanks! Staff read every one at the counter, and we'll email you if we can get it in.", `${width} thanks: ${await page.locator('.search-ask').innerText()}`);
  check((await sideways()) <= 0, `${width} search: no sideways scroll`);
  if (OUT && width !== 320) await page.screenshot({ path: `${OUT}/search-ask-${width}.png`, fullPage: true });

  /* ---------- the staff page: To pull's free holds, and Stock's Asked for ---------- */
  m.mockState.customer = STAFF;
  await page.goto(`${base}/pages/lair-staff`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-tab="pull"]', { timeout: 15000 }).catch(() => null);
  await page.waitForTimeout(500);
  // the pickup, Ana's hold, and Ruby's two (the box and Catan) from earlier
  check(text(await page.locator('[data-tab="pull"]').innerText()) === 'To pull 4', `${width} the tab counts the pickup and the holds to set aside: ${await page.locator('[data-tab="pull"]').innerText()}`);
  const pullText = text(await page.locator('[data-pull-body]').textContent());
  check(pullText.includes('For Ruby T.'), `${width} Ruby's hold, by her short name: ${pullText.slice(0, 400)}`);
  await page.locator('[data-tab="pull"]').click();
  await page.waitForTimeout(300);
  const ana = page.locator('[data-free-hold="1"]');
  const anaText = text(await ana.innerText());
  check(anaText.includes('Free hold') && anaText.includes('Pays at the counter') && anaText.includes('One Piece - Starter Deck: Captain Kidd × 1') && /For Ana P\. · \$30 · held 5:38pm/.test(anaText) && /Kept till midnight (tomorrow|\w+day)/.test(anaText), `${width} Ana's hold: ${anaText}`);
  const behind = text(await page.locator('.spull-rows').first().innerText());
  check(behind.includes('Hold · Mooki Island') && behind.includes('Set aside') && /Jo T\. · kept till/.test(behind) && behind.includes('Collected'), `${width} Jo's behind the counter: ${behind}`);
  if (OUT && width !== 320) await page.screenshot({ path: `${OUT}/staff-holds-${width}.png`, fullPage: true });
  await ana.locator('[data-free-hold-set]').click();
  await page.waitForTimeout(400);
  check(!(await page.locator('[data-free-hold="1"]').count()) && text(await page.locator('.spull-rows').first().innerText()).includes('Hold · One Piece - Starter Deck: Captain Kidd'), `${width} set aside: behind the counter`);
  check(text(await page.locator('[data-tab="pull"]').innerText()) === 'To pull 3', `${width} counted down`);
  await page.locator('.spull-row', { hasText: 'One Piece' }).locator('[data-free-hold-collected]').click();
  await page.waitForTimeout(400);
  check(!text(await page.locator('[data-pull-body]').innerText()).includes('One Piece'), `${width} collected: off the list`);
  // a new hold comes in: the chime and the note
  const before = await page.evaluate(() => window.__notes);
  await page.locator('[data-pull-try-hold]').click();
  await page.waitForTimeout(500);
  check((await page.evaluate(() => window.__notes)) - before === 2, `${width} a new hold chimes`);
  check(/New free hold to set aside: .+, for .+/.test(text(await page.locator('lair-staff').innerText())), `${width} the note for a new hold`);
  // Not on the shelf, on the new one: asks first, then it's gone
  const cards = await page.locator('[data-free-hold]').evaluateAll((els) => els.map((el) => el.getAttribute('data-free-hold')));
  const newest = String(Math.max(...cards.map(Number)));
  check(cards.length === 3, `${width} the new hold joins Ruby's two: ${cards.join(', ')}`);
  const fresh = page.locator(`[data-free-hold="${newest}"]`);
  await fresh.locator('[data-free-hold-missing]').click();
  const asking = text(await fresh.locator('.staff-confirm').innerText());
  check(asking.includes('emails') && asking.includes('nothing to pay'), `${width} Not on the shelf asks first: ${asking}`);
  await fresh.locator('[data-free-hold-missing-yes]').click();
  await page.waitForTimeout(400);
  check(!(await page.locator(`[data-free-hold="${newest}"]`).count()), `${width} not on the shelf: gone`);
  check((await sideways()) <= 0, `${width} staff To pull: no sideways scroll`);
  // Stock: Asked for, with Ruby's from the search
  await page.locator('[data-tab="stock"]').click();
  await page.waitForTimeout(400);
  const asked = text(await page.locator('staff-requests').innerText());
  check(asked.includes('Asked for') && asked.includes('pitch black') && asked.includes('Email ruby@example.com') && asked.includes('Ruby Tane'), `${width} Asked for: ${asked}`);
  check(text(await page.locator('[data-tab="stock"]').innerText()).startsWith('Stock'), `${width} the Stock tab`);
  const doneButtons = await page.locator('[data-req-done]').count();
  await page.locator('[data-req-done]').first().click();
  await page.waitForTimeout(300);
  check((await page.locator('[data-req-done]').count()) === doneButtons - 1, `${width} one marked done`);
  check(await page.locator('staff-displays [data-disp-q]').isVisible(), `${width} Open a display is on Stock too`);
  if (OUT && width !== 320) await page.screenshot({ path: `${OUT}/staff-stock-${width}.png`, fullPage: true });

  check(!errors.length, `${width} no script errors: ${errors.join(' | ')}`);
  await ctx.close();
};
for (const width of [320, 390, 1280]) {
  try {
    await run(width);
  } catch (error) {
    failed.push(`${width} stopped: ${String(error && error.message).split('\n')[0]}`);
  }
}
// With the switch off (Theme settings › Free holds and Tell us what you're after), as step 1 goes live on its own: no
// hold row, the empty search from before, and no Asked for on the staff page's Stock tab
const off = async () => {
  m.globalSettings.retail_holds = false;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(CLOCK);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  m.mockState.customer = RUBY;
  await page.goto(`${base}/products/riftbound-radiance`, { waitUntil: 'networkidle' });
  check(!(await page.locator('[data-lair-card-hold]').count()) && !(await page.locator('[data-lair-hold]').count()), 'off: no Hold it free on the product page');
  await page.goto(`${base}/search?q=pitch+black`, { waitUntil: 'networkidle' });
  const empty = text(await page.locator('.search-page .empty-state').innerText());
  check(!(await page.locator('[data-ask-form]').count()) && empty.includes('Gobgob searched every pile and found nothing for “pitch black”. Try another word?'), `off: the empty search from before: ${empty}`);
  m.mockState.customer = STAFF;
  await page.goto(`${base}/pages/lair-staff`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-tab="stock"]', { timeout: 15000 }).catch(() => null);
  await page.locator('[data-tab="pull"]').click();
  await page.waitForTimeout(400);
  const pull = text(await page.locator('[data-pull-body]').innerText());
  check(!pull.includes('Free hold') && !(await page.locator('[data-pull-try-hold]').count()), `off: no free holds to pull: ${pull.slice(0, 200)}`);
  await page.locator('[data-tab="stock"]').click();
  await page.waitForTimeout(300);
  check(!(await page.locator('staff-requests').count()) && (await page.locator('staff-displays [data-disp-q]').isVisible()), 'off: Stock is Open a display only');
  check(!errors.length, `off: no script errors: ${errors.join(' | ')}`);
  await ctx.close();
};
try {
  await off();
} catch (error) {
  failed.push(`off stopped: ${String(error && error.message).split('\n')[0]}`);
}
await browser.close();
console.log(`${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log(`FAIL ${f}`);
process.exit(failed.length ? 1 : 0);

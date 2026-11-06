// Round 31, retail (contract v31-retail): the wishlist by option, end to end on the demo: Add to wishlist on a product
// with options, Tell me when it's back on a sold-out option, logged out going to the login, and My Lair's wishlist in the
// Wallet (statuses, Remove, the email switch), at 320, 390 and 1280px.
// DG_THEME=/path/to/theme PORT=4962 [OUT=dir] node tools/qa/round31-retail/wishlist.mjs
import { createRequire } from 'node:module';
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
const PORT = Number(process.env.PORT || 4962);
const OUT = process.env.OUT || null;
m.serve(PORT);
const base = `http://localhost:${PORT}`;
const RUBY = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', tags: [], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };

let passed = 0;
const failed = [];
const check = (ok, what) => {
  if (ok) passed += 1;
  else failed.push(what);
};
const text = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const browser = await chromium.launch();
for (const width of [320, 390, 1280]) {
  const ctx = await browser.newContext({ viewport: { width, height: width > 1000 ? 900 : 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()); });

  // logged out: the heart goes to the login and back with ?wish=1
  m.mockState.customer = null;
  await page.goto(`${base}/products/riftbound-radiance`, { waitUntil: 'networkidle' });
  const login = await page.locator('wishlist-button').getAttribute('data-login');
  check(/^\/customer_authentication\/login\?return_to=%2Fproducts%2Friftbound-radiance%3Fvariant%3D\d+%26wish%3D1$/.test(login || ''), `${width} login link: ${login}`);

  // logged in: Add to wishlist for the box, then Tell me for Showdown (sold out)
  m.mockState.customer = RUBY;
  await page.goto(`${base}/products/riftbound-radiance`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const heart = page.locator('[data-wishlist-button]');
  await heart.click();
  await page.waitForTimeout(250);
  check(text(await heart.innerText()) === 'On your wishlist', `${width} added: ${await heart.innerText()}`);
  await page.locator('label.chip', { hasText: 'Showdown' }).click();
  await page.waitForTimeout(200);
  check(text(await heart.innerText()) === "Tell me when it's back", `${width} Showdown not on it yet: ${await heart.innerText()}`);
  await heart.click();
  await page.waitForTimeout(250);
  check(text(await heart.innerText()) === "We'll email you when it's back", `${width} told: ${await heart.innerText()}`);
  await page.locator('label.chip', { hasText: 'Booster Box' }).click();
  await page.waitForTimeout(200);
  check(text(await heart.innerText()) === 'On your wishlist', `${width} the box is still on it`);
  await page.locator('label.chip', { hasText: 'Booster Pack' }).click();
  await page.waitForTimeout(200);
  check(text(await heart.innerText()) === 'Add to wishlist', `${width} the pack isn't`);

  // back from the login with ?wish=1: added straight away, and the address loses it
  await page.goto(`${base}/products/blossom-sky-dice-set?wish=1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  check(text(await page.locator('[data-wishlist-button]').innerText()) === 'On your wishlist', `${width} ?wish=1 added it`);
  check(!page.url().includes('wish=1'), `${width} the address lost ?wish=1: ${page.url()}`);

  // My Lair: Your wishlist in the Wallet
  await page.goto(`${base}/pages/my-lair#ml-wishlist`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.mlw-list', { timeout: 8000 }).catch(() => null);
  const items = await page.locator('.mlw-item').evaluateAll((els) => els.map((el) => ({
    name: el.querySelector('.mlw-name')?.textContent.replace(/\s+/g, ' ').trim(),
    status: el.querySelector('.mlw-status')?.textContent.replace(/\s+/g, ' ').trim(),
    add: Boolean(el.querySelector('[data-mlw-add]')),
  })));
  check(items.length === 3, `${width} three on the wishlist: ${JSON.stringify(items)}`);
  const by = Object.fromEntries(items.map((i) => [i.name, i]));
  check(by['Blossom Sky Dice Set']?.status === 'Delivered in about 10 days · $90' && by['Blossom Sky Dice Set'].add, `${width} dice: ${JSON.stringify(by['Blossom Sky Dice Set'])}`);
  check(by['Riftbound Radiance: Showdown']?.status === "Sold out. We'll email you." && !by['Riftbound Radiance: Showdown'].add, `${width} Showdown: ${JSON.stringify(by['Riftbound Radiance: Showdown'])}`);
  check(by['Riftbound Radiance: Booster Box']?.status === 'On the shelf at the Lair · $240' && by['Riftbound Radiance: Booster Box'].add, `${width} box: ${JSON.stringify(by['Riftbound Radiance: Booster Box'])}`);
  check(text(await page.locator('.mlw-count').innerText()) === '3 things', `${width} count`);
  check(await page.locator('#ml-wishlist').isVisible(), `${width} #ml-wishlist opens the Wallet at it`);
  check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), `${width} no sideways scroll`);
  if (OUT) await page.locator('#ml-wishlist').screenshot({ path: `${OUT}/r31-${width}-mylair-wishlist.png` });
  // the email switch off: Sold out says just that
  await page.locator('[data-mlw-alerts]').uncheck();
  await page.waitForTimeout(250);
  check(text(await page.locator('.mlw-say').innerText()) === 'No more wishlist emails. Switch it back on any time.', `${width} switched off`);
  const showdown = await page.locator('.mlw-item', { hasText: 'Showdown' }).locator('.mlw-status').innerText();
  check(text(showdown) === 'Sold out', `${width} sold out without the email: ${showdown}`);
  await page.locator('[data-mlw-alerts]').check();
  await page.waitForTimeout(250);
  // Remove one option
  await page.locator('.mlw-item', { hasText: 'Showdown' }).locator('[data-mlw-remove]').click();
  await page.waitForTimeout(250);
  check((await page.locator('.mlw-item').count()) === 2 && text(await page.locator('.mlw-say').innerText()) === 'Taken off your wishlist.', `${width} removed`);
  check(errors.length === 0, `${width} script errors: ${errors.slice(0, 3)}`);
  await ctx.close();
}
await browser.close();
console.log(`${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log('FAIL', f);
process.exit(failed.length ? 1 : 0);

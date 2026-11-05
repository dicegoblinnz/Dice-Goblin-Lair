// Round 31, retail (contract v31-retail): the Lair card on product pages, in demo mode on the theme mock, at 320, 390 and
// 1280px. Mo's pick "B · The Lair card" (6 Nov 2026), its states, the variant picker, Tell me when it's back and On the
// shelf now. DG_THEME=/path/to/theme PORT=4961 [OUT=dir] node tools/qa/round31-retail/lair-card.mjs
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
const mock = await import(path.join(HERE, '../theme-mock/render.mjs'));
const PORT = Number(process.env.PORT || 4961);
const OUT = process.env.OUT || null;
mock.serve(PORT);
const base = `http://localhost:${PORT}`;

let passed = 0;
const failed = [];
const check = (ok, what) => {
  if (ok) passed += 1;
  else failed.push(what);
};
const text = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const browser = await chromium.launch();
for (const width of [320, 390, 1280]) {
  const page = await browser.newPage({ viewport: { width, height: width > 1000 ? 900 : 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  // a missing file: only the theme's own scripts and styles count (the mock has no product photos at every size)
  page.on('response', (r) => { if (r.status() === 404 && /\.(js|css)(\?|$)/.test(r.url())) errors.push(`404 ${r.url()}`); });
  const look = async () => ({
    state: await page.locator('lair-card').getAttribute('data-state'),
    card: text(await page.locator('lair-card').innerText()),
    buy: await page.locator('.product__buy').isVisible(),
    wish: await page.locator('wishlist-button').getAttribute('data-look'),
    wishText: text(await page.locator('wishlist-button').innerText()),
    delivery: await page.locator('[data-lair-card-delivery]').isVisible(),
    instead: await page.locator('[data-lair-instead]').count() ? await page.locator('[data-lair-instead]').isVisible() : false,
    sideways: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
  });

  // on the shelf: the card under the price, collect free with a time, the delivery line, Add to wishlist
  await page.goto(`${base}/products/riftbound-radiance`, { waitUntil: 'networkidle' });
  let v = await look();
  check(v.state === 'shelf' && v.card.includes('On the shelf at the Lair'), `${width} shelf: ${v.card}`);
  check(/Ready by \d{1,2}(:\d\d)?(am|pm) (today|tomorrow|\w+day), at the counter/.test(v.card), `${width} ready time: ${v.card}`);
  check(v.card.includes('Directions') && v.card.includes('Upstairs in Royal Oak Mall, above Whitcoulls.'), `${width} where`);
  check(!v.card.includes('Hold it free'), `${width} no holds until Free holds is on`);
  check(v.buy && v.delivery && v.wish === 'add' && v.wishText === 'Add to wishlist' && !v.instead, `${width} shelf form ${JSON.stringify(v)}`);
  check(!v.sideways, `${width} no sideways scroll (shelf)`);
  const cardTop = await page.locator('lair-card').evaluate((el) => el.getBoundingClientRect().top);
  const priceTop = await page.locator('[data-product-price]').evaluate((el) => el.getBoundingClientRect().top);
  check(cardTop > priceTop, `${width} the card comes after the price`);
  if (OUT) await page.screenshot({ path: `${OUT}/r31-${width}-shelf.png`, fullPage: true });

  // the variant picker: Only 2 left, then sold out (Tell me), then back
  await page.locator('label.chip', { hasText: 'Booster Pack' }).click();
  await page.waitForTimeout(150);
  v = await look();
  check(v.state === 'few' && v.card.includes('Only 2 left at the Lair'), `${width} few: ${v.card}`);
  await page.locator('label.chip', { hasText: 'Showdown' }).click();
  await page.waitForTimeout(150);
  v = await look();
  check(v.state === 'out' && v.card === 'Sold out at the Lair', `${width} out: ${v.card}`);
  check(!v.buy && v.wish === 'tell' && v.wishText === "Tell me when it's back Gobgob emails you the day Showdown is back on the shelf.", `${width} tell: ${JSON.stringify(v)}`);
  check(!v.delivery, `${width} no delivery line when sold out`);
  await page.locator('label.chip', { hasText: 'Booster Box' }).click();
  await page.waitForTimeout(150);
  v = await look();
  check(v.state === 'shelf' && v.buy && v.wish === 'add', `${width} back to the box`);

  // sold out from the start: Tell me in Add to cart's place, before any script, and On the shelf now
  await page.goto(`${base}/products/cyberpunk-tcg-starter-deck`, { waitUntil: 'networkidle' });
  v = await look();
  check(v.state === 'out' && !v.buy && v.wish === 'tell' && v.instead, `${width} sold out page ${JSON.stringify(v)}`);
  const names = (await page.locator('.lair-instead__name').allInnerTexts()).map(text);
  check(names.length >= 1 && names.length <= 3 && names[0] === 'Cyberpunk TCG - Welcome to Night City - Booster', `${width} instead: ${names}`);
  check(new Set(names).size === names.length && !names.includes('Cyberpunk TCG - Starter Deck'), `${width} instead has no repeats or itself`);
  check(!v.sideways, `${width} no sideways scroll (sold out)`);
  if (OUT) await page.screenshot({ path: `${OUT}/r31-${width}-out.png`, fullPage: true });

  // the supplier's dice: Delivered in about 10 days, never the supplier, no collect or hold, Add to cart stays
  await page.goto(`${base}/products/blossom-sky-dice-set`, { waitUntil: 'networkidle' });
  v = await look();
  check(v.state === 'supplier' && v.card.startsWith('Delivered in about 10 days'), `${width} dice: ${v.card}`);
  check(!/supplier|dice maker|sent from/i.test(v.card), `${width} the supplier is never named: ${v.card}`);
  check(!v.card.includes('collect free') && v.buy && !v.delivery, `${width} dice form ${JSON.stringify(v)}`);

  // no card where it doesn't belong: Games Workshop (its own box), a library copy, the membership
  for (const p of ['/products/gw-in-store', '/products/library', '/products/board-game-rental-monthly']) {
    await page.goto(`${base}${p}`, { waitUntil: 'networkidle' });
    check((await page.locator('lair-card').count()) === 0, `${width} no card on ${p}`);
  }
  check(errors.length === 0, `${width} script errors: ${errors.slice(0, 3)}`);
  await page.close();
}
await browser.close();
console.log(`${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log('FAIL', f);
process.exit(failed.length ? 1 : 0);

import { serve } from './render.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const only = process.argv.slice(2);
const server = await serve(4173);
const browser = await chromium.launch();
fs.mkdirSync('shots', { recursive: true });
const jobs = [
  ['home', '/', 1440, 900, true],
  ['home-m', '/', 390, 844, true],
  ['product', '/products/wingspan', 1440, 900, true],
  ['product-lib', '/products/library', 1440, 900, false],
  ['collection', '/collections/new-additions', 1440, 900, true],
  ['collection-m', '/collections/new-additions', 390, 844, false],
  ['book', '/pages/book-a-table', 1440, 900, true],
  ['book-m', '/pages/book-a-table', 390, 844, true],
  ['gm', '/pages/gm-games', 1440, 900, true],
  ['events', '/pages/events-calendar', 1440, 900, true],
  ['staff', '/pages/lair-staff', 1440, 900, true],
  ['library', '/pages/board-game-rental', 1440, 900, true],
  ['404', '/404', 1440, 900, false],
  ['cart', '/cart-open', 1440, 900, false],
].filter((j) => !only.length || only.includes(j[0]));
for (const [name, url, w, h, full] of jobs) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://localhost:4173${url}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  if (name === 'cart') {
    await page.click('[data-cart-open]');
    await page.waitForTimeout(500);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.screenshot({ path: `shots/${name}.png`, fullPage: full });
  console.log(name, 'overflowX', overflow, errors.length ? errors.slice(0, 4) : '');
  await page.close();
}
await browser.close();
server.close();

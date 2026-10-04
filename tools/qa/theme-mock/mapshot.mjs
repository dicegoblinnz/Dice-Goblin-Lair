import { serve } from './render.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const OUT = process.argv[2];
const server = await serve(4181);
const browser = await chromium.launch();
const errors = [];
async function shot(path, width, height, file, selector) {
  const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 })).newPage();
  page.on('pageerror', (e) => errors.push(`${path}: ${e.message}`));
  await page.goto(`http://localhost:4181${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const el = selector ? await page.$(selector) : null;
  if (el) await el.screenshot({ path: `${OUT}/${file}` });
  else await page.screenshot({ path: `${OUT}/${file}`, fullPage: false });
  return page;
}
await shot('/pages/book-a-table', 1400, 1000, 'map-desktop.png', '.floor');
await shot('/pages/lair-staff', 1400, 1000, 'map-staff.png', 'lair-floor');
const phone = await shot('/pages/book-a-table', 390, 844, 'map-phone.png', '.floor-scroll');
console.log('errors:', errors);
await browser.close(); server.close();

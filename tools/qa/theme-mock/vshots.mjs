// Viewport screenshots at scroll positions: node vshots.mjs <outdir> <w>x<h> <url> <name>:<selector|y>[:offset] ...
import { serve } from './render.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const [OUT, size, url, ...stops] = process.argv.slice(2);
const [w, h] = size.split('x').map(Number);
const PORT = 4192;
fs.mkdirSync(OUT, { recursive: true });
const server = await serve(PORT);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: w < 700, isMobile: w < 700 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`http://localhost:${PORT}${url}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
for (const stop of stops) {
  const [name, target, off] = stop.split('::');
  if (/^\d+$/.test(target)) {
    await page.evaluate((y) => window.scrollTo(0, y), Number(target));
  } else if (target.startsWith('click=')) {
    await page.click(target.slice(6));
  } else {
    await page.evaluate(([sel, o]) => {
      const el = document.querySelector(sel);
      if (!el) { console.log('missing', sel); return; }
      const top = el.getBoundingClientRect().top + window.scrollY - (o ? Number(o) : 0);
      window.scrollTo(0, top);
    }, [target, off || '0']);
  }
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('shot', name, await page.evaluate(() => window.scrollY));
}
await browser.close();
server.close();

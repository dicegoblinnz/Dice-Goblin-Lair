import { serve } from './render.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const server = await serve(4174);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto('http://localhost:4174/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const res = await page.evaluate(() => {
  const vw = window.innerWidth;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    let clipped = false;
    for (let a = el.parentElement; a; a = a.parentElement) {
      const o = getComputedStyle(a).overflowX;
      if (o === 'hidden' || o === 'auto' || o === 'scroll' || o === 'clip') { clipped = true; break; }
    }
    if (!clipped && r.right > vw + 1 && r.width > 0) {
      const hasWideChild = Array.from(el.children).some((c) => c.getBoundingClientRect().right > vw + 1);
      if (!hasWideChild) out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} right=${Math.round(r.right)} w=${Math.round(r.width)}`);
    }
  }
  const s = window.Lair?.store;
  return { out: out.slice(0, 15), hours: s?.hours, text: s?.cfg.hoursText, open: s && s.openStatus(), today: s && s.time.today(), wd: s && s.time.weekday(s.time.today()) };
});
console.log(JSON.stringify(res, null, 1));
await browser.close(); server.close();

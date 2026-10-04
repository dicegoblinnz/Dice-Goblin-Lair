import { serve } from './render.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const server = await serve(4176);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto('http://localhost:4176/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
console.log(await page.evaluate(() => {
  const chain = [];
  let el = document.querySelector('.portal__stat');
  while (el && el !== document.body) {
    const cs = getComputedStyle(el);
    chain.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)} w=${Math.round(el.getBoundingClientRect().width)} disp=${cs.display} gtc=${cs.gridTemplateColumns.slice(0, 40)}`);
    el = el.parentElement;
  }
  return chain.join('\n');
}));
await browser.close(); server.close();

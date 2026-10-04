// Library worktree screenshots: node libshots.mjs <outdir> [name ...]
// Phone 390x844 and desktop 1280x900, full page, plus horizontal-overflow and console-error checks.
import { serve } from './render.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const OUT = process.argv[2] || 'library-shots';
const only = process.argv.slice(3);
const PORT = 4191;
fs.mkdirSync(OUT, { recursive: true });
const server = await serve(PORT);
const browser = await chromium.launch();
const jobs = [
  ['home', '/'],
  ['library', '/pages/board-game-rental'],
  ['collection', '/collections/board-game-rental'],
  ['collection-filtered', '/collections/board-game-rental/shelf-3-4-players+co-op'],
  ['product-lib', '/products/library'],
  ['product-lib-rpg', '/products/d-d-bigby-library'],
  ['membership', '/products/board-game-rental-monthly'],
  ['membership-generic', '/products/board-game-rental-monthly?generic=1'],
  ['terms', '/pages/dice-goblin-board-game-rental-membership'],
  ['search', '/search?q=w'],
  ['cart', '/cart-membership'],
].filter((j) => !only.length || only.includes(j[0]));
const sizes = [['m', 390, 844], ['d', 1280, 900]];
for (const [name, url] of jobs) {
  for (const [tag, w, h] of sizes) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    const resp = await page.goto(`http://localhost:${PORT}${url}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    if (name === 'cart') {
      await page.click('[data-cart-open]').catch(() => {});
      await page.waitForTimeout(500);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const missing = await page.evaluate(() => (document.body.innerText.match(/\[missing [^\]]+\]/g) || []).slice(0, 5));
    const small = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('main a, main button, main input[type=radio], main input[type=checkbox], main summary, main select, dialog[open] a, dialog[open] button')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || el.closest('[hidden]')) continue;
        if (el.matches('.visually-hidden, .chip__input, .plan__input') ) continue;
        if (el.closest('.rte p, .rte li, .breadcrumbs, .product-card__title')) continue; // inline text links
        if (r.height < 44 && r.width < 44 * 6) out.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} ${Math.round(r.width)}x${Math.round(r.height)} "${(el.textContent || '').trim().slice(0, 24)}"`);
      }
      return [...new Set(out)].slice(0, 12);
    });
    await page.screenshot({ path: `${OUT}/${name}-${tag}.png`, fullPage: true });
    console.log(`${name}-${tag}`, resp.status(), 'overflowX', overflow, errors.length ? errors.slice(0, 3) : '', missing.length ? missing : '', tag === 'm' && small.length ? `\n   small targets: ${small.join(' | ')}` : '');
    await ctx.close();
  }
}
await browser.close();
server.close();

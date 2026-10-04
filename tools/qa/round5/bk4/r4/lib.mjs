// Shared setup for the bk4 QA scripts: the mock renderer on the bk4 worktree, in demo mode, on port 4311.
process.env.DG_THEME = process.env.DG_THEME || '/home/claude/dg-theme-bk4';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const { chromium } = require('/opt/node-tools/node_modules/playwright');
export const m = await import('../../../theme-mock/render.mjs');
m.globalSettings.lair_mode = 'demo';
export const PORT = Number(process.env.QA_PORT || 4311);
export const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
export const CUSTOMER = { id: 7002, first_name: 'Aroha', name: 'Aroha Ngata', email: 'aroha.n@example.com', phone: '021 555 0101', tags: [] };
export const OUT = new URL('../shots/r4-', import.meta.url).pathname;
export const SIZES = { phone: [390, 844], desktop: [1280, 800] };
// LAIR_AT="2026-10-04T16:00" runs the page's clock from that time in Auckland (it keeps ticking), so a late-night run
// books today, not tomorrow. Unset: the real time.
const AT = process.env.LAIR_AT ? (() => {
  const [d, hm] = process.env.LAIR_AT.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = (hm || '16:00').split(':').map(Number);
  // the Auckland offset on that day, from Intl
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  const parts = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return guess - (shown - guess);
})() : null;
export const CLOCK = AT ? `(() => {
  const OFFSET = ${AT - Date.now()};
  const Real = Date;
  class LairDate extends Real {
    constructor(...args) { if (args.length === 0) super(Real.now() + OFFSET); else super(...args); }
    static now() { return Real.now() + OFFSET; }
  }
  globalThis.Date = LairDate;
})();` : null;

export async function open(browser, tag, path, { scale, init, query = '' } = {}) {
  const [W, H] = SIZES[tag];
  const phone = tag === 'phone';
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: scale || (phone ? 2 : 1), isMobile: phone, hasTouch: phone });
  if (init) await ctx.addInitScript(init);
  if (CLOCK) await ctx.addInitScript(CLOCK);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (msg) => { if (msg.type() === 'error') page.errors.push('console: ' + msg.text()); });
  await page.goto(`http://localhost:${PORT}${path}${query}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  return { ctx, page };
}

export const text = async (page, sel) => ((await page.textContent(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
export const shot = async (page, name, sel) => {
  const file = `${OUT}${name}.png`;
  if (sel) {
    const el = await page.$(sel);
    if (el) await el.screenshot({ path: file });
    else console.log('  (no element for', sel, ')');
  } else await page.screenshot({ path: file });
  return file;
};
export const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
/** Buttons, links and inputs smaller than 44px (visible ones only) */
export const smallTargets = (page, root = 'body') => page.evaluate((r) => {
  const out = [];
  const scope = document.querySelector(r);
  if (!scope) return ['(no ' + r + ')'];
  for (const el of scope.querySelectorAll('button, a[href], input:not([type=hidden]), select, summary, textarea')) {
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || el.closest('[hidden]')) continue;
    // a checkbox, radio or file input inside a label counts as the label's size
    const target = (el.matches('input[type=checkbox], input[type=radio], input[type=file]') && el.closest('label')) || el;
    const t = target.getBoundingClientRect();
    if (t.height < 43.5 && !el.closest('.floor')) out.push(`${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''} "${(el.textContent || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(t.width)}x${Math.round(t.height)}`);
  }
  return out;
}, root);
/** Elements wider than the viewport, or poking out of it (what makes a page scroll sideways) */
export const wideOnes = (page) => page.evaluate(() => {
  const W = document.documentElement.clientWidth;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || el.closest('.floor-scroll, .staff-tabs, .announcement, [class*="announcement"]')) continue;
    if (r.right > W + 1 || r.left < -1) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  return out.slice(0, 12);
});
import { execFileSync } from 'node:child_process';
export const decode = (file) => execFileSync('python3', ['decode.py', file], { cwd: new URL('../../booking-qa/', import.meta.url).pathname }).toString().trim();

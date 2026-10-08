// QA harness for round 5 (mg4): My Lair and the GM games board on the mock store (port 4312), Playwright Chromium,
// phone (390x844) and desktop (1280x800), console and page errors, sideways-scroll checks and screenshots in ./shots.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
export const { chromium } = require('/opt/node-tools/node_modules/playwright');
process.env.DG_THEME = process.env.DG_THEME || '/home/claude/dg-theme-mg4';
export const m = await import('../../theme-mock/render.mjs');
m.globalSettings.lair_mode = 'demo';
export const OUT = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
export const PORT = Number(process.env.QA_PORT || 4312); // QA_PORT lets two checkouts run at once
export const BASE = `http://localhost:${PORT}`;
export const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
export const customer = {
  id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [],
  orders_count: 1,
  orders: [{ name: '#1550', created_at: '2026-10-01T03:12:00Z', total_price: 10000, fulfillment_status: 'fulfilled', cancelled: false, customer_url: '/account/orders/1550' }],
  store_credit_account: { balance: 500 },
};
export const errors = [];
let server;
let browser;
export async function start(launch = {}) {
  server = await m.serve(PORT);
  browser = await chromium.launch(launch);
  return browser;
}
export async function stop() {
  await browser?.close();
  server?.close();
}
/** A fresh browser context (the demo's localStorage starts empty unless storageState is passed) at a size */
export async function open(size, path = '/pages/my-lair', opts = {}) {
  const vp = SIZES[size] || size;
  const phone = vp.width < 700;
  const ctx = opts.ctx || await browser.newContext({ viewport: vp, hasTouch: phone, isMobile: phone, deviceScaleFactor: opts.scale || 1, storageState: opts.storageState });
  const page = await ctx.newPage();
  const tag = `${typeof size === 'string' ? size : `${vp.width}`}${opts.label ? `/${opts.label}` : ''}`;
  page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`${tag} console: ${msg.text()}`);
  });
  if (opts.init) await page.addInitScript(opts.init);
  m.mockState.customer = opts.customer === undefined ? customer : opts.customer;
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  if (path.startsWith('/pages/my-lair') && m.mockState.customer) {
    // My Lair is five views (Home, Bookings, Tab, Wallet, Me) and only one shows: the bookings panel is drawn either way
    await page.waitForSelector('[data-panel="bookings"]:not([aria-busy])', { state: 'attached', timeout: 10000 });
    // Round 9: the demo puts its customer on a monthly account; these checks are about paying each visit, so the demo
    // customer pays each visit here (opts.billing 'monthly' keeps the account; round9/tab.mjs checks it)
    const switched = opts.billing === 'monthly' ? false : await page.evaluate(() => {
      const be = window.Lair && window.Lair.store && window.Lair.store.backend;
      if (!be || typeof be.demoBilling !== 'function' || (be.tabAccountOf(window.Lair.store.cfg.customer && window.Lair.store.cfg.customer.id) || {}).billing !== 'monthly') return false;
      be.demoBilling('visit');
      return true;
    });
    if (switched) {
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('[data-panel="bookings"]:not([aria-busy])', { state: 'attached', timeout: 10000 });
    }
  }
  if (path.startsWith('/pages/gm-games')) await page.waitForSelector('.gm-card, .gm-empty', { timeout: 10000 });
  await page.waitForTimeout(400);
  return { ctx, page, tag };
}
/** Open one of My Lair's views the way a person does: its link in the bar (the rail from 990px) */
export async function view(page, name) {
  await page.click(`.ml-bar [data-view-link="${name}"]`);
  await page.waitForSelector(`[data-view="${name}"]:not([hidden])`, { timeout: 5000 });
  await page.waitForTimeout(250);
}

/** Open a later booking's row so its ticket shows (today's tickets are open already) */
export async function openRow(page, selector) {
  const row = page.locator(`details.ml-later:has(${selector})`).first();
  if ((await row.count()) && !(await row.evaluate((d) => d.open))) await row.locator(':scope > summary').click();
  await page.waitForTimeout(150);
}

export async function overflow(page, tag) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 0) errors.push(`${tag}: horizontal overflow ${over}px`);
  return over;
}
export const shot = (page, name, opts = {}) => page.screenshot({ path: `${OUT}${name}.png`, ...opts });
export async function shotOf(page, selector, name) {
  await page.locator(selector).first().screenshot({ path: `${OUT}${name}.png` });
}
export function report(label = 'done') {
  console.log(errors.length ? `ERRORS (${errors.length}):\n${errors.join('\n')}` : `${label}: no errors`);
}
/** Anything clickable under 44px in either direction that's visible */
export async function smallTargets(page, scope = 'my-lair') {
  return page.evaluate((scope) => {
    const out = [];
    for (const el of document.querySelectorAll(`${scope} button, ${scope} a, ${scope} input, ${scope} select, ${scope} summary`)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden') continue;
      if (r.height < 43.5 || r.width < 43.5) out.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} "${(el.textContent || el.value || '').trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  }, scope);
}

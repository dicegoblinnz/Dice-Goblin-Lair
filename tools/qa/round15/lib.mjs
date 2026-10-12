// Scratch helpers for round 15 checks of My Lair and the staff page (demo mode on the theme mock).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
export const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
export const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round15-mylair');
fs.mkdirSync(OUT, { recursive: true });
// AXE: a copy of axe-core's axe.min.js; without it the axe checks are skipped (and say so)
export const AXE = process.env.AXE && fs.existsSync(process.env.AXE) ? fs.readFileSync(process.env.AXE, 'utf8') : null;
export const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };

const TZ = 'Pacific/Auckland';
export const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const offset = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${key}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
export const iso = (key, hm) => `${key}T${hm}:00${offset(key)}`;
export const today = lairKey(Date.now());
/** The page clock: today at hm (default 1pm) in Auckland */
export const clockAt = (hm = '13:00') => {
  const AT = Date.parse(iso(today, hm));
  return `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;
};

export const RUBY = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [], store_credit_account: { balance: 500 }, orders_count: 0, orders: [] };
export const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };

let pass = 0;
let fail = 0;
export const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 900)}`}`);
  return ok;
};
export const totals = () => ({ pass, fail });
export const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
export const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
export async function axe(page, label, selector) {
  if (!AXE) return;
  await page.addScriptTag({ content: AXE });
  const tags = (process.env.AXE_TAGS || 'wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa').split(',');
  const found = await page.evaluate(async ([sel, values]) => {
    const els = [...document.querySelectorAll(sel)];
    if (!els.length) return [`nothing matches ${sel}`];
    const out = [];
    for (const el of els) {
      const r = await window.axe.run(el, { runOnly: { type: 'tag', values }, rules: { region: { enabled: false } } });
      out.push(...r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`));
    }
    return out;
  }, [selector, tags]);
  check(`axe: ${label}`, !found.length, found.join(' / '));
  return found;
}
export const shot = async (page, name, sel = null, full = false) => {
  const el = sel ? await page.$(sel) : null;
  await (el || page).screenshot({ path: `${OUT}/${name}.png`, ...(el ? {} : { fullPage: full }) }).catch((e) => console.log('shot failed', name, e.message));
  return `${OUT}/${name}.png`;
};

export async function context(browser, size, hm = '13:00') {
  const phone = size === 'phone';
  const ctx = await browser.newContext({ viewport: SIZES[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(clockAt(hm));
  return ctx;
}

export function watch(page) {
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) page.errors.push(`console: ${msg.text()}`);
  });
  return page;
}

export async function go(page, base, where, customer) {
  m.mockState.customer = customer;
  await page.goto('about:blank');
  await page.goto(`${base}${where}`, { waitUntil: 'networkidle', timeout: 60000 });
}

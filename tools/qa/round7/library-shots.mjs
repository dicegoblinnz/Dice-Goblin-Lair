// Round 7, library: full-page screenshots of what the library work changed, phone (390px) then desktop (1280px), in demo
// mode: a library game's page held for a member, My Lair with My Library (games at home and reserved), the scanner
// sheet over it, and the staff page's Library tab. Writes tools/qa/round7/shots/library-<view>-<size>.png and prints
// overflowX for each (0 is right).
// Usage: DG_THEME=/path/to/theme [PORT=4836] node tools/qa/round7/library-shots.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4836);
const BASE = `http://localhost:${PORT}`;
const OUT = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const STASH = { id: 7700500001, first_name: 'Kiri', last_name: 'Moana', name: 'Kiri Moana', email: 'kiri.moana@example.com', phone: null, tags: ['Goblin Treasure - Board Game Rental'], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const AT = Date.UTC(2026, 9, 5, 22, 0); // Tue 6 Oct 2026, 11am NZDT
const CLOCK = `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;

const server = await m.serve(PORT);
const browser = await chromium.launch();
try {
  for (const size of ['phone', 'desktop']) {
    const phone = size === 'phone';
    const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1 });
    await ctx.addInitScript(CLOCK);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text());
    });
    const go = async (who, path) => {
      m.mockState.customer = who;
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);
    };
    const shot = async (name, fullPage = true) => {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      await page.screenshot({ path: `${OUT}library-${name}-${size}.png`, fullPage });
      console.log(`${size} ${name}: overflowX ${overflow}`);
    };

    await go(STASH, '/products/221b-baker-street');
    await page.click('[data-reserve]');
    await page.waitForSelector('library-reserve[data-state="mine"]');
    await go(STASH, '/products/forbidden-island');
    await page.click('[data-reserve]');
    await page.waitForSelector('library-reserve[data-state="mine"]');
    await shot('game-page');

    // My Library, with one game borrowed by scanning (before the merge it's put on the page as the round 7 check does)
    await go(STASH, '/pages/my-lair');
    await page.evaluate(() => {
      const lair = document.querySelector('my-lair');
      const send = async () => {
        const me = await window.Lair.store.backend.me();
        lair.me = me;
        lair.dispatchEvent(new CustomEvent('lair:me', { bubbles: true, detail: { me } }));
      };
      lair.addEventListener('lair:refresh', send);
      if (!lair.querySelector('[data-view="library"] my-library')) {
        const views = [...lair.querySelectorAll('[data-view]')];
        const view = document.createElement('section');
        view.className = 'ml-view';
        view.dataset.view = 'library';
        view.innerHTML = '<div class="ml-view__head"><h1 class="ml-view__title" tabindex="-1">My Library</h1></div>';
        views[views.length - 1].after(view);
        for (const v of views) v.hidden = true;
        const el = document.createElement('my-library');
        el.dataset.plansUrl = '/pages/board-game-rental#plans';
        el.dataset.shelvesUrl = '/collections/board-game-rental';
        view.append(el);
      } else window.location.hash = 'library';
      send();
    });
    await page.waitForSelector('my-library .mlib');
    await page.click('my-library [data-library-scan]');
    await page.waitForSelector('dialog.lair-scan.is-off');
    await page.fill('#lair-scan-code', 'DGL56-002');
    await page.press('#lair-scan-code', 'Enter');
    await page.waitForSelector('dialog.lair-scan', { state: 'detached', timeout: 6000 });
    await page.waitForTimeout(800);
    await shot('my-library');
    await page.click('my-library [data-library-scan]');
    await page.waitForSelector('dialog.lair-scan.is-off');
    await page.fill('#lair-scan-code', '9421906580017');
    await page.press('#lair-scan-code', 'Enter');
    await page.waitForTimeout(600);
    await shot('scanner-sheet', false);
    await page.keyboard.press('Escape');

    await go(STAFF, '/pages/lair-staff#library');
    await page.waitForSelector('[data-lib-loans] .staff-lib-rows', { timeout: 10000 });
    await page.fill('#lib-member-q', 'Sam');
    await page.waitForSelector('[data-lib-member-pick]');
    await page.locator('[data-lib-member-pick]', { hasText: 'Sam' }).first().click();
    await page.fill('#lib-out-code', 'DGL34-052');
    await page.press('#lib-out-code', 'Enter');
    await page.waitForTimeout(500);
    await shot('staff');
    console.log(`${size} errors: ${JSON.stringify(errors)}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

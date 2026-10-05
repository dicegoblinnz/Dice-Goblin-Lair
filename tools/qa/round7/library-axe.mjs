// Round 7, library: axe-core (WCAG 2.0, 2.1, 2.2 A and AA, and best practice) on what the library work changed, and a
// keyboard pass. Demo mode through the theme mock, 390px and 1280px: the reserve block (on the shelf, held for them, at
// home), My Library (with games, Cancel asking, and the scanner sheet open), the join card, and the staff Library tab
// (the desk, a member picked, several copies to pick from, games at home).
// Usage: DG_THEME=/path/to/theme AXE=/path/to/axe-core/axe.min.js [PORT=4835] node tools/qa/round7/library-axe.mjs
// Prints the violations for each view (none is []), the keyboard results, and a last line with the count.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME || !process.env.AXE) {
  console.error('Set DG_THEME to the theme checkout and AXE to axe-core\'s axe.min.js.');
  process.exit(2);
}
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4835);
const BASE = `http://localhost:${PORT}`;
const STASH = { id: 7700500001, first_name: 'Kiri', last_name: 'Moana', name: 'Kiri Moana', email: 'kiri.moana@example.com', phone: null, tags: ['Goblin Treasure - Board Game Rental'], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const PLAIN = { id: 7700500003, first_name: 'Pat', last_name: 'Reader', name: 'Pat Reader', email: 'pat.reader@example.com', phone: null, tags: [], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const AT = Date.UTC(2026, 9, 5, 22, 0); // Tue 6 Oct 2026, 11am NZDT
const CLOCK = `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;

let problems = 0;
const say = (size, what, list) => {
  problems += Array.isArray(list) ? list.length : 0;
  console.log(`${size} | ${what}: ${JSON.stringify(list)}`);
};
const axe = async (page, include) => {
  await page.addScriptTag({ path: process.env.AXE });
  return page.evaluate(async (inc) => {
    const r = await window.axe.run(inc ? { include: inc.map((s) => [s]) } : document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => `${v.impact}:${v.id}(${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
  }, include);
};
const focused = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return 'body';
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${(el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 40)}"`;
});
const ring = (page) => page.evaluate(() => {
  const s = getComputedStyle(document.activeElement);
  return `${s.outlineStyle} ${s.outlineWidth}`;
});

const server = await m.serve(PORT);
const browser = await chromium.launch();
try {
  for (const size of ['phone', 'desktop']) {
    const phone = size === 'phone';
    const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: phone, hasTouch: phone });
    await ctx.addInitScript(CLOCK);
    const page = await ctx.newPage();
    const go = async (who, path) => {
      m.mockState.customer = who;
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);
    };

    // the reserve block: on the shelf, then held for them (keyboard: Reserve with Enter), then at home
    await go(STASH, '/products/221b-baker-street');
    say(size, 'reserve block, on the shelf', await axe(page, ['library-reserve']));
    await page.focus('[data-reserve]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('library-reserve[data-state="mine"]');
    console.log(`${size} | keyboard: Reserve with Enter → focus on ${await focused(page)}`);
    say(size, 'reserve block, held for them', await axe(page, ['library-reserve']));

    // My Library (put on the page as the round 7 check does, before the merge)
    await go(STASH, '/pages/my-lair');
    await page.evaluate(() => {
      const lair = document.querySelector('my-lair');
      let view = lair.querySelector('[data-view="library"]');
      const send = async () => {
        const me = await window.Lair.store.backend.me();
        lair.me = me;
        lair.dispatchEvent(new CustomEvent('lair:me', { bubbles: true, detail: { me } }));
      };
      lair.addEventListener('lair:refresh', send);
      if (!view) {
        const views = [...lair.querySelectorAll('[data-view]')];
        view = document.createElement('section');
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
    // keyboard: Scan a game with Enter, type a code, Escape closes and focus comes back
    await page.focus('my-library [data-library-scan]');
    console.log(`${size} | keyboard: Scan a game focused, ring ${await ring(page)}`);
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.lair-scan.is-off');
    console.log(`${size} | keyboard: the sheet opens, focus on ${await focused(page)}`);
    say(size, 'the scanner sheet', await axe(page, ['dialog.lair-scan']));
    await page.keyboard.type('DGL34-052');
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.lair-scan', { state: 'detached', timeout: 6000 });
    await page.waitForTimeout(300);
    console.log(`${size} | keyboard: borrowed by typing, sheet closed, focus on ${await focused(page)}`);
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.lair-scan.is-off');
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog.lair-scan', { state: 'detached' });
    console.log(`${size} | keyboard: Escape closes the sheet, focus on ${await focused(page)}`);
    say(size, 'My Library with games', await axe(page, ['my-library']));
    // Cancel asks first, by keyboard
    await page.focus('my-library [data-mlib-cancel]');
    await page.keyboard.press('Enter');
    console.log(`${size} | keyboard: Cancel → focus on ${await focused(page)}`);
    say(size, 'My Library, Cancel asking', await axe(page, ['my-library']));
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    console.log(`${size} | keyboard: Yes, cancel it → focus on ${await focused(page)}`);

    await go(PLAIN, '/pages/my-lair');
    await page.evaluate(() => {
      const lair = document.querySelector('my-lair');
      const el = document.createElement('my-library');
      el.dataset.plansUrl = '/pages/board-game-rental#plans';
      el.dataset.shelvesUrl = '/collections/board-game-rental';
      lair.querySelector('[data-view]:not([hidden])').prepend(el);
      window.Lair.store.backend.me().then((me) => {
        lair.me = me;
        lair.dispatchEvent(new CustomEvent('lair:me', { bubbles: true, detail: { me } }));
      });
    });
    await page.waitForSelector('my-library .mlib-join');
    say(size, 'My Library, no plan', await axe(page, ['my-library']));

    // the game's page for a game at home with them
    await go(STASH, '/products/forbidden-island');
    say(size, 'reserve block, at home', await axe(page, ['library-reserve']));

    // the staff Library tab: the desk by keyboard, a pick list, games at home
    await go(STAFF, '/pages/lair-staff#library');
    await page.waitForSelector('[data-lib-loans] .staff-lib-rows', { timeout: 10000 });
    await page.focus('#lib-member-q');
    await page.keyboard.type('Sam');
    await page.waitForSelector('[data-lib-member-pick]');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    console.log(`${size} | keyboard: member search → Tab → ${await focused(page)}`);
    await page.locator('[data-lib-member-pick]', { hasText: 'Sam' }).first().focus();
    await page.keyboard.press('Enter');
    console.log(`${size} | keyboard: pick Sam with Enter → focus on ${await focused(page)}`);
    await page.keyboard.type('DGL34-052');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await page.fill('#lib-out-code', 'DGL34-052');
    await page.press('#lib-out-code', 'Enter');
    await page.waitForTimeout(400);
    await page.focus('#lib-in-code');
    await page.keyboard.type('DGL34-052');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-lib-pick] button');
    say(size, 'staff Library tab (desk, pick list, holds, games at home)', await axe(page, ['[data-panel="library"]']));
    await page.focus('[data-lib-pick] button');
    console.log(`${size} | keyboard: pick list button ring ${await ring(page)}`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    console.log(`${size} | keyboard: Back on the shelf from the pick list → focus on ${await focused(page)}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(problems ? `library axe: ${problems} violation group(s)` : 'library axe: no violations');

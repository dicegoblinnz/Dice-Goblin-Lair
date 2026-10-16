// Round 16 (16 Oct 2026), library lending: axe-core (WCAG 2.0, 2.1, 2.2 A and AA, and best practice) on what lending
// changed, and a keyboard pass through Lend to someone new. Demo mode through the theme mock, 390px and 1280px: the
// staff desk with the lend form open, Games at home with lent games (a guest's and a member's), My Library for someone
// whose only games are lent, and for a plan member with a lent game.
// Usage: DG_THEME=/path/to/theme AXE=/path/to/axe-core/axe.min.js [PORT=4988] node tools/qa/round16/library-lending-axe.mjs
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
const PORT = Number(process.env.PORT || 4988);
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
      await page.waitForTimeout(300);
    };
    const lend = async (name, email, code) => {
      await page.click('[data-lib-member] [data-lib-guest-open]');
      await page.fill('#lib-guest-name', name);
      await page.fill('#lib-guest-email', email);
      await page.fill('#lib-out-code', code);
      await page.press('#lib-out-code', 'Enter');
      await page.waitForTimeout(400);
      await page.click('[data-lib-guest-close]');
    };

    // the staff desk: keyboard first, from Lend to someone new to the game
    await go(STAFF, '/pages/lair-staff');
    await page.click('[data-tab="library"]');
    await page.waitForSelector('[data-lib-loans] .staff-lib-rows', { timeout: 10000 });
    await page.focus('#lib-member-q');
    const tabs = [];
    await page.keyboard.press('Tab');
    tabs.push(`Tab → ${await focused(page)} [${await ring(page)}]`);
    await page.keyboard.press('Enter');
    tabs.push(`Enter → ${await focused(page)}`);
    await page.keyboard.type('Wiremu Brown');
    await page.keyboard.press('Enter');
    tabs.push(`Enter in Name → ${await focused(page)}`);
    await page.keyboard.type('wiremu@example.com');
    await page.keyboard.press('Enter');
    tabs.push(`Enter in Email → ${await focused(page)}`);
    await page.keyboard.press('Enter');
    tabs.push(`Enter in Mobile → ${await focused(page)}`);
    console.log(`${size} | keyboard, Lend to someone new: ${tabs.join(' ; ')}`);
    say(size, 'staff desk, the lend form open', await axe(page, ['[data-lib-out]']));
    await page.keyboard.type('DGL7+-015');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    console.log(`${size} | lent by keyboard: ${(await page.locator('[data-lib-say="out"]').textContent()).trim()} (focus ${await focused(page)})`);
    await page.click('[data-lib-guest-close]');
    await lend('Grace', 'grace@example.com', 'DGLF-025');
    await lend('Pat', 'pat.reader@example.com', 'DGL56-002');
    await lend('Kiri', 'kiri.moana@example.com', 'DGL34-052');
    say(size, 'Games at home, with lent games', await axe(page, ['[data-lib-loans]']));
    // a search with no match: the offer to lend instead
    await page.fill('#lib-member-q', 'Zed Nobody');
    await page.waitForSelector('[data-lib-guest-from]', { timeout: 5000 });
    say(size, 'member search with no match', await axe(page, ['[data-lib-out]']));

    // My Library: someone whose only games are lent, then a plan member with one
    await go(PLAIN, '/pages/my-lair#library');
    await page.waitForSelector('my-library .mlib', { timeout: 10000 });
    await page.waitForTimeout(300);
    say(size, 'My Library, lent only', await axe(page, ['my-library']));
    await go(STASH, '/pages/my-lair#library');
    await page.waitForSelector('my-library .mlib', { timeout: 10000 });
    await page.waitForTimeout(300);
    say(size, 'My Library, a plan and a lent game', await axe(page, ['my-library']));
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(problems ? `library lending axe: ${problems} violations` : 'library lending axe: no violations');
process.exit(problems ? 1 : 0);

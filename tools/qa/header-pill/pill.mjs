// The header's open pill (layout chat, 8 Nov 2026), on the theme mock with the theme's own fonts and the store's seven
// top links. With Warhammer in the menu (round 31), the pill wrapped onto two lines from 1360px and touched New here?
// with the shop's longest words ("Open until midnight" most nights, "Opens Monday 4pm" on Sunday after 10pm). Checked,
// with each thing the pill can say for the shop's hours:
//   1. where the pill shows, it's on one line, with at least 16px to spare before it
//   2. it shows from 1420px (where all of it fits), and the top links stay on one row
//   3. no sideways scroll
// Usage: DG_THEME=/path/to/theme [PORT=4999] node tools/qa/header-pill/pill.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
const PORT = Number(process.env.PORT || 4999);
const L = (title, url, links = []) => ({ title, url, links, current: false });
const kids = (titles) => titles.map((t) => L(t, '/'));
// the store's dg-main-menu as it is on 8 Nov 2026
const MENU = {
  title: 'Main menu',
  links: [
    L('Book a table', '/pages/book-a-table'), L('TTRPG sessions', '/pages/gm-games'), L('Warhammer', '/pages/warhammer'), L('Events calendar', '/pages/events-calendar'),
    L('Shop', '/collections/all', kids(['New arrivals', 'Gift card', 'Board games'])),
    L('Library', '/pages/board-game-rental', kids(['How it works', 'Browse the shelves'])),
    L('New here?', '/#how-a-visit-works', kids(['How a visit works', 'Contact and getting here'])),
  ],
};
m.linklists['dg-main-menu'] = MENU;
m.linklists['dg-main-menu-lab'] = MENU;
// what the pill says with the shop's hours (Mon to Fri 4pm to midnight, Sat 10am to midnight, Sun 10am to 10pm)
const WORDS = ['Open until midnight', 'Open until 10pm', 'Opens at 4pm', 'Opens at 10am', 'Opens Monday 4pm'];

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

const server = await m.serve(PORT);
const browser = await chromium.launch();
for (const w of [1280, 1360, 1366, 1400, 1419, 1420, 1440, 1536, 1920]) {
  const page = await browser.newPage({ viewport: { width: w, height: 800 } });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  for (const words of WORDS) {
    const r = await page.evaluate((text) => {
      const pill = document.querySelector('.site-header .open-pill');
      const shown = Boolean(pill) && getComputedStyle(pill).display !== 'none';
      if (shown) {
        [...pill.childNodes].filter((n) => !(n.nodeType === 1 && n.classList.contains('open-pill__dot'))).forEach((n) => n.remove());
        pill.append(document.createTextNode(text));
      }
      const items = [...document.querySelectorAll('.site-nav__list > .site-nav__item')];
      const last = items[items.length - 1].getBoundingClientRect();
      const box = shown ? pill.getBoundingClientRect() : null;
      const lineHeight = shown ? parseFloat(getComputedStyle(pill).lineHeight) || 16 : 0;
      return {
        shown,
        lines: shown ? Math.round((box.height - parseFloat(getComputedStyle(pill).paddingTop) - parseFloat(getComputedStyle(pill).paddingBottom)) / lineHeight) : 0,
        room: shown ? Math.round(box.left - last.right) : null,
        rows: new Set(items.map((i) => Math.round(i.getBoundingClientRect().top))).size,
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    }, words);
    if (r.shown) check(`${w}px, "${words}": on one line, ${r.room}px to spare before it`, r.lines === 1 && r.room >= 16 && r.rows === 1, r);
    if (w >= 1420) check(`${w}px, "${words}": the pill shows`, r.shown, r);
    check(`${w}px, "${words}": no sideways scroll`, r.sideways <= 0, r.sideways);
  }
  await page.close();
}
await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Round 31, Warhammer in the main menu (Mo, 6 Nov 2026: "Yes let's have Warhammer in the menu"): the header with the
// store's seven top links (Book a table, TTRPG sessions, Warhammer, Events calendar, Shop, Library, New here?) on the
// theme mock, with the theme's own fonts:
//   1. below 1220px the menu drawer (the toggle shows, the links don't), and Warhammer is in the drawer
//   2. from 1220px every top link is on one row, with at least 16px to spare before the open pill or the icons
//   3. no sideways scroll at any width
// Usage: DG_THEME=/path/to/theme [PORT=4993] [OUT=/dir] node tools/qa/round31/menu.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round31-menu');
fs.mkdirSync(OUT, { recursive: true });
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
const PORT = Number(process.env.PORT || 4993);
const L = (title, url, links = []) => ({ title, url, links, current: false });
const kids = (titles) => titles.map((t) => L(t, '/'));
// the store's dg-main-menu as it is on 6 Nov 2026, with Warhammer after TTRPG sessions (the lab's header reads its copy)
const MENU = {
  title: 'Main menu',
  links: [
    L('Book a table', '/pages/book-a-table'), L('TTRPG sessions', '/pages/gm-games'), L('Warhammer', '/pages/warhammer'), L('Events calendar', '/pages/events-calendar'),
    L('Shop', '/collections/all', kids(['New arrivals', 'Board games', 'Family games', 'Role-playing games', 'Trading card games', 'Dice and accessories', 'Painting and hobby', 'Plush and toys', 'Everything'])),
    L('Library', '/pages/board-game-rental', kids(['How it works', 'Browse the shelves', 'Borrow RPG books', 'Library discovery'])),
    L('New here?', '/#how-a-visit-works', kids(['How a visit works', 'Our games', 'Contact and getting here'])),
  ],
};
m.linklists['dg-main-menu'] = MENU;
m.linklists['dg-main-menu-lab'] = MENU;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

const server = await m.serve(PORT);
const browser = await chromium.launch();
for (const w of [390, 1024, 1180, 1219, 1220, 1280, 1360, 1366, 1440, 1536, 1920]) {
  const page = await browser.newPage({ viewport: { width: w, height: 800 } });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const r = await page.evaluate(() => {
    const nav = document.querySelector('.site-nav');
    const items = [...document.querySelectorAll('.site-nav__list > .site-nav__item')];
    const shown = getComputedStyle(nav).display !== 'none';
    const toggle = document.querySelector('.site-header__menu-toggle');
    const pill = document.querySelector('.open-pill');
    const pillShown = Boolean(pill) && getComputedStyle(pill).display !== 'none';
    const last = items[items.length - 1]?.getBoundingClientRect();
    const edge = pillShown ? pill.getBoundingClientRect().left : document.querySelector('.site-header__actions').getBoundingClientRect().left;
    const drawerText = (document.querySelector('[data-menu-drawer], .menu-drawer, #menu-drawer') || document.body).textContent;
    return {
      shown, toggle: Boolean(toggle) && getComputedStyle(toggle).display !== 'none', pillShown,
      rows: new Set(items.map((i) => Math.round(i.getBoundingClientRect().top))).size,
      room: last ? Math.round(edge - last.right) : null,
      titles: items.map((i) => i.querySelector('.site-nav__link')?.textContent.trim()),
      drawerHasWarhammer: /Warhammer/.test(drawerText),
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  if (w < 1220) {
    check(`${w}px: the menu drawer, not the full menu`, !r.shown && r.toggle, r);
    check(`${w}px: Warhammer is in the drawer`, r.drawerHasWarhammer);
  } else {
    check(`${w}px: the full menu, every top link on one row, Warhammer third`, r.shown && !r.toggle && r.rows === 1 && r.titles[2] === 'Warhammer', r);
    check(`${w}px: at least 16px to spare before the ${r.pillShown ? 'open pill' : 'icons'} (${r.room}px)`, r.room >= 16, r);
  }
  check(`${w}px: no sideways scroll`, r.sideways <= 0, r.sideways);
  if ([390, 1220, 1366].includes(w)) await page.screenshot({ path: `${OUT}/header-${w}.png`, clip: { x: 0, y: 0, width: w, height: 120 } });
  await page.close();
}
await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed. Screenshots in ${OUT}`);
process.exit(fail ? 1 : 0);

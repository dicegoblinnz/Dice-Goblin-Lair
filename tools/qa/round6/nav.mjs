// Round 6 nav checks, on the mock store in demo mode, at 390px and 1280px (and the header at six desktop widths):
// - the main menu: six items (Shop, Book a table, Book a TTRPG session, Library, Events, Contact), only Shop with a submenu
// - the side menu: Join our Discord right under Book a table (a lighter button, new tab, gone when the setting is blank)
// - the home hero: Join our Discord under the two main buttons, lighter than both
// - the header scrolls away: 1,000px down it's above the screen; anchor jumps, the skip link and the events day strip
// - the header at 990, 1000, 1100, 1180, 1280 and 1440px: one line, nothing overlapping, wrapping or clipped
// - the shop chips: a Game row on Trading Card Games and a System row on Role Playing Game only, empty tags hidden,
//   and the library's Shelf and Type rows as they were
// - the Google Maps link: address, Get directions, Read our Google reviews, the footer, the fallback when blank
// Usage: DG_THEME=/path/to/theme PORT=4722 node tools/qa/round6/nav.mjs   (exits 1 if anything fails)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const THEME = process.env.DG_THEME || '/home/claude/dg-theme';
const PORT = Number(process.env.PORT || 4722);
const BASE = `http://localhost:${PORT}`;
const MAPS = 'https://maps.app.goo.gl/7KdmJLTqZPe47kXG6';
const DISCORD = m.globalSettings.social_discord;
// Monday 5 Oct 2026, 5pm in Auckland: the Lair's open, so the header's open pill is at its longest ("Open until midnight")
const AT = Date.UTC(2026, 9, 5, 4, 0);
const CLOCK = `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;
const CUSTOMER = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', tags: [], orders_count: 0, orders: [] };

let fails = 0;
const results = [];
const check = (name, ok, detail = '') => {
  if (!ok) fails += 1;
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`);
  console.log(results[results.length - 1]);
};

const server = await m.serve(PORT);
const browser = await chromium.launch();
async function open(width, url, { customer = null, height = 844 } = {}) {
  m.mockState.customer = customer;
  const phone = width < 700;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(CLOCK);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(`console: ${msg.text()}`); });
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const MENU = [
  ['Shop', null],
  ['Book a table', '/pages/book-a-table'],
  ['Book a TTRPG session', '/pages/gm-games'],
  ['Library', '/pages/board-game-rental'],
  ['Events', '/pages/events-calendar'],
  ['Contact', '/pages/contact'],
];

try {
  /* ---------- 1. the main menu: desktop bar and side menu ---------- */
  {
    const { ctx, page, errors } = await open(1280, '/');
    const items = await page.$$eval('.site-nav__list > li', (lis) => lis.map((li) => {
      const sub = li.querySelector('details');
      const link = li.querySelector(':scope > a.site-nav__link');
      return { title: (sub ? sub.querySelector('summary') : link).textContent.trim(), href: link ? link.getAttribute('href') : null, sub: Boolean(sub), children: sub ? sub.querySelectorAll('.site-nav__sublink').length : 0 };
    }));
    const titles = items.map((i) => i.title);
    check('desktop menu: six top-level items in order', JSON.stringify(titles) === JSON.stringify(MENU.map((x) => x[0])), titles.join(', '));
    check('desktop menu: only Shop has a submenu', items.length === 6 && items[0].sub && items[0].children > 0 && items.slice(1).every((i) => !i.sub), items.map((i) => `${i.title}${i.sub ? `(${i.children})` : ''}`).join(', '));
    check('desktop menu: links go to the right pages', items.slice(1).every((i, n) => i.href === MENU[n + 1][1]), items.slice(1).map((i) => i.href).join(' '));
    const header = await page.locator('.site-header').innerText();
    check('desktop menu: no "The Lair" item and no "GM games" in the header', !/The Lair|GM games/i.test(header));
    await page.click('.site-nav__details > summary');
    await page.waitForTimeout(250);
    const dropdown = await page.evaluate(() => {
      const d = document.querySelector('.site-nav__dropdown').getBoundingClientRect();
      const hit = document.elementFromPoint(d.left + 20, d.top + 20);
      return { open: document.querySelector('.site-nav__details').open, onTop: Boolean(hit && hit.closest('.site-nav__dropdown')) };
    });
    check('desktop menu: the Shop dropdown opens over the page', dropdown.open && dropdown.onTop);
    check('desktop menu: no console errors', errors.length === 0, errors.slice(0, 2).join(' / '));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(390, '/');
    await page.click('.site-header__menu-toggle');
    await page.waitForTimeout(500);
    const items = await page.$$eval('#menu-drawer .menu-drawer__list > li', (lis) => lis.map((li) => {
      const sub = li.querySelector('details');
      return { title: (sub ? sub.querySelector('summary') : li.querySelector('a')).textContent.trim(), sub: Boolean(sub) };
    }));
    check('side menu: the same six items, only Shop with a submenu', JSON.stringify(items.map((i) => i.title)) === JSON.stringify(MENU.map((x) => x[0])) && items[0].sub && items.slice(1).every((i) => !i.sub), items.map((i) => `${i.title}${i.sub ? '+' : ''}`).join(', '));
    await ctx.close();
  }

  /* ---------- 2. the side menu's Discord button ---------- */
  for (const [who, customer] of [['logged out', null], ['logged in', CUSTOMER]]) {
    const { ctx, page, errors } = await open(390, '/', { customer });
    await page.click('.site-header__menu-toggle');
    await page.waitForTimeout(500);
    const d = await page.evaluate(() => {
      const extras = document.querySelector('#menu-drawer .menu-drawer__extras');
      const book = [...extras.querySelectorAll('a.button')].find((a) => /book-a-table/.test(a.getAttribute('href')) && !a.classList.contains('button--ghost'));
      const next = book && book.nextElementSibling;
      const box = (el) => el.getBoundingClientRect();
      const css = (el) => getComputedStyle(el);
      return {
        open: document.querySelector('#menu-drawer').open,
        nextIsDiscord: Boolean(next && next.classList.contains('menu-drawer__discord')),
        href: next && next.getAttribute('href'), target: next && next.getAttribute('target'), rel: next && next.getAttribute('rel'),
        text: next && next.textContent.replace(/\s+/g, ' ').trim(), icon: Boolean(next && next.querySelector('.icon--discord')),
        gap: next ? Math.round(box(next).top - box(book).bottom) : null, height: next ? Math.round(box(next).height) : 0,
        sameWidth: next ? Math.abs(box(next).width - box(book).width) < 1 : false,
        bookBg: css(book).backgroundColor, discordBg: next ? css(next).backgroundColor : '',
        after: next && next.nextElementSibling ? next.nextElementSibling.textContent.replace(/\s+/g, ' ').trim().slice(0, 30) : '',
      };
    });
    check(`side menu (${who}): Join our Discord is the button right under Book a table`, d.open && d.nextIsDiscord && d.gap >= 0 && d.gap <= 24, `gap ${d.gap}px, then "${d.after}"`);
    check(`side menu (${who}): it opens the theme's Discord invite in a new tab`, d.href === DISCORD && d.target === '_blank' && /noopener/.test(d.rel || ''), `${d.href} ${d.target} ${d.rel}`);
    check(`side menu (${who}): labelled "Join our Discord" with the discord icon, a new-tab note for screen readers`, /^Join our Discord \(opens in a new tab\)$/.test(d.text) && d.icon, d.text);
    check(`side menu (${who}): an outline button under the filled Book a table, as wide, 44px+ tall`, d.discordBg === 'rgba(0, 0, 0, 0)' && d.bookBg !== 'rgba(0, 0, 0, 0)' && d.sameWidth && d.height >= 44, `book ${d.bookBg}, discord ${d.discordBg}, ${d.height}px`);
    if (!customer) {
      await page.focus('#menu-drawer .menu-drawer__extras a.button:not(.button--ghost)');
      await page.keyboard.press('Tab');
      const next = await page.evaluate(() => document.activeElement.className);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const back = await page.evaluate(() => ({ open: document.querySelector('#menu-drawer').open, focus: document.activeElement.classList.contains('site-header__menu-toggle') }));
      check('side menu: Tab from Book a table lands on Join our Discord; Escape closes it and focus goes back to the menu button', /menu-drawer__discord/.test(next) && !back.open && back.focus, `${next} | open ${back.open}, focus back ${back.focus}`);
    }
    check(`side menu (${who}): no console errors, no sideways scroll`, errors.length === 0 && (await overflowX(page)) === 0, errors.slice(0, 2).join(' / '));
    await ctx.close();
  }

  /* ---------- 3. the hero's Discord button ---------- */
  for (const width of [390, 1280]) {
    const { ctx, page } = await open(width, '/');
    const h = await page.evaluate(() => {
      const link = document.querySelector('.hero__discord');
      if (!link) return null;
      const pair = link.previousElementSibling;
      const first = pair && pair.querySelector('.signpost');
      const box = (el) => el.getBoundingClientRect();
      const a = box(link), p = box(pair), f = box(first);
      return {
        afterPair: Boolean(pair && pair.classList.contains('hero__actions')), pairLabels: [...pair.querySelectorAll('.signpost')].map((s) => s.textContent.trim()),
        href: link.getAttribute('href'), target: link.getAttribute('target'), rel: link.getAttribute('rel'), text: link.textContent.replace(/\s+/g, ' ').trim(),
        icon: Boolean(link.querySelector('.icon--discord')), gap: Math.round(a.top - p.bottom), leftDiff: Math.round(a.left - p.left),
        height: Math.round(a.height), firstHeight: Math.round(f.height), right: Math.round(a.right),
        bg: getComputedStyle(link).backgroundColor, firstBg: getComputedStyle(first).backgroundColor,
        weight: Number(getComputedStyle(link).fontWeight), firstWeight: Number(getComputedStyle(first).fontWeight),
      };
    });
    const tag = width < 700 ? 'phone' : 'desktop';
    check(`hero (${tag}): Join our Discord sits right under the two main buttons`, Boolean(h) && h.afterPair && h.gap >= 0 && h.gap <= 16 && Math.abs(h.leftDiff) <= 1, h ? `under "${h.pairLabels.join('" + "')}", gap ${h.gap}px` : 'missing');
    if (!h) continue;
    check(`hero (${tag}): it opens the Discord invite in a new tab, with the discord icon`, h.href === DISCORD && h.target === '_blank' && /noopener/.test(h.rel || '') && h.icon && /^Join our Discord/.test(h.text), `${h.href} | ${h.text}`);
    check(`hero (${tag}): lighter than the main pair (no fill, lighter type, no taller), still 44px to tap`, h.bg === 'rgba(0, 0, 0, 0)' && h.firstBg !== 'rgba(0, 0, 0, 0)' && h.weight < h.firstWeight && h.height >= 44 && h.height <= h.firstHeight, `${h.height}px vs ${h.firstHeight}px, weight ${h.weight} vs ${h.firstWeight}`);
    check(`hero (${tag}): fits the screen`, h.right <= width && (await overflowX(page)) === 0);
    await ctx.close();
  }
  {
    // with the theme's Discord link blank: the side menu button and the hero button (no link of its own) are both gone
    const saved = m.globalSettings.social_discord;
    m.globalSettings.social_discord = '';
    const { ctx, page } = await open(390, '/');
    const gone = await page.evaluate(() => ({ drawer: document.querySelectorAll('.menu-drawer__discord').length, hero: document.querySelectorAll('.hero__discord').length }));
    m.globalSettings.social_discord = saved;
    check('Discord buttons hide when the Discord invite link is blank', gone.drawer === 0 && gone.hero === 0, JSON.stringify(gone));
    await ctx.close();
  }

  /* ---------- 4. the header scrolls away ---------- */
  for (const [width, url] of [[390, '/'], [1280, '/'], [390, '/collections/trading-card-games'], [1280, '/pages/book-a-table']]) {
    const { ctx, page } = await open(width, url);
    const s = await page.evaluate(async () => {
      window.scrollTo(0, 1000);
      await new Promise((r) => setTimeout(r, 250));
      const header = document.querySelector('.site-header');
      const b = header.getBoundingClientRect();
      return { y: Math.round(window.scrollY), top: Math.round(b.top), bottom: Math.round(b.bottom), position: getComputedStyle(header).position };
    });
    check(`header (${width}px ${url}): scrolled 1,000px down, it's gone above the screen`, s.y === 1000 && s.bottom <= 0 && !['sticky', 'fixed'].includes(s.position), `scrollY ${s.y}, header top ${s.top}, bottom ${s.bottom}, position ${s.position}`);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(390, '/#contact');
    await page.waitForTimeout(300);
    const a = await page.evaluate(() => ({ pad: getComputedStyle(document.documentElement).scrollPaddingTop, top: Math.round(document.querySelector('#contact').getBoundingClientRect().top), y: Math.round(window.scrollY) }));
    check('anchor jump: /#contact lands 16px under the top edge (scroll-padding is --sticky-top, no header to clear)', a.pad === '16px' && Math.abs(a.top - 16) <= 1 && a.y > 0, `scroll-padding ${a.pad}, #contact at ${a.top}px`);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(1280, '/');
    await page.keyboard.press('Tab');
    const first = await page.evaluate(() => document.activeElement.className);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const k = await page.evaluate(() => ({ focus: document.activeElement.id, top: Math.round(document.querySelector('#main').getBoundingClientRect().top) }));
    check('skip link: first Tab stop, Enter moves focus to main and brings it to the top', /skip-link/.test(first) && k.focus === 'main' && k.top <= 17, `first stop .${first}, focus #${k.focus}, main at ${k.top}px`);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(390, '/pages/events-calendar');
    await page.waitForSelector('lair-calendar .cal-strip', { timeout: 15000 }).catch(() => {});
    const c = await page.evaluate(async () => {
      const strip = document.querySelector('lair-calendar .cal-strip');
      if (!strip) return null;
      // it sticks only while its week is on screen, so scroll a little way into the week (header long gone by then)
      const startTop = strip.getBoundingClientRect().top + window.scrollY;
      const room = strip.parentElement.getBoundingClientRect().height - strip.offsetHeight;
      window.scrollTo(0, startTop + Math.max(20, Math.min(150, room - 20)));
      await new Promise((r) => setTimeout(r, 400));
      const cal = document.querySelector('lair-calendar');
      return { position: getComputedStyle(strip).position, var: cal.style.getPropertyValue('--cal-sticky-top'), top: Math.round(strip.getBoundingClientRect().top), headerBottom: Math.round(document.querySelector('.site-header').getBoundingClientRect().bottom) };
    });
    check('events calendar (phone): once the header has gone, the day strip sticks at the very top', Boolean(c) && c.position === 'sticky' && c.var === '0px' && Math.abs(c.top) <= 1 && c.headerBottom <= 0, c ? JSON.stringify(c) : 'no day strip');
    await ctx.close();
  }

  /* ---------- 5. the header at desktop widths: one line, nothing overlapping or clipped ---------- */
  for (const width of [990, 1000, 1100, 1180, 1280, 1440]) {
    const { ctx, page } = await open(width, '/', { height: 800 });
    const r = await page.evaluate(() => {
      const box = (el) => el.getBoundingClientRect();
      const shown = (el) => el && getComputedStyle(el).display !== 'none' && box(el).width > 0;
      const header = document.querySelector('.site-header');
      const inner = header.querySelector('.site-header__inner');
      const nav = header.querySelector('.site-nav');
      const actions = header.querySelector('.site-header__actions');
      const logo = header.querySelector('.site-header__logo');
      const toggle = header.querySelector('.site-header__menu-toggle');
      const pill = header.querySelector('.open-pill');
      const items = [...header.querySelectorAll('.site-nav__list > li')].map((li) => box(li.querySelector('.site-nav__link')));
      const parts = [logo, ...(shown(nav) ? items.map((b) => ({ getBoundingClientRect: () => b })) : []), ...(shown(pill) ? [pill] : []), ...[...actions.querySelectorAll('.icon-button')].filter(shown)].map((el) => box(el));
      let overlap = 0;
      for (let i = 1; i < parts.length; i += 1) if (parts[i].left < parts[i - 1].right - 0.5) overlap += 1;
      const clipped = [...header.querySelectorAll('.site-nav__link, .open-pill, .icon-button')].filter(shown).filter((el) => el.scrollWidth > el.clientWidth + 1 || box(el).right > window.innerWidth || box(el).left < 0).length;
      return {
        nav: shown(nav), toggle: shown(toggle), pill: shown(pill), height: Math.round(box(header).height),
        oneLine: items.every((b) => b.height <= 46), sameRow: items.every((b) => Math.abs(b.top - (items[0] ? items[0].top : 0)) < 1),
        spare: shown(nav) ? Math.round(box(actions).left - box(nav).right) : null, overlap, clipped,
        innerScroll: inner.scrollWidth - inner.clientWidth, pageScroll: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    const ok = r.overlap === 0 && r.clipped === 0 && r.innerScroll <= 0 && r.pageScroll === 0 && r.height <= 80 && (r.nav ? r.oneLine && r.sameRow && r.spare >= 16 && !r.toggle : r.toggle);
    check(`header at ${width}px: ${r.nav ? `the full menu${r.pill ? ' and the open pill' : ''}` : 'the menu button (side menu)'}, one line, nothing overlapping or clipped`, ok, `height ${r.height}px${r.nav ? `, ${r.spare}px spare` : ''}, overlap ${r.overlap}, clipped ${r.clipped}, scroll ${r.innerScroll}/${r.pageScroll}`);
    await ctx.close();
  }

  /* ---------- 6. the shop chips, and the library's ---------- */
  const rows = (page) => page.evaluate(() => {
    const nav = document.querySelector('.tag-chips');
    return {
      label: nav ? nav.getAttribute('aria-label') : null,
      shopClass: document.querySelector('.collection').classList.contains('collection--shop'),
      chipsClass: document.querySelector('.collection').classList.contains('collection--chips'),
      rows: [...document.querySelectorAll('.tag-chips__list')].map((ul) => ({
        label: ul.getAttribute('aria-label'),
        chips: [...ul.querySelectorAll('.tag-chip')].map((c) => ({ text: c.textContent.replace(/\s+/g, ' ').trim(), href: c.getAttribute('href'), current: c.getAttribute('aria-current') === 'true', grey: c.getAttribute('aria-disabled') === 'true', bg: getComputedStyle(c).backgroundColor })),
      })),
    };
  });
  const GAME = [['Magic: The Gathering', 'magic-the-gathering'], ['Pokémon', 'pokemon'], ['Riftbound', 'riftbound-lol'], ['One Piece', 'one-piece'], ['Yu-Gi-Oh!', 'yu-gi-oh'], ['Cyberpunk', 'cyberpunk-tcg'], ['Sleeves and accessories', 'accessories']];
  const SYSTEM = [['Dungeons & Dragons', 'dungeons-dragons'], ['Call of Cthulhu', 'call-of-cthulhu'], ['Other systems', 'other-rpgs'], ['Dice and accessories', 'accessories']];
  const GOBLIN = 'rgb(70, 208, 108)';
  const MANA = 'rgb(60, 200, 216)';
  for (const width of [390, 1280]) {
    const tag = width < 700 ? 'phone' : 'desktop';
    {
      const { ctx, page, errors } = await open(width, '/collections/trading-card-games');
      const r = await rows(page);
      const row = r.rows[0] || { chips: [] };
      const want = GAME.map(([t, h]) => `${t} -> /collections/trading-card-games/${h}`);
      const got = row.chips.slice(1).map((c) => `${c.text} -> ${c.href}`);
      check(`TCG (${tag}): one Game row: All, then each game's tag link`, r.rows.length === 1 && row.label === 'Game' && row.chips[0].text === 'All' && row.chips[0].current && JSON.stringify(got) === JSON.stringify(want), got.map((g) => g.split(' -> ')[0]).join(', '));
      check(`TCG (${tag}): Gundam and Star Wars: Unlimited hidden (no products carry their tags)`, !row.chips.some((c) => /Gundam|Star Wars/.test(c.text)));
      check(`TCG (${tag}): named "Shop filters", the chosen chip in goblin green`, r.label === 'Shop filters' && r.shopClass && row.chips[0].bg === GOBLIN, `${r.label}, ${row.chips[0] && row.chips[0].bg}`);
      if (width < 700) {
        const s = await page.evaluate(() => { const rw = document.querySelector('.tag-chips__row'); return rw ? { scrolls: rw.scrollWidth > rw.clientWidth, page: document.documentElement.scrollWidth - window.innerWidth, tall: Math.min(...[...rw.querySelectorAll('.tag-chip')].map((c) => c.getBoundingClientRect().height)) } : null; });
        check('TCG (phone): the row swipes sideways inside itself, the page doesn\'t, chips 44px tall', Boolean(s) && s.scrolls && s.page === 0 && s.tall >= 44, JSON.stringify(s));
      }
      if (row.chips.some((c) => c.text === 'Pokémon')) {
        await page.click('.tag-chip >> text=Pokémon');
        await page.waitForLoadState('networkidle');
        const after = await rows(page);
        const chosen = after.rows[0] && after.rows[0].chips.find((c) => c.current);
        const count = await page.$$eval('.product-grid > li', (lis) => lis.length);
        const clear = await page.$('.collection__clear');
        check(`TCG (${tag}): tapping Pokémon filters to its tag, the chip is chosen and Clear filters shows`, new URL(page.url()).pathname === '/collections/trading-card-games/pokemon' && chosen && /^Pokémon/.test(chosen.text) && chosen.href === '/collections/trading-card-games' && count >= 1 && Boolean(clear), `${page.url()} | ${count} product(s)`);
      } else {
        check(`TCG (${tag}): tapping Pokémon filters to its tag, the chip is chosen and Clear filters shows`, false, 'no Pokémon chip');
      }
      check(`TCG (${tag}): no console errors`, errors.length === 0, errors.slice(0, 2).join(' / '));
      await ctx.close();
    }
    {
      const { ctx, page } = await open(width, '/collections/role-playing-game');
      const r = await rows(page);
      const row = r.rows[0] || { chips: [] };
      const want = SYSTEM.map(([t, h]) => `${t} -> /collections/role-playing-game/${h}`);
      const got = row.chips.slice(1).map((c) => `${c.text} -> ${c.href}`);
      check(`RPG (${tag}): one System row: All, then each system's tag link`, r.rows.length === 1 && row.label === 'System' && JSON.stringify(got) === JSON.stringify(want), got.map((g) => g.split(' -> ')[0]).join(', '));
      await ctx.close();
    }
    {
      const { ctx, page } = await open(width, '/collections/new-additions');
      const r = await rows(page);
      check(`other collections (${tag}): New Additions has no chip rows (the TCG and RPG chips are theirs alone)`, r.rows.length === 0 && r.label === null && !r.chipsClass && !(await page.$('.collection__chips')));
      await ctx.close();
    }
    {
      const { ctx, page } = await open(width, '/collections/board-game-rental');
      const r = await rows(page);
      const shelf = r.rows.find((x) => x.label === 'Shelf');
      const type = r.rows.find((x) => x.label === 'Type');
      const SHELF = ['All', '1–2 players', '3–4 players', '5–6 players', '7+ players', 'Kids 7 and under', 'RPG books'];
      const TYPE = ['All', 'Strategy', 'Co-op', 'Party', 'Family', 'Deduction', 'Word and trivia', 'Card games', 'Dexterity', 'Adventure', 'Plays solo', '30 min or less', 'Classics'];
      check(`library (${tag}): the Shelf and Type rows as before, named "Library filters", chosen chip in mana blue`, r.rows.length === 2 && shelf && type && JSON.stringify(shelf.chips.map((c) => c.text)) === JSON.stringify(SHELF) && JSON.stringify(type.chips.map((c) => c.text)) === JSON.stringify(TYPE) && r.label === 'Library filters' && !r.shopClass && shelf.chips[0].bg === MANA && shelf.chips[2].href === '/collections/board-game-rental/shelf-3-4-players', `${r.rows.map((x) => `${x.label} ${x.chips.length}`).join(', ')}, ${r.label}`);
      await page.goto(`${BASE}/collections/board-game-rental/shelf-3-4-players`, { waitUntil: 'networkidle' });
      const f = await rows(page);
      const fs3 = f.rows.find((x) => x.label === 'Shelf');
      const ft = f.rows.find((x) => x.label === 'Type');
      const picked = fs3 && fs3.chips.find((c) => c.current);
      const coop = ft && ft.chips.find((c) => c.text === 'Co-op');
      check(`library (${tag}): a shelf filter keeps working (chosen, the type row links add to it, empty types greyed)`, Boolean(picked && coop) && picked.text.startsWith('3–4 players') && coop.href === '/collections/board-game-rental/shelf-3-4-players+co-op' && ft.chips.some((c) => c.grey));
      await ctx.close();
    }
  }

  /* ---------- 7. the Google Maps link ---------- */
  for (const width of [390, 1280]) {
    const tag = width < 700 ? 'phone' : 'desktop';
    const { ctx, page } = await open(width, '/');
    const g = await page.evaluate(() => {
      const card = document.querySelector('.contact-card');
      const address = card.querySelector('.contact-card__address');
      const reviews = card.querySelector('.contact-card__reviews');
      const foot = document.querySelector('.site-footer__visit a.text-link');
      const box = (el) => el.getBoundingClientRect();
      return {
        address: address.getAttribute('href'), directions: address.querySelector('.contact-card__map').textContent.trim(),
        reviews: reviews && reviews.getAttribute('href'), reviewsText: reviews && reviews.textContent.replace(/\s+/g, ' ').trim(),
        reviewsTarget: reviews && reviews.getAttribute('target'), reviewsRel: reviews && reviews.getAttribute('rel'),
        reviewsH: reviews ? Math.round(box(reviews).height) : 0, under: reviews ? Math.round(box(reviews).top - box(address).bottom) : null,
        footer: foot.getAttribute('href'), footerText: foot.textContent.replace(/\s+/g, ' ').trim(),
        reviewsSection: document.querySelectorAll('.reviews').length,
      };
    });
    check(`Maps (${tag}): the contact card's address and Get directions open the Google Maps listing`, g.address === MAPS && g.directions === 'Get directions', g.address);
    check(`Maps (${tag}): "Read our Google reviews" just under Get directions, same link, new tab, 44px tall`, g.reviews === MAPS && /^Read our Google reviews/.test(g.reviewsText) && g.reviewsTarget === '_blank' && /noopener/.test(g.reviewsRel || '') && g.reviewsH >= 44 && g.under >= -1 && g.under <= 12, `${g.reviewsText}, ${g.reviewsH}px, ${g.under}px under`);
    check(`Maps (${tag}): the footer's address opens the listing`, g.footer === MAPS && /Manukau Road/.test(g.footerText), g.footer);
    if (width < 700) check('Maps: the home Reviews section stays switched off (no quotes yet)', g.reviewsSection === 0);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(390, '/pages/contact');
    const c = await page.evaluate(() => ({ address: document.querySelector('.contact-card__address')?.getAttribute('href') || null, reviews: document.querySelector('.contact-card__reviews')?.getAttribute('href') || null }));
    check('Maps: the contact page\'s card uses the listing too', c.address === MAPS && c.reviews === MAPS, JSON.stringify(c));
    await ctx.close();
  }
  {
    const saved = m.globalSettings.google_maps_url;
    m.globalSettings.google_maps_url = '';
    const { ctx, page } = await open(390, '/');
    const f = await page.evaluate(() => ({ address: document.querySelector('.contact-card__address').getAttribute('href'), reviews: document.querySelectorAll('.contact-card__reviews').length, footer: document.querySelector('.site-footer__visit a.text-link').getAttribute('href') }));
    m.globalSettings.google_maps_url = saved;
    const search = 'https://www.google.com/maps/search/?api=1&query=';
    check('Maps: blank setting falls back to the Maps search for the address, and the reviews link hides', f.address.startsWith(search) && f.footer.startsWith(search) && /Manukau/.test(decodeURIComponent(f.address)) && f.reviews === 0, f.address.slice(0, 90));
    await ctx.close();
  }
  {
    const raw = fs.readFileSync(path.join(THEME, 'templates/index.json'), 'utf8').replace(/^\s*\/\*[\s\S]*?\*\//, '');
    const reviews = JSON.parse(raw).sections.reviews;
    check('Maps: index.json\'s Reviews section links to the listing and stays disabled', reviews.disabled === true && reviews.settings.link === MAPS, `${reviews.settings.link_label} -> ${reviews.settings.link}`);
    check('Maps: the theme setting defaults to the listing', m.globalSettings.google_maps_url === MAPS, m.globalSettings.google_maps_url);
  }
} catch (error) {
  check('the run itself', false, String(error.stack || error).slice(0, 400));
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${results.length - fails} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);

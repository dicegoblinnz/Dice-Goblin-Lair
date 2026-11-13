// The search box's suggestions with shelf codes (14 Nov 2026; Mo: "display the QR code like DGL34-M011 as a tag instead
// of the library tag during search, if it has a code then it's clearly library if it doesn't it is for sale"), on the
// theme mock. The theme draws the suggestions in Liquid now (sections/predictive-search.liquid, asked for with
// /search/suggest?section_id=predictive-search), so a library game shows its shelf code where a shop product shows its
// price. Checked at 320, 360, 390, 480 and 1280px, with the shrunk script and the full one:
//   1. the box asks Shopify for the section, with the options it always sent, and never for the JSON
//   2. a library game: its name without "(Library)", its shelf code in the library badge, no price and no "Library" word
//   3. a shop game: its price, no badge; both kinds side by side in one answer
//   4. the rule is the code, not the title or the price: a copy with no "(Library)" in its name, and a priced RPG book
//   5. the code stays whole on one line; on a phone (under 480px) the price or code sits under the name, which keeps
//      the row's width, and from 480px it ends the row; nothing runs off the sheet, no sideways scroll
//   6. the same code as the game's card on the results page
//   7. sold-out products stay out; nothing found brings Gobgob, and See all keeps the sold-out ones hidden; the words
//      typed read as typed and See all searches for exactly them (Shopify hands Liquid the terms HTML-escaped, and the
//      mock does too: a link built from them in Liquid searched for "d&amp;d")
//   8. collections and pages as plain rows
//   9. a screen reader hears "Library game, shelf code" before the code; the arrow keys and Enter still work
//  10. an older answer never lands on a newer one, on an emptied box (not even for the 220ms the box waits for a
//      pause in the typing) or on a closed sheet; a failed answer leaves the box working (Enter still searches)
//  11. axe on the open sheet (when AXE is set)
// Usage: DG_THEME=/path/to/theme [PORT=4987] [AXE=/path/to/axe.min.js] [OUT=/dir] node tools/qa/search-codes/search.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
const PORT = Number(process.env.PORT || 4987);
const BASE = `http://localhost:${PORT}`;
const AXE = process.env.AXE && fs.existsSync(process.env.AXE) ? fs.readFileSync(process.env.AXE, 'utf8') : null;
const OUT = process.env.OUT || '';
if (OUT) fs.mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  return ok;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const INPUT = '#search-modal [data-search-input]';
const RESULTS = '#predictive-results';

/** Every request the search box made, newest last */
const asked = (page) => page.suggests;
async function open(page) {
  await page.locator('[data-dialog-open="search-modal"]:visible').first().click();
  await page.waitForSelector('#search-modal[open]');
  await wait(250);
}
/** Type into the box and wait for Shopify's answer to be on the page */
async function type(page, q, { settle = true } = {}) {
  const answered = settle ? page.waitForResponse((r) => r.url().includes('/search/suggest') && new URL(r.url()).searchParams.get('q') === q.trim(), { timeout: 8000 }) : null;
  await page.fill(INPUT, q);
  if (answered) {
    await answered;
    await wait(80);
  }
}
/** The suggestions as someone sees them: hidden screen-reader words left out of `seen` */
const rows = (page) => page.evaluate((sel) => {
  const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const seen = (el) => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('.visually-hidden').forEach((n) => n.remove());
    return flat(copy.textContent);
  };
  const box = document.querySelector(sel);
  const sheet = document.querySelector('#search-modal').getBoundingClientRect();
  return [...box.querySelectorAll('.predictive__item')].map((a) => {
    const badge = a.querySelector('.badge');
    const price = a.querySelector('.price');
    const title = a.querySelector('.predictive__title');
    const r = a.getBoundingClientRect();
    const b = badge ? badge.getBoundingClientRect() : null;
    const t = title.getBoundingClientRect();
    const tail = (badge || price)?.getBoundingClientRect();
    return {
      id: a.id,
      role: a.getAttribute('role'),
      href: a.getAttribute('href'),
      selected: a.getAttribute('aria-selected'),
      title: flat(title.textContent),
      seen: seen(a),
      heard: flat(a.textContent),
      code: badge ? seen(badge) : '',
      library: Boolean(badge && badge.classList.contains('badge--library')),
      price: price ? flat(price.textContent) : '',
      height: Math.round(r.height),
      inside: r.left >= sheet.left - 0.5 && r.right <= sheet.right + 0.5,
      // one line: the badge is no taller than a single line of its text needs
      codeLines: badge ? badge.getClientRects().length : 0,
      codeHeight: b ? Math.round(b.height) : 0,
      codeInside: b ? b.right <= r.right + 0.5 && b.left >= r.left - 0.5 : true,
      // where the price or code sits: under the name (a phone) or after it on the same line
      under: tail ? tail.top >= t.bottom - 0.5 && Math.abs(tail.left - t.left) < 1 : null,
      after: tail ? tail.left >= t.right - 0.5 && tail.top < t.bottom && tail.bottom > t.top && Math.abs(tail.right - (r.right - parseFloat(getComputedStyle(a).paddingRight))) < 1 : null,
      titleWidth: Math.round(t.width),
      titleLines: Math.round(t.height / parseFloat(getComputedStyle(title).lineHeight)),
      // the room the name has: from where it starts to the end of the row's own space (or to the price or code beside it)
      titleRoom: Math.round((tail && tail.top < t.bottom ? tail.left - parseFloat(getComputedStyle(a).columnGap) : r.right - parseFloat(getComputedStyle(a).paddingRight)) - t.left),
      thumb: Boolean(a.querySelector('.predictive__thumb')),
    };
  });
}, RESULTS);
const state = (page) => page.evaluate(([inputSel, sel]) => {
  const input = document.querySelector(inputSel);
  const box = document.querySelector(sel);
  const sheet = document.querySelector('#search-modal');
  return {
    value: input.value,
    expanded: input.getAttribute('aria-expanded'),
    active: input.getAttribute('aria-activedescendant'),
    html: box.innerHTML.trim().length,
    text: box.textContent.replace(/\s+/g, ' ').trim(),
    gob: Boolean(box.querySelector('.predictive__empty img.gobgob')),
    all: box.querySelector('a.text-link')?.getAttribute('href') || '',
    allText: (box.querySelector('a.text-link')?.textContent || '').replace(/\s+/g, ' ').trim(),
    headings: [...box.querySelectorAll('.predictive__heading')].map((h) => h.textContent.trim()),
    sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    sheetSideways: sheet.scrollWidth - sheet.clientWidth,
    open: sheet.open,
  };
}, [INPUT, RESULTS]);
async function scan(page, label) {
  if (!AXE) return;
  await page.addScriptTag({ content: AXE });
  const found = await page.evaluate(async () => {
    const r = await window.axe.run(document.querySelector('#search-modal'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  });
  check(`axe: ${label}`, !found.length, found.join(' / '));
}
const shot = async (page, name) => {
  if (OUT) await page.screenshot({ path: path.join(OUT, `${name}.png`) });
};

const server = await m.serve(PORT);
const browser = await chromium.launch();
const SIZES = [[320, 640], [360, 740], [390, 844], [480, 900], [1280, 800]];
for (const full of [false, true]) {
  // Theme settings › Lair bookings › Use full scripts: the file as written, or its shrunk copy (theme.min.js)
  m.globalSettings.full_scripts = full;
  for (const [w, h] of SIZES) {
    const phone = w < 750;
    const stacked = w < 480; // base.css: under 480px the price or code sits under the name
    const tag = `${w}px ${full ? 'full' : 'shrunk'}:`;
    console.log(`\n== ${w}px, ${full ? 'theme.js' : 'theme.min.js'} ==`);
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
    const page = await ctx.newPage();
    page.suggests = [];
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (r.url().includes('/search/suggest')) page.suggests.push(new URL(r.url()));
    });
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const script = await page.evaluate(() => [...document.scripts].map((s) => s.src).find((s) => /\/theme(\.min)?\.js/.test(s)) || '');
    check(`${tag} the page runs ${full ? 'theme.js' : 'theme.min.js'}`, full ? /\/theme\.js/.test(script) : /\/theme\.min\.js/.test(script), script);

    /* 1 and 2: a library game */
    await open(page);
    await type(page, 'codenames');
    let list = await rows(page);
    let s = await state(page);
    const last = asked(page)[asked(page).length - 1];
    check(`${tag} 1. the box asks for the section, with the options it always sent`,
      last && last.pathname === '/search/suggest' && last.searchParams.get('section_id') === 'predictive-search' && last.searchParams.get('q') === 'codenames'
        && last.searchParams.get('resources[type]') === 'product,collection,page' && last.searchParams.get('resources[limit]') === '6' && last.searchParams.get('resources[options][unavailable_products]') === 'hide',
      last ? last.search : 'no request');
    check(`${tag} 2. a library game shows its shelf code in the library badge`, list.length === 1 && list[0].library && list[0].code === 'DGL7+-015', list);
    check(`${tag} 2. its name without "(Library)", no price and no "Library" word to read`, list[0]?.title === 'Codenames' && list[0].price === '' && list[0].seen === 'Codenames DGL7+-015', list[0]);
    check(`${tag} 2. the list is open, under Products`, s.expanded === 'true' && s.headings.join() === 'Products', s);

    /* 3: a shop game, and both kinds together */
    await type(page, 'wingspan');
    list = await rows(page);
    check(`${tag} 3. a shop game shows its price and no badge`, list.length === 1 && list[0].title === 'Wingspan' && list[0].price === '$95.00' && list[0].code === '' && !list[0].library, list);
    await type(page, 'span');
    list = await rows(page);
    const shopRow = list.find((r) => r.title === 'Wingspan');
    const libRow = list.find((r) => r.title === 'Wyrmspan');
    check(`${tag} 3. in one answer: Wingspan with $95.00, the library's Wyrmspan with DGL56-157`, list.length === 2 && shopRow?.price === '$95.00' && !shopRow.code && libRow?.code === 'DGL56-157' && !libRow.price, list);
    check(`${tag} 5. the price and the code sit in the same place: ${stacked ? 'under the name' : 'at the end of the row'}`, list.every((r) => (stacked ? r.under : r.after)), list.map((r) => [r.title, r.under, r.after]));
    await shot(page, `${w}-${full ? 'full' : 'shrunk'}-span`);
    await scan(page, `${tag} a shop game and a library game`);

    /* 4: the code decides, not the name or the price */
    await type(page, 'paladins');
    list = await rows(page);
    check(`${tag} 4. a library copy with no "(Library)" in its name still shows its code`, list.length === 1 && list[0].title === 'Paladins of the West Kingdom' && list[0].code === 'DGL34-094' && list[0].library, list);
    await type(page, 'bigby');
    list = await rows(page);
    check(`${tag} 4. a library RPG book with a price shows its code, never the price`, list.length === 1 && list[0].code === 'DGLRPG-008' && list[0].price === '' && !/\$/.test(list[0].seen), list);
    await type(page, 'membership');
    list = (await rows(page)).filter((r) => r.role === 'option');
    check(`${tag} 4. the library membership has no shelf code, so it shows its price`, list.length === 1 && /membership/i.test(list[0].title) && /^\$\d/.test(list[0].price) && !list[0].code, list);

    /* 5: the layout, with the mock's six library games (the longest name beside its code) */
    await type(page, 'library');
    list = await rows(page);
    s = await state(page);
    const long = list.find((r) => /221B Baker Street/.test(r.title));
    check(`${tag} 5. six suggestions, each a library game with a code`, list.length === 6 && list.every((r) => r.library && /^DGL[A-Z0-9+]+-[SML]?\d{3}$/.test(r.code)), list.map((r) => r.code));
    check(`${tag} 5. every code is whole on one line (${list.map((r) => r.codeHeight).join(', ')}px tall)`, list.every((r) => r.codeLines === 1 && r.codeHeight <= 28), list.map((r) => [r.code, r.codeLines, r.codeHeight]));
    check(`${tag} 5. every code sits ${stacked ? 'under its name, in line with it' : 'at the end of its row, beside the name'}`, list.every((r) => (stacked ? r.under : r.after)), list.map((r) => [r.title, r.under, r.after]));
    check(`${tag} 5. the longest name has room: ${long?.titleRoom}px, on ${long?.titleLines} line${long?.titleLines === 1 ? '' : 's'}`, Boolean(long) && long.titleRoom >= 150 && long.titleLines <= (w < 360 ? 3 : 2) && list.every((r) => r.titleRoom >= 150), list.map((r) => [r.title, r.titleRoom, r.titleLines]));
    check(`${tag} 5. every row sits inside the sheet, 44px or more to tap`, list.every((r) => r.inside && r.codeInside && r.height >= 44 && r.thumb), list.map((r) => [r.inside, r.codeInside, r.height]));
    check(`${tag} 5. no sideways scroll, on the page or in the sheet`, s.sideways <= 0 && s.sheetSideways <= 0, s);
    await shot(page, `${w}-${full ? 'full' : 'shrunk'}-library`);
    await scan(page, `${tag} six library games`);

    /* 9: what a screen reader hears, and the keys */
    const heard = await page.locator(RESULTS).ariaSnapshot();
    check(`${tag} 9. a screen reader hears "Library game, shelf code" before the code`, /option "7 Wonders Duel Library game, shelf code DGL12-001"/.test(heard) && /listbox "Products"/.test(heard), heard);
    if (!phone) {
      await page.focus(INPUT);
      await page.keyboard.press('ArrowDown');
      let k = await state(page);
      list = await rows(page);
      check(`${tag} 9. Arrow down picks the first suggestion`, k.active === 'ps-0' && list[0].selected === 'true' && list.filter((r) => r.selected === 'true').length === 1, k);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowUp');
      k = await state(page);
      list = await rows(page);
      check(`${tag} 9. Arrow keys move through them`, k.active === 'ps-1' && list[1].selected === 'true' && list.filter((r) => r.selected === 'true').length === 1, k);
      check(`${tag} 9. every suggestion has an id of its own`, new Set(list.map((r) => r.id)).size === list.length && list.every((r) => r.role === 'option' && /^ps-\d+$/.test(r.id)), list.map((r) => r.id));
      await type(page, 'span');
      k = await state(page);
      check(`${tag} 9. a new answer forgets the old pick`, k.active === null && (await rows(page)).every((r) => r.selected === 'false'), k);
      await page.keyboard.press('ArrowDown');
      const first = (await rows(page))[0];
      await Promise.all([page.waitForURL((u) => u.pathname.startsWith('/products/')), page.keyboard.press('Enter')]);
      check(`${tag} 9. Enter opens the picked game`, new URL(page.url()).pathname === new URL(first.href, BASE).pathname, page.url());
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      await open(page);
    }

    /* 7: sold out stays out; nothing found */
    await type(page, 'Ark Nova');
    s = await state(page);
    list = await rows(page);
    check(`${tag} 7. a sold-out product isn't suggested: nothing found, with Gobgob`, list.length === 0 && s.gob && /Nothing found for “Ark Nova”/.test(s.text), s);
    check(`${tag} 7. See all keeps sold-out products hidden and names the search`, /^\/search\?q=Ark(\+|%20)Nova&options%5Bprefix%5D=last&options%5Bunavailable_products%5D=hide$/.test(s.all) && s.allText === 'See all results for “Ark Nova”', s);
    await shot(page, `${w}-${full ? 'full' : 'shrunk'}-nothing`);
    await scan(page, `${tag} nothing found`);
    await type(page, '<img src=x onerror=alert(1)>');
    s = await state(page);
    check(`${tag} 7. what was typed is shown as words, never run as HTML`, /Nothing found for “<img src=x onerror=alert\(1\)>”/.test(s.text) && !(await page.locator(`${RESULTS} img[src="x"]`).count()), s.text);
    // Shopify hands Liquid the search words already HTML-escaped (the mock does too): the words must read as typed,
    // and See all results must search for what was typed, not for "d&amp;d"
    // ...and a backslash: Shopify's replace filter reads one in the words it puts in as an instruction (the mock's does too)
    for (const typed of ['d&d', `it's "a<b" & c`, 'zzq\\0x\\\\y']) {
      await type(page, typed);
      s = await state(page);
      const all = new URL(s.all || '/', BASE);
      check(`${tag} 7. See all results searches for exactly what was typed: ${typed}`, all.pathname === '/search' && all.searchParams.get('q') === typed && all.searchParams.get('options[unavailable_products]') === 'hide' && s.allText === `See all results for “${typed}”`, { all: s.all, allText: s.allText });
      if (/Nothing found/.test(s.text)) check(`${tag} 7. nothing found reads as typed: ${typed}`, s.text.includes(`Nothing found for “${typed}”`), s.text);
    }
    await type(page, 'd&d');
    list = (await rows(page)).filter((r) => r.role === 'option');
    check(`${tag} 7. "d&d" finds the D&D books: the library's with its code, the shop's with its price`, list.some((r) => /^D&D Bigby/.test(r.title) && r.code === 'DGLRPG-008') && list.some((r) => /^D&D Player/.test(r.title) && r.price === '$85.00'), list.map((r) => [r.title, r.code, r.price]));

    /* 8: collections and pages */
    await type(page, 'board');
    s = await state(page);
    list = await rows(page);
    const plain = list.filter((r) => !r.role);
    check(`${tag} 8. collections and pages come as plain rows under Collections`, s.headings.join() === 'Products,Collections' && plain.length === 3 && plain.every((r) => !r.code && !r.price && r.inside && r.height >= 44), { headings: s.headings, plain });
    check(`${tag} 8. a plain row's name has the whole row to itself (${plain[0]?.titleRoom}px)`, plain.every((r) => r.titleRoom >= (phone ? 200 : 300)), plain.map((r) => r.titleRoom));

    /* 6: the results page says the same */
    await type(page, 'codenames');
    const inBox = (await rows(page))[0]?.code;
    const allHref = (await state(page)).all;
    await page.goto(`${BASE}${allHref}`, { waitUntil: 'networkidle' });
    const onCard = await page.evaluate(() => [...document.querySelectorAll('.product-card .badge--library')].map((b) => b.textContent.trim()));
    check(`${tag} 6. the results page's card shows the same code (${inBox})`, inBox === 'DGL7+-015' && onCard.length === 1 && onCard[0] === inBox, { inBox, onCard });

    /* 7, on the results page: Clear filters goes back to the search as typed (snippets/facets.liquid) */
    await page.goto(`${BASE}/search?q=${encodeURIComponent('d&d')}&options%5Bprefix%5D=last&options%5Bunavailable_products%5D=hide&filter.v.price.gte=10`, { waitUntil: 'networkidle' });
    const clears = await page.evaluate(() => [...document.querySelectorAll('a.facets__clear, a.facets__clear-all')].map((a) => a.getAttribute('href')));
    check(`${tag} 7. the results page's Clear filters goes back to the search as typed (d&d)`, clears.length >= 1 && clears.every((href) => new URL(href, 'http://x').searchParams.get('q') === 'd&d' && new URL(href, 'http://x').searchParams.get('options[unavailable_products]') === 'hide'), clears);

    /* 10: answers out of order, and a failed one */
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    const before = asked(page).length;
    // "wing" is slow, everything else is quick
    await page.route((u) => u.pathname === '/search/suggest' && u.searchParams.get('q') === 'wing', async (route) => {
      await wait(1200);
      await route.continue().catch(() => {});
    });
    await open(page);
    await type(page, 'wing', { settle: false });
    await wait(350); // the slow search has gone out
    await type(page, 'codenames');
    await wait(1500); // the slow answer would be here by now
    list = await rows(page);
    check(`${tag} 10. a slow older answer never lands on a newer one`, asked(page).length - before === 2 && list.length === 1 && list[0].title === 'Codenames', { asked: asked(page).slice(before).map((u) => u.searchParams.get('q')), list: list.map((r) => r.title) });
    await type(page, 'wing', { settle: false });
    await wait(350);
    await page.fill(INPUT, '');
    await wait(1500);
    s = await state(page);
    check(`${tag} 10. emptying the box drops a search on its way: the list stays empty and closed`, s.html === 0 && s.expanded === 'false', s);
    // ...and at once, not when the typing pause ends (220ms): an answer landing just after the box is emptied is never drawn
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route((u) => u.pathname === '/search/suggest' && u.searchParams.get('q') === 'jenga', async (route) => {
      await gate;
      await route.continue().catch(() => {});
    });
    const gone = page.waitForRequest((r) => r.url().includes('/search/suggest') && new URL(r.url()).searchParams.get('q') === 'jenga');
    await type(page, 'jenga', { settle: false });
    await gone;
    await page.fill(INPUT, '');
    await page.evaluate((sel) => {
      const box = document.querySelector(sel);
      window.drawnAfterEmptying = box.innerHTML.trim().length > 0;
      new MutationObserver(() => {
        if (box.innerHTML.trim()) window.drawnAfterEmptying = true;
      }).observe(box, { childList: true, subtree: true });
    }, RESULTS);
    release();
    await wait(700);
    s = await state(page);
    check(`${tag} 10. an answer landing just after the box is emptied is never drawn, not even for a moment`, (await page.evaluate(() => window.drawnAfterEmptying)) === false && s.html === 0 && s.expanded === 'false', s);
    await type(page, 'wing', { settle: false });
    await wait(350);
    await page.click('#search-modal [data-dialog-close]'); // (Escape would first empty the search field)
    await wait(1600);
    s = await state(page);
    check(`${tag} 10. closing the sheet drops a search on its way`, !s.open && s.html === 0 && s.value === '', s);
    await open(page);
    s = await state(page);
    check(`${tag} 10. reopened, the sheet is empty and ready`, s.open && s.html === 0 && s.value === '' && s.expanded === 'false' && s.active === null, s);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await type(page, 'codenames');
    await page.route((u) => u.pathname === '/search/suggest' && u.searchParams.get('q') === 'cascadia', (route) => route.fulfill({ status: 500, contentType: 'text/html', body: 'Internal Server Error' }));
    await type(page, 'cascadia');
    s = await state(page);
    check(`${tag} 10. a failed answer shows no suggestions, and no old ones`, s.html === 0 && s.expanded === 'false', s);
    await Promise.all([page.waitForURL((u) => u.pathname === '/search'), page.keyboard.press('Enter')]);
    const landed = new URL(page.url());
    check(`${tag} 10. Enter still searches: the results page, sold-out products hidden`, landed.searchParams.get('q') === 'cascadia' && landed.searchParams.get('options[unavailable_products]') === 'hide' && landed.searchParams.get('options[prefix]') === 'last', page.url());
    await page.unrouteAll({ behavior: 'ignoreErrors' });

    check(`${tag} 1. the search box never asked for the JSON`, !page.suggests.some((u) => u.pathname.endsWith('.json')), page.suggests.map((u) => u.pathname));
    check(`${tag} no script errors`, !errors.length, errors);
    await ctx.close();
  }
}
await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

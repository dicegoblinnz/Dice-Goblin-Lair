// Round 16 (16 Oct 2026), the library's numbers, on the theme mock. Mo asked for the site to say exactly what the
// library has, not "500+ games". The theme counts it live from Shopify (snippets/library-numbers.liquid): [games] is
// the library less its RPG books and the membership product, [rpg_books] the Library RPG books collection, [library]
// the two together. The mock holds the store's counts on 16 Oct 2026 (681 in the library collection with the
// membership, 136 RPG books), so the pages should say 544 games and 136 RPG books, 680 in all.
//   1. Files: no vague count left in the theme's copy (templates, section groups, locales, schema defaults, the My
//      Library script); the Library theme settings exist and point at the store's collections and membership; each
//      place that said 500+ holds a token now.
//   2. Pages, phone and desktop: the hero fact, the announcement bar (switched on in a copy of the theme for this
//      check), the library page (intro, plan ticks, See all on one line), the membership page, the bookings page's
//      house rules and their FAQ structured data, the library collection's count (whole, the RPG shelf and a game
//      filter) and My Library's invite for someone without a plan. No token or 500 shows, and no sideways scroll.
//   3. Live: change the store's counts and the hero follows.
// Usage: DG_THEME=/path/to/theme [PORT=4976] node tools/qa/round16/library-numbers.mjs [phone|desktop]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const THEME = process.env.DG_THEME;
if (!THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}

/* the announcement bar is off in the theme; switch it on in a copy, so its message renders */
const COPY = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-library-numbers-'));
fs.cpSync(THEME, COPY, { recursive: true, filter: (src) => !/[\\/]\.git([\\/]|$)/.test(src) });
const groupFile = path.join(COPY, 'sections/header-group.json');
const group = JSON.parse(fs.readFileSync(groupFile, 'utf8'));
const announcementId = Object.keys(group.sections).find((id) => group.sections[id].type === 'announcement-bar');
if (announcementId) group.sections[announcementId].disabled = false;
fs.writeFileSync(groupFile, JSON.stringify(group, null, 2));
process.env.DG_THEME = COPY;

const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4976);
const BASE = `http://localhost:${PORT}`;
const SIZES = [['phone', 390, 844], ['desktop', 1280, 800]].filter(([tag]) => !process.argv[2] || tag === process.argv[2]);
const SHOTS = process.env.OUT || path.join(os.tmpdir(), 'dg-round16-library-numbers');
fs.mkdirSync(SHOTS, { recursive: true });
const PLAIN = { id: 7700500003, first_name: 'Pat', last_name: 'Reader', name: 'Pat Reader', email: 'pat.reader@example.com', phone: null, tags: [], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' && detail !== undefined ? ` | ${typeof detail === 'string' ? detail.slice(0, 260) : JSON.stringify(detail).slice(0, 260)}` : ''}`);
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const read = (p) => fs.readFileSync(path.join(THEME, p), 'utf8');
const readJson = (p) => JSON.parse(read(p).replace(/^\s*\/\*[\s\S]*?\*\//, ''));
const VAGUE = /500\s*\+|over 500|more than 500|about 600|\b500 (board )?games|hundreds of games/i;
const TOKEN = /\[(games|rpg_books|library)\]/;

/* ---------- 1. files ---------- */
{
  const files = [
    ...fs.readdirSync(path.join(THEME, 'templates')).filter((f) => f.endsWith('.json')).map((f) => `templates/${f}`),
    ...fs.readdirSync(path.join(THEME, 'sections')).filter((f) => f.endsWith('.json')).map((f) => `sections/${f}`),
    ...fs.readdirSync(path.join(THEME, 'locales')).map((f) => `locales/${f}`),
    'config/settings_data.json',
    'assets/lair-my-library.js',
  ];
  const vague = files.filter((f) => VAGUE.test(read(f)));
  const schemas = fs.readdirSync(path.join(THEME, 'sections')).filter((f) => f.endsWith('.liquid'))
    .filter((f) => VAGUE.test((read(`sections/${f}`).match(/\{% schema %\}([\s\S]*?)\{% endschema %\}/) || ['', ''])[1]));
  check('files: no vague count in the copy (templates, groups, locales, settings, My Library script)', vague.length === 0, vague.join(', '));
  check('files: no vague count in a section schema default', schemas.length === 0, schemas.join(', '));

  const schema = readJson('config/settings_schema.json');
  const lib = schema.find((g) => g.name === 'Library');
  const ids = (lib?.settings || []).map((s) => `${s.id}:${s.type}`);
  check('files: Theme settings > Library has the library collection, membership product and RPG books collection',
    ['library_collection:collection', 'library_membership:product', 'library_rpg_collection:collection'].every((x) => ids.includes(x)), ids.join(', '));
  const cur = readJson('config/settings_data.json').current;
  check('files: they point at the store (board-game-rental, board-game-rental-monthly, library-rpg-books)',
    cur.library_collection === 'board-game-rental' && cur.library_membership === 'board-game-rental-monthly' && cur.library_rpg_collection === 'library-rpg-books',
    [cur.library_collection, cur.library_membership, cur.library_rpg_collection].join(', '));

  const index = readJson('templates/index.json');
  const library = readJson('templates/page.board-game-rental.json');
  const membership = readJson('templates/product.membership.json');
  const bookings = readJson('templates/page.bookings.json');
  const header = readJson('sections/header-group.json');
  const ofType = (t, type) => Object.values(t.sections).find((s) => s.type === type);
  const announce = ofType(header, 'announcement-bar');
  const tokens = {
    'hero fact': index.sections.hero.blocks['fact-games'].settings.big,
    'announcement': Object.values(announce?.blocks || {}).map((b) => b.settings.text).find((t) => TOKEN.test(t)) || '',
    'library intro': ofType(library, 'page-intro').settings.text,
    'library ticks': ofType(library, 'library-plans').settings.includes,
    'membership intro': ofType(membership, 'page-intro').settings.text,
    'membership ticks': ofType(membership, 'library-plans').settings.includes,
    'bookings answer': bookings.sections.rules.blocks.q1.settings.answer,
  };
  const missing = Object.entries(tokens).filter(([, v]) => !TOKEN.test(v)).map(([k]) => k);
  check('files: each place that said 500+ holds a live token', missing.length === 0, missing.length ? missing.join(', ') : Object.values(tokens).map((v) => flat(v).slice(0, 40)).join(' | '));
  check('files: the hero facts read "[games]" over "games to play or borrow" and "[rpg_books]" over "RPG books"', tokens['hero fact'] === '[games]' && index.sections.hero.blocks['fact-games'].settings.small === 'games to play or borrow'
    && index.sections.hero.blocks['fact-rpgs'].settings.big === '[rpg_books]' && index.sections.hero.blocks['fact-rpgs'].settings.small === 'RPG books');
}

/* ---------- the numbers the store gives ---------- */
const libraryCollection = m.collections['board-game-rental'];
const rpgCollection = m.collections['library-rpg-books'];
const membershipIn = (m.allProducts['board-game-rental-monthly'].collections || []).some((c) => c.handle === 'board-game-rental');
const LIB = libraryCollection.all_products_count - (membershipIn ? 1 : 0);
const RPG = rpgCollection.all_products_count;
const GAMES = LIB - RPG;
check('mock: the store\'s counts on 16 Oct 2026 (544 games and 136 RPG books, 680 in all)', GAMES === 544 && RPG === 136 && LIB === 680, { GAMES, RPG, LIB });

/* ---------- 2. pages ---------- */
const server = await m.serve(PORT);
const browser = await chromium.launch();
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const leftovers = (page) => page.evaluate(() => {
  const text = document.body.innerText;
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent).join(' ');
  return { token: /\[(games|rpg_books|library)\]/.test(text + ld), vague: /500\s*\+|over 500|more than 500|about 600|\b500 (board )?games/i.test(text + ld) };
});

for (const [tag, width, height] of SIZES) {
  const phone = width < 700;
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const go = async (url, who = null) => {
    m.mockState.customer = who;
    await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(150);
  };
  const clean = async (label) => {
    const l = await leftovers(page);
    check(`${tag} ${label}: no token or 500 shows (page or structured data), no sideways scroll`, !l.token && !l.vague && (await overflow(page)) <= 0, l);
  };

  // home: the hero fact and the announcement bar
  await go('/');
  const home = await page.evaluate(() => ({
    facts: [...document.querySelectorAll('.hero-fact')].map((f) => f.textContent.replace(/\s+/g, ' ').trim()),
    big: (() => {
      const f = [...document.querySelectorAll('.hero-fact')].find((x) => /to play or borrow/.test(x.textContent));
      const big = f?.querySelector('.hero-fact__big');
      return big ? { text: big.textContent.trim(), lines: big.getClientRects().length } : null;
    })(),
    announce: [...document.querySelectorAll('.announcement__item')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
  }));
  check(`${tag} home: the hero fact says the live number, "${GAMES} games to play or borrow"`, home.facts.includes(`${GAMES} games to play or borrow`), home.facts.join(' | '));
  check(`${tag} home: its big number is on one line`, home.big && home.big.text === String(GAMES) && home.big.lines === 1, home.big);
  check(`${tag} home: the games at one end of the strip and "${RPG} RPG books" at the other (Mo, 16 Oct 2026)`, home.facts[0] === `${GAMES} games to play or borrow` && home.facts.at(-1) === `${RPG} RPG books`, home.facts.join(' | '));
  check(`${tag} announcement bar (on for this check): "${GAMES} games to play in store", in both copies of the marquee`, home.announce.filter((t) => t === `${GAMES} games to play in store`).length === 2, home.announce.join(' | '));
  await clean('home');

  // the library page
  await go('/pages/board-game-rental');
  const libPage = await page.evaluate(() => ({
    intro: document.querySelector('.page-intro .lede')?.textContent.trim() || '',
    ticks: [...document.querySelectorAll('.plans-includes li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
    seeAll: (() => {
      const a = document.querySelector('.library-shelves__more a');
      if (!a) return null;
      // the words' line boxes (the arrow icon sits at its own height, so only text counts)
      const tops = new Set();
      const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) if (r.width > 2) tops.add(Math.round(r.top));
      }
      const lines = tops.size;
      return { text: a.textContent.replace(/\s+/g, ' ').trim(), lines, fits: a.scrollWidth <= a.clientWidth + 1 };
    })(),
  }));
  check(`${tag} library page: the intro says "${GAMES} games and ${RPG} RPG books to take home"`, libPage.intro.startsWith(`${GAMES} games and ${RPG} RPG books to take home.`), libPage.intro);
  check(`${tag} library page: the first tick is "The whole library, ${GAMES} games and ${RPG} RPG books"`, libPage.ticks[0] === `The whole library, ${GAMES} games and ${RPG} RPG books`, libPage.ticks.join(' | '));
  await page.locator('.library-shelves__more').screenshot({ path: path.join(SHOTS, `${tag}-see-all.png`) }).catch(() => {});
  check(`${tag} library page: See all says "${LIB} games and RPG books", on one line`, libPage.seeAll && libPage.seeAll.text === `See all ${LIB} games and RPG books` && libPage.seeAll.lines === 1 && libPage.seeAll.fits, libPage.seeAll);
  await clean('library page');

  // the membership product page
  await go('/products/board-game-rental-monthly');
  const memPage = await page.evaluate(() => ({
    intro: document.querySelector('.page-intro .lede')?.textContent.trim() || '',
    ticks: [...document.querySelectorAll('.plans-includes li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
  }));
  check(`${tag} membership page: the intro says "Borrow from ${GAMES} games and ${RPG} RPG books"`, memPage.intro.startsWith(`Borrow from ${GAMES} games and ${RPG} RPG books, keep them`), memPage.intro);
  check(`${tag} membership page: the first tick has the live numbers`, memPage.ticks[0] === `The whole library, ${GAMES} games and ${RPG} RPG books`, memPage.ticks.join(' | '));
  await clean('membership page');

  // the bookings page's house rules, and the same answer in their FAQ structured data
  await go('/pages/book-a-table');
  const rules = await page.evaluate(() => {
    const body = [...document.querySelectorAll('.rules__body')].map((b) => b.textContent.replace(/\s+/g, ' ').trim());
    let ld = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const j = JSON.parse(s.textContent);
        if (j['@type'] === 'FAQPage') ld = ld.concat(j.mainEntity.map((q) => q.acceptedAnswer.text));
      } catch { /* another block */ }
    }
    return { body, ld };
  });
  const phrase = `you can play any of the ${GAMES} games in our library while you're here`;
  check(`${tag} bookings: the table answer says "any of the ${GAMES} games in our library"`, rules.body.some((t) => t.includes(phrase)), rules.body[0]);
  check(`${tag} bookings: and so does its FAQ structured data`, rules.ld.some((t) => t.includes(phrase)), rules.ld[0]);
  await clean('bookings page');

  // the library collection's count: the whole library, the RPG shelf, a game filter
  const status = () => page.evaluate(() => ({
    status: document.querySelector('.collection__toolbar [role="status"]')?.childNodes[0]?.textContent.trim() || '',
    cards: document.querySelectorAll('.collection__main [data-results] .product-card, .collection__main .product-card').length,
  }));
  await go('/collections/board-game-rental');
  const whole = await status();
  check(`${tag} library collection: "${GAMES} games and ${RPG} RPG books"`, whole.status === `${GAMES} games and ${RPG} RPG books`, whole.status);
  await clean('library collection');
  await go('/collections/board-game-rental/shelf-rpg-books');
  const rpg = await status();
  const rpgShown = libraryCollection.products.filter((p) => (p.tags || []).includes('Shelf RPG books')).length;
  check(`${tag} the RPG shelf: counted as RPG books ("${rpgShown} RPG book${rpgShown === 1 ? '' : 's'}")`, rpg.status === `${rpgShown} RPG book${rpgShown === 1 ? '' : 's'}`, rpg.status);
  await go('/collections/board-game-rental/strategy');
  const strategy = await status();
  const strategyShown = libraryCollection.products.filter((p) => (p.tags || []).includes('Strategy')).length;
  check(`${tag} a game filter (Strategy): still "${strategyShown} games"`, strategy.status === `${strategyShown} games`, strategy.status);

  // My Library's invite for a customer without a plan
  await go('/pages/my-lair', PLAIN);
  await page.waitForSelector('[data-panel="bookings"]:not([aria-busy])', { state: 'attached', timeout: 10000 }).catch(() => {});
  await page.evaluate(() => { window.location.hash = 'library'; });
  await page.waitForSelector('my-library .mlib-join', { timeout: 10000 }).catch(() => {});
  const join = flat(await page.locator('my-library').innerText().catch(() => ''));
  check(`${tag} My Library, no plan: "Gobgob guards a hoard of ${GAMES} games and ${RPG} RPG books"`, join.includes(`Gobgob guards a hoard of ${GAMES} games and ${RPG} RPG books, and members take them home.`), join.slice(0, 200));
  await clean('My Library');

  check(`${tag}: no script errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/* ---------- 3. live: the store changes, the numbers follow ---------- */
{
  const was = { all: libraryCollection.all_products_count, count: libraryCollection.products_count, rpg: rpgCollection.all_products_count, rpgCount: rpgCollection.products_count };
  libraryCollection.all_products_count += 5;
  libraryCollection.products_count += 5;
  rpgCollection.all_products_count += 2;
  rpgCollection.products_count += 2;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  m.mockState.customer = null;
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const facts = await page.evaluate(() => [...document.querySelectorAll('.hero-fact')].map((f) => f.textContent.replace(/\s+/g, ' ').trim()));
  await page.goto(`${BASE}/pages/board-game-rental`, { waitUntil: 'networkidle' });
  const tick = await page.evaluate(() => document.querySelector('.plans-includes li')?.textContent.replace(/\s+/g, ' ').trim() || '');
  check(`live: 5 more in the library, 2 of them RPG books: the hero says ${GAMES + 3} games`, facts.includes(`${GAMES + 3} games to play or borrow`), facts.join(' | '));
  check(`live: and the library page ${GAMES + 3} games and ${RPG + 2} RPG books`, tick === `The whole library, ${GAMES + 3} games and ${RPG + 2} RPG books`, tick);
  Object.assign(libraryCollection, { all_products_count: was.all, products_count: was.count });
  Object.assign(rpgCollection, { all_products_count: was.rpg, products_count: was.rpgCount });
  await ctx.close();
}

await browser.close();
server.close?.();
fs.rmSync(COPY, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);

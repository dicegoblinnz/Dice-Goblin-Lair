// Round 7, library: the reserve block's words and hold times, My Library (pictures, borrowing and returning with the
// scanner), the tab scanner's order, and the staff Library tab (back on the shelf, check out, check in). Demo mode
// through the theme mock, phone (390x844) then desktop (1280x800). Prints a PASS or FAIL line for each check and exits
// 1 on any FAIL.
// Usage: DG_THEME=/path/to/theme [PORT=4832] node tools/qa/round7/library.mjs [phone|desktop]
// The page clock is pinned to Tuesday 6 October 2026, 11am in Auckland (NZDT): a hold made then is held until midnight
// at the end of Thursday (the app's until is 00:00 Friday 9 October), which reads "midnight, Thu 8 Oct" (Mo, 09:22).
// Shopify's t filter escapes the words the reserve block reads (We&#39;re); the mock's doesn't, so this check escapes
// them the way Shopify does on the way to the browser, and the block must show plain words.
// Before the merge My Lair has no Library view yet: this check puts <my-library> on the page and plays My Lair's half
// of their agreement (contract v7, 18.3: the `me` property, lair:me, and lair:refresh asking GET /me again). After the
// merge it uses the real view (#library).
// Needs: npm install in tools/qa/theme-mock, and Playwright at /opt/node-tools/node_modules/playwright.
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
const PORT = Number(process.env.PORT || 4832);
const BASE = `http://localhost:${PORT}`;
const OUT = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const only = process.argv[2];

// Made-up people (example.com)
const STASH = { id: 7700500001, first_name: 'Kiri', last_name: 'Moana', name: 'Kiri Moana', email: 'kiri.moana@example.com', phone: null, tags: ['Goblin Treasure - Board Game Rental'], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const GRAB = { id: 7700500002, first_name: 'Tane', last_name: 'Rua', name: 'Tane Rua', email: 'tane.rua@example.com', phone: null, tags: ['Goblin Loot - Board Game Rental'], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const PLAIN = { id: 7700500003, first_name: 'Pat', last_name: 'Reader', name: 'Pat Reader', email: 'pat.reader@example.com', phone: null, tags: [], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };

const GAME = {
  baker: { path: '/products/221b-baker-street', variant: '48100000000002', title: '221B Baker Street: The Master Detective Game', code: 'DGL56-001' },
  dungeon: { path: '/products/5-minute-dungeon', variant: '48100000000003', title: '5-Minute Dungeon', code: 'DGL56-002' },
  island: { path: '/products/forbidden-island', variant: '48100000000008', title: 'Forbidden Island', code: 'DGL34-052' },
  codenames: { path: '/products/codenames', variant: '48100000000006', title: 'Codenames', code: 'DGL7+-015' },
};

const clockAt = (ms) => `(() => { const OFFSET = ${ms} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;
const TUESDAY_11AM = Date.UTC(2026, 9, 5, 22, 0); // Tue 6 Oct 2026, 11am NZDT
const FRIDAY_MIDNIGHT = Date.UTC(2026, 9, 8, 11, 0); // 00:00 Fri 9 Oct 2026 NZDT: "midnight, Thu 8 Oct"

let failed = 0;
const results = [];
const check = (tag, ok, what, detail = '') => {
  if (!ok) failed += 1;
  const line = `${ok ? 'PASS' : 'FAIL'} ${tag} | ${what}${detail ? ` | ${String(detail).slice(0, 220)}` : ''}`;
  results.push(line);
  console.log(line);
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Shopify's t filter escapes HTML in translations: do that to the reserve block's words, as the real store would */
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
async function shopifyEscapes(ctx) {
  await ctx.route(/\/products\/[^/.?#]+(\?.*)?$/, async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    const body = (await response.text()).replace(/(<script type="application\/json" data-reserve-words>)([\s\S]*?)(<\/script>)/, (all, open, json, close) => {
      try {
        const words = JSON.parse(json);
        // Since the round 7 merge the mock's t escapes like Shopify (shell's render.mjs): then the words already are
        if (Object.values(words).some((v) => /&#39;|&amp;|&quot;/.test(String(v)))) return all;
        return `${open}${JSON.stringify(Object.fromEntries(Object.entries(words).map(([k, v]) => [k, escapeHtml(v)])))}${close}`;
      } catch {
        return all;
      }
    });
    await route.fulfill({ response, body });
  });
}

const server = await m.serve(PORT);
const browser = await chromium.launch();

async function context(size, at = TUESDAY_11AM) {
  const vp = SIZES[size];
  const phone = vp.width < 700;
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(clockAt(at));
  await shopifyEscapes(ctx);
  const page = await ctx.newPage();
  page.errors = [];
  page.searches = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) page.errors.push(`console: ${msg.text()}`);
  });
  page.on('request', (req) => {
    if (req.url().includes('/search/suggest')) page.searches.push(req.url());
  });
  return { ctx, page };
}

async function visit(page, who, path) {
  m.mockState.customer = who;
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  if (path.startsWith('/products/')) await page.waitForSelector('library-reserve[data-state]', { timeout: 10000 });
  // My Lair has loaded GET /me (after the merge its views may differ, so this only waits, it doesn't fail)
  if (path.startsWith('/pages/my-lair')) await page.waitForSelector('[data-panel="bookings"]:not([aria-busy])', { state: 'attached', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(250);
}
const state = (page) => page.getAttribute('library-reserve', 'data-state');
const block = async (page) => flat(await page.locator('library-reserve [data-reserve-body]').innerText());
const demo = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('dg-lair-demo-v3') || '{}'));
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/** My Library: the real Library view after the merge; before it, <my-library> put on the page with My Lair's half of
    the agreement played here */
async function openMyLibrary(page, who) {
  await visit(page, who, '/pages/my-lair');
  const real = await page.locator('[data-view="library"] my-library').count();
  if (real) {
    await page.evaluate(() => {
      window.location.hash = 'library';
    });
  } else {
    await page.evaluate(() => {
      const lair = document.querySelector('my-lair');
      const send = async () => {
        const me = await window.Lair.store.backend.me();
        lair.me = me;
        lair.dispatchEvent(new CustomEvent('lair:me', { bubbles: true, detail: { me } }));
      };
      lair.addEventListener('lair:refresh', send);
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
      el.innerHTML = '<p class="ml-loading">Dusting off the shelves…</p>';
      view.append(el);
      send();
    });
  }
  await page.waitForSelector('my-library .mlib', { timeout: 10000 });
  await page.waitForTimeout(300);
}
const lib = async (page) => flat(await page.locator('my-library').innerText());

/** The scanner sheet is open: type a code (headless Chrome has no camera, so the sheet offers typing) and read its line */
async function typeCode(page, code) {
  await page.waitForSelector('dialog.lair-scan[open]', { timeout: 5000 });
  // the camera tries first (and gives up here): wait for that, so its line doesn't land after this code's
  await page.waitForSelector('dialog.lair-scan.is-off', { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => {
    document.querySelector('[data-scan-status]').textContent = '';
  });
  await page.fill('#lair-scan-code', code);
  await page.press('#lair-scan-code', 'Enter');
  await page.waitForFunction(() => {
    const s = document.querySelector('[data-scan-status]');
    return !s || (s.textContent.trim() && !/Checking that one/.test(s.textContent));
  }, null, { timeout: 8000 }).catch(() => {});
  const status = page.locator('[data-scan-status]');
  return (await status.count()) ? flat(await status.textContent()) : '';
}
const sheetGone = (page) => page.waitForSelector('dialog.lair-scan', { state: 'detached', timeout: 5000 }).then(() => true).catch(() => false);

for (const size of Object.keys(SIZES).filter((s) => !only || s === only)) {
  const { ctx, page } = await context(size);
  const tag = size;

  /* ---------- 1. the reserve block: plain words, and the midnight hold ---------- */
  await visit(page, STASH, GAME.baker.path);
  const raw = await page.locator('script[data-reserve-words]').textContent();
  const offer = await block(page);
  check(tag, raw.includes('&#39;'), 'the words reach the page escaped, as Shopify sends them (We&#39;re)');
  check(tag, offer.includes("we'll hold it until midnight, Thu 8 Oct.") && !/&#39;|&amp;|&quot;/.test(offer), 'member, Tuesday: "we\'ll hold it until midnight, Thu 8 Oct", no escaped words', offer);
  await page.click('[data-reserve]');
  await page.waitForSelector('library-reserve[data-state="mine"]', { timeout: 5000 }).catch(() => {});
  const mine = await block(page);
  check(tag, mine.includes("You've reserved this") && mine.includes("We're holding it until midnight, Thu 8 Oct.") && !/&#39;|&amp;/.test(mine),
    'reserved: "You\'ve reserved this. We\'re holding it until midnight, Thu 8 Oct." (Mo\'s screenshot showed You&#39;ve)', mine);
  let made = (await demo(page)).libraryHolds.find((h) => h.variantId === GAME.baker.variant && String(h.customerId) === String(STASH.id));
  check(tag, Boolean(made) && made.until === FRIDAY_MIDNIGHT, 'the hold ends at 00:00 Friday Lair time (midnight at the end of Thursday, the third day)', made ? new Date(made.until).toISOString() : 'no hold');
  check(tag, Boolean(made) && /^\/img\/221b-baker-street/.test(made.image || ''), 'the hold carries the game\'s picture from the page', made && made.image);
  check(tag, mine.includes('See it in My Library'), 'theirs: a link to My Library');
  await page.locator('library-reserve').screenshot({ path: `${OUT}${tag}-reserve-mine.png` });
  check(tag, (await overflow(page)) === 0, 'game page: no sideways scroll');
  await visit(page, GRAB, GAME.baker.path);
  const other = await block(page);
  check(tag, (await state(page)) === 'reserved' && other.includes("It's back on the shelf by midnight, Thu 8 Oct if it isn't collected."), 'another member: back on the shelf by midnight, Thu 8 Oct', other);
  // the plan's limit counts holds and games at home, in the app's words
  await visit(page, GRAB, GAME.island.path);
  await page.click('[data-reserve]');
  await page.waitForSelector('library-reserve[data-state="mine"]', { timeout: 5000 }).catch(() => {});
  await visit(page, GRAB, GAME.codenames.path);
  await page.click('[data-reserve]');
  await page.waitForSelector('library-reserve .library-reserve__error', { timeout: 5000 }).catch(() => {});
  const limit = flat(await page.locator('library-reserve .library-reserve__error').textContent().catch(() => ''));
  check(tag, limit.startsWith("Your plan has 1 game at a time, and you've got 1: 1 reserved. Return one or cancel a hold first.") && limit.includes('See My Library'),
    'plan limit: the round 7 409, and a link to My Library', limit);

  /* ---------- 2. My Library: the plan, pictures, holds and what ended ---------- */
  await openMyLibrary(page, STASH);
  let text = await lib(page);
  check(tag, text.includes('Stash plan') && text.includes('1 of 3 games: 1 reserved') && text.includes('Room for 2 more.'), 'My Library: the plan line, "1 of 3 games: 1 reserved"', text.slice(0, 160));
  check(tag, text.includes('221B Baker Street') && text.includes('Held until midnight, Thu 8 Oct') && text.includes('DGL56-001'), 'My Library: the reserved game, its shelf code and "Held until midnight, Thu 8 Oct"');
  const holdPic = await page.locator('my-library .mlib-item--held img').first().getAttribute('src').catch(() => '');
  check(tag, /221b-baker-street/.test(holdPic) && /width=160/.test(holdPic), 'My Library: the game\'s picture beside it, sized (width=160)', holdPic);
  check(tag, text.includes("Your hold on Wyrmspan ended, so it’s back on the shelf.") && (await page.locator('my-library .mlib-lately a[href$="/products/wyrmspan"]').count()) === 1, 'My Library: a hold that ended lately, with Reserve it again');
  check(tag, (await page.locator('my-library [data-library-scan]').count()) === 1 && (await page.locator('my-library [data-library-scan]').isVisible()), 'My Library: a big "Scan a game" button');
  check(tag, (await page.locator('my-library a[href="/collections/board-game-rental"]').count()) >= 1 && (await page.locator('my-library a[href="/pages/board-game-rental#plans"]').count()) >= 1, 'My Library: links to the shelves and the plans');

  /* ---------- 3. borrowing and returning through the scanner ---------- */
  const refreshes = await page.evaluate(() => {
    window.__refreshes = 0;
    document.addEventListener('lair:refresh', () => { window.__refreshes += 1; });
    return 0;
  });
  await page.click('my-library [data-library-scan]');
  check(tag, (await page.locator('dialog.lair-scan[open]').count()) === 1 && flat(await page.locator('#lair-scan-title').textContent()) === 'Scan a game', 'Scan a game opens the shared camera sheet (lair-scan.js)');
  // only one sheet: another open closes this one
  const sheets = await page.evaluate(() => {
    window.LairScan.open({ title: 'Second sheet' });
    const n = document.querySelectorAll('dialog.lair-scan').length;
    window.LairScan.close();
    return n;
  });
  check(tag, sheets === 1 && (await page.locator('dialog.lair-scan').count()) === 0, 'only one scanner sheet is ever open, and LairScan.close() closes it', `sheets ${sheets}`);
  await page.click('my-library [data-library-scan]');
  let said = await typeCode(page, GAME.baker.code);
  check(tag, said === `${GAME.baker.title} is yours to take home. Scan it again when you bring it back.`, 'borrow a game held for them: it\'s theirs on loan', said);
  check(tag, await sheetGone(page), 'the sheet closes after a borrow');
  await page.waitForTimeout(400);
  text = await lib(page);
  check(tag, text.includes('1 of 3 games: 1 at home') && /At home 1/.test(text) && text.includes('Borrowed today'), 'My Library: the game is at home now, "Borrowed today"', text.slice(0, 200));
  const homePic = await page.locator('my-library .mlib-item--home img').first().getAttribute('src').catch(() => '');
  check(tag, /221b-baker-street/.test(homePic), 'at home: the loan keeps the hold\'s picture', homePic);
  const sayLine = flat(await page.locator('my-library [data-say]').textContent());
  check(tag, sayLine.includes('is yours to take home') && (await page.evaluate(() => window.__refreshes)) >= 1, 'the page says it too (aria-live), and lair:refresh went to My Lair', `${sayLine} | refreshes ${await page.evaluate(() => window.__refreshes)}`);
  // a free copy (nothing held): a game off the shelf, with its picture from the game's page
  await page.click('my-library [data-library-scan]');
  said = await typeCode(page, GAME.island.code);
  check(tag, said === 'Forbidden Island is yours to take home. Scan it again when you bring it back.', 'borrow a free copy (their plan has room)', said);
  await sheetGone(page);
  await page.click('my-library [data-library-scan]');
  said = await typeCode(page, GAME.dungeon.code.toLowerCase());
  check(tag, said.startsWith('5-Minute Dungeon is yours to take home'), 'borrow another (a typed code, any case)', said);
  await sheetGone(page);
  await page.waitForTimeout(500);
  text = await lib(page);
  check(tag, text.includes('3 of 3 games: 3 at home') && text.includes('Your plan’s full.'), 'My Library: 3 of 3 games: 3 at home, plan full', text.slice(0, 200));
  const fetched = await page.locator('my-library .mlib-item--home img[src*="forbidden-island"]').count();
  check(tag, fetched === 1, 'a game with no picture of its own: the featured image from /products/<handle>.js');
  // plan full, a shop product, an unknown code: the app's words, and the sheet stays open
  await page.click('my-library [data-library-scan]');
  said = await typeCode(page, GAME.codenames.code);
  check(tag, said === "Your plan has 3 games at a time, and you've got 3: 3 at home. Return one or cancel a hold first.", 'plan full: the 409 in the app\'s words', said);
  said = await typeCode(page, '9421906580017');
  check(tag, said === "That's from the shop, not the library. Borrow games from the library shelves, friend.", 'a shop product\'s barcode: the 422', said);
  said = await typeCode(page, 'DGL99-999');
  check(tag, said === "Gobgob can't find a library game with that code. Try the code on its label, or ask at the counter.", 'an unknown code: the 404', said);
  check(tag, (await page.locator('dialog.lair-scan[open]').count()) === 1, 'after a refusal the sheet stays open for another try');
  // return: scan it again
  said = await typeCode(page, GAME.island.code);
  check(tag, said === 'Forbidden Island is checked back in. Thanks, friend!', 'return: scan it again', said);
  await sheetGone(page);
  await page.waitForTimeout(500);
  text = await lib(page);
  const focusBack = await page.evaluate(() => document.activeElement && document.activeElement.matches('[data-library-scan]'));
  const atHomeNow = flat(await page.locator('my-library .mlib-item--home').allInnerTexts().then((x) => x.join(' | ')));
  check(tag, text.includes('2 of 3 games: 2 at home') && !atHomeNow.includes('Forbidden Island'), 'My Library: Forbidden Island is back on the shelf, 2 of 3', atHomeNow);
  check(tag, focusBack, 'focus comes back to Scan a game when the sheet closes');
  await page.locator('my-library').screenshot({ path: `${OUT}${tag}-my-library.png` });
  check(tag, (await overflow(page)) === 0, 'My Library: no sideways scroll');
  // the game's page knows it's at home with them, and another member sees every copy out on loan
  await visit(page, STASH, GAME.baker.path);
  const homeBlock = await block(page);
  check(tag, (await state(page)) === 'home' && homeBlock.includes("You've got this one at home") && homeBlock.includes('You borrowed it today.') && homeBlock.includes('See it in My Library'),
    'game page: "You\'ve got this one at home" (atHome)', homeBlock);
  await visit(page, GRAB, GAME.dungeon.path);
  const outBlock = await block(page);
  check(tag, (await state(page)) === 'out' && outBlock.includes('Out on loan right now') && !(await page.locator('[data-reserve]').count()), 'another member: every copy out on loan, no Reserve button', outBlock);
  await page.locator('library-reserve').screenshot({ path: `${OUT}${tag}-reserve-out.png` });
  // cancel a hold from My Library: it asks first
  await visit(page, STASH, GAME.codenames.path);
  await page.click('[data-reserve]');
  await page.waitForSelector('library-reserve[data-state="mine"]', { timeout: 5000 }).catch(() => {});
  await openMyLibrary(page, STASH);
  text = await lib(page);
  check(tag, text.includes('3 of 3 games: 1 reserved, 2 at home'), 'My Library: the plan line as Mo wrote it ("2 of 3 games: 1 reserved, 1 at home")', text.slice(0, 120));
  await page.click('my-library [data-mlib-cancel]');
  const askFocus = await page.evaluate(() => document.activeElement && document.activeElement.textContent.trim());
  await page.click('my-library [data-mlib-cancel-yes]');
  await page.waitForTimeout(500);
  text = await lib(page);
  check(tag, askFocus === 'Keep it' && text.includes('Cancelled. Codenames is back on the shelf.') && text.includes('Your hold on Codenames was cancelled.'), 'cancel a hold: asks first (focus on Keep it), then says so', text.slice(0, 220));
  // a member with no plan: the join card
  await openMyLibrary(page, PLAIN);
  text = await lib(page);
  check(tag, text.includes('Join the library') && (await page.locator('my-library .mlib-join a[href="/pages/board-game-rental#plans"]').count()) === 1 && !(await page.locator('my-library [data-library-scan]').count()),
    'no plan: a friendly card about joining, and no scanner', text.slice(0, 120));
  await page.locator('my-library').screenshot({ path: `${OUT}${tag}-my-library-join.png` });

  /* ---------- 4. the tab scanner: menu, QR link, lookup, search when the lookup's down, unknown ---------- */
  await visit(page, STASH, '/pages/my-lair#tab');
  await page.waitForSelector('[data-view="tab"]:not([hidden])', { timeout: 5000 }).catch(() => {});
  const lookups = () => page.evaluate(() => window.__lookups || 0);
  await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const real = be.tabLookup.bind(be);
    window.__lookups = 0;
    be.tabLookup = (code) => {
      window.__lookups += 1;
      return real(code);
    };
  });
  check(tag, await page.locator('[data-view="tab"] [data-scan]').isVisible(), 'Tab: the scan button is there');
  const scanTab = async (code) => {
    await page.click('[data-view="tab"] [data-scan]');
    const line = await typeCode(page, code);
    await page.evaluate(() => window.LairScan.close());
    return line;
  };
  page.searches.length = 0;
  said = await scanTab('31283123823');
  check(tag, said.startsWith('Added $2 Drink') && (await lookups()) === 0 && !page.searches.length, '1. the Tab menu\'s own barcode: added, no lookup', said);
  said = await scanTab('https://www.dicegoblin.nz/products/wingspan');
  check(tag, said.startsWith('Added Wingspan') && (await lookups()) === 0, '2. a product link in a QR code: added, no lookup', said);
  said = await scanTab('9421906580017');
  check(tag, said.startsWith('Added Pokémon TCG: booster pack') && (await lookups()) === 1 && !page.searches.length, '3. GET /tab/lookup finds a barcode the menu doesn\'t have', said);
  said = await scanTab('DGL34-052');
  check(tag, said === "That's one of our library games. Borrow it in My Library, friend. It doesn't go on a tab.", 'the lookup\'s 422 for a library copy, in its words', said);
  said = await scanTab('0000000000000');
  check(tag, said === "Gobgob doesn't know that one. Pick it from the menu instead." && !page.searches.length, '5. an unknown code (the lookup\'s 404): Gobgob doesn\'t know that one', said);
  await visit(page, STASH, '/pages/my-lair?tablookup=down#tab');
  page.searches.length = 0;
  await page.click('[data-view="tab"] [data-scan]');
  said = await typeCode(page, '9421906580017');
  await page.evaluate(() => window.LairScan.close());
  check(tag, said.startsWith('Added Pokémon TCG: booster pack') && page.searches.length >= 1, '4. ?tablookup=down (503): the store\'s predictive search finds it', `${said} | searches ${page.searches.length}`);
  check(tag, (await overflow(page)) === 0, 'My Lair Tab: no sideways scroll');

  /* ---------- 5. staff: back on the shelf, check out, check in ---------- */
  await visit(page, STAFF, '/pages/lair-staff');
  await page.click('[data-tab="library"]');
  await page.waitForSelector('[data-lib-list] .staff-lib-rows', { timeout: 10000 });
  await page.waitForSelector('[data-lib-loans] .staff-lib-rows', { timeout: 10000 });
  await page.waitForTimeout(300);
  let homeList = flat(await page.locator('[data-lib-loans]').innerText());
  check(tag, homeList.includes('Paladins of the West Kingdom') && homeList.includes('Sam Tautahi') && homeList.includes('1000 and One Treasures') && homeList.includes('Out 12 days') && homeList.includes('Kiri Moana'),
    'Games at home: every game out, with the member and days out', homeList.slice(0, 200));
  const holdsList = flat(await page.locator('[data-lib-list]').innerText());
  check(tag, holdsList.includes('Held until midnight, Thu 8 Oct') || holdsList.includes('Held until midnight, Wed 7 Oct'), 'staff holds: the midnight wording', holdsList.slice(0, 200));
  // a collected game: back on the shelf (Mo's ask)
  const myst = page.locator('.staff-lib[data-lib-row]', { hasText: 'Mysterium' });
  await myst.locator('[data-lib-act="collected"]').click();
  await page.waitForTimeout(300);
  const back = myst.locator('[data-lib-loan-return]');
  check(tag, (await back.count()) === 1 && flat(await back.textContent()) === 'Back on the shelf', 'a collected hold: "Back on the shelf" on it');
  homeList = flat(await page.locator('[data-lib-loans]').innerText());
  check(tag, homeList.includes('Mysterium') && homeList.includes('Hemi'), 'collected: the game is at home with Hemi');
  await back.click();
  await page.waitForTimeout(400);
  const loanMyst = (await demo(page)).libraryLoans.find((l) => l.title === 'Mysterium');
  homeList = flat(await page.locator('[data-lib-loans]').innerText());
  check(tag, loanMyst && loanMyst.status === 'returned' && !homeList.includes('Mysterium') && flat(await myst.innerText()).includes('Back on the shelf.'), 'Back on the shelf: returned, off the games at home', loanMyst && loanMyst.status);
  // check out: pick the member, then type (or scan) the game
  await page.click('#lib-out-code');
  await page.locator('[data-lib-out] button[type="submit"]').click();
  check(tag, flat(await page.locator('[data-lib-say="out"]').textContent()).startsWith('Scan the game') || flat(await page.locator('[data-lib-say="out"]').textContent()).startsWith('Pick the member'), 'check out: says what\'s missing');
  await page.fill('#lib-member-q', 'Sam');
  await page.waitForSelector('[data-lib-member-pick]', { timeout: 5000 });
  await page.locator('[data-lib-member-pick]', { hasText: 'Sam Tautahi' }).click();
  const picked = flat(await page.locator('[data-lib-member-picked]').textContent());
  check(tag, picked.includes('Sam Tautahi') && picked.includes('1 at home') && (await page.evaluate(() => document.activeElement && document.activeElement.id)) === 'lib-out-code', 'check out: the member picked (what they have), focus on the game', picked);
  await page.fill('#lib-out-code', '9780786968992');
  await page.press('#lib-out-code', 'Enter');
  await page.waitForTimeout(400);
  let line = flat(await page.locator('[data-lib-say="out"]').textContent());
  check(tag, line === 'Checked out: D&D Bigby Presents Glory of the Giants (DGLRPG-008) to Sam Tautahi.', 'check out by its ISBN barcode', line);
  // the camera: the same sheet, the game goes to the picked member
  await page.click('[data-lib-scan="out"]');
  const outTitle = flat(await page.locator('#lair-scan-title').textContent().catch(() => ''));
  said = await typeCode(page, GAME.island.code);
  check(tag, outTitle === 'Check out to Sam' && said === 'Checked out: Forbidden Island (DGL34-052) to Sam Tautahi.', 'check out with the camera sheet', `${outTitle} | ${said}`);
  await page.evaluate(() => window.LairScan.close());
  await page.click('[data-lib-member-change]');
  await page.fill('#lib-member-q', 'Aroha');
  await page.waitForSelector('[data-lib-member-pick]', { timeout: 5000 });
  await page.locator('[data-lib-member-pick]', { hasText: 'Aroha' }).click();
  await page.fill('#lib-out-code', GAME.island.code);
  await page.press('#lib-out-code', 'Enter');
  await page.waitForTimeout(400);
  line = flat(await page.locator('[data-lib-say="out"]').textContent());
  check(tag, line.startsWith('Checked out: Forbidden Island (DGL34-052) to Aroha'), 'a second copy out, to Aroha', line);
  // check in: one copy out comes straight back
  await page.fill('#lib-in-code', 'DGLF-001');
  await page.press('#lib-in-code', 'Enter');
  await page.waitForTimeout(400);
  line = flat(await page.locator('[data-lib-say="in"]').textContent());
  check(tag, line === 'Checked in: 1000 and One Treasures is back on the shelf. It was with Tui (12 days).', 'check in, one copy out: returned', line);
  // several out: pick which
  await page.fill('#lib-in-code', GAME.island.code);
  await page.press('#lib-in-code', 'Enter');
  await page.waitForTimeout(400);
  line = flat(await page.locator('[data-lib-say="in"]').textContent());
  const choices = await page.locator('[data-lib-pick] [data-lib-loan-return]').count();
  check(tag, line === '2 copies of Forbidden Island are out. Pick the one that came back.' && choices === 2, 'check in, several out: staff pick which', `${line} | ${choices}`);
  await page.locator('[data-lib-pick] [data-lib-loan-return]', { hasText: 'Aroha' }).click();
  await page.waitForTimeout(400);
  line = flat(await page.locator('[data-lib-say="in"]').textContent());
  const island = (await demo(page)).libraryLoans.filter((l) => l.title === 'Forbidden Island' && l.status === 'out');
  check(tag, line === 'Forbidden Island is back on the shelf. It was with Aroha (today).' && island.length === 1, 'the copy picked is back; the other stays out', `${line} | out ${island.length}`);
  // the camera checks games in too
  await page.click('[data-lib-scan="in"]');
  said = await typeCode(page, '9780786968992');
  check(tag, said === 'Checked in: D&D Bigby Presents Glory of the Giants is back on the shelf. It was with Sam (today).', 'check in with the camera sheet', said);
  said = await typeCode(page, '9780786968992');
  check(tag, said === "That game isn't out on loan. It must be on the shelf already.", 'check in something already on the shelf: the 404', said);
  await page.evaluate(() => window.LairScan.close());
  await page.locator('[data-panel="library"]').screenshot({ path: `${OUT}${tag}-staff-library.png` });
  check(tag, (await overflow(page)) === 0, 'staff page: no sideways scroll');

  check(tag, page.errors.length === 0, 'no console or page errors', page.errors.slice(0, 3).join(' | '));
  await ctx.close();
}

await browser.close();
server.close();
console.log(failed ? `library r7: ${failed} FAILED of ${results.length}` : `library r7: all ${results.length} passed`);
process.exit(failed ? 1 : 0);

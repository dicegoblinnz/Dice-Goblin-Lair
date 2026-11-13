// Round 37 (14 Nov 2026), the GM perk, the staff slot and a game's books (contract v37-gm-perk), on the theme mock in
// demo mode, phone (390x844) then desktop (1280x800). Mo picked 1A (the perk as a card of its own in My Library), 2A
// (a search box for the game's books on Run a game) and 3A (whoever borrows a wanted book is told as they take it).
//   1. A GM with no library plan, My Library: the perk's card with Scan a book; a board game is refused in the Lair's
//      words; an RPG book goes home free with the heads-up in a box of its own; the card then shows the book; a second
//      book is refused (one at a time). ?perk=resting, ?perk=idle, ?perk=staff and ?perk=none each read right.
//   2. Games I run: the game's books and where each is; Change the books (the search, Add, Added, three at most, take
//      one off, Save); the card redraws with what was saved.
//   3. Run a game: step 3 has Books for the table; the search; a book added and taken off; the review lists them; the
//      game is listed with its books.
//   4. A library book's page says which table would like it, and "your own game" for its GM.
//   5. Staff: the staff slot's card; a member's GM perk (the facts, the log, Take it away and Give, each asking first);
//      the Library tab's badges (GM perk, Wanted) and the GM perks list; Make a session has the books field.
// No sideways scroll, no console errors, and the new buttons are 44px or more to tap on a phone.
// The theme's demo backend (assets/lair-demo.js) has to follow the contract for these checks to pass.
// Usage: DG_THEME=/path/to/theme [PORT=4993] node tools/qa/round37-gm-perk/demo.mjs [phone|desktop]
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
const PORT = Number(process.env.PORT || 4993);
const BASE = `http://localhost:${PORT}`;
const OUT = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const only = process.argv[2];

// Made-up people (example.com)
const GM = { id: 7700600001, first_name: 'Aroha', last_name: 'Tane', name: 'Aroha Tane', email: 'aroha.tane@example.com', phone: null, tags: ['gm'], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const PLAIN = { id: 7700600003, first_name: 'Pat', last_name: 'Reader', name: 'Pat Reader', email: 'pat.reader@example.com', phone: null, tags: [], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };

let failed = 0;
const check = (tag, ok, what, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${tag} | ${what}${detail ? ` | ${String(detail).slice(0, 300)}` : ''}`);
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const server = await m.serve(PORT);
const browser = await chromium.launch();

async function context(size) {
  const vp = SIZES[size];
  const phone = vp.width < 700;
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) page.errors.push(`console: ${msg.text()}`);
  });
  return { ctx, page, phone };
}

async function visit(page, who, path) {
  m.mockState.customer = who;
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  if (path.startsWith('/pages/my-lair')) await page.waitForSelector('[data-panel="bookings"]:not([aria-busy])', { state: 'attached', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(250);
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
/** Shown controls inside a selector that are smaller than 44px to tap */
const small = (page, selector) => page.evaluate((sel) => {
  const out = [];
  for (const el of document.querySelectorAll(`${sel} button, ${sel} a.button, ${sel} input[type="search"]`)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || el.closest('[hidden]')) continue;
    if (r.height < 44 || r.width < 44) out.push(`${el.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`);
  }
  return out;
}, selector);

async function openMyLibrary(page, who, query = '') {
  await visit(page, who, `/pages/my-lair${query}`);
  await page.evaluate(() => {
    window.location.hash = 'library';
  });
  await page.waitForSelector('my-library .mlib', { timeout: 10000 });
  await page.waitForTimeout(300);
}
const lib = async (page) => flat(await page.locator('my-library').innerText());

/** The scanner sheet is open: type a code (headless Chrome has no camera, so the sheet offers typing) and read its line */
async function typeCode(page, code) {
  await page.waitForSelector('dialog.lair-scan[open]', { timeout: 5000 });
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
const closeScan = async (page) => {
  await page.evaluate(() => window.LairScan && window.LairScan.close());
  await page.waitForTimeout(400);
};

async function gamesIRun(page, who) {
  await visit(page, who, '/pages/my-lair');
  await page.click('.ml-bar [data-view-link="bookings"]');
  await page.waitForSelector('[data-view="bookings"]:not([hidden])', { timeout: 5000 });
  await page.waitForSelector('lair-game-books .mgb', { timeout: 10000 });
  await page.locator('lair-game-books').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
}

for (const size of Object.keys(SIZES).filter((s) => !only || s === only)) {
  const { ctx, page, phone } = await context(size);
  const tag = size;
  let text;
  let said;

  /* ---------- 1. a GM with no plan: the perk's card, and borrowing on it ---------- */
  await openMyLibrary(page, GM);
  text = await lib(page);
  check(tag, text.startsWith("Every good GM needs a good book, friend. This one's on Gobgob. GM perk One RPG book at home, free"), 'My Library opens with Gobgob and the perk\'s card', text.slice(0, 140));
  check(tag, (await page.locator('my-library .mlib-perk [data-library-scan]').count()) === 1 && flat(await page.locator('my-library .mlib-perk [data-library-scan]').innerText()) === 'Scan a book',
    'the card has Scan a book (no plan to scan with)');
  check(tag, !text.includes('Join the library Gobgob guards') || text.indexOf('Join the library') > text.indexOf('At home'), 'the invite to join comes after their games, not on top');
  check(tag, (await page.locator('my-library .mlib-perk a[href$="collections/library-rpg-books"]').count()) === 1, 'the card links to the RPG shelf');
  if (phone) check(tag, (await small(page, 'my-library .mlib-perk')).length === 0, 'the card\'s controls are 44px or more', (await small(page, 'my-library .mlib-perk')).join(', '));
  await page.locator('my-library .mlib-perk-stack, my-library .mlib-perk').first().screenshot({ path: `${OUT}${tag}-1a-perk-on.png` });

  await page.click('my-library [data-library-scan]');
  said = await typeCode(page, 'DGL7+-015');
  check(tag, said === 'Your GM perk covers the RPG shelf. Join the library to borrow board games.', 'a board game is refused in the Lair\'s words', said);
  said = await typeCode(page, 'DGLRPG-012');
  check(tag, said.startsWith("Dungeons & Dragons Player's Handbook (5th Edition) is yours to take home, free with your GM perk."), 'an RPG book goes home free on the perk', said);
  check(tag, /Heads up: .+ would like this one on the table at the Lair on \w{3} \d{1,2} \w{3}, \d/.test(said), 'the sheet says which table would like it and when', said.slice(-170));
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}${tag}-3a-scan-sheet.png` });
  await closeScan(page);
  text = await lib(page);
  check(tag, (await page.locator('my-library [data-heads]').count()) === 1 && flat(await page.locator('my-library [data-heads]').innerText()).startsWith('Heads up:'),
    'the heads-up shows in a box of its own under the usual words', flat(await page.locator('my-library [data-heads]').innerText().catch(() => '')));
  check(tag, text.includes("Your GM perk book's at home") && (await page.locator('my-library .mlib-item .mlib-tag', { hasText: 'GM perk' }).count()) === 1 && !text.includes('Lent'),
    'the card shows the book, and it\'s tagged GM perk at home (never Lent)', text.slice(0, 260));
  check(tag, (await page.locator('my-library .mlib-tag--wanted').count()) >= 1 && /A table would like it on \w{3} \d{1,2} \w{3}/.test(text), 'the game at home says when a table would like it');
  await page.locator('my-library').screenshot({ path: `${OUT}${tag}-1a-perk-home.png` });
  check(tag, (await page.locator('my-library [data-library-scan]').count()) === 0, 'no scanner while the slot is in use and there\'s no plan');

  // one at a time: the Lair's refusal (asked of the backend, since the page has no scanner to offer now)
  const second = await page.evaluate(() => window.Lair.store.backend.libraryScan('DGLRPG-010').then(() => 'borrowed', (e) => `${e.status} ${e.message}`));
  check(tag, second.startsWith('409 Your GM perk is one book at a time'), 'a second book is refused: one at a time', second);

  for (const [query, starts, shot] of [
    ['?perk=resting', 'GM perk · resting Your GM perk is having a rest Your last three sessions had nobody at the table.', 'resting'],
    ['?perk=idle', "GM perk · resting Your GM perk is having a rest It's been three weeks with no game of yours running at the Lair.", 'idle'],
  ]) {
    await openMyLibrary(page, GM, query);
    text = await lib(page);
    check(tag, text.startsWith(starts) && text.includes("You've still got Dungeons & Dragons Player's Handbook (5th Edition) at home. Could you bring it back next time you're in? There's nothing to pay."),
      `${query}: why it's resting, and the ask for the book`, text.slice(0, 300));
    check(tag, (await page.locator('my-library .mlib-perk a.button', { hasText: 'Run a game' }).count()) === 1, `${query}: Run a game`);
    check(tag, text.includes('GM perk ended') && !text.includes("Bring it back to the counter next time you're in."), `${query}: the book's row says its perk has ended (the card does the asking)`);
    await page.locator('my-library .mlib-perk').screenshot({ path: `${OUT}${tag}-1c-${shot}.png` });
  }
  await openMyLibrary(page, GM, '?perk=off');
  text = await lib(page);
  check(tag, !text.includes('GM perk · resting') && !text.includes('One RPG book at home, free') && text.includes('GM perk ended') && text.includes("Bring it back to the counter next time you're in. There's nothing to pay."),
    '?perk=off (staff took it): no card; the book at home is marked and quietly asked back', text.slice(0, 300));
  await page.locator('my-library .mlib-item', { hasText: 'GM perk ended' }).first().screenshot({ path: `${OUT}${tag}-1-perk-ended.png` });
  await openMyLibrary(page, GM, '?perk=none');
  text = await lib(page);
  check(tag, !text.includes('GM perk · resting') && !text.includes('One RPG book at home, free'), '?perk=none: no card', text.slice(0, 120));
  check(tag, (await overflow(page)) === 0, 'My Library: no sideways scroll');

  /* ---------- 2. Games I run: the game's books ---------- */
  await gamesIRun(page, GM);
  const card = page.locator('article.ml-game', { has: page.locator('lair-game-books') }).first();
  const books = card.locator('lair-game-books');
  text = flat(await books.innerText());
  check(tag, text.startsWith('Books for the table') && text.includes("Dungeons & Dragons Player's Handbook (5th Edition) DGLRPG-012 At home with you"), 'the book they borrowed is "At home with you"', text.slice(0, 200));
  check(tag, /Dungeons & Dragons Monster Manual \(5th Edition\) DGLRPG-011 At home with someone Gobgob tells them your table would like it back for \w{3} \d{1,2} \w{3}\./.test(text),
    'a book someone else has says so, and that they\'re told the day', text.slice(0, 420));
  check(tag, text.includes("Naming a book holds nothing back. Anyone can still borrow it, and they're told when your table would like it.") && text.endsWith('Change the books'), 'the note that nothing is held back, then Change the books');
  await books.screenshot({ path: `${OUT}${tag}-2c-books.png` });

  await books.locator('[data-books-edit]').click();
  await page.waitForSelector('lair-game-books .mgb--edit');
  check(tag, (await page.evaluate(() => document.activeElement && document.activeElement.matches('[data-books-search]'))), 'Change the books opens the search, with the keyboard in it');
  text = flat(await books.innerText());
  check(tag, text.includes("Name up to 3 books from the Lair's RPG shelf. They're for this session and every later one."), 'a weekly game: for this session and every later one', text.slice(0, 160));
  await books.locator('[data-books-search]').fill('d');
  await books.locator('[data-books-search]').press('Enter');
  await page.waitForTimeout(200);
  check(tag, flat(await books.locator('[data-books-results]').innerText()) === 'Type at least 2 letters to search.', 'one letter: type at least 2');
  await books.locator('[data-books-search]').fill('dungeon');
  await page.waitForSelector('lair-game-books .mgb-found', { timeout: 5000 });
  text = flat(await books.locator('[data-books-results]').innerText());
  check(tag, text.includes("Dungeons & Dragons Dungeon Master's Guide (5th Edition) DGLRPG-010 · 2 copies Add") && text.includes("Dungeons & Dragons Player's Handbook (5th Edition) DGLRPG-012 Added"),
    'the search lists the shelf\'s books: Add, or Added for one on the game', text);
  await books.locator('[data-books-search]').fill('zzzz');
  await page.waitForFunction(() => /No book on the RPG shelf matches/.test(document.querySelector('lair-game-books [data-books-results]')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  check(tag, flat(await books.locator('[data-books-results]').innerText()) === 'No book on the RPG shelf matches “zzzz”. Try fewer words.', 'nothing matches: said plainly');
  await books.locator('[data-books-search]').fill('dungeon');
  await page.waitForSelector('lair-game-books [data-books-add]', { timeout: 5000 });
  if (phone) check(tag, (await small(page, 'lair-game-books')).length === 0, 'the editor\'s controls are 44px or more', (await small(page, 'lair-game-books')).join(', '));
  await books.screenshot({ path: `${OUT}${tag}-2c-change.png` });
  await books.locator('[data-books-add]').first().click();
  await page.waitForTimeout(200);
  text = flat(await books.innerText());
  check(tag, text.includes("That's 3. Take one off to add another.") && (await books.locator('[data-books-search]').count()) === 0 && (await books.locator('.mgb-pick').count()) === 3,
    'three books: the search gives way to "That\'s 3"', text.slice(0, 260));
  await books.locator('[data-books-off]').nth(1).click(); // the Monster Manual comes off
  await page.waitForTimeout(200);
  check(tag, (await books.locator('.mgb-pick').count()) === 2 && (await books.locator('[data-books-search]').count()) === 1, 'one taken off: two left, and the search is back');
  await books.locator('[data-books-save]').click();
  await page.waitForSelector('lair-game-books [data-books-edit]', { timeout: 8000 });
  await page.waitForTimeout(600);
  const after = page.locator('article.ml-game', { has: page.locator('lair-game-books') }).first().locator('lair-game-books');
  text = flat(await after.innerText());
  check(tag, text.includes("Dungeon Master's Guide (5th Edition) DGLRPG-010 On the shelf 2 copies") && !text.includes('Monster Manual') && text.includes("Your game's books are saved."),
    'saved: the card shows the new books, and says so', text.slice(0, 360));
  const later = await page.evaluate(async () => {
    const me = await window.Lair.store.backend.me();
    const mine = (me.games || []).filter((g) => g.seriesId && g.status !== 'cancelled' && g.end > Date.now());
    return mine.map((g) => (g.books || []).map((b) => b.shelfCode).join('+'));
  });
  check(tag, later.length > 1 && later.every((x) => x === 'DGLRPG-012+DGLRPG-010'), 'every later session of the weekly game names them too', later.join(' | '));
  check(tag, (await overflow(page)) === 0, 'Games I run: no sideways scroll');

  /* ---------- 3. Run a game: Books for the table ---------- */
  await visit(page, GM, '/pages/gm-games#host');
  await page.waitForSelector('lair-session-form [data-host-form]', { timeout: 10000 });
  const form = page.locator('lair-session-form');
  await form.locator('[name="title"]').fill('The Lantern Street Job');
  await form.locator('[data-system-chips] .chip', { hasText: 'Other' }).click();
  await form.locator('[name="systemOther"]').fill('Blades in the Dark');
  await form.locator('[name="blurb"]').fill('A crew of scoundrels takes one last score in a haunted city.');
  await page.locator('[data-step-next]').click();
  await page.waitForSelector('lair-session-form [data-step="players"]');
  await form.locator('.pay-option', { hasText: 'New players welcome' }).first().click().catch(() => form.locator('[name="level"]').first().check({ force: true }));
  await form.locator('.chip', { hasText: '13+' }).click();
  await page.locator('[data-step-next]').click();
  await page.waitForSelector('lair-session-form [data-step="table"]');
  text = flat(await form.locator('[data-sf-books]').innerText());
  check(tag, text.startsWith("Books for the table (optional) Running it from a book on the Lair’s RPG shelf? Name up to 3. Whoever has one at home hears your table would like it back that day."),
    'step 3 has Books for the table, after What to bring', text.slice(0, 200));
  check(tag, (await page.evaluate(() => {
    const bring = document.querySelector('lair-session-form [name="bring"]');
    const field = document.querySelector('lair-session-form [data-sf-books]');
    const safety = document.querySelector('lair-session-form [name="safety"]');
    return Boolean(bring && field && safety) && (bring.compareDocumentPosition(field) & 4) > 0 && (field.compareDocumentPosition(safety) & 4) > 0;
  })), 'between What to bring and Safety tools');
  await form.locator('[data-sf-book-search]').fill('blades');
  await page.waitForSelector('lair-session-form .sf-found', { timeout: 5000 });
  text = flat(await form.locator('[data-sf-book-results]').innerText());
  check(tag, text === 'Blades in the Dark DGLRPG-005 Add', 'the search finds the book by a word of its title', text);
  await form.locator('[data-sf-book-search]').press('Enter');
  await page.waitForTimeout(300);
  check(tag, (await form.locator('[data-step="table"]').count()) === 1, 'Enter in the search looks again: it doesn\'t send the step');
  await form.locator('[data-sf-book-add]').click();
  await page.waitForTimeout(150);
  check(tag, flat(await form.locator('[data-sf-book-list]').innerText()) === 'Blades in the Dark' && flat(await form.locator('[data-sf-book-results]').innerText()) === 'Blades in the Dark DGLRPG-005 Added',
    'Add puts it on the game, and the result says Added');
  await form.locator('[data-sf-book-search]').fill('call');
  await page.waitForFunction(() => /Cthulhu/.test(document.querySelector('lair-session-form [data-sf-book-results]')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  await form.locator('[data-sf-book-add]').click();
  await page.waitForTimeout(150);
  check(tag, (await form.locator('.sf-book').count()) === 2, 'a second book');
  if (phone) check(tag, (await small(page, 'lair-session-form [data-sf-books]')).length === 0, 'the field\'s controls are 44px or more', (await small(page, 'lair-session-form [data-sf-books]')).join(', '));
  await form.locator('[data-sf-books]').screenshot({ path: `${OUT}${tag}-2a-picker.png` });
  await form.locator('[data-sf-book-remove]').nth(1).click();
  await page.waitForTimeout(150);
  check(tag, (await form.locator('.sf-book').count()) === 1 && (await page.evaluate(() => document.activeElement && document.activeElement.matches('[data-sf-book-search]'))), 'one taken off, and the keyboard goes back to the search');
  await form.locator('.pay-option', { hasText: 'ready-made' }).first().click().catch(() => form.locator('[name="characters"]').first().check({ force: true }));
  await page.locator('[data-step-next]').click();
  await page.waitForSelector('lair-session-form [data-step="when"]');
  // back and forward: the book is still there
  await page.locator('[data-step-back]').click();
  await page.waitForSelector('lair-session-form [data-step="table"]');
  check(tag, flat(await form.locator('[data-sf-book-list]').innerText()) === 'Blades in the Dark', 'going back keeps the book');
  const payload = await page.evaluate(() => {
    const el = document.querySelector('lair-session-form');
    return el.payload().books;
  });
  check(tag, JSON.stringify(payload) === JSON.stringify(['48100000000024']), 'the game is sent with the book\'s id', JSON.stringify(payload));
  // listing it through the backend the form uses (the map's taps are round 5's checks)
  const made = await page.evaluate(async () => {
    const { store } = window.Lair;
    const t = store.time;
    const el = document.querySelector('lair-session-form');
    const base = el.payload();
    for (let day = 2; day < 12; day += 1) {
      for (const table of store.cfg.tables) {
        const start = t.at(t.addDays(t.today(), day), 13 * 60);
        try {
          const r = await store.backend.createGame({ ...base, tables: [table.id], start, end: start + 3 * 3600000, email: store.cfg.customer.email, customerId: store.cfg.customer.id });
          return { books: (r.game.books || []).map((b) => `${b.title}:${b.out}:${b.withYou}`), perk: r.perk || null };
        } catch (e) {
          if (!e.status) throw e;
        }
      }
    }
    return null;
  });
  check(tag, made && made.books.join() === 'Blades in the Dark:1:false', 'the game is listed with its book, and where the book is', JSON.stringify(made));
  check(tag, (await overflow(page)) === 0, 'Run a game: no sideways scroll');

  /* ---------- 4. a library book's page: which table would like it ---------- */
  const bigby = await page.evaluate(async () => {
    const be = window.Lair.store.backend;
    const me = await be.me();
    const g = (me.games || []).find((x) => x.status === 'open' && x.end > Date.now());
    await be.setGameBooks(g.id, { books: ['48100000000010'], scope: 'session' });
    return g.title;
  });
  await visit(page, PLAIN, '/products/d-d-bigby-library');
  await page.waitForSelector('library-reserve .library-reserve__wanted', { timeout: 10000 }).catch(() => {});
  text = flat(await page.locator('library-reserve').innerText().catch(() => ''));
  check(tag, /A table would like this one on \w{3} \d{1,2} \w{3}, \d{1,2}(:\d\d)?[ap]m\. Borrow it by all means, and bring it back by then if you can\./.test(text), 'the book\'s page says when a table would like it', text.slice(0, 300));
  await page.locator('library-reserve').screenshot({ path: `${OUT}${tag}-3c-page.png` }).catch(() => {});
  await visit(page, GM, '/products/d-d-bigby-library');
  await page.waitForSelector('library-reserve .library-reserve__wanted', { timeout: 10000 }).catch(() => {});
  text = flat(await page.locator('library-reserve').innerText().catch(() => ''));
  check(tag, /It's down for your own game on \w{3} \d{1,2} \w{3}/.test(text), `its GM sees it's down for their own game (${bigby})`, text.slice(0, 300));
  check(tag, (await overflow(page)) === 0, 'the book\'s page: no sideways scroll');
  check(tag, page.errors.length === 0, 'the GM\'s pages: no console or page errors', page.errors.slice(0, 3).join(' | '));
  page.errors.length = 0;

  /* ---------- 5. staff ---------- */
  await openMyLibrary(page, STAFF);
  text = await lib(page);
  check(tag, text.includes('Staff slot One library game at home, free Because you\'re on the team.') && !text.includes('Every good GM needs'), 'the team\'s card: the staff slot, and no Gobgob line', text.slice(0, 200));
  await page.locator('my-library .mlib-perk').screenshot({ path: `${OUT}${tag}-1-staff-slot.png` });

  await visit(page, STAFF, '/pages/lair-staff');
  // (the Pieces look groups the tabs, so the Library tab's button can be folded away: the page's own setTab opens it)
  await page.waitForFunction(() => typeof document.querySelector('lair-staff')?.setTab === 'function' && document.querySelector('[data-library]'), null, { timeout: 10000 });
  await page.evaluate(() => document.querySelector('lair-staff').setTab('library'));
  await page.waitForSelector('[data-lib-loans] .staff-lib-rows', { timeout: 10000 });
  await page.waitForSelector('staff-gm-perks .sperk-row', { timeout: 10000 });
  await page.waitForTimeout(300);
  const row = (title) => page.locator('[data-lib-loans] .staff-loan', { hasText: title });
  text = flat(await row('Blades in the Dark').innerText());
  check(tag, text.includes('GM perk') && !text.includes('Lent'), 'Games at home: a perk book says GM perk, not Lent', text.slice(0, 200));
  text = flat(await row("Player's Handbook").innerText());
  check(tag, text.includes('GM perk') && /Wanted \w{3} \d{1,2} \w{3}, \d/.test(text), 'the GM\'s book: GM perk, and the table that would like it', text.slice(0, 260));
  await page.locator('[data-lib-loans]').screenshot({ path: `${OUT}${tag}-4b-loans.png` });
  text = flat(await page.locator('staff-gm-perks').innerText());
  check(tag, text.startsWith('GM perks') && /\bOn\b/.test(text) && text.includes('Resting') && text.includes('Taken away by Mo'), 'the GM perks list: on, resting, taken away', text.slice(0, 500));
  const order = await page.evaluate(() => [...document.querySelectorAll('staff-gm-perks .sperk-row .badge')].map((b) => b.textContent.trim()));
  check(tag, order.join() === [...order].sort((a, b) => ['On', 'Resting', 'Off'].indexOf(a) - ['On', 'Resting', 'Off'].indexOf(b)).join() && order.includes('On') && order.includes('Off'), 'on first, then resting, then off', order.join());
  await page.locator('staff-gm-perks').screenshot({ path: `${OUT}${tag}-4b-perks.png` });
  if (phone) check(tag, (await small(page, 'staff-gm-perks')).length === 0, 'the list\'s names are 44px or more to tap', (await small(page, 'staff-gm-perks')).join(', '));

  // open the first On member from the list
  await page.locator('staff-gm-perks .sperk-row', { has: page.locator('.badge', { hasText: /^On$/ }) }).last().locator('[data-member-view]').click();
  await page.waitForSelector('[data-person-perk]:not([hidden]) .sperk__facts', { timeout: 10000 });
  const perk = page.locator('[data-person-perk]');
  text = flat(await perk.innerText());
  check(tag, text.startsWith('GM perk On') && text.includes('Quiet sessions 0 of 3 in a row') && text.includes('On the slot Blades in the Dark') && text.includes("What’s happened"),
    'a member\'s page: GM perk, On, the facts and the log', text.slice(0, 420));
  check(tag, text.includes('Given by Mo') && text.includes('“Running our Sunday D&D”'), 'the log names who gave it, with their note');
  await perk.screenshot({ path: `${OUT}${tag}-4a-member-on.png` });
  await perk.locator('[data-perk-note]').fill('Stopped running games');
  await perk.locator('[data-perk-ask="take"]').click();
  text = flat(await perk.locator('.staff-confirm').innerText());
  check(tag, text.includes('Take the GM perk away from') && text.includes('Nothing is emailed.') && text.includes('Blades in the Dark stays at home with them until it’s scanned back in.'), 'Take it away asks first and says what happens', text);
  await perk.screenshot({ path: `${OUT}${tag}-4a-member-ask.png` });
  await perk.locator('[data-perk-do="take"]').click();
  await page.waitForFunction(() => /GM perk is switched off\./.test(document.querySelector('[data-person-perk]')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  text = flat(await perk.innerText());
  check(tag, text.startsWith('GM perk Off') && text.includes('Taken away') && text.includes('Note Stopped running games') && text.includes('Give the GM perk'), 'taken: Off, who and why, and Give the GM perk', text.slice(0, 360));
  await perk.screenshot({ path: `${OUT}${tag}-4a-member-off.png` });
  await perk.locator('[data-perk-ask="give"]').click();
  text = flat(await perk.locator('.staff-confirm').innerText());
  check(tag, text.includes('Give ') && text.includes('Gobgob emails them to say it’s on.'), 'Give asks first, and says they\'re emailed', text);
  await perk.locator('[data-perk-do="give"]').click();
  await page.waitForFunction(() => /has the GM perk\./.test(document.querySelector('[data-person-perk]')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  text = flat(await perk.innerText());
  check(tag, text.startsWith('GM perk On') && text.includes('given by Mo'), 'given: On again, given by Mo', text.slice(0, 300));
  if (phone) check(tag, (await small(page, '[data-person-perk]')).length === 0, 'the section\'s buttons are 44px or more', (await small(page, '[data-person-perk]')).join(', '));
  check(tag, (await overflow(page)) === 0, 'the staff page: no sideways scroll');
  check(tag, page.errors.length === 0, 'staff: no console or page errors', page.errors.slice(0, 3).join(' | '));
  await ctx.close();
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);

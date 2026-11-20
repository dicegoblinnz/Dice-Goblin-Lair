// A barcode several things share, on a tab (20 Nov 2026). Mo: the four Final Fantasy Commander decks are one product's
// four variants with one barcode, and scanning one in My Lair's Tab put Cloud's deck on straight away ("Fix it in my
// tab too"). My Lair's Tab on the theme mock (the demo), with GET /tab/lookup answered here as the Lair app does now
// (item, and choices when several things a tab takes share the code):
//  1. Scanning the shared barcode adds nothing: the product is on the menu, open, with each deck a row, and the
//     scanner says to pick which one.
//  2. Scanning it again (the decks are on the menu now, each with that barcode) still adds nothing and asks no lookup.
//  3. Tapping a deck's plus adds that deck, and only that one.
//  4. A barcode two different products share: both are on the menu, and the scanner says so.
//  5. A barcode only one thing has goes straight on, as before.
// No sideways scroll and no console errors. A phone (390x844).
// Usage: DG_THEME=/path/to/theme [PORT=4994] [OUT=dir] node tools/qa/shared-barcode/tab.mjs
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-shared-barcode');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, overflowX, shot, watch, go, context, flat, RUBY } = lib;
const PORT = Number(process.env.PORT || 4994);
const BASE = `http://localhost:${PORT}`;

const deck = (variantId, variantTitle, available = true) => ({
  variantId, productId: '10305361444967', handle: 'magic-the-gathering-final-fantasy-commander-decks', title: 'Magic the Gathering: Final Fantasy Commander Decks',
  variantTitle, price: 14000, image: null, available, barcode: '195166270999', sku: '',
});
const DECKS = [deck('51524039835751', 'Limit Break (Cloud, Final Fantasy VII)'), deck('51524039868519', 'Revival Trance (Terra, Final Fantasy VI)'), deck('51524039901287', "Scions & Spellcraft (Y'shtola, Final Fantasy XIV)"), deck('51524039934055', 'Counter Blitz (Tidus, Final Fantasy X)')];
const booster = (variantId, productId, title) => ({ variantId, productId, handle: `booster-${productId}`, title, variantTitle: '', price: 1000, image: null, available: true, barcode: '820650857442', sku: '' });
const BOOSTERS = [booster('5019', '109', 'Pokemon Surging Sparks Booster'), booster('5020', '110', 'Pokemon Prismatic Evolutions Booster')];
const ANSWERS = {
  '195166270999': { item: DECKS[0], choices: DECKS },
  '820650857442': { item: BOOSTERS[0], choices: BOOSTERS },
  '9300000000024': { item: { variantId: '5013', productId: '103', handle: 'riftbound-radiance', title: 'Riftbound Radiance', variantTitle: 'Booster Pack', price: 1599, image: null, available: true, barcode: '9300000000024', sku: '' } },
};

const server = await m.serve(PORT);
const browser = await chromium.launch();
m.globalSettings.lair_mode = 'demo';
const ctx = await context(browser, 'phone', '19:30');
const page = watch(await ctx.newPage());
await go(page, BASE, '/pages/my-lair#tab', RUBY);
await page.waitForSelector('[data-view="tab"]:not([hidden]) [data-scan]', { timeout: 15000 });
await page.waitForTimeout(400);
await page.evaluate((answers) => {
  window.__lookups = 0;
  window.Lair.store.backend.tabLookup = async (code) => {
    window.__lookups += 1;
    const hit = answers[String(code).replace(/^0+/, '')];
    if (!hit) throw Object.assign(new Error("Gobgob doesn't know that one. Pick it from the menu instead."), { status: 404 });
    return JSON.parse(JSON.stringify(hit));
  };
}, ANSWERS);

/** Scan by typing (headless Chrome has no camera, so the sheet offers typing): the scanner's line */
const scan = async (code) => {
  await page.click('[data-view="tab"] [data-scan]');
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
  const line = (await status.count()) ? flat(await status.textContent()) : '';
  await page.evaluate(() => window.LairScan.close());
  await page.waitForTimeout(300);
  return line;
};
/** The menu's scanned groups: title, whether it's open, its rows, and how many of each are picked */
const look = () => page.evaluate(() => {
  const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const tab = document.querySelector('my-lair-tab') || document.querySelector('[data-view="tab"]');
  return {
    groups: [...tab.querySelectorAll('.ml-menu__group--scanned')].map((g) => ({
      title: f(g.querySelector('.ml-menu__title')?.textContent),
      open: g.classList.contains('is-open'),
      rows: [...g.querySelectorAll('.ml-menu__item')].map((r) => r.dataset.variant),
    })),
    picked: Object.fromEntries([...tab.querySelectorAll('.ml-menu__item')].map((r) => [r.dataset.variant, Number(r.dataset.qty) || 0]).filter(([, n]) => n)),
    lookups: window.__lookups,
  };
});

/* ---------- 1. the shared barcode asks ---------- */
let said = await scan('195166270999');
let v = await look();
check('a barcode four decks share: the scanner says to pick which one', said === 'Found Magic the Gathering: Final Fantasy Commander Decks. Pick which one from the menu.', said);
check('the product is on the menu once, open, with a row for each deck, and nothing is picked',
  v.groups.length === 1 && v.groups[0].open && v.groups[0].rows.join() === DECKS.map((d) => d.variantId).join() && Object.keys(v.picked).length === 0, v);
await shot(page, 'tab-1-which');
check('the menu with the decks: no sideways scroll', (await overflowX(page)) <= 0, await overflowX(page));

/* ---------- 2. again, from the menu ---------- */
said = await scan('0195166270999');
v = await look();
check('scanned again (as an EAN-13): still nothing picked, the same words, and no second lookup', said === 'Found Magic the Gathering: Final Fantasy Commander Decks. Pick which one from the menu.' && Object.keys(v.picked).length === 0 && v.groups.length === 1 && v.groups[0].rows.length === 4 && v.lookups === 1, { said, v });

/* ---------- 3. picking ---------- */
await page.click(`.ml-menu__item[data-variant="${DECKS[3].variantId}"] [data-step="1"]`);
await page.waitForTimeout(300);
v = await look();
check("tapping Tidus's plus picks Tidus's deck, and only that one", JSON.stringify(v.picked) === JSON.stringify({ [DECKS[3].variantId]: 1 }), v.picked);

/* ---------- 4. two different products on one barcode ---------- */
said = await scan('820650857442');
v = await look();
check('a barcode two products share: both on the menu, open, nothing more picked, and the scanner says so',
  said === 'Found a few with that barcode. Pick which one from the menu.' && v.groups.length === 3 && v.groups.filter((g) => /Booster/.test(g.title)).every((g) => g.open) && Object.keys(v.picked).length === 1, { said, v });

/* ---------- 5. one thing, one barcode ---------- */
said = await scan('9300000000024');
v = await look();
check('a barcode only one thing has goes straight on', said.startsWith('Added ') && v.picked['5013'] === 1, { said, picked: v.picked });
check('no console errors', page.errors.length === 0, page.errors);

await ctx.close();
const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed (screenshots in ${process.env.OUT})`);
await browser.close();
server.close?.();
process.exit(fail ? 1 : 0);

// A barcode several things share (10 Nov 2026). Mo: "when I scan an item that shares the same barcode as other items
// but clearly they are different types Shopify tells me to choose on its POS system, but my till doesn't do that".
// The till, on the theme mock, with a stand-in for the Lair app's till routes (till/product answers with choices):
//  1. Hemi unlocks; scanning the shared barcode asks "Which one is it?", nothing goes in the basket yet.
//  2. Tapping one puts that one in the basket and the question goes; scanning again asks again; the other one goes in.
//  3. A dice set whose colours share a barcode: one row, each colour a button.
//  4. "None of these" closes the question with nothing added.
//  5. The customer screen: a customer scanning it starts their basket and is asked "Which one have you got?".
//  6. A barcode only one thing has goes straight in, as before.
// No sideways scroll, no console errors and axe at each. The counter's tablet: 1280×800 and 800×1280.
// Usage: DG_THEME=/path/to/theme [PORT=4995] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/shared-barcode/till.mjs [wide|tall]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-shared-barcode');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, overflowX, axe, shot, watch, go, clockAt, STAFF } = lib;
const PORT = Number(process.env.PORT || 4995);
const BASE = `http://localhost:${PORT}`;
const API = (m.globalSettings.lair_api || '/apps/liar').replace(/\/$/, '');
const VIEWPORTS = { wide: { width: 1280, height: 800 }, tall: { width: 800, height: 1280 } };
const sizes = process.argv[2] ? [process.argv[2]] : ['wide', 'tall'];

const HEMI = { id: 'hemi', name: 'Hemi', fullName: 'Hemi Walker', role: 'owner', kind: 'team', roleWords: 'Owner', perms: ['checkin', 'money'], pin: 'own', off: false, locked: false };
const product = (id, title, variants, extra = {}) => ({ id, title, type: 'Trading Card Games', vendor: 'Pokemon', dice: false, variants, ...extra });
const variant = (id, title, price, stock) => ({ id, title, price, sku: null, available: stock > 0, stock });
const SPARKS = { product: product('109', 'Pokemon Surging Sparks Booster', [variant('5019', 'Default Title', 1000, 20)]), variant: variant('5019', 'Default Title', 1000, 20) };
const PRISM = { product: product('110', 'Pokemon Prismatic Evolutions Booster', [variant('5020', 'Default Title', 1400, 0)]), variant: variant('5020', 'Default Title', 1400, 0) };
const GREEN = { product: product('112', 'Glow Dice Set', [variant('5022', 'Green', 2000, 3)], { type: 'Dice & Accessories', vendor: 'Dice Goblin NZ', dice: true }), variant: variant('5022', 'Green', 2000, 3) };
const BLUE = { product: product('112', 'Glow Dice Set', [variant('5023', 'Blue', 2000, 2)], { type: 'Dice & Accessories', vendor: 'Dice Goblin NZ', dice: true }), variant: variant('5023', 'Blue', 2000, 2) };
const PRODUCTS = {
  '820650857442': { ...SPARKS, choices: [SPARKS, PRISM] },
  '6900000000123': { ...GREEN, choices: [GREEN, BLUE] },
  '9300000000024': { product: product('103', 'Riftbound Radiance', [variant('5013', 'Booster Pack', 1599, 5)], { vendor: 'Riot Games' }), variant: variant('5013', 'Booster Pack', 1599, 5) },
};
const PRICE = { 5019: 1000, 5020: 1400, 5022: 2000, 5023: 2000, 5013: 1599 };

function lairApp() {
  const state = { calls: [] };
  const answer = (status, body) => ({ status, body });
  const routes = {
    'till/team': () => answer(200, { team: [HEMI] }),
    'till/unlock': (b) => (b.id === 'hemi' && b.pin === '1234' ? answer(200, { token: 'tok-hemi', staff: HEMI, mustChange: false }) : answer(401, { error: "That PIN isn't right. Try again." })),
    'till/tonight': () => answer(200, { rows: [], night: null }),
    'till/scan': () => answer(404, { error: "Gobgob doesn't know that code." }),
    'till/product': (b) => (PRODUCTS[b.code] ? answer(200, PRODUCTS[b.code]) : answer(404, { error: "Gobgob can't find that in the shop. Search for it by name instead." })),
    'till/find': () => answer(200, { people: [] }),
    'till/search': () => answer(200, { products: [] }),
    'till/price': (b) => {
      const total = b.lines.reduce((sum, l) => sum + (PRICE[l.variantId] || 0) * (Number(l.qty) || 1), 0);
      return answer(200, { price: { subtotal: total, discounts: [], total, gst: Math.round((total * 3) / 23), lines: b.lines.map((l) => ({ key: l.key, qty: l.qty, unit: PRICE[l.variantId] })) }, dropped: [] });
    },
  };
  return {
    state,
    async handle(route) {
      const req = route.request();
      const name = new URL(req.url()).pathname.slice(API.length + 1);
      const body = req.method() === 'POST' ? JSON.parse(req.postData() || '{}') : {};
      state.calls.push({ name, body });
      const fn = routes[name];
      const { status, body: out } = fn ? fn(body) : answer(404, { error: 'No such route.' });
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(out) });
    },
  };
}

const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 400) => page.waitForTimeout(ms);

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';
  const lair = lairApp();
  const ctx = await browser.newContext({ viewport: VIEWPORTS[size], deviceScaleFactor: 1, hasTouch: true });
  await ctx.addInitScript(clockAt('19:30'));
  await ctx.route(`${BASE}${API}/**`, (route) => lair.handle(route));
  const page = watch(await ctx.newPage());
  const scan = async (code) => {
    await page.evaluate((c) => document.querySelector('lair-till').onScan(c), code);
    await settle(page, 700);
  };
  const tap = async (sel) => {
    const over = page.locator(`[data-r="over"] ${sel} >> visible=true`);
    await ((await over.count()) ? over : page.locator(`${sel} >> visible=true`)).first().click();
    await settle(page, 500);
  };
  const look = () => page.evaluate(() => {
    const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const card = document.querySelector('[aria-labelledby="t-results-title"]');
    return {
      head: f(card?.querySelector('#t-results-title')?.textContent),
      focused: document.activeElement?.id === 't-results-title',
      note: f(card?.querySelector('.t-card__head + .t-result__meta')?.textContent),
      close: f(card?.querySelector('[data-act="clear-search"]')?.textContent),
      rows: [...(card?.querySelectorAll('.t-result') || [])].map((r) => `${f(r.querySelector('.t-result__title')?.textContent)}: ${[...r.querySelectorAll('[data-act="result"]')].map((b) => f(b.textContent)).join(' | ')}`),
      lines: [...document.querySelectorAll('[data-r="sale"] .t-line')].map((l) => f(l.querySelector('.t-line__title, .t-line__name, p')?.textContent) + ' ×' + f(l.querySelector('.t-step .t-num')?.textContent)),
      toast: f(document.querySelector('[data-r="toast"]')?.textContent),
    };
  });

  await go(page, BASE, '/pages/till', STAFF);
  await page.waitForSelector('[data-act="staff-door"]', { timeout: 20000 });
  await settle(page, 500);
  await tap('[data-act="staff-door"]');
  await tap('[data-act="pick"][data-id="hemi"]');
  for (const d of '1234') await tap(`[data-act="digit"][data-d="${d}"]`);
  await settle(page, 800);

  /* ---------- 1. the shared barcode asks ---------- */
  await scan('820650857442');
  let v = await look();
  check(`${tag} a shared barcode asks "Which one is it?" with both boosters, and adds nothing yet`,
    v.head === 'Which one is it?' && v.rows.length === 2 && v.rows[0].startsWith('Pokemon Surging Sparks Booster: $10.00') && v.rows[1].startsWith('Pokemon Prismatic Evolutions Booster: $14.00 · none on the shelf') && v.lines.length === 0, v);
  check(`${tag} it says why, the way out is "None of these", and the question has focus`, v.note === 'These all have barcode 820650857442. Tap the one in their hand.' && v.close === 'None of these' && v.focused, v);
  await shot(page, `till-${size}-1-which`);
  await axe(page, `${tag} the question`, '[aria-labelledby="t-results-title"]');
  check(`${tag} the question: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));

  /* ---------- 2. picking ---------- */
  await tap('[data-act="result"][data-i="1"][data-j="0"]');
  v = await look();
  check(`${tag} tapping Prismatic Evolutions puts it in the sale and the question goes`, v.head === '' && v.lines.length === 1 && /Prismatic Evolutions/.test(v.lines[0]), v);
  await scan('820650857442');
  await tap('[data-act="result"][data-i="0"][data-j="0"]');
  await scan('820650857442');
  await tap('[data-act="result"][data-i="0"][data-j="0"]');
  v = await look();
  check(`${tag} scanning again asks again; Surging Sparks twice is one line of 2`, v.lines.length === 2 && v.lines.some((l) => /Surging Sparks.*×2$/.test(l)), v);
  const sent = lair.state.calls.filter((c) => c.name === 'till/price').at(-1)?.body.lines || [];
  check(`${tag} the price asked for is the two that were picked`, sent.map((l) => `${l.variantId}×${l.qty}`).sort().join(',') === '5019×2,5020×1', sent);

  /* ---------- 3. a dice set's colours ---------- */
  await scan('6900000000123');
  v = await look();
  check(`${tag} a dice set's colours on one barcode: one row, a button each`, v.rows.length === 1 && v.rows[0] === 'Glow Dice Set: Green · $20.00 | Blue · $20.00', v);

  /* ---------- 4. None of these ---------- */
  await tap('[data-act="clear-search"]');
  v = await look();
  check(`${tag} "None of these" closes it with nothing added`, v.head === '' && v.lines.length === 2, v);

  /* ---------- 6. one thing on a barcode: straight in ---------- */
  await scan('9300000000024');
  v = await look();
  check(`${tag} a barcode only one thing has goes straight in`, v.head === '' && v.lines.length === 3, v);

  /* ---------- 5. the customer screen ---------- */
  await tap('[data-act="clear-sale"], [data-act="new-sale"]').catch(() => {});
  await tap('[data-act="to-customers"]');
  await settle(page, 600);
  await scan('820650857442');
  v = await look();
  check(`${tag} the customer screen: "Which one have you got?" in the customer's words`,
    v.head === 'Which one have you got?' && v.note === 'These all have the same barcode. Tap the one in your hand.' && v.rows.length === 2, v);
  await shot(page, `till-${size}-2-customer-which`);
  await axe(page, `${tag} the customer's question`, '[aria-labelledby="t-results-title"]');
  await tap('[data-act="result"][data-i="0"][data-j="0"]');
  v = await look();
  check(`${tag} the customer's pick goes in their basket`, v.head === '' && v.lines.some((l) => /Surging Sparks/.test(l)), v);
  check(`${tag} the customer screen: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  check(`${tag} no console errors`, page.errors.length === 0, page.errors);
  await ctx.close();
}

const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed (screenshots in ${process.env.OUT})`);
await browser.close();
server.close?.();
process.exit(fail ? 1 : 0);

// Paint pages (Warhammer and hobby chat; Mo picked "A · Better colour sheet", 6 Nov 2026), on the theme mock, in a real
// browser at phone (390px) then desktop (1280px):
//   1. the Colours dropdown flags a colour with 1 to 3 left ("Only 2 left"), never a sold-out one or one with more
//   2. the match line: hidden on a colour with no match, right after picking one that has one (the dropdown, no reload),
//      and already there when the page opens on it (?variant=)
//   3. Pick several: the count of colours on the shelf; the sheet opens (a bottom sheet on a phone); "blue" finds the four
//      blues; sold-out colours can't be ticked; two ticks give "2 colours picked" and "Add 2 to cart · $16.00"; ticking
//      never changes the page's colour; Enter in the filter adds nothing; Add puts each colour in the cart once, closes
//      the sheet and opens the cart drawer; Esc and a tap outside close it, focus back on Pick several
//   4. no Pick several on Games Workshop's paints (their cart lines carry the ordered-in chat's note), but the match line;
//      nothing on a paint product with two options
//   5. axe (WCAG 2.2 A and AA) on the picker and the open sheet; no sideways scroll; no console errors
// The mock's Vallejo colours stand in for the store's 196: type Paints & Hobby, stock tracked and not sold past zero (as
// every Vallejo colour is in the store, checked 6 Nov 2026), Bloody Red 1, Magic Blue 2 and Black 3 left, and the
// paint.match metafield on Ultramarine Blue and Black (the store's agreed pairs, with their real Warhammer Colour ids).
// Usage: DG_THEME=/path/to/theme [PORT=4994] [AXE=/path/to/axe.min.js] [OUT=/dir] node tools/qa/paints/paints.mjs
// Exits 1 on a FAIL.
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
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
const PORT = Number(process.env.PORT || 4994);
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-paints');
fs.mkdirSync(OUT, { recursive: true });
const AXE = process.env.AXE && fs.existsSync(process.env.AXE) ? fs.readFileSync(process.env.AXE, 'utf8') : null;

/* ---------------- the mock's Vallejo range as the store has it ---------------- */
const vgc = m.allProducts['vallejo-game-colour'];
vgc.type = 'Paints & Hobby';
const colour = (name) => vgc.variants.find((v) => v.title === name);
for (const v of vgc.variants) v.inventory_policy = 'deny';
colour('Bloody Red').inventory_quantity = 1;
colour('Magic Blue').inventory_quantity = 2;
colour('Black').inventory_quantity = 3;
const LOW = { 'Bloody Red': 1, 'Magic Blue': 2, Black: 3 };
const gwPot = (title, id) => ({
  id, title, url: `/products/warhammer-colour-paints?variant=${id}`, product: { title: 'Warhammer Colour Paints', vendor: 'Games Workshop' },
});
colour('Ultramarine Blue').metafields = { paint: { match: { value: gwPot('Base: Macragge Blue', 50719784108135) } } };
colour('Black').metafields = { paint: { match: { value: gwPot('Base: Abaddon Black', 50719783977063) } } };
const paintSet = m.allProducts['paint-set-starter'];
paintSet.type = 'Paints & Hobby';
const onShelf = vgc.variants.filter((v) => v.available).length;

/* ---------------- checks ---------------- */
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 700)}`}`);
  return ok;
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
// The mock's cart lines carry the product's title only: the colour comes from the variant id
const colourOf = (id) => vgc.variants.find((v) => Number(v.id) === Number(id))?.title || `variant ${id}`;
const cartItems = async () => (await (await fetch(`${BASE}/cart.js`)).json()).items.map((i) => `${colourOf(i.variant_id)} x${i.quantity}`);
const emptyCart = () => {
  m.mockCart.lines.length = 0;
};
async function axe(page, label, selector) {
  if (!AXE) return;
  await page.addScriptTag({ content: AXE });
  const found = await page.evaluate(async (sel) => {
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      const r = await window.axe.run(el, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
      out.push(...r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`));
    }
    return out;
  }, selector);
  check(`axe: ${label}`, !found.length, found.join(' / '));
}

const server = await m.serve(PORT);
const browser = await chromium.launch();
for (const size of ['phone', 'desktop']) {
  const phone = size === 'phone';
  console.log(`\n== ${size} ==`);
  emptyCart();
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(`console: ${msg.text()}`);
  });
  const adds = [];
  page.on('request', (req) => {
    if (/\/cart\/add/.test(req.url())) adds.push(req.postData() || '');
  });
  await page.goto(`${BASE}/products/vallejo-game-colour`, { waitUntil: 'networkidle' });

  // 1. low stock in the dropdown
  const flags = await page.$$eval('.vselect__option', (rows) => rows
    .map((r) => [r.dataset.value, r.querySelector('.vselect__flag--low')?.textContent.trim() || ''])
    .filter(([, low]) => low));
  check('the dropdown flags exactly the colours with 1 to 3 left', JSON.stringify(flags) === JSON.stringify(Object.entries(LOW).map(([n, q]) => [n, `Only ${q} left`])), flags);

  // 2. the match line
  const match = page.locator('paint-match');
  check('the match line is hidden on Dead White (no match)', (await match.count()) === 1 && (await match.isHidden()));
  const variantId = () => page.locator('[data-variant-id]').inputValue();
  const pick = async (name) => {
    await page.locator('[data-vselect-button]').click();
    await page.locator(`.vselect__option[data-value="${name}"]`).click();
    await page.waitForTimeout(150);
  };
  await pick('Ultramarine Blue');
  check('picking Ultramarine Blue shows its match', (await match.isVisible()) && flat(await match.innerText()) === "Matches Warhammer Colour's Macragge Blue", flat(await match.innerText()));
  check('the match links to the Warhammer pot', (await match.locator('a').getAttribute('href')) === '/products/warhammer-colour-paints?variant=50719784108135');
  check('the page is on Ultramarine Blue', (await variantId()) === String(colour('Ultramarine Blue').id));
  await pick('Imperial Blue');
  check('picking Imperial Blue (no match) hides it again', await match.isHidden());
  await pick('Ultramarine Blue');
  if (phone) await page.locator('variant-picker').screenshot({ path: `${OUT}/${size}-picker.png` });

  // 3. Pick several
  const picks = page.locator('paint-picks');
  check('the count of colours on the shelf', flat(await picks.locator('.paint-picks__count').innerText()) === `${onShelf} of ${vgc.variants.length} colours on the shelf at the Lair.`, await picks.locator('.paint-picks__count').innerText());
  await axe(page, 'the picker, the match line and Pick several', 'variant-picker');
  const before = await variantId();
  const openButton = picks.locator('[data-picks-open]');
  await openButton.click();
  const dialog = picks.locator('dialog');
  check('Pick several opens the sheet', await dialog.evaluate((d) => d.open));
  await page.waitForTimeout(400); // its slide-in
  const box = await dialog.boundingBox();
  if (phone) check('on a phone it is a sheet along the bottom', Math.abs(box.y + box.height - 844) < 2 && Math.abs(box.width - 390) < 2, box);
  else check('on a wide screen it sits in the middle', box.width <= 34 * 16 + 1 && Math.abs(box.x + box.width / 2 - 640) < 2, box);
  check('on a phone the keyboard stays down (the filter is not focused)', phone ? !(await picks.locator('[data-picks-filter]').evaluate((el) => el === document.activeElement)) : await picks.locator('[data-picks-filter]').evaluate((el) => el === document.activeElement));
  const sold = picks.locator('.paint-picks__row', { hasText: 'Pale Flesh' });
  check('a sold-out colour says so and cannot be ticked', (await sold.locator('input').isDisabled()) && /Sold out/.test(await sold.innerText()), await sold.innerText());
  check('a low colour says how many', /Only 2 left/.test(await picks.locator('.paint-picks__row', { hasText: 'Magic Blue' }).innerText()));
  await picks.locator('[data-picks-filter]').fill('blue');
  const shown = await picks.locator('.paint-picks__row:not([hidden]) .paint-picks__name').allInnerTexts();
  check('"blue" finds the four blues', JSON.stringify(shown) === JSON.stringify(['Imperial Blue', 'Ultramarine Blue', 'Magic Blue', 'Electric Blue']), shown);
  await picks.locator('[data-picks-filter]').press('Enter');
  await page.waitForTimeout(300);
  check('Enter in the filter adds nothing and stays on the page', adds.length === 0 && (await dialog.evaluate((d) => d.open)), adds);
  await picks.locator('.paint-picks__row', { hasText: 'Imperial Blue' }).locator('label').click();
  await picks.locator('.paint-picks__row', { hasText: 'Magic Blue' }).locator('label').click();
  check('two ticks: "2 colours picked"', flat(await picks.locator('[data-picks-summary]').innerText()) === '2 colours picked', await picks.locator('[data-picks-summary]').innerText());
  check('the Add button gives the count and total', flat(await picks.locator('[data-picks-add]').innerText()) === 'Add 2 to cart · $16.00', await picks.locator('[data-picks-add]').innerText());
  check('ticking never changes the page colour', (await variantId()) === before && /Ultramarine Blue/.test(await page.locator('[data-vselect-name]').innerText()));
  await axe(page, 'the open sheet', 'paint-picks dialog');
  check('no sideways scroll with the sheet open', (await overflowX(page)) <= 0);
  await page.screenshot({ path: `${OUT}/${size}-sheet.png` });
  await picks.locator('[data-picks-add]').click();
  await page.waitForTimeout(900);
  const items = await cartItems();
  check('Add puts each colour in the cart once, in one request', adds.length === 1 && JSON.stringify(items.sort()) === JSON.stringify(['Imperial Blue x1', 'Magic Blue x1']), { adds, items });
  check('the sheet closes and the cart drawer opens', !(await dialog.evaluate((d) => d.open)) && (await page.locator('cart-drawer dialog').evaluate((d) => d.open)));
  check('the ticks are cleared for next time', (await picks.locator('input:checked').count()) === 0 && (await picks.locator('[data-picks-add]').isDisabled()));
  await page.screenshot({ path: `${OUT}/${size}-drawer.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // closing: Esc (one press, even with words in the filter), and a tap outside the sheet
  await openButton.click();
  check('after an add the sheet starts fresh (empty filter, every colour)', (await picks.locator('[data-picks-filter]').inputValue()) === '' && (await picks.locator('.paint-picks__row[hidden]').count()) === 0);
  await picks.locator('[data-picks-filter]').fill('red');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('one Esc closes it, focus back on Pick several', !(await dialog.evaluate((d) => d.open)) && (await openButton.evaluate((b) => b === document.activeElement)));
  await openButton.click();
  await page.mouse.click(phone ? 195 : 40, phone ? 20 : 400);
  await page.waitForTimeout(200);
  check('a tap outside closes it', !(await dialog.evaluate((d) => d.open)));
  check('no sideways scroll on the page', (await overflowX(page)) <= 0);

  // the match line drawn on arrival (?variant=)
  await page.goto(`${BASE}/products/vallejo-game-colour?variant=${colour('Black').id}`, { waitUntil: 'networkidle' });
  check('opening on Black shows its match straight away', (await match.isVisible()) && flat(await match.innerText()) === "Matches Warhammer Colour's Abaddon Black", flat(await match.innerText()));

  // 4. Games Workshop's paints, and a paint product with two options
  vgc.vendor = 'Games Workshop';
  await page.goto(`${BASE}/products/vallejo-game-colour?variant=${colour('Black').id}`, { waitUntil: 'networkidle' });
  check("Games Workshop's paints: the match line, no Pick several", (await match.isVisible()) && (await page.locator('paint-picks').count()) === 0);
  vgc.vendor = 'Vallejo';
  await page.goto(`${BASE}/products/paint-set-starter`, { waitUntil: 'networkidle' });
  check('a paint product with two options gets neither', (await page.locator('paint-picks, paint-match').count()) === 0 && (await page.locator('.vselect__flag--low').count()) === 0);
  check('no console errors', !errors.length, errors);
  await ctx.close();
}
await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed. Screenshots in ${OUT}`);
process.exit(fail ? 1 : 0);

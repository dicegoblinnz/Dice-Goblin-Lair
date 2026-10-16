// Round 16 (16 Oct 2026), the game page, on the theme mock: the summary under the title with Read more down to About the
// game, the markers (players, play time, age, difficulty and type), the stock and delivery box (in stock, only N left,
// sold out, not tracked, and following a variant pick), Order as a gift (its fields off until it's opened, the line's
// properties in the add, empty ones left out, the cart's gift line, closed and emptied once it's in), Try it first (by
// metafield and by the -library handle rule) and Want your own?, the plain layout for everything that isn't a game (and
// the library membership), the wishlist's heart (switched off by default; on, in demo mode and live against a stubbed
// Lair app, and logged out), no sideways scroll, and axe. Phone and desktop.
// Usage: DG_THEME=/path/to/theme [PORT=4975] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round16/game-page.mjs [phone|desktop]
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
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round16-game-page');
fs.mkdirSync(OUT, { recursive: true });
const AXE = process.env.AXE || '';
const axe = AXE && fs.existsSync(AXE) ? fs.readFileSync(AXE, 'utf8') : null;
const PORT = Number(process.env.PORT || 4975);
const BASE = `http://localhost:${PORT}`;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const RUBY = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [] };

let pass = 0;
let fail = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else {
    fail += 1;
    fails.push(name);
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 900)}`}`);
  return ok;
};
async function scan(page, label, selector) {
  if (!axe) {
    console.log(`SKIP axe: ${label} (no AXE)`);
    return;
  }
  await page.addScriptTag({ content: axe });
  const found = await page.evaluate(async (sel) => {
    const nodes = [...document.querySelectorAll(sel)];
    const out = [];
    for (const node of nodes) {
      const r = await window.axe.run(node, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
      out.push(...r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} ${n.failureSummary || ''}`).join(' | ')}`));
    }
    return { count: nodes.length, out };
  }, selector);
  check(`axe: ${label} (${found.count} node)`, found.count > 0 && !found.out.length, found.out.join(' / ') || 'nothing matched');
}
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const server = await m.serve(PORT);
const browser = await chromium.launch();

/** What the page shows, top to bottom in the buy column */
const look = (page) => page.evaluate(() => {
  const flatten = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const seen = (el) => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const q = (s) => document.querySelector(s);
  const info = q('.product__info');
  const order = [...info.querySelectorAll('.product__title, .product__brief, .markers, [data-product-price], .promise, .product__buy, gift-option, .pair-card, .product__about, .borrow-card, .lair-callout, .product__details')]
    .filter(seen).map((el) => el.className.split(' ')[0] || el.tagName.toLowerCase());
  const promise = q('[data-promise]');
  return {
    order,
    brief: flatten(q('.product__brief')?.textContent),
    briefHtml: q('.product__brief')?.innerHTML || '',
    more: q('.product__more') ? { text: flatten(q('.product__more').textContent), href: q('.product__more').getAttribute('href') } : null,
    markers: [...document.querySelectorAll('.marker')].map((li) => ({ label: flatten(li.querySelector('.marker__label')?.textContent), value: flatten(li.querySelector('.marker__value')?.textContent), level: li.dataset.level || null, pips: li.querySelectorAll('.marker__pips span').length })),
    stats: document.querySelectorAll('.product__head .stats').length,
    promise: promise && seen(promise) ? [...promise.querySelectorAll('.promise__line')].filter(seen).map((li) => flatten(li.textContent)) : [],
    add: flatten(q('[data-add-label]')?.textContent),
    addDisabled: Boolean(q('[data-add-button]')?.disabled),
    gift: seen(q('gift-option')),
    pair: q('.pair-card') ? { title: flatten(q('.pair-card__title').textContent), text: flatten(q('.pair-card__text').textContent), links: [...q('.pair-card').querySelectorAll('a')].map((a) => ({ text: flatten(a.textContent), href: a.getAttribute('href') })) } : null,
    about: q('.product__about') ? { id: q('.product__about').id, title: flatten(q('.product__about-title').textContent), text: flatten(q('.product__about .rte').textContent) } : null,
    description: flatten(q('.product__description')?.textContent),
    callout: seen(q('.lair-callout')),
    wishlist: seen(q('wishlist-button')),
    sideways: document.scrollingElement.scrollWidth - window.innerWidth,
  };
});

for (const size of process.argv[2] ? [process.argv[2]] : ['phone', 'desktop']) {
  const phone = size === 'phone';
  const newCtx = async () => browser.newContext({ viewport: SIZES[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, locale: 'en-NZ' });
  const ctx = await newCtx();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const open = async (p) => {
    await page.goto(`${BASE}${p}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(150);
    return look(page);
  };
  const tag = `[${size}]`;

  /* ---- a shop game with a library copy found by the handle rule (catan and catan-library) ---- */
  let v = await open('/products/catan');
  check(`${tag} catan: the order is title, summary, markers, price, stock and delivery, buy, gift, Try it first, About`, JSON.stringify(v.order.slice(0, 9)) === JSON.stringify(['h1', 'rte', 'markers', 'product__price', 'promise', 'product__buy', 'gift-order', 'pair-card', 'product__about']), v.order);
  check(`${tag} catan: the summary is the "Catan is …" paragraph`, v.brief.startsWith('Catan is the classic trading and building board game') && !/Gobgob/.test(v.brief), v.brief);
  check(`${tag} catan: Read more goes to About the game`, v.more && v.more.text === 'Read more' && v.about && v.more.href === `#${v.about.id}` && v.about.title === 'About the game', { more: v.more, about: v.about && v.about.id });
  check(`${tag} catan: About the game has the rest (hook, favourite bit, stats, shop and video lines) and not the summary`, v.about && v.about.text.startsWith('Gobgob has wood for sheep.') && v.about.text.includes("Gobgob's favourite bit") && v.about.text.includes('👥 3–4 players') && v.about.text.includes('🛒') && v.about.text.includes('Watch how to play') && !v.about.text.includes('Catan is the classic'), v.about && v.about.text);
  check(`${tag} catan: markers Players, Play time, Age, Difficulty (2 pips) and Type`, JSON.stringify(v.markers.map((x) => `${x.label}=${x.value}`)) === JSON.stringify(['Players=3–4', 'Play time=60–90 min', 'Age=10+', 'Difficulty=Medium', 'Type=Strategy, Classic']) && v.markers[3].level === '2' && v.markers[3].pips === 3, v.markers);
  check(`${tag} catan: no stats pills (the markers have them)`, v.stats === 0, v.stats);
  check(`${tag} catan: In stock and Ships within 3 working days`, JSON.stringify(v.promise) === JSON.stringify(['In stock', 'Ships within 3 working days']), v.promise);
  check(`${tag} catan: Try it first, to the library copy and to book a table`, v.pair && v.pair.title === 'Try it first' && v.pair.links[0].href === '/products/catan-library' && v.pair.links[1].href.startsWith('/pages/book') && /Borrow it/.test(v.pair.links[0].text) && /Play it at the Lair/.test(v.pair.links[1].text), v.pair);
  check(`${tag} catan: the Lair callout block steps aside for Try it first`, v.callout === false, v.callout);
  check(`${tag} catan: Order as a gift shows, the wishlist doesn't (switched off)`, v.gift && !v.wishlist, { gift: v.gift, wishlist: v.wishlist });
  check(`${tag} catan: no sideways scroll`, v.sideways <= 0, v.sideways);
  await page.screenshot({ path: path.join(OUT, `${size}-catan.png`), fullPage: true });
  await scan(page, `${tag} catan buy column`, '.product__info');

  /* ---- Read more lands on About the game ---- */
  await page.click('.product__more');
  await page.waitForTimeout(400);
  const landed = await page.evaluate(() => { const r = document.querySelector('.product__about').getBoundingClientRect(); return { top: Math.round(r.top), hash: location.hash }; });
  check(`${tag} Read more scrolls About the game into view`, landed.hash.startsWith('#about-') && landed.top >= 0 && landed.top < (phone ? 844 : 800) * 0.5, landed);

  /* ---- Order as a gift ---- */
  await page.goto(`${BASE}/products/catan`, { waitUntil: 'networkidle' });
  const before = await page.evaluate(() => [...document.querySelectorAll('[data-gift-field], [data-gift-flag]')].map((f) => f.disabled));
  check(`${tag} gift: closed, its fields are switched off`, before.length === 4 && before.every(Boolean), before);
  await page.click('.gift-order__toggle');
  await page.waitForTimeout(150);
  const opened = await page.evaluate(() => ({
    disabled: [...document.querySelectorAll('[data-gift-field], [data-gift-flag]')].map((f) => f.disabled),
    add: document.querySelector('[data-add-label]').textContent.trim(),
    bar: document.querySelector('[data-buy-bar-label]')?.textContent.trim(),
    lede: document.querySelector('.gift-order__lede').textContent.trim(),
    labels: [...document.querySelectorAll('.gift-order__fields .field__label')].map((l) => l.textContent.trim()),
  }));
  check(`${tag} gift: opened, its fields are on and the buttons say Add gift to cart`, opened.disabled.every((d) => !d) && opened.add === 'Add gift to cart' && opened.bar === 'Add gift to cart', opened);
  const payHidden = await page.evaluate(() => getComputedStyle(document.querySelector('.shopify-payment-button')).display === 'none');
  check(`${tag} gift: Buy it now steps aside while the gift is open (it would skip the gift's details)`, payHidden, payHidden);
  check(`${tag} gift: it says no prices and the message goes in the box`, /no price on it or on the packing slip/.test(opened.lede) && /your message in the box/.test(opened.lede) && JSON.stringify(opened.labels) === JSON.stringify(["Who's it for?", "Who's it from?", 'Your message']), opened);
  await page.screenshot({ path: path.join(OUT, `${size}-gift-open.png`), fullPage: false });
  await scan(page, `${tag} gift open`, 'gift-option');
  await page.fill('#GiftFor-template--1__main', 'Aroha');
  await page.fill('#GiftMessage-template--1__main', 'Happy birthday!\nSee you at games night.');
  m.mockCart.lines = [];
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/cart/add') && r.method() === 'POST'),
    page.click('[data-add-button]'),
  ]);
  const body = request.postData() || '';
  await page.waitForTimeout(500);
  const line = m.mockCart.lines[0] || {};
  check(`${tag} gift: the add carries Gift, Gift for and Gift message, and leaves the empty Gift from out`, /name="properties\[Gift\]"/.test(body) && /name="properties\[Gift for\]"\r\n\r\nAroha/.test(body) && /Happy birthday!\r?\nSee you at games night\./.test(body) && !/Gift from/.test(body), body.slice(0, 900));
  check(`${tag} gift: the cart line has the properties`, line.properties && line.properties.Gift === 'Yes, no prices' && line.properties['Gift for'] === 'Aroha' && /See you at games night/.test(line.properties['Gift message'] || '') && !('Gift from' in line.properties), line.properties);
  const drawer = await page.evaluate(() => {
    const d = document.querySelector('cart-drawer');
    const item = d?.querySelector('.cart-item');
    return item ? { gift: item.querySelector('.cart-item__gift')?.textContent.trim(), meta: [...item.querySelectorAll('.cart-item__meta div')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()) } : null;
  });
  check(`${tag} gift: the cart shows it's a gift with who it's for and the message, not a Gift row`, drawer && drawer.gift === 'A gift: sent with no prices' && drawer.meta.some((x) => x === 'Gift for: Aroha') && drawer.meta.some((x) => /^Gift message: Happy birthday!/.test(x)) && !drawer.meta.some((x) => /^Gift:/.test(x)), drawer);
  await page.screenshot({ path: path.join(OUT, `${size}-gift-cart.png`), fullPage: false });
  const after = await page.evaluate(() => ({
    open: document.querySelector('[data-gift-details]').open,
    values: [...document.querySelectorAll('[data-gift-field]')].map((f) => f.value),
    disabled: [...document.querySelectorAll('[data-gift-field], [data-gift-flag]')].map((f) => f.disabled),
    add: document.querySelector('[data-add-label]').textContent.trim(),
  }));
  const payBack = await page.evaluate(() => getComputedStyle(document.querySelector('.shopify-payment-button')).display !== 'none');
  check(`${tag} gift: closed again, Buy it now is back`, payBack, payBack);
  check(`${tag} gift: once it's in the cart, the gift closes and empties, and Add to cart is back`, !after.open && after.values.every((x) => x === '') && after.disabled.every(Boolean) && after.add === 'Add to cart', after);
  // the next add isn't a gift
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('cart-drawer')?.close?.());
  m.mockCart.lines = [];
  const [plain] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/cart/add') && r.method() === 'POST'),
    page.evaluate(() => document.querySelector('[data-add-button]').click()),
  ]);
  await page.waitForTimeout(300);
  check(`${tag} gift: a plain add sends no gift properties`, !/properties\[/.test(plain.postData() || '') && Object.keys(m.mockCart.lines[0]?.properties || {}).length === 0, plain.postData());
  m.mockCart.lines = [];

  /* ---- Enter in a gift's name field goes to the next field and adds nothing ---- */
  await page.goto(`${BASE}/products/catan`, { waitUntil: 'networkidle' });
  await page.click('.gift-order__toggle');
  await page.fill('#GiftFor-template--1__main', 'Aroha');
  let added = 0;
  const count = (r) => { if (r.url().includes('/cart/add') && r.method() === 'POST') added += 1; };
  page.on('request', count);
  await page.focus('#GiftFor-template--1__main');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  page.off('request', count);
  const entered = await page.evaluate(() => ({ focus: document.activeElement?.id, open: document.querySelector('[data-gift-details]').open, value: document.querySelector('#GiftFor-template--1__main').value }));
  check(`${tag} gift: Enter in Who's it for? goes to Who's it from? and adds nothing`, added === 0 && entered.focus === 'GiftFrom-template--1__main' && entered.open && entered.value === 'Aroha', { added, entered });
  m.mockCart.lines = [];

  /* ---- a shop game paired by metafield; low stock; sold out; not tracked; a custom brief; two editions ---- */
  v = await open('/products/7-wonders-duel');
  check(`${tag} 7 Wonders Duel: Try it first goes to its library copy (custom.library_copy)`, v.pair && v.pair.links[0].href === '/products/7-wonders-duel-library', v.pair);
  v = await open('/products/cascadia');
  check(`${tag} Cascadia: Only 2 left in the hoard, and no Try it first (no library copy)`, v.promise[0] === 'Only 2 left in the hoard' && v.promise[1] === 'Ships within 3 working days' && !v.pair && v.callout, { promise: v.promise, pair: v.pair, callout: v.callout });
  check(`${tag} Cascadia: Type shows the shop's labels (Family Games is Family)`, v.markers.find((x) => x.label === 'Type')?.value === 'Family, Solo' && v.markers.find((x) => x.label === 'Difficulty')?.pips === 3 && v.markers.find((x) => x.label === 'Difficulty')?.level === '1', v.markers);
  v = await open('/products/sushi-go-party');
  check(`${tag} Sushi Go Party! (sold out): no stock or delivery box, no gift, Sold out`, v.promise.length === 0 && !v.gift && v.add === 'Sold out' && v.addDisabled, { promise: v.promise, gift: v.gift, add: v.add });
  v = await open('/products/heat-pedal-to-the-metal');
  check(`${tag} Heat: the summary is custom.brief (its new line kept), About has the whole description`, v.brief.startsWith('Heat is a fast car-racing board game') && /<br>/.test(v.briefHtml) && v.about && v.about.text.includes('Heat: Pedal to the Metal is a car-racing board game'), { brief: v.briefHtml, about: v.about && v.about.text.slice(0, 120) });
  check(`${tag} Heat: not tracked, so no stock line, but it still ships within 3 working days; no 🎂 line, so its Age is the group's`, JSON.stringify(v.promise) === JSON.stringify(['Ships within 3 working days']) && v.markers.find((x) => x.label === 'Age')?.value === '10+', { promise: v.promise, markers: v.markers });
  v = await open('/products/azul');
  const azul = await page.evaluate(() => {
    const brief = document.querySelector('.product__brief');
    const about = document.querySelector('.product__about');
    return {
      paras: brief.querySelectorAll('p').length,
      stray: brief.querySelectorAll('.markers, .product__price, form, .product__about').length + document.querySelectorAll('.product__summary form, .product__summary .markers').length,
      markersOutside: Boolean(document.querySelector('.product__head > .markers')),
      table: Boolean(about?.querySelector('table')),
      wrapper: Boolean(about?.querySelector('.bgg article')),
    };
  });
  check(`${tag} Azul (paragraphs inside wrappers, as a pasted description): a one-paragraph summary, the page laid out as usual, About keeps the rest whole`, azul.paras === 1 && azul.stray === 0 && azul.markersOutside && azul.table && azul.wrapper && v.brief.startsWith('Azul is a tile-drafting game') && JSON.stringify(v.order.slice(0, 6)) === JSON.stringify(['h1', 'rte', 'markers', 'product__price', 'promise', 'product__buy']), { azul, order: v.order });
  v = await open('/products/everdell');
  check(`${tag} Everdell (Standard): Only 2 left in the hoard`, v.promise[0] === 'Only 2 left in the hoard', v.promise);
  await page.evaluate(() => {
    const picker = document.querySelector('variant-picker');
    const radio = [...picker.querySelectorAll('input[type="radio"]')].find((r) => r.value.startsWith('Collector'));
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(150);
  v = await look(page);
  check(`${tag} Everdell (Collector's, sold out): the box hides, Sold out, no gift`, v.promise.length === 0 && v.add === 'Sold out' && !v.gift, { promise: v.promise, add: v.add, gift: v.gift });
  await page.evaluate(() => {
    const radio = [...document.querySelectorAll('variant-picker input[type="radio"]')].find((r) => r.value === 'Standard');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(150);
  v = await look(page);
  check(`${tag} Everdell (back to Standard): Only 2 left and Ships within 3 working days, the gift back`, JSON.stringify(v.promise) === JSON.stringify(['Only 2 left in the hoard', 'Ships within 3 working days']) && v.gift && v.add === 'Add to cart', { promise: v.promise, gift: v.gift, add: v.add });

  /* ---- library copies ---- */
  v = await open('/products/7-wonders-duel-library');
  check(`${tag} library copy: summary, markers, the borrow card, then Want your own? at the shop's price, About`, v.order.includes('borrow-card') && v.order.indexOf('pair-card') === v.order.indexOf('borrow-card') + 1 && v.markers.length === 5 && v.pair && v.pair.title === 'Want your own?' && v.pair.text === "It's in the shop for $55.00." && v.pair.links[0].href === '/products/7-wonders-duel' && v.about, { order: v.order, pair: v.pair });
  check(`${tag} library copy: no price, buy box or gift`, !v.order.includes('product__price') && !v.order.includes('promise') && !v.gift, v.order);
  await page.screenshot({ path: path.join(OUT, `${size}-library-copy.png`), fullPage: true });
  await scan(page, `${tag} library copy buy column`, '.product__info');
  v = await open('/products/catan-library');
  check(`${tag} library copy found by the handle rule: Want your own? goes to /products/catan`, v.pair && v.pair.links[0].href === '/products/catan' && v.pair.text === "It's in the shop for $79.00.", v.pair);
  v = await open('/products/paladins-of-the-west-kingdom');
  check(`${tag} Paladins (age group Teens): Age 12+ from the stats line; Hard with 3 pips; no pair card`, v.markers.find((x) => x.label === 'Age')?.value === '12+' && v.markers.find((x) => x.label === 'Difficulty')?.level === '3' && !v.pair, v.markers);
  v = await open('/products/codenames');
  check(`${tag} Codenames (library, no shop copy): Type Party, Word and trivia; no pair card`, v.markers.find((x) => x.label === 'Type')?.value === 'Party, Word and trivia' && !v.pair, { markers: v.markers, pair: v.pair });

  /* ---- not games: the layout they had ---- */
  v = await open('/products/vallejo-game-colour');
  check(`${tag} paint (not a game): no summary, markers, stock box, gift, pair card or About; its description as before`, !v.brief && v.markers.length === 0 && v.promise.length === 0 && !v.gift && !v.pair && !v.about && v.description.includes('Vallejo Game Colour'), v);
  v = await open('/products/d-d-bigby-library');
  check(`${tag} RPG book (Role-Playing Game): the plain library layout with its stats pills`, v.markers.length === 0 && v.stats === 1 && !v.pair, { markers: v.markers, stats: v.stats });
  v = await open('/products/board-game-rental-monthly?generic=1');
  check(`${tag} the library membership (type Board Games) never gets the game layout`, v.markers.length === 0 && !v.brief && !v.gift && !v.about, v);

  check(`${tag} no script errors`, errors.length === 0, errors);
  await ctx.close();

  /* ---- the wishlist: switched on (demo, a member) ---- */
  m.globalSettings.wishlist_enabled = true;
  m.globalSettings.lair_mode = 'demo';
  m.mockState.customer = RUBY;
  const wctx = await newCtx();
  const w = await wctx.newPage();
  const werrors = [];
  w.on('pageerror', (e) => werrors.push(e.message));
  await w.goto(`${BASE}/products/catan`, { waitUntil: 'networkidle' });
  await w.waitForTimeout(300);
  const heart = () => w.evaluate(() => { const b = document.querySelector('[data-wishlist-button]'); return b ? { pressed: String(b.hasAttribute('data-on')), label: b.textContent.trim() } : null; });
  const place = await w.evaluate(() => { const el = document.querySelector('wishlist-button'); const r = el.getBoundingClientRect(); const g = document.querySelector('gift-option').getBoundingClientRect(); return { after: el.previousElementSibling?.tagName, full: Math.abs(r.width - g.width) < 2, below: r.top >= g.bottom }; });
  check(`${tag} wishlist on (demo): Add to wishlist, full width under Order as a gift`, JSON.stringify(await heart()) === JSON.stringify({ pressed: 'false', label: 'Add to wishlist' }) && place.after === 'GIFT-OPTION' && place.full && place.below, { heart: await heart(), place });
  await w.click('[data-wishlist-button]');
  await w.waitForTimeout(300);
  check(`${tag} wishlist (demo): pressed, it's on the wishlist`, JSON.stringify(await heart()) === JSON.stringify({ pressed: 'true', label: 'On your wishlist' }), await heart());
  await w.screenshot({ path: path.join(OUT, `${size}-wishlist-on.png`), fullPage: false });
  await scan(w, `${tag} Add to wishlist`, 'wishlist-button');
  await w.reload({ waitUntil: 'networkidle' });
  await w.waitForTimeout(400);
  check(`${tag} wishlist (demo): still on after a reload`, (await heart())?.pressed === 'true', await heart());
  const kept = await w.evaluate(async () => (await window.Lair.store.backend.wishlist()).items.map((i) => `${i.productId}|${i.handle}|${i.title}`));
  check(`${tag} wishlist (demo): kept as the product's id, handle and title`, kept.length === 1 && /\|catan\|Catan$/.test(kept[0]), kept);
  await w.click('[data-wishlist-button]');
  await w.waitForTimeout(300);
  check(`${tag} wishlist (demo): pressed again, it's off`, (await heart())?.pressed === 'false' && (await w.evaluate(async () => (await window.Lair.store.backend.wishlist()).items.length)) === 0, await heart());
  check(`${tag} wishlist (demo): no script errors`, werrors.length === 0, werrors);
  await wctx.close();

  /* ---- the wishlist live, against a stubbed Lair app; then logged out ---- */
  m.globalSettings.lair_mode = 'live';
  const calls = [];
  m.mockState.before = async (req, res, url) => {
    if (!url.pathname.startsWith('/apps/liar/me/wishlist')) return false;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ method: req.method, path: url.pathname, body: raw ? JSON.parse(raw) : null });
    const has = calls.filter((c) => c.method === 'POST').length % 2 === 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.method === 'GET' ? { items: [] } : { ok: true, items: has ? [{ productId: String(calls.at(-1).body.productId), handle: 'catan', title: 'Catan', addedAt: 1 }] : [] }));
    return true;
  };
  const lctx = await newCtx();
  const l = await lctx.newPage();
  await l.goto(`${BASE}/products/catan`, { waitUntil: 'networkidle' });
  await l.waitForTimeout(300);
  const lairCore = await l.evaluate(() => [...document.scripts].some((s) => /lair-core/.test(s.src)));
  await l.click('[data-wishlist-button]');
  await l.waitForTimeout(300);
  const pressed = await l.evaluate(() => String(document.querySelector('[data-wishlist-button]').hasAttribute('data-on')));
  const post = calls.find((c) => c.method === 'POST');
  check(`${tag} wishlist live: asks the Lair app (GET /me/wishlist), and the press posts the product`, calls[0]?.method === 'GET' && calls[0].path === '/apps/liar/me/wishlist' && post && post.path === '/apps/liar/me/wishlist' && post.body.handle === 'catan' && post.body.title === 'Catan' && /^\d+$/.test(String(post.body.productId)) && pressed === 'true', { calls, pressed });
  check(`${tag} wishlist live: a game page doesn't load lair-core.js for it`, !lairCore, lairCore);
  await l.click('[data-wishlist-button]');
  await l.waitForTimeout(300);
  check(`${tag} wishlist live: pressed again, it posts /me/wishlist/remove`, calls.at(-1).path === '/apps/liar/me/wishlist/remove' && String(calls.at(-1).body.productId) === String(post.body.productId), calls.at(-1));
  await lctx.close();
  m.mockState.customer = null;
  const octx = await newCtx();
  const o = await octx.newPage();
  await o.goto(`${BASE}/products/catan`, { waitUntil: 'networkidle' });
  const asked = calls.length;
  await Promise.all([o.waitForURL(/\/customer_authentication\/login/), o.click('[data-wishlist-button]')]).catch(() => {});
  check(`${tag} wishlist logged out: the press goes to the login page and back, without asking the Lair app`, /\/customer_authentication\/login\?return_to=%2Fproducts%2Fcatan$/.test(o.url()) && calls.length === asked, o.url());
  await octx.close();
  m.mockState.before = null;
  m.globalSettings.wishlist_enabled = false;
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed${fails.length ? `: ${fails.join('; ')}` : ''}. Screens in ${OUT}`);
process.exit(fail ? 1 : 0);

// Round 38 on the theme mock: the three things the separate review of the website's side found (15 Nov 2026).
// 1. The cart's two bars, the free-shipping bar and the d20 roll meter, each grow from their own last amount when the
//    cart redraws. theme.js grew only the first .xp-bar__fill it found, so with both on, the roll meter took the
//    free-shipping bar's growth and the free-shipping bar never grew.
// 2. The cart's double days are the Lair app's: the same text gives the same days as src/core.js parseDoubleDays, so
//    the cart never says "Today every dollar counts double" on a day the app won't double, or the other way round.
// 3. Free sleeves only on Commander decks (Mo, 14 Nov 2026: "Commander decks come with a free sleeves"): never on a
//    Commander's Bundle or a library copy, and on a set with boxes and decks, only its decks in the cart.
// Usage: DG_THEME=/path/to/theme [PORT=4996] node tools/qa/round38-order-rolls/theme.mjs
process.env.TZ = 'Pacific/Auckland'; // the mock's 'now' | date is then the shop's day, as on Shopify

const { chromium, m } = await import('../round15/lib.mjs');
const { parseDoubleDays } = await import('../../../src/core.js');
const { doubleDayOn } = await import('../../../src/order-rolls.js');

const PORT = Number(process.env.PORT || 4996);
const base = `http://localhost:${PORT}`;
Object.assign(m.globalSettings, { lair_order_rolls: true, lair_rolls_every: 200, lair_rolls_double_days: '', deck_sleeves_show: true, free_shipping_threshold: 300 });
const server = await m.serve(PORT);
let failed = 0;
const ok = (name, pass, detail = '') => {
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass || !detail ? '' : ` | ${detail}`}`);
};
const html = async (path) => (await fetch(base + path)).text();

/* ---- 1. the two bars ---- */
{
  const feed = await (await fetch(`${base}/collections/all/products.json?limit=250`)).json();
  const pick = feed.products.flatMap((p) => p.variants).find((v) => v.available && Number(v.price) >= 40 && Number(v.price) <= 90);
  m.mockCart.lines.length = 0;
  await fetch(`${base}/cart/add.js`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: pick.id, quantity: 1 }) });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    window.__grown = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function grow(frames, options) {
      window.__grown.push({
        bar: this.closest('.roll-meter') ? 'rolls' : this.closest('.xp-bar') ? 'shipping' : String(this.className),
        where: this.closest('cart-drawer') ? 'drawer' : 'page',
        from: (Array.isArray(frames) && frames[0] && frames[0].clipPath) || '',
      });
      return animate.call(this, frames, options);
    };
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
  await page.goto(`${base}/cart`, { waitUntil: 'networkidle' });
  const bars = () => page.evaluate(() => {
    const xp = (sel) => parseFloat(document.querySelector(`main ${sel}`)?.style.getPropertyValue('--xp'));
    return { shipping: xp('.xp-bar__track > div'), rolls: xp('.roll-meter__track > div'), qty: document.querySelector('main [data-qty-input]')?.value };
  });
  const before = await bars();
  await page.locator('main [data-qty-step="1"]').first().click();
  await page.waitForFunction(() => document.querySelector('main [data-qty-input]')?.value === '2', null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const after = await bars();
  const grown = (await page.evaluate(() => window.__grown)).filter((g) => g.where === 'page');
  const inset = (from, to) => `inset(0 ${(100 - (from / to) * 100).toFixed(2)}% 0 0 round 999px)`;
  ok('the line went from 1 to 2', before.qty === '1' && after.qty === '2', JSON.stringify({ before, after }));
  ok('both bars moved up', after.shipping > before.shipping && after.rolls > before.rolls, JSON.stringify({ before, after }));
  const ship = grown.find((g) => g.bar === 'shipping');
  ok('the free-shipping bar grows from its own last amount', ship?.from === inset(before.shipping, after.shipping), JSON.stringify(grown));
  const rolls = grown.find((g) => g.bar === 'rolls');
  ok('the roll meter grows from its own last amount', rolls?.from === inset(before.rolls, after.rolls), JSON.stringify(grown));
  ok('no page errors', errors.length === 0, errors.join(' / '));
  await browser.close();
}

/* ---- 2. the double days, against the Lair app's ---- */
{
  const key = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  const today = key(Date.now());
  const yesterday = key(Date.now() - 86400000);
  const tomorrow = key(Date.now() + 86400000);
  const fifty = Array.from({ length: 50 }, (_, i) => `2020-01-${String((i % 28) + 1).padStart(2, '0')}`).join(', ');
  const cases = [
    '', '2020-01-01 to 2099-12-31', '2020-01-01 TO 2099-12-31', '2020-01-01 To 2099-12-31', '2020-01-01..2099-12-31',
    '2020-01-01 – 2099-12-31', '2020-01-01–2099-12-31', '2020-01-01-2099-12-31', '2020-01-01 - 2099-12-31', '2020-01-01to2099-12-31',
    '2099-12-31 to 2020-01-01', 'Black Friday; 2020-01-01 to 2099-12-31', '2026-02-30 to 2099-12-31', '2026-00-01 to 2099-12-31',
    '2023-02-29 to 2099-12-31', '2024-02-29 to 2099-12-31', '2O20-01-01 to 2099-12-31', '2020-1-01 to 2099-12-31',
    '2020-01-01 to 2099-12-31 to 2099-12-31', '2020-01-01 or 2099-12-31', today, `${yesterday}\n${today}`, yesterday, tomorrow,
    `${yesterday} to ${tomorrow}`, `${tomorrow} .. ${yesterday}`, '2020-01-01 to 2020-01-31, 2099-01-01', `${fifty}, 2020-01-01 to 2099-12-31`,
    `${fifty}; ${today}`, `nonsense, ${fifty.split(', ').slice(0, 49).join(', ')}, ${today}`,
  ];
  for (const text of cases) {
    m.globalSettings.lair_rolls_double_days = text;
    const cart = await html('/cart');
    const says = /roll-meter__double/.test(cart);
    const lair = doubleDayOn(Date.now(), parseDoubleDays(text), 'Pacific/Auckland');
    const shown = text.length > 60 ? `${text.slice(0, 28)}…${text.slice(-28)}` : text;
    ok(`double days "${shown.replace(/\n/g, '\\n')}": the cart says ${says}, the Lair app ${lair}`, says === lair);
  }
  m.globalSettings.lair_rolls_double_days = '';
}

/* ---- 3. free sleeves only on Commander decks ---- */
{
  const decks = { bundle: false, heroes: true, trek: true, fracture: true, aetherdrift: true, library: false };
  const list = await html('/r38-commander');
  const cards = list.split(/class="product-card(?=[" ])/).slice(1); // each card from its root, not its parts
  for (const [name, deck] of Object.entries(decks)) {
    const p = m.r38Commander[name];
    const card = cards.find((c) => c.includes(`href="${p.url}"`));
    ok(`${p.title}: ${deck ? 'a' : 'no'} Free sleeves badge on its card`, Boolean(card) && /badge--sleeves/.test(card) === deck, card ? '' : 'no card');
    const own = await html(p.url);
    ok(`${p.title}: ${deck ? 'a' : 'no'} free sleeves line on its page`, /deal-line--sleeves/.test(own) === deck);
  }
  const cart = await html('/cart-r38-commander');
  const nudge = (cart.match(/<p class="dice-deal__lead">([^<]*)<\/p>/) || [])[1] || '';
  ok('the cart counts 4 decks (not the bundle, the booster box or the library copy)', nudge.trim() === '4 free packs of sleeves to pick', nudge);
}

/* ---- 4. the sleeves deal in the cart (Mo, 15 Nov 2026: "give suggestions as you would with dice when someone buys
   something. Inside the cart", "make sure the sleeve collection is wider and say commander decks come with free
   sleeves") ---- */
{
  // a deck with no sleeves: how many packs are free, and two to add right there (the sold-out colour isn't offered)
  const deckCart = await html('/cart-r38-deck');
  const main = deckCart.slice(deckCart.indexOf('<main'));
  ok('a deck with no sleeves: "A free pack of sleeves to pick"', /A free pack of sleeves to pick/.test(main));
  const picks = main.match(/<li class="dice-deal-pick sleeve-pick">[\s\S]*?<\/li>/g) || [];
  ok('two sleeves to add in the cart, in the collection\'s order', picks.length === 2 && picks[0].includes('Ultimate Guard Katana Sleeves') && picks[1].includes('Dragon Shield Matte Sleeves'), `${picks.length} picks`);
  const options = (picks[0]?.match(/<option[\s\S]*?<\/option>/g) || []).map((o) => o.replace(/<[^>]+>/g, '').trim());
  ok('the colours in stock to choose from, the sold-out one left out', JSON.stringify(options) === JSON.stringify(['Obsidian Shard', 'Great Wave']), JSON.stringify(options));
  ok('the colour list says what it\'s for', /Color for Ultimate Guard Katana Sleeves/.test(picks[0] || ''));
  ok('one with no colours adds its only kind', /<input type="hidden" name="id" value="\d+">/.test(picks[1] || ''));
  ok('a link to every sleeve', /href="\/collections\/card-sleeves">See all sleeves</.test(main));
  // the deal made a pack free: the cart says so, and what it saved
  const free = await html('/cart-r38-sleeves-free');
  ok('once Shopify has made them free: "Your sleeves are free" and what it saved', /Your sleeves are free/.test(free) && /You saved \$20\.00/.test(free));
  // two packs in the cart and only one made free: the cart counts what Shopify made free (from the separate review)
  const one = await html('/cart-r38-sleeves-one');
  ok('one pack of two made free: "Your sleeves are free" for that one, not two', /Your sleeves are free/.test(one) && !/2 packs of sleeves are free/.test(one) && /You saved \$20\.00/.test(one));
  // a deck and sleeves with nothing taken off: no promise
  const off = await html('/cart-r38-sleeves-off');
  ok('a deck and sleeves with nothing off: the cart says nothing about sleeves', !/deal-line--sleeves/.test(off.slice(off.indexOf('<main'))));
  // a sleeve's own page and card
  ok('a sleeve\'s page: "Free with a Commander deck"', /Free with a Commander deck/.test(await html('/products/ultimate-guard-katana-sleeves')));
  const cards = (await html('/r38-collection')).split(/class="product-card(?=[" ])/).slice(1);
  const sleeveCard = cards.find((c) => c.includes('href="/products/dragon-shield-matte-sleeves"'));
  ok('a sleeve\'s card: "Free with a deck"', Boolean(sleeveCard) && /Free with a deck/.test(sleeveCard));
  // in a browser: a deck in the live cart, a colour chosen, Add, and the pack is free right there
  m.mockCart.lines.length = 0;
  await fetch(`${base}/cart/add.js`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 3803, quantity: 1 }) });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
  await page.goto(`${base}/cart`, { waitUntil: 'networkidle' });
  const pick = page.locator('main .sleeve-pick').first();
  await pick.locator('select').selectOption({ label: 'Great Wave' });
  await pick.getByRole('button', { name: /Add/ }).click();
  await page.waitForFunction(() => /Your sleeves are free/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  const after = await page.evaluate(() => ({
    panel: document.querySelector('main .deal-line--sleeves')?.textContent.replace(/\s+/g, ' ').trim(),
    drawerOpen: Boolean(document.querySelector('cart-drawer dialog[open]')),
    width: document.documentElement.scrollWidth,
  }));
  ok('picked in the cart: the pack is free right there, and the cart says what it saved', /Your sleeves are free/.test(after.panel || '') && /You saved \$24\.99/.test(after.panel || ''), JSON.stringify(after));
  ok('the colour picked is the one in the cart', m.mockCart.lines.some((l) => Number(l.variantId) === 3823));
  ok('the cart page stays put: no drawer opens over it', !after.drawerOpen);
  ok('no sideways scroll at 390', after.width <= 390, String(after.width));
  ok('no page errors', errors.length === 0, errors.join(' / '));
  await page.screenshot({ path: '/tmp/r38-sleeves-after.png', fullPage: false });
  await browser.close();
}

server.close();
console.log(failed ? `${failed} FAILED` : 'All passed');
process.exit(failed ? 1 : 0);

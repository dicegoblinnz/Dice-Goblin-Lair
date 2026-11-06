// Round 31, Christmas gifts (6 Nov 2026, contract v31-gifts), on the theme mock. Mo picked the gifts page as mockup B
// ("who it's for") and approved the gift pages "as drawn".
//  1. The gifts page: six tiles, the first one's ideas showing (two experience tickets, then products, then Still not
//     sure?), the count; another tile swaps them and goes in the address (#for=…) without a new history entry; a link
//     with #for= opens on its tile; a spend chip hides what costs more and counts again; nothing left says so; library
//     copies and the gifts themselves never show among the products; a ticket opens its gift.
//  2. Your first roleplaying game and Learn to paint: the price, How many? and Add to cart, the email line, and the blocks
//     (What's in it, Who can use it, How they use it, Gobgob, the fine print); no shipping words.
//  3. The gift card: the amounts swap the price and picture; Send it to Them shows their email, name, message and day,
//     and Me hides them (and they aren't sent); Them with no email stops with the message, a bad one too; with one, the
//     line carries Shopify's recipient fields and the time zone offset.
//  4. My Lair's Wallet as Ruby (the demo seeds her two gifts, as drawn): Gifts with a card each (who it's from, what it
//     covers, Learn to paint's next class, "Use by …" 3 years on), where to use each, Show at the counter (the code big,
//     with a QR), none of it in My passes, and Home's "2 gifts to use"; Got a code? with a gift nobody has claimed: the
//     Lair app's words and a third card.
//  5. The staff page: a gift's code at Check-in (what it covers, ready, its use-by), Use it now with a note, the Lair
//     app's words and Used; the gift's page (Used at the counter: the note) and Undo. Ruby's TTRPG seat with her first
//     game gift: the whole seat covered and the dice reminder, Undo gift. Her Learn to paint sign-up with her paint gift.
// No sideways scroll, no console errors and axe at each. 320, 390 and 1280 wide.
// Usage: DG_THEME=/path/to/theme [PORT=4994] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round31-gifts/gifts.mjs [small|phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round31-gifts');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, watch, go, clockAt, RUBY, STAFF, today } = lib;
const { extraEvents } = await import('../theme-mock/events-mock.mjs');
// Learn to paint as the shop has it (lair_event learn-to-paint, 6 Nov 2026): the first Thursday of the month, 6 to 8pm
extraEvents.push({
  handle: 'learn-to-paint', title: 'Learn to paint', event_type: 'learn', starts_at: '2026-11-05T18:00:00+13:00', ends_at: '2026-11-05T20:00:00+13:00',
  repeat: 'monthly', capacity: 8, entry_fee: 10, payment: 'In store', game: 'Miniature painting',
  description: 'Never painted a miniature? Gobgob will put a brush in your hand.', image_slug: 'riftbound',
});
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** A gift sold today is used by the end of this day 3 years on: "6 November 2029" */
/** Money as the staff page writes it: $15, $7.50 */
const dollars = (cents) => `$${cents % 100 ? (cents / 100).toFixed(2) : cents / 100}`;
const USE_BY = (() => {
  const [y, mo, d] = today.split('-').map(Number);
  return mo === 2 && d === 29 ? `1 March ${y + 3}` : `${d} ${MONTHS[mo - 1]} ${y + 3}`;
})();
const PORT = Number(process.env.PORT || 4994);
const BASE = `http://localhost:${PORT}`;
const VIEWPORTS = { small: { width: 320, height: 640 }, phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const sizes = process.argv[2] ? [process.argv[2]] : ['small', 'phone', 'desktop'];
// the gift card as it will be set on the gifts page once it's made (its product needs gift cards switched on first)
m.mockState.sectionSettings = { 'gifts-finder': { gift_card_product: 'dice-goblin-gift-card' } };
const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 300) => page.waitForTimeout(ms);

async function context(size) {
  const phone = size !== 'desktop';
  const ctx = await browser.newContext({ viewport: VIEWPORTS[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(clockAt('13:00'));
  return ctx;
}
/** The gifts page as it is now: the picked tile, what shows of its group, the count and the empty line */
const finder = (page) => page.evaluate(() => {
  const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const shown = (el) => Boolean(el) && !el.hidden && !el.closest('[hidden]') && el.getClientRects().length > 0;
  const group = [...document.querySelectorAll('[data-group]')].find((g) => !g.hidden);
  return {
    tile: document.querySelector('[data-who]:checked')?.value || null,
    groups: [...document.querySelectorAll('[data-group]')].filter((g) => !g.hidden).map((g) => g.dataset.group),
    heading: f(group?.querySelector('.gifts__results-head h2')?.textContent),
    count: f(group?.querySelector('[data-count]')?.textContent),
    tickets: [...(group?.querySelectorAll('.gift-ticket') || [])].filter(shown).map((t) => f(t.querySelector('.gift-ticket__link')?.textContent)),
    products: [...(group?.querySelectorAll('.gifts__products > li') || [])].filter(shown).map((li) => ({ title: f(li.querySelector('.product-card__link')?.textContent), price: Number(li.dataset.idea) })),
    empty: shown(group?.querySelector('[data-empty]')),
    card: shown(group?.querySelector('.gifts__card')),
    hash: window.location.hash,
    history: window.history.length,
  };
});

async function giftsPage(size) {
  const ctx = await context(size);
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gifts', null);
  await settle(page);
  let s = await finder(page);
  check(`${size} gifts: the first tile is picked and only its ideas show`, s.tile === 'kids-8-to-14' && s.groups.join() === 'kids-8-to-14', s);
  check(`${size} gifts: kids get both experience tickets first`, s.tickets.join(' | ') === 'Your first roleplaying game | Learn to paint', s.tickets);
  check(`${size} gifts: products from Family games, in stock and for sale (never a library copy or a gift)`, s.products.length > 0 && s.products.every((p) => p.price > 0 && !/library|gift card|first roleplaying|learn to paint/i.test(p.title)), s.products);
  check(`${size} gifts: the count is every idea`, s.count === `${s.tickets.length + s.products.length} ideas`, s);
  check(`${size} gifts: Still not sure? with the gift card`, s.card, s);
  const tiles = await page.$$eval('.gifts__tile', (els) => els.map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
  check(`${size} gifts: six tiles`, tiles.join(' | ') === 'Kids 8 to 14 | Roleplayers | Card players | Painters | Board gamers | Not sure', tiles);
  await shot(page, `${size}-gifts`, null, true);
  // another tile
  const before = s.history;
  await page.click('.gifts__tile:has([value="roleplayers"])');
  await settle(page);
  s = await finder(page);
  check(`${size} gifts: Roleplayers swaps the ideas`, s.groups.join() === 'roleplayers' && s.heading === 'For roleplayers' && s.tickets.join() === 'Your first roleplaying game', s);
  check(`${size} gifts: the pick goes in the address, with no new history entry`, s.hash === '#for=roleplayers' && s.history === before, s);
  // spend
  await page.click('.chip:has([data-spend][value="25"])');
  await settle(page);
  s = await finder(page);
  check(`${size} gifts: Under $25 hides what costs more`, s.products.every((p) => p.price <= 2500) && s.tickets.length === 0, s);
  check(`${size} gifts: and counts again`, s.count === (s.tickets.length + s.products.length === 1 ? '1 idea' : `${s.tickets.length + s.products.length} ideas`), s);
  // a tile with nothing under $25 says so
  await page.click('.gifts__tile:has([value="board-gamers"])');
  await settle(page);
  s = await finder(page);
  if (!s.products.length && !s.tickets.length) check(`${size} gifts: nothing left: the line says try a bigger spend`, s.empty && s.count === '0 ideas', s);
  else check(`${size} gifts: board gamers under $25 shows only what fits`, s.products.every((p) => p.price <= 2500), s);
  await page.click('.chip:has([data-spend][value="0"])');
  await settle(page);
  s = await finder(page);
  check(`${size} gifts: Any price brings them back`, !s.empty && s.products.length > 0, s);
  check(`${size} gifts: no sideways scroll`, (await overflowX(page)) <= 0);
  await axe(page, `${size} gifts page`, 'main');
  // a link to a tile opens on it
  await go(page, BASE, '/pages/gifts#for=painters', null);
  await settle(page);
  s = await finder(page);
  check(`${size} gifts: #for=painters opens on Painters`, s.tile === 'painters' && s.groups.join() === 'painters' && s.tickets.join() === 'Learn to paint', s);
  // a ticket opens its gift
  await page.click('[data-group]:not([hidden]) .gift-ticket__link >> nth=0');
  await page.waitForLoadState('networkidle');
  check(`${size} gifts: the Learn to paint ticket opens its gift`, page.url().endsWith('/products/learn-to-paint-gift'), page.url());
  check(`${size} gifts: no errors`, !page.errors.length, page.errors);
  await ctx.close();
}

async function experience(size) {
  const ctx = await context(size);
  const page = watch(await ctx.newPage());
  for (const [handle, name, price, parts] of [
    ['your-first-roleplaying-game', 'Your first roleplaying game', '$30.00', ["What's in it", 'Who can use it', 'How they use it']],
    ['learn-to-paint-gift', 'Learn to paint gift', '$10.00', ["What's in it", 'Who can use it', 'How they use it']],
  ]) {
    await go(page, BASE, `/products/${handle}`, null);
    await settle(page);
    const v = await page.evaluate(() => {
      const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      return {
        title: f(document.querySelector('.product__title')?.textContent),
        price: f(document.querySelector('[data-product-price] .price__current')?.textContent),
        crumb: [...document.querySelectorAll('.breadcrumbs li')].map((li) => f(li.textContent)),
        qty: Boolean(document.querySelector('.gift-page__buy [data-qty-input]')),
        qtyLabel: f(document.querySelector('.gift-page__qty-label')?.textContent),
        note: f(document.querySelector('.gift-page__note')?.textContent),
        parts: [...document.querySelectorAll('.gift-page__part .h3')].map((h) => f(h.textContent)),
        gob: f(document.querySelector('.gift-page__gob .gob-says')?.textContent),
        fine: f(document.querySelector('.gift-page__fine')?.textContent),
        text: f(document.querySelector('main')?.textContent),
      };
    });
    check(`${size} ${handle}: name, price and the Gifts crumb`, v.title === name && v.price === price && v.crumb.join(' › ') === `Home › Gifts › ${name}`, v);
    check(`${size} ${handle}: How many? beside Add to cart, and the email line`, v.qty && v.qtyLabel === 'How many?' && /by email, with its code and use-by date/.test(v.note), v);
    check(`${size} ${handle}: the blocks`, v.parts.join(' | ') === parts.join(' | ') && Boolean(v.gob) && /store credit for what you paid/.test(v.fine), v);
    check(`${size} ${handle}: no shipping or stock words`, !/delivery|ships within|in stock|order as a gift/i.test(v.text), v.text.slice(0, 300));
    check(`${size} ${handle}: no sideways scroll`, (await overflowX(page)) <= 0);
    await axe(page, `${size} ${handle}`, 'main');
    await shot(page, `${size}-${handle}`, null, true);
  }
  check(`${size} experience gifts: no errors`, !page.errors.length, page.errors);
  await ctx.close();
}

async function giftCard(size) {
  const ctx = await context(size);
  const page = watch(await ctx.newPage());
  m.mockCart.lines = [];
  await go(page, BASE, '/products/dice-goblin-gift-card', null);
  await settle(page);
  const state = () => page.evaluate(() => {
    const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const fields = document.querySelector('[data-recipient-fields]');
    return {
      price: f(document.querySelector('[data-product-price] .price__current')?.textContent),
      amounts: [...document.querySelectorAll('variant-picker .chip__label')].map((c) => f(c.textContent)),
      to: document.querySelector('[data-send-to]:checked')?.value,
      fields: Boolean(fields) && !fields.hidden,
      disabled: [...document.querySelectorAll('[data-recipient-field]')].every((el) => el.disabled),
      meHint: !document.querySelector('[data-recipient-me]')?.hidden,
      error: !document.querySelector('[data-recipient-error]')?.hidden,
      invalid: document.querySelector('[data-recipient-email]')?.getAttribute('aria-invalid'),
      qty: Boolean(document.querySelector('.gift-page__buy [data-qty-input]')),
      after: f(document.querySelector('.gift-page__after')?.textContent),
      min: document.querySelector('[data-recipient-date]')?.min,
      offset: document.querySelector('[data-recipient-offset]')?.value,
    };
  });
  let s = await state();
  // (Mo, 6 Nov 2026: tens from $10 as well as $25, $50, $100 and $200; the page opens on $50, as drawn)
  const checked = () => page.evaluate(() => document.querySelector('variant-picker .chip__input:checked')?.value || '');
  check(`${size} gift card: twelve amounts in order, opening on $50 as drawn`, s.amounts.join(' ') === '$10 $20 $25 $30 $40 $50 $60 $70 $80 $90 $100 $200'
    && s.price === '$50.00', s);
  const opening = { chip: await checked(), id: await page.evaluate(() => document.querySelector('[data-variant-id]')?.value) };
  check(`${size} gift card: the $50 chip is the one picked, and it's what goes in the cart`, opening.chip === '$50' && opening.id === String(51300000000006), opening);
  check(`${size} gift card: Them is picked, and their fields show`, s.to === 'them' && s.fields && !s.disabled, s);
  check(`${size} gift card: one at a time (no How many?), and the 3-years line`, !s.qty && /Lasts 3 years from the day you buy it/.test(s.after), s);
  check(`${size} gift card: Send it on starts today, and the time zone offset is filled in`, /^\d{4}-\d{2}-\d{2}$/.test(s.min || '') && s.offset !== '' && s.offset != null, s);
  await page.click('variant-picker .chip:has(input[value="$30"])');
  await settle(page);
  s = await state();
  check(`${size} gift card: $30 swaps the price`, s.price === '$30.00', s);
  check(`${size} gift card: the twelve amounts fit without sideways scroll`, (await overflowX(page)) <= 0);
  // Me
  await page.click('.chip:has([data-send-to][value="me"])');
  await settle(page);
  s = await state();
  check(`${size} gift card: Me hides their fields and switches them off`, s.to === 'me' && !s.fields && s.disabled && s.meHint, s);
  await page.click('.chip:has([data-send-to][value="them"])');
  await settle(page);
  // no email: stops with the message
  await page.click('.gift-page__buy [data-add-button]');
  await settle(page);
  s = await state();
  check(`${size} gift card: no email stops with the message`, s.error && s.invalid === 'true' && m.mockCart.lines.length === 0, { s, lines: m.mockCart.lines });
  await page.fill('[data-recipient-email]', 'not an email');
  await page.click('.gift-page__buy [data-add-button]');
  await settle(page);
  check(`${size} gift card: a bad email stops too`, (await state()).error && m.mockCart.lines.length === 0);
  await page.fill('[data-recipient-email]', ' kai@example.com ');
  await page.fill('#' + (await page.$eval('[data-recipient-fields] input[type="text"]', (el) => el.id)), 'Kai');
  await page.fill('[data-recipient-fields] textarea', 'Merry Christmas! Go buy the shiny dice.');
  await page.click('.gift-page__buy [data-add-button]');
  await page.waitForTimeout(800);
  const line = m.mockCart.lines[0] || null;
  check(`${size} gift card: added with Shopify's recipient fields`, Boolean(line) && line.properties['Recipient email'] === 'kai@example.com' && line.properties['Recipient name'] === 'Kai'
    && line.properties.Message === 'Merry Christmas! Go buy the shiny dice.' && line.properties.__shopify_send_gift_card_to_recipient === 'on' && line.properties.__shopify_offset !== undefined, line);
  // Me: nothing about a recipient goes with the line
  m.mockCart.lines = [];
  await go(page, BASE, '/products/dice-goblin-gift-card', null);
  await settle(page);
  await page.click('.chip:has([data-send-to][value="me"])');
  await page.click('.gift-page__buy [data-add-button]');
  await page.waitForTimeout(800);
  const mine = m.mockCart.lines[0] || null;
  check(`${size} gift card: Me adds it with no recipient`, Boolean(mine) && !Object.keys(mine.properties || {}).length, mine);
  check(`${size} gift card: no sideways scroll`, (await overflowX(page)) <= 0);
  await go(page, BASE, '/products/dice-goblin-gift-card', null);
  await settle(page);
  await axe(page, `${size} gift card`, 'main');
  await shot(page, `${size}-gift-card`, null, true);
  check(`${size} gift card: no errors`, !page.errors.length, page.errors);
  await ctx.close();
}

/* ---------- 4. My Lair's Wallet ---------- */
const xpCards = (page) => page.evaluate(() => {
  const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const box = document.querySelector('[data-xp-box]');
  return {
    shown: Boolean(box) && !box.hidden,
    title: f(box?.querySelector('.ml-side-title')?.textContent),
    cards: [...document.querySelectorAll('.ml-xp__items > .ml-xp-card')].filter((c) => !c.closest('details')).map((c) => ({
      name: f(c.querySelector('.ml-xp-card__name')?.textContent),
      from: f(c.querySelector('.ml-xp-card__from')?.textContent),
      badge: f(c.querySelector('.badge')?.textContent),
      covers: f(c.querySelector('.ml-xp-card__covers')?.textContent),
      by: f(c.querySelector('.ml-xp-card__by')?.textContent),
      links: [...c.querySelectorAll('.ml-xp-card__go a')].map((a) => ({ text: f(a.textContent), href: a.getAttribute('href') })),
      show: f(c.querySelector('[data-qr-show]')?.textContent),
      code: c.querySelector('[data-qr-show]')?.dataset.qrShow || '',
    })),
    passes: [...document.querySelectorAll('[data-passes] .ml-pass__label')].map((x) => f(x.textContent)),
    sum: f(document.querySelector('[data-sum="wallet"]')?.textContent),
  };
});

async function wallet(size, ctx) {
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/my-lair#wallet', RUBY);
  await page.waitForSelector('[data-stamp-count] strong', { state: 'attached', timeout: 20000 });
  await settle(page, 600);
  let w = await xpCards(page);
  check(`${size} wallet: Gifts shows, titled as drawn`, w.shown && w.title === 'Gifts', w);
  const [game, paint] = w.cards;
  check(`${size} wallet: Your first roleplaying game, a gift from Sam`, game && game.name === 'Your first roleplaying game' && game.from === 'A gift from Sam' && game.badge === 'Gift', game);
  check(`${size} wallet: what it covers and its use-by, as drawn`, game && game.covers === 'Covers a seat at any beginner game, GM’s fee and all, and a set of dice up to $30.' && game.by === `Use by ${USE_BY}`, game);
  check(`${size} wallet: Find a beginner game goes to the TTRPG page`, game && game.links.length === 1 && game.links[0].text === 'Find a beginner game' && /\/pages\/gm-games$/.test(game.links[0].href), game && game.links);
  check(`${size} wallet: Learn to paint, a gift from Aroha, with its next class`, paint && paint.name === 'Learn to paint' && paint.from === 'A gift from Aroha'
    && /^Covers a seat at Learn to paint, with the Lair’s miniature, brushes and paints\. Next class: Thursday \d{1,2} \w+, 6pm\.$/.test(paint.covers) && paint.by === `Use by ${USE_BY}`, paint);
  check(`${size} wallet: Save my seat goes to that class on the events page`, paint && paint.links[0] && paint.links[0].text === 'Save my seat' && /\/pages\/events-calendar#event=learn-to-paint%40\d{4}-\d{2}-\d{2}$/.test(paint.links[0].href), paint && paint.links);
  check(`${size} wallet: each has Show at the counter`, w.cards.length === 2 && w.cards.every((c) => c.show === 'Show at the counter' && /^DG-[A-Z]+-[A-HJKMNP-Z2-9]{4}$/.test(c.code)), w.cards);
  check(`${size} wallet: gifts aren't in My passes (its session passes still are)`, w.passes.length > 0 && !w.passes.some((x) => /^Gift: (Your first roleplaying game|Learn to paint)$/.test(x)), w.passes);
  await shot(page, `${size}-4-wallet-gifts`, '#ml-xp');
  await axe(page, `${size} wallet: Gifts`, '#ml-xp');
  check(`${size} wallet: no sideways scroll`, (await overflowX(page)) <= 0);
  // Show at the counter: the code big, with its QR, the gift's name and what to do
  await page.click('.ml-xp-card:first-child [data-qr-show]');
  await settle(page, 300);
  const qr = await page.evaluate(() => {
    const d = document.querySelector('[data-qr-dialog]');
    const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    return { open: d?.open, title: f(d?.querySelector('[data-qr-title]')?.textContent), code: f(d?.querySelector('[data-qr-code]')?.textContent),
      what: f(d?.querySelector('[data-qr-what]')?.textContent), how: f(d?.querySelector('[data-qr-how]')?.textContent), svg: Boolean(d?.querySelector('[data-qr-plate] svg')) };
  });
  check(`${size} wallet: Show at the counter opens the code big, with its QR`, qr.open && qr.title === 'Your gift' && qr.code === game.code && qr.what === 'Your first roleplaying game'
    && qr.how === 'Show this at the counter when you come in. Staff cover your seat, and you pick your dice.' && qr.svg, qr);
  await shot(page, `${size}-4-wallet-qr`, '[data-qr-dialog]');
  await page.keyboard.press('Escape');
  await settle(page, 200);
  // Home: the Wallet's summary counts them
  await go(page, BASE, '/pages/my-lair', RUBY);
  await page.waitForSelector('[data-stamp-count] strong', { state: 'attached', timeout: 20000 });
  await settle(page, 600);
  w = await xpCards(page);
  check(`${size} home: the Wallet's summary says 2 gifts to use`, w.sum.includes('2 gifts to use') && !/sessions? on passes.*gift/i.test(''), w.sum);
  // Got a code? with the gift nobody has claimed (Hana's, for whoever she gives it to)
  const hana = await page.evaluate(() => window.Lair.store.backend.passList().find((p) => p.giftFrom === 'Hana' && !p.customerId)?.code || '');
  await go(page, BASE, '/pages/my-lair#ml-code', RUBY);
  await page.waitForSelector('[data-stamp-count] strong', { state: 'attached', timeout: 20000 });
  await settle(page, 600);
  await page.fill('#ml-claim-code', hana.toLowerCase());
  await page.click('[data-claim] [type="submit"]');
  await settle(page, 500);
  const said = await page.evaluate(() => String(document.querySelector('[data-claim-message]')?.textContent || '').trim());
  w = await xpCards(page);
  check(`${size} Got a code?: a gift's code adds it, in the Lair app's words`, said === `Added to your wallet: Learn to paint. Use it by ${USE_BY}.` && w.cards.length === 3 && w.cards.some((c) => c.from === 'A gift from Hana'), { said, cards: w.cards.map((c) => c.from) });
  check(`${size} wallet: no errors`, !page.errors.length, page.errors);
  await page.close();
}

/* ---------- 5. the staff page ---------- */
const card = (page) => page.evaluate(() => {
  const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const c = document.querySelector('.checkin-card');
  return c ? {
    status: f(c.querySelector('.checkin-card__status')?.textContent), name: f(c.querySelector('.checkin-card__name')?.textContent),
    what: f(c.querySelector('.checkin-card__what')?.textContent), pay: f(c.querySelector('.checkin-card__pay')?.textContent),
    notices: [...c.querySelectorAll('.checkin-card__notice')].map((n) => f(n.textContent)),
    small: [...c.querySelectorAll(':scope > p.small')].map((n) => f(n.textContent)),
    buttons: [...c.querySelectorAll('.checkin-card__actions > .button, .checkin-card__actions summary, .checkin-pass__actions .button')].map((b) => f(b.textContent)),
    pass: f(c.querySelector('.checkin-pass')?.textContent),
    bill: f(c.querySelector('.staff-bill__line')?.textContent),
  } : null;
});
async function checkinCode(page, code) {
  await page.fill('[data-checkin-form] [name="code"]', code);
  await page.press('[data-checkin-form] [name="code"]', 'Enter');
  await page.waitForFunction(() => !document.querySelector('.checkin-card--pending'), null, { timeout: 10000 });
  await settle(page, 300);
}

async function staff(size, ctx) {
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/lair-staff#today', STAFF);
  await page.waitForSelector('[data-checkin-form] [name="code"]', { timeout: 20000 });
  await settle(page, 500);
  const gifts = await page.evaluate(() => window.Lair.store.backend.passList().filter((p) => p.kind).map((p) => ({ id: p.id, code: p.code, kind: p.kind, from: p.giftFrom })));
  const game = gifts.find((g) => g.kind === 'first-game');
  const paints = gifts.filter((g) => g.kind === 'paint');
  // a gift's code at Check-in
  await checkinCode(page, game.code);
  let c = await card(page);
  check(`${size} staff: a gift's code shows the gift: ready, its use-by, what it covers`, c && c.status === 'Gift' && c.name === 'Your first roleplaying game' && c.what.includes('Gift from Sam #1720')
    && c.pay === 'Ready to use' && c.small.length === 1 && c.small[0].startsWith("Covers one person's whole seat at a TTRPG session, GM's fee and all, and a set of dice up to $30 to keep. Use by ")
    && c.small[0].endsWith(`${USE_BY}.`), c);
  check(`${size} staff: Use it now, Open the gift and Done`, c && c.buttons.join(' | ') === 'Use it now | Open the gift | Done', c && c.buttons);
  await shot(page, `${size}-5-staff-gift`, '.checkin-card');
  await axe(page, `${size} staff: the gift's card`, '.checkin-card');
  await page.click('.checkin-gift > summary');
  await page.fill('#checkin-gift-note', "Kids' table");
  await shot(page, `${size}-5-staff-use-now`, '.checkin-card');
  await page.click('[data-gift-now] [type="submit"]');
  await settle(page, 500);
  c = await card(page);
  check(`${size} staff: Use it now says what to do, in the Lair app's words, and the gift is Used`,
    c && c.notices[0] === "Used: Your first roleplaying game. Don't charge for their seat today, and let them pick a set of dice up to $30." && c.pay === 'Used' && !c.buttons.includes('Use it now'), c);
  // (review) Use it now still waiting when the next code is scanned: the new card stays, and the gift's words come as a
  // note instead of covering it. Hana's Learn to paint gift (Ruby claimed it in the Wallet) is the one used here.
  const hana = gifts.find((g) => g.kind === 'paint' && g.from === 'Hana');
  await checkinCode(page, hana.code);
  await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const real = be.useGift.bind(be);
    be.useGift = async (...args) => { await new Promise((r) => setTimeout(r, 1500)); be.useGift = real; return real(...args); };
  });
  await page.click('.checkin-gift > summary');
  await page.click('[data-gift-now] [type="submit"]');
  await settle(page, 200);
  await checkinCode(page, game.code);
  await settle(page, 2000);
  c = await card(page);
  const toast = await page.evaluate(() => String(document.querySelector('.toast')?.textContent || '').trim());
  check(`${size} staff: a code scanned while Use it now waits keeps its own card, and the gift's words come as a note`,
    c && c.name === 'Your first roleplaying game' && !c.notices.some((n) => /^Used: Learn to paint/.test(n)) && toast.startsWith('Used: Learn to paint.'), { c, toast });
  await checkinCode(page, hana.code);
  c = await card(page);
  check(`${size} staff: Hana's gift was used all the same`, c && c.name === 'Learn to paint' && c.pay === 'Used', c);
  await checkinCode(page, game.code);
  // the gift's page: its use, with the note, and Undo
  await page.click('.checkin-card [data-pass-open]');
  await page.waitForSelector('.staff-pass__uses', { timeout: 10000 });
  await settle(page, 300);
  const view = await page.evaluate(() => {
    const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    return { eyebrow: f(document.querySelector('.staff-pass__eyebrow')?.textContent), label: f(document.querySelector('.staff-pass__label')?.textContent),
      left: f(document.querySelector('.staff-pass__left')?.textContent), covers: f(document.querySelector('.staff-pass__covers')?.textContent),
      heading: f(document.querySelector('#pass-uses-h')?.textContent), uses: [...document.querySelectorAll('.staff-pass__use-text')].map((u) => f(u.textContent)),
      sessions: Boolean(document.querySelector('[data-pass-edit] [name="sessions"]')) };
  });
  check(`${size} staff: the gift's page says gift, Used, what it covers, and its use at the counter with the note`, view.eyebrow === 'Dice Goblin gift' && view.label === 'Your first roleplaying game'
    && view.left === 'Used' && view.covers.startsWith("Covers one person's whole seat") && view.heading === 'Used' && view.uses.length === 1 && view.uses[0].endsWith("used at the counter: Kids' table") && !view.sessions, view);
  await shot(page, `${size}-5-staff-gift-page`, '.staff-pass--view');
  await page.click('[data-pass-use-undo]');
  await settle(page, 500);
  const after = await page.evaluate(() => ({ toast: String(document.querySelector('.staff-toast, [data-toast]')?.textContent || '').trim(), left: String(document.querySelector('.staff-pass__left')?.textContent || '').trim() }));
  check(`${size} staff: Undo puts the gift back`, after.left === 'Ready to use', after);
  // Ruby's TTRPG seat today, with her first game gift at check-in
  const seat = await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const t = window.Lair.store.time;
    const game = be.state.games.find((g) => g.start > Date.now() && t.key(g.start) === t.today()) || be.state.games.find((g) => t.key(g.start) === t.today());
    if (!game) return null;
    const b = { id: `bk_qa31_${Date.now()}`, ref: 'RT-GRIFFIN-31', kind: 'gm-seat', gameId: game.id, tables: game.tables || [], start: game.start, end: game.end, people: 1,
      name: 'Ruby Tane', email: 'ruby@example.com', customerId: '7700112233', status: 'confirmed', pay: 'day', paid: false, extras: [] };
    be.state.bookings.push(b);
    be.commit();
    return { ref: b.ref, amount: be.amountOf(b) };
  });
  if (!seat) {
    check(`${size} staff: a TTRPG game today to seat Ruby at`, false, 'no game today in the demo');
  } else {
    await page.click('[data-tab="today"]').catch(() => {});
    await checkinCode(page, seat.ref);
    await page.click('.checkin-pass [data-pass-other]');
    await page.fill('#checkin-pass-code', game.code);
    await page.click('.checkin-pass__form [type="submit"]');
    await page.waitForFunction(() => !document.querySelector('.checkin-card--pending'), null, { timeout: 10000 });
    await settle(page, 400);
    c = await card(page);
    check(`${size} staff: her first game gift covers the whole seat, and staff are told about the dice`, c && c.notices.includes("It's their first roleplaying game gift: they pick a set of dice to keep too, up to $30.")
      && c.pass.includes('Gift: Your first roleplaying game') && c.pass.includes(`Covered ${dollars(seat.amount)}.`) && !/session/.test(c.pass) && c.buttons.includes('Undo gift')
      && c.pay === 'Nothing to pay: the gift covers it' && c.bill === `Seat ${dollars(seat.amount)} · Gift covered ${dollars(seat.amount)}`, c);
    await shot(page, `${size}-5-staff-seat`, '.checkin-card');
    await axe(page, `${size} staff: the seat covered by a gift`, '.checkin-card');
    await page.click('.checkin-pass [data-pass-undo]');
    await settle(page, 500);
    c = await card(page);
    check(`${size} staff: Undo gift: taken off, and the code can be used again`, c && c.notices.some((n) => n === `Gift taken off. ${game.code} can be used again.`), c);
    // (review) her member card lists the seat with the gift still saved on it: gift words, no sessions
    const rubyCode = await page.evaluate(() => window.Lair.store.backend.staffMembers().find((x) => x.email === 'ruby@example.com')?.code || '');
    await checkinCode(page, rubyCode);
    const item = await page.evaluate(() => {
      const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const li = [...document.querySelectorAll('.checkin-card--member .checkin-item')].find((x) => /RT-GRIFFIN-31/.test(x.textContent));
      return li ? f([...li.querySelectorAll('p.small')].map((p) => p.textContent).join(' | ')) : '(no row)';
    });
    check(`${size} staff: a member's row with a gift saved on it says gift, not sessions`, item.includes('Gift: Your first roleplaying game') && !/session/.test(item) && !/Pass:/.test(item), item);
  }
  // her Learn to paint sign-up, checked in early, with her paint gift
  const join = await page.evaluate(async () => {
    const be = window.Lair.store.backend;
    const o = be.occurrences().filter((x) => /paint/i.test(x.id) && x.startMs > Date.now()).sort((a, b) => a.startMs - b.startMs)[0];
    if (!o) return null;
    const { join } = await be.joinEvent(o.id, { name: 'Ruby Tane', email: 'ruby@example.com', phone: '021 123 4567', people: 2 });
    return { ref: join.ref, amount: join.amount };
  });
  if (!join) {
    check(`${size} staff: a Learn to paint date to sign Ruby up for`, false, 'no Learn to paint in the demo');
  } else {
    await checkinCode(page, join.ref);
    const anyway = await page.$('[data-checkin-force], [data-checkin-anyway]');
    if (anyway) {
      await anyway.click();
      await page.waitForFunction(() => !document.querySelector('.checkin-card--pending'), null, { timeout: 10000 });
      await settle(page, 400);
    }
    c = await card(page);
    check(`${size} staff: a Learn to paint sign-up asks for a gift (never a session pass)`, c && c.pass.includes('No gift used. Got a Learn to paint gift? Scan or type its code.') && c.buttons.includes('Use a gift'), c);
    await page.click('.checkin-pass [data-pass-other]');
    await page.fill('#checkin-pass-code', paints[0].code);
    await page.click('.checkin-pass__form [type="submit"]');
    await page.waitForFunction(() => !document.querySelector('.checkin-card--pending'), null, { timeout: 10000 });
    await settle(page, 400);
    c = await card(page);
    check(`${size} staff: the paint gift covers one of the two, and their friend still pays`, c && c.pass.includes('Gift: Learn to paint') && c.pass.includes(`Covered ${dollars(join.amount / 2)}.`)
      && c.pay === `To pay: ${dollars(join.amount / 2)}` && c.bill === `Entry ${dollars(join.amount)} · Gift covered ${dollars(join.amount / 2)}` && c.buttons.includes('Undo gift'), c);
    await shot(page, `${size}-5-staff-paint`, '.checkin-card');
  }
  check(`${size} staff: no sideways scroll`, (await overflowX(page)) <= 0);
  check(`${size} staff: no errors`, !page.errors.length, page.errors);
  await page.close();
}

try {
  for (const size of sizes) {
    await giftsPage(size);
    await experience(size);
    await giftCard(size);
    // My Lair first, so the demo's gifts are Ruby's; the staff page in the same browser sees them
    const ctx = await context(size);
    await wallet(size, ctx);
    await staff(size, ctx);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed. Screenshots in ${process.env.OUT}`);
process.exit(fail ? 1 : 0);

// Black Friday on the theme mock (15 Nov 2026). Mo: "Yes please do all that. And ... make it clear on the homepage like
// maybe a banner across the gobgob logo on the homepage the one you first see inside the yellow box. Put a black black
// Friday banner or tag or what ever it is called on him to show it and even have a quick check out our black Friday
// deals etc." Theme settings › Black Friday turns on, just after midnight on 27 November 2026 (a scheduled task):
// 1. a black banner across Gobgob in the gold lid, and "Check out our Black Friday deals" in the lid, going to
// 2. the home page's Black Friday deals, under On tonight (#black-friday);
// 3. the dice deal as Shopify gives it that weekend, "Black Friday: buy any dice, get one free": cards, the line under a
//    dice's price and the cart count dice in twos, and the cart says free only once that discount took money off.
// Off, everything is as it was: no banner, no link, no section, and the usual buy 2, get the 3rd free. Before it starts,
// Black Friday is coming (Mo: "put a banner up saying black Friday deals coming Friday"): the banner with its date, the
// link and the deals saying when they start, and the dice as usual.
// Usage: DG_THEME=/path/to/theme [PORT=4997] node tools/qa/black-friday/theme.mjs
process.env.TZ = 'Pacific/Auckland';

const { chromium, m } = await import('../round15/lib.mjs');

const PORT = Number(process.env.PORT || 4997);
const base = `http://localhost:${PORT}`;
const server = await m.serve(PORT);
let failed = 0;
const ok = (name, pass, detail = '') => {
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass || !detail ? '' : ` | ${detail}`}`);
};
const html = async (path) => (await fetch(base + path)).text();
const text = (h) => h.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#39;|&rsquo;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const main = (h) => (h.split('<main')[1] || h).split('</main>')[0];
const count = (h, re) => (h.match(re) || []).length;

/* ---- 1 and 2. The home page ---- */
{
  const on = await html('/bf-home');
  const off = await html('/bf-home-off');
  const sash = on.match(/<span class="home-lid__sash" aria-hidden="true"><span class="bf-ribbon"><span>([^<]*)<\/span><\/span><\/span>/);
  ok('on: a banner across Gobgob says Black Friday, beside him in the lid, hidden from screen readers (the link says it in words)', sash && sash[1] === 'Black Friday' && on.indexOf('home-lid__gobgob') < on.indexOf('home-lid__sash') && on.indexOf('home-lid__sash') < on.indexOf('home-lid__box'));
  const link = on.match(/<p class="home-lid__deals">\s*<a class="bf-ribbon bf-ribbon--link" href="([^"]*)">\s*<span>([^<]*)<\/span>/);
  ok('on: "Check out our Black Friday deals" in the gold lid goes to #black-friday', link && link[1] === '#black-friday' && link[2] === 'Check out our Black Friday deals'
    && on.indexOf('home-lid__deals') > on.indexOf('home-lid__box') && on.indexOf('home-lid__deals') < on.indexOf('home-lid__actions'));
  const section = on.match(/<section\s+class="home-bf"\s+id="black-friday"\s+aria-labelledby="(home-bf-[^"]+)"/);
  ok('on: the deals are a section #black-friday, labelled by its heading, under On tonight', section && on.includes(`<h2 class="home-bf__title" id="${section?.[1]}">Black Friday deals</h2>`)
    && on.indexOf('home-ticket') > -1 && on.indexOf('home-ticket') < on.indexOf('id="black-friday"'));
  const words = text(main(on));
  ok('on: when and Gobgob\'s line', words.includes('Friday 27 to Monday 30 November') && words.includes("Gobgob's emptying the dice hoard for four days, friend."));
  const deals = [...on.matchAll(/<li class="piece piece--(\w+) home-bf__deal"[\s\S]*?<\/li>/g)].map((d) => ({
    colour: d[1], name: (d[0].match(/<h3 class="home-bf__name">([^<]*)<\/h3>/) || [])[1], tag: (d[0].match(/<p class="home-bf__tag">([^<]*)<\/p>/) || [])[1] || '',
    href: (d[0].match(/home-bf__link" href="([^"]*)"/) || [])[1], label: (d[0].match(/home-bf__link" href="[^"]*">\s*([^<]*?)\s*<\/a>/) || [])[1],
    info: text((d[0].match(/<p class="home-bf__info">([\s\S]*?)<\/p>/) || [])[1] || ''),
  }));
  ok('on: three deals, each with its link (the dice, the d20 rolls, and free sleeves marked Every day)', JSON.stringify(deals.map((d) => [d.colour, d.name, d.tag, d.href, d.label])) === JSON.stringify([
    ['potion', 'Buy any dice, get one free', '', '/collections/dice', 'Shop dice'],
    ['mana', 'Double d20 rolls', '', '/collections/all', 'Shop online'],
    ['ruby', 'Free sleeves with Commander decks', 'Every day', '/collections/trading-card-games', 'Shop card games'],
  ]), JSON.stringify(deals));
  // the deal's words are what Shopify and the Lair app do: the cheaper of two dice free; a roll for every $100 online
  // (every dollar counts double on 27 to 30 November, src/order-rolls.js); a pack of sleeves free with each deck
  ok('on: the deals say what Shopify and the Lair app give', deals[0]?.info.includes('the cheaper of each two is free') && deals[1]?.info.includes('a d20 roll for every $100, not $200') && deals[2]?.info.includes("one's free with each deck"));
  // Shopify still prints the section's empty wrapper (div.shopify-section.section-home-bf), which takes no room
  ok('off: no banner, no link in the lid, no deals section, nothing for the editor either', !/home-lid__sash|home-lid__deals|class="home-bf|id="black-friday"|bf-ribbon/.test(off));

  // Black Friday is coming (Mo, 15 Nov 2026: "put a banner up saying black Friday deals coming Friday")
  const soon = await html('/bf-home-soon');
  const soonSash = soon.match(/<span class="home-lid__sash" aria-hidden="true"><span class="bf-ribbon bf-ribbon--two"><span>([^<]*)<\/span><small>([^<]*)<\/small><\/span><\/span>/);
  ok('coming: the banner across Gobgob says Black Friday, Coming Fri 27 Nov under it', soonSash && soonSash[1] === 'Black Friday' && soonSash[2] === 'Coming Fri 27 Nov', soonSash ? soonSash.slice(1).join(' / ') : 'none');
  const soonLink = soon.match(/<p class="home-lid__deals">\s*<a class="bf-ribbon bf-ribbon--link" href="([^"]*)">\s*<span>([^<]*)<\/span>/);
  ok('coming: the link in the lid says "Black Friday deals coming Friday" and goes to the deals', soonLink && soonLink[1] === '#black-friday' && soonLink[2] === 'Black Friday deals coming Friday');
  ok('coming: the deals show, saying when they start', /id="black-friday"/.test(soon) && text(main(soon)).includes('Coming Friday 27 November, until Monday 30th') && !text(main(soon)).includes('Friday 27 to Monday 30 November') && count(soon, /class="piece piece--\w+ home-bf__deal"/g) === 3);
  const soonCards = [...main(await html('/bf-dice-collection-soon')).matchAll(/<span class="badge badge--sale">([^<]*)<\/span>/g)].map((x) => x[1]);
  ok('coming: the dice keep the usual deal, "3rd free", until it starts', soonCards.length === 3 && soonCards.every((b) => b === '3rd free'), String(soonCards));
  const both = await html('/bf-home-both');
  ok('both ticked: Black Friday is on wins (one line on the banner, the deals link, the dates)', /<span class="bf-ribbon"><span>Black Friday<\/span><\/span>/.test(both) && !/bf-ribbon--two/.test(both) && both.includes('<span>Check out our Black Friday deals</span>') && text(main(both)).includes('Friday 27 to Monday 30 November'));
}

/* ---- the home page in a browser: the banner never widens the page, and the link lands on the deals ---- */
{
  const browser = await chromium.launch();
  for (const [width, path] of [[360, '/bf-home'], [390, '/bf-home'], [1440, '/bf-home'], [360, '/bf-home-soon'], [390, '/bf-home-soon'], [1440, '/bf-home-soon']]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900); // the dice's tumble
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    ok(`${path} ${width}px: the page is still ${width}px wide with the banner on Gobgob`, wide === width, `${wide}px`);
    const box = await page.evaluate(() => {
      const gob = document.querySelector('.home-lid__gobgob').getBoundingClientRect();
      const r = document.querySelector('.home-lid__sash .bf-ribbon').getBoundingClientRect();
      return { gob: [gob.left, gob.top, gob.right, gob.bottom], r: [r.left, r.top, r.right, r.bottom] };
    });
    const [gl, gt, gr, gb] = box.gob;
    const [rl, rt, rr, rb] = box.r;
    const midY = (rt + rb) / 2;
    ok(`${path} ${width}px: the banner is across Gobgob, below his face (its middle 45-75% of the way down him), at most a fifth wider than him`, rl < gr && rr > gl && midY > gt + (gb - gt) * 0.45 && midY < gt + (gb - gt) * 0.75 && rr - rl <= (gr - gl) * 1.2, JSON.stringify(box));
    if (width === 390) {
      await page.click('.home-lid__deals a');
      await page.waitForTimeout(600);
      const landed = await page.evaluate(() => {
        const h = document.querySelector('#black-friday h2').getBoundingClientRect();
        const header = document.querySelector('header, .header, [data-header]')?.getBoundingClientRect();
        return { top: h.top, header: header ? header.bottom : 0, hash: location.hash };
      });
      ok(`${path} 390px: the link jumps to the deals, their heading just under the sticky header`, landed.hash === '#black-friday' && landed.top >= landed.header - 1 && landed.top < landed.header + 80, JSON.stringify(landed));
    }
    ok(`${path} ${width}px: no script errors`, errors.length === 0, errors.join(' | '));
    await page.close();
  }
  await browser.close();
}

/* ---- 3. The dice deal ---- */
{
  const card = (h) => [...main(h).matchAll(/<span class="badge badge--sale">([^<]*)<\/span>/g)].map((x) => x[1]);
  const on = await html('/bf-dice-collection');
  const off = await html('/bf-dice-collection-off');
  ok('dice cards say "2nd free" on Black Friday, "3rd free" otherwise', card(on).length === 3 && card(on).every((b) => b === '2nd free') && card(off).length === 3 && card(off).every((b) => b === '3rd free'), `${card(on)} / ${card(off)}`);
  const page = await html('/products/bf-galaxy-dice');
  const pageOff = await html('/bf-product-off');
  const panel = (h) => (main(h).match(/<div class="dice-deal">[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
  ok("a dice's page says buy any dice, get one free, with two dice drawn", /Buy any dice, get <span class="dice-deal__free">one free<\/span>/.test(panel(page)) && text(panel(page)).includes('For Black Friday. Mix sets, potions and D20s: the cheaper of each two is free.') && count(panel(page), /<svg/g) === 2, text(panel(page)));
  ok("off, a dice's page says buy any 2, get the 3rd free, with three dice", /Buy any 2 dice, get the <span class="dice-deal__free">3rd free<\/span>/.test(panel(pageOff)) && count(panel(pageOff), /<svg/g) === 3);

  const cart = async (path) => {
    const h = main(await html(path));
    const deal = (h.match(/<div\s+class="dice-deal dice-deal--cart[\s\S]*?<\/div>\s*(?=<div class="dice-deal-picks"|<\/|$)/) || [''])[0];
    const picks = (h.match(/<div class="dice-deal-picks">[\s\S]*?<\/ul>/) || [''])[0];
    return { has: /dice-deal--cart/.test(h), unlocked: /dice-deal--unlocked/.test(h), words: text(h.match(/<div\s+class="dice-deal dice-deal--cart[\s\S]*?(?=<div class="dice-deal-picks"|<\/form>|<div class="cart)/)?.[0] || ''), pips: count(deal, /class="dice-deal__pip[ "]/g), on: count(deal, /dice-deal__pip--on/g), picks: [...picks.matchAll(/dice-deal-pick__title" href="[^"]*">([^<]*)</g)].map((x) => x[1]), picksTitle: text((picks.match(/dice-deal-picks__title">([^<]*)</) || [])[1] || '') };
  };
  const one = await cart('/cart-bf-one');
  ok('one dice: add another and the cheaper of the two is free, 1 of 2, with dice under $50 to pick (dearest first)', one.has && !one.unlocked && one.words.includes('Add another dice and the cheaper of the two is free') && one.words.includes('1 of 2 dice') && one.words.includes('2nd free') && one.pips === 2 && one.on === 1
    && JSON.stringify(one.picks) === JSON.stringify(['Ember Dice Set', 'Moss Dice Set']) && one.picksTitle === 'Pick your second', JSON.stringify(one));
  const two = await cart('/cart-bf-two');
  ok('two dice, the cheaper one free by the Black Friday discount: "Your 2nd dice is free", what it saved, 2 of 2, nothing to pick', two.unlocked && two.words.includes('Your 2nd dice is free') && two.words.includes('You saved $30.00') && two.words.includes('2 of 2 dice') && two.words.includes('Every second dice is free. Add 2 more to get another.') && two.picks.length === 0, JSON.stringify(two));
  const none = await cart('/cart-bf-two-none');
  ok('two dice with nothing taken off: the cart says nothing about the deal (it isn\'t giving it)', !none.has, JSON.stringify(none));
  const wrong = await cart('/cart-bf-wrong-deal');
  ok("the usual deal's discount isn't read as Black Friday's: three dice, one free by the other title, says nothing", !wrong.has, JSON.stringify(wrong));
  const three = await cart('/cart-bf-three');
  ok('three dice, one free: says so, 1 of 2 toward the next, one more for another, the $20 dice to pick', three.unlocked && three.words.includes('Your 2nd dice is free') && three.words.includes('1 of 2 dice') && three.words.includes('Add 1 more dice to get another free.')
    && JSON.stringify(three.picks) === JSON.stringify(['Moss Dice Set']), JSON.stringify(three));
  const usual = await cart('/cart-bf-off-two');
  ok('off: two dice are one short of the usual third free, in its words', usual.has && !usual.unlocked && usual.words.includes('Add 1 more dice and the cheapest of the three is free') && usual.words.includes('2 of 3 dice') && usual.pips === 3 && usual.picksTitle === 'Pick your third', JSON.stringify(usual));
}

server.close();
console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);

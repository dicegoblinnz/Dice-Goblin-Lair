// Round 7 (mylair): My Lair after Mo's 6 Oct phone test. In demo mode through theme-mock, at 390px then 1280px:
// the six sections in a row that stays in sight (every one reachable from the row and by its address, the older ones
// included), Home's summary cards and their numbers, the loyalty card (the stacked logo, "Card N · X of 10 stamps", a
// full card's roll waiting and a fresh card at once, rolling), the Wallet (credit, a group's pass, Got a code? with
// ROLL-FOR-LOOT once and then refused, an unknown code, an HBD- code, a pass code, gifts by state and the rolls line,
// orders), the player profile (each field, the mobile messages, the 9th game, only what changed is sent), the GM box,
// staff tools and log out, the Library container and lair:me, the Tab's scanner, no &#39; and no sideways scroll.
// Usage: DG_THEME=/path/to/theme QA_PORT=4824 node tools/qa/round7/mylair.mjs [phone|desktop]   (exits 1 on a FAIL)
// Needs: npm install in tools/qa/theme-mock, and Playwright at /opt/node-tools/node_modules/playwright.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout');
  process.exit(2);
}
const m = await import('../theme-mock/render.mjs');
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.QA_PORT || process.env.PORT || 4824);
const BASE = `http://localhost:${PORT}`;
const OUT = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const ORDERS = [
  { name: '#1550', created_at: '2026-10-01T03:12:00Z', total_price: 10000, fulfillment_status: 'fulfilled', cancelled: false, customer_url: '/account/orders/1550' },
  { name: '#1544', created_at: '2026-09-28T03:12:00Z', total_price: 6000, fulfillment_status: null, cancelled: false, customer_url: '/account/orders/1544' },
];
const RUBY = {
  id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [],
  orders_count: 2, orders: ORDERS, store_credit_account: { balance: 500 },
};
const STASH = { ...RUBY, id: 7700114455, first_name: 'Tane', last_name: 'Rua', name: 'Tane Rua', email: 'tane@example.com', tags: ['Goblin Treasure - Board Game Rental'] };
const STAFF = { ...RUBY, id: 7700119999, first_name: 'Sam', last_name: 'Staff', name: 'Sam Staff', email: 'sam.staff@example.com', tags: ['staff'] };
const VIEWS = ['home', 'bookings', 'wallet', 'library', 'tab', 'profile'];
const LOOT = "Loot! That's 1 roll for your loyalty card. Roll it on Home, friend.";
const ONCE = "You've used that code already, friend. It's one go each.";
const UNKNOWN = "Gobgob doesn't know that code. Check it and try again, friend.";
const SHOP_CODE = "That's a shop discount code. Use it at checkout online, or show it at the counter.";
const MOBILE_WRONG = "That mobile number doesn't look right. Try one like 021 123 4567.";
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const money = (c) => `$${Number.isInteger(c / 100) ? c / 100 : (c / 100).toFixed(2)}`;
const results = [];
const check = (tag, name, ok, detail = '') => {
  results.push({ tag, name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${tag} | ${name}${detail && !ok ? ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

const server = await m.serve(PORT);
const browser = await chromium.launch();

async function open(size, path, customer, ctx = null) {
  const vp = SIZES[size];
  const phone = vp.width < 700;
  m.mockState.customer = customer;
  const context = ctx || (await browser.newContext({ viewport: vp, isMobile: phone, hasTouch: phone }));
  const page = await context.newPage();
  page.customer = customer; // the mock renders whoever is set when a page loads, so each page says who it's for
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') page.errors.push(`console: ${msg.text()}`);
  });
  await go(page, path);
  return { ctx: context, page };
}
async function go(page, path) {
  m.mockState.customer = page.customer;
  await page.goto('about:blank');
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('[data-coming]:not([aria-busy])', { state: 'attached', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
}
const state = (page) => page.evaluate(() => {
  const el = document.querySelector('my-lair');
  const a = document.activeElement;
  return {
    shown: [...el.querySelectorAll('[data-view]')].filter((v) => !v.hidden && getComputedStyle(v).display !== 'none').map((v) => v.dataset.view),
    current: [...el.querySelectorAll('[data-view-link][aria-current="page"]')].map((x) => x.dataset.viewLink),
    focus: a && a !== document.body ? a.id || a.tagName.toLowerCase() : '',
    hash: window.location.hash,
  };
});
const view = async (page, name) => {
  await page.click(`.ml-bar [data-view-link="${name}"]`);
  await page.waitForSelector(`[data-view="${name}"]:not([hidden])`, { timeout: 5000 });
  await page.waitForTimeout(250);
};
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const me = (page) => page.evaluate(async () => window.Lair.store.backend.me());
/** Submit Got a code? with a code and read what it says */
async function redeem(page, code) {
  await page.fill('#ml-claim-code', code);
  await page.click('[data-claim] button[type="submit"]');
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-claim] button[type="submit"]');
    const msg = document.querySelector('[data-claim-message]');
    return b && b.getAttribute('aria-busy') !== 'true' && msg && !msg.hidden;
  }, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(200);
  return flat(await page.locator('[data-claim-message]').innerText());
}

const only = process.argv[2];
for (const size of ['phone', 'desktop'].filter((s) => !only || s === only)) {
  const tag = size;
  // ---------------------------------------------------------------- sections and the row
  const { ctx, page } = await open(size, '/pages/my-lair', RUBY);
  const row = await page.evaluate(() => [...document.querySelectorAll('.ml-bar [data-view-link]')].map((a) => {
    const r = a.getBoundingClientRect();
    return { name: a.dataset.viewLink, label: a.textContent.trim().replace(/\s+\d+$/, ''), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), current: a.getAttribute('aria-current') };
  }));
  const vw = SIZES[size].width;
  check(tag, 'the row has the six sections in order, each labelled', row.map((x) => x.name).join() === VIEWS.join() && row.every((x) => x.label.length >= 3), row.map((x) => `${x.name}:${x.label}`).join(' '));
  check(tag, 'all six in sight at once, none hidden behind a click, each at least 44px', row.every((x) => x.left >= 0 && x.right <= vw && x.h >= 44 && x.w >= 44), row);
  check(tag, 'Home is marked as the current section', row[0].current === 'page' && row.slice(1).every((x) => !x.current));
  const bottomBar = await page.evaluate(() => [...document.querySelectorAll('my-lair nav')].filter((n) => getComputedStyle(n).position === 'fixed').length);
  check(tag, 'no fixed bottom bar: one row of sections, at the top', bottomBar === 0);
  // Home shows the greeting with Gobgob above the row
  const hello = await page.evaluate(() => {
    const img = document.querySelector('.ml-hello__gob');
    const rowTop = document.querySelector('.ml-bar').getBoundingClientRect().top;
    return { text: document.querySelector('.ml-hello__hi')?.textContent.trim(), src: img?.currentSrc || '', nat: img?.naturalWidth, w: img?.getAttribute('width'), h: img?.getAttribute('height'), above: img ? img.getBoundingClientRect().bottom <= rowTop + 1 : false };
  });
  check(tag, 'Gobgob says hello above the row (gobgob-240/480, sized)', hello.text === 'Kia ora, Ruby!' && /gobgob-(240|480)\.png/.test(hello.src) && hello.w === '240' && hello.h === '224' && hello.above, hello);
  // each link opens its section, marks it, puts it in the address and focus on its title
  for (const name of [...VIEWS.slice(1), 'home']) {
    await page.evaluate(() => window.scrollTo(0, 300));
    await view(page, name);
    const s = await state(page);
    check(tag, `the row opens ${name}`, s.shown.join() === name && s.current.join() === name && s.hash === `#${name}` && /^ml-.*-title$/.test(s.focus), s);
  }
  // the row stays in sight far down a long section, so every section is one tap from anywhere
  await view(page, 'wallet');
  await page.evaluate(() => {
    const end = document.querySelector('[data-view="wallet"]').getBoundingClientRect().bottom + window.scrollY;
    window.scrollTo(0, end - window.innerHeight);
  });
  await page.waitForTimeout(300);
  const stuck = await page.evaluate(() => {
    const r = document.querySelector('.ml-bar').getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), sy: Math.round(window.scrollY) };
  });
  check(tag, 'scrolled to the foot of the Wallet, the row is still in sight at the top', stuck.sy > 600 && stuck.top >= 0 && stuck.bottom <= 220, stuck);
  await page.click('.ml-bar [data-view-link="profile"]');
  await page.waitForTimeout(300);
  const fromFoot = await state(page);
  const titleSeen = await page.evaluate(() => {
    const t = document.getElementById('ml-profile-title').getBoundingClientRect();
    const bar = document.querySelector('.ml-bar').getBoundingClientRect();
    return t.top >= bar.bottom - 1 && t.top < window.innerHeight;
  });
  check(tag, 'one tap from there opens Profile, its title clear of the row', fromFoot.shown.join() === 'profile' && titleSeen, fromFoot);
  // addresses: new, ?view= (emails) and every older one
  const ADDRESSES = [
    ['', 'home'], ['#home', 'home'], ['#bookings', 'bookings'], ['#wallet', 'wallet'], ['#library', 'library'], ['#tab', 'tab'], ['#profile', 'profile'],
    ['?view=wallet', 'wallet'], ['?view=library', 'library'], ['?view=profile', 'profile'], ['?view=me', 'profile'], ['?view=bookings', 'bookings'],
    ['#me', 'profile'], ['#ml-library', 'library'], ['#ml-orders', 'wallet'], ['#ml-passes', 'wallet'], ['#ml-gifts', 'wallet'], ['#ml-credit', 'wallet'],
    ['#ml-dice', 'home'], ['#ml-card', 'home'], ['#ml-birthday', 'profile'], ['#ml-tab', 'tab'], ['#ml-tables', 'bookings'], ['#ml-seats', 'bookings'],
    ['#ml-events', 'bookings'], ['#ml-games', 'bookings'], ['#nope', 'home'],
  ];
  const wrong = [];
  for (const [path, want] of ADDRESSES) {
    await go(page, `/pages/my-lair${path}`);
    const s = await state(page);
    if (s.shown.join() !== want || s.current.join() !== want) wrong.push(`${path || '(none)'} → ${s.shown} / marks ${s.current}`);
  }
  check(tag, `every address opens its section (${ADDRESSES.length}, the older ones included)`, !wrong.length, wrong.join('; '));
  // keyboard: Tab from the top reaches the six links in order, each with a focus ring
  await go(page, '/pages/my-lair');
  const stops = [];
  let ringless = 0;
  for (let i = 0; i < 60 && stops.length < 6; i += 1) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate(() => {
      const a = document.activeElement;
      return a && a.dataset && a.dataset.viewLink ? { name: a.dataset.viewLink, ring: getComputedStyle(a).outlineStyle } : null;
    });
    if (hit) {
      stops.push(hit.name);
      if (hit.ring === 'none') ringless += 1;
    }
  }
  check(tag, 'keyboard: Tab reaches the six sections in order, each with a visible ring', stops.join() === VIEWS.join() && !ringless, `${stops} (${ringless} without a ring)`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const kb = await state(page);
  check(tag, 'keyboard: Enter on Profile opens it with focus on its title', kb.shown.join() === 'profile' && kb.focus === 'ml-profile-title', kb);

  // ---------------------------------------------------------------- Home: summary cards
  await go(page, '/pages/my-lair');
  let data = await me(page);
  const sums = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-sum]')].map((x) => [x.dataset.sum, x.textContent.trim()])));
  const wallet = flat(await page.locator('.ml-sum--wallet').innerText());
  const coming = await page.locator('[data-coming] .ml-coming__item').count();
  check(tag, 'Bookings card: how many are coming up, and the next three as rows', sums.bookings === `${coming} coming up` && (await page.locator('.ml-sum--bookings [data-next] .ml-row').count()) === Math.min(3, coming), `${sums.bookings} vs ${coming}`);
  const sessions = (data.passes || []).filter((p) => (p.status || 'active') === 'active').reduce((sum, p) => sum + Math.max(0, Number(p.sessionsLeft) || 0), 0);
  const ready = data.loyalty.rolls.available;
  const giftsReady = (data.gifts || []).filter((g) => g.state === 'ready').length;
  check(tag, 'Wallet card: store credit, sessions on passes, rolls ready, gifts ready', wallet.includes('$5') && wallet.includes(`${sessions} sessions on passes`) && wallet.includes(`${ready} roll${ready === 1 ? '' : 's'} ready`) && wallet.includes(`${giftsReady} gift${giftsReady === 1 ? '' : 's'} ready`), wallet);
  check(tag, 'Library card: no plan, so it offers to join', sums.library === 'Join' && sums['library-label'] === 'the library', sums);
  const tabTotal = (data.tab && ['open', 'in-cart'].includes(data.tab.status) ? data.tab.total : 0) + (data.dueNow || []).reduce((sum, d) => sum + (Number(d.due) || 0), 0);
  check(tag, "Tab card: today's total, with what's due", sums.tab === money(tabTotal) && /session/.test(sums['tab-more'] || ''), `${sums.tab} vs ${money(tabTotal)}; ${sums['tab-more']}`);
  check(tag, "Profile card: what's missing first", sums.profile === 'Add your mobile' && /birthday/.test(sums['profile-more']), `${sums.profile} / ${sums['profile-more']}`);
  const opens = [];
  for (const [selector, name] of [['.ml-sum--wallet', 'wallet'], ['.ml-sum--library', 'library'], ['.ml-sum--tab', 'tab'], ['.ml-sum--profile', 'profile'], ['.ml-sum--bookings .ml-sum__link', 'bookings']]) {
    await view(page, 'home');
    await page.locator(selector).first().click();
    await page.waitForTimeout(250);
    const s = await state(page);
    if (s.shown.join() !== name) opens.push(`${selector} → ${s.shown}`);
  }
  check(tag, 'each summary card opens its section', !opens.length, opens.join('; '));
  check(tag, "Home has no reserved-games row (My Library shows holds)", (await page.locator('[data-home-holds], .ml-reserved').count()) === 0);
  // a library member: games used of the plan, held and at home
  const member = await open(size, '/pages/my-lair', STASH);
  const mdata = await me(member.page);
  const msums = await member.page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-sum]')].map((x) => [x.dataset.sum, x.textContent.trim()])));
  const lib = mdata.library;
  const held = lib ? lib.holds.length : (mdata.holds || []).filter((h) => h.status === 'held' && h.until > Date.now()).length;
  const wantLib = lib && lib.plan ? `${lib.used} of ${lib.plan.games}` : `${held} of 3`;
  check(tag, 'Library card for a member: used of the plan, then held and at home', msums.library === wantLib && /held/.test(msums['library-more']) && /at home/.test(msums['library-more']), `${msums.library} vs ${wantLib}; ${msums['library-more']}`);
  await member.ctx.close();

  // ---------------------------------------------------------------- the loyalty card
  await go(page, '/pages/my-lair');
  data = await me(page);
  let L = data.loyalty;
  const logo = await page.evaluate(async () => {
    const img = document.querySelector('.ml-stampcard__logo');
    img.scrollIntoView({ block: 'center' });
    if (!img.complete) await new Promise((r) => img.addEventListener('load', r, { once: true }));
    const r = img.getBoundingClientRect();
    // the file's own pixels (naturalWidth is corrected for the srcset density)
    const bmp = await createImageBitmap(await (await fetch(img.currentSrc)).blob());
    return { src: img.currentSrc, alt: img.alt, nat: [bmp.width, bmp.height], shown: [Math.round(r.width), Math.round(r.height)], attrs: [img.getAttribute('width'), img.getAttribute('height')] };
  });
  const ratio = logo.shown[0] / logo.shown[1];
  check(tag, 'the card carries the stacked logo, sized asset, natural shape, never scaled up', /dg-logo-stacked-(320|640)\.png/.test(logo.src) && logo.alt === 'Dice Goblin' && [320, 640].includes(logo.nat[0])
    && Math.abs(ratio - 320 / 324) < 0.02 && logo.shown[0] <= logo.nat[0] && logo.shown[0] >= 96 && logo.attrs.join() === '320,324', logo);
  const card = await page.evaluate(() => {
    const el = document.querySelector('[data-stampcard]');
    const cs = getComputedStyle(el);
    const lum = (c) => {
      const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const probe = document.createElement('span');
    probe.style.color = cs.getPropertyValue('--ml-logo-green');
    document.body.append(probe);
    const green = getComputedStyle(probe).color;
    probe.remove();
    const text = getComputedStyle(el.querySelector('[data-stamp-count]')).color;
    const [a, b] = [lum(green), lum(text)].sort((x, y) => y - x);
    return {
      count: el.querySelector('[data-stamp-count] strong')?.textContent.trim(), next: el.querySelector('[data-stamp-count] span')?.textContent.trim(),
      stamped: el.querySelectorAll('[data-stamps] .ml-stamp.is-stamped').length, green, text, contrast: Math.round(((a + 0.05) / (b + 0.05)) * 10) / 10,
      border: cs.borderTopWidth, holder: el.querySelector('.ml-stampcard__holder')?.textContent.trim(),
    };
  });
  check(tag, `the card says "Card ${L.card} · ${L.stamps} of 10 stamps", its stamps in the slots`, card.count === `Card ${L.card} · ${L.stamps} of ${L.cardSize} stamps` && card.stamped === L.stamps && L.card === L.cards + 1, card);
  check(tag, "the card is in the logo's colours: bright green, black outline, text at 4.5:1 or better", /rgb\((\d+), (2[0-4]\d|25[0-5]), (\d+)\)/.test(card.green) && Number(card.green.match(/\d+/g)[1]) > 200 && card.border === '3px' && card.contrast >= 4.5, card);
  check(tag, "the card carries the holder's name", card.holder === 'Ruby Tane', card.holder);
  const readyText = flat(await page.locator('[data-rolls-ready]').innerText());
  check(tag, `rolls ready: "${L.rolls.available} roll${L.rolls.available === 1 ? '' : 's'} ready"`, readyText.startsWith(`${L.rolls.available} roll${L.rolls.available === 1 ? '' : 's'} ready`), readyText);
  const lairText = await page.evaluate(() => document.querySelector('my-lair').innerText);
  const how = await page.evaluate(() => [...document.querySelectorAll('.ml-odds__list li')].map((li) => li.textContent.trim()));
  check(tag, 'no welcome roll and no birthday-roll promise anywhere on the card', !/welcome roll|roll for every year|every year you've been/i.test(lairText + how.join(' '))
    && how.some((x) => /fresh card starts straight away/.test(x)) && how.some((x) => /Loot codes give rolls too/.test(x)), how.join(' / '));
  // a full card: the 10th stamp's roll waits under rolls ready, and the next card is there at once
  const before = L;
  const fill = before.cardSize - before.stamps;
  await page.evaluate((n) => {
    const be = window.Lair.store.backend;
    be.editLoyalty(String(be.cfg.customer.id), (x) => { x.seeded = (Number(x.seeded) || 0) + n; });
    be.commit();
  }, fill);
  await go(page, '/pages/my-lair');
  L = (await me(page)).loyalty;
  const fresh = await page.evaluate(() => ({
    count: document.querySelector('[data-stamp-count] strong')?.textContent.trim(),
    stamped: document.querySelectorAll('[data-stamps] .ml-stamp.is-stamped').length,
    note: document.querySelector('[data-card-fresh]')?.textContent.trim() || '',
    ready: document.querySelector('[data-rolls-ready]')?.innerText.replace(/\s+/g, ' ').trim(),
  }));
  check(tag, 'a full card: its roll joins rolls ready and a fresh card shows at once', L.card === before.card + 1 && L.stamps === 0 && L.rolls.available === before.rolls.available + 1
    && fresh.count === `Card ${before.card + 1} · 0 of 10 stamps` && fresh.stamped === 0 && fresh.ready.startsWith(`${L.rolls.available} roll`)
    && fresh.note === `Card ${before.card} is full! Its roll is ready below, and card ${before.card + 1} starts now.`, fresh);
  // rolling still works (?roll=14 forces the face)
  await go(page, '/pages/my-lair?roll=14');
  const rollsBefore = (await me(page)).loyalty.rolls.available;
  await page.click('[data-roll-slots] [data-roll]');
  await page.waitForSelector('[data-roll-slots] [data-result]', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
  const result = flat(await page.locator('[data-roll-slots] [data-result]').innerText().catch(() => ''));
  const rollsAfter = (await me(page)).loyalty.rolls.available;
  check(tag, 'rolling still works: a 14 is $14 store credit, one roll fewer', /You rolled a 14: \$14 store credit is yours\./.test(result) && rollsAfter === rollsBefore - 1, `${result} (${rollsBefore} → ${rollsAfter})`);
  await page.locator('.ml-roll').first().screenshot({ path: `${OUT}mylair-card-${size}.png` }).catch(() => {});

  // ---------------------------------------------------------------- the Wallet
  await go(page, '/pages/my-lair#wallet');
  const credit = flat(await page.locator('#ml-credit').innerText());
  check(tag, 'store credit', /\$5\.00/.test(credit), credit);
  // a group's pass: the demo's own when staff-admin's groups are in, else one added for this check
  const group = await page.evaluate(async () => {
    const be = window.Lair.store.backend;
    const mine = await be.me();
    let pass = (mine.passes || []).find((p) => p.group && p.group.name);
    if (!pass) {
      const original = be.passesFor.bind(be);
      be.passesFor = async () => [...(await original()), {
        code: 'WL-OWLBEAR-7', label: 'Warhammer League: 10 sessions', sessionsTotal: 10, sessionsLeft: 6, cover: 1000, expiresAt: null, status: 'active',
        source: 'staff', orderName: null, group: { id: 'grp-qa', name: 'Warhammer League' },
      }];
      const lair = document.querySelector('my-lair');
      lair.dispatchEvent(new CustomEvent('lair:refresh', { bubbles: true }));
      await lair.loading;
      pass = (await be.me()).passes.find((p) => p.group);
    }
    const el = [...document.querySelectorAll('.ml-pass')].find((x) => x.textContent.includes(pass.code));
    return { name: pass.group.name, label: el?.querySelector('.ml-pass__label')?.textContent.trim(), line: el?.querySelector('.ml-pass__group')?.textContent.trim(), after: el?.querySelector('.ml-pass__label')?.closest('.ml-pass__top')?.nextElementSibling?.className };
  });
  check(tag, "a group's pass says \"<group> group\" under its label", group.line === `${group.name} group` && /ml-pass__group/.test(group.after || ''), group);
  // Got a code?
  const box = flat(await page.locator('#ml-code').innerText());
  check(tag, 'Got a code? with its line', box.includes('Got a code?') && box.includes("Pass codes, gift codes and Gobgob's loot codes all go here."), box);
  await page.fill('#ml-claim-code', '');
  await page.click('[data-claim] button[type="submit"]');
  await page.waitForTimeout(200);
  check(tag, 'an empty box: "Type your code first."', flat(await page.locator('[data-claim-message]').innerText()) === 'Type your code first.');
  check(tag, 'an unknown code: Gobgob doesn\'t know it', (await redeem(page, 'NOPE-NOPE-99')) === UNKNOWN);
  data = await me(page);
  const hbd = (data.gifts || []).find((g) => g.product && g.product.code);
  check(tag, 'an HBD- gift code: it\'s a shop discount code', Boolean(hbd) && (await redeem(page, hbd.product.code)) === SHOP_CODE, hbd && hbd.product.code);
  const rolls0 = data.loyalty.rolls.available;
  const loot = await redeem(page, 'roll for loot');
  const go1 = await page.locator('[data-claim-go]').count();
  const rolls1 = (await me(page)).loyalty.rolls.available;
  const homeReady = await page.evaluate(() => document.querySelector('[data-rolls-ready]')?.innerText.replace(/\s+/g, ' ').trim());
  check(tag, 'ROLL-FOR-LOOT (typed loosely) gives 1 roll, says so, and offers the way to Home', loot === LOOT && rolls1 === rolls0 + 1 && go1 === 1 && (homeReady || '').startsWith(`${rolls1} roll`), `${loot} | ${rolls0} → ${rolls1} | ${homeReady}`);
  check(tag, 'ROLL-FOR-LOOT a second time: one go each', (await redeem(page, 'ROLL-FOR-LOOT')) === ONCE && (await me(page)).loyalty.rolls.available === rolls1);
  const unclaimed = await page.evaluate(() => (window.Lair.store.backend.passList().find((p) => !p.customerId && p.status === 'active' && !p.groupId) || {}));
  const passSaid = await redeem(page, unclaimed.code || 'NONE');
  const passListed = (await page.locator('[data-passes]').innerText()).includes(unclaimed.code);
  check(tag, 'a pass code: "Added to your wallet: <label>." and it\'s in My passes', passSaid === `Added to your wallet: ${unclaimed.label}.` && passListed, `${unclaimed.code}: ${passSaid}`);
  // birthday gifts: a full card while ready, a line once claimed, the rolls line only while rolls wait
  data = await me(page);
  const readyGift = (data.gifts || []).find((g) => g.state === 'ready');
  const claimedGift = (data.gifts || []).find((g) => g.state === 'claimed');
  const gifts = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('[data-gifts] .ml-gift')].map((x) => x.innerText.replace(/\s+/g, ' ').trim()),
    lines: [...document.querySelectorAll('[data-gifts] .ml-gift-line')].map((x) => x.innerText.replace(/\s+/g, ' ').trim()),
  }));
  check(tag, 'a ready gift is a full card with its words and its code to copy', Boolean(readyGift) && gifts.cards.length === 1 && gifts.cards[0].includes(readyGift.words) && gifts.cards[0].includes('Copy the code'), gifts.cards);
  check(tag, 'a claimed gift is one line, with its words', Boolean(claimedGift) && gifts.lines.length === 1 && gifts.lines[0].includes(claimedGift.words) && /claimed/i.test(gifts.lines[0]) && /used/.test(claimedGift.words), gifts.lines);
  const waiting = Math.min(claimedGift ? claimedGift.rolls : 0, data.loyalty.rolls.available);
  check(tag, `while rolls wait: "Your ${waiting} roll${waiting === 1 ? ' is' : 's are'} waiting on Home."`, waiting > 0 && gifts.lines[0].includes(`Your ${waiting} roll${waiting === 1 ? ' is' : 's are'} waiting on Home.`), gifts.lines[0]);
  await page.evaluate(async () => {
    const be = window.Lair.store.backend;
    const left = (await be.me()).loyalty.rolls.available;
    be.editLoyalty(String(be.cfg.customer.id), (x) => { x.used += left; });
    be.commit();
    await document.querySelector('my-lair').refreshRolls();
  });
  await page.waitForTimeout(200);
  const noRolls = flat(await page.locator('[data-gifts]').innerText());
  check(tag, 'once every roll is rolled, no gift says rolls are waiting', !/waiting on Home/.test(noRolls), noRolls);
  // orders, moved here from Me, with the links to all orders and addresses
  const orders = await page.evaluate(() => {
    const box = document.getElementById('ml-orders');
    return { inWallet: Boolean(box && box.closest('[data-view="wallet"]')), rows: box ? box.querySelectorAll('.ml-order').length : 0, links: box ? [...box.querySelectorAll('.ml-links a')].map((a) => a.getAttribute('href')) : [] };
  });
  check(tag, 'orders are in the Wallet with all orders and addresses', orders.inWallet && orders.rows === 2 && orders.links.includes('/account') && orders.links.some((h) => /profile/.test(h)), orders);
  check(tag, 'the Wallet: no sideways scroll', (await overflow(page)) <= 0);
  await page.screenshot({ path: `${OUT}mylair-wallet-${size}.png`, fullPage: true });

  // ---------------------------------------------------------------- Profile
  await go(page, '/pages/my-lair#profile');
  const sent = [];
  await page.exposeFunction('qaSent', (x) => sent.push(x)).catch(() => {});
  await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const original = be.saveProfile.bind(be);
    be.saveProfile = (input) => {
      window.qaSent(JSON.stringify(input));
      return original(input);
    };
  });
  const who = flat(await page.locator('#ml-player').innerText());
  check(tag, 'the player profile says who sees what', who.includes('Your GM sees your pronouns, favourite games and about me. Your mobile and birthday are just for the Lair team.'), who.slice(0, 200));
  const ready2 = await page.evaluate(() => !document.querySelector('[data-player-fields]').disabled && !document.querySelector('[data-player-save]').disabled);
  check(tag, 'the form opens once GET /me has filled it', ready2);
  const save = async () => {
    await page.click('[data-player-save]');
    await page.waitForFunction(() => document.querySelector('[data-player-save]').getAttribute('aria-busy') !== 'true' && !document.querySelector('[data-player-message]').hidden, null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(150);
    return flat(await page.locator('[data-player-message]').innerText());
  };
  // the mobile's messages
  await page.fill('#ml-pf-mobile', '09 123 4567');
  let said = await save();
  const invalid = await page.getAttribute('#ml-pf-mobile', 'aria-invalid');
  check(tag, 'a landline is refused before sending, with the contract\'s words', said === MOBILE_WRONG && invalid === 'true' && !sent.length, said);
  const app422 = await page.evaluate(async () => {
    try {
      await window.Lair.store.backend.saveProfile({ mobile: '12345' });
      return 'saved';
    } catch (error) {
      return `${error.status} ${error.message}`;
    }
  });
  check(tag, 'the app refuses it too: 422 and the same words', app422 === `422 ${MOBILE_WRONG}`, app422);
  sent.length = 0;
  // every field
  await page.fill('#ml-pf-name', 'Ruby Tane-Smith');
  await page.fill('#ml-pf-mobile', '021 123 4567');
  await page.selectOption('#ml-bday-day', '11');
  await page.selectOption('#ml-bday-month', '6');
  await page.fill('#ml-pf-pronouns', 'she/her');
  const nine = ['Catan', 'Root', 'Wingspan', 'Azul', 'Daggerheart', 'Riftbound', 'Kill Team', 'Patchwork', 'Splendor'];
  for (const name of nine) {
    if (await page.locator('#ml-pf-game').isDisabled()) break;
    await page.fill('#ml-pf-game', name);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(60);
  }
  const chips = await page.locator('[data-games] .ml-gamechip').count();
  const full = await page.locator('#ml-pf-game').isDisabled();
  const gamesHint = flat(await page.locator('[data-games-hint]').innerText());
  check(tag, 'a 9th favourite game is dropped: the box stops at 8 and says why', chips === 8 && full && /That's 8, the most there's room for/.test(gamesHint), `${chips} chips, disabled ${full}: ${gamesHint}`);
  await page.fill('#ml-pf-about', 'Paints minis badly, rolls dice well.\nAlways brings snacks.');
  said = await save();
  const p1 = (await me(page)).profile;
  check(tag, 'saving: the words, and every field is kept', said === "Saved. Gobgob's got your details. Gobgob has circled 11 June on the calendar."
    && p1.name === 'Ruby Tane-Smith' && p1.mobile === '021 123 4567' && p1.birthday === '06-11' && p1.pronouns === 'she/her' && p1.favouriteGames.length === 8 && p1.favouriteGames[0] === 'Catan'
    && !p1.favouriteGames.includes('Splendor') && p1.about === 'Paints minis badly, rolls dice well.\nAlways brings snacks.', `${said} | ${JSON.stringify(p1)}`);
  // only what changed is sent
  sent.length = 0;
  await page.click('[data-games] .ml-gamechip:first-child [data-game-remove]');
  await page.fill('#ml-pf-pronouns', 'she/they');
  said = await save();
  const patch = JSON.parse(sent[0] || '{}');
  check(tag, 'only what changed is sent: pronouns and the games', Object.keys(patch).sort().join() === 'favouriteGames,pronouns' && patch.pronouns === 'she/they' && patch.favouriteGames.length === 7, sent[0]);
  const nineApp = await page.evaluate(async () => (await window.Lair.store.backend.saveProfile({ favouriteGames: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'a'] })).profile.favouriteGames);
  check(tag, 'the app keeps 8 games too, repeats dropped', nineApp.join() === 'A,B,C,D,E,F,G,H', nineApp);
  await page.evaluate(async () => window.Lair.store.backend.saveProfile({ favouriteGames: ['Root', 'Wingspan'] }));
  await go(page, '/pages/my-lair#profile');
  const refilled = await page.evaluate(() => ({
    name: document.getElementById('ml-pf-name').value, mobile: document.getElementById('ml-pf-mobile').value, day: document.getElementById('ml-bday-day').value,
    month: document.getElementById('ml-bday-month').value, pronouns: document.getElementById('ml-pf-pronouns').value, games: [...document.querySelectorAll('[data-games] .ml-gamechip__name')].map((x) => x.textContent),
    about: document.getElementById('ml-pf-about').value,
  }));
  check(tag, 'back on the page, the form shows what was saved', refilled.name === 'Ruby Tane-Smith' && refilled.mobile === '021 123 4567' && refilled.day === '11' && refilled.month === '6' && refilled.pronouns === 'she/they'
    && refilled.games.join() === 'Root,Wingspan' && /Always brings snacks/.test(refilled.about), refilled);
  // clearing the mobile is allowed
  await page.fill('#ml-pf-mobile', '');
  said = await save();
  check(tag, 'a mobile can be cleared', /^Saved\./.test(said) && (await me(page)).profile.mobile === '', said);
  const homeProfile = await page.evaluate(() => document.querySelector('[data-sum="profile"]').textContent.trim());
  check(tag, "Home's Profile card follows: add your mobile", homeProfile === 'Add your mobile', homeProfile);
  // the GM profile, an optional box under it, and the way there from the games they run in Bookings
  const gmBox = await page.evaluate(() => {
    const box = document.getElementById('ml-gm-profile');
    const player = document.getElementById('ml-player');
    return { there: Boolean(box && box.closest('[data-view="profile"]')), after: Boolean(player && box && (player.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING)), summary: box?.querySelector('summary')?.textContent.trim(), open: box?.querySelector('details')?.open };
  });
  check(tag, 'the GM profile is a box under the player profile, shut until wanted', gmBox.there && gmBox.after && gmBox.summary === 'Set up my GM profile' && gmBox.open === false, gmBox);
  await page.click('#ml-gm-profile summary');
  await page.fill('#ml-gm-name', 'Ruby the Bold');
  await page.fill('#ml-gm-bio', 'Cosy horror, lots of snacks.');
  await page.click('[data-gm-profile] button[type="submit"]');
  await page.waitForTimeout(400);
  const gmSaid = flat(await page.locator('[data-profile-message]').innerText());
  check(tag, 'the GM profile saves', gmSaid === 'Saved. Players see this on your games.' && (await me(page)).gmProfile.name === 'Ruby the Bold', gmSaid);
  // log out, and no staff tools for a customer
  const out = await page.evaluate(() => ({ logout: document.querySelector('[data-view="profile"] .ml-logout a')?.getAttribute('href'), staff: document.querySelectorAll('.ml-staff').length, sw: document.querySelectorAll('.view-switch').length }));
  check(tag, 'Profile ends with log out; a customer sees no staff tools or switch', out.logout === '/account/logout' && !out.staff && !out.sw, out);
  check(tag, 'Profile: no sideways scroll', (await overflow(page)) <= 0);
  await page.screenshot({ path: `${OUT}mylair-profile-${size}.png`, fullPage: true });

  // ---------------------------------------------------------------- Library, Tab, the words, console
  await go(page, '/pages/my-lair#library');
  const container = await page.evaluate(() => {
    const el = document.querySelector('[data-view="library"] my-library');
    return { here: Boolean(el), plans: el?.dataset.plansUrl, shelves: el?.dataset.shelvesUrl, holding: el?.querySelector('.ml-loading')?.textContent.trim() || el?.textContent.trim().slice(0, 40) };
  });
  check(tag, '<my-library> sits in the Library section with its links and a holding line', container.here && /#plans$/.test(container.plans || '') && Boolean(container.shelves) && Boolean(container.holding), container);
  const events = await page.evaluate(async () => {
    const lair = document.querySelector('my-lair');
    const seen = [];
    lair.addEventListener('lair:me', (e) => seen.push(Boolean(e.detail && e.detail.me && e.detail.me.member)), { once: false });
    document.addEventListener('lair:me', () => seen.push('bubbled'));
    lair.querySelector('my-library').dispatchEvent(new CustomEvent('lair:refresh', { bubbles: true }));
    await lair.loading;
    return { seen, me: Boolean(lair.me && lair.me.member && lair.me.loyalty), holds: Array.isArray(lair.me && lair.me.holds) };
  });
  check(tag, 'lair:refresh fetches GET /me again; lair:me (bubbling) carries it; .me keeps it', events.seen.includes(true) && events.seen.includes('bubbled') && events.me && events.holds, events);
  await view(page, 'tab');
  const tabBits = await page.evaluate(() => {
    const scan = document.querySelector('[data-scan]');
    const r = scan?.getBoundingClientRect();
    return { scan: Boolean(scan && r.width && r.height >= 44 && getComputedStyle(scan).visibility !== 'hidden'), catalogue: Boolean(document.querySelector('[data-tab-catalogue]')), menu: Boolean(document.querySelector('[data-tab-menu] .ml-menu__group')) };
  });
  check(tag, 'Tab: the scan button in sight (44px), the catalogue and menu as they were', tabBits.scan && tabBits.catalogue && tabBits.menu, tabBits);
  const words = [];
  let wide = 0;
  for (const name of VIEWS) {
    await view(page, name);
    words.push(await page.evaluate(() => document.querySelector('my-lair').innerText));
    wide = Math.max(wide, await overflow(page));
  }
  const entities = words.join('\n').match(/&(#39|#x27|amp|quot|lt|gt);/g) || [];
  check(tag, 'no &#39; (or any other entity) shows, in any section', !entities.length, entities.join(' '));
  check(tag, 'no sideways scroll in any section', wide <= 0, `${wide}px`);
  check(tag, 'no console errors', !page.errors.length, page.errors.slice(0, 3).join(' | '));
  for (const name of ['home', 'bookings']) {
    await view(page, name);
    await page.screenshot({ path: `${OUT}mylair-${name}-${size}.png`, fullPage: true });
  }
  await ctx.close();

  // ---------------------------------------------------------------- staff: the switch at the top, staff tools in Profile
  const staff = await open(size, '/pages/my-lair#profile', STAFF);
  const st = await staff.page.evaluate(() => {
    const sw = document.querySelector('.view-switch');
    const tools = document.querySelector('[data-view="profile"] .ml-staff a');
    return { sw: Boolean(sw), swTop: sw ? Math.round(sw.getBoundingClientRect().top + window.scrollY) : null, tools: tools?.getAttribute('href'), order: [...document.querySelectorAll('[data-view="profile"] .ml-player, [data-view="profile"] .ml-gmbox, [data-view="profile"] .ml-staff, [data-view="profile"] .ml-logout')].map((x) => x.className.split(' ').pop()) };
  });
  check(tag, "staff: round 6's switch at the top, staff tools in Profile after the profiles, then log out", st.sw && st.swTop < 400 && st.tools === '/pages/lair-staff' && st.order.join() === 'ml-player,ml-gmbox,ml-staff,ml-logout', st);
  // staff run games: Bookings links to the GM profile from the games they run (Mo: it belongs with session booking)
  await go(staff.page, '/pages/my-lair#ml-games');
  await staff.page.click('[data-gm-profile-link]');
  await staff.page.waitForTimeout(350);
  const viaBookings = await state(staff.page);
  const opened = await staff.page.evaluate(() => document.querySelector('#ml-gm-profile details')?.open);
  check(tag, 'Bookings links to the GM profile from the games they run, open and in focus', viaBookings.shown.join() === 'profile' && opened === true && viaBookings.focus === 'ml-gm-title', viaBookings);
  check(tag, 'staff: no console errors', !staff.page.errors.length, staff.page.errors.slice(0, 3).join(' | '));
  await staff.ctx.close();
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `mylair: ${failed.length} of ${results.length} FAILED` : `mylair: all ${results.length} passed`);
await browser.close();
server.close();
process.exitCode = failed.length ? 1 : 0;

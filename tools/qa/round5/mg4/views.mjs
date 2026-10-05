// My Lair's five views (website review D1, D7, D9): a bar at the bottom of a phone and a rail from 990px, links not
// tabs, so back, forward, refresh and shared links work. Each view's title takes focus when it opens. Every older
// address (#ml-seats, #ml-passes...) and ?view= opens the right view, Bookings' chips filter it, a plain visit is Home.
// Also: the keyboard path through the bar, the Tab view's "Add to my tab" bar sitting above the bottom bar, Home's
// height, one filled button per ticket (cancelling is a ruby link), no dash before Gobgob, the payment link for a
// place held for an online payment, and the logged-out page listing the five views. Phone, then desktop.
import { start, stop, open, report, errors, shot, overflow, view, openRow, BASE } from './harness.mjs';

const PREFIX = process.argv[2] || 'views';
const flat = (s) => s.replace(/\s+/g, ' ').trim();
await start();

/** Which view shows, which bar link says so, the chip, the parts of Bookings showing, what has focus */
const state = (page) => page.evaluate(() => {
  const el = document.querySelector('my-lair');
  const a = document.activeElement;
  return {
    shown: [...el.querySelectorAll('[data-view]')].filter((v) => !v.hidden && getComputedStyle(v).display !== 'none').map((v) => v.dataset.view),
    current: [...el.querySelectorAll('[data-view-link][aria-current="page"]')].map((x) => x.dataset.viewLink),
    chip: el.querySelector('[data-filter-link][aria-current="true"]')?.dataset.filterLink || '',
    blocks: [...el.querySelectorAll('.ml-block[data-filter]')].filter((b) => !b.hidden).map((b) => b.dataset.filter),
    focus: a && a !== document.body ? a.id || `${a.tagName.toLowerCase()}.${String(a.className).split(' ')[0]}` : '',
    hash: window.location.hash,
  };
});
const inView = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.height > 0 && r.top >= 0 && r.top < window.innerHeight;
}, selector);
const want = (tag, s, view, label, more = {}) => {
  if (s.shown.length !== 1 || s.shown[0] !== view) errors.push(`${tag} ${label}: shows [${s.shown}], want ${view}`);
  if (s.current.length !== 1 || s.current[0] !== view) errors.push(`${tag} ${label}: the bar marks [${s.current}], want ${view}`);
  if (more.focus !== undefined && s.focus !== more.focus) errors.push(`${tag} ${label}: focus on ${s.focus || 'nothing'}, want ${more.focus}`);
  if (more.chip !== undefined && s.chip !== more.chip) errors.push(`${tag} ${label}: chip ${s.chip}, want ${more.chip}`);
};
const TITLES = { home: 'ml-home-title', bookings: 'ml-bookings-title', tab: 'ml-tab-title', wallet: 'ml-wallet-title', me: 'ml-me-title' };
const OLD = [
  ['#ml-card', 'home', 'ml-gcard-title'], ['#ml-dice', 'home', 'ml-roll-title'], ['#ml-tab', 'tab', 'ml-tab-title'],
  ['#ml-passes', 'wallet', 'ml-passes-title'], ['#ml-tables', 'bookings', 'ml-tables-title', 'tables'], ['#ml-seats', 'bookings', 'ml-seats-title', 'seats'],
  ['#ml-events', 'bookings', 'ml-events-title', 'events'], ['#ml-games', 'bookings', 'ml-games-title', 'games'], ['#ml-birthday', 'me', 'ml-bday-title'],
  ['#ml-orders', 'me', 'ml-orders-title'], ['#ml-library', 'me', 'ml-library-title'],
];

for (const size of ['phone', 'desktop']) {
  const { ctx, page, tag } = await open(size);
  // 1. A plain visit: Home, and the page doesn't grab focus
  let s = await state(page);
  want(tag, s, 'home', 'plain visit', { focus: '' });
  const home = await page.evaluate(() => {
    const vh = window.innerHeight;
    const above = (sel) => [...document.querySelectorAll(sel)].filter((el) => el.getBoundingClientRect().height && el.getBoundingClientRect().bottom <= vh).length;
    return {
      height: document.documentElement.scrollHeight,
      content: Math.round(document.querySelector('.site-footer').getBoundingClientRect().top + window.scrollY),
      card: above('[data-view="home"] .ml-gcard__card'),
      due: above('[data-home-due]:not([hidden]) .ml-due'),
      rows: above('[data-next] .ml-row'),
      demoNote: Math.round(document.querySelector('.ml .lair-demo')?.getBoundingClientRect().height || 0),
    };
  });
  console.log(tag, `Home: ${home.height}px with the footer, content ends at ${home.content}px; on the first screen: card ${home.card}, due ${home.due}, ${home.rows} rows (preview note ${home.demoNote}px, live has none)`);
  if (!home.card) errors.push(`${tag}: the Goblin card isn't on Home's first screen`);
  await shot(page, `${PREFIX}-home-${size}`);
  await overflow(page, tag);

  // 2. The bar: each link shows its view, marks it, puts its address in the URL, focus on its title, at the view's top
  for (const name of ['bookings', 'tab', 'wallet', 'me', 'home']) {
    await page.evaluate(() => window.scrollTo(0, 400));
    await view(page, name);
    s = await state(page);
    want(tag, s, name, `bar → ${name}`, { focus: TITLES[name] });
    if (s.hash !== `#${name}`) errors.push(`${tag} bar → ${name}: address ${s.hash}`);
    if (!(await inView(page, `#${TITLES[name]}`))) errors.push(`${tag} bar → ${name}: its title isn't on screen`);
    await overflow(page, `${tag}/${name}`);
    if (name !== 'home') await shot(page, `${PREFIX}-${name}-${size}`);
  }
  // the same link again: back to the view's top, focus on its title
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.click('.ml-bar [data-view-link="home"]');
  await page.waitForTimeout(200);
  s = await state(page);
  if (s.focus !== TITLES.home || !(await inView(page, `#${TITLES.home}`))) errors.push(`${tag}: tapping the current view's link doesn't go back to its top (${s.focus})`);

  // 3. Back and forward walk the views (and refresh keeps the view)
  await page.goBack();
  await page.waitForTimeout(250);
  want(tag, await state(page), 'me', 'back from home');
  await page.goBack();
  await page.waitForTimeout(250);
  want(tag, await state(page), 'wallet', 'back again');
  await page.goForward();
  await page.waitForTimeout(250);
  want(tag, await state(page), 'me', 'forward');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-panel="bookings"]:not([aria-busy])', { state: 'attached' });
  want(tag, await state(page), 'me', 'refresh on #me', { focus: TITLES.me });

  // 4. Every older address opens the view it lives in now (Bookings with its chip), with that part in sight and focused
  for (const [hash, name, heading, chip] of OLD) {
    await page.goto('about:blank');
    await page.goto(`${BASE}/pages/my-lair${hash}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-panel="bookings"]:not([aria-busy])', { state: 'attached' });
    await page.waitForTimeout(250);
    s = await state(page);
    want(tag, s, name, hash, { focus: heading, ...(chip ? { chip } : {}) });
    if (chip && (s.blocks.length !== 1 || s.blocks[0] !== chip)) errors.push(`${tag} ${hash}: Bookings shows [${s.blocks}]`);
    if (!(await inView(page, `#${heading}`))) errors.push(`${tag} ${hash}: ${heading} isn't on screen`);
  }
  // ?view= for emails; the #hash wins over it; anything unknown is Home
  for (const [path, name] of [['?view=wallet', 'wallet'], ['?view=bookings', 'bookings'], ['?view=wallet#tab', 'tab'], ['?view=nope', 'home'], ['#nope', 'home']]) {
    await page.goto('about:blank');
    await page.goto(`${BASE}/pages/my-lair${path}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-panel="bookings"]:not([aria-busy])', { state: 'attached' });
    want(tag, await state(page), name, path);
  }

  // 5. Bookings' chips: the filter changes in place, focus stays on the chip, the address changes, back undoes it
  await page.goto('about:blank');
  await page.goto(`${BASE}/pages/my-lair#bookings`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-panel="bookings"]:not([aria-busy])', { state: 'attached' });
  want(tag, await state(page), 'bookings', '#bookings', { chip: 'all' });
  await page.click('[data-filter-link="seats"]');
  await page.waitForTimeout(150);
  s = await state(page);
  if (s.chip !== 'seats' || s.blocks.join() !== 'seats' || s.hash !== '#ml-seats') errors.push(`${tag} chip: ${JSON.stringify(s)}`);
  if (!/tag-chip/.test(s.focus) && s.focus !== '') errors.push(`${tag} chip: focus moved to ${s.focus}`);
  if (!(await inView(page, '[data-filter-link="seats"]'))) errors.push(`${tag} chip: the chips scrolled away`);
  await page.goBack();
  await page.waitForTimeout(250);
  s = await state(page);
  if (s.chip !== 'all' || s.blocks.length !== 4) errors.push(`${tag} chip, back: ${JSON.stringify(s)}`);

  // 6. Home's "Coming up": a row opens Bookings at its ticket (a later one's row opened), focus on the ticket
  await view(page, 'home');
  const rowHref = await page.locator('[data-next] .ml-row').nth(1).getAttribute('href');
  await page.locator('[data-next] .ml-row').nth(1).click();
  await page.waitForTimeout(300);
  s = await state(page);
  want(tag, s, 'bookings', `Home row ${rowHref}`, { focus: rowHref.slice(1) });
  const opened = await page.evaluate((id) => document.getElementById(id)?.closest('details.ml-later')?.open ?? 'not folded', rowHref.slice(1));
  if (opened === false) errors.push(`${tag} Home row: its ticket's row didn't open`);
  if (!(await inView(page, rowHref))) errors.push(`${tag} Home row: the ticket isn't on screen`);

  // 7. The keyboard: from the top, Tab reaches the five links in order; Enter opens a view with focus on its title;
  // the next Tab goes into the view
  await page.goto('about:blank');
  await page.goto(`${BASE}/pages/my-lair`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-panel="bookings"]:not([aria-busy])', { state: 'attached' });
  const stops = [];
  for (let i = 0; i < 40 && stops.length < 5; i += 1) {
    await page.keyboard.press('Tab');
    const link = await page.evaluate(() => document.activeElement?.dataset?.viewLink || '');
    if (link) {
      stops.push(link);
      const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
      if (ring === 'none') errors.push(`${tag} keyboard: no focus ring on ${link}`);
    }
  }
  if (stops.join() !== 'home,bookings,tab,wallet,me') errors.push(`${tag} keyboard: bar stops ${stops}`);
  // back to Bookings' link and open it
  await page.focus('.ml-bar [data-view-link="bookings"]');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  s = await state(page);
  want(tag, s, 'bookings', 'keyboard Enter', { focus: TITLES.bookings });
  await page.keyboard.press('Tab');
  const next = await page.evaluate(() => document.activeElement?.dataset?.filterLink || document.activeElement?.className);
  if (next !== 'all') errors.push(`${tag} keyboard: after the title, Tab goes to ${next}, want the All chip`);
  // every view's controls take focus with a visible ring
  for (const name of ['home', 'bookings', 'tab', 'wallet', 'me']) {
    await view(page, name);
    const missing = await page.evaluate(async (n) => {
      const out = [];
      const v = document.querySelector(`[data-view="${n}"]`);
      for (const el of v.querySelectorAll('a[href], button:not([disabled]), input, select, summary, textarea')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || el.closest('[hidden]')) continue;
        // inside a later booking's folded row (its summary is what takes focus)
        const fold = el.closest('details:not([open])');
        if (fold && el !== fold.querySelector(':scope > summary')) continue;
        el.focus();
        if (document.activeElement !== el) out.push(`${el.tagName} "${el.textContent.trim().slice(0, 24)}" won't focus`);
      }
      return out;
    }, name);
    if (missing.length) errors.push(`${tag} ${name}: ${missing.slice(0, 4).join(' | ')}`);
  }

  // 8. The Tab view: pick something, and the "Add to my tab" bar sits above the bottom bar (phone), never under it
  await view(page, 'tab');
  if (!(await page.locator('.ml-menu__item').first().isVisible())) await page.locator('[data-menu-toggle]').first().click();
  await page.locator('.ml-menu__item [data-step="1"]').first().click();
  await page.waitForSelector('[data-tab-bar]:not([hidden])');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  // the bar rises into place (lair-my.css): measure where it settles
  await page.evaluate(() => Promise.all(document.querySelector('[data-tab-bar]').getAnimations().map((a) => a.finished.catch(() => {}))));
  const bars = await page.evaluate(() => {
    const add = document.querySelector('[data-tab-bar]').getBoundingClientRect();
    const nav = document.querySelector('.ml-bar').getBoundingClientRect();
    return { add: [Math.round(add.top), Math.round(add.bottom)], nav: [Math.round(nav.top), Math.round(nav.bottom)], fixed: getComputedStyle(document.querySelector('.ml-bar')).position, vh: window.innerHeight };
  });
  console.log(tag, 'Tab bars:', JSON.stringify(bars));
  if (bars.fixed === 'fixed' && bars.add[1] > bars.nav[0]) errors.push(`${tag}: "Add to my tab" (${bars.add}) overlaps the bottom bar (${bars.nav})`);
  if (bars.add[1] > bars.vh) errors.push(`${tag}: "Add to my tab" is off screen (${bars.add})`);
  await shot(page, `${PREFIX}-tab-bars-${size}`);

  // 9. One filled button per ticket at most; Add to calendar a ghost; cancelling a ruby link (still [data-cancel] and
  // .ml-cancel), which asks first; ticket titles at --text-lg; ghosts on cream ringed in ink at 55%
  await view(page, 'bookings');
  const look = await page.evaluate(() => {
    const filled = [...document.querySelectorAll('.ml-ticket')].map((t) => [...t.querySelectorAll('.button')].filter((b) => !b.classList.contains('button--ghost')).length);
    const cancel = document.querySelector('.ml-ticket [data-cancel]');
    const ghost = document.querySelector('.ml-ticket .button--ghost');
    const title = document.querySelector('.ml-ticket__title');
    const probe = document.createElement('span');
    probe.style.fontSize = 'var(--text-lg)';
    document.body.append(probe);
    const lg = getComputedStyle(probe).fontSize;
    probe.style.color = 'var(--c-ruby-ink)';
    const rubyInk = getComputedStyle(probe).color;
    probe.remove();
    return {
      filled, cancelClass: cancel?.className, cancelColor: cancel && getComputedStyle(cancel).color, rubyInk,
      ghostRing: ghost && getComputedStyle(ghost).boxShadow, titleSize: title && getComputedStyle(title).fontSize, lg,
    };
  });
  if (look.filled.some((n) => n > 1)) errors.push(`${tag}: a ticket has ${Math.max(...look.filled)} filled buttons`);
  if (!/text-link/.test(look.cancelClass || '') || !/ml-cancel/.test(look.cancelClass || '')) errors.push(`${tag}: cancelling isn't a .text-link.ml-cancel: ${look.cancelClass}`);
  if (look.cancelColor !== look.rubyInk) errors.push(`${tag}: the cancel link is ${look.cancelColor}, not ruby ink ${look.rubyInk}`);
  if (!/(0\.55\)|\/ 0\.55\))/.test(look.ghostRing || '')) errors.push(`${tag}: the ghost ring on cream isn't ink at 55%: ${look.ghostRing}`);
  if (look.titleSize !== look.lg) errors.push(`${tag}: ticket title ${look.titleSize}, want --text-lg ${look.lg}`);
  const cancel = page.locator('.ml-ticket [data-cancel]').first();
  await openRow(page, '[data-cancel]');
  await cancel.click();
  await page.waitForSelector('[data-cancel-dialog][open]');
  await page.locator('[data-cancel-dialog] [data-dialog-close]').last().click();
  await page.waitForTimeout(200);

  // 10. A place held for an online payment: Home says so with the payment link (the demo's stand-in pays it), and so
  // does its ticket
  await view(page, 'home');
  const hold = flat(await page.locator('[data-home-hold]').innerText().catch(() => ''));
  console.log(tag, 'held:', hold);
  if (!/Waiting for payment/.test(hold) || !/Pay \$\d+ online/.test(hold) || !/holding your spot until/.test(hold)) errors.push(`${tag}: Home's held place: "${hold}"`);
  await shot(page, `${PREFIX}-held-${size}`);
  const heldTicket = await page.evaluate(() => {
    const t = [...document.querySelectorAll('[data-panel="joins"] .ml-ticket')].find((x) => /Waiting for payment/.test(x.textContent));
    return t ? t.querySelector('.ml-pay')?.textContent.trim() : '';
  });
  if (!/Pay \$\d+ online/.test(heldTicket || '')) errors.push(`${tag}: the held sign-up's ticket has no payment link (${heldTicket})`);
  await page.locator('[data-home-hold] [data-demo-pay]').first().click();
  await page.waitForSelector('[data-notice]:not([hidden])');
  await page.waitForTimeout(300);
  if (await page.locator('[data-home-hold]').isVisible()) errors.push(`${tag}: still held after paying`);

  // 11. No dash before Gobgob, anywhere on the page
  const dashes = await page.evaluate(() => [...document.querySelectorAll('my-lair .gob-says__name')].map((n) => n.textContent).filter((x) => /[—–]/.test(x)));
  if (dashes.length) errors.push(`${tag}: a dash before Gobgob: ${dashes}`);
  await ctx.close();

  // 12. Logged out: the five views, in their own words
  const out = await open(size, '/pages/my-lair', { customer: null, label: 'out' });
  const list = flat(await out.page.locator('.ml-out__list').innerText());
  for (const name of ['Home', 'Bookings', 'Tab', 'Wallet', 'Me']) if (!new RegExp(`\\b${name}\\b`).test(list)) errors.push(`${out.tag}: "${name}" missing from: ${list}`);
  if (/[—–]/.test(await out.page.locator('.ml--out').innerText())) errors.push(`${out.tag}: a dash on the logged-out page`);
  await shot(out.page, `${PREFIX}-out-${size}`, { fullPage: true });
  await overflow(out.page, out.tag);
  await out.ctx.close();
}
report(PREFIX);
await stop();

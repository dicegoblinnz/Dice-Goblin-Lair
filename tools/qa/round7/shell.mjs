// Round 7, shell: on the mock store in demo mode, sections wrapped the way Shopify wraps them, phone (390) and desktop
// (1280), plus the wordmark at 320. PASS/FAIL lines; exits 1 if anything fails.
//   1. Header: no announcement bar; the header's section wrapper sticks on eight pages while scrolling (home, a
//      collection, a product, My Lair, the booking page, TTRPG sessions, the calendar, the staff page) and
//      --sticky-top is its height; anchor jumps and the pages' sticky bars sit under it; the menu drawer, search and
//      cart open above it, keep the focus and lock the page; Library sits below Events in the menu.
//   2. The wordmark: its own shape, crisp, legible and fitting beside the four buttons at 320, 390 and 1280.
//   3. Gobgob: sized (240x224, alt ""), small, lazy below the fold; beside the quips, the empty states, the 404, the
//      footer and the TTRPG regular's confirmation.
//   4. The home hero: Book a table, Shop new arrivals and Join our Discord the same size and weight; Discord the full
//      width on phones; its link and the side menu's Discord button kept.
//   5. The shop: sold-out products absent (rail, collections, chips, search, predictive search), library copies present
//      (a sold-out one too), no Availability filter but Price and Brand kept, the in-stock filter on every collection
//      link and form, counts that match.
//   6. The postal cutoff: Wednesday 10pm for Thursday delivery.
//   7. Words never show &#39;, &amp; or &quot; (the mock's t escapes like Shopify's).
//   8. Mobile numbers: the booking, TTRPG join (guest, member, every week) and event sign-up and game table forms (the
//      field, missing, a landline, an overseas number, a good one, pre-fill from the shop account and from the saved
//      mobile, never over what's typed) and the demo's rule (staff walk-ins exempt, saved to the member).
//   9. Recurring events: tags on the calendar's cards, the month's regulars once each, what's on and the home page
//      collapsed, skip dates and Repeat until respected, the three tag shapes.
// Usage: DG_THEME=/path/to/theme PORT=4815 node tools/qa/round7/shell.mjs [phone|desktop]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const ev = await import(new URL('../theme-mock/events-mock.mjs', import.meta.url).href);
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || process.env.QA_PORT || 4815);
const BASE = `http://localhost:${PORT}`;
const ONLY = process.argv[2] || '';
const SIZES = [['phone', 390, 844], ['desktop', 1280, 800]].filter(([tag]) => !ONLY || tag === ONLY);
const MISSING = 'Add a mobile number so we can reach you on the day.';
const WRONG = "That mobile number doesn't look right. Try one like 021 123 4567.";
const HINT = 'So we can reach you on the day.';
const DISCORD = m.globalSettings.social_discord;
const RUBY = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [], orders_count: 0, orders: [] };
const HEMI = { id: 7700445566, first_name: 'Hemi', last_name: 'Walker', name: 'Hemi Walker', email: 'hemi.walker@example.com', phone: '021 777 8888', tags: [], orders_count: 0, orders: [] };

/* ---------- dates in Lair time, and the two extra events (a fortnightly with Repeat until, a monthly with a skip date) ---------- */
const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dow = (key) => new Date(`${key}T12:00:00Z`).getUTCDay();
const today = lairKey(Date.now());
const nextDow = (d, from = addDays(today, 1)) => { let k = from; while (dow(k) !== d) k = addDays(k, 1); return k; };
const thirdSaturday = (y, mo) => { let k = `${y}-${String(mo).padStart(2, '0')}-01`; while (dow(k) !== 6) k = addDays(k, 1); return addDays(k, 14); };
const offset = (key) => { const o = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', timeZoneName: 'longOffset' }).formatToParts(new Date(`${key}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', ''); return o || '+00:00'; };
const iso = (key, hm) => `${key}T${hm}:00${offset(key)}`;
const SHORT = (key) => `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow(key)]} ${Number(key.slice(8))} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(key.slice(5, 7)) - 1]}`;
// fortnightly Thursdays 6:30pm: the next Thursday is on, the one a fortnight later is after Repeat until
const T1 = nextDow(4);
const fortnight = { handle: 'kill-team-fortnight', title: 'Kill Team fortnight', event_type: 'wargame', starts_at: iso(addDays(T1, -14), '18:30'), ends_at: iso(addDays(T1, -14), '21:30'), repeat: 'fortnightly', repeat_until: addDays(T1, 13), image_slug: 'warhammer', game: 'Warhammer', description: 'Kill Team every second Thursday.' };
// monthly third Saturday 11am: the next one is skipped, so the one after is next
const [ty, tm] = today.split('-').map(Number);
const months = [[ty, tm], [tm === 12 ? ty + 1 : ty, tm === 12 ? 1 : tm + 1], [tm >= 11 ? ty + 1 : ty, ((tm + 1) % 12) + 1], [tm >= 10 ? ty + 1 : ty, ((tm + 2) % 12) + 1]];
const thirds = months.map(([y, mo]) => thirdSaturday(y, mo)).filter((k) => k > today);
const [S1, S2] = thirds;
const monthly = { handle: 'oddity-alley-qa', title: 'Oddity Alley market', event_type: 'market', starts_at: '', ends_at: '', repeat: 'monthly', skip_dates: [S1], image_slug: 'market', game: '', description: 'The in-store market.' };
// the monthly event's first date is the third Saturday of this month (or last month's when this month's hasn't come)
{
  const first = thirdSaturday(...months[0]) <= today ? thirdSaturday(...months[0]) : thirdSaturday(tm === 1 ? ty - 1 : ty, tm === 1 ? 12 : tm - 1);
  monthly.starts_at = iso(first, '11:00');
  monthly.ends_at = iso(first, '16:00');
}
ev.extraEvents.push(fortnight, monthly);

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' && detail !== undefined ? ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const server = await m.serve(PORT);
const browser = await chromium.launch();
async function open(width, url, { customer = null, height = 844, scale = 1, ctx = null } = {}) {
  m.mockState.customer = customer;
  const phone = width < 700;
  const context = ctx || (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, isMobile: phone, hasTouch: phone }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(`console: ${msg.text()}`); });
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return { ctx: context, page, errors, own: !ctx };
}
const done = async (o) => { if (o.own) await o.ctx.close(); else await o.page.close(); };
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

try {
  for (const [tag, width, height] of SIZES) {
    /* ---------- 1. the header ---------- */
    const PAGES = ['/', '/collections/new-additions', '/products/wingspan', '/pages/my-lair', '/pages/book-a-table', '/pages/gm-games', '/pages/events-calendar', '/pages/lair-staff'];
    for (const url of PAGES) {
      const o = await open(width, url, { height });
      const r = await o.page.evaluate(async () => {
        const header = document.querySelector('.site-header');
        const wrap = header.closest('.shopify-section');
        const main = document.querySelector('main');
        // a page too short to scroll gets room to, so the header's stickiness shows on every page
        main.insertAdjacentHTML('beforeend', '<div data-qa-spacer style="height:3000px"></div>');
        const before = { top: Math.round(wrap.getBoundingClientRect().top) };
        window.scrollTo(0, 1600);
        await new Promise((res) => setTimeout(res, 300));
        const b = wrap.getBoundingClientRect();
        const hit = document.elementFromPoint(window.innerWidth / 2, 4);
        const sticky = getComputedStyle(document.documentElement).getPropertyValue('--sticky-top').trim();
        return {
          announcement: document.querySelectorAll('.announcement, [data-announcement]').length,
          wrapId: wrap.id, wrapClass: wrap.className, position: getComputedStyle(wrap).position,
          templateWrapped: [...main.children].filter((c) => c.classList.contains('shopify-section') && /^shopify-section-template--/.test(c.id)).length,
          scrollY: Math.round(window.scrollY), top: Math.round(b.top), height: b.height, hitHeader: Boolean(hit && hit.closest('.site-header')), sticky, before,
        };
      });
      check(`${tag} ${url}: no announcement bar`, r.announcement === 0, r.announcement);
      check(`${tag} ${url}: sections wrapped as on Shopify (header group class, schema class, template ids)`, /^shopify-section-sections--\d+__header$/.test(r.wrapId) && /shopify-section-group-header-group/.test(r.wrapClass) && /section-header/.test(r.wrapClass) && r.templateWrapped >= 1, `${r.wrapId} "${r.wrapClass}", ${r.templateWrapped} template section(s)`);
      check(`${tag} ${url}: the header sticks while scrolling (1,600px down it's at the top, on top)`, r.position === 'sticky' && r.scrollY >= 1500 && Math.abs(r.top) <= 1 && r.hitHeader, `scrollY ${r.scrollY}, top ${r.top}, ${r.position}`);
      check(`${tag} ${url}: --sticky-top is the header's height`, r.sticky === `${Math.floor(r.height)}px`, `${r.sticky} vs ${r.height}`);
      check(`${tag} ${url}: no console errors, no sideways scroll`, o.errors.length === 0 && (await overflowX(o.page)) === 0, o.errors.slice(0, 2).join(' / '));
      await done(o);
    }
    {
      // anchor jumps land under the header, not behind it
      const o = await open(width, '/#contact', { height });
      await o.page.waitForTimeout(300);
      const a = await o.page.evaluate(() => {
        const header = document.querySelector('.site-header').closest('.shopify-section').getBoundingClientRect();
        const target = document.querySelector('#contact');
        target.scrollIntoView();
        return { headerBottom: Math.round(header.bottom), top: Math.round(target.getBoundingClientRect().top), pad: getComputedStyle(document.documentElement).scrollPaddingTop };
      });
      check(`${tag} anchor jump: #contact lands just under the header (1rem below it)`, a.top >= a.headerBottom && a.top - a.headerBottom <= 18, a);
      await done(o);
    }
    if (width >= 1000) {
      // the pages' own sticky bars sit under the header: the filters, the booking map
      for (const [url, sel] of [['/collections/new-additions', '.facets-panel'], ['/pages/book-a-table', '.booking__map']]) {
        const o = await open(width, url, { height });
        await o.page.waitForTimeout(500);
        const s = await o.page.evaluate(async (sel) => {
          document.querySelector('main').insertAdjacentHTML('beforeend', '<div style="height:3000px"></div>');
          const el = document.querySelector(sel);
          if (!el) return null;
          window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY + 400);
          await new Promise((res) => setTimeout(res, 300));
          const header = document.querySelector('.site-header').closest('.shopify-section').getBoundingClientRect();
          return { top: Math.round(el.getBoundingClientRect().top), headerBottom: Math.round(header.bottom), position: getComputedStyle(el).position };
        }, sel);
        check(`${tag} ${url}: ${sel} sticks under the header, not behind it`, Boolean(s) && s.position === 'sticky' && s.top >= s.headerBottom && s.top - s.headerBottom <= 20, s);
        await done(o);
      }
    } else {
      // the calendar's day strip sits right under the header
      const o = await open(width, '/pages/events-calendar', { height });
      await o.page.waitForSelector('lair-calendar .cal-strip', { timeout: 15000 }).catch(() => {});
      const c = await o.page.evaluate(async () => {
        const strip = document.querySelector('lair-calendar .cal-strip');
        if (!strip) return null;
        const startTop = strip.getBoundingClientRect().top + window.scrollY;
        const room = strip.parentElement.getBoundingClientRect().height - strip.offsetHeight;
        const headerH = document.querySelector('.site-header').getBoundingClientRect().bottom;
        window.scrollTo(0, startTop - headerH + Math.max(5, Math.min(60, room - 5)));
        await new Promise((res) => setTimeout(res, 400));
        const header = document.querySelector('.site-header').closest('.shopify-section').getBoundingClientRect();
        return { position: getComputedStyle(strip).position, top: Math.round(strip.getBoundingClientRect().top), headerBottom: Math.round(header.bottom), headerTop: Math.round(header.top) };
      });
      check(`${tag} calendar: the day strip sticks right under the header`, Boolean(c) && c.position === 'sticky' && Math.abs(c.top - c.headerBottom) <= 1 && c.headerTop === 0, c);
      await done(o);
    }
    {
      // the menu drawer (phone), search and the cart drawer open above the sticky header, keep focus, lock the page
      const o = await open(width, '/', { height });
      await o.page.evaluate(() => window.scrollTo(0, 600));
      await o.page.waitForTimeout(200);
      if (width < 1100) {
        await o.page.click('.site-header__menu-toggle');
        await o.page.waitForTimeout(450);
        const d = await o.page.evaluate(() => {
          const dlg = document.querySelector('#menu-drawer');
          const r = dlg.getBoundingClientRect();
          const hit = document.elementFromPoint(Math.min(r.right - 10, 40), 20);
          const locked = document.body.classList.contains('has-open-dialog') && getComputedStyle(document.body).overflow === 'hidden';
          return { open: dlg.open, modal: dlg.matches(':modal'), focusIn: dlg.contains(document.activeElement), onTop: Boolean(hit && hit.closest('#menu-drawer')), locked, logo: Boolean(dlg.querySelector('img.site-header__logo-img[src*="dg-wordmark"]')) };
        });
        check(`${tag} menu drawer: opens above the header (modal, focus inside, page locked), with the wordmark`, d.open && d.modal && d.focusIn && d.onTop && d.locked && d.logo, d);
        await o.page.keyboard.press('Escape');
        await o.page.waitForTimeout(450);
        const back = await o.page.evaluate(() => ({ open: document.querySelector('#menu-drawer').open, focus: document.activeElement.classList.contains('site-header__menu-toggle') }));
        check(`${tag} menu drawer: Escape closes it and the focus goes back to the menu button`, !back.open && back.focus, back);
        const order = await o.page.evaluate(() => [...document.querySelectorAll('#menu-drawer .menu-drawer__list > li')].map((li) => (li.querySelector('summary') || li.querySelector('a')).textContent.trim()));
        check(`${tag} menu: Library below Events`, order.indexOf('Library') === order.indexOf('Events') + 1, order.join(', '));
      } else {
        const order = await o.page.evaluate(() => [...document.querySelectorAll('.site-nav__list > li')].map((li) => (li.querySelector('summary') || li.querySelector('a')).textContent.trim()));
        check(`${tag} menu: Library below (after) Events`, order.indexOf('Library') === order.indexOf('Events') + 1, order.join(', '));
      }
      await o.page.click('[data-dialog-open="search-modal"]');
      await o.page.waitForTimeout(450);
      const s = await o.page.evaluate(() => {
        const dlg = document.querySelector('#search-modal');
        const r = dlg.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
        return { open: dlg.open, modal: dlg.matches(':modal'), focusIn: dlg.contains(document.activeElement), onTop: Boolean(hit && hit.closest('#search-modal')) };
      });
      check(`${tag} search: opens above the header, the focus inside it`, s.open && s.modal && s.focusIn && s.onTop, s);
      await o.page.keyboard.press('Escape');
      await o.page.waitForTimeout(400);
      await o.page.click('.site-header [data-cart-open]');
      await o.page.waitForTimeout(500);
      const c = await o.page.evaluate(() => {
        const dlg = document.querySelector('#cart-drawer');
        if (!dlg) return null;
        const r = dlg.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, 20);
        return { open: dlg.open, modal: dlg.matches(':modal'), focusIn: dlg.contains(document.activeElement), onTop: Boolean(hit && hit.closest('#cart-drawer')), gob: Boolean(dlg.querySelector('.gob-moment img.gobgob')) };
      });
      check(`${tag} cart drawer: opens above the header, focus inside; the empty cart has Gobgob`, Boolean(c) && c.open && c.modal && c.focusIn && c.onTop && c.gob, c);
      await done(o);
    }

    /* ---------- 2. the wordmark ---------- */
    for (const [w, scale, minH] of width < 700 ? [[320, 2, 18], [390, 2, 26], [390, 3, 26]] : [[1280, 1, 36], [1280, 2, 36], [1100, 1, 36]]) {
      const o = await open(w, '/', { height, scale });
      const l = await o.page.evaluate(() => {
        const img = document.querySelector('.site-header .site-header__logo-img');
        const b = img.getBoundingClientRect();
        const header = document.querySelector('.site-header');
        const after = [...header.querySelectorAll('.site-nav, .site-header__actions')].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.getBoundingClientRect().left);
        const file = img.currentSrc.split('/').pop().split('?')[0];
        return {
          file, w: b.width, h: b.height, attrs: [img.getAttribute('width'), img.getAttribute('height'), img.getAttribute('loading'), img.getAttribute('alt')],
          srcset: img.getAttribute('srcset') || '', right: b.right, nextLeft: Math.min(...after), headerH: header.getBoundingClientRect().height, dpr: window.devicePixelRatio,
          linkH: img.closest('a').getBoundingClientRect().height,
        };
      });
      const px = /960/.test(l.file) ? 960 : /480/.test(l.file) ? 480 : 0;
      check(`wordmark at ${w}px x${scale}: the theme's wordmark, 480x90, eager, alt the shop's name, 480/960 srcset`, /dg-wordmark-(480|960)\.png/.test(l.file) && l.attrs[0] === '480' && l.attrs[1] === '90' && l.attrs[2] === 'eager' && l.attrs[3] === 'Dice Goblin NZ' && /480w/.test(l.srcset) && /960w/.test(l.srcset), l.attrs.concat(l.file).join(' '));
      check(`wordmark at ${w}px x${scale}: its own shape, crisp and legible (${minH}px+ tall)`, Math.abs(l.w / l.h - 480 / 90) < 0.12 && px >= l.w * l.dpr - 1 && l.h >= minH, `${Math.round(l.w)}x${Math.round(l.h)} from ${px}px wide at x${l.dpr}`);
      check(`wordmark at ${w}px x${scale}: fits beside the menu and buttons, one row`, l.right <= l.nextLeft + 0.5 && l.headerH <= 80 && (await overflowX(o.page)) === 0, `logo right ${Math.round(l.right)}, next ${Math.round(l.nextLeft)}, header ${Math.round(l.headerH)}px`);
      check(`wordmark at ${w}px x${scale}: its home link is a 44px tap target`, l.linkH >= 44, `${Math.round(l.linkH)}px tall`);
      await done(o);
    }

    /* ---------- 3. Gobgob ---------- */
    for (const [url, where, lazy] of [['/pages/book-a-table', '.page-intro__gob', false], ['/404', '.not-found__art', false], ['/', '.site-footer__signoff', true], ['/search?q=zzqq&options%5Bunavailable_products%5D=hide', '.search-page .gob-moment', true], ['/collections/new-additions?filter.v.availability=1&filter.p.vendor=Nobody', '.collection .gob-moment', true]]) {
      const o = await open(width, url, { height });
      const g = await o.page.evaluate((where) => {
        const img = document.querySelector(`${where} img.gobgob`);
        if (!img) return null;
        const b = img.getBoundingClientRect();
        return { w: b.width, h: b.height, attrs: [img.getAttribute('width'), img.getAttribute('height'), img.getAttribute('alt'), img.getAttribute('loading')], srcset: img.getAttribute('srcset') || '' };
      }, where);
      check(`${tag} Gobgob ${url.split('?')[0]} (${where}): 240x224, alt "", ${lazy ? 'lazy' : 'eager at the top'}, small, its own shape`, Boolean(g) && g.attrs[0] === '240' && g.attrs[1] === '224' && g.attrs[2] === '' && g.attrs[3] === (lazy ? 'lazy' : 'eager') && /gobgob-240\.png 240w/.test(g.srcset) && g.w <= 130 && Math.abs(g.w / g.h - 240 / 224) < 0.06, g);
      await done(o);
    }

    /* ---------- 4. the hero's three buttons ---------- */
    {
      const o = await open(width, '/', { height });
      const h = await o.page.evaluate(() => {
        const list = document.querySelector('.hero__actions');
        const items = [...list.querySelectorAll('.signpost')].map((a) => { const b = a.getBoundingClientRect(); const cs = getComputedStyle(a); return { text: a.textContent.replace(/\s+/g, ' ').trim(), w: b.width, h: b.height, top: b.top, size: cs.fontSize, weight: cs.fontWeight }; });
        const d = list.querySelector('.hero__discord');
        return { items, listW: list.getBoundingClientRect().width, href: d && d.getAttribute('href'), target: d && d.getAttribute('target'), drawer: document.querySelectorAll('#menu-drawer .menu-drawer__discord').length };
      });
      const [a, b, c] = h.items;
      check(`${tag} hero: three buttons, Join our Discord third`, h.items.length === 3 && /^Join our Discord/.test(c.text), h.items.map((i) => i.text).join(' | '));
      check(`${tag} hero: the three the same height, type size and weight`, h.items.every((i) => Math.abs(i.h - a.h) < 1 && i.size === a.size && i.weight === a.weight), h.items.map((i) => `${Math.round(i.h)}px ${i.size} ${i.weight}`).join(', '));
      if (width < 700) check(`${tag} hero: Join our Discord the full width under the pair`, Math.abs(c.w - h.listW) < 1 && c.top > a.top, `${Math.round(c.w)} of ${Math.round(h.listW)}`);
      else check(`${tag} hero: all three on one row, Discord as wide as the others near enough`, Math.abs(c.top - a.top) < 1 && Math.abs(c.top - b.top) < 1 && c.w >= Math.min(a.w, b.w) - 12, h.items.map((i) => Math.round(i.w)).join(', '));
      check(`${tag} hero: Discord keeps its invite link (new tab), and the side menu keeps its Discord button`, h.href === DISCORD && h.target === '_blank' && h.drawer === 1, `${h.href} ${h.target}, drawer ${h.drawer}`);
      await done(o);
    }

    /* ---------- 5. the shop ---------- */
    const SOLD = ['Ark Nova', 'Dice tower: Dragon keep', 'Mega Charizard', 'Sushi Go'];
    const cards = (page) => page.evaluate(() => [...document.querySelectorAll('.product-grid > li, .rail > li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
    {
      const o = await open(width, '/', { height });
      const list = await cards(o.page);
      check(`${tag} home rail: 12 products, none sold out (the rail fills from the next ones)`, list.length === 12 && !list.some((t) => SOLD.some((s) => t.includes(s))), `${list.length}: ${list.filter((t) => SOLD.some((s) => t.includes(s))).join(', ')}`);
      const links = await o.page.evaluate(() => [...document.querySelectorAll('.site-header a[href*="/collections/"], #menu-drawer a[href*="/collections/"], .site-footer a[href*="/collections/"], .hero a[href*="/collections/"], .product-rail a[href*="/collections/"]')].map((a) => a.getAttribute('href')));
      const plain = links.filter((h) => !/filter\.v\.availability=1/.test(h) && !/board-game-rental|\/products\//.test(h));
      check(`${tag} home: every shop collection link keeps the in-stock filter on (menu, side menu, footer, hero, rail)`, links.length >= 10 && plain.length === 0, plain.slice(0, 4).join(' ') || `${links.length} links`);
      const forms = await o.page.evaluate(() => [...document.querySelectorAll('form[action="/search"]')].map((f) => Boolean(f.querySelector('input[name="options[unavailable_products]"][value="hide"]'))));
      check(`${tag} home: the search forms ask Shopify to hide sold-out products`, forms.length >= 1 && forms.every(Boolean), forms);
      await done(o);
    }
    for (const url of ['/collections/new-additions', '/collections/new-additions?filter.v.availability=1', '/collections/trading-card-games', '/collections/board-game']) {
      const o = await open(width, url, { height });
      const list = await cards(o.page);
      const f = await o.page.evaluate(() => ({
        labels: [...document.querySelectorAll('.facet__summary > span')].map((s) => s.textContent.replace(/\(\d+\)/, '').trim()),
        hidden: [...document.querySelectorAll('[data-facets-form] input[type="hidden"]')].map((i) => `${i.name}=${i.value}`),
        count: (document.querySelector('.collection__toolbar [role="status"]')?.textContent || '').trim(),
        chips: [...document.querySelectorAll('.tag-chip[href]')].map((a) => a.getAttribute('href')),
        activeAvail: [...document.querySelectorAll('.filter-chip')].filter((a) => /availability/.test(a.getAttribute('href') || '') && !/filter\.v\.availability=1/.test(a.getAttribute('href') || '')).length,
      }));
      check(`${tag} ${url}: no sold-out products`, list.length > 0 && !list.some((t) => SOLD.some((s) => t.includes(s))), `${list.length} cards`);
      check(`${tag} ${url}: no Availability filter; Price and Brand stay; the in-stock filter rides along hidden`, !f.labels.includes('Availability') && f.labels.includes('Price') && f.labels.includes('Brand') && f.hidden.includes('filter.v.availability=1'), `${f.labels.join(', ')} | ${f.hidden.join(' ')}`);
      check(`${tag} ${url}: "N products" counts what shows`, f.count.startsWith(`${list.length} product`), `${f.count} for ${list.length} cards`);
      if (f.chips.length) check(`${tag} ${url}: the chips keep the in-stock filter on`, f.chips.every((h) => /filter\.v\.availability=1/.test(h)), f.chips.slice(0, 2).join(' '));
      await done(o);
    }
    {
      // library copies are never hidden, a sold-out one included; the library page has no in-stock filter
      const jenga = m.allProducts.jenga;
      const was = [jenga.available, jenga.variants[0].available];
      jenga.available = false;
      jenga.variants[0].available = false;
      const o = await open(width, '/collections/board-game-rental', { height });
      const list = await cards(o.page);
      const plain = await o.page.evaluate(() => [...document.querySelectorAll('.tag-chip[href]')].every((a) => !/availability/.test(a.getAttribute('href'))));
      check(`${tag} library page: every library copy shows, a sold-out one too, and its chips carry no in-stock filter`, list.length === 11 && list.some((t) => /Jenga/.test(t)) && plain, `${list.length} cards`);
      // an old search link without the option: the theme skips sold-out shop products, but never a library copy
      const s = await open(width, '/search?q=a', { height, ctx: o.ctx });
      const found = await cards(s.page);
      check(`${tag} search from an old link: sold-out shop products skipped, the sold-out library copy kept`, found.length > 0 && !found.some((t) => SOLD.some((x) => t.includes(x))) && found.some((t) => /Jenga/.test(t)), `${found.length} results`);
      await done(s);
      [jenga.available, jenga.variants[0].available] = was;
      await done(o);
    }
    {
      const o = await open(width, '/search?q=ark&options%5Bunavailable_products%5D=hide', { height });
      const list = await cards(o.page);
      check(`${tag} search: a sold-out product isn't found`, !list.some((t) => /Ark Nova/.test(t)), list.join(' | ').slice(0, 120));
      await o.page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      await o.page.click('[data-dialog-open="search-modal"]');
      await o.page.fill('#header-search-input', 'ark');
      await o.page.waitForTimeout(900);
      const p1 = await o.page.evaluate(() => ({ text: document.querySelector('#predictive-results').textContent.replace(/\s+/g, ' ').trim(), gob: Boolean(document.querySelector('#predictive-results .predictive__empty img.gobgob')), all: document.querySelector('#predictive-results a.text-link')?.getAttribute('href') || '' }));
      check(`${tag} predictive search: a sold-out product isn't suggested (nothing found, with Gobgob), and See all keeps hide`, !/Ark Nova/.test(p1.text) && p1.gob && /unavailable_products%5D=hide/.test(p1.all), p1);
      await o.page.fill('#header-search-input', 'pok');
      await o.page.waitForTimeout(900);
      const p2 = await o.page.evaluate(() => [...document.querySelectorAll('#predictive-results .predictive__title')].map((e) => e.textContent.trim()));
      check(`${tag} predictive search: Pokémon shows what can be bought, not the sold-out UPC`, p2.length >= 1 && !p2.some((t) => /Charizard/.test(t)), p2.join(', '));
      await done(o);
    }

    /* ---------- 6. the postal cutoff ---------- */
    for (const url of ['/pages/board-game-rental', '/products/board-game-rental-monthly', '/products/library']) {
      const o = await open(width, url, { height });
      const text = flat(await o.page.evaluate(() => document.querySelector('main').textContent));
      check(`${tag} ${url}: "The cutoff is Wednesday 10pm for Thursday delivery", no 10am Thursday`, /The cutoff is Wednesday 10pm for Thursday delivery/.test(text) && !/10am Thursday/.test(text));
      await done(o);
    }

    /* ---------- 7. no escaped words on the shell's pages ---------- */
    for (const url of ['/', '/collections/new-additions', '/search?q=zzqq', '/pages/book-a-table', '/pages/gm-games', '/pages/events-calendar', '/404', '/products/wingspan', '/cart-open', '/pages/contact']) {
      const o = await open(width, url, { height });
      await o.page.waitForTimeout(600);
      const bad = await o.page.evaluate(() => {
        const text = document.body.innerText;
        const labels = [...document.querySelectorAll('[aria-label], [placeholder], [title]')].map((el) => `${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('title') || ''}`).join(' ');
        return [text, labels].join(' ').match(/&(#39|amp|quot|#x27|lt|gt);/g) || [];
      });
      check(`${tag} ${url}: no &#39;, &amp; or &quot; in what people read`, bad.length === 0, bad.slice(0, 3).join(' '));
      await done(o);
    }
    {
      // the membership's terms tick (escaped twice before round 7), theme.js's words and decodeText
      const o = await open(width, '/products/board-game-rental-monthly', { height });
      const btn = o.page.locator('product-form [type="submit"]:visible').first();
      let message = '';
      if (await btn.count()) {
        await btn.click();
        await o.page.waitForTimeout(300);
        message = flat(await o.page.evaluate(() => [...document.querySelectorAll('[data-form-error]')].map((e) => e.textContent).join(' ')));
      }
      check(`${tag} membership: the terms tick's message reads "you've", not "you&#39;ve"`, /you've read the library terms/.test(message) && !/&#39;/.test(message), message);
      await done(o);
      const b = await open(width, '/pages/book-a-table', { height });
      const d = await b.page.evaluate(() => ({ raw: JSON.parse(document.getElementById('theme-config').textContent).strings.addError, decoded: window.Lair.decodeText('We&#39;re &amp; &quot;you&quot; &lt;3') }));
      check(`${tag} words: Shopify-escaped words arrive escaped (the mock's t), and window.Lair.decodeText decodes the five`, /&#39;/.test(d.raw) && d.decoded === 'We\'re & "you" <3', d);
      await done(b);
    }

    /* ---------- 8. mobile numbers ---------- */
    const fieldOk = (f) => f && f.label === 'Mobile' && f.type === 'tel' && f.inputmode === 'tel' && f.autocomplete === 'tel' && f.required && f.hint === HINT;
    const fieldOf = (page, sel) => page.evaluate((sel) => {
      const input = document.querySelector(sel);
      if (!input) return null;
      const field = input.closest('.field');
      const label = input.labels && input.labels[0] ? input.labels[0] : field.querySelector('.field__label');
      return {
        label: (label.querySelector('.field__label') || label).textContent.trim(), type: input.type, inputmode: input.getAttribute('inputmode'), autocomplete: input.getAttribute('autocomplete'),
        required: input.required, hint: (field.querySelector('.field__hint') || {}).textContent, value: input.value, described: (input.getAttribute('aria-describedby') || '').split(' ').map((id) => document.getElementById(id)?.textContent || '').join(' '),
      };
    }, sel);
    {
      // the table booking, logged out: missing, a landline, then an overseas number books it
      const o = await open(width, '/pages/book-a-table', { height });
      const p = o.page;
      await p.waitForSelector('[data-dates] [data-day]');
      const day = await p.$$eval('[data-dates] [data-day]', (els) => els.map((e) => e.dataset.day)[1]);
      await p.click(`[data-dates] [data-day="${day}"]`);
      await p.waitForTimeout(250);
      const slot = await p.$$eval('[data-slot]', (els) => els.filter((e) => !e.disabled).map((e) => e.dataset.slot)[2]);
      await p.click(`[data-slot="${slot}"]`);
      await p.waitForTimeout(250);
      check(`${tag} booking: one Mobile field (tel, required, autocomplete tel) with the hint`, fieldOk(await fieldOf(p, '#bk-phone')), await fieldOf(p, '#bk-phone'));
      await p.fill('#bk-name', 'Moana Test');
      await p.fill('#bk-email', 'moana.test@example.com');
      const count = () => p.evaluate(() => window.Lair.store.backend.state.bookings.length);
      const before = await count();
      await p.click('[data-submit]');
      await p.waitForTimeout(400);
      const e1 = flat(await p.textContent('[data-field-error="phone"]'));
      const box = flat(await p.textContent('[data-problems]'));
      check(`${tag} booking: no mobile is stopped in the browser with the contract's message`, e1 === MISSING && box.includes(MISSING) && (await count()) === before, e1);
      await p.fill('#bk-phone', '09 123 4567');
      await p.click('[data-submit]');
      await p.waitForTimeout(300);
      check(`${tag} booking: a landline is refused`, flat(await p.textContent('[data-field-error="phone"]')) === WRONG && (await count()) === before);
      await p.fill('#bk-phone', '+44 7700 900123');
      await p.click('[data-submit]');
      await p.waitForTimeout(700);
      const made = await p.evaluate(() => { const b = window.Lair.store.backend.state.bookings; return { shown: !document.querySelector('[data-done]').hidden, phone: b[b.length - 1].phone, name: b[b.length - 1].name }; });
      check(`${tag} booking: an overseas mobile books it, kept as typed`, made.shown && made.name === 'Moana Test' && made.phone === '+44 7700 900123', made);
      await done(o);
    }
    {
      // the demo's rule, straight: tables and seats need one, a staff walk-in doesn't
      const o = await open(width, '/pages/book-a-table', { height });
      const r = await o.page.evaluate(async ({ MISSING, WRONG }) => {
        const store = window.Lair.store;
        const out = {};
        const t = store.time;
        const day = t.addDays(t.today(), 3);
        const start = t.at(day, 18 * 60);
        const base = { kind: 'table', tables: ['T5'], room: store.roomOf('T5').id, start, end: start + 2 * 3600000, people: 2, extras: [], name: 'Rule Test', email: 'rule.test@example.com' };
        const tryIt = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return `${e.status} ${e.message}`; } };
        out.none = await tryIt(() => store.backend.createBooking({ ...base }));
        out.landline = await tryIt(() => store.backend.createBooking({ ...base, phone: '+64 9 123 4567' }));
        out.walkin = await tryIt(() => store.backend.createBooking({ kind: 'walkin', tables: ['T6'], room: store.roomOf('T6').id, start: Date.now(), end: Date.now() + 3600000, people: 2, name: 'Walk-in', staffOverride: true, amount: 2000 }));
        const ev = store.data.events.find((e) => e.capacity && e.startMs > Date.now());
        out.event = await tryIt(() => store.backend.joinEvent(ev.id, { name: 'Rule Test', email: 'rule.test@example.com', people: 1 }));
        out.eventWrong = await tryIt(() => store.backend.joinEvent(ev.id, { name: 'Rule Test', email: 'rule.test@example.com', people: 1, phone: '12345' }));
        const game = store.data.games.find((g) => g.status === 'open' && g.end > Date.now() && g.seats - g.taken >= 1);
        out.seat = await tryIt(() => store.backend.joinGame({ gameId: game.id, name: 'Rule Test', email: 'rule.two@example.com', people: 1, players: [{ name: 'Rule Test', character: '' }] }));
        return { out, MISSING, WRONG };
      }, { MISSING, WRONG });
      check(`${tag} demo: a table booking with no mobile is a 422 with the contract's words`, r.out.none === `422 ${MISSING}`, r.out.none);
      check(`${tag} demo: a +64 landline is a 422 "doesn't look right"`, r.out.landline === `422 ${WRONG}`, r.out.landline);
      check(`${tag} demo: a staff walk-in needs no mobile`, r.out.walkin === 'ok', r.out.walkin);
      check(`${tag} demo: event sign-ups and TTRPG seats need one too`, r.out.event === `422 ${MISSING}` && r.out.eventWrong === `422 ${WRONG}` && r.out.seat === `422 ${MISSING}`, r.out);
      await done(o);
    }
    {
      // a TTRPG seat as a guest: the field, missing, a landline, then a good one joins
      const o = await open(width, '/pages/gm-games', { height });
      const p = o.page;
      await p.waitForTimeout(500);
      const id = await p.evaluate(() => (window.Lair.store.data.games.find((g) => g.status === 'open' && g.end > Date.now() && g.seats - g.taken >= 2 && !g.seriesId) || window.Lair.store.data.games.find((g) => g.status === 'open' && g.end > Date.now() && g.seats - g.taken >= 2) || {}).id);
      await p.click(`.gm-card__link[data-game="${id}"]`);
      await p.waitForSelector('[data-sheet][open]');
      await p.click('[data-sheet-foot] [data-join]:not([data-every])');
      await p.waitForSelector('[data-session-join]');
      const f = await fieldOf(p, '[data-session-join] [name="phone"]');
      check(`${tag} TTRPG guest: one Mobile field (tel, required) with the hint, read with it`, fieldOk(f) && f.described.includes(HINT), f);
      await p.fill('[data-session-join] [name="name"]', 'Kahu Guest');
      await p.fill('[data-session-join] [name="email"]', 'kahu.guest@example.com');
      await p.click('[data-join-submit]');
      await p.waitForTimeout(300);
      const err = () => p.evaluate(() => document.querySelector('[data-session-join] [name="phone"]').closest('.field').querySelector('.field__error')?.textContent.trim() || '');
      check(`${tag} TTRPG guest: no mobile stops it with the contract's words`, (await err()) === MISSING, await err());
      await p.fill('[data-session-join] [name="phone"]', '07 838 1234');
      await p.click('[data-join-submit]');
      await p.waitForTimeout(300);
      check(`${tag} TTRPG guest: a landline is refused`, (await err()) === WRONG, await err());
      await p.fill('[data-session-join] [name="phone"]', '022 123 4567');
      await p.click('[data-join-submit]');
      await p.waitForSelector('.gm-done', { timeout: 5000 }).catch(() => {});
      const seat = await p.evaluate(() => { const b = window.Lair.store.backend.state.bookings.filter((x) => x.kind === 'gm-seat'); const x = b[b.length - 1]; return { done: Boolean(document.querySelector('.gm-done')), name: x.name, phone: x.phone }; });
      check(`${tag} TTRPG guest: a good mobile joins, kept on the seat`, seat.done && seat.name === 'Kahu Guest' && seat.phone === '022 123 4567', seat);
      await done(o);
    }
    {
      // a member: the shop account's phone fills the booking; a new number is saved and fills the next forms;
      // "Save my seat every week" with Gobgob's confirmation; the calendar's sign-up and game table; never over typing
      const ctx = await browser.newContext({ viewport: { width, height }, isMobile: width < 700, hasTouch: width < 700 });
      const savedOf = (page) => page.evaluate((id) => (window.Lair.store.backend.state.members || []).find((x) => String(x.customerId) === String(id))?.mobile || '', HEMI.id);
      let o = await open(width, '/pages/book-a-table', { customer: HEMI, ctx });
      let p = o.page;
      await p.waitForSelector('[data-dates] [data-day]');
      await p.waitForTimeout(400);
      check(`${tag} member: the booking's Mobile starts with the shop account's phone`, (await p.inputValue('#bk-phone')) === '021 777 8888', await p.inputValue('#bk-phone'));
      const day = await p.$$eval('[data-dates] [data-day]', (els) => els.map((e) => e.dataset.day)[2]);
      await p.click(`[data-dates] [data-day="${day}"]`);
      await p.waitForTimeout(250);
      const slot = await p.$$eval('[data-slot]', (els) => els.filter((e) => !e.disabled).map((e) => e.dataset.slot)[1]);
      await p.click(`[data-slot="${slot}"]`);
      await p.waitForTimeout(250);
      await p.fill('#bk-phone', '027 123 4567');
      await p.click('[data-submit]');
      await p.waitForTimeout(700);
      check(`${tag} member: booking with a new mobile saves it to the member (member.mobile)`, (await savedOf(p)) === '027 123 4567', await savedOf(p));
      await done(o);
      o = await open(width, '/pages/book-a-table', { customer: HEMI, ctx });
      p = o.page;
      await p.waitForTimeout(600);
      check(`${tag} member: the saved mobile fills the booking form next time (over the shop account's)`, (await p.inputValue('#bk-phone')) === '027 123 4567', await p.inputValue('#bk-phone'));
      await p.fill('#bk-phone', '021 000 1111');
      await p.evaluate(() => document.querySelector('lair-booking').prefillMobile('029 999 9999'));
      check(`${tag} member: a saved mobile arriving late never replaces what they've typed`, (await p.inputValue('#bk-phone')) === '021 000 1111', await p.inputValue('#bk-phone'));
      await done(o);
      o = await open(width, '/pages/gm-games', { customer: HEMI, ctx });
      p = o.page;
      await p.waitForTimeout(600);
      const weekly = await p.evaluate(() => (window.Lair.store.data.games.find((g) => g.status === 'open' && g.end > Date.now() && g.seriesId && ((g.series && g.series.schedule) || g.schedule) === 'weekly' && g.seats - g.taken >= 1) || window.Lair.store.data.games.find((g) => g.status === 'open' && g.end > Date.now() && g.seriesId && g.seats - g.taken >= 1) || {}).id);
      if (weekly) {
        await p.click(`.gm-card__link[data-game="${weekly}"]`);
        await p.waitForSelector('[data-sheet][open]');
        await p.click('[data-sheet-foot] [data-join]');
        await p.waitForSelector('[data-session-join]');
        await p.waitForTimeout(400);
        const f = await fieldOf(p, '[data-session-join] [name="phone"]');
        check(`${tag} member TTRPG: the Mobile shows (not behind Change) with the saved mobile`, fieldOk(f) && f.value === '027 123 4567' && (await p.isVisible('[data-session-join] [name="phone"]')), f);
        const series = await p.$('[name="joinMode"][value="series"]');
        if (series) await p.check('[name="joinMode"][value="series"]', { force: true });
        await p.fill('[data-session-join] [name="phone"]', '');
        await p.click('[data-join-submit]');
        await p.waitForTimeout(300);
        const e = await p.evaluate(() => document.querySelector('[data-session-join] [name="phone"]').closest('.field').querySelector('.field__error')?.textContent.trim() || '');
        check(`${tag} member TTRPG every week: no mobile is stopped too`, e === MISSING, e);
        await p.fill('[data-session-join] [name="phone"]', '027 123 4567');
        await p.click('[data-join-submit]');
        await p.waitForSelector('.gm-done', { timeout: 5000 }).catch(() => {});
        const g = await p.evaluate(() => ({ done: Boolean(document.querySelector('.gm-done')), gob: Boolean(document.querySelector('.gm-done .gob-moment img.gobgob[alt=""][width="240"][height="224"][loading="lazy"]')), says: document.querySelector('.gm-done .gob-says')?.textContent || '' }));
        check(`${tag} member TTRPG every week: saved, and Gobgob says so in person`, g.done && g.gob && /Gobgob/.test(g.says), g);
      } else {
        check(`${tag} member TTRPG: a weekly session to join`, false, 'none open');
      }
      await done(o);
      // the calendar: a sign-up (a landline refused, an overseas number saved), then a game table filled with it
      o = await open(width, '/pages/events-calendar', { customer: HEMI, ctx });
      p = o.page;
      await p.waitForSelector('lair-calendar .cal-card', { timeout: 15000 });
      const ids = await p.evaluate(() => {
        const cal = document.querySelector('lair-calendar');
        const now = Date.now();
        const items = cal.all().filter((i) => i.kind === 'event' && i.start > now + 3600000);
        return { join: (items.find((i) => i.capacity && !i.gameTables && i.repeat) || {}).id, reserve: (items.find((i) => i.gameTables) || {}).id };
      });
      await p.goto('about:blank');
      await p.goto(`${BASE}/pages/events-calendar#event=${encodeURIComponent(ids.join)}`, { waitUntil: 'networkidle' });
      await p.waitForTimeout(700);
      await p.click(`[data-join="${ids.join}"]`);
      await p.waitForSelector('[data-join-form]');
      await p.waitForTimeout(300);
      const f = await fieldOf(p, '[data-join-form] [name="phone"]');
      check(`${tag} calendar sign-up: one Mobile field with the hint, filled with the saved mobile`, fieldOk(f) && f.value === '027 123 4567', f);
      await p.fill('[data-join-form] [name="phone"]', '+64 4 499 1234');
      await p.click('button[form="cal-join-form"]');
      await p.waitForTimeout(300);
      const e1 = await p.evaluate(() => document.querySelector('#cal-err-phone')?.textContent || '');
      check(`${tag} calendar sign-up: a landline is refused before sending`, e1 === WRONG, e1);
      await p.fill('[data-join-form] [name="phone"]', '+61 412 345 678');
      await p.click('button[form="cal-join-form"]');
      await p.waitForTimeout(900);
      const j = await p.evaluate(() => { const js = window.Lair.store.backend.state.joins || []; const x = js[js.length - 1]; return { phone: x && x.phone, occ: x && x.occurrenceId }; });
      check(`${tag} calendar sign-up: an overseas mobile joins that date (of a weekly event), saved to the member`, j.phone === '+61 412 345 678' && j.occ === ids.join && (await savedOf(p)) === '+61 412 345 678', { ...j, saved: await savedOf(p) });
      if (ids.reserve) {
        await p.goto('about:blank');
        await p.goto(`${BASE}/pages/events-calendar#event=${encodeURIComponent(ids.reserve)}`, { waitUntil: 'networkidle' });
        await p.waitForTimeout(700);
        await p.click(`[data-reserve="${ids.reserve}"]`);
        await p.waitForSelector('[data-reserve-form]');
        await p.waitForTimeout(400);
        const rf = await fieldOf(p, '[data-reserve-form] [name="phone"]');
        check(`${tag} calendar game table: the Mobile is filled with the newly saved mobile`, fieldOk(rf) && rf.value === '+61 412 345 678', rf);
        await p.fill('[data-reserve-form] [name="phone"]', '');
        await p.click('button[form="cal-reserve-form"]');
        await p.waitForTimeout(300);
        const e2 = await p.evaluate(() => document.querySelector('#cal-err-phone')?.textContent || '');
        check(`${tag} calendar game table: no mobile is stopped`, e2 === MISSING, e2);
      }
      // GET /me's profile.mobile (live, and the demo once mylair's profile lands) fills the forms
      await p.goto('about:blank');
      await p.goto(`${BASE}/pages/events-calendar#event=${encodeURIComponent(ids.join)}`, { waitUntil: 'networkidle' });
      await p.waitForTimeout(600);
      const prof = await p.evaluate(async (id) => {
        const cal = document.querySelector('lair-calendar');
        const backend = window.Lair.store.backend;
        const real = backend.me.bind(backend);
        backend.me = async () => ({ ...(await real()), profile: { mobile: '022 555 0000' } });
        await cal.loadMine({ redraw: false });
        backend.me = real;
        cal.openJoin ? cal.openJoin(id) : null;
        await new Promise((res) => setTimeout(res, 300));
        return document.querySelector('[data-join-form] [name="phone"]')?.value || cal.mobile;
      }, ids.join);
      check(`${tag} calendar: GET /me's profile.mobile fills the Mobile`, prof === '022 555 0000', prof);
      await done(o);
      await ctx.close();
    }

    /* ---------- 9. recurring events ---------- */
    {
      const o = await open(width, '/pages/events-calendar', { height });
      const p = o.page;
      await p.waitForSelector('lair-calendar .cal-card', { timeout: 15000 });
      const r = await p.evaluate(({ T1, S1, S2 }) => {
        const cal = document.querySelector('lair-calendar');
        const items = cal.all();
        const cards = [...document.querySelectorAll('.cal-col')].flatMap((col) => [...col.querySelectorAll('.cal-card')].map((card) => {
          const item = items.find((i) => i.id === card.dataset.item);
          return { day: col.dataset.day, repeat: item && item.kind === 'event' ? item.repeat : '', tag: card.querySelector('.cal-card__repeat')?.textContent.trim() || '' };
        }));
        const kt = items.filter((i) => i.handle === 'kill-team-fortnight').map((i) => i.date);
        const oa = items.filter((i) => i.handle === 'oddity-alley-qa').map((i) => i.date);
        const L = window.Lair;
        const tag = (repeat, iso) => L.repeatTag({ repeat, start: iso }, L.store.time);
        return {
          cards, kt, oa,
          tags: [tag('weekly', '2026-10-08T18:00:00+13:00'), tag('fortnightly', '2026-10-08T18:30:00+13:00'), tag('monthly', '2026-10-17T11:00:00+13:00'), tag('', '2026-10-17T11:00:00+13:00')],
          T1, S1, S2,
        };
      }, { T1, S1, S2 });
      const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
      const repeating = r.cards.filter((c) => c.repeat);
      check(`${tag} calendar week: each repeating event's card carries its tag, on its own day`, repeating.length >= 4 && repeating.every((c) => new RegExp(`^(Weekly|Fortnightly|Monthly) · .*${DAYS[dow(c.day)].slice(0, -1)}`).test(c.tag)) && r.cards.filter((c) => !c.repeat).every((c) => !c.tag), repeating.slice(0, 3).map((c) => `${c.day} ${c.tag}`).join(' | '));
      check('the tag, word for word: "Weekly · Thursdays 6pm", "Fortnightly · Thursdays 6:30pm", "Monthly · Third Saturday 11am", none for a one-off', JSON.stringify(r.tags) === JSON.stringify(['Weekly · Thursdays 6pm', 'Fortnightly · Thursdays 6:30pm', 'Monthly · Third Saturday 11am', '']), r.tags);
      check(`${tag} Repeat until: the fortnightly event stops at its last date`, r.kt.includes(T1) && !r.kt.some((d) => d > fortnight.repeat_until), r.kt.join(', '));
      check(`${tag} skip dates: the monthly event's skipped date isn't on the calendar`, !r.oa.includes(S1) && r.oa.includes(S2), r.oa.join(', '));
      // the month: the regulars once each, with their tag and next date
      const monthOf = (key) => key.slice(0, 7);
      await p.click('[data-view="month"]');
      await p.waitForTimeout(300);
      // move to the month of S2 so the monthly one is listed
      for (let i = 0; i < 3; i += 1) {
        const shown = await p.evaluate(() => document.querySelector('[data-title]').textContent);
        const want = new Date(`${S2}T12:00:00Z`).toLocaleString('en-NZ', { month: 'long', timeZone: 'UTC' });
        if (shown.startsWith(want)) break;
        await p.click('[data-step="1"]');
        await p.waitForTimeout(250);
      }
      const regs = await p.evaluate(() => [...document.querySelectorAll('.cal-regular')].map((b) => ({ id: b.dataset.item, title: b.querySelector('.cal-regular__title').textContent.trim(), tag: b.querySelector('.cal-regular__tag').textContent.trim(), next: b.querySelector('.cal-regular__next').textContent.trim() })));
      const keys = regs.map((x) => `${x.title}|${x.tag}`);
      const oddity = regs.find((x) => x.title === 'Oddity Alley market');
      check(`${tag} month view: the month's regulars listed once each, each with its tag and "Next: …"`, regs.length >= 4 && new Set(keys).size === keys.length && regs.every((x) => /^(Weekly|Fortnightly|Monthly) · /.test(x.tag) && /^Next: \w{3} \d{1,2} \w{3}$/.test(x.next)), keys.slice(0, 4).join(' / '));
      check(`${tag} month view: the monthly market reads "Monthly · Third Saturday 11am", next after the skipped date (${SHORT(S2)})`, Boolean(oddity) && oddity.tag === 'Monthly · Third Saturday 11am' && oddity.next === `Next: ${SHORT(S2)}` && oddity.id === `oddity-alley-qa@${S2}`, oddity);
      if (oddity) {
        await p.click(`.cal-regular[data-item="${oddity.id}"]`);
        await p.waitForTimeout(500);
        const sheet = await p.evaluate(() => ({ open: document.querySelector('lair-calendar dialog')?.open, text: (document.querySelector('[data-dialog-body]')?.textContent || '').replace(/\s+/g, ' ') }));
        check(`${tag} month view: a regular opens its next date, with its tag`, sheet.open && /Monthly · Third Saturday 11am/.test(sheet.text), sheet.text.slice(0, 120));
      }
      // what's on (the usual week, Liquid): one line each, tagged, with the next date
      const whats = await p.evaluate(() => [...document.querySelectorAll('.whats-on li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
      const wk = whats.find((l) => l.startsWith('Kill Team fortnight'));
      const od = whats.find((l) => l.startsWith('Oddity Alley market'));
      const warh = whats.filter((l) => l.startsWith('Warhammer'));
      check(`${tag} what's on: each repeating event once, "Weekly · Thursdays 6pm to 11pm … Next: …"`, warh.length === 1 && /: Weekly · Thursdays 6pm to 11pm/.test(warh[0]) && /Next: \w{3} \d{1,2} \w{3}$/.test(warh[0]), warh.join(' | '));
      check(`${tag} what's on: the fortnightly and monthly ones, next dates respecting Repeat until and the skip date`, Boolean(wk) && /Fortnightly · Thursdays 6:30pm to 9:30pm/.test(wk) && wk.endsWith(`Next: ${SHORT(T1)}`) && Boolean(od) && /Monthly · Third Saturday 11am to 4pm/.test(od) && od.endsWith(`Next: ${SHORT(S2)}`), `${wk} | ${od}`);
      await done(o);
      const h = await open(width, '/', { height });
      await h.page.waitForTimeout(1200);
      const glance = await h.page.evaluate(() => [...document.querySelectorAll('lair-glance[data-view="events"] .portal__link')].map((a) => ({ href: a.getAttribute('href'), title: a.querySelector('.portal__what')?.textContent.trim(), meta: a.querySelector('.portal__meta')?.textContent.trim() || '' })));
      const handles = glance.map((g) => decodeURIComponent(g.href.split('#event=')[1] || '').split('@')[0]);
      check(`${tag} home page: what's on shows each repeating event once, at its next date (linked), with its tag`, glance.length >= 1 && new Set(handles).size === handles.length && glance.filter((g) => /@/.test(g.href)).every((g) => /#event=.+%40\d{4}-\d{2}-\d{2}$|#event=.+@\d{4}-\d{2}-\d{2}$/.test(g.href)), glance.map((g) => `${g.title}: ${g.meta}`).join(' | '));
      await done(h);
    }
  }
} catch (error) {
  check('the run finished', false, error.stack || error.message);
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `\n${fails} FAIL` : '\nall PASS');
process.exit(fails ? 1 : 0);

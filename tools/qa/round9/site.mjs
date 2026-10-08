// Round 9, site: the shop pages Mo asked about on 9 Oct, on the mock store in demo mode, phone (390) and desktop (1280).
// PASS/FAIL lines; exits 1 if anything fails.
//   1. The hero says what's here: a short heading (the business, no Royal Oak), a strip of facts (30 tables, 26+
//      role-playing games, Pokémon, Warhammer, 500+ games) as blocks with every word a setting, each fact whole on one
//      line, the text under it without Royal Oak or the table price, and the three buttons kept.
//   2. Meet Gobgob, right after the hero: Gobgob's picture, a line of their own, who they are (they/them) and four
//      places people meet them, every word from the section's settings.
//   3. The footer: much shorter on both sizes, "Made by goblins who like dice and games." (a setting), the visit
//      details on one line (address to Google Maps, today's hours, phone, Hours and directions), no hours table or
//      directions paragraph; menus folded on phones (44px rows that open), columns from 750px.
//   4. "Royal Oak" only where it's the address or directions, on seven pages and in a collection's meta description.
//   5. Review cards open and close their quotes (aria-hidden marks in a blockquote); desktop rows are full.
//   6. The contact form's topics include the two new ones; the home page's Google reviews link shows once.
//   7. The product page's dropdown with pictures (Vallejo - Game Colour, 48 colours): the button with the colour and
//      its picture, a row per colour with a lazy, sized picture and Sold out where it is, opening (a sheet on phones),
//      the filter, the keys (arrows, Home and End, type-ahead, Enter, Escape), choosing (id, price, button, URL,
//      buy bar), the picture swapping without a word, a sold-out colour, a ?variant= link, Back, a product with two
//      options, and Add to cart sending the chosen colour.
//   8. With AXE=/path/to/axe.min.js: axe-core on the home page, the product page (dropdown closed and open) and the
//      contact page.
// Usage: DG_THEME=/path/to/theme PORT=4975 [AXE=/path/to/axe.min.js] node tools/qa/round9/site.mjs [phone|desktop]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const THEME = process.env.DG_THEME || '/home/claude/dg-theme';
const PORT = Number(process.env.PORT || process.env.QA_PORT || 4975);
const BASE = `http://localhost:${PORT}`;
const ONLY = process.argv[2] || '';
const SIZES = [['phone', 390, 844], ['desktop', 1280, 800]].filter(([tag]) => !ONLY || tag === ONLY);
const MAPS = 'https://maps.app.goo.gl/7KdmJLTqZPe47kXG6';
const SIGNOFF = 'Made by goblins who like dice and games.';
const VGC = '/products/vallejo-game-colour';
const SOLD = ['Pale Flesh', 'Gory Red', 'Livery Green', 'Wolf Grey'];
// Monday 5 Oct 2026, 5pm in Auckland: open, so the footer says "Open today 4pm–midnight"
const AT = Date.UTC(2026, 9, 5, 4, 0);
const CLOCK = `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(THEME, p), 'utf8').replace(/^\s*\/\*[\s\S]*?\*\//, ''));
const schemaOf = (p) => JSON.parse(fs.readFileSync(path.join(THEME, p), 'utf8').match(/\{% schema %\}([\s\S]*?)\{% endschema %\}/)[1]);
const index = readJson('templates/index.json');
const footerGroup = readJson('sections/footer-group.json');

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' && detail !== undefined ? ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const server = await m.serve(PORT);
const browser = await chromium.launch();
async function open(width, height, url, { ctx = null } = {}) {
  const phone = width < 700;
  const context = ctx || (await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone }));
  if (!ctx) await context.addInitScript(CLOCK);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(`console: ${msg.text()}`); });
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return { ctx: context, page, errors, own: !ctx };
}
const done = async (o) => { if (o.own) await o.ctx.close(); else await o.page.close(); };
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const axe = async (page, include) => {
  await page.addScriptTag({ path: process.env.AXE });
  return page.evaluate(async (inc) => {
    const r = await window.axe.run(inc ? { include: inc.map((s) => [s]) } : document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => `${v.impact}:${v.id}(${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
  }, include);
};

/* ---------- the theme's files: settings, not hard-coded words ---------- */
{
  const hero = schemaOf('sections/hero-roll.liquid');
  const fact = (hero.blocks || []).find((b) => b.type === 'fact');
  const ids = (fact?.settings || []).map((s) => s.id);
  check('files: the hero has a "What we have" block (big, small, colour) and heading and text settings', Boolean(fact) && ['big', 'small', 'accent'].every((id) => ids.includes(id)) && hero.settings.some((s) => s.id === 'heading') && hero.settings.some((s) => s.id === 'text') && hero.max_blocks >= 10, ids.join(', '));
  const h = index.sections.hero;
  const facts = h.block_order.map((id) => h.blocks[id]).filter((b) => b.type === 'fact').map((b) => `${b.settings.big} ${b.settings.small}`);
  check('files: index.json holds the five facts in order', JSON.stringify(facts) === JSON.stringify(['30 tables', '26+ role-playing games', 'Pokémon and other TCGs', 'Warhammer and other wargames', '500+ games to play or borrow']), facts.join(' | '));
  check('files: the hero heading and text name no place and no price', !/royal oak/i.test(h.settings.heading + h.settings.text) && !/\$/.test(h.settings.text) && /game shop/i.test(h.settings.heading), `${h.settings.heading} / ${h.settings.text}`);
  const order = index.order;
  check('files: Meet Gobgob comes right after the hero', order[0] === 'hero' && index.sections[order[1]].type === 'gobgob-intro', order.join(', '));
  const gob = schemaOf('sections/gobgob-intro.liquid');
  check('files: Meet Gobgob\'s heading, bubble and text are settings, its places blocks', ['heading', 'quip', 'text'].every((id) => gob.settings.some((s) => s.id === id)) && gob.blocks.some((b) => b.type === 'job'), gob.settings.map((s) => s.id).join(', '));
  const signoff = footerGroup.sections.footer.settings.signoff;
  const def = schemaOf('sections/site-footer.liquid').settings.find((s) => s.id === 'signoff');
  check('files: the footer sign-off is the setting "Made by goblins who like dice and games." (its default too)', signoff === SIGNOFF && def.default === SIGNOFF, signoff);
  const loc = JSON.parse(fs.readFileSync(path.join(THEME, 'locales/en.default.json'), 'utf8'));
  check('files: the collection meta description names no suburb', !/royal oak/i.test(loc.general.meta.collection_description), loc.general.meta.collection_description);
  check('files: the contact topics include a website problem and shop feedback', /website/i.test(loc.sections.contact.topics.website || '') && /feedback/i.test(loc.sections.contact.topics.feedback || ''), `${loc.sections.contact.topics.website} / ${loc.sections.contact.topics.feedback}`);
  const product = schemaOf('sections/main-product.liquid').settings.find((s) => s.id === 'dropdown_from');
  check('files: the product section has the "dropdown with pictures from" setting (8)', product && product.default === 8, product);
}

try {
  for (const [tag, width, height] of SIZES) {
    const phone = width < 700;
    /* ---------- 1. the hero ---------- */
    {
      const o = await open(width, height, '/');
      const h = await o.page.evaluate(() => {
        const hero = document.querySelector('.hero');
        const facts = [...hero.querySelectorAll('.hero-fact')].map((li) => {
          const big = li.querySelector('.hero-fact__big');
          const cs = getComputedStyle(li);
          const inner = li.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          const range = document.createRange();
          range.selectNodeContents(big);
          return { text: li.textContent.replace(/\s+/g, ' ').trim(), lines: range.getClientRects().length, w: range.getBoundingClientRect().width, inner, size: getComputedStyle(big).fontSize, top: li.getBoundingClientRect().top, right: li.getBoundingClientRect().right };
        });
        const strip = hero.querySelector('.hero-facts').getBoundingClientRect();
        return {
          h1: document.querySelectorAll('h1').length, title: hero.querySelector('h1').textContent.trim(), lede: hero.querySelector('.hero__lede')?.textContent.trim() || '',
          facts, stripRight: strip.right, buttons: [...hero.querySelectorAll('.hero__actions .signpost')].map((a) => a.textContent.replace(/\s+/g, ' ').trim()),
          buttonsBottom: Math.max(...[...hero.querySelectorAll('.hero__actions .signpost')].map((a) => a.getBoundingClientRect().bottom)),
        };
      });
      check(`${tag} hero: one h1, saying what the business is, no Royal Oak`, h.h1 === 1 && h.title === index.sections.hero.settings.heading && !/royal oak/i.test(h.title), h.title);
      check(`${tag} hero: the five facts in order, from the blocks`, h.facts.map((f) => f.text).join(' | ') === '30 tables | 26+ role-playing games | Pokémon and other TCGs | Warhammer and other wargames | 500+ games to play or borrow', h.facts.map((f) => f.text).join(' | '));
      check(`${tag} hero: every fact's big words whole on one line, inside its tile, all the same size`, h.facts.every((f) => f.lines === 1 && f.w <= f.inner + 0.5) && new Set(h.facts.map((f) => f.size)).size === 1, h.facts.map((f) => `${Math.round(f.w)}/${Math.round(f.inner)} ${f.size}`).join(', '));
      const rows = [...new Set(h.facts.map((f) => Math.round(f.top)))].length;
      check(`${tag} hero: the strip ends square (${phone ? 'two to a row, the fifth across' : 'three, then two'})`, rows === (phone ? 3 : 2) && Math.abs(Math.max(...h.facts.map((f) => f.right)) - h.stripRight) < 1, `${rows} rows`);
      check(`${tag} hero: the text under it has no Royal Oak and no table price`, h.lede && !/royal oak/i.test(h.lede) && !/\$/.test(h.lede), h.lede);
      check(`${tag} hero: Book a table, Shop new arrivals and Join our Discord kept, on the first screen`, h.buttons.length === 3 && /Book a table/.test(h.buttons[0]) && /Discord/.test(h.buttons[2]) && h.buttonsBottom <= height, `${h.buttons.join(' | ')}; bottom ${Math.round(h.buttonsBottom)}`);

      /* ---------- 2. Meet Gobgob ---------- */
      const g = await o.page.evaluate(() => {
        const main = document.querySelector('main');
        const sections = [...main.children].filter((c) => c.classList.contains('shopify-section'));
        const sec = document.querySelector('.gob-intro');
        if (!sec) return null;
        const img = sec.querySelector('img.gobgob');
        return {
          second: sections[1]?.contains(sec), heading: sec.querySelector('h2')?.textContent.trim(), quip: sec.querySelector('.gob-says')?.firstChild?.textContent.trim(),
          text: sec.querySelector('.gob-intro__text')?.textContent.trim(), jobs: [...sec.querySelectorAll('.gob-intro__job')].map((li) => li.textContent.trim()),
          img: img && { src: img.currentSrc || img.src, w: img.getAttribute('width'), h: img.getAttribute('height'), alt: img.getAttribute('alt'), shown: img.getBoundingClientRect().width },
          labelled: sec.getAttribute('aria-labelledby') === sec.querySelector('h2')?.id,
        };
      });
      const gs = index.sections.gobgob;
      check(`${tag} Meet Gobgob: the second section, its heading names the section`, Boolean(g) && g.second && g.heading === gs.settings.heading && g.labelled, g && g.heading);
      check(`${tag} Meet Gobgob: Gobgob's picture (240x224, alt "") beside their own line`, Boolean(g?.img) && /gobgob-(240|480)\.png/.test(g.img.src) && g.img.w === '240' && g.img.h === '224' && g.img.alt === '' && g.img.shown >= 80 && g.quip === gs.settings.quip, g && g.img);
      check(`${tag} Meet Gobgob: who they are (they/them), and the four places you meet them, from the settings`, Boolean(g) && g.text === gs.settings.text && /\bThey\b/.test(g.text) && !/\b(he|him|his)\b/i.test(g.text) && g.jobs.length === 4 && g.jobs.join('|') === gs.block_order.map((id) => gs.blocks[id].settings.text).join('|'), g && g.jobs.join(' | '));

      /* ---------- 3. the footer ---------- */
      const f = await o.page.evaluate(() => {
        const foot = document.querySelector('.site-footer');
        const visit = foot.querySelector('.site-footer__visit');
        const line = visit.querySelector('.site-footer__visit-line');
        const items = [...line.children].filter((c) => c.getBoundingClientRect().height > 0).map((c) => ({ text: c.innerText.replace(/\s+/g, ' ').trim(), top: Math.round(c.getBoundingClientRect().top), h: c.getBoundingClientRect().height, href: c.getAttribute('href') }));
        const more = visit.querySelector('.site-footer__more');
        const menus = [...foot.querySelectorAll('[data-footer-menu]')].map((d) => {
          const sum = d.querySelector('summary');
          return { open: d.open, summaryH: sum.getBoundingClientRect().height, heading: getComputedStyle(d.querySelector('.site-footer__heading')).display, links: d.querySelectorAll('.site-footer__list a').length };
        });
        return {
          height: foot.getBoundingClientRect().height, signoff: foot.querySelector('.site-footer__signoff p')?.textContent.trim(),
          gob: Boolean(foot.querySelector('.site-footer__signoff img.gobgob')), items, more: more && { text: more.textContent.trim(), href: more.getAttribute('href'), top: Math.round(more.getBoundingClientRect().top) },
          address: visit.querySelector('a.text-link')?.getAttribute('href'), hoursTable: foot.querySelectorAll('.hours, [data-hours-list]').length,
          directions: /Whitcoulls/.test(foot.textContent), email: /@/.test(visit.textContent), menus,
          news: Boolean(foot.querySelector('#footer-newsletter-email')), socials: foot.querySelectorAll('.socials a').length, payments: foot.querySelectorAll('.payment-icons li').length,
          copyright: /©/.test(foot.querySelector('.site-footer__bottom')?.textContent || ''),
        };
      });
      check(`${tag} footer: much shorter than before (${phone ? 'under 800px, was about 1,500' : 'under 500px, was about 770'})`, f.height < (phone ? 800 : 500), `${Math.round(f.height)}px`);
      check(`${tag} footer: the sign-off "${SIGNOFF}" beside Gobgob`, f.signoff === SIGNOFF && f.gob, f.signoff);
      check(`${tag} footer: menus, newsletter, socials, copyright and payment icons kept`, f.menus.length === 3 && f.menus.every((mn) => mn.links >= 4) && f.news && f.socials >= 1 && f.copyright && f.payments >= 1, `${f.menus.length} menus, ${f.socials} socials, ${f.payments} payment icons`);
      check(`${tag} footer: the visit details are the address (to Google Maps), today's hours and the phone`, f.items.length === 3 && /^56\/691 Manukau Road, Royal Oak, Auckland 1023/.test(f.items[0].text) && f.address === MAPS && f.items[1].text === 'Open today 4pm–midnight' && /021 159 6894/.test(f.items[2].text), f.items.map((i) => i.text).join(' | '));
      check(`${tag} footer: ${phone ? 'each visit link at least 44px tall' : 'the visit details on one line'}, then Hours and directions (to the home page's contact block)`, (phone ? f.items.filter((i) => i.href).every((i) => i.h >= 44) : new Set(f.items.map((i) => i.top)).size === 1 && Math.abs(f.more.top - f.items[0].top) <= 6) && f.more.text === 'Hours and directions' && f.more.href === '#contact', `${f.items.map((i) => `${i.top}/${Math.round(i.h)}`).join(' ')} more ${f.more.top} ${f.more.href}`);
      check(`${tag} footer: no full hours table, directions paragraph or email in it any more`, f.hoursTable === 0 && !f.directions && !f.email, `${f.hoursTable} hours tables, directions ${f.directions}, email ${f.email}`);
      if (phone) {
        check(`${tag} footer: the three menus folded, each a 44px+ row`, f.menus.every((mn) => !mn.open && mn.summaryH >= 44), f.menus.map((mn) => `${mn.open ? 'open' : 'shut'} ${Math.round(mn.summaryH)}px`).join(', '));
        await o.page.locator('.site-footer__summary').first().click();
        await o.page.waitForTimeout(200);
        const opened = await o.page.evaluate(() => { const d = document.querySelector('[data-footer-menu]'); return { open: d.open, visible: [...d.querySelectorAll('.site-footer__list a')].filter((a) => a.getBoundingClientRect().height >= 44).length }; });
        check(`${tag} footer: tapping Shop opens its links, 44px each`, opened.open && opened.visible >= 4, opened);
        // the keyboard: the second menu's summary opens with Enter and closes with Space, with a focus ring
        await o.page.evaluate(() => { document.querySelectorAll('[data-footer-menu]')[0].open = false; });
        await o.page.locator('.site-footer__nav').nth(0).locator('summary').focus();
        await o.page.keyboard.press('Tab');
        const ringOn = await o.page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return `${document.activeElement.tagName} ${cs.outlineStyle} ${cs.outlineWidth}`; });
        await o.page.keyboard.press('Enter');
        await o.page.waitForTimeout(150);
        const afterEnter = await o.page.evaluate(() => document.querySelectorAll('[data-footer-menu]')[1].open);
        await o.page.keyboard.press('Space');
        await o.page.waitForTimeout(150);
        const afterSpace = await o.page.evaluate(() => document.querySelectorAll('[data-footer-menu]')[1].open);
        check(`${tag} footer keys: a menu row takes the focus (ring shown), Enter opens it, Space closes it`, /^SUMMARY solid 3px/.test(ringOn) && afterEnter && !afterSpace, `${ringOn}, Enter ${afterEnter}, Space ${afterSpace}`);
      } else {
        check(`${tag} footer: the menus open as columns with their headings, no accordion rows`, f.menus.every((mn) => mn.open && mn.summaryH === 0 && mn.heading === 'block'), f.menus.map((mn) => `${mn.open} ${mn.summaryH} ${mn.heading}`).join(', '));
        // the keyboard: Tab from the newsletter's button goes through the visit links, never a hidden menu row
        await o.page.focus('.site-footer__news button[type="submit"]');
        const stops = [];
        for (let i = 0; i < 5; i += 1) {
          await o.page.keyboard.press('Tab');
          stops.push(await o.page.evaluate(() => { const el = document.activeElement; const cs = getComputedStyle(el); return { tag: el.tagName, text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 30), ring: `${cs.outlineStyle} ${cs.outlineWidth}`, summary: Boolean(el.closest('summary')) }; }));
        }
        check(`${tag} footer keys: Tab moves through the address, phone and Hours and directions with a focus ring, no hidden menu rows`, stops.slice(0, 3).every((st) => st.tag === 'A' && /solid 3px/.test(st.ring)) && !stops.some((st) => st.summary) && /Manukau/.test(stops[0].text) && /Hours and directions/.test(stops[2].text), stops.map((st) => `${st.tag} ${st.text}`).join(' > '));
      }

      /* ---------- 5. reviews ---------- */
      const r = await o.page.evaluate(() => [...document.querySelectorAll('.review__quote')].map((q) => {
        const open = q.querySelector('.review__mark--open');
        const close = q.querySelector('.review__mark--close');
        const p = q.querySelector('p');
        return {
          tag: q.tagName, open: open && open.getAttribute('aria-hidden') === 'true' && open.textContent.trim() === '“', close: close && close.getAttribute('aria-hidden') === 'true' && close.textContent.trim() === '”',
          below: close && p ? close.getBoundingClientRect().top >= p.getBoundingClientRect().bottom - 2 : false, end: close ? getComputedStyle(close).textAlign : '', top: Math.round(q.closest('.review').getBoundingClientRect().top),
        };
      }));
      check(`${tag} reviews: every card opens and closes its quote, the closing mark under the words at the end (aria-hidden, in a blockquote)`, r.length === 6 && r.every((x) => x.tag === 'BLOCKQUOTE' && x.open && x.close && x.below && x.end === 'end'), r.map((x) => `${x.open ? 'o' : '-'}${x.close ? 'c' : '-'}${x.below ? 'b' : '-'}`).join(' '));
      if (!phone) {
        const perRow = Object.values(r.reduce((acc, x) => ({ ...acc, [x.top]: (acc[x.top] || 0) + 1 }), {}));
        check(`${tag} reviews: full rows (six in two rows of three)`, perRow.length === 2 && perRow.every((n) => n === 3), perRow.join('+'));
      }

      /* ---------- 6. the home page's contact block ---------- */
      const c = await o.page.evaluate(() => ({ cardReviews: document.querySelectorAll('.contact-card__reviews').length, sectionReviews: [...document.querySelectorAll('.reviews a')].filter((a) => /Google reviews/.test(a.textContent)).length, head: getComputedStyle(document.querySelector('.contact-lair__head')).textAlign }));
      check(`${tag} home: "Read our Google reviews" once (the Reviews section's), not again in the contact card`, c.cardReviews === 0 && c.sectionReviews === 1, c);
      if (!phone) check(`${tag} home: the contact heading starts on the left like the other sections`, c.head === 'start' || c.head === 'left', c.head);
      check(`${tag} home: no console errors, no sideways scroll`, o.errors.length === 0 && (await overflowX(o.page)) === 0, o.errors.slice(0, 2).join(' / '));
      await done(o);
    }

    /* ---------- 4. Royal Oak only in the address and directions ---------- */
    for (const url of ['/', '/products/wingspan', VGC, '/collections/new-additions', '/pages/contact', '/pages/board-game-rental', '/search?q=wing', '/404']) {
      const o = await open(width, height, url);
      const ro = await o.page.evaluate(() => {
        const allowed = '.contact-card__address, .contact-card__directions, .site-footer__visit-line a, script, style, noscript, template';
        const clone = document.body.cloneNode(true);
        clone.querySelectorAll(allowed).forEach((el) => el.remove());
        const text = clone.textContent;
        const hits = (text.match(/.{0,40}royal oak.{0,40}/gi) || []).map((s) => s.replace(/\s+/g, ' '));
        const meta = [...document.querySelectorAll('meta[name="description"], meta[property="og:description"], title')].map((el) => el.getAttribute('content') || el.textContent).join(' ');
        return { hits, meta: /royal oak/i.test(meta) };
      });
      check(`${tag} ${url}: "Royal Oak" only in the address and directions`, ro.hits.length === 0 && !ro.meta, ro.hits.slice(0, 2).join(' / ') || (ro.meta ? 'in the meta tags' : ''));
      await done(o);
    }

    /* ---------- 6. the contact form's topics ---------- */
    {
      const o = await open(width, height, '/pages/contact');
      const t = await o.page.evaluate(() => {
        const sel = document.querySelector('select[name="contact[topic]"]');
        return { name: sel?.getAttribute('name'), options: sel ? [...sel.options].map((op) => op.textContent.trim()) : [], label: sel ? document.querySelector(`label[for="${sel.id}"]`)?.textContent.trim() : '', reviews: document.querySelectorAll('.contact-card__reviews').length };
      });
      check(`${tag} contact: What's it about? offers "Website problem or bug" and "Feedback about the shop", sent as contact[topic]`, t.name === 'contact[topic]' && t.options.includes('Website problem or bug') && t.options.includes('Feedback about the shop') && t.options.length === 7 && t.label === "What's it about?", t.options.join(' | '));
      check(`${tag} contact page: its card keeps the Google reviews link`, t.reviews === 1, t.reviews);
      await done(o);
    }

    /* ---------- 7. the dropdown with pictures ---------- */
    {
      const o = await open(width, height, VGC);
      const page = o.page;
      const pageWords = () => page.evaluate(() => {
        const clone = document.querySelector('.product__info').cloneNode(true);
        clone.querySelectorAll('variant-select').forEach((el) => el.remove());
        return clone.innerText.replace(/\s+/g, ' ').trim();
      });
      const wordsBefore = await pageWords();
      const s0 = await page.evaluate(() => {
        const vs = document.querySelector('variant-select');
        const button = vs?.querySelector('[data-vselect-button]');
        const rows = vs ? [...vs.querySelectorAll('[role="option"]')] : [];
        const thumbs = rows.map((r) => r.querySelector('img'));
        return {
          has: Boolean(vs), chips: document.querySelectorAll('.variant-picker .chip__input').length, label: document.querySelector('.variant-picker__option--select legend')?.textContent.trim(),
          button: button && { name: button.querySelector('[data-vselect-name]').textContent.trim(), img: Boolean(button.querySelector('img[width="48"][height="48"]')), expanded: button.getAttribute('aria-expanded'), popup: button.getAttribute('aria-haspopup'), h: button.getBoundingClientRect().height, labelledby: button.getAttribute('aria-labelledby') },
          rows: rows.length, lazy: thumbs.every((im) => im && im.getAttribute('loading') === 'lazy' && im.getAttribute('width') === '48' && im.getAttribute('height') === '48' && im.getAttribute('alt') === '' && /w=96|width=96/.test(im.getAttribute('src'))),
          sold: rows.filter((r) => !r.querySelector('[data-vselect-sold]').hidden).map((r) => r.dataset.value), panelHidden: vs.querySelector('[data-vselect-panel]').hidden,
          id: document.querySelector('[data-variant-id]').value, price: document.querySelector('[data-product-price] .price')?.textContent.replace(/\s+/g, ' ').trim(),
        };
      });
      check(`${tag} dropdown: Colours (48 values) is a dropdown, not 48 buttons`, s0.has && s0.chips === 0 && s0.label === 'Colours' && s0.rows === 48, `${s0.rows} rows, ${s0.chips} chips`);
      check(`${tag} dropdown: the button shows the chosen colour with its picture (a listbox popup, closed, 44px+)`, s0.button && s0.button.name === 'Dead White' && s0.button.img && s0.button.expanded === 'false' && s0.button.popup === 'listbox' && s0.button.h >= 44 && s0.panelHidden, s0.button);
      check(`${tag} dropdown: every row has its variant's picture (96px image, 48x48, lazy, alt "")`, s0.lazy, s0.lazy);
      check(`${tag} dropdown: Sold out on exactly the four sold-out colours`, JSON.stringify(s0.sold) === JSON.stringify(SOLD), s0.sold.join(', '));
      const slideFor = (variantId) => page.evaluate((vid) => {
        const v = JSON.parse(document.querySelector('[data-variants]').textContent).find((x) => String(x.id) === String(vid));
        const track = document.querySelector('[data-gallery-track]');
        const slide = document.querySelector(`[data-media-id="${v.media}"]`);
        const current = document.querySelector('.product__thumb[aria-current="true"]');
        return { media: v.media, at: Math.abs(slide.offsetLeft - track.firstElementChild.offsetLeft - track.scrollLeft) < 2, thumb: current && current.dataset.thumb === slide.id };
      }, variantId);

      // open it
      await page.click('[data-vselect-button]');
      await page.waitForTimeout(250);
      const s1 = await page.evaluate(() => {
        const vs = document.querySelector('variant-select');
        const panel = vs.querySelector('[data-vselect-panel]');
        const list = vs.querySelector('[data-vselect-list]');
        const pb = panel.getBoundingClientRect();
        const rows = [...list.querySelectorAll('[role="option"]')];
        const active = list.querySelector('[data-active]');
        const filter = vs.querySelector('[data-vselect-filter]');
        return {
          expanded: vs.querySelector('[data-vselect-button]').getAttribute('aria-expanded'), shown: !panel.hidden && pb.height > 100, position: getComputedStyle(panel).position, bottomGap: Math.round(window.innerHeight - pb.bottom),
          scrolls: list.scrollHeight > list.clientHeight + 10, rowsTall: rows.filter((r) => !r.hidden).every((r) => r.getBoundingClientRect().height >= 44), focus: document.activeElement === filter ? 'filter' : document.activeElement === panel ? 'panel' : document.activeElement.tagName,
          active: active?.dataset.value, activeDesc: filter.getAttribute('aria-activedescendant') === active?.id, placeholder: filter.getAttribute('placeholder'), filterLabel: document.querySelector(`label[for="${filter.id}"]`)?.textContent.trim(),
          role: filter.getAttribute('role'), controls: filter.getAttribute('aria-controls') === list.id, locked: document.body.classList.contains('has-open-sheet'),
          inView: pb.top >= 0 && pb.bottom <= window.innerHeight + 1,
        };
      });
      check(`${tag} dropdown: opens (aria-expanded), its list scrolls inside the panel, 44px rows, the chosen colour active`, s1.expanded === 'true' && s1.shown && s1.scrolls && s1.rowsTall && s1.active === 'Dead White' && s1.activeDesc, s1);
      check(`${tag} dropdown: a "Find a colour" filter (a labelled combobox controlling the list)`, s1.placeholder === 'Find a colour' && s1.filterLabel === 'Find a colour' && s1.role === 'combobox' && s1.controls, `${s1.placeholder} / ${s1.filterLabel}`);
      if (phone) check(`${tag} dropdown: on a phone it's a sheet from the bottom over a locked page, the sheet holding the focus`, s1.position === 'fixed' && Math.abs(s1.bottomGap) <= 1 && s1.locked && s1.focus === 'panel' && s1.inView, s1);
      else check(`${tag} dropdown: on a desktop it drops under the button, the focus in the filter, all of it on screen`, s1.position === 'absolute' && s1.focus === 'filter' && s1.inView, s1);

      // filter
      if (phone) await page.click('[data-vselect-filter]');
      await page.keyboard.type('red');
      await page.waitForTimeout(200);
      const s2 = await page.evaluate(() => {
        const vs = document.querySelector('variant-select');
        return { shown: [...vs.querySelectorAll('[role="option"]')].filter((r) => !r.hidden).map((r) => r.dataset.value), active: vs.querySelector('[data-active]')?.dataset.value, status: vs.querySelector('[data-vselect-status]').textContent.trim() };
      });
      check(`${tag} dropdown: typing "red" leaves the reds, the first one active, and says how many`, JSON.stringify(s2.shown) === JSON.stringify(['Bloody Red', 'Gory Red', 'Scarlett Red']) && s2.active === 'Bloody Red' && s2.status === '3 matches', s2);
      await page.fill('[data-vselect-filter]', 'zzz');
      await page.waitForTimeout(150);
      const s3 = await page.evaluate(() => { const vs = document.querySelector('variant-select'); const e = vs.querySelector('[data-vselect-empty]'); return { none: [...vs.querySelectorAll('[role="option"]')].every((r) => r.hidden), empty: !e.hidden && e.textContent.trim() }; });
      check(`${tag} dropdown: no match says so, in Gobgob's words`, s3.none && /Gobgob can't find “zzz”/.test(s3.empty || ''), s3.empty);
      await page.fill('[data-vselect-filter]', 'blood');
      await page.waitForTimeout(150);

      // choose Bloody Red with Enter
      const watched = await page.evaluate(() => { window.__said = []; const live = document.querySelector('[data-live-region]'); if (live) new MutationObserver(() => window.__said.push(live.textContent)).observe(live, { childList: true, characterData: true, subtree: true }); return Boolean(live); });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      const s4 = await page.evaluate(() => {
        const vs = document.querySelector('variant-select');
        const v = JSON.parse(document.querySelector('[data-variants]').textContent).find((x) => x.options[0] === 'Bloody Red');
        return {
          vid: v.id, id: document.querySelector('[data-variant-id]').value, url: location.search, name: vs.querySelector('[data-vselect-name]').textContent.trim(), closed: vs.querySelector('[data-vselect-panel]').hidden,
          focus: document.activeElement === vs.querySelector('[data-vselect-button]'), add: document.querySelector('[data-add-label]').textContent.trim(), disabled: document.querySelector('[data-add-button]').disabled,
          price: document.querySelector('[data-product-price] .price').textContent.replace(/\s+/g, ' ').trim(), thumb: vs.querySelector('[data-vselect-thumb] img')?.getAttribute('src') || '',
          flag: vs.querySelector('[data-vselect-flag]').hidden, bar: document.querySelector('[data-buy-bar-label]')?.textContent.trim(), said: window.__said, locked: document.body.classList.contains('has-open-sheet'),
          selected: vs.querySelector('[aria-selected="true"]')?.dataset.value, submitted: document.querySelector('.vselect') ? [...new FormData(document.querySelector('form[action="/cart/add"]')).keys()].join(',') : '',
        };
      });
      const wordsAfter = await pageWords();
      check(`${tag} dropdown: Enter chooses Bloody Red: the id, the URL, the button's name and picture, closed, focus back on the button`, s4.id === String(s4.vid) && s4.url === `?variant=${s4.vid}` && s4.name === 'Bloody Red' && s4.closed && s4.focus && /bloody-red/.test(s4.thumb) && s4.selected === 'Bloody Red' && !s4.locked, s4);
      check(`${tag} dropdown: price, Add to cart and the buy bar follow it`, s4.price === '$8.00' && s4.add === 'Add to cart' && !s4.disabled && s4.flag && (s4.bar === undefined || s4.bar === 'Add to cart'), `${s4.price} ${s4.add} ${s4.bar}`);
      const pic = await slideFor(s4.vid);
      check(`${tag} dropdown: the main picture swaps to Bloody Red's, its thumbnail current`, pic.at && pic.thumb, pic);
      check(`${tag} dropdown: the swap says nothing (no announcement, no new words on the page)`, watched && s4.said.length === 0 && wordsAfter === wordsBefore, s4.said.join(' / ') || (wordsAfter === wordsBefore ? '' : `${wordsBefore.length} -> ${wordsAfter.length} characters`));
      check(`${tag} dropdown: the form sends only the variant id and quantity (the filter isn't sent)`, !/vselect|filter/.test(s4.submitted) && /\bid\b/.test(s4.submitted), s4.submitted);

      // the keys, on the closed button
      if (!phone) {
        await page.focus('[data-vselect-button]');
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(150);
        const k1 = await page.evaluate(() => ({ open: !document.querySelector('[data-vselect-panel]').hidden, active: document.querySelector('[data-active]')?.dataset.value, focus: document.activeElement.matches('[data-vselect-filter]') }));
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        const k2 = await page.evaluate(() => document.querySelector('[data-active]')?.dataset.value);
        await page.keyboard.press('ArrowUp');
        const k3 = await page.evaluate(() => document.querySelector('[data-active]')?.dataset.value);
        await page.keyboard.press('End');
        const k4 = await page.evaluate(() => { const a = document.querySelector('[data-active]'); const l = document.querySelector('[data-vselect-list]'); const ab = a.getBoundingClientRect(); const lb = l.getBoundingClientRect(); return { v: a.dataset.value, inView: ab.top >= lb.top - 1 && ab.bottom <= lb.bottom + 1 }; });
        await page.keyboard.press('Home');
        const k5 = await page.evaluate(() => document.querySelector('[data-active]')?.dataset.value);
        await page.keyboard.press('PageDown');
        const k6 = await page.evaluate(() => document.querySelector('[data-active]')?.dataset.value);
        check(`${tag} keys: Down opens on the chosen colour; Down, Up, End (scrolled into view), Home and Page Down move`, k1.open && k1.active === 'Bloody Red' && k1.focus && k2 === 'Scarlett Red' && k3 === 'Gory Red' && k4.v === 'Gunmetal Metal' && k4.inView && k5 === 'Dead White' && k6 === 'Sunblast Yellow', { k1, k2, k3, k4, k5, k6 });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        const k7 = await page.evaluate(() => ({ closed: document.querySelector('[data-vselect-panel]').hidden, focus: document.activeElement.matches('[data-vselect-button]'), name: document.querySelector('[data-vselect-name]').textContent.trim(), expanded: document.querySelector('[data-vselect-button]').getAttribute('aria-expanded') }));
        check(`${tag} keys: Escape closes it without changing the colour, the focus back on the button`, k7.closed && k7.focus && k7.name === 'Bloody Red' && k7.expanded === 'false', k7);
        await page.keyboard.press('g');
        await page.waitForTimeout(150);
        const k8 = await page.evaluate(() => ({ open: !document.querySelector('[data-vselect-panel]').hidden, typed: document.querySelector('[data-vselect-filter]').value, active: document.querySelector('[data-active]')?.dataset.value }));
        await page.keyboard.type('ory');
        const k9 = await page.evaluate(() => document.querySelector('[data-active]')?.dataset.value);
        check(`${tag} keys: typing on the closed button opens it and starts the filter (type-ahead)`, k8.open && k8.typed === 'g' && k8.active === 'Gold Yellow' && k9 === 'Gory Red', { k8, k9 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
        const k10 = await page.evaluate(() => ({ name: document.querySelector('[data-vselect-name]').textContent.trim(), flag: !document.querySelector('[data-vselect-flag]').hidden, add: document.querySelector('[data-add-label]').textContent.trim(), disabled: document.querySelector('[data-add-button]').disabled }));
        check(`${tag} sold out: choosing Gory Red shows Sold out on the button and disables Add to cart`, k10.name === 'Gory Red' && k10.flag && k10.add === 'Sold out' && k10.disabled, k10);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Tab');
        await page.waitForTimeout(150);
        const k11 = await page.evaluate(() => ({ closed: document.querySelector('[data-vselect-panel]').hidden, focusOut: !document.activeElement.closest('variant-select') }));
        check(`${tag} keys: Tab closes it and moves on`, k11.closed && k11.focusOut, k11);
        const ring = await page.evaluate(() => { const b = document.querySelector('[data-vselect-button]'); b.focus(); const cs = getComputedStyle(b); return `${cs.outlineStyle} ${cs.outlineWidth}`; });
        check(`${tag} keys: the button shows a focus ring`, /solid 3px/.test(ring), ring);
      } else {
        // a phone: tap a colour in the sheet, and close it with the backdrop
        await page.click('[data-vselect-button]');
        await page.waitForTimeout(250);
        await page.locator('[role="option"][data-value="Wolf Grey"]').scrollIntoViewIfNeeded();
        await page.click('[role="option"][data-value="Wolf Grey"]');
        await page.waitForTimeout(400);
        const t1 = await page.evaluate(() => ({ name: document.querySelector('[data-vselect-name]').textContent.trim(), closed: document.querySelector('[data-vselect-panel]').hidden, add: document.querySelector('[data-add-label]').textContent.trim(), flag: !document.querySelector('[data-vselect-flag]').hidden, locked: document.body.classList.contains('has-open-sheet') }));
        check(`${tag} sheet: tapping Wolf Grey chooses it (Sold out shown, Add to cart off) and closes the sheet`, t1.name === 'Wolf Grey' && t1.closed && t1.add === 'Sold out' && t1.flag && !t1.locked, t1);
        await page.click('[data-vselect-button]');
        await page.waitForTimeout(250);
        await page.mouse.click(195, 40);
        await page.waitForTimeout(250);
        const t2 = await page.evaluate(() => ({ closed: document.querySelector('[data-vselect-panel]').hidden, name: document.querySelector('[data-vselect-name]').textContent.trim(), locked: document.body.classList.contains('has-open-sheet') }));
        check(`${tag} sheet: tapping the dimmed page closes it without changing anything`, t2.closed && t2.name === 'Wolf Grey' && !t2.locked, t2);
      }
      check(`${tag} product (dropdown): no console errors, no sideways scroll`, o.errors.length === 0 && (await overflowX(page)) === 0, o.errors.slice(0, 2).join(' / '));
      await done(o);
    }
    {
      // a ?variant= link, and Back after going elsewhere
      const variants = m.allProducts['vallejo-game-colour'].variants;
      const uv = variants.find((v) => v.options[0] === 'Ultramarine Blue');
      const o = await open(width, height, `${VGC}?variant=${uv.id}`);
      const l = await o.page.evaluate((vid) => ({
        name: document.querySelector('[data-vselect-name]').textContent.trim(), id: document.querySelector('[data-variant-id]').value, selected: document.querySelector('[aria-selected="true"]')?.dataset.value,
        first: document.querySelector('[data-gallery-track] > li')?.dataset.mediaId, firstLoading: document.querySelector('[data-gallery-track] > li img')?.getAttribute('loading'),
        thumb: document.querySelector('.product__thumb[aria-current="true"]')?.dataset.thumb, vid,
      }), uv.id);
      check(`${tag} ?variant=: opens on Ultramarine Blue, its picture first (loaded first) and its thumbnail current`, l.name === 'Ultramarine Blue' && l.id === String(uv.id) && l.selected === 'Ultramarine Blue' && l.first === String(uv.featured_media.id) && l.firstLoading === 'eager' && l.thumb === `media-template--1__main-${uv.featured_media.id}`, l);
      // choose another, go to the home page, come back
      await o.page.click('[data-vselect-button]');
      await o.page.waitForTimeout(200);
      await o.page.locator('[role="option"][data-value="Jade Green"]').scrollIntoViewIfNeeded();
      await o.page.click('[role="option"][data-value="Jade Green"]');
      await o.page.waitForTimeout(300);
      const jg = variants.find((v) => v.options[0] === 'Jade Green');
      await o.page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      await o.page.goBack({ waitUntil: 'networkidle' });
      await o.page.waitForTimeout(400);
      const b = await o.page.evaluate(() => ({ url: location.search, name: document.querySelector('[data-vselect-name]').textContent.trim(), id: document.querySelector('[data-variant-id]').value, selected: document.querySelector('[aria-selected="true"]')?.dataset.value }));
      const bpic = await o.page.evaluate((vid) => {
        const v = JSON.parse(document.querySelector('[data-variants]').textContent).find((x) => String(x.id) === String(vid));
        const track = document.querySelector('[data-gallery-track]');
        const slide = document.querySelector(`[data-media-id="${v.media}"]`);
        return Math.abs(slide.offsetLeft - track.firstElementChild.offsetLeft - track.scrollLeft) < 2;
      }, jg.id);
      check(`${tag} Back: coming back shows Jade Green (the URL, the dropdown, the id and the picture agree)`, b.url === `?variant=${jg.id}` && b.name === 'Jade Green' && b.id === String(jg.id) && b.selected === 'Jade Green' && bpic, { ...b, bpic });
      // Add to cart sends the chosen colour
      m.mockCart.lines.length = 0;
      const addButton = o.page.locator('[data-add-button]');
      await addButton.scrollIntoViewIfNeeded();
      await addButton.click();
      await o.page.waitForTimeout(800);
      const cart = await o.page.evaluate(() => fetch('/cart.js').then((r) => r.json()));
      check(`${tag} Add to cart: the cart gets Jade Green's variant`, cart.items.some((it) => String(it.variant_id) === String(jg.id)), cart.items.map((it) => `${it.variant_id} ${it.title}`).join(', '));
      m.mockCart.lines.length = 0;
      await done(o);
    }
    {
      // a product with two options: the long one a dropdown, the short one buttons, and Sold out per combination
      const o = await open(width, height, '/products/paint-set-starter');
      const p0 = await o.page.evaluate(() => ({ dropdowns: [...document.querySelectorAll('variant-select')].map((v) => v.closest('fieldset').querySelector('legend').textContent.trim()), chips: [...document.querySelectorAll('.chip__input')].map((c) => c.value), thumbs: [...document.querySelectorAll('variant-select [role="option"] img')].length }));
      check(`${tag} two options: Colour (12) is a dropdown with pictures, Size (2) stays as buttons`, JSON.stringify(p0.dropdowns) === '["Colour"]' && JSON.stringify(p0.chips) === '["17ml","60ml"]' && p0.thumbs === 12, p0);
      await o.page.locator('.chip:has(input[value="60ml"])').click();
      await o.page.waitForTimeout(250);
      await o.page.click('[data-vselect-button]');
      await o.page.waitForTimeout(200);
      await o.page.locator('[role="option"][data-value="Gory Red"]').scrollIntoViewIfNeeded();
      const soldFlag = await o.page.evaluate(() => !document.querySelector('[role="option"][data-value="Gory Red"] [data-vselect-sold]').hidden);
      await o.page.locator('[role="option"][data-value="Imperial Blue"]').scrollIntoViewIfNeeded();
      await o.page.click('[role="option"][data-value="Imperial Blue"]');
      await o.page.waitForTimeout(300);
      const set = m.allProducts['paint-set-starter'];
      const want = set.variants.find((v) => v.options[0] === 'Imperial Blue' && v.options[1] === '60ml');
      const p1 = await o.page.evaluate(() => ({ id: document.querySelector('[data-variant-id]').value, url: location.search, name: document.querySelector('[data-vselect-name]').textContent.trim() }));
      check(`${tag} two options: 60ml then Imperial Blue picks the Imperial Blue / 60ml variant (Gory Red marked Sold out)`, p1.id === String(want.id) && p1.url === `?variant=${want.id}` && p1.name === 'Imperial Blue' && soldFlag, { ...p1, soldFlag });
      check(`${tag} two options: no console errors`, o.errors.length === 0, o.errors.slice(0, 2).join(' / '));
      await done(o);
    }

    /* ---------- 8. axe ---------- */
    if (process.env.AXE) {
      for (const [url, what, prep] of [['/', 'home', null], [VGC, 'product (closed)', null], [VGC, 'product (dropdown open)', async (page) => { await page.click('[data-vselect-button]'); await page.waitForTimeout(250); }], ['/pages/contact', 'contact', null]]) {
        const o = await open(width, height, url);
        if (prep) await prep(o.page);
        const v = await axe(o.page);
        check(`${tag} axe ${what}: no violations`, v.length === 0, v.join(' / '));
        await done(o);
      }
    } else {
      console.log(`SKIP ${tag} axe: set AXE to axe-core's axe.min.js`);
    }
  }
} catch (error) {
  check('the run itself', false, String(error.stack || error).slice(0, 500));
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${fails ? `${fails} failed` : 'all passed'}`);
process.exit(fails ? 1 : 0);

// Round 9, community: turnouts by game, lists of members and early access offers for regulars (contract
// v9-community). Mo: "the more you show up the more you get added into our list of say Pokemon turnouts … they will be
// the ones where we will give the option to buy our products before it goes to the rest of the shop".
// Demo mode on the theme mock, phone (390px) then desktop (1280px), each in a fresh browser (a fresh demo):
//   1. My Lair (Ruby, on the demo's open offer): the Early access card on Home (picture, name, price, "Just for you
//      until…", Gobgob's line, the limit), the quantity stepper, Buy now → Waiting for payment with Pay now, the demo's
//      pretend checkout → Got 2 / Got it, never anyone else's link
//   2. the staff page's Community tab: the game chips with their 3-month turnouts, the people sorted by each measure
//      (3 months, 12 months, all time, total spend), one game's people only, Top 10 this quarter ticks ten
//   3. a list: save the ticked people, open it, take someone off, rename it, delete it (it asks first)
//   4. early access: New offer, the product search (a draft product can't be picked, a published one warns), options,
//      limit, units, the list, the message, "Save and open…" asks "Open early access to … for N members and email
//      them?", it opens, its claims (Ruby paid), close (asks first)
//   5. walk-ins: Today's bookings has "Add a walk-in" on tonight's event: a member code checks them in (the fee to pay at
//      the counter), a second time is refused plainly, and the turnout counts on the Community tab
//   6. axe (WCAG 2.1 A and AA) on the Community tab, the offer form, the offer page, the walk-ins and the My Lair card;
//      a keyboard pass (the views, a tick, the selection bar; the card's stepper and Buy now); overflowX 0; no console
//      errors
// Screenshots go to OUT, or a folder in the system's temp directory. Without AXE (axe-core's axe.min.js) the axe part is
// skipped, and says so.
// Usage: DG_THEME=/path/to/theme PORT=4962 [AXE=/path/to/axe.min.js] [OUT=/dir] node tools/qa/round9/community.mjs [phone|desktop]
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
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round9-community');
const AXE = process.env.AXE || '';
const axe = AXE && fs.existsSync(AXE) ? fs.readFileSync(AXE, 'utf8') : null;
fs.mkdirSync(OUT, { recursive: true });
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4962);
const BASE = `http://localhost:${PORT}`;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };

/* ---------- the page clock: today, 1pm in Auckland (tonight's D&D one-off is today's event) ---------- */
const TZ = 'Pacific/Auckland';
const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const offset = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${key}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const iso = (key, hm) => `${key}T${hm}:00${offset(key)}`;
const today = lairKey(Date.now());
const AT = Date.parse(iso(today, '13:00'));
const CLOCK = `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;

const RUBY = { id: 7700112244, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [] };
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  return ok;
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const text = async (page, sel) => flat(await page.textContent(sel).catch(() => ''));
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function scan(page, label, selector) {
  if (!axe) return;
  await page.addScriptTag({ content: axe });
  const found = await page.evaluate(async (sel) => {
    const el = document.querySelector(sel);
    if (!el) return [`nothing at ${sel}`];
    const r = await window.axe.run(el, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  }, selector);
  check(`axe: ${label}: no WCAG 2.1 A/AA violations`, !found.length, found.join(' / '));
}
const shot = async (page, name, sel = null) => {
  const el = sel ? await page.$(sel) : null;
  await (el || page).screenshot({ path: `${OUT}/${name}.png`, ...(el ? {} : { fullPage: false }) }).catch(() => {});
};

const server = await m.serve(PORT);
const browser = await chromium.launch();
if (!axe) console.log('NOTE axe-core not given (AXE=…): the accessibility scans are skipped');

for (const size of process.argv[2] ? [process.argv[2]] : ['phone', 'desktop']) {
  const phone = size === 'phone';
  const tag = size;
  const ctx = await browser.newContext({ viewport: SIZES[size], deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(CLOCK);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()); });
  const open = async (where, customer) => {
    m.mockState.customer = customer;
    await page.goto('about:blank');
    await page.goto(`${BASE}${where}`, { waitUntil: 'networkidle', timeout: 60000 });
  };
  // a fresh demo, seeded with Ruby logged in, so the demo's open offer is hers too
  await open('/pages/my-lair', RUBY);
  await page.evaluate(() => localStorage.clear());
  await open('/pages/my-lair', RUBY);

  /* ---------- 1. My Lair: the Early access card ---------- */
  await page.waitForSelector('[data-home-offers] .ml-offer', { timeout: 20000 });
  const card = await page.evaluate(() => {
    const c = document.querySelector('[data-home-offers] .ml-offer');
    const q = (s) => (c.querySelector(s) || {}).textContent || '';
    return {
      flag: q('.ml-offer__flag'), title: q('.ml-offer__title'), price: q('.ml-offer__price'), until: q('.ml-offer__until').replace(/\s+/g, ' '), gob: q('.ml-offer__gob'),
      small: q('.ml-offer__small').replace(/\s+/g, ' '), buy: q('[data-offer-buy]').replace(/\s+/g, ' ').trim(), stepper: Boolean(c.querySelector('.stepper')),
      labelled: c.getAttribute('aria-labelledby') === c.querySelector('.ml-offer__title').id, hidden: c.closest('[data-home-offers]').hidden,
    };
  });
  check(`${tag}: My Lair Home shows the Early access card: flag, name, price, "Just for you until…"`,
    !card.hidden && card.flag === 'Early access' && card.title === 'Riftbound booster box' && card.price === '$219 each' && /^Just for you until \w{3} \d{1,2} \w{3}, 6pm$/.test(card.until) && card.labelled, card);
  check(`${tag}: Gobgob's line and the plain money words (limit, units left, a checkout for their account, 48 hours)`,
    card.gob === 'Gobgob saved you up to 2 before anyone else.' && /^Limit 2 a person · 6 left\. Buy now takes you to a checkout made for your account\. Pay within 48 hours, or it goes back for someone else\.$/.test(card.small), card);
  check(`${tag}: a stepper (up to 2) and Buy now with the price`, card.stepper && card.buy === 'Buy now · $219', card);
  await page.locator('[data-home-offers] .ml-offer').scrollIntoViewIfNeeded();
  await shot(page, `${tag}-mylair-offer`, '[data-home-offers] .ml-offer');
  await scan(page, `${tag} My Lair early access card`, '[data-home-offers]');
  // the stepper: + to 2 (then it stops), by keyboard
  await page.focus('[data-offer-step="1"]');
  await page.keyboard.press('Enter');
  const stepped = await page.evaluate(() => ({
    qty: document.querySelector('[data-home-offers] .stepper__value').textContent, plusOff: document.querySelector('[data-offer-step="1"]').disabled,
    buy: document.querySelector('[data-offer-buy]').textContent.replace(/\s+/g, ' ').trim(), focus: document.activeElement && document.activeElement.getAttribute('data-focus-key'),
  }));
  check(`${tag}: the stepper goes to 2, stops there, and the total follows (keyboard; focus stays on the stepper)`, stepped.qty === '2' && stepped.plusOff && stepped.buy === 'Buy now · $438' && /^(plus|minus)-/.test(stepped.focus || ''), stepped);
  await page.focus('[data-offer-buy]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-home-offers] .ml-offer__wait', { timeout: 10000 });
  const waiting = await page.evaluate(() => {
    const c = document.querySelector('[data-home-offers] .ml-offer');
    return { state: c.querySelector('.ml-offer__state').textContent.replace(/\s+/g, ' ').trim(), pay: (c.querySelector('[data-offer-demo-pay]') || {}).textContent, small: c.querySelector('.ml-offer__small').textContent.replace(/\s+/g, ' ').trim(), focus: document.activeElement && document.activeElement.className };
  });
  check(`${tag}: Buy now claims it: "Waiting for payment: 2 × Riftbound booster box: $438" with Pay now (focus on it)`,
    waiting.state === 'Waiting for payment 2 × Riftbound booster box: $438' && /Pay now · \$438/.test(waiting.pay || '') && /ml-offer__buy/.test(waiting.focus || ''), waiting);
  check(`${tag}: it says when to pay by, and that the checkout is theirs only`, /^Pay by \w{3} \d{1,2} \w{3}, \d{1,2}(:\d{2})?(am|pm), or it goes back for someone else\. The checkout is made for your account only\.$/.test(waiting.small), waiting);
  await shot(page, `${tag}-mylair-offer-waiting`, '[data-home-offers] .ml-offer');
  await page.click('[data-offer-demo-pay]');
  await page.waitForSelector('[data-home-offers] .ml-offer__state--got', { timeout: 10000 });
  const got = await text(page, '[data-home-offers] .ml-offer__state--got');
  check(`${tag}: paid (the demo's pretend checkout): "Got it! All 2 are paid for."`, got === 'Got it! All 2 are paid for. Your receipt is in your email.', got);
  await shot(page, `${tag}-mylair-offer-got`, '[data-home-offers] .ml-offer');
  check(`${tag}: My Lair: no horizontal scroll`, (await overflowX(page)) === 0, String(await overflowX(page)));

  /* ---------- 2. the Community tab: turnouts ---------- */
  await open('/pages/lair-staff#community', STAFF);
  await page.waitForSelector('staff-community .cm-table tbody tr', { timeout: 20000 });
  const tab = await page.evaluate(() => ({
    tab: (document.querySelector('#tab-community') || {}).textContent, selected: document.querySelector('#tab-community').getAttribute('aria-selected'), panel: !document.querySelector('#panel-community').hidden,
    chips: [...document.querySelectorAll('[data-cm-game]')].map((i) => i.closest('.chip').textContent.replace(/\s+/g, ' ').trim()),
    rows: document.querySelectorAll('.cm-table tbody tr').length, summary: document.querySelector('[data-cm-summary]').textContent,
  }));
  check(`${tag}: the staff page has a Community tab (#community opens it)`, /^Community/.test(tab.tab || '') && tab.selected === 'true' && tab.panel, tab);
  check(`${tag}: game chips: All games, then each game with its 3-month turnouts`, tab.chips[0] === 'All games' && tab.chips.length > 2 && tab.chips.slice(1).every((c) => /\S \d+$/.test(c)), tab.chips);
  const measures = async () => page.evaluate(() => [...document.querySelectorAll('.cm-table tbody tr')].map((tr) => [...tr.querySelectorAll('td.cm-num')].map((td) => Number(td.textContent.replace(/[$,]/g, '')))));
  const sortedBy = (rows, i) => rows.every((r, n) => n === 0 || rows[n - 1][i] >= r[i]);
  const byM3 = await measures();
  check(`${tag}: people sorted by the last 3 months to start with`, byM3.length > 5 && sortedBy(byM3, 0), byM3.slice(0, 6));
  for (const [value, i, label] of [['12m', 1, 'the last 12 months'], ['all', 2, 'all time'], ['spend', 3, 'total spend']]) {
    await page.check(`[data-cm-sort][value="${value}"]`);
    await page.waitForFunction((v) => {
      const th = document.querySelector(`[data-cm-sortby="${v}"]`);
      return th && th.closest('th').getAttribute('aria-sort') === 'descending';
    }, value, { timeout: 10000 });
    check(`${tag}: sort by ${label}`, sortedBy(await measures(), i), (await measures()).slice(0, 5));
  }
  await page.check('[data-cm-sort][value="3m"]');
  await page.waitForTimeout(300);
  const game = await page.evaluate(() => document.querySelectorAll('[data-cm-game]')[1].value);
  await page.check(`[data-cm-game][value="${game}"]`);
  await page.waitForTimeout(400);
  const oneGame = await page.evaluate((g) => ({ summary: document.querySelector('[data-cm-summary]').textContent, rows: document.querySelectorAll('.cm-table tbody tr').length, stats: window.Lair.store.backend.communityStats({ game: g }) }), game);
  const stats = await page.evaluate((g) => window.Lair.store.backend.communityStats({ game: g, sort: '3m' }), game);
  check(`${tag}: one game shows only its people, with their numbers for it`, oneGame.rows === Math.min(100, stats.total) && /turned up for /.test(oneGame.summary) && stats.members.every((x) => x.turnouts.all > 0), { rows: oneGame.rows, total: stats.total, summary: oneGame.summary });
  await page.check('[data-cm-game][value="all"]');
  await page.waitForTimeout(400);
  await shot(page, `${tag}-community-turnouts`);
  await scan(page, `${tag} Community tab (turnouts)`, 'staff-community');
  // keyboard: a tick by Space, then the selection bar's buttons
  await page.focus('.cm-table tbody tr [data-cm-tick]');
  await page.keyboard.press('Space');
  const kb = await page.evaluate(() => ({ ticked: document.querySelectorAll('[data-cm-tick]:checked').length, bar: !document.querySelector('[data-cm-selbar]').hidden, count: (document.querySelector('.cm-selbar__count') || {}).textContent }));
  check(`${tag}: keyboard: Space ticks someone and the selection bar appears`, kb.ticked === 1 && kb.bar && /1 ticked/.test(kb.count || ''), kb);
  await page.click('[data-cm-clear]');
  await page.click('[data-cm-top="3m"]');
  await page.waitForTimeout(500);
  const top = await page.evaluate(() => ({ ticked: document.querySelectorAll('[data-cm-tick]:checked').length, count: document.querySelector('.cm-selbar__count').textContent.replace(/\s+/g, ' ').trim() }));
  check(`${tag}: Top 10 this quarter ticks ten`, top.ticked === 10 && /^10 ticked/.test(top.count), top);
  await shot(page, `${tag}-community-ticked`);

  /* ---------- 3. a list ---------- */
  await page.click('[data-cm-selmode="save"]');
  const nameNow = await page.inputValue('#cm-list-name');
  check(`${tag}: Save as a list suggests a name (focus in it)`, /^Regulars, \w{3}$/.test(nameNow) && (await page.evaluate(() => document.activeElement && document.activeElement.id)) === 'cm-list-name', nameNow);
  await page.fill('#cm-list-name', `Quarter's regulars ${tag}`);
  await page.click('[data-cm-savelist] [type="submit"]');
  await page.waitForSelector('[data-cm-list-head] h3', { timeout: 10000 });
  const list = await page.evaluate(() => ({ h: document.querySelector('[data-cm-list-head] h3').textContent, count: document.querySelector('[data-cm-list-count]').textContent, people: document.querySelectorAll('[data-cm-list-people] .sa-person').length, focus: document.activeElement && document.activeElement.tagName }));
  check(`${tag}: the list is saved with the 10 and opens (focus on its heading)`, list.h === `Quarter's regulars ${tag}` && list.count === 'People (10)' && list.people === 10 && list.focus === 'H3', list);
  await page.locator('[data-cm-list-drop]').first().click();
  await page.waitForFunction(() => document.querySelector('[data-cm-list-count]').textContent === 'People (9)', null, { timeout: 10000 });
  check(`${tag}: take someone off: 9 on it`, true);
  await page.click('.staff-gm__more summary');
  await page.fill('#cm-list-edit-name', `Regulars ${tag}`);
  await page.click('[data-cm-list-edit] [type="submit"]');
  await page.waitForFunction((n) => document.querySelector('[data-cm-list-head] h3').textContent === n, `Regulars ${tag}`, { timeout: 10000 });
  check(`${tag}: rename it`, true);
  await page.click('[data-cm-confirm^="delete-list:"]');
  const asks = await text(page, '[data-cm-list-danger] .staff-confirm p');
  check(`${tag}: delete asks first, plainly`, asks === `Delete Regulars ${tag}? The list goes. Offers made from it keep their people.`, asks);
  await page.click('[data-cm-cancel]');
  check(`${tag}: Keep it keeps it`, await page.isVisible('[data-cm-confirm^="delete-list:"]'));

  /* ---------- 4. early access: a new offer ---------- */
  await page.click('[data-cm-view="offers"]');
  await page.waitForSelector('[data-cm-offers] .cm-offer', { timeout: 10000 });
  const seeded = await text(page, '[data-cm-offers] .cm-offer');
  check(`${tag}: the offers list: the open Riftbound offer, its people, closing time and units (Ruby's 2 paid)`, /^Riftbound booster box Open 3 people · Riftbound regulars · closes \w{3} \d{1,2} \w{3}, 6pm 2 of 6 claimed \(2 paid\) · 4 left$/.test(seeded), seeded);
  await page.click('[data-cm-new-offer]');
  await page.waitForSelector('[data-cm-offer-form]');
  await page.fill('#cm-product-q', 'co');
  await page.waitForSelector('.cm-result', { timeout: 10000 });
  const results = await page.evaluate(() => [...document.querySelectorAll('.cm-result')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
  check(`${tag}: the product search finds products, hidden ones too, and says a draft can't be sold`, results.some((r) => /Warhammer 40,000 combat patrol .*A draft in Shopify: it can’t be sold/.test(r)), results);
  await page.click('.cm-result[aria-disabled="true"]', { force: true });
  const refused = await text(page, '[data-cm-results]');
  check(`${tag}: picking the draft product says why not`, /is a draft in Shopify, so it can’t be sold\. Make it Active first/.test(refused), refused);
  await page.fill('#cm-product-q', 'trainer');
  await page.waitForFunction(() => [...document.querySelectorAll('.cm-result')].some((r) => /elite trainer/.test(r.textContent)), null, { timeout: 10000 });
  await page.click('.cm-result:has-text("elite trainer")');
  const picked = await text(page, '.cm-picked');
  check(`${tag}: a product on the online store warns plainly`, /Pokémon elite trainer box ?Anyone can buy this online right now\. Hide it from the online store in Shopify until early access ends\./.test(picked), picked);
  await page.check('[data-cm-variant][value="9200002"]');
  await page.check('[data-cm-variant][value="9200003"]');
  await page.fill('#cm-per', '1');
  await page.fill('#cm-units', '4');
  const listId = await page.evaluate(() => [...document.querySelectorAll('#cm-offer-list option')].find((o) => /Riftbound regulars/.test(o.textContent)).value);
  await page.selectOption('#cm-offer-list', listId);
  await page.fill('#cm-message', 'One each, friends.');
  const forCount = await text(page, '[data-cm-forcount]');
  check(`${tag}: who it's for: the list and its count`, /^3 people: Riftbound regulars \(3\)\.$/.test(forCount), forCount);
  await shot(page, `${tag}-offer-form`);
  await scan(page, `${tag} the new offer form`, '[data-cm-offer-form]');
  await page.click('[data-cm-save-open]');
  await page.waitForSelector('.cm-confirm', { timeout: 10000 });
  const ask = await text(page, '.cm-confirm p');
  check(`${tag}: "Save and open…" asks plainly first: "Open early access to Pokémon elite trainer box for 3 members and email them?"`,
    /^Open early access to Pokémon elite trainer box for 3 members and email them\? They’ll see it in My Lair straight away\. It closes \w{3} \d{1,2} \w{3}, 6pm\./.test(ask), ask);
  await page.click('[data-cm-open]');
  await page.waitForSelector('[data-cm-offer-head] h3', { timeout: 10000 });
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => ({ h: document.querySelector('[data-cm-offer-head] h3').textContent, status: document.querySelector('[data-cm-offer-head] .cm-status').textContent, warn: (document.querySelector('.cm-warn') || {}).textContent || '', claims: document.querySelector('[data-cm-claims]').textContent.trim(), facts: document.querySelector('.cm-facts').textContent.replace(/\s+/g, ' ') }));
  check(`${tag}: it opens: status Open, the warning stays, no claims yet`, opened.h === 'Pokémon elite trainer box' && opened.status === 'Open' && /Anyone can buy this online/.test(opened.warn) && opened.claims === 'No claims yet.', opened);
  check(`${tag}: the offer's facts: options with prices, the limit, units, email`, /Options ?Pikachu · \$89\.95, Eevee · \$89\.95/.test(opened.facts) && /Limit ?1 a person/.test(opened.facts) && /Units ?0 of 4 claimed \(0 paid\) · 4 left/.test(opened.facts) && /For ?3 people · list: Riftbound regulars/.test(opened.facts) && /Email ?Emailed/.test(opened.facts), opened.facts);
  await shot(page, `${tag}-offer-page`);
  await scan(page, `${tag} an offer's page`, 'staff-community');
  await page.click('[data-cm-confirm^="close:"]');
  const closeAsk = await text(page, '[data-cm-offer-actions] .staff-confirm p');
  check(`${tag}: closing asks first, plainly`, closeAsk === 'Close early access to Pokémon elite trainer box now? Unpaid claims are let go and their checkout links stop working. Paid ones stay paid.', closeAsk);
  await page.click('[data-cm-cancel]');
  // the seeded offer: Ruby's claim, paid
  await page.click('[data-cm-back]');
  await page.locator('[data-cm-open-offer]', { has: page.locator('.cm-offer__title', { hasText: 'Riftbound booster box' }) }).click();
  await page.waitForFunction(() => document.querySelectorAll('.cm-claim').length > 0, null, { timeout: 10000 }).catch(() => {});
  const claims = await page.evaluate(() => [...document.querySelectorAll('.cm-claim')].map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
  check(`${tag}: the claims: Ruby, 2 × Riftbound booster box, $438, Paid`, claims.some((c) => /^Ruby Tane [A-Z]{2}-[A-Z]+-\d+ 2 × Riftbound booster box · \$438 Paid/.test(c)), claims);

  /* ---------- 5. walk-ins at today's events ---------- */
  await page.click('#tab-today');
  await page.waitForSelector('staff-walkins .cm-walkin', { timeout: 15000 });
  const walk = await page.evaluate(() => [...document.querySelectorAll('staff-walkins .cm-walkin')].map((li) => ({ id: li.dataset.walkin, text: li.querySelector('.cm-walkin__what').textContent.replace(/\s+/g, ' ').trim() })));
  const dnd = walk.find((w) => /^Dungeons & Dragons 6pm · \$15 entry$/.test(w.text));
  check(`${tag}: Today's bookings lists today's events with "Add a walk-in"`, Boolean(dnd), walk);
  const mia = await page.evaluate(() => {
    const x = window.Lair.store.backend.staffMembers().find((p) => p.name === 'Mia Chen');
    return { id: String(x.customerId), code: x.code };
  });
  const before = await page.evaluate(() => window.Lair.store.backend.communityStats({}).then((s) => s.games.reduce((n, g) => n + g.turnouts.all, 0)));
  await page.click(`[data-walkin-toggle="${dnd.id}"]`);
  const focusIn = await page.evaluate(() => document.activeElement && document.activeElement.name);
  await page.fill(`[data-walkin-form="${dnd.id}"] input`, mia.code.toLowerCase());
  await page.press(`[data-walkin-form="${dnd.id}"] input`, 'Enter');
  await page.waitForFunction((id) => /Walk-in added/.test(document.querySelector(`[data-walkin="${id}"] [data-walkin-msg]`).textContent), dnd.id, { timeout: 10000 });
  const said = await text(page, `[data-walkin="${dnd.id}"] [data-walkin-msg]`);
  check(`${tag}: a member code (any case) adds them, checked in, with the entry to pay at the counter (focus went to the code)`, focusIn === 'code' && said === 'Walk-in added and checked in: Mia Chen for Dungeons & Dragons. Charge $15.', { focusIn, said });
  await page.fill(`[data-walkin-form="${dnd.id}"] input`, mia.code);
  await page.press(`[data-walkin-form="${dnd.id}"] input`, 'Enter');
  await page.waitForFunction((id) => /already/.test(document.querySelector(`[data-walkin="${id}"] [data-walkin-msg]`).textContent), dnd.id, { timeout: 10000 });
  const twice = await text(page, `[data-walkin="${dnd.id}"] [data-walkin-msg]`);
  check(`${tag}: a second time is refused plainly`, twice === 'Mia Chen is already checked in at Dungeons & Dragons.', twice);
  const after = await page.evaluate(() => window.Lair.store.backend.communityStats({}).then((s) => s.games.reduce((n, g) => n + g.turnouts.all, 0)));
  check(`${tag}: the walk-in counts as a turnout`, after === before + 1, { before, after });
  const here = await page.evaluate((id) => [...document.querySelectorAll('.staff-join__item')].some((li) => /Mia Chen/.test(li.textContent) && /Here/.test(li.textContent)), dnd.id);
  check(`${tag}: Today's sign-ups show Mia as here`, here);
  await page.locator('staff-walkins').scrollIntoViewIfNeeded();
  await shot(page, `${tag}-walkins`, 'staff-walkins');
  await scan(page, `${tag} walk-ins`, 'staff-walkins');

  check(`${tag}: the staff page: no horizontal scroll`, (await overflowX(page)) === 0, String(await overflowX(page)));
  check(`${tag}: no console errors`, errors.length === 0, errors.slice(0, 5));
  await ctx.close();
}

await browser.close();
server.close?.();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

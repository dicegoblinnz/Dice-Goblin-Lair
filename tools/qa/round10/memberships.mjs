// Round 10, memberships (contract v10-memberships, section 6): the theme side of the Lair billing the library itself.
// Demo mode on the theme mock, phone (390px) then desktop (1280px), each in a fresh browser context (a fresh demo).
// Prints a PASS or FAIL line per check, then a summary (exit 1 when anything failed).
//   1. The membership product page: the Lair's plans (Grab, Stash and Hoard, matched by name), Stash picked first, the
//      "Good to know before you join" points by the button, the small print and the FAQ (cancel in My Lair, damage).
//   2. My Lair › Library for a member: damage charges to sort first, "Your membership" (plan, next bill, card, payments),
//      Update my card (then the hourly limit), Change plan (from the next bill), Cancel (asks first) and Keep my
//      membership, and "Tell us we've got it wrong". Home's Library card from GET /me. Then each state by ?membership=:
//      past due (borrowing paused, said first), a bank check, ended, paused, and none (the join card).
//   3. A library game's page: a Lair member with no tags gets Reserve, and the Join parts go; a payment outstanding
//      pauses it; nobody's plan, Join.
//   4. The staff page: Memberships and Damage tabs after Library; Memberships (billing, counts, problems first, filters,
//      search, Retry, End asks first); Damage (the open list in order, settle store credit, Charge now from store credit
//      and on a card that goes through, waive, a new amount, logging one from a game at home and one charged now, the
//      same key twice is one charge); a member's page (their membership and damage charges); Library's "Damage charge".
//   5. axe (WCAG 2.1 A and AA) on the join form, My Library and both tabs; no sideways scroll; no console errors.
// Screenshots go to OUT (or a folder in the system's temp directory). Without AXE the axe part is skipped and says so.
// Usage: DG_THEME=/path/to/theme QA_PORT=4951 [AXE=/path/to/axe.min.js] [OUT=/dir] node tools/qa/round10/memberships.mjs [phone|desktop]
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
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round10-memberships');
const AXE = process.env.AXE || '';
const axe = AXE && fs.existsSync(AXE) ? fs.readFileSync(AXE, 'utf8') : null;
fs.mkdirSync(OUT, { recursive: true });
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.QA_PORT || process.env.PORT || 4951);
const BASE = `http://localhost:${PORT}`;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };

/* ---------- the membership product with the Lair's plans (Lair Memberships made them: one group, three plans) ---------- */
const membership = m.allProducts['board-game-rental-monthly'];
const lairPlan = (id, name, cents) => ({
  id, name, description: '', group_id: '6605537383', recurring_deliveries: true, selected: false, options: [{ name: 'Plan', position: 1, value: name }],
  price_adjustments: [{ position: 1, order_count: null, value_type: 'price', value: cents }], checkout_charge: { value_type: 'percentage', value: 100 },
});
const PLANS = [lairPlan(12303630439, 'Grab', 3000), lairPlan(12303663207, 'Stash', 6000), lairPlan(12303695975, 'Hoard', 7500)];
const allocation = (plan) => ({
  selling_plan: plan, selling_plan_group_id: plan.group_id, price: plan.price_adjustments[0].value, compare_at_price: 3000, per_delivery_price: plan.price_adjustments[0].value,
  checkout_charge_amount: plan.price_adjustments[0].value, remaining_balance_charge_amount: 0, price_adjustments: [{ position: 1, price: plan.price_adjustments[0].value }], unit_price: null,
});
// Stash first in Shopify's list too, so matching by name (not position) is what puts each price on its card
membership.selling_plan_groups = [{ id: '6605537383', name: 'Library membership', app_id: null, selling_plan_selected: false, options: [{ name: 'Plan', position: 1, values: ['Stash', 'Grab', 'Hoard'], selected_value: null }], selling_plans: [PLANS[1], PLANS[0], PLANS[2]] }];
membership.variants[0].selling_plan_allocations = [allocation(PLANS[1]), allocation(PLANS[0]), allocation(PLANS[2])];
membership.selected_or_first_available_selling_plan_allocation = membership.variants[0].selling_plan_allocations[0];

const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const RUBY = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [] };

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 700)}`);
  return ok;
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function scan(page, label, selector) {
  if (!axe) return;
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ content: axe });
  const found = await page.evaluate(async (sel) => {
    const r = await window.axe.run(document.querySelector(sel), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  }, selector);
  check(`axe: ${label}: no WCAG 2.1 A/AA violations`, !found.length, found.join(' / '));
}
const shot = async (page, name, sel = null, full = false) => {
  const el = sel ? await page.$(sel) : null;
  await (el || page).screenshot({ path: `${OUT}/${name}.png`, ...(el ? {} : { fullPage: full }) }).catch(() => {});
};
const text = async (page, sel) => flat(await page.textContent(sel).catch(() => ''));
const toastText = async (page) => flat(await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')).catch(() => ''));
/** Wait for an element's words to match (Playwright selectors, so :has() and :text-is() work) */
const waitText = async (page, sel, re, timeout = 6000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (re.test(flat(await page.textContent(sel, { timeout: 500 }).catch(() => '')))) return true;
    await page.waitForTimeout(150);
  }
  return false;
};

const server = await m.serve(PORT);
const browser = await chromium.launch();
if (!axe) console.log('SKIP axe: set AXE to axe-core’s axe.min.js to run it');

for (const size of process.argv[2] ? [process.argv[2]] : ['phone', 'desktop']) {
  const tag = size;
  const phone = size === 'phone';
  const ctx = await browser.newContext({ viewport: SIZES[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(`${page.url()}: ${msg.text()}`); });
  const open = async (url, customer, wait = 600) => {
    m.mockState.customer = customer;
    await page.goto('about:blank');
    await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(wait);
  };

  /* ---------- 1. the membership product page ---------- */
  await open('/products/board-game-rental-monthly', RUBY);
  const cards = await page.$$eval('.plan', (els) => els.map((el) => ({
    name: el.querySelector('.plan__name')?.textContent.trim(), price: el.querySelector('.plan__amount')?.textContent.trim(),
    value: el.querySelector('.plan__input')?.value, checked: el.querySelector('.plan__input')?.checked, disabled: el.querySelector('.plan__input')?.disabled,
  })));
  check(`${tag}: product page: Grab $30, Stash $60 and Hoard $75, each with its own Lair plan (matched by name)`,
    JSON.stringify(cards.map((c) => [c.name, c.price, c.value])) === JSON.stringify([['Grab', '$30', '12303630439'], ['Stash', '$60', '12303663207'], ['Hoard', '$75', '12303695975']]), cards);
  check(`${tag}: product page: Stash is picked to start, and every plan can be picked`, cards.map((c) => c.checked).join() === 'false,true,false' && cards.every((c) => !c.disabled), cards);
  const summary = await text(page, '.join__summary');
  check(`${tag}: product page: "Good to know before you join" sits by the button with the four points`, /^Good to know before you join/.test(summary)
    && /Monthly\. You pay for your first month today, then it renews each month until you cancel\./.test(summary)
    && /Cancel any time in My Lair\. Your membership runs to the end of the month you've paid for, with no more bills\./.test(summary)
    && /Change plans in My Lair\. The new plan and price start from your next bill\./.test(summary)
    && /Missing bits or damage can be charged up to the game's RRP\. We email you first\. Usually it goes on your next bill after 7 days, so there's time to bring the bits back or tell us we've got it wrong, but we can also take it straight away from your store credit or the card on your membership\./.test(summary), summary);
  const order = await page.evaluate(() => {
    const s = document.querySelector('.join__summary');
    const b = document.querySelector('.join__button');
    return Boolean(s && b && s.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  check(`${tag}: product page: the points come just before the join button`, order);
  check(`${tag}: product page: the small print: renews monthly, cancel in My Lair`, (await text(page, '.join__note')) === 'Renews monthly until you cancel. Cancel any time in My Lair.', await text(page, '.join__note'));
  const label = await text(page, '.join__button');
  check(`${tag}: product page: the button says the plan picked and its price`, /Join Stash/.test(label) && /\$60 a month/.test(label), label);
  const faq = await text(page, '.faq, [class*="faq"]');
  check(`${tag}: product page FAQ: cancel in My Lair, change plans there, damage after an emailed notice, and failed payments`,
    /Cancel any time in My Lair, under Library\./.test(faq) && /Pick a bigger or smaller plan and it starts from your next bill\./.test(faq)
    && /We email you first with what's missing and what it costs\./.test(faq) && /What if a payment doesn't go through\?/.test(faq) && !/Get in touch any time before your next billing date/.test(faq), faq.slice(0, 400));
  await page.click('.plan:nth-of-type(3) .plan__card').catch(() => page.click('text=Hoard'));
  await page.waitForTimeout(200);
  check(`${tag}: product page: picking Hoard says Join Hoard, $75 a month`, /Join Hoard/.test(await text(page, '.join__button')) && /\$75 a month/.test(await text(page, '.join__button')), await text(page, '.join__button'));
  check(`${tag}: product page: no sideways scroll`, (await overflowX(page)) === 0, await overflowX(page));
  await page.locator('.join__summary').scrollIntoViewIfNeeded();
  await shot(page, `${tag}-1-product-plans`, null, false);
  await shot(page, `${tag}-1-product-summary`, '.join');
  await scan(page, `${tag}: the plans and the join form`, '.library-plans');
  await open('/pages/board-game-rental', RUBY);
  const lib = await text(page, 'main');
  check(`${tag}: library page: the same points, small print and FAQ (holds on the game's page, plan changes in My Lair)`,
    /Good to know before you join/.test(lib) && /Renews monthly until you cancel\. Cancel any time in My Lair\./.test(lib)
    && /Reserve it on the game's page and we'll hold it until midnight on the third day/.test(lib) && /Yes, in My Lair, under Library\./.test(lib), lib.slice(0, 300));

  /* ---------- 2. My Lair › Library for a member ---------- */
  await open('/pages/my-lair', RUBY);
  await page.evaluate(() => localStorage.clear());
  // Ruby has no library tags: the demo gives her a membership when the page asks (the Lair app would have one from checkout)
  await open('/pages/my-lair?membership=active#library', RUBY, 900);
  await page.waitForSelector('my-library .mlib-member', { timeout: 8000 }).catch(() => {});
  const member = await text(page, 'my-library .mlib-member');
  check(`${tag}: My Library: "Your membership" with Stash, Active, 3 games at a time, $60 a month`, /Your membership/.test(member) && /Stash/.test(member) && /Active/.test(member) && /3 games at a time · \$60 a month/.test(member), member);
  check(`${tag}: My Library: the next bill with its date and amount, the card, and member since`, /Next bill\s*\w{3} \d{1,2} \w{3,4} · \$60/.test(member) && /Visa ending 4242 · expires 08\/28/.test(member) && /Member since/.test(member), member);
  check(`${tag}: My Library: Update my card, Change plan and Cancel my membership`, await page.isVisible('[data-mem-card]') && await page.isVisible('[data-mem-plans]') && await page.isVisible('[data-mem-cancel]'));
  const lists = await page.$$eval('my-library .mlib-lists > *', (els) => els.map((el) => el.className));
  check(`${tag}: My Library: damage charges to sort come first, before the games`, /mlib-damage/.test(lists[0] || ''), lists);
  const dmg = await text(page, 'my-library .mlib-damage');
  check(`${tag}: My Library: the notice (Ticket to Ride: Europe, $9.50, missing parts) with when it's due, and the paid one says how`,
    /Ticket to Ride: Europe/.test(dmg) && /\$9\.50/.test(dmg) && /Missing parts: 5 blue trains/.test(dmg) && /Due \w{3} \d{1,2} \w{3,4}\. Until then there’s time to bring the bits back or tell us we’ve got it wrong\./.test(dmg)
    && /Codenames/.test(dmg) && /Paid on your bill/.test(dmg), dmg);
  check(`${tag}: My Library: payments fold away under "Recent payments"`, await page.isVisible('my-library .mlib-member__paid summary') && !(await page.isVisible('my-library .mlib-member__charges')));
  await page.click('my-library .mlib-member__paid summary');
  check(`${tag}: My Library: opened, the payments say what and how`, /Membership/.test(await text(page, 'my-library .mlib-member__charges')) && /Damage charges/.test(await text(page, 'my-library .mlib-member__charges')) && /Paid/.test(await text(page, 'my-library .mlib-member__charges')), await text(page, 'my-library .mlib-member__charges'));
  // Home's Library card: from GET /me
  const home = await page.evaluate(() => [document.querySelector('[data-sum="library"]')?.textContent, document.querySelector('[data-sum="library-label"]')?.textContent].join(' | '));
  check(`${tag}: Home's Library card: "0 of 3 games on your plan" from GET /me (no tags needed)`, home === '0 of 3 | games on your plan', home);
  await shot(page, `${tag}-2-my-library`, 'my-library');
  await scan(page, `${tag}: My Library with a membership`, 'my-library');
  // Update my card, then again within the hour
  await page.click('[data-mem-card]');
  check(`${tag}: Update my card: Shopify's emailed a secure link`, await waitText(page, '[data-mem-say]', /Shopify’s emailed you a secure link to update your card|Shopify's emailed you a secure link to update your card/), await text(page, '[data-mem-say]'));
  await page.click('[data-mem-card]');
  check(`${tag}: Update my card again: the Lair app's hourly limit, said plainly`, await waitText(page, '[data-mem-say]', /Shopify sent you a link in the last hour\. Check your inbox, and your spam folder too\./), await text(page, '[data-mem-say]'));
  // Change plan
  await page.click('[data-mem-plans]');
  await page.waitForSelector('[data-mem-change-form]');
  const opts = (await page.$$eval('.mlib-plan-opt', (els) => els.map((el) => el.textContent))).map(flat);
  check(`${tag}: Change plan: the three plans, Stash marked as theirs, and the button waits for a new pick`,
    opts.length === 3 && (await text(page, '.mlib-plan-opt.is-current')).includes('Your plan') && (await page.isDisabled('[data-mem-change-form] [type="submit"]')), opts);
  check(`${tag}: Change plan: when it starts`, /It starts from your next bill on \w{3} \d{1,2} \w{3,4}, so you keep Stash until then\./.test(await text(page, '[data-mem-change-form] .mlib-note')), await text(page, '[data-mem-change-form] .mlib-note'));
  await page.check('[data-mem-tier][value="hoard"]');
  check(`${tag}: picking Hoard: "Change to Hoard"`, (await text(page, '[data-mem-change-form] [type="submit"]')) === 'Change to Hoard', await text(page, '[data-mem-change-form] [type="submit"]'));
  await page.click('[data-mem-change-form] [type="submit"]');
  check(`${tag}: Change to Hoard: done, from the next bill`, await waitText(page, '[data-mem-say]', /Done\. You’re on Hoard from your next bill on \w{3} \d{1,2} \w{3,4}\./), await text(page, '[data-mem-say]'));
  check(`${tag}: the card says Hoard comes from the next bill`, /From your next bill: Hoard, 5 games at a time · \$75 a month\./.test(await text(page, 'my-library .mlib-member')), await text(page, 'my-library .mlib-member'));
  // Cancel asks first, then Keep my membership
  await page.click('[data-mem-cancel]');
  const ask = await text(page, '#mlib-cancel-q');
  check(`${tag}: Cancel asks first, saying when it ends`, /^Cancel your membership\? It runs until \w{3} \d{1,2} \w{3,4}, the end of the month you’ve paid for, and there are no more bills\. You can change your mind until then\.$/.test(ask), ask);
  check(`${tag}: focus moves to the question`, await page.evaluate(() => document.activeElement && document.activeElement.id === 'mlib-cancel-q'));
  await page.click('[data-mem-close][data-key="mem-keep"]');
  check(`${tag}: Keep it: no change, focus back on Cancel my membership`, (await page.evaluate(() => document.activeElement && document.activeElement.matches('[data-mem-cancel]'))) && /Active/.test(await text(page, '.mlib-member__head')));
  await page.click('[data-mem-cancel]');
  await page.click('[data-mem-cancel-yes]');
  check(`${tag}: Yes, cancel it: it runs until the paid month ends, with Keep it on offer`, await waitText(page, '[data-mem-say]', /Cancelled\. Your membership runs until \w{3} \d{1,2} \w{3,4}, with no more bills\./), await text(page, '[data-mem-say]'));
  check(`${tag}: cancelled: the badge says Ending, and "Keep my membership" shows`, /Ending/.test(await text(page, '.mlib-member__head')) && await page.isVisible('[data-mem-resume]'), await text(page, '.mlib-member__head'));
  await page.click('[data-mem-resume]');
  check(`${tag}: Keep my membership: staying, with the next bill`, await waitText(page, '[data-mem-say]', /You’re staying! Your membership carries on, and your next bill is \w{3} \d{1,2} \w{3,4}\./), await text(page, '[data-mem-say]'));
  // Tell us we've got it wrong
  await page.click('[data-mem-dispute]');
  await page.waitForSelector('[data-mem-dispute-form] textarea');
  check(`${tag}: "Tell us we've got it wrong": a box for what happened, focused`, await page.evaluate(() => document.activeElement && document.activeElement.matches('textarea[data-mem-note]')));
  await page.fill('[data-mem-dispute-form] textarea', 'The trains were all there when I brought it back.');
  await page.click('[data-mem-dispute-form] [type="submit"]');
  check(`${tag}: sent: on hold while we look into it, said by the damage charges`, await waitText(page, '.mlib-damage [data-mem-say]', /Thanks\. It’s on hold while we look into it, and we’ll be in touch\./), await text(page, '.mlib-damage'));
  check(`${tag}: the charge now says it's on hold, with what they said`, /On hold while we look into it\. Nothing’s charged in the meantime\./.test(await text(page, '.mlib-fee--disputed')) && /You said: “The trains were all there when I brought it back\.”/.test(await text(page, '.mlib-fee--disputed')), await text(page, '.mlib-damage'));
  check(`${tag}: My Library: no sideways scroll`, (await overflowX(page)) === 0, await overflowX(page));
  // a payment that didn't go through: said first, on the plan card
  await open('/pages/my-lair?membership=past_due#library', RUBY, 900);
  const top = await text(page, 'my-library .mlib-top');
  check(`${tag}: past due: borrowing's paused, said first on the plan card`, /Borrowing’s paused because your last library payment didn’t go through\. Update your card under Your membership and Gobgob tries again\. Returning games still works\./.test(top), top);
  const pd = await text(page, 'my-library .mlib-member');
  check(`${tag}: past due: "Payment didn't go through", when it's tried again, and Update my card`, /Payment didn’t go through/.test(pd) && /Otherwise we’ll try again \w{3} \d{1,2} \w{3,4}\./.test(pd) && await page.isVisible('[data-mem-card]') && !(await page.isVisible('[data-mem-plans]')), pd);
  check(`${tag}: past due: Home's card says borrowing's paused`, (await page.evaluate(() => document.querySelector('[data-sum="library-more"]')?.textContent)) === 'Borrowing paused: see your membership');
  await shot(page, `${tag}-2-past-due`, 'my-library');
  await open('/pages/my-lair?membership=bank#library', RUBY, 900);
  check(`${tag}: a bank check: look for Shopify's email`, /Borrowing’s paused while your bank confirms your last library payment\. Look for the email from Shopify, and check your spam folder too\./.test(await text(page, 'my-library .mlib-top')) && /Waiting on your bank/.test(await text(page, 'my-library .mlib-member')), await text(page, 'my-library .mlib-top'));
  await open('/pages/my-lair?membership=ended#library', RUBY, 900);
  const ended = await text(page, 'my-library');
  check(`${tag}: ended: "Membership ended" with See the plans, and the membership says when`, /Membership ended/.test(ended) && /Your membership has ended, so borrowing and reserving are off for now\./.test(ended) && /Your membership ended \w{3} \d{1,2} \w{3,4}\./.test(ended) && await page.isVisible('my-library .mlib-join a.button'), ended.slice(0, 500));
  check(`${tag}: ended: Home's card says Ended`, (await page.evaluate(() => document.querySelector('[data-sum="library"]')?.textContent)) === 'Ended');
  await open('/pages/my-lair?membership=paused#library', RUBY, 900);
  check(`${tag}: paused: "Membership paused", ask at the counter`, /Membership paused/.test(await text(page, 'my-library .mlib-top')) && /Ask us at the counter to start it again\./.test(await text(page, 'my-library .mlib-top')), await text(page, 'my-library .mlib-top'));
  await open('/pages/my-lair?membership=none#library', RUBY, 900);
  check(`${tag}: no membership: the join card, and no membership section`, /Join the library/.test(await text(page, 'my-library .mlib-top')) && !(await page.$('my-library .mlib-member')), await text(page, 'my-library'));
  check(`${tag}: no membership: Home's card says Join the library`, (await page.evaluate(() => [document.querySelector('[data-sum="library"]')?.textContent, document.querySelector('[data-sum="library-label"]')?.textContent].join(' '))) === 'Join the library');

  /* ---------- 3. a library game's page ---------- */
  await open('/pages/my-lair?membership=active', RUBY, 600);
  await open('/products/library', RUBY, 1200);
  await page.waitForSelector('library-reserve [data-reserve]', { timeout: 6000 }).catch(() => {});
  check(`${tag}: library game: a Lair member with no tags can reserve it`, await page.isVisible('library-reserve [data-reserve]'), await text(page, 'library-reserve'));
  check(`${tag}: library game: the borrow card's Join parts go for a member`, await page.evaluate(() => [...document.querySelectorAll('[data-borrow-join]')].every((el) => el.hidden || !el.offsetParent)));
  await open('/pages/my-lair?membership=past_due', RUBY, 600);
  await open('/products/library', RUBY, 1200);
  check(`${tag}: library game: a payment outstanding pauses reserving, with the way to sort it`, await waitText(page, 'library-reserve', /Borrowing's paused until your last library payment is sorted\.\s*Sort it in My Library/), await text(page, 'library-reserve'));
  await open('/pages/my-lair?membership=none', RUBY, 600);
  await open('/products/library', RUBY, 1200);
  check(`${tag}: library game: no plan: Join the library to reserve games`, await waitText(page, 'library-reserve', /Join the library to reserve games/), await text(page, 'library-reserve'));
  check(`${tag}: library game: no plan: the Join parts stay`, await page.evaluate(() => [...document.querySelectorAll('[data-borrow-join]')].some((el) => !el.hidden)));

  /* ---------- 4. the staff page ---------- */
  await open('/pages/lair-staff', STAFF);
  await page.evaluate(() => localStorage.clear());
  await open('/pages/lair-staff', STAFF);
  await page.waitForSelector('.staff-tabs [data-tab]');
  const tabs = await page.$$eval('.staff-tabs [data-tab]', (b) => b.map((x) => x.dataset.tab));
  check(`${tag}: staff: Memberships and Damage come after Library`, tabs.join(',').includes('library,memberships,damage,accounts'), tabs);
  const people = await page.evaluate(() => {
    const list = window.Lair.store.backend.staffMembers();
    const pick = (first) => {
      const x = list.find((p) => p.firstName === first);
      return { id: String(x.customerId), code: x.code, name: x.name };
    };
    return { sam: pick('Sam'), aroha: pick('Aroha'), hemi: pick('Hemi'), tui: pick('Tui'), mia: pick('Mia'), priya: pick('Priya') };
  });
  // Memberships
  await page.click('[data-tab="memberships"]');
  await page.waitForSelector('staff-memberships .smem-row', { timeout: 8000 });
  const billing = await text(page, 'staff-memberships [data-mships-top]');
  check(`${tag}: Memberships: billing is on, with the counts`, /Library billing is on\./.test(billing) && /active memberships · 2 payments to sort · 1 ending/.test(billing), billing);
  const rows = await page.$$eval('staff-memberships .smem-row', (els) => els.map((el) => el.querySelector('.smem-row__who').textContent.trim()));
  check(`${tag}: Memberships: problems first (Hemi and Priya), then ending, paused, active`, rows[0].startsWith('Hemi') || rows[0].startsWith('Priya'), rows);
  check(`${tag}: Memberships: the tab's count is the payments to sort`, (await page.textContent('[data-count="memberships"]')) === '2');
  const hemiRow = `staff-memberships .smem-row:has(.smem-row__who:text-is("${people.hemi.name}"))`;
  const hemi = await text(page, hemiRow);
  check(`${tag}: Hemi: the payment didn't go through, when it's tried again, the card, last payment didn't go through (CARD_DECLINED)`,
    /Payment didn’t go through/.test(hemi) && /The last payment didn’t go through\. Borrowing’s paused, and it’s tried again \w{3} \d{1,2} \w{3,4}\./.test(hemi) && /Visa ending 0341 · expires 01\/27/.test(hemi) && /didn’t go through \(CARD_DECLINED\)/.test(hemi), hemi);
  await page.click(`${hemiRow} [data-mship-retry]`);
  check(`${tag}: Retry: it's tried again within 10 minutes`, await waitText(page, `${hemiRow} [data-mship-said]`, /Hemi’s payment is tried again on the next run, within 10 minutes\./), await text(page, hemiRow));
  const priya = await text(page, `staff-memberships .smem-row:has(.smem-row__who:text-is("${people.priya.name}"))`);
  check(`${tag}: Priya: waiting on her bank, and no Retry`, /Waiting on their bank/.test(priya) && /isn’t tried again while it waits/.test(priya) && !(await page.$(`staff-memberships .smem-row:has(.smem-row__who:text-is("${people.priya.name}")) [data-mship-retry]`)), priya);
  const samRow = `staff-memberships .smem-row:has(.smem-row__who:text-is("${people.sam.name}"))`;
  await page.click(`${samRow} [data-mship-end]`);
  const endAsk = await text(page, `${samRow} .staff-confirm`);
  check(`${tag}: End asks first: at the end of the month they've paid for, or now`, /End Sam’s membership\? At the end of the month they’ve paid for \(\w{3} \d{1,2} \w{3,4}\), or now\? They’re emailed either way/.test(endAsk) && await page.isVisible(`${samRow} [data-mship-end-later]`) && await page.isVisible(`${samRow} [data-mship-end-now]`), endAsk);
  await page.click(`${samRow} [data-mship-end-later]`);
  check(`${tag}: At the end of the month: it ends then, and Sam's emailed`, await waitText(page, `${samRow} [data-mship-said]`, /Sam’s membership ends \w{3} \d{1,2} \w{3,4}\. They’ve been emailed\./), await text(page, samRow));
  check(`${tag}: Sam's row now says Ending`, /Ending/.test(await text(page, `${samRow} .staff-card__head`)));
  await page.check('[data-mships-status][value="past_due"]');
  await page.waitForTimeout(400);
  const due = await page.$$eval('staff-memberships .smem-row', (els) => els.map((el) => el.querySelector('.smem-row__who').textContent.trim()));
  check(`${tag}: Payment problems: only Hemi and Priya`, due.length === 2 && due.every((n) => /^(Hemi|Priya)/.test(n)), due);
  await page.check('[data-mships-status][value="all"]');
  await page.waitForTimeout(400);
  await page.fill('[data-mships-find]', 'tui');
  await page.waitForTimeout(200);
  const found = await page.$$eval('staff-memberships .smem-row', (els) => els.map((el) => el.querySelector('.smem-row__who').textContent.trim()));
  check(`${tag}: Find a member: "tui" finds Tui`, found.length === 1 && /^Tui/.test(found[0]), found);
  check(`${tag}: Memberships: no sideways scroll`, (await overflowX(page)) === 0, await overflowX(page));
  await page.fill('[data-mships-find]', '');
  await page.check('[data-mships-status][value="current"]');
  await page.waitForTimeout(400);
  await shot(page, `${tag}-4-memberships`, 'staff-memberships');
  await scan(page, `${tag}: the Memberships tab`, 'staff-memberships');
  // Damage
  await page.click('[data-tab="damage"]');
  await page.waitForSelector('staff-damage .smem-fee', { timeout: 8000 });
  const fees = await page.$$eval('staff-damage .smem-fee', (els) => els.map((el) => el.querySelector('.smem-fee__game').textContent.trim()));
  check(`${tag}: Damage: to sort first (the dispute, then to collect, being charged, due, then notices)`, fees[0] === '1000 and One Treasures' && fees[1] === 'Jenga' && fees.includes('Wingspan') && fees.includes('Catan'), fees);
  check(`${tag}: Damage: the tab's count is what waits on staff (a dispute and one to collect)`, (await page.textContent('[data-count="damage"]')) === '2');
  const feeRow = (title) => `staff-damage .smem-fee:has(.smem-fee__game:text-is("${title}"))`;
  const wing = await text(page, feeRow('Wingspan'));
  check(`${tag}: Wingspan: store credit Shopify didn't confirm, with "It came off" and "It didn't"`, /Did \$25 come off Aroha’s store credit\?/.test(wing) && await page.isVisible(`${feeRow('Wingspan')} [data-fee-settle][data-taken="1"]`), wing);
  await page.click(`${feeRow('Wingspan')} [data-fee-settle][data-taken="1"]`);
  check(`${tag}: It came off: settled, paid`, await waitText(page, `${feeRow('Wingspan')} [data-fee-said]`, /Settled: it came off Aroha’s store credit, so the charge is paid\./), await text(page, feeRow('Wingspan')));
  // Charge now from store credit (Sam has $25)
  await page.click(`${feeRow('Catan')} [data-fee-ask="charge"]`);
  await page.waitForSelector(`${feeRow('Catan')} [data-fee-charge-yes]`);
  await page.waitForTimeout(400);
  const chargeAsk = await text(page, `${feeRow('Catan')} .staff-confirm`);
  check(`${tag}: Charge now asks first, with store credit's balance and the card`, /Take \$12\.50 for Catan from Sam now\?/.test(chargeAsk) && /Store credit \(\$25 now\)/.test(chargeAsk) && /Their card \(Visa ending 4242\)/.test(chargeAsk), chargeAsk);
  await page.click(`${feeRow('Catan')} [data-fee-charge-yes]`);
  check(`${tag}: Charge now (store credit if it covers it): paid from Sam's store credit`, await waitText(page, `${feeRow('Catan')} [data-fee-said]`, /Paid: \$12\.50 came off Sam Tautahi's store credit\./), await text(page, feeRow('Catan')));
  check(`${tag}: Catan now says Paid, from their store credit`, /Paid/.test(await text(page, `${feeRow('Catan')} .staff-card__head`)) && /paid from their store credit/.test(await text(page, feeRow('Catan'))), await text(page, feeRow('Catan')));
  // Charge now on the card (Hemi's Mysterium, due)
  await page.click(`${feeRow('Mysterium')} [data-fee-ask="charge"]`);
  await page.check(`${feeRow('Mysterium')} [data-fee-use][value="card"]`);
  await page.click(`${feeRow('Mysterium')} [data-fee-charge-yes]`);
  check(`${tag}: On their card: with Shopify, shows here once it's through`, await waitText(page, `${feeRow('Mysterium')} [data-fee-said]`, /Charging \$45 to Visa ending 0341\. It shows here once Shopify says how it went\./), await text(page, feeRow('Mysterium')));
  check(`${tag}: Mysterium says Charging now`, /Charging now/.test(await text(page, `${feeRow('Mysterium')} .staff-card__head`)), await text(page, feeRow('Mysterium')));
  await page.waitForTimeout(13000);
  await page.click('[data-damage-reload]');
  await page.waitForTimeout(500);
  check(`${tag}: a few seconds on (Shopify's webhook): Mysterium is paid on the card`, /paid on their card/.test(await text(page, feeRow('Mysterium'))) || !(await page.$(feeRow('Mysterium'))), (await text(page, 'staff-damage [data-damage-list]')).slice(0, 300));
  // Waive Mia's Jenga
  await page.click(`${feeRow('Jenga')} [data-fee-ask="waive"]`);
  const waiveAsk = await text(page, `${feeRow('Jenga')} .staff-confirm`);
  check(`${tag}: Waive asks first: Mia is emailed there's nothing to pay`, /Waive Mia’s \$5 for Jenga\? Mia is emailed that there’s nothing to pay\./.test(waiveAsk), waiveAsk);
  await page.fill(`${feeRow('Jenga')} [data-fee-ask-note]`, 'Found the blocks in the box');
  await page.click(`${feeRow('Jenga')} [data-fee-update-yes]`);
  check(`${tag}: Waived, with Mia emailed`, await waitText(page, `${feeRow('Jenga')} [data-fee-said]`, /Waived\. Mia has been emailed that there’s nothing to pay\./), await text(page, feeRow('Jenga')));
  // a new amount on Tui's dispute
  await page.click(`${feeRow('1000 and One Treasures')} [data-fee-ask="amount"]`);
  await page.fill(`${feeRow('1000 and One Treasures')} [data-fee-ask-amount]`, '600');
  await page.click(`${feeRow('1000 and One Treasures')} [data-fee-update-yes]`);
  check(`${tag}: a new amount over $500 is stopped, said plainly`, await waitText(page, `${feeRow('1000 and One Treasures')} [data-fee-said]`, /A charge is \$1 to \$500/), await text(page, feeRow('1000 and One Treasures')));
  await page.fill(`${feeRow('1000 and One Treasures')} [data-fee-ask-amount]`, '6');
  await page.click(`${feeRow('1000 and One Treasures')} [data-fee-update-yes]`);
  check(`${tag}: New amount saved: a new notice, 7 days again`, await waitText(page, `${feeRow('1000 and One Treasures')} [data-fee-said]`, /New amount saved\. Tui has been emailed a new notice, with 7 days again\./), await text(page, feeRow('1000 and One Treasures')));
  check(`${tag}: it's $6 and a notice again`, /\$6/.test(await text(page, `${feeRow('1000 and One Treasures')} .smem-fee__amount`)) && /Notice/.test(await text(page, `${feeRow('1000 and One Treasures')} .staff-card__head`)), await text(page, feeRow('1000 and One Treasures')));
  // log one from Tui's game at home (the Library tab's Damage charge)
  await page.click('[data-tab="library"]');
  await page.waitForSelector('[data-lib-damage]', { timeout: 8000 });
  await page.click('[data-lib-damage]');
  await page.waitForTimeout(800);
  check(`${tag}: Library's "Damage charge": the Damage tab, with the form open, Tui picked and her game ticked`,
    (await page.$eval('.staff-tabs [aria-selected="true"]', (b) => b.dataset.tab)) === 'damage' && (await page.$eval('[data-damage-log]', (d) => d.open))
    && /Tui Henare/.test(await text(page, 'staff-damage [data-pick-picked]')) && (await page.isChecked('staff-damage [data-damage-loan]:not([value="other"])')), await text(page, 'staff-damage .smem-log'));
  await page.click('staff-damage [data-damage-form] [type="submit"]');
  check(`${tag}: Next with nothing picked: what happened is asked for, plainly`, (await text(page, '[data-damage-error]')) === 'Pick what happened: missing parts, damaged, or lost.', await text(page, '[data-damage-error]'));
  await page.check('staff-damage [data-damage-reason][value="damaged"]');
  await page.fill('staff-damage [data-damage-details]', 'Coffee on the board');
  await page.fill('staff-damage [data-damage-amount]', '15');
  await page.click('staff-damage [data-damage-form] [type="submit"]');
  const logAsk = await text(page, '#damage-ask-q');
  check(`${tag}: Log asks first: what, how much, and what happens next`, /^Log \$15 for 1000 and One Treasures \(damaged\) to Tui Henare\? Tui is emailed a notice now and has 7 days to bring the bits back or tell us we’ve got it wrong\. Then it’s billed on its own when their membership ends\.$/.test(logAsk), logAsk);
  await page.click('[data-damage-yes]');
  check(`${tag}: Logged, and Tui's been emailed`, await waitText(page, '[data-damage-result]', /Logged \$15 for 1000 and One Treasures\. Tui has been emailed the notice\./), await text(page, '[data-damage-result]'));
  // the same form key twice: one charge (a double tap)
  const twice = await page.evaluate(async (id) => {
    const be = window.Lair.store.backend;
    const body = { customerId: id, title: 'Splendor', reason: 'missing', amount: 300, key: 'qa-double-tap' };
    const a = await be.logDamage(body);
    const b = await be.logDamage(body);
    const all = await be.damageCharges({ status: 'all', customerId: id });
    return { same: a.charge.id === b.charge.id, repeated: Boolean(b.repeated), count: all.charges.filter((f) => f.title === 'Splendor').length };
  }, people.sam.id);
  check(`${tag}: the same key twice is one charge, answered "repeated"`, twice.same && twice.repeated && twice.count === 1, twice);
  // log one charged now (Sam, store credit)
  await page.click('[data-damage-clear]');
  await page.fill('staff-damage .sa-pick__input', 'Sam');
  await page.waitForSelector(`staff-damage [data-pick="${people.sam.id}"]`, { timeout: 5000 });
  await page.click(`staff-damage [data-pick="${people.sam.id}"]`);
  await page.waitForTimeout(500);
  await page.fill('staff-damage [data-damage-title]', 'Azul').catch(async () => {
    await page.check('staff-damage [data-damage-loan][value="other"]');
    await page.fill('staff-damage [data-damage-title]', 'Azul');
  });
  await page.check('staff-damage [data-damage-reason][value="missing"]');
  await page.fill('staff-damage [data-damage-amount]', '5');
  await page.check('staff-damage [data-damage-now]');
  await page.check('staff-damage [data-damage-use-pick][value="credit"]');
  await page.waitForTimeout(300);
  check(`${tag}: Charge it now: their store credit and card show`, /Store credit: \$\d+(\.\d\d)?\./.test(await text(page, '[data-damage-now-info]')) && /Card: Visa ending 4242\./.test(await text(page, '[data-damage-now-info]')), await text(page, '[data-damage-now-info]'));
  await page.click('staff-damage [data-damage-form] [type="submit"]');
  const nowAsk = await text(page, '#damage-ask-q');
  check(`${tag}: Log and charge asks first, saying where it comes from`, /Sam is emailed a notice saying it’s being taken now, then it’s taken from their store credit/.test(nowAsk) && (await text(page, '[data-damage-yes]')) === 'Yes, log it and charge it', nowAsk);
  await page.click('[data-damage-yes]');
  check(`${tag}: Logged and paid from store credit`, await waitText(page, '[data-damage-result]', /Paid: \$5 came off Sam Tautahi's store credit\./), await text(page, '[data-damage-result]'));
  check(`${tag}: the form starts again: not charged now, "Store credit, else their card" ticked, nobody picked`,
    !(await page.isChecked('staff-damage [data-damage-now]')) && (await page.isChecked('staff-damage [data-damage-use-pick][value="auto"]')) && !(await page.isVisible('staff-damage [data-pick-picked]')));
  check(`${tag}: Damage: no sideways scroll`, (await overflowX(page)) === 0, await overflowX(page));
  await shot(page, `${tag}-4-damage`, 'staff-damage');
  await scan(page, `${tag}: the Damage tab with the log form`, 'staff-damage');
  // a member's page: their membership and damage charges
  await page.click('[data-tab="members"]');
  await page.waitForSelector('[data-members-find]');
  await page.fill('[data-members-find]', 'Hemi');
  await page.waitForSelector(`[data-member-view="${people.hemi.id}"]`, { timeout: 5000 });
  await page.click(`.staff-mem-row[data-member-view="${people.hemi.id}"]`).catch(() => page.click(`[data-member-view="${people.hemi.id}"]`));
  await page.waitForSelector('[data-person-membership] .smem-person__plan', { timeout: 8000 }).catch(() => {});
  const mem = await text(page, '[data-person-membership]');
  check(`${tag}: Hemi's page: "Library membership" with the payment problem and Stash, and Mysterium in his damage charges`,
    /Library membership/.test(mem) && /Payment didn’t go through/.test(mem) && /Stash/.test(mem) && /Mysterium/.test(mem) && await page.isVisible('[data-person-membership] [data-damage-for]'), mem.slice(0, 400));
  await page.click('[data-person-membership] [data-damage-for]');
  await page.waitForTimeout(600);
  check(`${tag}: "Log a damage charge" from his page: the Damage tab with Hemi picked`, (await page.$eval('.staff-tabs [aria-selected="true"]', (b) => b.dataset.tab)) === 'damage' && /Hemi Walker/.test(await text(page, 'staff-damage [data-pick-picked]')), await text(page, 'staff-damage [data-pick-picked]'));

  check(`${tag}: no console errors`, !errors.length, errors.join(' / '));
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Round 9, tab: the running tab and monthly accounts (contract v9-tab). Mo (9 Oct): "...you will have a running tab with
// future events and when you settle the tab you can pay for it day by day or if you like you can save it to pay it off
// once a month either up front or compiled. The idea is to track it all in the Shopify." And: "increase credit limit
// or decrease it".
// Demo mode on the theme mock, phone (390px) then desktop (1280px), each in a fresh browser (a fresh demo):
//   1. My Lair as Ruby, who the demo puts on a monthly account ($500 limit, last month's bill open): Home's Tab card says
//      what's on the account and the next thing coming up; the Tab view's panel has the limit, a bar of how much is
//      used, the open bill with Pay online, what's on the account, store credit, and coming up (each with its date,
//      price and "Goes on your monthly bill"); the pretend invoice pays the bill; "Pay online now" makes a bill for
//      everything; a tab item that would go over the limit is refused with the app's words
//   2. the staff page as Mo: the Accounts tab (over the limit first, the open bill, Open), a member's "Tab and account"
//      (owed, coming up, the billing form: the limit change asks first with what it was and what it becomes, then says
//      so; Bill now and Void ask first), and switching a pay-each-visit member to a monthly account; the check-in card
//      of a member on an account says "On their account"
//   3. axe (WCAG 2.1 A and AA) on the panel, coming up, the member section and the Accounts tab; overflowX 0 and no
//      console errors on every page
// Screenshots go to OUT, or a folder in the system's temp directory. Without AXE (axe-core's axe.min.js) the axe part is
// skipped, and says so.
// Usage: DG_THEME=/path/to/theme PORT=4941 [AXE=/path/to/axe.min.js] [OUT=/dir] node tools/qa/round9/tab.mjs [phone|desktop]
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
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round9-tab');
const AXE = process.env.AXE || '';
const axe = AXE && fs.existsSync(AXE) ? fs.readFileSync(AXE, 'utf8') : null;
fs.mkdirSync(OUT, { recursive: true });
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4941);
const BASE = `http://localhost:${PORT}`;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };

/* ---------- the page clock: today, 1pm in Auckland ---------- */
const TZ = 'Pacific/Auckland';
const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const offset = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${key}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const iso = (key, hm) => `${key}T${hm}:00${offset(key)}`;
const today = lairKey(Date.now());
const AT = Date.parse(iso(today, '13:00'));
const CLOCK = `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const lastMonth = (() => {
  const [y, mo] = today.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 2, 1));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
})();

const RUBY = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [], store_credit_account: { balance: 500 } };
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
    if (!el) return [`nothing matches ${sel}`];
    const r = await window.axe.run(el, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  }, selector);
  check(`axe: ${label}: no WCAG 2.1 A/AA violations`, !found.length, found.join(' / '));
}
const shot = async (page, name, sel = null, full = false) => {
  const el = sel ? await page.$(sel) : null;
  await (el || page).screenshot({ path: `${OUT}/${name}.png`, ...(el ? {} : { fullPage: full }) }).catch(() => {});
};

const server = await m.serve(PORT);
const browser = await chromium.launch();
if (!axe) console.log('NOTE axe-core not given (AXE=…/axe.min.js): the axe checks are skipped');

for (const size of process.argv[2] ? [process.argv[2]] : ['phone', 'desktop']) {
  const phone = size === 'phone';
  const tag = size;
  const ctx = await browser.newContext({ viewport: SIZES[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
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
  await open('/pages/my-lair', RUBY);
  await page.evaluate(() => localStorage.clear());

  /* ---------- 1. My Lair ---------- */
  await open('/pages/my-lair', RUBY);
  await page.waitForFunction(() => document.querySelector('[data-sum="tab"]') && document.querySelector('[data-sum="tab"]').textContent !== '…', null, { timeout: 20000 });
  const account = await page.evaluate(() => window.Lair.store.backend.accountFor(window.Lair.store.cfg.customer.id));
  const home = await page.evaluate(() => ({
    value: document.querySelector('[data-sum="tab"]').textContent.trim(), label: document.querySelector('[data-sum="tab-label"]').textContent.trim(),
    more: document.querySelector('[data-sum="tab-more"]').textContent,
  }));
  const owed = account.owed.total;
  const money = (c) => `$${c % 100 === 0 ? c / 100 : (c / 100).toFixed(2)}`;
  check(`${tag}: the demo puts Ruby on a monthly account with last month's bill open`, account.billing === 'monthly' && account.creditLimit === 50000 && account.bill && account.bill.label === lastMonth, account);
  check(`${tag}: Home's Tab card: the running total on the account, what's left, and the next thing coming up`,
    home.value === money(owed) && home.label === 'on your account' && home.more.includes(`${money(account.creditLimit - owed)} left of ${money(account.creditLimit)}`)
      && (account.comingUp.items.length ? home.more.includes(`Next: ${account.comingUp.items[0].title}`) : true), { home, owed });
  await shot(page, `${tag}-home`, '.ml-sums, [data-sum="tab"]');

  await open('/pages/my-lair#tab', RUBY);
  await page.waitForSelector('[data-tab-account]:not([hidden]) .ml-acct', { timeout: 20000 });
  const panel = await page.evaluate(() => {
    const p = document.querySelector('[data-tab-account]');
    const c = document.querySelector('[data-tab-coming]');
    return {
      title: p.querySelector('.ml-acct__title').textContent.trim(), used: p.querySelector('.ml-acct__used').textContent.replace(/\s+/g, ' ').trim(),
      bar: p.querySelector('.ml-acct__bar').getAttribute('aria-label'), billLabel: (p.querySelector('.ml-acct__bill-label') || {}).textContent,
      billTotal: (p.querySelector('.ml-acct__bill-total') || {}).textContent, pay: !!p.querySelector('[data-demo-bill]'),
      lines: p.querySelectorAll('.ml-acct__line').length, credit: p.querySelector('.ml-acct__credit').textContent.replace(/\s+/g, ' ').trim(),
      payNow: (p.querySelector('[data-account-pay]') || {}).textContent || '',
      coming: c && !c.hidden ? { title: c.querySelector('h2').textContent.trim(), how: [...c.querySelectorAll('.ml-upnext__how')].map((x) => x.textContent.trim()), items: c.querySelectorAll('.ml-upnext__item').length } : null,
      tabHeading: (document.querySelector('.ml-tabcard__title') || {}).textContent || '',
    };
  });
  check(`${tag}: the panel: "Your Lair account", what's used of the limit, and a bar that says it`,
    panel.title === 'Your Lair account' && panel.used === `${money(owed)} used of your ${money(account.creditLimit)} limit` && panel.bar === `${money(owed)} of ${money(account.creditLimit)} used`, panel);
  check(`${tag}: the open bill: "Your ${lastMonth} bill", its total and Pay online`, panel.billLabel === `Your ${lastMonth} bill` && panel.billTotal === money(account.bill.total) && panel.pay, panel);
  check(`${tag}: what's on the account, one line each, and store credit used when you pay`, panel.lines === account.owed.items.length && panel.credit === 'Store credit: $5, used when you pay.', panel);
  check(`${tag}: "Pay online now" for everything owed (more than the bill)`, owed > account.bill.total ? panel.payNow === `Pay online now (${money(owed)})` : !panel.payNow, panel);
  check(`${tag}: coming up, each with its date, price and how it's paid`,
    account.comingUp.items.length ? panel.coming && panel.coming.title === 'Coming up' && panel.coming.items === account.comingUp.items.length && panel.coming.how.every((h) => ['Goes on your monthly bill', 'Nothing to pay', 'Paying online'].includes(h)) : !panel.coming, panel);
  check(`${tag}: today's tab card says it's on their account`, !panel.tabHeading || panel.tabHeading === 'On your account. Show your code at the counter', panel);
  check(`${tag}: My Lair's Tab view: no sideways scroll`, (await overflowX(page)) === 0);
  await shot(page, `${tag}-mylair-account`, '[data-tab-account]');
  await shot(page, `${tag}-mylair-tab`, null, true);
  await scan(page, `${tag} My Lair account panel`, '[data-tab-account]');
  if (panel.coming) await scan(page, `${tag} My Lair coming up`, '[data-tab-coming]');

  // the pretend invoice pays the bill: it goes, and what was on it comes off
  await page.click('[data-demo-bill]');
  await page.waitForFunction(() => !document.querySelector('[data-demo-bill]'), null, { timeout: 10000 });
  const paid = await page.evaluate(() => ({ notice: (document.querySelector('[data-notice]') || {}).textContent || '', used: document.querySelector('.ml-acct__used').textContent.replace(/\s+/g, ' ').trim() }));
  const after = owed - account.bill.total;
  check(`${tag}: Pay online (the demo's pretend invoice) pays the bill and what was on it`, /Paid online\. Thanks, friend!/.test(paid.notice) && paid.used === `${money(after)} used of your ${money(account.creditLimit)} limit`, paid);
  // "Pay online now": a bill for everything still owed (the demo shows its pretend invoice on the bill)
  if (after > 0) {
    await page.click('[data-account-pay]');
    await page.waitForSelector('[data-demo-bill]', { timeout: 10000 });
    const fresh = await page.evaluate(() => ({ label: document.querySelector('.ml-acct__bill-label').textContent, total: document.querySelector('.ml-acct__bill-total').textContent, focus: document.activeElement && document.activeElement.matches('[data-demo-bill]') }));
    check(`${tag}: "Pay online now" makes a bill for everything owed, focus on its Pay online`, fresh.label === 'Your bill so far' && fresh.total === money(after) && fresh.focus, fresh);
  }
  // over the limit: a tab item is refused with the app's words
  const refused = await page.evaluate(async () => {
    const be = window.Lair.store.backend;
    const a = be.accountFor(window.Lair.store.cfg.customer.id);
    const room = a.creditLimit - a.owed.total;
    try {
      await be.saveTab({ items: [{ variantId: '9100000001', title: 'Pocky', variantTitle: 'Strawberry', price: Math.min(100000, room + 100), qty: 1 }] });
      return { ok: true };
    } catch (e) {
      return { ok: false, status: e.status, message: e.message, room, limit: a.creditLimit };
    }
  });
  check(`${tag}: a tab item over the limit is refused (409) with the app's words`,
    !refused.ok && refused.status === 409 && refused.message === `That would take your Lair account over its ${money(refused.limit)} limit (${money(refused.room)} left). Pay your bill online or at the counter, then add to your tab again.`, refused);

  /* ---------- 2. the staff page ---------- */
  await open('/pages/lair-staff#accounts', STAFF);
  await page.waitForSelector('staff-accounts .staff-accounts__row', { timeout: 20000 });
  const list = await page.evaluate(() => [...document.querySelectorAll('.staff-accounts__row')].map((r) => ({
    over: r.classList.contains('is-over'), who: r.querySelector('.staff-accounts__who').textContent.replace(/\s+/g, ' ').trim(),
    owed: r.querySelector('.staff-accounts__owed').textContent.replace(/\s+/g, ' ').trim(), bill: r.querySelector('.staff-accounts__bill').textContent.replace(/\s+/g, ' ').trim(),
    open: r.querySelector('[data-account-open]').dataset.accountOpen,
  })));
  check(`${tag}: the Accounts tab lists the accounts, over the limit first`, list.length >= 2 && list[0].over && /Over the limit/.test(list[0].who), list);
  check(`${tag}: someone back on pay each visit is listed while they owe from their account`, list.some((x) => /Pays each visit now/.test(x.who) && /owed from their account/.test(x.owed)), list);
  check(`${tag}: the Accounts tab: no sideways scroll`, (await overflowX(page)) === 0);
  await shot(page, `${tag}-staff-accounts`, '#panel-accounts');
  await scan(page, `${tag} staff Accounts tab`, '#panel-accounts');
  // a member's page: Open from the list
  const over = list[0];
  await page.click(`[data-account-open="${over.open}"]`);
  await page.waitForSelector('[data-person-account]:not([hidden]) .staff-acct__form', { timeout: 20000 });
  const section = await page.evaluate(() => {
    const s = document.querySelector('[data-person-account]');
    return {
      head: s.querySelector('.staff-sheet__sub').textContent.trim(), mode: s.querySelector('.staff-acct__mode').textContent.replace(/\s+/g, ' ').trim(),
      warning: (s.querySelector('.staff-error-text') || {}).textContent || '', items: s.querySelectorAll('.staff-acct__item').length,
      billing: (s.querySelector('[data-acct-billing]:checked') || {}).value, limit: s.querySelector('[data-acct-limit]').value,
      billNow: (s.querySelector('[data-acct-bill]') || {}).textContent || '',
    };
  });
  check(`${tag}: the member page's "Tab and account": the account, what's owed and the warning`,
    section.head === 'Tab and account' && /^Monthly account .* owed of \$50$/.test(section.mode) && /^Over their \$50 limit/.test(section.warning) && section.items >= 2, section);
  check(`${tag}: the billing form starts as it is: Monthly account, $50`, section.billing === 'monthly' && section.limit === '50', section);
  await shot(page, `${tag}-staff-member-account`, '[data-person-account]');
  await scan(page, `${tag} staff member "Tab and account"`, '[data-person-account]');
  // raise the limit: it asks first, saying what it was and what it becomes; then it says so
  await page.fill('[data-acct-limit]', '120');
  await page.click('[data-acct-form] button[type="submit"]');
  await page.waitForSelector('[data-acct-yes]');
  const ask = await page.evaluate(() => ({ words: document.querySelector('[data-person-account] .staff-acct__ask-text').textContent.trim(), focus: document.activeElement && document.activeElement.matches('.staff-acct__ask-text') }));
  check(`${tag}: changing the limit asks first: "Change …'s credit limit from $50 to $120?"`, /^Change \w+'s credit limit from \$50 to \$120\?$/.test(ask.words) && ask.focus, ask);
  await page.click('[data-acct-yes]');
  await page.waitForSelector('[data-acct-said]');
  const saidLimit = await page.evaluate(() => ({ said: document.querySelector('[data-acct-said]').textContent.trim(), focus: document.activeElement && document.activeElement.matches('[data-acct-said]'), mode: document.querySelector('.staff-acct__mode').textContent.replace(/\s+/g, ' ').trim() }));
  check(`${tag}: then it says what it was and what it is now, focus on it`, /^\w+'s credit limit went from \$50 to \$120\./.test(saidLimit.said) && saidLimit.focus && /of \$120/.test(saidLimit.mode), saidLimit);
  // Bill now asks first, then says it was emailed
  await page.click('[data-acct-bill]');
  const billAsk = await text(page, '[data-person-account] .staff-acct__ask-text');
  check(`${tag}: Bill now asks first, saying what will be emailed`, /^Email \w+ a bill for \$\d+\.\d{2} now, with a Pay online link\?/.test(billAsk), billAsk);
  await page.click('[data-acct-bill-yes]');
  await page.waitForSelector('[data-acct-said]');
  const billed = await text(page, '[data-acct-said]');
  check(`${tag}: Bill now: "Bill for $… emailed to …", and the bill shows open with Resend and Void`,
    /^Bill for \$\d+\.\d{2} emailed to \S+@example\.com\.$/.test(billed) && (await page.$$('[data-acct-void]')).length === 1 && (await page.$$('[data-acct-resend]')).length === 1, billed);
  // Void asks first; Keep it keeps it
  await page.click('[data-acct-void]');
  const voidAsk = await text(page, '[data-person-account] .staff-acct__ask-text');
  check(`${tag}: Void asks first: its link stops working and what's on it stays owed`, /Its payment link stops working\. What's on it stays owed\.$/.test(voidAsk), voidAsk);
  await page.click('[data-acct-ask-no]');
  check(`${tag}: "Keep it" leaves the bill and focus goes back to Void`, (await page.evaluate(() => document.activeElement && document.activeElement.matches('[data-acct-void]'))));
  await page.click('[data-acct-void]');
  await page.click('[data-acct-void-yes]');
  await page.waitForSelector('[data-acct-said]');
  const voided = await page.evaluate(() => ({ said: document.querySelector('[data-acct-said]').textContent.trim(), cancelled: [...document.querySelectorAll('.staff-acct__bill .badge')].some((b) => b.textContent === 'Cancelled') }));
  check(`${tag}: Void: the bill is cancelled and the page says so`, /^Bill cancelled\./.test(voided.said) && voided.cancelled, voided);
  check(`${tag}: the member page: no sideways scroll`, (await overflowX(page)) === 0);
  await shot(page, `${tag}-staff-member-after`, '[data-person-account]');

  // a pay-each-visit member onto a monthly account (asks first), then their check-in card says "On their account"
  await page.click('[data-members-back]');
  await page.waitForSelector('[data-member-view]');
  const visitor = await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const known = new Set(Object.keys(be.state.tabAccounts || {}));
    const m = be.staffMembers().find((x) => !known.has(String(x.customerId)) && x.code);
    return m ? { id: String(m.customerId), code: m.code, first: m.firstName || String(m.name).split(' ')[0] } : null;
  });
  if (check(`${tag}: a member paying each visit to switch`, Boolean(visitor), visitor)) {
    await page.evaluate((id) => document.querySelector('lair-staff').openMember(id), visitor.id);
    await page.waitForSelector('[data-person-account]:not([hidden]) .staff-acct__form', { timeout: 20000 });
    await page.check('[data-acct-billing][value="monthly"]');
    await page.fill('[data-acct-limit]', '80');
    await page.click('[data-acct-form] button[type="submit"]');
    const switchAsk = await text(page, '[data-person-account] .staff-acct__ask-text');
    check(`${tag}: switching to a monthly account asks first with the limit`, switchAsk === `Put ${visitor.first} on a monthly account with a $80 limit? What they check in for from now goes on their account, and their bill comes on the 1st.`, switchAsk);
    await page.click('[data-acct-yes]');
    await page.waitForSelector('[data-acct-said]');
    check(`${tag}: then says so`, (await text(page, '[data-acct-said]')).startsWith(`${visitor.first} is on a monthly account now, with a $80 limit.`));
    // their check-in card (the floor knows they're on an account once it reloads)
    await page.evaluate(() => window.Lair.store.refresh && window.Lair.store.refresh());
    await page.waitForTimeout(500);
    await page.fill('#checkin-code', visitor.code);
    await page.press('#checkin-code', 'Enter');
    await page.waitForSelector('.checkin-card--member', { timeout: 10000 });
    const card = await page.evaluate(() => ({ note: (document.querySelector('.checkin-card__account') || {}).textContent || '', pay: (document.querySelector('.checkin-card--member .checkin-card__pay') || {}).textContent || '' }));
    check(`${tag}: their check-in card says it's a monthly account, and puts today's fees on it`, /Monthly account \$\d+(\.\d{2})? owed of \$80\. Checking in puts today's fees on their account\./.test(flat(card.note)) && (!card.pay || /^On their account/.test(card.pay.trim())), card);
    await shot(page, `${tag}-staff-checkin-card`, '.checkin-card--member');
  }
  check(`${tag}: no console errors`, !errors.length, errors.slice(0, 5));
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed. Screenshots in ${OUT}`);
process.exit(fail ? 1 : 0);

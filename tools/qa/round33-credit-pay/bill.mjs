// Round 33 (7 Nov 2026, contract v33-credit-pay), on the theme mock (demo mode). Mo: "I want to add pay using store
// credit for clients as an extra option thanks", at the counter till and on My Lair's bill. This is My Lair's bill:
//  1. Ruby's bill (a $7 tab and what the demo has her owing from before, with $25 more than that in store credit): Pay
//     with store credit between Show my Goblin card and Pay with cash, as an extra option, not the main one.
//  2. It asks first: how much, what's left, that staff still check her in. Not now goes back.
//  3. The bill changed while it asked (more on the tab): the Lair app's words, the new total, nothing taken.
//  4. Pay: the Lair app's words, the tab and what was owed paid, the Wallet and Home's summary show what's left.
//  5. A lost answer: says so, keeps the bill; tapping again sends the same key, so it's paid once.
//  6. Not enough store credit: no button, a line saying it can go towards it at the counter.
// No sideways scroll, no console errors and axe at each. 320, 390 and 1280 wide.
// Usage: DG_THEME=/path/to/theme [PORT=4994] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round33-credit-pay/bill.mjs [small|phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round33-credit-pay');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, overflowX, axe, shot, watch, go, clockAt, RUBY } = lib;
const PORT = Number(process.env.PORT || 4994);
const BASE = `http://localhost:${PORT}`;
const VIEWPORTS = { small: { width: 320, height: 640 }, phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const sizes = process.argv[2] ? [process.argv[2]] : ['small', 'phone', 'desktop'];
const COKE = (qty) => ({ variantId: '9101', title: 'Coke', variantTitle: 'Default Title', price: 350, qty });
const PIZZA = (qty) => ({ variantId: '9102', title: 'Pizza slice', variantTitle: 'Default Title', price: 800, qty });
// the demo puts the day's first login on a monthly account (round 9), so Ama logs in first and Ruby pays each visit
const AMA = { id: 7700445566, first_name: 'Ama', last_name: 'Reti', name: 'Ama Reti', email: 'ama@example.com', phone: null, tags: [], store_credit_account: { balance: 0 }, orders_count: 0, orders: [] };

/** axe on a part of the page with the sticky site header and My Lair's bar unstuck (round 30's way) */
async function axeFree(page, label, sel) {
  const unstick = await page.addStyleTag({ content: '[id^="shopify-section-"]:has(> .site-header), my-lair .ml-bar { position: static !important; }' });
  await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel);
  await axe(page, label, sel);
  await unstick.evaluate((el) => el.remove());
}
/** My Lair's way ($7, $10.50) and the Lair app's ($7.00) */
const money = (c) => `$${Number.isInteger(c / 100) ? c / 100 : (c / 100).toFixed(2)}`;
const dollars = (c) => `$${(c / 100).toFixed(2)}`;
const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 400) => page.waitForTimeout(ms);

async function context(size) {
  const phone = size !== 'desktop';
  const ctx = await browser.newContext({ viewport: VIEWPORTS[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(clockAt('19:30'));
  return ctx;
}
async function myLair(page, where = '/pages/my-lair#tab', who = RUBY) {
  await go(page, BASE, where, who);
  await page.waitForSelector('[data-stamp-count] strong', { state: 'attached', timeout: 20000 });
  await settle(page, 600);
}
/** today's tab in the demo, saved as My Lair's menu saves it */
const saveTab = (page, items) => page.evaluate(async (list) => {
  await window.Lair.store.backend.saveTab({ items: list });
}, items);
const bill = (page) => page.evaluate(() => {
  const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const q = (s) => document.querySelector(s);
  const shown = (el) => Boolean(el) && !el.hidden && !el.closest('[hidden]');
  const card = q('[data-tab-card]');
  const note = q('[data-tab-status] .ml-tab__note');
  const error = q('[data-tab-card-error]');
  return {
    shown: shown(q('[data-tab-status]')) && Boolean(card),
    heading: f(q('#ml-tabcard-title')?.textContent),
    total: f(q('[data-tab-card-total]')?.textContent).replace(/^Total /, ''),
    ledes: [...(card?.querySelectorAll('.ml-tabcard__lede') || [])].map((p) => f(p.textContent)),
    buttons: [...(card?.querySelectorAll('.ml-tabcard__show button') || [])].map((b) => f(b.textContent)),
    note: note ? f(note.textContent) : '', noteRole: note?.getAttribute('role') || '', error: shown(error) ? f(error.textContent) : '',
    amount: f(q('[data-credit-amount]')?.textContent), sum: f(q('[data-credit-sum]')?.textContent),
    focus: document.activeElement?.id || document.activeElement?.getAttribute('data-credit-go') !== null && 'go' || document.activeElement?.tagName || '',
  };
});
const demo = (page) => page.evaluate(() => {
  const be = window.Lair.store.backend;
  const id = String(window.Lair.store.cfg.customer.id);
  const tabs = (be.state.tabs || []).filter((t) => t.customerId === id);
  return { pays: be.creditPaysDemo().map((p) => ({ key: p.key, amount: p.amount, status: p.status })), balance: be.creditOfDemo(id), tabs: tabs.map((t) => ({ status: t.status, total: t.total, orderId: t.orderId || '' })) };
});

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';
  const ctx = await context(size);
  const page = watch(await ctx.newPage());
  await page.goto(BASE);
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* a fresh demo */ } });

  /* ---------- 1. the bill ---------- */
  await myLair(page, '/pages/my-lair#tab', AMA);
  await myLair(page);
  // what the demo has her owing from before (it depends on the day), and store credit for that and $25 more
  const owed = await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const c = window.Lair.store.cfg.customer;
    const cents = be.cashBillFor(c, Date.now()).total;
    be.creditState().balances[String(c.id)] = cents + 2500;
    be.commit();
    return cents;
  });
  check(`${tag} the demo has Ruby owing something from before (${money(owed)}), so the bill pays bookings too`, owed > 0, owed);
  await saveTab(page, [COKE(2)]);
  await myLair(page);
  let b = await bill(page);
  check(`${tag} Ruby's bill: ${money(owed + 700)}, her card, then Pay with store credit and Pay with cash`,
    b.shown && b.total === money(owed + 700) && b.heading === 'Pay at the counter: just give your name' && b.buttons.join(' | ') === 'Show my Goblin card | Pay with store credit | Pay with cash' && b.amount === dollars(owed + 2500), b);
  await shot(page, `${size}-1-bill`, '[data-tab-status]');

  /* ---------- 2. it asks first ---------- */
  await page.click('[data-credit-pay]');
  await settle(page, 250);
  b = await bill(page);
  check(`${tag} Pay with store credit asks: how much, what's left, staff still check her in; focus on the question`,
    b.heading === `Pay ${money(owed + 700)} from your store credit?` && b.ledes[0] === 'It comes off now, and you’ll have $18 left. Staff still check you in when you get here.'
    && b.buttons.join(' | ') === `Pay ${money(owed + 700)} | Not now` && b.focus === 'ml-tabcard-title' && b.amount === dollars(owed + 2500), b);
  await shot(page, `${size}-2-ask`, '[data-tab-status]');
  await axeFree(page, `${tag} the bill, asking`, '[data-tab-status]');
  await page.click('[data-credit-cancel]');
  await settle(page, 250);
  b = await bill(page);
  check(`${tag} Not now: back to the bill, nothing taken`, b.heading === 'Pay at the counter: just give your name' && b.buttons.includes('Pay with store credit') && b.focus === 'ml-tabcard-title' && b.amount === dollars(owed + 2500), b);

  /* ---------- 3. the bill changed while it asked ---------- */
  await page.click('[data-credit-pay]');
  await settle(page, 250);
  await saveTab(page, [COKE(3)]);
  await page.click('[data-credit-go]');
  await settle(page, 600);
  b = await bill(page);
  let d = await demo(page);
  check(`${tag} the bill changed while it asked: the Lair app's words, the new total, nothing taken`,
    b.note === `Your bill's ${dollars(owed + 1050)} now (a session pass took some off, or something changed). Check it, then pay again.` && b.noteRole === 'alert'
    && b.total === money(owed + 1050) && b.buttons.includes('Pay with store credit') && b.amount === dollars(owed + 2500) && d.pays.length === 0 && d.balance === owed + 2500, { b, d });

  /* ---------- 4. paid ---------- */
  await page.click('[data-credit-pay]');
  await settle(page, 250);
  b = await bill(page);
  check(`${tag} asking again: the new total`, b.heading === `Pay ${money(owed + 1050)} from your store credit?` && b.ledes[0] === 'It comes off now, and you’ll have $14.50 left. Staff still check you in when you get here.' && !b.note, b);
  await page.click('[data-credit-go]');
  await settle(page, 800);
  b = await bill(page);
  d = await demo(page);
  const left = await page.evaluate(() => {
    const be = window.Lair.store.backend;
    return be.cashBillFor(window.Lair.store.cfg.customer, Date.now()).total;
  });
  check(`${tag} Pay: the Lair app's words (as a status), the tab and what was owed paid, $14.50 on the Wallet and Home's summary`,
    b.note === `Paid! ${dollars(owed + 1050)} came off your store credit, and $14.50 is left.` && b.noteRole === 'status' && b.heading === 'Paid. Thanks, friend.'
    && !b.buttons.includes('Pay with store credit') && b.amount === '$14.50' && b.sum === '$14.50' && left === 0, { b, left });
  check(`${tag} the demo: one payment, the tab paid by it, $14.50 left`,
    d.pays.length === 1 && d.pays[0].amount === owed + 1050 && d.balance === 1450 && d.tabs.some((t) => t.status === 'paid' && t.total === 1050 && /^credit:/.test(t.orderId)), d);
  await shot(page, `${size}-3-paid`, '[data-tab-status]');
  await axeFree(page, `${tag} the bill, paid`, '[data-tab-status]');
  check(`${tag} no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));

  /* ---------- 5. a lost answer ---------- */
  await saveTab(page, [COKE(1)]);
  await myLair(page);
  await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const real = be.payCredit.bind(be);
    let lost = false;
    be.payCredit = async (input) => {
      window.__keys = [...(window.__keys || []), input.key];
      const answer = await real(input);
      if (!lost) {
        lost = true;
        throw new TypeError('Failed to fetch');
      }
      return answer;
    };
  });
  await page.click('[data-credit-pay]');
  await settle(page, 250);
  await page.click('[data-credit-go]');
  await settle(page, 600);
  b = await bill(page);
  check(`${tag} a lost answer: says so (never twice), and the question stays to tap again`,
    b.error === 'That didn’t go through. Check your connection and tap Pay again: it won’t be paid twice.' && b.buttons.join(' | ') === 'Pay $3.50 | Not now', b);
  await page.click('[data-credit-go]');
  await settle(page, 800);
  b = await bill(page);
  d = await demo(page);
  const keys = await page.evaluate(() => window.__keys);
  check(`${tag} tapping again sends the same key: paid once, $11.00 left`,
    keys.length === 2 && keys[0] === keys[1] && d.pays.length === 2 && d.balance === 1100 && b.amount === '$11.00' && /^Paid! \$3\.50 came off your store credit/.test(b.note) && !b.error, { keys, d, b });

  /* ---------- 6. not enough store credit ---------- */
  await saveTab(page, [PIZZA(2)]);
  await myLair(page);
  b = await bill(page);
  check(`${tag} $16 with $11 of store credit: no button, and it can go towards it at the counter`,
    b.total === '$16' && !b.buttons.includes('Pay with store credit') && b.ledes.includes('Your $11 of store credit can go towards it at the counter.') && b.buttons.join(' | ') === 'Show my Goblin card | Pay with cash', b);
  await shot(page, `${size}-4-short`, '[data-tab-status]');
  await axeFree(page, `${tag} the bill, not enough store credit`, '[data-tab-status]');
  check(`${tag} no sideways scroll (short)`, (await overflowX(page)) <= 0, await overflowX(page));
  check(`${tag} My Lair: no console errors`, page.errors.length === 0, page.errors);
  await ctx.close();
}

const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed (screenshots in ${process.env.OUT})`);
await browser.close();
server.close?.();
process.exit(fail ? 1 : 0);

// Cash at the counter (17 Oct 2026, contract v18-cash), on the theme mock: My Lair's Pay with cash (the bill card's
// button, Paying cash with what to hand over, Update when the bill changes, I'll pay another way) and the staff page's
// Paying cash list (Got the cash in two taps: checked in and paid; a changed total said and taken again; Not paid), the
// live backend's four calls, focus, no sideways scroll and axe. Phone and desktop.
// Usage: DG_THEME=/path/to/theme [PORT=4995] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round18/cash.mjs [phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-cash');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, context, watch, go, STAFF, RUBY } = lib;
const PORT = Number(process.env.PORT || 4995);
const BASE = `http://localhost:${PORT}`;
const sizes = process.argv[2] ? [process.argv[2]] : ['phone', 'desktop'];

const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const toast = (page) => page.evaluate(() => (document.querySelector('[data-live-region]')?.textContent || '').trim());
// the theme's money ($7, $3.50) and the Lair's words' ($7.00)
const money = (cents) => `$${Number.isInteger(cents / 100) ? cents / 100 : (cents / 100).toFixed(2)}`;
const fixed = (cents) => `$${(cents / 100).toFixed(2)}`;

/** Ruby pays each visit: her table tonight (T5, 8pm, 2 people) and a tab (2 × Coke at $3.50), in the demo backend */
const seedRuby = (page, ruby) => page.evaluate(async (r) => {
  const { store } = window.Lair;
  const be = store.backend;
  const t = be.time;
  const now = Date.now();
  be.demoBilling('visit');
  be.state.bookings = be.state.bookings.filter((b) => !/^bk-cash-/.test(b.id));
  be.state.tabs = (be.state.tabs || []).filter((x) => !/^tb-cash-/.test(x.id));
  be.state.cash = [];
  be.state.bookings.push({
    id: 'bk-cash-t5', ref: 'RT-CASH-5', kind: 'table', status: 'confirmed', pay: 'day', paid: false, amount: 2000, covered: 0, paidAmount: 0,
    email: r.email, phone: '', notes: '', activity: 'board', extras: [], name: r.name, createdAt: now - 3600000, customerId: String(r.id),
    tables: ['T5'], start: t.at(t.today(), 20 * 60), end: t.at(t.today(), 23 * 60), people: 2,
  });
  be.state.tabs.push({
    id: 'tb-cash-1', customerId: String(r.id), day: t.today(), items: [{ variantId: '9001', title: 'Coke', variantTitle: 'Default Title', price: 350, qty: 2 }],
    total: 700, status: 'open', orderId: null, createdAt: now - 600000, updatedAt: now - 600000,
  });
  be.commit();
  await store.refresh();
  return be.cashBillFor({ id: String(r.id), email: r.email }).total;
}, { id: RUBY.id, name: RUBY.name, email: RUBY.email });

const card = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-tab-card]');
  const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  return el ? {
    title: f(el.querySelector('.ml-tabcard__title')?.textContent),
    badge: f(el.querySelector('.ml-tabcard__kicker .badge')?.textContent),
    ledes: [...el.querySelectorAll('.ml-tabcard__lede')].map((p) => f(p.textContent)),
    buttons: [...el.querySelectorAll('.ml-tabcard__show button')].map((b) => f(b.textContent)),
    focus: document.activeElement?.id || '',
  } : null;
});

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';

  /* ---------- My Lair: Pay with cash ---------- */
  let ctx = await context(browser, size);
  let page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/my-lair#tab', RUBY);
  await page.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend, null, { timeout: 20000 });
  const total = await seedRuby(page, RUBY);
  await page.evaluate(() => document.querySelector('my-lair')?.dispatchEvent(new CustomEvent('lair:refresh')));
  await page.waitForSelector('[data-tab-card] [data-cash-pay]', { timeout: 15000 });
  const before = await card(page);
  check(`${tag} My Lair: the bill has Pay with cash beside Show my Goblin card`, before && before.buttons.includes('Pay with cash') && before.buttons.includes('Show my Goblin card'), before);
  await page.click('[data-tab-card] [data-cash-pay]');
  await page.waitForSelector('[data-tab-card] [data-cash-cancel]', { timeout: 10000 });
  await settle(page, 200);
  const paying = await card(page);
  check(`${tag} My Lair: Paying cash says what to hand over (${money(total)}), with the Goblin card and I'll pay another way, focus on the title`,
    paying.title === `Paying cash: ${money(total)}` && paying.badge === 'Paying cash'
    && paying.ledes[0] === `Hand ${money(total)} to one of the team at the counter. They’ll tick it off, and you’re all paid.`
    && !paying.ledes.some((x) => /Tap Update/.test(x))
    && JSON.stringify(paying.buttons) === JSON.stringify(['Show my Goblin card', 'I’ll pay another way']) && paying.focus === 'ml-tabcard-title', paying);
  const asked = await page.evaluate(() => JSON.parse(JSON.stringify(window.Lair.store.backend.state.cash)));
  check(`${tag} My Lair: the request is waiting, for the bill's total`, asked.length === 1 && asked[0].status === 'waiting' && asked[0].total === total, asked);
  await shot(page, `${size}-mylair-paying-cash`, '[data-tab-card]');
  await axe(page, `${tag} My Lair: paying cash`, '[data-tab-card]');
  check(`${tag} My Lair: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  // a chocolate bar goes on the tab elsewhere: the card says the bill's changed, and Update brings the request up to date
  await page.evaluate(async () => {
    const be = window.Lair.store.backend;
    const tab = be.state.tabs.find((x) => x.id === 'tb-cash-1');
    tab.items.push({ variantId: '9002', title: 'Moro', variantTitle: 'Default Title', price: 300, qty: 1 });
    tab.total = 1000;
    be.commit();
    await document.querySelector('my-lair').refreshTab();
  });
  await page.waitForSelector('.ml-tabcard__cash-changed', { timeout: 10000 });
  const changed = await card(page);
  check(`${tag} My Lair: a changed bill says the new total and offers Update`,
    changed.ledes.includes(`Your bill’s ${money(total + 300)} now. Tap Update so the team see the new total.`) && changed.buttons[0] === 'Update', changed);
  await page.click('[data-tab-card] [data-cash-pay]');
  await page.waitForFunction((want) => (document.querySelector('.ml-tabcard__title')?.textContent || '').includes(want), money(total + 300), { timeout: 10000 });
  const updated = await page.evaluate(() => window.Lair.store.backend.state.cash.map((x) => [x.status, x.total]));
  check(`${tag} My Lair: Update brings the same request up to date`, JSON.stringify(updated) === JSON.stringify([['waiting', total + 300]]), updated);
  // they'll pay another way
  await page.click('[data-tab-card] [data-cash-cancel]');
  await page.waitForSelector('[data-tab-card] [data-cash-pay]', { timeout: 10000 });
  const back = { card: await card(page), state: await page.evaluate(() => window.Lair.store.backend.state.cash.map((x) => x.status)) };
  check(`${tag} My Lair: I'll pay another way takes it back (Pay with cash again)`, back.card.buttons.includes('Pay with cash') && JSON.stringify(back.state) === '["ended"]' && back.card.focus === 'ml-tabcard-title', back);
  check(`${tag} My Lair: no script errors`, !page.errors.length, page.errors.slice(0, 5));
  await ctx.close();

  /* ---------- the staff page: Paying cash ---------- */
  ctx = await context(browser, size);
  page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/lair-staff', STAFF);
  await page.waitForSelector('#checkin-code', { timeout: 20000 });
  /** Ruby's bill, and a request for it waiting (total: what staff are shown; stale: an older total) */
  const ask = (stale = 0) => page.evaluate(async ([r, off]) => {
    const { store } = window.Lair;
    const be = store.backend;
    const t = be.time;
    const now = Date.now();
    if (!be.memberList().some((x) => String(x.customerId) === String(r.id))) be.memberFromPick(String(r.id), r.name, r.email);
    be.state.bookings = be.state.bookings.filter((b) => !/^bk-cash-/.test(b.id));
    be.state.tabs = (be.state.tabs || []).filter((x) => !/^tb-cash-/.test(x.id));
    be.state.bookings.push({
      id: 'bk-cash-t5', ref: 'RT-CASH-5', kind: 'table', status: 'confirmed', pay: 'day', paid: false, amount: 2000, covered: 0, paidAmount: 0,
      email: r.email, phone: '', notes: '', activity: 'board', extras: [], name: r.name, createdAt: now - 3600000, customerId: String(r.id),
      tables: ['T5'], start: t.at(t.today(), 20 * 60), end: t.at(t.today(), 23 * 60), people: 2,
    });
    be.state.tabs.push({ id: 'tb-cash-1', customerId: String(r.id), day: t.today(), items: [{ variantId: '9001', title: 'Coke', variantTitle: 'Default Title', price: 350, qty: 2 }], total: 700, status: 'open', orderId: null, createdAt: now, updatedAt: now });
    const bill = be.cashBillFor({ id: String(r.id), email: r.email });
    be.state.cash = [{ id: 'cr-demo-1', customerId: String(r.id), day: t.today(), status: 'waiting', total: bill.total - off, items: bill.items, at: now - 120000 }];
    be.commit();
    await store.refresh();
    return bill.total;
  }, [{ id: RUBY.id, name: RUBY.name, email: RUBY.email }, stale]);
  let staffTotal = await ask();
  await page.evaluate(() => document.querySelector('lair-staff').render(true));
  await page.waitForSelector('[data-cash] [data-cash-paid]', { timeout: 15000 });
  const list = await page.evaluate(() => {
    const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    const sec = document.querySelector('[data-cash] .staff-cash');
    return {
      h: f(sec?.querySelector('h3')?.textContent),
      name: f(sec?.querySelector('.staff-card__head strong')?.textContent),
      badge: f(sec?.querySelector('.staff-card__head .badge')?.textContent),
      items: [...(sec?.querySelectorAll('.staff-cash__items li') || [])].map((li) => f(li.textContent)),
      buttons: [...(sec?.querySelectorAll('button') || [])].map((b) => f(b.textContent)),
      aboveTabs: Boolean(document.querySelector('[data-cash] + .staff-bar')),
    };
  });
  check(`${tag} staff: Paying cash under check-in (above the tabs), with Ruby, what's on her bill and Got the cash: ${money(staffTotal)} and Not paid`,
    list.h === 'Paying cash 1' && list.name === 'Ruby Tane' && list.badge === `${money(staffTotal)} cash` && list.aboveTabs
    && list.items.some((x) => /^Table T5/.test(x)) && list.items.some((x) => x === 'Tab: 2 things (2 × Coke)$7')
    && JSON.stringify(list.buttons) === JSON.stringify([`Got the cash: ${money(staffTotal)}`, 'Not paid']), list);
  await shot(page, `${size}-staff-paying-cash`, '[data-cash]');
  await axe(page, `${tag} staff: Paying cash`, '[data-cash]');
  check(`${tag} staff: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  // Got the cash: two taps
  await page.click('[data-cash-paid="cr-demo-1"]');
  const armed = await page.evaluate(() => document.querySelector('[data-cash-paid="cr-demo-1"]')?.textContent.trim());
  await page.click('[data-cash-paid="cr-demo-1"]');
  await settle(page, 700);
  const paid = await page.evaluate(() => {
    const be = window.Lair.store.backend;
    return {
      cash: be.state.cash.map((x) => x.status),
      booking: (({ status, paid: p }) => [status, p])(be.state.bookings.find((b) => b.id === 'bk-cash-t5')),
      tab: be.state.tabs.find((x) => x.id === 'tb-cash-1').status,
      list: Boolean(document.querySelector('[data-cash] .staff-cash')),
    };
  });
  check(`${tag} staff: Got the cash takes two taps, then Ruby's checked in and it's all paid, and the list is gone`,
    armed === `Tap again: got ${money(staffTotal)}` && JSON.stringify(paid) === JSON.stringify({ cash: ['paid'], booking: ['seated', true], tab: 'paid', list: false })
    && (await toast(page)) === `Paid in cash: ${money(staffTotal)} from Ruby Tane. They’re checked in, and Gobgob’s putting it in Shopify.`, { armed, paid, toast: await toast(page) });
  // a total that's changed since she asked: said, shown, and taken at the new total
  staffTotal = await ask(300);
  await page.evaluate(() => document.querySelector('lair-staff').render(true));
  await page.waitForSelector('[data-cash-paid="cr-demo-1"]', { timeout: 10000 });
  const shown = await page.evaluate(() => Number(document.querySelector('[data-cash-paid="cr-demo-1"]').dataset.total));
  await page.click('[data-cash-paid="cr-demo-1"]');
  await page.click('[data-cash-paid="cr-demo-1"]');
  await settle(page, 700);
  const told = await toast(page);
  const now = await page.evaluate(() => document.querySelector('[data-cash-paid="cr-demo-1"]')?.textContent.trim());
  check(`${tag} staff: a changed total isn't taken: it says the new total, and the button shows it`,
    shown === staffTotal - 300 && told === `It's ${fixed(staffTotal)} now (a session pass took some off, or their tab changed). Take ${fixed(staffTotal)}, then tap Got the cash again.`
    && now === `Got the cash: ${money(staffTotal)}`, { shown, told, now });
  await page.click('[data-cash-paid="cr-demo-1"]');
  await page.click('[data-cash-paid="cr-demo-1"]');
  await settle(page, 700);
  check(`${tag} staff: then it's taken at the new total`, (await page.evaluate(() => window.Lair.store.backend.state.cash.map((x) => [x.status, x.total])))[0][0] === 'paid', await toast(page));
  // Not paid
  await ask();
  await page.evaluate(() => document.querySelector('lair-staff').render(true));
  await page.waitForSelector('[data-cash-cancel="cr-demo-1"]', { timeout: 10000 });
  await page.click('[data-cash-cancel="cr-demo-1"]');
  const armedNot = await page.evaluate(() => document.querySelector('[data-cash-cancel="cr-demo-1"]')?.textContent.trim());
  await page.click('[data-cash-cancel="cr-demo-1"]');
  await settle(page, 600);
  const ended = await page.evaluate(() => ({ cash: window.Lair.store.backend.state.cash.map((x) => x.status), paid: window.Lair.store.backend.state.bookings.find((b) => b.id === 'bk-cash-t5').paid }));
  check(`${tag} staff: Not paid takes two taps, ends it and pays nothing`,
    armedNot === 'Tap again: not paid' && JSON.stringify(ended) === JSON.stringify({ cash: ['ended'], paid: false })
    && (await toast(page)) === 'Cleared Ruby Tane’s cash payment. Nothing was paid.', { armedNot, ended, toast: await toast(page) });
  check(`${tag} staff page: no script errors`, !page.errors.length, page.errors.slice(0, 5));
  await ctx.close();

  /* ---------- live: the four calls, against a stubbed Lair app ---------- */
  m.globalSettings.lair_mode = 'live';
  const calls = [];
  m.mockState.before = async (req, res, url) => {
    if (!url.pathname.startsWith('/apps/liar/')) return false;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const route = url.pathname.replace('/apps/liar', '');
    if (req.method === 'POST') calls.push({ path: route, body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cash: null, notices: [] }));
    return true;
  };
  const lctx = await context(browser, size);
  const lp = watch(await lctx.newPage());
  await go(lp, BASE, '/pages/my-lair', STAFF);
  await lp.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend, null, { timeout: 20000 });
  await lp.evaluate(async () => {
    const be = window.Lair.store.backend;
    await be.payCash();
    await be.cancelCash();
    await be.cashPaid('cr_1', 2700);
    await be.cashNotPaid('cr_1');
  });
  check(`${tag} live: POST /me/cash, /me/cash/cancel, /cash/:id/paid { expect } and /cash/:id/cancel`,
    JSON.stringify(calls.filter((x) => /cash/.test(x.path))) === JSON.stringify([
      { path: '/me/cash', body: {} },
      { path: '/me/cash/cancel', body: {} },
      { path: '/cash/cr_1/paid', body: { expect: 2700 } },
      { path: '/cash/cr_1/cancel', body: {} },
    ]), calls);
  await lctx.close();
  m.mockState.before = null;
  m.globalSettings.lair_mode = 'demo';
}

const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed. Screens in ${process.env.OUT}`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

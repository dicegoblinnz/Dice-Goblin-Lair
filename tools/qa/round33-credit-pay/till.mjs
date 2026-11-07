// Round 33 (7 Nov 2026, contract v33-credit-pay), on the theme mock. Mo: "I want to add pay using store credit for
// clients as an extra option thanks", at the counter till and on My Lair's bill. This is the till, with Sales: Live (the
// lab's page.till.json) and a stand-in for the Lair app's till routes, so the till's live paths run as they will:
//  1. Hemi unlocks the till; Ruby's code is scanned ($5 of store credit); two products ($26.99).
//  2. Use their $5 store credit: Store credit −$5.00, Left to pay $21.99, Card · $21.99.
//  3. Card: Pay sends credit: true with card; the EFTPOS screen says $21.99. Back lets the sale go (its store credit goes
//     back on, the Lair app's job).
//  4. Card again, Confirm paid: expect is $21.99 (what's left), the done screen says the store credit.
//  5. $50 of store credit and $11: Pay with store credit (method 'credit', no PIN), paid at once.
//  6. Their store credit changed meanwhile: the Lair app's words, and Ruby's screen as she is now.
//  7. The customer screen: staff's line goes with them; Ruby scans her own code, Use my store credit, Pay with my
//     store credit (no staff token). The store credit tile says to use it in the sale (or on her basket), not on POS.
//  8. (the reviews, 8 Nov) A lost answer: says it may have gone through; tapping again sends the same key, so it's
//     taken once. The screen changing hands while store credit pays: the paid sale still shows as paid. Practice
//     sales with real people: store credit isn't offered (it's on Shopify POS).
// No sideways scroll, no console errors and axe at each. The counter's tablet: 1280×800 and 800×1280.
// Usage: DG_THEME=/path/to/theme [PORT=4996] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round33-credit-pay/till.mjs [wide|tall]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round33-credit-pay');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, overflowX, axe, shot, watch, go, clockAt, STAFF } = lib;
const PORT = Number(process.env.PORT || 4996);
const BASE = `http://localhost:${PORT}`;
const API = (m.globalSettings.lair_api || '/apps/liar').replace(/\/$/, '');
const VIEWPORTS = { wide: { width: 1280, height: 800 }, tall: { width: 800, height: 1280 } };
const sizes = process.argv[2] ? [process.argv[2]] : ['wide', 'tall'];
const money = (c) => `$${(c / 100).toFixed(2)}`;

/* ---------- the Lair app's till routes, standing in (contract v32-till and v33-credit-pay) ---------- */
const HEMI = { id: 'hemi', name: 'Hemi', fullName: 'Hemi Walker', role: 'owner', kind: 'team', roleWords: 'Owner', perms: ['checkin', 'money'], pin: 'own', off: false, locked: false };
const RUBY_CODE = 'RT-OWLBEAR-17';
const PRODUCTS = {
  '9300000000017': { product: { title: 'MTG - The Hobbit', vendor: 'Wizards of the Coast', type: 'Trading Card Games' }, variant: { id: 5013, title: 'Booster Pack', price: '11.00', sku: 'MTG-HOB-BP', barcode: '9300000000017' } },
  '9300000000024': { product: { title: 'Riftbound Radiance', vendor: 'Riot Games', type: 'Trading Card Games' }, variant: { id: 5011, title: 'Booster Pack', price: '15.99', sku: 'RB-RAD-BP', barcode: '9300000000024' } },
};
const PRICE = { 5013: 1100, 5011: 1599 };
const SHORT = (balance, total) => `Their store credit is ${money(balance)}, so it doesn't cover ${money(total)}. Use it for part, and pay the rest by card or cash.`;

function lairApp() {
  // lose: the next till/pay is done, then its answer is lost; hold: till/pay waits for this promise before answering
  // gateway: the next till/pay is done, then Shopify's proxy gives up on it (a 504 page, not the Lair's words)
  const state = { balance: 500, sales: new Map(), keys: new Map(), next: 1, calls: [], lose: false, hold: null, gateway: false };
  const person = (staff) => ({
    id: '7700112233', first: 'Ruby', name: staff ? 'Ruby Tane' : 'Ruby T.', code: RUBY_CODE, since: 'October 2026', ...(staff ? { email: 'r***@example.com' } : {}),
    loyalty: { onCard: 3, slots: 10, headStart: 0, stamps: 3 }, passes: [], library: [], bookings: [], tab: null, account: { billing: 'visit' }, credit: state.balance,
  });
  const totalOf = (lines) => lines.reduce((sum, l) => sum + (PRICE[l.variantId] || 0) * (Number(l.qty) || 1), 0);
  const view = (sale) => ({ ...sale, due: sale.total - sale.credit });
  const answer = (status, body) => ({ status, body });
  const routes = {
    'till/team': () => answer(200, { team: [HEMI] }),
    'till/unlock': (b) => (b.id === 'hemi' && b.pin === '1234' ? answer(200, { token: 'tok-hemi', staff: HEMI, mustChange: false }) : answer(401, { error: "That PIN isn't right. Try again." })),
    'till/tonight': () => answer(200, { rows: [], night: null }),
    'till/scan': (b) => (String(b.code).toUpperCase() === RUBY_CODE ? answer(200, { type: 'person', person: person(Boolean(b.token)) }) : answer(404, { error: "Gobgob doesn't know that code." })),
    'till/person': (b) => (b.id === '7700112233' ? answer(200, { person: person(Boolean(b.token)) }) : answer(404, { error: 'Not found.' })),
    'till/product': (b) => (PRODUCTS[b.code] ? answer(200, PRODUCTS[b.code]) : answer(404, { error: "The shop doesn't have that barcode." })),
    'till/find': () => answer(200, { people: [] }),
    'till/search': () => answer(200, { products: [] }),
    'till/price': (b) => {
      const total = totalOf(b.lines);
      return answer(200, { price: { subtotal: total, discounts: [], total, gst: Math.round((total * 3) / 23), lines: b.lines.map((l) => ({ key: l.key, qty: l.qty, unit: PRICE[l.variantId] })) }, dropped: [] });
    },
    'till/pay': (b) => {
      // (the review) the same key again: that sale as it stands
      const known = b.key ? state.sales.get(state.keys.get(b.key)) : null;
      if (known && known.status !== 'gone') return answer(200, { sale: view(known), dropped: [], notices: [], repeated: true });
      const total = totalOf(b.lines);
      const useCredit = b.method === 'credit' || b.credit === true;
      if (!['card', 'cash', 'credit'].includes(b.method)) return answer(400, { error: 'Pay by card, with cash or with store credit.' });
      if (useCredit && !b.person) return answer(422, { error: 'Store credit needs a member on the sale: scan their code first.' });
      if (useCredit && state.balance <= 0) return answer(409, { error: "They don't have any store credit right now." });
      if (b.method === 'credit' && state.balance < total) return answer(409, { error: SHORT(state.balance, total) });
      const credit = useCredit ? Math.min(state.balance, total) : 0;
      state.balance -= credit;
      const id = `ts_${String(state.next++).padStart(4, '0')}`;
      const paid = credit === total;
      const sale = {
        id, status: paid ? 'paid' : 'open', method: b.method, total, subtotal: total, gst: Math.round((total * 3) / 23), discounts: [], lines: [], person: b.person ? { id: b.person, first: 'Ruby' } : null,
        credit, order: paid ? { id: 'gid://shopify/Order/1', name: '#3001' } : null, saving: false, receipt: paid && b.person ? 'r***@example.com' : null, change: null,
      };
      state.sales.set(id, sale);
      if (b.key) state.keys.set(b.key, id);
      return answer(200, { sale: view(sale), dropped: [], notices: [] });
    },
    'till/paid': (b) => {
      const sale = state.sales.get(b.sale);
      if (!sale || sale.status !== 'open') return answer(409, { error: 'That sale was let go. Start it again.' });
      const due = sale.total - sale.credit;
      if (b.expect !== due) return answer(409, { error: `This sale is ${money(due)} now. Check the EFTPOS, then confirm again.` });
      Object.assign(sale, { status: 'paid', order: { id: 'gid://shopify/Order/2', name: '#3002' }, receipt: sale.person ? 'r***@example.com' : null });
      return answer(200, { sale: view(sale) });
    },
    'till/pay/cancel': (b) => {
      const sale = state.sales.get(b.sale);
      if (sale && sale.status === 'open') {
        sale.status = 'gone';
        state.balance += sale.credit;
      }
      return answer(200, { ok: true });
    },
  };
  return {
    state,
    async handle(route) {
      const req = route.request();
      const url = new URL(req.url());
      const name = url.pathname.slice(API.length + 1);
      const body = req.method() === 'POST' ? JSON.parse(req.postData() || '{}') : {};
      state.calls.push({ name, body });
      const fn = routes[name];
      if (name === 'till/pay' && state.hold) await state.hold;
      const { status, body: out } = fn ? fn(body) : answer(404, { error: 'No such route.' });
      if (name === 'till/pay' && state.lose) {
        state.lose = false;
        await route.abort('failed');
        return;
      }
      if (name === 'till/pay' && state.gateway) {
        state.gateway = false;
        await route.fulfill({ status: 504, contentType: 'text/html', body: '<html><body>Gateway Timeout</body></html>' });
        return;
      }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(out) });
    },
  };
}

const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 400) => page.waitForTimeout(ms);

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';
  const lair = lairApp();
  const ctx = await browser.newContext({ viewport: VIEWPORTS[size], deviceScaleFactor: 1, hasTouch: true });
  await ctx.addInitScript(clockAt('19:30'));
  await ctx.route(`${BASE}${API}/**`, (route) => lair.handle(route));
  const page = watch(await ctx.newPage());
  const calls = (name) => lair.state.calls.filter((c) => c.name === name);
  const scan = async (code) => {
    await page.evaluate((c) => document.querySelector('lair-till').onScan(c), code);
    await settle(page, 700);
  };
  // (the head and the screen over it can both have a button: the one on top)
  const tap = async (sel) => {
    const over = page.locator(`[data-r="over"] ${sel} >> visible=true`);
    await ((await over.count()) ? over : page.locator(`${sel} >> visible=true`)).first().click();
    await settle(page, 500);
  };
  const look = () => page.evaluate(() => {
    const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const q = (s) => document.querySelector(s);
    const sale = q('[data-r="sale"]');
    const over = q('[data-r="over"]');
    return {
      totals: [...(sale?.querySelectorAll('.t-totals p') || [])].map((p) => [...p.children].map((c) => f(c.textContent)).join(' ')),
      tick: sale?.querySelector('[data-in="credit"]') ? f(sale.querySelector('[data-in="credit"]').closest('label').textContent) : '',
      ticked: Boolean(sale?.querySelector('[data-in="credit"]')?.checked),
      pay: [...(sale?.querySelectorAll('.t-pay button') || [])].map((b) => f(b.textContent) + (b.disabled ? ' (off)' : '')),
      amount: f(over?.querySelector('.t-paying__amount')?.textContent), steps: [...(over?.querySelectorAll('.t-steps li') || [])].map((li) => f(li.textContent)),
      done: f(over?.querySelector('.t-done .t-h1')?.textContent), doneLines: [...(over?.querySelectorAll('.t-done .t-done__lines') || [])].map((p) => f(p.textContent)),
      toast: f(q('[data-r="toast"]')?.textContent),
    };
  });

  await go(page, BASE, '/pages/till', STAFF);
  await page.waitForSelector('[data-act="staff-door"]', { timeout: 20000 });
  await settle(page, 500);
  check(`${tag} Sales: Live with the Lair app answering: no Practice pill`, (await page.locator('.t-pill', { hasText: 'Practice' }).count()) === 0, 'Practice shows');

  /* ---------- 1. Hemi unlocks; Ruby and two products ---------- */
  await tap('[data-act="staff-door"]');
  await tap('[data-act="pick"][data-id="hemi"]');
  for (const d of '1234') await tap(`[data-act="digit"][data-d="${d}"]`);
  await settle(page, 800);
  await scan(RUBY_CODE);
  await scan('9300000000017');
  await scan('9300000000024');
  let v = await look();
  check(`${tag} Ruby on the sale with $5 of store credit: "Use their $5.00 store credit", not ticked; Card · $26.99`,
    v.tick === 'Use their $5.00 store credit' && !v.ticked && v.pay[0] === 'Card · $26.99' && v.totals.includes('Total $26.99'), v);

  /* ---------- 2. Use their store credit ---------- */
  await page.check('[data-in="credit"]');
  await settle(page, 300);
  v = await look();
  check(`${tag} ticked: Store credit −$5.00, Left to pay $21.99, Card · $21.99, Cash`,
    v.ticked && v.totals.includes('Store credit −$5.00') && v.totals.includes('Left to pay $21.99') && v.pay.join(' | ') === 'Card · $21.99 | Cash', v);
  await shot(page, `till-${size}-1-ticked`);
  await axe(page, `${tag} the sale, with store credit ticked`, '[data-r="sale"]');

  /* ---------- 3. Card, then Back ---------- */
  await tap('[data-act="pay-card"]');
  v = await look();
  let sent = calls('till/pay').at(-1)?.body || {};
  check(`${tag} Card sends credit: true with card, Ruby and Hemi's till; the EFTPOS screen says $21.99`,
    sent.method === 'card' && sent.credit === true && sent.person === '7700112233' && sent.token === 'tok-hemi' && v.amount === '$21.99' && v.steps[0] === 'Key $21.99 into the EFTPOS', { sent, v });
  await shot(page, `till-${size}-2-card`);
  await axe(page, `${tag} the EFTPOS screen, part store credit`, '[data-r="over"]');
  const first = calls('till/pay').at(-1);
  await tap('[data-act="back"]');
  v = await look();
  const cancelled = calls('till/pay/cancel').at(-1)?.body || {};
  check(`${tag} Back lets the sale go (the Lair app puts the $5 back), and the sale's as it was, still ticked`,
    Boolean(first) && cancelled.sale === 'ts_0001' && lair.state.balance === 500 && v.ticked && v.pay[0] === 'Card · $21.99', { cancelled, balance: lair.state.balance, v });

  /* ---------- 4. Card again, Confirm paid ---------- */
  await tap('[data-act="pay-card"]');
  await tap('[data-act="card-ok"]');
  v = await look();
  const confirmed = calls('till/paid').at(-1)?.body || {};
  check(`${tag} Confirm paid: expect is $21.99 (what's left), the done screen says $21.99 by card and the $5.00 store credit`,
    confirmed.expect === 2199 && confirmed.token === 'tok-hemi' && v.done === 'Paid $21.99 by card' && v.doneLines[0] === 'Ruby Tane · Order #3002 · $5.00 store credit', { confirmed, v });
  await shot(page, `till-${size}-3-done-split`);
  await axe(page, `${tag} the done screen, split`, '[data-r="over"]');

  /* ---------- 5. store credit pays all of it ---------- */
  lair.state.balance = 5000;
  await tap('[data-act="next"]');
  await scan(RUBY_CODE);
  await scan('9300000000017');
  await page.check('[data-in="credit"]');
  await settle(page, 300);
  v = await look();
  check(`${tag} $50 of store credit and $11: Pay with store credit, Cash off`,
    v.totals.includes('Store credit −$11.00') && v.totals.includes('Left to pay $0.00') && v.pay.join(' | ') === 'Pay with store credit | Cash (off)', v);
  await tap('[data-act="pay-credit"]');
  v = await look();
  sent = calls('till/pay').at(-1)?.body || {};
  check(`${tag} Pay with store credit: method credit (no credit flag), paid at once with no PIN: "Paid $11.00 with store credit"`,
    sent.method === 'credit' && sent.credit === undefined && v.done === 'Paid $11.00 with store credit' && v.doneLines[0] === 'Ruby Tane · Order #3001' && calls('till/paid').length === 1, { sent, v });
  await shot(page, `till-${size}-4-done-credit`);

  /* ---------- 6. their store credit changed meanwhile ---------- */
  await tap('[data-act="next"]');
  await scan(RUBY_CODE);
  await scan('9300000000017');
  await page.check('[data-in="credit"]');
  await settle(page, 300);
  lair.state.balance = 450;
  await tap('[data-act="pay-credit"]');
  await settle(page, 500);
  v = await look();
  check(`${tag} their store credit changed meanwhile: the Lair app's words, and Ruby as she is now ($4.50, not ticked)`,
    v.toast === SHORT(450, 1100) && v.tick === 'Use their $4.50 store credit' && !v.ticked && v.pay[0] === 'Card · $11.00' && !v.done, v);
  check(`${tag} the till: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));

  const tile = () => page.evaluate(() => {
    const t = [...document.querySelectorAll('.t-tile')].find((x) => /Store credit/.test(x.textContent));
    return t ? String(t.querySelector('.t-tile__note')?.textContent || '').trim() : '';
  });
  check(`${tag} the store credit tile: use it in the sale (not on Shopify POS any more)`, (await tile()) === 'Use it in the sale', await tile());

  /* ---------- 7. the customer screen ---------- */
  lair.state.balance = 5000;
  await tap('[data-act="to-customers"]');
  v = await look();
  check(`${tag} handing the screen to customers takes the staff line about Ruby's store credit with it`, !v.toast, v.toast);
  await scan(RUBY_CODE);
  await scan('9300000000017');
  v = await look();
  check(`${tag} the customer screen: "Use my $50.00 store credit", and the tile says to use it on her basket`, v.tick === 'Use my $50.00 store credit' && !v.ticked && (await tile()) === 'Use it on your basket', { v, tile: await tile() });
  await page.check('[data-in="credit"]');
  await settle(page, 300);
  v = await look();
  check(`${tag} ticked: Your store credit −$11.00 and Pay with my store credit`, v.totals.includes('Your store credit −$11.00') && v.pay[0] === 'Pay with my store credit', v);
  await shot(page, `till-${size}-5-customer`);
  await axe(page, `${tag} the customer's basket, with store credit`, '[data-r="sale"]');
  await tap('[data-act="pay-credit"]');
  v = await look();
  sent = calls('till/pay').at(-1)?.body || {};
  check(`${tag} Pay with my store credit: no staff token, paid: "Paid $11.00 with your store credit", thanks Ruby`,
    sent.method === 'credit' && !sent.token && v.done === 'Paid $11.00 with your store credit' && v.doneLines[0] === 'Thanks, Ruby! See you at the table.', { sent, v });
  await shot(page, `till-${size}-6-customer-done`);
  await axe(page, `${tag} the customer's done screen`, '[data-r="over"]');
  check(`${tag} the customer screen: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));

  /* ---------- 8. the reviews: a lost answer, the screen changing hands, Practice ---------- */
  await tap('[data-act="next"]');
  await tap('[data-act="staff-door"]');
  await tap('[data-act="pick"][data-id="hemi"]');
  for (const d of '1234') await tap(`[data-act="digit"][data-d="${d}"]`);
  await settle(page, 600);
  lair.state.balance = 5000;
  await scan(RUBY_CODE);
  await scan('9300000000017');
  await page.check('[data-in="credit"]');
  await settle(page, 300);
  lair.state.lose = true;
  const before = calls('till/pay').length;
  await tap('[data-act="pay-credit"]');
  v = await look();
  check(`${tag} a lost answer on Pay with store credit: it may have gone through, tap it again (never taken twice)`,
    v.toast === "The till didn't hear back from the Lair app, so it may have gone through. Tap it again to check: store credit is never taken twice." && !v.done && lair.state.balance === 3900, { v, balance: lair.state.balance });
  await tap('[data-act="pay-credit"]');
  v = await look();
  const tries = calls('till/pay').slice(before).map((c) => c.body.key);
  check(`${tag} tapping again sends the same key: the same paid sale, taken once`,
    tries.length === 2 && Boolean(tries[0]) && tries[0] === tries[1] && v.done === 'Paid $11.00 with store credit' && lair.state.balance === 3900, { tries, v, balance: lair.state.balance });
  // a lost answer, then Start over and the same basket again: the same key, so it's still taken once; half an hour on,
  // a new key
  await tap('[data-act="next"]');
  await scan(RUBY_CODE);
  await scan('9300000000017');
  await page.check('[data-in="credit"]');
  await settle(page, 300);
  lair.state.lose = true;
  const from = calls('till/pay').length;
  await tap('[data-act="pay-credit"]');
  await tap('[data-act="clear-person"]');
  await scan(RUBY_CODE);
  await page.check('[data-in="credit"]');
  await settle(page, 300);
  await tap('[data-act="pay-credit"]');
  const redo = calls('till/pay').slice(from).map((c) => c.body.key);
  v = await look();
  check(`${tag} a lost answer, then Not Ruby? and the same basket again: the same key, the same paid sale, taken once`,
    redo.length === 2 && redo[0] === redo[1] && v.done === 'Paid $11.00 with store credit' && lair.state.balance === 2800, { redo, v, balance: lair.state.balance });
  await tap('[data-act="next"]');
  await scan(RUBY_CODE);
  await scan('9300000000017');
  await page.check('[data-in="credit"]');
  await settle(page, 300);
  lair.state.lose = true;
  await tap('[data-act="pay-credit"]');
  await page.evaluate(() => {
    const real = Date.now;
    Date.now = () => real() + 31 * 60_000;
  });
  await tap('[data-act="pay-credit"]');
  const stale = calls('till/pay').slice(-2).map((c) => c.body.key);
  check(`${tag} half an hour after a lost answer, Pay starts a new key`, stale.length === 2 && stale[0] !== stale[1], stale);

  // Shopify's proxy gives up on a slow Pay (the Lair app went on and took it): the same, not "try again"
  lair.state.balance = 5000;
  await tap('[data-act="next"]');
  await scan(RUBY_CODE);
  await scan('9300000000017');
  await page.check('[data-in="credit"]');
  await settle(page, 300);
  lair.state.gateway = true;
  const gw = calls('till/pay').length;
  await tap('[data-act="pay-credit"]');
  v = await look();
  const gwToast = v.toast;
  await tap('[data-act="pay-credit"]');
  v = await look();
  const gwKeys = calls('till/pay').slice(gw).map((c) => c.body.key);
  check(`${tag} the shop's proxy giving up on a slow Pay: it may have gone through; tapping again sends the same key, taken once`,
    gwToast === "The till didn't hear back from the Lair app, so it may have gone through. Tap it again to check: store credit is never taken twice."
    && gwKeys.length === 2 && gwKeys[0] === gwKeys[1] && v.done === 'Paid $11.00 with store credit' && lair.state.balance === 3900, { gwToast, gwKeys, v, balance: lair.state.balance });

  // the screen changes hands while store credit pays all of it
  lair.state.balance = 5000;
  await tap('[data-act="next"]');
  await scan(RUBY_CODE);
  await scan('9300000000017');
  await page.check('[data-in="credit"]');
  await settle(page, 300);
  let release;
  lair.state.hold = new Promise((resolve) => { release = resolve; });
  await page.locator('[data-r="sale"] [data-act="pay-credit"]').click();
  await settle(page, 200);
  await tap('[data-act="to-customers"]');
  lair.state.hold = null;
  release();
  await settle(page, 800);
  v = await look();
  const paidSale = [...lair.state.sales.values()].at(-1);
  check(`${tag} the screen changed hands while store credit paid: the paid sale still shows as paid, and isn't let go`,
    paidSale.status === 'paid' && /^Paid \$11\.00 with (your )?store credit$/.test(v.done) && !calls('till/pay/cancel').some((c) => c.body.sale === paidSale.id), { v, paidSale: paidSale.status });
  check(`${tag} the till: no console errors`, page.errors.length === 0, page.errors);
  await ctx.close();

  // Practice sales with the Lair's real people: their store credit is real, so it isn't offered in a practice sale
  m.mockState.sectionSettings = { 'lair-till': { sales: 'practice' } };
  const ctx2 = await browser.newContext({ viewport: VIEWPORTS[size], deviceScaleFactor: 1, hasTouch: true });
  await ctx2.addInitScript(clockAt('19:30'));
  const lair2 = lairApp();
  lair2.state.balance = 5000;
  await ctx2.route(`${BASE}${API}/**`, (route) => lair2.handle(route));
  const practice = watch(await ctx2.newPage());
  await go(practice, BASE, '/pages/till', STAFF);
  await practice.waitForSelector('[data-act="staff-door"]', { timeout: 20000 });
  await settle(practice, 500);
  const ptap = async (sel) => {
    const over = practice.locator(`[data-r="over"] ${sel} >> visible=true`);
    await ((await over.count()) ? over : practice.locator(`${sel} >> visible=true`)).first().click();
    await settle(practice, 500);
  };
  await ptap('[data-act="staff-door"]');
  await ptap('[data-act="pick"][data-id="hemi"]');
  for (const d of '1234') await ptap(`[data-act="digit"][data-d="${d}"]`);
  await settle(practice, 600);
  await practice.evaluate((c) => document.querySelector('lair-till').onScan(c), RUBY_CODE);
  await settle(practice, 700);
  await practice.evaluate((c) => document.querySelector('lair-till').onScan(c), '9300000000017');
  await settle(practice, 700);
  const pv = await practice.evaluate(() => ({
    pill: Boolean([...document.querySelectorAll('.t-pill')].find((x) => /Practice/.test(x.textContent))),
    tick: Boolean(document.querySelector('[data-r="sale"] [data-in="credit"]')),
    note: String([...document.querySelectorAll('.t-tile')].find((x) => /Store credit/.test(x.textContent))?.querySelector('.t-tile__note')?.textContent || '').trim(),
  }));
  check(`${tag} Practice with real people: no store credit in the sale, and the tile says Shopify POS`, pv.pill && !pv.tick && pv.note === 'Use it on Shopify POS for now', pv);
  check(`${tag} Practice: no console errors`, practice.errors.length === 0, practice.errors);
  m.mockState.sectionSettings = null;
  await ctx2.close();
}

const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed (screenshots in ${process.env.OUT})`);
await browser.close();
server.close?.();
process.exit(fail ? 1 : 0);

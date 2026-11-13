// Round 35 on the theme mock's demo (Practice sales: the till's own sums, no Lair app), in either look: dollars off each
// one, the till's own limit (20% of its price for the thing), the review's finding from round 34 still holding (Back
// while a discount's PIN is being checked pays nothing), and Discount on everything (11 Nov 2026).
// Round 36 (Mo, 13 Nov 2026: "instead of locking it just create a warning message"): past 20% the till asks first
// where it used to say the most a thing could come down by; the checks below that typed a cent too much meet that
// question and say No. The whole of the new way on the practice till is tools/qa/round36-till-discount-over/practice.mjs.
// Usage: DG_THEME=/path/to/theme [LOOK=pieces|first] [PORT=4990] node tools/qa/round35-till-discounts/practice.mjs
import fs from 'node:fs';
import path from 'node:path';

const lib = await import('../round15/lib.mjs');
const { chromium, m } = lib;
const THEME = process.env.DG_THEME;
const PORT = Number(process.env.PORT || 4990);
const LOOK = process.env.LOOK || 'pieces';
const TYPES = { '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2' };
m.globalSettings.lair_mode = 'demo';
m.mockState.before = async (req, res, url) => {
  if (!url.pathname.startsWith('/assets/')) return false;
  const type = TYPES[path.extname(url.pathname)];
  const file = path.join(THEME, 'assets', path.basename(url.pathname));
  if (!type || !fs.existsSync(file)) return false;
  res.writeHead(200, { 'Content-Type': type });
  res.end(fs.readFileSync(file));
  return true;
};
const server = await m.serve(PORT);
const browser = await chromium.launch();
const results = [];
const ok = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass || !detail ? '' : ` | ${detail}`}`);
};
const fresh = async () => {
  m.mockState.customer = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
  m.mockState.sectionSettings = { 'lair-till': { sales: 'practice', look: LOOK } };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
  await page.goto(`http://localhost:${PORT}/pages/till`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const T = {
    page, errors,
    s: () => page.evaluate(() => {
      const f = (t) => String(t || '').replace(/\s+/g, ' ').trim();
      const el = document.querySelector('lair-till');
      const s = el.s;
      const sale = document.querySelector('[data-r="sale"]');
      return {
        view: s.view, mode: s.mode, pay: s.pay ? s.pay.method : null, discountOk: Boolean(s.discountOk), busy: Boolean(s.busy), offs: s.lines.map((l) => l.off || 0),
        prices: s.lines.map((l) => l.price), totals: [...(sale?.querySelectorAll('.t-totals p') || [])].map((p) => [...p.children].map((c) => f(c.textContent)).join(' ')),
        toast: f(document.querySelector('[data-r="toast"]')?.textContent), lede: f(document.querySelector('[data-r="over"] .t-lede')?.textContent),
        title: f(document.querySelector('[data-r="over"] .t-h1')?.textContent),
      };
    }),
    click: async (sel, wait = 400) => {
      const over = page.locator(`[data-r="over"] ${sel} >> visible=true`);
      const loc = (await over.count()) ? over : page.locator(`${sel} >> visible=true`);
      await loc.first().click({ timeout: 4000 });
      await page.waitForTimeout(wait);
    },
    pin: async (digits, wait = 900) => {
      for (const d of digits) {
        await page.locator(`[data-act="digit"][data-d="${d}"] >> visible=true`).first().click();
        await page.waitForTimeout(100);
      }
      await page.waitForTimeout(wait);
    },
    scan: async (code) => {
      await page.evaluate((c) => document.querySelector('lair-till').onScan(c), code);
      await page.waitForTimeout(700);
    },
    type: async (text) => {
      await page.locator('#t-off').fill(text);
      await T.click('[data-form="discount"] button[type="submit"]');
    },
    noToast: () => page.evaluate(() => {
      const el = document.querySelector('lair-till');
      clearTimeout(el.toastTimer);
      el.s.toast = null;
      el.paintToast();
    }),
    // onto the staff side as the owner (who has Money), with their own PIN (2580), and a quick sale of one booster
    sale: async () => {
      await T.click('[data-act="staff-door"]');
      await T.click('[data-act="pick"] >> nth=0');
      await T.pin('1234');
      if ((await T.s()).view === 'newpin') {
        await T.pin('2580');
        await T.pin('2580');
      }
      await T.noToast();
      await T.click('[data-act="quick"]');
      await T.scan('810155276195');
      await T.noToast();
    },
    // the PIN's answer takes this long to come back, as it can on the shop's wifi
    slowPin: (ms) => page.evaluate((wait) => {
      const el = document.querySelector('lair-till');
      const real = el.staffApi.unlock.bind(el.staffApi);
      el.staffApi.unlock = async (...a) => {
        await new Promise((r) => setTimeout(r, wait));
        return real(...a);
      };
    }, ms),
  };
  return { T, ctx };
};

// 0. the demo says it's the demo: Demo codes on its start screen, and "Practice till" as staff sign in
{
  const { T, ctx } = await fresh();
  const texts = (sel) => T.page.evaluate((q) => [...document.querySelectorAll(q)].filter((b) => b.offsetParent).map((b) => b.textContent.replace(/\s+/g, ' ').trim()), sel);
  const doors = await texts('[data-r="over"] button');
  await T.click('[data-act="staff-door"]');
  const notes = await texts('[data-r="over"] .t-note');
  ok("the demo's start screen offers Demo codes beside Staff", doors.includes('Demo codes') && doors.includes('Staff'), JSON.stringify(doors));
  ok('and its sign-in screen says it is a practice till', notes.some((t) => /Practice till: sales here aren’t charged or saved yet\./.test(t)), JSON.stringify(notes));
  await ctx.close();
}

// 1. dollars off, the till's own limit, and the ordinary way through to cash
{
  const { T, ctx } = await fresh();
  await T.sale();
  const first = await T.s();
  const price = first.prices[0];
  const most = Math.floor(price * 0.2);
  await T.click('[data-act="discount"] >> nth=0');
  const screen = await T.s();
  ok('Discount says the price before the discount, with no percent and no limit', screen.view === 'discount' && screen.lede === `$${(price / 100).toFixed(2)} before the discount.`, JSON.stringify(screen));
  await T.type(((most + 1) / 100).toFixed(2));
  const over = await T.s();
  ok('a cent more than 20% of it (round 36): the till asks first, and nothing is on the line', over.view === 'discountover' && over.title === 'More than 20% off' && over.lede === 'This exceeds the 20% discount threshold. Are you sure you want to continue?' && !over.toast && over.offs[0] === 0, JSON.stringify(over));
  await T.click('[data-act="over-no"]');
  const back = await T.s();
  ok('No, go back: the Discount screen again', back.view === 'discount' && back.offs[0] === 0, JSON.stringify(back));
  await T.type((most / 100).toFixed(2));
  const set = await T.s();
  ok('exactly 20% of it is taken: the sale says Staff discount and the total', set.view === 'till' && set.offs[0] === most && set.totals.includes(`Staff discount −$${(most / 100).toFixed(2)}`) && set.totals.includes(`Total $${((price - most) / 100).toFixed(2)}`), JSON.stringify(set));
  await T.noToast();
  // one more of it: the same dollars off each one
  await T.click('[data-act="more"] >> nth=0');
  const two = await T.s();
  ok('two of it: the discount is off each one', two.totals.includes(`Staff discount −$${((most * 2) / 100).toFixed(2)}`) && two.totals.includes(`Total $${(((price - most) * 2) / 100).toFixed(2)}`), JSON.stringify(two.totals));
  await T.click('[data-act="pay-cash"]');
  const gate = await T.s();
  await T.click('[data-act="pick"] >> nth=0');
  await T.pin('2580');
  const after = await T.s();
  ok('a discount asks for a Money PIN at Pay, then pays the way that was chosen', gate.view === 'discountok' && after.view === 'cash' && after.pay === 'cash', JSON.stringify({ gate: gate.view, after: after.view, pay: after.pay }));
  ok('no errors on the page', T.errors.length === 0, T.errors.join(' | '));
  await ctx.close();
}

// 2. (round 34's review) Back while the PIN is being checked: nothing is paid, and the PIN isn't kept
{
  const { T, ctx } = await fresh();
  await T.sale();
  await T.click('[data-act="discount"] >> nth=0');
  await T.click('[data-act="discount-set"][data-c="100"]');
  await T.noToast();
  await T.click('[data-act="pay-cash"]');
  await T.click('[data-act="pick"] >> nth=0');
  await T.slowPin(700);
  await T.pin('2580', 120);
  await T.click('[data-act="back"]', 100);
  const backed = await T.s();
  await T.page.waitForTimeout(1300);
  const settled = await T.s();
  ok('Back while the PIN is checked goes back to the sale', backed.view === 'till', JSON.stringify(backed.view));
  ok('and the late answer starts no payment, and the approval is not kept', settled.view === 'till' && settled.pay === null && settled.discountOk === false, JSON.stringify({ view: settled.view, pay: settled.pay, ok: settled.discountOk }));
  await T.click('[data-act="pay-cash"]');
  const again = await T.s();
  await T.click('[data-act="pick"] >> nth=0');
  await T.pin('2580', 1600);
  const paid = await T.s();
  ok('Pay after that asks for the PIN again, and pays with cash', again.view === 'discountok' && paid.view === 'cash' && paid.pay === 'cash', JSON.stringify({ again: again.view, paid: paid.view }));
  ok('no errors on the page', T.errors.length === 0, T.errors.join(' | '));
  await ctx.close();
}

// 3. (Mo, 11 Nov 2026: "make $ off discount back") Discount on everything, on the till's own sums: dollars off the sale,
//    shared across its things; a booking in the sale keeps its price
{
  const { T, ctx } = await fresh();
  await T.sale();
  const one = await T.page.evaluate(() => [...document.querySelectorAll('.t-off')].filter((b) => b.offsetParent).map((b) => b.textContent.trim()));
  await T.scan('31283123823');
  await T.scan('31283123821');
  await T.noToast();
  const three = await T.page.evaluate(() => [...document.querySelectorAll('.t-off')].filter((b) => b.offsetParent).map((b) => b.textContent.trim()));
  ok('one thing in the sale has its own Discount only; with more, Discount on everything too', JSON.stringify(one) === JSON.stringify(['Discount']) && JSON.stringify(three) === JSON.stringify(['Discount', 'Discount', 'Discount', 'Discount on everything']), JSON.stringify({ one, three }));
  const before = (await T.s()).prices.reduce((n, c) => n + c, 0);
  const room = (await T.s()).prices.reduce((n, c) => n + Math.floor(c * 0.2), 0);
  await T.click('[data-act="discount"][data-key="*"]');
  const screen = await T.s();
  ok('Discount on everything says what the things cost before it', screen.view === 'discount' && screen.lede === `$${(before / 100).toFixed(2)} before the discount.`, JSON.stringify(screen));
  await T.type(((room + 1) / 100).toFixed(2));
  const over = await T.s();
  ok('a cent more than keeps them within 20% between them (round 36): the till asks first, and nothing is on the lines', over.view === 'discountover' && over.title === 'More than 20% off' && over.offs.every((c) => c === 0), JSON.stringify(over));
  await T.click('[data-act="over-no"]');
  await T.type('2');
  const set = await T.s();
  const sum = set.offs.reduce((n, c) => n + c, 0);
  ok('$2 is shared across the three, to the cent, each within 20% of its price', set.view === 'till' && sum === 200 && set.offs.every((c, i) => c > 0 && c <= Math.floor(set.prices[i] * 0.2)) && set.totals.includes('Staff discount −$2.00') && set.totals.includes(`Total $${((before - 200) / 100).toFixed(2)}`)
    && set.toast === '$2.00 off the sale, shared across 3 things. Someone with Money approves it at Pay.', JSON.stringify(set));
  await T.noToast();
  // the $2 stays with the sale when it changes: one more of the first thing, then one fewer
  await T.click('[data-act="more"] >> nth=0');
  const more = await T.s();
  await T.click('[data-act="less"] >> nth=0');
  const fewer = await T.s();
  ok('one more of something and the sale still has $2.00 off; one fewer, the same', more.totals.includes('Staff discount −$2.00') && more.totals.includes(`Total $${((before + more.prices[0] - 200) / 100).toFixed(2)}`) && fewer.totals.includes('Staff discount −$2.00') && fewer.totals.includes(`Total $${((before - 200) / 100).toFixed(2)}`), JSON.stringify({ more: more.totals, fewer: fewer.totals }));
  await T.noToast();
  // a booking's code adds what's left to pay on it: that keeps its price
  await T.scan('PS-HYDRA-14');
  await T.noToast();
  const kinds = await T.page.evaluate(() => document.querySelector('lair-till').s.lines.map((l) => l.kind));
  await T.click('[data-act="discount"][data-key="*"]');
  const withBooking = await T.s();
  const notes = await T.page.evaluate(() => [...document.querySelectorAll('[data-r="over"] .t-temp')].map((p) => p.textContent.replace(/\s+/g, ' ').trim()));
  ok('with a booking in the sale, the things are the same and the note says bookings keep their price', kinds.includes('owed') && withBooking.lede === `$${(before / 100).toFixed(2)} before the discount.` && notes[0] === 'Bookings and tabs keep their price.', JSON.stringify({ kinds, lede: withBooking.lede, notes }));
  await T.click('[data-act="discount-set"][data-c="0"]');
  const off = await T.s();
  ok('No discount takes it off everything', off.view === 'till' && off.toast === 'Discounts taken off.' && off.offs.every((c) => !c) && !off.totals.some((t) => /Staff discount/.test(t)), JSON.stringify(off));
  ok('no errors on the page', T.errors.length === 0, T.errors.join(' | '));
  await ctx.close();
}

await browser.close();
server.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

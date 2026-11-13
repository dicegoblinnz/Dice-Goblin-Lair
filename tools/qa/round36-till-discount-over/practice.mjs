// Round 36 on the theme mock's demo (Practice sales: the till's own sums, no Lair app), in either look. Mo (13 Nov
// 2026): "for the discount limitation of 20% instead of locking it just create a warning message [...] saying this
// exceeds the 20% threshold of discounts are you sure you wanna continue". On the practice till nothing is saved, so
// there is no order to flag and no email: what's checked here is the question, its yes and its no, what the PIN screen
// says, and that a sale's own discount never grows into a bigger share of the sale than was said yes to.
// Usage: DG_THEME=/path/to/theme [LOOK=pieces|first] [PORT=4989] node tools/qa/round36-till-discount-over/practice.mjs
import fs from 'node:fs';
import path from 'node:path';

const lib = await import('../round15/lib.mjs');
const { chromium, m } = lib;
const THEME = process.env.DG_THEME;
const PORT = Number(process.env.PORT || 4989);
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
        past: [...document.querySelectorAll('[data-r="over"] .t-warn li')].map((li) => f(li.textContent)), warn: f(document.querySelector('[data-r="over"] p.t-warn')?.textContent),
        subs: [...(sale?.querySelectorAll('.t-line') || [])].map((li) => f(li.querySelector('.t-line__sub')?.textContent)), titles: s.lines.map((l) => l.title),
        all: s.all, button: f([...document.querySelectorAll('.t-off--all')].filter((x) => x.offsetParent)[0]?.textContent),
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

const ASK = 'This exceeds the 20% discount threshold. Are you sure you want to continue?';
const $ = (cents) => `$${(cents / 100).toFixed(2)}`;
/** How far off, as the till writes it: to one decimal place */
const pct = (off, price) => `${Math.round((off / price) * 1000) / 10}%`;

// 1. one thing past 20%: the question, No, Yes, the PIN screen, and paid in cash on the practice till
{
  const { T, ctx } = await fresh();
  await T.sale();
  const first = await T.s();
  const price = first.prices[0];
  const name = first.titles[0];
  const off = Math.floor(price / 2);
  await T.click('[data-act="discount"] >> nth=0');
  await T.type((off / 100).toFixed(2));
  const asked = await T.s();
  ok('half its price typed: the till asks first, with what it would come to', asked.view === 'discountover' && asked.title === 'More than 20% off' && asked.lede === ASK
    && JSON.stringify(asked.past) === JSON.stringify([`${name}: ${$(off)} off, so ${$(price - off)} (${pct(off, price)} off)`]) && asked.offs[0] === 0 && !asked.toast, JSON.stringify(asked));
  await T.click('[data-act="over-no"]');
  const no = await T.s();
  ok('No, go back: the Discount screen, and nothing on the line', no.view === 'discount' && no.offs[0] === 0, JSON.stringify(no));
  await T.type((off / 100).toFixed(2));
  await T.page.waitForTimeout(450);
  await T.click('[data-act="over-yes"]');
  const yes = await T.s();
  ok('Yes, continue: the line has it and says it is over 20%, and the sale says Staff discount and the total', yes.view === 'till' && yes.offs[0] === off && /Staff discount: .* off · over 20%$/.test(yes.subs[0])
    && yes.totals.includes(`Staff discount −${$(off)}`) && yes.totals.includes(`Total ${$(price - off)}`) && yes.toast === `${$(off)} off. Someone with Money approves it at Pay.`, JSON.stringify(yes));
  await T.noToast();
  // more than it costs
  await T.click('[data-act="discount"] >> nth=0');
  await T.type(((price + 1) / 100).toFixed(2));
  const tooMuch = await T.s();
  ok('a cent more than it costs: the till says so and stays', tooMuch.view === 'discount' && tooMuch.toast === `${name} is ${$(price)}, so it can't come down by more than that.` && tooMuch.offs[0] === off, JSON.stringify(tooMuch));
  await T.noToast();
  await T.click('[data-act="back"]');
  await T.click('[data-act="pay-cash"]');
  const gate = await T.s();
  ok('Pay: the PIN screen says what the PIN is a yes to', gate.view === 'discountok' && gate.warn === `This exceeds the 20% discount threshold: ${name} is ${pct(off, price)} off. A PIN says yes to that.`, JSON.stringify(gate));
  await T.click('[data-act="pick"] >> nth=0');
  await T.pin('2580');
  const after = await T.s();
  ok('a Money PIN, then cash as chosen', after.view === 'cash' && after.pay === 'cash', JSON.stringify({ view: after.view, pay: after.pay }));
  ok('no errors on the page', T.errors.length === 0, T.errors.join(' | '));
  await ctx.close();
}

// 2. Discount on everything past what keeps the things within 20%
{
  const { T, ctx } = await fresh();
  await T.sale();
  await T.scan('31283123823');
  await T.scan('31283123821');
  await T.noToast();
  const start = await T.s();
  const before = start.prices.reduce((n, c) => n + c, 0);
  const room = start.prices.reduce((n, c) => n + Math.floor(c * 0.2), 0);
  const amount = Math.floor(before * 0.4);
  await T.click('[data-act="discount"][data-key="*"]');
  await T.type((amount / 100).toFixed(2));
  const asked = await T.s();
  ok('40% of the sale typed: the till asks, with a line for each thing it takes past 20%', asked.view === 'discountover' && asked.lede === ASK && asked.past.length === 3 && asked.past.every((t) => / off, so \$[\d.]+ \(\d+(\.\d)?% off\)$/.test(t)) && asked.offs.every((c) => c === 0), JSON.stringify(asked));
  await T.page.waitForTimeout(450);
  await T.click('[data-act="over-yes"]');
  const set = await T.s();
  const sum = set.offs.reduce((n, c) => n + c, 0);
  ok('Yes: the whole amount is shared, by price, none more than its thing costs', set.view === 'till' && sum === amount && set.offs.every((c, i) => c > Math.floor(set.prices[i] * 0.2) && c <= set.prices[i])
    && set.totals.includes(`Staff discount −${$(amount)}`) && set.button === `${$(amount)} off everything`, JSON.stringify(set));
  ok('by price: each thing is the same share off, to within a cent or two', set.offs.every((c, i) => Math.abs(c - (amount * set.prices[i]) / before) <= 2), JSON.stringify({ offs: set.offs, prices: set.prices }));
  await T.noToast();
  // more than the things cost
  await T.click('[data-act="discount"][data-key="*"]');
  await T.type(((before + 1) / 100).toFixed(2));
  const tooMuch = await T.s();
  ok('a cent more than the things cost: the till says so and stays', tooMuch.view === 'discount' && tooMuch.toast === `These come to ${$(before)}, so the sale can't come down by more than that.` && tooMuch.all === amount, JSON.stringify(tooMuch));
  await T.noToast();
  await T.click('[data-act="back"]');
  // one more of the first thing: the sale is bigger, the amount stands
  await T.click('[data-act="more"] >> nth=0');
  const more = await T.s();
  ok('one more of something: the same dollars off the sale', more.totals.includes(`Staff discount −${$(amount)}`), JSON.stringify(more.totals));
  await T.click('[data-act="less"] >> nth=0');
  // two of the three things taken out: what's left keeps the share that was said yes to, never the whole amount
  await T.click('[data-act="less"] >> nth=2');
  await T.click('[data-act="less"] >> nth=1');
  await T.noToast();
  const left = await T.s();
  const share = Math.floor((amount * left.prices[0]) / before);
  ok('two things taken out: the one left has the same share off as before, not the whole amount', left.prices.length === 1 && left.offs[0] === share && left.offs[0] < left.prices[0] && left.all === amount, JSON.stringify(left));
  ok('and the button says how much of the amount that is', left.button === `${$(share)} of ${$(amount)} off everything`, JSON.stringify(left.button));
  // within 20% again: no question
  await T.scan('31283123823');
  await T.noToast();
  await T.click('[data-act="discount"][data-key="*"]');
  await T.type('1');
  const within = await T.s();
  ok('$1 off the sale: no question, and nothing over 20%', within.view === 'till' && within.all === 100 && !within.subs.some((t) => /over 20%/.test(t)), JSON.stringify(within));
  await T.noToast();
  await T.click('[data-act="pay-cash"]');
  const gate = await T.s();
  ok('its PIN screen says nothing of the threshold', gate.view === 'discountok' && !gate.warn, JSON.stringify(gate));
  ok('no errors on the page', T.errors.length === 0, T.errors.join(' | '));
  await ctx.close();
}

await browser.close();
server.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

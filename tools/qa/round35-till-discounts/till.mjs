// Round 35 (contract v35-till-discounts): the till's own script in a browser (the theme mock, Sales: Live) against the
// Lair app itself: the Durable Object class run here on node's SQLite, as the tests run it, with only Shopify stood in
// for (its sums done the way the real one did them when asked, 11 Nov 2026). So the till and the Lair app are checked
// against each other, not against a stand-in's idea of the contract. Mo (10 Nov 2026): "for the discount make it go
// off actual dollar value not % thanks no need to say no more than 25% but do not accept anything lower than 25% unless
// it is done on the item previously thanks. Actually make it 20%".
//  1. Mo unlocks; a quick sale of 7 Wonders ($105) and two boosters ($11 each): a Discount on each line, none for
//     everything.
//  2. Discount on 7 Wonders: dollars, no percent and no limit said anywhere; the amounts offered are ones it can take.
//  3. $25 typed: the till says the most it can ($21.00) and stays; $21: the Lair app prices it with off: 2100.
//  4. The boosters: off each one; $2.21 typed is too much ($2.20 each at most); $2 off each.
//  5. Card: approve first (people with Money), Rua's PIN, the EFTPOS amount, and the draft Shopify was asked for.
//  6. Confirm paid: the sale's discount and who approved it are kept.
//  7. Something on sale past 80% of what it was can't have a discount; one with a little off comes down only so far.
//  8. On top of the dice deal (a third die added to a discounted line): the Lair app's words, Pay says them again
//     without sending anything, and Discount on a line a deal has taken something off offers no amounts.
//  9. Pay tapped before the Lair app has priced the discount: one tap is enough.
// 10. Shopify's price dropping between the price and Pay: the Lair app's words, and nothing's sold.
// 11. A Lair app from before dollars: the till says so and Pay doesn't go ahead. The price never answering after Pay:
//     the sale isn't left with its buttons off.
// 12. No discount, typed oddities, and the customer screen.
// 6b, 6c. Discount on everything (Mo, 11 Nov 2026: "make $ off discount back"): dollars off the whole sale, shared
//     across its things by price as whole cents off each one, exact where the quantities allow.
// 6d. What stays out of it, and why: a deck's free sleeves (the shop's other deal), dice, things on sale already.
// 6e. Tapped before Shopify's price is in: the Lair app's refusal names the line, and the next go leaves it out.
// And what the real till says about itself: no Demo codes on its start screen, no "Practice till" as staff sign in.
// Usage: DG_THEME=/path/to/theme [LOOK=pieces|first] [PORT=4997] [OUT=dir] node tools/qa/round35-till-discounts/till.mjs
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from '../../../test/cloudflare-sql.js';
import { Lair } from '../../../src/lair.js';
import { rulesFromSettings, DEFAULT_HOURS } from '../../../src/core.js';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round35-till-discounts');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, overflowX, shot, watch, go, clockAt, STAFF } = lib;
const PORT = Number(process.env.PORT || 4997);
const BASE = `http://localhost:${PORT}`;
const API = (m.globalSettings.lair_api || '/apps/liar').replace(/\/$/, '');
const LOOK = process.env.LOOK || '';

/* ---------- the Lair app, as the tests run it ---------- */
const background = [];
function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      cloudflareSql(query, bindings);
      const stmt = db.prepare(query);
      if (/^\s*(select|with)/i.test(query)) {
        const rows = stmt.all(...bindings);
        return { toArray: () => rows, one: () => rows[0] };
      }
      stmt.run(...bindings);
      return { toArray: () => [], one: () => undefined };
    },
  };
  const kv = new Map();
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: (p) => background.push(p) };
}
const drain = () => {
  while (background.length) Promise.resolve(background.shift()).catch(() => {});
};
const OWNER = '9001';
const HEMI = '9102';
const RUA = '9104';

/* ---------- the shop, as the stand-in Shopify has it ---------- */
const PRODUCTS = {
  oakie: { id: '101', title: 'Oakie Doakie Translucent RPG Dice Set', type: 'Dice & Accessories', vendor: 'Oakie Doakie Dice', status: 'ACTIVE', giftCard: false, dice: true },
  booster: { id: '103', title: 'Riftbound Radiance', type: 'Trading Card Games', vendor: 'Riot Games', status: 'ACTIVE', giftCard: false, dice: false },
  coke: { id: '113', title: 'Coca-Cola – Half Price (Flat)', type: 'Drinks', vendor: 'Dice Goblin NZ', status: 'ACTIVE', giftCard: false, dice: false },
  barrage: { id: '114', title: 'Barrage', type: 'Board Games', vendor: 'Cranio Creations', status: 'ACTIVE', giftCard: false, dice: false },
  wonders: { id: '115', title: '7 Wonders', type: 'Board Games', vendor: 'Repos Production', status: 'ACTIVE', giftCard: false, dice: false },
  // (11 Nov 2026) a second set of dice, and the shop's other deal: a Commander deck comes with its sleeves free
  glow: { id: '112', title: 'Glow Dice Set', type: 'Dice & Accessories', vendor: 'Dice Goblin NZ', status: 'ACTIVE', giftCard: false, dice: true },
  deck: { id: '117', title: 'Final Fantasy Commander Deck', type: 'Trading Card Games', vendor: 'Wizards of the Coast', status: 'ACTIVE', giftCard: false, dice: false },
  sleeves: { id: '118', title: 'Final Fantasy Commander Sleeves (100)', type: 'Trading Card Games', vendor: 'Ultra Pro', status: 'ACTIVE', giftCard: false, dice: false },
};
const VARIANTS = {
  5011: { product: 'oakie', id: '5011', title: 'Green', sku: null, barcodes: ['4056133701068'], price: 1599, tracked: true, stock: 35, oversell: false },
  5013: { product: 'booster', id: '5013', title: 'Booster Pack', sku: null, barcodes: ['810155276195'], price: 1100, tracked: true, stock: 12, oversell: false },
  5024: { product: 'coke', id: '5024', title: 'Classic', sku: null, barcodes: ['9400000000017'], price: 300, was: 600, tracked: false, stock: null, oversell: false },
  5025: { product: 'barrage', id: '5025', title: 'Default Title', sku: null, barcodes: ['9400000000024'], price: 9000, was: 10000, tracked: true, stock: 2, oversell: false },
  5026: { product: 'wonders', id: '5026', title: 'Default Title', sku: null, barcodes: ['9400000000031'], price: 10500, tracked: true, stock: 4, oversell: false },
  5022: { product: 'glow', id: '5022', title: 'Green', sku: null, barcodes: ['9400000000048'], price: 2000, tracked: true, stock: 3, oversell: false },
  5028: { product: 'deck', id: '5028', title: 'Default Title', sku: null, barcodes: ['9400000000055'], price: 8999, tracked: true, stock: 3, oversell: false },
  5029: { product: 'sleeves', id: '5029', title: 'Default Title', sku: null, barcodes: ['9400000000062'], price: 1999, tracked: true, stock: 6, oversell: false },
};
const CODE = { oakie: '4056133701068', booster: '810155276195', coke: '9400000000017', barrage: '9400000000024', wonders: '9400000000031', glow: '9400000000048', deck: '9400000000055', sleeves: '9400000000062' };
const match = (id) => ({ product: { ...PRODUCTS[VARIANTS[id].product] }, variant: { ...VARIANTS[id] } });
/**
 * Shopify's figures as the stand-in works them out, the way the real one did when asked (draftOrderCalculate, 11 Nov
 * 2026): a line's staff discount, dollars off each one of it (never more than the price) or a percent of the line
 * rounded down; then every third dice free, at what it costs after its line's discount, on the line it came from; a
 * variant's compare-at price (was); and GST. And the shop's other deal (10 Nov 2026, "Final Fantasy Commander deck +
 * free sleeves": buy a deck, get one of its sleeves free): the sleeves' price comes off the sleeves' own line.
 */
function figuresFor(lines) {
  const out = lines.map((l) => {
    if (l.variantId) {
      const v = VARIANTS[l.variantId];
      const unit = l.cents ?? v.price;
      const total = unit * l.qty;
      const staff = l.off ? Math.min(l.off, unit) * l.qty : l.discount ? Math.floor((total * l.discount) / 100) : null;
      return {
        uuid: l.uuid, title: PRODUCTS[v.product].title, variantTitle: v.title === 'Default Title' ? '' : v.title, variantId: l.variantId, qty: l.qty, unit, total,
        paid: total - (staff || 0), custom: false, attributes: l.attributes || {}, ...(staff != null ? { staff } : {}), ...(v.was > unit ? { was: v.was } : {}),
        dice: PRODUCTS[v.product].dice && l.cents == null, each: Math.round((total - (staff || 0)) / l.qty),
      };
    }
    return { uuid: l.uuid, title: l.title, variantTitle: '', variantId: null, qty: 1, unit: l.cents, total: l.cents, paid: l.cents, custom: true, attributes: l.attributes || {}, dice: false, each: l.cents };
  });
  const units = [];
  out.forEach((l, i) => {
    if (l.dice) for (let n = 0; n < l.qty; n += 1) units.push({ unit: l.each, line: i });
  });
  units.sort((x, y) => y.unit - x.unit);
  let deal = 0;
  for (let i = 2; i < units.length; i += 3) {
    deal += units[i].unit;
    out[units[i].line].paid -= units[i].unit;
  }
  // a deck's sleeves, free: one for each deck, the cheapest first, at what they cost after their own line's discount
  // (the real store, asked on 11 Nov 2026 with a deck and two lines of sleeves, one with $1.35 off: the deal took
  // $23.65 off that line and left the other alone)
  const decks = out.reduce((n, l) => n + (l.variantId === '5028' ? l.qty : 0), 0);
  const packs = [];
  out.forEach((l, i) => {
    if (l.variantId === '5029') for (let n = 0; n < l.qty; n += 1) packs.push({ unit: l.each, line: i });
  });
  packs.sort((x, y) => x.unit - y.unit);
  let sleeves = 0;
  packs.slice(0, decks).forEach((u) => {
    sleeves += u.unit;
    out[u.line].paid -= u.unit;
  });
  const subtotal = out.reduce((sum, l) => sum + l.total, 0);
  const staffTotal = out.reduce((sum, l) => sum + (l.staff || 0), 0);
  const total = subtotal - deal - sleeves - staffTotal;
  return {
    subtotal, total, gst: Math.round((total * 3) / 23), taxIncluded: true,
    discounts: [...(deal ? [{ title: 'Buy any 2 dice, get the 3rd free', amount: deal }] : []), ...(sleeves ? [{ title: 'Final Fantasy Commander deck + free sleeves', amount: sleeves }] : [])],
    lines: out.map(({ dice, each, ...l }) => l),
  };
}

const lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'dice-goblin.myshopify.com' });
const shop = { drafts: [], deleted: [], completed: [], calculated: [] };
lair.taggedPerson = async (id) => {
  const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
  if (id) lair.people.set(id, { at: Date.now(), person });
  return person;
};
Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
Object.assign(lair.shopify, {
  // (anything the stand-in doesn't answer never leaves this machine)
  graphql: async () => {
    throw new Error('No Shopify in this check');
  },
  searchCustomers: async () => [{ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }],
  storeCreditBalance: async () => 0,
  orderSpend: async () => null,
  orderBuyer: async () => null,
  customerEmail: async () => null,
  tillVariants: async (code) => Object.keys(VARIANTS).filter((id) => VARIANTS[id].barcodes.some((b) => b.replace(/^0+/, '') === code.replace(/^0+/, ''))).map(match),
  tillSearch: async () => [],
  tillCalculate: async ({ lines }) => {
    shop.calculated.push(lines);
    return figuresFor(lines);
  },
  createTillDraft: async (input) => {
    const draft = { id: `gid://shopify/DraftOrder/${900 + shop.drafts.length}`, input, figures: figuresFor(input.lines), order: null };
    shop.drafts.push(draft);
    return { id: draft.id, ready: true, ...draft.figures };
  },
  tillDraft: async (id) => {
    const d = shop.drafts.find((x) => x.id === id && !shop.deleted.includes(id));
    return d ? { id, status: d.order ? 'COMPLETED' : 'OPEN', ready: true, order: d.order, ...d.figures } : null;
  },
  completePaidDraft: async (id) => {
    const d = shop.drafts.find((x) => x.id === id && !shop.deleted.includes(id));
    if (!d) return { order: null, status: null, errors: ['Draft order not found'] };
    if (d.order) return { order: null, status: 'COMPLETED', errors: ['This draft order has already been completed'] };
    d.order = { id: `gid://shopify/Order/${8000 + shop.completed.length}`, name: `#${3000 + shop.completed.length}`, total: d.figures.total };
    shop.completed.push(id);
    return { order: d.order, status: 'COMPLETED', errors: [] };
  },
  draftOrderState: async (id) => {
    const d = shop.drafts.find((x) => x.id === id && !shop.deleted.includes(id));
    return d ? { id, status: d.order ? 'COMPLETED' : 'OPEN', ready: true, order: d.order } : null;
  },
  deleteDraftIfOpen: async (id) => {
    const d = shop.drafts.find((x) => x.id === id);
    if (!d || d.order) return false;
    shop.deleted.push(id);
    return true;
  },
  fulfilTillOrder: async () => ({ fulfilled: 1, moved: 0 }),
});
lair.notifyStaff = () => {};
lair.mail = async () => ({ ok: true });
lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }], []);
lair.rulesLoadedAt = Date.now() + 10 * 365 * 24 * 3600_000;
const call = async (method, name, body, search = '') => {
  const response = await lair.fetch(new Request(`https://lair.test/${name}${search}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': OWNER, 'X-Lair-Client': '203.0.113.7' }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: response.status, text: await response.text() };
};
const must = async (method, name, body) => {
  const res = await call(method, name, body);
  if (res.status !== 200) throw new Error(`${name}: ${res.status} ${res.text}`);
  return JSON.parse(res.text);
};
lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, Date.now());
for (const [id, name, perms] of [[HEMI, 'Hemi Walker', ['checkin']], [RUA, 'Rua Parata', ['checkin', 'money']]]) {
  await must('POST', 'team', { customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, perms });
}
// everyone has chosen their own PIN already (the first unlock is with 1234)
for (const [id, pin] of [[OWNER, '2580'], [HEMI, '1357'], [RUA, '4711']]) {
  const u = await must('POST', 'till/unlock', { id, pin: '1234' });
  await must('POST', 'till/pin', { token: u.token, pin });
}

/* ---------- the till, in a browser ---------- */
// slowPrice: ms each price takes; hangPrice: a price doesn't come back while it's on; old: the Lair app is one from
// before round 35 (it never sees `off`)
const state = { calls: [], slowPrice: 0, hangPrice: false, old: false };
const server = await m.serve(PORT);
const browser = await chromium.launch();
m.globalSettings.lair_mode = 'demo';
if (LOOK) m.mockState.sectionSettings = { 'lair-till': { sales: 'live', look: LOOK, quick_keys: [] } };
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, hasTouch: true });
await ctx.addInitScript(clockAt('19:30'));
await ctx.route(`${BASE}${API}/**`, async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const name = url.pathname.slice(API.length + 1);
  let body = req.method() === 'POST' ? JSON.parse(req.postData() || '{}') : undefined;
  state.calls.push({ name, body });
  if (name === 'till/price' && state.slowPrice) await new Promise((r) => setTimeout(r, state.slowPrice));
  if (name === 'till/price' && state.hangPrice) {
    const until = Date.now() + 30000;
    while (state.hangPrice && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  }
  if (state.old && body?.lines) body = { ...body, lines: body.lines.map(({ off, ...l }) => l) };
  const res = await call(req.method(), name, body, url.search);
  drain();
  await route.fulfill({ status: res.status, contentType: 'application/json', body: res.text });
});
const page = watch(await ctx.newPage());
const calls = (name) => state.calls.filter((c) => c.name === name);
const settle = (ms = 400) => page.waitForTimeout(ms);
const scan = async (code, wait = 900) => {
  await page.evaluate((c) => document.querySelector('lair-till').onScan(c), code);
  await settle(wait);
};
const tap = async (sel, wait = 500) => {
  const over = page.locator(`[data-r="over"] ${sel} >> visible=true`);
  await ((await over.count()) ? over : page.locator(`${sel} >> visible=true`)).first().click({ timeout: 5000 });
  await settle(wait);
};
const pin = async (digits, wait = 900) => {
  for (const d of digits) await tap(`[data-act="digit"][data-d="${d}"]`, 90);
  await settle(wait);
};
const type = async (text, wait = 900) => {
  await page.locator('#t-off').fill(text);
  await tap('[data-form="discount"] button[type="submit"]', wait);
};
const noToast = () => page.evaluate(() => {
  const el = document.querySelector('lair-till');
  clearTimeout(el.toastTimer);
  el.s.toast = null;
  el.paintToast();
});
const look = () => page.evaluate(() => {
  const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const q = (s) => document.querySelector(s);
  const el = q('lair-till');
  const sale = q('[data-r="sale"]');
  const over = q('[data-r="over"]');
  return {
    view: el.s.view, mode: el.s.mode, busy: Boolean(el.s.busy),
    lines: [...(sale?.querySelectorAll('.t-line') || [])].map((li) => ({ title: f(li.querySelector('.t-line__title')?.textContent), sub: f(li.querySelector('.t-line__sub')?.textContent), amount: f(li.querySelector('.t-line__amount')?.textContent) })),
    totals: [...(sale?.querySelectorAll('.t-totals p') || [])].map((p) => [...p.children].map((c) => f(c.textContent)).join(' ')),
    pay: [...(sale?.querySelectorAll('.t-pay button') || [])].map((b) => f(b.textContent) + (b.disabled ? ' (off)' : '')),
    offs: [...document.querySelectorAll('.t-off')].filter((b) => b.offsetParent).map((b) => f(b.textContent)),
    title: f(over?.querySelector('.t-h1')?.textContent), lede: f(over?.querySelector('.t-lede')?.textContent),
    quick: [...(over?.querySelectorAll('[data-act="discount-set"]:not([data-c="0"])') || [])].map((b) => `${f(b.querySelector('span')?.textContent)} ${f(b.querySelector('small')?.textContent)}${b.getAttribute('aria-pressed') === 'true' ? ' (on)' : ''}`),
    field: over?.querySelector('#t-off') ? { label: f(over.querySelector('label[for="t-off"]')?.textContent), sign: f(over.querySelector('.t-discount__type span')?.textContent), value: over.querySelector('#t-off').value } : null,
    none: Boolean(over?.querySelector('[data-act="discount-set"][data-c="0"]')),
    notes: [...(over?.querySelectorAll('.t-temp') || [])].map((p) => f(p.textContent)),
    overText: f(over?.textContent),
    approvers: [...(over?.querySelectorAll('.t-staff [data-act="pick"]') || [])].map((b) => f(b.textContent)),
    amount: f(over?.querySelector('.t-paying__amount')?.textContent), steps: [...(over?.querySelectorAll('.t-steps li') || [])].map((li) => f(li.textContent)),
    toast: f(q('[data-r="toast"]')?.textContent),
  };
});
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    check(`${name}: the step ran`, false, String(e.message).split('\n')[0]);
  }
};
/** The line of the latest price or Pay the till sent that has dollars off */
const offsSent = (name) => (calls(name).at(-1)?.body?.lines || []).filter((l) => l.off != null).map((l) => [String(l.variantId), l.off]);
const saleRow = () => lair.sql.exec('SELECT * FROM till_sales ORDER BY created_at DESC, rowid DESC LIMIT 1').one();

await go(page, BASE, '/pages/till', STAFF);
await page.waitForSelector('[data-act="staff-door"]', { timeout: 20000 });
await settle(500);
check('Sales: Live with the Lair app answering: no Practice pill', (await page.locator('.t-pill', { hasText: 'Practice' }).count()) === 0, 'Practice shows');
let v;
const words = (sel) => page.evaluate((q) => [...document.querySelectorAll(q)].filter((b) => b.offsetParent).map((b) => b.textContent.replace(/\s+/g, ' ').trim()), sel);

/* ---------- 1. Mo unlocks; a quick sale ---------- */
await step('1', async () => {
  // (11 Nov 2026) the real till isn't the demo: its start screen offers no Demo codes, and signing in doesn't call it a
  // practice till (both showed on the counter's till, where every sale is a paid order)
  const doors = await words('[data-r="over"] button');
  check("the real till's start screen has its Staff door, and no Demo codes", doors.includes('Staff') && !doors.includes('Demo codes'), doors);
  await tap('[data-act="staff-door"]');
  const notes = await words('[data-r="over"] .t-note');
  check("signing in doesn't call the real till a practice till", !notes.some((t) => /Practice till/.test(t)), notes);
  await tap(`[data-act="pick"][data-id="${OWNER}"]`);
  await pin('2580');
  await tap('[data-act="quick"]');
  await scan(CODE.wonders);
  await scan(CODE.booster);
  await scan(CODE.booster);
  await noToast();
  v = await look();
  check('7 Wonders and two boosters: a Discount on each line, and one for everything; Card · $127.00',
    JSON.stringify(v.offs) === JSON.stringify(['Discount', 'Discount', 'Discount on everything']) && v.pay[0] === 'Card · $127.00', v);
});

/* ---------- 2. The Discount screen is in dollars, and doesn't say the limit ---------- */
await step('2', async () => {
  await tap('[data-act="discount"] >> nth=0');
  v = await look();
  check('Discount on 7 Wonders: its price before the discount', v.view === 'discount' && v.title === '7 Wonders' && v.lede === '$105.00 before the discount.', v);
  check('no percent anywhere on it, and nothing saying how far it can come down', !/%|at most|up to|most/i.test(v.overText), v.overText);
  check('the amounts offered are ones it can take, each with what it would cost: $1, $2, $5, $10 and $20 off',
    JSON.stringify(v.quick) === JSON.stringify(['$1 off $104.00', '$2 off $103.00', '$5 off $100.00', '$10 off $95.00', '$20 off $85.00']), v.quick);
  check('or dollars typed after their sign', v.field && v.field.sign === '$' && v.field.label === 'Or type the dollars off' && v.field.value === '' && !v.none, v.field);
  await shot(page, 'till-1-discount');
  check('the Discount screen: no sideways scroll', (await overflowX(page)) <= 0);
});

/* ---------- 3. More than it can come down by; then what it can ---------- */
await step('3', async () => {
  const prices = calls('till/price').length;
  await type('25');
  v = await look();
  check('$25 typed: the till says the most 7 Wonders can come down by, and stays on Discount', v.view === 'discount' && v.toast === '7 Wonders can come down by $21.00 at most.' && calls('till/price').length === prices, v);
  await noToast();
  await type('21', 1200);
  v = await look();
  check('$21: back at the sale, the line says so, and the Lair app is asked for the price with 2100 off that line only',
    v.view === 'till' && v.offs[0] === '$21.00 off' && v.lines[0].sub === 'Staff discount: $21.00 off' && JSON.stringify(offsSent('till/price')) === JSON.stringify([['5026', 2100]]), { v, sent: offsSent('till/price') });
  check('the sale says Staff discount −$21.00, Total $106.00, Card · $106.00', v.totals.includes('Staff discount −$21.00') && v.totals.includes('Total $106.00') && v.pay[0] === 'Card · $106.00', v);
  check('the till said who approves it', /\$21\.00 off\. Someone with Money approves it at Pay\./.test(v.toast), v.toast);
  await noToast();
});

/* ---------- 4. Two of something: off each one ---------- */
await step('4', async () => {
  await tap('[data-act="discount"] >> nth=1');
  v = await look();
  check('Discount on the two boosters says it comes off each one', v.title === 'Riftbound Radiance' && v.lede === '$11.00 each, and 2 in the sale. A discount comes off each one.' && v.field.label === 'Or type the dollars off each one', v);
  check('the amounts offered: $0.50, $1 and $2 off, with what each one would cost', JSON.stringify(v.quick) === JSON.stringify(['$0.50 off $10.50 each', '$1 off $10.00 each', '$2 off $9.00 each']), v.quick);
  await shot(page, 'till-2-discount-each');
  await type('2.21');
  v = await look();
  check('$2.21 typed: $2.20 each at most', v.view === 'discount' && v.toast === 'Riftbound Radiance can come down by $2.20 each at most.', v);
  await noToast();
  await tap('[data-act="discount-set"][data-c="200"]', 1200);
  v = await look();
  check('$2 off: the line says $2.00 off each, and the Lair app is asked with 200 off each on that line too',
    v.offs[1] === '$2.00 off each' && v.lines[1].sub === 'Booster Pack · Staff discount: $2.00 off each' && JSON.stringify(offsSent('till/price')) === JSON.stringify([['5026', 2100], ['5013', 200]]), { v, sent: offsSent('till/price') });
  check('Staff discount −$25.00 ($21 and 2 x $2), Total $102.00', v.totals.includes('Staff discount −$25.00') && v.totals.includes('Total $102.00') && v.pay[0] === 'Card · $102.00', v);
  await noToast();
  await shot(page, 'till-3-discounted');
  // going back in shows what's on it
  await tap('[data-act="discount"] >> nth=1');
  v = await look();
  check('Discount again: $2 off is the one that is on, and No discount is offered', v.quick.includes('$2 off $9.00 each (on)') && v.none, v);
  await tap('[data-act="back"]');
});

/* ---------- 5. Card: approve first ---------- */
await step('5', async () => {
  const before = calls('till/pay').length;
  await tap('[data-act="pay-card"]');
  v = await look();
  check('Card asks to Approve the discount first, and nothing has gone to Pay', v.view === 'discountok' && v.title === 'Approve the discount' && calls('till/pay').length === before, { view: v.view, title: v.title });
  check('it says what comes off and what the sale is: $25.00 off, so the sale is $102.00', /\$25\.00 off, so the sale is \$102\.00\./.test(v.lede), v.lede);
  check('only people with Money are offered: Mo and Rua, not Hemi', v.approvers.length === 2 && v.approvers.some((t) => /Mo/.test(t)) && v.approvers.some((t) => /Rua/.test(t)), v.approvers);
  await tap(`[data-act="pick"][data-id="${RUA}"]`);
  await pin('4711', 1200);
  v = await look();
  const sent = calls('till/pay').at(-1)?.body || {};
  check("Rua's PIN: Pay gets her approval, card, and the lines' dollars off", calls('till/pay').length === before + 1 && sent.method === 'card' && Boolean(sent.discountOk) && sent.discountOk !== sent.token && JSON.stringify(offsSent('till/pay')) === JSON.stringify([['5026', 2100], ['5013', 200]]), sent);
  check('the EFTPOS screen says $102.00', v.view === 'card' && v.amount === '$102.00' && v.steps[0] === 'Key $102.00 into the EFTPOS', v);
  const draft = shop.drafts.at(-1)?.input;
  check('Shopify was asked for a draft with those dollars off each line, saying who approved it, tagged staff-discount',
    draft && draft.lines[0].off === 2100 && draft.lines[1].off === 200 && draft.lines.every((l) => l.discountNote === 'Approved by Rua on the till' && l.discount === undefined) && draft.tags.includes('staff-discount'), draft);
  await shot(page, 'till-4-card');
});

/* ---------- 6. Confirm paid ---------- */
await step('6', async () => {
  await tap('[data-act="card-ok"]');
  await settle(900);
  v = await look();
  const confirmed = calls('till/paid').at(-1)?.body || {};
  const row = saleRow();
  check('Confirm paid: expect is $102.00, and the sale is done', confirmed.expect === 10200 && v.view === 'done', { confirmed, view: v.view, toast: v.toast });
  check('the Lair app kept what came off and who approved it', row.status === 'paid' && row.total === 10200 && row.discount_total === 2500 && row.discount_by === RUA && row.discount_by_name === 'Rua', { status: row.status, total: row.total, off: row.discount_total, by: row.discount_by_name });
});

/* ---------- 6b. Discount on everything: dollars off the whole sale ---------- */
await step('6b', async () => {
  // (Mo, 11 Nov 2026: "make $ off discount back") an amount off the sale, shared across its things as cents off each one
  await tap('[data-act="next"]');
  await tap('[data-act="quick"]');
  await scan(CODE.wonders);
  await scan(CODE.booster);
  await scan(CODE.booster);
  await scan(CODE.coke);
  await noToast();
  await tap('[data-act="discount"][data-key="*"]');
  v = await look();
  check('Discount on everything: what the sale\'s things cost before it, leaving out what is on sale already', v.view === 'discount' && v.title === 'Everything in the sale' && v.lede === '$127.00 before the discount.' && /Things on sale already stay as they are\./.test(v.overText), v);
  check('no percent on it, and nothing saying how far it can come down', !/%|at most|up to/i.test(v.overText), v.overText);
  check('amounts it can take, each with what those things would then cost, and a field for dollars off the sale',
    JSON.stringify(v.quick) === JSON.stringify(['$1 off $126.00', '$2 off $125.00', '$5 off $122.00', '$10 off $117.00', '$20 off $107.00']) && v.field && v.field.label === 'Or type the dollars off the sale', { quick: v.quick, field: v.field });
  await shot(page, 'till-8-everything');
  const prices = calls('till/price').length;
  await type('30');
  v = await look();
  check('$30 typed: the most the sale can come down by ($21.00 and 2 x $2.20), and it stays', v.view === 'discount' && v.toast === 'Everything in the sale can come down by $25.40 at most.' && calls('till/price').length === prices, v);
  await noToast();
  await type('10', 1300);
  v = await look();
  check('$10: shared by price as whole cents off each one, $8.28 off 7 Wonders and 86c off each booster, which is $10.00 exactly',
    v.view === 'till' && JSON.stringify(offsSent('till/price')) === JSON.stringify([['5026', 828], ['5013', 86]]) && v.lines[0].sub === 'Staff discount: $8.28 off' && v.lines[1].sub === 'Booster Pack · Staff discount: $0.86 off each' && v.lines[2].sub === 'Classic', { v, sent: offsSent('till/price') });
  check('the sale says Staff discount −$10.00 and Total $120.00, and the till says how it was shared', v.totals.includes('Staff discount −$10.00') && v.totals.includes('Total $120.00') && v.toast === '$10.00 off the sale, shared across 2 things. Someone with Money approves it at Pay.', v);
  await noToast();
  await shot(page, 'till-9-everything-on');
  // Card asks for the PIN as for any discount
  await tap('[data-act="pay-card"]', 700);
  v = await look();
  check('Card asks to approve it: $10.00 off, so the sale is $120.00', v.view === 'discountok' && /\$10\.00 off, so the sale is \$120\.00\./.test(v.lede), { view: v.view, lede: v.lede });
  await tap('[data-act="back"]');
  // and off again, all at once
  await tap('[data-act="discount"][data-key="*"]');
  v = await look();
  check('Discount on everything again shows the $10 that is on, and offers No discount', v.none && v.quick.includes('$10 off $117.00 (on)') && v.quick.filter((t) => / \(on\)$/.test(t)).length === 1, { none: v.none, quick: v.quick });
  await tap('[data-act="discount-set"][data-c="0"]', 1200);
  v = await look();
  check('No discount takes it off every line: Total $130.00 again', v.view === 'till' && v.toast === 'Discounts taken off.' && v.totals.includes('Total $130.00') && !v.totals.some((t) => /Staff discount/.test(t)) && v.offs.slice(0, 3).every((t) => t === 'Discount'), v);
  await noToast();
});

/* ---------- 6c. An amount that can't be shared to the cent ---------- */
await step('6c', async () => {
  await page.evaluate(() => document.querySelector('lair-till').nextSale());
  await settle(300);
  await tap('[data-act="quick"]').catch(() => {});
  await scan(CODE.booster);
  await scan(CODE.booster);
  await scan(CODE.booster);
  await scan(CODE.coke);
  await noToast();
  await tap('[data-act="discount"][data-key="*"]');
  v = await look();
  check('three of one thing (and a drink on sale): no ready amounts split to the cent, so dollars are typed', v.lede === '$33.00 before the discount.' && v.quick.length === 0 && v.field.label === 'Type the dollars off the sale', { lede: v.lede, quick: v.quick, field: v.field });
  await type('1', 1300);
  v = await look();
  check("$1 across three boosters is 33c each: 99c comes off, never more than was asked, and the till says why", v.view === 'till' && JSON.stringify(offsSent('till/price')) === JSON.stringify([['5013', 33]]) && v.totals.includes('Staff discount −$0.99')
    && v.toast === "$0.99 off the sale: $1.00 didn't share out to the cent across these. Someone with Money approves it at Pay.", { v, sent: offsSent('till/price') });
  await noToast();
  await tap('[data-act="discount"][data-key="*"]');
  v = await look();
  check('opened again, the field has what is off the sale now: 0.99', v.field && v.field.value === '0.99', v.field);
  const prices = calls('till/price').length;
  await type('0.01');
  v = await look();
  check('a cent across three of something is too little to share, and nothing is asked', v.view === 'discount' && v.toast === '$0.01 is too little to share across these. Try a little more.' && calls('till/price').length === prices, v);
  await noToast();
  await tap('[data-act="back"]');
  await page.evaluate(() => document.querySelector('lair-till').nextSale());
  await settle(300);
});

/* ---------- 6d. What stays out of Discount on everything ---------- */
await step('6d', async () => {
  await tap('[data-act="quick"]').catch(() => {});
  await scan(CODE.deck);
  await scan(CODE.sleeves);
  await scan(CODE.booster, 1300);
  await noToast();
  v = await look();
  check("a Commander deck's sleeves are free with it: the shop's own deal, on Shopify's sums", v.totals.includes('Final Fantasy Commander deck + free sleeves −$19.99') && v.totals.includes('Total $100.99'), v.totals);
  // the sleeves' own Discount: the Lair app's price said a deal has taken something off them
  await tap('.t-line:nth-child(2) [data-act="discount"]');
  v = await look();
  check("Discount on the sleeves says they're on a deal already, and offers no amounts", v.view === 'discount' && v.lede === "$19.99. It's on a deal already, so it can't have a discount too." && v.quick.length === 0 && !v.field, v);
  await tap('[data-act="back"]');
  await tap('[data-act="discount"][data-key="*"]');
  v = await look();
  check('Discount on everything leaves the free sleeves out, and says why', v.lede === '$100.99 before the discount.' && v.notes.includes('Things on a deal already stay as they are.') && !v.notes.some((t) => /Dice|on sale|Bookings/.test(t)), { lede: v.lede, notes: v.notes });
  await type('10', 1300);
  v = await look();
  check('$10 is shared across the deck and the booster only, and the Lair app takes it', v.view === 'till' && JSON.stringify(offsSent('till/price')) === JSON.stringify([['5028', 892], ['5013', 108]]) && v.totals.includes('Staff discount −$10.00') && v.totals.includes('Total $90.99')
    && v.toast === '$10.00 off the sale, shared across 2 things. Someone with Money approves it at Pay.', { v, sent: offsSent('till/price') });
  await noToast();
  // dice and a drink on sale join the sale: each stays out, for its own reason
  await scan(CODE.oakie);
  await scan(CODE.coke, 1300);
  await noToast();
  await tap('[data-act="discount"][data-key="*"]');
  v = await look();
  check('with dice and something on sale in it too: the same $100.99, and each reason said once',
    v.lede === '$100.99 before the discount.' && v.notes[0] === 'Dice keep the dice deal instead, so they stay as they are. Things on sale or on a deal already stay as they are.' && v.notes.length === 2 && v.quick.includes('$10 off $90.99 (on)'), { lede: v.lede, notes: v.notes, quick: v.quick });
  await shot(page, 'till-10-everything-stays');
  check('nothing bigger is offered than the deck and the booster can take between them ($17.99 and $2.20)', !v.quick.some((t) => /^\$50 off/.test(t)) && v.quick.some((t) => /^\$20 off \$80\.99$/.test(t)), v.quick);
  await tap('[data-act="discount-set"][data-c="2000"]', 1300);
  v = await look();
  check('$20 the same way: the dice and the drink keep their price', v.view === 'till' && JSON.stringify(offsSent('till/price')) === JSON.stringify([['5028', 1783], ['5013', 217]]) && v.totals.includes('Staff discount −$20.00'), { v, sent: offsSent('till/price') });
  await noToast();
  await page.evaluate(() => document.querySelector('lair-till').nextSale());
  await settle(300);
  // only dice in the sale: nothing to share it across
  await tap('[data-act="quick"]').catch(() => {});
  await scan(CODE.oakie);
  await scan(CODE.glow, 1300);
  await noToast();
  await tap('[data-act="discount"][data-key="*"]');
  v = await look();
  check('only dice in the sale: it says so, with no amounts and no field', v.lede === 'Only dice are in the sale, and they keep the dice deal.' && v.quick.length === 0 && !v.field && v.notes.length === 0, v);
  await tap('[data-act="back"]');
  await page.evaluate(() => document.querySelector('lair-till').nextSale());
  await settle(300);
});

/* ---------- 6e. Tapped before Shopify's price is in ---------- */
await step('6e', async () => {
  // the till doesn't know yet that the sleeves are the deal's, so it shares across them too; the Lair app won't have it
  state.slowPrice = 2500;
  await tap('[data-act="quick"]').catch(() => {});
  await scan(CODE.deck, 400);
  await scan(CODE.sleeves, 400);
  await tap('[data-act="discount"][data-key="*"]', 200);
  v = await look();
  check('before the price is in, the till shares across both', v.lede === '$109.98 before the discount.', v.lede);
  await type('10', 300);
  state.slowPrice = 0;
  await page.waitForFunction(() => /on a deal already/.test(document.querySelector('[data-r="toast"]')?.textContent || ''), null, { timeout: 12000 }).catch(() => {});
  v = await look();
  check("the Lair app's own words for the sleeves, and the sale is still there",
    v.view === 'till' && v.toast === "Final Fantasy Commander Sleeves (100) is on a deal already, so it can't have a discount too. Take the discount off it." && JSON.stringify(offsSent('till/price')) === JSON.stringify([['5028', 819], ['5029', 181]]), { v, sent: offsSent('till/price') });
  await noToast();
  await tap('[data-act="discount"][data-key="*"]');
  v = await look();
  check('Discount on everything now leaves the sleeves out', v.lede === '$89.99 before the discount.' && v.notes.includes('Things on a deal already stay as they are.') && v.quick.includes('$10 off $79.99 (on)'), { lede: v.lede, notes: v.notes, quick: v.quick });
  await tap('[data-act="discount-set"][data-c="1000"]', 1300);
  v = await look();
  check('$10 again: all of it off the deck, none on the sleeves, and the Lair app takes it', v.view === 'till' && JSON.stringify(offsSent('till/price')) === JSON.stringify([['5028', 1000]]) && v.totals.includes('Staff discount −$10.00') && v.totals.includes('Total $79.99')
    && v.toast === '$10.00 off the sale. Someone with Money approves it at Pay.', { v, sent: offsSent('till/price') });
  await noToast();
  await page.evaluate(() => document.querySelector('lair-till').nextSale());
  await settle(300);
});

/* ---------- 7. Things on sale already ---------- */
await step('7', async () => {
  await tap('[data-act="quick"]').catch(() => {});
  await scan(CODE.coke);
  await scan(CODE.barrage);
  await noToast();
  await tap('[data-act="discount"] >> nth=0');
  v = await look();
  check("the half-price drink ($6, now $3) can't have a discount: it says why, and offers no amounts",
    v.title === 'Coca-Cola – Half Price (Flat)' && v.lede === "$3.00, down from $6.00. It's on sale already, so it can't have a discount too." && v.quick.length === 0 && v.field === null, v);
  await shot(page, 'till-5-on-sale');
  await tap('[data-act="back"]');
  await tap('[data-act="discount"] >> nth=1');
  v = await look();
  check('Barrage ($100, now $90) is offered up to $10 off', JSON.stringify(v.quick) === JSON.stringify(['$0.50 off $89.50', '$1 off $89.00', '$2 off $88.00', '$5 off $85.00', '$10 off $80.00']), v.quick);
  await type('10.01');
  v = await look();
  check('$10.01 typed: $10.00 at most (80% of what it was)', v.view === 'discount' && v.toast === 'Barrage can come down by $10.00 at most.', v);
  await noToast();
  await type('$10', 1200);
  v = await look();
  check('$10: Staff discount −$10.00, Total $83.00', v.view === 'till' && v.totals.includes('Staff discount −$10.00') && v.totals.includes('Total $83.00'), v);
  await noToast();
});

/* ---------- 8. On top of the dice deal ---------- */
await step('8', async () => {
  await tap('[data-act="remove"] >> nth=0').catch(() => {});
  // a fresh quick sale: two of the same dice set, with a discount on the line (two is no deal yet)
  await page.evaluate(() => document.querySelector('lair-till').nextSale());
  await settle(300);
  await tap('[data-act="quick"]').catch(() => {});
  await scan(CODE.oakie);
  await scan(CODE.oakie);
  await noToast();
  await tap('[data-act="discount"] >> nth=0');
  await tap('[data-act="discount-set"][data-c="100"]', 1300);
  v = await look();
  check('two dice sets with $1 off each: the Lair app takes it, Total $29.98', v.totals.includes('Staff discount −$2.00') && v.totals.includes('Total $29.98'), v);
  await noToast();
  // a third makes it the dice deal's: the free one comes off this line, which has a discount on it
  await scan(CODE.oakie, 1300);
  v = await look();
  const words = "Oakie Doakie Translucent RPG Dice Set · Green is on a deal already, so it can't have a discount too. Take the discount off it.";
  check("a third set, so the deal's free one lands on the discounted line: the Lair app's words", v.toast === words, v.toast);
  await noToast();
  const pays = calls('till/pay').length;
  await tap('[data-act="pay-card"]', 900);
  v = await look();
  check('Card asks the Lair app afresh and says them again: nobody is asked for a PIN, and nothing goes to Pay', v.view === 'till' && !v.busy && v.toast === words && calls('till/pay').length === pays, { view: v.view, toast: v.toast });
  await noToast();
  // its Discount screen knows now (the refusal said the line is the deal's): no amounts, only the way out
  await tap('[data-act="discount"] >> nth=0');
  v = await look();
  check("Discount on it says it's on a deal already, with no amounts to tap or type, and No discount", v.lede === "$15.99 each. It's on a deal already, so it can't have a discount too." && v.quick.length === 0 && !v.field && v.none, v);
  await tap('[data-act="discount-set"][data-c="0"]', 1200);
  v = await look();
  check('No discount: it says Discount taken off, and the sale is the deal alone', /Discount taken off\./.test(v.toast) && v.offs[0] === 'Discount' && v.totals.some((t) => /3rd free −\$15\.99/.test(t)) && v.totals.includes('Total $31.98') && v.lines[0].sub === 'Green', v);
  await noToast();
  // and from the price alone (no refusal first): three dice on a line are the deal's
  await tap('[data-act="discount"] >> nth=0');
  v = await look();
  check("three dice sets priced: Discount says they're on a deal already, and there's nothing to take off", v.lede === "$15.99 each. It's on a deal already, so it can't have a discount too." && v.quick.length === 0 && !v.field && !v.none, v);
  await tap('[data-act="back"]');
});

/* ---------- 9. Pay tapped before the discount's priced ---------- */
await step('9', async () => {
  await page.evaluate(() => document.querySelector('lair-till').nextSale());
  await settle(300);
  await tap('[data-act="quick"]').catch(() => {});
  await scan(CODE.wonders);
  await noToast();
  v = await look();
  check('one thing in the sale: its own Discount, and none for everything', JSON.stringify(v.offs) === JSON.stringify(['Discount']), v.offs);
  state.slowPrice = 1500;
  await tap('[data-act="discount"] >> nth=0');
  await tap('[data-act="discount-set"][data-c="500"]', 60);
  const pays = calls('till/pay').length;
  await tap('[data-act="pay-card"]', 250);
  const during = await look();
  await settle(2600);
  state.slowPrice = 0;
  v = await look();
  check('Card tapped before the Lair app has priced the discount: the sale waits (its buttons off), nothing is sent to Pay', during.view === 'till' && during.busy && /\(off\)/.test(during.pay[0]) && calls('till/pay').length === pays, during);
  check('and once the price is in it carries on to Approve the discount by itself: one tap', v.view === 'discountok' && /\$5\.00 off, so the sale is \$100\.00\./.test(v.lede), { view: v.view, lede: v.lede, toast: v.toast });
  await tap('[data-act="back"]');
  await noToast();
});

/* ---------- 10. The price in Shopify dropping between the price and Pay ---------- */
await step('10', async () => {
  // $5 off a $105 game is fine; Mo drops it to $20 in Shopify before Pay, and $5 is more than 20% of that
  VARIANTS[5026].price = 2000;
  const drafts = shop.drafts.length;
  await tap('[data-act="pay-card"]');
  await tap(`[data-act="pick"][data-id="${OWNER}"]`);
  await pin('2580', 1400);
  v = await look();
  check("Pay after the price dropped: the Lair app's words, and the sale is still there, unpaid", v.view === 'till' && /7 Wonders can come down by \$4\.00 at most\. Change the discount, or take it off\./.test(v.toast), v);
  check('the draft Shopify made for it was deleted, and the sale let go', shop.drafts.length === drafts + 1 && shop.deleted.includes(shop.drafts.at(-1).id) && saleRow().ended_why === 'discount', { drafts: shop.drafts.length - drafts, why: saleRow().ended_why });
  await settle(1200);
  await noToast();
  const pays = calls('till/pay').length;
  await tap('[data-act="pay-card"]', 900);
  v = await look();
  check('Card again says why without sending anything to Pay, until the discount is changed', v.view === 'till' && !v.busy && /can come down by \$4\.00 at most/.test(v.toast) && calls('till/pay').length === pays, { view: v.view, toast: v.toast });
  await noToast();
  // the price goes back up in Shopify: the very same basket is fine again, and Card finds that out by asking
  VARIANTS[5026].price = 10500;
  await tap('[data-act="pay-card"]', 1100);
  v = await look();
  check("a refusal doesn't stick: once Shopify's price allows it again, Card goes through (Mo's PIN from a minute ago still approves this basket): $100.00 on the EFTPOS screen", v.view === 'card' && v.amount === '$100.00', { view: v.view, amount: v.amount, toast: v.toast });
  await tap('[data-act="back"]');
  VARIANTS[5026].price = 2000;
  await tap('[data-act="pay-card"]', 1100);
  await noToast();
  await tap('[data-act="discount"] >> nth=0');
  v = await look();
  check("Discount now offers what it can take at its new price (the refusal said the line's figures): up to $2 off $20.00, and what's on it in the field",
    v.lede === '$20.00 before the discount.' && JSON.stringify(v.quick) === JSON.stringify(['$0.50 off $19.50', '$1 off $19.00', '$2 off $18.00']) && v.field.value === '5.00', v);
  await tap('[data-act="back"]');
  VARIANTS[5026].price = 10500;
});

/* ---------- 11. A Lair app from before dollars ---------- */
await step('11', async () => {
  await page.evaluate(() => document.querySelector('lair-till').nextSale());
  await settle(300);
  await tap('[data-act="quick"]').catch(() => {});
  await scan(CODE.wonders);
  await noToast();
  state.old = true;
  await tap('[data-act="discount"] >> nth=0');
  await tap('[data-act="discount-set"][data-c="1000"]', 1300);
  v = await look();
  const words = "The Lair app hasn't caught up with dollar discounts yet. Take the discount off for now, or try again in a few minutes.";
  check('a Lair app that prices the basket without the discount: the till says it has not caught up', v.toast === words && v.totals.includes('Total $105.00'), v);
  await noToast();
  const pays = calls('till/pay').length;
  await tap('[data-act="pay-card"]');
  v = await look();
  check('and Card does not go ahead: no PIN asked, nothing sent to Pay', v.view === 'till' && v.toast === words && calls('till/pay').length === pays, { view: v.view, toast: v.toast });
  state.old = false;
  await noToast();
});

/* ---------- 11b. The Lair app not answering the price once Pay is tapped ---------- */
await step('11b', async () => {
  // (the review) a price that never comes back mustn't leave the sale's buttons off: the till gives up after its wait
  // (12 seconds at the counter; 1.2 here) and says so
  await page.evaluate(() => {
    document.querySelector('lair-till').priceWait = 1200;
  });
  state.hangPrice = true;
  await tap('[data-act="discount"] >> nth=0');
  await tap('[data-act="discount-set"][data-c="500"]', 60);
  const pays = calls('till/pay').length;
  await tap('[data-act="pay-card"]', 300);
  const during = await look();
  await settle(1700);
  v = await look();
  check('no answer for the price after Card: the sale waits, then gives up and says so, with its buttons back on and nothing sent to Pay',
    during.busy && v.view === 'till' && !v.busy && !/\(off\)/.test(v.pay[0]) && v.toast === "Shopify didn't answer, so the discount isn't worked out yet. Try again in a moment." && calls('till/pay').length === pays, { during: during.busy, view: v.view, busy: v.busy, pay: v.pay, toast: v.toast });
  state.hangPrice = false;
  await settle(900);
  await noToast();
  // and once it answers again, Card goes on as usual
  await tap('[data-act="pay-card"]', 1100);
  v = await look();
  check('once the Lair app answers again, Card goes on to Approve the discount', v.view === 'discountok' && /\$5\.00 off, so the sale is \$100\.00\./.test(v.lede), { view: v.view, lede: v.lede, toast: v.toast });
  await tap('[data-act="back"]');
  await noToast();
});

/* ---------- 12. Typed oddities, and the customer screen ---------- */
await step('12', async () => {
  await tap('[data-act="discount"] >> nth=0');
  await type('ten');
  v = await look();
  check('words typed: it asks for dollars', v.view === 'discount' && v.toast === 'Type the dollars off, like 5 or 7.50.', v.toast);
  await noToast();
  await type('0');
  v = await look();
  check('nothing typed as 0: it asks for dollars', v.view === 'discount' && v.toast === 'Type the dollars off, like 5 or 7.50.', v.toast);
  await noToast();
  await type('7,5', 1200);
  v = await look();
  check('7,5 typed is $7.50 off', v.view === 'till' && v.offs[0] === '$7.50 off' && JSON.stringify(offsSent('till/price')) === JSON.stringify([['5026', 750]]) && v.totals.includes('Total $97.50'), { v, sent: offsSent('till/price') });
  await noToast();
  await tap('[data-act="discount"] >> nth=0');
  v = await look();
  check('Discount again: the typed amount is in the field', v.field && v.field.value === '7.50', v.field);
  await tap('[data-act="back"]');
  // shown to the customer: what came off and the total
  await tap('[data-act="customer"]');
  await settle(500);
  v = await look();
  check('Show the customer: their sale says Staff discount −$7.50 and Total $97.50', v.view === 'customer' && /Staff discount\s*−\$7\.50/.test(v.overText) && /Total\s*\$97\.50/.test(v.overText), v.overText);
  await shot(page, 'till-6-shown');
  // the till handed to customers: nothing of a discount on their own screen
  await page.evaluate(() => {
    const el = document.querySelector('lair-till');
    el.setView('till');
    el.nextSale();
  });
  await settle(300);
  await tap('[data-act="to-customers"]');
  await tap('[data-act="guest"]');
  await scan(CODE.wonders);
  await noToast();
  v = await look();
  const buttons = await page.evaluate(() => [...document.querySelectorAll('.t-off, [data-act="discount"], [data-act="discount-set"]')].filter((b) => b.offsetParent).length);
  check('the customer screen: 7 Wonders in the basket at $105.00 and no discount buttons', v.mode === 'customer' && buttons === 0 && v.totals.includes('Total $105.00'), { mode: v.mode, buttons, totals: v.totals });
  await shot(page, 'till-7-customer');
});

check('the till: no console errors', page.errors.length === 0, page.errors);
await ctx.close();
m.mockState.sectionSettings = null;
const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed (screenshots in ${process.env.OUT})`);
await browser.close();
server.close?.();
process.exit(fail ? 1 : 0);

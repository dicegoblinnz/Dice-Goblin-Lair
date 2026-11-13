// Round 36 (contract v36-till-discount-over): the till's own script in a browser (the theme mock, Sales: Live) against
// the Lair app itself: the Durable Object class run here on node's SQLite, as the tests run it, with only Shopify and
// the email service stood in for. Mo (13 Nov 2026): "for the discount limitation of 20% instead of locking it just
// create a warning message that this happened and flag it and send a special email when it happens so I would know
// [...] So you would create a warning message saying this exceeds the 20% threshold of discounts are you sure you wanna
// continue and when the transaction is done an automatic email is sent without alerting anyone etc. just for my
// information and if an investigation is needed I will deal with it myself I just want the information".
//  1. Mo unlocks; a quick sale of 7 Wonders ($105), two boosters ($11 each) and a half-price drink ($3, was $6).
//     $50 typed on 7 Wonders: the till asks first, in Mo's words, with what it would come to, and nothing is priced.
//  2. No, go back: the Discount screen again, with nothing on it.
//  3. $50 again and Yes, continue (a tap that lands as the question appears isn't a yes): the line has it, and says
//     it's over 20%. More than the thing costs is still turned down.
//  4. Two of something: $4 off each asks with "each". Something on sale already can have dollars typed now, and asks.
//  5. Card: the PIN screen says what the PIN is a yes to. Rua's PIN: Pay carries the till's yes, and what comes back
//     says nothing of a flag or an email.
//  6. Confirm paid: the order is tagged discount-over-20 with its note, and one email goes to the shop owner's own
//     address. Nothing on the till says so, and the team hear nothing.
//  7. A sale within 20% afterwards: no question, no yes sent, no flag, no email.
//  8. Discount on everything past what keeps the things within 20%: the till asks with each share; yes shares the
//     whole amount by price; more than the things cost is turned down.
//  9. That amount stays with the sale as it changes, and the PIN screen says what's past 20% as it stands then.
// 10. Back within 20%: no question. And a deal's line still can't have a discount at all.
// 11. Shopify's price dropping between the price and Pay: nothing is sold on a yes nobody gave; the next Pay asks.
// 11b. Two things' prices dropping before Pay: the till has both lines right at once, and the next Pay names both.
// 12. A scan while the till is asking: it wants its answer first.
// Usage: DG_THEME=/path/to/theme [LOOK=pieces|first] [PORT=4996] [OUT=dir] node tools/qa/round36-till-discount-over/till.mjs
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from '../../../test/cloudflare-sql.js';
import { Lair } from '../../../src/lair.js';
import { rulesFromSettings, DEFAULT_HOURS } from '../../../src/core.js';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round36-till-discount-over');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, overflowX, shot, watch, go, clockAt, STAFF } = lib;
const PORT = Number(process.env.PORT || 4996);
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

// (email is set up, and no address is set for the owner's email: it goes to the shop owner's own, as Shopify has it)
const lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'dice-goblin.myshopify.com', RESEND_API_KEY: 'test-key', FROM_EMAIL: 'Gobgob <gobgob@example.com>', STAFF_EMAIL: 'team@example.com' });
const shop = { drafts: [], deleted: [], completed: [], calculated: [], marked: [], owner: 'the-owner@example.com' };
/** Every email the Lair app sent, and every alert for the team */
const mails = [];
const alerts = [];
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
  // round 36: an order's tag and the paragraph on its note, and the shop owner's own address (Shop.email)
  gwMarkOrder: async (orderId, tag, paragraph) => {
    shop.marked.push({ orderId, tag, paragraph });
    return true;
  },
  shopOwnerEmail: async () => shop.owner,
});
lair.notifyStaff = (subject) => alerts.push(subject);
lair.mail = async (message) => {
  mails.push(message);
  return { ok: true, attempted: true, status: 200, code: null, message: 'Sent.' };
};
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
  const made = { name, body, status: 0, text: '' };
  state.calls.push(made);
  if (name === 'till/price' && state.slowPrice) await new Promise((r) => setTimeout(r, state.slowPrice));
  if (name === 'till/price' && state.hangPrice) {
    const until = Date.now() + 30000;
    while (state.hangPrice && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  }
  if (state.old && body?.lines) body = { ...body, lines: body.lines.map(({ off, ...l }) => l) };
  const res = await call(req.method(), name, body, url.search);
  made.status = res.status;
  made.text = res.text;
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
    field: over?.querySelector('#t-off') ? { label: f(over.querySelector('label[for="t-off"]')?.textContent), sign: f(over.querySelector('.t-discount__type span')?.textContent), value: over.querySelector('#t-off').value, held: document.activeElement === over.querySelector('#t-off') } : null,
    none: Boolean(over?.querySelector('[data-act="discount-set"][data-c="0"]')),
    notes: [...(over?.querySelectorAll('.t-temp') || [])].map((p) => f(p.textContent)),
    // round 36: the question a discount past 20% asks (its lines and its buttons), and what the PIN screen says of one
    past: [...(over?.querySelectorAll('.t-warn li') || [])].map((li) => f(li.textContent)), warn: f(over?.querySelector('p.t-warn')?.textContent),
    cap: f(over?.querySelector('.t-warn__cap')?.textContent),
    asks: [...(over?.querySelectorAll('[data-act="over-yes"], [data-act="over-no"]') || [])].map((b) => f(b.textContent)),
    overText: f(over?.textContent),
    approvers: [...(over?.querySelectorAll('.t-staff [data-act="pick"]') || [])].map((b) => f(b.textContent)),
    amount: f(over?.querySelector('.t-paying__amount')?.textContent), steps: [...(over?.querySelectorAll('.t-steps li') || [])].map((li) => f(li.textContent)),
    toast: f(q('[data-r="toast"]')?.textContent),
  };
});
const ASK = 'This exceeds the 20% discount threshold. Are you sure you want to continue?';
/** The till is asking about a discount past 20%, with these lines */
const asking = (view, lines) => view.view === 'discountover' && view.title === 'More than 20% off' && view.lede === ASK && JSON.stringify(view.past) === JSON.stringify(lines)
  && JSON.stringify(view.asks) === JSON.stringify(['Yes, continue', 'No, go back']);
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

/** Nothing the till shows or is told says the sale is flagged or that anyone is emailed */
const QUIET = /e-?mail|flag|discount-over|\btold\b|notif|investigat/i;
/** The question's buttons: big enough for a thumb on the counter's tablet, side by side, neither off the screen */
const askButtons = () => page.evaluate(() => [...document.querySelectorAll('[data-act="over-yes"], [data-act="over-no"]')].map((b) => {
  const r = b.getBoundingClientRect();
  return { h: Math.round(r.height), w: Math.round(r.width), inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth };
}));

/* ---------- 1. More than 20% off: the till asks first ---------- */
await step('1', async () => {
  await tap('[data-act="staff-door"]');
  await tap(`[data-act="pick"][data-id="${OWNER}"]`);
  await pin('2580');
  await tap('[data-act="quick"]');
  await scan(CODE.wonders);
  await scan(CODE.booster);
  await scan(CODE.booster);
  await scan(CODE.coke, 1300);
  await noToast();
  v = await look();
  check('7 Wonders, two boosters and a half-price drink: Card · $130.00', v.pay[0] === 'Card · $130.00' && v.lines.length === 3, v);
  await tap('[data-act="discount"] >> nth=0');
  v = await look();
  check('the Discount screen is as it was: nothing on it says a limit', v.view === 'discount' && v.lede === '$105.00 before the discount.' && !/%|at most|threshold/i.test(v.overText), v.overText);
  const prices = calls('till/price').length;
  await type('50');
  v = await look();
  check("$50 typed on a $105 game: the till asks, in Mo's words, with what it would come to", asking(v, ['7 Wonders: $50.00 off, so $55.00 (47.6% off)']) && !v.cap, v);
  check('nothing is on the line yet, nothing was priced, and no toast', v.lines[0].sub === '' && calls('till/price').length === prices && !v.toast, { sub: v.lines[0].sub, toast: v.toast });
  check('the question says nothing of a flag or an email', !QUIET.test(v.overText), v.overText);
  const buttons = await askButtons();
  check('Yes and No are each at least 64px tall and on the screen', buttons.length === 2 && buttons.every((b) => b.h >= 64 && b.w >= 120 && b.inView), buttons);
  const held = await page.evaluate(() => document.activeElement?.dataset?.act || '');
  check('the keyboard starts on No, go back: Enter pressed twice by mistake is not a yes', held === 'over-no', held);
  await shot(page, 'over-1-ask');
  check('the question: no sideways scroll', (await overflowX(page)) <= 0);
});

/* ---------- 2. No, go back ---------- */
await step('2', async () => {
  const prices = calls('till/price').length;
  await tap('[data-act="over-no"]');
  v = await look();
  check('No, go back: Discount on 7 Wonders again, nothing on the line, nothing priced', v.view === 'discount' && v.title === '7 Wonders' && v.lines[0].sub === '' && !v.none && !v.toast && calls('till/price').length === prices, v);
  check('what was typed is in the field again, ready to type over: a slip of the finger is put right in one go', v.field.value === '50.00' && v.field.held, v.field);
  const picked = await page.evaluate(() => {
    const box = document.querySelector('#t-off');
    return box.selectionStart === 0 && box.selectionEnd === box.value.length;
  });
  check('and picked out, so the next thing typed takes its place', picked, picked);
});

/* ---------- 3. Yes, continue ---------- */
await step('3', async () => {
  // a tap that lands as the question appears was meant for the screen before it: it isn't a yes
  await type('50', 0);
  await page.evaluate(() => document.querySelector('lair-till [data-act="over-yes"]').click());
  await settle(150);
  v = await look();
  check('a Yes pressed in the moment the question appears is not taken: it is still asking', asking(v, ['7 Wonders: $50.00 off, so $55.00 (47.6% off)']) && v.lines[0].sub === '', v);
  await settle(500);
  await tap('[data-act="over-yes"]', 1300);
  v = await look();
  check('Yes, continue: back at the sale, the line has $50.00 off and says it is over 20%, and the Lair app is asked for the price with 5000 off it',
    v.view === 'till' && v.offs[0] === '$50.00 off' && v.lines[0].sub === 'Staff discount: $50.00 off · over 20%' && JSON.stringify(offsSent('till/price')) === JSON.stringify([['5026', 5000]]), { v, sent: offsSent('till/price') });
  check('the Lair app prices it: Staff discount −$50.00, Total $80.00, Card · $80.00', v.totals.includes('Staff discount −$50.00') && v.totals.includes('Total $80.00') && v.pay[0] === 'Card · $80.00', v);
  check('the till says who approves it, as for any discount', v.toast === '$50.00 off. Someone with Money approves it at Pay.', v.toast);
  await noToast();
  // more than it costs is still turned down, there and then
  await tap('[data-act="discount"] >> nth=0');
  v = await look();
  check("Discount again: what's on it is in the field, and No discount is offered", v.field && v.field.value === '50.00' && v.none, v.field);
  const prices = calls('till/price').length;
  await type('105.01');
  v = await look();
  check('a cent more than it costs: the till says so and stays', v.view === 'discount' && v.toast === "7 Wonders is $105.00, so it can't come down by more than that." && calls('till/price').length === prices, v);
  await noToast();
  await type('105');
  v = await look();
  check('the whole price asks, as 100% off', asking(v, ['7 Wonders: $105.00 off, so $0.00 (100% off)']), v);
  await tap('[data-act="over-no"]');
  await tap('[data-act="back"]');
});

/* ---------- 4. Off each one, and something on sale already ---------- */
await step('4', async () => {
  await tap('[data-act="discount"] >> nth=1');
  await type('4');
  v = await look();
  check('$4 off each of two boosters asks, saying each', asking(v, ['2 × Riftbound Radiance: $4.00 off each, so $7.00 each (36.4% off)']), v);
  await settle(450);
  await tap('[data-act="over-yes"]', 1300);
  v = await look();
  check('Yes: the line says $4.00 off each, over 20%', v.view === 'till' && v.lines[1].sub === 'Booster Pack · Staff discount: $4.00 off each · over 20%', v.lines);
  await noToast();
  // the drink is half price already ($6, now $3): before, it couldn't have a discount at all
  await tap('[data-act="discount"] >> nth=2');
  v = await look();
  check('the half-price drink says what it was, and dollars can be typed (no ready amounts: any would be past 20% of what it was)',
    v.title === 'Coca-Cola – Half Price (Flat)' && v.lede === '$3.00, down from $6.00.' && v.quick.length === 0 && v.field && v.field.label === 'Type the dollars off', v);
  await type('0.50');
  v = await look();
  check('50c off it asks, as a share of what it was', asking(v, ['Coca-Cola – Half Price (Flat): $0.50 off, so $2.50 (58.3% off what it was)']), v);
  await settle(450);
  await tap('[data-act="over-yes"]', 1300);
  v = await look();
  check('Yes: the Lair app takes all three: Staff discount −$58.50, Total $71.50',
    v.view === 'till' && v.totals.includes('Staff discount −$58.50') && v.totals.includes('Total $71.50') && JSON.stringify(offsSent('till/price')) === JSON.stringify([['5026', 5000], ['5013', 400], ['5024', 50]]), { v, sent: offsSent('till/price') });
  await noToast();
  await shot(page, 'over-2-sale');
});

/* ---------- 5. Card: the PIN screen says what the PIN is a yes to ---------- */
let overOrder = null;
await step('5', async () => {
  const before = calls('till/pay').length;
  await tap('[data-act="pay-card"]');
  v = await look();
  check('Card asks to Approve the discount: $58.50 off, so the sale is $71.50', v.view === 'discountok' && v.title === 'Approve the discount' && /\$58\.50 off, so the sale is \$71\.50\./.test(v.lede) && calls('till/pay').length === before, { view: v.view, lede: v.lede });
  check('and says what the PIN is a yes to, thing by thing',
    v.warn === 'This exceeds the 20% discount threshold on 3 things: 7 Wonders (47.6% off), Riftbound Radiance (36.4% off) and Coca-Cola – Half Price (Flat) (58.3% off what it was). A PIN says yes to that.', v.warn);
  check('the PIN screen says nothing of a flag or an email', !QUIET.test(v.overText), v.overText);
  const fits = await page.evaluate(() => {
    const pad = document.querySelector('[data-r="over"] .t-pinpad')?.getBoundingClientRect();
    const staff = document.querySelector('[data-r="over"] .t-lock__staff')?.getBoundingClientRect();
    return { pad: pad ? pad.bottom <= innerHeight && pad.top >= 0 : false, staff: staff ? staff.bottom <= innerHeight && staff.top >= 0 : false };
  });
  check('with that on it, the names and the PIN pad still fit the screen', fits.pad && fits.staff, fits);
  await shot(page, 'over-3-pin');
  check('the PIN screen: no sideways scroll', (await overflowX(page)) <= 0);
  await tap(`[data-act="pick"][data-id="${RUA}"]`);
  await pin('4711', 1300);
  v = await look();
  const sent = calls('till/pay').at(-1) || {};
  check("Rua's PIN: Pay carries her approval, the till's yes (overOk) and each line's dollars off",
    calls('till/pay').length === before + 1 && sent.body.overOk === true && Boolean(sent.body.discountOk) && JSON.stringify(offsSent('till/pay')) === JSON.stringify([['5026', 5000], ['5013', 400], ['5024', 50]]), sent.body);
  check('the EFTPOS screen says $71.50', v.view === 'card' && v.amount === '$71.50' && v.steps[0] === 'Key $71.50 into the EFTPOS', v);
  check("what Pay answered, and the screen, say nothing of a flag or an email", sent.status === 200 && !QUIET.test(sent.text) && !QUIET.test(v.overText), { text: sent.text.slice(0, 400), over: v.overText });
  // (the review, 13 Nov 2026) nor that the sale is past 20% at all: its answer is any discounted sale's
  check('nor does Pay\'s answer mark any line as past 20%', !/"over"/.test(sent.text), sent.text.slice(0, 600));
  check('nothing is flagged or sent before it is paid', shop.marked.length === 0 && mails.length === 0, { marked: shop.marked.length, mails: mails.length });
});

/* ---------- 6. Paid: flagged in Shopify, and the owner emailed, quietly ---------- */
await step('6', async () => {
  await tap('[data-act="card-ok"]');
  await settle(1300);
  v = await look();
  const confirmed = calls('till/paid').at(-1) || {};
  const row = saleRow();
  overOrder = row.order_name;
  check('Confirm paid: the sale is done', confirmed.body.expect === 7150 && v.view === 'done' && row.status === 'paid' && row.total === 7150 && row.discount_total === 5850, { view: v.view, status: row.status, total: row.total });
  check('its order is tagged discount-over-20, with which things on its note',
    JSON.stringify(shop.marked) === JSON.stringify([{ orderId: row.order_id, tag: 'discount-over-20',
      paragraph: 'More than 20% off, said yes to at the till: 7 Wonders, $50.00 off (47.6% off); 2 × Riftbound Radiance · Booster Pack, $4.00 off each (36.4% off); Coca-Cola – Half Price (Flat) · Classic, $0.50 off (58.3% off what it was).' }]), shop.marked);
  const mail = mails[0] || {};
  const text = String(mail.text || '').replace(/[ \t]+/g, ' ');
  check("one email, to the shop owner's own address as Shopify has it", mails.length === 1 && mail.to === 'the-owner@example.com' && mail.subject === `Till discount over 20%: ${row.order_name}, $58.50 off`, { n: mails.length, to: mail.to, subject: mail.subject });
  const wanted = [
    'A sale at the till had a staff discount that took 3 things more than 20% off. Rua approved it with their PIN.',
    "Nobody at the till was told about this email. It's only so you know.",
    `Order: ${row.order_name}`, 'Rung up by: Mo', 'Approved by: Rua', 'Paid: $71.50 by card, taken by Mo', 'Sold to: A quick sale (no member)',
    '7 Wonders: $50.00 off, 47.6% off ($105.00 down to $55.00)',
    '2 × Riftbound Radiance · Booster Pack: $4.00 off each, 36.4% off ($11.00 down to $7.00 each)',
    'Coca-Cola – Half Price (Flat) · Classic: $0.50 off, 58.3% off what it was ($6.00 before its sale, $3.00 down to $2.50)',
    'Before discounts: $130.00', 'Staff discounts: $58.50',
  ];
  const missing = wanted.filter((w) => !text.includes(w));
  check('it says who rang it up, who approved it, how it was paid and what came off what', missing.length === 0, { missing, text });
  check('the team hear nothing, and neither the Done screen nor what the Lair app answered says anything of it', alerts.length === 0 && !QUIET.test(v.overText) && !v.toast && !QUIET.test(confirmed.text) && !/"over"/.test(confirmed.text), { alerts, over: v.overText, toast: v.toast, text: String(confirmed.text).slice(0, 300) });
  await shot(page, 'over-4-done');
});

/* ---------- 7. A sale within 20% afterwards ---------- */
await step('7', async () => {
  await tap('[data-act="next"]');
  await tap('[data-act="quick"]');
  await scan(CODE.wonders, 1300);
  await noToast();
  await tap('[data-act="discount"] >> nth=0');
  await tap('[data-act="discount-set"][data-c="500"]', 1300);
  v = await look();
  check('$5 off a $105 game: no question, and the line does not say over 20%', v.view === 'till' && v.lines[0].sub === 'Staff discount: $5.00 off' && v.totals.includes('Total $100.00'), v);
  await noToast();
  await tap('[data-act="pay-card"]');
  v = await look();
  check('its PIN screen says nothing of the threshold', v.view === 'discountok' && !v.warn && !/threshold|20%/.test(v.overText), { view: v.view, warn: v.warn });
  await tap(`[data-act="pick"][data-id="${RUA}"]`);
  await pin('4711', 1300);
  const sent = calls('till/pay').at(-1) || {};
  await tap('[data-act="card-ok"]');
  await settle(1300);
  v = await look();
  check('paid with no yes sent, no flag and no email', v.view === 'done' && sent.body.overOk === undefined && shop.marked.length === 1 && mails.length === 1 && saleRow().discount_over === null, { view: v.view, overOk: sent.body.overOk, marked: shop.marked.length, mails: mails.length });
});

/* ---------- 8. Discount on everything, past what keeps the things within 20% ---------- */
await step('8', async () => {
  await tap('[data-act="next"]');
  await tap('[data-act="quick"]');
  await scan(CODE.wonders);
  await scan(CODE.booster);
  await scan(CODE.booster);
  await scan(CODE.coke, 1300);
  await noToast();
  await tap('[data-act="discount"][data-key="*"]');
  v = await look();
  check('Discount on everything is as it was: $127.00 before the discount, amounts up to $20, the drink left out', v.lede === '$127.00 before the discount.' && v.quick.at(-1) === '$20 off $107.00' && /Things on sale already stay as they are\./.test(v.overText), v);
  const prices = calls('till/price').length;
  await type('40');
  v = await look();
  check('$40 typed (these are within 20% only up to $25.40): the till asks, with each share',
    asking(v, ['7 Wonders: $33.08 off, so $71.92 (31.5% off)', '2 × Riftbound Radiance: $3.46 off each, so $7.54 each (31.5% off)']) && v.cap === '$40.00 off the sale takes these past 20%:' && calls('till/price').length === prices, v);
  await shot(page, 'over-5-ask-all');
  check('the question for the sale: no sideways scroll', (await overflowX(page)) <= 0);
  await tap('[data-act="over-no"]');
  v = await look();
  check('No, go back: Discount on everything again, nothing on, with the $40 that was typed in its field', v.view === 'discount' && v.title === 'Everything in the sale' && v.field.value === '40.00' && v.field.held && !v.none, v);
  await type('127.01');
  v = await look();
  check('a cent more than the things cost: the till says so and stays', v.view === 'discount' && v.toast === "These come to $127.00, so the sale can't come down by more than that." && calls('till/price').length === prices, v);
  await noToast();
  await type('40');
  await settle(450);
  await tap('[data-act="over-yes"]', 1300);
  v = await look();
  check('Yes: $40.00 is shared by price, $33.08 off the game and $3.46 off each booster, and the drink keeps its price',
    v.view === 'till' && JSON.stringify(offsSent('till/price')) === JSON.stringify([['5026', 3308], ['5013', 346]]) && v.lines[0].sub === 'Staff discount: $33.08 off · over 20%' && v.lines[1].sub === 'Booster Pack · Staff discount: $3.46 off each · over 20%' && v.lines[2].sub === 'Classic', { v, sent: offsSent('till/price') });
  check('Staff discount −$40.00, Total $90.00, and the till says how it was shared', v.totals.includes('Staff discount −$40.00') && v.totals.includes('Total $90.00') && v.toast === '$40.00 off the sale, shared across 2 things. Someone with Money approves it at Pay.' && v.offs.at(-1) === '$40.00 off everything', v);
  await noToast();
  await tap('[data-act="discount"][data-key="*"]');
  v = await look();
  check('opened again: the $40 is in the field, and No discount is offered', v.field && v.field.value === '40.00' && v.none && v.lede === '$127.00 before the discount.', { field: v.field, lede: v.lede });
  await tap('[data-act="back"]');
});

/* ---------- 9. The amount stays with the sale, as the share of it that was said yes to ---------- */
await step('9', async () => {
  // one more booster: the sale is bigger, so the $40 stands, shared again
  await tap('.t-line:nth-child(2) [data-act="more"]', 1300);
  v = await look();
  check('one more booster: still $40.00 off, shared again ($30.46 and $3.18 each), Total $101.00',
    JSON.stringify(offsSent('till/price')) === JSON.stringify([['5026', 3046], ['5013', 318]]) && v.totals.includes('Staff discount −$40.00') && v.totals.includes('Total $101.00') && v.offs.at(-1) === '$40.00 off everything', { v, sent: offsSent('till/price') });
  await noToast();
  await tap('[data-act="pay-card"]', 900);
  v = await look();
  check('Card: the PIN screen says what is past 20% as the sale stands now',
    v.view === 'discountok' && /\$40\.00 off, so the sale is \$101\.00\./.test(v.lede) && v.warn === 'This exceeds the 20% discount threshold on 2 things: 7 Wonders (29% off) and Riftbound Radiance (28.9% off). A PIN says yes to that.', { view: v.view, lede: v.lede, warn: v.warn });
  await tap('[data-act="back"]');
  // the game comes out: $40 off three boosters would be more than they cost. The yes was to 31.5% of the sale, so
  // that's what stays on what's left, never more
  await tap('.t-line:nth-child(1) [data-act="less"]', 1300);
  v = await look();
  check('7 Wonders taken out: the boosters keep the same share off ($3.46 each), not the whole $40',
    JSON.stringify(offsSent('till/price')) === JSON.stringify([['5013', 346]]) && v.totals.includes('Staff discount −$10.38') && v.totals.includes('Total $25.62') && v.offs.at(-1) === '$10.38 of $40.00 off everything', { v, sent: offsSent('till/price') });
  await tap('[data-act="discount"][data-key="*"]');
  v = await look();
  check('its screen says why', v.lede === '$33.00 before the discount. $10.38 of the $40.00 is off: the same share of the sale as when it was set.' && v.field.value === '40.00', { lede: v.lede, field: v.field });
  await tap('[data-act="back"]');
  await scan(CODE.wonders, 1300);
  v = await look();
  check('7 Wonders scanned back in: $40.00 off the sale again', v.totals.includes('Staff discount −$40.00') && v.totals.includes('Total $101.00') && v.offs.at(-1) === '$40.00 off everything', v);
  await noToast();
});

/* ---------- 10. Back within 20%; and a deal's line still can't have a discount ---------- */
await step('10', async () => {
  await tap('[data-act="discount"][data-key="*"]');
  await tap('[data-act="discount-set"][data-c="1000"]', 1300);
  v = await look();
  check('$10 off the sale instead: no question, nothing over 20%', v.view === 'till' && v.totals.includes('Staff discount −$10.00') && v.offs.at(-1) === '$10.00 off everything' && !v.lines.some((l) => /over 20%/.test(l.sub)), v);
  await noToast();
  await tap('[data-act="pay-card"]', 900);
  v = await look();
  check('and its PIN screen says nothing of the threshold', v.view === 'discountok' && !v.warn, { view: v.view, warn: v.warn });
  await tap('[data-act="back"]');
  await page.evaluate(() => document.querySelector('lair-till').nextSale());
  await settle(300);
  await tap('[data-act="quick"]').catch(() => {});
  await scan(CODE.oakie);
  await scan(CODE.oakie);
  await scan(CODE.oakie, 1300);
  await noToast();
  await tap('[data-act="discount"] >> nth=0');
  v = await look();
  check("three dice sets (the dice deal's free one is on the line): Discount still says it can't have one too, with nothing to type", v.lede === "$15.99 each. It's on a deal already, so it can't have a discount too." && v.quick.length === 0 && !v.field, v);
  await tap('[data-act="back"]');
  await page.evaluate(() => document.querySelector('lair-till').nextSale());
  await settle(300);
});

/* ---------- 11. Shopify's figures putting a discount past 20% ---------- */
await step('11', async () => {
  // typed before Shopify's price is in: the till's own sum has Barrage ($90) within 20% up to $18, so $15 isn't asked
  // about; Shopify has it on sale ($100 before), so it's within 20% only up to $10. The price says so, the line says
  // so, and the PIN screen says what the PIN is a yes to
  state.slowPrice = 2500;
  await tap('[data-act="quick"]').catch(() => {});
  await scan(CODE.barrage, 400);
  await tap('[data-act="discount"] >> nth=0', 200);
  await type('15', 300);
  v = await look();
  check("$15 off Barrage before Shopify's price is in: no question yet", v.view === 'till' && v.lines[0].sub === 'Staff discount: $15.00 off', v.lines);
  state.slowPrice = 0;
  await settle(3200);
  await noToast();
  v = await look();
  check("Shopify's price is in: the line says it is over 20% now", v.lines[0].sub === 'Staff discount: $15.00 off · over 20%' && v.totals.includes('Total $75.00'), v);
  const pays = calls('till/pay').length;
  await tap('[data-act="pay-card"]', 900);
  v = await look();
  check('Card: the PIN screen says so, as a share of what it was', v.view === 'discountok' && v.warn === 'This exceeds the 20% discount threshold: Barrage is 25% off what it was. A PIN says yes to that.' && calls('till/pay').length === pays, { view: v.view, warn: v.warn });
  await tap(`[data-act="pick"][data-id="${OWNER}"]`);
  await pin('2580', 1300);
  v = await look();
  check("Mo's PIN: Pay carries the till's yes, and the EFTPOS screen says $75.00", v.view === 'card' && v.amount === '$75.00' && calls('till/pay').at(-1).body.overOk === true, { view: v.view, amount: v.amount });
  await tap('[data-act="back"]');
});

/* ---------- 11b. Shopify's prices dropping on two things between the price and Pay ---------- */
await step('11b', async () => {
  // $5 off a $105 game and $2 off an $11 booster are both within 20%. Mo drops them to $20 and $5 in Shopify before
  // Pay: both are past 20% now, and nobody was asked. Nothing is sold; the Lair app says which lines, with its figures,
  // and the till has both right at once (its own next price is slow here, so it can't be that which puts them right)
  await page.evaluate(() => document.querySelector('lair-till').nextSale());
  await settle(300);
  await tap('[data-act="quick"]').catch(() => {});
  await scan(CODE.wonders);
  await scan(CODE.booster, 1300);
  await noToast();
  await tap('[data-act="discount"] >> nth=0');
  await tap('[data-act="discount-set"][data-c="500"]', 1300);
  await noToast();
  await tap('[data-act="discount"] >> nth=1');
  await tap('[data-act="discount-set"][data-c="200"]', 1300);
  await noToast();
  v = await look();
  check('$5 off the game and $2 off the booster: within 20%, nothing asked, Total $109.00', v.view === 'till' && v.totals.includes('Total $109.00') && !v.lines.some((l) => /over 20%/.test(l.sub)), v);
  VARIANTS[5026].price = 2000;
  VARIANTS[5013].price = 500;
  try {
    const drafts = shop.drafts.length;
    await tap('[data-act="pay-card"]');
    v = await look();
    check('Card: the PIN screen says nothing of the threshold (the till has no reason to yet)', v.view === 'discountok' && !v.warn, { view: v.view, warn: v.warn });
    state.slowPrice = 3000;
    await tap(`[data-act="pick"][data-id="${OWNER}"]`);
    await pin('2580', 1400);
    v = await look();
    check("Mo's PIN, with both prices dropped in Shopify: nothing is sold, and the till says two things are past 20% now",
      v.view === 'till' && v.toast === "2 things are more than 20% off on Shopify's prices now. Pay again to carry on, or change the discount." && shop.drafts.length === drafts + 1 && shop.deleted.includes(shop.drafts.at(-1).id) && saleRow().ended_why === 'discount', { view: v.view, toast: v.toast, why: saleRow().ended_why });
    check('both lines say so at once, at the prices Shopify has', v.lines[0].sub === 'Staff discount: $5.00 off · over 20%' && v.lines[1].sub === 'Booster Pack · Staff discount: $2.00 off · over 20%' && v.lines[0].amount === '$20.00' && v.lines[1].amount === '$5.00', v.lines);
    state.slowPrice = 0;
    await settle(3200);
    await noToast();
    const pays = calls('till/pay').length;
    await tap('[data-act="pay-card"]', 1500);
    v = await look();
    check('Card again: a PIN afresh, on a screen that names both: $7.00 off, so the sale is $18.00',
      v.view === 'discountok' && /\$7\.00 off, so the sale is \$18\.00\./.test(v.lede) && v.warn === 'This exceeds the 20% discount threshold on 2 things: 7 Wonders (25% off) and Riftbound Radiance (40% off). A PIN says yes to that.' && calls('till/pay').length === pays, { view: v.view, lede: v.lede, warn: v.warn });
    await tap('[data-act="back"]');
  } finally {
    VARIANTS[5026].price = 10500;
    VARIANTS[5013].price = 1100;
    state.slowPrice = 0;
  }
  await page.evaluate(() => document.querySelector('lair-till').nextSale());
  await settle(300);
});

/* ---------- 12. A scan while the till is asking ---------- */
await step('12', async () => {
  await tap('[data-act="quick"]').catch(() => {});
  await scan(CODE.barrage, 1300);
  await noToast();
  await tap('[data-act="discount"] >> nth=0');
  await type('50');
  v = await look();
  check('$50 off Barrage asks', asking(v, ['Barrage: $50.00 off, so $40.00 (60% off what it was)']), v);
  const lines = v.lines.length;
  await scan(CODE.booster);
  v = await look();
  check('a barcode scanned while it asks: the till wants its answer first, and nothing is added', v.view === 'discountover' && v.toast === 'Say yes or no to the discount first.' && v.lines.length === lines, { view: v.view, toast: v.toast, lines: v.lines.length });
  await noToast();
  await tap('[data-act="over-no"]');
  await tap('[data-act="back"]');
});

check('the till: no console errors', page.errors.length === 0, page.errors);
check('the team heard nothing through all of it', alerts.length === 0, alerts);
await ctx.close();
m.mockState.sectionSettings = null;
const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed (screenshots in ${process.env.OUT})`);
await browser.close();
server.close?.();
process.exit(fail ? 1 : 0);

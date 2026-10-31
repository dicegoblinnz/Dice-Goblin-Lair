// Round 26 (1 Nov 2026), the staff page's Warhammer tab on the theme mock (contract v26-gw-pad), with the real Lair app
// in this process (node:sqlite) and a pretend Shopify behind it. The owner picks GW's real order pad, it's read in the
// browser (SheetJS, served here from its npm copy so its integrity hash is checked), sent a part at a time, the shop is
// read, the plan shows what changes, and Update the shop runs to the end with a progress bar. A helper never sees the
// tab. A release still hidden shows with its on-sale day, which can be changed. No sideways scroll at 320, 390 and 1280,
// no console errors, axe on the tab.
// Usage: DG_THEME=/path/to/theme PAD=/path/to/pad.xlsx SHEETJS=/path/to/xlsx.mini.min.js [AXE=/path/to/axe.min.js]
//        [PORT=4991] [OUT=dir] node tools/qa/round26/warhammer-tab.mjs
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round26-warhammer');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, watch } = lib;
const { Lair } = await import('../../../src/lair.js');
const { rulesFromSettings, DEFAULT_HOURS, STAFF_PERMS } = await import('../../../src/core.js');
const PORT = Number(process.env.PORT || 4991);
const BASE = `http://localhost:${PORT}`;
const PAD = process.env.PAD;
const SHEETJS = process.env.SHEETJS;
if (!PAD || !fs.existsSync(PAD) || !SHEETJS || !fs.existsSync(SHEETJS)) {
  console.error('Set PAD to GW\'s order pad (.xlsx) and SHEETJS to xlsx.mini.min.js (npm pack xlsx@0.18.5).');
  process.exit(2);
}
const OWNER = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const HELPER = { id: 7002, first_name: 'Ana', name: 'Ana Helper', email: 'ana@example.com', phone: '', tags: [] };

/* ---------------- the Lair app, in this process, with a pretend Shopify ---------------- */
const db = new DatabaseSync(':memory:');
const sql = {
  exec(q, ...b) {
    const st = db.prepare(q);
    if (/^\s*(select|with)/i.test(q)) {
      const rows = st.all(...b);
      return { toArray: () => rows, one: () => rows[0] };
    }
    st.run(...b);
    return { toArray: () => [], one: () => undefined };
  },
};
const lair = new Lair({ storage: { sql, get: async () => null, put: async () => {} }, waitUntil: () => {} },
  { CURRENCY: 'NZD', GW_LOCATION_ID: '72250359911', GW_POS_PUBLICATION_ID: '129866989671' });
lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }], []);
lair.rulesLoadedAt = Date.now() + 365 * 24 * 3600_000;
Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
lair.shopify.graphql = async () => {
  throw new Error('No Shopify in this check');
};
lair.shopify.customerTags = async (id) => (String(id) === String(OWNER.id) ? ['staff'] : []);
lair.sql.exec("INSERT INTO staff_helpers (customer_id, perms, status, created_at) VALUES (?, ?, 'active', ?)", String(HELPER.id), JSON.stringify(STAFF_PERMS), Date.now());
let nextId = 5000;
const products = new Map();
const variants = new Map();
const shopCalls = [];
function addProduct(p, list) {
  const id = `gid://shopify/Product/${(nextId += 1)}`;
  products.set(id, { id, ...p, tags: p.tags || [], variants: [] });
  for (const v of list) {
    const vid = `gid://shopify/ProductVariant/${(nextId += 1)}`;
    variants.set(vid, { id: vid, productId: id, ...v });
    products.get(id).variants.push(vid);
  }
  return id;
}
// the live shop: one GW kit at an old price, one off the pad
addProduct({ title: 'Space Marines: Bladeguard Veterans', status: 'ACTIVE', vendor: 'Games Workshop' }, [{ sku: '99120101284', price: '120.00', cost: '72.58', barcode: '5011921138630', policy: 'CONTINUE', pack: 1 }]);
addProduct({ title: 'A Kit GW Stopped Making', status: 'ACTIVE', vendor: 'Games Workshop' }, [{ sku: '99120109999', price: '60.00', cost: '30.00', barcode: '', policy: 'CONTINUE', pack: 1 }]);
lair.shopify.lastCost = null;
lair.shopify.gwShopPage = async (after) => {
  const all = [...variants.values()].filter((v) => products.get(v.productId).vendor === 'Games Workshop');
  const start = after ? Number(after) : 0;
  const slice = all.slice(start, start + 100);
  return {
    variants: slice.map((v) => {
      const p = products.get(v.productId);
      return { ...v, productTitle: p.title, status: p.status, tags: p.tags, variants: p.variants.length, release: p.release || null };
    }),
    next: start + 100 < all.length ? String(start + 100) : null,
  };
};
lair.shopify.gwUpdate = async (groups) => groups.map((g) => {
  for (const input of g.variants) Object.assign(variants.get(input.id), input.price ? { price: input.price } : {}, input.inventoryPolicy ? { policy: input.inventoryPolicy } : {});
  return { productId: g.productId };
});
lair.shopify.gwCreate = async (list) => {
  shopCalls.push(['create', list.length]);
  await new Promise((r) => setTimeout(r, 15));
  return list.map((item) => {
    const id = addProduct({ title: item.input.title, status: item.input.status, vendor: 'Games Workshop', tags: item.input.tags }, item.input.variants.map((v) => ({ sku: v.sku, price: v.price, policy: v.inventoryPolicy, pack: 1 })));
    return { codes: item.codes, productId: id, range: item.range || null, published: true };
  });
};
lair.shopify.gwAddVariants = async (productId, list) => list.map((v) => {
  const vid = `gid://shopify/ProductVariant/${(nextId += 1)}`;
  variants.set(vid, { id: vid, productId, sku: v.sku, price: v.price, policy: v.inventoryPolicy, pack: 6 });
  products.get(productId).variants.push(vid);
  return { codes: [v.sku], productId };
});
lair.shopify.gwPublish = async (ids) => ids.map((id) => ({ productId: id }));
lair.shopify.gwFindSkus = async () => new Map();
lair.shopify.gwActivate = async (ids) => ids.map((id) => ({ productId: id }));

/* ---------------- the theme mock, live, with /apps/liar going to the Lair above ---------------- */
m.globalSettings.lair_mode = 'live';
const API = '/apps/liar';
const lairCalls = [];
m.mockState.before = async (req, res, url) => {
  if (!url.pathname.startsWith(`${API}/`)) return false;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const route = url.pathname.slice(API.length);
  lairCalls.push(`${req.method} ${route}`);
  const response = await lair.fetch(new Request(`https://lair.test${route}${url.search}`, {
    method: req.method,
    headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': m.mockState.customer ? String(m.mockState.customer.id) : '' },
    body: req.method === 'POST' ? raw || '{}' : undefined,
  }));
  res.writeHead(response.status, { 'Content-Type': 'application/json' });
  res.end(await response.text());
  return true;
};
const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const VIEWPORTS = { small: { width: 320, height: 640 }, phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };

async function open(size, who) {
  const phone = size !== 'desktop';
  const ctx = await browser.newContext({ viewport: VIEWPORTS[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  // SheetJS from its npm copy (this machine can't reach the CDN); the page still checks its integrity hash
  await ctx.route('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.mini.min.js', (route) => route.fulfill({
    status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(SHEETJS),
  }));
  const page = watch(await ctx.newPage());
  m.mockState.customer = who;
  await page.goto(`${BASE}/pages/lair-staff`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('.staff-tabs [data-tab]', { timeout: 20000 });
  return { ctx, page };
}
const tabState = (page) => page.evaluate(() => {
  const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const el = document.querySelector('staff-warhammer');
  return {
    kinds: [...document.querySelectorAll('.wh-kind')].map((k) => f(k.querySelector('.wh-kind__head')?.textContent)),
    progress: f(document.querySelector('[data-wh-progress]')?.textContent),
    message: f(el?.querySelector('.form-message')?.textContent),
    button: f(el?.querySelector('[data-wh-ask], [data-wh-apply]')?.textContent),
    last: f(el?.querySelector('.wh-last')?.textContent),
    error: f(el?.querySelector('.field__error')?.textContent),
  };
});

{
  // a helper with every permission a helper can have: no Warhammer tab
  const { ctx, page } = await open('phone', HELPER);
  const tabs = await page.$$eval('.staff-tabs [data-tab]', (els) => els.map((e) => e.dataset.tab));
  check('a helper has no Warhammer tab', !tabs.includes('warhammer') && !(await page.$('staff-warhammer')), tabs);
  await ctx.close();
}

{
  const tag = '[phone]';
  const { ctx, page } = await open('phone', OWNER);
  const tabs = await page.$$eval('.staff-tabs [data-tab]', (els) => els.map((e) => e.dataset.tab));
  check(`${tag} the owner has a Warhammer tab, before Team`, tabs.indexOf('warhammer') > -1 && tabs.indexOf('warhammer') === tabs.indexOf('team') - 1, tabs);
  await page.click('[data-tab="warhammer"]');
  await page.waitForSelector('[data-wh-pad]', { timeout: 10000 });
  await settle(page);
  let st = await tabState(page);
  check(`${tag} no pad yet`, st.last === 'No order pad yet.', st);
  await shot(page, 'phone-1-empty', 'staff-warhammer');
  // Check the pad with no file: says so
  await page.click('[data-wh-pad] button[type="submit"]');
  st = await tabState(page);
  check(`${tag} no file: says to pick GW's pad`, st.error === 'Pick GW’s order pad first: the .xlsx file from GW’s trade site.', st);
  // the real pad
  await page.setInputFiles('#wh-file', PAD);
  const t0 = Date.now();
  await page.click('[data-wh-pad] button[type="submit"]');
  await page.waitForSelector('[data-wh-progress]', { timeout: 10000 });
  await shot(page, 'phone-2-sending', 'staff-warhammer');
  await page.waitForSelector('.wh-kinds', { timeout: 120000 });
  const took = Date.now() - t0;
  st = await tabState(page);
  const pads = lairCalls.filter((c) => c === 'POST /gw/pad').length;
  check(`${tag} the pad went in a part at a time (60 rows each: 36 parts), then the shop was read and the plan made`,
    pads === 36 && lairCalls.includes('POST /gw/shop') && lairCalls.includes('POST /gw/plan'), { pads, took });
  check(`${tag} what changes: 1,627 new products, 470 paint colours, 1 change, 1 to stop selling`,
    JSON.stringify(st.kinds) === JSON.stringify([
      '1,627 New products On the till only until each has GW’s picture.',
      '470 Paint colours Each paint range is one product, a colour an option.',
      '1 Changes Prices, costs, barcodes, pack sizes and release dates.',
      '1 Stop selling at 0 Off the pad: what’s on the shelf still sells.',
    ]), st.kinds);
  check(`${tag} the last pad: Mon 26 Oct, 2,098 lines`, /^Last pad: .*26 Oct.*, 2,098 lines/.test(st.last), st.last);
  check(`${tag} Update the shop`, st.button === 'Update the shop', st);
  await shot(page, 'phone-3-plan', 'staff-warhammer');
  // the lines: 50, then Show more
  await page.click('[data-wh-open="create"]');
  await page.waitForSelector('.wh-kind--create .wh-line', { timeout: 10000 });
  let lines = await page.$$eval('.wh-kind--create .wh-line', (els) => els.length);
  check(`${tag} New products: 50 lines, then Show more`, lines === 50 && Boolean(await page.$('[data-wh-more="create"]')), lines);
  await page.click('[data-wh-more="create"]');
  await page.waitForFunction(() => document.querySelectorAll('.wh-kind--create .wh-line').length === 100, null, { timeout: 10000 });
  lines = await page.$$eval('.wh-kind--create .wh-line', (els) => els.length);
  check(`${tag} Show more: 100 lines`, lines === 100, lines);
  const sample = await page.$$eval('.wh-kind--create .wh-line', (els) => els.slice(0, 3).map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  check(`${tag} a new product's line: its name, code, game and price`, sample.every((s) => /\d{11} · .+ · \$\d/.test(s)), sample);
  await page.click('[data-wh-open="create"]');
  await page.click('[data-wh-open="update"]');
  await page.waitForSelector('.wh-kind--update .wh-line', { timeout: 10000 });
  const change = flat(await page.$eval('.wh-kind--update .wh-line', (e) => e.textContent));
  check(`${tag} the change in words: price $120 → $128`, change.includes('Space Marines: Bladeguard Veterans') && change.includes('Price $120 → $128'), change);
  await page.click('[data-wh-open="update"]');
  check(`${tag} no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  await axe(page, `${tag} the Warhammer tab with its plan`, 'staff-warhammer');
  // update the shop: asks first, then runs to the end
  await page.click('[data-wh-ask]');
  const ask = flat(await page.$eval('.wh-confirm', (e) => e.textContent));
  check(`${tag} asks first, saying what it does`, ask.startsWith('Update the shop? This adds 1,627 products, adds 470 paint colours, changes 1 line and stops 1 line selling at 0.'), ask);
  await page.click('[data-wh-apply]');
  await page.waitForSelector('[data-wh-progress] progress[max]', { timeout: 10000 });
  await settle(page, 1500);
  await shot(page, 'phone-4-updating', 'staff-warhammer');
  const mid = await tabState(page);
  check(`${tag} progress while it updates: "Updating the shop: N of 2,099 done"`, /^Updating the shop: [\d,]+ of 2,099 done/.test(mid.progress), mid.progress);
  await page.waitForFunction(() => /up to date/.test(document.querySelector('staff-warhammer .form-message')?.textContent || ''), null, { timeout: 600000 });
  st = await tabState(page);
  check(`${tag} done: up to date with the pad`, /^The shop is up to date with the .*26 Oct pad\.$/.test(st.message), st.message);
  const gw = [...products.values()].filter((p) => p.vendor === 'Games Workshop');
  const ranges = gw.filter((p) => /^Warhammer (Colour|Pro) \w+ Paints$/.test(p.title));
  check(`${tag} Shopify has 1,627 new products and 8 paint range products (470 colours)`,
    gw.length === 2 + 1627 + 8 && ranges.length === 8 && ranges.reduce((a, p) => a + p.variants.length, 0) === 470, { gw: gw.length, ranges: ranges.map((r) => `${r.title} ${r.variants.length}`) });
  const skus = [...variants.values()].map((v) => v.sku);
  check(`${tag} nothing made twice`, skus.length === new Set(skus).size, skus.length - new Set(skus).size);
  await shot(page, 'phone-5-done', 'staff-warhammer');
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await ctx.close();
}

// a release still hidden (from a later pad), with its on-sale day
const RELEASE = '2099-01-10';
lair.sql.exec('INSERT INTO gw_releases (code, product_id, title, release, on_sale_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  '99120199001', 'gid://shopify/Product/1', 'Combat Patrol: Test Marines', RELEASE, lair.gwOnSaleAt('2099-01-03'), Date.now());

for (const size of ['small', 'desktop']) {
  const tag = `[${size}]`;
  const { ctx, page } = await open(size, OWNER);
  await page.click('[data-tab="warhammer"]');
  await page.waitForSelector('.wh-kinds', { timeout: 10000 });
  await settle(page);
  const rel = flat(await page.$eval('[aria-labelledby="wh-rel-title"]', (e) => e.textContent));
  // (the small screen changes it to Thursday 8 January, so the desktop shows that)
  const onSale = size === 'small' ? '10am Sat 3 Jan' : '10am Thu 8 Jan';
  check(`${tag} a hidden release, with its on-sale day`, rel.includes('Combat Patrol: Test Marines') && rel.includes(`released Sat 10 Jan · on sale at the till from ${onSale}`), rel);
  if (size === 'small') {
    await page.click('[data-wh-release-edit="99120199001"]');
    await page.fill('#wh-rel-99120199001', '2099-01-08');
    await page.click('[data-wh-release] button[type="submit"]');
    await page.waitForFunction(() => /10am Thu 8 Jan/.test(document.querySelector('[aria-labelledby="wh-rel-title"]')?.textContent || ''), null, { timeout: 10000 });
    check(`${tag} the on-sale day changed`, true);
  }
  check(`${tag} no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  await shot(page, `${size}-6-tab`, 'staff-warhammer');
  await axe(page, `${tag} the Warhammer tab`, 'staff-warhammer');
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await ctx.close();
}

await browser.close();
server.close();
const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed. Screenshots in ${process.env.OUT}`);
process.exit(fail ? 1 : 0);

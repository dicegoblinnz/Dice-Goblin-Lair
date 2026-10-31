// Round 27 (31 Oct 2026), the Warhammer tab's other views on the theme mock (contract v27-gw-week), with the real Lair
// app in this process (node:sqlite) and a pretend Shopify behind it: This week's order (the next order so far, the order
// that went last with its lines to paste, packs for the shelf, GW couldn't supply, refunds to do, week by week), When the
// box comes (fill in from the order, scan, change a count, kept while the page reloads, added to stock once, who's ready)
// and Order dates (skip a week, give one its own dates). The tab opens on This week's order once a pad's in. No
// sideways scroll at 320, 390 and 1280, no console errors, axe on each view.
// Usage: DG_THEME=/path/to/theme [AXE=/path/to/axe.min.js] [PORT=4992] [OUT=dir] node tools/qa/round27/warhammer-week.mjs
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round27-warhammer');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, watch } = lib;
const { Lair } = await import('../../../src/lair.js');
const { LairTime, rulesFromSettings, DEFAULT_HOURS, STAFF_PERMS } = await import('../../../src/core.js');
const PORT = Number(process.env.PORT || 4992);
const BASE = `http://localhost:${PORT}`;
const OWNER = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const HELPER = { id: 7002, first_name: 'Ana', name: 'Ana Helper', email: 'ana@example.com', phone: '', tags: [] };
const time = new LairTime('Pacific/Auckland');
const today = time.key(Date.now());
const addDays = (key, n) => new Date(Date.UTC(...key.split('-').map((x, i) => (i === 1 ? x - 1 : +x))) + n * 864e5).toISOString().slice(0, 10);
const weekday = (key) => new Date(`${key}T00:00:00Z`).getUTCDay() || 7;
const thisMonday = addDays(today, 1 - weekday(today));
// the week before's order went on its Tuesday; orders now are for the next Monday (or today's, on a Monday)
const lastCutoff = weekday(today) === 1 ? addDays(today, -7) : thisMonday;
const nextCutoff = weekday(today) === 1 ? today : addDays(thisMonday, 7);

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
const pending = [];
const lair = new Lair({ storage: { sql, get: async () => null, put: async () => {} }, waitUntil: (p) => pending.push(p) }, {
  CURRENCY: 'NZD', GW_LOCATION_ID: '72250359911', GW_POS_PUBLICATION_ID: '129866989671', SHOP: 'ep0qiq-rp.myshopify.com',
  RESEND_API_KEY: 'test', FROM_EMAIL: 'gobgob@example.com', STAFF_EMAIL: 'staff@example.com',
});
const drain = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};
lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }], []);
lair.rulesLoadedAt = Date.now() + 365 * 24 * 3600_000;
Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
lair.shopify.graphql = async () => {
  throw new Error('No Shopify in this check');
};
lair.shopify.customerTags = async (id) => (String(id) === String(OWNER.id) ? ['staff'] : []);
lair.shopify.orderSpend = async () => null;
lair.shopify.orderBuyer = async () => null;
lair.shopify.customerEmail = async () => null;
lair.sql.exec("INSERT INTO staff_helpers (customer_id, perms, status, created_at) VALUES (?, ?, 'active', ?)", String(HELPER.id), JSON.stringify(STAFF_PERMS), Date.now());
const mails = [];
lair.mail = async (message) => {
  mails.push(message);
  return { ok: true, attempted: true, status: 200 };
};
lair.mailMany = async (messages) => {
  mails.push(...messages);
  return { ok: true, attempted: true, status: 200, sent: messages.length };
};
const V = (n) => `gid://shopify/ProductVariant/${n}`;
const KIT = V(501);
const PAINT = V(502);
const SOON = V(503);
const NULN = V(505);
const stock = new Map([
  [KIT, { code: '99120101386', title: 'Combat Patrol: Space Marines', available: 0, policy: 'CONTINUE', pack: 1, release: '', price: '210.00', tracked: true, barcode: '5011921160001' }],
  [PAINT, { code: '99189950001', title: 'Base: Abaddon Black (18ml)', available: 0, policy: 'CONTINUE', pack: 6, release: '', price: '8.50', tracked: true, barcode: '5011921150001' }],
  [SOON, { code: '99120102999', title: 'Kill Team: Starter Set', available: 0, policy: 'CONTINUE', pack: 1, release: '', price: '180.00', tracked: true, barcode: '5011921170001' }],
  [NULN, { code: '99189953083', title: 'Shade: Nuln Oil (24ml)', available: 2, policy: 'CONTINUE', pack: 6, release: '', price: '11.60', tracked: true, barcode: '5011921100009' }],
]);
// 30 more codes, so a delivery can be more than one part (25 lines a part)
for (let i = 1; i <= 30; i += 1) {
  stock.set(V(800 + i), { code: String(99120200000 + i), title: `Test Kit ${String(i).padStart(2, '0')}`, available: 0, policy: 'CONTINUE', pack: 1, release: '', price: '50.00', tracked: true, barcode: String(5011921200000 + i) });
}
const orders = new Map();
let schedule = { overrides: {}, digest: null };
const adjustKeys = new Map();
const adjustCalls = [];
const itemOf = (v) => `gid://shopify/InventoryItem/${Number(v.split('/').pop()) + 1000}`;
lair.shopify.gwStock = async (ids) => ({ variants: new Map(ids.filter((id) => stock.has(id)).map((id) => [id, { id, ...stock.get(id) }])), overrides: schedule.overrides });
lair.shopify.gwOrderInfo = async (id) => orders.get(id)?.info || null;
lair.shopify.orderGiftBuyer = async (id) => {
  const info = orders.get(id)?.info;
  return info ? { name: info.name, email: info.email || '', firstName: info.first || '' } : null;
};
lair.shopify.gwState = async (ids) => {
  const state = new Map();
  for (const id of ids) {
    if (stock.has(id)) state.set(id, { available: stock.get(id).available, cancelledAt: null, currentQuantity: NaN });
    else if (orders.has(id)) state.set(id, { available: NaN, cancelledAt: null, currentQuantity: NaN });
    else {
      const o = [...orders.values()].find((x) => x.lines.has(id));
      if (o) state.set(id, { available: NaN, cancelledAt: null, currentQuantity: o.lines.get(id) });
    }
  }
  return state;
};
lair.shopify.gwMarkOrder = async () => true;
lair.shopify.gwBelowZero = async () => ({ variants: [], overrides: schedule.overrides });
lair.shopify.gwScheduleRead = async () => ({ shopId: 'gid://shopify/Shop/1', overrides: JSON.parse(JSON.stringify(schedule.overrides)), digest: schedule.digest });
lair.shopify.gwScheduleSave = async (shopId, value, digest) => {
  if (digest !== schedule.digest) return { stale: true };
  schedule = { overrides: JSON.parse(value).overrides, digest: `d${Date.now()}` };
  return { ok: true };
};
lair.shopify.gwReceiveLookup = async (codes) => new Map([...stock].filter(([, v]) => codes.includes(v.code)).map(([id, v]) => [v.code, { variantId: id, inventoryItemId: itemOf(id), tracked: true, title: v.title }]));
// part 2 of a delivery Shopify doesn't answer (how many times in a row)
let failPart2 = 0;
lair.shopify.gwAdjust = async (changes, locationId, key) => {
  adjustCalls.push(key);
  if (failPart2 > 0 && /-2$/.test(key)) {
    failPart2 -= 1;
    throw new Error('The network connection was lost.');
  }
  if (adjustKeys.has(key)) return { ok: true };
  for (const c of changes) stock.get([...stock.keys()].find((id) => itemOf(id) === c.inventoryItemId)).available += c.delta;
  adjustKeys.set(key, true);
  return { ok: true };
};
// the latest pad (round 26) and its import done, so the tab opens on This week's order
const pad = (v, mrp) => lair.sql.exec(
  `INSERT INTO gw_pad (code, desc, title, system, race, ss, barcode, pack, trade, mrp, release, min_stock, type, tags, range_key, colour, part)
   VALUES (?, ?, ?, '', '', '', ?, ?, 0, ?, NULL, 0, 'War Game', '[]', NULL, NULL, 1)`, stock.get(v).code, stock.get(v).title, stock.get(v).title, stock.get(v).barcode, stock.get(v).pack, mrp,
);
pad(KIT, 21000);
pad(PAINT, 850);
pad(SOON, 18000);
pad(NULN, 1160);
for (let i = 1; i <= 30; i += 1) pad(V(800 + i), 5000);
lair.sql.exec("INSERT INTO meta (key, value) VALUES ('gw-pad', ?)", JSON.stringify({ upload: 'qa', date: '2026-10-26', part: 1, parts: 1, rows: 4, skipped: 0, at: Date.now(), complete: true }));
lair.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('gw-list', ?)", addDays(lastCutoff, -7));

/** A paid order, made `day` (Auckland, at noon) */
let orderNo = 2040;
async function pay(who, lines, how, day) {
  orderNo += 1;
  const id = `gid://shopify/Order/${orderNo}`;
  for (const [v, q] of lines) stock.get(v).available -= q;
  orders.set(id, {
    info: { id, name: `#${orderNo}`, email: who?.email || null, first: who?.first || '', createdAt: new Date(time.at(day, 12 * 60)).toISOString(),
      shippingLine: how === 'counter' ? null : how === 'ship' ? { title: 'NZ Post tracked', deliveryCategory: 'shipping' } : { title: 'Collect from the Lair', deliveryCategory: 'pick-up' } },
    lines: new Map(lines.map(([v], i) => [`gid://shopify/LineItem/${orderNo * 10 + i}`, lines[i][1]])),
  });
  const webhook = {
    id: orderNo, admin_graphql_api_id: id, name: `#${orderNo}`, source_name: how === 'counter' ? 'pos' : 'web',
    line_items: lines.map(([v, q], i) => ({ id: orderNo * 10 + i, variant_id: Number(v.split('/').pop()), sku: stock.get(v).code, vendor: 'Games Workshop', name: stock.get(v).title, title: stock.get(v).title, quantity: q, price: stock.get(v).price })),
  };
  const res = await lair.fetch(new Request('https://lair.test/internal/orders-paid', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body: JSON.stringify(webhook) }));
  if (res.status !== 200) throw new Error(`orders/paid ${res.status}`);
  await drain();
}
const KAI = { email: 'kai@example.com', first: 'Kai' };
const MIA = { email: 'mia@example.com', first: 'Mia' };
const LEO = { email: 'leo@example.com', first: 'Leo' };
const ZOE = { email: 'zoe@example.com', first: 'Zoe' };
const before = addDays(lastCutoff, -2);
await pay(KAI, [[KIT, 1], [PAINT, 2]], 'pickup', before);
await pay(MIA, [[PAINT, 1]], 'ship', before);
await pay(LEO, [[SOON, 1]], 'counter', before);
// the last order's list went (its Tuesday, 6:05am)
await lair.gwOrderList(lair.rulesCache, time.at(addDays(lastCutoff, 1), 6 * 60 + 5));
await drain();
check('the last order\'s list went, so the tab has one to show', lair.sql.exec("SELECT value FROM meta WHERE key = 'gw-list-sent'").toArray().length === 1);
// this week so far
await pay(ZOE, [[KIT, 1]], 'pickup', today);

/* ---------------- the theme mock, live, with /apps/liar going to the Lair above ---------------- */
m.globalSettings.lair_mode = 'live';
const API = '/apps/liar';
m.mockState.before = async (req, res, url) => {
  if (!url.pathname.startsWith(`${API}/`)) return false;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const route = url.pathname.slice(API.length);
  const response = await lair.fetch(new Request(`https://lair.test${route}${url.search}`, {
    method: req.method,
    headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': m.mockState.customer ? String(m.mockState.customer.id) : '' },
    body: req.method === 'POST' ? raw || '{}' : undefined,
  }));
  await drain();
  res.writeHead(response.status, { 'Content-Type': 'application/json' });
  res.end(await response.text());
  return true;
};
const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 300) => page.waitForTimeout(ms);
const outside = [];
const VIEWPORTS = { small: { width: 320, height: 640 }, phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
async function open(size, who) {
  const phone = size !== 'desktop';
  const ctx = await browser.newContext({ viewport: VIEWPORTS[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await ctx.route(/^https?:\/\/(?!localhost)/, (route) => {
    outside.push(route.request().url());
    return route.abort();
  });
  const page = watch(await ctx.newPage());
  m.mockState.customer = who;
  await page.goto(`${BASE}/pages/lair-staff`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('.staff-tabs [data-tab]', { timeout: 20000 });
  return { ctx, page };
}
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
const day = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${key}T00:00:00Z`)).replace(',', '');

{
  const tag = '[phone]';
  const { ctx, page } = await open('phone', OWNER);
  await page.click('[data-tab="warhammer"]');
  await page.waitForSelector('staff-gw-week .wh-step', { timeout: 15000 });
  await settle(page);
  const pressed = await page.$eval('[data-wh-view][aria-pressed="true"]', (e) => e.dataset.whView);
  check(`${tag} with a pad in and the shop up to date, the tab opens on This week's order`, pressed === 'week' && await page.$eval('[data-wh-body]', (e) => e.hidden), pressed);
  const sent = await text(page, '[aria-labelledby="gw-sent-title"]');
  check(`${tag} the order that went last: its codes, packs and what's still to come`,
    sent.includes(`Order for ${day(lastCutoff)}`) && /Combat Patrol: Space Marines.*99120101386 · 1 for customers · 1 still to come/.test(sent)
    && /Base: Abaddon Black \(18ml\).*99189950001 · 3 for customers: 1 pack of 6 · 3 still to come/.test(sent), sent);
  const paste = await page.$eval('#gw-paste', (e) => e.value);
  check(`${tag} the lines to paste into GW's trade site`, paste === '99120101386,1\n99120102999,1\n99189950001,1', paste);
  await page.click('[data-gw-copy]');
  await settle(page);
  const copied = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `(${e.message})`);
  check(`${tag} Copy the lines puts them on the clipboard`, copied === paste && (await text(page, '[data-gw-copy]')) === 'Copied', copied);
  const csvHref = await page.$eval('[aria-labelledby="gw-sent-title"] a[download]', (a) => [a.getAttribute('download'), decodeURIComponent(a.href.split(',').slice(1).join(','))]);
  check(`${tag} the CSV to download`, csvHref[0] === `gw-order-${lastCutoff}.csv` && csvHref[1] === 'Product code,Quantity\n99120101386,1\n99120102999,1\n99189950001,1\n', csvHref);
  const next = await text(page, '[aria-labelledby="gw-open-title"]');
  check(`${tag} the next order so far: Zoe's kit`, next.includes(`Next order: ${day(nextCutoff)}`) && next.includes('99120101386 · 1 for customers'), next);
  await shot(page, 'phone-1-week', 'staff-warhammer');
  // packs for the shelf: find by name, one match, two packs on the next order
  await page.fill('#gw-find', 'nuln');
  await page.click('[data-gw-find] button[type="submit"]');
  await page.waitForSelector('#gw-top-packs', { timeout: 10000 });
  const focus = await page.evaluate(() => document.activeElement?.id);
  check(`${tag} one match: straight to how many packs`, focus === 'gw-top-packs', focus);
  await page.fill('#gw-top-packs', '2');
  await page.check(`[data-gw-top] input[name="cutoff"][value="${nextCutoff}"]`);
  await page.click('[data-gw-top] button[type="submit"]');
  await page.waitForFunction(() => /2 packs of 6 for the shelf/.test(document.querySelector('[aria-labelledby="gw-open-title"]')?.textContent || ''), null, { timeout: 10000 });
  check(`${tag} added for the shelf on the next order`, true);
  // the same code again: its 2 packs show, and the number sets them (it doesn't add)
  await page.fill('#gw-find', 'nuln');
  await page.click('[data-gw-find] button[type="submit"]');
  await page.waitForSelector('#gw-top-packs', { timeout: 10000 });
  await page.check(`[data-gw-top] input[name="cutoff"][value="${nextCutoff}"]`);
  await settle(page);
  check(`${tag} a code already on the order: its packs show, and the button says Change`, (await page.$eval('#gw-top-packs', (e) => e.value)) === '2'
    && (await text(page, '[data-gw-top] button[type="submit"]')) === 'Change the shelf packs' && (await text(page, '#gw-top-now')).startsWith('2 packs are on that order already'));
  await page.fill('#gw-top-packs', '3');
  await page.click('[data-gw-top] button[type="submit"]');
  await page.waitForFunction(() => /3 packs of 6 for the shelf/.test(document.querySelector('[aria-labelledby="gw-open-title"]')?.textContent || ''), null, { timeout: 10000 });
  check(`${tag} changed to 3 packs, not added to`, !/5 packs/.test(await text(page, '[aria-labelledby="gw-open-title"]')));
  // and two more on the order to paste: the lines change
  await page.fill('#gw-find', '5011921150001');
  await page.click('[data-gw-find] button[type="submit"]');
  await page.waitForSelector('#gw-top-packs', { timeout: 10000 });
  await page.fill('#gw-top-packs', '2');
  await page.check(`[data-gw-top] input[name="cutoff"][value="${lastCutoff}"]`);
  await page.click('[data-gw-top] button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#gw-paste')?.value.includes('99189950001,3'), null, { timeout: 10000 });
  check(`${tag} packs added to the order to paste: 3 packs of the paint now`, (await page.$eval('#gw-paste', (e) => e.value)) === '99120101386,1\n99120102999,1\n99189950001,3');
  // a name that matches nothing
  await page.fill('#gw-find', 'zzzz');
  await page.click('[data-gw-find] button[type="submit"]');
  await page.waitForFunction(() => /Nothing on the order pad matches that/.test(document.querySelector('.wh-top')?.textContent || ''), null, { timeout: 10000 });
  check(`${tag} nothing found says so`, true);
  // GW couldn't supply the kit: refund it, and Kai's told
  await page.click('[data-gw-gone="99120101386"]');
  await page.waitForSelector('[data-gw-gone-form]', { timeout: 5000 });
  check(`${tag} GW couldn't supply: the choice opens on Order it again`, (await page.evaluate(() => document.activeElement?.value)) === 'again');
  await page.check('[data-gw-gone-form] input[value="refund"]');
  await page.click('[data-gw-gone-form] button[type="submit"]');
  await page.waitForSelector('[aria-labelledby="gw-refunds-title"]', { timeout: 10000 });
  const refunds = await text(page, '[aria-labelledby="gw-refunds-title"]');
  check(`${tag} Refunds to do: Kai's kit, with the order in Shopify`, /#2041: Combat Patrol: Space Marines.*99120101386 · 1 item · \$210/.test(refunds)
    && (await page.$eval('[aria-labelledby="gw-refunds-title"] a', (a) => a.href)) === 'https://admin.shopify.com/store/ep0qiq-rp/orders/2041', refunds);
  check(`${tag} the code shows Refunding`, (await text(page, '[aria-labelledby="gw-sent-title"]')).includes('Combat Patrol: Space Marines Refunding'));
  check(`${tag} Kai heard it's not coming`, mails.some((x) => x.to === 'kai@example.com' && /^Sorry: part of order #2041/.test(x.subject)));
  check(`${tag} the week-by-week table fits a phone`, await page.$eval('.wh-table-wrap', (e) => e.scrollWidth <= e.clientWidth + 1));
  const weeks = await page.$$eval('.wh-table tbody tr', (rows) => rows.map((r) => [...r.children].map((c) => c.textContent.trim())));
  check(`${tag} ordered in, week by week`, JSON.stringify(weeks) === JSON.stringify([[day(nextCutoff), '1 order, 1 item, $210', 'None'], [day(lastCutoff), '2 orders, 4 items, $235.50', '1 order, 1 item, $180']]), weeks);
  check(`${tag} no sideways scroll on This week's order`, (await overflowX(page)) <= 0, await overflowX(page));
  await shot(page, 'phone-2-week-refund', 'staff-warhammer');
  await page.evaluate(() => window.scrollTo(0, 0));
  await axe(page, `${tag} This week's order`, 'staff-warhammer');

  // When the box comes
  await page.click('[data-wh-view="box"]');
  await page.waitForSelector('staff-gw-box .wh-step', { timeout: 10000 });
  const waiting = await text(page, '[aria-labelledby="gw-waiting-title"]');
  check(`${tag} customers are waiting on the paint and the starter set (the kit's being refunded)`, /Base: Abaddon Black.*3 items for 2 orders/.test(waiting) && /Kill Team: Starter Set.*1 item for 1 order/.test(waiting) && !waiting.includes('Combat Patrol'), waiting);
  await page.click('[data-gw-fill]');
  await settle(page);
  let counted = await page.$$eval('[data-gw-units]', (els) => els.map((e) => [e.dataset.gwUnits, e.value]));
  check(`${tag} filled in from the order: what it ordered, the shelf packs too, not what GW couldn't supply`, JSON.stringify(counted) === JSON.stringify([['99189950001', '18'], ['99120102999', '1']]), counted);
  // a scan adds one; a count can be changed
  await page.fill('#gw-scan', '5011921100009');
  await page.press('#gw-scan', 'Enter');
  await page.waitForFunction(() => document.querySelector('[data-gw-units="99189953083"]'), null, { timeout: 10000 });
  await page.fill('#gw-scan', '5011921100009');
  await page.press('#gw-scan', 'Enter');
  await page.waitForFunction(() => document.querySelector('[data-gw-units="99189953083"]')?.value === '2', null, { timeout: 10000 });
  check(`${tag} two scans of the Nuln Oil: 2`, true);
  check(`${tag} the scan box keeps focus for the next scan`, (await page.evaluate(() => document.activeElement?.id)) === 'gw-scan');
  // GW sent a kit after all
  await page.fill('#gw-scan', '5011921160001');
  await page.press('#gw-scan', 'Enter');
  await page.waitForFunction(() => document.querySelector('[data-gw-units="99120101386"]')?.value === '1', null, { timeout: 10000 });
  await page.fill('[data-gw-units="99189950001"]', '12');
  await page.press('[data-gw-units="99189950001"]', 'Tab');
  await settle(page);
  check(`${tag} a changed count: the total follows, the next field keeps focus`, (await text(page, '[data-gw-total]')) === '16 items in 4 lines'
    && (await page.evaluate(() => document.activeElement?.tagName)) !== 'BODY', await text(page, '[data-gw-total]'));
  // the page closed by mistake: the count is still there
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('[data-tab="warhammer"]');
  await page.click('[data-wh-view="box"]');
  await page.waitForSelector('[data-gw-units]', { timeout: 10000 });
  counted = await page.$$eval('[data-gw-units]', (els) => els.map((e) => [e.dataset.gwUnits, e.value]));
  check(`${tag} the count is kept while the page reloads`, counted.length === 4 && counted.find((c) => c[0] === '99189950001')[1] === '12', counted);
  // Start again asks first, and keeping counting keeps it
  await page.click('[data-gw-clear]');
  check(`${tag} Start again asks first`, (await text(page, '#gw-clear-ask')).startsWith('Clear the count?'));
  await page.click('[data-gw-clear-no]');
  check(`${tag} Keep counting: the count's still there, focus back on Start again`, (await page.$$('[data-gw-units]')).length === 4 && (await page.evaluate(() => document.activeElement?.dataset?.gwClear)) !== undefined);
  await shot(page, 'phone-3-box', 'staff-warhammer');
  await page.click('[data-gw-ask]');
  check(`${tag} Add to stock asks first`, (await text(page, '#gw-box-ask')).startsWith('Add 16 items to stock in Shopify?'));
  await page.click('[data-gw-send]');
  await page.waitForSelector('#gw-added-title', { timeout: 15000 });
  await settle(page, 500);
  const added = await text(page, '[aria-labelledby="gw-added-title"]');
  check(`${tag} added: who's ready now`, added.includes('16 items in 4 lines') && added.includes('#2041: 2 × Base: Abaddon Black (18ml)') && added.includes('#2042: 1 × Base: Abaddon Black (18ml) Ready to pack and post')
    && added.includes('#2043: 1 × Kill Team: Starter Set') && added.includes("#2044: 1 × Combat Patrol: Space Marines Zoe collects at the Lair: we've emailed them it's in."), added);
  // (the kit: Kai's sale is still off the count until the refund puts it back, so -1)
  check(`${tag} Shopify added it once`, adjustCalls.length === 1 && stock.get(PAINT).available === 9 && stock.get(NULN).available === 4 && stock.get(KIT).available === -1, { adjustCalls, paint: stock.get(PAINT).available, kit: stock.get(KIT).available });
  check(`${tag} the kit that came went to Zoe, not to Kai's refund`, mails.some((x) => x.to === 'zoe@example.com' && /^It's in/.test(x.subject)) && !mails.some((x) => x.to === 'kai@example.com' && /Combat Patrol/.test(x.text || '') && /^It's in/.test(x.subject)));
  check(`${tag} the count's cleared, and nothing's kept`, !(await page.$('[data-gw-units]')) && (await page.evaluate(() => localStorage.getItem('dg-gw-box'))) === null);
  const receipts = await text(page, '[aria-labelledby="gw-receipts-title"]');
  check(`${tag} added in the last two weeks`, /Today, \d+:\d+[ap]m 16 items in 4 lines · 4 orders ready/.test(receipts), receipts);
  check(`${tag} no sideways scroll on When the box comes`, (await overflowX(page)) <= 0, await overflowX(page));
  await shot(page, 'phone-4-box-added', 'staff-warhammer');
  await page.evaluate(() => window.scrollTo(0, 0));
  await axe(page, `${tag} When the box comes`, 'staff-warhammer');

  // Order dates
  await page.click('[data-wh-view="dates"]');
  await page.waitForSelector('staff-gw-dates .wh-weeks', { timeout: 10000 });
  const first = await text(page, `staff-gw-dates .wh-line:has([data-gw-edit="${nextCutoff}"])`);
  check(`${tag} the next order's week, its usual dates`, first.includes(`Orders by ${day(nextCutoff)} Next order`) && first.includes(`GW ships ${day(addDays(nextCutoff, 3))} · with customers by ${day(addDays(nextCutoff, 17))}`), first);
  await page.click(`[data-gw-edit="${nextCutoff}"]`);
  await page.check(`[data-gw-date="${nextCutoff}"] input[value="skip"]`);
  check(`${tag} Skip says where its orders go`, await page.$eval(`[data-gw-date="${nextCutoff}"] [data-gw-skip-hint]`, (e) => !e.hidden));
  await page.click(`[data-gw-date="${nextCutoff}"] button[type="submit"]`);
  await page.waitForFunction((k) => /Skipped/.test(document.querySelector(`staff-gw-dates .wh-line:has([data-gw-edit="${k}"])`)?.textContent || ''), nextCutoff, { timeout: 10000 });
  check(`${tag} skipped, in the shop's schedule`, schedule.overrides[nextCutoff]?.skip === true, schedule.overrides);
  const later = addDays(nextCutoff, 14);
  await page.click(`[data-gw-edit="${later}"]`);
  await page.check(`[data-gw-date="${later}"] input[value="own"]`);
  await page.fill(`#gw-d-${later}-ships`, addDays(later, 4));
  await page.fill(`#gw-d-${later}-promise`, addDays(later, 21));
  await page.click(`[data-gw-date="${later}"] button[type="submit"]`);
  await page.waitForFunction((k) => /Own dates/.test(document.querySelector(`staff-gw-dates .wh-line:has([data-gw-edit="${k}"])`)?.textContent || ''), later, { timeout: 10000 });
  check(`${tag} a week with its own dates`, JSON.stringify(schedule.overrides[later]) === JSON.stringify({ ships: addDays(later, 4), promise: addDays(later, 21) }), schedule.overrides);
  check(`${tag} focus back on its Change`, (await page.evaluate(() => document.activeElement?.dataset?.gwEdit)) === later);
  check(`${tag} no sideways scroll on Order dates`, (await overflowX(page)) <= 0, await overflowX(page));
  await shot(page, 'phone-5-dates', 'staff-warhammer');
  await page.evaluate(() => window.scrollTo(0, 0));
  await axe(page, `${tag} Order dates`, 'staff-warhammer');
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await ctx.close();
}

{
  const tag = '[two tabs]';
  const { ctx, page } = await open('desktop', OWNER);
  await page.click('[data-tab="warhammer"]');
  await page.click('[data-wh-view="box"]');
  await page.waitForSelector('#gw-scan', { timeout: 10000 });
  // the same count as the last box: Abaddon Black 12, Kill Team 1, Nuln Oil 2, the kit 1
  for (const [code, units] of [['99189950001', 12], ['99120102999', 1], ['99189953083', 2], ['99120101386', 1]]) {
    await page.fill('#gw-scan', code);
    await page.press('#gw-scan', 'Enter');
    await page.waitForSelector(`[data-gw-units="${code}"]`, { timeout: 10000 });
    await page.fill(`[data-gw-units="${code}"]`, String(units));
    await page.press(`[data-gw-units="${code}"]`, 'Tab');
  }
  // a second tab on the same browser has the same count
  const other = watch(await ctx.newPage());
  await other.goto(`${BASE}/pages/lair-staff`, { waitUntil: 'networkidle', timeout: 60000 });
  await other.click('[data-tab="warhammer"]');
  await other.click('[data-wh-view="box"]');
  await other.waitForSelector('[data-gw-units]', { timeout: 10000 });
  check(`${tag} the second tab has the count`, (await other.$$('[data-gw-units]')).length === 4);
  // the first tab sends it: it's the same as the last box, so it asks
  const before = adjustCalls.length;
  await page.click('[data-gw-ask]');
  await page.click('[data-gw-send]');
  await page.waitForSelector('#gw-repeat-ask', { timeout: 10000 });
  check(`${tag} the same counts as the last box: it asks first, nothing added`, /^This looks the same as a delivery added today at \d+:\d\d[ap]m\. Add it to stock again\?/.test(await text(page, '#gw-repeat-ask')) && adjustCalls.length === before, await text(page, '#gw-repeat-ask'));
  await page.click('[data-gw-repeat-no]');
  await settle(page, 600);
  check(`${tag} No, it's in already: the count's cleared, nothing added`, !(await page.$('[data-gw-units]')) && adjustCalls.length === before);
  check(`${tag} the second tab follows: the count's gone there too, and says why`, !(await other.$('[data-gw-units]')) && /The count changed in another tab or window/.test(await text(other, 'staff-gw-box')));
  await other.close();
  check(`${tag} no console errors`, !page.errors.length && !other.errors.length, [...page.errors, ...other.errors]);
  await ctx.close();
}

{
  const tag = '[two parts]';
  const { ctx, page } = await open('desktop', OWNER);
  await page.click('[data-tab="warhammer"]');
  await page.click('[data-wh-view="box"]');
  await page.waitForSelector('#gw-scan', { timeout: 10000 });
  for (let i = 1; i <= 30; i += 1) {
    await page.fill('#gw-scan', String(99120200000 + i));
    await page.press('#gw-scan', 'Enter');
    await page.waitForSelector(`[data-gw-units="${99120200000 + i}"]`, { timeout: 10000 });
  }
  check(`${tag} 30 lines counted`, (await text(page, '[data-gw-total]')) === '30 items in 30 lines');
  // part 1 goes in; Shopify doesn't answer part 2 (three tries)
  const before = adjustCalls.length;
  failPart2 = 3;
  await page.click('[data-gw-ask]');
  await page.click('[data-gw-send]');
  await page.waitForSelector('[data-gw-retry]', { timeout: 30000 });
  const stuck = await text(page, 'staff-gw-box');
  check(`${tag} part 2 not answered: Try again, the count can't be changed, part 1 shown as in`, stuck.includes('Try again') && stuck.includes('Added to stock') && stuck.includes('25 items in 25 lines')
    && (await page.$$eval('[data-gw-units]', (els) => els.every((e) => e.disabled))), stuck.slice(0, 400));
  // the page closed by mistake and opened again: still waiting to try again, what's in so far kept
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('[data-tab="warhammer"]');
  await page.click('[data-wh-view="box"]');
  await page.waitForSelector('[data-gw-retry]', { timeout: 10000 });
  check(`${tag} after a reload: still Try again, part 1 still shown`, (await text(page, 'staff-gw-box')).includes('25 items in 25 lines'));
  await page.click('[data-gw-retry]');
  await page.waitForSelector('#gw-added-title', { timeout: 15000 });
  await settle(page, 500);
  const done = await text(page, '[aria-labelledby="gw-added-title"]');
  const parts = adjustCalls.slice(before);
  const counts = [...stock.entries()].filter(([id]) => Number(id.split('/').pop()) > 800).map(([, v]) => v.available);
  check(`${tag} done: 30 items, each code added once (part 2's key sent again, never twice)`, done.includes('30 items in 30 lines') && counts.every((n) => n === 1)
    && new Set(parts).size === 2 && failPart2 === 0, { done: done.slice(0, 200), parts, counts });
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await ctx.close();
}

for (const size of ['small', 'desktop']) {
  const tag = `[${size}]`;
  const { ctx, page } = await open(size, OWNER);
  await page.click('[data-tab="warhammer"]');
  await page.waitForSelector('staff-gw-week .wh-step', { timeout: 15000 });
  for (const view of ['week', 'box', 'dates', 'pad']) {
    await page.click(`[data-wh-view="${view}"]`);
    await settle(page, 500);
    check(`${tag} ${view}: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
    if (view !== 'pad') await shot(page, `${size}-${view}`, 'staff-warhammer');
  }
  await axe(page, `${tag} the Warhammer tab`, 'staff-warhammer');
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await ctx.close();
}

{
  const { ctx, page } = await open('phone', HELPER);
  const tabs = await page.$$eval('.staff-tabs [data-tab]', (els) => els.map((e) => e.dataset.tab));
  check('a helper has no Warhammer tab', !tabs.includes('warhammer') && !(await page.$('staff-gw-week')), tabs);
  await ctx.close();
}

check('nothing loaded from outside the shop', !outside.length, outside.slice(0, 5));
await browser.close();
server.close();
const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed. Screenshots in ${process.env.OUT}`);
process.exit(fail ? 1 : 0);

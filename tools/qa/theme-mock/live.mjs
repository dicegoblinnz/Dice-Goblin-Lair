// Live-mode browser test: theme pages (mock storefront) talking to the real Lair Worker (wrangler dev on :8787)
// through a stand-in for Shopify's app proxy that signs every request the way Shopify does.
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { serve, mockState, globalSettings } from './render.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const WORKER = 'http://127.0.0.1:8787';
const SECRET = 'hush';
const SHOP = 'ep0qiq-rp.myshopify.com';

globalSettings.lair_mode = 'live';
const API = (globalSettings.lair_api || '/apps/liar').replace(/\/$/, '');
globalSettings.store_phone = '09 555 0123';

mockState.before = async (req, res, url) => {
  if (!url.pathname.startsWith(`${API}/`)) return false;
  const params = new URLSearchParams(url.search);
  params.set('shop', SHOP);
  params.set('logged_in_customer_id', mockState.customer ? String(mockState.customer.id) : '');
  params.set('path_prefix', API);
  params.set('timestamp', String(Math.floor(Date.now() / 1000)));
  const grouped = {};
  for (const [k, v] of params) (grouped[k] ||= []).push(v);
  const message = Object.entries(grouped).map(([k, v]) => `${k}=${v.join(',')}`).sort().join('');
  params.set('signature', createHmac('sha256', SECRET).update(message).digest('hex'));
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const upstream = await fetch(`${WORKER}/proxy/${url.pathname.slice(`${API}/`.length)}?${params}`, {
    method: req.method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9, 23.227.38.2' },
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
  res.end(await upstream.text());
  return true;
};

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

const server = await serve(4178);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
const errors = [];
const apiErrors = [];
const watch = (page, label) => {
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('response', (r) => {
    if (r.url().includes(`${API}/`) && r.status() >= 500) apiErrors.push(`${label}: ${r.status()} ${r.url()}`);
  });
};

/* 1. Anonymous visitor books a table, pays on the day */
const page = await ctx.newPage();
watch(page, 'book');
await page.goto('http://localhost:4178/pages/book-a-table', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
check('pay-now option hidden while the app is not connected to Shopify', await page.locator('[data-pay-now]').isHidden());
await page.click('.date-chip:not([disabled]) >> nth=1');
await page.click('[data-slot]:not([disabled]) >> nth=0');
await page.waitForTimeout(200);
const picked = (await page.textContent('[data-picked]')).replace(/\s+/g, ' ').trim();
await page.fill('#bk-name', 'Live Goblin');
await page.fill('#bk-email', 'live@example.com');
const agree = page.locator('input[name="agree"]');
if (await agree.count()) await agree.check();
await page.click('[data-submit]');
await page.waitForSelector('[data-done]:not([hidden])', { timeout: 5000 }).catch(() => {});
const ticket = (await page.textContent('[data-done]').catch(() => '')).replace(/\s+/g, ' ');
const ref = (ticket.match(/GOB-[A-Z0-9]{4}/) || [])[0];
check('booking saved by the app and a ticket shown', Boolean(ref) && /Booked/.test(ticket), `${ref} · ${picked}`);
check('ticket does not promise an email when email is not set up', /screenshot/i.test(ticket) && !/We emailed/.test(ticket));

/* 2. Second visitor sees those tables taken for the same slot */
const other = await browser.newContext({ viewport: { width: 1280, height: 950 } });
const page2 = await other.newPage();
watch(page2, 'book2');
await page2.goto('http://localhost:4178/pages/book-a-table', { waitUntil: 'networkidle' });
await page2.waitForTimeout(800);
await page2.click('.date-chip:not([disabled]) >> nth=1');
await page2.click('[data-slot]:not([disabled]) >> nth=0');
await page2.waitForTimeout(300);
const takenIds = picked.match(/[A-Z]\d+/g) || [];
const statuses = [];
for (const id of takenIds) statuses.push(await page2.getAttribute(`[data-table="${id}"]`, 'data-status'));
check('another visitor sees the booked tables as taken', statuses.length > 0 && statuses.every((s) => s === 'taken'), `${takenIds.join(',')} → ${statuses.join(',')}`);
const auto = await page2.evaluate(() => document.querySelector('lair-booking').state.tables);
check('auto-pick avoids the taken tables', auto.length > 0 && auto.every((id) => !takenIds.includes(id)), auto.join(','));

/* 3. Same tables, same time from the second visitor: the app refuses */
const api = await page2.evaluate(async (tables) => {
  const store = window.Lair.store;
  const day = store.time.addDays(store.time.today(), 1);
  const slot = store.slots(day).find((s) => s.bookable);
  try {
    await store.backend.createBooking({ kind: 'table', tables, start: slot.start, end: slot.start + 3600000, people: 2, name: 'Sneaky', email: 'sneaky@example.com', pay: 'day' });
    return 'accepted';
  } catch (error) {
    return `${error.status} ${error.message}`;
  }
}, takenIds);
check('double booking is refused by the app', /^409/.test(api), api);

/* 4. A logged-in player lists a GM game: it waits for staff approval */
mockState.customer = { id: 777, first_name: 'Ellie', name: 'Ellie Tane', email: 'ellie@example.com', phone: '', tags: [] };
const gm = await other.newPage();
watch(gm, 'gm');
await gm.goto('http://localhost:4178/pages/gm-games', { waitUntil: 'networkidle' });
await gm.waitForTimeout(800);
await gm.click('[data-host]');
await gm.fill('#host-title', 'Live test one-shot');
await gm.fill('#host-blurb', 'A short adventure for the live test.');
await gm.selectOption('#host-seats', '5');
await gm.waitForTimeout(200);
const tableNote = await gm.textContent('[data-host-table]');
check('a 5-player game gets enough tables for 6 people', /tables .+ and /.test(tableNote) || /\(Fancy room\)/.test(tableNote), tableNote.trim());
await gm.click('[data-host-form] button[type="submit"]');
await gm.waitForTimeout(800);
const listed = (await gm.textContent('gm-board dialog').catch(() => '')).replace(/\s+/g, ' ');
check('game listed and waiting for approval (no false email promise)', /check it soon/.test(listed) && /once it is approved/.test(listed), listed.slice(0, 140));
await gm.keyboard.press('Escape');
await gm.reload({ waitUntil: 'networkidle' });
await gm.waitForTimeout(800);
const board = (await gm.textContent('gm-board')).replace(/\s+/g, ' ');
check('the GM sees their pending game on the board', /Live test one-shot/.test(board) && /Waiting for staff approval/.test(board));

/* 5. Staff page with a customer tagged staff in the theme, but not in Shopify: the app refuses changes */
mockState.customer = { id: 888, first_name: 'Mo', name: 'Mo', email: 'mo@example.com', phone: '', tags: ['staff'] };
const staff = await other.newPage();
watch(staff, 'staff');
await staff.goto('http://localhost:4178/pages/lair-staff', { waitUntil: 'networkidle' });
await staff.waitForTimeout(900);
await staff.click('[data-table="T2"]');
await staff.fill('#walkin-name', 'Walky');
await staff.click('[data-walkin-form] button[type="submit"]');
await staff.waitForTimeout(600);
const toast = (await staff.textContent('.toast').catch(() => '')) || '';
check('staff actions are checked by the app, not just the theme', /Staff only/.test(toast), toast.trim());

check('no script errors on any page', errors.length === 0, errors.join(' | '));
check('no server errors from the app', apiErrors.length === 0, apiErrors.join(' | '));
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
await browser.close();
server.close();
process.exit(results.every(Boolean) ? 0 : 1);

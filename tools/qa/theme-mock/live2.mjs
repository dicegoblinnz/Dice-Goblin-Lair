// End-to-end against the real Lair app (wrangler dev on :8787) through a signing stand-in for Shopify's app proxy:
// GM listing with a picture, the home page roll, and My Lair.
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { serve, mockState, globalSettings } from './render.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const WORKER = 'http://127.0.0.1:8787';
const SHOP = 'ep0qiq-rp.myshopify.com';
globalSettings.lair_mode = 'live';
const API = (globalSettings.lair_api || '/apps/liar').replace(/\/$/, '');
const calls = [];
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
  params.set('signature', createHmac('sha256', 'hush').update(message).digest('hex'));
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const path = url.pathname.slice(`${API}/`.length);
  const upstream = await fetch(`${WORKER}/proxy/${path}?${params}`, {
    method: req.method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9, 23.227.38.2' },
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const text = await upstream.text();
  calls.push({ method: req.method, path, status: upstream.status, text: text.slice(0, 300) });
  res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
  res.end(text);
  return true;
};
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };
const server = await serve(4179);
const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));

/* 1. A logged-in customer lists a flexible game with a picture and a $0 GM fee */
mockState.customer = { id: 777, first_name: 'Ellie', name: 'Ellie Tane', email: 'ellie@example.com', phone: '', tags: [] };
await page.goto('http://localhost:4179/pages/gm-games', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.click('.gm-toolbar__host');
await page.fill('[name="title"]', 'Live listed');
await page.check('[data-host-form] [name="system"][value="Daggerheart"]', { force: true });
await page.fill('[name="blurb"]', 'A pitch for the live test.');
await page.setInputFiles('[data-photo-input]', '../games-qa/test-photo.jpg');
await page.waitForSelector('.gm-photo__preview img', { timeout: 15000 });
await page.click('[data-step-next]');
await page.check('[name="age"][value="18+"]', { force: true });
await page.click('[data-step-next]');
await page.check('[name="characters"][value="pregens"]', { force: true });
await page.click('[data-step-next]');
await page.check('[name="schedule"][value="flexible"]', { force: true });
await page.waitForTimeout(300);
const pick = await page.$$eval('gm-floor [data-table^="P"]', (els) => els.filter((e) => !e.disabled && e.dataset.status !== 'taken').map((e) => e.dataset.table));
for (const id of pick.slice(0, 2)) await page.click(`gm-floor [data-table="${id}"]`, { force: true });
await page.click('[data-step-next]');
await page.fill('[name="gm"]', 'Ellie the GM');
await page.fill('[name="bio"]', 'GM for the live test.');
await page.check('[name="gmFee"][value="0"]', { force: true });
await page.click('[data-step-next]');
await page.waitForSelector('.gm-done, .gm-step__error, [role="alert"]', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
const created = calls.find((c) => c.method === 'POST' && c.path === 'games');
check('the app accepted the game', created && created.status === 200, created ? `${created.status} ${created.text.slice(0, 120)}` : 'no call');
const image = calls.find((c) => c.method === 'POST' && /^games\/[^/]+\/image$/.test(c.path));
check('the picture uploaded through the app proxy', image && image.status === 200, image ? `${image.status} ${image.text.slice(0, 120)}` : 'no call');
const profile = calls.find((c) => c.method === 'POST' && c.path === 'gm-profile');
check('the GM profile saved', profile && profile.status === 200, profile ? profile.text.slice(0, 80) : 'no call');
const url = image && JSON.parse(image.text).image;
if (url) {
  const pic = await fetch(url);
  check('the picture is served by the app', pic.status === 200 && /image\/jpeg/.test(pic.headers.get('content-type')), `${pic.status} ${pic.headers.get('content-type')} ${(await pic.arrayBuffer()).byteLength} bytes`);
}
const done = (await page.textContent('.gm-done').catch(() => '')).replace(/\s+/g, ' ');
check('pending message shown', /check/i.test(done), done.slice(0, 160));

/* 2. A table booking while logged in shows up in My Lair */
await page.goto('http://localhost:4179/pages/book-a-table', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.click('.date-chip:not([disabled]) >> nth=1');
await page.click('[data-play-start]:not([disabled]), [data-slot]:not([disabled]) >> visible=true >> nth=0');
await page.waitForTimeout(300);
await page.fill('#bk-name', 'Ellie');
await page.fill('#bk-email', 'ellie@example.com');
const agree = page.locator('input[name="agree"]');
if (await agree.count()) await agree.check();
await page.click('[data-submit]');
await page.waitForSelector('[data-done]:not([hidden])', { timeout: 8000 }).catch(() => {});
const ticket = (await page.textContent('[data-done]').catch(() => '')).replace(/\s+/g, ' ');
const ref = (ticket.match(/GOB-[A-Z0-9]{6}/) || [])[0];
check('booking made while logged in', Boolean(ref), ticket.slice(0, 120));
await page.goto('http://localhost:4179/pages/my-lair', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const lairText = (await page.textContent('main').catch(() => '')).replace(/\s+/g, ' ');
check('My Lair lists the booking', ref && lairText.includes(ref), lairText.slice(0, 200));
check('My Lair lists the game I run', /Live listed/.test(lairText));

/* 3. The home page dice: the roll comes from the app */
await page.goto('http://localhost:4179/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const before = calls.length;
await page.click('[data-die]').catch(() => page.click('[data-roll]'));
await page.waitForTimeout(2500);
const roll = calls.slice(before).find((c) => c.path === 'roll');
check('POST /roll answered by the app', roll && roll.status === 200, roll ? roll.text.slice(0, 160) : 'no call');
check('no script errors', errors.length === 0, errors.join(' | '));
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
await browser.close();
server.close();
process.exit(results.every(Boolean) ? 0 : 1);

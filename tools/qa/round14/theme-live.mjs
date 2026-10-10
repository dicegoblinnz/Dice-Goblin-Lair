// LOCAL QA ONLY (round 14): the theme's Discord parts in live mode, talking to the real Lair app under `wrangler dev`
// (through a stand-in for Shopify's app proxy that signs every request, as theme-mock/live.mjs does), with Discord faked
// (./fake-discord.mjs). Run it after ./discord.mjs on the same stack, so the sessions have their posts:
//   DG_THEME=/path/to/theme node tools/qa/round14/theme-live.mjs
// - My Lair › Profile: Link Discord goes to Discord's sign-in (checked, then answered here the way Discord would: back
//   to My Lair with ?code=…&state=…), the Lair app finishes it, the card says who's linked, and Unlink undoes it.
// - "Chat on Discord" on a TTRPG session's sheet goes to its post's thread in the server.
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(fs.existsSync('/opt/node-tools/node_modules/playwright') ? '/opt/node-tools/node_modules/playwright' : 'playwright');
process.env.DG_THEME = process.env.DG_THEME || '/home/claude/dice-goblin-website';
const { serve, mockState, globalSettings } = await import('../theme-mock/render.mjs');

const WORKER = 'http://127.0.0.1:8787';
const SECRET = 'hush';
const SHOP = 'ep0qiq-rp.myshopify.com';
const GUILD = '111111111111111111';
const PORT = Number(process.env.QA_PORT || 4179);
const BASE = `http://localhost:${PORT}`;
globalSettings.lair_mode = 'live';
const API = (globalSettings.lair_api || '/apps/liar').replace(/\/$/, '');
mockState.customer = { id: 7301, first_name: 'Mere', last_name: 'Kahu', name: 'Mere Kahu', email: 'mere@example.com', phone: null, tags: [], orders_count: 0, orders: [] };
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

let failures = 0;
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !extra ? '' : `\n     ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 600)}`}`);
  if (!ok) failures += 1;
};
const errors = [];
const server = await serve(PORT);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));

// Discord's sign-in, as Discord answers it once they say yes: back to the redirect with a code and the same state
let authorize = null;
await page.route('https://discord.com/**', async (route) => {
  const u = new URL(route.request().url());
  authorize = u;
  await route.fulfill({ status: 302, headers: { location: `${BASE}/pages/my-lair?code=qa-live-code&state=${encodeURIComponent(u.searchParams.get('state') || '')}` } });
});

const card = () => page.evaluate(() => {
  const el = document.querySelector('[data-discord-card]');
  const msg = el?.querySelector('[data-discord-message]');
  return {
    shown: Boolean(el) && !el.hidden,
    text: el ? el.innerText.replace(/\s+/g, ' ').trim() : '',
    message: msg && !msg.hidden ? msg.textContent.trim() : '',
    buttons: el ? [...el.querySelectorAll('button')].map((b) => b.textContent.trim()) : [],
    search: window.location.search,
  };
});
const settle = async () => {
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('[data-panel="bookings"]:not([aria-busy])', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(600);
};

await page.goto(`${BASE}/pages/my-lair#profile`, { waitUntil: 'networkidle' });
await settle();
let c = await card();
check(c.shown && c.buttons.join('|') === 'Link Discord', "My Lair's Discord card offers Link Discord (the Lair app says it's switched on)", c);
// (My Lair takes the code out of the address at once, so wait for it to be sent on to the Lair app)
const finishing = page.waitForResponse((r) => r.url().includes(`${API}/me/discord/finish`), { timeout: 20000 });
await page.click('[data-discord-link]');
const finished = await finishing;
check(finished.status() === 200, 'POST /me/discord/finish', finished.status());
await page.waitForTimeout(800);
check(authorize && authorize.origin === 'https://discord.com' && authorize.pathname === '/oauth2/authorize', "off to Discord's own sign-in", authorize?.href);
check(authorize && authorize.searchParams.get('client_id') === '777777777777777777' && authorize.searchParams.get('scope') === 'identify'
  && authorize.searchParams.get('redirect_uri') === 'https://www.dicegoblin.nz/pages/my-lair' && /^dg[0-9a-f]{32}$/.test(authorize.searchParams.get('state') || ''), 'with the app, the identify scope, the redirect and a state', authorize?.search);
c = await card();
check(c.search === '', 'the code is taken out of the address', c.search);
check(c.message === 'Linked! Gobgob knows you as Ruby in the Dice Goblin server now.' && /Linked to Ruby \(@ruby\)\./.test(c.text), 'the Lair app finished it, and the card says who', c);
const me = await page.evaluate(async () => (await window.Lair.store.backend.request('/me')).discord);
check(me?.linked?.username === 'ruby', 'GET /me has the link', me);

// the same code and state again (the back button): refused, nothing changes
await page.goto(`${BASE}/pages/my-lair?code=qa-live-code&state=${encodeURIComponent(authorize?.searchParams.get('state') || '')}`, { waitUntil: 'networkidle' });
await settle();
c = await card();
check(c.message === 'That Discord link has expired. Tap Link Discord again.' && /Linked to Ruby/.test(c.text), 'a state works once', c);

// Unlink
await page.click('[data-discord-unlink]');
await page.click('[data-discord-unlink-yes]');
await page.waitForTimeout(800);
c = await card();
check(c.message === "Unlinked. What you've booked stays booked." && c.buttons.join('|') === 'Link Discord', 'Unlink, asked first', c);

// Chat on Discord: a session with a post (./discord.mjs's QA Strahd) goes to its thread
await page.goto(`${BASE}/pages/gm-games`, { waitUntil: 'networkidle' });
await page.waitForSelector('.gm-card [data-game]', { timeout: 15000 });
const id = await page.evaluate(() => (window.Lair.store.data.games.find((g) => g.title === 'QA Strahd' && g.discordUrl) || {}).id || null);
check(Boolean(id), 'the floor gives QA Strahd its Discord link');
if (id) {
  await page.evaluate((gameId) => document.querySelector('gm-board').openGame(gameId), id);
  await page.waitForSelector('.gm-detail', { timeout: 5000 });
  const href = await page.evaluate(() => document.querySelector('.gm-detail .gm-chat a.lair-chat')?.getAttribute('href') || '');
  check(new RegExp(`^https://discord\\.com/channels/${GUILD}/\\d+$`).test(href), "Chat on Discord goes to the session's thread", href);
}

check(!errors.length, 'no page errors', errors);
await browser.close();
server.close();
console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);

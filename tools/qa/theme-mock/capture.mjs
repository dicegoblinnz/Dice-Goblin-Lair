// Screenshot every route of the theme through the mock renderer, phone (390x844 @2x) and desktop (1440x900),
// full page, with the Lair in demo mode and the page clock pinned to a shop-open afternoon. Also records console
// errors, sideways scroll, and bytes per resource type for each page.
// Usage: DG_THEME=/path/to/theme OUT=/dir/ PORT=4501 node capture.mjs [only-route-names...]
// Writes <route>-phone.png and <route>-desktop.png (full page) plus summary.json into OUT.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const m = await import(new URL('./render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const OUT = process.env.OUT || new URL('./shots/', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 4501);
fs.mkdirSync(OUT, { recursive: true });

const CUSTOMER = {
  id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [],
  orders_count: 1,
  orders: [{ name: '#1550', created_at: '2026-10-01T03:12:00Z', total_price: 10000, fulfillment_status: 'fulfilled', cancelled: false, customer_url: '/account/orders/1550' }],
  store_credit_account: { balance: 500 },
};
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
// r6: a library member (Stash plan, 3 games), for the Reserve button on a library copy
const MEMBER = { id: 7700500001, first_name: 'Kiri', last_name: 'Moana', name: 'Kiri Moana', email: 'kiri.moana@example.com', phone: null, tags: ['Goblin Treasure - Board Game Rental'] };

// Pin the page clock to Monday 5 Oct 2026, 5pm in Auckland (UTC+13), so "today" has sessions on the floor
const AT = Date.UTC(2026, 9, 5, 4, 0);
const CLOCK = `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;

const ROUTES = [
  ['home', '/'],
  ['cart-drawer', '/cart-open', { click: '[data-cart-open]' }],
  ['product', '/products/wingspan'],
  ['product-library-copy', '/products/library'],
  ['product-library-member', '/products/library', { customer: MEMBER }],
  ['product-membership', '/products/board-game-rental-monthly'],
  ['collection', '/collections/new-additions'],
  ['collection-tcg', '/collections/trading-card-games'],
  ['collection-rpg', '/collections/role-playing-game'],
  ['collection-library', '/collections/board-game-rental'],
  ['library-landing', '/pages/board-game-rental'],
  ['library-terms', '/pages/dice-goblin-board-game-rental-membership'],
  ['book-a-table', '/pages/book-a-table'],
  ['gm-games', '/pages/gm-games'],
  ['events-calendar', '/pages/events-calendar'],
  ['contact', '/pages/contact'],
  ['my-lair-logged-out', '/pages/my-lair'],
  ['my-lair', '/pages/my-lair', { customer: CUSTOMER }],
  // r7: My Lair's other sections (the row of six at the top)
  ['my-lair-bookings', '/pages/my-lair#bookings', { customer: CUSTOMER }],
  ['my-lair-wallet', '/pages/my-lair#wallet', { customer: CUSTOMER }],
  ['my-lair-library', '/pages/my-lair#library', { customer: MEMBER }],
  ['my-lair-tab', '/pages/my-lair#tab', { customer: CUSTOMER }],
  ['my-lair-profile', '/pages/my-lair#profile', { customer: STAFF }],
  ['staff', '/pages/lair-staff', { customer: STAFF }],
  // round 7 (staff-admin): the new tabs, opened by their deep links
  ['staff-events', '/pages/lair-staff#events', { customer: STAFF }],
  ['staff-groups', '/pages/lair-staff#groups', { customer: STAFF }],
  ['staff-codes', '/pages/lair-staff?tab=codes', { customer: STAFF }],
  ['search', '/search?q=wing'],
  ['404', '/404'],
];
const SIZES = { phone: { width: 390, height: 844, scale: 2 }, desktop: { width: 1440, height: 900, scale: 1 } };
const only = process.argv.slice(2);
const server = await m.serve(PORT);
const browser = await chromium.launch();
const summary = [];
for (const [name, path, opts = {}] of ROUTES.filter((r) => !only.length || only.includes(r[0]))) {
  for (const [size, vp] of Object.entries(SIZES)) {
    m.mockState.customer = opts.customer || null;
    const phone = vp.width < 700;
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.scale, isMobile: phone, hasTouch: phone });
    await ctx.addInitScript(CLOCK);
    const page = await ctx.newPage();
    const errors = [];
    const bytes = {};
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(`console: ${msg.text()}`); });
    page.on('response', async (res) => {
      try {
        const type = res.request().resourceType();
        const body = await res.body();
        bytes[type] = (bytes[type] || 0) + body.length;
      } catch { /* redirects etc. */ }
    });
    await page.goto(`http://localhost:${PORT}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    if (opts.click) { await page.click(opts.click).catch(() => {}); await page.waitForTimeout(600); }
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path: `${OUT}${name}-${size}.png`, fullPage: !opts.click });
    summary.push({ name, size, path, overflowX, height, errors, bytes });
    console.log(name, size, 'overflowX', overflowX, 'height', height, 'kb', Object.fromEntries(Object.entries(bytes).map(([k, v]) => [k, Math.round(v / 1024)])), errors.length ? errors.slice(0, 3) : '');
    await ctx.close();
  }
}
fs.writeFileSync(`${OUT}summary.json`, JSON.stringify(summary, null, 1));
await browser.close();
server.close();

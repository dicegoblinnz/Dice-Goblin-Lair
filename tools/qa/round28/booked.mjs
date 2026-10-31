// Round 28, "Booked a session" (contract v28-booked): the website's side, on the theme mock. A booking the Lair confirms
// (its answer's track) goes to each ad platform whose ID is set in Theme settings › Ad tracking, once; clicks from ads
// are kept on the landing page; nothing loads with no ID set, for a visitor who said no to marketing, or in demo mode.
// The platforms' own scripts are stood in for (nothing reaches Meta, Google or TikTok): each stub queues its calls, as
// their real loaders do before the script arrives, and the checks read those queues.
//
// Usage: DG_THEME=/path/to/theme [PORT=4993] [OUT=dir] node tools/qa/round28/booked.mjs
import fs from 'node:fs';
import path from 'node:path';

const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, go, RUBY } = lib;
const PORT = Number(process.env.PORT || 4993);
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.OUT || '/tmp/dg-round28';
fs.mkdirSync(OUT, { recursive: true });

const IDS = { ads_meta_pixel: '123456789012345', ads_google_id: 'AW-987654321', ads_google_booked: 'BookedLabel1', ads_google_first: 'FirstLabel22', ads_tiktok_pixel: 'CTEST123ABC456DEF789' };
const TRACK = { id: 'RU-OWLBEAR-17', kind: 'table', value: 20, currency: 'NZD', first: true };

/* ---------------- a stand-in Lair behind /apps/liar ---------------- */
const API = '/apps/liar';
let calls = [];
// what the next POST /bookings answers: 'track' (confirmed, with track), 'plain' (no track) or 'refused' (a 422)
let bookingAnswer = 'track';
let track = TRACK;
m.mockState.before = async (req, res, url) => {
  if (!url.pathname.startsWith(`${API}/`)) return false;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const route = url.pathname.slice(API.length);
  calls.push(`${req.method} ${route}`);
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  };
  if (route === '/me') return send(200, { customer: { id: m.mockState.customer?.id || null }, bookings: [], seats: [], joins: [], games: [], credits: [], member: {} });
  if (req.method === 'POST' && route === '/bookings') {
    if (bookingAnswer === 'refused') return send(422, { error: 'That table is taken.' });
    const booking = { id: 'bk_1', ref: track.id, kind: 'table', status: 'confirmed', amount: 2000 };
    return send(200, bookingAnswer === 'track' ? { booking, track } : { booking });
  }
  return send(200, { ok: true });
};

/* ---------------- the browser: the platforms stood in for ---------------- */
const server = await m.serve(PORT);
const browser = await chromium.launch();
const PLATFORMS = [
  ['meta', /connect\.facebook\.net\/.*fbevents\.js/],
  ['google', /googletagmanager\.com\/gtag\/js/],
  ['tiktok', /analytics\.tiktok\.com\/i18n\/pixel\/events\.js/],
];
async function context({ privacy = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  ctx.loads = [];
  for (const [name, pattern] of PLATFORMS) {
    await ctx.route(pattern, (route) => {
      ctx.loads.push(name);
      route.fulfill({ status: 200, contentType: 'application/javascript', body: `/* ${name} stand-in: calls stay queued */` });
    });
  }
  // Shopify's analytics and (when given) customer privacy, as the storefront provides them
  await ctx.addInitScript((said) => {
    window.__published = [];
    window.Shopify = window.Shopify || {};
    window.Shopify.analytics = { publish: (name, data) => window.__published.push([name, data]) };
    if (said !== null) window.Shopify.customerPrivacy = { marketingAllowed: () => said };
  }, privacy);
  return ctx;
}
function watch(page) {
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) page.errors.push(msg.text());
  });
  return page;
}
/** What each platform was told: Meta's queue, Google's dataLayer, and the TikTok pixel's own instance queue */
const told = (page) => page.evaluate((tiktok) => {
  const arr = (x) => Array.from(x || []).map((a) => JSON.parse(JSON.stringify(Array.from(a))));
  return {
    meta: window.fbq ? arr(window.fbq.queue) : null,
    google: window.dataLayer ? arr(window.dataLayer).filter((a) => a[0] !== 'js') : null,
    tiktok: window.ttq && window.ttq._i && window.ttq._i[tiktok] ? arr(window.ttq._i[tiktok]) : null,
    published: window.__published,
    config: document.getElementById('ad-tracking') ? JSON.parse(document.getElementById('ad-tracking').textContent) : null,
    script: Boolean(document.querySelector('script[src*="tracking.js"]')),
  };
}, IDS.ads_tiktok_pixel);
const cookie = async (ctx, name) => (await ctx.cookies()).find((c) => c.name === name)?.value || null;
/** A booking from a Lair page, as the booking form makes it, after the Lair app's answer */
async function book(page) {
  await page.evaluate(async () => {
    try {
      await window.Lair.store.backend.createBooking({ kind: 'table', tables: ['T3'], people: 2, name: 'Ruby' });
    } catch {
      /* a refused booking: the page shows its error */
    }
  });
  await page.waitForTimeout(300);
}
async function lairPage(page, where = '/pages/my-lair') {
  await go(page, BASE, where, RUBY);
  await page.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend, null, { timeout: 20000 });
  await page.waitForTimeout(400);
}
const set = (ids) => {
  for (const key of Object.keys(IDS)) delete m.globalSettings[key];
  Object.assign(m.globalSettings, ids);
};

/* ---------------- no IDs: nothing at all ---------------- */
{
  const tag = '[no IDs]';
  m.globalSettings.lair_mode = 'live';
  set({});
  const ctx = await context();
  const page = watch(await ctx.newPage());
  await lairPage(page, '/pages/my-lair?gclid=Gtest-123456&fbclid=IwAR0test12345&ttclid=E.C.P.test12345');
  bookingAnswer = 'track';
  await book(page);
  const t = await told(page);
  check(`${tag} no settings block and no tracking.js on the page`, t.config === null && t.script === false, t);
  check(`${tag} no platform script loads, even arriving from ads and after a booking`, ctx.loads.length === 0, ctx.loads);
  check(`${tag} no _fbc cookie is made`, (await cookie(ctx, '_fbc')) === null);
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await ctx.close();
}

/* ---------------- IDs set ---------------- */
set(IDS);
{
  const tag = '[a plain visit]';
  const ctx = await context();
  const page = watch(await ctx.newPage());
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const t = await told(page);
  check(`${tag} the IDs are on the page, and tracking.js`, t.script && JSON.stringify(t.config) === JSON.stringify({ meta: IDS.ads_meta_pixel, googleAds: IDS.ads_google_id, googleBooked: IDS.ads_google_booked, googleFirst: IDS.ads_google_first, tiktok: IDS.ads_tiktok_pixel }), t.config);
  check(`${tag} but no platform script loads until there's something to send`, ctx.loads.length === 0 && t.meta === null && t.google === null && t.tiktok === null, { loads: ctx.loads, t });
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await ctx.close();
}
{
  const tag = '[from a Google ad]';
  const ctx = await context();
  const page = watch(await ctx.newPage());
  await page.goto(`${BASE}/?gclid=Gtest-123456`, { waitUntil: 'networkidle' });
  const t = await told(page);
  check(`${tag} Google's tag loads, set up without a page view, so it keeps the click`,
    JSON.stringify(ctx.loads) === JSON.stringify(['google']) && JSON.stringify(t.google) === JSON.stringify([['config', IDS.ads_google_id, { send_page_view: false }]]), { loads: ctx.loads, google: t.google });
  check(`${tag} nothing else loads`, t.meta === null && t.tiktok === null);
  await ctx.close();
}
{
  const tag = '[from a Facebook ad]';
  const ctx = await context();
  const page = watch(await ctx.newPage());
  const before = Date.now();
  await page.goto(`${BASE}/?fbclid=IwAR0test12345`, { waitUntil: 'networkidle' });
  const fbc = await cookie(ctx, '_fbc');
  const [fb, one, when, click] = String(fbc || '').split('.');
  check(`${tag} the click goes in Meta's _fbc cookie (fb.1.<when>.<fbclid>), with no script`,
    fb === 'fb' && one === '1' && Number(when) >= before - 1000 && Number(when) <= Date.now() + 1000 && click === 'IwAR0test12345' && ctx.loads.length === 0, { fbc, loads: ctx.loads });
  await page.goto(`${BASE}/collections/all?fbclid=IwAR0test12345`, { waitUntil: 'networkidle' });
  check(`${tag} the same click again leaves the cookie as it was`, (await cookie(ctx, '_fbc')) === fbc);
  await ctx.close();
}
{
  const tag = '[from a TikTok ad]';
  const ctx = await context();
  const page = watch(await ctx.newPage());
  await page.goto(`${BASE}/?ttclid=E.C.P.test12345`, { waitUntil: 'networkidle' });
  const t = await told(page);
  check(`${tag} TikTok's pixel loads (it keeps the click), with no page view`,
    JSON.stringify(ctx.loads) === JSON.stringify(['tiktok']) && Array.isArray(t.tiktok) && t.tiktok.length === 0, { loads: ctx.loads, tiktok: t.tiktok });
  await ctx.close();
}
{
  const tag = '[a booking]';
  const ctx = await context();
  const page = watch(await ctx.newPage());
  await lairPage(page);
  check(`${tag} a Lair page loads nothing by itself`, ctx.loads.length === 0, ctx.loads);
  bookingAnswer = 'track';
  track = TRACK;
  calls = [];
  await book(page);
  let t = await told(page);
  check(`${tag} the booking went to the Lair`, calls.includes('POST /bookings'), calls);
  check(`${tag} each platform's script loads once`, JSON.stringify([...ctx.loads].sort()) === JSON.stringify(['google', 'meta', 'tiktok']), ctx.loads);
  check(`${tag} Meta: automatic events off, the pixel, and Schedule with its value, kind, first booking and the event ID; no page view`,
    JSON.stringify(t.meta) === JSON.stringify([
      ['set', 'autoConfig', false, IDS.ads_meta_pixel],
      ['init', IDS.ads_meta_pixel],
      ['trackSingle', IDS.ads_meta_pixel, 'Schedule', { value: 20, currency: 'NZD', content_category: 'table', first_booking: true }, { eventID: 'booked-RU-OWLBEAR-17' }],
    ]), t.meta);
  check(`${tag} Google: Booked a session, and First booking (it's Ruby's first), each with its own transaction ID`,
    JSON.stringify(t.google) === JSON.stringify([
      ['config', IDS.ads_google_id, { send_page_view: false }],
      ['event', 'conversion', { send_to: `${IDS.ads_google_id}/${IDS.ads_google_booked}`, value: 20, currency: 'NZD', transaction_id: 'RU-OWLBEAR-17' }],
      ['event', 'conversion', { send_to: `${IDS.ads_google_id}/${IDS.ads_google_first}`, value: 20, currency: 'NZD', transaction_id: 'first-RU-OWLBEAR-17' }],
    ]), t.google);
  check(`${tag} TikTok: Schedule with the event ID`,
    JSON.stringify(t.tiktok) === JSON.stringify([['track', 'Schedule', { value: 20, currency: 'NZD', content_type: 'product', content_id: 'table', description: 'first booking' }, { event_id: 'booked-RU-OWLBEAR-17' }]]), t.tiktok);
  check(`${tag} Shopify's analytics hear it too (dice_goblin:booked)`,
    JSON.stringify(t.published) === JSON.stringify([['dice_goblin:booked', { id: 'RU-OWLBEAR-17', kind: 'table', value: 20, currency: 'NZD', first: true }]]), t.published);
  // the same booking told twice (a second answer, or the event again) is sent once
  await page.evaluate((x) => document.dispatchEvent(new CustomEvent('lair:booked', { detail: x })), TRACK);
  await book(page);
  t = await told(page);
  check(`${tag} the same booking again sends nothing more`, t.meta.length === 3 && t.google.length === 3 && t.tiktok.length === 1 && t.published.length === 1, t);
  // a second booking, not their first: no First booking conversion
  track = { ...TRACK, id: 'RU-OWLBEAR-18', first: false };
  await book(page);
  t = await told(page);
  check(`${tag} a later booking: Booked a session only`,
    JSON.stringify(t.google.slice(3)) === JSON.stringify([['event', 'conversion', { send_to: `${IDS.ads_google_id}/${IDS.ads_google_booked}`, value: 20, currency: 'NZD', transaction_id: 'RU-OWLBEAR-18' }]]) && t.meta.length === 4 && t.tiktok.length === 2, t.google);
  // an answer without track (staff made it, or it's held for payment) and a refused booking send nothing
  track = { ...TRACK, id: 'RU-OWLBEAR-19' };
  bookingAnswer = 'plain';
  await book(page);
  bookingAnswer = 'refused';
  await book(page);
  t = await told(page);
  check(`${tag} an answer without track, or a refused booking, sends nothing`, t.meta.length === 4 && t.google.length === 4 && t.tiktok.length === 2 && t.published.length === 2, t);
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await page.screenshot({ path: path.join(OUT, 'booking-page.png') });
  await ctx.close();
}
{
  const tag = '[said no to marketing]';
  bookingAnswer = 'track';
  track = { ...TRACK, id: 'RU-OWLBEAR-20' };
  const ctx = await context({ privacy: false });
  const page = watch(await ctx.newPage());
  await page.goto(`${BASE}/?gclid=Gtest-123456&fbclid=IwAR0test12345&ttclid=E.C.P.test12345`, { waitUntil: 'networkidle' });
  check(`${tag} arriving from ads keeps no click and loads nothing`, ctx.loads.length === 0 && (await cookie(ctx, '_fbc')) === null, ctx.loads);
  await lairPage(page);
  await book(page);
  const t = await told(page);
  check(`${tag} a booking is sent to no platform`, ctx.loads.length === 0 && t.meta === null && t.google === null && t.tiktok === null, { loads: ctx.loads, t });
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await ctx.close();
}
{
  const tag = '[only Google set]';
  set({ ads_google_id: IDS.ads_google_id, ads_google_booked: IDS.ads_google_booked });
  track = { ...TRACK, id: 'RU-OWLBEAR-21' };
  const ctx = await context();
  const page = watch(await ctx.newPage());
  await lairPage(page);
  await book(page);
  const t = await told(page);
  check(`${tag} Google alone hears it (no First booking label: Booked a session only)`,
    JSON.stringify(ctx.loads) === JSON.stringify(['google']) && t.google.length === 2 && t.meta === null && t.tiktok === null, { loads: ctx.loads, t });
  await ctx.close();
  set(IDS);
}
{
  const tag = '[demo mode]';
  m.globalSettings.lair_mode = 'demo';
  const ctx = await context();
  const page = watch(await ctx.newPage());
  await lairPage(page, '/pages/book-a-table');
  await page.evaluate(async () => {
    const be = window.Lair.store.backend;
    try {
      await be.createBooking({ kind: 'table', tables: ['T3'], people: 2, name: 'Ruby', start: Date.now() + 2 * 3600000, end: Date.now() + 4 * 3600000 });
    } catch {
      /* the demo may refuse a made-up time: either way nothing is sent */
    }
  });
  await page.waitForTimeout(300);
  check(`${tag} the lab's made-up bookings never reach the ad platforms`, ctx.loads.length === 0, ctx.loads);
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await ctx.close();
  m.globalSettings.lair_mode = 'live';
}

set({});
m.mockState.before = null;
const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed (shots in ${OUT})`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

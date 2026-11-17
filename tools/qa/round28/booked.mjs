// Round 28, "Booked a session" (contract v28-booked): the website's side, on the theme mock. A booking the Lair confirms
// (its answer's track) goes to each ad platform whose ID is set in Theme settings › Ad tracking, once; clicks from ads
// are kept on the landing page; nothing loads with no ID set, for a visitor who said no to marketing, or in demo mode.
// The platforms' own scripts are stood in for (nothing reaches Meta, Google or TikTok): each stub queues its calls, as
// their real loaders do before the script arrives, and the checks read those queues.
//
// 17 Nov 2026 (contract v28, section 6): someone's first booking is also "First booking" (Google) and
// CompleteRegistration (Meta, TikTok); the booker's email and mobile go with it, SHA-256 hashed in the browser, only with
// marketing consent; and a paid click beats an older unpaid link in the ad tags the site keeps.
//
// Usage: DG_THEME=/path/to/theme [PORT=4993] [OUT=dir] node tools/qa/round28/booked.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, go, RUBY } = lib;
const PORT = Number(process.env.PORT || 4993);
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.OUT || '/tmp/dg-round28';
fs.mkdirSync(OUT, { recursive: true });

const IDS = { ads_meta_pixel: '123456789012345', ads_google_id: 'AW-987654321', ads_google_booked: 'BookedLabel1', ads_google_first: 'FirstLabel22', ads_tiktok_pixel: 'CTEST123ABC456DEF789' };
// the booking's own opaque ID (from the review: never its code, which carries the booker's initials)
const TRACK = { id: 'bk_9f3k27', kind: 'table', value: 20, currency: 'NZD', first: true };
// what the booker typed, and each platform's hashed copy (Google drops a gmail address's dots; phones in E.164)
const TYPED = { email: ' Ruby.Tane@Gmail.com ', phone: '021 555 0100' };
const hash = (text) => createHash('sha256').update(text).digest('hex');
const MATCH = {
  google: { sha256_email_address: hash('rubytane@gmail.com'), sha256_phone_number: hash('+64215550100') },
  meta: { em: hash('ruby.tane@gmail.com'), ph: hash('64215550100') },
  tiktok: { email: hash('ruby.tane@gmail.com'), phone_number: hash('+64215550100') },
};
const GOOGLE_CONFIG = ['config', 'AW-987654321', { send_page_view: false, allow_enhanced_conversions: true }];

/* ---------------- a stand-in Lair behind /apps/liar ---------------- */
const API = '/apps/liar';
let calls = [];
let bodies = [];
// what the next POST /bookings answers: 'track' (confirmed, with track), 'plain' (no track) or 'refused' (a 422)
let bookingAnswer = 'track';
let track = TRACK;
m.mockState.before = async (req, res, url) => {
  if (!url.pathname.startsWith(`${API}/`)) return false;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const route = url.pathname.slice(API.length);
  calls.push(`${req.method} ${route}`);
  try {
    if (chunks.length) bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    /* not JSON */
  }
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  };
  if (route === '/me') return send(200, { customer: { id: m.mockState.customer?.id || null }, bookings: [], seats: [], joins: [], games: [], credits: [], member: {} });
  if (req.method === 'POST' && route === '/bookings') {
    if (bookingAnswer === 'refused') return send(422, { error: 'That table is taken.' });
    const booking = { id: track.id, ref: 'RU-OWLBEAR-17', kind: 'table', status: 'confirmed', amount: 2000 };
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
async function context({ privacy = null, late = undefined } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  ctx.loads = [];
  for (const [name, pattern] of PLATFORMS) {
    await ctx.route(pattern, (route) => {
      ctx.loads.push(name);
      route.fulfill({ status: 200, contentType: 'application/javascript', body: `/* ${name} stand-in: calls stay queued */` });
    });
  }
  // Shopify's analytics and (when given) customer privacy, as the storefront provides them
  await ctx.addInitScript(([said, later]) => {
    window.__published = [];
    window.Shopify = window.Shopify || {};
    window.Shopify.analytics = { publish: (name, data) => window.__published.push([name, data]) };
    if (said !== null) window.Shopify.customerPrivacy = { marketingAllowed: () => said };
    // (from the review) Shopify's privacy API, as a storefront loads it when asked: a moment later
    if (later !== undefined) {
      window.__asked = [];
      window.Shopify.loadFeatures = (features, done) => {
        window.__asked.push(features.map((f) => f.name).join(','));
        setTimeout(() => {
          window.Shopify.customerPrivacy = { marketingAllowed: () => later };
          done();
        }, 300);
      };
    }
  }, [privacy, late]);
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
    script: Boolean(document.querySelector('script[src*="/tracking."]')),
  };
}, IDS.ads_tiktok_pixel);
const cookie = async (ctx, name) => (await ctx.cookies()).find((c) => c.name === name)?.value || null;
/** A booking from a Lair page, as the booking form makes it (with what the booker typed), after the Lair app's answer */
async function book(page, typed = TYPED) {
  await page.evaluate(async (more) => {
    try {
      await window.Lair.store.backend.createBooking({ kind: 'table', tables: ['T3'], people: 2, name: 'Ruby', ...more });
    } catch {
      /* a refused booking: the page shows its error */
    }
  }, typed);
  await page.waitForTimeout(400);
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
    JSON.stringify(ctx.loads) === JSON.stringify(['google']) && JSON.stringify(t.google) === JSON.stringify([GOOGLE_CONFIG]), { loads: ctx.loads, google: t.google });
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
  check(`${tag} Meta: automatic events off, the pixel with the booker's hashed email and mobile, Schedule, and CompleteRegistration (first booking); no page view`,
    JSON.stringify(t.meta) === JSON.stringify([
      ['set', 'autoConfig', false, IDS.ads_meta_pixel],
      ['init', IDS.ads_meta_pixel, MATCH.meta],
      ['trackSingle', IDS.ads_meta_pixel, 'Schedule', { value: 20, currency: 'NZD', content_category: 'table', first_booking: true }, { eventID: 'booked-bk_9f3k27' }],
      ['trackSingle', IDS.ads_meta_pixel, 'CompleteRegistration', { value: 20, currency: 'NZD', content_name: 'first booking', status: true }, { eventID: 'booked-first-bk_9f3k27' }],
    ]), t.meta);
  check(`${tag} Google: the hashed email and mobile, Booked a session, and First booking (it's Ruby's first), each with its own transaction ID`,
    JSON.stringify(t.google) === JSON.stringify([
      GOOGLE_CONFIG,
      ['set', 'user_data', MATCH.google],
      ['event', 'conversion', { send_to: `${IDS.ads_google_id}/${IDS.ads_google_booked}`, value: 20, currency: 'NZD', transaction_id: 'bk_9f3k27' }],
      ['event', 'conversion', { send_to: `${IDS.ads_google_id}/${IDS.ads_google_first}`, value: 20, currency: 'NZD', transaction_id: 'first-bk_9f3k27' }],
    ]), t.google);
  check(`${tag} TikTok: identify with the hashed email and mobile, Schedule, and CompleteRegistration, each with its event ID`,
    JSON.stringify(t.tiktok) === JSON.stringify([
      ['identify', MATCH.tiktok],
      ['track', 'Schedule', { value: 20, currency: 'NZD', content_type: 'product', content_id: 'table', description: 'first booking' }, { event_id: 'booked-bk_9f3k27' }],
      ['track', 'CompleteRegistration', { value: 20, currency: 'NZD', content_type: 'product', content_id: 'table', description: 'first booking' }, { event_id: 'booked-first-bk_9f3k27' }],
    ]), t.tiktok);
  const plain = JSON.stringify({ meta: t.meta, google: t.google, tiktok: t.tiktok, published: t.published }).toLowerCase();
  check(`${tag} the email and mobile never go in plain text`, !plain.includes('ruby.tane') && !plain.includes('gmail') && !plain.includes('555'), plain.slice(0, 300));
  check(`${tag} Shopify's analytics hear it too (dice_goblin:booked)`,
    JSON.stringify(t.published) === JSON.stringify([['dice_goblin:booked', { id: 'bk_9f3k27', kind: 'table', value: 20, currency: 'NZD', first: true }]]), t.published);
  // the same booking told twice (a second answer, or the event again) is sent once
  await page.evaluate((x) => document.dispatchEvent(new CustomEvent('lair:ad-booked', { detail: x })), TRACK);
  await book(page);
  t = await told(page);
  check(`${tag} the same booking again sends nothing more`, t.meta.length === 4 && t.google.length === 4 && t.tiktok.length === 3 && t.published.length === 1, t);
  // a second booking, not their first: no First booking conversion
  track = { ...TRACK, id: 'bk_9f3k28', first: false };
  await book(page);
  t = await told(page);
  check(`${tag} a later booking: Booked a session, Schedule and Schedule only (no First booking, no CompleteRegistration)`,
    JSON.stringify(t.google.slice(4)) === JSON.stringify([['set', 'user_data', MATCH.google], ['event', 'conversion', { send_to: `${IDS.ads_google_id}/${IDS.ads_google_booked}`, value: 20, currency: 'NZD', transaction_id: 'bk_9f3k28' }]])
      && JSON.stringify(t.meta.slice(4).map((a) => a[2])) === JSON.stringify(['Schedule'])
      && JSON.stringify(t.tiktok.slice(3).map((a) => (a[0] === 'identify' ? 'identify' : a[1]))) === JSON.stringify(['identify', 'Schedule']), { google: t.google.slice(4), meta: t.meta.slice(4), tiktok: t.tiktok.slice(3) });
  // an answer without track (staff made it, or it's held for payment) and a refused booking send nothing
  track = { ...TRACK, id: 'bk_9f3k29' };
  bookingAnswer = 'plain';
  await book(page);
  bookingAnswer = 'refused';
  await book(page);
  t = await told(page);
  check(`${tag} an answer without track, or a refused booking, sends nothing`, t.meta.length === 5 && t.google.length === 6 && t.tiktok.length === 5 && t.published.length === 2, t);
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await page.screenshot({ path: path.join(OUT, 'booking-page.png') });
  await ctx.close();
}
{
  const tag = '[said no to marketing]';
  bookingAnswer = 'track';
  track = { ...TRACK, id: 'bk_9f3k30' };
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
  const tag = '[privacy known late: no]';
  bookingAnswer = 'track';
  track = { ...TRACK, id: 'bk_9f3k40' };
  const ctx = await context({ late: false });
  const page = watch(await ctx.newPage());
  await page.goto(`${BASE}/?gclid=Gtest-123456&fbclid=IwAR0test12345&ttclid=E.C.P.test12345`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  check(`${tag} the page asks Shopify for its privacy API`, JSON.stringify(await page.evaluate(() => window.__asked)) === JSON.stringify(['consent-tracking-api']), await page.evaluate(() => window.__asked));
  check(`${tag} and, told no once it arrives, keeps no click and loads nothing`, ctx.loads.length === 0 && (await cookie(ctx, '_fbc')) === null, ctx.loads);
  await lairPage(page);
  await book(page);
  await page.waitForTimeout(500);
  const t = await told(page);
  check(`${tag} a booking is sent to no platform`, ctx.loads.length === 0 && t.meta === null && t.google === null && t.tiktok === null, { loads: ctx.loads, t });
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await ctx.close();
}
{
  const tag = '[privacy known late: yes]';
  const ctx = await context({ late: true });
  const page = watch(await ctx.newPage());
  await page.goto(`${BASE}/?gclid=Gtest-123456`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  check(`${tag} once it says yes, Google's tag keeps the click`, JSON.stringify(ctx.loads) === JSON.stringify(['google']), ctx.loads);
  await ctx.close();
}
{
  const tag = '[first not known]';
  bookingAnswer = 'track';
  track = { ...TRACK, id: 'bk_9f3k41', kind: 'ttrpg', first: null };
  const ctx = await context();
  const page = watch(await ctx.newPage());
  await lairPage(page);
  await book(page);
  const t = await told(page);
  const schedule = (t.meta || []).find((a) => a[0] === 'trackSingle');
  check(`${tag} a guest's booking: Meta isn't told it's a repeat (no first_booking at all)`, schedule && !('first_booking' in schedule[3]), schedule);
  check(`${tag} Google: Booked a session only (no First booking)`, (t.google || []).filter((a) => a[0] === 'event').length === 1, t.google);
  check(`${tag} Shopify's analytics hear first: null`, t.published.length === 1 && t.published[0][1].first === null, t.published);
  await ctx.close();
}
{
  const tag = '[the booking page\'s own lair:booked]';
  const ctx = await context();
  const page = watch(await ctx.newPage());
  await lairPage(page);
  // lair-booking.js fires lair:booked when a booking's made (demo too): it isn't for the ad platforms, whatever it holds
  await page.evaluate((x) => document.dispatchEvent(new CustomEvent('lair:booked', { bubbles: true, detail: { booking: { id: 'bk_1' }, ...x } })), { ...TRACK, id: 'bk_9f3k42' });
  await page.waitForTimeout(300);
  const t = await told(page);
  check(`${tag} sends nothing`, ctx.loads.length === 0 && t.meta === null && t.google === null && t.tiktok === null && t.published.length === 0, { loads: ctx.loads, t });
  await ctx.close();
}
{
  const tag = '[only Google set]';
  set({ ads_google_id: IDS.ads_google_id, ads_google_booked: IDS.ads_google_booked });
  track = { ...TRACK, id: 'bk_9f3k31' };
  const ctx = await context();
  const page = watch(await ctx.newPage());
  await lairPage(page);
  await book(page);
  const t = await told(page);
  check(`${tag} Google alone hears it (no First booking label: Booked a session only)`,
    JSON.stringify(ctx.loads) === JSON.stringify(['google']) && t.google.filter((a) => a[0] === 'event').length === 1 && t.meta === null && t.tiktok === null, { loads: ctx.loads, t });
  await ctx.close();
  set(IDS);
}
{
  const tag = '[a guest\'s first booking]';
  bookingAnswer = 'track';
  track = { ...TRACK, id: 'bk_9f3k50', kind: 'ttrpg', first: true };
  const ctx = await context();
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/book-a-table', null);
  await page.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend, null, { timeout: 20000 });
  await book(page, { email: 'ash@example.com', phone: '+64 27 555 0123' });
  const t = await told(page);
  const names = (list, at) => (list || []).filter((a) => a[0] === 'trackSingle' || a[0] === 'track' || a[0] === 'event').map((a) => (a[0] === 'event' ? a[2].send_to.split('/')[1] : a[at]));
  check(`${tag} all four: Booked a session and First booking (Google), Schedule and CompleteRegistration (Meta and TikTok)`,
    JSON.stringify(names(t.google)) === JSON.stringify([IDS.ads_google_booked, IDS.ads_google_first])
      && JSON.stringify(names(t.meta, 2)) === JSON.stringify(['Schedule', 'CompleteRegistration'])
      && JSON.stringify(names(t.tiktok, 1)) === JSON.stringify(['Schedule', 'CompleteRegistration']), { google: names(t.google), meta: names(t.meta, 2), tiktok: names(t.tiktok, 1) });
  check(`${tag} matched by what they typed (an overseas-style +64 mobile is E.164 too)`,
    JSON.stringify(t.meta[1]) === JSON.stringify(['init', IDS.ads_meta_pixel, { em: hash('ash@example.com'), ph: hash('64275550123') }]), t.meta[1]);
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await ctx.close();
}
{
  const tag = '[a member who typed nothing]';
  track = { ...TRACK, id: 'bk_9f3k51', first: false };
  const ctx = await context();
  const page = watch(await ctx.newPage());
  await lairPage(page);
  await book(page, {});
  const t = await told(page);
  check(`${tag} their account's email is used (RUBY has no phone on her account), and nothing marks it a first booking`,
    JSON.stringify(t.google.find((a) => a[0] === 'set')) === JSON.stringify(['set', 'user_data', { sha256_email_address: hash('ruby@example.com') }])
      && !t.meta.some((a) => a[2] === 'CompleteRegistration') && !t.tiktok.some((a) => a[1] === 'CompleteRegistration'), { google: t.google, meta: t.meta });
  await ctx.close();
}

/* ---------------- paid clicks keep their credit (the ad tags theme.js keeps) ---------------- */
{
  const tag = '[ad credit]';
  const ctx = await context();
  const page = watch(await ctx.newPage());
  const kept = async () => JSON.parse((await page.evaluate(() => window.localStorage.getItem('lair-ad'))) || 'null');
  const visit = async (query) => {
    await page.goto(`${BASE}/${query}`, { waitUntil: 'networkidle' });
    const k = await kept();
    return k ? `${k.source}/${k.medium}/${k.campaign}` : null;
  };
  check(`${tag} an Eventfinda link is kept`, (await visit('?utm_source=eventfinda&utm_medium=referral&utm_campaign=trivia')) === 'eventfinda/referral/trivia');
  check(`${tag} a Facebook link (fbclid alone) doesn't replace it: Facebook adds fbclid to every link, paid or not`, (await visit('?fbclid=IwAR0test12345')) === 'eventfinda/referral/trivia');
  check(`${tag} a TikTok ad (ttclid) beats the unpaid link`, (await visit('?ttclid=E.C.P.test12345')) === 'tiktok/paid/null');
  check(`${tag} the first paid click stays: a Google ad later doesn't replace it`, (await visit('?gclid=Gtest-1234567890')) === 'tiktok/paid/null');
  await page.evaluate(() => window.localStorage.clear());
  check(`${tag} fbclid alone, nothing kept before: facebook/social`, (await visit('?fbclid=IwAR0test12345')) === 'facebook/social/null');
  check(`${tag} a Meta ad tagged utm_medium=paid beats it`, (await visit('?utm_source=facebook&utm_medium=paid&utm_campaign=new-players&fbclid=IwAR0test12345')) === 'facebook/paid/new-players');
  await page.evaluate(() => window.localStorage.clear());
  check(`${tag} a Google ad's gclid alone is google/cpc`, (await visit('?gclid=Gtest-1234567890')) === 'google/cpc/null');
  await page.evaluate(() => window.localStorage.clear());
  check(`${tag} a gclid makes a link paid whatever its medium says`, (await visit('?utm_source=google&utm_medium=social&gclid=Gtest-1234567890')) === 'google/cpc/null');
  // the paid click goes with the booking to the Lair, pages later
  await page.evaluate(() => window.localStorage.setItem('lair-ad', JSON.stringify({ source: 'eventfinda', medium: 'referral', campaign: null, at: Date.now() - 86400000 })));
  await visit('?utm_source=tiktok&utm_medium=paid&utm_campaign=burst-1&ttclid=E.C.P.test12345');
  bookingAnswer = 'track';
  track = { ...TRACK, id: 'bk_9f3k52' };
  bodies = [];
  await go(page, BASE, '/pages/book-a-table', RUBY);
  await page.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend, null, { timeout: 20000 });
  await book(page);
  const sentAd = (bodies.find((b) => b && b.kind === 'table') || {}).ad;
  check(`${tag} the booking carries the paid click's tags to the Lair`, JSON.stringify(sentAd) === JSON.stringify({ source: 'tiktok', medium: 'paid', campaign: 'burst-1' }), sentAd);
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await ctx.close();
}
{
  const tag = '[demo mode]';
  m.globalSettings.lair_mode = 'demo';
  const ctx = await context();
  const page = watch(await ctx.newPage());
  // (from the review) the lab is demo mode: arriving from an ad there loads nothing either, with IDs set
  await page.goto(`${BASE}/?gclid=Gtest-123456&fbclid=IwAR0test12345&ttclid=E.C.P.test12345`, { waitUntil: 'networkidle' });
  const landing = await told(page);
  check(`${tag} no IDs or tracking.js on the page, and nothing loads arriving from ads`, landing.config === null && !landing.script && ctx.loads.length === 0 && (await cookie(ctx, '_fbc')) === null, { landing, loads: ctx.loads });
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

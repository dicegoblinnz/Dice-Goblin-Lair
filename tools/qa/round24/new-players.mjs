// Round 24 (31 Oct 2026), new players, on the theme mock (contract v24-new-players). Mo (31 Oct 2026): "Happy with welcome
// codes but I want it only given out after their first event at dice goblin not a free dice roll. They need to come and
// pay using their id or qr etc. Then they get a dice for it."
// Demo mode: My Lair's "Got a code?" saves a welcome code with the Lair's words and no Roll it now; Home's card says the
// welcome roll is waiting (in place of "No rolls yet") until a session lands on their card, and then it's a roll; a
// second welcome code is turned away. The staff page's Loot codes lists the four welcome codes with a Welcome badge, makes
// one with the Welcome code tick and switches one with Edit; a member's page says their welcome code.
// Live mode, with a stand-in for the Lair app: the first ad link this browser arrives by is kept for 30 days and a later
// one never replaces it; Google's gclid alone is google/cpc; bookings, TTRPG seats, sign-ups, game spots and weekly seats
// carry the tags and nothing else does; a logged-in customer's tags go to POST /me/ad once; tags over 30 days old are
// replaced and never sent.
// No sideways scroll, no console errors (demo mode), axe. 320, 360, 390 and 430 wide, and 1280.
// Usage: DG_THEME=/path/to/theme [PORT=4989] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round24/new-players.mjs [small|...]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round24-new-players');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, watch, go, clockAt, RUBY, STAFF, today } = lib;
const PORT = Number(process.env.PORT || 4989);
const BASE = `http://localhost:${PORT}`;
const VIEWPORTS = {
  small: { width: 320, height: 640 }, narrow: { width: 360, height: 740 }, phone: { width: 390, height: 844 }, large: { width: 430, height: 932 },
  desktop: { width: 1280, height: 800 },
};
const sizes = process.argv[2] ? [process.argv[2]] : Object.keys(VIEWPORTS);
const SAVED = "Saved! Your welcome roll unlocks after your first paid session at the Lair. Show your member code at the counter when you pay, and it's yours.";
const WAITING = 'Your welcome roll is waiting, friend. It unlocks after your first paid session at the Lair.';
const ONE_EACH = "You've used a welcome code already. It's one per player.";

const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 400) => page.waitForTimeout(ms);

async function context(size) {
  const phone = size !== 'desktop';
  const ctx = await browser.newContext({ viewport: VIEWPORTS[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(clockAt('19:00'));
  return ctx;
}
async function open(page, where, who = RUBY) {
  await go(page, BASE, where, who);
  await page.waitForSelector('[data-stamp-count] strong', { state: 'attached', timeout: 20000 });
  await settle(page);
}
/** The roll box and "Got a code?" as a member sees them */
const box = (page) => page.evaluate(() => {
  const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const ready = document.querySelector('[data-rolls-ready]');
  const said = document.querySelector('[data-claim-message]');
  return {
    ready: ready && !ready.hidden ? f(ready.textContent) : '',
    welcome: f(document.querySelector('.ml-roll__welcome')?.textContent),
    none: f(document.querySelector('.ml-roll__none')?.textContent),
    roll: Boolean(document.querySelector('[data-roll-slots] [data-roll]')),
    said: said && !said.hidden ? { text: f(said.textContent), ok: said.classList.contains('form-message--success') } : null,
    go: Boolean(document.querySelector('[data-claim-go]')),
  };
});
const rolls = (page) => page.evaluate(async () => (await window.Lair.store.backend.me()).loyalty.rolls);
/** Nothing ready to roll, so the card shows what waits (as for someone new) */
const spendAll = (page) => page.evaluate(() => {
  const be = window.Lair.store.backend;
  const id = String(be.cfg.customer.id);
  const view = be.loyaltyFor(be.cfg.customer);
  be.editLoyalty(id, (x) => { x.used = (Number(x.used) || 0) + view.rolls.available; });
  be.commit();
});
async function redeem(page, code) {
  await page.fill('#ml-claim-code', code);
  await page.click('[data-claim] [type="submit"]');
  await page.waitForFunction(() => {
    const said = document.querySelector('[data-claim-message]');
    return said && !said.hidden && said.textContent.trim();
  }, null, { timeout: 10000 });
  await settle(page, 300);
}

/* ---------------- demo mode: My Lair and the staff page ---------------- */
for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';
  m.mockState.before = null;
  const ctx = await context(size);
  const page = watch(await ctx.newPage());
  await open(page, '/pages/my-lair');
  await spendAll(page);
  await open(page, '/pages/my-lair#wallet');
  await redeem(page, 'scroll-roll');
  let b = await box(page);
  check(`${tag} "Got a code?" with SCROLL-ROLL: the Lair's words, said as done, and no Roll it now`, b.said && b.said.ok && b.said.text === SAVED && !b.go, b);
  await page.locator('#ml-code').scrollIntoViewIfNeeded();
  await shot(page, `${size}-1-saved`, '#ml-code');
  await axe(page, `${tag} Got a code? after a welcome code`, '#ml-code');
  let r = await rolls(page);
  check(`${tag} the card has 1 welcome roll waiting and none to roll`, r.waiting === 1 && r.available === 0, r);
  await open(page, '/pages/my-lair');
  b = await box(page);
  check(`${tag} Home's card says the welcome roll is waiting, in place of "No rolls yet", with nothing to roll`, b.welcome === WAITING && !b.none && !b.roll, b);
  await page.locator('.ml-roll').first().scrollIntoViewIfNeeded();
  await shot(page, `${size}-2-waiting`, '.ml-roll');
  await axe(page, `${tag} the loyalty card with a welcome roll waiting`, '.ml-roll');
  // one each
  await open(page, '/pages/my-lair#wallet');
  await redeem(page, 'SEARCH-ROLL');
  b = await box(page);
  check(`${tag} a second welcome code: "${ONE_EACH}"`, b.said && !b.said.ok && b.said.text === ONE_EACH, b);
  // a session on their card (in the demo, any from the day they typed it; the Lair app: their first paid one)
  await page.evaluate(() => {
    const be = window.Lair.store.backend;
    be.editLoyalty(String(be.cfg.customer.id), (x) => {
      x.ledger = [...(Array.isArray(x.ledger) ? x.ledger : []), { id: 'st_qa_first', count: 1, at: Date.now(), title: 'A session at the counter', kind: 'staff' }];
    });
    be.commit();
  });
  await open(page, '/pages/my-lair');
  r = await rolls(page);
  b = await box(page);
  check(`${tag} after their first session: nothing waits, and the roll is ready to roll`, !r.waiting && r.available >= 1 && !b.welcome && b.roll && /^\d+ rolls? ready/.test(b.ready), { r, b });
  check(`${tag} no sideways scroll on My Lair`, (await overflowX(page)) <= 0, await overflowX(page));

  // ---------- the staff page: Loot codes ----------
  await go(page, BASE, '/pages/lair-staff#codes', STAFF);
  await page.waitForSelector('.sa-code', { timeout: 20000 });
  await settle(page, 500);
  const codes = () => page.evaluate(() => [...document.querySelectorAll('.sa-code')].map((li) => ({
    code: li.querySelector('.sa-code__code')?.textContent.trim(),
    badges: [...li.querySelectorAll('.sa-code__tag .badge')].map((x) => x.textContent.trim()),
    rolls: li.querySelector('.sa-code__rolls')?.textContent.replace(/\s+/g, ' ').trim(),
  })));
  let list = await codes();
  const welcomeCodes = ['SEARCH-ROLL', 'SCROLL-ROLL', 'TOK-ROLL', 'UPVOTE-ROLL'];
  check(`${tag} Loot codes lists the four welcome codes, each with a Welcome badge and what it gives`,
    welcomeCodes.every((c) => list.some((x) => x.code === c && x.badges.includes('Welcome') && x.rolls === '1 roll for a new player, once they’ve paid for their first session')), list);
  check(`${tag} ROLL-FOR-LOOT has no Welcome badge`, list.some((x) => x.code === 'ROLL-FOR-LOOT' && !x.badges.includes('Welcome') && x.rolls === '1 roll each time, once per customer'), list);
  await shot(page, `${size}-3-codes`, '.sa-codes');
  // make one with the tick (axe as the form opens: once it's scrolled down to the tick, the site's sticky header sits
  // over the Rolls stepper, which axe counts against its buttons' size)
  await page.click('[data-code-make]');
  await settle(page, 300);
  await axe(page, `${tag} Make a loot code, with Welcome code`, '[data-code-form]');
  await page.fill('#sa-code-code', 'MEET-GOBGOB');
  await page.check('#sa-code-welcome');
  await shot(page, `${size}-4-make`, '[data-code-form]');
  await page.click('[data-code-form] [type="submit"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.sa-code__code')].some((x) => x.textContent.trim() === 'MEET-GOBGOB'), null, { timeout: 10000 });
  list = await codes();
  check(`${tag} made with the tick: MEET-GOBGOB is a welcome code`, list.some((x) => x.code === 'MEET-GOBGOB' && x.badges.includes('Welcome')), list);
  // Edit switches an ordinary one to a welcome code
  const item = page.locator('.sa-code', { hasText: 'ROLL-FOR-LOOT' }).first();
  await item.locator('summary', { hasText: 'Edit' }).click();
  const tick = item.locator('[name="welcome"]');
  check(`${tag} Edit has the Welcome code tick, off for an ordinary code`, (await tick.count()) === 1 && !(await tick.isChecked()));
  await tick.check();
  await item.locator('[type="submit"]').click();
  await page.waitForFunction(() => {
    const li = [...document.querySelectorAll('.sa-code')].find((x) => x.querySelector('.sa-code__code')?.textContent.trim() === 'ROLL-FOR-LOOT');
    return li && [...li.querySelectorAll('.badge')].some((x) => x.textContent.trim() === 'Welcome');
  }, null, { timeout: 10000 }).catch(() => {});
  list = await codes();
  check(`${tag} saved: ROLL-FOR-LOOT now has the Welcome badge`, list.some((x) => x.code === 'ROLL-FOR-LOOT' && x.badges.includes('Welcome')), list);
  check(`${tag} no sideways scroll on Loot codes`, (await overflowX(page)) <= 0, await overflowX(page));

  // ---------- a member's page: their welcome code ----------
  await go(page, BASE, '/pages/lair-staff#members', STAFF);
  await page.waitForSelector('.staff-mem-row', { timeout: 20000 });
  await page.locator('.staff-mem-row', { hasText: 'Ruby Tane' }).first().click().catch(() => {});
  await page.waitForSelector('.staff-person__facts', { timeout: 15000 }).catch(() => {});
  await settle(page, 600);
  const facts = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.staff-person__facts div')].map((d) => [d.querySelector('dt')?.textContent.trim(), d.querySelector('dd')?.textContent.trim()])));
  check(`${tag} Ruby's page: "Welcome code: SCROLL-ROLL · roll unlocked" and "Found us: Not asked yet"`,
    facts['Welcome code'] === 'SCROLL-ROLL · roll unlocked' && facts['Found us'] === 'Not asked yet', facts);
  await shot(page, `${size}-5-member`, '[data-person-loyalty]');
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await ctx.close();
}

/* ---------------- live mode: the ad link they came by ---------------- */
// A stand-in for the Lair app behind /apps/liar: every request is noted, and each gets a small answer
const API = '/apps/liar';
let calls = [];
// what POST /me/ad answers: 200 { saved: true }, or 404 (a Lair app from before round 24)
let adStatus = 200;
m.globalSettings.lair_mode = 'live';
m.mockState.before = async (req, res, url) => {
  if (!url.pathname.startsWith(`${API}/`)) return false;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  const route = url.pathname.slice(API.length);
  calls.push({ method: req.method, route, body });
  if (route === '/me/ad' && adStatus !== 200) {
    res.writeHead(adStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return true;
  }
  const answer = route === '/me/ad' ? { saved: true } : route === '/me' ? { customer: { id: mockState().customer?.id || null }, bookings: [], seats: [], joins: [], games: [], credits: [], member: {} } : { ok: true };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(answer));
  return true;
};
function mockState() {
  return m.mockState;
}
const kept = (page) => page.evaluate(() => {
  try {
    return JSON.parse(window.localStorage.getItem('lair-ad') || 'null');
  } catch {
    return 'blocked';
  }
});
const posts = (route) => calls.filter((c) => c.method === 'POST' && c.route === route);

{
  const tag = '[live]';
  const ctx = await browser.newContext({ viewport: VIEWPORTS.phone });
  const page = await ctx.newPage();
  m.mockState.customer = null;
  await page.goto(`${BASE}/?utm_source=Google&utm_medium=paid&utm_campaign=New%20players%20Nov`, { waitUntil: 'networkidle', timeout: 60000 });
  let k = await kept(page);
  check(`${tag} the first ad link is kept: google, paid, new-players-nov`, k && k.source === 'google' && k.medium === 'paid' && k.campaign === 'new-players-nov' && Math.abs(Date.now() - k.at) < 120000, k);
  await page.goto(`${BASE}/collections/all?utm_source=facebook&utm_medium=paid&utm_campaign=trivia`, { waitUntil: 'networkidle', timeout: 60000 });
  check(`${tag} a later ad link never replaces it`, (await kept(page))?.source === 'google', await kept(page));
  // logged in, a Lair page sends them to their account once
  calls = [];
  await go(page, BASE, '/pages/my-lair', RUBY);
  await page.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend, null, { timeout: 20000 });
  await settle(page, 800);
  check(`${tag} POST /me/ad once logged in, with the kept tags`,
    posts('/me/ad').length === 1 && JSON.stringify(posts('/me/ad')[0].body) === JSON.stringify({ source: 'google', medium: 'paid', campaign: 'new-players-nov' }), posts('/me/ad'));
  // (from the review) only after GET /me, which makes their member record and code from their name
  const order = calls.map((c) => `${c.method} ${c.route}`);
  check(`${tag} POST /me/ad goes after GET /me has answered`, order.indexOf('GET /me') > -1 && order.indexOf('GET /me') < order.indexOf('POST /me/ad'), order);
  check(`${tag} the tags now belong to Ruby's account`, (await kept(page))?.owner === String(RUBY.id) && (await kept(page))?.sent === true, await kept(page));
  calls = [];
  await go(page, BASE, '/pages/my-lair', RUBY);
  await settle(page, 800);
  check(`${tag} and never again from this browser`, posts('/me/ad').length === 0, calls.map((c) => `${c.method} ${c.route}`));
  // what carries them: bookings, TTRPG seats, sign-ups, game spots and weekly seats; nothing else
  calls = [];
  await page.evaluate(async () => {
    const be = window.Lair.store.backend;
    const quiet = (p) => p.catch(() => null);
    await quiet(be.createBooking({ kind: 'table', tables: ['T3'], people: 2, name: 'Ruby' }));
    await quiet(be.joinGame({ gameId: 'g_1', people: 1, name: 'Ruby' }));
    await quiet(be.joinEvent('quiz@2026-11-01', { name: 'Ruby', people: 1 }));
    await quiet(be.reserveEvent('warhammer@2026-11-03', { name: 'Ruby', people: 2 }));
    await quiet(be.joinSeries('g_2', { name: 'Ruby', people: 1 }));
    await quiet(be.updateBooking('bk_1', { status: 'cancelled' }));
    await quiet(be.redeemCode('SCROLL-ROLL'));
  });
  const withAd = calls.filter((c) => c.body && typeof c.body === 'object' && c.body.ad);
  check(`${tag} a table, a TTRPG seat, a sign-up, a game spot and a weekly seat carry the tags`,
    JSON.stringify(withAd.map((c) => c.route).sort()) === JSON.stringify(['/bookings', '/bookings', '/events/quiz@2026-11-01/join', '/events/warhammer@2026-11-03/reserve', '/games/g_2/join-series'].sort())
      && withAd.every((c) => JSON.stringify(c.body.ad) === JSON.stringify({ source: 'google', medium: 'paid', campaign: 'new-players-nov' })), calls);
  check(`${tag} a change to a booking and a code don't`, calls.some((c) => c.route === '/bookings/bk_1/update' && !c.body.ad) && calls.some((c) => c.route === '/me/codes/redeem' && !c.body.ad), calls);
  // (from the review) someone else logging in on this browser isn't credited to Ruby's ad
  const KIRI = { ...RUBY, id: 7700445566, first_name: 'Kiri', last_name: 'Smith', name: 'Kiri Smith', email: 'kiri@example.com' };
  calls = [];
  await go(page, BASE, '/pages/my-lair', KIRI);
  await page.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend, null, { timeout: 20000 });
  await settle(page, 800);
  await page.evaluate(() => window.Lair.store.backend.createBooking({ kind: 'table', name: 'Kiri' }).catch(() => null));
  check(`${tag} Kiri on the same browser: no POST /me/ad, and her booking carries no tags`,
    posts('/me/ad').length === 0 && posts('/bookings').length === 1 && !posts('/bookings')[0].body.ad, calls.map((c) => `${c.method} ${c.route} ${JSON.stringify(c.body?.ad || null)}`));
  // over 30 days old: never sent, and the next ad link replaces it
  await page.evaluate(() => window.localStorage.setItem('lair-ad', JSON.stringify({ source: 'google', medium: 'paid', campaign: 'old', at: Date.now() - 31 * 24 * 3600 * 1000 })));
  calls = [];
  await page.evaluate(() => window.Lair.store.backend.createBooking({ kind: 'table', name: 'Ruby' }).catch(() => null));
  check(`${tag} tags over 30 days old aren't sent`, calls.length === 1 && !calls[0].body.ad, calls);
  m.mockState.customer = null;
  await page.goto(`${BASE}/?utm_source=TikTok&utm_medium=paid`, { waitUntil: 'networkidle', timeout: 60000 });
  k = await kept(page);
  check(`${tag} and the next ad link replaces them`, k && k.source === 'tiktok' && k.medium === 'paid' && k.campaign === null, k);
  await ctx.close();
  // Google's own tag alone, in a new browser
  const ctx2 = await browser.newContext({ viewport: VIEWPORTS.desktop });
  const page2 = await ctx2.newPage();
  await page2.goto(`${BASE}/?gclid=Cj0KCQjw-qa`, { waitUntil: 'networkidle', timeout: 60000 });
  k = await kept(page2);
  check(`${tag} Google's gclid alone is google/cpc`, k && k.source === 'google' && k.medium === 'cpc' && k.campaign === null, k);
  await page2.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 60000 });
  check(`${tag} a plain visit keeps nothing new`, (await kept(page2))?.medium === 'cpc', await kept(page2));
  // (from the review) a Lair app without POST /me/ad: the 404 waits a day, not every page
  adStatus = 404;
  calls = [];
  await go(page2, BASE, '/pages/my-lair', RUBY);
  await page2.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend, null, { timeout: 20000 });
  await settle(page2, 800);
  const tried = posts('/me/ad').length;
  calls = [];
  await go(page2, BASE, '/pages/my-lair', RUBY);
  await settle(page2, 800);
  const retry = (await kept(page2))?.retryAt;
  check(`${tag} refused once, it waits a day before trying again`, tried === 1 && posts('/me/ad').length === 0 && retry > Date.now() + 23 * 3600 * 1000 && !(await kept(page2))?.sent, { tried, again: posts('/me/ad').length, retry });
  adStatus = 200;
  await ctx2.close();
}

/* ---------------- (from the review) the staff page with a Lair app that doesn't know welcome codes ---------------- */
{
  const tag = '[older Lair]';
  m.globalSettings.lair_mode = 'demo';
  m.mockState.before = null;
  const ctx = await context('phone');
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/lair-staff#codes', STAFF);
  await page.waitForSelector('.sa-code', { timeout: 20000 });
  // the demo's codes as an older Lair app lists them (nothing says welcome), then the list loaded again (All)
  await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const real = be.rollCodes.bind(be);
    be.rollCodes = async (...a) => {
      const data = await real(...a);
      return { codes: data.codes.map(({ welcome, ...rest }) => rest) };
    };
  });
  await page.click('label.chip:has([data-code-status][value="all"])');
  await page.waitForFunction(() => !document.querySelector('[data-code-list]')?.textContent.includes('Loading'), null, { timeout: 10000 });
  await settle(page, 300);
  await page.click('[data-code-make]');
  await settle(page, 300);
  check(`${tag} no Welcome code tick on Make a loot code, so it can't quietly make a code that pays at once`, (await page.locator('[data-code-form] [name="welcome"]').count()) === 0);
  await page.locator('.sa-code').first().locator('summary', { hasText: 'Edit' }).click();
  check(`${tag} nor on Edit`, (await page.locator('.sa-code').first().locator('[name="welcome"]').count()) === 0);
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await ctx.close();
}

const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed (today ${today}; shots in ${process.env.OUT})`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

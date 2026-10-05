// Round 6, library holds: reserving a library game, in demo mode through the theme mock, phone (390x844) then desktop
// (1280x800). Prints a PASS or FAIL line for each check and exits 1 on any FAIL.
// Usage: DG_THEME=/path/to/theme [PORT=4732] node tools/qa/round6/library.mjs [phone|desktop]
// The page clock is pinned to Monday 5 October 2026, 5pm in Auckland (NZDT), so a hold made then is held until midnight
// at the end of Wednesday 7 October (round 7: the third day, counting the day it's made; the until is 00:00 Thursday).
// One more check pins it to Friday 2 April 2027, 9pm, two days before daylight saving ends: held until midnight at the
// end of Sunday 4 April (00:00 Monday NZST). The mock's library copies have fixed ids (theme-mock/render.mjs), and the
// demo seeds a hold by another member on 7 Wonders Duel (assets/lair-demo.js).
// Needs: npm install in tools/qa/theme-mock, and Playwright at /opt/node-tools/node_modules/playwright.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4732);
const BASE = `http://localhost:${PORT}`;
const OUT = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const only = process.argv[2];

// Made-up people (example.com), one for each kind of visitor
const STASH = { id: 7700500001, first_name: 'Kiri', last_name: 'Moana', name: 'Kiri Moana', email: 'kiri.moana@example.com', phone: null, tags: ['Goblin Treasure - Board Game Rental'], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const GRAB = { id: 7700500002, first_name: 'Tane', last_name: 'Rua', name: 'Tane Rua', email: 'tane.rua@example.com', phone: null, tags: ['Goblin Loot - Board Game Rental'], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const PLAIN = { id: 7700500003, first_name: 'Pat', last_name: 'Reader', name: 'Pat Reader', email: 'pat.reader@example.com', phone: null, tags: [], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };

// The mock's library copies (product 810000000000NN, variant 481000000000NN)
const GAME = {
  baker: { path: '/products/221b-baker-street', variant: '48100000000002', title: '221B Baker Street: The Master Detective Game' },
  duel: { path: '/products/7-wonders-duel-library', variant: '48100000000005', title: '7 Wonders Duel' },
  codenames: { path: '/products/codenames', variant: '48100000000006', title: 'Codenames' },
  island: { path: '/products/forbidden-island', variant: '48100000000008', title: 'Forbidden Island' },
};

const clockAt = (ms) => `(() => { const OFFSET = ${ms} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;
const MONDAY_5PM = Date.UTC(2026, 9, 5, 4, 0); // Mon 5 Oct 2026, 5pm NZDT
const WEDNESDAY_MIDNIGHT = Date.UTC(2026, 9, 7, 11, 0); // 00:00 Thu 8 Oct 2026 NZDT: "midnight, Wed 7 Oct" (round 7)
const FRIDAY_9PM = Date.UTC(2027, 3, 2, 8, 0); // Fri 2 Apr 2027, 9pm NZDT (daylight saving ends Sun 4 Apr, 3am)
const SUNDAY_MIDNIGHT_NZST = Date.UTC(2027, 3, 4, 12, 0); // 00:00 Mon 5 Apr 2027 NZST: "midnight, Sun 4 Apr" (round 7)

let failed = 0;
const results = [];
const check = (tag, ok, what, detail = '') => {
  if (!ok) failed += 1;
  const line = `${ok ? 'PASS' : 'FAIL'} ${tag} | ${what}${detail ? ` | ${detail}` : ''}`;
  results.push(line);
  console.log(line);
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const server = await m.serve(PORT);
const browser = await chromium.launch();

async function context(size, at = MONDAY_5PM) {
  const vp = SIZES[size];
  const phone = vp.width < 700;
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(clockAt(at));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) page.errors.push(`console: ${msg.text()}`);
  });
  return { ctx, page };
}

/** A page as someone (the mock renders lair-config for them; the demo's state is this browser's, shared by all) */
async function visit(page, who, path) {
  m.mockState.customer = who;
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  if (path.startsWith('/products/')) await page.waitForSelector('library-reserve[data-state]', { timeout: 10000 });
  if (path.startsWith('/pages/my-lair')) await page.waitForSelector('[data-panel="bookings"]:not([aria-busy])', { state: 'attached', timeout: 10000 });
  await page.waitForTimeout(300);
}
const state = (page) => page.getAttribute('library-reserve', 'data-state');
const block = async (page) => flat(await page.locator('library-reserve [data-reserve-body]').innerText());
const holdsInDemo = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('dg-lair-demo-v3') || '{}').libraryHolds || []);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const size of Object.keys(SIZES).filter((s) => !only || s === only)) {
  const { ctx, page } = await context(size);
  const tag = size;

  // 1. Logged out: "Log in to reserve", and logging in comes back to this game
  await visit(page, null, GAME.baker.path);
  const login = page.locator('library-reserve a', { hasText: 'Log in to reserve' });
  const loginHref = (await login.count()) ? await login.getAttribute('href') : '';
  check(tag, (await state(page)) === 'available' && loginHref === '/customer_authentication/login?return_to=%2Fproducts%2F221b-baker-street',
    'logged out: Log in to reserve, back to this page', loginHref);
  check(tag, (await overflow(page)) === 0, 'game page: no sideways scroll');

  // 2. Logged in without a plan: "Join the library to reserve games", to the plans
  await visit(page, PLAIN, GAME.baker.path);
  const join = page.locator('library-reserve a', { hasText: 'Join the library to reserve games' });
  const joinHref = (await join.count()) ? await join.getAttribute('href') : '';
  check(tag, /#plans$/.test(joinHref) && !(await page.locator('[data-reserve]').count()), 'no plan: Join the library to reserve games, no Reserve button', joinHref);

  // 3. A member reserves it: held until midnight on the third day, counting the day it's made (round 7: made Monday,
  // held until midnight Wednesday)
  await visit(page, STASH, GAME.baker.path);
  const offer = await block(page);
  check(tag, offer.includes('1 copy on the shelf') && offer.includes("we'll hold it until midnight, Wed 7 Oct"), 'member: copies on the shelf and the hold time before reserving', offer);
  await page.click('[data-reserve]');
  await page.waitForSelector('library-reserve[data-state="mine"]', { timeout: 5000 }).catch(() => {});
  const mine = await block(page);
  const made = (await holdsInDemo(page)).find((h) => h.variantId === GAME.baker.variant && h.customerId === String(STASH.id));
  check(tag, (await state(page)) === 'mine' && mine.includes("You've reserved this") && mine.includes("We're holding it until midnight, Wed 7 Oct."),
    'member reserves: "You\'ve reserved this. We\'re holding it until midnight, Wed 7 Oct."', mine);
  check(tag, Boolean(made) && made.until === WEDNESDAY_MIDNIGHT && made.status === 'held', 'the hold ends at midnight at the end of Wednesday, Lair time', made ? new Date(made.until).toISOString() : 'no hold');
  check(tag, mine.includes('Cancel my reservation') && (await page.locator('library-reserve a[href*="my-lair#ml-library"]').count()) === 1, 'theirs: Cancel my reservation and a link to My Lair');
  await page.waitForTimeout(200); // the live region speaks a moment later, so the same words twice still count
  const said = await page.locator('[data-reserve-say]').textContent();
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.matches('[data-reserve-status]'));
  check(tag, /Reserved!/.test(said || '') && focused, 'reserving is announced, and focus stays on the block', flat(said));
  await page.locator('library-reserve').screenshot({ path: `${OUT}${tag}-library-mine.png` });

  // 4. Another member sees it reserved, with when it's back on the shelf, and no button
  await visit(page, GRAB, GAME.baker.path);
  const other = await block(page);
  check(tag, (await state(page)) === 'reserved' && other.includes("It's back on the shelf by midnight, Wed 7 Oct if it isn't collected.") && !(await page.locator('[data-reserve]').count()),
    'another member: "Reserved right now. It\'s back on the shelf by midnight, Wed 7 Oct if it isn\'t collected."', other);
  // and the demo's seeded hold: Aroha has 7 Wonders Duel until midnight at the end of Tuesday (made Sunday evening)
  await visit(page, GRAB, GAME.duel.path);
  check(tag, (await state(page)) === 'reserved' && (await block(page)).includes('midnight, Tue 6 Oct'), 'a seeded hold by another member shows as reserved', await block(page));
  await page.locator('library-reserve').screenshot({ path: `${OUT}${tag}-library-reserved.png` });

  // 5. The plan's limit: a Grab member (1 game) with one reserved gets the app's own words
  await visit(page, GRAB, GAME.island.path);
  const many = await block(page);
  await page.click('[data-reserve]');
  await page.waitForSelector('library-reserve[data-state="mine"]', { timeout: 5000 }).catch(() => {});
  check(tag, many.includes('3 copies on the shelf') && (await state(page)) === 'mine', 'a game with 3 copies: reserve one');
  await visit(page, GRAB, GAME.island.path);
  check(tag, (await block(page)).includes("You've reserved this"), 'theirs again on a fresh visit');
  await visit(page, STASH, GAME.island.path);
  check(tag, (await block(page)).includes('2 of 3 copies on the shelf'), 'another member: 2 of 3 copies on the shelf', await block(page));
  await visit(page, GRAB, GAME.codenames.path);
  await page.click('[data-reserve]');
  await page.waitForSelector('library-reserve .library-reserve__error', { timeout: 5000 }).catch(() => {});
  const limit = flat(await page.locator('library-reserve .library-reserve__error').textContent().catch(() => ''));
  const mineLink = page.locator('library-reserve .library-reserve__error a[href$="my-lair#ml-library"]', { hasText: 'See My Library' });
  check(tag, limit.startsWith("Your plan has 1 game at a time, and you've got 1: 1 reserved. Return one or cancel a hold first.")
    && (await page.getAttribute('library-reserve .library-reserve__error', 'role')) === 'alert' && (await mineLink.count()) === 1,
  'plan limit: the 409 message, as it comes, and a link to their reserved games', limit);
  await page.locator('library-reserve').screenshot({ path: `${OUT}${tag}-library-limit.png` });

  // 5b. Someone else got the last copy while the page was open: the 409 leaves the page saying it's reserved
  await visit(page, STASH, GAME.codenames.path);
  await page.evaluate((variantId) => {
    const be = window.Lair.store.backend;
    const now = Date.now();
    be.libraryHoldList().push({ id: 'lh-race', customerId: '8394581110001', variantId, productId: null, title: 'Codenames', shelfCode: 'DGL7+-015', handle: 'codenames', until: be.holdUntil(now), status: 'held', createdAt: now, staffNote: '' });
  }, GAME.codenames.variant);
  await page.click('[data-reserve]');
  await page.waitForSelector('library-reserve[data-state="reserved"]', { timeout: 5000 }).catch(() => {});
  const race = await block(page);
  const raceFocus = await page.evaluate(() => document.activeElement && document.activeElement.matches('[data-reserve-status]'));
  check(tag, (await state(page)) === 'reserved' && race.includes("It's back on the shelf by midnight, Wed 7 Oct") && !race.includes('Every copy') && raceFocus,
    'beaten to the last copy: the page says it\'s reserved now, focus on the news', race);
  await page.evaluate(() => {
    const be = window.Lair.store.backend;
    be.state.libraryHolds = be.libraryHoldList().filter((h) => h.id !== 'lh-race');
    be.save();
  });

  // 6. Cancelling frees it, by keyboard: it asks first, and focus goes back to Reserve
  await visit(page, STASH, GAME.baker.path);
  await page.focus('[data-reserve-cancel]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-reserve-cancel-yes]');
  const askFocus = await page.evaluate(() => document.activeElement && document.activeElement.textContent.trim());
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await page.waitForSelector('library-reserve[data-state="available"]', { timeout: 5000 }).catch(() => {});
  const afterFocus = await page.evaluate(() => document.activeElement && document.activeElement.matches('[data-reserve]'));
  check(tag, askFocus === 'Keep it' && (await state(page)) === 'available' && afterFocus, 'cancel by keyboard: asks first (focus on Keep it), then focus back on Reserve', `ask focus ${askFocus}`);
  await visit(page, GRAB, GAME.baker.path);
  check(tag, (await state(page)) === 'available', 'cancel frees it: another member sees it on the shelf');

  // 7. My Lair: the hold, how many the plan allows, and one that ended (the demo's Wyrmspan, ran out yesterday)
  await visit(page, STASH, GAME.island.path);
  await page.click('[data-reserve]');
  await page.waitForSelector('library-reserve[data-state="mine"]', { timeout: 5000 }).catch(() => {});
  await visit(page, STASH, '/pages/my-lair');
  // Round 7 (contract v7 18.3): Home's reserved-games row went, and Me's list moved to My Library, the Library section's
  // <my-library> (the library agent's component, checked in its own round 7 check). My Lair counts the holds on Home's
  // Library card and hands GET /me to <my-library>.
  check(tag, (await page.locator('[data-home-holds]').count()) === 0, 'My Lair Home: no reserved-games row (My Library lists them)');
  const libCard = flat(await page.locator('.ml-sum--library').innerText());
  check(tag, /\b1 of 3\b/.test(libCard) && /1 held/.test(libCard), 'My Lair Home: the Library card counts the hold, 1 of 3 games', libCard);
  await page.click('.ml-bar [data-view-link="library"]');
  await page.waitForSelector('[data-view="library"]:not([hidden])');
  await page.waitForTimeout(200);
  const handed = await page.evaluate(() => {
    const lair = document.querySelector('my-lair');
    const el = document.querySelector('[data-view="library"] my-library');
    const hold = ((lair.me && lair.me.holds) || []).find((h) => h.title === 'Forbidden Island' && h.status === 'held');
    return { container: Boolean(el), plans: el && el.dataset.plansUrl, hold: hold ? { id: hold.id, shelf: hold.shelfCode, until: hold.until } : null };
  });
  check(tag, handed.container && /#plans$/.test(handed.plans || '') && handed.hold && handed.hold.shelf === 'DGL34-052', 'My Lair Library: <my-library> is there, and GET /me (its me) has the hold', handed);
  await page.locator('[data-view="library"]').screenshot({ path: `${OUT}${tag}-mylair-holds.png` });
  // cancelled in My Library: it asks My Lair to fetch GET /me again (lair:refresh), and Home's card follows
  await page.evaluate(async (id) => {
    await window.Lair.store.backend.cancelLibraryHold(id);
    const lair = document.querySelector('my-lair');
    lair.querySelector('my-library').dispatchEvent(new CustomEvent('lair:refresh', { bubbles: true }));
    await lair.loading;
  }, handed.hold && handed.hold.id);
  const after = await page.evaluate(() => `${document.querySelector('[data-sum="library"]').textContent} / ${document.querySelector('[data-sum="library-more"]').textContent}`);
  check(tag, /^0 of 3 \/ 0 held/.test(after), 'My Lair: after a cancel in My Library, Home\'s Library card says 0 of 3', after);
  check(tag, (await overflow(page)) === 0, 'My Lair: no sideways scroll');

  // 8. Staff: the Library tab marks a hold collected, and puts one back on the shelf (with Undo)
  await visit(page, STASH, GAME.baker.path);
  await page.click('[data-reserve]');
  await page.waitForSelector('library-reserve[data-state="mine"]', { timeout: 5000 }).catch(() => {});
  await visit(page, STAFF, '/pages/lair-staff');
  await page.click('[data-tab="library"]');
  await page.waitForSelector('.staff-lib-rows', { timeout: 10000 });
  await page.waitForTimeout(200);
  const list = flat(await page.locator('[data-lib-list]').innerText());
  const first = list.indexOf('7 Wonders Duel');
  check(tag, list.includes('Forbidden Island') && list.includes('Tane Rua') && list.includes('221B Baker Street') && list.includes('Kiri Moana') && first >= 0 && first < list.indexOf('Forbidden Island'),
    'staff: active holds, soonest first, with the member and their code', list.slice(0, 160));
  const island = page.locator('.staff-lib', { hasText: 'Forbidden Island' });
  await island.locator('[data-lib-act="collected"]').click();
  await page.waitForTimeout(300);
  const collected = (await holdsInDemo(page)).find((h) => h.variantId === GAME.island.variant && h.customerId === String(GRAB.id));
  check(tag, flat(await island.innerText()).includes('Collected') && collected && collected.status === 'collected', 'staff: Collected');
  const baker = page.locator('.staff-lib', { hasText: '221B Baker Street' });
  await baker.locator('[data-lib-act="released"]').click();
  await page.waitForTimeout(300);
  const released = (await holdsInDemo(page)).find((h) => h.variantId === GAME.baker.variant && h.status !== 'cancelled' && h.customerId === String(STASH.id));
  const undoFocus = await page.evaluate(() => document.activeElement && document.activeElement.textContent.trim());
  check(tag, flat(await baker.innerText()).includes('Back on the shelf') && released && released.status === 'released' && undoFocus === 'Undo', 'staff: Put back on the shelf, with Undo (focused)', undoFocus);
  await baker.locator('[data-lib-act="held"]').click();
  await page.waitForTimeout(300);
  const again = (await holdsInDemo(page)).find((h) => h.id === released.id);
  check(tag, again && again.status === 'held' && again.until === WEDNESDAY_MIDNIGHT, 'staff: Undo holds it again, until midnight on the third day');
  await page.locator('[data-panel="library"]').screenshot({ path: `${OUT}${tag}-staff-library.png` });
  check(tag, (await overflow(page)) === 0, 'staff page: no sideways scroll');
  // a scanned member card says what they've reserved
  const code = await page.evaluate((id) => (JSON.parse(localStorage.getItem('dg-lair-demo-v3')).members.find((x) => String(x.customerId) === id) || {}).code, String(STASH.id));
  await page.fill('#checkin-code', code || '');
  await page.press('#checkin-code', 'Enter');
  await page.waitForSelector('.checkin-card--member', { timeout: 5000 }).catch(() => {});
  const card = flat(await page.locator('.checkin-card--member').innerText().catch(() => ''));
  check(tag, card.includes('1 game reserved: 221B Baker Street'), 'staff: a scanned member card says what they have reserved', card.slice(0, 160));

  check(tag, page.errors.length === 0, 'no console or page errors', page.errors.slice(0, 3).join(' | '));
  await ctx.close();

  // 9. Daylight saving: made Friday 2 April 2027 at 9pm (NZDT), held until midnight at the end of Sunday 4 April (NZST)
  const late = await context(size, FRIDAY_9PM);
  await visit(late.page, STASH, GAME.codenames.path);
  await late.page.click('[data-reserve]');
  await late.page.waitForSelector('library-reserve[data-state="mine"]', { timeout: 5000 }).catch(() => {});
  const dst = (await holdsInDemo(late.page)).find((h) => h.variantId === GAME.codenames.variant && h.customerId === String(STASH.id));
  check(tag, Boolean(dst) && dst.until === SUNDAY_MIDNIGHT_NZST && (await block(late.page)).includes('midnight, Sun 4 Apr'), 'daylight saving: made Fri 9pm, held until midnight Sun (NZST)', dst ? new Date(dst.until).toISOString() : 'no hold');
  check(tag, late.page.errors.length === 0, 'no console or page errors (daylight saving)', late.page.errors.slice(0, 3).join(' | '));
  await late.ctx.close();
}

await browser.close();
server.close();
console.log(failed ? `library: ${failed} FAILED of ${results.length}` : `library: all ${results.length} passed`);
process.exit(failed ? 1 : 0);

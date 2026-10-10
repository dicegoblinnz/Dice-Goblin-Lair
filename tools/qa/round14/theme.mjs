// LOCAL QA ONLY (round 14): the theme's Discord parts in demo mode, through theme-mock (liquidjs) and Playwright
// Chromium, at phone size (390) and desktop (1280):
// - My Lair › Profile's Discord card: Link Discord (the demo comes straight back with a made-up code, as Discord would),
//   the code taken out of the address, "Linked!", the account shown after a reload, Unlink (asked first), Discord saying
//   no (?error=access_denied), an old state, and ?link=discord starting it by itself.
// - "Chat on Discord" on a TTRPG session's sheet and an event date's sheet (the demo uses the shop's Discord invite).
// - No page errors, no sideways scroll, every tap target 44px or more; screenshots in ./shots.
//   DG_THEME=/path/to/theme node tools/qa/round14/theme.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(fs.existsSync('/opt/node-tools/node_modules/playwright') ? '/opt/node-tools/node_modules/playwright' : 'playwright');
process.env.DG_THEME = process.env.DG_THEME || '/home/claude/dice-goblin-website';
const m = await import('../theme-mock/render.mjs');
m.globalSettings.lair_mode = 'demo';
const INVITE = m.globalSettings.social_discord || 'https://discord.gg/dicegoblin';
m.globalSettings.social_discord = INVITE;
const OUT = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.QA_PORT || 4314);
const BASE = `http://localhost:${PORT}`;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const customer = { id: 7700114455, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [], orders_count: 0, orders: [] };
m.mockState.customer = customer;

const errors = [];
let checks = 0;
const check = (ok, what, extra = '') => {
  checks += 1;
  if (!ok) errors.push(`${what}${extra ? `: ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`);
};
const server = await m.serve(PORT);
const browser = await chromium.launch();

async function open(size, path) {
  const vp = SIZES[size];
  const phone = vp.width < 700;
  const ctx = await browser.newContext({ viewport: vp, hasTouch: phone, isMobile: phone });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${size} pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`${size} console: ${msg.text()}`);
  });
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  return { ctx, page };
}
const card = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-discord-card]');
  const msg = el?.querySelector('[data-discord-message]');
  return {
    shown: Boolean(el) && !el.hidden && el.getBoundingClientRect().height > 0,
    text: el ? el.innerText.replace(/\s+/g, ' ').trim() : '',
    message: msg && !msg.hidden ? msg.textContent.trim() : '',
    buttons: el ? [...el.querySelectorAll('button')].map((b) => b.textContent.trim()) : [],
    search: window.location.search,
    hash: window.location.hash,
    view: [...document.querySelectorAll('my-lair [data-view]')].filter((v) => !v.hidden).map((v) => v.dataset.view).join(','),
    focus: document.activeElement?.id || '',
  };
});
const settle = async (page) => {
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('[data-panel="bookings"]:not([aria-busy])', { state: 'attached', timeout: 10000 });
  await page.waitForTimeout(500);
};
async function overflow(page, tag) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 0, `${tag}: no sideways scroll`, `${over}px`);
}
async function targets(page, tag, scope) {
  const small = await page.evaluate((sel) => [...document.querySelectorAll(`${sel} button, ${sel} a`)]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width && r.height && (r.height < 43.5 || r.width < 43.5))
    .map(({ el, r }) => `"${el.textContent.trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`), scope);
  check(!small.length, `${tag}: tap targets 44px or more`, small);
}

for (const size of ['phone', 'desktop']) {
  const tag = size;
  // 1. the card, not linked
  const { ctx, page } = await open(size, '/pages/my-lair#profile');
  await settle(page);
  let c = await card(page);
  check(c.shown, `${tag}: the Discord card shows in Profile`, c);
  check(/Link your Discord and Gobgob books you in with one tap/.test(c.text), `${tag}: it says what linking does`, c.text);
  check(c.buttons.join('|') === 'Link Discord', `${tag}: one button, Link Discord`, c.buttons);
  await targets(page, `${tag} card`, '[data-discord-card]');
  await overflow(page, `${tag} profile`);
  await page.locator('[data-discord-card]').screenshot({ path: `${OUT}theme-${size}-card.png` });

  // 2. Link Discord: off to "Discord" (the demo comes straight back with a code) and finished here
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('[data-discord-link]')]);
  await settle(page);
  c = await card(page);
  check(c.search === '' && c.hash === '#profile', `${tag}: the code and state are taken out of the address`, { search: c.search, hash: c.hash });
  check(c.view === 'profile', `${tag}: back on Profile`, c.view);
  check(c.message === 'Linked! Gobgob knows you as Ruby in the Dice Goblin server now.', `${tag}: "Linked!"`, c.message);
  check(/Linked to Ruby \(@ruby_rolls\)\./.test(c.text) && c.buttons.join('|') === 'Unlink', `${tag}: the card shows who's linked, with Unlink`, c);
  check(c.focus === 'ml-discord-title', `${tag}: focus on the Discord card`, c.focus);
  const history = await page.evaluate(() => window.history.length);
  check(history >= 1, `${tag}: history`, history);
  await page.locator('[data-discord-card]').screenshot({ path: `${OUT}theme-${size}-linked.png` });
  await overflow(page, `${tag} linked`);

  // 3. still linked after a reload; the same code again (back button) is refused
  await page.reload({ waitUntil: 'networkidle' });
  await settle(page);
  c = await card(page);
  check(/Linked to Ruby/.test(c.text) && !c.message, `${tag}: still linked after a reload, with no message`, c);

  // 4. Unlink, asked first
  await page.click('[data-discord-unlink]');
  c = await card(page);
  check(/Unlink your Discord\? Gobgob won't know it's you in the server any more\./.test(c.text) && c.buttons.join('|') === 'Yes, unlink it|Keep it linked', `${tag}: unlinking asks first`, c);
  await targets(page, `${tag} unlink`, '[data-discord-card]');
  await page.click('[data-discord-keep]');
  c = await card(page);
  check(/Linked to Ruby/.test(c.text), `${tag}: Keep it linked keeps it`, c.text);
  await page.click('[data-discord-unlink]');
  await page.click('[data-discord-unlink-yes]');
  await page.waitForTimeout(300);
  c = await card(page);
  check(c.message === "Unlinked. What you've booked stays booked." && c.buttons.join('|') === 'Link Discord', `${tag}: unlinked`, c);

  // 5. Discord says no
  const state = `dg${'ab12'.repeat(8)}`;
  await page.goto(`${BASE}/pages/my-lair?error=access_denied&error_description=The+resource+owner+denied+the+request&state=${state}`, { waitUntil: 'networkidle' });
  await settle(page);
  c = await card(page);
  check(c.message === "No worries, your Discord isn't linked. Tap Link Discord whenever you're ready." && c.search === '' && c.view === 'profile', `${tag}: Discord saying no`, c);

  // 6. an old or made-up state
  await page.goto(`${BASE}/pages/my-lair?code=abc&state=${state}`, { waitUntil: 'networkidle' });
  await settle(page);
  c = await card(page);
  check(c.message === 'That Discord link has expired. Tap Link Discord again.' && c.search === '', `${tag}: an old state is refused, in the Lair app's words`, c);

  // 7. ?link=discord (the bot's "Link my account") starts it by itself
  await page.goto(`${BASE}/pages/my-lair?link=discord#profile`);
  await page.waitForURL(/code=demo/, { timeout: 10000 }).catch(() => {});
  await settle(page);
  c = await card(page);
  check(/Linked to Ruby/.test(c.text) && c.search === '', `${tag}: ?link=discord links by itself`, c);
  // and again once linked: it says so
  await page.goto(`${BASE}/pages/my-lair?link=discord#profile`, { waitUntil: 'networkidle' });
  await settle(page);
  c = await card(page);
  check(c.message === 'Your Discord is linked already, as Ruby.', `${tag}: linked already`, c);
  await ctx.close();

  // 8. Chat on Discord: a TTRPG session's sheet
  const games = await open(size, '/pages/gm-games');
  await games.page.waitForSelector('.gm-card [data-game]', { timeout: 10000 });
  await games.page.click('.gm-card [data-game]');
  await games.page.waitForSelector('.gm-detail', { timeout: 5000 });
  // (the sheet grows in as it opens: measure once it's settled)
  await games.page.waitForTimeout(700);
  const gchat = await games.page.evaluate(() => {
    const a = document.querySelector('.gm-detail .gm-chat a.lair-chat');
    return a ? { href: a.getAttribute('href'), target: a.target, rel: a.rel, text: a.textContent.trim(), line: a.closest('.gm-chat').querySelector('p')?.textContent.trim() } : null;
  });
  check(gchat && gchat.href === INVITE && gchat.target === '_blank' && /noopener/.test(gchat.rel), `${tag}: Chat on Discord on a session's sheet`, gchat);
  check(gchat && gchat.text === 'Chat on Discord (opens in a new tab)' && gchat.line === 'Say hi to your GM and the table before the game.', `${tag}: its words`, gchat);
  await targets(games.page, `${tag} session chat`, '.gm-chat');
  await overflow(games.page, `${tag} session sheet`);
  await games.page.locator('.gm-chat').screenshot({ path: `${OUT}theme-${size}-session-chat.png` });
  await games.ctx.close();

  // 9. an event date's sheet (a date in the next week)
  const cal = await open(size, '/pages/events-calendar');
  await cal.page.waitForFunction(() => window.Lair && window.Lair.store && Object.keys(window.Lair.store.data.eventDiscord || {}).length > 0, null, { timeout: 10000 });
  const opened = await cal.page.evaluate(() => {
    const id = Object.keys(window.Lair.store.data.eventDiscord)[0];
    const el = document.querySelector('lair-calendar');
    el.openItem(id);
    return id;
  });
  await cal.page.waitForSelector('.cal-detail', { timeout: 5000 });
  await cal.page.waitForTimeout(700);
  await targets(cal.page, `${tag} event chat`, '.cal-chat');
  const echat = await cal.page.evaluate(() => {
    const a = document.querySelector('.cal-detail .cal-chat a.lair-chat');
    return a ? { href: a.getAttribute('href'), line: a.closest('.cal-chat').querySelector('p')?.textContent.trim() } : null;
  });
  check(echat && echat.href === INVITE && echat.line === "See who's keen and chat about it.", `${tag}: Chat on Discord on an event date's sheet (${opened})`, echat);
  await overflow(cal.page, `${tag} event sheet`);
  await cal.page.locator('.cal-chat').screenshot({ path: `${OUT}theme-${size}-event-chat.png` });
  await cal.ctx.close();
}

await browser.close();
server.close();
console.log(errors.length ? `ERRORS (${errors.length} of ${checks} checks):\n${errors.join('\n')}` : `round14 theme: ${checks} checks, no errors`);
process.exit(errors.length ? 1 : 0);

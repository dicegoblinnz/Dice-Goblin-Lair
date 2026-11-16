// Round 42 (17 Nov 2026): the staff page's Riddles tab (contract v41-quests, section 4) and the d20 roller telling the
// Lair its pick for Rolled it, on the theme mock in demo mode, phone (390x844) then desktop (1280x800).
//   1. Riddles: the tab is there for staff with Members; the weeks from last week to four ahead, with the gap line; a
//      solved riddle has no Remove; Write one on the empty week (its week picked, the Lair's words for an empty riddle
//      and an unknown box, then saved and the gap line covered); Edit on a solved riddle offers only its words; Edit
//      on an unsolved one changes its answer; Remove asks first, Keep it keeps it, Remove it takes it off.
//   2. The d20 roller: logged in, with the Lair live and Quests in My Lair ticked, a roll POSTs the pick's product to
//      /pick/rolled; logged out, or quests off, nothing goes.
// No sideways scroll, no console errors, and the tab's buttons are 44px or more to tap on a phone.
// Usage: DG_THEME=/path/to/theme [PORT=4994] node tools/qa/round42-riddles/demo.mjs [phone|desktop]
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
const PORT = Number(process.env.PORT || 4994);
const BASE = `http://localhost:${PORT}`;
const OUT = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const only = process.argv[2];

// Made-up people (example.com)
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const MEMBER = { id: 7700600003, first_name: 'Pat', last_name: 'Reader', name: 'Pat Reader', email: 'pat.reader@example.com', phone: null, tags: [], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };

let failed = 0;
const check = (tag, ok, what, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${tag} | ${what}${detail ? ` | ${String(detail).slice(0, 300)}` : ''}`);
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const server = await m.serve(PORT);
const browser = await chromium.launch();

async function context(size) {
  const vp = SIZES[size];
  const phone = vp.width < 700;
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) page.errors.push(`console: ${msg.text()}`);
  });
  return { ctx, page, phone };
}
async function visit(page, who, path) {
  m.mockState.customer = who;
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const small = (page, selector) => page.evaluate((sel) => {
  const out = [];
  for (const el of document.querySelectorAll(`${sel} button, ${sel} a.button, ${sel} input:not([type="checkbox"]), ${sel} select`)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || el.closest('[hidden]')) continue;
    if (r.height < 44 || r.width < 44) out.push(`${el.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)} "${(el.textContent || el.name || '').trim().slice(0, 30)}"`);
  }
  return out;
}, selector);

for (const size of Object.keys(SIZES)) {
  if (only && only !== size) continue;
  const tag = size;
  const { ctx, page, phone } = await context(size);

  /* ---------- 1. the Riddles tab ---------- */
  await visit(page, STAFF, '/pages/lair-staff');
  await page.evaluate(() => localStorage.clear());
  await visit(page, STAFF, '/pages/lair-staff');
  await page.waitForFunction(() => typeof document.querySelector('lair-staff')?.setTab === 'function' && document.querySelector('#tab-riddles'), null, { timeout: 10000 });
  const tabs = await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map((x) => x.textContent.trim()));
  check(tag, tabs.indexOf('Riddles') === tabs.indexOf('Members') + 1, 'the Riddles tab is there, after Members', tabs.join(', '));
  await page.evaluate(() => document.querySelector('lair-staff').setTab('riddles'));
  await page.waitForSelector('staff-riddles .sr-weeks', { timeout: 10000 });
  const R = page.locator('staff-riddles');
  const week = (n) => R.locator('.sr-week').nth(n);
  let text = flat(await R.innerText());
  check(tag, text.startsWith('Gobgob’s riddles') && text.includes('out in My Lair from 10am Monday'), 'the head says what a riddle is and when it\'s out', text.slice(0, 200));
  check(tag, (await R.locator('.sr-week').count()) === 5, 'five weeks: last week, this week and three ahead', await R.locator('.sr-week').count());
  check(tag, /^1 of the next 4 weeks has no riddle \(\w{3} \d{1,2} \w{3}\)\.$/.test(flat(await R.locator('.sr-cover').innerText())), 'the gap line names the empty week', await R.locator('.sr-cover').innerText());
  text = flat(await week(0).innerText());
  check(tag, text.startsWith('Last week') && text.includes('Done') && text.includes('Mysterium') && text.includes('Solved by 3 players') && !text.includes('Remove'), 'last week: done, solved by 3, no Remove', text);
  text = flat(await week(1).innerText());
  check(tag, text.startsWith('This week') && /Out (now|at 10am today)/.test(text) && text.includes('Forbidden Island') && text.includes('Hint 3–4 player shelf') && text.includes('Solved by 1 player') && !text.includes('Remove'), 'this week: out, its hint and answer, solved by 1, no Remove', text);
  text = flat(await week(2).innerText());
  check(tag, text.startsWith('Next week') && text.includes('7 Wonders Duel') && text.includes('Remove'), 'next week: coming, with Remove', text);
  text = flat(await week(3).innerText());
  check(tag, text.startsWith('In 2 weeks') && text.includes('No riddle yet') && /Write one for \w{3} \d{1,2} \w{3}/.test(text), 'the empty week asks for one', text);
  await page.screenshot({ path: `${OUT}${tag}-1-weeks.png`, fullPage: !phone });
  if (phone) check(tag, (await small(page, 'staff-riddles')).length === 0, 'the tab\'s buttons are 44px or more', (await small(page, 'staff-riddles')).join(', '));

  // Write one for the empty week
  const emptyWeek = await week(3).getAttribute('data-sr-week');
  await week(3).locator('[data-sr-write]').click();
  const form = R.locator('[data-sr-new-box] form');
  await form.waitFor();
  check(tag, (await form.locator('[name="week"]').inputValue()) === emptyWeek, 'its week is picked in the form');
  const options = await form.locator('[name="week"] option').evaluateAll((os) => os.map((o) => o.value));
  check(tag, !options.includes(await week(2).getAttribute('data-sr-week')) && options.length >= 8, 'the picker has only weeks with no riddle', options.join());
  check(tag, await page.evaluate(() => document.activeElement?.name === 'text'), 'the riddle box has focus');
  await form.locator('[type="submit"]').click();
  text = flat(await form.locator('[data-error-name="text"]').innerText());
  check(tag, text === 'Write the riddle: up to 400 characters.', 'an empty riddle is said under it', text);
  await form.locator('[name="text"]').fill('Knights, a crumbling kingdom, and far too many workers to feed. Gobgob built a chapel and forgot the walls.');
  check(tag, /^\d+ of 400$/.test(flat(await form.locator('[data-sr-count]').innerText())), 'the count follows the typing', await form.locator('[data-sr-count]').innerText());
  await form.locator('[name="hint"]').fill('3–4 player shelf, big boxes.');
  await form.locator('[name="code"]').fill('NOPE-404');
  await form.locator('[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('staff-riddles [data-sr-new-box] [data-error-name="code"]')?.hidden, null, { timeout: 5000 }).catch(() => {});
  text = flat(await form.locator('[data-error-name="code"]').innerText());
  check(tag, text.startsWith('Gobgob can’t find a library game') || text.startsWith("Gobgob can't find a library game"), 'an unknown box is said under the answer', text);
  await page.screenshot({ path: `${OUT}${tag}-2-write.png`, fullPage: !phone });
  if (phone) check(tag, (await small(page, 'staff-riddles [data-sr-new-box]')).length === 0, 'the form\'s fields and buttons are 44px or more', (await small(page, 'staff-riddles [data-sr-new-box]')).join(', '));
  await form.locator('[name="code"]').fill('DGL34-094');
  await form.locator('[type="submit"]').click();
  await page.waitForSelector(`staff-riddles .sr-week.is-new[data-sr-week="${emptyWeek}"]`, { timeout: 5000 }).catch(() => {});
  text = flat(await R.locator(`.sr-week[data-sr-week="${emptyWeek}"]`).innerText());
  check(tag, text.includes('Paladins of the West Kingdom') && text.includes('DGL34-094') && text.includes('Remove'), 'saved: the week has the riddle and its answer', text);
  check(tag, flat(await R.locator('.sr-cover').innerText()).startsWith('The next 4 weeks have riddles, up to'), 'the gap line says they\'re covered', await R.locator('.sr-cover').innerText());
  check(tag, await page.evaluate((w) => document.activeElement?.id === `sr-w-${w}`, emptyWeek), 'focus is on the saved week');
  check(tag, (await R.locator('[data-sr-new-box]').isHidden()), 'the form closed');

  // Edit a solved riddle: only its words
  await week(1).locator('[data-sr-edit]').click();
  let edit = week(1).locator('form');
  check(tag, (await edit.locator('[name="week"]').count()) === 0 && (await edit.locator('[name="code"]').count()) === 0, 'a solved riddle\'s week and answer are fixed');
  text = flat(await edit.innerText());
  check(tag, text.includes('1 player solved it, so its week and answer stay.'), 'and it says why', text.slice(0, 200));
  await edit.locator('[name="text"]').fill('Four treasures, one sinking island. Gobgob still can’t swim.');
  await edit.locator('[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('staff-riddles .sr-week:nth-child(2) form'), null, { timeout: 5000 }).catch(() => {});
  text = flat(await week(1).innerText());
  check(tag, text.includes('Gobgob still can’t swim.') && text.includes('Forbidden Island'), 'its words changed, its answer stayed', text);

  // Edit an unsolved one: a new answer
  await week(2).locator('[data-sr-edit]').click();
  edit = week(2).locator('form');
  check(tag, (await edit.locator('[name="code"]').getAttribute('placeholder')) === 'DGL12-001', 'the answer field shows the box it has now');
  await edit.locator('[name="code"]').fill('DGL7+-056');
  await edit.locator('[type="submit"]').click();
  await page.waitForFunction(() => /Mysterium/.test(document.querySelector('staff-riddles .sr-week:nth-child(3)')?.textContent || '') && !document.querySelector('staff-riddles .sr-week:nth-child(3) form'), null, { timeout: 5000 }).catch(() => {});
  text = flat(await week(2).innerText());
  check(tag, text.includes('Mysterium') && !text.includes('7 Wonders Duel'), 'the answer changed', text);

  // Remove: asks first
  const last = R.locator('.sr-week').last();
  const lastWeek = await last.getAttribute('data-sr-week');
  await last.locator('[data-sr-remove]').click();
  text = flat(await last.locator('.sr-confirm').innerText());
  check(tag, text.includes('Take') && text.includes('riddle off? Players won’t see it'), 'Remove asks first', text);
  check(tag, await page.evaluate(() => document.activeElement?.textContent.trim() === 'Keep it'), 'focus is on Keep it');
  await page.screenshot({ path: `${OUT}${tag}-3-remove.png`, fullPage: !phone });
  await last.locator('[data-sr-remove-no]').click();
  check(tag, (await last.locator('.sr-confirm').count()) === 0 && flat(await last.innerText()).includes('Jenga'), 'Keep it keeps it');
  await last.locator('[data-sr-remove]').click();
  await last.locator('[data-sr-remove-yes]').click();
  await page.waitForFunction((w) => document.querySelector(`staff-riddles .sr-week[data-sr-week="${w}"]`)?.classList.contains('is-empty'), lastWeek, { timeout: 5000 }).catch(() => {});
  check(tag, await R.locator(`.sr-week[data-sr-week="${lastWeek}"]`).evaluate((el) => el.classList.contains('is-empty')), 'Remove it takes it off: the week is empty again');
  check(tag, flat(await R.locator('.sr-cover').innerText()).startsWith('1 of the next 4 weeks has no riddle'), 'and the gap line says so');
  check(tag, (await overflow(page)) === 0, 'no sideways scroll');
  check(tag, page.errors.length === 0, 'staff: no console or page errors', page.errors.slice(0, 3).join(' | '));
  await page.screenshot({ path: `${OUT}${tag}-4-after.png`, fullPage: !phone });

  /* ---------- 2. the d20 roller tells the Lair its pick ---------- */
  if (!phone) {
    const sent = [];
    await page.route('**/pick/rolled', async (route) => {
      sent.push({ url: route.request().url(), body: route.request().postDataJSON() });
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    const roll = async () => {
      await page.waitForSelector('d20-roller [data-roll]:not([hidden])', { timeout: 10000 });
      await page.locator('d20-roller [data-roll]').first().click();
      await page.waitForSelector('d20-roller .roll-pick:not(.roll-pick--loading)', { timeout: 15000 });
      await page.waitForTimeout(400);
    };
    m.globalSettings.lair_mode = 'live';
    m.globalSettings.lair_quests = true;
    await visit(page, MEMBER, '/');
    const attr = await page.locator('d20-roller').first().getAttribute('data-rolled');
    check(tag, attr === `${m.globalSettings.lair_api || '/apps/liar'}/pick/rolled`, 'logged in, live, quests on: the roller has the Lair\'s address', attr);
    await roll();
    const pickedUrl = await page.locator('d20-roller .roll-pick__title a').first().getAttribute('href');
    check(tag, sent.length === 1 && /^\d+$/.test(String(sent[0].body.productId)), 'a roll sends its pick\'s product', JSON.stringify(sent));
    const handle = pickedUrl.split('/products/')[1];
    const product = await page.evaluate(async (h) => (await (await fetch(`/products/${h}.js`)).json().catch(() => null)), handle).catch(() => null);
    if (product && product.id) check(tag, String(product.id) === String(sent[0] && sent[0].body.productId), 'the product sent is the one shown', `${product.id} vs ${sent[0] && sent[0].body.productId}`);
    sent.length = 0;
    await visit(page, null, '/');
    check(tag, (await page.locator('d20-roller[data-rolled]').count()) === 0, 'logged out: no address');
    await roll();
    check(tag, sent.length === 0, 'logged out: nothing sent', JSON.stringify(sent));
    m.globalSettings.lair_quests = false;
    await visit(page, MEMBER, '/');
    check(tag, (await page.locator('d20-roller[data-rolled]').count()) === 0, 'quests off: no address');
    m.globalSettings.lair_mode = 'demo';
    check(tag, page.errors.filter((e) => !/Lair app/.test(e)).length === 0, 'home: no console or page errors', page.errors.slice(0, 3).join(' | '));
  }
  await ctx.close();
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);

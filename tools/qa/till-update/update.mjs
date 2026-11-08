// The till updates itself (layout chat, 9 Nov 2026; Mo: "Yes please"). On the theme mock, the till in the demo with
// Sales on Practice, its own page served through the check so its files can "change":
//   1. it reads its page when it starts; nothing changed, or a page that isn't the till's (logged out): no update
//   2. the till's file changed: it knows, but never reloads with staff on it, or with the customer screen just touched
//   3. a minute untouched on the customer screen: it reloads itself, and comes back as the newer till
//   4. never twice within half an hour; and never without the internet (it waits, then goes)
// Usage: DG_THEME=/path/to/theme [PORT=4992] node tools/qa/till-update/update.mjs
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-till-update');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, watch } = lib;
const PORT = Number(process.env.PORT || 4992);
const BASE = `http://localhost:${PORT}`;

m.globalSettings.lair_mode = 'demo';
m.mockState.sectionSettings = { 'lair-till': { sales: 'practice' } };
const server = await m.serve(PORT);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });

// the shop's side: which version of the till's file the page names, whether the internet's up, and a logged-out page
const shop = { version: 1, offline: false, loggedOut: false, reads: 0 };
await ctx.route((url) => url.pathname === '/pages/till', async (route) => {
  const fetchByTill = route.request().resourceType() === 'fetch';
  if (fetchByTill) shop.reads += 1;
  if (fetchByTill && shop.offline) return route.abort('internetdisconnected');
  const res = await route.fetch();
  let body = await res.text();
  if (shop.version > 1) body = body.replace('src="/assets/lair-till.js"', `src="/assets/lair-till.js?v=${shop.version}"`);
  if (fetchByTill && shop.loggedOut) body = body.replace(/<script type="application\/json" data-till-config>[\s\S]*?<\/script>/, '');
  return route.fulfill({ response: res, body });
});
const page = watch(await ctx.newPage());
let loads = 0;
page.on('load', () => { loads += 1; });
const wait = (ms) => page.waitForTimeout(ms);
const till = (fn, arg) => page.evaluate(fn, arg);
const state = () => till(() => {
  const t = document.querySelector('lair-till');
  const s = t.s;
  return { ready: Boolean(t.updateReady), start: Boolean(t.startSig), mode: s.mode, view: s.view, version: (document.querySelector('script[src*="lair-till.js"]')?.getAttribute('src') || '').split('?v=')[1] || '1' };
});
const checkNow = async () => {
  await till(() => document.querySelector('lair-till').checkUpdate());
  await wait(300);
};
const quiet = () => till(() => { document.querySelector('lair-till').s.idleAt = Date.now() - 61000; });

await page.goto(`${BASE}/pages/till`);
await page.waitForSelector('[data-act="staff-door"]', { timeout: 20000 });
await wait(1200);

/* ---------- 1. it reads its page when it starts ---------- */
let st = await state();
check('it reads its own page when it starts', shop.reads >= 1 && st.start && !st.ready, { reads: shop.reads, st });
await checkNow();
st = await state();
check('nothing changed: no update', !st.ready, st);
shop.loggedOut = true;
await checkNow();
shop.loggedOut = false;
st = await state();
check('a page that isn\'t the till\'s (logged out): not an update', !st.ready, st);

/* ---------- 2. the till's file changed: it waits for a quiet moment ---------- */
shop.version = 2;
await checkNow();
st = await state();
check('the till\'s file changed: it knows there\'s a newer till', st.ready, st);
const before = loads;
// staff on the till, untouched a minute (under the 2 minutes that sends it back to customers): not now
await page.locator('[data-r="over"] [data-act="staff-door"]').click();
await wait(300);
await page.locator('[data-r="over"] [data-act="pick"]').first().click();
await wait(300);
for (const d of '1234') await page.locator(`[data-r="over"] [data-act="digit"][data-d="${d}"]`).click();
await wait(500);
await quiet();
await wait(2500);
st = await state();
check('staff on the till: it doesn\'t reload', loads === before && st.mode === 'staff', { loads, st });
// the customer screen, touched just now: not yet
await till(() => document.querySelector('lair-till').toWelcome());
await wait(2500);
st = await state();
check('the customer screen, touched just now: not yet', loads === before && st.view === 'welcome', { loads, st });

/* ---------- 3. a minute untouched on the customer screen: it reloads itself ---------- */
await quiet();
await page.waitForEvent('load', { timeout: 10000 }).catch(() => null);
await page.waitForSelector('[data-act="staff-door"]', { timeout: 20000 });
await wait(1200);
st = await state();
check('a minute untouched on the customer screen: it reloads itself, as the newer till', loads === before + 1 && st.version === '2' && !st.ready, { loads, st });

/* ---------- 4. never twice within half an hour; never without the internet ---------- */
shop.version = 3;
await checkNow();
await quiet();
await wait(2500);
st = await state();
check('changed again within half an hour: it waits', st.ready && loads === before + 1 && st.version === '2', { loads, st });
await till(() => sessionStorage.setItem('dg-till-reloaded', String(Date.now() - 31 * 60000)));
shop.offline = true;
await quiet();
await wait(2500);
st = await state();
check('half an hour on, but no internet: it waits (a reload would leave an error page)', loads === before + 1 && st.version === '2', { loads, st });
shop.offline = false;
await quiet();
await page.waitForEvent('load', { timeout: 10000 }).catch(() => null);
await page.waitForSelector('[data-act="staff-door"]', { timeout: 20000 });
await wait(1200);
st = await state();
check('the internet back: it reloads, as the newer till', loads === before + 2 && st.version === '3' && !st.ready, { loads, st });
check('no console errors', page.errors.length === 0, page.errors);

const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed`);
m.mockState.sectionSettings = null;
await browser.close();
server.close?.();
process.exit(fail ? 1 : 0);

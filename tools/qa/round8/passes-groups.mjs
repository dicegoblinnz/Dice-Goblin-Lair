// Round 8: a group made while the pass form is open shows up in its Group list (Mo, 6 Oct: "even though I made a group I
// cannot select it when I attempt to make a pass"). Demo mode on the theme mock, phone then desktop: open Issue a pass,
// make a group under Groups, come back: the group is in the list; Group chosen again asks for the list again; and a
// group's own "Issue a pass" opens the form on that group even when the form was already open.
// Usage: DG_THEME=/path/to/theme PORT=4881 node tools/qa/round8/passes-groups.mjs [phone|desktop]   (exits 1 on a FAIL)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4881);
const BASE = `http://localhost:${PORT}`;
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};
const options = (page) => page.$$eval('[data-pass-group] option', (els) => els.map((o) => o.textContent.trim()));

const server = await m.serve(PORT);
const browser = await chromium.launch();
m.mockState.customer = STAFF;
for (const size of process.argv[2] ? [process.argv[2]] : ['phone', 'desktop']) {
  const phone = size === 'phone';
  const ctx = await browser.newContext({ viewport: SIZES[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/pages/lair-staff`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('[data-tab="passes"]');
  await page.waitForSelector('[data-pass-issue]', { timeout: 10000 });
  await page.click('[data-pass-issue]');
  await page.waitForSelector('[data-pass-new]');
  await page.waitForFunction(() => !document.querySelector('[data-pass-group]').disabled || /No groups/.test(document.querySelector('[data-pass-group]').textContent), null, { timeout: 5000 });
  const before = await options(page);
  check(`${size}: the form lists the groups there are`, before.some((o) => /Thursday Warhammer league/.test(o)) && !before.some((o) => /Round 8 Club/.test(o)), before);
  // Mo's way: leave the form open, make a group, come back
  const made = await page.evaluate(async () => {
    const be = window.Lair.store.backend;
    const person = (await be.findCustomers('hemi')).customers[0];
    return (await be.createGroup({ name: 'Round 8 Club', organiser: person, members: [person] })).group;
  });
  await page.click('[data-tab="groups"]');
  await page.waitForTimeout(400);
  await page.click('[data-tab="passes"]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-pass-group] option')].some((o) => /Round 8 Club/.test(o.textContent)), null, { timeout: 5000 }).catch(() => {});
  const after = await options(page);
  check(`${size}: back on Passes, the group made since is in the list`, after.some((o) => /Round 8 Club \(1 person\)/.test(o)), after);
  const enabled = await page.evaluate(() => !document.querySelector('[data-pass-group]').disabled);
  check(`${size}: …and the list can be used`, enabled);
  // Group chosen again asks again (another group made while the form shows)
  await page.evaluate(async () => {
    const be = window.Lair.store.backend;
    const person = (await be.findCustomers('aroha')).customers[0];
    await be.createGroup({ name: 'Round 8 Second Club', organiser: person, members: [person] });
  });
  await page.check('[data-pass-owner-pick][value="customer"]', { force: true });
  await page.check('[data-pass-owner-pick][value="group"]', { force: true });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-pass-group] option')].some((o) => /Round 8 Second Club/.test(o.textContent)), null, { timeout: 5000 }).catch(() => {});
  check(`${size}: choosing Group again catches a group made meanwhile`, (await options(page)).some((o) => /Round 8 Second Club/.test(o)), await options(page));
  // A group's own Issue a pass, with the form already open: it opens on that group
  await page.evaluate((g) => document.querySelector('lair-staff').showPassForm(null, g), made);
  await page.waitForFunction(() => document.querySelector('[data-pass-group] option:checked')?.textContent.includes('Round 8 Club'), null, { timeout: 5000 }).catch(() => {});
  const chosen = await page.evaluate(() => document.querySelector('[data-pass-group] option:checked')?.textContent.trim());
  check(`${size}: a group's Issue a pass opens the form on that group, even with the form open`, /^Round 8 Club/.test(chosen || ''), chosen);
  // and the pass goes to the group
  await page.fill('#pass-new-label', 'Round 8 Club: 10 sessions');
  await page.click('[data-pass-new] button[type="submit"]');
  await page.waitForSelector('[data-pass-card]', { timeout: 10000 }).catch(() => {});
  const card = (await page.textContent('[data-pass-card]').catch(() => '')).replace(/\s+/g, ' ');
  check(`${size}: the pass belongs to the group`, /Round 8 Club/.test(card), card.slice(0, 200));
  check(`${size}: no script errors`, !errors.length, errors);
  await ctx.close();
}
await browser.close();
server.close();
console.log(`passes-groups: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Round 7, staff-admin helper: axe-core (WCAG 2.x A and AA) on what round 7 changed on the staff page, in demo mode at
// 390px and 1280px: the Groups tab (list, a new group, a group's page), Loot codes (list, the form, Edit open), Events
// (list, the form, a Remove asking), the pass form's owner choice, a member's page (profile and gifts), the birthdays
// list and a member card at check-in. Prints each view's violations (none is "0 violations"); exits 1 if any.
// Usage: DG_THEME=/path/to/theme PORT=4843 AXE=/path/to/axe.min.js node tools/qa/round7/staff-admin-axe.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const AXE = process.env.AXE || '/tmp/claude-0/-home-claude/5328840b-74f5-55ee-90fc-cbd04e2b255c/scratchpad/audit/performance/node_modules/axe-core/axe.min.js';
if (!process.env.DG_THEME || !fs.existsSync(AXE)) {
  console.error('Set DG_THEME to the theme checkout, and AXE to axe-core/axe.min.js.');
  process.exit(2);
}
const axe = fs.readFileSync(AXE, 'utf8');
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4843);
m.mockState.customer = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const server = await m.serve(PORT);
const browser = await chromium.launch();
let total = 0;

async function scan(page, label, selector = 'lair-staff') {
  await page.addScriptTag({ content: axe });
  const result = await page.evaluate(async (sel) => {
    const r = await window.axe.run(document.querySelector(sel), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  }, selector);
  total += result.length;
  console.log(`${label}: ${result.length} violations${result.length ? `\n  ${result.join('\n  ')}` : ''}`);
}

for (const [size, vp] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 800 }]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, isMobile: size === 'phone', hasTouch: size === 'phone' });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/pages/lair-staff#groups`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('.sa-row', { timeout: 10000 });
  await scan(page, `${size} groups list`);
  await page.click('[data-group-new]');
  await scan(page, `${size} a new group`);
  await page.click('[data-group-back]');
  await page.locator('.sa-row').first().click();
  await page.waitForSelector('[data-group-people] .sa-person');
  await page.locator('[data-group-confirm^="remove:"]').first().click();
  await scan(page, `${size} a group's page (taking someone out asks)`);
  await page.click('[data-tab="codes"]');
  await page.waitForSelector('.sa-code');
  await page.click('[data-code-make]');
  await page.locator('.sa-code__edit > summary').first().click();
  await scan(page, `${size} loot codes (the form, and Edit open)`);
  await page.click('[data-tab="events"]');
  await page.waitForSelector('.sa-event');
  await page.locator('[data-event-ask]').first().click();
  await scan(page, `${size} events list (Remove asking)`);
  await page.click('[data-event-new]');
  await page.check('[data-event-form] [name="repeat"][value="weekly"]', { force: true });
  await scan(page, `${size} the event form`);
  await page.click('[data-event-back]');
  await page.click('[data-tab="passes"]');
  await page.click('[data-pass-issue]');
  await page.check('[data-pass-owner-pick][value="customer"]', { force: true });
  await page.fill('#find-pass', 'hemi');
  await page.waitForSelector('[data-owner-panel="customer"] [data-pick]');
  await page.click('[data-owner-panel="customer"] [data-pick]');
  await scan(page, `${size} the pass form (a customer picked)`);
  await page.click('[data-tab="members"]');
  await page.waitForSelector('.staff-mem-row');
  await scan(page, `${size} members and birthdays`);
  await page.locator('.staff-mem-row', { hasText: 'Aroha Ngata' }).click();
  await page.waitForSelector('[data-person-gifts] .staff-gifts__item', { timeout: 10000 });
  await scan(page, `${size} a member's page (profile, gifts)`);
  const code = await page.evaluate(async () => (await window.Lair.store.backend.members({ q: 'wiremu' }))[0].code);
  await page.fill('#checkin-code', code);
  await page.click('.checkin__go');
  await page.waitForSelector('.checkin-card--member');
  await scan(page, `${size} a member card with a group's pass`, '.checkin');
  await ctx.close();
}
console.log(`staff-admin axe: ${total} violations in all`);
await browser.close();
server.close();
process.exitCode = total ? 1 : 0;

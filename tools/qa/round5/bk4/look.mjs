// Quick look at the staff page: each tab, errors and sideways scroll. Usage: node look.mjs phone|desktop [prefix]
import { m, chromium, open, shot, overflow, STAFF, PORT } from './lib.mjs';
const tag = process.argv[2] || 'phone';
const prefix = process.argv[3] || 'look';
const server = await m.serve(PORT);
const browser = await chromium.launch();
m.mockState.customer = STAFF;
const { ctx, page } = await open(browser, tag, '/pages/lair-staff');
for (const tab of ['floor', 'today', 'passes', 'members', 'holds', 'games']) {
  await page.click(`[data-tab="${tab}"]`);
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('.staff-tabs').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(150);
  await shot(page, `${tag}-${prefix}-${tab}`);
  console.log(tab, 'overflow', await overflow(page));
}
console.log('errors', page.errors);
await ctx.close();
await browser.close();
server.close();

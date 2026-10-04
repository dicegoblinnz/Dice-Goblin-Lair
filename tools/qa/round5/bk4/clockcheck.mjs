// Is the page clock where LAIR_AT says, and does it keep going across a reload?
import { m, chromium, open, STAFF, PORT } from './lib.mjs';
const server = await m.serve(PORT);
const browser = await chromium.launch();
m.mockState.customer = STAFF;
const { ctx, page } = await open(browser, 'phone', '/pages/lair-staff');
const show = () => page.evaluate(() => `${new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' })} | today ${window.Lair.store.time.today()} | ${Date.now()}`);
console.log('page clock:', await show());
await page.waitForTimeout(1500);
await page.reload({ waitUntil: 'networkidle' });
console.log('after reload:', await show());
console.log('errors', page.errors);
await ctx.close();
await browser.close();
server.close();

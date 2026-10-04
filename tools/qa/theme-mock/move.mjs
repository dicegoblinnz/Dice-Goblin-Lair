import { serve } from './render.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const server = await serve(4180);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:4180/pages/lair-staff', { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
async function run(target) {
await page.evaluate((t) => { window.__target = t; }, target);
return page.evaluate(async () => {
  const { store } = window.Lair;
  const staff = document.querySelector('lair-staff');
  const now = Date.now();
  const { booking } = await store.mutate('createBooking', { kind: 'walkin', tables: ['T9', 'T10'], start: now, end: now + 2 * 3600000, people: 6, name: 'Pair test', status: 'seated', pay: 'day', paid: false, email: '', activity: 'board', extras: [] });
  staff.moving = booking.id;
  await staff.tapTable(window.__target);
  const moved = store.data.bookings.find((b) => b.id === booking.id);
  const toast = document.querySelector('.toast, [data-toast]')?.textContent || '';
  await store.mutate('updateBooking', booking.id, { status: 'cancelled' });
  return { lookback: store.lookbackDays, tables: moved.tables, toast };
});
}
for (const target of ['P1', 'G3', 'T20']) {
  const result = await run(target);
  console.log('move pair to', target, '->', result.tables.join(','), '| toast:', result.toast.trim().slice(0, 90));
}
console.log('errors:', errors);
await browser.close(); server.close();

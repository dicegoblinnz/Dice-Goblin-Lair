// Look: My Lair's bill (tab card), the series card, the passes and the gifts, phone and desktop
import { start, stop, open, shotOf, report, overflow, errors, view } from './harness.mjs';
const PREFIX = process.argv[2] || 'look';
await start();
for (const size of ['phone', 'desktop']) {
  const { ctx, page, tag } = await open(size);
  await view(page, 'tab');
  await shotOf(page, '#ml-tab', `${PREFIX}-tab-${size}`);
  await view(page, 'bookings');
  await shotOf(page, '#ml-seats', `${PREFIX}-seats-${size}`);
  await view(page, 'wallet');
  await shotOf(page, '#ml-passes', `${PREFIX}-passes-${size}`);
  await view(page, 'profile');
  await shotOf(page, '#ml-birthday', `${PREFIX}-bday-${size}`);
  const bill = await page.locator('[data-tab-card]').innerText().catch(() => 'no bill');
  console.log(tag, 'BILL:', bill.replace(/\s+/g, ' '));
  const series = await page.locator('.ml-ticket--series').innerText().catch(() => 'no series card');
  console.log(tag, 'SERIES:', series.replace(/\s+/g, ' '));
  console.log(tag, 'NAV:', (await page.locator('.ml-nav').innerText()).replace(/\s+/g, ' '));
  await overflow(page, tag);
  await ctx.close();
}
report(PREFIX);
await stop();

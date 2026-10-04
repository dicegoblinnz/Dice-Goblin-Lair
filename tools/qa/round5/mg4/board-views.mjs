// The board for staff (every session, held seats counted) and logged out (next sessions only), plus the events
// calendar and the staff page for console errors with the new floor
import { start, stop, open, report, errors, shot, overflow, customer } from './harness.mjs';
const PREFIX = process.argv[2] || 'views';
const flat = (s) => s.replace(/\s+/g, ' ').trim();
await start();
for (const size of ['phone', 'desktop']) {
  // a regular first (seeds Ruby as a regular at Abomination Vaults), then staff in the same browser
  const { ctx, page } = await open(size, '/pages/my-lair');
  await page.waitForTimeout(300);
  const staff = { ...customer, id: 7700119999, first_name: 'Sam', last_name: 'Staff', name: 'Sam Staff', email: 'sam.staff@example.com', tags: ['staff'] };
  const s = await open(size, '/pages/gm-games', { ctx, customer: staff, label: 'staff' });
  const av = flat(await s.page.locator('.gm-card', { hasText: 'Abomination Vaults' }).innerText());
  if (!/more dates/.test(av)) errors.push(`${s.tag}: staff don't see the later dates: ${av}`);
  console.log(s.tag, 'card:', av.slice(0, 120));
  // a later session: the regular holds a seat there
  await s.page.locator('.gm-card', { hasText: 'Abomination Vaults' }).locator('[data-game]').click();
  await s.page.waitForSelector('[data-sheet][open]');
  const dates = await s.page.locator('.gm-date').count();
  if (dates < 3) errors.push(`${s.tag}: staff see ${dates} dates`);
  await s.page.locator('.gm-date').nth(1).click();
  await s.page.waitForTimeout(400);
  const own = flat(await s.page.locator('.gm-own').innerText());
  console.log(s.tag, 'later session:', own.slice(0, 160));
  if (!/held for regulars/.test(own)) errors.push(`${s.tag}: a later session doesn't say a seat is held for a regular: ${own.slice(0, 200)}`);
  await shot(s.page, `${PREFIX}-staff-later-${size}`);
  await overflow(s.page, s.tag);
  // logged out: next sessions only
  const out = await open(size, '/pages/gm-games', { ctx, customer: null, label: 'out' });
  const cards = await out.page.locator('.gm-card').allInnerTexts();
  const avOut = flat(cards.find((c) => c.includes('Abomination')) || '');
  if (/more dates/.test(avOut) || !/Weekly · \d+ regulars?/.test(avOut)) errors.push(`${out.tag}: logged-out card: ${avOut}`);
  await out.page.locator('.gm-card', { hasText: 'Abomination Vaults' }).locator('[data-game]').click();
  await out.page.waitForSelector('[data-sheet][open]');
  const sheet = flat(await out.page.locator('[data-sheet]').innerText());
  if (/Upcoming dates/.test(sheet)) errors.push(`${out.tag}: logged out sees every date`);
  await out.page.locator('[data-sheet] [data-close]').click();
  await overflow(out.page, out.tag);
  // the events calendar and the staff page load cleanly with the new floor
  const cal = await open(size, '/pages/events-calendar', { ctx, customer, label: 'calendar' });
  await cal.page.waitForTimeout(800);
  await overflow(cal.page, cal.tag);
  const st = await open(size, '/pages/lair-staff', { ctx, customer: staff, label: 'staffpage' });
  await st.page.waitForTimeout(1200);
  await overflow(st.page, st.tag);
  await ctx.close();
}
report(PREFIX);
await stop();

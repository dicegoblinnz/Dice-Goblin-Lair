// Booking page, live: a soft-held Warhammer table books with the heads-up, a locked event's tables are unavailable,
// "use my pass" is sent and the ticket shows the pass and the QR, "split the bill" is sent, and there's no pay-online
// option. Phone (390×844) first, then desktop.
import fs from 'node:fs';
import { start, stop, context, page, overflow, shot, text, apiLog, lastApi, PHONE, DESKTOP, BASE } from './harness.mjs';
import { check, summary, proxy } from './client.mjs';

const seed = JSON.parse(fs.readFileSync(new URL('./seed.json', import.meta.url)));
await start();
const problems = [];

/** Next weekday (0 Sun … 6 Sat) on or after today+offset, as YYYY-MM-DD in Auckland */
const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
function nextDow(dow, minDays = 1) {
  for (let i = minDays; i < 21; i += 1) {
    const key = lairKey(Date.now() + i * 86400000);
    if (new Date(`${key}T12:00:00Z`).getUTCDay() === dow) return key;
  }
  return null;
}
const THU = nextDow(4); // Warhammer night
const addDays = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const SUN2 = addDays(nextDow(0), 7); // Riftbound championship (locked T4-T13)

async function openBooking(p) {
  await p.goto(`${BASE}/pages/book-a-table`, { waitUntil: 'networkidle' });
  // Round 9: the one booking page (lair-play): its month view picks the day, and the booking's own day strip steps aside
  await p.waitForSelector('lair-play [data-play-date], [data-dates] [data-day]');
  await p.waitForSelector('lair-booking [data-dates] [data-day]', { state: 'attached' });
}
async function pickDay(p, key) {
  if (await p.locator('lair-play [data-play-date]').count()) {
    // the month view: on to the day's month (the next-month arrow), then tap the day
    for (let i = 0; i < 3 && !(await p.locator(`lair-play [data-play-date="${key}"]`).count()); i += 1) await p.click('lair-play [data-play-month="1"]');
    await p.click(`lair-play [data-play-date="${key}"]`);
    await p.waitForTimeout(200);
    return;
  }
  const chip = p.locator(`[data-dates] [data-day="${key}"]`);
  if (await chip.count()) await chip.first().click();
  else {
    await p.fill('[data-date-input]', key);
    await p.dispatchEvent('[data-date-input]', 'change');
  }
  await p.waitForTimeout(200);
}
async function pickSlot(p, minutes) {
  // Round 10: on the one booking page the start times sit under the day (as the other tabs' times do), and the
  // booking's own When card steps aside
  if (await p.locator('lair-play [data-play-start]').count()) await p.click(`lair-play [data-play-start="${minutes}"]`);
  else await p.click(`[data-slot="${minutes}"]`);
  await p.waitForTimeout(200);
}
async function setPeople(p, n) {
  for (let i = 0; i < 30; i += 1) {
    const now = Number(await p.evaluate(() => document.querySelector('lair-booking').state.people));
    if (now === n) return;
    await p.click(`[data-stepper="people"] ${now < n ? '[data-step-up]' : '[data-step-down]'}`);
  }
}
async function pickTables(p, ids) {
  // A tap on the map swaps the auto pick for the person's own; tap again to drop one
  for (const id of ids) await p.click(`lair-floor [data-table="${id}"]`);
  await p.waitForTimeout(150);
  return p.evaluate(() => document.querySelector('lair-booking').state.tables);
}

for (const [device, label] of [[PHONE, 'phone'], [DESKTOP, 'desktop']]) {
  /* 1. Anonymous: a soft-held Warhammer table on Thursday at 6pm */
  const ctx = await context(null, device);
  const p = await page(ctx, `${label}/anon`);
  await openBooking(p);
  const payNowBits = await p.evaluate(() => ({
    payNow: document.querySelectorAll('[data-pay-now], input[name="pay"], [value="now"]').length,
    words: /pay (it )?online|pay now/i.test(document.querySelector('lair-booking').innerText),
  }));
  check(`${label}: no pay-online option on the booking page`, payNowBits.payNow === 0 && !payNowBits.words, payNowBits);
  await pickDay(p, THU);
  await pickSlot(p, 18 * 60);
  // the first free table Warhammer has soft dibs on (earlier runs may have booked some)
  const softId = await p.evaluate(() => [...document.querySelectorAll('lair-floor [data-table]')].find((b) => b.dataset.soft && b.dataset.status === 'free')?.dataset.table || null);
  const status14 = softId && await p.getAttribute(`lair-floor [data-table="${softId}"]`, 'data-status');
  const sub14 = softId ? await text(p, `lair-floor [data-table="${softId}"] [data-sub]`) : '';
  check(`${label}: a Warhammer table is free and marked soft on Thursday 6pm`, Boolean(softId) && status14 === 'free' && /Warhammer/.test(sub14), { softId, status14, sub14 });
  const picked = await pickTables(p, [softId]);
  check(`${label}: ${softId} can be picked`, picked.includes(softId), picked);
  // keep only that table (the auto pick may have added a neighbour)
  for (const id of picked.filter((x) => x !== softId)) await p.click(`lair-floor [data-table="${id}"]`);
  await setPeople(p, 2);
  const summaryText = await text(p, '[data-summary]');
  check(`${label}: the summary has one heads-up about Warhammer's dibs`, (summaryText.match(/Heads up, friend/g) || []).length === 1 && new RegExp(`Warhammer & other wargames has dibs on ${softId} from 6`).test(summaryText), summaryText.slice(-200));
  await p.fill('#bk-name', label === 'phone' ? 'Hemi Walker' : 'Desk Top');
  await p.fill('#bk-email', label === 'phone' ? 'hemi@example.com' : 'desk@example.com');
  // round 7: a mobile is required (the form's Mobile field)
  const mobile = p.locator('#bk-phone, lair-booking input[type="tel"]');
  if (await mobile.count() && !(await mobile.first().inputValue())) await mobile.first().fill('021 555 0177');
  const agree = p.locator('input[name="agree"]');
  if (await agree.count()) await agree.check();
  const before = apiLog.length;
  await p.click('[data-submit]');
  await p.waitForSelector('[data-done]:not([hidden])', { timeout: 8000 }).catch(() => {});
  const call = apiLog.slice(before).find((c) => c.method === 'POST' && c.route.startsWith('bookings'));
  const sent = call ? JSON.parse(call.body) : {};
  const got = call ? JSON.parse(call.text) : {};
  check(`${label}: POST /bookings accepted the soft-held table`, call?.status === 200 && got.booking?.tables?.join() === softId, call ? `${call.status} ${call.text.slice(0, 160)}` : 'no call');
  check(`${label}: no pay choice is sent`, !('pay' in sent), Object.keys(sent));
  const ticket = await text(p, '[data-done]');
  const ref = got.booking?.ref || '';
  check(`${label}: the ticket shows the fun code and the heads-up`, ref && ticket.includes(ref) && /Heads up, friend/.test(ticket) && /^[A-Z]{2}-[A-Z]+-\d{1,2}$/.test(ref), `${ref} | ${ticket.slice(0, 120)}`);
  const qr = await p.evaluate(() => {
    const svg = document.querySelector('[data-done] [data-ticket-code] svg');
    return svg ? { label: svg.getAttribute('aria-label'), w: svg.getAttribute('width') } : null;
  });
  check(`${label}: the ticket has a QR of the code`, qr && String(qr.label || '').includes(ref), qr);
  check(`${label}: ticket says pay at the counter`, /To pay at the counter: \$20/.test(ticket) && /Pay at the counter when you arrive/.test(ticket), ticket.slice(0, 300));
  check(`${label}: no sideways scroll on the ticket`, (await overflow(p)) <= 0, await overflow(p));
  if (label === 'phone') await shot(p, 'booking-ticket-soft-phone');
  problems.push(...p.problems);
  await ctx.close();

  /* 2. A locked event's tables are unavailable (Riftbound championship, T4-T13, the Sunday after next) */
  const ctx2 = await context(null, device);
  const p2 = await page(ctx2, `${label}/locked`);
  await openBooking(p2);
  await pickDay(p2, SUN2);
  await pickSlot(p2, 12 * 60);
  const statuses = await p2.evaluate(() => ['T4', 'T8', 'T13', 'T14'].map((id) => [id, document.querySelector(`lair-floor [data-table="${id}"]`)?.dataset.status]));
  check(`${label}: the locked championship tables T4-T13 are taken, T14 is free`, statuses.slice(0, 3).every(([, s]) => s === 'taken') && statuses[3][1] === 'free', statuses);
  await p2.click('lair-floor [data-table="T8"]');
  const afterTap = await p2.evaluate(() => document.querySelector('lair-booking').state.tables);
  check(`${label}: tapping a locked table doesn't pick it`, !afterTap.includes('T8'), afterTap);
  // the app agrees: booking T8 straight through the proxy is refused
  const sunStart = Date.parse(`${SUN2}T12:00:00+13:00`);
  const direct = await proxy('POST', 'bookings', { body: { kind: 'table', tables: ['T8'], start: sunStart, end: sunStart + 7200000, people: 2, name: 'Sneaky', email: `sneaky-${label}@example.com` } });
  check(`${label}: the app refuses the locked table too`, direct.status === 409, `${direct.status} ${direct.data.error}`);
  problems.push(...p2.problems);
  await ctx2.close();

  /* 3. Logged in with a pass: "use my pass" and "split the bill" */
  const ctx3 = await context(7101, device);
  const p3 = await page(ctx3, `${label}/sam`);
  await openBooking(p3);
  await p3.waitForSelector('[data-pass]:not([hidden])', { timeout: 6000 }).catch(() => {});
  const passBox = await text(p3, '[data-pass]');
  check(`${label}: Sam sees "Use my pass" with the league pass`, /Use my pass/.test(passBox) && /Warhammer league/.test(passBox), passBox.slice(0, 120));
  const day = nextDow(5); // Friday
  await pickDay(p3, day);
  await pickSlot(p3, 17 * 60);
  await setPeople(p3, 3);
  const own = await p3.evaluate(() => document.querySelector('lair-booking').state.tables);
  await p3.check('input[name="usePass"]');
  await p3.check('input[name="split"]');
  await p3.waitForTimeout(150);
  const sum3 = await text(p3, '[data-summary]');
  check(`${label}: the summary shows the pass maths and the split`, /Your pass/.test(sum3) && /Split at the counter/.test(sum3), sum3.slice(0, 260));
  const agree3 = p3.locator('input[name="agree"]');
  if (await agree3.count()) await agree3.check();
  const before3 = apiLog.length;
  await p3.click('[data-submit]');
  await p3.waitForSelector('[data-done]:not([hidden])', { timeout: 8000 }).catch(() => {});
  const call3 = apiLog.slice(before3).find((c) => c.method === 'POST' && c.route.startsWith('bookings'));
  const sent3 = call3 ? JSON.parse(call3.body) : {};
  const got3 = call3 ? JSON.parse(call3.text) : {};
  check(`${label}: "use my pass" is sent as usePass`, sent3.usePass === seed.samPass.code, sent3.usePass);
  check(`${label}: "split the bill" is sent as split: true`, sent3.split === true, sent3.split);
  check(`${label}: the app saved the pass and the split`, call3?.status === 200 && got3.booking?.pass?.code === seed.samPass.code && got3.booking?.split === true, call3 ? call3.text.slice(0, 300) : 'no call');
  const ticket3 = await text(p3, '[data-done]');
  check(`${label}: the ticket shows the pass and its code`, ticket3.includes(seed.samPass.code) && /Warhammer league/.test(ticket3), ticket3.slice(0, 400));
  check(`${label}: the ticket shows the split line`, /Splitting the bill\? Each friend can pay their share at the counter\./.test(ticket3));
  check(`${label}: the ticket's QR is the booking code`, await p3.evaluate((r) => (document.querySelector('[data-done] [data-ticket-code] svg')?.getAttribute('aria-label') || '').includes(r), got3.booking?.ref || '?'));
  check(`${label}: no sideways scroll`, (await overflow(p3)) <= 0);
  if (label === 'phone') {
    await shot(p3, 'booking-ticket-pass-phone');
    await shot(p3, 'booking-ticket-pass-phone-full', { fullPage: true });
  } else await shot(p3, 'booking-ticket-pass-desktop');
  fs.writeFileSync(new URL(`./booking-${label}.json`, import.meta.url), JSON.stringify({ soft: got, pass: got3, own }, null, 2));
  // tidy up: Sam cancels it himself (people have at most 6 bookings coming up, and later flows book for him too)
  if (got3.booking) await proxy('POST', `bookings/${got3.booking.id}/update`, { customer: '7101', body: { status: 'cancelled' } });
  problems.push(...p3.problems);
  await ctx3.close();
}
check('no script errors, console errors or failed requests', problems.length === 0, problems.slice(0, 8).join(' | '));
await stop();
process.exit(summary() ? 1 : 0);

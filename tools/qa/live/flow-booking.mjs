// Booking page, live: a soft-held Warhammer table books with the heads-up, a locked event's tables are unavailable,
// "use my pass" is sent and the confirmation shows the pass, "split the bill" is sent, and there's no pay-online option.
// Round 15 (Mo, 12 Oct 2026: "no need to go to new pages when you decide to book a table", "Don't create a new QR code to
// pay make it live inside each person's tab"): a table is booked from its sheet on the map, in a sheet over the page, and
// the confirmation has no code or QR: it's on their tab (a guest pays at the counter on the day, by name), with until when
// it can be cancelled online. Phone (390×844) first, then desktop.
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
  // Round 9: the one booking page (lair-play): its days pick the day, and the booking's own day strip steps aside (round
  // 14: the strip of days is for phones and the month for desktop, so wait for the page to be ready, not for one of them)
  await p.waitForFunction(() => document.querySelector('lair-play')?.ready === true || (!document.querySelector('lair-play') && Boolean(document.querySelector('[data-dates] [data-day]'))), null, { timeout: 30000 });
  // Round 15: the page stays on the map; a table's sheet on it opens the booking in a sheet over the page (bookTable)
  await p.waitForSelector('lair-booking [data-dates] [data-day]', { state: 'attached' });
}
/** Round 15: tap the table on the map, then its sheet's Book (a table an event has set aside: its "Book T14" first), and
    the booking opens in a sheet over the page with that table → the booking's tables */
async function bookTable(p, id) {
  await p.click(`lair-play-floor [data-table="${id}"]`);
  await p.waitForSelector('[data-play-sheet][open]', { timeout: 5000 });
  await p.waitForTimeout(200);
  const aside = p.locator(`[data-play-sheet] [data-play-free="${id}"]`);
  if (await aside.count()) {
    await aside.first().click();
    await p.waitForTimeout(200);
  }
  await p.click('[data-play-sheet] [data-play-book-table]');
  await p.waitForSelector('[data-play-booking][open]', { timeout: 5000 });
  await p.waitForTimeout(300);
  return p.evaluate(() => document.querySelector('lair-booking').state.tables);
}
async function pickDay(p, key) {
  if (await p.locator('lair-play [data-play-date]').count()) {
    // round 14: the strip of days on phones when the day is on it; else the month (a tap away on phones)
    const strip = p.locator(`lair-play [data-play-strip] [data-play-date="${key}"]`);
    if ((await strip.count()) && (await strip.first().isVisible())) {
      await strip.first().click();
      await p.waitForTimeout(200);
      return;
    }
    const cal = p.locator('lair-play [data-play-cal]');
    if ((await cal.isVisible()) && (await cal.getAttribute('aria-expanded')) !== 'true') await cal.click();
    // the month view: on to the day's month (the next-month arrow), then tap the day
    for (let i = 0; i < 3 && !(await p.locator(`lair-play [data-play-days] [data-play-date="${key}"]`).count()); i += 1) await p.click('lair-play [data-play-month="1"]');
    await p.click(`lair-play [data-play-days] [data-play-date="${key}"]`);
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
  // Round 15: the map's times under the day (the booking's own When card steps aside in its sheet)
  if (await p.locator('lair-play [data-play-time]').count()) await p.click(`lair-play [data-play-time="${minutes}"]`);
  else await p.click(`[data-slot="${minutes}"]`);
  await p.waitForTimeout(250);
}
async function setPeople(p, n) {
  for (let i = 0; i < 30; i += 1) {
    const now = Number(await p.evaluate(() => document.querySelector('lair-booking').state.people));
    if (now === n) return;
    await p.click(`[data-stepper="people"] ${now < n ? '[data-step-up]' : '[data-step-down]'}`);
  }
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
  // the first free table Warhammer has soft dibs on (earlier runs may have booked some): on the map it's set aside for
  // Warhammer night and still free
  const soft = await p.evaluate(() => {
    const b = [...document.querySelectorAll('lair-play-floor [data-table]')].find((x) => x.dataset.status === 'free' && x.dataset.kind === 'event' && /set aside for Warhammer/.test(x.getAttribute('aria-label') || ''));
    return b ? { id: b.dataset.table, status: b.dataset.status, sub: (b.querySelector('[data-sub]')?.textContent || '').trim(), label: b.getAttribute('aria-label') } : null;
  });
  const softId = soft?.id || null;
  check(`${label}: a Warhammer table is free and set aside on the map on Thursday 6pm`, Boolean(softId) && soft.status === 'free' && /Warhammer/.test(soft.sub), soft);
  const picked = softId ? await bookTable(p, softId) : [];
  check(`${label}: its sheet books ${softId} in a sheet over the page (the address stays)`, picked.join() === softId && await p.evaluate(() => document.querySelector('[data-play-booking]').open && window.location.pathname === '/pages/book-a-table'), picked);
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
  // round 15: the Lair app says until when it can be cancelled online (the cut-off, 24 hours before), not locked yet
  const hours = await p.evaluate(() => window.Lair.refundHours());
  check(`${label}: the app's answer: cancel until ${hours} hours before, not locked`, got.booking?.cancelUntil === got.booking?.start - hours * 3600000 && got.booking?.locked === false, { hours, cancelUntil: got.booking?.cancelUntil, start: got.booking?.start, locked: got.booking?.locked });
  const words = await p.evaluate((b) => ({ tab: window.Lair.TAB.onTabGuest, cancel: window.Lair.TAB.cancelByGuest(b.cancelUntil) }), got.booking || {});
  check(`${label}: the confirmation has the heads-up, and no code or QR (round 15)`, /Heads up, friend/.test(ticket) && ref && !ticket.includes(ref) && !(await p.locator('[data-done] svg[aria-label^="QR"], [data-done] [data-ticket-code]').count()), `${ref} | ${ticket.slice(0, 160)}`);
  // Make a free account where the page has the sign-up link (the store's routes; the mock has none)
  const register = await p.evaluate(() => document.querySelector('lair-play')?.dataset.register || '');
  check(`${label}: a guest pays at the counter on the day, by name; until when to let us know${register ? '; Make a free account' : ''}`, /To pay on the day: \$20/.test(ticket) && ticket.includes(words.tab) && ticket.includes(words.cancel) && (await p.locator('[data-done] a', { hasText: 'Make a free account' }).count()) === (register ? 1 : 0), ticket.slice(0, 600));
  check(`${label}: no sideways scroll on the confirmation`, (await overflow(p)) <= 0, await overflow(p));
  if (label === 'phone') await shot(p, 'booking-ticket-soft-phone');
  problems.push(...p.problems);
  await ctx.close();

  /* 2. A locked event's tables are unavailable (Riftbound championship, T4-T13, the Sunday after next) */
  const ctx2 = await context(null, device);
  const p2 = await page(ctx2, `${label}/locked`);
  await openBooking(p2);
  await pickDay(p2, SUN2);
  await pickSlot(p2, 12 * 60);
  // round 15: the map at that time: T4-T13 held for the championship (not set aside: held), T14 free
  const statuses = await p2.evaluate(() => ['T4', 'T8', 'T13', 'T14'].map((id) => {
    const b = document.querySelector(`lair-play-floor [data-table="${id}"]`);
    return [id, b?.dataset.status, b?.dataset.kind];
  }));
  check(`${label}: the locked championship tables T4-T13 are held for it, T14 is free`, statuses.slice(0, 3).every(([, s, k]) => s === 'event' && k === 'event') && statuses[3][1] === 'free' && statuses[3][2] === 'free', statuses);
  await p2.click('lair-play-floor [data-table="T8"]');
  await p2.waitForSelector('[data-play-sheet][open]', { timeout: 5000 }).catch(() => {});
  await p2.waitForTimeout(200);
  const afterTap = await p2.evaluate(() => {
    const d = document.querySelector('[data-play-sheet]');
    return { open: d.open, view: d.dataset.view, book: Boolean(d.querySelector('[data-play-book-table], [data-play-free]')), booking: document.querySelector('[data-play-booking]').open };
  });
  check(`${label}: tapping a locked table opens the event's sheet, with no way to book the table`, afterTap.open && afterTap.view === 'event' && !afterTap.book && !afterTap.booking, afterTap);
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
  const day = nextDow(5); // Friday
  await pickDay(p3, day);
  await pickSlot(p3, 17 * 60);
  // a free table in the Main room at 5pm (the first one free for its sheet's 3 hours)
  const freeId = await p3.evaluate(() => {
    const play = document.querySelector('lair-play');
    const at = play.mapMoment();
    return [...document.querySelectorAll('lair-play-floor [data-table]')].map((b) => b.dataset.table)
      .find((id) => window.Lair.store.roomOf(id)?.id === 'main-room' && play.canBook(id, at, at + 3 * 3600000) && !window.Lair.store.softHold(id, at, at + 3 * 3600000)) || null;
  });
  const own = freeId ? await bookTable(p3, freeId) : [];
  await setPeople(p3, 3);
  await p3.waitForSelector('[data-pass]:not([hidden])', { timeout: 6000 }).catch(() => {});
  const passBox = await text(p3, '[data-pass]');
  check(`${label}: Sam sees "Use my pass" with the league pass`, /Use my pass/.test(passBox) && /Warhammer league/.test(passBox), passBox.slice(0, 120));
  await p3.check('input[name="usePass"]');
  // the league pass, when he has more than one (a run on a used state: a birthday gift's pass comes first)
  if (await p3.locator('select[name="passCode"]').count()) await p3.selectOption('select[name="passCode"]', seed.samPass.code);
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
  const b3 = got3.booking || {};
  const words3 = await p3.evaluate((b) => ({ nothing: window.Lair.TAB.nothingToPay, cancel: window.Lair.TAB.cancelBy(b.cancelUntil) }), b3);
  check(`${label}: the confirmation shows the pass and its code`, ticket3.includes(seed.samPass.code) && /Warhammer league/.test(ticket3), ticket3.slice(0, 400));
  check(`${label}: the confirmation shows the split line`, /Splitting the bill\? Each friend can pay their share at the counter\./.test(ticket3));
  check(`${label}: nothing to pay (the pass covers it), until when to cancel in My Lair, See your tab in My Lair; no booking code or QR`, /Nothing to pay: your pass covers it\./.test(ticket3) && ticket3.includes(words3.nothing) && ticket3.includes(words3.cancel) && (await p3.locator('[data-done] a', { hasText: 'See your tab in My Lair' }).count()) === 1 && !ticket3.includes(b3.ref || '?') && !(await p3.locator('[data-done] svg[aria-label^="QR"], [data-done] [data-ticket-code]').count()), ticket3.slice(0, 600));
  // Done closes the sheet, back to the map as it was (the address never changed)
  await p3.click('lair-booking [data-again]');
  await p3.waitForTimeout(500);
  const back3 = await p3.evaluate(() => ({ open: document.querySelector('[data-play-booking]').open, url: window.location.pathname }));
  check(`${label}: Done closes the booking sheet, on the same page`, !back3.open && back3.url === '/pages/book-a-table', back3);
  check(`${label}: no sideways scroll`, (await overflow(p3)) <= 0);
  if (label === 'phone') {
    await shot(p3, 'booking-ticket-pass-phone');
    await shot(p3, 'booking-ticket-pass-phone-full', { fullPage: true });
  } else await shot(p3, 'booking-ticket-pass-desktop');
  fs.writeFileSync(new URL(`./booking-${label}.json`, import.meta.url), JSON.stringify({ soft: got, pass: got3, own }, null, 2));
  // tidy up: staff cancel it (people have at most 6 bookings coming up, and later flows book for him too; round 15: inside
  // 24 hours he couldn't cancel it himself)
  if (got3.booking) await proxy('POST', `bookings/${got3.booking.id}/update`, { customer: '7001', body: { status: 'cancelled' } });
  problems.push(...p3.problems);
  await ctx3.close();
}
check('no script errors, console errors or failed requests', problems.length === 0, problems.slice(0, 8).join(' | '));
await stop();
process.exit(summary() ? 1 : 0);

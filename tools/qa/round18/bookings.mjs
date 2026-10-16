// Staff and table bookings (17 Oct 2026). Mo: "I cannot cancel people's booking if someone booked in and never showed
// up it shows that table is booked out but I want to remove it manually. Even before the event. And have the option to
// write an email to them". On the theme mock (demo): the staff page's Bookings tab (Today, Tomorrow, the next 7 days or
// a picked day; a search looks at every day), Cancel booking until it ends (a no-show's too, freeing the table), and
// Email (a dialog: subject, message, sent from the shop), the live body, focus, no sideways scroll and axe.
// Usage: DG_THEME=/path/to/theme [PORT=4997] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round18/bookings.mjs [phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-bookings');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, context, watch, go, STAFF } = lib;
const PORT = Number(process.env.PORT || 4997);
const BASE = `http://localhost:${PORT}`;
const sizes = process.argv[2] ? [process.argv[2]] : ['phone', 'desktop'];

const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const toast = (page) => page.evaluate(() => (document.querySelector('[data-live-region]')?.textContent || '').trim());

/** Three of Mia's bookings: today 11am to 2pm (she hasn't come: it's 1pm), tomorrow 6pm, and in 3 days 7pm */
const seed = (page) => page.evaluate(async () => {
  const { store } = window.Lair;
  const be = store.backend;
  const t = be.time;
  const today = t.today();
  be.state.bookings = be.state.bookings.filter((b) => !/^bk-mia-/.test(b.id));
  const mk = (id, ref, day, from, to, tables) => ({
    id, ref, kind: 'table', status: 'confirmed', pay: 'day', paid: false, amount: 2000, covered: 0, paidAmount: 0, email: 'mia@example.com', phone: '021 555 0100',
    notes: '', activity: 'board', extras: [], name: 'Mia Chen', createdAt: Date.now() - 86400000, customerId: null, tables, start: t.at(day, from * 60), end: t.at(day, to * 60), people: 2,
  });
  be.state.bookings.push(
    mk('bk-mia-today', 'MC-KRAKEN-7', today, 11, 14, ['T15']),
    mk('bk-mia-tomorrow', 'MC-OWLBEAR-3', t.addDays(today, 1), 18, 20, ['T16']),
    mk('bk-mia-later', 'MC-HYDRA-12', t.addDays(today, 3), 19, 21, ['T17']),
  );
  be.commit();
  await store.refresh();
  return { today, tomorrow: t.addDays(today, 1), later: t.addDays(today, 3) };
});
const cards = (page) => page.evaluate(() => {
  const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  return [...document.querySelectorAll('[data-today-list] .staff-card')].map((c) => ({
    name: f(c.querySelector('.staff-card__head strong')?.textContent), code: f(c.querySelector('.staff-card__code')?.textContent),
    buttons: [...c.querySelectorAll('button')].map((b) => f(b.textContent)),
  }));
});
const heads = (page) => page.evaluate(() => [...document.querySelectorAll('[data-today-list] .staff-days__title')].map((h) => h.textContent.trim()));

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';
  const ctx = await context(browser, size);
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/lair-staff', STAFF);
  await page.waitForSelector('#checkin-code', { timeout: 20000 });
  const days = await seed(page);
  await page.click('#tab-today');
  await page.waitForSelector('[data-today-list]', { state: 'visible' });
  await settle(page);
  check(`${tag} the tab is called Bookings`, flat(await page.textContent('#tab-today')).startsWith('Bookings'));
  // today: Mia's 11am table, started and not here: No-show and Cancel booking, and Email Mia
  let list = (await cards(page)).filter((c) => c.code === 'MC-KRAKEN-7');
  check(`${tag} today: a booking that's started but they're not here has No-show, Cancel booking and Email Mia`,
    list.length === 1 && ['Check in', 'No-show', 'Cancel booking', 'Email Mia'].every((b) => list[0].buttons.includes(b)), list);
  check(`${tag} today: only today's bookings`, !(await cards(page)).some((c) => ['MC-OWLBEAR-3', 'MC-HYDRA-12'].includes(c.code)));
  // tomorrow
  await page.click('[data-days="tomorrow"]');
  await settle(page, 200);
  list = await cards(page);
  check(`${tag} Tomorrow: Mia's 6pm table, with Cancel booking`, list.some((c) => c.code === 'MC-OWLBEAR-3' && c.buttons.includes('Cancel booking')) && !list.some((c) => c.code === 'MC-KRAKEN-7')
    && (await page.getAttribute('[data-days="tomorrow"]', 'aria-pressed')) === 'true', list.map((c) => c.code));
  // the next 7 days: each day under its own heading
  await page.click('[data-days="week"]');
  await settle(page, 200);
  const week = await heads(page);
  list = await cards(page);
  check(`${tag} Next 7 days: every day's bookings under their day (${week.join(', ')})`,
    week[0] === 'Today' && week.includes('Tomorrow') && ['MC-KRAKEN-7', 'MC-OWLBEAR-3', 'MC-HYDRA-12'].every((code) => list.some((c) => c.code === code)), week);
  // a picked day
  await page.fill('[data-days-date]', days.later);
  await page.dispatchEvent('[data-days-date]', 'change');
  await settle(page, 200);
  list = await cards(page);
  check(`${tag} a picked day shows that day's bookings`, list.some((c) => c.code === 'MC-HYDRA-12') && !list.some((c) => c.code === 'MC-KRAKEN-7')
    && (await page.getAttribute('[data-days="week"]', 'aria-pressed')) === 'false', list.map((c) => c.code));
  // a search looks at every day
  await page.click('[data-days="today"]');
  await page.fill('[data-find]', 'mc-hydra-12');
  await settle(page, 300);
  list = await cards(page);
  check(`${tag} a search finds a booking on any day`, list.length === 1 && list[0].code === 'MC-HYDRA-12', list);
  await page.fill('[data-find]', '');
  await settle(page, 300);
  await shot(page, `${size}-bookings`, '[data-panel="today"]');
  await axe(page, `${tag} Bookings`, '[data-panel="today"]');
  check(`${tag} Bookings: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));

  // Email Mia: the dialog, with the subject filled in; an empty message is caught; sent
  const emailButton = page.locator('[data-today-list] .staff-card', { hasText: 'MC-KRAKEN-7' }).locator('[data-email-booking]');
  await emailButton.click();
  await page.waitForSelector('[data-email-dialog][open]');
  const dlg = await page.evaluate(() => {
    const d = document.querySelector('[data-email-dialog]');
    return {
      title: d.querySelector('[data-email-title]').textContent.trim(), to: d.querySelector('[data-email-to]').textContent.trim(),
      subject: d.querySelector('[name="subject"]').value, focus: document.activeElement?.name || '',
    };
  });
  check(`${tag} Email: the dialog says who to, with the subject filled in and the message focused`,
    dlg.title === 'Email Mia Chen' && /^To Mia Chen \(mia@example\.com\), about .+ at 11am, MC-KRAKEN-7\.$/.test(dlg.to) && /^Your booking at Dice Goblin on /.test(dlg.subject) && dlg.focus === 'text', dlg);
  await shot(page, `${size}-email`, '[data-email-dialog]');
  await axe(page, `${tag} the email dialog`, '[data-email-dialog]');
  await page.click('[data-email-form] [type="submit"]');
  await settle(page, 200);
  const empty = await page.evaluate(() => {
    const e = document.querySelector('[data-email-error]');
    return { hidden: e.hidden, text: e.textContent.trim(), open: document.querySelector('[data-email-dialog]').open };
  });
  check(`${tag} Email: an empty message says so and stays open`, !empty.hidden && empty.text === 'Write a message first.' && empty.open, empty);
  await page.fill('[data-email-form] [name="text"]', 'Kia ora Mia, are you still coming? We can hold your table till 2.');
  await page.click('[data-email-form] [type="submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-email-dialog]').open, null, { timeout: 5000 });
  const sentIt = await page.evaluate(() => JSON.parse(JSON.stringify(window.Lair.store.backend.state.bookingMessages || [])));
  check(`${tag} Email: sent, the dialog closes and says so, focus back on Email Mia`,
    sentIt.length === 1 && sentIt[0].to === 'mia@example.com' && /hold your table/.test(sentIt[0].text) && (await toast(page)) === 'Email sent to mia@example.com.'
    && (await page.evaluate(() => document.activeElement?.dataset?.emailBooking)) === 'bk-mia-today', { sentIt, toast: await toast(page) });
  // Escape closes it too, and focus comes back
  await emailButton.click();
  await page.waitForSelector('[data-email-dialog][open]');
  await page.keyboard.press('Escape');
  await settle(page, 300);
  check(`${tag} Email: Escape closes it, focus back`, (await page.evaluate(() => !document.querySelector('[data-email-dialog]').open && document.activeElement?.dataset?.emailBooking)) === 'bk-mia-today');

  // Cancel booking: two taps; she's off, and T15 is free
  const cancel = page.locator('[data-today-list] .staff-card', { hasText: 'MC-KRAKEN-7' }).locator('[data-act="cancel"]');
  await cancel.click();
  const armed = flat(await cancel.textContent());
  await cancel.click();
  await settle(page, 600);
  const after = await page.evaluate(() => {
    const b = window.Lair.store.backend.state.bookings.find((x) => x.id === 'bk-mia-today');
    return { status: b.status, free: window.Lair.store.isFree('T15', Date.now(), Date.now() + 3600000) };
  });
  check(`${tag} Cancel booking: two taps, then it's cancelled and T15 is free`, armed === 'Tap again to cancel' && after.status === 'cancelled' && after.free && (await toast(page)) === 'Booking cancelled', { armed, after, toast: await toast(page) });
  list = (await cards(page)).filter((c) => c.code === 'MC-KRAKEN-7');
  check(`${tag} a cancelled booking can still be emailed, with nothing else to do`, list.length === 1 && JSON.stringify(list[0].buttons) === JSON.stringify(['Email Mia']), list);
  check(`${tag} no script errors`, !page.errors.length, page.errors.slice(0, 5));
  await ctx.close();

  // live: the body
  m.globalSettings.lair_mode = 'live';
  const calls = [];
  m.mockState.before = async (req, res, url) => {
    if (!url.pathname.startsWith('/apps/liar/')) return false;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.method === 'POST') calls.push({ path: url.pathname.replace('/apps/liar', ''), body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sent: 1, to: 'mia@example.com' }));
    return true;
  };
  const lctx = await context(browser, size);
  const lp = watch(await lctx.newPage());
  await go(lp, BASE, '/pages/my-lair', STAFF);
  await lp.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend, null, { timeout: 20000 });
  await lp.evaluate(() => window.Lair.store.backend.messageBooking('bk_1', { subject: 'Hi', text: 'Hello' }));
  check(`${tag} live: POST /bookings/:id/message { subject, text }`, JSON.stringify(calls.filter((c) => /message/.test(c.path))) === JSON.stringify([{ path: '/bookings/bk_1/message', body: { subject: 'Hi', text: 'Hello' } }]), calls);
  await lctx.close();
  m.mockState.before = null;
  m.globalSettings.lair_mode = 'demo';
}

const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed. Screens in ${process.env.OUT}`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

// Staff page, round 4, end to end in one browser (the booking page and the staff page share the demo's storage):
// 1 Aroha books today with "use my pass"; 2 staff check her in by typing the code (lower case, no dashes): the
// amount due drops; switch to another pass, take the pass off (Undo pass), use the saved pass again, then undo that
// use from the pass's page; 3 a member code and an old GOB- ref; 4 a pass scanned after a booking; 5 a split bill
// on the Today list, and Mark refunded; 6 issue a pass, find it, edit it, void it; 7 members: code, Mark done, a new
// member code; 8 a walk-in still works. Usage: node staff.mjs phone|desktop
import { m, chromium, shot, text, overflow, decode, smallTargets, STAFF, CUSTOMER, SIZES, CLOCK } from './lib.mjs';
const tag = process.argv[2] || 'phone';
const PORT = Number(process.env.QA_PORT || 4311);
const server = await m.serve(PORT);
const browser = await chromium.launch();
const [W, H] = SIZES[tag];
const phone = tag === 'phone';
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone });
if (CLOCK) await ctx.addInitScript(CLOCK);
const page = await ctx.newPage();
page.errors = [];
page.on('pageerror', (e) => page.errors.push(e.message));
page.on('console', (msg) => { if (msg.type() === 'error') page.errors.push(`console: ${msg.text()}`); });
const log = (...a) => console.log(tag, '|', ...a);
const sleep = (ms) => page.waitForTimeout(ms);
const go = async (path) => {
  await page.goto(`http://localhost:${PORT}${path}`, { waitUntil: 'networkidle' });
  await sleep(600);
};
const card = () => text(page, '[data-checkin-result]');
const toCard = async () => {
  await page.evaluate(() => document.querySelector('.checkin').scrollIntoView({ block: 'start' }));
  await sleep(150);
};
const typeCode = async (code) => {
  await page.fill('#checkin-code', code);
  await page.press('#checkin-code', 'Enter');
  await sleep(500);
};
const bookingDue = (ref) => page.evaluate((r) => {
  const b = window.Lair.store.data.bookings.find((x) => x.ref === r);
  return b ? { due: b.due, covered: b.covered, pass: b.pass && `${b.pass.code} (${b.pass.left} left)`, status: b.status } : null;
}, ref);
const passLeft = () => page.evaluate(() => window.Lair.store.backend.passList().map((p) => `${p.label}:${p.sessionsTotal - p.sessionsUsed}`).join(', '));

// ---------- 1. Aroha books a fancy room table today, 4 people, with her pass ----------
m.mockState.customer = CUSTOMER;
await go('/pages/book-a-table');
await page.waitForSelector('[data-pass]:not([hidden])', { timeout: 4000 }).catch(() => log('NO PASS TOGGLE'));
const today = await page.evaluate(() => window.Lair.store.time.today());
// round 10: the one booking page picks the day on its month view and the start time under the day (the booking's own
// When card, with its strip of days, steps aside there; the strip still says whether today can be booked)
const todayOpen = await page.$(`[data-day="${today}"]:not([disabled])`);
if (todayOpen) await page.click(`[data-play-date="${today}"], [data-day="${today}"] >> visible=true`);
await sleep(200);
await page.click('[data-play-start]:not([disabled]), [data-slot]:not([disabled]) >> visible=true');
await sleep(250);
await page.click('[data-table="F1"]').catch(() => {});
for (let i = 0; i < 2; i += 1) await page.click('[data-stepper="people"] [data-step-up]');
await page.click('.booking__pass .booking__toggle');
await sleep(250);
log('booking summary:', await text(page, '[data-summary]'));
await page.click('[data-submit]');
await sleep(900);
const ref = await text(page, '.ticket-qr__ref');
log('booked:', ref, '| today?', Boolean(todayOpen), '|', (await text(page, '.ticket__stub')).slice(0, 120));
const ticketShot = await shot(page, `${tag}-s0-ticket`, '.ticket');
log('ticket QR:', decode(ticketShot).replace(/\(\(.*$/, '').replace(/^.*?\[/, '['));

// ---------- 2. staff: check her in by typing the code, then switch and undo passes ----------
m.mockState.customer = STAFF;
await go('/pages/lair-staff');
log('passes before:', await passLeft());
log('before check-in:', JSON.stringify(await bookingDue(ref)));
await page.click('[data-tab="today"]');
await sleep(300);
const todayCard = await page.$(`.staff-card:has-text("${ref}")`);
if (todayCard) {
  await todayCard.scrollIntoViewIfNeeded();
  log('Today card before:', (await todayCard.innerText()).replace(/\s+/g, ' '));
  await todayCard.screenshot({ path: `${(await import('./lib.mjs')).OUT}${tag}-s1-today-card-before.png` });
}
await toCard();
await typeCode(ref.toLowerCase().replace(/-/g, ''));
if (!todayOpen) {
  log('(booked tomorrow, so: Check in anyway)', await card());
  await page.click('[data-checkin-force]');
  await sleep(500);
}
log('check-in card:', await card());
log('after check-in:', JSON.stringify(await bookingDue(ref)), '|', await passLeft());
await toCard();
await shot(page, `${tag}-s2-checkin-pass`, '.checkin');
log('small targets in the check-in card:', JSON.stringify(await smallTargets(page, '[data-checkin-result]')));

// switch to the league pass, by code
const league = await page.evaluate(() => window.Lair.store.backend.passList().find((p) => p.label === 'Warhammer league').code);
await page.click('[data-pass-other]');
await sleep(200);
await page.fill('#checkin-pass-code', league.toLowerCase());
await shot(page, `${tag}-s3-another-pass`, '.checkin');
await page.click('[data-pass-use] button[type="submit"]');
await sleep(600);
log('switched to the league pass:', await card());
log('  →', JSON.stringify(await bookingDue(ref)), '|', await passLeft());

// no pass: Undo pass
await page.click('[data-pass-undo]');
await sleep(600);
log('after Undo pass:', await card());
log('  →', JSON.stringify(await bookingDue(ref)), '|', await passLeft());
await shot(page, `${tag}-s4-no-pass`, '.checkin');

// the saved pass again, then undo that use from the pass's own page
await page.click('[data-pass-saved]');
await sleep(600);
log('saved pass again:', JSON.stringify(await bookingDue(ref)), '|', await passLeft());
await page.click('[data-pass-open], [data-tab="passes"]').catch(() => {});
await page.click('[data-tab="passes"]');
await sleep(400);
await page.click(`[data-pass-open][data-code="${league}"]`);
await sleep(500);
log('league pass page:', (await text(page, '[data-pass-uses]')).slice(0, 300));
await page.click('[data-pass-use-undo]');
await sleep(600);
log('undone from the pass page:', JSON.stringify(await bookingDue(ref)), '|', await passLeft(), '| toast:', await text(page, '.toast'));

// ---------- 3. a member code (Sam, lower case, no dashes) and an old GOB- ref ----------
const sam = await page.evaluate(() => window.Lair.store.backend.staffMembers().find((x) => x.firstName === 'Sam').code);
await toCard();
await typeCode(sam.toLowerCase().replace(/-/g, ' '));
log('member code', sam, '→', await card());
await shot(page, `${tag}-s5-member-code`, '.checkin');
const first = await page.$('[data-checkin-row]');
if (first) {
  await first.click();
  await sleep(500);
  log('row from the member card:', (await card()).slice(0, 200));
  await page.click('[data-checkin-card]');
  await sleep(500);
}
await page.evaluate(() => {
  const be = window.Lair.store.backend;
  const t = window.Lair.store.time;
  const now = Date.now();
  be.state.bookings.push({
    id: 'bk-legacy', ref: 'GOB-7K2QXM', kind: 'table', status: 'confirmed', pay: 'day', paid: false, tables: ['T3'], room: 'main-room',
    start: now + 30 * 60000, end: now + 150 * 60000, people: 2, name: 'Old Booking', email: 'old@example.com', amount: 2000, extras: [], activity: 'board',
  });
  be.save();
  return t.today();
});
await typeCode('gob 7k2qxm');
log('legacy GOB ref:', await card());
await shot(page, `${tag}-s6-legacy`, '.checkin');

// ---------- 4. a pass scanned straight after a booking: use it for that booking ----------
const rangi = await page.evaluate(() => window.Lair.store.data.bookings.find((b) => b.name === 'Rangi Parata').ref);
await typeCode(rangi);
log('Rangi (saved league pass):', await card());
await page.click('[data-pass-undo]');
await sleep(600);
const gift = await page.evaluate(() => window.Lair.store.backend.passList().find((p) => p.label.startsWith('Gift')).code);
await typeCode(gift);
log('gift pass scanned:', await card());
await shot(page, `${tag}-s7-pass-scanned`, '.checkin');
await page.click('[data-pass-apply]');
await sleep(600);
log('used for Rangi:', await card());
log('  →', JSON.stringify(await bookingDue(rangi)), '|', await passLeft());
await page.click('[data-checkin-clear]');

// ---------- 5. the Today list: a split bill, and refunds ----------
await page.click('[data-tab="today"]');
await sleep(400);
const leo = await page.$('.staff-card:has-text("Splitting the bill")');
log('split card:', leo ? (await leo.innerText()).replace(/\s+/g, ' ') : 'NONE');
if (leo) {
  await leo.scrollIntoViewIfNeeded();
  await leo.screenshot({ path: `${(await import('./lib.mjs')).OUT}${tag}-s8-split-card.png` });
}
const refunds = await text(page, '[data-refunds]');
log('refunds:', refunds.slice(0, 260));
await page.click('[data-refunds] [data-act="refund"]');
await sleep(500);
log('after Mark refunded:', (await text(page, '[data-refunds]')).slice(0, 200), '| toast:', await text(page, '.toast'));
log('refund states:', await page.evaluate(() => window.Lair.store.data.bookings.filter((b) => b.refund).map((b) => `${b.name}:${b.refund}`).join(', ')));
await page.evaluate(() => document.querySelector('[data-today-list]').scrollIntoView({ block: 'start' }));
await shot(page, `${tag}-s9-today`);

// ---------- 6. passes: issue, find, edit, void ----------
await page.click('[data-tab="passes"]');
await sleep(300);
await page.click('[data-pass-back]').catch(() => {});
await sleep(300);
await page.click('[data-pass-issue]');
await sleep(300);
await page.click('[data-pass-preset="Gift pack: 10 sessions"]');
// round 7: who it's for is a choice (a group, a customer or a typed name); a customer comes from the customer search
await page.check('[data-pass-owner-pick][value="customer"]', { force: true });
await page.fill('#find-pass', 'grace');
await page.waitForSelector('[data-owner-panel="customer"] [data-pick]', { timeout: 6000 });
await page.click('[data-owner-panel="customer"] [data-pick]');
await sleep(200);
await page.fill('#pass-new-price', '90');
const expires = await page.evaluate(() => window.Lair.store.time.addDays(window.Lair.store.time.today(), 120));
await page.fill('#pass-new-expires', expires);
await page.fill('#pass-new-note', 'Christmas present from her flatmates');
await page.evaluate(() => document.querySelector('[data-pass-new]').scrollIntoView({ block: 'start' }));
await shot(page, `${tag}-s10-issue-form`);
log('small targets in the issue form:', JSON.stringify(await smallTargets(page, '[data-pass-new]')));
await page.click('[data-pass-new] button[type="submit"]');
await sleep(700);
log('issued:', (await text(page, '[data-pass-card]')).slice(0, 260), '| toast:', await text(page, '.toast'));
const passShot = await shot(page, `${tag}-s11-pass-view`, '[data-print-pass]');
log('pass QR:', decode(passShot).replace(/\(\(.*$/, '').replace(/^.*?\[/, '['));
const newCode = await text(page, '.staff-pass__code');
await page.screenshot({ path: `${(await import('./lib.mjs')).OUT}${tag}-s11-pass-view-screen.png` });
// print: only the card, on one page, without the price and note
{
  const { OUT } = await import('./lib.mjs');
  const { execFileSync } = await import('node:child_process');
  await page.evaluate(() => document.documentElement.classList.add('dg-print-pass'));
  const pdf = `${OUT}${tag}-s12-print.pdf`;
  await page.pdf({ path: pdf, format: 'A4', printBackground: true });
  await page.emulateMedia({ media: 'print' });
  log('print shows private bits?', await page.evaluate(() => [...document.querySelectorAll('.staff-pass__private')].some((el) => getComputedStyle(el).display !== 'none')));
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => document.documentElement.classList.remove('dg-print-pass'));
  const pages = execFileSync('pdfinfo', [pdf]).toString().match(/Pages:\s+(\d+)/)[1];
  execFileSync('pdftoppm', ['-png', '-r', '70', '-f', '1', '-l', '1', pdf, `${OUT}${tag}-s12-print`]);
  log('printed pages:', pages);
}
// find it
await page.click('[data-pass-back]');
await sleep(400);
await page.fill('#pass-find', newCode.slice(0, 6).toLowerCase());
await sleep(700);
log('search by code:', await text(page, '[data-pass-list]'));
await page.fill('#pass-find', 'grace');
await sleep(700);
log('search by holder:', await text(page, '[data-pass-list]'));
await shot(page, `${tag}-s13-pass-list`, '.staff-passes');
await page.click(`[data-pass-open][data-code="${newCode}"]`);
await sleep(400);
// edit
await page.click('.staff-pass .staff-gm__summary');
await sleep(200);
await page.fill('#pass-edit-label', 'Gift pack: 12 sessions');
await page.fill('[data-pass-edit] [name="sessions"]', '12');
await page.fill('#pass-edit-expires', '');
await page.fill('#pass-edit-note', 'From her flatmates');
await shot(page, `${tag}-s14-edit`, '.staff-pass');
await page.click('[data-pass-edit] button[type="submit"]');
await sleep(600);
log('edited:', (await text(page, '[data-pass-card]')).slice(0, 220), '| toast:', await text(page, '.toast'));
// sessions below used: the Lair app says no
await page.click('.staff-pass .staff-gm__summary');
await page.click(`[data-pass-back]`);
await sleep(300);
// void
await page.click(`[data-pass-open][data-code="${newCode}"]`);
await sleep(400);
await page.click('[data-pass-confirm^="void:"]');
await sleep(250);
log('void asks:', await text(page, '[data-pass-danger]'));
await page.evaluate(() => document.querySelector('[data-pass-danger]').scrollIntoView({ block: 'center' }));
await shot(page, `${tag}-s15-void-confirm`, '[data-pass-danger]');
await page.click('[data-pass-set-status="void"]');
await sleep(600);
log('voided:', await text(page, '.staff-pass__status'), '|', await text(page, '[data-pass-danger]'), '| toast:', await text(page, '.toast'));
await page.click('[data-pass-back]');
await sleep(300);
await page.fill('#pass-find', '');
await sleep(400);
await page.click('[data-pass-status="void"]');
await sleep(600);
log('void list:', await text(page, '[data-pass-list]'));
// the void pass at check-in: skipped with a notice
const someone = await page.evaluate(() => window.Lair.store.data.bookings.find((b) => b.status === 'confirmed' && b.kind === 'table' && !b.paid && window.Lair.store.time.key(b.start) === window.Lair.store.time.today() && b.ref !== 'GOB-7K2QXM')?.ref);
if (someone) {
  await toCard();
  await typeCode(someone);
  await page.click('[data-pass-other]');
  await page.fill('#checkin-pass-code', newCode);
  await page.click('[data-pass-use] button[type="submit"]');
  await sleep(600);
  log('void pass at check-in:', await card());
}

// ---------- 7. members: code search, Mark done, a new member code ----------
await page.click('[data-tab="members"]');
await sleep(300);
await page.fill('#members-find', sam.slice(0, 8).toLowerCase());
await sleep(600);
log('members by code:', await text(page, '[data-members-list]'));
await page.click('.staff-mem-row'); // round 5: the list opens the member's page
await sleep(800);
await page.evaluate(() => document.querySelector('[data-panel="members"]').scrollIntoView({ block: 'start' }));
await shot(page, `${tag}-s16-member`);
await page.click('[data-prize-done]');
await sleep(500);
log('prize done:', (await text(page, '[data-members]')).slice(0, 200), '| toast:', await text(page, '.toast'));
await page.click('[data-member-confirm]:not([data-member-confirm=""])');
await sleep(250);
log('new code asks:', await text(page, '.staff-confirm'));
await shot(page, `${tag}-s17-new-code-confirm`, '.staff-person__card');
await page.click('[data-member-new-code]');
await sleep(500);
const fresh = await page.evaluate(() => document.querySelector('.staff-person__code-text strong').textContent);
log('new member code:', fresh, '| toast:', await text(page, '.toast'));
await toCard();
await typeCode(sam);
log('old code now:', await card());
await typeCode(fresh);
log('new code:', (await card()).slice(0, 120));
await page.click('[data-checkin-clear]');
log('birthdays on the Members tab:', (await text(page, '[data-birthdays]')).slice(0, 80));

// ---------- 8. a walk-in still works ----------
await page.click('[data-tab="floor"]');
await sleep(300);
const pair = await page.evaluate(() => {
  const { store } = window.Lair;
  const now = Date.now();
  const free = store.cfg.tables.filter((tb) => tb.room === 'main-room' && !store.isShopTable(tb.id) && ['free', 'soon'].includes(store.statusAt(tb.id, now).status) && store.isFree(tb.id, now, now + 3600000)).map((tb) => tb.id);
  return free.slice(0, 2);
});
for (const id of pair) await page.evaluate((x) => document.querySelector(`[data-table="${x}"]`).click(), id);
await sleep(300);
await page.click('[data-seat-walkin]');
await sleep(300);
await page.fill('#walkin-name', 'Hemi');
await page.click('[data-walkin-form] button[type="submit"]');
await sleep(500);
log('walk-in:', await text(page, '.toast'));

log('overflow', await overflow(page), 'errors', page.errors);
await ctx.close();
await browser.close();
server.close();

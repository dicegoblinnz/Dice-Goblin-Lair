// Round 5 (f), the staff page in the browser (Mo, staff), phone (390px) then desktop: check-in by member code shows
// what a weekly regular owes from earlier sessions, with Waive; the Members tab lists members and sorts them (spend,
// recent, owing, "Owes money"); a birthday gift sent from a member's page (credit, sessions, a roll, a product, the
// email). Kiri (phone) and Tui (desktop) owe for the weekly game after flow-r5-regulars.mjs.
import fs from 'node:fs';
import { start, stop, context, page, overflow, shot, text, apiLog, PHONE, DESKTOP, BASE } from './harness.mjs';
import { check, summary, proxy, fake } from './client.mjs';

const R = JSON.parse(fs.readFileSync(new URL('./r5-regulars.json', import.meta.url)));
const DEVICE = process.argv[2] === 'desktop' ? DESKTOP : PHONE;
const L = process.argv[2] === 'desktop' ? 'desktop' : 'phone';
const OWES = L === 'desktop' ? { id: '7106', name: 'Tui Harper', first: 'Tui' } : { id: '7102', name: 'Kiri Smith', first: 'Kiri' };
const GIFT = L === 'desktop' ? { id: '7103', name: 'Ana Rangi', email: 'ana@example.com' } : { id: '7101', name: 'Sam Jones', email: 'sam@example.com' };
const seatId = R.seats[OWES.id];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const owedBefore = ((await proxy('GET', 'me', { customer: OWES.id })).data.seats || []).find((x) => x.id === seatId);
check(`${L} setup: ${OWES.first} owes $15 for the weekly game's ended session`, owedBefore?.owed === true && owedBefore.due === 1500, owedBefore && { owed: owedBefore.owed, due: owedBefore.due });

await start();
const problems = [];
const ctx = await context(7001, DEVICE);
const p = await page(ctx, `${L}/staff-r5`);
await p.goto(`${BASE}/pages/lair-staff`, { waitUntil: 'networkidle' });
await p.waitForSelector('#checkin-code');
const checkin = async (code) => {
  const b = apiLog.length;
  await p.fill('#checkin-code', code);
  await p.press('#checkin-code', 'Enter');
  await p.waitForSelector('.checkin-card:not(.checkin-card--pending)', { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(400);
  const call = apiLog.slice(b).find((c) => c.method === 'POST' && c.route.startsWith('checkin'));
  return { call, data: call ? JSON.parse(call.text) : {}, card: await text(p, '[data-checkin-result]') };
};

/* 1. Check-in by member code: the owed session, with Waive */
const c1 = await checkin(R.codes[OWES.id].toLowerCase());
const owedRow = (c1.data.rows || []).find((r) => r.id === seatId);
check(`${L}: member code (typed in lower case): ${OWES.first}'s card, with the owed row from the app`, c1.call?.status === 200 && c1.data.kind === 'member' && owedRow?.owed === true && owedRow.due === 1500 && /They owe \$15/.test(c1.data.message || ''), c1.call ? c1.call.text.slice(0, 200) : 'no call');
check(`${L}: the card: "Owed from earlier sessions", the game, the date, $15, not checked in, Waive`, /Owed from earlier sessions/.test(c1.card) && c1.card.includes(R.title) && /\$15/.test(c1.card) && /Didn’t check in/.test(c1.card) && Boolean(await p.$(`[data-checkin-result] [data-waive="${seatId}"]`)), c1.card.slice(0, 500));
check(`${L}: no sideways scroll`, (await overflow(p)) <= 0, await overflow(p));
await p.evaluate(() => document.querySelector('.checkin-card__owed')?.scrollIntoView({ block: 'center' }));
await shot(p, `r5-staff-owed-${L}`);
await p.click(`[data-checkin-result] [data-waive="${seatId}"]`);
await p.waitForSelector(`[data-waive-yes="${seatId}"]`, { timeout: 5000 }).catch(() => {});
const ask = await text(p, '.staff-owed__confirm');
check(`${L}: Waive asks first: what's let off, no undo`, /Waive \$15 for/.test(ask) && ask.includes(R.title) && /no undo/.test(ask), ask);
let b = apiLog.length;
await p.click(`[data-waive-yes="${seatId}"]`);
await p.waitForTimeout(1200);
const waived = apiLog.slice(b).find((c) => c.method === 'POST' && c.route === `bookings/${seatId}/update`);
check(`${L}: Yes, waive it: POST /bookings/:id/update { waived: true }`, waived?.status === 200 && JSON.parse(waived.body).waived === true && JSON.parse(waived.text).booking?.waived === true && JSON.parse(waived.text).booking.owed === false, waived ? `${waived.body} → ${waived.text.slice(0, 160)}` : 'no call');
const card2 = await text(p, '[data-checkin-result]');
check(`${L}: the row says Waived, no Waive button`, /Waived/.test(card2) && !(await p.$(`[data-checkin-result] [data-waive="${seatId}"]`)), card2.slice(0, 400));
const toast = await text(p, '.toast');
check(`${L}: the toast says what was let off`, /Waived: \$15 for/.test(toast), toast);
const after = ((await proxy('GET', 'me', { customer: OWES.id })).data.seats || []).find((x) => x.id === seatId);
check(`${L}: ${OWES.first} owes nothing now`, after && after.waived === true && after.owed === false && after.due === 0, after && { waived: after.waived, owed: after.owed, due: after.due });

/* 2. The Members tab: a list, sorted three ways, and "Owes money" */
await p.click('[data-tab="members"]');
await p.waitForSelector('[data-members-list] .staff-mem-row', { timeout: 8000 }).catch(() => {});
const pageOrder = async () => p.$$eval('[data-members-list] .staff-mem-row', (rows) => rows.map((r) => r.dataset.memberView));
const apiOrder = async (query) => ((await proxy('GET', `members?${query}`, { customer: '7001' })).data || []).map((m) => m.customerId);
const waitList = async (route) => {
  const from = apiLog.length;
  for (let i = 0; i < 40; i += 1) {
    if (apiLog.slice(from).some((c) => c.method === 'GET' && c.route.startsWith('members') && route.test(c.route))) break;
    await sleep(100);
  }
  await p.waitForTimeout(500);
};
const shown = await pageOrder();
const bySpend = await apiOrder('sort=spend');
check(`${L}: the Members tab lists everyone, by spend this year (the app's order)`, shown.length >= 6 && shown.join() === bySpend.join(), { shown, bySpend });
// round 6: spend is this financial year's (1 April on), and a Card column shows the loyalty card
check(`${L}: each row: name, code, this financial year, total, card, last visit, owed, open tab`, /This financial year/.test(await text(p, '[data-members-list]')) && /of 10 stamps/.test(await text(p, '[data-members-list]')) && (await text(p, `[data-members-list] [data-member-view="7101"]`)).includes(R.codes['7101']), (await text(p, '[data-members-list] .staff-mem-row')).slice(0, 200));
for (const sort of ['recent', 'owing']) {
  const wait = waitList(new RegExp(`sort=${sort}`));
  await p.check(`[data-members-sort="${sort}"]`, { force: true });
  await wait;
  const order = await pageOrder();
  const want = await apiOrder(`sort=${sort}`);
  check(`${L}: sorted by ${sort}: the app's order`, order.length && order.join() === want.join(), { order, want });
}
const owingWait = waitList(/owing=1/);
await p.check('[data-members-owing]', { force: true });
await owingWait;
const owingShown = await pageOrder();
const owingWant = await apiOrder('sort=owing&owing=1');
// (after the desktop pass waives Tui, nobody may owe anything: the list says so)
const owingText = await text(p, '[data-members-list]');
check(`${L}: "Owes money": only those who owe, most first`, owingShown.join() === owingWant.join() && !owingShown.includes(OWES.id) && (owingShown.length > 0 || /Nobody owes anything right now/.test(owingText)), { owingShown, owingWant, owingText: owingText.slice(0, 120) });
check(`${L}: no sideways scroll on the list`, (await overflow(p)) <= 0, await overflow(p));
await shot(p, `r5-staff-members-${L}`);
const backWait = waitList(/sort=spend/);
await p.uncheck('[data-members-owing]', { force: true });
await p.check('[data-members-sort="spend"]', { force: true });
await backWait;

/* 3. A birthday gift from a member's page */
await p.fill('[data-members-find]', GIFT.name.split(' ')[0].toLowerCase());
await p.waitForSelector(`[data-members-list] [data-member-view="${GIFT.id}"]`, { timeout: 8000 }).catch(() => {});
await p.click(`[data-members-list] [data-member-view="${GIFT.id}"]`);
await p.waitForSelector(`[data-gift-open="${GIFT.id}"]`, { timeout: 8000 });
await p.click(`[data-gift-open="${GIFT.id}"]`);
await p.waitForSelector('[data-gift-form]');
check(`${L}: the gift form: credit, sessions, dice rolls, a product, a note, "Email them" ticked`, Boolean(await p.$('#gift-credit')) && Boolean(await p.$('[data-gift-form] [name="sessions"]')) && Boolean(await p.$('[data-gift-form] [name="rolls"]')) && Boolean(await p.$('[data-gift-search]')) && (await p.isChecked('[data-gift-form] [name="notify"]')), await text(p, '[data-gift-form]'));
await p.fill('#gift-credit', '4');
await p.fill('[data-gift-form] [name="sessions"]', '2');
await p.fill('[data-gift-form] [name="rolls"]', '1');
await p.fill('[data-gift-search]', 'wingspan');
await p.waitForSelector('[data-gift-pick="wingspan"]', { timeout: 8000 }).catch(() => {});
await p.click('[data-gift-pick="wingspan"]');
await p.waitForSelector('[data-gift-unpick]', { timeout: 8000 }).catch(() => {});
await p.fill('#gift-note', 'Happy birthday from the Lair!');
check(`${L}: the product is picked`, /Wingspan/.test(await text(p, '[data-gift-product]')), await text(p, '[data-gift-product]'));
await shot(p, `r5-staff-gift-form-${L}`);
const callsFrom = (await fake('GET', 'calls')).length;
const emailsFrom = (await fake('GET', 'emails')).length;
b = apiLog.length;
await p.click('[data-gift-form] [type="submit"]');
await p.waitForSelector('.staff-gift--done', { timeout: 10000 }).catch(() => {});
await p.waitForTimeout(800);
const sent = apiLog.slice(b).find((c) => c.method === 'POST' && c.route === `members/${GIFT.id}/gift`);
const body = sent ? JSON.parse(sent.body) : {};
const gift = sent ? JSON.parse(sent.text).gift : null;
check(`${L}: POST /members/:id/gift with every part`, sent?.status === 200 && body.credit === 4 && body.sessions === 2 && body.rolls === 1 && /^\d+$/.test(body.productVariantId || '') && body.productTitle === 'Wingspan' && body.note === 'Happy birthday from the Lair!' && body.notify === true, sent ? `${sent.body} → ${sent.text.slice(0, 200)}` : 'no call');
check(`${L}: the app gave it all: no problems`, gift && gift.credit === 400 && gift.sessions === 2 && gift.rolls === 1 && /^HBD-/.test(gift.product?.code || '') && gift.emailed === true && gift.problems.length === 0, gift);
const done = await text(p, '.staff-gift--done');
check(`${L}: the page says what each part did, with the codes`, /Gift sent/.test(done) && /\$4 store credit/.test(done) && /2 sessions/.test(done) && /1 (dice )?roll/.test(done) && /Wingspan/.test(done) && gift && done.includes(gift.product.code) && done.includes(gift.passCode) && /Emailed/.test(done), done.slice(0, 500));
const made = (await fake('GET', 'calls')).slice(callsFrom);
const emails = (await fake('GET', 'emails')).slice(emailsFrom);
check(`${L}: once each at Shopify: the credit ($4) and the discount code (for ${GIFT.name.split(' ')[0]})`, made.filter((x) => x.op === 'Credit').length === 1 && made.find((x) => x.op === 'Credit')?.variables.creditInput.creditAmount.amount === '4.00' && made.filter((x) => x.op === 'Prize').length === 1 && made.find((x) => x.op === 'Prize')?.variables.discount.context.customers.add[0] === `gid://shopify/Customer/${GIFT.id}`, made.map((x) => x.op));
check(`${L}: one birthday email`, emails.length === 1 && [].concat(emails[0].to).includes(GIFT.email) && /Happy birthday from Gobgob/.test(emails[0].subject), emails.map((e) => [e.to, e.subject]));
check(`${L}: no sideways scroll on the gift`, (await overflow(p)) <= 0, await overflow(p));
await p.evaluate(() => document.querySelector('.staff-gift--done')?.scrollIntoView({ block: 'start' }));
await shot(p, `r5-staff-gift-done-${L}`);

problems.push(...p.problems);
check(`${L}: no script errors, console errors or failed requests`, problems.length === 0, problems.slice(0, 6).join(' | '));
await stop();
process.exit(summary() ? 1 : 0);

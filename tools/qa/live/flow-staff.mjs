// Staff page, live (Mo, tagged staff), phone first: check-in by code (a fun code, lower case without dashes, a
// legacy GOB- code, a member code); check in with a pass, switch passes, undo; the Passes tab (issue, search, edit,
// void); the Members tab (codes, a pending dice prize "Mark done", a new member code); booking cards (pass, due,
// refund states, a split bill "Paid $X of $Y").
import fs from 'node:fs';
import { start, stop, context, page, overflow, shot, text, apiLog, PHONE, DESKTOP, BASE } from './harness.mjs';
import { check, summary, proxy, pos, webhook, fake } from './client.mjs';

const seed = JSON.parse(fs.readFileSync(new URL('./seed.json', import.meta.url)));
const T = JSON.parse(fs.readFileSync(new URL('./today.json', import.meta.url)));
const DEVICE = process.argv[2] === 'desktop' ? DESKTOP : PHONE;
const L = process.argv[2] === 'desktop' ? 'desktop' : 'phone';
const run = Date.now() % 100000;
const tz = 'Pacific/Auckland';
const key = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (k, n) => new Date(Date.parse(`${k}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const today = key(Date.now());
const at = (k, h) => Date.parse(`${k}T${String(h).padStart(2, '0')}:00:00+13:00`);

/* setup through the app: refund states to sort, and a fresh gift pass to switch to */
const order = async (id, customerId, lines, source = 'pos') => {
  await fake('POST', 'order', { id, customerId, subtotal: lines.reduce((s, l) => s + Math.round(Number(l.price) * 100), 0), source });
  return webhook({ id, source_name: source, line_items: lines.map((l, i) => ({ id: id * 10 + i, quantity: 1, ...l })) });
};
// 'due': Kiri's Warhammer spot two weeks out, paid at the counter, then the night is off (staff cancel it)
let THU = addDays(today, 1);
while (new Date(`${THU}T12:00:00Z`).getUTCDay() !== 4) THU = addDays(THU, 1);
const spotDay = addDays(THU, L === 'desktop' ? 21 : 14);
const spot = await proxy('POST', `events/warhammer-wargames@${spotDay}/reserve`, { customer: '7102', body: { name: 'Kiri Smith', email: 'kiri@example.com', people: 2, pay: 'day' } });
check(`${L} setup: Kiri reserves a Warhammer spot`, spot.status === 200 && spot.data.booking?.payment === 'store', spot.data.error || spot.data.booking?.ref);
await order(90000 + run, '7102', [{ title: 'Game spot', price: '20.00', properties: [{ name: '_booking', value: spot.data.booking.ref }] }]);
const off = await proxy('POST', `bookings/${spot.data.booking.id}/update`, { customer: '7001', body: { status: 'cancelled' } });
check(`${L} setup: staff cancel the paid spot: refund 'due'`, off.data.booking?.refund === 'due' && off.data.refund?.due === true, off.data.booking?.refund);
// 'ask': a booking today with a share paid, then nobody comes
const late = await proxy('POST', 'bookings', { customer: '7102', body: { kind: 'table', tables: [L === 'desktop' ? 'T19' : 'T11'], start: at(today, 21), end: at(today, 23), people: 2, name: 'Kiri Smith', email: 'kiri+late@example.com', split: true } });
check(`${L} setup: Kiri books for 9pm, split`, late.status === 200, late.data.error);
await order(91000 + run, '7101', [{ title: 'Share', price: '10.00', properties: [{ name: '_booking', value: late.data.booking.ref }, { name: '_share', value: '1' }] }]);
const noshow = await proxy('POST', `bookings/${late.data.booking.id}/update`, { customer: '7001', body: { status: 'noshow' } });
check(`${L} setup: marked a no-show after a share was paid: refund 'ask'`, noshow.data.booking?.refund === 'ask', noshow.data.booking?.refund);
const gift = await proxy('POST', 'passes', { customer: '7001', body: { label: 'Gift pack: 5 sessions', sessions: 5, holderName: 'Hemi Walker' } });
const A2 = (await proxy('GET', 'me', { customer: '7101' })).data.bookings.find((b) => b.id === T.A2.id);
// a clean A2: not checked in yet, no pass used (an earlier run may have)
const pastUses = (await proxy('GET', `passes?q=${encodeURIComponent(seed.samPass.code)}&status=all`, { customer: '7001' })).data.passes?.[0]?.uses || [];
for (const u of pastUses.filter((x) => x.bookingId === T.A2.id && !x.undone)) await proxy('POST', `passes/uses/${u.id}/undo`, { customer: '7001', body: {} });
if (A2?.status === 'seated') await proxy('POST', `bookings/${T.A2.id}/update`, { customer: '7001', body: { status: 'confirmed' } });
await proxy('POST', `passes/${seed.samPass.id}/apply`, { customer: '7001', body: { bookingId: T.A2.id } });

await start();
const problems = [];
const ctx = await context(7001, DEVICE);
const p = await page(ctx, `${L}/staff`);
await p.goto(`${BASE}/pages/lair-staff`, { waitUntil: 'networkidle' });
await p.waitForSelector('#checkin-code');
check(`${L}: the staff page loads for a staff customer`, !(await p.$('.lair-demo')) && (await p.$$('lair-floor [data-table]')).length > 20);
const checkin = async (code) => {
  const b = apiLog.length;
  await p.fill('#checkin-code', code);
  await p.press('#checkin-code', 'Enter');
  await p.waitForSelector('.checkin-card:not(.checkin-card--pending)', { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(400);
  const call = apiLog.slice(b).find((c) => c.method === 'POST' && c.route.startsWith('checkin'));
  return { call, data: call ? JSON.parse(call.text) : {}, card: await text(p, '[data-checkin-result]') };
};

/* 1. a fun code, as printed: Sam's 8pm T13 booking with his pass saved */
const c1 = await checkin(T.A2.ref);
check(`${L}: fun code: checked in, the saved pass covers 2 sessions`, c1.call?.status === 200 && c1.data.checkedIn === true && c1.data.pass?.used === 2 && c1.data.row?.due === 0, c1.call ? c1.call.text.slice(0, 260) : 'no call');
check(`${L}: the card: checked in, the pass, covered $20, nothing to pay, Undo`, /(Already c|C)hecked in/.test(c1.card) && /Warhammer league/.test(c1.card) && /Covered \$20/.test(c1.card) && /Nothing to pay: the pass covers it/.test(c1.card) && Boolean(await p.$('[data-pass-undo]')), c1.card.slice(0, 400));
check(`${L}: no sideways scroll`, (await overflow(p)) <= 0, await overflow(p));
await p.evaluate(() => document.querySelector('[data-checkin-result]').scrollIntoView({ block: 'start' }));
await shot(p, `staff-checkin-pass-${L}`);
/* switch to the gift pack */
await p.click('[data-pass-other]');
await p.fill('#checkin-pass-code', gift.data.pass.code.toLowerCase());
let b = apiLog.length;
await p.press('#checkin-pass-code', 'Enter');
await p.waitForTimeout(1500);
const undoCall = apiLog.slice(b).find((c) => c.method === 'POST' && /^passes\/uses\/.+\/undo$/.test(c.route));
const switchCall = apiLog.slice(b).find((c) => c.method === 'POST' && c.route.startsWith('checkin'));
const switched = switchCall ? JSON.parse(switchCall.text) : {};
check(`${L}: switching passes: the league pass comes off, the gift pack goes on`, undoCall?.status === 200 && switchCall?.status === 200 && JSON.parse(switchCall.body).pass === gift.data.pass.code.toLowerCase() && switched.pass?.code === gift.data.pass.code && switched.pass.used === 2, switchCall ? switchCall.text.slice(0, 260) : 'no call');
const card2 = await text(p, '[data-checkin-result]');
check(`${L}: the card shows the gift pack now`, card2.includes(gift.data.pass.code) && /Gift pack/.test(card2), card2.slice(0, 300));
const league = (await proxy('GET', `passes?q=${encodeURIComponent(seed.samPass.code)}&status=all`, { customer: '7001' })).data.passes[0];
check(`${L}: the league pass got its sessions back`, league.uses.filter((u) => u.bookingId === T.A2.id && !u.undone).length === 0, league.uses.filter((u) => u.bookingId === T.A2.id));
/* undo */
b = apiLog.length;
await p.click('[data-pass-undo]');
await p.waitForTimeout(1200);
const undone = apiLog.slice(b).find((c) => c.method === 'POST' && /^passes\/uses\/.+\/undo$/.test(c.route));
const card3 = await text(p, '[data-checkin-result]');
check(`${L}: Undo pass: the sessions go back, $20 to pay again`, undone?.status === 200 && JSON.parse(undone.text).row?.due === 2000 && /Pass taken off/.test(card3) && /To pay: \$20/.test(card3), card3.slice(0, 300));

/* 2. lower case without dashes: Kiri's split bill */
const c4 = await checkin(T.B.ref.toLowerCase().replace(/-/g, ''));
check(`${L}: lower case without dashes checks in`, c4.call?.status === 200 && c4.data.row?.ref === T.B.ref && c4.data.checkedIn === true, c4.call ? c4.call.text.slice(0, 200) : 'no call');
check(`${L}: the split bill: "Splitting the bill", paid $20 of $40, $20 left, who paid`, /Splitting the bill/.test(c4.card) && /Paid \$20 of \$40 · \$20 left/.test(c4.card) && /Sam Jones \$10/.test(c4.card) && /Leo Tane \$10/.test(c4.card), c4.card.slice(0, 500));
await shot(p, `staff-checkin-split-${L}`);

/* 3. legacy GOB- codes, with and without the dash */
const c5 = await checkin('GOB-7K2QXM');
check(`${L}: legacy GOB-7K2QXM`, c5.call?.status === 200 && c5.data.row?.ref === 'GOB-7K2QXM' && (c5.data.checkedIn === true), c5.call ? c5.call.text.slice(0, 220) : 'no call');
const c6 = await checkin('gob7k2qxm');
check(`${L}: legacy without the dash, lower case`, c6.call?.status === 200 && c6.data.row?.ref === 'GOB-7K2QXM', c6.call ? c6.call.text.slice(0, 160) : 'no call');

/* 4. a member code: Leo's card with his rows today */
const leoCode = (await proxy('GET', 'me', { customer: '7104' })).data.member.code;
const c7 = await checkin(leoCode);
check(`${L}: member code: Leo's card, his rows today`, c7.call?.status === 200 && c7.data.kind === 'member' && c7.data.rows?.length >= 2 && /Member/.test(c7.card) && c7.card.includes(leoCode), c7.call ? c7.call.text.slice(0, 200) : 'no call');

/* 5. the Passes tab */
await p.click('[data-tab="passes"]');
await p.waitForSelector('[data-pass-issue]');
await p.click('[data-pass-issue]');
await p.click('[data-pass-preset="Gift pack: 10 sessions"]');
await p.check('[data-pass-owner-pick][value="name"]', { force: true }).catch(() => {}); // round 7: who it's for, Type a name
await p.fill('[data-pass-new] [name="holderName"]', `Aroha ${L}`);
await p.fill('[data-pass-new] [name="holderEmail"]', `aroha.${L}@example.com`);
await p.fill('[data-pass-new] [name="pricePaid"]', '90');
b = apiLog.length;
await p.click('[data-pass-new] [type="submit"]');
await p.waitForSelector('[data-pass-card] svg', { timeout: 6000 }).catch(() => {});
const issued = apiLog.slice(b).find((c) => c.method === 'POST' && c.route === 'passes');
const newPass = issued ? JSON.parse(issued.text).pass : null;
check(`${L}: issue a pass from the form`, issued?.status === 200 && newPass?.label === 'Gift pack: 10 sessions' && newPass.sessionsTotal === 10 && newPass.pricePaid === 9000 && /^A[A-Z]-[A-Z]+-\d+$/.test(newPass.code), issued ? `${issued.body} → ${issued.text.slice(0, 200)}` : 'no call');
const passCard = await text(p, '[data-pass-card]');
check(`${L}: the pass shows its code and QR`, newPass && passCard.includes(newPass.code) && /10 sessions left/.test(passCard) && Boolean(await p.$('[data-pass-card] svg')), passCard.slice(0, 200));
await shot(p, `staff-passes-${L}`);
// search by name, then by code typed loosely
await p.click('[data-pass-back]');
await p.fill('[data-pass-find]', `aroha ${L}`);
await p.waitForTimeout(900);
const found1 = await text(p, '[data-pass-list]');
check(`${L}: search by holder name finds it`, newPass && found1.includes(newPass.code), found1.slice(0, 200));
await p.fill('[data-pass-find]', newPass ? newPass.code.toLowerCase().replace(/-/g, ' ') : 'x');
await p.waitForTimeout(900);
const found2 = await text(p, '[data-pass-list]');
check(`${L}: search by code (lower case, spaces) finds it`, newPass && found2.includes(newPass.code), found2.slice(0, 200));
// open it, edit, void
await p.click(`[data-pass-open="${newPass.id}"]`);
await p.waitForSelector('[data-pass-card] svg');
await p.click('[data-passes] .staff-gm__more summary');
await p.fill('[data-pass-edit] [name="sessions"]', '12');
await p.fill('[data-pass-edit] [name="note"]', 'Topped up');
b = apiLog.length;
await p.click('[data-pass-edit] [type="submit"]');
await p.waitForTimeout(1000);
const edited = apiLog.slice(b).find((c) => c.method === 'POST' && /^passes\/.+\/update$/.test(c.route));
check(`${L}: edit the pass (12 sessions, a note)`, edited?.status === 200 && JSON.parse(edited.text).pass.sessionsTotal === 12 && JSON.parse(edited.text).pass.note === 'Topped up', edited ? edited.text.slice(0, 200) : 'no call');
await p.click(`[data-pass-confirm="void:${newPass.id}"]`);
b = apiLog.length;
await p.click(`[data-pass-set-status="void"][data-id="${newPass.id}"]`);
await p.waitForTimeout(1000);
const voided = apiLog.slice(b).find((c) => c.method === 'POST' && /^passes\/.+\/update$/.test(c.route));
check(`${L}: void the pass`, voided?.status === 200 && JSON.parse(voided.text).pass.status === 'void' && /Void/.test(await text(p, '[data-pass-card]')), voided ? voided.text.slice(0, 160) : 'no call');
const tryVoid = await checkin(newPass.code);
check(`${L}: a void pass scanned at check-in says so`, tryVoid.data.kind === 'pass' && /Void/.test(tryVoid.card), tryVoid.card.slice(0, 200));

/* 6. the Members tab (round 5: a list to sort and search, and a page for each member): Sam's pending prize, Leo's
   new code */
await p.click('[data-tab="members"]');
await p.waitForSelector('[data-members-find]');
const samCode = (await proxy('GET', 'me', { customer: '7101' })).data.member.code;
await p.fill('[data-members-find]', samCode.toLowerCase());
await p.waitForFunction((c) => (document.querySelector('[data-members-list]')?.textContent || '').includes(c), samCode, { timeout: 8000 }).catch(() => {});
const members = await text(p, '[data-members-list]');
const pendingPrize = ((await proxy('GET', `members?q=${encodeURIComponent(samCode)}`, { customer: '7001' })).data[0]?.pendingPrizes || [])[0] || null;
check(`${L}: (Sam has a dice prize waiting from the My Lair run)`, Boolean(pendingPrize), 'run flow-mylair.mjs first');
check(`${L}: search by member code: Sam's row with his code`, members.includes('Sam Jones') && members.includes(samCode), members.slice(0, 200));
await p.click('[data-members-list] [data-member-view="7101"]');
await p.waitForSelector('[data-person-card]');
await p.waitForFunction(() => !/Looking up what they owe|Loading their passes/.test(document.querySelector('.staff-person')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
const person = await text(p, '[data-person-card]');
const prizesText = await text(p, '[data-person-prizes]');
check(`${L}: Sam's page: his code and its QR`, person.includes(samCode) && Boolean(await p.$('[data-person-card] svg')), person.slice(0, 200));
check(`${L}: Sam's dice prize waiting at the counter shows, with Mark done`, !pendingPrize || (/to sort at the counter/.test(prizesText) && Boolean(await p.$(`[data-prize-done="${pendingPrize.id}"]`))), prizesText.slice(0, 300));
await shot(p, `staff-members-${L}`);
if (pendingPrize) {
  b = apiLog.length;
  await p.click(`[data-prize-done="${pendingPrize.id}"]`);
  await p.waitForTimeout(1000);
  const done = apiLog.slice(b).find((c) => c.method === 'POST' && /^prizes\/.+\/done$/.test(c.route));
  check(`${L}: Mark done: the prize is sorted`, done?.status === 200 && JSON.parse(done.text).prize.status === 'done' && !(await p.$(`[data-prize-done="${pendingPrize.id}"]`)), done ? done.text : 'no call');
}
await p.click('[data-members-back]');
await p.waitForSelector('[data-members-find]');
await p.fill('[data-members-find]', 'leo');
await p.waitForSelector('[data-members-list] [data-member-view="7104"]', { timeout: 8000 }).catch(() => {});
await p.click('[data-members-list] [data-member-view="7104"]');
await p.waitForSelector('[data-member-confirm="code:7104"]');
await p.click('[data-member-confirm="code:7104"]');
b = apiLog.length;
await p.click('[data-member-new-code="7104"]');
await p.waitForTimeout(1000);
const fresh = apiLog.slice(b).find((c) => c.method === 'POST' && c.route === 'members/7104/new-code');
const newCode = fresh ? JSON.parse(fresh.text).code : '';
const leoCard = await text(p, '[data-person-card]');
check(`${L}: a new member code for Leo, shown with "New"`, fresh?.status === 200 && newCode && newCode !== leoCode && leoCard.includes(newCode) && /New/.test(leoCard), fresh ? `${fresh.text} | ${leoCard.slice(0, 160)}` : 'no call');
const oldScan = await checkin(leoCode);
check(`${L}: the old member code stops working`, oldScan.call?.status === 404 || oldScan.data.kind !== 'member', oldScan.card.slice(0, 120));
const newScan = await checkin(newCode);
check(`${L}: the new one works`, newScan.data.kind === 'member', newScan.card.slice(0, 120));

/* 7. booking cards: Today's bookings and Refunds to sort */
await p.click('[data-tab="today"]');
await p.waitForTimeout(500);
const todayText = await text(p, '[data-today-list]');
const cardOf = async (ref) => p.evaluate((r) => [...document.querySelectorAll('[data-today-list] .staff-card, [data-refunds] .staff-card')].find((c) => c.textContent.includes(r))?.innerText.replace(/\s+/g, ' ') || '', ref);
const cardA = await cardOf(T.A.ref);
check(`${L}: Sam's card: Paid, the pass and what it covered`, /Paid/.test(cardA) && /Pass covered \$40/.test(cardA) && /Pass: Warhammer league/.test(cardA), cardA);
const cardB = await cardOf(T.B.ref);
check(`${L}: Kiri's card: "Splitting the bill", Part paid, "Paid $20 of $40 · $20 left", who paid`, /Splitting the bill/.test(cardB) && /Part paid/.test(cardB) && /Paid \$20 of \$40 · \$20 left/.test(cardB) && /Sam Jones \$10/.test(cardB), cardB);
const cardA2 = await cardOf(T.A2.ref);
check(`${L}: Sam's 8pm card: $20 to pay, its saved pass`, /To pay \$20/.test(cardA2) && /Pass:/.test(cardA2), cardA2);
await p.evaluate((r) => [...document.querySelectorAll('[data-today-list] .staff-card')].find((c) => c.textContent.includes(r))?.scrollIntoView({ block: 'center' }), T.B.ref);
await shot(p, `staff-card-split-${L}`);
const refunds = await text(p, '[data-refunds]');
check(`${L}: Refunds to sort: "Refund due: $20" for the cancelled paid spot`, refunds.includes(spot.data.booking.ref) && /Refund due: \$20/.test(refunds), refunds.slice(0, 400));
check(`${L}: Refunds to sort: "Refund? Your call." for the paid no-show`, refunds.includes(late.data.booking.ref) && /Refund\? Your call\./.test(refunds), refunds.slice(0, 600));
check(`${L}: Refunds to sort: the online-paid sign-up Sam cancelled`, /Refund\? Your call/.test(refunds) && /Riftbound store championship|Event sign-up/.test(refunds), refunds.slice(0, 600));
await p.evaluate(() => document.querySelector('[data-refunds]').scrollIntoView({ block: 'start' }));
await shot(p, `staff-refunds-${L}`);
b = apiLog.length;
await p.click(`[data-refunds] [data-act="refund"][data-id="${spot.data.booking.id}"]`);
await p.waitForTimeout(1000);
const marked = apiLog.slice(b).find((c) => c.method === 'POST' && c.route === `bookings/${spot.data.booking.id}/update`);
check(`${L}: Mark refunded: refund 'done'`, marked?.status === 200 && JSON.parse(marked.text).booking.refund === 'done', marked ? marked.text.slice(0, 160) : 'no call');
const kiriMe = (await proxy('GET', 'me', { customer: '7102' })).data;
check(`${L}: Kiri's My Lair has the refund states: done and ask`, kiriMe.bookings.find((x) => x.id === spot.data.booking.id)?.refund === 'done' && kiriMe.bookings.find((x) => x.id === late.data.booking.id)?.refund === 'ask');

problems.push(...p.problems);
check(`${L}: no script errors, console errors or failed requests`, problems.filter((x) => !/404/.test(x)).length === 0, problems.slice(0, 6).join(' | '));
await stop();
process.exit(summary() ? 1 : 0);

// GM games board, live: a seat without a pass, a seat with a pass (the GM fee is still paid), "join every session",
// and the GM's tools (message the players, cancel a session). Ana (trusted GM) lists a weekly game first.
// Round 5: a weekly regular ("save my seat every week") holds a seat in the next session only; later sessions are seated
// as each one ends (flow-r5-regulars.mjs covers that part). Round 15 (Mo, 12 Oct 2026): a seat goes on the tab, paid at the
// counter on the day, with no code or QR to show; it can be given up (skipped) online until 24 hours before, then it's
// locked in (the checks follow whichever it is when the run happens).
import fs from 'node:fs';
import { start, stop, context, page, overflow, shot, text, apiLog, PHONE, DESKTOP, BASE } from './harness.mjs';
import { check, summary, proxy, fake } from './client.mjs';

const seed = JSON.parse(fs.readFileSync(new URL('./seed.json', import.meta.url)));
const DEVICE = process.argv[2] === 'desktop' ? DESKTOP : PHONE;
const L = process.argv[2] === 'desktop' ? 'desktop' : 'phone';
const tz = 'Pacific/Auckland';
const key = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (k, n) => new Date(Date.parse(`${k}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dow = (k) => new Date(`${k}T12:00:00Z`).getUTCDay();
let WED = addDays(key(Date.now()), 1);
while (dow(WED) !== 3) WED = addDays(WED, 1);
const at = (k, h) => Date.parse(`${k}T${String(h).padStart(2, '0')}:00:00+13:00`);
const tables = L === 'desktop' ? ['G3', 'G4'] : ['P1', 'P2'];

await start();
const problems = [];
const out = {};
// earlier runs' weekly games: cancel the series so the tables are free again
for (const old of (await proxy('GET', 'me', { customer: '7103' })).data.games || []) {
  if (old.title === `Tomb of Annihilation (${L})` && old.status !== 'cancelled') await proxy('POST', `games/${old.id}/update`, { customer: '7103', body: { status: 'cancelled', scope: 'series' } });
}
const listed = await proxy('POST', 'games', {
  customer: '7103',
  body: { title: `Tomb of Annihilation (${L})`, system: 'D&D 5e', gm: 'Ana', email: 'ana@example.com', blurb: 'Jungle, dinosaurs and a death curse.', seats: 4, level: 'some', age: '13+', tables, start: at(WED, 18), end: at(WED, 21), schedule: 'weekly', gmFee: 1000, characters: 'bring' },
});
check(`${L}: Ana lists a weekly game ($10 GM fee, live straight away)`, listed.status === 200 && !listed.data.pending && listed.data.sessions?.length >= 4, listed.data.error || listed.data.sessions?.length);
const g = listed.data.game;
out.game = g;
const second = listed.data.sessions?.[1]?.id;

async function openJoin(p, id, every = false) {
  await p.goto(`${BASE}/pages/gm-games?join=${encodeURIComponent(id)}${every ? '&every=1' : ''}`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#gm-join-form', { timeout: 8000 });
}
/** Round 7: a mobile is required. The form's phone field sits behind "Change" when the booker is known; it's filled only when empty. */
async function typeMobile(p, mobile) {
  const field = p.locator('#gm-join-form input[type="tel"], #gm-join-form input[name="phone"]');
  if (!(await field.count()) || (await field.first().inputValue())) return;
  if (!(await field.first().isVisible()) && (await p.$('[data-booker-edit]'))) await p.click('[data-booker-edit]');
  await field.first().fill(mobile);
}

/** The TAB words on the page, for a reply's lock */
const tab = (p, x) => p.evaluate((x) => {
  const T = window.Lair.TAB;
  const lock = window.Lair.lockOf(x || {});
  return { onTab: T.onTab, ahead: T.ahead(), soon: T.soon(), cancel: lock.locked ? T.lockedNow() : lock.cancelUntil ? T.cancelBy(lock.cancelUntil) : '', locked: lock.locked, lockedLabel: T.lockedLabel, cancelUntil: lock.cancelUntil ? T.cancelUntil(lock.cancelUntil) : '' };
}, x || null);
/** No code or QR on a confirmation (round 15) */
const noCode = async (p, ref) => !(await text(p, '.gm-done')).includes(ref || '?') && !(await p.locator('.gm-done [aria-label^="QR"], .gm-done .gm-ticket__stub, .gm-done [data-ticket-code]').count());

/* 1. Leo: a seat, no pass */
const leo = await context(7104, DEVICE);
const pl = await page(leo, `${L}/leo`);
await openJoin(pl, g.id);
const form1 = await text(pl, '#gm-join-form');
const w1 = await tab(pl);
check(`${L}: the seat form says it goes on the tab (cancel up to 24 hours before), $20 a seat, nothing online`, (form1.includes(w1.ahead) || form1.includes(w1.soon)) && /\$20 a seat/.test(form1) && !/online/i.test(form1), form1.slice(0, 400));
await typeMobile(pl, '021 555 0104');
let b = apiLog.length;
await pl.click('[data-join-submit]');
await pl.waitForSelector('.gm-done', { timeout: 8000 }).catch(() => {});
let call = apiLog.slice(b).find((c) => c.method === 'POST' && c.route.startsWith('bookings'));
let sent = call ? JSON.parse(call.body) : {};
let got = call ? JSON.parse(call.text) : {};
check(`${L}: the seat is booked, paid at the counter, no pay or pass sent`, call?.status === 200 && !('pay' in sent) && !('usePass' in sent) && got.booking?.status === 'confirmed' && got.booking.amount === 2000 && got.booking.payment === 'store', call ? `${call.body.slice(0, 120)} → ${call.text.slice(0, 160)}` : 'no call');
const tk1 = await text(pl, '.gm-done');
const w1b = await tab(pl, { ...got.booking });
check(`${L}: Leo's confirmation: $20 on your tab, TAB.onTab, until when to cancel (or locked in), no code or QR, See your tab in My Lair`, /Seat fee\s*\$20 on your tab/.test(tk1) && tk1.includes(w1b.onTab) && w1b.cancel && tk1.includes(w1b.cancel) && await noCode(pl, got.booking?.ref) && (await pl.locator('.gm-done a', { hasText: 'See your tab in My Lair' }).count()) === 1, tk1.slice(0, 500));
out.leoSeat = got.booking;
problems.push(...pl.problems);
await leo.close();

/* 2. Sam: a seat with his pass: it covers the table part, the $10 GM fee is still paid */
const sam = await context(7101, DEVICE);
const ps = await page(sam, `${L}/sam`);
await openJoin(ps, g.id);
await ps.waitForSelector('#gm-join-form input[name="usePass"]', { timeout: 5000 }).catch(() => {});
const hasPass = Boolean(await ps.$('#gm-join-form input[name="usePass"]'));
check(`${L}: Sam is offered his pass on the seat form`, hasPass);
if (hasPass) await ps.check('#gm-join-form input[name="usePass"]');
await ps.waitForTimeout(200);
// the league pass, when he has more than one (a run on a used state: a birthday gift's pass comes first)
if (await ps.locator('#gm-join-form select[name="passCode"]').isVisible().catch(() => false)) {
  await ps.selectOption('#gm-join-form select[name="passCode"]', seed.samPass.code);
  await ps.waitForTimeout(200);
}
const maths = await text(ps, '#gm-join-form [data-pass-maths]');
check(`${L}: the pass maths: covers $10, the $10 GM fee is still paid`, /\$10/.test(maths) && /GM fee|pay \$10/i.test(maths), maths);
b = apiLog.length;
await ps.click('[data-join-submit]');
await ps.waitForSelector('.gm-done', { timeout: 8000 }).catch(() => {});
call = apiLog.slice(b).find((c) => c.method === 'POST' && c.route.startsWith('bookings'));
sent = call ? JSON.parse(call.body) : {};
got = call ? JSON.parse(call.text) : {};
check(`${L}: usePass is sent and saved on the seat`, sent.usePass === seed.samPass.code && got.booking?.pass?.code === seed.samPass.code && !('pay' in sent), call ? `${call.body.slice(0, 160)} → ${call.text.slice(0, 200)}` : 'no call');
const tk2 = await text(ps, '.gm-done');
check(`${L}: Sam's confirmation: the pass covers $10 when he checks in, the seat on his tab, no code`, /Warhammer league/.test(tk2) && /Covers \$10 when you check in/.test(tk2) && /\$20 on your tab/.test(tk2) && await noCode(ps, got.booking?.ref), tk2.slice(0, 420));
check(`${L}: no sideways scroll`, (await overflow(ps)) <= 0, await overflow(ps));
await shot(ps, `gm-seat-ticket-pass-${L}`);
out.samSeat = got.booking;
problems.push(...ps.problems);
await sam.close();

/* 3. Kiri: join every session (round 5: her seat in the next session, her member code as the ticket) */
const kiriCode = (await proxy('GET', 'me', { customer: '7102' })).data.member?.code;
const kiri = await context(7102, DEVICE);
const pk = await page(kiri, `${L}/kiri`);
await openJoin(pk, g.id, true);
const mode = await pk.evaluate(() => document.querySelector('#gm-join-form input[name="joinMode"]:checked')?.value);
check(`${L}: "Join every session" opens in series mode`, mode === 'series', mode);
await typeMobile(pk, '021 555 0102');
b = apiLog.length;
await pk.click('[data-join-submit]');
await pk.waitForSelector('.gm-done', { timeout: 8000 }).catch(() => {});
call = apiLog.slice(b).find((c) => c.method === 'POST' && /join-series/.test(c.route));
got = call ? JSON.parse(call.text) : {};
check(`${L}: a regular: a seat in the next session only`, call?.status === 200 && got.booked?.length === 1 && got.booked[0].gameId === g.id && /^KS-[A-Z]+-\d+$/.test(got.booked[0].ref) && !('pay' in JSON.parse(call.body)), call ? call.text.slice(0, 260) : 'no call');
const tk3 = await text(pk, '.gm-done');
// the seat joining books is locked like a one-off seat (24 hours before), as GET /me has it
const seat3 = ((await proxy('GET', 'me', { customer: '7102' })).data.seats || []).find((x) => x.gameId === g.id && x.status !== 'cancelled');
const w3 = await tab(pk, seat3);
check(`${L}: the "regular" confirmation: seat saved every week, $20 on her tab each week, TAB.onTab, until when to skip it (or locked in), no card or code`, /A regular! Gobgob has saved your seat/.test(tk3) && /Your seat’s saved every week/.test(tk3) && /Each week\s*\$20 on your tab/.test(tk3) && tk3.includes(w3.onTab) && w3.cancel && tk3.includes(w3.cancel) && !/Goblin card is your ticket/.test(tk3) && !tk3.includes(kiriCode || '?') && await noCode(pk, got.booked?.[0]?.ref), { seat3: seat3 && { cancelUntil: seat3.cancelUntil, locked: seat3.locked }, tk3: tk3.slice(0, 500) });
out.series = got;
problems.push(...pk.problems);
await kiri.close();

/* 4. The GM's tools: message the players, cancel the second session */
const ana = await context(7103, DEVICE);
const pa = await page(ana, `${L}/ana`);
await pa.goto(`${BASE}/pages/gm-games#game=${encodeURIComponent(g.id)}`, { waitUntil: 'networkidle' });
await pa.waitForSelector('.gm-own', { timeout: 8000 }).catch(() => {});
const own = await text(pa, '.gm-own');
check(`${L}: Ana sees her players (Leo, Sam, Kiri) on her game`, /Leo/.test(own) && /Sam/.test(own) && /Kiri/.test(own), own.slice(0, 300));
await pa.click(`.gm-own [data-message="${g.id}"]`);
await pa.waitForSelector('[data-message-form]');
await pa.fill('[data-message-form] textarea[name="message"]', 'Kia ora team! Bring a d20 and a hat. See you Wednesday.');
const emailsBefore = (await fake('GET', 'emails')).length;
b = apiLog.length;
await pa.click('[data-message-send]');
await pa.waitForTimeout(1500);
call = apiLog.slice(b).find((c) => c.method === 'POST' && /\/message$/.test(c.route));
got = call ? JSON.parse(call.text) : {};
const emails = (await fake('GET', 'emails')).slice(emailsBefore);
check(`${L}: the message went to the three players`, call?.status === 200 && got.sent === 3 && emails.length === 3 && emails.every((e) => /A message from your GM/.test(e.text || '') || /message from Ana/.test(e.subject)), call ? `${call.text} / ${emails.map((e) => e.subject).join(' | ')}` : 'no call');
const flash = await text(pa, 'gm-board dialog');
check(`${L}: the board says it was sent`, /Sent\. Gobgob emailed 3 people/.test(flash), flash.slice(0, 200));
if (second) {
  await pa.goto('about:blank');
  await pa.goto(`${BASE}/pages/gm-games#game=${encodeURIComponent(second)}`, { waitUntil: 'networkidle' });
  await pa.waitForSelector(`.gm-own [data-cancel-ask="${second}"]`, { timeout: 8000 }).catch(() => {});
  await pa.click(`.gm-own [data-cancel-ask="${second}"][data-scope="session"]`);
  await pa.waitForSelector(`[data-cancel-do="${second}"]`);
  b = apiLog.length;
  await pa.click(`[data-cancel-do="${second}"]`);
  await pa.waitForTimeout(1500);
  call = apiLog.slice(b).find((c) => c.method === 'POST' && c.route === `games/${second}/update`);
  got = call ? JSON.parse(call.text) : {};
  // round 5: nobody holds a seat in the session after next yet (regulars roll forward as each session ends)
  check(`${L}: the GM cancelled the session after next: nobody had a seat in it yet`, call?.status === 200 && got.game?.status === 'cancelled' && got.affected === 0, call ? call.text.slice(-200) : 'no call');
  const told = await text(pa, 'gm-board dialog');
  check(`${L}: the board says there was no one to tell`, /Cancelled .+Nobody had a seat, so there was no one to tell\./.test(told), told.slice(0, 200));
}
problems.push(...pa.problems);
await ana.close();

/* 5. Kiri: skip one session, then leave the series */
const kiri2 = await context(7102, DEVICE);
const pk2 = await page(kiri2, `${L}/kiri-again`);
/* skip one session, then leave the series */
await pk2.goto('about:blank');
await pk2.goto(`${BASE}/pages/gm-games#game=${encodeURIComponent(g.id)}`, { waitUntil: 'networkidle' });
await pk2.waitForSelector('[data-leave]', { timeout: 8000 }).catch(() => {});
const youText = await text(pk2, '.gm-you');
const seat5 = ((await proxy('GET', 'me', { customer: '7102' })).data.seats || []).find((x) => x.gameId === g.id && x.status !== 'cancelled');
const w5 = await tab(pk2, seat5);
check(`${L}: Kiri's seat on the game: saved every week, $20 on her tab each week, no code; ${w5.locked ? 'locked in (no Skip), Stop saving my seat' : 'Skip this week with until when, Stop saving my seat'}`,
  /Your seat’s saved every week/.test(youText) && /\$20 on your tab each week/.test(youText) && !youText.includes(kiriCode || '?') && Boolean(await pk2.$('[data-leave]'))
  && (w5.locked ? youText.includes(w5.lockedLabel) && !(await pk2.$('[data-skip]')) : Boolean(await pk2.$('[data-skip]')) && youText.includes(w5.cancelUntil)), youText.slice(0, 300));
if (!w5.locked) {
  await pk2.click('[data-skip]');
  await pk2.waitForSelector('[data-skip-do]');
  b = apiLog.length;
  await pk2.click('[data-skip-do]');
  await pk2.waitForTimeout(1500);
  call = apiLog.slice(b).find((c) => c.method === 'POST' && /^bookings\/.+\/update$/.test(c.route));
  check(`${L}: skipping a session cancels that seat only, and the seat stays saved after that`, call?.status === 200 && JSON.parse(call.body).status === 'cancelled' && JSON.parse(call.text).booking.status === 'cancelled' && /Skipped .+Your seat’s still saved after that\./.test(await text(pk2, 'gm-board dialog')), call ? call.text.slice(0, 160) : 'no call');
}
const kiriMe = (await proxy('GET', 'me', { customer: '7102' })).data;
check(`${L}: she's still a regular after skipping`, kiriMe.series?.some((m) => m.seriesId === g.seriesId), kiriMe.series);
const coming = (kiriMe.seats || []).filter((x) => x.seriesId === g.seriesId && ['held', 'confirmed'].includes(x.status) && x.start > Date.now()).length;
await pk2.waitForSelector('[data-leave]', { timeout: 8000 }).catch(() => {});
await pk2.click('[data-leave]');
await pk2.waitForSelector('[data-leave-do]');
b = apiLog.length;
await pk2.click('[data-leave-do]');
await pk2.waitForTimeout(1500);
call = apiLog.slice(b).find((c) => c.method === 'POST' && /^series\/.+\/leave$/.test(c.route));
const left = call ? JSON.parse(call.text) : {};
// round 15: a seat that's locked in stays on her tab (kept); the rest are freed
check(`${L}: leaving the series frees the seats to come (${w5.locked ? 'the locked-in one stays on her tab' : 'none after the skip'})`, call?.status === 200 && left.ok === true && left.cancelled + (left.kept || []).length === coming && (left.kept || []).length === (w5.locked ? 1 : 0) && /Gobgob has stopped saving your seat/.test(await text(pk2, 'gm-board dialog')), call ? `${call.text} (coming ${coming})` : 'no call');
check(`${L}: she's not a regular any more`, !((await proxy('GET', 'me', { customer: '7102' })).data.series || []).some((m) => m.seriesId === g.seriesId));
problems.push(...pk2.problems);
await kiri2.close();
check(`${L}: no script errors, console errors or failed requests`, problems.length === 0, problems.slice(0, 6).join(' | '));
fs.writeFileSync(new URL(`./games-${L}.json`, import.meta.url), JSON.stringify(out, null, 2));
await stop();
process.exit(summary() ? 1 : 0);

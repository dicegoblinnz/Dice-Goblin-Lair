// GM games board, live: a seat without a pass, a seat with a pass (the GM fee is still paid), "join every session",
// and the GM's tools (message the players, cancel a session). Ana (trusted GM) lists a weekly game first.
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

/* 1. Leo: a seat, no pass */
const leo = await context(7104, DEVICE);
const pl = await page(leo, `${L}/leo`);
await openJoin(pl, g.id);
const form1 = await text(pl, '#gm-join-form');
check(`${L}: the seat form says pay at the counter, $20 a seat`, /Pay at the counter/.test(form1) && /\$20 a seat/.test(form1) && !/online/i.test(form1), form1.slice(0, 300));
let b = apiLog.length;
await pl.click('[data-join-submit]');
await pl.waitForSelector('.gm-done', { timeout: 8000 }).catch(() => {});
let call = apiLog.slice(b).find((c) => c.method === 'POST' && c.route.startsWith('bookings'));
let sent = call ? JSON.parse(call.body) : {};
let got = call ? JSON.parse(call.text) : {};
check(`${L}: the seat is booked, paid at the counter, no pay or pass sent`, call?.status === 200 && !('pay' in sent) && !('usePass' in sent) && got.booking?.status === 'confirmed' && got.booking.amount === 2000 && got.booking.payment === 'store', call ? `${call.body.slice(0, 120)} → ${call.text.slice(0, 160)}` : 'no call');
const tk1 = await text(pl, '.gm-done');
check(`${L}: Leo's ticket: code, QR, $20 at the counter`, tk1.includes(got.booking?.ref || '?') && /\$20/.test(tk1) && /Pay at the counter/.test(tk1) && Boolean(await pl.$('.gm-done svg')), tk1.slice(0, 260));
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
check(`${L}: Sam's ticket: the pass, and $10 to pay at the counter`, /Warhammer league/.test(tk2) && /Covers \$10/.test(tk2) && /Pay \$10 at the counter/.test(tk2), tk2.slice(0, 320));
check(`${L}: no sideways scroll`, (await overflow(ps)) <= 0, await overflow(ps));
await shot(ps, `gm-seat-ticket-pass-${L}`);
out.samSeat = got.booking;
problems.push(...ps.problems);
await sam.close();

/* 3. Kiri: join every session */
const kiri = await context(7102, DEVICE);
const pk = await page(kiri, `${L}/kiri`);
await openJoin(pk, g.id, true);
const mode = await pk.evaluate(() => document.querySelector('#gm-join-form input[name="joinMode"]:checked')?.value);
check(`${L}: "Join every session" opens in series mode`, mode === 'series', mode);
b = apiLog.length;
await pk.click('[data-join-submit]');
await pk.waitForSelector('.gm-done', { timeout: 8000 }).catch(() => {});
call = apiLog.slice(b).find((c) => c.method === 'POST' && /join-series/.test(c.route));
got = call ? JSON.parse(call.text) : {};
check(`${L}: every session: a seat in each upcoming session, each with its own code`, call?.status === 200 && got.booked?.length === listed.data.sessions.length && got.booked.every((x) => /^KS-[A-Z]+-\d+$/.test(x.ref)) && !('pay' in JSON.parse(call.body)), call ? call.text.slice(0, 200) : 'no call');
const tk3 = await text(pk, '.gm-done');
check(`${L}: the "regular" ticket lists the sessions and says pay at the counter each session`, /You’re in every session/.test(tk3) && /Pay at the counter each session/.test(tk3) && got.booked && tk3.includes(got.booked[0].ref), tk3.slice(0, 300));
out.series = got;
const seriesResult = got;
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
  check(`${L}: the GM cancelled one session: Kiri's seat in it goes`, call?.status === 200 && got.game?.status === 'cancelled' && got.affected === 1, call ? call.text.slice(0, 200) : 'no call');
  const told = await text(pa, 'gm-board dialog');
  check(`${L}: the board says who was told`, /Cancelled .+We’ve emailed 1 booking/.test(told), told.slice(0, 200));
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
check(`${L}: Kiri's ticket on the game, with skip and leave`, seriesResult.booked && youText.includes(seriesResult.booked[0].ref) && Boolean(await pk2.$('[data-skip]')) && Boolean(await pk2.$('[data-leave]')), youText.slice(0, 200));
await pk2.click('[data-skip]');
await pk2.waitForSelector('[data-skip-do]');
b = apiLog.length;
await pk2.click('[data-skip-do]');
await pk2.waitForTimeout(1500);
call = apiLog.slice(b).find((c) => c.method === 'POST' && /^bookings\/.+\/update$/.test(c.route));
check(`${L}: skipping a session cancels that seat only`, call?.status === 200 && JSON.parse(call.body).status === 'cancelled' && JSON.parse(call.text).booking.status === 'cancelled' && /Skipped .+You’re still in every other session\./.test(await text(pk2, 'gm-board dialog')), call ? call.text.slice(0, 160) : 'no call');
await pk2.waitForSelector('[data-leave]', { timeout: 8000 }).catch(() => {});
await pk2.click('[data-leave]');
await pk2.waitForSelector('[data-leave-do]');
b = apiLog.length;
await pk2.click('[data-leave-do]');
await pk2.waitForTimeout(1500);
call = apiLog.slice(b).find((c) => c.method === 'POST' && /^series\/.+\/leave$/.test(c.route));
const left = call ? JSON.parse(call.text) : {};
check(`${L}: leaving the series frees the seats to come`, call?.status === 200 && left.ok === true && left.cancelled === seriesResult.booked.length - 2 && /You’ve left/.test(await text(pk2, 'gm-board dialog')), call ? call.text : 'no call');
problems.push(...pk2.problems);
await kiri2.close();
check(`${L}: no script errors, console errors or failed requests`, problems.length === 0, problems.slice(0, 6).join(' | '));
fs.writeFileSync(new URL(`./games-${L}.json`, import.meta.url), JSON.stringify(out, null, 2));
await stop();
process.exit(summary() ? 1 : 0);

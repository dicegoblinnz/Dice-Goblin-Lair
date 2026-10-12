// Events calendar, live, phone first: join an "In store" event, an "Online or in store" event, an "Online" event, a free
// event; reserve a Warhammer game table with a pass. Round 15 (Mo, 12 Oct 2026: "Don't create a new QR code to pay make
// it live inside each person's tab"): every sign-up and game table goes on the tab, paid at the counter on the day, whatever
// the event's payment said: nothing is held for a checkout (none is made, even with Shopify's checkout down), the
// confirmation has no code or QR, and it says until when it can be cancelled online (24 hours before).
import fs from 'node:fs';
import { start, stop, context, page, overflow, shot, text, apiLog, PHONE, DESKTOP, BASE } from './harness.mjs';
import { check, summary, fake, proxy } from './client.mjs';

const seed = JSON.parse(fs.readFileSync(new URL('./seed.json', import.meta.url)));
const DEVICE = process.argv[2] === 'desktop' ? DESKTOP : PHONE;
const L = process.argv[2] === 'desktop' ? 'desktop' : 'phone';
const tz = 'Pacific/Auckland';
const key = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (k, n) => new Date(Date.parse(`${k}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dow = (k) => new Date(`${k}T12:00:00Z`).getUTCDay();
const next = (d, from = key(Date.now()), skip = 1) => { let k = addDays(from, skip); while (dow(k) !== d) k = addDays(k, 1); return k; };
const SUN = next(0);
const FRI = next(5);
const THU = next(4);
const offsetWeeks = L === 'desktop' ? 1 : 0; // the desktop pass uses the next week's dates, so both passes start fresh
const ids = {
  store: `dnd-sunday-10am@${addDays(SUN, 7 * offsetWeeks)}`,
  eitherDay: `pokemon-tcg-league@${addDays(FRI, 14 * offsetWeeks)}`,
  eitherNow: `pokemon-tcg-league@${addDays(FRI, 7 + 14 * offsetWeeks)}`,
  online: `riftbound-store-championship@${addDays(SUN, 7)}`,
  free: `learn-riftbound@${SUN}`,
  warhammer: `warhammer-wargames@${addDays(THU, 7 * offsetWeeks)}`,
};
await start();
const problems = [];
const out = { ids };
// a clean slate on these dates for Sam and Kiri (earlier runs joined some of them); staff cancel them (round 15: inside 24
// hours they couldn't themselves)
for (const who of ['7101', '7102']) {
  const me = await proxy('GET', 'me', { customer: who });
  const targets = new Set(Object.values(ids));
  for (const j of me.data.joins || []) if (targets.has(j.occurrenceId) && j.status !== 'cancelled') await proxy('POST', `events/joins/${j.id}/cancel`, { customer: '7001', body: {} });
  for (const b of me.data.bookings || []) if (targets.has(b.occurrenceId) && b.status !== 'cancelled') await proxy('POST', `bookings/${b.id}/update`, { customer: '7001', body: { status: 'cancelled' } });
}

async function openEvent(p, id) {
  // a fresh load each time (a hash-only change wouldn't reload the page)
  if (p.url().startsWith(`${BASE}/pages/events-calendar`)) await p.goto('about:blank');
  await p.goto(`${BASE}/pages/events-calendar#event=${encodeURIComponent(id)}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
}
async function lastCall(before, re) {
  return apiLog.slice(before).filter((c) => c.method === 'POST' && re.test(c.route)).pop();
}
async function join(p, id, { people = 1 } = {}) {
  await openEvent(p, id);
  await p.click(`[data-join="${id}"]`);
  await p.waitForSelector('[data-join-form]');
  // round 8: "Who's coming?" adds each person after you (by name here); round 7's form had How many? chips
  if (people > 1 && await p.$('[data-join-form] [data-guest-add]')) {
    for (let i = 1; i < people; i += 1) {
      await p.click('[data-join-form] [data-guest-add]');
      await p.locator('[data-join-form] [data-guest] [name="guestName"]').last().fill(`Friend ${i}`);
    }
  } else if (people > 1) await p.check(`[data-join-form] input[name="people"][value="${people}"]`, { force: true });
  // round 7: a mobile is required; round 6's calendar form has no field for one (so its joins fail until round 7's theme)
  const mobile = p.locator('[data-join-form] input[type="tel"], [data-join-form] input[name="phone"]');
  if (await mobile.count() && !(await mobile.first().inputValue())) await mobile.first().fill('021 555 0101');
  // round 15: what the form says about paying, before it's sent
  const form = await text(p, '[data-join-form]');
  const payChoice = await p.locator('[data-join-form] input[name="pay"]').count();
  const before = apiLog.length;
  await p.click('button[form="cal-join-form"]');
  await p.waitForTimeout(1500);
  const call = await lastCall(before, /^events\/.+\/join/);
  return call ? Object.assign(call, { form, payChoice }) : { form, payChoice, status: 0, text: '{}', body: '{}' };
}
/** The TAB words on the page (window.Lair.TAB), for a reply's cancelUntil */
const words = (p, x) => p.evaluate((x) => ({
  onTab: window.Lair.TAB.onTab, nothing: window.Lair.TAB.nothingToPay, ahead: window.Lair.TAB.ahead(),
  cancelBy: x && x.cancelUntil ? window.Lair.TAB.cancelBy(x.cancelUntil) : '', lockedNow: window.Lair.TAB.lockedNow(),
}), x || null);
/** No code to show: not the reply's ref, and no QR (round 15) */
const noCode = async (p, ref) => !(await text(p, '.cal-done')).includes(ref || '?') && !(await p.locator('.cal-done [aria-label^="QR"], .cal-done [data-ticket-code], .cal-done .qr').count());
const draftsMade = async () => ((await fake('GET', 'calls')) || []).filter((c) => c.op === 'Draft').length;

const sam = await context(7101, DEVICE);
const p = await page(sam, `${L}/sam`);

/* 1. In store */
const drafts0 = await draftsMade();
const c1 = await join(p, ids.store);
const r1 = JSON.parse(c1.text || '{}');
check(`${L}: In store join is confirmed straight away, no checkout`, c1?.status === 200 && r1.join?.status === 'confirmed' && !r1.checkoutUrl && r1.join.payment === 'store' && r1.join.pay === 'day', c1 ? c1.text.slice(0, 200) : 'no call');
const w1 = await words(p, r1.join);
check(`${L}: the form says it goes on the tab, cancel up to 24 hours before (TAB.ahead), with no pay choice`, c1.form.includes(w1.ahead) && c1.payChoice === 0 && !/pay (it )?online|pay now/i.test(c1.form), c1.form.slice(0, 400));
check(`${L}: the app says until when it can be cancelled online, not locked`, r1.join?.cancelUntil === r1.join?.start - 24 * 3600000 && r1.join?.locked === false, r1.join && { cancelUntil: r1.join.cancelUntil, start: r1.join.start, locked: r1.join.locked });
const t1 = await text(p, '.cal-done');
check(`${L}: the confirmation: $15 on your tab, TAB.onTab, and until when to cancel in My Lair`, /Entry fee\s*\$15 on your tab/.test(t1) && t1.includes(w1.onTab) && t1.includes(w1.cancelBy), t1.slice(0, 400));
check(`${L}: no code or QR on it, and See your tab in My Lair`, await noCode(p, r1.join?.ref) && (await p.locator('.cal-done a', { hasText: 'See your tab in My Lair' }).count()) === 1, t1.slice(0, 200));
check(`${L}: no sideways scroll`, (await overflow(p)) <= 0, await overflow(p));
await shot(p, `event-join-ticket-${L}`);
out.storeJoin = r1.join;

/* 2. Online or in store: on the tab now, with no pay choice */
const c2 = await join(p, ids.eitherDay);
const r2 = JSON.parse(c2.text || '{}');
const sent2 = JSON.parse(c2.body || '{}');
check(`${L}: "Online or in store": no pay choice on the form, never "now"; confirmed on the tab`, c2.payChoice === 0 && sent2.pay !== 'now' && c2?.status === 200 && r2.join?.status === 'confirmed' && r2.join.payment === 'store' && !r2.checkoutUrl, c2 ? `${c2.body} → ${c2.text.slice(0, 160)}` : 'no call');
// an older page (cached before round 15) that still sends pay 'now': on the tab all the same, nothing held
const old = await proxy('POST', `events/${encodeURIComponent(ids.eitherNow)}/join`, { customer: '7101', body: { name: 'Sam Jones', email: 'sam@example.com', phone: '021 555 0101', people: 1, pay: 'now' } });
check(`${L}: an older page sending pay 'now': confirmed on the tab, no checkoutUrl, nothing held`, old.status === 200 && old.data.join?.status === 'confirmed' && old.data.join.pay === 'day' && old.data.join.payment === 'store' && !old.data.checkoutUrl && !old.data.holdMinutes, old.data.error || old.data);
const meNow = (await proxy('GET', 'me', { customer: '7101' })).data.joins.find((j) => j.id === old.data.join?.id);
check(`${L}: GET /me: no checkoutUrl or holdUntil on it`, meNow && !meNow.checkoutUrl && !meNow.holdUntil && meNow.status === 'confirmed', meNow);
out.eitherNow = old.data.join;

/* 3. Online only: on the tab too; cancelled online well before (no refund, nothing paid) */
const c4 = await join(p, ids.online);
const r4 = JSON.parse(c4.text || '{}');
const sent4 = JSON.parse(c4.body || '{}');
check(`${L}: "Online" join: never "now" any more, confirmed on the tab, no checkoutUrl`, sent4.pay !== 'now' && c4?.status === 200 && r4.join?.status === 'confirmed' && r4.join.payment === 'store' && !r4.checkoutUrl, c4 ? `${c4.body} → ${c4.text.slice(0, 200)}` : 'no call');
const t4 = await text(p, '.cal-done');
const w4 = await words(p, r4.join);
check(`${L}: its confirmation: $25 on your tab, TAB.onTab, the cancel-by line, no code`, /\$25 on your tab/.test(t4) && t4.includes(w4.onTab) && t4.includes(w4.cancelBy) && await noCode(p, r4.join?.ref), t4.slice(0, 400));
out.online = r4.join;
check(`${L}: no checkout (draft order) was made for any of these sign-ups`, (await draftsMade()) === drafts0, { before: drafts0, after: await draftsMade() });
if (r4.join) {
  await openEvent(p, ids.online);
  const mine = await text(p, '.cal-you');
  check(`${L}: the event shows it on their tab, Cancel my spot with until when`, /on your tab/i.test(mine) && !/Paid online|Waiting for payment|Locked in/.test(mine) && Boolean(await p.$(`[data-cancel-mine="${ids.online}"]`)), mine.slice(0, 240));
  await p.click(`[data-cancel-mine="${ids.online}"]`);
  await p.waitForSelector('[data-cancel-do]');
  const warn = await text(p, '.cal-confirm');
  check(`${L}: cancelling says nothing about paying online`, !/paid online|refund/i.test(warn), warn.slice(0, 200));
  const before = apiLog.length;
  await p.click(`[data-cancel-do="${ids.online}"]`);
  await p.waitForTimeout(1200);
  const cc = await lastCall(before, /^events\/joins\/.+\/cancel/);
  const rc = cc ? JSON.parse(cc.text) : {};
  check(`${L}: cancel: cancelled, no refund (nothing was paid)`, cc?.status === 200 && rc.join?.status === 'cancelled' && !rc.join.refund, cc ? cc.text.slice(0, 260) : 'no call');
  check(`${L}: the calendar thanks them`, /Your spot is cancelled\. Thanks for letting us know, friend\./.test(await text(p, 'body')));
}

/* 4. Free event */
const c5 = await join(p, ids.free, { people: 2 });
const r5 = JSON.parse(c5.text || '{}');
check(`${L}: free event: confirmed, no payment of any kind`, c5?.status === 200 && r5.join?.status === 'confirmed' && r5.join.amount === 0 && !r5.checkoutUrl && JSON.parse(c5.body || '{}').pay !== 'now', c5 ? `${c5.body} → ${c5.text.slice(0, 160)}` : 'no call');
const t5 = await text(p, '.cal-done');
const w5 = await words(p, r5.join);
check(`${L}: the free confirmation: nothing to pay (TAB.nothingToPay), cancel any time before so someone else can come, no $ and no code`, t5.includes(w5.nothing) && /Can’t make it\? Cancel in My Lair, so someone else can have your spot\./.test(t5) && !/\$/.test(t5) && await noCode(p, r5.join?.ref) && r5.join?.locked === false, t5.slice(0, 300));
out.free = r5.join;

/* 5. Warhammer: reserve a game table with the pass */
await openEvent(p, ids.warhammer);
await p.click(`[data-reserve="${ids.warhammer}"]`);
await p.waitForSelector('[data-reserve-form]');
const passOpt = await p.$(`[data-reserve-form] input[name="pay"][value="pass:${seed.samPass.code}"]`);
check(`${L}: Warhammer offers "Use my pass" (paid at the counter)`, Boolean(passOpt) && !(await p.$('[data-reserve-form] input[name="pay"][value="now"]')));
if (passOpt) await p.check(`[data-reserve-form] input[name="pay"][value="pass:${seed.samPass.code}"]`, { force: true });
// round 7: a mobile, when the form has a field for one (round 6's calendar doesn't)
const spotMobile = p.locator('[data-reserve-form] input[type="tel"], [data-reserve-form] input[name="phone"]');
if (await spotMobile.count() && !(await spotMobile.first().inputValue())) await spotMobile.first().fill('021 555 0101');
// round 11: the form names the other player (1 v 1 is picked to start with): a member code or an email
const opponent = p.locator('[data-reserve-form] [data-player] input');
if (await opponent.count()) await opponent.first().fill(`opponent.${L}@example.com`);
const bw = apiLog.length;
await p.click('button[form="cal-reserve-form"]');
await p.waitForTimeout(1500);
const cw = await lastCall(bw, /^events\/.+\/reserve/);
const rw = cw ? JSON.parse(cw.text) : {};
const sw = cw ? JSON.parse(cw.body) : {};
check(`${L}: reserve sends usePass and pay day`, sw.usePass === seed.samPass.code && sw.pay === 'day', sw);
// round 11: and the pair picked (the first free one) and the opponent; the booking lists them
check(`${L}: reserve sends the pair and the opponent (round 11)`, !(await opponent.count()) || (/^T\d+\+T\d+$/.test(sw.spot || '') && sw.people === 2 && sw.players?.[0]?.email === `opponent.${L}@example.com` && rw.booking?.gamePlayers?.[0]?.email === `opponent.${L}@example.com`), { sent: sw, players: rw.booking?.gamePlayers });
check(`${L}: the app booked a game spot with the pass, $10 a player`, cw?.status === 200 && rw.booking?.tables?.length === 2 && rw.booking.amount === 2000 && rw.booking.pass?.code === seed.samPass.code && rw.booking.payment === 'store' && rw.booking.occurrenceId === ids.warhammer, cw ? cw.text.slice(0, 300) : 'no call');
const tw = await text(p, '.cal-done');
check(`${L}: the confirmation shows the tables and the pass, and no code`, rw.booking && tw.includes(rw.booking.tables.join(' + ')) && /pass/i.test(tw) && await noCode(p, rw.booking.ref), tw.slice(0, 300));
await shot(p, `event-reserve-ticket-${L}`);
out.warhammer = rw.booking;
// tidy up (Sam's 6-booking limit): staff cancel the table (round 15: inside 24 hours he couldn't himself)
if (rw.booking) await proxy('POST', `bookings/${rw.booking.id}/update`, { customer: '7001', body: { status: 'cancelled' } });
problems.push(...p.problems);
await sam.close();

/* 6. Shopify's checkout down: signing up doesn't need it any more (Kiri) */
await fake('POST', 'set', { failCheckout: true });
const kiri = await context(7102, DEVICE);
const k = await page(kiri, `${L}/kiri`);
const c6 = await join(k, ids.online);
const r6 = JSON.parse(c6.text || '{}');
check(`${L}: "Online" with checkout down: confirmed on the tab (no 503 any more)`, c6?.status === 200 && r6.join?.status === 'confirmed' && r6.join.payment === 'store' && !r6.notice, c6 ? `${c6.status} ${c6.text.slice(0, 200)}` : 'no call');
check(`${L}: …and no error on the form`, !(await k.locator('.cal-error').count()));
await shot(k, `event-checkout-down-${L}`);
const c7 = await join(k, ids.eitherDay);
const r7 = JSON.parse(c7.text || '{}');
check(`${L}: "Online or in store" with checkout down: confirmed on the tab, no notice`, c7?.status === 200 && r7.join?.status === 'confirmed' && r7.join.payment === 'store' && !r7.notice, c7 ? c7.text.slice(0, 260) : 'no call');
await fake('POST', 'set', { failCheckout: false });
problems.push(...k.problems);
await kiri.close();
const after = await proxy('GET', 'floor', { customer: '7001' });
check(`${L}: Kiri's sign-ups are confirmed on the floor, nothing held`, ['online', 'eitherDay'].every((n) => after.data.joins.some((j) => j.occurrenceId === ids[n] && j.name === 'Kiri Smith' && j.status === 'confirmed')) && !after.data.joins.some((j) => j.status === 'held'));
// tidy up: staff cancel Kiri's (later flows count the places)
for (const j of after.data.joins.filter((x) => [ids.online, ids.eitherDay].includes(x.occurrenceId) && x.name === 'Kiri Smith' && x.status !== 'cancelled')) {
  await proxy('POST', `events/joins/${j.id}/cancel`, { customer: '7001', body: {} });
}

check(`${L}: no script errors, console errors or failed requests`, problems.filter((x) => !/503/.test(x)).length === 0, problems.slice(0, 6).join(' | '));
fs.writeFileSync(new URL(`./events-${L}.json`, import.meta.url), JSON.stringify(out, null, 2));
await stop();
process.exit(summary() ? 1 : 0);

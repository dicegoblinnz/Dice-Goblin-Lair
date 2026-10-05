// Events calendar, live, phone first: join an "In store" event, an "Online or in store" event both ways, an "Online"
// event (held, with a checkoutUrl), a free event; the 503 when checkout can't be made; reserve a Warhammer game
// table; pay the online join (draft order + webhook) and cancel it (locked in: refund 'ask').
import fs from 'node:fs';
import { start, stop, context, page, overflow, shot, text, apiLog, PHONE, DESKTOP, BASE } from './harness.mjs';
import { check, summary, fake, webhook, proxy } from './client.mjs';

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
// a clean slate on these dates for Sam and Kiri (earlier runs joined some of them)
for (const who of ['7101', '7102']) {
  const me = await proxy('GET', 'me', { customer: who });
  const targets = new Set(Object.values(ids));
  for (const j of me.data.joins || []) if (targets.has(j.occurrenceId) && j.status !== 'cancelled') await proxy('POST', `events/joins/${j.id}/cancel`, { customer: who, body: {} });
  for (const b of me.data.bookings || []) if (targets.has(b.occurrenceId) && b.status !== 'cancelled') await proxy('POST', `bookings/${b.id}/update`, { customer: who, body: { status: 'cancelled' } });
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
async function join(p, id, { pay = null, people = 1 } = {}) {
  await openEvent(p, id);
  await p.click(`[data-join="${id}"]`);
  await p.waitForSelector('[data-join-form]');
  if (people > 1) await p.check(`[data-join-form] input[name="people"][value="${people}"]`, { force: true });
  if (pay) await p.check(`[data-join-form] input[name="pay"][value="${pay}"]`, { force: true });
  await p.fill('[data-join-form] [name="phone"]', '021 555 0188'); // round 7: a mobile is required
  const before = apiLog.length;
  await p.click('button[form="cal-join-form"]');
  await p.waitForTimeout(1500);
  return lastCall(before, /^events\/.+\/join/);
}

const sam = await context(7101, DEVICE);
const p = await page(sam, `${L}/sam`);

/* 1. In store */
const c1 = await join(p, ids.store);
const r1 = c1 ? JSON.parse(c1.text) : {};
check(`${L}: In store join is confirmed straight away, no checkout`, c1?.status === 200 && r1.join?.status === 'confirmed' && !r1.checkoutUrl && r1.join.payment === 'store', c1 ? c1.text.slice(0, 200) : 'no call');
const t1 = await text(p, '.cal-done');
check(`${L}: the ticket says pay at the counter, with the code`, t1.includes(r1.join?.ref || '?') && /Pay at the counter when you arrive/.test(t1) && /\$15/.test(t1), t1.slice(0, 300));
check(`${L}: the ticket has the QR`, await p.evaluate(() => Boolean(document.querySelector('.cal-done svg'))));
check(`${L}: no sideways scroll`, (await overflow(p)) <= 0, await overflow(p));
await shot(p, `event-join-ticket-${L}`);
out.storeJoin = r1.join;

/* 2a. Online or in store, at the counter */
const c2 = await join(p, ids.eitherDay, { pay: 'day' });
const r2 = c2 ? JSON.parse(c2.text) : {};
check(`${L}: "Online or in store" at the counter: confirmed, pay at the counter`, c2?.status === 200 && JSON.parse(c2.body).pay === 'day' && r2.join?.status === 'confirmed' && r2.join.payment === 'store' && !r2.checkoutUrl, c2 ? `${c2.body} → ${c2.text.slice(0, 160)}` : 'no call');
/* 2b. Online or in store, online: held, checkoutUrl, off to checkout */
const c3 = await join(p, ids.eitherNow, { pay: 'now' });
const r3 = c3 ? JSON.parse(c3.text) : {};
check(`${L}: "Online or in store" paying online: held with a checkoutUrl`, c3?.status === 200 && r3.join?.status === 'held' && /\/__checkout\/\d+$/.test(r3.checkoutUrl || '') && r3.holdMinutes === 30 && r3.join.payment === 'online', c3 ? c3.text.slice(0, 220) : 'no call');
check(`${L}: the browser went to the checkout`, /\/__checkout\/\d+$/.test(p.url()), p.url());
out.eitherNow = { ...r3.join, checkoutUrl: r3.checkoutUrl };
// back to the calendar without paying: the held place offers the payment link
await openEvent(p, ids.eitherNow);
const heldPanel = await text(p, '.cal-you');
const payLink = await p.getAttribute('.cal-you__pay', 'href').catch(() => null);
check(`${L}: back without paying: "Waiting for payment" and a link to pay`, /Waiting for payment/.test(heldPanel) && payLink === r3.checkoutUrl, { heldPanel: heldPanel.slice(0, 160), payLink });
await shot(p, `event-held-${L}`);
// another device (nothing saved in this browser): the link comes from GET /me
const other = await context(7101, DEVICE);
const po = await page(other, `${L}/sam-other-device`);
await openEvent(po, ids.eitherNow);
const otherPanel = await text(po, '.cal-you');
const otherLink = await po.getAttribute('.cal-you__pay', 'href').catch(() => null);
const meNow = (await proxy('GET', 'me', { customer: '7101' })).data.joins.find((j) => j.id === r3.join?.id);
check(`${L}: GET /me has the held sign-up's checkoutUrl and holdUntil`, meNow && meNow.checkoutUrl === r3.checkoutUrl && meNow.holdUntil > Date.now(), meNow && { checkoutUrl: meNow.checkoutUrl, holdUntil: meNow.holdUntil });
check(`${L}: on another device the held place still offers the payment link, with its time`, otherLink === r3.checkoutUrl && /until \d{1,2}(:\d{2})?[ap]m/.test(otherPanel) && !/Lost the payment page/.test(otherPanel), { otherLink, otherPanel: otherPanel.slice(0, 200) });
problems.push(...po.problems);
await other.close();

/* 3. Online only: held, checkoutUrl; then paid through the draft order */
const c4 = await join(p, ids.online);
const r4 = c4 ? JSON.parse(c4.text) : {};
const sent4 = c4 ? JSON.parse(c4.body) : {};
check(`${L}: "Online" join: pay now is sent, it's held with a checkoutUrl`, c4?.status === 200 && sent4.pay === 'now' && r4.join?.status === 'held' && Boolean(r4.checkoutUrl), c4 ? `${c4.body} → ${c4.text.slice(0, 200)}` : 'no call');
out.online = { ...r4.join, checkoutUrl: r4.checkoutUrl };
if (r4.checkoutUrl) {
  const draftId = `gid://shopify/DraftOrder/${r4.checkoutUrl.split('/').pop()}`;
  const orderNo = 7000 + Number(r4.checkoutUrl.split('/').pop()) % 1000;
  await fake('POST', 'draft-paid', { draftId, orderId: `gid://shopify/Order/${orderNo}` });
  await fake('POST', 'order', { id: orderNo, customerId: '7101', subtotal: 2500, source: 'shopify_draft_order' });
  const hook = await webhook({ id: orderNo, source_name: 'shopify_draft_order', note_attributes: [{ name: '_booking', value: r4.join.ref }],
    line_items: [{ id: orderNo * 10, title: 'Event entry: Riftbound store championship', price: '25.00', quantity: 1, properties: [{ name: '_booking', value: r4.join.ref }] }] });
  check(`${L}: the paid checkout's webhook confirms the join`, hook.status === 200 && hook.data.updated?.[0] === r4.join.ref, hook.data);
  await openEvent(p, ids.online);
  const paidPanel = await text(p, '.cal-you');
  check(`${L}: the event shows it paid online and locked in`, /Paid online/.test(paidPanel) && /Locked in/.test(paidPanel), paidPanel.slice(0, 200));
  // cancel it: locked in, so the refund is a chat
  await p.click(`[data-cancel-mine="${ids.online}"]`);
  await p.waitForSelector('[data-cancel-do]');
  const warn = await text(p, '.cal-confirm');
  check(`${L}: cancelling warns it was paid online`, /You paid online, so you’re locked in/.test(warn), warn.slice(0, 200));
  const before = apiLog.length;
  await p.click(`[data-cancel-do="${ids.online}"]`);
  await p.waitForTimeout(1200);
  const cc = await lastCall(before, /^events\/joins\/.+\/cancel/);
  const rc = cc ? JSON.parse(cc.text) : {};
  check(`${L}: cancel: locked in, refund 'ask', the contract's notice`, cc?.status === 200 && rc.join?.refund === 'ask' && rc.notice === 'Your spot is cancelled. You paid online, so have a chat with us about a refund.', cc ? cc.text.slice(0, 260) : 'no call');
  const flash = await text(p, '[data-dialog]').catch(() => '');
  check(`${L}: the calendar shows the notice`, /have a chat with us about a refund/.test(flash) || /have a chat with us about a refund/.test(await text(p, 'body')), flash.slice(0, 200));
}

/* 4. Free event */
const c5 = await join(p, ids.free, { people: 2 });
const r5 = c5 ? JSON.parse(c5.text) : {};
check(`${L}: free event: confirmed, no payment of any kind`, c5?.status === 200 && r5.join?.status === 'confirmed' && r5.join.amount === 0 && !r5.checkoutUrl && !('pay' in JSON.parse(c5.body)), c5 ? `${c5.body} → ${c5.text.slice(0, 160)}` : 'no call');
const t5 = await text(p, '.cal-done');
check(`${L}: the free ticket says nothing about money`, !/\$|pay|counter/i.test(t5.replace(/Show this at the counter[^.]*\./, '').replace(/Plans changed\?.*$/, '')), t5.slice(0, 300));
out.free = r5.join;

/* 5. Warhammer: reserve a game table with the pass */
await openEvent(p, ids.warhammer);
await p.click(`[data-reserve="${ids.warhammer}"]`);
await p.waitForSelector('[data-reserve-form]');
const passOpt = await p.$(`[data-reserve-form] input[name="pay"][value="pass:${seed.samPass.code}"]`);
check(`${L}: Warhammer offers "Use my pass" (paid at the counter)`, Boolean(passOpt) && !(await p.$('[data-reserve-form] input[name="pay"][value="now"]')));
if (passOpt) await p.check(`[data-reserve-form] input[name="pay"][value="pass:${seed.samPass.code}"]`, { force: true });
await p.fill('[data-reserve-form] [name="phone"]', '021 555 0188'); // round 7: a mobile is required
const bw = apiLog.length;
await p.click('button[form="cal-reserve-form"]');
await p.waitForTimeout(1500);
const cw = await lastCall(bw, /^events\/.+\/reserve/);
const rw = cw ? JSON.parse(cw.text) : {};
const sw = cw ? JSON.parse(cw.body) : {};
check(`${L}: reserve sends usePass and pay day`, sw.usePass === seed.samPass.code && sw.pay === 'day', sw);
check(`${L}: the app booked a game spot with the pass, $10 a player`, cw?.status === 200 && rw.booking?.tables?.length === 2 && rw.booking.amount === 2000 && rw.booking.pass?.code === seed.samPass.code && rw.booking.payment === 'store' && rw.booking.occurrenceId === ids.warhammer, cw ? cw.text.slice(0, 300) : 'no call');
const tw = await text(p, '.cal-done');
check(`${L}: the ticket shows the tables and the pass`, rw.booking && tw.includes(rw.booking.ref) && tw.includes(rw.booking.tables.join(' + ')) && /pass/i.test(tw), tw.slice(0, 300));
await shot(p, `event-reserve-ticket-${L}`);
out.warhammer = rw.booking;
// tidy up (Sam's 6-booking limit): he cancels the table himself
if (rw.booking) await proxy('POST', `bookings/${rw.booking.id}/update`, { customer: '7101', body: { status: 'cancelled' } });
problems.push(...p.problems);
await sam.close();

/* 6. Checkout can't be made: Kiri */
await fake('POST', 'set', { failCheckout: true });
const kiri = await context(7102, DEVICE);
const k = await page(kiri, `${L}/kiri`);
const c6 = await join(k, ids.online);
check(`${L}: "Online" with checkout down: 503 and the contract's message`, c6?.status === 503 && JSON.parse(c6.text).error === "Online payment isn't working right now. Call us and we'll hold you a spot.", c6 ? `${c6.status} ${c6.text}` : 'no call');
const err = await text(k, '.cal-error');
check(`${L}: the form shows it, with a Call button`, /Online payment isn’t working|Online payment isn't working/.test(err) && Boolean(await k.$('.cal-error .cal-call')), err);
await shot(k, `event-503-${L}`);
const c7 = await join(k, ids.eitherDay, { pay: 'now' });
const r7 = c7 ? JSON.parse(c7.text) : {};
check(`${L}: "Online or in store" online with checkout down: confirmed at the counter, with a notice`, c7?.status === 200 && r7.join?.status === 'confirmed' && r7.join.payment === 'store' && /pay at the counter/i.test(r7.notice || ''), c7 ? c7.text.slice(0, 260) : 'no call');
await fake('POST', 'set', { failCheckout: false });
problems.push(...k.problems);
await kiri.close();
const after = await proxy('GET', 'floor', { customer: '7001' });
check(`${L}: no half-made online join left behind after the 503`, !after.data.joins.some((j) => j.occurrenceId === ids.online && j.name === 'Kiri Smith' && j.status !== 'cancelled'));

check(`${L}: no script errors, console errors or failed requests`, problems.filter((x) => !/503/.test(x)).length === 0, problems.slice(0, 6).join(' | '));
fs.writeFileSync(new URL(`./events-${L}.json`, import.meta.url), JSON.stringify(out, null, 2));
await stop();
process.exit(summary() ? 1 : 0);

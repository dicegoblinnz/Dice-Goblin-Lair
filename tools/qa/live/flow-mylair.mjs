// My Lair, live, phone first: the member code and its QR; the loyalty card (round 6: the spend dice's 410, and the rolls
// staff give pay their face in store credit through the page, then pending when Shopify can't); passes and claiming
// one; the tab (add, edit, clear, add again, in the cart after POST /pos/tab/:id/added, paid after a webhook with
// _tab); and bookings with refund labels and a split bill.
import fs from 'node:fs';
import { start, stop, context, page, overflow, shot, text, apiLog, PHONE, DESKTOP, BASE } from './harness.mjs';
import { check, summary, proxy, pos, webhook, fake } from './client.mjs';

const seed = JSON.parse(fs.readFileSync(new URL('./seed.json', import.meta.url)));
const T = JSON.parse(fs.readFileSync(new URL('./today.json', import.meta.url)));
const DEVICE = process.argv[2] === 'desktop' ? DESKTOP : PHONE;
const L = process.argv[2] === 'desktop' ? 'desktop' : 'phone';
const run = Date.now() % 100000;
await start();
const problems = [];

/** My Lair at one of its views: Home (the card and the dice), or #tab, #wallet, #bookings, #me. Everything is drawn into
    every view, so text can be read from any of them; a click needs its view showing. */
async function openLair(p, view = '') {
  if (p.url().includes('/pages/my-lair')) await p.goto('about:blank');
  await p.goto(`${BASE}/pages/my-lair${view ? `#${view}` : ''}`, { waitUntil: 'networkidle' });
  await p.waitForSelector('[data-card-qr] svg', { state: 'attached', timeout: 8000 }).catch(() => {});
}

/* setup: Sam spends $200 online (a signed orders/paid webhook), staff-side refund states for Kiri */
await fake('POST', 'set', { failCredit: false });
await fake('POST', 'order', { id: 80000 + run, customerId: '7101', subtotal: 20000, source: 'web' });
const spent = await webhook({ id: 80000 + run, source_name: 'web', line_items: [{ id: 1, title: 'Dice set', price: '200.00', quantity: 1, properties: [] }] });
check(`${L}: a web order's webhook counts Sam's spend`, spent.status === 200 && spent.data.spend === 20000, spent.data);

const sam = await context(7101, DEVICE);
const p = await page(sam, `${L}/sam`);
await openLair(p);
const me = (await proxy('GET', 'me', { customer: '7101' })).data;
/* 1. member code and QR */
const cardCode = await text(p, '[data-card-code]');
const qrLabel = await p.getAttribute('[data-card-qr] svg', 'aria-label').catch(() => '');
check(`${L}: the Goblin card shows the member code and its QR`, cardCode === me.member.code && String(qrLabel).includes(me.member.code), { cardCode, qrLabel, code: me.member.code });
check(`${L}: no sideways scroll`, (await overflow(p)) <= 0, await overflow(p));
await p.evaluate(() => document.querySelector('[data-card-qr]').scrollIntoView({ block: 'center' }));
await p.waitForTimeout(300);
await shot(p, `mylair-card-${L}`);
await p.evaluate(() => window.scrollTo(0, 0));

/* 2. the loyalty card (round 6): the spend dice have retired, so { kind: 'spend' } gets the 410 and the loyalty card's
   words. Staff give Sam two rolls; the page's "Roll your d20" sends { kind: 'loyalty' } and its face is his store
   credit (added); with Shopify down, the next one is pending and says to show the screen at the counter. Sam also has
   his welcome roll, so he has at least three. */
const retired = await proxy('POST', 'roll', { customer: '7101', body: { kind: 'spend' } });
check(`${L}: the spend dice have retired: { kind: 'spend' } gets the 410 and the loyalty card's words`, retired.status === 410 && retired.data.error === 'The spend dice have retired. Fill your loyalty card: 10 sessions earn a roll.', `${retired.status} ${JSON.stringify(retired.data).slice(0, 200)}`);
const given = await proxy('POST', 'members/7101/rolls', { customer: '7001', body: { count: 2, note: `QA ${L}` } });
check(`${L}: staff give Sam two loyalty rolls`, given.status === 200 && given.data.member?.loyalty?.rollsAvailable >= 2, given.data.error || given.data.member?.loyalty);
await openLair(p);
await p.waitForSelector('[data-roll-slots] [data-roll]', { timeout: 8000 }).catch(() => {});
const ready = await text(p, '[data-rolls-ready]');
check(`${L}: the loyalty card says how many rolls are ready`, Number((ready.match(/(\d+) rolls? ready/) || [])[1]) >= 2, ready.slice(0, 200));
const rollOnce = async () => {
  const b0 = apiLog.length;
  await p.click('[data-roll-slots] [data-roll]');
  await p.waitForFunction(() => !document.querySelector('my-lair').rolling, null, { timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(400);
  const call = apiLog.slice(b0).find((c) => c.method === 'POST' && c.route.startsWith('roll'));
  let data = null;
  try { data = call ? JSON.parse(call.text) : null; } catch { data = null; }
  return { call, data, sent: call ? JSON.parse(call.body || '{}') : null };
};
const credits0 = (await fake('GET', 'state')).credits.length;
const first = await rollOnce();
const won = first.data;
check(`${L}: Roll your d20 sends { kind: 'loyalty' }: its face in store credit, added`, first.sent?.kind === 'loyalty' && first.call.status === 200 && won?.prize?.status === 'added' && won.prize.kind === 'credit' && won.prize.amount === won.roll * 100, first.call ? `${first.call.status} ${first.call.text.slice(0, 200)}` : 'no call');
const shown = await text(p, '[data-roll-slots] [data-result]');
check(`${L}: the page shows the app's words and the credit`, Boolean(won) && shown.includes(won.message) && shown.includes(`$${won.roll}`), shown.slice(0, 200));
const credits1 = (await fake('GET', 'state')).credits;
check(`${L}: Shopify was asked to add that credit (storeCreditAccountCredit)`, won && credits1.length === credits0 + 1 && credits1.at(-1).customerId === '7101' && credits1.at(-1).amount === won.prize.amount, credits1.at(-1));
await fake('POST', 'set', { failCredit: true });
const second = await rollOnce();
await fake('POST', 'set', { failCredit: false });
const pending = second.data;
check(`${L}: Shopify down: the prize is saved as pending, "show this screen"`, pending && pending.prize?.status === 'pending' && /Show this screen at the counter to claim it\.$/.test(pending.message), second.call ? `${second.call.status} ${second.call.text.slice(0, 200)}` : 'no call');
const shown2 = await text(p, '[data-roll-slots] [data-result]');
check(`${L}: the page says to show this screen at the counter`, /Show this screen at the counter to claim it/.test(shown2), shown2.slice(0, 200));
await openLair(p, 'wallet');
const prizes = await text(p, '[data-prizes]');
check(`${L}: the Wallet lists the pending roll and the added one`, /Show this at the counter to claim it/.test(prizes) && /Added/.test(prizes), prizes.slice(0, 300));
await shot(p, `mylair-dice-pending-${L}`);
fs.writeFileSync(new URL(`./pending-prize-${L}.json`, import.meta.url), JSON.stringify(pending?.prize || null));

/* 3. passes: Sam's league pass (in the Wallet) */
const passes = await text(p, '[data-passes]');
check(`${L}: Sam's pass is listed with sessions left`, /Warhammer league/.test(passes) && /of 10 sessions left/.test(passes) && passes.includes(seed.samPass.code), passes.slice(0, 200));
await p.click('.ml-bar [data-view-link="wallet"]');
await p.waitForTimeout(300);
await shot(p, `mylair-passes-${L}`);

/* 4. the tab: add from the menu, edit, clear, add again (in the Tab view) */
await proxy('POST', 'tab/clear', { customer: '7101', body: {} });
await openLair(p, 'tab');
const firstGroup = await p.$('[data-menu-toggle]');
if (firstGroup && (await firstGroup.getAttribute('aria-expanded')) === 'false') await firstGroup.click();
const items = await p.$$eval('.ml-menu__item[data-variant]', (rows) => rows.filter((r) => r.offsetParent).slice(0, 2).map((r) => r.dataset.variant));
for (const id of items) await p.click(`.ml-menu__item[data-variant="${id}"] [data-step="1"]`);
await p.click(`.ml-menu__item[data-variant="${items[0]}"] [data-step="1"]`);
let b = apiLog.length;
await p.click('[data-tab-save]');
await p.waitForTimeout(800);
let call = apiLog.slice(b).find((c) => c.method === 'POST' && c.route === 'tab');
let tab = call ? JSON.parse(call.text).tab : null;
check(`${L}: "Add to my tab" saves today's tab (open, 2 lines, 3 things)`, call?.status === 200 && tab?.status === 'open' && tab.items.length === 2 && tab.items.reduce((s, x) => s + x.qty, 0) === 3, call ? `${call.body.slice(0, 200)} → ${call.text.slice(0, 120)}` : 'no call');
const sentItems = call ? JSON.parse(call.body).items : [];
check(`${L}: the lines carry numeric variant ids, titles and cents from the catalogue`, sentItems.every((x) => /^\d+$/.test(x.variantId) && Number.isInteger(x.price) && x.price > 0 && x.title), sentItems);
const card1 = await text(p, '[data-tab-card]');
check(`${L}: the tab card: open, show your code to pay, with the code`, /Open tab/.test(card1) && /Show your code at the counter to pay/.test(card1) && card1.includes(me.member.code), card1.slice(0, 200));
await shot(p, `mylair-tab-${L}`);
// edit: one less of the first thing
await p.click('[data-tab-edit]');
await p.click(`[data-qty-box="edit"][data-id="${items[0]}"] [data-step="-1"]`);
b = apiLog.length;
await p.click('[data-tab-edit-save]');
await p.waitForTimeout(800);
call = apiLog.slice(b).find((c) => c.method === 'POST' && c.route === 'tab');
tab = call ? JSON.parse(call.text).tab : null;
check(`${L}: editing the tab saves the new quantities`, call?.status === 200 && tab?.items.find((x) => x.variantId === items[0])?.qty === 1, call ? call.text.slice(0, 200) : 'no call');
// clear it
await p.click('[data-tab-clear]');
b = apiLog.length;
await p.click('[data-tab-clear-yes]');
await p.waitForTimeout(800);
call = apiLog.slice(b).find((c) => c.method === 'POST' && c.route === 'tab/clear');
const cleared = call ? JSON.parse(call.text).tab : undefined;
check(`${L}: clearing the tab deletes it (what's left is nothing, or today's earlier paid tab)`, call?.status === 200 && (cleared === null || cleared.status === 'paid') && cleared?.id !== tab.id, call ? call.text.slice(0, 160) : 'no call');
check(`${L}: My Lair says the tab was cleared`, /Tab cleared/.test(await text(p, '[data-tab-status]')));
// add again
await p.click(`.ml-menu__item[data-variant="${items[1]}"] [data-step="1"]`);
b = apiLog.length;
await p.click('[data-tab-save]');
await p.waitForTimeout(800);
call = apiLog.slice(b).find((c) => c.method === 'POST' && c.route === 'tab');
tab = call ? JSON.parse(call.text).tab : null;
check(`${L}: a fresh tab after clearing`, call?.status === 200 && tab?.status === 'open' && tab.items.length === 1, call ? call.text.slice(0, 160) : 'no call');
// the counter: the POS puts it in the cart
const added = await pos('POST', `tab/${tab.id}/added`, {});
check(`${L}: POST /pos/tab/:id/added marks it in the cart`, added.status === 200 && added.data.tab.status === 'in-cart');
await openLair(p, 'tab');
await p.waitForSelector('[data-tab-card]', { timeout: 5000 }).catch(() => {});
const card2 = await text(p, '[data-tab-card]');
check(`${L}: My Lair shows "At the counter now", and no adding`, /At the counter/.test(card2) && (await p.$eval('[data-tab-add]', (el) => el.hidden)), card2.slice(0, 200));
await shot(p, `mylair-tab-in-cart-${L}`);
// paid at the counter: a POS order with the tab's lines (_tab)
const order = 81000 + run;
await fake('POST', 'order', { id: order, customerId: '7101', subtotal: tab.total, source: 'pos' });
const paid = await webhook({ id: order, source_name: 'pos', line_items: tab.items.map((x, i) => ({ id: order * 10 + i, title: x.title, price: (x.price / 100).toFixed(2), quantity: x.qty, variant_id: Number(x.variantId), properties: [{ name: '_tab', value: tab.id }] })) });
check(`${L}: the webhook with _tab marks the tab paid`, paid.status === 200 && paid.data.tabs?.[0] === tab.id, paid.data);
await openLair(p, 'tab');
await p.waitForSelector('[data-tab-card]', { timeout: 5000 }).catch(() => {});
const card3 = await text(p, '[data-tab-card]');
// round 5, one bill: while today's sessions are still to pay, the card leads with them and says the tab's paid in a line
check(`${L}: My Lair shows the tab paid, and a fresh one can start`, /Paid\. Thanks, friend\.|Your tab's paid\. Thanks, friend\./.test(card3) && (await text(p, '[data-tab-add-title]')) === 'Start a fresh tab', card3.slice(0, 400));
await shot(p, `mylair-tab-paid-${L}`);

/* 5. Sam's bookings: the pass saved for check-in, what it covered */
const bookingsText = await text(p, '[data-panel="bookings"]');
check(`${L}: Sam's Fancy room booking shows the pass covered $40 and it's paid`, bookingsText.includes(T.A.ref) && /\$40/.test(bookingsText), bookingsText.slice(0, 400));
const joinsText = await text(p, '[data-panel="joins"]');
check(`${L}: the cancelled online-paid sign-up says "Have a chat with us about a refund"`, /Have a chat with us about a refund/.test(joinsText), joinsText.slice(0, 400));
problems.push(...p.problems);
await sam.close();

/* 6. Leo claims the unclaimed gift pack by its code; then nobody else can */
const leo = await context(7104, DEVICE);
const pl = await page(leo, `${L}/leo`);
await openLair(pl, 'wallet');
await pl.fill('#ml-claim-code', 'zz nope 9');
let cb = apiLog.length;
await pl.click('[data-claim] [type="submit"]');
await pl.waitForTimeout(800);
let cc = apiLog.slice(cb).find((c) => c.method === 'POST' && c.route === 'me/passes/claim');
check(`${L}: claiming an unknown code: 404 and the contract's words`, cc?.status === 404 && /No pass with that code\. Check it and try again, friend\./.test(await text(pl, '[data-claim-message]')), cc ? cc.text : 'no call');
await pl.fill('#ml-claim-code', seed.giftPass.code.toLowerCase().replace(/-/g, ' '));
cb = apiLog.length;
await pl.click('[data-claim] [type="submit"]');
await pl.waitForTimeout(800);
cc = apiLog.slice(cb).find((c) => c.method === 'POST' && c.route === 'me/passes/claim');
const claimMsg = await text(pl, '[data-claim-message]');
check(`${L}: Leo claims the gift pack (typed loosely): it's his`, cc?.status === 200 && JSON.parse(cc.text).pass?.code === seed.giftPass.code && /It's yours!/.test(claimMsg), cc ? `${cc.text.slice(0, 160)} | ${claimMsg}` : 'no call');
check(`${L}: his passes list shows it`, (await text(pl, '[data-passes]')).includes(seed.giftPass.code));
await shot(pl, `mylair-claim-${L}`);
problems.push(...pl.problems.filter((x) => !/404/.test(x)));
await leo.close();
const stolen = await proxy('POST', 'me/passes/claim', { customer: '7101', body: { code: seed.giftPass.code } });
check(`${L}: someone else claiming it: 409 and the contract's words`, stolen.status === 409 && stolen.data.error === 'That pass already belongs to someone. Ask us at the counter.', stolen.data);

/* 7. Kiri: the split bill, and the refund labels on her game spots */
const kiri = await context(7102, DEVICE);
const k = await page(kiri, `${L}/kiri`);
await openLair(k, 'bookings');
const kb = await text(k, '[data-panel="bookings"]');
check(`${L}: Kiri's booking: "Splitting the bill", paid $20 of $40, $20 left`, kb.includes(T.B.ref) && /Splitting the bill/.test(kb) && /Paid \$20 of \$40 · \$20 left/.test(kb), kb.slice(0, 500));
await k.evaluate((ref) => [...document.querySelectorAll('[data-panel="bookings"] .ml-ticket, [data-panel="bookings"] article')].find((x) => x.textContent.includes(ref))?.scrollIntoView({ block: 'center' }), T.B.ref);
await shot(k, `mylair-split-${L}`);
problems.push(...k.problems);
await kiri.close();

check(`${L}: no script errors, console errors or failed requests`, problems.length === 0, problems.slice(0, 6).join(' | '));
await stop();
process.exit(summary() ? 1 : 0);

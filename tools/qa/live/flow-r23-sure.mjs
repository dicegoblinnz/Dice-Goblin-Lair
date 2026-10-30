// Round 23, the sure $10, live: the theme in live mode against the real Lair app (wrangler dev) and the fake Admin API.
// Staff give Sam three rolls. GET /me's card comes with loyalty.sure, so My Lair offers Take $10 instead; it sends
// { kind: 'loyalty', pick: 'sure' }, the app adds exactly $10.00 (storeCreditAccountCredit) and the page shows the
// app's words with the $10 coin. Roll your d20 sends pick 'roll' and pays its face. With Shopify's credit off, the $10
// waits at the counter ("show this screen") and staff's email says what was picked. The Wallet lists it as played safe,
// and the staff list's prize says so too. A pick the app doesn't know is a 422 with nothing used.
// Usage: sh tools/qa/live/up.sh, then DG_THEME=/path/to/theme node tools/qa/live/flow-r23-sure.mjs [phone|desktop]
import { start, stop, context, page, overflow, shot, text, apiLog, PHONE, DESKTOP, BASE } from './harness.mjs';
import { check, summary, proxy, fake } from './client.mjs';

const DEVICE = process.argv[2] === 'desktop' ? DESKTOP : PHONE;
const L = process.argv[2] === 'desktop' ? 'desktop' : 'phone';
await start();

async function openLair(p, view = '') {
  if (p.url().includes('/pages/my-lair')) await p.goto('about:blank');
  await p.goto(`${BASE}/pages/my-lair${view ? `#${view}` : ''}`, { waitUntil: 'networkidle' });
  await p.waitForSelector('[data-stamp-count] strong', { state: 'attached', timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(300);
}
/** Tap a roll button and wait for the answer: the call the page made, what it sent and what came back */
async function tap(p, selector) {
  const b0 = apiLog.length;
  await p.click(`[data-roll-slots] ${selector}`);
  await p.waitForFunction(() => !document.querySelector('my-lair').rolling, null, { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(500);
  const call = apiLog.slice(b0).find((c) => c.method === 'POST' && c.route.startsWith('roll'));
  let data = null;
  try { data = call ? JSON.parse(call.text) : null; } catch { data = null; }
  return { call, data, sent: call ? JSON.parse(call.body || '{}') : null };
}
const coupon = (p) => p.evaluate(() => {
  const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const r = document.querySelector('[data-roll-slots] [data-result]');
  return r ? { coin: Boolean(r.querySelector('.ml-face--coin')), face: f(r.querySelector('.ml-face')?.textContent), kicker: f(r.querySelector('.ml-prize__kicker')?.textContent), all: f(r.textContent), look: [...r.classList].find((c) => c.startsWith('ml-prize--')) } : null;
});

await fake('POST', 'set', { failCredit: false });
const sam = await context(7101, DEVICE);
const p = await page(sam, `${L}/sam`);
await openLair(p);
const given = await proxy('POST', 'members/7101/rolls', { customer: '7001', body: { count: 3, note: `QA round 23 ${L}` } });
check(`${L}: staff give Sam three rolls`, given.status === 200 && given.data.member?.loyalty?.rollsAvailable >= 3, given.data.error || given.data.member?.loyalty);
const me = (await proxy('GET', 'me', { customer: '7101' })).data;
check(`${L}: the live app's card offers the sure $10 (loyalty.sure 1000)`, me.loyalty?.sure === 1000, me.loyalty);
await openLair(p);
const pickLine = await text(p, '.ml-roll__pick');
const sureLabel = await text(p, '[data-roll-slots] [data-roll-sure]');
check(`${L}: the page offers it: the pick line, and Take $10 instead under Roll your d20`, pickLine === 'Roll for $1 to $20, or play it safe with $10.' && sureLabel === 'Take $10 instead', { pickLine, sureLabel });

// the sure $10
const credits0 = (await fake('GET', 'state')).credits.length;
const ten = await tap(p, '[data-roll-sure]');
check(`${L}: Take $10 instead sends { kind: 'loyalty', pick: 'sure' }, and the app adds $10 with nothing rolled`,
  ten.sent?.kind === 'loyalty' && ten.sent?.pick === 'sure' && ten.call?.status === 200 && ten.data?.pick === 'sure' && ten.data?.roll === null
    && ten.data?.prize?.amount === 1000 && ten.data?.prize?.status === 'added' && ten.data?.message === 'You played it safe: $10 store credit is yours.', ten.call ? `${ten.call.status} ${ten.call.text.slice(0, 240)}` : 'no call');
const credits1 = (await fake('GET', 'state')).credits;
check(`${L}: Shopify was asked for exactly $10.00 of store credit for Sam`, credits1.length === credits0 + 1 && credits1.at(-1).customerId === '7101' && credits1.at(-1).amount === 1000, credits1.at(-1));
let c = await coupon(p);
check(`${L}: the coupon shows the app's words with the $10 coin`, c && c.coin && c.face === '$10' && c.kicker === 'You played it safe: $10 store credit is yours.' && c.look === 'ml-prize--credit', c);
await shot(p, `r23-sure-${L}`);

// the d20, as before
const rolled = await tap(p, '[data-roll]');
check(`${L}: Roll your d20 sends pick 'roll' and pays its face`, rolled.sent?.pick === 'roll' && rolled.call?.status === 200 && rolled.data?.pick === 'roll'
  && Number.isInteger(rolled.data?.roll) && rolled.data.prize?.amount === rolled.data.roll * 100, rolled.call ? `${rolled.call.status} ${rolled.call.text.slice(0, 200)}` : 'no call');
c = await coupon(p);
check(`${L}: its coupon has the d20's face, no coin`, c && !c.coin && c.face === String(rolled.data?.roll), c);

// Shopify can't add it: pending at the counter, and staff told what was picked
const mail0 = (await fake('GET', 'emails')).length;
await fake('POST', 'set', { failCredit: true });
const waiting = await tap(p, '[data-roll-sure]');
await fake('POST', 'set', { failCredit: false });
check(`${L}: with Shopify's credit off, the $10 waits at the counter`, waiting.data?.pick === 'sure' && waiting.data?.prize?.status === 'pending'
  && waiting.data?.message === 'You played it safe: $10 store credit is yours. Show this screen at the counter to claim it.', waiting.call ? `${waiting.call.status} ${waiting.call.text.slice(0, 200)}` : 'no call');
c = await coupon(p);
check(`${L}: the page says to show this screen at the counter, with when it was taken`, c && c.look === 'ml-prize--counter' && /Show this screen at the counter to claim it\. Taken at /.test(c.all), c);
let staffMail = null;
for (let i = 0; i < 20 && !staffMail; i += 1) {
  await p.waitForTimeout(300);
  staffMail = (await fake('GET', 'emails')).slice(mail0).find((m) => /Prize to give at the counter/.test(m.subject));
}
check(`${L}: staff's email says "Picked: Took $10 instead of rolling", not a roll`, staffMail && /Took \$10 instead of rolling/.test(staffMail.text) && !/Roll: /.test(staffMail.text), staffMail ? staffMail.text.slice(0, 400) : 'no email');

// the Wallet, and the staff list
await openLair(p, 'wallet');
const wallet = await text(p, '[data-prizes]');
check(`${L}: the Wallet lists the $10s as played safe`, (wallet.match(/Played it safe/g) || []).length >= 2 && /Show this at the counter to claim it/.test(wallet), wallet.slice(0, 400));
const listed = (await proxy('GET', 'members?q=7101', { customer: '7001' })).data;
const pend = (Array.isArray(listed) ? listed[0] : null)?.pendingPrizes || [];
check(`${L}: staff see the pending $10 as the sure pick`, pend.some((x) => x.pick === 'sure' && x.roll === null && x.amount === 1000 && x.status === 'pending'), pend);

// a pick the app doesn't know
const before = (await proxy('GET', 'me', { customer: '7101' })).data.loyalty.rolls.available;
const odd = await proxy('POST', 'roll', { customer: '7101', body: { kind: 'loyalty', pick: 'ten' } });
const after = (await proxy('GET', 'me', { customer: '7101' })).data.loyalty.rolls.available;
check(`${L}: a pick the app doesn't know is a 422, nothing used`, odd.status === 422 && odd.data.error === "That pick didn't come through properly. Try again." && after === before, `${odd.status} ${JSON.stringify(odd.data)} ${before}→${after}`);

check(`${L}: no sideways scroll`, (await overflow(p)) <= 0, await overflow(p));
check(`${L}: no script errors, console errors or failed requests`, !p.problems.length, p.problems.slice(0, 5));
await stop();
process.exit(summary() ? 1 : 0);

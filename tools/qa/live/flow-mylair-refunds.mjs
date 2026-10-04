// After the staff flow: Kiri's My Lair shows the refund labels staff set on her bookings (due → done, and ask).
import { start, stop, context, page, shot, text, PHONE, DESKTOP, BASE } from './harness.mjs';
import { check, summary, proxy } from './client.mjs';

const DEVICE = process.argv[2] === 'desktop' ? DESKTOP : PHONE;
const L = process.argv[2] === 'desktop' ? 'desktop' : 'phone';
const me = (await proxy('GET', 'me', { customer: '7102' })).data;
const done = me.bookings.find((b) => b.refund === 'done');
const ask = me.bookings.find((b) => b.refund === 'ask');
check(`${L}: Kiri has a refunded booking and one waiting on staff (from the staff flow)`, done && ask, me.bookings.map((b) => [b.ref, b.status, b.refund]));
await start();
const ctx = await context(7102, DEVICE);
const p = await page(ctx, `${L}/kiri-refunds`);
await p.goto(`${BASE}/pages/my-lair#bookings`, { waitUntil: 'networkidle' });
await p.waitForSelector('[data-panel="bookings"]:not([aria-busy])', { state: 'attached', timeout: 8000 }).catch(() => {});
const panel = await text(p, '[data-panel="bookings"]');
const rowOf = (ref) => p.evaluate((r) => [...document.querySelectorAll('[data-panel="bookings"] li, [data-panel="bookings"] article')].find((x) => x.textContent.includes(r) && x.textContent.length < 400)?.innerText.replace(/\s+/g, ' ') || '', ref);
check(`${L}: the refunded game spot says "Refunded"`, done && /Refunded/.test(panel), done && (await rowOf(done.ref)));
check(`${L}: the paid no-show says "Have a chat with us about a refund"`, ask && /Have a chat with us about a refund/.test(panel), ask && (await rowOf(ask.ref)));
await p.evaluate(() => document.querySelector('.ml-past')?.scrollIntoView({ block: 'center' }));
await shot(p, `mylair-refunds-${L}`);
check(`${L}: no script errors`, p.problems.length === 0, p.problems.join(' | '));
await stop();
process.exit(summary() ? 1 : 0);

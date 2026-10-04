// Every Lair page in live mode, for nobody, a member (Sam) and staff (Mo), on a phone and a desktop: no script or
// console errors, no failed requests, no sideways scroll. The home page's d20 rolls through the app ({ kind: 'fun' }).
import { start, stop, context, page, overflow, apiLog, PHONE, DESKTOP, BASE } from './harness.mjs';
import { check, summary } from './client.mjs';

const pages = ['/', '/pages/book-a-table', '/pages/events-calendar', '/pages/gm-games', '/pages/my-lair', '/pages/lair-staff'];
await start();
// A brand-new customer opens My Lair: the theme sends their account name with GET /me, so the code has their initials
{
  const ctx = await context(7105, PHONE);
  const p = await page(ctx, 'phone/new-member');
  await p.goto(`${BASE}/pages/my-lair`, { waitUntil: 'networkidle' });
  await p.waitForSelector('[data-card-qr] svg', { timeout: 8000 }).catch(() => {});
  const code = ((await p.textContent('[data-card-code]').catch(() => '')) || '').trim();
  const sent = apiLog.find((c) => c.who === 7105 && c.method === 'GET' && c.route.startsWith('me'));
  check('a new member\'s first My Lair visit: GET /me carries their name, the code is ZB-…', sent && /^me\?name=Zo%C3%AB%20van%20der%20Berg/.test(sent.route) && /^ZB-[A-Z]+-\d{1,2}$/.test(code), { route: sent?.route, code });
  await ctx.close();
}
for (const [device, label] of [[PHONE, 'phone'], [DESKTOP, 'desktop']]) {
  for (const who of [null, 7101, 7001]) {
    const ctx = await context(who, device);
    for (const path of pages) {
      const p = await page(ctx, `${label}/${who || 'anon'}${path}`);
      const res = await p.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      await p.waitForTimeout(700);
      const ov = await overflow(p);
      const fails = p.problems.filter((x) => !(who === null && path === '/pages/my-lair' && /401/.test(x)));
      check(`${label} ${who || 'anon'} ${path}: loads, no errors, no sideways scroll`, res.status() === 200 && ov <= 0 && fails.length === 0, { status: res.status(), overflow: ov, problems: fails.slice(0, 3) });
      if (path === '/' && who === 7101) {
        const before = apiLog.length;
        const die = await p.$('[data-die], [data-roll], .d20');
        if (die) {
          await die.click();
          await p.waitForTimeout(2500);
          const roll = apiLog.slice(before).find((c) => c.method === 'POST' && c.route === 'roll');
          const body = roll ? JSON.parse(roll.body || '{}') : {};
          const data = roll ? JSON.parse(roll.text) : {};
          check(`${label}: the home page d20 rolls through the app, just for fun`, roll?.status === 200 && (body.kind === 'fun' || !body.kind) && Object.keys(data).join() === 'roll', roll ? `${roll.body} → ${roll.text}` : 'no call');
        } else check(`${label}: the home page has a d20`, false);
      }
      await p.close();
    }
    await ctx.close();
  }
}
await stop();
process.exit(summary() ? 1 : 0);

// Round 13: the Our games page on the live stack (the theme on the mock renderer in live mode, the real Lair app under
// wrangler dev, fake Shopify), with the store's own events and GM games. A visitor on a phone (390) and a desktop (1280):
// a tile per game with its night, next dates, what's left and Follow; the TTRPG tile; Today at the Lair; every date link
// opening its sheet in the calendar; a session link opening its session; the Follow dialog's links; the calendar's
// "See all our games"; and each game's feed (GET /feeds/<key>.ics, public and through the signed proxy) agreeing with
// the page. Prints "ISSUE …" and "ok …" lines and saves screenshots to OUT.
//
// Usage (the live stack up with DG_SIM_EVENTS set, under the live lock):
//   DG_THEME=/path/to/theme DG_SIM_EVENTS=… DG_SIM_GAMES=… OUT=/dir QA_PORT=4998 node tools/qa/round13/our-games.mjs
import fs from 'node:fs';
import path from 'node:path';
import { start, stop, context, page, overflow, PHONE, DESKTOP, BASE } from '../live/harness.mjs';
import { proxyUrl, WORKER } from '../live/client.mjs';

const OUT = process.env.OUT || '/tmp/dg-r13';
fs.mkdirSync(OUT, { recursive: true });
const GAMES = process.env.DG_SIM_GAMES ? JSON.parse(fs.readFileSync(process.env.DG_SIM_GAMES, 'utf8')) : null;
let issues = 0;
const issue = (area, what, detail = '') => {
  issues += 1;
  console.log(`ISSUE ${area}: ${what}${detail !== '' ? ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const ok = (what) => console.log(`ok ${what}`);
/** The theme's and the Lair app's feed key */
const feedSlug = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
const standIn = () => '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#3a2f63"/></svg>';
async function ctxFor(device) {
  const ctx = await context(null, device);
  await ctx.route('https://cdn.shopify.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: standIn() }));
  return ctx;
}
const uidsOf = (ics) => [...ics.matchAll(/\r\nUID:([^\r]+)/g)].map((m) => m[1]);
const uidFor = (occurrenceId) => `${occurrenceId.replace(/[^A-Za-z0-9._-]+/g, '-')}@dicegoblin.nz`;

await start();
try {
  if (GAMES) {
    const loaded = await fetch(`${WORKER}/__dev/admin-job`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'r13', kind: 'games.add', payload: GAMES }) }).then((r) => r.json());
    if (loaded.failed?.length) issue('setup', 'games that would not load', loaded.failed);
    else ok(`${(loaded.added || loaded.result?.added || []).length || 'the'} GM games loaded`);
  }
  const floor = await fetch(proxyUrl(`floor?from=${Date.now() - 86400000}&to=${Date.now() + 61 * 86400000}`)).then((r) => r.json());
  const sessionIds = new Set((floor.games || []).map((g) => g.id));

  for (const [label, device] of [['phone', PHONE], ['desktop', DESKTOP]]) {
    const ctx = await ctxFor(device);
    const p = await page(ctx, `our-games ${label}`);
    await p.goto(`${BASE}/pages/our-games`, { waitUntil: 'networkidle', timeout: 90000 });
    await p.waitForTimeout(1500);
    const over = await overflow(p);
    if (over > 0) issue(label, 'the page scrolls sideways', `${over}px`);
    await p.screenshot({ path: path.join(OUT, `our-games-${label}.png`), fullPage: true });
    const tiles = await p.$$eval('[data-og-tile]', (els) => els.map((el) => ({
      name: el.dataset.ogName,
      night: el.querySelector('.og-card__night')?.textContent.trim() || '',
      week: el.querySelector('.og-week')?.getAttribute('aria-label') || '',
      chips: [...el.querySelectorAll('.og-chip')].map((c) => ({ text: c.textContent.trim(), href: c.getAttribute('href') })),
      left: el.querySelector('.og-card__left')?.textContent.trim() || '',
      actions: [...el.querySelectorAll('[data-og-actions] a, [data-og-actions] button')].map((b) => ({ text: b.textContent.trim(), href: b.getAttribute('href'), follow: b.dataset.ogFollow || null })),
      price: el.querySelector('.og-card__price')?.textContent.trim() || '',
      small: el.getBoundingClientRect().width,
    })));
    for (const tile of tiles) {
      console.log(`  ${label} | ${tile.name} | ${tile.night} | ${tile.chips.map((c) => c.text).join(', ')} | ${tile.left} | ${tile.actions.map((a) => a.text).join(' + ')}`);
      if (!tile.night) issue(label, `${tile.name}: no night`);
      if (!tile.chips.length) issue(label, `${tile.name}: no dates`);
      const follow = tile.actions.find((a) => a.follow);
      if (!follow) issue(label, `${tile.name}: no Follow`);
      else if (follow.follow !== feedSlug(tile.name)) issue(label, `${tile.name}: Follow's key`, follow.follow);
      for (const chip of tile.chips) {
        const id = decodeURIComponent(chip.href.split('#event=')[1] || '');
        if (!/^\/pages\/events-calendar#event=/.test(chip.href) || !id) issue(label, `${tile.name}: a date link that isn't the calendar's`, chip.href);
      }
    }
    if (tiles.length) ok(`${label}: ${tiles.length} game tiles`);
    const ttrpg = await p.$eval('[data-og-ttrpg]', (el) => ({
      week: el.querySelector('.og-week')?.getAttribute('aria-label') || '',
      text: el.querySelector('[data-og-sessions]')?.textContent.replace(/\s+/g, ' ').trim() || '',
      links: [...el.querySelectorAll('.og-session')].map((a) => a.getAttribute('href')),
      pics: el.querySelectorAll('.og-collage img').length,
    })).catch(() => null);
    if (!ttrpg) issue(label, 'no TTRPG tile');
    else {
      console.log(`  ${label} | TTRPG | ${ttrpg.week} | ${ttrpg.text} | ${ttrpg.pics} pictures`);
      if (sessionIds.size && !ttrpg.links.length) issue(label, 'the TTRPG tile lists no sessions with seats');
      for (const href of ttrpg.links) if (!sessionIds.has(decodeURIComponent(href.split('#game=')[1] || ''))) issue(label, 'a session link to no session', href);
    }
    const today = await p.$eval('[data-og-today]', (el) => (el.hidden ? '(hidden)' : el.textContent.replace(/\s+/g, ' ').trim())).catch(() => '(none)');
    console.log(`  ${label} | today: ${today}`);
    // Follow: its dialog and its four ways
    await p.click('[data-og-tile] [data-og-follow]');
    await p.waitForTimeout(400);
    const dialog = await p.$eval('[data-og-dialog]', (d) => ({ open: d.open, title: d.querySelector('[data-og-follow-title]').textContent, apps: [...d.querySelectorAll('[data-og-app]')].map((a) => a.getAttribute('href')), copy: d.querySelector('[data-og-copy]').dataset.url }));
    await p.screenshot({ path: path.join(OUT, `our-games-${label}-follow.png`) });
    if (!dialog.open) issue(label, 'Follow did not open its dialog');
    if (!/\/apps\/liar\/feeds\/[a-z0-9-]+\.ics$/.test(dialog.copy)) issue(label, 'the Follow link', dialog.copy);
    if (!dialog.apps[0].startsWith('webcal://') || !dialog.apps[1].startsWith('https://calendar.google.com/calendar/r?cid=webcal') || !dialog.apps[2].startsWith('https://outlook.live.com/calendar/0/addfromweb?url=')) issue(label, 'the Follow apps', dialog.apps);
    else ok(`${label}: Follow ${dialog.title.replace(/^Follow /, '')} offers Apple, Google, Outlook and the link`);
    await p.keyboard.press('Escape');
    // the harness' proxy passes the app's answer on, as Shopify's does: the page's own Follow link answers a calendar
    const viaPage = await p.evaluate(async (url) => {
      const r = await fetch(url);
      return { status: r.status, type: r.headers.get('content-type'), text: await r.text() };
    }, dialog.copy.replace(/^https?:\/\/[^/]+/, ''));
    if (viaPage.status !== 200 || !/^text\/calendar/.test(viaPage.type || '') || !viaPage.text.startsWith('BEGIN:VCALENDAR')) issue(label, 'the Follow link through the store did not answer a calendar', `${viaPage.status} ${viaPage.type}`);
    else ok(`${label}: the Follow link answers a calendar (${uidsOf(viaPage.text).length} dates)`);

    // every game's first date opens its sheet in the calendar
    if (label === 'desktop') {
      for (const tile of tiles) {
        const chip = tile.chips[0];
        if (!chip) continue;
        const q = await page(ctx, `calendar ${tile.name}`);
        await q.goto(`${BASE}${chip.href}`, { waitUntil: 'networkidle', timeout: 90000 });
        await q.waitForTimeout(1800);
        const sheet = await q.evaluate(() => {
          const d = [...document.querySelectorAll('dialog[open]')][0];
          return d ? (d.querySelector('h2, .h3')?.textContent || '').trim() : null;
        });
        if (!sheet) issue('calendar', `${tile.name}'s next date did not open a sheet`, chip.href);
        else ok(`${tile.name}: ${chip.text} opens "${sheet}" in the calendar`);
        if (tile.name === tiles[0].name) {
          const games = await q.$eval('.play__games-link', (a) => `${a.textContent.trim()} -> ${a.getAttribute('href')}`).catch(() => null);
          if (!games) issue('calendar', 'no See all our games link');
          else ok(`calendar: ${games}`);
          await q.screenshot({ path: path.join(OUT, 'calendar-with-link.png') });
        }
        if (q.problems.length) issue('calendar', 'errors on the page', q.problems.slice(0, 3).join(' || '));
        await q.close();
      }
      if (ttrpg && ttrpg.links[0]) {
        const q = await page(ctx, 'session');
        await q.goto(`${BASE}${ttrpg.links[0]}`, { waitUntil: 'networkidle', timeout: 90000 });
        await q.waitForTimeout(1800);
        const sheet = await q.evaluate(() => {
          const d = [...document.querySelectorAll('dialog[open]')][0];
          return d ? (d.querySelector('h2, .h3')?.textContent || '').trim() : null;
        });
        if (!sheet) issue('sessions', 'the first session link did not open its session', ttrpg.links[0]);
        else ok(`TTRPG: the first session link opens "${sheet}"`);
        await q.close();
      }
    }
    if (p.problems.length) issue(label, 'errors on the page', p.problems.slice(0, 5).join(' || '));
    await ctx.close();

    // each game's feed, public and through the signed proxy, has the dates the page links to
    if (label === 'phone') {
      for (const tile of tiles) {
        const key = feedSlug(tile.name);
        const pub = await fetch(`${WORKER}/feeds/${key}.ics`);
        const text = await pub.text();
        const signed = await fetch(proxyUrl(`feeds/${key}.ics`));
        if (pub.status !== 200 || signed.status !== 200) issue('feeds', `${key}: ${pub.status} / ${signed.status} through the proxy`);
        if (!/^text\/calendar/.test(pub.headers.get('content-type') || '')) issue('feeds', `${key}: not a calendar`, pub.headers.get('content-type'));
        const uids = uidsOf(text);
        const missing = tile.chips.map((c) => decodeURIComponent(c.href.split('#event=')[1])).filter((id) => !uids.includes(uidFor(id)));
        if (missing.length) issue('feeds', `${key}: dates on the page that aren't in the feed`, missing);
        else ok(`feed ${key}: ${uids.length} dates, ${(text.match(/X-WR-CALNAME:([^\r]+)/) || [])[1]}`);
      }
      const all = await fetch(`${WORKER}/feeds/kind-tcg.ics`);
      if (all.status !== 200) issue('feeds', `kind-tcg: ${all.status}`);
      else ok(`feed kind-tcg: ${uidsOf(await all.text()).length} card nights`);
      const nope = await fetch(`${WORKER}/feeds/not-a-game.ics`);
      if (nope.status !== 404) issue('feeds', `an unknown game: ${nope.status}`);
    }
  }
} finally {
  await stop();
}
console.log(`\n${issues} issue(s); screenshots in ${OUT}`);

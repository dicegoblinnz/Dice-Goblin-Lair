// A real-data simulation of the website: the store's own events and GM games on a local copy (the theme on the mock
// renderer in live mode, the real Lair app under wrangler dev, fake Shopify), walked through as a visitor, a member and
// staff on a phone (390) and a desktop (1280), with backend changes in the middle (a picture taken away, a session
// cancelled, an event removed in Shopify) to see that nothing on the pages breaks. Prints "ISSUE area: what | detail"
// lines and "ok" lines, saves a screenshot of every page and sheet to OUT, and writes OUT/findings.json.
//
// Data (kept out of this public repo; both are the store's own, exported from Shopify and the admin job):
//   DG_SIM_EVENTS  a JSON list of lair_event entries in events-mock.mjs' QA_EVENTS shape (read by the mock and the fake)
//   DG_SIM_GAMES   the games.add payload { games: [spec] } (src/admin.js), pictures as https://cdn.shopify.com/ URLs
// Pictures on cdn.shopify.com can't load here, so the browser gets a labelled 16:9 stand-in for each (its file name).
//
// Usage (the live stack must be up with DG_SIM_EVENTS set, under the live lock):
//   DG_THEME=/path/to/theme DG_SIM_EVENTS=… DG_SIM_GAMES=… OUT=/dir QA_PORT=4997 node tools/qa/sim/sim.mjs
import fs from 'node:fs';
import path from 'node:path';
import { start, stop, context, page, overflow, PHONE, DESKTOP, BASE } from '../live/harness.mjs';
import { proxy, WORKER } from '../live/client.mjs';

const OUT = process.env.OUT || '/tmp/dg-sim';
fs.mkdirSync(OUT, { recursive: true });
const GAMES = JSON.parse(fs.readFileSync(process.env.DG_SIM_GAMES, 'utf8'));
const EVENTS = JSON.parse(fs.readFileSync(process.env.DG_SIM_EVENTS, 'utf8'));
const findings = [];
const issue = (area, what, detail = '') => {
  findings.push({ area, what, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  console.log(`ISSUE ${area}: ${what}${detail !== '' ? ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const ok = (what) => console.log(`ok ${what}`);
const TZ = 'Pacific/Auckland';
const key = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const DAY = 86400000;

/* ---------- a labelled stand-in for each Shopify picture (16:9 unless the URL asks otherwise) ---------- */
const standIn = (url) => {
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'picture');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3a2f63"/><stop offset="1" stop-color="#1f5b4a"/></linearGradient></defs><rect width="1600" height="900" fill="url(#g)"/><rect x="40" y="40" width="1520" height="820" fill="none" stroke="#f6b93b" stroke-width="8" stroke-dasharray="30 20"/><circle cx="800" cy="450" r="60" fill="#f6b93b"/><text x="800" y="620" font-family="sans-serif" font-size="64" fill="#f8efe2" text-anchor="middle">${name.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text></svg>`;
};
async function ctxFor(customer, device) {
  const ctx = await context(customer, device);
  await ctx.route('https://cdn.shopify.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: standIn(route.request().url()) }));
  return ctx;
}

/* ---------- a page: open, settle, screenshot, and anything that went wrong ---------- */
let shotNo = 0;
async function visit(ctx, url, label, { wait = 1500, scroll = null, full = false } = {}) {
  const p = await page(ctx, label);
  await p.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 90000 });
  await p.waitForTimeout(wait);
  if (scroll) await p.locator(scroll).first().scrollIntoViewIfNeeded().catch(() => {});
  await settle(p, label, { full });
  return p;
}
async function settle(p, label, { full = false } = {}) {
  await p.waitForTimeout(400);
  const over = await overflow(p);
  if (over > 0) issue(label, 'the page scrolls sideways', `${over}px`);
  shotNo += 1;
  const file = path.join(OUT, `${String(shotNo).padStart(3, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
  await p.screenshot({ path: file, fullPage: full });
  const problems = p.problems.splice(0);
  if (problems.length) issue(label, 'errors on the page', problems.slice(0, 5).join(' || '));
  return file;
}

/* ---------- the cron's maintenance, once, now; and the staff emails it sent (the fake's Resend) ---------- */
const FAKE = 'http://127.0.0.1:8799';
const maintenance = () => fetch(`${WORKER}/__dev/maintenance`, { method: 'POST' }).then((r) => r.json());
const staffEmails = async () => {
  const list = await fetch(`${FAKE}/__fake/emails`).then((r) => r.json()).catch(() => []);
  return (Array.isArray(list) ? list : list.emails || []).flatMap((m) => (Array.isArray(m) ? m : [m]))
    .filter((m) => [].concat(m.to || []).includes('staff@dicegoblin.test')).map((m) => String(m.subject || ''));
};

const now = Date.now();
const today = key(now);
const from = Date.parse(`${today}T00:00:00+13:00`);
const to = from + 60 * DAY;

await start();
try {
  /* ---------- setup: members, the 25 GM games through the owner's job ---------- */
  const names = { 7001: 'Mo Ashgrove', 7101: 'Sam Jones', 7102: 'Kiri Smith', 7103: 'Ana Rangi', 7104: 'Leo Tane' };
  const codes = {};
  for (const [id, name] of Object.entries(names)) {
    const me = await proxy('GET', `me?name=${encodeURIComponent(name)}`, { customer: id });
    codes[id] = me.data.member?.code;
  }
  const loaded = await fetch(`${WORKER}/__dev/admin-job`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'sim', kind: 'games.add', payload: GAMES }) }).then((r) => r.json());
  if (loaded.failed?.length) issue('setup', 'games that would not load', loaded.failed);
  ok(`loaded ${loaded.added?.length} games, ${loaded.added?.reduce((n, a) => n + a.sessions, 0)} sessions; skipped: ${JSON.stringify(loaded.added?.flatMap((a) => a.skipped.map((s) => `${a.title} ${s.when}`)))}`);
  // Round 12: the job lists only dates a game really can't have (an event locks its tables), never the horizon's last day
  const horizonDay = key(now + 60 * DAY);
  const edge = (loaded.added || []).flatMap((a) => a.skipped.filter((s) => key(s.start) === horizonDay).map((s) => `${a.title} ${s.when}`));
  if (edge.length) issue('setup', "sessions on the horizon's last day reported as skipped", edge);
  // The cron's maintenance, twice: staff hear about each date a series can't have once, not on every run
  const before = (await staffEmails()).length;
  await maintenance();
  await maintenance();
  const told = (await staffEmails()).slice(before).filter((s) => /^Game series needs a table/.test(s));
  const twice = told.filter((s, i) => told.indexOf(s) !== i);
  if (twice.length) issue('maintenance', 'staff told about the same series twice', twice);
  ok(`maintenance x2: staff told once each: ${JSON.stringify(told)}`);
  const series = Object.fromEntries((loaded.added || []).map((a) => [a.title + (a.title === 'Icewind Dale' ? `:${a.id}` : ''), a]));
  const gameId = (title) => (loaded.added || []).find((a) => a.title === title)?.id;

  /* ---------- 1. the app and the theme agree on every event date (next 60 days), tag, hold and seat ---------- */
  const floor = await proxy('GET', `floor?from=${from}&to=${to}`);
  const holds = new Set((floor.data.eventHolds || []).map((h) => h.occurrenceId));
  {
    const ctx = await ctxFor(null, DESKTOP);
    const p = await visit(ctx, '/pages/events-calendar', 'consistency events calendar');
    const theme = await p.evaluate(({ from, to }) => {
      const L = window.Lair;
      const items = (L.store.data.events || []).filter((e) => e.startMs >= from && e.startMs < to);
      const tags = {};
      for (const e of items) if (!tags[e.handle]) tags[e.handle] = L.repeatTag(e, L.store.time);
      return { ids: items.map((e) => e.id), tags };
    }, { from, to });
    const themeIds = new Set(theme.ids);
    const onlyTheme = theme.ids.filter((id) => !holds.has(id));
    const onlyApp = [...holds].filter((id) => !themeIds.has(id));
    if (onlyTheme.length || onlyApp.length) issue('events', 'the theme and the app list different event dates', { onlyTheme, onlyApp });
    else ok(`event dates agree: ${themeIds.size} dates in the next 60 days`);
    const staffList = await proxy('GET', 'events', { customer: '7001' });
    for (const e of staffList.data.events || []) {
      const themeTag = theme.tags[e.handle];
      if (e.repeatTag && themeTag && e.repeatTag !== themeTag) issue('events', `repeat tags differ for ${e.handle}`, `app "${e.repeatTag}" vs theme "${themeTag}"`);
    }
    ok(`repeat tags compared for ${Object.keys(theme.tags).length} events`);
    await ctx.close();
  }
  // seats: the board's taken includes the players already in each group
  for (const g of floor.data.games || []) {
    const spec = GAMES.games.find((x) => x.title === g.title && x.gm === g.gm);
    if (spec && g.taken !== spec.offlinePlayers) issue('games', `${g.title}: ${g.taken} taken, expected ${spec.offlinePlayers}`);
    if (g.taken >= g.seats && g.status !== 'full') issue('games', `${g.title} is full but says ${g.status}`);
  }
  ok(`${(floor.data.games || []).length} games on the board`);

  /* ---------- 2. a visitor, phone then desktop ---------- */
  const SHEETS_EVENTS = [
    `warhammer-night@2026-10-15`, `pokemon-night@2026-10-16`, `gundam-night@2026-10-16`, `magic-night-monday@2026-10-12`, `riftbound-night@2026-10-13`,
    `one-piece-night@2026-10-12`, `blood-on-the-clocktower-october@2026-10-18`, `oddity-alley-november@2026-11-21`, `oddity-alley-november@2026-11-22`,
  ];
  const SHEETS_GAMES = ['Cyberpunk', 'Rise of Dragon', 'PF Society Organized Play', 'Mist Walkers of Ravenloft', 'Rogue Trader', 'The Shattered Obelisk'];
  for (const [tag, device] of [['phone', PHONE], ['desktop', DESKTOP]]) {
    const ctx = await ctxFor(null, device);
    await visit(ctx, '/', `${tag} home`);
    await visit(ctx, '/', `${tag} home what's on`, { scroll: 'lair-glance' });
    await visit(ctx, '/pages/book-a-table', `${tag} book tables`);
    await visit(ctx, '/pages/gm-games', `${tag} ttrpg board`);
    const board = await visit(ctx, '/pages/gm-games', `${tag} ttrpg board lower`, { scroll: '.cal-card:nth-of-type(6), .gm-card:nth-of-type(6)' });
    await board.close();
    await visit(ctx, '/pages/events-calendar', `${tag} events`);
    await visit(ctx, '/pages/events-calendar', `${tag} events what's on`, { scroll: '.whats-on' });
    for (const id of SHEETS_EVENTS) {
      const p = await visit(ctx, `/pages/events-calendar#event=${encodeURIComponent(id)}`, `${tag} sheet ${id}`, { wait: 2000 });
      const open = await p.evaluate(() => Boolean(document.querySelector('lair-calendar dialog[open], dialog[open]')));
      if (!open) issue(`${tag} sheet ${id}`, 'the event sheet did not open from its link');
      await p.close();
    }
    for (const title of SHEETS_GAMES) {
      const id = gameId(title);
      const p = await visit(ctx, `/pages/gm-games#game=${encodeURIComponent(id)}`, `${tag} game ${title}`, { wait: 2000 });
      await p.close();
    }
    await ctx.close();
  }

  /* ---------- 3. a member's evening: a seat, a Warhammer game, I'm coming with a reminder, a sign-up ---------- */
  const mist = gameId('Mist Walkers of Ravenloft');
  const seat = await proxy('POST', 'bookings', { customer: '7101', body: { kind: 'gm-seat', gameId: mist, people: 1, name: 'Sam Jones', email: 'sam@example.com', phone: '021 555 0101' } });
  if (seat.status !== 200) issue('member', 'a seat at Mist Walkers was refused', seat.data);
  const wh = await proxy('POST', 'events/warhammer-night@2026-10-15/reserve', { customer: '7101', body: { name: 'Sam Jones', email: 'sam@example.com', phone: '021 555 0101', spot: 'T10+T11', people: 2, players: [{ code: codes[7102] }], pay: 'day' } });
  if (wh.status !== 200) issue('member', 'a Warhammer 1 v 1 was refused', wh.data);
  const poke = await proxy('POST', 'interest', { customer: '7101', body: { kind: 'event', id: 'pokemon-night@2026-10-16', coming: true, remind: true } });
  if (poke.status !== 200) issue('member', "Pokémon night's I'm coming was refused", poke.data);
  const odd = await proxy('POST', 'interest', { customer: '7101', body: { kind: 'event', id: 'oddity-alley-november@2026-11-22', coming: true, remind: true } });
  if (odd.status !== 200) issue('member', "Oddity Alley's Sunday I'm coming was refused", odd.data);
  const botc = await proxy('POST', 'events/blood-on-the-clocktower-october@2026-10-18/join', { customer: '7101', body: { name: 'Sam Jones', email: 'sam@example.com', phone: '021 555 0101', people: 2, pay: 'store' } });
  if (botc.status !== 200) issue('member', 'a Blood on the Clocktower sign-up was refused', botc.data);
  for (const [tag, device] of [['phone', PHONE], ['desktop', DESKTOP]]) {
    const ctx = await ctxFor('7101', device);
    await visit(ctx, '/pages/my-lair', `${tag} member my lair`, { wait: 2500 });
    await visit(ctx, '/pages/my-lair#bookings', `${tag} member my lair bookings`, { wait: 2500 });
    for (const id of ['blood-on-the-clocktower-october@2026-10-18', 'pokemon-night@2026-10-16', 'warhammer-night@2026-10-15']) {
      const p = await visit(ctx, `/pages/events-calendar#event=${encodeURIComponent(id)}`, `${tag} member sheet ${id}`, { wait: 2000 });
      await p.close();
    }
    const p = await visit(ctx, `/pages/gm-games#game=${encodeURIComponent(mist)}`, `${tag} member game Mist Walkers`, { wait: 2000 });
    await p.close();
    await ctx.close();
  }
  // Kiri, named as Sam's opponent: her My Lair
  {
    const ctx = await ctxFor('7102', PHONE);
    await visit(ctx, '/pages/my-lair', 'phone opponent my lair', { wait: 2500 });
    await ctx.close();
  }

  /* ---------- 4. Blood on the Clocktower fills up (40), then the waitlist ---------- */
  let left = 38;
  let n = 0;
  while (left > 0) {
    const people = Math.min(6, left);
    n += 1;
    const r = await proxy('POST', 'events/blood-on-the-clocktower-october@2026-10-18/join', { body: { name: `Guest ${n} Example`, email: `guest${n}@example.com`, phone: '021 555 0199', people, pay: 'store' } });
    if (r.status !== 200) {
      issue('botc', `sign-up ${n} (${people}) refused before 40`, r.data);
      break;
    }
    left -= people;
  }
  const over = await proxy('POST', 'events/blood-on-the-clocktower-october@2026-10-18/join', { body: { name: 'Late Example', email: 'late@example.com', phone: '021 555 0198', people: 1, pay: 'store' } });
  if (over.status === 200) issue('botc', 'a 41st place was taken');
  const wait = await proxy('POST', 'interest', { body: { waitlist: true, kind: 'event', id: 'blood-on-the-clocktower-october@2026-10-18', name: 'Late Example', email: 'late@example.com', phone: '021 555 0198', people: 3 } });
  if (wait.status !== 200) issue('botc', 'the waitlist was refused', wait.data);
  for (const [tag, device] of [['phone', PHONE], ['desktop', DESKTOP]]) {
    const ctx = await ctxFor(null, device);
    const p = await visit(ctx, `/pages/events-calendar#event=${encodeURIComponent('blood-on-the-clocktower-october@2026-10-18')}`, `${tag} botc full`, { wait: 2000 });
    const words = await p.evaluate(() => (document.querySelector('dialog[open]')?.textContent || '').replace(/\s+/g, ' '));
    if (!/waiting/i.test(words)) issue(`${tag} botc full`, 'the full sheet does not say how many are waiting', words.slice(0, 200));
    await p.close();
    await ctx.close();
  }

  /* ---------- 5. staff, desktop then phone ---------- */
  for (const [tag, device] of [['desktop', DESKTOP], ['phone', PHONE]]) {
    const ctx = await ctxFor('7001', device);
    const p = await visit(ctx, '/pages/lair-staff', `${tag} staff floor`, { wait: 2500 });
    const tabs = await p.$$eval('.staff-tab', (els) => els.map((e) => e.dataset.tab));
    for (const id of tabs) {
      if (id === 'floor') continue;
      await p.click(`[data-tab="${id}"]`);
      await p.waitForTimeout(1500);
      await settle(p, `${tag} staff ${id}`);
    }
    // a GM game with players already in the group: its players
    await p.click('[data-tab="games"]');
    await p.waitForTimeout(1200);
    const row = p.locator('.staff-gm-row', { hasText: 'Fanova' }).first();
    if (await row.count()) {
      await row.click().catch(() => {});
      await p.waitForTimeout(1200);
      const players = await p.evaluate(() => document.querySelector('[data-gm-players]')?.textContent || '');
      if (!/5 players already in the group/.test(players)) issue(`${tag} staff game Fanova`, "the players panel doesn't say five are already in the group", players.replace(/\s+/g, ' ').slice(0, 160));
      await settle(p, `${tag} staff game Fanova`);
    }
    await p.close();
    await ctx.close();
  }

  /* ---------- 6. backend changes while the site is in use ---------- */
  // a game's picture taken away
  const pic = await fetch(`${WORKER}/__dev/admin-job`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'games.update', payload: { updates: [{ seriesId: series['Barons'].seriesId, set: { imageUrl: null } }] } }) }).then((r) => r.json());
  if (pic.failed?.length) issue('backend', 'taking a picture away failed', pic.failed);
  // the session Sam has a seat at is cancelled by staff
  const cancel = await proxy('POST', `games/${mist}/update`, { customer: '7001', body: { status: 'cancelled' } });
  if (cancel.status !== 200) issue('backend', 'staff could not cancel a session', cancel.data);
  // the October Blood on the Clocktower is deleted in Shopify (sign-ups and a waitlist on it)
  const without = EVENTS.filter((e) => e.handle !== 'blood-on-the-clocktower-october');
  fs.writeFileSync(process.env.DG_SIM_EVENTS, JSON.stringify(without, null, 1));
  // Round 12: the next maintenance tells staff once about the date that went, with people on it; the run after, nothing
  const beforeGone = (await staffEmails()).length;
  // the setup route is maintenance with Shopify's events read again now (the cron reads them every 5 minutes)
  const run = await fetch(`${WORKER}/setup?key=test-setup-key`).then((r) => r.json());
  await maintenance();
  const goneMail = (await staffEmails()).slice(beforeGone).filter((s) => /^Not on the calendar any more/.test(s));
  if (goneMail.length !== 1 || !/Blood on the Clocktower, Sun 18 Oct/.test(goneMail[0] || '')) issue('maintenance', 'staff were not told once about the deleted date', { goneMail, gone: run.goneDates });
  else ok(`staff told once: ${goneMail[0]}`);
  for (const [tag, device] of [['phone', PHONE], ['desktop', DESKTOP]]) {
    const ctx = await ctxFor('7101', device);
    // Home's list flags it; Bookings opens its ticket with the note
    const home = await visit(ctx, '/pages/my-lair', `${tag} after changes my lair`, { wait: 2500 });
    const flagged = await home.evaluate(() => document.body.innerText);
    if (!/Not on the calendar now/.test(flagged)) issue(`${tag} after changes my lair`, "Home doesn't flag the deleted date's sign-up");
    await home.close();
    const mine = await visit(ctx, '/pages/my-lair#bookings', `${tag} after changes my lair bookings`, { wait: 2500 });
    const said = await mine.evaluate(() => document.body.innerText);
    if (!/isn’t on the events calendar any more/.test(said)) issue(`${tag} after changes my lair bookings`, "the deleted date's sign-up doesn't say it's gone");
    await mine.close();
    const b = await visit(ctx, '/pages/gm-games', `${tag} after changes ttrpg board`, { wait: 2000, scroll: '.cal-card:nth-of-type(10)' });
    await b.close();
    const e = await visit(ctx, '/pages/events-calendar#event=blood-on-the-clocktower-october%402026-10-18', `${tag} after changes deleted event link`, { wait: 2000 });
    const sheet = await e.evaluate(() => (document.querySelector('dialog[open]')?.textContent || '').replace(/\s+/g, ' '));
    if (!/Not on the calendar/.test(sheet)) issue(`${tag} after changes deleted event link`, 'the link to the deleted date opens nothing', sheet.slice(0, 200));
    await e.close();
    // the cancelled Mist Walkers session's link (the sessions board says it couldn't find it)
    const c = await visit(ctx, `/pages/gm-games#game=${encodeURIComponent(mist)}`, `${tag} after changes cancelled session link`, { wait: 2000 });
    const words = await c.evaluate(() => [...document.querySelectorAll('[data-notice]')].map((el) => (el.hidden ? '' : el.textContent)).join(' '));
    if (!/couldn’t find that game/.test(words)) issue(`${tag} after changes cancelled session link`, 'the link to the cancelled session says nothing', words.slice(0, 200));
    await c.close();
    await ctx.close();
  }
  {
    const ctx = await ctxFor('7001', DESKTOP);
    const p = await visit(ctx, '/pages/lair-staff', 'desktop after changes staff', { wait: 2500 });
    for (const id of ['today', 'games', 'events']) {
      await p.click(`[data-tab="${id}"]`);
      await p.waitForTimeout(1500);
      await settle(p, `desktop after changes staff ${id}`);
    }
    await p.close();
    await ctx.close();
  }
  fs.writeFileSync(process.env.DG_SIM_EVENTS, JSON.stringify(EVENTS, null, 1));
} catch (error) {
  issue('run', 'the simulation stopped', error.stack || error.message);
  fs.writeFileSync(process.env.DG_SIM_EVENTS, JSON.stringify(EVENTS, null, 1));
} finally {
  await stop();
  fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify(findings, null, 2));
  console.log(`\n${findings.length} issue(s); screenshots in ${OUT}`);
}

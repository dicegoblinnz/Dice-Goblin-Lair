// Round 19, the website's booking steps (24 Oct 2026, contract v19-report). Mo: "Yes, build both" (the weekly numbers,
// and an anonymous count of how many people start and finish a booking). On the theme mock:
//  1. Demo mode (the lab), phone and desktop, a guest: a table booked end to end, a TTRPG seat joined, an event signed up
//     for. Each flow says start, the TTRPG seat says it asked them to log in, and each says done; a second open of the
//     same form isn't a second start; demo mode sends nothing to the Lair app.
//  2. Live mode against a stubbed Lair app: store.step sends POST /apps/liar/steps as JSON with only the flow and the
//     step; a start or a log-in once a try in this tab, again after a done; unknown flows and steps send nothing; and it
//     doesn't reload the floor.
// No console errors throughout.
// Usage: DG_THEME=/path/to/theme [PORT=4995] [OUT=dir] node tools/qa/round19/steps.mjs [phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round19-steps');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, context, watch, go, shot } = lib;
const PORT = Number(process.env.PORT || 4995);
const BASE = `http://localhost:${PORT}`;
const sizes = process.argv[2] ? [process.argv[2]] : ['phone', 'desktop'];

const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const ready = (page) => page.waitForFunction(() => Boolean(window.Lair && window.Lair.store && window.Lair.store.data), null, { timeout: 20000 });

/** Record every store.step call (it still runs: in demo mode it sends nothing), and every request to the Lair app */
async function spy(page) {
  page.lairRequests = [];
  page.on('request', (req) => {
    if (new URL(req.url()).pathname.startsWith('/apps/liar/')) page.lairRequests.push({ method: req.method(), path: new URL(req.url()).pathname, body: req.postData() });
  });
}
const armSpy = (page) => page.evaluate(() => {
  const { store } = window.Lair;
  window.__steps = [];
  if (!store.__real) store.__real = store.step.bind(store);
  store.step = (flow, name) => {
    window.__steps.push(`${flow}:${name}`);
    return store.__real(flow, name);
  };
});
const steps = (page) => page.evaluate(() => window.__steps.slice());

/* ---------- 1. demo mode: the three flows ---------- */
m.globalSettings.lair_mode = 'demo';
for (const size of sizes) {
  const tag = size;
  const ctx = await context(browser, size);
  const page = watch(await ctx.newPage());
  await spy(page);

  // a table, end to end
  await go(page, BASE, '/pages/book-a-table', null);
  await ready(page);
  await armSpy(page);
  const free = await page.evaluate(() => {
    const play = document.querySelector('lair-play');
    const store = window.Lair.store;
    const today = store.time.today();
    for (let i = 0; i < 10; i += 1) {
      const day = store.time.addDays(today, i);
      if (!store.openWindow(day)) continue;
      const slot = store.slots(day).find((x) => x.bookable && x.start > Date.now() + 2 * 3600000 && x.minutes <= store.openWindow(day).closeMin - 180);
      if (!slot) continue;
      const id = ['T4', 'T16', 'G1', 'P3', 'T18'].find((t) => play.canBook(t, slot.start, slot.start + 3 * 3600000) && !store.softHold(t, slot.start, slot.start + 3 * 3600000));
      if (id) return { day, minutes: slot.minutes, id };
    }
    return null;
  });
  if (check(`${tag}: a free table to book`, Boolean(free), free)) {
    await page.evaluate(({ day, minutes, id }) => {
      const play = document.querySelector('lair-play');
      if (play.day !== day) play.selectDay(day);
      play.enterBooking({ tables: [id], minutes, hours: 3 });
      // Change, then Book again: the same try
      play.enterBooking({ tables: [id], minutes, hours: 3 });
    }, free);
    await settle(page);
    await page.fill('#bk-name', 'Steps Test');
    await page.fill('#bk-email', 'steps@example.com');
    await page.fill('#bk-phone', '021 555 0190');
    await page.click('lair-booking [data-submit]');
    await page.waitForFunction(() => {
      const done = document.querySelector('lair-booking [data-done]');
      return done && !done.hidden;
    }, null, { timeout: 10000 }).catch(() => {});
    const booked = await page.evaluate(() => !document.querySelector('lair-booking [data-done]').hidden);
    check(`${tag}: the table is booked (the demo's ticket)`, booked);
    check(`${tag}: a table booking says start once (Change and Book again is the same try), then done`, JSON.stringify(await steps(page)) === JSON.stringify(['table:start', 'table:start', 'table:done']), await steps(page));
    await shot(page, `${tag}-table-done`);
  }

  // a TTRPG seat, as a guest: the form asks them to log in first (or join just this once)
  await go(page, BASE, '/pages/gm-games', null);
  await ready(page);
  await armSpy(page);
  const game = await page.evaluate(() => {
    const store = window.Lair.store;
    const g = store.data.games.find((x) => x.status === 'open' && x.start > Date.now() && !x.private && (x.seats - (x.taken || 0)) > 1);
    return g ? { id: g.id, title: g.title } : null;
  });
  if (check(`${tag}: an open TTRPG session to join`, Boolean(game), game)) {
    await page.evaluate((id) => document.querySelector('gm-board').joiner.open(id), game.id);
    await page.waitForSelector('[data-session-join]', { timeout: 8000 });
    const login = await page.evaluate(() => Boolean(document.querySelector('[data-session-join] [data-account="login"]')));
    check(`${tag}: a guest's seat form says log in first`, login);
    await page.fill('[data-session-join] [name="name"]', 'Jo Steps');
    await page.fill('[data-session-join] [name="email"]', 'jo.steps@example.com');
    await page.fill('[data-session-join] [name="phone"]', '021 555 0191');
    await page.click('[data-join-submit]');
    await page.waitForSelector('gm-board .gm-done', { timeout: 8000 }).catch(() => {});
    check(`${tag}: the guest joins (the demo's ticket)`, Boolean(await page.$('gm-board .gm-done')));
    check(`${tag}: a seat says start, asked to log in, then done`, JSON.stringify(await steps(page)) === JSON.stringify(['ttrpg:start', 'ttrpg:login', 'ttrpg:done']), await steps(page));
    await shot(page, `${tag}-seat-done`);
  }

  // an event sign-up
  await go(page, BASE, '/pages/events-calendar', null);
  await ready(page);
  await page.waitForFunction(() => Boolean(document.querySelector('lair-calendar') && document.querySelector('lair-calendar').all), null, { timeout: 10000 });
  await armSpy(page);
  const event = await page.evaluate(() => {
    const cal = document.querySelector('lair-calendar');
    for (const item of cal.all()) {
      if (item.start <= Date.now()) continue;
      cal.openJoin(item.id);
      if (cal.querySelector('#cal-join-form')) return { id: item.id, title: item.title };
    }
    return null;
  });
  if (check(`${tag}: an event to sign up for`, Boolean(event), event)) {
    await page.fill('#cal-join-form [name="name"]', 'Ari Steps');
    await page.fill('#cal-join-form [name="email"]', 'ari.steps@example.com');
    await page.fill('#cal-join-form [name="phone"]', '021 555 0192');
    await page.click('button[form="cal-join-form"]');
    await page.waitForFunction(() => window.__steps.includes('event:done'), null, { timeout: 8000 }).catch(() => {});
    const said = await steps(page);
    check(`${tag}: an event sign-up says start (once, however many forms it opened on the way), then done`, said[said.length - 1] === 'event:done' && said.filter((s) => s === 'event:start').length >= 1 && said.every((s) => /^event:(start|done)$/.test(s)), said);
    await shot(page, `${tag}-event-done`);
  }

  check(`${tag}: demo mode sends nothing to the Lair app`, page.lairRequests.length === 0, page.lairRequests);
  check(`${tag}: no console errors`, page.errors.length === 0, page.errors);
  await ctx.close();
}

/* ---------- 2. live mode: what store.step sends, against a stubbed Lair app ---------- */
m.globalSettings.lair_mode = 'live';
const sent = [];
let floors = 0;
m.mockState.before = async (req, res, url) => {
  if (!url.pathname.startsWith('/apps/liar/')) return false;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const route = url.pathname.replace('/apps/liar', '');
  let body = {};
  if (route === '/floor') {
    floors += 1;
    body = { now: Date.now(), bookings: [], blocks: [], games: [], events: [], eventJoins: {}, eventSpots: {}, gameSpots: {}, eventInterest: {}, shopTables: [], openings: [], features: {} };
  } else if (route === '/steps') {
    sent.push({ method: req.method, type: req.headers['content-type'] || '', body: raw ? JSON.parse(raw) : null });
    body = { ok: true, counted: true };
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
};
{
  const ctx = await context(browser, 'desktop');
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/book-a-table', null);
  await page.waitForFunction(() => window.Lair && window.Lair.store && !window.Lair.store.isDemo, null, { timeout: 15000 });
  await settle(page, 800);
  const floorsBefore = floors;
  await page.evaluate(() => {
    const { store } = window.Lair;
    store.step('table', 'start');
    store.step('table', 'start');
    store.step('table', 'login');
    store.step('shop', 'start');
    store.step('table', 'paid');
    store.step('table', 'done');
    store.step('table', 'start');
  });
  await settle(page, 800);
  check('live: POST /apps/liar/steps as JSON, only the flow and the step; a start once a try, again after done; nothing for unknown ones',
    JSON.stringify(sent) === JSON.stringify([
      { method: 'POST', type: 'application/json', body: { flow: 'table', step: 'start' } },
      { method: 'POST', type: 'application/json', body: { flow: 'table', step: 'login' } },
      { method: 'POST', type: 'application/json', body: { flow: 'table', step: 'done' } },
      { method: 'POST', type: 'application/json', body: { flow: 'table', step: 'start' } },
    ]), sent);
  check('live: counting a step doesn\'t reload the floor', floors === floorsBefore, { floors, floorsBefore });
  const stored = await page.evaluate(() => Object.keys(window.sessionStorage).filter((k) => k.startsWith('lair-step:')).sort());
  check('live: the tab remembers only that a try is open (no ids)', JSON.stringify(stored) === JSON.stringify(['lair-step:table:start']), stored);
  check('live: no console errors', page.errors.length === 0, page.errors);
  await ctx.close();
}
m.mockState.before = null;
m.globalSettings.lair_mode = 'demo';

const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed. Screens in ${process.env.OUT}`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

// Polling (17 Oct 2026): on launch day the site's open pages, each asking the Lair every 8 to 30 seconds all night, used up
// the Cloudflare free plan's daily Durable Objects allowance. On the theme mock in live mode (the Lair app stubbed, a
// fake clock): the booking and TTRPG pages ask every minute while someone's using them and stop after 10 minutes with
// nobody; a tap brings the latest straight away and starts them again; the staff page asks every 20 seconds, then every
// 2 minutes when nobody's used it for 10.
// Usage: DG_THEME=/path/to/theme [PORT=4996] node tools/qa/round18/polling.mjs
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-polling');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, STAFF } = lib;
const PORT = Number(process.env.PORT || 4996);
const BASE = `http://localhost:${PORT}`;
const MIN = 60_000;

const server = await m.serve(PORT);
const browser = await chromium.launch();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

m.globalSettings.lair_mode = 'live';
let floors = 0;
const FLOOR = { bookings: [], blocks: [], games: [], events: [], eventJoins: {}, eventSpots: {}, gameSpots: {}, eventInterest: {}, shopTables: [], openings: [], features: {} };
m.mockState.before = async (req, res, url) => {
  if (!url.pathname.startsWith('/apps/liar/')) return false;
  for await (const chunk of req) void chunk;
  const route = url.pathname.replace('/apps/liar', '');
  let body = {};
  if (route === '/floor') {
    floors += 1;
    body = { now: Date.now(), ...FLOOR, staff: Boolean(m.mockState.customer?.tags?.includes('staff')) };
  } else if (route === '/staff/me') {
    body = { staff: true, role: 'owner', perms: ['team'], name: 'Mo' };
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
};

/** A page on the fake clock; returns how many times it asked for the floor at each step */
async function run(where, customer, steps) {
  m.mockState.customer = customer;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date('2026-10-17T03:00:00Z') });
  await page.goto(`${BASE}${where}`, { waitUntil: 'networkidle', timeout: 60000 });
  await pause(500);
  const counts = [];
  for (const step of steps) {
    const before = floors;
    if (step.tap) await page.mouse.click(5, 400);
    // the clock moves on 10 seconds at a time, with a moment for each look to come back, as a real minute would
    for (let left = step.run || 0; left > 0; left -= 10_000) {
      await page.clock.runFor(Math.min(10_000, left));
      await pause(60);
    }
    await pause(700);
    counts.push(floors - before);
  }
  await ctx.close();
  return counts;
}

// The booking page: a minute between looks while it's in use; nothing once nobody's touched it for 10 minutes; a tap
// asks straight away and starts it again
const booking = await run('/pages/book-a-table', null, [
  { run: 5 * MIN }, // 0 to 5 minutes: 5 looks
  { run: 4 * MIN }, // 5 to 9: 4 more
  { run: 20 * MIN }, // 9 to 29: one at 10 at most, then none
  { tap: true }, // back: straight away
  { run: 3 * MIN }, // and every minute again
]);
check(`booking page: every minute while in use (${booking[0]}, ${booking[1]})`, booking[0] === 5 && booking[1] === 4, booking);
check(`booking page: nothing after 10 minutes with nobody (${booking[2]} in 20 minutes)`, booking[2] <= 1, booking);
check(`booking page: a tap asks straight away (${booking[3]}), then every minute again (${booking[4]})`, booking[3] === 1 && booking[4] === 3, booking);

const games = await run('/pages/gm-games', null, [{ run: 5 * MIN }, { run: 25 * MIN }, { tap: true }]);
check(`TTRPG sessions page: every minute in use (${games[0]}), stops when idle (${games[1]}), a tap asks (${games[2]})`, games[0] === 5 && games[1] <= 5 && games[2] === 1, games);

// The staff page: every 20 seconds while in use, every 2 minutes after 10 minutes with nobody
const staff = await run('/pages/lair-staff', STAFF, [{ run: 2 * MIN }, { run: 8 * MIN }, { run: 20 * MIN }, { run: 50_000 }, { tap: true }, { run: MIN }]);
check(`staff page: every 20 seconds in use (${staff[0]} in 2 minutes)`, staff[0] >= 5 && staff[0] <= 6, staff);
check(`staff page: every 2 minutes when idle (${staff[2]} in 20 minutes)`, staff[2] >= 9 && staff[2] <= 11, staff);
check(`staff page: a tap more than 20 seconds after its last look asks straight away (${staff[4]}), and every 20 seconds again (${staff[5]})`, staff[4] === 1 && staff[5] >= 2 && staff[5] <= 3, staff);

m.mockState.before = null;
const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed.`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

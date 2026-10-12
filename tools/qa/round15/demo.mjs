// Round 15 checks for assets/lair-demo.js: drives the demo backend in a page (theme mock, demo mode) with a movable clock.
// Usage: DG_THEME=/path/to/theme PORT=4963 node tools/qa/round15/demo.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4963);
const BASE = `http://localhost:${PORT}`;
const TZ = 'Pacific/Auckland';
const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const offset = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${key}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const iso = (key, hm) => `${key}T${hm}:00${offset(key)}`;
const today = lairKey(Date.now());
const AT = Date.parse(iso(today, '13:00'));
const CLOCK = `(() => { let OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; globalThis.__setNow = (ms) => { OFFSET = ms - Real.now(); }; })();`;
const RUBY = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [] };

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

const server = await m.serve(PORT);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: TZ, locale: 'en-NZ' });
await ctx.addInitScript(CLOCK);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
m.mockState.customer = RUBY;
await page.goto(`${BASE}/pages/book-a-table`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend && window.Lair.TAB, null, { timeout: 20000 });

// Everything below runs in the page: helpers to call the backend as Ruby, as staff (no login, the demo's staff page) and
// to move the clock
const run = (fn, arg) => page.evaluate(fn, arg);
await run(() => {
  const b = window.Lair.store.backend;
  window.__ruby = b.cfg.customer;
  window.__as = async (who, fn) => {
    const before = b.cfg.customer;
    b.cfg.customer = who === 'staff' ? { id: 'demo-staff-1', name: 'Staff', fullName: 'Staff Member', email: 'staff@example.com', staff: true } : who === 'nobody' ? null : who === 'ruby' ? window.__ruby : who;
    try {
      return await fn(b);
    } catch (error) {
      return { error: error.message, status: error.status };
    } finally {
      b.cfg.customer = before;
    }
  };
});

/* 1. no checkout: payOnline false, sign-ups and game tables confirmed at once, whatever pay says */
const floor = await run(async () => (await window.Lair.store.backend.floor()).features);
check('floor: features.payOnline is false', floor.payOnline === false, floor);

const setup = await run(async () => {
  const b = window.Lair.store.backend;
  const now = Date.now();
  const occ = b.occurrences();
  const paidDate = occ.filter((o) => o.capacity && o.entryFee && o.startMs > now + 30 * 3600000).sort((x, y) => x.startMs - y.startMs)[0];
  const freeDate = occ.filter((o) => o.capacity && !o.entryFee && o.startMs > now + 3600000).sort((x, y) => x.startMs - y.startMs)[0];
  const spotDate = occ.filter((o) => o.gameTables && o.startMs > now + 30 * 3600000).sort((x, y) => x.startMs - y.startMs)[0];
  return {
    paidDate: paidDate && { id: paidDate.id, start: paidDate.startMs, end: paidDate.endMs, fee: paidDate.entryFee, payment: paidDate.payment },
    freeDate: freeDate && { id: freeDate.id, start: freeDate.startMs, end: freeDate.endMs },
    spotDate: spotDate && { id: spotDate.id, start: spotDate.startMs, end: spotDate.endMs, fee: spotDate.entryFee },
  };
});
check('setup: a paid date, a free date and a date with game tables', setup.paidDate && setup.freeDate && setup.spotDate, setup);
const H = 3600000;

const joined = await run((s) => window.__as('ruby', (b) => b.joinEvent(s.paidDate.id, { name: 'Ruby Tane', email: 'ruby@example.com', phone: '021 555 0100', people: 2, pay: 'now' })), setup);
check('joinEvent (pay now): confirmed on the tab, no hold, no checkout', joined.join && joined.join.status === 'confirmed' && joined.join.pay === 'day' && joined.join.payment === 'store'
  && !('holdMinutes' in joined) && !('checkoutUrl' in joined) && joined.notice === null && joined.join.due === 2 * setup.paidDate.fee, joined);
check('joinEvent: cancelUntil is the start less 24 hours, not locked; owed false, waived false', joined.join && joined.join.cancelUntil === setup.paidDate.start - 24 * H
  && joined.join.locked === false && joined.join.owed === false && joined.join.waived === false, joined.join);

const spot = await run((s) => window.__as('ruby', (b) => b.reserveEvent(s.spotDate.id, { name: 'Ruby Tane', email: 'ruby@example.com', phone: '021 555 0100', people: 2, pay: 'now' })), setup);
check('reserveEvent (pay now): confirmed on the tab, no hold', spot.booking && spot.booking.status === 'confirmed' && spot.booking.pay === 'day' && !('holdMinutes' in spot) && spot.notice === null, spot);
check('reserveEvent: cancelUntil/locked on the booking', spot.booking && spot.booking.cancelUntil === setup.spotDate.start - 24 * H && spot.booking.locked === false, spot.booking);

const free = await run((s) => window.__as('ruby', (b) => b.joinEvent(s.freeDate.id, { name: 'Ruby Tane', email: 'ruby@example.com', phone: '021 555 0100', people: 1 })), setup);
check('a free sign-up: cancelUntil is its start, not locked', free.join && free.join.amount === 0 && free.join.cancelUntil === setup.freeDate.start && free.join.locked === false, free.join);

/* 2. a table booked inside the 24 hours is locked at once */
const table = await run(async () => window.__as('ruby', async (b) => {
  const t = b.time;
  const now = Date.now();
  const key = t.today();
  // the first free table in a bookable room, three hours from the next whole hour, for an hour
  const start = t.at(key, (Math.floor(t.minutesOf(now) / 60) + 3) * 60);
  for (const room of b.cfg.rooms.filter((r) => r.bookable)) {
    for (const tb of room.tables) {
      if (b.cfg.shopTables.includes(tb.id) || b.tableTaken(tb.id, start, start + 3600000)) continue;
      try {
        return await b.createBooking({ kind: 'table', tables: [tb.id], start, end: start + 3600000, people: 2, name: 'Ruby Tane', email: 'ruby@example.com', phone: '021 555 0100', customerId: b.cfg.customer.id });
      } catch (error) {
        if (error.status !== 409 && error.status !== 422) throw error;
      }
    }
  }
  return { error: 'no table' };
}));
check('createBooking inside the 24 hours: locked at once (cancelUntil in the past)', table.booking && table.booking.locked === true && table.booking.cancelUntil === table.booking.start - 24 * H, table);
const tableCancel = await run((id) => window.__as('ruby', (b) => b.updateBooking(id, { status: 'cancelled' })), table.booking.id);
const LOCKED = "It's less than 24 hours away, so it can't be cancelled online now: it stays on your tab. Have a chat with us at the counter or give us a call, and we'll sort it out.";
check('own cancel of a locked table: 409 with the Lair app\'s words', tableCancel.status === 409 && tableCancel.error === LOCKED, tableCancel);

/* 3. the clock moves to 23 hours before the paid date: the sign-up and game table are locked; staff still cancel */
await run((ms) => window.__setNow(ms), setup.paidDate.start - 23 * H);
const lockedJoin = await run((id) => window.__as('ruby', (b) => b.cancelJoin(id)), joined.join.id);
check('cancelJoin 23 hours before: 409 locked', lockedJoin.status === 409 && lockedJoin.error === LOCKED, lockedJoin);
const meLocked = await run(() => window.__as('ruby', (b) => b.me()));
const mineJoin = meLocked.joins.find((j) => j.id === joined.join.id);
check('GET /me joins[]: locked true, cancelUntil kept', mineJoin && mineJoin.locked === true && mineJoin.cancelUntil === setup.paidDate.start - 24 * H, mineJoin);
const coming = meLocked.account.comingUp.items.find((i) => i.id === joined.join.id);
check('running tab comingUp: the sign-up carries cancelUntil and locked', coming && coming.locked === true && coming.cancelUntil === setup.paidDate.start - 24 * H, coming);
const staffCancel = await run((id) => window.__as('staff', (b) => b.cancelJoin(id)), joined.join.id);
check('staff cancel a locked sign-up: never refused', staffCancel.join && staffCancel.join.status === 'cancelled' && staffCancel.join.cancelUntil === null && staffCancel.join.locked === false, staffCancel);

/* 4. a free sign-up after it starts: 409 started */
await run((ms) => window.__setNow(ms), setup.freeDate.start + 10 * 60000);
const started = await run((id) => window.__as('ruby', (b) => b.cancelJoin(id)), free.join.id);
check('cancelJoin of a free sign-up once it has started: 409 started', started.status === 409 && started.error === "That one has already started, so it can't be cancelled online. Have a chat with us if something's not right.", started);

/* 5. over and unpaid: owed (the game table and the free date's ... the free one has nothing due) */
await run((ms) => window.__setNow(ms), setup.spotDate.end + 30 * 60000);
const owedMe = await run(() => window.__as('ruby', (b) => b.me()));
const owedSpot = owedMe.dueNow.find((d) => d.id === spot.booking.id);
check('GET /me dueNow: the game table that ended unpaid is owed', owedSpot && owedSpot.owed === true && owedSpot.due > 0, owedMe.dueNow);
const tabSpot = owedMe.account.owed.items.find((i) => i.id === spot.booking.id);
check('running tab owed: owedRow true', tabSpot && tabSpot.owedRow === true && tabSpot.kind === 'spot', tabSpot);
const bookingView = owedMe.bookings.find((x) => x.id === spot.booking.id);
check('GET /me bookings[]: owed true, cancelUntil null once over', bookingView && bookingView.owed === true && bookingView.cancelUntil === null && bookingView.locked === false, bookingView);

console.log(`errors: ${errors.join(' | ') || 'none'}`);
console.log(`${pass} passed, ${fail} failed`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

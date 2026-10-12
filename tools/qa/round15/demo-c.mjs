// Round 15 checks for assets/lair-demo.js, part c: the emails staff-added seats send (the demo's outbox), the check-in
// answer's sign-up view, a GM's own table and a walk-in never owed, and a table with no-show owed once it's over.
// Usage: DG_THEME=/path/to/theme PORT=4965 node tools/qa/round15/demo-c.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4965);
const TZ = 'Pacific/Auckland';
const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const offset = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${key}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const AT = Date.parse(`${lairKey(Date.now())}T13:00:00${offset(lairKey(Date.now()))}`);
const CLOCK = `(() => { let OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; globalThis.__setNow = (ms) => { OFFSET = ms - Real.now(); }; })();`;
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
m.mockState.customer = null; // the demo's staff page works without a login
await page.goto(`http://localhost:${PORT}/pages/book-a-table`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend && window.Lair.TAB, null, { timeout: 20000 });

const out = await page.evaluate(async () => {
  const b = window.Lair.store.backend;
  const TAB = window.Lair.TAB;
  const now = Date.now();
  const game = b.state.games.filter((g) => g.seriesId && g.status === 'open' && g.start > now + 30 * 3600000 && g.seats - g.taken >= 2).sort((x, y) => x.start - y.start)[0];
  const member = b.staffMembers().find((x) => x.firstName === 'Priya');
  const regular = await b.addGamePlayer(game.id, { customerId: member.customerId, name: member.name, email: member.email, people: 1, weekly: true });
  const regularMail = (b.state.outbox || []).filter((e) => e.kind === 'regular').pop();
  const invited = await b.addGamePlayer(game.id, { name: 'Wren Example', email: 'wren@example.com', people: 1, weekly: true });
  const inviteMail = (b.state.outbox || []).filter((e) => e.kind === 'seat-confirmation' && e.to === 'wren@example.com').pop();
  const regularSeat = b.state.bookings.find((x) => x.id === regular.booking.id);
  return {
    game: { start: game.start }, regularLines: Object.fromEntries(regularMail.lines), inviteLines: Object.fromEntries(inviteMail.lines),
    want: { onTab: TAB.onTab, onTabGuest: TAB.onTabGuest, cancelByGuest: TAB.cancelByGuest(game.start - 24 * 3600000) },
    regularLock: b.bookingLockView(regularSeat), joinedThen: regularSeat.joinedThen === true, invitedRef: invited.booking.ref,
  };
});
check('staff make a member a regular: "You\'re a regular" keeps its intro and says it\'s on the tab, cancelled up to 24 hours before', /saved your seat at .+ every/.test(out.regularLines.Intro || '')
  && out.regularLines.Paying === out.want.onTab && /at least 24 hours before it starts\. After that it stays on your tab/.test(out.regularLines.Cancelling || ''), out.regularLines);
check('…their seat is joinedThen, locked 24 hours before like any seat', out.joinedThen && out.regularLock.cancelUntil === out.game.start - 24 * 3600000 && out.regularLock.locked === false, out.regularLock);
check('a reserved weekly seat for someone with no account: no ticket, pay on the day, let us know by, then the account invite', !('Ticket' in out.inviteLines) && out.inviteLines.Paying === out.want.onTabGuest
  && out.inviteLines.Cancelling === out.want.cancelByGuest && /It's a weekly game: make your Dice Goblin account with this email/.test(out.inviteLines['Your account'] || ''), out.inviteLines);
check('…and no code anywhere in it', !JSON.stringify(out.inviteLines).includes(out.invitedRef), out.inviteLines);

/* a walk-in and a GM's own table never owed; a table that ends unpaid with a no-show is */
const owed = await page.evaluate(async () => {
  const b = window.Lair.store.backend;
  const now = Date.now();
  const gm = b.state.bookings.find((x) => x.kind === 'gm' && x.end < now + 48 * 3600000 && x.end > now);
  const walk = b.state.bookings.find((x) => x.kind === 'walkin');
  const table = b.state.bookings.find((x) => x.kind === 'table' && !x.paid && x.customerId && x.start > now && x.end < now + 24 * 3600000 && x.status === 'confirmed');
  const later = Math.max(gm.end, walk.end, table.end) + 60000;
  window.__setNow(later);
  await b.updateBooking(table.id, { status: 'noshow' });
  const r = { gm: b.isOwed(gm), walk: b.isOwed(walk), table: b.isOwed(b.state.bookings.find((x) => x.id === table.id)), tableOwner: table.customerId, tableId: table.id };
  const rows = b.owedRows(table.customerId).map((x) => [x.id, x.owed]);
  return { ...r, rows };
});
check('a GM\'s own table and a walk-in are never owed', owed.gm === false && owed.walk === false, owed);
check('a member\'s table that ended unpaid, marked a no-show, is owed and on their owed rows', owed.table === true && owed.rows.some(([id, o]) => id === owed.tableId && o === true), owed);

/* the check-in answer's sign-up carries the lock, owed and waived */
const ci = await page.evaluate(async () => {
  const b = window.Lair.store.backend;
  const j = (b.state.joins || []).find((x) => x.status === 'confirmed');
  if (!j) return null;
  const r = await b.checkin({ id: j.id, type: 'join', force: true });
  return r.join;
});
check('the check-in answer\'s sign-up has cancelUntil, locked, owed and waived', ci && 'cancelUntil' in ci && 'locked' in ci && 'owed' in ci && 'waived' in ci, ci);

console.log(`errors: ${errors.join(' | ') || 'none'}`);
console.log(`${pass} passed, ${fail} failed`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

// Round 15 checks for assets/lair-demo.js, part b: owed sign-ups, waiving one, POST /members/:id/paid (markTabPaid),
// leaving a weekly game with a locked seat, a seat Gobgob saved late, and the outbox's words.
// Usage: DG_THEME=/path/to/theme PORT=4964 node tools/qa/round15/demo-b.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4964);
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
const H = 3600000;
const W = {
  locked: "It's less than 24 hours away, so it can't be cancelled online now: it stays on your tab. Have a chat with us at the counter or give us a call, and we'll sort it out.",
  pickSome: "Tick what they're paying for.",
  notTheirs: "One of those isn't on their tab any more. Refresh their page and try again.",
  nothingDue: 'Nothing is left to pay on what you ticked.',
};

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
const run = (fn, arg) => page.evaluate(fn, arg);
await run(() => {
  const b = window.Lair.store.backend;
  window.__ruby = b.cfg.customer;
  window.__as = async (who, fn) => {
    const before = b.cfg.customer;
    b.cfg.customer = who === 'staff' ? { id: 'demo-staff-1', name: 'Staff', fullName: 'Staff Member', email: 'staff@example.com', staff: true }
      : who === 'nobody' ? null : who === 'ruby' ? window.__ruby : who;
    try {
      return await fn(b);
    } catch (error) {
      return { error: error.message, status: error.status };
    } finally {
      b.cfg.customer = before;
    }
  };
});
const rubyId = String(RUBY.id);

/* sign-ups and a game table for Ruby, more than 24 hours away */
const setup = await run(async () => {
  const b = window.Lair.store.backend;
  const now = Date.now();
  const paid = b.occurrences().filter((o) => o.capacity && o.entryFee && o.startMs > now + 30 * 3600000).sort((x, y) => x.startMs - y.startMs);
  const spots = b.occurrences().filter((o) => o.gameTables && o.startMs > now + 30 * 3600000).sort((x, y) => x.startMs - y.startMs);
  return { a: paid[0] && { id: paid[0].id, start: paid[0].startMs, end: paid[0].endMs }, c: paid[1] && { id: paid[1].id, start: paid[1].startMs, end: paid[1].endMs }, spot: spots[0] && { id: spots[0].id, start: spots[0].startMs, end: spots[0].endMs } };
});
check('setup: two paid dates and a game-table date', setup.a && setup.c && setup.spot, setup);
const join = (id) => run((x) => window.__as('ruby', (b) => b.joinEvent(x, { name: 'Ruby Tane', email: 'ruby@example.com', phone: '021 555 0100', people: 1 })), id);
const A = (await join(setup.a.id)).join;
const C = (await join(setup.c.id)).join;
const B = (await run((x) => window.__as('ruby', (b) => b.reserveEvent(x, { name: 'Ruby Tane', email: 'ruby@example.com', phone: '021 555 0100', people: 2 })), setup.spot.id)).booking;
check('Ruby has two sign-ups and a game table', A && C && B && A.due > 0 && C.due > 0 && B.due > 0, { A, B, C });

/* markTabPaid: the checks and words, then two at once */
const someoneElse = await run(() => window.Lair.store.backend.state.bookings.find((x) => x.customerId && String(x.customerId) !== '7700112233' && x.kind !== 'gm' && x.status !== 'cancelled').id);
const notStaff = await run((x) => window.__as('ruby', (b) => b.markTabPaid(x.id, [{ type: 'join', id: x.A }])), { id: rubyId, A: A.id });
check('markTabPaid as a member: 403 staff only', notStaff.status === 403 && notStaff.error === 'Staff only. Log in with your staff account.', notStaff);
const empty = await run((id) => window.__as('staff', (b) => b.markTabPaid(id, [])), rubyId);
check('markTabPaid nothing ticked: 422 pickSome', empty.status === 422 && empty.error === W.pickSome, empty);
const theirs = await run((x) => window.__as('staff', (b) => b.markTabPaid(x.id, [{ type: 'join', id: x.A }, { type: 'booking', id: x.other }])), { id: rubyId, A: A.id, other: someoneElse });
check('markTabPaid someone else\'s: 409 notTheirs, nothing paid', theirs.status === 409 && theirs.error === W.notTheirs, theirs);
const asJoin = await run((x) => window.__as('staff', (b) => b.markTabPaid(x.id, [{ type: 'join', id: x.B }])), { id: rubyId, B: B.id });
check('markTabPaid a booking named as a sign-up: 409 notTheirs', asJoin.status === 409 && asJoin.error === W.notTheirs, asJoin);
const stillDue = await run((x) => window.__as('ruby', async (b) => (await b.me()).joins.find((j) => j.id === x).due), A.id);
check('…and A is still due', stillDue === A.due, stillDue);
const paidTwo = await run((x) => window.__as('staff', (b) => b.markTabPaid(x.id, [{ type: 'join', id: x.A }, { type: 'booking', id: x.B }])), { id: rubyId, A: A.id, B: B.id });
check('markTabPaid two at once: paid list, total and the staff account', paidTwo.paid && paidTwo.paid.length === 2 && paidTwo.paid[0].type === 'join' && paidTwo.paid[0].id === A.id && paidTwo.paid[0].ref === A.ref
  && paidTwo.paid[0].amount === A.due && paidTwo.paid[1].type === 'booking' && paidTwo.paid[1].amount === B.due && paidTwo.total === A.due + B.due
  && paidTwo.account && Array.isArray(paidTwo.account.bills), paidTwo);
const settled = paidTwo.account ? paidTwo.account.comingUp.items.filter((i) => [A.id, B.id].includes(i.id)).map((i) => [i.amount, i.settle]) : null;
check('…the staff account shows them paid', JSON.stringify(settled) === JSON.stringify([[0, 'paid'], [0, 'paid']]), settled);
const again = await run((x) => window.__as('staff', (b) => b.markTabPaid(x.id, [{ type: 'join', id: x.A }, { type: 'booking', id: x.B }])), { id: rubyId, A: A.id, B: B.id });
check('markTabPaid again: 409 nothingDue', again.status === 409 && again.error === W.nothingDue, again);

/* C ends unpaid: owed (GET /me, the running tab, the staff card by member code) */
await run((ms) => window.__setNow(ms), setup.c.end + 30 * 60000);
const owedMe = await run(() => window.__as('ruby', (b) => b.me()));
const cDue = owedMe.dueNow.find((d) => d.id === C.id);
check('GET /me dueNow: the sign-up over and unpaid is owed', cDue && cDue.type === 'join' && cDue.owed === true && cDue.due === C.due, owedMe.dueNow);
const cJoin = owedMe.joins.find((j) => j.id === C.id);
check('GET /me joins[]: owed true, waived false, no lock once over', cJoin && cJoin.owed === true && cJoin.waived === false && cJoin.cancelUntil === null && cJoin.locked === false, cJoin);
const cTab = owedMe.account.owed.items.find((i) => i.id === C.id);
check('running tab owed: the sign-up is an owedRow, kind event', cTab && cTab.owedRow === true && cTab.kind === 'event' && cTab.amount === C.due, cTab);
const code = await run(() => window.Lair.store.backend.memberFor(window.__ruby).code);
const card = await run((x) => window.__as('staff', (b) => b.checkin({ code: x })), code);
const cRow = card.rows && card.rows.find((r) => r.id === C.id);
check('staff check-in by member code lists the owed sign-up once (type join, owed)', cRow && cRow.type === 'join' && cRow.owed === true && card.rows.filter((r) => r.id === C.id).length === 1 && card.due >= C.due && /They owe/.test(card.message), { rows: card.rows && card.rows.map((r) => [r.type, r.id, r.owed]), message: card.message });

/* waive it through POST /bookings/:id/update with the sign-up's id (staff), then put it back and mark it paid */
const byMember = await run((x) => window.__as('ruby', (b) => b.updateBooking(x, { waived: true })), C.id);
check('a member waiving a sign-up: 404 Booking not found.', byMember.status === 404 && byMember.error === 'Booking not found.', byMember);
const waived = await run((x) => window.__as('staff', (b) => b.updateBooking(x, { waived: true })), C.id);
check('staff waive a sign-up: waived, nothing due, not owed', waived.join && waived.join.waived === true && waived.join.due === 0 && waived.join.owed === false, waived);
const afterWaive = await run(() => window.__as('ruby', (b) => b.me()));
check('…GET /me dueNow and the tab no longer list it', !afterWaive.dueNow.some((d) => d.id === C.id) && !afterWaive.account.owed.items.some((i) => i.id === C.id), afterWaive.dueNow);
const back = await run((x) => window.__as('staff', (b) => b.updateBooking(x, { waived: false })), C.id);
check('…put back: owed again', back.join && back.join.waived === false && back.join.owed === true, back);
const markPaid = await run((x) => window.__as('staff', (b) => b.updateBooking(x, { paid: true })), C.id);
check('…Mark paid on the sign-up: paid, not owed', markPaid.join && markPaid.join.paid === true && markPaid.join.due === 0 && markPaid.join.owed === false, markPaid);

/* leaving a weekly game: the seat inside the 24 hours stays (on the tab), the later one is freed */
await run((ms) => window.__setNow(ms), AT);
const blades = await run(() => {
  const b = window.Lair.store.backend;
  const sessions = b.state.games.filter((g) => g.title.startsWith('Blades in the Dark') && g.seriesId && g.status === 'open').sort((x, y) => x.start - y.start);
  return sessions.slice(0, 2).map((g) => ({ id: g.id, start: g.start, end: g.end, seriesId: g.seriesId }));
});
check('setup: two sessions of the fortnightly Blades game', blades.length === 2, blades);
await run((ms) => window.__setNow(ms), blades[0].start - 10 * H);
const joinedSeries = await run((id) => window.__as('ruby', (b) => b.joinSeries(id, { name: 'Ruby Tane', email: 'ruby@example.com', phone: '021 555 0100', people: 1 })), blades[0].id);
check('join the weekly game 10 hours before its next session: a seat booked', joinedSeries.booked && joinedSeries.booked.length === 1, joinedSeries);
const seatNow = await run((x) => window.__as('ruby', async (b) => (await b.me()).seats.find((s) => s.gameId === x && s.status === 'confirmed')), blades[0].id);
check('the seat joining booked is locked at once (their own choice)', seatNow && seatNow.locked === true && seatNow.cancelUntil === blades[0].start - 24 * H, seatNow);
const skip = await run((id) => window.__as('ruby', (b) => b.updateBooking(id, { status: 'cancelled' })), seatNow.id);
check('…skipping it: 409 locked', skip.status === 409 && skip.error === W.locked, skip);
const later = await run((x) => window.__as('staff', (b) => b.addGamePlayer(x, { customerId: '7700112233', name: 'Ruby Tane', email: 'ruby@example.com', people: 1, weekly: true })), blades[1].id);
check('staff save Ruby a seat in the session after (weekly)', later.booking && later.booking.seriesId === blades[1].seriesId, later);
const left = await run((s) => window.__as('ruby', (b) => b.leaveSeries(s)), blades[0].seriesId);
const when = await run((x) => window.Lair.store.backend.appWhen(x), blades[0]);
check('leaveSeries: { ok, cancelled: 1, kept: [the locked seat], notice }', left.ok === true && left.cancelled === 1 && left.kept && left.kept.length === 1 && left.kept[0].id === seatNow.id
  && left.kept[0].ref === seatNow.ref && left.kept[0].start === blades[0].start && left.kept[0].end === blades[0].end
  && left.notice === `Your seat on ${when} is less than 24 hours away, so it stays on your tab. Have a chat with us if you can't make it.`, left);
const afterLeave = await run((x) => window.__as('ruby', async (b) => {
  const me = await b.me();
  return { seats: me.seats.filter((s) => x.includes(s.gameId) && s.pay !== 'now').map((s) => [s.gameId, s.status, s.locked]), series: me.series.filter((r) => r.title.startsWith('Blades')).length };
}), blades.map((g) => g.id));
check('…the kept seat stays confirmed and locked, the later one is cancelled, no longer a regular', JSON.stringify(afterLeave) === JSON.stringify({ seats: [[blades[0].id, 'confirmed', true], [blades[1].id, 'cancelled', false]], series: 0 }), afterLeave);
const gmMail = await run(() => (window.Lair.store.backend.state.outbox || []).filter((e) => e.kind === 'player-left').pop());
check('…the GM hears which seat stays (outbox)', gmMail && Object.fromEntries(gmMail.lines)['Seat kept'] === when && Object.fromEntries(gmMail.lines)['Sessions freed'] === '1', gmMail);

/* a regular's seat Gobgob saved inside the 24 hours can be cancelled until it starts; one saved earlier is locked */
const rules = await run(() => {
  const b = window.Lair.store.backend;
  const now = Date.now();
  const seat = { kind: 'gm-seat', seriesId: 'sr-x', member: 'sm-x', start: now + 5 * 3600000, end: now + 8 * 3600000, amount: 1500, pay: 'day', status: 'confirmed' };
  const r = (x) => b.cancelRule(b.bookingItem(x), now);
  return {
    late: r({ ...seat, createdAt: now }), early: r({ ...seat, createdAt: now - 30 * 3600000 }), joined: r({ ...seat, createdAt: now, joinedThen: true }),
    oneOff: r({ ...seat, seriesId: null, member: null, createdAt: now }), free: b.cancelRule(b.joinItem({ status: 'confirmed', pay: 'day', amount: 0, createdAt: now }, { startMs: seat.start, endMs: seat.end }), now),
    online: r({ ...seat, seriesId: null, member: null, pay: 'now', paid: true, createdAt: now }), start: seat.start,
  };
});
check('cancelRule: a regular\'s seat saved late: cancel until it starts', rules.late.lockable === false && rules.late.cancelUntil === rules.start && rules.late.locked === false, rules.late);
check('cancelRule: a regular\'s seat saved earlier: locked 24 hours before', rules.early.lockable === true && rules.early.locked === true && rules.early.cancelUntil === rules.start - 24 * H, rules.early);
check('cancelRule: the seat joining booked (joinedThen): locked', rules.joined.lockable === true && rules.joined.locked === true, rules.joined);
check('cancelRule: a one-off seat booked inside the 24 hours: locked at once', rules.oneOff.locked === true, rules.oneOff);
check('cancelRule: a free one and one paid online before round 15: not locked', rules.free.lockable === false && rules.online.lockable === false && rules.free.cancelUntil === rules.start, { free: rules.free, online: rules.online });

/* the outbox's words: a seat's confirmation, as a member and as a guest */
await run((ms) => window.__setNow(ms), AT);
const mail = await run(async () => {
  const b = window.Lair.store.backend;
  const now = Date.now();
  const game = b.state.games.filter((g) => !g.seriesId && g.status === 'open' && g.start > now + 30 * 3600000 && g.seats - g.taken >= 2).sort((x, y) => x.start - y.start)[0];
  if (!game) return null;
  const member = await window.__as('ruby', (x) => x.joinGame({ gameId: game.id, people: 1, name: 'Ruby Tane', email: 'ruby@example.com', phone: '021 555 0100' }));
  const memberMail = (b.state.outbox || []).filter((e) => e.kind === 'seat-confirmation' && e.to === 'ruby@example.com').pop();
  const guest = await window.__as('nobody', (x) => x.joinGame({ gameId: game.id, people: 1, name: 'Hemi Guest', email: 'hemi.guest@example.com', phone: '021 555 0101' }));
  const guestMail = (b.state.outbox || []).filter((e) => e.kind === 'seat-confirmation' && e.to === 'hemi.guest@example.com').pop();
  const TAB = window.Lair.TAB;
  return {
    member, guest, memberLines: memberMail && Object.fromEntries(memberMail.lines), guestLines: guestMail && Object.fromEntries(guestMail.lines),
    want: { onTab: TAB.onTab, onTabGuest: TAB.onTabGuest, cancelBy: TAB.cancelBy(game.start - 24 * 3600000), cancelByGuest: TAB.cancelByGuest(game.start - 24 * 3600000) },
  };
});
check('a member\'s seat confirmation: no ticket code, on your tab, cancel by (the theme\'s words)', mail && mail.memberLines && !('Ticket' in mail.memberLines) && mail.memberLines.Paying === mail.want.onTab && mail.memberLines.Cancelling === mail.want.cancelBy, mail && mail.memberLines);
check('a guest\'s seat confirmation: pay on the day, let us know by', mail && mail.guestLines && !('Ticket' in mail.guestLines) && mail.guestLines.Paying === mail.want.onTabGuest && mail.guestLines.Cancelling === mail.want.cancelByGuest && !('Your account' in mail.guestLines), mail && mail.guestLines);
check('joinGame answers carry the lock', mail && mail.member.booking && mail.member.booking.cancelUntil > 0 && mail.member.booking.locked === false, mail && mail.member);
const outboxCodes = await run(() => (window.Lair.store.backend.state.outbox || []).filter((e) => e.kind === 'seat-confirmation').some((e) => JSON.stringify(e.lines).includes('Show your code') || e.lines.some(([k]) => k === 'Ticket')));
check('no seat confirmation in the outbox shows a code', outboxCodes === false, outboxCodes);

/* the staff floor's sign-ups carry the lock, owed and waived */
const floorJoin = await run((x) => window.__as('staff', async (b) => (await b.floor()).joins.find((j) => j.id === x)), A.id);
check('floor joins: cancelUntil, locked, owed and waived', floorJoin && 'cancelUntil' in floorJoin && 'locked' in floorJoin && floorJoin.owed === false && floorJoin.waived === false, floorJoin);

console.log(`errors: ${errors.join(' | ') || 'none'}`);
console.log(`${pass} passed, ${fail} failed`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

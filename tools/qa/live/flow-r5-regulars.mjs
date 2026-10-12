// Round 5 (b), part 2, after r5-travel.py moved the weekly game (and the one-off) a week earlier: the first session
// ended with the four regulars' seats unpaid, and the one-off ended with Sam's seat unpaid. Maintenance rolls the
// regulars into the next session; an unpaid series seat whose session has ended is owed (My Lair's dueNow, the POS
// member scan, staff check-in by member code, GET /members?owing=1) until it's paid or waived. Round 15 (contract
// v15-tab): so is a one-off seat booked from round 15's first start that ended unpaid, no-show or not (before round 15
// a one-off unpaid no-show never was; the unit tests keep that rule for what was booked before).
import fs from 'node:fs';
import { proxy, pos, check, summary, WORKER } from './client.mjs';

const R = JSON.parse(fs.readFileSync(new URL('./r5-regulars.json', import.meta.url)));
const [s1, s2, s3] = R.sessions;
const NAMES = { 7101: 'Sam Jones', 7102: 'Kiri Smith', 7104: 'Leo Tane', 7106: 'Tui Harper' };
const seriesSeats = async (id) => ((await proxy('GET', 'me', { customer: id })).data.seats || []).filter((x) => x.seriesId === R.seriesId && x.status !== 'cancelled');
const maintenance = async () => fetch(`${WORKER}/setup?key=test-setup-key`).then((r) => r.json());
const memberRow = async (q, id) => ((await proxy('GET', `members?q=${encodeURIComponent(q)}`, { customer: '7001' })).data || []).find((m) => m.customerId === id) || null;

/* 1. After the first session ended: maintenance gives every regular a seat in the next one */
const before = await seriesSeats('7101');
check('(the first session has ended: a week has passed)', before.find((x) => x.gameId === s1)?.end < Date.now() && !before.some((x) => x.gameId === s2), before.map((x) => [x.gameId, x.end]));
const run1 = await maintenance();
check('maintenance seats the four regulars in the next session', run1.regulars?.seated === 4 && !run1.regulars.full, run1.regulars || run1);
for (const [id, name] of Object.entries(NAMES)) {
  const seats = await seriesSeats(id);
  const next = seats.find((x) => x.gameId === s2);
  check(`${name}: the ended session's seat, a seat in the next session (member code as the ticket), none later`, seats.length === 2 && seats.some((x) => x.id === R.seats[id]) && next && next.status === 'confirmed' && next.ticketCode === R.codes[id] && !seats.some((x) => x.gameId === s3), seats.map((x) => [x.gameId, x.status]));
}
const run2 = await maintenance();
check('maintenance again books nothing twice', !run2.regulars && (await seriesSeats('7101')).length === 2, run2.regulars);

/* 2. Sam's ended seat is owed; round 15: so is the one-off */
const sam = (await proxy('GET', 'me', { customer: '7101' })).data;
const owedSeat = sam.seats.find((x) => x.id === R.seats['7101']);
check('the ended, unpaid series seat is owed, $15 still due', owedSeat?.owed === true && owedSeat.due === 1500 && owedSeat.end < Date.now() && !owedSeat.waived, owedSeat && { owed: owedSeat.owed, due: owedSeat.due, status: owedSeat.status });
const oneOff = sam.seats.find((x) => x.id === R.oneOffSeat);
check('round 15: the one-off seat that ended unpaid is owed too, $15 still due', oneOff && oneOff.owed === true && oneOff.due === 1500 && oneOff.end < Date.now(), oneOff && { owed: oneOff.owed, due: oneOff.due, status: oneOff.status });
const dueOwed = (sam.dueNow || []).filter((x) => x.owed);
const both = [R.seats['7101'], R.oneOffSeat].sort();
check('GET /me dueNow lists both, owed, $15 each, the series seat with the game\'s title', dueOwed.length === 2 && JSON.stringify(dueOwed.map((x) => x.id).sort()) === JSON.stringify(both) && dueOwed.every((x) => x.due === 1500 && x.type === 'booking') && dueOwed.find((x) => x.id === R.seats['7101'])?.title.includes(R.title), sam.dueNow);
const nextSeat = sam.seats.find((x) => x.gameId === s2);
check('the next session\'s seat isn\'t owed, and isn\'t due now', nextSeat && !nextSeat.owed && !(sam.dueNow || []).some((x) => x.id === nextSeat.id), nextSeat && { owed: nextSeat.owed });

/* 3. The POS member scan and staff check-in by member code */
const scan = await pos('POST', 'scan', { code: R.codes['7101'] });
const scanned = scan.data.rows || [];
const sOwed = scanned.filter((r) => r.owed);
check('POS member scan: the two owed seats come after today\'s rows, not checked in', scan.status === 200 && scan.data.type === 'member' && sOwed.length === 2 && JSON.stringify(sOwed.map((r) => r.id).sort()) === JSON.stringify(both) && sOwed.every((r) => r.due === 1500 && !r.arrivedAt) && scanned.slice(-2).every((r) => r.owed), scanned.map((r) => [r.ref, r.owed, r.due]));
const card = await proxy('POST', 'checkin', { customer: '7001', body: { code: R.codes['7101'] } });
check('staff check-in by member code: the owed seats after today\'s rows, and the message says what they owe', card.status === 200 && card.data.kind === 'member' && (card.data.rows || []).slice(-2).every((r) => r.owed === true) && /They owe \$30(\.00)? from 2 earlier sessions\./.test(card.data.message || ''), card.data.message || card.data.error);

/* 4. GET /members?owing=1 (round 15: it counts what My Lair and the POS do) */
const owing = (await proxy('GET', 'members?owing=1', { customer: '7001' })).data || [];
const samRow = owing.find((m) => m.customerId === '7101');
check('GET /members?owing=1 lists Sam: $30 owed for 2 sessions', samRow && samRow.owed === 3000 && samRow.owedCount === 2, samRow && { owed: samRow.owed, owedCount: samRow.owedCount, openTab: samRow.openTab });
check('and every other regular, $15 each', ['7102', '7104', '7106'].every((id) => owing.find((m) => m.customerId === id)?.owed === 1500), owing.map((m) => [m.customerId, m.owed, m.openTab]));
check('everyone it lists owes something', owing.length > 0 && owing.every((m) => m.owed + m.openTab > 0));

/* 5. Round 15: a no-show at the one-off is still owed */
const ns = await proxy('POST', `bookings/${R.oneOffSeat}/update`, { customer: '7001', body: { status: 'noshow' } });
check('staff mark Sam a no-show at the one-off: still owed', ns.status === 200 && ns.data.booking?.status === 'noshow' && ns.data.booking.owed === true, ns.data.error || ns.data.booking && { status: ns.data.booking.status, owed: ns.data.booking.owed });
const samOwes = await memberRow(R.codes['7101'], '7101');
check('Sam still owes both: $30, 2 sessions', samOwes && samOwes.owed === 3000 && samOwes.owedCount === 2, samOwes && { owed: samOwes.owed, owedCount: samOwes.owedCount });

/* 6. Waiving clears each */
const notMine = await proxy('POST', `bookings/${R.seats['7101']}/update`, { customer: '7101', body: { waived: true } });
check('Sam can\'t waive it himself (403)', notMine.status === 403, notMine.data);
const w = await proxy('POST', `bookings/${R.seats['7101']}/update`, { customer: '7001', body: { waived: true } });
check('staff waive the series seat: waived, nothing due, not owed', w.status === 200 && w.data.booking?.waived === true && w.data.booking.due === 0 && w.data.booking.owed === false, w.data.error || w.data.booking && { waived: w.data.booking.waived, due: w.data.booking.due, owed: w.data.booking.owed });
const samAfter = (await proxy('GET', 'me', { customer: '7101' })).data;
const waivedSeat = samAfter.seats.find((x) => x.id === R.seats['7101']);
check('My Lair: the series seat no longer owed or due now, marked waived; the one-off still owed', waivedSeat && waivedSeat.waived === true && waivedSeat.owed === false && waivedSeat.due === 0 && JSON.stringify((samAfter.dueNow || []).filter((x) => x.owed).map((x) => x.id)) === JSON.stringify([R.oneOffSeat]), waivedSeat && { waived: waivedSeat.waived, owed: waivedSeat.owed, due: waivedSeat.due, dueNow: samAfter.dueNow });
const scanAfter = await pos('POST', 'scan', { code: R.codes['7101'] });
check('the POS member scan has the one-off\'s owed row only', scanAfter.status === 200 && JSON.stringify((scanAfter.data.rows || []).filter((r) => r.owed).map((r) => r.id)) === JSON.stringify([R.oneOffSeat]), (scanAfter.data.rows || []).map((r) => [r.ref, r.owed]));
const w2 = await proxy('POST', `bookings/${R.oneOffSeat}/update`, { customer: '7001', body: { waived: true } });
check('staff waive the one-off too', w2.status === 200 && w2.data.booking?.waived === true && w2.data.booking.owed === false, w2.data.error || w2.data.booking?.owed);
const scanClear = await pos('POST', 'scan', { code: R.codes['7101'] });
check('the POS member scan has no owed rows now', scanClear.status === 200 && !(scanClear.data.rows || []).some((r) => r.owed), (scanClear.data.rows || []).map((r) => [r.ref, r.owed]));
const samClear = await memberRow(R.codes['7101'], '7101');
check('the Members view: Sam owes nothing', samClear && samClear.owed === 0 && samClear.owedCount === 0, samClear && { owed: samClear.owed, owedCount: samClear.owedCount });
const owingAfter = (await proxy('GET', 'members?owing=1', { customer: '7001' })).data || [];
check('owing=1 drops Sam (unless he has an open tab)', !owingAfter.some((m) => m.customerId === '7101' && m.openTab === 0), owingAfter.map((m) => [m.customerId, m.owed, m.openTab]));

process.exit(summary() ? 1 : 0);

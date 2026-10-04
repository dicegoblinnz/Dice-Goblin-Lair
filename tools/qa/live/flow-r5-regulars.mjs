// Round 5 (b), part 2, after r5-travel.py moved the weekly game (and the one-off) a week earlier: the first session
// ended with the four regulars' seats unpaid, and the one-off ended with Sam's seat unpaid. Maintenance rolls the
// regulars into the next session; an unpaid series seat whose session has ended is owed (My Lair's dueNow, the POS
// member scan, staff check-in by member code, GET /members?owing=1) until it's paid or waived; a one-off unpaid
// no-show never is.
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

/* 2. Sam's ended seat is owed; the one-off isn't */
const sam = (await proxy('GET', 'me', { customer: '7101' })).data;
const owedSeat = sam.seats.find((x) => x.id === R.seats['7101']);
check('the ended, unpaid series seat is owed, $15 still due', owedSeat?.owed === true && owedSeat.due === 1500 && owedSeat.end < Date.now() && !owedSeat.waived, owedSeat && { owed: owedSeat.owed, due: owedSeat.due, status: owedSeat.status });
const dueOwed = (sam.dueNow || []).filter((x) => x.owed);
check('GET /me dueNow lists it, owed, with the game\'s title', dueOwed.length === 1 && dueOwed[0].id === R.seats['7101'] && dueOwed[0].due === 1500 && dueOwed[0].type === 'booking' && dueOwed[0].title.includes(R.title), sam.dueNow);
const nextSeat = sam.seats.find((x) => x.gameId === s2);
check('the next session\'s seat isn\'t owed, and isn\'t due now', nextSeat && !nextSeat.owed && !(sam.dueNow || []).some((x) => x.id === nextSeat.id), nextSeat && { owed: nextSeat.owed });
const oneOff = sam.seats.find((x) => x.id === R.oneOffSeat);
check('the one-off seat that ended unpaid isn\'t owed and isn\'t on dueNow', oneOff && oneOff.owed === false && oneOff.end < Date.now() && !(sam.dueNow || []).some((x) => x.id === R.oneOffSeat), oneOff && { owed: oneOff.owed, status: oneOff.status });

/* 3. The POS member scan and staff check-in by member code */
const scan = await pos('POST', 'scan', { code: R.codes['7101'] });
const scanned = scan.data.rows || [];
const sOwed = scanned.filter((r) => r.owed);
check('POS member scan: the owed seat comes after today\'s rows, not checked in', scan.status === 200 && scan.data.type === 'member' && sOwed.length === 1 && sOwed[0].id === R.seats['7101'] && sOwed[0].due === 1500 && !sOwed[0].arrivedAt && scanned.at(-1)?.id === R.seats['7101'], scanned.map((r) => [r.ref, r.owed, r.due]));
check('POS member scan: the one-off isn\'t on it', !scanned.some((r) => r.id === R.oneOffSeat));
const card = await proxy('POST', 'checkin', { customer: '7001', body: { code: R.codes['7101'] } });
check('staff check-in by member code: the owed seat after today\'s rows, and the message says what they owe', card.status === 200 && card.data.kind === 'member' && card.data.rows?.at(-1)?.id === R.seats['7101'] && card.data.rows.at(-1).owed === true && /They owe \$15(\.00)? from 1 earlier session\./.test(card.data.message || ''), card.data.message || card.data.error);

/* 4. GET /members?owing=1 */
const owing = (await proxy('GET', 'members?owing=1', { customer: '7001' })).data || [];
const samRow = owing.find((m) => m.customerId === '7101');
check('GET /members?owing=1 lists Sam: $15 owed for 1 session', samRow && samRow.owed === 1500 && samRow.owedCount === 1, samRow && { owed: samRow.owed, owedCount: samRow.owedCount, openTab: samRow.openTab });
check('and every other regular, $15 each', ['7102', '7104', '7106'].every((id) => owing.find((m) => m.customerId === id)?.owed === 1500), owing.map((m) => [m.customerId, m.owed, m.openTab]));
check('everyone it lists owes something', owing.length > 0 && owing.every((m) => m.owed + m.openTab > 0));

/* 5. A one-off unpaid no-show is never owed */
const ns = await proxy('POST', `bookings/${R.oneOffSeat}/update`, { customer: '7001', body: { status: 'noshow' } });
check('staff mark Sam a no-show at the one-off', ns.status === 200 && ns.data.booking?.status === 'noshow' && ns.data.booking.owed === false, ns.data.error || ns.data.booking?.status);
const samOwes = await memberRow(R.codes['7101'], '7101');
check('Sam still owes only the series seat: $15, 1 session', samOwes && samOwes.owed === 1500 && samOwes.owedCount === 1, samOwes && { owed: samOwes.owed, owedCount: samOwes.owedCount });

/* 6. Waiving clears it */
const notMine = await proxy('POST', `bookings/${R.seats['7101']}/update`, { customer: '7101', body: { waived: true } });
check('Sam can\'t waive it himself (403)', notMine.status === 403, notMine.data);
const w = await proxy('POST', `bookings/${R.seats['7101']}/update`, { customer: '7001', body: { waived: true } });
check('staff waive it: waived, nothing due, not owed', w.status === 200 && w.data.booking?.waived === true && w.data.booking.due === 0 && w.data.booking.owed === false, w.data.error || w.data.booking && { waived: w.data.booking.waived, due: w.data.booking.due, owed: w.data.booking.owed });
const samAfter = (await proxy('GET', 'me', { customer: '7101' })).data;
const waivedSeat = samAfter.seats.find((x) => x.id === R.seats['7101']);
check('My Lair: no longer owed or due now, marked waived', waivedSeat && waivedSeat.waived === true && waivedSeat.owed === false && waivedSeat.due === 0 && !(samAfter.dueNow || []).some((x) => x.owed), waivedSeat && { waived: waivedSeat.waived, owed: waivedSeat.owed, due: waivedSeat.due });
const scanAfter = await pos('POST', 'scan', { code: R.codes['7101'] });
check('the POS member scan has no owed rows now', scanAfter.status === 200 && !(scanAfter.data.rows || []).some((r) => r.owed), (scanAfter.data.rows || []).map((r) => [r.ref, r.owed]));
const samClear = await memberRow(R.codes['7101'], '7101');
check('the Members view: Sam owes nothing', samClear && samClear.owed === 0 && samClear.owedCount === 0, samClear && { owed: samClear.owed, owedCount: samClear.owedCount });
const owingAfter = (await proxy('GET', 'members?owing=1', { customer: '7001' })).data || [];
check('owing=1 drops Sam (unless he has an open tab)', !owingAfter.some((m) => m.customerId === '7101' && m.openTab === 0), owingAfter.map((m) => [m.customerId, m.owed, m.openTab]));

process.exit(summary() ? 1 : 0);

// Round 5 (b), part 1: weekly regulars. Ana lists a weekly game two days out (P3+P4, 6-9pm, $5 GM fee, 6 seats) and a
// one-off the day after; Sam, Kiri, Leo and Tui save their seat every week; Sam also books a seat at the one-off.
// Joining books the next session only, and the seats of the session after are held for the regulars.
// Then run-all.sh stops wrangler and r5-travel.py moves these games a week earlier, so the first session (and the
// one-off) has ended unpaid, and flow-r5-regulars.mjs carries on from r5-regulars.json.
import fs from 'node:fs';
import { proxy, check, summary } from './client.mjs';

const tz = 'Pacific/Auckland';
const key = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (k, n) => new Date(Date.parse(`${k}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** A Lair date and hour as a timestamp, with Auckland's offset on that day */
const at = (k, h) => {
  const guess = Date.parse(`${k}T${String(h).padStart(2, '0')}:00:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  return guess - (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - guess);
};
const today = key(Date.now());
const D = addDays(today, 2); // the weekly game's first session
const D2 = addDays(today, 3); // the one-off
const TITLE = 'Waterdeep: Dragon Heist (r5)';
const ONE_OFF = 'Mothership one-shot (r5)';
const REGULARS = { 7101: ['Sam Jones', 'sam@example.com'], 7102: ['Kiri Smith', 'kiri@example.com'], 7104: ['Leo Tane', 'leo@example.com'], 7106: ['Tui Harper', 'tui@example.com'] };
const out = { D, D2, title: TITLE, oneOffTitle: ONE_OFF, seats: {}, refs: {}, codes: {} };

// an earlier run's games: cancel them so the tables are free again
for (const old of (await proxy('GET', 'me', { customer: '7103' })).data.games || []) {
  if ([TITLE, ONE_OFF].includes(old.title) && old.status !== 'cancelled') {
    await proxy('POST', `games/${old.id}/update`, { customer: '7103', body: { status: 'cancelled', scope: old.seriesId ? 'series' : 'session' } });
  }
}

const listed = await proxy('POST', 'games', {
  customer: '7103',
  body: { title: TITLE, system: 'D&D 5e', gm: 'Ana', email: 'ana@example.com', blurb: 'Heists, fireballs and a vault full of dragons.', seats: 6, level: 'some', age: '13+', tables: ['P3', 'P4'], start: at(D, 18), end: at(D, 21), schedule: 'weekly', gmFee: 500, characters: 'pregens' },
});
const sessions = (listed.data.sessions || []).map((s) => s.id);
check('Ana lists a weekly game two days out: live, a session every week', listed.status === 200 && !listed.data.pending && listed.data.game?.seriesId && sessions.length >= 4 && sessions[0] === listed.data.game.id, listed.data.error || sessions.length);
out.seriesId = listed.data.game?.seriesId;
out.sessions = sessions;
const one = await proxy('POST', 'games', {
  customer: '7103',
  body: { title: ONE_OFF, system: 'Mothership', gm: 'Ana', email: 'ana@example.com', blurb: 'Space horror in a rusty tug.', seats: 4, level: 'new', age: '13+', tables: ['P3', 'P4'], start: at(D2, 18), end: at(D2, 21), schedule: 'one-shot', gmFee: 500, characters: 'pregens' },
});
check('and a one-off the day after', one.status === 200 && one.data.game?.status === 'open' && !one.data.game.seriesId, one.data.error || one.data.game?.status);
out.oneOffId = one.data.game?.id;

/* Joining every session books the next session only; the member code is the ticket */
for (const [id, [name, email]] of Object.entries(REGULARS)) {
  const code = (await proxy('GET', `me?name=${encodeURIComponent(name)}`, { customer: id })).data.member?.code;
  out.codes[id] = code;
  const r = await proxy('POST', `games/${sessions[0]}/join-series`, { customer: id, body: { people: 1, players: [{ name, character: '' }], name, email } });
  check(`${name} saves a seat every week: a seat in the next session only, the member code is the ticket`, r.status === 200 && r.data.booked?.length === 1 && r.data.booked[0].gameId === sessions[0] && r.data.booked[0].ticketCode === code && !r.data.full?.length, r.data.error || r.data);
  const seats = ((await proxy('GET', 'me', { customer: id })).data.seats || []).filter((x) => x.seriesId === out.seriesId && x.status !== 'cancelled');
  check(`${name}: one seat, in the first session, none in the sessions after it`, seats.length === 1 && seats[0].gameId === sessions[0] && seats[0].ticketCode === code && seats[0].amount === 1500 && !seats[0].owed, seats.map((x) => [x.gameId, x.ref, x.ticketCode]));
  out.seats[id] = seats[0]?.id;
  out.refs[id] = seats[0]?.ref;
}

/* The seats of the session after are held for the four regulars (round 5, v5.1: taken counts them) */
const ana = (await proxy('GET', 'me', { customer: '7103' })).data.games || [];
const s1 = ana.find((g) => g.id === sessions[0]);
const s2 = ana.find((g) => g.id === sessions[1]);
check('the GM\'s view: first session 4 of 6 taken by the regulars\' seats, nothing held', s1 && s1.taken === 4 && s1.held === 0 && s1.series?.regulars === 4 && s1.nextOnly === true, s1 && { taken: s1.taken, held: s1.held, series: s1.series, nextOnly: s1.nextOnly });
check('the session after: nobody booked, 4 seats held for the regulars, so 4 taken', s2 && s2.held === 4 && s2.taken === 4 && s2.status === 'open' && s2.nextOnly === false, s2 && { taken: s2.taken, held: s2.held, status: s2.status });
const board = (await proxy('GET', 'floor')).data.games || [];
const onBoard = board.filter((g) => g.series?.id === out.seriesId);
check('the public games board shows the next session only', onBoard.length === 1 && onBoard[0].id === sessions[0] && onBoard[0].series.regulars === 4, onBoard.map((g) => g.id));

/* Sam books a seat at the one-off too (unpaid, at the counter) */
const seat = await proxy('POST', 'bookings', { customer: '7101', body: { kind: 'gm-seat', gameId: out.oneOffId, people: 1, name: 'Sam Jones', email: 'sam@example.com', players: [{ name: 'Sam', character: 'Ellen' }] } });
check('Sam books a seat at the one-off', seat.status === 200 && seat.data.booking?.status === 'confirmed' && !seat.data.booking.seriesId, seat.data.error || seat.data.booking?.ref);
out.oneOffSeat = seat.data.booking?.id;
out.oneOffRef = seat.data.booking?.ref;

fs.writeFileSync(new URL('./r5-regulars.json', import.meta.url), JSON.stringify(out, null, 2));
process.exit(summary() ? 1 : 0);

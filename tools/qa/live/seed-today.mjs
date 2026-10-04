// Today's bookings for the POS, staff page and My Lair flows, made through the signed app proxy like the theme does.
//   A  Sam (member, pass) books the $15 Fancy room for 4 at 5pm: the pass covers $10 a person, $5 each is left
//   A2 Sam books T13 for 2 at 8pm with the pass (the staff page switches and undoes passes on this one)
//   B  Kiri books T10 for 4 at 5pm and splits the bill: Sam and Leo pay shares at the counter
//   C  Leo joins tonight's D&D (6pm, $15, paid in store)
//   D  Ana (trusted GM) runs a game today at G1+G2, 6-9pm, $5 GM fee: Sam takes a seat with his pass, Leo without
//   E  a walk-in at T12, seated by staff
//   F  Sam's self-serve tab: two drinks and a snack
import fs from 'node:fs';
import { proxy, check, summary } from './client.mjs';

const tz = 'Pacific/Auckland';
const key = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const today = key(Date.now());
const offset = (() => {
  const d = new Date();
  const local = new Date(d.toLocaleString('en-US', { timeZone: tz }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return (local - utc) / 60000;
})();
const at = (h, m = 0) => Date.parse(`${today}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`) - offset * 60000;
const seed = JSON.parse(fs.readFileSync(new URL('./seed.json', import.meta.url)));
const out = { today };

const A = await proxy('POST', 'bookings', { customer: '7101', body: { kind: 'table', tables: ['F1'], start: at(17), end: at(19), people: 4, name: 'Sam Jones', email: 'sam@example.com', usePass: seed.samPass.code } });
check('A: Sam books the Fancy room for 4 with his pass', A.status === 200 && A.data.booking.pass?.code === seed.samPass.code && A.data.booking.amount === 6000, A.data.error || A.data.booking?.ref);
out.A = A.data.booking;
const A2 = await proxy('POST', 'bookings', { customer: '7101', body: { kind: 'table', tables: ['T13'], start: at(20), end: at(22), people: 2, name: 'Sam Jones', email: 'sam@example.com', usePass: seed.samPass.code } });
check('A2: Sam books T13 at 8pm with his pass', A2.status === 200 && A2.data.booking.pass?.code === seed.samPass.code, A2.data.error || A2.data.booking?.ref);
out.A2 = A2.data.booking;
const B = await proxy('POST', 'bookings', { customer: '7102', body: { kind: 'table', tables: ['T10'], start: at(17), end: at(20), people: 4, name: 'Kiri Smith', email: 'kiri@example.com', split: true } });
check('B: Kiri books T10 for 4 and splits the bill', B.status === 200 && B.data.booking.split === true && B.data.booking.amount === 4000, B.data.error || B.data.booking?.ref);
out.B = B.data.booking;
const C = await proxy('POST', `events/dnd-saturday-6pm@${today}/join`, { customer: '7104', body: { name: 'Leo Tane', email: 'leo@example.com', people: 1, pay: 'now' } });
check('C: Leo joins tonight\'s D&D (in store, so pay is ignored)', C.status === 200 && C.data.join?.status === 'confirmed' && !C.data.checkoutUrl && C.data.join.payment === 'store', C.data.error || JSON.stringify(C.data).slice(0, 200));
out.C = C.data.join;
const D = await proxy('POST', 'games', {
  customer: '7103',
  body: { title: 'Curse of Strahd', system: 'D&D 5e', gm: 'Ana', email: 'ana@example.com', blurb: 'Mists, wolves and a count who never sleeps.', seats: 4, level: 'some', age: '13+', tables: ['G1', 'G2'], start: at(18), end: at(21), schedule: 'one-shot', gmFee: 500, characters: 'pregens' },
});
check('D: Ana lists a game today (trusted GM, so it\'s open)', D.status === 200 && !D.data.pending && D.data.game?.status === 'open', D.data.error || JSON.stringify(D.data).slice(0, 200));
out.D = D.data.game;
if (D.data.game) {
  const seatSam = await proxy('POST', 'bookings', { customer: '7101', body: { kind: 'gm-seat', gameId: D.data.game.id, people: 1, name: 'Sam Jones', email: 'sam@example.com', players: [{ name: 'Sam', character: 'Ireena' }], usePass: seed.samPass.code } });
  check('D: Sam takes a seat with his pass', seatSam.status === 200 && seatSam.data.booking?.pass?.code === seed.samPass.code && seatSam.data.booking.amount === 1500, seatSam.data.error || seatSam.data.booking?.ref);
  out.seatSam = seatSam.data.booking;
  const seatLeo = await proxy('POST', 'bookings', { customer: '7104', body: { kind: 'gm-seat', gameId: D.data.game.id, people: 1, name: 'Leo Tane', email: 'leo@example.com', players: [{ name: 'Leo', character: 'Van Richten' }], pay: 'now' } });
  check('D: Leo takes a seat (pay ignored, at the counter)', seatLeo.status === 200 && seatLeo.data.booking?.pay === 'day' && !seatLeo.data.checkoutUrl, seatLeo.data.error || seatLeo.data.booking?.ref);
  out.seatLeo = seatLeo.data.booking;
}
const E = await proxy('POST', 'bookings', { customer: '7001', body: { kind: 'walkin', tables: ['T12'], start: Date.now(), end: Date.now() + 2 * 3600000, people: 3, name: 'Walk-in Whanau' } });
check('E: staff seat a walk-in at T12', E.status === 200 && E.data.booking?.status === 'seated', E.data.error || E.data.booking?.ref);
out.E = E.data.booking;
const F = await proxy('POST', 'tab', {
  customer: '7101',
  body: { items: [{ variantId: '44114640568423', title: 'Drinks', variantTitle: '$3 Drink', price: 300, qty: 2 }, { variantId: '44114682347623', title: 'Snacks', variantTitle: '$4 Snack', price: 400, qty: 1 }] },
});
check('F: Sam starts a tab', F.status === 200 && F.data.tab?.total === 1000 && F.data.tab.status === 'open', F.data.error || JSON.stringify(F.data.tab));
out.F = F.data.tab;
fs.writeFileSync(new URL('./today.json', import.meta.url), JSON.stringify(out, null, 2));
process.exit(summary() ? 1 : 0);

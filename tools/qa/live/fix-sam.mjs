import fs from 'node:fs';
import { proxy } from './client.mjs';
const me = await proxy('GET', 'me', { customer: '7101' });
const today = JSON.parse(fs.readFileSync('./today.json'));
const keep = new Set([today.A.id, today.A2.id]);
for (const b of me.data.bookings.filter((x) => !keep.has(x.id) && x.status === 'confirmed')) {
  const r = await proxy('POST', `bookings/${b.id}/update`, { customer: '7101', body: { status: 'cancelled' } });
  console.log('cancelled', b.ref, r.status, r.data.booking?.status, r.data.refund?.reason);
}
const seed = JSON.parse(fs.readFileSync('./seed.json'));
const seat = await proxy('POST', 'bookings', { customer: '7101', body: { kind: 'gm-seat', gameId: today.D.id, people: 1, name: 'Sam Jones', email: 'sam@example.com', players: [{ name: 'Sam', character: 'Ireena' }], usePass: seed.samPass.code } });
console.log('seat', seat.status, seat.data.error || [seat.data.booking.ref, seat.data.booking.amount, seat.data.booking.pass, seat.data.booking.due]);
today.seatSam = seat.data.booking;
fs.writeFileSync('./today.json', JSON.stringify(today, null, 2));

// Split the bill in the demo: split on createBooking, paidAmount and payments on the floor, due after payments,
// paid once nothing is left, a repeated order line counted once, and a pass at check-in after part is paid.
import { m, chromium, open, STAFF, CUSTOMER, PORT } from './lib.mjs';
const server = await m.serve(PORT);
const browser = await chromium.launch();
m.mockState.customer = CUSTOMER;
let { ctx, page } = await open(browser, 'desktop', '/pages/book-a-table');
const out = await page.evaluate(async () => {
  const { store } = window.Lair;
  const be = store.backend;
  const t = store.time;
  const r = {};
  const day = t.addDays(t.today(), 3);
  const st = t.at(day, 18 * 60);
  const res = await store.mutate('createBooking', { kind: 'table', tables: ['T6', 'T7'], room: 'main-room', start: st, end: st + 2 * 3600000, people: 5, extras: [], name: 'Aroha Ngata', email: 'aroha.n@example.com', phone: '021 555 0101', amount: 5000, split: true, paidAmount: 999, payments: [{ amount: 999 }] });
  r.created = { split: res.booking.split, paidAmount: res.booking.paidAmount, payments: res.booking.payments, due: res.booking.due };
  // Round 9: the booking page also runs the sessions board and the calendar, whose GET /me sets up the demo member's
  // account (a seated table today), so the walk-in takes a main-room table that's free now
  const freeNow = store.cfg.tables.find((tb) => tb.room === 'main-room' && !store.isShopTable(tb.id) && store.isFree(tb.id, Date.now(), Date.now() + 3600000))?.id || 'T6';
  const walk = await store.mutate('createBooking', { kind: 'walkin', tables: [freeNow], room: 'main-room', start: Date.now(), end: Date.now() + 3600000, people: 2, name: 'W', split: true, staffOverride: true, amount: 2000 });
  r.walkinSplit = walk.booking.split;
  const b = be.state.bookings.find((x) => x.id === res.booking.id);
  r.first = be.recordPayment('booking', b, { amount: 1000, name: 'Aroha Ngata', orderId: 'o1', lineId: 'l1' });
  r.again = be.recordPayment('booking', b, { amount: 1000, name: 'Aroha Ngata', orderId: 'o1', lineId: 'l1' });
  r.afterOne = { paidAmount: b.paidAmount, due: be.dueFor(b), paid: b.paid };
  be.recordPayment('booking', b, { amount: 4000, name: 'Mia Chen', orderId: 'o2', lineId: 'l1' });
  r.afterAll = { paidAmount: b.paidAmount, due: be.dueFor(b), paid: b.paid, payments: be.paymentsOf(b).map((p) => `${p.name}:${p.amount}`) };
  await store.refresh();
  const leo = store.data.bookings.find((x) => x.name === 'Leo' && x.split);
  r.leoFloor = leo && { split: leo.split, paidAmount: leo.paidAmount, due: leo.due, amount: leo.amount, payments: leo.payments.map((p) => `${p.name}:${p.amount}`), customerId: leo.customerId };
  r.joinsHaveDue = store.data.joins.every((j) => 'due' in j && 'paidAmount' in j && 'refund' in j);
  return r;
});
console.log(JSON.stringify(out, null, 1));
console.log('errors', page.errors);
await ctx.close();
m.mockState.customer = STAFF;
({ ctx, page } = await open(browser, 'desktop', '/pages/lair-staff'));
const staff = await page.evaluate(async () => {
  const { store } = window.Lair;
  const be = store.backend;
  const r = {};
  const leo = be.state.bookings.find((x) => x.name === 'Leo' && x.split);
  // a pass at check-in after two of five paid: three people left, so three sessions
  const gift = be.passList().find((p) => p.label.startsWith('Gift'));
  const c = await store.mutate('checkin', { id: leo.id, type: 'booking', pass: gift.code });
  r.checkin = { due: c.row.due, covered: c.row.covered, paidAmount: c.row.paidAmount, pass: c.pass && { used: c.pass.used, covered: c.pass.covered }, split: c.row.split, payments: c.row.payments.length };
  return r;
});
console.log(JSON.stringify(staff, null, 1));
console.log('errors', page.errors);
await ctx.close();
await browser.close();
server.close();

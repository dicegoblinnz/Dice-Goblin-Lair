// DemoBackend, round 5: the members list (fields, sorts, owing filter), birthdays (suggested, gifted, last gift),
// gifts (credit, pass, rolls, product code, problems), waiving an owed seat, owed rows at check-in, pass sources.
import { m, chromium, open, STAFF, PORT } from './lib.mjs';
const server = await m.serve(PORT);
const browser = await chromium.launch();
m.mockState.customer = STAFF;
const query = process.argv[2] || '';
const { ctx, page } = await open(browser, 'phone', '/pages/lair-staff', { query });
const out = await page.evaluate(async () => {
  const be = window.Lair.store.backend;
  const money = window.Lair.money;
  const line = (x) => `${x.name} ${x.code} year ${money(x.spendYear)} total ${money(x.spendTotal)} owed ${money(x.owed)}(${x.owedCount}) tab ${money(x.openTab)} prizes ${x.pendingPrizes.length} gifted ${x.giftedThisYear}`;
  const r = {};
  r.spend = (await be.members({ sort: 'spend' })).slice(0, 4).map(line);
  r.recent = (await be.members({ sort: 'recent' })).slice(0, 3).map((x) => `${x.name} ${new Date(x.lastSeen).toISOString().slice(0, 10)}`);
  r.owing = (await be.members({ sort: 'owing', owing: true })).map(line);
  r.search = (await be.members({ q: 'tama', sort: 'spend' })).map(line);
  const tama = (await be.members({ q: 'tama', sort: 'spend' }))[0];
  r.byId = (await be.members({ q: tama.customerId, sort: 'spend' })).map((x) => x.name);
  r.pickers = (await be.findMembers('ar')).map((x) => x.name);
  r.empty = (await be.findMembers('')).length;
  r.birthdays = (await be.birthdays()).map((x) => `${x.date} ${x.name} ${JSON.stringify(x.suggested)} gifted=${x.giftedThisYear} last=${x.lastGift ? JSON.stringify(x.lastGift) : null}`);
  const card = await be.checkin({ code: tama.code });
  r.card = { message: card.message, due: card.due, rows: card.rows.map((x) => `${x.title} ${x.start ? new Date(x.start).toISOString().slice(0, 10) : ''} owed=${x.owed} due=${x.due} status=${x.status}`) };
  const owedRow = card.rows.find((x) => x.owed);
  const waived = await be.updateBooking(owedRow.id, { waived: true });
  r.waived = { owed: waived.booking.owed, waived: waived.booking.waived, due: waived.booking.due };
  try { await be.updateBooking(owedRow.id, { waived: true }); r.again = 'ok (already waived)'; } catch (e) { r.again = e.message; }
  r.tamaAfter = line((await be.members({ q: tama.customerId, sort: 'spend' }))[0]);
  const sam = (await be.members({ q: 'sam', sort: 'spend' }))[0];
  const gift = await be.giftMember(sam.customerId, { credit: 6, sessions: 3, rolls: 2, productVariantId: '12345', productTitle: 'Wingspan', note: 'Have a good one', notify: true });
  r.gift = gift;
  const again = await be.giftMember(sam.customerId, { productVariantId: '12345', productTitle: 'Wingspan', notify: false });
  r.gift2 = again.gift.product;
  try { await be.giftMember(sam.customerId, { notify: true }); } catch (e) { r.noGift = `${e.status} ${e.message}`; }
  const wiremu = (await be.members({ q: 'wiremu', sort: 'spend' }))[0];
  r.wiremuEmail = JSON.stringify(wiremu.email);
  r.wiremuGift = (await be.giftMember(wiremu.customerId, { credit: 4, notify: true })).gift;
  r.samAfter = line((await be.members({ q: sam.customerId, sort: 'spend' }))[0]);
  r.passes = (await be.listPasses('', 'all')).passes.map((p) => `${p.label} | ${p.code} | ${p.source} ${p.orderName || ''} | holder ${p.holder.customerId ? 'linked' : 'unlinked'} ${p.holder.name} | note ${p.note}`);
  return r;
});
console.log(JSON.stringify(out, null, 1));
console.log('errors', page.errors);
await ctx.close();
await browser.close();
server.close();

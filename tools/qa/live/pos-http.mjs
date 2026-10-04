// The POS extension's routes over HTTP with a signed POS session token, then the Verifone payments as signed
// orders/paid webhooks (source_name 'pos'): a full _booking line, two _share payments from different people, and a tab.
import fs from 'node:fs';
import { pos, proxy, webhook, fake, check, summary, WORKER } from './client.mjs';

const seed = JSON.parse(fs.readFileSync(new URL('./seed.json', import.meta.url)));
const T = JSON.parse(fs.readFileSync(new URL('./today.json', import.meta.url)));
const samCode = seed['7101'].code;
const out = {};

/* auth and CORS */
const noToken = await fetch(`${WORKER}/pos/today`);
check('POS: no token is a 401', noToken.status === 401);
const pre = await fetch(`${WORKER}/pos/scan`, { method: 'OPTIONS', headers: { Origin: 'https://extensions.shopifycdn.com', 'Access-Control-Request-Method': 'POST' } });
check('POS: CORS preflight answers', pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*');

/* GET /pos/today */
const today = await pos('GET', 'today');
check('GET /pos/today', today.status === 200 && Array.isArray(today.data.groups), today.status);
const groups = today.data.groups || [];
const game = groups.find((g) => g.kind === 'game' && g.key === `game:${T.D.id}`);
check('Today: the GM game is a group titled "<game> · GM <gm>" with its seats, not the GM', game && game.title === 'Curse of Strahd · GM Ana' && game.rows.length === 2 && game.rows.every((r) => r.kind === 'gm-seat'), game && [game.title, game.rows.map((r) => r.name)]);
const dnd = groups.find((g) => g.key === `event:dnd-saturday-6pm@${T.today}`);
check('Today: tonight\'s D&D is an event group with Leo\'s sign-up', dnd && dnd.rows.some((r) => r.type === 'join' && r.ref === T.C.ref && r.name === 'Leo Tane'), dnd && dnd.rows.map((r) => r.ref));
const tables = groups.find((g) => g.kind === 'tables');
const refs = tables ? tables.rows.map((r) => r.ref) : [];
check('Today: "Table bookings" holds the table bookings, the walk-in and the old GOB- booking', tables && tables.title === 'Table bookings' && [T.A.ref, T.A2.ref, T.B.ref, T.E.ref, 'GOB-7K2QXM'].every((r) => refs.includes(r)), refs);
check('Today: groups are in start order', groups.every((g, i) => i === 0 || groups[i - 1].start <= g.start));
const rowA = tables?.rows.find((r) => r.ref === T.A.ref);
const keys = ['id', 'type', 'ref', 'name', 'people', 'tables', 'start', 'end', 'status', 'arrivedAt', 'paid', 'amount', 'covered', 'due', 'customerId', 'pass', 'refund', 'note'];
check('Today: a row has every contract field', rowA && keys.every((k) => k in rowA), rowA && keys.filter((k) => !(k in rowA)));
check('Today: Sam\'s row shows his saved pass { code, label, left }', rowA?.pass?.code === seed.samPass.code && rowA.pass.left === 10 && 'label' in rowA.pass, rowA?.pass);
check('Today: a split bill row says split', tables?.rows.find((r) => r.ref === T.B.ref)?.split === true);

/* POST /pos/scan for each code type */
const scan = async (code) => pos('POST', 'scan', { code });
const sA = await scan(T.A.ref);
check('scan: a booking code', sA.status === 200 && sA.data.type === 'booking' && sA.data.row?.id === T.A.id && sA.data.group?.kind === 'tables', JSON.stringify(sA.data).slice(0, 160));
const sB = await scan(T.B.ref.toLowerCase().replace(/-/g, ''));
check(`scan: lower case without dashes (${T.B.ref.toLowerCase().replace(/-/g, '')})`, sB.status === 200 && sB.data.row?.ref === T.B.ref, sB.data.error);
const sB2 = await scan(T.B.ref.toLowerCase().replace(/-/g, ' '));
check('scan: with spaces', sB2.status === 200 && sB2.data.row?.ref === T.B.ref, sB2.data.error);
const sC = await scan(T.C.ref);
check('scan: an event sign-up code', sC.status === 200 && sC.data.type === 'join' && sC.data.group?.kind === 'event', JSON.stringify(sC.data).slice(0, 160));
const sSeat = await scan(T.seatSam.ref);
check('scan: a GM seat code (group is the game)', sSeat.status === 200 && sSeat.data.group?.key === `game:${T.D.id}` && sSeat.data.group.title === 'Curse of Strahd · GM Ana', sSeat.data.group);
const sM = await scan(samCode);
check('scan: Sam\'s member code', sM.status === 200 && sM.data.type === 'member' && sM.data.member?.customerId === '7101' && sM.data.member.code === samCode, JSON.stringify(sM.data).slice(0, 200));
check('scan member: his rows today, his tab and his active passes', sM.data.rows?.length === 3 && sM.data.tab?.status === 'open' && sM.data.passes?.[0]?.code === seed.samPass.code, [sM.data.rows?.map((r) => r.ref), sM.data.tab?.status, sM.data.passes?.map((p) => p.code)]);
const sP = await scan(seed.samPass.code);
check('scan: a pass code', sP.status === 200 && sP.data.type === 'pass' && sP.data.pass?.code === seed.samPass.code && sP.data.pass.sessionsLeft === 10, JSON.stringify(sP.data).slice(0, 160));
for (const legacy of ['GOB-7K2QXM', 'gob7k2qxm', '7K2QXM']) {
  const sL = await scan(legacy);
  check(`scan: legacy ${legacy}`, sL.status === 200 && sL.data.type === 'booking' && sL.data.row?.ref === 'GOB-7K2QXM', sL.data.error || sL.data.row?.ref);
}
const sX = await scan('ZZ-NOPE-99');
check('scan: an unknown code is 404 with the contract message', sX.status === 404 && sX.data.error === 'No booking, member or pass with that code.', sX.data);
const before = await proxy('GET', 'floor', { customer: '7001' });
check('scan checks nobody in', before.data.bookings.find((b) => b.id === T.A.id)?.status === 'confirmed');

/* POST /pos/checkin by id + type: the saved pass is used */
const cA = await pos('POST', 'checkin', { id: T.A.id, type: 'booking' });
const lineA = cA.data.lines?.[0];
check('checkin A: arrived, and the pass covered 4 sessions ($40 of $60)', cA.status === 200 && cA.data.row?.status === 'seated' && cA.data.pass?.used === 4 && cA.data.pass?.covered === 4000 && cA.data.row.due === 2000, JSON.stringify({ pass: cA.data.pass, due: cA.data.row?.due, notice: cA.data.notice }));
check('checkin A: one line, $20, titled like the contract', cA.data.lines?.length === 1 && lineA.price === '20.00' && lineA.title === `Table fee: ${T.A.ref} (F1, 4 people) (pass covered $40)` && lineA.properties?._booking === T.A.ref && lineA.quantity === 1 && lineA.taxable === true, lineA);
check('checkin A: the cart\'s customer is Sam', cA.data.customer?.id === '7101', cA.data.customer);
out.useA = cA.data.pass?.useId;
/* POST /pos/pass-undo */
const undo = await pos('POST', 'pass-undo', { useId: cA.data.pass?.useId });
check('pass-undo: the sessions go back and the fee comes back', undo.status === 200 && undo.data.pass?.sessionsLeft === 10 && undo.data.row?.due === 6000 && undo.data.row.covered === 0, JSON.stringify({ left: undo.data.pass?.sessionsLeft, due: undo.data.row?.due }));
/* checking in again (already arrived) re-applies the saved pass and returns the same lines */
const cA2 = await pos('POST', 'checkin', { id: T.A.id, type: 'booking' });
check('checkin A again: fine, the pass applies again, same line', cA2.status === 200 && cA2.data.pass?.used === 4 && cA2.data.lines?.[0]?.price === '20.00' && cA2.data.row.status === 'seated', JSON.stringify({ msg: cA2.data.message, lines: cA2.data.lines }));
const cA3 = await pos('POST', 'checkin', { id: T.A.id, type: 'booking' });
check('checkin A a third time: no second pass use, same $20 line', cA3.status === 200 && !cA3.data.pass && cA3.data.lines?.[0]?.price === '20.00', JSON.stringify({ pass: cA3.data.pass, lines: cA3.data.lines }));
/* the legacy code checks in with { code } */
const cL = await pos('POST', 'checkin', { code: 'gob-7k2qxm' });
check('checkin by legacy code', cL.status === 200 && cL.data.row?.ref === 'GOB-7K2QXM' && cL.data.lines?.[0]?.price === '30.00', JSON.stringify({ msg: cL.data.message, lines: cL.data.lines }));

/* POST /pos/checkin-member: all of Leo's rows today */
const cM = await pos('POST', 'checkin-member', { customerId: '7104' });
check('checkin-member Leo: his sign-up and his seat are checked in', cM.status === 200 && cM.data.rows?.length === 2 && cM.data.rows.every((r) => r.arrivedAt), JSON.stringify(cM.data).slice(0, 300));
const titles = (cM.data.lines || []).map((l) => `${l.title} ${l.price}`);
check('checkin-member Leo: an event entry line and a GM seat line', titles.some((x) => x === `Event entry: Dungeons & Dragons (${T.C.ref}) 15.00`) && titles.some((x) => x === `GM seat: Curse of Strahd (${T.seatLeo.ref}) 15.00`), titles);
check('checkin-member: customer and notices', cM.data.customer?.id === '7104' && Array.isArray(cM.data.notices));

/* Sam's GM seat with his pass: the GM fee is still paid */
const cS = await pos('POST', 'checkin', { id: T.seatSam.id, type: 'booking' });
check('checkin Sam\'s seat: the pass covers the table part ($10), the $5 GM fee is left', cS.status === 200 && cS.data.pass?.covered === 1000 && cS.data.row?.due === 500 && cS.data.lines?.[0]?.title === `GM seat: Curse of Strahd (${T.seatSam.ref}) (pass covered $10)`, JSON.stringify({ pass: cS.data.pass, lines: cS.data.lines }));

/* POST /pos/share: per-person and custom amounts */
const sh = await pos('POST', 'share', { id: T.B.id, type: 'booking' });
check('share: one person\'s share of Kiri\'s $40', sh.status === 200 && sh.data.line?.price === '10.00' && sh.data.line.title === `Table fee share: ${T.B.ref} ($10 of $40 left)` && sh.data.line.properties?._booking === T.B.ref && sh.data.line.properties._share === '1', sh.data.line || sh.data);
const shC = await pos('POST', 'share', { id: T.B.id, type: 'booking', amount: 1500 });
check('share: a custom amount', shC.status === 200 && shC.data.line?.price === '15.00', shC.data.line);
const shBig = await pos('POST', 'share', { id: T.B.id, type: 'booking', amount: 99999 });
check('share: capped at what\'s due', shBig.status === 200 && shBig.data.line?.price === '40.00', shBig.data.line);

/* POST /pos/tab/:id/added */
const tabAdded = await pos('POST', `tab/${T.F.id}/added`, {});
check('tab added: the tab is in the cart', tabAdded.status === 200 && tabAdded.data.tab?.status === 'in-cart', tabAdded.data);
const tabLocked = await proxy('POST', 'tab', { customer: '7101', body: { items: [{ variantId: '44114640568423', title: 'Drinks', variantTitle: '$3 Drink', price: 300, qty: 5 }] } });
check('tab in the cart can\'t change from My Lair (409)', tabLocked.status === 409 && /at the counter already/.test(tabLocked.data.error), tabLocked.data.error);

/* The Verifone payments: signed orders/paid webhooks */
const order = async (id, customerId, lines, source = 'pos') => {
  const subtotal = lines.reduce((s, l) => s + Math.round(Number(l.price) * 100) * (l.quantity || 1), 0);
  await fake('POST', 'order', { id, customerId, subtotal, source });
  return webhook({ id, source_name: source, line_items: lines.map((l, i) => ({ id: Number(`${id}${i}`), quantity: 1, ...l })) });
};
const prop = (name, value) => ({ name, value });
const w1 = await order(6001, '7104', [
  { title: lineA ? 'Event entry' : '', price: '15.00', properties: [prop('_booking', T.C.ref)] },
  { title: 'GM seat', price: '15.00', properties: [prop('_booking', T.seatLeo.ref)] },
]);
check('webhook: Leo pays his entry and his seat in full', w1.status === 200 && w1.data.updated?.length === 2 && w1.data.spend === 3000, w1.data);
const w2 = await order(6002, '7101', [{ title: 'Share', price: '10.00', properties: [prop('_booking', T.B.ref), prop('_share', '1')] }]);
check('webhook: Sam pays a $10 share of Kiri\'s bill', w2.status === 200 && w2.data.updated?.[0] === T.B.ref, w2.data);
const w3 = await order(6003, '7104', [{ title: 'Share', price: '10.00', properties: [prop('_booking', T.B.ref), prop('_share', '1')] }]);
check('webhook: Leo pays a $10 share too', w3.status === 200 && w3.data.updated?.[0] === T.B.ref, w3.data);
const again = await webhook({ id: 6002, source_name: 'pos', line_items: [{ id: 60020, quantity: 1, title: 'Share', price: '10.00', properties: [prop('_booking', T.B.ref), prop('_share', '1')] }] });
check('webhook: the same order again doesn\'t count twice', again.status === 200, again.data);
const tabLines = T.F.items.map((it) => ({ title: `${it.title} - ${it.variantTitle}`, price: (it.price / 100).toFixed(2), quantity: it.qty, variant_id: Number(it.variantId), properties: [prop('_tab', T.F.id)] }));
const w4 = await order(6004, '7101', [{ title: 'Table fee', price: '20.00', properties: [prop('_booking', T.A.ref)] }, ...tabLines]);
check('webhook: Sam pays his $20 and his tab in one order', w4.status === 200 && w4.data.updated?.[0] === T.A.ref && w4.data.tabs?.[0] === T.F.id, w4.data);

/* the effects: staff floor, the POS roster and My Lair */
const staff = await proxy('GET', 'floor', { customer: '7001' });
const fB = staff.data.bookings.find((b) => b.id === T.B.id);
check('staff floor: Kiri\'s bill is part paid, $20 of $40, by Sam and Leo', fB && fB.paidAmount === 2000 && fB.due === 2000 && !fB.paid && fB.payments.length === 2 && fB.payments.map((p) => p.name).sort().join() === 'Leo Tane,Sam Jones', fB && { paidAmount: fB.paidAmount, due: fB.due, payments: fB.payments });
const fA = staff.data.bookings.find((b) => b.id === T.A.id);
check('staff floor: Sam\'s Fancy room is paid (pass $40 + $20)', fA && fA.paid && fA.due === 0 && fA.covered === 4000 && fA.paidAmount === 2000, fA && { paid: fA.paid, due: fA.due, covered: fA.covered, paidAmount: fA.paidAmount });
const fC = staff.data.joins?.find((j) => j.id === T.C.id);
check('staff floor: Leo\'s sign-up is paid', fC && fC.paid && fC.due === 0, fC && { paid: fC.paid, due: fC.due, paidAmount: fC.paidAmount });
const today2 = await pos('GET', 'today');
const rowB = today2.data.groups.find((g) => g.kind === 'tables').rows.find((r) => r.ref === T.B.ref);
check('POS today: the split row shows paidAmount, due and payments', rowB.paidAmount === 2000 && rowB.due === 2000 && rowB.payments.length === 2, { paidAmount: rowB.paidAmount, due: rowB.due, payments: rowB.payments });
const share2 = await pos('POST', 'share', { id: T.B.id, type: 'booking' });
check('share after two payments: $10 of $20 left', share2.data.line?.title === `Table fee share: ${T.B.ref} ($10 of $20 left)`, share2.data.line?.title);
const kiri = await proxy('GET', 'me', { customer: '7102' });
const kB = kiri.data.bookings.find((b) => b.id === T.B.id);
check('Kiri\'s My Lair: paid $20 of $40, $20 left, split', kB && kB.paidAmount === 2000 && kB.due === 2000 && kB.split === true && kB.amount === 4000, kB);
check('Kiri\'s My Lair: no payer names (staff and POS only)', kB && !('payments' in kB), kB && Object.keys(kB));
const sam = await proxy('GET', 'me', { customer: '7101' });
check('Sam\'s My Lair: the tab is paid', sam.data.tab?.status === 'paid' && sam.data.tab.id === T.F.id, sam.data.tab);
check('Sam\'s My Lair: his Fancy room booking is paid, the pass covered $40', sam.data.bookings.find((b) => b.id === T.A.id)?.paid === true && sam.data.bookings.find((b) => b.id === T.A.id)?.covered === 4000);
check('Sam\'s spend counts (orders 6002 and 6004: $40 → 2 rolls)', sam.data.member?.spendTotal === 4000 && sam.data.rolls?.available === 2 && sam.data.rolls.bonus === 2 && sam.data.rolls.per === 2000 && !('daily' in sam.data.rolls), { spend: sam.data.member?.spendTotal, rolls: sam.data.rolls });
const newTab = await proxy('POST', 'tab', { customer: '7101', body: { items: [{ variantId: '44114640601191', title: 'Drinks', variantTitle: '$6 Drink', price: 600, qty: 1 }] } });
check('after the tab is paid, a new tab starts', newTab.status === 200 && newTab.data.tab?.id !== T.F.id && newTab.data.tab.status === 'open', newTab.data);
await proxy('POST', 'tab/clear', { customer: '7101', body: {} });
out.after = { B: fB, A: fA };
fs.writeFileSync(new URL('./pos-out.json', import.meta.url), JSON.stringify(out, null, 2));
process.exit(summary() ? 1 : 0);

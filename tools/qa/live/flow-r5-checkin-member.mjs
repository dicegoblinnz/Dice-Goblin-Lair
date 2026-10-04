// Round 5 (c): one bill at the counter. Leo has a table booked tonight, an open tab, and a weekly game seat he owes for
// (from flow-r5-regulars.mjs). The POS member view's "Add everything to cart": /pos/scan (his rows, owed rows and the
// tab), /pos/checkin-member (checks in today's rows only; lines for today's and the owed rows, "Owed: <title> (<date>)"),
// the tab's items with _tab, POST /pos/tab/:id/added, then the paid POS order settles all of it.
import fs from 'node:fs';
import { proxy, pos, webhook, fake, check, summary } from './client.mjs';

const R = JSON.parse(fs.readFileSync(new URL('./r5-regulars.json', import.meta.url)));
const tz = 'Pacific/Auckland';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const at = (h) => {
  const guess = Date.parse(`${today}T${String(h).padStart(2, '0')}:00:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  return guess - (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - guess);
};
const run = Date.now() % 100000;
const owedId = R.seats['7104'];

/* setup: tonight's table and a tab */
const table = await proxy('POST', 'bookings', { customer: '7104', body: { kind: 'table', tables: ['T7'], start: at(21), end: at(23), people: 2, name: 'Leo Tane', email: 'leo@example.com' } });
check('setup: Leo books T7 for 2 tonight ($20 at the counter)', table.status === 200 && table.data.booking?.amount === 2000, table.data.error || table.data.booking?.ref);
const T7 = table.data.booking;
const tab = await proxy('POST', 'tab', { customer: '7104', body: { items: [{ variantId: '44114640601191', title: 'Drinks', variantTitle: '$6 Drink', price: 600, qty: 2 }] } });
check('setup: Leo starts a tab ($12)', tab.status === 200 && tab.data.tab?.status === 'open' && tab.data.tab.total === 1200, tab.data.error || tab.data.tab);
const leoBefore = (await proxy('GET', 'me', { customer: '7104' })).data;
check('setup: he owes for the weekly game\'s ended session', leoBefore.seats.find((x) => x.id === owedId)?.owed === true && (leoBefore.dueNow || []).some((x) => x.id === owedId && x.owed), (leoBefore.dueNow || []).map((x) => [x.ref, x.due, x.owed]));
check('My Lair\'s one bill (dueNow): tonight\'s table and the owed seat', (leoBefore.dueNow || []).some((x) => x.id === T7?.id && x.due === 2000 && !x.owed) && (leoBefore.dueNow || []).filter((x) => x.owed).length === 1, (leoBefore.dueNow || []).map((x) => [x.ref, x.title, x.due, x.owed]));

/* 1. the scan */
const code = (await proxy('GET', 'me', { customer: '7104' })).data.member.code;
const scan = await pos('POST', 'scan', { code });
const rows = scan.data.rows || [];
check('scan: his rows today, then the owed row (owed: true)', scan.status === 200 && rows.some((r) => r.id === T7?.id && !r.owed) && rows.at(-1)?.id === owedId && rows.at(-1).owed === true && rows.at(-1).due === 1500, rows.map((r) => [r.ref, r.status, r.due, r.owed]));
check('scan: the open tab', scan.data.tab?.id === tab.data.tab?.id && scan.data.tab.status === 'open' && scan.data.tab.total === 1200, scan.data.tab);

/* 2. Add everything to cart: check in today's rows, lines for them and the owed row */
const cm = await pos('POST', 'checkin-member', { customerId: '7104' });
const cRows = cm.data.rows || [];
const lines = cm.data.lines || [];
const owedRow = cRows.find((r) => r.id === owedId);
const t7Row = cRows.find((r) => r.id === T7?.id);
check('checkin-member: tonight\'s table is checked in', cm.status === 200 && t7Row?.status === 'seated' && Boolean(t7Row.arrivedAt), t7Row && { status: t7Row.status, arrivedAt: t7Row.arrivedAt });
check('checkin-member: the owed row comes last and is not checked in', owedRow && cRows.at(-1)?.id === owedId && owedRow.owed === true && !owedRow.arrivedAt && owedRow.status === 'confirmed', owedRow && { status: owedRow.status, arrivedAt: owedRow.arrivedAt });
const t7Line = lines.find((l) => l.properties?._booking === T7?.ref);
const owedLine = lines.find((l) => l.properties?._booking === R.refs['7104']);
check('a line for tonight\'s table: "Table fee: <code> (T7, 2 people)", $20', t7Line && t7Line.title === `Table fee: ${T7.ref} (T7, 2 people)` && t7Line.price === '20.00' && t7Line.quantity === 1 && t7Line.taxable === true, t7Line);
check('a line for the owed seat: "Owed: <game> (<date>)", $15, its own code in _booking', owedLine && owedLine.title.startsWith(`Owed: ${R.title} (`) && /\(\w{3} \d{1,2} \w{3,4}\)$/.test(owedLine.title) && owedLine.price === '15.00', owedLine);
check('only lines for what\'s due (his paid rows today have none)', lines.length === 2 && lines.every((l) => Number(l.price) > 0), lines.map((l) => `${l.title} ${l.price}`));
check('checkin-member: customer and notices', cm.data.customer?.id === '7104' && Array.isArray(cm.data.notices), cm.data.customer);
const again = await pos('POST', 'checkin-member', { customerId: '7104' });
check('again: the same lines, and the owed row still isn\'t checked in', (again.data.lines || []).length === 2 && !(again.data.rows || []).find((r) => r.id === owedId)?.arrivedAt, (again.data.lines || []).map((l) => l.title));

/* 3. the tab goes in the cart, then the order is paid at the counter */
const added = await pos('POST', `tab/${tab.data.tab.id}/added`, {});
check('the tab is in the cart', added.status === 200 && added.data.tab?.status === 'in-cart', added.data);
const tabLines = tab.data.tab.items.map((it) => ({ title: `${it.title} - ${it.variantTitle}`, price: (it.price / 100).toFixed(2), quantity: it.qty, variant_id: Number(it.variantId), properties: [{ name: '_tab', value: tab.data.tab.id }] }));
const cart = [...lines.map((l) => ({ title: l.title, price: l.price, quantity: l.quantity, properties: Object.entries(l.properties).map(([name, value]) => ({ name, value })) })), ...tabLines];
const orderId = 97000 + (run % 1000);
const subtotal = cart.reduce((s, l) => s + Math.round(Number(l.price) * 100) * (l.quantity || 1), 0);
await fake('POST', 'order', { id: orderId, customerId: '7104', subtotal, source: 'pos' });
const paid = await webhook({ id: orderId, source_name: 'pos', line_items: cart.map((l, i) => ({ id: orderId * 10 + i, ...l })) });
check('the paid POS order: tonight\'s table and the owed seat paid, the tab paid, $47 spend', paid.status === 200 && [T7.ref, R.refs['7104']].every((r) => paid.data.updated?.includes(r)) && paid.data.tabs?.[0] === tab.data.tab.id && paid.data.spend === 4700, paid.data);

/* 4. all settled */
const leo = (await proxy('GET', 'me', { customer: '7104' })).data;
const seat = leo.seats.find((x) => x.id === owedId);
check('the owed seat is paid: not owed, nothing due, never checked in', seat && seat.paid === true && seat.owed === false && seat.due === 0, seat && { paid: seat.paid, owed: seat.owed, due: seat.due });
check('My Lair: nothing left to pay now, and the tab is paid', !(leo.dueNow || []).some((x) => x.id === owedId || x.id === T7.id) && leo.tab?.status === 'paid', { dueNow: (leo.dueNow || []).map((x) => [x.ref, x.due]), tab: leo.tab?.status });
const member = ((await proxy('GET', 'members?q=7104', { customer: '7001' })).data || []).find((m) => m.customerId === '7104');
check('the Members view: Leo owes nothing, no open tab', member && member.owed === 0 && member.owedCount === 0 && member.openTab === 0, member && { owed: member.owed, openTab: member.openTab });
const scan2 = await pos('POST', 'scan', { code });
check('the next scan: no owed rows', !(scan2.data.rows || []).some((r) => r.owed), (scan2.data.rows || []).map((r) => [r.ref, r.owed, r.due]));

process.exit(summary() ? 1 : 0);

// Round 9, tab (contract v9-tab), HTTP only (no browser), on the real Worker and the fake Admin API: the running tab and
// monthly accounts. Mo (9 Oct): "...you will have a running tab with future events and when you settle the tab you can
// pay for it day by day or if you like you can save it to pay it off once a month either up front or compiled. The idea
// is to track it all in the Shopify."
//   1. staff put Tama on a monthly account ($40 limit): the words; a booking is coming up "on the account"; checked in it's
//      owed on the account; a tab too; past the limit a tab item and a booking are refused with the app's words
//   2. Bill now: a draft order for Tama (purchasingEntity), the table as a custom line tagged _booking, the tab's product
//      tagged _tab, every line tagged _bill, a $0 "Collected at the Lair" shipping line; the email "Your Lair bill:
//      $29.00" with the invoice link; "Pay online now" gives the same bill while nothing changed
//   3. paid online (the bill's own draft order, orders/paid): the bill, the booking and the tab are paid; no booking email;
//      the webhook again pays nothing twice
//   4. Hine pays her bill at the counter (a POS sale with her tab's lines): the bill is paid at the counter and its draft
//      order deleted; Void deletes another bill's draft; back on pay each visit what she owes stays owed, and says so
//   5. the Accounts tab lists them; a pay-each-visit member's scan at the POS is as before ({ billing: 'visit' }, no rows
//      from an account)
import { proxy, pos, webhook, fake, check, summary } from './client.mjs';
import { key, addDays, nextDow, at, sleep } from './r6-time.mjs';

const STAFF = '7001';
const TAMA = '7921'; // monthly account, pays online
const HINE = '7922'; // monthly account, pays at the counter, then back to pay each visit
const RANGI = '7923'; // pays each visit
const PEOPLE = [[TAMA, 'Tama Ruru', 'tama.r9tab@example.com'], [HINE, 'Hine Kawa', 'hine.r9tab@example.com'], [RANGI, 'Rangi Pou', 'rangi.r9tab@example.com']];
for (const [id, name, email] of PEOPLE) {
  await fake('POST', 'customer', { id, tags: [], name, email });
  await proxy('GET', `me?name=${encodeURIComponent(name)}`, { customer: id });
}
const me = async (id) => (await proxy('GET', 'me', { customer: id })).data;
const said = (res) => `${res.status} ${res.data?.error || ''}`.trim();
const money = (c) => `$${c % 100 === 0 ? c / 100 : (c / 100).toFixed(2)}`;
const pocky = (qty) => [{ variantId: '9190000001', title: 'Pocky', variantTitle: 'Strawberry', price: 450, qty }];
const detail = async (id) => (await proxy('GET', `members/${id}`, { customer: STAFF })).data.member?.account;
const D = nextDow(6, key(Date.now()), 14); // a Saturday at least two weeks away, clear of the other flows
const emailsNow = async () => (await fake('GET', 'emails')).length;

/* 1. a monthly account */
const switched = await proxy('POST', `members/${TAMA}/account`, { customer: STAFF, body: { billing: 'monthly', creditLimit: 4000, note: 'Round 9 QA' } });
check('1: staff put Tama on a monthly account: the words', switched.status === 200 && switched.data.said === 'Tama is on a monthly account now, with a $40 limit. What they check in for from now goes on their account, and their bill comes on the 1st.', switched.data);
check('1: not staff: 403', said(await proxy('POST', `members/${TAMA}/account`, { customer: TAMA, body: { billing: 'monthly', creditLimit: 900000 } })) === '403 Staff only. Log in with your staff account.');
const booked = await proxy('POST', 'bookings', { customer: TAMA, body: { kind: 'table', tables: ['T20'], start: at(D, 18), end: at(D, 20), people: 2, name: 'Tama Ruru', email: 'tama.r9tab@example.com' } });
const B = booked.data.booking || {};
check('1: Tama books a table: on the account, nothing owed yet', booked.status === 200 && B.amount > 0, booked.data.error || B);
let account = (await me(TAMA)).account || {};
check('1: GET /me account: monthly, $40 limit, the table coming up "account", nothing owed',
  account.billing === 'monthly' && account.creditLimit === 4000 && account.owed.total === 0 && account.comingUp.items.some((i) => i.ref === B.ref && i.settle === 'account') && account.available === 4000, account);
const checked = await proxy('POST', 'checkin', { customer: STAFF, body: { code: B.ref, force: true } });
check('1: staff check Tama in', checked.status === 200 && checked.data.checkedIn, checked.data);
await proxy('POST', 'tab', { customer: TAMA, body: { items: pocky(2) } });
account = (await me(TAMA)).account || {};
const owed1 = B.amount + 900;
check('1: checked in, the table is owed on the account, and the tab with it', account.owed.total === owed1 && account.owed.items.map((i) => `${i.kind}:${i.settle}`).sort().join(',') === 'tab:account,table:account', account.owed);
const room = 4000 - owed1;
const over = await proxy('POST', 'tab', { customer: TAMA, body: { items: pocky(2 + Math.ceil((room + 1) / 450)) } });
check('1: a tab item past the limit: 409 with the words', said(over) === `409 That would take your Lair account over its $40 limit (${money(room)} left). Pay your bill online or at the counter, then add to your tab again.`, said(over));
const overBooking = await proxy('POST', 'bookings', { customer: TAMA, body: { kind: 'table', tables: ['T21'], start: at(D, 18), end: at(D, 20), people: 4, name: 'Tama Ruru', email: 'tama.r9tab@example.com' } });
check('1: a booking past the limit: 409 with the words', said(overBooking).startsWith(`409 That would take your Lair account over its $40 limit (${money(room)} left).`) && said(overBooking).endsWith('then book again.'), said(overBooking));

/* 2. Bill now, and Pay online now */
const e0 = await emailsNow();
const billNow = await proxy('POST', `accounts/${TAMA}/bill`, { customer: STAFF, body: {} });
const bill = billNow.data.bill || {};
check('2: Bill now: made and emailed, the words', billNow.status === 200 && billNow.data.said === `Bill for $${(owed1 / 100).toFixed(2)} emailed to tama.r9tab@example.com.` && bill.status === 'open' && bill.total === owed1 && bill.kind === 'now', billNow.data);
const drafts = (await fake('GET', 'state')).drafts;
const draft = drafts[bill.draftOrderId] || {};
const input = draft.input || {};
const lines = input.lineItems || [];
const attr = (l, k) => (l.customAttributes || []).find((a) => a.key === k)?.value;
check('2: the draft order is Tama\'s (purchasingEntity), tagged lair-bill, with _bill', input.purchasingEntity?.customerId === `gid://shopify/Customer/${TAMA}` && (input.tags || []).includes('lair-bill') && (input.customAttributes || []).some((a) => a.key === '_bill' && a.value === bill.id), input);
check('2: the table is a custom line "Table for 2 · <day> · <code>" tagged _booking and _bill', lines.some((l) => !l.variantId && /^Table for 2 · \w{3} \d{1,2} \w{3,4} · /.test(l.title) && attr(l, '_booking') === B.ref && attr(l, '_bill') === bill.id && l.originalUnitPriceWithCurrency?.amount === (B.amount / 100).toFixed(2)), lines);
check('2: the tab is its product at the tab\'s price, tagged _tab and _bill, and nothing is shipped', lines.some((l) => l.variantId === 'gid://shopify/ProductVariant/9190000001' && l.quantity === 2 && l.priceOverride?.amount === '4.50' && attr(l, '_tab') && attr(l, '_bill') === bill.id) && input.shippingLine?.title === 'Collected at the Lair', { lines, ship: input.shippingLine });
await sleep(400);
const billMail = (await fake('GET', 'emails')).slice(e0).find((m) => [].concat(m.to).includes('tama.r9tab@example.com'));
check('2: the email: "Your Lair bill: $…", Pay online with the invoice link, or the counter', billMail?.subject === `Your Lair bill: $${(owed1 / 100).toFixed(2)}`
  && billMail.text.includes(`__checkout/${String(bill.draftOrderId).split('/').pop()}`) && /Or pay at the counter next time you're in/.test(billMail.text) && billMail.text.includes(B.ref), billMail);
const payNow = await proxy('POST', 'me/account/pay', { customer: TAMA, body: {} });
check('2: "Pay online now" while nothing changed: the same bill and link', payNow.status === 200 && payNow.data.bill?.id === bill.id && payNow.data.invoiceUrl && payNow.data.invoiceUrl.endsWith(`/__checkout/${String(bill.draftOrderId).split('/').pop()}`), payNow.data);
check('2: GET /me shows the open bill, the items on it', (await me(TAMA)).account.bill?.id === bill.id && (await me(TAMA)).account.owed.items.every((i) => i.onBill), (await me(TAMA)).account);

/* 3. paid online */
const ORDER = 9900000 + Math.floor(Math.random() * 90000);
const orderGid = `gid://shopify/Order/${ORDER}`;
await fake('POST', 'draft-paid', { draftId: bill.draftOrderId, orderId: orderGid });
await fake('POST', 'order', { id: ORDER, customerId: TAMA, subtotal: owed1, source: 'shopify_draft_order' });
const order = {
  id: ORDER, source_name: 'shopify_draft_order', note_attributes: [{ name: '_bill', value: bill.id }],
  line_items: lines.map((l, i) => ({
    id: ORDER * 10 + i, price: (l.priceOverride || l.originalUnitPriceWithCurrency).amount, quantity: l.quantity || 1,
    properties: (l.customAttributes || []).map((a) => ({ name: a.key, value: a.value })),
  })),
};
const e1 = await emailsNow();
const paid = await webhook(order);
check('3: orders/paid from the bill\'s draft order: the bill is paid', paid.status === 200 && (paid.data?.bills || []).includes(bill.id), paid.data);
let tama = await me(TAMA);
const acct = await detail(TAMA);
const tableNow = (tama.bookings || []).find((b) => b.ref === B.ref) || {};
check('3: the bill says paid online, the table is paid in full, the tab paid, nothing owed', acct.bills?.[0]?.status === 'paid' && acct.bills[0].paidHow === 'online' && tableNow.paid === true && tableNow.paidAmount === B.amount && tama.account.owed.total === 0 && tama.account.bill === null && tama.tab?.status === 'paid', { bill: acct.bills?.[0], tableNow, owed: tama.account.owed, tab: tama.tab });
await sleep(400);
check('3: no booking email for a bill', !(await fake('GET', 'emails')).slice(e1).some((m) => [].concat(m.to).includes('tama.r9tab@example.com')));
await webhook(order);
tama = await me(TAMA);
check('3: the webhook again pays nothing twice', ((tama.bookings || []).find((b) => b.ref === B.ref) || {}).paidAmount === B.amount);

/* 4. Hine: paid at the counter, void, back to pay each visit */
await proxy('POST', `members/${HINE}/account`, { customer: STAFF, body: { billing: 'monthly', creditLimit: 5000 } });
await proxy('POST', 'tab', { customer: HINE, body: { items: pocky(2) } });
const hineBill = (await proxy('POST', `accounts/${HINE}/bill`, { customer: STAFF, body: {} })).data.bill || {};
check('4: Hine\'s bill for her tab', hineBill.status === 'open' && hineBill.total === 900, hineBill);
const hine = await me(HINE);
const scan = await pos('POST', 'scan', { code: hine.member.code });
check('4: the POS scan says she\'s on a monthly account, with her tab', scan.status === 200 && scan.data.account?.billing === 'monthly' && scan.data.account.creditLimit === 5000 && scan.data.tab?.total === 900, scan.data);
const POS = ORDER + 1;
await fake('POST', 'order', { id: POS, customerId: HINE, subtotal: 900, source: 'pos' });
const counter = await webhook({ id: POS, source_name: 'pos', line_items: [{ id: POS * 10, price: '4.50', quantity: 2, properties: [{ name: '_tab', value: scan.data.tab.id }] }] });
check('4: the POS sale went through', counter.status === 200, counter.data);
await sleep(600);
const hineAcct = await detail(HINE);
const hineDraft = (await fake('GET', 'state')).drafts[hineBill.draftOrderId] || {};
check('4: paid at the counter: the bill is paid ("counter") and its draft order deleted, so it can\'t be paid twice', hineAcct.bills?.[0]?.status === 'paid' && hineAcct.bills[0].paidHow === 'counter' && hineDraft.status === 'DELETED', { bill: hineAcct.bills?.[0], draft: hineDraft.status });
await proxy('POST', 'tab', { customer: HINE, body: { items: pocky(1) } });
const second = (await proxy('POST', `accounts/${HINE}/bill`, { customer: STAFF, body: {} })).data.bill || {};
const voided = await proxy('POST', `bills/${second.id}/void`, { customer: STAFF, body: {} });
await sleep(600);
check('4: Void: the bill is cancelled and its draft order deleted; what was on it stays owed', voided.data.bill?.status === 'void' && voided.data.bill.voidReason === 'staff' && (await fake('GET', 'state')).drafts[second.draftOrderId]?.status === 'DELETED' && voided.data.account?.owed.total === 450, voided.data);
check('4: a cancelled bill can\'t be sent again', said(await proxy('POST', `bills/${second.id}/resend`, { customer: STAFF, body: {} })) === '409 That bill was cancelled. Make a new one with Bill now.');
const back = await proxy('POST', `members/${HINE}/account`, { customer: STAFF, body: { billing: 'visit' } });
check('4: back to pay each visit: what she owes stays owed, and the words say so', back.data.said === 'Hine pays each visit now. They still owe $4.50 from their account. That stays owed until they pay it, online or at the counter.' && back.data.account.owed.total === 450, back.data);
check('4: pay each visit: no online paying for her', said(await proxy('POST', 'me/account/pay', { customer: HINE, body: {} })) === "409 You pay each visit, so there's nothing to pay online. Show your member code at the counter and we'll ring it up.");

/* 5. the Accounts tab, and a pay-each-visit member at the counter */
const list = (await proxy('GET', 'accounts', { customer: STAFF })).data.accounts || [];
check('5: the Accounts tab lists Tama (monthly) and Hine (owes from her account)', list.some((a) => a.customerId === TAMA && a.billing === 'monthly') && list.some((a) => a.customerId === HINE && a.billing === 'visit' && a.owed === 450), list);
check('5: not staff: 403', said(await proxy('GET', 'accounts', { customer: TAMA })) === '403 Staff only. Log in with your staff account.');
await proxy('POST', 'tab', { customer: RANGI, body: { items: pocky(1) } });
const rangi = await me(RANGI);
const rscan = await pos('POST', 'scan', { code: rangi.member.code });
check('5: pay each visit: GET /me says so, and the POS scan is as before', rangi.account?.billing === 'visit' && rscan.data.account?.billing === 'visit' && !(rscan.data.rows || []).some((r) => r.onAccount) && rscan.data.tab?.total === 450, { me: rangi.account, scan: rscan.data });

process.exit(summary() ? 1 : 0);

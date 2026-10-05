// Round 6 (c): session gifts. Rangi buys two 5-session gifts and a 10-session gift online (LAIR-GIFT-5 and
// LAIR-GIFT-10): three unlinked gift passes, and one email to the order's address with every code and how to redeem
// it. Shopify sending the webhook again makes nothing new. Kahu claims a code in My Lair: it's hers, still a gift. A
// gift sold at the counter with no email goes to the staff instead.
import { proxy, webhook, fake, check, summary } from './client.mjs';
import { sleep } from './r6-time.mjs';

const RANGI = '7207';
const KAHU = '7208';
const STAFF = '7001';
const run = Date.now() % 100000;
let next = 98000 + (run % 1000) * 10;
await fake('POST', 'customer', { id: RANGI, tags: [], name: 'Rangi Tamatea', email: 'rangi.t@example.com' });
await fake('POST', 'customer', { id: KAHU, tags: [], name: 'Kahu Moana', email: 'kahu.m@example.com' });
await proxy('GET', `me?name=${encodeURIComponent('Kahu Moana')}`, { customer: KAHU });
const giftLine = (n, quantity, price, extra = {}) => ({ title: 'Session gift', variant_title: `${n} sessions`, sku: `LAIR-GIFT-${n}`, price, quantity, properties: [], ...extra });
async function order({ customerId = null, lines, source = 'web', email = '', name }) {
  next += 1;
  const id = next;
  const subtotal = lines.reduce((s, l) => s + Math.round(Number(l.price) * 100) * l.quantity, 0);
  await fake('POST', 'order', { id, customerId, subtotal, source, email, name: name || `#R6G${id}` });
  const payload = { id, source_name: source, line_items: lines.map((l, i) => ({ id: id * 10 + i, ...l })) };
  const before = (await fake('GET', 'emails')).length;
  const res = await webhook(payload);
  await sleep(800);
  return { id, name: name || `#R6G${id}`, payload, res, emails: (await fake('GET', 'emails')).slice(before) };
}
const staffPass = async (code) => (await proxy('GET', `passes?q=${encodeURIComponent(code)}&status=all`, { customer: STAFF })).data.passes?.find((p) => p.code === code) || null;

/* 1. Rangi buys three gifts online */
const a = await order({ customerId: RANGI, email: 'rangi.gifts@example.com', lines: [giftLine(5, 2, '50.00'), giftLine(10, 1, '100.00')] });
const codes = a.res.data?.gifts || [];
check('three gifts: two of 5 sessions and one of 10, and no session passes', a.res.status === 200 && codes.length === 3 && a.res.data.passes?.length === 0, a.res.data);
const passes = await Promise.all(codes.map(staffPass));
check('each is an unlinked gift pass: "Gift: N sessions", from the order, "A gift from Rangi"', passes.every((p) => p && p.source === 'gift' && !p.holder.customerId && !p.holder.name && p.orderName === a.name && p.note === 'A gift from Rangi' && p.cover === 1000 && p.status === 'active')
  && passes.map((p) => p.label).sort().join('|') === 'Gift: 10 sessions|Gift: 5 sessions|Gift: 5 sessions', passes.map((p) => p && { label: p.label, source: p.source, holder: p.holder, note: p.note }));
check('price paid: what each unit cost', passes.map((p) => p.pricePaid).sort((x, y) => x - y).join() === '5000,5000,10000', passes.map((p) => p.pricePaid));
const mail = a.emails.find((e) => [].concat(e.to).includes('rangi.gifts@example.com'));
check('one email to the order\'s address: "Your session gift is ready"', a.emails.length === 1 && mail?.subject === 'Your session gift is ready', a.emails.map((e) => [e.to, e.subject]));
check('every code is in it, with its sessions and how to redeem it', mail && codes.every((c) => mail.text.includes(c)) && (mail.text.match(/5 sessions at the Dice Goblin Lair/g) || []).length === 2 && (mail.text.match(/10 sessions at the Dice Goblin Lair/g) || []).length === 1
  && (mail.text.match(/Log in at dicegoblin\.nz, open My Lair › Wallet and enter the code under 'Got a pass code\?'/g) || []).length === 3, (mail?.text || '').slice(0, 600));

/* 2. The same webhook again: nothing new */
const before = (await fake('GET', 'emails')).length;
const again = await webhook(a.payload);
await sleep(800);
check('Shopify sends it again: no new gifts, no second email', again.status === 200 && again.data?.gifts?.length === 0 && (await fake('GET', 'emails')).length === before, again.data);

/* 3. Kahu claims one in My Lair */
const claim = await proxy('POST', 'me/passes/claim', { customer: KAHU, body: { code: codes[0].toLowerCase().replace(/-/g, ' ') } });
check('Kahu claims a code: it\'s hers, and still a gift', claim.status === 200 && claim.data.pass?.code === codes[0] && claim.data.pass.source === 'gift' && claim.data.pass.orderName === null, claim.data);
const mine = (await proxy('GET', 'me', { customer: KAHU })).data.passes || [];
check('her passes list it, as a gift', mine.some((p) => p.code === codes[0] && p.source === 'gift'), mine.map((p) => [p.code, p.source]));
const taken = await proxy('POST', 'me/passes/claim', { customer: RANGI, body: { code: codes[0] } });
check('nobody else can claim it now (409)', taken.status === 409, taken.data);
check('the staff view links it to Kahu and keeps the note', (await staffPass(codes[0]))?.holder.customerId === KAHU && (await staffPass(codes[0]))?.note === 'A gift from Rangi', (await staffPass(codes[0]))?.holder);

/* 4. Sold at the counter with no customer and no email: the staff get the codes */
const b = await order({ source: 'pos', lines: [giftLine(5, 1, '50.00')], name: `#R6C${next + 1}` });
const toStaff = b.emails.find((e) => [].concat(e.to).includes('staff@dicegoblin.test'));
check('no email on the order: the staff get the code to pass on', b.res.data?.gifts?.length === 1 && toStaff && /^Session gift codes to pass on/.test(toStaff.subject) && toStaff.text.includes(b.res.data.gifts[0]), b.emails.map((e) => [e.to, e.subject]));

/* 5. Shopify won't say who bought it (no protected data approval): the member on the order is emailed */
await proxy('GET', `me?name=${encodeURIComponent('Rangi Tamatea')}`, { customer: RANGI });
await proxy('POST', 'me/profile', { customer: RANGI, body: { name: 'Rangi Tamatea', email: 'rangi.t@example.com' } });
await fake('POST', 'set', { failBuyer: true });
const c = await order({ customerId: RANGI, lines: [giftLine(5, 1, '50.00')] });
await fake('POST', 'set', { failBuyer: false });
check('the buyer lookup refused: the webhook still works and the member\'s email gets the code', c.res.status === 200 && c.res.data?.gifts?.length === 1 && c.emails.some((e) => [].concat(e.to).includes('rangi.t@example.com') && e.text.includes(c.res.data.gifts[0])), c.emails.map((e) => e.to));

process.exit(summary() ? 1 : 0);

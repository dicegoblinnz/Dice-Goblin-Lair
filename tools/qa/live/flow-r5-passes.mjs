// Round 5 (a): session passes are a product. A paid line with SKU LAIR-PASS-N (online or at the POS) issues a pass of N
// sessions for each one bought: to the order's customer, or unlinked with the buyer's name (or "Sold at the counter")
// for them to claim in My Lair. Shopify sending the webhook again makes nothing new.
import { proxy, webhook, fake, check, summary } from './client.mjs';

const run = Date.now() % 100000;
let next = 96000 + (run % 1000) * 10;
/** A paid order through the fake (its customer, subtotal, name and billing name) and its signed orders/paid webhook */
async function order({ customerId = null, lines, source = 'web', billingName = '' }) {
  next += 1;
  const id = next;
  const name = `#R5${id}`;
  const subtotal = lines.reduce((s, l) => s + Math.round(Number(l.price) * 100) * (l.quantity || 1) - (l.discount_allocations || []).reduce((d, a) => d + Math.round(Number(a.amount) * 100), 0), 0);
  await fake('POST', 'order', { id, customerId, subtotal, source, billingName, name });
  const payload = { id, source_name: source, line_items: lines.map((l, i) => ({ id: id * 10 + i, quantity: 1, properties: [], ...l })) };
  const res = await webhook(payload);
  return { id, name, payload, res };
}
const passLine = (n, price, extra = {}) => ({ title: 'Session pass', variant_title: `${n} sessions`, sku: `LAIR-PASS-${n}`, price, ...extra });
/** The staff view of a pass, by its code */
const staffPass = async (code) => (await proxy('GET', `passes?q=${encodeURIComponent(code)}&status=all`, { customer: '7001' })).data.passes?.find((p) => p.code === code) || null;
const myPasses = async (who) => (await proxy('GET', 'me', { customer: who })).data.passes || [];

/* 1. Kiri buys a 10-session pass online: it's hers */
const kiriBefore = (await myPasses('7102')).length;
const a = await order({ customerId: '7102', lines: [passLine(10, '100.00')] });
check('online order with LAIR-PASS-10: one pass, and the spend counts', a.res.status === 200 && a.res.data?.passes?.length === 1 && a.res.data.spend === 10000, a.res.data);
const aCode = a.res.data?.passes?.[0];
const aPass = aCode ? await staffPass(aCode) : null;
check('the pass: "Session pass: 10 sessions", covers the table fee, $100 paid, from the order', aPass && aPass.label === 'Session pass: 10 sessions' && aPass.sessionsTotal === 10 && aPass.sessionsLeft === 10 && aPass.cover === 1000 && aPass.pricePaid === 10000 && aPass.source === 'order' && aPass.orderName === a.name && aPass.status === 'active', aPass);
check('it\'s linked to Kiri (her name and email from her member record), noted "Bought online"', aPass && aPass.holder.customerId === '7102' && aPass.holder.name === 'Kiri Smith' && aPass.holder.email === 'kiri@example.com' && aPass.note === 'Bought online', aPass && { holder: aPass.holder, note: aPass.note });
const kiriPasses = await myPasses('7102');
const mine = kiriPasses.find((p) => p.code === aCode);
check('Kiri\'s My Lair lists it: source, order name and "Bought online"', kiriPasses.length === kiriBefore + 1 && mine && mine.source === 'order' && mine.orderName === a.name && mine.note === 'Bought online' && mine.sessionsLeft === 10, mine);

/* 2. Shopify sends the same webhook again: nothing new */
const again = await webhook(a.payload);
const kiriAfter = await myPasses('7102');
check('the same order again issues no second pass and no second spend', again.status === 200 && again.data?.passes?.length === 0 && again.data.spend === 0 && kiriAfter.length === kiriPasses.length, again.data);

/* 3. Leo buys two 5-session passes on one line, with $10 off the line: two passes, $45 each */
const b = await order({ customerId: '7104', lines: [passLine(5, '50.00', { quantity: 2, discount_allocations: [{ amount: '10.00' }] })] });
const bCodes = b.res.data?.passes || [];
check('quantity 2: two passes', b.res.status === 200 && bCodes.length === 2 && bCodes[0] !== bCodes[1], b.res.data);
const bPasses = await Promise.all(bCodes.map(staffPass));
check('each is Leo\'s, 5 sessions, $45 paid (the line\'s $90 after its discount, split two ways)', bPasses.length === 2 && bPasses.every((p) => p && p.holder.customerId === '7104' && p.sessionsTotal === 5 && p.label === 'Session pass: 5 sessions' && p.pricePaid === 4500 && p.orderName === b.name), bPasses.map((p) => p && { holder: p.holder.customerId, n: p.sessionsTotal, paid: p.pricePaid }));
const bAgain = await webhook(b.payload);
check('and again: still two', bAgain.data?.passes?.length === 0 && (await myPasses('7104')).filter((p) => p.orderName === b.name).length === 2, bAgain.data);

/* 4. Online with no customer: unlinked, in the billing name, for them to claim in My Lair */
const callsBefore = (await fake('GET', 'calls')).length;
const c = await order({ customerId: null, billingName: 'Hemi Walker', lines: [passLine(10, '100.00')] });
const cCode = c.res.data?.passes?.[0];
const cPass = cCode ? await staffPass(cCode) : null;
const buyerCalls = (await fake('GET', 'calls')).slice(callsBefore).filter((x) => x.op === 'OrderBuyer' && x.variables?.id === `gid://shopify/Order/${c.id}`);
check('no customer on the order: Shopify is asked who bought it (OrderBuyer)', buyerCalls.length === 1, buyerCalls.length);
check('the pass is unlinked, in the billing name, no spend counted', c.res.status === 200 && cPass && !cPass.holder.customerId && cPass.holder.name === 'Hemi Walker' && cPass.source === 'order' && c.res.data.spend === 0, cPass && { holder: cPass.holder, spend: c.res.data.spend });
// Tui (a new member) claims it from My Lair with the code, typed loosely
await proxy('GET', `me?name=${encodeURIComponent('Tui Harper')}`, { customer: '7106' });
const claim = await proxy('POST', 'me/passes/claim', { customer: '7106', body: { code: cCode ? cCode.toLowerCase().replace(/-/g, ' ') : 'x' } });
check('Tui claims it in My Lair: it\'s hers', claim.status === 200 && claim.data.pass?.code === cCode && claim.data.pass.source === 'order' && claim.data.pass.note === 'Bought online', claim.data);
const tuiPasses = await myPasses('7106');
check('her passes list it, and the staff view links it to her', tuiPasses.some((p) => p.code === cCode) && (await staffPass(cCode))?.holder.customerId === '7106', tuiPasses.map((p) => p.code));
const steal = await proxy('POST', 'me/passes/claim', { customer: '7102', body: { code: cCode } });
check('nobody else can claim it now (409)', steal.status === 409, steal.data);

/* 5. Sold at the POS with no customer and no name: "Sold at the counter", "Bought at the counter" */
const d = await order({ customerId: null, source: 'pos', lines: [passLine(5, '50.00')] });
const dPass = d.res.data?.passes?.[0] ? await staffPass(d.res.data.passes[0]) : null;
check('a POS sale with no customer: unlinked, "Sold at the counter", "Bought at the counter"', d.res.status === 200 && dPass && !dPass.holder.customerId && dPass.holder.name === 'Sold at the counter' && dPass.note === 'Bought at the counter' && dPass.pricePaid === 5000, dPass && { holder: dPass.holder, note: dPass.note });

/* 6. A customer the Lair doesn't know yet: their name and email come from Shopify */
const e = await order({ customerId: '7107', lines: [passLine(10, '100.00')] });
const ePass = e.res.data?.passes?.[0] ? await staffPass(e.res.data.passes[0]) : null;
check('a customer who isn\'t a member yet: linked, with the name and email Shopify has', e.res.status === 200 && ePass && ePass.holder.customerId === '7107' && ePass.holder.name === 'Ari Moana' && ePass.holder.email === 'ari@example.com', ePass && ePass.holder);

/* 7. Shopify won't share who bought it (protected customer data not approved): the pass is still made */
await fake('POST', 'set', { failBuyer: true });
const f = await order({ customerId: null, lines: [passLine(10, '100.00')] });
await fake('POST', 'set', { failBuyer: false });
const fPass = f.res.data?.passes?.[0] ? await staffPass(f.res.data.passes[0]) : null;
check('OrderBuyer refused: the webhook still succeeds and the pass is made, "Sold at the counter"', f.res.status === 200 && fPass && !fPass.holder.customerId && fPass.holder.name === 'Sold at the counter', f.res.data);

/* 8. Ordinary lines make no passes; a pass line and a booking line on one order each do their job */
const g = await order({ customerId: '7101', lines: [{ title: 'Dice set', sku: 'DICE-1', price: '20.00' }, { title: 'Session pass', sku: 'LAIR-PASS-0', price: '0.00' }] });
check('other SKUs (and LAIR-PASS-0) make no pass', g.res.status === 200 && g.res.data?.passes?.length === 0, g.res.data);

process.exit(summary() ? 1 : 0);

// Round 6 (b): spend by month and New Zealand financial year (GET /members/:id/spend, staff). Hemi has orders in the
// fake Shopify going back 400 days; one was already counted by orders/paid. The first report fills in the older ones
// from Shopify (CustomerOrders), once: Shopify shows the last 60 days until read_all_orders is granted, then every
// order. Each order counts once, whether it came by the webhook or the backfill.
import { proxy, webhook, fake, check, summary, WORKER } from './client.mjs';
import { key } from './r6-time.mjs';

const HEMI = '7206';
const STAFF = '7001';
const run = Date.now() % 100000;
let next = 97000 + (run % 1000) * 10;
await fake('POST', 'customer', { id: HEMI, tags: [], name: 'Hemi Rawiri', email: 'hemi.r@example.com', createdAt: '2018-05-01T00:00:00Z' });
await proxy('GET', `me?name=${encodeURIComponent('Hemi Rawiri')}`, { customer: HEMI });
const daysAgo = (n) => Date.now() - n * 86400000;
const order = async (customerId, subtotal, ms, extra = {}) => {
  next += 1;
  await fake('POST', 'order', { id: next, customerId, subtotal, source: 'web', name: `#R6S${next}`, createdAt: new Date(ms).toISOString(), ...extra });
  return { id: next, gid: `gid://shopify/Order/${next}`, ms, subtotal };
};
const old = await order(HEMI, 12000, daysAgo(400)); // only with read_all_orders
const month = await order(HEMI, 4550, daysAgo(30));
const recent = await order(HEMI, 2000, daysAgo(10));
await order(HEMI, 9900, daysAgo(5), { cancelled: true });
await order(HEMI, 1500, daysAgo(3), { status: 'PENDING' });
await order('7101', 7700, daysAgo(4)); // someone else's
const customerOrders = async () => (await fake('GET', 'calls')).filter((c) => c.op === 'CustomerOrders' && c.variables?.id === `gid://shopify/Customer/${HEMI}`).length;
const report = async () => (await proxy('GET', `members/${HEMI}/spend`, { customer: STAFF })).data;

/* 1. orders/paid counted one already */
const paid = await webhook({ id: recent.id, source_name: 'web', line_items: [{ id: recent.id * 10, title: 'Dice set', price: '20.00', quantity: 1, properties: [] }] });
check('orders/paid counted the recent order', paid.status === 200 && paid.data?.spend === 2000, paid.data);

/* 2. The first report: Shopify's last 60 days are filled in, once */
const notStaff = await proxy('GET', `members/${HEMI}/spend`, { customer: HEMI });
check('staff only (403)', notStaff.status === 403, notStaff.data);
const first = await report();
check('the first report reads Hemi\'s orders from Shopify once (CustomerOrders)', (await customerOrders()) === 1, await customerOrders());
check('the last 60 days are added; the order orders/paid counted isn\'t counted again; cancelled and unpaid ones are left out', first.total === 4550 + 2000, first.total);
check('24 months, oldest first, this month last, empty months as 0', first.months?.length === 24 && first.months.at(-1).month === key(Date.now()).slice(0, 7) && first.months.every((m) => typeof m.amount === 'number' && typeof m.orders === 'number'), first.months?.slice(-3));
const monthOf = (ms) => first.months.find((m) => m.month === key(ms).slice(0, 7));
check('each order lands in its month (Lair time)', monthOf(month.ms)?.amount >= 4550 && first.months.reduce((s, m) => s + m.amount, 0) === 6550, first.months.filter((m) => m.amount));
const fyStart = (k) => (Number(k.slice(5, 7)) >= 4 ? Number(k.slice(0, 4)) : Number(k.slice(0, 4)) - 1);
const fyName = (start) => `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
const thisFy = fyStart(key(Date.now()));
check('the financial years run from 1 April to 31 March, newest first', first.years?.[0]?.fy === fyName(thisFy) && first.years[0].from === `${thisFy}-04-01` && first.years[0].to === `${thisFy + 1}-03-31`, first.years);
check('since: the first order the Lair knows about', first.since === key(month.ms), first.since);
await report();
check('once per customer: Shopify isn\'t asked again', (await customerOrders()) === 1, await customerOrders());

/* 3. read_all_orders granted: every order, read once more, nothing counted twice */
await fake('POST', 'set', { scopes: ['read_customers', 'read_metaobjects', 'read_themes', 'read_orders', 'read_all_orders', 'write_draft_orders', 'write_store_credit_account_transactions', 'write_discounts', 'read_products', 'read_inventory'] });
await fetch(`${WORKER}/setup?key=test-setup-key`);
const all = await report();
await report();
check('with read_all_orders the older order is added, once', all.total === 12000 + 4550 + 2000 && (await customerOrders()) === 2, { total: all.total, calls: await customerOrders() });
check('since moves back to it, and its financial year is listed (up to four)', all.since === key(old.ms) && all.years.length <= 4 && all.years.some((y) => y.fy === fyName(fyStart(key(old.ms))) && y.amount >= 12000), { since: all.since, years: all.years });
const twice = await webhook({ id: month.id, source_name: 'web', line_items: [{ id: month.id * 10, title: 'Board game', price: '45.50', quantity: 1, properties: [] }] });
check('orders/paid for an order the backfill added counts nothing more', twice.status === 200 && twice.data?.spend === 0 && (await report()).total === all.total, twice.data);
await fake('POST', 'set', { scopes: null });
await fetch(`${WORKER}/setup?key=test-setup-key`);

/* 4. Shopify down for someone new: the report still answers from what the Lair has */
await fake('POST', 'customer', { id: '7209', tags: [], name: 'Tia Paewai', email: 'tia.p@example.com' });
await proxy('GET', `me?name=${encodeURIComponent('Tia Paewai')}`, { customer: '7209' });
await fake('POST', 'set', { failOrders: true });
const down = await proxy('GET', 'members/7209/spend', { customer: STAFF });
await fake('POST', 'set', { failOrders: false });
check('Shopify can\'t answer: the report still comes back (nothing yet)', down.status === 200 && down.data.total === 0 && down.data.since === null && down.data.years?.length === 1, down.data);
check('the staff Members list shows this financial year\'s spend', ((await proxy('GET', `members?q=${HEMI}`, { customer: STAFF })).data || [])[0]?.spendFy >= 0, 'spendFy');

process.exit(summary() ? 1 : 0);

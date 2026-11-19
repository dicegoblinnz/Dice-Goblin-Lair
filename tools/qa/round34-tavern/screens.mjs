// Round 34b: the Tavern's two screens in a real browser, against a real Lair with a pretend Shopify behind it.
// Local only, never ships.   node tools/qa/round34-tavern/screens.mjs [folder for the pictures] [--stay]
// It orders from a table as Sam, makes the drinks as Caleb, and checks what each screen says. --stay leaves the pages
// up on http://localhost:8734 (add ?as=sam or ?as=caleb once to "log in").
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../../../src/lair.js';
import { rulesFromSettings } from '../../../src/core.js';
import { tavernSkus } from '../../../src/tavern-menu.js';
import { tavernPageFor, tavernPageResponse } from '../../../src/tavern-pages.js';
import { shopifyTabPrices } from '../../../test/tab-prices.js';

const out = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '/tmp/tavern-screens';
const stay = process.argv.includes('--stay');
mkdirSync(out, { recursive: true });

const db = new DatabaseSync(':memory:');
const sql = {
  exec(query, ...bindings) {
    const stmt = db.prepare(query);
    if (/^\s*(select|with)/i.test(query)) {
      const rows = stmt.all(...bindings);
      return { toArray: () => rows, one: () => rows[0] };
    }
    stmt.run(...bindings);
    return { toArray: () => [], one: () => undefined };
  },
};
const kv = new Map();
const lair = new Lair({ storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: () => {} }, { CURRENCY: 'NZD' });
lair.person = async (id) => ({ customerId: id || null, staff: id === 'caleb', gm: false });
lair.memberRow = (id) => (id ? { first_name: id.charAt(0).toUpperCase() + id.slice(1) } : null);
lair.shopify.orderSpend = async () => null;
lair.shopify.orderBuyer = async () => null;
lair.shopify.customerEmail = async () => null;
const hours = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `${d} 00:00-23:59`).join('\n');
lair.rulesCache = rulesFromSettings({ lair_hours: hours, lair_shop_tables: '' }, [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }], []);
lair.rulesLoadedAt = Date.now() + 10 * 365 * 24 * 3_600_000;
const catalogue = new Map(tavernSkus().map((s, i) => [s.sku, { variantId: String(900000 + i), price: s.price, title: s.title, variantTitle: 'Default Title', sellable: true }]));
lair.shopify.tavernVariants = async () => catalogue;
shopifyTabPrices(lair);

const PREFIX = '/apps/liar';
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const cookie = /(?:^|; )as=([a-z]*)/.exec(req.headers.cookie || '')?.[1] || '';
  const as = url.searchParams.get('as') ?? cookie;
  const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : null;
  let answer;
  if (path === null) answer = new Response('Not the Lair', { status: 404 });
  else if (req.method === 'GET' && tavernPageFor(path)) answer = tavernPageResponse(tavernPageFor(path));
  else {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    answer = await lair.fetch(new Request(`https://lair.test${path}${url.search}`, {
      method: req.method, headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': as, 'X-Lair-Client': '203.0.113.7' },
      body: req.method === 'GET' ? undefined : Buffer.concat(chunks).toString() || '{}',
    }));
  }
  const headers = Object.fromEntries(answer.headers);
  if (url.searchParams.has('as')) headers['Set-Cookie'] = `as=${as}; Path=/`;
  res.writeHead(answer.status, headers);
  res.end(Buffer.from(await answer.arrayBuffer()));
});
await new Promise((ok) => server.listen(8734, ok));
const site = `http://localhost:8734${PREFIX}`;

let failed = 0;
const check = (what, ok, saw = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `\n       saw: ${String(saw).slice(0, 400)}`}`);
};
const flat = (text) => String(text || '').replace(/\s+/g, ' ').trim();

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright');
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const errors = [];
const watch = (page, name) => {
  page.on('console', (m) => { // a guest's 401, the missing favicon and (offline) the fonts are expected; anything the page's own rules block is not
  if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
};

const staffCtx = await browser.newContext(phone);
const staff = await staffCtx.newPage();
watch(staff, 'staff');
const tables = await (await staffCtx.request.get(`${site}/tavern/tables?as=caleb`)).json();
const T4 = tables.tables.find((t) => t.id === 'T4').code;

/* ---- the order page, nobody logged in, no table ---- */
const guestCtx = await browser.newContext(phone);
const guest = await guestCtx.newPage();
watch(guest, 'guest');
await guest.goto(`${site}/tavern`);
await guest.waitForSelector('.card');
check('A1 without a table code it shows the menu and how to order, with no Order button', flat(await guest.innerText('body')).includes("scan the code on your table's card") && (await guest.locator('button.order').count()) === 0);
check('A2 seventeen drinks, each with a drawing', (await guest.locator('.card').count()) === 17 && (await guest.locator('.card svg[role=img]').count()) === 17);
check('A3 the fancy name sits above the plain one', flat(await guest.locator('.card').first().innerText()).startsWith('Healing Potion No. 1 · Strawberry Lemonade'), await guest.locator('.card').first().innerText());
await guest.goto(`${site}/tavern?t=${T4}`);
await guest.waitForSelector('.pill');
await guest.getByRole('button', { name: 'Add Blue Lychee' }).click();
await guest.getByRole('button', { name: /^Add to order/ }).click();
check('A4 a guest can fill an order but is asked to log in', (await guest.locator('a.order').getAttribute('href'))?.startsWith('/customer_authentication/login?return_to=') && flat(await guest.innerText('.bar')).includes('1 drink · $8'), await guest.innerText('.bar'));
await guestCtx.close();

/* ---- Sam at table T4 ---- */
const samCtx = await browser.newContext(phone);
const sam = await samCtx.newPage();
watch(sam, 'sam');
await sam.goto(`${site}/tavern?t=${T4}&as=sam`);
await sam.waitForSelector('.pill');
check('B1 the table from the QR card is named', flat(await sam.innerText('.top')) === 'Tavern Table T4', await sam.innerText('.top'));
await sam.getByRole('button', { name: 'Add Strawberry Lemonade' }).click();
await sam.getByRole('button', { name: 'Less ice' }).click();
await sam.getByRole('button', { name: /^Add to order · \$8$/ }).click();
await sam.getByRole('button', { name: 'Add Taro Milk' }).click();
await sam.getByLabel('Oat milk instead of creamer').check();
await sam.getByLabel('A note for whoever makes it').fill('birthday!');
await sam.screenshot({ path: `${out}/2-options.png`, fullPage: true });
check('B2 oat milk adds a dollar to the button', (await sam.getByRole('button', { name: 'Add to order · $10' }).count()) === 1);
await sam.getByRole('button', { name: 'Add to order · $10' }).click();
check('B3 the bar adds it up', flat(await sam.innerText('.bar')).startsWith('2 drinks · $18'), await sam.innerText('.bar'));
await sam.screenshot({ path: `${out}/1-menu.png` });
await sam.screenshot({ path: `${out}/1-menu-full.png`, fullPage: true });
// Brew Your Own asks for what it needs
await sam.getByRole('button', { name: 'Add Brew Your Own' }).click();
check('B4 Brew Your Own waits for a flavour and a topping', await sam.getByRole('button', { name: /^Add to order/ }).isDisabled());
await sam.getByRole('button', { name: 'Cherry', exact: true }).click();
await sam.getByRole('button', { name: 'Lemon', exact: true }).click();
await sam.getByRole('button', { name: 'Strawberry pearls' }).click();
await sam.screenshot({ path: `${out}/3-brew-your-own.png`, fullPage: true });
await sam.getByRole('button', { name: 'Add to order · $10' }).click();
await sam.locator('button.sum').click();
await sam.screenshot({ path: `${out}/4-your-order.png`, fullPage: true });
check('B5 the order can be read back and changed', flat(await sam.innerText('.sheet')).includes('cherry + lemon, sparkling · strawberry pearls') && (await sam.getByRole('button', { name: /^Take .* off your order$/ }).count()) === 3, await sam.innerText('.sheet'));
await sam.getByRole('button', { name: 'Take Brew Your Own off your order' }).click();
await sam.getByRole('button', { name: 'Back to the menu' }).first().click();
await sam.getByRole('button', { name: 'Order', exact: true }).click();
await sam.waitForSelector('.notice.gold');
check('B6 ordering says so and shows where each drink is', flat(await sam.innerText('.page')).includes("Ordered. $18 is on your tab") && (await sam.locator('.status.waiting').count()) === 2, await sam.innerText('.page'));
await sam.screenshot({ path: `${out}/5-ordered.png` });

/* ---- Caleb's phone ---- */
await staff.goto(`${site}/tavern/drinks?as=caleb`);
await staff.waitForSelector('.order');
check('C1 the new order sits on top with its ring', flat(await staff.innerText('.ringer')).startsWith('1 new order') && flat(await staff.innerText('.order.new')).includes('Table T4 · Sam'), await staff.innerText('.page'));
check('C2 each drink says how it was ordered, and the note', flat(await staff.innerText('.order.new')).includes('5 Taro Milk Brown sugar jelly · oat milk Note: birthday!') && flat(await staff.innerText('.order.new')).includes('1 Strawberry Lemonade Strawberry pearls · less ice'), await staff.innerText('.order.new'));
await staff.locator('button.ringer').click();
await staff.waitForSelector('div.ringer.on');
check('C3 with the ring on it says it rings until On it', flat(await staff.innerText('.ringer')) === '1 new order. Rings until someone taps On it.', await staff.innerText('.ringer'));
await staff.screenshot({ path: `${out}/6-staff-ringing.png`, fullPage: true });
await staff.getByRole('button', { name: 'On it' }).click();
await staff.waitForSelector('.order.mine');
check('C4 On it stops the ring and names who has it', flat(await staff.innerText('.order.mine .who')).includes("Caleb's on it") && (await staff.locator('div.ringer.on').count()) === 0, await staff.innerText('.page'));
await staff.screenshot({ path: `${out}/7-staff-on-it.png`, fullPage: true });
await staff.getByRole('button', { name: 'Recipe for Taro Milk' }).click();
const card = flat(await staff.innerText('.page'));
check('C5 the recipe card is the drink as ordered', card.includes('Taro Milk') && card.includes('No. 5 · Sleep Potion') && card.includes('Table T4 · Sam · Glass tavern mug') && card.includes('Note from Sam: birthday!') && card.includes('Taro powder 2 scoops') && card.includes('Oat milk (instead of creamer) 150 ml') && !card.includes('Creamer 3 scoops'), card);
await staff.screenshot({ path: `${out}/8-recipe.png`, fullPage: true });
await staff.getByRole('button', { name: 'Done', exact: true }).click();
await staff.waitForSelector('.order.mine');
check('C6 Done takes it off the list', (await staff.locator('.drink').count()) === 1, await staff.innerText('.page'));
await sam.reload();
await sam.waitForSelector('.status');
check('B7 Sam sees one on its way and one being made', (await sam.locator('.status.done').count()) === 1 && (await sam.locator('.status.making').count()) === 1, await sam.innerText('.page'));
await staff.getByRole('button', { name: 'Recipe for Strawberry Lemonade' }).click();
await staff.getByRole('button', { name: /cancel this drink/ }).click();
await staff.getByRole('button', { name: /Tap again/ }).click();
await staff.getByText('No drinks to make').waitFor();
check('C7 a cancelled drink leaves an empty list', flat(await staff.innerText('.page')).includes('No drinks to make'), await staff.innerText('.page'));
await staff.getByRole('button', { name: 'Rush sign: in' }).click();
await staff.waitForSelector('button.pill');
await staff.screenshot({ path: `${out}/9-staff-empty-rush.png`, fullPage: true });
await sam.reload();
await sam.waitForSelector('.card.resting');
check('B8 with the Rush sign out the slow drinks rest', (await sam.locator('.card.resting').count()) === 5 && flat(await sam.innerText('.page')).includes("It's a rush right now"), String(await sam.locator('.card.resting').count()));
await sam.screenshot({ path: `${out}/10-rush.png`, fullPage: true });

/* ---- someone who isn't staff ---- */
await sam.goto(`${site}/tavern/drinks`);
await sam.waitForSelector('.notice');
check("D1 the drinks list is for the team only", flat(await sam.innerText('.page')).includes("The drinks list is for the Lair's team."), await sam.innerText('.page'));

check('E1 nothing went wrong in any browser (and nothing was blocked)', errors.length === 0, errors.join(' | '));
console.log(`\nPictures in ${out}`);
if (stay) console.log(`Pages up at ${site}/tavern?t=${T4}&as=sam and ${site}/tavern/drinks?as=caleb (Ctrl+C to stop)`);
else {
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
}

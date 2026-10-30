// The theme review's cart findings, in a real browser on the theme mock: quick add carries the Ordered in note, the cart
// puts wrong notes right whenever it shows or changes (so Shop Pay etc. get it), the cart is drawn again with the new
// keys (so remove and +/- keep working), and Checkout still goes on.
import { createRequire } from 'node:module';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('/opt/node-tools/node_modules/playwright');
// Run: DG_THEME=<the theme's folder> node tools/qa/round25/cart-sync.mjs
const { serve, mockCart } = await import('../theme-mock/render.mjs');
const server = await serve(4198);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const bad = [];
page.on('response', (r) => { if (r.status() >= 400 && /cart/.test(r.url())) bad.push(`${r.status()} ${r.url()}`); });
const base = 'http://localhost:4198';
const cart = async () => (await (await fetch(`${base}/cart.js`)).json()).items.map((i) => `${i.title} x${i.quantity} [${i.properties['Ordered in'] || '-'}]`);
const settle = () => page.waitForTimeout(700);
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${JSON.stringify(got)}`}`); if (!ok) process.exitCode = 1; };

// 1. quick add on a card: the ordered-in kit goes in with its note
await page.goto(`${base}/collections/war-game`, { waitUntil: 'networkidle' });
const warriors = page.locator('.product-card', { hasText: 'Necron Warriors' });
await warriors.locator('button[name="add"]').click();
await settle();
let items = await cart();
check('quick add carries the note', items.length === 1 && /Necron Warriors x1 \[From Games Workshop, should be with you by /.test(items[0]), items);

// 2. a line added without a note (as a stale tab or an app would): the cart page puts it right when it shows
await fetch(`${base}/cart/add.js`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: mockCart.lines.length ? (await (await fetch(`${base}/products/gw-last-one.js`)).json()).variants?.[0]?.id ?? 0 : 0, quantity: 2 }) }).catch(() => {});
items = await cart();
if (!items.some((i) => /Lokhust/.test(i))) {
  // the mock's product .js may not know the GW kits: add by the variant id the product page carries
  await page.goto(`${base}/products/gw-last-one`, { waitUntil: 'networkidle' });
  const id = await page.locator('[data-variant-id]').first().inputValue();
  await fetch(`${base}/cart/add.js`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, quantity: 2 }) });
}
await page.goto(`${base}/cart`, { waitUntil: 'networkidle' });
await settle();
items = await cart();
check('the cart page puts a missing note right (1 on the shelf, 1 ordered in)', items.some((i) => /Lokhust Heavy Destroyer x2 \[1 of 2 from Games Workshop, should be with you by /.test(i)), items);
const lineText = await page.locator('[data-gw-line]').allInnerTexts();
check('the cart is drawn again with the split', lineText.some((t) => /1 in store, 1 ordered in/.test(t)), lineText);

// 3. after that, the +/- and remove buttons still work (fresh keys)
const lokhust = page.locator('[data-line]', { hasText: 'Lokhust' });
await lokhust.locator('[data-qty-step="-1"], [data-qty-minus], button[aria-label*="ess"]').first().click().catch(async () => {
  const input = lokhust.locator('[data-qty-input]');
  await input.fill('1');
  await input.dispatchEvent('change');
});
await settle();
items = await cart();
check('a change after the fix works, and the note follows (1, all on the shelf)', items.some((i) => /Lokhust Heavy Destroyer x1 \[-\]/.test(i)), items);
await page.locator('[data-line]', { hasText: 'Necron Warriors' }).locator('[data-qty-remove]').first().click();
await settle();
items = await cart();
check('remove works after the fix', !items.some((i) => /Necron Warriors/.test(i)), items);

// 4. Checkout: a wrong note is put right first, then checkout goes on
await fetch(`${base}/cart/change.js`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: mockCart.lines[0].key, quantity: 3, properties: {} }) });
await page.goto(`${base}/cart`, { waitUntil: 'domcontentloaded' });
let checkoutPosted = null;
page.on('request', (r) => { if (r.method() === 'POST' && /\/cart$/.test(new URL(r.url()).pathname)) checkoutPosted = r.postData(); });
await page.locator('[name="checkout"]').first().click();
await page.waitForTimeout(1500);
items = await cart();
check('checkout waits for the note (3 wanted, 1 on the shelf)', items.some((i) => /Lokhust Heavy Destroyer x3 \[2 of 3 from Games Workshop/.test(i)), items);
check('checkout went on', checkoutPosted !== null && /checkout/.test(checkoutPosted || ''), checkoutPosted);

console.log('cart errors:', bad);
console.log('page errors:', errors);
await browser.close();
server.close();

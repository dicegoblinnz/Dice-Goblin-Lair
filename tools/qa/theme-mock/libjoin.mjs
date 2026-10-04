// Join-flow checks for the library worktree: node libjoin.mjs
import { serve } from './render.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const PORT = Number(process.env.PORT || 4194);
const server = await serve(PORT);
const browser = await chromium.launch();
const parseMultipart = (buf, type) => {
  const text = buf.toString('utf8');
  const out = {};
  if (/multipart/.test(type)) {
    for (const m of text.matchAll(/name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n--/g)) out[m[1]] = m[2];
  } else {
    for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  }
  return out;
};
async function run(label, url, steps) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  const posts = [];
  let failNext = false;
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/cart/add.js', async (route) => {
    const req = route.request();
    posts.push(parseMultipart(req.postDataBuffer() || Buffer.from(''), req.headers()['content-type'] || ''));
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ status: 422, message: 'Cart Error', description: 'Variants can only be purchased with a selling plan' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 1, product_title: 'Board Game Rental Membership', sections: {} }) });
  });
  await page.goto(`http://localhost:${PORT}${url}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const visibleText = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : null;
  }, sel);
  console.log(`\n== ${label} ${url}`);
  await steps({ page, posts, visibleText, fail: () => { failNext = true; } });
  console.log('errors:', errors.length ? errors : 'none');
  await ctx.close();
}

await run('library page join', '/pages/board-game-rental', async ({ page, posts, visibleText, fail }) => {
  console.log('button at start:', await visibleText('.join__button'));
  await page.locator('.plan__card').nth(2).click();
  console.log('after picking Hoard:', await visibleText('.join__button'));
  await page.locator('.plan__card').nth(0).click();
  console.log('after picking Grab:', await visibleText('.join__button'));
  await page.click('.join__button');
  await page.waitForTimeout(300);
  console.log('posts without ticking terms:', posts.length, '| checkbox valid:', await page.evaluate(() => document.querySelector('.join__check input').validity.valid));
  console.log('message when unticked:', await page.evaluate(() => { const e = document.querySelector('.join [data-form-error]'); return e && !e.hidden ? e.textContent : null; }), '| focus on the tick:', await page.evaluate(() => document.activeElement === document.querySelector('.join__check input')));
  await page.click('.join__check');
  console.log('ticked by tapping the label:', await page.evaluate(() => document.querySelector('.join__check input').checked));
  fail();
  await page.click('.join__button');
  await page.waitForTimeout(500);
  console.log('error shown:', await page.evaluate(() => { const e = document.querySelector('.join [data-form-error]'); return e && !e.hidden ? e.textContent : null; }));
  await page.click('.join__button');
  await page.waitForTimeout(600);
  console.log('posted:', JSON.stringify(posts[posts.length - 1]));
  console.log('drawer open:', await page.evaluate(() => !!document.querySelector('cart-drawer dialog[open]')));
});

await run('membership template', '/products/board-game-rental-monthly', async ({ page, posts, visibleText }) => {
  console.log('button at start:', await visibleText('.join__button'));
  await page.locator('.plan__card').nth(2).click();
  await page.click('.join__check');
  await page.click('.join__button');
  await page.waitForTimeout(600);
  console.log('posted:', JSON.stringify(posts[posts.length - 1]));
});

await run('generic plan picker', '/products/board-game-rental-monthly?generic=1', async ({ page, posts, visibleText }) => {
  console.log('price at start:', await visibleText('.product__price, [data-price]'));
  const options = await page.locator('[data-plan-picker] .plan-option').count();
  console.log('plan options:', options);
  await page.locator('[data-plan-picker] .plan-option').nth(2).click();
  await page.waitForTimeout(200);
  console.log('price after picking 3rd plan:', await visibleText('.product__price, [data-price]'), '| url:', page.url().replace(/^http:\/\/localhost:\d+/, ''));
  const btn = page.locator('form[action="/cart/add"] [type="submit"]').first();
  console.log('add button:', (await btn.innerText()).replace(/\s+/g, ' '));
  await btn.click();
  await page.waitForTimeout(600);
  console.log('posted:', JSON.stringify(posts[posts.length - 1]));
});

await browser.close();
server.close();

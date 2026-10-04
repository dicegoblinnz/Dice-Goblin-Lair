// Round 5, the Members tab end to end: the list (sorts, Owes money, search), a member's page (code and QR, owed rows,
// Waive with its confirm, prizes, passes, gifts), birthday gifts (from the page and the birthdays list: credit,
// sessions, rolls, a product from the shop search, the email, the result with the pass and product codes), a member
// with no email, and a gift with problems (?giftfail=). Usage: node members.mjs phone|desktop
import { m, chromium, open, shot, text, overflow, smallTargets, wideOnes, STAFF, PORT } from './lib.mjs';
const tag = process.argv[2] || 'phone';
const server = await m.serve(PORT);
const browser = await chromium.launch();
m.mockState.customer = STAFF;
let { ctx, page } = await open(browser, tag, '/pages/lair-staff');
const log = (...a) => console.log(tag, '|', ...a);
const sleep = (ms) => page.waitForTimeout(ms);
const top = async () => {
  await page.evaluate(() => document.querySelector('.staff-tabs').scrollIntoView({ block: 'start' }));
  await sleep(150);
};
const check = async (label, root = '[data-members]') => {
  log(`${label}: overflow ${await overflow(page)}, small targets ${JSON.stringify(await smallTargets(page, root))}`);
  const wide = await wideOnes(page);
  if (wide.length) log('  wide:', JSON.stringify(wide));
};
const rows = () => page.$$eval('.staff-mem-row', (els) => els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()));

// ---------- 1. the list: by spend, recent, owing, and Owes money ----------
await page.click('[data-tab="members"]');
await sleep(600);
log('by spend:', (await rows()).slice(0, 3).join(' || '));
await top();
await shot(page, `${tag}-m1-list-spend`);
await check('list');
await page.click('[data-members-sort="recent"]');
await sleep(500);
log('by recent:', (await rows()).slice(0, 3).map((r) => r.slice(0, 60)).join(' || '));
await page.click('[data-members-sort="owing"]');
await sleep(500);
log('by owing:', (await rows()).slice(0, 5).map((r) => r.slice(0, 80)).join(' || '));
await page.click('[data-members-owing]');
await sleep(500);
log('owes money only:', (await rows()).map((r) => r.slice(0, 90)).join(' || '), '| count line:', await text(page, '.staff-mem-count'));
await top();
await shot(page, `${tag}-m2-owing`);
// search keeps the sort and the filter
await page.fill('#members-find', 'tama');
await sleep(600);
log('search "tama" (owing):', (await rows()).join(' || '));

// ---------- 2. Tama's page: code and QR, two owed sessions, Waive asks first ----------
await page.click('.staff-mem-row');
await sleep(800);
await top();
log('page card:', (await text(page, '[data-person-card]')).slice(0, 220));
log('owed:', await text(page, '[data-person-owed]'));
log('passes:', (await text(page, '[data-person-passes]')).slice(0, 200));
log('gifts:', await text(page, '[data-person-gifts]'));
const qr = await page.$eval('[data-person-card] svg.qr', (svg) => `${svg.getAttribute('width')}px ${svg.getAttribute('aria-label')}`).catch(() => 'no QR');
log('QR:', qr);
await shot(page, `${tag}-m3-person`);
await check('member page');
await page.click('[data-person-owed] [data-waive]');
await sleep(300);
log('waive asks:', await text(page, '[data-person-owed] .staff-confirm'));
await page.$eval('[data-person-owed] .staff-confirm', (el) => el.scrollIntoView({ block: 'center' }));
await shot(page, `${tag}-m4-waive-ask`, '[data-person-owed]');
await check('waive confirm', '[data-person-owed]');
await page.click('[data-waive-no]');
await sleep(200);
log('kept:', (await text(page, '[data-person-owed]')).slice(0, 120));
await page.click('[data-person-owed] [data-waive]');
await sleep(200);
await page.click('[data-waive-yes]');
await sleep(900);
log('toast:', await text(page, '.toast'));
log('after waive:', await text(page, '[data-person-owed]'));
log('card badges:', await text(page, '.staff-person__badges'));
await shot(page, `${tag}-m5-waived`, '[data-person-owed]');

// ---------- 3. a gift from the page: credit (prefilled), sessions, rolls, a product, a note, the email ----------
await page.click('[data-gift-open]');
await sleep(500);
await top();
log('gift form:', (await text(page, '.staff-gift')).slice(0, 400));
log('credit prefilled:', await page.inputValue('#gift-credit'));
await shot(page, `${tag}-m6-gift-form`);
await check('gift form');
// nothing picked: it says so
await page.fill('#gift-credit', '');
await page.click('[data-gift-form] button[type="submit"]');
await sleep(400);
log('nothing picked:', await text(page, '[data-gift-form] [data-form-error]'));
await page.fill('#gift-credit', '7.50');
for (let i = 0; i < 3; i += 1) await page.click('.staff-gift__count:nth-child(1) [data-seats-step="1"]');
for (let i = 0; i < 2; i += 1) await page.click('.staff-gift__count:nth-child(2) [data-seats-step="1"]');
log('steppers:', await page.inputValue('[name="sessions"]'), await page.inputValue('[name="rolls"]'));
await page.fill('#gift-product', 'wing');
await sleep(800);
log('search results:', await text(page, '[data-gift-results]'));
await shot(page, `${tag}-m7-product-search`, '.staff-gift__product');
await check('product results', '.staff-gift__product');
await page.click('[data-gift-pick]');
await sleep(600);
log('picked:', await text(page, '[data-gift-product]'));
await page.fill('#gift-note', 'Happy birthday from all of us!');
await page.$eval('[data-gift-form] button[type="submit"]', (el) => el.scrollIntoView({ block: 'center' }));
await shot(page, `${tag}-m8-gift-ready`, '.staff-gift');
await page.click('[data-gift-form] button[type="submit"]');
await sleep(900);
await top();
log('result:', await text(page, '.staff-gift--done'));
await shot(page, `${tag}-m9-gift-done`);
await check('gift result');
// back to the page: the gift's there, and the pass
await page.click('.staff-gift--done [data-member-view]');
await sleep(900);
log('gifts now:', await text(page, '[data-person-gifts]'));
log('passes now:', (await text(page, '[data-person-passes]')).slice(0, 260));
log('badges now:', await text(page, '.staff-person__badges'));
await page.$eval('[data-person-gifts]', (el) => el.scrollIntoView({ block: 'center' }));
await shot(page, `${tag}-m10-person-after-gift`);

// ---------- 4. birthdays: the suggested range, Gifted, and a gift from there ----------
await page.click('[data-members-back]');
await sleep(600);
await page.$eval('[data-birthdays]', (el) => el.scrollIntoView({ block: 'start' }));
await sleep(200);
log('birthdays:', await text(page, '[data-birthdays]'));
await shot(page, `${tag}-m11-birthdays`, '[data-birthdays]');
await check('birthdays', '[data-birthdays]');
const marcus = await page.$('.staff-birthday:has-text("Marcus") [data-gift-open]');
await marcus.click();
await sleep(500);
log('from birthdays, back says:', await text(page, '[data-gift-back]'), '| hint:', await text(page, '#gift-credit-hint'));
await page.click('[data-gift-form] button[type="submit"]');
await sleep(900);
log('Marcus result:', await text(page, '.staff-gift--done'));
await page.click('[data-gift-back]');
await sleep(600);
log('birthdays after:', (await text(page, '.staff-birthday:has-text("Marcus")')));

// ---------- 5. no email on file (Wiremu): Email them is off ----------
await page.click('[data-members-owing]'); // Owes money off again
await sleep(400);
await page.fill('#members-find', 'wiremu');
await sleep(700);
await page.click('.staff-mem-row');
await sleep(800);
await page.click('[data-gift-open]');
await sleep(400);
log('Wiremu email box:', await page.$eval('[name="notify"]', (el) => `checked=${el.checked} disabled=${el.disabled}`), '|', await text(page, '.staff-gift__email'));
await page.$eval('.staff-gift__email', (el) => el.scrollIntoView({ block: 'center' }));
await shot(page, `${tag}-m12-no-email`, '.staff-gift__form');
log('errors so far', JSON.stringify(page.errors));
await ctx.close();

// ---------- 6. problems: Shopify says no to the credit and the product code ----------
({ ctx, page } = await open(browser, tag, '/pages/lair-staff', { query: '?giftfail=credit,product#members' }));
await page.waitForTimeout(600);
log('deep link opened:', await page.getAttribute('#tab-members', 'aria-selected'));
await page.fill('#members-find', 'priya');
await page.waitForTimeout(700);
await page.click('.staff-mem-row');
await page.waitForTimeout(800);
await page.click('[data-gift-open]');
await page.waitForTimeout(400);
await page.click('.staff-gift__count:nth-child(1) [data-seats-step="1"]');
// a product with more than one variant: the shop's search sends the drinks (reachable by handle in the mock)
await page.route('**/search/suggest.json*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ resources: { results: { products: [
  { title: 'Drinks', handle: 'drinks', url: '/products/drinks', price: '2.00', tags: [], image: '/img/drinks__600x600.svg?x=1' },
  { title: 'Library game 1 (Library)', handle: 'library-copy-1', url: '/products/library-copy-1', price: '0.00', tags: ['Board Game Rental'] },
  { title: 'Dice Goblin gift card', handle: 'gift-card', url: '/products/gift-card', price: '25.00', tags: [], type: 'Gift Card' },
] } } }) }));
await page.fill('#gift-product', 'drink');
await page.waitForTimeout(800);
log('results (no library copy, no gift card):', await text(page, '[data-gift-results]'));
await page.click('[data-gift-pick]');
await page.waitForTimeout(600);
log('variants:', await page.$$eval('#gift-variant option', (os) => os.map((o) => `${o.value}${o.selected ? '*' : ''} ${o.textContent}`).join(' | ')));
await page.selectOption('#gift-variant', { index: 2 });
await page.$eval('.staff-gift__product', (el) => el.scrollIntoView({ block: 'center' }));
await shot(page, `${tag}-m13a-variant`, '.staff-gift__product');
await page.click('[data-gift-form] button[type="submit"]');
await page.waitForTimeout(900);
await page.evaluate(() => document.querySelector('.staff-tabs').scrollIntoView({ block: 'start' }));
log('with problems:', await text(page, '.staff-gift--done'));
await shot(page, `${tag}-m13-gift-problems`);
log('sent body:', JSON.stringify(await page.evaluate(() => { const st = document.querySelector('lair-staff').members.sent; const k = Object.keys(st)[0]; return st[k][0].body; })));
// the variant picker on a product with more than one (a tab menu product isn't searchable; Pokémon booster has one)
log('errors', JSON.stringify(page.errors));
await ctx.close();
await browser.close();
server.close();

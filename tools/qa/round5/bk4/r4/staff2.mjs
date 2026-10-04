// Staff page regressions and links, round 4: a code typed into the Today search checks in; a booking for another
// day (Check in anyway); an event sign-up checked in from Today; "Member details" and "Open the pass" from the
// check-in card; GM games (manage, add a player found by member code, edit, cancel); shop table openings; holds.
// Usage: node staff2.mjs phone|desktop
import { m, chromium, open, shot, text, overflow, STAFF } from './lib.mjs';
const tag = process.argv[2] || 'phone';
const server = await m.serve(Number(process.env.QA_PORT || 4311));
const browser = await chromium.launch();
m.mockState.customer = STAFF;
const { ctx, page } = await open(browser, tag, '/pages/lair-staff');
const log = (...a) => console.log(tag, '|', ...a);
const sleep = (ms) => page.waitForTimeout(ms);
const card = () => text(page, '[data-checkin-result]');

// a code typed into Today's search box checks them in
await page.click('[data-tab="today"]');
const mia = await page.evaluate(() => window.Lair.store.data.bookings.find((b) => b.name === 'Mia' && b.status === 'confirmed').ref);
await page.fill('#staff-find', mia.toLowerCase());
await page.press('#staff-find', 'Enter');
await sleep(600);
log('code in the search box:', (await card()).slice(0, 110), '| search box now:', JSON.stringify(await page.inputValue('#staff-find')));

// another day's booking: Not today, then Check in anyway
const later = await page.evaluate(() => {
  const { store } = window.Lair;
  return store.data.bookings.find((b) => b.kind === 'table' && b.status === 'confirmed' && store.time.key(b.start) !== store.time.today()).ref;
});
await page.fill('#checkin-code', later);
await page.press('#checkin-code', 'Enter');
await sleep(500);
log('another day:', (await card()).slice(0, 140));
await page.click('[data-checkin-force]');
await sleep(500);
log('anyway:', (await card()).slice(0, 80));
await page.click('[data-checkin-clear]');

// an event sign-up from Today's list
await page.click('[data-tab="today"]');
await sleep(300);
const joinBtn = await page.$('[data-act="checkin-join"]');
log('sign-ups:', (await text(page, '[data-joins]')).slice(0, 200));
if (joinBtn) {
  await joinBtn.click();
  await sleep(600);
  log('sign-up checked in:', (await card()).slice(0, 160));
  await shot(page, `${tag}-r1-join`, '.checkin');
} else log('(no sign-ups today to check in)');

// member card → Member details
const sam = await page.evaluate(() => window.Lair.store.backend.staffMembers().find((x) => x.firstName === 'Sam').code);
await page.fill('#checkin-code', sam);
await page.press('#checkin-code', 'Enter');
await sleep(500);
await page.click('[data-checkin-result] [data-member-view]'); // round 5: opens their page
await sleep(700);
log('Member details →', await page.getAttribute('#tab-members', 'aria-selected'), '|', (await text(page, '[data-members]')).slice(0, 160));
// a pass → Open the pass
const league = await page.evaluate(() => window.Lair.store.backend.passList().find((p) => p.label === 'Warhammer league').code);
await page.fill('#checkin-code', league);
await page.press('#checkin-code', 'Enter');
await sleep(500);
await page.click('[data-pass-open]');
await sleep(700);
log('Open the pass →', await page.getAttribute('#tab-passes', 'aria-selected'), '|', (await text(page, '[data-pass-card]')).slice(0, 90));
await page.click('[data-checkin-clear]');

// GM games: manage the first coming up, add a player found by member code, edit, cancel
await page.click('[data-tab="games"]');
await sleep(300);
await page.click('.staff-gm-row');
await sleep(400);
const title = await text(page, '[data-panel="games"] .staff-gm__head h3');
const grace = await page.evaluate(() => window.Lair.store.backend.staffMembers().find((x) => x.firstName === 'Grace').code);
await page.fill('#find-add', grace.toLowerCase());
await sleep(600);
log('member finder by code:', (await text(page, '[data-member-results="add"]')).slice(0, 120));
await page.click('[data-member-pick][data-key="add"]');
await sleep(200);
await page.click('[data-gm-add] button[type="submit"]');
await sleep(500);
log('added:', await text(page, '.toast'), '|', (await text(page, '[data-gm-players]')).slice(-140));
await page.click('[data-panel="games"] .staff-gm__more summary');
await page.fill('#gm-edit-title', `${title} (edited)`);
await page.click('[data-gm-edit] button[type="submit"]');
await sleep(500);
log('edited:', await text(page, '.toast'), '|', await text(page, '[data-panel="games"] .staff-gm__head h3'));
await shot(page, `${tag}-r2-gm-manager`);
await page.click('[data-gm-cancel-wrap] summary');
await page.click('[data-gm-cancel="session"]');
await page.click('[data-gm-cancel="session"]');
await sleep(500);
log('cancelled:', await text(page, '.toast'));

// a shop table opening, and a hold
await page.click('[data-tab="floor"]');
await sleep(300);
await page.evaluate(() => document.querySelector('[data-table="T2"]').click());
await sleep(300);
await page.click('[data-opening-form] button[type="submit"]');
await sleep(500);
log('opening:', await text(page, '.toast'));
await page.click('[data-tab="holds"]');
await sleep(300);
await page.fill('#holdx-tables', 'T18-T19');
await page.fill('#holdx-label', 'Pokémon prerelease');
await page.click('[data-panel="holds"] [data-hold-form] button[type="submit"]');
await sleep(500);
log('hold:', await text(page, '.toast'));
log('overflow', await overflow(page), 'errors', page.errors);
await ctx.close();
await browser.close();
server.close();

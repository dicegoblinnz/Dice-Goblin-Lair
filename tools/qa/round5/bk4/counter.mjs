// Round 5 at the counter and on the Passes tab: a member code with owed sessions (Waive on the check-in card, the
// total split into today and owed), an owed seat's own code (Owed card: Mark paid, Waive), the Passes tab's sources
// (bought online #1550, at the counter #1553 with no customer on the sale, birthday gift, issued by staff), an
// unlinked pass opened and scanned. Usage: node counter.mjs phone|desktop
import { m, chromium, open, shot, text, overflow, smallTargets, wideOnes, STAFF, PORT } from './lib.mjs';
const tag = process.argv[2] || 'phone';
const server = await m.serve(PORT);
const browser = await chromium.launch();
m.mockState.customer = STAFF;
const { ctx, page } = await open(browser, tag, '/pages/lair-staff');
const log = (...a) => console.log(tag, '|', ...a);
const sleep = (ms) => page.waitForTimeout(ms);
const card = () => text(page, '[data-checkin-result]');
const type = async (code) => {
  await page.fill('#checkin-code', code);
  await page.press('#checkin-code', 'Enter');
  await sleep(700);
};
const check = async (label, root) => {
  log(`${label}: overflow ${await overflow(page)}, small targets ${JSON.stringify(await smallTargets(page, root))}`);
  const wide = await wideOnes(page);
  if (wide.length) log('  wide:', JSON.stringify(wide));
};
const toCard = () => page.evaluate(() => document.querySelector('.checkin').scrollIntoView({ block: 'start' }));

// ---------- 1. Tama's member code: today's booking, two owed sessions, Waive on the card ----------
const tama = await page.evaluate(() => window.Lair.store.backend.staffMembers().find((x) => x.firstName === 'Tama'));
await type(tama.code.toLowerCase().replace(/-/g, ' '));
log('member card:', await card());
await toCard();
await shot(page, `${tag}-c1-member-owed`, '.checkin');
await check('member card', '[data-checkin-result]');
await page.click('[data-checkin-result] [data-waive]');
await sleep(300);
log('asks:', await text(page, '[data-checkin-result] .staff-confirm'));
await shot(page, `${tag}-c2-member-waive-ask`, '[data-checkin-result]');
await page.click('[data-checkin-result] [data-waive-yes]');
await sleep(900);
log('after waive:', await card());
log('toast:', await text(page, '.toast'));
await shot(page, `${tag}-c3-member-waived`, '[data-checkin-result]');
// check in today's booking from the card, then back to the card: the waived one stays waived
if (await page.$('[data-checkin-result] [data-checkin-row]')) {
  await page.click('[data-checkin-result] [data-checkin-row]');
  await sleep(700);
  log('checked in from the card:', (await card()).slice(0, 140));
  await page.click('[data-checkin-card]');
  await sleep(800);
  log('back on the card:', await card());
} else log('(nothing for Tama to check in today at this hour)');

// ---------- 2. an owed seat's own code (Priya's): the Owed card ----------
const priyaSeat = await page.evaluate(() => {
  const { store } = window.Lair;
  const b = store.data.bookings.find((x) => x.owed && x.name === 'Priya Nair');
  return b ? b.ref : null;
});
log('Priya owed seat ref:', priyaSeat);
if (priyaSeat) {
  await type(priyaSeat);
  log('owed card:', await card());
  await toCard();
  await shot(page, `${tag}-c4-owed-card`, '.checkin');
  await check('owed card', '[data-checkin-result]');
  await page.click('[data-checkin-result] [data-waive]');
  await sleep(300);
  await page.click('[data-checkin-result] [data-waive-yes]');
  await sleep(900);
  log('owed card after waive:', await card());
  await shot(page, `${tag}-c5-owed-waived`, '.checkin');
}
// Tama's other owed session, scanned on its own and paid at the counter: Mark paid, and the card says Paid
await type(tama.code);
const left = await page.$('[data-checkin-result] .staff-owed__row:not(.is-waived) [data-waive]');
log('Tama still owes:', Boolean(left), '|', (await card()).slice(0, 260));
const tamaSeat = await page.evaluate(() => (window.Lair.store.data.bookings.find((x) => x.owed && x.name === 'Tama Rewiti') || {}).ref);
await type(tamaSeat);
log('Tama owed card:', (await card()).slice(0, 160));
await page.click('[data-checkin-result] [data-checkin-paid]');
await sleep(800);
log('after Mark paid:', await card());
await toCard();
await shot(page, `${tag}-c5a-owed-paid`, '.checkin');
await type(tama.code);
log('Tama now:', await card());

// ---------- 3. the Passes tab: where each pass came from, and the one with no customer on the sale ----------
await page.click('[data-tab="passes"]');
await sleep(700);
await page.click('[data-pass-status="all"]');
await sleep(600);
log('pass rows:', (await page.$$eval('.staff-pass-row', (els) => els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()))).join(' || '));
await page.evaluate(() => document.querySelector('.staff-tabs').scrollIntoView({ block: 'start' }));
await shot(page, `${tag}-c6-passes`);
await check('passes list', '[data-passes]');
await page.click('.staff-pass-row:has-text("#1553")');
await sleep(700);
log('unlinked pass page:', (await text(page, '[data-pass-card]')).slice(0, 400));
await page.evaluate(() => document.querySelector('.staff-tabs').scrollIntoView({ block: 'start' }));
await shot(page, `${tag}-c7-pass-unlinked`);
await check('pass page', '[data-passes]');
const unlinked = await page.evaluate(() => window.Lair.store.backend.passList().find((p) => p.orderName === '#1553').code);
await type(unlinked);
log('unlinked pass scanned:', await card());
await toCard();
await shot(page, `${tag}-c8-pass-scanned`, '.checkin');
const hemi = await page.evaluate(() => window.Lair.store.backend.passList().find((p) => p.orderName === '#1550').code);
await type(hemi);
log('order pass scanned:', await card());
log('errors', JSON.stringify(page.errors));
await ctx.close();
await browser.close();
server.close();

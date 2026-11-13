// Round 37, going live in two steps: the theme first, then the Lair app. This runs the NEW theme (live mode) against
// the Lair app AS IT IS DEPLOYED NOW (a checkout of main from before round 37), at phone size, and checks that every
// page this round touches works as it did, with none of the new parts showing: no perk card, no Books for the table,
// no books on Games I run, no "a table would like this" on a book's page, no GM perk on a member's page, and the Library
// tab's GM perks list stays away. And nothing errors.
// Start the OLD Lair's stack first, from its own checkout:  DG_THEME=/path/to/theme sh /path/to/lair-main/tools/qa/live/up.sh
// Usage (from this checkout): DG_THEME=/path/to/theme node tools/qa/round37-gm-perk/compat.mjs
import { start, stop, context, page, overflow, apiLog, PHONE, BASE } from '../live/harness.mjs';
import { check, summary, proxy, fake } from '../live/client.mjs';
import { key, addDays, at } from '../live/r6-time.mjs';

const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const ANA = '7103';
const SAM = '7101';
const MO = '7001';
const names = { [MO]: 'Mo Ashgrove', [SAM]: 'Sam Jones', [ANA]: 'Ana Rangi' };
for (const [id, name] of Object.entries(names)) {
  await proxy('GET', `me?name=${encodeURIComponent(name)}`, { customer: id });
  await proxy('POST', 'me/profile', { customer: id, body: { name, firstName: name.split(' ')[0], email: `${name.split(' ')[0].toLowerCase()}@example.com` } });
}
const floor = (await proxy('GET', 'floor')).data;
check('this is a Lair from before round 37 (the floor has no features.books)', floor.features && floor.features.books === undefined, floor.features);
// Sam has a game at home (staff lent it), so My Library and the staff's Games at home have a row to draw
await fake('POST', 'variant-code', { id: '48100000000006', productId: '81000000000006', handle: 'codenames', productTitle: 'Codenames (Library)', sku: 'DGL7+-015', barcode: 'DGL7+-015', price: '0.00', libraryCode: 'DGL7+-015' });
await fake('POST', 'variant', { id: '48100000000006', quantity: 1, tracked: true });
const lent = await proxy('POST', 'library/loans', { customer: MO, body: { customerId: SAM, code: 'DGL7+-015' } });
check('staff lend Sam a game on the old Lair', lent.status === 200 && lent.data.loan?.perk === undefined, lent.data.error || Object.keys(lent.data.loan || {}).join());
// Ana runs a weekly game; the old Lair takes no notice of books sent with it
const W = addDays(key(Date.now()), 4);
const listed = await proxy('POST', 'games', { customer: ANA, body: { title: 'The Ember Road', system: 'D&D 5e', gm: 'Ana', email: 'ana@example.com', blurb: 'A caravan and a cursed road.', seats: 4, tables: ['T16'], start: at(W, 18), end: at(W, 21), gmFee: 500, schedule: 'weekly', books: ['48100000000010'] } });
check('a game listed with books: the old Lair lists it and ignores them', listed.status === 200 && listed.data.game?.status === 'open' && listed.data.game.books === undefined && listed.data.perk === undefined, listed.data.error || Object.keys(listed.data.game || {}).join());

await start();
const problems = [];
const openLibrary = async (pg) => {
  await pg.goto(`${BASE}/pages/my-lair#library`, { waitUntil: 'networkidle' });
  await pg.waitForSelector('my-library .mlib', { timeout: 15000 });
  await pg.waitForTimeout(400);
};

/* Ana, a GM */
const ana = await context(ANA, PHONE);
const p = await page(ana, 'phone/ana');
await openLibrary(p);
let t = flat(await p.locator('my-library').innerText());
check('My Library (a GM, no plan): the invite to join, as before, and no perk card', t.startsWith('Join the library') && (await p.locator('my-library .mlib-perk').count()) === 0 && !t.includes('GM perk'), t.slice(0, 160));
await p.goto('about:blank');
await p.goto(`${BASE}/pages/my-lair#bookings`, { waitUntil: 'networkidle' });
await p.waitForSelector('article.ml-game', { timeout: 15000 });
t = flat(await p.locator('article.ml-game', { hasText: 'The Ember Road' }).first().innerText());
check('Games I run: her game\'s card as before, with no books part', (await p.locator('lair-game-books').count()) === 0 && t.includes('The Ember Road') && !t.includes('Books for the table'), t.slice(0, 200));
await p.goto(`${BASE}/pages/gm-games#host`, { waitUntil: 'networkidle' });
await p.waitForSelector('lair-session-form [data-host-form]', { timeout: 15000 });
const form = p.locator('lair-session-form');
await form.locator('[name="title"]').fill('Another game');
await form.locator('[data-system-chips] .chip', { hasText: 'D&D 5e' }).click();
await form.locator('[name="blurb"]').fill('Just checking the steps.');
await p.locator('[data-step-next]').click();
await p.waitForSelector('lair-session-form [data-step="players"]');
await form.locator('[name="level"]').first().check({ force: true });
await form.locator('.chip', { hasText: '13+' }).click();
await p.locator('[data-step-next]').click();
await p.waitForSelector('lair-session-form [data-step="table"]');
t = flat(await form.innerText());
check('Run a game, step 3: What to bring then Safety tools, with no Books for the table', (await form.locator('[data-sf-books]').count()) === 0 && t.includes('What to bring') && t.includes('Safety tools') && !t.includes('Books for the table'), t.slice(0, 200));
const sent = await p.evaluate(() => {
  const el = document.querySelector('lair-session-form');
  Object.assign(el.draft, { day: window.Lair.store.time.today(), start: 18 * 60, hours: 3 });
  return Object.keys(el.payload()).includes('books');
});
check('and the game would be sent with no books', sent === false);
check('no sideways scroll', (await overflow(p)) <= 0, await overflow(p));

/* Sam, with a lent game at home */
const sam = await context(SAM, PHONE);
const ps = await page(sam, 'phone/sam');
await openLibrary(ps);
t = flat(await ps.locator('my-library').innerText());
check('My Library (a lent game): the game, tagged Lent, as before', t.includes('Codenames') && (await ps.locator('my-library .mlib-item .mlib-tag', { hasText: 'Lent' }).count()) === 1 && (await ps.locator('my-library .mlib-perk, my-library .mlib-tag--wanted, my-library [data-heads]').count()) === 0, t.slice(0, 200));
await ps.goto(`${BASE}/products/d-d-bigby-library`, { waitUntil: 'networkidle' });
await ps.waitForSelector('library-reserve', { timeout: 15000 });
await ps.waitForTimeout(800);
t = flat(await ps.locator('library-reserve').innerText());
check('a library book\'s page: its usual status, and no "a table would like this"', t.length > 20 && (await ps.locator('library-reserve .library-reserve__wanted').count()) === 0, t.slice(0, 200));

/* Mo, staff */
const mo = await context(MO, PHONE);
const pm = await page(mo, 'phone/mo');
await openLibrary(pm);
t = flat(await pm.locator('my-library').innerText());
check('My Library (staff): no staff slot card', (await pm.locator('my-library .mlib-perk').count()) === 0 && !t.includes('Staff slot'), t.slice(0, 120));
await pm.goto(`${BASE}/pages/lair-staff`, { waitUntil: 'networkidle' });
await pm.waitForFunction(() => typeof document.querySelector('lair-staff')?.openMember === 'function' && document.querySelector('[data-library]'), null, { timeout: 15000 });
await pm.evaluate((id) => document.querySelector('lair-staff').openMember(id), ANA);
await pm.waitForSelector('[data-person-card] .staff-person__name', { timeout: 15000 });
await pm.waitForFunction(() => !/Looking up what they owe/.test(document.querySelector('[data-person-owed]')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
await pm.waitForTimeout(500);
check('a member\'s page: as before, with the GM perk section hidden', (await pm.locator('[data-person-perk]').count()) === 1 && (await pm.locator('[data-person-perk]').isHidden()) && flat(await pm.locator('[data-person-card]').innerText()).includes('Ana Rangi'));
await pm.evaluate(() => document.querySelector('lair-staff').setTab('library'));
await pm.waitForSelector('[data-lib-loans] .staff-lib-rows', { timeout: 15000 });
await pm.waitForTimeout(1500);
t = flat(await pm.locator('[data-lib-loans] .staff-loan', { hasText: 'Codenames' }).innerText());
check('Games at home: Sam\'s lent game, tagged Lent, as before', t.includes('Sam Jones') && t.includes('Lent') && !t.includes('GM perk') && !t.includes('Wanted'), t.slice(0, 200));
const asked = apiLog.filter((c) => c.route === 'gm-perks');
check('the GM perks list asked once, got a 404 from the old Lair, and stays away', asked.length === 1 && asked[0].status === 404 && (await pm.locator('staff-gm-perks').isHidden()), asked.map((c) => c.status));
check('the staff page: no sideways scroll', (await overflow(pm)) <= 0, await overflow(pm));
problems.push(...p.problems, ...ps.problems, ...pm.problems);
const real = problems.filter((x) => !/console: Failed to load resource: the server responded with a status of 404/.test(x));
check('no script errors, failed requests or 500s on any page', real.length === 0, real.slice(0, 5).join(' | '));

await stop();
process.exit(summary() ? 1 : 0);

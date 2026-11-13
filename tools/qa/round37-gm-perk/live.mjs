// Round 37 (14 Nov 2026), the GM perk, the staff slot and a game's books (contract v37-gm-perk): the theme in live
// mode against the real Lair app (wrangler dev) and the fake Shopify, at phone size. It checks that the pages and the
// app agree: the routes the pages call, the shapes they read and the words they show.
//   0. The library's catalogue: four RPG books and a board game in the fake Shopify, read by the Lair's own sync.
//   1. Ana (a trusted GM, no library plan) lists a weekly game from Run a game: the floor says the Lair knows books
//      (features.books), step 3's search asks GET /library/books, and the game is listed with its book (POST /games).
//      Her GM perk goes on, and Gobgob emails her once.
//   2. Her My Library: the perk's card; a board game refused; the Player's Handbook goes home free, and the heads-up
//      about Leo's game shows in a box of its own; the card then shows the book.
//   3. Games I run: her game's books and where each is; Change the books saves through POST /games/:id/books, for this
//      and every later session.
//   4. Sam (no plan, no perk) on the book's page: which table would like it; Ana sees her own game's.
//   5. Mo (staff): the staff slot's card; Ana's member page (GM perk on, the log; Take it away and Give ask first and
//      go through POST /members/:id/gm-perk); the Library tab's badges and the GM perks list (GET /gm-perks).
// Start the stack first: DG_THEME=/path/to/theme sh tools/qa/live/up.sh   (and sh tools/qa/live/down.sh after)
// Usage: DG_THEME=/path/to/theme node tools/qa/round37-gm-perk/live.mjs
import fs from 'node:fs';
import { start, stop, context, page, overflow, text, apiLog, PHONE, BASE } from '../live/harness.mjs';
import { check, summary, proxy, fake, WORKER } from '../live/client.mjs';
import { key, addDays, at, sleep } from '../live/r6-time.mjs';

const OUT = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const ANA = '7103';
const LEO = '7104';
const SAM = '7101';
const MO = '7001';
const maintenance = async () => (await fetch(`${WORKER}/setup?key=test-setup-key`)).json().catch(() => null);
const emailsTo = async (to, from = 0) => (await fake('GET', 'emails')).slice(from).filter((e) => [].concat(e.to).includes(to));
const lastCall = (method, re) => [...apiLog].reverse().find((c) => c.method === method && re.test(c.route));

/* ---------- 0. the catalogue ---------- */
// (the mock store's own RPG library copy keeps its ids, so its page can be asked about: variant 48100000000010)
const BOOKS = [
  { id: '48100000000010', productId: '81000000000010', handle: 'd-d-bigby-library', productTitle: 'D&D Bigby Presents Glory of the Giants (Library)', libraryCode: 'DGLRPG-008' },
  { id: '48200000000001', productId: '82000000000001', handle: 'd-d-players-handbook-library', productTitle: "Dungeons & Dragons Player's Handbook (5th Edition) (Library)", libraryCode: 'DGLRPG-012' },
  { id: '48200000000002', productId: '82000000000002', handle: 'blades-in-the-dark-library', productTitle: 'Blades in the Dark (Library)', libraryCode: 'DGLRPG-005' },
  { id: '48200000000003', productId: '82000000000003', handle: 'd-d-monster-manual-library', productTitle: 'Dungeons & Dragons Monster Manual (5th Edition) (Library)', libraryCode: 'DGLRPG-011' },
];
const CATAN = { id: '48200000000009', productId: '82000000000009', handle: 'catan-library', productTitle: 'Catan (Library)', libraryCode: 'DGL34-M011' };
for (const b of [...BOOKS, CATAN]) {
  await fake('POST', 'variant-code', { ...b, sku: b.libraryCode, barcode: b.libraryCode, price: '0.00', tags: b === CATAN ? ['Board Game Rental'] : ['Board Game Rental', 'RPG', 'Shelf RPG books'] });
  await fake('POST', 'variant', { id: b.id, quantity: 1, tracked: true });
}
await fake('POST', 'set', { pickCatalog: true });
const names = { [MO]: 'Mo Ashgrove', [SAM]: 'Sam Jones', [ANA]: 'Ana Rangi', [LEO]: 'Leo Tane' };
for (const [id, name] of Object.entries(names)) {
  await proxy('GET', `me?name=${encodeURIComponent(name)}`, { customer: id });
  await proxy('POST', 'me/profile', { customer: id, body: { name, firstName: name.split(' ')[0], email: `${name.split(' ')[0].toLowerCase()}@example.com` } });
}
await maintenance();
await sleep(600);
let found = (await proxy('GET', 'library/books?q=', { customer: ANA })).data;
if (!(found.books || []).length) {
  // (the sync runs on the first maintenance after the Lair starts: one more, in case the scopes weren't read yet)
  await maintenance();
  await sleep(600);
  found = (await proxy('GET', 'library/books?q=', { customer: ANA })).data;
}
check('0: the Lair\'s own sync read the RPG shelf from Shopify (4 books, A to Z, no board game)', (found.books || []).map((b) => b.shelfCode).join() === 'DGLRPG-005,DGLRPG-008,DGLRPG-011,DGLRPG-012',
  (found.books || []).map((b) => `${b.title} ${b.shelfCode}`).join(' | ') || found.error);
const floor = (await proxy('GET', 'floor')).data;
check('0: the floor says this Lair knows a game\'s books (features.books)', floor.features && floor.features.books === true, floor.features);

await start();
const problems = [];
const notFound = [];
const watch = (pg) => pg.on('response', (r) => {
  if (r.status() === 404) notFound.push(new URL(r.url()).pathname);
});
const mails0 = (await fake('GET', 'emails')).length;

// Leo runs a one-shot that names the Player's Handbook (so someone else's table wants it): staff list it for him
const D = addDays(key(Date.now()), 9);
const leos = await proxy('POST', 'games', { customer: MO, body: { title: 'The Lantern Street Job', system: 'D&D 5e', gm: 'Leo', blurb: 'One last score.', seats: 4, tables: ['T17'], start: at(D, 18), end: at(D, 21), gmFee: 500, gmCustomerId: LEO, gmCustomerName: 'Leo Tane', gmEmail: 'leo@example.com', email: 'leo@example.com', books: ['48200000000001'] } });
check('staff list Leo\'s game with its book', leos.status === 200 && (leos.data.game?.books || []).map((b) => b.shelfCode).join() === 'DGLRPG-012', leos.data.error || leos.data.game?.books);

/* ---------- 1. Ana lists a weekly game from Run a game ---------- */
const ana = await context(ANA, PHONE);
const p = await page(ana, 'phone/ana');
watch(p);
await p.goto(`${BASE}/pages/gm-games#host`, { waitUntil: 'networkidle' });
await p.waitForSelector('lair-session-form [data-host-form]', { timeout: 15000 });
const form = p.locator('lair-session-form');
await form.locator('[name="title"]').fill('The Ember Road');
await form.locator('[data-system-chips] .chip', { hasText: 'D&D 5e' }).click();
await form.locator('[name="blurb"]').fill('A caravan, a cursed road, and too many goblins.');
await p.locator('[data-step-next]').click();
await p.waitForSelector('lair-session-form [data-step="players"]');
await form.locator('[name="level"]').first().check({ force: true });
await form.locator('.chip', { hasText: '13+' }).click();
await p.locator('[data-step-next]').click();
await p.waitForSelector('lair-session-form [data-step="table"]');
check('1: step 3 has Books for the table on a Lair that knows books', (await form.locator('[data-sf-books]').count()) === 1 && flat(await form.locator('[data-sf-books] .field__label').innerText()).startsWith('Books for the table'));
const b0 = apiLog.length;
await form.locator('[data-sf-book-search]').fill('monster manual');
await p.waitForSelector('lair-session-form .sf-found', { timeout: 8000 }).catch(() => {});
const asked = apiLog.slice(b0).find((c) => c.method === 'GET' && /^library\/books\?q=monster%20manual$/.test(c.route));
check('1: the search asks GET /library/books?q= (every word of it)', asked && asked.status === 200, apiLog.slice(b0).map((c) => `${c.method} ${c.route} ${c.status}`).join(' | '));
check('1: and lists what the Lair found, with its shelf code', flat(await form.locator('[data-sf-book-results]').innerText()) === 'Dungeons & Dragons Monster Manual (5th Edition) DGLRPG-011 Add', flat(await form.locator('[data-sf-book-results]').innerText()));
await form.locator('[data-sf-book-add]').click();
await form.locator('[data-sf-book-search]').fill('bigby');
await p.waitForFunction(() => /Bigby/.test(document.querySelector('lair-session-form [data-sf-book-results]')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
await form.locator('[data-sf-book-add]').click();
await p.waitForTimeout(150);
check('1: two books on the game', flat(await form.locator('[data-sf-book-list]').innerText()) === 'Dungeons & Dragons Monster Manual (5th Edition) D&D Bigby Presents Glory of the Giants', flat(await form.locator('[data-sf-book-list]').innerText()));
await form.locator('[data-sf-books]').screenshot({ path: `${OUT}live-2a-picker.png` });
await form.locator('[name="characters"]').first().check({ force: true });
// the game goes to the Lair as the form sends it (its payload, with a day, time and table: the map's taps are round 5's checks)
const W = addDays(key(Date.now()), 4);
const made = await p.evaluate(async ({ start, end }) => {
  const { store } = window.Lair;
  const el = document.querySelector('lair-session-form');
  el.readStep();
  // (the day and time the map would have set)
  Object.assign(el.draft, { day: store.time.key(start), start: store.time.minutesOf(start), hours: (end - start) / 3600000 });
  const body = { ...el.payload(), seats: 4, schedule: 'weekly', tables: ['T16'], start, end, email: store.cfg.customer.email, customerId: store.cfg.customer.id };
  try {
    const r = await store.mutate('createGame', body);
    return { sent: body.books, game: { id: r.game.id, status: r.game.status, seriesId: r.game.seriesId, books: (r.game.books || []).map((b) => `${b.shelfCode}:${b.out}:${b.withYou}`) }, perk: r.perk || null };
  } catch (e) {
    return { error: `${e.status} ${e.message}`, sent: body.books };
  }
}, { start: at(W, 18), end: at(W, 21) });
check('1: POST /games carries the books, and the game is listed with them', !made.error && made.game.status === 'open' && made.game.books.join() === 'DGLRPG-011:0:false,DGLRPG-008:0:false' && JSON.stringify(made.sent) === JSON.stringify(['48200000000003', '48100000000010']), made);
check('1: listing it switched her GM perk on (the answer says so)', made.perk && made.perk.on === true, made.perk);
await sleep(900);
const perkMails = (await emailsTo('ana@example.com', mails0)).filter((e) => /GM perk/.test(e.subject));
check('1: Gobgob emails her once: "Your GM perk is on: borrow an RPG book, free"', perkMails.length === 1 && perkMails[0].subject === 'Your GM perk is on: borrow an RPG book, free', perkMails.map((e) => e.subject));

/* ---------- 2. her My Library ---------- */
const openLibrary = async (pg) => {
  if (pg.url().includes('/pages/my-lair')) await pg.goto('about:blank');
  await pg.goto(`${BASE}/pages/my-lair#library`, { waitUntil: 'networkidle' });
  await pg.waitForSelector('my-library .mlib', { timeout: 15000 });
  await pg.waitForTimeout(400);
};
const lib = async (pg) => flat(await pg.locator('my-library').innerText());
await openLibrary(p);
let t = await lib(p);
check('2: My Library opens with the perk\'s card and Scan a book', t.startsWith("Every good GM needs a good book, friend. This one's on Gobgob. GM perk One RPG book at home, free") && (await p.locator('my-library .mlib-perk [data-library-scan]').count()) === 1, t.slice(0, 200));
await p.locator('my-library .mlib-perk-stack, my-library .mlib-perk').first().screenshot({ path: `${OUT}live-1a-perk-on.png` });
const typeCode = async (code) => {
  await p.waitForSelector('dialog.lair-scan[open]', { timeout: 5000 });
  await p.waitForSelector('dialog.lair-scan.is-off', { timeout: 5000 }).catch(() => {});
  await p.evaluate(() => {
    document.querySelector('[data-scan-status]').textContent = '';
  });
  await p.fill('#lair-scan-code', code);
  await p.press('#lair-scan-code', 'Enter');
  await p.waitForFunction(() => {
    const s = document.querySelector('[data-scan-status]');
    return !s || (s.textContent.trim() && !/Checking that one/.test(s.textContent));
  }, null, { timeout: 10000 }).catch(() => {});
  return flat(await p.locator('[data-scan-status]').textContent().catch(() => ''));
};
await p.click('my-library [data-library-scan]');
let said = await typeCode('DGL34-M011');
check('2: a board game is refused in the Lair\'s words', said === 'Your GM perk covers the RPG shelf. Join the library to borrow board games.', said);
said = await typeCode('DGLRPG-012');
check('2: the Player\'s Handbook goes home free on her perk', said.startsWith("Dungeons & Dragons Player's Handbook (5th Edition) is yours to take home, free with your GM perk."), said);
check('2: and she\'s told Leo\'s table would like it, with the day and time', /Heads up: The Lantern Street Job would like this one on the table at the Lair on \w{3} \d{1,2} \w{3}, 6pm\. Take it by all means, and bring it back by then if you can\.$/.test(said), said.slice(-200));
const scan = lastCall('POST', /^library\/scan$/);
const scanned = scan ? JSON.parse(scan.text) : {};
check('2: the scan\'s answer: a perk loan, the wanted list and the heads-up on its own', scanned.loan?.perk === 'gm' && scanned.loan?.lent === true && scanned.wanted?.length === 1 && scanned.wanted[0].mine === false && scanned.message.endsWith(scanned.wantedLine) && scanned.library?.perk?.free === false,
  { perk: scanned.loan?.perk, wanted: scanned.wanted, line: scanned.wantedLine, lib: scanned.library?.perk });
await p.evaluate(() => window.LairScan && window.LairScan.close());
await p.waitForTimeout(500);
t = await lib(p);
check('2: the heads-up shows in a box of its own, apart from the usual words', (await p.locator('my-library [data-heads]').count()) === 1 && flat(await p.locator('my-library [data-heads]').innerText()) === scanned.wantedLine, flat(await p.locator('my-library [data-heads]').innerText().catch(() => '')));
check('2: the card shows the book; at home it\'s tagged GM perk with when a table would like it', t.includes("Your GM perk book's at home") && (await p.locator('my-library .mlib-item .mlib-tag', { hasText: 'GM perk' }).count()) === 1 && /A table would like it on \w{3} \d{1,2} \w{3}, 6pm/.test(t), t.slice(0, 300));
await p.locator('my-library .mlib-perk').screenshot({ path: `${OUT}live-1a-perk-home.png` });
const second = await proxy('POST', 'library/scan', { customer: ANA, body: { code: 'DGLRPG-005' } });
check('2: one book at a time', second.status === 409 && second.data.error.startsWith('Your GM perk is one book at a time'), second.data.error);
check('2: no sideways scroll', (await overflow(p)) <= 0, await overflow(p));

/* ---------- 3. Games I run ---------- */
await p.goto('about:blank');
await p.goto(`${BASE}/pages/my-lair#bookings`, { waitUntil: 'networkidle' });
await p.waitForSelector('lair-game-books .mgb', { timeout: 15000 });
const books = p.locator('article.ml-game', { hasText: 'The Ember Road' }).first().locator('lair-game-books');
await books.scrollIntoViewIfNeeded();
t = flat(await books.innerText());
check('3: her game\'s books, each on the shelf', t.startsWith('Books for the table Dungeons & Dragons Monster Manual (5th Edition) DGLRPG-011 On the shelf D&D Bigby Presents Glory of the Giants DGLRPG-008 On the shelf'), t.slice(0, 260));
await books.locator('[data-books-edit]').click();
await p.waitForSelector('lair-game-books .mgb--edit');
const c0 = apiLog.length;
await books.locator('[data-books-search]').fill('handbook');
await p.waitForSelector('lair-game-books [data-books-add]', { timeout: 8000 }).catch(() => {});
check('3: Change the books searches the same shelf', apiLog.slice(c0).some((c) => c.method === 'GET' && /^library\/books\?q=handbook$/.test(c.route) && c.status === 200) && flat(await books.locator('[data-books-results]').innerText()) === "Dungeons & Dragons Player's Handbook (5th Edition) DGLRPG-012 Add",
  flat(await books.locator('[data-books-results]').innerText()));
await books.locator('[data-books-add]').click();
await p.waitForTimeout(150);
await books.locator('[data-books-off]').first().click(); // the Monster Manual comes off
await p.waitForTimeout(150);
await books.screenshot({ path: `${OUT}live-2c-change.png` });
await books.locator('[data-books-save]').click();
await p.waitForSelector('lair-game-books [data-books-edit]', { timeout: 10000 });
await p.waitForTimeout(900);
const saved = lastCall('POST', /^games\/[^/]+\/books$/);
const savedBody = saved ? JSON.parse(saved.body || '{}') : {};
const savedAnswer = saved ? JSON.parse(saved.text) : {};
check('3: Save sends POST /games/:id/books with the ids, and the Lair changes this and every later session', saved && saved.status === 200 && JSON.stringify(savedBody.books) === JSON.stringify(['48100000000010', '48200000000001']) && savedAnswer.sessions > 1, { status: saved?.status, body: savedBody, sessions: savedAnswer.sessions, error: savedAnswer.error });
const after = p.locator('article.ml-game', { hasText: 'The Ember Road' }).first().locator('lair-game-books');
t = flat(await after.innerText());
check('3: the card redraws: Bigby on the shelf, the Player\'s Handbook at home with her', t.includes('D&D Bigby Presents Glory of the Giants DGLRPG-008 On the shelf') && t.includes("Dungeons & Dragons Player's Handbook (5th Edition) DGLRPG-012 At home with you") && !t.includes('Monster Manual'), t.slice(0, 300));
await after.screenshot({ path: `${OUT}live-2c-books.png` });
const mine = (await proxy('GET', 'me', { customer: ANA })).data;
const sessions = (mine.games || []).filter((g) => g.title === 'The Ember Road' && g.status === 'open');
check('3: GET /me: every session of the weekly game names the two books', sessions.length > 1 && sessions.every((g) => (g.books || []).map((b) => b.shelfCode).join() === 'DGLRPG-008,DGLRPG-012'), sessions.map((g) => (g.books || []).map((b) => b.shelfCode).join('+')).join(' | '));
check('3: her own loan now says it\'s down for her game too', (mine.library?.atHome || []).some((l) => l.perk === 'gm' && (l.wanted || []).some((w) => w.mine) && (l.wanted || []).some((w) => !w.mine)), (mine.library?.atHome || []).map((l) => l.wanted));
check('3: no sideways scroll', (await overflow(p)) <= 0, await overflow(p));

/* ---------- 4. the book's page ---------- */
const sam = await context(SAM, PHONE);
const ps = await page(sam, 'phone/sam');
watch(ps);
await ps.goto(`${BASE}/products/d-d-bigby-library`, { waitUntil: 'networkidle' });
await ps.waitForSelector('library-reserve .library-reserve__wanted', { timeout: 15000 }).catch(() => {});
t = flat(await ps.locator('library-reserve').innerText().catch(() => ''));
check('4: Sam sees a table would like the book, and when', /A table would like this one on \w{3} \d{1,2} \w{3}, 6pm\. Borrow it by all means, and bring it back by then if you can\./.test(t), t.slice(0, 300));
await ps.locator('library-reserve').screenshot({ path: `${OUT}live-3c-page.png` }).catch(() => {});
await p.goto(`${BASE}/products/d-d-bigby-library`, { waitUntil: 'networkidle' });
await p.waitForSelector('library-reserve .library-reserve__wanted', { timeout: 15000 }).catch(() => {});
t = flat(await p.locator('library-reserve').innerText().catch(() => ''));
check('4: Ana sees it\'s down for her own game', /It's down for your own game on \w{3} \d{1,2} \w{3}, 6pm\./.test(t), t.slice(0, 300));
problems.push(...p.problems, ...ps.problems);

/* ---------- 5. staff ---------- */
const mo = await context(MO, PHONE);
const pm = await page(mo, 'phone/mo');
watch(pm);
await openLibrary(pm);
t = await lib(pm);
check('5: Mo (on the team) has the staff slot\'s card', t.includes("Staff slot One library game at home, free Because you're on the team.") && (await pm.locator('my-library [data-library-scan]').count()) >= 1, t.slice(0, 200));
await pm.goto(`${BASE}/pages/lair-staff`, { waitUntil: 'networkidle' });
await pm.waitForFunction(() => typeof document.querySelector('lair-staff')?.openMember === 'function' && document.querySelector('[data-library]'), null, { timeout: 15000 });
await pm.evaluate((id) => document.querySelector('lair-staff').openMember(id), ANA);
await pm.waitForSelector('[data-person-perk]:not([hidden]) .sperk__facts', { timeout: 15000 });
const perk = pm.locator('[data-person-perk]');
t = flat(await perk.innerText());
check('5: Ana\'s page: GM perk, On, since her game went on the board, with her book on the slot', t.startsWith('GM perk On') && t.includes('when their game went on the board') && t.includes('Quiet sessions 0 of 3 in a row') && t.includes("On the slot Dungeons & Dragons Player's Handbook (5th Edition), out today") && /Next session \w{3} \d{1,2} \w{3}, 6pm/.test(t),
  t.slice(0, 420));
await perk.screenshot({ path: `${OUT}live-4a-member.png` });
await perk.locator('[data-perk-note]').fill('Checking the take and give');
await perk.locator('[data-perk-ask="take"]').click();
await perk.locator('[data-perk-do="take"]').click();
await pm.waitForFunction(() => /GM perk is switched off\./.test(document.querySelector('[data-person-perk]')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
let call = lastCall('POST', /^members\/7103\/gm-perk$/);
t = flat(await perk.innerText());
check('5: Take it away goes through POST /members/:id/gm-perk { action: "take", note }, and the page says Off', call && call.status === 200 && JSON.parse(call.body).action === 'take' && JSON.parse(call.body).note === 'Checking the take and give' && t.startsWith('GM perk Off') && t.includes('by Mo'),
  { status: call?.status, body: call?.body, text: t.slice(0, 200) });
const taken = (await proxy('GET', 'me', { customer: ANA })).data.library;
check('5: for Ana the perk is off, and her book is marked as one whose perk ended (nothing taken back)', taken.perk?.status === 'off' && (taken.atHome || []).some((l) => l.perk === 'gm' && l.perkEnded === true), { perk: taken.perk, home: (taken.atHome || []).map((l) => [l.title, l.perkEnded]) });
await openLibrary(p);
t = await lib(p);
check('5: her My Library: no card now; the book is marked "GM perk ended" and quietly asked back', !t.includes('One RPG book at home, free') && !t.includes("Your GM perk book's at home") && t.includes('GM perk ended') && t.includes("Bring it back to the counter next time you're in. There's nothing to pay."), t.slice(0, 300));
const m1 = (await fake('GET', 'emails')).length;
await perk.locator('[data-perk-ask="give"]').click();
await perk.locator('[data-perk-do="give"]').click();
await pm.waitForFunction(() => /has the GM perk\./.test(document.querySelector('[data-person-perk]')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
call = lastCall('POST', /^members\/7103\/gm-perk$/);
t = flat(await perk.innerText());
check('5: Give puts it back on, given by Mo, and the log has all three', call && call.status === 200 && JSON.parse(call.body).action === 'give' && t.startsWith('GM perk On') && t.includes('given by Mo') && t.includes('Taken away by Mo') && t.includes('“Checking the take and give”') && t.includes('Their game went on the board'),
  { status: call?.status, text: t.slice(0, 500) });
await sleep(900);
const again = (await emailsTo('ana@example.com', m1)).filter((e) => /GM perk/.test(e.subject));
check('5: giving it emails her; taking it emailed nobody', again.length === 1 && again[0].subject === 'Your GM perk is on: borrow an RPG book, free', again.map((e) => e.subject));
await pm.evaluate(() => document.querySelector('lair-staff').setTab('library'));
await pm.waitForSelector('[data-lib-loans] .staff-lib-rows', { timeout: 15000 });
await pm.waitForSelector('staff-gm-perks .sperk-row', { timeout: 15000 });
await pm.waitForTimeout(400);
t = flat(await pm.locator('[data-lib-loans] .staff-loan', { hasText: "Player's Handbook" }).innerText());
check('5: Games at home: her book says GM perk (not Lent), and that Leo\'s table would like it', t.includes('GM perk') && !t.includes('Lent') && /Wanted \w{3} \d{1,2} \w{3}, 6pm · The Lantern Street Job/.test(t), t.slice(0, 300));
await pm.locator('[data-lib-loans] .staff-loan', { hasText: "Player's Handbook" }).screenshot({ path: `${OUT}live-4b-loan.png` });
t = flat(await pm.locator('staff-gm-perks').innerText());
check('5: the GM perks list (GET /gm-perks) has Ana and Leo, on, with what each has', apiLog.some((c) => c.method === 'GET' && c.route === 'gm-perks' && c.status === 200) && /Ana Rangi On Has Dungeons & Dragons Player's Handbook \(5th Edition\) · next session/.test(t) && /Leo Tane On Slot free · next session/.test(t), t.slice(0, 500));
await pm.locator('staff-gm-perks').screenshot({ path: `${OUT}live-4b-perks.png` });
check('5: the staff page: no sideways scroll', (await overflow(pm)) <= 0, await overflow(pm));
problems.push(...pm.problems);
// (a refusal the page shows is a 403 or 409 by design, and the mock store has no page for the books made up here, so
// their picture lookups are 404s: those console lines aren't problems; script errors, failed requests and 500s are)
const real = problems.filter((x) => !/console: Failed to load resource: the server responded with a status of 40[349]/.test(x));
check('no script errors, failed requests or 500s on any page', real.length === 0, real.slice(0, 5).join(' | '));
// (the lab's theme also asks three routes of rounds still in the lab, which no Lair has yet: not this round's)
const LAB_ONLY = ['/apps/liar/me/shop-holds', '/apps/liar/staff/pull', '/apps/liar/staff/requests'];
const missing = [...new Set(notFound)].filter((u) => !LAB_ONLY.includes(u));
check('nothing this round asks for is missing (a 404): only the made-up books\' picture lookups', missing.every((u) => /^\/products\/[a-z0-9-]+-library\.js$/.test(u)), missing.join(' | '));

await stop();
process.exit(summary() ? 1 : 0);

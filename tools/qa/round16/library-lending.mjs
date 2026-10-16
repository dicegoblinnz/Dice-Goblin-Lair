// Round 16 (16 Oct 2026), library lending (contract v16-library-lending), on the theme mock in demo mode, phone
// (390x844) then desktop (1280x800). Mo: "give the staff the ability to lend out a game to anyone even if they don't
// have an account it still adds to their account but no charge as they will not be subscribed but it is still evident
// that they have the game ... But reserved only for staff."
//   1. Staff, Library tab: Lend to someone new (the name, then an email or mobile, each said and focused; a landline
//      turned down by the Lair app's words), lent by typing the code and with the camera, an email that's a member's
//      lending it to them, Pick a member instead, a member with no plan (lent, no notice), a plan member (checked out,
//      not lent), a search with no match offering to lend, Games at home marking Lent games and a guest's email and
//      mobile, and a guest's game checked in at the counter.
//   2. The person it was lent to logs in with that email (no plan): the game joins their account. My Library shows it,
//      lent and free, with how it comes back and no invite to join on top; My Lair's Library tile says so.
//   3. A plan member lent a game the same way: it doesn't use the plan (room for 3 of 3, a line about the lent game),
//      and they still borrow on the plan; the tile counts only the plan's games.
//   4. Staff see the adopted games under their members, still Lent. No sideways scroll and no console errors.
// The theme's demo backend (assets/lair-demo.js) has to follow the contract for these checks to pass.
// Usage: DG_THEME=/path/to/theme [PORT=4986] node tools/qa/round16/library-lending.mjs [phone|desktop]
// Needs: npm install in tools/qa/theme-mock, and Playwright at /opt/node-tools/node_modules/playwright.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4986);
const BASE = `http://localhost:${PORT}`;
const OUT = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const only = process.argv[2];

// Made-up people (example.com), as round 7's library check
const STASH = { id: 7700500001, first_name: 'Kiri', last_name: 'Moana', name: 'Kiri Moana', email: 'kiri.moana@example.com', phone: null, tags: ['Goblin Treasure - Board Game Rental'], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const PLAIN = { id: 7700500003, first_name: 'Pat', last_name: 'Reader', name: 'Pat Reader', email: 'pat.reader@example.com', phone: null, tags: [], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };

const clockAt = (ms) => `(() => { const OFFSET = ${ms} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;
const TUESDAY_11AM = Date.UTC(2026, 9, 5, 22, 0); // Tue 6 Oct 2026, 11am NZDT

let failed = 0;
const results = [];
const check = (tag, ok, what, detail = '') => {
  if (!ok) failed += 1;
  const line = `${ok ? 'PASS' : 'FAIL'} ${tag} | ${what}${detail ? ` | ${String(detail).slice(0, 240)}` : ''}`;
  results.push(line);
  console.log(line);
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const server = await m.serve(PORT);
const browser = await chromium.launch();

async function context(size) {
  const vp = SIZES[size];
  const phone = vp.width < 700;
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(clockAt(TUESDAY_11AM));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) page.errors.push(`console: ${msg.text()}`);
  });
  return { ctx, page };
}

async function visit(page, who, path) {
  m.mockState.customer = who;
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  if (path.startsWith('/pages/my-lair')) await page.waitForSelector('[data-panel="bookings"]:not([aria-busy])', { state: 'attached', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(250);
}
const demo = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('dg-lair-demo-v3') || '{}'));
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const focusId = (page) => page.evaluate(() => (document.activeElement && document.activeElement.id) || '');
const outLine = async (page) => flat(await page.locator('[data-lib-say="out"]').textContent());

async function staffLibrary(page) {
  await visit(page, STAFF, '/pages/lair-staff');
  await page.click('[data-tab="library"]');
  await page.waitForSelector('[data-lib-loans] .staff-lib-rows', { timeout: 10000 });
  await page.waitForTimeout(300);
}
/** Type (or scan with a USB scanner) a game's code into the desk's out box and press Enter; the line it says */
async function outCode(page, code) {
  await page.fill('#lib-out-code', code);
  await page.press('#lib-out-code', 'Enter');
  await page.waitForTimeout(400);
  return outLine(page);
}
const homeRow = (page, title) => page.locator('[data-lib-loans] .staff-loan', { hasText: title });

async function openMyLibrary(page, who) {
  await visit(page, who, '/pages/my-lair');
  await page.evaluate(() => {
    window.location.hash = 'library';
  });
  await page.waitForSelector('my-library .mlib', { timeout: 10000 });
  await page.waitForTimeout(300);
}
const lib = async (page) => flat(await page.locator('my-library').innerText());
/** My Lair's Library tile: [value, label, more] */
const tile = (page) => page.evaluate(() => ['library', 'library-label', 'library-more'].map((k) => (document.querySelector(`[data-sum="${k}"]`)?.textContent || '').replace(/\s+/g, ' ').trim()));

/** The scanner sheet is open: type a code (headless Chrome has no camera, so the sheet offers typing) and read its line */
async function typeCode(page, code) {
  await page.waitForSelector('dialog.lair-scan[open]', { timeout: 5000 });
  await page.waitForSelector('dialog.lair-scan.is-off', { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => {
    document.querySelector('[data-scan-status]').textContent = '';
  });
  await page.fill('#lair-scan-code', code);
  await page.press('#lair-scan-code', 'Enter');
  await page.waitForFunction(() => {
    const s = document.querySelector('[data-scan-status]');
    return !s || (s.textContent.trim() && !/Checking that one/.test(s.textContent));
  }, null, { timeout: 8000 }).catch(() => {});
  const status = page.locator('[data-scan-status]');
  return (await status.count()) ? flat(await status.textContent()) : '';
}

for (const size of Object.keys(SIZES).filter((s) => !only || s === only)) {
  const { ctx, page } = await context(size);
  const tag = size;

  /* ---------- 1. staff: lend to someone new, to a member with no plan, and check out to a plan member ---------- */
  await staffLibrary(page);
  const heading = flat(await page.locator('#lib-out-title').textContent());
  check(tag, heading === 'Check out or lend a game', 'the desk: "Check out or lend a game"', heading);
  await page.locator('[data-lib-member] [data-lib-guest-open]').click();
  const guestOpen = await page.locator('[data-lib-guest]').isVisible();
  const legend = flat(await page.locator('[data-lib-guest] legend').textContent());
  const goLabel = flat(await page.locator('[data-lib-out-go]').textContent());
  check(tag, guestOpen && legend === 'Lend to someone new' && !(await page.locator('[data-lib-member]').isVisible()) && (await focusId(page)) === 'lib-guest-name' && goLabel === 'Lend',
    'Lend to someone new: the form takes the member search\'s place, focus on Name, the button says Lend', `${guestOpen} | ${legend} | ${await focusId(page)} | ${goLabel}`);
  const hint = flat(await page.locator('#lib-guest-hint').textContent());
  check(tag, /no account or plan needed/i.test(hint) && /email or mobile/i.test(hint) && /joins their account/i.test(hint), 'it says it\'s free, why an email or mobile, and that an email joins their account', hint);
  // what's missing, one thing at a time, with focus on it
  let line = await outCode(page, 'DGL7+-015');
  check(tag, line === 'Add the name of who you’re lending it to.' && (await focusId(page)) === 'lib-guest-name' && (await page.inputValue('#lib-out-code')) === 'DGL7+-015',
    'no name: says so, focus on Name, the game stays typed', `${line} | ${await focusId(page)}`);
  await page.fill('#lib-guest-name', 'Pat Reader');
  await page.press('#lib-guest-name', 'Enter');
  await page.waitForTimeout(300);
  line = await outLine(page);
  check(tag, line === 'Add their email or mobile, so we can reach them about the game.' && (await focusId(page)) === 'lib-guest-email', 'no email or mobile: says so, focus on Email', `${line} | ${await focusId(page)}`);
  await page.fill('#lib-guest-email', 'Pat.Reader@Example.com');
  await page.fill('#lib-guest-mobile', '09 123 4567');
  line = await outCode(page, 'DGL7+-015');
  check(tag, line === "That mobile number doesn't look right. Try one like 021 123 4567." && (await focusId(page)) === 'lib-guest-mobile', 'a landline: the Lair app\'s words, focus on Mobile', `${line} | ${await focusId(page)}`);
  await page.fill('#lib-guest-mobile', '021 555 0199');
  line = await outCode(page, 'DGL7+-015');
  check(tag, line === 'Lent: Codenames (DGL7+-015) to Pat Reader. Nothing to pay. It joins their account when they log in to My Lair with pat.reader@example.com.'
    && (await page.inputValue('#lib-out-code')) === '', 'lent to someone without an account: "Lent: … Nothing to pay. It joins their account …"', line);
  let state = await demo(page);
  let loan = (state.libraryLoans || []).find((l) => l.title === 'Codenames' && l.status === 'out');
  check(tag, Boolean(loan) && loan.customerId === '' && loan.lent === true && loan.guestName === 'Pat Reader' && loan.guestEmail === 'pat.reader@example.com' && loan.guestMobile === '021 555 0199',
    'the loan: no account yet, lent, with their name, email (lower case) and mobile', JSON.stringify(loan && { c: loan.customerId, lent: loan.lent, n: loan.guestName, e: loan.guestEmail, m: loan.guestMobile }));
  // Games at home: Lent, and how to reach them (there's no member to open)
  let row = homeRow(page, 'Codenames');
  let rowText = flat(await row.innerText());
  check(tag, rowText.includes('Lent') && rowText.includes('Pat Reader (no account yet)') && rowText.includes('pat.reader@example.com') && rowText.includes('021 555 0199')
    && (await row.locator('.staff-lib__reach a').count()) === 2
    && (await row.locator('.staff-lib__lent').count()) === 1 && (await row.locator('a[href="mailto:pat.reader@example.com"]').count()) === 1 && (await row.locator('a[href="tel:0215550199"]').count()) === 1
    && !(await row.locator('[data-member-view]').count()) && !(await row.locator('[data-lib-damage]').count()),
  'Games at home: Lent, "(no account yet)", their email and mobile as links, no member to open, no damage charge', rowText);
  // the camera lends to the same person, game after game
  await page.click('[data-lib-scan="out"]');
  const sheetTitle = flat(await page.locator('#lair-scan-title').textContent().catch(() => ''));
  let said = await typeCode(page, 'DGL56-002');
  check(tag, sheetTitle === 'Lend to Pat' && said === 'Lent: 5-Minute Dungeon (DGL56-002) to Pat Reader. Nothing to pay. It joins their account when they log in to My Lair with pat.reader@example.com.',
    'the camera: "Lend to Pat", and the next game goes to them too', `${sheetTitle} | ${said}`);
  await page.evaluate(() => window.LairScan.close());
  // a plan member who's never used the Lair: by email, so it joins them when they log in
  await page.click('[data-lib-guest-close]');
  check(tag, (await page.locator('[data-lib-member]').isVisible()) && !(await page.locator('[data-lib-guest]').isVisible()) && (await focusId(page)) === 'lib-member-q'
    && flat(await page.locator('[data-lib-out-go]').textContent()) === 'Check out', 'Pick a member instead: back to the member search, and Check out');
  await page.locator('[data-lib-member] [data-lib-guest-open]').click();
  check(tag, (await page.inputValue('#lib-guest-name')) === '' && (await page.inputValue('#lib-guest-email')) === '' && (await page.inputValue('#lib-guest-mobile')) === '', 'opened again: someone new, so the last person\'s details have gone');
  await page.fill('#lib-guest-name', 'Kiri');
  await page.fill('#lib-guest-email', 'kiri.moana@example.com');
  line = await outCode(page, 'DGL34-052');
  check(tag, line === 'Lent: Forbidden Island (DGL34-052) to Kiri. Nothing to pay. It joins their account when they log in to My Lair with kiri.moana@example.com.', 'an email only (no mobile) is enough', line);
  // an email that's a member's: it's lent to them
  await page.click('[data-lib-guest-close]');
  await page.locator('[data-lib-member] [data-lib-guest-open]').click();
  await page.fill('#lib-guest-name', 'Grace');
  await page.fill('#lib-guest-email', 'GRACE@example.com');
  line = await outCode(page, 'DGLF-025');
  check(tag, line === 'Lent: Jenga (DGLF-025) to Grace Liu, whose account has that email. Nothing to pay, and it doesn’t use a library plan.', 'an email that\'s a member\'s: lent to them, and the line says whose account', line);
  row = homeRow(page, 'Jenga');
  check(tag, (await row.locator('[data-member-view]').count()) === 1 && (await row.locator('.staff-lib__lent').count()) === 1 && !flat(await row.innerText()).includes('no account yet'), 'Games at home: Grace\'s, as a member, and Lent', flat(await row.innerText()));
  // a member with no plan, picked from the search: lent, no "isn't on a library plan" notice
  await page.click('[data-lib-guest-close]');
  await page.fill('#lib-member-q', 'Jordan');
  await page.waitForSelector('[data-lib-member-pick]', { timeout: 5000 });
  await page.locator('[data-lib-member-pick]', { hasText: 'Jordan Lee' }).click();
  line = await outCode(page, 'DGL56-001');
  check(tag, line === 'Lent: 221B Baker Street: The Master Detective Game (DGL56-001) to Jordan Lee. Nothing to pay, and it doesn’t use a library plan.', 'a member with no plan: lent, nothing to pay, no notice', line);
  state = await demo(page);
  loan = (state.libraryLoans || []).find((l) => l.title.startsWith('221B') && l.status === 'out');
  check(tag, Boolean(loan) && loan.lent === true && loan.customerId !== '', 'their loan is lent, on their account');
  // a member with a plan: checked out as before, not lent
  await page.click('[data-lib-member-change]');
  await page.fill('#lib-member-q', 'Sam');
  await page.waitForSelector('[data-lib-member-pick]', { timeout: 5000 });
  await page.locator('[data-lib-member-pick]', { hasText: 'Sam Tautahi' }).click();
  line = await outCode(page, 'DGL56-157');
  row = homeRow(page, 'Wyrmspan');
  check(tag, line === 'Checked out: Wyrmspan (DGL56-157) to Sam Tautahi.' && !(await row.locator('.staff-lib__lent').count()), 'a plan member: "Checked out", one of their plan\'s games (no Lent)', line);
  // nobody matches: lend it instead, with what was typed as their name
  await page.click('[data-lib-member-change]');
  await page.fill('#lib-member-q', 'Zed Nobody');
  await page.waitForSelector('[data-lib-guest-from]', { timeout: 5000 });
  const noMatch = flat(await page.locator('[data-lib-member-results]').innerText());
  await page.click('[data-lib-guest-from]');
  check(tag, noMatch.includes('No members match') && noMatch.includes('Lend it to someone new instead') && (await page.inputValue('#lib-guest-name')) === 'Zed Nobody' && (await focusId(page)) === 'lib-guest-email',
    'no member matches: "Lend it to someone new instead" puts what was typed in Name, focus on Email', `${noMatch} | ${await focusId(page)}`);
  await page.locator('[data-lib-out]').screenshot({ path: `${OUT}${tag}-lend-form.png` });
  check(tag, (await overflow(page)) === 0, 'staff page with the lend form: no sideways scroll');
  // a guest's game comes back at the counter like any other
  await page.fill('#lib-in-code', 'DGL56-002');
  await page.press('#lib-in-code', 'Enter');
  await page.waitForTimeout(400);
  line = flat(await page.locator('[data-lib-say="in"]').textContent());
  check(tag, line === 'Checked in: 5-Minute Dungeon is back on the shelf. It was with Pat (today).', 'a guest\'s game checked in at the counter', line);
  const lede = flat(await page.locator('.staff-library__lede').nth(1).textContent());
  check(tag, lede.includes('Games marked Lent went out free, outside a library plan.'), 'Games at home says what Lent means', lede);
  await page.locator('[data-lib-loans]').screenshot({ path: `${OUT}${tag}-games-at-home.png` });

  /* ---------- 2. Pat logs in (no plan): the game joins his account, lent, with no invite to join on top ---------- */
  await openMyLibrary(page, PLAIN);
  let text = await lib(page);
  state = await demo(page);
  loan = (state.libraryLoans || []).find((l) => l.title === 'Codenames' && l.status === 'out');
  check(tag, Boolean(loan) && loan.customerId === String(PLAIN.id), 'logged in with that email: Codenames is on Pat\'s account', loan && loan.customerId);
  check(tag, text.includes('Lent to you') && text.includes("We've lent you a game from the library, with nothing to pay. When you're done with it, bring it to the counter and we'll scan it back onto the shelf.")
    && !text.includes('Join the library') && !(await page.locator('my-library .mlib-join__actions').count()),
  'My Library: "Lent to you", free, how it comes back, and no "Join the library" card', text.slice(0, 260));
  const items = flat(await page.locator('my-library .mlib-item--home').allInnerTexts().then((x) => x.join(' | ')));
  check(tag, items.includes('Codenames') && items.includes('Lent') && (await page.locator('my-library .mlib-item--lent .mlib-tag').count()) === 1 && !items.includes('5-Minute Dungeon'),
    'At home: Codenames, tagged Lent (5-Minute Dungeon came back)', items);
  check(tag, !(await page.locator('my-library [data-library-scan]').count()) && !(await page.locator('#mlib-holds-title').count()) && (await page.locator('my-library .mlib-links a').count()) === 2,
    'no scanner and no Reserved list (they need a plan), just the shelves and plans as links');
  let t = await tile(page);
  check(tag, t[0] === '1' && t[1] === 'game lent to you' && t[2] === 'Nothing to pay', 'My Lair\'s Library tile: 1 game lent to you, nothing to pay (not "Join")', t.join(' | '));
  await page.locator('my-library').screenshot({ path: `${OUT}${tag}-my-library-lent.png` });
  check(tag, (await overflow(page)) === 0, 'My Library (lent): no sideways scroll');

  /* ---------- 3. Kiri (Stash, 3 games) logs in: the lent game doesn't use her plan ---------- */
  await openMyLibrary(page, STASH);
  text = await lib(page);
  check(tag, text.includes('0 of 3 games') && text.includes('Room for 3 more.') && text.includes("Plus 1 game we've lent you, which doesn't use your plan."),
    'a plan member lent a game: 0 of 3, room for 3, and a line about the lent one', text.slice(0, 240));
  check(tag, (await page.locator('my-library .mlib-item--lent', { hasText: 'Forbidden Island' }).count()) === 1 && (await page.locator('my-library [data-library-scan]').count()) === 1,
    'Forbidden Island at home, tagged Lent; the scanner is there for the plan');
  await page.click('my-library [data-library-scan]');
  said = await typeCode(page, 'DGL56-002');
  await page.evaluate(() => window.LairScan && window.LairScan.close());
  await page.waitForTimeout(400);
  text = await lib(page);
  check(tag, said.startsWith('5-Minute Dungeon is yours to take home.') && text.includes('1 of 3 games: 1 at home') && text.includes("Plus 1 game we've lent you"),
    'she borrows on her plan: 1 of 3, the lent game still apart', `${said} | ${text.slice(0, 160)}`);
  await visit(page, STASH, '/pages/my-lair');
  t = await tile(page);
  check(tag, t[0] === '1 of 3', 'her Library tile counts only the plan\'s games (1 of 3)', t.join(' | '));
  await openMyLibrary(page, STASH);
  await page.locator('my-library').screenshot({ path: `${OUT}${tag}-my-library-plan-lent.png` });

  /* ---------- 4. staff see the adopted games under their members ---------- */
  await staffLibrary(page);
  row = homeRow(page, 'Codenames');
  rowText = flat(await row.innerText());
  check(tag, (await row.locator('[data-member-view]').count()) === 1 && rowText.includes('Pat Reader') && rowText.includes('Lent') && !rowText.includes('no account yet'),
    'Games at home: Codenames is Pat Reader\'s now (a member to open), still Lent', rowText);
  row = homeRow(page, 'Forbidden Island');
  check(tag, (await row.locator('[data-member-view]').count()) === 1 && flat(await row.innerText()).includes('Kiri Moana'), 'Forbidden Island is Kiri Moana\'s', flat(await row.innerText()));
  check(tag, (await overflow(page)) === 0, 'staff page: no sideways scroll');
  check(tag, page.errors.length === 0, 'no console or page errors', page.errors.slice(0, 3).join(' | '));
  await ctx.close();
}

await browser.close();
server.close();
console.log(failed ? `library lending: ${failed} FAILED of ${results.length}` : `library lending: all ${results.length} passed`);
process.exit(failed ? 1 : 0);

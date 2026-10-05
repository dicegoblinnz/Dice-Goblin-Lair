// Round 6, part 1 (loyalty): My Lair's 10-stamp loyalty card and its d20 roll, the staff page's loyalty tools (Give
// rolls, Customer since, spend by financial year and month, birthday rolls) and session gift passes ("A gift"), in
// demo mode through theme-mock, at 390px and then 1280px. Prints a PASS or FAIL line for each check, then a summary.
// Usage: DG_THEME=/path/to/theme QA_PORT=4744 node tools/qa/round6/loyalty.mjs [phone|desktop]
// Needs: npm install in tools/qa/theme-mock, and Playwright at /opt/node-tools/node_modules/playwright.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout');
  process.exit(2);
}
const m = await import('../theme-mock/render.mjs');
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.QA_PORT || 4744);
const BASE = `http://localhost:${PORT}`;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const CUSTOMER = {
  id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [],
  orders_count: 0, orders: [], store_credit_account: { balance: 500 },
};
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const NO_ROLLS = 'No rolls yet, friend. Fill your card: 10 sessions earn a roll.';
// Words only the old spend dice used ("a die per $50", "$7.50 to your next roll" ...): none may show to customers
const OLD_DICE = [
  /every \$\d+/i, /spend \$\d+/i, /\$\d+(\.\d\d)? more to your next roll/i, /die per/i, /per \$\d+/i, /no ones/i,
  /on the face/i, /two ones/i, /roll for loot/i, /what a roll wins/i, /1, 10, 12 to 19/, /rolls ready:/i, /you spend/i,
];
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const results = [];
const check = (tag, name, ok, detail = '') => {
  results.push({ tag, name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${tag} | ${name}${detail ? ` | ${detail}` : ''}`);
};

const server = await m.serve(PORT);
const browser = await chromium.launch();

async function open(size, path, customer) {
  const vp = SIZES[size];
  const phone = vp.width < 700;
  m.mockState.customer = customer;
  const ctx = await browser.newContext({ viewport: vp, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') page.errors.push(`console: ${msg.text()}`); });
  await go(page, path);
  return { ctx, page };
}
async function go(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  if (path.startsWith('/pages/my-lair')) await page.waitForSelector('[data-stamp-count] strong', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const view = async (page, name) => {
  await page.click(`.ml-bar [data-view-link="${name}"]`);
  await page.waitForSelector(`[data-view="${name}"]:not([hidden])`, { timeout: 5000 });
  await page.waitForTimeout(200);
};
const me = (page) => page.evaluate(async () => (await window.Lair.store.backend.me()).loyalty);
const ui = (page) => page.evaluate(() => ({
  stamped: document.querySelectorAll('[data-stamps] .ml-stamp.is-stamped').length,
  count: document.querySelector('[data-stamp-count]')?.innerText.replace(/\s+/g, ' ').trim() || '',
  tag: document.querySelector('[data-card-tag]')?.textContent.trim() || '',
  ready: document.querySelector('[data-rolls-ready]:not([hidden])')?.innerText.replace(/\s+/g, ' ').trim() || '',
  buttons: document.querySelectorAll('[data-roll-slots] [data-roll]').length,
  button: document.querySelector('[data-roll-slots] [data-roll]')?.innerText.replace(/\s+/g, ' ').trim() || '',
  slots: document.querySelector('[data-roll-play]:not([hidden]) [data-roll-slots]')?.innerText.replace(/\s+/g, ' ').trim() || '',
}));

const only = process.argv[2];
for (const size of ['phone', 'desktop'].filter((s) => !only || s === only)) {
  // ---------- My Lair: the card ----------
  const { ctx, page } = await open(size, '/pages/my-lair?roll=14', CUSTOMER);
  let L = await me(page);
  let s = await ui(page);
  const left = L.cardSize - L.stamps;
  check(size, 'the card shows the right stamps', s.stamped === L.stamps && s.count.includes(`${L.stamps} of ${L.cardSize} stamps`)
    && s.count.includes(`${left} more ${left === 1 ? 'session' : 'sessions'} to your next roll`), `${s.stamped} stamped; "${s.count}"; app says ${L.stamps}`);
  check(size, 'the demo card starts at 7 stamps, 1 card filled, 2 rolls ready', L.stamps === 7 && L.cards === 1 && L.rolls.available === 2
    && s.tag === '1 card filled' && s.ready.startsWith('2 rolls ready'), `${L.stamps}/${L.cards}/${L.rolls.available}; tag "${s.tag}"; "${s.ready}"`);
  check(size, 'the welcome roll says where it came from', s.ready.includes("Welcome to the Lair! Your first roll's on us."), s.ready);
  check(size, 'one clear roll button', s.buttons === 1 && /^Roll your d20/.test(s.button), s.button);

  // ---------- the roll: ?roll=14 ----------
  await page.click('[data-roll-slots] [data-roll]');
  await page.waitForSelector('[data-roll-slots] [data-result]', { timeout: 10000 });
  await page.waitForTimeout(400);
  const result = flat(await page.locator('[data-roll-slots] [data-result]').innerText());
  check(size, 'rolling with ?roll=14 shows $14 store credit', result.includes('$14 store credit') && result.includes('You rolled a 14: $14 store credit is yours.'), result);
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.matches('[data-result]'));
  check(size, 'focus moves to the result', focused);
  L = await me(page);
  s = await ui(page);
  check(size, 'the card updates after the roll', L.rolls.available === 1 && s.ready.startsWith('1 roll ready') && /1 ready/.test(s.button)
    && L.history[0] && L.history[0].amount === 1400, `"${s.ready}" / "${s.button}"`);

  // ---------- no rolls: the 409 words and no button ----------
  await page.click('[data-roll-slots] [data-roll]');
  await page.waitForSelector('[data-roll-slots] [data-result]', { timeout: 10000 });
  await page.waitForTimeout(400);
  await go(page, '/pages/my-lair'); // without ?roll, so no roll is given back
  s = await ui(page);
  const app409 = await page.evaluate(async () => {
    try {
      await window.Lair.store.backend.roll({ kind: 'loyalty' });
      return 'it rolled';
    } catch (error) {
      return `${error.status} ${error.message}`;
    }
  });
  check(size, 'no rolls: the 409 message and no button', s.buttons === 0 && s.ready === NO_ROLLS && app409 === `409 ${NO_ROLLS}`, `"${s.ready}"; app: ${app409}`);
  // a roll used up behind the page's back (another phone): the Lair app's 409 replaces the button
  await page.evaluate(async () => {
    const be = window.Lair.store.backend;
    be.editLoyalty(String(be.cfg.customer.id), (x) => { x.staff += 1; });
    be.commit();
    await document.querySelector('my-lair').refreshRolls();
  });
  await page.waitForSelector('[data-roll-slots] [data-roll]', { timeout: 5000 });
  await page.evaluate(() => {
    const be = window.Lair.store.backend;
    be.editLoyalty(String(be.cfg.customer.id), (x) => { x.used += 1; });
    be.commit();
  });
  await page.click('[data-roll-slots] [data-roll]');
  await page.waitForSelector('[data-roll-slots] .ml-roll__error', { timeout: 10000 });
  s = await ui(page);
  const stale = flat(await page.locator('[data-roll-slots] .ml-roll__error').innerText());
  check(size, 'a stale roll shows the 409 message and no button', stale === NO_ROLLS && s.buttons === 0, stale);
  check(size, 'spend dice kinds answer 410', await page.evaluate(async () => {
    try {
      await window.Lair.store.backend.roll({ kind: 'spend' });
      return false;
    } catch (error) {
      return error.status === 410 && /spend dice have retired/.test(error.message);
    }
  }));

  // ---------- nothing about the old spend dice for customers ----------
  const seen = [];
  for (const name of ['home', 'wallet', 'me']) {
    await view(page, name);
    seen.push(await page.evaluate(() => document.querySelector('my-lair').innerText));
  }
  const how = await page.evaluate(() => [...document.querySelectorAll('.ml-odds__list li')].map((li) => li.textContent.trim()));
  const out = await open(size, '/pages/my-lair', null);
  seen.push(await out.page.locator('.ml--out').innerText());
  await out.ctx.close();
  const found = OLD_DICE.filter((re) => seen.some((text) => re.test(text))).map(String);
  check(size, 'nothing about the old spend dice on the customer side', !found.length, found.join(', ') || 'none found');
  check(size, 'How it works: sessions earn stamps, 10 fill a card, the roll is $1 to $20 store credit', how.some((x) => /stamp/i.test(x) && /TTRPG/.test(x))
    && how.some((x) => /10 stamps/.test(x)) && how.some((x) => /\$1 to \$20/.test(x)), how.join(' / '));

  // ---------- the Wallet: the roll history and the stamps ----------
  await view(page, 'wallet');
  const wallet = flat(await page.locator('[data-prizes]').innerText());
  check(size, 'the Wallet lists the rolls and the stamped sessions', /\$14 store credit/.test(wallet) && /Recent stamps/.test(wallet) && /Abomination Vaults/.test(wallet)
    && /Show this at the counter to claim it/.test(wallet), wallet.slice(0, 160));

  // ---------- a session gift: claimed, it reads "A gift" ----------
  const code = await page.evaluate(() => (window.Lair.store.backend.passList().find((p) => p.source === 'gift' && !p.customerId) || {}).code || '');
  await page.fill('#ml-claim-code', code);
  await page.click('[data-claim] button[type="submit"]');
  await page.waitForSelector('[data-claim-message]:not([hidden])', { timeout: 5000 });
  await page.waitForTimeout(300);
  const gift = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.ml-pass')].find((c) => /^Gift: /.test(c.querySelector('.ml-pass__label')?.textContent || ''));
    return card ? card.querySelector('.ml-pass__from')?.textContent.trim() || '(no source line)' : '(no gift pass)';
  });
  check(size, 'a gift pass reads "A gift"', Boolean(code) && gift === 'A gift', `${code}: ${gift}`);
  const over = await overflow(page);
  check(size, 'My Lair: no sideways scroll and no console errors', over === 0 && !page.errors.length, `overflow ${over}; ${page.errors.slice(0, 3).join(' | ')}`);
  await ctx.close();

  // ---------- the staff page: a member's loyalty card, Give rolls, Customer since, spend ----------
  const staff = await open(size, '/pages/lair-staff#members', STAFF);
  const sp = staff.page;
  await sp.waitForSelector('.staff-mem-row', { timeout: 10000 });
  const head = flat(await sp.locator('.staff-mem-head').textContent().catch(() => ''));
  const firstRow = flat(await sp.locator('.staff-mem-row').first().innerText());
  check(size, 'the members list shows spend this financial year and the card', head.includes('This financial year') && head.includes('Card')
    && /This financial year/.test(firstRow) && /\d+\/10/.test(firstRow), firstRow.slice(0, 140));
  await sp.locator('.staff-mem-row', { hasText: 'Sam Tautahi' }).click();
  await sp.waitForSelector('[data-person-loyalty] .staff-person__facts', { timeout: 10000 });
  const facts = async () => sp.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-person-loyalty] .staff-person__facts > div')]
    .map((d) => [d.querySelector('dt').textContent.trim(), d.querySelector('dd').textContent.trim()])));
  const before = await facts();
  await sp.click('[data-rolls-form] [data-seats-step="1"]');
  await sp.click('[data-rolls-form] button[type="submit"]');
  await sp.waitForTimeout(800);
  const toast = flat(await sp.locator('.toast').innerText().catch(() => ''));
  const after = await facts();
  check(size, 'staff give 2 rolls', Number(after['Rolls ready']) === Number(before['Rolls ready']) + 2 && /Gave Sam 2 rolls/.test(toast), `${before['Rolls ready']} → ${after['Rolls ready']}; "${toast}"`);
  await sp.fill('[data-since-form] [name="since"]', '2019');
  await sp.click('[data-since-form] button[type="submit"]');
  await sp.waitForTimeout(800);
  const since = await facts();
  const today = await sp.evaluate(() => window.Lair.store.time.today());
  const years = Number(today.slice(0, 4)) - 2019;
  check(size, 'customer since 2019, and years with us right', since['Customer since'] === '2019' && since['With us'] === `${years} years with us`, JSON.stringify(since));
  const id = await sp.evaluate(() => document.querySelector('[data-rolls-form]').dataset.id);
  const appSince = await sp.evaluate(async (who) => (await window.Lair.store.backend.members({ q: who }))[0], id);
  check(size, 'the Lair app keeps it', appSince.customerSince === '2019-01-01' && appSince.yearsWithUs === years, `${appSince.customerSince} / ${appSince.yearsWithUs}`);
  // spend: the financial years and 24 months
  await sp.waitForSelector('[data-person-spend] .staff-spend__years', { timeout: 10000 });
  const spend = await sp.evaluate(() => ({
    years: [...document.querySelectorAll('[data-person-spend] .staff-spend__years tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()),
    months: document.querySelectorAll('[data-person-spend] .staff-spend__month').length,
    total: document.querySelector('[data-person-spend] .staff-spend__total')?.innerText.replace(/\s+/g, ' ').trim(),
  }));
  check(size, 'spend shows financial years and 24 months', spend.years.length >= 1 && spend.years.length <= 4 && /^\d{4}\/\d{2} \(this year\)/.test(spend.years[0])
    && spend.months === 24 && /in all/.test(spend.total || ''), `${spend.years.join(' | ')}; ${spend.months} months; ${spend.total}`);
  // birthdays: the gift form's rolls start at 0 (round 7, MO.md decision 5: no rolls by years with us; staff can still add some)
  await sp.click('[data-members-back]');
  await sp.waitForSelector('[data-birthdays] .staff-birthday', { timeout: 10000 });
  const people = await sp.evaluate(() => [...document.querySelectorAll('[data-birthdays] .staff-birthday [data-gift-open]')].slice(0, 3).map((b) => b.dataset.giftOpen));
  const seenRolls = [];
  let rollsOk = people.length > 0;
  for (const who of people) {
    await sp.click(`[data-birthdays] [data-gift-open="${who}"]`);
    await sp.waitForSelector('[data-gift-form]', { timeout: 5000 });
    const value = Number(await sp.inputValue('[data-gift-form] [name="rolls"]'));
    const hint = flat(await sp.locator('#gift-rolls-hint').innerText());
    const row = await sp.evaluate(async (x) => (await window.Lair.store.backend.members({ q: x }))[0], who);
    seenRolls.push(`${row.name}: ${value} (years ${row.yearsWithUs})`);
    if (value !== 0 || /each year with us/.test(hint)) rollsOk = false;
    await sp.click('[data-gift-back]');
    await sp.waitForSelector('[data-birthdays] .staff-birthday', { timeout: 5000 });
  }
  check(size, 'birthday gifts start with no rolls (round 7)', rollsOk, seenRolls.join('; '));
  // the gift pass on the staff page says where it came from
  await sp.click('[data-tab="passes"]');
  await sp.waitForSelector('.staff-pass-row', { timeout: 10000 });
  const giftRow = flat(await sp.locator('.staff-pass-row', { hasText: 'Gift: 5 sessions' }).first().innerText().catch(() => ''));
  check(size, 'staff see a session gift as one', /Session gift #1561/.test(giftRow) && /A gift, not claimed yet/.test(giftRow), giftRow);
  const sover = await overflow(sp);
  check(size, 'staff page: no sideways scroll and no console errors', sover === 0 && !sp.errors.length, `overflow ${sover}; ${sp.errors.slice(0, 3).join(' | ')}`);
  await staff.ctx.close();
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `loyalty: ${failed.length} of ${results.length} FAILED` : `loyalty: all ${results.length} passed`);
await browser.close();
server.close();
process.exitCode = failed.length ? 1 : 0;

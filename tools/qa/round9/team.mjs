// Round 9, team (team.md): helpers and permissions on the staff page, a member's store credit, library and Email
// them, and adding people to events and games by member code or by name and email. Demo mode on the theme mock, phone
// (390px) then desktop (1280px), each in a fresh browser context (a fresh demo). Prints a PASS or FAIL line per check,
// then a summary (exit 1 when anything failed).
//   1. The main account: every tab, Team last, the floor first; the Team tab with "Main account, everything".
//   2. Add a helper from the search (Check-in and Tables ticked to start), change what they can do, and Remove asks first.
//   3. A member's page: their store credit (add, the question with the balance before and after, a take-off with no
//      note and one bigger than the balance stopped), what they borrow, Email them (a preview to confirm, then the log),
//      and "<name> is a helper".
//   4. The Events tab: add a member to an event date by typing their member code (found at once), and someone without
//      an account by name and email (invited), each asked first; they're on Today's list.
//   5. GM games: a member code typed into Add players picks them at once.
//   6. The demo's "Preview as a helper": only Check-in, Tables and Members tabs, landing on Today, no Team tab, the
//      banner and the way back. A helper logged in sees the same, and My Lair's Staff tools and the view switch.
//   7. A customer who isn't staff gets the locked message.
//   8. axe (WCAG 2.1 A and AA) on the Team tab, a member's tools and the event form; a keyboard pass on the Team form;
//      no sideways scroll; no console errors.
// Screenshots go to OUT (or a folder in the system's temp directory). Without AXE the axe part is skipped and says so.
// Usage: DG_THEME=/path/to/theme QA_PORT=4931 [AXE=/path/to/axe.min.js] [OUT=/dir] node tools/qa/round9/team.mjs [phone|desktop]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round9-team');
const AXE = process.env.AXE || '';
const axe = AXE && fs.existsSync(AXE) ? fs.readFileSync(AXE, 'utf8') : null;
fs.mkdirSync(OUT, { recursive: true });
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
const ev = await import(new URL('../theme-mock/events-mock.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.QA_PORT || process.env.PORT || 4931);
const BASE = `http://localhost:${PORT}`;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };

/* ---------- the page clock (today, 1pm) and a sign-up event tomorrow evening ---------- */
const TZ = 'Pacific/Auckland';
const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const offset = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${key}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const iso = (key, hm) => `${key}T${hm}:00${offset(key)}`;
const today = lairKey(Date.now());
const tomorrow = lairKey(Date.parse(iso(today, '12:00')) + 24 * 3600 * 1000);
const AT = Date.parse(iso(today, '13:00'));
const CLOCK = `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;
const EVENT = 'r9-team-quiz-night';
ev.extraEvents.push({ handle: EVENT, title: 'Quiz night (round 9)', event_type: 'social', starts_at: iso(tomorrow, '19:00'), ends_at: iso(tomorrow, '21:00'), capacity: 12, entry_fee: 10, image_slug: 'board-games', game: '', description: 'Questions, snacks and friends.' });

const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const RUBY = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [] };

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 600)}`);
  return ok;
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function scan(page, label, selector) {
  if (!axe) return;
  await page.addScriptTag({ content: axe });
  const found = await page.evaluate(async (sel) => {
    const r = await window.axe.run(document.querySelector(sel), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  }, selector);
  check(`axe: ${label}: no WCAG 2.1 A/AA violations`, !found.length, found.join(' / '));
}
const shot = async (page, name, sel = null) => {
  const el = sel ? await page.$(sel) : null;
  await (el || page).screenshot({ path: `${OUT}/${name}.png`, ...(el ? {} : { fullPage: false }) }).catch(() => {});
};
const toastText = async (page) => flat(await page.evaluate(() => [...document.querySelectorAll('.staff-toast, .toast, [data-toast], .lair-toast')].map((t) => t.textContent).join(' | ')).catch(() => ''));

const server = await m.serve(PORT);
const browser = await chromium.launch();
if (!axe) console.log('SKIP axe: set AXE to axe-core’s axe.min.js to run it');

for (const size of process.argv[2] ? [process.argv[2]] : ['phone', 'desktop']) {
  const tag = size;
  const phone = size === 'phone';
  const ctx = await browser.newContext({ viewport: SIZES[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(CLOCK);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()); });
  const open = async (url, customer) => {
    m.mockState.customer = customer;
    await page.goto('about:blank');
    await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(500);
  };
  const tabs = () => page.$$eval('.staff-tabs [data-tab]', (b) => b.map((x) => x.dataset.tab));
  const selected = () => page.$eval('.staff-tabs [aria-selected="true"]', (b) => b.dataset.tab).catch(() => null);

  /* ---------- 1. the main account ---------- */
  await open('/pages/lair-staff', STAFF);
  await page.evaluate(() => localStorage.clear());
  await open('/pages/lair-staff', STAFF);
  await page.waitForSelector('.staff-tabs [data-tab]');
  const all = await tabs();
  check(`${tag}: the main account sees every tab (round 9: Accounts and Community too; round 10: Memberships and Damage), Team last`, JSON.stringify(all) === JSON.stringify(['floor', 'today', 'passes', 'groups', 'members', 'codes', 'holds', 'games', 'events', 'library', 'memberships', 'damage', 'accounts', 'community', 'team']), all);
  check(`${tag}: the main account starts on the floor, with the check-in box`, (await selected()) === 'floor' && (await page.isVisible('.checkin')), await selected());
  const people = await page.evaluate(() => {
    const list = window.Lair.store.backend.staffMembers();
    const pick = (name) => {
      const x = list.find((p) => p.name === name);
      return { id: String(x.customerId), code: x.code, email: x.email, name: x.name, first: x.name.split(' ')[0] };
    };
    return { mia: pick('Mia Chen'), tama: pick('Tama Rewiti'), sam: pick('Sam Tautahi') };
  });
  await page.click('[data-tab="team"]');
  await page.waitForSelector('staff-team .st-person--owner');
  const owner = flat(await page.textContent('staff-team .st-person--owner'));
  check(`${tag}: Team: the main account first, "Main account, everything"`, /Mo Ashgrove/.test(owner) && /Main account, everything/.test(owner), owner);
  const lede = flat(await page.textContent('staff-team .sa-lede'));
  check(`${tag}: Team says helpers don't get Shopify admin`, lede === 'Helpers can use this staff page with what you tick. They don’t get Shopify admin, so they don’t need a paid staff account.', lede);

  /* ---------- 2. add, change and remove a helper ---------- */
  await page.click('[data-team-new]');
  await page.waitForSelector('[data-team-form]');
  const boxes = await page.$$eval('[data-team-form] input[name="perm"]', (b) => b.map((x) => [x.value, x.checked]));
  check(`${tag}: a new helper starts with Check-in and Tables ticked, and Team isn't one to tick`,
    JSON.stringify(boxes) === JSON.stringify([['checkin', true], ['tables', true], ['sessions', false], ['events', false], ['members', false], ['money', false], ['library', false], ['community', false]]), boxes);
  // nobody picked: said plainly
  await page.click('[data-team-form] [type="submit"]');
  await page.waitForTimeout(200);
  check(`${tag}: saving with nobody picked says what to do`, flat(await page.textContent('[data-team-form] [data-form-error]')) === 'Pick a member from the search, or scan their card.');
  await page.fill('#team-pick', 'Mia');
  await page.waitForSelector('[data-team-form] [data-pick]', { timeout: 5000 });
  await page.click(`[data-team-form] [data-pick="${people.mia.id}"]`);
  await page.click('[data-team-form] [type="submit"]');
  await page.waitForSelector(`[data-team-person="${people.mia.id}"]`, { timeout: 5000 });
  const chips = await page.$$eval(`[data-team-person="${people.mia.id}"] .st-chip`, (c) => c.map((x) => x.textContent.trim()));
  check(`${tag}: Mia is a helper with Check-in and Tables`, JSON.stringify(chips) === JSON.stringify(['Check-in', 'Tables']), chips);
  check(`${tag}: the toast says so`, /Mia is a helper now/.test(await toastText(page)), await toastText(page));
  await page.click(`[data-team-edit="${people.mia.id}"]`);
  await page.check(`[data-team-edit-form="${people.mia.id}"] input[value="members"]`);
  await page.click(`[data-team-edit-form="${people.mia.id}"] [type="submit"]`);
  await page.waitForTimeout(400);
  const chips2 = await page.$$eval(`[data-team-person="${people.mia.id}"] .st-chip`, (c) => c.map((x) => x.textContent.trim()));
  check(`${tag}: Change: Mia can use Members too`, JSON.stringify(chips2) === JSON.stringify(['Check-in', 'Tables', 'Members']), chips2);
  await page.click(`[data-team-ask="${people.mia.id}"]`);
  const ask = flat(await page.textContent(`[data-team-person="${people.mia.id}"] .staff-confirm`));
  check(`${tag}: Remove asks first, and says what happens`, ask.startsWith('Remove Mia as a helper? They can’t use the staff page from now on. Their member account stays as it is.'), ask);
  check(`${tag}: focus moves to the question`, await page.evaluate(() => document.activeElement && document.activeElement.id.startsWith('team-rm-')));
  await page.click(`[data-team-person="${people.mia.id}"] [data-team-cancel]`);
  check(`${tag}: Keep them: still a helper`, await page.isVisible(`[data-team-person="${people.mia.id}"] .st-chip`));
  // a second helper to remove for real
  await page.click('[data-team-new]');
  await page.fill('#team-pick', 'Tama');
  await page.waitForSelector(`[data-team-form] [data-pick="${people.tama.id}"]`, { timeout: 5000 });
  await page.click(`[data-team-form] [data-pick="${people.tama.id}"]`);
  await page.click('[data-team-form] [type="submit"]');
  await page.waitForSelector(`[data-team-person="${people.tama.id}"]`);
  await page.click(`[data-team-ask="${people.tama.id}"]`);
  await page.click(`[data-team-remove="${people.tama.id}"]`);
  await page.waitForTimeout(400);
  check(`${tag}: Yes, remove: Tama's gone, and the log has it`, !(await page.$(`[data-team-person="${people.tama.id}"]`))
    && /Tama Rewiti stopped being a helper/.test(flat(await page.textContent('[data-team-log]'))), flat(await page.textContent('[data-team-log]')));
  check(`${tag}: Team: no sideways scroll`, (await overflowX(page)) === 0, await overflowX(page));
  await page.click('[data-team-new]');
  await shot(page, `${tag}-team`, 'staff-team');
  await scan(page, `${tag}: the Team tab with Add a helper open`, 'staff-team');
  // keyboard: from the search, Tab reaches every box, Make them a helper and Cancel
  await page.focus('#team-pick');
  const order = [];
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => {
      const a = document.activeElement;
      return a ? (a.name === 'perm' ? `perm:${a.value}` : a.matches('[type="submit"]') ? 'submit' : a.matches('[data-team-cancel]') ? 'cancel' : a.matches('[data-team-scan]') ? 'scan' : a.tagName) : '';
    }));
  }
  const want = ['perm:checkin', 'perm:tables', 'perm:sessions', 'perm:events', 'perm:members', 'perm:money', 'perm:library', 'perm:community', 'submit', 'cancel'];
  check(`${tag}: keyboard: Tab from the search reaches every box, then Make them a helper and Cancel, in order`, want.every((w, i) => order.indexOf(w) >= 0 && (i === 0 || order.indexOf(w) > order.indexOf(want[i - 1]))), order);
  await page.click('[data-team-form] [data-team-cancel]');

  /* ---------- 3. a member's page ---------- */
  await page.click('[data-tab="members"]');
  await page.waitForSelector('[data-members-find]');
  await page.fill('[data-members-find]', 'Mia');
  await page.waitForSelector(`[data-member-view="${people.mia.id}"]`, { timeout: 5000 });
  await page.click(`[data-member-view="${people.mia.id}"]`);
  await page.waitForSelector('[data-credit-now] .st-credit__balance', { timeout: 8000 });
  const sections = await page.$$eval('.staff-person .staff-sheet__sub', (h) => h.map((x) => x.textContent.trim()));
  check(`${tag}: Mia's page has Store credit, Library, Email them and Staff page`, ['Store credit', 'Library', 'Email them', 'Staff page'].every((s) => sections.includes(s)), sections);
  const balance0 = await page.evaluate(() => Number(String(document.querySelector('[data-credit-now] strong').textContent).replace(/[$,]/g, '')));
  check(`${tag}: her balance shows`, Number.isFinite(balance0), balance0);
  check(`${tag}: Staff page: "Mia is a helper." with what she can use`, /Mia is a helper\. They can use: Check-in, Tables and Members\./.test(flat(await page.textContent('[data-member-helper]'))), flat(await page.textContent('[data-member-helper]')));
  // add $10: the question first, with the balance before and after
  await page.fill('[data-credit-form] [name="amount"]', '10');
  await page.fill('[data-credit-form] [name="note"]', 'Paid up front for October');
  await page.click('[data-credit-form] [type="submit"]');
  await page.waitForSelector('[data-credit-ask] .staff-confirm');
  const q = flat(await page.textContent('[data-credit-ask] .staff-confirm'));
  const money = (n) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  check(`${tag}: "Add $10 to Mia’s store credit? Their balance goes from … to …"`, q.startsWith(`Add $10 to Mia’s store credit? Their balance goes from ${money(balance0)} to ${money(balance0 + 10)}.`), q);
  check(`${tag}: focus on the question; the form waits`, await page.evaluate(() => document.activeElement && document.activeElement.id.startsWith('credit-q-')) && (await page.isHidden('[data-credit-form]')));
  await page.click('[data-credit-yes]');
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => Number(String(document.querySelector('[data-credit-now] strong').textContent).replace(/[$,]/g, '')));
  check(`${tag}: Yes: the balance is $10 more, and the history has +$10 with the note`, after === balance0 + 10 && /\+\$10 · Paid up front for October/.test(flat(await page.textContent('[data-credit-history]'))), { after, history: flat(await page.textContent('[data-credit-history]')) });
  // a take-off: a note is needed, and never more than the balance
  await page.check('[data-credit-form] input[name="way"][value="take"]');
  await page.fill('[data-credit-form] [name="amount"]', '5');
  await page.fill('[data-credit-form] [name="note"]', '');
  await page.click('[data-credit-form] [type="submit"]');
  check(`${tag}: taking off with no note: "Add a note to say why the credit is coming off."`, flat(await page.textContent('[data-credit-form] [data-form-error]')) === 'Add a note to say why the credit is coming off.');
  await page.fill('[data-credit-form] [name="note"]', 'Too much');
  await page.fill('[data-credit-form] [name="amount"]', String(after + 50));
  await page.click('[data-credit-form] [type="submit"]');
  check(`${tag}: taking off more than she has is stopped, plainly`, flat(await page.textContent('[data-credit-form] [data-form-error]')) === `Mia has ${money(after)} of store credit, so you can take off ${money(after)} at most.`, flat(await page.textContent('[data-credit-form] [data-form-error]')));
  await page.fill('[data-credit-form] [name="amount"]', '5');
  await page.fill('[data-credit-form] [name="note"]', 'Took a $5 game home');
  await page.click('[data-credit-form] [type="submit"]');
  const q2 = flat(await page.textContent('[data-credit-ask] .staff-confirm'));
  check(`${tag}: "Take $5 off Mia’s store credit? Their balance goes from … to …"`, q2.startsWith(`Take $5 off Mia’s store credit? Their balance goes from ${money(after)} to ${money(after - 5)}.`), q2);
  await page.click('[data-credit-no]');
  check(`${tag}: Back: nothing changed, the form's back`, (await page.isVisible('[data-credit-form]')) && !(await page.$('[data-credit-ask] .staff-confirm')));
  // what she borrows
  const lib = flat(await page.textContent('[data-member-library]'));
  check(`${tag}: Library: her plan (or none) and where the work is done`, /Library/.test(lib) && /(No library plan|at a time)/.test(lib) && /The Library tab checks games out and in\./.test(lib), lib);
  // Email them: a preview, then sent and logged
  const nowLine = flat(await page.textContent('[data-email-now]'));
  check(`${tag}: Email them: to her address, replies to the shop, 30 a day`, nowLine.includes(`to ${people.mia.email}`) && /Replies come back to the shop\. You can send 30 more emails today\./.test(nowLine), nowLine);
  check(`${tag}: Signed starts with the sender's first name`, (await page.inputValue('[data-email-form] [name="signedAs"]')) === 'Mo');
  await page.fill('[data-email-form] [name="subject"]', 'Your pre-order is in');
  await page.fill('[data-email-form] [name="message"]', 'Kia ora Mia,\n\nYour pre-order came in today. It’s behind the counter.');
  await page.click('[data-email-form] [type="submit"]');
  await page.waitForSelector('[data-email-ask] .staff-confirm');
  const preview = flat(await page.textContent('[data-email-ask] .staff-confirm'));
  check(`${tag}: Preview: "Send this to <her email>?" with the email as she'll read it, signed Mo, Dice Goblin`, preview.startsWith(`Send this to ${people.mia.email}?`) && /Your pre-order is in ?Kia ora Mia, ?Your pre-order came in today\. It’s behind the counter\. ?Mo, Dice Goblin/.test(preview), preview);
  await shot(page, `${tag}-member-tools`, '.staff-person__side');
  await scan(page, `${tag}: a member's tools (store credit, library, email preview)`, '.staff-person');
  await page.click('[data-email-yes]');
  await page.waitForTimeout(500);
  check(`${tag}: Sent: the log has it, and one fewer left today`, /Your pre-order is in/.test(flat(await page.textContent('[data-email-log]'))) && /You can send 29 more emails today\./.test(flat(await page.textContent('[data-email-now]'))), flat(await page.textContent('[data-email-log]')));
  check(`${tag}: member page: no sideways scroll`, (await overflowX(page)) === 0, await overflowX(page));

  /* ---------- 4. the Events tab: add a member by code, and someone by name and email ---------- */
  await page.click('[data-tab="events"]');
  await page.waitForSelector('[data-ev-add-open]');
  await page.click('[data-ev-add-open]');
  await page.waitForSelector('[data-ev-add] [data-ev-dates]');
  const occ = await page.evaluate((handle) => {
    const opt = [...document.querySelectorAll('[data-ev-dates] option')].find((o) => o.value.startsWith(`${handle}@`));
    return opt ? opt.value : null;
  }, EVENT);
  check(`${tag}: the event form lists tomorrow's quiz night`, Boolean(occ), occ);
  await page.selectOption('[data-ev-dates]', occ);
  const places = flat(await page.textContent('[data-ev-places]'));
  check(`${tag}: places left and the fee show`, /places? left of 12 · \$10 each, paid at the counter/.test(places), places);
  await page.fill('#ev-add-pick', people.sam.code.toLowerCase());
  await page.waitForTimeout(700);
  const picked = flat(await page.textContent('[data-ev-add] [data-pick-picked]').catch(() => ''));
  check(`${tag}: a typed member code picks them at once`, picked.includes(people.sam.name), picked);
  await page.click('[data-ev-add] [type="submit"]');
  await page.waitForSelector('#ev-add-q');
  const evq = flat(await page.textContent('#ev-add-q'));
  check(`${tag}: it asks first: who, which date, the fee at the counter and the email`, evq.startsWith(`Add ${people.sam.name} to Quiz night (round 9),`) && evq.includes('$10 to pay at the counter.') && evq.includes(`Gobgob emails ${people.sam.email} their confirmation.`), evq);
  await scan(page, `${tag}: the event form's question`, 'staff-event-add');
  await page.click('[data-ev-yes]');
  await page.waitForTimeout(600);
  check(`${tag}: added: the toast says the fee`, /Added Sam Tautahi to Quiz night \(round 9\)\. \$10 to pay at the counter\./.test(await toastText(page)), await toastText(page));
  const joined = await page.evaluate((o) => (window.Lair.store.backend.state.joins || []).filter((j) => j.occurrenceId === o).map((j) => [j.name, j.customerId ? 'member' : 'invite']), occ);
  check(`${tag}: Sam is on that date's sign-ups`, JSON.stringify(joined) === JSON.stringify([[people.sam.name, 'member']]), joined);
  await page.selectOption('[data-ev-dates]', occ);
  await page.check('[data-ev-add] input[name="who"][value="new"]');
  await page.fill('#ev-add-name', 'Jo Bloggs');
  await page.fill('#ev-add-email', 'jo@example.com');
  await page.click('[data-ev-add] [type="submit"]');
  await page.waitForSelector('#ev-add-q');
  const evq2 = flat(await page.textContent('#ev-add-q'));
  check(`${tag}: someone without an account: invited, said in the question`, evq2.includes('Gobgob emails jo@example.com their confirmation and an invite to make an account.'), evq2);
  await page.click('[data-ev-yes]');
  await page.waitForTimeout(600);
  check(`${tag}: added and invited`, /They’re invited to make an account\./.test(await toastText(page)), await toastText(page));
  await page.selectOption('[data-ev-dates]', occ);
  await page.fill('#ev-add-pick', people.sam.code);
  await page.waitForTimeout(700);
  await page.click('[data-ev-add] [type="submit"]');
  await page.waitForSelector('#ev-add-q');
  await page.click('[data-ev-yes]');
  await page.waitForTimeout(500);
  check(`${tag}: Sam twice: the app's words`, /Sam Tautahi is already on the list for this one/.test(flat(await page.textContent('[data-ev-add] [data-form-error]'))), flat(await page.textContent('[data-ev-add] [data-form-error]')));
  await shot(page, `${tag}-event-add`, 'staff-event-add');
  check(`${tag}: Events: no sideways scroll`, (await overflowX(page)) === 0, await overflowX(page));

  /* ---------- 5. GM games: a member code picks the player at once ---------- */
  await page.click('[data-tab="games"]');
  await page.waitForTimeout(400);
  const gameId = await page.evaluate(() => {
    const g = window.Lair.store.data.games.find((x) => x.status === 'open' && x.end > Date.now() && (x.seats || 0) > (x.taken || 0));
    return g ? g.id : null;
  });
  if (gameId) {
    await page.evaluate((id) => document.querySelector('lair-staff').openGame({ id }), gameId);
    await page.waitForSelector('[data-gm-add] [data-member-search="add"]', { timeout: 5000 });
    await page.fill('[data-gm-add] [data-member-search="add"]', people.tama.code);
    await page.waitForTimeout(800);
    const got = await page.evaluate(() => ({ id: document.querySelector('[data-gm-add] [name="customerId"]').value, name: document.querySelector('[data-gm-add] [name="name"]').value }));
    check(`${tag}: GM games: a typed member code picks the player at once`, got.id === people.tama.id && got.name === people.tama.name, got);
  } else check(`${tag}: GM games: a demo game with a seat to add a player to`, false, 'none found');

  /* ---------- 6. the page as a helper sees it ---------- */
  await page.click('[data-tab="team"]');
  await page.waitForSelector('[data-team-preview]');
  await page.selectOption('[data-team-preview] [name="helper"]', people.mia.id);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('[data-team-preview] [type="submit"]')]);
  await page.waitForSelector('.staff-tabs [data-tab]');
  const helperTabs = await tabs();
  check(`${tag}: as Mia (Check-in, Tables, Members): the floor, Today, Members, Holds and Memberships (round 10); no Team, no money tabs`, JSON.stringify(helperTabs) === JSON.stringify(['floor', 'today', 'members', 'holds', 'memberships']), helperTabs);
  check(`${tag}: a helper with Check-in lands on Today`, (await selected()) === 'today', await selected());
  check(`${tag}: the banner says whose view it is`, /You’re seeing this page as Mia sees it\./.test(flat(await page.textContent('lair-staff'))));
  const money2 = await page.evaluate(() => ({
    refunds: [...document.querySelectorAll('[data-refunds]')].some((el) => el.offsetParent !== null && el.innerHTML.trim()),
    markRefunded: [...document.querySelectorAll('[data-act="refund"]')].some((el) => el.offsetParent !== null),
  }));
  check(`${tag}: as a helper without Money: no Refunds to sort, no Mark refunded`, !money2.refunds && !money2.markRefunded, money2);
  await shot(page, `${tag}-as-helper`);
  check(`${tag}: as a helper: no sideways scroll`, (await overflowX(page)) === 0, await overflowX(page));
  await page.goto(`${BASE}/pages/lair-staff#team`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.staff-tabs [data-tab]');
  check(`${tag}: a link to Team doesn't open it for a helper`, (await selected()) === 'today' && (await page.isHidden('#panel-team')), await selected());
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('[data-team-unpreview]')]);
  await page.waitForSelector('.staff-tabs [data-tab]');
  check(`${tag}: Back to the main account: every tab again`, (await tabs()).includes('team'));
  // Mia logged in herself
  const MIA = { id: Number(people.mia.id), first_name: 'Mia', last_name: 'Chen', name: 'Mia Chen', email: people.mia.email, phone: null, tags: [] };
  await open('/pages/lair-staff', MIA);
  await page.waitForSelector('.staff-tabs [data-tab]');
  check(`${tag}: Mia logged in: her tabs, on Today`, JSON.stringify(await tabs()) === JSON.stringify(['floor', 'today', 'members', 'holds', 'memberships']) && (await selected()) === 'today', await tabs());
  check(`${tag}: the view switch shows for her`, await page.isVisible('[data-view-switch]'));
  await open('/pages/my-lair#profile', MIA);
  await page.waitForTimeout(800);
  check(`${tag}: My Lair: Staff tools shows for a helper`, await page.evaluate(() => { const el = document.querySelector('[data-staff-tools]'); return Boolean(el && !el.hidden); }));

  /* ---------- 7. a customer who isn't staff ---------- */
  await open('/pages/lair-staff', RUBY);
  await page.waitForSelector('lair-staff .lair-locked p');
  const locked = flat(await page.textContent('lair-staff'));
  check(`${tag}: a customer who isn't staff: the locked message, no tabs`, /Staff only/.test(locked) && /This page is for the Dice Goblin team\. Helping out at the counter\? Ask the team to make you a helper\./.test(locked) && !(await page.$('.staff-tabs')), locked);
  check(`${tag}: no view switch for them`, !(await page.isVisible('[data-view-switch]').catch(() => false)));

  check(`${tag}: no console errors`, !errors.length, errors.join(' / '));
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

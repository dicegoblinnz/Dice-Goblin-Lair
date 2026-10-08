// Round 7, staff-games: staff make TTRPG sessions with the GMs' own form and table map, invite a GM by email, move a
// session, add players (one session, every week, or a seat reserved under a name), stop a regular and cancel an
// invite. Demo mode on the theme mock, phone (390x844) then desktop (1280x800). Prints a PASS or FAIL line per check,
// then a summary (exit 1 when anything failed).
//   1. The games board's Run a game is unchanged: a GM lists a weekly session through the five steps, tables on the map.
//   2. Staff "Make a session": the same steps and fields, the same map (a taken table shows taken, shop tables free for
//      staff), a customer picked as the GM.
//   3. A GM invited by email: the notice, "Invited: waiting for <email> to make an account", the email in the demo's
//      outbox, and a demo login with that email takes the session over.
//   4. Staff move a session to another table (Edit this session).
//   5. Add players: a customer for one session, a customer every week (a regular), a seat reserved under a name, every
//      week (an email needed, then an invite); stop a regular; cancel an invite.
//   6. The staff-made session's categories and sub-filters on the board (system, level, age, tags).
//   7. No sideways scroll, no console errors, and the session form's tap targets.
// Usage: DG_THEME=/path/to/theme QA_PORT=4853 [OUT=/dir] node tools/qa/round7/staff-games.mjs [phone|desktop]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
process.env.DG_THEME = process.env.DG_THEME || '/home/claude/r7/staff-games';
const m = await import('../theme-mock/render.mjs');
m.globalSettings.lair_mode = 'demo';

const PORT = Number(process.env.QA_PORT || 4853);
const BASE = `http://localhost:${PORT}`;
const OUT = `${process.env.OUT || path.join(os.tmpdir(), 'dg-round7-staff-games')}/`;
fs.mkdirSync(OUT, { recursive: true });
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const ONLY = process.argv[2];
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const GM = { id: 7700300001, first_name: 'Ari', last_name: 'Mason', name: 'Ari Mason', email: 'ari.gm@example.com', phone: null, tags: ['gm'], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` | ${String(detail).replace(/\s+/g, ' ').slice(0, 500)}` : ''}`);
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const errors = [];

const server = await m.serve(PORT);
const browser = await chromium.launch();

/** A page in a context (one context per size, so the demo's localStorage carries through), logged in as `customer` */
async function go(ctx, size, url, customer) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  if (!page.listening) {
    page.listening = true;
    page.on('pageerror', (e) => errors.push(`${size} pageerror: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`${size} console: ${msg.text()}`);
    });
  }
  m.mockState.customer = customer;
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  if (url.startsWith('/pages/gm-games')) await page.waitForSelector('.gm-card, .gm-empty', { timeout: 10000 });
  await page.waitForTimeout(400);
  return page;
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const outbox = (page) => page.evaluate(() => {
  try {
    return JSON.parse(localStorage.getItem('dg-lair-demo-v3')).outbox || [];
  } catch {
    return [];
  }
});
const demo = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('dg-lair-demo-v3') || '{}'));
/** Buttons, inputs and selects under 44px tall in a scope (a radio, checkbox or file input counts as its label) */
const smallTargets = (page, scope) => page.evaluate((r) => {
  const out = [];
  for (const el of document.querySelectorAll(`${r} button, ${r} a[href], ${r} input:not([type=hidden]), ${r} select, ${r} textarea, ${r} summary`)) {
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height || el.closest('[hidden]') || getComputedStyle(el).visibility === 'hidden') continue;
    const target = (el.matches('input[type=checkbox], input[type=radio], input[type=file]') && el.closest('label')) || el;
    const t = target.getBoundingClientRect();
    if (t.height < 43.5 && !el.closest('.floor')) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${(el.textContent || el.value || '').trim().slice(0, 30)}" ${Math.round(t.width)}x${Math.round(t.height)}`);
  }
  return out;
}, scope);
/** A day three days ahead (the Lair key), and two free tables in one room then that aren't shop tables */
const planFor = (page, { from = 18 * 60, hours = 4, days = 3, skip = [] } = {}) => page.evaluate(({ from, hours, days, skip }) => {
  const { store } = window.Lair;
  const t = store.time;
  const day = t.addDays(t.today(), days);
  const start = t.at(day, from);
  const end = start + hours * 3600000;
  for (const room of store.cfg.rooms) {
    if (!room.bookable || room.minPeople) continue;
    const free = room.tables.filter((tb) => store.isFree(tb.id, start, end) && !store.isShopTable(tb.id) && !skip.includes(tb.id));
    if (free.length >= 2) return { day, tables: free.slice(0, 2).map((tb) => tb.id) };
  }
  return null;
}, { from, hours, days, skip });
/** Tap tables on a form's map the way a person does (the map may be scrolled sideways) */
const tapTables = async (page, scope, ids) => {
  for (const id of ids) {
    await page.evaluate(({ scope, id }) => document.querySelector(`${scope} gm-floor [data-table="${id}"]`).click(), { scope, id });
    await page.waitForTimeout(120);
  }
};
const steps = async (page, scope) => flat(await page.locator(`${scope} .gm-steps__label`).first().innerText());

for (const size of Object.keys(SIZES).filter((s) => !ONLY || s === ONLY)) {
  const S = size;
  const vp = SIZES[size];
  const phone = vp.width < 700;
  const ctx = await browser.newContext({ viewport: vp, hasTouch: phone, isMobile: phone });

  /* ---------- 1. the games board: Run a game, as before (a GM lists a weekly session with the map) ---------- */
  let board = await go(ctx, S, '/pages/gm-games', GM);
  await board.click(phone ? '.gm-toolbar__host' : '.gm-perks [data-host]');
  await board.waitForSelector('[data-sheet][open] lair-session-form [data-host-form][data-step="game"]');
  const foot = flat(await board.locator('[data-sheet-foot]').textContent());
  check(`${S} board: Run a game opens in the sheet, step 1 of 5`, /Step 1 of 5 Your game/.test(flat(await board.locator('[data-sheet-steps]').innerText()))
    && /Next: players/.test(foot) && (await board.locator('#gm-host-form').count()) === 1, foot);
  const H = '[data-sheet]';
  await board.fill(`${H} [name="title"]`, `GM weekly (${S})`);
  await board.click(`${H} [data-host-form] label.chip:has-text("Daggerheart")`);
  await board.fill(`${H} [name="blurb"]`, 'A weekly sky-ship campaign. Drop in any week.');
  await board.click(`${H} [data-step-next]`);
  await board.waitForSelector(`${H} [data-step="players"]`);
  await board.click(`${H} [data-host-form] label.chip:has-text("All ages")`);
  await board.click(`${H} [data-step-next]`);
  await board.waitForSelector(`${H} [data-step="table"]`);
  await board.click(`${H} [data-host-form] label.pay-option:has-text("Made at the table")`);
  await board.click(`${H} [data-step-next]`);
  await board.waitForSelector(`${H} [data-step="when"]`);
  await board.click(`${H} [data-host-form] label.chip:has-text("Weekly")`);
  const gmPlan = await planFor(board, { days: 4 });
  await board.click(`${H} [data-day="${gmPlan.day}"]`);
  await board.click(`${H} [data-slot="${18 * 60}"]`);
  await board.waitForTimeout(200);
  const shopForGm = await board.evaluate(() => [...document.querySelectorAll('[data-sheet] gm-floor [data-table]')].filter((b) => ['T1', 'T2', 'T3'].includes(b.dataset.table)).map((b) => b.dataset.status));
  check(`${S} board: on a GM's map, shop tables are closed unless opened`, shopForGm.every((s) => s === 'taken'), shopForGm);
  await tapTables(board, H, gmPlan.tables);
  const picked = flat(await board.locator(`${H} [data-picked]`).innerText());
  check(`${S} board: the GM picks two free tables on the map`, picked.includes(gmPlan.tables[0]) && /Room for your 5 players/.test(picked), picked);
  check(`${S} board: the weekly hint names the day`, /Every \w+day\. We list your sessions up to \d+ days ahead/.test(flat(await board.locator(`${H} [data-schedule-hint]`).innerText())));
  await board.click(`${H} [data-step-next]`);
  await board.waitForSelector(`${H} [data-step="you"]`);
  const review = flat(await board.locator(`${H} [data-review]`).innerText());
  check(`${S} board: step 5 is you and your fee, with the review`, /Your GM name/.test(flat(await board.locator(`${H} [data-host-form]`).innerText())) && /then every \w+day/.test(review) && /Goes live Straight away\. You’re a trusted GM\./.test(review), review);
  await board.screenshot({ path: `${OUT}${S}-1-board-run-a-game.png` });
  await board.click(`${H} [data-step-next]`);
  await board.waitForSelector(`${H} .gm-done`);
  const done = flat(await board.locator(`${H} .gm-done`).innerText());
  check(`${S} board: Game listed: weekly dates listed, live now`, /Your game is live on the board/.test(done) && /\d+ dates listed/.test(done), done);
  await board.click(`${H} [data-sheet-foot] [data-game]`);
  await board.waitForTimeout(300);
  check(`${S} board: the GM sees their own game`, /Your game/.test(flat(await board.locator(`${H} .gm-own`).innerText().catch(() => ''))));
  // Add a session uses the same day, time and table picker
  await board.click(`${H} [data-add-session]`);
  await board.waitForSelector(`${H} [data-session-form] gm-floor`);
  await board.waitForTimeout(250);
  const addPlan = await planFor(board, { days: 6 });
  await board.click(`${H} [data-day="${addPlan.day}"]`);
  await board.click(`${H} [data-slot="${18 * 60}"]`);
  const already = await board.evaluate(() => [...document.querySelectorAll('[data-sheet] gm-floor [data-table].is-selected')].map((b) => b.dataset.table));
  await tapTables(board, H, already.filter((id) => !addPlan.tables.includes(id)));
  await tapTables(board, H, addPlan.tables.filter((id) => !already.includes(id)));
  await board.click(`${H} [data-session-submit]`);
  await board.waitForSelector(`${H} .gm-flash`, { timeout: 8000 }).catch(() => {});
  const added = flat(await board.locator(`${H} .gm-flash`).innerText().catch(() => ''));
  check(`${S} board: Add a session picks a day and tables on the map and adds the date`, /^Added \w+day \d{1,2} \w+\. Players can book it now\./.test(added), added);
  await board.locator(`${H} [data-close]`).first().click();
  await board.waitForTimeout(250);
  check(`${S} board: the new weekly game is on the board`, /Weekly/.test(flat(await board.locator('.gm-card', { hasText: `GM weekly (${S})` }).innerText().catch(() => ''))));

  /* ---------- 2. staff: Make a session, the same steps and map ---------- */
  let staff = await go(ctx, S, '/pages/lair-staff', STAFF);
  await staff.click('[data-tab="games"]');
  await staff.click('[data-gm-new]');
  const F = '[data-games] lair-session-form';
  await staff.waitForSelector(`${F} [data-host-form][data-step="game"]`);
  check(`${S} staff: Make a session uses the session form, step 1 of 5`, /Step 1 of 5 The game/.test(await steps(staff, F)));
  const names = await staff.evaluate((F) => [...document.querySelectorAll(`${F} [data-host-form] [name]`)].map((el) => el.name), F);
  check(`${S} staff: step 1 has the GMs' fields (title, system, pitch, picture)`, ['title', 'system', 'systemOther', 'blurb'].every((n) => names.includes(n)) && (await staff.locator(`${F} [data-photo-input]`).count()) === 1, names);
  await staff.click(`${F} [data-step-next]`);
  await staff.waitForTimeout(150);
  const empty = flat(await staff.locator(`${F} [data-host-form]`).innerText());
  check(`${S} staff: the same checks (an empty step 1 says what's missing)`, /Give the game a title\./.test(empty) && /Pick a system\./.test(empty) && /Write a line or two/.test(empty), empty.slice(0, 300));
  const title = `Staff-made Pathfinder (${S})`;
  await staff.fill(`${F} [name="title"]`, title);
  await staff.click(`${F} label.chip:has-text("Pathfinder 2e")`);
  await staff.fill(`${F} [name="blurb"]`, 'Abomination Vaults, for new players. Pre-made characters.');
  await staff.click(`${F} [data-step-next]`);
  await staff.waitForSelector(`${F} [data-step="players"]`);
  await staff.click(`${F} label.pay-option:has-text("New players welcome")`);
  await staff.click(`${F} label.chip:has-text("13+")`);
  await staff.click(`${F} label.chip:has-text("Dungeon crawl")`);
  await staff.click(`${F} label.chip:has-text("Teaching game")`);
  await staff.click(`${F} [data-step-next]`);
  await staff.waitForSelector(`${F} [data-step="table"]`);
  await staff.click(`${F} label.pay-option:has-text("Pre-generated")`);
  await staff.click(`${F} label.check:has-text("X-card")`);
  await staff.click(`${F} [data-step-next]`);
  await staff.waitForSelector(`${F} [data-step="when"]`);
  await staff.click(`${F} label.chip:has-text("Weekly")`);
  const day = await staff.evaluate(() => window.Lair.store.time.addDays(window.Lair.store.time.today(), 3));
  await staff.click(`${F} [data-day="${day}"]`);
  await staff.click(`${F} [data-slot="${18 * 60}"]`);
  await staff.waitForTimeout(250);
  const map = await staff.evaluate((F) => {
    const { store } = window.Lair;
    const t = store.time;
    const start = t.at(t.addDays(t.today(), 3), 18 * 60);
    const end = start + 4 * 3600000;
    const out = { shop: [], taken: null, free: [] };
    for (const b of document.querySelectorAll(`${F} gm-floor [data-table]`)) {
      const id = b.dataset.table;
      const room = store.roomOf(id);
      if (['T1', 'T2', 'T3'].includes(id)) out.shop.push(`${id}:${b.dataset.status}:${/open to staff/.test(b.getAttribute('aria-label'))}`);
      else if (room.bookable && !store.isFree(id, start, end) && !out.taken) out.taken = `${id}:${b.dataset.status}`;
    }
    return out;
  }, F);
  check(`${S} staff: the map shows a taken table as taken (${map.taken})`, Boolean(map.taken) && map.taken.endsWith(':taken'), JSON.stringify(map));
  check(`${S} staff: shop tables T1 to T3 are free for staff`, map.shop.length === 3 && map.shop.every((x) => x.endsWith(':free:true')), map.shop);
  const takenId = map.taken.split(':')[0];
  await tapTables(staff, F, [takenId]);
  check(`${S} staff: tapping a taken table says so`, new RegExp(`${takenId} is booked at that time`).test(flat(await staff.locator(`${F} [data-picked]`).innerText())));
  await tapTables(staff, F, ['T1', 'T2']);
  const staffPicked = flat(await staff.locator(`${F} [data-picked]`).innerText());
  check(`${S} staff: two shop tables picked`, /T1/.test(staffPicked) && /T2/.test(staffPicked) && /Room for its 5 players/.test(staffPicked), staffPicked);
  check(`${S} staff: the staff page's own floor map isn't touched by the form's map`, await staff.evaluate(() => document.querySelector('lair-staff').selected.length === 0));
  await staff.evaluate((F) => document.querySelector(`${F} [data-step="when"]`).scrollIntoView(), F);
  await staff.screenshot({ path: `${OUT}${S}-2-staff-when.png` });
  await staff.click(`${F} [data-step-next]`);
  await staff.waitForSelector(`${F} [data-step="gm"]`);
  check(`${S} staff: step 5 is Who’s running it?`, /Step 5 of 5 Who’s running it\?/.test(await steps(staff, F)));
  await staff.click(`${F} [data-step-next]`);
  await staff.waitForTimeout(150);
  check(`${S} staff: sending with no GM says pick one or type their name and email`, /Pick the GM from the customers, or type their name and email\./.test(flat(await staff.locator(`${F} [data-host-form]`).innerText())));
  await staff.fill(`${F} [data-sf-search]`, 'aroha');
  await staff.waitForSelector(`${F} [data-sf-pick]`, { timeout: 5000 });
  await staff.click(`${F} [data-sf-pick]`);
  await staff.waitForTimeout(150);
  const gmName = await staff.inputValue(`${F} [name="gm"]`);
  check(`${S} staff: picking a customer fills the GM name players see`, gmName === 'Aroha' && /Aroha Ngata/.test(flat(await staff.locator(`${F} [data-sf-picked]`).innerText())), gmName);
  await staff.click(`${F} label.pay-option:has-text("$10 a player")`);
  const staffReview = flat(await staff.locator(`${F} [data-review]`).innerText());
  check(`${S} staff: the review says who runs it and that it goes live now`, /GM Aroha \(aroha@example\.com\)/.test(staffReview) && /Players pay \$20 a seat/.test(staffReview) && /Straight away/.test(staffReview), staffReview);
  const small = await smallTargets(staff, F);
  check(`${S} staff: the session form's tap targets are 44px`, !small.length, small.join(', '));
  await staff.screenshot({ path: `${OUT}${S}-2-staff-gm-step.png`, fullPage: false });
  await staff.click(`${F} [data-step-next]`);
  await staff.waitForSelector('[data-games] .staff-gm__head h3', { timeout: 8000 });
  await staff.waitForTimeout(400);
  const made = await staff.evaluate((title) => window.Lair.store.data.games.filter((g) => g.title === title).sort((a, b) => a.start - b.start), title);
  const first = made[0] || {};
  check(`${S} staff: the session is made for the customer (linked), weekly, on T1 and T2`, made.length > 1 && first.gmAccount === 'linked' && first.schedule === 'weekly' && first.tables.join() === 'T1,T2' && first.status === 'open'
    && first.gm === 'Aroha' && first.gmFee === 1000 && first.level === 'new' && first.age === '13+' && first.tags.join() === 'Dungeon crawl,Teaching game' && first.characters === 'pregens', JSON.stringify(first).slice(0, 400));
  check(`${S} staff: after making it, the page offers Add players`, /Add players/.test(flat(await staff.locator('[data-gm-add-wrap]').innerText())) && (await staff.locator('[data-gm-add-wrap].staff-gm__section--new').count()) === 1);
  const gmLive = (await outbox(staff)).filter((e) => e.kind === 'gm-live').pop();
  check(`${S} demo outbox: the picked GM hears their game is live`, Boolean(gmLive) && gmLive.to === 'aroha@example.com' && gmLive.subject === `Your game is live: ${title}`, JSON.stringify(gmLive));

  /* ---------- 5. players: a customer once, a customer every week, a seat under a name, an invite ---------- */
  const A = '[data-gm-add]';
  const addCustomer = async (q, weekly = false) => {
    await staff.fill(`${A} [data-member-search="add"]`, q);
    await staff.waitForSelector(`${A} [data-member-pick]`, { timeout: 5000 });
    await staff.click(`${A} [data-member-pick]`);
    if (weekly) await staff.check(`${A} [name="weekly"]`);
    await staff.click(`${A} button[type="submit"]`);
    await staff.waitForTimeout(600);
  };
  await addCustomer('sam');
  let toast = flat(await staff.locator('.toast').innerText().catch(() => ''));
  check(`${S} players: a customer for this session`, /Added Sam Tautahi to /.test(toast) && /They pay at the counter/.test(toast), toast);
  await addCustomer('priya', true);
  toast = flat(await staff.locator('.toast').innerText().catch(() => ''));
  let players = flat(await staff.locator('[data-gm-players]').innerText());
  check(`${S} players: a customer every week becomes a regular`, /They’re a regular now/.test(toast) && /Regulars/.test(players) && /Priya Nair/.test(players) && (await staff.locator('[data-gm-stop]').count()) >= 1, `${toast} || ${players}`);
  const priyaMail = (await outbox(staff)).filter((e) => e.kind === 'regular').pop();
  check(`${S} demo outbox: "You're a regular" from the team`, Boolean(priyaMail) && /Kia ora Priya Nair, the Dice Goblin team has saved your seat at .+ with GM Aroha every week\./.test(Object.fromEntries(priyaMail.lines).Intro || ''), JSON.stringify(priyaMail));
  await staff.fill(`${A} [name="name"]`, 'Kai Reserved');
  await staff.click(`${A} button[type="submit"]`);
  await staff.waitForTimeout(600);
  players = flat(await staff.locator('[data-gm-players]').innerText());
  check(`${S} players: a seat reserved under a name`, /Reserved a seat for Kai Reserved/.test(flat(await staff.locator('.toast').innerText().catch(() => ''))) && /Kai Reserved Reserved: no account yet/.test(players), players);
  await staff.fill(`${A} [name="name"]`, 'Wren Invite');
  await staff.check(`${A} [name="weekly"]`);
  await staff.click(`${A} button[type="submit"]`);
  await staff.waitForTimeout(400);
  const noEmail = flat(await staff.locator('.toast').innerText().catch(() => ''));
  check(`${S} players: every week under a name needs an email`, /Add their email, so Gobgob can invite them to keep the seat\./.test(noEmail), noEmail);
  await staff.fill(`${A} [name="email"]`, `wren.${S}@example.com`);
  await staff.click(`${A} button[type="submit"]`);
  await staff.waitForTimeout(700);
  toast = flat(await staff.locator('.toast').innerText().catch(() => ''));
  players = flat(await staff.locator('[data-gm-players]').innerText());
  check(`${S} players: every week under a name is an invite`, /Gobgob emailed wren\.\w+@example\.com to make an account and keep it every week/.test(toast)
    && /invited to keep their seat every week: waiting for wren\.\w+@example\.com to make an account/.test(players) && (await staff.locator('[data-gm-uninvite]').count()) === 1, `${toast} || ${players}`);
  const wrenMail = (await outbox(staff)).filter((e) => e.kind === 'seat-confirmation' && e.to === `wren.${S}@example.com`).pop();
  check(`${S} demo outbox: the reserved weekly seat's confirmation invites them`, Boolean(wrenMail) && /It's a weekly game: make your Dice Goblin account with this email and Gobgob will save your seat every week\./.test(Object.fromEntries(wrenMail.lines)['Your account'] || ''), JSON.stringify(wrenMail));
  await staff.screenshot({ path: `${OUT}${S}-5-players.png`, fullPage: true });
  // stop the regular (two taps), cancel the invite (two taps)
  await staff.click('[data-gm-stop]');
  await staff.click('[data-gm-stop]');
  await staff.waitForTimeout(600);
  toast = flat(await staff.locator('.toast').innerText().catch(() => ''));
  const st = await demo(staff);
  check(`${S} players: Stop saving their seat stops the regular`, /stopped saving Priya Nair’s seat/.test(toast) && !(st.seriesMembers || []).some((x) => x.seriesId === first.seriesId && x.name === 'Priya Nair')
    && (await staff.locator('[data-gm-stop]').count()) === 0, toast);
  await staff.click('[data-gm-uninvite]');
  await staff.click('[data-gm-uninvite]');
  await staff.waitForTimeout(600);
  toast = flat(await staff.locator('.toast').innerText().catch(() => ''));
  check(`${S} players: Cancel invite cancels it, the seat stays`, /Invite cancelled/.test(toast) && (await staff.locator('[data-gm-uninvite]').count()) === 0
    && /Wren Invite/.test(flat(await staff.locator('[data-gm-players]').innerText())), toast);
  // another invite, taken up when they log in with that email: they're a regular, and the reserved seat is theirs
  const kahuEmail = `kahu.${S}@example.com`;
  await staff.fill(`${A} [name="name"]`, 'Kahu Invite');
  await staff.fill(`${A} [name="email"]`, kahuEmail);
  await staff.check(`${A} [name="weekly"]`);
  await staff.click(`${A} button[type="submit"]`);
  await staff.waitForTimeout(700);
  const KAHU = { id: 7700300077, first_name: 'Kahu', last_name: 'Rawiri', name: 'Kahu Rawiri', email: kahuEmail, phone: null, tags: [], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
  await go(ctx, S, '/pages/gm-games', KAHU);
  await (ctx.pages()[0]).waitForTimeout(800);
  const taken = await demo(ctx.pages()[0]);
  const kahuInvite = (taken.seriesInvites || []).find((x) => x.email === kahuEmail) || {};
  const kahuRegular = (taken.seriesMembers || []).find((x) => x.seriesId === first.seriesId && x.customerId === '7700300077');
  const kahuSeat = (taken.bookings || []).find((b) => b.id === kahuInvite.bookingId) || {};
  check(`${S} players: logging in with the invited email makes them a regular, with the reserved seat`, kahuInvite.status === 'joined' && Boolean(kahuRegular) && kahuSeat.customerId === '7700300077' && kahuSeat.seriesId === first.seriesId,
    JSON.stringify({ kahuInvite, kahuRegular, seat: kahuSeat.customerId }));
  staff = await go(ctx, S, '/pages/lair-staff', STAFF);
  await staff.click('[data-tab="games"]');
  await staff.click(`.staff-gm-row[data-gm-manage="${first.id}"]`);
  await staff.waitForSelector('[data-gm-players]');
  await staff.waitForTimeout(300);
  players = flat(await staff.locator('[data-gm-players]').innerText());
  check(`${S} players: the staff view shows Kahu as a regular now`, /Kahu Invite Regular/.test(players) && (await staff.locator('[data-gm-stop]').count()) === 1, players);

  /* ---------- 4. staff move a session to another table (Edit this session) ---------- */
  await staff.click('[data-panel="games"] .staff-gm__more summary');
  const E = '[data-gm-edit-wrap] lair-session-form';
  await staff.waitForSelector(`${E} [data-host-form]`);
  check(`${S} edit: Edit this session is the session form, every part a tap away`, /Editing The game/.test(await steps(staff, E)) && (await staff.locator(`${E} [data-sf-step]`).count()) === 5
    && (await staff.inputValue(`${E} #gm-edit-title`)) === title);
  await staff.click(`${E} [data-sf-step="3"]`);
  await staff.waitForSelector(`${E} [data-step="when"]`);
  await staff.waitForTimeout(200);
  const movePlan = await planFor(staff, { days: 3, skip: ['T1', 'T2'] });
  await tapTables(staff, E, ['T1', 'T2', ...movePlan.tables]);
  const movePicked = flat(await staff.locator(`${E} [data-picked]`).innerText());
  check(`${S} edit: the session's own tables show as picked, and others can be picked`, movePicked.includes(movePlan.tables[0]) && !/T1/.test(movePicked), movePicked);
  await staff.screenshot({ path: `${OUT}${S}-4-edit-move.png` });
  await staff.click(`${E} [data-sf-save]`);
  await staff.waitForTimeout(800);
  toast = flat(await staff.locator('.toast').innerText().catch(() => ''));
  const moved = await staff.evaluate((id) => window.Lair.store.data.games.find((g) => g.id === id), first.id);
  check(`${S} edit: Save moves the session to the new tables`, /Saved\. The GM and every player moved with it\./.test(toast) && moved.tables.join() === movePlan.tables.join(), `${toast} | ${moved && moved.tables}`);
  const seatsMoved = await staff.evaluate((id) => window.Lair.store.data.bookings.filter((b) => b.gameId === id && ['confirmed', 'held'].includes(b.status)).every((b) => b.tables.join() === window.Lair.store.data.games.find((g) => g.id === id).tables.join()), first.id);
  check(`${S} edit: every seat and the GM's hold moved with it`, seatsMoved);

  /* ---------- 3. a GM invited by email ---------- */
  await staff.click('[data-gm-back]');
  await staff.click('[data-gm-new]');
  await staff.waitForSelector(`${F} [data-host-form][data-step="game"]`);
  const inviteTitle = `Invited GM's one-shot (${S})`;
  await staff.fill(`${F} [name="title"]`, inviteTitle);
  await staff.click(`${F} label.chip:has-text("Other")`);
  await staff.fill(`${F} [name="systemOther"]`, 'Mothership');
  await staff.fill(`${F} [name="blurb"]`, 'A salvage crew and a silent station.');
  await staff.click(`${F} [data-step-next]`);
  await staff.click(`${F} label.pay-option:has-text("Veterans")`);
  await staff.click(`${F} label.chip:has-text("18+")`);
  await staff.click(`${F} label.chip:has-text("Horror")`);
  await staff.click(`${F} [data-step-next]`);
  await staff.click(`${F} label.pay-option:has-text("Pre-generated")`);
  await staff.click(`${F} [data-step-next]`);
  await staff.waitForSelector(`${F} [data-step="when"]`);
  const invitePlan = await planFor(staff, { days: 5, from: 19 * 60, hours: 3 });
  await staff.click(`${F} [data-day="${invitePlan.day}"]`);
  await staff.click(`${F} [data-stepper="hours"] [data-step-down]`);
  await staff.click(`${F} [data-slot="${19 * 60}"]`);
  await tapTables(staff, F, invitePlan.tables);
  await staff.click(`${F} [data-step-next]`);
  await staff.waitForSelector(`${F} [data-step="gm"]`);
  await staff.click(`${F} label.pay-option:has-text("Not a customer yet")`);
  const inviteEmail = `new.gm.${S}@example.com`;
  await staff.fill(`${F} [name="inviteEmail"]`, inviteEmail);
  await staff.fill(`${F} [name="gm"]`, 'Rua');
  await staff.click(`${F} [data-step-next]`);
  await staff.waitForSelector('[data-games] .staff-gm__head h3', { timeout: 8000 });
  await staff.waitForTimeout(400);
  toast = flat(await staff.locator('.toast').innerText().catch(() => ''));
  check(`${S} invite: the notice says Gobgob emailed them`, toast.includes(`Gobgob emailed ${inviteEmail} to make an account. The game joins their account when they log in with that email.`), toast);
  const head = flat(await staff.locator('[data-gm-head]').innerText());
  check(`${S} invite: the staff view says Invited: waiting for them`, head.includes(`Invited: waiting for ${inviteEmail} to make an account`), head);
  const invite = (await outbox(staff)).filter((e) => e.kind === 'gm-invite').pop();
  check(`${S} demo outbox: the GM invite email`, Boolean(invite) && invite.to === inviteEmail && invite.subject === `You're running ${inviteTitle} at the Dice Goblin Lair`
    && /Kia ora Rua, the Dice Goblin team has put/.test(Object.fromEntries(invite.lines).Intro || ''), JSON.stringify(invite).slice(0, 300));
  await staff.screenshot({ path: `${OUT}${S}-3-invited.png` });
  const invitedId = await staff.evaluate((t) => (window.Lair.store.data.games.find((g) => g.title === t) || {}).id, inviteTitle);
  check(`${S} invite: listed as Invited in the games list`, await staff.evaluate((t) => window.Lair.store.data.games.some((g) => g.title === t && g.gmAccount === 'invited'), inviteTitle));
  // a demo login with that email takes it over
  const NEWGM = { id: 7700300099, first_name: 'Rua', last_name: 'Tipene', name: 'Rua Tipene', email: inviteEmail, phone: null, tags: [], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
  board = await go(ctx, S, `/pages/gm-games#game=${encodeURIComponent(invitedId)}`, NEWGM);
  await board.waitForTimeout(1200);
  await board.evaluate((id) => {
    const el = document.querySelector('gm-board');
    if (!el.dialog.open) el.openGame(id, { keepHash: true });
  }, invitedId);
  await board.waitForSelector('[data-sheet] .gm-own', { timeout: 8000 }).catch(() => {});
  const own = flat(await board.locator('[data-sheet] .gm-own').innerText().catch(() => ''));
  check(`${S} invite: logging in with that email, the session is theirs (Your game on the board)`, /Your game/.test(own) && /Message your players/.test(own), own.slice(0, 200));
  staff = await go(ctx, S, '/pages/lair-staff', STAFF);
  const linked = await staff.evaluate((id) => (window.Lair.store.data.games.find((g) => g.id === id) || {}).gmAccount, invitedId);
  check(`${S} invite: the staff page now shows it on their account`, linked === 'linked', linked);

  /* ---------- 6. the staff-made session on the board: categories and sub-filters ---------- */
  board = await go(ctx, S, '/pages/gm-games', null);
  const card = board.locator('.gm-card', { hasText: title });
  check(`${S} board: the staff-made session is on the board`, (await card.count()) === 1);
  const cardText = flat(await card.innerText().catch(() => ''));
  check(`${S} board: its card shows its level, age and tags`, /New players welcome/.test(cardText) && /13\+/.test(cardText) && /Dungeon crawl/.test(cardText) && /Weekly/.test(cardText), cardText);
  const filter = async (sel, value) => {
    await board.evaluate(({ sel, value }) => {
      const form = document.querySelector('[data-filters]');
      const el = form.querySelector(sel);
      if (el.tagName === 'SELECT') el.value = value;
      else el.checked = true;
      form.dispatchEvent(new Event('change', { bubbles: true }));
    }, { sel, value });
    await board.waitForTimeout(150);
    return (await board.locator('.gm-card', { hasText: title }).count()) === 1;
  };
  check(`${S} board: the Pathfinder 2e system chip finds it`, await filter('[name="system"][value="Pathfinder 2e"]'));
  check(`${S} board: New players welcome finds it`, await filter('[name="newbie"]'));
  check(`${S} board: Teens welcome finds it`, await filter('[name="age"]', 'teens'));
  check(`${S} board: 18+ games leaves it out`, !(await filter('[name="age"]', 'adults')));
  await board.evaluate(() => document.querySelector('[data-filters]').reset());
  board = await go(ctx, S, '/pages/gm-games', null);
  check(`${S} board: the invited GM's Mothership session is under Other`, await filter('[name="system"][value="other"]').then(async () => (await board.locator('.gm-card', { hasText: inviteTitle }).count()) === 1));
  await board.screenshot({ path: `${OUT}${S}-6-board.png` });

  /* ---------- 7. no sideways scroll, no errors ---------- */
  check(`${S} board: no sideways scroll`, (await overflow(board)) <= 0, await overflow(board));
  staff = await go(ctx, S, '/pages/lair-staff', STAFF);
  await staff.click('[data-tab="games"]');
  await staff.click('[data-gm-new]');
  await staff.waitForSelector(`${F} [data-host-form]`);
  check(`${S} staff: no sideways scroll`, (await overflow(staff)) <= 0, await overflow(staff));
  await ctx.close();
}
check('no console errors', errors.length === 0, errors.join(' | '));
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed} of ${results.length} passed`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);

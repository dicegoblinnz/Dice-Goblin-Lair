// Round 11, Warhammer game tables (contract v11-warhammer). Mo (9 Oct, 7pm): "Book tables from T8-T21 ... for Warhammer
// with games needing to be organized for one on one or two on two games, and people inside the Warhammer group can book
// their spots with the code of Thier opponent or their email to help them join us. They can choose a specific table as
// well but it needs to be two at a time ... set the fee to $10 per person."
// Demo mode on the theme mock, phone (390px) then desktop (1280px), each in a fresh browser (a fresh demo), with Mo's
// Warhammer night tonight (6pm to midnight, T8-T21 held, six pairs, T16-T17 the painting station, $10 a person):
//   1. the form: "Pick your tables" (the six pairs, the first free one picked), "Game size" (1 v 1 picked) and "Who's
//      playing" (one box for 1 v 1, three for 2 v 2, what's typed kept), the price line ($10 a person and the total)
//   2. an empty box is stopped by the form; an unknown member code is refused by the app (on that box)
//   3. 1 v 1 with a member code on the pair picked: the ticket (tables, 1 v 1, who's playing, $10 a person each)
//   4. a pair someone else just took is refused, marked taken and the next free one picked; taken pairs show "taken"
//   5. 2 v 2 with two codes and an email: the ticket says "You and … against … and …"
//   6. My Lair: the booker sees who's playing; a named member sees "You're playing in Ruby's game", the tables, their
//      own $10, their Goblin card as the ticket and nothing to cancel; the calendar says the same
//   7. the staff page: an opponent's member code finds the game ("Playing", their share); Check in checks it in, and the
//      card lists the players
//   8. axe (WCAG 2.1 A and AA) on the form, the ticket, My Lair and the staff card; the keyboard through the form (one
//      Tab stop for the pairs, arrows skip a taken pair, the size changes the boxes); no sideways scroll; no console errors
// Screenshots go to OUT, or a folder in the system's temp directory. Without AXE (axe-core's axe.min.js) the axe part is
// skipped, and says so.
// Usage: DG_THEME=/path/to/theme PORT=4931 [AXE=/path/to/axe.min.js] [OUT=/dir] node tools/qa/round11/warhammer.mjs [phone|desktop]
// Exits 1 on a FAIL.
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
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round11-warhammer');
const AXE = process.env.AXE || '';
const axe = AXE && fs.existsSync(AXE) ? fs.readFileSync(AXE, 'utf8') : null;
fs.mkdirSync(OUT, { recursive: true });
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
const ev = await import(new URL('../theme-mock/events-mock.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || process.env.QA_PORT || 4931);
const BASE = `http://localhost:${PORT}`;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };

/* ---------- Lair dates, the page clock (today, 1pm) and Mo's Warhammer night tonight ---------- */
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
const HANDLE = 'r11-warhammer-night';
const TITLE = 'Warhammer night (round 11)';
ev.extraEvents.push({
  handle: HANDLE, title: TITLE, event_type: 'wargame', starts_at: iso(today, '18:00'), ends_at: iso(tomorrow, '00:00'), image_slug: 'warhammer', game: 'Warhammer',
  description: 'Bring your army: 1 v 1 or 2 v 2 on a pair of tables.', tables: 'T8-T21', lock_tables: true,
  game_tables: 'T8+T9, T10+T11, T12+T13, T14+T15, T18+T19, T20+T21', entry_fee: 10, payment: null,
});
const PAIRS = ['T8+T9', 'T10+T11', 'T12+T13', 'T14+T15', 'T18+T19', 'T20+T21'];

const RUBY = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [] };
const KAI = { id: 7700112244, first_name: 'Kai', last_name: 'Ngata', name: 'Kai Ngata', email: 'kai@example.com', phone: null, tags: [] };
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const MOBILE = '021 555 0123';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  return ok;
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const text = async (page, sel) => flat(await page.textContent(sel).catch(() => ''));
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
let axeTotal = 0;
async function scan(page, label, selector) {
  if (!axe) return;
  await page.addScriptTag({ content: axe });
  const found = await page.evaluate(async (sel) => {
    const r = await window.axe.run(document.querySelector(sel), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  }, selector);
  axeTotal += found.length;
  check(`axe: ${label}: no WCAG 2.1 A/AA violations`, !found.length, found.join(' / '));
}
const shot = async (page, name, sel = null) => {
  const el = sel ? await page.$(sel) : null;
  await (el || page).screenshot({ path: `${OUT}/${name}.png`, ...(el ? {} : { fullPage: false }) }).catch(() => {});
};

/** What the reserve form shows */
const formLook = (page) => page.evaluate(() => {
  const f = document.querySelector('[data-reserve-form]');
  if (!f) return null;
  const legends = [...f.querySelectorAll('legend')].map((l) => l.textContent.replace(/\s+/g, ' ').trim());
  return {
    legends,
    pairs: [...f.querySelectorAll('[name="spot"]')].map((r) => ({ v: r.value, on: r.checked, off: r.disabled, text: r.closest('label').textContent.replace(/\s+/g, ' ').trim() })),
    sizes: [...f.querySelectorAll('[name="people"]')].map((r) => ({ v: r.value, on: r.checked, text: r.closest('label').textContent.replace(/\s+/g, ' ').trim() })),
    rows: [...f.querySelectorAll('[data-player]')].map((r) => ({ role: r.dataset.role, label: r.querySelector('.field__label').textContent.trim(), value: r.querySelector('input').value, error: (r.querySelector('.field__error') || {}).textContent || '' })),
    total: (f.querySelector('[data-total]') || {}).textContent?.replace(/\s+/g, ' ').trim() || '',
    legend: (f.querySelector('.cal-pay legend') || {}).textContent?.replace(/\s+/g, ' ').trim() || '',
    button: (document.querySelector('button[form="cal-reserve-form"]') || {}).textContent?.replace(/\s+/g, ' ').trim() || '',
    status: (f.querySelector('[data-form-status]') || {}).textContent?.replace(/\s+/g, ' ').trim() || '',
    active: document.activeElement && document.activeElement.closest('[data-player]') ? `player:${document.activeElement.closest('[data-player]').dataset.n}` : document.activeElement?.name || document.activeElement?.tagName,
  };
});

const server = await m.serve(PORT);
const browser = await chromium.launch();

for (const size of process.argv[2] ? [process.argv[2]] : ['phone', 'desktop']) {
  const phone = size === 'phone';
  const tag = size;
  const ctx = await browser.newContext({ viewport: SIZES[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(CLOCK);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()); });
  const open = async (where, customer) => {
    m.mockState.customer = customer;
    await page.goto('about:blank');
    await page.goto(`${BASE}${where}`, { waitUntil: 'networkidle', timeout: 60000 });
  };
  await open('/pages/events-calendar', RUBY);
  await page.evaluate(() => localStorage.clear());
  await open('/pages/events-calendar', RUBY);
  await page.waitForSelector('lair-calendar .cal-card', { state: 'attached', timeout: 20000 });
  const id = await page.evaluate((h) => (document.querySelector('lair-calendar').all().find((i) => i.handle === h) || {}).id, HANDLE);
  check(`${tag}: Mo's Warhammer night is on the calendar tonight`, Boolean(id), id);
  const people = await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const list = be.staffMembers();
    const pick = (name) => { const x = list.find((p) => p.name === name); return { id: String(x.customerId), code: x.code, email: x.email, name: x.name }; };
    return { mia: pick('Mia Chen'), hemi: pick('Hemi Walker'), tama: pick('Tama Rewiti'), ruby: be.memberView(window.Lair.store.cfg.customer).code };
  });
  const MIA = { id: Number(people.mia.id), first_name: 'Mia', last_name: 'Chen', name: 'Mia Chen', email: people.mia.email, phone: null, tags: [] };
  const openForm = async (customer) => {
    await open(`/pages/events-calendar#event=${encodeURIComponent(id)}`, customer);
    await page.waitForTimeout(700);
    await page.click(`[data-reserve="${id}"]`);
    await page.waitForSelector('[data-reserve-form]');
    await page.waitForTimeout(300);
    await page.fill('[data-reserve-form] [name="phone"]', MOBILE);
  };
  const submit = async () => {
    await page.click('button[form="cal-reserve-form"]');
    await page.waitForTimeout(700);
  };

  /* ---------- 1. the form ---------- */
  await openForm(RUBY);
  let f = await formLook(page);
  check(`${tag}: the form asks "Pick your tables", "Game size" and "Who's playing"`, ['Pick your tables', 'Game size', 'Who’s playing'].every((l) => f.legends.includes(l)), f.legends);
  check(`${tag}: the six pairs ("T8 + T9" …), the painting station not among them, the first free one picked`,
    f.pairs.map((p) => p.v).join() === PAIRS.join() && f.pairs.map((p) => p.text).join('|') === PAIRS.map((p) => p.replace('+', ' + ')).join('|') && f.pairs.filter((p) => p.on).map((p) => p.v).join() === 'T8+T9' && !f.pairs.some((p) => p.off), f.pairs);
  check(`${tag}: 1 v 1 (2 players) or 2 v 2 (4 players), 1 v 1 picked, with one box: "Your opponent"`,
    f.sizes.map((s) => s.text).join('|') === '1 v 1 (2 players)|2 v 2 (4 players)' && f.sizes.find((s) => s.on).v === '2' && f.rows.length === 1 && f.rows[0].label === 'Your opponent', f);
  check(`${tag}: the price line says $10 a person and the total; the button says each pays at the counter`,
    f.legend === 'Table fee $10 a person' && /^\$10 a person × 2 players, each paid at the counter\s*\$20$/.test(f.total) && f.button === 'Reserve · $10 each at the counter', f);
  await page.fill('[data-player] input', people.mia.code);
  await page.check('[name="people"][value="4"]', { force: true });
  await page.waitForTimeout(150);
  f = await formLook(page);
  check(`${tag}: 2 v 2: your teammate and two opponents, the opponent typed kept as the first; $40 for 4 players`,
    f.rows.map((r) => `${r.role}:${r.label}:${r.value}`).join('|') === `teammate:Your teammate:|opponent:Opponent 1:${people.mia.code}|opponent:Opponent 2:` && /× 4 players/.test(f.total) && /\$40$/.test(f.total), f);
  await page.check('[name="people"][value="2"]', { force: true });
  await page.waitForTimeout(150);
  f = await formLook(page);
  check(`${tag}: back to 1 v 1: one box, the opponent kept`, f.rows.length === 1 && f.rows[0].value === people.mia.code && /\$20$/.test(f.total), f.rows);
  await page.evaluate(() => document.querySelector('[data-reserve-form] .cal-pairs').scrollIntoView({ block: 'start' }));
  await shot(page, `${tag}-1-form`);

  /* ---------- 2. an empty box, then a code nobody has ---------- */
  await page.fill('[data-player] input', '');
  await submit();
  f = await formLook(page);
  check(`${tag}: an empty box: "Add a member code or an email for each player." under it, the focus there`,
    f.rows[0].error === 'Add a member code or an email for each player.' && f.active === 'player:0', f);
  await page.fill('[data-player] input', 'zz-nope-1');
  check(`${tag}: typing clears the problem`, !(await formLook(page)).rows[0].error);
  await submit();
  f = await formLook(page);
  check(`${tag}: a code nobody has is refused by the app, on that box: "Gobgob doesn't know the member code ZZ-NOPE-1. …"`,
    f.rows[0].error === "Gobgob doesn't know the member code ZZ-NOPE-1. Check it, or use their email instead." && f.active === 'player:0', f);
  await page.evaluate(() => document.querySelector('[data-player]').scrollIntoView({ block: 'center' }));
  await shot(page, `${tag}-2-refused`);
  await scan(page, `${tag} the reserve form, with a problem showing`, '[data-reserve-form]');
  check(`${tag}: no sideways scroll on the form`, (await overflowX(page)) <= 0, await overflowX(page));

  /* ---------- 8a. the keyboard through the form ---------- */
  await page.focus('[data-reserve-form] [name="phone"]');
  await page.keyboard.press('Tab');
  let k = await page.evaluate(() => ({ name: document.activeElement.name, value: document.activeElement.value }));
  check(`${tag}: keyboard: Tab from the mobile lands on the picked pair (one stop for the pairs)`, k.name === 'spot' && k.value === 'T8+T9', k);
  await page.keyboard.press('ArrowRight');
  k = await page.evaluate(() => ({ name: document.activeElement.name, value: document.activeElement.value, on: document.activeElement.checked }));
  check(`${tag}: keyboard: an arrow picks the next pair`, k.name === 'spot' && k.value === 'T10+T11' && k.on, k);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Tab');
  k = await page.evaluate(() => ({ name: document.activeElement.name, value: document.activeElement.value }));
  check(`${tag}: keyboard: the next Tab is the game size`, k.name === 'people' && k.value === '2', k);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  await page.keyboard.press('Tab');
  k = await page.evaluate(() => ({ player: document.activeElement.closest('[data-player]')?.dataset.role, rows: document.querySelectorAll('[data-player]').length }));
  check(`${tag}: keyboard: 2 v 2 by arrow, then Tab to the first of three boxes (your teammate)`, k.player === 'teammate' && k.rows === 3, k);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(150);

  /* ---------- 3. 1 v 1 with a member code on the pair picked ---------- */
  await page.check('[name="spot"][value="T12+T13"]', { force: true });
  await page.fill('[data-player] input', people.mia.code.toLowerCase());
  await submit();
  await page.waitForSelector('.cal-done', { timeout: 8000 }).catch(() => {});
  const ticket = await text(page, '.cal-done');
  check(`${tag}: 1 v 1 with Mia's code: the ticket says T12 + T13, 1 v 1, "You against Mia Chen", $10 a person each`,
    /Game table reserved/.test(ticket) && /Table\s*T12 \+ T13/.test(ticket) && /Game\s*1 v 1/.test(ticket) && /Playing\s*You against Mia Chen/.test(ticket) && /\$10 a person\s*Each pays at the counter/.test(ticket), ticket.slice(0, 400));
  const saved = await page.evaluate((occ) => {
    const b = window.Lair.store.backend.state.bookings.filter((x) => x.occurrenceId === occ).pop();
    return b ? { tables: b.tables, people: b.people, amount: b.amount, split: b.split, players: (b.gamePlayers || []).map((p) => [p.role, p.customerId, p.code]) } : null;
  }, id);
  check(`${tag}: the demo booked T12 + T13 for 2 at $20, split, with Mia as the opponent`,
    saved && saved.tables.join() === 'T12,T13' && saved.people === 2 && saved.amount === 2000 && saved.split === true && saved.players.length === 1 && saved.players[0][0] === 'opponent' && saved.players[0][1] === people.mia.id, saved);
  await shot(page, `${tag}-3-ticket`, '.cal-sheet');
  await scan(page, `${tag} the game table ticket`, '.cal-done');
  await page.click('[data-close]').catch(() => {});

  /* ---------- 4. a pair someone else just took; taken pairs show "taken" ---------- */
  await openForm(KAI);
  f = await formLook(page);
  check(`${tag}: Kai's form: Ruby's T12 + T13 shows "taken" and can't be picked`, f.pairs.find((p) => p.v === 'T12+T13').off && /taken/.test(f.pairs.find((p) => p.v === 'T12+T13').text) && f.pairs.find((p) => p.on).v === 'T8+T9', f.pairs);
  // someone else takes T8 + T9 while Kai fills in the form
  await page.evaluate(async (occ) => {
    const be = window.Lair.store.backend;
    const keep = be.cfg.customer;
    be.cfg.customer = null;
    await be.reserveEvent(occ, { name: 'Leo Fontaine', email: 'leo@example.com', phone: '021 555 0199', people: 2, spot: 'T8+T9', players: [{ email: 'friend@example.com' }] });
    be.cfg.customer = keep;
  }, id);
  await page.fill('[data-player] input', people.hemi.code);
  await submit();
  f = await formLook(page);
  check(`${tag}: refused: "T8 + T9 has just been reserved. Pick another pair of tables."; it's marked taken and T10 + T11 is picked`,
    /T8 \+ T9 has just been reserved\. Pick another pair of tables\./.test(f.status) && f.pairs.find((p) => p.v === 'T8+T9').off && /taken/.test(f.pairs.find((p) => p.v === 'T8+T9').text) && f.pairs.find((p) => p.on).v === 'T10+T11', f);
  await page.evaluate(() => document.querySelector('[data-reserve-form] .cal-pairs').scrollIntoView({ block: 'start' }));
  await shot(page, `${tag}-4-taken`);
  // keyboard: arrows skip the taken pairs
  await page.focus('[name="spot"][value="T10+T11"]');
  await page.keyboard.press('ArrowRight');
  k = await page.evaluate(() => document.activeElement.value);
  check(`${tag}: keyboard: the arrow skips the taken T12 + T13`, k === 'T14+T15', k);

  /* ---------- 5. 2 v 2 with two codes and an email ---------- */
  await page.check('[name="people"][value="4"]', { force: true });
  await page.waitForTimeout(150);
  const boxes = page.locator('[data-player] input');
  await boxes.nth(0).fill(people.hemi.code);
  await boxes.nth(1).fill(people.tama.code);
  await boxes.nth(2).fill('jo@example.com');
  await submit();
  await page.waitForSelector('.cal-done', { timeout: 8000 }).catch(() => {});
  const big = await text(page, '.cal-done');
  check(`${tag}: 2 v 2 with Hemi and Tama's codes and Jo's email: "You and Hemi Walker against Tama Rewiti and jo@example.com", 4 players`,
    /Game\s*2 v 2/.test(big) && /Playing\s*You and Hemi Walker against Tama Rewiti and jo@example\.com/.test(big) && /Players\s*4/.test(big) && /Table\s*T14 \+ T15/.test(big), big.slice(0, 400));
  await shot(page, `${tag}-5-ticket-2v2`, '.cal-sheet');
  await page.click('[data-close]').catch(() => {});

  /* ---------- 6. My Lair: the booker, and a named member ---------- */
  await open('/pages/my-lair#bookings', KAI);
  await page.waitForSelector('my-lair .ml-ticket', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const kaiTicket = await page.evaluate((title) => {
    const t = [...document.querySelectorAll('[data-coming] .ml-ticket')].find((x) => x.textContent.includes(title));
    return t ? t.textContent.replace(/\s+/g, ' ').trim() : '';
  }, TITLE);
  check(`${tag}: My Lair (Kai, the booker): 2 v 2, who's playing (the email he typed), each pays their own $10`,
    /Game\s*2 v 2/.test(kaiTicket) && /Playing\s*You and Hemi Walker against Tama Rewiti and jo@example\.com/.test(kaiTicket) && /Each player pays their own \$10 at the counter\./.test(kaiTicket), kaiTicket.slice(0, 400));
  await open('/pages/my-lair#bookings', MIA);
  await page.waitForSelector('my-lair .ml-ticket', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const miaView = await page.evaluate((title) => {
    const t = [...document.querySelectorAll('[data-coming] .ml-ticket')].find((x) => x.textContent.includes(title));
    if (!t) return null;
    return { text: t.textContent.replace(/\s+/g, ' ').trim(), cancel: Boolean(t.querySelector('.ml-cancel, [data-cancel]')), pay: Boolean(t.querySelector('.ml-pay, [data-demo-pay]')), code: (t.querySelector('.ml-ticket__ref') || {}).textContent || '' };
  }, TITLE);
  check(`${tag}: My Lair (Mia): "You’re playing in Ruby’s game", T12, T13, 1 v 1, "Ruby Tane against you"`,
    miaView && /You’re playing in Ruby’s game/.test(miaView.text) && /Tables\s*T12, T13/.test(miaView.text) && /Game\s*1 v 1/.test(miaView.text) && /Playing\s*Ruby Tane against you/.test(miaView.text), miaView);
  check(`${tag}: My Lair (Mia): her own $10 at the counter, her Goblin card is the ticket, nothing to cancel or pay online, no emails`,
    miaView && /Your fee\s*\$10\s*Pay at the counter/.test(miaView.text) && /Pay your own \$10 at the counter/.test(miaView.text) && miaView.code === people.mia.code && !miaView.cancel && !miaView.pay && !/@/.test(miaView.text), miaView);
  const homeRow = await page.evaluate((title) => [...document.querySelectorAll('[data-next] .ml-row, [data-coming] .ml-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()).find((x) => x.includes(title)) || '', TITLE);
  check(`${tag}: My Lair (Mia): Coming up says it's Ruby's game`, /Ruby’s game/.test(homeRow), homeRow);
  await page.locator('[data-coming] .ml-coming__item', { hasText: TITLE }).first().screenshot({ path: `${OUT}/${tag}-6-mylair-mia.png` }).catch(() => {});
  await scan(page, `${tag} My Lair bookings (a named player's game)`, 'my-lair');
  check(`${tag}: no sideways scroll in My Lair`, (await overflowX(page)) <= 0, await overflowX(page));
  await open(`/pages/events-calendar#event=${encodeURIComponent(id)}`, MIA);
  await page.waitForTimeout(800);
  const panel = await text(page, '.cal-you');
  const button = await text(page, '[data-show-mine]');
  check(`${tag}: the calendar (Mia): "You're playing in Ruby's game", T12 + T13, her code, her $10, nothing to cancel`,
    /You’re playing in Ruby’s game/.test(panel) && /Tables T12 \+ T13/.test(panel) && panel.includes(people.mia.code) && /Your \$10: pay at the counter/.test(panel) && !(await page.$('.cal-you [data-cancel-mine]')) && /You’re playing: show my code/.test(button), { panel: panel.slice(0, 300), button });
  await shot(page, `${tag}-6-calendar-mia`, '.cal-sheet');
  await scan(page, `${tag} the calendar's panel for a named player`, '.cal-you');

  /* ---------- 7. the staff page: an opponent's code at check-in ---------- */
  await open('/pages/lair-staff#today', STAFF);
  await page.waitForTimeout(800);
  const stampsOf = (cid) => page.evaluate((x) => {
    const be = window.Lair.store.backend;
    const mem = be.staffMembers().find((p) => String(p.customerId) === String(x));
    const L = be.loyaltyView(mem);
    return L.cards * 10 + L.stamps;
  }, cid);
  const stampsBefore = { tama: await stampsOf(people.tama.id), hemi: await stampsOf(people.hemi.id), kai: await stampsOf(String(KAI.id)) };
  await page.click('[data-tab="floor"]').catch(() => {});
  await page.fill('#checkin-code', people.tama.code);
  await page.press('#checkin-code', 'Enter');
  await page.waitForSelector('.checkin-card--member', { timeout: 8000 }).catch(() => {});
  const card = await page.evaluate(() => {
    const c = document.querySelector('.checkin-card--member');
    if (!c) return null;
    const item = [...c.querySelectorAll('.checkin-item')].find((x) => /Playing/.test(x.textContent));
    return { text: c.textContent.replace(/\s+/g, ' ').trim(), item: item ? item.textContent.replace(/\s+/g, ' ').trim() : '', button: item ? (item.querySelector('[data-checkin-row]') || {}).textContent : '' };
  });
  // what the demo says is due on his card: his own rows (the demo seeds some under his name) plus his $10 share
  const due = await page.evaluate(async (cid) => {
    const r = await window.Lair.store.backend.memberCheckin(cid);
    return { due: r.due, share: (r.rows.find((x) => x.playerOf) || {}).due, own: r.rows.filter((x) => !x.playerOf && !x.guestOf && !x.owed).reduce((s, x) => s + x.due, 0), owed: r.rows.filter((x) => x.owed).reduce((s, x) => s + x.due, 0) };
  }, people.tama.id);
  check(`${tag}: staff check-in, Tama's member code: Kai's game ("Playing", "Kai booked them into this game"), his own $10, on his total`,
    card && /Game table: Warhammer night \(round 11\)/.test(card.item) && /Playing Kai booked them into this game/.test(card.item) && /Their share: \$10 of Kai’s game/.test(card.item) && card.button === 'Check in'
      && due.share === 1000 && due.due === due.own + due.owed + 1000, { card, due });
  await shot(page, `${tag}-7-staff-member-card`, '.checkin-card--member');
  await scan(page, `${tag} staff member card (a named player)`, '[data-checkin-result]');
  await page.locator('.checkin-item', { hasText: 'booked them into this game' }).locator('[data-checkin-row]').click();
  await page.waitForSelector('.checkin-card--ok', { timeout: 8000 }).catch(() => {});
  const done = await text(page, '[data-checkin-result]');
  check(`${tag}: checked in: the card lists the game's players (Hemi, Tama with their codes, jo@example.com invited)`,
    /Checked in/.test(done) && /Playing/.test(done) && /2 v 2/.test(done) && done.includes(people.tama.code) && done.includes(people.hemi.code) && /jo@example\.com/.test(done) && /Invited/.test(done), done.slice(0, 400));
  const seated = await page.evaluate((occ) => window.Lair.store.backend.state.bookings.filter((b) => b.occurrenceId === occ && b.people === 4).map((b) => b.status), id);
  check(`${tag}: the game is checked in`, seated.length === 1 && ['seated', 'checked-in'].includes(seated[0]), seated);
  const stampsAfter = { tama: await stampsOf(people.tama.id), hemi: await stampsOf(people.hemi.id), kai: await stampsOf(String(KAI.id)) };
  check(`${tag}: a loyalty stamp each for Tama and Hemi (members), 2 for Kai (him and the invited player)`,
    stampsAfter.tama === stampsBefore.tama + 1 && stampsAfter.hemi === stampsBefore.hemi + 1 && stampsAfter.kai === stampsBefore.kai + 2, { stampsBefore, stampsAfter });
  await shot(page, `${tag}-7-staff-checked-in`, '[data-checkin-result]');
  check(`${tag}: no script errors`, !errors.length, errors.slice(0, 3));
  await ctx.close();
}
await browser.close();
server.close?.();
console.log(`\n${pass} passed, ${fail} failed${axe ? `, axe violations ${axeTotal}` : ' (axe skipped: set AXE to axe.min.js)'}. Screenshots: ${OUT}`);
process.exit(fail ? 1 : 0);

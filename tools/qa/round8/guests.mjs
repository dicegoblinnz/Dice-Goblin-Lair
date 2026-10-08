// Round 8, guests: friends on event sign-ups, each by member code or by name (contract v8, section 2). Mo (6 Oct): "For
// signing up for events always ask if they intend to get another person and have it as a thing to add another and
// another etc.etc. with either their code and if they don't have one state their name etc."
// Demo mode on the theme mock, phone (390px) then desktop (1280px), each in a fresh browser (a fresh demo):
//   1. the calendar's sign-up form: "Who's coming?", You, "Bringing anyone?", "Add another person" again and again up
//      to 5 more (then it says why it stopped), focus to a new person's first field and back after removing, the count,
//      the places left and the total following, a person with neither a code nor a name, your own code, a code Gobgob
//      doesn't know, a member twice (the app's words), and a sign-up with a member by code and a friend by name
//   2. a date with room for 3: it stops at the places left
//   3. My Lair for both people: "You, Mia Chen and Jo Bloggs"; for Mia "With Ruby", her Goblin card, no pay, no cancel
//      (and the cancel route's 403); the calendar shows Mia "You're in, with Ruby"
//   4. the staff page: Today's sign-ups with the guests (members marked, with their code); Mia's member code at
//      check-in shows the sign-up she's on; "Check in all 3"; a loyalty stamp for Mia (and 2 for Ruby: her and Jo)
//   5. axe (WCAG 2.1 A and AA) on the form, My Lair and the staff page, and a keyboard pass on the form
// Screenshots go to OUT, or a folder in the system's temp directory. Without AXE (axe-core's axe.min.js) the axe part is
// skipped, and says so.
// Usage: DG_THEME=/path/to/theme PORT=4921 [AXE=/path/to/axe.min.js] [OUT=/dir] node tools/qa/round8/guests.mjs [phone|desktop]
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
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round8-guests');
const AXE = process.env.AXE || '';
const axe = AXE && fs.existsSync(AXE) ? fs.readFileSync(AXE, 'utf8') : null;
fs.mkdirSync(OUT, { recursive: true });
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
const ev = await import(new URL('../theme-mock/events-mock.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4921);
const BASE = `http://localhost:${PORT}`;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };

/* ---------- Lair dates, the page clock (today, 1pm) and two sign-up events tonight ---------- */
const TZ = 'Pacific/Auckland';
const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const offset = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${key}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const iso = (key, hm) => `${key}T${hm}:00${offset(key)}`;
const today = lairKey(Date.now());
const AT = Date.parse(iso(today, '13:00'));
const CLOCK = `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;
/** The demo seeds "people already in" each date from a hash of its id (lair-demo.js eventJoins): pick handles it seeds none on */
const seeded = (id, capacity) => {
  let hash = 7;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 11 === 0 ? capacity : hash % Math.min(4, capacity);
};
const handleFor = (base, capacity) => {
  for (let n = 1; n < 200; n += 1) if (!seeded(`${base}-${n}@${today}`, capacity)) return `${base}-${n}`;
  return `${base}-1`;
};
const BIG = handleFor('r8-games-night', 20);
const SMALL = handleFor('r8-paint-night', 3);
ev.extraEvents.push(
  { handle: BIG, title: 'Board game night (round 8)', event_type: 'social', starts_at: iso(today, '19:00'), ends_at: iso(today, '22:00'), capacity: 20, entry_fee: 15, image_slug: 'board-games', game: '', description: 'Games, snacks and friends.' },
  { handle: SMALL, title: 'Paint night (round 8)', event_type: 'learn', starts_at: iso(today, '19:30'), ends_at: iso(today, '21:30'), capacity: 3, image_slug: 'board-games', game: '', description: 'Paint a mini with us.' },
);

const RUBY = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [] };
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const MISSING = 'Add a name or a member code for each person coming, or take them off the list.';
const OWN = 'That’s your own member code, friend. Add the people coming with you.';

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
  const open = async (path, customer) => {
    m.mockState.customer = customer;
    await page.goto('about:blank');
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 60000 });
  };
  await open('/pages/events-calendar', RUBY);
  await page.evaluate(() => localStorage.clear());
  await open('/pages/events-calendar', RUBY);
  await page.waitForSelector('lair-calendar .cal-card', { state: 'attached', timeout: 20000 });
  const ids = await page.evaluate(({ big, small }) => {
    const all = document.querySelector('lair-calendar').all();
    return { big: (all.find((i) => i.handle === big) || {}).id, small: (all.find((i) => i.handle === small) || {}).id };
  }, { big: BIG, small: SMALL });
  const people = await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const list = be.staffMembers();
    const mia = list.find((x) => x.name === 'Mia Chen');
    return { mia: { id: String(mia.customerId), code: mia.code, email: mia.email }, ruby: be.memberView(window.Lair.store.cfg.customer).code };
  });
  check(`${tag}: tonight's two sign-up events are on the calendar`, Boolean(ids.big && ids.small), ids);
  const MIA = { id: Number(people.mia.id), first_name: 'Mia', last_name: 'Chen', name: 'Mia Chen', email: people.mia.email, phone: null, tags: [] };

  /* ---------- 1. the sign-up form ---------- */
  await open(`/pages/events-calendar#event=${encodeURIComponent(ids.big)}`, RUBY);
  await page.waitForTimeout(600);
  await page.click(`[data-join="${ids.big}"]`);
  await page.waitForSelector('[data-join-form] [data-who]');
  const form = await page.evaluate(() => {
    const f = document.querySelector('[data-join-form]');
    const who = f.querySelector('[data-who]');
    return {
      legend: who.querySelector('legend').textContent.trim(), you: who.querySelector('.cal-who__you').textContent.replace(/\s+/g, ' ').trim(),
      ask: who.querySelector('.cal-who__ask').textContent.trim(), add: who.querySelector('[data-guest-add]').textContent.trim(),
      addShown: !who.querySelector('[data-guest-add]').hidden, chips: f.querySelectorAll('[name="people"]').length, count: who.querySelector('[data-who-count]').textContent.trim(),
      total: f.querySelector('[data-total]').textContent.replace(/\s+/g, ' ').trim(), mobileRequired: f.querySelector('[name="phone"]').required,
      left: Number(who.dataset.left), lead: f.querySelector('.cal-form__lead').textContent.replace(/\s+/g, ' ').trim(),
    };
  });
  // the demo seeds a few people into today's dates, so the places left come from the form (and match its lead)
  const LEFT = form.left;
  check(`${tag}: the form knows the places left, as its lead says`, LEFT > 6 && form.lead.includes(`${LEFT} of 20 spaces left`), form);
  check(`${tag}: "Who's coming?" with You (their name), "Bringing anyone?" and "Add another person"; no How many chips`,
    form.legend === 'Who’s coming?' && /^1\s*You · Ruby Tane$/.test(form.you) && form.ask === 'Bringing anyone?' && form.add === 'Add another person' && form.addShown && form.chips === 0, form);
  check(`${tag}: the count, the places left and the total start at you`, form.count === `Just you so far · ${LEFT - 1} spaces left after you` && /\$15 × 1 person\s*\$15/.test(form.total), form);
  check(`${tag}: the Mobile field stays, required`, form.mobileRequired, form);
  await page.fill('[data-join-form] [name="phone"]', '021 555 0199');
  // Add another person, again and again: focus to the new person's code, up to 5, then why it stopped
  const added = [];
  for (let i = 0; i < 5; i += 1) {
    await page.click('[data-guest-add]');
    added.push(await page.evaluate(() => {
      const a = document.activeElement;
      const row = a && a.closest('[data-guest]');
      return { name: a && a.name, title: row && row.querySelector('[data-guest-title]').textContent, rows: document.querySelectorAll('[data-guest]').length };
    }));
  }
  check(`${tag}: each "Add another person" adds a row and focus goes to its Member code`, added.every((a, i) => a.name === 'guestCode' && a.title === `Person ${i + 2}` && a.rows === i + 1), added);
  const stopped = await page.evaluate(() => ({
    add: document.querySelector('[data-guest-add]').hidden, stop: document.querySelector('[data-guest-stop]').textContent.trim(), stopShown: !document.querySelector('[data-guest-stop]').hidden,
    count: document.querySelector('[data-who-count]').textContent.trim(), total: document.querySelector('[data-total]').textContent.replace(/\s+/g, ' ').trim(),
    button: document.querySelector('button[form="cal-join-form"]').textContent.trim(),
  }));
  check(`${tag}: after 5 more it stops and says why`, stopped.add && stopped.stopShown && stopped.stop === 'That’s 6 of you, the most for one sign-up. Got more coming? One of them can sign up the rest.', stopped);
  check(`${tag}: the count, places left and total follow (6 people, $90)`, stopped.count === `6 of you · ${LEFT - 6} spaces left after you` && /\$15 × 6 people\s*\$90/.test(stopped.total) && /Join · \$90 at the counter/.test(stopped.button), stopped);
  await shot(page, `${tag}-form-full`, '.cal-sheet');
  // Remove three: focus goes back to "Add another person" each time
  const removed = [];
  for (let i = 0; i < 3; i += 1) {
    await page.locator('[data-guest-remove]').last().click();
    removed.push(await page.evaluate(() => ({ focus: document.activeElement && document.activeElement.matches('[data-guest-add]'), rows: document.querySelectorAll('[data-guest]').length })));
  }
  check(`${tag}: removing a person takes focus back to "Add another person"`, removed.every((r, i) => r.focus && r.rows === 4 - i), removed);
  const labels = await page.$$eval('[data-guest]', (rows) => rows.map((r) => [r.querySelector('[data-guest-title]').textContent, r.querySelector('[data-guest-remove]').getAttribute('aria-label')]));
  check(`${tag}: the people left are numbered again, each Remove named for its person`, JSON.stringify(labels) === JSON.stringify([['Person 2', 'Remove person 2'], ['Person 3', 'Remove person 3']]), labels);
  // A person with neither: stopped here, with the app's words, on that person
  const before = await page.evaluate(() => (window.Lair.store.backend.state.joins || []).length);
  await page.click('button[form="cal-join-form"]');
  await page.waitForTimeout(300);
  const empty = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-guest]')];
    const a = document.activeElement;
    return { errors: rows.map((r) => (r.querySelector('.field__error') || {}).textContent || ''), focus: a && a.name, inFirst: Boolean(a && a.closest('[data-guest]') === rows[0]), invalid: rows[0].querySelector('[name="guestCode"]').getAttribute('aria-invalid') };
  });
  check(`${tag}: a person with neither a code nor a name: the app's words on them, focus there, nothing sent`, empty.errors.every((e) => e === MISSING) && empty.focus === 'guestCode' && empty.inFirst && empty.invalid === 'true'
    && (await page.evaluate(() => (window.Lair.store.backend.state.joins || []).length)) === before, empty);
  await shot(page, `${tag}-form-missing`, '.cal-sheet');
  // Their own code
  const rowCode = (i) => page.locator('[data-guest] [name="guestCode"]').nth(i);
  const rowName = (i) => page.locator('[data-guest] [name="guestName"]').nth(i);
  await rowCode(0).fill(people.ruby);
  await rowName(1).fill('Jo Bloggs');
  await page.click('button[form="cal-join-form"]');
  await page.waitForTimeout(300);
  const own = await page.evaluate(() => ({ error: (document.querySelector('[data-guest] .field__error') || {}).textContent || '', focus: document.activeElement && document.activeElement.name }));
  check(`${tag}: your own member code: "That's your own member code, friend…" on that person`, own.error === OWN && own.focus === 'guestCode', own);
  // A code Gobgob doesn't know: the app's words by the form, and on that person
  await rowCode(0).fill('zz-nope-1');
  await page.click('button[form="cal-join-form"]');
  await page.waitForSelector('.cal-error', { timeout: 5000 }).catch(() => {});
  const unknown = await page.evaluate(() => ({ status: (document.querySelector('.cal-error') || {}).textContent || '', row: (document.querySelector('[data-guest] .field__error') || {}).textContent || '', focus: document.activeElement && document.activeElement.value }));
  check(`${tag}: a code Gobgob doesn't know: the app's words by the form and on that person`, flat(unknown.status) === "Gobgob doesn't know the member code ZZ-NOPE-1. Check it, or put their name instead." && flat(unknown.row) === flat(unknown.status) && unknown.focus === 'zz-nope-1', unknown);
  await shot(page, `${tag}-form-unknown-code`, '.cal-sheet');
  // A member twice (her code, typed two ways)
  await rowCode(0).fill(people.mia.code.toLowerCase().replace(/-/g, ''));
  await rowCode(1).fill(people.mia.code.replace(/-/g, ' '));
  await page.click('button[form="cal-join-form"]');
  await page.waitForTimeout(500);
  const twice = flat(await text(page, '.cal-error'));
  check(`${tag}: the same member twice: "Mia Chen is on the list twice."`, twice === 'Mia Chen is on the list twice.', twice);
  // Mia by her code (any case, no dashes), Jo by name: in
  await rowCode(1).fill('');
  const ready = await page.evaluate(() => ({ count: document.querySelector('[data-who-count]').textContent.trim(), total: document.querySelector('[data-total]').textContent.replace(/\s+/g, ' ').trim() }));
  check(`${tag}: 3 of you, $45`, ready.count === `3 of you · ${LEFT - 3} spaces left after you` && /\$15 × 3 people\s*\$45/.test(ready.total), ready);
  await shot(page, `${tag}-form-ready`, '.cal-sheet');
  if (axe) await scan(page, `${tag} the sign-up form with two people`, '.cal-sheet');
  await page.click('button[form="cal-join-form"]');
  await page.waitForSelector('.cal-done', { timeout: 8000 }).catch(() => {});
  const ticket = await text(page, '.cal-done');
  check(`${tag}: the ticket: 3 people, "You, Mia Chen and Jo Bloggs", $45 at the counter`, /People\s*3/.test(ticket) && /Coming\s*You, Mia Chen and Jo Bloggs/.test(ticket) && /\$45/.test(ticket), ticket.slice(0, 300));
  const saved = await page.evaluate(() => { const js = window.Lair.store.backend.state.joins || []; return js[js.length - 1]; });
  check(`${tag}: the demo kept Mia as a member (her account and code) and Jo by name; 3 people, $45`, saved && saved.people === 3 && saved.amount === 4500 && saved.guests.length === 2
    && saved.guests[0].customerId === people.mia.id && saved.guests[0].name === 'Mia Chen' && saved.guests[0].code === people.mia.code && saved.guests[1].customerId === null && saved.guests[1].name === 'Jo Bloggs', saved);
  await shot(page, `${tag}-ticket`, '.cal-sheet');
  check(`${tag}: no sideways scroll on the calendar`, (await overflowX(page)) <= 0, await overflowX(page));

  /* ---------- 2. a date with room for 3 ---------- */
  await open(`/pages/events-calendar#event=${encodeURIComponent(ids.small)}`, RUBY);
  await page.waitForTimeout(600);
  await page.click(`[data-join="${ids.small}"]`);
  await page.waitForSelector('[data-join-form] [data-who]');
  await page.click('[data-guest-add]');
  await page.click('[data-guest-add]');
  const small = await page.evaluate(() => ({ rows: document.querySelectorAll('[data-guest]').length, add: document.querySelector('[data-guest-add]').hidden, stop: document.querySelector('[data-guest-stop]').textContent.trim(), count: document.querySelector('[data-who-count]').textContent.trim() }));
  check(`${tag}: a date with room for 3 stops at 2 more, and says so`, small.rows === 2 && small.add && small.stop === 'That’s everyone this date has room for.' && small.count === '3 of you · that’s the last space', small);
  await shot(page, `${tag}-form-places`, '.cal-sheet');
  // keyboard: from Mobile, Tab reaches "Add another person"; Enter adds a person with focus in their code; Shift+Tab is
  // their Remove; Enter on it takes them off and focus goes back to "Add another person", with a visible ring
  await page.locator('[data-guest-remove]').last().click();
  await page.locator('[data-guest-remove]').last().click();
  await page.focus('[data-join-form] [name="phone"]');
  const stops = [];
  for (let i = 0; i < 3 && stops[stops.length - 1] !== 'add'; i += 1) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => document.activeElement.matches('[data-guest-add]') ? 'add' : document.activeElement.name || document.activeElement.tagName));
  }
  const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 ? 'outline' : s.boxShadow !== 'none' ? 'shadow' : ''; });
  await page.keyboard.press('Enter');
  const kbAdd = await page.evaluate(() => ({ name: document.activeElement.name, rows: document.querySelectorAll('[data-guest]').length }));
  await page.keyboard.press('Shift+Tab');
  const onRemove = await page.evaluate(() => document.activeElement.matches('[data-guest-remove]'));
  const removeRing = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0; });
  await page.keyboard.press('Enter');
  const kbRemove = await page.evaluate(() => ({ add: document.activeElement.matches('[data-guest-add]'), rows: document.querySelectorAll('[data-guest]').length }));
  check(`${tag}: keyboard: Tab from Mobile reaches "Add another person" (with a ring); Enter adds a person, focus in their code`, stops.join() === 'add' && Boolean(ring) && kbAdd.name === 'guestCode' && kbAdd.rows === 1, { stops, ring, kbAdd });
  check(`${tag}: keyboard: Shift+Tab is their Remove (ringed); Enter takes them off, focus back on "Add another person"`, onRemove && removeRing && kbRemove.add && kbRemove.rows === 0, { onRemove, removeRing, kbRemove });
  const targets = await page.evaluate(() => {
    document.querySelector('[data-guest-add]').click();
    const els = [...document.querySelectorAll('[data-guest-add], [data-guest-remove], [data-guest] input')].filter((el) => el.offsetParent);
    return els.map((el) => { const r = el.getBoundingClientRect(); return [el.matches('input') ? el.name : el.textContent.trim(), Math.round(r.width), Math.round(r.height)]; });
  });
  check(`${tag}: 44px targets (Add, Remove, the fields)`, targets.length >= 3 && targets.every(([, w, h]) => w >= 44 && h >= 44), targets);
  check(`${tag}: no sideways scroll with a person on the form`, (await overflowX(page)) <= 0, await overflowX(page));

  /* ---------- 3. My Lair, for both people ---------- */
  await open('/pages/my-lair#bookings', RUBY);
  await page.waitForSelector('my-lair .ml-ticket', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const rubyTicket = await page.evaluate((title) => {
    const t = [...document.querySelectorAll('[data-coming] .ml-ticket')].find((x) => x.textContent.includes(title));
    return t ? t.textContent.replace(/\s+/g, ' ').trim() : '';
  }, 'Board game night (round 8)');
  check(`${tag}: My Lair (Ruby): her sign-up says who's coming: "You, Mia Chen and Jo Bloggs"`, /People\s*3/.test(rubyTicket) && /Coming\s*You, Mia Chen and Jo Bloggs/.test(rubyTicket) && /\$45/.test(rubyTicket), rubyTicket.slice(0, 300));
  await page.locator('[data-coming] .ml-coming__item', { hasText: 'Board game night (round 8)' }).first().screenshot({ path: `${OUT}/${tag}-mylair-ruby.png` }).catch(() => {});
  await open('/pages/my-lair#bookings', MIA);
  await page.waitForSelector('my-lair .ml-ticket', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const miaView = await page.evaluate((title) => {
    const t = [...document.querySelectorAll('[data-coming] .ml-ticket')].find((x) => x.textContent.includes(title));
    if (!t) return null;
    return {
      text: t.textContent.replace(/\s+/g, ' ').trim(), pay: Boolean(t.querySelector('.ml-pay, [data-demo-pay]')), cancel: Boolean(t.querySelector('.ml-cancel, [data-cancel]')),
      code: (t.querySelector('.ml-ticket__ref') || {}).textContent || '',
    };
  }, 'Board game night (round 8)');
  check(`${tag}: My Lair (Mia): "With Ruby", 3 people, no money`, miaView && /With Ruby/.test(miaView.text) && /People\s*3/.test(miaView.text) && !/\$/.test(miaView.text), miaView);
  check(`${tag}: My Lair (Mia): no pay and no cancel; her Goblin card is the ticket`, miaView && !miaView.pay && !miaView.cancel && miaView.code === people.mia.code && /Only Ruby can change this sign-up/.test(miaView.text), miaView);
  const homeRow = await page.evaluate(() => [...document.querySelectorAll('[data-next] .ml-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()).find((x) => /round 8/.test(x)) || '');
  check(`${tag}: My Lair (Mia): Home's "Coming up" says "With Ruby"`, /With Ruby/.test(homeRow), homeRow);
  const cancel = await page.evaluate(async (id) => { try { await window.Lair.store.backend.cancelJoin(id); return 'cancelled'; } catch (e) { return `${e.status} ${e.message}`; } }, saved && saved.id);
  check(`${tag}: Mia can't cancel it: 403 "Only the person who signed up can change this. Ask them, or the counter."`, cancel === '403 Only the person who signed up can change this. Ask them, or the counter.', cancel);
  await page.locator('[data-coming] .ml-coming__item', { hasText: 'Board game night (round 8)' }).first().screenshot({ path: `${OUT}/${tag}-mylair-mia.png` }).catch(() => {});
  if (axe) await scan(page, `${tag} My Lair bookings (a guest's sign-up)`, 'my-lair');
  await open(`/pages/events-calendar#event=${encodeURIComponent(ids.big)}`, MIA);
  await page.waitForTimeout(800);
  const panel = await text(page, '.cal-you');
  const panelCancel = await page.$('.cal-you [data-cancel-mine]');
  check(`${tag}: the calendar (Mia): "You're in, with Ruby", her code, nothing to cancel`, /You’re in, with Ruby/.test(panel) && panel.includes(people.mia.code) && /Only Ruby can change this sign-up/.test(panel) && !panelCancel, panel.slice(0, 240));
  await shot(page, `${tag}-calendar-mia`, '.cal-sheet');

  /* ---------- 4. the staff page ---------- */
  const stampsOf = (id) => page.evaluate((cid) => {
    const be = window.Lair.store.backend;
    const mem = be.staffMembers().find((x) => String(x.customerId) === String(cid));
    const L = be.loyaltyView(mem);
    return L.cards * 10 + L.stamps;
  }, id);
  await open('/pages/lair-staff#today', STAFF);
  await page.waitForSelector('[data-joins] .staff-join', { timeout: 15000 }).catch(() => {});
  const listed = await page.evaluate((title) => {
    const sec = [...document.querySelectorAll('[data-joins] .staff-join')].find((s) => s.textContent.includes(title));
    const item = sec && [...sec.querySelectorAll('.staff-join__item')].find((li) => /Ruby/.test(li.textContent));
    return item ? { text: item.textContent.replace(/\s+/g, ' ').trim(), pills: [...item.querySelectorAll('.staff-guests__item')].map((p) => p.textContent.replace(/\s+/g, ' ').trim()) } : null;
  }, 'Board game night (round 8)');
  check(`${tag}: staff, Today's sign-ups: the guests under Ruby's sign-up, Mia marked a member with her code, Jo by name`,
    listed && listed.pills.length === 2 && listed.pills[0] === `Mia Chen Member ${people.mia.code}` && listed.pills[1] === 'Jo Bloggs', listed);
  await page.fill('[data-find]', 'jo bloggs');
  await page.waitForTimeout(200);
  check(`${tag}: staff can find the sign-up by a guest's name`, /Ruby/.test(await text(page, '[data-joins]')), await text(page, '[data-joins]'));
  await page.fill('[data-find]', '');
  await shot(page, `${tag}-staff-today`, '[data-joins]');
  if (axe) await scan(page, `${tag} staff Today's sign-ups with guests`, '[data-panel="today"]');
  const miaBefore = await stampsOf(people.mia.id);
  const rubyBefore = await stampsOf(String(RUBY.id));
  await page.click('[data-tab="floor"]').catch(() => {});
  await page.fill('#checkin-code', people.mia.code);
  await page.press('#checkin-code', 'Enter');
  await page.waitForSelector('.checkin-card--member', { timeout: 8000 }).catch(() => {});
  const card = await page.evaluate(() => {
    const c = document.querySelector('.checkin-card--member');
    if (!c) return null;
    const along = c.querySelector('.checkin-item--along');
    return { text: c.textContent.replace(/\s+/g, ' ').trim(), along: along ? along.textContent.replace(/\s+/g, ' ').trim() : '', button: along ? (along.querySelector('[data-checkin-row]') || {}).textContent : '' };
  });
  check(`${tag}: staff check-in, Mia's member code: the sign-up she's on, "Ruby signed them up", "Check in all 3", not on her total`,
    card && /Guest Ruby signed them up/.test(card.along) && /Mia Chen/.test(card.along) && card.button === 'Check in all 3' && !/To pay today/.test(card.text), card);
  await shot(page, `${tag}-staff-member-card`, '.checkin-card--member');
  if (axe) await scan(page, `${tag} staff member card (a guest)`, '[data-checkin-result]');
  await page.click('.checkin-item--along [data-checkin-row]');
  await page.waitForSelector('.checkin-card--ok', { timeout: 8000 }).catch(() => {});
  const done = await text(page, '[data-checkin-result]');
  check(`${tag}: checked in, the card lists who's coming with Ruby`, /Checked in/.test(done) && /Coming with Ruby/.test(done) && done.includes(people.mia.code) && /Jo Bloggs/.test(done), done.slice(0, 300));
  await shot(page, `${tag}-staff-checked-in`, '[data-checkin-result]');
  const miaAfter = await stampsOf(people.mia.id);
  const rubyAfter = await stampsOf(String(RUBY.id));
  check(`${tag}: a loyalty stamp for Mia (her own), 2 for Ruby (her and Jo)`, miaAfter === miaBefore + 1 && rubyAfter === rubyBefore + 2, { miaBefore, miaAfter, rubyBefore, rubyAfter });
  check(`${tag}: no script errors`, !errors.length, errors.slice(0, 3));
  await ctx.close();
}
await browser.close();
server.close();
if (!axe) console.log(`(axe skipped: ${AXE ? `${AXE} not found` : 'set AXE to axe-core\'s axe.min.js'})`);
console.log(`guests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

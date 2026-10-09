// Round 11, reminders (contract v11-reminders): "Remind me the day before" on an event date's "I'm coming" or "Maybe",
// and "Join the waitlist" on a full date. Mo (9 Oct 2026): "have a add to calendar option on it and possibly a reminder
// the day prior if they opt for it?" and "if we went more let it notify us so we cns try to organize a new group".
// Demo mode on the theme mock, phone (390px) then desktop (1280px), each in a fresh browser (a fresh demo):
//   1. a guest's "I'm coming": the form's "Remind me the day before" box (unticked), ticked and sent; the sheet shows the
//      toggle pressed beside "You're coming", and it turns off and on in one tap (focus stays, the change is announced)
//   2. a member's one-tap "Maybe", then the toggle, by keyboard; the day list shows it beside "You're a maybe"
//   3. a full date: "Full · n waiting" on the card and in the sheet, "Join the waitlist" in the sheet and the day list;
//      the form's checks, a guest joining for 2, the count going up, "You're on the waitlist" and taking it back; a
//      member joining (their name from the account)
//   4. staff see each waitlist place on Today's bookings: name, people, email, mobile and note
//   5. My Lair: "Coming, maybe and waitlists" with the toggle and Take it back
//   6. axe (WCAG 2.1 A and AA) on each form and list, no sideways scroll, no console errors
// Usage: DG_THEME=/path/to/theme PORT=4942 [AXE=/path/to/axe.min.js] [OUT=/dir] node tools/qa/round11/reminders.mjs [phone|desktop]
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
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round11-reminders');
const AXE = process.env.AXE || '';
const axe = AXE && fs.existsSync(AXE) ? fs.readFileSync(AXE, 'utf8') : null;
fs.mkdirSync(OUT, { recursive: true });
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || process.env.QA_PORT || 4942);
const BASE = `http://localhost:${PORT}`;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };

/* ---------- the page clock: today, 1pm in Auckland ---------- */
const TZ = 'Pacific/Auckland';
const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const offset = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${key}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const iso = (key, hm) => `${key}T${hm}:00${offset(key)}`;
const today = lairKey(Date.now());
const AT = Date.parse(iso(today, '13:00'));
const CLOCK = `(() => { const OFFSET = ${AT} - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;
const DEMO = 'dg-lair-demo-v3';

const RUBY = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [] };
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  return ok;
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function scan(page, label, selector) {
  if (!axe) {
    console.log(`SKIP axe: ${label} (set AXE to axe.min.js)`);
    return;
  }
  await page.addScriptTag({ content: axe });
  const found = await page.evaluate(async (sel) => {
    const nodes = [...document.querySelectorAll(sel)].filter((n) => n.offsetParent || n.matches('dialog[open]'));
    const out = [];
    for (const node of nodes) {
      const r = await window.axe.run(node, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
      out.push(...r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`));
    }
    return { out, nodes: nodes.length };
  }, selector);
  check(`axe: ${label}: no WCAG 2.1 A/AA violations`, found.nodes > 0 && !found.out.length, found.nodes ? found.out.join(' / ') : 'nothing to scan');
}
const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false }).catch(() => {});
};
const demoRows = (page) => page.evaluate((key) => (JSON.parse(localStorage.getItem(key) || '{}').interests || []), DEMO);

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
  const open = async (where, customer = null) => {
    m.mockState.customer = customer;
    await page.goto('about:blank');
    await page.goto(`${BASE}${where}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(400);
  };
  const openEvent = async (id, customer = null) => {
    await open(`/pages/events-calendar#event=${encodeURIComponent(id)}`, customer);
    await page.waitForSelector('lair-calendar [data-dialog][open]', { timeout: 20000 });
    await page.waitForTimeout(300);
  };
  const sheet = () => page.evaluate(() => {
    const d = document.querySelector('lair-calendar [data-dialog]');
    const toggle = d.querySelector('[data-interest-remind]');
    return {
      open: d.open, title: d.querySelector('[data-dialog-title]')?.textContent.trim(), foot: (d.querySelector('[data-dialog-foot]')?.textContent || '').replace(/\s+/g, ' ').trim(),
      facts: (d.querySelector('.cal-facts')?.textContent || '').replace(/\s+/g, ' ').trim(), flash: d.querySelector('.cal-flash')?.textContent.trim() || '',
      toggle: toggle ? toggle.getAttribute('aria-pressed') : null, toggleText: toggle ? toggle.textContent.trim() : null, focus: document.activeElement?.getAttribute('data-interest-remind') || document.activeElement?.name || null, active: `${document.activeElement?.tagName} ${document.activeElement?.className}`,
      waitlist: Boolean(d.querySelector('[data-waitlist]')), said: d.querySelector('.cal-note--said')?.textContent.replace(/\s+/g, ' ').trim() || '',
    };
  });

  /* ---------- find the dates: one with no sign-ups from tomorrow on, and one that takes sign-ups ---------- */
  await open('/pages/events-calendar');
  await page.evaluate(() => localStorage.clear());
  await open('/pages/events-calendar');
  await page.waitForFunction(() => window.Lair?.store?.data?.events?.length > 0, null, { timeout: 20000 });
  const dates = await page.evaluate(() => {
    const t = window.Lair.store.time;
    const tomorrow = t.addDays(t.today(), 1);
    const events = window.Lair.store.data.events.filter((e) => e.startMs > Date.now()).sort((a, b) => a.startMs - b.startMs);
    const open = events.find((e) => !e.capacity && !e.gameTables && !(e.product && e.product.url) && t.key(e.startMs) >= tomorrow);
    const signUp = events.find((e) => Number(e.capacity) > 0 && !e.gameTables && !(e.product && e.product.url) && t.key(e.startMs) >= tomorrow);
    return { open: open && { id: open.id, title: open.title }, signUp: signUp && { id: signUp.id, title: signUp.title, capacity: Number(signUp.capacity) } };
  });
  if (!check(`${tag}: the demo has a date with no sign-ups and one with sign-ups, from tomorrow on`, dates.open && dates.signUp, dates)) continue;

  /* ---------- 1. a guest's "I'm coming" with "Remind me the day before" ---------- */
  await openEvent(dates.open.id);
  await page.click('lair-calendar [data-dialog] [data-interest][data-level="coming"]');
  await page.waitForSelector('lair-calendar [data-interest-form]', { timeout: 8000 });
  const form1 = await page.evaluate(() => {
    const f = document.querySelector('lair-calendar [data-interest-form]');
    const box = f.querySelector('[name="remind"]');
    return { fields: [...f.elements].map((x) => x.name).filter(Boolean), box: box ? { checked: box.checked, label: box.closest('label')?.textContent.replace(/\s+/g, ' ').trim() } : null };
  });
  check(`${tag}: the guest form asks name, email, mobile, a note, and "Remind me the day before" (unticked)`, form1.fields.join() === 'name,email,phone,note,remind' && form1.box && !form1.box.checked && form1.box.label === "Remind me the day before One email from Gobgob the day before, from 9am, with Add to calendar.", form1);
  await page.fill('lair-calendar [data-interest-form] [name="name"]', 'Kiri Example');
  await page.fill('lair-calendar [data-interest-form] [name="email"]', 'kiri@example.com');
  await page.fill('lair-calendar [data-interest-form] [name="phone"]', '021 555 0103');
  await page.check('lair-calendar [data-interest-form] [name="remind"]');
  await scan(page, `${tag}: the guest form with the reminder box`, 'lair-calendar [data-dialog][open]');
  await shot(page, `${tag}-1-guest-form`);
  await page.click('lair-calendar [data-interest-send]');
  await page.waitForSelector('lair-calendar [data-dialog] .cal-flash', { timeout: 8000 });
  await page.waitForTimeout(300);
  let s = await sheet();
  let row = (await demoRows(page)).find((r) => r.targetId === dates.open.id && r.status === 'active');
  check(`${tag}: sent: "You're coming." with the reminder toggle pressed and Take it back; the row wants a reminder`, /You’re coming\./.test(s.said) && s.toggle === 'true' && s.toggleText === 'Remind me the day before' && /Take it back/.test(s.foot) && row && row.remind === true && row.level === 'coming', { s, row });
  await shot(page, `${tag}-1-guest-said`);
  // one tap turns it off, focus stays on it, and it's announced
  await page.click('lair-calendar [data-interest-remind]');
  await page.waitForFunction(() => document.querySelector('lair-calendar [data-interest-remind]')?.getAttribute('aria-pressed') === 'false', null, { timeout: 8000 });
  await page.waitForTimeout(250);
  s = await sheet();
  row = (await demoRows(page)).find((r) => r.targetId === dates.open.id && r.status === 'active');
  const said1 = await page.evaluate(() => document.getElementById('interest-say')?.textContent || '');
  check(`${tag}: one tap turns the reminder off (the guest's key, no form), focus stays on the toggle, and it's announced`, s.toggle === 'false' && row.remind === false && s.focus === dates.open.id && said1 === 'Reminder off.', { s, said1, remind: row.remind });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('lair-calendar [data-interest-remind]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 8000 });
  await page.waitForTimeout(250);
  const said1b = await page.evaluate(() => document.getElementById('interest-say')?.textContent || '');
  check(`${tag}: Enter on the focused toggle turns it back on: "Reminder on. Gobgob will email you the day before."`, said1b === 'Reminder on. Gobgob will email you the day before.', said1b);

  /* ---------- 2. a member's one-tap Maybe, then the toggle by keyboard; the day list ---------- */
  // another person on this browser: the guest's key stays with the guest
  await page.evaluate(() => localStorage.removeItem('dg-lair-interests'));
  await openEvent(dates.open.id, RUBY);
  await page.click('lair-calendar [data-dialog] [data-interest][data-level="maybe"]');
  await page.waitForSelector('lair-calendar [data-dialog] [data-interest-remind]', { timeout: 8000 });
  s = await sheet();
  check(`${tag}: a member's Maybe is one tap, and the sheet offers "Remind me the day before" (not pressed)`, /You’re a maybe\./.test(s.said) && s.toggle === 'false', s);
  await page.focus('lair-calendar [data-interest-remind]');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('lair-calendar [data-interest-remind]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 8000 });
  row = (await demoRows(page)).find((r) => r.targetId === dates.open.id && r.status === 'active' && r.customerId === String(RUBY.id));
  check(`${tag}: Space on the toggle turns the member's reminder on`, row && row.remind === true && row.level === 'maybe', row);
  await scan(page, `${tag}: the sheet with the toggle`, 'lair-calendar [data-dialog][open]');
  await shot(page, `${tag}-2-member-toggle`);
  // the day list (the booking page's Events tab) shows it beside "You're a maybe"
  await page.keyboard.press('Escape');
  const day = await page.evaluate((id) => window.Lair.store.time.key(window.Lair.store.data.events.find((e) => e.id === id).startMs), dates.open.id);
  await page.evaluate((key) => document.querySelector('lair-play')?.selectDay?.(key), day);
  await page.waitForTimeout(400);
  const listed = await page.evaluate((id) => {
    const item = document.querySelector(`.play-item [data-play-target="${CSS.escape(id)}"]`)?.closest('.play-item');
    return item ? { said: item.querySelector('.play-item__said')?.textContent.trim(), toggle: item.querySelector('[data-interest-remind]')?.getAttribute('aria-pressed') || null } : null;
  }, dates.open.id);
  check(`${tag}: the day's list shows "You're a maybe" with the toggle pressed`, listed && listed.said === 'You’re a maybe' && listed.toggle === 'true', listed);
  if (listed) await shot(page, `${tag}-2-day-list`);

  /* ---------- 3. a full date: "Full · n waiting" and the waitlist ---------- */
  // a date with sign-ups the demo member isn't on (the demo gave them sign-ups when they first logged in)
  const other = await page.evaluate(({ key, member }) => {
    const t = window.Lair.store.time;
    const tomorrow = t.addDays(t.today(), 1);
    const theirs = new Set((JSON.parse(localStorage.getItem(key) || '{}').joins || []).filter((j) => String(j.customerId || '') === member).map((j) => j.occurrenceId));
    const e = window.Lair.store.data.events.filter((x) => x.startMs > Date.now()).sort((a, b) => a.startMs - b.startMs)
      .find((x) => Number(x.capacity) > 0 && !x.gameTables && !(x.product && x.product.url) && t.key(x.startMs) >= tomorrow && !theirs.has(x.id));
    return e ? { id: e.id, title: e.title, capacity: Number(e.capacity) } : null;
  }, { key: DEMO, member: String(RUBY.id) });
  if (other) dates.signUp = other;
  // fill the date (the demo's sign-ups), so the sign-up form would say it's full
  await page.evaluate(({ key, id, capacity }) => {
    const state = JSON.parse(localStorage.getItem(key) || '{}');
    state.eventJoins = { ...(state.eventJoins || {}), [id]: capacity };
    localStorage.setItem(key, JSON.stringify(state));
  }, { key: DEMO, id: dates.signUp.id, capacity: dates.signUp.capacity });
  await openEvent(dates.signUp.id);
  s = await sheet();
  const waitingBefore = Number((s.facts.match(/Full · (\d+) waiting/) || [])[1] || 0);
  check(`${tag}: a full date's sheet says "Full · n waiting" and offers "Join the waitlist"`, /This date is full\. Join the waitlist and the team will be in touch if a place opens up\./.test(s.foot) && s.waitlist && waitingBefore > 0, s);
  await page.click('lair-calendar [data-dialog] [data-waitlist]');
  await page.waitForSelector('lair-calendar [data-waitlist-form]', { timeout: 8000 });
  const form3 = await page.evaluate(() => {
    const f = document.querySelector('lair-calendar [data-waitlist-form]');
    return { title: document.querySelector('lair-calendar [data-dialog-title]').textContent, fields: [...f.elements].map((x) => x.name).filter(Boolean), lead: f.querySelector('.interest-form__lead').textContent.trim(), send: document.querySelector('lair-calendar [data-interest-send]')?.textContent.trim(), focus: document.activeElement?.name || null, people: [...f.querySelectorAll('[name="people"] option')].map((o) => o.value).join() };
  });
  check(`${tag}: the waitlist form: name, email, mobile, how many (1 to 6) and a note; nothing booked or paid`, /^Waitlist: /.test(form3.title) && form3.fields.join() === 'name,email,phone,people,note' && form3.people === '1,2,3,4,5,6' && form3.focus === 'name' && /Nothing is booked and there’s nothing to pay\./.test(form3.lead) && form3.send === 'Join the waitlist', form3);
  await page.click('lair-calendar [data-interest-send]');
  const problems3 = await page.evaluate(() => [...document.querySelectorAll('lair-calendar [data-waitlist-form] [data-field-error]:not([hidden])')].map((e) => e.textContent.trim()));
  check(`${tag}: sent empty, it says what's missing, in the Lair app's words`, problems3.join('|') === 'Add your name.|Add your email so we can get back to you.|Add a mobile number so we can reach you on the day.', problems3);
  await page.fill('lair-calendar [data-waitlist-form] [name="name"]', 'Tama Example');
  await page.fill('lair-calendar [data-waitlist-form] [name="email"]', 'tama@example.com');
  await page.fill('lair-calendar [data-waitlist-form] [name="phone"]', '021 555 0104');
  await page.selectOption('lair-calendar [data-waitlist-form] [name="people"]', '2');
  await page.fill('lair-calendar [data-waitlist-form] [name="note"]', 'Happy to start a second group.');
  await scan(page, `${tag}: the waitlist form`, 'lair-calendar [data-dialog][open]');
  await shot(page, `${tag}-3-waitlist-form`);
  await page.click('lair-calendar [data-interest-send]');
  await page.waitForSelector('lair-calendar [data-dialog] .cal-flash', { timeout: 8000 });
  await page.waitForTimeout(300);
  s = await sheet();
  row = (await demoRows(page)).find((r) => r.targetId === dates.signUp.id && r.status === 'active');
  const waitingAfter = Number((s.facts.match(/Full · (\d+) waiting/) || [])[1] || 0);
  check(`${tag}: joined: the thanks says nothing is booked or paid, the sheet says "You're on the waitlist for 2.", and n waiting goes up by 2`, /You’re on the waitlist\. Nothing is booked or paid/.test(s.flash) && /You’re on the waitlist for 2\./.test(s.said) && /Take me off the waitlist/.test(s.foot) && !s.waitlist && waitingAfter === waitingBefore + 2 && row && row.level === 'waitlist' && row.people === 2, { s, waitingBefore, waitingAfter, row });
  await shot(page, `${tag}-3-waitlist-joined`);
  const card = await page.evaluate((id) => [...document.querySelectorAll('lair-calendar .cal-card')].find((c) => c.dataset.item === id)?.querySelector('.cal-card__spaces')?.textContent.trim() || null, dates.signUp.id);
  check(`${tag}: the card says "Full · n waiting" (a count, never names)`, card === null || (card === `Full · ${waitingAfter} waiting`), card);
  await page.click('lair-calendar [data-dialog] [data-interest-back]');
  await page.waitForSelector('lair-calendar [data-dialog] [data-waitlist]', { timeout: 8000 });
  s = await sheet();
  check(`${tag}: Take me off the waitlist: it's gone, the count is back, and Join the waitlist is offered again`, Number((s.facts.match(/Full · (\d+) waiting/) || [])[1] || 0) === waitingBefore && s.waitlist, s);
  // a member: the name comes from their account, the mobile field is theirs to fill
  await openEvent(dates.signUp.id, RUBY);
  await page.click('lair-calendar [data-dialog] [data-waitlist]');
  await page.waitForSelector('lair-calendar [data-waitlist-form]', { timeout: 8000 });
  const member3 = await page.evaluate(() => ({ who: document.querySelector('lair-calendar [data-waitlist-form] .interest-form__who')?.textContent.trim(), fields: [...document.querySelector('lair-calendar [data-waitlist-form]').elements].map((x) => x.name).filter(Boolean) }));
  check(`${tag}: a member's waitlist form says "As Ruby Tane." and asks only the mobile, how many and a note`, member3.who === 'As Ruby Tane.' && member3.fields.join() === 'phone,people,note', member3);
  await page.fill('lair-calendar [data-waitlist-form] [name="phone"]', '021 555 0106');
  await page.click('lair-calendar [data-interest-send]');
  await page.waitForSelector('lair-calendar [data-dialog] .cal-flash', { timeout: 8000 });
  row = (await demoRows(page)).find((r) => r.targetId === dates.signUp.id && r.status === 'active' && r.customerId === String(RUBY.id));
  check(`${tag}: the member is on the waitlist for 1`, row && row.level === 'waitlist' && row.people === 1 && row.phone === '021 555 0106', row);
  // and a guest (logged out) for 3, for staff to see
  await page.evaluate(() => localStorage.removeItem('dg-lair-interests'));
  await open('/pages/events-calendar', null);
  await page.waitForFunction(() => Boolean(window.LairInterest && window.Lair?.store?.data?.events?.length), null, { timeout: 20000 });
  const tui = await page.evaluate(async (id) => window.LairInterest.sendInput({ waitlist: true, kind: 'event', id, people: 3, name: 'Tui Example', email: 'tui@example.com', phone: '021 555 0107', note: 'Three of us, any time.' }).then((r) => r.interest).catch((e) => ({ error: e.message })), dates.signUp.id);
  check(`${tag}: a guest joins the same waitlist for 3 (a row of their own)`, tui && tui.level === 'waitlist' && tui.people === 3 && tui.key, tui);

  /* ---------- 4. staff see the waitlist with names, emails, mobiles and notes ---------- */
  await open('/pages/lair-staff#today', STAFF);
  await page.waitForSelector('lair-staff [data-joins]', { timeout: 20000 });
  await page.waitForTimeout(600);
  const staff = await page.evaluate(() => {
    const box = [...document.querySelectorAll('lair-staff .staff-waitlist')];
    return { head: [...document.querySelectorAll('lair-staff .staff-joins__h')].map((h) => h.textContent.trim()), text: box.map((b) => b.textContent.replace(/\s+/g, ' ').trim()).join(' / ') };
  });
  check(`${tag}: staff see "Waitlists" on Today's bookings: each person, how many, their email, mobile and note`, staff.head.includes('Waitlists') && /Tui Example\s*3 people\s*No account/.test(staff.text) && /tui@example\.com · 021 555 0107/.test(staff.text) && /“Three of us, any time\.”/.test(staff.text) && /Ruby Tane\s*1 person/.test(staff.text) && /ruby@example\.com · 021 555 0106/.test(staff.text) && /4 people waiting · \d+ of \d+ places taken/.test(staff.text), staff);
  await scan(page, `${tag}: staff's waitlists`, 'lair-staff [data-joins]');
  await page.evaluate(() => document.querySelector('lair-staff .staff-waitlist')?.scrollIntoView({ block: 'start' }));
  await shot(page, `${tag}-4-staff-waitlists`);

  /* ---------- 5. My Lair: coming, maybe and waitlists ---------- */
  await open('/pages/my-lair#bookings', RUBY);
  await page.waitForSelector('my-lair [data-ml-said]:not([hidden])', { timeout: 20000 }).catch(() => {});
  const ml = await page.evaluate(() => {
    const box = document.querySelector('my-lair [data-ml-said]');
    return box && !box.hidden ? { head: box.querySelector('.ml-said__h')?.textContent.trim(), items: [...box.querySelectorAll('.ml-said__item')].map((i) => ({ text: i.querySelector('.ml-said__main').textContent.replace(/\s+/g, ' ').trim(), toggle: i.querySelector('[data-ml-said-remind]')?.getAttribute('aria-pressed') || null, back: i.querySelector('[data-ml-said-back]')?.textContent.trim() })), visible: Boolean(box.offsetParent) } : null;
  });
  const mlMaybe = ml && ml.items.find((i) => /You’re a maybe/.test(i.text));
  const mlWait = ml && ml.items.find((i) => /On the waitlist · 1 person/.test(i.text));
  check(`${tag}: My Lair lists "Coming, maybe and waitlists": the maybe with its toggle on, the waitlist place with Take me off`, ml && ml.visible && ml.head === 'Coming, maybe and waitlists' && mlMaybe && mlMaybe.toggle === 'true' && mlMaybe.back === 'Take it back' && mlWait && mlWait.toggle === null && mlWait.back === 'Take me off', ml);
  await page.evaluate(() => document.querySelector('my-lair [data-ml-said]')?.scrollIntoView({ block: 'center' }));
  await shot(page, `${tag}-5-my-lair`);
  await scan(page, `${tag}: My Lair's list`, 'my-lair [data-ml-said]');
  await page.click('my-lair [data-ml-said-remind][aria-pressed="true"]');
  await page.waitForFunction(() => document.querySelector('my-lair [data-ml-said-remind]')?.getAttribute('aria-pressed') === 'false', null, { timeout: 8000 }).catch(() => {});
  const mlOff = await page.evaluate(() => ({ pressed: document.querySelector('my-lair [data-ml-said-remind]')?.getAttribute('aria-pressed'), focus: document.activeElement?.hasAttribute('data-ml-said-remind') || false, say: document.querySelector('my-lair [data-ml-said-say]')?.textContent || '' }));
  check(`${tag}: My Lair's toggle turns it off in one tap, keeps focus and says so`, mlOff.pressed === 'false' && mlOff.focus && mlOff.say === 'Reminder off.', mlOff);
  await page.click('my-lair [data-ml-said-back]:text("Take me off")');
  await page.waitForTimeout(500);
  const mlBack = await page.evaluate(() => [...document.querySelectorAll('my-lair .ml-said__item')].map((i) => i.textContent.replace(/\s+/g, ' ').trim()));
  check(`${tag}: Take me off: the waitlist place goes from the list`, mlBack.length === 1 && /You’re a maybe/.test(mlBack[0]), mlBack);

  /* ---------- 6. the whole page ---------- */
  check(`${tag}: no sideways scroll on My Lair`, (await overflowX(page)) <= 0, await overflowX(page));
  await openEvent(dates.open.id, RUBY);
  check(`${tag}: no sideways scroll on the events page with the sheet open`, (await overflowX(page)) <= 0, await overflowX(page));
  check(`${tag}: no console errors`, !errors.length, errors.slice(0, 5));
  await ctx.close();
}

await browser.close();
server.close?.();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

// Round 6, part 1 (sessions): TTRPG sessions for customers, in demo mode on the theme mock, phone (390x844) then
// desktop (1280x800). Prints a PASS or FAIL line per check, then a summary.
//   - No "GM game" left in the customer pages this round changed (the sessions page, the calendar, My Lair, the
//     booking page's FAQ); the staff page keeps it. Headers and footers are left out: their menus are the nav agent's.
//   - A guest joins from the sessions page and from the calendar, with no account, and gets a ticket whose QR code
//     decodes to its code; the ticket says pay at the counter, that the GM has been told, and to make an account with
//     the same email. Log in is offered beside the form, and saving a seat every week says it needs an account.
//   - The demo's outbox (state.outbox) has the GM's email, with the player's details.
//   - A guest's seat shows in My Lair once they log in with the same email.
//   - A member's join still works, from the sessions page and the calendar.
//   - The calendar's TCG and TTRPG sub-chips filter, by keyboard too, and are one scrolling row on phones.
//   - Prices: an entry fee as money, a price note as written, Free for a $0 fee, nothing when neither (never $0 or
//     null), on the calendar's cards and sheets and in the usual week.
//   - Keyboard: focus moves into the sheet and the form, and back to the card that opened it.
//   - No sideways scroll, no console errors.
// Usage: DG_THEME=/path/to/theme QA_PORT=4712 [OUT=/dir] node tools/qa/round6/sessions.mjs [phone|desktop]
// Needs npm install in tools/qa/theme-mock, Playwright at /opt/node-tools/node_modules/playwright, and python3 with
// zxing-cpp and pillow for the QR codes (pip install zxing-cpp pillow).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
process.env.DG_THEME = process.env.DG_THEME || '/home/claude/r6/sessions';
const m = await import('../theme-mock/render.mjs');
m.globalSettings.lair_mode = 'demo';

const PORT = Number(process.env.QA_PORT || 4712);
const BASE = `http://localhost:${PORT}`;
// Screenshots (and the QR crops it decodes) go outside the repo: OUT, or a folder in the system's temp directory
const OUT = `${process.env.OUT || path.join(os.tmpdir(), 'dg-round6-sessions')}/`;
fs.mkdirSync(OUT, { recursive: true });
const DECODE = new URL('../round5/booking-qa/decode.py', import.meta.url).pathname;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const ONLY = process.argv[2];
const RUBY = {
  id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [],
  orders_count: 1, orders: [], store_credit_account: { balance: 500 },
};
const GM_GAME = /\bGM games?\b/i;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` | ${String(detail).replace(/\s+/g, ' ').slice(0, 500)}` : ''}`);
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const decode = (file) => execFileSync('python3', [DECODE, file]).toString().trim();
const errors = [];

const server = await m.serve(PORT);
const browser = await chromium.launch();

/** A fresh browser context at a size, logged in as `customer` (or not), on `path` */
async function open(size, path, { customer = null, ctx = null } = {}) {
  const vp = SIZES[size];
  const phone = vp.width < 700;
  const context = ctx || (await browser.newContext({ viewport: vp, hasTouch: phone, isMobile: phone }));
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${size} ${path} pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`${size} ${path} console: ${msg.text()}`);
  });
  m.mockState.customer = customer;
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  if (path.startsWith('/pages/gm-games')) await page.waitForSelector('.gm-card, .gm-empty', { timeout: 10000 });
  if (path.startsWith('/pages/events-calendar')) await page.waitForSelector('.cal-card, .cal-empty', { timeout: 10000 });
  if (path.startsWith('/pages/my-lair') && customer) await page.waitForSelector('[data-panel="seats"]:not([aria-busy])', { state: 'attached', timeout: 10000 });
  await page.waitForTimeout(400);
  return { ctx: context, page };
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
/** Buttons, inputs and links in a scope under 44px, leaving out links inside a line of text */
const smallTargets = (page, scope) => page.evaluate((scope) => {
  const out = [];
  for (const el of document.querySelectorAll(`${scope} button, ${scope} a, ${scope} input:not([type="radio"]):not([type="checkbox"]), ${scope} select, ${scope} textarea, ${scope} .chip`)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
    if (el.matches('a, button') && el.closest('p, li, dd') && !el.matches('.button, .chip *')) continue;
    if (r.height < 43.5 || r.width < 43.5) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${flat(el.textContent).slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return out;
}, scope);
/** The text a customer can see in the page's main content (menus left out), including closed FAQ answers */
const mainText = (page) => page.evaluate(() => {
  const main = document.querySelector('main') || document.body;
  const copy = main.cloneNode(true);
  copy.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
  return copy.innerHTML.replace(/<[^>]+>/g, ' ');
});
const outbox = (page) => page.evaluate(() => {
  try {
    return JSON.parse(localStorage.getItem('dg-lair-demo-v3')).outbox || [];
  } catch {
    return [];
  }
});
const active = (page) => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return { tag: 'body' };
  return { tag: a.tagName.toLowerCase(), id: a.id, game: a.dataset.game || '', item: a.dataset.item || '', name: a.getAttribute('name') || '', cls: String(a.className) };
});
const qrDecodes = async (page, locator, code, file) => {
  await locator.scrollIntoViewIfNeeded();
  await locator.screenshot({ path: `${OUT}${file}.png` });
  const out = decode(`${OUT}${file}.png`);
  return { ok: out.includes(`'${code}'`), out };
};

/** Fill and send the join form as a guest: two seats, a second player with a character, a phone and a note */
async function guestJoin(page, { name, email, seats = 2 }) {
  await page.fill('[data-session-join] [name="name"]', name);
  await page.fill('[data-session-join] [name="email"]', email);
  await page.fill('[data-session-join] [name="phone"]', '021 000 0000');
  if (seats > 1) {
    await page.locator(`[data-session-join] [name="seats"][value="${seats}"]`).check({ force: true });
    await page.waitForTimeout(150);
    await page.fill('[data-session-join] [name="player-name"][data-index="1"]', 'Ana Example');
    await page.fill('[data-session-join] [name="player-character"][data-index="1"]', 'Brother Vex');
  }
  await page.fill('[data-session-join] [name="notes"]', 'First time at the Lair.');
  await page.click('[data-join-submit]');
  await page.waitForSelector('.gm-done', { timeout: 8000 });
  await page.waitForTimeout(300);
}

for (const size of Object.keys(SIZES).filter((s) => !ONLY || s === ONLY)) {
  const S = size;

  /* ---------- 1. the sessions page, logged out: a guest joins ---------- */
  {
    const { ctx, page } = await open(size, '/pages/gm-games');
    check(`${S} sessions page: the heading leads with booking a session`, /Book a TTRPG session/.test(flat(await page.locator('main h1').first().innerText())));
    // Running a game: a quiet button for GMs above the list on phones, and the GMs' box after (beside, on desktop) it
    const gms = await page.evaluate(() => {
      const host = document.querySelector('.gm-toolbar__host');
      const box = document.querySelector('.gm-perks');
      const list = document.querySelector('.gm-grid');
      return {
        host: host && host.offsetParent ? host.textContent.trim() : '', hostPotion: Boolean(host && host.matches('.button--potion')),
        box: box ? box.querySelector('h2').textContent.trim() : '', boxBg: box ? getComputedStyle(box).backgroundColor : '',
        potion: getComputedStyle(document.documentElement).getPropertyValue('--c-potion').trim(),
        after: Boolean(box && list && list.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    const potionRgb = gms.potion.startsWith('#') ? `rgb(${[1, 3, 5].map((i) => parseInt(gms.potion.slice(i, i + 2), 16)).join(', ')})` : gms.potion;
    check(`${S} sessions page: running a game is for GMs, secondary`, (S === 'phone' ? /For GMs: run a game/.test(gms.host) && !gms.hostPotion : !gms.host)
      && gms.box === 'GMs: run your own game' && gms.after && gms.boxBg !== potionRgb, JSON.stringify(gms));
    // a one-shot with at least two seats left
    const id = await page.evaluate(() => {
      const now = Date.now();
      const g = window.Lair.store.data.games.filter((x) => !x.seriesId && x.status === 'open' && x.start > now && x.seats - x.taken >= 2).sort((a, b) => a.start - b.start)[0];
      return g ? g.id : null;
    });
    check(`${S} sessions page: a one-shot with room to join`, Boolean(id));
    await page.click(`.gm-card__link[data-game="${id}"]`);
    await page.waitForSelector('[data-sheet][open]');
    await page.waitForTimeout(300);
    const join = page.locator('[data-sheet-foot] [data-join]:not([data-every])');
    const joinText = flat(await join.innerText());
    check(`${S} sessions page: logged out, Join is a plain Join (no log-in wall)`, /^Join · \$\d+ a seat/.test(joinText) && !/Log in/.test(joinText), joinText);
    await join.click();
    await page.waitForSelector('[data-session-join]');
    await page.waitForTimeout(300);
    const form = page.locator('[data-session-join]');
    const fields = await page.evaluate(() => ['name', 'email', 'phone', 'notes'].filter((n) => document.querySelector(`[data-session-join] [name="${n}"]`)));
    check(`${S} sessions page: the guest form asks for name, email, phone and notes`, fields.length === 4, fields);
    const login = form.locator('a[data-account="login"].button');
    check(`${S} sessions page: Log in is offered beside the form, as a button`, (await login.count()) === 1 && /return_(url|to)=/.test((await login.getAttribute('href')) || ''), await login.count());
    check(`${S} sessions page: focus moves into the form (the sheet's title)`, (await active(page)).id === 'gm-sheet-title', JSON.stringify(await active(page)));
    // an empty send says what's missing, on the field
    await page.click('[data-join-submit]');
    await page.waitForTimeout(200);
    const firstBad = await active(page);
    check(`${S} sessions page: sending it empty points at the name field`, firstBad.name === 'name' && (await form.locator('.field__error').count()) >= 2, JSON.stringify(firstBad));
    const small = await smallTargets(page, '[data-sheet]');
    check(`${S} sessions page: the join sheet's targets are 44px`, !small.length, small.join(', '));
    await page.screenshot({ path: `${OUT}${S}-sessions-guest-form.png` });
    const email = `guest.${S}@example.com`;
    await guestJoin(page, { name: `Tui ${S === 'phone' ? 'Phone' : 'Desk'}`, email });
    const ticket = flat(await page.locator('.gm-done').innerText());
    const code = flat(await page.locator('.gm-done .gm-qr__ref').innerText());
    const qr = await qrDecodes(page, page.locator('.gm-done .gm-qr'), code, `${S}-sessions-guest-qr`);
    check(`${S} sessions page: the guest's ticket QR decodes to its code (${code})`, qr.ok, qr.out);
    check(`${S} sessions page: the ticket says pay at the counter, a seat at a time`, /Pay at the counter when you arrive: \$\d+ a seat, \$\d+ for 2\./.test(ticket), ticket);
    check(`${S} sessions page: the ticket says the GM has been told`, /has emailed .+ your GM, to say you’re coming|Gobgob is your GM/.test(ticket), ticket);
    check(`${S} sessions page: the ticket offers an account with the same email`, /Make an account with this email any time, and your seats will show up in My Lair\./.test(ticket)
      && (await page.locator('.gm-done a[data-account="register"]').count()) === 1, ticket);
    check(`${S} sessions page: focus moves to the ticket`, /gm-done/.test((await active(page)).cls), JSON.stringify(await active(page)));
    await page.screenshot({ path: `${OUT}${S}-sessions-guest-ticket.png` });
    // the GM's email in the demo's outbox
    const mail = (await outbox(page)).filter((e) => e.kind === 'gm-new-player').pop();
    const lines = mail ? Object.fromEntries(mail.lines) : {};
    check(`${S} demo outbox: the GM is emailed about the new player`, Boolean(mail) && /^New player for .+: Tui/.test(mail.subject) && lines.Email === email && lines.Phone === '021 000 0000'
      && lines.Seats === '2' && /Ana Example as Brother Vex/.test(lines.Players) && lines.Notes === 'First time at the Lair.' && /pay at the counter/.test(lines.Paying) && 'Seats left' in lines, JSON.stringify(mail));
    const confirm = (await outbox(page)).filter((e) => e.kind === 'seat-confirmation').pop();
    check(`${S} demo outbox: the guest's confirmation adds the account line`, Boolean(confirm) && confirm.to === email && JSON.stringify(confirm.lines).includes('Make an account with this email any time'), JSON.stringify(confirm));
    // closing goes back to the card that opened it
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const back = await active(page);
    check(`${S} sessions page: closing the ticket puts focus back on the card`, back.game === id, JSON.stringify(back));
    // a weekly game: saving a seat every week needs an account, said plainly
    const weekly = await page.evaluate(() => {
      const g = window.Lair.store.data.games.find((x) => x.seriesId && x.nextOnly && ['open', 'full'].includes(x.status) && x.start > Date.now() && x.seats - x.taken > 0);
      return g ? g.id : null;
    });
    if (weekly) {
      await page.click(`.gm-card__link[data-game="${weekly}"]`);
      await page.waitForSelector('[data-sheet][open]');
      await page.waitForTimeout(300);
      const save = flat(await page.locator('[data-sheet-foot] [data-every]').innerText());
      check(`${S} sessions page: logged out, saving a seat every week says log in`, /^Log in to save my seat/.test(save), save);
      await page.click('[data-sheet-foot] [data-join]:not([data-every])');
      await page.waitForSelector('[data-session-join]');
      const note = flat(await page.locator('.gm-join__weekly').innerText());
      check(`${S} sessions page: the guest form says a weekly seat needs an account`, /needs a Dice Goblin account/.test(note), note);
      await page.click('[data-sheet] [data-close]');
    } else check(`${S} sessions page: a weekly game with room`, false, 'none in the demo');
    const text = await mainText(page);
    check(`${S} sessions page: no "GM game" anywhere a customer reads`, !GM_GAME.test(text), (text.match(/.{0,60}\bGM games?\b.{0,60}/i) || [''])[0]);
    check(`${S} sessions page: no sideways scroll`, (await overflow(page)) <= 0);
    await ctx.close();
  }

  /* ---------- 1b. the Lair app's own words when it says no: too many bookings for one email, and a full session ---------- */
  {
    const { ctx, page } = await open(size, '/pages/gm-games');
    const id = await page.evaluate(() => {
      const g = window.Lair.store.data.games.filter((x) => !x.seriesId && x.status === 'open' && x.start > Date.now() && x.seats - x.taken >= 1).sort((a, b) => a.start - b.start)[0];
      return g ? g.id : null;
    });
    // six bookings coming up for one email already (the demo's state, as the Lair app would have them)
    await page.evaluate(() => {
      const backend = window.Lair.store.backend;
      const now = Date.now();
      for (let i = 0; i < 6; i += 1) {
        backend.state.bookings.push({
          id: `bk-limit-${i}`, ref: `LI-MIT-${i + 1}`, kind: 'table', tables: ['T21'], start: now + (i + 2) * 86400000, end: now + (i + 2) * 86400000 + 3600000,
          people: 1, name: 'Busy Example', email: 'busy@example.com', status: 'confirmed', pay: 'day', paid: false, amount: 1000,
        });
      }
      backend.commit();
    });
    const tryJoin = async (email) => {
      await page.click(`.gm-card__link[data-game="${id}"]`);
      await page.waitForSelector('[data-sheet][open]');
      await page.click('[data-sheet-foot] [data-join]:not([data-every])');
      await page.waitForSelector('[data-session-join]');
      await page.fill('[data-session-join] [name="name"]', 'Busy Example');
      await page.fill('[data-session-join] [name="email"]', email);
      await page.click('[data-join-submit]');
      await page.waitForSelector('[data-session-join] [data-form-status] [role="alert"]', { timeout: 5000 }).catch(() => {});
      return flat(await page.locator('[data-session-join] [data-form-status]').innerText().catch(() => ''));
    };
    const limit = await tryJoin('busy@example.com');
    check(`${S} errors: too many bookings for one email reads as the app says it`, limit === 'You already have 6 bookings coming up. Call us to book more.', limit);
    await page.click('[data-sheet] [data-close]');
    // the session fills up while the form is open
    await page.click(`.gm-card__link[data-game="${id}"]`);
    await page.waitForSelector('[data-sheet][open]');
    await page.click('[data-sheet-foot] [data-join]:not([data-every])');
    await page.waitForSelector('[data-session-join]');
    await page.evaluate((x) => {
      const backend = window.Lair.store.backend;
      const g = backend.state.games.find((y) => y.id === x);
      g.taken = g.seats;
      backend.commit();
    }, id);
    await page.fill('[data-session-join] [name="name"]', 'Late Example');
    await page.fill('[data-session-join] [name="email"]', 'late@example.com');
    await page.click('[data-join-submit]');
    await page.waitForSelector('[data-session-join] [data-form-status] [role="alert"]', { timeout: 5000 }).catch(() => {});
    const full = flat(await page.locator('[data-session-join] [data-form-status]').innerText().catch(() => ''));
    check(`${S} errors: a session that filled up reads as the app says it`, full === 'This table is full.', full);
    await ctx.close();
  }

  /* ---------- 2. the events calendar, logged out: a guest joins a session there ---------- */
  {
    const { ctx, page } = await open(size, '/pages/events-calendar');
    const items = await page.evaluate(() => {
      const cal = document.querySelector('lair-calendar');
      const now = Date.now();
      const games = cal.all().filter((i) => i.kind === 'game' && i.end > now);
      const series = new Map();
      for (const g of games) if (g.seriesId) series.set(g.seriesId, [...(series.get(g.seriesId) || []), g]);
      const weekly = [...series.values()].find((list) => ['weekly', 'fortnightly'].includes(list[0].schedule));
      return {
        floor: window.Lair.store.data.games.filter((g) => ['open', 'full'].includes(g.status) && g.end > now).map((g) => g.id),
        shown: games.filter((g) => !g.projected).map((g) => g.gameId),
        weeklyDates: weekly ? weekly.length : 0,
        weeklyFirst: weekly ? weekly[0].start : 0,
        horizon: window.Lair.store.cfg.horizonDays,
        open: (games.find((g) => !g.projected && g.start > now && g.seats - g.taken >= 2) || {}).id || null,
        full: (games.find((g) => !g.projected && g.seats - g.taken <= 0) || {}).id || null,
        later: (games.find((g) => g.projected) || {}).id || null,
      };
    });
    check(`${S} calendar: every open or full session from the floor is on it`, items.floor.every((id) => items.shown.includes(id)), JSON.stringify(items));
    check(`${S} calendar: a weekly game's later dates are listed to the horizon`, items.weeklyDates >= Math.floor((items.horizon - 7) / 14), JSON.stringify(items));
    // the session's sheet: system, GM, seats left, price, picture or art; Join right there
    await page.evaluate((id) => {
      window.location.hash = `#event=${encodeURIComponent(id)}`;
      document.querySelector('lair-calendar').openFromHash();
    }, items.open);
    await page.waitForSelector('[data-dialog][open]');
    await page.waitForTimeout(300);
    const sheet = flat(await page.locator('[data-dialog]').innerText());
    check(`${S} calendar: a session's sheet has the system, GM, seats left and price`, / with GM .+/.test(sheet) && /\d+ of \d+ seats left/.test(sheet) && /\$\d+ a seat/.test(sheet) && (await page.locator('[data-dialog] .cal-detail__media').count()) === 1, sheet);
    check(`${S} calendar: a session is a TTRPG session, never a GM game`, /TTRPG/.test(sheet) && !GM_GAME.test(sheet), sheet);
    await page.click('[data-dialog-foot] [data-lj-join]:not([data-every])');
    await page.waitForSelector('[data-session-join]');
    await page.waitForTimeout(400);
    const styled = await page.evaluate(() => getComputedStyle(document.querySelector('[data-session-join]')).display);
    check(`${S} calendar: the join form is styled (the sessions page's styles loaded)`, styled === 'grid', styled);
    await page.screenshot({ path: `${OUT}${S}-calendar-guest-form.png` });
    await guestJoin(page, { name: 'Kiri Example', email: `kiri.${S}@example.com` });
    const code = flat(await page.locator('.gm-done .gm-qr__ref').innerText());
    const qr = await qrDecodes(page, page.locator('.gm-done .gm-qr'), code, `${S}-calendar-guest-qr`);
    check(`${S} calendar: the guest's ticket QR decodes to its code (${code})`, qr.ok, qr.out);
    const ticket = flat(await page.locator('.gm-done').innerText());
    check(`${S} calendar: the same ticket as the sessions page`, /Pay at the counter when you arrive: \$\d+ a seat/.test(ticket) && /Make an account with this email any time/.test(ticket), ticket);
    await page.screenshot({ path: `${OUT}${S}-calendar-guest-ticket.png` });
    const mail = (await outbox(page)).filter((e) => e.kind === 'gm-new-player').pop();
    check(`${S} calendar: the GM is emailed about the calendar's guest too`, Boolean(mail) && /: Kiri Example$/.test(mail.subject), JSON.stringify(mail));
    await page.click('[data-dialog-foot] [data-close]');
    await page.waitForTimeout(300);
    // a full session says so, with no Join
    if (items.full) {
      await page.evaluate((id) => document.querySelector('lair-calendar').openItem(id), items.full);
      await page.waitForTimeout(300);
      const foot = flat(await page.locator('[data-dialog-foot]').innerText());
      check(`${S} calendar: a full session says so, with no Join`, /This session is full\./.test(foot) && !(await page.locator('[data-dialog-foot] [data-lj-join]:not([data-every])').count()), foot);
      await page.click('[data-dialog] [data-close]');
    } else check(`${S} calendar: a full session to check`, false, 'none in the demo');
    // a weekly game's later date: says when its seats open, and offers the next one
    if (items.later) {
      await page.evaluate((id) => document.querySelector('lair-calendar').openItem(id), items.later);
      await page.waitForTimeout(300);
      const later = flat(await page.locator('[data-dialog]').innerText());
      check(`${S} calendar: a later weekly date says when its seats open, and offers the next`, /Seats for .+ open once the .+ session is done/.test(later)
        && ((await page.locator('[data-dialog-foot] [data-lj-join]:not([data-every])').count()) === 1 || /See /.test(later)), later);
      await page.click('[data-dialog] [data-close]');
    }
    const text = await mainText(page);
    check(`${S} calendar: no "GM game" anywhere a customer reads`, !GM_GAME.test(text), (text.match(/.{0,60}\bGM games?\b.{0,60}/i) || [''])[0]);
    check(`${S} calendar: no sideways scroll`, (await overflow(page)) <= 0);
    await ctx.close();
  }

  /* ---------- 3. the calendar's sub-chips, and prices ---------- */
  {
    const { ctx, page } = await open(size, '/pages/events-calendar');
    const sub = page.locator('[data-subfilters]');
    check(`${S} chips: no second row until a type with one is picked`, await sub.isHidden());
    await page.locator('[data-filters] .chip', { hasText: 'TCGs' }).click();
    await page.waitForTimeout(250);
    const tcg = await page.evaluate(() => {
      const cal = document.querySelector('lair-calendar');
      const row = document.querySelector('[data-subfilters]');
      const style = getComputedStyle(row);
      const chips = [...row.querySelectorAll('.chip')];
      return {
        hidden: row.hidden, label: row.getAttribute('aria-label'), names: chips.map((c) => c.textContent.trim()),
        oneRow: chips.every((c) => Math.abs(c.getBoundingClientRect().top - chips[0].getBoundingClientRect().top) < 2), wrap: style.flexWrap, overflowX: style.overflowX,
        empty: cal.subChips('tcg').filter((s) => !cal.all().some((i) => i.type === 'tcg' && i.end > Date.now() && cal.subOf(i).key === s.key)).map((s) => s.label),
      };
    });
    check(`${S} chips: TCGs gets a row by game, labelled for screen readers`, !tcg.hidden && tcg.label === 'TCGs by game' && tcg.names[0] === 'All TCGs' && tcg.names.length >= 3, JSON.stringify(tcg));
    check(`${S} chips: no empty chips`, !tcg.empty.length, tcg.empty.join(', '));
    check(`${S} chips: one row${S === 'phone' ? ' that scrolls sideways' : ''}`, tcg.oneRow && tcg.wrap === 'nowrap' && tcg.overflowX === 'auto', JSON.stringify(tcg));
    // pick a game: only its events show; then by keyboard, the arrow keys move to the next one
    const pick = tcg.names[1];
    await sub.locator('.chip', { hasText: pick }).click();
    await page.waitForTimeout(250);
    const picked = await page.evaluate(() => {
      const cal = document.querySelector('lair-calendar');
      const list = cal.filtered();
      const shown = [...document.querySelectorAll('.cal-body [data-item]')].map((b) => b.dataset.item);
      return { sub: cal.sub, ok: list.length > 0 && list.every((i) => i.type === 'tcg' && cal.subOf(i).key === cal.sub), shownOk: shown.every((id) => list.some((i) => i.id === id)), shown: shown.length };
    });
    check(`${S} chips: picking ${pick} shows only ${pick}`, picked.ok && picked.shownOk, JSON.stringify(picked));
    await sub.locator('input:checked').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(250);
    const moved = await page.evaluate(() => document.querySelector('lair-calendar').sub);
    check(`${S} chips: the arrow keys move along the row and filter`, moved !== picked.sub && moved !== 'all', `${picked.sub} → ${moved}`);
    await page.locator('[data-filters] .chip', { hasText: 'TTRPG' }).click();
    await page.waitForTimeout(250);
    const rpg = await page.evaluate(() => {
      const cal = document.querySelector('lair-calendar');
      const names = [...document.querySelectorAll('[data-subfilters] .chip')].map((c) => c.textContent.trim());
      const dnd = cal.subChips('rpg').find((s) => /D&D|Dungeons/.test(s.label));
      return { label: document.querySelector('[data-subfilters]').getAttribute('aria-label'), names, sub: cal.sub, dnd: dnd && dnd.label };
    });
    check(`${S} chips: TTRPG starts at All TTRPGs, by system and game`, rpg.label === 'TTRPGs by system' && rpg.names[0] === 'All TTRPGs' && rpg.sub === 'all' && Boolean(rpg.dnd), JSON.stringify(rpg));
    if (rpg.dnd) {
      await sub.locator('.chip', { hasText: rpg.dnd }).click();
      await page.waitForTimeout(250);
      const dnd = await page.evaluate(() => {
        const cal = document.querySelector('lair-calendar');
        const list = cal.filtered();
        return { kinds: [...new Set(list.map((i) => i.kind))], ok: list.every((i) => i.type === 'rpg' && /^(D&D|Dungeons)/.test(i.kind === 'game' ? i.system : i.game)) };
      });
      check(`${S} chips: D&D shows its sessions and its events together`, dnd.ok && dnd.kinds.includes('game') && dnd.kinds.includes('event'), JSON.stringify(dnd));
    }
    await page.screenshot({ path: `${OUT}${S}-calendar-chips.png` });
    await page.locator('[data-filters] .chip', { hasText: 'Everything' }).click();
    await page.waitForTimeout(250);
    check(`${S} chips: Everything hides the second row`, await sub.isHidden());

    // prices: one event of each kind, on its card and its sheet
    const cases = await page.evaluate(() => {
      const cal = document.querySelector('lair-calendar');
      const now = Date.now();
      const events = cal.all().filter((i) => i.kind === 'event' && i.end > now && !i.gameTables && !i.product);
      const pick = (fn) => (events.find(fn) || {}).id || null;
      return {
        fee: pick((i) => i.entryFee > 0), note: pick((i) => !i.entryFee && !i.freeEntry && i.price),
        free: pick((i) => i.freeEntry), neither: pick((i) => !i.entryFee && !i.freeEntry && !i.price),
      };
    });
    const priceOf = async (id) => {
      await page.evaluate((x) => {
        window.location.hash = `#event=${encodeURIComponent(x)}`;
        document.querySelector('lair-calendar').openFromHash();
      }, id);
      await page.waitForSelector('[data-dialog][open]');
      await page.waitForTimeout(250);
      const facts = flat(await page.locator('[data-dialog] .cal-facts').innerText());
      const item = await page.evaluate((x) => {
        const i = document.querySelector('lair-calendar').find(x);
        return { title: i.title, entryFee: i.entryFee, price: i.price };
      }, id);
      await page.click('[data-dialog] [data-close]');
      await page.waitForTimeout(250);
      const card = flat(await page.locator(`.cal-body [data-item="${id}"]`).first().innerText());
      return { facts, card, item };
    };
    for (const [kind, id] of Object.entries(cases)) {
      if (!id) {
        check(`${S} prices: an event with ${kind === 'neither' ? 'no fee and no note' : kind === 'fee' ? 'an entry fee' : kind === 'note' ? 'a price note' : 'a $0 fee'} to check`, false, 'none in the mock events');
        continue;
      }
      const p = await priceOf(id);
      const both = `${p.facts} || ${p.card}`;
      let ok = !/\$0\b|null|undefined|NaN/.test(both);
      if (kind === 'fee') ok = ok && p.facts.includes(`$${p.item.entryFee / 100} a person`) && p.card.includes(`$${p.item.entryFee / 100}`);
      if (kind === 'note') ok = ok && p.facts.includes(p.item.price) && p.card.includes(p.item.price);
      if (kind === 'free') ok = ok && /\bFree\b/.test(p.facts) && /\bFree\b/.test(p.card);
      if (kind === 'neither') ok = ok && !/\$|\bFree\b/.test(both);
      check(`${S} prices: ${kind === 'fee' ? 'an entry fee as money' : kind === 'note' ? 'a price note as written' : kind === 'free' ? 'a $0 fee reads Free' : 'no fee and no note shows no price'} (${p.item.title})`, ok, both);
    }
    // the usual week, as text
    const week = await page.evaluate(() => [...document.querySelectorAll('.whats-on li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
    const titleOf = async (id) => (id ? page.evaluate((x) => document.querySelector('lair-calendar').find(x).title, id) : '');
    const lineOf = async (id) => {
      const title = await titleOf(id);
      return week.find((l) => l.startsWith(title)) || '';
    };
    const feeLine = await lineOf(cases.fee);
    const noteLine = await lineOf(cases.note);
    const freeLine = await lineOf(cases.free);
    check(`${S} the usual week: fee, note and Free as the calendar shows them, never $0`, /\$\d+ a person/.test(feeLine) && noteLine.includes('booster') && /, Free\b/.test(freeLine) && !week.some((l) => /\$0\b|null/.test(l)), JSON.stringify({ feeLine, noteLine, freeLine }));
    await ctx.close();
  }

  /* ---------- 4. members: a join from the sessions page and the calendar, and a guest's seat in My Lair ---------- */
  {
    // a guest books with Ruby's email, then logs in as Ruby: the seat shows in My Lair
    const { ctx, page } = await open(size, '/pages/gm-games');
    const id = await page.evaluate(() => {
      const g = window.Lair.store.data.games.filter((x) => !x.seriesId && x.status === 'open' && x.start > Date.now() && x.seats - x.taken >= 1).sort((a, b) => b.start - a.start)[0];
      return g ? g.id : null;
    });
    const title = await page.evaluate((x) => window.Lair.store.data.games.find((g) => g.id === x).title, id);
    await page.click(`.gm-card__link[data-game="${id}"]`);
    await page.waitForSelector('[data-sheet][open]');
    await page.click('[data-sheet-foot] [data-join]:not([data-every])');
    await page.waitForSelector('[data-session-join]');
    await guestJoin(page, { name: 'Ruby Tane', email: 'ruby@example.com', seats: 1 });
    await page.close();
    const mine = await open(size, '/pages/my-lair#ml-seats', { customer: RUBY, ctx });
    const seats = flat(await mine.page.locator('[data-panel="seats"]').evaluate((el) => el.textContent));
    check(`${S} My Lair: a guest's seat shows once they log in with that email`, seats.includes(title), `${title} | ${seats.slice(0, 300)}`);
    check(`${S} My Lair: no "GM game" on the seat cards`, !GM_GAME.test(await mainText(mine.page)));
    await ctx.close();

    // a member's join on the sessions page: filled in from their account, ticket with its own code
    const a = await open(size, '/pages/gm-games', { customer: RUBY });
    await a.page.waitForTimeout(600);
    const gid = await a.page.evaluate(() => {
      const board = document.querySelector('gm-board');
      const mineIds = new Set((board.seats || []).filter((s) => ['held', 'confirmed', 'seated'].includes(s.status)).map((s) => s.gameId));
      const g = window.Lair.store.data.games.filter((x) => !x.seriesId && x.status === 'open' && x.start > Date.now() && x.seats - x.taken > 0 && !mineIds.has(x.id)).sort((x, y) => x.start - y.start)[0];
      return g ? g.id : null;
    });
    await a.page.click(`.gm-card__link[data-game="${gid}"]`);
    await a.page.waitForSelector('[data-sheet][open]');
    await a.page.click('[data-sheet-foot] [data-join]:not([data-every])');
    await a.page.waitForSelector('[data-session-join]');
    const prefilled = flat(await a.page.locator('[data-booker-line]').innerText());
    check(`${S} member: the form is filled in from their account, with no log-in box`, /Booking as Ruby Tane/.test(prefilled) && !(await a.page.locator('.gm-join__who').count()), prefilled);
    await a.page.click('[data-join-submit]');
    await a.page.waitForSelector('.gm-done', { timeout: 8000 });
    const ref = flat(await a.page.locator('.gm-done .gm-qr__ref').innerText());
    const qr = await qrDecodes(a.page, a.page.locator('.gm-done .gm-qr'), ref, `${S}-member-qr`);
    check(`${S} member: a join on the sessions page still works, QR ${ref}`, qr.ok && !(await a.page.locator('.gm-join__account').count()), qr.out);
    await a.ctx.close();

    // and from the calendar: then the sheet says You're in, with the code
    const c = await open(size, '/pages/events-calendar', { customer: RUBY });
    await c.page.waitForTimeout(600);
    const cid = await c.page.evaluate(() => {
      const cal = document.querySelector('lair-calendar');
      const mineIds = new Set((cal.mine.seats || []).map((s) => s.gameId));
      const g = cal.all().find((i) => i.kind === 'game' && !i.projected && i.start > Date.now() && i.seats - i.taken > 0 && !mineIds.has(i.gameId));
      return g ? g.id : null;
    });
    await c.page.evaluate((x) => document.querySelector('lair-calendar').openItem(x), cid);
    await c.page.waitForTimeout(300);
    await c.page.click('[data-dialog-foot] [data-lj-join]:not([data-every])');
    await c.page.waitForSelector('[data-session-join]');
    await c.page.click('[data-join-submit]');
    await c.page.waitForSelector('.gm-done', { timeout: 8000 });
    const cref = flat(await c.page.locator('.gm-done .gm-qr__ref').innerText());
    await c.page.click('[data-dialog-foot] [data-close]');
    await c.page.waitForTimeout(600);
    await c.page.evaluate((x) => document.querySelector('lair-calendar').openItem(x), cid);
    await c.page.waitForTimeout(300);
    const you = (await c.page.locator('.cal-you').count()) ? flat(await c.page.locator('.cal-you').innerText()) : '';
    check(`${S} member: a join in the calendar works, and the sheet then says You're in with the code`, you.includes('You’re in') && you.includes(cref), `${cref} | ${you}`);
    await c.ctx.close();
  }

  /* ---------- 5. keyboard: into the sheet and the form, and back to the card ---------- */
  for (const path of ['/pages/gm-games', '/pages/events-calendar']) {
    const { ctx, page } = await open(size, path);
    const cal = path.includes('calendar');
    const opener = page.locator(cal ? '.cal-card[data-item^="game:"]' : '.gm-card__link').first();
    const key = await opener.getAttribute(cal ? 'data-item' : 'data-game');
    await opener.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(350);
    const inSheet = await page.evaluate(() => Boolean(document.activeElement && document.activeElement.closest('dialog[open]')));
    let reached = false;
    for (let i = 0; i < 40 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => /^Join · /.test((document.activeElement && document.activeElement.textContent.trim()) || ''));
    }
    if (reached) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
    }
    const inForm = (await active(page)).id === (cal ? 'cal-sheet-title' : 'gm-sheet-title') && (await page.locator('[data-session-join]').count()) === 1;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    const back = await active(page);
    check(`${S} keyboard (${cal ? 'calendar' : 'sessions page'}): into the sheet, Tab to Join, into the form, and back to the card on Escape`,
      inSheet && reached && inForm && (cal ? back.item : back.game) === key, JSON.stringify({ inSheet, reached, inForm, back, key }));
    await ctx.close();
  }
}

check('no console errors or page errors', !errors.length, errors.join(' || '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} passed${failed.length ? `; failed: ${failed.map((r) => r.name).join('; ')}` : ''}`);
await browser.close();
server.close();
process.exitCode = failed.length ? 1 : 0;

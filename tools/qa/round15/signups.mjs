// Round 15 (everything on the tab) checks for lair-join.js, lair-calendar.js and lair-games.js, on the theme mock in
// demo mode: joining a TTRPG seat, signing up for an event (paid, inside 24 hours, free), reserving a game table, the
// confirmations (no QR, no code, the tab and cancel words, Add to calendar, My Lair), the forms' lock lines, no paying
// online, a member's own seat and sign-up with Cancel, and locked when the clock is moved inside 24 hours. Axe on the
// sheets. Phone and desktop, guest and member.
// Usage: DG_THEME=/path/to/theme [PORT=4971] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round15/signups.mjs [phone|desktop]
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
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round15-signups');
fs.mkdirSync(OUT, { recursive: true });
// AXE: a copy of axe-core's axe.min.js; without it the axe checks are skipped (and say so)
const AXE = process.env.AXE || '';
const axe = AXE && fs.existsSync(AXE) ? fs.readFileSync(AXE, 'utf8') : null;
const PORT = Number(process.env.PORT || 4971);
const BASE = `http://localhost:${PORT}`;
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const TZ = 'Pacific/Auckland';
const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const offset = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(`${key}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const iso = (key, hm) => `${key}T${hm}:00${offset(key)}`;
const today = lairKey(Date.now());
const AT = Date.parse(iso(today, '13:00'));
// The page's clock: today 1pm in Auckland, or sessionStorage qa-at (to move it inside 24 hours, same demo day)
const CLOCK = `(() => { let at = ${AT}; try { const v = sessionStorage.getItem('qa-at'); if (v) at = Number(v); } catch {}
  const OFFSET = at - Date.now(); const Real = Date;
  class LairDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
  globalThis.Date = LairDate; })();`;
const RUBY = { id: 7700112233, first_name: 'Ruby', last_name: 'Tane', name: 'Ruby Tane', email: 'ruby@example.com', phone: null, tags: [] };

let pass = 0;
let fail = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else {
    fail += 1;
    fails.push(name);
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 900)}`}`);
  return ok;
};
let axeTotal = 0;
async function scan(page, label, selector) {
  if (!axe) return;
  await page.addScriptTag({ content: axe });
  const found = await page.evaluate(async (sel) => {
    const nodes = [...document.querySelectorAll(sel)];
    const out = [];
    for (const node of nodes) {
      const r = await window.axe.run(node, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
      out.push(...r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} ${n.failureSummary || ''}`).join(' | ')}`));
    }
    return { count: nodes.length, out };
  }, selector);
  axeTotal += found.out.length;
  check(`axe: ${label} (${found.count} node)`, found.count > 0 && !found.out.length, found.out.join(' / ') || 'nothing matched');
}

const server = await m.serve(PORT);
const browser = await chromium.launch();

/** What the words say, from the page's own window.Lair.TAB */
const tab = (page) => page.evaluate(() => {
  const T = window.Lair.TAB;
  // a guest has no tab or My Lair yet: their own words before booking and once it's locked
  const guest = !window.Lair.store.cfg.customer;
  return {
    onTab: T.onTab, onTabGuest: T.onTabGuest, nothingToPay: T.nothingToPay, soon: guest ? T.soonGuest() : T.soon(), ahead: guest ? T.aheadGuest() : T.ahead(),
    lockedNow: guest ? T.lockedNowGuest() : T.lockedNow(), lockedLabel: T.lockedLabel, lockedHint: T.lockedHint(),
  };
});
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
/** The text of an element, with what each Add to calendar file says (decoded) */
const sheetInfo = (page, sel) => page.evaluate(async (s) => {
  const d = document.querySelector(s);
  if (!d) return null;
  const flatten = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const icsLinks = [];
  for (const a of d.querySelectorAll('a[download]')) {
    const href = a.getAttribute('href');
    const text = href.startsWith('blob:') ? await (await fetch(href)).text() : decodeURIComponent(href.replace(/^data:text\/calendar;charset=utf-8,/, ''));
    icsLinks.push({ name: a.getAttribute('download'), text: text.replace(/\r?\n /g, '') });
  }
  return {
    open: d.open, title: flatten(d.querySelector('h2')?.textContent), text: flatten(d.textContent),
    qr: d.querySelectorAll('svg.qr, .gm-qr, .ticket-code, .ticket__stub, .cal-you__code, [class*="qr"]').length,
    icsLinks, google: [...d.querySelectorAll('a[href*="calendar.google.com"]')].map((a) => decodeURIComponent(a.href)),
    links: [...d.querySelectorAll('a')].map((a) => ({ text: flatten(a.textContent), href: a.getAttribute('href') })),
    buttons: [...d.querySelectorAll('button')].filter((b) => b.offsetParent).map((b) => flatten(b.textContent)),
    payNow: d.querySelectorAll('[name="pay"][value="now"], [data-pay-now-label]').length,
  };
}, sel);
const noCode = (info, ref) => !/\bcode\b/i.test(info.text.replace(/member code[^.]*\./gi, '')) && !/\bQR\b/.test(info.text) && !(ref && info.text.includes(ref));

for (const size of process.argv[2] ? [process.argv[2]] : ['phone', 'desktop']) {
  const phone = size === 'phone';
  const newCtx = async () => {
    const ctx = await browser.newContext({ viewport: SIZES[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, timezoneId: TZ, locale: 'en-NZ' });
    await ctx.addInitScript(CLOCK);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()); });
    return { ctx, page, errors };
  };
  const open = async (page, where, customer = null) => {
    m.mockState.customer = customer;
    await page.goto('about:blank');
    await page.goto(`${BASE}${where}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForFunction(() => window.Lair && window.Lair.store && document.querySelector('lair-play')?.ready === true, null, { timeout: 20000 });
    await page.waitForTimeout(400);
  };
  /** A screenshot once the sheet has finished arriving, with what's being checked scrolled into view */
  const shot = async (page, name, sel = '') => {
    await page.waitForTimeout(700);
    if (sel) await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${OUT}/${size}-${name}.png` }).catch(() => {});
  };
  /** Wrap the demo backend so we see what each sign-up, game table and seat sends */
  const spy = (page) => page.evaluate(() => {
    const b = window.Lair.store.backend;
    window.__sent = [];
    for (const name of ['joinEvent', 'reserveEvent', 'joinGame', 'joinSeries']) {
      const orig = b[name].bind(b);
      b[name] = async (...args) => {
        window.__sent.push({ name, args: JSON.parse(JSON.stringify(args)) });
        return orig(...args);
      };
    }
  });

  for (const who of ['guest', 'member']) {
    const member = who === 'member';
    const customer = member ? RUBY : null;
    const tag = `${size} ${who}`;
    const { ctx, page, errors } = await newCtx();

    /* ---------- 1. a TTRPG seat more than 24 hours away (gm-games) ---------- */
    await open(page, '/pages/gm-games', customer);
    await spy(page);
    const T = await tab(page);
    const games = await page.evaluate(() => {
      const now = Date.now();
      const H = 3600000;
      const open = window.Lair.store.data.games.filter((g) => g.status === 'open' && g.start > now && (g.seats - g.taken) > 0);
      const far = open.filter((g) => g.start - now > 30 * H).sort((a, b) => a.start - b.start)[0];
      const near = open.filter((g) => g.start - now < 24 * H).sort((a, b) => a.start - b.start)[0];
      // tomorrow afternoon or evening (more than 24 hours away now, inside them later the same day)
      const tomorrow = open.filter((g) => g.start - now > 25 * H && g.start - now < 33 * H && g !== far).sort((a, b) => a.start - b.start)[0];
      const pick = (g) => (g ? { id: g.id, title: g.title, start: g.start, price: g.seatPrice, seriesId: g.seriesId || null } : null);
      return { far: pick(far), near: pick(near), tomorrow: pick(tomorrow), all: open.length };
    });
    check(`${tag}: there's a game more than 24 hours away to join`, Boolean(games.far), games);
    if (games.far) {
      await page.evaluate((id) => document.querySelector('gm-board').joiner.open(id), games.far.id);
      await page.waitForSelector('gm-board [data-sheet][open] [data-session-join]', { timeout: 8000 });
      const form = await page.evaluate(() => {
        const d = document.querySelector('gm-board [data-sheet][open]');
        const flatten = (x) => String(x || '').replace(/\s+/g, ' ').trim();
        return {
          lock: flatten(d.querySelector('[data-pay-session] .gm-join__lock')?.textContent),
          total: flatten(d.querySelector('[data-join-total]')?.textContent), button: flatten(d.querySelector('[data-join-submit]')?.textContent),
          text: flatten(d.textContent),
        };
      });
      check(`${tag}: the seat form says TAB.ahead() (it starts more than 24 hours away)`, form.lock === T.ahead, form);
      check(`${tag}: the total says ${member ? 'On your tab' : 'At the counter on the day'}; no code, no online`, form.total.startsWith(member ? 'On your tab' : 'At the counter on the day') && !/code|online|ring it up/i.test(form.text.replace(/we email you a code/i, '')), form);
      await shot(page, `${who}-1-seat-form`, 'gm-board [data-pay-session]');
      await scan(page, `${tag}: the seat form`, 'gm-board [data-sheet][open]');
      if (!member) {
        await page.fill('[data-session-join] [name="name"]', 'Jo Example');
        await page.fill('[data-session-join] [name="email"]', 'jo@example.com');
      }
      await page.fill('[data-session-join] [name="phone"]', '021 555 0102');
      await page.click('[data-join-submit]');
      await page.waitForSelector('gm-board .gm-done', { timeout: 8000 }).catch(() => {});
      const info = await sheetInfo(page, 'gm-board [data-sheet][open]');
      const sent = await page.evaluate(() => window.__sent.filter((s) => s.name === 'joinGame').pop());
      const ref = await page.evaluate(() => (window.Lair.store.data.bookings || []).slice(-1)[0]?.ref || '');
      const until = await page.evaluate((start) => window.Lair.TAB[window.Lair.store.cfg.customer ? 'cancelBy' : 'cancelByGuest'](start - window.Lair.refundHours() * 3600000), games.far.start);
      check(`${tag}: seat joined: confirmation, no QR or code anywhere`, Boolean(info && /You’re in/.test(info.text)) && info.qr === 0 && noCode(info, ref), { qr: info && info.qr, text: info && info.text.slice(0, 600), ref });
      const fee = member ? `${'$'}${(games.far.price ?? 1500) / 100} on your tab` : 'pay at the counter on the day';
      check(`${tag}: seat confirmation: what it costs (${fee}), ${member ? 'TAB.onTab' : 'TAB.onTabGuest'}, then the cancel-by line`, info.text.includes(member ? 'on your tab' : ', pay at the counter on the day') && info.text.includes(member ? T.onTab : T.onTabGuest) && info.text.includes(until), { until, text: info.text.slice(0, 900) });
      check(`${tag}: seat confirmation: the order is fee, how it's paid, then cancelling`, info.text.indexOf('Seat fee') < info.text.indexOf(member ? T.onTab : T.onTabGuest) && info.text.indexOf(member ? T.onTab : T.onTabGuest) < info.text.indexOf(until), info.text.slice(0, 900));
      const ics = info.icsLinks[0];
      check(`${tag}: seat confirmation: Add to calendar (a .ics named for the game and day), its description has no code`, Boolean(ics) && /^dice-goblin-.*-\d{4}-\d{2}-\d{2}\.ics$/.test(ics.name) && !/\bcode\b/i.test(ics.text) && !(ref && ics.text.includes(ref)) && /Just give your name/.test(ics.text), ics);
      const lairLink = info.links.find((l) => /See your tab in My Lair/.test(l.text));
      const account = info.links.find((l) => /Create a free account/.test(l.text));
      check(`${tag}: seat confirmation: ${member ? '"See your tab in My Lair" to data-my-lair' : '"Create a free account"'}`, member ? Boolean(lairLink) && lairLink.href === '/pages/my-lair' : Boolean(account) && !lairLink, info.links);
      check(`${tag}: the seat was sent with no pay 'now'`, sent && !('pay' in sent.args[0] && sent.args[0].pay === 'now'), sent);
      await shot(page, `${who}-2-seat-done`);
      await scan(page, `${tag}: the seat confirmation`, 'gm-board [data-sheet][open]');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      /* ---------- 2. their own seat (members): on their tab, Give up, Cancel by ---------- */
      if (member) {
        await page.evaluate((id) => document.querySelector('gm-board').openGame(id), games.far.id);
        await page.waitForSelector('gm-board .gm-you', { timeout: 8000 }).catch(() => {});
        const you = await page.evaluate(() => {
          const s = document.querySelector('gm-board .gm-you');
          const flatten = (x) => String(x || '').replace(/\s+/g, ' ').trim();
          return s ? { text: flatten(s.textContent), give: Boolean(s.querySelector('[data-skip]')), until: flatten(s.querySelector('.gm-you__until')?.textContent), described: s.querySelector('[data-skip]')?.getAttribute('aria-describedby'), locked: Boolean(s.querySelector('.gm-you__locked')), qr: s.querySelectorAll('svg.qr, .gm-qr').length } : null;
        });
        const cancelUntil = await page.evaluate((start) => window.Lair.TAB.cancelUntil(start - window.Lair.refundHours() * 3600000), games.far.start);
        check(`${tag}: their own seat: on their tab, no QR, Give up my seat with "${cancelUntil}" beside it`, you && /on your tab/.test(you.text) && you.qr === 0 && you.give && you.until === cancelUntil && you.described === 'gm-you-until' && !you.locked && !/code|ticket/i.test(you.text), you);
        const foot = await page.evaluate(() => document.querySelector('gm-board [data-sheet-foot]')?.textContent.trim());
        check(`${tag}: the game's foot says "You’re in: see my seat"`, /You’re in: see my seat/.test(foot || ''), foot);
        await shot(page, `${who}-3-own-seat`, 'gm-board .gm-you');
        await scan(page, `${tag}: the game with their own seat`, 'gm-board [data-sheet][open]');
        // Give it up: the confirm, then gone
        await page.click('gm-board [data-skip]');
        await page.waitForSelector('gm-board [data-skip-do]', { timeout: 5000 });
        const ask = flat(await page.evaluate(() => document.querySelector('gm-board .gm-confirm')?.textContent));
        check(`${tag}: Give up my seat asks first, with no refund words (nothing paid online)`, /Give up your (1 )?seat\?/.test(ask) && !/refund/i.test(ask), ask);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    }

    /* ---------- 3. a TTRPG seat inside 24 hours: TAB.soon(), locked at once ---------- */
    if (games.near) {
      await page.evaluate((id) => document.querySelector('gm-board').joiner.open(id), games.near.id);
      await page.waitForSelector('gm-board [data-sheet][open] [data-session-join]', { timeout: 8000 });
      const lock = flat(await page.evaluate(() => document.querySelector('gm-board [data-pay-session] .gm-join__lock')?.textContent));
      check(`${tag}: a session inside 24 hours: the form says TAB.soon()`, lock === T.soon, lock);
      if (!member) {
        await page.fill('[data-session-join] [name="name"]', 'Jo Example');
        await page.fill('[data-session-join] [name="email"]', 'jo2@example.com');
      }
      await page.fill('[data-session-join] [name="phone"]', '021 555 0102');
      await page.click('[data-join-submit]');
      await page.waitForSelector('gm-board .gm-done', { timeout: 8000 }).catch(() => {});
      const info = await sheetInfo(page, 'gm-board [data-sheet][open]');
      check(`${tag}: joined inside 24 hours: the confirmation says TAB.lockedNow()`, info && info.text.includes(T.lockedNow) && info.qr === 0, info && info.text.slice(0, 700));
      await shot(page, `${who}-4-seat-locked-done`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      if (member) {
        await page.evaluate((id) => document.querySelector('gm-board').openGame(id), games.near.id);
        await page.waitForSelector('gm-board .gm-you', { timeout: 8000 }).catch(() => {});
        const you = await page.evaluate(() => {
          const s = document.querySelector('gm-board .gm-you');
          const flatten = (x) => String(x || '').replace(/\s+/g, ' ').trim();
          return s ? { text: flatten(s.textContent), give: Boolean(s.querySelector('[data-skip]')), locked: flatten(s.querySelector('.gm-you__locked')?.textContent) } : null;
        });
        check(`${tag}: their own seat inside 24 hours: no Give up; TAB.lockedLabel and TAB.lockedHint() instead`, you && !you.give && you.locked.includes(T.lockedLabel) && you.locked.includes(T.lockedHint), you);
        await shot(page, `${who}-5-own-seat-locked`, 'gm-board .gm-you');
        await scan(page, `${tag}: their own locked seat`, 'gm-board [data-sheet][open]');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    } else console.log(`NOTE ${tag}: no open game with seats inside 24 hours in this demo (the clock move below covers a locked seat)`);

    /* ---------- 3b. a seat of theirs tonight (the demo's own): locked in ---------- */
    if (member) {
      const seat = await page.evaluate(() => {
        const board = document.querySelector('gm-board');
        const s = board.seats.find((x) => x.locked && x.start > Date.now() && ['confirmed', 'held'].includes(x.status));
        return s ? { gameId: s.gameId, start: s.start } : null;
      });
      if (seat) {
        await page.evaluate((id) => document.querySelector('gm-board').openGame(id), seat.gameId);
        await page.waitForSelector('gm-board .gm-you', { timeout: 8000 }).catch(() => {});
        const you = await page.evaluate(() => {
          const s = document.querySelector('gm-board .gm-you');
          const flatten = (x) => String(x || '').replace(/\s+/g, ' ').trim();
          return s ? { text: flatten(s.textContent), skip: Boolean(s.querySelector('[data-skip]')), leave: Boolean(s.querySelector('[data-leave]')), locked: flatten(s.querySelector('.gm-you__locked')?.textContent), qr: s.querySelectorAll('svg.qr, .gm-qr').length } : null;
        });
        check(`${tag}: their seat tonight: no Give up; locked in words; no QR, card or code`, you && !you.skip && you.locked.includes(T.lockedLabel) && you.locked.includes(T.lockedHint) && you.qr === 0 && !/Goblin card|ticket|code/i.test(you.text), you);
        await shot(page, `${who}-5b-regular-seat-locked`, 'gm-board .gm-you');
        await scan(page, `${tag}: a regular's locked seat`, 'gm-board [data-sheet][open]');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      } else console.log(`NOTE ${tag}: no locked seat in the demo to look at`);
    }

    /* ---------- 3c. the weekly game they're a regular at (the demo makes Ruby one) ---------- */
    if (member) {
      const reg = await page.evaluate(() => {
        const board = document.querySelector('gm-board');
        const now = Date.now();
        for (const mem of board.series) {
          const g = window.Lair.store.data.games.filter((x) => x.seriesId === mem.seriesId && x.end > now && board.seatIn(x)).sort((a, b) => a.start - b.start)[0];
          if (g) return { id: g.id, seriesId: mem.seriesId, start: g.start };
        }
        return null;
      });
      if (reg) {
        await page.evaluate((id) => document.querySelector('gm-board').openGame(id), reg.id);
        await page.waitForSelector('gm-board .gm-you--series', { timeout: 8000 }).catch(() => {});
        const you = await page.evaluate(() => {
          const s = document.querySelector('gm-board .gm-you--series');
          const flatten = (x) => String(x || '').replace(/\s+/g, ' ').trim();
          return s ? { text: flatten(s.textContent), skip: flatten(s.querySelector('[data-skip]')?.textContent), until: flatten(s.querySelector('.gm-you__until')?.textContent), leave: Boolean(s.querySelector('[data-leave]')), owed: flatten(s.querySelector('.gm-note--owed')?.textContent) } : null;
        });
        const cu = await page.evaluate((start) => window.Lair.TAB.cancelUntil(start - window.Lair.refundHours() * 3600000), reg.start);
        check(`${tag}: the regular's panel: on your tab each week, Skip with "${cu}", Stop saving my seat, no card or code`, you && /on your tab each (week|fortnight|session)/.test(you.text) && /^Skip/.test(you.skip) && you.until === cu && you.leave && !/Goblin card|ticket|code/i.test(you.text) && (!you.owed || /It stays on your tab/.test(you.owed)), you);
        await shot(page, `${who}-5c-regular-panel`, 'gm-board .gm-you');
        await scan(page, `${tag}: the regular's panel`, 'gm-board [data-sheet][open]');
        // Stop saving my seat, with the next seat locked in: it says that seat stays on their tab
        const leave = await page.evaluate(async (r) => {
          const board = document.querySelector('gm-board');
          board.seats = board.seats.map((x) => (x.gameId === r.id ? { ...x, locked: true } : x));
          board.askLeave(r.seriesId);
          await new Promise((res) => setTimeout(res, 200));
          return (document.querySelector('gm-board .gm-confirm')?.textContent || '').replace(/\s+/g, ' ').trim();
        }, reg);
        check(`${tag}: Stop saving my seat, the next seat locked in: it says it stays on their tab (TAB.lockedHint())`, /stays on your tab\./.test(leave) && leave.includes(T.lockedHint) && !/frees up your seat on/.test(leave), leave);
        await shot(page, `${who}-5d-leave-kept`, 'gm-board .gm-confirm');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      } else console.log(`NOTE ${tag}: no weekly game they're a regular at in this demo`);
    }

    /* ---------- 4. events: a paid sign-up (Pokémon: 'Online or in store'), one inside 24 hours, a free one ---------- */
    await open(page, '/pages/events-calendar', customer);
    await spy(page);
    const ev = await page.evaluate(() => {
      const cal = document.querySelector('lair-calendar');
      const now = Date.now();
      const all = cal.all().filter((i) => i.kind === 'event' && i.end > now);
      const pick = (i) => (i ? { id: i.id, title: i.title, start: i.start, fee: i.entryFee, payment: i.payment } : null);
      return {
        poke: pick(all.find((i) => /Pokémon/.test(i.title) && i.capacity && i.start - now > 30 * 3600000)),
        champ: pick(all.find((i) => /championship/i.test(i.title))),
        tonight: pick(all.find((i) => i.id.startsWith('dnd-tonight') || (/Dungeons/.test(i.title) && !i.repeat && i.start - now < 24 * 3600000 && i.start > now))),
        free: pick(all.find((i) => i.capacity && !i.entryFee && !i.gameTables && !i.product && i.start > now)),
        war: pick(all.find((i) => i.gameTables && i.start - now > 30 * 3600000)),
      };
    });
    check(`${tag}: events to sign up for (paid, tonight, free, a game table night)`, ev.poke && ev.tonight && ev.free && ev.war, ev);
    // The details: no online wording anywhere on the paid ones
    for (const k of ['poke', 'champ']) {
      if (!ev[k]) continue;
      await page.evaluate((id) => document.querySelector('lair-calendar').openItem(id), ev[k].id);
      await page.waitForTimeout(200);
      const d = await sheetInfo(page, 'lair-calendar [data-dialog]');
      const blurbless = d.text.replace(/Entry is paid online when you join, and that locks in your place\./, '');
      check(`${tag}: ${ev[k].title}'s details: paid ${member ? 'on your tab' : 'at the counter on the day'}, never online (payment was ${ev[k].payment})`, !/online/i.test(blurbless) && (member ? /On your tab/.test(d.text) : /Pay at the counter on the day/.test(d.text)) && d.buttons.some((b) => (member ? /Join · \$\d+ on your tab/ : /Join · \$\d+ at the counter/).test(b)), { text: d.text.slice(0, 600), buttons: d.buttons });
    }
    if (ev.poke) {
      await page.evaluate((id) => document.querySelector('lair-calendar').openJoin(id), ev.poke.id);
      await page.waitForSelector('lair-calendar [data-join-form]', { timeout: 8000 });
      const form = await sheetInfo(page, 'lair-calendar [data-dialog]');
      const fp = await page.evaluate(() => ({
        how: document.querySelector('lair-calendar .cal-pay__how')?.textContent.replace(/\s+/g, ' ').trim(),
        total: document.querySelector('lair-calendar [data-total]')?.textContent.replace(/\s+/g, ' ').trim(),
        submit: document.querySelector('lair-calendar [form="cal-join-form"][type="submit"]')?.textContent.trim(),
      }));
      check(`${tag}: Pokémon's sign-up form: TAB.ahead(), no Pay online (it was "Online or in store"), ${member ? 'on your tab' : 'at the counter on the day'}`, fp.how === T.ahead && form.payNow === 0 && !/online|code|ring it up/i.test(form.text) && fp.total.startsWith(member ? 'On your tab' : 'At the counter on the day') && fp.submit === `Join · $10 ${member ? 'on your tab' : 'at the counter'}`, { fp, text: form.text.slice(0, 500) });
      await shot(page, `${who}-6-event-form`, 'lair-calendar .cal-pay');
      await scan(page, `${tag}: the sign-up form`, 'lair-calendar [data-dialog]');
      if (!member) {
        await page.fill('[data-join-form] [name="name"]', 'Mere Example');
        await page.fill('[data-join-form] [name="email"]', 'mere@example.com');
      }
      await page.fill('[data-join-form] [name="phone"]', '021 555 0104');
      await page.click('[data-guest-add]');
      await page.fill('[data-guest] [name="guestName"]', 'Jo Bloggs');
      await page.click('button[form="cal-join-form"]');
      await page.waitForSelector('lair-calendar .cal-done', { timeout: 8000 }).catch(() => {});
      const info = await sheetInfo(page, 'lair-calendar [data-dialog]');
      const sent = await page.evaluate(() => window.__sent.filter((s) => s.name === 'joinEvent').pop());
      const ref = await page.evaluate(() => (window.Lair.store.data.joins || []).slice(-1)[0]?.ref || '');
      const until = await page.evaluate((start) => window.Lair.TAB[window.Lair.store.cfg.customer ? 'cancelBy' : 'cancelByGuest'](start - window.Lair.refundHours() * 3600000), ev.poke.start);
      check(`${tag}: Pokémon sign-up sent pay 'day', never 'now'`, sent && sent.args[1].pay === 'day', sent);
      check(`${tag}: sign-up confirmation: See you there!, no QR, no code, Jo Bloggs coming`, info.title === 'See you there!' && info.qr === 0 && noCode(info, ref) && /Jo Bloggs/.test(info.text), { title: info.title, qr: info.qr, ref, text: info.text.slice(0, 500) });
      check(`${tag}: sign-up confirmation: "$20 ${member ? 'on your tab' : ', pay at the counter on the day'}", ${member ? 'TAB.onTab' : 'TAB.onTabGuest'}, then the cancel-by line`, info.text.includes(member ? '$20 on your tab' : '$20, pay at the counter on the day') && info.text.includes(member ? T.onTab : T.onTabGuest) && info.text.includes(until), { until, text: info.text.slice(0, 900) });
      const cal = info.icsLinks[0];
      check(`${tag}: sign-up confirmation: Add to calendar's file says what's to pay, no code`, Boolean(cal) && !/\bcode\b/i.test(cal.text) && !(ref && cal.text.includes(ref)) && /pay|tab/i.test(cal.text) && info.google.every((g) => !/\bcode\b/i.test(g)), cal);
      check(`${tag}: sign-up confirmation: ${member ? '"See your tab in My Lair"' : '"Create a free account"'}`, member ? info.links.some((l) => /See your tab in My Lair/.test(l.text) && l.href === '/pages/my-lair') : info.links.some((l) => /Create a free account/.test(l.text)), info.links);
      await shot(page, `${who}-7-event-done`);
      await scan(page, `${tag}: the sign-up confirmation`, 'lair-calendar [data-dialog]');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      if (member) {
        await page.evaluate((id) => document.querySelector('lair-calendar').openItem(id), ev.poke.id);
        await page.waitForSelector('lair-calendar .cal-you', { timeout: 8000 }).catch(() => {});
        const you = await page.evaluate(() => {
          const s = document.querySelector('lair-calendar .cal-you');
          const flatten = (x) => String(x || '').replace(/\s+/g, ' ').trim();
          return s ? { text: flatten(s.textContent), cancel: Boolean(s.querySelector('[data-cancel-mine]')), until: flatten(s.querySelector('.cal-you__until')?.textContent), locked: Boolean(s.querySelector('.cal-you__locked')), qr: s.querySelectorAll('svg.qr, .ticket-code').length, foot: flatten(document.querySelector('lair-calendar [data-dialog-foot]')?.textContent) } : null;
        });
        const cu = await page.evaluate((start) => window.Lair.TAB.cancelUntil(start - window.Lair.refundHours() * 3600000), ev.poke.start);
        check(`${tag}: their own sign-up: On your tab, no QR or code, Cancel my spot with "${cu}"; the foot says "see my spot"`, you && /\$20 On your tab/.test(you.text) && you.qr === 0 && you.cancel && you.until === cu && !you.locked && !/code|ticket/i.test(you.text) && /You’re in: see my spot/.test(you.foot), you);
        await shot(page, `${who}-8-own-signup`, 'lair-calendar .cal-you');
        await scan(page, `${tag}: the event with their own sign-up`, 'lair-calendar [data-dialog]');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    }
    // inside 24 hours: TAB.soon() on the form, TAB.lockedNow() on the confirmation, locked on their own panel
    if (ev.tonight) {
      await page.evaluate((id) => document.querySelector('lair-calendar').openJoin(id), ev.tonight.id);
      await page.waitForSelector('lair-calendar [data-join-form]', { timeout: 8000 });
      const how = flat(await page.evaluate(() => document.querySelector('lair-calendar .cal-pay__how')?.textContent));
      check(`${tag}: tonight's sign-up form says TAB.soon()`, how === T.soon, how);
      if (!member) {
        await page.fill('[data-join-form] [name="name"]', 'Mere Example');
        await page.fill('[data-join-form] [name="email"]', 'mere2@example.com');
      }
      await page.fill('[data-join-form] [name="phone"]', '021 555 0104');
      await page.click('button[form="cal-join-form"]');
      await page.waitForSelector('lair-calendar .cal-done', { timeout: 8000 }).catch(() => {});
      const info = await sheetInfo(page, 'lair-calendar [data-dialog]');
      check(`${tag}: tonight's confirmation says TAB.lockedNow()`, info.text.includes(T.lockedNow), info.text.slice(0, 700));
      await shot(page, `${who}-9-tonight-done`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      if (member) {
        await page.evaluate((id) => document.querySelector('lair-calendar').openItem(id), ev.tonight.id);
        await page.waitForSelector('lair-calendar .cal-you', { timeout: 8000 }).catch(() => {});
        const you = await page.evaluate(() => {
          const s = document.querySelector('lair-calendar .cal-you');
          const flatten = (x) => String(x || '').replace(/\s+/g, ' ').trim();
          return s ? { text: flatten(s.textContent), cancel: Boolean(s.querySelector('[data-cancel-mine]')), locked: flatten(s.querySelector('.cal-you__locked')?.textContent) } : null;
        });
        check(`${tag}: their own sign-up tonight: no Cancel; TAB.lockedLabel and TAB.lockedHint() instead`, you && !you.cancel && you.locked.includes(T.lockedLabel) && you.locked.includes(T.lockedHint), you);
        await shot(page, `${who}-10-own-signup-locked`, 'lair-calendar .cal-you');
        await scan(page, `${tag}: their own locked sign-up`, 'lair-calendar [data-dialog]');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    }
    // a free sign-up
    if (ev.free) {
      await page.evaluate((id) => document.querySelector('lair-calendar').openJoin(id), ev.free.id);
      await page.waitForSelector('lair-calendar [data-join-form]', { timeout: 8000 });
      const formText = flat(await page.evaluate(() => document.querySelector('lair-calendar [data-dialog]')?.textContent));
      check(`${tag}: a free sign-up's form says nothing about paying or the tab`, !/tab|pay|code/i.test(formText.replace(/your tab in My Lair/g, '')), formText.slice(0, 400));
      if (!member) {
        await page.fill('[data-join-form] [name="name"]', 'Mere Example');
        await page.fill('[data-join-form] [name="email"]', 'mere3@example.com');
      }
      await page.fill('[data-join-form] [name="phone"]', '021 555 0104');
      await page.click('button[form="cal-join-form"]');
      await page.waitForSelector('lair-calendar .cal-done', { timeout: 8000 }).catch(() => {});
      const info = await sheetInfo(page, 'lair-calendar [data-dialog]');
      const freeCancel = member ? 'Can’t make it? Cancel in My Lair, so someone else can have your spot.' : 'Can’t make it? Let us know, so someone else can have your spot.';
      check(`${tag}: free sign-up confirmation: TAB.nothingToPay, then "${freeCancel}"`, info.text.includes(T.nothingToPay) && info.text.includes(freeCancel) && info.qr === 0 && !/on your tab,|pay at the counter on the day/.test(info.text), info.text.slice(0, 700));
      await shot(page, `${who}-11-free-done`);
      await scan(page, `${tag}: the free sign-up confirmation`, 'lair-calendar [data-dialog]');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      if (member) {
        await page.evaluate((id) => document.querySelector('lair-calendar').openItem(id), ev.free.id);
        await page.waitForSelector('lair-calendar .cal-you', { timeout: 8000 }).catch(() => {});
        const you = await page.evaluate(() => {
          const s = document.querySelector('lair-calendar .cal-you');
          const flatten = (x) => String(x || '').replace(/\s+/g, ' ').trim();
          return s ? { text: flatten(s.textContent), cancel: Boolean(s.querySelector('[data-cancel-mine]')), until: flatten(s.querySelector('.cal-you__until')?.textContent) } : null;
        });
        const cu = await page.evaluate((start) => window.Lair.TAB.cancelUntil(start), ev.free.start);
        check(`${tag}: their own free sign-up: TAB.nothingToPay, Cancel until it starts ("${cu}")`, you && you.text.includes(T.nothingToPay) && you.cancel && you.until === cu, you);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    }

    /* ---------- 5. a game table (Warhammer) ---------- */
    if (ev.war) {
      await page.evaluate((id) => document.querySelector('lair-calendar').openReserve(id), ev.war.id);
      await page.waitForSelector('lair-calendar [data-reserve-form]', { timeout: 8000 });
      const form = await page.evaluate(() => {
        const d = document.querySelector('lair-calendar [data-dialog]');
        const flatten = (x) => String(x || '').replace(/\s+/g, ' ').trim();
        return { how: flatten(d.querySelector('.cal-pay__how')?.textContent), total: flatten(d.querySelector('[data-total]')?.textContent), options: [...d.querySelectorAll('[name="pay"]')].map((r) => r.value), text: flatten(d.textContent) };
      });
      check(`${tag}: the game table form: TAB.ahead(), no online, ${member ? 'pass options with Put it on my tab' : 'no pay choices'}`, form.how === T.ahead && !form.options.includes('now') && !/online|ring it up|booking code/i.test(form.text) && (member ? form.options[0] === 'day' && /Put it on my tab/.test(form.text) : !form.options.length), form);
      await shot(page, `${who}-12-table-form`, 'lair-calendar .cal-pay');
      await scan(page, `${tag}: the game table form`, 'lair-calendar [data-dialog]');
      if (!member) {
        await page.fill('[data-reserve-form] [name="name"]', 'Tama Example');
        await page.fill('[data-reserve-form] [name="email"]', 'tama@example.com');
      }
      await page.fill('[data-reserve-form] [name="phone"]', '021 555 0105');
      await page.fill('[data-reserve-form] [name="player"]', 'kiri@example.com');
      await page.click('button[form="cal-reserve-form"]');
      await page.waitForSelector('lair-calendar .cal-done', { timeout: 8000 }).catch(() => {});
      const info = await sheetInfo(page, 'lair-calendar [data-dialog]');
      const ref = await page.evaluate(() => (window.Lair.store.data.bookings || []).slice(-1)[0]?.ref || '');
      check(`${tag}: game table confirmation: Your game table, no QR, no code; each pays their own, the others give your name or show their Goblin card`, info.title === 'Your game table' && info.qr === 0 && noCode(info, ref) && /The others give your name when they arrive, or show their Goblin card from My Lair\./.test(info.text) && !/booking code|this code/i.test(info.text), { title: info.title, ref, text: info.text.slice(0, 900) });
      check(`${tag}: game table confirmation: ${member ? 'TAB.onTab' : 'TAB.onTabGuest'} and the cancel-by line`, info.text.includes(member ? T.onTab : T.onTabGuest) && /Can’t make it\? (Cancel in My Lair|Let us know) by /.test(info.text), info.text.slice(0, 900));
      await shot(page, `${who}-13-table-done`);
      await scan(page, `${tag}: the game table confirmation`, 'lair-calendar [data-dialog]');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      if (member) {
        await page.evaluate((id) => document.querySelector('lair-calendar').openItem(id), ev.war.id);
        await page.waitForSelector('lair-calendar .cal-you', { timeout: 8000 }).catch(() => {});
        const you = await page.evaluate(() => {
          const s = document.querySelector('lair-calendar .cal-you');
          const flatten = (x) => String(x || '').replace(/\s+/g, ' ').trim();
          return s ? { text: flatten(s.textContent), cancel: flatten(s.querySelector('[data-cancel-mine]')?.textContent), until: flatten(s.querySelector('.cal-you__until')?.textContent), foot: flatten(document.querySelector('lair-calendar [data-dialog-foot]')?.textContent) } : null;
        });
        check(`${tag}: their own game table: On your tab, Cancel my table with Cancel by, the foot "Your game table: see it"`, you && /On your tab/.test(you.text) && you.cancel === 'Cancel my table' && /^Cancel by /.test(you.until) && /Your game table: see it/.test(you.foot) && !/code/i.test(you.text), you);
        await shot(page, `${who}-14-own-table`, 'lair-calendar .cal-you');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    }

    /* ---------- 6. the clock moved inside 24 hours (same demo day): their own seat and sign-up lock ---------- */
    if (member) {
      const later = await page.evaluate(() => {
        const cal = document.querySelector('lair-calendar');
        const me = cal.mine;
        const now = Date.now();
        const H = 3600000;
        // the Pokémon sign-up (Friday): too far; use the seat or sign-up that starts tomorrow, if any; else none
        const all = [...(me.joins || []).map((j) => ({ kind: 'join', id: j.id, start: Number(j.start), occ: j.occurrenceId })), ...(me.seats || []).map((s) => ({ kind: 'seat', id: s.id, start: Number(s.start), gameId: s.gameId }))]
          .filter((x) => x.start - now > 24 * H && x.start - now < 46 * H);
        return all;
      });
      // book a game for tomorrow if there's one, so there's something to lock today
      if (games.tomorrow && !later.length) {
        await open(page, '/pages/gm-games', customer);
        await page.evaluate((id) => document.querySelector('gm-board').joiner.open(id), games.tomorrow.id);
        await page.waitForSelector('gm-board [data-sheet][open] [data-session-join]', { timeout: 8000 });
        await page.fill('[data-session-join] [name="phone"]', '021 555 0102');
        await page.click('[data-join-submit]');
        await page.waitForSelector('gm-board .gm-done', { timeout: 8000 }).catch(() => {});
      }
      const target = games.tomorrow;
      if (target) {
        const moveTo = target.start - 22 * 3600000;
        const sameDay = lairKey(moveTo) === today;
        await page.evaluate((at) => sessionStorage.setItem('qa-at', String(at)), moveTo);
        m.mockState.customer = customer;
        await page.goto(`${BASE}/pages/gm-games#game=${encodeURIComponent(target.id)}`, { waitUntil: 'networkidle', timeout: 60000 });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForFunction(() => document.querySelector('lair-play')?.ready === true, null, { timeout: 20000 });
        await page.waitForTimeout(800);
        const clock = await page.evaluate(() => new Date().toString());
        console.log(`NOTE ${tag}: the page clock is now ${clock}`);
        await page.evaluate((id) => document.querySelector('gm-board').openGame(id), target.id);
        await page.waitForTimeout(800);
        await page.waitForSelector('gm-board .gm-you', { timeout: 8000 }).catch(() => {});
        const you = await page.evaluate(() => {
          const s = document.querySelector('gm-board .gm-you');
          const flatten = (x) => String(x || '').replace(/\s+/g, ' ').trim();
          return s ? { text: flatten(s.textContent), give: Boolean(s.querySelector('[data-skip]')), locked: flatten(s.querySelector('.gm-you__locked')?.textContent) } : null;
        });
        check(`${tag}: clock moved to 22 hours before tomorrow's game (same day: ${sameDay}): their seat is locked in (no Give up; TAB.lockedLabel, TAB.lockedHint())`, sameDay && you && !you.give && you.locked.includes(T.lockedLabel) && you.locked.includes(T.lockedHint), you);
        await shot(page, `${who}-15-moved-clock-locked`, 'gm-board .gm-you');
        // the events calendar's sheet for the same session says it's locked in too
        await page.goto(`${BASE}/pages/events-calendar`, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForFunction(() => document.querySelector('lair-play')?.ready === true, null, { timeout: 20000 });
        await page.waitForTimeout(800);
        await page.evaluate((id) => document.querySelector('lair-calendar').openItem(`game:${id}`), target.id);
        await page.waitForSelector('lair-calendar .cal-you', { timeout: 8000 }).catch(() => {});
        const calYou = await page.evaluate(() => {
          const s = document.querySelector('lair-calendar .cal-you');
          const flatten = (x) => String(x || '').replace(/\s+/g, ' ').trim();
          return s ? { text: flatten(s.textContent), manage: Boolean([...s.querySelectorAll('a')].find((a) => /Manage my seat/.test(a.textContent))), locked: flatten(s.querySelector('.cal-you__locked')?.textContent) } : null;
        });
        check(`${tag}: the calendar's sheet for that session: locked in, no Manage my seat`, calYou && !calYou.manage && calYou.locked.includes(T.lockedLabel), calYou);
        await shot(page, `${who}-15b-moved-clock-calendar`, 'lair-calendar .cal-you');
        await scan(page, `${tag}: the calendar's sheet with a locked seat`, 'lair-calendar [data-dialog]');
        await page.keyboard.press('Escape');
        await page.evaluate(() => sessionStorage.removeItem('qa-at'));
      } else check(`${tag}: a game tomorrow to lock by moving the clock`, false, games);
    }

    /* ---------- 7. the one booking page (book-a-table): the board's and the calendar's sheets ---------- */
    await open(page, '/pages/book-a-table?show=events,ttrpg,tables', customer);
    const boardLock = await page.evaluate(async () => {
      const now = Date.now();
      const g = window.Lair.store.data.games.filter((x) => x.status === 'open' && x.start - now > 30 * 3600000 && x.seats - x.taken > 0)[0];
      if (!g) return 'no game with seats';
      await document.querySelector('gm-board').joiner.open(g.id);
      await new Promise((r) => setTimeout(r, 400));
      const lock = document.querySelector('gm-board [data-sheet][open] .gm-join__lock');
      return lock ? lock.textContent.replace(/\s+/g, ' ').trim() : '';
    });
    check(`${tag}: the one booking page: the board's join form, with its lock line`, boardLock === T.ahead, boardLock);
    await shot(page, `${who}-16-book-a-table-form`, 'gm-board [data-pay-session]');
    await scan(page, `${tag}: the one booking page's join form`, 'gm-board [data-sheet][open]');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.evaluate((id) => document.querySelector('lair-calendar').openItem(id), ev.poke && ev.poke.id);
    await page.waitForTimeout(400);
    const calInfo = await sheetInfo(page, 'lair-calendar [data-dialog]');
    check(`${tag}: the one booking page: the calendar's event sheet, ${member ? 'their own sign-up on their tab' : 'Join at the counter'}, no code, no online`, calInfo && calInfo.open && !/\bcode\b|online/i.test(calInfo.text) && (member ? /On your tab/.test(calInfo.text) : calInfo.buttons.some((b) => /Join · \$10 at the counter/.test(b))), calInfo && { text: calInfo.text.slice(0, 500), buttons: calInfo.buttons });
    await shot(page, `${who}-17-book-a-table-event`, 'lair-calendar .cal-you, lair-calendar .cal-sheet__foot');
    await scan(page, `${tag}: the one booking page's event sheet`, 'lair-calendar [data-dialog]');
    await page.keyboard.press('Escape');
    check(`${tag}: no console errors`, !errors.length, errors);
    await ctx.close();
  }
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed, ${axeTotal} axe violations`);
if (fails.length) console.log(`FAILED:\n- ${fails.join('\n- ')}`);

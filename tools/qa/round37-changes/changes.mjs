// Round 37 (14 Nov 2026, contract v37-changes), on the theme mock (demo mode). Mo: a customer dropped from 9 players to
// 6, three days early, "but wasn't given an option other than cancelling"; and GMs cancel their own games "so long as
// they are before the 24 hour period" and "change the time and date", for that session or every later one.
//  A. My Lair, Ruby's table for nine on three tables (the demo makes one, three days out):
//     1. its ticket has Change numbers beside Add to calendar, and "Change or cancel by …" beside Cancel booking;
//     2. the dialog: 9, nothing to save yet; down to 6: $60 (it was $90), one table goes back (the last unless she
//        picks), she picks T4, Update booking: the notice says so, the ticket and the demo follow, T4 is free again;
//     3. up to every seat at the two tables she kept, and no further (the + stops, and says why);
//     4. tomorrow's table at 7:30pm is inside 24 hours: no Change numbers, and it says Locked in;
//     5. it passes its moment while the dialog is open: the Lair app's words, and the ticket shows it locked after.
//  B. My Lair, Rangi's Games I run (a GM; the demo gives his weekly game four sessions):
//     1. the game has Change date or time (to the board, ?move=1#game=…), Open game, Cancel this session, Cancel all
//        future sessions and "Change or cancel by …";
//     2. Cancel this session asks first (who has a seat, who hears, no undo), then says who was emailed; the next
//        session is the card's;
//     3. a session less than 24 hours away: a note in place of the buttons; Cancel all future sessions says before
//        and after that it stays on.
//  C. The games board, as Rangi:
//     1. My Lair's link opens the game's Change date or time, and ?move leaves the address;
//     2. a weekly game asks Which sessions?, the picker starts where the session is, today is too soon;
//     3. nothing changed: says so; the next day, just this session: the flash, the game's facts, the other sessions
//        where they were, and each player has a day to drop out;
//     4. This and every later session: the button says so, and every later session moves by the same days;
//     5. a one-shot has no Which sessions?;
//     6. his own game says Cancel up to 24 hours before; one that's closer has a note and no buttons;
//     7. a Lair app from before round 37 (no features.changes): no Change date or time.
//  D. Staff on the board: Change date or time on a session that's hours away, and "Staff can cancel … until it ends".
// No sideways scroll, no console errors, and axe on each new part. 320, 390 and 1280 wide.
// Usage: DG_THEME=/path/to/theme [PORT=4937] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round37-changes/changes.mjs [small|phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round37-changes');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, overflowX, axe, shot, watch, go, clockAt, RUBY, STAFF, flat } = lib;
const PORT = Number(process.env.PORT || 4937);
const BASE = `http://localhost:${PORT}`;
const VIEWPORTS = { small: { width: 320, height: 640 }, phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const sizes = process.argv[2] ? [process.argv[2]] : ['small', 'phone', 'desktop'];
const RANGI = { id: 7700990011, first_name: 'Rangi', last_name: 'Hohaia', name: 'Rangi Hohaia', email: 'rangi@example.com', phone: null, tags: ['gm'], store_credit_account: { balance: 0 }, orders_count: 0, orders: [] };
const HOUR = 3600000;

const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 400) => page.waitForTimeout(ms);

async function context(size, hm = '13:00') {
  const phone = size !== 'desktop';
  const ctx = await browser.newContext({ viewport: VIEWPORTS[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(clockAt(hm));
  return ctx;
}
async function fresh(ctx) {
  const page = watch(await ctx.newPage());
  await page.goto(BASE);
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* a fresh demo */ } });
  return page;
}
async function myLair(page, who, where = '/pages/my-lair#bookings') {
  await go(page, BASE, where, who);
  await page.waitForSelector('[data-stamp-count] strong', { state: 'attached', timeout: 20000 });
  await settle(page, 700);
  // later bookings are rows that open to their ticket: open them all, so every ticket can be read and tapped
  await page.evaluate(() => document.querySelectorAll('details.ml-later').forEach((d) => { d.open = true; }));
  await settle(page, 150);
}
/** axe on a part of the page with the sticky site header and My Lair's bar unstuck (round 30's way) */
async function axeFree(page, label, sel) {
  const unstick = await page.addStyleTag({ content: '[id^="shopify-section-"]:has(> .site-header), my-lair .ml-bar { position: static !important; }' });
  await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel);
  await axe(page, label, sel);
  await unstick.evaluate((el) => el.remove());
}
/** The demo's own bookings and games, as it keeps them */
const demo = (page) => page.evaluate(() => {
  const be = window.Lair.store.backend;
  const id = String(window.Lair.store.cfg.customer.id);
  return {
    bookings: be.state.bookings.filter((b) => String(b.customerId || '') === id && b.kind === 'table').map((b) => ({ id: b.id, ref: b.ref, tables: b.tables, people: b.people, amount: b.amount, start: b.start, end: b.end, status: b.status, notes: b.notes || '' })),
    games: be.state.games.filter((g) => String(g.gmCustomerId || '') === id).sort((a, b) => a.start - b.start).map((g) => ({ id: g.id, title: g.title, start: g.start, end: g.end, tables: g.tables, status: g.status, seriesId: g.seriesId || null, schedule: g.schedule })),
  };
});
const dialogOf = (page) => page.evaluate(() => {
  const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const d = document.querySelector('[data-cancel-dialog]');
  const q = (s) => d.querySelector(s);
  const shown = (el) => Boolean(el) && !el.hidden && !el.closest('[hidden]');
  return {
    open: d.open, title: f(q('[data-cancel-title]')?.textContent), text: f(q('[data-cancel-body]')?.innerText),
    people: f(q('[data-change-people]')?.textContent), sum: f(q('[data-change-sum]')?.textContent),
    less: q('[data-change-step="-1"]')?.disabled, more: q('[data-change-step="1"]')?.disabled,
    limit: shown(q('[data-change-limit]')) ? f(q('[data-change-limit]').textContent) : '',
    tables: shown(q('[data-change-tables]')) ? { legend: f(q('[data-change-legend]').textContent), hint: f(q('[data-change-hint]').textContent), chips: [...d.querySelectorAll('[data-change-table]')].map((c) => `${c.value}${c.checked ? '*' : ''}`), type: q('[data-change-table]')?.type, keeping: f(q('[data-change-keeping]').textContent) } : null,
    save: q('[data-confirm-change]') ? { text: f(q('[data-confirm-change]').textContent), disabled: q('[data-confirm-change]').disabled } : null,
    error: shown(q('[data-cancel-error]')) ? f(q('[data-cancel-error]').textContent) : '',
    buttons: [...d.querySelectorAll('.modal__body .button')].map((b) => f(b.textContent)),
  };
});
const noticeOf = (page) => page.evaluate(() => {
  const n = document.querySelector('my-lair [data-notice]');
  return n && !n.hidden ? n.textContent.replace(/\s+/g, ' ').trim() : '';
});
const ticketOf = (page, key) => page.evaluate((k) => {
  const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const a = document.querySelector(`article[aria-labelledby="ml-${k}"]`);
  if (!a) return null;
  return {
    text: f(a.innerText), rows: Object.fromEntries([...a.querySelectorAll('dl.summary > div')].map((d) => [f(d.querySelector('dt').textContent), f(d.querySelector('dd').textContent)])),
    actions: [...a.querySelectorAll('.ml-ticket__actions button, .ml-ticket__actions a')].map((b) => f(b.textContent)), by: f(a.querySelector('.ml-cancel-row__by')?.textContent),
    lock: f(a.querySelector('.ml-lock')?.textContent), stub: f(a.querySelector('.ml-stub')?.textContent),
  };
}, key);
const gameCards = (page) => page.evaluate(() => {
  const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  return [...document.querySelectorAll('my-lair .ml-game')].map((g) => ({
    title: f(g.querySelector('.ml-game__title')?.textContent), when: f(g.querySelector('.ml-game__when')?.textContent), sub: f(g.querySelector('.ml-game__when + p')?.textContent),
    links: [...g.querySelectorAll('.ml-game__actions a')].map((a) => [f(a.textContent), a.getAttribute('href')]),
    cancels: [...g.querySelectorAll('[data-game-cancel]')].map((b) => [f(b.textContent), b.dataset.scope]),
    by: f(g.querySelector('.ml-cancel-row__by')?.textContent), lock: f(g.querySelector('.ml-lock')?.textContent),
  }));
});
const sheetOf = (page) => page.evaluate(() => {
  const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const d = document.querySelector('gm-board dialog');
  const q = (s) => d.querySelector(s);
  return {
    open: d.open, title: f(q('[data-sheet-title]')?.textContent), flash: f(q('.gm-flash span')?.textContent),
    intro: f(q('.gm-form__intro')?.textContent), scopes: [...d.querySelectorAll('[data-move-form] [name="scope"]')].map((r) => `${r.value}${r.checked ? '*' : ''}`),
    day: q('[data-days] .is-selected')?.dataset.day || '', days: [...d.querySelectorAll('[data-days] [data-day]')].slice(0, 3).map((b) => `${f(b.textContent)}${b.disabled ? ' (off)' : ''}`),
    slot: q('[data-slots] .is-selected')?.dataset.slot || '', tell: f(q('.gm-move__tell')?.textContent), status: f(q('[data-form-status]')?.textContent),
    go: f(q('[data-move-submit]')?.textContent), facts: [...d.querySelectorAll('.gm-facts li')].map((li) => f(li.textContent)),
    own: q('.gm-own') ? {
      buttons: [...d.querySelectorAll('.gm-own__actions button')].map((b) => f(b.textContent)), hint: f(q('.gm-own__cancel .small')?.textContent), locked: f(q('.gm-own__locked')?.textContent),
    } : null,
    confirm: f(q('.gm-confirm')?.innerText), foot: [...d.querySelectorAll('[data-sheet-foot] button')].map((b) => f(b.textContent)),
  };
});
/** "Wed 18 Nov" the way My Lair writes a short day, and the board's long one, from a time */
const days = (page, ms) => page.evaluate((at) => {
  const t = window.Lair.store.time;
  return { short: t.fmtDate(t.key(at)).replace(',', ''), long: t.fmtLong(t.key(at)).replace(',', ''), key: t.key(at), time: t.fmtTime(at), lock: window.Lair.lockWhen(at) };
}, ms);

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';

  /* ================= A. a table booking's numbers ================= */
  {
    const ctx = await context(size);
    const page = await fresh(ctx);
    await myLair(page, RUBY);
    const nine = (await demo(page)).bookings.find((b) => b.tables.length === 3 && b.people === 9);
    check(`${tag} A the demo gives her a table for nine on three tables, three days out`, Boolean(nine) && nine.amount === 9000, nine);
    const key = `bk-${nine.ref}`;
    const by = await days(page, nine.start - 24 * HOUR);
    let ticket = await ticketOf(page, key);
    check(`${tag} A1 its ticket has Change numbers beside Add to calendar`, ticket && ticket.actions.join('|') === 'Add to calendar|Change numbers|Cancel booking', ticket && ticket.actions);
    check(`${tag} A1 one moment for both: "Change or cancel by ${by.lock}"`, ticket && ticket.by === `Change or cancel by ${by.lock}`, ticket && ticket.by);
    await shot(page, `${size}-a1-ticket`, `article[aria-labelledby="ml-${key}"]`);
    await axeFree(page, `${tag} A1 the ticket`, `article[aria-labelledby="ml-${key}"]`);

    // 2. nine become six
    await page.locator(`[data-change="${key}"]`).click();
    await settle(page);
    let d = await dialogOf(page);
    check(`${tag} A2 the dialog asks "How many are coming?" with her tables and the time`, d.open && d.title === 'How many are coming?' && /^Tables T\d+, T\d+ and T\d+ /.test(d.text), d.text.slice(0, 120));
    check(`${tag} A2 it starts at 9 with nothing to save`, d.people === '9' && d.sum === '9 people · $90' && d.save.disabled && !d.tables, d);
    check(`${tag} A2 it says until when: "Change it again any time until ${by.lock}."`, d.text.includes(`Change it again any time until ${by.lock}.`), d.text);
    for (let i = 0; i < 3; i += 1) await page.locator('[data-change-step="-1"]').click();
    await settle(page, 150);
    d = await dialogOf(page);
    const [t1, t2, t3] = nine.tables;
    check(`${tag} A2 six: $60 (it was $90)`, d.people === '6' && d.sum === '6 people · $60 (it was $90)', d.sum);
    check(`${tag} A2 six fit at two tables, so one goes back: the last unless she picks`, d.tables && d.tables.legend === 'Which table goes back?' && d.tables.type === 'radio'
      && d.tables.hint === '6 people fit at 2 tables, so one goes back on the map for someone else.' && d.tables.chips.join() === `${t1},${t2},${t3}*` && d.tables.keeping === `You keep ${t1} and ${t2}.`, d.tables);
    await shot(page, `${size}-a2-six`);
    await axe(page, `${tag} A2 the dialog`, '[data-cancel-dialog]');
    await page.locator('[data-change-chips] .chip').first().click();
    await settle(page, 150);
    d = await dialogOf(page);
    check(`${tag} A2 she picks ${t1} to go back instead`, d.tables.chips.join() === `${t1}*,${t2},${t3}` && d.tables.keeping === `You keep ${t2} and ${t3}.` && !d.save.disabled, d.tables);
    check(`${tag} A2 no sideways scroll with the dialog open`, (await overflowX(page)) <= 0);
    await page.locator('[data-confirm-change]').click();
    await settle(page, 900);
    await page.evaluate(() => document.querySelectorAll('details.ml-later').forEach((x) => { x.open = true; }));
    const day = await days(page, nine.start);
    let said = await noticeOf(page);
    check(`${tag} A2 the notice says what it is now and what went back`, said === `Updated: Tables ${t2} and ${t3} for 6, ${day.short}. ${t1} is back on the map for someone else. It’s $60 now.`, said);
    const noticeTop = await page.evaluate(() => {
      const n = document.querySelector('my-lair [data-notice]').getBoundingClientRect();
      const bars = [...document.querySelectorAll('.site-header, my-lair .ml-bar')].filter((el) => ['sticky', 'fixed'].includes(getComputedStyle(el).position)).map((el) => el.getBoundingClientRect()).filter((r) => r.top < 200);
      return { top: Math.round(n.top), under: Math.round(Math.max(0, ...bars.map((r) => r.bottom))) };
    });
    check(`${tag} A2 the notice isn't behind the sticky bars`, noticeTop.top >= noticeTop.under - 1, noticeTop);
    ticket = await ticketOf(page, key);
    check(`${tag} A2 the ticket follows: 6 people, two tables, $60 on her tab`, ticket && ticket.rows.People === '6' && ticket.rows.Tables.startsWith(`${t2}, ${t3}`) && ticket.rows['Table fee'] === '$60' && /^\$60/.test(ticket.stub), ticket);
    let state = (await demo(page)).bookings.find((b) => b.id === nine.id);
    check(`${tag} A2 the demo keeps it, with a note for staff`, state.people === 6 && state.tables.join() === `${t2},${t3}` && state.amount === 6000 && state.notes.includes(`[Changed online: 9 to 6 people, ${t1} freed]`), state);
    const freeNow = await page.evaluate(async ([id, s, e]) => {
      await window.Lair.store.refresh();
      return window.Lair.store.isFree(id, s, e);
    }, [t1, nine.start, nine.end]);
    check(`${tag} A2 ${t1} is free for someone else at that time`, freeNow === true);
    check(`${tag} A2 no console errors`, page.errors.length === 0, page.errors);

    // 3. growing into the chairs she kept, and no further
    await page.locator(`[data-change="${key}"]`).click();
    await settle(page);
    await page.locator('[data-change-step="1"]').click();
    await page.locator('[data-change-step="1"]').click();
    await settle(page, 150);
    d = await dialogOf(page);
    check(`${tag} A3 up to every seat at her two tables, and the + stops there`, d.people === '8' && d.more === true && d.sum === '8 people · $80 (it was $60)' && !d.tables
      && d.limit === 'That’s every seat at your tables. For a bigger group, book another table or give us a call.', d);
    await page.locator('[data-confirm-change]').click();
    await settle(page, 900);
    await page.evaluate(() => document.querySelectorAll('details.ml-later').forEach((x) => { x.open = true; }));
    said = await noticeOf(page);
    check(`${tag} A3 the notice: eight now, $80`, said === `Updated: Tables ${t2} and ${t3} for 8, ${day.short}. It’s $80 now.`, said);

    // 5. it passes its moment while the dialog is open (the demo's booking is moved to 23 hours away under it)
    await page.locator(`[data-change="${key}"]`).click();
    await settle(page);
    await page.locator('[data-change-step="-1"]').click();
    await page.evaluate((id) => {
      const be = window.Lair.store.backend;
      const b = be.state.bookings.find((x) => x.id === id);
      const length = b.end - b.start;
      b.start = Date.now() + 23 * 3600000;
      b.end = b.start + length;
      be.commit();
    }, nine.id);
    await page.locator('[data-confirm-change]').click();
    await settle(page, 600);
    d = await dialogOf(page);
    check(`${tag} A5 refused once it's inside 24 hours, in the Lair app's words`, d.open && d.error === "It's less than 24 hours away, so it can't be changed online now: it stays on your tab as it is. Have a chat with us at the counter or give us a call, and we'll sort it out.", d.error);
    await page.locator('[data-cancel-dialog] [data-dialog-close]').first().click();
    await settle(page, 900);
    await page.evaluate(() => document.querySelectorAll('details.ml-later').forEach((x) => { x.open = true; }));
    ticket = await ticketOf(page, key);
    check(`${tag} A5 and the ticket shows it locked in, with no Change numbers`, ticket && !ticket.actions.includes('Change numbers') && /^Locked in: on your tab/.test(ticket.lock) && ticket.rows.People === '8', ticket);
    check(`${tag} A no sideways scroll on Bookings`, (await overflowX(page)) <= 0);
    check(`${tag} A no console errors`, page.errors.length === 0, page.errors);
    await ctx.close();
  }
  {
    // 4. tomorrow's 6pm table, at 7:30pm: inside its 24 hours
    const ctx = await context(size, '19:30');
    const page = await fresh(ctx);
    await myLair(page, RUBY);
    const now = await page.evaluate(() => Date.now());
    const soon = (await demo(page)).bookings.find((b) => b.status === 'confirmed' && b.start > now && b.start < now + 24 * HOUR);
    const ticket = soon ? await ticketOf(page, `bk-${soon.ref}`) : null;
    check(`${tag} A4 a table less than 24 hours away has no Change numbers, and says Locked in`, Boolean(ticket) && !ticket.actions.includes('Change numbers') && !ticket.actions.includes('Cancel booking') && /^Locked in: on your tab/.test(ticket.lock), ticket || soon);
    const tried = soon ? await page.evaluate(async (id) => {
      try {
        await window.Lair.store.backend.updateBooking(id, { people: 2 });
        return 'changed';
      } catch (e) {
        return `${e.status} ${e.message}`;
      }
    }, soon.id) : '';
    check(`${tag} A4 and the Lair app's demo refuses it too`, /^409 It's less than 24 hours away, so it can't be changed online now/.test(tried), tried);
    await ctx.close();
  }

  /* ================= B. Games I run ================= */
  {
    const ctx = await context(size);
    const page = await fresh(ctx);
    await myLair(page, RANGI, '/pages/my-lair#ml-games');
    let games = (await demo(page)).games;
    const weekly = games.filter((g) => g.seriesId && g.status !== 'cancelled');
    check(`${tag} B the demo gives his weekly game four sessions, a week apart`, weekly.length === 4 && weekly.every((g, i) => i === 0 || Math.round((g.start - weekly[i - 1].start) / (24 * HOUR)) === 7), weekly.map((g) => new Date(g.start).toISOString()));
    const first = weekly[0];
    const by = await days(page, first.start - 24 * HOUR);
    let cards = await gameCards(page);
    let card = cards.find((c) => c.title === first.title);
    check(`${tag} B1 the game's own buttons: Change date or time (to the board) and Open game`, card && card.links.length === 2 && card.links[0][0] === 'Change date or time' && card.links[0][1] === `/pages/gm-games?move=1#game=${first.id}`
      && card.links[1][0] === 'Open game' && card.links[1][1] === `/pages/gm-games#game=${first.id}`, card && card.links);
    check(`${tag} B1 Cancel this session and Cancel all future sessions, with until when`, card && card.cancels.join('|') === 'Cancel this session,session|Cancel all future sessions,series' && card.by === `Change or cancel by ${by.lock}`, card);
    const oneShot = cards.find((c) => c.title !== first.title);
    check(`${tag} B1 a one-shot has no "all future sessions"`, oneShot && oneShot.cancels.join('|') === 'Cancel this session,session', oneShot);
    await shot(page, `${size}-b1-games`, '[data-panel="games"]');
    await axeFree(page, `${tag} B1 Games I run`, '[data-panel="games"]');
    check(`${tag} B1 no sideways scroll on Games I run`, (await overflowX(page)) <= 0);

    // 2. cancel this session
    await page.locator(`[data-game-cancel="${first.id}"][data-scope="session"]`).click();
    await settle(page);
    let d = await dialogOf(page);
    check(`${tag} B2 it asks first: who has a seat, who hears, and that there's no undo`, d.open && d.title === 'Cancel this session?' && d.text.includes(first.title)
      && d.text.includes('3 players have a seat. Everyone with a seat gets an email to say it’s off, and anyone who’s already paid gets a full refund.')
      && d.text.includes('This can’t be undone. To run it again, list it as a new game.') && d.buttons.join('|') === 'Cancel this session|Keep it', d);
    await shot(page, `${size}-b2-ask`);
    await axe(page, `${tag} B2 the dialog`, '[data-cancel-dialog]');
    await page.locator('[data-confirm-game-cancel]').click();
    await settle(page, 900);
    const firstDay = await days(page, first.start);
    let said = await noticeOf(page);
    check(`${tag} B2 the notice says it's cancelled and who was emailed`, said === `Cancelled: ${first.title}, ${firstDay.short}. Gobgob emailed 2 bookings, and 1 paid seat is flagged for a refund.`, said);
    games = (await demo(page)).games;
    check(`${tag} B2 that session is cancelled in the demo, the others aren't`, games.find((g) => g.id === first.id).status === 'cancelled' && weekly.slice(1).every((w) => games.find((g) => g.id === w.id).status !== 'cancelled'));
    cards = await gameCards(page);
    card = cards.find((c) => c.title === first.title);
    const second = weekly[1];
    const secondDay = await days(page, second.start);
    check(`${tag} B2 the card is the next session's now`, card && card.when.includes(secondDay.long) && card.sub.includes('2 more sessions booked') && card.links[0][1].endsWith(`#game=${second.id}`), card);

    // 3. less than 24 hours away: a note in place of the buttons, and "all future sessions" leaves it on
    await page.evaluate((id) => {
      const be = window.Lair.store.backend;
      const g = be.state.games.find((x) => x.id === id);
      const length = g.end - g.start;
      const t = window.Lair.store.time;
      // tomorrow at 11am (the clock says 1pm today): 22 hours away
      const start = t.at(t.addDays(t.today(), 1), 11 * 60);
      Object.assign(g, { start, end: start + length });
      be.state.bookings.forEach((b) => { if (b.gameId === id) Object.assign(b, { start, end: start + length }); });
      be.commit();
    }, second.id);
    await myLair(page, RANGI, '/pages/my-lair#ml-games');
    cards = await gameCards(page);
    card = cards.find((c) => c.title === first.title);
    check(`${tag} B3 too close: a note in place of Change and Cancel this session`, card && card.links.map((l) => l[0]).join('|') === 'Open game' && card.cancels.join('|') === 'Cancel all future sessions,series'
      && card.lock === 'Too close to change online It’s less than 24 hours away, so it can’t be moved or cancelled online now. Give us a call or see us at the counter, and we’ll sort it out with your players.', card);
    await shot(page, `${size}-b3-locked`, '[data-panel="games"]');
    await axeFree(page, `${tag} B3 Games I run, one too close`, '[data-panel="games"]');
    await page.locator(`[data-game-cancel="${second.id}"][data-scope="series"]`).click();
    await settle(page);
    d = await dialogOf(page);
    const close = await days(page, (await demo(page)).games.find((g) => g.id === second.id).start);
    check(`${tag} B3 "all future sessions" says which it means, and which stays on`, d.title === 'Cancel all future sessions?' && d.text.includes('2 sessions.')
      && d.text.includes(`${close.long} is less than 24 hours away, so it stays on. Give us a call if it can’t run.`) && d.buttons.join('|') === 'Cancel all 2|Keep them', d);
    await shot(page, `${size}-b3-ask`);
    await axe(page, `${tag} B3 the dialog`, '[data-cancel-dialog]');
    await page.locator('[data-confirm-game-cancel]').click();
    await settle(page, 900);
    said = await noticeOf(page);
    check(`${tag} B3 after: the Lair app's own words for the one it left on`, said.startsWith(`Cancelled: ${first.title}, every future session. Nobody had a seat, so there was no one to tell. `)
      && said.endsWith("is less than 24 hours away, so it's still on. Give us a call if it can't run."), said);
    games = (await demo(page)).games;
    check(`${tag} B3 the close one is still on, the two after it are cancelled`, games.find((g) => g.id === second.id).status !== 'cancelled' && weekly.slice(2).every((w) => games.find((g) => g.id === w.id).status === 'cancelled'),
      games.map((g) => g.status));
    check(`${tag} B no console errors`, page.errors.length === 0, page.errors);
    await ctx.close();
  }

  /* ================= C. the games board ================= */
  {
    const ctx = await context(size);
    const page = await fresh(ctx);
    await myLair(page, RANGI, '/pages/my-lair#ml-games');
    const before = (await demo(page)).games;
    const weekly = before.filter((g) => g.seriesId);
    const single = before.find((g) => !g.seriesId);
    const first = weekly[0];
    const href = await page.evaluate(() => document.querySelector('my-lair .ml-game a[href*="move=1"]')?.getAttribute('href') || '');
    await go(page, BASE, href, RANGI);
    await settle(page, 1200);
    let s = await sheetOf(page);
    const address = await page.evaluate(() => `${window.location.pathname}${window.location.search}${window.location.hash}`);
    const firstDay = await days(page, first.start);
    check(`${tag} C1 My Lair's link opens the game's Change date or time`, s.open && s.title === 'Change date or time' && s.intro.startsWith(`Move ${first.title} to a new day, time or tables. Right now it’s ${firstDay.long},`), s.intro);
    check(`${tag} C1 and ?move leaves the address (a reload opens the game alone)`, address === `/pages/gm-games#game=${first.id}`, address);
    check(`${tag} C2 a weekly game asks Which sessions?, just this one unless they say`, s.scopes.join() === 'session*,series' && s.go === 'Move this session', s);
    check(`${tag} C2 the picker starts where the session is, and today is too soon`, s.day === firstDay.key && Number(s.slot) === 18 * 60 && /Today.*Too soon.*\(off\)/.test(s.days[0]), [s.day, s.slot, s.days]);
    check(`${tag} C2 it says who hears and why a day's notice`, s.tell === '3 seats are taken. Gobgob emails everyone the new time, and they get 24 hours to drop out if they can’t make it. So pick a time at least 24 hours away.', s.tell);
    await shot(page, `${size}-c2-move`);
    await axe(page, `${tag} C2 the move sheet`, 'gm-board dialog');
    check(`${tag} C2 no sideways scroll with the sheet open`, (await overflowX(page)) <= 0);

    // 3. nothing changed, then the next day, just this session
    await page.locator('[data-move-submit]').click();
    await settle(page, 300);
    s = await sheetOf(page);
    check(`${tag} C3 nothing changed: it says so, and asks nothing of the Lair app`, s.status === 'That’s where it is now. Pick a new day, time or tables.', s.status);
    const nextKey = await page.evaluate((k) => window.Lair.store.time.addDays(k, 1), firstDay.key);
    await page.locator(`gm-board dialog [data-day="${nextKey}"]`).click();
    await settle(page, 200);
    await page.locator('[data-move-submit]').click();
    await settle(page, 1200);
    s = await sheetOf(page);
    let games = (await demo(page)).games;
    const moved = games.find((g) => g.id === first.id);
    const movedDay = await days(page, moved.start);
    check(`${tag} C3 moved a day on: the flash says where, and who was told`, s.title !== 'Change date or time' && s.flash.startsWith('Moved to ') && s.flash.includes(' 19 Nov') === (movedDay.key.endsWith('-19')) && s.flash.endsWith('Gobgob emailed 2 people the new time.'), s.flash);
    check(`${tag} C3 the session is a day later at the same time, on the same tables`, Math.round((moved.start - first.start) / HOUR) === 24 && moved.end - moved.start === first.end - first.start && moved.tables.join() === first.tables.join(), moved);
    check(`${tag} C3 the game's facts show the new day`, s.facts.some((f) => f.includes(String(Number(movedDay.key.slice(-2))))) && s.facts[0].includes(movedDay.long.split(' ')[0]), s.facts.slice(0, 2));
    check(`${tag} C3 the other sessions stay where they were (a one-off)`, weekly.slice(1).every((w) => games.find((g) => g.id === w.id).start === w.start));
    const seats = await page.evaluate((id) => {
      const be = window.Lair.store.backend;
      return be.state.bookings.filter((b) => b.gameId === id && b.kind === 'gm-seat').map((b) => ({ start: b.start, movedAt: Boolean(b.movedAt), until: be.cancelRule(be.bookingItem(b)).cancelUntil }));
    }, first.id);
    check(`${tag} C3 each seat moved with it`, seats.length > 0 && seats.every((x) => x.start === moved.start && x.movedAt), seats);

    // 4. this and every later session: the second session, to the day before
    const second = weekly[1];
    await page.evaluate((id) => document.querySelector('gm-board').openGame(id), second.id);
    await settle(page, 400);
    s = await sheetOf(page);
    check(`${tag} C6 his own game: Change date or time among its buttons, and Cancel up to 24 hours before`, s.own && s.own.buttons.includes('Change date or time') && s.own.buttons.includes('Cancel this session') && s.own.buttons.includes('Cancel all future sessions')
      && s.own.hint === 'Can’t run it? Cancel up to 24 hours before it starts. Everyone with a seat gets an email, and anyone who’s already paid gets a refund.', s.own);
    await page.evaluate(() => document.querySelector('gm-board dialog .gm-own')?.scrollIntoView({ block: 'start' }));
    await shot(page, `${size}-c6-own`, 'gm-board dialog .gm-own');
    await axe(page, `${tag} C6 his game's own panel`, 'gm-board dialog .gm-own');
    await page.locator('gm-board dialog [data-move]').click();
    await settle(page, 500);
    await page.locator('gm-board dialog [name="scope"][value="series"]').check();
    await settle(page, 150);
    s = await sheetOf(page);
    check(`${tag} C4 This and every later session: the button says so`, s.scopes.join() === 'session,series*' && s.go === 'Move every session', s.go);
    const secondDay = await days(page, second.start);
    const dayBefore = await page.evaluate((k) => window.Lair.store.time.addDays(k, -1), secondDay.key);
    await page.locator(`gm-board dialog [data-day="${dayBefore}"]`).click();
    await settle(page, 200);
    await shot(page, `${size}-c4-series`);
    await page.locator('[data-move-submit]').click();
    await settle(page, 1200);
    s = await sheetOf(page);
    games = (await demo(page)).games;
    check(`${tag} C4 the flash says every later session moves with it`, s.flash.startsWith('Moved to ') && s.flash.includes('Every later session moves with it.') && s.flash.endsWith('Nobody had a seat, so there was no one to tell.'), s.flash);
    check(`${tag} C4 this session and both after it are a day earlier; the one before stays`, weekly.slice(1).every((w) => Math.round((w.start - games.find((g) => g.id === w.id).start) / HOUR) === 24)
      && games.find((g) => g.id === first.id).start === moved.start, weekly.map((w) => (w.start - games.find((g) => g.id === w.id).start) / HOUR));

    // 5. a one-shot has no Which sessions?
    await page.evaluate((id) => document.querySelector('gm-board').openMove(id), single.id);
    await settle(page, 500);
    s = await sheetOf(page);
    check(`${tag} C5 a one-shot has no Which sessions?`, s.title === 'Change date or time' && s.scopes.length === 0 && s.tell === 'Nobody has a seat yet, so there’s no one to tell.', s);

    // 6. a session that's closer than 24 hours: a note, and no buttons to change it
    await page.evaluate((id) => {
      const be = window.Lair.store.backend;
      const g = be.state.games.find((x) => x.id === id);
      const length = g.end - g.start;
      const t = window.Lair.store.time;
      const start = t.at(t.addDays(t.today(), 1), 11 * 60);
      Object.assign(g, { start, end: start + length });
      be.state.bookings.forEach((b) => { if (b.gameId === id) Object.assign(b, { start, end: start + length }); });
      be.commit();
    }, single.id);
    await page.evaluate(() => window.Lair.store.refresh());
    await settle(page, 300);
    await page.evaluate((id) => document.querySelector('gm-board').openGame(id), single.id);
    await settle(page, 400);
    s = await sheetOf(page);
    check(`${tag} C6 too close: a note, and no Change date or time or Cancel this session`, s.own && !s.own.buttons.includes('Change date or time') && !s.own.buttons.includes('Cancel this session')
      && s.own.locked === 'Too close to change online. It’s less than 24 hours away, so it can’t be moved or cancelled online now. Give us a call or see us at the counter, and we’ll sort it out with your players.', s.own);
    await page.evaluate(() => document.querySelector('gm-board dialog .gm-own')?.scrollIntoView({ block: 'start' }));
    await shot(page, `${size}-c6-locked`, 'gm-board dialog .gm-own');
    await axe(page, `${tag} C6 the game's sheet, too close`, 'gm-board dialog');
    const refused = await page.evaluate(async (id) => {
      const out = [];
      for (const call of [() => window.Lair.store.backend.cancelGame(id, 'session'), () => window.Lair.store.backend.moveGame(id, { start: Date.now() + 5 * 24 * 3600000 })]) {
        try {
          await call();
          out.push('done');
        } catch (e) {
          out.push(`${e.status} ${e.message}`);
        }
      }
      return out;
    }, single.id);
    check(`${tag} C6 and the demo refuses both in the Lair app's words`, refused[0] === "409 It's less than 24 hours away, so it can't be cancelled online now. Give us a call or see us at the counter, and we'll sort it out with your players."
      && refused[1] === "409 It's less than 24 hours away, so it can't be moved online now. Give us a call or see us at the counter, and we'll sort it out with your players.", refused);

    // 7. a Lair app from before round 37 doesn't say features.changes: no Change date or time
    await page.evaluate((id) => {
      const board = document.querySelector('gm-board');
      window.Lair.store.data.features = { ...window.Lair.store.data.features, changes: false };
      board.openGame(id);
    }, weekly[2].id);
    await settle(page, 300);
    s = await sheetOf(page);
    check(`${tag} C7 an older Lair app: no Change date or time, the rest as before`, s.own && !s.own.buttons.includes('Change date or time') && s.own.buttons.includes('Cancel this session'), s.own);
    check(`${tag} C no console errors`, page.errors.length === 0, page.errors);
    await ctx.close();
  }

  /* ================= D. staff on the board ================= */
  {
    const ctx = await context(size);
    const page = await fresh(ctx);
    await go(page, BASE, '/pages/gm-games', STAFF);
    await settle(page, 1200);
    // a session of anyone's that starts later today or tomorrow: inside 24 hours, which is no bar to staff
    const id = await page.evaluate(() => {
      const now = Date.now();
      const g = window.Lair.store.data.games.filter((x) => x.status !== 'cancelled' && x.start > now && x.start < now + 24 * 3600000).sort((a, b) => a.start - b.start)[0];
      if (g) document.querySelector('gm-board').openGame(g.id);
      return g ? g.id : '';
    });
    await settle(page, 400);
    const s = id ? await sheetOf(page) : null;
    check(`${tag} D staff: Change date or time on a session hours away, and they cancel until it ends`, Boolean(s && s.own) && s.own.buttons.includes('Change date or time') && s.own.buttons.includes('Cancel this session')
      && s.own.hint === 'Staff can cancel a session until it ends. Everyone with a seat gets an email, and anyone who’s already paid gets a refund.' && !s.own.locked, s ? s.own : 'no session in the next 24 hours');
    // someone on the team changing their own table from My Lair: the staff way in the Lair app (no lock, no email), and
    // the page reads the same: six, two tables, $60
    await myLair(page, STAFF);
    const nine = (await demo(page)).bookings.find((b) => b.tables.length === 3 && b.people === 9);
    const key = nine ? `bk-${nine.ref}` : '';
    if (nine) {
      await page.locator(`[data-change="${key}"]`).click();
      await settle(page);
      for (let i = 0; i < 3; i += 1) await page.locator('[data-change-step="-1"]').click();
      await page.locator('[data-confirm-change]').click();
      await settle(page, 900);
      await page.evaluate(() => document.querySelectorAll('details.ml-later').forEach((x) => { x.open = true; }));
    }
    const said = await noticeOf(page);
    const ticket = nine ? await ticketOf(page, key) : null;
    check(`${tag} D someone on the team changes their own table from My Lair the same way`, Boolean(ticket) && ticket.rows.People === '6' && ticket.rows['Table fee'] === '$60'
      && /^Updated: Tables \S+ and \S+ for 6, .+\. \S+ is back on the map for someone else\. It’s \$60 now\.$/.test(said), { said, ticket });
    check(`${tag} D no console errors`, page.errors.length === 0, page.errors);
    await ctx.close();
  }
}

const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed. Screenshots: ${process.env.OUT}`);
await browser.close();
server.close?.();
process.exit(fail ? 1 : 0);

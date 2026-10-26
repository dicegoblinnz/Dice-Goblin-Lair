// A GM sees their players on every session (17 Oct 2026, contract v18-gm-players), on the theme mock. Mo: "I have a user
// who is asking me that he wants to see his players etc. if you see the mobile view I can see my players but he cannot see
// his please make it that all gms can see their players across the site". Dan runs Icewind Dale from the session after
// the series' next one (the next is still on no account, as staff left it), so its three weekly regulars are booked into
// the next session and only saved in his: his card said "3 of 6 seats taken" over "No players yet".
//  1. My Lair › Bookings › Games I run: his card lists the three, each a Regular, with the line about saved seats, and no
//     "No players yet"; at 320, 360, 390 and 430 wide (phone) or 1280 (desktop), light and dark, no sideways scroll, axe.
//  2. The TTRPG sessions page, his game's sheet: Your game lists them as Regulars on his session, and lists them booked on
//     the series' next session (his series, someone else's session).
//  3. Message your players for his session: "Everyone with a seat: 3 players", and the demo emails the three.
//  4. Staff running it: the series' next session's roster keeps Remove on each booked row; his session's roster lists the
//     saved regulars as rows with no Remove.
// Usage: DG_THEME=/path/to/theme [PORT=4994] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round18/gm-players.mjs [phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round18-gm-players');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, context, watch, go, STAFF, OUT } = lib;
const PORT = Number(process.env.PORT || 4994);
const BASE = `http://localhost:${PORT}`;
const sizes = process.argv[2] ? [process.argv[2]] : ['phone', 'desktop'];
const DAN = { id: 7310, first_name: 'Dan', last_name: 'Kerr', name: 'Dan Kerr', email: 'dan@example.com', phone: '', tags: ['gm'], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const SERIES = 'sr-gp-icewind';
const NOTE = 'Regulars: Gobgob saves their seat every week.';
const SAVED_META = 'Seat saved: booked once the session before ends';

const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 350) => page.waitForTimeout(ms);
const ready = (page) => page.waitForFunction(() => Boolean(window.Lair && window.Lair.store && window.Lair.store.data && Array.isArray(window.Lair.store.data.games) && window.Lair.store.data.games.length), null, { timeout: 20000 });

/** The demo, through its own backend: Icewind Dale on Fridays 6pm to 10pm, three sessions from the next Friday. The first
    (the series' next) is still on no account; the two after are Dan's. Mia (as Thorin Frostbeard), Kai and Ria are
    regulars, booked into the first. */
const seed = (page) => page.evaluate(async ([dan, series]) => {
  const { store } = window.Lair;
  const be = store.backend;
  const t = store.time;
  let first = t.addDays(t.today(), 1);
  while (new Date(`${first}T12:00:00Z`).getUTCDay() !== 5) first = t.addDays(first, 1);
  const days = [first, t.addDays(first, 7), t.addDays(first, 14)];
  be.state.games = be.state.games.filter((g) => !/^gm-gp-/.test(g.id));
  be.state.bookings = be.state.bookings.filter((b) => !/^gm-gp-/.test(b.gameId || ''));
  be.state.seriesMembers = (be.state.seriesMembers || []).filter((x) => x.seriesId !== series);
  const games = days.map((day, i) => ({
    id: `gm-gp-${i + 1}`, title: 'Icewind Dale', system: 'D&D 5e', gm: 'Dan', gmCustomerId: i ? dan : 'demo-nobody', gmEmail: i ? 'dan@example.com' : null,
    blurb: "Dan's weekly Rime of the Frostmaiden campaign.", tables: ['G3'], room: 'gaming-room', seats: 6, start: t.at(day, 18 * 60), end: t.at(day, 22 * 60),
    taken: i ? 0 : 3, status: 'open', credited: null, gmFee: 500, seatPrice: 1500, schedule: 'weekly', seriesId: series, level: 'some', age: '13+', tags: [],
    safety: [], characters: 'bring', bring: '', contentNotes: '', sessionZero: '', image: null, gmFeeApproved: true,
  }));
  be.state.games.push(...games);
  for (const g of games) {
    be.state.bookings.push({
      id: `bk-${g.id}`, ref: `GM-${g.id}`, kind: 'gm', gameId: g.id, tables: g.tables, start: g.start, end: g.end, people: g.seats + 1, name: 'GM Dan',
      status: 'confirmed', pay: 'day', paid: true, activity: 'rpg', extras: [], customerId: g.gmCustomerId,
    });
  }
  const regulars = [['Mia', 'Thorin Frostbeard'], ['Kai', ''], ['Ria', '']].map(([name, character], i) => ({
    id: `sm-gp-${i + 1}`, seriesId: series, customerId: `demo-gp-${name.toLowerCase()}`, people: 1, players: [{ name, character }], name,
    email: `${name.toLowerCase()}@example.com`, since: Date.now() - (10 - i) * 60000,
  }));
  be.state.seriesMembers.push(...regulars);
  for (const r of regulars) {
    const g = games[0];
    be.state.bookings.push({
      id: `bk-gp-${r.name.toLowerCase()}`, ref: `GP-${r.name.toUpperCase()}-17`, kind: 'gm-seat', gameId: g.id, tables: g.tables, start: g.start, end: g.end,
      people: 1, players: r.players.map((p) => ({ ...p })), name: r.name, email: r.email, phone: '', notes: '', status: 'confirmed', pay: 'day', paid: false,
      paidAmount: 0, refund: null, holdUntil: null, amount: 1500, activity: 'rpg', extras: [], customerId: r.customerId, member: r.id, seriesId: series, createdAt: Date.now(),
    });
  }
  be.commit();
  await store.refresh();
  return days;
}, [String(DAN.id), SERIES]);

/** The Games I run card for Icewind Dale, as words */
const card = (page) => page.evaluate(() => {
  const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const el = [...document.querySelectorAll('my-lair [data-panel="games"] .ml-game')].find((x) => f(x.querySelector('.ml-game__title')?.textContent) === 'Icewind Dale');
  if (!el) return null;
  return {
    when: f(el.querySelector('.ml-game__when')?.textContent),
    seats: f(el.querySelector('.ml-game__seats')?.textContent),
    rows: [...el.querySelectorAll('.ml-roster li')].map((li) => f(li.innerText)),
    badges: [...el.querySelectorAll('.ml-roster li .badge')].map((b) => f(b.textContent)),
    note: f(el.querySelector('.ml-roster__note')?.textContent),
    empty: /No players yet/.test(el.textContent),
  };
});
/** The open sheet's Your game panel, as words */
const own = (page) => page.evaluate(() => {
  const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  // every bit of text, a space between each (a badge sits right after a name, apart only by its margin)
  const words = (el) => {
    const out = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) if (walk.currentNode.textContent.trim()) out.push(walk.currentNode.textContent.trim());
    return f(out.join(' '));
  };
  const box = document.querySelector('[data-sheet][open] .gm-own');
  if (!box) return null;
  return {
    head: f(box.querySelector('.gm-own__players .gm-own__head')?.innerText),
    rows: [...box.querySelectorAll('.gm-own__players .gm-own__list > li')].map((li) => words(li).replace(/ Remove$/, '')),
    removes: [...box.querySelectorAll('.gm-own__players .gm-own__list > li')].map((li) => li.querySelectorAll('[data-roster-remove]').length),
    empty: /No players yet/.test(box.textContent),
  };
});
const openSheet = async (page, id) => {
  await page.goto('about:blank');
  await page.goto(`${BASE}/pages/gm-games#game=${id}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('[data-sheet][open] .gm-detail', { timeout: 15000 });
  await settle(page, 450);
};

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';

  /* ---------- 1. My Lair › Games I run ---------- */
  let ctx = await context(browser, size);
  let page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gm-games', DAN);
  await ready(page);
  const days = await seed(page);
  await go(page, BASE, '/pages/my-lair#bookings', DAN);
  await page.waitForSelector('my-lair [data-panel="games"] .ml-game', { timeout: 20000 });
  await settle(page, 500);
  const c = await card(page);
  check(`${tag} Games I run: Dan's card is his session (the second), "3 of 6 seats taken, 3 left"`, c && /Next session:/.test(c.when) && c.seats === '3 of 6 seats taken, 3 left', c);
  check(`${tag} Games I run: it lists Mia as Thorin Frostbeard, Kai and Ria, each a Regular, with the saved-seat line and no "No players yet"`,
    c && JSON.stringify(c.rows) === JSON.stringify(['Mia as Thorin Frostbeard Regular', 'Kai Regular', 'Ria Regular']) && c.badges.every((b) => b === 'Regular')
    && c.note === NOTE && !c.empty, c);
  await shot(page, `${size}-1-games-i-run`, 'my-lair [data-panel="games"]');
  await axe(page, `${tag} Games I run`, 'my-lair [data-panel="games"]');
  if (size === 'phone') {
    for (const width of [320, 360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await settle(page, 250);
      check(`${tag} Games I run at ${width} wide: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
      if (width === 320) await shot(page, `${size}-1-games-i-run-320`, 'my-lair [data-panel="games"]');
    }
    await page.setViewportSize({ width: 390, height: 844 });
  } else {
    check(`${tag} Games I run: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await settle(page, 250);
  await shot(page, `${size}-1-games-i-run-dark`, 'my-lair [data-panel="games"]');
  await axe(page, `${tag} Games I run, dark`, 'my-lair [data-panel="games"]');
  await page.emulateMedia({ colorScheme: 'light' });

  /* ---------- 2. the TTRPG sessions page: Your game ---------- */
  await openSheet(page, 'gm-gp-2');
  const mine = await own(page);
  check(`${tag} Your game (his session): "3 of 6 seats taken, 3 held for regulars" over Mia, Kai and Ria, each a Regular, no "No players yet"`,
    mine && /3 of 6 seats taken, 3 held for regulars$/.test(mine.head)
    && JSON.stringify(mine.rows) === JSON.stringify(['Mia as Thorin Frostbeard Regular', 'Kai · no character yet Regular', 'Ria · no character yet Regular']) && !mine.empty, mine);
  await shot(page, `${size}-2-your-game`, '[data-sheet][open] .gm-own');
  await axe(page, `${tag} Your game, his session`, '[data-sheet]');
  check(`${tag} Your game: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  await openSheet(page, 'gm-gp-1');
  const next = await own(page);
  check(`${tag} Your game (the series' next, still on no account): the three booked, no Regular badge, no "No players yet"`,
    // (round 21, part 2: each booked seat offers Pay for them, as its GM can pay for a player)
    next && /3 of 6 seats taken$/.test(next.head) && JSON.stringify(next.rows) === JSON.stringify(['Mia as Thorin Frostbeard Pay for them', 'Kai · no character yet Pay for them', 'Ria · no character yet Pay for them']) && !next.empty, next);
  await shot(page, `${size}-2-your-game-next`, '[data-sheet][open] .gm-own');

  /* ---------- 3. Message your players, his session ---------- */
  await openSheet(page, 'gm-gp-2');
  await page.locator('[data-sheet][open] .gm-own [data-message="gm-gp-2"]').click();
  await page.waitForSelector('[data-sheet][open] [data-message-form]', { timeout: 10000 });
  const to = flat(await page.locator('[data-sheet][open] [data-message-form] input[value="session"] + .pay-option__body').textContent());
  check(`${tag} Message: this session goes to everyone with a seat, 3 players`, /Everyone with a seat: 3 players\./.test(to), to);
  await page.locator('[data-sheet][open] textarea[name="message"]').fill('Bring warm clothes, team!');
  await page.locator('[data-sheet][open] [data-message-send]').click();
  await page.waitForSelector('[data-sheet][open] .gm-flash', { timeout: 10000 });
  const flash = flat(await page.locator('[data-sheet][open] .gm-flash').first().textContent());
  const sent = await page.evaluate(() => (window.Lair.store.backend.state.messages || []).slice(-1)[0]?.sent);
  check(`${tag} Message: the demo emails the three saved regulars`, sent === 3 && /Gobgob emailed 3 people with a seat\./.test(flash), { sent, flash });
  check(`${tag} Dan: no errors`, !page.errors.length, page.errors);
  await ctx.close();

  /* ---------- 4. staff running it ---------- */
  ctx = await context(browser, size);
  page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gm-games', STAFF);
  await ready(page);
  await seed(page);
  await openSheet(page, 'gm-gp-1');
  const staffNext = await own(page);
  check(`${tag} Staff, the series' next: one roster row per booking, each with Remove`, staffNext && staffNext.rows.length === 3 && staffNext.removes.every((n) => n === 1), staffNext);
  await openSheet(page, 'gm-gp-2');
  const staffMine = await own(page);
  check(`${tag} Staff, Dan's session: the saved regulars as rows with no Remove, each "${SAVED_META}"`,
    staffMine && staffMine.rows.length === 3 && staffMine.removes.every((n) => n === 0) && staffMine.rows.every((r) => r.endsWith(`Regular ${SAVED_META}`))
    && /^Mia as Thorin Frostbeard/.test(staffMine.rows[0]) && !staffMine.empty, staffMine);
  await shot(page, `${size}-4-staff-roster`, '[data-sheet][open] .gm-own');
  await axe(page, `${tag} staff roster with saved regulars`, '[data-sheet] .gm-own');
  check(`${tag} Staff: no errors`, !page.errors.length, page.errors);
  await ctx.close();
  void days;
}

await browser.close();
server.close();
const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed. Screenshots in ${OUT}`);
process.exit(fail ? 1 : 0);

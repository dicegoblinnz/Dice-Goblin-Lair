// Round 21 (26 Oct 2026), GM credit that adds itself, on the theme mock (demo mode): the GM games tab's "Earlier this
// week" card for a session from 26 October on says where its GM credit is up to (credited, still to pay, kept from a
// staff GM) and offers no Session done, while a session from before then keeps Session done. No sideways scroll and axe.
// Phone and desktop. The page's clock is today at 11:30pm.
// Usage: DG_THEME=/path/to/theme [PORT=4986] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round21/staff-gm-credit.mjs [phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round21-staff-gm-credit');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, context, watch, go, STAFF, today } = lib;
const PORT = Number(process.env.PORT || 4986);
const BASE = `http://localhost:${PORT}`;
const sizes = process.argv[2] ? [process.argv[2]] : ['phone', 'desktop'];
const ANA = 'demo-ana-gm';
const AUTO_FROM = Date.parse('2026-10-26T00:00:00+13:00');

const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 350) => page.waitForTimeout(ms);

/**
 * The demo, through its own backend: Rangi's session tonight 6pm to 9pm (two paid seats, one still to pay), Ana's
 * (a helper, so Never keeps it from her) at the same time, and one from Sunday 25 October (before round 21)
 */
const seed = (page, day) => page.evaluate(async ([ana, key]) => {
  const { store } = window.Lair;
  const be = store.backend;
  const t = store.time;
  await be.teamAdd({ customerId: ana, name: 'Ana Ngata', email: 'ana@example.com', perms: ['sessions'] });
  const game = (id, title, gm, gmCustomerId, start, end, tables) => ({
    id, title, system: 'D&D 5e', gm, gmCustomerId, gmEmail: `${gm.toLowerCase()}@example.com`, blurb: 'A test session.', tables, room: 'game-room',
    seats: 4, start, end, taken: 0, status: 'open', credited: null, gmFee: 500, seatPrice: 1500, schedule: 'one-shot', seriesId: null, level: 'new',
    age: '18+', tags: [], safety: [], characters: 'pregens', bring: '', contentNotes: '', sessionZero: '', image: null, gmFeeApproved: true,
  });
  const seat = (id, gameId, name, people, paid, start, end, tables) => ({
    id, ref: `${name.slice(0, 2).toUpperCase()}-OWL-${id.length}`, kind: 'gm-seat', gameId, tables, start, end, people, players: [{ name, character: '' }],
    name, email: `${name.toLowerCase()}@example.com`, status: paid ? 'done' : 'confirmed', pay: 'day', paid, amount: 1500 * people,
    paidAmount: paid ? 1500 * people : 0, activity: 'rpg', extras: [],
  });
  const ids = ['gm-r21-rangi', 'gm-r21-ana', 'gm-r21-sunday'];
  be.state.games = be.state.games.filter((g) => !ids.includes(g.id));
  be.state.bookings = be.state.bookings.filter((b) => !ids.includes(b.gameId));
  const start = t.at(key, 18 * 60);
  const end = t.at(key, 21 * 60);
  const sunStart = t.at('2026-10-25', 18 * 60);
  const sunEnd = t.at('2026-10-25', 21 * 60);
  be.state.games.push(game(ids[0], 'Rangi’s one-shot', 'Rangi', 'demo-rangi-r21', start, end, ['G1']));
  be.state.games.push(game(ids[1], 'Ana’s staff one-shot', 'Ana', ana, start, end, ['G2']));
  be.state.games.push(game(ids[2], 'Sunday’s one-shot', 'Rangi', 'demo-rangi-r21', sunStart, sunEnd, ['G1']));
  be.state.bookings.push(seat('bk-r21-mia', ids[0], 'Mia', 2, true, start, end, ['G1']));
  be.state.bookings.push(seat('bk-r21-kai', ids[0], 'Kai', 1, false, start, end, ['G1']));
  be.state.bookings.push(seat('bk-r21-ria', ids[1], 'Ria', 1, true, start, end, ['G2']));
  be.state.bookings.push(seat('bk-r21-sun', ids[2], 'Tama', 1, true, sunStart, sunEnd, ['G1']));
  be.commit();
  await store.refresh();
  return ids;
}, [ANA, day]);

/** A card on the GM games tab, by its title: its buttons, badges and notes */
const card = (page, title) => page.evaluate((name) => {
  const el = [...document.querySelectorAll('.staff-gm-card')].find((a) => a.querySelector('strong')?.textContent.trim() === name);
  if (!el) return null;
  const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  return {
    buttons: [...el.querySelectorAll('[data-act="credit"]')].map((b) => f(b.textContent)),
    badges: [...el.querySelectorAll('.cluster .badge')].map((b) => f(b.textContent)),
    notes: [...el.querySelectorAll('.cluster .small')].map((s) => f(s.textContent)),
  };
}, title);

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';
  const ctx = await context(browser, size, '23:30');
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/lair-staff', STAFF);
  await page.waitForSelector('#checkin-code', { timeout: 20000 });
  await seed(page, today);
  check(`${tag} today (${today}) is from round 21 on`, Date.parse(`${today}T00:00:00+13:00`) >= AUTO_FROM, today);
  await page.click('[data-tab="games"]');
  await page.waitForSelector('.staff-gm-card', { timeout: 15000 });

  const rangi = await card(page, 'Rangi’s one-shot');
  check(`${tag} Rangi’s session tonight: GM credited $10 for 2 players, 1 still to pay, and no Session done`,
    rangi && rangi.buttons.length === 0 && JSON.stringify(rangi.badges) === JSON.stringify(['GM credited $10 for 2 players'])
    && rangi.notes.includes('1 player still to pay: Rangi gets $5 for each once they pay.'), rangi);
  const ana = await card(page, 'Ana’s staff one-shot');
  check(`${tag} Ana’s session tonight (a helper, Never): no GM credit for 1 player, why, and no Session done`,
    ana && ana.buttons.length === 0 && JSON.stringify(ana.badges) === JSON.stringify(['No GM credit for 1 player'])
    && ana.notes.includes('Ana is staff, so there’s no GM credit.'), ana);
  const sunday = await card(page, 'Sunday’s one-shot');
  check(`${tag} Sunday 25 October’s session (before round 21) keeps Session done: credit GM $5`,
    sunday && JSON.stringify(sunday.buttons) === JSON.stringify(['Session done: credit GM $5']), sunday);
  await shot(page, `${size}-gm-cards`, '[data-panel="games"]');
  await axe(page, `${tag} GM games tab with round 21 cards`, '[data-panel="games"]');
  check(`${tag} GM games tab: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));

  // Kai pays: once he has, the card says the credit goes within 10 minutes (the demo has no 10-minute run)
  await page.evaluate(async () => {
    const { store } = window.Lair;
    const kai = store.backend.state.bookings.find((b) => b.id === 'bk-r21-kai');
    Object.assign(kai, { paid: true, paidAmount: 1500, status: 'done' });
    store.backend.commit();
    await store.refresh();
  });
  await settle(page, 500);
  const paid = await card(page, 'Rangi’s one-shot');
  check(`${tag} Kai paid: GM credited $15 for 3 players, nobody left to pay`,
    paid && JSON.stringify(paid.badges) === JSON.stringify(['GM credited $15 for 3 players']) && !paid.notes.some((n) => /still to pay/.test(n)), paid);
  // a page from before round 21 tapping Session done on a round 21 session hears there's nothing to tap
  const tapped = await page.evaluate(async () => window.Lair.store.backend.creditGm('gm-r21-rangi', {}));
  check(`${tag} Session done on a round 21 session: nothing to tap, and it's all done`,
    tapped.auto === true && tapped.status === 'none' && tapped.note === "Done: the GM has had their fee for every player who's paid.", tapped);

  // Round 17's marks still work: Not in their hours, Ana works Mondays to 11:59pm, so tonight's session is kept from her;
  // the main account says she wasn't working (two taps), and she's credited
  const weekday = await page.evaluate(() => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][window.Lair.store.time.weekday(window.Lair.store.time.today())]);
  await page.evaluate(async ([ana, day]) => {
    const be = window.Lair.store.backend;
    await be.teamGmCredit('shifts');
    await be.teamHours(ana, [{ day, from: '16:00', to: '23:59' }]);
    await window.Lair.store.refresh();
  }, [ANA, weekday]);
  await settle(page, 500);
  const kept = await card(page, 'Ana’s staff one-shot');
  const off = '.staff-gm-card [data-act="credit"][data-value="off"]';
  check(`${tag} Not in their hours: Ana’s kept session offers the main account They weren’t working: credit $5`,
    kept && JSON.stringify(kept.buttons) === JSON.stringify(['They weren’t working: credit $5']), kept);
  await page.click(off);
  await settle(page, 150);
  await page.click(off);
  await settle(page, 600);
  const marked = await card(page, 'Ana’s staff one-shot');
  check(`${tag} Marked not working: GM credited $5 for 1 player, no buttons left`,
    marked && JSON.stringify(marked.badges) === JSON.stringify(['GM credited $5 for 1 player']) && marked.buttons.length === 0, marked);
  await shot(page, `${size}-marked`, '[data-panel="games"]');
  await ctx.close();
}

await browser.close();
server.close();
const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

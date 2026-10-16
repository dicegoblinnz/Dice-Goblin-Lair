// Open seats (16 Oct 2026, contract v18-open-seats), on the theme mock: taking a weekly regular off every session.
// The staff page's GM games manager (a regular's Remove asks just this session or every session, with Keep them; a
// one-off seat keeps its two taps), the GM page for a staff GM in his own weekly game (Take a player off asks the same
// for a regular), the live backend's body ({ scope: 'series' }), focus, no sideways scroll and axe. Phone and desktop.
// Usage: DG_THEME=/path/to/theme [PORT=4992] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round18/open-seats.mjs [phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-open-seats');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, context, watch, go, STAFF } = lib;
const PORT = Number(process.env.PORT || 4992);
const BASE = `http://localhost:${PORT}`;
const sizes = process.argv[2] ? [process.argv[2]] : ['phone', 'desktop'];
// Tama: a helper with Library only, who runs the weekly game (a staff GM)
const TAMA = { id: 7203, first_name: 'Tama', name: 'Tama Rewi', email: 'tama@example.com', phone: '', tags: [] };

const server = await m.serve(PORT);
const browser = await chromium.launch();

const toast = (page) => page.evaluate(() => (document.querySelector('[data-live-region]')?.textContent || '').trim());
const settle = (page, ms = 400) => page.waitForTimeout(ms);

/**
 * The demo, through its own backend: Tama on the team (Library only), and his weekly game, tomorrow and the week after
 * at 6pm (4 seats, $15). Kai's a regular, with a seat at both; Mia booked tomorrow's one-off.
 */
const seed = (page) => page.evaluate(async (tama) => {
  const { store } = window.Lair;
  const be = store.backend;
  const t = store.time;
  const team = be.teamState();
  if (!team.helpers.some((h) => h.customerId === tama)) team.helpers.push({ customerId: tama, perms: ['library'], since: Date.now(), updatedAt: Date.now(), madeBy: 'demo-owner' });
  const days = [t.addDays(t.today(), 1), t.addDays(t.today(), 8)];
  const game = (id, day) => ({
    id, title: 'Tama’s campaign', system: 'D&D 5e', gm: 'Tama', gmCustomerId: tama, gmEmail: 'tama@example.com', blurb: 'A weekly campaign.',
    tables: ['G1'], room: 'game-room', seats: 4, start: t.at(day, 18 * 60), end: t.at(day, 21 * 60), taken: 0, status: 'open', credited: null,
    gmFee: 500, seatPrice: 1500, schedule: 'weekly', seriesId: 'sr-os-tama', level: 'new', age: '18+', tags: [], safety: [], characters: 'pregens', bring: '',
    contentNotes: '', sessionZero: '', image: null, gmFeeApproved: true,
  });
  const seat = (id, ref, g, name, extra = {}) => ({
    id, ref, kind: 'gm-seat', gameId: g.id, tables: g.tables, start: g.start, end: g.end, people: 1, players: [{ name, character: '' }], name,
    email: `${name.toLowerCase()}@example.com`, status: 'confirmed', pay: 'day', paid: false, amount: 1500, paidAmount: 0, activity: 'rpg', extras: [],
    createdAt: Date.now() - 1000, ...extra,
  });
  be.state.games = be.state.games.filter((g) => !/^gm-os-/.test(g.id));
  be.state.bookings = be.state.bookings.filter((b) => !/^bk-os-/.test(b.id));
  be.state.seriesMembers = (be.state.seriesMembers || []).filter((x) => x.seriesId !== 'sr-os-tama');
  const [s1, s2] = days.map((day, i) => game(`gm-os-${i + 1}`, day));
  be.state.games.push(s1, s2);
  const kai = { customerId: '6002', seriesId: 'sr-os-tama', member: 'sm-os-kai' };
  be.state.bookings.push(
    seat('bk-os-kai-1', 'KA-WEEK-1', s1, 'Kai', kai),
    seat('bk-os-kai-2', 'KA-WEEK-2', s2, 'Kai', kai),
    seat('bk-os-mia', 'MI-ONCE-3', s1, 'Mia', { createdAt: Date.now() }),
  );
  be.state.seriesMembers.push({ id: 'sm-os-kai', seriesId: 'sr-os-tama', customerId: '6002', people: 1, players: [{ name: 'Kai', character: '' }], name: 'Kai', email: 'kai@example.com', since: Date.now() - 7 * 86400000 });
  s1.taken = 2;
  s2.taken = 1;
  be.commit();
  await store.refresh();
  return { s1: s1.id, s2: s2.id };
}, String(TAMA.id));

const stateOf = (page) => page.evaluate(() => {
  const be = window.Lair.store.backend;
  const status = (id) => be.state.bookings.find((b) => b.id === id)?.status;
  return {
    kai1: status('bk-os-kai-1'), kai2: status('bk-os-kai-2'), mia: status('bk-os-mia'),
    regular: (be.state.seriesMembers || []).some((x) => x.id === 'sm-os-kai'),
  };
});

/** The staff page, on the GM games tab, managing tomorrow's session */
async function staffManager(page, s1) {
  await page.click('[data-tab="games"]');
  await page.waitForSelector(`[data-gm-manage="${s1}"]`, { timeout: 15000 });
  await page.click(`button.staff-gm-row[data-gm-manage="${s1}"]`);
  await page.waitForSelector('[data-gm-players] .staff-players', { timeout: 15000 });
}
const players = (page) => page.evaluate(() => [...document.querySelectorAll('[data-gm-players] .staff-player')].map((li) => ({
  who: (li.querySelector('.staff-player__names')?.textContent || '').replace(/\s+/g, ' ').trim(),
  out: li.classList.contains('is-out'),
  acts: [...li.querySelectorAll('[data-act]')].map((b) => `${b.dataset.act}:${b.textContent.trim()}`),
})));

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';

  /* ---------- the staff page: a regular's Remove ---------- */
  let ctx = await context(browser, size);
  let page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/lair-staff', STAFF);
  await page.waitForSelector('#checkin-code', { timeout: 20000 });
  let ids = await seed(page);
  await staffManager(page, ids.s1);
  const first = await players(page);
  const kaiRow = first.find((p) => p.who.startsWith('Kai'));
  const miaRow = first.find((p) => p.who.startsWith('Mia'));
  check(`${tag} staff: Kai (a regular) has Remove that asks; Mia's one-off seat keeps the two-tap Remove`,
    kaiRow && kaiRow.acts.includes('remove-ask:Remove') && /Regular/.test(kaiRow.who) && miaRow && miaRow.acts.includes('remove:Remove'), first);

  await page.click('[data-act="remove-ask"][data-id="bk-os-kai-1"]');
  await page.waitForSelector('[data-act="remove-session"][data-id="bk-os-kai-1"]');
  const ask = await page.evaluate(() => ({
    text: (document.querySelector('.staff-player__ask p')?.textContent || '').replace(/\s+/g, ' ').trim(),
    buttons: [...document.querySelectorAll('.staff-player__ask [data-act]')].map((b) => b.textContent.trim()),
    focus: document.activeElement?.dataset?.act || '',
    group: document.querySelector('.staff-player__ask')?.getAttribute('role'),
  }));
  check(`${tag} staff: Kai's Remove asks "Take Kai off just this session, or every session?", with Just this session, Every session and Keep them, focus on the first`,
    /^Take Kai off just this session, or every session\? They’re a regular\. Just this session: Gobgob saves their seat again next time\. Every session: they stop being a regular, and their seats to come are freed\.$/.test(ask.text)
    && JSON.stringify(ask.buttons) === JSON.stringify(['Just this session', 'Every session', 'Keep them']) && ask.focus === 'remove-session' && ask.group === 'group', ask);
  await shot(page, `${size}-staff-ask`, '[data-gm-players]');
  await axe(page, `${tag} staff: the regular's question`, '[data-gm-players]');
  check(`${tag} staff: no sideways scroll with the question up`, (await overflowX(page)) <= 0, await overflowX(page));

  // Keep them: back to the seat's buttons, focus on Kai's Remove
  await page.click('[data-act="remove-keep"][data-id="bk-os-kai-1"]');
  await settle(page, 200);
  const kept = await page.evaluate(() => ({ ask: Boolean(document.querySelector('.staff-player__ask')), focus: `${document.activeElement?.dataset?.act}:${document.activeElement?.dataset?.id}` }));
  check(`${tag} staff: Keep them puts the buttons back, focus on Kai's Remove, nothing changed`,
    !kept.ask && kept.focus === 'remove-ask:bk-os-kai-1' && JSON.stringify(await stateOf(page)) === JSON.stringify({ kai1: 'confirmed', kai2: 'confirmed', mia: 'confirmed', regular: true }), kept);

  // Every session
  await page.click('[data-act="remove-ask"][data-id="bk-os-kai-1"]');
  await page.click('[data-act="remove-every"][data-id="bk-os-kai-1"]');
  await settle(page, 600);
  const every = { toast: await toast(page), state: await stateOf(page), focus: await page.evaluate(() => document.activeElement?.id || '') };
  check(`${tag} staff: Every session takes Kai off tomorrow and the week after, he's not a regular any more, and the toast says so`,
    every.toast === 'Removed Kai from every session. Gobgob’s stopped saving their seat. Their seat at a later session is free again too.'
    && JSON.stringify(every.state) === JSON.stringify({ kai1: 'cancelled', kai2: 'cancelled', mia: 'confirmed', regular: false }), every);
  check(`${tag} staff: focus goes to the Players heading after Every session`, every.focus === 'gm-players-h', every.focus);
  // Mia (a one-off seat): two taps, as before
  await page.click('[data-act="remove"][data-id="bk-os-mia"]');
  const armed = await page.evaluate(() => document.querySelector('[data-act="remove"][data-id="bk-os-mia"]')?.textContent.trim());
  await page.click('[data-act="remove"][data-id="bk-os-mia"]');
  await settle(page, 500);
  check(`${tag} staff: Mia's one-off seat is two taps (Tap again to remove), then Removed Mia from the game`,
    armed === 'Tap again to remove' && (await toast(page)) === 'Removed Mia from the game' && (await stateOf(page)).mia === 'cancelled', { armed, toast: await toast(page) });

  // Just this session: Kai stays a regular, his seat next week stays
  ids = await seed(page);
  await page.click('[data-gm-back]');
  await staffManager(page, ids.s1);
  await page.click('[data-act="remove-ask"][data-id="bk-os-kai-1"]');
  await page.click('[data-act="remove-session"][data-id="bk-os-kai-1"]');
  await settle(page, 600);
  const once = { toast: await toast(page), state: await stateOf(page), focus: await page.evaluate(() => document.activeElement?.id || '') };
  check(`${tag} staff: Just this session takes Kai off tomorrow only; he's still a regular with next week's seat, and the toast says so`,
    once.toast === 'Removed Kai from this session. They’re still a regular, so Gobgob saves their seat next time.'
    && JSON.stringify(once.state) === JSON.stringify({ kai1: 'cancelled', kai2: 'confirmed', mia: 'confirmed', regular: true }) && once.focus === 'gm-players-h', once);
  check(`${tag} staff page: no script errors`, !page.errors.length, page.errors.slice(0, 5));
  await ctx.close();

  /* ---------- the GM page, for Tama (a staff GM) in his own weekly game ---------- */
  ctx = await context(browser, size);
  page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gm-games', TAMA);
  await page.waitForSelector('gm-board', { state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend, null, { timeout: 20000 });
  ids = await seed(page);
  const open = async () => {
    await page.evaluate(async (gid) => {
      const board = document.querySelector('gm-board');
      await board.loadAccount();
      board.openGame(gid);
    }, ids.s1);
    await page.waitForSelector('.gm-roster', { timeout: 15000 });
  };
  await open();
  // Mia (one-off): Keep them and Take them off, as before
  await page.click('[data-roster-remove="MI-ONCE-3"]');
  await page.waitForSelector('[data-roster-remove-do]');
  const miaAsk = await page.evaluate(() => [...document.querySelectorAll('[data-back-to], [data-roster-remove-do]')].map((b) => b.textContent.trim()));
  check(`${tag} GM page: a one-off seat's sheet is Keep them and Take them off`, JSON.stringify(miaAsk) === JSON.stringify(['Keep them', 'Take them off']), miaAsk);
  await page.click('[data-back-to]');
  await page.waitForSelector('.gm-roster', { timeout: 10000 });
  // Kai (a regular): the question, then Every session
  await page.click('[data-roster-remove="KA-WEEK-1"]');
  await page.waitForSelector('[data-roster-remove-do][data-scope="series"]');
  const kaiAsk = await page.evaluate(() => ({
    text: (document.querySelector('.gm-confirm')?.textContent || '').replace(/\s+/g, ' ').trim(),
    buttons: [...document.querySelectorAll('[data-back-to], [data-roster-remove-do]')].map((b) => b.textContent.trim()),
    focus: Boolean(document.activeElement?.matches('.gm-confirm .h3')),
  }));
  check(`${tag} GM page: a regular's sheet asks just this session or every session (Keep them, Just this session, Every session), focus on the question`,
    /^Take Kai off just this session, or every session\? Tama’s campaign, .+ They’re a regular\. Just this session: Gobgob saves their seat again next time\. Every session: they stop being a regular, and their seats to come are freed\. Gobgob doesn’t email them, so let them know\.$/.test(kaiAsk.text)
    && JSON.stringify(kaiAsk.buttons) === JSON.stringify(['Keep them', 'Just this session', 'Every session']) && kaiAsk.focus, kaiAsk);
  await shot(page, `${size}-gm-ask`, '.gm-sheet');
  await axe(page, `${tag} GM page: the regular's question`, '.gm-sheet');
  check(`${tag} GM page: no sideways scroll with the question up`, (await overflowX(page)) <= 0, await overflowX(page));
  await page.click('[data-roster-remove-do][data-scope="series"]');
  await page.waitForSelector('.gm-flash', { timeout: 10000 });
  const gmEvery = await page.evaluate(() => ({
    flash: (document.querySelector('.gm-flash')?.textContent || '').trim(),
    focus: Boolean(document.activeElement?.classList.contains('gm-flash')),
    rows: [...document.querySelectorAll('.gm-roster__item')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
  }));
  check(`${tag} GM page: Every session takes Kai off for good (his seat next week too), says so, focus on what happened`,
    gmEvery.flash === 'Took Kai off every session. Their seat’s free for someone else. They’re not a regular any more, so Gobgob won’t save their seat again. Their seat at a later session is free too.'
    && gmEvery.focus && !gmEvery.rows.some((x) => x.includes('Kai'))
    && JSON.stringify(await stateOf(page)) === JSON.stringify({ kai1: 'cancelled', kai2: 'cancelled', mia: 'confirmed', regular: false }), gmEvery);
  // again, Just this session
  ids = await seed(page);
  await open();
  await page.click('[data-roster-remove="KA-WEEK-1"]');
  await page.waitForSelector('[data-roster-remove-do]:not([data-scope])');
  await page.click('[data-roster-remove-do]:not([data-scope])');
  await page.waitForSelector('.gm-flash', { timeout: 10000 });
  const gmOnce = await page.evaluate(() => (document.querySelector('.gm-flash')?.textContent || '').trim());
  check(`${tag} GM page: Just this session takes Kai off tomorrow only, and says he's still a regular`,
    gmOnce === 'Took Kai off. Their seat’s free for someone else. They’re still a regular, so Gobgob saves their seat next time.'
    && JSON.stringify(await stateOf(page)) === JSON.stringify({ kai1: 'cancelled', kai2: 'confirmed', mia: 'confirmed', regular: true }), gmOnce);
  check(`${tag} GM page: no script errors`, !page.errors.length, page.errors.slice(0, 5));
  await ctx.close();

  /* ---------- live: the body for every session, against a stubbed Lair app ---------- */
  m.globalSettings.lair_mode = 'live';
  const calls = [];
  m.mockState.before = async (req, res, url) => {
    if (!url.pathname.startsWith('/apps/liar/')) return false;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const route = url.pathname.replace('/apps/liar', '');
    if (req.method === 'POST') calls.push({ path: route, body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ game: {}, booking: {}, refund: { due: false, amount: 0 }, regular: null }));
    return true;
  };
  const lctx = await context(browser, size);
  const lp = watch(await lctx.newPage());
  await go(lp, BASE, '/pages/my-lair', STAFF);
  await lp.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend, null, { timeout: 20000 });
  await lp.evaluate(async () => {
    const be = window.Lair.store.backend;
    await be.removeGamePlayer('gm_1', 'SJ-OWLBEAR-17');
    await be.removeGamePlayer('gm_1', 'KA-WEEK-1', { scope: 'series' });
  });
  check(`${tag} live: Remove sends {} for one session and { scope: 'series' } for every session`,
    JSON.stringify(calls.filter((x) => /^\/games\//.test(x.path))) === JSON.stringify([
      { path: '/games/gm_1/players/SJ-OWLBEAR-17/remove', body: {} },
      { path: '/games/gm_1/players/KA-WEEK-1/remove', body: { scope: 'series' } },
    ]), calls);
  await lctx.close();
  m.mockState.before = null;
  m.globalSettings.lair_mode = 'demo';
}

const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed. Screens in ${process.env.OUT}`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

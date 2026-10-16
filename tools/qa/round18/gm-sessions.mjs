// Round 18 (16 Oct 2026), more for GM sessions, on the theme mock: the staff page's GM games manager (Free and Charge
// again, with the paid-seat refusal; Seats for new players; Change the GM by email; the New player badge and tick), the
// GM page for a staff GM in their own game (the roster with its badges, Reserve a seat, Seats for new players, Take a
// player off), the GM page for a player (the seats kept for new players: someone who's played before and someone new;
// a free session's card, details and join form), the live backend's four calls against a stubbed Lair app, no sideways
// scroll and axe. Phone and desktop.
// Usage: DG_THEME=/path/to/theme [PORT=4991] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round18/gm-sessions.mjs [phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round18-gm-sessions');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, context, watch, go, STAFF, RUBY } = lib;
const PORT = Number(process.env.PORT || 4991);
const BASE = `http://localhost:${PORT}`;
const sizes = process.argv[2] ? [process.argv[2]] : ['phone', 'desktop'];
// Tama: a helper with Library only, who runs a session (a staff GM); Rangi: a GM who isn't staff
const TAMA = { id: 7203, first_name: 'Tama', name: 'Tama Rewi', email: 'tama@example.com', phone: '', tags: [] };
const NEWBIE = { id: 7204, first_name: 'Lee', name: 'Lee Brown', email: 'lee@example.com', phone: '', tags: [] };

const server = await m.serve(PORT);
const browser = await chromium.launch();

/** The staff page's last toast */
const toast = (page) => page.evaluate(() => (document.querySelector('[data-live-region]')?.textContent || '').trim());
const settle = (page, ms = 350) => page.waitForTimeout(ms);

/**
 * The demo, through its own backend: Tama on the team (Library only), and his session tomorrow 6pm to 9pm (4 seats,
 * $15: $10 table, $5 GM fee) with Kai (2 seats; Kai played at last week's session, so he isn't new) and Mia (new);
 * Ruby's seat last week too (so she isn't new). Rangi's session tomorrow too, for a GM who isn't staff.
 */
const seed = (page, { kept = 0, free = false, kaiPaid = false } = {}) => page.evaluate(async ([tama, ruby, keptSeats, isFree, paid]) => {
  const { store } = window.Lair;
  const be = store.backend;
  const t = store.time;
  const team = be.teamState();
  if (!team.helpers.some((h) => h.customerId === tama)) team.helpers.push({ customerId: tama, perms: ['library'], since: Date.now(), updatedAt: Date.now(), madeBy: 'demo-owner' });
  const tomorrow = t.addDays(t.today(), 1);
  const lastWeek = t.addDays(t.today(), -7);
  const game = (id, gm, gmCustomerId, day, extra = {}) => ({
    id, title: `${gm}’s one-shot`, system: 'D&D 5e', gm, gmCustomerId, gmEmail: `${gm.toLowerCase()}@example.com`, blurb: 'A test session.',
    tables: [gm === 'Rangi' ? 'G2' : 'G1'], room: 'game-room', seats: 4, start: t.at(day, 18 * 60), end: t.at(day, 21 * 60), taken: 0, status: 'open', credited: null,
    gmFee: 500, seatPrice: 1500, schedule: 'one-shot', seriesId: null, level: 'new', age: '18+', tags: [], safety: [], characters: 'pregens', bring: '',
    contentNotes: '', sessionZero: '', image: null, gmFeeApproved: true, ...extra,
  });
  const seat = (id, ref, g, name, email, people, extra = {}) => ({
    id, ref, kind: 'gm-seat', gameId: g.id, tables: g.tables, start: g.start, end: g.end, people,
    players: Array.from({ length: people }, (_, i) => ({ name: i ? `${name} +${i}` : name, character: i ? '' : 'Brakka' })), name, email, status: 'confirmed',
    pay: 'day', paid: false, amount: 1500 * people, paidAmount: 0, activity: 'rpg', extras: [], createdAt: Date.now() - (people * 1000), ...extra,
  });
  be.state.games = be.state.games.filter((g) => !/^gm-r18-/.test(g.id));
  be.state.bookings = be.state.bookings.filter((b) => !/^bk-r18-/.test(b.id));
  const past = game('gm-r18-past', 'Ana', 'demo-ana', lastWeek, { status: 'open', credited: 2 });
  const mine = game('gm-r18-tama', 'Tama', tama, tomorrow, { newSeats: keptSeats, free: isFree });
  const rangis = game('gm-r18-rangi', 'Rangi', 'demo-rangi', tomorrow);
  be.state.games.push(past, mine, rangis);
  be.state.bookings.push(
    seat('bk-r18-kai-past', 'KA-PAST-1', past, 'Kai', 'kai@example.com', 1, { status: 'done', paid: true, paidAmount: 1500 }),
    seat('bk-r18-ruby-past', 'RU-PAST-2', past, 'Ruby', ruby.email, 1, { status: 'done', paid: true, paidAmount: 1500, customerId: String(ruby.id) }),
    seat('bk-r18-kai', 'KA-OWL-3', mine, 'Kai', 'kai@example.com', 2, paid ? { paid: true, paidAmount: 3000 } : {}),
    seat('bk-r18-mia', 'MI-OWL-4', mine, 'Mia', 'mia@example.com', 1, { newPlayer: true, createdAt: Date.now() }),
  );
  mine.taken = 3;
  if (isFree) be.state.bookings.filter((b) => b.gameId === mine.id && !b.paid).forEach((b) => { b.amount = 0; });
  be.commit();
  await store.refresh();
  return { id: mine.id, rangi: rangis.id, tomorrow };
}, [String(TAMA.id), RUBY, kept, free, kaiPaid]);

/** The demo's state of one booking or game */
const stateOf = (page, kind, id) => page.evaluate(([k, x]) => {
  const be = window.Lair.store.backend;
  const row = (k === 'game' ? be.state.games : be.state.bookings).find((r) => r.id === x);
  return row ? JSON.parse(JSON.stringify(row)) : null;
}, [kind, id]);

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';

  /* ---------- the staff page's GM games manager ---------- */
  let ctx = await context(browser, size);
  let page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/lair-staff', STAFF);
  await page.waitForSelector('#checkin-code', { timeout: 20000 });
  const { id } = await seed(page);
  await page.click('[data-tab="games"]');
  await page.waitForSelector(`[data-gm-manage="${id}"]`, { timeout: 15000 });
  await page.click(`button.staff-gm-row[data-gm-manage="${id}"]`);
  await page.waitForSelector('[data-gm-run-wrap] [data-gm-newseats]', { timeout: 15000 });
  const run = await page.evaluate(() => {
    const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    const sec = document.querySelector('[data-gm-run-wrap]');
    return {
      h: f(sec.querySelector('h4').textContent),
      price: f(sec.querySelector('[data-gm-free-wrap] p').textContent),
      free: f(sec.querySelector('[data-gm-free]').textContent),
      seats: sec.querySelector('[data-gm-newseats] [name="seats"]').value,
      change: f(sec.querySelector('.staff-gm__change summary').textContent),
      mia: f([...document.querySelectorAll('.staff-player')].find((li) => li.textContent.includes('Mia'))?.querySelector('.staff-player__names')?.textContent),
    };
  });
  check(`${tag} staff: the manager has Free, new players and the GM: $15 a seat, Make it free, Seats for new players 0, Change the GM (now Tama), and Mia's New player badge`,
    run.h === 'Free, new players and the GM' && /^\$15 a seat /.test(run.price) && run.free === 'Make it free' && run.seats === '0'
    && run.change === 'Change the GM · now Tama, on their account' && run.mia === 'Mia as Brakka Reserved: no account yet New player', run);
  await shot(page, `${size}-staff-run`, '[data-gm-run-wrap]');
  await axe(page, `${tag} staff GM manager with round 18's section`, '.staff-gm');
  check(`${tag} staff manager: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));

  // Seats for new players: 2
  await page.click('[data-gm-newseats] [data-seats-step="1"]');
  await page.click('[data-gm-newseats] [data-seats-step="1"]');
  await page.click('[data-gm-newseats] [type="submit"]');
  await settle(page, 600);
  const kept = await page.evaluate(() => [...document.querySelectorAll('.staff-gm__badges .badge')].map((b) => b.textContent.trim()));
  check(`${tag} staff: Seats for new players 2 saved: the toast, the game's newSeats, and the badge (1 still open: Mia has one)`,
    (await toast(page)) === 'Saved: 2 seats are kept for new players.' && (await stateOf(page, 'game', id)).newSeats === 2 && kept.includes('2 seats for new players, 1 open'), { toast: await toast(page), kept });

  // Make it free (two taps)
  await page.click('[data-gm-free="true"]');
  await settle(page, 150);
  const asked = await page.evaluate(() => document.querySelector('[data-gm-free="true"]')?.textContent.trim());
  await page.click('[data-gm-free="true"]');
  await settle(page, 600);
  const freed = await page.evaluate(() => ({
    head: String(document.querySelector('[data-gm-head] .small')?.textContent || '').replace(/\s+/g, ' ').trim(),
    badge: [...document.querySelectorAll('.staff-gm__badges .badge')].some((b) => b.textContent.trim() === 'Free'),
    button: document.querySelector('[data-gm-free]')?.textContent.trim(),
    pay: [...document.querySelectorAll('.staff-player .small')].map((p) => p.textContent.replace(/\s+/g, ' ').trim()),
  }));
  const kai = await stateOf(page, 'booking', 'bk-r18-kai');
  check(`${tag} staff: Make it free asks first (Tap again to make it free), then the session is free: the toast, the header, the Free badge, $0 seats, Charge $15 a seat again`,
    asked === 'Tap again to make it free' && /^Free now: Tama’s one-shot, Tomorrow. Players pay nothing, and there’s no GM credit.$/.test(await toast(page))
    && /Free: nothing to pay, no GM credit/.test(freed.head) && freed.badge && freed.button === 'Charge $15 a seat again' && kai.amount === 0
    && freed.pay.every((p) => /Free/.test(p)), { asked, toast: await toast(page), freed, kai: kai.amount });
  // and back
  await page.click('[data-gm-free="false"]');
  await settle(page, 150);
  await page.click('[data-gm-free="false"]');
  await settle(page, 600);
  check(`${tag} staff: Charge $15 a seat again puts the price back on the unpaid seats`,
    (await stateOf(page, 'booking', 'bk-r18-kai')).amount === 3000 && (await page.evaluate(() => document.querySelector('[data-gm-free]')?.textContent.trim())) === 'Make it free', await toast(page));
  // a seat paid already: refused, in the Lair app's words
  await page.evaluate(() => {
    const be = window.Lair.store.backend;
    Object.assign(be.state.bookings.find((b) => b.id === 'bk-r18-kai'), { paid: true, paidAmount: 3000 });
    be.commit();
    return window.Lair.store.refresh();
  });
  await settle(page);
  await page.click('[data-gm-free="true"]');
  await settle(page, 150);
  await page.click('[data-gm-free="true"]');
  await settle(page, 600);
  check(`${tag} staff: with seats paid already, Make it free says to refund them first, and it stays priced`,
    (await toast(page)) === '2 seats are paid for already, or on a session pass. Refund them (or undo the pass) first, then make it free.' && !(await stateOf(page, 'game', id)).free, await toast(page));

  // Change the GM, to someone invited by email
  await page.click('.staff-gm__change summary');
  await page.fill('[data-gm-change] [name="gmEmail"]', 'nova@example.com');
  await page.fill('[data-gm-change] [name="gm"]', 'Nova');
  await shot(page, `${size}-staff-change-gm`, '.staff-gm__change');
  await axe(page, `${tag} Change the GM, open`, '.staff-gm__change');
  await page.click('[data-gm-change] [type="submit"]');
  await settle(page, 700);
  const changed = await stateOf(page, 'game', id);
  const headGm = await page.evaluate(() => String(document.querySelector('[data-gm-head] .small')?.textContent || '').replace(/\s+/g, ' ').trim());
  check(`${tag} staff: Change the GM by email: Nova runs it now, invited (the toast says so), and the header says GM Nova`,
    changed.gm === 'Nova' && changed.gmCustomerId === null && changed.gmEmail === 'nova@example.com'
    && (await toast(page)) === 'Nova runs Tama’s one-shot on Tomorrow now. Gobgob emailed nova@example.com to make an account. The game joins their account when they log in with that email.'
    && /GM Nova/.test(headGm), { changed: [changed.gm, changed.gmCustomerId, changed.gmEmail], toast: await toast(page), headGm });

  // Add players: the New to our TTRPG sessions tick
  await page.fill('[data-gm-add] [name="name"]', 'Sam Friend');
  await page.check('[data-gm-add] [name="newPlayer"]');
  await page.click('[data-gm-add] [type="submit"]');
  await settle(page, 600);
  const sam = await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const b = be.state.bookings.find((x) => x.name === 'Sam Friend' && x.gameId === 'gm-r18-tama');
    const li = [...document.querySelectorAll('.staff-player')].find((x) => x.textContent.includes('Sam Friend'));
    return { newPlayer: b && b.newPlayer, badge: Boolean(li && /New player/.test(li.textContent)) };
  });
  check(`${tag} staff: Add players with New to our TTRPG sessions ticked marks the seat new, with the badge`, sam.newPlayer === true && sam.badge, sam);
  check(`${tag} staff page: no script errors`, !page.errors.length, page.errors.slice(0, 5));
  await ctx.close();

  /* ---------- the GM page, for Tama (a staff GM) in his own game ---------- */
  ctx = await context(browser, size);
  page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gm-games', TAMA);
  await page.waitForSelector('gm-board', { state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend, null, { timeout: 20000 });
  const seeded = await seed(page, { kept: 0 });
  await page.evaluate(async (gid) => {
    const board = document.querySelector('gm-board');
    await board.loadAccount();
    board.openGame(gid);
  }, seeded.id);
  await page.waitForSelector('.gm-roster', { timeout: 15000 });
  const own = await page.evaluate(() => {
    const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    const sec = document.querySelector('.gm-own');
    return {
      rows: [...sec.querySelectorAll('.gm-roster__item')].map((li) => ({ who: f(li.querySelector('.gm-roster__who > span').textContent), meta: f(li.querySelector('.gm-roster__meta').textContent), remove: li.querySelector('[data-roster-remove]')?.getAttribute('aria-label') || '' })),
      head: f(sec.querySelector('.gm-own__head').textContent),
      seats: sec.querySelector('[data-newseats-form] [name="seats"]')?.value,
      reserve: Boolean(sec.querySelector('[data-reserve]')),
    };
  });
  check(`${tag} GM page: Tama (a staff GM, Library only) gets his game's roster: Kai's 2 seats ($30 to pay), Mia new, each with Remove; Seats for new players None; Reserve a seat`,
    JSON.stringify(own.rows) === JSON.stringify([
      { who: 'Kai as Brakka, Kai +1', meta: '2 seats · $30 to pay', remove: 'Remove Kai' },
      { who: 'Mia as Brakka New player', meta: '1 seat · $15 to pay', remove: 'Remove Mia' },
    ]) && /3 of 4 seats taken$/.test(own.head) && own.seats === '0' && own.reserve, own);
  await shot(page, `${size}-gm-own-roster`, '.gm-own');
  await axe(page, `${tag} GM page, a staff GM's own game`, '.gm-sheet');
  check(`${tag} GM page sheet: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));

  // Seats for new players: 1
  await page.selectOption('[data-newseats-form] [name="seats"]', '1');
  await page.click('[data-newseats-form] [type="submit"]');
  await page.waitForSelector('.gm-flash', { timeout: 10000 });
  const flash1 = await page.evaluate(() => document.querySelector('.gm-flash')?.textContent.trim());
  check(`${tag} GM page: Seats for new players 1 saved (the flash, the game)`, flash1 === 'Saved. 1 seat is kept for new players.' && (await stateOf(page, 'game', seeded.id)).newSeats === 1, flash1);

  // Reserve a seat for someone new
  await page.click('[data-reserve]');
  await page.waitForSelector('[data-reserve-form]');
  await axe(page, `${tag} Reserve a seat`, '.gm-sheet');
  await page.fill('[data-reserve-form] [name="name"]', 'Pat Lee');
  await page.fill('[data-reserve-form] [name="email"]', 'not-an-email');
  await page.click('[data-reserve-send]');
  await settle(page, 300);
  const badEmail = await page.evaluate(() => document.querySelector('[data-reserve-form] .field__error')?.textContent.trim());
  await page.fill('[data-reserve-form] [name="email"]', 'pat@example.com');
  await page.check('[data-reserve-form] [name="newPlayer"]');
  await shot(page, `${size}-gm-reserve`, '.gm-sheet');
  await page.click('[data-reserve-send]');
  await page.waitForSelector('.gm-flash', { timeout: 10000 });
  const reserved = await page.evaluate(() => ({
    flash: document.querySelector('.gm-flash')?.textContent.trim(),
    row: [...document.querySelectorAll('.gm-roster__item')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()).find((x) => x.includes('Pat Lee')) || '',
    gmTold: (window.Lair.store.backend.state.outbox || []).some((mail) => mail.kind === 'gm-new-player' && /Pat Lee/.test(mail.subject)),
  }));
  check(`${tag} GM page: Reserve a seat checks the email, then reserves it for someone new (the flash, the roster's New player), and Tama isn't emailed about his own add`,
    badEmail === 'That email doesn’t look right.' && reserved.flash === 'Reserved a seat for Pat Lee. They’re new to our TTRPG sessions.'
    && /New player/.test(reserved.row) && !reserved.gmTold, { badEmail, reserved });

  // Take Kai off
  await page.click('[data-roster-remove="KA-OWL-3"]');
  await page.waitForSelector('[data-roster-remove-do]');
  const confirm = await page.evaluate(() => String(document.querySelector('.gm-confirm')?.textContent || '').replace(/\s+/g, ' ').trim());
  await axe(page, `${tag} Take a player off`, '.gm-sheet');
  await page.click('[data-roster-remove-do]');
  await page.waitForSelector('.gm-flash', { timeout: 10000 });
  const gone = await page.evaluate(() => ({
    flash: document.querySelector('.gm-flash')?.textContent.trim(),
    rows: [...document.querySelectorAll('.gm-roster__item')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
  }));
  check(`${tag} GM page: Take a player off asks first (Gobgob doesn't email them), then Kai's 2 seats are free`,
    /^Take Kai and Kai \+1 off .+\?/.test(confirm) && /Gobgob doesn’t email them, so let them know\./.test(confirm)
    && gone.flash === 'Took Kai and Kai +1 off. Their seat’s free for someone else.' && !gone.rows.some((x) => x.includes('Kai'))
    && (await stateOf(page, 'booking', 'bk-r18-kai')).status === 'cancelled', { confirm, gone });

  // Rangi's game (not staff) on Tama's page: no roster; and a GM who isn't staff gets none in his own
  const rangi = await page.evaluate((rid) => {
    const g = window.Lair.store.data.games.find((x) => x.id === rid);
    return { roster: g ? Array.isArray(g.roster) : 'missing' };
  }, seeded.rangi);
  check(`${tag} GM page: no roster for a game Tama doesn't run`, rangi.roster === false, rangi);
  check(`${tag} GM page (Tama): no script errors`, !page.errors.length, page.errors.slice(0, 5));
  await ctx.close();

  /* ---------- the GM page, for players: kept seats and a free session ---------- */
  ctx = await context(browser, size);
  page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gm-games', RUBY);
  await page.waitForSelector('gm-board', { state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend, null, { timeout: 20000 });
  // 1 seat left, kept for new players; Ruby played last week
  const forRuby = await seed(page, { kept: 2 });
  await page.evaluate(async (gid) => {
    const board = document.querySelector('gm-board');
    await board.loadAccount();
    board.openGame(gid);
  }, forRuby.id);
  await page.waitForSelector('.gm-facts', { timeout: 15000 });
  const ruby = await page.evaluate(() => {
    const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    return {
      note: f(document.querySelector('.gm-facts .gm-facts__seats')?.parentElement?.querySelector('.gm-facts__note')?.textContent),
      foot: f(document.querySelector('[data-sheet-foot]')?.textContent),
      join: Boolean(document.querySelector('[data-sheet-foot] [data-join]:not([data-every])')),
      newPlayer: document.querySelector('gm-board').newPlayer,
    };
  });
  check(`${tag} GM page: someone who's played before sees the last seat is kept for new players, with no Join`,
    ruby.newPlayer === false && ruby.note === 'It’s kept for players new to our TTRPG sessions.'
    && /The seats left are kept for players new to our TTRPG sessions/.test(ruby.foot) && !ruby.join, ruby);
  await shot(page, `${size}-gm-kept-ruby`, '.gm-sheet');
  check(`${tag} GM page (Ruby): no script errors`, !page.errors.length, page.errors.slice(0, 5));
  await ctx.close();

  ctx = await context(browser, size);
  page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gm-games', NEWBIE);
  await page.waitForSelector('gm-board', { state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend, null, { timeout: 20000 });
  const forNew = await seed(page, { kept: 2, free: true });
  // the demo gives a logged-in customer example seats on its first visit each day: Lee's are taken away, so he's new
  await page.evaluate(async ([gid, lee]) => {
    const { store } = window.Lair;
    const be = store.backend;
    await be.gmAccount();
    be.state.bookings = be.state.bookings.filter((b) => !(b.kind === 'gm-seat' && (String(b.customerId || '') === lee.id || String(b.email || '').toLowerCase() === lee.email)));
    be.commit();
    await store.refresh();
    const board = document.querySelector('gm-board');
    await board.loadAccount();
    board.renderList();
    board.openGame(gid);
  }, [forNew.id, { id: String(NEWBIE.id), email: NEWBIE.email }]);
  await page.waitForSelector('.gm-facts', { timeout: 15000 });
  const lee = await page.evaluate((gid) => {
    const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    const card = document.querySelector(`.gm-grid [data-game="${gid}"]`)?.closest('.gm-card');
    return {
      price: f(card?.querySelector('.gm-card__price')?.textContent),
      badges: [...(card?.querySelectorAll('.gm-card__tags .badge') || [])].map((b) => f(b.textContent)),
      note: f(document.querySelector('.gm-facts .gm-facts__seats')?.parentElement?.querySelector('.gm-facts__note')?.textContent),
      fee: f([...document.querySelectorAll('.gm-facts li')].map((li) => li.textContent).find((x) => /Free|a seat/.test(x))),
      join: f(document.querySelector('[data-sheet-foot] [data-join]:not([data-every])')?.textContent),
    };
  }, forNew.id);
  check(`${tag} GM page: a free session's card says Free (price and badge) and 1 seat for new players; someone new sees the seat is kept for them, Free, and Join · free`,
    lee.price === 'Free' && lee.badges.slice(0, 2).join('|') === 'Free|1 seat for new players'
    && lee.note === '1 seat is kept for players new to our TTRPG sessions, like you.' && lee.fee === 'Free (nothing to pay for this session)' && lee.join === 'Join · free', lee);
  await shot(page, `${size}-gm-free-detail`, '.gm-sheet');
  await page.click('[data-sheet-foot] [data-join]:not([data-every])');
  await page.waitForSelector('[data-join-form]', { timeout: 10000 });
  const form = await page.evaluate(() => {
    const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    return {
      legend: f(document.querySelector('.gm-seatfee legend')?.textContent),
      total: f(document.querySelector('[data-join-total]')?.textContent),
      button: f(document.querySelector('[data-join-submit]')?.textContent),
      kept: f(document.querySelector('.gm-join__kept')?.textContent),
      pass: Boolean(document.querySelector('[data-pass-pick], [data-use-pass]')),
    };
  });
  check(`${tag} join form: a free session's fee says Free, Nothing to pay, Join · free, and the kept seat note`,
    form.legend === 'Seat fee Free' && /^This session is free\s*Nothing to pay$/.test(form.total) && form.button === 'Join · free'
    && form.kept === '1 seat is kept for players new to our TTRPG sessions, like you.' && !form.pass, form);
  await shot(page, `${size}-gm-free-join`, '.gm-sheet');
  await axe(page, `${tag} join form for a free session`, '.gm-sheet');
  check(`${tag} join form: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  check(`${tag} GM page (Lee): no script errors`, !page.errors.length, page.errors.slice(0, 5));
  await ctx.close();

  /* ---------- live: the four calls, against a stubbed Lair app ---------- */
  m.globalSettings.lair_mode = 'live';
  const calls = [];
  m.mockState.before = async (req, res, url) => {
    if (!url.pathname.startsWith('/apps/liar/')) return false;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const route = url.pathname.replace('/apps/liar', '');
    if (req.method === 'POST') calls.push({ path: route, body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ game: {}, sessions: 1, booking: {}, refund: { due: false, amount: 0 } }));
    return true;
  };
  const lctx = await context(browser, size);
  const lp = watch(await lctx.newPage());
  await go(lp, BASE, '/pages/my-lair', STAFF);
  await lp.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend, null, { timeout: 20000 });
  await lp.evaluate(async () => {
    const be = window.Lair.store.backend;
    await be.removeGamePlayer('gm_1', 'SJ-OWLBEAR-17');
    await be.setNewSeats('gm_1', { seats: 2, scope: 'series' });
    await be.setGameFree('gm_1', { free: true, scope: 'session' });
    await be.changeGm('gm_1', { gmEmail: 'nova@example.com', gm: 'Nova' });
  });
  check(`${tag} live: POST /games/:id/players/:ref/remove, /new-seats, /free and /gm with their bodies`,
    JSON.stringify(calls.filter((x) => /^\/games\//.test(x.path))) === JSON.stringify([
      { path: '/games/gm_1/players/SJ-OWLBEAR-17/remove', body: {} },
      { path: '/games/gm_1/new-seats', body: { seats: 2, scope: 'series' } },
      { path: '/games/gm_1/free', body: { free: true, scope: 'session' } },
      { path: '/games/gm_1/gm', body: { gmEmail: 'nova@example.com', gm: 'Nova' } },
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

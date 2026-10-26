// Round 21, part 2 (26 Oct 2026, contract v21-gm-cover): a GM pays for one of their players, on the theme mock (demo
// mode). Mo: "have the option for the gm to pay for someone else if they wish from one of their players. Paying the full
// $10 for Thier time and they don't get store credit for them playing." Website and counter, until the player has paid.
//  1. The TTRPG sessions page, Dan's own game: Pay for them on Mia (unpaid), not on Kai (paid); the question and its
//     words (locked in 24 hours before, like any seat); Pay $10; You're paying with Stop paying; stopping puts it back.
//     Then the session moved to 3 hours away: You're paying: locked in, and no Stop paying.
//  2. My Lair as Dan: Mia's seat is one he pays for, and Players you're paying for lists it, $10, Pay at the counter;
//     locked in once it's 3 hours away.
//  3. My Lair as Mia: her seat says Your GM pays for it; 3 hours away, Locked in: your GM pays for it.
//  4. The staff page's session: The GM pays (two taps), then the GM's $10 on their account, Mark it paid, Stop (even
//     once it's paid: two taps, and the GM's $10 is a refund due).
// No sideways scroll and axe at each. Phone and desktop.
// Usage: DG_THEME=/path/to/theme [PORT=4987] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round21/gm-pays.mjs [phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round21-gm-pays');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, context, watch, go, STAFF } = lib;
const PORT = Number(process.env.PORT || 4987);
const BASE = `http://localhost:${PORT}`;
const sizes = process.argv[2] ? [process.argv[2]] : ['phone', 'desktop'];
const DAN = { id: 7310, first_name: 'Dan', last_name: 'Kerr', name: 'Dan Kerr', email: 'dan@example.com', phone: '', tags: ['gm'], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const MIA = { id: 7320, first_name: 'Mia', last_name: 'Chen', name: 'Mia Chen', email: 'mia@example.com', phone: '', tags: [], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const GAME = 'gm-r21-pays';

const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 350) => page.waitForTimeout(ms);
const ready = (page) => page.waitForFunction(() => Boolean(window.Lair && window.Lair.store && window.Lair.store.data && Array.isArray(window.Lair.store.data.games) && window.Lair.store.data.games.length), null, { timeout: 20000 });

/** The demo: Dan's one-shot next Friday 6pm to 10pm ($15 a seat, $5 GM fee), Mia booked (not paid) and Kai (paid) */
const seed = (page) => page.evaluate(async ([dan, mia, id]) => {
  const { store } = window.Lair;
  const be = store.backend;
  const t = store.time;
  let day = t.addDays(t.today(), 1);
  while (new Date(`${day}T12:00:00Z`).getUTCDay() !== 5) day = t.addDays(day, 1);
  const start = t.at(day, 18 * 60);
  const end = t.at(day, 22 * 60);
  be.state.games = be.state.games.filter((g) => g.id !== id);
  be.state.bookings = be.state.bookings.filter((b) => b.gameId !== id);
  be.state.games.push({
    id, title: 'The Sunless Citadel', system: 'D&D 5e', gm: 'Dan', gmCustomerId: dan, gmEmail: 'dan@example.com', blurb: "Dan's one-shot.", tables: ['G3'],
    room: 'gaming-room', seats: 4, start, end, taken: 2, status: 'open', credited: null, gmFee: 500, seatPrice: 1500, schedule: 'one-shot', seriesId: null,
    level: 'some', age: '13+', tags: [], safety: [], characters: 'pregens', bring: '', contentNotes: '', sessionZero: '', image: null, gmFeeApproved: true,
  });
  be.state.bookings.push({
    id: `bk-${id}`, ref: `GM-${id}`, kind: 'gm', gameId: id, tables: ['G3'], start, end, people: 5, name: 'GM Dan', status: 'confirmed', pay: 'day', paid: true,
    activity: 'rpg', extras: [], customerId: dan,
  });
  const seat = (name, customerId, paid) => ({
    id: `bk-r21p-${name.toLowerCase()}`, ref: `R21-${name.toUpperCase()}-7`, kind: 'gm-seat', gameId: id, tables: ['G3'], start, end, people: 1,
    players: [{ name, character: '' }], name, email: `${name.toLowerCase()}@example.com`, phone: '', notes: '', status: 'confirmed', pay: 'day', paid,
    paidAmount: paid ? 1500 : 0, refund: null, amount: 1500, activity: 'rpg', extras: [], customerId, createdAt: Date.now(),
  });
  be.state.bookings.push(seat('Mia', mia, false), seat('Kai', 'demo-r21-kai', true));
  be.commit();
  await store.refresh();
  return { day };
}, [String(DAN.id), String(MIA.id), GAME]);

/** The open sheet's Your game panel: each player row's words, and its buttons */
const own = (page) => page.evaluate(() => {
  const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const box = document.querySelector('[data-sheet][open] .gm-own');
  if (!box) return null;
  return [...box.querySelectorAll('.gm-own__players .gm-own__list > li')].map((li) => ({
    text: f(li.innerText),
    buttons: [...li.querySelectorAll('button')].map((b) => f(b.textContent)),
    badges: [...li.querySelectorAll('.badge')].map((b) => f(b.textContent)),
  }));
});
const openSheet = async (page, id) => {
  await page.goto('about:blank');
  await page.goto(`${BASE}/pages/gm-games#game=${id}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('[data-sheet][open] .gm-detail', { timeout: 15000 });
  await settle(page, 450);
};
const flash = (page) => page.evaluate(() => String(document.querySelector('[data-sheet][open] .gm-flash')?.textContent || '').replace(/\s+/g, ' ').trim());
/** The demo's session (and its seats and charges) moved a week on, out of the 24 hours */
const nextWeek = (page) => page.evaluate(async (id) => {
  const { store } = window.Lair;
  const be = store.backend;
  const week = 7 * 24 * 3_600_000;
  for (const g of be.state.games.filter((x) => x.id === id)) Object.assign(g, { start: g.start + week, end: g.end + week });
  for (const b of be.state.bookings.filter((x) => x.gameId === id)) Object.assign(b, { start: b.start + week, end: b.end + week });
  be.commit();
  await store.refresh();
}, GAME);
/** The demo's session (and its seats and charges) moved to 3 hours from now, inside the 24 hours */
const soon = (page) => page.evaluate(async (id) => {
  const { store } = window.Lair;
  const be = store.backend;
  const start = Date.now() + 3 * 3_600_000;
  const end = start + 4 * 3_600_000;
  for (const g of be.state.games.filter((x) => x.id === id)) Object.assign(g, { start, end });
  for (const b of be.state.bookings.filter((x) => x.gameId === id)) Object.assign(b, { start, end });
  be.commit();
  await store.refresh();
}, GAME);

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';

  /* ---------- 1. the TTRPG sessions page: Dan's own game ---------- */
  let ctx = await context(browser, size);
  let page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gm-games', DAN);
  await ready(page);
  await seed(page);
  await openSheet(page, GAME);
  let rows = await own(page);
  check(`${tag} Your game: Mia has Pay for them; Kai is Paid with none`,
    rows && rows.length === 2 && JSON.stringify(rows[0].buttons) === JSON.stringify(['Pay for them']) && rows[1].buttons.length === 0 && rows[1].badges.includes('Paid'), rows);
  await shot(page, `${size}-1-your-game`, '[data-sheet][open] .gm-own');
  await axe(page, `${tag} Your game with Pay for them`, '[data-sheet]');
  check(`${tag} Your game: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  await page.click('[data-sheet][open] [data-gm-pays]');
  await page.waitForSelector('[data-sheet][open] [data-gm-pays-do]', { timeout: 10000 });
  const ask = await page.evaluate(() => {
    const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    return {
      q: f(document.querySelector('[data-sheet][open] .gm-confirm .h3')?.textContent),
      lines: [...document.querySelectorAll('[data-sheet][open] .gm-confirm > p:not(.h3):not([data-own-status])')].map((p) => f(p.textContent)),
      go: f(document.querySelector('[data-sheet][open] [data-gm-pays-do]')?.textContent),
      focus: document.activeElement === document.querySelector('[data-sheet][open] .gm-confirm .h3'),
    };
  });
  check(`${tag} Pay for them asks first: "Pay for Mia’s seat?", what it means ($10 at the counter, Mia pays nothing, no GM credit, locked in 24 hours before), Pay $10, focus on the question`,
    ask.q === 'Pay for Mia’s seat?' && /^You pay the table fee, \$10, at the counter \(it goes on your account\), and Mia pays nothing for The Sunless Citadel, /.test(ask.lines[0] || '')
    && ask.lines[1] === 'There’s no GM credit for a seat you pay for. Like any seat, it’s locked in 24 hours before: after that you pay even if they don’t come.' && ask.go === 'Pay $10' && ask.focus, ask);
  await shot(page, `${size}-1-ask`, '[data-sheet][open]');
  await axe(page, `${tag} Pay for them, the question`, '[data-sheet]');
  await page.click('[data-sheet][open] [data-gm-pays-do]');
  await page.waitForSelector('[data-sheet][open] .gm-flash', { timeout: 10000 });
  const paidFlash = await flash(page);
  rows = await own(page);
  check(`${tag} Paid for: the flash says so, and Mia shows You’re paying with Stop paying`,
    /Done\. You’re paying \$10 for Mia’s seat, at the counter\. Mia pays nothing\./.test(paidFlash) && rows && rows[0].badges.includes('You’re paying') && JSON.stringify(rows[0].buttons) === JSON.stringify(['Stop paying']), { paidFlash, rows });
  const charge = await page.evaluate((id) => window.Lair.store.backend.state.bookings.find((b) => b.kind === 'gm-cover' && b.gameId === id && b.status !== 'cancelled'), GAME);
  check(`${tag} The demo: Dan's charge of $10 for Mia's seat, which is $0 for her`, charge && charge.amount === 1000 && charge.customerId === String(DAN.id), charge);
  await shot(page, `${size}-1-paying`, '[data-sheet][open] .gm-own');
  // stop, then pay again for the next checks
  await page.click('[data-sheet][open] [data-gm-pays-stop]');
  await page.waitForSelector('[data-sheet][open] [data-gm-pays-do][data-stop="1"]', { timeout: 10000 });
  const stopAsk = await page.evaluate(() => String(document.querySelector('[data-sheet][open] .gm-confirm')?.textContent || '').replace(/\s+/g, ' ').trim());
  check(`${tag} Stop paying asks first: Mia pays for it again, $15`, /^Stop paying for Mia’s seat\? Mia pays for it again: \$15 at The Sunless Citadel, /.test(stopAsk), stopAsk);
  await page.click('[data-sheet][open] [data-gm-pays-do][data-stop="1"]');
  await page.waitForSelector('[data-sheet][open] .gm-flash', { timeout: 10000 });
  rows = await own(page);
  check(`${tag} Stopped: Mia pays again, and Pay for them is back`, /Done\. Mia pays for their seat again\./.test(await flash(page)) && rows && JSON.stringify(rows[0].buttons) === JSON.stringify(['Pay for them']), rows);
  await page.click('[data-sheet][open] [data-gm-pays]');
  await page.waitForSelector('[data-sheet][open] [data-gm-pays-do]', { timeout: 10000 });
  await page.click('[data-sheet][open] [data-gm-pays-do]');
  await page.waitForSelector('[data-sheet][open] .gm-flash', { timeout: 10000 });
  // the session moved to 3 hours from now: Dan's offer is locked in, so he can't stop paying (staff can)
  await soon(page);
  await openSheet(page, GAME);
  rows = await own(page);
  check(`${tag} 3 hours to go: Mia shows You’re paying: locked in, and no Stop paying`,
    rows && rows[0].badges.includes('You’re paying: locked in') && rows[0].buttons.length === 0, rows);
  await shot(page, `${size}-1-locked`, '[data-sheet][open] .gm-own');
  await axe(page, `${tag} Your game, locked in`, '[data-sheet]');
  const tried = await page.evaluate(async ([id, ref]) => {
    try {
      await window.Lair.store.backend.uncoverGamePlayer(id, ref);
      return 'stopped';
    } catch (error) {
      return `${error.status} ${error.message}`;
    }
  }, [GAME, 'R21-MIA-7']);
  check(`${tag} 3 hours to go: the demo won't let Dan stop paying`, tried === "403 It's less than 24 hours away, so it's locked in: you pay for this seat, the same as any seat. Ask staff if something's come up.", tried);

  /* ---------- 2. My Lair as Dan ---------- */
  await go(page, BASE, '/pages/my-lair#bookings', DAN);
  await page.waitForSelector('my-lair [data-panel="games"] .ml-game', { timeout: 20000 });
  await settle(page, 500);
  const mine = await page.evaluate(() => {
    const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const panel = document.querySelector('my-lair [data-panel="games"]');
    return {
      roster: [...panel.querySelectorAll('.ml-roster li')].map((li) => f(li.innerText)),
      covers: f(panel.querySelector('.ml-covers')?.innerText),
    };
  });
  check(`${tag} My Lair (Dan): Mia's seat is one he pays for, and Players you’re paying for lists it at $10, locked in 3 hours before, Pay at the counter`,
    mine.roster.some((r) => /^Mia You pay for this seat$/.test(r)) && /Players you’re paying for\. They pay nothing, and there’s no GM credit for their seats\. Like any seat, each is locked in 24 hours before/.test(mine.covers)
    && /Paying for Mia's seat: The Sunless Citadel \$10 Locked in: pay at the counter/.test(mine.covers), mine);
  await shot(page, `${size}-2-my-lair-dan`, 'my-lair [data-panel="games"]');
  const upNext = await page.evaluate(() => [...document.querySelectorAll('my-lair .ml-upnext__item')].map((li) => ({
    text: String(li.textContent || '').replace(/\s+/g, ' ').trim(), cancel: Boolean(li.querySelector('[data-tab-cancel]')),
  })).filter((x) => /Paying for Mia/.test(x.text)));
  check(`${tag} My Lair (Dan): Coming up has "Paying for Mia's seat", with no Cancel there`, upNext.length === 1 && !upNext[0].cancel, upNext);
  await axe(page, `${tag} My Lair, a GM paying for a player`, 'my-lair [data-panel="games"]');
  check(`${tag} My Lair (Dan): no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  check(`${tag} Dan: no errors`, !page.errors.length, page.errors);
  await ctx.close();

  /* ---------- 3. My Lair as Mia ---------- */
  ctx = await context(browser, size);
  page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gm-games', MIA);
  await ready(page);
  await seed(page);
  await page.evaluate(async ([id, ref]) => {
    const be = window.Lair.store.backend;
    const seat = be.state.bookings.find((b) => b.ref === ref);
    const game = be.state.games.find((g) => g.id === id);
    Object.assign(seat, { coveredBy: game.gmCustomerId, coverWas: 1500, amount: 0 });
    be.state.bookings.push({ id: 'bk-r21p-cover', ref: 'GM-PAYS-1', kind: 'gm-cover', gameId: id, coverOf: seat.id, customerId: game.gmCustomerId, name: 'Dan', start: seat.start, end: seat.end, tables: [], people: 1, amount: 1000, paid: false, paidAmount: 0, status: 'confirmed', pay: 'day', extras: [], players: [] });
    be.commit();
    await window.Lair.store.refresh();
  }, [GAME, 'R21-MIA-7']);
  await go(page, BASE, '/pages/my-lair#bookings', MIA);
  await page.waitForSelector('my-lair .ml-ticket', { timeout: 20000 });
  await settle(page, 500);
  // (a ticket folded into its row has no innerText: its words are still there)
  const hers = await page.evaluate(() => [...document.querySelectorAll('my-lair .ml-ticket')].map((x) => String(x.textContent || '').replace(/\s+/g, ' ').trim()).find((x) => /The Sunless Citadel/.test(x)) || '');
  check(`${tag} My Lair (Mia): her seat says Your GM pays for it`, /Your GM pays for it/.test(hers) && !/\$15/.test(hers), hers);
  await shot(page, `${size}-3-my-lair-mia`, 'my-lair');
  // 3 hours to go: locked in, with nothing on her tab
  await soon(page);
  await go(page, BASE, '/pages/my-lair#bookings', MIA);
  await page.waitForSelector('my-lair .ml-ticket', { timeout: 20000 });
  await settle(page, 500);
  const locked = await page.evaluate(() => [...document.querySelectorAll('my-lair .ml-ticket')].map((x) => String(x.textContent || '').replace(/\s+/g, ' ').trim()).find((x) => /The Sunless Citadel/.test(x)) || '');
  check(`${tag} My Lair (Mia), 3 hours to go: Locked in: your GM pays for it, not on her tab`, /Locked in: your GM pays for it/.test(locked) && !/Locked in: on your tab/.test(locked), locked);
  const lateCancel = await page.evaluate(async () => {
    try {
      await window.Lair.store.backend.updateBooking('bk-r21p-mia', { status: 'cancelled' });
      return 'cancelled';
    } catch (error) {
      return `${error.status} ${error.message}`;
    }
  });
  check(`${tag} Mia, 3 hours to go: the demo won't cancel her seat online`, lateCancel === "409 It's less than 24 hours away, so it can't be cancelled online now: your GM is paying for your seat. Have a chat with us at the counter or give us a call, and we'll sort it out.", lateCancel);
  await nextWeek(page);
  const inTime = await page.evaluate(async () => {
    const be = window.Lair.store.backend;
    await be.updateBooking('bk-r21p-mia', { status: 'cancelled' });
    const cover = be.state.bookings.find((b) => b.id === 'bk-r21p-cover');
    return cover && cover.status;
  });
  check(`${tag} Mia cancels a week out: Dan's charge goes with her seat`, inTime === 'cancelled', inTime);
  check(`${tag} Mia: no errors`, !page.errors.length, page.errors);
  await ctx.close();

  /* ---------- 4. the staff page: the session's players ---------- */
  ctx = await context(browser, size);
  page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/lair-staff', STAFF);
  await page.waitForSelector('#checkin-code', { timeout: 20000 });
  await seed(page);
  await page.click('[data-tab="games"]');
  await page.waitForSelector(`button.staff-gm-row[data-gm-manage="${GAME}"]`, { timeout: 15000 });
  await page.click(`button.staff-gm-row[data-gm-manage="${GAME}"]`);
  await page.waitForSelector('.staff-players', { timeout: 15000 });
  const playerRow = (name) => page.evaluate((who) => {
    const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const li = [...document.querySelectorAll('.staff-players > li')].find((x) => f(x.querySelector('.staff-player__names')?.textContent).startsWith(who));
    return li ? { text: f(li.innerText), buttons: [...li.querySelectorAll('button')].map((b) => f(b.textContent)) } : null;
  }, name);
  let row = await playerRow('Mia');
  check(`${tag} Staff: Mia's row offers The GM pays; Kai's doesn't`, row && row.buttons.includes('The GM pays') && !(await playerRow('Kai')).buttons.includes('The GM pays'), { row, kai: await playerRow('Kai') });
  const gmPays = '.staff-players [data-act="gm-cover"]';
  await page.click(gmPays);
  await settle(page, 150);
  await page.click(gmPays);
  await settle(page, 700);
  row = await playerRow('Mia');
  check(`${tag} Staff: two taps, and Mia's seat says the GM pays $10 on their account, with Mark the GM’s $10 paid and Stop the GM paying`,
    row && /The GM pays: \$10 on their account/.test(row.text) && row.buttons.includes('Mark the GM’s $10 paid') && row.buttons.includes('Stop the GM paying') && !row.buttons.includes('Mark paid'), row);
  await shot(page, `${size}-4-staff`, '.staff-players');
  await axe(page, `${tag} staff page, a seat the GM pays for`, '.staff-players');
  // the GM has paid $5 of it: $5 left, and Mark the GM's $5 paid
  await page.evaluate(async (id) => {
    const be = window.Lair.store.backend;
    const cover = be.state.bookings.find((b) => b.kind === 'gm-cover' && b.gameId === id && b.status !== 'cancelled');
    cover.paidAmount = 500;
    be.commit();
    await window.Lair.store.refresh();
  }, GAME);
  await settle(page, 500);
  row = await playerRow('Mia');
  check(`${tag} Staff: part paid: The GM pays: $5 left on their account, with Mark the GM’s $5 paid`,
    row && /The GM pays: \$5 left on their account/.test(row.text) && row.buttons.includes('Mark the GM’s $5 paid'), row);
  // the GM pays the rest at the counter; staff can still stop it, and it's a refund due to him
  await page.click('.staff-players [data-act="paid"]');
  await settle(page, 700);
  row = await playerRow('Mia');
  check(`${tag} Staff: the GM paid: The GM paid for it, and Stop the GM paying is still there`, row && /The GM paid for it/.test(row.text) && row.buttons.includes('Stop the GM paying'), row);
  const stopIt = '.staff-players [data-act="gm-uncover"]';
  await page.click(stopIt);
  await settle(page, 150);
  const armedText = await page.evaluate((sel) => String(document.querySelector(sel)?.textContent || '').trim(), stopIt);
  check(`${tag} Staff: the first tap says the GM gets a refund`, armedText === 'Tap again: Mia pays again, and the GM gets a refund', armedText);
  await page.click(stopIt);
  await settle(page, 700);
  const after = await page.evaluate((id) => {
    const be = window.Lair.store.backend;
    const cover = be.state.bookings.find((b) => b.kind === 'gm-cover' && b.gameId === id);
    const toast = [...document.querySelectorAll('.staff-toast, [data-toast], .toast')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()).join(' | ');
    return { status: cover && cover.status, refund: cover && cover.refund, toast };
  }, GAME);
  row = await playerRow('Mia');
  check(`${tag} Staff: stopped: the GM's charge is a refund due, and Mia's seat is $15 to pay again`,
    after.status === 'cancelled' && after.refund === 'due' && row && /Unpaid, \$15 to pay/.test(row.text) && /refund due/.test(after.toast), { after, row });
  check(`${tag} Staff: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  check(`${tag} Staff: no errors`, !page.errors.length, page.errors);
  await ctx.close();
}

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';

  /* ---------- 5. the staff desk and Refunds to sort, for the GM's charge ---------- */
  let ctx = await context(browser, size);
  let page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/lair-staff', STAFF);
  await page.waitForSelector('#checkin-code', { timeout: 20000 });
  await seed(page);
  const ref = await page.evaluate(async ([id, seatRef]) => {
    const { store } = window.Lair;
    await store.backend.coverGamePlayer(id, seatRef);
    await store.refresh();
    return store.backend.state.bookings.find((b) => b.kind === 'gm-cover' && b.gameId === id && b.status !== 'cancelled').ref;
  }, [GAME, 'R21-MIA-7']);
  await page.fill('#checkin-code', ref);
  await page.press('#checkin-code', 'Enter');
  await page.waitForSelector('[data-checkin-result] .checkin-card', { timeout: 10000 });
  await settle(page, 400);
  const desk = await page.evaluate(() => {
    const card = document.querySelector('[data-checkin-result] .checkin-card');
    const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    return {
      status: f(card?.querySelector('.checkin-card__status')?.textContent), what: f(card?.querySelector('.checkin-card__what')?.textContent),
      bill: f(card?.querySelector('.staff-bill')?.textContent), buttons: [...(card?.querySelectorAll('button') || [])].map((b) => f(b.textContent)),
    };
  });
  check(`${tag} Staff desk: the GM's charge's code: To pay, "Paying for Mia's seat", The GM's part $10, Mark paid, no check-in`,
    desk.status === 'To pay' && /^Paying for Mia's seat: The Sunless Citadel/.test(desk.what) && /The GM’s part \$10/.test(desk.bill)
    && desk.buttons.includes('Mark paid $10') && !desk.buttons.some((b) => /Check in/.test(b)), desk);
  await shot(page, `${size}-5-desk`, '[data-checkin-result]');
  // the GM paid $20 for a $10 charge: $10 to give back, in Refunds to sort, with nothing there but Mark refunded (and email)
  await page.evaluate(async (id) => {
    const be = window.Lair.store.backend;
    const cover = be.state.bookings.find((b) => b.kind === 'gm-cover' && b.gameId === id && b.status !== 'cancelled');
    cover.paidAmount = 2000;
    be.commit();
    await window.Lair.store.refresh();
  }, GAME);
  await page.click('[data-checkin-clear]').catch(() => {});
  await settle(page, 500);
  const refundCard = await page.evaluate(() => {
    const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const card = [...document.querySelectorAll('[data-refunds] .staff-card')].find((c) => /GM pays for a player/.test(c.textContent));
    return card ? { text: f(card.textContent), buttons: [...card.querySelectorAll('button')].map((b) => f(b.textContent)) } : null;
  });
  check(`${tag} Staff: Refunds to sort has the GM's charge: Refund due $10, Mark refunded, and no Check in, −1, +1, +1 hour or Cancel`,
    refundCard && /Refund due: \$10/.test(refundCard.text) && refundCard.buttons.includes('Mark refunded')
    && !refundCard.buttons.some((b) => /^(Check in|−1|\+1|\+1 hour|Cancel booking|No-show)$/.test(b)), refundCard);
  await shot(page, `${size}-5-refunds`, '[data-refunds]');
  await axe(page, `${tag} staff page, Refunds to sort with a GM's charge`, '[data-refunds]');
  // stopped: the charge's code at the desk says it was taken off, with nothing to pay and no Mark paid
  await page.evaluate(async ([id, seatRef]) => {
    await window.Lair.store.backend.uncoverGamePlayer(id, seatRef);
    await window.Lair.store.refresh();
  }, [GAME, 'R21-MIA-7']);
  await page.fill('#checkin-code', ref);
  await page.press('#checkin-code', 'Enter');
  await page.waitForSelector('[data-checkin-result] .checkin-card', { timeout: 10000 });
  await settle(page, 400);
  const gone = await page.evaluate(() => {
    const card = document.querySelector('[data-checkin-result] .checkin-card');
    const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    return { status: f(card?.querySelector('.checkin-card__status')?.textContent), text: f(card?.textContent), buttons: [...(card?.querySelectorAll('button') || [])].map((b) => f(b.textContent)) };
  });
  check(`${tag} Staff desk: a GM's charge that's gone: Taken off, nothing to pay, no Mark paid`,
    gone.status === 'Taken off' && /taken off, so there's nothing to pay/.test(gone.text) && !gone.buttons.some((b) => /^Mark paid/.test(b)) && !/To pay: \$/.test(gone.text), gone);
  check(`${tag} Staff (5): no errors`, !page.errors.length, page.errors);
  await ctx.close();

  /* ---------- 6. Dan's game when another GM still pays for Mia (locked in before the session came to him) ---------- */
  ctx = await context(browser, size);
  page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gm-games', DAN);
  await ready(page);
  await seed(page);
  await page.evaluate(async ([id, seatRef]) => {
    const be = window.Lair.store.backend;
    const seat = be.state.bookings.find((b) => b.ref === seatRef);
    Object.assign(seat, { coveredBy: 'demo-r21-rangi', coverWas: 1500, amount: 0 });
    be.state.bookings.push({ id: 'bk-r21p-other', ref: 'GM-PAYS-2', kind: 'gm-cover', gameId: id, coverOf: seat.id, customerId: 'demo-r21-rangi', name: 'Rangi Parata', start: seat.start, end: seat.end, tables: [], people: 1, amount: 1000, paid: false, paidAmount: 0, status: 'confirmed', pay: 'day', extras: [], players: [], createdAt: Date.now() });
    be.commit();
    await window.Lair.store.refresh();
  }, [GAME, 'R21-MIA-7']);
  await openSheet(page, GAME);
  const rows = await own(page);
  check(`${tag} Dan's game: Mia shows Rangi pays for it, and Dan has no Stop paying`,
    rows && rows[0].badges.includes('Rangi pays for it') && rows[0].buttons.length === 0, rows);
  check(`${tag} Dan (6): no errors`, !page.errors.length, page.errors);
  await ctx.close();
}

await browser.close();
server.close();
const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

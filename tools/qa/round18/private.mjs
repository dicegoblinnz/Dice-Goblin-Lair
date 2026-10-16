// Private games (17 Oct 2026, contract v18-private), on the theme mock. Mo: "I want my gms to be able to have a private
// game, and it becomes an invite only game. But they can toggle a register interest button if they want otherwise it is
// locked to the public." He picked: shown as Private, invite only, and an invite link the GM shares.
// The TTRPG sessions page is the one booking page (lair-play.js), with the sessions board (lair-games.js) for its sheets.
//  1. A player without the link: the day's list says Private: invite only with no Join, Looking for players leaves it
//     out, the map's table says so, its details say to ask the GM (?join= opens them too), I'm interested only while
//     the GM takes interest, and the demo backend says no without the key.
//  2. The invite link (?invite=): the game opens on its day, they're invited, the key is kept, they join; a link that
//     doesn't work says so.
//  3. The events calendar: Private, invite only, no Join.
//  4. The GM: Who can join with the invite link (Copy, Register interest, New link, Make it public and private again),
//     and Run a game's Who can join (Invite only, with interest), listed with its link to copy.
//  5. The staff page: Private on the list and in the manager, with the link, Take interest, Make it public and private
//     again (the same link), and New link.
//  6. The live backend's three calls against a stubbed Lair app.
// No sideways scroll and axe throughout. Phone and desktop.
// Usage: DG_THEME=/path/to/theme [PORT=4993] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round18/private.mjs [phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round18-private');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, context, watch, go, STAFF, RUBY } = lib;
const PORT = Number(process.env.PORT || 4993);
const BASE = `http://localhost:${PORT}`;
const sizes = process.argv[2] ? [process.argv[2]] : ['phone', 'desktop'];
// Rangi runs the private game (a trusted GM)
const RANGI = { id: 7300, first_name: 'Rangi', last_name: 'Kahu', name: 'Rangi Kahu', email: 'rangi@example.com', phone: '', tags: ['gm'], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const KEY = 'pq7rst8uvw9xyzab2cde';
const ID = 'gm-pv-private';
const WORDS = {
  locked: 'This game is invite only. Ask Rangi for the invite link.',
  lockedInterest: 'This game is invite only. Interested? Tell Rangi, and they can send you the invite link.',
  invited: 'You’re invited! Your invite link lets you join this private game.',
  refused: 'This game is invite only. Ask the GM for the invite link.',
  // the Lair app's words (straight apostrophe)
  badLink: "That invite link doesn't work any more. Ask the GM for a new one.",
};

const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 350) => page.waitForTimeout(ms);
const text = (page, sel) => page.evaluate((s) => String(document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim(), sel);
const ready = (page) => page.waitForFunction(() => Boolean(window.Lair && window.Lair.store && window.Lair.store.data && Array.isArray(window.Lair.store.data.games) && window.Lair.store.data.games.length), null, { timeout: 20000 });

/** The demo, through its own backend: Rangi's private one-shot tomorrow 6pm to 9pm (4 seats, 1 taken, $15) on G1, and
    Aria's public one on G2 */
const seed = (page, { interest = false } = {}) => page.evaluate(async ([rangi, key, id, interestOpen]) => {
  const { store } = window.Lair;
  const be = store.backend;
  const t = store.time;
  const tomorrow = t.addDays(t.today(), 1);
  const game = (gid, title, gm, gmCustomerId, tables, extra = {}) => ({
    id: gid, title, system: 'D&D 5e', gm, gmCustomerId, gmEmail: `${gm.toLowerCase()}@example.com`, blurb: 'A test session.', tables, room: 'gaming-room',
    seats: 4, start: t.at(tomorrow, 18 * 60), end: t.at(tomorrow, 21 * 60), taken: 1, status: 'open', credited: null, gmFee: 500, seatPrice: 1500,
    schedule: 'one-shot', seriesId: null, level: 'new', age: 'All ages', tags: [], safety: [], characters: 'pregens', bring: '', contentNotes: '',
    sessionZero: '', image: null, gmFeeApproved: true, ...extra,
  });
  be.state.games = be.state.games.filter((g) => !/^gm-pv-/.test(g.id));
  be.state.bookings = be.state.bookings.filter((b) => !/^gm-pv-/.test(b.gameId || ''));
  const games = [
    game(id, 'The Sunless Vault', 'Rangi', rangi, ['G1'], { private: true, interestOpen, inviteKey: key }),
    game('gm-pv-public', 'Open Table Heist', 'Aria', 'demo-aria', ['G2']),
  ];
  be.state.games.push(...games);
  // each game holds its table, as the demo's own sessions do
  for (const g of games) {
    be.state.bookings.push({
      id: `bk-${g.id}`, ref: `GM-${g.id}`, kind: 'gm', gameId: g.id, tables: g.tables, start: g.start, end: g.end, people: g.seats + 1, name: `GM ${g.gm}`,
      status: 'confirmed', pay: 'day', paid: true, activity: 'rpg', extras: [], customerId: g.gmCustomerId,
    });
  }
  be.commit();
  await store.refresh();
  return tomorrow;
}, [String(RANGI.id), KEY, ID, interest]);

/** The demo's private game as it's stored */
const stored = (page) => page.evaluate((id) => JSON.parse(JSON.stringify(window.Lair.store.backend.state.games.find((g) => g.id === id) || null)), ID);
/** A row in the booking page's list for the day: its words and its actions */
const row = (page, title) => page.evaluate((x) => {
  const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const li = [...document.querySelectorAll('.play-row')].find((r) => f(r.querySelector('.play-row__title')?.textContent) === x);
  return li ? { left: f(li.querySelector('.play-row__left')?.textContent), actions: f(li.querySelector('.play-row__actions')?.textContent) } : null;
}, title);
/** The sessions board's sheet for a game, from its deep link */
const openLinked = async (page, where = `/pages/gm-games#game=${ID}`) => {
  // a fresh load (a hash on the same page would only open the sheet, not move the booking page to its day)
  await page.goto('about:blank');
  await page.goto(`${BASE}${where}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('[data-sheet][open] .gm-detail', { timeout: 15000 });
  await settle(page, 400);
};
const closeSheet = async (page) => {
  await page.locator('[data-sheet][open] [data-close]').first().click();
  await settle(page, 400);
};

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';

  /* ---------- 1. a player without the link ---------- */
  let ctx = await context(browser, size);
  let page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gm-games', RUBY);
  await ready(page);
  await seed(page);
  await openLinked(page);
  const sheet = await page.evaluate(() => {
    const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    const d = document.querySelector('[data-sheet]');
    return {
      tags: f(d.querySelector('.gm-detail__tags')?.textContent),
      fact: f([...d.querySelectorAll('.gm-facts li')].find((li) => /Private game/.test(li.textContent))?.textContent),
      foot: f(d.querySelector('[data-sheet-foot]')?.textContent),
      join: d.querySelectorAll('[data-sheet-foot] [data-join]').length,
      interest: d.querySelectorAll('[data-sheet-foot] [data-interest]').length,
      own: d.querySelectorAll('.gm-own').length,
    };
  });
  check(`${tag} details: the Private badge, "invite only" in the facts, and the foot says to ask Rangi, with no Join and no I'm interested`,
    /Private/.test(sheet.tags) && sheet.fact === 'Private game: invite only. Only people with the GM’s invite link can join.' && sheet.foot === WORDS.locked
    && !sheet.join && !sheet.interest && !sheet.own, sheet);
  await shot(page, `${size}-1-details-locked`, '[data-sheet]');
  await axe(page, `${tag} a private game's details, locked`, '[data-sheet]');
  check(`${tag} details: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  await closeSheet(page);
  // the day's list: Private: invite only, no Join; the public game has its seats and Join
  const rows = { priv: await row(page, 'The Sunless Vault'), pub: await row(page, 'Open Table Heist') };
  check(`${tag} the day's list: the private game says Private: invite only, with nothing to tap; the public one has its seats and Join`,
    rows.priv && rows.priv.left === 'Private: invite only' && rows.priv.actions === '' && rows.pub && rows.pub.left === '3 seats left' && /^Join · \$15/.test(rows.pub.actions), rows);
  // the map's table for it
  const table = await page.evaluate(() => [...document.querySelectorAll('[aria-label*="The Sunless Vault"]')].map((el) => el.getAttribute('aria-label'))[0] || '');
  check(`${tag} the map: the private game's table says private, invite only`, /The Sunless Vault, a TTRPG game \(D&D 5e\), private, invite only,/.test(table), table);
  await shot(page, `${size}-1-day`, 'lair-play');
  check(`${tag} the booking page: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  // Looking for players leaves it out
  await page.goto(`${BASE}/pages/gm-games?players=1`, { waitUntil: 'networkidle', timeout: 60000 });
  await settle(page, 600);
  const looking = await page.evaluate(() => [...document.querySelectorAll('.play-row__title')].map((b) => b.textContent.trim()));
  check(`${tag} Looking for players leaves the private game out, and keeps the public one`, !looking.includes('The Sunless Vault') && looking.includes('Open Table Heist'), looking);

  // the GM takes interest: I'm interested is there, and the foot says to tell them
  await page.evaluate(async (id) => {
    const be = window.Lair.store.backend;
    be.state.games.find((g) => g.id === id).interestOpen = true;
    be.commit();
  }, ID);
  await openLinked(page);
  const keen = { foot: await text(page, '[data-sheet-foot] .gm-note'), ask: await text(page, '[data-sheet-foot] [data-interest]'), join: await page.locator('[data-sheet-foot] [data-join]').count() };
  check(`${tag} details: with Register interest on, the foot says to tell Rangi and has I'm interested (and still no Join)`,
    keen.foot === WORDS.lockedInterest && keen.ask === 'I’m interested' && !keen.join, keen);
  await closeSheet(page);
  const keenRow = await row(page, 'The Sunless Vault');
  check(`${tag} the day's list: with Register interest on, the private game's row has I'm interested`, keenRow && keenRow.left === 'Private: invite only' && keenRow.actions === 'I’m interested', keenRow);
  await page.evaluate(async (id) => {
    const be = window.Lair.store.backend;
    be.state.games.find((g) => g.id === id).interestOpen = false;
    be.commit();
    await window.Lair.store.refresh();
  }, ID);

  // the backend says no without the key (and with a wrong one), in the Lair app's words; and to interest while it's off
  const refused = await page.evaluate(async ([id]) => {
    const be = window.Lair.store.backend;
    const seat = { kind: 'gm-seat', gameId: id, people: 1, name: 'Ruby Tane', email: 'ruby@example.com', phone: '021 555 0199', players: [{ name: 'Ruby Tane', character: '' }] };
    const out = [];
    for (const input of [seat, { ...seat, invite: 'abcdefghjkmnpqrstuvw' }]) {
      try {
        await be.joinGame(input);
        out.push('joined');
      } catch (e) {
        out.push(`${e.status} ${e.message}`);
      }
    }
    try {
      await be.addInterest({ kind: 'session', id, name: 'Ruby Tane', email: 'ruby@example.com', phone: '021 555 0199' });
      out.push('interested');
    } catch (e) {
      out.push(`${e.status} ${e.message}`);
    }
    return out;
  }, [ID]);
  check(`${tag} demo backend: a seat without the key, or with a wrong one, is 403 invite only; interest while it's off is 403 too`,
    refused[0] === `403 ${WORDS.refused}` && refused[1] === `403 ${WORDS.refused}`
    && refused[2] === "403 This game is invite only, and the GM isn't taking interest right now. Ask them for the invite link.", refused);

  // ?join= (back from logging in) opens the details, not the form
  await page.goto(`${BASE}/pages/gm-games?join=${ID}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('[data-sheet][open]', { timeout: 15000 });
  await settle(page, 400);
  check(`${tag} ?join= to a private game without the link opens its details, not the join form`,
    (await page.locator('[data-sheet] [data-join-form]').count()) === 0 && (await text(page, '[data-sheet-foot]')) === WORDS.locked, await text(page, '[data-sheet-foot]'));
  check(`${tag} no errors without the link`, page.errors.length === 0, page.errors);
  await ctx.close();

  /* ---------- 2. the invite link ---------- */
  ctx = await context(browser, size);
  page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gm-games', RUBY);
  await ready(page);
  const tomorrow = await seed(page);
  await page.goto(`${BASE}/pages/gm-games?invite=${KEY}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('[data-sheet][open] .gm-detail', { timeout: 15000 });
  await settle(page, 500);
  const invited = await page.evaluate((id) => {
    const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    const d = document.querySelector('[data-sheet]');
    let kept = null;
    try {
      kept = JSON.parse(localStorage.getItem('dg-lair-invites') || '{}')[id] || null;
    } catch {
      kept = 'unreadable';
    }
    return {
      flash: f(d.querySelector('.gm-flash')?.textContent),
      fact: f([...d.querySelectorAll('.gm-facts li')].find((li) => /Private game/.test(li.textContent))?.textContent),
      join: f(d.querySelector('[data-sheet-foot] [data-join]')?.textContent),
      search: window.location.search,
      hash: window.location.hash,
      kept: kept && kept.key,
      day: document.querySelector('lair-play')?.day || '',
    };
  }, ID);
  check(`${tag} invite link: the game opens on its day with "You're invited!", Join, the key kept, and the link gone from the address`,
    invited.flash === WORDS.invited && invited.fact === 'Private game: you’re invited. Your invite link lets you join.' && /^Join · \$15 a seat/.test(invited.join)
    && invited.search === '' && invited.hash === `#game=${ID}` && invited.kept === KEY && invited.day === tomorrow, invited);
  await shot(page, `${size}-2-invited`, '[data-sheet]');
  await axe(page, `${tag} a private game's details, invited`, '[data-sheet]');
  // join it
  await page.click('[data-sheet-foot] [data-join]:not([data-every])');
  await page.waitForSelector('[data-sheet] [data-join-form]', { timeout: 10000 });
  await page.fill('[data-sheet] [data-join-form] [name="phone"]', '021 555 0199');
  await page.click('[data-sheet] [data-join-submit]');
  await settle(page, 900);
  const seat = await page.evaluate((id) => {
    const b = window.Lair.store.backend.state.bookings.find((x) => x.gameId === id && x.kind === 'gm-seat' && x.status === 'confirmed');
    return b ? { people: b.people, email: b.email } : null;
  }, ID);
  check(`${tag} invite link: they join (the seat is booked with the key)`, Boolean(seat) && seat.people === 1 && seat.email === RUBY.email,
    { seat, errors: page.errors, form: await text(page, '[data-sheet] [data-form-status]') });
  await closeSheet(page);
  // and on the next visit, with the link kept in this browser: their seat on the day's list
  await openLinked(page);
  await closeSheet(page);
  const afterRow = await row(page, 'The Sunless Vault');
  check(`${tag} invite link: next visit, the day's list shows them in, not invite only`, afterRow && afterRow.left === '2 seats left' && /You’re in/.test(afterRow.actions), afterRow);
  // a link that doesn't work
  await page.goto(`${BASE}/pages/gm-games?invite=zzzzzzzzzzzzzzzzzzzz`, { waitUntil: 'networkidle', timeout: 60000 });
  await settle(page, 800);
  const bad = await text(page, '[data-notice]');
  check(`${tag} an invite link that doesn't work says so`, bad === WORDS.badLink, bad);
  check(`${tag} no errors with the invite link`, page.errors.length === 0, page.errors);
  await ctx.close();

  /* ---------- 3. the events calendar ---------- */
  ctx = await context(browser, size);
  page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/events-calendar', RUBY);
  await ready(page);
  await seed(page);
  await page.goto(`${BASE}/pages/events-calendar#event=${encodeURIComponent(`game:${ID}`)}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('dialog[open] .cal-detail', { timeout: 15000 }).catch(() => {});
  await settle(page, 500);
  const cal = await page.evaluate(() => {
    const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    const d = document.querySelector('dialog[open]');
    return {
      tags: f(d?.querySelector('.cal-detail__tags')?.textContent),
      fact: f([...(d?.querySelectorAll('.cal-facts li') || [])].find((li) => /Private game/.test(li.textContent))?.textContent),
      note: f(d?.querySelector('.cal-note--private')?.textContent),
      join: d ? d.querySelectorAll('[data-lj-join]').length : -1,
    };
  });
  check(`${tag} calendar: the session says Private, invite only, ask Rangi, with no Join`,
    /Private/.test(cal.tags) && cal.fact === 'Private game: invite only.' && cal.note === WORDS.locked && cal.join === 0, cal);
  await shot(page, `${size}-3-calendar`, 'dialog[open]');
  await axe(page, `${tag} calendar: a private session`, 'dialog[open]');
  check(`${tag} calendar: no errors`, page.errors.length === 0, page.errors);
  await ctx.close();

  /* ---------- 4. the GM ---------- */
  ctx = await context(browser, size);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gm-games', RANGI);
  await ready(page);
  await seed(page);
  await openLinked(page);
  await page.waitForSelector('[data-sheet] .gm-private', { timeout: 10000 });
  // their own game's foot once GET /me says it's theirs
  await page.waitForSelector('[data-sheet-foot] [data-message]', { timeout: 10000 }).catch(() => {});
  const box = await page.evaluate(() => {
    const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    const b = document.querySelector('[data-sheet] .gm-private');
    return {
      head: [...b.querySelectorAll('.gm-own__head span')].map((x) => f(x.textContent)).join(' '),
      url: b.querySelector('[data-invite-url]')?.value || '',
      copy: f(b.querySelector('[data-invite-copy]')?.textContent),
      interest: b.querySelector('[data-private-interest]')?.checked,
      buttons: [...b.querySelectorAll('.gm-own__actions button')].map((x) => f(x.textContent)),
      fact: f([...document.querySelectorAll('[data-sheet] .gm-facts li')].find((li) => /Private game/.test(li.textContent))?.textContent),
      foot: f(document.querySelector('[data-sheet-foot]')?.textContent),
    };
  });
  check(`${tag} GM: Who can join says Private · invite only, with the invite link to copy, Register interest off, New link and Make it public`,
    box.head === 'Who can join Private · invite only' && box.url === `${BASE}/pages/gm-games?invite=${KEY}` && box.copy === 'Copy' && box.interest === false
    && JSON.stringify(box.buttons) === JSON.stringify(['New link', 'Make it public']) && box.fact === 'Private game: invite only. Its invite link is below, under Who can join.'
    && /Message your players/.test(box.foot), box);
  await shot(page, `${size}-4-gm-who-can-join`, '[data-sheet] .gm-own');
  await axe(page, `${tag} GM's own game with Who can join`, '[data-sheet]');
  check(`${tag} GM: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  await page.click('[data-sheet] [data-invite-copy]');
  await settle(page, 300);
  const copied = await text(page, '[data-sheet] [data-own-status]');
  check(`${tag} GM: Copy copies the link (or selects it to copy)`, ['Invite link copied. Paste it in a message to the players you want.', 'Copy the invite link from the box (it’s selected).'].includes(copied), copied);
  // Register interest on
  await page.click('[data-sheet] [data-private-interest]');
  await settle(page, 700);
  const interestOn = { said: await text(page, '[data-sheet] [data-own-status]'), stored: (await stored(page)).interestOpen, box: await page.evaluate(() => document.querySelector('[data-sheet] [data-private-interest]')?.checked) };
  check(`${tag} GM: Register interest goes on (said, kept, ticked)`,
    /^Register interest is on: players can tell (you|the GM) they’d like to play\.$/.test(interestOn.said) && interestOn.stored === true && interestOn.box === true, interestOn);
  // a new link
  await page.click('[data-sheet] [data-invite-new]');
  await page.waitForSelector('[data-sheet] [data-invite-new-do]', { timeout: 5000 });
  const ask = await text(page, '[data-sheet] .gm-confirm');
  await axe(page, `${tag} GM: New invite link, asked`, '[data-sheet]');
  await page.click('[data-sheet] [data-invite-new-do]');
  await page.waitForSelector('[data-sheet] .gm-flash', { timeout: 8000 });
  const fresh = await stored(page);
  const oldLink = await page.evaluate(async (key) => {
    try {
      await window.Lair.store.backend.gameByInvite(key);
      return 'still works';
    } catch (e) {
      return `${e.status} ${e.message}`;
    }
  }, KEY);
  const newUrl = await page.evaluate(() => document.querySelector('[data-sheet] [data-invite-url]')?.value || '');
  check(`${tag} GM: New link asks first, then makes a new key: the old link is 404, and the box has the new one`,
    /^Make a new invite link\?/.test(ask) && fresh.inviteKey !== KEY && /^[a-z0-9]{20}$/.test(fresh.inviteKey) && oldLink === `404 ${WORDS.badLink}`
    && newUrl === `${BASE}/pages/gm-games?invite=${fresh.inviteKey}` && (await text(page, '[data-sheet] .gm-flash')) === 'New invite link made. The old one doesn’t work any more: send this one to the players you want.',
    { ask, key: fresh.inviteKey, oldLink, newUrl });
  // public, then private again (the same link)
  await page.click('[data-sheet] [data-private="off"]');
  await settle(page, 700);
  const pub = { stored: (await stored(page)).private, head: await page.evaluate(() => [...document.querySelectorAll('[data-sheet] .gm-private .gm-own__head span')].map((x) => x.textContent.trim()).join(' ')), said: await text(page, '[data-sheet] [data-own-status]'), button: await text(page, '[data-sheet] [data-private="on"]') };
  check(`${tag} GM: Make it public: anyone can join (said, kept), and Make it private is offered`,
    pub.stored === false && pub.head === 'Who can join Anyone' && pub.said === 'Public now: anyone can join The Sunless Vault from the board.' && pub.button === 'Make it private', pub);
  await page.click('[data-sheet] [data-private="on"]');
  await settle(page, 700);
  const again = await stored(page);
  const saidAgain = await text(page, '[data-sheet] [data-own-status]');
  check(`${tag} GM: Make it private again keeps the same link`, again.private === true && again.inviteKey === fresh.inviteKey
    && saidAgain === 'Private now: The Sunless Vault is invite only. Copy the invite link and send it to the players you want.', { again: [again.private, again.inviteKey], saidAgain });

  // Run a game: Who can join, Invite only with Register interest
  await page.goto('about:blank');
  await page.goto(`${BASE}/pages/gm-games#host`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('[data-sheet][open] lair-session-form [data-host-form][data-step="game"]', { timeout: 15000 });
  const H = '[data-sheet]';
  await page.fill(`${H} [name="title"]`, `Invite-only crawl (${size})`);
  await page.click(`${H} [data-host-form] label.chip:has-text("Daggerheart")`);
  await page.fill(`${H} [name="blurb"]`, 'A private dungeon crawl for my regular table.');
  await page.click(`${H} [data-step-next]`);
  await page.waitForSelector(`${H} [data-step="players"]`);
  const who = await page.evaluate(() => {
    const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    const set = document.querySelector('[data-sheet] .sf-who-joins');
    return { legend: f(set?.querySelector('legend')?.textContent), options: [...(set?.querySelectorAll('.pay-option strong') || [])].map((x) => f(x.textContent)), hidden: set?.querySelector('[data-interest-wrap]')?.hidden };
  });
  check(`${tag} Run a game: the Players step asks Who can join (Anyone, Invite only), with Register interest hidden until Invite only`,
    who.legend === 'Who can join' && JSON.stringify(who.options) === JSON.stringify(['Anyone', 'Invite only']) && who.hidden === true, who);
  await page.click(`${H} [data-host-form] label.chip:has-text("All ages")`);
  await page.click(`${H} .sf-who-joins label.pay-option:has-text("Invite only")`);
  await settle(page, 150);
  const shown = await page.evaluate(() => document.querySelector('[data-sheet] [data-interest-wrap]')?.hidden);
  await page.click(`${H} [data-interest-wrap] .check__input`);
  await shot(page, `${size}-4-run-a-game-who`, `${H} .sf-who-joins`);
  await axe(page, `${tag} Run a game: Players with Who can join`, H);
  await page.click(`${H} [data-step-next]`);
  await page.waitForSelector(`${H} [data-step="table"]`);
  await page.click(`${H} [data-host-form] label.pay-option:has-text("Made at the table")`);
  await page.click(`${H} [data-step-next]`);
  await page.waitForSelector(`${H} [data-step="when"]`);
  const plan = await page.evaluate(() => {
    const { store } = window.Lair;
    const t = store.time;
    const day = t.addDays(t.today(), 4);
    const start = t.at(day, 18 * 60);
    const end = start + 4 * 3600000;
    for (const room of store.cfg.rooms) {
      if (!room.bookable || room.minPeople) continue;
      const free = room.tables.filter((tb) => store.isFree(tb.id, start, end) && !store.isShopTable(tb.id));
      if (free.length >= 2) return { day, tables: free.slice(0, 2).map((tb) => tb.id) };
    }
    return null;
  });
  await page.click(`${H} [data-day="${plan.day}"]`);
  await page.click(`${H} [data-slot="${18 * 60}"]`);
  await settle(page, 200);
  for (const id of plan.tables) {
    await page.evaluate((x) => document.querySelector(`[data-sheet] gm-floor [data-table="${x}"]`).click(), id);
    await settle(page, 120);
  }
  await page.click(`${H} [data-step-next]`);
  await page.waitForSelector(`${H} [data-step="you"]`);
  const review = flat(await page.locator(`${H} [data-review]`).innerText());
  check(`${tag} Run a game: Register interest shows once Invite only is picked, and the review says Who can join: Invite only, with interest`,
    shown === false && /Who can join\s*Invite only\. Players can register interest\./.test(review), { shown, review });
  await page.click(`${H} [data-step-next]`);
  await page.waitForSelector(`${H} .gm-done`, { timeout: 10000 });
  const done = await page.evaluate(() => {
    const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    const d = document.querySelector('[data-sheet] .gm-done');
    return { text: f(d?.textContent), url: d?.querySelector('[data-invite-url]')?.value || '' };
  });
  const made = await page.evaluate((title) => {
    const g = window.Lair.store.backend.state.games.find((x) => x.title === title);
    return g ? { private: g.private, interestOpen: g.interestOpen, key: g.inviteKey } : null;
  }, `Invite-only crawl (${size})`);
  check(`${tag} Run a game: listed as Private with interest, and the summary has the invite link to copy`,
    made && made.private === true && made.interestOpen === true && /^[a-z0-9]{20}$/.test(made.key)
    && /Your game is live on the board, as Private\. Only players with your invite link can join\./.test(done.text) && done.url === `${BASE}/pages/gm-games?invite=${made && made.key}`,
    { made, done });
  await shot(page, `${size}-4-run-a-game-listed`, '[data-sheet]');
  // the summary with its invite row (axe can't see a top-layer dialog's own background, so Gobgob's bubble above it
  // reads against whatever is on the page behind: checked by eye in the screenshot)
  await axe(page, `${tag} Run a game: listed, the summary with the invite link`, '[data-sheet] .gm-done .summary');
  check(`${tag} GM: no errors`, page.errors.length === 0, page.errors);
  await ctx.close();

  /* ---------- 5. the staff page ---------- */
  ctx = await context(browser, size);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/lair-staff', STAFF);
  await page.waitForSelector('#checkin-code', { timeout: 20000 });
  await seed(page);
  await page.click('[data-tab="games"]');
  await page.waitForSelector(`button.staff-gm-row[data-gm-manage="${ID}"]`, { timeout: 15000 });
  const listed = await text(page, `button.staff-gm-row[data-gm-manage="${ID}"] .staff-gm-row__meta`);
  check(`${tag} staff: the games list says Private`, /· Private$/.test(listed), listed);
  await page.click(`button.staff-gm-row[data-gm-manage="${ID}"]`);
  await page.waitForSelector('[data-gm-run-private] [data-gm-private-wrap]', { timeout: 15000 });
  const toast = () => page.evaluate(() => (document.querySelector('[data-live-region]')?.textContent || '').trim());
  const part = async () => page.evaluate(() => {
    const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    const p = document.querySelector('[data-gm-run-private]');
    return {
      text: f(p?.querySelector('p')?.textContent), url: p?.querySelector('[data-gm-invite-url]')?.value || '',
      buttons: [...(p?.querySelectorAll('.cluster button') || [])].map((b) => f(b.textContent)),
      badge: [...document.querySelectorAll('.staff-gm__badges .badge')].some((b) => b.textContent.trim() === 'Private'),
      h: f(document.querySelector('[data-gm-run-wrap] h4')?.textContent),
    };
  });
  const first = await part();
  check(`${tag} staff: the manager's Who can join: Invite only, the link, Take interest, New link, Make it public, and the Private badge`,
    first.h === 'Free, new players, who can join and the GM' && first.text === 'Invite only It shows on the board as Private, and only people with its invite link can join. It isn’t taking interest.'
    && first.url === `${BASE}/pages/gm-games?invite=${KEY}` && JSON.stringify(first.buttons) === JSON.stringify(['Take interest', 'New link', 'Make it public']) && first.badge, first);
  await shot(page, `${size}-5-staff-private`, '[data-gm-run-wrap]');
  await axe(page, `${tag} staff manager with Who can join`, '.staff-gm');
  check(`${tag} staff manager: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  await page.click('[data-gm-interest="true"]');
  await settle(page, 700);
  const tookInterest = { stored: (await stored(page)).interestOpen, toast: await toast(), first: (await part()).buttons[0] };
  check(`${tag} staff: Take interest (one tap)`, tookInterest.stored === true && tookInterest.toast === 'The Sunless Vault takes interest now: players can tell the GM they’d like to play.'
    && tookInterest.first === 'Stop taking interest', tookInterest);
  await page.click('[data-gm-private="false"]');
  await settle(page, 150);
  const askPublic = await text(page, '[data-gm-private="false"]');
  await page.click('[data-gm-private="false"]');
  await settle(page, 700);
  const pubStaff = await part();
  check(`${tag} staff: Make it public asks first (two taps), then anyone can join`,
    askPublic === 'Tap again to make it public' && (await stored(page)).private === false && /^Anyone can join/.test(pubStaff.text) && JSON.stringify(pubStaff.buttons) === JSON.stringify(['Make it private']),
    { askPublic, pubStaff, toast: await toast() });
  await page.click('[data-gm-private="true"]');
  await settle(page, 150);
  await page.click('[data-gm-private="true"]');
  await settle(page, 700);
  const privAgain = await stored(page);
  const privToast = await toast();
  check(`${tag} staff: Make it private (two taps) keeps the same link`, privAgain.private === true && privAgain.inviteKey === KEY && /^Private now: The Sunless Vault, /.test(privToast), { key: privAgain.inviteKey, privToast });
  await page.click('[data-gm-invite-new]');
  await settle(page, 150);
  const askNew = await text(page, '[data-gm-invite-new]');
  await page.click('[data-gm-invite-new]');
  await settle(page, 700);
  const newKey = (await stored(page)).inviteKey;
  const newToast = await toast();
  check(`${tag} staff: New link asks first, then the key changes and the box has the new link`,
    askNew === 'Tap again: the old link stops working' && newKey !== KEY && (await part()).url === `${BASE}/pages/gm-games?invite=${newKey}`
    && newToast === 'New invite link for The Sunless Vault. The old one doesn’t work any more, so send the GM this one.', { askNew, newKey, newToast });
  check(`${tag} staff: no errors`, page.errors.length === 0, page.errors);
  await ctx.close();
}

/* ---------- 6. the live backend's calls, against a stubbed Lair app ---------- */
m.globalSettings.lair_mode = 'live';
const calls = [];
m.mockState.before = async (req, res, url) => {
  if (!url.pathname.startsWith('/apps/liar/')) return false;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const route = url.pathname.replace('/apps/liar', '');
  let body = {};
  if (route === '/floor') body = { now: Date.now(), bookings: [], blocks: [], games: [], events: [], eventJoins: {}, eventSpots: {}, gameSpots: {}, eventInterest: {}, shopTables: [], openings: [], features: {} };
  else if (route.startsWith('/games/')) {
    calls.push({ method: req.method, route, body: raw ? JSON.parse(raw) : null });
    body = { game: { id: 'g1', private: true, invite: { key: KEY, url: 'x' } }, sessions: 1 };
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
};
{
  const ctx = await context(browser, 'desktop');
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/gm-games', RANGI);
  await page.waitForFunction(() => window.Lair && window.Lair.store && !window.Lair.store.isDemo, null, { timeout: 15000 });
  await page.evaluate(async (key) => {
    const be = window.Lair.store.backend;
    await be.setGamePrivate('g 1', { private: true, interest: true });
    await be.newInviteLink('g 1');
    await be.gameByInvite(key);
  }, KEY);
  check('live: setGamePrivate, newInviteLink and gameByInvite call the Lair app\'s routes',
    JSON.stringify(calls) === JSON.stringify([
      { method: 'POST', route: '/games/g%201/private', body: { private: true, interest: true } },
      { method: 'POST', route: '/games/g%201/invite/new', body: {} },
      { method: 'GET', route: `/games/invite/${KEY}`, body: null },
    ]), calls);
  await ctx.close();
}
m.mockState.before = null;
m.globalSettings.lair_mode = 'demo';

const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed. Screens in ${process.env.OUT}`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

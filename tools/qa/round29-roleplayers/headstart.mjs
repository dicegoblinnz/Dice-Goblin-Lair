// Round 29 (2 Nov 2026), the head-start loyalty card, on the theme mock (demo mode). Mo (2 Nov 2026) picked mockup A,
// "12 slots, 2 from Gobgob": "Every card shows 12 slots, the first 2 already filled as Gobgob's head start, so a d20
// roll still takes 10 paid visits. Cards in progress get the 2 as well: 7 of 10 shows as 9 of 12; 0 shows 2 of 12; 9
// shows 11 of 12; the 10th stamp completes the card, a roll becomes available exactly as today, and the next card shows
// 2 of 12." Progress shows wherever people book, each saying "X of 12".
// Checked here: My Lair's card (12 slots, three rows of four, Gobgob's 2 in gold with a sparkle and a screen reader
// label, the stamps, the next slot, the gold roll; "Card N · X of 12", the visits to go, the head-start note), the strip
// at the top of Home (a link to the card, 12 pills), 0, 9 and the 10th stamp, Gobgob's line after a roll on a fresh
// card, the Wallet's line; the staff page's check-in card, members list and member page ("9 of 12"); the booking
// confirmations (a TTRPG seat, an event sign-up and a table: "Your loyalty card: 9 of 12. Stamps land when you check
// in." for a member, nothing for a guest); an older Lair app (no slots): 10 slots everywhere. Nothing moves when the
// card fills in, no sideways scroll, no console errors, axe. 320, 390 and 1280 wide.
// Usage: DG_THEME=/path/to/theme [PORT=4989] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round29-roleplayers/headstart.mjs [small|phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round29-headstart');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, watch, go, clockAt, RUBY, STAFF, today } = lib;
const PORT = Number(process.env.PORT || 4989);
const BASE = `http://localhost:${PORT}`;
const VIEWPORTS = { small: { width: 320, height: 640 }, phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const sizes = process.argv[2] ? [process.argv[2]] : ['small', 'phone', 'desktop'];
const NOTE = "Gold is Gobgob's head start: every card begins with 2, so a roll is still 10 visits.";
const LINE = (on, slots = 12) => `Your loyalty card: ${on} of ${slots}. Stamps land when you check in.`;

const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 400) => page.waitForTimeout(ms);

async function context(size) {
  const phone = size !== 'desktop';
  const ctx = await browser.newContext({ viewport: VIEWPORTS[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(clockAt('13:00'));
  return ctx;
}
async function myLair(page, where = '/pages/my-lair') {
  await go(page, BASE, where, RUBY);
  await page.waitForSelector('[data-stamp-count] strong', { state: 'attached', timeout: 20000 });
  await settle(page);
}

/** The card and the strip as a member sees them */
const look = (page) => page.evaluate(() => {
  const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const card = document.querySelector('[data-stampcard]');
  const list = card.querySelector('[data-stamps]');
  const shown = (el) => el && getComputedStyle(el).display !== 'none';
  const slots = [...list.querySelectorAll('.ml-stamp')].filter(shown);
  const rects = slots.map((s) => s.getBoundingClientRect());
  const rows = [...new Set(rects.map((r) => Math.round(r.top)))].length;
  const strip = document.querySelector('[data-card-strip]');
  const pills = strip ? [...strip.querySelectorAll('.ml-strip__pill')].filter(shown) : [];
  const sr = (el) => f([...el.querySelectorAll('.visually-hidden')].map((x) => x.textContent).join(' '));
  return {
    count: f(card.querySelector('[data-stamp-count] strong')?.textContent),
    toGo: f(card.querySelector('[data-stamp-count] span')?.textContent),
    note: shown(card.querySelector('[data-card-note]')) && !card.querySelector('[data-card-note]').hidden ? f(card.querySelector('[data-card-note]').textContent) : '',
    ten: card.classList.contains('is-ten'),
    listLabel: list.getAttribute('aria-label'),
    listHidden: list.getAttribute('aria-hidden'),
    slots: slots.map((s) => ({
      kind: s.classList.contains('ml-stamp--head') ? 'head' : s.classList.contains('ml-stamp--roll') ? 'roll' : s.classList.contains('is-stamped') ? 'stamped' : s.classList.contains('is-next') ? 'next' : 'empty',
      no: f(s.querySelector('.ml-stamp__no')?.textContent),
      sr: sr(s),
      sparkle: Boolean(s.querySelector('.icon--sparkle')),
      next: s.classList.contains('is-next'),
    })),
    size: Math.round(rects[0]?.width || 0),
    rows,
    perRow: rects.filter((r) => Math.round(r.top) === Math.round(rects[0].top)).length,
    strip: strip && !strip.hidden ? {
      href: strip.getAttribute('href'), tag: strip.tagName, card: f(strip.querySelector('[data-strip-card]')?.textContent), left: f(strip.querySelector('[data-strip-left]')?.textContent),
      name: f(strip.textContent), height: Math.round(strip.getBoundingClientRect().height), top: Math.round(strip.getBoundingClientRect().top),
      pills: pills.map((p) => (p.classList.contains('ml-strip__pill--head') ? 'head' : p.classList.contains('ml-strip__pill--roll') ? 'roll' : p.classList.contains('is-on') ? 'on' : 'off')),
      leftColour: getComputedStyle(strip.querySelector('[data-strip-left]')).color,
    } : null,
    // the strip comes first on Home: before the Goblin card
    firstOnHome: (() => {
      const home = document.querySelector('[data-view="home"]');
      const s = home.querySelector('[data-card-strip]');
      const g = home.querySelector('.ml-gcard');
      return Boolean(s && g && (s.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING));
    })(),
  };
});
const want = (head, stamps, size = 10) => [...Array(head).fill('head'), ...Array.from({ length: size - 1 }, (_, i) => (i < stamps ? 'stamped' : i === stamps ? 'next' : 'empty')), 'roll'];
const pillsWant = (head, stamps, size = 10) => [...Array(head).fill('head'), ...Array.from({ length: size - 1 }, (_, i) => (i < stamps ? 'on' : 'off')), 'roll'];
/** Puts the demo member's card on `n` stamps (the card they're on stays the same), by the stamps from before the demo */
const setStamps = (page, n) => page.evaluate((k) => {
  const be = window.Lair.store.backend;
  const c = be.cfg.customer;
  const L = be.loyaltyFor(c);
  be.editLoyalty(String(c.id), (x) => { x.seeded = (Number(x.seeded) || 0) + (k - L.stamps); });
  be.commit();
}, n);
const addStamps = (page, n) => page.evaluate((k) => {
  const be = window.Lair.store.backend;
  be.editLoyalty(String(be.cfg.customer.id), (x) => { x.seeded = (Number(x.seeded) || 0) + k; });
  be.commit();
}, n);
const giveRolls = (page, n) => page.evaluate((k) => {
  const be = window.Lair.store.backend;
  be.editLoyalty(String(be.cfg.customer.id), (x) => { x.staff = (Number(x.staff) || 0) + k; });
  be.commit();
}, n);
const cardNow = (page) => page.evaluate(() => window.Lair.store.backend.loyaltyFor(window.Lair.store.backend.cfg.customer));
/** An older Lair app: its cards have no slots, headStart or onCard */
const olderLair = (page) => page.evaluate(() => {
  const be = window.Lair.store.backend;
  const strip = (L) => {
    if (L && typeof L === 'object') for (const k of ['slots', 'headStart', 'onCard']) delete L[k];
    return L;
  };
  for (const name of ['me', 'memberDetail', 'members', 'checkin', 'memberStamps']) {
    if (typeof be[name] !== 'function' || be[name].__older) continue;
    const real = be[name].bind(be);
    be[name] = async (...a) => {
      const answer = await real(...a);
      if (Array.isArray(answer)) answer.forEach((x) => strip(x && x.loyalty));
      else if (answer) {
        strip(answer.loyalty);
        if (answer.member) strip(answer.member.loyalty);
      }
      return answer;
    };
    be[name].__older = true;
  }
  const realCard = be.myCard.bind(be);
  be.myCard = () => strip({ ...realCard() });
});

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';
  const ctx = await context(size);
  const page = watch(await ctx.newPage());

  // ---------- nothing moves when the card fills in: the Liquid-only page (no my-lair.js) against the filled one ----------
  await page.route(/\/my-lair\.js(\?|$)/, (route) => route.abort());
  await go(page, BASE, '/pages/my-lair', RUBY);
  await settle(page, 300);
  const bare = await page.evaluate(() => ({
    strip: Math.round(document.querySelector('[data-card-strip]').getBoundingClientRect().height),
    card: Math.round(document.querySelector('[data-stampcard]').getBoundingClientRect().height),
    gcard: Math.round(document.querySelector('.ml-gcard').getBoundingClientRect().top),
  }));
  await page.unroute(/\/my-lair\.js(\?|$)/);
  page.errors.length = 0; // (the aborted script's own errors)
  await myLair(page);
  await setStamps(page, 7);
  await myLair(page);
  const filled = await page.evaluate(() => ({
    strip: Math.round(document.querySelector('[data-card-strip]').getBoundingClientRect().height),
    card: Math.round(document.querySelector('[data-stampcard]').getBoundingClientRect().height),
    gcard: Math.round(document.querySelector('.ml-gcard').getBoundingClientRect().top),
  }));
  check(`${tag} no layout shift: the strip and the card are the same height before and after they fill in, and the Goblin card stays put`,
    Math.abs(bare.strip - filled.strip) <= 1 && Math.abs(bare.card - filled.card) <= 1 && Math.abs(bare.gcard - filled.gcard) <= 1, { bare, filled });

  // ---------- 7 stamps: 9 of 12 ----------
  let L = await look(page);
  const n = (await cardNow(page)).card;
  check(`${tag} 7 of 10 shows as 9 of 12: "Card ${n} · 9 of 12" and "3 more visits to your next roll"`, L.count === `Card ${n} · 9 of 12` && L.toGo === '3 more visits to your next roll', L);
  check(`${tag} the 12 slots: Gobgob's 2 (gold, with a sparkle), 7 stamps, the next, 2 empty, the gold roll`, JSON.stringify(L.slots.map((s) => s.kind)) === JSON.stringify(want(2, 7)) && L.slots[0].sparkle && L.slots[1].sparkle, L.slots);
  check(`${tag} the stamps' slots are numbered 3 to 11`, JSON.stringify(L.slots.slice(2, 11).map((s) => s.no)) === JSON.stringify(['3', '4', '5', '6', '7', '8', '9', '10', '11']), L.slots.map((s) => s.no));
  check(`${tag} a screen reader hears each slot: "Head start from Gobgob" twice, Stamped, Next stamp, Empty, then the roll`,
    !L.listHidden && L.listLabel === "The card's slots" && L.slots[0].sr === 'Head start from Gobgob' && L.slots[1].sr === 'Head start from Gobgob'
      && L.slots[2].sr === 'Stamped' && L.slots[9].sr === 'Next stamp' && L.slots[10].sr === 'Empty' && L.slots[11].sr === 'Last slot: your d20 roll', L.slots.map((s) => s.sr));
  // (on a phone the card sits inside the section's padding: 44px or more at 320, 50 or more at 390, 60 at 1280)
  check(`${tag} three rows of four, about 60px each where there's room`, L.rows === 3 && L.perRow === 4 && L.size >= ({ small: 44, phone: 50, desktop: 58 })[size] && L.size <= 61, { rows: L.rows, perRow: L.perRow, size: L.size });
  check(`${tag} the note under the count: "${NOTE}"`, L.note === NOTE, L.note);
  check(`${tag} the strip is first on Home, a link to the card: "Card ${n} · 9 of 12", "3 visits to your roll" in gold, 12 pills (2 gold, 7 green, the rest faint, the last the roll's)`,
    L.firstOnHome && L.strip && L.strip.tag === 'A' && L.strip.href === '#ml-dice' && L.strip.card === `Card ${n} · 9 of 12` && L.strip.left === '3 visits to your roll'
      && L.strip.name === `My loyalty card: Card ${n} · 9 of 12, 3 visits to your roll` && JSON.stringify(L.strip.pills) === JSON.stringify(pillsWant(2, 7)) && L.strip.height >= 44
      && L.strip.leftColour === 'rgb(246, 185, 59)', L.strip);
  check(`${tag} the page's GET /me card says 9 of 12 for the confirmations`, await page.evaluate(() => window.Lair.cardLineHtml().includes('Your loyalty card: 9 of 12. Stamps land when you check in.')), await page.evaluate(() => window.Lair.cardLineHtml()));
  await page.locator('[data-card-strip]').scrollIntoViewIfNeeded();
  await shot(page, `${size}-1-home`, null);
  await shot(page, `${size}-2-strip`, '[data-card-strip]');
  await axe(page, `${tag} the strip`, '[data-card-strip]');
  await page.locator('.ml-stampcard').scrollIntoViewIfNeeded();
  await shot(page, `${size}-3-card-9of12`, '.ml-stampcard');
  await axe(page, `${tag} the loyalty card`, '.ml-roll');
  check(`${tag} My Lair: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  // the strip opens the card
  await page.click('[data-card-strip]');
  await settle(page, 600);
  const atCard = await page.evaluate(() => {
    const r = document.querySelector('#ml-dice').getBoundingClientRect();
    return { top: Math.round(r.top), inView: r.top < window.innerHeight && r.bottom > 0, hash: window.location.hash };
  });
  check(`${tag} tapping the strip takes them to the card`, atCard.inView && atCard.hash === '#ml-dice', atCard);

  // ---------- 0 stamps: 2 of 12; 9 stamps: 11 of 12 ----------
  await setStamps(page, 0);
  await myLair(page);
  L = await look(page);
  check(`${tag} 0 shows 2 of 12: Gobgob's 2, then the next slot (3), and "10 more visits to your next roll"`,
    L.count === `Card ${n} · 2 of 12` && L.toGo === '10 more visits to your next roll' && JSON.stringify(L.slots.map((s) => s.kind)) === JSON.stringify(want(2, 0)) && L.strip.left === '10 visits to your roll', L);
  await setStamps(page, 9);
  await myLair(page);
  L = await look(page);
  check(`${tag} 9 shows 11 of 12: one more visit, and the gold roll is next`,
    L.count === `Card ${n} · 11 of 12` && L.toGo === '1 more visit to your next roll' && L.slots[11].next && L.slots.filter((s) => s.kind === 'stamped').length === 9 && L.strip.left === '1 visit to your roll', L);
  await page.locator('.ml-stampcard').scrollIntoViewIfNeeded();
  await shot(page, `${size}-4-card-11of12`, '.ml-stampcard');

  // ---------- the 10th stamp completes the card: a roll as today, and the next card shows 2 of 12 ----------
  const rollsBefore = (await cardNow(page)).rolls.available;
  await addStamps(page, 1);
  await myLair(page);
  L = await look(page);
  const after = await cardNow(page);
  check(`${tag} the 10th stamp: card ${n + 1} at 2 of 12, one more roll ready, and "Card ${n} is full!"`,
    L.count === `Card ${n + 1} · 2 of 12` && after.rolls.available === rollsBefore + 1 && after.card === n + 1 && after.stamps === 0
      && (await page.evaluate(() => document.querySelector('[data-card-fresh]')?.textContent.trim())) === `Card ${n} is full! Its roll is ready below, and card ${n + 1} starts now.`, { count: L.count, after });
  // a roll on that fresh card: Gobgob's line under the coupon (the 14 is forced)
  await myLair(page, '/pages/my-lair?roll=14');
  await page.click('[data-roll-slots] [data-roll]');
  await page.waitForSelector('[data-roll-slots] [data-result]', { timeout: 10000 });
  await settle(page, 900);
  const rolled = await page.evaluate(() => ({
    kicker: document.querySelector('[data-roll-slots] .ml-prize__kicker')?.textContent.trim(),
    next: document.querySelector('[data-roll-slots] .ml-roll__next')?.textContent.trim() || '',
  }));
  check(`${tag} after the roll: "Card ${n + 1} is ready, and Gobgob's already started it."`, rolled.kicker === 'You rolled a 14: $14 store credit is yours.' && rolled.next === `Card ${n + 1} is ready, and Gobgob's already started it.`, rolled);
  await page.locator('.ml-roll').scrollIntoViewIfNeeded();
  await shot(page, `${size}-5-rolled`, '.ml-roll');
  await axe(page, `${tag} the card after a roll`, '.ml-roll');
  // with stamps on the card already, a roll doesn't say the card's ready
  await setStamps(page, 4);
  await giveRolls(page, 1);
  await myLair(page, '/pages/my-lair?roll=9');
  await page.click('[data-roll-slots] [data-roll]');
  await page.waitForSelector('[data-roll-slots] [data-result]', { timeout: 10000 });
  await settle(page, 900);
  check(`${tag} a roll on a card with stamps on it already: no "ready" line`, !(await page.$('[data-roll-slots] .ml-roll__next')), await page.evaluate(() => document.querySelector('[data-roll-slots]')?.textContent.replace(/\s+/g, ' ').slice(0, 200)));
  // a brand-new member (card 1, nothing on it) rolling a roll staff gave them (or a loot code's): no card has been
  // filled, so Gobgob never says "Card 1 is ready" (the head-start review, 2 Nov 2026: it only follows a full card)
  const keptRecord = await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const c = be.cfg.customer;
    const L = be.loyaltyFor(c);
    const was = JSON.parse(JSON.stringify(be.loyaltyOf(be.memberFor(c))));
    // nothing stamped, no rolls given, none used: then one roll from staff
    be.editLoyalty(String(c.id), (x) => Object.assign(x, {
      seeded: (Number(was.seeded) || 0) - (L.cards * 10 + L.stamps), welcome: 0, birthday: 0, staff: 0, codes: 0, used: 0, welcomeCode: null,
    }));
    be.commit();
    return was;
  });
  await giveRolls(page, 1);
  await myLair(page, '/pages/my-lair?roll=9');
  const fresh = await cardNow(page);
  await page.click('[data-roll-slots] [data-roll]');
  await page.waitForSelector('[data-roll-slots] [data-result]', { timeout: 10000 });
  await settle(page, 900);
  check(`${tag} a brand-new member (card 1, no stamps) rolls a roll staff gave them: no "Card 1 is ready" line`,
    fresh.card === 1 && fresh.stamps === 0 && !(await page.$('[data-roll-slots] .ml-roll__next')),
    { card: fresh.card, stamps: fresh.stamps, said: await page.evaluate(() => document.querySelector('[data-roll-slots] .ml-roll__next')?.textContent.trim() || '') });
  // (back to the card the checks below expect)
  await page.evaluate((was) => {
    const be = window.Lair.store.backend;
    be.editLoyalty(String(be.cfg.customer.id), (x) => {
      for (const key of Object.keys(x)) delete x[key];
      Object.assign(x, was);
    });
    be.commit();
  }, keptRecord);

  // ---------- the Wallet ----------
  await myLair(page, '/pages/my-lair#wallet');
  const sum = flat(await page.locator('[data-prizes] .ml-prizes__sum').innerText().catch(() => ''));
  check(`${tag} the Wallet: "Card ${n + 1}: 6 of 12, … filled so far."`, new RegExp(`^Card ${n + 1}: 6 of 12, \\d+ cards? filled so far\\.`).test(sum), sum);

  // ---------- an older Lair app (no slots): its 10 slots, as before ----------
  await myLair(page);
  await olderLair(page);
  await page.evaluate(() => document.querySelector('my-lair').refreshRolls());
  await settle(page, 600);
  L = await look(page);
  check(`${tag} an older Lair app: 10 slots numbered 1 to 9 and the roll, "Card ${n + 1} · 4 of 10", no gold and no note; the strip's 10 pills`,
    L.ten && JSON.stringify(L.slots.map((s) => s.kind)) === JSON.stringify(want(0, 4)) && JSON.stringify(L.slots.slice(0, 9).map((s) => s.no)) === JSON.stringify(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
      && L.count === `Card ${n + 1} · 4 of 10` && L.toGo === '6 more visits to your next roll' && !L.note && L.perRow === 5 && L.rows === 2
      && L.strip && L.strip.card === `Card ${n + 1} · 4 of 10` && JSON.stringify(L.strip.pills) === JSON.stringify(pillsWant(0, 4)), L);
  await page.locator('.ml-stampcard').scrollIntoViewIfNeeded();
  await shot(page, `${size}-6-older-lair`, '.ml-stampcard');
  check(`${tag} no console errors on My Lair`, !page.errors.length, page.errors.slice(0, 4));
  page.errors.length = 0;

  // ---------- booking confirmations: a TTRPG seat, an event sign-up and a table, member and guest ----------
  for (const who of ['member', 'guest']) {
    const customer = who === 'member' ? RUBY : null;
    await go(page, BASE, '/pages/my-lair', RUBY);
    await page.waitForSelector('[data-stamp-count] strong', { state: 'attached', timeout: 20000 });
    await setStamps(page, 7);
    await go(page, BASE, '/pages/gm-games', customer);
    await page.waitForSelector('gm-board', { state: 'attached', timeout: 20000 });
    await settle(page, 800);
    const game = await page.evaluate(() => {
      const now = Date.now();
      const g = window.Lair.store.data.games.filter((x) => x.status === 'open' && x.start > now + 30 * 3600000 && (x.seats - x.taken) > 0 && !x.private).sort((a, b) => a.start - b.start)[0];
      return g ? { id: g.id, title: g.title } : null;
    });
    check(`${tag} ${who}: there's a TTRPG session to join`, Boolean(game), game);
    if (game) {
      await page.evaluate((id) => document.querySelector('gm-board').joiner.open(id), game.id);
      await page.waitForSelector('gm-board [data-sheet][open] [data-session-join]', { timeout: 8000 });
      if (!customer) {
        await page.fill('[data-session-join] [name="name"]', 'Jo Example');
        await page.fill('[data-session-join] [name="email"]', 'jo@example.com');
      }
      await page.fill('[data-session-join] [name="phone"]', '021 555 0102');
      await page.click('[data-join-submit]');
      await page.waitForSelector('gm-board .gm-done', { timeout: 8000 }).catch(() => {});
      await settle(page, 500);
      const line = flat(await page.locator('gm-board .gm-done [data-card-line]').innerText().catch(() => ''));
      check(`${tag} ${who}: the TTRPG seat's confirmation ${customer ? `says "${LINE(9)}"` : 'says nothing about a card'}`, customer ? line === LINE(9) : line === '', line);
      if (customer) {
        await page.evaluate(() => document.querySelector('gm-board .gm-done [data-card-line]')?.scrollIntoView({ block: 'center' }));
        await shot(page, `${size}-7-seat-confirmation`, null);
        await axe(page, `${tag} the seat's confirmation`, 'gm-board [data-sheet][open]');
      }
    }
    // an event sign-up
    await go(page, BASE, '/pages/events-calendar', customer);
    await page.waitForSelector('lair-calendar', { state: 'attached', timeout: 20000 });
    await settle(page, 800);
    const ev = await page.evaluate(() => {
      const now = Date.now();
      const el = document.querySelector('lair-calendar');
      const all = typeof el.all === 'function' ? el.all() : [];
      const e = all.find((i) => i.kind === 'event' && i.capacity && !i.gameTables && !i.product && i.start - now > 30 * 3600000);
      return e ? { id: e.id, title: e.title } : null;
    });
    if (ev) {
      await page.evaluate((id) => document.querySelector('lair-calendar').openJoin(id), ev.id);
      await page.waitForSelector('lair-calendar [data-join-form]', { timeout: 8000 });
      if (!customer) {
        await page.fill('[data-join-form] [name="name"]', 'Mere Example');
        await page.fill('[data-join-form] [name="email"]', 'mere@example.com');
      }
      await page.fill('[data-join-form] [name="phone"]', '021 555 0104');
      await page.click('button[form="cal-join-form"]');
      await page.waitForSelector('lair-calendar .cal-done', { timeout: 8000 }).catch(() => {});
      await settle(page, 500);
      const line = flat(await page.locator('lair-calendar .cal-done [data-card-line]').innerText().catch(() => ''));
      check(`${tag} ${who}: ${ev.title}'s sign-up confirmation ${customer ? `says "${LINE(9)}"` : 'says nothing about a card'}`, customer ? line === LINE(9) : line === '', line);
      if (customer) {
        await page.evaluate(() => document.querySelector('lair-calendar .cal-done [data-card-line]')?.scrollIntoView({ block: 'center' }));
        await shot(page, `${size}-8-signup-confirmation`, null);
        await axe(page, `${tag} the sign-up's confirmation`, 'lair-calendar [data-dialog]');
      }
    } else {
      check(`${tag} ${who}: there's an event to sign up for`, false, 'none found');
    }
    // a table: booked through the store, its confirmation drawn by lair-booking (the demo's table booking page asks
    // GET /me for nothing, so the card is the demo's own, myCard)
    await go(page, BASE, '/pages/book-a-table', customer);
    await page.waitForSelector('lair-booking', { state: 'attached', timeout: 20000 });
    await settle(page, 800);
    const table = await page.evaluate(async (ahead) => {
      const store = window.Lair.store;
      const t = store.time;
      const day = t.addDays(t.today(), ahead);
      const start = t.at(day, 18 * 60);
      const free = store.cfg.tables.find((x) => x.room === 'main-room' && !/^T[123]$/.test(x.id)) || store.cfg.tables[5];
      const room = store.roomOf(free.id);
      const result = await store.mutate('createBooking', {
        kind: 'table', tables: [free.id], room: room.id, start, end: start + 2 * 3600000, people: 2, extras: [], name: 'Ruby Tane', email: 'ruby@example.com', phone: '021 555 0105', notes: '',
        amount: (room.price || store.cfg.prices.table) * 2, customerId: store.cfg.customer ? store.cfg.customer.id : null,
      });
      const el = document.querySelector('lair-booking');
      el.showDone(result.booking, result);
      return { ref: result.booking && result.booking.ref };
    }, customer ? 2 : 3).catch((e) => ({ error: e.message }));
    await settle(page, 500);
    const tline = flat(await page.locator('lair-booking [data-done] [data-card-line]').innerText().catch(() => ''));
    check(`${tag} ${who}: the table's confirmation ${customer ? `says "${LINE(9)}"` : 'says nothing about a card'}`, !table.error && (customer ? tline === LINE(9) : tline === ''), { table, tline });
    if (customer) {
      // (on the one booking page the form is in a sheet: open it to see the confirmation)
      await page.evaluate(() => {
        const sheet = document.querySelector('lair-booking')?.closest('dialog');
        if (sheet && !sheet.open) sheet.showModal();
      });
      await settle(page, 400);
      await page.evaluate(() => document.querySelector('lair-booking [data-done] [data-card-line]')?.scrollIntoView({ block: 'center' }));
      await shot(page, `${size}-9-table-confirmation`, null);
      await axe(page, `${tag} the table's confirmation`, 'lair-booking [data-done]');
      // an older Lair app: the line says 7 of 10
      await olderLair(page);
      check(`${tag} an older Lair app's card on a confirmation: "${LINE(7, 10)}"`, await page.evaluate((w) => window.Lair.cardLineHtml().includes(w), LINE(7, 10)), await page.evaluate(() => window.Lair.cardLineHtml()));
    }
    check(`${tag} ${who}: the booking pages: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  }
  check(`${tag} no console errors on the booking pages`, !page.errors.length, page.errors.slice(0, 4));
  page.errors.length = 0;

  // ---------- the staff page: the check-in card, the members list and a member's page ----------
  await go(page, BASE, '/pages/lair-staff#members', STAFF);
  await page.waitForSelector('.staff-mem-row', { timeout: 20000 });
  const aroha = await page.evaluate(async () => (await window.Lair.store.backend.members({ q: 'Aroha Ngata' })).find((x) => x.name === 'Aroha Ngata'));
  const ci = () => page.evaluate(() => {
    const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    const el = document.querySelector('.checkin-card--member .checkin-card__loyalty');
    return {
      count: f(el?.querySelector('.staff-loyalty__count')?.textContent),
      // the count and what it's made of, each on its own line
      lines: (() => {
        const c = el?.querySelector('.staff-loyalty__count');
        if (!c) return 0;
        return new Set([c.querySelector('strong'), c.querySelector('.staff-loyalty__made')].filter(Boolean).map((x) => Math.round(x.getBoundingClientRect().top))).size;
      })(),
      dots: [...(el ? el.querySelectorAll('.staff-loyalty__dot') : [])].map((d) => (d.classList.contains('is-head') ? 'head' : d.classList.contains('is-on') ? 'on' : d.classList.contains('is-roll') ? 'roll' : 'off')),
    };
  });
  await page.fill('#checkin-code', aroha.code);
  await page.click('.checkin__go');
  await page.waitForSelector('.checkin-card--member .checkin-card__loyalty', { timeout: 15000 });
  await settle(page);
  const s = aroha.loyalty.stamps;
  let k = await ci();
  check(`${tag} staff check-in card: "${s + 2} of 12", under it "${s} stamps and Gobgob’s 2", and 12 dots (2 gold)`,
    k.count === `${s + 2} of 12, ${s === 1 ? '1 stamp' : `${s} stamps`} and Gobgob’s 2` && k.lines === 2 && k.dots.length === 12 && k.dots.slice(0, 2).every((d) => d === 'head') && k.dots.filter((d) => d === 'on').length === s && k.dots[11] === 'roll', k);
  await page.click('[data-checkin-stamp]');
  await settle(page, 700);
  const toast = flat(await page.locator('.toast').last().innerText().catch(() => ''));
  check(`${tag} Add a stamp: "Stamp added: Aroha is on ${(s + 1) % 10 + 2} of 12."`, s + 1 >= 10 ? /card is full/.test(toast) : toast === `Stamp added: Aroha is on ${s + 3} of 12.`, toast);
  await page.evaluate(() => document.querySelector('.checkin-card__loyalty')?.scrollIntoView({ block: 'center' }));
  await shot(page, `${size}-10-checkin-card`, '.checkin-card--member');
  await axe(page, `${tag} the check-in card`, '.checkin-card--member');
  check(`${tag} staff check-in: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  await page.click('[data-checkin-stamp-undo]').catch(() => {});
  await settle(page, 600);
  await page.click('[data-checkin-clear]').catch(() => {});
  await settle(page, 300);
  // the members list
  await go(page, BASE, '/pages/lair-staff#members', STAFF);
  await page.waitForSelector('.staff-mem-row', { timeout: 20000 });
  await settle(page, 500);
  const cell = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.staff-mem-row')].find((r) => /Aroha Ngata/.test(r.textContent));
    const v = row?.querySelector('.staff-mem-row__cell--card .staff-mem-row__v');
    return { shown: v?.querySelector('[aria-hidden="true"]')?.textContent.trim(), sr: v?.querySelector('.visually-hidden')?.textContent.trim() };
  });
  check(`${tag} the members list: "${s + 2}/12", read out as "${s + 2} of 12 on their card"`, cell.shown === `${s + 2}/12` && cell.sr === `${s + 2} of 12 on their card`, cell);
  // a member's page
  await page.locator('.staff-mem-row', { hasText: 'Aroha Ngata' }).first().click();
  await page.waitForSelector('[data-person-loyalty] .staff-loyalty__count', { timeout: 15000 });
  await settle(page);
  const pageCard = await page.evaluate(() => {
    const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    const root = document.querySelector('[data-person-loyalty]');
    return { count: f(root.querySelector('.staff-loyalty__count')?.textContent), dots: [...root.querySelectorAll('.staff-loyalty__dot')].map((d) => (d.classList.contains('is-head') ? 'head' : d.classList.contains('is-on') ? 'on' : d.classList.contains('is-roll') ? 'roll' : 'off')) };
  });
  check(`${tag} a member's page: "${s + 2} of 12, … and Gobgob’s 2", 12 dots`, pageCard.count.startsWith(`${s + 2} of 12, `) && pageCard.count.endsWith('and Gobgob’s 2') && pageCard.dots.length === 12 && pageCard.dots.slice(0, 2).join() === 'head,head', pageCard);
  // Add stamps on their page: the toast says where they're up to
  await page.fill('[data-stamps-form] [name="count"]', '1');
  await page.click('[data-stamps-form] button[type="submit"]');
  await settle(page, 700);
  const toast2 = flat(await page.locator('.toast').last().innerText().catch(() => ''));
  check(`${tag} Add stamps on a member's page: "… Aroha is on ${(s + 1) % 10 + 2} of 12."`, toast2.endsWith(`Aroha is on ${(s + 1) % 10 + 2} of 12.`), toast2);
  await page.evaluate(() => document.querySelector('.staff-loyalty')?.scrollIntoView({ block: 'start' }));
  await shot(page, `${size}-11-member-page`, '.staff-loyalty');
  await page.evaluate(() => document.querySelector('.staff-loyalty__card')?.scrollIntoView({ block: 'center' }));
  await axe(page, `${tag} a member's page`, '.staff-loyalty');
  check(`${tag} a member's page: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  // an older Lair app: "7 of 10 stamps" again
  await olderLair(page);
  await page.click('[data-members-back]');
  await page.waitForSelector('.staff-mem-row', { timeout: 15000 });
  await page.evaluate(() => {
    const el = document.querySelector('lair-staff');
    for (const x of Object.values(el.members.people)) if (x.loyalty) for (const key of ['slots', 'headStart', 'onCard']) delete x.loyalty[key];
  });
  await page.locator('.staff-mem-row', { hasText: 'Aroha Ngata' }).first().click();
  await page.waitForSelector('[data-person-loyalty] .staff-loyalty__count', { timeout: 15000 });
  await settle(page);
  const old = await page.evaluate(() => {
    const root = document.querySelector('[data-person-loyalty]');
    return { count: root.querySelector('.staff-loyalty__count')?.textContent.replace(/\s+/g, ' ').trim(), dots: root.querySelectorAll('.staff-loyalty__dot').length, head: root.querySelectorAll('.staff-loyalty__dot.is-head').length };
  });
  check(`${tag} an older Lair app on a member's page: "N of 10 stamps", 10 dots, no gold head start`, /^\d of 10 stamps$/.test(old.count) && old.dots === 10 && old.head === 0, old);
  check(`${tag} no console errors on the staff page`, !page.errors.length, page.errors.slice(0, 4));
  await ctx.close();
}

const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed (today ${today}; shots in ${process.env.OUT})`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

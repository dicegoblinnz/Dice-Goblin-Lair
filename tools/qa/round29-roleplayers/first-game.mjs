// Round 29, roleplayers phase 1, item 3 (contract v29-roleplayers section 3): "Your first game" on the theme mock, with
// the real Lair app in this process (node:sqlite), and then the website lab's demo. Mo approved it on 2 Nov 2026 from
// mockups A (the front door), B (the join sheet and "You're in") and D3 (the email the day after).
// Checked at 320, 390 and 1280 wide:
//  - the TTRPG page's front door: logged out it shows (printed from the sessions feed before any script runs, and the
//    same once the board's data is in, so nothing moves): mockup A's words, this week's beginner games with seats
//    (soonest first, 3 at most), See all N games this week, the cost line and Gobgob's line, above For GMs and
//    organisers (below it when the section says so); a new member sees it (and next time before any script runs), a
//    member who's played doesn't;
//  - the join sheet: "Is this your first roleplaying game?" with neither chip picked; after Yes, the GM line, how they
//    get a character and the unticked box (keeping my seat at a weekly game, my next game at a one-shot); a member
//    who's played isn't asked; the answer and the box land on the seat; the GM's email says it's their first game;
//  - "You're in, Sam!" and What happens next (the GM's email, the reminder's day only when one will go, when to come,
//    the counter, what to pay, and the section's access note); "I've played before" and no answer get the usual one;
//  - the counter: the staff page's check-in card and a member's check-in list say "First game" with what to do;
//  - the email the day after's "Don't send me emails like this": the key is out of the address before the page's own
//    scripts run and never in a request's address; opening it stops nothing; one tap stops them (straight away, kept
//    by email); again, "already"; a wrong key says so, with the phone number;
//  - the demo: the front door and joining with "Yes, my first" work the same.
// No sideways scroll, no console errors, nothing outside localhost, axe on each part.
// Usage (from the Lair repo): DG_THEME=/path/to/theme [AXE=/path/to/axe.min.js] [PORT=4996] [OUT=dir] node tools/qa/round29-roleplayers/first-game.mjs [small|phone|desktop]
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round29-first-game');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, overflowX, axe, shot, watch, clockAt, iso, today } = lib;

/* ---------------- the clock: today at 1pm in Auckland, ticking, for the Lair app here and the pages alike ---------------- */
const RealDate = Date;
const OFFSET = Date.parse(iso(today, '13:00')) - RealDate.now();
class LairDate extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(RealDate.now() + OFFSET);
    else super(...a);
  }
  static now() {
    return RealDate.now() + OFFSET;
  }
}
globalThis.Date = LairDate;

const { Lair } = await import('../../../src/lair.js');
const { LairTime, rulesFromSettings, DEFAULT_HOURS } = await import('../../../src/core.js');
const { sessionsFeed, LOGGED_OUT } = await import('../../../src/sessions-feed.js');
const { UNSUBSCRIBE_WORDS } = await import('../../../src/first-game.js');
const PORT = Number(process.env.PORT || 4996);
const BASE = `http://localhost:${PORT}`;
const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const addDays = (key, n) => new RealDate(RealDate.UTC(...key.split('-').map((x, i) => (i === 1 ? x - 1 : +x))) + n * 864e5).toISOString().slice(0, 10);
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const weekday = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, weekday: 'long' }).format(new RealDate(at(key, 12)));
const short = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(new RealDate(at(key, 12))).replace(/,/g, '');
const VIEWPORTS = { small: { width: 320, height: 640 }, phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const sizes = process.argv[2] ? [process.argv[2]] : ['small', 'phone', 'desktop'];

// Days: Goblin Kitchen tonight, Abomination Vaults in 2 days (not for beginners), Candlekeep Mysteries in 3 (weekly),
// The Titans Heart in 4; the email the day after Candlekeep goes the morning after it
const TODAY = today;
const D2 = addDays(TODAY, 2);
const D3 = addDays(TODAY, 3);
const D4 = addDays(TODAY, 4);
const RIA = { id: 7700112233, first_name: 'Ria', last_name: 'Moana', name: 'Ria Moana', email: 'ria@example.com', phone: null, tags: [], store_credit_account: { balance: 0 }, orders_count: 0, orders: [] };
const KAI = { id: 7700112244, first_name: 'Kai', last_name: 'Tane', name: 'Kai Tane', email: 'kai@example.com', phone: null, tags: [], store_credit_account: { balance: 0 }, orders_count: 0, orders: [] };
const STAFF = { id: 9001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const GM = '7001';
const ADDRESS = '56/691 Manukau Road, Royal Oak, Auckland 1023';
const MOBILE = '021 555 0100';
const HINT = 'Walk them to their GM, and point out drinks, the bathroom and the lift.';

/* ---------------- the Lair app, in this process, with a pretend Shopify and Resend ---------------- */
const db = new DatabaseSync(':memory:');
const sql = {
  exec(q, ...b) {
    const st = db.prepare(q);
    if (/^\s*(select|with)/i.test(q)) {
      const rows = st.all(...b);
      return { toArray: () => rows, one: () => rows[0] };
    }
    st.run(...b);
    return { toArray: () => [], one: () => undefined };
  },
};
const pending = [];
const lair = new Lair({ storage: { sql, get: async () => null, put: async () => {} }, waitUntil: (p) => pending.push(p) }, {
  CURRENCY: 'NZD', SHOP: 'ep0qiq-rp.myshopify.com', RESEND_API_KEY: 'test', FROM_EMAIL: 'gobgob@example.com', STAFF_EMAIL: 'staff@example.com',
  PUBLIC_URL: 'https://lair.example.com',
});
const drain = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};
// reminders on, as the lab's settings say (absent, the Lair sends none and the confirmation promises none)
lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '', store_phone: '021 159 6894', lair_booking_reminders: true }, [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }], [], { address: ADDRESS });
lair.rulesLoadedAt = Date.now() + 365 * 24 * 3600_000;
Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
lair.shopify.graphql = async () => {
  throw new Error('No Shopify in this check');
};
lair.taggedPerson = async (id) => ({ customerId: id || null, staff: String(id) === String(STAFF.id), gm: String(id) === GM, tags: [] });
lair.shopify.orderSpend = async () => null;
lair.shopify.orderBuyer = async () => null;
lair.shopify.customerEmail = async () => null;
lair.accountEmail = async () => ({ fetched: false, email: '' });
lair.checkGiftCodes = async () => 0;
const mails = [];
lair.mail = async (message) => {
  mails.push(message);
  return { ok: true, attempted: true, status: 200 };
};
lair.mailMany = async (messages) => {
  mails.push(...messages);
  return { ok: true, attempted: true, status: 200, sent: messages.length };
};
const riaMember = lair.makeMember({ customerId: String(RIA.id), name: RIA.name, email: RIA.email }, Date.now());
lair.makeMember({ customerId: String(KAI.id), name: KAI.name, email: KAI.email }, Date.now());
lair.makeMember({ customerId: GM, name: 'Ellie Rua', email: 'ellie@example.com' }, Date.now());
const api = async (method, route, body, customer = '') => {
  const res = await lair.fetch(new Request(`https://lair.test/${route}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer }, body: body ? JSON.stringify(body) : undefined,
  }));
  await drain();
  const data = await res.json();
  if (res.status !== 200) throw new Error(`${route}: ${res.status} ${data.error}`);
  return data;
};
const listGame = async (more) => (await api('POST', 'games', { gm: 'Ellie', email: 'ellie@example.com', blurb: 'A night of dice.', ...more }, GM)).game;
const goblin = await listGame({ title: 'Goblin Kitchen Nightmares', system: 'D&D 5e', seats: 4, tables: ['T6'], start: at(TODAY, 19), end: at(TODAY, 22), characters: 'bring', level: 'new' });
const vaults = await listGame({ title: 'Abomination Vaults', system: 'Pathfinder 2e', seats: 4, tables: ['T8'], start: at(D2, 17), end: at(D2, 21), characters: 'bring', level: 'some' });
const candlekeep = await listGame({ title: 'Candlekeep Mysteries', system: 'D&D 5e', seats: 4, tables: ['T12'], start: at(D3, 18), end: at(D3, 22), schedule: 'weekly', characters: 'pregens', level: 'new' });
const titans = await listGame({ title: 'The Titans Heart', system: 'D&D 5e', seats: 6, tables: ['T13', 'T14'], start: at(D4, 18), end: at(D4, 22), characters: 'at-table', level: 'new', gmFee: 1000 });
// Kai has played: a seat at a session last week, checked in and done
lair.saveBooking({
  id: 'bk_kaiplayed00000001', ref: 'KT-OWLBEAR-11', kind: 'gm-seat', status: 'done', gameId: null, tables: ['T3'], start: at(addDays(TODAY, -7), 18), end: at(addDays(TODAY, -7), 21),
  people: 1, name: KAI.name, email: KAI.email, amount: 1500, paid: true, customerId: String(KAI.id),
}, Date.now() - 7 * 864e5);
const row = (id) => lair.sql.exec('SELECT * FROM bookings WHERE id = ?', id).toArray()[0];
const seatOf = (email) => lair.sql.exec("SELECT * FROM bookings WHERE kind = 'gm-seat' AND lower(email) = ? ORDER BY created_at DESC LIMIT 1", email.toLowerCase()).toArray()[0];

/* ---------------- the theme mock, live, with /apps/liar going to the Lair above ---------------- */
const API = '/apps/liar';
m.mockState.before = async (req, res, url) => {
  if (!url.pathname.startsWith(`${API}/`)) return false;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const route = url.pathname.slice(API.length);
  const response = await lair.fetch(new Request(`https://lair.test${route}${url.search}`, {
    method: req.method,
    headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': m.mockState.customer ? String(m.mockState.customer.id) : '', 'X-Lair-Client': '203.0.113.29' },
    body: req.method === 'POST' ? raw || '{}' : undefined,
  }));
  await drain();
  res.writeHead(response.status, { 'Content-Type': response.headers.get('Content-Type') || 'application/json' });
  res.end(await response.text());
  return true;
};
/** The shop metafield lair.sessions, as the Lair app's 10-minute run writes it (src/sessions-feed.js) */
const refreshFeed = async () => {
  const now = Date.now();
  const board = await lair.floor(new URL(`https://lair.internal/floor?from=${now}&to=${now + 14 * 864e5}`), LOGGED_OUT);
  m.mockState.sessionsFeed = sessionsFeed(board.games, { now });
};
const server = await m.serve(PORT);
const browser = await chromium.launch();
const outside = [];
const requests = [];

async function open(size, who, where, { block = null, live = true } = {}) {
  m.globalSettings.lair_mode = live ? 'live' : 'demo';
  const phone = size !== 'desktop';
  const ctx = await browser.newContext({ viewport: VIEWPORTS[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(clockAt('13:00'));
  await ctx.route(/^https?:\/\/(?!localhost)/, (route) => {
    outside.push(route.request().url());
    return route.abort();
  });
  if (block) await ctx.route(block, (route) => route.abort());
  // what the page's own scripts see of the address, once the document is parsed (the head snippets have run by then);
  // hash changes and history steps as a listener added before any page script gets them (as a browser extension could),
  // which shows a same-tab link really fired them; and as a listener as late as the page's own (My Lair's router listens
  // for hash changes), which must never get an unsubscribe link
  await ctx.addInitScript(() => {
    window.__early = [];
    window.addEventListener('hashchange', (event) => window.__early.push(event.newURL));
    window.addEventListener('popstate', () => window.__early.push(`popstate ${window.location.href}`));
    document.addEventListener('DOMContentLoaded', () => {
      window.__seenAddress = window.location.href;
      window.__late = [];
      window.addEventListener('hashchange', (event) => window.__late.push(event.newURL));
      window.addEventListener('popstate', () => window.__late.push(`popstate ${window.location.href}`));
    });
  });
  const page = watch(await ctx.newPage());
  page.on('request', (r) => requests.push({ url: r.url(), referer: r.headers().referer || '' }));
  m.mockState.customer = who;
  await page.goto(`${BASE}${where}`, { waitUntil: 'networkidle', timeout: 60000 });
  return { ctx, page };
}
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
/** An element's screenshot without the sticky header over it (it scrolls with the page for the shot) */
async function shotOf(page, name, sel) {
  const unstick = await page.addStyleTag({ content: '[id^="shopify-section-"]:has(> .site-header) { position: static !important; }' });
  await shot(page, name, sel);
  await unstick.evaluate((el) => el.remove());
}
/** The page as it first shows, from the top */
async function shotTop(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  await shot(page, name, null, false);
}
const text = (page, sel) => page.$eval(sel, (e) => (e.hidden ? '' : e.textContent.replace(/\s+/g, ' ').trim())).catch(() => '');
const settle = (page, ms = 400) => page.waitForTimeout(ms);
/** The front door as it is on the page */
const door = (page) => page.evaluate(() => {
  const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const box = document.querySelector('[data-first-game]');
  if (!box) return null;
  const organise = document.querySelector('.play__organise');
  const step1 = box.querySelector('.first-game__steps li:first-child .first-game__step');
  const bolds = step1 ? [...step1.querySelectorAll('b, strong')] : [];
  return {
    hidden: box.hidden,
    shown: !box.hidden && box.getBoundingClientRect().height > 0,
    beforeOrganise: Boolean(organise && (box.compareDocumentPosition(organise) & Node.DOCUMENT_POSITION_FOLLOWING)),
    eyebrow: f(box.querySelector('.first-game__eyebrow')?.textContent),
    title: f(box.querySelector('.first-game__title')?.textContent),
    intro: f(box.querySelector('.first-game__intro')?.textContent),
    steps: [...box.querySelectorAll('.first-game__step')].map((s) => f(s.textContent)),
    readyColour: bolds[1] ? getComputedStyle(bolds[1]).color : '',
    firstBoldColour: bolds[0] ? getComputedStyle(bolds[0]).color : '',
    week: f(box.querySelector('.first-game__week')?.textContent),
    cards: [...box.querySelectorAll('.first-game__card')].map((c) => ({
      name: f(c.querySelector('.first-game__name')?.textContent), price: f(c.querySelector('.first-game__price')?.textContent),
      meta: f(c.querySelector('.first-game__meta')?.textContent), chip: f(c.querySelector('.first-game__chip')?.textContent),
      chipKind: c.querySelector('.first-game__chip')?.dataset.characters || '', left: f(c.querySelector('.first-game__left')?.textContent),
      join: f(c.querySelector('[data-first-join]')?.textContent), href: c.querySelector('[data-first-join]')?.getAttribute('href') || '',
    })),
    empty: f(box.querySelector('.first-game__empty')?.textContent),
    all: box.querySelector('.first-game__all')?.hidden ? '' : f(box.querySelector('[data-first-game-all]')?.textContent),
    allHref: box.querySelector('[data-first-game-all]')?.getAttribute('href') || '',
    cost: box.querySelector('[data-first-game-cost]')?.hidden ? '' : f(box.querySelector('[data-first-game-cost-text]')?.textContent),
    gob: f(box.querySelector('.first-game__gob .gob-says')?.textContent),
    height: Math.round(box.getBoundingClientRect().height),
    top: Math.round(box.getBoundingClientRect().top + window.scrollY),
  };
});
const sheet = (page) => page.evaluate(() => {
  const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const d = document.querySelector('gm-board dialog[data-sheet]');
  if (!d) return null;
  const q = (s) => d.querySelector(s);
  return {
    open: d.open,
    title: f(q('[data-sheet-title]')?.textContent),
    asked: f(q('[data-first-ask] legend')?.textContent),
    chips: [...d.querySelectorAll('input[name="firstGame"]')].map((i) => ({ value: i.value, checked: i.checked, label: f(i.closest('label')?.textContent) })),
    more: q('[data-first-more]') ? !q('[data-first-more]').hidden : false,
    note: f(q('.gm-first__note')?.textContent),
    box: q('input[name="followUp"]') ? { checked: q('input[name="followUp"]').checked, label: f(q('input[name="followUp"]').closest('label')?.textContent) } : null,
    next: [...d.querySelectorAll('.gm-next__list li')].map((li) => f(li.textContent)),
    nextTitle: f(q('.gm-next__title')?.textContent),
    access: f(q('.gm-next__access')?.textContent),
    told: f(q('.gm-ticket__told')?.textContent),
    arrive: [...d.querySelectorAll('.gm-done > p.small.muted')].map((p) => f(p.textContent)).join(' | '),
    card: f(q('.gm-card-line, .lair-card-line, [data-card-line]')?.textContent),
    done: Boolean(q('.gm-done')),
  };
});
/** Fill in a guest's details and join */
async function guestJoin(page, name, email) {
  await page.fill('gm-board dialog [data-session-join] input[name="name"]', name);
  await page.fill('gm-board dialog [data-session-join] input[name="email"]', email);
  await page.fill('gm-board dialog [data-session-join] input[name="phone"]', MOBILE);
  await page.click('gm-board dialog [data-join-submit]');
  await page.waitForSelector('gm-board dialog .gm-done', { timeout: 15000 });
  await settle(page);
}
async function memberJoin(page) {
  await page.fill('gm-board dialog [data-session-join] input[name="phone"]', MOBILE);
  await page.click('gm-board dialog [data-join-submit]');
  await page.waitForSelector('gm-board dialog .gm-done', { timeout: 15000 });
  await settle(page);
}
const openJoin = async (page, gameId) => {
  await page.click(`[data-first-join="${gameId}"]`);
  await page.waitForSelector('gm-board dialog[open] [data-session-join]', { timeout: 15000 });
  await settle(page, 300);
};
const pick = (page, value) => page.click(`gm-board dialog label:has(input[name="firstGame"][value="${value}"])`);
const reminderLine = (key) => `We'll email you on ${weekday(addDays(key, -2))} as a reminder.`;
const GM_LINE = "Your GM gets an email saying it's your first game.";
const COUNTER = "Give your name at the counter. We'll walk you to your table and introduce your GM.";
const come = (key) => {
  const label = key === TODAY ? 'Today' : key === addDays(TODAY, 1) ? 'Tomorrow' : `On ${weekday(key)}`;
  return `${label}, come up to the Lair, above Whitcoulls, a few minutes early.`;
};

const STEPS = [
  "Pick a game. Look for Character ready if you'd rather not make one.",
  "Say it's your first game when you book. Your GM gets a heads-up.",
  "Come up and say hi. We'll walk you to your table.",
];
const POTION = 'rgb(167, 123, 255)';
const want = {
  eyebrow: 'New to roleplaying?', title: 'Your first game, sorted', intro: "Never played? That's fine. These games are made for beginners, and your GM walks you through it.",
  week: 'This week, with seats left', gob: "Nobody's born knowing the rules, friend. That's what the GM is for.Gobgob",
};
const leftWords = (n) => (n === 1 ? '1 seat left' : `${n} seats left`);
const cardsWant = () => [
  { name: 'Goblin Kitchen Nightmares', price: '$15', meta: `D&D 5e · ${short(TODAY)}, 7pm to 10pm · one-shot`, chip: 'Bring your own character', chipKind: 'bring', left: leftWords(4 - takenOf(goblin)), join: 'Join · $15' },
  { name: 'Candlekeep Mysteries', price: '$15', meta: `D&D 5e · ${short(D3)}, 6pm to 10pm · weekly`, chip: 'Character ready', chipKind: 'pregens', left: leftWords(4 - takenOf(candlekeep)), join: 'Join · $15' },
  { name: 'The Titans Heart', price: '$20', meta: `D&D 5e · ${short(D4)}, 6pm to 10pm · one-shot`, chip: 'Made together at the table', chipKind: 'at-table', left: leftWords(6 - takenOf(titans)), join: 'Join · $20' },
];
const takenOf = (g) => Number(lair.sql.exec("SELECT COALESCE(SUM(people), 0) AS n FROM bookings WHERE game_id = ? AND kind = 'gm-seat' AND status IN ('held', 'confirmed', 'seated')", g.id).one().n) || 0;
const sameCards = (got, wanted) => got.length === wanted.length && wanted.every((w, i) => Object.entries(w).every(([k, v]) => got[i][k] === v));

let n = 0;
for (const size of sizes) {
  const tag = `[${size}]`;
  n += 1;
  await refreshFeed();

  /* ---------------- logged out: printed from the feed, then the same from the board ---------------- */
  {
    const { ctx, page } = await open(size, null, '/pages/gm-games', { block: /\/lair-play\.js(\?|$)/ });
    const printed = await door(page);
    check(`${tag} logged out, before any script: the front door shows, above For GMs and organisers`, printed && printed.shown && printed.beforeOrganise, printed);
    check(`${tag} mockup A's words`, printed.eyebrow === want.eyebrow && printed.title === want.title && printed.intro === want.intro && JSON.stringify(printed.steps) === JSON.stringify(STEPS) && printed.week === want.week && printed.gob === want.gob, { gob: printed.gob, eyebrow: printed.eyebrow, title: printed.title, intro: printed.intro, week: printed.week, steps: printed.steps });
    check(`${tag} step 1's "Character ready" in the tag's colour (the step's lead in the text's)`, printed.readyColour === POTION && printed.firstBoldColour !== POTION, [printed.readyColour, printed.firstBoldColour]);
    check(`${tag} printed: this week's 3 beginner games with seats, soonest first (not Abomination Vaults: some experience)`, sameCards(printed.cards, cardsWant()), printed.cards);
    check(`${tag} printed: "See all 4 games this week", to the sessions list`, printed.all === 'See all 4 games this week' && printed.allHref === '#play-sessions-title', [printed.all, printed.allHref]);
    check(`${tag} printed: "A seat is $15 to $20, paid at the counter on the day. Cancel free up to 24 hours before."`, printed.cost === 'A seat is $15 to $20, paid at the counter on the day. Cancel free up to 24 hours before.', printed.cost);
    check(`${tag} printed: each Join is a link to ?join=<session> (it opens the join sheet without any script)`, printed.cards.every((c, i) => c.href === `?join=${[goblin, candlekeep, titans][i].id}`), printed.cards.map((c) => c.href));
    await ctx.close();

    const live = await open(size, null, '/pages/gm-games');
    const page2 = live.page;
    await page2.waitForSelector('[data-play-day]:not([data-drawing])', { timeout: 20000 });
    await settle(page2, 600);
    const drawn = await door(page2);
    check(`${tag} once the board's in: the same cards, words and size (nothing moves)`, sameCards(drawn.cards, cardsWant()) && drawn.all === printed.all && drawn.cost === printed.cost && Math.abs(drawn.height - printed.height) <= 2 && Math.abs(drawn.top - printed.top) <= 2, { drawn: [drawn.height, drawn.top], printed: [printed.height, printed.top], cards: drawn.cards });
    check(`${tag} no sideways scroll`, (await overflowX(page2)) <= 0, await overflowX(page2));
    await axe(page2, `${tag} the front door`, '[data-first-game]');
    await shotOf(page2, `${n}-${size}-1-front-door`, '[data-first-game]');
    await shotTop(page2, `${n}-${size}-1-page-top`);

    // a weekly beginner game, joined by a guest: "Yes, my first" and the box ticked
    await openJoin(page2, candlekeep.id);
    let s = await sheet(page2);
    check(`${tag} Join on a card opens that session's join sheet in place`, s.open && s.title === 'Join Candlekeep Mysteries', s.title);
    check(`${tag} "Is this your first roleplaying game? (optional)", neither chip picked, nothing else yet`, s.asked === 'Is this your first roleplaying game? (optional)' && s.chips.map((c) => `${c.label}:${c.checked}`).join() === "Yes, my first:false,I've played before:false" && !s.more, s);
    await axe(page2, `${tag} the join sheet, asking`, 'gm-board dialog[open]');
    await pick(page2, 'yes');
    await settle(page2, 200);
    s = await sheet(page2);
    check(`${tag} after "Yes, my first": the GM line and the character line (mockup B), and the box, unticked`,
      s.more && s.note === "Your GM will know it's your first game. Your character's ready for you, so just bring yourself." && s.box && !s.box.checked && s.box.label === 'Email me the day after about keeping my seat', s);
    await shot(page2, `${n}-${size}-2-join-yes`, 'gm-board dialog[open]');
    await axe(page2, `${tag} the join sheet, after Yes`, 'gm-board dialog[open]');
    await page2.click('gm-board dialog label:has(input[name="followUp"])');
    const before = mails.length;
    await guestJoin(page2, `Sam ${size}`, `sam.${size}@example.com`);
    s = await sheet(page2);
    const sam = seatOf(`sam.${size}@example.com`);
    check(`${tag} "You're in, Sam!"`, s.title === "You're in, Sam!", s.title);
    check(`${tag} What happens next: the GM's email, the reminder's day, when to come, the counter, what to pay`,
      s.nextTitle === 'What happens next' && JSON.stringify(s.next) === JSON.stringify([GM_LINE, reminderLine(D3), come(D3), COUNTER, 'Pay the $15 at the counter on the day.']), s.next);
    check(`${tag} then the section's access note (not a lift sentence of its own)`, /^Need the lift\? The mall lift is next to Whitcoulls\./.test(s.access), s.access);
    check(`${tag} said once: no "Gobgob has emailed …" or "Arrive 10 minutes early" as well`, !s.told && !/Arrive 10 minutes early/.test(s.arrive), [s.told, s.arrive]);
    check(`${tag} the seat keeps "Yes, my first" and the box, with when (first_game 1, followup_ok 1; never new_player)`, Boolean(sam) && sam.first_game === 1 && sam.followup_ok === 1 && Math.abs(Number(sam.followup_ok_at) - Date.now()) < 120_000 && !sam.new_player, sam && { first_game: sam.first_game, followup_ok: sam.followup_ok, at: sam.followup_ok_at, new_player: sam.new_player });
    const gmMail = mails.slice(before).find((x) => x.to === 'ellie@example.com' && /new player/i.test(`${x.subject} ${x.text}`));
    check(`${tag} the GM's email says "It's Sam's first roleplaying game."`, Boolean(gmMail) && gmMail.text.includes("It's Sam's first roleplaying game."), gmMail && gmMail.text.slice(0, 400));
    check(`${tag} no sideways scroll on the confirmation`, (await overflowX(page2)) <= 0, await overflowX(page2));
    await axe(page2, `${tag} "You're in", with what happens next`, 'gm-board dialog[open]');
    await shot(page2, `${n}-${size}-3-youre-in`, 'gm-board dialog[open]');
    await page2.click('gm-board dialog [data-close]');
    await settle(page2);

    // "I've played before" at a one-shot: the usual confirmation
    await page2.reload({ waitUntil: 'networkidle' });
    await page2.waitForSelector('[data-play-day]:not([data-drawing])', { timeout: 20000 });
    await openJoin(page2, titans.id);
    await pick(page2, 'no');
    await settle(page2, 200);
    s = await sheet(page2);
    check(`${tag} "I've played before": nothing more to say`, !s.more, s);
    await guestJoin(page2, `Jo ${size}`, `jo.${size}@example.com`);
    s = await sheet(page2);
    const jo = seatOf(`jo.${size}@example.com`);
    check(`${tag} … "See you there!", no What happens next, and first_game 0 (no box)`, s.title === 'See you there!' && !s.next.length && jo.first_game === 0 && jo.followup_ok === null, { title: s.title, next: s.next, first: jo.first_game, ok: jo.followup_ok });
    await page2.click('gm-board dialog [data-close]');
    await settle(page2);
    // not answered: nothing kept
    if (size === sizes[0]) {
      await page2.reload({ waitUntil: 'networkidle' });
      await page2.waitForSelector('[data-play-day]:not([data-drawing])', { timeout: 20000 });
      await openJoin(page2, titans.id);
      await guestJoin(page2, 'Lee Quiet', 'lee.quiet@example.com');
      const lee = seatOf('lee.quiet@example.com');
      check(`${tag} not answered: it never stops anyone, and nothing is kept (first_game null)`, lee && lee.first_game === null && (await sheet(page2)).title === 'See you there!', lee && lee.first_game);
    }
    check(`${tag} logged out: no console errors`, !page2.errors.length, page2.errors);
    await live.ctx.close();
  }

  /* ---------------- a new member: sees it, and joins tonight's game with "Yes, my first", the box left unticked ---------------- */
  {
    const { ctx, page } = await open(size, RIA, '/pages/gm-games');
    await page.waitForSelector('[data-play-day]:not([data-drawing])', { timeout: 20000 });
    await settle(page, 600);
    let d = await door(page);
    const kept = await page.evaluate((id) => window.localStorage.getItem(`dg-lair-played:${id}`), RIA.id);
    check(`${tag} a new member (GET /me: not played) sees it, and this browser remembers ('0')`, d.shown && kept === '0', { shown: d.shown, kept });
    // next time, it's there before any script runs
    await page.route(/\/lair-play\.js(\?|$)/, (route) => route.abort());
    await page.reload({ waitUntil: 'networkidle' });
    d = await door(page);
    check(`${tag} … and next time it's there before any script runs`, d.shown, d);
    await page.unroute(/\/lair-play\.js(\?|$)/);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('[data-play-day]:not([data-drawing])', { timeout: 20000 });
    await settle(page, 600);
    const goblinFree = 4 - takenOf(goblin);
    if (goblinFree > 0 && size === sizes[0]) {
      await openJoin(page, goblin.id);
      let s = await sheet(page);
      check(`${tag} the member is asked too (GET /me says they haven't played)`, s.asked.startsWith('Is this your first roleplaying game?'), s.asked);
      await pick(page, 'yes');
      await settle(page, 200);
      s = await sheet(page);
      check(`${tag} a one-shot that asks you to bring a character: "This game asks you to bring your own character.", and the box about their next game`,
        s.note === "Your GM will know it's your first game. This game asks you to bring your own character." && s.box && !s.box.checked && s.box.label === 'Email me the day after about my next game', s);
      await memberJoin(page);
      s = await sheet(page);
      const ria = seatOf(RIA.email);
      check(`${tag} "You're in, Ria!": tonight, so no reminder email; "Today, come up…"`, s.title === "You're in, Ria!" && JSON.stringify(s.next) === JSON.stringify([GM_LINE, come(TODAY), COUNTER, 'Pay the $15 at the counter on the day.']), { title: s.title, next: s.next });
      check(`${tag} the box left unticked: first_game 1, followup_ok 0 (no email the day after)`, ria && ria.first_game === 1 && ria.followup_ok === 0, ria && [ria.first_game, ria.followup_ok]);
      await shot(page, `${n}-${size}-4-youre-in-member`, 'gm-board dialog[open]');
      await page.click('gm-board dialog [data-close]');
    }
    check(`${tag} a new member: no console errors`, !page.errors.length, page.errors);
    await ctx.close();
  }

  /* ---------------- a member who's played: no front door, and the join sheet doesn't ask ---------------- */
  {
    const { ctx, page } = await open(size, KAI, '/pages/gm-games');
    await page.waitForSelector('[data-play-day]:not([data-drawing])', { timeout: 20000 });
    await settle(page, 600);
    const d = await door(page);
    const kept = await page.evaluate((id) => window.localStorage.getItem(`dg-lair-played:${id}`), KAI.id);
    check(`${tag} a member who's played (a seat checked in last week) doesn't see it, and this browser remembers ('1')`, d && d.hidden && kept === '1', { hidden: d && d.hidden, kept });
    await page.route(/\/lair-play\.js(\?|$)/, (route) => route.abort());
    await page.reload({ waitUntil: 'networkidle' });
    check(`${tag} … nor next time, before any script runs`, (await door(page)).hidden);
    await page.unroute(/\/lair-play\.js(\?|$)/);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('[data-play-day]:not([data-drawing])', { timeout: 20000 });
    await settle(page, 600);
    await page.evaluate((id) => document.querySelector('gm-board').joiner.open(id), titans.id);
    await page.waitForSelector('gm-board dialog[open] [data-session-join]', { timeout: 15000 });
    const s = await sheet(page);
    check(`${tag} the join sheet doesn't ask them`, s.open && !s.asked && !s.chips.length, s);
    await page.click('gm-board dialog [data-close]');
    await settle(page);
    await shotTop(page, `${n}-${size}-5-played-member`);
    check(`${tag} a member who's played: no console errors`, !page.errors.length, page.errors);
    await ctx.close();
  }

  /* ---------------- below For GMs and organisers, when the section says so ---------------- */
  {
    m.mockState.sectionSettings = { 'lair-play': { first_place: 'below' } };
    const { ctx, page } = await open(size, null, '/pages/gm-games');
    const order = await page.evaluate(() => {
      const box = document.querySelector('[data-first-game]');
      const organise = document.querySelector('.play__organise');
      const day = document.querySelector('[data-play-day]');
      return { after: Boolean(organise.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING), beforeDay: Boolean(box.compareDocumentPosition(day) & Node.DOCUMENT_POSITION_FOLLOWING), count: document.querySelectorAll('[data-first-game]').length };
    });
    check(`${tag} Where Your first game sits: Below puts it under For GMs and organisers, above the day (once)`, order.after && order.beforeDay && order.count === 1, order);
    await shotTop(page, `${n}-${size}-6-below`);
    m.mockState.sectionSettings = null;
    await ctx.close();
  }
}

/* ---------------- the counter: "First game" on Ria's seat tonight ---------------- */
{
  const riaSeat = seatOf(RIA.email);
  if (riaSeat && riaSeat.first_game === 1) {
    const { ctx, page } = await open('phone', STAFF, '/pages/lair-staff');
    await page.waitForSelector('#checkin-code', { timeout: 20000 });
    await page.fill('#checkin-code', riaMember.code);
    await page.click('.checkin__go');
    await page.waitForSelector('.checkin-card--member', { timeout: 15000 });
    const item = await page.evaluate(() => [...document.querySelectorAll('.checkin-card--member .checkin-item')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
    check('[phone] staff: a member\'s check-in list says "First game" on that seat, and what to do', item.some((x) => /Goblin Kitchen Nightmares/.test(x) && x.includes('First game') && x.includes(HINT)), item);
    await axe(page, '[phone] the member check-in card', '.checkin-card--member');
    await shot(page, '9-phone-counter-member', '.checkin-card--member');
    await page.click('[data-checkin-clear]').catch(() => {});
    await page.fill('#checkin-code', riaSeat.ref);
    await page.click('.checkin__go');
    await page.waitForSelector('.checkin-card .checkin-card__name', { timeout: 15000 });
    const cardText = await text(page, '.checkin-card');
    check('[phone] staff: the seat\'s own check-in card says "First game" and what to do', cardText.includes('First game') && cardText.includes(HINT), cardText.slice(0, 400));
    await shot(page, '9-phone-counter-seat', '.checkin-card');
    check('[phone] staff: no console errors', !page.errors.length, page.errors);
    await ctx.close();
  } else {
    check('the counter: Ria\'s first-game seat is there to check', false, riaSeat);
  }
}

/* ---------------- the email the day after, and "Don't send me emails like this" ---------------- */
{
  const first = sizes[0];
  const sam = seatOf(`sam.${first}@example.com`);
  // Sam came: checked in at the session, and the next morning at 9:05 the email goes
  lair.sql.exec("UPDATE bookings SET status = 'seated', arrived_at = ? WHERE id = ?", at(D3, 18, 5), sam.id);
  const run = await lair.nextDayAt(at(addDays(D3, 1), 9, 5));
  await drain();
  const email = mails.find((x) => x.to === sam.email && /^How was your first game/.test(x.subject));
  check('the email the day after went to Sam (checked in, the box ticked)', run.sent >= 1 && Boolean(email), run);
  const link = email ? (email.text.match(/^Don't send me emails like this: (\S+)$/m) || [])[1] : null;
  const url = link ? new URL(link) : null;
  check('its unsubscribe link is My Lair with the code and key in the #fragment', Boolean(url) && url.pathname === '/pages/my-lair' && /^#unsubscribe=[A-Za-z0-9-]+\.[a-f0-9]{32}$/.test(url.hash), link);
  const key = url ? url.hash.split('.').pop() : 'none';
  const local = url ? `/pages/my-lair${url.hash}` : '/pages/my-lair';
  const stops = () => lair.sql.exec('SELECT * FROM followup_stops').toArray();
  const cardOf = async (page) => ({
    title: await text(page, '.stop-link__title'), line: await text(page, '.stop-link__line'), yes: await text(page, '[data-stop-link-yes]'),
    said: await text(page, '.stop-link__said'), still: await text(page, '.stop-link__still'), error: await text(page, '.stop-link__error'), call: await text(page, '.stop-link__call'),
    actions: await page.$eval('.stop-link__actions', (e) => !e.hidden).catch(() => false),
  });
  for (const size of ['phone', 'desktop'].filter((x) => sizes.includes(x) || sizes.length === 1)) {
    const tag = `[${size}]`;
    lair.sql.exec('DELETE FROM followup_stops');
    requests.length = 0;
    const { ctx, page } = await open(size, null, local);
    await page.waitForSelector('.stop-link__actions:not([hidden])', { timeout: 15000 });
    const seen = await page.evaluate(() => window.__seenAddress);
    check(`${tag} the key is out of the address before the page's own scripts run`, !seen.includes('#unsubscribe') && !page.url().includes(key), [seen, page.url()]);
    check(`${tag} … and never in a request's address or Referer`, !requests.some((r) => r.url.includes(key) || r.referer.includes(key)), requests.filter((r) => r.url.includes(key) || r.referer.includes(key)));
    let c = await cardOf(page);
    check(`${tag} the card asks once: "Stop emails like this one?"`, c.title === 'Stop emails like this one?' && c.line === "It's the email Gobgob sends the day after a first game. Once you stop them, you won't get another." && c.yes === 'Yes, stop these emails' && c.actions, c);
    check(`${tag} opening it stops nothing (email scanners open links)`, stops().length === 0, stops());
    check(`${tag} focus is on the card's question, above My Lair's page`, await page.evaluate(() => document.activeElement?.id) === 'stop-link-title');
    check(`${tag} no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
    await axe(page, `${tag} the unsubscribe card, asking`, 'lair-unsubscribe');
    await shot(page, `8-${size}-unsubscribe-ask`, 'lair-unsubscribe');
    await page.click('[data-stop-link-yes]');
    await page.waitForFunction(() => /Done\./.test(document.querySelector('.stop-link__said')?.textContent || ''), null, { timeout: 15000 });
    c = await cardOf(page);
    const kept = stops();
    check(`${tag} one tap: "Done. No more emails like that one." and that booking emails still come`, c.said === 'Done. No more emails like that one.' && c.still === "Booking confirmations and reminders still come, so you know what's booked." && !c.actions && c.title === 'Emails after a first game', c);
    check(`${tag} … straight away, kept by email (lower case), with the code and how`, kept.length === 1 && kept[0].email === sam.email.toLowerCase() && kept[0].ref === sam.ref && kept[0].via === 'link', kept);
    await axe(page, `${tag} the unsubscribe card, done`, 'lair-unsubscribe');
    await shot(page, `8-${size}-unsubscribe-done`, 'lair-unsubscribe');
    // the same link again (a new page, as from the email)
    await page.goto('about:blank');
    await page.goto(`${BASE}${local}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => /already/.test(document.querySelector('.stop-link__said')?.textContent || ''), null, { timeout: 15000 });
    c = await cardOf(page);
    check(`${tag} the link again: "You've already stopped these. No more emails like that one."`, c.said === "You've already stopped these. No more emails like that one." && !c.actions, c);
    // the link again in the tab that's on My Lair already (only the #fragment changes: no new page), its stop taken off
    // first: the head snippet takes the code and key before any of the page's own listeners (My Lair's router included)
    // gets the change, and the card asks afresh
    lair.sql.exec('DELETE FROM followup_stops');
    await page.evaluate(() => { window.__early = []; window.__late = []; });
    await page.goto(`${BASE}${local}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => /Stop emails/.test(document.querySelector('.stop-link__title')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
    c = await cardOf(page);
    const tab = await page.evaluate(() => ({ early: window.__early || [], late: window.__late || [], now: window.location.href }));
    check(`${tag} the link in a tab that's on My Lair already (only the #fragment changes): taken before any of the page's own listeners gets it (My Lair's router included), and the card asks afresh`,
      tab.early.some((a) => a.includes('#unsubscribe=')) && !tab.late.some((a) => a.includes('unsubscribe') || a.includes(key)) && !tab.now.includes('#unsubscribe') && c.title === 'Stop emails like this one?' && c.actions, { c, tab });
    // a wrong key, opened in the tab that's on My Lair already (only the #fragment changes: no new page)
    await page.evaluate((h) => { window.location.hash = h; }, `#unsubscribe=${encodeURIComponent(sam.ref)}.${'0'.repeat(32)}`);
    await page.waitForSelector('.stop-link__call:not([hidden])', { timeout: 15000 });
    c = await cardOf(page);
    check(`${tag} a wrong key (opened in the same tab): the Lair's "${UNSUBSCRIBE_WORDS.wrong}", and how to reach us`, c.error === UNSUBSCRIBE_WORDS.wrong && c.call === 'Something not right? Call us on 021 159 6894.' && !c.actions, c);
    check(`${tag} … with the key taken out of the address there too`, !page.url().includes('#unsubscribe'), page.url());
    await shot(page, `8-${size}-unsubscribe-wrong`, 'lair-unsubscribe');
    // two links one after the other, the first one's answer slow: the card is the second link's, whenever the first's
    // answer comes (Sam's real link would ask; the wrong one can't)
    let slow = 0;
    await page.route('**/apps/liar/unsubscribe/view', async (route) => {
      if (slow++ === 0) await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.continue();
    });
    await page.evaluate((h) => { window.location.hash = h; }, local.slice(local.indexOf('#')));
    await page.evaluate((h) => { window.location.hash = h; }, `#unsubscribe=${encodeURIComponent(sam.ref)}.${'0'.repeat(32)}`);
    await settle(page, 3000);
    c = await cardOf(page);
    check(`${tag} a link's slow answer never lands on the card of a link opened after it`, slow === 2 && c.error === UNSUBSCRIBE_WORDS.wrong && !c.actions && c.title !== 'Stop emails like this one?', { c, slow });
    await page.unroute('**/apps/liar/unsubscribe/view');
    // a refresh: no link any more, so nothing shows
    await page.reload({ waitUntil: 'networkidle' });
    check(`${tag} a refresh shows nothing: the key's gone from the address`, await page.$eval('lair-unsubscribe', (e) => e.hidden));
    check(`${tag} unsubscribe: no console errors`, !page.errors.filter((e) => !/404/.test(e)).length, page.errors);
    await ctx.close();
  }
}

/* ---------------- the demo (the website lab): the same front door and joining ---------------- */
for (const size of sizes) {
  const tag = `[${size}, demo]`;
  m.mockState.sessionsFeed = null;
  const { ctx, page } = await open(size, null, '/pages/gm-games', { live: false });
  await page.waitForSelector('[data-play-day]:not([data-drawing])', { timeout: 20000 });
  await settle(page, 600);
  const d = await door(page);
  check(`${tag} the front door fills in from the demo board: beginner games with seats, soonest first, 3 at most`, d.shown && d.cards.length >= 1 && d.cards.length <= 3 && d.cards.every((c) => /^Join · /.test(c.join)), d.cards);
  check(`${tag} See all and the cost line`, /^See all \d+ games this week$/.test(d.all) && /^A seat is \$\d+( to \$\d+)?, paid at the counter on the day\. Cancel free up to 24 hours before\.$/.test(d.cost), [d.all, d.cost]);
  await shotOf(page, `7-${size}-demo-front-door`, '[data-first-game]');
  const id = await page.$eval('[data-first-join]', (a) => a.dataset.firstJoin);
  await openJoin(page, id);
  await pick(page, 'yes');
  await settle(page, 200);
  const asked = await sheet(page);
  check(`${tag} after "Yes, my first": the GM line and the unticked box`, asked.more && asked.note.startsWith("Your GM will know it's your first game.") && asked.box && !asked.box.checked, asked);
  await guestJoin(page, 'Aroha Demo', 'aroha.demo@example.com');
  const s = await sheet(page);
  check(`${tag} "You're in, Aroha!" with What happens next`, s.title === "You're in, Aroha!" && s.next[0] === GM_LINE && s.next.includes(COUNTER) && s.next.some((x) => /come up to the Lair, above Whitcoulls/.test(x)), s);
  const kept = await page.evaluate(() => {
    const b = window.Lair.store.backend.state.bookings.find((x) => x.email === 'aroha.demo@example.com');
    const mail = (window.Lair.store.backend.state.outbox || []).find((x) => x.bookingId === b.id && x.kind === 'gm-new-player');
    return { first: b.firstGame, followUp: b.followUp, gm: mail ? mail.lines[0] : null };
  });
  check(`${tag} the demo keeps the answer, and its GM email says it's their first game`, kept.first === true && kept.followUp === false && kept.gm && kept.gm[1] === "It’s Aroha’s first roleplaying game.", kept);
  await shot(page, `7-${size}-demo-youre-in`, 'gm-board dialog[open]');
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await ctx.close();
}

check('nothing outside localhost was asked for', !outside.length, outside.slice(0, 5));
const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed. Screenshots in ${process.env.OUT}`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);

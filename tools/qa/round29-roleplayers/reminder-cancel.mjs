// Round 29, roleplayers phase 1, item 1 (contract v29-roleplayers section 2): a booking reminder's cancel link on the
// theme mock, with the real Lair app in this process (node:sqlite), so every link here comes from a real reminder email
// (POST /internal/reminders at a fixed time). Mo's plan (2 Nov 2026): "One tap cancels while it's still free."
// Checked logged out and logged in, at 390 and 1280: the code and key are out of the address before the page's own
// scripts run; the card asks once ("Give up your seat at …?", until when it's free); opening the link cancels nothing
// (email scanners open links); "Yes" cancels by the Lair's own path (the GM hears); "Keep it" keeps it; a wrong key,
// one that's locked in and one cancelled already say so in the Lair's words, with the phone number; logged in, My Lair
// shows it cancelled straight after; logged out, Log in comes back with an email's ?view= and never the key. No
// sideways scroll, no console errors, nothing outside localhost, axe on the card.
// Usage (from the Lair repo): DG_THEME=/path/to/theme [AXE=/path/to/axe.min.js] [PORT=4994] [OUT=dir] node tools/qa/round29-roleplayers/reminder-cancel.mjs
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round29-reminder-cancel');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, watch, AXE } = lib;
const { Lair } = await import('../../../src/lair.js');
const { LairTime, rulesFromSettings, DEFAULT_HOURS, TAB_WORDS } = await import('../../../src/core.js');
const { CANCEL_LINK_WORDS } = await import('../../../src/booking-reminders.js');
const PORT = Number(process.env.PORT || 4994);
const BASE = `http://localhost:${PORT}`;
const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const today = time.key(Date.now());
const addDays = (key, n) => new Date(Date.UTC(...key.split('-').map((x, i) => (i === 1 ? x - 1 : +x))) + n * 864e5).toISOString().slice(0, 10);
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// the sessions are three days away: their reminder day is tomorrow, and cancelling is free until two days from now
const DAY = addDays(today, 3);
const REMIND = addDays(today, 1);
const weekday = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, weekday: 'long' }).format(new Date(at(key, 12)));
const longDay = (key) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(at(key, 12))).replace(/,/g, '');
const RIA = { id: 7700112233, first_name: 'Ria', last_name: 'Moana', name: 'Ria Moana', email: 'ria@example.com', phone: null, tags: [], store_credit_account: { balance: 0 }, orders_count: 0, orders: [] };
const GM = '7001';
const ADDRESS = '56/691 Manukau Road, Royal Oak, Auckland 1023';

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
const EVENTS = [{ id: 'clocktower', title: 'Blood on the Clocktower', type: 'social', start: at(DAY, 18), end: at(DAY, 21), tables: '', capacity: 40, entryFee: 1000, payment: 'store' }];
lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '', store_phone: '021 159 6894' }, [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }], EVENTS, { address: ADDRESS });
lair.rulesLoadedAt = Date.now() + 365 * 24 * 3600_000;
Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
lair.shopify.graphql = async () => {
  throw new Error('No Shopify in this check');
};
lair.taggedPerson = async (id) => ({ customerId: id || null, staff: false, gm: String(id) === GM, tags: [] });
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
lair.makeMember({ customerId: String(RIA.id), name: RIA.name, email: RIA.email }, Date.now());
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
const game = (await api('POST', 'games', {
  title: 'Candlekeep Mysteries', system: 'D&D 5e', gm: 'Ellie', email: 'ellie@example.com', blurb: 'A library full of secrets.', seats: 4, tables: ['T12'],
  start: at(DAY, 18), end: at(DAY, 22),
}, GM)).game;
const mobile = '021 555 0100';
/** The bookings each size needs: Ria's seat (a member) and a guest's, a guest's table and a member's, and a guest's sign-up */
async function bookings(tag, n) {
  return {
    seatGuest: (await api('POST', 'bookings', { kind: 'gm-seat', gameId: game.id, people: 1, name: `Sam ${tag}`, email: `sam.${tag}@example.com`, phone: mobile })).booking,
    tableMember: (await api('POST', 'bookings', { kind: 'table', tables: [`T${n}`], start: at(DAY, 18), end: at(DAY, 20), people: 2, name: 'Ria Moana', email: `ria.${tag}@example.com`, phone: mobile, pay: 'day' }, String(RIA.id))).booking,
    seatMember: (await api('POST', 'bookings', { kind: 'gm-seat', gameId: game.id, people: 1, name: 'Ria Moana', email: `ria.seat.${tag}@example.com`, phone: mobile }, String(RIA.id))).booking,
    join: (await api('POST', `events/${encodeURIComponent(`clocktower@${DAY}`)}/join`, { name: `Jo ${tag}`, email: `jo.${tag}@example.com`, phone: mobile, people: 2 })).join,
  };
}
const phoneSet = await bookings('phone', 3);
const deskSet = await bookings('desk', 5);
// tomorrow at 9:05am, the reminders go: every link here comes from one of those emails
const run = await lair.remindersAt(at(REMIND, 9, 5));
await drain();
check('the reminders went (tomorrow at 9:05, as the 10-minute run would): 8 of them', run.bookings?.sent === 8, run);
const reminderTo = (email) => mails.find((x) => x.to === email && /^See you /.test(x.subject));
const linkOf = (email) => {
  const text = reminderTo(email)?.text || '';
  const line = text.match(/^Cancel my (?:seat|seats|table|sign-up): (\S+)$/m);
  return line ? new URL(line[1]) : null;
};
const local = (url) => `/pages/my-lair${url.search}`;
const status = (id) => lair.sql.exec('SELECT status FROM bookings WHERE id = ? UNION ALL SELECT status FROM event_joins WHERE id = ?', id, id).one()?.status;
// one that's locked in already (its session starts in 6 hours), with a key of its own (made now: one made before the
// Lair's round 15 start keeps the old rules and never locks)
const lockedId = 'bk_ab12cd34ef56ab12';
const lockedKey = 'c'.repeat(32);
lair.saveBooking({
  id: lockedId, ref: 'LK-LOCKED-7', kind: 'gm-seat', status: 'confirmed', gameId: game.id, tables: ['T12'], start: Date.now() + 6 * 3600_000, end: Date.now() + 9 * 3600_000,
  people: 1, name: 'Lee Locked', email: 'lee@example.com', amount: 1500,
}, Date.now());
lair.sql.exec('UPDATE bookings SET cancel_key = ? WHERE id = ?', lockedKey, lockedId);

/* ---------------- the theme mock, live, with /apps/liar going to the Lair above ---------------- */
m.globalSettings.lair_mode = 'live';
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
const server = await m.serve(PORT);
const browser = await chromium.launch();
const outside = [];
const VIEWPORTS = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
async function open(size, who, where) {
  const phone = size === 'phone';
  const ctx = await browser.newContext({ viewport: VIEWPORTS[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  await ctx.route(/^https?:\/\/(?!localhost)/, (route) => {
    outside.push(route.request().url());
    return route.abort();
  });
  // what the page's own scripts see of the address, once the document is parsed (the head snippet has run by then)
  await ctx.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      window.__seenAddress = window.location.href;
    });
  });
  const page = watch(await ctx.newPage());
  m.mockState.customer = who;
  await page.goto(`${BASE}${where}`, { waitUntil: 'networkidle', timeout: 60000 });
  return { ctx, page };
}
const text = (page, sel) => page.$eval(sel, (e) => (e.hidden ? '' : e.textContent.replace(/\s+/g, ' ').trim())).catch(() => '');
const card = async (page) => ({
  title: await text(page, '.cancel-link__title'), line: await text(page, '.cancel-link__line'), said: await text(page, '.cancel-link__said'),
  error: await text(page, '.cancel-link__error'), call: await text(page, '.cancel-link__call'), yes: await text(page, '[data-cancel-link-yes]'),
  keep: await text(page, '[data-cancel-link-keep]'), actions: await page.$eval('.cancel-link__actions', (e) => !e.hidden).catch(() => false),
});
const settle = (page, ms = 400) => page.waitForTimeout(ms);
const when = `${longDay(DAY)}, 6pm`;
const free = `It's free to cancel until 6pm ${weekday(addDays(DAY, -1))}.`;

for (const size of ['phone', 'desktop']) {
  const set = size === 'phone' ? phoneSet : deskSet;
  const tag = `[${size}]`;

  /* logged out: a guest's seat, asked once, cancelled with one tap */
  {
    const link = linkOf(`sam.${size === 'phone' ? 'phone' : 'desk'}@example.com`);
    const { ctx, page } = await open(size, null, local(link));
    await page.waitForSelector('.cancel-link__actions:not([hidden])', { timeout: 15000 });
    check(`${tag} logged out: the code and key are out of the address before the page's own scripts run`, !/[?&](cancel|key)=/.test(await page.evaluate(() => window.__seenAddress)) && !/[?&](cancel|key)=/.test(page.url()), [await page.evaluate(() => window.__seenAddress), page.url()]);
    const c = await card(page);
    check(`${tag} the card: "Give up your seat at Candlekeep Mysteries, ${when}?" and until when it's free`, c.title === `Give up your seat at Candlekeep Mysteries, ${when}?` && c.line === free && c.yes === 'Yes, give up my seat' && c.keep === 'Keep it', c);
    check(`${tag} opening the link cancels nothing (email scanners open links)`, status(set.seatGuest.id) === 'confirmed');
    check(`${tag} focus is on the card's question`, await page.evaluate(() => document.activeElement?.id) === 'cancel-link-title');
    check(`${tag} no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
    await axe(page, `${tag} the card, asking (logged out)`, 'lair-cancel-link');
    await shot(page, `${size}-1-ask-logged-out`, 'lair-cancel-link');
    await shot(page, `${size}-1-ask-logged-out-page`, null, false);
    const before = mails.length;
    await page.click('[data-cancel-link-yes]');
    await page.waitForFunction(() => /Done\./.test(document.querySelector('.cancel-link__said')?.textContent || ''), null, { timeout: 15000 });
    const done = await card(page);
    check(`${tag} one tap: "Done. Your seat's gone back on the board for someone else."`, done.said === "Done. Your seat's gone back on the board for someone else." && !done.actions && done.title === `Your seat at Candlekeep Mysteries, ${when}`, done);
    check(`${tag} it's cancelled in the Lair, by its own path: the GM hears`, status(set.seatGuest.id) === 'cancelled' && mails.slice(before).some((x) => x.to === 'ellie@example.com' && /^Seat dropped/.test(x.subject)), mails.slice(before).map((x) => [x.to, x.subject]));
    check(`${tag} the status line is a live region, and focus is back on the card`, await page.$eval('.cancel-link__said', (e) => e.getAttribute('role')) === 'status' && await page.evaluate(() => document.activeElement?.id) === 'cancel-link-title');
    await axe(page, `${tag} the card, done (logged out)`, 'lair-cancel-link');
    await shot(page, `${size}-2-done-logged-out`, 'lair-cancel-link');
    check(`${tag} no console errors`, !page.errors.length, page.errors);
    // the same link again (another tab, say): cancelled already, in the Lair's words, with the phone number
    await page.goto(`${BASE}${local(link)}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.cancel-link__call:not([hidden])', { timeout: 15000 });
    const again = await card(page);
    check(`${tag} the link again: "${CANCEL_LINK_WORDS.cancelled}", and how to reach us`, again.error === CANCEL_LINK_WORDS.cancelled && again.call === 'Something come up? Call us on 021 159 6894.' && !again.actions, again);
    check(`${tag} the phone number is a tap to call`, await page.$eval('.cancel-link__call a', (a) => a.getAttribute('href')) === 'tel:0211596894');
    // it reads as one sentence: only the number is the link, flowing with the words (a flex link split it into pieces
    // with gaps), and on a desktop it's one line
    const flow = await page.$eval('.cancel-link__call', (p) => {
      const a = p.querySelector('a');
      const line = parseFloat(getComputedStyle(p).lineHeight) || 24;
      return { link: a.textContent, display: getComputedStyle(a).display, lines: Math.round(p.getBoundingClientRect().height / line) };
    });
    check(`${tag} the call line reads as one sentence, with the number as its link`, flow.link === '021 159 6894' && flow.display === 'inline' && (size === 'phone' || flow.lines === 1), flow);
    // a refresh: the address has no key any more, so nothing shows
    await page.reload({ waitUntil: 'networkidle' });
    check(`${tag} a refresh shows nothing: the key's gone from the address`, await page.$eval('lair-cancel-link', (e) => e.hidden));
    await ctx.close();
  }

  /* logged out: a guest's sign-up for 2 */
  {
    const { ctx, page } = await open(size, null, local(linkOf(`jo.${size === 'phone' ? 'phone' : 'desk'}@example.com`)));
    await page.waitForSelector('.cancel-link__actions:not([hidden])', { timeout: 15000 });
    const c = await card(page);
    check(`${tag} a sign-up for 2: "Cancel your 2 places at Blood on the Clocktower, …?"`, c.title === `Cancel your 2 places at Blood on the Clocktower, ${when}?` && c.yes === 'Yes, cancel my sign-up', c);
    await page.click('[data-cancel-link-yes]');
    await page.waitForFunction(() => /Done\./.test(document.querySelector('.cancel-link__said')?.textContent || ''), null, { timeout: 15000 });
    check(`${tag} "Done. Your places are free for someone else now." and the places are free`, (await card(page)).said === 'Done. Your places are free for someone else now.' && status(set.join.id) === 'cancelled');
    await ctx.close();
  }

  /* logged in: Ria keeps her table, then gives up her seat; My Lair shows it straight after */
  {
    const { ctx, page } = await open(size, RIA, local(linkOf(`ria.${size === 'phone' ? 'phone' : 'desk'}@example.com`)));
    await page.waitForSelector('.cancel-link__actions:not([hidden])', { timeout: 15000 });
    check(`${tag} logged in: the card above My Lair`, await page.evaluate(() => {
      const card = document.querySelector('lair-cancel-link');
      const mine = document.querySelector('my-lair');
      return Boolean(card && mine && card.compareDocumentPosition(mine) & Node.DOCUMENT_POSITION_FOLLOWING);
    }));
    const c = await card(page);
    check(`${tag} a table: "Cancel your table for 2, …?" and "Yes, cancel my table"`, c.title === `Cancel your table for 2, ${when}?` && c.yes === 'Yes, cancel my table', c);
    await axe(page, `${tag} the card, asking (logged in)`, 'lair-cancel-link');
    await shot(page, `${size}-3-ask-logged-in`, null, false);
    await page.click('[data-cancel-link-keep]');
    await settle(page);
    const kept = await card(page);
    check(`${tag} Keep it: "Gobgob's guarding your table. See you there!", and it's still booked`, kept.said === "Gobgob's guarding your table. See you there!" && !kept.actions && status(set.tableMember.id) === 'confirmed', kept);
    await page.goto(`${BASE}${local(linkOf(`ria.seat.${size === 'phone' ? 'phone' : 'desk'}@example.com`))}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.cancel-link__actions:not([hidden])', { timeout: 15000 });
    await page.click('[data-cancel-link-yes]');
    await page.waitForFunction(() => /Done\./.test(document.querySelector('.cancel-link__said')?.textContent || ''), null, { timeout: 15000 });
    check(`${tag} logged in, the seat's cancelled the same way`, status(set.seatMember.id) === 'cancelled');
    // (Ria's seats: one at each size, so the phone's is cancelled already when the desktop's goes)
    const gone = size === 'phone' ? 1 : 2;
    await page.waitForFunction((n) => new RegExp(`Earlier and cancelled \\(${n}\\)`).test(document.querySelector('[data-panel="seats"]')?.textContent || ''), gone, { timeout: 15000 }).catch(() => {});
    check(`${tag} My Lair loads again and shows the seat cancelled`, new RegExp(`Earlier and cancelled \\(${gone}\\)`).test(await text(page, '[data-panel="seats"]')), await text(page, '[data-panel="seats"]'));
    check(`${tag} no sideways scroll, no console errors`, (await overflowX(page)) <= 0 && !page.errors.length, page.errors);
    await shot(page, `${size}-4-done-logged-in`, 'lair-cancel-link');
    await ctx.close();
  }

  /* a wrong key, and one that's locked in */
  {
    const real = linkOf(`ria.${size === 'phone' ? 'phone' : 'desk'}@example.com`);
    const wrong = new URL(real);
    wrong.searchParams.set('key', 'f'.repeat(32));
    const { ctx, page } = await open(size, null, local(wrong));
    await page.waitForSelector('.cancel-link__call:not([hidden])', { timeout: 15000 });
    const c = await card(page);
    check(`${tag} a wrong key: one plain message, and the phone number`, c.title === 'Cancel a booking' && c.error === CANCEL_LINK_WORDS.wrong && c.call === 'Something come up? Call us on 021 159 6894.' && !c.actions, c);
    await axe(page, `${tag} the card, a wrong link`, 'lair-cancel-link');
    await shot(page, `${size}-5-wrong`, 'lair-cancel-link');
    await page.goto(`${BASE}/pages/my-lair?cancel=LK-LOCKED-7&key=${lockedKey}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.cancel-link__call:not([hidden])', { timeout: 15000 });
    const locked = await card(page);
    check(`${tag} locked in: what it is, and the tab's words`, /^Your seat at Candlekeep Mysteries, /.test(locked.title) && locked.error === TAB_WORDS.locked(24) && !locked.actions && status(lockedId) === 'confirmed', locked);
    await shot(page, `${size}-6-locked`, 'lair-cancel-link');
    await ctx.close();
  }
}

/* logged out with an email's ?view=: Log in comes back to it, never with the cancel link's code or key */
{
  const { ctx, page } = await open('phone', null, `/pages/my-lair?view=ml-st-RM-OWLBEAR-17&cancel=NO-SUCH-1&key=${'d'.repeat(32)}`);
  const href = await page.$eval('a[data-ml-login]', (a) => a.getAttribute('href'));
  const back = new URL(href, BASE).searchParams.get('return_to');
  check('[phone] Log in comes back to the ticket the email linked to (?view=), and the address keeps it', back === '/pages/my-lair?view=ml-st-RM-OWLBEAR-17' && /view=ml-st-RM-OWLBEAR-17/.test(page.url()), { href, url: page.url() });
  check('[phone] … and never carries the cancel link\'s code or key', !/cancel|key|dddd/.test(decodeURIComponent(href)), href);
  await ctx.close();
  const plain = await open('phone', null, '/pages/my-lair');
  check('[phone] with no ?view=, Log in comes back to My Lair', new URL(await plain.page.$eval('a[data-ml-login]', (a) => a.getAttribute('href')), BASE).searchParams.get('return_to') === '/pages/my-lair');
  check('[phone] with no link, the card stays hidden', await plain.page.$eval('lair-cancel-link', (e) => e.hidden));
  await plain.ctx.close();
}

/* demo mode (the website lab): a made-up seat, and nothing reaches the Lair */
{
  m.globalSettings.lair_mode = 'demo';
  const before = lair.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE status = 'cancelled'").one().n;
  const { ctx, page } = await open('phone', null, `/pages/my-lair?cancel=DEMO-1&key=${'e'.repeat(32)}`);
  await page.waitForSelector('.cancel-link__actions:not([hidden])', { timeout: 15000 });
  check('[demo] a made-up seat, saying it\'s a demo', /^Give up your seat at Candlekeep Mysteries, /.test(await text(page, '.cancel-link__title')) && (await text(page, '.cancel-link__demo')) === 'Demo: nothing is cancelled.');
  await page.click('[data-cancel-link-yes]');
  await page.waitForFunction(() => /Done\./.test(document.querySelector('.cancel-link__said')?.textContent || ''), null, { timeout: 15000 });
  check('[demo] "Done", and nothing in the Lair changed', lair.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE status = 'cancelled'").one().n === before);
  await ctx.close();
  m.globalSettings.lair_mode = 'live';
}

check('nothing outside localhost was asked for', !outside.length, outside.slice(0, 5));
if (!AXE) console.log('(axe skipped: set AXE to a copy of axe.min.js)');
console.log(JSON.stringify(totals()), `screenshots in ${process.env.OUT}`);
await browser.close();
server.close();
process.exit(totals().fail ? 1 : 0);

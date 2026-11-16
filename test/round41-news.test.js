// Round 41, news emails (16 Nov 2026). Mo asked for Dice Goblin's own marketing emails, with new items in them, saw test
// copies of "This week at the Lair" and the Black Friday email that night and said: "I'm happy lets build it but don't
// send anything yet". So: nothing goes until NEWS_EMAILS switches an email on; then only to people Shopify has
// subscribed to email marketing, less the Lair's stop list; the weekly email on Mondays from 10am with what's on this
// week and what's new in stock; Black Friday once, from 17 to 30 November; each with the shop's details and an
// Unsubscribe that works without logging in (and the mail app's one-click), which stops every marketing email.
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { NEWS_WORDS, newsSwitches, tagged } from '../src/news.js';
import { renderEmail } from '../src/email.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const DAY = 24 * 3_600_000;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// The week of Monday 23 November 2026 (NZDT): the first Monday Mo said he'd decide on
const SUN0 = '2026-11-22';
const MON = '2026-11-23';
const TUE = '2026-11-24';
const WED = '2026-11-25';
const THU = '2026-11-26';
const SAT = '2026-11-28';
const NOW = at(SUN0, 13);
const realNow = Date.now;
const realFetch = globalThis.fetch;
const nowIs = (ms) => {
  Date.now = () => ms;
};
const ADDRESS = '56/691 Manukau Road, Royal Oak, Auckland 1023';

function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      cloudflareSql(query, bindings);
      const stmt = db.prepare(query);
      if (/^\s*(select|with)/i.test(query)) {
        const rows = stmt.all(...bindings);
        return { toArray: () => rows, one: () => rows[0] };
      }
      stmt.run(...bindings);
      return { toArray: () => [], one: () => undefined };
    },
  };
  const kv = new Map();
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: () => {} };
}

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];
const SETTINGS = { lair_hours: DEFAULT_HOURS, lair_shop_tables: '', store_phone: '021 159 6894', page_events: 'our-games' };
// Warhammer Night every Thursday 6pm to midnight ($10), and Oddity Alley over Saturday and Sunday 28–29 Nov (free)
const EVENTS = [
  { id: 'warhammer-night', title: 'Warhammer Night', start: at('2026-10-15', 18), end: at('2026-10-16', 0), repeat: 'weekly', days: 1, entryFee: 1000, tables: '' },
  { id: 'oddity-alley-november', title: 'Oddity Alley', start: at(SAT, 11), end: at(SAT, 15), repeat: '', days: 2, entryFee: 0, freeEntry: true, tables: '' },
];
const rulesWith = (events = EVENTS) => rulesFromSettings(SETTINGS, ROOMS, events, { address: ADDRESS });
const OWNER = '9001';
const GM = '7001';

let lair;
let mail;
let shopify;
async function call(method, path, body, customer = '', extraHeaders = {}) {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  }));
  const type = response.headers.get('Content-Type') || '';
  return { status: response.status, data: type.includes('json') ? await response.json() : await response.text(), headers: response.headers };
}
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error || JSON.stringify(res.data));
  return res.data;
};
const internal = (path, body) => call('POST', `internal/${path}`, body, '', { 'X-Lair-Internal': '1' });

function captureEmails() {
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test', PUBLIC_URL: 'https://lair.example.com' };
  // the 10-minute run is called directly here, so the env it reads is set as a request would set it
  lair.env = lair.baseEnv;
  const sent = [];
  const reached = [];
  let failWith = 0;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.resend.com/')) {
      reached.push(String(url));
      throw new Error(`No network in tests: ${url}`);
    }
    if (failWith) return new Response(JSON.stringify({ message: 'nope' }), { status: failWith });
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return { sent, reached, fail: (status) => { failWith = status; } };
}
const switchOn = (value, more = {}) => {
  lair.baseEnv = { ...lair.baseEnv, NEWS_EMAILS: value, ...more };
  lair.env = lair.baseEnv;
};
const run = (ms) => {
  nowIs(ms);
  return lair.newsUpkeep(lair.rulesCache, ms);
};
const news = (to = null) => mail.sent.filter((m) => m.headers?.['List-Unsubscribe'] && (!to || m.to === to));
const linkIn = (m, label) => (m.text.match(new RegExp(`^${label}: (\\S+)$`, 'm')) || [])[1] || null;
const stopOf = (m) => {
  const url = new URL(linkIn(m, NEWS_WORDS.unsubscribe));
  const value = decodeURIComponent(url.hash.replace(/^#unsubscribe=/, ''));
  const dot = value.lastIndexOf('.');
  return { ref: value.slice(0, dot), key: value.slice(dot + 1), url };
};

const PEOPLE = [
  { email: 'mia@example.com', customerId: '6001', firstName: 'Mia' },
  { email: 'kai@example.com', customerId: '6002', firstName: 'Kai' },
  { email: 'ria@example.com', customerId: '6003', firstName: 'Ria' },
];
const DICE = [
  { title: 'Marmalade Cat\'s Eye Dice Set', url: 'https://www.dicegoblin.nz/products/marmalade', image: 'https://cdn.shopify.com/m.jpg', price: 11000 },
  { title: 'Hoarfrost Snowflake Obsidian Dice Set', url: 'https://www.dicegoblin.nz/products/hoarfrost', image: 'https://cdn.shopify.com/h.jpg', price: 12000 },
  { title: 'Wild Magic Rainbow Glass Dice Set', url: 'https://www.dicegoblin.nz/products/wild-magic', image: 'https://cdn.shopify.com/w.jpg', price: 18000 },
  { title: 'Basilisk Gemstone Dice Set', url: 'https://www.dicegoblin.nz/products/basilisk', image: 'https://cdn.shopify.com/b.jpg', price: 12000 },
];

/** A one-shot TTRPG session Ellie lists for Wednesday: Lost Mine (D&D 5e), 6pm to 10pm, 4 seats */
async function session(more = {}) {
  nowIs(NOW);
  return ok(await call('POST', 'games', {
    title: 'Lost Mine', system: 'D&D 5e', gm: 'Ellie Rua', email: 'ellie@example.com', blurb: 'A mine full of trouble.', seats: 4,
    tables: ['T12'], start: at(WED, 18), end: at(WED, 22), schedule: 'one-shot', characters: 'pregens', ...more,
  }, GM)).game;
}

beforeEach(() => {
  nowIs(NOW);
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'example-shop.myshopify.com' });
  mail = captureEmails();
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: id === GM, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.shopify.customerEmail = async () => null;
  lair.shopify.customersSince = async () => new Map();
  lair.accountEmail = async () => ({ fetched: false, email: '' });
  lair.checkGiftCodes = async () => 0;
  lair.rulesCache = rulesWith();
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  lair.makeMember({ customerId: GM, name: 'Ellie Rua', email: 'ellie@example.com' }, NOW);
  shopify = { subscribers: 0, products: [] };
  lair.shopify.marketingSubscribers = async () => {
    shopify.subscribers += 1;
    return PEOPLE.map((p) => ({ ...p }));
  };
  lair.shopify.eventImages = async () => new Map([['warhammer-night', 'https://cdn.shopify.com/s/files/1/dg-event-warhammer.jpg?v=1']]);
  lair.shopify.newInStock = async (options) => {
    shopify.products.push(options);
    return { count: 115, items: DICE.map((d) => ({ ...d })) };
  };
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(mail.reached, [], 'nothing but Resend was reached');
});

/* ---------------- the switch ---------------- */

test('round 41, news: NEWS_EMAILS reads as a list of what is on; empty or off is nothing', () => {
  assert.deepEqual([...newsSwitches({})], []);
  assert.deepEqual([...newsSwitches({ NEWS_EMAILS: 'off' })], []);
  assert.deepEqual([...newsSwitches({ NEWS_EMAILS: ' Weekly, black-friday-2026 ' })], ['weekly', 'black-friday-2026']);
});

test('round 41, news: nothing is sent while NEWS_EMAILS is unset or off, not even on a Monday at 10am; the week\'s draft is made for the staff page', async () => {
  await session();
  assert.deepEqual(await run(at(MON, 10, 5)), { drafted: [{ id: `weekly-${MON}` }] });
  switchOn('off');
  assert.equal(await run(at(MON, 11)), null);
  assert.equal(news().length, 0);
  assert.equal(shopify.subscribers, 0, 'Shopify was not asked who to send it to');
  assert.equal(lair.newsRow(`weekly-${MON}`).status, 'draft');
});

/* ---------------- the weekly email ---------------- */

test('round 41, news: the weekly email goes on Monday from 10am, once, to everyone subscribed in Shopify less the stop list, with this week and the new stock', async () => {
  await session();
  // an invite-only game and a session that's already full are left out
  await session({ title: 'Secret Table', private: true, tables: ['T13'] });
  await session({ title: 'Packed House', seats: 2, tables: ['T14'], start: at(THU, 18), end: at(THU, 22) });
  const packed = lair.sql.exec("SELECT id FROM games WHERE title = 'Packed House'").one().id;
  ok(await call('POST', 'bookings', { kind: 'gm-seat', gameId: packed, people: 2, name: 'Leo Park', email: 'leo@example.com', phone: '021 555 0100' }, ''));
  switchOn('weekly');
  // Kai used an unsubscribe in an earlier email
  lair.write("INSERT INTO followup_stops (email, at, ref, via) VALUES ('kai@example.com', ?, 'X', 'link')", NOW);
  assert.equal(await run(at(MON, 6, 55)), null, 'no draft before 7am');
  assert.deepEqual(await run(at(MON, 9, 55)), { drafted: [{ id: `weekly-${MON}` }] }, 'the draft at 7am, not sent before 10am');
  assert.equal(news().length, 0);
  const first = await run(at(MON, 10, 5));
  assert.deepEqual(first.made, [{ id: `weekly-${MON}`, recipients: 2 }]);
  assert.deepEqual(first.sent, { sent: 2, stopped: 0, failed: 0 });
  assert.deepEqual(news().map((m) => m.to).sort(), ['mia@example.com', 'ria@example.com']);
  assert.equal(shopify.products.length, 1);
  assert.equal(shopify.products[0].since, at(MON, 9, 55) - 7 * DAY, 'new in the 7 days before the draft was made');
  // once: the next runs that day make nothing and send nothing
  await run(at(MON, 10, 15));
  await run(at(MON, 15));
  assert.equal(news().length, 2);
  assert.equal(shopify.subscribers, 1);

  const m = news('mia@example.com')[0];
  assert.equal(m.subject, 'This week at the Lair: Oddity Alley', 'the first event that is not on every week');
  assert.equal(m.from, 'Dice Goblin <bookings@dicegoblin.test>');
  // what's on: Wednesday's session with its seats, Thursday's Warhammer, and Oddity Alley once over two days
  assert.match(m.text, /Wed 25 Nov {2}Lost Mine \(D&D 5e\)\n {4}TTRPG with GM Ellie · 6pm to 10pm · \$15 a seat · 4 seats left/);
  assert.match(m.text, /Thu 26 Nov {2}Warhammer Night\n {4}6pm to midnight · \$10 a person/);
  assert.match(m.text, /Sat–Sun 28–29 Nov {2}Oddity Alley\n {4}11am to 3pm each day · Free entry/);
  assert.doesNotMatch(m.text, /Secret Table|Packed House/);
  assert.ok(m.text.indexOf('Lost Mine') < m.text.indexOf('Warhammer Night') && m.text.indexOf('Warhammer Night') < m.text.indexOf('Oddity Alley'), 'soonest first');
  assert.match(m.text, /See what’s on: https:\/\/www\.dicegoblin\.nz\/pages\/our-games\?utm_medium=email&utm_source=weekly-email&utm_campaign=events/);
  // new in the hoard: four products with their pictures and prices, and how many in all
  assert.match(m.text, /NEW IN THE HOARD\n\n115 new things landed on the shelves this week/);
  assert.match(m.text, /Marmalade Cat's Eye Dice Set, \$110\nhttps:\/\/www\.dicegoblin\.nz\/products\/marmalade\?utm_medium=email&utm_source=weekly-email&utm_campaign=shop/);
  assert.match(m.html, /<img src="https:\/\/cdn\.shopify\.com\/m\.jpg" width="250"/);
  // the shop's details, why they're getting it, and an unsubscribe of their own (link and one-click)
  assert.match(m.text, new RegExp(ADDRESS));
  assert.match(m.text, /You're getting this because you said yes to news from Dice Goblin\.\nUnsubscribe: /);
  const stop = stopOf(m);
  assert.match(stop.ref, /^NEWS-[0-9a-f]{16}$/);
  assert.match(stop.key, /^[0-9a-f]{32}$/);
  assert.equal(stop.url.origin + stop.url.pathname, 'https://www.dicegoblin.nz/pages/my-lair');
  assert.equal(m.headers['List-Unsubscribe'], `<https://lair.example.com/unsubscribe/${stop.ref}/${stop.key}>`);
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.notEqual(stopOf(news('ria@example.com')[0]).ref, stop.ref, 'each address its own');
});

test('round 41, news: with nothing on and nothing new there is no email that week, and Shopify is not asked who to send it to', async () => {
  switchOn('weekly');
  lair.rulesCache = rulesWith([]);
  lair.shopify.newInStock = async () => ({ count: 0, items: [] });
  const result = await run(at(MON, 10, 5));
  assert.deepEqual(result, { drafted: [{ id: `weekly-${MON}`, skipped: 'nothing to say' }] });
  assert.equal(news().length, 0);
  assert.equal(shopify.subscribers, 0, 'nobody to ask about');
  await run(at(MON, 11));
  assert.equal(news().length, 0, 'and not tried again that Monday');
});

test('round 41, news: a quiet week with new stock still goes, with Book a table', async () => {
  switchOn('weekly');
  lair.rulesCache = rulesWith([]);
  await run(at(MON, 10, 5));
  const m = news('mia@example.com')[0];
  assert.equal(m.subject, 'This week at the Lair');
  assert.match(m.text, /A quiet week on the calendar/);
  assert.match(m.text, /Book a table: https:\/\/www\.dicegoblin\.nz\/pages\/book-a-table\?utm_medium=email&utm_source=weekly-email&utm_campaign=tables/);
});

test('round 41, news: Resend down puts the batch back on the queue for the next run; a refusal marks it failed', async () => {
  switchOn('weekly');
  mail.fail(503);
  const down = await run(at(MON, 10, 5));
  assert.equal(down.sent.retry, 3);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM news_sends WHERE status = 'queued'").one().n, 3);
  mail.fail(0);
  const again = await run(at(MON, 10, 15));
  assert.deepEqual(again.sent, { sent: 3, stopped: 0, failed: 0 });
  assert.equal(news().length, 3);
  // a new week, refused outright: nothing is marked failed in a batch, it's halved and tried again (the review's tests below)
  mail.fail(422);
  const refused = await run(at('2026-11-30', 10, 5));
  assert.deepEqual(refused.sent, { sent: 0, failed: 0, retry: 3, stopped: 0 });
  mail.fail(0);
  assert.equal((await run(at('2026-11-30', 10, 15))).sent.sent, 2, 'half a batch at a time now');
  assert.equal((await run(at('2026-11-30', 10, 25))).sent.sent, 1);
  assert.equal(news().length, 6);
});

test('round 41, news: from 9am to 8pm only; a batch queued before 8pm waits for the morning', async () => {
  switchOn('weekly');
  // made at 7:55pm, then Resend is busy until after 8pm
  mail.fail(429);
  await run(at(MON, 19, 55));
  mail.fail(0);
  assert.equal(await run(at(MON, 20, 5)), null);
  assert.equal(news().length, 0);
  const morning = await run(at(TUE, 9, 5));
  assert.equal(morning.sent.sent, 3);
});

/* ---------------- unsubscribing ---------------- */

test('round 41, news: the Unsubscribe works without logging in (view, then the tap), stops every news email, and a later email skips them', async () => {
  switchOn('weekly');
  await run(at(MON, 10, 5));
  const stop = stopOf(news('mia@example.com')[0]);
  const viewed = ok(await call('POST', 'unsubscribe/view', { ref: stop.ref, key: stop.key }, '', { 'X-Lair-Client': '203.0.113.9' }));
  assert.deepEqual(viewed, { link: { stopped: false } });
  // a wrong key says nothing about anyone
  const wrong = await call('POST', 'unsubscribe/view', { ref: stop.ref, key: '0'.repeat(32) }, '', { 'X-Lair-Client': '203.0.113.9' });
  assert.equal(wrong.status, 404);
  const done = ok(await call('POST', 'unsubscribe/stop', { ref: stop.ref, key: stop.key }, '', { 'X-Lair-Client': '203.0.113.9' }));
  assert.deepEqual(done, { ok: true, already: false });
  assert.equal(lair.followupStopped('mia@example.com'), true);
  // Black Friday, switched on now: Mia isn't sent it
  switchOn('weekly, black-friday-2026');
  const bf = await run(at(TUE, 10));
  assert.deepEqual(bf.made, [{ id: 'black-friday-2026', recipients: 2 }]);
  assert.deepEqual(news().filter((m) => m.subject === NEWS_WORDS.blackFriday.subject).map((m) => m.to).sort(), ['kai@example.com', 'ria@example.com']);
});

test('round 41, news: the mail app\'s one-click POST stops them; a GET only goes on to the page that asks', async () => {
  switchOn('weekly');
  await run(at(MON, 10, 5));
  const stop = stopOf(news('ria@example.com')[0]);
  const looked = await lair.fetch(new Request('https://lair.test/internal/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body: JSON.stringify({ ref: stop.ref, key: stop.key, stop: false }) }));
  assert.equal(looked.status, 303);
  assert.equal(lair.followupStopped('ria@example.com'), false);
  const clicked = await lair.fetch(new Request('https://lair.test/internal/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Internal': '1' }, body: JSON.stringify({ ref: stop.ref, key: stop.key, stop: true, client: '198.51.100.7' }) }));
  assert.equal(clicked.status, 200);
  assert.equal(lair.followupStopped('ria@example.com'), true);
});

test('round 41, news: someone who unsubscribes after an email is made, before their batch goes, is not sent it', async () => {
  switchOn('weekly');
  mail.fail(503);
  await run(at(MON, 10, 5));
  mail.fail(0);
  lair.write("INSERT INTO followup_stops (email, at, ref, via) VALUES ('mia@example.com', ?, 'X', 'link')", at(MON, 10, 6));
  const next = await run(at(MON, 10, 15));
  assert.deepEqual(next.sent, { sent: 2, stopped: 1, failed: 0 });
  assert.deepEqual(news().map((m) => m.to).sort(), ['kai@example.com', 'ria@example.com']);
});

/* ---------------- Black Friday ---------------- */

test('round 41, news: Black Friday goes once, the first run after it is switched on between 17 and 30 November, with four Dice Goblin dice', async () => {
  switchOn('black-friday-2026');
  assert.equal((await run(at('2026-11-16', 11))).made, undefined, 'not before the 17th');
  assert.equal(lair.newsRow('black-friday-2026'), null);
  const made = await run(at('2026-11-23', 9, 5));
  assert.deepEqual(made.made, [{ id: 'black-friday-2026', recipients: 3 }]);
  assert.deepEqual(shopify.products.filter((o) => o.vendor), [{ vendor: 'Dice Goblin NZ', limit: 4 }]);
  await run(at('2026-11-24', 10));
  const sent = news();
  assert.equal(sent.length, 3);
  const m = sent[0];
  assert.equal(m.subject, 'Black Friday: buy one dice set, get one free');
  assert.match(m.text, /^BUY ONE DICE SET, GET ONE FREE\n\nGobgob counted twice/);
  assert.match(m.text, /Basilisk Gemstone Dice Set, \$120\nhttps:\/\/www\.dicegoblin\.nz\/products\/basilisk\?utm_medium=email&utm_source=black-friday&utm_campaign=shop/);
  assert.match(m.text, /Pick your dice: https:\/\/www\.dicegoblin\.nz\/collections\/all-dice\?utm_medium=email&utm_source=black-friday&utm_campaign=shop/);
  assert.match(m.text, /DOUBLE ROLLS ONLINE\n\nOrder online over the weekend/);
  assert.match(m.text, /The fine print: buy one, get one free runs from 12am Friday 27 November/);
  assert.match(m.text, /Gobgob, the Dice Goblin\n\n--/);
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  // the weekly isn't on, so Monday brings nothing else
  assert.equal(sent.filter((x) => /This week/.test(x.subject)).length, 0);
});

test('round 41, news: Black Friday switched on after 30 November never goes', async () => {
  switchOn('black-friday-2026');
  assert.equal(await run(at('2026-12-01', 10)), null);
  assert.equal(news().length, 0);
});

test('round 41, news: NEWS_FROM sends them from its own address, with the usual reply-to', async () => {
  switchOn('weekly', { NEWS_FROM: 'Gobgob at Dice Goblin <news@news.dicegoblin.test>', REPLY_TO: 'dicegoblinnz@example.com' });
  await run(at(MON, 10, 5));
  const m = news('mia@example.com')[0];
  assert.equal(m.from, 'Gobgob at Dice Goblin <news@news.dicegoblin.test>');
  assert.equal(m.reply_to, 'dicegoblinnz@example.com');
});

/* ---------------- a test copy ---------------- */

test('round 41, news: a test copy goes to one address only, [Test] on the subject, even with NEWS_EMAILS off, and nothing is queued', async () => {
  await session();
  const result = ok(await internal('news-test', { campaign: 'weekly', to: 'owner@example.com', at: at(MON, 10, 5) }));
  assert.deepEqual(result, { ok: true, subject: '[Test] This week at the Lair: Oddity Alley' });
  const copies = mail.sent.filter((m) => m.to === 'owner@example.com');
  assert.equal(copies.length, 1);
  assert.deepEqual(mail.sent.filter((m) => m.headers?.['List-Unsubscribe']).map((m) => m.to), ['owner@example.com'], 'no news email to anyone else');
  assert.equal(shopify.subscribers, 0, 'nobody else is looked up');
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM news_sends').one().n, 0);
  const bf = ok(await internal('news-test', { campaign: 'black-friday-2026', to: 'owner@example.com' }));
  assert.equal(bf.subject, '[Test] Black Friday: buy one dice set, get one free');
  const bad = ok(await internal('news-test', { campaign: 'weekly', to: 'not an email' }));
  assert.equal(bad.ok, false);
  // and the owner's job does the same
  const job = await lair.adminJob({ kind: 'news.status' });
  assert.deepEqual(job, { news: [] });
});

/* ---------------- the layout ---------------- */

test('round 41, news: the layout\'s list, products two to a row and second part render, and links get the email\'s tags', () => {
  const { html, text } = renderEmail({
    title: 'T', agenda: [{ when: ['Tue', '17 Nov'], title: 'A <b>', detail: 'x', url: 'https://a.nz' }],
    tiles: [{ title: 'D', price: '$1', url: 'https://b.nz', image: 'https://c.nz/i.jpg' }, { title: 'E' }, { title: 'F', url: 'javascript:alert(1)' }],
    section: { heading: 'New', intro: 'hi', link: { label: 'See', url: 'https://d.nz' } },
    unsubscribe: { label: 'Unsubscribe', url: 'https://e.nz', note: 'You said yes.' },
  });
  assert.match(html, /A &lt;b&gt;/, 'escaped');
  assert.doesNotMatch(html, /javascript:/, 'only http(s) links');
  assert.equal((html.match(/<td width="50%"/g) || []).length, 4, 'three products and a spacer, two rows');
  assert.match(text, /Tue 17 Nov {2}A <b>\n {4}x/);
  assert.match(text, /NEW\n\nhi\n\nSee: https:\/\/d\.nz/);
  assert.equal(tagged('https://x.nz/p?a=1', 's', 'c'), 'https://x.nz/p?a=1&utm_medium=email&utm_source=s&utm_campaign=c');
});

/* ---------------- after the review ---------------- */

test('round 41 review: a batch Resend refuses (one bad address) is halved and tried again, so only that address fails', async () => {
  switchOn('weekly');
  // Resend refuses any batch with Kai in it (a 422 for the whole batch, as it does)
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const list = Array.isArray(body) ? body : [body];
    if (list.some((m) => m.to[0] === 'kai@example.com')) return new Response(JSON.stringify({ message: 'Invalid `to` field' }), { status: 422 });
    for (const m of list) mail.sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: list.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  let t = at(MON, 10, 5);
  for (let i = 0; i < 6; i += 1, t += 10 * 60_000) await run(t);
  assert.deepEqual(news().map((m) => m.to).sort(), ['mia@example.com', 'ria@example.com'], 'the others still get it');
  const rows = lair.sql.exec('SELECT email, status FROM news_sends ORDER BY email').toArray().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ email: 'kai@example.com', status: 'failed' }, { email: 'mia@example.com', status: 'sent' }, { email: 'ria@example.com', status: 'sent' }]);
});

test('round 41 review: a refusal for every email (a sender Resend won\'t take) pauses the news emails after three, instead of using up the list', async () => {
  switchOn('weekly');
  lair.shopify.marketingSubscribers = async () => Array.from({ length: 8 }, (_, i) => ({ email: `p${i}@example.com`, customerId: String(i), firstName: '' }));
  mail.fail(403);
  let t = at(MON, 10, 5);
  for (let i = 0; i < 12; i += 1, t += 10 * 60_000) await run(t);
  const failed = lair.sql.exec("SELECT COUNT(*) AS n FROM news_sends WHERE status = 'failed'").one().n;
  assert.equal(failed, 3, 'three marked failed, one at a time');
  assert.match(lair.newsPaused(), /^Resend refused 3 emails in a row on their own: /);
  assert.equal(lair.newsStatus().paused, lair.newsPaused());
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM news_sends WHERE status = 'queued'").one().n, 5, 'the rest wait');
  // fixed and resumed (the owner's job): the rest go
  mail.fail(0);
  assert.deepEqual(await lair.adminJob({ kind: 'news.resume' }), { resumed: true });
  const after = await run(t);
  assert.equal(after.sent.sent, 5);
});

test('round 41 review: an email still queued once its time has passed is not sent late (Black Friday after the 30th, a weekly after Tuesday)', async () => {
  switchOn('weekly, black-friday-2026');
  mail.fail(503);
  await run(at('2026-11-30', 19, 55));
  mail.fail(0);
  const late = await run(at('2026-12-01', 9, 5));
  assert.equal(news().filter((m) => m.subject === NEWS_WORDS.blackFriday.subject).length, 0, 'no Black Friday email on 1 December');
  assert.equal(late.sent.expired, 3);
  // this Monday's weekly went the same run (made at 7:55pm on the 30th), sent the next morning: still this week
  assert.equal(news().filter((m) => /This week/.test(m.subject)).length, 3);
  // a weekly made but not sent by the end of Tuesday is let go
  mail.fail(503);
  await run(at('2026-12-07', 19, 55));
  mail.fail(0);
  await run(at('2026-12-09', 9, 5));
  assert.equal(news().filter((m) => /This week/.test(m.subject)).length, 3, 'the 7 December weekly never went');
});

/* ---------------- pictures (Mo, 16 Nov 2026: "I want the game images be included with the events inside the email") ---------------- */

test('round 41, news: each event shows its picture from Shopify (cropped to a thumbnail), each session its game\'s picture, and one without gets a day tile', async () => {
  const g = await session();
  lair.write('UPDATE games SET image_id = ? WHERE id = ?', 'https://cdn.shopify.com/s/files/1/lost-mine.png?v=2', g.id);
  switchOn('weekly');
  await run(at(MON, 10, 5));
  const m = news('mia@example.com')[0];
  // Warhammer Night: its Shopify picture, 240 x 135 from the CDN, shown 120 wide, linked to the events page
  assert.match(m.html, /<a href="https:\/\/www\.dicegoblin\.nz\/pages\/our-games\?utm_medium=email&amp;utm_source=weekly-email&amp;utm_campaign=events" style="text-decoration:none;"><img src="https:\/\/cdn\.shopify\.com\/s\/files\/1\/dg-event-warhammer\.jpg\?v=1&amp;width=240&amp;height=135&amp;crop=center" width="120" alt="Warhammer Night"/);
  // Lost Mine: the game's own picture, linked to its join sheet
  assert.match(m.html, /<img src="https:\/\/cdn\.shopify\.com\/s\/files\/1\/lost-mine\.png\?v=2&amp;width=240&amp;height=135&amp;crop=center" width="120" alt="Lost Mine \(D&amp;D 5e\)"/);
  // Oddity Alley has no picture here: a dark tile with its days in goblin green
  assert.match(m.html, /background:#16110f;border-radius:8px;font:800 15px\/1\.25 [^"]*;color:#46d06c;[^"]*">Sat–Sun<br>28–29 Nov<\/td>/);
  // the day sits over each title now
  assert.match(m.html, /color:#1f7a3d;margin:0 0 2px;">Thu 26 Nov<\/div><a [^>]*>Warhammer Night<\/a>/);
  // the plain-text copy is as it was
  assert.match(m.text, /Thu 26 Nov {2}Warhammer Night\n {4}6pm to midnight · \$10 a person/);
});

test('round 41, news: with no pictures to be had (Shopify won\'t give them), the weekly email still goes, as the plain list', async () => {
  lair.shopify.eventImages = async () => {
    throw new Error('Access denied for reference field');
  };
  switchOn('weekly');
  const r = await run(at(MON, 10, 5));
  assert.equal(r.sent.sent, 3);
  const m = news('mia@example.com')[0];
  assert.doesNotMatch(m.html, /width="120"/);
  assert.match(m.html, /font:700 13px\/1\.4 [^"]*;color:#6b5d52;vertical-align:top;width:64px;">Thu<br>26 Nov<\/td>/);
});

/* ---------------- the staff page's Emails tab (Mo: "automated inside the staff section to be sent as a weekly template with the chance to edit") ---------------- */

const MO = 'mo@dicegoblin.test';
const staffCall = (method, path, body) => call(method, path, body, OWNER);
async function mondayDraft() {
  await session();
  nowIs(at(MON, 8));
  await run(at(MON, 8));
  return `weekly-${MON}`;
}

test('round 41, Emails tab: only the owner sees it; a helper with every permission and a customer are turned away', async () => {
  await mondayDraft();
  const list = ok(await staffCall('GET', 'news'));
  assert.equal(list.ready, true);
  assert.deepEqual(list.on, []);
  assert.equal(list.week, `weekly-${MON}`);
  assert.equal(list.emails.length, 1);
  const customer = await call('GET', 'news', null, '6001');
  assert.equal(customer.status, 403);
  assert.throws(() => lair.newsStaffList({ customerId: '5', staff: true, role: 'helper', perms: ['tables', 'checkin', 'money', 'members', 'sessions', 'events', 'library', 'community', 'team'] }, lair.rulesCache), /./);
});

test('round 41, Emails tab: Monday\'s draft shows as it will go, with every event, session and product to leave in or out', async () => {
  const id = await mondayDraft();
  const e = ok(await staffCall('GET', 'news')).emails[0];
  assert.equal(e.id, id);
  assert.equal(e.status, 'draft');
  assert.equal(e.subject, 'This week at the Lair: Oddity Alley');
  assert.deepEqual(e.agenda.map((a) => a.title), ['Lost Mine (D&D 5e)', 'Warhammer Night', 'Oddity Alley']);
  assert.ok(e.agenda.every((a) => a.key && a.hidden === false));
  assert.equal(e.newStock.tiles.length, 4);
  assert.equal(e.defaults.intro, NEWS_WORDS.weekly.intro);
  assert.match(e.preview, /<h1[^>]*>This week at the Lair<\/h1>/);
  assert.match(e.preview, /Unsubscribe<\/a>/);
});

test('round 41, Emails tab: the owner\'s changes (subject, preview line, opening words, a note from Gobgob, rows and products left out, the new stock off) show in the preview, the test and what goes', async () => {
  const id = await mondayDraft();
  const draft = ok(await staffCall('GET', 'news')).emails[0];
  const warhammer = draft.agenda.find((a) => a.title === 'Warhammer Night').key;
  const basilisk = draft.newStock.tiles.find((t) => /Basilisk/.test(t.title)).key;
  let e = ok(await staffCall('POST', `news/${id}`, {
    subject: 'Oddity Alley this weekend, friend', preheader: 'Stalls, snacks and strange things.', intro: 'Big week at the Lair.',
    note: 'Black Friday is coming: buy one dice set, get one free.', hide: [warhammer, basilisk, 'not-a-key'],
  })).emails[0];
  assert.equal(e.subject, 'Oddity Alley this weekend, friend');
  assert.deepEqual(e.edits, { subject: 'Oddity Alley this weekend, friend', preheader: 'Stalls, snacks and strange things.', intro: 'Big week at the Lair.', note: 'Black Friday is coming: buy one dice set, get one free.', hideNew: false });
  assert.equal(e.agenda.find((a) => a.key === warhammer).hidden, true);
  assert.doesNotMatch(e.preview, /Warhammer Night/);
  assert.doesNotMatch(e.preview, /Basilisk/);
  assert.match(e.preview, /Big week at the Lair\./);
  assert.match(e.preview, /Black Friday is coming: buy one dice set, get one free\./);
  // the test copy: to the owner's own account email, as it will go
  lair.accountEmail = async () => ({ fetched: true, email: MO });
  const test = ok(await staffCall('POST', `news/${id}/test`, {}));
  assert.deepEqual(test, { ok: true, to: MO, subject: '[Test] Oddity Alley this weekend, friend' });
  const copy = mail.sent.find((m) => m.to === MO);
  assert.match(copy.text, /^THIS WEEK AT THE LAIR\n\nBig week at the Lair\.\n\n> Black Friday is coming/);
  assert.doesNotMatch(copy.text, /Warhammer Night|Basilisk/);
  // or to an address typed in
  ok(await staffCall('POST', `news/${id}/test`, { to: 'caleb@example.com' }));
  assert.equal(mail.sent.filter((m) => m.to === 'caleb@example.com').length, 1);
  assert.equal((await staffCall('POST', `news/${id}/test`, { to: 'not an email' })).status, 422);
  // the new stock off altogether, then a word field back to the Lair's own words
  e = ok(await staffCall('POST', `news/${id}`, { hideNew: true, intro: '' })).emails[0];
  assert.doesNotMatch(e.preview, /New in the hoard/);
  assert.match(e.preview, /Pull up a chair, friend/);
  assert.equal(e.edits.subject, 'Oddity Alley this weekend, friend', 'what wasn\'t sent stays as it was');
  // too long
  assert.equal((await staffCall('POST', `news/${id}`, { subject: 'x'.repeat(121) })).status, 422);
  // Send: to everyone subscribed less the stop list, as edited, first batch straight away
  nowIs(at(MON, 9, 30));
  const sent = ok(await staffCall('POST', `news/${id}/send`, {}));
  assert.deepEqual(sent.sent, { id, recipients: 3 });
  await new Promise((r) => setTimeout(r, 20));
  const went = news().filter((m) => m.to !== MO && m.to !== 'caleb@example.com');
  assert.equal(went.length, 3);
  assert.ok(went.every((m) => m.subject === 'Oddity Alley this weekend, friend' && !/Warhammer Night|New in the hoard/.test(m.html)));
  const after = ok(await staffCall('GET', 'news')).emails[0];
  assert.equal(after.status, 'sent');
  assert.equal(after.sentBy, 'staff');
  assert.deepEqual(after.counts, { sent: 3, waiting: 0, failed: 0, stopped: 0, expired: 0 });
  // once sent, it can't be changed or sent again; NEWS_EMAILS at 10am sends nothing more
  assert.equal((await staffCall('POST', `news/${id}`, { subject: 'Again' })).status, 409);
  assert.equal((await staffCall('POST', `news/${id}/send`, {})).status, 409);
  switchOn('weekly');
  await run(at(MON, 10, 5));
  assert.equal(news().filter((m) => m.to === 'mia@example.com').length, 1);
});

test('round 41, Emails tab: NEWS_EMAILS sends the draft by itself at 10am with the owner\'s changes', async () => {
  const id = await mondayDraft();
  ok(await staffCall('POST', `news/${id}`, { subject: 'Edited before ten' }));
  switchOn('weekly');
  const r = await run(at(MON, 10, 5));
  assert.deepEqual(r.made, [{ id, recipients: 3 }]);
  assert.ok(news().every((m) => m.subject === 'Edited before ten'));
  assert.equal(ok(await staffCall('GET', 'news')).emails[0].sentBy, 'auto');
});

test('round 41, Emails tab: a draft made on another day, Refresh keeps the changes, Black Friday only in its days, and nothing left means nothing to send', async () => {
  // Wednesday, no draft yet: the owner makes this week's
  nowIs(at(WED, 9));
  const made = ok(await staffCall('POST', 'news/draft', { kind: 'weekly' }));
  assert.equal(made.emails[0].id, `weekly-${MON}`);
  assert.equal((await staffCall('POST', 'news/draft', { kind: 'black-friday-2027' })).status, 422);
  const kinds = made.kinds.map((k) => k.kind);
  assert.deepEqual(kinds, ['weekly', 'black-friday-2026']);
  const bf = ok(await staffCall('POST', 'news/draft', { kind: 'black-friday-2026' }));
  assert.equal(bf.emails.find((e) => e.id === 'black-friday-2026').status, 'draft');
  // leave everything out of the weekly: nothing to send
  const id = `weekly-${MON}`;
  const e = made.emails[0];
  const all = [...e.agenda.map((a) => a.key), ...e.newStock.tiles.map((t) => t.key)];
  ok(await staffCall('POST', `news/${id}`, { hide: all, hideNew: true, subject: 'Kept' }));
  assert.equal((await staffCall('POST', `news/${id}/send`, {})).status, 422);
  // Refresh: made again, the changes kept
  const fresh = ok(await staffCall('POST', `news/${id}/refresh`, {})).emails.find((x) => x.id === id);
  assert.equal(fresh.subject, 'Kept');
  assert.equal(fresh.edits.hideNew, true);
});

// Round 37: the GM perk, the staff slot and a game's books (contract v37-gm-perk). Mo (14 Nov 2026): "I want a special
// tag that staff [can] give to certain customers who are gms, and given to the customers that sign up to run roleplaying
// games. As a perk they get the option to get one library copy of any RPG books, only one copy per person. [...] when
// gms set up [to] run games they should ask for a copy of the game to be soft reserved [...] this does not stop someone
// from taking a game but will be notified that there are games that want this game on such and such date. [...] we
// might send a nudge if a week or two passed and the book is not back. [...] after 3 games consecutively that have not
// been filled it will disable the perk. Staff can give permission directly and take it away as well. The three weeks no
// game remove perk function still applies to staff giving to customers the tag etc. Also give all staff the perk of
// adding any library game from dice goblin as a perk not just RPG books. One slot only." His answers the same morning:
// filled is at least 1 player; both ways of switching off; and a new GM gets it when their game is listed.
// Each test is written from the contract's rules (the section is named), not from the code. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { GM_PERK, GM_PERK_WORDS as W } from '../src/gm-perk.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Monday 16 November 2026, 10:00am in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 10, 15, 21, 0);
const realNow = Date.now;
const realFetch = globalThis.fetch;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const nowIs = (ms) => {
  Date.now = () => ms;
};

/* ---------------- helpers, as in test/round21-gm-credit.test.js ---------------- */
function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      // as SQLite in a Durable Object: at most 100 bound values a query and 5 terms in a compound SELECT, Cloudflare's
      // limits (test/cloudflare-sql.js), so a query of this round's that Cloudflare would refuse fails here too
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

const ROOMS = [
  { id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 },
  { id: 'side-room-2', name: 'Side room 2', code: 'B', tables: 8, seats: 4, order: 3 },
];
// People by their Shopify customer IDs (made up). The team: the main account (tagged staff in Shopify); Ana, a helper
// with Library and Members; Ben, a helper with Check-in only; Cal, a helper with GM games. GMs who aren't staff: Rangi,
// Wiremu, and Hana (tagged gm in Shopify, so her games need no approval). Players: Mia and Kai. Sam is a library member
// on Stash (3 games) and Pita on Grab (1 game), by their Simplee tags.
const OWNER = '9001';
const ANA = '9101';
const BEN = '9102';
const CAL = '9103';
const RANGI = '5001';
const WIREMU = '5002';
const HANA = '5003';
const MIA = '6001';
const KAI = '6002';
const SAM = '6003';
const PITA = '6004';
const NAMES = {
  [OWNER]: 'Mo Ashgrove', [ANA]: 'Ana Ngata', [BEN]: 'Ben Tane', [CAL]: 'Cal Reid', [RANGI]: 'Rangi Hohaia', [WIREMU]: 'Wiremu Paki', [HANA]: 'Hana Rewi',
  [MIA]: 'Mia Chen', [KAI]: 'Kai Tane', [SAM]: 'Sam Jones', [PITA]: 'Pita Moana',
};
const first = (id) => NAMES[id].split(' ')[0];
const emailOf = (id) => `${first(id).toLowerCase()}@example.com`;
let TAGS;

// The library's catalogue (as the 10-minute sync keeps it in pick_catalog): six books on the RPG shelf, one of them
// tagged for it without the shelf's code, one that stays in the Lair, one gone from the shelf, and two board games
const BOOK = (variantId, title, shelfCode, extra = {}) => ({
  variantId, productId: `8${variantId.slice(1)}`, title, shelfCode, handle: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-library`,
  tags: ['Board Game Rental', 'RPG', 'Shelf RPG books'], status: 'active', inStoreOnly: 0, copies: 1, ...extra,
});
const PHB = BOOK('7001', "Player's Handbook", 'DGLRPG-001');
const BLADES = BOOK('7002', 'Blades in the Dark', 'DGLRPG-002');
const MOTHERSHIP = BOOK('7003', 'Mothership', 'DGLRPG-003');
const CTHULHU = BOOK('7004', 'Call of Cthulhu', 'DGLRPG-004', { copies: 2 });
const BROOMS = BOOK('7005', 'Kids on Brooms', 'DGL34-M050');
const VAULT = BOOK('7006', 'The Vault of Secrets', 'DGLRPG-006', { inStoreOnly: 1 });
const GONE = BOOK('7007', 'An Old Edition', 'DGLRPG-007', { status: 'gone' });
const CATAN = BOOK('7101', 'Catan', 'DGL34-M011', { tags: ['Board Game Rental'] });
const AZUL = BOOK('7102', 'Azul', 'DGL34-S002', { tags: ['Board Game Rental'] });
const CATALOGUE = [PHB, BLADES, MOTHERSHIP, CTHULHU, BROOMS, VAULT, GONE, CATAN, AZUL];

let lair;
let reached;
let lookups;
async function call(method, path, body, customer = '', headers = {}) {
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...headers },
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, data: await response.json() };
}
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const me = async (who) => ok(await call('GET', `me?name=${encodeURIComponent(NAMES[who] || 'Someone New')}`, null, who));
const perkOf = async (who) => (await me(who)).library.perk;
const perkRow = (id) => {
  const row = lair.sql.exec('SELECT status, source, off_reason AS reason, by, since FROM gm_perks WHERE customer_id = ?', id).toArray()[0];
  return row ? { ...row } : null;
};
const log = (id) => lair.sql.exec('SELECT action, reason, by, note FROM gm_perk_log WHERE customer_id = ? ORDER BY at, rowid', id).toArray().map((r) => `${r.action}:${r.reason}`);
const run = () => lair.gmPerkUpkeep(Date.now());
const scan = (book, who) => call('POST', 'library/scan', { code: book.shelfCode }, who);
const desk = (book, customerId, who = OWNER) => call('POST', 'library/loans', { customerId, code: book.shelfCode }, who);
const back = (book, who = OWNER) => call('POST', 'library/return', { code: book.shelfCode }, who);
const status = async (book, who = '') => ok(await call('GET', `library/status?ids=${book.variantId}`, null, who)).games[book.variantId];
const give = (id, body = {}, who = OWNER) => call('POST', `members/${id}/gm-perk`, { action: 'give', ...body }, who);
const take = (id, body = {}, who = OWNER) => call('POST', `members/${id}/gm-perk`, { action: 'take', ...body }, who);
const loansOf = (id) => lair.sql.exec("SELECT title, perk, lent, status FROM library_loans WHERE customer_id = ? ORDER BY out_at, rowid", id).toArray().map((r) => ({ ...r }));
const settle = () => new Promise((r) => setTimeout(r, 15));

/** A game's details as Run a game sends them: Wednesday 18 November, 6pm to 10pm, on B1, unless said */
const details = (gm, over = {}) => ({
  title: `${first(gm)}'s game`, system: 'D&D 5e', gm: first(gm), blurb: 'A test game.', seats: 4, tables: ['B1'],
  start: at('2026-11-18', 18), end: at('2026-11-18', 22), ...over,
});
/** A game the main account lists for a GM: straight on the board. → POST /games's answer */
const listFor = async (gm, over = {}) => ok(await call('POST', 'games', {
  ...details(gm, over), gmCustomerId: gm, gmCustomerName: NAMES[gm], gmEmail: emailOf(gm),
}, OWNER));
/** A game a GM lists themself (it waits for approval unless they're tagged gm) */
const listOwn = (gm, over = {}) => call('POST', 'games', details(gm, over), gm);
const approve = (gameId, who = OWNER) => call('POST', `games/${gameId}/update`, { status: 'open' }, who);
const cancel = (gameId, who = OWNER, scope = 'session') => call('POST', `games/${gameId}/update`, { status: 'cancelled', scope }, who);
/** A player's seat at a session (on their tab) */
async function seat(gameId, who) {
  return ok(await call('POST', 'bookings', { kind: 'gm-seat', gameId, people: 1, name: first(who), email: emailOf(who), phone: '021 555 0100', pay: 'day' }, who)).booking;
}
/** A weekly game for a GM, Wednesdays 6pm from 18 November on its own table: → its sessions, soonest first ({ id, start }) */
async function weekly(gm, over = {}) {
  const made = await listFor(gm, { schedule: 'weekly', ...over });
  return made.sessions.slice().sort((a, b) => a.start - b.start);
}
/** The moment a session has just ended (they're all 4 hours long) */
const after = (session) => session.start + 4 * HOUR + MIN;

/** Put a listing in the library's catalogue, as the 10-minute sync would, and let a scan find it by its shelf code */
function shelve(b) {
  lair.sql.exec(
    `INSERT INTO pick_catalog (product_id, variant_id, handle, raw_title, title, shelf_code, copies, in_store_only, tags, status, seen_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    b.productId, b.variantId, b.handle, `${b.title} (Library)`, b.title, b.shelfCode, b.copies, b.inStoreOnly, JSON.stringify(b.tags), b.status, NOW, NOW,
  );
  // and the Lair knows each by its shelf code, so a scan finds it without asking Shopify
  lair.saveLibraryGame({ variantId: b.variantId, productId: b.productId, title: b.title, handle: b.handle, shelfCode: b.shelfCode, image: null }, NOW);
}

/** Turn on emails and catch everything sent to Resend (single and batch) */
function captureEmails() {
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test' };
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.resend.com/')) throw new Error(`No network in tests: ${url}`);
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  // this round's emails, by their subjects (a GM also gets "Your game is live" and "New player for…", as before)
  const ours = (m) => /^(Your GM perk|A table wants|Could you bring)/.test(m.subject);
  return {
    sent,
    /** The subjects of this round's emails sent to someone since the last look, in order */
    to: async (who) => {
      await settle();
      const mine = sent.filter((m) => m.to === emailOf(who) && ours(m));
      sent.splice(0, sent.length, ...sent.filter((m) => m.to !== emailOf(who)));
      return mine.map((m) => m.subject);
    },
    all: async () => {
      await settle();
      return sent.splice(0, sent.length);
    },
  };
}

beforeEach(async () => {
  reached = [];
  lookups = [];
  TAGS = { [OWNER]: ['staff'], [HANA]: ['gm'], [SAM]: ['Simplee: Stash'], [PITA]: ['Simplee: Grab'] };
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  // Shopify's customer tags, kept 5 minutes as the Lair keeps them (lair.people)
  lair.taggedPerson = async (id) => {
    if (!id) return { customerId: null, staff: false, gm: false };
    const cached = lair.people.get(id);
    if (cached && Date.now() - cached.at < 5 * MIN) return cached.person;
    lookups.push(id);
    const tags = TAGS[id] || [];
    const person = { customerId: id, staff: tags.includes('staff'), gm: tags.includes('gm'), tags };
    lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  lair.notifyStaff = () => null;
  lair.gmCreditSoon = () => null;
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  for (const id of Object.keys(NAMES)) lair.makeMember({ customerId: id, name: NAMES[id], email: emailOf(id) }, NOW);
  ok(await call('POST', 'team', { customerId: ANA, perms: ['library', 'members'] }, OWNER));
  ok(await call('POST', 'team', { customerId: BEN, perms: ['checkin'] }, OWNER));
  ok(await call('POST', 'team', { customerId: CAL, perms: ['sessions'] }, OWNER));
  for (const b of CATALOGUE) shelve(b);
  // two copies of Call of Cthulhu, as its library page would say
  lair.pageCopies = ((original) => (variantId) => (String(variantId) === CTHULHU.variantId ? 2 : original.call(lair, variantId)))(lair.pageCopies);
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

/* ---------------- the words and the numbers (section 4, 1.2, 1.6, 1.7) ---------------- */

test('round 37: the words, word for word, and the numbers: 3 quiet sessions, 21 idle days, a nudge after 7 days, 3 books a game', () => {
  assert.deepEqual([GM_PERK.quiet, GM_PERK.idleDays, GM_PERK.nudgeDays, GM_PERK.backAskDays, GM_PERK.booksMax, GM_PERK.cancelHours], [3, 21, 7, 7, 3, 24]);
  assert.equal(W.borrowedGm('Mothership'), "Mothership is yours to take home, free with your GM perk. When you're done, bring it to the counter and we'll scan it back onto the shelf.");
  assert.equal(W.borrowedStaff('Catan'), "Catan is yours to take home on your staff slot. Scan it back onto the shelf when you're done.");
  assert.equal(W.slotFullGm('Mothership'), 'Your GM perk is one book at a time, and Mothership is at home with you. Bring it back to the counter to swap.');
  assert.equal(W.slotFullStaff('Catan'), 'Your staff slot is one game at a time, and Catan is at home with you. Scan it back in to swap.');
  assert.equal(W.rpgOnly, 'Your GM perk covers the RPG shelf. Join the library to borrow board games.');
  assert.equal(W.resting, 'Your GM perk is having a rest until your next game runs. Join the library to borrow in the meantime.');
  const sun = at('2026-11-15', 18);
  const wed = at('2026-11-18', 18, 30);
  const sat = at('2026-11-21', 14);
  assert.equal(
    W.wantedLine([{ at: sun, title: 'The Ember Road', mine: false }], TZ),
    'Heads up: The Ember Road would like this one on the table at the Lair on Sun 15 Nov, 6pm. Take it by all means, and bring it back by then if you can.',
  );
  assert.equal(
    W.wantedLine([{ at: sun, title: null, mine: false }], TZ),
    'Heads up: a private game would like this one on the table at the Lair on Sun 15 Nov, 6pm. Take it by all means, and bring it back by then if you can.',
  );
  assert.equal(
    W.wantedLine([{ at: sun, title: 'A', mine: false }, { at: wed, title: 'B', mine: false }, { at: sat, title: 'A', mine: false }], TZ),
    'Heads up: tables at the Lair would like this one on Sun 15 Nov, 6pm, Wed 18 Nov, 6:30pm and Sat 21 Nov, 2pm. Take it by all means, and bring it back in time if you can.',
  );
  assert.equal(
    W.wantedLine([{ at: sun, title: 'A', mine: false }, { at: wed, title: 'B', mine: false }, { at: sat, title: 'A', mine: false }], TZ, 2),
    'Heads up: tables at the Lair would like this one on Sun 15 Nov, 6pm, Wed 18 Nov, 6:30pm, Sat 21 Nov, 2pm and 2 more dates. Take it by all means, and bring it back in time if you can.',
  );
  assert.equal(
    W.wantedLine([{ at: sun, title: 'A', mine: false }, { at: wed, title: 'B', mine: false }], TZ, 1),
    'Heads up: tables at the Lair would like this one on Sun 15 Nov, 6pm, Wed 18 Nov, 6:30pm and 1 more date. Take it by all means, and bring it back in time if you can.',
  );
  assert.equal(W.wantedLine([{ at: sun, title: 'A', mine: true }, { at: sat, title: 'A', mine: true }], TZ), "It's down for your own game on Sun 15 Nov, 6pm: bring it along.");
  // their own game and someone else's: the heads-up is about the other table's dates
  assert.equal(
    W.wantedLine([{ at: sun, title: 'Mine', mine: true }, { at: wed, title: 'Theirs', mine: false }], TZ),
    'Heads up: Theirs would like this one on the table at the Lair on Wed 18 Nov, 6:30pm. Take it by all means, and bring it back by then if you can.',
  );
  assert.equal(W.wantedLine([], TZ), '');
  assert.equal(W.booksList, "Send the game's books as a list.");
  assert.equal(W.booksMax, 'A game can name up to 3 library books.');
  assert.equal(W.bookUnknown, "That isn't one of the library's RPG books. Pick one from the list.");
  assert.equal(W.booksOwn, "Only the game's GM or staff can change its books.");
  assert.equal(W.booksCancelled, "That game was cancelled, so its books can't change.");
  assert.equal(W.action, 'Pick give or take.');
  assert.equal(W.giveTeam('Ana'), 'Ana is on the team, so they have the staff slot already.');
  assert.equal(W.giveOn('Rangi'), 'Rangi already has the GM perk.');
  assert.equal(W.takeOff('Rangi'), "Rangi's GM perk is switched off already.");
  assert.equal(W.giveOn(''), 'They already have the GM perk.');
  assert.equal(W.takeOff(''), 'Their GM perk is switched off already.');
  assert.equal(W.giveTeam(''), 'They are on the team, so they have the staff slot already.');
});

/* ---------------- who has the GM perk (1.2) ---------------- */

test('1.2: a game on the board switches its GM\'s perk on at once, the first time: one RPG book, free, with nothing in a Shopify tag', async () => {
  assert.equal(await perkOf(RANGI), null, 'nobody has it before they run a game');
  const made = await listFor(RANGI);
  assert.deepEqual(made.perk, { on: true }, 'listing it switched the perk on, and the answer says so');
  assert.deepEqual(perkRow(RANGI), { status: 'on', source: 'auto', reason: null, by: 'auto', since: NOW });
  assert.deepEqual(log(RANGI), ['on:listed']);
  assert.deepEqual(await perkOf(RANGI), { kind: 'gm', status: 'on', covers: 'rpg', free: true, loanId: null, since: NOW, quiet: 0, quietMax: 3, reason: null });
  // a second game doesn't switch it on again
  const again = await listFor(RANGI, { tables: ['B2'], title: 'Another' });
  assert.equal(again.perk, undefined);
  assert.deepEqual(log(RANGI), ['on:listed']);
  // players get no perk for joining
  await seat(made.game.id, MIA);
  assert.equal(await perkOf(MIA), null);
});

test('1.2: a GM\'s own listing waits for approval, and the perk with it; a trusted GM\'s game is on the board, so theirs is on at once', async () => {
  const own = await listOwn(WIREMU);
  assert.deepEqual([own.status, own.data.pending, own.data.perk], [200, true, undefined]);
  assert.equal(perkRow(WIREMU), null, 'a game waiting for approval is not on the board');
  await run();
  assert.equal(perkRow(WIREMU), null, 'nor by the 10-minute run');
  ok(await approve(own.data.game.id));
  assert.deepEqual([perkRow(WIREMU)?.status, log(WIREMU)], ['on', ['on:listed']], 'approved: on the board, and the perk is on');
  const trusted = await listOwn(HANA, { tables: ['B2'] });
  assert.deepEqual([trusted.status, trusted.data.pending, trusted.data.perk], [200, false, { on: true }]);
  assert.equal(perkRow(HANA)?.status, 'on');
});

test('1.2: games already on the board count: the 10-minute run switches those GMs on, and so does a game that joins an account at login', async () => {
  const mail = captureEmails();
  await listFor(RANGI);
  // as if the game were listed before this round: no record yet
  lair.sql.exec('DELETE FROM gm_perks');
  lair.sql.exec('DELETE FROM gm_perk_log');
  await mail.all();
  const result = await run();
  assert.equal(result.on, 1);
  assert.deepEqual([perkRow(RANGI)?.status, log(RANGI)], ['on', ['on:listed']]);
  assert.deepEqual(await mail.to(RANGI), ['Your GM perk is on: borrow an RPG book, free']);
  assert.equal((await run()).on, 0, 'once');
  // a game staff listed by email for a GM with no account joins their account when they log in with that email
  const NEW = '7777';
  ok(await call('POST', 'games', { ...details(RANGI, { tables: ['B3'], title: 'Tama runs this', gm: 'Tama' }), gmEmail: 'tama@example.com' }, OWNER));
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  lair.shopify.customerEmail = async () => ({ email: 'tama@example.com', verified: true });
  lair.shopify.giftCodeUse = async () => null;
  const mine = ok(await call('GET', 'me?name=Tama%20Kereama', null, NEW));
  assert.equal(mine.games.length, 1, 'the game is theirs now');
  assert.deepEqual([mine.library.perk?.kind, mine.library.perk?.status], ['gm', 'on'], 'and the perk is on from the same login');
  assert.deepEqual(log(NEW), ['on:listed']);
});

test('1.1, 1.2: the team has the staff slot instead: no GM perk record for the main account or a helper who runs a game', async () => {
  const mos = await listOwn(OWNER);
  assert.deepEqual([mos.status, mos.data.pending, mos.data.perk], [200, false, undefined]);
  await listFor(ANA, { tables: ['B2'] });
  await run();
  assert.deepEqual([perkRow(OWNER), perkRow(ANA)], [null, null]);
  const staffSlot = { kind: 'staff', status: 'on', covers: 'any', free: true, loanId: null, since: null, quiet: 0, quietMax: 3, reason: null };
  assert.deepEqual(await perkOf(OWNER), staffSlot);
  assert.deepEqual(await perkOf(ANA), staffSlot);
  assert.deepEqual(await perkOf(BEN), staffSlot, 'every helper, whatever they can do on the staff page');
});

/* ---------------- which sessions count, the rest and the way back (1.2, 1.3) ---------------- */

test('1.2, 1.3: three sessions in a row with nobody at the table and the perk rests; the GM is emailed once; two is not three', async () => {
  const mail = captureEmails();
  const s = await weekly(RANGI);
  assert.deepEqual(await mail.to(RANGI), ['Your GM perk is on: borrow an RPG book, free']);
  nowIs(after(s[0]));
  await run();
  assert.equal((await perkOf(RANGI)).quiet, 1);
  nowIs(after(s[1]));
  await run();
  assert.deepEqual([perkRow(RANGI).status, (await perkOf(RANGI)).quiet], ['on', 2], 'two quiet sessions: still on');
  // the third hasn't ended yet: a session counts once its end has passed
  nowIs(s[2].start + HOUR);
  await run();
  assert.equal(perkRow(RANGI).status, 'on');
  nowIs(after(s[2]));
  const result = await run();
  assert.equal(result.rested, 1);
  assert.deepEqual(perkRow(RANGI), { status: 'off', source: 'auto', reason: 'quiet', by: 'auto', since: NOW });
  assert.deepEqual(log(RANGI), ['on:listed', 'off:quiet']);
  assert.deepEqual(await perkOf(RANGI), { kind: 'gm', status: 'resting', covers: 'rpg', free: false, loanId: null, since: NOW, quiet: 0, quietMax: 3, reason: 'quiet' });
  assert.deepEqual(await mail.to(RANGI), ['Your GM perk is having a rest']);
  nowIs(after(s[3]));
  await run();
  assert.deepEqual([log(RANGI), await mail.to(RANGI)], [['on:listed', 'off:quiet'], []], 'it rests once');
});

test('1.3: filled is at least one player: one seat makes a session played, and so do the group\'s own players; the GM\'s own seat, a no-show and a cancelled seat do not', async () => {
  const s = await weekly(RANGI);
  // Wiremu's group books outside the Lair: the players the game already has count (Mo's "5/6")
  const w = await weekly(WIREMU, { tables: ['B2'] });
  lair.sql.exec('UPDATE games SET offline_players = 3 WHERE gm_customer_id = ?', WIREMU);
  // week 1: one player booked → played
  await seat(s[0].id, MIA);
  // week 2: only the GM's own seat → quiet
  await seat(s[1].id, RANGI);
  // week 3: a player who cancels → quiet
  const gone = await seat(s[2].id, KAI);
  ok(await call('POST', `bookings/${gone.id}/update`, { status: 'cancelled' }, OWNER));
  nowIs(after(s[2]));
  await run();
  assert.deepEqual([perkRow(RANGI).status, (await perkOf(RANGI)).quiet], ['on', 2], 'played, quiet, quiet');
  // week 4: a player staff mark a no-show → quiet: three in a row now
  const noshow = await seat(s[3].id, KAI);
  nowIs(s[3].start + HOUR);
  ok(await call('POST', `bookings/${noshow.id}/update`, { status: 'noshow' }, OWNER));
  nowIs(after(s[3]));
  await run();
  assert.deepEqual([perkRow(RANGI).status, perkRow(RANGI).reason], ['off', 'quiet']);

  nowIs(after(w[5]));
  await run();
  assert.deepEqual([perkRow(WIREMU).status, (await perkOf(WIREMU)).quiet, log(WIREMU)], ['on', 0, ['on:listed']], 'six sessions with nobody booked through the Lair, all played');
});

test('1.3: a played session breaks the run: quiet, quiet, played, quiet, quiet is not three in a row', async () => {
  const s = await weekly(RANGI);
  await seat(s[2].id, MIA);
  for (const n of [0, 1, 2, 3, 4]) {
    nowIs(after(s[n]));
    await run();
  }
  assert.deepEqual([perkRow(RANGI).status, (await perkOf(RANGI)).quiet], ['on', 2]);
  nowIs(after(s[5]));
  await run();
  assert.deepEqual([perkRow(RANGI).status, perkRow(RANGI).reason], ['off', 'quiet']);
});

test('1.3: a session called off within 24 hours of its start (or after it) is quiet; one cancelled further ahead does not count either way', async () => {
  const s = await weekly(RANGI);
  // week 1 cancelled two days ahead (plans changed): doesn't count
  ok(await cancel(s[0].id, RANGI));
  // week 2 quiet
  // week 3 called off 23 hours before: quiet (whoever calls it off: staff here, as the counter does for a GM that late)
  nowIs(s[2].start - 23 * HOUR);
  ok(await cancel(s[2].id));
  nowIs(after(s[2]));
  await run();
  assert.deepEqual([perkRow(RANGI).status, (await perkOf(RANGI)).quiet], ['on', 2], 'the one cancelled two days ahead is not a third');
  // week 4 cancelled half an hour in (the group didn't show): the third quiet one in a row
  nowIs(s[3].start + 30 * MIN);
  ok(await cancel(s[3].id));
  nowIs(after(s[3]));
  await run();
  assert.deepEqual([perkRow(RANGI).status, perkRow(RANGI).reason], ['off', 'quiet']);

  // and a cancelled session with a player booked is no played session: Wiremu's are called off on the day three times, players and all
  nowIs(NOW);
  const w = await weekly(WIREMU, { tables: ['B2'], start: at('2026-11-19', 18), end: at('2026-11-19', 22) });
  // (his group has players of its own too: the players a called-off session would have had don't make it played)
  lair.sql.exec('UPDATE games SET offline_players = 3 WHERE gm_customer_id = ?', WIREMU);
  for (const n of [0, 1, 2]) {
    nowIs(w[n].start - 30 * HOUR);
    await seat(w[n].id, MIA);
    nowIs(w[n].start - HOUR);
    ok(await cancel(w[n].id));
  }
  nowIs(after(w[2]));
  await run();
  assert.deepEqual([perkRow(WIREMU).status, perkRow(WIREMU).reason], ['off', 'quiet']);
  // nor does a called-off session bring a resting perk back, or stand in for a game in his three weeks
  nowIs(w[3].start - HOUR);
  ok(await cancel(w[3].id));
  nowIs(after(w[3]));
  await run();
  assert.deepEqual([perkRow(WIREMU).status, log(WIREMU)], ['off', ['on:listed', 'off:quiet']]);
  assert.equal(ok(await call('GET', `members/${WIREMU}`, null, ANA)).member.perk.lastPlayed, null);
});

test('1.2: three weeks with no session played and none coming up and the perk rests (idle); a session coming up, even one waiting for approval, keeps it', async () => {
  const mail = captureEmails();
  // staff give Rangi the perk; he never lists a game
  ok(await give(RANGI));
  assert.deepEqual(await mail.to(RANGI), ['Your GM perk is on: borrow an RPG book, free']);
  nowIs(NOW + 21 * DAY - MIN);
  await run();
  assert.equal(perkRow(RANGI).status, 'on', 'not yet three weeks');
  nowIs(NOW + 21 * DAY);
  await run();
  assert.deepEqual(perkRow(RANGI), { status: 'off', source: 'staff', reason: 'idle', by: 'auto', since: NOW });
  assert.deepEqual([log(RANGI), await mail.to(RANGI)], [['on:staff', 'off:idle'], ['Your GM perk is having a rest']]);

  // Wiremu has the perk and a one-shot five weeks out: nothing played for three weeks, but a game is coming up
  nowIs(NOW);
  await listFor(WIREMU, { tables: ['B2'], start: at('2026-12-21', 18), end: at('2026-12-21', 22) });
  // Hana has the perk from staff and a game still waiting for approval (she isn't tagged gm any more)
  TAGS[HANA] = [];
  ok(await give(HANA));
  const waiting = await listOwn(HANA, { tables: ['B3'], start: at('2026-12-22', 18), end: at('2026-12-22', 22) });
  assert.equal(waiting.data.pending, true);
  nowIs(NOW + 25 * DAY);
  await run();
  assert.deepEqual([perkRow(WIREMU).status, perkRow(HANA).status], ['on', 'on']);
  // Wiremu's one-shot comes and goes with nobody at it: five weeks with nothing played, and now nothing coming up
  nowIs(at('2026-12-21', 21, 59));
  await run();
  assert.equal(perkRow(WIREMU).status, 'on', 'still coming up until it ends');
  nowIs(at('2026-12-21', 22, 1));
  await run();
  assert.deepEqual([perkRow(WIREMU).status, perkRow(WIREMU).reason], ['off', 'idle']);
});

test('1.2: a played session in the last three weeks keeps a GM with nothing coming up from being idle', async () => {
  const made = await listFor(RANGI);
  await seat(made.game.id, MIA);
  nowIs(made.game.start + 20 * DAY);
  await run();
  assert.equal(perkRow(RANGI).status, 'on');
  nowIs(made.game.start + 21 * DAY + MIN);
  await run();
  assert.deepEqual([perkRow(RANGI).status, perkRow(RANGI).reason], ['off', 'idle']);
});

test('1.2: after a rest it comes back by itself when a game of theirs is played, never just for listing one', async () => {
  const mail = captureEmails();
  const s = await weekly(RANGI);
  nowIs(after(s[2]));
  await run();
  assert.equal(perkRow(RANGI).reason, 'quiet');
  await mail.all();
  const rested = Date.now();
  // listing another game doesn't bring it back
  const another = await listFor(RANGI, { tables: ['B2'], title: 'A new one-shot', start: at('2026-12-05', 14), end: at('2026-12-05', 18) });
  assert.equal(another.perk, undefined);
  await run();
  assert.equal(perkRow(RANGI).status, 'off');
  // week 4 has a player: once it's over, the perk is back
  await seat(s[3].id, MIA);
  nowIs(s[3].start + HOUR);
  await run();
  assert.equal(perkRow(RANGI).status, 'off', 'not until the session has ended');
  nowIs(after(s[3]));
  const result = await run();
  assert.equal(result.back, 1);
  assert.deepEqual(perkRow(RANGI), { status: 'on', source: 'auto', reason: null, by: 'auto', since: after(s[3]) });
  assert.deepEqual(log(RANGI), ['on:listed', 'off:quiet', 'on:played']);
  assert.deepEqual(await mail.to(RANGI), ['Your GM perk is back']);
  assert.ok(rested < after(s[3]));
  // and the count starts again from there: the three quiet sessions before it are behind them
  assert.equal((await perkOf(RANGI)).quiet, 0);
});

test('1.2: a session played before the rest began never brings the perk back', async () => {
  const s = await weekly(RANGI);
  await seat(s[0].id, MIA);
  nowIs(after(s[3]));
  await run();
  assert.equal(perkRow(RANGI).reason, 'quiet', 'played, then three quiet ones');
  nowIs(after(s[3]) + HOUR);
  await run();
  assert.equal(perkRow(RANGI).status, 'off');
});

/* ---------------- staff give and take (1.8, 3.9) ---------------- */

test('1.8, 3.9: staff give the perk and take it away: who may, the refusals, the log, and an email only when it is given', async () => {
  const mail = captureEmails();
  assert.equal(said(await give(RANGI, {}, MIA)), '403 Staff only. Log in with your staff account.');
  assert.equal((await give(RANGI, {}, BEN)).status, 403, 'a helper with Check-in only');
  assert.equal(said(await give('4040')), '404 No member with that customer ID.');
  assert.equal(said(await call('POST', `members/${RANGI}/gm-perk`, { action: 'lend' }, OWNER)), `422 ${W.action}`);
  assert.equal(said(await give(ANA)), `409 ${W.giveTeam('Ana')}`);
  assert.equal(said(await give(OWNER)), `409 ${W.giveTeam('Mo')}`);
  assert.equal(perkRow(RANGI), null, 'nothing changed by any of those');

  // any one of Members, GM games or Library will do: Ana (Library and Members) gives it, with a note
  const given = ok(await give(RANGI, { note: '  Runs the Sunday beginners table  ' }, ANA));
  assert.deepEqual(
    [given.perk.kind, given.perk.status, given.perk.source, given.perk.since, given.perk.by, given.perk.note],
    ['gm', 'on', 'staff', NOW, { customerId: ANA, name: 'Ana Ngata' }, 'Runs the Sunday beginners table'],
  );
  assert.deepEqual(perkRow(RANGI), { status: 'on', source: 'staff', reason: null, by: `staff:${ANA}`, since: NOW });
  assert.deepEqual(await mail.to(RANGI), ['Your GM perk is on: borrow an RPG book, free']);
  assert.equal(said(await give(RANGI)), `409 ${W.giveOn('Rangi')}`);

  // Cal (GM games) takes it away: off, and nobody is emailed
  nowIs(NOW + HOUR);
  const taken = ok(await take(RANGI, { note: 'Lost a book last year' }, CAL));
  assert.deepEqual([taken.perk.status, taken.perk.reason, taken.perk.offAt, taken.perk.by, taken.perk.note], ['off', 'staff', NOW + HOUR, { customerId: CAL, name: 'Cal Reid' }, 'Lost a book last year']);
  assert.deepEqual(await mail.to(RANGI), []);
  assert.equal(said(await take(RANGI)), `409 ${W.takeOff('Rangi')}`);
  assert.deepEqual(await perkOf(RANGI), { kind: 'gm', status: 'off', covers: 'rpg', free: false, loanId: null, since: NOW, quiet: 0, quietMax: 3, reason: null });
  // the log, newest first, with who and why
  const page = ok(await call('GET', `members/${RANGI}`, null, ANA)).member.perk;
  assert.deepEqual(page.log.map((l) => [l.action, l.reason, l.by?.name, l.note]), [['off', 'staff', 'Cal Reid', 'Lost a book last year'], ['on', 'staff', 'Ana Ngata', 'Runs the Sunday beginners table']]);
  // a note is 300 characters at most
  const long = ok(await give(RANGI, { note: 'x'.repeat(400) }));
  assert.equal(long.perk.note.length, 300);
});

test('1.2, 1.8: a perk staff took never comes back by itself (not for listing, not for a played game), and taking it from someone who never had it keeps it off', async () => {
  // Wiremu never had it: staff take it, so listing a game doesn't switch it on
  ok(await take(WIREMU));
  assert.deepEqual(perkRow(WIREMU), { status: 'off', source: 'staff', reason: 'staff', by: `staff:${OWNER}`, since: NOW });
  const made = await listFor(WIREMU);
  assert.equal(made.perk, undefined);
  await seat(made.game.id, MIA);
  nowIs(made.game.end + MIN);
  await run();
  assert.deepEqual([perkRow(WIREMU).status, log(WIREMU)], ['off', ['off:staff']]);
  assert.equal(said(await scan(MOTHERSHIP, WIREMU)), '403 Join the library to borrow games.', 'and it borrows nothing');
  // staff give it back: on again
  ok(await give(WIREMU));
  assert.deepEqual([perkRow(WIREMU).status, log(WIREMU)], ['on', ['off:staff', 'on:staff']]);

  // Rangi's is resting; staff take it, so a played game doesn't bring it back
  nowIs(NOW);
  const s = await weekly(RANGI, { tables: ['B2'] });
  nowIs(after(s[2]));
  await run();
  assert.equal(perkRow(RANGI).reason, 'quiet');
  ok(await take(RANGI));
  await seat(s[3].id, MIA);
  nowIs(after(s[3]));
  await run();
  assert.deepEqual([perkRow(RANGI).status, perkRow(RANGI).reason], ['off', 'staff']);
});

test('1.2: a perk staff gave rests like any other, and only sessions after it went on count', async () => {
  const s = await weekly(RANGI);
  // two quiet sessions, then staff take it and give it back: a fresh start
  nowIs(after(s[1]));
  await run();
  assert.equal((await perkOf(RANGI)).quiet, 2);
  ok(await take(RANGI));
  ok(await give(RANGI));
  assert.deepEqual([perkRow(RANGI).source, (await perkOf(RANGI)).quiet], ['staff', 0]);
  nowIs(after(s[2]));
  await run();
  assert.deepEqual([perkRow(RANGI).status, (await perkOf(RANGI)).quiet], ['on', 1], 'the two from before it went on are behind them');
  nowIs(after(s[4]));
  await run();
  assert.deepEqual([perkRow(RANGI).status, perkRow(RANGI).reason, perkRow(RANGI).source], ['off', 'quiet', 'staff']);
});

/* ---------------- borrowing with a perk (1.1, 1.4) ---------------- */

test('1.1, 1.4: a GM with no library plan scans an RPG book and takes it home free; one at a time; it comes back through staff', async () => {
  await listFor(RANGI);
  const got = ok(await scan(MOTHERSHIP, RANGI));
  assert.deepEqual([got.result, got.message, got.wanted], ['borrowed', W.borrowedGm('Mothership'), []]);
  assert.deepEqual([got.loan.title, got.loan.perk, got.loan.lent, got.loan.perkEnded], ['Mothership', 'gm', true, false]);
  assert.deepEqual([got.library.plan, got.library.used, got.library.perk.free, got.library.perk.loanId], [null, 0, false, got.loan.id], 'outside any plan');
  assert.deepEqual(loansOf(RANGI), [{ title: 'Mothership', perk: 'gm', lent: 1, status: 'out' }]);
  assert.deepEqual([(await status(MOTHERSHIP)).out, (await status(MOTHERSHIP)).available], [1, 0], 'the copy is out, like any loan');
  // a second book while the first is at home
  assert.equal(said(await scan(BLADES, RANGI)), `409 ${W.slotFullGm('Mothership')}`);
  // the same one again: at home already, as for anyone
  assert.equal(ok(await scan(MOTHERSHIP, RANGI)).result, 'at-home');
  // staff scan it back in, and the slot is free again
  assert.equal(ok(await back(MOTHERSHIP, ANA)).result, 'returned');
  assert.equal((await perkOf(RANGI)).free, true);
  assert.equal(ok(await scan(BLADES, RANGI)).loan.perk, 'gm');
});

test('1.1: the GM perk covers the RPG shelf only: by its shelf code or its Shelf RPG books tag; never a board game, and never a game that stays in the Lair', async () => {
  await listFor(RANGI);
  assert.equal(said(await scan(CATAN, RANGI)), `403 ${W.rpgOnly}`);
  assert.equal(said(await scan(VAULT, RANGI)), '422 The Vault of Secrets stays in the Lair, so it can\'t go home. Play it at your table instead.');
  assert.deepEqual(loansOf(RANGI), []);
  // tagged for the RPG shelf without the shelf's code
  assert.equal(ok(await scan(BROOMS, RANGI)).loan.perk, 'gm');
});

test('1.4: with no plan, the scan says why the perk did not help: resting, or (taken by staff, or never had) join the library', async () => {
  const s = await weekly(RANGI);
  nowIs(after(s[2]));
  await run();
  assert.equal(said(await scan(MOTHERSHIP, RANGI)), `403 ${W.resting}`);
  ok(await take(RANGI));
  assert.equal(said(await scan(MOTHERSHIP, RANGI)), '403 Join the library to borrow games.');
  assert.equal(said(await scan(MOTHERSHIP, MIA)), '403 Join the library to borrow games.');
  assert.deepEqual([loansOf(RANGI), loansOf(MIA)], [[], []]);
});

test('1.1, 1.4: on top of a library plan: the perk takes an RPG book first and never counts towards the plan; the plan covers the rest as before', async () => {
  // Pita is on Grab (1 game) and runs a game
  await listFor(PITA);
  const book = ok(await scan(MOTHERSHIP, PITA));
  assert.deepEqual([book.loan.perk, book.loan.lent, book.library.plan, book.library.used], ['gm', true, { name: 'Grab', games: 1 }, 0]);
  // a board game goes on the plan
  const game = ok(await scan(CATAN, PITA));
  assert.deepEqual([game.loan.perk, game.loan.lent, game.library.used, game.message], [null, false, 1, "Catan is yours to take home. When you're done, bring it to the counter and we'll scan it back onto the shelf."]);
  // the plan is full and the slot is in use: the plan's own words, as before
  assert.equal(said(await scan(BLADES, PITA)), "409 Your plan has 1 game at a time, and you've got 1: 1 at home. Return one or cancel a hold first.");
  // Sam is on Stash and has the perk too: a second RPG book goes on the plan
  await listFor(SAM, { tables: ['B2'] });
  assert.equal(ok(await scan(PHB, SAM)).loan.perk, 'gm');
  const second = ok(await scan(BLADES, SAM));
  assert.deepEqual([second.loan.perk, second.loan.lent, second.library.used], [null, false, 1]);
});

test('1.4: a hold of theirs is collected on their plan, perk or no perk; and a perk never takes a copy that is not free', async () => {
  await listFor(SAM);
  const held = ok(await call('POST', 'library/holds', { variantId: PHB.variantId, productId: PHB.productId, title: PHB.title, shelfCode: PHB.shelfCode, handle: PHB.handle }, SAM));
  const got = ok(await scan(PHB, SAM));
  assert.deepEqual([got.loan.perk, got.loan.lent, got.hold?.id, got.library.used, got.library.perk.free], [null, false, held.hold.id, 1, true]);
  // Rangi's perk doesn't take the only copy from under a hold, or one that's out
  await listFor(RANGI, { tables: ['B2'] });
  assert.equal(said(await scan(PHB, RANGI)), '409 Every copy of Player\'s Handbook is reserved or out on loan. Ask us at the counter.');
  assert.deepEqual(loansOf(RANGI), []);
  // the hold is the plan's, by the plan's rules: with Pita's payment behind, the scan says so and the perk doesn't
  // quietly take the book he reserved; once he cancels the hold, the perk takes it
  await listFor(PITA, { tables: ['B3'] });
  const mine = ok(await call('POST', 'library/holds', { variantId: BLADES.variantId, productId: BLADES.productId, title: BLADES.title, shelfCode: BLADES.shelfCode, handle: BLADES.handle }, PITA));
  const planOf = lair.planOf.bind(lair);
  lair.planOf = (...args) => ({ ...planOf(...args), blocked: true, bankCheck: false });
  assert.equal((await scan(BLADES, PITA)).status, 402);
  assert.deepEqual(loansOf(PITA), []);
  ok(await call('POST', `library/holds/${mine.hold.id}/cancel`, {}, PITA));
  assert.equal(ok(await scan(BLADES, PITA)).loan.perk, 'gm');
  lair.planOf = planOf;
});

test('1.1, 1.4: the staff slot: anyone on the team takes any library game home, one at a time, with no plan', async () => {
  const got = ok(await scan(CATAN, BEN));
  assert.deepEqual([got.result, got.message, got.loan.perk, got.loan.lent, got.library.plan, got.library.perk.free], ['borrowed', W.borrowedStaff('Catan'), 'staff', true, null, false]);
  assert.equal(said(await scan(AZUL, BEN)), `409 ${W.slotFullStaff('Catan')}`);
  assert.equal(said(await scan(MOTHERSHIP, BEN)), `409 ${W.slotFullStaff('Catan')}`);
  // an RPG book is any library game too, and the main account has the slot as well
  assert.equal(ok(await scan(MOTHERSHIP, OWNER)).loan.perk, 'staff');
  assert.equal(said(await scan(VAULT, ANA)), '422 The Vault of Secrets stays in the Lair, so it can\'t go home. Play it at your table instead.');
});

test('1.1: one slot a person: a GM who joins the team with a perk book at home has their one slot in use, and the staff slot covers it', async () => {
  await listFor(RANGI);
  ok(await scan(MOTHERSHIP, RANGI));
  ok(await call('POST', 'team', { customerId: RANGI, perms: ['checkin'] }, OWNER));
  const mine = (await me(RANGI)).library;
  assert.deepEqual([mine.perk.kind, mine.perk.free, mine.atHome.map((l) => [l.title, l.perk, l.perkEnded])], ['staff', false, [['Mothership', 'gm', false]]]);
  assert.equal(said(await scan(CATAN, RANGI)), `409 ${W.slotFullStaff('Mothership')}`);
});

test('1.4: two scans at the same moment take one book, not two', async () => {
  await listFor(RANGI);
  const both = await Promise.all([scan(MOTHERSHIP, RANGI), scan(BLADES, RANGI)]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  assert.equal(loansOf(RANGI).length, 1);
});

test('1.4, 3.3: at the staff desk a perk takes it first too; with the slot in use and no plan it is lent, as before', async () => {
  await listFor(RANGI);
  assert.equal((await desk(MOTHERSHIP, RANGI, BEN)).status, 403, 'the desk needs Library');
  const out = ok(await desk(MOTHERSHIP, RANGI, ANA));
  assert.deepEqual([out.perk, out.lent, out.notice, out.loan.perk, out.loan.perkEnded, out.loan.name], ['gm', true, null, 'gm', false, 'Rangi Hohaia']);
  const lent = ok(await desk(BLADES, RANGI, ANA));
  assert.deepEqual([lent.perk, lent.lent, lent.loan.perk], [null, true, null], 'lent outside any plan or perk, as staff always could');
  // a board game for a GM with no plan: lent, not the perk
  await listFor(WIREMU, { tables: ['B2'] });
  assert.deepEqual([ok(await desk(CATAN, WIREMU, ANA)).perk, (await perkOf(WIREMU)).free], [null, true]);
  // a plan member with the perk: the RPG book goes on the perk, and the plan stays empty
  await listFor(SAM, { tables: ['B3'] });
  const sams = ok(await desk(PHB, SAM, ANA));
  assert.deepEqual([sams.perk, sams.lent, (await me(SAM)).library.used], ['gm', true, 0]);
  // someone on the team, at the desk: their staff slot
  assert.equal(ok(await desk(AZUL, BEN, ANA)).perk, 'staff');
  // and a game that stays in the Lair is refused for everyone
  assert.equal((await desk(VAULT, WIREMU, ANA)).status, 422);
});

/* ---------------- when a perk ends with a game at home (1.5) ---------------- */

test('1.5: when the perk rests with a book at home, nothing is taken back: it is marked, the email asks for it, and one more asks a week on', async () => {
  const mail = captureEmails();
  const s = await weekly(RANGI);
  ok(await scan(MOTHERSHIP, RANGI));
  await mail.all();
  nowIs(after(s[2]));
  await run();
  const rest = (await mail.all()).filter((m) => m.to === emailOf(RANGI));
  assert.deepEqual(rest.map((m) => m.subject), ['Your GM perk is having a rest']);
  assert.match(rest[0].text, /Mothership/);
  assert.match(rest[0].text, /bring it back/i);
  const mine = (await me(RANGI)).library;
  assert.deepEqual([mine.perk.status, mine.perk.free, mine.atHome.map((l) => [l.title, l.perk, l.perkEnded])], ['resting', false, [['Mothership', 'gm', true]]]);
  const staffs = ok(await call('GET', 'library/loans', null, ANA)).loans;
  assert.deepEqual(staffs.map((l) => [l.title, l.perk, l.perkEnded, l.lent]), [['Mothership', 'gm', true, true]]);
  // six days on: nothing more
  nowIs(after(s[2]) + 6 * DAY);
  await run();
  assert.deepEqual(await mail.to(RANGI), []);
  // seven days on: one more ask
  nowIs(after(s[2]) + 7 * DAY);
  await run();
  assert.deepEqual(await mail.to(RANGI), ['Could you bring Mothership back?']);
  nowIs(after(s[2]) + 20 * DAY);
  await run();
  assert.deepEqual(await mail.to(RANGI), [], 'once');
});

test('1.5: a book that came back within the week is never asked for again, and staff taking a perk emails nobody', async () => {
  const mail = captureEmails();
  const s = await weekly(RANGI);
  ok(await scan(MOTHERSHIP, RANGI));
  nowIs(after(s[2]));
  await run();
  ok(await back(MOTHERSHIP));
  await mail.all();
  nowIs(after(s[2]) + 8 * DAY);
  await run();
  assert.deepEqual(await mail.to(RANGI), []);
  // Wiremu has a book at home when staff take his perk: marked, and no email at all
  await listFor(WIREMU, { tables: ['B2'], start: at('2026-12-21', 18), end: at('2026-12-21', 22) });
  ok(await scan(BLADES, WIREMU));
  await mail.all();
  ok(await take(WIREMU));
  nowIs(Date.now() + 9 * DAY);
  await run();
  assert.deepEqual(await mail.to(WIREMU), []);
  assert.deepEqual((await me(WIREMU)).library.atHome.map((l) => [l.title, l.perkEnded]), [['Blades in the Dark', true]]);
});

/* ---------------- a game's books (1.6, 3.5 to 3.7) ---------------- */

test('3.5: the picker lists the RPG shelf\'s books from the catalogue: every word of the search, A to Z, 12 at most, logged in', async () => {
  assert.equal((await call('GET', 'library/books?q=dark')).status, 401);
  const find = async (q) => ok(await call('GET', `library/books${q === null ? '' : `?q=${encodeURIComponent(q)}`}`, null, RANGI)).books;
  assert.deepEqual(await find('dark'), [{
    variantId: BLADES.variantId, productId: BLADES.productId, title: 'Blades in the Dark', handle: BLADES.handle, shelfCode: 'DGLRPG-002', image: null, copies: 1,
  }]);
  assert.deepEqual((await find('THE in')).map((b) => b.title), ['Blades in the Dark'], 'every word, any case');
  assert.deepEqual((await find('kids')).map((b) => b.title), ['Kids on Brooms'], 'tagged for the shelf');
  assert.deepEqual(await find('catan'), [], 'not a board game');
  assert.deepEqual(await find('old edition'), [], 'not one that has gone from the shelf');
  assert.deepEqual((await find(null)).map((b) => b.title), ['Blades in the Dark', 'Call of Cthulhu', 'Kids on Brooms', 'Mothership', "Player's Handbook", 'The Vault of Secrets']);
  assert.equal((await find('cthulhu'))[0].copies, 2);
  // a tag that only looks like the shelf's doesn't make a listing one of its books
  lair.sql.exec("INSERT INTO pick_catalog (product_id, variant_id, title, shelf_code, tags, status) VALUES ('8900', '7900', 'Rack of Dice', 'DGL34-S090', ?, 'active')", JSON.stringify(['Shelf RPG books (sold)']));
  assert.deepEqual(await find('rack'), []);
  for (let n = 1; n <= 14; n += 1) {
    lair.sql.exec("INSERT INTO pick_catalog (product_id, variant_id, title, shelf_code, tags, status) VALUES (?, ?, ?, ?, '[]', 'active')", `86${n}`, `76${n}`, `Zine ${String(n).padStart(2, '0')}`, `DGLRPG-1${n}`);
  }
  assert.equal((await find('zine')).length, 12);
  assert.equal((await find('')).length, 12);
});

test('3.11: the floor tells the website this Lair knows a game\'s books, so Run a game shows its picker', async () => {
  for (const who of ['', RANGI, OWNER]) assert.equal(ok(await call('GET', 'floor', null, who)).features.books, true, who || 'logged out');
});

test('1.6, 3.6: Run a game takes up to 3 library books, by variant or product id, checked before anything is saved', async () => {
  const before = lair.sql.exec('SELECT COUNT(*) AS n FROM games').one().n;
  const tryWith = (books) => call('POST', 'games', { ...details(RANGI), gmCustomerId: RANGI, gmCustomerName: NAMES[RANGI], gmEmail: emailOf(RANGI), books }, OWNER);
  assert.equal(said(await tryWith('7001')), `422 ${W.booksList}`);
  assert.equal(said(await tryWith([PHB.variantId, BLADES.variantId, MOTHERSHIP.variantId, CTHULHU.variantId])), `422 ${W.booksMax}`);
  assert.equal(said(await tryWith([CATAN.variantId])), `422 ${W.bookUnknown}`);
  assert.equal(said(await tryWith([GONE.variantId])), `422 ${W.bookUnknown}`);
  assert.equal(said(await tryWith(['123456'])), `422 ${W.bookUnknown}`);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM games').one().n, before, 'nothing was listed');
  assert.equal(perkRow(RANGI), null);
  // a product id, a variant id as a number, and the same book twice
  const made = ok(await tryWith([PHB.productId, Number(BLADES.variantId), PHB.variantId]));
  assert.deepEqual(made.game.books, [
    { variantId: PHB.variantId, productId: PHB.productId, title: "Player's Handbook", handle: PHB.handle, shelfCode: 'DGLRPG-001', image: null, copies: 1, out: 0, withYou: false },
    { variantId: BLADES.variantId, productId: BLADES.productId, title: 'Blades in the Dark', handle: BLADES.handle, shelfCode: 'DGLRPG-002', image: null, copies: 1, out: 0, withYou: false },
  ]);
  // the GM takes one home: their own view of the game says it's with them
  ok(await scan(PHB, RANGI));
  ok(await desk(BLADES, MIA));
  const mine = (await me(RANGI)).games.find((g) => g.id === made.game.id);
  assert.deepEqual(mine.books.map((b) => [b.title, b.out, b.withYou]), [["Player's Handbook", 1, true], ['Blades in the Dark', 1, false]]);
  // a game with no books lists none, and a book that stays in the Lair can be named (it never leaves)
  assert.deepEqual((await listFor(WIREMU, { tables: ['B2'] })).game.books, []);
  assert.equal(ok(await call('POST', 'games', { ...details(HANA, { tables: ['B3'] }), books: [VAULT.variantId] }, HANA)).game.books[0].title, 'The Vault of Secrets');
});

test('1.6: the books are every session\'s: a weekly game\'s sessions all name them, and so do the ones the series adds later and a date its GM adds', async () => {
  const made = await listFor(RANGI, { schedule: 'weekly', books: [PHB.variantId] });
  const booksOf = (gameId) => lair.sql.exec('SELECT title FROM game_books WHERE game_id = ? ORDER BY position', gameId).toArray().map((r) => r.title);
  assert.ok(made.sessions.length >= 8);
  for (const s of made.sessions) assert.deepEqual(booksOf(s.id), ["Player's Handbook"]);
  // a week on, the series adds the next session at the horizon: it names the book too
  nowIs(NOW + 7 * DAY);
  lair.extendSeries(lair.rulesCache, Date.now());
  const all = lair.sql.exec('SELECT id FROM games WHERE series_id = ? ORDER BY starts_at', made.game.seriesId).toArray();
  assert.equal(all.length, made.sessions.length + 1);
  assert.deepEqual(booksOf(all[all.length - 1].id), ["Player's Handbook"]);
  // one session swapping its book doesn't change the game's: the next session the series adds names the game's own
  const swapped = all[all.length - 1].id;
  ok(await call('POST', `games/${swapped}/books`, { books: [BLADES.variantId], scope: 'session' }, RANGI));
  nowIs(NOW + 14 * DAY);
  lair.extendSeries(lair.rulesCache, Date.now());
  const then = lair.sql.exec('SELECT id FROM games WHERE series_id = ? ORDER BY starts_at', made.game.seriesId).toArray();
  assert.equal(then.length, all.length + 1);
  assert.deepEqual([booksOf(swapped), booksOf(then[then.length - 1].id)], [['Blades in the Dark'], ["Player's Handbook"]]);
  // a one-off whose GM adds a date (it becomes a flexible game): the new date names the book
  nowIs(NOW);
  const one = await listFor(WIREMU, { tables: ['B2'], books: [BLADES.variantId, MOTHERSHIP.variantId] });
  const added = ok(await call('POST', `games/${one.game.id}/sessions`, { start: at('2026-11-25', 18), end: at('2026-11-25', 22) }, WIREMU));
  assert.deepEqual(booksOf(added.game.id), ['Blades in the Dark', 'Mothership']);
});

test('1.6, 3.7: a GM changes their game\'s books later: this and every later session by default, or this session only; nobody else\'s game', async () => {
  const s = await weekly(RANGI);
  const booksOf = (gameId) => lair.sql.exec('SELECT title FROM game_books WHERE game_id = ? ORDER BY position', gameId).toArray().map((r) => r.title);
  assert.deepEqual(ok(await call('GET', `games/${s[1].id}/books`, null, RANGI)), { books: [], scope: 'series' });
  assert.equal(said(await call('GET', `games/${s[1].id}/books`, null, MIA)), `403 ${W.booksOwn}`);
  assert.equal(said(await call('POST', `games/${s[1].id}/books`, { books: [PHB.variantId] }, WIREMU)), `403 ${W.booksOwn}`);
  assert.equal(said(await call('POST', 'games/nope/books', { books: [] }, RANGI)), '404 Game not found.');
  assert.equal(said(await call('POST', `games/${s[1].id}/books`, { books: [CATAN.variantId] }, RANGI)), `422 ${W.bookUnknown}`);
  // from the second session on
  const set = ok(await call('POST', `games/${s[1].id}/books`, { books: [PHB.variantId] }, RANGI));
  assert.deepEqual([set.books.map((b) => b.title), set.sessions], [["Player's Handbook"], s.length - 1]);
  assert.deepEqual([booksOf(s[0].id), booksOf(s[1].id), booksOf(s[s.length - 1].id)], [[], ["Player's Handbook"], ["Player's Handbook"]]);
  // and the series keeps them for the sessions it adds
  nowIs(NOW + 7 * DAY);
  lair.extendSeries(lair.rulesCache, Date.now());
  const newest = () => lair.sql.exec('SELECT id FROM games WHERE series_id = (SELECT series_id FROM games WHERE id = ?) ORDER BY starts_at DESC LIMIT 1', s[0].id).one().id;
  const last = newest();
  assert.deepEqual(booksOf(last), ["Player's Handbook"]);
  // (the game's own, even when its latest session has swapped to another book)
  ok(await call('POST', `games/${last}/books`, { books: [MOTHERSHIP.variantId], scope: 'session' }, RANGI));
  nowIs(NOW + 14 * DAY);
  lair.extendSeries(lair.rulesCache, Date.now());
  assert.notEqual(newest(), last);
  assert.deepEqual([booksOf(last), booksOf(newest())], [['Mothership'], ["Player's Handbook"]]);
  nowIs(NOW + 7 * DAY);
  // one session only: staff with GM games swap the book for the third session
  const once = ok(await call('POST', `games/${s[2].id}/books`, { books: [BLADES.variantId], scope: 'session' }, CAL));
  assert.equal(once.sessions, 1);
  assert.deepEqual([booksOf(s[1].id), booksOf(s[2].id), booksOf(s[3].id)], [["Player's Handbook"], ['Blades in the Dark'], ["Player's Handbook"]]);
  // none at all
  assert.deepEqual(ok(await call('POST', `games/${s[3].id}/books`, { books: [], scope: 'session' }, RANGI)).books, []);
  assert.deepEqual(booksOf(s[3].id), []);
  // a cancelled game's books can't change
  ok(await cancel(s[4].id, RANGI));
  assert.equal(said(await call('POST', `games/${s[4].id}/books`, { books: [PHB.variantId], scope: 'session' }, RANGI)), `409 ${W.booksCancelled}`);
  // a one-off's scope is the session
  nowIs(NOW);
  const one = await listFor(WIREMU, { tables: ['B2'] });
  assert.equal(ok(await call('GET', `games/${one.game.id}/books`, null, WIREMU)).scope, 'session');
});

/* ---------------- who wants a book, and who is told (1.7, 3.3, 3.4) ---------------- */

test('1.6, 1.7, 3.4: naming a book reserves nothing: the copy is free to hold and borrow; its page says which sessions want it, soonest first, 3 at most', async () => {
  const s = await weekly(RANGI, { title: 'The Ember Road', books: [PHB.variantId] });
  const page = await status(PHB, MIA);
  assert.deepEqual([page.copies, page.held, page.out, page.available], [1, 0, 0, 1], 'nothing is held or out');
  assert.deepEqual(page.wanted, [0, 1, 2].map((n) => ({ at: s[n].start, until: s[n].start + 4 * HOUR, title: 'The Ember Road', mine: false })));
  assert.equal(page.wantedMore, s.length - 3);
  assert.deepEqual((await status(PHB, RANGI)).wanted.map((w) => w.mine), [true, true, true], 'its GM sees they are their own');
  assert.deepEqual([(await status(BLADES)).wanted, (await status(BLADES)).wantedMore], [[], 0]);
  // another table wants it sooner: soonest first across games
  await listFor(WIREMU, { tables: ['B2'], title: 'Dragon Heist', start: at('2026-11-17', 18), end: at('2026-11-17', 22), books: [PHB.variantId] });
  assert.deepEqual((await status(PHB)).wanted.map((w) => w.title), ['Dragon Heist', 'The Ember Road', 'The Ember Road']);
  // a session that's over, one that's cancelled and one waiting for approval don't want anything
  ok(await cancel(s[1].id, RANGI));
  TAGS[HANA] = [];
  ok(await call('POST', 'games', { ...details(HANA, { tables: ['B3'], start: at('2026-11-16', 18), end: at('2026-11-16', 22), title: 'Waiting' }), books: [PHB.variantId] }, HANA));
  nowIs(at('2026-11-18', 22, 1));
  assert.deepEqual((await status(PHB)).wanted.map((w) => [w.title, w.at]), [['The Ember Road', s[2].start], ['The Ember Road', s[3].start], ['The Ember Road', s[4].start]]);
});

test('1.7: a private game wants its book too, but only its GM and staff see its name', async () => {
  const made = await listFor(RANGI, { title: 'The Secret Campaign', private: true, books: [MOTHERSHIP.variantId] });
  assert.equal(made.game.private, true);
  assert.deepEqual((await status(MOTHERSHIP, MIA)).wanted.map((w) => [w.title, w.mine]), [[null, false]]);
  assert.deepEqual((await status(MOTHERSHIP)).wanted.map((w) => w.title), [null], 'logged out too');
  assert.deepEqual((await status(MOTHERSHIP, RANGI)).wanted.map((w) => [w.title, w.mine]), [['The Secret Campaign', true]]);
  assert.deepEqual((await status(MOTHERSHIP, ANA)).wanted.map((w) => w.title), ['The Secret Campaign']);
  // whoever borrows it is told a private game wants it, without its name
  await listFor(WIREMU, { tables: ['B2'] });
  assert.equal(
    ok(await scan(MOTHERSHIP, WIREMU)).message,
    `${W.borrowedGm('Mothership')} Heads up: a private game would like this one on the table at the Lair on Wed 18 Nov, 6pm. Take it by all means, and bring it back by then if you can.`,
  );
});

test('1.7, 3.3: whoever takes a wanted book is told there and then, in My Library and at the desk, and it never stops the loan', async () => {
  const s = await weekly(RANGI, { title: 'The Ember Road', books: [PHB.variantId, BLADES.variantId] });
  // Sam, on a plan, scans it
  const got = ok(await scan(PHB, SAM));
  assert.equal(got.result, 'borrowed');
  assert.equal(
    got.message,
    `Player's Handbook is yours to take home. When you're done, bring it to the counter and we'll scan it back onto the shelf. ${W.wantedLine(got.wanted, TZ, s.length - 3)}`,
  );
  assert.match(got.message, /Heads up: tables at the Lair would like this one on Wed 18 Nov, 6pm, Wed 25 Nov, 6pm, Wed 2 Dec, 6pm and \d more dates\./);
  assert.deepEqual(got.wanted.map((w) => w.at), [s[0].start, s[1].start, s[2].start]);
  assert.deepEqual(got.loan.wanted.map((w) => w.title), ['The Ember Road', 'The Ember Road', 'The Ember Road']);
  // in My Library the game at home says who wants it
  assert.deepEqual((await me(SAM)).library.atHome.map((l) => [l.title, l.wanted.length, l.wanted[0].at]), [["Player's Handbook", 3, s[0].start]]);
  // at the desk the notice tells staff
  const out = ok(await desk(BLADES, MIA, ANA));
  assert.equal(out.notice, W.wantedLine(out.loan.wanted, TZ, s.length - 3));
  assert.deepEqual(ok(await call('GET', 'library/loans', null, ANA)).loans.map((l) => [l.title, l.wanted.length, l.nudgedAt]), [["Player's Handbook", 3, null], ['Blades in the Dark', 3, null]]);
  // the game's own GM borrowing it for their table
  ok(await back(PHB));
  const own = ok(await scan(PHB, RANGI));
  assert.equal(own.message, `${W.borrowedGm("Player's Handbook")} It's down for your own game on Wed 18 Nov, 6pm: bring it along.`);
});

test('1.7, 5.3: one email to whoever has a wanted book at home, for each game that wants it, the first time; a game that names it later is told once too; never the game\'s own GM', async () => {
  const mail = captureEmails();
  await weekly(RANGI, { title: 'The Ember Road', books: [PHB.variantId] });
  ok(await scan(PHB, SAM));
  await mail.all();
  await run();
  const told = (await mail.all()).filter((m) => m.to === emailOf(SAM));
  assert.deepEqual(told.map((m) => m.subject), ["A table wants Player's Handbook on Wed 18 Nov"]);
  assert.match(told[0].text, /The Ember Road/);
  assert.match(told[0].text, /Wed 18 Nov, 6pm/);
  assert.match(told[0].text, /Wed 25 Nov, 6pm/);
  await run();
  nowIs(NOW + DAY);
  await run();
  assert.deepEqual(await mail.to(SAM), [], 'once for that game, however many sessions it has');
  // a week on the series adds its next session: the same game still, so nothing more
  nowIs(NOW + 7 * DAY);
  lair.extendSeries(lair.rulesCache, Date.now());
  await run();
  assert.deepEqual(await mail.to(SAM), [], 'not again for a session the series adds');
  nowIs(NOW + DAY);
  // another game names the book while it's out
  await listFor(WIREMU, { tables: ['B2'], title: 'Dragon Heist', start: at('2026-11-20', 18), end: at('2026-11-20', 22), books: [PHB.variantId] });
  await mail.all();
  await run();
  const again = (await mail.all()).filter((m) => m.to === emailOf(SAM));
  assert.deepEqual(again.map((m) => m.subject), ["A table wants Player's Handbook on Fri 20 Nov"]);
  assert.match(again[0].text, /Dragon Heist/);
  assert.doesNotMatch(again[0].text, /The Ember Road/, 'only the game they have not heard about');
  await run();
  assert.deepEqual(await mail.to(SAM), []);
  // a GM with the book of their own game at home hears nothing
  ok(await call('POST', `games/${(await listFor(HANA, { tables: ['B3'], title: 'Lancer nights' })).game.id}/books`, { books: [MOTHERSHIP.variantId] }, HANA));
  ok(await scan(MOTHERSHIP, HANA));
  await mail.all();
  await run();
  assert.deepEqual((await mail.all()).filter((m) => /Mothership/.test(m.subject)), []);
});

test('1.7, 5.4: one nudge when a session that wanted the book started a week ago while it was out, and it is still out', async () => {
  const mail = captureEmails();
  const made = await listFor(RANGI, { title: 'The Ember Road', books: [PHB.variantId] });
  ok(await scan(PHB, SAM));
  await run();
  await mail.all();
  // six days after the session: nothing
  nowIs(made.game.start + 6 * DAY);
  await run();
  assert.deepEqual(await mail.to(SAM), []);
  nowIs(made.game.start + 7 * DAY);
  const result = await run();
  assert.equal(result.nudged, 1);
  const nudge = (await mail.all()).filter((m) => m.to === emailOf(SAM));
  assert.deepEqual(nudge.map((m) => m.subject), ["Could you bring Player's Handbook back?"]);
  assert.match(nudge[0].text, /The Ember Road/);
  assert.match(nudge[0].text, /Wed 18 Nov/);
  assert.equal(ok(await call('GET', 'library/loans', null, ANA)).loans[0].nudgedAt, made.game.start + 7 * DAY);
  nowIs(made.game.start + 30 * DAY);
  await run();
  assert.deepEqual(await mail.to(SAM), [], 'one nudge a loan');
});

test('1.7: no nudge for a book that came back, for the borrower\'s own game, or for a session from before it went out', async () => {
  const mail = captureEmails();
  const made = await listFor(RANGI, { title: 'The Ember Road', books: [PHB.variantId, BLADES.variantId, MOTHERSHIP.variantId] });
  // Sam brings the Player's Handbook back in time
  ok(await scan(PHB, SAM));
  nowIs(made.game.start - HOUR);
  ok(await back(PHB));
  // Rangi has Blades for his own game
  ok(await scan(BLADES, RANGI));
  // Kai is lent Mothership the day after the session
  nowIs(made.game.start + DAY);
  ok(await desk(MOTHERSHIP, KAI));
  await mail.all();
  nowIs(made.game.start + 9 * DAY);
  const result = await run();
  assert.equal(result.nudged, 0);
  assert.deepEqual((await mail.all()).filter((m) => /Could you bring/.test(m.subject)), []);
});

test('1.7, 5.4: the nudge is never about the borrower\'s own game, even once another table has had its email', async () => {
  const mail = captureEmails();
  // Rangi runs a weekly game from the Player's Handbook and has it at home; Wiremu's one-off a month on names it too
  const s = await weekly(RANGI, { title: 'The Ember Road', books: [PHB.variantId] });
  await listFor(WIREMU, { tables: ['B2'], title: 'Dragon Heist', start: at('2026-12-17', 18), end: at('2026-12-17', 22), books: [PHB.variantId] });
  ok(await scan(PHB, RANGI));
  for (const n of [0, 1]) await seat(s[n].id, MIA);
  await run();
  const told = (await mail.all()).filter((m) => m.to === emailOf(RANGI) && /^A table wants/.test(m.subject));
  assert.deepEqual(told.map((m) => m.subject), ["A table wants Player's Handbook on Thu 17 Dec"]);
  // eight days after his own first session, with the book still at home: nothing about his own game
  nowIs(s[0].start + 8 * DAY);
  assert.equal((await run()).nudged, 0);
  assert.deepEqual((await mail.all()).filter((m) => /Could you bring/.test(m.subject)), []);
});

test('1.7, 5.4: the nudge is never about a session from before the book went out, even with an older loan waiting on a nudge of its own', async () => {
  const mail = captureEmails();
  // Sam has had Blades since Monday, and a game a month off wants it: his loan is waiting on a nudge of its own
  await listFor(HANA, { tables: ['B3'], title: 'Lancer nights', start: at('2026-12-17', 18), end: at('2026-12-17', 22), books: [BLADES.variantId] });
  ok(await scan(BLADES, SAM));
  // Rangi's weekly game names the Player's Handbook; Mia is lent it the day after its first session
  const s = await weekly(RANGI, { title: 'The Ember Road', books: [PHB.variantId] });
  await run();
  nowIs(s[0].start + DAY);
  ok(await desk(PHB, MIA));
  await run();
  await mail.all();
  // nine days after that first session: it started before she had the book, so it's no reason to nudge her
  nowIs(s[0].start + 9 * DAY);
  assert.equal((await run()).nudged, 0);
  assert.deepEqual((await mail.all()).filter((m) => /Could you bring/.test(m.subject)), []);
  // the session a week after she borrowed it is: one nudge, a week after that one
  nowIs(s[1].start + 7 * DAY);
  assert.equal((await run()).nudged, 1);
  const nudge = (await mail.all()).filter((m) => m.to === emailOf(MIA) && /Could you bring/.test(m.subject));
  assert.equal(nudge.length, 1);
  assert.match(nudge[0].text, /Wed 25 Nov/);
});

/* ---------------- staff's views (3.8, 3.10) ---------------- */

test('3.8: a member\'s page shows staff the perk: where it stands, quiet sessions, their last played and next sessions, the game on the slot', async () => {
  const none = ok(await call('GET', `members/${MIA}`, null, ANA)).member.perk;
  assert.deepEqual(none, { kind: null, status: 'none', source: null, since: null, reason: null, offAt: null, by: null, note: '', quiet: 0, quietMax: 3, lastPlayed: null, next: null, loan: null, log: [] });
  const s = await weekly(RANGI);
  await seat(s[0].id, MIA);
  ok(await scan(MOTHERSHIP, RANGI));
  nowIs(after(s[1]));
  await run();
  const page = ok(await call('GET', `members/${RANGI}`, null, ANA)).member.perk;
  assert.deepEqual(
    [page.kind, page.status, page.source, page.since, page.reason, page.offAt, page.by, page.note, page.quiet, page.quietMax, page.lastPlayed, page.next],
    ['gm', 'on', 'auto', NOW, null, null, null, '', 1, 3, s[0].start, s[2].start],
  );
  assert.deepEqual([page.loan.title, page.loan.perk, page.loan.name], ['Mothership', 'gm', 'Rangi Hohaia']);
  assert.deepEqual(page.log.map((l) => [l.action, l.reason, l.by]), [['on', 'listed', null]]);
  // someone on the team: the staff slot
  ok(await scan(CATAN, BEN));
  const bens = ok(await call('GET', `members/${BEN}`, null, ANA)).member.perk;
  assert.deepEqual([bens.kind, bens.status, bens.loan.title, bens.log], ['staff', 'on', 'Catan', []]);
});

test('3.10: the GM perks list for staff: on first, then resting, then off, and the team\'s slots in use', async () => {
  assert.equal(said(await call('GET', 'gm-perks', null, MIA)), '403 Staff only. Log in with your staff account.');
  assert.equal((await call('GET', 'gm-perks', null, BEN)).status, 403);
  const s = await weekly(RANGI);
  await listFor(WIREMU, { tables: ['B2'], start: at('2026-12-21', 18), end: at('2026-12-21', 22) });
  ok(await take(HANA));
  ok(await scan(MOTHERSHIP, WIREMU));
  ok(await scan(CATAN, BEN));
  nowIs(after(s[2]));
  await run();
  const list = ok(await call('GET', 'gm-perks', null, CAL));
  assert.deepEqual(list.perks.map((p) => [p.name, p.status, p.reason, p.loan?.title || null, p.log]), [
    ['Wiremu Paki', 'on', null, 'Mothership', undefined], ['Rangi Hohaia', 'resting', 'quiet', null, undefined], ['Hana Rewi', 'off', 'staff', null, undefined],
  ]);
  assert.ok(list.perks.every((p) => /^[A-Z]{2}-/.test(p.code)));
  assert.deepEqual(list.team.map((t) => [t.name, t.loan.title, t.loan.perk]), [['Ben Tane', 'Catan', 'staff']]);
});

/* ---------------- the 10-minute run (section 6) ---------------- */

test('section 6: the 10-minute run is part of the Lair\'s maintenance, asks Shopify about 10 new GMs a run, and waits when Shopify cannot say who is on the team', async () => {
  // 12 GMs with games on the board from before this round, none of them looked up yet
  const gms = [];
  for (let n = 0; n < 12; n += 1) {
    const id = `52${String(n).padStart(2, '0')}`;
    gms.push(id);
    lair.makeMember({ customerId: id, name: `Gm ${n}`, email: `gm${n}@example.com` }, NOW);
    lair.sql.exec(
      `INSERT INTO games (id, title, system, gm, gm_customer_id, tables, starts_at, ends_at, seats, status, created_at, updated_at)
       VALUES (?, ?, 'D&D 5e', ?, ?, '["T1"]', ?, ?, 4, 'open', ?, ?)`,
      `gm_old${n}`, `Old game ${n}`, `Gm ${n}`, id, at('2026-11-20', 18), at('2026-11-20', 22), NOW, NOW,
    );
  }
  lookups = [];
  const firstRun = await run();
  assert.deepEqual([firstRun.on, lookups.length], [10, 10]);
  const second = await run();
  assert.deepEqual([second.on, lookups.length], [2, 12]);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM gm_perks WHERE status = 'on'").one().n, 12);
  // Shopify can't say whether a new GM is on the team: they wait for the next run
  lair.makeMember({ customerId: '5300', name: 'Late Gm', email: 'late@example.com' }, NOW);
  lair.sql.exec(
    `INSERT INTO games (id, title, system, gm, gm_customer_id, tables, starts_at, ends_at, seats, status, created_at, updated_at)
     VALUES ('gm_late', 'Late game', 'D&D 5e', 'Late', '5300', '["T2"]', ?, ?, 4, 'open', ?, ?)`,
    at('2026-11-20', 18), at('2026-11-20', 22), NOW, NOW,
  );
  const tagged = lair.taggedPerson;
  lair.taggedPerson = async (id) => ({ customerId: id, staff: false, gm: false, tags: [], tagsFailed: true });
  assert.equal((await run()).on, 0);
  lair.taggedPerson = tagged;
  assert.equal((await run()).on, 1);
  // and the Lair's own maintenance runs it
  let ran = 0;
  const upkeep = lair.gmPerkUpkeep.bind(lair);
  lair.gmPerkUpkeep = async (now) => {
    ran += 1;
    return upkeep(now);
  };
  ok(await call('POST', 'internal/maintenance', {}, '', { 'X-Lair-Internal': '1' }));
  assert.equal(ran, 1);
});

test('section 6: Cloudflare\'s SQL limits hold with many perks, loans and wanted books at once', async () => {
  // 130 GMs with the perk on, each with a book at home that a game wants: every query of the run stays under 100 bound values
  for (let n = 0; n < 130; n += 1) {
    const id = `54${String(n).padStart(3, '0')}`;
    lair.makeMember({ customerId: id, name: `Gm ${n}`, email: `many${n}@example.com` }, NOW);
    lair.sql.exec("INSERT INTO gm_perks (customer_id, status, source, since, by, created_at, updated_at) VALUES (?, 'on', 'auto', ?, 'auto', ?, ?)", id, NOW, NOW, NOW);
    lair.sql.exec(
      `INSERT INTO library_loans (id, variant_id, product_id, title, shelf_code, customer_id, status, out_at, created_at, updated_at, lent, perk)
       VALUES (?, ?, ?, ?, ?, ?, 'out', ?, ?, ?, 1, 'gm')`,
      `ln_many${n}`, `79${n}`, `89${n}`, `Book ${n}`, `DGLRPG-9${n}`, id, NOW, NOW, NOW,
    );
  }
  const made = await listFor(RANGI);
  for (let n = 0; n < 130; n += 1) {
    lair.sql.exec("INSERT INTO game_books (game_id, variant_id, product_id, title, position, created_at) VALUES (?, ?, ?, ?, 0, ?)", made.game.id, `79${n}`, `89${n}`, `Book ${n}`, NOW);
  }
  await run();
  assert.equal(ok(await call('GET', 'library/loans', null, OWNER)).loans.filter((l) => l.wanted.length === 1).length, 130);
  assert.equal(ok(await call('GET', 'gm-perks', null, OWNER)).perks.length, 131);
  nowIs(NOW + 22 * DAY);
  const result = await run();
  assert.equal(result.rested, 131, 'every one of them is idle three weeks on, Rangi too: his one-shot came and went with nobody at it');
  assert.equal(ok(await call('GET', 'library/loans', null, OWNER)).loans.filter((l) => l.perkEnded).length, 130);
});

/* ---------------- the emails' switch and words (section 5) ---------------- */

test('section 5: GM_PERK_EMAILS = off stops every one of this round\'s emails and nothing else; switched back on, a table that still wants a book is told', async () => {
  const mail = captureEmails();
  lair.baseEnv = { ...lair.baseEnv, GM_PERK_EMAILS: 'off' };
  const s = await weekly(RANGI, { title: 'The Ember Road', books: [PHB.variantId] });
  assert.equal(perkRow(RANGI).status, 'on', 'the perk itself carries on');
  ok(await scan(PHB, SAM));
  await run();
  nowIs(after(s[2]));
  await run();
  assert.equal(perkRow(RANGI).reason, 'quiet');
  const quietly = await mail.all();
  assert.deepEqual(quietly.filter((m) => /GM perk|A table wants|Could you bring/.test(m.subject)), []);
  assert.ok(quietly.some((m) => m.subject.startsWith('Your game is live')), 'the Lair\'s other emails still go');
  // switched back on in the config table: the Lair picks it up with its next request, here the maintenance run itself
  lair.baseEnv = { ...lair.baseEnv, GM_PERK_EMAILS: '' };
  ok(await call('POST', 'internal/maintenance', {}, '', { 'X-Lair-Internal': '1' }));
  const told = (await mail.all()).filter((m) => m.to === emailOf(SAM));
  assert.deepEqual(told.map((m) => m.subject), ["A table wants Player's Handbook on Wed 9 Dec"], 'the next date it is wanted, not the ones that have been and gone');
  // the nudge about the sessions it missed never lands with that email: it waits a week from it
  nowIs(after(s[2]) + 6 * DAY);
  await run();
  assert.deepEqual(await mail.to(SAM), []);
  nowIs(after(s[2]) + 7 * DAY);
  await run();
  assert.deepEqual(await mail.to(SAM), ["Could you bring Player's Handbook back?"]);
});

test('section 5: what each email says: the perk and how to keep it; why it rests and how it comes back; and each subject fits a phone', async () => {
  const mail = captureEmails();
  const s = await weekly(RANGI, { title: 'The Ember Road' });
  const on = (await mail.all()).find((m) => m.subject.startsWith('Your GM perk is on'));
  assert.match(on.text, /Kia ora Rangi!/);
  assert.match(on.text, /The Ember Road is on the board, and GMs at the Lair get a perk: one book from the library's RPG shelf to take home at a time, free\./);
  assert.match(on.text, /Three sessions in a row with nobody at the table, or three weeks with no game, and the perk has a rest until your next game runs\./);
  assert.match(on.text, /Gobgob, the Dice Goblin/);
  assert.match(on.html, /collections\/library-rpg-books/);
  // it rests after three quiet sessions, and says how it comes back
  nowIs(after(s[2]));
  await run();
  const rest = (await mail.all()).find((m) => m.subject === 'Your GM perk is having a rest');
  assert.match(rest.text, /Your last three sessions had nobody at the table, so your GM perk is having a rest\./);
  assert.match(rest.text, /It comes back by itself as soon as a game of yours runs with players\./);
  assert.doesNotMatch(rest.text, /bring it back/, 'no book at home, nothing to ask for');
  // back, once a session of theirs has players
  await seat(s[3].id, MIA);
  nowIs(after(s[3]));
  await run();
  const back = (await mail.all()).find((m) => m.subject === 'Your GM perk is back');
  assert.match(back.text, /The Ember Road had players at the table, so your GM perk is back: one book from the library's RPG shelf to take home at a time, free\./);
  // staff giving it, and the idle rest
  ok(await give(WIREMU));
  const given = (await mail.all()).find((m) => m.to === emailOf(WIREMU));
  assert.match(given.text, /The team's switched on your GM perk: one book from the library's RPG shelf to take home at a time, free\./);
  nowIs(Date.now() + 21 * DAY);
  await run();
  const idle = (await mail.all()).find((m) => m.to === emailOf(WIREMU));
  assert.match(idle.text, /It's been three weeks with no game of yours running at the Lair, so your GM perk is having a rest\./);
  for (const subject of [on.subject, rest.subject, back.subject, "A table wants Player's Handbook on Wed 18 Nov", "Could you bring Player's Handbook back?"]) {
    assert.ok(subject.length < 50, `${subject} (${subject.length})`);
  }
});

test('section 5: a book title too long for a phone\'s subject line stays out of the subject, and in the email', async () => {
  const mail = captureEmails();
  const LONG = BOOK('7008', "Dungeons & Dragons Player's Handbook (5th Edition)", 'DGLRPG-008');
  const LONGER = BOOK('7009', 'Call of Cthulhu: Mansions of Madness Vol. 1: Behind Closed Doors', 'DGLRPG-009');
  shelve(LONG);
  shelve(LONGER);
  // a table wants one Mia has at home, and a week after its session she still has it
  const made = await listFor(RANGI, { title: 'The Ember Road', books: [LONG.variantId] });
  ok(await desk(LONG, MIA));
  await run();
  const told = (await mail.all()).find((m) => m.to === emailOf(MIA));
  assert.equal(told.subject, 'A table wants your library book on Wed 18 Nov');
  assert.match(told.text, /You've got Dungeons & Dragons Player's Handbook \(5th Edition\) at home, and The Ember Road would love it/);
  nowIs(made.game.start + 7 * DAY);
  await run();
  const nudge = (await mail.all()).find((m) => m.to === emailOf(MIA));
  assert.equal(nudge.subject, 'Could you bring your library book back?');
  assert.match(nudge.text, /The Ember Road wanted Dungeons & Dragons Player's Handbook \(5th Edition\) on the table/);
  // and a perk book still at home a week into its perk's rest
  nowIs(NOW);
  ok(await give(WIREMU));
  ok(await scan(LONGER, WIREMU));
  nowIs(NOW + 21 * DAY);
  await run();
  nowIs(NOW + 28 * DAY + HOUR);
  await run();
  const asked = (await mail.all()).filter((m) => m.to === emailOf(WIREMU)).map((m) => m.subject);
  assert.deepEqual(asked, ['Your GM perk is on: borrow an RPG book, free', 'Your GM perk is having a rest', 'Could you bring your library book back?']);
  // a title that fits is named, as before
  for (const subject of [told.subject, nudge.subject]) assert.ok(subject.length < 50, `${subject} (${subject.length})`);
});

test('section 5: someone on the team is never emailed about a GM perk, even one they had before they joined', async () => {
  const mail = captureEmails();
  const s = await weekly(RANGI);
  assert.deepEqual(await mail.to(RANGI), ['Your GM perk is on: borrow an RPG book, free']);
  ok(await scan(PHB, RANGI));
  ok(await call('POST', 'team', { customerId: RANGI, perms: ['checkin'] }, OWNER));
  // three quiet sessions rest the record underneath, and nobody's emailed; a week on, no ask for the book either
  nowIs(after(s[2]));
  await run();
  assert.equal(perkRow(RANGI).status, 'off');
  nowIs(after(s[2]) + 8 * DAY);
  await run();
  assert.deepEqual(await mail.to(RANGI), []);
});

/* ---------------- the edges ---------------- */

test('1.2, section 6: staff listing a game for a GM read their tags first, so the main account never gets a GM perk; a GM nobody has looked up waits for the run', async () => {
  // Cal (GM games) lists a game for the main account, whose tags the Lair hasn't read since it started
  lair.people.clear();
  lookups = [];
  ok(await call('POST', 'games', { ...details(OWNER), gmCustomerId: OWNER, gmCustomerName: NAMES[OWNER], gmEmail: emailOf(OWNER) }, CAL));
  assert.ok(lookups.includes(OWNER), 'their tags were read');
  assert.equal(perkRow(OWNER), null);
  // Wiremu listed his own game; the Lair restarts (nothing known about him) before staff approve it
  const own = await listOwn(WIREMU, { tables: ['B2'] });
  lair.people.clear();
  ok(await approve(own.data.game.id, CAL));
  assert.equal(perkRow(WIREMU), null, 'not known to be off the team: he waits');
  assert.equal((await run()).on, 1);
  assert.deepEqual([perkRow(WIREMU).status, perkRow(OWNER)], ['on', null]);
});

test('1.4: a library plan whose payment did not go through pauses the plan, not the perk', async () => {
  await listFor(PITA);
  const planOf = lair.planOf.bind(lair);
  lair.planOf = (...args) => ({ ...planOf(...args), blocked: true, bankCheck: false });
  const book = ok(await scan(MOTHERSHIP, PITA));
  assert.deepEqual([book.loan.perk, book.loan.lent], ['gm', true]);
  assert.equal((await scan(CATAN, PITA)).status, 402, 'a board game is the plan\'s, and the plan is paused');
  // at the desk the perk book carries no word about the plan's payment
  ok(await back(MOTHERSHIP));
  assert.equal(ok(await desk(MOTHERSHIP, PITA, ANA)).notice, null);
});

test('1.5, 3.2: a staff slot\'s game is marked once its holder leaves the team; a game that came back is never marked or wanted', async () => {
  ok(await scan(CATAN, BEN));
  assert.equal((await me(BEN)).library.atHome[0].perkEnded, false);
  ok(await call('POST', `team/${BEN}/remove`, {}, OWNER));
  const mine = (await me(BEN)).library;
  assert.deepEqual([mine.perk, mine.atHome.map((l) => [l.title, l.perk, l.perkEnded])], [null, [['Catan', 'staff', true]]]);
  assert.equal(said(await scan(AZUL, BEN)), '403 Join the library to borrow games.');
  // a perk book back on the shelf
  await listFor(RANGI, { title: 'The Ember Road', books: [MOTHERSHIP.variantId] });
  ok(await scan(MOTHERSHIP, RANGI));
  ok(await back(MOTHERSHIP));
  const page = ok(await call('GET', `members/${RANGI}`, null, ANA)).member.library;
  assert.deepEqual(page.returns.map((l) => [l.title, l.perk, l.perkEnded, l.wanted]), [['Mothership', 'gm', false, []]]);
});

test('1.7, 3.3: the heads-up is about other tables: a GM borrowing a book both their game and another want hears the other table\'s date', async () => {
  const s = await weekly(RANGI, { title: 'The Ember Road', books: [PHB.variantId] });
  await listFor(WIREMU, { tables: ['B2'], title: 'Dragon Heist', start: at('2026-11-20', 18), end: at('2026-11-20', 22), books: [PHB.variantId] });
  const got = ok(await scan(PHB, RANGI));
  assert.equal(got.message, `${W.borrowedGm("Player's Handbook")} Heads up: Dragon Heist would like this one on the table at the Lair on Fri 20 Nov, 6pm. Take it by all means, and bring it back by then if you can.`);
  assert.deepEqual(got.wanted.map((w) => [w.title, w.mine]), [['The Ember Road', true], ['Dragon Heist', false], ['The Ember Road', true]]);
  // the heads-up comes on its own too, so the page can show it apart from the rest; null when nobody else wants the game
  assert.equal(got.wantedLine, 'Heads up: Dragon Heist would like this one on the table at the Lair on Fri 20 Nov, 6pm. Take it by all means, and bring it back by then if you can.');
  assert.equal(ok(await scan(CATAN, SAM)).wantedLine, null);
  assert.ok(s.length > 3);
  // and someone staff lend it to by name is told by staff: the notice, and no email (the Lair has no account for them)
  ok(await back(PHB));
  const mail = captureEmails();
  const lent = ok(await call('POST', 'library/loans', { guest: { name: 'Walk In', mobile: '021 555 0199' }, code: PHB.shelfCode }, ANA));
  assert.match(lent.notice, /^Heads up: tables at the Lair would like this one on Wed 18 Nov, 6pm, Fri 20 Nov, 6pm, Wed 25 Nov, 6pm and \d+ more dates\./);
  await run();
  assert.deepEqual((await mail.all()).filter((m) => /A table wants/.test(m.subject)), []);
});

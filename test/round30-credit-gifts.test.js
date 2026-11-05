// Round 30: members send some of their store credit to another member (contract v30-credit). Mo (6 Nov 2026): "I want
// the clients to have the ability to gift their store credit to another." Planned since round 6 as "sending store
// credit to another member by their member code" (the dice-goblin-shop notes). Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { CREDIT_GIFT, CREDIT_GIFT_WORDS as W } from '../src/credit-gifts.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const MIN = 60_000;
// Friday 6 November 2026, 7:42pm in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 10, 6, 6, 42);
const realNow = Date.now;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const nowIs = (ms) => {
  Date.now = () => ms;
};

/* ---------------- helpers, as in the other round tests ---------------- */
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
const OWNER = '9001';
const HEMI = '9102';
const MIA = '6001';
const KAI = '6002';
const RIA = '6003';

let lair;
async function call(method, path, body, customer = '', extraHeaders = {}) {
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders },
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
const codeOf = (id) => lair.memberRow(id).code;
const check = (who, code) => call('POST', 'me/credit/gift/check', { code }, who);
let keys = 0;
const send = (who, body) => call('POST', 'me/credit/gift', { key: `gift-key-${String((keys += 1)).padStart(4, '0')}`, ...body }, who);
const gifts = async (who) => ok(await call('GET', 'me', null, who)).creditGifts;
const giftRow = (id) => ({ ...lair.sql.exec('SELECT * FROM credit_gifts WHERE id = ?', id).one() });

// A pretend Shopify store credit: each customer's balance, every change asked for, and what it does with the next one:
// null (it moves), 'short' (Shopify says there isn't enough), 'refuse' (Shopify says no), 'silent' (it moves, but the
// answer is lost) or 'lost' (nothing moves, and the answer is lost)
let balances;
let changes;
let says;
let transactions;
const realFetch = globalThis.fetch;
let reached = [];
let mails = [];
let alerts = [];

beforeEach(async () => {
  keys = 0;
  balances = new Map([[MIA, 2500], [KAI, 0], [RIA, 400]]);
  changes = [];
  says = [];
  transactions = [];
  reached = [];
  mails = [];
  alerts = [];
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <lair@dicegoblin.test>' });
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  // (My Lair asks Shopify for their account's email once a day: nobody's here)
  lair.shopify.customerEmail = async () => null;
  lair.shopify.storeCreditBalance = async (id) => balances.get(String(id)) || 0;
  lair.shopify.changeStoreCredit = async (id, cents) => {
    const how = says.shift() ?? null;
    changes.push([String(id), cents]);
    if (how === 'short' || (cents < 0 && (balances.get(String(id)) || 0) + cents < 0)) {
      throw Object.assign(new Error('Insufficient funds'), { refused: true, code: 'INSUFFICIENT_FUNDS' });
    }
    if (how === 'refuse') throw Object.assign(new Error('Account is closed'), { refused: true, code: 'ACCOUNT_CLOSED' });
    if (how === 'lost') throw new Error('The operation was aborted due to timeout');
    const after = (balances.get(String(id)) || 0) + cents;
    balances.set(String(id), after);
    const tx = { id: `gid://shopify/StoreCreditAccountTransaction/${transactions.length + 1}`, customerId: String(id), cents, at: Date.now() };
    transactions.push(tx);
    if (how === 'silent') throw new Error('The operation was aborted due to timeout');
    return { id: tx.id, balanceAfter: after };
  };
  lair.shopify.storeCreditDebits = async (id) => transactions.filter((t) => t.customerId === String(id) && t.cents < 0).reverse()
    .map((t) => ({ id: t.id, amount: -t.cents, balanceAfter: null, createdAt: t.at, fromOrder: false }));
  lair.mail = async (message) => {
    mails.push(message);
    return { ok: true };
  };
  lair.notifyStaff = (subject, content) => alerts.push({ subject, intro: content.intro });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  ok(await call('POST', 'team', { customerId: HEMI, name: 'Hemi Walker', email: 'hemi@example.com', perms: ['checkin'] }, OWNER));
  for (const [id, name] of [[MIA, 'Mia Chen'], [KAI, 'Kai Tane'], [RIA, 'Ria Moana']]) {
    lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, NOW);
  }
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 5));
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

/* ---------------- the words ---------------- */

test('round 30: the words, word for word, and the limits', () => {
  assert.deepEqual([CREDIT_GIFT.min, CREDIT_GIFT.max, CREDIT_GIFT.dayMax, CREDIT_GIFT.dayCount, CREDIT_GIFT.noteMax, CREDIT_GIFT.lookups], [100, 20000, 20000, 5, 140, 20]);
  assert.equal(W.login, 'Log in to send store credit.');
  assert.equal(W.code, "Type your friend's member code, like SJ-OWLBEAR-17. It's on their Goblin card in My Lair.");
  assert.equal(W.noMember, "There's no member with that code. Check it with your friend.");
  assert.equal(W.own, "That's your own member code. Pop in your friend's instead.");
  assert.equal(W.amount, 'Send between $1 and $200 at a time.');
  assert.equal(W.note, 'Keep the note to 140 characters.');
  assert.equal(W.key, "That didn't come through properly. Try again.");
  assert.equal(W.daily(5000), 'You can send $50.00 more today.');
  assert.equal(W.daily(0), "That's all the store credit you can send today. More can go tomorrow.");
  assert.equal(W.count, "That's 5 gifts sent today. More can go tomorrow.");
  assert.equal(W.busy, 'Your last gift is still on its way. Try again in a few minutes.');
  assert.equal(W.lookups, "That's a lot of member codes in a row. Try again in an hour.");
  assert.equal(W.off, "Store credit can't be sent right now. Try again in a minute.");
  assert.equal(W.short(400), 'You have $4.00 of store credit, so you can send $4.00 at most.');
  assert.equal(W.short(0), "You don't have any store credit to send right now.");
  assert.equal(W.shortNow, "You don't have that much store credit. Check your balance and send less.");
  assert.equal(W.notTaken('Account is closed'), "Shopify didn't take the store credit off your account (Account is closed). Nothing moved. Try again in a minute.");
  assert.equal(W.returned('Kai'), "Shopify wouldn't add it to Kai's account, so it's back on yours. Nothing's changed.");
  assert.equal(W.sent('$10.00', 'Kai'), "Sent! $10.00 is on Kai's account now.");
  assert.equal(W.checking, "Shopify didn't answer, so Gobgob's checking whether it went. It shows here within 10 minutes.");
  assert.equal(W.onItsWay('Kai'), "It came off your store credit, but Shopify hasn't said it reached Kai yet. The team's checking, so it's never sent twice.");
  assert.equal(W.notCheck, "That gift isn't waiting to be checked.");
  assert.equal(W.outcome, 'Say what happened: sent, returned or failed.');
});

/* ---------------- sending ---------------- */

test('gifts (round 30): a member sends store credit to a friend by their member code: it comes off theirs and goes on the friend\'s, once', async () => {
  // the friend's code first: Mia sees who it is before anything moves
  assert.deepEqual(ok(await check(MIA, codeOf(KAI))), { to: { name: 'Kai T.' } });
  assert.deepEqual(ok(await check(MIA, ` ${codeOf(KAI).toLowerCase()} `)).to, { name: 'Kai T.' }, 'typed any old way');
  const sent = ok(await call('POST', 'me/credit/gift', { code: codeOf(KAI), amount: 1000, note: 'For the pizza', key: 'gift-tap-0001' }, MIA));
  assert.deepEqual([sent.gift.direction, sent.gift.name, sent.gift.amount, sent.gift.note, sent.gift.status], ['sent', 'Kai T.', 1000, 'For the pizza', 'sent']);
  assert.equal(sent.balance, 1500);
  assert.equal(sent.message, W.sent('$10.00', 'Kai'));
  assert.deepEqual(changes, [[MIA, -1000], [KAI, 1000]]);
  assert.deepEqual([balances.get(MIA), balances.get(KAI)], [1500, 1000]);
  // the same tap again (an answer lost on the way back to the phone): the same gift, nothing more moves
  const again = ok(await call('POST', 'me/credit/gift', { code: codeOf(KAI), amount: 1000, note: 'For the pizza', key: 'gift-tap-0001' }, MIA));
  assert.deepEqual([again.repeated, again.gift.id, again.gift.status], [true, sent.gift.id, 'sent']);
  assert.equal(changes.length, 2);
  // both see it in My Lair: the sender as sent, the friend as received; nobody else sees it
  assert.deepEqual((await gifts(MIA)).map((g) => [g.direction, g.name, g.amount, g.note, g.status]), [['sent', 'Kai T.', 1000, 'For the pizza', 'sent']]);
  assert.deepEqual((await gifts(KAI)).map((g) => [g.direction, g.name, g.amount, g.note, g.status]), [['received', 'Mia C.', 1000, 'For the pizza', 'sent']]);
  assert.deepEqual(await gifts(RIA), []);
  // My Lair's form knows what's left to send today
  assert.deepEqual(ok(await call('GET', 'me', null, MIA)).giftCredit, { min: 100, max: 20000, left: 19000 });
  // the friend hears who it's from (with the note), and the sender gets a receipt
  assert.deepEqual(mails.map((m) => [m.to, m.subject]), [['kai@example.com', 'Mia sent you $10.00 of store credit'], ['mia@example.com', 'You sent Kai $10.00 of store credit']]);
  assert.ok(mails[0].text.includes('For the pizza'));
  assert.ok(mails[0].text.includes("Kia ora Kai, Mia just sent you $10.00 of Dice Goblin store credit."));
  assert.ok(mails[1].text.includes("Didn't send this? Reply to this email straight away and the team will look into it."));
});

test('gifts (round 30): the rules: logged in, a member\'s code that isn\'t yours, $1 to $200, a short note and a key; nothing moves when one fails', async () => {
  assert.equal(said(await check('', codeOf(KAI))), `401 ${W.login}`);
  assert.equal(said(await send('', { code: codeOf(KAI), amount: 500 })), `401 ${W.login}`);
  assert.equal(said(await check(MIA, '')), `422 ${W.code}`);
  assert.equal(said(await check(MIA, 'KT-NOSUCH-99')), `404 ${W.noMember}`);
  assert.equal(said(await check(MIA, codeOf(MIA))), `409 ${W.own}`);
  assert.equal(said(await send(MIA, { code: codeOf(MIA), amount: 500 })), `409 ${W.own}`);
  for (const amount of [0, 99, 20001, -500, 12.5, '500', null]) assert.equal(said(await send(MIA, { code: codeOf(KAI), amount })), `422 ${W.amount}`, String(amount));
  assert.equal(said(await send(MIA, { code: codeOf(KAI), amount: 500, note: 'x'.repeat(141) })), `422 ${W.note}`);
  for (const key of ['', 'short', 'has spaces in it', 'x'.repeat(65)]) assert.equal(said(await call('POST', 'me/credit/gift', { code: codeOf(KAI), amount: 500, key }, MIA)), `422 ${W.key}`, key);
  assert.deepEqual(changes, []);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM credit_gifts').one().n, 0);
  // the most and the least work
  ok(await send(MIA, { code: codeOf(KAI), amount: 100 }));
  balances.set(MIA, 50000);
  ok(await send(MIA, { code: codeOf(KAI), amount: 19900 }));
  assert.deepEqual(changes, [[MIA, -100], [KAI, 100], [MIA, -19900], [KAI, 19900]]);
});

test('gifts (round 30): up to $200 and 5 gifts a day for each sender (Lair time); tomorrow there\'s more', async () => {
  balances.set(MIA, 100000);
  ok(await send(MIA, { code: codeOf(KAI), amount: 15000 }));
  assert.equal(said(await send(MIA, { code: codeOf(RIA), amount: 6000 })), `409 ${W.daily(5000)}`);
  ok(await send(MIA, { code: codeOf(RIA), amount: 5000 }));
  assert.equal(said(await send(MIA, { code: codeOf(RIA), amount: 100 })), `409 ${W.daily(0)}`);
  // a new Lair day (midnight in Auckland, not UTC)
  nowIs(at('2026-11-07', 0, 1));
  for (let i = 0; i < 5; i += 1) ok(await send(MIA, { code: codeOf(KAI), amount: 100 }));
  assert.equal(said(await send(MIA, { code: codeOf(KAI), amount: 100 })), `409 ${W.count}`);
  // a gift that didn't go doesn't count
  nowIs(at('2026-11-08', 10));
  says.push('refuse');
  assert.equal(said(await send(MIA, { code: codeOf(KAI), amount: 20000 })), `409 ${W.notTaken('Account is closed')}`);
  ok(await send(MIA, { code: codeOf(KAI), amount: 20000 }));
});

test('gifts (round 30): not enough store credit: they hear what they have, and nothing moves', async () => {
  assert.equal(said(await send(RIA, { code: codeOf(KAI), amount: 500 })), `409 ${W.short(400)}`);
  assert.equal(said(await send(KAI, { code: codeOf(MIA), amount: 500 })), `409 ${W.short(0)}`);
  assert.deepEqual(changes, []);
  // the balance changed between Shopify's two answers (spent at the counter a moment before): Shopify says no
  lair.shopify.storeCreditBalance = async () => 5000;
  assert.equal(said(await send(RIA, { code: codeOf(KAI), amount: 500 })), `409 ${W.shortNow}`);
  assert.deepEqual(changes, [[RIA, -500]]);
  assert.deepEqual([balances.get(RIA), balances.get(KAI)], [400, 0]);
  const [gift] = await gifts(RIA);
  assert.deepEqual([gift.status, gift.amount], ['failed', 500]);
  // Shopify not reached for the balance: it's still Shopify that says no
  lair.shopify.storeCreditBalance = async () => {
    throw new Error('Shopify API error 503');
  };
  assert.equal(said(await send(RIA, { code: codeOf(KAI), amount: 500 })), `409 ${W.shortNow}`);
});

test('gifts (round 30): Shopify won\'t add it to the friend\'s account: it goes back on the sender\'s, and they hear', async () => {
  says.push(null, 'refuse');
  assert.equal(said(await send(MIA, { code: codeOf(KAI), amount: 1000 })), `409 ${W.returned('Kai')}`);
  assert.deepEqual(changes, [[MIA, -1000], [KAI, 1000], [MIA, 1000]]);
  assert.deepEqual([balances.get(MIA), balances.get(KAI)], [2500, 0]);
  const [gift] = await gifts(MIA);
  assert.equal(gift.status, 'returned');
  assert.deepEqual(await gifts(KAI), [], "nothing reached Kai, so it isn't in his list");
  assert.deepEqual(mails, [], 'no emails for a gift that came back');
});

/* ---------------- answers lost on the way ---------------- */

test('gifts (round 30): no answer taking it off: Gobgob looks in Shopify next run; it came off, so it goes on to the friend', async () => {
  says.push('silent');
  const sent = ok(await send(MIA, { code: codeOf(KAI), amount: 1000 }));
  assert.deepEqual([sent.gift.status, sent.message], ['checking', W.checking]);
  assert.deepEqual([balances.get(MIA), balances.get(KAI)], [1500, 0]);
  // a new gift waits for it
  assert.equal(said(await send(MIA, { code: codeOf(RIA), amount: 100 })), `409 ${W.busy}`);
  // the 10-minute run finds it in Mia's store credit and finishes the gift
  nowIs(NOW + 10 * MIN);
  assert.deepEqual(await lair.creditGiftUpkeep(Date.now()), { looked: 1, sent: 1 });
  assert.deepEqual([balances.get(MIA), balances.get(KAI)], [1500, 1000]);
  assert.deepEqual(changes, [[MIA, -1000], [KAI, 1000]]);
  assert.equal((await gifts(MIA))[0].status, 'sent');
  assert.equal(await lair.creditGiftUpkeep(Date.now()), null, 'done: never again');
  assert.deepEqual(mails.map((m) => m.subject), ['Mia sent you $10.00 of store credit', 'You sent Kai $10.00 of store credit']);
});

test('gifts (round 30): no answer taking it off, and it never came off: after 30 minutes it didn\'t go, and nothing moved', async () => {
  says.push('lost');
  const sent = ok(await send(MIA, { code: codeOf(KAI), amount: 1000 }));
  assert.equal(sent.gift.status, 'checking');
  nowIs(NOW + 10 * MIN);
  assert.deepEqual(await lair.creditGiftUpkeep(Date.now()), { looked: 1 });
  assert.equal((await gifts(MIA))[0].status, 'checking', 'not yet: Shopify may still show it');
  nowIs(NOW + 31 * MIN);
  assert.deepEqual(await lair.creditGiftUpkeep(Date.now()), { looked: 1, failed: 1 });
  assert.equal((await gifts(MIA))[0].status, 'failed');
  assert.deepEqual(changes, [[MIA, -1000]]);
  assert.deepEqual([balances.get(MIA), balances.get(KAI)], [2500, 0]);
  // Mia can send again
  ok(await send(MIA, { code: codeOf(KAI), amount: 1000 }));
  assert.deepEqual([balances.get(MIA), balances.get(KAI)], [1500, 1000]);
});

test('gifts (round 30): no answer adding it to the friend: staff hear and check, it\'s never sent twice, and staff say what happened', async () => {
  says.push(null, 'silent');
  const sent = ok(await send(MIA, { code: codeOf(KAI), amount: 1000 }));
  assert.deepEqual([sent.gift.status, sent.message], ['checking', W.onItsWay('Kai')]);
  assert.deepEqual(alerts.map((a) => a.subject), ['Check a store credit gift: Mia to Kai']);
  assert.ok(alerts[0].intro.startsWith("Mia sent Kai $10.00 of store credit. It came off Mia's store credit, but Shopify didn't confirm it reached Kai"));
  // the runs never send it again
  nowIs(NOW + 40 * MIN);
  await lair.creditGiftUpkeep(Date.now());
  assert.deepEqual(changes, [[MIA, -1000], [KAI, 1000]]);
  // staff with Money see it on both members' store credit, waiting to be checked
  const history = ok(await call('GET', `members/${KAI}/credit`, null, OWNER)).history;
  const row = history.find((h) => h.kind === 'gift');
  assert.deepEqual([row.amount, row.status, row.check, row.note], [1000, 'pending', true, 'Gift from Mia C.']);
  assert.equal(said(await call('POST', `credit-gifts/${row.giftId}/settle`, { outcome: 'sent' }, HEMI)), "403 That's not one of your staff permissions. Ask the main account to tick it on the Team tab.");
  assert.equal(said(await call('POST', `credit-gifts/${row.giftId}/settle`, { outcome: 'maybe' }, OWNER)), `422 ${W.outcome}`);
  // it's there in Shopify admin: the main account says so, and both see it as sent
  const settled = ok(await call('POST', `credit-gifts/${row.giftId}/settle`, { outcome: 'sent' }, OWNER));
  assert.equal(settled.gift.status, 'sent');
  assert.equal((await gifts(KAI))[0].status, 'sent');
  assert.equal(said(await call('POST', `credit-gifts/${row.giftId}/settle`, { outcome: 'sent' }, OWNER)), `409 ${W.notCheck}`);
  assert.deepEqual(changes, [[MIA, -1000], [KAI, 1000]], 'settling moves nothing');
});

test('gifts (round 30, from the review): the friend only sees a gift staff are checking when it may have reached them, not one that never went their way', async () => {
  // Shopify wouldn't add it to Kai's, and didn't answer as it went back on Mia's: staff check where it is (stage back)
  says.push(null, 'refuse', 'lost');
  ok(await send(MIA, { code: codeOf(KAI), amount: 1000 }));
  const [back] = await gifts(MIA);
  assert.equal(back.status, 'checking');
  assert.deepEqual(await gifts(KAI), [], 'Shopify said no to Kai: it never reached him');
  const kais = ok(await call('GET', `members/${KAI}/credit`, null, OWNER)).history.filter((h) => h.kind === 'gift');
  assert.deepEqual(kais, [], 'nor on his member page');
  const mias = ok(await call('GET', `members/${MIA}/credit`, null, OWNER)).history.filter((h) => h.kind === 'gift');
  assert.deepEqual(mias.map((h) => [h.amount, h.check, h.stage]), [[-1000, true, 'back']], "on Mia's, for staff to check");
  ok(await call('POST', `credit-gifts/${back.id}/settle`, { outcome: 'returned' }, OWNER));
  // the answer adding it to the friend's was lost (stage give): it may be on Kai's, so he sees it on its way
  nowIs(NOW + HOUR);
  says.push(null, 'silent');
  ok(await send(MIA, { code: codeOf(KAI), amount: 500 }));
  assert.deepEqual((await gifts(KAI)).map((g) => [g.direction, g.amount, g.status]), [['received', 500, 'checking']]);
});

/* ---------------- one at a time, lookups, notes, privacy ---------------- */

test('gifts (round 30): two taps at once send once; one still with Shopify holds the next', async () => {
  let release;
  const real = lair.shopify.changeStoreCredit;
  lair.shopify.changeStoreCredit = async (id, cents) => {
    if (!release) await new Promise((resolve) => {
      release = resolve;
    });
    return real(id, cents);
  };
  const first = send(MIA, { code: codeOf(KAI), amount: 1000 });
  for (let i = 0; i < 20 && !release; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.ok(release, 'the first is with Shopify');
  assert.equal(said(await send(MIA, { code: codeOf(RIA), amount: 500 })), `409 ${W.busy}`);
  // the same tap twice: the second answer is the first gift, still on its way
  const dupe = ok(await call('POST', 'me/credit/gift', { code: codeOf(KAI), amount: 1000, key: 'gift-key-0001' }, MIA));
  assert.deepEqual([dupe.repeated, dupe.gift.status], [true, 'checking']);
  release();
  assert.equal(ok(await first).gift.status, 'sent');
  assert.deepEqual(changes, [[MIA, -1000], [KAI, 1000]]);
});

test('gifts (round 30): looking up member codes: 20 an hour each, so nobody can trawl through them', async () => {
  for (let i = 0; i < CREDIT_GIFT.lookups; i += 1) assert.equal((await check(MIA, `KT-NOSUCH-${i}`)).status, 404);
  assert.equal(said(await check(MIA, codeOf(KAI))), `429 ${W.lookups}`);
  assert.equal(said(await send(MIA, { code: codeOf(KAI), amount: 500 })), `429 ${W.lookups}`);
  assert.equal((await check(RIA, codeOf(KAI))).status, 200, "Ria's lookups are her own");
  nowIs(NOW + HOUR + 1);
  assert.equal((await check(MIA, codeOf(KAI))).status, 200);
});

test('gifts (round 30): a note is kept as text: tags in it never become HTML in the friend\'s email', async () => {
  const note = '<img src=x onerror=alert(1)> "quoted" & </p><script>alert(2)</script>';
  ok(await send(MIA, { code: codeOf(KAI), amount: 500, note }));
  assert.equal((await gifts(KAI))[0].note, note.replace(/\s+/g, ' ').trim(), 'the words as typed (spaces tidied)');
  const html = mails[0].html;
  assert.ok(!html.includes('<img src=x') && !html.includes('<script>'), 'no tags from the note');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  // and a note's line breaks and control characters are tidied away
  ok(await send(MIA, { code: codeOf(RIA), amount: 100, note: 'Happy\nbirthday\u0000!' }));
  assert.equal((await gifts(RIA))[0].note, 'Happy birthday!');
});

test('gifts (round 30): staff with Money see gifts in a member\'s store credit; nobody else does', async () => {
  ok(await send(MIA, { code: codeOf(KAI), amount: 700, note: 'Thanks for the ride' }));
  const mias = ok(await call('GET', `members/${MIA}/credit`, null, OWNER)).history.filter((h) => h.kind === 'gift');
  assert.deepEqual(mias.map((h) => [h.amount, h.status, h.note, h.check]), [[-700, 'done', 'Gift to Kai T.: Thanks for the ride', false]]);
  const kais = ok(await call('GET', `members/${KAI}/credit`, null, OWNER)).history.filter((h) => h.kind === 'gift');
  assert.deepEqual(kais.map((h) => [h.amount, h.status, h.note]), [[700, 'done', 'Gift from Mia C.: Thanks for the ride']]);
  assert.equal((await call('GET', `members/${MIA}/credit`, null, HEMI)).status, 403);
  assert.equal((await call('GET', `members/${MIA}/credit`, null, RIA)).status, 403);
});

test('gifts (round 30): a gift left mid-way by a restart is an answer lost: taking is looked for in Shopify; giving goes to staff', async () => {
  // the Lair restarted while Shopify had them: one taking (it came off), one giving
  const old = NOW - 40 * MIN;
  transactions.push({ id: 'gid://shopify/StoreCreditAccountTransaction/77', customerId: MIA, cents: -1000, at: old + 1000 });
  balances.set(MIA, 1500);
  const insert = (id, from, to, status) => lair.sql.exec(
    "INSERT INTO credit_gifts (id, from_id, to_id, amount, currency, note, key, status, created_at, updated_at) VALUES (?, ?, ?, 1000, 'NZD', NULL, ?, ?, ?, ?)",
    id, from, to, `key-${id}-0001`, status, old, old,
  );
  insert('cg_taking', MIA, KAI, 'taking');
  insert('cg_giving', RIA, KAI, 'giving');
  assert.deepEqual(await lair.creditGiftUpkeep(NOW), { looked: 1, sent: 1, check: 1 });
  assert.deepEqual([giftRow('cg_taking').status, giftRow('cg_taking').take_tx], ['sent', 'gid://shopify/StoreCreditAccountTransaction/77']);
  assert.deepEqual(changes, [[KAI, 1000]], 'Mia\'s came off before the restart: only Kai\'s is added');
  assert.deepEqual([giftRow('cg_giving').status, giftRow('cg_giving').stage], ['check', 'give']);
  assert.deepEqual(alerts.map((a) => a.subject), ['Check a store credit gift: Ria to Kai']);
  // a debit the Lair already knows (that one) is never matched to another gift
  insert('cg_again', MIA, RIA, 'checking');
  nowIs(NOW + 31 * MIN);
  assert.deepEqual(await lair.creditGiftUpkeep(Date.now()), { looked: 1, failed: 1 });
  assert.equal(giftRow('cg_again').status, 'failed');
});

test('gifts (round 30): Shopify can\'t be read about a lost answer for 2 hours: staff look, and say what happened', async () => {
  says.push('lost');
  const sent = ok(await send(MIA, { code: codeOf(KAI), amount: 1000 }));
  lair.shopify.storeCreditDebits = async () => {
    throw new Error('Shopify API error 503');
  };
  nowIs(NOW + 10 * MIN);
  assert.deepEqual(await lair.creditGiftUpkeep(Date.now()), { looked: 1 });
  assert.deepEqual(alerts, []);
  nowIs(NOW + 2 * HOUR + MIN);
  assert.deepEqual(await lair.creditGiftUpkeep(Date.now()), { looked: 1, check: 1 });
  assert.deepEqual([giftRow(sent.gift.id).status, giftRow(sent.gift.id).stage], ['check', 'take']);
  assert.deepEqual(alerts.map((a) => a.subject), ['Check a store credit gift: Mia to Kai']);
  assert.ok(alerts[0].intro.includes("If nothing came off, tap Nothing came off."));
  // nothing came off Mia's: staff say so, and Mia can send again
  ok(await call('POST', `credit-gifts/${sent.gift.id}/settle`, { outcome: 'failed' }, OWNER));
  assert.equal((await gifts(MIA))[0].status, 'failed');
  assert.deepEqual(mails, []);
  ok(await send(MIA, { code: codeOf(KAI), amount: 1000 }));
});

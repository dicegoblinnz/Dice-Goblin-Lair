// Library lending (16 Oct 2026, Mo: "give the staff the ability to lend out a game to anyone even if they don't have an
// account it still adds to their account but no charge as they will not be subscribed but it is still evident that
// they have the game. This helps us lend out stuff to people without pressuring them to be subscribers. But reserved
// only for staff."): POST /library/loans for someone with no plan or no account (contract v16-library-lending).
// Run with: node --test test/
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair, LENDING_WORDS } from '../src/lair.js';
import { LairTime, rulesFromSettings, MOBILE_WRONG } from '../src/core.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Friday 16 October 2026, 6:51pm in Auckland (NZDT, UTC+13): when Mo asked
const NOW = Date.UTC(2026, 9, 16, 5, 51);
const realNow = Date.now;

/* ---------------- helpers (as test/round7-a.test.js) ---------------- */
function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
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
const FALLBACK = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];
const TEST_HOURS = 'Mon 16:00-24:00\nTue 16:00-24:00\nWed 16:00-24:00\nThu 16:00-24:00\nFri 16:00-24:00\nSat 10:00-24:00\nSun 10:00-22:00';
/** Library plans come from Shopify tags here: Sam has Stash (3 games); Ari has none until he joins */
const TAGS = { 1001: ['Simplee: Stash'], 1004: [], staff: ['staff'] };

let lair;
async function call(method, path, body, customer = '') {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer },
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: response.status, data: await response.json() };
}
const profile = (body, who) => call('POST', 'me/profile', body, who);
const people = async () => {
  for (const [id, name] of [['1001', 'Sam Jones'], ['1004', 'Ari Moana']]) await profile({ name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, id);
};
const lend = (body, who = 'staff') => call('POST', 'library/loans', body, who);
const scan = (code, who) => call('POST', 'library/scan', { code }, who);

/** A library copy as Shopify's LairVariantByCode gives it */
const copy = (variantId, title, code) => ({
  variantId, productId: `99${variantId}`, handle: `${title.toLowerCase().replace(/\W+/g, '-')}-library`, title: 'Default Title', productTitle: `${title} (Library)`,
  sku: code, barcode: code, price: 0, available: true, image: null, productImage: `https://cdn.shopify.com/s/files/1/${variantId}.jpg`, status: 'ACTIVE',
  giftCard: false, sellingPlan: false, libraryCode: code,
});
const GAMES = [copy('4401', 'Wingspan', 'DGL34-001'), copy('4402', 'Azul', 'DGL34-002'), copy('4403', 'Root', 'DGL34-003'), copy('4404', 'Catan', 'DGL34-004')];

/** Shopify connected: library copies found by their codes, one copy each, and an account email for whoever logs in */
function shopify(accountEmail = null) {
  Object.defineProperty(lair.shopify, 'configured', { value: true, configurable: true });
  lair.shopify.variantByCode = async (code) => GAMES.filter((v) => v.sku.toUpperCase() === code.toUpperCase());
  lair.shopify.variantCopies = async (ids) => new Map(ids.map((id) => [id, { quantity: 1, tracked: true }]));
  lair.shopify.customerEmail = async () => (accountEmail ? { email: accountEmail, verified: true } : null);
  lair.shopify.giftCodeUse = async () => null;
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
}

beforeEach(() => {
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'ep0qiq-rp.myshopify.com' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: false, tags: TAGS[id] || [] });
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '' }, FALLBACK, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
});
afterEach(() => {
  Date.now = realNow;
  TAGS[1004] = [];
});

test('lending: staff only; who it\'s for has to be clear (a member, or a name with an email or a mobile), checked before anything is looked up or lent', async () => {
  shopify();
  const said = (res) => [res.status, res.data.error];
  assert.deepEqual(said(await lend({ guest: { name: 'Wiremu Brown', email: 'wiremu@example.com' }, code: 'DGL34-001' }, '1001')), [403, 'Staff only. Log in with your staff account.']);
  assert.deepEqual(said(await lend({ code: 'DGL34-001' })), [422, LENDING_WORDS.who]);
  assert.deepEqual(said(await lend({ guest: 'Wiremu', code: 'DGL34-001' })), [422, LENDING_WORDS.who]);
  assert.deepEqual(said(await lend({ guest: { email: 'wiremu@example.com' }, code: 'DGL34-001' })), [422, LENDING_WORDS.name]);
  assert.deepEqual(said(await lend({ guest: { name: '   ' }, code: 'DGL34-001' })), [422, LENDING_WORDS.name]);
  assert.deepEqual(said(await lend({ guest: { name: 'Wiremu Brown' }, code: 'DGL34-001' })), [422, LENDING_WORDS.reach]);
  assert.deepEqual(said(await lend({ guest: { name: 'Wiremu Brown', email: 'wiremu@' }, code: 'DGL34-001' })), [422, LENDING_WORDS.email]);
  assert.deepEqual(said(await lend({ guest: { name: 'Wiremu Brown', mobile: '09 123 4567' }, code: 'DGL34-001' })), [422, MOBILE_WRONG], 'a landline');
  assert.deepEqual(said(await lend({ customerId: '4040', code: 'DGL34-001' })), [404, 'No member with that customer ID.']);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM library_loans').one().n, 0, 'nothing went out');
  assert.deepEqual(LENDING_WORDS, {
    who: "Pick the member, or add the name of who you're lending it to.",
    name: "Add the name of who you're lending it to.",
    email: "That email doesn't look right. Try one like name@example.com.",
    reach: 'Add their email or mobile, so we can reach them about the game.',
  });
});

test('lending: a game lent to someone without an account goes out under their name, email and mobile (nothing to pay), counts as out, comes back by scanning, and joins their account when they log in with that email', async () => {
  shopify('WIREMU@example.com');
  await people();
  const lent = await lend({ guest: { name: '  Wiremu   Brown ', email: 'Wiremu@Example.com', mobile: '021 555 0199' }, code: 'dgl34-001' });
  assert.equal(lent.status, 200, lent.data.error);
  const loan = lent.data.loan;
  assert.deepEqual([lent.data.lent, lent.data.notice], [true, null]);
  assert.deepEqual(
    [loan.title, loan.shelfCode, loan.status, loan.lent, loan.guest, loan.customerId, loan.name, loan.email, loan.mobile, loan.code, loan.days],
    ['Wingspan', 'DGL34-001', 'out', true, true, null, 'Wiremu Brown', 'wiremu@example.com', '021 555 0199', null, 0],
  );
  // staff see it with the games at home; the game's page counts it out, so nobody else can take the only copy
  const list = (await call('GET', 'library/loans', null, 'staff')).data.loans;
  assert.deepEqual(list.map((l) => [l.id, l.name, l.guest, l.lent]), [[loan.id, 'Wiremu Brown', true, true]]);
  const status = (await call('GET', 'library/status?ids=4401', null, '1001')).data.games['4401'];
  assert.deepEqual([status.out, status.available, status.atHome], [1, 0, null]);
  const sams = await scan('DGL34-001', '1001');
  assert.deepEqual([sams.status, sams.data.error], [409, 'Every copy of Wingspan is reserved or out on loan. Ask us at the counter.']);
  // Wiremu makes an account with that email and opens My Lair: it's at home with him, lent, using up no plan
  const WIREMU = '5005';
  const mine = (await call('GET', 'me?name=Wiremu%20Brown', null, WIREMU)).data.library;
  assert.deepEqual([mine.plan, mine.used, mine.atHome.map((l) => [l.id, l.title, l.lent])], [null, 0, [[loan.id, 'Wingspan', true]]]);
  const theirs = (await call('GET', 'library/loans', null, 'staff')).data.loans[0];
  assert.deepEqual([theirs.customerId, theirs.guest, theirs.name, theirs.email, theirs.mobile, Boolean(theirs.code)], [WIREMU, false, 'Wiremu Brown', 'wiremu@example.com', '', true]);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM library_loans WHERE customer_id = ''").one().n, 0);
  // the same game scanned in My Library is at home with him; staff scan it back onto the shelf at the counter
  const again = await scan('DGL34-001', WIREMU);
  assert.deepEqual([again.data.result, again.data.loan.id], ['at-home', loan.id]);
  const back = await call('POST', 'library/return', { code: 'DGL34-001' }, 'staff');
  assert.deepEqual([back.data.result, back.data.loan.id, back.data.loan.customerId, back.data.loan.status], ['returned', loan.id, WIREMU, 'returned']);
  // a mobile is enough to reach someone (no email: it stays a guest's, under their name)
  const byMobile = await lend({ guest: { name: 'Hana', mobile: '+64 27 555 0100' }, code: 'DGL34-002' });
  assert.deepEqual([byMobile.status, byMobile.data.loan.guest, byMobile.data.loan.email, byMobile.data.loan.mobile], [200, true, '', '+64 27 555 0100']);
  // a guest's game comes back like any other ("Back on the shelf" here), and stays in the history under their name
  const hanaBack = await call('POST', `library/loans/${byMobile.data.loan.id}/return`, null, 'staff');
  assert.deepEqual([hanaBack.status, hanaBack.data.loan.status, hanaBack.data.loan.name, hanaBack.data.loan.guest], [200, 'returned', 'Hana', true]);
  const history = (await call('GET', 'library/loans?status=all', null, 'staff')).data.loans;
  assert.deepEqual(history.map((l) => [l.title, l.name, l.guest, l.status]), [['Azul', 'Hana', true, 'returned'], ['Wingspan', 'Wiremu Brown', false, 'returned']]);
  assert.deepEqual((await call('GET', 'library/loans', null, 'staff')).data.loans, []);
  // other people never see a guest's game as theirs
  assert.deepEqual((await call('GET', 'me', null, '1001')).data.library.atHome, []);
});

test('lending: an email the Lair knows lends to that member; a member with no plan gets a lent game (no notice) that never uses up a plan they join later; a member with a plan checks games out as before', async () => {
  shopify();
  await people();
  // Ari has no plan. Staff type his email in the guest form: it's his, on his account
  const byEmail = await lend({ guest: { name: 'Ari', email: 'ARI@example.com' }, code: 'DGL34-001' });
  assert.equal(byEmail.status, 200, byEmail.data.error);
  assert.deepEqual([byEmail.data.loan.customerId, byEmail.data.loan.guest, byEmail.data.loan.name, byEmail.data.lent, byEmail.data.notice], ['1004', false, 'Ari Moana', true, null]);
  // picked from the member search: lent too, with no "isn't on a library plan" notice
  const picked = await lend({ customerId: '1004', code: 'DGL34-002' });
  assert.deepEqual([picked.data.lent, picked.data.loan.lent, picked.data.notice], [true, true, null]);
  let ari = (await call('GET', 'me', null, '1004')).data.library;
  assert.deepEqual([ari.plan, ari.used, ari.atHome.map((l) => [l.title, l.lent])], [null, 0, [['Wingspan', true], ['Azul', true]]]);
  // Ari joins Grab (1 game): the two games he was lent don't use it up, so he borrows Root, and then his plan is full
  TAGS[1004] = ['Grab - Board Game Rental'];
  ari = (await call('GET', 'me', null, '1004')).data.library;
  assert.deepEqual([ari.plan?.games, ari.used, ari.atHome.length], [1, 0, 2]);
  const root = await scan('DGL34-003', '1004');
  assert.deepEqual([root.status, root.data.result, root.data.loan.lent, root.data.library.used], [200, 'borrowed', false, 1]);
  const full = await scan('DGL34-004', '1004');
  assert.deepEqual([full.status, full.data.error], [409, "Your plan has 1 game at a time, and you've got 1: 1 at home. Return one or cancel a hold first."]);
  // if his membership ends, its emails ask for Root back, not the games he was lent
  assert.deepEqual(lair.gamesAtHome('1004'), ['Root']);
  // Sam has Stash: a check-out is one of his plan's games, as before (not lent)
  const sams = await lend({ customerId: '1001', code: 'DGL34-004' });
  assert.deepEqual([sams.status, sams.data.lent, sams.data.loan.lent, sams.data.loan.guest, sams.data.notice], [200, false, false, false, null]);
  assert.equal((await call('GET', 'me', null, '1001')).data.library.used, 1);
});

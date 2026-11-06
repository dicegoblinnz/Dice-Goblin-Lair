// Round 31, retail and shopping (contract v31-retail, section 5): free holds of things on the shelf. From the plan
// "Retail and shopping: plan", the Decision log's rules (1 Nov 2026) and Mo's picks of 6 Nov 2026 (the canvas "Retail
// and shopping: mockups": the hold sheet, My Lair's holds and the cases a hold can't happen). Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';
import { SHOP_HOLD_WORDS, SHOP_HOLD_MAX, shopHoldCalls } from '../src/shop-holds.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const MIN = 60_000;
const DAY = 24 * HOUR;
// Friday 6 November 2026, 7:42pm in Auckland (NZDT, UTC+13): the shop's open until midnight
const NOW = Date.UTC(2026, 10, 6, 6, 42);
const realNow = Date.now;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const nowIs = (ms) => {
  Date.now = () => ms;
};

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
  return { db, storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: () => {} };
}

const ROOMS = [{ id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 }];
const OWNER = '9001';
const MIA = '6001';
const KAI = '6002';
const ENV = {
  CURRENCY: 'NZD', RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <lair@dicegoblin.test>', STAFF_EMAIL: 'shop@example.com',
  GW_LOCATION_ID: '72250359911', PUBLIC_URL: 'https://lair.test',
};
const LOCATION = '72250359911';
// a booster box on the shelf, a pack, a starter deck, a card release from 2 days ago, dice from the supplier, a game
// staff switched holds off for, and one that's not sold online
const BOX = '4700000000021';
const PACK = '4700000000022';
const DECK = '4700000000011';
const FRESH = '4700000000041';
const DICE = '4700000000031';
const NOPE = '4700000000051';
const HIDDEN = '4700000000061';
const option = (variantId, productId, more = {}) => ({
  variantId, productId, title: 'Riftbound Radiance', variantTitle: 'Booster Box', handle: 'riftbound-radiance', image: null, price: 24000,
  sold: true, giftCard: false, tags: [], productType: 'Trading Card Games', vendor: 'Riot Games', publishedAt: NOW - 60 * DAY, supplier: false,
  tracked: true, shelf: 5, ...more,
});
const OPTIONS = () => new Map([
  [BOX, option(BOX, '8100000000002')],
  [PACK, option(PACK, '8100000000002', { variantTitle: 'Booster Pack', price: 1100 })],
  [DECK, option(DECK, '8100000000001', { title: 'One Piece - Starter Deck: Captain Kidd', variantTitle: '', handle: 'one-piece-captain-kidd', price: 3000 })],
  [FRESH, option(FRESH, '8100000000004', { title: 'Cyberpunk TCG - Welcome to Night City - Booster', variantTitle: 'Booster Box', publishedAt: NOW - 2 * DAY })],
  [DICE, option(DICE, '8100000000003', { title: 'Blossom Sky Dice Set', variantTitle: '', productType: 'Dice & Accessories', vendor: 'Dice Goblin NZ', supplier: true, shelf: 0 })],
  [NOPE, option(NOPE, '8100000000005', { title: 'Mooki Island', variantTitle: '', productType: 'Board Games', tags: ['No-Holds'] })],
  [HIDDEN, option(HIDDEN, '8100000000006', { title: 'Staff test', variantTitle: '', sold: false })],
]);

let lair;
let options;
let calls;
let mails;
let alerts;
let draftAnswer;
let releaseAnswer;
let beforeVariant;
let shelfAnswer;
const realFetch = globalThis.fetch;
let reached = [];

async function call(method, path, body, customer = '') {
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer },
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}
const ok = (res) => {
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
};
const said = (res) => `${res.status} ${res.data?.error || ''}`.trim();
const hold = (who, variantId, productId = options.get(variantId)?.productId) => call('POST', 'me/shop-holds', { productId, variantId }, who);

const fakeHolds = () => ({
  async holdVariant(variantId, locationId) {
    calls.push(['holdVariant', variantId, locationId]);
    if (beforeVariant) {
      const first = beforeVariant;
      beforeVariant = null;
      await first();
    }
    const v = options.get(String(variantId));
    return v ? { ...v, tags: [...v.tags] } : null;
  },
  async holdCustomer(customerId) {
    calls.push(['holdCustomer', customerId]);
    return null;
  },
  async holdDraft(input) {
    calls.push(['holdDraft', input]);
    if (draftAnswer instanceof Error) throw draftAnswer;
    return `gid://shopify/DraftOrder/${700 + calls.filter((c) => c[0] === 'holdDraft').length}`;
  },
  async holdRelease(id) {
    calls.push(['holdRelease', id]);
    if (releaseAnswer instanceof Error) throw releaseAnswer;
    return true;
  },
});

beforeEach(async () => {
  reached = [];
  calls = [];
  mails = [];
  alerts = [];
  options = OPTIONS();
  draftAnswer = null;
  releaseAnswer = null;
  beforeVariant = null;
  shelfAnswer = { ok: true };
  globalThis.fetch = async (url) => {
    reached.push(String(url));
    throw new Error(`No network in tests: ${url}`);
  };
  nowIs(NOW);
  lair = new Lair(fakeCtx(), { ...ENV });
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  Object.defineProperty(lair.shopify, 'configured', { get: () => true, configurable: true });
  lair.shopify.customerEmail = async () => null;
  lair.shopHoldApi = fakeHolds;
  lair.retail = () => ({
    async setShelf(changes, locationId, key, reference) {
      calls.push(['setShelf', changes, locationId, key, reference]);
      if (shelfAnswer instanceof Error) throw shelfAnswer;
      return shelfAnswer;
    },
  });
  lair.mail = async (message) => {
    mails.push(message);
    return { ok: true };
  };
  lair.notifyStaff = (subject, content) => alerts.push({ subject, intro: content.intro, details: content.details });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '', retail_holds: true }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  lair.makeMember({ customerId: MIA, name: 'Mia Chen', email: 'mia@example.com' }, NOW);
  lair.makeMember({ customerId: KAI, name: 'Kai Tane', email: 'kai@example.com' }, NOW);
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 5));
  Date.now = realNow;
  globalThis.fetch = realFetch;
  assert.deepEqual(reached, [], 'nothing reached for the network');
});

const drafts = () => calls.filter((c) => c[0] === 'holdDraft').map((c) => c[1]);
const released = () => calls.filter((c) => c[0] === 'holdRelease').map((c) => c[1]);
const rows = () => lair.sql.exec('SELECT id, customer_id, variant_id, status, put_back FROM shop_holds ORDER BY id').toArray();
const upkeep = async (ms) => {
  nowIs(ms);
  return lair.retailUpkeep(lair.rulesCache, ms);
};

test('free holds: the words, word for word (the canvas, H-cant and S2)', () => {
  assert.equal(SHOP_HOLD_MAX, 3);
  assert.equal(SHOP_HOLD_WORDS.full(3), "You're holding 3 things already. Collect one, or cancel one in My Lair, to hold this.");
  assert.equal(SHOP_HOLD_WORDS.paused, "Free holds are paused on your account, because 2 holds weren't collected. Ask at the counter and staff can switch them back on.");
  assert.equal(SHOP_HOLD_WORDS.gone, "Someone grabbed the last one a moment ago. Gobgob can tell you when it's back.");
  assert.equal(SHOP_HOLD_WORDS.release('Thursday 12 November'), 'Free holds start Thursday 12 November. New card releases skip holds in their first week, so everyone gets a fair go.');
});

test('free holds: kept until closing time the next day the shop is open', () => {
  const rules = lair.rulesCache;
  // Friday evening: till Saturday's close, midnight
  assert.equal(lair.shopHoldUntil(rules, NOW), at('2026-11-08', 0));
  assert.equal(lair.shopHoldUntilWords(rules, at('2026-11-08', 0)), 'midnight Saturday 7 November');
  // before Saturday's opening: Saturday's close too; during Saturday: Sunday's, 10pm
  assert.equal(lair.shopHoldUntil(rules, at('2026-11-07', 7)), at('2026-11-08', 0));
  assert.equal(lair.shopHoldUntil(rules, at('2026-11-07', 11)), at('2026-11-08', 22));
  assert.equal(lair.shopHoldUntilWords(rules, at('2026-11-08', 22)), '10pm Sunday 8 November');
  // Sunday night after the close: Monday's, midnight
  assert.equal(lair.shopHoldUntil(rules, at('2026-11-08', 23)), at('2026-11-10', 0));
});

test('free holds: a member holds the box: a draft order sets it aside until then, it\'s in My Lair, and the shop hears', async () => {
  const made = ok(await hold(MIA, BOX));
  assert.equal(made.ok, true);
  assert.deepEqual([made.hold.title, made.hold.variantTitle, made.hold.price, made.hold.until, made.hold.set], ['Riftbound Radiance', 'Booster Box', 24000, at('2026-11-08', 0), false]);
  assert.deepEqual(drafts(), [{ holdId: made.hold.id, customerId: MIA, variantId: BOX, quantity: 1, until: at('2026-11-08', 0) }]);
  assert.deepEqual(calls.find((c) => c[0] === 'holdVariant'), ['holdVariant', BOX, LOCATION]);
  const mine = ok(await call('GET', 'me/shop-holds', null, MIA));
  assert.deepEqual([mine.holds.map((h) => h.variantId), mine.max, mine.paused], [[BOX], 3, false]);
  assert.deepEqual(ok(await call('GET', 'me/shop-holds', null, KAI)).holds, [], 'only their own');
  assert.deepEqual(alerts.map((a) => a.subject), ['Hold to set aside: Riftbound Radiance: Booster Box (Mia C.)']);
  assert.equal(alerts[0].intro, 'Mia C. is holding it free until midnight Saturday 7 November, to pay at the counter. Set it aside behind the counter and tap Set aside on the staff page.');
  // staff see it on To pull, and the counter tablet counts it
  const pull = ok(await call('GET', 'staff/pull', null, OWNER));
  assert.deepEqual(pull.holds.map((h) => [h.customer, h.title, h.variantTitle, h.status, h.price]), [['Mia C.', 'Riftbound Radiance', 'Booster Box', 'new', 24000]]);
  assert.equal((await lair.posToday()).toPull, 1);
  assert.equal((await call('GET', 'staff/pull', null, MIA)).status, 403);
});

test('free holds: the ones that can\'t be, each with its words, and nothing is held', async () => {
  assert.equal(said(await hold('', BOX)), `401 ${SHOP_HOLD_WORDS.login}`);
  const cant = async (who, variantId) => {
    const answer = ok(await hold(who, variantId));
    assert.equal(answer.ok, false);
    return [answer.cant, answer.message];
  };
  assert.deepEqual(await cant(MIA, NOPE), ['noHolds', SHOP_HOLD_WORDS.noHolds], 'tagged no-holds (any case)');
  assert.deepEqual(await cant(MIA, DICE), ['notShelf', SHOP_HOLD_WORDS.notShelf], "the supplier's dice");
  assert.deepEqual(await cant(MIA, HIDDEN), ['product', SHOP_HOLD_WORDS.product], 'not sold online');
  assert.deepEqual(await cant(MIA, FRESH), ['release', 'Free holds start Wednesday 11 November. New card releases skip holds in their first week, so everyone gets a fair go.']);
  assert.equal(ok(await hold(MIA, FRESH)).startsAt, NOW + 5 * DAY);
  options.get(BOX).shelf = 0;
  assert.deepEqual(await cant(MIA, BOX), ['gone', SHOP_HOLD_WORDS.gone]);
  assert.deepEqual(drafts(), []);
  assert.deepEqual(rows(), [], 'no placeholder left behind');
  // switched off in the live theme: none
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  options.get(BOX).shelf = 5;
  assert.deepEqual(await cant(MIA, BOX), ['off', SHOP_HOLD_WORDS.off]);
  assert.deepEqual(calls.filter((c) => c[0] === 'holdVariant').length, 6, 'off: Shopify not asked');
});

test('free holds: up to 3 at a time, one of each, and two members at once for the last one', async () => {
  ok(await hold(MIA, BOX));
  assert.equal(ok(await hold(MIA, BOX)).cant, 'already');
  ok(await hold(MIA, PACK));
  ok(await hold(MIA, DECK));
  options.set('4700000000099', option('4700000000099', '8100000000009', { title: 'Catan', variantTitle: '', productType: 'Board Games' }));
  const full = ok(await hold(MIA, '4700000000099'));
  assert.deepEqual([full.cant, full.message, full.holds.length], ['full', SHOP_HOLD_WORDS.full(3), 3]);
  // Kai and someone else for the same option at the same moment: the second is told to wait, nothing doubled
  let during;
  beforeVariant = async () => {
    during = await hold(MIA, '4700000000099');
  };
  ok(await hold(KAI, '4700000000099'));
  assert.equal(ok(during).cant, 'full', 'Mia is full anyway');
  beforeVariant = async () => {
    during = await call('POST', 'me/shop-holds', { productId: '8100000000002', variantId: PACK }, OWNER);
  };
  ok(await hold(KAI, PACK));
  assert.equal(ok(during).cant, 'busy');
});

test('free holds: when Shopify says no, nothing is held and no placeholder stays', async () => {
  draftAnswer = new Error('Inventory could not be reserved');
  assert.equal(said(await hold(MIA, BOX)), `502 ${SHOP_HOLD_WORDS.shopify}`);
  assert.deepEqual(rows(), []);
  draftAnswer = null;
  ok(await hold(MIA, BOX));
  assert.equal(rows().length, 1);
});

test('free holds: a member cancels their own; one set aside goes back on the shelf by staff', async () => {
  const a = ok(await hold(MIA, BOX)).hold;
  const b = ok(await hold(MIA, DECK)).hold;
  assert.equal(said(await call('POST', 'me/shop-holds/cancel', { id: a.id }, KAI)), `404 ${SHOP_HOLD_WORDS.notFound}`, 'not someone else\'s');
  const left = ok(await call('POST', 'me/shop-holds/cancel', { id: a.id }, MIA));
  assert.deepEqual(left.holds.map((h) => h.id), [b.id]);
  assert.deepEqual(released(), ['gid://shopify/DraftOrder/701']);
  // set aside, then cancelled: staff are asked to put it back
  ok(await call('POST', 'staff/shop-holds/set', { id: b.id }, OWNER));
  ok(await call('POST', 'me/shop-holds/cancel', { id: b.id }, MIA));
  const pull = ok(await call('GET', 'staff/pull', null, OWNER));
  assert.deepEqual(pull.holds.map((h) => [h.id, h.status, h.putBack, h.closedHow]), [[b.id, 'cancelled', true, 'member']]);
  ok(await call('POST', 'staff/shop-holds/done', { id: b.id }, OWNER));
  assert.deepEqual(ok(await call('GET', 'staff/pull', null, OWNER)).holds, []);
});

test('free holds: staff set it aside, then it\'s collected; or it isn\'t on the shelf after all and the member hears', async () => {
  const a = ok(await hold(MIA, BOX)).hold;
  const set = ok(await call('POST', 'staff/shop-holds/set', { id: a.id }, OWNER));
  assert.equal(set.hold.status, 'set');
  assert.equal(said(await call('POST', 'staff/shop-holds/set', { id: a.id }, OWNER)), `409 ${SHOP_HOLD_WORDS.notNew}`);
  assert.equal(ok(await call('GET', 'me/shop-holds', null, MIA)).holds[0].set, true);
  ok(await call('POST', 'staff/shop-holds/collected', { id: a.id }, OWNER));
  assert.deepEqual(rows().map((r) => [r.status, r.put_back]), [['collected', 0]]);
  assert.deepEqual(released(), ['gid://shopify/DraftOrder/701']);
  // not on the shelf: closed, the count goes to 0 at the Lair, and Mia's told there's nothing to pay
  const b = ok(await hold(MIA, DECK)).hold;
  ok(await call('POST', 'staff/shop-holds/missing', { id: b.id }, OWNER));
  assert.deepEqual(calls.filter((c) => c[0] === 'setShelf').map((c) => [c[1], c[2]]), [[[{ variantId: DECK, quantity: 0 }], LOCATION]]);
  assert.deepEqual(mails.map((m) => [m.to, m.subject]), [['mia@example.com', "Sorry, your hold isn't on the shelf"]]);
  assert.ok(mails[0].text.includes("We went to set aside One Piece - Starter Deck: Captain Kidd for you, and it wasn't on the shelf. Our count was wrong, and that's on us."));
  assert.ok(mails[0].text.includes("Your hold's cancelled, so there's nothing to pay."));
  assert.equal(said(await call('POST', 'staff/shop-holds/missing', { id: b.id }, OWNER)), `404 ${SHOP_HOLD_WORDS.notFound}`, 'once');
  // Shopify not taking the count: staff told to set it themselves
  const c = ok(await hold(MIA, PACK)).hold;
  shelfAnswer = { errors: ['nope'] };
  assert.equal(ok(await call('POST', 'staff/shop-holds/missing', { id: c.id }, OWNER)).warning, SHOP_HOLD_WORDS.countNotSet('Riftbound Radiance: Booster Pack'));
  assert.equal((await call('POST', 'staff/shop-holds/set', { id: c.id }, MIA)).status, 403);
});

test('free holds: not collected in time ends them (set aside ones go back on the shelf); 2 of those pause holds until staff switch them back on', async () => {
  const a = ok(await hold(MIA, BOX)).hold;
  ok(await call('POST', 'staff/shop-holds/set', { id: a.id }, OWNER));
  // Saturday midnight passes
  const first = await upkeep(at('2026-11-08', 0, 5));
  assert.deepEqual(first.holds, { ended: 1, released: 0 });
  assert.deepEqual(rows().map((r) => [r.status, r.put_back]), [['ended', 1]]);
  assert.deepEqual(released(), ['gid://shopify/DraftOrder/701']);
  // a second one not collected: paused
  ok(await hold(MIA, PACK));
  await upkeep(at('2026-11-09', 0, 5));
  const paused = ok(await hold(MIA, DECK));
  assert.deepEqual([paused.cant, paused.message, paused.paused], ['paused', SHOP_HOLD_WORDS.paused, true]);
  const pull = ok(await call('GET', 'staff/pull', null, OWNER));
  assert.deepEqual(pull.paused, [{ customerId: MIA, customer: 'Mia C.', misses: 2 }]);
  ok(await call('POST', 'staff/shop-holds/resume', { customerId: MIA }, OWNER));
  assert.equal(ok(await hold(MIA, DECK)).ok, true, 'back on');
  assert.deepEqual(ok(await call('GET', 'staff/pull', null, OWNER)).paused, []);
});

test('free holds: paid at the counter with the member on the sale, it\'s collected; stock Shopify didn\'t let go is tried again', async () => {
  const a = ok(await hold(MIA, BOX)).hold;
  ok(await hold(KAI, PACK));
  assert.equal(await lair.shopHoldsFromOrder({ source_name: 'pos', customer: { id: Number(MIA) }, line_items: [{ variant_id: Number(BOX) }, { variant_id: 123 }] }), 1);
  assert.deepEqual(rows().map((r) => [r.customer_id, r.status]), [[MIA, 'collected'], [KAI, 'new']]);
  assert.equal(await lair.shopHoldsFromOrder({ source_name: 'pos', customer: { id: Number(KAI) }, line_items: [{ variant_id: Number(BOX) }] }), 0, 'not the option Kai holds');
  // a release Shopify didn't take
  releaseAnswer = new Error('timeout');
  ok(await call('POST', 'me/shop-holds/cancel', { id: rows()[1].id }, KAI));
  assert.equal(lair.sql.exec('SELECT release_due FROM shop_holds WHERE id = ?', rows()[1].id).one().release_due, 1);
  releaseAnswer = null;
  const later = await upkeep(NOW + 10 * MIN);
  assert.deepEqual(later.holds, { ended: 0, released: 1 });
  assert.equal(a.id, rows()[0].id);
});

test('free holds: Shopify\'s calls ask for what a hold needs', async () => {
  const asked = [];
  const api = shopHoldCalls({
    graphql: async (query, variables) => {
      asked.push([query.match(/(query|mutation) (\w+)/)[2], variables]);
      if (/HoldVariant/.test(query)) {
        return { productVariant: { id: `gid://shopify/ProductVariant/${BOX}`, title: 'Booster Box', price: '240.00', image: null,
          inventoryItem: { tracked: true, inventoryLevel: { quantities: [{ name: 'available', quantity: 4 }] } },
          product: { id: 'gid://shopify/Product/8100000000002', title: 'Riftbound Radiance', handle: 'riftbound-radiance', status: 'ACTIVE', onlineStoreUrl: 'https://x', publishedAt: '2026-09-01T00:00:00Z',
            productType: 'Trading Card Games', vendor: 'Riot Games', tags: ['TCG'], isGiftCard: false, featuredMedia: null, supplier: null } } };
      }
      return { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/1' }, userErrors: [] } };
    },
    deleteDraftIfOpen: async () => true,
  });
  const v = await api.holdVariant(BOX, LOCATION);
  assert.deepEqual([v.shelf, v.price, v.sold, v.publishedAt, v.variantTitle], [4, 24000, true, Date.parse('2026-09-01T00:00:00Z'), 'Booster Box']);
  await api.holdDraft({ holdId: 7, customerId: MIA, variantId: BOX, quantity: 1, until: at('2026-11-08', 0) });
  const input = asked[1][1].input;
  assert.deepEqual([input.purchasingEntity, input.lineItems, input.reserveInventoryUntil, input.tags], [
    { customerId: `gid://shopify/Customer/${MIA}` }, [{ variantId: `gid://shopify/ProductVariant/${BOX}`, quantity: 1 }], '2026-11-07T11:00:00.000Z', ['lair-hold'],
  ]);
});

/* ---------------- an empty search's "Tell us what you're after" (contract v31-retail, section 6) ---------------- */

test('requests: anyone tells the counter what they\'re after; staff see them, new first, and mark them done', async () => {
  const { REQUEST_WORDS } = await import('../src/shop-requests.js');
  const ask = (body, who = '', client = '203.0.113.7') => lair.fetch(new Request('https://lair.test/requests', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': who, 'X-Lair-Client': client }, body: JSON.stringify(body),
  })).then(async (r) => ({ status: r.status, data: await r.json() }));
  assert.deepEqual(ok(await ask({ text: '  pitch   black ', query: 'pitch black' })), { ok: true, message: REQUEST_WORDS.thanks });
  assert.deepEqual(ok(await ask({ text: 'Commander decks', email: 'Sam@Example.com' }, MIA)), { ok: true, message: REQUEST_WORDS.thanksEmail });
  assert.equal(said(await ask({ text: '' })), `422 ${REQUEST_WORDS.text}`);
  assert.equal(said(await ask({ text: 'x'.repeat(201) })), `422 ${REQUEST_WORDS.long}`);
  assert.equal(said(await ask({ text: 'dice', email: 'not an email' })), `422 ${REQUEST_WORDS.email}`);
  // a bot that fills in the hidden field: thanked, nothing kept
  assert.equal(ok(await ask({ text: 'cheap pills', website: 'https://spam.example' })).ok, true);
  const list = ok(await call('GET', 'staff/requests', null, OWNER));
  assert.deepEqual(list.requests.map((r) => [r.text, r.query, r.email, r.member, r.done]), [
    ['Commander decks', null, 'sam@example.com', 'Mia Chen', false],
    ['pitch black', 'pitch black', null, null, false],
  ]);
  assert.equal(list.waiting, 2);
  ok(await call('POST', 'staff/requests/done', { id: list.requests[1].id }, OWNER));
  const after = ok(await call('GET', 'staff/requests', null, OWNER));
  assert.deepEqual([after.waiting, after.requests.map((r) => r.done)], [1, [false, true]]);
  assert.equal((await call('GET', 'staff/requests', null, MIA)).status, 403);
  // five an hour from one address, then wait
  for (let i = 0; i < 3; i += 1) ok(await ask({ text: `more ${i}` }));
  assert.equal(said(await ask({ text: 'one too many' })), `429 ${REQUEST_WORDS.tooMany}`);
  assert.equal(ok(await ask({ text: 'from elsewhere' }, '', '198.51.100.2')).ok, true);
  // kept 180 days
  await upkeep(NOW + 181 * DAY);
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM shop_requests').one().n, 0);
});

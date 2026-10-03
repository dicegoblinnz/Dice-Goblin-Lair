// Calls to the Lair app (the Worker), with a pretend POS and a pretend network: `npm test` in pos-app.
// Nothing here reaches the real Lair app.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  checkIn,
  checkInMember,
  getToday,
  LAIR_URL,
  LairError,
  OFFLINE,
  problemFor,
  scanCode,
  shareBill,
  tabAdded,
  undoPassUse,
} from '../extensions/lair-checkin/src/lair.js';

/** @type {{ url: string, init: RequestInit }[]} */
let requests = [];

/**
 * A pretend POS (session token, connectivity) and network.
 * @param {{ status?: number, body?: unknown, token?: string | undefined, online?: boolean, fail?: boolean }} [options]
 */
function pretend(options = {}) {
  const { status = 200, online = true, fail = false } = options;
  const body = 'body' in options ? options.body : {};
  const token = 'token' in options ? options.token : 'session-token';
  requests = [];
  globalThis.shopify = /** @type {any} */ ({
    connectivity: { current: { value: { internetConnected: online ? 'Connected' : 'Disconnected' } } },
    session: { getSessionToken: async () => token },
  });
  globalThis.fetch = /** @type {any} */ (
    async (url, init) => {
      requests.push({ url: String(url), init });
      if (fail) throw new TypeError('Network request failed');
      return new Response(body === undefined ? 'oops' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }
  );
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.shopify;
});

test('GET /pos/today with the POS session token', async () => {
  pretend({ body: { day: '2026-10-03', now: 1, groups: [{ key: 'tables', rows: [] }] } });
  const today = await getToday();
  assert.equal(today.groups.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${LAIR_URL}/pos/today`);
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(requests[0].init.body, undefined);
  assert.equal(/** @type {any} */ (requests[0].init.headers).Authorization, 'Bearer session-token');
  pretend({ body: {} });
  assert.deepEqual((await getToday()).groups, [], 'a roster without groups is an empty day');
});

test('POST /pos/scan, /pos/checkin, /pos/checkin-member, /pos/share, /pos/pass-undo and /pos/tab/:id/added send what the contract says', async () => {
  pretend({ body: { ok: true } });
  await scanCode('SJ-OWLBEAR-17');
  await checkIn({ id: 'bk_sam', type: 'booking' });
  await checkIn({ id: 'bk_sam', type: 'booking', pass: 'none' });
  await checkIn({ id: 'ej_jo', type: 'join', pass: 'SJ-KIWI-4', force: true });
  await checkInMember('777');
  await shareBill({ id: 'bk_sam', type: 'booking' });
  await shareBill({ id: 'bk_sam', type: 'booking', amount: 1250 });
  await shareBill({ id: 'bk_sam', type: 'booking', amount: null });
  await undoPassUse('pu_1');
  await tabAdded('tab 1');
  assert.deepEqual(
    requests.map((r) => [r.init.method, r.url.slice(LAIR_URL.length), JSON.parse(String(r.init.body))]),
    [
      ['POST', '/pos/scan', { code: 'SJ-OWLBEAR-17' }],
      ['POST', '/pos/checkin', { id: 'bk_sam', type: 'booking' }],
      ['POST', '/pos/checkin', { id: 'bk_sam', type: 'booking', pass: 'none' }],
      ['POST', '/pos/checkin', { id: 'ej_jo', type: 'join', pass: 'SJ-KIWI-4', force: true }],
      ['POST', '/pos/checkin-member', { customerId: '777' }],
      ['POST', '/pos/share', { id: 'bk_sam', type: 'booking' }],
      ['POST', '/pos/share', { id: 'bk_sam', type: 'booking', amount: 1250 }],
      ['POST', '/pos/share', { id: 'bk_sam', type: 'booking' }],
      ['POST', '/pos/pass-undo', { useId: 'pu_1' }],
      ['POST', '/pos/tab/tab%201/added', {}],
    ],
  );
  assert.equal(/** @type {any} */ (requests[0].init.headers)['Content-Type'], 'application/json');
});

test('banners say what went wrong in plain words, with Try again only where it can help', () => {
  assert.deepEqual(problemFor(new LairError('offline', OFFLINE)), {
    title: "Can't reach the Lair app",
    message: "Check the iPad's internet and try again.",
    tone: 'critical',
    retry: true,
  });
  assert.equal(problemFor(new LairError('login', 'x')).title, 'This POS login has no access', 'no session token at all');
  assert.equal(problemFor(new LairError('login', 'x', 401)).title, "The Lair app didn't accept this POS login");
  assert.deepEqual(problemFor(new LairError('not-found', 'No booking, member or pass with that code.', 404)), {
    title: 'Not found',
    message: 'No booking, member or pass with that code.',
    tone: 'warning',
    retry: false,
  });
  assert.equal(problemFor(new LairError('refused', 'Nothing is left to pay on this one.', 409)).retry, false);
  assert.equal(problemFor(new LairError('server', 'x', 500)).retry, true);
  assert.equal(problemFor(new Error('POS said no.')).message, 'POS said no. Try again.');
});

test('offline, or the network failing, says so in plain words', async () => {
  pretend({ online: false });
  await assert.rejects(getToday(), (e) => e instanceof LairError && e.kind === 'offline' && e.message === OFFLINE);
  assert.equal(requests.length, 0, "doesn't even try");
  pretend({ fail: true });
  await assert.rejects(scanCode('SJ-OWLBEAR-17'), (e) => e instanceof LairError && e.message === "Can't reach the Lair app. Check the iPad's internet and try again.");
});

test("shows the Lair app's own message for 4xx answers", async () => {
  pretend({ status: 404, body: { error: 'No booking, member or pass with that code.' } });
  await assert.rejects(scanCode('ZZ-FLUMPH-3'), { kind: 'not-found', message: 'No booking, member or pass with that code.' });
  pretend({ status: 409, body: { error: 'This booking is for Saturday 4 October, not today.' } });
  await assert.rejects(checkIn({ id: 'bk_1', type: 'booking' }), { kind: 'refused', status: 409, message: 'This booking is for Saturday 4 October, not today.' });
  pretend({ status: 422, body: { error: "That pass has no sessions left." } });
  await assert.rejects(checkIn({ id: 'bk_1', type: 'booking', pass: 'SJ-KIWI-4' }), { kind: 'refused', message: 'That pass has no sessions left.' });
  pretend({ status: 403, body: { error: "That pass isn't yours. Ask us at the counter." } });
  await assert.rejects(checkIn({ id: 'bk_1', type: 'booking' }), { kind: 'refused', message: "That pass isn't yours. Ask us at the counter." });
  pretend({ status: 429, body: {} });
  await assert.rejects(scanCode('X'), { kind: 'busy' });
});

test('a bare "Not found" (an older Lair app without the route) gets a clearer sentence', async () => {
  pretend({ status: 404, body: { error: 'Not found' } });
  await assert.rejects(getToday(), { kind: 'not-found', message: "The Lair app doesn't have the Today list yet. It needs its latest update." });
  await assert.rejects(undoPassUse('pu_1'), { kind: 'not-found', message: 'That pass use could not be found. Undo it on the staff page, under Passes.' });
  pretend({ status: 404, body: { error: 'That pass use could not be found.' } });
  await assert.rejects(undoPassUse('pu_x'), { kind: 'not-found', message: 'That pass use could not be found.' });
});

test('login problems and server errors', async () => {
  pretend({ token: undefined });
  await assert.rejects(getToday(), { kind: 'login' });
  assert.equal(requests.length, 0);
  pretend({ status: 401, body: { error: 'Sign in to Shopify POS to use this.' } });
  await assert.rejects(getToday(), (e) => e instanceof LairError && e.kind === 'login' && e.message.includes('Sign in to Shopify POS to use this.'));
  pretend({ status: 500, body: undefined });
  await assert.rejects(getToday(), { kind: 'server', message: 'The Lair app had a problem (error 500). Try again in a minute.' });
});

// Staff and table bookings (17 Oct 2026). Mo: "I cannot cancel people's booking if someone booked in and never showed
// up it shows that table is booked out but I want to remove it manually. Even before the event. And have the option to
// write an email to them etc. that should be any normal table booking". Staff cancel any booking at any time (the
// staff page shows every day now), and POST /bookings/:id/message emails whoever made it.
// Run with: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../src/core.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
// Friday 16 October 2026, 1:00pm in Auckland (NZDT, UTC+13)
const NOW = Date.UTC(2026, 9, 16, 0, 0);
const realNow = Date.now;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const NOT_PERMITTED = "That's not one of your staff permissions. Ask the main account to tick it on the Team tab.";

function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      // as SQLite in a Durable Object: at most 100 bound values a query (Cloudflare's limit; 27 Oct 2026)
      if (bindings.length > 100) throw new Error(`too many SQL variables: ${bindings.length}`);
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
const TAMA = '9103';
const MIA = '6001';

let lair;
let sent;
async function call(method, path, body, customer = '') {
  const response = await lair.fetch(new Request(`https://lair.test/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  }));
  return { status: response.status, data: await response.json() };
}
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const ok = (res) => {
  assert.equal(res.status, 200, res.data.error);
  return res.data;
};
const book = (over = {}, who = MIA) => call('POST', 'bookings', {
  kind: 'table', tables: ['T3'], start: at('2026-10-17', 18), end: at('2026-10-17', 20), people: 2, name: 'Mia Chen', email: 'mia@example.com', phone: '021 555 0100', ...over,
}, who);
const message = (id, body, who = HEMI) => call('POST', `bookings/${id}/message`, body, who);
const board = async (who = OWNER) => ok(await call('GET', `floor?from=${at('2026-10-16', 0)}&to=${at('2026-10-20', 0)}`, null, who));

const realFetch = globalThis.fetch;
beforeEach(async () => {
  sent = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('resend')) throw new Error(`No network in tests: ${url}`);
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: Array.isArray(m.to) ? m.to[0] : m.to });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), {
    CURRENCY: 'NZD', RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test',
  });
  lair.later = (promise) => Promise.resolve(promise).catch(() => {});
  lair.taggedPerson = async (id) => {
    const person = { customerId: id || null, staff: id === OWNER, gm: false, tags: [] };
    if (id) lair.people.set(id, { at: Date.now(), person });
    return person;
  };
  Object.defineProperty(lair.shopify, 'configured', { get: () => false, configurable: true });
  lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '' }, ROOMS, []);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
  lair.makeMember({ customerId: OWNER, name: 'Mo Ashgrove', email: 'owner@example.com' }, NOW);
  for (const [id, name, perms] of [[HEMI, 'Hemi Walker', ['checkin']], [TAMA, 'Tama Rewi', ['library']]]) {
    ok(await call('POST', 'team', { customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, perms }, OWNER));
  }
  lair.makeMember({ customerId: MIA, name: 'Mia Chen', email: 'mia@example.com' }, NOW);
  sent = [];
});
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
});

test('bookings: staff email whoever made a booking, with its details; replies go to the team', async () => {
  const booking = ok(await book()).booking;
  sent = [];
  const res = ok(await message(booking.id, { subject: 'Your table tomorrow', text: 'Kia ora Mia, T3 has a wobbly leg, so we\'ve moved you to T4.' }));
  assert.deepEqual(res, { sent: 1, to: 'mia@example.com' });
  assert.equal(sent.length, 1);
  const mail = sent[0];
  assert.equal(mail.to, 'mia@example.com');
  assert.equal(mail.subject, 'Your table tomorrow');
  assert.equal(mail.reply_to, 'staff@dicegoblin.test');
  assert.ok(mail.text.includes('T3 has a wobbly leg'), mail.text);
  assert.ok(mail.text.includes(booking.ref), 'with the booking code');
  assert.ok(/Table T3/.test(mail.text));
  // the subject's made up when it's left out
  sent = [];
  ok(await message(booking.ref, { text: 'See you soon!' }, OWNER));
  assert.equal(sent[0].subject, 'Your booking at Dice Goblin on Saturday, 17 October');
});

test('bookings: who can email, and what stops it', async () => {
  const booking = ok(await book()).booking;
  assert.equal(said(await message(booking.id, { text: 'Hi' }, MIA)), '403 Staff only. Log in with your staff account.');
  assert.equal(said(await message(booking.id, { text: 'Hi' }, TAMA)), `403 ${NOT_PERMITTED}`);
  assert.equal(said(await message('bk_nope', { text: 'Hi' })), '404 Booking not found.');
  assert.equal(said(await message(booking.id, { text: '   ' })), '422 Write a message first.');
  // a walk-in with no email: call them
  const walkin = ok(await call('POST', 'bookings', { kind: 'walkin', tables: ['T5'], start: NOW, end: NOW + 2 * HOUR, people: 2, name: 'Sam' }, OWNER)).booking;
  assert.equal(said(await message(walkin.id, { text: 'Hi' })), '422 This booking has no email address.');
  // ten a day
  for (let i = 0; i < 10; i += 1) ok(await message(booking.id, { text: `Note ${i}` }));
  assert.equal(said(await message(booking.id, { text: 'One more' })), "429 That's 10 emails about this booking today. Try again tomorrow.");
  Date.now = () => NOW + 25 * HOUR;
  ok(await message(booking.id, { text: 'Next day' }));
  // emails not set up
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: '' };
  await lair.useConfig();
  assert.equal(said(await message(booking.id, { text: 'Hi' })), "503 Emails aren't set up yet, so messages can't go out. Call them instead.");
});

test('bookings: staff cancel a booking any time, even after it should have started, and the table is free; they can still email them', async () => {
  const booking = ok(await book({ start: at('2026-10-16', 17), end: at('2026-10-16', 20), tables: ['T4'] })).booking;
  // 6pm: they haven't come
  Date.now = () => at('2026-10-16', 18);
  const before = (await board()).bookings.find((b) => b.id === booking.id);
  assert.equal(before.status, 'confirmed');
  ok(await call('POST', `bookings/${booking.id}/update`, { status: 'cancelled' }, HEMI));
  const after = (await board()).bookings.find((b) => b.id === booking.id);
  assert.equal(after.status, 'cancelled');
  // the table's free for someone else now
  const walkin = await call('POST', 'bookings', { kind: 'walkin', tables: ['T4'], start: Date.now(), end: Date.now() + HOUR, people: 2, name: 'Walk-in' }, OWNER);
  assert.equal(walkin.status, 200, JSON.stringify(walkin.data));
  sent = [];
  ok(await message(booking.id, { text: 'We gave your table away, sorry. Book again any time!' }));
  assert.ok(sent[0].text.includes('Cancelled'), 'the email says it was cancelled');
});

// Round 37 (contract v37-changes, section 5): the emails as the Lair app writes them, saved as HTML and text for a
// look before they're switched on (Mo approves each new email's words). Nothing is sent: Resend is a stand-in.
//  1. A table's confirmation, with its new last line ("Numbers changed? Update them in My Lair by then too.")
//  2. "Your booking's changed": nine became six, a table went back
//  3. "New time": a GM moved one session (a player's, and the team's "Moved by its GM")
//  4. "New day and time": a GM moved this and every later session of a weekly game
//  5. The two-day reminder for a table, with the same new line
//  6. Seats booked for friends: "Your booking's changed" (three seats became two), and what their GM gets
//  7. A sign-up with friends on it: "Your booking's changed" (three people became two)
// Usage: node tools/qa/round37-changes/emails.mjs [out dir]   (then open the .html files, or shots.mjs for pictures)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Lair } from '../../../src/lair.js';
import { LairTime, rulesFromSettings, DEFAULT_HOURS } from '../../../src/core.js';

const OUT = process.argv[2] || path.join(os.tmpdir(), 'dg-round37-emails');
fs.mkdirSync(OUT, { recursive: true });
const time = new LairTime('Pacific/Auckland');
const HOUR = 3_600_000;
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// Saturday 14 November 2026, 9:00am in Auckland
let clock = at('2026-11-14', 9);
Date.now = () => clock;

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
const ROOMS = [
  { id: 'main-room', name: 'Main room', code: 'T', tables: 20, seats: 4, order: 1 },
  { id: 'gaming-room', name: 'Gaming room', code: 'G', tables: 4, seats: 4, order: 2 },
];
// Blood on the Clocktower as it's run: Sunday 29 November, 12pm to 6pm, $10, 40 places
const EVENTS = [{ id: 'clocktower', title: 'Blood on the Clocktower', start: time.at('2026-11-29', 12 * 60), end: time.at('2026-11-29', 18 * 60), tables: '', capacity: 40, entryFee: 1000 }];
const OWNER = '9001';
const RANGI = '5001';
const MIA = '6001';
const KAI = '6002';
let sent = [];
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('resend')) throw new Error(`No network here: ${url}`);
  const body = JSON.parse(init.body);
  for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: Array.isArray(m.to) ? m.to[0] : m.to });
  return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
};
const lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', RESEND_API_KEY: 're_preview', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.nz>', STAFF_EMAIL: 'team@example.com' });
lair.later = (promise) => Promise.resolve(promise).catch(() => {});
lair.taggedPerson = async (id) => {
  const person = { customerId: id || null, staff: id === OWNER, gm: id === RANGI, tags: [] };
  if (id) lair.people.set(id, { at: Date.now(), person });
  return person;
};
lair.shopify.orderSpend = async () => null;
lair.shopify.orderBuyer = async () => null;
Object.defineProperty(lair.shopify, 'configured', { get: () => false, configurable: true });
lair.rulesCache = rulesFromSettings({ lair_hours: DEFAULT_HOURS, lair_shop_tables: '', lair_booking_reminders: true }, ROOMS, EVENTS);
lair.rulesLoadedAt = clock + 10 * 365 * 24 * HOUR;
for (const [id, name] of [[OWNER, 'Mo Ashgrove'], [RANGI, 'Rangi Hohaia'], [MIA, 'Mia Chen'], [KAI, 'Kai Tane']]) {
  lair.makeMember({ customerId: id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }, clock);
}
async function call(method, route, body, customer = '', headers = {}) {
  const response = await lair.fetch(new Request(`https://lair.test/${route}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...headers }, body: body == null ? undefined : JSON.stringify(body),
  }));
  const data = await response.json();
  if (response.status !== 200) throw new Error(`${method} ${route}: ${response.status} ${data.error}`);
  return data;
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const saved = [];
async function keep(name, what, pick) {
  await settle();
  const mail = sent.find(pick);
  sent = [];
  if (!mail) {
    console.log(`MISSING ${name}`);
    return;
  }
  fs.writeFileSync(path.join(OUT, `${name}.html`), mail.html);
  fs.writeFileSync(path.join(OUT, `${name}.txt`), `To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}`);
  saved.push({ name, what, to: mail.to, subject: mail.subject });
  console.log(`${name}: "${mail.subject}" to ${mail.to}`);
}

// 1 and 2: Mia's table for nine, three days out, then six
const table = await call('POST', 'bookings', {
  kind: 'table', tables: ['T6', 'T7', 'T8'], start: at('2026-11-17', 18), end: at('2026-11-17', 21), people: 9, name: 'Mia Chen', email: 'mia@example.com', phone: '021 555 0100',
}, MIA);
await keep('1-confirmation', 'A table’s confirmation, with its new last line', (m) => m.to === 'mia@example.com');
await call('POST', `bookings/${table.booking.id}/update`, { people: 6, tables: ['T6', 'T7'] }, MIA);
await keep('2-booking-changed', 'Nine became six, and a table went back', (m) => m.to === 'mia@example.com');

// 5: its two-day reminder (Sunday 15 November, 9am)
clock = at('2026-11-15', 9);
await call('POST', 'internal/reminders', { at: clock }, '', { 'X-Lair-Internal': '1' }).catch((e) => console.log(String(e.message)));
await keep('5-reminder', 'The two-day reminder for a table, with the same new line', (m) => m.to === 'mia@example.com');
clock = at('2026-11-14', 9, 30);

// 3 and 4: Rangi's weekly game, Saturdays 6pm from 21 November, with Mia and Kai on the first two sessions
const listed = await call('POST', 'games', {
  title: 'Curse of Strahd', system: 'D&D 5e', gm: 'Rangi', blurb: 'Barovia is waiting.', seats: 5, tables: ['G1', 'G2'], start: at('2026-11-21', 18), end: at('2026-11-21', 22),
  email: 'rangi@example.com', schedule: 'weekly',
}, RANGI);
const ids = listed.sessions.map((s) => s.id);
for (const [who, name] of [[MIA, 'Mia'], [KAI, 'Kai']]) {
  for (const id of ids.slice(0, 2)) await call('POST', 'bookings', { kind: 'gm-seat', gameId: id, people: 1, name, email: `${name.toLowerCase()}@example.com`, phone: '021 555 0100' }, who);
}
await settle();
sent = [];
// one session, a one-off: Saturday 21 November 6pm becomes Sunday 22 November 1pm
await call('POST', `games/${ids[0]}/move`, { start: at('2026-11-22', 13), end: at('2026-11-22', 17), scope: 'session' }, RANGI);
await settle();
const moved = sent.slice();
sent = moved.filter((m) => m.to === 'mia@example.com');
await keep('3-new-time', 'A GM moved one session: what each player gets', () => true);
sent = moved.filter((m) => m.to === 'team@example.com');
await keep('3b-team', 'And what the team gets when a GM moves a session', () => true);
// this and every later session: Saturdays 6pm become Fridays 7pm, from 27 November
await call('POST', `games/${ids[1]}/move`, { start: at('2026-11-27', 19), end: at('2026-11-27', 23), scope: 'series' }, RANGI);
await keep('4-new-day', 'A GM moved this and every later session of a weekly game', (m) => m.to === 'mia@example.com');

// 6: Mia's three seats at a one-shot of Rangi's (Thursday 19 November), then Kiri can't come
const oneShot = await call('POST', 'games', {
  title: 'Goblin Kitchen Nightmares', system: 'Honey Heist', gm: 'Rangi', blurb: 'A one-shot.', seats: 5, tables: ['G3', 'G4'], start: at('2026-11-19', 18), end: at('2026-11-19', 21),
  email: 'rangi@example.com',
}, RANGI);
const three = await call('POST', 'bookings', {
  kind: 'gm-seat', gameId: oneShot.game.id, people: 3, name: 'Mia Chen', email: 'mia@example.com', phone: '021 555 0100', players: [{ name: 'Mia' }, { name: 'Kiri' }, { name: 'Jo' }],
}, MIA);
await settle();
sent = [];
await call('POST', `bookings/${three.booking.id}/update`, { people: 2, staying: [0, 2] }, MIA);
await settle();
const fewer = sent.slice();
sent = fewer.filter((m) => m.to === 'mia@example.com');
await keep('6-seats-changed', 'Three seats became two: what whoever booked them gets', () => true);
sent = fewer.filter((m) => m.to === 'rangi@example.com');
await keep('6b-gm-seat-dropped', 'And what their GM gets', () => true);

// 7: Mia's sign-up for three at Blood on the Clocktower, then Jo can't come
const signed = await call('POST', 'events/clocktower@2026-11-29/join', { name: 'Mia Chen', email: 'mia@example.com', phone: '021 555 0100', guests: [{ name: 'Kai' }, { name: 'Jo' }] }, MIA);
await settle();
sent = [];
await call('POST', `events/joins/${signed.join.id}/change`, { people: 2, staying: [0] }, MIA);
await keep('7-signup-changed', 'A sign-up for three became two', (m) => m.to === 'mia@example.com');

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(saved, null, 1));
console.log(`\nSaved to ${OUT}`);
process.exit(0);

// Round 11, reminders (contract v11-reminders): "Remind me the day before" on an event date's "I'm coming" or "Maybe",
// sent once by the maintenance run between 9am and 9pm at the Lair, and the waitlist for a full date, which tells the
// staff and the person. Mo (9 Oct 2026): "have a add to calendar option on it and possibly a reminder the day prior if
// they opt for it?" and "Maximum capacity of 40 people but if we went more let it notify us so we cns try to organize a
// new group to accommodate."
// Run with: node --test test/   (under TZ=UTC and TZ=Pacific/Auckland)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair, MIGRATIONS } from '../src/lair.js';
import { LairTime, rulesFromSettings } from '../src/core.js';
import { INTEREST_MESSAGES } from '../src/interest.js';
import { REMINDER_MESSAGES } from '../src/reminders.js';
import { renderEmail } from '../src/email.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Friday 9 October 2026, 1:00pm in Auckland (NZDT, UTC+13): round 11
const NOW = Date.UTC(2026, 9, 9, 0, 0);
const realNow = Date.now;

/* ---------------- helpers (as test/round9-play.test.js) ---------------- */
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

const FALLBACK = [
  { id: 'main-room', name: 'Main room', code: 'T', tables: 21, seats: 4, order: 1 },
  { id: 'party-room', name: 'Party room', code: 'P', tables: 4, seats: 4, order: 2 },
  { id: 'fancy-room', name: 'Fancy room', code: 'F', tables: 1, seats: 12, price: 15, minPeople: 4, order: 4 },
];
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
// A Pokémon night with no sign-ups (a booster pack), Blood on the Clocktower with 4 places at $10 (paid in store), and
// Oddity Alley's two days (free entry), each day its own date
const EVENTS = [
  { id: 'pokemon', title: 'Pokémon night', type: 'tcg', start: at('2026-10-16', 19), end: at('2026-10-17', 0), tables: '', priceNote: 'Entry: a booster pack', freeEntry: false },
  { id: 'clocktower', title: 'Blood on the Clocktower', type: 'social', start: at('2026-10-18', 12), end: at('2026-10-18', 18), tables: '', capacity: 4, entryFee: 1000, payment: 'store' },
  { id: 'alley-sat', title: 'Oddity Alley', type: 'market', start: at('2026-11-21', 10), end: at('2026-11-21', 16), tables: '', freeEntry: true, priceNote: '' },
  { id: 'alley-sun', title: 'Oddity Alley', type: 'market', start: at('2026-11-22', 10), end: at('2026-11-22', 16), tables: '', freeEntry: true, priceNote: '' },
];
const POKEMON = 'pokemon@2026-10-16';
const CLOCK = 'clocktower@2026-10-18';
const SAT = 'alley-sat@2026-11-21';
const SUN = 'alley-sun@2026-11-22';
const MOBILE = '021 555 0100';
const RUBY = { name: 'Ruby Tane', email: 'ruby@example.com', phone: MOBILE };
const MERE = { name: 'Mere Parata', email: 'mere@example.com', phone: '021 555 0101' };

let lair;
async function call(method, path, body, customer = '', extraHeaders = {}) {
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  const type = response.headers.get('Content-Type') || '';
  return { status: response.status, data: type.includes('json') ? await response.json() : await response.text(), headers: response.headers };
}
const said = (res) => `${res.status} ${res.data.error || ''}`.trim();
const interest = (body, who = '') => call('POST', 'interest', body, who);
const remind = (id, body, who = '') => call('POST', `interest/${encodeURIComponent(id)}/remind`, body, who);
const removeInterest = (id, body = {}, who = '') => call('POST', `interest/${encodeURIComponent(id)}/remove`, body, who);
const waitlist = (body, who = '') => call('POST', 'interest', { waitlist: true, kind: 'event', ...body }, who);
const join = (id, body, who = '') => call('POST', `events/${encodeURIComponent(id)}/join`, body, who);
const floor = async (who = '') => (await call('GET', `floor?from=${NOW - DAY}&to=${NOW + 60 * DAY}`, null, who)).data;
const me = async (who) => (await call('GET', 'me', null, who)).data;
const rows = () => lair.sql.exec('SELECT * FROM interests ORDER BY rowid').toArray();
/** The maintenance run's reminders at a fixed time (the internal route the live checks use) */
const runAt = async (ms) => {
  const res = await call('POST', 'internal/reminders', { at: ms }, '', { 'X-Lair-Internal': '1' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
};

function captureEmails() {
  lair.baseEnv = { ...lair.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test', PUBLIC_URL: 'https://lair.example.com' };
  const sent = [];
  const realFetch = globalThis.fetch;
  let failWith = 0;
  globalThis.fetch = async (url, init) => {
    if (failWith) return new Response(JSON.stringify({ message: 'nope' }), { status: failWith });
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return { sent, fail: (status) => { failWith = status; }, restore: () => { globalThis.fetch = realFetch; } };
}
const settle = () => new Promise((r) => setTimeout(r, 10));
const reminders = (sent) => sent.filter((m) => /^(Tomorrow|Today): /.test(m.subject));

beforeEach(() => {
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD', SHOP: 'example-shop.myshopify.com' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: id === 'gm', tags: [] });
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  lair.rulesCache = rulesFromSettings({ lair_shop_tables: '' }, FALLBACK, EVENTS, { address: '56/691 Manukau Road, Royal Oak, Auckland 1023' });
  lair.rulesLoadedAt = NOW + 10 * 365 * DAY;
});
afterEach(() => {
  Date.now = realNow;
});

test('reminders (round 11): one migration entry, found by what it adds: four new columns on interests and an index', () => {
  const mine = MIGRATIONS.filter((m) => m.some((s) => /ALTER TABLE interests ADD COLUMN reminded_at\b/.test(s)));
  assert.equal(mine.length, 1);
  for (const column of ['remind', 'remind_at', 'reminded_at', 'people']) {
    assert.ok(mine[0].some((s) => new RegExp(`ALTER TABLE interests ADD COLUMN ${column} INTEGER`).test(s)), column);
  }
  assert.ok(mine[0].every((s) => /^\s*(ALTER TABLE interests ADD COLUMN|CREATE INDEX IF NOT EXISTS)/.test(s)), 'new columns and an index only');
  const columns = lair.sql.exec("SELECT name FROM pragma_table_info('interests')").toArray().map((c) => c.name);
  for (const column of ['remind', 'remind_at', 'reminded_at', 'people']) assert.ok(columns.includes(column), `${column} is there`);
});

test('reminders: a guest and a member opt in; the day before from 9am each gets exactly one, with what, when, where, the price, Add to calendar and how to take it back', async () => {
  const mail = captureEmails();
  try {
    // Ruby (no account) is coming with a reminder; member 501 is a maybe and turns it on later; 502 turns it on, then off
    const ruby = await interest({ kind: 'event', id: POKEMON, coming: true, remind: true, ...RUBY });
    assert.equal(ruby.status, 200, said(ruby));
    assert.equal(ruby.data.interest.remind, true);
    assert.equal(ruby.data.interest.reminded, false);
    assert.ok(ruby.data.interest.key, 'a guest gets the key that changes it');
    const mere = await interest({ kind: 'event', id: POKEMON, ...MERE }, '501');
    assert.equal(mere.data.interest.remind, false, 'left out, there is no reminder');
    const on = await remind(mere.data.interest.id, { remind: true }, '501');
    assert.equal(on.status, 200, said(on));
    assert.equal(on.data.interest.remind, true);
    assert.equal(on.data.interest.level, 'maybe', 'turning the reminder on changes nothing else');
    const tama = await interest({ kind: 'event', id: POKEMON, coming: true, remind: true, name: 'Tama Rewiti', email: 'tama@example.com' }, '502');
    assert.equal((await remind(tama.data.interest.id, { remind: false }, '502')).data.interest.remind, false);
    assert.equal(mail.sent.length, 0, 'saying it emails nobody (no GM for an event date)');

    // Thursday 15 October: nothing before 9am, then one each for Ruby and Mere, never Tama
    assert.deepEqual(await runAt(at('2026-10-15', 8, 55)), { sent: 0, dates: [] });
    const run = await runAt(at('2026-10-15', 9, 5));
    assert.equal(run.sent, 2);
    assert.deepEqual(run.dates, [POKEMON]);
    const sent = reminders(mail.sent);
    assert.deepEqual(sent.map((m) => m.to).sort(), ['mere@example.com', 'ruby@example.com']);
    const r = sent.find((m) => m.to === 'ruby@example.com');
    assert.equal(r.subject, 'Tomorrow: Pokémon night, 7pm');
    assert.match(r.text, /SEE YOU TOMORROW!/);
    assert.match(r.text, /Kia ora Ruby, here’s the reminder you asked for: Pokémon night is tomorrow, Friday 16 October, 7pm to midnight\./);
    assert.match(r.text, /Where: +Dice Goblin, 56\/691 Manukau Road, Royal Oak, Auckland 1023\n +Upstairs in Royal Oak Mall, above Whitcoulls\. The lift is next to Whitcoulls\./);
    assert.doesNotMatch(r.text, /weekends/, 'a Friday says nothing about the weekend lift');
    assert.match(r.text, /Entry: +Entry: a booster pack/, 'the price as the event says it');
    assert.match(r.text, /You said: +I’m coming/);
    assert.match(r.text, /Add to calendar: https:\/\/lair\.example\.com\/ics\/pokemon%402026-10-16\.ics/);
    assert.match(r.text, /Google Calendar: https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&text=Pok%C3%A9mon\+night&dates=20261016T060000Z%2F20261016T110000Z/);
    // the guest's link carries the key that takes it back from any device
    assert.match(r.text, new RegExp(`The event’s page: https://www\\.dicegoblin\\.nz/pages/events-calendar\\?interest=${ruby.data.interest.id}&key=${ruby.data.interest.key}&date=pokemon%402026-10-16&said=coming#event=pokemon%402026-10-16`));
    assert.match(r.text, /Not coming after all\? Take it back on the event’s page \(the link above\)/);
    const m = sent.find((x) => x.to === 'mere@example.com');
    assert.match(m.text, /TOMORROW’S THE DAY/);
    assert.match(m.text, /You said maybe\. No pressure, friend: come along if you can\./);
    assert.match(m.text, /The event’s page: https:\/\/www\.dicegoblin\.nz\/pages\/events-calendar#event=pokemon%402026-10-16\n/, "a member's link is the plain page");
    assert.match(m.text, /in My Lair/);
    assert.ok(m.html.includes('href="https://lair.example.com/ics/pokemon%402026-10-16.ics"'), 'the button is the calendar file');

    // never twice: later runs that day, and a take-back and say-again
    assert.equal((await runAt(at('2026-10-15', 9, 15))).sent, 0);
    assert.equal((await runAt(at('2026-10-15', 18, 0))).sent, 0);
    assert.equal((await removeInterest(ruby.data.interest.id, { key: ruby.data.interest.key })).status, 200);
    Date.now = () => at('2026-10-15', 12);
    const again = await interest({ kind: 'event', id: POKEMON, coming: true, remind: true, ...RUBY });
    assert.equal(again.data.interest.reminded, true, 'the new row knows it went');
    assert.equal((await runAt(at('2026-10-15', 12, 5))).sent, 0);
    assert.equal(reminders(mail.sent).length, 2);
    // GET /me shows a member's choice and that it went
    const mine = (await me('501')).interests.find((i) => i.targetId === POKEMON);
    assert.deepEqual([mine.remind, mine.reminded], [true, true]);
  } finally {
    mail.restore();
  }
});

test('reminders: never late at night; opted in after 9pm the day before, it comes that morning; on the day itself, none', async () => {
  const mail = captureEmails();
  try {
    // 10pm on Thursday: Ruby opts in for Friday's Pokémon night; the 10:05pm run sends nothing
    Date.now = () => at('2026-10-15', 22);
    const ruby = await interest({ kind: 'event', id: POKEMON, coming: true, remind: true, ...RUBY });
    assert.equal(ruby.status, 200, said(ruby));
    assert.equal((await runAt(at('2026-10-15', 22, 5))).sent, 0, 'not at night');
    assert.equal((await runAt(at('2026-10-16', 6, 0))).sent, 0, 'not before 9am');
    // Friday 9:30am Mere opts in on the day itself: she gets none, Ruby gets hers that morning
    Date.now = () => at('2026-10-16', 9, 30);
    await interest({ kind: 'event', id: POKEMON, remind: true, ...MERE }, '501');
    const run = await runAt(at('2026-10-16', 9, 35));
    assert.equal(run.sent, 1);
    const [r] = reminders(mail.sent);
    assert.equal(r.to, 'ruby@example.com');
    assert.equal(r.subject, 'Today: Pokémon night, 7pm');
    assert.match(r.text, /SEE YOU TODAY!/);
    assert.match(r.text, /Pokémon night is today, Friday 16 October, 7pm to midnight\./);
    assert.equal((await runAt(at('2026-10-16', 14, 0))).sent, 0, 'Mere asked on the day: none');
    // and nothing for a date that has started
    assert.equal((await runAt(at('2026-10-16', 19, 30))).sent, 0);
  } finally {
    mail.restore();
  }
});

test('reminders: a two-day event is two dates, each with its own interest and its own reminder the day before', async () => {
  const mail = captureEmails();
  try {
    const sat = await interest({ kind: 'event', id: SAT, coming: true, remind: true, ...RUBY });
    const sun = await interest({ kind: 'event', id: SUN, coming: true, remind: true, ...RUBY });
    assert.equal(sat.status, 200, said(sat));
    assert.equal(sun.status, 200, said(sun));
    assert.notEqual(sat.data.interest.id, sun.data.interest.id);
    // Friday 20 November: Saturday's
    assert.deepEqual((await runAt(at('2026-11-20', 9, 0))).dates, [SAT]);
    // Saturday 21 November: Sunday's
    assert.deepEqual((await runAt(at('2026-11-21', 9, 0))).dates, [SUN]);
    const [first, second] = reminders(mail.sent);
    assert.equal(first.subject, 'Tomorrow: Oddity Alley, 10am');
    assert.match(first.text, /Saturday 21 November, 10am to 4pm/);
    assert.match(first.text, /Entry: +Free entry/, 'a $0 entry fee is free entry');
    assert.match(first.text, /The lift is next to Whitcoulls\. On weekends the lift runs during mall hours, 10am to 5pm\./);
    assert.match(second.text, /Sunday 22 November, 10am to 4pm/);
  } finally {
    mail.restore();
  }
});

test('reminders: the maintenance run sends them too; Resend down means the next run tries again, never twice once sent', async () => {
  const mail = captureEmails();
  try {
    await interest({ kind: 'event', id: POKEMON, coming: true, remind: true, ...RUBY });
    Date.now = () => at('2026-10-15', 10);
    mail.fail(503);
    const down = await lair.checkConnection(undefined, { force: false });
    assert.equal(down.reminders.sent, 1, 'claimed');
    await settle();
    assert.equal(rows()[0].reminded_at, null, 'Resend was down: unmarked for the next run');
    mail.fail(0);
    Date.now = () => at('2026-10-15', 10, 10);
    const up = await lair.checkConnection(undefined, { force: false });
    assert.equal(up.reminders.sent, 1);
    await settle();
    assert.equal(reminders(mail.sent).length, 1);
    assert.ok(rows()[0].reminded_at);
    Date.now = () => at('2026-10-15', 10, 20);
    assert.equal((await lair.checkConnection(undefined, { force: false })).reminders, undefined);
  } finally {
    mail.restore();
  }
});

test('reminders: changing it: the owner, a guest with the key or staff; only on "I’m coming" or "Maybe"; on or off', async () => {
  const ruby = await interest({ kind: 'event', id: POKEMON, coming: true, ...RUBY });
  const id = ruby.data.interest.id;
  assert.equal(said(await remind(id, { remind: true })), `403 ${REMINDER_MESSAGES.notYours}`);
  assert.equal(said(await remind(id, { remind: true, key: 'wrong' })), `403 ${REMINDER_MESSAGES.notYours}`);
  assert.equal(said(await remind(id, { remind: 'yes', key: ruby.data.interest.key })), `422 ${REMINDER_MESSAGES.choose}`);
  const on = await remind(id, { remind: true, key: ruby.data.interest.key });
  assert.equal(on.status, 200, said(on));
  assert.equal(on.data.interest.remind, true);
  assert.equal(rows()[0].remind_at, NOW);
  Date.now = () => NOW + HOUR;
  await remind(id, { remind: true, key: ruby.data.interest.key });
  assert.equal(rows()[0].remind_at, NOW, 'still on: it keeps when it was turned on');
  assert.equal((await remind(id, { remind: false }, 'staff')).data.interest.remind, false, 'staff can');
  assert.equal(said(await remind('in_nope', { remind: true })), `404 ${INTEREST_MESSAGES.missing}`);
  // a TTRPG session's interest has no reminder
  lair.sql.exec("UPDATE interests SET kind = 'session' WHERE id = ?", id);
  assert.equal(said(await remind(id, { remind: true }, 'staff')), `422 ${REMINDER_MESSAGES.only}`);
});

test('waitlist: a full date offers it; staff are told plainly with the total, the person hears nothing is booked; public counts only', async () => {
  const mail = captureEmails();
  try {
    // 4 places: two sign-ups of 2 fill it
    assert.equal((await join(CLOCK, { name: 'Sam Jones', email: 'sam@example.com', phone: MOBILE, people: 2 })).status, 200);
    const early = await waitlist({ id: CLOCK, people: 2, ...RUBY });
    assert.equal(said(early), `409 ${REMINDER_MESSAGES.room(2)}`, 'room left: sign up instead');
    assert.equal((await join(CLOCK, { name: 'Kiri Smith', email: 'kiri@example.com', phone: MOBILE, people: 2 })).status, 200);
    mail.sent.length = 0;

    const ruby = await waitlist({ id: CLOCK, people: 2, note: 'We could run a second table.', ...RUBY });
    assert.equal(ruby.status, 200, said(ruby));
    assert.equal(ruby.data.interest.level, 'waitlist');
    assert.equal(ruby.data.interest.people, 2);
    assert.ok(ruby.data.interest.key);
    assert.deepEqual([ruby.data.already, ruby.data.emailed, ruby.data.staffEmailed, ruby.data.placesLeft], [false, true, true, 0]);
    assert.deepEqual(ruby.data.counts, { maybe: 0, coming: 0, waiting: 2 });
    await settle();
    const staff = mail.sent.find((m) => m.to === 'staff@dicegoblin.test');
    assert.equal(staff.subject, 'Waitlist: Blood on the Clocktower, Sun 18 Oct (2 waiting)');
    assert.match(staff.text, /Blood on the Clocktower on Sunday 18 October is full \(4 of 4 places\)\. Ruby Tane just joined the waitlist for 2 people\./);
    assert.match(staff.text, /2 people are waiting now\. This is the moment to organise another group, if you can\./);
    assert.match(staff.text, /Mobile: +021 555 0100/);
    assert.match(staff.text, /Their note: +We could run a second table\./);
    assert.match(staff.text, /Waiting: +2 people \(1 name on the list\)/);
    assert.match(staff.text, /nothing happens by itself: who gets it is your call/);
    assert.equal(staff.reply_to, 'ruby@example.com', 'replies go to the person');
    const you = mail.sent.find((m) => m.to === 'ruby@example.com');
    assert.equal(you.subject, 'You’re on the waitlist: Blood on the Clocktower, Sun 18 Oct');
    assert.match(you.text, /Kia ora Ruby, Blood on the Clocktower on Sunday 18 October is full, so Gobgob has put you on the waitlist for 2 people\./);
    assert.match(you.text, /Nothing is booked and nothing is paid\. If a place opens up, or the team can start another group, they’ll be in touch\./);

    // a member: their saved mobile fills in, and their "Maybe" becomes the waitlist (one row)
    lair.sql.exec("INSERT INTO members (customer_id, name, first_name, email, mobile, created_at, updated_at) VALUES ('501', 'Mere Parata', 'Mere', 'mere@example.com', '021 555 0101', ?, ?)", NOW, NOW);
    const maybe = await interest({ kind: 'event', id: CLOCK, remind: true }, '501');
    assert.equal(maybe.data.interest.level, 'maybe');
    mail.sent.length = 0;
    const mere = await waitlist({ id: CLOCK }, '501');
    assert.equal(mere.status, 200, said(mere));
    assert.equal(mere.data.interest.id, maybe.data.interest.id, 'the same row');
    assert.deepEqual([mere.data.interest.level, mere.data.interest.people, mere.data.interest.remind, mere.data.interest.key], ['waitlist', 1, false, undefined]);
    await settle();
    assert.match(mail.sent.find((m) => m.to === 'staff@dicegoblin.test').text, /3 people are waiting now/);
    // asking again changes the people, and emails nobody
    mail.sent.length = 0;
    const more = await waitlist({ id: CLOCK, people: 3 }, '501');
    assert.deepEqual([more.data.already, more.data.emailed, more.data.staffEmailed, more.data.interest.people], [true, false, false, 3]);
    await settle();
    assert.equal(mail.sent.length, 0);

    // the public: "Full · n waiting" from counts; never names, never places taken
    const pub = await floor();
    assert.deepEqual(pub.eventInterest[CLOCK], { maybe: 0, coming: 0, waiting: 5 });
    assert.equal(pub.eventJoins[CLOCK], 4, 'the waitlist is never places taken');
    assert.equal(pub.interests, undefined);
    assert.ok(!JSON.stringify(pub).includes('ruby@example.com'));
    // staff see names, emails, mobiles and notes
    const desk = (await floor('staff')).interests.filter((i) => i.level === 'waitlist').map((i) => [i.name, i.email, i.phone, i.people, i.note]);
    assert.deepEqual(desk, [['Ruby Tane', 'ruby@example.com', MOBILE, 2, 'We could run a second table.'], ['Mere Parata', 'mere@example.com', '021 555 0101', 3, '']]);
    // My Lair lists it
    const mine = (await me('501')).interests.find((i) => i.targetId === CLOCK);
    assert.deepEqual([mine.level, mine.people], ['waitlist', 3]);
    // a reminder is only for "I'm coming" and "Maybe"
    assert.equal(said(await remind(mine.id, { remind: true }, '501')), `422 ${REMINDER_MESSAGES.only}`);

    // taking themselves off; a place freeing up books nobody by itself
    assert.equal((await removeInterest(ruby.data.interest.id, { key: ruby.data.interest.key })).data.counts.waiting, 3);
    const kiri = (await floor('staff')).joins.find((j) => j.email === 'kiri@example.com');
    assert.equal((await call('POST', `events/joins/${kiri.id}/cancel`, {}, 'staff')).status, 200);
    assert.equal((await floor()).eventJoins[CLOCK], 2);
    assert.equal(rows().filter((r) => r.level === 'waitlist' && r.status === 'active').length, 1, 'still waiting: staff decide');
    assert.equal((await join(CLOCK, { name: 'Ana Ngata', email: 'ana@example.com', phone: MOBILE, people: 2 })).status, 200, 'anyone can sign up for the free places');
  } finally {
    mail.restore();
  }
});

test('waitlist: the checks, word for word', async () => {
  await join(CLOCK, { name: 'Sam Jones', email: 'sam@example.com', phone: MOBILE, people: 4 });
  assert.equal(said(await waitlist({ id: POKEMON, ...RUBY })), `422 ${REMINDER_MESSAGES.noSignUps}`);
  assert.equal(said(await waitlist({ id: 'nope@2026-10-18', ...RUBY })), `404 ${INTEREST_MESSAGES.event}`);
  assert.equal(said(await waitlist({ id: CLOCK, kind: 'session', ...RUBY })), `422 ${REMINDER_MESSAGES.kind}`);
  assert.equal(said(await waitlist({ id: CLOCK, people: 7, ...RUBY })), `422 ${REMINDER_MESSAGES.people}`);
  assert.equal(said(await waitlist({ id: CLOCK, people: 0, ...RUBY })), `422 ${REMINDER_MESSAGES.people}`);
  assert.equal(said(await waitlist({ id: CLOCK, ...RUBY, name: '' })), `422 ${INTEREST_MESSAGES.name}`);
  assert.equal(said(await waitlist({ id: CLOCK, ...RUBY, email: 'ruby' })), `422 ${INTEREST_MESSAGES.email}`);
  assert.equal(said(await waitlist({ id: CLOCK, ...RUBY, phone: '' })), '422 Add a mobile number so we can reach you on the day.');
  assert.equal(said(await waitlist({ id: CLOCK, ...RUBY, note: 'x'.repeat(281) })), `422 ${INTEREST_MESSAGES.note}`);
  assert.equal(said(await waitlist({ id: CLOCK, name: 'Sam Jones', email: 'SAM@example.com', phone: MOBILE })), `409 ${INTEREST_MESSAGES.joined}`);
  Date.now = () => at('2026-10-18', 18, 30);
  assert.equal(said(await waitlist({ id: CLOCK, ...RUBY })), `422 ${INTEREST_MESSAGES.over}`);
});

test('reminders: an event date as a calendar file; one not on the calendar is a 404', async () => {
  const res = await call('GET', `internal/eventics/${encodeURIComponent(CLOCK)}`, null, '', { 'X-Lair-Internal': '1' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'text/calendar; charset=utf-8');
  assert.match(res.headers.get('Content-Disposition'), /attachment; filename="blood-on-the-clocktower-2026-10-18\.ics"/);
  const ics = res.data.replace(/\r\n /g, '');
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /UID:clocktower-2026-10-18@dicegoblin\.nz\r\n/, 'the same UID as the events page makes');
  assert.match(ics, /DTSTART:20261017T230000Z\r\nDTEND:20261018T050000Z\r\n/);
  assert.match(ics, /SUMMARY:Blood on the Clocktower\r\n/);
  assert.match(ics, /DESCRIPTION:\$10 a person\\, paid at the counter\\n\\nhttps:\/\/www\.dicegoblin\.nz\/pages\/events-calendar#event=clocktower%402026-10-18\r\n/);
  assert.match(ics, /LOCATION:Dice Goblin\\, 56\/691 Manukau Road\\, Royal Oak\\, Auckland 1023\r\n/);
  const missing = await call('GET', 'internal/eventics/nope%402026-10-18', null, '', { 'X-Lair-Internal': '1' });
  assert.equal(missing.status, 404);
  assert.equal(missing.data, 'That event date could not be found.');
  assert.equal((await call('GET', `internal/eventics/${encodeURIComponent(CLOCK)}`)).status, 404, 'only the Worker itself reaches the internal route');
});

test('reminders: the email layout takes small links under the button, http(s) only', () => {
  const { html, text } = renderEmail({ title: 'T', button: { label: 'Add to calendar', url: 'https://a.example/x.ics' }, links: [{ label: 'Google Calendar', url: 'https://g.example/?a=1&b=2' }, { label: 'Bad', url: 'javascript:alert(1)' }] });
  assert.ok(html.includes('<a href="https://g.example/?a=1&amp;b=2"'));
  assert.ok(!html.includes('javascript:'));
  assert.match(text, /Add to calendar: https:\/\/a\.example\/x\.ics\n\nGoogle Calendar: https:\/\/g\.example\/\?a=1&b=2/);
  assert.ok(!renderEmail({ title: 'T' }).html.includes('&nbsp;·&nbsp;'), 'no links, no line');
});

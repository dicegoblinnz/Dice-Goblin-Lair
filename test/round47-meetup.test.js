// Round 47: who's going on Meetup, for an event whose link is a Meetup event (contract v47-meetup). Mo, 20 Nov 2026:
// "is there a way for us to get numbers on my website from meetup?" ... "it checks once every 8 hours".
// Run with: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cloudflareSql } from './cloudflare-sql.js';
import { MEETUP, MEETUP_TABLES, meetupLink, meetupMethods, ownCapacity, parseMeetup } from '../src/meetup.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 20, 5, 0); // Friday 20 November 2026, 6pm in Auckland
const LINK = 'https://www.meetup.com/auckland-games-meetup-group/events/317403367/';
const START = Date.parse('2026-11-29T13:50:00+13:00');
const realFetch = globalThis.fetch;

/** A Meetup event page as it comes: the numbers are in its __NEXT_DATA__ */
const page = (going = 10, o = {}) => `<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"event":{"eventUrl":"${LINK}","status":"${o.status || 'ACTIVE'}","dateTime":"2026-11-29T13:50:00+13:00","endTime":"2026-11-29T18:00:00+13:00","maxTickets":${o.cap ?? 32},"rsvps":{"__typename":"RsvpConnection","totalCount":0},"goingCount":{"__typename":"RsvpConnection","totalCount":${going}}}}}</script></body></html>`;

/** The Lair's own methods over a real SQLite, checked against Cloudflare's limits */
function lair() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      cloudflareSql(query, bindings);
      const stmt = db.prepare(query);
      if (/^\s*select/i.test(query)) {
        const rows = stmt.all(...bindings);
        return { toArray: () => rows };
      }
      stmt.run(...bindings);
      return { toArray: () => [] };
    },
  };
  for (const statement of MEETUP_TABLES) sql.exec(statement);
  return { sql, ...meetupMethods };
}

/** Meetup, answering with what `answer` gives; calls: every address asked for */
function meetup(answer) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const a = answer();
    if (a instanceof Error) throw a;
    return { ok: a.ok !== false && !a.to, status: a.to ? 302 : a.ok === false ? 503 : 200, headers: { get: (h) => (h === 'location' ? a.to || null : null) }, text: async () => a.body || '' };
  };
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('only a Meetup event is ever read', () => {
  assert.equal(meetupLink(LINK), LINK);
  assert.equal(meetupLink('https://meetu.ps/e/QplTV/z5ZqL/i'), 'https://meetu.ps/e/QplTV/z5ZqL/i');
  for (const no of ['', null, 'https://www.dicegoblin.nz/pages/events', 'http://www.meetup.com/group/events/1/', 'https://www.meetup.com/find/', 'https://evil.example/www.meetup.com/g/events/1/', 'https://www.meetup.com.evil.example/g/events/1/']) {
    assert.equal(meetupLink(no), null, String(no));
  }
});

test("the page's own numbers: who's going, the places and when it starts", () => {
  assert.deepEqual(parseMeetup(page(10)), { going: 10, cap: 32, start: START });
  assert.deepEqual(parseMeetup(page(3, { cap: 0 })), { going: 3, cap: null, start: START });
  assert.equal(parseMeetup(page(10, { status: 'CANCELLED' })), null);
  assert.equal(parseMeetup('<html>Just a moment...</html>'), null);
  assert.equal(parseMeetup(''), null);
});

test('a link is read once every 8 hours, and the numbers go out with the floor', async () => {
  const l = lair();
  let going = 10;
  const calls = meetup(() => ({ body: page(going) }));
  assert.equal(await l.meetupRefresh([LINK, '', 'https://www.dicegoblin.nz/'], NOW), 1);
  assert.deepEqual(calls, [LINK]);
  assert.deepEqual(l.meetupCounts(NOW), { [LINK]: { going: 10, cap: 32, start: START } });
  going = 14;
  assert.equal(await l.meetupRefresh([LINK], NOW + MEETUP.every - 60_000), 0, 'not again inside 8 hours');
  assert.equal(calls.length, 1);
  assert.equal(await l.meetupRefresh([LINK], NOW + MEETUP.every), 1);
  assert.equal(l.meetupCounts(NOW + MEETUP.every)[LINK].going, 14);
});

test('a read that fails keeps the last numbers, waits its 8 hours, and they stop showing after 26', async () => {
  const l = lair();
  let answer = { body: page(10) };
  const calls = meetup(() => answer);
  await l.meetupRefresh([LINK], NOW);
  answer = new Error('down');
  await l.meetupRefresh([LINK], NOW + 8 * HOUR);
  answer = { ok: false };
  await l.meetupRefresh([LINK], NOW + 16 * HOUR);
  answer = { body: '<html>Just a moment...</html>' };
  await l.meetupRefresh([LINK], NOW + 16 * HOUR + 60_000);
  assert.equal(calls.length, 3, 'a failed read is not tried again early');
  assert.equal(l.meetupCounts(NOW + 25 * HOUR)[LINK].going, 10);
  assert.deepEqual(l.meetupCounts(NOW + 27 * HOUR), {});
});

test('a short link is followed to its Meetup event, and nowhere else is ever asked for', async () => {
  const SHORT = 'https://meetu.ps/e/QplTV/z5ZqL/i';
  let l = lair();
  let calls = meetup(() => (calls.length === 1 ? { to: `${LINK}?utm=share` } : { body: page(10) }));
  await l.meetupRefresh([SHORT], NOW);
  assert.deepEqual(calls, [SHORT, LINK]);
  assert.equal(l.meetupCounts(NOW)[SHORT].going, 10);
  l = lair();
  calls = meetup(() => ({ to: 'https://elsewhere.example/', body: page(99) }));
  await l.meetupRefresh([SHORT], NOW);
  assert.deepEqual(calls, [SHORT], 'the other address is never fetched');
  assert.deepEqual(l.meetupCounts(NOW), {});
});

test("a Lair that couldn't reach Shopify forgets nothing and reads nothing", async () => {
  const l = lair();
  const calls = meetup(() => ({ body: page(10) }));
  let known = true;
  l.rules = async () => ({ events: known ? [{ link: LINK }] : [] });
  l.eventsKnown = () => known;
  assert.equal(await l.meetupRun(NOW), 1);
  known = false; // Shopify down on a fresh start: the built-in rules have no events
  assert.equal(await l.meetupRun(NOW + 600_000), 0);
  assert.equal(l.meetupCounts(NOW + 600_000)[LINK].going, 10, 'kept');
  known = true;
  assert.equal(await l.meetupRun(NOW + 1_200_000), 0, 'still inside its 8 hours');
  assert.equal(calls.length, 1);
});

test("a link no event has any more is forgotten, and an event that's over shows nothing", async () => {
  const l = lair();
  meetup(() => ({ body: page(10) }));
  await l.meetupRefresh([LINK], NOW);
  await l.meetupRefresh([LINK], START + 11 * HOUR);
  assert.equal(l.meetupCounts(START + 11 * HOUR)[LINK].going, 10);
  assert.deepEqual(l.meetupCounts(START + 13 * HOUR), {}, 'over');
  await l.meetupRefresh([], START + 13 * HOUR);
  assert.equal(l.sql.exec('SELECT COUNT(*) AS n FROM meetup_counts').toArray()[0].n, 0);
});

test('at most 3 pages a run', async () => {
  const l = lair();
  const calls = meetup(() => ({ body: page(1) }));
  const links = [1, 2, 3, 4, 5].map((n) => `https://www.meetup.com/g/events/${n}/`);
  assert.equal(await l.meetupRefresh(links, NOW), MEETUP.aRun);
  assert.equal(await l.meetupRefresh(links, NOW + 600_000), 2);
  assert.equal(calls.length, 5);
});

// Mo, 20 Nov 2026 (later): "don't make our own signups ... make them all go through Meetup and just keep the update
// on the website."
test('an event that links to a Meetup event takes no sign-ups of its own', () => {
  assert.equal(ownCapacity('40', LINK), null);
  assert.equal(ownCapacity('40', 'https://meetu.ps/e/QplTV/z5ZqL/i'), null);
  // a date that isn't up on Meetup yet links to the group's page: still no sign-ups here (Mo, 20 Nov 2026, 7:37pm)
  assert.equal(ownCapacity('40', 'https://www.meetup.com/auckland-games-meetup-group/events/'), null);
  assert.equal(meetupLink('https://www.meetup.com/auckland-games-meetup-group/events/'), null, 'and a group page is never read for numbers');
  assert.equal(ownCapacity('40', 'https://www.meetup.com.evil.example/g/'), 40);
  assert.equal(ownCapacity('40', ''), 40);
  assert.equal(ownCapacity('40', 'https://www.dicegoblin.nz/pages/our-games'), 40, 'any other link changes nothing');
  assert.equal(ownCapacity(null, LINK), null);
  assert.equal(ownCapacity('', ''), null);
});

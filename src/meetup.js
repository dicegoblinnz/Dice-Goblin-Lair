/**
 * Round 47 (20 Nov 2026, contract v47-meetup): how many people are going on Meetup, for an event whose link is a
 * Meetup event.
 *
 * Mo, 20 Nov 2026: "I want my blood on the clock tower to link to this website for people to join is there a way for
 * us to get numbers on my website from meetup?" The Meetup group isn't his, and Meetup's API is for paying organisers,
 * so the Lair reads the event's public page, the one anyone sees: "it checks once every 8 hours no need to be every 15
 * mins".
 *
 * An event's Link (lair_event link) that is a Meetup event's address is read at most once every MEETUP.every, by the
 * 10-minute run (maintenance), at most MEETUP.aRun pages a run. The page's own data gives who's going, the places
 * there are and when it starts; they're kept in meetup_counts and go out with GET /floor as meetup: { [link]: { going,
 * cap, start } }, counts only. A read that fails (Meetup down, the page changed, the Lair turned away) keeps the last
 * numbers until they're MEETUP.usable old, then the website shows the link with no number. Nothing here changes a
 * sign-up, a place or a price.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair.
 */
import { HOUR } from './core.js';
import { externalCalls } from './shopify.js';

/** The numbers in one place */
export const MEETUP = {
  /** a page is read once every 8 hours (Mo, 20 Nov 2026) */
  every: 8 * HOUR,
  /** numbers older than this aren't shown: three reads missed */
  usable: 26 * HOUR,
  /** pages read in one 10-minute run */
  aRun: 3,
  /** how long Meetup gets to answer */
  timeout: 8000,
};

export const MEETUP_TABLES = [
  // one row a link: the last numbers read (ok_at), and when it was last tried, read or not
  `CREATE TABLE IF NOT EXISTS meetup_counts (
    url TEXT PRIMARY KEY, going INTEGER, cap INTEGER, starts_at INTEGER, tried_at INTEGER NOT NULL DEFAULT 0, ok_at INTEGER)`,
];

/** A link that's a Meetup event (its page, or Meetup's short link to it), else null. Nothing else is ever fetched. */
export function meetupLink(link) {
  const text = String(link || '').trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (host === 'meetu.ps') return /^\/e\/[\w/-]+$/.test(url.pathname) ? text : null;
  if (host !== 'www.meetup.com' && host !== 'meetup.com') return null;
  return /^\/(?:[a-z]{2}-[A-Z]{2}\/)?[\w-]+\/events\/\w+\/?$/.test(url.pathname) ? text : null;
}

/** A link anywhere on Meetup: an event's page, or its group's (for a date that isn't up there yet) */
export function onMeetup(link) {
  try {
    const url = new URL(String(link || '').trim());
    return url.protocol === 'https:' && ['www.meetup.com', 'meetup.com', 'meetu.ps'].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * An event's own capacity (its sign-ups, places and waitlist): none when its link is on Meetup. Mo, 20 Nov 2026:
 * "don't make our own signups ... make them all go through Meetup and just keep the update on the website." So the
 * Meetup group's list is the only list, and its limit the only limit. The website asks the same (onMeetup in
 * assets/lair-calendar.js and lair-core.js).
 */
export const ownCapacity = (capacity, link) => (capacity && !onMeetup(link) ? Number(capacity) : null);

/**
 * What a Meetup event page says: { going, cap, start }, or null when it doesn't say (not an event page, a cancelled
 * event, a page Meetup has changed). going: people going. cap: the places there are (null: no limit). start: ms.
 */
export function parseMeetup(html) {
  const page = String(html || '');
  const data = page.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (!data) return null;
  const going = data.match(/"goingCount":\{[^{}]*"totalCount":(\d+)/)?.[1];
  if (going === undefined) return null;
  if (/"status":"(?:CANCELLED|CANCELLED_PERM|DRAFT)"/.test(data)) return null;
  const cap = Number(data.match(/"maxTickets":(\d+)/)?.[1] || 0);
  const start = Date.parse(data.match(/"dateTime":"([^"]+)"/)?.[1] || '');
  if (!Number.isFinite(start)) return null;
  return { going: Number(going), cap: cap > 0 ? cap : null, start };
}

export const meetupMethods = {
  /**
   * The 10-minute run's step: the events' links, read when due. Only with the events read from Shopify: a Lair that
   * couldn't reach Shopify knows no events, and that must never forget every link (and its 8 hours). Returns pages read.
   */
  async meetupRun(now = Date.now()) {
    const rules = await this.rules();
    if (!this.eventsKnown()) return 0;
    return this.meetupRefresh(rules.events.map((e) => e.link), now);
  },

  /**
   * The 10-minute run: read each Meetup link that's due. links: every event's Link. Never throws (a page that can't
   * be read is tried again in MEETUP.every). Returns how many pages it read.
   */
  async meetupRefresh(links, now = Date.now()) {
    const wanted = [...new Set((links || []).map(meetupLink).filter(Boolean))];
    // a link no event has any more is forgotten
    for (const row of this.sql.exec('SELECT url FROM meetup_counts').toArray()) {
      if (!wanted.includes(row.url)) this.sql.exec('DELETE FROM meetup_counts WHERE url = ?', row.url);
    }
    let read = 0;
    for (const url of wanted) {
      if (read >= MEETUP.aRun) break;
      const row = this.sql.exec('SELECT tried_at FROM meetup_counts WHERE url = ?', url).toArray()[0];
      if (row && now - Number(row.tried_at) < MEETUP.every) continue;
      // marked as tried first, so a read that hangs or fails still waits its 8 hours
      this.sql.exec('INSERT INTO meetup_counts (url, tried_at) VALUES (?, ?) ON CONFLICT (url) DO UPDATE SET tried_at = excluded.tried_at', url, now);
      read += 1;
      let found = null;
      try {
        // the short link hands on to the event's own page: each hop is checked before it's asked for, so nowhere
        // but Meetup is ever fetched
        let at = url;
        for (let hop = 0; hop < 3 && at; hop += 1) {
          externalCalls.count += 1;
          const res = await fetch(at, {
            redirect: 'manual',
            headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; DiceGoblinLair/1.0; +https://www.dicegoblin.nz)' },
            signal: AbortSignal.timeout(MEETUP.timeout),
          });
          const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
          if (next) {
            at = meetupLink(new URL(next, at).href.split('?')[0]);
            continue;
          }
          if (res.ok) found = parseMeetup(await res.text());
          break;
        }
      } catch {
        found = null;
      }
      if (found) this.sql.exec('UPDATE meetup_counts SET going = ?, cap = ?, starts_at = ?, ok_at = ? WHERE url = ?', found.going, found.cap, found.start, now, url);
    }
    return read;
  },

  /** For GET /floor: { [link]: { going, cap, start } } for numbers fresh enough to show, of events not yet over. No awaits. */
  meetupCounts(now = Date.now()) {
    const out = {};
    const rows = this.sql.exec('SELECT * FROM meetup_counts WHERE ok_at IS NOT NULL AND ok_at > ? AND starts_at > ?', now - MEETUP.usable, now - 12 * HOUR).toArray();
    for (const r of rows) out[r.url] = { going: Number(r.going) || 0, cap: r.cap == null ? null : Number(r.cap), start: Number(r.starts_at) };
    return out;
  },
};

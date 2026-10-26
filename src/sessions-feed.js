// Round 20 (26 Oct 2026, contract v20-sessions-feed): the TTRPG page's sessions, in the page itself. From the website lab:
// the TTRPG sessions page (/pages/gm-games) is one of the site's top landing pages, but the HTML Shopify serves has no
// sessions in it. The board fetches them from the Lair app once the page's script runs, so search engines and AI search
// tools find a page with no games on it. Mo picked "Sessions in the page": the Lair app keeps the next two weeks of
// public sessions in a shop metafield (lair.sessions, JSON), and the theme prints them as a plain list
// (snippets/lair-sessions-list.liquid).
//
// These are methods of the Lair Durable Object (src/lair.js mixes them in with Object.assign(Lair.prototype, …)). The
// 10-minute health check runs syncSessionsFeed, which writes to Shopify only when the list has changed, and at least
// once a day in case the metafield was removed.
//
// What goes in is what the public board already shows anyone logged out (GET /floor), less:
// - the GM's name and bio (Mo, 26 Oct 2026: GM names stay out, because a page Google reads makes them searchable),
// - private games (invite only), and anything pending, cancelled or already started,
// - everything else the board has but the list doesn't need (blurb, tables, players, interest, safety notes).
// Weekly games show their next session only, as on the board. A free session shows its usual seat price, as on the
// board (free sessions are staff-only: Mo, 16 Oct 2026).
import { HOUR } from './core.js';

const DAY = 24 * HOUR;

export const SESSIONS_FEED = Object.freeze({
  namespace: 'lair',
  key: 'sessions',
  type: 'json',
  // the shape's version: the theme reads v 1
  version: 1,
  // how far ahead it reaches, and the most sessions in it
  days: 14,
  max: 40,
  // written again at least this often even when nothing changed, in case someone removed it in Shopify admin
  refreshMs: DAY,
  // how long the write may take before it gives up (the next run tries again)
  timeoutMs: 20_000,
  // the Durable Object's own record of the last write: { same, at, count }
  storageKey: 'sessions-feed',
});

/** The board as someone logged out sees it (src/lair.js gives a request with no customer the same) */
export const LOGGED_OUT = Object.freeze({ customerId: null, staff: false, gm: false });

const SCHEDULES = ['one-shot', 'weekly', 'fortnightly', 'flexible'];
const clip = (value, length) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);
const iso = (ms) => new Date(ms).toISOString();

/**
 * The feed from the public board's games (GET /floor's games for someone logged out). now: ms. Returns
 * { v, updated, days, sessions: [{ id, title, system, start, end, schedule, newPlayers, price, seatsLeft, full }] },
 * soonest first. start and end are UTC ISO times; price is the usual seat price in cents.
 */
export function sessionsFeed(games, { now, days = SESSIONS_FEED.days, max = SESSIONS_FEED.max } = {}) {
  const until = now + days * DAY;
  const sessions = (games || [])
    .filter((g) => {
      if (!g || g.private || !['open', 'full'].includes(g.status)) return false;
      const start = Number(g.start);
      const end = Number(g.end);
      return Number.isFinite(start) && Number.isFinite(end) && start > now && start <= until && end > start;
    })
    .sort((a, b) => a.start - b.start || String(a.title).localeCompare(String(b.title)) || String(a.id).localeCompare(String(b.id)))
    .slice(0, max)
    .map((g) => {
      const seatsLeft = Math.max(0, (Number(g.seats) || 0) - (Number(g.taken) || 0));
      return {
        id: String(g.id),
        title: clip(g.title, 80),
        system: clip(g.system, 40),
        start: iso(Number(g.start)),
        end: iso(Number(g.end)),
        schedule: SCHEDULES.includes(g.schedule) ? g.schedule : 'one-shot',
        newPlayers: g.level === 'new',
        price: Math.max(0, Math.round(Number(g.seatPrice) || 0)),
        seatsLeft,
        full: g.status === 'full' || seatsLeft === 0,
      };
    });
  return { v: SESSIONS_FEED.version, updated: iso(now), days, sessions };
}

/** What has to change for the feed to be written again: everything but when it was made */
export const feedContent = (feed) => JSON.stringify({ v: feed.v, days: feed.days, sessions: feed.sessions });

export const sessionsFeedMethods = {
  /**
   * Keeps the shop metafield lair.sessions in step with the public board. Run by the 10-minute health check. null when
   * Shopify isn't set up; { count, unchanged: true } when there's nothing new to write; { count, written: true } after
   * a write. Throws when Shopify refuses or doesn't answer in time (nothing is recorded, so the next run tries again).
   */
  async syncSessionsFeed(now = Date.now()) {
    if (!this.shopify.configured) return null;
    const until = now + SESSIONS_FEED.days * DAY;
    const board = await this.floor(new URL(`https://lair.internal/floor?from=${now}&to=${until}`), LOGGED_OUT);
    const feed = sessionsFeed(board.games, { now });
    const same = feedContent(feed);
    const count = feed.sessions.length;
    const last = await this.ctx.storage.get?.(SESSIONS_FEED.storageKey);
    if (last && last.same === same && now - last.at < SESSIONS_FEED.refreshMs) return { count, unchanged: true };
    const { namespace, key, type, timeoutMs } = SESSIONS_FEED;
    await this.shopify.setShopMetafield({ namespace, key, type, value: JSON.stringify(feed) }, { timeout: timeoutMs });
    await this.ctx.storage.put?.(SESSIONS_FEED.storageKey, { same, at: now, count });
    return { count, written: true };
  },
};

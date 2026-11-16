/**
 * Round 41, news emails (16 Nov 2026). Later that night (Mo: "I want the game images be included with the events inside
 * the email. Not just text for the events."): each event in the weekly email shows its picture from Shopify, and each
 * TTRPG session its game's picture, with a day tile where there's none.
 * Mo asked: "Can we do our own marketing email to our customers? [...] Like adding new
 * items added etc." He saw test copies of the weekly email and the Black Friday email in his inbox the same night and
 * said: "I'm happy lets build it but don't send anything yet remind me again next week Monday to send one incase I
 * changed my mind". So everything here is built and nothing sends until NEWS_EMAILS says so.
 *
 * - Two emails, both marketing under New Zealand's Unsolicited Electronic Messages Act 2007:
 *   - "This week at the Lair" (NEWS_EMAILS has `weekly`): every Monday from 10am, what's on from then to Sunday (the
 *     events' dates and the TTRPG sessions with seats anyone can book), and "New in the hoard": what's come onto the
 *     website in the last 7 days, in stock (never Games Workshop's or a library copy). With nothing on and nothing new,
 *     no email that week.
 *   - Black Friday 2026 (NEWS_EMAILS has `black-friday-2026`): buy one dice set, get one free from Friday 27 to Monday 30
 *     November, and double d20 rolls online, with four of the newest Dice Goblin dice. Goes once, the first run after it's
 *     switched on, from 17 November until 30 November.
 * - Who gets them: only people Shopify has SUBSCRIBED to email marketing (Shopify's one list, as the emails skill says),
 *   less anyone on the Lair's stop list (followup_stops: whoever used an unsubscribe in any of the Lair's marketing
 *   emails). Read when each email is made, and the stop list checked again as each batch goes.
 * - Each carries the shop's details (the footer), "You're getting this because you said yes to news from Dice Goblin."
 *   and an Unsubscribe that works without logging in: the same page and routes as the first-game email's (My Lair's
 *   #unsubscribe=<code>.<key>, POST /unsubscribe/view and /stop, and the mail app's one-click on the Lair's own
 *   /unsubscribe/<code>/<key>), with a code of its own per address (NEWS-<16 hex>, news_keys). Using it stops every
 *   marketing email from Dice Goblin, and reaches Shopify's setting (first-game.js pushStopsToShopify).
 * - Sending: each email is made once (news_campaigns: its words and products kept, so every batch says the same) with
 *   everyone it's for queued (news_sends), then the 10-minute run sends NEWS_A_RUN a run in one Resend batch, each row
 *   marked before it goes and put back when Resend is down or busy. 9am to 8pm only.
 * - Switches (the config database): NEWS_EMAILS, a comma list of the emails switched on (`weekly`,
 *   `black-friday-2026`); empty or `off`: none. NEWS_FROM: the sender for these (a marketing subdomain once Resend has it
 *   verified), FROM_EMAIL when unset.
 * - POST /internal/news-test { campaign, to, at }: one copy to `to`, "[Test]" on the subject, nothing queued or marked.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair; each
 * keeps its rule: every await first, then one synchronous read-check-write.
 */
import { LairTime, addDays, eventOccurrences } from './core.js';
import { emailReady } from './shopify.js';
import { clockLabel } from './email.js';
import { seatPriceOf } from './gm-sessions.js';

export const NEWS_TABLES = [
  // one row an email made: its words and products as made (JSON, renderEmail's content less the unsubscribe)
  // until_at: none of it goes after this (the weekly by the end of its Tuesday, a one-off after its last day)
  'CREATE TABLE IF NOT EXISTS news_campaigns (id TEXT PRIMARY KEY, kind TEXT NOT NULL, made_at INTEGER NOT NULL, subject TEXT, content TEXT, recipients INTEGER NOT NULL DEFAULT 0, skipped TEXT, until_at INTEGER)',
  // who it's for: 'queued', 'sending' (at: when this run took it), 'sent', 'failed' (Resend refused it on its own),
  // 'unknown' (Resend never answered, so it may have gone: never sent again), 'stopped' (on the stop list by then) or
  // 'expired' (still queued when its time passed)
  'CREATE TABLE IF NOT EXISTS news_sends (campaign TEXT NOT NULL, email TEXT NOT NULL, name TEXT, status TEXT NOT NULL, at INTEGER, PRIMARY KEY (campaign, email))',
  'CREATE INDEX IF NOT EXISTS news_sends_queued ON news_sends (status) WHERE status IN (\'queued\', \'sending\')',
  // an address's unsubscribe code and key, made the first time it's sent a news email, and kept
  'CREATE TABLE IF NOT EXISTS news_keys (email TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, key TEXT NOT NULL, at INTEGER NOT NULL)',
];

/** Emails sent a run: one Resend batch (Resend takes 100 a batch) */
export const NEWS_A_RUN = 100;
/** The weekly email goes from this hour on a Monday, Lair time (Mo, 1 Nov 2026: "Monday 10am") */
export const WEEKLY_FROM_HOUR = 10;
/** News emails only go from 9am to 8pm at the Lair */
export const NEWS_FROM_HOUR = 9;
export const NEWS_UNTIL_HOUR = 20;
/** Rows in the weekly email's list, and products shown */
const AGENDA_MAX = 12;
const TILES = 4;
/** A send stuck as 'sending' (the run ended before Resend answered) goes back on the queue after this */
const STUCK_AFTER = 30 * 60_000;
/**
 * Review, 16 Nov 2026: Resend refuses a whole batch for one address it won't take, so a refused batch is halved and
 * tried again (meta 'news-batch'), down to one email, which is then marked failed on its own. This many refused in a row
 * on their own means the fault isn't an address (a sender Resend won't take, a key): the news emails pause (meta
 * 'news-paused', with Resend's words) until the owner's job news.resume, so a fault never uses up the list.
 */
export const NEWS_PAUSE_AFTER = 3;

/** The one-off emails, by the name NEWS_EMAILS switches them on with: when they may go (Lair days, inclusive) */
export const NEWS_CAMPAIGNS = {
  'black-friday-2026': { from: '2026-11-17', until: '2026-11-30' },
};

/** Everything the emails say, word for word (Gobgob's voice; the deal's facts plainly) */
export const NEWS_WORDS = {
  unsubscribe: 'Unsubscribe',
  why: "You're getting this because you said yes to news from Dice Goblin.",
  signoff: 'See you at the Lair!\nGobgob, the Dice Goblin',
  test: (subject) => `[Test] ${subject}`,
  weekly: {
    subject: (highlight) => (highlight ? `This week at the Lair: ${highlight}` : 'This week at the Lair'),
    title: 'This week at the Lair',
    preheader: (on, fresh) => [on ? `${on} ${on === 1 ? 'thing' : 'things'} on this week` : '', fresh ? `${fresh} new in the hoard` : ''].filter(Boolean).join(', and ') + '.',
    intro: 'Pull up a chair, friend. Here’s what’s on at the Lair this week.',
    quiet: 'A quiet week on the calendar, friend, but the tables are open every day. Grab one with your crew.',
    button: 'See what’s on',
    book: 'Book a table',
    seats: (n) => `${n} ${n === 1 ? 'seat' : 'seats'} left`,
    ttrpg: 'TTRPG',
    withGm: (name) => `with GM ${name}`,
    seat: (price) => `${price} a seat`,
    newHeading: 'New in the hoard',
    newIntro: (n) => `${n} new ${n === 1 ? 'thing' : 'things'} landed on the shelves this week. Here’s a peek.`,
    newLink: 'See everything new',
  },
  blackFriday: {
    subject: 'Black Friday: buy one dice set, get one free',
    title: 'Buy one dice set, get one free',
    preheader: 'Friday 27 to Monday 30 November, plus double d20 rolls online.',
    intro: 'Gobgob counted twice and got the same answer both times. From Friday 27 to Monday 30 November, every Dice Goblin dice set you buy brings a friend home for free.',
    button: 'Pick your dice',
    rollsHeading: 'Double rolls online',
    rolls: 'Order online over the weekend and you earn a d20 roll for every $100 you spend, twice the usual. Each roll is store credit equal to the number you roll, waiting in My Lair as soon as you’ve paid. Or take a sure $10 instead.',
    finePrint: 'The fine print: buy one, get one free runs from 12am Friday 27 November to midnight Monday 30 November, online and at the counter. The cheaper set in each pair is the free one. Games Workshop’s Warhammer dice aren’t included. From 1 December it’s back to buy two, get the third free.',
    signoff: 'Gobgob, the Dice Goblin',
  },
};

const lowerEmail = (v) => String(v || '').trim().toLowerCase();
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const money = (cents) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
const firstWord = (name) => String(name || '').trim().split(/\s+/)[0] || '';
/** "Tue" and "17 Nov" in the Lair's time zone */
const dayParts = (ms, tz) => [
  new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'short' }).format(new Date(ms)).replace(/[.,]/g, ''),
  new Intl.DateTimeFormat('en-NZ', { timeZone: tz, day: 'numeric', month: 'short' }).format(new Date(ms)).replace(/[.,]/g, ''),
];
/** A website link with the email's tags (utm_medium=email, utm_source=<which email>, utm_campaign=<page or topic>) */
export function tagged(url, source, campaign) {
  try {
    const u = new URL(url);
    u.searchParams.set('utm_medium', 'email');
    u.searchParams.set('utm_source', source);
    u.searchParams.set('utm_campaign', campaign);
    return u.toString();
  } catch {
    return url;
  }
}
/** The email names NEWS_EMAILS switches on (lower case), or none */
export function newsSwitches(env) {
  const value = String(env?.NEWS_EMAILS || '').trim().toLowerCase();
  if (!value || value === 'off') return new Set();
  return new Set(value.split(/[\s,]+/).filter(Boolean));
}

export const newsMethods = {
  /* ---------------- the 10-minute run ---------------- */
  /**
   * Makes the emails that are due (their awaits first: Shopify's subscribers and products), then sends a batch from the
   * queue. Nothing at all without NEWS_EMAILS. → { made, sent, … } or null.
   */
  async newsUpkeep(rules, now) {
    const on = newsSwitches(this.env);
    if (!on.size || !emailReady(this.env)) return null;
    const result = {};
    for (const due of this.newsDue(rules, now, on)) {
      try {
        const made = await this.makeNews(due, rules, now);
        if (made) (result.made ||= []).push(made);
      } catch (error) {
        console.error(`Lair: could not make the news email ${due.id}`, error);
        (result.errors ||= []).push({ id: due.id, error: String(error?.message || error).slice(0, 300) });
      }
    }
    const sent = await this.sendNewsBatch(rules, now);
    if (sent) result.sent = sent;
    return Object.keys(result).length ? result : null;
  },

  /**
   * The emails switched on that are due at `now` and not made yet: this Monday's weekly from 10am to 8pm, and each
   * one-off in its days from 9am to 8pm. No awaits. → [{ id, kind }]
   */
  newsDue(rules, now, on) {
    const time = new LairTime(rules.tz);
    const today = time.key(now);
    const hour = time.parts(now).h;
    if (hour < NEWS_FROM_HOUR || hour >= NEWS_UNTIL_HOUR) return [];
    const due = [];
    if (on.has('weekly') && time.weekday(today) === 1 && hour >= WEEKLY_FROM_HOUR) due.push({ id: `weekly-${today}`, kind: 'weekly' });
    for (const [id, c] of Object.entries(NEWS_CAMPAIGNS)) {
      if (on.has(id) && today >= c.from && today <= c.until) due.push({ id, kind: id });
    }
    return due.filter((d) => !this.sql.exec('SELECT 1 AS n FROM news_campaigns WHERE id = ?', d.id).toArray().length);
  },

  /**
   * One email made: its content (newsContent: products from Shopify), and everyone subscribed in Shopify less the stop
   * list queued for it. Every await first; then, if no other run made it meanwhile, one write of the lot. With nothing to
   * say (the weekly with nothing on and nothing new) it's noted as skipped and nobody's queued. → { id, recipients }
   */
  async makeNews(due, rules, now) {
    const content = await this.newsContent(due.kind, rules, now);
    const people = content ? await this.shopify.marketingSubscribers() : [];
    // --- no awaits from here ---
    if (this.sql.exec('SELECT 1 AS n FROM news_campaigns WHERE id = ?', due.id).toArray().length) return null;
    if (!content) {
      this.write('INSERT INTO news_campaigns (id, kind, made_at, recipients, skipped) VALUES (?, ?, ?, 0, ?)', due.id, due.kind, now, 'nothing to say');
      return { id: due.id, recipients: 0, skipped: 'nothing to say' };
    }
    const list = people.filter((p) => isEmail(p.email) && !this.followupStopped(p.email));
    this.write('INSERT INTO news_campaigns (id, kind, made_at, subject, content, recipients, until_at) VALUES (?, ?, ?, ?, ?, ?, ?)', due.id, due.kind, now, content.subject, JSON.stringify(content), list.length, this.newsUntil(due, rules, now));
    for (const p of list) this.write("INSERT OR IGNORE INTO news_sends (campaign, email, name, status, at) VALUES (?, ?, ?, 'queued', ?)", due.id, lowerEmail(p.email), p.firstName || null, now);
    return { id: due.id, recipients: list.length };
  },

  /**
   * When an email stops going (review, 16 Nov 2026: one queued behind a Resend outage mustn't go out stale): the weekly at
   * the end of the Tuesday after its Monday, a one-off at the end of its last day. No awaits. → ms
   */
  newsUntil(due, rules, now) {
    const time = new LairTime(rules.tz);
    if (due.kind === 'weekly') return time.at(addDays(time.key(now), 2), 0);
    const c = NEWS_CAMPAIGNS[due.kind];
    return time.at(addDays(c ? c.until : time.key(now), 1), 0);
  },

  /** Why the news emails are paused (Resend's words), or null. No awaits. */
  newsPaused() {
    return this.sql.exec("SELECT value FROM meta WHERE key = 'news-paused'").toArray()[0]?.value || null;
  },

  /** The owner's job news.resume: sending starts again (after the fault's fixed), at full batches. No awaits. */
  newsResume() {
    this.write("DELETE FROM meta WHERE key IN ('news-paused', 'news-batch', 'news-refused')");
    return { resumed: true };
  },

  /**
   * The email's words and products (the awaits: Shopify's products), or null when the weekly has nothing to say.
   * → { subject, title, preheader, intro, agenda, tiles, button, section, outro, signoff }
   */
  async newsContent(kind, rules, now) {
    if (kind === 'weekly') {
      const fresh = await this.shopify.newInStock({ since: now - 7 * 24 * 3_600_000, limit: TILES });
      // the events' pictures (Mo: "I want the game images be included with the events"); without them it still goes
      let pictures = new Map();
      try {
        pictures = await this.shopify.eventImages();
      } catch (error) {
        console.error('Lair: could not read the events\' pictures for the weekly email', error);
      }
      return this.weeklyContent(rules, now, fresh, pictures);
    }
    if (kind === 'black-friday-2026') {
      const dice = await this.shopify.newInStock({ vendor: 'Dice Goblin NZ', limit: TILES });
      return this.blackFridayContent(dice);
    }
    throw new Error(`No news email called ${kind}`);
  },

  /**
   * "This week at the Lair": from now to the end of Sunday, the events' dates (an event over several days in a row, like
   * Oddity Alley, once) and the TTRPG sessions with seats anyone can book (a weekly game's next session only), soonest
   * first; then what's new in the hoard. The subject names the first event that isn't on every week, else the first
   * session. No awaits. → content, or null with nothing on and nothing new.
   */
  weeklyContent(rules, now, fresh = { count: 0, items: [] }, pictures = new Map()) {
    const W = NEWS_WORDS.weekly;
    const SRC = 'weekly-email';
    const time = new LairTime(rules.tz);
    const today = time.key(now);
    const end = time.at(addDays(today, 7 - ((time.weekday(today) + 6) % 7)), 0);
    const events = new Map((rules.events || []).map((e) => [e.id, e]));
    const rows = [];
    // events: a date per day, joined into one row when the same event runs on days in a row at the same time
    const dates = eventOccurrences(rules, now, end).filter((o) => o.end > now).sort((a, b) => a.start - b.start);
    const joined = [];
    for (const o of dates) {
      const last = joined.find((j) => j.eventId === o.eventId && time.key(j.lastStart + 24 * 3_600_000) === time.key(o.start) && time.minutesOf(j.lastStart) === time.minutesOf(o.start));
      if (last) {
        last.lastStart = o.start;
        last.days += 1;
      } else joined.push({ ...o, lastStart: o.start, days: 1 });
    }
    for (const o of joined) {
      const ev = events.get(o.eventId) || {};
      const [d1, n1] = dayParts(o.start, rules.tz);
      const [d2, n2] = dayParts(o.lastStart, rules.tz);
      const when = o.days > 1 ? [`${d1}–${d2}`, `${n1.split(' ')[0]}–${n2}`] : [d1, n1];
      const hours = `${clockLabel(time.minutesOf(o.start))} to ${clockLabel(time.minutesOf(o.end))}${o.days > 1 ? ' each day' : ''}`;
      rows.push({ start: o.start, weekly: ev.repeat === 'weekly', row: { when, title: o.title, detail: [hours, this.newsPrice(o, ev)].filter(Boolean).join(' · '), url: tagged(this.page('events'), SRC, 'events'), image: pictures.get(o.eventId) || null } });
    }
    // TTRPG sessions with seats anyone can book now
    const st = this.state(now, end + 1);
    const info = this.seriesInfo(now);
    for (const g of st.games) {
      if (!(g.start > now && g.start < end) || g.private) continue;
      if (g.seriesId && info.next.get(g.seriesId) !== g.id) continue;
      const view = this.gameView(g, st, rules, info);
      const left = view.status === 'open' ? view.seats - view.taken : 0;
      if (left <= 0) continue;
      const price = seatPriceOf(g, rules);
      const gm = firstWord(g.gm);
      rows.push({
        start: g.start, weekly: Boolean(g.seriesId), session: true,
        row: {
          when: dayParts(g.start, rules.tz), title: g.system ? `${g.title} (${g.system})` : g.title,
          detail: [`${W.ttrpg}${gm ? ` ${W.withGm(gm)}` : ''}`, `${clockLabel(time.minutesOf(g.start))} to ${clockLabel(time.minutesOf(g.end))}`, price ? W.seat(money(price)) : '', W.seats(left)].filter(Boolean).join(' · '),
          url: tagged(`${this.page('gm')}?join=${encodeURIComponent(g.id)}`, SRC, 'ttrpg'),
          // the game's own picture, as the games board shows it
          image: this.imageUrl(g.imageId),
        },
      });
    }
    rows.sort((a, b) => a.start - b.start);
    const agenda = rows.slice(0, AGENDA_MAX);
    const items = (fresh?.items || []).filter((t) => t.title && t.url);
    const count = Math.max(Number(fresh?.count) || 0, items.length);
    if (!agenda.length && !items.length) return null;
    const highlight = (agenda.find((r) => !r.weekly && !r.session) || agenda.find((r) => r.session) || agenda[0])?.row.title || '';
    const subject = W.subject(highlight.length <= 28 ? highlight : '');
    return {
      subject,
      title: W.title,
      preheader: W.preheader(agenda.length, count),
      intro: agenda.length ? W.intro : W.quiet,
      agenda: agenda.map((r) => r.row),
      button: agenda.length ? { label: W.button, url: tagged(this.page('events'), SRC, 'events') } : { label: W.book, url: tagged(this.page('book'), SRC, 'tables') },
      section: items.length ? {
        heading: W.newHeading,
        intro: W.newIntro(count),
        tiles: items.map((t) => ({ title: t.title, image: t.image, url: tagged(t.url, SRC, 'shop'), price: t.price ? money(t.price) : '' })),
        link: { label: W.newLink, url: tagged(this.link('/collections/all?sort_by=created-descending'), SRC, 'shop') },
      } : null,
      signoff: NEWS_WORDS.signoff,
    };
  },

  /** An event's price for the list, short: "$10", "Free for library members, $10 otherwise", "Free entry", or its note. No awaits. */
  newsPrice(o, ev = {}) {
    const note = String(ev.priceNote || '').trim();
    if (o.entryFee) return o.memberFree ? `Free for library members, ${money(o.entryFee)} otherwise` : `${money(o.entryFee)} a person`;
    if (ev.freeEntry) return 'Free entry';
    return note;
  },

  /** The Black Friday email, with four of the newest Dice Goblin dice in stock. No awaits. */
  blackFridayContent(dice = { items: [] }) {
    const B = NEWS_WORDS.blackFriday;
    const SRC = 'black-friday';
    return {
      subject: B.subject,
      title: B.title,
      preheader: B.preheader,
      intro: B.intro,
      tiles: (dice?.items || []).filter((t) => t.title && t.url).map((t) => ({ title: t.title, image: t.image, url: tagged(t.url, SRC, 'shop'), price: t.price ? money(t.price) : '' })),
      button: { label: B.button, url: tagged(this.link('/collections/all-dice'), SRC, 'shop') },
      section: { heading: B.rollsHeading, intro: B.rolls, after: B.finePrint },
      signoff: B.signoff,
    };
  },

  /* ---------------- sending ---------------- */
  /**
   * Up to NEWS_A_RUN queued emails (oldest email first; fewer while a refused batch is being halved), from 9am to 8pm
   * and not while paused: each marked 'sending' before it goes; anyone on the stop list by now is marked 'stopped' and
   * not sent, and anything past its email's time 'expired'. Resend down or busy: back on the queue; no answer: 'unknown';
   * refused: see NEWS_PAUSE_AFTER. → { sent, stopped, failed, … } or null.
   */
  async sendNewsBatch(rules, now) {
    const time = new LairTime(rules.tz);
    const hour = time.parts(now).h;
    // --- claimed with no awaits ---
    this.write("UPDATE news_sends SET status = 'queued' WHERE status = 'sending' AND at < ?", now - STUCK_AFTER);
    // still queued once its time has passed: never sent late
    const stale = this.sql.exec(
      "SELECT COUNT(*) AS n FROM news_sends WHERE status = 'queued' AND campaign IN (SELECT id FROM news_campaigns WHERE until_at IS NOT NULL AND until_at <= ?)", now,
    ).toArray()[0]?.n || 0;
    if (stale) this.write("UPDATE news_sends SET status = 'expired', at = ? WHERE status = 'queued' AND campaign IN (SELECT id FROM news_campaigns WHERE until_at IS NOT NULL AND until_at <= ?)", now, now);
    const expired = stale ? { expired: stale } : {};
    if (hour < NEWS_FROM_HOUR || hour >= NEWS_UNTIL_HOUR || this.newsPaused()) return stale ? { sent: 0, stopped: 0, failed: 0, ...expired } : null;
    const meta = (key) => Number(this.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray()[0]?.value) || 0;
    const size = Math.min(NEWS_A_RUN, meta('news-batch') || NEWS_A_RUN);
    const rows = this.sql.exec(
      `SELECT s.campaign, s.email, s.name, c.content FROM news_sends s JOIN news_campaigns c ON c.id = s.campaign
        WHERE s.status = 'queued' ORDER BY c.made_at, s.email LIMIT ?`,
      size,
    ).toArray();
    if (!rows.length) return stale ? { sent: 0, stopped: 0, failed: 0, ...expired } : null;
    let stopped = 0;
    const going = [];
    for (const r of rows) {
      if (this.followupStopped(r.email)) {
        this.write("UPDATE news_sends SET status = 'stopped', at = ? WHERE campaign = ? AND email = ?", now, r.campaign, r.email);
        stopped += 1;
        continue;
      }
      this.write("UPDATE news_sends SET status = 'sending', at = ? WHERE campaign = ? AND email = ? AND status = 'queued'", now, r.campaign, r.email);
      going.push({ r, letter: this.newsLetter(r.email, JSON.parse(r.content)) });
    }
    if (!going.length) return { sent: 0, stopped, failed: 0, ...expired };
    const result = await this.mailMany(going.map((g) => g.letter));
    // --- after the await, only these rows, and only where this run marked them ---
    const mark = (status) => {
      for (const g of going) this.write("UPDATE news_sends SET status = ?, at = ? WHERE campaign = ? AND email = ? AND status = 'sending' AND at = ?", status, now, g.r.campaign, g.r.email, now);
    };
    const setMeta = (key, value) => this.write('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, String(value));
    const base = { stopped, ...expired };
    if (result.ok) {
      mark('sent');
      this.write("DELETE FROM meta WHERE key IN ('news-batch', 'news-refused')");
      return { sent: going.length, failed: 0, ...base };
    }
    // Resend down or busy (or email not set up): all back on the queue for the next run
    if (result.status >= 500 || result.status === 429 || !result.attempted) {
      mark('queued');
      return { sent: 0, failed: 0, retry: going.length, ...base };
    }
    // no answer at all (timed out): it may have gone, so it's never sent again
    if (!result.status) {
      mark('unknown');
      return { sent: 0, failed: 0, unknown: going.length, ...base };
    }
    // refused: a batch is halved and tried again; one email on its own is marked failed, and a run of those pauses
    if (going.length > 1) {
      mark('queued');
      setMeta('news-batch', Math.ceil(going.length / 2));
      return { sent: 0, failed: 0, retry: going.length, ...base };
    }
    mark('failed');
    const refused = meta('news-refused') + 1;
    setMeta('news-refused', refused);
    if (refused >= NEWS_PAUSE_AFTER) {
      setMeta('news-paused', `Resend refused ${refused} emails in a row on their own: ${String(result.message || result.status).slice(0, 200)}`);
      console.error('Lair: news emails paused', result.status, result.message);
    }
    return { sent: 0, failed: 1, ...base };
  },

  /**
   * One news email to one address: the content as made, with that address's unsubscribe (link, and the one-click
   * headers), from NEWS_FROM when it's set. Makes the address's code and key the first time. No awaits.
   */
  newsLetter(email, content, { subject = null } = {}) {
    const k = this.newsKey(email);
    const lair = String(this.env.PUBLIC_URL || 'https://dice-goblin-lair.dicegoblinnz.workers.dev').replace(/\/$/, '');
    const unsubscribe = { label: NEWS_WORDS.unsubscribe, note: NEWS_WORDS.why, url: `${this.page('myLair')}#unsubscribe=${encodeURIComponent(k.ref)}.${k.key}` };
    const headers = { 'List-Unsubscribe': `<${lair}/unsubscribe/${encodeURIComponent(k.ref)}/${k.key}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
    const { subject: own, ...rest } = content;
    const from = String(this.env.NEWS_FROM || '').trim();
    return this.letter(email, subject || own, { ...rest, unsubscribe }, { headers, ...(from ? { from, pinned: true, replyTo: this.env.REPLY_TO || null } : {}) });
  },

  /** An address's unsubscribe code (NEWS-<16 hex>) and key (32 hex), made once and kept. No awaits. → { ref, key } */
  newsKey(email) {
    const mail = lowerEmail(email);
    let row = this.sql.exec('SELECT id, key FROM news_keys WHERE email = ?', mail).toArray()[0];
    if (!row) {
      row = { id: crypto.randomUUID().replace(/-/g, '').slice(0, 16), key: crypto.randomUUID().replace(/-/g, '') };
      this.write('INSERT INTO news_keys (email, id, key, at) VALUES (?, ?, ?, ?)', mail, row.id, row.key, Date.now());
    }
    return { ref: `NEWS-${row.id}`, key: row.key };
  },

  /** The address a news unsubscribe code is for, with its key: { email, key }, or null. No awaits. */
  newsKeyRow(ref) {
    const m = String(ref || '').match(/^NEWS-([0-9a-f]{16})$/);
    if (!m) return null;
    return this.sql.exec('SELECT email, key FROM news_keys WHERE id = ?', m[1]).toArray()[0] || null;
  },

  /* ---------------- a test copy ---------------- */
  /**
   * POST /internal/news-test { campaign: 'weekly' | 'black-friday-2026', to, at }: the email as it would be made at `at`,
   * to `to` only, "[Test]" on its subject; nothing queued or marked (the address gets a news key, so its Unsubscribe
   * works). Doesn't need NEWS_EMAILS. → { ok, subject } or { ok: false, error }
   */
  async newsTest(body) {
    const to = String(body?.to || '').trim();
    const kind = String(body?.campaign || 'weekly').trim();
    if (!isEmail(to)) return { ok: false, error: 'Who to send the test to (to) is not an email address.' };
    if (!emailReady(this.env)) return { ok: false, error: 'Email is not set up.' };
    const rules = await this.rules();
    const at = Number(body?.at) || Date.now();
    const content = await this.newsContent(kind, rules, at);
    if (!content) return { ok: false, error: 'Nothing on and nothing new, so this week has no email.' };
    // --- no awaits until it's sent ---
    const letter = this.newsLetter(to, content, { subject: NEWS_WORDS.test(content.subject) });
    const result = await this.mail(letter);
    return { ok: Boolean(result.ok), subject: letter.subject, ...(result.ok ? {} : { error: result.message || 'Resend refused it.' }) };
  },

  /** For staff and Monday's checks: each email made, and where its sends stand (and why they're paused). No awaits. */
  newsStatus() {
    const paused = this.newsPaused();
    const list = this.sql.exec(
      `SELECT c.id, c.kind, c.made_at AS madeAt, c.subject, c.recipients, c.skipped,
              SUM(s.status = 'sent') AS sent, SUM(s.status IN ('queued', 'sending')) AS waiting, SUM(s.status = 'failed') AS failed, SUM(s.status = 'stopped') AS stopped
         FROM news_campaigns c LEFT JOIN news_sends s ON s.campaign = c.id GROUP BY c.id ORDER BY c.made_at DESC LIMIT 20`,
    ).toArray().map((r) => ({ ...r }));
    return paused ? { paused, campaigns: list } : list;
  },
};

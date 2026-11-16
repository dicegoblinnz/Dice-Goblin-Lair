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
 * Later still (Mo: "can we have it automated inside the staff section to be sent as a weekly template with the chance to
 * edit any possible changes if not just the ability to send the email from staff is good enough"): every email is a
 * draft first. Each Monday from 7am the Lair makes that week's draft by itself; the staff page's Emails tab (owner only:
 * it emails every subscriber) shows it as it will look, lets the owner change the subject, the preview line and the
 * opening words, add a note from Gobgob, leave out any event, session or product, or the new stock altogether, refresh
 * it from the calendar and the shop, send themselves a test, and Send it. NEWS_EMAILS still sends a draft by itself
 * (the weekly at 10am, a one-off when it's due), edits and all, for when Mo wants it hands-free.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair; each
 * keeps its rule: every await first, then one synchronous read-check-write.
 */
import { LairTime, RuleError, addDays, eventOccurrences } from './core.js';
import { emailReady } from './shopify.js';
import { clockLabel } from './email.js';
import { seatPriceOf } from './gm-sessions.js';

export const NEWS_TABLES = [
  // one row an email: status 'draft' (base: its words and products as the Lair made them, edits: the owner's changes,
  // both JSON) until it's sent, then 'queued' (content: what went, renderEmail's content less the unsubscribe; sent_at,
  // sent_by: when and who, 'auto' when NEWS_EMAILS sent it). until_at: none of it goes after this (the weekly by the end of
  // its Tuesday, a one-off after its last day). skipped: a draft with nothing to say ('nothing to say')
  'CREATE TABLE IF NOT EXISTS news_campaigns (id TEXT PRIMARY KEY, kind TEXT NOT NULL, made_at INTEGER NOT NULL, subject TEXT, content TEXT, recipients INTEGER NOT NULL DEFAULT 0, skipped TEXT, until_at INTEGER, status TEXT NOT NULL DEFAULT \'draft\', base TEXT, edits TEXT, updated_at INTEGER, sent_at INTEGER, sent_by TEXT)',
  // who it's for: 'queued', 'sending' (at: when this run took it), 'sent', 'failed' (Resend refused it on its own),
  // 'unknown' (Resend never answered, so it may have gone: never sent again), 'stopped' (on the stop list by then) or
  // 'expired' (still queued when its time passed)
  'CREATE TABLE IF NOT EXISTS news_sends (campaign TEXT NOT NULL, email TEXT NOT NULL, name TEXT, status TEXT NOT NULL, at INTEGER, PRIMARY KEY (campaign, email))',
  'CREATE INDEX IF NOT EXISTS news_sends_queued ON news_sends (status) WHERE status IN (\'queued\', \'sending\')',
  // an address's unsubscribe code and key, made the first time it's sent a news email, and kept
  'CREATE TABLE IF NOT EXISTS news_keys (email TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, key TEXT NOT NULL, at INTEGER NOT NULL)',
];

/** news_campaigns' columns from the drafts (the review, 17 Nov 2026): added on start when a table made before them lacks them */
export const NEWS_COLUMNS = [
  ['news_campaigns', 'status', "TEXT NOT NULL DEFAULT 'draft'"], ['news_campaigns', 'base', 'TEXT'], ['news_campaigns', 'edits', 'TEXT'],
  ['news_campaigns', 'updated_at', 'INTEGER'], ['news_campaigns', 'sent_at', 'INTEGER'], ['news_campaigns', 'sent_by', 'TEXT'],
];

/** Emails sent a run: one Resend batch (Resend takes 100 a batch) */
export const NEWS_A_RUN = 100;
/** The weekly email goes from this hour on a Monday, Lair time (Mo, 1 Nov 2026: "Monday 10am"), when NEWS_EMAILS sends it */
export const WEEKLY_FROM_HOUR = 10;
/** Its draft is made from this hour on a Monday, so it's there to look over before then */
export const WEEKLY_DRAFT_HOUR = 7;
/** The longest subject, preview line, opening words and note the owner can write (characters) */
export const NEWS_LIMITS = { subject: 120, preheader: 200, intro: 1200, note: 1200 };
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

/** The emails' names on the staff page */
export const NEWS_KIND_LABELS = { weekly: 'This week at the Lair', 'black-friday-2026': 'Black Friday 2026' };
/** What the Emails tab's routes say when they can't (staff words: plain) */
export const NEWS_STAFF_WORDS = {
  missing: 'That email isn’t here any more. Reload the Emails tab.',
  sent: 'That email has been sent, so it can’t be changed now.',
  nothing: 'This email has nothing in it to send. Refresh it, or put something back in.',
  tooLate: 'This email’s time has passed, so it can’t be sent now.',
  noKind: 'There’s no email of that kind.',
  notOn: 'That email isn’t on yet.',
  noEmail: 'Email isn’t set up for the Lair app, so nothing can be sent.',
  noTo: 'There’s no email address to send the test to. Type one in.',
  long: (what, most) => `The ${what} can be at most ${most} characters.`,
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
   * Makes this Monday's weekly draft (from 7am) and the drafts of one-offs switched on, sends by itself what NEWS_EMAILS
   * switches on and is due, then sends a batch from the queue. → { drafted, made, sent, … } or null.
   */
  async newsUpkeep(rules, now) {
    if (!emailReady(this.env)) return null;
    const on = newsSwitches(this.env);
    const result = {};
    for (const due of this.newsDraftsDue(rules, now, on)) {
      try {
        const made = await this.makeNewsDraft(due, rules, now);
        if (made) (result.drafted ||= []).push(made);
      } catch (error) {
        console.error(`Lair: could not make the news email ${due.id}`, error);
        (result.errors ||= []).push({ id: due.id, error: String(error?.message || error).slice(0, 300) });
      }
    }
    for (const id of this.newsAutoDue(rules, now, on)) {
      try {
        const made = await this.queueNews(id, rules, now, 'auto', { rebuild: true });
        if (made) (result.made ||= []).push(made);
      } catch (error) {
        console.error(`Lair: could not send the news email ${id}`, error);
        (result.errors ||= []).push({ id, error: String(error?.message || error).slice(0, 300) });
      }
    }
    const sent = await this.sendNewsBatch(rules, now);
    if (sent) result.sent = sent;
    return Object.keys(result).length ? result : null;
  },

  /** This Monday's weekly email's id (weekly-YYYY-MM-DD, the Monday of `now`'s week, Lair time). No awaits. */
  weeklyId(rules, now) {
    const time = new LairTime(rules.tz);
    const today = time.key(now);
    return `weekly-${addDays(today, -((time.weekday(today) + 6) % 7))}`;
  },

  /**
   * Drafts to make at `now` that aren't made yet: this week's weekly on Monday from 7am (until 8pm), and each one-off
   * switched on, in its days. No awaits. → [{ id, kind }]
   */
  newsDraftsDue(rules, now, on) {
    const time = new LairTime(rules.tz);
    const today = time.key(now);
    const hour = time.parts(now).h;
    if (hour >= NEWS_UNTIL_HOUR) return [];
    const due = [];
    if (time.weekday(today) === 1 && hour >= WEEKLY_DRAFT_HOUR) due.push({ id: this.weeklyId(rules, now), kind: 'weekly' });
    for (const [id, c] of Object.entries(NEWS_CAMPAIGNS)) {
      if (on.has(id) && today >= c.from && today <= c.until && hour >= NEWS_FROM_HOUR) due.push({ id, kind: id });
    }
    return due.filter((d) => !this.newsRow(d.id));
  },

  /**
   * Drafts NEWS_EMAILS sends by itself now: this Monday's weekly from 10am, a one-off in its days from 9am; each still a
   * draft with something to say. No awaits. → [id]
   */
  newsAutoDue(rules, now, on) {
    if (!on.size) return [];
    const time = new LairTime(rules.tz);
    const today = time.key(now);
    const hour = time.parts(now).h;
    if (hour < NEWS_FROM_HOUR || hour >= NEWS_UNTIL_HOUR) return [];
    const ids = [];
    if (on.has('weekly') && time.weekday(today) === 1 && hour >= WEEKLY_FROM_HOUR) ids.push(this.weeklyId(rules, now));
    for (const [id, c] of Object.entries(NEWS_CAMPAIGNS)) if (on.has(id) && today >= c.from && today <= c.until) ids.push(id);
    return ids.filter((id) => {
      const row = this.newsRow(id);
      return row && row.status === 'draft' && !row.skipped;
    });
  },

  /** One email's row, or null. No awaits. */
  newsRow(id) {
    return this.sql.exec('SELECT * FROM news_campaigns WHERE id = ?', String(id || '')).toArray()[0] || null;
  },

  /**
   * One draft made: its words and products (newsContent: from Shopify and the calendar), kept as its base. Every await
   * first; then, if nobody made it meanwhile, one write. Nothing to say (the weekly with nothing on and nothing new): a
   * draft marked skipped, which never goes. → { id, skipped? } or null
   */
  async makeNewsDraft(due, rules, now) {
    const content = await this.newsContent(due.kind, rules, now);
    // --- no awaits from here ---
    if (this.newsRow(due.id)) return null;
    this.write(
      "INSERT INTO news_campaigns (id, kind, made_at, subject, base, status, skipped, until_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)",
      due.id, due.kind, now, content?.subject || null, content ? JSON.stringify(content) : null, content ? null : 'nothing to say', this.newsUntil(due, rules, now), now,
    );
    return content ? { id: due.id } : { id: due.id, skipped: 'nothing to say' };
  },

  /**
   * A draft sent: everyone subscribed in Shopify less the stop list queued for it, with the draft as edited (newsFinal).
   * Every await first (Shopify's subscribers); then, if it's still a draft, one write of the lot. by: who sent it ('auto'
   * for NEWS_EMAILS, else the staff member's customer id). → { id, recipients } or null when it isn't a draft any more.
   */
  async queueNews(id, rules, now, by, { rebuild = false } = {}) {
    const before = this.newsRow(id);
    if (!before || before.status !== 'draft') return null;
    if (!rebuild && (before.skipped || !before.base)) throw new RuleError(NEWS_STAFF_WORDS.nothing, 422);
    if (before.until_at && before.until_at <= now) throw new RuleError(NEWS_STAFF_WORDS.tooLate, 422);
    // sent by itself (the review): made again from the calendar and the shop as they are now, the owner's edits kept, so
    // seats left and stock aren't three hours old
    const fresh = rebuild ? await this.newsContent(before.kind, rules, now) : undefined;
    const people = await this.shopify.marketingSubscribers();
    // --- no awaits from here ---
    let row = this.newsRow(id);
    if (!row || row.status !== 'draft') return null;
    if (rebuild) {
      this.write(
        "UPDATE news_campaigns SET base = ?, subject = ?, skipped = ?, updated_at = ? WHERE id = ? AND status = 'draft'",
        fresh ? JSON.stringify(fresh) : null, fresh?.subject || null, fresh ? null : 'nothing to say', now, id,
      );
      row = this.newsRow(id);
      if (!fresh) return { id, recipients: 0, skipped: 'nothing to say' };
    }
    const content = this.newsFinal(row);
    if (!this.newsHasSomething(content)) throw new RuleError(NEWS_STAFF_WORDS.nothing, 422);
    const list = people.filter((p) => isEmail(p.email) && !this.followupStopped(p.email));
    this.write(
      "UPDATE news_campaigns SET status = 'queued', subject = ?, content = ?, recipients = ?, sent_at = ?, sent_by = ?, updated_at = ? WHERE id = ? AND status = 'draft'",
      content.subject, JSON.stringify(content), list.length, now, String(by || 'auto'), now, id,
    );
    for (const p of list) this.write("INSERT OR IGNORE INTO news_sends (campaign, email, name, status, at) VALUES (?, ?, ?, 'queued', ?)", id, lowerEmail(p.email), p.firstName || null, now);
    return { id, recipients: list.length };
  },

  /**
   * Whether an email as it will go has something in it: a weekly needs an event or session, or new stock with a product
   * left in (the review: a heading with nothing under it isn't an email); a one-off always has its offer. No awaits.
   */
  newsHasSomething(content) {
    if (!content) return false;
    if (content.kind !== 'weekly') return true;
    return (content.agenda || []).length > 0 || ((content.section && content.section.tiles) || []).length > 0;
  },

  /**
   * A draft as it will go: its base with the owner's edits (their subject, preview line, opening words and note; the
   * events, sessions and products they left out, by key; the new stock left out altogether). No awaits. → content
   */
  newsFinal(row) {
    const base = row.base ? JSON.parse(row.base) : null;
    if (!base) return null;
    const e = row.edits ? JSON.parse(row.edits) : {};
    const hidden = new Set(Array.isArray(e.hide) ? e.hide.map(String) : []);
    const out = { ...base };
    if (typeof e.subject === 'string' && e.subject.trim()) out.subject = e.subject.trim();
    if (typeof e.preheader === 'string' && e.preheader.trim()) out.preheader = e.preheader.trim();
    if (typeof e.intro === 'string' && e.intro.trim()) out.intro = e.intro.trim();
    if (typeof e.note === 'string' && e.note.trim()) out.quote = e.note.trim();
    if (Array.isArray(base.agenda)) out.agenda = base.agenda.filter((a) => !hidden.has(String(a.key)));
    if (Array.isArray(base.tiles)) out.tiles = base.tiles.filter((t) => !hidden.has(String(t.key)));
    if (base.section) {
      const tiles = Array.isArray(base.section.tiles) ? base.section.tiles.filter((t) => !hidden.has(String(t.key))) : base.section.tiles;
      // the weekly's new stock with every product left out goes too: a heading with nothing under it isn't worth sending
      out.section = base.kind === 'weekly' && (e.hideNew === true || !(tiles || []).length) ? null : { ...base.section, tiles };
    }
    return out;
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
      rows.push({ start: o.start, weekly: ev.repeat === 'weekly', row: { key: `e:${o.eventId}@${time.key(o.start)}`, when, title: o.title, detail: [hours, this.newsPrice(o, ev)].filter(Boolean).join(' · '), url: tagged(this.page('events'), SRC, 'events'), image: pictures.get(o.eventId) || null } });
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
          key: `g:${g.id}`,
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
      kind: 'weekly',
      subject,
      title: W.title,
      preheader: W.preheader(agenda.length, count),
      intro: agenda.length ? W.intro : W.quiet,
      agenda: agenda.map((r) => r.row),
      button: agenda.length ? { label: W.button, url: tagged(this.page('events'), SRC, 'events') } : { label: W.book, url: tagged(this.page('book'), SRC, 'tables') },
      section: items.length ? {
        heading: W.newHeading,
        intro: W.newIntro(count),
        tiles: items.map((t) => ({ key: `p:${t.url}`, title: t.title, image: t.image, url: tagged(t.url, SRC, 'shop'), price: t.price ? money(t.price) : '' })),
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
      kind: 'black-friday-2026',
      subject: B.subject,
      title: B.title,
      preheader: B.preheader,
      intro: B.intro,
      tiles: (dice?.items || []).filter((t) => t.title && t.url).map((t) => ({ key: `p:${t.url}`, title: t.title, image: t.image, url: tagged(t.url, SRC, 'shop'), price: t.price ? money(t.price) : '' })),
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
        WHERE s.status = 'queued' AND c.status = 'queued' ORDER BY c.sent_at, s.email LIMIT ?`,
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

  /* ---------------- the staff page's Emails tab (owner only) ---------------- */
  /**
   * GET /news: the emails, newest first (the last 12), each as the tab shows it: where it stands, what's in it (every
   * event, session and product, hidden or not, by key), the owner's edits and the words they replace, and a preview of
   * it as it will go. With whether email works, what NEWS_EMAILS sends by itself, a pause and the one-offs on offer.
   * Owner only. No awaits.
   */
  newsStaffList(who, rules, now = Date.now()) {
    this.requireStaff(who, 'news');
    const time = new LairTime(rules.tz);
    const today = time.key(now);
    const rows = this.sql.exec('SELECT * FROM news_campaigns ORDER BY made_at DESC LIMIT 12').toArray();
    return {
      ready: emailReady(this.env),
      on: [...newsSwitches(this.env)],
      paused: this.newsPaused(),
      week: this.weeklyId(rules, now),
      kinds: [
        { kind: 'weekly', label: 'This week at the Lair' },
        ...Object.entries(NEWS_CAMPAIGNS).filter(([, c]) => today >= c.from && today <= c.until).map(([kind]) => ({ kind, label: NEWS_KIND_LABELS[kind] || kind })),
      ],
      emails: rows.map((r) => this.newsStaffView(r, now)),
    };
  },

  /** One email as the tab shows it. No awaits. */
  newsStaffView(row, now) {
    const base = row.base ? JSON.parse(row.base) : null;
    const e = row.edits ? JSON.parse(row.edits) : {};
    const hidden = new Set(Array.isArray(e.hide) ? e.hide.map(String) : []);
    const draft = row.status === 'draft';
    const content = draft ? this.newsFinal(row) : row.content ? JSON.parse(row.content) : null;
    const counts = draft ? null : this.sql.exec(
      `SELECT SUM(status = 'sent') AS sent, SUM(status IN ('queued', 'sending')) AS waiting, SUM(status IN ('failed', 'unknown')) AS failed,
              SUM(status = 'stopped') AS stopped, SUM(status = 'expired') AS expired FROM news_sends WHERE campaign = ?`, row.id,
    ).toArray()[0];
    const items = (list) => (Array.isArray(list) ? list : []).map((x) => ({ key: String(x.key || ''), title: x.title, when: x.when || null, detail: x.detail || '', price: x.price || '', image: x.image || null, hidden: hidden.has(String(x.key)) }));
    const part = base?.section || null;
    let preview = null;
    if (content) {
      const unsubscribe = { label: NEWS_WORDS.unsubscribe, note: NEWS_WORDS.why, url: this.page('myLair') };
      const { subject, ...rest } = content;
      preview = this.letter('preview@dicegoblin.nz', subject, { ...rest, unsubscribe }).html;
    }
    return {
      id: row.id, kind: row.kind, label: NEWS_KIND_LABELS[row.kind] || row.kind, status: draft ? 'draft' : 'sent',
      madeAt: row.made_at, updatedAt: row.updated_at || row.made_at, sentAt: row.sent_at || null,
      sentBy: row.sent_by === 'auto' ? 'auto' : row.sent_by ? 'staff' : null, until: row.until_at || null,
      expired: Boolean(draft && row.until_at && row.until_at <= now), skipped: row.skipped || null,
      subject: content?.subject || row.subject || '',
      edits: { subject: e.subject || '', preheader: e.preheader || '', intro: e.intro || '', note: e.note || '', hideNew: e.hideNew === true },
      defaults: base ? { subject: base.subject || '', preheader: base.preheader || '', intro: base.intro || '' } : null,
      agenda: items(base?.agenda),
      tiles: items(base?.tiles),
      newStock: part && Array.isArray(part.tiles) && part.tiles.length ? { heading: part.heading || '', tiles: items(part.tiles) } : null,
      recipients: draft ? null : row.recipients,
      counts: counts ? { sent: counts.sent || 0, waiting: counts.waiting || 0, failed: counts.failed || 0, stopped: counts.stopped || 0, expired: counts.expired || 0 } : null,
      preview,
    };
  },

  /**
   * POST /news/draft { kind }: this week's weekly draft (or a one-off's, in its days), made now if it isn't there; one
   * that's there already is left as it is. Owner only. → GET /news's answer
   */
  async newsStaffDraft(body, who) {
    this.requireStaff(who, 'news');
    const rules = await this.rules();
    const now = Date.now();
    const kind = String(body?.kind || 'weekly');
    const time = new LairTime(rules.tz);
    const today = time.key(now);
    let due;
    if (kind === 'weekly') due = { id: this.weeklyId(rules, now), kind };
    else if (NEWS_CAMPAIGNS[kind] && today >= NEWS_CAMPAIGNS[kind].from && today <= NEWS_CAMPAIGNS[kind].until) due = { id: kind, kind };
    else throw new RuleError(NEWS_STAFF_WORDS.noKind, 422);
    if (!this.newsRow(due.id)) await this.makeNewsDraft(due, rules, now);
    return this.newsStaffList(who, rules, Date.now());
  },

  /**
   * POST /news/:id { subject, preheader, intro, note, hide, hideNew }: the owner's changes to a draft. A word field sent
   * empty goes back to the Lair's own words; hide: the keys of the events, sessions and products to leave out (only
   * this draft's); hideNew: leave the new stock out. Only what's sent changes. Owner only. No awaits. → GET /news's answer
   */
  newsStaffEdit(id, body, who, rules) {
    this.requireStaff(who, 'news');
    const row = this.newsRow(id);
    if (!row) throw new RuleError(NEWS_STAFF_WORDS.missing, 404);
    if (row.status !== 'draft') throw new RuleError(NEWS_STAFF_WORDS.sent, 409);
    const e = row.edits ? JSON.parse(row.edits) : {};
    const names = { subject: 'subject', preheader: 'preview line', intro: 'opening words', note: 'note' };
    for (const field of Object.keys(NEWS_LIMITS)) {
      if (!(field in (body || {}))) continue;
      const value = String(body[field] ?? '').replace(/\r\n/g, '\n').trim();
      if (value.length > NEWS_LIMITS[field]) throw new RuleError(NEWS_STAFF_WORDS.long(names[field], NEWS_LIMITS[field]), 422);
      if (field === 'subject' || field === 'preheader') e[field] = value.replace(/\s+/g, ' ');
      else e[field] = value;
    }
    if (Array.isArray(body?.hide)) {
      const base = row.base ? JSON.parse(row.base) : {};
      const keys = new Set([...(base.agenda || []), ...(base.tiles || []), ...(base.section?.tiles || [])].map((x) => String(x.key)));
      e.hide = [...new Set(body.hide.map(String).filter((k) => keys.has(k)))];
    }
    if (typeof body?.hideNew === 'boolean') e.hideNew = body.hideNew;
    this.write('UPDATE news_campaigns SET edits = ?, updated_at = ? WHERE id = ? AND status = \'draft\'', JSON.stringify(e), Date.now(), id);
    return this.newsStaffList(who, rules, Date.now());
  },

  /**
   * POST /news/:id/refresh: a draft made again from the calendar and the shop as they are now, keeping the owner's
   * edits (what they left out stays out when it's still there). Owner only. → GET /news's answer
   */
  async newsStaffRefresh(id, who) {
    this.requireStaff(who, 'news');
    const rules = await this.rules();
    const before = this.newsRow(id);
    if (!before) throw new RuleError(NEWS_STAFF_WORDS.missing, 404);
    if (before.status !== 'draft') throw new RuleError(NEWS_STAFF_WORDS.sent, 409);
    const now = Date.now();
    const content = await this.newsContent(before.kind, rules, now);
    // --- no awaits from here ---
    this.write(
      "UPDATE news_campaigns SET base = ?, subject = ?, skipped = ?, updated_at = ? WHERE id = ? AND status = 'draft'",
      content ? JSON.stringify(content) : null, content?.subject || null, content ? null : 'nothing to say', now, id,
    );
    return this.newsStaffList(who, rules, now);
  },

  /**
   * POST /news/:id/test { to }: one copy of the email as it will go, "[Test]" on its subject, to `to` or else the owner's
   * own account email. Nothing queued or marked. Owner only. → { ok, to, subject }
   */
  async newsStaffTest(id, body, who) {
    this.requireStaff(who, 'news');
    if (!emailReady(this.env)) throw new RuleError(NEWS_STAFF_WORDS.noEmail, 503);
    const typed = String(body?.to || '').trim();
    let to = isEmail(typed) ? typed : '';
    if (!to && typed) throw new RuleError(NEWS_STAFF_WORDS.noTo, 422);
    if (!to && who.customerId) to = (await this.accountEmail(who.customerId))?.email || '';
    if (!to) throw new RuleError(NEWS_STAFF_WORDS.noTo, 422);
    // --- no awaits until it's sent ---
    const row = this.newsRow(id);
    if (!row) throw new RuleError(NEWS_STAFF_WORDS.missing, 404);
    const content = row.status === 'draft' ? this.newsFinal(row) : row.content ? JSON.parse(row.content) : null;
    if (!content) throw new RuleError(NEWS_STAFF_WORDS.nothing, 422);
    const letter = this.newsLetter(to, content, { subject: NEWS_WORDS.test(content.subject) });
    const result = await this.mail(letter);
    if (!result.ok) throw new RuleError(`The test didn’t go: ${String(result.message || 'Resend refused it.').slice(0, 200)}`, 502);
    return { ok: true, to, subject: letter.subject };
  },

  /**
   * POST /news/:id/send: the draft, as edited, to everyone subscribed in Shopify less the stop list; the first batch goes
   * straight away from 9am to 8pm, the rest with the 10-minute run (outside those hours, from 9am). Owner only.
   * → { sent: { id, recipients }, …GET /news's answer }
   */
  async newsStaffSend(id, who) {
    this.requireStaff(who, 'news');
    if (!emailReady(this.env)) throw new RuleError(NEWS_STAFF_WORDS.noEmail, 503);
    const rules = await this.rules();
    const row = this.newsRow(id);
    if (!row) throw new RuleError(NEWS_STAFF_WORDS.missing, 404);
    if (row.status !== 'draft') throw new RuleError(NEWS_STAFF_WORDS.sent, 409);
    if (!this.newsHasSomething(this.newsFinal(row))) throw new RuleError(NEWS_STAFF_WORDS.nothing, 422);
    const now = Date.now();
    const made = await this.queueNews(id, rules, now, who.customerId || 'staff');
    if (!made) throw new RuleError(NEWS_STAFF_WORDS.sent, 409);
    this.later(this.sendNewsBatch(rules, Date.now()));
    return { sent: made, ...this.newsStaffList(who, rules, Date.now()) };
  },

  /** GET /news/audience: how many it would go to now (subscribed in Shopify, less the stop list). Owner only. → { count } */
  async newsAudience(who) {
    this.requireStaff(who, 'news');
    const people = await this.shopify.marketingSubscribers();
    return { count: people.filter((p) => isEmail(p.email) && !this.followupStopped(p.email)).length };
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

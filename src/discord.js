/**
 * Round 14, Discord (contract v14-discord). Mo (10 Oct 2026): "Can we build a discord mod or something and make it link to
 * the website for dice goblin to organize and fit people in, inside the discord? And update the website too?" He picked
 * all four parts: TTRPG sessions, events, table bookings, and auto-posts with seat pings.
 *
 * The bot is another front door to the same Lair, like the POS tile: a seat taken in Discord is a seat taken on the
 * website, with the same rules, codes and emails. Discord sends interactions to the Worker (POST /discord/interactions,
 * signed with Ed25519); the Worker checks the signature and hands them to the Lair (/internal/discord/interaction).
 * Everything is HTTP (slash commands, buttons, selects and modals), with no gateway connection, so it runs on the free plan.
 *
 * - Who: a Discord account linked to a Dice Goblin account (My Lair › Link Discord, through Discord's own sign-in) books as
 *   that member, in one tap when their profile has a mobile. Anyone else books as a guest through a pop-up (name, email,
 *   mobile), as on the website; what they make is theirs in Discord (discord_items) and joins their account once they link.
 * - Discord acts as a customer, never as staff: the bot can't do anything the public website can't. Only /lair-setup is
 *   for Discord's server managers (their Discord permission, checked on every click).
 * - Posts: each TTRPG session (one post per series, moved on to its next date as each session ends) and each event date
 *   in the next week goes up in the channel picked with /lair-setup, with a live seat count, its buttons and, for a
 *   session, a thread for its chat. A seat that opens up in a full session or event in the next week pings the role
 *   picked, and a round-up of today's spare seats goes up once a day at midday when there are any.
 *
 * These are methods of the Lair Durable Object (Object.assign onto its prototype in lair.js), so `this` is the Lair; each
 * keeps its rule: every await first, then one synchronous read-check-write. Discord calls that follow a write (posting)
 * claim their row first. The top of the file also holds what the Worker needs before the Lair is involved (the
 * signature check, and the deferred answer when the Lair is slow).
 */
import {
  HOUR, MIN, LairTime, RuleError, addDays, checkMobile, checkTableBooking, eventOccurrences, findOccurrence, isFree, lairTime,
  maxOnlineTables, openWindow, shopTableOpen,
} from './core.js';
import { clockLabel } from './email.js';

export const DISCORD_API = 'https://discord.com/api/v10';
export const DISCORD_UA = 'DiscordBot (https://www.dicegoblin.nz, 1.0)';
/**
 * What the bot needs in its channels: view channel, send messages, send in threads, make public threads, embed links,
 * read history, manage threads (its own posts' threads in a forum) and mention everyone (only so a seat ping can mention
 * the role picked when that role isn't set as mentionable; every message says which roles it may ping).
 */
export const BOT_PERMISSIONS = '326417730560';
export const EPHEMERAL = 64;
export const INTERACTION = { PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4, MODAL: 5 };
export const RESPONSE = { PONG: 1, MESSAGE: 4, DEFER_MESSAGE: 5, DEFER_UPDATE: 6, UPDATE: 7, CHOICES: 8, MODAL: 9 };
const COMPONENT = { ROW: 1, BUTTON: 2, SELECT: 3, TEXT: 4, ROLE_SELECT: 6, CHANNEL_SELECT: 8, LABEL: 18 };
const STYLE = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4, LINK: 5 };
export const CHANNEL = { TEXT: 0, ANNOUNCEMENT: 5, FORUM: 15 };
const POSTABLE = [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT, CHANNEL.FORUM];
const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;
/** The theme's colours: potion purple for TTRPG sessions and events, goblin green for anything booked */
const POTION = 0xa77bff;
const GOBLIN = 0x46d06c;

const DAY = 24 * HOUR;
/** /games and /events list the next fortnight */
const LIST_DAYS = 14;
/** Event dates go up a week ahead (a weekly event would otherwise fill the channel); sessions as far as the board shows */
const EVENT_POST_DAYS = 7;
/** A seat or place that opens up pings only for something in the next week, and at most every 30 minutes for each post */
const PING_DAYS = 7;
const PING_GAP = 30 * MIN;
/** A Link Discord started on the website has 10 minutes to come back */
const STATE_TTL = 10 * MIN;
/** After a booking changes, the posts catch up this long after (so a burst of changes is one round of edits) */
const SYNC_DELAY = 2000;
/** Discord calls one round of posting makes at most (Discord's limits are per channel); the rest wait for the next */
const SYNC_BUDGET = 12;
/** A post Discord refused is tried again after this long, up to MAX_TRIES times */
const RETRY_FAILED = 30 * MIN;
const MAX_TRIES = 5;
/** A post whose create never came back is tried again after this long (with the same nonce, so it's never doubled) */
const CREATING_STALE = 10 * MIN;
/** The daily round-up of today's spare seats goes up from midday, Lair time */
const DIGEST_HOUR = 12;
/** Slash commands Discord refused are registered again after an hour */
const COMMANDS_RETRY = HOUR;
/** Discord-made guest bookings join an account when it links, if they're upcoming or ended in the last 30 days */
const ADOPT_DAYS = 30;
/** Threads stay in the channel list for a week of quiet (Discord's longest) */
const THREAD_ARCHIVE = 10080;

const trimmed = (v, max) => String(v ?? '').trim().slice(0, max);
const clip = (v, max) => {
  const text = String(v ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const money = (cents) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** The ids the Lair makes (bk_…, gm_…, ej_…, in_…) and Discord's snowflakes */
const ID = /^[A-Za-z0-9_-]{3,64}$/;
const SNOWFLAKE = /^\d{5,25}$/;
/** A member code typed among friends' names (SJ-OWLBEAR-17, sj owlbear 17) */
const MEMBER_CODE = /^[A-Za-z]{2}[\s-]?[A-Za-z]{3,14}[\s-]?\d{1,2}$/;
/** A session's experience level in the games board's words (lair-session-form.js) */
const LEVEL_WORDS = { new: 'New players welcome', some: 'Some experience', veteran: 'Veterans' };
/** What /table's setup choices mean on a booking (the booking page's extras) */
const SETUPS = { board: [], wargame: ['wargame'], bigbox: ['bigbox'] };
const SETUP_CODES = { board: 'b', wargame: 'w', bigbox: 'x' };
const SETUP_FROM_CODE = { b: [], w: ['wargame'], x: ['bigbox'] };

/** Every message a customer can see, word for word in the contract */
export const DISCORD_WORDS = {
  guildOnly: 'Gobgob only works in the Dice Goblin server.',
  who: 'Gobgob could not tell who you are. Try again.',
  oldButton: "That button's from an older message. Run the command again.",
  unknown: "Gobgob doesn't know that one. Try /games, /events, /table or /mylair.",
  broken: "Something went wrong on Gobgob's side. Try again, or book on dicegoblin.nz.",
  sessionGone: 'That session has finished or come off the board.',
  eventGone: "That date isn't on the calendar any more.",
  managers: 'Only server managers can set Gobgob up.',
  day: 'Pick a day from the list.',
  time: 'Pick a start time from the list.',
  people: 'Tell Gobgob how many of you are coming (1 to 24).',
  hours: 'Bookings are 1 to 8 hours.',
  noTables: "The Lair's packed then. Try another day, or call us and we'll see what we can do.",
  taken: 'Someone just grabbed that table. Here\'s what\'s left:',
  linkOff: "Discord linking isn't switched on yet.",
  linkLogin: 'Log in to link your Discord.',
  linkExpired: 'That Discord link has expired. Tap Link Discord again.',
  linkRefused: "Discord didn't let Gobgob in. Tap Link Discord and try again.",
  linkDown: "Discord didn't answer just now. Try again in a minute.",
  gone: "That's already gone.",
  slow: 'Gobgob took a moment there. Tap the button again.',
};

/* ---------------- the Worker's part: signatures and late answers ---------------- */
const hexBytes = (hex) => {
  const text = String(hex || '');
  if (!text || text.length % 2 || !/^[0-9a-f]+$/i.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
};
let verifyKey = null;

/**
 * Discord signs every interaction: Ed25519 over the timestamp header and the raw body, with the app's public key. Anything
 * that doesn't check out is refused (Discord tests this with bad signatures when the endpoint is saved, and now and then
 * after). Never throws.
 */
export async function verifyDiscord(rawBody, signature, timestamp, publicKey) {
  const sig = hexBytes(signature);
  const key = hexBytes(publicKey);
  if (!sig || sig.length !== 64 || !key || key.length !== 32 || !timestamp) return false;
  try {
    if (!verifyKey || verifyKey.hex !== publicKey) verifyKey = { hex: publicKey, key: await crypto.subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify']) };
    return await crypto.subtle.verify({ name: 'Ed25519' }, verifyKey.key, sig, new TextEncoder().encode(`${timestamp}${rawBody}`));
  } catch {
    return false;
  }
}

/**
 * Whether the answer changes the message a button (or a modal's button) is on: Gobgob's private cards change in place,
 * while a public post's buttons answer with a new message only the person who tapped sees.
 */
export const inPlace = (interaction) =>
  [INTERACTION.COMPONENT, INTERACTION.MODAL].includes(interaction?.type) && Boolean(interaction.message)
  && (Number(interaction.message.flags) & EPHEMERAL) === EPHEMERAL;

/** What the Worker answers when the Lair is slow (Discord waits 3 seconds): a private "thinking", or a quiet acknowledgement for a card that changes in place */
export function deferFor(interaction) {
  if (interaction?.type === INTERACTION.AUTOCOMPLETE) return { type: RESPONSE.CHOICES, data: { choices: [] } };
  if (inPlace(interaction)) return { type: RESPONSE.DEFER_UPDATE };
  return { type: RESPONSE.DEFER_MESSAGE, data: { flags: EPHEMERAL } };
}

/** The Lair's answer, once it came, put where the deferred answer is (the interaction's token lasts 15 minutes) */
export async function finishDeferred(env, interaction, answer) {
  if (interaction?.type === INTERACTION.AUTOCOMPLETE) return { ok: true, skipped: true };
  const appId = env.DISCORD_APPLICATION_ID || interaction.application_id;
  const shown = answer && [RESPONSE.MESSAGE, RESPONSE.UPDATE].includes(answer.type);
  const data = shown ? { ...(answer.data || {}) } : { content: DISCORD_WORDS.slow, embeds: [], components: [] };
  // Ephemeral or not was settled by the deferred answer
  delete data.flags;
  try {
    const res = await fetch(`${DISCORD_API}/webhooks/${appId}/${interaction.token}/messages/@original`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', 'User-Agent': DISCORD_UA }, body: JSON.stringify(data),
    });
    return { ok: res.ok, status: res.status };
  } catch (error) {
    console.error('Lair: could not finish a late Discord answer', error);
    return { ok: false };
  }
}

/** The slash commands, as Discord's bulk overwrite takes them: in the server only, installed with the bot */
export function discordCommands() {
  const base = { type: 1, contexts: [0], integration_types: [0] };
  return [
    { ...base, name: 'games', description: 'TTRPG sessions at the Lair with seats to grab' },
    { ...base, name: 'events', description: "What's on at the Lair: sign up, say you're coming or join a waitlist" },
    {
      ...base, name: 'table', description: 'Book a table at the Lair',
      options: [
        { type: 3, name: 'day', description: 'Which day', required: true, autocomplete: true },
        { type: 3, name: 'time', description: 'What time you start', required: true, autocomplete: true },
        { type: 4, name: 'people', description: 'How many of you', required: true, min_value: 1, max_value: 24 },
        { type: 4, name: 'hours', description: 'How many hours (2 if you leave it out)', required: false, min_value: 1, max_value: 8 },
        {
          type: 3, name: 'setup', description: "What you're playing", required: false,
          choices: [{ name: 'Board or card games', value: 'board' }, { name: 'Wargame (double tables)', value: 'wargame' }, { name: 'Big box game (double tables)', value: 'bigbox' }],
        },
      ],
    },
    { ...base, name: 'mylair', description: 'Your bookings, seats and sign-ups at the Lair' },
    { ...base, name: 'link', description: 'Link your Discord to your Dice Goblin account' },
    { ...base, name: 'lair-setup', description: 'Pick where Gobgob posts sessions and events (server managers)', default_member_permissions: '32' },
  ];
}

/** A short, stable fingerprint (posts' content, event handles in button ids, nonces). Not for security. */
export function shortHash(text) {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return `${a.toString(36).padStart(7, '0')}${b.toString(36).padStart(7, '0')}`;
}

/** An event date in a button's id: its handle's fingerprint and the day (handles can be long; ids hold 100 characters) */
export const occRef = (occurrenceId) => {
  const m = String(occurrenceId || '').match(/^(.+)@(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${shortHash(m[1]).slice(0, 10)}@${m[2]}${m[3]}${m[4]}` : null;
};

/* ---------------- message pieces ---------------- */
const cid = (...parts) => ['dg', ...parts].join(':');
const cidParts = (customId) => {
  const parts = String(customId || '').split(':');
  return parts[0] === 'dg' ? parts.slice(1) : null;
};
const button = (label, customId, style = STYLE.SECONDARY, { disabled = false, emoji = null } = {}) => ({
  type: COMPONENT.BUTTON, style, label: clip(label, 80), custom_id: customId, ...(disabled ? { disabled: true } : {}), ...(emoji ? { emoji: { name: emoji } } : {}),
});
const linkButton = (label, url) => ({ type: COMPONENT.BUTTON, style: STYLE.LINK, label: clip(label, 80), url: String(url).slice(0, 512) });
const row = (...components) => ({ type: COMPONENT.ROW, components: components.filter(Boolean).slice(0, 5) });
const selectRow = (customId, placeholder, options) => row({ type: COMPONENT.SELECT, custom_id: customId, placeholder: clip(placeholder, 150), options: options.slice(0, 25) });
/** A modal's text box, inside a Label (Discord's current shape; the old Action Row shape is deprecated) */
const textBox = (id, label, { value = '', required = true, paragraph = false, max = 100, placeholder = '', description = '' } = {}) => ({
  type: COMPONENT.LABEL, label: clip(label, 45), ...(description ? { description: clip(description, 100) } : {}),
  component: {
    type: COMPONENT.TEXT, custom_id: id, style: paragraph ? 2 : 1, required, max_length: max,
    ...(value ? { value: String(value).slice(0, max) } : {}), ...(placeholder ? { placeholder: clip(placeholder, 100) } : {}),
  },
});
const modal = (customId, title, boxes) => ({ type: RESPONSE.MODAL, data: { custom_id: customId, title: clip(title, 45), components: boxes.slice(0, 5) } });
/** A modal's answers by box: Label-wrapped boxes and the older Action Row ones */
export function readModal(data) {
  const out = {};
  for (const top of data?.components || []) {
    const kids = top.type === COMPONENT.LABEL ? [top.component] : top.type === COMPONENT.ROW ? top.components || [] : [];
    for (const c of kids) if (c?.custom_id) out[c.custom_id] = 'values' in c ? c.values : c.value;
  }
  return out;
}
/** A slash command's options as { name: value } */
const optionMap = (options) => Object.fromEntries((options || []).flatMap((o) => (o.options ? Object.entries(optionMap(o.options)) : [[o.name, o.value]])));
/** Names typed one to a line (or with commas): trimmed, one space, up to max */
const names = (text, max) => String(text ?? '').split(/\r?\n|,/).map((s) => s.trim().replace(/\s+/g, ' ').slice(0, 60)).filter(Boolean).slice(0, max);
/** A time as minutes after midnight: "14:00", "2pm", "2:30 pm", "14", "midday", "noon" */
export function parseClock(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (t === 'midday' || t === 'noon') return 12 * 60;
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] || 0);
  if (mi > 59 || h > 23 || (m[3] && (h < 1 || h > 12))) return null;
  if (m[3] === 'pm' && h !== 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  return h * 60 + mi;
}
const hhmm = (minutes) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const minutes36 = (ms) => Math.round(ms / MIN).toString(36);
const fromMinutes36 = (text) => (/^[0-9a-z]{4,12}$/.test(String(text || '')) ? parseInt(text, 36) * MIN : NaN);
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export const discordMethods = {
  /* ---------------- settings and who's who ---------------- */
  /** The server's settings (/lair-setup), kept in memory until they change. No awaits. */
  discordSettings() {
    if (!this.discordSettingsCache) {
      const m = Object.fromEntries(this.sql.exec('SELECT key, value FROM discord_settings').toArray().map((r) => [r.key, r.value]));
      this.discordSettingsCache = {
        boundGuild: m.guild || null,
        sessionsChannel: m.sessions_channel || null, sessionsType: Number(m.sessions_type || 0),
        eventsChannel: m.events_channel || null, eventsType: Number(m.events_type || 0),
        pingRole: m.ping_role || null,
        posts: m.posts !== 'off', pings: m.pings !== 'off', digest: m.digest !== 'off',
      };
    }
    // DISCORD_GUILD_ID (config) wins over the server the first /lair-setup bound
    return { ...this.discordSettingsCache, guild: String(this.env.DISCORD_GUILD_ID || '').trim() || this.discordSettingsCache.boundGuild };
  },

  saveDiscordSetting(key, value, by, now = Date.now()) {
    this.sql.exec(
      `INSERT INTO discord_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      key, value == null ? null : String(value), now, by || null,
    );
    this.discordSettingsCache = null;
  },

  /** Discord can reach the bot: slash commands, buttons and modals work */
  discordReady() {
    return Boolean(this.env.DISCORD_APPLICATION_ID && this.env.DISCORD_PUBLIC_KEY);
  },

  /** My Lair's Link Discord works */
  discordCanLink() {
    return Boolean(this.env.DISCORD_APPLICATION_ID && this.env.DISCORD_CLIENT_SECRET);
  },

  /** The bot can post: its token, a channel picked, and auto-posts on */
  discordCanPost() {
    if (!this.env.DISCORD_BOT_TOKEN) return false;
    const s = this.discordSettings();
    return Boolean(s.posts && (s.sessionsChannel || s.eventsChannel));
  },

  discordLinkRow(userId) {
    return this.sql.exec('SELECT * FROM discord_links WHERE user_id = ?', String(userId)).toArray()[0] || null;
  },

  /**
   * Who a Discord user is to the Lair's handlers: their linked member, or a guest, never staff (the bot does only what
   * the public website does). discordUserId lets them change what they made through the bot (discordOwns). No awaits.
   */
  discordWho(ctx) {
    const link = this.discordLinkRow(ctx.userId);
    return { customerId: link ? String(link.customer_id) : null, staff: false, gm: false, tags: [], role: null, perms: [], discordUserId: ctx.userId };
  },

  /** A linked member's name, email and mobile from their profile; complete when a seat can be booked in one tap. No awaits. */
  discordDetails(who) {
    const m = who.customerId ? this.memberRow(who.customerId) : null;
    let mobile = '';
    try {
      mobile = m?.mobile ? checkMobile(m.mobile) : '';
    } catch {
      mobile = '';
    }
    const name = trimmed(m?.name || m?.first_name, 80);
    const email = trimmed(m?.account_email || m?.email, 120);
    return { name, email, mobile, complete: Boolean(name && isEmail(email) && mobile) };
  },

  /** The bot's own soft limit key, per Discord user (the website's is the shopper's address) */
  discordClient(ctx) {
    return `discord:${ctx.userId}`;
  },

  /** Note what a Discord user made through the bot, so they can change it there (and it joins their account when they link). No awaits. */
  discordOwn(kind, itemId, userId, key = null, now = Date.now()) {
    this.sql.exec('INSERT OR IGNORE INTO discord_items (kind, item_id, user_id, item_key, created_at) VALUES (?, ?, ?, ?, ?)', kind, String(itemId), String(userId), key, now);
  },

  /** Whether this Discord user made that booking ('booking'), sign-up ('join') or interest ('interest') through the bot. No awaits. */
  discordOwns(who, kind, itemId) {
    if (!who?.discordUserId) return false;
    return this.sql.exec('SELECT 1 AS n FROM discord_items WHERE kind = ? AND item_id = ? AND user_id = ?', kind, String(itemId), String(who.discordUserId)).toArray().length > 0;
  },

  discordItemKey(kind, itemId, userId) {
    return this.sql.exec('SELECT item_key FROM discord_items WHERE kind = ? AND item_id = ? AND user_id = ?', kind, String(itemId), String(userId)).toArray()[0]?.item_key || null;
  },

  /* ---------------- words and times ---------------- */
  discordDay(ms, rules, now = Date.now()) {
    const time = lairTime(rules.tz);
    const key = time.key(ms);
    const today = time.key(now);
    if (key === today) return 'Today';
    if (key === addDays(today, 1)) return 'Tomorrow';
    return this.shortDay(ms, rules);
  },

  discordClock(ms, rules) {
    return clockLabel(lairTime(rules.tz).minutesOf(ms));
  },

  /** "Thu 16 Oct, 6pm to 10pm" ("Today, …", "Tomorrow, …") */
  discordSpan(start, end, rules, now = Date.now()) {
    return `${this.discordDay(start, rules, now)}, ${this.discordClock(start, rules)} to ${this.discordClock(end, rules)}`;
  },

  discordGameUrl(gameId) {
    return `${this.page('gm')}#game=${encodeURIComponent(gameId)}`;
  },

  /** My Lair's Profile with the Link Discord card, which starts linking by itself (?link=discord) */
  discordLinkUrl() {
    return `${this.page('myLair')}?link=discord#profile`;
  },

  discordImage(url) {
    return /^https:\/\/[^\s]+$/.test(String(url || '')) ? String(url) : null;
  },

  discordSeatsWord(view) {
    const left = Math.max(0, view.seats - view.taken);
    return left ? plural(left, 'seat left', 'seats left') : 'full';
  },

  discordPlacesWord(o) {
    if (!o.capacity) return o.gameTables ? 'game tables to book' : 'just turn up';
    const left = Math.max(0, o.capacity - this.placesTaken(o.id));
    return left ? plural(left, 'place left', 'places left') : 'full';
  },

  /** The event date in a button's id, back again (null when it's gone from the calendar) */
  discordOcc(ref, rules) {
    const m = String(ref || '').match(/^([0-9a-z]{10})@(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    const ev = (rules.events || []).find((e) => shortHash(e.id).slice(0, 10) === m[1]);
    return ev ? findOccurrence(rules, `${ev.id}@${m[2]}-${m[3]}-${m[4]}`) : null;
  },

  /* ---------------- answering ---------------- */
  /** A private message for whoever tapped, or the private card they tapped, changed in place. Never pings anyone. */
  discordAnswer(ctx, data) {
    if (ctx.inPlace) return { type: RESPONSE.UPDATE, data: { content: '', embeds: [], components: [], allowed_mentions: { parse: [] }, ...data } };
    return { type: RESPONSE.MESSAGE, data: { flags: EPHEMERAL, allowed_mentions: { parse: [] }, ...data } };
  },

  /** Words on their own. A problem on a card keeps the card and says it on top. */
  discordSay(ctx, text, { error = false, components = null } = {}) {
    const content = error ? `⚠️ ${text}` : text;
    if (error && ctx.inPlace && !components) return { type: RESPONSE.UPDATE, data: { content, allowed_mentions: { parse: [] } } };
    return this.discordAnswer(ctx, { content, embeds: [], components: components || [] });
  },

  /**
   * POST /internal/discord/interaction (the Worker checked Discord's signature): a slash command, a button or select, a
   * modal sent, or the day and time boxes of /table filling in. Returns Discord's answer. Problems the Lair's rules find
   * (a full table, a mobile number that doesn't look right) come back as the website says them.
   */
  async discordInteraction(interaction) {
    const user = interaction?.member?.user || interaction?.user || {};
    const ctx = { interaction, userId: String(user.id || ''), user, inPlace: inPlace(interaction) };
    try {
      if (!SNOWFLAKE.test(ctx.userId)) throw new RuleError(DISCORD_WORDS.who);
      const settings = this.discordSettings();
      const guild = interaction.guild_id ? String(interaction.guild_id) : '';
      if (!guild || (settings.guild && guild !== settings.guild)) {
        if (interaction.type === INTERACTION.AUTOCOMPLETE) return { type: RESPONSE.CHOICES, data: { choices: [] } };
        return this.discordSay(ctx, DISCORD_WORDS.guildOnly, { error: true });
      }
      ctx.guild = guild;
      if (interaction.type === INTERACTION.COMMAND) return await this.discordCommand(ctx);
      if (interaction.type === INTERACTION.AUTOCOMPLETE) return await this.discordAutocomplete(ctx);
      if (interaction.type === INTERACTION.COMPONENT) return await this.discordComponent(ctx);
      if (interaction.type === INTERACTION.MODAL) return await this.discordModalSent(ctx);
      return this.discordSay(ctx, DISCORD_WORDS.unknown, { error: true });
    } catch (error) {
      if (interaction?.type === INTERACTION.AUTOCOMPLETE) return { type: RESPONSE.CHOICES, data: { choices: [] } };
      if (error instanceof RuleError) return this.discordSay(ctx, error.message, { error: true });
      console.error('Lair: Discord interaction failed', error);
      this.note({ lastError: { message: String(error?.message || error).slice(0, 300), path: '/discord/interactions', at: new Date().toISOString() } });
      return this.discordSay(ctx, DISCORD_WORDS.broken, { error: true });
    }
  },

  async discordCommand(ctx) {
    const name = ctx.interaction.data?.name;
    if (name === 'games') return this.discordGames(ctx);
    if (name === 'events') return this.discordEvents(ctx);
    if (name === 'table') return this.discordTable(ctx);
    if (name === 'mylair') return this.discordMine(ctx);
    if (name === 'link') return this.discordLinkInfo(ctx);
    if (name === 'lair-setup') return this.discordSetup(ctx);
    return this.discordSay(ctx, DISCORD_WORDS.unknown, { error: true });
  },

  async discordComponent(ctx) {
    const parts = cidParts(ctx.interaction.data?.custom_id);
    if (!parts) return this.discordSay(ctx, DISCORD_WORDS.oldButton, { error: true });
    const [action, a, b] = parts;
    const value = ctx.interaction.data?.values?.[0];
    if (action === 'pick') return this.discordPick(ctx, value);
    if (action === 'list') return a === 'e' ? this.discordEvents(ctx) : this.discordGames(ctx);
    if (action === 'seat') return this.discordSeat(ctx, a);
    if (action === 'friends') return this.discordFriends(ctx, a);
    if (action === 'int') return this.discordInterest(ctx, a);
    if (action === 'every') return this.discordEvery(ctx, a);
    if (action === 'join') return this.discordJoin(ctx, a, false);
    if (action === 'jfr') return this.discordJoin(ctx, a, true);
    if (action === 'wait') return this.discordWaitlist(ctx, a);
    if (action === 'coming' || action === 'maybe') return this.discordEventInterest(ctx, a, action === 'coming');
    if (action === 'table') return this.discordTablePick(ctx, parts.slice(1));
    if (action === 'tmore') return this.discordTableMore(ctx, parts.slice(1));
    if (action === 'mine') return this.discordAsk(ctx, value);
    if (action === 'ask') return this.discordAsk(ctx, `${a}:${b}`);
    if (action === 'drop') return this.discordDrop(ctx, a, b);
    if (action === 'keep') return this.discordMine(ctx);
    if (action === 'unlink') return this.discordUnlinkHere(ctx);
    if (action === 'set') return this.discordSetupChange(ctx, a);
    return this.discordSay(ctx, DISCORD_WORDS.oldButton, { error: true });
  },

  async discordModalSent(ctx) {
    const parts = cidParts(ctx.interaction.data?.custom_id);
    if (!parts) return this.discordSay(ctx, DISCORD_WORDS.oldButton, { error: true });
    const f = readModal(ctx.interaction.data);
    const [kind, a, b] = parts;
    if (kind === 'mseat') return this.discordSeatSent(ctx, a, b === 'f', f);
    if (kind === 'mint') return this.discordInterestSent(ctx, a, f);
    if (kind === 'mevery') return this.discordEverySent(ctx, a, f);
    if (kind === 'mjoin') return this.discordJoinSent(ctx, a, f);
    if (kind === 'mwait') return this.discordWaitlistSent(ctx, a, f);
    if (kind === 'mev') return this.discordEventInterestSent(ctx, b, a === 'c', f);
    if (kind === 'mtable') return this.discordTableSent(ctx, parts.slice(1), f);
    return this.discordSay(ctx, DISCORD_WORDS.oldButton, { error: true });
  },

  /** A pick from a list of sessions and events (/games, /events, the daily round-up) */
  async discordPick(ctx, value) {
    const m = String(value || '').match(/^([ge]):(.+)$/);
    if (!m) return this.discordSay(ctx, DISCORD_WORDS.oldButton, { error: true });
    return m[1] === 'g' ? this.discordSessionCard(ctx, m[2]) : this.discordEventCard(ctx, m[2]);
  },

  /* ---------------- TTRPG sessions ---------------- */
  /** The public games board's sessions in [from, to): open or full, a series' next session only, soonest first. No awaits. */
  discordSessions(rules, from, to) {
    const st = this.state(from - HOUR, to);
    const info = this.seriesInfo(from);
    return st.games
      .filter((g) => ['open', 'full'].includes(g.status) && g.end > from && g.start < to && (!g.seriesId || info.next.get(g.seriesId) === g.id))
      .sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)))
      .map((g) => this.gameView(g, st, rules, info));
  },

  /** One session as the board shows it, or null once it's finished, cancelled or off the board. No awaits. */
  discordSessionView(gameId, rules, now) {
    if (!ID.test(String(gameId || ''))) return null;
    const game = this.game(gameId);
    if (!game || !['open', 'full'].includes(game.status) || game.end <= now) return null;
    return this.gameView(game, this.state(game.start - 1, game.end + 1), rules);
  },

  /** Their seat at a session: on their account, or made through the bot. No awaits. */
  discordSeatOf(gameId, who) {
    const r = this.sql.exec(
      `SELECT * FROM bookings WHERE game_id = ? AND kind = 'gm-seat' AND status IN ('held', 'confirmed', 'seated')
         AND (customer_id = ? OR id IN (SELECT item_id FROM discord_items WHERE kind = 'booking' AND user_id = ?)) ORDER BY created_at, id LIMIT 1`,
      String(gameId), who.customerId || '', who.discordUserId || '',
    ).toArray()[0];
    return r ? this.rowToBooking(r) : null;
  },

  async discordGames(ctx) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const views = this.discordSessions(rules, now, now + LIST_DAYS * DAY);
    if (!views.length) {
      return this.discordAnswer(ctx, {
        content: 'No sessions on the board for the next fortnight. Gobgob is pacing the hallway. Fancy running one?',
        components: [row(linkButton('Run a game', `${this.page('gm')}#host`))],
      });
    }
    const lines = views.slice(0, 15).map((v) => `🎲 **${clip(v.title, 60)}** · ${this.discordDay(v.start, rules, now)}, ${this.discordClock(v.start, rules)} · ${this.discordSeatsWord(v)}`);
    if (views.length > 15) lines.push(`…and ${views.length - 15} more on the website.`);
    const options = views.slice(0, 25).map((v) => ({
      label: clip(v.title, 100), value: `g:${v.id}`,
      description: clip(`${this.discordDay(v.start, rules, now)} ${this.discordClock(v.start, rules)} · ${this.discordSeatsWord(v)} · ${money(v.seatPrice)}`, 100),
    }));
    return this.discordAnswer(ctx, {
      embeds: [{ title: 'TTRPG sessions at the Lair', color: POTION, description: clip(lines.join('\n'), 4000), footer: { text: 'Pick one to grab a seat. Seats are paid at the counter.' } }],
      components: [selectRow(cid('pick'), 'Pick a session', options), row(linkButton('The games board', this.page('gm')))],
    });
  },

  discordSessionEmbed(view, rules, now) {
    const left = Math.max(0, view.seats - view.taken);
    const schedule = { weekly: 'Every week', fortnightly: 'Every fortnight', flexible: 'Regular game, dates as the GM sets them' }[view.series?.schedule]
      || (view.seriesId ? 'Regular game' : 'One-shot');
    const fields = [
      { name: 'When', value: `${this.discordSpan(view.start, view.end, rules, now)}\n<t:${Math.floor(view.start / 1000)}:R>`, inline: true },
      { name: 'Seats', value: left > 0 ? `${left} of ${view.seats} left` : 'Full right now', inline: true },
      { name: 'Price', value: `${money(view.seatPrice)} a seat, at the counter`, inline: true },
    ];
    if (view.gm) fields.push({ name: 'GM', value: clip(view.gm, 200), inline: true });
    if (view.system) fields.push({ name: 'System', value: clip(view.system, 200), inline: true });
    fields.push({ name: 'Game', value: schedule, inline: true });
    if (view.level) fields.push({ name: 'Experience', value: LEVEL_WORDS[view.level] || clip(view.level, 200), inline: true });
    if (view.age) fields.push({ name: 'Ages', value: clip(view.age, 200), inline: true });
    const image = this.discordImage(view.image);
    return {
      title: clip(view.title, 256), url: this.discordGameUrl(view.id), color: POTION,
      ...(trimmed(view.blurb, 1) ? { description: clip(view.blurb, 600) } : {}),
      fields,
      ...(image ? { thumbnail: { url: image } } : {}),
      footer: { text: 'Seats are paid at the counter. Grab one here or on dicegoblin.nz.' },
    };
  },

  /** A session's buttons. seat: theirs already (a private card). post: the public post (the same for everyone). */
  discordSessionButtons(view, now, { seat = null, back = false } = {}) {
    const left = Math.max(0, view.seats - view.taken);
    const open = left > 0 && view.end > now;
    const first = seat
      ? [button('Bring friends', cid('friends', view.id), STYLE.PRIMARY, { disabled: !open }), button('Drop my seat', cid('ask', 'b', seat.id), STYLE.DANGER)]
      : [button(open ? 'Grab a seat' : 'Full', cid('seat', view.id), STYLE.SUCCESS, { disabled: !open, emoji: '🎲' }), button('Bring friends', cid('friends', view.id), STYLE.SECONDARY, { disabled: left < 2 || view.end <= now })];
    first.push(button("I'm interested", cid('int', view.id)));
    if (view.seriesId) first.push(button('Save my seat every week', cid('every', view.id)));
    first.push(linkButton('On the website', this.discordGameUrl(view.id)));
    const rows = [row(...first)];
    if (back) rows.push(row(button('All sessions', cid('list', 'g'))));
    return rows;
  },

  async discordSessionCard(ctx, gameId, { notice = '' } = {}) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const view = this.discordSessionView(gameId, rules, now);
    if (!view) return this.discordSay(ctx, DISCORD_WORDS.sessionGone, { error: true });
    const seat = this.discordSeatOf(view.id, this.discordWho(ctx));
    const content = notice || (seat ? `You've got a seat at this one (code **${seat.ref}**).` : '');
    return this.discordAnswer(ctx, { content, embeds: [this.discordSessionEmbed(view, rules, now)], components: this.discordSessionButtons(view, now, { seat, back: ctx.inPlace }) });
  },

  discordAlreadySeated(ctx, view, seat) {
    return this.discordAnswer(ctx, {
      content: `You've already got a seat at **${clip(view.title, 80)}** (code **${seat.ref}**). Bringing friends?`,
      components: [row(button('Bring friends', cid('friends', view.id), STYLE.PRIMARY), button('Drop my seat', cid('ask', 'b', seat.id), STYLE.DANGER))],
    });
  },

  /** Grab a seat: in one tap for a linked member with a mobile on their profile; anyone else fills in the pop-up */
  async discordSeat(ctx, gameId) {
    const rules = await this.rules();
    // --- no awaits until the booking ---
    const now = Date.now();
    const view = this.discordSessionView(gameId, rules, now);
    if (!view) return this.discordSay(ctx, DISCORD_WORDS.sessionGone, { error: true });
    const who = this.discordWho(ctx);
    const seat = this.discordSeatOf(view.id, who);
    if (seat) return this.discordAlreadySeated(ctx, view, seat);
    const d = this.discordDetails(who);
    if (!who.customerId || !d.complete) return this.discordSeatModal(view, who, d, false);
    return this.discordBookSeat(ctx, view, who, { name: d.name, email: d.email, phone: d.mobile, players: [{ name: d.name, character: '' }] });
  },

  /** Bring friends: seats for them too (with yours when you haven't got one yet) */
  async discordFriends(ctx, gameId) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const view = this.discordSessionView(gameId, rules, Date.now());
    if (!view) return this.discordSay(ctx, DISCORD_WORDS.sessionGone, { error: true });
    const who = this.discordWho(ctx);
    return this.discordSeatModal(view, who, this.discordDetails(who), Boolean(this.discordSeatOf(view.id, who)));
  },

  discordSeatModal(view, who, d, friendsOnly) {
    const boxes = [];
    if (!who.customerId || !d.name) boxes.push(textBox('name', 'Your name', { value: d.name, max: 80 }));
    if (!who.customerId || !isEmail(d.email)) boxes.push(textBox('email', 'Email', { value: d.email, max: 120, description: 'Your confirmation goes here.' }));
    if (!d.mobile) boxes.push(textBox('mobile', 'Mobile', { max: 20, placeholder: '021 123 4567', description: 'So we can reach you on the day.' }));
    boxes.push(textBox('friends', friendsOnly ? "Who's coming? One name per line" : 'Bringing friends? One name per line', {
      paragraph: true, required: friendsOnly, max: 400, placeholder: 'Kiri\nSam', description: 'Each friend takes a seat. Up to 8 seats in all.',
    }));
    boxes.push(textBox('notes', 'Anything the GM should know?', { paragraph: true, required: false, max: 300 }));
    return modal(cid('mseat', view.id, friendsOnly ? 'f' : 's'), `${friendsOnly ? 'Seats for friends' : 'Grab a seat'}: ${view.title}`, boxes);
  },

  async discordSeatSent(ctx, gameId, friendsOnly, f) {
    const rules = await this.rules();
    // --- no awaits until the booking ---
    const now = Date.now();
    const view = this.discordSessionView(gameId, rules, now);
    if (!view) return this.discordSay(ctx, DISCORD_WORDS.sessionGone, { error: true });
    const who = this.discordWho(ctx);
    if (!friendsOnly) {
      const seat = this.discordSeatOf(view.id, who);
      if (seat) return this.discordAlreadySeated(ctx, view, seat);
    }
    const d = this.discordDetails(who);
    const name = trimmed(f.name ?? d.name, 80);
    const friends = names(f.friends, 9);
    const players = [...(friendsOnly ? [] : [name]), ...friends].map((n) => ({ name: n, character: '' }));
    if (!players.length) throw new RuleError('Add a name for every seat.');
    if (players.length > 8) throw new RuleError('Book between 1 and 8 seats.');
    return this.discordBookSeat(ctx, view, who, { name, email: trimmed(f.email ?? d.email, 120), phone: trimmed(f.mobile ?? d.mobile, 40), players, notes: f.notes });
  },

  async discordBookSeat(ctx, view, who, { name, email, phone, players, notes = '' }) {
    const res = await this.createBooking(
      { kind: 'gm-seat', gameId: view.id, people: players.length, name, email, phone, players, notes: trimmed(notes, 500) },
      who, this.discordClient(ctx),
    );
    // --- no awaits from here on ---
    const b = res.booking;
    const now = Date.now();
    this.discordOwn('booking', b.id, ctx.userId, null, now);
    const rules = this.rulesCache;
    const where = res.emailed ? 'Your confirmation is in your email' : 'Your code is your ticket';
    return this.discordAnswer(ctx, {
      content: res.notice || '',
      embeds: [{
        title: "You're in!", color: GOBLIN,
        description: `Gobgob has pulled up ${players.length > 1 ? `${players.length} chairs` : 'a chair'} for you at **${clip(view.title, 100)}**.`,
        fields: [
          { name: 'When', value: this.discordSpan(view.start, view.end, rules, now), inline: true },
          { name: players.length > 1 ? 'Seats' : 'Seat', value: clip(players.map((p) => p.name).join(', '), 1000), inline: true },
          { name: 'Pay', value: b.due > 0 ? `${money(b.due)} at the counter when you arrive` : 'Nothing to pay', inline: true },
          { name: 'Your code', value: `**${b.ticketCode || b.ref}**`, inline: true },
        ],
        footer: { text: who.customerId ? `${where}, and it's in My Lair.` : `${where}. Link Discord in My Lair to see your bookings there too.` },
      }],
      components: [row(
        button('Drop my seat', cid('ask', 'b', b.id), STYLE.DANGER),
        who.customerId ? linkButton('Open My Lair', this.page('myLair')) : linkButton('About this session', this.discordGameUrl(view.id)),
      )],
    });
  },

  /** I'm interested: the GM hears and gets back to them (round 9). Nothing is booked. */
  async discordInterest(ctx, gameId) {
    const rules = await this.rules();
    // --- no awaits until the interest ---
    const view = this.discordSessionView(gameId, rules, Date.now());
    if (!view) return this.discordSay(ctx, DISCORD_WORDS.sessionGone, { error: true });
    const who = this.discordWho(ctx);
    const d = this.discordDetails(who);
    if (!who.customerId || !d.name || !isEmail(d.email)) {
      const boxes = [];
      if (!who.customerId || !d.name) boxes.push(textBox('name', 'Your name', { value: d.name, max: 80 }));
      if (!who.customerId || !isEmail(d.email)) boxes.push(textBox('email', 'Email', { value: d.email, max: 120, description: 'So the GM can get back to you.' }));
      if (!who.customerId) boxes.push(textBox('mobile', 'Mobile', { max: 20, placeholder: '021 123 4567' }));
      boxes.push(textBox('note', 'A note for the GM?', { paragraph: true, required: false, max: 280, placeholder: 'New to D&D, keen to learn' }));
      return modal(cid('mint', view.id), `Interested: ${view.title}`, boxes);
    }
    const res = await this.addInterest({ kind: 'session', id: view.id }, who, this.discordClient(ctx));
    return this.discordInterestDone(ctx, res, view.title, 'session');
  },

  async discordInterestSent(ctx, gameId, f) {
    const rules = await this.rules();
    const view = this.discordSessionView(gameId, rules, Date.now());
    if (!view) return this.discordSay(ctx, DISCORD_WORDS.sessionGone, { error: true });
    const who = this.discordWho(ctx);
    const res = await this.addInterest({ kind: 'session', id: view.id, name: f.name, email: f.email, phone: f.mobile, note: f.note }, who, this.discordClient(ctx));
    return this.discordInterestDone(ctx, res, view.title, 'session');
  },

  discordInterestDone(ctx, res, title, kind) {
    const it = res.interest;
    this.discordOwn('interest', it.id, ctx.userId, it.key || null);
    const name = `**${clip(title, 100)}**`;
    let text;
    if (kind === 'session') {
      text = res.already ? `You'd already said you're keen on ${name}. Gobgob has updated it.`
        : res.emailed ? `Gobgob told the GM you're keen on ${name}. Nothing's booked yet, so they'll get back to you.`
          : `Gobgob has noted you're keen on ${name}. Nothing's booked yet.`;
    } else if (it.level === 'waitlist') {
      const people = Number(it.people) || 1;
      text = `You're on the waitlist for ${name}${people > 1 ? ` (${people} people)` : ''}. Nothing's booked or paid. If a place opens up, the team will be in touch.`;
    } else if (it.level === 'coming') {
      text = `Gobgob's expecting you at ${name}. No need to sign up, just turn up.`;
    } else {
      text = `Marked as maybe for ${name}. No pressure, friend.`;
    }
    return this.discordAnswer(ctx, { content: text, components: [row(button('Take it back', cid('ask', 'i', it.id)))] });
  },

  /** Save my seat every week (a weekly regular, round 5): their member code is the ticket, so it needs a linked account */
  async discordEvery(ctx, gameId) {
    const rules = await this.rules();
    // --- no awaits until joining ---
    const view = this.discordSessionView(gameId, rules, Date.now());
    if (!view) return this.discordSay(ctx, DISCORD_WORDS.sessionGone, { error: true });
    const who = this.discordWho(ctx);
    if (!who.customerId) {
      return this.discordAnswer(ctx, {
        content: 'Saving your seat every week needs a Dice Goblin account, since your member code is your ticket. Link yours, then tap this again.',
        components: [row(linkButton('Link my account', this.discordLinkUrl()))],
      });
    }
    const d = this.discordDetails(who);
    if (!d.complete) {
      const boxes = [];
      if (!d.name) boxes.push(textBox('name', 'Your name', { max: 80 }));
      if (!isEmail(d.email)) boxes.push(textBox('email', 'Email', { max: 120 }));
      boxes.push(textBox('mobile', 'Mobile', { value: d.mobile, max: 20, placeholder: '021 123 4567', description: 'So the GM can reach you on the day.' }));
      return modal(cid('mevery', view.id), `Every week: ${view.title}`, boxes);
    }
    return this.discordJoinEvery(ctx, view, who, { name: d.name, email: d.email, phone: d.mobile });
  },

  async discordEverySent(ctx, gameId, f) {
    const rules = await this.rules();
    const view = this.discordSessionView(gameId, rules, Date.now());
    if (!view) return this.discordSay(ctx, DISCORD_WORDS.sessionGone, { error: true });
    const who = this.discordWho(ctx);
    if (!who.customerId) return this.discordSay(ctx, 'Link your Dice Goblin account first with /link.', { error: true });
    const d = this.discordDetails(who);
    return this.discordJoinEvery(ctx, view, who, { name: trimmed(f.name ?? d.name, 80), email: trimmed(f.email ?? d.email, 120), phone: trimmed(f.mobile ?? d.mobile, 40) });
  },

  async discordJoinEvery(ctx, view, who, { name, email, phone }) {
    const res = await this.joinSeries(view.id, { people: 1, name, email, phone, players: [{ name, character: '' }] }, who, this.discordClient(ctx));
    // --- no awaits from here on ---
    const title = `**${clip(view.title, 100)}**`;
    const code = this.memberRow(who.customerId)?.code;
    const booked = res.booked?.[0];
    const text = booked
      ? `You're a regular at ${title}! Gobgob has booked your seat for the next session and will save you one every session after that. Your member code${code ? ` (**${code}**)` : ''} is your ticket.`
      : res.full?.length
        ? `You're a regular at ${title}. The next session's full, so Gobgob will grab you a seat if one comes free, and your seat's saved from the one after.`
        : `You're a regular at ${title}. Gobgob will save your seat as soon as the next session's on the board.`;
    return this.discordAnswer(ctx, {
      content: `${text}\nA seat you keep is yours to pay for, even if you don't come. Can't make one? Drop that session's seat in /mylair before it starts.`,
      components: [row(linkButton('Open My Lair', this.page('myLair')))],
    });
  },

  /* ---------------- events ---------------- */
  async discordEvents(ctx) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const dates = eventOccurrences(rules, now, now + LIST_DAYS * DAY).filter((o) => o.end > now).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    if (!dates.length) {
      return this.discordAnswer(ctx, {
        content: 'Nothing on the calendar for the next fortnight yet. Gobgob is working on it.',
        components: [row(linkButton('The events calendar', this.page('events')))],
      });
    }
    const lines = dates.slice(0, 15).map((o) => `🎟️ **${clip(o.title, 60)}** · ${this.discordDay(o.start, rules, now)}, ${this.discordClock(o.start, rules)} · ${this.discordPlacesWord(o)}`);
    if (dates.length > 15) lines.push(`…and ${dates.length - 15} more on the website.`);
    const options = dates.slice(0, 25).map((o) => ({
      label: clip(o.title, 100), value: `e:${occRef(o.id)}`,
      description: clip(`${this.discordDay(o.start, rules, now)} ${this.discordClock(o.start, rules)} · ${this.discordPlacesWord(o)}`, 100),
    }));
    return this.discordAnswer(ctx, {
      embeds: [{ title: "What's on at the Lair", color: POTION, description: clip(lines.join('\n'), 4000), footer: { text: "Pick one to sign up, or say you're coming." } }],
      components: [selectRow(cid('pick'), 'Pick an event', options), row(linkButton('The events calendar', this.page('events')))],
    });
  },

  discordEventEmbed(o, rules, now) {
    const ev = (rules.events || []).find((e) => e.id === o.eventId) || {};
    const counts = this.interestCounts('event', o.id);
    const left = o.capacity ? Math.max(0, o.capacity - this.placesTaken(o.id)) : null;
    const places = !o.capacity
      ? (o.gameTables ? 'Book a game table on the website' : 'No need to sign up. Just turn up!')
      : left > 0 ? `${left} of ${o.capacity} left` : `Full${counts.waiting ? ` (${counts.waiting} on the waitlist)` : ''}`;
    const fields = [
      { name: 'When', value: `${this.discordSpan(o.start, o.end, rules, now)}\n<t:${Math.floor(o.start / 1000)}:R>`, inline: true },
      { name: o.capacity ? 'Places' : 'Signing up', value: places, inline: true },
    ];
    const price = this.eventPriceLine(o, ev);
    if (price) fields.push({ name: 'Entry', value: clip(price, 300), inline: true });
    const keen = [counts.coming ? `${counts.coming} coming` : '', counts.maybe ? `${counts.maybe} maybe` : ''].filter(Boolean).join(', ');
    if (keen) fields.push({ name: "Who's keen", value: keen, inline: true });
    return {
      title: clip(o.title, 256), url: this.eventLink(o), color: POTION,
      ...(trimmed(ev.description, 1) ? { description: clip(ev.description, 600) } : {}),
      fields,
      footer: { text: o.capacity ? 'Sign up here or on dicegoblin.nz.' : "Tap I'm coming so Gobgob can count the chairs." },
    };
  },

  discordEventButtons(o, { mine = null, back = false } = {}) {
    const ref = occRef(o.id);
    const left = o.capacity ? Math.max(0, o.capacity - this.placesTaken(o.id)) : null;
    const buttons = [];
    if (mine) buttons.push(button('Drop my spot', cid('ask', 'j', mine.id), STYLE.DANGER));
    else if (o.capacity && left > 0) {
      buttons.push(button('Sign up', cid('join', ref), STYLE.SUCCESS, { emoji: '🎟️' }));
      if (left > 1) buttons.push(button('Bring friends', cid('jfr', ref)));
    } else if (o.capacity) buttons.push(button('Join the waitlist', cid('wait', ref), STYLE.PRIMARY));
    else if (!o.gameTables) buttons.push(button("I'm coming", cid('coming', ref), STYLE.SUCCESS));
    if (!mine) buttons.push(button('Maybe', cid('maybe', ref)));
    buttons.push(linkButton(o.gameTables ? 'Book a game table' : 'On the website', this.eventLink(o)));
    const rows = [row(...buttons)];
    if (back) rows.push(row(button('All events', cid('list', 'e'))));
    return rows;
  },

  /** Their sign-up for an event date: on their account, or made through the bot. No awaits. */
  discordJoinOf(occurrenceId, who) {
    const r = this.sql.exec(
      `SELECT * FROM event_joins WHERE occurrence_id = ? AND status NOT IN ('cancelled', 'noshow')
         AND (customer_id = ? OR id IN (SELECT item_id FROM discord_items WHERE kind = 'join' AND user_id = ?)) ORDER BY created_at, id LIMIT 1`,
      occurrenceId, who.customerId || '', who.discordUserId || '',
    ).toArray()[0];
    return r ? this.rowToJoin(r) : null;
  },

  async discordEventCard(ctx, ref, { notice = '' } = {}) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const o = this.discordOcc(ref, rules);
    if (!o || o.end <= now) return this.discordSay(ctx, DISCORD_WORDS.eventGone, { error: true });
    const mine = this.discordJoinOf(o.id, this.discordWho(ctx));
    const content = notice || (mine ? `You're on the list for this one (code **${mine.ref}**).` : '');
    return this.discordAnswer(ctx, { content, embeds: [this.discordEventEmbed(o, rules, now)], components: this.discordEventButtons(o, { mine, back: ctx.inPlace }) });
  },

  async discordJoin(ctx, ref, withFriends) {
    const rules = await this.rules();
    // --- no awaits until signing up ---
    const now = Date.now();
    const o = this.discordOcc(ref, rules);
    if (!o || o.end <= now) return this.discordSay(ctx, DISCORD_WORDS.eventGone, { error: true });
    const who = this.discordWho(ctx);
    const mine = this.discordJoinOf(o.id, who);
    if (mine) {
      return this.discordAnswer(ctx, {
        content: `You're already on the list for **${clip(o.title, 80)}** (code **${mine.ref}**).${withFriends ? ' To bring friends, drop your spot and sign up again with them.' : ''}`,
        components: [row(button('Drop my spot', cid('ask', 'j', mine.id), STYLE.DANGER))],
      });
    }
    const d = this.discordDetails(who);
    if (withFriends || !who.customerId || !d.complete) {
      const boxes = [];
      if (!who.customerId || !d.name) boxes.push(textBox('name', 'Your name', { value: d.name, max: 80 }));
      if (!who.customerId || !isEmail(d.email)) boxes.push(textBox('email', 'Email', { value: d.email, max: 120, description: 'Your confirmation goes here.' }));
      if (!d.mobile) boxes.push(textBox('mobile', 'Mobile', { max: 20, placeholder: '021 123 4567', description: 'So we can reach you on the day.' }));
      boxes.push(textBox('friends', 'Bringing friends? One per line', {
        paragraph: true, required: withFriends, max: 400, placeholder: 'Kiri\nSJ-OWLBEAR-17', description: 'A name, or their member code so it counts on their card. Up to 5.',
      }));
      boxes.push(textBox('note', 'Anything we should know?', { paragraph: true, required: false, max: 300 }));
      return modal(cid('mjoin', ref), `Sign up: ${o.title}`, boxes);
    }
    return this.discordSignUp(ctx, o, who, { name: d.name, email: d.email, phone: d.mobile, people: 1 });
  },

  async discordJoinSent(ctx, ref, f) {
    const rules = await this.rules();
    const o = this.discordOcc(ref, rules);
    if (!o || o.end <= Date.now()) return this.discordSay(ctx, DISCORD_WORDS.eventGone, { error: true });
    const who = this.discordWho(ctx);
    const d = this.discordDetails(who);
    const guests = names(f.friends, 6).map((line) => (MEMBER_CODE.test(line) ? { code: line } : { name: line }));
    return this.discordSignUp(ctx, o, who, {
      name: trimmed(f.name ?? d.name, 80), email: trimmed(f.email ?? d.email, 120), phone: trimmed(f.mobile ?? d.mobile, 40), note: trimmed(f.note, 300),
      ...(guests.length ? { guests } : { people: 1 }),
    });
  },

  async discordSignUp(ctx, o, who, input) {
    const res = await this.joinEvent(o.id, input, who, this.discordClient(ctx));
    // --- no awaits from here on ---
    const j = res.join;
    const now = Date.now();
    this.discordOwn('join', j.id, ctx.userId, null, now);
    const title = `**${clip(o.title, 100)}**`;
    const spots = j.people > 1 ? `${j.people} spots` : 'your spot';
    if (res.checkoutUrl) {
      return this.discordAnswer(ctx, {
        embeds: [{
          title: 'Pay to lock it in', color: POTION,
          description: `Gobgob is holding ${spots} at ${title} for ${res.holdMinutes || 30} minutes. Pay online to keep ${j.people > 1 ? 'them' : 'it'}. Paid online means you're locked in.`,
          fields: [{ name: 'Entry', value: money(j.amount), inline: true }, { name: 'Your code', value: `**${j.ref}**`, inline: true }],
        }],
        components: [row(linkButton('Pay now', res.checkoutUrl), button('Drop my spot', cid('ask', 'j', j.id), STYLE.DANGER))],
      });
    }
    return this.discordAnswer(ctx, {
      content: res.notice || '',
      embeds: [{
        title: "You're on the list!", color: GOBLIN, description: `Gobgob's saving ${spots} at ${title}.`,
        fields: [
          { name: 'When', value: this.discordSpan(j.start, j.end, this.rulesCache, now), inline: true },
          { name: 'People', value: String(j.people), inline: true },
          { name: 'Entry', value: j.due > 0 ? `${money(j.due)} at the counter` : 'Nothing to pay', inline: true },
          { name: 'Your code', value: `**${j.ref}**`, inline: true },
        ],
        footer: { text: res.emailed ? 'Your confirmation is in your email.' : 'Show your code at the counter.' },
      }],
      components: [row(button('Drop my spot', cid('ask', 'j', j.id), STYLE.DANGER), linkButton('About this event', this.eventLink(o)))],
    });
  },

  /** Join the waitlist for a full date (round 11): nothing's booked, and the team hears */
  async discordWaitlist(ctx, ref) {
    const rules = await this.rules();
    // --- no awaits until joining ---
    const o = this.discordOcc(ref, rules);
    if (!o || o.end <= Date.now()) return this.discordSay(ctx, DISCORD_WORDS.eventGone, { error: true });
    const who = this.discordWho(ctx);
    const d = this.discordDetails(who);
    if (!who.customerId || !d.complete) {
      const boxes = [];
      if (!who.customerId || !d.name) boxes.push(textBox('name', 'Your name', { value: d.name, max: 80 }));
      if (!who.customerId || !isEmail(d.email)) boxes.push(textBox('email', 'Email', { value: d.email, max: 120 }));
      if (!d.mobile) boxes.push(textBox('mobile', 'Mobile', { max: 20, placeholder: '021 123 4567', description: 'So the team can ring you if a place opens up.' }));
      boxes.push(textBox('people', 'How many of you? (1 to 6)', { value: '1', max: 1 }));
      return modal(cid('mwait', ref), `Waitlist: ${o.title}`, boxes);
    }
    const res = await this.joinWaitlist({ waitlist: true, id: o.id, people: 1 }, who, this.discordClient(ctx));
    return this.discordInterestDone(ctx, res, o.title, 'event');
  },

  async discordWaitlistSent(ctx, ref, f) {
    const rules = await this.rules();
    const o = this.discordOcc(ref, rules);
    if (!o || o.end <= Date.now()) return this.discordSay(ctx, DISCORD_WORDS.eventGone, { error: true });
    const who = this.discordWho(ctx);
    const res = await this.joinWaitlist({ waitlist: true, id: o.id, people: f.people, name: f.name, email: f.email, phone: f.mobile }, who, this.discordClient(ctx));
    return this.discordInterestDone(ctx, res, o.title, 'event');
  },

  /** I'm coming (dates with no sign-ups) and Maybe (round 9) */
  async discordEventInterest(ctx, ref, coming) {
    const rules = await this.rules();
    // --- no awaits until saying it ---
    const o = this.discordOcc(ref, rules);
    if (!o || o.end <= Date.now()) return this.discordSay(ctx, DISCORD_WORDS.eventGone, { error: true });
    const who = this.discordWho(ctx);
    const d = this.discordDetails(who);
    if (!who.customerId || !d.name || !isEmail(d.email)) {
      const boxes = [];
      if (!who.customerId || !d.name) boxes.push(textBox('name', 'Your name', { value: d.name, max: 80 }));
      if (!who.customerId || !isEmail(d.email)) boxes.push(textBox('email', 'Email', { value: d.email, max: 120 }));
      if (!who.customerId) boxes.push(textBox('mobile', 'Mobile', { max: 20, placeholder: '021 123 4567' }));
      return modal(cid('mev', coming ? 'c' : 'm', ref), `${coming ? 'Coming' : 'Maybe'}: ${o.title}`, boxes);
    }
    const res = await this.addInterest({ kind: 'event', id: o.id, coming }, who, this.discordClient(ctx));
    return this.discordInterestDone(ctx, res, o.title, 'event');
  },

  async discordEventInterestSent(ctx, ref, coming, f) {
    const rules = await this.rules();
    const o = this.discordOcc(ref, rules);
    if (!o || o.end <= Date.now()) return this.discordSay(ctx, DISCORD_WORDS.eventGone, { error: true });
    const who = this.discordWho(ctx);
    const res = await this.addInterest({ kind: 'event', id: o.id, coming, name: f.name, email: f.email, phone: f.mobile }, who, this.discordClient(ctx));
    return this.discordInterestDone(ctx, res, o.title, 'event');
  },

  /* ---------------- tables ---------------- */
  /** A day typed or picked: "2026-10-17" (the list's), today, tomorrow, a weekday (the next one, today included) or 17/10 */
  discordDayKey(text, rules, now) {
    const time = lairTime(rules.tz);
    const today = time.key(now);
    const t = String(text ?? '').trim().toLowerCase();
    let key = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) key = t;
    else if (t === 'today' || t === 'tonight') key = today;
    else if (t === 'tomorrow') key = addDays(today, 1);
    else {
      const wd = WEEKDAYS.findIndex((w) => t.length >= 3 && w.startsWith(t));
      if (wd >= 0) key = addDays(today, (wd - time.weekday(today) + 7) % 7);
      const dm = t.match(/^(\d{1,2})[/.](\d{1,2})$/);
      if (dm) {
        const year = Number(today.slice(0, 4));
        const make = (y) => `${y}-${String(dm[2]).padStart(2, '0')}-${String(dm[1]).padStart(2, '0')}`;
        key = make(year) < today ? make(year + 1) : make(year);
      }
    }
    if (!key) return null;
    // a real date (31/02 isn't), on or after today
    return addDays(key, 0) === key && key >= today ? key : null;
  },

  /**
   * The tables a group could have at a time, one choice per room: the fewest tables that seat them (doubled for a wargame
   * or big box game), side by side where they can be, free for the whole time, under the house rules the booking page
   * uses. problem: what the house rules say about the time itself (too soon, closed, too long). No awaits.
   */
  discordFindTables({ start, hours, people, extras }, rules, now) {
    const end = start + hours * HOUR;
    const time = new LairTime(rules.tz);
    const st = this.state(start - 1, end + 1);
    const shopClosed = (id) => (rules.shopTables || []).includes(id) && !shopTableOpen(st, id, start, end);
    const check = (ids, state) => {
      try {
        checkTableBooking({ tables: ids, start, end, people, extras, name: 'Discord', email: 'discord@dicegoblin.nz' }, { state, rules, time, now });
        return null;
      } catch (error) {
        if (error instanceof RuleError) return error;
        throw error;
      }
    };
    const options = [];
    let problem = null;
    for (const room of rules.rooms) {
      if (!room.bookable || (room.minPeople && people < room.minPeople)) continue;
      const seatsOf = (t) => t.seats || room.seats;
      const perTable = Math.min(...room.tables.map(seatsOf));
      const count = maxOnlineTables(people, perTable, extras);
      const usable = room.tables.filter((t) => !shopClosed(t.id));
      if (count > usable.length || usable.reduce((n, t) => n + seatsOf(t), 0) < people) continue;
      // the time itself, checked once against an empty floor (the same answer for every room)
      if (problem === null) {
        const timeProblem = check(usable.slice(0, count).map((t) => t.id), { bookings: [], blocks: [], openings: [], games: [] });
        if (timeProblem && timeProblem.status !== 409) {
          problem = timeProblem.message;
          break;
        }
        problem = '';
      }
      const free = new Set(usable.filter((t) => isFree(st, rules, t.id, start, end)).map((t) => t.id));
      let pick = null;
      for (let i = 0; i + count <= room.tables.length && !pick; i += 1) {
        const run = room.tables.slice(i, i + count);
        if (run.every((t) => free.has(t.id))) pick = run;
      }
      if (!pick && free.size >= count) pick = room.tables.filter((t) => free.has(t.id)).slice(0, count);
      if (!pick || pick.reduce((n, t) => n + seatsOf(t), 0) < people) continue;
      const ids = pick.map((t) => t.id);
      if (check(ids, st)) continue;
      options.push({ room, tables: ids, amount: room.price * people });
    }
    return { options, problem: problem || null };
  },

  async discordTable(ctx) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const opt = optionMap(ctx.interaction.data?.options);
    const day = this.discordDayKey(opt.day, rules, now);
    if (!day) throw new RuleError(DISCORD_WORDS.day);
    const minutes = parseClock(opt.time);
    if (minutes == null) throw new RuleError(DISCORD_WORDS.time);
    const people = Math.floor(Number(opt.people));
    if (!(people >= 1 && people <= 24)) throw new RuleError(DISCORD_WORDS.people);
    const hours = opt.hours == null ? 2 : Math.floor(Number(opt.hours));
    if (!(hours >= 1 && hours <= 8)) throw new RuleError(DISCORD_WORDS.hours);
    const setup = SETUPS[opt.setup] ? opt.setup : 'board';
    return this.discordTableChoices(ctx, { start: lairTime(rules.tz).at(day, minutes), hours, people, setup }, rules, now);
  },

  /** A table request in a button's id: start (minutes, base 36), hours, people and setup, then the tables picked */
  discordTableArgs(args, withTables) {
    const [startText, hoursText, peopleText, setupCode, tablesText] = args;
    const start = fromMinutes36(startText);
    const hours = Number(hoursText);
    const people = Number(peopleText);
    const setup = Object.keys(SETUP_CODES).find((k) => SETUP_CODES[k] === setupCode);
    if (!Number.isFinite(start) || !(hours >= 1 && hours <= 8) || !(people >= 1 && people <= 24) || !setup) return null;
    if (!withTables) return { start, hours, people, setup };
    if (!/^[A-Z0-9]{1,8}(\+[A-Z0-9]{1,8}){0,9}$/.test(String(tablesText || ''))) return null;
    return { start, hours, people, setup, tables: tablesText.split('+') };
  },

  discordTableChoices(ctx, req, rules, now, { notice = '' } = {}) {
    const extras = SETUPS[req.setup];
    const found = this.discordFindTables({ ...req, extras }, rules, now);
    if (found.problem) throw new RuleError(found.problem);
    const span = this.discordSpan(req.start, req.start + req.hours * HOUR, rules, now);
    const title = `Tables for ${req.people}, ${span}`;
    const base = [minutes36(req.start), req.hours, req.people, SETUP_CODES[req.setup]];
    if (found.options.length) {
      return this.discordAnswer(ctx, {
        content: notice,
        embeds: [{
          title, color: GOBLIN,
          description: `Pick a room and Gobgob will book it. You pay at the counter when you arrive.${extras.length ? ' Double tables, for the big setup.' : ''}`,
        }],
        components: [row(...found.options.slice(0, 5).map((o) => button(`${o.room.name}: ${o.tables.join(' + ')} · ${money(o.amount)}`, cid('table', ...base, o.tables.join('+')), STYLE.SUCCESS)))],
      });
    }
    const alternatives = [];
    for (const shift of [1, -1, 2, -2, 3, -3]) {
      const start = req.start + shift * HOUR;
      const other = this.discordFindTables({ ...req, start, extras }, rules, now);
      if (!other.problem && other.options.length) alternatives.push(start);
      if (alternatives.length >= 3) break;
    }
    if (!alternatives.length) return this.discordAnswer(ctx, { content: `${notice ? `${notice}\n` : ''}${DISCORD_WORDS.noTables}`, components: [row(linkButton('See the floor', this.page('book')))] });
    alternatives.sort((a, b) => a - b);
    return this.discordAnswer(ctx, {
      content: notice,
      embeds: [{ title, color: GOBLIN, description: "Every table's taken at that time. There's room at these times:" }],
      components: [row(...alternatives.map((s) => button(`Try ${this.discordClock(s, rules)}`, cid('tmore', minutes36(s), req.hours, req.people, SETUP_CODES[req.setup]), STYLE.PRIMARY)))],
    });
  },

  async discordTableMore(ctx, args) {
    const rules = await this.rules();
    const req = this.discordTableArgs(args, false);
    if (!req) return this.discordSay(ctx, DISCORD_WORDS.oldButton, { error: true });
    return this.discordTableChoices(ctx, req, rules, Date.now());
  },

  async discordTablePick(ctx, args) {
    const rules = await this.rules();
    // --- no awaits until the booking ---
    const req = this.discordTableArgs(args, true);
    if (!req) return this.discordSay(ctx, DISCORD_WORDS.oldButton, { error: true });
    const who = this.discordWho(ctx);
    const d = this.discordDetails(who);
    if (!who.customerId || !d.complete) {
      const boxes = [];
      if (!who.customerId || !d.name) boxes.push(textBox('name', 'Name for the booking', { value: d.name, max: 80 }));
      if (!who.customerId || !isEmail(d.email)) boxes.push(textBox('email', 'Email', { value: d.email, max: 120, description: 'Your confirmation goes here.' }));
      if (!d.mobile) boxes.push(textBox('mobile', 'Mobile', { max: 20, placeholder: '021 123 4567', description: 'So we can reach you on the day.' }));
      boxes.push(textBox('notes', 'Anything we should know?', { paragraph: true, required: false, max: 300 }));
      return modal(cid('mtable', ...args), `Book ${req.tables.join(' + ')}, ${this.discordClock(req.start, rules)}`, boxes);
    }
    return this.discordBookTable(ctx, req, who, { name: d.name, email: d.email, phone: d.mobile }, rules);
  },

  async discordTableSent(ctx, args, f) {
    const rules = await this.rules();
    const req = this.discordTableArgs(args, true);
    if (!req) return this.discordSay(ctx, DISCORD_WORDS.oldButton, { error: true });
    const who = this.discordWho(ctx);
    const d = this.discordDetails(who);
    return this.discordBookTable(ctx, req, who, { name: trimmed(f.name ?? d.name, 80), email: trimmed(f.email ?? d.email, 120), phone: trimmed(f.mobile ?? d.mobile, 40), notes: f.notes }, rules);
  },

  async discordBookTable(ctx, req, who, { name, email, phone, notes = '' }, rules) {
    let res;
    try {
      res = await this.createBooking(
        { kind: 'table', tables: req.tables, start: req.start, end: req.start + req.hours * HOUR, people: req.people, extras: SETUPS[req.setup], name, email, phone, notes: trimmed(notes, 500) },
        who, this.discordClient(ctx),
      );
    } catch (error) {
      // someone took it in the meantime: what's left at that time
      if (error instanceof RuleError && error.status === 409) return this.discordTableChoices(ctx, req, rules, Date.now(), { notice: `⚠️ ${DISCORD_WORDS.taken}` });
      throw error;
    }
    // --- no awaits from here on ---
    const b = res.booking;
    const now = Date.now();
    this.discordOwn('booking', b.id, ctx.userId, null, now);
    const label = `${b.tables.length > 1 ? 'Tables' : 'Table'} ${b.tables.join(', ')}`;
    return this.discordAnswer(ctx, {
      content: res.notice || '',
      embeds: [{
        title: "You're booked in!", color: GOBLIN, description: `Gobgob's already guarding **${label}**.`,
        fields: [
          { name: 'When', value: this.discordSpan(b.start, b.end, rules, now), inline: true },
          { name: 'People', value: String(b.people), inline: true },
          { name: 'Pay', value: b.due > 0 ? `${money(b.due)} at the counter when you arrive` : 'Nothing to pay', inline: true },
          { name: 'Your code', value: `**${b.ref}**`, inline: true },
        ],
        footer: { text: 'Plans changed? Cancel in /mylair so someone else can have the table.' },
      }],
      components: [row(button('Cancel this booking', cid('ask', 'b', b.id), STYLE.DANGER), ...(who.customerId ? [linkButton('Open My Lair', this.page('myLair'))] : []))],
    });
  },

  /** /table's day and time boxes, filled in as they type. Days the Lair is open in the booking horizon; times on the hour. */
  async discordAutocomplete(ctx) {
    const data = ctx.interaction.data || {};
    const rules = await this.rules();
    // --- no awaits from here on ---
    const choices = (list) => ({ type: RESPONSE.CHOICES, data: { choices: list.slice(0, 25) } });
    const focused = (data.options || []).find((o) => o.focused);
    if (data.name !== 'table' || !focused) return choices([]);
    const now = Date.now();
    const time = lairTime(rules.tz);
    const typed = String(focused.value ?? '').trim().toLowerCase();
    const today = time.key(now);
    if (focused.name === 'day') {
      const list = [];
      for (let i = 0; i <= Math.min(rules.horizonDays, 60) && list.length < 25; i += 1) {
        const key = addDays(today, i);
        const win = openWindow(rules, time, key);
        if (!win || win.close <= now + rules.leadMinutes * MIN) continue;
        const day = this.shortDay(time.at(key, 12 * 60), rules);
        const name = i === 0 ? `Today, ${day}` : i === 1 ? `Tomorrow, ${day}` : day;
        const weekday = WEEKDAYS[time.weekday(key)];
        if (!typed || name.toLowerCase().includes(typed) || weekday.startsWith(typed)) list.push({ name, value: key });
      }
      return choices(list);
    }
    if (focused.name === 'time') {
      const opt = optionMap(data.options);
      const key = this.discordDayKey(opt.day, rules, now);
      const win = key ? openWindow(rules, time, key) : null;
      const hours = Math.max(1, Math.floor(Number(opt.hours)) || 1);
      const list = [];
      const from = win ? win.openMin : 10 * 60;
      const to = win ? win.closeMin - hours * 60 : 23 * 60;
      for (let m = Math.ceil(from / 60) * 60; m <= to && m < 24 * 60; m += 60) {
        if (key && time.at(key, m) < now + rules.leadMinutes * MIN) continue;
        const name = clockLabel(m);
        if (!typed || name.includes(typed) || hhmm(m).startsWith(typed)) list.push({ name, value: hhmm(m) });
      }
      return choices(list);
    }
    return choices([]);
  },

  /* ---------------- /mylair ---------------- */
  /**
   * Everything still to come that's theirs: bookings and seats, sign-ups, interests (on their account, or made through
   * the bot) and, for a linked member, the games they're a regular at. Each with what it's called, when, its code, and
   * how to cancel or take it back (drop: 'b:<id>', 'j:<id>', 'i:<id>' or 's:<series id>'). No awaits.
   */
  discordItems(who, rules, now) {
    const me = who.customerId || '';
    const uid = who.discordUserId || '';
    const mine = (kind) => `(customer_id = ? OR id IN (SELECT item_id FROM discord_items WHERE kind = '${kind}' AND user_id = ?))`;
    const out = [];
    const bookings = this.sql.exec(
      `SELECT * FROM bookings WHERE ends_at > ? AND status IN ('held', 'confirmed', 'seated') AND kind IN ('table', 'gm-seat') AND ${mine('booking')} ORDER BY starts_at, id LIMIT 30`,
      now, me, uid,
    ).toArray().map((r) => this.rowToBooking(r));
    for (const b of bookings) {
      const game = b.kind === 'gm-seat' && b.gameId ? this.game(b.gameId) : null;
      const occ = b.occurrenceId ? findOccurrence(rules, b.occurrenceId) : null;
      const title = game ? game.title : occ ? `Game table at ${occ.title}` : `${b.tables.length > 1 ? 'Tables' : 'Table'} ${b.tables.join(', ')}`;
      const due = this.ownView(b).due;
      out.push({
        type: 'b', id: b.id, icon: game ? '🎲' : '🪑', title, start: b.start, when: this.discordSpan(b.start, b.end, rules, now), code: this.ticketCode(b),
        extra: [b.seriesId ? 'every session' : '', due > 0 ? `${money(due)} at the counter` : ''].filter(Boolean).join(', '),
        drop: b.start > now ? `b:${b.id}` : null, dropWord: game ? 'Drop' : 'Cancel', regular: Boolean(b.seriesId), seat: Boolean(game),
      });
    }
    const joins = this.sql.exec(
      `SELECT * FROM event_joins WHERE ends_at > ? AND status NOT IN ('cancelled', 'noshow') AND ${mine('join')} ORDER BY starts_at, id LIMIT 30`,
      now, me, uid,
    ).toArray().map((r) => this.rowToJoin(r));
    for (const j of joins) {
      const due = Math.max(0, (j.amount || 0) - (j.paidAmount || 0));
      out.push({
        type: 'j', id: j.id, icon: '🎟️', title: j.title, start: j.start, when: this.discordSpan(j.start, j.end, rules, now), code: j.ref,
        extra: j.status === 'held' ? 'waiting to be paid online' : !j.paid && due > 0 ? `${money(due)} at the counter` : '', drop: `j:${j.id}`, dropWord: 'Drop',
      });
    }
    const said = { interested: 'interested', maybe: 'maybe', coming: 'coming', waitlist: 'on the waitlist' };
    const interests = this.sql.exec(`SELECT * FROM interests WHERE ends_at > ? AND status = 'active' AND ${mine('interest')} ORDER BY starts_at, rowid LIMIT 30`, now, me, uid).toArray();
    for (const r of interests) {
      out.push({
        type: 'i', id: r.id, icon: '👀', title: r.title || 'A session', start: r.starts_at, when: this.discordSpan(r.starts_at, r.ends_at, rules, now), code: '',
        extra: said[r.level] || r.level, drop: `i:${r.id}`, dropWord: 'Take back',
      });
    }
    if (me) {
      const series = this.sql.exec(
        `SELECT m.series_id, s.details FROM series_members m JOIN series s ON s.id = m.series_id WHERE m.customer_id = ? AND m.status = 'active' AND s.status = 'active'`,
        me,
      ).toArray();
      for (const s of series) {
        let title = 'A regular game';
        try {
          title = JSON.parse(s.details || '{}').title || title;
        } catch {
          // keep the plain name
        }
        out.push({ type: 's', id: s.series_id, icon: '🔁', title, start: Infinity, when: 'Your seat is saved every session', code: '', extra: '', drop: `s:${s.series_id}`, dropWord: 'Stop' });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  },

  async discordMine(ctx, { notice = '' } = {}) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const who = this.discordWho(ctx);
    const items = this.discordItems(who, rules, now);
    const lines = items.map((it) => `${it.icon} **${clip(it.title, 70)}** · ${it.when}${it.code ? ` · \`${it.code}\`` : ''}${it.extra ? ` · ${it.extra}` : ''}`);
    const embed = {
      title: 'Your Lair', color: GOBLIN,
      description: lines.length ? clip(lines.join('\n'), 4000) : 'Nothing booked yet. Try /games, /events or /table and Gobgob will sort you out.',
      ...(who.customerId ? {} : { footer: { text: 'Bookings from the website show here too once you link your account with /link.' } }),
    };
    const options = items.filter((it) => it.drop).slice(0, 25).map((it) => ({
      label: clip(`${it.dropWord}: ${it.title}`, 100), value: it.drop, description: clip(`${it.when}${it.code ? ` · ${it.code}` : ''}`, 100),
    }));
    const components = [];
    if (options.length) components.push(selectRow(cid('mine'), 'Cancel something or take it back', options));
    components.push(row(who.customerId ? linkButton('Open My Lair', this.page('myLair')) : linkButton('Link my account', this.discordLinkUrl())));
    return this.discordAnswer(ctx, { content: notice, embeds: [embed], components });
  },

  /** "Drop your seat at …?": only for something that's theirs (it's looked up among their own) */
  async discordAsk(ctx, value) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const m = String(value || '').match(/^([bjis]):([A-Za-z0-9_-]{3,64})$/);
    if (!m) return this.discordSay(ctx, DISCORD_WORDS.oldButton, { error: true });
    const item = this.discordItems(this.discordWho(ctx), rules, now).find((it) => it.drop === `${m[1]}:${m[2]}`);
    if (!item) return this.discordSay(ctx, DISCORD_WORDS.gone, { error: true });
    const title = `**${clip(item.title, 100)}**`;
    const question = {
      b: item.seat ? `Drop your seat at ${title} (${item.when})?${item.regular ? " That's just this session: you stay a regular." : ''}` : `Cancel ${title} (${item.when})?`,
      j: `Drop your spot at ${title} (${item.when})?`,
      i: `Take back "${item.extra}" for ${title}?`,
      s: `Stop being a regular at ${title}? Gobgob stops saving your seat, and your upcoming seats are freed.`,
    }[m[1]];
    const yes = { b: item.seat ? 'Yes, drop it' : 'Yes, cancel it', j: 'Yes, drop it', i: 'Yes, take it back', s: 'Yes, stop' }[m[1]];
    return this.discordAnswer(ctx, { content: question, components: [row(button(yes, cid('drop', m[1], m[2]), STYLE.DANGER), button('Keep it', cid('keep')))] });
  },

  async discordDrop(ctx, type, id) {
    if (!['b', 'j', 'i', 's'].includes(type) || !ID.test(String(id || ''))) return this.discordSay(ctx, DISCORD_WORDS.oldButton, { error: true });
    const who = this.discordWho(ctx);
    let res;
    let done;
    if (type === 'b') {
      const before = this.booking(id);
      res = await this.updateBooking(id, { status: 'cancelled' }, who);
      done = before?.kind === 'gm-seat'
        ? `Done. Gobgob has let the GM know.${before.seriesId ? " That was just this session's seat: you're still a regular." : ''}`
        : 'Done. Your table is free for someone else.';
    } else if (type === 'j') {
      res = await this.cancelJoin(id, who);
      done = 'Done. Your spot is free for someone else.';
    } else if (type === 'i') {
      const key = this.discordItemKey('interest', id, ctx.userId);
      res = await this.removeInterest(id, key ? { key } : {}, who);
      done = 'Taken back.';
    } else {
      if (!who.customerId) return this.discordSay(ctx, DISCORD_WORDS.gone, { error: true });
      res = await this.leaveSeries(id, who, {});
      done = "You're not a regular there any more. Gobgob will miss you.";
    }
    return this.discordMine(ctx, { notice: [done, res?.notice].filter(Boolean).join(' ') });
  },

  /* ---------------- linking ---------------- */
  async discordLinkInfo(ctx) {
    const link = this.discordLinkRow(ctx.userId);
    if (link) {
      const m = this.memberRow(link.customer_id);
      const name = trimmed(m?.name || m?.first_name, 60);
      return this.discordAnswer(ctx, {
        content: `Linked to ${name ? `**${name}**'s` : 'your'} Dice Goblin account${m?.code ? ` (member code **${m.code}**)` : ''}. Gobgob books you in with one tap, and everything shows up in My Lair.`,
        components: [row(linkButton('Open My Lair', this.page('myLair')), button('Unlink', cid('unlink'), STYLE.DANGER))],
      });
    }
    if (!this.discordCanLink()) return this.discordSay(ctx, DISCORD_WORDS.linkOff);
    return this.discordAnswer(ctx, {
      content: 'Link your Discord to your Dice Goblin account and Gobgob books you in with one tap, with everything in My Lair. Log in on the website and tap Link Discord. It takes a minute.',
      components: [row(linkButton('Link my account', this.discordLinkUrl()))],
    });
  },

  async discordUnlinkHere(ctx) {
    this.sql.exec('DELETE FROM discord_links WHERE user_id = ?', ctx.userId);
    return this.discordAnswer(ctx, { content: 'Unlinked. Anything you booked stays booked.', components: [] });
  },

  discordRedirect() {
    return String(this.env.DISCORD_REDIRECT_URI || '').trim() || this.page('myLair');
  },

  /** What My Lair shows: whether Link Discord works, and the account linked (or null). No awaits. */
  discordMemberView(customerId) {
    const link = customerId ? this.sql.exec('SELECT * FROM discord_links WHERE customer_id = ?', String(customerId)).toArray()[0] : null;
    return {
      ready: this.discordCanLink(),
      linked: link ? { username: link.username || '', name: link.global_name || link.username || '', at: link.linked_at } : null,
    };
  },

  /**
   * POST /me/discord/start (logged in): Discord's sign-in page to send them to, with a state that's theirs alone, used once
   * and good for 10 minutes. Discord sends them back to My Lair, which finishes it (POST /me/discord/finish). → { url }
   */
  async discordStart(who) {
    if (!who.customerId) throw new RuleError(DISCORD_WORDS.linkLogin, 401);
    if (!this.discordCanLink()) throw new RuleError(DISCORD_WORDS.linkOff, 503);
    // --- no awaits from here on ---
    const now = Date.now();
    this.sql.exec('DELETE FROM discord_states WHERE created_at < ?', now - DAY);
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const state = `dg${[...bytes].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
    this.sql.exec('INSERT INTO discord_states (state, customer_id, created_at) VALUES (?, ?, ?)', state, String(who.customerId), now);
    const query = new URLSearchParams({ response_type: 'code', client_id: this.env.DISCORD_APPLICATION_ID, scope: 'identify', redirect_uri: this.discordRedirect(), state, prompt: 'none' });
    return { url: `https://discord.com/oauth2/authorize?${query}` };
  },

  /**
   * POST /me/discord/finish { code, state } (logged in, from My Lair when Discord sends them back): the state must be one
   * this member started in the last 10 minutes and never used (claimed first, so it works once). Discord swaps the code for
   * who they are (Discord's id and name only: the token is thrown away), and that Discord account is linked to this member,
   * one to one (an earlier link of either is replaced). What they made through the bot as a guest joins their account.
   * → { discord: discordMemberView, adopted }
   */
  async discordFinish(input, who) {
    if (!who.customerId) throw new RuleError(DISCORD_WORDS.linkLogin, 401);
    if (!this.discordCanLink()) throw new RuleError(DISCORD_WORDS.linkOff, 503);
    const code = trimmed(input?.code, 200);
    const state = trimmed(input?.state, 100);
    if (!code || !/^dg[0-9a-f]{32}$/.test(state)) throw new RuleError(DISCORD_WORDS.linkExpired);
    // --- claim the state: no awaits until it's used ---
    const now = Date.now();
    const started = this.sql.exec('SELECT * FROM discord_states WHERE state = ?', state).toArray()[0];
    if (!started || started.used_at || String(started.customer_id) !== String(who.customerId) || now - started.created_at > STATE_TTL) throw new RuleError(DISCORD_WORDS.linkExpired);
    this.sql.exec('UPDATE discord_states SET used_at = ? WHERE state = ? AND used_at IS NULL', now, state);
    const user = await this.discordOAuthUser(code);
    // --- no awaits from here on ---
    const at = Date.now();
    this.sql.exec('DELETE FROM discord_links WHERE user_id = ? OR customer_id = ?', user.id, String(who.customerId));
    this.sql.exec(
      'INSERT INTO discord_links (user_id, customer_id, username, global_name, linked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      user.id, String(who.customerId), user.username || null, user.globalName || null, at, at,
    );
    const adopted = this.discordAdopt(user.id, who.customerId, at);
    return { discord: this.discordMemberView(who.customerId), adopted };
  },

  /** Discord's answer to the code: { id, username, globalName }. Throws the words My Lair shows. The token is revoked straight after. */
  async discordOAuthUser(code) {
    const form = new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: this.discordRedirect(), client_id: this.env.DISCORD_APPLICATION_ID, client_secret: this.env.DISCORD_CLIENT_SECRET,
    });
    let token = null;
    try {
      const res = await fetch(`${DISCORD_API}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': DISCORD_UA }, body: form.toString() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.access_token) {
        this.note({ discordError: { message: `Link Discord: ${res.status} ${trimmed(data?.error_description || data?.error || '', 200)}`, at: new Date().toISOString() } });
        throw new RuleError(DISCORD_WORDS.linkRefused);
      }
      token = data.access_token;
      const me = await fetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': DISCORD_UA } });
      const user = await me.json().catch(() => ({}));
      if (!me.ok || !SNOWFLAKE.test(String(user?.id || ''))) throw new RuleError(DISCORD_WORDS.linkRefused);
      return { id: String(user.id), username: trimmed(user.username, 40), globalName: trimmed(user.global_name, 40) };
    } catch (error) {
      if (error instanceof RuleError) throw error;
      console.error('Lair: Discord sign-in failed', error);
      throw new RuleError(DISCORD_WORDS.linkDown, 502);
    } finally {
      if (token) {
        const revoke = new URLSearchParams({ token, token_type_hint: 'access_token', client_id: this.env.DISCORD_APPLICATION_ID, client_secret: this.env.DISCORD_CLIENT_SECRET });
        this.later(fetch(`${DISCORD_API}/oauth2/token/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': DISCORD_UA }, body: revoke.toString() }));
      }
    }
  },

  /** What a Discord user made through the bot as a guest joins the account they linked (upcoming, or ended in the last 30 days). No awaits. */
  discordAdopt(userId, customerId, now) {
    const since = now - ADOPT_DAYS * DAY;
    const id = String(customerId);
    let n = 0;
    for (const [table, kind, extra] of [['bookings', 'booking', " AND kind != 'gm'"], ['event_joins', 'join', ''], ['interests', 'interest', '']]) {
      const where = `customer_id IS NULL AND ends_at > ?${extra} AND id IN (SELECT item_id FROM discord_items WHERE kind = '${kind}' AND user_id = ?)`;
      const count = this.sql.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, since, String(userId)).toArray()[0]?.n || 0;
      if (count) this.write(`UPDATE ${table} SET customer_id = ?, updated_at = ? WHERE ${where}`, id, now, since, String(userId));
      n += count;
    }
    // counted once per session or date, as adoptInterests does
    this.write(
      `UPDATE interests SET status = 'removed', updated_at = ? WHERE customer_id = ? AND status = 'active'
         AND rowid NOT IN (SELECT MIN(rowid) FROM interests WHERE customer_id = ? AND status = 'active' GROUP BY kind, target_id)`,
      now, id, id,
    );
    return n;
  },

  /** POST /me/discord/unlink (logged in) → { ok, discord } */
  async discordUnlink(who) {
    if (!who.customerId) throw new RuleError(DISCORD_WORDS.linkLogin, 401);
    this.sql.exec('DELETE FROM discord_links WHERE customer_id = ?', String(who.customerId));
    return { ok: true, discord: this.discordMemberView(who.customerId) };
  },

  /* ---------------- /lair-setup (server managers) ---------------- */
  discordIsManager(ctx) {
    try {
      const perms = BigInt(ctx.interaction.member?.permissions || '0');
      return (perms & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n;
    } catch {
      return false;
    }
  },

  async discordSetup(ctx) {
    if (!this.discordIsManager(ctx)) return this.discordSay(ctx, DISCORD_WORDS.managers, { error: true });
    // The first /lair-setup ties Gobgob to this server (DISCORD_GUILD_ID in the config does the same)
    if (!this.discordSettings().guild) this.saveDiscordSetting('guild', ctx.guild, ctx.userId);
    return this.discordAnswer(ctx, this.discordSetupPanel());
  },

  discordSetupPanel(notice = '') {
    const s = this.discordSettings();
    const where = (id, type) => (id ? `<#${id}>${type === CHANNEL.FORUM ? ' (a forum: each one gets its own post)' : ''}` : 'Not picked yet');
    const onOff = (on) => (on ? 'On' : 'Off');
    const fields = [
      { name: 'TTRPG sessions go to', value: where(s.sessionsChannel, s.sessionsType), inline: true },
      { name: 'Events go to', value: where(s.eventsChannel, s.eventsType), inline: true },
      { name: 'Seat pings mention', value: s.pingRole ? `<@&${s.pingRole}>` : 'Nobody (the ping still goes up)', inline: true },
      { name: 'Switches', value: `Auto-posts: ${onOff(s.posts)} · Seat pings: ${onOff(s.pings)} · Midday round-up: ${onOff(s.digest)}` },
    ];
    if (!this.env.DISCORD_BOT_TOKEN) fields.push({ name: 'Heads up', value: "The bot's token isn't in Cloudflare yet (DISCORD_BOT_TOKEN), so nothing can be posted." });
    const channelPick = (id, placeholder, current) => row({
      type: COMPONENT.CHANNEL_SELECT, custom_id: cid('set', id), placeholder, channel_types: POSTABLE, min_values: 0, max_values: 1,
      ...(current ? { default_values: [{ id: current, type: 'channel' }] } : {}),
    });
    return {
      content: notice,
      embeds: [{
        title: "Gobgob's Discord setup", color: POTION, fields,
        description: 'Pick where new sessions and events go up. Gobgob keeps each post\'s seats up to date, opens a chat thread for each session, and pings the role you pick when a seat opens up.',
      }],
      components: [
        channelPick('sessions', 'Channel for TTRPG sessions', s.sessionsChannel),
        channelPick('events', 'Channel for events', s.eventsChannel),
        row({ type: COMPONENT.ROLE_SELECT, custom_id: cid('set', 'role'), placeholder: 'Role to ping when a seat opens (optional)', min_values: 0, max_values: 1, ...(s.pingRole ? { default_values: [{ id: s.pingRole, type: 'role' }] } : {}) }),
        row(
          button(`Auto-posts: ${onOff(s.posts)}`, cid('set', 'posts'), s.posts ? STYLE.SUCCESS : STYLE.SECONDARY),
          button(`Seat pings: ${onOff(s.pings)}`, cid('set', 'pings'), s.pings ? STYLE.SUCCESS : STYLE.SECONDARY),
          button(`Round-up: ${onOff(s.digest)}`, cid('set', 'digest'), s.digest ? STYLE.SUCCESS : STYLE.SECONDARY),
          button('Post now', cid('set', 'sync'), STYLE.PRIMARY),
        ),
      ],
    };
  },

  async discordSetupChange(ctx, what) {
    if (!this.discordIsManager(ctx)) return this.discordSay(ctx, DISCORD_WORDS.managers, { error: true });
    const now = Date.now();
    const data = ctx.interaction.data || {};
    const s = this.discordSettings();
    if (!s.guild) this.saveDiscordSetting('guild', ctx.guild, ctx.userId, now);
    let notice = '';
    if (what === 'sessions' || what === 'events') {
      const id = data.values?.[0] || null;
      const type = id ? Number(data.resolved?.channels?.[id]?.type ?? CHANNEL.TEXT) : CHANNEL.TEXT;
      if (id && (!SNOWFLAKE.test(String(id)) || !POSTABLE.includes(type))) return this.discordSay(ctx, 'Pick a text, announcement or forum channel.', { error: true });
      this.saveDiscordSetting(`${what}_channel`, id, ctx.userId, now);
      this.saveDiscordSetting(`${what}_type`, type, ctx.userId, now);
      notice = id ? `Got it. ${what === 'sessions' ? 'TTRPG sessions' : 'Events'} go to <#${id}>.` : `${what === 'sessions' ? 'TTRPG sessions' : 'Events'} won't be posted.`;
    } else if (what === 'role') {
      const id = data.values?.[0] || null;
      if (id && !SNOWFLAKE.test(String(id))) return this.discordSay(ctx, DISCORD_WORDS.oldButton, { error: true });
      this.saveDiscordSetting('ping_role', id, ctx.userId, now);
      notice = id ? `Seat pings will mention <@&${id}>.` : "Seat pings won't mention a role.";
    } else if (['posts', 'pings', 'digest'].includes(what)) {
      this.saveDiscordSetting(what, s[what] ? 'off' : 'on', ctx.userId, now);
    } else if (what === 'sync') {
      if (!this.discordCanPost()) notice = 'Pick a channel first (and check the bot token is in Cloudflare).';
      else {
        const out = await this.discordSync({ force: true });
        notice = out?.busy ? 'Gobgob is already posting. Give it a moment.' : `Done: ${plural(out?.created || 0, 'new post', 'new posts')}, ${plural(out?.edited || 0, 'update', 'updates')}${out?.failed ? `, ${out.failed} Discord refused (check the bot can post in that channel)` : ''}.`;
      }
    } else return this.discordSay(ctx, DISCORD_WORDS.oldButton, { error: true });
    if (what !== 'sync') this.discordSoon();
    return this.discordAnswer(ctx, this.discordSetupPanel(notice));
  },

  /* ---------------- posts in the server ---------------- */
  /** Discord's REST API as the bot. Never throws. A 429 or a refused token holds posting off for a while. */
  async discordRest(method, path, body) {
    const token = this.env.DISCORD_BOT_TOKEN;
    if (!token) return { ok: false, status: 0, data: { message: 'No bot token.' } };
    let res;
    try {
      res = await fetch(`${DISCORD_API}${path}`, {
        method, headers: { Authorization: `Bot ${token}`, 'User-Agent': DISCORD_UA, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      return { ok: false, status: 0, data: { message: String(error?.message || error) } };
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.status === 429) {
      const wait = Math.min(600, Math.max(1, Number(data?.retry_after) || Number(res.headers.get('Retry-After')) || 5));
      this.discordBackoffUntil = Date.now() + Math.ceil(wait * 1000);
    } else if (res.status === 401) {
      this.discordBackoffUntil = Date.now() + HOUR;
      this.note({ discordError: { message: "Discord didn't accept the bot token (DISCORD_BOT_TOKEN).", at: new Date().toISOString() } });
    }
    return { ok: res.ok, status: res.status, data };
  },

  discordWhy(res) {
    return trimmed(`${res.status || 'no answer'}${res.data?.code ? ` (${res.data.code})` : ''} ${res.data?.message || ''}`, 300);
  },

  /**
   * After a booking, seat, sign-up or session changes (write() calls this): bring the posts up to date a moment later,
   * once for a burst of changes. Nothing happens until the bot can post.
   */
  discordSoon() {
    if (this.discordPending || this.discordAuto === false) return;
    try {
      if (!this.discordCanPost()) return;
    } catch {
      return;
    }
    const delay = this.discordDelay ?? SYNC_DELAY;
    this.discordPending = new Promise((resolve) => setTimeout(resolve, delay)).then(() => {
      this.discordPending = null;
      return this.discordSync();
    });
    this.later(this.discordPending);
  },

  /** A session's post: the card everyone sees, with the buttons everyone gets */
  discordSessionMessage(view, rules, now) {
    return { embeds: [this.discordSessionEmbed(view, rules, now)], components: this.discordSessionButtons(view, now), allowed_mentions: { parse: [] } };
  },

  discordEventMessage(o, rules, now) {
    return { embeds: [this.discordEventEmbed(o, rules, now)], components: this.discordEventButtons(o), allowed_mentions: { parse: [] } };
  },

  /** A post that's done: its title, why, and a way to the website */
  discordEndedMessage(post, why) {
    const event = post.kind === 'event';
    const text = {
      finished: event ? "This one's been and gone. See you at the next one!" : 'This session has been played. Gobgob hopes the dice were kind.',
      over: 'No more sessions on the calendar for this one.',
      cancelled: 'This session was cancelled.',
      gone: "This date isn't on the calendar any more.",
      off: 'This one is off the board for now.',
    }[why] || 'This one is off the board for now.';
    return {
      content: '', allowed_mentions: { parse: [] },
      embeds: [{ title: clip(post.title || 'Dice Goblin', 256), description: text, color: 0x6b6b6b }],
      components: [row(event ? linkButton("What's on next", this.page('events')) : linkButton('The games board', this.page('gm')))],
    };
  },

  /** Why a live post is no longer wanted (a session that finished, a series with no dates left, an event date gone). No awaits. */
  discordEndReason(post, rules, now) {
    if (post.kind === 'session') {
      if (post.id.startsWith('s:')) {
        const seriesId = post.id.slice(2);
        const series = this.sql.exec('SELECT status FROM series WHERE id = ?', seriesId).toArray()[0];
        if (!series || series.status !== 'active') return 'over';
        return this.nextSession(seriesId, now) ? 'off' : 'over';
      }
      const g = this.game(post.target_id);
      if (!g || g.status === 'cancelled') return 'cancelled';
      return g.end <= now ? 'finished' : 'off';
    }
    const o = findOccurrence(rules, post.target_id);
    if (!o) return 'gone';
    return o.end <= now ? 'finished' : 'off';
  },

  /**
   * What the channels should show now, against what they do (discord_posts), as a list of jobs: new posts, edits, posts
   * to close off, and pings for a seat or place that opened up in something that was full. Soonest first. No awaits.
   */
  discordPlan(rules, now) {
    const s = this.discordSettings();
    const want = new Map();
    if (s.sessionsChannel) {
      for (const view of this.discordSessions(rules, now, now + (rules.horizonDays + 2) * DAY)) {
        const key = view.seriesId ? `s:${view.seriesId}` : `g:${view.id}`;
        const message = this.discordSessionMessage(view, rules, now);
        want.set(key, {
          key, kind: 'session', targetId: view.id, channel: s.sessionsChannel, channelType: s.sessionsType, title: view.title, start: view.start,
          message, hash: shortHash(JSON.stringify(message)), left: Math.max(0, view.seats - view.taken), thread: true, ref: view.id,
        });
      }
    }
    if (s.eventsChannel) {
      for (const o of eventOccurrences(rules, now, now + EVENT_POST_DAYS * DAY)) {
        if (o.end <= now) continue;
        const message = this.discordEventMessage(o, rules, now);
        want.set(`e:${o.id}`, {
          key: `e:${o.id}`, kind: 'event', targetId: o.id, channel: s.eventsChannel, channelType: s.eventsType,
          title: `${o.title} · ${this.shortDay(o.start, rules)}`, start: o.start, message, hash: shortHash(JSON.stringify(message)),
          left: o.capacity ? Math.max(0, o.capacity - this.placesTaken(o.id)) : null, thread: false, ref: occRef(o.id), capacity: Boolean(o.capacity),
        });
      }
    }
    const rows = this.sql.exec("SELECT * FROM discord_posts WHERE status IN ('creating', 'live', 'failed')").toArray();
    const have = new Map(rows.map((r) => [r.id, r]));
    const jobs = [];
    for (const w of want.values()) {
      const post = have.get(w.key);
      if (!post) {
        jobs.push({ job: 'create', w });
        continue;
      }
      if (post.status === 'creating') {
        if (now - (post.updated_at || post.created_at) > CREATING_STALE) jobs.push({ job: 'create', w, post });
        continue;
      }
      if (post.status === 'failed') {
        if ((post.tries || 0) < MAX_TRIES && now - (post.updated_at || 0) >= RETRY_FAILED) jobs.push({ job: post.message_id ? 'edit' : 'create', w, post });
        continue;
      }
      if (post.channel_id !== w.channel) {
        jobs.push({ job: 'move', post }, { job: 'create', w });
        continue;
      }
      if (post.hash !== w.hash) jobs.push({ job: 'edit', w, post });
      const opened = w.left > 0 && post.seats_left === 0 && w.start > now && w.start - now <= PING_DAYS * DAY && (!post.pinged_at || now - post.pinged_at >= PING_GAP);
      if (s.pings && opened) jobs.push({ job: 'ping', w, post });
    }
    for (const post of rows) {
      if (post.status === 'live' && !want.has(post.id)) jobs.push({ job: 'end', post, why: this.discordEndReason(post, rules, now) });
    }
    const rank = { move: 0, ping: 1, edit: 2, end: 3, create: 4 };
    return jobs.sort((a, b) => rank[a.job] - rank[b.job] || (a.w?.start ?? a.post?.starts_at ?? 0) - (b.w?.start ?? b.post?.starts_at ?? 0));
  },

  /**
   * One round of posting (discordPlan's jobs, up to SYNC_BUDGET Discord calls): never two at once in this Lair, and held
   * off while Discord says to wait. → { created, edited, ended, pinged, failed, more }
   */
  async discordSync({ force = false } = {}) {
    if (!this.discordCanPost()) return { off: true };
    if (this.discordSyncing) {
      this.discordAgain = true;
      return { busy: true };
    }
    if (!force && Date.now() < (this.discordBackoffUntil || 0)) return { waiting: true };
    this.discordSyncing = true;
    const out = { created: 0, edited: 0, ended: 0, pinged: 0, failed: 0, more: false };
    try {
      const rules = await this.rules();
      const jobs = this.discordPlan(rules, Date.now());
      let calls = 0;
      for (const job of jobs) {
        if (calls >= SYNC_BUDGET || Date.now() < (this.discordBackoffUntil || 0)) {
          out.more = true;
          break;
        }
        if (job.job === 'move') {
          // the channel changed in /lair-setup: the old post stays where it is, untouched, and a new one goes up
          this.sql.exec("UPDATE discord_posts SET id = ?, status = 'moved', updated_at = ? WHERE id = ?", `${job.post.id}~${Date.now()}`, Date.now(), job.post.id);
          continue;
        }
        if (job.job === 'create') calls += await this.discordCreatePost(job.w, job.post, out);
        else if (job.job === 'edit') calls += await this.discordEditPost(job.post, job.w, out);
        else if (job.job === 'ping') calls += await this.discordPing(job.post, job.w, out);
        else if (job.job === 'end') calls += await this.discordEndPost(job.post, job.why, out);
      }
    } catch (error) {
      console.error('Lair: Discord posting failed', error);
      out.error = String(error?.message || error).slice(0, 300);
    } finally {
      this.discordSyncing = false;
      if (this.discordAgain) {
        this.discordAgain = false;
        this.discordSoon();
      }
    }
    if (out.failed || out.error) this.note({ discordPosts: { ...out, at: new Date().toISOString() } });
    return out;
  },

  /** A new post: a message (and a thread from it, for a session), or a forum post, which is its own thread. The row is claimed first. */
  async discordCreatePost(w, post, out) {
    const now = Date.now();
    if (post) this.sql.exec("UPDATE discord_posts SET status = 'creating', channel_id = ?, channel_type = ?, updated_at = ? WHERE id = ?", w.channel, w.channelType, now, w.key);
    else {
      this.sql.exec(
        `INSERT INTO discord_posts (id, kind, target_id, channel_id, channel_type, status, title, starts_at, tries, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'creating', ?, ?, 0, ?, ?)`,
        w.key, w.kind, w.targetId, w.channel, w.channelType, w.title, w.start, now, now,
      );
    }
    const forum = w.channelType === CHANNEL.FORUM;
    const name = clip(w.title, 100);
    let calls = 1;
    const res = forum
      ? await this.discordRest('POST', `/channels/${w.channel}/threads`, { name, auto_archive_duration: THREAD_ARCHIVE, message: w.message })
      : await this.discordRest('POST', `/channels/${w.channel}/messages`, { ...w.message, nonce: shortHash(`${w.key}|${w.channel}`).slice(0, 25), enforce_nonce: true });
    if (!res.ok) {
      this.sql.exec("UPDATE discord_posts SET status = 'failed', tries = tries + 1, error = ?, updated_at = ? WHERE id = ?", this.discordWhy(res), Date.now(), w.key);
      out.failed += 1;
      return calls;
    }
    let messageId;
    let threadId = null;
    let where = w.channel;
    if (forum) {
      // a forum post is a thread, and its first message has the thread's id
      threadId = String(res.data?.id || '');
      messageId = String(res.data?.message?.id || threadId);
      where = threadId;
    } else {
      messageId = String(res.data?.id || '');
      if (w.thread && messageId) {
        calls += 1;
        const t = await this.discordRest('POST', `/channels/${w.channel}/messages/${messageId}/threads`, { name, auto_archive_duration: THREAD_ARCHIVE });
        if (t.ok) threadId = String(t.data?.id || messageId);
      }
    }
    this.sql.exec(
      `UPDATE discord_posts SET status = 'live', message_id = ?, message_channel = ?, thread_id = ?, hash = ?, seats_left = ?, title = ?, starts_at = ?, error = NULL,
         tries = 0, updated_at = ? WHERE id = ?`,
      messageId, where, threadId, w.hash, w.left, w.title, w.start, Date.now(), w.key,
    );
    out.created += 1;
    return calls;
  },

  /** A post's card brought up to date (a forum thread that went quiet is opened again first) */
  async discordEditPost(post, w, out) {
    const where = post.message_channel || post.channel_id;
    let calls = 1;
    let res = await this.discordRest('PATCH', `/channels/${where}/messages/${post.message_id}`, w.message);
    if (!res.ok && res.data?.code === 50083 && post.thread_id) {
      calls += 2;
      await this.discordRest('PATCH', `/channels/${post.thread_id}`, { archived: false });
      res = await this.discordRest('PATCH', `/channels/${where}/messages/${post.message_id}`, w.message);
    }
    const now = Date.now();
    if (res.ok) {
      this.sql.exec(
        "UPDATE discord_posts SET status = 'live', hash = ?, seats_left = ?, title = ?, starts_at = ?, target_id = ?, error = NULL, tries = 0, updated_at = ? WHERE id = ?",
        w.hash, w.left, w.title, w.start, w.targetId, now, post.id,
      );
      out.edited += 1;
    } else if (res.status === 404 || [10003, 10008].includes(res.data?.code)) {
      // deleted in Discord: put up a fresh one next round
      this.sql.exec("UPDATE discord_posts SET id = ?, status = 'gone', error = ?, updated_at = ? WHERE id = ?", `${post.id}~${now}`, this.discordWhy(res), now, post.id);
      out.failed += 1;
    } else {
      this.sql.exec(
        `UPDATE discord_posts SET tries = tries + 1, error = ?, status = CASE WHEN tries + 1 >= ? THEN 'failed' ELSE status END, updated_at = ? WHERE id = ?`,
        this.discordWhy(res), MAX_TRIES, now, post.id,
      );
      out.failed += 1;
    }
    return calls;
  },

  /** A seat or place opened up in something that was full: say so where people will see it, mentioning the role picked */
  async discordPing(post, w, out) {
    const s = this.discordSettings();
    const rules = this.rulesCache;
    // claimed first, so the next round can't ping it again
    this.sql.exec('UPDATE discord_posts SET pinged_at = ? WHERE id = ?', Date.now(), post.id);
    const when = `${this.discordDay(w.start, rules)}, ${this.discordClock(w.start, rules)}`;
    const what = w.kind === 'session' ? 'A seat just opened up' : 'A place just opened up';
    const more = w.left === 1 ? 'Just the one, so be quick.' : `${w.left} going.`;
    const content = `${s.pingRole ? `<@&${s.pingRole}> ` : ''}${what} at **${clip(w.kind === 'session' ? w.title : w.title.replace(/ · [^·]+$/, ''), 100)}** (${when}). ${more}`;
    const grab = w.kind === 'session'
      ? button('Grab a seat', cid('seat', w.ref), STYLE.SUCCESS, { emoji: '🎲' })
      : button('Sign up', cid('join', w.ref), STYLE.SUCCESS, { emoji: '🎟️' });
    // a forum post's ping goes in its thread (forums take posts, not messages)
    const where = post.channel_type === CHANNEL.FORUM && post.thread_id ? post.thread_id : post.channel_id;
    const res = await this.discordRest('POST', `/channels/${where}/messages`, {
      content, components: [row(grab)], allowed_mentions: s.pingRole ? { roles: [s.pingRole] } : { parse: [] },
    });
    if (res.ok) out.pinged += 1;
    else out.failed += 1;
    return 1;
  },

  /**
   * A post that's done says so and loses its buttons. Its row is set aside under a new id, so the same session or date
   * gets a fresh post if it comes back (approved again, or put back on the calendar). Discord refusing is tried again
   * next round, up to MAX_TRIES times.
   */
  async discordEndPost(post, why, out) {
    const where = post.message_channel || post.channel_id;
    const message = this.discordEndedMessage(post, why);
    let calls = 1;
    let res = await this.discordRest('PATCH', `/channels/${where}/messages/${post.message_id}`, message);
    if (!res.ok && res.data?.code === 50083 && post.thread_id) {
      calls += 2;
      await this.discordRest('PATCH', `/channels/${post.thread_id}`, { archived: false });
      res = await this.discordRest('PATCH', `/channels/${where}/messages/${post.message_id}`, message);
    }
    const now = Date.now();
    const settled = res.ok || res.status === 404 || [10003, 10008].includes(res.data?.code) || (post.tries || 0) + 1 >= MAX_TRIES;
    if (settled) {
      this.sql.exec(
        "UPDATE discord_posts SET id = ?, status = 'ended', error = ?, updated_at = ? WHERE id = ?",
        `${post.id}~${now}`, res.ok ? null : this.discordWhy(res), now, post.id,
      );
    } else this.sql.exec('UPDATE discord_posts SET tries = tries + 1, error = ?, updated_at = ? WHERE id = ?', this.discordWhy(res), now, post.id);
    if (res.ok) out.ended += 1;
    else out.failed += 1;
    return calls;
  },

  /**
   * Once a day from midday: today's sessions and events with room left, in one message with a list to pick from, when
   * there are any. It goes in the sessions channel (or the events one), never a forum, which takes posts, not messages.
   * Noted for the day before it's sent, so it goes once.
   */
  async discordDigest(rules, now = Date.now()) {
    const s = this.discordSettings();
    if (!s.digest || !this.discordCanPost()) return null;
    const time = lairTime(rules.tz);
    if (time.parts(now).h < DIGEST_HOUR) return null;
    const today = time.key(now);
    if (this.sql.exec("SELECT value FROM meta WHERE key = 'discord-digest'").toArray()[0]?.value === today) return null;
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('discord-digest', ?)", today);
    const channel = [[s.sessionsChannel, s.sessionsType], [s.eventsChannel, s.eventsType]].find(([id, type]) => id && type !== CHANNEL.FORUM)?.[0];
    if (!channel) return { posted: false, reason: 'no text channel' };
    const end = time.at(addDays(today, 1), 0) + 6 * HOUR;
    const items = [];
    if (s.sessionsChannel) {
      for (const v of this.discordSessions(rules, now, end)) {
        if (v.start > now && v.start < end && v.seats - v.taken > 0) items.push({ start: v.start, line: `🎲 **${clip(v.title, 60)}** · ${this.discordClock(v.start, rules)} · ${this.discordSeatsWord(v)}`, value: `g:${v.id}`, label: v.title, desc: `${this.discordClock(v.start, rules)} · ${this.discordSeatsWord(v)}` });
      }
    }
    if (s.eventsChannel) {
      for (const o of eventOccurrences(rules, now, end)) {
        if (o.start <= now || o.start >= end) continue;
        const left = o.capacity ? o.capacity - this.placesTaken(o.id) : null;
        if (left !== null && left <= 0) continue;
        if (left === null && o.gameTables) continue;
        items.push({ start: o.start, line: `🎟️ **${clip(o.title, 60)}** · ${this.discordClock(o.start, rules)} · ${this.discordPlacesWord(o)}`, value: `e:${occRef(o.id)}`, label: o.title, desc: `${this.discordClock(o.start, rules)} · ${this.discordPlacesWord(o)}` });
      }
    }
    if (!items.length) return { posted: false, reason: 'nothing with room' };
    items.sort((a, b) => a.start - b.start);
    const res = await this.discordRest('POST', `/channels/${channel}/messages`, {
      content: clip(`**Still room at the Lair today:**\n${items.slice(0, 15).map((x) => x.line).join('\n')}\nPick one below to grab a spot.`, 2000),
      components: [selectRow(cid('pick'), 'Grab a spot', items.slice(0, 25).map((x) => ({ label: clip(x.label, 100), value: x.value, description: clip(x.desc, 100) })))],
      allowed_mentions: { parse: [] }, flags: 4096,
    });
    return { posted: res.ok, items: items.length, ...(res.ok ? {} : { error: this.discordWhy(res) }) };
  },

  /** Where each live post is, for the website's "Chat on Discord": { [post key]: url } (a session's thread, or the post). No awaits. */
  discordPostLinks() {
    const guild = this.discordSettings().guild;
    const out = new Map();
    if (!guild) return out;
    for (const r of this.sql.exec("SELECT id, channel_id, message_id, message_channel, thread_id FROM discord_posts WHERE status = 'live' AND message_id IS NOT NULL").toArray()) {
      out.set(r.id, r.thread_id ? `https://discord.com/channels/${guild}/${r.thread_id}` : `https://discord.com/channels/${guild}/${r.message_channel || r.channel_id}/${r.message_id}`);
    }
    return out;
  },

  /* ---------------- upkeep and the health check ---------------- */
  /**
   * The slash commands, registered with Discord (globally, in servers only) when they or the app change, or when asked
   * (/setup?…&discord=commands). A refusal is tried again after an hour. → { ok, at, cached?, reason? }
   */
  async discordRegisterCommands({ force = false } = {}) {
    const appId = this.env.DISCORD_APPLICATION_ID;
    if (!appId || !this.env.DISCORD_BOT_TOKEN) return { ok: false, reason: 'Add DISCORD_APPLICATION_ID and the DISCORD_BOT_TOKEN secret first.' };
    const body = discordCommands();
    const hash = shortHash(`${appId}|${JSON.stringify(body)}`);
    let saved = null;
    try {
      saved = JSON.parse(this.sql.exec("SELECT value FROM meta WHERE key = 'discord-commands'").toArray()[0]?.value || 'null');
    } catch {
      saved = null;
    }
    const now = Date.now();
    if (!force && saved?.hash === hash && saved.ok) return { ok: true, at: saved.at, cached: true };
    if (!force && saved?.hash === hash && !saved.ok && now - saved.at < COMMANDS_RETRY) return { ok: false, at: saved.at, reason: saved.reason, waiting: true };
    const res = await this.discordRest('PUT', `/applications/${appId}/commands`, body);
    const result = { hash, ok: res.ok, at: Date.now(), reason: res.ok ? null : this.discordWhy(res) };
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('discord-commands', ?)", JSON.stringify(result));
    return { ok: result.ok, at: result.at, ...(result.reason ? { reason: result.reason } : {}) };
  },

  /** What's set up, for /setup and the status table (nothing secret) */
  discordStatus() {
    const s = this.discordSettings();
    const base = String(this.env.PUBLIC_URL || 'https://dice-goblin-lair.dicegoblinnz.workers.dev').replace(/\/$/, '');
    const appId = this.env.DISCORD_APPLICATION_ID || null;
    const posts = Object.fromEntries(this.sql.exec('SELECT status, COUNT(*) AS n FROM discord_posts GROUP BY status').toArray().map((r) => [r.status, r.n]));
    return {
      interactions: this.discordReady(), linking: this.discordCanLink(), posting: this.discordCanPost(), botToken: Boolean(this.env.DISCORD_BOT_TOKEN),
      guild: s.guild || null, sessionsChannel: s.sessionsChannel, eventsChannel: s.eventsChannel, pingRole: s.pingRole,
      switches: { posts: s.posts, pings: s.pings, digest: s.digest }, posts,
      interactionsUrl: `${base}/discord/interactions`, redirectUri: this.discordRedirect(),
      installUrl: appId ? `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}` : null,
      linkedMembers: this.sql.exec('SELECT COUNT(*) AS n FROM discord_links').toArray()[0]?.n || 0,
    };
  },

  /**
   * The 10-minute maintenance's Discord part: commands registered, posts brought up to date and the midday round-up.
   * action (from /setup?…&discord=): 'commands' registers again now, 'sync' posts now even while Discord said to wait.
   */
  async discordUpkeep(rules, { action = null } = {}) {
    const status = this.discordStatus();
    if (!this.env.DISCORD_BOT_TOKEN) return status;
    if (this.env.DISCORD_APPLICATION_ID) status.commands = await this.discordRegisterCommands({ force: action === 'commands' });
    if (this.discordCanPost()) {
      status.sync = await this.discordSync({ force: action === 'sync' });
      status.digest = await this.discordDigest(rules, Date.now());
    }
    return status;
  },
};


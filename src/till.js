// Round 32, the till, part 1: who's on the till (the till chat, 6 Nov 2026; contract docs/contracts/lair-api-contract-v32-till.md).
//
// Mo (6 Nov 2026) asked for his own passcode, Caleb on 1234, and everyone changing theirs to what they like the first time
// they log in, Felix too. PINs never live in the page (anyone can read a web page's code), or in this code: they live in
// the Lair, scrambled. Everyone starts on TILL_START_PIN, and the till asks them to choose their own the first time they
// unlock, so Mo sets his then and Caleb and Felix choose theirs.
//
//  - The till's people are the staff page's team (the owner, tagged staff in Shopify, and the helpers on the Team tab,
//    with the Team tab's permissions), and people the owner adds on the till itself, who need no account: just a name and
//    what they can do there (Check-in: take payment at the counter and approve cash; Money: refunds, store credit, tabs).
//    Caleb and Felix are added on the first start, unless they're already helpers.
//  - A PIN is 4 numbers, kept as HMAC-SHA-256 over "salt:pin" with a key made once at random and kept in the Durable
//    Object's key-value storage, not in the Lair's tables. Nobody has a hash until they choose their own PIN.
//  - Five wrong PINs in a row lock that person out: 5 minutes, then 10, 20, 40, and an hour after that, until a right PIN
//    or the owner's reset. 4 numbers is only 10,000 PINs, so the waits are what keep guessing slow.
//  - Unlocking gives the till a token for TILL_SESSION_MS (a long shift), which says who's on the till for everything
//    after it: the till only asks again on Switch person. Tokens are kept as their SHA-256, so the table alone can't be
//    used to get on the till.
//  - Until someone has chosen their own PIN, their token does nothing but choose one: the Lair says so, not just the till.
//  - The owner, on the till, resets anyone's PIN (back to the starting one, to choose again), switches someone's till
//    access off and on, and adds, changes and removes the till's own people.
//  - An owner who forgot their PIN gets a 6-digit code by email (Forgot your PIN?, from any staff account), which puts
//    them on the till to choose a new one. Never a reset on the logged-in account alone: the counter tablet's account is
//    open to anyone at the counter (the review, 6 Nov 2026).
import { RuleError, STAFF_PERMS, cleanPerms, makeId } from './core.js';
import { emailReady } from './shopify.js';

/** Everyone's PIN until they choose their own (Mo, 6 Nov 2026) */
export const TILL_START_PIN = '1234';
/** Five wrong PINs in a row lock that person out */
export const TILL_TRIES = 5;
/** The first lock-out, doubling each time after it, up to TILL_LOCK_MAX_MS */
export const TILL_LOCK_MS = 5 * 60 * 1000;
export const TILL_LOCK_MAX_MS = 60 * 60 * 1000;
/** A till token lasts a long shift: the till asks again only on Switch person */
export const TILL_SESSION_MS = 14 * 60 * 60 * 1000;
/** What the till's own people can be given: Check-in (take payment at the counter, approve cash) and Money */
export const TILL_PERMS = ['checkin', 'money'];
export const TILL_DEFAULT_PERMS = ['checkin'];
/** Mo (6 Nov 2026): Caleb and Felix are on the till too. Added once, on the first start, unless they're helpers already. */
export const TILL_FIRST_PEOPLE = ['Caleb', 'Felix'];
/** An owner's code by email: 6 numbers, good for 15 minutes and 5 tries, one a minute */
export const TILL_CODE_MS = 15 * 60 * 1000;
export const TILL_CODE_GAP_MS = 60 * 1000;
export const TILL_CODE_TRIES = 5;
/** How long the list of staff tagged in Shopify is kept before it's asked for again */
const TILL_OWNERS_MS = 10 * 60 * 1000;
/** The HMAC key's name in the Durable Object's key-value storage */
const TILL_KEY = 'till-pin-key';

/**
 * The till's tables, made on every start when they're missing (as each round's own are):
 *  - till_people: the people the owner added on the till (no account needed): name, perms (JSON), status ('active' or
 *    'removed'), who added them and when.
 *  - till_pins: one row per person once anything about their PIN changed: hash and salt (null = still the starting PIN),
 *    must_change (1 = they're asked to choose their own), failed (wrong PINs in a row), lockouts (how many times they were
 *    locked out since their last right PIN), locked_until (ms), off (1 = their till access is switched off), updated_at.
 *    person_id is a Shopify customer ID for the team, or a till_people id.
 *  - till_sessions: the SHA-256 of each unlock's token, whose it is, and when it stops working.
 *  - till_resets: an owner's emailed code (HMAC and salt, as PINs), when it runs out, wrong tries, and when it was sent.
 */
export const TILL_TABLES = [
  `CREATE TABLE IF NOT EXISTS till_people (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, perms TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', made_by TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS till_pins (
    person_id TEXT PRIMARY KEY, hash TEXT, salt TEXT, must_change INTEGER NOT NULL DEFAULT 1, failed INTEGER NOT NULL DEFAULT 0,
    lockouts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, off INTEGER NOT NULL DEFAULT 0, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS till_sessions (
    token_hash TEXT PRIMARY KEY, person_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS till_sessions_person ON till_sessions (person_id)',
  `CREATE TABLE IF NOT EXISTS till_resets (
    person_id TEXT PRIMARY KEY, hash TEXT NOT NULL, salt TEXT NOT NULL, expires_at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER NOT NULL)`,
];

/** The till's words, for staff: plain NZ English */
export const TILL_WORDS = {
  staffOnly: 'The till is for staff. Log in with a staff account.',
  notOnTill: "That person isn't on the till. Ask Mo.",
  off: 'Your till access is switched off. Ask Mo to turn it back on.',
  wrong: "That PIN isn't right. Try again.",
  locked: (minutes) => `Too many wrong PINs. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or ask Mo to reset it.`,
  fourNumbers: 'A PIN is 4 numbers.',
  notStart: `Choose a PIN that isn't ${TILL_START_PIN}.`,
  expired: 'The till locked itself. Tap your name and your PIN again.',
  ownerOnly: 'Only the owner can do that.',
  notSelf: "You can't switch off your own till access.",
  name: 'Type their name (up to 30 letters).',
  nameTaken: (name) => `There's already a ${name} on the till.`,
  permsList: 'Send what they can do as a list.',
  notTillPerson: 'Only people added on the till can be changed or removed here. Helpers are on the Team tab.',
  chooseFirst: 'Choose your own PIN first.',
  codeOwners: "Only an owner's PIN is reset by email. Ask Mo to reset yours on the till.",
  codeNoEmail: "The Lair can't email a code right now, so this PIN can't be reset here.",
  codeWait: 'A code was just sent. Check your email, or ask again in a minute.',
  codeFailed: "The email didn't send. Try again in a minute.",
  codeNone: 'There is no code waiting. Tap Forgot your PIN? to get one.',
  codeOld: 'That code ran out. Ask for a new one.',
  codeWrong: "That code isn't right. Check the email and try again.",
  codeTries: 'Too many wrong codes. Ask for a new one.',
};

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const parse = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};
/** The same length and every character the same, checked to the end */
const sameText = (a, b) => {
  const x = String(a ?? '');
  const y = String(b ?? '');
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
};
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
/** owner@example.com as o•••@example.com, so the till says where the code went without showing the address */
export const maskEmail = (email) => {
  const [name, domain] = String(email || '').trim().split('@');
  return name && domain ? `${name[0]}•••@${domain}` : '';
};
/** 6 numbers, every one as likely (no modulo bias) */
export function tillCode() {
  const box = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(box);
    if (box[0] < 4294000000) return String(box[0] % 1000000).padStart(6, '0');
  }
}
/** A till person's permissions as sent: Check-in and Money only, in that order (null when it isn't a list) */
export function tillPerms(list) {
  const clean = cleanPerms(list);
  return clean ? clean.filter((p) => TILL_PERMS.includes(p)) : null;
}
/** A name for someone added on the till: 1 to 30 characters, spaces tidied, or null */
export function tillName(value) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  return name && name.length <= 30 && !/[<>]/.test(name) ? name : null;
}
/** How long a lock-out is, after `lockouts` before it since the last right PIN: 5, 10, 20, 40, then 60 minutes */
export const tillLockMs = (lockouts) => Math.min(TILL_LOCK_MAX_MS, TILL_LOCK_MS * 2 ** Math.max(0, Math.min(Number(lockouts) || 0, 10)));

/** What the lock screen says under someone's name: Owner, or what they can do on the till */
export function tillRoleWords(row) {
  if (row.role === 'owner') return 'Owner';
  const bits = [];
  if (row.perms.includes('checkin')) bits.push('check-in');
  if (row.perms.includes('money')) bits.push('money');
  if (!bits.length) return 'Sales only';
  const words = bits.join(' and ');
  return words[0].toUpperCase() + words.slice(1);
}

export const tillMethods = {
  /** The till is for staff: anyone the staff page lets in (the owner, or a helper) */
  tillGate(who) {
    if (!who?.customerId || !who.staff) throw new RuleError(TILL_WORDS.staffOnly, 403);
  },

  /** Caleb and Felix on the till, once (unless they're helpers already). On start; no awaits. */
  tillSeed(now) {
    if (this.sql.exec("SELECT value FROM meta WHERE key = 'till-seeded'").toArray().length) return;
    const helpers = new Set(
      this.sql
        .exec("SELECT m.first_name AS name FROM staff_helpers h JOIN members m ON m.customer_id = h.customer_id WHERE h.status = 'active'")
        .toArray()
        .map((r) => String(r.name || '').toLowerCase()),
    );
    for (const name of TILL_FIRST_PEOPLE) {
      if (helpers.has(name.toLowerCase())) continue;
      this.sql.exec(
        "INSERT INTO till_people (id, name, perms, status, made_by, created_at, updated_at) VALUES (?, ?, ?, 'active', 'start', ?, ?)",
        makeId('tp'), name, JSON.stringify(TILL_DEFAULT_PERMS), now, now,
      );
    }
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('till-seeded', ?)", String(now));
  },

  /** The HMAC key PINs are kept with, made once and kept in the Durable Object's key-value storage */
  async tillKey() {
    if (this.tillHmacKey) return this.tillHmacKey;
    let secret = await this.ctx.storage.get(TILL_KEY);
    if (!secret) {
      secret = randomHex(32);
      await this.ctx.storage.put(TILL_KEY, secret);
    }
    this.tillHmacKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return this.tillHmacKey;
  },

  async tillHash(pin, salt) {
    const key = await this.tillKey();
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${salt}:${pin}`));
    return hex(new Uint8Array(sig));
  },

  /** A token's SHA-256, as till_sessions keeps it (null for anything that isn't a till token) */
  async tillTokenHash(token) {
    const text = String(token ?? '');
    if (!/^[0-9a-f]{48}$/.test(text)) return null;
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
  },

  /** A person's PIN row, or null (no row: the starting PIN, nothing wrong, not switched off). No awaits. */
  tillPinRow(personId) {
    return this.sql.exec('SELECT * FROM till_pins WHERE person_id = ?', String(personId)).toArray()[0] || null;
  },

  /** Someone the owner added on the till, still there, or null. No awaits. */
  tillPersonRow(id) {
    return this.sql.exec("SELECT * FROM till_people WHERE id = ? AND status = 'active'", String(id)).toArray()[0] || null;
  },

  /** The staff tagged in Shopify ([{ customerId, name }]), asked for at most every 10 minutes (the last list when it fails) */
  async tillTagged() {
    if (!this.shopify?.configured) return [];
    const kept = this.tillOwners;
    if (kept && Date.now() - kept.at < TILL_OWNERS_MS) return kept.list;
    try {
      const list = (await this.shopify.searchCustomers('tag:staff')) || [];
      this.tillOwners = { at: Date.now(), list };
      return list;
    } catch (error) {
      console.error('Lair: the till could not ask Shopify for the staff', error);
      return kept ? kept.list : [];
    }
  },

  /**
   * The till's people, in order: whoever's asking when they're the owner, the others tagged staff in Shopify, the helpers
   * (oldest first), then the people added on the till (oldest first). [{ id, name, fullName, role: 'owner' | 'helper',
   * kind: 'team' | 'till', perms }]. No awaits.
   */
  tillTeamFrom(who, tagged) {
    const rows = new Map();
    const fromTeam = (id, role, perms, fallbackName = '') => {
      const key = String(id || '');
      if (!key || rows.has(key)) return;
      const m = this.memberRow(key);
      const fullName = String(m?.name || m?.first_name || fallbackName || '').trim();
      const name = m?.first_name || fullName.split(/\s+/)[0] || 'Staff';
      rows.set(key, { id: key, name, fullName: fullName || name, role, kind: 'team', perms });
    };
    const ownerPerms = [...STAFF_PERMS, 'team'];
    const named = new Map((tagged || []).filter((c) => c?.customerId).map((c) => [String(c.customerId), c]));
    if (who?.customerId && who.role === 'owner') fromTeam(who.customerId, 'owner', ownerPerms, named.get(String(who.customerId))?.name);
    for (const [id, c] of named) if (!this.helperRow(id)) fromTeam(id, 'owner', ownerPerms, c.name);
    for (const h of this.sql.exec("SELECT * FROM staff_helpers WHERE status = 'active' ORDER BY created_at, rowid").toArray()) {
      fromTeam(h.customer_id, 'helper', cleanPerms(parse(h.perms, [])) || []);
      // a helper added back after being taken off: tills from before don't come back with them
      const row = rows.get(String(h.customer_id));
      if (row) row.since = Number(h.created_at) || 0;
    }
    for (const p of this.sql.exec("SELECT * FROM till_people WHERE status = 'active' ORDER BY created_at, rowid").toArray()) {
      if (!rows.has(p.id)) rows.set(p.id, { id: p.id, name: p.name, fullName: p.name, role: 'helper', kind: 'till', perms: tillPerms(parse(p.perms, [])) || [] });
    }
    return [...rows.values()];
  },

  /** One person as the till shows them. No awaits. */
  tillPersonView(row, now = Date.now()) {
    const pin = this.tillPinRow(row.id);
    const locked = Boolean(pin?.locked_until && pin.locked_until > now);
    return {
      id: row.id, name: row.name, fullName: row.fullName, role: row.role, kind: row.kind, roleWords: tillRoleWords(row), perms: row.perms,
      pin: pin && pin.hash && !pin.must_change ? 'own' : 'start', off: Boolean(pin?.off), locked,
      ...(locked ? { lockedMinutes: Math.max(1, Math.ceil((pin.locked_until - now) / 60000)) } : {}),
    };
  },

  /** The till's people as the till shows them. No awaits. */
  tillTeamView(team, now = Date.now()) {
    return team.map((row) => this.tillPersonView(row, now));
  },

  /**
   * Whoever a till token is for, from the till's people (or a 401: the till asks for the PIN again). Until they've chosen
   * their own PIN, a 403 for anything but choosing one (start: true). No awaits.
   */
  tillOn(tokenHash, team, { start = false, now = Date.now() } = {}) {
    const session = tokenHash ? this.sql.exec('SELECT * FROM till_sessions WHERE token_hash = ?', tokenHash).toArray()[0] : null;
    const row = session && session.expires_at > now ? team.find((x) => x.id === session.person_id) : null;
    const pin = row ? this.tillPinRow(row.id) : null;
    if (!row || pin?.off || (row.since && session.created_at < row.since)) throw new RuleError(TILL_WORDS.expired, 401);
    if (!start && (!pin?.hash || pin.must_change)) throw new RuleError(TILL_WORDS.chooseFirst, 403);
    return row;
  },

  /** The owner on the till with their own PIN, or a 403. No awaits. */
  tillOwnerOn(tokenHash, team) {
    const me = this.tillOn(tokenHash, team, { start: true });
    if (me.role !== 'owner') throw new RuleError(TILL_WORDS.ownerOnly, 403);
    return this.tillOn(tokenHash, team);
  },

  /** GET /till/team: the lock screen's people. { team: [tillPersonView], startPin } */
  async tillTeam(who) {
    this.tillGate(who);
    const team = this.tillTeamFrom(who, await this.tillTagged());
    return { team: this.tillTeamView(team), startPin: TILL_START_PIN };
  },

  /**
   * POST /till/unlock { id, pin }: someone on the till. → { token, staff: tillPersonView, mustChange }. A wrong PIN is a
   * 401, the fifth in a row (and any while they're locked out) a 429, someone switched off a 403.
   */
  async tillUnlock(body, who) {
    this.tillGate(who);
    const id = String(body?.id ?? '');
    const pin = String(body?.pin ?? '');
    const team = this.tillTeamFrom(who, await this.tillTagged());
    const row = team.find((x) => x.id === id);
    if (!row) throw new RuleError(TILL_WORDS.notOnTill, 404);
    const before = this.tillPinRow(id);
    if (before?.off) throw new RuleError(TILL_WORDS.off, 403);
    const start = Date.now();
    if (before?.locked_until && before.locked_until > start) {
      throw new RuleError(TILL_WORDS.locked(Math.max(1, Math.ceil((before.locked_until - start) / 60000))), 429);
    }
    const right = /^\d{4}$/.test(pin) && (before?.hash ? sameText(await this.tillHash(pin, before.salt), before.hash) : sameText(pin, TILL_START_PIN));
    const token = randomHex(24);
    const tokenHash = await this.tillTokenHash(token);
    // --- no awaits from here on (the row is read again: another unlock may have run while the PIN was checked) ---
    const now = Date.now();
    const pinRow = this.tillPinRow(id);
    if (pinRow?.off) throw new RuleError(TILL_WORDS.off, 403);
    if ((pinRow?.hash || null) !== (before?.hash || null)) throw new RuleError(TILL_WORDS.wrong, 401);
    if (pinRow?.locked_until && pinRow.locked_until > now) {
      throw new RuleError(TILL_WORDS.locked(Math.max(1, Math.ceil((pinRow.locked_until - now) / 60000))), 429);
    }
    if (!right) {
      const failed = (pinRow?.failed || 0) + 1;
      const lockouts = pinRow?.lockouts || 0;
      const lock = failed >= TILL_TRIES ? tillLockMs(lockouts) : 0;
      this.write(
        `INSERT INTO till_pins (person_id, hash, salt, must_change, failed, lockouts, locked_until, off, updated_at) VALUES (?, NULL, NULL, 1, ?, ?, ?, 0, ?)
         ON CONFLICT (person_id) DO UPDATE SET failed = excluded.failed, lockouts = excluded.lockouts, locked_until = excluded.locked_until,
           updated_at = excluded.updated_at`,
        id, lock ? 0 : failed, lock ? lockouts + 1 : lockouts, lock ? now + lock : null, now,
      );
      if (lock) throw new RuleError(TILL_WORDS.locked(Math.round(lock / 60000)), 429);
      throw new RuleError(TILL_WORDS.wrong, 401);
    }
    if (pinRow && (pinRow.failed || pinRow.lockouts || pinRow.locked_until)) {
      this.write('UPDATE till_pins SET failed = 0, lockouts = 0, locked_until = NULL, updated_at = ? WHERE person_id = ?', now, id);
    }
    this.write('DELETE FROM till_sessions WHERE expires_at <= ?', now);
    this.write('INSERT INTO till_sessions (token_hash, person_id, created_at, expires_at) VALUES (?, ?, ?, ?)', tokenHash, id, now, now + TILL_SESSION_MS);
    return { token, staff: this.tillPersonView(row, now), mustChange: !pinRow || !pinRow.hash || Boolean(pinRow.must_change) };
  },

  /** POST /till/pin { token, pin }: whoever's on the till chooses their own PIN (4 numbers, not the starting one) */
  async tillChoosePin(body, who) {
    this.tillGate(who);
    const pin = String(body?.pin ?? '');
    if (!/^\d{4}$/.test(pin)) throw new RuleError(TILL_WORDS.fourNumbers, 400);
    if (pin === TILL_START_PIN) throw new RuleError(TILL_WORDS.notStart, 400);
    const tokenHash = await this.tillTokenHash(body?.token);
    const tagged = await this.tillTagged();
    const salt = randomHex(16);
    const hash = await this.tillHash(pin, salt);
    // --- no awaits from here on ---
    const me = this.tillOn(tokenHash, this.tillTeamFrom(who, tagged), { start: true });
    const now = Date.now();
    this.write(
      `INSERT INTO till_pins (person_id, hash, salt, must_change, failed, lockouts, locked_until, off, updated_at) VALUES (?, ?, ?, 0, 0, 0, NULL, 0, ?)
       ON CONFLICT (person_id) DO UPDATE SET hash = excluded.hash, salt = excluded.salt, must_change = 0, failed = 0, lockouts = 0, locked_until = NULL,
         updated_at = excluded.updated_at`,
      me.id, hash, salt, now,
    );
    return { ok: true, staff: this.tillPersonView(me, now) };
  },

  /** Someone back on the starting PIN, to choose their own, with any lock-out cleared. No awaits. */
  tillClearPin(id, now) {
    this.write(
      `INSERT INTO till_pins (person_id, hash, salt, must_change, failed, lockouts, locked_until, off, updated_at) VALUES (?, NULL, NULL, 1, 0, 0, NULL, 0, ?)
       ON CONFLICT (person_id) DO UPDATE SET hash = NULL, salt = NULL, must_change = 1, failed = 0, lockouts = 0, locked_until = NULL,
         updated_at = excluded.updated_at`,
      id, now,
    );
  },

  /**
   * POST /till/reset { token, id }: the owner on the till puts someone back on the starting PIN (they choose their own
   * the next time they unlock), and clears any lock-out; that person's other tills lock. → { team }
   */
  async tillReset(body, who) {
    this.tillGate(who);
    const id = String(body?.id ?? '');
    const tokenHash = await this.tillTokenHash(body?.token);
    const team = this.tillTeamFrom(who, await this.tillTagged());
    // --- no awaits from here on ---
    this.tillOwnerOn(tokenHash, team);
    if (!team.some((x) => x.id === id)) throw new RuleError(TILL_WORDS.notOnTill, 404);
    const now = Date.now();
    this.tillClearPin(id, now);
    this.write('DELETE FROM till_sessions WHERE person_id = ? AND token_hash != ?', id, tokenHash);
    return { team: this.tillTeamView(team, now) };
  },

  /** An owner's emailed code, or null. No awaits. */
  tillResetRow(id) {
    return this.sql.exec('SELECT * FROM till_resets WHERE person_id = ?', String(id)).toArray()[0] || null;
  },

  /**
   * POST /till/forgot { id } (any staff account): an owner who forgot their PIN gets a 6-digit code at their own email,
   * good for 15 minutes; a new one replaces the last, one a minute. → { sent: true, to: 'o•••@example.com' }
   */
  async tillForgot(body, who) {
    this.tillGate(who);
    const id = String(body?.id ?? '');
    const tagged = await this.tillTagged();
    const row = this.tillTeamFrom(who, tagged).find((x) => x.id === id);
    if (!row) throw new RuleError(TILL_WORDS.notOnTill, 404);
    if (row.role !== 'owner') throw new RuleError(TILL_WORDS.codeOwners, 403);
    if (this.tillPinRow(id)?.off) throw new RuleError(TILL_WORDS.off, 403);
    const member = this.memberRow(id);
    const shop = tagged.find((c) => String(c?.customerId) === id);
    const email = [member?.email, shop?.email].find((e) => isEmail(e)) || '';
    if (!emailReady(this.env) || !email) throw new RuleError(TILL_WORDS.codeNoEmail, 503);
    const was = this.tillResetRow(id);
    if (was && Date.now() - was.sent_at < TILL_CODE_GAP_MS) throw new RuleError(TILL_WORDS.codeWait, 429);
    const code = tillCode();
    const salt = randomHex(16);
    const hash = await this.tillHash(`reset:${code}`, salt);
    // --- no awaits from here on, until the email (another ask may have come in meanwhile) ---
    const now = Date.now();
    const again = this.tillResetRow(id);
    if (again && now - again.sent_at < TILL_CODE_GAP_MS) throw new RuleError(TILL_WORDS.codeWait, 429);
    this.write(
      'INSERT OR REPLACE INTO till_resets (person_id, hash, salt, expires_at, tries, sent_at) VALUES (?, ?, ?, ?, 0, ?)',
      id, hash, salt, now + TILL_CODE_MS, now,
    );
    const sent = await this.mail(this.letter(email, 'Your code for the till', {
      title: 'Your code for the till',
      preheader: 'Type it on the till to choose a new PIN. It works once, for 15 minutes.',
      intro: `Someone tapped Forgot your PIN? on the till for ${row.name}. Type this code on the till, then choose a new PIN.`,
      codes: [{ code, lines: ['Works once, for 15 minutes'] }],
      outro: "If that wasn't you, ignore this email. Your PIN stays as it is.",
      signoff: 'Gobgob',
    }));
    if (!sent?.ok) {
      // nothing went: the next ask isn't made to wait
      this.write('DELETE FROM till_resets WHERE person_id = ? AND sent_at = ?', id, now);
      throw new RuleError(TILL_WORDS.codeFailed, 502);
    }
    return { sent: true, to: maskEmail(email) };
  },

  /**
   * POST /till/forgot/check { id, code }: the emailed code, typed on the till. Right: that owner is on the till with the
   * starting PIN cleared away, choosing a new one → { token, staff, mustChange: true } (their other tills lock). Wrong: a
   * 401, the fifth a 429 and the code is gone; one that ran out a 410; none waiting a 400.
   */
  async tillForgotCheck(body, who) {
    this.tillGate(who);
    const id = String(body?.id ?? '');
    const code = String(body?.code ?? '').replace(/\s+/g, '');
    const row = this.tillTeamFrom(who, await this.tillTagged()).find((x) => x.id === id);
    if (!row) throw new RuleError(TILL_WORDS.notOnTill, 404);
    if (row.role !== 'owner') throw new RuleError(TILL_WORDS.codeOwners, 403);
    const before = this.tillResetRow(id);
    if (!before) throw new RuleError(TILL_WORDS.codeNone, 400);
    const right = /^\d{6}$/.test(code) && sameText(await this.tillHash(`reset:${code}`, before.salt), before.hash);
    const token = randomHex(24);
    const tokenHash = await this.tillTokenHash(token);
    // --- no awaits from here on (the code is read again: it may have been used or replaced meanwhile) ---
    const now = Date.now();
    const r = this.tillResetRow(id);
    if (!r || r.hash !== before.hash) throw new RuleError(TILL_WORDS.codeNone, 400);
    if (r.expires_at <= now) {
      this.write('DELETE FROM till_resets WHERE person_id = ?', id);
      throw new RuleError(TILL_WORDS.codeOld, 410);
    }
    if (this.tillPinRow(id)?.off) throw new RuleError(TILL_WORDS.off, 403);
    if (!right) {
      const tries = (r.tries || 0) + 1;
      if (tries >= TILL_CODE_TRIES) {
        this.write('DELETE FROM till_resets WHERE person_id = ?', id);
        throw new RuleError(TILL_WORDS.codeTries, 429);
      }
      this.write('UPDATE till_resets SET tries = ? WHERE person_id = ?', tries, id);
      throw new RuleError(TILL_WORDS.codeWrong, 401);
    }
    this.write('DELETE FROM till_resets WHERE person_id = ?', id);
    this.tillClearPin(id, now);
    this.write('DELETE FROM till_sessions WHERE person_id = ?', id);
    this.write('INSERT INTO till_sessions (token_hash, person_id, created_at, expires_at) VALUES (?, ?, ?, ?)', tokenHash, id, now, now + TILL_SESSION_MS);
    return { token, staff: this.tillPersonView(row, now), mustChange: true };
  },

  /** POST /till/access { token, id, off } (the owner on the till): someone's till access off, or back on. → { team } */
  async tillAccess(body, who) {
    this.tillGate(who);
    const tokenHash = await this.tillTokenHash(body?.token);
    const team = this.tillTeamFrom(who, await this.tillTagged());
    // --- no awaits from here on ---
    const me = this.tillOwnerOn(tokenHash, team);
    const id = String(body?.id ?? '');
    if (!team.some((x) => x.id === id)) throw new RuleError(TILL_WORDS.notOnTill, 404);
    const off = Boolean(body?.off);
    if (off && id === me.id) throw new RuleError(TILL_WORDS.notSelf, 400);
    const now = Date.now();
    this.write(
      `INSERT INTO till_pins (person_id, hash, salt, must_change, failed, lockouts, locked_until, off, updated_at) VALUES (?, NULL, NULL, 1, 0, 0, NULL, ?, ?)
       ON CONFLICT (person_id) DO UPDATE SET off = excluded.off, updated_at = excluded.updated_at`,
      id, off ? 1 : 0, now,
    );
    if (off) this.write('DELETE FROM till_sessions WHERE person_id = ?', id);
    return { team: this.tillTeamView(team, now) };
  },

  /**
   * POST /till/people { token, name, perms } (the owner on the till): someone added on the till, on the starting PIN.
   * With id: their name or perms changed. perms: Check-in and Money only (Check-in when left out for someone new).
   * → { team, person: tillPersonView }
   */
  async tillSavePerson(body, who) {
    this.tillGate(who);
    const tokenHash = await this.tillTokenHash(body?.token);
    const tagged = await this.tillTagged();
    // --- no awaits from here on ---
    const team = this.tillTeamFrom(who, tagged);
    const me = this.tillOwnerOn(tokenHash, team);
    const id = String(body?.id ?? '');
    const was = id ? this.tillPersonRow(id) : null;
    if (id && !was) throw new RuleError(TILL_WORDS.notTillPerson, 404);
    const name = body?.name === undefined && was ? was.name : tillName(body?.name);
    if (!name) throw new RuleError(TILL_WORDS.name, 400);
    const lower = name.toLowerCase();
    if (team.some((x) => x.id !== id && (x.name.toLowerCase() === lower || x.fullName.toLowerCase() === lower))) throw new RuleError(TILL_WORDS.nameTaken(name), 409);
    const sent = body?.perms === undefined ? null : tillPerms(body.perms);
    if (body?.perms !== undefined && !sent) throw new RuleError(TILL_WORDS.permsList, 400);
    const perms = sent || (was ? tillPerms(parse(was.perms, [])) || [] : TILL_DEFAULT_PERMS.slice());
    const now = Date.now();
    let personId = id;
    if (was) this.write('UPDATE till_people SET name = ?, perms = ?, updated_at = ? WHERE id = ?', name, JSON.stringify(perms), now, id);
    else {
      personId = makeId('tp');
      this.write(
        "INSERT INTO till_people (id, name, perms, status, made_by, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)",
        personId, name, JSON.stringify(perms), `till:${me.id}`, now, now,
      );
    }
    const after = this.tillTeamFrom(who, tagged);
    return { team: this.tillTeamView(after, now), person: this.tillPersonView(after.find((x) => x.id === personId), now) };
  },

  /** POST /till/people/remove { token, id } (the owner on the till): someone added on the till, gone from it. → { team } */
  async tillRemovePerson(body, who) {
    this.tillGate(who);
    const tokenHash = await this.tillTokenHash(body?.token);
    const tagged = await this.tillTagged();
    // --- no awaits from here on ---
    this.tillOwnerOn(tokenHash, this.tillTeamFrom(who, tagged));
    const id = String(body?.id ?? '');
    if (!this.tillPersonRow(id)) throw new RuleError(TILL_WORDS.notTillPerson, 404);
    const now = Date.now();
    this.write("UPDATE till_people SET status = 'removed', updated_at = ? WHERE id = ?", now, id);
    this.write('DELETE FROM till_pins WHERE person_id = ?', id);
    this.write('DELETE FROM till_sessions WHERE person_id = ?', id);
    return { team: this.tillTeamView(this.tillTeamFrom(who, tagged), now) };
  },
};

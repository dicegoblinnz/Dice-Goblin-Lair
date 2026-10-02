// Reading the codes staff scan or type, and turning Lair answers into short lines for the result card.
// Plain functions with no `shopify` global, so `npm test` can check them without a POS.

export const TIME_ZONE = 'Pacific/Auckland';

const MEMBER = /^DGC(\d{1,20})$/; // member card: DGC-<Shopify customer id>
const TICKET = /^([A-Z]{2,10})(\d{4})$/; // booking or sign-up: SAM-4821 (first name, 4 digits)
const OLD_TICKET = /^GOB([A-Z0-9]{6})$/; // older tickets: GOB-7K2QXM

/**
 * @typedef {{ kind: 'empty' }
 *   | { kind: 'unknown', text: string }
 *   | { kind: 'member', code: string, customerId: string }
 *   | { kind: 'ticket', code: string }} ReadCode
 */

/**
 * Works out what a scanned or typed code is. Case, spaces and dashes don't matter ("sam 4821" is SAM-4821),
 * and a code inside a longer text or link is still found.
 * @param {unknown} raw
 * @returns {ReadCode}
 */
export function readCode(raw) {
  const text = String(raw ?? '').trim().toUpperCase();
  if (!text) return { kind: 'empty' };
  const tokens = text.split(/[^A-Z0-9]+/).filter(Boolean);
  const candidates = [tokens.join('')];
  tokens.forEach((token, i) => {
    candidates.push(token);
    if (i + 1 < tokens.length) candidates.push(token + tokens[i + 1]);
  });
  for (const candidate of candidates) {
    const m = candidate.match(MEMBER);
    if (m) return { kind: 'member', code: `DGC-${m[1]}`, customerId: m[1] };
  }
  for (const candidate of candidates) {
    const t = candidate.match(TICKET);
    if (t) return { kind: 'ticket', code: `${t[1]}-${t[2]}` };
    const o = candidate.match(OLD_TICKET);
    if (o) return { kind: 'ticket', code: `GOB-${o[1]}` };
  }
  return { kind: 'unknown', text: text.slice(0, 40) };
}

/** @param {unknown} cents */
export function money(cents) {
  const n = Math.max(0, Math.round(Number(cents) || 0));
  return `$${(n / 100).toFixed(2)}`;
}

/** @param {unknown} n */
export function peopleLabel(n) {
  const count = Math.round(Number(n) || 0);
  if (count < 1) return '';
  return count === 1 ? '1 person' : `${count} people`;
}

/**
 * Formats a time in Auckland time, falling back to the device's own clock (which is in Auckland anyway).
 * @param {number} ms
 * @param {Intl.DateTimeFormatOptions} options
 */
function format(ms, options) {
  const date = new Date(ms);
  try {
    return new Intl.DateTimeFormat('en-NZ', { ...options, timeZone: TIME_ZONE }).format(date);
  } catch {
    try {
      return new Intl.DateTimeFormat('en-NZ', options).format(date);
    } catch {
      return date.toString();
    }
  }
}

/** "6:00pm" @param {number} ms */
export function timeLabel(ms) {
  return format(ms, { hour: 'numeric', minute: '2-digit' }).replace(/\s*([ap])\.?\s?m\.?/i, (_, x) => `${x.toLowerCase()}m`);
}

/** "Today" or "Sat 4 Oct" @param {number} ms @param {number} [now] */
export function dayLabel(ms, now = Date.now()) {
  const key = (/** @type {number} */ t) => format(t, { year: 'numeric', month: '2-digit', day: '2-digit' });
  if (key(ms) === key(now)) return 'Today';
  return format(ms, { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
}

/** "Today, 6:00pm–9:00pm" @param {unknown} start @param {unknown} end @param {number} [now] */
export function whenLabel(start, end, now = Date.now()) {
  const from = Number(start);
  if (!from) return '';
  const to = Number(end);
  return `${dayLabel(from, now)}, ${timeLabel(from)}${to > from ? `–${timeLabel(to)}` : ''}`;
}

/**
 * A Shopify customer id as the number the POS cart wants ("123", 123 or "gid://shopify/Customer/123").
 * @param {unknown} id
 * @returns {number | null}
 */
export function customerIdNumber(id) {
  const match = String(id ?? '').match(/(\d+)$/);
  const n = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * @typedef {{ ref?: string, kind?: string, name?: string, tables?: string[], start?: number, end?: number,
 *   people?: number, paid?: boolean, status?: string, arrivedAt?: number | null, title?: string,
 *   players?: { name?: string, character?: string }[] }} LairItem
 * @typedef {{ title: string, price: string, quantity: number, taxable: boolean, properties: Record<string, string> }} FeeLine
 * @typedef {{ found?: boolean, kind?: string, booking?: LairItem, join?: LairItem, game?: { title?: string, tables?: string[] } | null,
 *   checkedIn?: boolean, reason?: string, due?: number, message?: string, lines?: unknown[], customer?: { id?: unknown } | null }} CheckInAnswer
 */

/** @param {CheckInAnswer | null | undefined} answer */
function itemOf(answer) {
  return answer?.booking || answer?.join || {};
}

/** @param {CheckInAnswer} answer */
function tablesOf(answer) {
  const own = answer.booking?.tables;
  const tables = own?.length ? own : answer.game?.tables || [];
  return tables.filter(Boolean).map(String);
}

/**
 * What the result card shows for a booking, GM game seat or event sign-up.
 * @param {CheckInAnswer} answer
 * @param {string} code
 * @param {number} [now]
 */
export function describeTicket(answer, code, now = Date.now()) {
  const item = itemOf(answer);
  const ref = item.ref || code;
  const booking = answer.booking;
  let what = 'Table booking';
  if (answer.join || answer.kind === 'join') what = `Event sign-up${item.title ? `: ${item.title}` : ''}`;
  else if (booking?.kind === 'gm-seat') what = `Game seat${answer.game?.title ? `: ${answer.game.title}` : ''}`;
  else if (booking?.kind === 'walkin') what = 'Walk-in';
  const tables = tablesOf(answer);
  const players = (booking?.players || []).map((p) => p?.name).filter(Boolean);
  const people = peopleLabel(item.people);
  return {
    ref,
    name: item.name || 'Guest',
    what,
    when: whenLabel(item.start, item.end, now),
    tables: tables.length ? `${tables.length === 1 ? 'Table' : 'Tables'} ${tables.join(', ')}` : '',
    people: players.length > 1 ? `${people}: ${players.join(', ')}` : people,
    paid: Boolean(item.paid),
    due: Math.max(0, Math.round(Number(answer.due) || 0)),
    arrivedAt: item.arrivedAt ? timeLabel(item.arrivedAt) : '',
  };
}

/** @param {unknown} price */
function priceString(price) {
  const n = Number(price);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
}

/**
 * The custom sale lines to put in the POS cart: the ones the Lair app sends, or one line for what's due when an
 * older Lair app doesn't send any. Every line carries the `_booking` property, which is how the payment finds
 * its way back to the booking.
 * @param {CheckInAnswer} answer
 * @param {string} code
 * @returns {FeeLine[]}
 */
export function feeLines(answer, code) {
  const ref = itemOf(answer).ref || code;
  /** @type {FeeLine[]} */
  const lines = [];
  for (const raw of Array.isArray(answer.lines) ? answer.lines : []) {
    const line = /** @type {{ title?: unknown, price?: unknown, quantity?: unknown, taxable?: unknown, properties?: unknown }} */ (raw || {});
    const price = priceString(line.price);
    if (!price) continue;
    /** @type {Record<string, string>} */
    const properties = {};
    if (line.properties && typeof line.properties === 'object') {
      for (const [key, value] of Object.entries(line.properties)) properties[key] = String(value);
    }
    if (!properties._booking) properties._booking = ref;
    lines.push({
      title: String(line.title || `Table fee ${ref}`).slice(0, 255),
      price,
      quantity: Math.max(1, Math.round(Number(line.quantity) || 1)),
      taxable: line.taxable !== false,
      properties,
    });
  }
  const due = Math.max(0, Math.round(Number(answer.due) || 0));
  if (lines.length || !due) return lines;
  const tables = tablesOf(answer);
  const title = answer.join ? `Entry fee ${ref}` : `Table fee ${ref}${tables.length ? ` (${tables.join(', ')})` : ''}`;
  return [{ title, price: (due / 100).toFixed(2), quantity: 1, taxable: true, properties: { _booking: ref } }];
}

/** Total of some fee lines, in cents. @param {FeeLine[]} lines */
export function linesTotal(lines) {
  return lines.reduce((sum, line) => sum + Math.round(Number(line.price) * 100) * line.quantity, 0);
}

/**
 * "2 bonus rolls waiting · today's free roll not used yet". Accepts a number or { daily, bonus, toNext }.
 * @param {unknown} rolls
 */
export function rollsLabel(rolls) {
  if (rolls == null) return '';
  if (typeof rolls === 'number') return rolls > 0 ? `${rolls} bonus ${rolls === 1 ? 'roll' : 'rolls'} waiting` : 'No bonus rolls waiting';
  if (typeof rolls !== 'object') return '';
  const r = /** @type {{ daily?: unknown, bonus?: unknown, toNext?: unknown }} */ (rolls);
  const bonus = Math.round(Number(r.bonus) || 0);
  const parts = [];
  if (bonus > 0) parts.push(`${bonus} bonus ${bonus === 1 ? 'roll' : 'rolls'} waiting`);
  if (r.daily === true) parts.push("today's free roll not used yet");
  if (Number(r.toNext) > 0) parts.push(`${money(r.toNext)} more spend for the next roll`);
  return parts.join(' · ');
}

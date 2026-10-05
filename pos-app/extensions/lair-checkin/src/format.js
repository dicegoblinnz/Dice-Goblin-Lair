// Plain words and numbers for the counter screens: money, people, tables and times in Auckland time.
// No `shopify` global here, so `npm test` can check it without a POS.

export const TIME_ZONE = 'Pacific/Auckland';

/**
 * Cents as dollars: "$15", "$12.50", "$1,200". Anything that isn't a positive number shows as "$0".
 * @param {unknown} cents
 */
export function money(cents) {
  const n = Math.max(0, Math.round(Number(cents) || 0));
  const dollars = Math.floor(n / 100);
  const rest = n % 100;
  const whole = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return rest ? `$${whole}.${String(rest).padStart(2, '0')}` : `$${whole}`;
}

/** "1 person", "3 people", or '' when there's no count. @param {unknown} n */
export function peopleLabel(n) {
  const count = Math.round(Number(n) || 0);
  if (count < 1) return '';
  return count === 1 ? '1 person' : `${count} people`;
}

/** "T4" or "T7, T8". @param {unknown} tables */
export function tablesLabel(tables) {
  if (!Array.isArray(tables)) return typeof tables === 'string' ? tables.trim() : '';
  return tables
    .map((t) => String(t ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

/** "Sam" from "Sam Jones". @param {unknown} name */
export function firstName(name) {
  const text = String(name ?? '').trim();
  return text.split(/\s+/)[0] || text;
}

/** "1 item", "3 items". @param {number} n @param {string} one @param {string} [many] */
export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The member view's loyalty card (API contract v6, section 1): "Loyalty card: 7 of 10 stamps · 1 roll waiting in My
 * Lair", or '' when the scan didn't send one (a Lair app from before round 6). For show only: they roll in My Lair.
 * @param {unknown} loyalty `{ stamps, cardSize, rollsAvailable }` from POST /pos/scan
 */
export function loyaltyLine(loyalty) {
  if (!loyalty || typeof loyalty !== 'object') return '';
  const card = /** @type {{ stamps?: unknown, cardSize?: unknown, rollsAvailable?: unknown }} */ (loyalty);
  const size = Math.round(Number(card.cardSize) || 0);
  if (size < 1) return '';
  const stamps = Math.min(size, Math.max(0, Math.round(Number(card.stamps) || 0)));
  const rolls = Math.max(0, Math.round(Number(card.rollsAvailable) || 0));
  return `Loyalty card: ${stamps} of ${size} stamps${rolls ? ` · ${plural(rolls, 'roll')} waiting in My Lair` : ''}`;
}

/**
 * Lower case without accents, for matching names: "Zoë" → "zoe".
 * @param {unknown} text
 */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Formats a time in Auckland time, falling back to the device's own clock (which is in Auckland anyway) when the
 * device can't do time zones.
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

/** "6pm", "6:30pm", "12pm". @param {unknown} ms */
export function timeLabel(ms) {
  const t = Number(ms);
  if (!t) return '';
  const text = format(t, { hour: 'numeric', minute: '2-digit', hour12: true });
  const twelve = text.match(/(\d{1,2})[:.](\d{2})\s*([ap])\.?\s*m\.?/i);
  if (twelve) return `${Number(twelve[1])}${twelve[2] === '00' ? '' : `:${twelve[2]}`}${twelve[3].toLowerCase()}m`;
  const clock = text.match(/(\d{1,2})[:.](\d{2})/);
  if (!clock) return text;
  const hour = Number(clock[1]);
  return `${hour % 12 || 12}${clock[2] === '00' ? '' : `:${clock[2]}`}${hour >= 12 && hour < 24 ? 'pm' : 'am'}`;
}

/** "6pm–9pm", or just "6pm" without an end. @param {unknown} start @param {unknown} end */
export function timeRange(start, end) {
  const from = Number(start);
  if (!from) return '';
  const to = Number(end);
  return to > from ? `${timeLabel(from)}–${timeLabel(to)}` : timeLabel(from);
}

/**
 * The Lair day of a time, as "2026-10-03" (the same form as `day` from GET /pos/today).
 * @param {number} ms
 */
export function dayKey(ms) {
  const date = new Date(ms);
  /** @type {Record<string, string>} */
  const parts = {};
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
    for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;
  } catch {
    // No time zones on this device: its own clock is in Auckland anyway.
    parts.year = String(date.getFullYear());
    parts.month = String(date.getMonth() + 1).padStart(2, '0');
    parts.day = String(date.getDate()).padStart(2, '0');
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** "Today" or "Sat 4 Oct". @param {unknown} ms @param {number} [now] */
export function dayLabel(ms, now = Date.now()) {
  const t = Number(ms);
  if (!t) return '';
  if (dayKey(t) === dayKey(now)) return 'Today';
  return shortDay(t);
}

/** "Sun 4 Oct", never "Today". @param {unknown} ms */
export function shortDay(ms) {
  const t = Number(ms);
  return t ? format(t, { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '') : '';
}

/** "Saturday 3 October". @param {unknown} ms */
export function longDay(ms) {
  const t = Number(ms);
  return t ? format(t, { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '') : '';
}

/** "Today, 6pm–9pm" or "Sat 4 Oct, 6pm–9pm". @param {unknown} start @param {unknown} end @param {number} [now] */
export function whenLabel(start, end, now = Date.now()) {
  const range = timeRange(start, end);
  return range ? `${dayLabel(start, now)}, ${range}` : '';
}

/** "31 Dec 2026". @param {unknown} ms */
export function dateLabel(ms) {
  const t = Number(ms);
  return t ? format(t, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
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

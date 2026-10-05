// Lair (Pacific/Auckland) dates and times for the round 6 flows, worked out with the time zone's own offsets, so they
// come out right on any day of the year and either side of daylight saving.
export const TZ = 'Pacific/Auckland';
/** The Lair date ('YYYY-MM-DD') of a moment */
export const key = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
/** Calendar arithmetic on a date key */
export const addDays = (k, n) => new Date(Date.parse(`${k}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** 0 = Sunday … 6 = Saturday */
export const dow = (k) => new Date(`${k}T12:00:00Z`).getUTCDay();
/** The first `day` (0-6) at least `skip` days after `from` */
export const nextDow = (day, from = key(Date.now()), skip = 1) => {
  let k = addDays(from, skip);
  while (dow(k) !== day) k = addDays(k, 1);
  return k;
};
/** A Lair date and time (hours, minutes) as a timestamp */
export const at = (k, h, mi = 0) => {
  const guess = Date.parse(`${k}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00Z`);
  const offset = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - ms;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
};
/** When a library hold made at `ms` ends (round 7): midnight at the end of the third day, the day it's made counting as
    the first (made Tuesday: 00:00 Friday) */
export const holdUntil = (ms) => at(addDays(key(ms), 3), 0);
/** Whole years from one date key to another, the way birthdays count */
export const wholeYears = (a, b) => {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.max(0, y2 - y1 - (m2 < m1 || (m2 === m1 && d2 < d1) ? 1 : 0));
};
/** "midnight on Thursday 8 October" (emails), "midnight, Thu 8 Oct" (messages on the page) and "midnight Thu", the way the
    Lair app words a hold's end (round 7: 00:00 is the end of the day before) */
export const longWhen = (ms) => `midnight on ${new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(ms - 1)).replace(',', '')}`;
export const pageWhen = (ms) => `midnight, ${new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms - 1)).replace(',', '')}`;
export const shortWhen = (ms) => `midnight ${new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, weekday: 'short' }).format(new Date(ms - 1))}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

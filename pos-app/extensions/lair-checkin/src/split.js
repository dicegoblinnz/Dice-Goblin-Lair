// Split the bill (API contract v4, section 11): friends each pay a share of a booking at the counter. Each share is
// one cart line from POST /pos/share, paid on its own; the friend paying can be put on the sale so the spend is theirs.
// No `shopify` global here, so `npm test` can check it without a POS.
import { firstName, money } from './format.js';
import { dueOf } from './today.js';

/**
 * @typedef {import('./today.js').Row} Row
 * @typedef {{ customerId: string, name: string, code: string }} Payer who's paying a share (their account gets the spend)
 * @typedef {{ ref: string, amount: number, expect: number, at: number }} Pending
 *   A share this iPad put in the cart: once it's paid, the booking's paidAmount should reach `expect`.
 * @typedef {'none' | 'in-cart' | 'waiting' | 'landed' | 'expired'} PendingState
 */

/** Where the check-in screen keeps its notes of shares put in the cart (shopify.storage). */
export const SHARES_KEY = 'pending-shares';

/** After this long, a share that never showed up as paid is forgotten (it was probably taken off the sale). */
export const PENDING_MS = 30 * 60 * 1000;

export const WAITING = 'Waiting for the last payment…';

/** @param {unknown} n */
const cents = (n) => Math.max(0, Math.round(Number(n) || 0));

/** What's owed after any pass: amount − covered, in cents. @param {Row | null | undefined} row */
export function owedOf(row) {
  return Math.max(0, cents(row?.amount) - cents(row?.covered));
}

/** Paid so far, in cents. @param {Row | null | undefined} row */
export function paidOf(row) {
  return cents(row?.paidAmount);
}

/**
 * One person's share, worked out the way the Lair app does for POST /pos/share with no amount: the whole amount
 * shared by everyone booked, rounded up to the cent, but never more than what's left.
 * @param {Row | null | undefined} row
 */
export function personShare(row) {
  const due = dueOf(row);
  if (!due) return 0;
  const amount = cents(row?.amount);
  const people = Math.max(1, Math.round(Number(row?.people) || 1));
  return amount > 0 ? Math.min(due, Math.ceil(amount / people)) : due;
}

/** How many shares are still to pay: what's left ÷ one person's share, rounded up. @param {Row | null | undefined} row */
export function sharesLeft(row) {
  const due = dueOf(row);
  const share = personShare(row);
  return due && share ? Math.ceil(due / share) : 0;
}

/** Offer "Split the bill": something's due and there's someone to split it with, or it's already been split. @param {Row | null | undefined} row */
export function canSplit(row) {
  return dueOf(row) > 0 && (Math.round(Number(row?.people) || 1) > 1 || Boolean(row?.split) || paidOf(row) > 0);
}

/** Lead with "Split the bill": they said they would when booking, or part of it is paid already. @param {Row | null | undefined} row */
export function splitFirst(row) {
  return canSplit(row) && (Boolean(row?.split) || paidOf(row) > 0);
}

/** "3 of 4 left to pay · $10 each". @param {Row | null | undefined} row */
export function shareSummary(row) {
  const left = sharesLeft(row);
  if (!left) return 'Nothing left to pay';
  const people = Math.max(1, Math.round(Number(row?.people) || 1));
  return `${left} of ${Math.max(left, people)} left to pay · ${money(personShare(row))} each`;
}

/** "Paid $10 of $40 · $30 left", or '' while nothing's been paid. @param {Row | null | undefined} row */
export function paidSummary(row) {
  const paid = paidOf(row);
  if (!paid) return '';
  const due = dueOf(row);
  const of = `Paid ${money(paid)} of ${money(Math.max(owedOf(row), paid))}`;
  return due ? `${of} · ${money(due)} left` : of;
}

/** "Sam $10 · Alex $10": who has paid so far. @param {Row | null | undefined} row */
export function paymentsLine(row) {
  const list = Array.isArray(row?.payments) ? row.payments : [];
  return list
    .filter((p) => cents(p?.amount) > 0)
    .map((p) => `${firstName(p?.name) || 'Someone'} ${money(p?.amount)}`)
    .join(' · ');
}

/**
 * Dollars typed by staff, as cents: "12", "12.5", "$12.50" and ".5" all work. Null for a blank, $0, a negative, more
 * than two decimal places, or anything that isn't a number.
 * @param {unknown} text
 * @returns {number | null}
 */
export function parseDollars(text) {
  const t = String(text ?? '')
    .trim()
    .replace(/^\$\s*/, '')
    .replace(/,/g, '');
  if (!/^(?:\d{1,6}(?:\.\d{0,2})?|\.\d{1,2})$/.test(t)) return null;
  const value = Math.round(Number(t) * 100);
  return value > 0 ? value : null;
}

/**
 * What's wrong with a typed share, or '' when it's fine.
 * @param {number | null} amount cents, from parseDollars
 * @param {Row | null | undefined} row
 */
export function amountProblem(amount, row) {
  if (amount == null) return 'Type an amount, like 12.50.';
  const due = dueOf(row);
  if (amount > due) return `Only ${money(due)} is left to pay.`;
  return '';
}

/** The person who booked, as the one paying. @param {Row | null | undefined} row @returns {Payer | null} */
export function bookerPayer(row) {
  const id = String(row?.customerId ?? '').trim();
  return id ? { customerId: id, name: String(row?.name || 'The booker'), code: String(row?.ref || '') } : null;
}

/**
 * Who's paying a share, from a POST /pos/scan answer: a member code (the usual way), or a ticket of theirs that's on
 * their account.
 * @param {any} answer
 * @returns {{ payer: Payer } | { problem: string }}
 */
export function payerFromScan(answer) {
  if (answer?.type === 'member' && answer.member?.customerId != null && answer.member.customerId !== '') {
    const m = answer.member;
    return { payer: { customerId: String(m.customerId), name: String(m.name || 'Member'), code: String(m.code || '') } };
  }
  if ((answer?.type === 'booking' || answer?.type === 'join') && answer.row) {
    const payer = bookerPayer(answer.row);
    if (payer) return { payer };
  }
  return { problem: "That's not a member code. Ask them to open My Lair on the website and show the code there." };
}

/**
 * A note of a share just put in the cart: once it's paid, the booking's paidAmount should reach what it was plus
 * this share.
 * @param {Row} row the row as it was when the share was made
 * @param {number} amount cents
 * @param {number} now
 * @returns {Pending}
 */
export function pendingShare(row, amount, now) {
  return { ref: String(row?.ref || ''), amount: cents(amount), expect: paidOf(row) + cents(amount), at: now };
}

/**
 * Where a share put in the cart from this iPad has got to:
 *   landed   the payment has reached the Lair app (or nothing's left to pay): forget the note
 *   in-cart  its line is still in this cart: take payment on the Verifone
 *   waiting  it's left the cart, but the Lair app hasn't heard about the payment yet
 *   expired  half an hour on and still nothing: forget the note
 *   none     no note
 * @param {Pending | null | undefined} pending
 * @param {Row | null | undefined} row the freshest copy of the row
 * @param {string[]} shareRefs bookings with a share line in this cart (sharesInCart)
 * @param {number} now
 * @returns {PendingState}
 */
export function pendingState(pending, row, shareRefs, now) {
  if (!pending) return 'none';
  if (paidOf(row) >= pending.expect || (row && dueOf(row) === 0)) return 'landed';
  if (pending.ref && (shareRefs || []).includes(pending.ref)) return 'in-cart';
  if (!(now - pending.at < PENDING_MS)) return 'expired';
  return 'waiting';
}

/**
 * Saved notes of shares, checked: anything malformed or too old is dropped.
 * @param {unknown} saved what `shopify.storage.get(SHARES_KEY)` gave back
 * @param {number} now
 * @returns {Record<string, Pending>}
 */
export function cleanPending(saved, now) {
  /** @type {Record<string, Pending>} */
  const out = {};
  if (!saved || typeof saved !== 'object') return out;
  for (const [key, raw] of Object.entries(/** @type {Record<string, any>} */ (saved))) {
    if (!raw || typeof raw.ref !== 'string' || !raw.ref) continue;
    const expect = Number(raw.expect);
    const at = Number(raw.at);
    if (!Number.isFinite(expect) || !Number.isFinite(at) || !(now - at < PENDING_MS)) continue;
    out[key] = { ref: raw.ref, amount: cents(raw.amount), expect, at };
  }
  return out;
}

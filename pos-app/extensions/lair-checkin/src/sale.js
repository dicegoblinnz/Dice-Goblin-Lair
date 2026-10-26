// The strip at the top of each screen saying what's in the cart and who's on the sale (Mo, 27 Oct 2026: "It should
// always be clear who's here, what they owe and what's in the cart"). No `shopify` global here, so `npm test` can
// check it without a POS.
import { customerIdNumber, firstName, money } from './format.js';

/**
 * @typedef {import('./cart.js').CartLike} CartLike
 * @typedef {import('./today.js').Today} Today
 * @typedef {{ text: string, tone: 'neutral' | 'warning', detail: string }} Strip
 */

/** What the cart comes to, in cents, from its grandTotal ("15.00"). @param {CartLike} cart */
export function cartCents(cart) {
  const total = Number(/** @type {{ grandTotal?: unknown } | null | undefined} */ (cart)?.grandTotal);
  return Number.isFinite(total) && total > 0 ? Math.round(total * 100) : 0;
}

/**
 * Names for the Shopify customers this screen knows (from today's list and the members it has seen), by customer
 * number, so the strip can say who's on the sale.
 * @param {Today | null | undefined} today
 * @param {{ customerId?: unknown, name?: unknown }[]} [more] members and payers seen on this screen
 * @returns {Map<number, string>}
 */
export function customerNames(today, more = []) {
  /** @type {Map<number, string>} */
  const names = new Map();
  /** @param {unknown} id @param {unknown} name */
  const add = (id, name) => {
    const number = customerIdNumber(id);
    const text = String(name ?? '').trim();
    if (number && text && !names.has(number)) names.set(number, text);
  };
  for (const person of more || []) add(person?.customerId, person?.name);
  for (const group of today?.groups || []) for (const row of group.rows || []) add(row?.customerId, row?.name);
  return names;
}

/**
 * What the cart strip says: "In the cart: nothing yet", or "In the cart: $15 · Sam Jones". When someone other than
 * the person on screen is on a sale with something in it, a warning: this person's fee would join that sale.
 * @param {CartLike} cart shopify.cart.current.value
 * @param {Map<number, string>} names customerNames
 * @param {{ customerId?: unknown, name?: string } | null} [person] who's on screen
 * @returns {Strip}
 */
export function saleStrip(cart, names, person = null) {
  const onSale = customerIdNumber(cart?.customer?.id);
  const who = onSale ? names.get(onSale) || 'a customer' : '';
  if (!(cart?.lineItems || []).length) {
    return { text: `In the cart: nothing yet${who ? ` · ${who} is on the sale` : ''}`, tone: 'neutral', detail: '' };
  }
  const text = `In the cart: ${money(cartCents(cart))}${who ? ` · ${who}` : ''}`;
  const mine = customerIdNumber(person?.customerId);
  if (!onSale || !mine || onSale === mine) return { text, tone: 'neutral', detail: '' };
  const them = names.get(onSale) ? firstName(names.get(onSale)) : '';
  const fee = firstName(person?.name) ? `${firstName(person?.name)}'s fee` : 'This fee';
  return {
    text,
    tone: 'warning',
    detail: them
      ? `${fee} joins ${them}'s sale. If they're paying apart, take ${them}'s payment first.`
      : `${fee} joins the sale already in the cart. If they're paying apart, take that payment first.`,
  };
}

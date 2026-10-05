// Putting Lair fees, shares of a bill, tabs and members into the POS cart (the cart API of POS UI extensions 2026-07).
import { customerIdNumber } from './format.js';
import { tabItems } from './lines.js';

/**
 * @typedef {import('./lines.js').FeeLine} FeeLine
 * @typedef {import('./lines.js').TabItem} TabItem
 * @typedef {'added' | 'already' | 'other' | 'failed' | 'none'} CustomerResult
 *   added: now on the sale · already: was on it · other: the sale has someone else · failed: POS said no · none: no id
 * @typedef {{ uuid?: string, properties?: Record<string, string> }} LineLike
 * @typedef {{ lineItems?: LineLike[], customer?: { id?: unknown } } | null | undefined} CartLike
 */

/**
 * The values of one line item property across the cart: the `_booking` refs or `_tab` ids already there.
 * @param {CartLike} cart
 * @param {string} key
 * @returns {string[]}
 */
export function propertyValues(cart, key) {
  return (cart?.lineItems || []).map((item) => item?.properties?.[key]).filter((v) => typeof v === 'string' && v !== '');
}

/** Codes of the bookings with a line in the cart (a whole fee or a share). @param {CartLike} cart */
export function bookingsInCart(cart) {
  return propertyValues(cart, '_booking');
}

/** Codes of the bookings with a share of their bill in the cart. @param {CartLike} cart */
export function sharesInCart(cart) {
  return (cart?.lineItems || [])
    .filter((item) => item?.properties?._share)
    .map((item) => item?.properties?._booking)
    .filter((ref) => typeof ref === 'string' && ref !== '');
}

/** @param {CartLike} cart */
export function tabsInCart(cart) {
  return propertyValues(cart, '_tab');
}

/** @param {CartLike} cart */
export function cartCustomerId(cart) {
  return customerIdNumber(cart?.customer?.id);
}

/** A plain sentence for a cart error. @param {unknown} error */
export function cartProblem(error) {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return text && text.length < 160 ? text : 'POS refused the change.';
}

/**
 * Puts a customer on the sale, so what they spend counts for them. Leaves someone else already on
 * the sale alone unless `replace` is set (staff picked who's paying).
 * @param {unknown} id
 * @param {boolean} [replace]
 * @returns {Promise<CustomerResult>}
 */
export async function putOnSale(id, replace = false) {
  const customerId = customerIdNumber(id);
  if (!customerId) return 'none';
  const current = cartCustomerId(shopify.cart.current.value);
  if (current === customerId) return 'already';
  if (current && !replace) return 'other';
  try {
    await shopify.cart.setCustomer({ id: customerId });
    return 'added';
  } catch {
    return 'failed';
  }
}

/**
 * Adds each fee line as a custom sale and tags it with its booking (`_booking`, and `_share` for a share of a bill).
 * Custom sales can't carry properties themselves, so they go on by the line's UUID straight after. Skips a booking
 * that already has a line in the cart, so a second tap never charges twice. Then puts the customer on the sale: if
 * the sale has nobody yet, or in their place when `replaceCustomer` is set (staff picked who's paying).
 * @param {FeeLine[]} lines
 * @param {unknown} customerId
 * @param {{ replaceCustomer?: boolean }} [options]
 */
export async function addFeesToCart(lines, customerId, { replaceCustomer = false } = {}) {
  const result = { ...(await addFeeLines(lines)), customer: /** @type {CustomerResult} */ ('none') };
  if (result.added.length || result.skipped.length) result.customer = await putOnSale(customerId, replaceCustomer);
  return result;
}

/**
 * The fee lines into the cart, as addFeesToCart does, without touching the customer.
 * @param {FeeLine[]} lines
 */
async function addFeeLines(lines) {
  const already = new Set(bookingsInCart(shopify.cart.current.value));
  const result = {
    /** @type {FeeLine[]} */ added: [],
    /** @type {FeeLine[]} a line for that booking was in the cart already */ skipped: [],
    /** @type {FeeLine[]} in the cart, but not tagged with their booking */ unlinked: [],
    /** @type {{ line: FeeLine, message: string }[]} not in the cart */ failed: [],
  };
  for (const line of lines || []) {
    const ref = line.properties._booking;
    if (ref && already.has(ref)) {
      result.skipped.push(line);
      continue;
    }
    /** @type {string} */
    let uuid;
    try {
      uuid = await shopify.cart.addCustomSale({ title: line.title, price: line.price, quantity: line.quantity, taxable: line.taxable });
    } catch (error) {
      result.failed.push({ line, message: cartProblem(error) });
      continue;
    }
    result.added.push(line);
    if (ref) already.add(ref);
    if (!ref || !uuid) {
      result.unlinked.push(line);
      continue;
    }
    try {
      await shopify.cart.addLineItemProperties(uuid, line.properties);
    } catch {
      result.unlinked.push(line);
    }
  }
  return result;
}

/**
 * A member's tab into the cart, in the order the API contract gives (section 7):
 *   1. each item as the real product (`cart.addLineItem(variantId, qty)`, so POS charges the shop's own price) with
 *      the line property `_tab: <tab id>`, so paying the order marks the tab paid. The 2026-07 cart API takes the
 *      property in the same call (`{ properties }`); a line that still turns up without it gets it straight after.
 *   2. `markAdded(tab id)`: POST /pos/tab/:id/added, so they can't change the tab while they pay.
 *   3. the member on the sale.
 * Does nothing if this tab is in the cart already.
 * @param {import('./lines.js').Tab} tab
 * @param {unknown} customerId
 * @param {(tabId: string) => Promise<unknown>} markAdded
 */
export async function addTabToCart(tab, customerId, markAdded) {
  const result = {
    ...(await addTabItems(tab)),
    /** @type {string} what the Lair app said when told the tab is in the cart, if it went wrong */ markProblem: '',
    customer: /** @type {CustomerResult} */ ('none'),
  };
  if (!result.added.length) return result;
  result.markProblem = await tellTabAdded(String(tab?.id ?? ''), markAdded);
  result.customer = await putOnSale(customerId);
  return result;
}

/**
 * "Add everything to cart" for a member, in the order the API contract gives (v5 section 2): their fee lines (today's,
 * then owed seats'), then the tab's items tagged `_tab`, then the member on the sale, then the Lair app told the tab
 * is in the cart. Each part skips what's in the cart already, like addFeesToCart and addTabToCart.
 * @param {{ lines: FeeLine[], tab: import('./lines.js').Tab | null, customerId: unknown, markAdded: (tabId: string) => Promise<unknown> }} input
 */
export async function addEverythingToCart({ lines, tab, customerId, markAdded }) {
  const fees = await addFeeLines(lines);
  const tabPart = tab ? { ...(await addTabItems(tab)), markProblem: '' } : null;
  const anything = fees.added.length || fees.skipped.length || tabPart?.added.length || tabPart?.already;
  /** @type {CustomerResult} */
  const customer = anything ? await putOnSale(customerId) : 'none';
  if (tabPart?.added.length) tabPart.markProblem = await tellTabAdded(String(tab?.id ?? ''), markAdded);
  return { fees, tab: tabPart, customer };
}

/**
 * POST /pos/tab/:id/added through `markAdded`: '' when it went, else what to tell staff.
 * @param {string} tabId
 * @param {(tabId: string) => Promise<unknown>} markAdded
 */
async function tellTabAdded(tabId, markAdded) {
  try {
    await markAdded(tabId);
    return '';
  } catch (error) {
    return error instanceof Error && error.message ? error.message : 'The Lair app did not answer.';
  }
}

/**
 * A tab's items into the cart, as addTabToCart does, without telling the Lair app or touching the customer.
 * @param {import('./lines.js').Tab} tab
 */
async function addTabItems(tab) {
  const tabId = String(tab?.id ?? '');
  const { items, bad } = tabItems(tab);
  const result = {
    already: tabId !== '' && tabsInCart(shopify.cart.current.value).includes(tabId),
    /** @type {TabItem[]} */ added: [],
    /** @type {TabItem[]} staff said no to selling it (POS asked about stock) */ declined: [],
    /** @type {TabItem[]} in the cart without `_tab`: paying won't mark the tab paid */ untagged: [],
    /** @type {{ item: TabItem, message: string }[]} */ failed: [],
    /** @type {string[]} no usable product */ bad,
  };
  if (result.already || !tabId) return result;
  for (const item of items) {
    /** @type {string} */
    let uuid;
    try {
      uuid = await shopify.cart.addLineItem(item.variantId, item.qty, { properties: { _tab: tabId } });
    } catch (error) {
      result.failed.push({ item, message: cartProblem(error) });
      continue;
    }
    if (!uuid) {
      result.declined.push(item);
      continue;
    }
    result.added.push(item);
    const line = (shopify.cart.current.value?.lineItems || []).find((l) => l?.uuid === uuid);
    if (line && line.properties?._tab !== tabId) {
      try {
        await shopify.cart.addLineItemProperties(uuid, { _tab: tabId });
      } catch {
        result.untagged.push(item);
      }
    }
  }
  return result;
}

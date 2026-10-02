// Putting Lair fees and members into the POS cart.

/**
 * The `_booking` refs of fee lines already in the cart.
 * @param {{ lineItems?: { properties?: Record<string, string> }[] } | undefined} cart
 * @returns {string[]}
 */
export function bookingsInCart(cart) {
  return (cart?.lineItems || []).map((item) => item?.properties?._booking).filter((ref) => typeof ref === 'string' && ref !== '');
}

/**
 * Adds each fee line as a custom sale and tags it with its booking (line item properties), skipping fees that are
 * already in the cart. Puts the booking's customer on the sale when the sale has no customer yet, so the spend
 * counts toward their rolls. Throws if POS refuses the custom sale itself.
 * @param {import('./codes.js').FeeLine[]} lines
 * @param {number | null} customerId
 */
export async function addFeesToCart(lines, customerId) {
  const cart = shopify.cart.current.value;
  const already = new Set(bookingsInCart(cart));
  const result = {
    /** @type {import('./codes.js').FeeLine[]} */ added: [],
    /** @type {import('./codes.js').FeeLine[]} */ skipped: [],
    /** @type {import('./codes.js').FeeLine[]} */ unlinked: [],
    customerAdded: false,
  };
  if (customerId && !cart?.customer) {
    try {
      await shopify.cart.setCustomer({ id: customerId });
      result.customerAdded = true;
    } catch {
      // The fee matters more than the customer: carry on without them.
    }
  }
  for (const line of lines) {
    if (already.has(line.properties._booking)) {
      result.skipped.push(line);
      continue;
    }
    const uuid = await shopify.cart.addCustomSale({ title: line.title, price: line.price, quantity: line.quantity, taxable: line.taxable });
    result.added.push(line);
    try {
      if (!uuid) throw new Error('POS gave no line id');
      await shopify.cart.addLineItemProperties(uuid, line.properties);
    } catch {
      result.unlinked.push(line);
    }
  }
  return result;
}

/**
 * Puts a member on the current sale.
 * @param {number} customerId
 */
export async function setCartCustomer(customerId) {
  await shopify.cart.setCustomer({ id: customerId });
}

/** A plain sentence for a cart error. @param {unknown} error */
export function cartProblem(error) {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return text && text.length < 160 ? text : 'POS refused the change.';
}

// What goes in the POS cart: fee lines from a check-in, items from a member's tab, and the words staff see after.
// No `shopify` global here, so `npm test` can check it without a POS.
import { money, plural } from './format.js';

/**
 * A custom sale for the POS cart. `properties._booking` is the ticket code: when the order is paid, the Lair app
 * marks that booking or sign-up paid.
 * @typedef {{ title: string, price: string, quantity: number, taxable: boolean, properties: Record<string, string> }} FeeLine
 * A tab item ready for cart.addLineItem.
 * @typedef {{ variantId: number, qty: number, title: string, price: number }} TabItem
 * @typedef {{ id?: string | number, day?: string, items?: unknown[], total?: number, status?: string, updatedAt?: number }} Tab
 * @typedef {{ code?: string, label?: string, used?: number, left?: number, covered?: number }} UsedPass
 */

/** "15.00" for a positive price, null otherwise. @param {unknown} price */
function priceString(price) {
  const n = Number(price);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
}

/**
 * The fee lines from a check-in answer (`POST /pos/checkin` or `/pos/checkin-member`), cleaned up and each tagged
 * with its booking. An answer without `lines` at all (an older Lair app) gets one line for what the row says is due.
 * @param {{ lines?: unknown, row?: { ref?: string, type?: string, due?: number } | null } | null | undefined} answer
 * @param {string} [ref] the ticket code to use when a line doesn't say
 * @returns {FeeLine[]}
 */
export function feeLines(answer, ref = '') {
  const fallbackRef = String(answer?.row?.ref || ref || '').trim();
  if (!Array.isArray(answer?.lines)) {
    const due = Math.max(0, Math.round(Number(answer?.row?.due) || 0));
    if (!due || !fallbackRef) return [];
    const what = answer?.row?.type === 'join' ? 'Event entry' : 'Table fee';
    return [{ title: `${what}: ${fallbackRef}`, price: (due / 100).toFixed(2), quantity: 1, taxable: true, properties: { _booking: fallbackRef } }];
  }
  /** @type {FeeLine[]} */
  const lines = [];
  for (const raw of answer.lines) {
    const line = /** @type {{ title?: unknown, price?: unknown, quantity?: unknown, taxable?: unknown, properties?: unknown }} */ (raw || {});
    const price = priceString(line.price);
    if (!price) continue;
    /** @type {Record<string, string>} */
    const properties = {};
    if (line.properties && typeof line.properties === 'object') {
      for (const [key, value] of Object.entries(line.properties)) if (value != null) properties[key] = String(value);
    }
    if (!properties._booking && fallbackRef) properties._booking = fallbackRef;
    // A line with no booking still goes in the cart (the money is owed); the cart step warns that it won't mark
    // anything paid by itself.
    lines.push({
      title: String(line.title || (properties._booking ? `Table fee: ${properties._booking}` : 'Lair fee')).slice(0, 255),
      price,
      quantity: Math.min(100, Math.max(1, Math.round(Number(line.quantity) || 1))),
      taxable: line.taxable !== false,
      properties,
    });
  }
  return lines;
}

/**
 * The cart line for one share of a bill, from `POST /pos/share` (`{ row, line }`): tagged with its booking and with
 * `_share`, so the payment counts towards the booking without paying all of it.
 * @param {{ line?: unknown, row?: { ref?: string } | null } | null | undefined} answer
 * @returns {FeeLine[]}
 */
export function shareLines(answer) {
  if (!answer?.line || typeof answer.line !== 'object') return [];
  return feeLines({ lines: [answer.line], row: answer.row }).map((line) => ({
    ...line,
    properties: { ...line.properties, _share: line.properties._share || '1' },
  }));
}

/** Total of some fee lines, in cents. @param {FeeLine[]} lines */
export function linesTotal(lines) {
  return (lines || []).reduce((sum, line) => sum + Math.round(Number(line.price) * 100) * line.quantity, 0);
}

/**
 * A tab's items, ready for the cart: numeric variant ids and quantities 1–20. Items POS couldn't take (no usable
 * variant id) come back in `bad`, so staff can ring them up by hand.
 * @param {Tab | null | undefined} tab
 */
export function tabItems(tab) {
  /** @type {TabItem[]} */
  const items = [];
  /** @type {string[]} */
  const bad = [];
  for (const raw of Array.isArray(tab?.items) ? tab.items : []) {
    const item = /** @type {{ variantId?: unknown, qty?: unknown, title?: unknown, variantTitle?: unknown, price?: unknown }} */ (raw || {});
    const title = [item.title, item.variantTitle]
      .map((t) => String(t ?? '').trim())
      .filter((t) => t && t !== 'Default Title')
      .join(' – ');
    const id = String(item.variantId ?? '').trim();
    const variantId = /^\d{1,20}$/.test(id) ? Number(id) : NaN;
    if (!Number.isSafeInteger(variantId) || variantId <= 0) {
      bad.push(title || 'An item');
      continue;
    }
    const qty = Math.min(20, Math.max(1, Math.round(Number(item.qty) || 1)));
    items.push({ variantId, qty, title: title || `Item ${id}`, price: Math.max(0, Math.round(Number(item.price) || 0)) });
  }
  return { items, bad };
}

/** "3 items · $12.50" (the tab's own prices; POS charges the shop's). @param {Tab | null | undefined} tab */
export function tabSummary(tab) {
  const { items, bad } = tabItems(tab);
  const count = [...items.map((i) => i.qty), ...bad.map(() => 1)].reduce((a, b) => a + b, 0);
  const total = Number(tab?.total) > 0 ? Number(tab?.total) : items.reduce((sum, i) => sum + i.price * i.qty, 0);
  return `${plural(count, 'item')} · ${money(total)}`;
}

/** The toast after fees go in the cart: "Added $15. Ready to pay." @param {number} cents */
export function addedToast(cents) {
  return `Added ${money(cents)}. Ready to pay.`;
}

export const NOTHING_TO_PAY = 'Checked in. Nothing to pay.';

/** The toast after a tab goes in the cart: "Added 3 items from the tab. Ready to pay." @param {number} count */
export function tabToast(count) {
  return `Added ${plural(count, 'item')} from the tab. Ready to pay.`;
}

/** How many things a list of tab items is (2 Cokes and an ice cream are 3). @param {TabItem[]} items */
export function itemCount(items) {
  return (items || []).reduce((sum, item) => sum + item.qty, 0);
}

/**
 * "Warhammer league covered $10 · 6 sessions left", from the `pass` in a check-in answer.
 * @param {UsedPass | null | undefined} pass
 */
export function passUsedLabel(pass) {
  if (!pass) return '';
  const covered = Math.max(0, Math.round(Number(pass.covered) || 0));
  const left = Number(pass.left);
  const name = pass.label || 'The pass';
  const parts = [covered ? `${name} covered ${money(covered)}` : `${name} used`];
  if (Number.isFinite(left)) parts.push(`${plural(Math.max(0, Math.round(left)), 'session')} left`);
  return parts.join(' · ');
}

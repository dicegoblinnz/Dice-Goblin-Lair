// What Lair check-in keeps on the iPad between visits (shopify.storage, shared by the tile and the check-in screen):
// notes of bill shares put in the cart, and today's numbers for the tile. Storage is only a convenience: when it
// fails (full, or missing on an old POS) these quietly do nothing, and nothing about money depends on them.
import { cleanPending, SHARES_KEY } from './split.js';
import { TILE_KEY } from './today.js';

/**
 * The notes of shares put in the cart from this iPad, checked.
 * @param {number} now
 * @returns {Promise<Record<string, import('./split.js').Pending>>}
 */
export async function loadPending(now) {
  try {
    return cleanPending(await shopify.storage.get(SHARES_KEY), now);
  } catch {
    return {};
  }
}

/** @param {Record<string, import('./split.js').Pending>} pending */
export async function savePending(pending) {
  try {
    await shopify.storage.set(SHARES_KEY, pending);
  } catch {
    // Only "Waiting for the last payment…" depends on it.
  }
}

/** Today's numbers for the tile. @param {{ at: number, day: string, text: string }} entry */
export async function saveTileEntry(entry) {
  try {
    await shopify.storage.set(TILE_KEY, entry);
  } catch {
    // The tile keeps the numbers it has.
  }
}

/** @returns {Promise<unknown>} */
export async function readTileEntry() {
  try {
    return await shopify.storage.get(TILE_KEY);
  } catch {
    return undefined;
  }
}

// The "Lair check-in" tile on the POS home screen, with today's numbers ("9 of 27 here · 2 to pay") and a badge for
// the bookings that are here with something still to pay that isn't in the cart. Tapping it opens the check-in
// screen (Modal.jsx).
//
// It asks the Lair app for today's list when the tile appears, a few seconds after a sale with Lair fees leaves the
// cart (it was probably paid), and when its numbers are over 15 minutes old as the cart changes: no polling. In
// between it picks up the numbers the check-in screen saves as it works.
import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { bookingsInCart, hasLairLines } from './cart.js';
import { dayKey } from './format.js';
import { getToday } from './lair.js';
import { readTileEntry } from './store.js';
import { AFTER_SALE_MS, newerTileEntry, STALE_MS, tileEntry, tileWords } from './today.js';

export default async () => {
  render(<Tile />, document.body);
};

const WELCOME = 'Scan a code or find a booking';

/** At most one try for the numbers a minute, so a slow or missing connection isn't asked again and again. */
const RETRY_MS = 60_000;

function Tile() {
  const [words, setWords] = useState({ subheading: WELCOME, count: 0 });

  useEffect(() => {
    let live = true;
    /** @type {import('./today.js').TileEntry | null} */
    let entry = null;
    let triedAt = 0;
    let hadLair = hasLairLines(shopify.cart?.current?.value);
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const inCart = () => bookingsInCart(shopify.cart?.current?.value);
    /** @param {import('./today.js').TileEntry} next */
    const show = (next) => {
      if (!live) return;
      entry = next;
      setWords(tileWords(next, inCart()));
    };
    const ask = () => {
      triedAt = Date.now();
      getToday().then(
        (today) => show(tileEntry(today, Date.now())),
        () => {
          // No numbers (offline, or the POS login has no access): the tile still opens the check-in screen.
        },
      );
    };
    ask();
    const unsubscribe = shopify.cart?.current?.subscribe?.((cart) => {
      if (entry) setWords(tileWords(entry, bookingsInCart(cart)));
      readTileEntry().then((saved) => {
        const newer = newerTileEntry(saved, entry?.at ?? 0, dayKey(Date.now()));
        if (newer) show(newer);
      });
      const hasLair = hasLairLines(cart);
      const now = Date.now();
      if (hadLair && !hasLair) {
        clearTimeout(timer);
        timer = setTimeout(ask, AFTER_SALE_MS);
      } else if (now - (entry?.at ?? 0) > STALE_MS && now - triedAt > RETRY_MS) {
        ask();
      }
      hadLair = hasLair;
    });
    return () => {
      live = false;
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, []);

  // A tile with a count and one without are separate elements (the key), so the count is never left behind when it
  // goes back to none.
  return words.count ? (
    <s-tile key="count" heading="Lair check-in" subheading={words.subheading} itemCount={words.count} onClick={() => shopify.action.presentModal()} />
  ) : (
    <s-tile key="plain" heading="Lair check-in" subheading={words.subheading} onClick={() => shopify.action.presentModal()} />
  );
}

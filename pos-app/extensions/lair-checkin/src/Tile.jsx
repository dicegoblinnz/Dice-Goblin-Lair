// The "Lair check-in" tile on the POS home screen, with today's numbers ("14 today · 5 here"). Tapping it opens the
// check-in screen (Modal.jsx).
//
// It asks the Lair app for today's list once, when the tile appears: no polling. After that it picks up the numbers
// the check-in screen saves as it works, whenever the cart changes (people being checked in change it), without
// asking the Lair app again.
import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { dayKey } from './format.js';
import { getToday } from './lair.js';
import { readTileEntry } from './store.js';
import { newerTileText, tileSubheading } from './today.js';

export default async () => {
  render(<Tile />, document.body);
};

const WELCOME = 'Scan a code or find a booking';

function Tile() {
  const [subheading, setSubheading] = useState(WELCOME);

  useEffect(() => {
    let live = true;
    let shownAt = 0;
    /** @param {string} text @param {number} at */
    const show = (text, at) => {
      if (!live) return;
      shownAt = at;
      setSubheading(text);
    };
    getToday().then(
      (today) => show(tileSubheading(today), Date.now()),
      () => {
        // No numbers (offline, or the POS login has no access): the tile still opens the check-in screen.
      },
    );
    const unsubscribe = shopify.cart?.current?.subscribe?.(() => {
      readTileEntry().then((entry) => {
        const text = newerTileText(entry, shownAt, dayKey(Date.now()));
        if (text) show(text, Number(/** @type {{ at?: unknown }} */ (entry).at));
      });
    });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, []);

  return <s-tile heading="Lair check-in" subheading={subheading} onClick={() => shopify.action.presentModal()} />;
}

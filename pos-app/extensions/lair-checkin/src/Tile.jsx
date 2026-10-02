// The "Lair check-in" tile on the POS home screen. Tapping it opens the check-in screen (Modal.jsx).
import '@shopify/ui-extensions/preact';
import { render } from 'preact';

export default async () => {
  render(<Tile />, document.body);
};

function Tile() {
  return (
    <s-tile
      heading="Lair check-in"
      subheading="Scan a ticket or member card"
      onClick={() => shopify.action.presentModal()}
    />
  );
}

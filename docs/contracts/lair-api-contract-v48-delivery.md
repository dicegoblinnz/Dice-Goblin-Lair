# Lair API contract v48: delivery priced from the parcel and the address

Mo, 21 November 2026. A rural parcel cost $16 on a $10 delivery, because rural was an option the customer chose.
Delivery is now worked out in the Lair before payment: the real Aramex price to that address, plus $1 for packing.

## 1. The rule (built: `src/delivery.js`, `test/round48-delivery.test.js`)

- **One rule for every posted order:** it's priced as one Aramex parcel sent from the Lair, whoever really sends it
  (dropshipped dice and the Baron of Dice range included). Pickup is free and skips all of this.
- **The parcel:** the items' weights plus 150 g of packing, rounded up to 100 g. The box is as long and wide as the
  biggest item and tall enough for everything with 15% padding. An item with no weight or size on its listing counts as
  300 g and 20 × 15 × 6 cm, and the quote is marked `estimated`.
- **The price:** GoSweetSpot's `Cost` for the cheapest Aramex service that isn't a Saturday one, plus 15% GST, rounded
  up to a whole cent, plus $1.00 packing. Rural is the courier's answer for the address (`IsRuralDelivery`).
- **No live price** (no key, GoSweetSpot down or slow past 8 seconds, no Aramex service): the flat rates from before
  stand, $10, or $15 when the address has RD in it. Nobody is stopped from buying.
- **Settings:** `GSS_ACCESS_KEY` (Worker secret only), `GSS_SITE_ID`, `GSS_COST_HAS_GST` (`yes` if `Cost` turns out to
  include GST).

## 2. Still to build

1. **Check against a real quote** once the key is in: that `Cost` has no GST or fuel surcharge missing, against a
   GoSweetSpot invoice.
2. **`POST /delivery/quote`** `{ address, lines: [{ variantId, quantity }] }`: reads each variant's weight and its
   product's `custom.ship_length_cm`, `ship_width_cm`, `ship_height_cm` from Shopify, answers `deliveryQuote`'s result.
3. **`POST /delivery/checkout`**: quotes again on the server, then makes a draft order for the cart with the delivery
   as its shipping line (as `createLibrarySend` does) and answers its checkout link. To prove before it goes live: the
   dice deal, a deck's free sleeves, discount codes, store credit, gift cards, the d20 rolls and Same parcel all behave
   as they do at the normal checkout.
4. **The website's delivery step** (lab first): Proceed to pay opens it, the address goes in, one line shows the price.
5. **Staff page:** parcels that cost more than the customer paid, from GoSweetSpot's webhook (`TotalCost`), and
   tracking in My Lair.

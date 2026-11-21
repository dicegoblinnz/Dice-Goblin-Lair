# Lair API contract v48: delivery priced from the parcel and the address

Mo, 21 November 2026. A rural parcel cost $16 on a $10 delivery, because rural was an option the customer chose.
Delivery is now worked out in the Lair before payment: the real Aramex price to that address, plus $1 for packing.

## 1. The rule (built: `src/delivery.js`, `test/round48-delivery.test.js`)

- **One rule for every posted order:** it's priced as one Aramex parcel sent from the Lair, whoever really sends it
  (dropshipped dice and the Baron of Dice range included). Pickup is free and skips all of this.
- **The parcel:** the items' weights, 5% on the heavy side, plus 150 g of packing, rounded up to 100 g (section 3
  says when an order is split). The box is as long and wide as the
  biggest item and tall enough for everything with 15% padding. An item with no weight or size on its listing counts as
  300 g and 20 × 15 × 6 cm, and the quote is marked `estimated`.
- **The price:** GoSweetSpot's `Cost` for the cheapest Aramex service that isn't a Saturday one, plus 15% GST, rounded
  up to a whole cent, plus $1.00 packing. Rural is the courier's answer for the address (`IsRuralDelivery`).
- **No live price** (no key, GoSweetSpot down or slow past 8 seconds, no Aramex service): the flat rates from before
  stand, $10, or $15 when the address has RD in it. Nobody is stopped from buying.
- **Settings:** `GSS_ACCESS_KEY` (Worker secret only), `GSS_SITE_ID` (in `wrangler.toml`), `GSS_COST_HAS_GST` (`yes` if `Cost` turns out to
  include GST).

## 2. `POST /delivery/quote` (built)

`{ address: { street, suburb, city, postcode }, lines: [{ variantId, quantity }] }`, for anyone with a cart, through
the store's app proxy. Answers `{ cents, rural, source, estimated }` and never the courier's own cost. `source` is
`live`, `fallback` or `none` (nothing to post).

- Each variant's weight comes from Shopify, and its size from its product's `custom.ship_length_cm`,
  `ship_width_cm` and `ship_height_cm` (a plain number, or Shopify's dimension type).
- An item with no weight or size, one Shopify doesn't know, or Shopify not answering: that line is a guess and the
  answer says `estimated: true`. The quote still comes.
- A live courier cost under $3 isn't believed, and the flat rates stand.
- At most 60 lines; 30 quotes in ten minutes from one address (429 past that); the same cart to the same door is kept
  for ten minutes.
- The last live quote's workings (every service offered, the one picked, the parcel) go to the config database's
  `status` table, key `delivery`.

## 3. Parcels (built: `parcelsOf`)

- **One parcel or several:** biggest items first, each into the first parcel with room. A parcel is split off before it
  passes 22 kg, 140 cm long or 150 litres, a little under Aramex's 25 kg, 1.5 m and 175 litres.
- **On the large side:** items are weighed 5% heavy, each parcel gets its 150 g of packing and 15% padding, and
  everything rounds up.
- **One price:** the parcels go to GoSweetSpot as one request, and the customer sees one price with one $1.00 for
  packing. With no live price, each parcel is charged the flat rate.
- **An item too big for any parcel** gets a parcel of its own. Aramex then offers no service, so the flat rate stands.
  Still Mo's to decide: charge the flat rate as now, or ask the customer to get in touch.

## 4. `POST /delivery/checkout` (built, on the branch; nothing calls it yet)

`{ address: { name, street, suburb, city, postcode, phone }, email, note, codes, lines: [{ variantId, quantity,
properties }] }`. The Lair prices the delivery again itself (a price sent by the page is ignored), makes a draft order
for the cart with that as its shipping line, and answers `{ checkoutUrl, cents, rural, source, estimated,
sameParcel? }`. `checkoutUrl` is `null` when nothing in the cart is posted: the page goes to the normal checkout.

- **The draft:** tagged `lair-delivery`, the signed-in customer on it, the address filled in, automatic discounts on,
  the cart's discount codes on it and more allowed at checkout, each line's properties kept.
- **Its paid order is an online order** (`asOnlineOrder`): it earns d20 rolls and quests as any website order does,
  and gets none of the trust the Lair's own drafts get (a note naming a booking pays nothing).
- **Same parcel:** a signed-in customer inside their hour pays no delivery. The Lair honours it itself (the quote
  answers `cents: 0, sameParcel: "#1550"`, the line reads "Same parcel as #1550"), since the `PARCEL-` code can't take
  the Lair's own delivery line off. The paid order is linked to its first by `_parcel`, then tagged and noted as before.

What's proven, and how:

| | How | |
|---|---|---|
| Dice deal, free sleeves | Shopify's own sum for a delivery draft on the real shop (`draftOrderCalculate`, 21 Nov 2026): 3 dice sets, a Commander deck and sleeves came to $150 after $35 off, plus $6.75 delivery | proven |
| d20 rolls, Same parcel | `test/round48-delivery-checkout.test.js`, `test/round38-order-rolls.test.js` | proven |
| Discount codes | The draft is asked for with the codes on it and allowed at checkout (test). The shop had no live code to try on 21 Nov 2026 | to try with a real code |
| Store credit, gift cards | Both are taken on Shopify's payment page, which the draft's link opens for the customer on it | to try on one real checkout in the lab |

Known gap: two delivery checkouts opened inside the same hour both read $0 until one is paid.

Also to try on that real checkout: whether the address can be changed on Shopify's page after the price is set, and
that an item out of stock can't be bought.

## 5. Still to build

1. **Check against a real quote:** that `Cost` has no GST or fuel surcharge missing, against GoSweetSpot.
2. **The website's delivery step** (lab first): Proceed to pay opens it, the address goes in, one line shows the price.
   Express checkout buttons skip it: Mo to say whether they stay.
3. **The Packed button** (section 6).
4. **Staff page:** parcels that cost more than the customer paid, from GoSweetSpot's webhook (`TotalCost`), and
   tracking in My Lair.

## 6. Packing and dispatch (decided by Mo, 21 November 2026; not built)

- **No AI when it runs:** packing, pricing, the label and the pickup are plain rules and GoSweetSpot calls.
- **Packing:** the Lair chooses the box sizes itself, on the slightly larger and heavier side to allow for error, as
  one parcel or as two or more when the order needs it. The customer sees one delivery price.
- **Packed button:** nothing is sent to GoSweetSpot when the order is paid. Staff tap Packed on the staff page (changing
  the box there if they used another), and that makes the shipment, prints the label and books the Aramex pickup.
- **What leaves the Lair:** everything except the dropshipped dice, which their supplier sends direct, so those lines
  get no label and no pickup. The Baron of Dice range does leave the Lair: Mo collects it first, then packs it.
- **Every parcel that's ready goes:** the pickup the Packed button books covers every packed parcel the driver hasn't
  collected yet, not only the one just packed (Mo: "Make sure it takes all the items ready for delivery"). If the
  Lair can't book through GoSweetSpot, staff book it by hand on GoSweetSpot's Reprint & Manifests page.
- **Pickup:** Aramex's driver already collects from the Lair. To check on the account: whether GoSweetSpot's
  `bookpickup` takes Aramex, or the pickups are a standing arrangement.

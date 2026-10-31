# Lair API contract v26-gw-pad: Games Workshop's order pad into Shopify

Round 26 (31 Oct 2026). Mo: "how do we tackle the ordered products? Do we add them online? With the same
context?" Every line on GW's weekly ANZ order pad goes into Shopify set up like the live GW listings, and each new pad
keeps the shop in step "in one go" (Mo's brief). The staff page's new Warhammer tab drives it (owner only).

The code: `src/gw-pad.js` (everything below), `src/shopify.js` (`gwShopPage`, `gwUpdate`, `gwCreate`, `gwPublish`,
`gwAddVariants`, `gwFindSkus`, `gwActivate`), `src/lair.js` (routes, tables, maintenance), `src/gw-orders.js` (advance
orders wait for release day). `wrangler.toml` holds the shop's location (`GW_LOCATION_ID`) and the till's sales channel
(`GW_POS_PUBLICATION_ID`). The app's scopes add `write_products`, `write_inventory` and `write_publications`
(`pos-app/shopify.app.toml`); Mo approves them once in Shopify admin. Tests: `test/round26-gw-pad.test.js`.

## What a GW product looks like

As the 56 live GW listings (31 Oct 2026):

- Title: the pad's Description, tidied only: GW's short forms written out as GW writes them ("S/E:" → "Stormcast
  Eternals:", "Hh:" → "Horus Heresy:", "W/" → "with", "O/T" → "of the", "Warhammer 40000" → "Warhammer 40,000"),
  sizes as "(18ml)", "(English)", "Eng",
  "(Uk/Row)" and "Eng/Spa/Port/Lat" left off, "(Pb)" and "(Hb)" as "(Paperback)" and "(Hardback)", small words lower
  case. GW's words are never otherwise changed (Mo's rep: "so long as we don't change the actual words").
- Description: the title, nothing else (`<p>Codex: Orks</p>`). SEO description: "Buy {title} at Dice Goblin in
  Auckland, in store or ordered in from Games Workshop."
- Vendor Games Workshop. Type: Dice & Accessories (Hobby - Play), Paints & Hobby (paints, paint sets such as "Orks +
  Paints", brushes, sprays, tools), else War Game (kits, sets and books).
- Tags: Warhammer; the game (Warhammer 40K, Age of Sigmar, Kill Team, Horus Heresy, The Old World, Necromunda, Legions
  Imperialis, Middle-earth, Blood Bowl, Warhammer Underworlds; Chaos Daemons adds both Age of Sigmar and Warhammer 40K);
  a faction for 40K, Age of Sigmar, Kill Team, Horus Heresy, Necromunda and The Old World (the Race's last part, or the
  one before "Generic"; never a grand alliance); Citadel and Paints for paints, Accessories and Citadel for brushes and
  tools (plus Warhammer Colour or Warhammer Pro by name); a paint set's game and faction with Citadel and Warhammer
  Colour; Black Library for books; Starter sets on starter, introductory and core sets, Combat Patrol and Spearhead
  boxes; New release while the pad dates it. No tag ever has a comma (Shopify splits it in two).
- One variant: SKU the GW code, barcode, NZ MRP as the price, NZ trade (ex GST) as the cost, tracked, stocked at the shop
  with 0, keeps selling at 0 (`CONTINUE`, so round 25 orders it in), `custom.gw_pack_size` when GW's pack is over 1,
  `custom.gw_release_date` when the pad dates it.
- On the till only (Point of Sale). It goes on the website and Shop app once it has GW's picture (a later step).
- A paint in one of the eight ranges (Warhammer Colour Base, Layer, Shade, Contrast, Dry, Technical and Air, and
  Warhammer Pro Tone) is a colour (variant) of its range's product: "Warhammer Colour Base Paints", option Colours (as
  the live "Warhammer Colour Paints" listing), the
  colour's name without the range's short form ("Mephiston Red"), with its size when the range has two sizes
  ("Mordant Earth (24ml)"). The 18 colours already in "Warhammer Colour Paints" stay there for now.

## New releases (GW's trade terms 9.3)

A product whose release date is after today is made as a draft (hidden everywhere, the till too) and goes on sale at
10am NZ on its pre-order day: 7 days before release unless staff move it (`POST /gw/releases/:code`). Maintenance (every
10 minutes) makes it active then. One made in a batch whose answer was lost is kept the same way once it's found by SKU.
When a later pad moves its release date, its on-sale day moves with it (7 days before the new date, whatever staff had
set), at the plan, so it never goes on sale at the old pre-order day. A release made again (the last one was deleted in
Shopify) replaces the old one's record, so the new product is the one that goes on sale. A paint colour still to be released waits for a later pad (`later` in the plan), so it
never shows on its range's product early. Round 25's It's in email, and the shop's list of parcels and pickups, wait for
8am on release day for an order with an advance-order line that's in early (`gw_orderins.release`).

## Routes (owner only: anyone else gets 403)

All answers are JSON; errors are `{ error }` with the words below.

### POST /gw/pad `{ upload, date, part, parts, rows }`

The pad a part at a time, in order (part 1 has no `upload`; every later part sends the one part 1's answer gave). At
most 200 rows a part; the staff page sends 60. `date` is the pad's date (`YYYY-MM-DD`, else today). A part sent again is
kept again. Part 1 clears the last pad and plan.

Part 1 is turned away (409, "Finish updating the shop first: some changes are still on their way to Shopify or the
till. Carry on updating the shop, then add the new pad.") while any change is still with Shopify or made but not yet
on the till, since a new pad clears the plan. Reading the shop again (`restart`) and a new plan are turned away the same
way.

Each row (the pad's Export sheet, header row 4): `{ code (Product Code), desc (Description), system, race, ss (SS Code),
module, release (Release Date: an Excel day number or a date), minstock (Minimum Stock Level), pack (Qty in Pack),
barcode, nz_trade (NZD GST exclusive), nz_mrp (NZ MRP) }`. Kept when the code is 8 to 13 digits, it has an NZ MRP, and
it isn't a shop fitting (Marketing POS, Merchandising POS, Fixtures And Fittings, Sales Support).

→ `{ upload, stored, total, complete }`. The last part fails with 422 when fewer than 500 lines were kept ("That file
has only 120 order pad lines the Lair can use, so it doesn't look like GW's whole order pad. Pick the whole pad.").

### POST /gw/shop `{ restart }`

Reads Shopify's Games Workshop variants, two pages of 100 a request (`restart: true` starts again). → `{ done, count,
wait }`: call again until `done`, waiting `wait` ms first when it's over 0 (Shopify's bucket filling).

### POST /gw/plan

Works out the changes (the pad must be complete, and the shop read after it and after anything applied). → the status
(below). Actions:

- `create`: a product of its own. `range`: a paint colour for its range's product. `later`: a paint colour still to be
  released (not applied).
- `update`: price, cost, barcode, pack size, keep selling at 0, and on a product of its own the release date and the New
  release tag. `changes` has `[was, now]` for each (money in cents).
- `drop`: off the pad and still selling at 0: stops at 0 (what's on the shelf still sells).

### GET /gw, GET /gw/plan?action=create|range|later|update|drop&page=N

The status: `{ pad: { upload, date, part, parts, rows, skipped, at, complete }, shop: { done, startedAt, at }, plan: {
at, upload, date } | null, counts: { create: { todo, sending, publish, done, error }, … }, ranges: [{ key, title,
colours, done, made }], releases: [{ code, title, release, onSale, onSaleAt, error }], left }`. With `action`, also
`lines` (50 a page, errors first: `{ code, action, title, range, price (cents), game, type, release, status, error,
changes }`), `page` and `more`.

### POST /gw/apply

The next batch: a batch Shopify never answered (looked for by SKU after 2 minutes, 40 at a time: found ones only need
to be on the till, the rest go back on the list), then products made but not yet on the till, then updates and stops (20 products),
new products (5), paint colours (a range's product made with 25, then 50 at a time). → `{ done, left, errors: [{ code,
title, error }], wait, busy, summary }`. Call again until `left` is 0, waiting `wait` ms first. `busy` is "Shopify is
busy. Carrying on in a moment." A change Shopify turns down is tried 3 times, then left as an error; a missing
permission says so straight away ("Shopify said no: approve the Lair app's new permissions in Shopify admin (Apps ›
Dice Goblin Lair), then carry on.").

### POST /gw/releases/:code `{ onSale: 'YYYY-MM-DD' }`

The day a hidden release goes on sale (10am NZ), from today up to its release day. → the status.

## Words

Every message is in `PAD_WORDS` (`src/gw-pad.js`), word for word.

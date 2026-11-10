# Lair API contract v34-gw-pictures: GW's pictures on the pad's products, and those products online

Round 34 (10 Nov 2026). Mo: "please create a full product list with images and information for my customers to
order". Round 26 makes every line on GW's order pad a product on the till only, because a GW listing goes online only
with GW's own picture (trade terms 20.3 and 20.5: the trade site's Resources files, whole and uncropped). This round is
that later step. Code: `src/gw-pictures.js`, `src/gw-pictures-data.js`, `src/shopify.js` (`gwPictureTargets`,
`gwAddPictures`, `gwAddVariantPictures`, `gwPictureStatus`, `gwDeleteFiles`), `src/shop-filters.js` (the upkeep runs it).
Tests: `test/round34-gw-pictures.test.js`.

## The pictures

`GW_PICTURES` maps each pad code to the Resources files that show it (paths under
`https://trade.games-workshop.com/assets/`): files named with its code; a repacked kit's files under its short code; a
paint pot by its colour in its range. It's made from the Resources library and the 9 Nov 2026 pad and checked in, so the
Lair never fetches the trade site. A later pad's new lines need it made again.

## What runs

The Durable Object's alarm upkeep (and maintenance every 10 minutes) runs `gwPicturesUpkeep` with what's left of the
invocation's outside calls:

1. Up to 50 codes not looked up yet are looked up in Shopify by SKU. No product yet: `missing`, looked for again a day
   later. A product that already shows a picture (a paint colour: its variant): `had`, left as it is, channels and all.
2. The rest get GW's pictures: a product all its files (up to 20 products a request); a paint range's colours their pot
   on their own variant. `sent`.
3. Two minutes on, Shopify's fetch is checked. A product with a fetched (READY) picture goes on the Online Store and the
   Shop app (`GW_ONLINE_PUBLICATION_ID`, `GW_SHOP_PUBLICATION_ID` in wrangler.toml): `live`. Pictures Shopify couldn't
   fetch are deleted (fileDelete); with none fetched the product stays on the till: `failed`. Still not fetched after 6
   hours: `failed`.

Products are only ever published, never made active: a release still to come stays a draft until round 26 puts it on
sale, so nothing shows before GW's dates.

## GET /gw/pictures (owner: the `warhammer` permission)

`{ codes, counts: { missing, had, sent, live, failed }, failed: [{ code, productId, error }] }` (failed: up to 200).

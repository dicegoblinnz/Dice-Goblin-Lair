# Lair API contract v31-retail: shopping at the Lair

Round 31 (retail and shopping chat), 6 November 2026. From the plan "Retail and shopping: plan" and Mo's picks on the
canvas "Retail and shopping: mockups" (6 Nov 2026, 12:08pm: the Lair card, Tell me plus what's here instead, the whole
week; the rest as drawn), and at 12:10pm: "The part where you said the dice is being shipped from our supplier remove
that I don't want people to know. Best they just know it will take approximately 10 days."

**Changes only**, on top of every contract before it. Money in cents, times in ms (UTC), days in Lair time
(Pacific/Auckland). Errors stay `{ error: "A plain sentence." }` with a 4xx or 5xx. This part covers live step 1: the
wishlist by option and its back-in-stock emails, pickups to pull, and Open a display. Free holds, the empty search and
the weekly email come in later parts.

**The Lair's own stock** is the Dice Goblin location (`LAIR_LOCATION_ID`, else `GW_LOCATION_ID` in wrangler.toml). The
dice the shop's supplier sends (Dice Hoard) are never "on the shelf", and no customer word names the supplier: they're
"Delivered in about 10 days".

New permissions: `read_merchant_managed_fulfillment_orders` and `write_merchant_managed_fulfillment_orders` (pickups:
reading an order's pickup and marking it ready). Each deploy sends them from `pos-app/shopify.app.toml`; Mo approves them
once in Shopify admin (Apps › Dice Goblin Lair). Until then pickups still list and email staff, and Ready to collect says
it can't reach Shopify yet.

## 1. The wishlist by option

Round 16's wishlist keeps the exact option (Mo's plan: "It remembers the sleeve colour or the paint they wanted"). A
member can wish for several options of one product (three paint colours from one range). `src/wishlist.js`; tests
`test/round31-retail.test.js`.

Table `wishlist` gains `variant_id` (`''` for "any option", every row from before) and `variant_title`, and its key
becomes (customer_id, product_id, variant_id): rebuilt once on start when `variant_id` is missing, keeping every row.
`WISHLIST_MAX` (100) counts entries.

| Route | Who | What |
|---|---|---|
| `GET /proxy/me/wishlist` | logged in | `{ items, alerts: { on } }`, items newest first (below) |
| `POST /proxy/me/wishlist` | logged in | `{ productId, variantId?, handle?, title?, variantTitle? }` → `{ ok, added, items, alerts }`. `variantId` as a number, its digits or `gid://shopify/ProductVariant/…`; left out or null is any option. One already on it keeps its place |
| `POST /proxy/me/wishlist/remove` | logged in | `{ productId, variantId? }` → `{ ok, removed, items, alerts }`. With `variantId`, that entry; without, every entry for the product |
| `POST /proxy/me/wishlist/alerts` | logged in | `{ on }` (true or false): My Lair's "Email me when these come back" → `{ ok, alerts: { on } }`. On until they say |

Each item: `{ productId, variantId, handle, title, variantTitle, addedAt, image, price, url, status, shelf, supplier, toldAt }`.
`variantId` is null for any option. From the Lair's last stock check (section 2, at most 10 minutes old): `image` (a
picture's address or null), `price` (cents, or null), `url` (the product's page, with `?variant=` for an option),
`status` and `shelf` (the Lair's count, null when not known). `status` is `shelf` (on the shelf at the Lair: 1 or more),
`out` (sold out), `away` (can be bought but isn't on the shelf: `supplier` true for the dice that are "Delivered in
about 10 days", otherwise Games Workshop's Ordered in), `gone` (no longer sold online) or null (not checked yet).
`toldAt`: when they were last emailed that it's back.

New messages (word for word):
- `variant`: "That option doesn't look right. Refresh the page and try again."
- `alerts`: "Say whether to email you: on or off."

## 2. Back on the shelf

Every 10 minutes the Lair reads the Lair's count of every option on someone's wishlist (any-option entries: every option
of the product), 100 a request, and keeps it in `wish_stock`. An option is **on the shelf** when its count is above 0.
An entry is **back** when its option (any option, for an any-option entry) goes from not on the shelf to on the shelf,
after the entry was made. The first read of an option only records it.

Each time something's back:
- **Regulars** (as Monday's numbers count them: an account and visits in 2 different weeks of the last 4) are emailed
  straight away; **everyone else 24 hours later**, and only if it's still on the shelf then. Sold out again by then:
  they aren't emailed, and wait for the next time. The product shows in stock to everyone straight away; only the email
  waits.
- One email per member per product each time, listing the options that are back. Never a "sold out again" email.
- From 9am to 9pm at the Lair, like the Lair's other emails; anything due overnight goes at 9am. At most 100 a run.
- Not sent to: a member who switched it off in My Lair; an email on the Lair's stop list ("Don't send me emails like
  this", round 29's `followup_stops`) at or after the entry was made; an email Shopify has as unsubscribed at or after
  the entry was made, or invalid or redacted; a product no longer sold online. An entry made after an unsubscribe is
  fresh consent to that alert (the emails skill: "nothing commercial goes after it, including … an alert given before
  it").
- After it goes, the entry stays on the wishlist (`toldAt`), and a later return tells them again.

The email (canvas T-email; Gobgob signs it). `label` is the option's name when the product has several options and the
name isn't a pack size (Booster Box, Booster Pack, Pack, Box, Display, Bundle, Single, Case), otherwise the product's
title.
- Subject: "`label` is back on the shelf", or "Back on the shelf: `label`" cut at 50 characters on a word.
- Preview: "`product title`, `$price`. You're hearing a day before everyone else." (a regular), or "`product title`,
  `$price`. On the shelf at the Lair now."
- Heading "`label` is back", then "You asked Gobgob to keep an eye out. It's back on the shelf at the Lair." ("These are
  back" for several options).
- One card per option: "`product title`: `option`" (the option left off a product with one), and "`$price` · On the
  shelf at the Lair", or "Only `n` left at the Lair" from 1 to 3 (true when it's sent).
- A regular's quote: "You're a regular, so you're hearing first. Everyone else hears tomorrow."
- Button: "Buy it online" (the product's page), and the line "Collect it free at the Lair, or have it delivered for $10."
  Free holds (a later part) change this to "Hold it free" and "Or buy online and collect it".
- Details: Open today (today's hours, or Closed today), Where ("Upstairs in Royal Oak Mall, above Whitcoulls").
- "See you at the Lair!" and "Gobgob, the Dice Goblin"; the footer; "You're getting this because `label` is on your
  wishlist." and "Don't send me emails like this".

Links carry `utm_source=back-in-stock&utm_medium=email&utm_campaign=shop`. The unsubscribe works like round 29's: the
link is `/pages/my-lair#unsubscribe=WISH-<id>.<key>` (My Lair's existing handler asks `POST /unsubscribe/view` and stops
only on the tap, `POST /unsubscribe/stop`), and the one-click header points at the Lair's own
`/unsubscribe/WISH-<id>/<key>`. Both put the email on the stop list (so Shopify hears, as round 29) and switch that
member's wishlist emails off.

## 3. Pickups to pull

A paid online order collected at the Lair (its shipping line is a pickup) becomes a pickup for staff to pull, from the
order's paid webhook and from a 10-minute look at the last 3 days' pickup orders (one the webhook missed). `src/pickups.js`.

- **Promised by:** 2 hours of opening time after it was paid (paid at 11pm on a Friday: 11am Saturday). Shopify's own
  pickup time moves from 24 hours to 2 hours when this goes live.
- **Staff hear:** the staff page's To pull list, the counter tile, and one email to the shop (`STAFF_EMAIL`): "Pickup
  #2031 to pull: `what`".
- **Ready to collect:** staff pull it, put it behind the counter and tap Ready to collect. Shopify marks it prepared for
  pickup and sends its own ready-for-pickup email.
- **Not on the shelf:** the customer is emailed straight away that it isn't, and that it's being refunded to their card;
  the Lair's count of what's missing goes to 0; and staff see Refund due until they tap Done after refunding in Shopify.
- **Reminders** to the customer 3 and 10 days after Ready (9am to 9pm). At 14 days staff see Refund due (and get one
  email): the refund goes to their card, or store credit if they ask.
- **Collected:** once Shopify shows the order fulfilled (staff mark it picked up), it leaves the list by itself.

| Route | Who | What |
|---|---|---|
| `GET /proxy/staff/pull` | staff with Check-in | `{ pickups, newest }`: open pickups, newest first: `{ orderId, name, customer, items: [{ lineId, title, variantTitle, quantity }], paidAt, dueAt, status, readyAt, missing: [lineId], refundDue, waiting }`. `status`: `new`, `ready` or `missing`. `customer` is "Sam K.". `waiting`: whole days since Ready. `newest`: the newest paidAt (the page chimes when it grows) |
| `POST /proxy/staff/pull/ready` | Check-in | `{ orderId }` → `{ ok, pickup }` |
| `POST /proxy/staff/pull/missing` | Check-in | `{ orderId, lineIds? }` (all lines when left out) → `{ ok, pickup }` |
| `POST /proxy/staff/pull/done` | Check-in | `{ orderId }`: refunded or sorted → `{ ok }` |

Customer emails (transactional: about their own order; no unsubscribe):
- Reminder, day 3: subject "Your order `#2031` is waiting at the Lair"; day 10: "Last reminder: your order `#2031` is at
  the Lair". "Gobgob is guarding your order behind the counter. Come and grab it whenever we're open." Details: Order,
  What, Open today, Where, Kept until (14 days after Ready: "then it's refunded to your card"). Button: "Get directions".
- Not on the shelf: subject "Sorry, part of your order `#2031` isn't here" ("Sorry, your order `#2031` isn't here" for
  all of it). "We went to pull your order and `what` wasn't on the shelf. Our count was wrong, and that's on us." Then
  "We're refunding `$amount` to your card. Shopify emails you when it's done." (and "The rest of your order is still
  ready to collect." when some is). Signed "Sorry again, Gobgob, the Dice Goblin".

## 4. Open a display

On the staff page (Check-in): pick a product, say how many boxes, and the Lair takes the boxes off and puts their packs
on in one go, at the Lair's location, in Shopify. The packs in a box are remembered for each product. `src/displays.js`.

| Route | Who | What |
|---|---|---|
| `GET /proxy/staff/displays?q=` | Check-in | Products whose title has the words, with two or more options: `{ products: [{ productId, title, variants: [{ variantId, title, shelf }], remembered: { boxVariantId, packVariantId, packs } or null }] }` (at most 20) |
| `POST /proxy/staff/displays/open` | Check-in | `{ productId, boxVariantId, packVariantId, boxes, packs, key }` → `{ ok, open: { id, box: { before, after }, pack: { before, after } }, repeated? }`. `boxes` 1 to 10, `packs` 1 to 100, `key` 8 to 64 letters, numbers, `-` or `_` (the same key never changes stock twice) |
| `POST /proxy/staff/displays/undo` | Check-in | `{ id }`: within 24 hours, once → `{ ok, undone }` |

Messages (word for word):
- `pick`: "Pick the box you're opening and the packs it holds."
- `same`: "The box and the packs need to be different options."
- `boxes`: "Open between 1 and 10 boxes at a time."
- `packs`: "A box holds between 1 and 100 packs."
- `noBox`: (n) "Shopify has `n` of that box on the shelf. Count them, then fix the count in Shopify first."
- `undoLate`: "That was more than a day ago. Change the counts in Shopify instead."
- `shopify`: "Shopify didn't take it. Nothing changed. Try again in a minute."

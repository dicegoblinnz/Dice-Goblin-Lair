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
| `POST /proxy/me/wishlist` | logged in | `{ productId, variantId?, handle?, title?, variantTitle?, tell? }` → `{ ok, added, items, alerts }`. `variantId` as a number, its digits or `gid://shopify/ProductVariant/…`; left out or null is any option. One already on it keeps its place. `tell: true` is Tell me when it's back: a request for that option's email (`asked_at`, now), sent even while My Lair's switch is off, and after an unsubscribe that came before it |
| `POST /proxy/me/wishlist/remove` | logged in | `{ productId, variantId? }` → `{ ok, removed, items, alerts }`. With `variantId`, that entry; without, every entry for the product |
| `POST /proxy/me/wishlist/alerts` | logged in | `{ on }` (true or false): My Lair's "Email me when these come back" → `{ ok, alerts: { on } }`. On until they say |

Each item: `{ productId, variantId, handle, title, variantTitle, addedAt, image, price, url, status, shelf, supplier, toldAt, emails }`.
`variantId` is null for any option. From the Lair's last stock check (section 2, at most 10 minutes old): `image` (a
picture's address or null), `price` (cents, or null), `url` (the product's page, with `?variant=` for an option),
`status` and `shelf` (the Lair's count, null when not known). `status` is `shelf` (on the shelf at the Lair: 1 or more),
`out` (sold out), `away` (can be bought but isn't on the shelf: `supplier` true for the dice that are "Delivered in
about 10 days", otherwise Games Workshop's Ordered in), `gone` (no longer sold online) or null (not checked yet).
`toldAt`: when they were last emailed that it's back. `emails`: whether an email goes when it's back, by the sender's
own rules: the switch on, or Tell me when it's back since it went off, and no unsubscribe since the wish or the ask (My
Lair says "We'll email you" only then, and a product page's Tell me shows "We'll email you when it's back" only then).

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
- Not sent to: a member who switched it off in My Lair (except for options they asked about with Tell me when it's back
  since, which go on their own); an email on the Lair's stop list ("Don't send me emails like
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
| `GET /proxy/staff/pull` | staff with Check-in | `{ pickups, newest }`: open pickups, newest first: `{ orderId, name, customer, items: [{ lineId, title, variantTitle, quantity }], paidAt, dueAt, status, readyAt, missing: [lineId], refundDue, waiting, reminded }`. `status`: `new`, `ready` or `missing`. `customer` is "Sam K.". `waiting`: whole days since Ready. `reminded`: reminder emails sent (0 to 2). `newest`: the newest paidAt (the page chimes when it grows) |
| `POST /proxy/staff/pull/ready` | Check-in | `{ orderId }` → `{ ok, pickup }`. Only one still to pull (`new`): Ready or Refund due is a 409 |
| `POST /proxy/staff/pull/missing` | Check-in | `{ orderId, lineIds? }` (all lines when left out) → `{ ok, pickup, warning? }`. Lines already marked are left as they are (no second email); lines marked but not yet told (a tap cut short) are finished by the next tap; a tap while another is on its way answers as things stand. `warning` when Shopify didn't take the count of 0 |
| `POST /proxy/staff/pull/done` | Check-in | `{ orderId }`: refunded or sorted → `{ ok }`. While Not on the shelf is still on its way: 409, "Someone's marking that pickup right now. Try again in a moment." |
| `GET /pos/today` (the counter tablet) | POS token | also `toPull`: how many are still to pull. A number only: the tablet faces customers (round 30), so it never gets names or orders. The tile adds "· 1 to pull" ("1 online order to pull" with no bookings) |

Customer emails (transactional: about their own order; no unsubscribe):
- Reminder, day 3: subject "Your order `#2031` is waiting at the Lair"; day 10: "Last reminder: your order `#2031` is at
  the Lair". "Gobgob is guarding your order behind the counter. Come and grab it whenever we're open." Details: Order,
  What, Open today, Where, Kept until (14 days after Ready: "then it's refunded to your card"). Button: "Get directions".
- Not on the shelf: subject "Sorry, part of your order `#2031` isn't here" ("Sorry, your order `#2031` isn't here" for
  all of it). "We went to pull your order and `what` wasn't on the shelf. Our count was wrong, and that's on us." Then
  "We're refunding `$amount` to your card. Shopify emails you when it's done." (and "The rest of your order is still
  ready to collect." when some is). Signed "Sorry again, Gobgob, the Dice Goblin". The amount is what was paid for those
  lines after every discount (Shopify's discountedUnitPriceAfterAllDiscounts).
- Staff, when Shopify didn't take the count of 0 (`warning`): "Shopify didn't take the new count. Set `what` to 0 in
  Shopify yourself, so the website stops selling it." The customer has still been told.

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
- `keyUsed`: "That tap was already used for a different opening. Refresh the page, then try again." (the same key with
  other numbers; the same key with the same numbers answers with that opening, `repeated: true`)
- `busy`: "Someone's opening or putting back that one right now. Try again in a moment." (one opening or undo of a
  product at a time)

## 5. Free holds (step 2)

Hold something on the shelf free and pay at the counter (Mo's picks of 6 Nov 2026: the hold sheet, My Lair's holds and
the cases a hold can't happen, as drawn; the rules from the Decision log of 1 Nov 2026). `src/shop-holds.js` (library
holds are a different thing, at `/library/holds`).

- **Who and how many:** members (logged in), up to 3 open at a time, one of each option, and at most 10 made in 24 hours
  (cancelled ones count too, so holding and cancelling can't run on).
- **Until:** closing time of the first opening that starts after it's made (made Friday evening: midnight Saturday;
  made Saturday before 10am: midnight Saturday; made during Saturday: 10pm Sunday).
- **Not on:** a trading card (product type Trading Card Games) or Games Workshop product in its first 7 days after it
  went on the site; a product tagged `no-holds` (staff switch holds off with the tag); anything not sold online, a gift
  card, or untracked stock; nothing on the shelf at the Lair (by the Lair's own count: the supplier's dice only when the
  Lair has some).
- **Only once the live theme says** (Theme settings › Wishlist › Free holds and Tell us what you're after, `retail_holds`;
  the same switch shows the empty search's box, section 6).
- **Off sale while held:** a draft order for the member (tagged `lair-hold`) reserves the stock until the hold ends
  (`reserveInventoryUntil`), and is deleted when the hold ends, is cancelled or is collected; a deletion Shopify didn't
  take is tried again every 10 minutes.
- **Collected** when staff say so (the staff page's Collected, or the counter tablet's Add to the sale after scanning
  their code), or when a paid order at the counter (Shopify POS or Pay on Verifone; never the online store, the Shop
  app, another sales channel or a draft order) has the member on it and that option.
- **Not collected in time:** it ends; one set aside shows on To pull for staff to put back. After 2 holds that weren't
  collected (since staff last switched them back on), the member's holds pause until staff switch them back on.
- **Staff hear** each new one on To pull (with the chime) and by email: "Hold to set aside: `what` (`Ana P.`)", "`Ana P.`
  is holding it free until `midnight Saturday 7 November`, to pay at the counter. Set it aside behind the counter and tap
  Set aside on the staff page." The counter tablet's `toPull` counts holds still to set aside too.

| Route | Who | What |
|---|---|---|
| `GET /proxy/me/shop-holds` | logged in | `{ holds, max, paused }`: open holds soonest first, `{ id, productId, variantId, title, variantTitle, handle, image, price, quantity, until, madeAt, set, url }` |
| `POST /proxy/me/shop-holds` | logged in | `{ productId, variantId }` → `{ ok: true, hold, holds, max, paused }`, or `{ ok: false, cant, message, holds, max, paused, startsAt? }`. `cant`: `off`, `full`, `paused`, `many`, `already`, `busy`, `product`, `noHolds`, `notShelf`, `release` (with `startsAt`), `gone`. 401 logged out; 502 when Shopify didn't answer (nothing held) |
| `POST /proxy/me/shop-holds/cancel` | logged in, their own | `{ id }` → `{ ok, holds, max, paused }` |
| `GET /proxy/staff/pull` | Check-in | also `holds`: open ones and ones to put back, `{ id, customer, customerId, title, variantTitle, quantity, price, madeAt, until, status, putBack, closedHow }`; and `paused`: `[{ customerId, customer, misses }]` |
| `POST /proxy/staff/shop-holds/set` | Check-in | `{ id }`: set aside behind the counter → `{ ok, hold }` (409 when it isn't new) |
| `POST /proxy/staff/shop-holds/collected` | Check-in | `{ id }` → `{ ok }` |
| `POST /proxy/staff/shop-holds/missing` | Check-in | `{ id }`: not on the shelf after all → `{ ok, warning? }`. Closed, the stock let go, the Lair's count set to 0, and the member emailed |
| `POST /proxy/staff/shop-holds/done` | Check-in | `{ id }`: put back on the shelf → `{ ok }` |
| `POST /proxy/staff/shop-holds/resume` | Check-in | `{ customerId }`: a paused member's holds back on → `{ ok }` |
| `POST /pos/scan` (the counter tablet) | POS token | a member's code also gives `holds`: their open holds, soonest first, `{ id, productId, variantId, title, variantTitle, price, quantity, until, set }`. Only theirs: it's their own code |
| `POST /pos/shop-holds/collect` | POS token | `{ id, customerId }`: Add to the sale. Collected, and its stock let go before the answer (so the till doesn't ask about stock) → `{ ok, hold: { id, variantId, productId, quantity, title, variantTitle, price }, holds }`. Not that member's, or not open (a second tap): 404 |

Words (word for word): `login` "Log in to hold it."; `off` "Free holds aren't on yet."; `full` "You're holding `n` things
already. Collect one, or cancel one in My Lair, to hold this."; `paused` "Free holds are paused on your account, because 2
holds weren't collected. Ask at the counter and staff can switch them back on."; `gone` "Someone grabbed the last one a
moment ago. Gobgob can tell you when it's back."; `release` "Free holds start `Thursday 12 November`. New card releases
skip holds in their first week, so everyone gets a fair go."; `noHolds` "This one can't be held. You can still buy it
online and collect it free."; `notShelf` "It isn't on the shelf at the Lair, so it can't be held."; `already` "You're
holding this one already. It's in My Lair."; `busy` "Someone else is holding that one right now. Try again in a moment.";
`many` "That's 10 holds today, the most for one day. You can hold more tomorrow."

The member's email when it isn't on the shelf (transactional, about their own hold): subject "Sorry, your hold isn't on
the shelf"; "We went to set aside `what` for you, and it wasn't on the shelf. Our count was wrong, and that's on us."
"Your hold's cancelled, so there's nothing to pay." Signed "Sorry again, Gobgob, the Dice Goblin".

## 6. Tell us what you're after (step 2)

An empty search offers a short box (Mo's pick of 6 Nov 2026, the empty search, as drawn). `src/shop-requests.js`.

| Route | Who | What |
|---|---|---|
| `POST /proxy/requests` | anyone | `{ text, email?, query?, website? }` → `{ ok, message }`. `text` up to 200 characters; `email` optional, to hear back; `website` is the field people never see (a bot's is thanked and dropped). At most 5 an hour from one address, 200 a day in all (429) |
| `GET /proxy/staff/requests` | Check-in | `{ requests: [{ id, text, query, email, member, madeAt, done }], waiting }`: the last 60 days', new first |
| `POST /proxy/staff/requests/done` | Check-in | `{ id }` → `{ ok }` |

Requests are deleted 180 days after they're made. Words: `text` "Say what you're after, in a few words."; `long` "Keep
it to 200 characters or fewer."; `email` "That email doesn't look right. Leave it out if you'd rather not hear back.";
`tooMany` "That's a lot of asks in a row. Try again in a little while, or tell us at the counter."; `thanks` "Thanks!
Staff read every one at the counter."; `thanksEmail` "Thanks! Staff read every one at the counter, and we'll email you if
we can get it in."

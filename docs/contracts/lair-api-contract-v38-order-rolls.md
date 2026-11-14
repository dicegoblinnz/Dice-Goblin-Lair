# Lair API contract v38: d20 rolls on online orders, and a second order in the same parcel

Round 38. Mo (14 Nov 2026), settling the shop's deals in the price-check playbook: "The $200 spend is online only no
in-store correlation", "magic boxes always give a dice per $100 sold and anything else will be $200 normally and $100
if it was a special season thing", "The $200 is for a transaction not a running total", "they get the dice after
purchase. And credit is immediately in Thier account", "I reckon the $200 meter should be on the order [...] shows a
running total there for people to see and realize that they can buy more for the extra prize", and "give them the
ability to buy more products within the hour to add the items inside the same package if they chose to. To save on
shipping again. Reason is if they got the dice and wanted to use it straight away they can buy something else and ship
it at the same time".

`src/order-rolls.js`, with its part in `src/lair.js` (ordersPaid, loyaltyOf, the 10-minute run), `src/core.js`
(the theme's settings) and `src/shopify.js` (the parcel code); tests `test/round38-order-rolls.test.js`. The theme's
side is section 6.

## 1. The rule

- **Online orders only.** A paid order earns rolls when it's from the website or another online channel: never a
  counter sale (Shopify POS, the Lair's till, Pay on Verifone), never a draft order (the Lair's own checkouts and bills,
  and orders staff make in Shopify admin; an order with no source at all is taken as one, as ordersPaid does), never a
  subscription's own billing (a library membership's month, a damage charge on its card), and only with a customer on
  it. A pickup order is an online order.
- **Each order on its own.** Nothing carries over from one order to the next.
- **A roll for every $200** of what the order's products cost after their discounts (each line's price times its
  quantity, less what discounts took off it; a free die is $0). Delivery, gift cards and library damage charges don't
  count: what a gift card later pays for does. How it's paid doesn't matter (store credit, card).
- **Magic booster boxes count double** (Mo: they "trigger the special $100"), so a roll for every $100 of them while the
  setting is $200, and for every half of whatever it's set to: Wizards of the Coast's products whose variant is
  a box of boosters ("Box", "Booster Box", "Collector Box", "Play Booster Box" …), or with no variants of their own,
  titled one. Never a scene box, bundle, Commander deck, Draft Night or pack, and never another game's boxes (Mo: "Don't
  do that with any other game, only magic the gathering").
- **Double days**: on the days in the theme's setting, every dollar counts double, Magic boxes too (twice, never four
  times). The day is the shop's (Pacific/Auckland), on when Shopify says the order was paid.
- Mixed orders add up: a $380 box and $50 of dice is 760 + 50 = $810 of $200s, 4 rolls.
- At most **50 rolls an order** (a guard against a mistake, not one of Mo's rules).
- **The rolls are the loyalty card's**: they're in My Lair the moment the payment lands, and each is rolled there, the
  d20's face in store credit ($1 to $20) or the sure $10, exactly as a full card's. GET /me's `loyalty.rolls.earned`
  has `orders` once a member has some (it isn't there before, so a card from before reads as it did).
- **Once per order**: Shopify sending orders/paid again changes nothing.
- **Refunds**: nothing is taken back by itself. A refunded order's rolls, or the credit they became, are staff's to
  sort on the member's page, as with any refund now. (`order_rolls.status` is there for a later round.)

## 2. The theme's settings (Theme settings › Lair bookings)

| Setting | What it is |
| --- | --- |
| `lair_order_rolls` | checkbox, "d20 rolls on online orders": on only when the live theme says `true`, so a Lair deployed before its theme gives none, and Mo switches the whole thing on in one place |
| `lair_rolls_every` | number, "A d20 roll for every ($)": 200, rounded to whole dollars as the cart rounds it (150.5 is 151); empty, or under $1 once rounded, means 200 |
| `lair_rolls_double_days` | text, "Double days": days or ranges in NZ dates, split by commas, semicolons or new lines, `2026-11-27 to 2026-11-30, 2026-12-26` (also `..`, `–` or `-`, with or without spaces, in any case). A part that isn't one, or has a date that isn't real (2026-02-30), is left out, and only the first 50 count. The cart reads them the same way (snippets/roll-meter.liquid), checked against `parseDoubleDays` by tools/qa/round38-order-rolls/theme.mjs |

The Lair reads them every 5 minutes with the other booking rules (`rules.rolls: { on, every, doubleDays }`).

## 3. Gobgob's email

Once the rolls are kept, in the background (the 10-minute run finishes one a restart cut short, within 2 hours), to the
member's email, or Shopify's for the customer. Once: marked before it goes. `ORDER_ROLL_EMAILS` = `off` (config) stops
it, and with it the parcel code (the email is the only place it's told).

- Subject: `A d20 roll for your order #1550` / `3 d20 rolls for your order #1550`.
- Title: `A d20 roll, waiting in My Lair` / `3 d20 rolls, waiting in My Lair`.
- `Kia ora Mia, thanks for your order #1550. It earned 3 d20 rolls.`
- `Roll each one in My Lair and the number lands in your store credit straight away, $1 to $20. Or take a sure $10
  instead.` (one roll: `Roll it in My Lair …`)
- A posted order with its parcel code: `Want to spend it now? Order again before 2:05pm and it goes in the same parcel
  as #1550, with no extra delivery.` and the link `Add to this parcel`.
- Button: `Roll them in My Lair` (one: `Roll it in My Lair`), to My Lair. Signed as every Lair email.

## 4. The same parcel

- A **posted** order that earned rolls (its shipping line isn't a pickup) gets a code for an hour from when it was paid:
  `PARCEL-` and 6 of `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, from crypto. In Shopify it's a free-shipping code titled `Same
  parcel as #1550`, only that customer's, one use, any delivery, alongside the shop's product and order discounts. The
  email's link applies it (`/discount/PARCEL-…?redirect=/collections/all`).
- No code with less than 10 minutes of the hour left (a late webhook), for a pickup, for an email that isn't going, or
  for an order that itself used a parcel code. Tried once.
- A paid order (online, any amount) with one of those codes, used by the same customer: both orders get the tag `Same
  parcel` and a line on their note (`Same parcel as #1550: pack the two together.` and `#1551 goes in the same parcel
  as this one: pack the two together.`), once. Shopify refusing is noted and the 10-minute run tries again for a day.
  Needs `write_orders` (as round 25) and `write_discounts` (as the birthday codes).
- The second order earns its own rolls as any order.

## 4b. Refunds

Mo, 15 Nov 2026: "The credit they gave is removed and if it was used to buy something nothing we can do about it. But
ultimately the dice gets removed if refunded. And if it was used for credit that credit is removed instead."

- The 10-minute run asks Shopify about orders with rolls left, paid in the last 60 days (Shopify's window for the
  app's orders), each at most every 30 minutes, up to 100 a run: a cheap look at which have money back or are
  cancelled, then those orders' lines as they stand (`currentQuantity`).
- The order is counted again on what's left of it, with the roll size and double day it was paid on (`every_cents`,
  `doubled`): the refunded lines' share comes off the points it was counted on, so an order nothing came back from
  keeps its rolls exactly. A cancelled order keeps none. A refund of an amount with no items in it changes nothing.
- The rolls it no longer earns come off the loyalty card. Rolls not rolled yet go first. If the card has fewer left
  than that, the rest were rolled: the newest loyalty rolls made since the order was paid are taken back, and the
  store credit they gave comes off their account, as much as is still there, never more (spent credit stays spent).
  A prize still waiting to be given at the counter is no longer to give (`prizes.status` `taken back`). A roll taken
  back stops counting as used, so it never eats into the card's later rolls.
- The store credit is taken once: claimed before Shopify is asked. Shopify saying no is tried again by the 10-minute
  run, 3 times, then staff are emailed ("Store credit to take back by hand"); no answer at all may have gone through,
  so staff are emailed at once and it's never tried again. Nor is one the Lair stopped in the middle of
  (`debiting_at` still set): staff check it by hand.
- A roll taken back while Shopify is still adding its credit (the refund lands mid-roll): when the credit lands,
  `roll()` hands it to a take-back of its own (`midway`), which takes back that credit and only that, with its own line
  on the order (`Refund: a d20 roll taken back as it was being rolled. …`). Staff aren't asked to give its prize.
- My Lair's history of rolls leaves out the ones taken back.
- The order is tagged `Rolls taken back` with a line on its note: `Refund: 2 d20 rolls taken back (1 rolled already).
  $15.00 of the store credit it gave was taken back.` (or `…; the rest was spent.`, or `The $15.00 store credit it
  gave was spent, so none was taken back.`, or `Refund: a d20 roll taken back, not rolled yet.`).
- An order refunded before its email goes gets none; one partly refunded is told the rolls it still earns.

## 4c. New Commander decks join the free sleeves deal

Mo, 15 Nov 2026, told that a new Commander deck had to go into Shopify's discount by hand: "Yes make a lair app to add
them automatically". `src/commander-deal.js`, tests `test/round38-commander-deal.test.js`.

- The deal is Shopify's automatic discount "Free sleeves with a Commander deck" (Buy X get Y: each Commander deck makes
  one pack from the Card sleeves collection free, every time). The Lair finds it by the theme's title (Theme settings ›
  Commander decks › Discount title, `deck_sleeves_discount`; empty is that title), matched exactly as the cart matches
  it, among the live and scheduled automatic Buy X get Y discounts: at most two (one live, one to follow).
- Once an hour, while the live theme says Commander decks come with free sleeves (`deck_sleeves_show`), the 10-minute
  run asks Shopify, in one search, for the products and options with Commander in their titles (Wizards of the Coast's;
  products not archived), works out which are decks by section 6's rule (a product counts whole, every option; else an
  option counts alone), and adds the ones each deal is missing, with its Customer buys quantity sent back as it was. The
  setup check (`/setup`) looks straight away. With fewer than 5 of the run's outside calls left (Cloudflare's free plan:
  50 an invocation) it waits for the next run. The hour is claimed before Shopify is asked, so a failure tries again
  in an hour, not every 10 minutes.
- It only ever adds. Nothing comes out of a deal: a deck renamed or archived, anything staff put in by hand. An option
  whose whole product is in the deal isn't added on its own. A product or option that was in a deal when the Lair
  looked (or that the Lair put in), and isn't now, was taken out in Shopify by hand, and stays out. A new deal with the
  same title (made again) starts afresh.
- Staff are emailed what was added ("New Commander decks in the free sleeves deal": each deck, "Every option" or the
  option's name), so one that shouldn't count is caught; taking it out of the discount in Shopify keeps it out. And
  once, until it works again, when the deal can't be kept: no live discount with that title while the theme still
  says decks come with free sleeves ("Free sleeves: the deal is missing in Shopify"), Customer buys that's a
  collection rather than products ("Free sleeves: new decks can't go in"), more than 250 products or options to read
  ("Free sleeves: the deal's too long to check"), or Shopify saying no ("Free sleeves: Shopify said no to new decks",
  with its words and the decks; tried again every hour).
- Tried on a throwaway discount (scheduled for 2030, then deleted) on 15 Nov 2026: adding keeps what's there, and
  adding one that's there already, or an option of a product that's in whole, is no error.

## 5. Data

`order_rolls`: one row per order that earned rolls: `order_id` (key), `customer_id`, `order_name`, `counted` and
`boxes` (cents), `doubled`, `rolls`, `paid_at`, `created_at`, `parcel_ok`, `parcel_code` (unique), `parcel_ends`,
`parcel_tried_at`, `parcel_order_id`, `parcel_order_name`, `parcel_tagged_at`, `emailed_at`, `follow_at` (the email's
follow-up under way: another run leaves it alone for 5 minutes, so the 10-minute run never sends it without its parcel),
`status` (`active`), `every_cents` (the roll size it was counted on), `taken_back` (rolls refunds took back) and
`refund_checked_at`.
`roll_takebacks`: one row per refund that took rolls back: `id`, `order_id`, `customer_id`, `order_name`, `rolls`,
`unrolled`, `rolled`, `credit_asked` and `credit_taken` (cents), `status` (`credit`, `done` or `check`), `tries`,
`note`, `claimed_at`, `noted_at`, `debiting_at` (while Shopify is asked) and `midway`. `member_rolls` gains
`taken_back_at` and `taken_back_id`.
`commander_deal_items` (section 4c): `discount_id` and `item_id` (a product's or option's Shopify id; together the key),
`title` (the decks the Lair added), `seen_at` and `added_at`. `meta` keys `commander-deal-at` (the last look) and
`commander-deal-state` (`ok`, `missing`, `collections`, `too-many` or `refused`: what staff were last told).
ordersPaid's answer adds `orderRolls: { rolls?, parcel? }`; the 10-minute run's `orderRolls: { emails, tags, takenBack? }`
and, the hours it looks, `commanderDeal: { deals, added, problem? }`.
Needs `read_store_credit_accounts` and `write_store_credit_account_transactions` (as round 9's staff page) for the
store credit, and `write_orders` for the order's line. The free sleeves deal needs `read_products` and `write_discounts`
(both granted already).

## 6. The theme's side

- The three settings above, in Lair bookings.
- The cart (drawer and page) shows the running total when `lair_order_rolls` is on: the rolls the cart has earned so far
  and how much more for the next, worked out the same way (Magic boxes double, double days double), with a line saying
  Magic boxes count double when there's one in the cart. It's the cart's figure; the order's own is what counts.
- Badges on the deal items: Magic booster boxes (the roll per $100), and the shop's own deals (the dice deal, free
  sleeves with Commander decks), on product cards and pages. A Commander deck is Wizards of the Coast's, not a library
  copy, with "Commander Deck" (or Decks) in its variant's or product's title, or a product title ending in "Commander"
  (MTG - Super Heroes - Commander); a Commander's Bundle isn't one. The automatic discount's decks are the same list, and
  new ones go into it by themselves (section 4c).
- The cart's bars (the free-shipping bar and the roll meter) each grow from their own last amount when the cart
  redraws: each fill has `data-cart-bar`.
- My Lair's card already shows rolls to use; nothing else changes there.

## 7. Going live

The Lair can go live first: nothing happens until the live theme has the settings and `lair_order_rolls` is ticked.
Then the theme's part goes live and Mo ticks the box (and sets the double days, Black Friday's 27 to 30 November first).

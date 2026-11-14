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
| `lair_rolls_every` | number, "A d20 roll for every ($)": 200; empty or not a positive number means 200 |
| `lair_rolls_double_days` | text, "Double days": days or ranges in NZ dates, split by commas, `2026-11-27 to 2026-11-30, 2026-12-26` (also `..`). A part that isn't one is left out |

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

## 5. Data

`order_rolls`: one row per order that earned rolls: `order_id` (key), `customer_id`, `order_name`, `counted` and
`boxes` (cents), `doubled`, `rolls`, `paid_at`, `created_at`, `parcel_ok`, `parcel_code` (unique), `parcel_ends`,
`parcel_tried_at`, `parcel_order_id`, `parcel_order_name`, `parcel_tagged_at`, `emailed_at`, `follow_at` (the email's
follow-up under way: another run leaves it alone for 5 minutes, so the 10-minute run never sends it without its parcel),
`status` (`active`).
ordersPaid's answer adds `orderRolls: { rolls?, parcel? }`; the 10-minute run's `orderRolls: { emails, tags }`.

## 6. The theme's side

- The three settings above, in Lair bookings.
- The cart (drawer and page) shows the running total when `lair_order_rolls` is on: the rolls the cart has earned so far
  and how much more for the next, worked out the same way (Magic boxes double, double days double), with a line saying
  Magic boxes count double when there's one in the cart. It's the cart's figure; the order's own is what counts.
- Badges on the deal items: Magic booster boxes (the roll per $100), and the shop's own deals (the dice deal, free
  sleeves with Commander decks), on product cards and pages.
- My Lair's card already shows rolls to use; nothing else changes there.

## 7. Going live

The Lair can go live first: nothing happens until the live theme has the settings and `lair_order_rolls` is ticked.
Then the theme's part goes live and Mo ticks the box (and sets the double days, Black Friday's 27 to 30 November first).

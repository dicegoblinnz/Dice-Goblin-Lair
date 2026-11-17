# Lair API contract v44: library copies bought online are held (round 44)

From the website review of 17 November 2026: library copies (products whose title ends "(Library)" and that carry the
metafield `custom.library_code`) are on the Online Store, so anyone with a cart link can buy one, and 163 of them are
still $0. Members may buy a library copy they've borrowed, at 20% off, from My Library (Mo, 2 November 2026, decided
and not built yet). Any other online order with a library copy in it must never be posted out or handed over by mistake.

Nothing here changes Shopify's products, prices or channels: it catches the order once it's paid.

## 1. Which orders are held

On every paid order (the `orders/paid` webhook, `ordersPaid` in `src/lair.js` calling `libraryHoldPaid` in
`src/library-hold.js`) that wasn't rung up at the counter (`counterSale`: Shopify POS, the Lair's till, Pay on Verifone).
Web orders and draft orders (made in Shopify admin or by the Lair) are both looked at. A counter sale is staff handing a
game over in person, and the till already refuses library codes.

**A library copy** is a line whose product's title ends "(Library)" and has `custom.library_code`, as Shopify says now
(`libraryProducts`, read_products). Only lines with a product are asked about: a line whose title ends "(Library)" or
whose variant the Lair knows as a library game (`library_games`). The Lair's own postal swap checkout is a custom line
("Library swap: …") with no product, so it's never one. If Shopify can't answer, every line asked about counts as a
library copy: holding by mistake costs a click, posting by mistake costs a game.

**A member's own My Library purchase** is the only library copy that isn't held: the order's customer (as Shopify has
the order, `orderSpend`) has that game at home on loan in the Lair (`library_loans`, status `out`, the same variant), at
least as many copies as the order has of it, and each one was paid for (over $0 after its discounts). It's worked out
from what the Lair knows, never from anything on the order or the cart, so a cart link can't pass for one. The My
Library button that sells it at 20% off isn't built yet; whatever way it checks out, this rule needs nothing from it.

**A $0 library copy is always held**, even for the member who has it at home: its price is $0, or its discounts take it
to $0.

An order is held once, whatever its library copies (one row a order in `library_order_holds`; a webhook sent again does
nothing more).

## 2. What the Lair does with a held order

All in the background, once the order is kept; the webhook's answer gains `libraryHold: { lines }` (the number of
library copy lines held).

1. **Shopify's fulfilment hold** on each of the order's fulfilment orders that can be held (`supportedActions` has
   `HOLD`): reason `OTHER`, handle `lair-library-copy`, the note below as its reason notes, `notifyMerchant` false (the
   Lair's own email tells staff). Shopify then shows the order as On hold and it can't be fulfilled until someone
   releases the hold. Needs `write_merchant_managed_fulfillment_orders` (asked for in `pos-app/shopify.app.toml` since
   round 32; the till's sales being fulfilled the second they're paid shows it's approved).
2. **A tag and a note** on the order: tag `Library copy`, and the note line
   `Library copy in this order: <game> (<code>). Don't post it or hand it over. Refund or cancel unless there's a good reason.`
   (several games: "Library copies in this order: A (code) and B (code)."). Needs `write_orders`; it's the backup should
   the hold fail, and the way to find these orders in Shopify (Orders, filter by tag).
3. **One email to staff** (`STAFF_EMAIL`, a Worker secret; never an address in code), sent once the hold has been tried,
   whether or not it worked, and only once (`mailed_at`, with Resend's idempotency key `library-hold-<order number>`).

The 10-minute run (`libraryHoldUpkeep`) finishes what a restart or Shopify cut short, for a day after the order: a hold
not placed yet, a tag not on yet, an email not sent yet. After a day it stops trying; the email has gone by then.
`LIBRARY_HOLD_EMAILS = off` in the config stops the email (the hold and tag still happen).

## 3. The staff email, word for word

Plain and clear, in Gobgob's voice for staff (`LIBRARY_HOLD_WORDS`):

- Subject: `Don't send order #1550: it has a library copy`
- Title: `A library copy was bought online`
- Intro, held: `Order #1550 has a library copy in it, so Gobgob has put it on hold in Shopify. Don't post it or hand it over.`
- Intro, not held (Shopify said no, or had nothing to hold): `Order #1550 has a library copy in it. Shopify wouldn't let Gobgob put it on hold, so it's tagged Library copy. Don't post it or hand it over.`
- Details: `Order` #1550; one `Library copy` row a game (the row label once, then blank), each
  `Catan (DGL34-M011): $0.00, a $0 library copy` or `Catan (DGL34-M011): $65.00, not a game they have on loan`
  (`2 × Catan (DGL34-M011): $65.00 each, …` for more than one); `Customer` their name as the Lair knows it, or
  `Not a Lair member` (no customer at all: `No customer on the order`).
- Outro: `What to do: refund or cancel it in Shopify, and let them know library copies aren't for sale online.` and
  `Only keep it if there's a good reason, like a member buying a game they've borrowed. Then release the hold in Shopify (Orders, the order, Release hold) before you send it.`
- Button: Open the staff page. Sign-off: Gobgob, keeping an eye on the Lair.

## 4. Data

`library_order_holds`: `order_id` (key), `order_name`, `customer_id`, `lines` (JSON: title, code, quantity, each in
cents, why: `free` or `notTheirs`), `created_at`, `held_at` (when Shopify's hold went on), `hold_note` (why it didn't),
`hold_tries`, `tagged_at`, `mailed_at`, `tried_at` (the last follow-up).

## 5. What's left to Mo and staff

- Releasing a hold, refunding or cancelling is staff's, in Shopify.
- The 163 $0 library copies still need a retail price (Mo, 16 November 2026), or to come off the Online Store; this
  round only catches the orders.

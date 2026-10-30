# Lair API contract v25-gw-orders: Games Workshop items ordered in

Round 25 (31 Oct 2026). From Mo's brief, 31 Oct 2026: any product on GW's latest ANZ order pad can be ordered online,
in the Shop app and at the till. "If it's on our shelf, it says so. If not, it's clearly ordered in from Games Workshop,
not in store." Orders close at midnight at the end of Monday (Auckland), Mo orders on Tuesday, GW ships on Thursday, and
it should be with the customer two weeks after that Thursday. Mo gets the GW order list first thing Tuesday without
typing, sees the week's ordered-in sales, and Lair pickups are emailed when it's in. Mo's answers: one parcel when it's
all in; the whole GW pack is ordered (extras go on the shelf).

The code: `src/gw-orders.js` (everything below), `src/shopify.js` (`gwOrder`, `gwState`, `gwMarkOrder`, `gwBelowZero`,
and email attachments), `src/lair.js` (`ordersPaid` calls `gwOrderPaid`; maintenance calls `gwOrderList` and
`gwReconcile`; the tables). The app's scopes add `write_orders` (`pos-app/shopify.app.toml`) for the tag and note. The
theme's side (badges, the product page's date box, cart notes, the Ordered in line property) is on the theme's
`dice-goblin-2-theme` branch: `snippets/gw-*.liquid`, `assets/gw.js`. Tests: `test/round25-gw-orders.test.js`.

No new routes. Nothing changes for any product until its variant is set to keep selling when out of stock.

## The dates

`gwSchedule(day, release, overrides)` → `{ cutoff, ships, promise }`, as the theme's `snippets/gw-dates.liquid` and
`assets/gw.js`: the cutoff is the Monday on or after the order day (Auckland), ships 3 days after, promise 17 days after.
A product released after the order day (`custom.gw_release_date`) counts from its release day. The shop metafield
`gw.schedule` holds the Warhammer tab's changes, keyed by Monday: `{"overrides": {"2026-12-28": {"skip": true},
"2027-01-04": {"promise": "2027-01-28"}}}`. A skipped Monday's orders join the next week.

## A paid order (orders/paid)

A GW line is one whose vendor is `Games Workshop` and whose SKU is a GW code (8 to 13 digits; library copies'
`DGLRPG-…` never are). An order with GW lines is worked out once (one Shopify request: the order, the lines' variants,
`gw.schedule`); if Shopify can't answer, the webhook fails and comes again.

For each GW line whose variant is tracked and keeps selling (`CONTINUE`): Shopify has already taken the sale off the
stock, so the variant is short by `max(0, -inventoryQuantity)`. What the Lair already has down as ordered in for that
variant (not in, not taken off) counts first; the rest, up to the line's quantity, is this line's ordered-in units. A
variant that stops at 0 (dropped off the pad) is never ordered in. The order's date is when it was made, so an order
made at 11:58pm on Monday is that week's however late its webhook comes.

With any ordered-in units: the order is tagged `Ordered in` and a paragraph added to its note:

- online: "Ordered in from Games Workshop: 1 × Combat Patrol: Space Marines (99120101386). Should be with them by Thu 26
  Nov. One parcel: send it all once it's in."
- counter: "Ordered in from Games Workshop at the counter: … Should be in by Thu 26 Nov: put it aside for them."

Shopify turning the tag down (before `write_orders` is approved) is tried again by maintenance, three a run, for two
weeks. A customer with an email gets "Ordered in for you: order #2041" (words in `GW_WORDS`): what's ordered in, the
date, how it reaches them (one parcel, or an email when it's in), and the refund line.

`ordersPaid`'s answer adds `gw: { units, lines: [{ code, quantity, promise }] }` for an order with GW lines.

## Tuesday's order list

From 6am on Tuesday, once per cutoff, to `GW_ORDER_EMAIL` (else `STAFF_EMAIL`): "GW order for Monday 9 Nov: 2 codes".
Every ordered-in line with that cutoff or earlier that isn't on a list yet, by code: units still to come, rounded up to
GW's pack (`custom.gw_pack_size` on the variant, 1 when unset). The lines to paste (`code,packs`) and a CSV
(`Product code,Quantity`), the total at NZ RRP, the week's ordered-in sales online and at the counter (orders, items,
value), counter sales with no customer on them, and GW variants below zero that no ordered-in line explains. The first
run after going live only notes the week. A skipped week sends nothing. The lines are marked as listed only once the
email has gone (Resend's key `gw-list-<cutoff>` stops a second copy).

## Maintenance: refunds, deliveries, late orders

Every run with open lines (one Shopify request for their variants, orders and order lines):

1. A cancelled order takes all its open ordered-in units off; a line with fewer units left (a refund or an edit) takes
   that many off, ordered-in units first.
2. A variant with more open ordered-in units than it's short has had stock come in: the difference goes to its open
   lines, oldest order first.
3. An order with nothing left to come: when something came in, a pickup or counter customer with an email gets "It's in:
   order #2041 is ready to collect", and the shop gets one email listing each order and what to do (collect, pack and
   post, or put aside). An order with everything taken off says nothing.
4. An order still waiting the day after its date: the shop hears once.

## Known limits

- Who gets the shelf's last one goes by the stock when each webhook is worked out. Two orders for the same variant
  within seconds of each other, or a sale that takes fresh stock below zero again before the next maintenance run, can
  swap who's ordered in. The total ordered from GW is still right.
- Refund an ordered-in item with Restock ticked, so the count goes back to where it was; otherwise it shows as below
  zero with no order to explain it.
- At the till: when Shopify says 0 but there's one on the shelf, it's someone's online order. Don't sell it: the
  counter customer's is ordered in.

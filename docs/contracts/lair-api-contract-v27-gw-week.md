# Lair API contract v27-gw-week: the rest of the Warhammer tab

Round 27 (31 Oct 2026). The plan ("Warhammer ordered in: plan", agreed with Mo on 31 Oct 2026): "Your side of the week.
Ready before the first Tuesday after going live: the Warhammer tab with the pad upload, the Tuesday list and email,
receiving, GW couldn't supply, holiday dates and weekly ordered-in sales." Rounds 25 and 26 did the pad, the list and the
email. This round adds the rest to the staff page's Warhammer tab (owner only):

- **This week's order**: the list as Tuesday's email has it, shelf top-ups (in the email when added before it goes, and
  in the tab's lines to paste after), GW couldn't supply (order it again next week, or refund it), the refunds still to
  do, and ordered-in sales week by week.
- **When the box comes**: scan or type what came and add it to stock in Shopify in one go. The Lair marks customers'
  items in straight away: It's in emails, and what to pack or put aside.
- **Order dates**: skip a week or change its dates. The website, the emails and Tuesday's list follow (they already read
  the shop's `gw.schedule`), and customers with orders that week can be told their new date.

The code: `src/gw-week.js` (everything below), `src/gw-orders.js` (lines GW couldn't supply, top-ups on the list, the list
kept once sent), `src/shopify.js` (`gwReceiveLookup`, `gwAdjust`, `gwScheduleRead`, `gwScheduleSave`), `src/lair.js`
(routes, tables). Tests: `test/round27-gw-week.test.js`. No new app permissions: stock uses `write_inventory` (round 26)
and the schedule is the shop's own metafield.

## The weeks

A week's orders close at midnight at the end of its Monday (its cutoff), and its list goes from 6am on the Tuesday
(round 25).

- **Open week**: the Monday whose list goes next. Today, on a Monday. Otherwise the last Monday until its list has gone,
  then the Monday after. A skipped Monday passes it on to the next.
- **Sent week**: the last list emailed. The Lair keeps it as it went (`meta` `gw-list-sent`: `{ cutoff, at, codes }`).
- **A line's week**: the list it's on (`listed_for`), else the open week (or, ordered after the open week closed, its own
  cutoff's), past any skipped Mondays. Its date is that week's (the week's own dates, else 17 days after the Monday).

## Routes (owner only: anyone else gets 403)

All answers are JSON; errors are `{ error }` with the words in `GW_WEEK_WORDS`.

### GET /gw/week

`{ today, open, sent, refunds, weeks }`:

- `open`: `{ cutoff, due (the Tuesday its list goes), codes, total }`. `codes`: each GW code with units still to come for
  customers and not on a list yet (lines whose week closes by then), and the week's top-ups: `{ code, title, units, pack,
  packs (whole GW packs for the units), topup (shelf packs), price (cents, NZ RRP) }`. `total`: all packs at NZ RRP.
- `sent`: `null`, or `{ cutoff, at, codes, total, paste, csv }`: the list as it went, with top-ups added since. Each code
  adds `waiting` (units from that list still to come) and `unsupplied` (`{ choice, units, at }` when GW couldn't supply
  it). `paste`: a line `code,packs` each (customers' packs and top-ups together), as GW's trade site takes them; `csv`:
  `Product code,Quantity` and the same lines.
- `refunds`: lines GW couldn't supply, still to refund: `{ id, order, orderId, admin (the order in Shopify admin), code,
  title, units, amount (cents), at }`.
- `weeks`: up to 6 weeks with ordered-in sales, newest first: `{ cutoff, online: { orders, units, value }, counter }`.

### GET /gw/find?q=

Up to 10 lines of the latest pad: digits find a barcode, or codes starting with them; words find titles with all of
them. `[{ code, title, pack, barcode, price }]` (`{ lines }`).

### POST /gw/topups `{ cutoff, code, packs }`

Shelf top-ups: whole GW packs of a code on the latest pad, for the open week (in its email) or the sent week (after it
went: on the tab's lines to paste). `packs` 1 to 99 sets it, 0 takes it off. → the week (as GET).

Errors (422): "That week's order has closed." · "That code isn't on the latest order pad." · "Packs is a whole number
from 0 to 99."

### POST /gw/unsupplied `{ cutoff, code, choice, tell }`

A code GW couldn't supply, on a list sent in the last 8 weeks. Its lines on that list still to come:

- `again`: back on the next list (the open week's), with that week's date. Customers with an email hear the new date
  when `tell` is true.
- `refund`: refunds to do. Customers with an email hear it's not coming and is being refunded in full, when `tell`. Their
  units stop waiting for stock (stock that comes in goes to other orders or the shelf), an order with nothing else to
  come is ready (its It's in email for the rest), and it's never flagged late. Refund it in Shopify with Restock ticked:
  maintenance sees the refund, and the line's done.

→ the week (as GET) and `told` (emails sent). The same request again changes nothing. Errors (422): "Choose whether to
order it again next week or refund it." · "Nothing from that list is still waiting on that code." · "That list is too old
to change here."

### GET /gw/receiving

`{ waiting, lastList, receipts }`:

- `waiting`: each code customers are waiting on that's been on a list: `{ code, title, barcode, pack, units, orders }`.
- `lastList`: the sent week's codes and how many units it ordered, top-ups included: `{ cutoff, codes: [{ code, title,
  barcode, pack, units }] }` (`null` before any list), to fill the delivery in from.
- `receipts`: deliveries added in the last 14 days, newest first, up to 10: `{ receipt, at, who, units, lines, ready }`.

### POST /gw/receive `{ receipt, part, parts, items: [{ code, units }] }`

A delivery added to stock at the shop (Shopify's `received`), a part at a time: up to 25 lines a part, 20 parts.
`receipt` is the browser's id for the delivery (8 to 64 letters, digits and dashes). Each code once a part, 1 to 999
units.

Nothing is added twice. The Lair keeps each part's answer and gives it again when the part comes again, and Shopify's
idempotency key (`<receipt>-<part>`, a new one only after Shopify said no and added nothing) covers an answer lost on
the way for 24 hours. A part that's every code in the shop, tracked, goes to Shopify; otherwise nothing is added.

Then, from the new stock, customers' units are marked in, oldest order first (as maintenance does), and the orders with
nothing left to come are told (round 25: It's in emails, and the shop's email). If the stock can't be read straight
after, maintenance does it within 10 minutes.

→ `{ added: [{ code, title, units }], ready: [{ order, what, action }], later (matched by maintenance) }`.

Errors: "These aren't in the shop yet: … Update the shop from the latest pad, or take them off." (422) · "Shopify doesn't
count stock for these: … Turn on Track quantity for them in Shopify, or take them off." (422) · "That delivery was
already added with different counts. Start a new one." (409) · "Still adding the last lot to stock. Wait a moment, then
try again." (503) · "Shopify didn't answer. Try again: nothing is added twice." (503) · a missing permission (round 26's
words).

### GET /gw/dates

`{ today, open, weeks: [{ monday, ships, promise, skip, changed, sent, orders, canSkip }] }`: 4 weeks back to 12 ahead.
`changed`: the week has its own dates; `sent`: its list has gone; `orders`: orders with something still to come that
week; `canSkip`: its list hasn't gone and skipping it leaves fewer than 4 skipped weeks in a row.

### POST /gw/dates `{ monday, skip | reset | ships + promise, tell }`

- `skip: true`: a week whose list hasn't gone. Its orders join the next week's list and date.
- `ships`, `promise`: the week's own dates: after the Monday, shipping first, both within 8 weeks. The usual dates take
  it back to usual.
- `reset: true`: back to the usual dates.

Saved to the shop's `gw.schedule` (`{"overrides": {"2026-12-28": {"skip": true}, "2027-01-04": {"ships": "2027-01-07",
"promise": "2027-01-28"}}}`), compare-and-set; weeks more than 8 weeks gone are tidied away. Then every line still to
come whose week is that one gets the week's date, its order's date follows (the latest of its lines), and an order told
it was late can be told again. Customers with an email whose date moved hear the new one when `tell`.

→ the dates (as GET) and `told`. Errors: "Pick a Monday from the last six weeks or the next six months." · "That week's
list has already gone, so it can't be skipped. Change its dates instead." · "Four weeks in a row are skipped already.
Change a week's dates instead." · "Pick dates after that Monday: GW ships, then it's with customers by the second date,
within eight weeks." (422) · "The dates changed just now. Have another look, then try again." (409).

## Changes to round 25

- A line GW couldn't supply and is being refunded never takes stock that comes in (its variant's shortfall less its
  units is what other lines wait on), doesn't hold up its order, and isn't flagged late.
- Tuesday's list adds the week's top-ups (`… + 2 packs for the shelf`, or a line of its own), keeps what it sent
  (`gw-list-sent`), and its last line says the delivery can be added to stock on the Warhammer tab.

## Words

Every message is in `GW_WEEK_WORDS` (`src/gw-week.js`), word for word.

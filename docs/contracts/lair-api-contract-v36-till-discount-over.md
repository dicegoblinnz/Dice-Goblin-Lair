# Lair API contract v36: a till discount past 20% asks first, is flagged and is emailed

Round 36. Mo (13 Nov 2026): "for the discount limitation of 20% instead of locking it just create a warning message
that this happened and flag it and send a special email when it happens so I would know [...] So you would create a
warning message saying this exceeds the 20% threshold of discounts are you sure you wanna continue and when the
transaction is done an automatic email is sent without alerting anyone etc. just for my information and if an
investigation is needed I will deal with it myself I just want the information".

**Changes only**, on top of contract v35-till-discounts (which stands for dollars off each one, Shopify's own figures
and what `most` is) and v34-till-discounts (approving, the `staff-discount` tag and the note).
`src/till-discounts.js`, with its part in `src/till-sales.js`, `src/shopify.js` and `src/config.js`; tests
`test/round36-till-discount-over.test.js` (and `test/round35-till-discounts.test.js`, brought up to it).

## 1. The rule

- **Nothing is locked at 20% any more.** Dollars off (`off`) can take an item past 80% of its full price, as far as
  its whole price and no further. Its full price is as v35: Shopify's compare-at price when it's on sale, otherwise
  its price. So something on sale already can have a discount too now, and it's past 20% as soon as it sells for
  under 80% of what it was.
- **20% is where the till asks.** `most` on a price's line is still what a discount can take off each one before
  it's past 20% (0 when it's there already). The till puts its warning up ("This exceeds the 20% discount threshold.
  Are you sure you want to continue?"), and Pay goes through only when the till says yes was said: `overOk: true`.
- **Flagged.** The sale keeps which lines were past 20%, and once it's paid its Shopify order gets the tag
  `discount-over-20` and a paragraph on its note.
- **Emailed, quietly.** Once it's paid, one email goes to the shop's owner (section 4). Nothing the till is told says
  so, and nothing goes to the team.
- Still as v34 and v35: only the shop's products (bookings, sign-ups and tabs keep their price); never on top of one
  of the shop's deals; a PIN from someone with Money, or the owner, put in within 10 minutes (`discountOk`); and all
  of it checked on Shopify's own figures, for the price and again on the draft at Pay.
- v34's percent (`discount`, from a till that hasn't reloaded since round 35) is held to the 80% exactly as v35 left
  it: it's refused past it, never asked about.
- `overOk` is the till's word that it asked: the Lair doesn't know which lines the question named. What's flagged and
  emailed is what the draft's own figures show past 20% at Pay, whatever the till had on its screen.
- **The till's side** (the theme's `assets/lair-till.js`; `tools/qa/round36-till-discount-over/`):
  - Its Discount screens are as they were: buttons for amounts within 20%, and dollars typed. Dollars that would
    take a thing past 20% get the question before anything is on the sale: `More than 20% off`, `This exceeds the 20%
    discount threshold. Are you sure you want to continue?`, a line for each thing with what it would come to
    (`7 Wonders: $50.00 off, so $55.00 (47.6% off)`), and `Yes, continue` or `No, go back` (which puts what was
    typed back in the field, picked out, to type over). A line past 20% says `· over 20%` in the sale.
  - The PIN screen says what the PIN is a yes to (`This exceeds the 20% discount threshold: 7 Wonders is 47.6% off.
    A PIN says yes to that.`), and the till sends `overOk: true` only when the approval's PIN went in on a screen that
    named exactly the things that are past 20% now. So figures that moved since (the 422 above, or a price that
    came in later) always mean a fresh PIN on a screen that says so.
  - "Discount on everything" past what keeps the things within 20% asks the same way, then shares the amount by
    price, each thing as far as its whole price. The yes is to that share of the sale: a bigger sale keeps the
    dollars, a smaller one keeps the same share of what's left, never more. Things on sale as far as 20% goes, a
    deal's lines and dice stay out of it, as v35.
  - Nothing on the till says anything of the flag or the email.

## 2. Routes

| Route | Change |
|---|---|
| `POST /proxy/till/price` | Dollars off past a line's `most` are no longer refused. The price comes back as ever, with `over`: one `{ key, off, most, unit, was?, percent }` for each line a discount takes past 20% (`key` as the till sent it; `off`, `most`, `unit` and `was` in cents as on the line; `percent`: how far under its full price each one sells, to 2 places, never less than 20.01). That line's `discount` is `{ each, amount, over: true }`. No `over` when nothing is past it. |
| `POST /proxy/till/pay` | Takes `overOk` (`true`: the till asked about the discounts past 20% and yes was said). With lines past 20% and no `overOk: true`: 422 (below), the sale is let go and its draft deleted, as any refusal on the draft's figures. With it: the sale is made as ever. What Pay answers is exactly what it was: nothing in it says the sale is past 20%, flagged or emailed about. |
| `POST /proxy/till/paid` | No change to what it takes or answers. A sale past 20% has its order flagged and the owner emailed once it's paid, in the background. |

Errors, word for word:

- Past 20% at Pay without `overOk: true`: 422
  `7 Wonders would be more than 20% off, and the till hasn't asked about that yet. Change the discount, or tap Pay again to be asked.`
  with `{ error, over: [{ key, off, most, unit, was?, percent }], line: { key, unit, most, was? } }` (`over`: every
  line past it; `line`: the first one's figures, as any refusal over a line has). The words are for a till from before
  this round, which shows them as they are: a till from this round reads `over` and asks.
- More dollars off than the item costs (price or Pay): 422
  `Riftbound Radiance · Booster Pack is $11.00, so it can't come down by more than that. Change the discount, or take it off.`
  With 2 or more of it: `… is $11.00 each, so it can't come down by more than that. …` With `{ error, line }` as v35.
  (Shopify takes a fixed amount of more than the price as the whole price and says nothing, so what was asked is
  checked.)
- On a line a deal took something off: 422 `… is on a deal already, so it can't have a discount too. Take the discount off it.` (as v34)
- Shopify took something other than what was asked off a line: 422 `…'s discount didn't come out as asked. Take it off and add it again.` (as v35)

Gone for dollars off: v35's `… can come down by $21.00 at most. …`, `… is on sale already, so it can't have a discount
too. …` and `… can't have a discount. …`. They're still what a percent (`discount`) past the 80% gets.

## 3. In Shopify

As v34 and v35 (each discounted line titled `Staff discount`, described `Approved by Rua on the till`; the order
tagged `staff-discount`, with who approved it on its note), and for a sale with something past 20%, once it's paid:

- the order's tag `discount-over-20` (Orders, filter by the tag, lists them all);
- a paragraph on its note:
  `More than 20% off, said yes to at the till: 7 Wonders, $50.00 off (47.6% off); 2 × Coca-Cola – Half Price (Flat) · Classic, $0.50 off each (58.3% off what it was).`
  Its first 8 lines, then `and 3 more`. The percent is to one decimal place, worked out once on the line's own
  figures, and `just over 20%` for anything that would round to 20.

The flag goes on once the order exists (`gwMarkOrder`, which adds the tag and the paragraph once however often it's
asked). An order Shopify is slow to make is flagged when it's made. One that can't be made at all (the team's
"needs its order made by hand" email, v32) has nothing to flag: the owner's email says so.

## 4. The owner's email

One email for each paid sale with something past 20%.

- **To:** `DISCOUNT_EMAIL` when it's set (one address; `off` for no email at all), otherwise the shop owner's own
  address as Shopify has it (`shop { email }`: Settings, Store details), asked for at most once an hour. Never
  `STAFF_EMAIL`: this one is the owner's alone. With no address to be had (the setting isn't one address, Shopify
  didn't answer) it's tried again, as below.
- **When:** as soon as the sale's order is made, so it can name it: usually seconds after it's paid. With no order
  after 10 minutes it goes without one (`… with no Shopify order yet`), and when the order can't be made at all it
  says that (`… with no Shopify order`).
- **Once:** the email is written once and kept with the sale (`over_letter`: its words, who it's to and from), and
  every try sends exactly that with the Resend idempotency key `till-over-<sale id>`. Resend knows a second send of
  it by the key, and turns the key away with other words, so a try that may have gone is never followed by a
  different email: one written before its order was made still says so if it goes later. A try that didn't go is
  made again by the 10-minute run, for 23 hours after the sale was paid (inside the day Resend keeps a key for),
  then given up on; the flag is tried for 3 days. Only a letter Resend turns away as a letter (a 400 or 422: an
  address it won't take) is written again, to the address as it is then, with a key of its own
  (`till-over-<sale id>-2`). What went wrong last is kept on the sale (`over_error`) and in the status table
  (`tillOver`).
- **Quiet:** nothing in `/till/pay`'s or `/till/paid`'s answers, no team alert, no line in any other email.

Subject: `Till discount over 20%: #4321, $60.00 off` (the order's name, and every staff discount on the sale
together). Without an order: `Till discount over 20%: $60.00 off, with no Shopify order yet` or `…, with no Shopify
order`.

Body (the Lair's usual email, with its logo and footer):

> **A discount over 20%**
>
> A sale at the till had a staff discount that took 2 things more than 20% off. Rua approved it with their PIN.
>
> Nobody at the till was told about this email. It's only so you know.
>
> | | |
> |---|---|
> | Order | #4321 |
> | When | Friday, 13 November at 6:42 pm |
> | Rung up by | Hemi |
> | Approved by | Rua |
> | Paid | $142.00 by card, taken by Hemi |
> | Sold to | Sam Jones |
> | More than 20% off | 7 Wonders: $50.00 off, 47.6% off ($105.00 down to $55.00)<br>2 × Riftbound Radiance · Booster Pack: $4.00 off each, 36.4% off ($11.00 down to $7.00 each) |
> | Other discounts | Catan: $2.00 off |
> | Before discounts | $202.00 |
> | Staff discounts | $60.00 |
>
> [Open the order in Shopify]
>
> Gobgob, keeping an eye on the till

- One thing: `… that took one thing more than 20% off.`
- Something on sale already: `Coca-Cola – Half Price (Flat) · Classic: $0.50 off, 58.3% off what it was ($6.00 before its sale, $3.00 down to $2.50)`.
- `Order` without one: `Not in Shopify yet. The Lair is still making it: it will have the tag discount-over-20 when it's there.`
  or `Shopify couldn't make its order, so there's nothing there to flag. The team have an email about making it by hand.`
- `Rung up by` on the customer screen: `A customer, on the customer screen`. `Sold to` with nobody on the sale:
  `A quick sale (no member)`.
- `Paid`: `$3.00 in cash, taken by Hemi`, `$20.00 with store credit`, `$50.00 with $10.00 of store credit and the rest by card, taken by Hemi`.
- `Other discounts` (staff discounts on the sale that stayed within 20%) is left out when there are none.
- The button opens the order in Shopify admin; it's left out when there's no order.

## 5. Data

`till_sales` gains (added when missing, `TILL_DISCOUNT_COLUMNS`):

| Column | What |
|---|---|
| `discount_over` | the lines past 20% as Pay found them on the draft, JSON (`[{ key, title, qty, unit, was?, off, most, percent }]`), null for none |
| `started_by_name` | who rang the sale up (null on the customer screen) |
| `over_mark` | its order's flag: `due`, then `done`; `stopped` when there's no order to flag, or after 3 days |
| `over_mail` | the owner's email: `due`, then `sent`; `off` when `DISCOUNT_EMAIL` is `off`; `stopped` after 23 hours |
| `over_tries`, `over_next_at`, `over_error` | for trying again: how many tries, when the next one is due, what went wrong last |
| `over_letter`, `over_letters` | the email as it was written (JSON, with its key and sender), kept until it's sent or given up on; how many have been written |

`tillSalesUpkeep` (the 10-minute run) looks after up to 5 of them a run and answers `{ letGo, orders, fulfilled, over }`.

## 6. Settings

`DISCOUNT_EMAIL` (the `config` table, or a Worker variable): where the owner's email goes: one email address, or `off`.
Not set: the shop owner's address in Shopify. It's deliberately not in `wrangler.toml`: this repo is public.

## 7. Going live

The Lair first, then the till. A till from before this round never sends more than `most` once Shopify has priced
the basket, so it carries on as it was; the rare amount it lets through on its own sum (typed before the first price
came back, on something Shopify has on sale) is refused at Pay with the first error above, and its Discount screen
then offers what the item can take. (The other way round, a till from this round against a Lair from before it would
say yes to a discount the Lair then refuses in v35's words.)

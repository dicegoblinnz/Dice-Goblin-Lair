# Lair API contract v35: discounts on the till, in dollars

Round 35. Mo (10 Nov 2026): "for the discount make it go off actual dollar value not % thanks no need to say no more
than 25% but do not accept anything lower than 25% unless it is done on the item previously thanks. Actually make it
20%". Asked when something may sell for more than 20% off, he picked "Already on sale": only when Shopify already has
the item at a sale price or on a deal.

**Changes only**, on top of contract v34-till-discounts (which stands for approving, the tag and the note).
`src/till-discounts.js`, with its part in `src/till-sales.js` and `src/shopify.js`; tests
`test/round35-till-discounts.test.js`.

## 1. The rule

- A discount is **dollars off each one** of a shop product in the basket: `off`, in whole cents, more than 0. Two of a
  $50 game with $5 off is $10 off. Bookings, sign-ups and tabs keep their price, as before.
- **No item sells for less than 80% of its full price because of a discount.** Its full price is Shopify's compare-at
  price when the item is on sale (a compare-at price above its price), otherwise its price. So:
  - an item at full price comes down by up to 20% of it, rounded down to the cent ($59.99: $11.99);
  - an item on sale comes down only as far as 80% of what it was ($100, now $90: $10);
  - an item already at or under 80% of what it was can't have a discount ($6, now $3). It sells for less than 80% only
    because Shopify already has it there.
- A line the shop's own deal took something off (the dice deal's free die, a Commander deck's free sleeves) can't
  have a discount too, as before.
- (11 Nov 2026) The till also takes dollars off the whole sale ("Discount on everything", Mo: "make $ off discount
  back"). That's the till's doing alone: it shares the amount across the sale's things as `off` on each line, by price
  and within each thing's `most`, and sends lines as ever. Nothing here knows a shared discount from one put on by
  hand, and every line is held to the same rule.
- All of it is checked on Shopify's own figures (the price and compare-at price Shopify has for the item as it works
  the sale out, and what it took off the line): for the price, and again on the draft at Pay.
- Approving is as v34: Pay takes a discounted basket only with `discountOk`.
- Nothing says the limit until it's passed: a refusal names the most that item can come down by, in dollars.

## 2. Routes

`lines` (the basket) as v32, products now `{ key, variantId, qty, off? }` (`off`: cents off each one).

v34's `discount` (a percent off the line) is still read, for a till that hasn't reloaded since this round: at most
**20** now, and held to the same 80%. A line can't have both. It goes in a later round.

| Route | Change |
|---|---|
| `POST /proxy/till/price` | Each product line (not a tab's) has `most`: the cents a discount could take off each one of it (0 when it can't have one), and `was`: its compare-at price in cents, when it's on sale. A line one of the shop's deals took something off has `most: 0` and `deal: true` (11 Nov 2026: so the till leaves it out when it shares a discount across the sale, and its Discount screen offers nothing). A line with dollars off has `discount: { each, amount }` (`each`: `off`; `amount`: what Shopify took off the line); a line with a percent has `{ percent, amount }` as v34. `discounts`, `needsOk` and `staffDiscount` as v34. |
| `POST /proxy/till/pay` | As v34. |

Errors, word for word:

- `off` isn't a whole number of cents from 1 to 1,000,000: 400 `A discount is dollars and cents off each item.`
- `discount` over 20, not a number, or more than 2 decimal places: 400 `A discount can be up to 20% off each item.`
- A line with both `off` and `discount`, or the same product twice with different discounts: 400 `Something in the basket didn't look right. Take it out and add it again.`
- On a booking or a tab: 400 `Discounts are for things from the shop. Bookings and tabs keep their price.` (as v34)
- More than the item can come down by (price or Pay): 422 `7 Wonders can come down by $21.00 at most. Change the discount, or take it off.` With 2 or more of it: `Riftbound Radiance · Booster Pack can come down by $2.20 each at most. Change the discount, or take it off.`
- On an item on sale that's at or under 80% of what it was: 422 `Coca-Cola – Half Price (Flat) · Classic is on sale already, so it can't have a discount too. Take the discount off it.`
- On an item too cheap for 20% to be a cent: 422 `Lolly can't have a discount. Take the discount off it.`
- On a line a deal took something off: 422 `Oakie Doakie Translucent RPG Dice Set · Green is on a deal already, so it can't have a discount too. Take the discount off it.` (as v34)
- Shopify took something other than what was asked off a line: 422 `Riftbound Radiance · Booster Pack's discount didn't come out as asked. Take it off and add it again.`

Each of those 422s about a line's discount also says which line, with Shopify's figures for it now, so the till can
offer what it can take: `{ error, line: { key, unit, most, was?, deal? } }` (`key` as the till sent it; `unit` its
price, `most`, `was` and `deal` as in the price, all in cents: the `… is on a deal already …` refusal's line has
`most: 0` and `deal: true`). Every other refusal is `{ error }` alone, as before.

At Pay, a refusal on the draft's figures lets the sale go and deletes its draft, as v34. v34's
`… came to more than 25% off. …` is gone: a percent that comes to more than the item can come down by gets the
`… can come down by … at most. …` words.

## 3. In Shopify

A line with dollars off has Shopify's applied discount as a fixed amount (Shopify takes it off each one of the line),
titled `Staff discount`, described `Approved by Rua on the till`. The tag and the note are as v34.

## 4. Data

Nothing new. A sale's `lines` keep `off`.

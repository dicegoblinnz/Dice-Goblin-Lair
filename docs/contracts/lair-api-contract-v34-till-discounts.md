# Lair API contract v34: discounts on the till

Round 34, 10 November 2026. Mo: "for the till have an option to apply discounts but once applied the staff needs to
'log in' and that goes through make sure no item can go below 25% discount". With his 6 Nov 2026 decision that
discounts on the till are for the Money role.

**Changes only**, on top of contract v32-till (section 6) and v33-credit-pay. `src/till-discounts.js`, with its part in
`src/till-sales.js` and `src/shopify.js`; tests `test/round34-till-discounts.test.js`.

## 1. The rule

- A discount is a percent off one of the shop's products in the basket: more than 0 and **at most 25**, to 2 decimal
  places. Bookings, sign-ups and tabs keep their price (they have passes, waiving and the tab's prices).
- **No item sells for less than 75% of its price because of a discount.** The percent is checked when it's sent, and
  again on what Shopify actually took off each line. A line the shop's own deal already took something off (the dice
  deal's free die) can't have a discount too.
- **Approving:** Pay takes a discounted basket only with `discountOk`: the till token from a PIN put in **in the last 10
  minutes** by the owner or someone with **Money**, even when they're the one on the till. One approval is for one sale:
  a sale let go (Back, Shopify failing) can use it again on the same till; a sale that's paid, or still open on another
  till, can't.

## 2. Routes

`lines` (the basket) as v32, products now `{ key, variantId, qty, discount? }` (`discount`: the percent).

| Route | Change |
|---|---|
| `POST /proxy/till/price` | Discounts show straight away, with no approval: each discounted line has `discount: { percent, amount }`, the price's `discounts` ends with `{ title: 'Staff discount', amount }`, and the price has `needsOk: true` and `staffDiscount` (cents). |
| `POST /proxy/till/pay` | `{ …, discountOk }` when any line has a discount: the approver's till token (from `POST /proxy/till/unlock`). The sale (`sale`) has `staffDiscount: { amount, by }` (the approver's name), or null. |

The till's approval is an ordinary unlock: the till asks the approver for their PIN (`POST /proxy/till/unlock`) and
sends the token it gets back as `discountOk`. Whoever's on the till stays on it.

Errors, word for word:

- Over 25%, not a number, or more than 2 decimal places: 400 `A discount can be up to 25% off each item.`
- On a booking or a tab: 400 `Discounts are for things from the shop. Bookings and tabs keep their price.`
- The same product twice with different discounts: 400 `Something in the basket didn't look right. Take it out and add it again.`
- No `discountOk`, or one that isn't a till token: 403 `A discount needs a PIN from someone with Money, or the owner, before it goes through.`
- From longer than 10 minutes ago: 401 `That approval has run out. Put a PIN in again to approve the discount.`
- From someone without Money: 403 `Hemi can't approve discounts. That's for staff with Money, or the owner.`
- Used for another sale: 409 `That approval was for another sale. Put a PIN in again to approve this one.`
- On a line a deal took something off: 422 `Oakie Doakie Translucent RPG Dice Set · Green is on a deal already, so it can't have a discount too. Take the discount off it.`
- Shopify took more than 25% off a line (price or Pay; at Pay the sale is let go and its draft deleted): 422 `Riftbound Radiance · Booster Pack came to more than 25% off. Take the discount off and add it again.`

Nothing is checked in or made when an approval is refused.

## 3. In Shopify

Each discounted line has Shopify's applied discount (a percentage), titled `Staff discount`, described
`Approved by Rua on the till`. The order is tagged `staff-discount` (Orders → filter by tag to see them all) and its note
ends `Staff discount approved by Rua.`

## 4. Data

`till_sales` gains `discount_by` (the approver's id), `discount_by_name`, `discount_ok` (the SHA-256 of the approving
token, so it's used once) and `discount_total` (cents), added when missing.

# Lair API contract v32: the till (who's on it, people on it, and its sales)

Round 32, 6 November 2026 (the library filters and open games are round 31s of their own). Mo is replacing Shopify POS with the shop's own till (the website's staff page with
`?view=till` on the end, on the counter tablet; plan: the doc "Dice Goblin till: plan"). He asked for his own passcode,
Caleb on 1234, and everyone changing theirs to what they like the first time they log in, Felix too.

**Changes only**, on top of every contract before it. Times in ms (UTC). Errors stay `{ error: "A plain sentence." }`
with a 4xx or 5xx.

PINs never go in the website's code (anyone can read it), so the till's people and their PINs live here. Everyone starts
on **1234** and the till asks them to choose their own PIN the first time they unlock: Mo chooses his then, and Caleb
and Felix choose theirs. Nobody's own PIN is in any code, test or document.

`src/till.js`; tests `test/round32-till.test.js`.

## 1. Who's on the till

The till's people, in this order:

1. The owner: whoever's logged in when they're tagged `staff` in Shopify, then anyone else tagged `staff` (Shopify is
   asked at most every 10 minutes; when it can't be asked, the last answer, or just whoever's logged in).
2. The helpers on the staff page's Team tab (oldest first), with the Team tab's permissions.
3. People the owner adds on the till itself (oldest first). They need no account: a name, and what they can do on the
   till: `checkin` (take payment at the counter and approve cash, as Check-in does on the staff page) and `money`
   (refunds, store credit and tabs, as Money does). Someone new gets `checkin`.

Caleb and Felix are added on the till on its first start (with `checkin`), unless a helper by that first name is on the
Team tab already. Mo ticks Money for them on the till's Team screen if he wants them doing refunds and store credit.

A person, as every till route gives them (`tillPersonView`):

```
{ id, name, fullName, role: 'owner' | 'helper', kind: 'team' | 'till', roleWords, perms, pin: 'start' | 'own',
  off, locked, lockedMinutes? }
```

- `id`: a Shopify customer ID (`kind: 'team'`), or `tp_` and 16 letters and numbers (`kind: 'till'`, added on the till).
- `name`: a first name for the team (from their member record), the name as typed for the till's own people.
- `roleWords`: `Owner`, `Check-in`, `Money`, `Check-in and money` or `Sales only` (what the lock screen says under
  their name).
- `pin`: `start` while they're on 1234 (never chosen, or reset), `own` once they chose theirs.
- `off`: their till access is switched off. `locked`: too many wrong PINs; `lockedMinutes` until they can try again.

## 2. PINs, tokens and lock-outs

- A PIN is 4 numbers. It's kept as HMAC-SHA-256 over `salt:pin`, each with its own random salt, with a key made once at
  random and kept in the Durable Object's key-value storage, not in the Lair's tables. The starting PIN is no row at all.
- Five wrong PINs in a row lock that person out: 5 minutes, then 10, 20, 40, then an hour each time after that, until
  a right PIN (or the owner's reset) starts them at 5 again. Only that person is held up.
- Unlocking gives a token (48 letters and numbers) that says who's on the till for 14 hours. The till keeps it in the
  tablet's memory and sends it in the body (never the address). The Lair keeps only its SHA-256. A token stops working
  when it runs out, when that person's PIN is reset or access switched off, or when they leave the team or the till (a
  helper added back later doesn't get their old tills back).
- Until someone has chosen their own PIN (on 1234 the first time, or after a reset), their token does only one thing:
  choose it. Anything else is a 403 `Choose your own PIN first.` The Lair checks this, not just the till's page.
- **Forgot your PIN (owners):** never a reset on the logged-in account alone, because the counter tablet's account is
  open to anyone at the counter. Instead the owner gets a 6-digit code at their own email (their member record's, else
  Shopify's). The code is kept as an HMAC like a PIN and works once, for 15 minutes; a new one replaces the last, at most
  one a minute and 10 a day. Five wrong codes in a row, across new codes, lock that owner's codes like PINs (5 minutes,
  doubling to an hour). The right code gives a till for 15 minutes that can only choose a new PIN: the old PIN stays until
  the new one is saved, so walking away halfway never leaves them on 1234, and choosing turns it into an ordinary till
  for a shift. Helpers and the till's own people ask the owner to reset theirs.

## 3. Routes

All need a logged-in staff account (the owner or a helper; the till tablet is logged in as one): anyone else gets
403 `The till is for staff. Log in with a staff account.`

| Route | Who | What |
|---|---|---|
| `GET /proxy/till/team` | staff | The lock screen → `{ team: [person], startPin: '1234' }` |
| `POST /proxy/till/unlock` | staff | `{ id, pin }` → `{ token, staff: person, mustChange }`. `mustChange` is true while they're on 1234: the till asks them to choose their own before anything else. Wrong PIN: 401 `That PIN isn't right. Try again.` The fifth in a row, and any try while locked out: 429 `Too many wrong PINs. Try again in 5 minutes, or ask Mo to reset it.` Switched off: 403. Not on the till: 404 |
| `POST /proxy/till/pin` | on the till | `{ token, pin }`: whoever the token is for chooses their own PIN → `{ ok: true, staff: person }`. 4 numbers (400 `A PIN is 4 numbers.`), not 1234 (400 `Choose a PIN that isn't 1234.`). A token that ran out or was stopped: 401 `The till locked itself. Tap your name and your PIN again.` |
| `POST /proxy/till/reset` | the owner on the till | `{ token, id }`: that person goes back on 1234 (they choose their own the next time they unlock), any lock-out is cleared, and their other tills lock → `{ team }`. The owner's own till stays open when they reset their own PIN with it (then it can only choose a new one). No token: 401 |
| `POST /proxy/till/forgot` | staff | `{ id }` of an owner: emails them a 6-digit code → `{ sent: true, to: 'o•••@example.com' }`; asked again within a minute of one going → `{ sent: false, to }` (type that one). Not an owner: 403 `Only an owner's PIN is reset by email. Ask Mo to reset yours on the till.` Locked by wrong codes: 429 `Too many wrong codes. Try again in 5 minutes.` The 11th in a day: 429 `That's 10 codes today. Try again tomorrow.` No email set up or no address: 503. The email didn't go: 502 (ask again straight away; it doesn't count) |
| `POST /proxy/till/forgot/check` | staff | `{ id, code }` (spaces ignored) → `{ token, staff: person, mustChange: true }`: a till for that owner for 15 minutes that can only choose a new PIN (anything else 403 `Choose your own PIN first.`); their other tills lock. Wrong: 401 `That code isn't right. Check the email and try again.`; the fifth wrong in a row, across new codes: 429, the code is gone and codes are locked; ran out: 410; none waiting (used, replaced, never asked): 400 |
| `POST /proxy/till/access` | the owner on the till | `{ token, id, off }`: till access off (their tills lock; unlocking gives 403 `Your till access is switched off. Ask Mo to turn it back on.`) or back on (their own PIN still works) → `{ team }`. Not your own (400) |
| `POST /proxy/till/people` | the owner on the till | `{ token, name, perms? }` adds someone on the till, on 1234; `{ token, id, name?, perms? }` changes someone added on the till → `{ team, person }`. `name`: 1 to 30 characters, spaces tidied, no `<` or `>` (400), not the name or first name of anyone on the till already, any case (409 `There's already a Caleb on the till.`). `perms`: a list, `checkin` and `money` kept, anything else dropped. Helpers are changed on the Team tab (404 here) |
| `POST /proxy/till/people/remove` | the owner on the till | `{ token, id }`: someone added on the till is taken off it; their PIN goes and their tills lock → `{ team }`. Only people added on the till (404 for the team) |

"The owner on the till" is a token from unlocking as an owner who has chosen their own PIN: a helper's token gets 403
`Only the owner can do that.`, an owner still on 1234 gets 403 `Choose your own PIN first.`, no token or a stopped one 401.

## 4. Data

Three tables, made on start when they're missing:

- `till_people (id, name, perms, status, made_by, created_at, updated_at)`: the people added on the till; `status`
  `active` or `removed`; `made_by` `start` (Caleb and Felix) or `till:<owner's ID>`.
- `till_pins (person_id, hash, salt, must_change, failed, lockouts, locked_until, off, updated_at)`: one row a person,
  once anything about their PIN changed.
- `till_sessions (token_hash, person_id, created_at, expires_at, pin_only)`: the SHA-256 of each token; `pin_only` 1 for a
  till from an emailed code until its PIN is chosen. Ones that ran out are cleared on the next unlock.
- `till_resets (person_id, hash, salt, expires_at, sent_at, failed, lockouts, locked_until, day_start, day_count)`: an
  owner's emailed code (hash null when none is waiting), wrong codes in a row and the lock-outs they caused, and the
  day's codes. Gone after a right code.

The meta row `till-seeded` says Caleb and Felix were added (once).

## 5. Part 2: people on the till

Mo (6 Nov 2026): the counter faces customers, "people just scan their code and immediately start using it", and staff
sign in to sort things out. `src/till-people.js`; tests `test/round32-till-people.test.js`. Nothing here changes a
booking: paying is part 3.

| Route | Who | What |
|---|---|---|
| `POST /proxy/till/scan` | staff account (the counter tablet's), nobody on the till needed | `{ code, token? }`: a code at the counter. A member's code → `{ type: 'person', person }`. A booking's or sign-up's code → `{ type: 'booking', booking, name }`: just that booking and a first name (whoever holds a ticket isn't always its booker). With staff on the till (`token`, own PIN, Check-in or the owner) and an account on it → `{ type: 'person', person, focus: '<its code>' }`. A pass → `{ type: 'pass', pass: { label, left } }`. Unknown: 404 `Gobgob doesn't know that code. Try your member code from My Lair.`; the 20th unknown code from one tablet in 10 minutes, and anything after it from that tablet, 429 `Too many codes Gobgob didn't know. Ask staff for a hand.` (staff on the till are never held up) |
| `POST /proxy/till/find` | staff on the till with Check-in, or the owner | `{ token, q }` (2 letters at least) → `{ people: [{ id, name, code }] }`: members by name, email or code, up to 12 |
| `POST /proxy/till/person` | staff on the till with Check-in, or the owner | `{ token, id }` → `{ type: 'person', person }` (404 for no such member) |
| `POST /proxy/till/tonight` | staff on the till with Check-in, or the owner | `{ token }` → `{ rows: [{ ref, personId, name, what, kind, at, due, paid, status }], night }`: today's rows as the counter tile's Today list has them, in time order; `night` is the event on now or starting within 90 minutes (the soonest) as `{ title, at, rows }`, or null |

Someone on the till without Check-in (and not the owner) gets 403 `Finding people is for staff with Check-in.`; on 1234
still, 403 `Choose your own PIN first.`

A person (`person`):

```
{ id, first, name, code, since, email?, loyalty, credit, passes: [{ label, left }], library: [{ name }],
  bookings: [{ code, title, at, kind, paid, owed, onAccount, status, lines: [{ title, sub, price, session, line }] }],
  tab, account }
```

- `name`: "Mia T." on the customer screen; the full name, and a masked `email` ("m•••@example.com"), for staff on the till.
- `bookings`: today's rows and what they owe from before, as `/pos/scan` lists them. Each row still to pay (not a
  no-show) has one basket line: `price` (cents) is what's due, `sub` says what it is ("Event entry · MT-OWLBEAR-17",
  "Table fee · T1, 2 people · …", "Owed from Thu 1 Oct · …"), `session` whether paying it stamps the card, and `line`
  is the very cart line the counter tile uses (`_booking`), for part 3 to pay.
  A no-show (staff settle those), a cancelled booking and one held for paying online (its checkout still open)
  have no line.
- `loyalty`: their card as the counter shows it (staffCard). `credit`: store credit in cents from Shopify, kept a minute;
  null when Shopify can't say. `tab`: today's self-serve tab while it isn't paid, else null. `account`: pay each visit,
  or a monthly account's limit and what's owed (accountSummary).

## 6. Part 3: products, prices and sales

Mo (6 Nov 2026): "Part 3 please": the shop's real products and prices (the dice deal) and stock, and each sale saved to
Shopify as a paid order with the member and the basket's lines (paying a booking's line marks it paid, as at the
counter), and stamps. `src/till-sales.js`; tests `test/round32-till-sales.test.js`.

The price is fixed before anyone pays: tapping Pay makes the sale's draft order, and that draft's total is what's keyed
into the EFTPOS or taken in cash. Staff then say they have the money with their own PIN, and from that moment the sale is
paid, whatever Shopify does next.

| Route | Who | What |
|---|---|---|
| `POST /proxy/till/product` | staff account (the counter tablet's) | `{ code }`: a barcode (in any of its forms: a UPC read with a leading 0 is the same) or SKU → `{ product, variant }`: the variant whose barcode, then SKU, it is (one for sale first), with its product (only that variant). From Shopify admin, so products sold only at the counter and unlisted ones (the Session product) are found too. Kept 5 minutes. (10 Nov 2026) When several things the till sells share the barcode (two sets' boosters, a dice set's colours), `choices: [{ product, variant }]` too, in Shopify's order, each product with only that variant, never a library copy or gift card: the till asks which (Shopify POS does); `product` and `variant` are the first of them. Unknown: 404 `Gobgob can't find that in the shop. Search for it by name instead.`; a library copy (its code, or "(Library)" in the title): 422 `That's one of our library games, so it isn't for sale.`; the gift card: 422 `Gift cards are sold on Shopify POS for now: the till sells them once Shopify lets the Lair app issue them.`; archived or a draft: 422 `That one isn't for sale at the till.`; not a code (1 to 40 letters, numbers and `. _ + -`): 400 `Scan the barcode, or type the code under it.`; Shopify down: 503 `Shopify didn't answer. Try again in a moment.` |
| `POST /proxy/till/search` | staff account | `{ q }` → `{ products }`: up to 12 of the shop's products, by title, whose title has every word (up to 5), active or unlisted, never a library copy or gift card. Fewer than 2 letters: 400 `Type at least 2 letters to search.` |
| `POST /proxy/till/price` | staff account | `{ lines, person? }` → `{ price: { lines, subtotal, discounts, total, gst, taxIncluded }, dropped }`: what the basket comes to, worked out by Shopify as at checkout (the shop's prices, its automatic discounts like the dice deal, GST), its bookings at what's left to pay and its tab at the tab's prices. Nothing is made or checked in. `dropped`: booking codes with nothing to pay now (left out) |
| `POST /proxy/till/pay` | staff account; staff on the till (`token`) or a customer at the counter | `{ lines, person?, method: 'card' \| 'cash', token?, till? }`: start paying. Today's bookings in the basket are checked in, as the counter tile does when it scans them (saved passes apply), then the sale's draft order is made → `{ sale, dropped, notices }`. `dropped`: booking codes with nothing to pay now (paid already, being paid by another till sale, or a pass covered them at check-in, on this try or an earlier one Shopify didn't finish), left out of the sale since nothing's been taken yet; `{ sale: null }` when nothing's left to pay. The till's sale still waiting for its money is let go first (`till`: the tablet's own id, 6 to 40 letters, numbers and dashes; else where it came from). Their tab changed, or another paid till sale has it: 409 `Their tab has changed. Scan their code again.`; `method` missing: 400 `Pay by card or with cash.`; Shopify refused the sale: 422 `Shopify wouldn't take this sale: …`; Shopify down or too slow: 503 (nothing was taken) |
| `POST /proxy/till/paid` | staff on the till with their own PIN; cash: the owner, Check-in or Money | `{ sale, token, expect, handed? }`: they have the money. `expect` is the total they were shown, in cents (409 `This sale is $26.00. Check that's what was paid, then confirm again.` when it isn't the sale's). Cash: `handed` in cents, at least the total and at most $1,000 over (400 `Type how much cash they handed over: $22.00 or more.`); the change is worked out. Sales only on the till can't take cash: 403 `Approving cash is for staff with Check-in or Money, or the owner.` A booking or tab it pays that was paid another way since Pay (another till, online, the counter tile, cash in My Lair, or another till sale that's paid): 409 `MT-OWLBEAR-17 was paid another way while this sale waited, so this sale wasn't saved. Tap Back to see what's left to pay; if the EFTPOS took this one already, refund the difference there.` (`Their tab` for a tab), and nothing's saved → `{ sale }`, paid. Asking again for a paid sale gives it as it is. A sale that was let go: 409 `That sale was let go before it was confirmed, so it wasn't saved. If the EFTPOS took the money, ring it up again and confirm it without charging again.`; still being set up: 409; none: 404 |
| `POST /proxy/till/pay/cancel` | staff account | `{ sale }`: back from paying: it's let go (its draft deleted, its tab back to open) → `{ sale: null }`. A paid one: 409 `That sale's paid already.` |

`lines` (the basket): `[{ key, variantId, qty }]` products (1 to 99 of each; the same variant twice is one line),
`[{ key, booking: '<code>' }]` bookings, sign-ups, owed rows and a monthly account's owed tab (from the person's
`bookings`, part 2), `[{ key, tab: '<tab id>' }]` their self-serve tab from My Lair. Up to 60 lines; anything else is 400
`Something in the basket didn't look right. Take it out and add it again.` (none: `There's nothing in the basket yet.`).
`person`: the member on the sale (their customer ID), or none for a guest or a ticket's code alone.

A product (`product`): `{ id, title, type, vendor, dice, variants: [{ id, title, price, sku, available, stock }] }`.
`dice`: it's in the dice deal's collection ("All dice (buy 2, get the 3rd free)", `TILL_DICE_COLLECTION` to change it).
`stock`: Shopify's count when it tracks one, else null; `available`: Shopify would sell one now. The till sells it either
way (it's in their hand), and says when Shopify shows none.

A sale (`sale`): `{ id, status: 'open' | 'paid' | 'gone', method, total, subtotal, gst, discounts: [{ title, amount }],
lines: [{ key, title, qty, unit, total, booking?, tab? }], person: { id, first } | null, paidAt, by, handed, change,
order: { id, name } | null, saving, receipt }`. Amounts in cents; `subtotal` and the lines are before discounts.
`saving`: paid, and its Shopify order still being made. `receipt`: the member's email, masked, where Shopify sends their
receipt (its order confirmation).

**The sale's order.** The draft is the member's (none for a quick sale), with the products by variant at the shop's
prices, its tab's things at the tab's prices (`_tab`), each booking as the counter tile's own custom line ("Table fee:
MT-OWLBEAR-17 (T1, 2 people)", `_booking`), the shop's automatic discounts, and a $0 "Collected at the Lair" shipping line
when there are products. It's tagged `lair-till`, `till` and `card` or `cash`, noted "Sold on the Lair till, by card on
the EFTPOS, rung up by Hemi (ts_…)" (no booking codes), with the sale's id in its `_lair_till` attribute. Once paid,
it's made a paid order (marked as paid), and then fulfilled at the shop (`TILL_LOCATION_ID`, "Dice Goblin" by default:
anything assigned elsewhere is moved there first when the shop stocks it), so stock comes off there and it never waits in
Unfulfilled. Fulfilling needs `read_merchant_managed_fulfillment_orders` and `write_merchant_managed_fulfillment_orders`
(new in `pos-app/shopify.app.toml`): until Mo approves them it's tried every 6 hours for 14 days (so sales from before he
approves them are fulfilled once he does), and staff mark sales fulfilled by hand meanwhile. Fulfilling that fails any
other way is tried after 10 minutes, 1 hour, 6 hours and a day twice, then staff get "A till sale to mark fulfilled by
hand: Mia Tamaki".

Shopify gives the order the Lair app's ID as its `source_name` (the Lair's cash orders, completed the same way, have
430573649921), so its orders/paid webhook knows it as **a counter sale** (`src/counter.js tillSale`: a number, or the
draft-order source should Shopify ever give that, and the `lair-till` tag; a web order or a POS sale tagged by hand isn't
one) that keeps its lines' properties: its `_booking` lines pay their bookings, `_tab` its tab,
Session lines stamp the member, RPG Sessions pay their TTRPG seat, passes and gifts are made, and the spend counts with
the source `lair-till` (one of `COUNTER_SOURCES`, so a till sale counts as being in the shop for new players).

**When Shopify is slow.** Pay waits up to 9 seconds for the draft (the shop's app proxy gives up on slower answers);
nothing is taken when it fails. Paid waits up to 9 seconds for the order; past that the sale is paid and `saving`, and
the 10-minute run tries again after 10 minutes, 30, 1 hour, 3, 6, 12 and 24 (each try first looks at whether the draft
became an order already, so an answer that was lost never makes two). Meanwhile its bookings show as paid at the till
(`paying: true`, no line), so nobody pays twice, until its order's payments are in (or two days). When it never can, or
its draft was deleted in Shopify, staff get "A till sale with no Shopify order: Mia Tamaki" with what to do. An order that
comes to a different total than was taken: "A till sale that doesn't match".

**Letting go.** The EFTPOS may have taken the money for a sale still on the pay screen, so the till never clears a pay
screen by itself on Live (nobody touching it for a while included): only staff end it, with Confirm paid, It was declined
or Back. The Lair lets a sale go when the till says Back, when the same till starts a new one, and when Shopify fails
while its draft's made; one left waiting 12 hours (a tablet that reloaded mid-sale) goes in the 10-minute run.

Data: `till_sales (id, till, customer_id, method, status, lines, refs, tabs, subtotal, total, gst, discounts, shown,
draft_id, started_by, created_at, updated_at, paid_at, by, by_name, handed, change_given, ended_at, ended_why,
order_status, order_tries, order_next_at, order_id, order_name, order_total, order_error, fulfil_status, fulfil_tries,
fulfil_next_at, fulfil_error)`: `status` `making` (its draft on the way), `open`, `paid` or `gone`; `lines` what the draft
was made from; `refs` the booking codes it pays; `shown` the lines as Shopify priced them; `order_status` `making`,
`made`, `failed` or `stopped`; `fulfil_status` `due`, `making`, `done`, `failed` or `stopped`.

## 7. Next (not in this round)

Part 4: store credit and tabs as ways to pay at the till, staff phones' Counter tab (hearing Get staff, approving cash
there), and Eftpos NZ's link sending the amount to the EFTPOS itself.
